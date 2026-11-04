"""Contract for typed runtime incidents and monotonic turn outcomes."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
import unittest
from contextlib import closing
from dataclasses import asdict, replace
from types import SimpleNamespace
from typing import Any, Mapping
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInventory,
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.command import EmptyThreadReplacementProof, TurnRequest
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.history import ResumeTurnSnapshot, TurnStatus
from scholarseed_runtime.contract.incident import (
    RUNTIME_TURN_NOT_SUBMITTED,
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from scholarseed_runtime.contract.permission import PERMISSION_MODE_KEY
from scholarseed_runtime.contract.provider import RuntimeOpenNotAppliedError
from scholarseed_runtime.contract.session import (
    RuntimeActivitySnapshot,
    TurnConfirmationReceipt,
    TurnConfirmationTarget,
    TurnConfirmationTicket,
)
from scholarseed_runtime.gateway.driver import RuntimeTurnNotSubmittedError, RuntimeTurnOutcome
from service.capabilities.service.skills import SkillCatalog
from service.chat.active import RUNTIME_ID
from service.chat.api.sessions import mount_session_routes
from service.chat.constants import (
    AUTOMATIC_CRASH_RETRY,
    PRODUCT_EVENT_RUNTIME_INCIDENT,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_RECONCILED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_TURN_OUTCOME_FAILED,
    PRODUCT_TURN_OUTCOME_INTERRUPTED,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
    TURN_OUTCOME_UNCONFIRMED,
)
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import (
    QueuedMessageState,
    ReplacementState,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.incidents import event_incident, incident_data
from service.chat.runtime.ledger import SessionLedger
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import readiness_payload
from service.chat.service.rejections import (
    TRANSIENT_PROVIDER_FAILURE_CODE,
    TRANSIENT_PROVIDER_FAILURE_MESSAGE,
)
from service.chat.service.sessions import SessionService
from service.chat.service.streams import CONTENT_SAFETY_BLOCKED, CONTENT_SAFETY_MESSAGE
from service.chat.service.turns import TurnResult, TurnService
from service.persistence.project import DatabaseBindingError
from service.platform.activity import Activities, MaintenanceActive

from ._directories import directory

PRODUCT_SESSION_ID = "runtime-incident-session"
VENDOR_THREAD_ID = "runtime-incident-thread"
VENDOR_TURN_ID = "runtime-incident-turn"
RAW_VENDOR_SECRET = "raw-vendor-secret-must-not-be-persisted"
OWNER = SessionPrincipal("runtime-incident-owner")
SETTLEMENT_TIMEOUT_SECONDS = 2.0


class _Adapter:
    resource_evidence = None

    runtime_id = RUNTIME_ID

    def __init__(
        self,
        resume_turns: tuple[ResumeTurnSnapshot, ...] = (),
        activity_snapshot: RuntimeActivitySnapshot | None = None,
    ) -> None:
        self.session_id = VENDOR_THREAD_ID
        self.resume_turns = resume_turns
        self.binding = RuntimeBinding(
            PRODUCT_SESSION_ID,
            RUNTIME_ID,
            "test",
            "test",
            "test",
            "test",
            VENDOR_THREAD_ID,
            CapabilitySet(),
        )
        self.capabilities = self.binding.capabilities
        self.queue = asyncio.Queue()
        self.sequence = 0
        self.fail_submission = False
        self.activity_snapshot = activity_snapshot or RuntimeActivitySnapshot(
            VENDOR_THREAD_ID, 0, 0, True, execution_tree_complete=True
        )

    async def submit(self, request):
        if self.fail_submission:
            raise RuntimeError("raw adapter failure")
        self.sequence += 1
        await self.queue.put(
            RuntimeEvent(
                schema_version=1,
                event_id=f"submitted-{self.sequence}",
                runtime_id=RUNTIME_ID,
                product_session_id=PRODUCT_SESSION_ID,
                native_session_id=VENDOR_THREAD_ID,
                native_turn_id=request.command_id,
                process_generation=3,
                sequence=self.sequence,
                kind=RuntimeEventKind.TURN_COMPLETED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-09-07T00:00:00Z",
                correlation_id=request.command_id,
                payload={"status": "completed"},
            )
        )
        return CommandReceipt(request.command_id, CommandState.ACCEPTED)

    async def events(self):
        while True:
            yield await self.queue.get()

    async def history(self):
        return []

    async def inventory(self, request):
        return RuntimeInventory("test", {})

    async def snapshot(self):
        return {"resume_turns": [asdict(row) for row in self.resume_turns]}

    async def activity(self) -> RuntimeActivitySnapshot:
        return self.activity_snapshot

    async def detach(self):
        return None


class _EvidenceControl:
    runtime_id = RUNTIME_ID

    def __init__(self) -> None:
        self.process_events = (
            RuntimeProcessEvent(
                runtime_id=RUNTIME_ID,
                kind=RuntimeProcessEventKind.STARTED,
                process_generation=9,
                process_state="ready",
                evidence_seq=1,
                created_at="2026-08-23T00:00:00Z",
                pid=123,
                executable="/secret/path/codex",
                version="contract",
            ),
        )
        self.rpc_evidence = (
            RuntimeRpcEvidence(
                runtime_id=RUNTIME_ID,
                method="turn/start",
                process_generation=9,
                latency_ms=37,
                evidence_seq=2,
                created_at="2026-08-23T00:00:01Z",
            ),
        )

    async def aclose(self) -> None:
        return None


class RuntimeIncidentContract(unittest.IsolatedAsyncioTestCase):
    async def test_projection_recovery_replays_committed_event_once_without_resubmission(
        self,
    ) -> None:
        driver = self.live.runtime_driver
        adapter = self.live.runtime_session
        event = RuntimeEvent(
            schema_version=1,
            event_id="projection-retry-original",
            product_session_id=PRODUCT_SESSION_ID,
            runtime_id=RUNTIME_ID,
            native_session_id=VENDOR_THREAD_ID,
            kind=RuntimeEventKind.TOOL_STARTED,
            native_turn_id=VENDOR_TURN_ID,
            native_item_id="retained-tool",
            sequence=1,
            process_generation=3,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-09-07T00:00:00Z",
            payload={"name": "update_plan", "input": {}},
        )
        append = self.events.append

        def fail_after_commit(*args, **kwargs):
            append(*args, **kwargs)
            raise DatabaseBindingError("storage failed after durable commit")

        with patch.object(self.events, "append", side_effect=fail_after_commit):
            adapter.queue.put_nowait(event)
            with self.assertRaises(DatabaseBindingError):
                await driver._consumer
        self.assertTrue(driver.projection_failed)
        self.assertEqual(len(self.events.replay(PRODUCT_SESSION_ID)), 1)
        await self.live.recover_runtime_projection()
        self.assertFalse(driver.projection_failed)
        self.assertEqual(len(self.events.replay(PRODUCT_SESSION_ID)), 1)
        self.assertEqual(adapter.sequence, 0)
        self.assertEqual(self.live._broadcast_sequence, 1)

    async def test_recovery_block_notification_can_retry_after_publication_failure(self) -> None:
        self.live.active_product_turn_id = "notification-retry"
        await self.emit(RuntimeEventKind.TURN_UNKNOWN)
        incident = replace(
            self.incident(RuntimeIncidentState.FAILED),
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
        )
        original = self.live.publish

        async def fail_state(kind, *args, **kwargs):
            if kind == "session_state":
                raise RuntimeError("controlled publication failure")
            return await original(kind, *args, **kwargs)

        with patch.object(self.live, "publish", side_effect=fail_state):
            with self.assertRaisesRegex(RuntimeError, "controlled publication failure"):
                await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        self.assertTrue(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID).recovery_blocked)
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        notifications = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == "session_state" and event.payload.get("recovery_blocked")
        ]
        self.assertEqual(len(notifications), 1)

    async def test_old_generation_failure_does_not_block_current_settlement(self) -> None:
        self.live.active_product_turn_id = "current-generation"
        await self.emit(RuntimeEventKind.TURN_UNKNOWN)
        incident = replace(
            self.incident(RuntimeIncidentState.FAILED, generation=2),
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        self.assertFalse(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID).recovery_blocked)

    async def test_exhausted_thread_recovery_publishes_blocked_state_without_settling(self) -> None:
        self.live.active_product_turn_id = "recovering-submission"
        await self.emit(RuntimeEventKind.TURN_UNKNOWN)
        pending = self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID)
        self.assertIsNotNone(pending)
        incident = replace(
            self.incident(RuntimeIncidentState.RETRYING),
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
            strategy=RuntimeRecoveryStrategy.AUTO_RESUME,
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        self.assertFalse(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID).recovery_blocked)
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=replace(incident, state=RuntimeIncidentState.FAILED),
        )
        self.assertTrue(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID).recovery_blocked)
        states = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == "session_state" and event.payload.get("recovery_blocked")
        ]
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0].payload["state"], "failed")
        self.assertTrue(states[0].payload["recovery_pending"])
        self.assertNotIn(
            PRODUCT_EVENT_TURN_UNKNOWN,
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
        )
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=replace(
                incident, scope=RuntimeIncidentScope.PROCESS, state=RuntimeIncidentState.RECOVERED
            ),
        )
        self.assertTrue(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID).recovery_blocked)

    async def test_started_permission_uses_submission_not_latest_selection(self) -> None:
        self.catalog.set_policy(PRODUCT_SESSION_ID, OWNER, "bypassPermissions")
        await self.emit(RuntimeEventKind.TURN_STARTED, payload={PERMISSION_MODE_KEY: "ask"})
        self.assertEqual(self.live.applied_permission_mode, "ask")

    async def test_started_permission_preserves_confirmed_live_switch(self) -> None:
        self.live.applied_permission_mode = "safe_auto"
        self.live.applied_permission_turn_id = VENDOR_TURN_ID
        await self.emit(RuntimeEventKind.TURN_STARTED, payload={PERMISSION_MODE_KEY: "ask"})
        self.assertEqual(self.live.applied_permission_mode, "safe_auto")

    async def test_permission_route_continues_admitted_change_across_drain(self) -> None:
        activities = Activities()
        self.live.last_submission_id = "permission-submission"
        self.catalog.set_policy(PRODUCT_SESSION_ID, OWNER, "ask")
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=activities)
        app = FastAPI()
        app.state.activities = activities
        calls = []

        async def set_mode(*args, **kwargs):
            calls.append((args, kwargs))
            activities.begin()
            return {
                "ok": True,
                "mode": "ask",
                "continuation": {
                    "submission_id": "permission-submission",
                    "interrupt_generation": self.live.interrupt_generation,
                },
            }, 200

        sessions = SimpleNamespace(
            require_access=lambda *_args: None,
            align_metering_identity=lambda *_args: None,
            is_readonly=lambda _session_id: False,
            set_mode=set_mode,
        )
        mount_session_routes(
            app,
            sessions=sessions,
            turns=turns,
            events=SimpleNamespace(),
            artifacts=SimpleNamespace(),
            credentials=SimpleNamespace(),
        )
        # Exercise real HTTP admission and TurnService guards; stop at enqueue so
        # this deterministic contract does not claim a native resumed turn.
        enqueue = AsyncMock(return_value=({"ok": False, "error": "enqueue-boundary"}, 409))
        with patch.object(turns, "_enqueue", enqueue):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    f"/api/serve/sessions/{PRODUCT_SESSION_ID}/mode",
                    json={"mode": "ask", "application": "interrupt_continue"},
                )
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["error"], "enqueue-boundary")
                enqueue.assert_awaited_once()
                with self.assertRaises(MaintenanceActive):
                    await client.post(
                        f"/api/serve/sessions/{PRODUCT_SESSION_ID}/mode", json={"mode": "safe_auto"}
                    )
        self.assertEqual(len(calls), 1)
        await asyncio.wait_for(activities.wait_execution_drained(), 1)

    async def test_permission_continuation_rejects_changed_origin(self) -> None:
        self.live.last_submission_id = "permission-submission"
        self.catalog.set_policy(PRODUCT_SESSION_ID, OWNER, "ask")
        service = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        for submission_id, generation, mode in (
            ("other-submission", self.live.interrupt_generation, "ask"),
            ("permission-submission", self.live.interrupt_generation + 1, "ask"),
            ("permission-submission", self.live.interrupt_generation, "safe_auto"),
        ):
            with self.subTest(submission_id=submission_id, generation=generation, mode=mode):
                result, status = await service.post(
                    PRODUCT_SESSION_ID,
                    {"input": [{"type": "text", "text": "continue"}]},
                    side=False,
                    expected_submission_id=submission_id,
                    expected_interrupt_generation=generation,
                    expected_permission_mode=mode,
                )
                self.assertEqual(status, 409)
                self.assertFalse(result["ok"])
                self.assertEqual(self.catalog.queued_messages(PRODUCT_SESSION_ID), ())

    async def asyncSetUp(self) -> None:
        self.root = self.enterContext(directory(prefix="runtime-incidents-"))
        self.workdir = self.root / "workspace"
        self.workdir.mkdir()
        self.database = self.root / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            PRODUCT_SESSION_ID,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=str(self.workdir),
            project_path=None,
            output_root=str(self.workdir / "outputs"),
            codex_version="codex-cli contract",
            model_id="gpt-contract",
            policy_id="on-request",
            status=SessionStatus.READY,
            title="runtime incident contract",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.database)
        self.logger = SimpleNamespace(
            debug=lambda *_args, **_kwargs: None,
            info=lambda *_args, **_kwargs: None,
            warning=lambda *_args, **_kwargs: None,
            error=lambda *_args, **_kwargs: None,
        )
        self.live = LiveSession(
            session_id=PRODUCT_SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=self.workdir,
            project_path=None,
            output_root=self.workdir / "outputs",
            model_id="gpt-contract",
            catalog=self.catalog,
            events=self.events,
            artifacts=SessionArtifactStore(self.database),
            skills=SkillCatalog(
                bundled_root=self.root / "bundled-skills",
                user_root=self.root / "user-skills",
            ),
            logger=self.logger,
            trace=SessionTrace(
                PRODUCT_SESSION_ID,
                self.workdir,
                runtime_id=RUNTIME_ID,
                trace_dir=self.root / "trace",
            ),
        )
        self.live.attach_gateway(_Adapter(), resumed=False, activities=Activities())
        await self.live.activate()
        self.vendor_seq = 0

    async def asyncTearDown(self) -> None:
        await self.live.aclose()

    async def emit(
        self,
        kind: RuntimeEventKind,
        *,
        incident: RuntimeIncident | None = None,
        payload: Mapping[str, Any] | None = None,
        turn_id: str = VENDOR_TURN_ID,
    ) -> None:
        self.vendor_seq += 1
        data = dict(payload or {})
        if incident is not None:
            data["incident"] = incident_data(incident)
        await self.live.on_runtime_observation(
            RuntimeEvent(
                schema_version=1,
                event_id=f"incident-event-{self.vendor_seq}",
                product_session_id=PRODUCT_SESSION_ID,
                runtime_id=RUNTIME_ID,
                native_session_id=VENDOR_THREAD_ID,
                kind=kind,
                native_turn_id=turn_id,
                native_item_id="item-contract",
                sequence=self.vendor_seq,
                process_generation=(
                    incident.process_generation
                    if incident
                    else int(data.get("process_generation", 3))
                ),
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-09-07T00:00:00Z",
                payload=data,
            )
        )

    async def test_observer_resumes_late_settlement_without_resubmitting_native_turn(self) -> None:
        client_turn_id = "late-projection-settlement"
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_turn_id, {"text": "once"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_turn_id)
        self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_turn_id, VENDOR_TURN_ID)
        await self.emit(RuntimeEventKind.TURN_STARTED)
        await self.live.ledger.record_unknown_submission(
            VENDOR_TURN_ID, safe_error="projection failed"
        )
        self.catalog.fail_queued_submission(
            PRODUCT_SESSION_ID, client_turn_id, unknown=True, safe_error="projection failed"
        )
        self.assertEqual(
            self.catalog.uncertainty(
                PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
            ).process_generation,
            3,
        )
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.live.active_product_turn_id = client_turn_id
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        self.live.settlement_observer = turns.resume_pending_settlement
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        task = self.live.current_task
        self.assertIsNotNone(task)
        self.assertTrue(self.live.running)
        await asyncio.wait_for(asyncio.shield(task), 5)
        self.assertIsNone(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID))
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, client_turn_id).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(
            self.catalog.uncertainty(
                PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
            ).state,
            UncertaintyState.RECONCILED,
        )
        self.assertEqual(
            [record.kind for record in self.events.replay(PRODUCT_SESSION_ID)].count(
                PRODUCT_EVENT_TURN_RECONCILED
            ),
            1,
        )
        self.assertEqual(self.live.runtime_session.sequence, 0)

    async def test_late_settlement_requires_reconciled_matching_queue_binding(self) -> None:
        client_turn_id = "unreconciled-submission"
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_turn_id, {"text": "once"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_turn_id)
        self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_turn_id, VENDOR_TURN_ID)
        self.catalog.fail_queued_submission(
            PRODUCT_SESSION_ID, client_turn_id, unknown=True, safe_error="unknown"
        )
        await self.live.ledger.record_unknown_submission(VENDOR_TURN_ID, safe_error="unknown")
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        await turns._settle_queued_outcome(
            self.live,
            client_turn_id,
            RuntimeTurnOutcome.COMPLETED,
            "",
            native_turn_id=VENDOR_TURN_ID,
        )
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, client_turn_id).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.catalog.transition_uncertainty(
            PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID, UncertaintyState.RECONCILED
        )
        await turns._settle_queued_outcome(
            self.live,
            client_turn_id,
            RuntimeTurnOutcome.COMPLETED,
            "",
            native_turn_id="other-native",
        )
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, client_turn_id).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_pending_settlement_keeps_recovery_task_while_database_is_locked(self) -> None:
        client_turn_id = "locked-settlement-client"
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_turn_id, {"text": "once"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_turn_id)
        self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_turn_id, VENDOR_TURN_ID)
        self.live.active_product_turn_id = client_turn_id
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        attempted = threading.Event()
        original = self.catalog._connect

        def connect():
            connection = original()
            connection.execute("PRAGMA busy_timeout = 0")
            attempted.set()
            return connection

        blocker = sqlite3.connect(self.database)
        blocker.execute("BEGIN IMMEDIATE")
        task = None
        try:
            with patch.object(self.catalog, "_connect", side_effect=connect):
                turns = TurnService(
                    {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
                )
                turns.resume_pending_settlement(self.live)
                task = self.live.current_task
                self.assertIsNotNone(task)
                self.assertTrue(await asyncio.to_thread(attempted.wait, 2))
                await asyncio.sleep(0.05)
                self.assertFalse(task.done())
                blocker.rollback()
                await asyncio.wait_for(asyncio.shield(task), 3)
            self.assertIsNone(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID))
            self.assertEqual(self.live.active_product_turn_id, "")
            self.assertEqual(
                self.catalog.queued_message(PRODUCT_SESSION_ID, client_turn_id).state,
                QueuedMessageState.COMPLETED,
            )
        finally:
            blocker.rollback()
            blocker.close()
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)

    async def test_unknown_then_exit_keeps_gateway_recovery_observations(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=False)

    async def test_exit_then_unknown_keeps_gateway_recovery_observations(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=True)

    async def test_late_submission_unknown_releases_original_uncertainty(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=True, late=True)

    async def test_late_submission_unknown_with_retained_product_turn(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=True, late=True, retain_active=True)

    async def test_late_process_unknown_does_not_downgrade_submission(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=False, late=True)

    async def test_late_unknown_without_native_turn_keeps_recovery_observations(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=False, late=True, missing_native=True)

    async def test_late_submission_without_native_turn_refines_original_uncertainty(self) -> None:
        await self._assert_unknown_exit_projection(exit_first=True, late=True, missing_native=True)

    async def test_late_confirmed_unknown_keeps_later_turn_after_restart(self) -> None:
        await self._assert_closed_unknown_projection(confirmed=True)

    async def test_late_reconciled_unknown_keeps_later_turn_after_restart(self) -> None:
        await self._assert_closed_unknown_projection(confirmed=False)

    async def _assert_closed_unknown_projection(self, *, confirmed: bool) -> None:
        old_turn = "closed-unknown-turn"
        later_turn = "later-completed-turn"
        incident = replace(
            self.incident(
                RuntimeIncidentState.FAILED, retryability=RuntimeRetryability.UNKNOWN_OUTCOME
            ),
            vendor_turn_id=old_turn,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=incident, turn_id=old_turn)
        if confirmed:
            self.assertTrue(await self.live.ledger.confirm_unknown_turn(old_turn))
        else:
            await self.emit(RuntimeEventKind.TURN_COMPLETED, turn_id=old_turn)
        await self.emit(RuntimeEventKind.TURN_COMPLETED, turn_id=later_turn)
        unknown_before = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_TURN_UNKNOWN
        ]
        self.live.ledger = SessionLedger(
            PRODUCT_SESSION_ID,
            self.catalog,
            self.live.publish,
            self.live._trace,
            self.logger,
            self.live._projection_lock,
            self.live.persistence,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=incident, turn_id=old_turn)
        record = self.catalog.get(PRODUCT_SESSION_ID)
        assert record is not None
        self.assertEqual(record.last_turn_id, later_turn)
        self.assertEqual(record.status, SessionStatus.COMPLETED)
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            [
                event
                for event in self.events.replay(PRODUCT_SESSION_ID)
                if event.kind == PRODUCT_EVENT_TURN_UNKNOWN
            ],
            unknown_before,
        )

    async def _assert_unknown_exit_projection(
        self,
        *,
        exit_first: bool,
        late: bool = False,
        retain_active: bool = False,
        missing_native: bool = False,
    ) -> None:
        client_id = "preack-client"
        self.live.active_product_turn_id = client_id
        self.live.last_submission_id = client_id
        adapter = self.live.runtime_session
        driver = self.live.runtime_driver
        assert isinstance(adapter, _Adapter)
        assert driver is not None
        submission_incident = RuntimeIncident(
            incident_id="submission-unknown",
            scope=RuntimeIncidentScope.TURN,
            state=RuntimeIncidentState.FAILED,
            kind=RuntimeIncidentKind.TRANSPORT_LOST,
            strategy=RuntimeRecoveryStrategy.MANUAL_RETRY,
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
            safe_error="agent_runtime_exit",
            process_generation=3,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=client_id,
            rpc_method="turn/start",
            ambiguous_commit=True,
        )
        process_incident = replace(
            submission_incident,
            incident_id="process-exit",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            vendor_turn_id="",
            rpc_method="",
            ambiguous_commit=False,
        )
        incidents = (
            (process_incident, submission_incident)
            if exit_first
            else (submission_incident, process_incident)
        )
        observations = [
            RuntimeEvent(
                schema_version=1,
                event_id=f"unknown-{sequence}",
                product_session_id=PRODUCT_SESSION_ID,
                runtime_id=RUNTIME_ID,
                native_session_id=VENDOR_THREAD_ID,
                native_turn_id=client_id,
                correlation_id=client_id,
                process_generation=3,
                sequence=sequence * 2,
                kind=RuntimeEventKind.TURN_UNKNOWN,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-10-26T00:00:00Z",
                payload={"incident": incident_data(incident)},
            )
            for sequence, incident in enumerate(incidents, start=1)
        ]
        recovered = replace(
            observations[-1],
            event_id="process-recovered",
            sequence=5,
            native_turn_id="",
            kind=RuntimeEventKind.RUNTIME_INCIDENT,
            process_generation=4,
            payload={
                "incident": incident_data(
                    replace(
                        process_incident,
                        state=RuntimeIncidentState.RECOVERED,
                        process_generation=4,
                    )
                )
            },
        )

        def enqueue(observation: RuntimeEvent) -> None:
            if (
                observation.kind is RuntimeEventKind.TURN_UNKNOWN
                and event_incident(observation).scope is RuntimeIncidentScope.PROCESS
            ):
                adapter.queue.put_nowait(
                    replace(
                        observation,
                        event_id="process-detected",
                        sequence=observation.sequence - 1,
                        kind=RuntimeEventKind.RUNTIME_INCIDENT,
                        native_turn_id="",
                        native_item_id="",
                    )
                )
            adapter.queue.put_nowait(observation)

        if late:
            enqueue(observations[0])
            async with asyncio.timeout(SETTLEMENT_TIMEOUT_SECONDS):
                while driver._projected_sequence < observations[0].sequence:
                    if driver._consumer_error is not None:
                        raise driver._consumer_error
                    await asyncio.sleep(0.01)
            self.assertTrue(await self.live.settle_product_turn(observations[0]))
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            self.assertTrue(self.catalog.clear_turn_settlement(PRODUCT_SESSION_ID, client_id))
            self.live.ledger = SessionLedger(
                PRODUCT_SESSION_ID,
                self.catalog,
                self.live.publish,
                self.live._trace,
                self.logger,
                self.live._projection_lock,
                self.live.persistence,
            )
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            if not retain_active:
                self.live.active_product_turn_id = ""
            prior_admission = dict(self.live.ledger._unknown_admission)
            with patch.object(
                self.catalog, "record_unknown_turn", side_effect=OSError("write failed")
            ):
                with self.assertRaises(OSError):
                    await self.live.ledger.refine_unknown(observations[1])
            self.assertEqual(self.live.ledger._unknown_admission, prior_admission)
        if missing_native:
            observations[1] = replace(observations[1], native_turn_id="")
        for observation in (*(observations[1:] if late else observations), recovered):
            enqueue(observation)
        async with asyncio.timeout(SETTLEMENT_TIMEOUT_SECONDS):
            while driver._projected_sequence < 5:
                if driver._consumer_error is not None:
                    raise driver._consumer_error
                await asyncio.sleep(0.01)
        self.assertTrue(adapter.queue.empty())
        self.assertFalse(driver._consumer.done())
        pending = self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID)
        if pending is not None:
            self.assertEqual(
                event_incident(pending.event), submission_incident if not late else incidents[-1]
            )
            self.assertEqual(pending.event.kind, RuntimeEventKind.TURN_UNKNOWN)
        else:
            self.assertTrue(late and not retain_active)
        if late:
            uncertainty = self.catalog.uncertainty(
                PRODUCT_SESSION_ID, UncertaintyKind.TURN, client_id
            )
            assert uncertainty is not None
            self.assertEqual(uncertainty.incident_id, submission_incident.incident_id)
            self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            [
                event.payload["state"]
                for event in self.events.replay(PRODUCT_SESSION_ID)
                if event.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
            ][-1],
            RuntimeIncidentState.RECOVERED.value,
        )
        self.assertFalse(
            await self.live.settle_product_turn(
                next(
                    observation
                    for observation in observations
                    if event_incident(observation).scope is RuntimeIncidentScope.PROCESS
                )
            )
        )
        submission_state = self.live.ledger._runtime_incidents.get(submission_incident.incident_id)
        if submission_state is not None:
            self.assertEqual(submission_state.state, RuntimeIncidentState.FAILED)
        else:
            self.assertTrue(late and not exit_first)
        self.assertEqual(
            self.live.ledger._runtime_incidents[process_incident.incident_id].state,
            RuntimeIncidentState.RECOVERED,
        )
        self.assertFalse(
            any(
                event.kind in {PRODUCT_EVENT_TURN_COMPLETED, PRODUCT_EVENT_TURN_RECONCILED}
                for event in self.events.replay(PRODUCT_SESSION_ID)
            )
        )
        completed = replace(
            recovered,
            event_id="authoritative-completed",
            kind=RuntimeEventKind.TURN_COMPLETED,
            sequence=6,
            native_turn_id=VENDOR_TURN_ID,
            payload={"resolved_ambiguous_incident_id": submission_incident.incident_id},
        )
        adapter.queue.put_nowait(completed)
        async with asyncio.timeout(SETTLEMENT_TIMEOUT_SECONDS):
            while driver._projected_sequence < 6:
                if driver._consumer_error is not None:
                    raise driver._consumer_error
                await asyncio.sleep(0.01)
        pending = self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID)
        if pending is not None:
            self.assertEqual(pending.event, completed)
            self.assertTrue(await self.live.settle_product_turn(completed))
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        if late:
            self.assertEqual(
                self.catalog.uncertainty(PRODUCT_SESSION_ID, UncertaintyKind.TURN, client_id).state,
                UncertaintyState.RECONCILED,
            )

    async def settle_pending(self, client_turn_id: str) -> None:
        pending = self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID)
        self.assertIsNotNone(pending)
        assert pending is not None
        self.assertEqual(pending.client_turn_id, client_turn_id)
        self.assertEqual(pending.native_turn_id, VENDOR_TURN_ID)
        self.assertEqual(pending.event.event_id, f"incident-event-{self.vendor_seq}")
        self.assertEqual(pending.event.kind, RuntimeEventKind.TURN_FAILED)
        self.assertNotIn(
            PRODUCT_EVENT_TURN_FAILED,
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
        )
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        turns.resume_pending_settlement(self.live)
        task = self.live.current_task
        self.assertIsNotNone(task)
        assert task is not None
        await asyncio.wait_for(asyncio.shield(task), 5.0)
        self.assertIsNone(self.catalog.pending_turn_settlement(PRODUCT_SESSION_ID))
        self.assertEqual(self.live.active_product_turn_id, "")

    @staticmethod
    def incident(
        state: RuntimeIncidentState,
        *,
        incident_id: str = "incident-contract",
        generation: int = 3,
        attempt: int = 1,
        retryability: RuntimeRetryability = RuntimeRetryability.IN_PROGRESS,
    ) -> RuntimeIncident:
        return RuntimeIncident(
            incident_id=incident_id,
            scope=RuntimeIncidentScope.PROVIDER,
            state=state,
            kind=RuntimeIncidentKind.PROVIDER_RETRY,
            strategy=RuntimeRecoveryStrategy.VENDOR_RETRY,
            retryability=retryability,
            safe_error="provider_retrying",
            process_generation=generation,
            attempt=attempt,
            max_attempts=5,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=VENDOR_TURN_ID,
            rpc_method="turn/start",
            rpc_code=-32000,
        )

    def test_incident_wire_roundtrip_and_type_validation(self) -> None:
        incident = self.incident(RuntimeIncidentState.RETRYING)
        wire = incident_data(incident)
        self.assertEqual(event_incident(SimpleNamespace(payload={"incident": wire})), incident)
        self.assertEqual(
            event_incident(
                SimpleNamespace(
                    payload={
                        "incident": {
                            **wire,
                            "provider_error_code": "rate_limit_exceeded",
                            "provider_http_status": 429,
                        }
                    }
                )
            ).provider_http_status,
            429,
        )
        for field, invalid in (
            ("incident_id", 12),
            ("attempt", True),
            ("process_generation", "3"),
            ("rpc_code", []),
            ("ambiguous_commit", "false"),
            ("scope", "unrecognized"),
        ):
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "invalid runtime incident"),
            ):
                event_incident(SimpleNamespace(payload={"incident": {**wire, field: invalid}}))

    async def test_process_incident_keeps_binding_when_unknown_carries_client_identity(
        self,
    ) -> None:
        incident = RuntimeIncident(
            incident_id="process-context-contract",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=3,
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident, turn_id="")
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=incident, turn_id="preack-client")
        records = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
        ]
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0].vendor_turn_id)
        self.assertFalse(records[0].vendor_item_id)
        self.assertTrue(self.live.ledger.has_unknown_outcome)

    async def test_incident_progression_is_typed_idempotent_and_redacted(self) -> None:
        retrying = self.incident(RuntimeIncidentState.RETRYING)
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=retrying,
            payload={"raw_error": RAW_VENDOR_SECRET},
        )
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=retrying,
            payload={"raw_error": RAW_VENDOR_SECRET},
        )
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(RuntimeIncidentState.RECOVERED),
            payload={"raw_error": RAW_VENDOR_SECRET},
        )

        records = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual([record.kind for record in records], [PRODUCT_EVENT_RUNTIME_INCIDENT] * 2)
        self.assertEqual(
            [record.idempotency_key for record in records],
            [
                "incident:incident-contract:retrying:1",
                "incident:incident-contract:recovered:1",
            ],
        )
        self.assertEqual(records[0].payload["process_generation"], 3)
        self.assertEqual(records[0].payload["rpc_code"], -32000)
        self.assertNotIn("vendor_thread_id", records[0].payload)
        self.assertNotIn("vendor_turn_id", records[0].payload)
        self.assertNotIn(RAW_VENDOR_SECRET, json.dumps([record.payload for record in records]))

        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_text = trace_path.read_text(encoding="utf-8")
        trace_rows = [json.loads(line) for line in trace_text.splitlines()]
        incident_rows = [row for row in trace_rows if row["name"].startswith("runtime.incident.")]
        self.assertEqual(
            [row["name"] for row in incident_rows],
            [
                "runtime.incident.retrying",
                "runtime.incident.retrying",
                "runtime.incident.recovered",
            ],
        )
        self.assertEqual(incident_rows[0]["attributes"]["incident_id"], "incident-contract")
        self.assertNotIn(RAW_VENDOR_SECRET, trace_text)

    async def test_unknown_pauses_admission_and_only_same_generation_completion_reconciles(
        self,
    ) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-contract",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        self.live.last_submission_id = VENDOR_TURN_ID
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN,
            incident=replace(unknown, vendor_turn_id=""),
            payload={"safe_error": "turn_result_unconfirmed"},
            turn_id="",
        )

        self.assertTrue(self.live.ledger.has_unknown_outcome)
        unknown_record = next(
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_TURN_UNKNOWN
        )
        self.assertEqual(unknown_record.vendor_turn_id, VENDOR_TURN_ID)
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.last_turn_status, PRODUCT_TURN_OUTCOME_UNKNOWN)
        rejected, status = await TurnService(
            {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
        ).post(
            PRODUCT_SESSION_ID,
            {"input": [{"type": "text", "text": "must remain paused"}]},
            side=False,
        )
        self.assertEqual(status, 409)
        self.assertEqual(rejected["error"], TURN_OUTCOME_UNCONFIRMED)

        original = self.live.runtime_session.fail_submission
        self.live.runtime_session.fail_submission = True
        try:
            await TurnService(
                {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
            )._execute(
                self.live,
                TurnInput(
                    items=(InputItem(InputKind.TEXT, text="ambiguous"),),
                    client_user_message_id=VENDOR_TURN_ID,
                ),
            )
        finally:
            self.live.runtime_session.fail_submission = original
        self.assertNotIn(
            PRODUCT_EVENT_TURN_FAILED,
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
        )

        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={"safe_error": "late failure", "process_generation": 4},
        )
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            payload={"status": "completed", "process_generation": 4},
        )
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertNotIn(
            PRODUCT_EVENT_TURN_FAILED,
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
        )

        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            payload={"status": "completed", "process_generation": 3},
        )
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            payload={"status": "completed", "process_generation": 3},
        )
        kinds = [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)]
        self.assertEqual(kinds.count(PRODUCT_EVENT_TURN_UNKNOWN), 1)
        self.assertEqual(kinds.count(PRODUCT_EVENT_TURN_COMPLETED), 1)
        self.assertFalse(self.live.ledger.has_unknown_outcome)

    async def test_controlled_interrupt_reconciles_unknown_without_human_confirmation(
        self,
    ) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="controlled-interrupt",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)

        self.assertTrue(await self.live.ledger.reconcile_controlled_interrupt(VENDOR_TURN_ID))
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.status, SessionStatus.INTERRUPTED)
        self.assertEqual(record.last_turn_status, PRODUCT_TURN_OUTCOME_INTERRUPTED)
        uncertainty = self.catalog.uncertainty(
            PRODUCT_SESSION_ID,
            UncertaintyKind.TURN,
            VENDOR_TURN_ID,
        )
        self.assertIsNotNone(uncertainty)
        assert uncertainty is not None
        self.assertEqual(uncertainty.state, UncertaintyState.RECONCILED)
        self.assertEqual(
            [
                event.kind
                for event in self.events.replay(PRODUCT_SESSION_ID)
                if event.kind == PRODUCT_EVENT_TURN_RECONCILED
            ],
            [PRODUCT_EVENT_TURN_RECONCILED],
        )

    async def test_only_authoritative_reconciliation_reopens_turn_admission(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-before-restart",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.assertTrue(self.live.ledger.has_unknown_outcome)

        process_recovered = replace(
            self.incident(
                RuntimeIncidentState.RECOVERED,
                incident_id="process-after-restart",
                generation=4,
                retryability=RuntimeRetryability.TERMINAL,
            ),
            scope=RuntimeIncidentScope.PROCESS,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
        )
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=process_recovered,
            turn_id="",
        )
        self.assertTrue(self.live.ledger.has_unknown_outcome)

        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            payload={
                "process_generation": 4,
                "resolved_ambiguous_incident_id": unknown.incident_id,
            },
            turn_id="turn-authoritatively-reconciled",
        )
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        incident_states = [
            event.payload["state"]
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
            and event.payload["incident_id"] == unknown.incident_id
        ]
        self.assertEqual(incident_states, ["detected", "recovered"])

        result, status = await TurnService(
            {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
        ).post(
            PRODUCT_SESSION_ID,
            {"wait": True, "input": [{"type": "text", "text": "continue after recovery"}]},
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(result["ok"], result)

    async def test_a_message_sent_during_process_recovery_is_durably_queued_first(self) -> None:
        """AOne 86998131 的准入前提: 进程恢复窗口内的普通消息先落盘, 再等运行时。

        前端之所以可以在 ``starting``/``recovering`` 期间放行已有会话的普通发送, 靠的就是这条
        后端契约 —— ``post`` 不读 readiness, 入队发生在任何运行时交互之前, 因此瞬态窗口最坏
        只是延迟执行, 不会丢消息。若后端改成按 readiness 拒收, 这条断言会先失败。
        """

        recovering = replace(
            self.incident(RuntimeIncidentState.DETECTED, incident_id="process-recovering"),
            scope=RuntimeIncidentScope.PROCESS,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=recovering, turn_id="")
        adapter = self.live.runtime_session
        submitted = asyncio.Event()
        released = asyncio.Event()
        accept = adapter.submit

        async def restarting(request):
            submitted.set()
            await released.wait()
            return await accept(request)

        adapter.submit = restarting
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        payload, status = await turns.post(
            PRODUCT_SESSION_ID,
            {"input": [{"type": "text", "text": "恢复期间继续发送"}]},
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(payload["ok"])
        task = self.live.resource_task
        queued_id = str(payload["queued_message_id"])
        stored = self.catalog.queued_message(PRODUCT_SESSION_ID, queued_id)
        self.assertIsNotNone(stored)
        await asyncio.wait_for(submitted.wait(), 2.0)
        # 运行时还没接下这条消息, 但它已经在持久队列里 —— 这正是可以放行发送的理由。
        self.assertIn(
            self.catalog.queued_message(PRODUCT_SESSION_ID, queued_id).state,
            (QueuedMessageState.QUEUED, QueuedMessageState.SUBMITTING),
        )

        self.assertIsNotNone(task)
        released.set()
        await asyncio.wait_for(asyncio.shield(task), 5.0)
        self.assertEqual(tuple(self.catalog.queued_messages(PRODUCT_SESSION_ID)), ())
        self.assertTrue(
            any(
                event.kind == PRODUCT_EVENT_TURN_COMPLETED
                for event in self.events.replay(PRODUCT_SESSION_ID)
            )
        )

    async def test_unknown_correlation_survives_restart_and_exact_resume_is_authoritative(
        self,
    ) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-durable",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        restarted = LiveSession(
            session_id=PRODUCT_SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=self.workdir,
            project_path=None,
            output_root=self.workdir / "outputs",
            model_id="gpt-contract",
            catalog=SessionCatalogStore(self.database),
            events=self.events,
            artifacts=SessionArtifactStore(self.database),
            skills=SkillCatalog(
                bundled_root=self.root / "restarted-bundled",
                user_root=self.root / "restarted-user",
            ),
            logger=self.logger,
            trace=SessionTrace(
                PRODUCT_SESSION_ID,
                self.workdir,
                runtime_id=RUNTIME_ID,
                trace_dir=self.root / "restart-trace",
            ),
        )
        restarted.attach_gateway(
            _Adapter(
                (
                    ResumeTurnSnapshot(
                        client_id=VENDOR_TURN_ID,
                        turn_id=VENDOR_TURN_ID,
                        terminal_status=TurnStatus.COMPLETED,
                    ),
                )
            ),
            resumed=True,
            activities=Activities(),
        )
        await restarted.activate()
        try:
            self.assertTrue(restarted.ledger.has_unknown_outcome)
            await restarted.reconcile_resumed_turns()
            self.assertFalse(restarted.ledger.has_unknown_outcome)
            durable = self.catalog.uncertainty(
                PRODUCT_SESSION_ID,
                UncertaintyKind.TURN,
                VENDOR_TURN_ID,
            )
            self.assertIsNotNone(durable)
            assert durable is not None
            self.assertEqual(durable.state, UncertaintyState.RECONCILED)
            completed = [
                row
                for row in self.events.replay(PRODUCT_SESSION_ID)
                if row.kind == PRODUCT_EVENT_TURN_COMPLETED
            ]
            self.assertEqual([row.vendor_turn_id for row in completed], [VENDOR_TURN_ID])
        finally:
            await restarted.aclose()

    async def test_resumed_terminal_settles_unknown_queue_and_allows_next_turn(self) -> None:
        for status in (TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.INTERRUPTED):
            with self.subTest(status=status):
                client_id = f"resume-client-{status.value}"
                native_id = f"resume-native-{status.value}"
                self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_id, {"text": "once"})
                self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_id)
                self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_id, native_id)
                await self.emit(
                    RuntimeEventKind.TURN_UNKNOWN,
                    turn_id=native_id,
                    payload={"client_user_message_id": client_id},
                )
                self.catalog.fail_queued_submission(
                    PRODUCT_SESSION_ID, client_id, unknown=True, safe_error="unknown"
                )
                self.live.runtime_session.resume_turns = (
                    ResumeTurnSnapshot(
                        client_id=client_id, turn_id=native_id, terminal_status=status
                    ),
                )
                await self.live.reconcile_resumed_turns()
                await self.live.reconcile_resumed_turns()
                self.assertFalse(self.live.ledger.has_unknown_outcome)
                self.assertEqual(
                    self.catalog.queued_message(PRODUCT_SESSION_ID, client_id).state,
                    QueuedMessageState.COMPLETED,
                )
                self.assertEqual(
                    self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, status.value
                )
                removed = [
                    event
                    for event in self.events.replay(PRODUCT_SESSION_ID)
                    if event.kind == "message_removed"
                    and event.payload.get("queued_message_id") == client_id
                ]
                self.assertEqual(len(removed), 1)
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities())
        result, status = await turns.post(
            PRODUCT_SESSION_ID,
            {"wait": True, "input": [{"type": "text", "text": "continue after restart"}]},
            side=False,
        )
        self.assertEqual(status, 202, result)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.catalog.queued_messages(PRODUCT_SESSION_ID), ())

    async def test_resume_resolves_zero_generation_and_partially_reconciled_turns(self) -> None:
        for status in (TurnStatus.COMPLETED, TurnStatus.FAILED, TurnStatus.INTERRUPTED):
            for partial in (False, True):
                with self.subTest(status=status, partial=partial):
                    client_id = f"zero-client-{status.value}-{partial}"
                    native_id = f"zero-native-{status.value}-{partial}"
                    self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_id, {"text": "once"})
                    self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_id)
                    self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_id, native_id)
                    self.catalog.fail_queued_submission(
                        PRODUCT_SESSION_ID, client_id, unknown=True, safe_error="shutdown"
                    )
                    self.catalog.claim_uncertainty(
                        PRODUCT_SESSION_ID,
                        UncertaintyKind.TURN,
                        native_id,
                        state=UncertaintyState.EXECUTING,
                    )
                    if partial:
                        self.catalog.transition_uncertainty(
                            PRODUCT_SESSION_ID,
                            UncertaintyKind.TURN,
                            native_id,
                            UncertaintyState.RECONCILED,
                            payload={"vendor_turn_id": native_id},
                        )
                        queued = self.catalog.queued_message(PRODUCT_SESSION_ID, client_id)
                        self.catalog.remove_reconciled_unknown_message(
                            PRODUCT_SESSION_ID, client_id, int(queued.operation_seq or 0)
                        )
                    self.catalog.update_status(
                        PRODUCT_SESSION_ID,
                        SessionStatus.ERROR,
                        turn_id=native_id,
                        turn_status=PRODUCT_TURN_OUTCOME_UNKNOWN,
                    )
                    self.live.ledger = SessionLedger(
                        PRODUCT_SESSION_ID,
                        self.catalog,
                        self.live.publish,
                        self.live._trace,
                        self.logger,
                        self.live._projection_lock,
                        self.live.persistence,
                    )
                    self.live.runtime_session.resume_turns = (
                        ResumeTurnSnapshot(
                            client_id=client_id, turn_id=native_id, terminal_status=status
                        ),
                    )
                    await self.live.reconcile_resumed_turns()
                    await self.live.reconcile_resumed_turns()
                    self.assertFalse(self.live.ledger.has_unknown_outcome)
                    self.assertEqual(
                        self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, status.value
                    )
                    self.assertEqual(
                        self.catalog.queued_message(PRODUCT_SESSION_ID, client_id).state,
                        QueuedMessageState.COMPLETED,
                    )
        self.assertFalse(
            any(
                event.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
                and event.payload.get("kind") == "terminal_conflict"
                for event in self.events.replay(PRODUCT_SESSION_ID)
            )
        )

    async def test_zero_generation_live_terminal_does_not_resolve_unknown(self) -> None:
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, payload={"process_generation": 0})
        await self.emit(RuntimeEventKind.TURN_COMPLETED, payload={"process_generation": 0})
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, PRODUCT_TURN_OUTCOME_UNKNOWN
        )

    async def test_resume_settles_already_reconciled_queue_after_reopening_ledger(self) -> None:
        client_id = "previously-reconciled-client"
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_id, {"text": "once"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_id)
        self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_id, VENDOR_TURN_ID)
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN, payload={"client_user_message_id": client_id}
        )
        self.catalog.fail_queued_submission(
            PRODUCT_SESSION_ID, client_id, unknown=True, safe_error="unknown"
        )
        await self.emit(RuntimeEventKind.TURN_FAILED)
        self.live.ledger = SessionLedger(
            PRODUCT_SESSION_ID,
            SessionCatalogStore(self.database),
            self.live.publish,
            self.live._trace,
            self.logger,
            self.live._projection_lock,
            self.live.persistence,
        )
        self.live.runtime_session.resume_turns = (
            ResumeTurnSnapshot(
                client_id=client_id, turn_id=VENDOR_TURN_ID, terminal_status=TurnStatus.FAILED
            ),
        )
        await self.live.reconcile_resumed_turns()
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, client_id).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, "failed")

    async def test_resume_keeps_unknown_queue_for_unmatched_or_nonterminal_history(self) -> None:
        client_id = "unmatched-resume-client"
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, client_id, {"text": "once"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, client_id)
        self.catalog.mark_queue_running(PRODUCT_SESSION_ID, client_id, VENDOR_TURN_ID)
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN, payload={"client_user_message_id": client_id}
        )
        self.catalog.fail_queued_submission(
            PRODUCT_SESSION_ID, client_id, unknown=True, safe_error="unknown"
        )
        for snapshot in (
            ResumeTurnSnapshot(
                client_id="other-client", turn_id=VENDOR_TURN_ID, terminal_status=TurnStatus.FAILED
            ),
            ResumeTurnSnapshot(
                client_id=client_id, turn_id="other-native", terminal_status=TurnStatus.FAILED
            ),
            ResumeTurnSnapshot(client_id=client_id, turn_id=VENDOR_TURN_ID, terminal_status=None),
        ):
            self.live.runtime_session.resume_turns = (snapshot,)
            await self.live.reconcile_resumed_turns()
            self.assertEqual(
                self.catalog.queued_message(PRODUCT_SESSION_ID, client_id).state,
                QueuedMessageState.OUTCOME_UNKNOWN,
            )
            self.assertTrue(self.live.ledger.has_unknown_outcome)

    async def test_shutdown_interrupt_settles_turn_and_preserves_unsent_queue(self) -> None:
        adapter = self.live.runtime_session
        submitted = asyncio.Event()
        request_id = "shutdown-active-client"
        original_submit = adapter.submit

        async def submit(request):
            adapter.sequence += 1
            await adapter.queue.put(
                RuntimeEvent(
                    schema_version=1,
                    event_id="shutdown-started",
                    runtime_id=RUNTIME_ID,
                    product_session_id=PRODUCT_SESSION_ID,
                    native_session_id=VENDOR_THREAD_ID,
                    native_turn_id=request.command_id,
                    process_generation=3,
                    sequence=adapter.sequence,
                    kind=RuntimeEventKind.TURN_STARTED,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="2026-09-07T00:00:00Z",
                    correlation_id=request.command_id,
                )
            )
            submitted.set()
            return CommandReceipt(request.command_id, CommandState.ACCEPTED)

        async def interrupt(request):
            adapter.sequence += 1
            await adapter.queue.put(
                RuntimeEvent(
                    schema_version=1,
                    event_id="shutdown-interrupted",
                    runtime_id=RUNTIME_ID,
                    product_session_id=PRODUCT_SESSION_ID,
                    native_session_id=VENDOR_THREAD_ID,
                    native_turn_id=request_id,
                    process_generation=3,
                    sequence=adapter.sequence,
                    kind=RuntimeEventKind.TURN_INTERRUPTED,
                    delivery=DeliveryClass.MUST_PERSIST,
                    observed_at="2026-09-07T00:00:00Z",
                    correlation_id=request_id,
                )
            )
            return CommandReceipt(request.command_id, CommandState.APPLIED)

        adapter.submit = submit
        adapter.interrupt = interrupt
        activities = Activities()
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger, activities=activities)
        self.addAsyncCleanup(turns.aclose)
        result, status = await turns.post(
            PRODUCT_SESSION_ID,
            {
                "client_user_message_id": request_id,
                "input": [{"type": "text", "text": "active before shutdown"}],
            },
            side=False,
        )
        self.assertEqual(status, 202, result)
        await asyncio.wait_for(submitted.wait(), 5)
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, "still-queued", {"text": "later"})
        await asyncio.wait_for(
            SessionService.interrupt_running_for_shutdown(
                SimpleNamespace(_sessions={PRODUCT_SESSION_ID: self.live})
            ),
            5,
        )
        self.assertEqual(self.catalog.get(PRODUCT_SESSION_ID).last_turn_status, "interrupted")
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, request_id).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(
            self.catalog.queued_message(PRODUCT_SESSION_ID, "still-queued").state,
            QueuedMessageState.QUEUED,
        )
        self.assertEqual(adapter.sequence, 2)
        adapter.submit = original_submit

    async def test_nonterminal_resume_keeps_gate_until_explicit_human_confirmation(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-active",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.live.runtime_session.resume_turns = (
            ResumeTurnSnapshot(
                client_id=VENDOR_TURN_ID,
                turn_id=VENDOR_TURN_ID,
                terminal_status=None,
            ),
        )
        await self.live.reconcile_resumed_turns()
        self.assertTrue(self.live.running)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        rejected, status = await TurnService(
            {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
        ).post(
            PRODUCT_SESSION_ID,
            {"input": [{"type": "text", "text": "must still wait"}]},
            side=False,
        )
        self.assertEqual((rejected["error"], status), ("turn_outcome_unconfirmed", 409))
        self.assertTrue(await self.live.ledger.confirm_unknown_turn(VENDOR_TURN_ID))
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertTrue(self.live.running)
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            turn_id=VENDOR_TURN_ID,
            payload={"status": "completed", "process_generation": 3},
        )
        self.assertFalse(self.live.running)

    async def test_failed_confirmation_never_releases_the_in_memory_gate(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-confirm-failure",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        original = self.catalog.confirm_turn_uncertainty
        self.catalog.confirm_turn_uncertainty = lambda *_args, **_kwargs: False  # type: ignore[method-assign]
        try:
            self.assertFalse(await self.live.ledger.confirm_unknown_turn(VENDOR_TURN_ID))
            self.assertTrue(self.live.ledger.has_unknown_outcome)

            def fail(*_args: Any, **_kwargs: Any) -> bool:
                raise RuntimeError("durable confirmation failed")

            self.catalog.confirm_turn_uncertainty = fail  # type: ignore[method-assign]
            with self.assertRaises(RuntimeError):
                await self.live.ledger.confirm_unknown_turn(VENDOR_TURN_ID)
            self.assertTrue(self.live.ledger.has_unknown_outcome)
        finally:
            self.catalog.confirm_turn_uncertainty = original  # type: ignore[method-assign]
        row = self.catalog.uncertainty(
            PRODUCT_SESSION_ID,
            UncertaintyKind.TURN,
            VENDOR_TURN_ID,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row.state, UncertaintyState.UNKNOWN)

    def confirmation_service(self) -> SessionService:
        service = SessionService(
            self.workdir,
            {PRODUCT_SESSION_ID: self.live},
            activities=Activities(),
            access=self.catalog,
            events=self.events,
            runtime=SimpleNamespace(),
            workspaces=SimpleNamespace(),
            artifacts=SessionArtifactStore(self.database),
            settings=SimpleNamespace(),
            credentials=SimpleNamespace(),
            logger=self.logger,
        )
        return service

    def enable_turn_confirmation(self) -> None:
        self.live.runtime_session.capabilities = CapabilitySet(
            (RuntimeCapability("turn_confirmation", CapabilityState.SUPPORTED),)
        )
        self.live.runtime_binding = replace(
            self.live.runtime_binding, capabilities=self.live.runtime_session.capabilities
        )
        self.live.runtime_session.binding = self.live.runtime_binding

    @staticmethod
    def confirmation_receipt(target: TurnConfirmationTarget) -> TurnConfirmationReceipt:
        return TurnConfirmationReceipt(
            TurnConfirmationTicket("confirmation-ticket", target, "adapter-instance:4", 5, 6),
            CommandState.APPLIED,
        )

    async def test_automatic_retry_confirmation_keeps_unknown_outcome_and_policy_audit(
        self,
    ) -> None:
        unknown = self.incident(
            RuntimeIncidentState.FAILED,
            incident_id="automatic-retry",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock(side_effect=self.confirmation_receipt)
        service = self.confirmation_service()
        callback = AsyncMock()
        service.bind_turn_confirmation(callback)
        async with self.live.lifecycle_lock:
            self.assertTrue(await service.authorize_crash_retry(self.live, VENDOR_TURN_ID))
        driver.confirm_turn.assert_awaited_once()
        callback.assert_not_awaited()
        uncertainty = self.catalog.uncertainty(
            PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
        )
        self.assertIs(uncertainty.state, UncertaintyState.CONFIRMED)
        self.assertEqual(uncertainty.payload["resolution"], AUTOMATIC_CRASH_RETRY)
        reconciled = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_TURN_RECONCILED
        ]
        self.assertEqual(reconciled[-1].payload["resolution"], AUTOMATIC_CRASH_RETRY)
        self.assertEqual(reconciled[-1].payload["outcome"], "unknown_outcome")

    async def test_runtime_confirmation_rejection_preserves_product_uncertainty(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.FAILED,
            incident_id="confirmation-rejected",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock(
            return_value=SimpleNamespace(state=CommandState.REJECTED, safe_error="unsafe")
        )
        service = self.confirmation_service()
        callback = AsyncMock()
        service.bind_turn_confirmation(callback)
        result, status = await service.confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 409, result)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            self.catalog.uncertainty(
                PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
            ).state,
            UncertaintyState.UNKNOWN,
        )
        callback.assert_not_awaited()
        self.assertNotIn(
            PRODUCT_EVENT_TURN_RECONCILED,
            [event.kind for event in self.events.replay(PRODUCT_SESSION_ID)],
        )

    async def test_runtime_confirmation_drains_without_holding_projection_lock(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.FAILED,
            incident_id="confirmation-applied",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        calls = []

        async def drain():
            async with self.live.ledger.lock:
                calls.append("drain")
            return 0

        async def confirm(target):
            async with self.live.ledger.lock:
                calls.append(target)
            self.assertTrue(self.live.ledger.has_unknown_outcome)
            return self.confirmation_receipt(target)

        driver.drain_observations = drain
        driver.confirm_turn = confirm
        service = self.confirmation_service()
        service.bind_turn_confirmation(
            TurnService(
                {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
            ).confirm_queued_unknown
        )
        result, status = await asyncio.wait_for(
            service.confirm_unknown_turn(
                PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
            ),
            SETTLEMENT_TIMEOUT_SECONDS,
        )
        self.assertEqual(status, 200, result)
        self.assertTrue(result["unknown_outcome"])
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(calls[0], "drain")
        self.assertEqual(calls[1].client_submission_id, VENDOR_TURN_ID)
        self.assertEqual(calls[1].incident_id, unknown.incident_id)
        self.assertEqual(calls[1].process_generation, unknown.process_generation)
        persisted = self.catalog.uncertainty(
            PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
        )
        self.assertEqual(persisted.payload["turn_confirmation"]["ticket_id"], "confirmation-ticket")
        self.assertIn("runtime_event", persisted.payload)

    async def test_runtime_confirmation_failure_is_safe_and_keeps_the_gate(self) -> None:
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN,
            incident=self.incident(
                RuntimeIncidentState.FAILED, retryability=RuntimeRetryability.UNKNOWN_OUTCOME
            ),
        )
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(side_effect=RuntimeError(RAW_VENDOR_SECRET))
        driver.confirm_turn = AsyncMock()
        result, status = await self.confirmation_service().confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 409, result)
        self.assertNotIn(RAW_VENDOR_SECRET, json.dumps(result))
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        driver.confirm_turn.assert_not_awaited()

    async def test_applied_runtime_confirmation_retries_after_durable_failure(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.FAILED,
            incident_id="confirmation-durable-retry",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock(side_effect=self.confirmation_receipt)
        service = self.confirmation_service()
        with patch.object(
            self.catalog, "confirm_turn_uncertainty", side_effect=RuntimeError("write failed")
        ):
            with self.assertRaises(RuntimeError):
                await service.confirm_unknown_turn(
                    PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
                )
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertEqual(
            self.catalog.uncertainty(
                PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
            ).state,
            UncertaintyState.UNKNOWN,
        )
        result, status = await service.confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 200, result)
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(driver.confirm_turn.await_count, 2)
        self.assertEqual(
            driver.confirm_turn.await_args_list[0].args,
            driver.confirm_turn.await_args_list[1].args,
        )

    async def test_confirmed_runtime_retry_cannot_infer_native_proof_from_product_state(
        self,
    ) -> None:
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN,
            incident=self.incident(
                RuntimeIncidentState.FAILED, retryability=RuntimeRetryability.UNKNOWN_OUTCOME
            ),
        )
        self.assertTrue(await self.live.ledger.confirm_unknown_turn(VENDOR_TURN_ID))
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock(
            return_value=SimpleNamespace(state=CommandState.REJECTED, safe_error="unsafe")
        )
        service = self.confirmation_service()
        callback = AsyncMock()
        service.bind_turn_confirmation(callback)
        result, status = await service.confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 409, result)
        driver.confirm_turn.assert_awaited_once()
        callback.assert_not_awaited()

    async def test_runtime_confirmation_rejects_historical_unknown_without_identity(self) -> None:
        await self.live.ledger.record_unknown_submission(VENDOR_TURN_ID, safe_error="unknown")
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock()
        result, status = await self.confirmation_service().confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 409, result)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        driver.confirm_turn.assert_not_awaited()

    async def test_confirmed_retry_republishes_once_and_retries_queue_cleanup(self) -> None:
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN,
            incident=self.incident(
                RuntimeIncidentState.FAILED, retryability=RuntimeRetryability.UNKNOWN_OUTCOME
            ),
        )
        service = self.confirmation_service()
        callback = AsyncMock()
        service.bind_turn_confirmation(callback)
        publish = self.live.ledger.publish
        self.live.ledger.publish = AsyncMock(side_effect=RuntimeError("publication failed"))
        try:
            with self.assertRaises(RuntimeError):
                await service.confirm_unknown_turn(
                    PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
                )
        finally:
            self.live.ledger.publish = publish
        result, status = await service.confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 200, result)
        callback.assert_awaited_once()
        reconciled = [
            event
            for event in self.events.replay(PRODUCT_SESSION_ID)
            if event.kind == PRODUCT_EVENT_TURN_RECONCILED
        ]
        self.assertEqual(len(reconciled), 1)

    async def test_durable_runtime_confirmation_retries_publication_without_native_driver(
        self,
    ) -> None:
        await self.emit(
            RuntimeEventKind.TURN_UNKNOWN,
            incident=self.incident(
                RuntimeIncidentState.FAILED, retryability=RuntimeRetryability.UNKNOWN_OUTCOME
            ),
        )
        self.enable_turn_confirmation()
        driver = self.live.runtime_driver
        session = self.live.runtime_session
        driver.drain_observations = AsyncMock(return_value=0)
        driver.confirm_turn = AsyncMock(side_effect=self.confirmation_receipt)
        service = self.confirmation_service()
        callback = AsyncMock()
        service.bind_turn_confirmation(callback)
        publish = self.live.ledger.publish
        self.live.ledger.publish = AsyncMock(side_effect=RuntimeError("publication failed"))
        try:
            with self.assertRaises(RuntimeError):
                await service.confirm_unknown_turn(
                    PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
                )
        finally:
            self.live.ledger.publish = publish
        reopened = SessionCatalogStore(self.database)
        service._access = reopened
        self.live.ledger = SessionLedger(
            PRODUCT_SESSION_ID,
            reopened,
            self.live.publish,
            self.live._trace,
            self.logger,
            self.live._projection_lock,
            self.live.persistence,
        )
        self.live.runtime_driver = None
        self.live.runtime_session = None
        try:
            result, status = await service.confirm_unknown_turn(
                PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
            )
            self.assertEqual(status, 200, result)
            self.assertTrue(result["unknown_outcome"])
            self.assertNotIn("admission_ready", result)
        finally:
            self.live.runtime_driver = driver
            self.live.runtime_session = session
        driver.confirm_turn.reset_mock()
        driver.drain_observations.reset_mock()
        result, status = await service.confirm_unknown_turn(
            PRODUCT_SESSION_ID, VENDOR_TURN_ID, {"decision": "continue_without_replay"}
        )
        self.assertEqual(status, 200, result)
        driver.confirm_turn.assert_not_awaited()
        driver.drain_observations.assert_not_awaited()
        self.assertEqual(callback.await_count, 2)
        self.assertEqual(
            len(
                [
                    event
                    for event in self.events.replay(PRODUCT_SESSION_ID)
                    if event.kind == PRODUCT_EVENT_TURN_RECONCILED
                ]
            ),
            1,
        )

    async def test_late_turn_started_becomes_the_single_active_admission_fact(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="unknown-late-start",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        await self.emit(
            RuntimeEventKind.TURN_STARTED,
            turn_id="vendor-active-turn",
            payload={
                "process_generation": 3,
                "resolved_ambiguous_incident_id": unknown.incident_id,
            },
        )
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertTrue(self.live.running)
        self.assertEqual(self.live.ledger.active_turn_id, "vendor-active-turn")
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            turn_id="vendor-active-turn",
            payload={"status": "completed", "process_generation": 3},
        )
        self.assertFalse(self.live.running)
        self.assertEqual(self.live.ledger.active_turn_id, "")

    async def test_terminal_conflict_has_both_outcomes_and_generations_in_event_and_trace(
        self,
    ) -> None:
        await self.emit(
            RuntimeEventKind.TURN_COMPLETED,
            payload={"status": "completed", "process_generation": 2},
        )
        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={"safe_error": "late conflict", "process_generation": 3},
        )
        conflict = next(
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind == PRODUCT_EVENT_RUNTIME_INCIDENT
            and row.payload["kind"] == "terminal_conflict"
        )
        self.assertEqual(conflict.payload["existing_outcome"], "completed")
        self.assertEqual(conflict.payload["incoming_outcome"], "failed")
        self.assertEqual(conflict.payload["existing_generation"], 2)
        self.assertEqual(conflict.payload["incoming_generation"], 3)
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        trace_conflict = next(
            row
            for row in trace_rows
            if row["name"] == "runtime.incident.failed"
            and row["attributes"].get("incident_kind") == "terminal_conflict"
        )
        self.assertEqual(trace_conflict["attributes"]["existing_outcome"], "completed")
        self.assertEqual(trace_conflict["attributes"]["incoming_generation"], 3)

    async def test_legacy_runtime_error_defaults_to_non_recoverable(self) -> None:
        await self.emit(
            RuntimeEventKind.RUNTIME_EXTENSION,
            payload={"extension_kind": "runtime_error", "safe_error": "legacy runtime notice"},
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, "runtime_error")
        self.assertFalse(record.payload["recoverable"])

    async def test_product_submission_unknown_is_immediately_confirmable_and_idempotent(
        self,
    ) -> None:
        client_id = "unconfirmed-product-submission"
        terminal_waiter = asyncio.create_task(self.live.ledger.wait_terminal(client_id))
        await asyncio.sleep(0)
        self.assertFalse(terminal_waiter.done())
        self.assertTrue(
            await self.live.ledger.record_unknown_submission(
                client_id, safe_error=TURN_OUTCOME_UNCONFIRMED
            )
        )
        self.assertEqual(await terminal_waiter, PRODUCT_TURN_OUTCOME_UNKNOWN)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        snapshot = self.live.ledger.uncertainty_snapshot()
        self.assertEqual(len(snapshot), 1)
        self.assertEqual(snapshot[0]["kind"], UncertaintyKind.TURN.value)
        self.assertEqual(snapshot[0]["state"], UncertaintyState.UNKNOWN.value)
        self.assertEqual(snapshot[0]["correlation_id"], client_id)
        self.assertEqual(snapshot[0]["safe_error"], TURN_OUTCOME_UNCONFIRMED)
        self.assertFalse(snapshot[0]["retryable"])
        self.assertFalse(
            await self.live.ledger.record_unknown_submission(client_id, safe_error="late")
        )
        self.assertFalse(
            await self.live.ledger.record_turn_failure(client_id, code="late", message="late")
        )
        terminals = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind in {PRODUCT_EVENT_TURN_UNKNOWN, PRODUCT_EVENT_TURN_FAILED}
        ]
        self.assertEqual([row.kind for row in terminals], [PRODUCT_EVENT_TURN_UNKNOWN])
        self.assertEqual(terminals[0].vendor_turn_id, client_id)
        self.assertTrue(await self.live.ledger.confirm_unknown_turn(client_id))
        self.assertFalse(await self.live.ledger.confirm_unknown_turn(client_id))
        self.assertFalse(
            await self.live.ledger.record_unknown_submission(client_id, safe_error="late")
        )
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertEqual(self.live.ledger.uncertainty_snapshot(), [])
        self.assertEqual(
            self.catalog.uncertainty(PRODUCT_SESSION_ID, UncertaintyKind.TURN, client_id).state,
            UncertaintyState.CONFIRMED,
        )

    async def test_product_submission_unknown_preserves_native_terminal_evidence(self) -> None:
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        self.assertFalse(
            await self.live.ledger.record_unknown_submission(VENDOR_TURN_ID, safe_error="late")
        )
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        self.assertIsNone(
            self.catalog.uncertainty(PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID)
        )
        self.assertFalse(
            any(
                row.kind == PRODUCT_EVENT_TURN_UNKNOWN
                for row in self.events.replay(PRODUCT_SESSION_ID)
            )
        )

    async def test_product_submission_unknown_keeps_native_unknown_identity(self) -> None:
        unknown = self.incident(
            RuntimeIncidentState.DETECTED,
            incident_id="native-unknown-kept",
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )
        await self.emit(RuntimeEventKind.TURN_UNKNOWN, incident=unknown)
        previous = self.catalog.uncertainty(
            PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID
        )
        self.assertFalse(
            await self.live.ledger.record_unknown_submission(VENDOR_TURN_ID, safe_error="late")
        )
        self.assertEqual(
            self.catalog.uncertainty(PRODUCT_SESSION_ID, UncertaintyKind.TURN, VENDOR_TURN_ID),
            previous,
        )
        self.assertEqual(
            sum(
                row.kind == PRODUCT_EVENT_TURN_UNKNOWN
                for row in self.events.replay(PRODUCT_SESSION_ID)
            ),
            1,
        )

    async def test_terminal_ledger_is_the_only_live_state_owner(self) -> None:
        for name in (
            "_turn_outcomes",
            "_terminal_waiters",
            "_unknown_admission",
            "_active_vendor_turn_id",
            "_runtime_incidents",
        ):
            self.assertNotIn(name, vars(self.live))
        self.assertIs(self.live.ledger.lock, self.live._projection_lock)
        await self.emit(RuntimeEventKind.TURN_STARTED)
        self.assertEqual(self.live.ledger.active_turn_id, VENDOR_TURN_ID)
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        self.assertFalse(
            await self.live.ledger.record_turn_failure(VENDOR_TURN_ID, code="late", message="late")
        )
        terminals = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind in {PRODUCT_EVENT_TURN_COMPLETED, PRODUCT_EVENT_TURN_FAILED}
        ]
        self.assertEqual([row.kind for row in terminals], [PRODUCT_EVENT_TURN_COMPLETED])
        self.assertEqual(self.live.ledger.active_turn_id, "")

    async def test_terminal_waiter_releases_after_native_and_service_terminal_paths(self) -> None:
        await self.emit(RuntimeEventKind.TURN_STARTED)
        native_waiter = asyncio.create_task(self.live.ledger.wait_terminal(VENDOR_TURN_ID))
        await asyncio.sleep(0)
        self.assertFalse(native_waiter.done())
        await self.emit(RuntimeEventKind.TURN_INTERRUPTED)
        self.assertEqual(await native_waiter, PRODUCT_TURN_OUTCOME_INTERRUPTED)

        failed_turn_id = "service-failed-turn"
        service_waiter = asyncio.create_task(self.live.ledger.wait_terminal(failed_turn_id))
        await asyncio.sleep(0)
        self.assertFalse(service_waiter.done())
        self.assertTrue(
            await self.live.ledger.record_turn_failure(
                failed_turn_id, code="service_failed", message="service failed"
            )
        )
        self.assertEqual(await service_waiter, PRODUCT_TURN_OUTCOME_FAILED)
        self.assertEqual(self.live.ledger._terminal_waiters, {})

    async def test_terminal_waiter_returns_an_already_persisted_outcome(self) -> None:
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        self.assertEqual(await self.live.ledger.wait_terminal(VENDOR_TURN_ID), "completed")
        self.assertEqual(self.live.ledger._terminal_waiters, {})

    async def test_terminal_does_not_create_a_second_review_ledger(self) -> None:
        await self.emit(RuntimeEventKind.TURN_COMPLETED)
        self.assertEqual(self.live.ledger.active_turn_id, "")
        self.assertTrue(
            any(
                row.kind == PRODUCT_EVENT_TURN_COMPLETED
                for row in self.events.replay(PRODUCT_SESSION_ID)
            )
        )
        self.assertFalse(
            any(row.kind == "change_set_ready" for row in self.events.replay(PRODUCT_SESSION_ID))
        )

    async def test_terminal_separates_visible_turn_from_internal_cleanup(self) -> None:
        cleanup = asyncio.create_task(asyncio.Event().wait())
        self.live.current_task = cleanup
        try:
            await self.emit(RuntimeEventKind.TURN_STARTED)
            self.assertTrue(self.live.turn_active)
            await self.emit(RuntimeEventKind.TURN_COMPLETED)
            self.assertFalse(self.live.turn_active)
            self.assertTrue(self.live.running)
        finally:
            cleanup.cancel()
            await asyncio.gather(cleanup, return_exceptions=True)
            self.live.current_task = None

    async def test_proven_empty_open_not_applied_persists_one_final_failure_without_binding_input(
        self,
    ) -> None:
        command_id = "unsubmitted-empty-turn"
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.catalog._store_runtime_binding(connection, self.live.runtime_session.binding, 2.0)
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, command_id, {"content": "original"})
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, command_id)
        self.live.active_product_turn_id = command_id
        proof = EmptyThreadReplacementProof(
            "empty-proof",
            self.catalog.runtime_binding(PRODUCT_SESSION_ID),
            command_id,
            "current-call",
            1,
            2,
            "proof-event",
            1,
            asyncio.get_running_loop().time() + 60,
            1,
        )
        failure = RuntimeTurnNotSubmittedError(proof)
        failure.request = TurnRequest(command_id, ("original",))

        async def not_applied(_proof):
            self.catalog.record_replacement(proof, "revision")
            self.catalog.begin_replacement(proof, "revision", "reservation")
            self.catalog.settle_replacement(
                PRODUCT_SESSION_ID, proof.proof_id, ReplacementState.NOT_APPLIED
            )
            raise RuntimeOpenNotAppliedError("reservation")

        self.live.recover_empty = not_applied
        with (
            patch.object(self.live, "run_runtime", side_effect=failure),
            patch.object(self.live, "bind_user_history", new=AsyncMock()) as bind,
        ):
            result = await TurnService(
                {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
            )._execute(
                self.live,
                TurnInput(
                    (InputItem(InputKind.TEXT, text="original"),), client_user_message_id=command_id
                ),
            )
        self.assertEqual(result.error, RUNTIME_TURN_NOT_SUBMITTED)
        bind.assert_not_awaited()
        queued = self.catalog.queued_message(PRODUCT_SESSION_ID, command_id)
        self.assertIs(queued.state, QueuedMessageState.FAILED)
        self.assertEqual(queued.native_turn_id, "")
        terminals = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind == PRODUCT_EVENT_TURN_FAILED
        ]
        self.assertEqual(len(terminals), 1)
        self.assertEqual(terminals[0].payload["code"], RUNTIME_TURN_NOT_SUBMITTED)

    async def test_manual_replacement_reuses_admitted_fact_and_starts_a_new_checkpoint_epoch(
        self,
    ) -> None:
        command_id = "manual-empty-retry"
        original = self.live.runtime_session.binding
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.catalog._store_runtime_binding(connection, original, 2.0)
        body = {
            "input": [{"type": "text", "text": "original"}],
            "client_user_message_id": command_id,
        }
        self.catalog.enqueue_message(PRODUCT_SESSION_ID, command_id, body)
        self.catalog.begin_queued_submission(PRODUCT_SESSION_ID, command_id)
        await self.live.record_user_history("original", turn_id=command_id, item_id=command_id)
        self.live.last_submission_id = command_id
        proof = EmptyThreadReplacementProof(
            "manual-proof",
            original,
            command_id,
            "first-call",
            1,
            2,
            "proof-event",
            1,
            asyncio.get_running_loop().time() + 60,
            1,
        )
        self.catalog.record_replacement(proof, "revision")
        self.catalog.begin_replacement(proof, "revision", "initial-reservation")
        self.catalog.settle_replacement(
            PRODUCT_SESSION_ID, proof.proof_id, ReplacementState.NOT_APPLIED
        )
        self.catalog.fail_queued_submission(
            PRODUCT_SESSION_ID, command_id, unknown=False, safe_error=RUNTIME_TURN_NOT_SUBMITTED
        )
        candidate = replace(original, opaque_session_ref="manual-replacement")

        async def prepare(live, **_kwargs):
            manual = self.catalog.manual_replacement_proof(PRODUCT_SESSION_ID, command_id)
            self.catalog.begin_replacement(
                manual, "manual-revision", "manual-reservation", manual=True
            )
            self.catalog.settle_replacement(
                PRODUCT_SESSION_ID, proof.proof_id, ReplacementState.OPENING, candidate
            )
            self.catalog.replace_runtime_binding(
                original, candidate, proof=manual, revision="manual-revision", manual=True
            )
            live.runtime_session.binding = candidate
            live.runtime_binding = candidate
            live.vendor_thread_id = candidate.opaque_session_ref
            live._local_history = []

        turns = TurnService(
            {PRODUCT_SESSION_ID: self.live},
            self.logger,
            activities=Activities(),
            prepare=prepare,
            catalog=self.catalog,
            events=self.events,
        )
        self.addAsyncCleanup(turns.aclose)
        turns.recovery.bind_quiescence(AsyncMock())
        await turns.recovery.begin(self.live, command_id)
        previous = turns.recovery._checkpoints[PRODUCT_SESSION_ID]
        previous.sealed = True
        admitted = self.events.by_key(PRODUCT_SESSION_ID, f"service:user:{command_id}")
        with patch.object(
            turns,
            "_execute",
            new=AsyncMock(return_value=TurnResult(command_id, TurnStatus.COMPLETED)),
        ) as execute:
            response, status = await turns.send_queued(PRODUCT_SESSION_ID, command_id)
            self.assertEqual(status, 202, response)
            await asyncio.wait_for(self.live.resource_task, 2)
        execute.assert_awaited_once()
        self.assertEqual(
            self.events.by_key(PRODUCT_SESSION_ID, f"service:user:{command_id}"), admitted
        )
        self.assertTrue(previous.sealed)
        successor = turns.recovery._checkpoints[PRODUCT_SESSION_ID]
        self.assertIsNot(successor, previous)
        self.assertTrue(successor.epoch)
        self.assertEqual(successor.payload["native_session_id"], "manual-replacement")
        self.assertEqual(
            len([row for row in self.live._local_history if row.get("item_id") == command_id]), 1
        )

    async def test_turn_execution_exception_does_not_publish_fake_recovery(self) -> None:
        original = self.live.runtime_session.fail_submission
        self.live.runtime_session.fail_submission = True
        try:
            result = await TurnService(
                {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
            )._execute(
                self.live,
                TurnInput(
                    items=(InputItem(InputKind.TEXT, text="contract"),),
                    client_user_message_id="client-turn-contract",
                ),
            )
        finally:
            self.live.runtime_session.fail_submission = original
        self.assertEqual(result.status, TurnStatus.FAILED)
        records = self.events.replay(PRODUCT_SESSION_ID)
        self.assertEqual([record.kind for record in records], [PRODUCT_EVENT_TURN_FAILED])
        self.assertEqual(records[0].vendor_turn_id, "client-turn-contract")

    async def test_execution_failure_settles_native_turn_before_broadcast(self) -> None:
        await self.emit(RuntimeEventKind.TURN_STARTED)
        self.live.runtime_session.fail_submission = True
        published_active_turns = []
        publish = self.live.ledger.publish

        async def observe_publish(kind, payload, **kwargs):
            if kind == PRODUCT_EVENT_TURN_FAILED:
                published_active_turns.append(self.live.ledger.active_turn_id)
            return await publish(kind, payload, **kwargs)

        self.live.ledger.publish = observe_publish
        result = await TurnService(
            {PRODUCT_SESSION_ID: self.live}, self.logger, activities=Activities()
        )._execute(
            self.live,
            TurnInput(
                items=(InputItem(InputKind.TEXT, text="contract"),),
                client_user_message_id="different-client-turn",
            ),
        )
        self.assertEqual(result.turn_id, VENDOR_TURN_ID)
        self.assertEqual(result.status, TurnStatus.FAILED)
        self.assertEqual(published_active_turns, [""])
        self.assertFalse(self.live.turn_active)
        record = self.catalog.get(PRODUCT_SESSION_ID)
        self.assertEqual(record.last_turn_id, VENDOR_TURN_ID)
        self.assertEqual(record.status, SessionStatus.ERROR)
        terminals = [
            row
            for row in self.events.replay(PRODUCT_SESSION_ID)
            if row.kind == PRODUCT_EVENT_TURN_FAILED
        ]
        self.assertEqual([row.vendor_turn_id for row in terminals], [VENDOR_TURN_ID])
        self.assertFalse(
            await self.live.ledger.record_turn_failure(VENDOR_TURN_ID, code="late", message="late")
        )

    async def test_turn_failure_preserves_provider_code_retryability_and_trace_status(self) -> None:
        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={
                "error_code": "insufficient_quota",
                "safe_error": "You exceeded your current quota.",
                "retryability": RuntimeRetryability.TERMINAL.value,
                "process_generation": 2,
            },
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_TURN_FAILED)
        self.assertEqual(record.payload["code"], "insufficient_quota")
        self.assertEqual(record.payload["message"], "You exceeded your current quota.")
        self.assertFalse(record.payload["retryable"])
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        runtime_failure = next(row for row in trace_rows if row["name"] == "codex.turn.failed")
        product_failure = next(
            row for row in trace_rows if row["name"] == "scholarseed.product.turn_failed"
        )
        self.assertEqual(runtime_failure["status"], "error")
        self.assertEqual(runtime_failure["error"]["code"], "insufficient_quota")
        self.assertEqual(product_failure["status"], "error")
        self.assertEqual(product_failure["error"]["code"], "insufficient_quota")

    async def test_model_bridge_terminal_failure_enriches_same_turn_runtime_failure(self) -> None:
        client_turn_id = "client-content-safety-turn"
        self.live.active_product_turn_id = client_turn_id
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "downstream": {
                    "terminal_event": "response.failed",
                    "error_code": CONTENT_SAFETY_BLOCKED,
                },
            }
        )

        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={
                "error_code": "codex_provider_failed",
                "safe_error": "The model provider rejected the request.",
                "retryability": RuntimeRetryability.USER_RETRYABLE.value,
            },
        )
        await self.settle_pending(client_turn_id)

        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_TURN_FAILED)
        self.assertEqual(record.payload["code"], CONTENT_SAFETY_BLOCKED)
        self.assertEqual(record.payload["message"], CONTENT_SAFETY_MESSAGE)
        self.assertFalse(record.payload["retryable"])

    async def test_exhausted_bridge_retry_count_reaches_product_failure(self) -> None:
        client_turn_id = "client-transient-failure-turn"
        self.live.active_product_turn_id = client_turn_id
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "status_code": 500,
                "attempt": 3,
                "max_attempts": 3,
                "downstream": {},
            }
        )

        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={
                "error_code": "codex_provider_failed",
                "safe_error": "The model provider rejected the request.",
                "retryability": RuntimeRetryability.USER_RETRYABLE.value,
            },
        )
        await self.settle_pending(client_turn_id)

        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_TURN_FAILED)
        self.assertEqual(record.payload["code"], TRANSIENT_PROVIDER_FAILURE_CODE)
        self.assertEqual(record.payload["message"], TRANSIENT_PROVIDER_FAILURE_MESSAGE)
        self.assertTrue(record.payload["retryable"])
        self.assertEqual(record.payload["automatic_retry_attempts"], 3)

    async def test_http_rate_limit_reaches_product_failure(self) -> None:
        client_turn_id = "client-rate-limit-turn"
        self.live.active_product_turn_id = client_turn_id
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "status_code": 429,
                "http_error_code": "rate_limit_exceeded",
                "attempt": 3,
                "max_attempts": 3,
                "downstream": {},
            }
        )
        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={
                "error_code": "codex_provider_failed",
                "safe_error": "The model provider rejected the request.",
                "retryability": RuntimeRetryability.USER_RETRYABLE.value,
            },
        )
        await self.settle_pending(client_turn_id)
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_TURN_FAILED)
        self.assertEqual(record.payload["code"], "rate_limit_exceeded")
        self.assertTrue(record.payload["retryable"])
        self.assertEqual(record.payload["automatic_retry_attempts"], 3)

    async def test_later_same_turn_bridge_result_replaces_stale_content_failure(self) -> None:
        client_turn_id = "client-retried-turn"
        self.live.active_product_turn_id = client_turn_id
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "downstream": {
                    "terminal_event": "response.failed",
                    "error_code": CONTENT_SAFETY_BLOCKED,
                },
            }
        )
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "downstream": {
                    "terminal_event": "response.failed",
                    "error_code": "different_terminal_failure",
                },
            }
        )

        await self.emit(
            RuntimeEventKind.TURN_FAILED,
            payload={
                "error_code": "codex_provider_failed",
                "safe_error": "The model provider rejected the request.",
                "retryability": RuntimeRetryability.USER_RETRYABLE.value,
            },
        )
        await self.settle_pending(client_turn_id)

        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.payload["code"], "codex_provider_failed")
        self.assertEqual(record.payload["message"], "The model provider rejected the request.")
        self.assertTrue(record.payload["retryable"])

    def _reject_diagnostic(self, client_turn_id: str) -> None:
        self.live.trace_completion(
            {
                "client_user_message_id": client_turn_id,
                "phase": "finished",
                "downstream": {
                    "terminal_event": "response.failed",
                    "error_code": "InvalidParameter",
                    "error_message": "Unsupported model: 'minimax-m2.1'",
                },
            }
        )

    async def test_provider_incident_backfills_recovered_error_code(self) -> None:
        """Codex 拍平码后，bridge 恢复的真实上游码回填到 retrying incident 投影。"""

        client_turn_id = "client-rejected-turn"
        self.live.active_product_turn_id = client_turn_id
        self._reject_diagnostic(client_turn_id)
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(RuntimeIncidentState.RETRYING),
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_RUNTIME_INCIDENT)
        self.assertEqual(record.payload["provider_error_code"], "InvalidParameter")
        self.assertEqual(record.payload["provider_http_status"], 400)

    async def test_incident_backfill_requires_same_active_turn(self) -> None:
        """活跃轮切走后才到的 incident 不能被上一轮恢复出的归因污染。"""

        self.live.active_product_turn_id = "turn-a"
        self._reject_diagnostic("turn-a")
        self.live.active_product_turn_id = "turn-b"
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(RuntimeIncidentState.RETRYING),
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertNotIn("provider_error_code", record.payload)

    async def test_incident_backfill_tolerates_late_diagnostic(self) -> None:
        """诊断晚于 incident 到达：incident 保持无归因，不阻塞、不报错（终态另行恢复）。"""

        self.live.active_product_turn_id = "client-late-turn"
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(RuntimeIncidentState.RETRYING),
        )
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertNotIn("provider_error_code", record.payload)

    async def test_incident_backfill_preserves_existing_specific_code(self) -> None:
        """incident 已带具体上游码（Codex 白名单放行的）时，bridge 恢复不覆盖它。"""

        client_turn_id = "client-specific-turn"
        self.live.active_product_turn_id = client_turn_id
        self._reject_diagnostic(client_turn_id)
        specific = replace(
            self.incident(RuntimeIncidentState.RETRYING),
            provider_error_code="rate_limit_exceeded",
            provider_http_status=429,
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=specific)
        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.payload["provider_error_code"], "rate_limit_exceeded")
        self.assertEqual(record.payload["provider_http_status"], 429)

    async def test_failed_incident_is_an_error_but_recovery_states_are_not(self) -> None:
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(RuntimeIncidentState.RETRYING),
        )
        await self.emit(
            RuntimeEventKind.RUNTIME_INCIDENT,
            incident=self.incident(
                RuntimeIncidentState.FAILED,
                retryability=RuntimeRetryability.TERMINAL,
            ),
        )
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        retrying = [row for row in trace_rows if row["name"] == "runtime.incident.retrying"]
        failed = [row for row in trace_rows if row["name"] == "runtime.incident.failed"]
        self.assertTrue(retrying)
        self.assertTrue(all(row["status"] == "ok" for row in retrying))
        self.assertTrue(failed)
        self.assertTrue(all(row["status"] == "error" for row in failed))

    async def test_unsupported_notification_is_observable_without_becoming_first_error(
        self,
    ) -> None:
        incident = replace(
            self.incident(RuntimeIncidentState.FAILED),
            scope=RuntimeIncidentScope.CAPABILITY,
            kind=RuntimeIncidentKind.UNSUPPORTED_NOTIFICATION,
            safe_error="unsupported_notification",
        )
        await self.emit(RuntimeEventKind.RUNTIME_INCIDENT, incident=incident)
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        unsupported = [
            row
            for row in trace_rows
            if row["attributes"].get("incident_kind") == "unsupported_notification"
        ]
        self.assertTrue(unsupported)
        self.assertTrue(all(row["status"] == "ok" for row in unsupported))

    def test_readiness_projects_supervisor_progress(self) -> None:
        payload = readiness_payload(
            RuntimeReadiness(
                runtime_id=RUNTIME_ID,
                status=RuntimeStatus.READY,
                ready=True,
                process_generation=7,
                recovery_attempt=2,
                max_recovery_attempts=5,
            )
        )
        self.assertEqual(payload["process_generation"], 7)
        self.assertEqual(payload["recovery_attempt"], 2)
        self.assertEqual(payload["max_recovery_attempts"], 5)

    async def test_runtime_control_evidence_is_traceable_and_health_safe(self) -> None:
        control = _EvidenceControl()
        await self.emit(
            RuntimeEventKind.RUNTIME_EVIDENCE,
            payload={
                "process": [asdict(row) for row in control.process_events],
                "rpc": [asdict(row) for row in control.rpc_evidence],
            },
        )
        snapshot = self.live.runtime_evidence_snapshot()
        self.assertEqual(snapshot["last_evidence_seq"], 2)
        self.assertEqual(snapshot["process"][0]["process_generation"], 9)
        self.assertEqual(snapshot["rpc"][0]["latency_ms"], 37)
        trace_path = self.root / "trace" / f"scholarseed-codex-{PRODUCT_SESSION_ID}.jsonl"
        trace_rows = [
            json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines()
        ]
        self.assertIn("runtime.process.started", [row["name"] for row in trace_rows])
        rpc = next(row for row in trace_rows if row["name"] == "runtime.rpc.success")
        self.assertEqual(rpc["attributes"]["rpc_latency_ms"], 37)
        self.assertEqual(
            next(row for row in trace_rows if row["name"] == "runtime.process.started")[
                "attributes"
            ]["executable"],
            "codex",
        )


if __name__ == "__main__":
    unittest.main()
