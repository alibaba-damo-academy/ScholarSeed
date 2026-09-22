"""Detailed recording contracts over real catalog, event store, and JSONL files."""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from damoatrace.data.store import TraceStore
from damoatrace.recording.content import CONTENT_FIELDS, RETENTION_SECONDS, has_content
from damoatrace.recording.diagnostics import bundle_manifest, diagnostic_bundle
from damoatrace.recording.redaction import Redactor
from damoatrace.recording.storage import purge_content
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.service.diagnostics import DiagnosticService
from service.chat.service.recording import (
    POLICY_EVENT,
    PolicyConflict,
    RecordingMode,
    RecordingService,
)

SESSION = "detailed-contract"
OWNER = SessionPrincipal("owner")
BODY = "研究正文内容-ordinary-private-content"
SECRET = "test-sensitive-credential-value"


class DetailedDiagnosticsContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="detailed-contract-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.catalog = SessionCatalogStore(self.root / "catalog.sqlite3")
        self.catalog.register(
            SESSION,
            OWNER,
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="test",
            model_id="test",
            policy_id="default",
            status=SessionStatus.READY,
            title="test",
            created_at=1,
        )
        self.events = ProductEventStore(self.catalog.database)
        self.policies = RecordingService(self.catalog, self.events)
        self.trace = SessionTrace(
            SESSION,
            self.root,
            runtime_id="codex",
            trace_dir=self.root / "trace",
            recording=self.policies,
            secrets=(SECRET,),
        )
        self.addCleanup(self.trace.close)

    def enable(self) -> None:
        current = self.policies.current(SESSION)
        self.policies.update(
            SESSION, OWNER, mode=RecordingMode.DETAILED, expected_revision=current.revision
        )

    def input(self, *, steer: bool = False) -> None:
        self.trace.turn_input(
            TurnInput((InputItem(InputKind.TEXT, text=BODY),), client_user_message_id="submission"),
            vendor_thread_id="thread",
            skill_versions={},
            user_text=BODY,
            product_context="product supplied context",
            steer=steer,
        )

    def event(self, kind: RuntimeEventKind, payload: dict, *, item: str = "item") -> None:
        self.trace.runtime_event(
            RuntimeEvent(
                schema_version=1,
                event_id=f"{kind.value}-{item}",
                runtime_id="codex",
                product_session_id=SESSION,
                native_session_id="thread",
                native_turn_id="turn",
                native_item_id=item,
                process_generation=1,
                sequence=1,
                kind=kind,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-09-09T00:00:00Z",
                payload=payload,
            )
        )

    def rows(self, content: bool = True) -> list[dict]:
        return TraceStore(
            self.trace.path.parent,
            trace_file=self.trace.path,
            offline=True,
            include_content=content,
        ).all_events()

    def test_default_captures_first_turn_but_not_unfrozen_events(self) -> None:
        self.event(RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "unfrozen"})
        self.assertFalse(any(has_content(row) for row in self.rows()))
        self.assertTrue(self.policies.current(SESSION).active)
        self.input()
        self.event(
            RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": BODY}, item="first"
        )
        self.assertTrue(any(has_content(row) for row in self.rows()))
        self.assertNotIn(BODY, json.dumps(self.rows(False), ensure_ascii=False))

    def test_disabled_and_frozen_steer_do_not_capture(self) -> None:
        self.policies.update(SESSION, OWNER, mode=RecordingMode.METADATA, expected_revision=0)
        self.input()
        self.enable()
        self.input(steer=True)
        self.event(RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": BODY})
        self.assertFalse(any(has_content(row) for row in self.rows()))

        self.input()
        self.assertTrue(any(has_content(row) for row in self.rows()))
        self.assertNotIn(BODY, json.dumps(self.rows(False), ensure_ascii=False))

    def test_redaction_structured_strings_and_known_values(self) -> None:
        values = [
            json.dumps({"api_key": SECRET}),
            f'password="two words secret"',
            f"bearer {SECRET}",
            SECRET,
        ]
        filtered = Redactor((SECRET,)).value(values)
        self.assertNotIn(SECRET, str(filtered))
        self.assertNotIn("words secret", str(filtered))
        self.enable()
        self.input()
        self.event(
            RuntimeEventKind.TOOL_COMPLETED,
            {"output": json.dumps({"api_key": SECRET, "result": BODY}), "ok": False},
        )
        self.assertNotIn(SECRET, self.trace.path.read_text())
        self.assertIn(BODY, json.dumps(self.rows(), ensure_ascii=False))

    def test_revoke_and_reenable_cannot_upgrade_current_turn(self) -> None:
        self.enable()
        self.input()
        self.event(RuntimeEventKind.CONTENT_DELTA, {"role": "assistant", "text": "pending-private"})
        policy = self.policies.current(SESSION)
        self.policies.update(
            SESSION, OWNER, mode=RecordingMode.METADATA, expected_revision=policy.revision
        )
        self.enable()
        self.event(
            RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "after-revoke"}
        )
        self.event(RuntimeEventKind.TURN_INTERRUPTED, {})
        raw = self.trace.path.read_text()
        self.assertNotIn("pending-private", raw)
        self.assertNotIn("after-revoke", raw)

    def test_completion_dedup_and_interruption(self) -> None:
        self.enable()
        self.input()
        self.event(RuntimeEventKind.CONTENT_DELTA, {"role": "assistant", "text": "partial-answer"})
        self.event(RuntimeEventKind.TURN_INTERRUPTED, {})
        blocks = [
            block
            for row in self.rows()
            for field in CONTENT_FIELDS
            for block in (row.get(field) or {}).get("blocks", [])
        ]
        partial = next(block for block in blocks if block.get("data") == "partial-answer")
        self.assertEqual(partial["missing_reason"], "interrupted")
        self.input()
        self.event(
            RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "final-answer"}
        )
        self.event(
            RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "final-answer"}
        )
        self.assertEqual(self.trace.path.read_text().count('"data": "final-answer"'), 1)

    def test_cross_chunk_secret_is_filtered_after_reassembly(self) -> None:
        self.enable()
        self.input()
        midpoint = len(SECRET) // 2
        self.event(RuntimeEventKind.CONTENT_DELTA, {"role": "assistant", "text": SECRET[:midpoint]})
        self.event(RuntimeEventKind.CONTENT_DELTA, {"role": "assistant", "text": SECRET[midpoint:]})
        self.event(RuntimeEventKind.TURN_INTERRUPTED, {})
        self.assertNotIn(SECRET, self.trace.path.read_text())
        self.assertIn("[REDACTED]", self.trace.path.read_text())

    def test_policy_owner_revision_and_restart(self) -> None:
        self.enable()
        with self.assertRaises(PolicyConflict):
            self.policies.update(SESSION, OWNER, mode=RecordingMode.METADATA, expected_revision=0)
        with self.assertRaises(SessionAccessError):
            self.policies.require(SESSION, SessionPrincipal("other"))
        restored = RecordingService(self.catalog, ProductEventStore(self.catalog.database))
        self.assertTrue(restored.current(SESSION).active)

    def test_capture_database_failure_does_not_escape(self) -> None:
        with patch.object(
            self.policies, "current", side_effect=sqlite3.OperationalError("fixture")
        ):
            self.input()
            self.event(RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": BODY})

    def test_recording_does_not_expire_but_export_confirmation_does(self) -> None:
        self.enable()
        self.input()
        before = self.rows()
        with patch(
            "service.chat.service.recording.time.time", return_value=time.time() + 2 * 24 * 60 * 60
        ):
            self.assertTrue(self.policies.current(SESSION).active)
            self.event(
                RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "after-expiry"}
            )
        self.assertIn("after-expiry", json.dumps(self.rows()))
        self.assertGreater(len(self.rows()), len(before), "metadata remains available")
        diagnostics = DiagnosticService(self.policies)
        with patch(
            "service.chat.service.diagnostics.session_trace_paths", return_value=(self.trace.path,)
        ):
            with self.assertRaises(SessionAccessError):
                diagnostics.preview(SESSION, SessionPrincipal("other"))
            preview = diagnostics.preview(SESSION, OWNER)
            with patch(
                "service.chat.service.diagnostics.time.time",
                return_value=preview["confirmation"]["expires_at"] + 1,
            ):
                with self.assertRaises(ValueError):
                    diagnostics.export(
                        SESSION,
                        OWNER,
                        confirmation=preview["confirmation"],
                        token=preview["token"],
                        accepted=True,
                    )

    def test_default_session_expiry_maintenance_without_policy_event(self) -> None:
        self.input()
        self.assertIsNone(self.events.latest_kind(SESSION, POLICY_EVENT))
        diagnostics = DiagnosticService(self.policies)
        with patch(
            "service.chat.service.diagnostics.session_trace_paths", return_value=(self.trace.path,)
        ):
            with patch("time.time", return_value=time.time() + RETENTION_SECONDS + 1):
                diagnostics.expire(set())
        self.assertFalse(any(has_content(row) for row in self.rows()))
        self.assertTrue(self.rows())

    def test_old_deadline_does_not_override_explicit_mode(self) -> None:
        self.events.append(
            session_id=SESSION,
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=POLICY_EVENT,
            payload={
                "mode": RecordingMode.DETAILED.value,
                "revision": 1,
                "consented_at": 1,
                "expires_at": 2,
            },
            idempotency_key="old-policy",
        )
        self.assertTrue(self.policies.current(SESSION).active)
        self.policies.update(SESSION, OWNER, mode=RecordingMode.METADATA, expected_revision=1)
        restored = RecordingService(self.catalog, ProductEventStore(self.catalog.database))
        self.assertFalse(restored.current(SESSION).active)

    def test_export_confirmation_and_clear(self) -> None:
        self.enable()
        self.input()
        diagnostics = DiagnosticService(self.policies)
        with patch(
            "service.chat.service.diagnostics.session_trace_paths", return_value=(self.trace.path,)
        ):
            preview = diagnostics.preview(SESSION, OWNER)
            bundle = diagnostics.export(
                SESSION,
                OWNER,
                confirmation=preview["confirmation"],
                token=preview["token"],
                accepted=True,
            )
            self.assertEqual(bundle_manifest(bundle)["export_mode"], "detailed")
            self.event(RuntimeEventKind.TOOL_COMPLETED, {"output": "new output"})
            with self.assertRaises(ValueError):
                diagnostics.export(
                    SESSION,
                    OWNER,
                    confirmation=preview["confirmation"],
                    token=preview["token"],
                    accepted=True,
                )
            diagnostics.clear(SESSION, OWNER)
            cleared = diagnostics.preview(SESSION, OWNER)["manifest"]
            self.assertFalse(cleared["content_available"])
            self.assertGreater(cleared["missing_blocks"], 0)
            self.assertTrue(cleared["submissions"])
            self.event(
                RuntimeEventKind.CONTENT_COMPLETED, {"role": "assistant", "text": "must not return"}
            )
        self.assertFalse(any(has_content(row) for row in self.rows()))
        self.assertNotIn(BODY, self.trace.path.read_text())

    def test_upstream_truncation_is_not_claimed_complete(self) -> None:
        self.enable()
        self.input()
        self.event(
            RuntimeEventKind.TOOL_COMPLETED,
            {
                "output": "partial",
                "content_observations": [
                    {
                        "field": "output",
                        "source": "runtime_observation",
                        "truncated": True,
                        "original_bytes": None,
                        "missing_reason": "upstream_truncated",
                    }
                ],
            },
        )
        blocks = [
            block for row in self.rows() for block in (row.get("outputs") or {}).get("blocks", [])
        ]
        self.assertTrue(blocks[-1]["truncated"])
        self.assertIsNone(blocks[-1]["original_bytes"])
        self.assertEqual(blocks[-1]["missing_reason"], "upstream_truncated")

    def test_disconnect_flushes_authorized_partial_answer(self) -> None:
        self.enable()
        self.input()
        self.event(RuntimeEventKind.CONTENT_DELTA, {"role": "assistant", "text": "partial-answer"})
        self.trace.turn_execution_failed(failure_type="disconnect", retryability="retry")
        blocks = [
            block for row in self.rows() for block in (row.get("outputs") or {}).get("blocks", [])
        ]
        self.assertEqual(blocks[-1]["data"], "partial-answer")
        self.assertTrue(blocks[-1]["truncated"])
        self.assertEqual(blocks[-1]["missing_reason"], "interrupted")

    def test_cli_default_full_does_not_authorize_content(self) -> None:
        self.enable()
        self.input()
        command = [
            sys.executable,
            "-m",
            "damoatrace",
            "--trace-file",
            str(self.trace.path),
            "events",
            "--full",
        ]
        default = subprocess.run(command, capture_output=True, text=True, check=True)
        self.assertNotIn(BODY, default.stdout)
        detailed = subprocess.run(
            [*command, "--include-content"], capture_output=True, text=True, check=True
        )
        self.assertIn(BODY, detailed.stdout)

    def test_purge_reopens_writer_and_keeps_metadata(self) -> None:
        self.enable()
        self.input()
        self.assertGreater(purge_content(self.trace.path, all_content=True), 0)
        self.event(RuntimeEventKind.TOOL_COMPLETED, {"output": "new evidence"})
        self.assertIn("new evidence", self.trace.path.read_text())
        self.assertNotIn(BODY, self.trace.path.read_text())
        bundle = diagnostic_bundle((self.trace.path,), session_id=SESSION, versions={})
        self.assertEqual(bundle_manifest(bundle)["export_mode"], "basic")


if __name__ == "__main__":
    unittest.main()
