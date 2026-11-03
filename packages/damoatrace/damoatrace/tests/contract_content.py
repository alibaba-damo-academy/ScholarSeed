"""Content retention, bounds and private-file contracts (not product acceptance)."""

from __future__ import annotations

import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from collections import UserDict
from contextlib import closing, redirect_stderr, redirect_stdout
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path, PureWindowsPath
from unittest.mock import Mock, patch

from damoatrace.cli import main as cli
from damoatrace.cli.output import EXIT_ERROR
from damoatrace.data.inspection import inspect_event_line, inspect_event_record
from damoatrace.data.records import decode_event_line, decode_object_line
from damoatrace.data.store import CONTEXT_LEDGER_FILES, TraceStore
from damoatrace.paths import TracePaths
from damoatrace.recording.content import (
    BLOCK_LIMIT,
    CONTENT_VERSION,
    ContentCategory,
    UnsupportedContentVersion,
    content_block,
    has_content,
    inspect_content_versions,
    visible_content,
)
from damoatrace.recording.redaction import Redactor
from damoatrace.recording.storage import purge_content
from damoatrace.recording.writer import EvidenceWriter
from damoatrace.search.fts import FtsSearch
from damoatrace.search.index import PROJECTION_VERSION, IndexCheck, TraceIndex


class ContentContract(unittest.TestCase):
    def test_missing_trace_directory_never_returns_cached_index_hits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            traces = root / "trace"
            search = FtsSearch(traces, root / "cache" / "index.sqlite3")
            try:
                self.assertIsNone(search.search("needle"))
                self.assertFalse(traces.exists())
                traces.mkdir()
                source = traces / "events.jsonl"
                source.write_text('{"id":"known","name":"needle"}\n')
                self.assertEqual(len(search.search("needle")), 1)
                source.unlink()
                search.meta_path.unlink()
                traces.rmdir()
                self.assertEqual(len(search._index.search("needle")), 1)
                self.assertIsNone(search.search("needle"))
                self.assertEqual(TraceStore(traces).all_events(), [])
            finally:
                if search._index is not None:
                    search._index.close()

    def test_query_cli_reports_unreadable_content_without_success_or_traceback(self) -> None:
        for payload, error_name in (
            (b"\xff\n", "UnicodeDecodeError"),
            (b'{"diagnostic_content_version":999}\n', "UnsupportedContentVersion"),
        ):
            with self.subTest(error=error_name), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "events.jsonl"
                source.write_bytes(payload)
                result = subprocess.run(
                    [sys.executable, "-m", "damoatrace", "--trace-file", str(source), "events"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, EXIT_ERROR)
                self.assertEqual(result.stdout, "")
                self.assertIn(error_name, result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(source.read_bytes(), payload)

    def test_query_cli_preserves_io_failure_as_nonzero_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            store = TraceStore(Path(directory))
            output, diagnostic = io.StringIO(), io.StringIO()
            with (
                patch.object(cli, "_store", return_value=store),
                patch.object(Path, "iterdir", side_effect=PermissionError("denied")),
                redirect_stdout(output),
                redirect_stderr(diagnostic),
            ):
                result = cli.main(["events"])
            self.assertEqual(result, EXIT_ERROR)
            self.assertEqual(output.getvalue(), "")
            self.assertIn("PermissionError", diagnostic.getvalue())
            self.assertNotIn("Traceback", diagnostic.getvalue())

    def test_query_enumeration_preserves_windows_case_matching(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = Mock(wraps=PureWindowsPath("EVENTS.JSONL"))
            source.name = "EVENTS.JSONL"
            source.is_file = Mock(return_value=True)
            source.stat = Mock(return_value=root.stat())
            index = Mock(projection_reset=False)
            index.ingest_jsonl.return_value = 1
            search = FtsSearch(root)
            with patch.object(Path, "iterdir", return_value=iter((source,))):
                self.assertEqual(TraceStore(root)._scan_files(), [source])
            with (
                patch.object(Path, "iterdir", return_value=iter((source,))),
                patch.object(search, "_open", return_value=index),
            ):
                self.assertEqual(search.ensure_indexed(), {"files": 1, "events": 1})
            index.ingest_jsonl.assert_called_once_with(source)

    def test_queries_reject_future_content_before_filtering_malformed_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "events.jsonl"
            source.write_text('{"diagnostic_content_version":999,"attributes":[]}\n')
            before = source.read_bytes()
            with self.assertRaises(UnsupportedContentVersion):
                TraceStore(root).all_events()
            self.assertEqual(source.read_bytes(), before)

    def test_history_read_failures_are_not_successful_empty_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = TracePaths.from_home(root / "home", ledger_root=root / "ledger")
            paths.trace.mkdir(parents=True)
            source = paths.trace / "events.jsonl"
            source.write_bytes(b"\xff\n")
            store = TraceStore(paths.trace, paths=paths)
            with self.assertRaises(UnicodeError):
                store.all_events()
            with patch("builtins.open", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    store.all_events()
            self.assertEqual(store.session_context_items("missing")["items"], [])
            paths.ledger_root.mkdir()
            with patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    store.session_context_items("session")
                with self.assertRaises(PermissionError):
                    store.all_events()
            ledger = paths.ledger_root / "project" / "session" / "context"
            ledger.mkdir(parents=True)
            with patch.object(Path, "open", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    store.session_context_items("session")
            (ledger / "items.jsonl").write_bytes(b"\xff\n")
            with self.assertRaises(UnicodeError):
                store.session_context_items("session")
            (ledger / "items.jsonl").write_text('{"diagnostic_content_version":999}\n')
            with self.assertRaises(UnsupportedContentVersion):
                store.session_context_items("session")

    def test_search_does_not_return_stale_hits_after_source_read_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "events.jsonl"
            source.write_text('{"id":"known","name":"needle"}\n')
            search = FtsSearch(root)
            self.assertEqual(len(search.search("needle")), 1)
            self.addCleanup(search._index.close)
            before_meta = search.meta_path.read_bytes()
            source.write_bytes(b"\xff\n")
            with self.assertRaises(UnicodeError):
                search.search("needle")
            with patch.object(Path, "iterdir", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    search.search("needle")
            with patch.object(Path, "open", side_effect=PermissionError("denied")):
                with self.assertRaises(PermissionError):
                    search.search("needle")
            self.assertEqual(search.meta_path.read_bytes(), before_meta)
            self.assertEqual(source.read_bytes(), b"\xff\n")

    def test_on_demand_context_projection_rejects_unreadable_nested_history(self) -> None:
        for name, field, value in (
            ("items.jsonl", "supersedes", 1),
            ("operations.jsonl", "input_item_refs", 1),
            ("spans.jsonl", "used_item_refs", 1),
            ("visible_indexes.jsonl", "entries", ["future-entry"]),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                ledger = root / "ledger" / "project" / "session" / "context"
                ledger.mkdir(parents=True)
                records = self.context_records()
                records[name][0][field] = value
                for filename, rows in records.items():
                    (ledger / filename).write_text("".join(json.dumps(row) + "\n" for row in rows))
                before = {path.name: path.read_bytes() for path in ledger.iterdir()}
                paths = TracePaths.from_home(root / "home", ledger_root=root / "ledger")
                store = TraceStore(paths.trace, paths=paths)
                for query in (
                    lambda: store.session_context_item("session", "item"),
                    lambda: store.session_context_items("session"),
                ):
                    with self.assertRaises((TypeError, AttributeError, ValueError)):
                        query()
                self.assertEqual(
                    {path.name: path.read_bytes() for path in ledger.iterdir()}, before
                )

    def test_on_demand_projection_rejects_unknown_content_before_reinterpretation(self) -> None:
        for record in (
            {"diagnostic_content_version": 999},
            {"diagnostic_content_version": 1, "outputs": {"version": 999, "blocks": []}},
            {"diagnostic_content_version": 1, "outputs": {"legacy": "not a versioned envelope"}},
        ):
            before = deepcopy(record)
            for include_content in (False, True):
                with self.subTest(record=record, include_content=include_content):
                    with self.assertRaises(UnsupportedContentVersion):
                        visible_content(record, include_content=include_content)
            with self.assertRaises(UnsupportedContentVersion):
                TraceIndex.project_record(record)
            self.assertEqual(record, before)

    def test_indexed_search_does_not_hide_future_content_or_return_stale_hits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "session.jsonl"
            path.write_text('{"id":"known","name":"needle"}\n')
            search = FtsSearch(root)
            self.assertEqual(len(search.search("needle")), 1)
            self.addCleanup(search._index.close)
            before_meta = search.meta_path.read_bytes()
            before_index = search._index.count()
            payload = path.read_bytes() + b'{"id":"future","diagnostic_content_version":999}\n'
            path.write_bytes(payload)
            for operation in (search.ensure_indexed, lambda: search.search("needle")):
                with self.assertRaises(UnsupportedContentVersion):
                    operation()
            self.assertEqual(path.read_bytes(), payload)
            self.assertEqual(search.meta_path.read_bytes(), before_meta)
            self.assertEqual(search._index.count(), before_index)
            with self.assertRaises(UnsupportedContentVersion):
                TraceStore(root).all_events()

    def test_index_projection_reads_attributes_without_copying_them(self) -> None:
        class UncopiedAttributes(dict):
            def __deepcopy__(self, memo):
                raise AssertionError("scalar index projection must not copy attributes")

        attributes = UncopiedAttributes(nested={"items": ["原文"]}, usage={"input_tokens": 3})
        record = {"name": "legacy", "attributes": attributes, "extra": attributes}
        result = TraceIndex.project_record(record)
        self.assertEqual(result["body"], 'legacy {"nested": {"items": ["原文"]}}')
        self.assertTrue(all(isinstance(value, str) for value in result.values()))
        self.assertEqual(attributes["nested"]["items"], ["原文"])

    def test_index_projection_preserves_mapping_visibility_and_legacy_fields(self) -> None:
        record = UserDict(
            {
                "id": "id",
                "task_run_id": "run",
                "session_id": "session",
                "component_id": "component",
                "kind": "tool",
                "name": "查询",
                "status": "error",
                "started_at": "2026-10-13T00:00:00Z",
                "diagnostic_content_version": CONTENT_VERSION,
                "inputs": {
                    "version": CONTENT_VERSION,
                    "blocks": [{"data": "secret", "expires_at": 200}],
                },
                "outputs": {"version": CONTENT_VERSION, "legacy": ["输出"]},
                "attributes": {"nested": ["attr"], "usage": {"input_tokens": 3}},
                "error": {"code": "ERR", "message": "private", "error_class": "tool"},
            }
        )
        before = deepcopy(record)
        with patch("damoatrace.recording.content.time.time", return_value=100):
            result = TraceIndex.project_record(record)
        self.assertEqual(
            result,
            {
                "id": "id",
                "task_run_id": "run",
                "session_id": "session",
                "component_id": "component",
                "kind": "tool",
                "name": "查询",
                "status": "error",
                "started_at": "2026-10-13T00:00:00Z",
                "body": '查询 {"version": 1, "legacy": ["输出"]} {"nested": ["attr"]}',
                "tool_input": '{"version": 1, "blocks": [{"expires_at": 200, "missing_reason": "content_not_requested"}]}',
                "error_class": "tool",
                "error_text": "ERR content_not_requested",
            },
        )
        self.assertEqual(record, before)

    def test_hidden_content_is_not_copied(self) -> None:
        class UncopiedPayload(dict):
            def __deepcopy__(self, memo):
                raise AssertionError("hidden payload must not be copied")

        for include_content, expires_at in ((False, 200), (False, 50), (True, 50)):
            with self.subTest(include_content=include_content, expires_at=expires_at):
                payload = UncopiedPayload(items=[{"text": "private"}])
                record = {
                    "diagnostic_content_version": CONTENT_VERSION,
                    "inputs": {
                        "version": CONTENT_VERSION,
                        "blocks": [{"data": payload, "text": payload, "expires_at": expires_at}],
                    },
                }
                result = visible_content(record, include_content=include_content, now=100)
                self.assertEqual(
                    result["inputs"]["blocks"],
                    [
                        {
                            "expires_at": expires_at,
                            "missing_reason": (
                                "expired" if expires_at <= 100 else "content_not_requested"
                            ),
                        }
                    ],
                )
                self.assertIs(record["inputs"]["blocks"][0]["data"], payload)

    def test_visible_projection_is_independent_of_its_input(self) -> None:
        for include_content in (False, True):
            with self.subTest(include_content=include_content):
                record = {
                    "diagnostic_content_version": CONTENT_VERSION,
                    "attributes": {"nested": ["原文"]},
                    "error": {"message": "private", "details": {"codes": [1]}},
                    "outputs": {
                        "version": CONTENT_VERSION,
                        "blocks": [
                            {"data": {"items": ["private"]}, "expires_at": 200, "metadata": [1]},
                            {"data": "expired", "expires_at": 50},
                            {"expires_at": 200},
                            "opaque",
                        ],
                    },
                }
                before = deepcopy(record)
                result = visible_content(record, include_content=include_content, now=100)
                blocks = result["outputs"]["blocks"]
                self.assertEqual(len(blocks), 3)
                self.assertEqual(blocks[1], {"expires_at": 50, "missing_reason": "expired"})
                self.assertEqual(blocks[2], {"expires_at": 200})
                self.assertEqual(
                    result["error"]["message"],
                    "private" if include_content else "content_not_requested",
                )
                result["attributes"]["nested"].append("changed")
                result["error"]["details"]["codes"].append(2)
                blocks[0]["metadata"].append(2)
                if include_content:
                    blocks[0]["data"]["items"].append("changed")
                else:
                    self.assertNotIn("data", blocks[0])
                self.assertEqual(record, before)

    @staticmethod
    def context_records():
        return {
            "items.jsonl": [
                {
                    "item_id": "item",
                    "content": "private context",
                    "content_hash": "hash",
                    "channel": "prompt",
                    "version": 1,
                    "supersedes": [],
                    "lifecycle_started_at": "2026-09-01T00:00:00Z",
                }
            ],
            "operations.jsonl": [
                {"operation_id": "operation", "kind": "append", "output_item_refs": ["item"]}
            ],
            "spans.jsonl": [
                {
                    "context_span_id": "span",
                    "kind": "compose",
                    "input_item_refs": ["item"],
                    "created_at": "2026-09-01T00:00:01Z",
                }
            ],
            "visible_indexes.jsonl": [
                {
                    "visible_index_id": "index",
                    "created_at": "2026-09-01T00:00:02Z",
                    "entries": [{"item_id": "item", "ordinal": 0, "context_span_id": "span"}],
                }
            ],
        }

    def test_context_preflight_uses_the_real_query_projections_without_mutation(self) -> None:
        records = self.context_records()
        before = json.dumps(records, sort_keys=True)
        TraceStore.inspect_context_records(records)
        self.assertEqual(json.dumps(records, sort_keys=True), before)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = root / "ledger" / "project" / "session" / "context"
            ledger.mkdir(parents=True)
            for name in CONTEXT_LEDGER_FILES:
                (ledger / name).write_text(
                    "".join(json.dumps(row) + "\n" for row in records[name]), encoding="utf-8"
                )
            paths = TracePaths.from_home(root / "home", ledger_root=root / "ledger")
            store = TraceStore(paths.trace, paths=paths)
            item = store.session_context_item("session", "item")
            self.assertIsNotNone(item)
            self.assertEqual(item["versions"][0]["content"], "private context")
            self.assertEqual(store.session_context_items("session")["items"][0]["visible_count"], 1)
            self.assertFalse(paths.index.exists())
            for name in CONTEXT_LEDGER_FILES:
                self.assertEqual(
                    [json.loads(line) for line in (ledger / name).read_text().splitlines()],
                    records[name],
                )

    def test_context_preflight_rejects_unreadable_nested_records(self) -> None:
        for name, field, value in (
            ("items.jsonl", "supersedes", 1),
            ("operations.jsonl", "input_item_refs", 1),
            ("spans.jsonl", "used_item_refs", 1),
            ("visible_indexes.jsonl", "entries", ["future-entry"]),
        ):
            with self.subTest(name=name, field=field):
                records = self.context_records()
                records[name][0][field] = value
                before = json.dumps(records, sort_keys=True)
                with self.assertRaises((TypeError, AttributeError, ValueError)):
                    TraceStore.inspect_context_records(records)
                self.assertEqual(json.dumps(records, sort_keys=True), before)

    def test_inspection_reads_writer_events_without_creating_an_index(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "inspect.jsonl"
            with EvidenceWriter(path) as writer:
                writer.emit(
                    session_id="session",
                    kind="llm.stream",
                    name="response",
                    task_run_id="run",
                    component_id="test",
                    attributes={"usage": {"input_tokens": 3, "output_tokens": 2}},
                )
            before = path.read_bytes()
            for line in before.decode("utf-8").splitlines():
                self.assertTrue(inspect_event_line(line))
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((root / "index.sqlite3").exists())
            self.assertEqual(len(TraceStore(root, trace_file=path, offline=True).all_events()), 1)

    def test_shared_record_inspection_decodes_once_and_preserves_input(self) -> None:
        record = {
            "diagnostic_content_version": CONTENT_VERSION,
            "name": "Unicode 检查",
            "attributes": {
                "usage": {"input_tokens": 3, "output_tokens": 2},
                "nested": {"items": [1, {"text": "private"}]},
            },
            "inputs": {"version": CONTENT_VERSION, "content": {"text": "历史输入"}},
            "outputs": {"version": CONTENT_VERSION, "content": {"text": "历史输出"}},
        }
        payload = json.dumps(record)
        results = []

        def observe(value):
            before = deepcopy(value)
            results.append(inspect_event_record(value))
            self.assertEqual(value, before)

        with patch("damoatrace.recording.content.json.loads", wraps=json.loads) as decoder:
            versions = inspect_content_versions((payload,), inspect_record=observe)
        self.assertEqual(decoder.call_count, 1)
        self.assertEqual(versions, (CONTENT_VERSION,))
        self.assertEqual(results, [True])
        self.assertEqual(json.dumps(record), payload)

    def test_future_version_rejected_before_record_observer(self) -> None:
        with patch("damoatrace.data.inspection.inspect_event_record") as observer:
            with self.assertRaises(ValueError):
                inspect_content_versions(
                    ('{"diagnostic_content_version":999}',), inspect_record=observer
                )
        observer.assert_not_called()

    def test_shared_record_inspection_preserves_opaque_and_blank_lines(self) -> None:
        results = []
        versions = inspect_content_versions(
            (" \n", "interrupted line", "[]", '{"attributes":[]}', "{}"),
            inspect_record=lambda value: results.append(inspect_event_record(value)),
        )
        self.assertEqual(versions, ())
        self.assertEqual(results, [False, False, False, True])

    def test_inspection_preserves_query_skip_policy_and_uses_actual_usage_decoder(self) -> None:
        for line in ("interrupted historical line", "[]", '{"attributes":[]}'):
            with self.subTest(line=line):
                self.assertIsNone(decode_event_line(line))
                self.assertFalse(inspect_event_line(line))
        self.assertEqual(decode_object_line('{"legacy":true}'), {"legacy": True})
        self.assertTrue(inspect_event_line('{"legacy":true}'))
        with self.assertRaises(ValueError):
            inspect_event_line('{"attributes":{"usage":{"input_tokens":"future"}}}')

    def test_compaction_inspection_uses_normal_query_projection_and_preserves_bytes(self) -> None:
        event = {
            "session_id": "session",
            "kind": "context",
            "name": "context.compaction",
            "started_at": "2026-09-01T00:00:00Z",
            "task_run_id": "turn",
            "span_id": "span",
            "attributes": {
                "run_id": "run",
                "trace_ref": "private-trace-reference",
                "item_transitions": [
                    {"item_id": "old", "checkpoint_item_ids": ["checkpoint"]},
                    None,
                ],
                "retained_items": [{"item_id": "retained"}, "historical opaque member"],
            },
        }
        original = json.dumps(event)
        self.assertTrue(inspect_event_line(original))
        projected = TraceStore.project_compaction_events([event])
        self.assertEqual(
            projected[0]["item_transitions"], [event["attributes"]["item_transitions"][0]]
        )
        self.assertEqual(projected[0]["retained_items"], [{"item_id": "retained"}])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "compaction.jsonl"
            path.write_text(original + "\n", encoding="utf-8")
            before = path.read_bytes()
            store = TraceStore(root, trace_file=path, offline=True)
            self.assertEqual(store._context_compaction_events("session"), projected)
            self.assertEqual(path.read_bytes(), before)
            self.assertFalse((root / "index.sqlite3").exists())
        self.assertEqual(json.dumps(event), original)

    def test_compaction_preflight_does_not_skip_an_unreadable_retained_collection(self) -> None:
        event = {
            "kind": "context",
            "name": "context.compaction",
            "attributes": {
                "item_transitions": [{"item_id": "old"}],
                "retained_items": None,
            },
        }
        with self.assertRaises(TypeError):
            TraceStore.project_compaction_events([event])
        with self.assertRaises(TypeError):
            inspect_event_line(json.dumps(event))
        # Historical records without item-level transitions follow the normal
        # query's skip policy and remain preserved in the source file.
        event["attributes"].pop("item_transitions")
        self.assertEqual(TraceStore.project_compaction_events([event]), [])
        self.assertTrue(inspect_event_line(json.dumps(event)))

    def test_writer_preserves_explicit_interval_and_instant_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "timing.jsonl"
            started = datetime(2026, 9, 21, tzinfo=timezone.utc)
            with EvidenceWriter(path) as writer:
                fields = dict(
                    session_id="timing-session",
                    kind="runtime.activation",
                    name="preflight",
                    task_run_id="activation",
                    component_id="test",
                    attributes={},
                )
                writer.emit(
                    **fields,
                    span_id="timed-span",
                    parent_span_id="parent-span",
                    started_at=started,
                    duration_ms=125.5,
                )
                writer.emit(**fields)
            rows = TraceStore(root, trace_file=path, offline=True).all_events()
            timed = next(row for row in rows if row["span_id"] == "timed-span")
            instant = next(row for row in rows if row["span_id"] != "timed-span")
            self.assertEqual(timed["started_at"], started.isoformat())
            self.assertEqual(
                timed["ended_at"], (started + timedelta(milliseconds=125.5)).isoformat()
            )
            self.assertEqual(timed["duration_ms"], 125.5)
            self.assertEqual(timed["parent_span_id"], "parent-span")
            self.assertEqual(instant["started_at"], instant["ended_at"])
            self.assertEqual(instant["duration_ms"], 0)
            self.assertIsNone(instant["parent_span_id"])

    def test_writer_rejects_invalid_measurements_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invalid.jsonl"
            with EvidenceWriter(path) as writer:
                fields = dict(
                    session_id="timing-session",
                    kind="runtime.activation",
                    name="invalid",
                    task_run_id="activation",
                    component_id="test",
                    attributes={},
                )
                for duration in (-1, float("nan"), float("inf")):
                    with self.subTest(duration=duration), self.assertRaises(ValueError):
                        writer.emit(**fields, duration_ms=duration)
                with self.assertRaises(ValueError):
                    writer.emit(**fields, started_at=datetime(2026, 9, 21))
            self.assertFalse(path.exists())

    def test_writer_requires_integer_content_version_before_creating_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "invalid-version.jsonl"
            with EvidenceWriter(path) as writer:
                for version in (999, True, 1.0, "1", None):
                    with (
                        self.subTest(version=version),
                        self.assertRaisesRegex(ValueError, "unsupported diagnostic content"),
                    ):
                        writer.emit(
                            session_id="session",
                            kind="tool.exec",
                            name="result",
                            task_run_id="turn",
                            component_id="test",
                            attributes={},
                            outputs={"version": version, "blocks": []},
                        )
            self.assertFalse(path.exists())

    def test_secret_echo_is_filtered_in_same_recorder(self) -> None:
        redactor = Redactor()
        redactor.value("假凭据 api_key=diagnostic-fixture-credential，不要联网。")
        self.assertNotIn(
            "diagnostic-fixture-credential", redactor.text("收到 diagnostic-fixture-credential")
        )
        self.assertNotIn(
            "another-fixture-secret",
            redactor.value({"echo": "another-fixture-secret", "api_key": "another-fixture-secret"})[
                "echo"
            ],
        )

    def test_checkpoint_uses_writable_descriptor_without_mutating_trace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "session.jsonl"
            writer = EvidenceWriter(path)
            writer.emit(
                session_id="session",
                kind="turn.end",
                name="checkpoint",
                task_run_id="turn",
                component_id="test",
                attributes={},
            )
            before = path.read_bytes()

            def require_writable_descriptor(file_descriptor: int) -> None:
                os.write(file_descriptor, b"")

            with patch(
                "damoatrace.recording.writer.os.fsync",
                side_effect=require_writable_descriptor,
            ):
                writer.checkpoint()

            self.assertEqual(path.read_bytes(), before)

    def test_sql_and_search_share_content_projection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "session.jsonl"
            block = content_block(
                ContentCategory.ANSWER,
                "private-search-needle",
                source="runtime_observation",
                revision=1,
                redactor=Redactor(),
            )
            writer = EvidenceWriter(path)
            writer.emit(
                session_id="session",
                kind="tool.exec",
                name="public-name",
                task_run_id="turn",
                component_id="test",
                attributes={},
                outputs={"version": CONTENT_VERSION, "blocks": [block]},
            )
            writer.close()
            with (
                patch.multiple(
                    cli, TRACE_DIR=root, APP_LOG_DIR=root / "logs", METRICS_DIR=root / "metrics"
                ),
                patch.object(cli, "ensure_home"),
            ):

                def query(*args: str) -> tuple[int, dict]:
                    output = io.StringIO()
                    with redirect_stdout(output):
                        status = cli.main(list(args))
                    return status, json.loads(output.getvalue()) if output.getvalue() else {}

                status, result = query("sql", "select outputs from trace", "--full")
                self.assertEqual(status, 0)
                self.assertNotIn("private-search-needle", json.dumps(result))
                status, result = query("sql", "select outputs from trace", "--include-content")
                self.assertEqual(status, 0)
                self.assertIn("private-search-needle", json.dumps(result))
                self.assertEqual(query("sql", f"select * from read_json_auto('{path}')")[0], 2)
                self.assertEqual(query("search", "private-search-needle")[1]["total"], 0)
                self.assertGreater(
                    query("search", "private-search-needle", "--include-content")[1]["total"], 0
                )
                self.assertNotIn(b"private-search-needle", FtsSearch(root).db_path.read_bytes())
                purge_content(path, all_content=True)
                self.assertNotIn(
                    "private-search-needle",
                    json.dumps(query("sql", "select outputs from trace", "--include-content")),
                )

    def test_index_startup_preview_rebuilds_only_the_private_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            with closing(TraceIndex(path)) as index:
                index._fts.upsert({"id": "retained", "body": "original searchable text"})
            with closing(sqlite3.connect(path)) as source:
                source.execute("DELETE FROM projection_versions")
                source.commit()
                source.execute("BEGIN")
                before = path.read_bytes(), source.serialize()
                self.assertFalse(TraceIndex.inspect_startup(source, deadline=time.monotonic() + 30))
                self.assertEqual((path.read_bytes(), source.serialize()), before)
                self.assertEqual(
                    source.execute("SELECT id FROM trace_events").fetchall(), [("retained",)]
                )
                self.assertEqual(source.execute("SELECT * FROM projection_versions").fetchall(), [])
            # The normal writer uses the same initialization and actually resets it.
            with closing(TraceIndex(path)) as index:
                self.assertTrue(index.projection_reset)
                self.assertEqual(index.count(), 0)

    def test_index_startup_preview_rejects_marker_with_wrong_table(self) -> None:
        with closing(sqlite3.connect(":memory:")) as source:
            source.execute("CREATE TABLE projection_versions (name TEXT PRIMARY KEY, version TEXT)")
            source.execute(
                "INSERT INTO projection_versions VALUES ('trace_events', ?)", (PROJECTION_VERSION,)
            )
            source.execute("CREATE TABLE trace_events (id TEXT, body TEXT)")
            source.commit()
            source.execute("BEGIN")
            before = source.serialize()
            with self.assertRaisesRegex(ValueError, "unsupported Trace index columns"):
                TraceIndex.inspect_startup(source, deadline=time.monotonic() + 30)
            self.assertEqual(source.serialize(), before)

    def test_index_startup_preview_checks_current_fts_and_its_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            with closing(TraceIndex(path)) as index:
                index._fts.upsert({"id": "retained", "body": "searchable text"})
            with closing(sqlite3.connect(path)) as source:
                source.execute("BEGIN")
                before = path.read_bytes(), source.serialize()
                self.assertTrue(TraceIndex.inspect_startup(source, deadline=time.monotonic() + 30))
                with self.assertRaisesRegex(ValueError, "budget"):
                    TraceIndex.inspect_startup(source, deadline=time.monotonic() + 30, max_bytes=1)
                self.assertEqual((path.read_bytes(), source.serialize()), before)
            self.assertFalse(TraceIndex.inspect_startup(None, deadline=time.monotonic() + 30))

    def test_readonly_index_check_preserves_source_and_never_copies_database(self) -> None:
        class UncopiedConnection(sqlite3.Connection):
            def backup(self, *args, **kwargs):
                raise AssertionError("ordinary startup must not copy the database")

        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            with closing(TraceIndex(path)) as index:
                index._fts.upsert({"id": "retained", "body": "original searchable text"})
            with closing(
                sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, factory=UncopiedConnection)
            ) as source:
                source.execute("BEGIN")
                before = path.read_bytes(), source.serialize()
                observed = TraceIndex.inspect_readonly(source)
                self.assertTrue(observed.current)
                self.assertEqual(observed.sqlite_check, IndexCheck.COMPLETE)
                self.assertTrue(source.in_transaction)
                self.assertTrue(source.getconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA))
                self.assertEqual((path.read_bytes(), source.serialize()), before)

    def test_readonly_index_budget_is_explicit_and_progress_handler_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            with closing(TraceIndex(path)) as index:
                index._fts.upsert({"id": "retained", "body": "searchable text"})
            with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as source:
                source.execute("BEGIN")
                before = source.serialize()
                observed = TraceIndex.inspect_readonly(source, budget_seconds=0)
                self.assertEqual(observed.sqlite_check, IndexCheck.INCOMPLETE_BUDGET)
                with (
                    patch("damoatrace.search.index.INDEX_CHECK_PROGRESS_OPS", 1),
                    patch("damoatrace.search.index.time.monotonic", side_effect=[0, 0, 2]),
                ):
                    observed = TraceIndex.inspect_readonly(source, budget_seconds=1)
                self.assertEqual(observed.sqlite_check, IndexCheck.INCOMPLETE_BUDGET)
                self.assertEqual(
                    source.execute("SELECT id FROM trace_events").fetchall(), [("retained",)]
                )
                self.assertEqual(source.serialize(), before)
                self.assertTrue(source.in_transaction)
                self.assertEqual(
                    TraceIndex.inspect_readonly(source).sqlite_check, IndexCheck.COMPLETE
                )
                with self.assertRaisesRegex(ValueError, "budget"):
                    TraceIndex.inspect_startup(source, deadline=time.monotonic() - 1)

    def test_readonly_index_does_not_treat_other_sqlite_errors_as_budget(self) -> None:
        class FailingConnection(sqlite3.Connection):
            def execute(self, sql, *args, **kwargs):
                if sql == "PRAGMA quick_check(1)":
                    error = sqlite3.OperationalError("database is locked")
                    error.sqlite_errorcode = sqlite3.SQLITE_BUSY
                    raise error
                return super().execute(sql, *args, **kwargs)

        with closing(sqlite3.connect(":memory:", factory=FailingConnection)) as source:
            with self.assertRaisesRegex(sqlite3.OperationalError, "database is locked"):
                TraceIndex.inspect_readonly(source)
            self.assertTrue(source.getconfig(sqlite3.SQLITE_DBCONFIG_TRUSTED_SCHEMA))

    def test_readonly_index_rejects_confirmed_corruption_without_repair(self) -> None:
        with closing(sqlite3.connect(":memory:")) as source:
            source.execute("CREATE TABLE evidence(value INTEGER CHECK(value > 0))")
            source.execute("PRAGMA ignore_check_constraints=ON")
            source.execute("INSERT INTO evidence VALUES (-1)")
            source.commit()
            source.execute("PRAGMA ignore_check_constraints=OFF")
            source.execute("BEGIN")
            before = source.serialize()
            with self.assertRaisesRegex(ValueError, "SQLite integrity check failed"):
                TraceIndex.inspect_readonly(source)
            self.assertEqual(source.serialize(), before)
            self.assertEqual(source.execute("SELECT value FROM evidence").fetchone(), (-1,))

    def test_readonly_index_rejects_future_marker_and_unsupported_structure_before_budget(
        self,
    ) -> None:
        cases = (
            ("CREATE VIEW unsupported AS SELECT 1", "unsupported Trace index schema"),
            (
                "CREATE TABLE evidence(value); CREATE TRIGGER unsupported AFTER INSERT ON evidence BEGIN SELECT 1; END",
                "unsupported Trace index schema",
            ),
            ("CREATE TABLE trace_events(id TEXT)", "unsupported Trace index columns"),
            (
                f"CREATE TABLE trace_events({', '.join(TraceIndex.COLUMNS)})",
                "unsupported Trace index table",
            ),
            (
                "CREATE TABLE projection_versions(name, version); INSERT INTO projection_versions VALUES ('trace_events', 'future')",
                "unsupported projection version",
            ),
        )
        for sql, message in cases:
            with self.subTest(sql=sql), closing(sqlite3.connect(":memory:")) as source:
                source.executescript(sql)
                source.execute("BEGIN")
                before = source.serialize()
                with self.assertRaisesRegex(ValueError, message):
                    TraceIndex.inspect_readonly(source, budget_seconds=0)
                self.assertEqual(source.serialize(), before)

    def test_readonly_index_observes_missing_and_unmarked_without_rewriting(self) -> None:
        absent = TraceIndex.inspect_readonly(None, budget_seconds=0)
        self.assertFalse(absent.current)
        self.assertEqual(absent.sqlite_check, IndexCheck.NOT_PRESENT)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            with closing(TraceIndex(path)) as index:
                index._fts.upsert({"id": "retained", "body": "original history"})
            with closing(sqlite3.connect(path)) as writer:
                writer.execute("DELETE FROM projection_versions")
                writer.commit()
            before = path.read_bytes()
            with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as source:
                source.execute("BEGIN")
                observed = TraceIndex.inspect_readonly(source)
                self.assertFalse(observed.current)
                self.assertEqual(observed.sqlite_check, IndexCheck.COMPLETE)
                self.assertEqual(
                    source.execute("SELECT id FROM trace_events").fetchone(), ("retained",)
                )
            self.assertEqual(path.read_bytes(), before)

    def test_previous_fts_projection_is_physically_invalidated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "index.sqlite3"
            index = TraceIndex(path)
            index._fts.upsert({"id": "old", "body": "old-diagnostic-private-body"})
            index._fts._con.execute("DELETE FROM projection_versions")
            index._fts._con.commit()
            index.close()
            replacement = TraceIndex(path)
            self.assertEqual(replacement.count(), 0)
            replacement.close()
            self.assertNotIn(b"old-diagnostic-private-body", path.read_bytes())

    def test_future_projection_is_preserved_before_index_creation_or_reset(self) -> None:
        for existing_index in (False, True):
            with self.subTest(existing_index=existing_index), tempfile.TemporaryDirectory() as root:
                path = Path(root) / "index.sqlite3"
                if existing_index:
                    index = TraceIndex(path)
                    index._fts.upsert({"id": "kept", "body": "preserved future data"})
                    index.close()
                with closing(sqlite3.connect(path)) as writer:
                    writer.execute("PRAGMA journal_mode=WAL")
                    writer.execute("PRAGMA wal_autocheckpoint=0")
                    writer.execute(
                        "CREATE TABLE IF NOT EXISTS projection_versions (name TEXT PRIMARY KEY, version TEXT)"
                    )
                    writer.execute(
                        "INSERT OR REPLACE INTO projection_versions VALUES ('trace_events', 'future-v999')"
                    )
                    writer.commit()
                    wal = Path(str(path) + "-wal")
                    before = path.read_bytes(), wal.read_bytes(), tuple(writer.iterdump())
                    opened = TraceIndex.try_open(path)
                    try:
                        self.assertIsNone(opened)
                        self.assertEqual(
                            (path.read_bytes(), wal.read_bytes(), tuple(writer.iterdump())), before
                        )
                    finally:
                        if opened is not None:
                            opened.close()

    def test_projection_reset_rejects_version_changed_after_open(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            index = TraceIndex(Path(root) / "index.sqlite3")
            try:
                index._fts.upsert({"id": "kept", "body": "preserved future data"})
                index._fts._con.execute("UPDATE projection_versions SET version='future-v999'")
                index._fts._con.commit()
                before = tuple(index._fts._con.iterdump())
                with self.assertRaisesRegex(ValueError, "unsupported projection version"):
                    index._fts.reset_projection(PROJECTION_VERSION)
                self.assertEqual(tuple(index._fts._con.iterdump()), before)
            finally:
                index.close()

    def test_failed_projection_initialization_closes_real_connection(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "index.sqlite3"
            with closing(sqlite3.connect(path)) as writer, writer:
                writer.execute(
                    "CREATE TABLE projection_versions (name TEXT PRIMARY KEY, version TEXT)"
                )
                writer.execute(
                    "INSERT INTO projection_versions VALUES ('trace_events', 'future-v999')"
                )
            connect = sqlite3.connect
            connections = []

            def capture(*args, **kwargs):
                connection = connect(*args, **kwargs)
                connections.append(connection)
                return connection

            opened = None
            try:
                with patch("damoatrace.search.sqlite.sqlite3.connect", side_effect=capture):
                    opened = TraceIndex.try_open(path)
                self.assertIsNone(opened)
                self.assertTrue(connections)
                for connection in connections:
                    with self.assertRaises(sqlite3.ProgrammingError):
                        connection.execute("SELECT 1")
            finally:
                if opened is not None:
                    opened.close()
                for connection in connections:
                    connection.close()

    def test_unicode_limit_and_structured_redaction(self) -> None:
        block = content_block(
            ContentCategory.TOOL_OUTPUT,
            "科学" * BLOCK_LIMIT,
            source="runtime_observation",
            revision=1,
            redactor=Redactor(),
            budget=101,
        )
        self.assertTrue(block["truncated"])
        self.assertLessEqual(block["captured_bytes"], 101)
        self.assertEqual(len(block["data"].encode()), block["captured_bytes"])
        self.assertEqual(block["byte_end"], block["captured_bytes"])
        value = '{"headers":{"Authorization":"Bearer fixture-secret"},"result":"ok"}'
        self.assertNotIn("fixture-secret", Redactor().text(value))
        self.assertIn("ok", Redactor().text(value))

    def test_expiry_hidden_then_removed_and_writer_reopens(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "evidence" / "session.jsonl"
            writer = EvidenceWriter(path)
            block = content_block(
                ContentCategory.ANSWER,
                "retained-private-body",
                source="runtime_observation",
                revision=1,
                redactor=Redactor(),
            )
            block["expires_at"] = time.time() - 1
            writer.emit(
                session_id="session",
                kind="tool.exec",
                name="test",
                task_run_id="turn",
                component_id="test",
                attributes={},
                outputs={"version": CONTENT_VERSION, "blocks": [block]},
            )
            before = path.read_bytes()
            store = TraceStore(path.parent, trace_file=path, offline=True, include_content=True)
            self.assertFalse(any(has_content(row) for row in store.all_events()))
            self.assertEqual(before, path.read_bytes(), "queries must not mutate offline evidence")
            self.assertGreater(purge_content(path), 0)
            self.assertNotIn(b"retained-private-body", path.read_bytes())
            writer.emit(
                session_id="session",
                kind="turn.end",
                name="new",
                task_run_id="turn",
                component_id="test",
                attributes={},
            )
            writer.close()
            self.assertEqual(len(store.all_events()), 2)
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)

    def test_explicit_legacy_record_remains_readable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "old.jsonl"
            path.write_text(
                json.dumps({"session_id": "old", "inputs": None, "outputs": None}) + "\n"
            )
            self.assertEqual(
                len(TraceStore(path.parent, trace_file=path, offline=True).all_events()), 1
            )


if __name__ == "__main__":
    unittest.main()
