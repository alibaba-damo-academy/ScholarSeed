"""Native Trace startup reads; deterministic contracts, not update acceptance."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
import unittest
from contextlib import closing, contextmanager
from dataclasses import asdict, replace
from hashlib import file_digest, sha256
from unittest.mock import patch

from apps.serve.tests._directories import make_directory
from damoatrace.data.store import TraceStore
from damoatrace.paths import TracePaths
from damoatrace.recording.content import (
    CONTENT_FORMAT,
    inspect_content_versions,
    validate_content_version,
)
from damoatrace.search.index import PROJECTION_VERSION, IndexCheck, TraceIndex
from service.chat.persistence.ledger import inspect_context_ledgers
from service.chat.persistence.trace import (
    HistoryInspection,
    TraceInspectionCache,
    TraceProjection,
    TraceStartupSources,
    inspect_trace_sources,
    inspect_trace_startup,
    recover_trace_storage,
    require_trace_storage,
    trace_write_format_source,
)
from service.persistence.documents import check_documents, preview_documents
from service.platform.domains import DomainChangedError, Domains
from service.platform.startup import acquire_startup_domains, prepare_startup_domains
from service.platform.storage import DarwinDirectoryNative, LeaseError, WindowsDirectoryNative


def crash_index_writer(index_path) -> None:
    """Leave a real SQLite hot journal by exiting without transaction cleanup."""
    case = unittest.TestCase()
    with closing(TraceIndex(index_path)) as index:
        index._fts.upsert({"id": "retained", "body": "committed evidence"})
    crashed = subprocess.run(
        [
            sys.executable,
            "-c",
            """
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA journal_mode=DELETE')
connection.execute('PRAGMA cache_size=5')
connection.execute('BEGIN IMMEDIATE')
connection.execute("UPDATE trace_events SET body='uncommitted replacement'")
connection.executemany('INSERT INTO trace_events (id, body) VALUES (?, ?)',
((str(number), 'uncommitted ' * 1024) for number in range(128)))
os._exit(73)
""",
            str(index_path),
        ],
        check=False,
        capture_output=True,
        timeout=30,
    )
    case.assertEqual(crashed.returncode, 73, crashed.stderr)
    with closing(sqlite3.connect(index_path.as_uri() + "?mode=ro", uri=True)) as connection:
        with case.assertRaises(sqlite3.OperationalError) as caught:
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    case.assertEqual(caught.exception.sqlite_errorcode, sqlite3.SQLITE_READONLY_ROLLBACK)


class TraceStartupContract(unittest.TestCase):
    def test_crash_recovery_is_deferred_to_exclusive_maintenance(self) -> None:
        crash_index_writer(self.paths.index)
        journal = self.paths.index.with_name(self.paths.index.name + "-journal")
        before = self.paths.index.read_bytes(), journal.read_bytes()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_startup(held, self.paths)
        self.assertIsNotNone(observed.projection.recovery)
        self.assertEqual((self.paths.index.read_bytes(), journal.read_bytes()), before)
        with self.assertRaisesRegex(RuntimeError, "exclusive rollback"):
            require_trace_storage(
                observed.files, observed.projection, observed.formats, observed.history
            )
        recovered, occupied = prepare_startup_domains(
            self.native,
            str(self.coordinator),
            (str(self.paths.home), str(self.paths.trace)),
            lambda held: inspect_trace_startup(held, self.paths),
            lambda state: state.projection.recovery is not None,
            lambda state: recover_trace_storage(self.paths, state.projection),
        )
        occupied.close()
        self.assertIsNone(recovered.projection.recovery)
        self.assertTrue(recovered.projection.current)
        with closing(
            sqlite3.connect(self.paths.index.as_uri() + "?mode=ro", uri=True)
        ) as connection:
            self.assertEqual(connection.execute("PRAGMA quick_check").fetchone(), ("ok",))
            self.assertEqual(
                connection.execute("SELECT id, body FROM trace_events").fetchall(),
                [("retained", "committed evidence")],
            )
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone(), ("delete",))
        after = self.paths.index.read_bytes()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            repeated = inspect_trace_startup(held, self.paths)
        self.assertIsNone(repeated.projection.recovery)
        self.assertEqual(self.paths.index.read_bytes(), after)

    def test_hot_journal_preview_never_recovers_source(self) -> None:
        crash_index_writer(self.paths.index)
        journal = self.paths.index.with_name(self.paths.index.name + "-journal")
        before = self.paths.index.read_bytes(), journal.read_bytes()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaises(sqlite3.OperationalError) as caught:
                inspect_trace_sources(held, self.paths)
        self.assertEqual(caught.exception.sqlite_errorcode, sqlite3.SQLITE_READONLY_ROLLBACK)
        self.assertEqual((self.paths.index.read_bytes(), journal.read_bytes()), before)

    def test_hot_journal_waits_for_exclusive_directory_qualification(self) -> None:
        crash_index_writer(self.paths.index)
        journal = self.paths.index.with_name(self.paths.index.name + "-journal")
        before = self.paths.index.read_bytes(), journal.read_bytes()
        with self.occupied(self.paths.home, self.paths.trace):
            with self.assertRaises(LeaseError) as caught:
                prepare_startup_domains(
                    self.native,
                    str(self.coordinator),
                    (str(self.paths.home), str(self.paths.trace)),
                    lambda held: inspect_trace_startup(held, self.paths),
                    lambda state: state.projection.recovery is not None,
                    lambda state: self.fail("initializer called without exclusive qualification"),
                )
            self.assertEqual(caught.exception.code, "ERR_LEASE_BUSY")
        self.assertEqual((self.paths.index.read_bytes(), journal.read_bytes()), before)

    def test_other_sqlite_errors_do_not_request_recovery(self) -> None:
        with closing(TraceIndex(self.paths.index)):
            pass
        for code in (
            sqlite3.SQLITE_READONLY,
            sqlite3.SQLITE_IOERR,
            sqlite3.SQLITE_CORRUPT,
            sqlite3.SQLITE_BUSY,
        ):
            error = sqlite3.OperationalError("fixture SQLite error")
            error.sqlite_errorcode = code
            with self.subTest(code=code), self.occupied(self.paths.home, self.paths.trace) as held:
                with patch.object(TraceIndex, "inspect_readonly", side_effect=error):
                    with self.assertRaises(sqlite3.OperationalError) as caught:
                        inspect_trace_startup(held, self.paths)
                self.assertIs(caught.exception, error)

    def test_recovery_rejects_changed_pending_journal(self) -> None:
        crash_index_writer(self.paths.index)
        journal = self.paths.index.with_name(self.paths.index.name + "-journal")
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_startup(held, self.paths)
        with journal.open("ab") as output:
            output.write(b"changed")
        before = self.paths.index.read_bytes(), journal.read_bytes()
        exclusive = Domains(
            self.native,
            str(self.coordinator),
            [str(self.paths.home), str(self.paths.trace)],
            maintenance=True,
        )
        try:
            exclusive.occupy()
            with exclusive.mutation(), self.assertRaisesRegex(sqlite3.DatabaseError, "changed"):
                recover_trace_storage(self.paths, observed.projection)
        finally:
            exclusive.close()
        self.assertEqual((self.paths.index.read_bytes(), journal.read_bytes()), before)

    def test_missing_history_stays_complete_without_creating_trace_directory(self) -> None:
        self.paths.trace.rmdir()
        self.paths.trace.parent.rmdir()
        with self.occupied(self.paths.home) as held:
            observed = inspect_trace_startup(held, self.paths)
            require_trace_storage(
                observed.files, observed.projection, observed.formats, observed.history
            )
        self.assertIs(observed.history, HistoryInspection.COMPLETE)
        self.assertEqual(observed.files, ())
        self.assertFalse(self.paths.trace.parent.exists())

    def test_explicit_history_audit_rejects_missing_format_evidence_before_reading(self) -> None:
        malformed = TraceStartupSources(
            (str(self.paths.home), str(self.paths.trace)), None, TraceProjection(False, False)
        )
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with (
                patch(
                    "service.chat.persistence.trace._inspect_trace_storage", return_value=malformed
                ),
                patch("service.chat.persistence.trace._names", side_effect=AssertionError("read")),
                self.assertRaisesRegex(RuntimeError, "formats"),
            ):
                inspect_trace_sources(held, self.paths)

    def test_startup_does_not_enumerate_or_read_large_historical_content(self) -> None:
        path = self.paths.trace / "large.jsonl"
        with path.open("wb") as source:
            source.write(b'{"diagnostic_content_version":999}\n')
            source.truncate(512 * 1024 * 1024)
        before = path.stat()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with (
                patch(
                    "service.chat.persistence.trace._names",
                    side_effect=AssertionError("history enumeration"),
                ),
                patch(
                    "service.chat.persistence.trace.inspect_content_versions",
                    side_effect=AssertionError("history read"),
                ),
                patch(
                    "service.chat.persistence.trace._digest",
                    side_effect=AssertionError("history hash"),
                ),
                self.assertLogs("service.chat.persistence.trace", level="INFO") as logs,
            ):
                observed = inspect_trace_startup(held, self.paths)
            self.assertIs(observed.history, HistoryInspection.DEFERRED)
            self.assertIsNone(observed.files)
            require_trace_storage(
                observed.files, observed.projection, observed.formats, observed.history
            )
            self.assertIn("history=deferred", " ".join(logs.output))
            self.assertIn("bytes_read=0", " ".join(logs.output))
            with self.assertRaisesRegex(ValueError, "byte budget"):
                inspect_trace_sources(held, self.paths)
        self.assertEqual(path.stat().st_size, before.st_size)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)

    def test_deferred_history_does_not_grant_unqualified_or_complete_evidence(self) -> None:
        with self.occupied(self.paths.home) as held:
            pending = inspect_trace_startup(held, self.paths)
        self.assertIsNone(pending.history)
        with self.assertRaisesRegex(RuntimeError, "storage"):
            require_trace_storage(
                pending.files, pending.projection, pending.formats, pending.history
            )
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_startup(held, self.paths)
            for files, history in (
                ((), HistoryInspection.DEFERRED),
                (None, HistoryInspection.COMPLETE),
            ):
                with (
                    self.subTest(history=history),
                    self.assertRaisesRegex(RuntimeError, "inconsistent"),
                ):
                    require_trace_storage(files, observed.projection, observed.formats, history)
            inspected = inspect_trace_sources(held, self.paths)
            self.assertIs(inspected.history, HistoryInspection.COMPLETE)
            self.assertEqual(inspected.files, ())
            self.assertNotEqual(observed, inspected)

    def test_startup_converges_without_certifying_changing_history(self) -> None:
        path = self.paths.trace / "changing.jsonl"
        path.write_text("{}\n")

        def inspect(held):
            observed = inspect_trace_startup(held, self.paths)
            with path.open("a") as source:
                source.write('{"diagnostic_content_version":999}\n')
            return observed

        observed, domains = acquire_startup_domains(
            self.native,
            str(self.coordinator),
            (str(self.paths.home), str(self.paths.trace)),
            inspect,
            attempts=1,
        )
        try:
            self.assertIs(observed.history, HistoryInspection.DEFERRED)
            with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                inspect_trace_sources(domains.inspection_view(), self.paths)
        finally:
            domains.close()

    def test_startup_preserves_future_content_until_explicit_consumption(self) -> None:
        path = self.paths.trace / "future.jsonl"
        payload = b'{"diagnostic_content_version":999}\n'
        path.write_bytes(payload)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            self.assertIs(
                inspect_trace_startup(held, self.paths).history, HistoryInspection.DEFERRED
            )
            with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                inspect_trace_sources(held, self.paths)
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
            TraceStore(self.paths.trace, paths=self.paths).all_events()
        self.assertEqual(path.read_bytes(), payload)

    def setUp(self) -> None:
        self.root = make_directory("trace-startup-")
        self.addCleanup(shutil.rmtree, self.root)
        self.native = (
            DarwinDirectoryNative() if sys.platform == "darwin" else WindowsDirectoryNative()
        )
        self.paths = TracePaths.from_home(self.root / "home")
        self.coordinator = self.root / "coordinator"
        for path in (self.paths.home, self.paths.trace.parent, self.paths.trace, self.coordinator):
            pin = self.native.pin(str(path), True)
            self.native.release(pin)

    @contextmanager
    def occupied(self, *roots):
        domains = Domains(self.native, str(self.coordinator), [str(root) for root in roots])
        try:
            domains.occupy()
            yield domains.inspection_view()
        finally:
            domains.close()

    def test_discovery_requires_trace_directory_selection_before_content_read(self) -> None:
        path = self.paths.trace / "future.jsonl"
        payload = b'{"diagnostic_content_version":999}\n'
        path.write_bytes(payload)
        with self.occupied(self.paths.home) as held:
            result = inspect_trace_sources(held, self.paths)
            self.assertIsNone(result.files)
            self.assertEqual(set(result.roots), {str(self.paths.home), str(self.paths.trace)})
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                inspect_trace_sources(held, self.paths)
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(list(self.paths.trace.iterdir()), [path])

    def test_selection_matches_platform_trace_glob_case_rules(self) -> None:
        path = self.paths.trace / "future.JSONL"
        path.write_text('{"diagnostic_content_version":999}\n')
        selected = bool(list(self.paths.trace.glob("*.jsonl")))
        with self.occupied(self.paths.home, self.paths.trace) as held:
            if selected:
                with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                    inspect_trace_sources(held, self.paths)
            else:
                self.assertEqual(inspect_trace_sources(held, self.paths).files, ())

    def test_missing_content_directory_is_not_created(self) -> None:
        self.paths.trace.rmdir()
        self.paths.trace.parent.rmdir()
        with self.occupied(self.paths.home) as held:
            result = inspect_trace_sources(held, self.paths)
        self.assertEqual(result.files, ())
        self.assertFalse(self.paths.trace.parent.exists())
        self.assertIsNotNone(result.formats)
        result.formats.require_candidate(result.formats)

    def test_content_compatibility_uses_the_actual_reader_contract(self) -> None:
        with self.occupied(self.paths.home, self.paths.trace) as held:
            result = inspect_trace_sources(held, self.paths)
        formats = result.formats
        self.assertIsNotNone(formats)
        candidate = replace(formats, content=replace(formats.content, written=999))
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
            formats.require_candidate(candidate)
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
            validate_content_version({"diagnostic_content_version": candidate.content.written})
        validate_content_version({"diagnostic_content_version": CONTENT_FORMAT.written})
        formats.require_candidate(formats)
        self.assertFalse(self.paths.index.exists())

    def test_candidate_trace_writer_formats_are_read_by_source_contracts(self) -> None:
        owner = trace_write_format_source()
        candidate = preview_documents((owner,))
        checked = check_documents([asdict(row) for row in candidate], (owner,))
        self.assertEqual(checked[0].name, "trace-write-formats")
        for name, version in (("content", 999), ("projection", "future-v999")):
            written = json.loads(owner.prepared)
            written[name] = version
            payload = json.dumps(written, sort_keys=True, separators=(",", ":")).encode()
            # Candidate owns its declaration; old readers must inspect its exact
            # bytes through the normal paired-document transport.
            future = replace(owner, prepared=payload, read=lambda _: None)
            report = preview_documents((future,))
            with self.assertRaises(ValueError):
                check_documents([asdict(row) for row in report], (owner,))
        self.assertFalse(self.paths.index.exists())

    def test_trace_write_format_declaration_requires_exact_closed_fields(self) -> None:
        owner = trace_write_format_source()
        for raw in (
            None,
            b"{}",
            b"null",
            owner.prepared + b"{}",
            owner.prepared.replace(b'"schema":1', b'"schema":true'),
            owner.prepared.replace(b'"schema":1', b'"schema":1,"schema":1'),
        ):
            with self.subTest(raw=raw):
                with self.assertRaises(ValueError):
                    owner.read(raw)
        with self.assertRaisesRegex(ValueError, "coverage"):
            check_documents([], (owner,))

    def test_projection_compatibility_does_not_treat_rebuild_as_permission_for_future_marker(
        self,
    ) -> None:
        with self.occupied(self.paths.home, self.paths.trace) as held:
            result = inspect_trace_sources(held, self.paths)
        formats = result.formats
        self.assertIsNotNone(formats)
        self.assertTrue(formats.projection.rebuild_unmarked)
        candidate = replace(formats, projection=replace(formats.projection, written="future-v999"))
        with self.assertRaisesRegex(ValueError, "unsupported projection version"):
            formats.require_candidate(candidate)
        self.assertFalse(self.paths.index.exists())

    def test_index_version_is_checked_in_the_actual_wal_snapshot_without_rewrite(self) -> None:
        with closing(sqlite3.connect(self.paths.index)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA wal_autocheckpoint=0")
            connection.execute(
                "CREATE TABLE projection_versions (name TEXT PRIMARY KEY, version TEXT)"
            )
            connection.execute(
                "INSERT INTO projection_versions VALUES ('trace_events', ?)", (PROJECTION_VERSION,)
            )
            connection.commit()
            with self.occupied(self.paths.home, self.paths.trace) as held:
                observed = inspect_trace_sources(held, self.paths)
            self.assertTrue(observed.projection.present)
            self.assertTrue(observed.projection.current)
            connection.execute("UPDATE projection_versions SET version='future-v999'")
            connection.commit()
            wal = self.paths.index.with_name(self.paths.index.name + "-wal")
            before = self.paths.index.read_bytes(), wal.read_bytes(), tuple(connection.iterdump())
            with self.occupied(self.paths.home, self.paths.trace) as held:
                with self.assertRaisesRegex(ValueError, "unsupported projection version"):
                    inspect_trace_sources(held, self.paths)
            self.assertEqual(
                (self.paths.index.read_bytes(), wal.read_bytes(), tuple(connection.iterdump())),
                before,
            )

    def test_current_marker_does_not_hide_an_unreadable_index(self) -> None:
        with closing(sqlite3.connect(self.paths.index)) as connection:
            connection.execute(
                "CREATE TABLE projection_versions (name TEXT PRIMARY KEY, version TEXT)"
            )
            connection.execute(
                "INSERT INTO projection_versions VALUES ('trace_events', ?)", (PROJECTION_VERSION,)
            )
            connection.execute("CREATE TABLE trace_events (id TEXT, body TEXT)")
            connection.commit()
        before = self.paths.index.read_bytes()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaisesRegex(ValueError, "unsupported Trace index columns"):
                inspect_trace_sources(held, self.paths)
        self.assertEqual(self.paths.index.read_bytes(), before)

    def test_missing_index_is_observed_without_creating_a_database(self) -> None:
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_sources(held, self.paths)
        self.assertFalse(observed.projection.present)
        self.assertFalse(observed.projection.current)
        self.assertFalse(self.paths.index.exists())

    def test_runtime_startup_accepts_index_larger_than_preview_budget_without_mutation(
        self,
    ) -> None:
        with closing(TraceIndex(self.paths.index)) as index:
            index._fts.upsert({"id": "retained", "body": "searchable history"})
        with closing(sqlite3.connect(self.paths.index)) as writer:
            block = "a" * (16 * 1024 * 1024)
            writer.executemany(
                "INSERT INTO trace_events (id, body) VALUES (?, ?)",
                ((str(number), block) for number in range(17)),
            )
            writer.commit()
        self.assertGreater(self.paths.index.stat().st_size, 256 * 1024 * 1024)
        before = self.paths.index.stat()
        with self.paths.index.open("rb") as source:
            digest = file_digest(source, "sha256").hexdigest()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaisesRegex(ValueError, "preview exceeds budget"):
                inspect_trace_sources(held, self.paths)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_sources(held, self.paths, compatibility_preview=False)
        self.assertTrue(observed.projection.current)
        self.assertTrue(observed.projection.present)
        self.assertIn(
            observed.projection.sqlite_check, (IndexCheck.COMPLETE, IndexCheck.INCOMPLETE_BUDGET)
        )
        self.assertEqual(self.paths.index.stat().st_mtime_ns, before.st_mtime_ns)
        with self.paths.index.open("rb") as source:
            self.assertEqual(file_digest(source, "sha256").hexdigest(), digest)
        with closing(sqlite3.connect(f"{self.paths.index.as_uri()}?mode=ro", uri=True)) as source:
            self.assertEqual(source.execute("SELECT count(*) FROM trace_events").fetchone(), (18,))
        self.assertEqual(list(self.paths.trace.iterdir()), [self.paths.index])

    def test_runtime_sqlite_budget_state_is_logged_and_never_reused_for_preview(self) -> None:
        with closing(TraceIndex(self.paths.index)) as index:
            index._fts.upsert({"id": "retained", "body": "searchable text"})
        inspect = TraceIndex.inspect_readonly
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with (
                patch.object(
                    TraceIndex,
                    "inspect_readonly",
                    side_effect=lambda source: inspect(source, budget_seconds=0),
                ),
                self.assertLogs("service.chat.persistence.trace", level="INFO") as logs,
            ):
                observed = inspect_trace_sources(held, self.paths, compatibility_preview=False)
        self.assertEqual(observed.projection.sqlite_check, IndexCheck.INCOMPLETE_BUDGET)
        self.assertIn("scope=readonly_sqlite status=incomplete_budget", "\n".join(logs.output))
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch.object(
                TraceIndex,
                "inspect_readonly",
                side_effect=AssertionError("preview cannot use quick checks"),
            ):
                preview = inspect_trace_sources(held, self.paths)
        self.assertIsNone(preview.projection.sqlite_check)
        self.assertTrue(preview.projection.current)

    def test_runtime_checks_future_marker_in_wal_without_changing_source(self) -> None:
        with closing(TraceIndex(self.paths.index)):
            pass
        with closing(sqlite3.connect(self.paths.index)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("UPDATE projection_versions SET version='future-v999'")
            writer.commit()
            wal = self.paths.index.with_name(self.paths.index.name + "-wal")
            before = self.paths.index.read_bytes(), wal.read_bytes()
            with self.occupied(self.paths.home, self.paths.trace) as held:
                with self.assertRaisesRegex(ValueError, "unsupported projection version"):
                    inspect_trace_sources(held, self.paths, compatibility_preview=False)
            self.assertEqual((self.paths.index.read_bytes(), wal.read_bytes()), before)

    def test_runtime_budget_observation_does_not_change_source_qualification(self) -> None:
        with closing(TraceIndex(self.paths.index)) as index:
            index._fts.upsert({"id": "retained", "body": "searchable text"})
        inspections = []

        def read(held):
            observed = inspect_trace_sources(held, self.paths, compatibility_preview=False)
            status = IndexCheck.COMPLETE if not inspections else IndexCheck.INCOMPLETE_BUDGET
            observed = replace(
                observed, projection=replace(observed.projection, sqlite_check=status)
            )
            inspections.append(observed)
            return observed

        observed, occupied = acquire_startup_domains(
            self.native,
            str(self.coordinator),
            (str(self.paths.home), str(self.paths.trace)),
            read,
            attempts=1,
        )
        try:
            self.assertEqual(len(inspections), 2)
            self.assertEqual(inspections[0], inspections[1])
            self.assertEqual(observed.projection.sqlite_check, IndexCheck.INCOMPLETE_BUDGET)
            self.assertNotEqual(
                observed, replace(observed, projection=replace(observed.projection, current=False))
            )
        finally:
            occupied.close()

    def test_current_and_opaque_history_are_read_without_rewrite(self) -> None:
        path = self.paths.trace / "current.jsonl"
        payload = (
            b'{"legacy":true}\r\npartial historical line\r\n{"diagnostic_content_version":1}\r\n'
        )
        path.write_bytes(payload)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            result = inspect_trace_sources(held, self.paths)
        self.assertEqual(result.files[0].versions, (1,))
        self.assertEqual(result.files[0].size, len(payload))
        self.assertEqual(result.files[0].digest, sha256(payload).hexdigest())
        self.assertEqual(result.files[0].events, 2)
        self.assertEqual(result.files[0].opaque_lines, 1)
        self.assertEqual(path.read_bytes(), payload)
        self.assertEqual(list(self.paths.trace.iterdir()), [path])

    def test_event_usage_codec_failure_preserves_original_evidence(self) -> None:
        path = self.paths.trace / "usage.jsonl"
        payload = b'{"kind":"llm.stream","attributes":{"usage":{"input_tokens":"future-number"}}}\n'
        path.write_bytes(payload)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaises(ValueError):
                inspect_trace_sources(held, self.paths)
        self.assertEqual(path.read_bytes(), payload)
        self.assertFalse(self.paths.index.exists())

    def test_context_ledger_discovery_waits_for_qualification(self) -> None:
        ledger = self.root / "unqualified-ledger"
        with self.occupied(self.paths.home) as held:
            self.assertIsNone(inspect_context_ledgers(held, ledger))
            self.assertEqual(inspect_context_ledgers(held, None), ())
        self.assertFalse(ledger.exists())

    def test_compaction_snapshot_reaches_only_its_session_ledger_and_real_lifecycle(self) -> None:
        ledger = self.root / "linked-ledger"
        item = {
            "item_id": "item",
            "content": "private context",
            "version": 1,
            "lifecycle_started_at": "2026-09-01T00:00:00Z",
            "lifecycle_ended_at": "2026-09-01T00:01:00Z",
        }
        for session in ("selected", "unrelated"):
            directory = ledger / "project" / session / "context"
            directory.mkdir(parents=True)
            (directory / "items.jsonl").write_text(json.dumps(item) + "\n", encoding="utf-8")
        event = {
            "session_id": "selected",
            "kind": "context",
            "name": "context.compaction",
            "started_at": "2026-09-01T00:01:00Z",
            "task_run_id": "turn",
            "attributes": {
                "run_id": "compaction",
                "item_transitions": [
                    {
                        "item_id": "item",
                        "checkpoint_item_ids": ["checkpoint"],
                        "removed_at": "2026-09-01T00:01:00Z",
                    }
                ],
                "retained_items": [],
            },
        }
        path = self.paths.trace / "compaction.jsonl"
        original = (json.dumps(event) + "\n").encode()
        path.write_bytes(original)
        project_lifecycle = TraceStore._context_item_lifecycle
        with self.occupied(self.paths.home, self.paths.trace, ledger) as held:
            snapshot = inspect_trace_sources(held, self.paths)
            compactions = tuple(value for source in snapshot.files for value in source.compactions)
            self.assertEqual(len(compactions), 1)
            self.assertNotIn("checkpoint", repr(snapshot.files))
            with patch.object(
                TraceStore, "_context_item_lifecycle", wraps=project_lifecycle
            ) as lifecycle:
                inspect_context_ledgers(held, ledger, compactions=compactions)
            calls = lifecycle.call_args_list
            self.assertEqual(len(calls), 2)
            projected = [project_lifecycle(**call.kwargs) for call in calls]
            selected = [row for row in projected[0] if row["kind"] == "compacted"]
            self.assertEqual(selected[0]["checkpoint_item_ids"], ["checkpoint"])
            self.assertFalse(any(row["kind"] == "compacted" for row in projected[1]))
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(self.paths.index.exists())
        for source in ledger.rglob("items.jsonl"):
            self.assertEqual(json.loads(source.read_text()), item)

    def test_compaction_retention_budget_rejects_without_changing_trace(self) -> None:
        path = self.paths.trace / "bounded-compaction.jsonl"
        payload = b'{"session_id":"session","kind":"context","name":"context.compaction","attributes":{"item_transitions":[]}}\n'
        path.write_bytes(payload)
        for name in ("MAX_TRACE_COMPACTIONS", "MAX_TRACE_COMPACTION_BYTES"):
            with self.subTest(name=name), self.occupied(self.paths.home, self.paths.trace) as held:
                with patch("service.chat.persistence.trace." + name, 0):
                    with self.assertRaisesRegex(ValueError, "compaction evidence exceeds"):
                        inspect_trace_sources(held, self.paths)
            self.assertEqual(path.read_bytes(), payload)
            with self.occupied(self.paths.home, self.paths.trace) as held:
                with patch("service.chat.persistence.trace." + name, 0):
                    observed = inspect_trace_sources(held, self.paths, compatibility_preview=False)
            self.assertEqual(observed.files[0].compactions, ())
            self.assertEqual(observed.files[0].events, 1)
            self.assertEqual(path.read_bytes(), payload)

    def test_context_ledgers_and_subagents_are_read_without_creating_missing_files(self) -> None:
        ledger = self.root / "ledger"
        payload = (
            json.dumps(
                {
                    "item_id": "item",
                    "content": "private-ledger-content",
                    "content_hash": "hash",
                    "supersedes": [],
                }
            ).encode()
            + b"\r\npartial history\r\n"
        )
        sources = []
        for parent in (ledger / "project" / "session", ledger / "project" / "_subagents" / "child"):
            directory = parent / "context"
            directory.mkdir(parents=True)
            path = directory / "items.jsonl"
            path.write_bytes(payload)
            sources.append(path)
        before = tuple(sorted(str(path.relative_to(ledger)) for path in ledger.rglob("*")))
        with self.occupied(ledger) as held:
            result = inspect_context_ledgers(held, ledger)
        self.assertEqual(len(result), 8)
        present = [source for source in result if source.present]
        self.assertEqual(len(present), 2)
        for source in present:
            self.assertEqual(source.digest, sha256(payload).hexdigest())
            self.assertEqual(source.records, 1)
            self.assertEqual(source.opaque_lines, 1)
        self.assertNotIn("private-ledger-content", repr(result))
        self.assertEqual(
            tuple(sorted(str(path.relative_to(ledger)) for path in ledger.rglob("*"))), before
        )
        self.assertTrue(all(path.read_bytes() == payload for path in sources))

    def test_context_ledger_budget_failure_preserves_file(self) -> None:
        ledger = self.root / "ledger"
        directory = ledger / "project" / "session" / "context"
        directory.mkdir(parents=True)
        path = directory / "items.jsonl"
        payload = b'{"item_id":"item","content":"private"}\n'
        path.write_bytes(payload)
        for name, value in (
            ("MAX_BYTES", 1),
            ("MAX_LINE_BYTES", 1),
            ("MAX_RECORDS", 0),
            ("MAX_ENTRIES", 0),
        ):
            with self.subTest(name=name), self.occupied(ledger) as held:
                with patch("service.chat.persistence.ledger." + name, value):
                    with self.assertRaises(ValueError):
                        inspect_context_ledgers(held, ledger)
            self.assertEqual(path.read_bytes(), payload)

    def test_trace_line_and_total_budgets_do_not_truncate_original_file(self) -> None:
        path = self.paths.trace / "bounded.jsonl"
        payload = b'{"name":"private-content"}\n'
        path.write_bytes(payload)
        for name, limit in (
            ("MAX_TRACE_LINE_CHARS", 8),
            ("MAX_TRACE_BYTES", 8),
            ("MAX_TRACE_ENTRIES", 0),
        ):
            with self.subTest(name=name), self.occupied(self.paths.home, self.paths.trace) as held:
                with patch("service.chat.persistence.trace." + name, limit):
                    with self.assertRaises(ValueError):
                        inspect_trace_sources(held, self.paths)
            self.assertEqual(path.read_bytes(), payload)

    def test_explicit_history_reads_beyond_preview_capacity_without_mutation(self) -> None:
        path = self.paths.trace / "large.jsonl"
        block = json.dumps({"historical": "x" * (1024 * 1024)}).encode() + b"\n"
        digest = sha256()
        with path.open("wb") as writer:
            for _ in range(257):
                writer.write(block)
                digest.update(block)
            tail = b'{"diagnostic_content_version":1}\n'
            writer.write(tail)
            digest.update(tail)
        before = path.stat()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaisesRegex(ValueError, "byte budget"):
                inspect_trace_sources(held, self.paths)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            observed = inspect_trace_sources(held, self.paths, compatibility_preview=False)
        self.assertEqual(observed.files[0].digest, digest.hexdigest())
        self.assertEqual(observed.files[0].versions, (1,))
        self.assertEqual(observed.files[0].size, before.st_size)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
        with path.open("rb") as source:
            self.assertEqual(sha256(source.read()).hexdigest(), digest.hexdigest())
        self.assertEqual(list(self.paths.trace.iterdir()), [path])

    def test_explicit_history_rejects_future_format_at_end_of_history(self) -> None:
        path = self.paths.trace / "future.jsonl"
        payload = b'{}\n{"diagnostic_content_version":999}\n'
        path.write_bytes(payload)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch("service.chat.persistence.trace.MAX_TRACE_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                    inspect_trace_sources(held, self.paths, compatibility_preview=False)
        self.assertEqual(path.read_bytes(), payload)

    def test_repeated_qualification_hashes_all_bytes_before_reusing_checks(self) -> None:
        path = self.paths.trace / "cached.jsonl"
        payload = '{"diagnostic_content_version":1,"attributes":{"label":"你好"}}\r\n{}'
        path.write_bytes(payload.encode())
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            initial = inspect_trace_sources(
                held, self.paths, compatibility_preview=False, cache=cache
            )
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch(
                "service.chat.persistence.trace.inspect_content_versions",
                side_effect=AssertionError("unchanged content was parsed again"),
            ):
                observed = inspect_trace_sources(
                    held, self.paths, compatibility_preview=False, cache=cache
                )
        self.assertEqual(initial, observed)
        self.assertEqual(observed.files[0].digest, sha256(payload.encode()).hexdigest())

    def test_same_size_and_mtime_cannot_hide_changed_content_from_cache(self) -> None:
        path = self.paths.trace / "changed.jsonl"
        original = b'{"diagnostic_content_version":1}\n'
        future = b'{"diagnostic_content_version":2}\n'
        path.write_bytes(original)
        before = path.stat()
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        path.write_bytes(future)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
                inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        self.assertEqual(path.read_bytes(), future)

    def test_runtime_cache_cannot_satisfy_preview_or_changed_line_limit(self) -> None:
        path = self.paths.trace / "bounded-cache.jsonl"
        path.write_bytes(b'{"diagnostic_content_version":1}\n')
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch("service.chat.persistence.trace.MAX_TRACE_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "byte budget"):
                    inspect_trace_sources(held, self.paths, cache=cache)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch("service.chat.persistence.trace.MAX_TRACE_LINE_CHARS", 1):
                with self.assertRaisesRegex(ValueError, "line exceeds"):
                    inspect_trace_sources(
                        held, self.paths, compatibility_preview=False, cache=cache
                    )

    def test_replacement_with_identical_bytes_requires_fresh_codec_checks(self) -> None:
        path = self.paths.trace / "replaced.jsonl"
        payload = b'{"diagnostic_content_version":1}\n'
        path.write_bytes(payload)
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            initial = inspect_trace_sources(
                held, self.paths, compatibility_preview=False, cache=cache
            )
        replacement = self.paths.trace / "replacement"
        replacement.write_bytes(payload)
        replacement.replace(path)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch(
                "service.chat.persistence.trace.inspect_content_versions",
                wraps=inspect_content_versions,
            ) as inspect:
                observed = inspect_trace_sources(
                    held, self.paths, compatibility_preview=False, cache=cache
                )
        self.assertEqual(inspect.call_count, 1)
        self.assertNotEqual(initial.files[0].identity, observed.files[0].identity)
        self.assertEqual(observed.files[0].digest, initial.files[0].digest)

    def test_cached_read_still_rejects_changed_source_and_inventory(self) -> None:
        path = self.paths.trace / "cached-change.jsonl"
        payload = b'{"diagnostic_content_version":1}\n'
        for change in ("source", "inventory"):
            with self.subTest(change=change):
                path.write_bytes(payload)
                cache = TraceInspectionCache()
                with self.occupied(self.paths.home, self.paths.trace) as held:
                    inspect_trace_sources(
                        held, self.paths, compatibility_preview=False, cache=cache
                    )

                def change_after_read(source):
                    digest = sha256(source.read()).hexdigest()
                    if change == "source":
                        path.write_bytes(payload + b"{}\n")
                    else:
                        (self.paths.trace / "added.jsonl").write_bytes(b"{}\n")
                    return digest

                with self.occupied(self.paths.home, self.paths.trace) as held:
                    with patch(
                        "service.chat.persistence.trace._digest", side_effect=change_after_read
                    ):
                        with self.assertRaises(DomainChangedError):
                            inspect_trace_sources(
                                held, self.paths, compatibility_preview=False, cache=cache
                            )

    def test_failed_scan_does_not_publish_partial_cache(self) -> None:
        first = self.paths.trace / "a.jsonl"
        second = self.paths.trace / "b.jsonl"
        first.write_bytes(b'{"diagnostic_content_version":1}\n')
        second.write_bytes(b'{"diagnostic_content_version":999}\n')
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaises(ValueError):
                inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        second.write_bytes(b'{"diagnostic_content_version":1}\n')
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch(
                "service.chat.persistence.trace.inspect_content_versions",
                wraps=inspect_content_versions,
            ) as inspect:
                inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        self.assertEqual(inspect.call_count, 2)

    def test_changed_cached_source_must_match_second_complete_read(self) -> None:
        path = self.paths.trace / "two-reads.jsonl"
        initial = b'{"diagnostic_content_version":1,"x":1}\n'
        changed = b'{"diagnostic_content_version":1,"x":2}\n'
        path.write_bytes(initial)
        before = path.stat()
        cache = TraceInspectionCache()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            inspect_trace_sources(held, self.paths, compatibility_preview=False, cache=cache)
        path.write_bytes(changed)
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))

        def mutate_after_hash(source):
            digest = sha256(source.read()).hexdigest()
            path.write_bytes(initial)
            os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
            return digest

        with self.occupied(self.paths.home, self.paths.trace) as held:
            with (
                patch("service.chat.persistence.trace._digest", side_effect=mutate_after_hash),
                patch("service.chat.persistence.trace.stable_read_matches", return_value=True),
            ):
                with self.assertRaisesRegex(DomainChangedError, "between complete reads"):
                    inspect_trace_sources(
                        held, self.paths, compatibility_preview=False, cache=cache
                    )

    def test_modified_file_is_rejected_after_real_read(self) -> None:
        path = self.paths.trace / "current.jsonl"
        path.write_text('{"diagnostic_content_version":1}\n')

        def modify(source, **kwargs):
            versions = inspect_content_versions(source, **kwargs)
            with path.open("ab") as writer:
                writer.write(b'{"new_record":true}\n')
            return versions

        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch(
                "service.chat.persistence.trace.inspect_content_versions", side_effect=modify
            ):
                with self.assertRaises(DomainChangedError):
                    inspect_trace_sources(held, self.paths)

    def test_new_file_is_rejected_after_inventory_changes(self) -> None:
        path = self.paths.trace / "current.jsonl"
        path.write_text('{"diagnostic_content_version":1}\n')

        def add_file(source, **kwargs):
            versions = inspect_content_versions(source, **kwargs)
            (self.paths.trace / "new.jsonl").write_text("{}\n")
            return versions

        with self.occupied(self.paths.home, self.paths.trace) as held:
            with patch(
                "service.chat.persistence.trace.inspect_content_versions", side_effect=add_file
            ):
                with self.assertRaises(DomainChangedError):
                    inspect_trace_sources(held, self.paths)

    def test_directory_cannot_impersonate_content_file(self) -> None:
        (self.paths.trace / "directory.jsonl").mkdir()
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaises((ValueError, IsADirectoryError, PermissionError)):
                inspect_trace_sources(held, self.paths)
        self.assertTrue((self.paths.trace / "directory.jsonl").is_dir())
        self.assertEqual(list((self.paths.trace / "directory.jsonl").iterdir()), [])

    def test_symlink_cannot_redirect_content_read(self) -> None:
        target = self.root / "outside"
        target.write_bytes(b"{}\n")
        (self.paths.trace / "linked.jsonl").symlink_to(target)
        with self.occupied(self.paths.home, self.paths.trace) as held:
            with self.assertRaises(OSError):
                inspect_trace_sources(held, self.paths)
        self.assertEqual(target.read_bytes(), b"{}\n")


if __name__ == "__main__":
    unittest.main()
