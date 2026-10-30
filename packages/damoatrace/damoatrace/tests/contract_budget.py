"""Real-file budget/concurrency/snapshot contracts, not product acceptance."""

from __future__ import annotations

import copy
import io
import json
import multiprocessing
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from damoatrace.cli.main import main as cli
from damoatrace.data.store import TraceStore
from damoatrace.recording.budget import ContentBudget
from damoatrace.recording.content import (
    BLOCK_LIMIT,
    CONTENT_FIELDS,
    CONTENT_MARKER,
    CONTENT_VERSION,
    DISK_LIMIT,
    RETENTION_SECONDS,
    SESSION_LIMIT,
    TURN_LIMIT,
    ContentCategory,
    content_block,
    has_content,
)
from damoatrace.recording.diagnostics import diagnostic_bundle, verify_diagnostic_directory
from damoatrace.recording.redaction import Redactor
from damoatrace.recording.storage import purge_content
from damoatrace.recording.writer import EvidenceWriter

LIMIT = 200
VALUE = "body-" * 15


def emit(writer: EvidenceWriter, value: str = VALUE, *, captured_at: float | None = None) -> None:
    block = content_block(
        ContentCategory.ANSWER, value, source="test", revision=0, redactor=Redactor()
    )
    if captured_at is not None:
        block["captured_at"] = captured_at
    writer.emit(
        session_id="session",
        kind="tool.exec",
        name="result",
        task_run_id="turn",
        component_id="test",
        attributes={},
        outputs={"version": CONTENT_VERSION, "blocks": [block]},
    )


def concurrent_writer(directory: str, name: str) -> None:
    root = Path(directory)
    writer = EvidenceWriter(root / name, budget=ContentBudget(root, pattern="*.jsonl", limit=LIMIT))
    for _ in range(5):
        emit(writer)
    writer.close()


class BudgetContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def rows(self, root: Path | None = None, **kwargs) -> list[dict]:
        return TraceStore(
            root or self.root, offline=True, include_content=True, **kwargs
        ).all_events()

    def test_unknown_content_version_refuses_purge_and_budget_without_changes(self) -> None:
        for field in (CONTENT_MARKER, "outputs"):
            for version in (999, True, 1.0, "1", None):
                for action in ("purge", "enforce", "append"):
                    with self.subTest(field=field, version=version, action=action):
                        with tempfile.TemporaryDirectory() as temporary:
                            root = Path(temporary)
                            path = root / "one.jsonl"
                            with EvidenceWriter(path) as writer:
                                emit(writer)
                            current = json.loads(path.read_text())
                            future = copy.deepcopy(current)
                            if field == CONTENT_MARKER:
                                future[field] = version
                            else:
                                future[field]["version"] = version
                            path.write_text(json.dumps(current) + "\n" + json.dumps(future) + "\n")
                            before = path.read_bytes(), path.stat().st_ino
                            budget = ContentBudget(root, pattern="*.jsonl", limit=0)
                            with self.assertRaisesRegex(
                                ValueError, "unsupported diagnostic content"
                            ):
                                if action == "purge":
                                    purge_content(path, all_content=True)
                                elif action == "enforce":
                                    budget.enforce()
                                else:
                                    budget.append(path, current)
                            self.assertEqual((path.read_bytes(), path.stat().st_ino), before)
                            self.assertEqual(list(root.glob(".one.jsonl.*")), [])

    def test_incoming_batch_version_rejected_before_first_append(self) -> None:
        path = self.root / "one.jsonl"
        with EvidenceWriter(path) as writer:
            emit(writer)
        current = json.loads(path.read_text())
        future = copy.deepcopy(current)
        future[CONTENT_MARKER] = 999
        before = path.read_bytes()
        budget = ContentBudget(self.root, pattern="*.jsonl", limit=0)
        with self.assertRaisesRegex(ValueError, "unsupported diagnostic content"):
            budget.append_many(path, [current, future])
        self.assertEqual(path.read_bytes(), before)

    def test_limits(self) -> None:
        self.assertEqual(
            (BLOCK_LIMIT, TURN_LIMIT, SESSION_LIMIT, DISK_LIMIT),
            (512 * 1024, 4 * 1024**2, 64 * 1024**2, 1024**3),
        )
        self.assertEqual(RETENTION_SECONDS, 14 * 24 * 60 * 60)

    def test_batch_preserves_sequential_budget_policy(self) -> None:
        results = []
        for batched in (False, True):
            root = self.root / str(batched)
            writer = EvidenceWriter(
                root / "one.jsonl", budget=ContentBudget(root, pattern="*.jsonl", limit=LIMIT)
            )
            if batched:
                with writer.batch():
                    for value in (VALUE, VALUE, "oversize" * LIMIT, VALUE):
                        emit(writer, value, captured_at=time.time())
            else:
                for value in (VALUE, VALUE, "oversize" * LIMIT, VALUE):
                    emit(writer, value, captured_at=time.time())
            rows = self.rows(root)
            results.append(
                [
                    (block.get("data"), block.get("missing_reason"))
                    for row in rows
                    for block in row["outputs"]["blocks"]
                ]
            )
        self.assertEqual(results[0], results[1])

    def test_batch_refreshes_and_writes_once(self) -> None:
        budget = ContentBudget(self.root, pattern="*.jsonl", limit=100_000)
        writer = EvidenceWriter(self.root / "one.jsonl", budget=budget)
        with (
            patch.object(budget, "_refresh", wraps=budget._refresh) as refresh,
            patch("damoatrace.recording.budget.make_private") as private,
        ):
            with writer.batch():
                for _ in range(64):
                    emit(writer)
            self.assertEqual(refresh.call_count, 1)
            self.assertEqual(private.call_count, 1)
        self.assertEqual(len(self.rows()), 64)

    def test_batch_failure_is_not_silently_committed(self) -> None:
        writer = EvidenceWriter(self.root / "one.jsonl")
        with (
            self.assertRaises(OSError),
            patch.object(writer, "_append_many", side_effect=OSError("full")),
        ):
            with writer.batch():
                emit(writer)
        emit(writer)
        self.assertEqual(len(self.rows()), 1)

    def test_oldest_block_not_file_and_warm_cache(self) -> None:
        budget = ContentBudget(self.root, pattern="*.jsonl", limit=LIMIT)
        first = EvidenceWriter(self.root / "first.jsonl", budget=budget)
        second = EvidenceWriter(self.root / "second.jsonl", budget=budget)
        emit(first, "old-" * 20, captured_at=1)
        emit(second, "middle-" * 10, captured_at=2)
        with patch.object(budget, "_scan", wraps=budget._scan) as scan:
            emit(first, "new-" * 20, captured_at=3)
            # Only the evicted file needs a rebuild, not the unrelated file.
            self.assertEqual([call.args[0].name for call in scan.call_args_list], ["first.jsonl"])
        rows = self.rows()
        self.assertEqual(len(rows), 3)
        blocks = [block for row in rows for block in (row.get("outputs") or {}).get("blocks", [])]
        self.assertEqual(
            next(b for b in blocks if b["captured_at"] == 1)["missing_reason"], "budget_evicted"
        )
        self.assertEqual(sum("data" in block for block in blocks), 2)
        self.assertLessEqual(budget.enforce(), LIMIT)

    def test_cache_refresh_after_clear_and_other_coordinator(self) -> None:
        path = self.root / "one.jsonl"
        one = ContentBudget(self.root, pattern="*.jsonl", limit=LIMIT)
        writer = EvidenceWriter(path, budget=one)
        emit(writer)
        purge_content(path, all_content=True)
        other = EvidenceWriter(
            path, budget=ContentBudget(self.root, pattern="*.jsonl", limit=LIMIT)
        )
        emit(other)
        emit(writer)
        self.assertLessEqual(one.enforce(), LIMIT)
        self.assertEqual(len(self.rows()), 3)
        self.assertEqual(sum(has_content(row) for row in self.rows()), 2)

    def test_concurrent_processes_preserve_hard_limit_and_metadata(self) -> None:
        context = multiprocessing.get_context("spawn")
        processes = [
            context.Process(target=concurrent_writer, args=(str(self.root), f"{n}.jsonl"))
            for n in range(2)
        ]
        for process in processes:
            process.start()
        for process in processes:
            process.join(20)
            self.assertEqual(process.exitcode, 0)
        rows = self.rows()
        self.assertEqual(len(rows), 10)
        body_bytes = sum(
            len(json.dumps(block["data"], ensure_ascii=False).encode())
            for row in rows
            for field in CONTENT_FIELDS
            for block in (row.get(field) or {}).get("blocks", [])
            if "data" in block
        )
        self.assertLessEqual(body_bytes, LIMIT)
        self.assertIn("budget_evicted", json.dumps(rows))

    def test_snapshot_survives_source_expiry_and_gap_only_export(self) -> None:
        path = self.root / "one.jsonl"
        writer = EvidenceWriter(path, budget=ContentBudget(self.root, pattern="*.jsonl"))
        emit(writer)
        bundle = diagnostic_bundle((path,), session_id="session", versions={}, detailed=True)
        target = self.root / "export"
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            archive.extractall(target)
        snapshot_at = verify_diagnostic_directory(target)
        with patch("time.time", return_value=time.time() + RETENTION_SECONDS + 1):
            self.assertFalse(any(has_content(row) for row in self.rows()))
            self.assertTrue(
                any(has_content(row) for row in self.rows(target, snapshot_at=snapshot_at))
            )
            self.assertEqual(
                cli(["--trace-dir", str(target), "events", "--full", "--include-content"]), 0
            )
            purge_content(path)
        gap_bundle = diagnostic_bundle((path,), session_id="session", versions={}, detailed=True)
        with zipfile.ZipFile(io.BytesIO(gap_bundle)) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        self.assertFalse(manifest["content_available"])
        self.assertIn("expired", manifest["missing_reasons"])
        self.assertEqual(manifest["missing_blocks"], 1)

    def test_oversized_incoming_body_is_marked_without_dropping_event(self) -> None:
        writer = EvidenceWriter(
            self.root / "one.jsonl", budget=ContentBudget(self.root, pattern="*.jsonl", limit=1)
        )
        emit(writer)
        self.assertEqual(len(self.rows()), 1)
        self.assertFalse(any(has_content(row) for row in self.rows()))
        self.assertIn("budget_exhausted", json.dumps(self.rows()))


if __name__ == "__main__":
    unittest.main()
