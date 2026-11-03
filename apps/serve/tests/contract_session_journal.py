"""Canonical body durability and qualified snapshot contracts."""

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from service.chat.persistence.journal import (
    BODY_TABLE,
    GENERATION_TABLE,
    JOURNAL_SUFFIX,
    JOURNAL_TABLE,
    Journal,
    cleanup,
    compact,
    initialize,
    inspect_connection,
    inspect_index_rows,
    inspect_rows,
)


class SessionJournalContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name).resolve() / "sessions.sqlite3"
        self.connection = sqlite3.connect(self.database)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("BEGIN")
        initialize(self.connection)
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.directory.cleanup()

    def put(self, value: str) -> str:
        with self.connection:
            self.connection.execute("BEGIN")
            with Journal(self.connection, self.database) as journal:
                return journal.put(value)

    def get(self, reference: str) -> str:
        with Journal(self.connection, self.database) as journal:
            return journal.get(reference)

    def test_dedup_preserves_exact_text_without_sql_body(self) -> None:
        body = '正文\n\x00\\quoted"'
        reference = self.put(body)
        self.assertEqual(self.put(body), reference)
        self.assertEqual(self.get(reference), body)
        rows = self.connection.execute(f"SELECT * FROM {BODY_TABLE}").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertNotIn(body, repr([tuple(row) for row in rows]))
        self.assertFalse(inspect_connection(self.connection).needs_write)
        inspect_rows(self.connection, self.database)

    def test_rollback_tail_is_replaced_without_losing_committed_body(self) -> None:
        first = self.put("first")
        self.connection.execute("BEGIN")
        with Journal(self.connection, self.database) as journal:
            abandoned = journal.put("abandoned" * 100)
        self.connection.rollback()
        second = self.put("second")
        self.assertEqual(self.get(first), "first")
        self.assertEqual(self.get(second), "second")
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.get(abandoned)
        path = Journal(self.connection, self.database).path
        extent = self.connection.execute(f"SELECT committed_bytes FROM {JOURNAL_TABLE}").fetchone()[
            0
        ]
        self.assertEqual(path.stat().st_size, extent)
        self.assertNotIn(b"abandoned", path.read_bytes())

    def test_partial_writes_and_fsync_failure_leave_no_published_reference(self) -> None:
        original = os.write
        with patch(
            "service.chat.persistence.journal.os.write",
            side_effect=lambda fd, data: original(fd, data[:7]),
        ):
            reference = self.put("partial" * 30)
        self.assertEqual(self.get(reference), "partial" * 30)
        with patch("service.chat.persistence.journal.os.fsync", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                self.put("unpublished")
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {BODY_TABLE}").fetchone()[0], 1
        )
        self.assertEqual(self.get(self.put("retry")), "retry")

    def test_qualified_memory_snapshot_reads_original_journal_but_cannot_write(self) -> None:
        reference = self.put("history")
        with closing(sqlite3.connect(":memory:")) as snapshot:
            snapshot.row_factory = sqlite3.Row
            self.connection.backup(snapshot)
            with Journal(snapshot, self.database) as journal:
                self.assertEqual(journal.get(reference), "history")
                snapshot.execute("BEGIN")
                with self.assertRaises(ValueError):
                    journal.put("forbidden")
            inspect_rows(snapshot, self.database)

    def test_missing_corrupt_and_truncated_files_fail_closed(self) -> None:
        reference = self.put("original")
        path = Journal(self.connection, self.database).path
        original = path.read_bytes()
        for data in (original.replace(b"original", b"tampered"), original[:-1]):
            path.write_bytes(data)
            with self.assertRaises(RuntimeError):
                self.get(reference)
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.get(reference)
        with self.assertRaises(FileNotFoundError):
            self.put("replacement")

    def test_bounds_and_unknown_reference_are_rejected(self) -> None:
        reference = self.put("body")
        self.connection.execute(f"UPDATE {BODY_TABLE} SET length=length+1")
        self.connection.commit()
        with self.assertRaisesRegex(RuntimeError, "bounds"):
            self.get(reference)
        with self.assertRaises(ValueError):
            self.get("ordinary text")

    def test_linked_files_are_rejected(self) -> None:
        reference = self.put("body")
        path = Journal(self.connection, self.database).path
        target = path.with_suffix(".original")
        path.rename(target)
        try:
            path.symlink_to(target)
        except OSError:
            self.skipTest("symlink creation unavailable")
        with self.assertRaises(OSError):
            self.get(reference)
        path.unlink()
        os.link(target, path)
        with self.assertRaises(OSError):
            self.get(reference)

    def test_sqlite_writer_lock_serializes_connections(self) -> None:
        with closing(sqlite3.connect(self.database, timeout=0)) as other:
            other.row_factory = sqlite3.Row
            self.connection.execute("BEGIN")
            with Journal(self.connection, self.database) as first:
                reference = first.put("committed")
                other.execute("BEGIN")
                with Journal(other, self.database) as second:
                    with self.assertRaises(sqlite3.OperationalError):
                        second.put("blocked")
                other.rollback()
            self.connection.commit()
            other.execute("BEGIN")
            with Journal(other, self.database) as second:
                next_reference = second.put("next")
            other.commit()
        self.assertEqual(self.get(reference), "committed")
        self.assertEqual(self.get(next_reference), "next")

    def test_batch_dedup_and_single_fsync_before_sql_publication(self) -> None:
        self.put("seed-directory")
        original = os.fsync
        with self.connection:
            self.connection.execute("BEGIN")
            with Journal(self.connection, self.database) as journal:
                with patch("service.chat.persistence.journal.os.fsync", wraps=original) as sync:
                    refs = journal.put_many(("one", "two", "one"))
                    self.assertEqual(sync.call_count, 2 if os.name != "nt" else 1)
                self.assertEqual(refs[0], refs[2])
                self.assertEqual(journal.get(refs[1]), "two")
        self.assertEqual(self.get(refs[0]), "one")

    def test_encoded_limit_rejects_expansion_without_publishing(self) -> None:
        with patch("service.chat.persistence.journal.RECORD_LIMIT", 90):
            with self.assertRaisesRegex(ValueError, "encoded"):
                self.put("\x00" * 30)
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {BODY_TABLE}").fetchone()[0], 0
        )

    def _live(self, connection):
        return (row[0] for row in connection.execute("SELECT ref FROM live_reference"))

    def _garbage_fixture(self):
        live = self.put("retained-history-正文")
        dead = self.put("deleted-session-body" * 200)
        with self.connection:
            self.connection.execute("CREATE TABLE live_reference(ref TEXT PRIMARY KEY)")
            self.connection.execute("INSERT INTO live_reference VALUES(?)", (live,))
        return live, dead

    def test_compaction_reclaims_deleted_bodies_and_preserves_reopen(self) -> None:
        live, dead = self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            self.assertTrue(compact(self.database, self._live))
        current = Journal(self.connection, self.database).path
        self.assertNotEqual(current, old)
        self.assertFalse(old.exists())
        self.assertLess(current.stat().st_size, 300)
        self.assertEqual(self.get(live), "retained-history-正文")
        with self.assertRaisesRegex(RuntimeError, "missing"):
            self.get(dead)
        with closing(sqlite3.connect(self.database)) as reopened:
            reopened.row_factory = sqlite3.Row
            with Journal(reopened, self.database) as journal:
                self.assertEqual(journal.get(live), "retained-history-正文")
            inspect_rows(reopened, self.database)
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {GENERATION_TABLE}").fetchone()[0], 0
        )
        self.assertEqual(self.get(self.put("new-generation-append")), "new-generation-append")

    def test_compaction_failure_before_switch_retains_original_and_staging_cleanup(self) -> None:
        live, dead = self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        with (
            patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1),
            patch("service.chat.persistence.journal.os.fsync", side_effect=OSError("disk-full")),
        ):
            with self.assertRaisesRegex(OSError, "disk-full"):
                compact(self.database, self._live)
        self.assertEqual(Journal(self.connection, self.database).path, old)
        self.assertEqual(self.get(live), "retained-history-正文")
        self.assertEqual(self.get(dead), "deleted-session-body" * 200)
        self.assertEqual(
            self.connection.execute(f"SELECT state FROM {GENERATION_TABLE}").fetchone()[0],
            "staging",
        )
        unknown = self.database.with_suffix(JOURNAL_SUFFIX) / "unowned.jsonl"
        unknown.write_text("untouched")
        self.assertEqual(cleanup(self.database), 1)
        self.assertTrue(unknown.exists())
        self.assertFalse(old.with_name("1.jsonl").exists())
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            self.assertTrue(compact(self.database, self._live))
        self.assertEqual(self.get(live), "retained-history-正文")

    def test_failure_after_switch_keeps_retired_manifest_until_retry(self) -> None:
        live, _ = self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        with (
            patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1),
            patch(
                "service.chat.persistence.journal.storage.DirectoryHandle.unlink",
                side_effect=OSError("busy"),
            ),
        ):
            with self.assertRaisesRegex(OSError, "busy"):
                compact(self.database, self._live)
        self.assertNotEqual(Journal(self.connection, self.database).path, old)
        self.assertTrue(old.exists())
        self.assertEqual(self.get(live), "retained-history-正文")
        self.assertEqual(
            self.connection.execute(f"SELECT state FROM {GENERATION_TABLE}").fetchone()[0],
            "retired",
        )
        self.assertEqual(cleanup(self.database), 1)
        self.assertFalse(old.exists())

    def test_corrupt_live_body_never_switches_generation(self) -> None:
        live, _ = self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        data = old.read_bytes().replace(b"retained-history", b"tampered-history")
        old.write_bytes(data)
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            with self.assertRaisesRegex(RuntimeError, "digest"):
                compact(self.database, self._live)
        self.assertEqual(Journal(self.connection, self.database).path, old)
        self.assertTrue(old.exists())
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {BODY_TABLE}").fetchone()[0], 2
        )

    def test_missing_active_file_does_not_delete_retired_copy(self) -> None:
        self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        with (
            patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1),
            patch(
                "service.chat.persistence.journal.storage.DirectoryHandle.unlink",
                side_effect=OSError("busy"),
            ),
        ):
            with self.assertRaises(OSError):
                compact(self.database, self._live)
        Journal(self.connection, self.database).path.unlink()
        with self.assertRaises(FileNotFoundError):
            cleanup(self.database)
        self.assertTrue(old.exists())

    def test_compaction_deadline_leaves_original_and_retryable_manifest(self) -> None:
        live, _ = self._garbage_fixture()
        old = Journal(self.connection, self.database).path
        expired = []
        original_get = Journal._read_indexed

        def expire_after_read(journal, digest, offset, length):
            value = original_get(journal, digest, offset, length)
            expired.append(True)
            return value

        with (
            patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1),
            patch.object(Journal, "_read_indexed", expire_after_read),
            patch(
                "service.chat.persistence.journal.time.monotonic",
                side_effect=lambda: 2.0 if expired else 0.0,
            ),
        ):
            self.assertFalse(compact(self.database, self._live, deadline=1.0))
        self.assertEqual(Journal(self.connection, self.database).path, old)
        self.assertEqual(self.get(live), "retained-history-正文")
        self.assertEqual(cleanup(self.database), 1)
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            self.assertTrue(compact(self.database, self._live))

    def test_compaction_cleans_empty_history_without_retaining_deleted_text(self) -> None:
        self._garbage_fixture()
        with self.connection:
            self.connection.execute("DELETE FROM live_reference")
        with patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1):
            self.assertTrue(compact(self.database, self._live))
        self.assertEqual(
            len(Journal(self.connection, self.database).path.read_bytes().splitlines()), 1
        )
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {BODY_TABLE}").fetchone()[0], 0
        )
        self.assertEqual(self.get(self.put("history-after-empty")), "history-after-empty")

    def test_cleanup_rejects_manifest_filename_with_wrong_header(self) -> None:
        self._garbage_fixture()
        with (
            patch("service.chat.persistence.journal.COMPACT_MIN_BYTES", 1),
            patch("service.chat.persistence.journal.os.fsync", side_effect=OSError("disk")),
        ):
            with self.assertRaises(OSError):
                compact(self.database, self._live)
        staging = self.database.with_suffix(JOURNAL_SUFFIX) / "1.jsonl"
        staging.write_bytes(b"unowned file\n")
        with self.assertRaisesRegex(RuntimeError, "header mismatch"):
            cleanup(self.database)
        self.assertEqual(staging.read_bytes(), b"unowned file\n")
        self.assertEqual(
            self.connection.execute(f"SELECT COUNT(*) FROM {GENERATION_TABLE}").fetchone()[0], 1
        )

    def test_index_inspection_checks_bounds_and_header_without_reading_bodies(self) -> None:
        reference = self.put("body-coverage")
        path = Journal(self.connection, self.database).path
        original = path.read_bytes()
        path.write_bytes(original.replace(b"body-coverage", b"body-tampered"))
        inspect_index_rows(self.connection, self.database)
        with self.assertRaisesRegex(RuntimeError, "digest"):
            self.get(reference)
        with self.connection:
            self.connection.execute(f"UPDATE {BODY_TABLE} SET offset=0")
        with self.assertRaisesRegex(RuntimeError, "index"):
            inspect_index_rows(self.connection, self.database)

    def test_readonly_schema_never_creates_body_directory(self) -> None:
        path = self.database.with_suffix(JOURNAL_SUFFIX)
        self.assertFalse(path.exists())
        with Journal(self.connection, self.database) as journal:
            self.assertEqual(journal.path, path / "0.jsonl")
        self.assertFalse(inspect_connection(self.connection).needs_write)
        self.assertFalse(path.exists())

    def test_incomplete_or_changed_schema_is_rejected(self) -> None:
        self.connection.execute(f"DROP TABLE {BODY_TABLE}")
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            inspect_connection(self.connection)


if __name__ == "__main__":
    unittest.main()
