"""Deterministic product evidence projection and portable CLI regression checks."""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime
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
from service.chat.runtime.timing import ActivationStage, ActivationTiming

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

    def runtime(
        self,
        kind: RuntimeEventKind,
        turn: str,
        payload: dict,
        *,
        correlation_id: str = "",
    ) -> None:
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
                correlation_id=correlation_id,
                payload=payload,
            )
        )

    def events(self) -> list[dict]:
        self.trace.close()
        return TraceStore(
            self.trace.path.parent, trace_file=self.trace.path, offline=True
        ).all_events()

    def test_activation_timing_has_real_intervals_hierarchy_and_cli_evidence(self) -> None:
        self.trace.close()
        self.trace = SessionTrace(
            SESSION, self.root, runtime_id=RUNTIME, trace_dir=self.root / "logs" / "trace"
        )
        self.addCleanup(self.trace.close)
        timing = self.trace.activation("client-request")
        with patch(
            "service.chat.runtime.timing.perf_counter", side_effect=[10.0, 10.1, 10.4, 10.5]
        ):
            with timing.measure(ActivationStage.TOTAL):
                with timing.measure(ActivationStage.SKILLS):
                    pass
        rows = self.events()
        root = next(row for row in rows if row["name"] == ActivationStage.TOTAL)
        child = next(row for row in rows if row["name"] == ActivationStage.SKILLS)
        self.assertEqual(root["duration_ms"], 500)
        self.assertAlmostEqual(child["duration_ms"], 300)
        self.assertEqual(child["parent_span_id"], root["span_id"])
        self.assertEqual(root["attributes"]["request_id"], "client-request")
        elapsed = datetime.fromisoformat(root["ended_at"]) - datetime.fromisoformat(
            root["started_at"]
        )
        self.assertEqual(elapsed.total_seconds(), 0.5)
        for command in (
            ["events", "--kind", "runtime.activation", "--session", SESSION],
            ["span", child["span_id"]],
            ["slow", "--session", SESSION],
        ):
            result = subprocess.run(
                [sys.executable, "-m", "damoatrace", *command, "--full"],
                env={**os.environ, "DAMOATRACE_HOME": str(self.root)},
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            envelope = json.loads(result.stdout)
            self.assertFalse(envelope["truncated"])
            visible = envelope.get("top_spans", envelope["rows"])
            self.assertTrue(any(row["span_id"] == child["span_id"] for row in visible))

    def test_activation_recording_failure_does_not_replace_business_failure(self) -> None:
        timing = self.trace.activation("failure-request")
        failure = ValueError(PRIVATE_CONTENT)
        with patch.object(EvidenceWriter, "emit", side_effect=OSError("full")):
            with self.assertRaises(ValueError) as caught:
                with timing.measure(ActivationStage.SKILLS):
                    raise failure
        self.assertIs(caught.exception, failure)

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

    def test_runtime_extension_keeps_safe_kind_and_method_only(self) -> None:
        self.runtime(
            RuntimeEventKind.RUNTIME_EXTENSION,
            "extension-turn",
            {
                "extension_kind": "runtime_warning",
                "rpc_method": "item/started",
                "private": PRIVATE_CONTENT,
            },
        )
        row = self.events()[0]
        self.assertEqual(row["attributes"]["extension_kind"], "runtime_warning")
        self.assertEqual(row["attributes"]["rpc_method"], "item/started")
        self.assertNotIn(PRIVATE_CONTENT, json.dumps(row))

    def test_model_request_preparation_measures_first_bridge_ingress(self) -> None:
        client_turn_id = "client-turn"
        with patch("service.chat.runtime.evidence.perf_counter", side_effect=[10.0, 11.45, 12.0]):
            self.runtime(
                RuntimeEventKind.TURN_STARTED,
                "vendor-turn",
                {},
                correlation_id=client_turn_id,
            )
            fields = {
                "phase": "started",
                "client_user_message_id": client_turn_id,
                "request_id": "model-request",
            }
            self.trace.completion(fields)
            self.trace.completion(fields)
        rows = self.events()
        preparation = [
            row for row in rows if row["name"] == "runtime.turn.model_request_preparation"
        ]
        self.assertEqual(len(preparation), 1)
        self.assertAlmostEqual(preparation[0]["duration_ms"], 1450)
        self.assertEqual(
            preparation[0]["attributes"]["stage"], "turn.started_to_model_bridge_ingress"
        )
        self.assertEqual(preparation[0]["attributes"]["vendor_turn_id"], "vendor-turn")
        self.assertEqual(preparation[0]["attributes"]["evidence_completeness"], "complete")
        self.assertEqual(preparation[0]["attributes"]["evidence_gaps"], [])


class ActivationTimingConcurrency(unittest.IsolatedAsyncioTestCase):
    async def test_deferred_start_in_another_task_uses_request_root(self) -> None:
        samples = []
        timing = ActivationTiming("queued-request", samples.append)
        other = ActivationTiming("releasing-request", lambda sample: None)
        grant = asyncio.Event()

        async def deferred_start() -> None:
            await grant.wait()
            with other.measure("release"):
                with timing.measure("process_start"):
                    pass

        starter = asyncio.create_task(deferred_start())
        with timing.measure("activation"):
            with timing.measure("admission"):
                grant.set()
                await starter
        root = next(sample for sample in samples if sample.stage == "activation")
        startup = next(sample for sample in samples if sample.stage == "process_start")
        self.assertEqual(startup.parent_span_id, root.span_id)
        self.assertEqual(startup.activation_id, root.activation_id)

    async def test_concurrent_scopes_do_not_share_parent_or_session(self) -> None:
        samples = []
        timing = ActivationTiming("request", samples.append)
        other_samples = []
        other = ActivationTiming("other-request", other_samples.append)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def first() -> None:
            with timing.measure("first"):
                entered.set()
                await release.wait()

        async def second() -> None:
            await entered.wait()
            with timing.measure("second"):
                with other.measure("separate-session"):
                    release.set()

        with timing.measure("root"):
            await asyncio.gather(first(), second())
        root = next(sample for sample in samples if sample.stage == "root")
        self.assertTrue(
            all(sample.parent_span_id == root.span_id for sample in samples if sample is not root)
        )
        self.assertIsNone(other_samples[0].parent_span_id)
        self.assertNotEqual(root.activation_id, other_samples[0].activation_id)
        self.assertEqual(other_samples[0].request_id, "other-request")


if __name__ == "__main__":
    unittest.main()
