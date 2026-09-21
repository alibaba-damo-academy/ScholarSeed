"""Content retention, bounds and private-file contracts (not product acceptance)."""

from __future__ import annotations

import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from damoatrace.cli import main as cli
from damoatrace.data.store import TraceStore
from damoatrace.recording.content import (
    BLOCK_LIMIT,
    CONTENT_VERSION,
    ContentCategory,
    content_block,
    has_content,
)
from damoatrace.recording.redaction import Redactor
from damoatrace.recording.storage import purge_content
from damoatrace.recording.writer import EvidenceWriter
from damoatrace.search.fts import FtsSearch
from damoatrace.search.index import TraceIndex


class ContentContract(unittest.TestCase):
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
