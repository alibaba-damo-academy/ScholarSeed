"""Contract for typed runtime incidents and monotonic turn outcomes."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

from scholarseed_runtime.contract import (
    CapabilitySet,
    CommandReceipt,
    CommandState,
    DeliveryClass,
    RuntimeBinding,
    RuntimeEvent,
    RuntimeEventKind,
    RuntimeInventory,
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.evidence import (
    RuntimeProcessEvent,
    RuntimeProcessEventKind,
    RuntimeRpcEvidence,
)
from scholarseed_runtime.contract.history import ResumeTurnSnapshot, TurnStatus
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from service.capabilities.service.skills import SkillCatalog
from service.chat.active import RUNTIME_ID
from service.chat.constants import (
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
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.incidents import event_incident, incident_data
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import readiness_payload
from service.chat.service.rejections import (
    TRANSIENT_PROVIDER_FAILURE_CODE,
    TRANSIENT_PROVIDER_FAILURE_MESSAGE,
)
from service.chat.service.streams import CONTENT_SAFETY_BLOCKED, CONTENT_SAFETY_MESSAGE
from service.chat.service.turns import TurnService

PRODUCT_SESSION_ID = "runtime-incident-session"
VENDOR_THREAD_ID = "runtime-incident-thread"
VENDOR_TURN_ID = "runtime-incident-turn"
RAW_VENDOR_SECRET = "raw-vendor-secret-must-not-be-persisted"
OWNER = SessionPrincipal("runtime-incident-owner")


class _Adapter:
    runtime_id = RUNTIME_ID

    def __init__(
        self,
        resume_turns: tuple[ResumeTurnSnapshot, ...] = (),
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
        self.queue = asyncio.Queue()
        self.sequence = 0
        self.fail_submission = False

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
    async def asyncSetUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="runtime-incidents-")
        self.root = Path(self._temporary.name)
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
        self.live.attach_gateway(_Adapter(), resumed=False)
        await self.live.activate()
        self.vendor_seq = 0

    async def asyncTearDown(self) -> None:
        await self.live.aclose()
        self._temporary.cleanup()

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
        rejected, status = await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger).post(
            PRODUCT_SESSION_ID,
            {"input": [{"type": "text", "text": "must remain paused"}]},
            side=False,
        )
        self.assertEqual(status, 409)
        self.assertEqual(rejected["error"], TURN_OUTCOME_UNCONFIRMED)

        original = self.live.runtime_session.fail_submission
        self.live.runtime_session.fail_submission = True
        try:
            await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)._execute(
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

        result, status = await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger).post(
            PRODUCT_SESSION_ID,
            {"wait": True, "input": [{"type": "text", "text": "continue after recovery"}]},
            side=False,
        )
        self.assertEqual(status, 202)
        self.assertTrue(result["ok"])

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
        turns = TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)
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
                        turn_id="official-turn-id",
                        terminal_status=TurnStatus.COMPLETED,
                    ),
                )
            ),
            resumed=True,
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
            self.assertEqual([row.vendor_turn_id for row in completed], ["official-turn-id"])
        finally:
            await restarted.aclose()

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
                turn_id="late-active-turn",
                terminal_status=None,
            ),
        )
        await self.live.reconcile_resumed_turns()
        self.assertTrue(self.live.running)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        rejected, status = await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger).post(
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
            turn_id="late-active-turn",
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

    async def test_turn_execution_exception_does_not_publish_fake_recovery(self) -> None:
        original = self.live.runtime_session.fail_submission
        self.live.runtime_session.fail_submission = True
        try:
            result = await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)._execute(
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
        result = await TurnService({PRODUCT_SESSION_ID: self.live}, self.logger)._execute(
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

        record = self.events.replay(PRODUCT_SESSION_ID)[-1]
        self.assertEqual(record.kind, PRODUCT_EVENT_TURN_FAILED)
        self.assertEqual(record.payload["code"], TRANSIENT_PROVIDER_FAILURE_CODE)
        self.assertEqual(record.payload["message"], TRANSIENT_PROVIDER_FAILURE_MESSAGE)
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
