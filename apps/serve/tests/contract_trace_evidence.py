"""Deterministic product evidence projection and portable CLI regression checks."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from damoatrace.data.store import TraceStore
from damoatrace.recording.diagnostics import diagnostic_bundle
from damoatrace.recording.records import effective_status, is_failed
from damoatrace.recording.writer import EvidenceWriter
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
from service.chat.persistence.events import ProductEventRecord
from service.chat.runtime.evidence import SessionTrace

SESSION = "evidence-contract"
RUNTIME = "codex"
REQUEST = "permission-request"
OPTION = "acceptForSession"
PRIVATE_CONTENT = "private-prompt-command-file-body"
OUTCOMES = (
    (PRODUCT_EVENT_TURN_COMPLETED, "ok", False),
    (PRODUCT_EVENT_TURN_FAILED, "error", True),
    (PRODUCT_EVENT_TURN_INTERRUPTED, "cancelled", False),
    (PRODUCT_EVENT_TURN_UNKNOWN, "unknown", True),
)


class TraceEvidenceContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="trace-evidence-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.trace = SessionTrace(SESSION, self.root, runtime_id=RUNTIME, trace_dir=self.root)
        self.addCleanup(self.trace.close)

    def product(self, kind: str, turn: str, payload: dict | None = None) -> None:
        self.trace.product_event(
            ProductEventRecord(
                event_id=1,
                session_id=SESSION,
                runtime_id=RUNTIME,
                vendor_thread_id=SESSION,
                vendor_turn_id=turn,
                vendor_item_id=None,
                kind=kind,
                payload=payload or {},
                schema_version=2,
                product_seq=1,
                idempotency_key=turn,
                created_at=1.0,
            )
        )

    def runtime(self, kind: RuntimeEventKind, turn: str, payload: dict) -> None:
        self.trace.runtime_event(
            RuntimeEvent(
                schema_version=1,
                event_id=turn,
                runtime_id=RUNTIME,
                product_session_id=SESSION,
                native_session_id=SESSION,
                native_turn_id=turn,
                process_generation=1,
                sequence=1,
                kind=kind,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-09-08T00:00:00Z",
                payload=payload,
            )
        )

    def events(self) -> list[dict]:
        self.trace.close()
        return TraceStore(self.root, trace_file=self.trace.path, offline=True).all_events()

    def test_checkpoint_flushes_real_trace_before_release(self) -> None:
        self.trace.resource("granted", reservation_id="reservation")
        self.trace.checkpoint(3, 11)
        rows = TraceStore(self.root, trace_file=self.trace.path, offline=True).all_events()
        checkpoints = [row for row in rows if row["name"].endswith("resource.checkpoint")]
        self.assertEqual(len(checkpoints), 1)
        self.assertEqual(checkpoints[0]["attributes"]["watermark"], 11)

    def test_write_failure_is_not_erased_by_a_later_success(self) -> None:
        with patch.object(EvidenceWriter, "emit", side_effect=OSError("disk full")):
            self.trace.resource("granted")
        self.trace.resource("later-success")
        with self.assertRaisesRegex(RuntimeError, "checkpoint"):
            self.trace.checkpoint(1, 9)

    def test_flush_failure_prevents_current_and_future_checkpoints(self) -> None:
        self.trace.resource("granted")
        with patch.object(EvidenceWriter, "checkpoint", side_effect=OSError("fsync failed")):
            with self.assertRaises(RuntimeError):
                self.trace.checkpoint(1, 9)
        with self.assertRaises(RuntimeError):
            self.trace.checkpoint(1, 10)

    def test_authoritative_product_outcomes_preserve_status(self) -> None:
        for kind, _, _ in OUTCOMES:
            self.product(kind, kind)
        rows = self.events()
        self.assertEqual(len(rows), len(OUTCOMES))
        for row, (kind, status, failed) in zip(rows, OUTCOMES):
            with self.subTest(kind=kind):
                self.assertEqual(row["kind"], "run.outcome")
                self.assertEqual(row["attributes"]["outcome"], kind)
                self.assertEqual(row["attributes"]["status"], status)
                self.assertEqual(effective_status(row), status)
                self.assertEqual(is_failed(row), failed)

    def test_hil_runtime_identifiers_survive_redacted_export(self) -> None:
        self.product(PRODUCT_EVENT_HIL_REQUESTED, "hil-turn", {"request_id": REQUEST})
        self.runtime(
            RuntimeEventKind.INTERACTION_RESOLVED,
            "hil-turn",
            {
                "request_id": REQUEST,
                "option_id": OPTION,
                "cancelled": False,
                "command": PRIVATE_CONTENT,
            },
        )
        original = self.events()
        bundle = diagnostic_bundle([self.trace.path], session_id=SESSION, versions={})
        with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
            raw = archive.read("trace.jsonl")
        self.assertNotIn(PRIVATE_CONTENT.encode(), raw)
        exported = [json.loads(line) for line in raw.splitlines()]
        for rows in (original, exported):
            request = next(row for row in rows if row["kind"] == "hil.request")
            response = next(row for row in rows if row["kind"] == "hil.response")
            self.assertEqual(request["attributes"]["interaction_id"], REQUEST)
            self.assertEqual(response["attributes"]["interaction_id"], REQUEST)
            self.assertEqual(response["attributes"]["decision"], OPTION)
            self.assertIs(response["attributes"]["cancelled"], False)

    def test_cli_summary_requires_outcome_and_preserves_cancellation(self) -> None:
        self.runtime(RuntimeEventKind.TURN_STARTED, "pending", {})
        for kind, _, _ in OUTCOMES:
            self.product(kind, kind)
        self.trace.close()
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "damoatrace",
                "--trace-file",
                str(self.trace.path),
                "summary",
                "--session",
                SESSION,
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        envelope = json.loads(result.stdout)
        rows = {row["task_run_id"].rsplit(":", 1)[-1]: row for row in envelope["rows"]}
        self.assertEqual(rows["pending"]["status"], "unknown")
        self.assertIsNone(rows["pending"]["outcome_evidence"])
        for kind, status, _ in OUTCOMES:
            self.assertEqual(rows[kind]["status"], status)
            self.assertTrue(rows[kind]["outcome_evidence"]["span_id"])

    def test_skill_progress_is_not_failure_but_failed_completion_is(self) -> None:
        skill = "contract-skill"
        observations = (
            ("skill_started", False, "running", False),
            ("skill_completed", True, "completed", False),
            ("skill_completed", False, "completed", True),
        )
        for extension, ok, status, _ in observations:
            self.runtime(
                RuntimeEventKind.RUNTIME_EXTENSION,
                "skill-turn",
                {"extension_kind": extension, "skill": skill, "ok": ok, "status": status},
            )
        rows = self.events()
        self.assertEqual(len(rows), len(observations))
        for row, (_, _, _, failed) in zip(rows, observations):
            self.assertEqual(row["kind"], "tool.exec")
            self.assertEqual(row["attributes"]["tool_name"], skill)
            self.assertEqual(is_failed(row), failed)
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "damoatrace",
                "--trace-file",
                str(self.trace.path),
                "errors",
                "--session",
                SESSION,
            ],
            check=True,
            text=True,
            capture_output=True,
        )
        errors = json.loads(result.stdout)["rows"]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["span_id"], rows[-1]["span_id"])


if __name__ == "__main__":
    unittest.main()
