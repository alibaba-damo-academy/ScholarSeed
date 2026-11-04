"""Crash continuation gates with real stores; fixtures are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI

from scholarseed_codex.capacity import CapacityPolicy
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import (
    CapabilitySet,
    CapabilityState,
    RuntimeCapability,
)
from scholarseed_runtime.contract.command import CommandState, ThreadReplacementProof
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from scholarseed_runtime.contract.model import ModelWireProtocol
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RuntimeActivitySnapshot,
    ThreadReplacementReceipt,
    ThreadReplacementTarget,
    ThreadReplacementTicket,
)
from service.chat.api.sessions import mount_session_routes
from service.chat.constants import (
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_PLAN_SNAPSHOT,
    PRODUCT_EVENT_REASONING_DELTA,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_SUBAGENT_COMPLETED,
    PRODUCT_EVENT_TOOL_COMPLETED,
    PRODUCT_EVENT_TOOL_OUTPUT_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_SESSION_STATE_IDLE,
    PRODUCT_TURN_OUTCOME_UNKNOWN,
)
from service.chat.persistence import blocks, journal
from service.chat.persistence.catalog import (
    QUEUE_PURPOSE_RECOVERY,
    QueuedMessageState,
    ReplacementKind,
    ReplacementState,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.worker import PersistenceWorker
from service.chat.runtime.activation import SessionActivationError
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.incidents import event_incident, incident_data
from service.chat.runtime.ledger import SessionLedger
from service.chat.runtime.live import LiveSession
from service.chat.runtime.projection import queued_message_payload
from service.chat.service.completions import (
    CompletionAuthority,
    CompletionBridge,
    CompletionCall,
    CompletionStream,
    chat_stream_to_responses,
)
from service.chat.service.recovery import (
    READ_ONLY_WEB_SEARCH,
    RECOVERY_CLAIMED,
    RECOVERY_EXPOSED,
    RECOVERY_PREPARED,
    RECOVERY_REBUILD,
    RECOVERY_REBUILD_PROOF,
    RECOVERY_SOURCE,
    RECOVERY_STALE,
    RecoveryAction,
    RecoveryService,
    recovery_key,
    safe_model_output,
    safe_model_request,
)
from service.chat.service.sessions import SessionService
from service.chat.service.streams import SSE_BUFFER_LIMIT, CompletionDiagnostic
from service.chat.service.turns import TurnAdmission, TurnResult, TurnService
from service.platform.activity import Activities

SESSION_ID = "continuation-session"
CLIENT_ID = "original-client"
NATIVE_ID = "original-native-turn"
THREAD_ID = "original-native-thread"
TRUSTED_RESPONSES = "https://gateway.example/v1/responses"
READ_ONLY_TOOLS = frozenset({READ_ONLY_WEB_SEARCH})


def sse(payload):
    return b"data: " + json.dumps(payload).encode() + b"\n\n"


class ModelOutputContracts(unittest.TestCase):
    def test_read_only_search_requires_external_authority_not_request_claims(self):
        payload = {"tools": [{"type": READ_ONLY_WEB_SEARCH}], "trusted": True}
        self.assertFalse(safe_model_request(payload))
        self.assertTrue(safe_model_request(payload, READ_ONLY_TOOLS))
        self.assertTrue(
            safe_model_request(
                {**payload, "tool_choice": {"type": READ_ONLY_WEB_SEARCH}}, READ_ONLY_TOOLS
            )
        )

    def test_read_only_search_rejects_unknown_parameters_and_hosted_tools(self):
        for declaration in (
            {"type": READ_ONLY_WEB_SEARCH, "actions": ["write"]},
            {"type": READ_ONLY_WEB_SEARCH, "filters": {"mcp": "unknown"}},
            {"type": READ_ONLY_WEB_SEARCH, "search_context_size": []},
            {"type": READ_ONLY_WEB_SEARCH, "user_location": {"type": "unknown"}},
            {"type": READ_ONLY_WEB_SEARCH, "external_web_access": "true"},
            {"type": "mcp"},
            {"type": "future_tool"},
            {"type": []},
            {"type": "namespace", "name": "functions", "tools": [{"type": READ_ONLY_WEB_SEARCH}]},
        ):
            with self.subTest(declaration=declaration):
                self.assertFalse(safe_model_request({"tools": [declaration]}, READ_ONLY_TOOLS))
        self.assertFalse(
            safe_model_request(
                {"tools": [{"type": READ_ONLY_WEB_SEARCH}, {"type": "mcp"}]}, READ_ONLY_TOOLS
            )
        )

    def test_read_only_search_does_not_waive_any_tool_output_guard(self):
        for kind in ("web_search_call", "function_call", "custom_tool_call", "mcp_call"):
            self.assertFalse(
                safe_model_output(
                    sse(
                        {
                            "type": "response.output_item.added",
                            "item": {"type": kind, "name": "web_search"},
                        }
                    )
                )
            )

    def test_bridge_created_prelude_does_not_authorize_a_tool(self):
        self.assertTrue(
            safe_model_output(sse({"type": "response.created", "response": {"id": "response"}}))
        )

    def test_provider_execution_authority_is_unsafe_before_any_output(self):
        self.assertTrue(safe_model_request({"tools": [{"type": "function", "name": "client"}]}))
        for payload in (
            {"tools": [{"type": "web_search"}]},
            {"tools": [{"type": "future_tool"}]},
            {"tools": [None]},
            {"tools": None},
            {"background": True},
            {"tool_choice": {"type": "web_search"}},
        ):
            with self.subTest(payload=payload):
                self.assertFalse(safe_model_request(payload))

    def test_client_tool_namespaces_do_not_grant_provider_execution_authority(self):
        self.assertTrue(
            safe_model_request(
                {
                    "tools": [
                        {
                            "type": "namespace",
                            "name": "functions",
                            "tools": [
                                {"type": "function", "name": "read"},
                                {"type": "custom", "name": "patch"},
                            ],
                        }
                    ]
                }
            )
        )
        for child in ({"type": "web_search"}, {"type": "mcp"}, {"type": "unknown"}, None):
            self.assertFalse(
                safe_model_request(
                    {"tools": [{"type": "namespace", "name": "functions", "tools": [child]}]}
                )
            )
        self.assertFalse(safe_model_request({"tools": [{"type": "namespace"}]}))

    def test_text_and_reasoning_are_safe(self):
        for payload in (
            {"type": "response.output_text.delta", "delta": "function_call is literal text"},
            {"type": "response.reasoning_summary_text.delta", "delta": "thinking"},
            {
                "type": "response.output_item.done",
                "item": {"type": "message", "content": [{"type": "output_text", "text": "ok"}]},
            },
            {"type": "response.completed", "response": {"output": []}},
        ):
            with self.subTest(payload=payload):
                self.assertTrue(safe_model_output(sse(payload)))
        self.assertTrue(safe_model_output(b"data: [DONE]\n\n"))
        self.assertTrue(safe_model_output(b'{"object":"response","output":[]}'))

    def test_tool_unknown_partial_and_oversized_outputs_are_unsafe(self):
        for body in (
            sse(
                {
                    "type": "response.output_item.added",
                    "item": {"type": "function_call", "name": "exec_command"},
                }
            ),
            sse({"type": "future.output", "data": "unknown"}),
            b'data: {"type":"response.output_text.delta"}',
            b"data: invalid\n\n",
            b"event: ping\n\n",
            b"\xff",
            b"x" * (SSE_BUFFER_LIMIT + 1),
            b'{"object":"response","output":[{"type":"custom_tool_call"}]}',
            sse(
                {"type": "response.completed", "response": {"output": [{"type": "function_call"}]}}
            ),
        ):
            with self.subTest(body=body[:80]):
                self.assertFalse(safe_model_output(body))


class BridgeProtocolContracts(unittest.IsolatedAsyncioTestCase):
    async def test_authority_uses_exact_actual_destination_and_protocol(self):
        bridge = CompletionBridge(
            "http://127.0.0.1", retryable_tool_endpoints={TRUSTED_RESPONSES: READ_ONLY_TOOLS}
        )
        self.addAsyncCleanup(bridge.close)
        registration = bridge.register(
            endpoint=TRUSTED_RESPONSES,
            responses_endpoint="https://untrusted.example/responses",
            api_key="contract-only",
            wire_protocol=ModelWireProtocol.RESPONSES,
        )
        upstream = bridge._upstreams[registration.bridge_id]
        for endpoint in (
            upstream.responses_endpoint,
            TRUSTED_RESPONSES + "?trusted=true",
            TRUSTED_RESPONSES + "/child",
            TRUSTED_RESPONSES.replace("/responses", "/../responses"),
            TRUSTED_RESPONSES.replace("https://", "http://"),
        ):
            self.assertFalse(
                bridge._request_authority(
                    upstream, endpoint, ModelWireProtocol.RESPONSES
                ).retryable_tools
            )
        self.assertFalse(
            bridge._request_authority(
                upstream, TRUSTED_RESPONSES, ModelWireProtocol.CHAT_COMPLETIONS
            ).retryable_tools
        )
        authority = bridge._request_authority(
            upstream, TRUSTED_RESPONSES, ModelWireProtocol.RESPONSES
        )
        self.assertEqual(authority.retryable_tools, READ_ONLY_TOOLS)
        self.assertTrue(authority.current())
        upstream.responses_endpoint = "https://changed.example/responses"
        self.assertFalse(authority.current())

    async def test_even_a_redirecting_client_cannot_forward_authority_to_another_endpoint(self):
        requests = []

        async def upstream(request):
            requests.append(str(request.url))
            return httpx.Response(302, headers={"Location": "https://untrusted.example/responses"})

        bridge = CompletionBridge(
            "http://127.0.0.1", retryable_tool_endpoints={TRUSTED_RESPONSES: READ_ONLY_TOOLS}
        )
        self.addAsyncCleanup(bridge.close)
        bridge._clients[False] = httpx.AsyncClient(
            transport=httpx.MockTransport(upstream), follow_redirects=True
        )
        registration = bridge.register(
            endpoint=TRUSTED_RESPONSES,
            responses_endpoint=TRUSTED_RESPONSES,
            api_key="contract-only",
            wire_protocol=ModelWireProtocol.RESPONSES,
        )
        response = await bridge.forward(
            registration.bridge_id,
            {"model": "model", "tools": [{"type": READ_ONLY_WEB_SEARCH}], "input": "inspect"},
        )
        self.assertEqual(requests, [TRUSTED_RESPONSES])
        self.assertIsNotNone(response)

    async def test_real_converter_text_and_reasoning_frames_remain_safe(self):
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "inspect safely"}}]},
            {"choices": [{"delta": {"content": "Read only."}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ]
        response = httpx.Response(200, content=b"".join(sse(chunk) for chunk in chunks))
        frames = [frame async for frame in chat_stream_to_responses(response)]
        self.assertTrue(frames)
        for frame in frames:
            self.assertTrue(safe_model_output(frame), frame)

    async def test_real_converter_tool_frames_are_not_a_text_safety_proof(self):
        response = httpx.Response(
            200,
            content=sse(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call",
                                        "function": {"name": "read", "arguments": "{}"},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                }
            ),
        )
        frames = [frame async for frame in chat_stream_to_responses(response)]
        self.assertTrue(safe_model_output(frames[0]))
        self.assertTrue(any(not safe_model_output(frame) for frame in frames))


class ContinuationContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="continuation-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.catalog.register(
            SESSION_ID,
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id=THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="contract",
            model_id="model",
            policy_id="ask",
            status=SessionStatus.READY,
            title="original task",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.root / "sessions.sqlite3")
        self.activities = Activities()
        self.callback = AsyncMock()
        self.runtime = SimpleNamespace(
            binding=SimpleNamespace(
                capabilities=CapabilitySet(
                    (RuntimeCapability("turn_admission", CapabilityState.SUPPORTED),)
                )
            ),
            activity=AsyncMock(
                return_value=RuntimeActivitySnapshot("generation-2", 1, 12, True, (), True)
            ),
            snapshot=AsyncMock(
                return_value={
                    "resume_turns": [
                        {
                            "client_id": CLIENT_ID,
                            "turn_id": NATIVE_ID,
                            "terminal_status": "interrupted",
                        }
                    ]
                }
            ),
        )

        async def persist(operation, *arguments, **keywords):
            return operation(*arguments, **keywords)

        async def publish(kind, payload, *, turn_id="", idempotency_key="", **_kwargs):
            return self.events.append(
                session_id=SESSION_ID,
                runtime_id="codex",
                vendor_thread_id=self.live.vendor_thread_id,
                vendor_turn_id=turn_id or None,
                vendor_item_id=None,
                kind=kind,
                payload=dict(payload),
                idempotency_key=idempotency_key,
            )

        self.live = SimpleNamespace(
            id=SESSION_ID,
            catalog=self.catalog,
            runtime_session=self.runtime,
            vendor_thread_id=THREAD_ID,
            model_id="model",
            user_id="owner",
            interrupt_generation=0,
            last_submission_id=CLIENT_ID,
            current_task=None,
            resource_task=None,
            waiting_request_id="",
            running=False,
            interrupting=False,
            closing=False,
            terminating=False,
            terminated=False,
            lifecycle_lock=asyncio.Lock(),
            ledger=SimpleNamespace(
                active_turn_id=NATIVE_ID, uncertainty_snapshot=Mock(return_value=[])
            ),
            pending_hil_snapshot=Mock(return_value=[]),
            trace_resource=Mock(),
            publish=publish,
            persistence=SimpleNamespace(run=persist),
            reconcile_resumed_turns=AsyncMock(),
        )
        self.sessions = {SESSION_ID: self.live}
        self.recovery = RecoveryService(
            self.sessions, self.events, self.activities, logging.getLogger(__name__), self.callback
        )
        self.recovery.bind_quiescence(AsyncMock())
        self.addAsyncCleanup(self.recovery.aclose)
        await publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {"text": "original", "client_turn_id": CLIENT_ID},
            turn_id=CLIENT_ID,
            idempotency_key="original-user",
        )
        await self.recovery.begin(self.live, CLIENT_ID)
        await self.recovery.before_output(SESSION_ID, CLIENT_ID, b"")

    def event(self, state, generation):
        incident = RuntimeIncident(
            "incident",
            RuntimeIncidentScope.PROCESS,
            state,
            RuntimeIncidentKind.PROCESS_EXIT,
            RuntimeRecoveryStrategy.AUTO_RESTART,
            RuntimeRetryability.IN_PROGRESS,
            "agent_runtime_exit",
            process_generation=generation,
            vendor_thread_id=THREAD_ID,
            vendor_turn_id=NATIVE_ID,
        )
        return RuntimeEvent(
            1,
            f"event-{state.value}",
            "codex",
            SESSION_ID,
            THREAD_ID,
            generation,
            1,
            RuntimeEventKind.RUNTIME_INCIDENT,
            DeliveryClass.MUST_PERSIST,
            "",
            native_turn_id=NATIVE_ID,
            payload={"incident": incident_data(incident)},
        )

    async def recover(self):
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.RECOVERED, 2))
        await asyncio.gather(*tuple(self.recovery._tasks.values()))

    async def test_failed_thread_resume_schedules_one_context_rebuild(self):
        self.recovery._rebuild = AsyncMock()
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        process_event = self.event(RuntimeIncidentState.FAILED, 2)
        incident = replace(
            event_incident(process_event),
            incident_id="missing-thread",
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
            safe_error="codex_thread_history_missing",
        )
        missing = replace(process_event, payload={"incident": incident_data(incident)})
        await self.recovery.observe(self.live, missing)
        await self.recovery.observe(self.live, missing)
        await asyncio.gather(*tuple(self.recovery._tasks.values()))
        self.recovery._rebuild.assert_awaited_once()

    async def test_unsealed_thread_resume_failure_does_not_replace_a_live_thread(self):
        self.recovery._rebuild = AsyncMock()
        event = self.event(RuntimeIncidentState.FAILED, 2)
        incident = replace(
            event_incident(event),
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
            safe_error="codex_thread_history_missing",
        )
        await self.recovery.observe(
            self.live, replace(event, payload={"incident": incident_data(incident)})
        )
        self.recovery._rebuild.assert_not_awaited()

    async def assert_idle_checkpoint_does_not_rebuild(self, state):
        if state is not None:
            self.catalog.enqueue_message(SESSION_ID, CLIENT_ID, {"content": "original"})
            self.catalog.begin_queued_submission(SESSION_ID, CLIENT_ID)
            if state is QueuedMessageState.COMPLETED:
                self.catalog.complete_queued_message(SESSION_ID, CLIENT_ID)
            else:
                self.catalog.fail_queued_submission(
                    SESSION_ID, CLIENT_ID, unknown=False, safe_error="previous failure"
                )
        self.live.rebuild_thread = AsyncMock(
            side_effect=AssertionError("idle checkpoints must not prepare a replacement")
        )
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        failed = self.event(RuntimeIncidentState.FAILED, 2)
        incident = replace(
            event_incident(failed),
            incident_id="missing",
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
        )
        await self.recovery.observe(
            self.live, replace(failed, payload={"incident": incident_data(incident)})
        )
        await asyncio.gather(*tuple(self.recovery._tasks.values()))
        self.live.rebuild_thread.assert_not_awaited()
        self.assertIsNone(self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_REBUILD)))
        if state is not None:
            self.assertIs(self.catalog.queued_message(SESSION_ID, CLIENT_ID).state, state)

    async def test_completed_checkpoint_does_not_rebuild_an_idle_thread(self):
        await self.assert_idle_checkpoint_does_not_rebuild(QueuedMessageState.COMPLETED)

    async def test_failed_checkpoint_does_not_rebuild_an_idle_thread(self):
        await self.assert_idle_checkpoint_does_not_rebuild(QueuedMessageState.FAILED)

    async def test_checkpoint_without_a_source_queue_does_not_rebuild_an_idle_thread(self):
        await self.assert_idle_checkpoint_does_not_rebuild(None)

    async def configure_thread_rebuild(self):
        persistence = PersistenceWorker(session_id=SESSION_ID)
        self.addAsyncCleanup(persistence.close)
        self.live.persistence = persistence

        async def publish(kind, payload, *, turn_id="", idempotency_key="", **_kwargs):
            return await persistence.run(
                self.events.append,
                session_id=SESSION_ID,
                runtime_id="codex",
                vendor_thread_id=self.live.vendor_thread_id,
                vendor_turn_id=turn_id or None,
                vendor_item_id=None,
                kind=kind,
                payload=dict(payload),
                idempotency_key=idempotency_key,
            )

        self.live.publish = publish
        original = RuntimeBinding(
            SESSION_ID,
            "codex",
            "contract",
            "contract",
            "contract",
            "contract",
            THREAD_ID,
            self.runtime.binding.capabilities,
        )
        await persistence.run(
            self.catalog.register,
            SESSION_ID,
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id=THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="contract",
            model_id="model",
            policy_id="ask",
            status=SessionStatus.READY,
            title="original task",
            created_at=1.0,
            runtime_binding=original,
        )
        await persistence.run(self.catalog.begin_attachment, SESSION_ID)
        self.runtime.binding = original
        self.runtime.activity.side_effect = RuntimeError("native thread is missing")
        await persistence.run(
            self.catalog.enqueue_message,
            SESSION_ID,
            CLIENT_ID,
            {"client_user_message_id": CLIENT_ID, "input": [{"type": "text", "text": "original"}]},
        )
        await persistence.run(self.catalog.begin_queued_submission, SESSION_ID, CLIENT_ID)
        await persistence.run(self.catalog.mark_queue_running, SESSION_ID, CLIENT_ID, NATIVE_ID)
        self.live.ledger = await self.unknown_ledger()
        unknown = replace(
            self.event(RuntimeIncidentState.DETECTED, 1),
            kind=RuntimeEventKind.TURN_UNKNOWN,
            correlation_id=CLIENT_ID,
            payload={
                **self.event(RuntimeIncidentState.DETECTED, 1).payload,
                "client_user_message_id": CLIENT_ID,
            },
        )
        await persistence.run(self.catalog.record_turn_settlement, SESSION_ID, CLIENT_ID, unknown)
        proof = ThreadReplacementProof("rebuild-proof", original, CLIENT_ID, "missing", 1, 2, 1)
        ticket = ThreadReplacementTicket(proof, "generation-2", 1, 1)
        attachment_closed = asyncio.Event()
        driver = SimpleNamespace(
            prepare_thread_replacement=AsyncMock(return_value=ticket),
            commit_thread_replacement=AsyncMock(
                return_value=ThreadReplacementReceipt(ticket, CommandState.APPLIED)
            ),
            close=AsyncMock(side_effect=attachment_closed.set),
        )
        self.live.runtime_driver = driver
        self.live.thread_replacement_proof = None
        self.live.replacement_proof = None
        self.live.replacement_revision = None
        self.live.active_product_turn_id = CLIENT_ID
        self.live.release_attachment_activity = Mock()

        async def release_product_turn(_client):
            self.live.active_product_turn_id = ""
            return True

        self.live.release_product_turn = release_product_turn

        async def settle(event):
            await self.live.ledger.terminal(
                event, fallback_submission_id=CLIENT_ID, finish_messages=Mock()
            )
            return True

        self.live.settle_product_turn = settle
        turns = TurnService(
            self.sessions,
            logging.getLogger(__name__),
            activities=self.activities,
            catalog=self.catalog,
            events=self.events,
        )
        self.addAsyncCleanup(turns.aclose)
        turns.recovery = self.recovery
        turns._schedule_locked = Mock()
        self.recovery._continue = turns._enqueue_recovery

        async def original_owner():
            await attachment_closed.wait()
            pending = await turns._settle_pending_turn(self.live, CLIENT_ID)
            await persistence.run(
                self.catalog.fail_queued_submission,
                SESSION_ID,
                CLIENT_ID,
                unknown=True,
                safe_error="process_exit",
            )
            await persistence.run(
                self.catalog.clear_turn_settlement, SESSION_ID, pending.native_turn_id
            )

        self.live.current_task = asyncio.create_task(original_owner())

        async def finish_owner():
            self.live.current_task.cancel()
            await asyncio.gather(self.live.current_task, return_exceptions=True)

        self.addAsyncCleanup(finish_owner)
        candidate = replace(original, opaque_session_ref="rebuilt-thread")
        service = object.__new__(LiveSessionService)
        service._catalog = self.catalog
        service._activities = self.activities
        service._logger = logging.getLogger(__name__)
        service._activation_revision = Mock(return_value=("revision",))
        service._gateway = SimpleNamespace(
            provider_for=Mock(return_value=SimpleNamespace(resource_policy=CapacityPolicy()))
        )

        async def attach(_live, **_options):
            await persistence.run(
                self.catalog.begin_replacement,
                proof,
                service._revision_digest(("revision",)),
                "reserved",
            )
            await persistence.run(
                self.catalog.settle_replacement,
                SESSION_ID,
                proof.proof_id,
                ReplacementState.OPENING,
                candidate,
            )
            await persistence.run(
                self.catalog.replace_runtime_binding,
                original,
                candidate,
                proof=proof,
                revision=service._revision_digest(("revision",)),
            )
            self.live.runtime_session = SimpleNamespace(
                binding=candidate,
                activity=AsyncMock(
                    return_value=RuntimeActivitySnapshot("generation-2", 2, 2, True, (), True)
                ),
                snapshot=AsyncMock(return_value={"resume_turns": []}),
            )
            self.live.vendor_thread_id = candidate.opaque_session_ref

        service.ensure_active = AsyncMock(side_effect=attach)
        self.live.rebuild_thread = lambda target: service._rebuild_thread(self.live, target)
        return proof, driver, turns, service

    async def test_rebuild_rechecks_cancellation_before_sealing_the_old_attachment(self):
        _proof, driver, _turns, service = await self.configure_thread_rebuild()
        ticket = driver.prepare_thread_replacement.return_value

        async def cancelled(_target):
            self.live.interrupt_generation += 1
            return ticket

        driver.prepare_thread_replacement.side_effect = cancelled
        target = ThreadReplacementTarget(self.runtime.binding, CLIENT_ID, "missing", 1)
        with self.assertRaises(SessionActivationError):
            await service._rebuild_thread(self.live, target)
        driver.commit_thread_replacement.assert_not_awaited()
        service.ensure_active.assert_not_awaited()
        self.assertIsNone(self.catalog.replacement(SESSION_ID))
        self.assertIsNone(self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_SESSION_STATE))

    async def test_rebuild_initialization_failure_never_reports_recovery_unblocked(self):
        _proof, _driver, _turns, service = await self.configure_thread_rebuild()
        attach = service.ensure_active.side_effect

        async def initialization_failed(live, **options):
            await attach(live, **options)
            raise RuntimeError("new thread initialization failed")

        service.ensure_active.side_effect = initialization_failed
        target = ThreadReplacementTarget(self.runtime.binding, CLIENT_ID, "missing", 1)
        with self.assertRaisesRegex(RuntimeError, "new thread initialization failed"):
            await service._rebuild_thread(self.live, target)
        self.assertIs(self.catalog.replacement(SESSION_ID)["state"], ReplacementState.BOUND)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertIsNone(self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_SESSION_STATE))

    async def test_rebuild_source_conflict_drops_only_the_confirmed_detached_attachment(self):
        _proof, driver, _turns, service = await self.configure_thread_rebuild()
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        failed = self.event(RuntimeIncidentState.FAILED, 2)
        incident = replace(
            event_incident(failed),
            incident_id="missing",
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
        )
        with patch.object(
            self.catalog,
            "record_replacement",
            side_effect=SessionBindingConflictError("source changed"),
        ):
            with self.assertRaisesRegex(SessionBindingConflictError, "source changed"):
                await self.recovery._rebuild(
                    self.live,
                    self.recovery._checkpoints[SESSION_ID],
                    replace(failed, payload={"incident": incident_data(incident)}),
                )
        driver.close.assert_awaited_once()
        self.assertIsNone(self.live.runtime_driver)
        self.assertIsNone(self.live.runtime_session)
        self.live.release_attachment_activity.assert_called_once()
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.assertIsNotNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_REBUILD))
        )
        self.assertIsNone(self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_SESSION_STATE))

    async def test_rebuild_cancelled_after_binding_never_reports_recovery_unblocked(self):
        _proof, _driver, _turns, service = await self.configure_thread_rebuild()
        attach = service.ensure_active.side_effect

        async def cancelled(live, **options):
            await attach(live, **options)
            live.interrupt_generation += 1

        service.ensure_active.side_effect = cancelled
        target = ThreadReplacementTarget(self.runtime.binding, CLIENT_ID, "missing", 1)
        with self.assertRaises(SessionActivationError):
            await service._rebuild_thread(self.live, target)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertIsNone(self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_SESSION_STATE))

    async def test_rebuild_creation_ack_loss_keeps_a_durable_fence_and_never_recreates(self):
        proof, driver, _turns, service = await self.configure_thread_rebuild()

        async def lost_ack(_live, **_options):
            self.catalog.begin_replacement(
                proof, service._revision_digest(("revision",)), "reserved"
            )
            raise OSError("creation result unknown")

        service.ensure_active.side_effect = lost_ack
        target = ThreadReplacementTarget(self.runtime.binding, CLIENT_ID, "missing", 1)
        with self.assertRaisesRegex(OSError, "creation result unknown"):
            await service._rebuild_thread(self.live, target)
        self.assertIs(self.catalog.replacement(SESSION_ID)["state"], ReplacementState.UNKNOWN)
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        driver.commit_thread_replacement.assert_awaited_once()
        service.ensure_active.assert_awaited_once()
        with self.assertRaises(SessionActivationError):
            await service._rebuild_thread(self.live, target)
        service.ensure_active.assert_awaited_once()

    async def test_missing_history_rebuilds_and_continues_without_repeating_the_original_input(
        self,
    ):
        proof, driver, turns, service = await self.configure_thread_rebuild()
        for kind, payload in (
            (PRODUCT_EVENT_TOOL_COMPLETED, {"tool": "write_file", "result": "already written"}),
            (PRODUCT_EVENT_ARTIFACT_CHANGED, {"path": "result.txt"}),
            (PRODUCT_EVENT_PLAN_SNAPSHOT, {"steps": [{"status": "completed", "text": "write"}]}),
        ):
            await self.live.publish(kind, payload, turn_id=NATIVE_ID, idempotency_key=kind)
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        failed = self.event(RuntimeIncidentState.FAILED, 2)
        incident = replace(
            event_incident(failed),
            incident_id="missing",
            scope=RuntimeIncidentScope.THREAD,
            kind=RuntimeIncidentKind.RESUME_FAILED,
        )
        await self.recovery.observe(
            self.live, replace(failed, payload={"incident": incident_data(incident)})
        )
        await asyncio.gather(*tuple(self.recovery._tasks.values()))
        driver.commit_thread_replacement.assert_awaited_once()
        service.ensure_active.assert_awaited_once()
        turns._schedule_locked.assert_called_once()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        self.assertEqual(checkpoint.epoch, proof.proof_id)
        self.assertEqual(checkpoint.payload[RECOVERY_REBUILD_PROOF], proof.proof_id)
        queued = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(len(queued), 1)
        self.assertNotEqual(queued[0].queued_message_id, CLIENT_ID)
        self.assertNotEqual(queued[0].body["input"], [{"type": "text", "text": "original"}])
        context = queued[0].body["input"][1]["text"]
        self.assertIn("already written", context)
        self.assertIn("result.txt", context)
        self.assertIn(PRODUCT_EVENT_PLAN_SNAPSHOT, context)
        self.assertIn("outcome remains unknown", context)
        self.assertFalse(self.live.ledger.has_unknown_outcome)
        restored = self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_SESSION_STATE)
        self.assertIsNotNone(restored)
        self.assertEqual(restored.payload["state"], PRODUCT_SESSION_STATE_IDLE)
        self.assertFalse(restored.payload["recovery_blocked"])
        self.assertFalse(restored.payload["recovery_pending"])
        self.assertEqual(restored.payload["reason"], ReplacementKind.HISTORY_REBUILD.value)
        self.assertEqual(restored.payload["proof_id"], proof.proof_id)
        self.assertEqual(restored.payload["previous_native_session_id"], THREAD_ID)
        self.assertEqual(restored.payload["native_session_id"], "rebuilt-thread")
        self.assertEqual(
            self.catalog.uncertainty(SESSION_ID, "turn", NATIVE_ID).payload["outcome"],
            PRODUCT_TURN_OUTCOME_UNKNOWN,
        )

    async def unknown_ledger(self, native_id=NATIVE_ID, correlation_id=CLIENT_ID):
        ledger = SessionLedger(
            session_id=SESSION_ID,
            catalog=self.catalog,
            publish=self.live.publish,
            trace=Mock(),
            logger=logging.getLogger(__name__),
            lock=asyncio.Lock(),
            persistence=self.live.persistence,
        )
        detected = self.event(RuntimeIncidentState.DETECTED, 1)
        event = replace(
            detected,
            kind=RuntimeEventKind.TURN_UNKNOWN,
            native_turn_id=native_id,
            correlation_id=correlation_id,
            payload={**detected.payload, "client_user_message_id": CLIENT_ID},
        )
        await ledger.terminal(event, fallback_submission_id=CLIENT_ID, finish_messages=Mock())
        return ledger

    async def test_acknowledged_native_turn_reconciles_before_automatic_policy(self):
        ledger = await self.unknown_ledger()
        self.assertTrue(ledger.has_unknown_outcome)
        self.live.ledger = ledger

        async def reconcile():
            await ledger.reconcile(
                await self.runtime.snapshot(),
                runtime_id="codex",
                native_session_id=THREAD_ID,
                finish_messages=Mock(),
            )

        self.live.reconcile_resumed_turns = reconcile
        await self.recover()
        self.assertFalse(ledger.has_unknown_outcome)
        self.callback.assert_awaited_once()

    async def test_cross_namespace_identity_collision_does_not_resolve_another_turn(self):
        ledger = await self.unknown_ledger()
        snapshot = {
            "resume_turns": [
                {"client_id": CLIENT_ID, "turn_id": NATIVE_ID, "terminal_status": "interrupted"},
                {"client_id": NATIVE_ID, "turn_id": "other-native", "terminal_status": "completed"},
            ]
        }
        await ledger.reconcile(
            snapshot, runtime_id="codex", native_session_id=THREAD_ID, finish_messages=Mock()
        )
        self.assertTrue(ledger.has_unknown_outcome)
        self.assertTrue(ledger.uncertainty_snapshot())

    async def test_missing_native_target_cannot_be_impersonated_by_a_client_id(self):
        ledger = await self.unknown_ledger()
        await ledger.reconcile(
            {
                "resume_turns": [
                    {
                        "client_id": NATIVE_ID,
                        "turn_id": "other-native",
                        "terminal_status": "completed",
                    }
                ]
            },
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertTrue(ledger.has_unknown_outcome)

    async def test_matching_native_target_with_wrong_client_keeps_unknown(self):
        ledger = await self.unknown_ledger()
        await ledger.reconcile(
            {
                "resume_turns": [
                    {
                        "client_id": "other-client",
                        "turn_id": NATIVE_ID,
                        "terminal_status": "completed",
                    }
                ]
            },
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertTrue(ledger.has_unknown_outcome)

    async def test_safe_interrupted_turn_can_continue(self):
        await self.recover()
        self.callback.assert_awaited_once()
        self.assertIs(self.callback.call_args.args[0], self.live)
        self.assertEqual(self.callback.call_args.args[2], "generation-2")

    async def test_closing_prevents_automatic_recovery_claim(self):
        turns = await self.queued_recovery()
        self.live.closing = True
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        self.assertIsNone(
            self.events.by_key(
                SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED, checkpoint.epoch)
            )
        )
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        turns._schedule_locked.assert_not_called()

    async def test_archiving_prevents_automatic_recovery_claim(self):
        turns = await self.queued_recovery()
        self.catalog.set_archived(SESSION_ID, SessionPrincipal("owner"), True)
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        self.assertIsNone(
            self.events.by_key(
                SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED, checkpoint.epoch)
            )
        )
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        turns._schedule_locked.assert_not_called()

    async def test_issued_recovery_admission_expires_on_closing_or_archiving(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        fence = await self.recovery.admission(
            self.live, self.recovery.source(checkpoint, "generation-2"), "successor"
        )
        self.assertIsNotNone(fence)
        self.assertTrue(fence.current())
        self.live.closing = True
        self.assertFalse(fence.current())
        self.live.closing = False
        self.assertTrue(fence.current())
        self.catalog.set_archived(SESSION_ID, SessionPrincipal("owner"), True)
        self.assertFalse(fence.current())

    async def test_native_binding_update_is_not_a_new_user_submission(self):
        await self.live.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {"text": "original", "client_turn_id": CLIENT_ID, "origin": "turn", "binding": "bound"},
            turn_id=NATIVE_ID,
            idempotency_key="bound-user",
        )
        await self.recover()
        self.callback.assert_awaited_once()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        fence = await self.recovery.admission(
            self.live, self.recovery.source(checkpoint, "generation-2"), "successor"
        )
        self.assertIsNotNone(fence)
        self.assertTrue(fence.current())

    async def test_reused_client_identity_with_changed_content_is_not_a_binding_update(self):
        await self.live.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "different task",
                "client_turn_id": CLIENT_ID,
                "origin": "turn",
                "binding": "bound",
            },
            turn_id=NATIVE_ID,
            idempotency_key="changed-binding",
        )
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_binding_updates_preserve_every_input_identity_field_at_final_fence(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        fence = await self.recovery.admission(
            self.live, self.recovery.source(checkpoint, "generation-2"), "successor"
        )
        valid = {
            "text": "original",
            "client_turn_id": CLIENT_ID,
            "origin": "turn",
            "binding": "bound",
        }
        for index, changed in enumerate(
            (
                {"refs": [{"name": "changed"}]},
                {"assistant_snapshot_id": "changed"},
                {"assistant_context_revision": 9},
                {"origin": "steer"},
                {"binding": "cancelled"},
            )
        ):
            with self.subTest(changed=changed):
                await self.live.publish(
                    PRODUCT_EVENT_USER_MESSAGE,
                    {**valid, **changed},
                    turn_id=NATIVE_ID,
                    idempotency_key=f"changed-{index}",
                )
                self.assertFalse(await self.recovery.eligible(self.live, checkpoint))
                self.assertFalse(fence.current())
                await self.live.publish(
                    PRODUCT_EVENT_USER_MESSAGE,
                    valid,
                    turn_id=NATIVE_ID,
                    idempotency_key=f"valid-{index}",
                )
                self.assertTrue(await self.recovery.eligible(self.live, checkpoint))
                self.assertTrue(fence.current())

    async def test_original_resource_owner_must_finish_its_queue_settlement(self):
        release = asyncio.Event()
        self.live.resource_task = asyncio.create_task(release.wait())
        self.live.waiting_request_id = CLIENT_ID
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.DETECTED, 1))
        await self.recovery.observe(self.live, self.event(RuntimeIncidentState.RECOVERED, 2))
        await asyncio.sleep(0)
        try:
            self.callback.assert_not_awaited()
        finally:
            release.set()
            await self.live.resource_task
            await asyncio.gather(*tuple(self.recovery._tasks.values()))
        self.callback.assert_awaited_once()

    async def test_reconciled_process_crash_does_not_claim_the_user_stopped(self):
        ledger = await self.unknown_ledger()
        await ledger.reconcile(
            await self.runtime.snapshot(),
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        interrupted = [
            row for row in self.events.replay(SESSION_ID) if row.kind == "turn_interrupted"
        ]
        self.assertEqual(interrupted[-1].payload.get("reason"), "process_exit")

    async def test_typed_client_binding_does_not_use_generic_request_correlation(self):
        ledger = await self.unknown_ledger(correlation_id="generic-request")
        await ledger.reconcile(
            await self.runtime.snapshot(),
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertFalse(ledger.has_unknown_outcome)

    async def test_process_recovery_owned_by_adapter_is_not_republished_by_turn_reconciliation(
        self,
    ):
        ledger = await self.unknown_ledger()
        recovered = self.event(RuntimeIncidentState.RECOVERED, 2)
        await ledger.incident(recovered, event_incident(recovered))
        await ledger.reconcile(
            await self.runtime.snapshot(),
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertFalse(ledger.has_unknown_outcome)
        incidents = [
            row for row in self.events.replay(SESSION_ID) if row.kind == "runtime_incident"
        ]
        self.assertEqual([row.payload["state"] for row in incidents], ["recovered"])

    async def test_turn_terminal_does_not_establish_process_recovery(self):
        ledger = await self.unknown_ledger()
        detected = self.event(RuntimeIncidentState.DETECTED, 1)
        await ledger.incident(detected, event_incident(detected))
        await ledger.reconcile(
            await self.runtime.snapshot(),
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        incidents = [
            row for row in self.events.replay(SESSION_ID) if row.kind == "runtime_incident"
        ]
        self.assertEqual([row.payload["state"] for row in incidents], ["detected"])

    async def test_preacknowledgement_queue_resolves_only_its_client_identity(self):
        self.catalog.enqueue_message(
            SESSION_ID, CLIENT_ID, {"input": [{"type": "text", "text": "task"}]}
        )
        ledger = await self.unknown_ledger(native_id=CLIENT_ID)
        await ledger.reconcile(
            {
                "resume_turns": [
                    {
                        "client_id": "other-client",
                        "turn_id": CLIENT_ID,
                        "terminal_status": "completed",
                    }
                ]
            },
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertTrue(ledger.has_unknown_outcome)
        await ledger.reconcile(
            await self.runtime.snapshot(),
            runtime_id="codex",
            native_session_id=THREAD_ID,
            finish_messages=Mock(),
        )
        self.assertFalse(ledger.has_unknown_outcome)

    async def test_tool_exposure_is_durable_and_allows_inspect_before_continuing(self):
        await self.recovery.before_output(
            SESSION_ID, CLIENT_ID, sse({"type": "response.function_call_arguments.delta"})
        )
        self.assertIsNotNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_EXPOSED))
        )
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_provider_tool_request_without_output_allows_recovery(self):
        await self.recovery.before_request(
            SESSION_ID, CLIENT_ID, {"tools": [{"type": "web_search"}]}
        )
        self.assertIsNotNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_EXPOSED))
        )
        self.assertEqual(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_EXPOSED)).payload[
                "boundary"
            ],
            "model_request",
        )
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_authorized_read_only_request_without_output_can_continue_once(self):
        authority = CompletionAuthority("registered", READ_ONLY_TOOLS, lambda: True)
        await self.recovery.before_request(
            SESSION_ID, CLIENT_ID, {"tools": [{"type": READ_ONLY_WEB_SEARCH}]}, authority
        )
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_bridge_injects_authority_only_for_its_reviewed_actual_upstream(self):
        requests = []

        async def upstream(request):
            requests.append(str(request.url))
            self.assertFalse(self.recovery._checkpoints[SESSION_ID].exposed)
            return httpx.Response(200, json={"object": "response", "output": []})

        bridge = CompletionBridge(
            "http://127.0.0.1",
            turn_ids=lambda _session: CLIENT_ID,
            retryable_tool_endpoints={TRUSTED_RESPONSES: READ_ONLY_TOOLS},
        )
        self.addAsyncCleanup(bridge.close)
        bridge._clients[False] = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        bridge.bind_output_guard(
            self.recovery.before_output, before_request=self.recovery.before_request
        )
        self.recovery.bind_quiescence(bridge.quiesce_turn)
        registration = bridge.register(
            endpoint="https://other.example/ignored",
            responses_endpoint=TRUSTED_RESPONSES,
            api_key="contract-only",
            session_id=SESSION_ID,
            wire_protocol=ModelWireProtocol.RESPONSES,
        )
        await bridge.forward(
            registration.bridge_id,
            {"model": "model", "input": "inspect", "tools": [{"type": READ_ONLY_WEB_SEARCH}]},
        )
        self.assertEqual(requests, [TRUSTED_RESPONSES])
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_bridge_freezes_only_the_first_matching_checkpoint_request(self):
        reads = []
        intent = {"credential": 1}
        turn = [CLIENT_ID]
        bridge = CompletionBridge(
            "http://127.0.0.1",
            turn_ids=lambda _session: turn[0],
            retryable_tool_endpoints={TRUSTED_RESPONSES: READ_ONLY_TOOLS},
        )
        self.addAsyncCleanup(bridge.close)
        bridge._clients[False] = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, json={"object": "response", "output": []})
            )
        )
        bridge.bind_output_guard(
            self.recovery.before_output, before_request=self.recovery.before_request
        )

        def source():
            reads.append(dict(intent))
            return intent

        parameters = {
            "endpoint": TRUSTED_RESPONSES,
            "responses_endpoint": TRUSTED_RESPONSES,
            "wire_protocol": ModelWireProtocol.RESPONSES,
            "api_key": "private-checkpoint-key",
            "renewal_source": source,
        }
        outside = bridge.register(**parameters, session_id="outside-checkpoint")
        payload = {"model": "model", "input": "inspect", "tools": [{"type": READ_ONLY_WEB_SEARCH}]}
        await bridge.forward(outside.bridge_id, payload)
        self.assertEqual(reads, [])
        registration = bridge.register(**parameters, session_id=SESSION_ID)
        turn[0] = "outside-turn"
        await bridge.forward(registration.bridge_id, payload)
        self.assertEqual(reads, [])
        turn[0] = CLIENT_ID
        await bridge.forward(registration.bridge_id, payload)
        authority = self.recovery._checkpoints[SESSION_ID].authority
        self.assertIsNotNone(authority)
        self.assertEqual(reads, [{"credential": 1}])
        await bridge.forward(registration.bridge_id, payload)
        self.assertEqual(reads, [{"credential": 1}])
        intent["credential"] = 2
        bridge._upstreams[registration.bridge_id].api_key = "rotated-checkpoint-key"
        await bridge.forward(registration.bridge_id, payload)
        self.assertEqual(reads, [{"credential": 1}])
        self.assertIs(self.recovery._checkpoints[SESSION_ID].authority, authority)
        self.assertIsNone(authority.prepare_renewal("successor"))
        self.assertEqual(reads, [{"credential": 1}, {"credential": 2}])

    async def test_checkpoint_capture_precedes_the_first_await_and_cannot_be_refrozen(self):
        reads = []
        intent = {"credential": 1}
        bridge = CompletionBridge("http://127.0.0.1")
        self.addAsyncCleanup(bridge.close)

        def source():
            reads.append(dict(intent))
            return intent

        registration = bridge.register(
            endpoint=TRUSTED_RESPONSES,
            api_key="private-key",
            session_id=SESSION_ID,
            renewal_source=source,
        )
        authority = bridge._request_authority(
            bridge._upstreams[registration.bridge_id],
            TRUSTED_RESPONSES,
            ModelWireProtocol.RESPONSES,
        )
        self.assertEqual(reads, [])

        async def boundary(*_args):
            self.assertEqual(reads, [{"credential": 1}])
            intent["credential"] = 2
            await asyncio.sleep(0)

        with patch.object(self.recovery, "_observe_exposure", side_effect=boundary):
            await self.recovery.before_request(SESSION_ID, CLIENT_ID, {}, authority)
        authority.capture_renewal()
        self.assertEqual(reads, [{"credential": 1}])
        self.assertIsNone(authority.prepare_renewal("successor"))

    async def test_upstream_change_revokes_recovery_and_the_final_native_fence(self):
        valid = True
        authority = CompletionAuthority("registered", READ_ONLY_TOOLS, lambda: valid)
        await self.recovery.before_request(
            SESSION_ID, CLIENT_ID, {"tools": [{"type": READ_ONLY_WEB_SEARCH}]}, authority
        )
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        source = self.recovery.source(checkpoint, "generation-2")
        fence = await self.recovery.admission(self.live, source, "successor")
        self.assertTrue(fence.current())
        valid = False
        self.assertFalse(fence.current())
        self.assertFalse(await self.recovery.eligible(self.live, checkpoint))

    async def test_replacing_registration_does_not_inherit_authority(self):
        payload = {"tools": [{"type": READ_ONLY_WEB_SEARCH}]}
        await self.recovery.before_request(
            SESSION_ID,
            CLIENT_ID,
            payload,
            CompletionAuthority("first", READ_ONLY_TOOLS, lambda: True),
        )
        await self.recovery.before_request(
            SESSION_ID,
            CLIENT_ID,
            payload,
            CompletionAuthority("second", READ_ONLY_TOOLS, lambda: True),
        )
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_upstream_authority_is_journaled_before_request_and_physically_quiesced(self):
        received = asyncio.Event()
        cancelled = asyncio.Event()

        async def upstream(_request):
            exposure = self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_EXPOSED))
            self.assertEqual(exposure.payload["boundary"], "model_request")
            received.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        bridge = CompletionBridge("http://127.0.0.1", turn_ids=lambda _session: CLIENT_ID)
        self.addAsyncCleanup(bridge.close)
        bridge._clients[False] = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        bridge.bind_output_guard(
            self.recovery.before_output, before_request=self.recovery.before_request
        )
        self.recovery.bind_quiescence(bridge.quiesce_turn)
        registration = bridge.register(
            endpoint="https://upstream.example/responses",
            responses_endpoint="https://upstream.example/responses",
            api_key="contract-only",
            session_id=SESSION_ID,
            wire_protocol=ModelWireProtocol.RESPONSES,
        )
        forwarding = asyncio.create_task(
            bridge.forward(
                registration.bridge_id,
                {
                    "model": "model",
                    "input": "inspect",
                    "tools": [{"type": "web_search"}],
                },
            )
        )
        await asyncio.wait_for(received.wait(), timeout=1)
        await self.recover()
        self.assertTrue(cancelled.is_set())
        self.assertTrue(forwarding.cancelled())
        self.assertFalse(bridge._calls)
        self.callback.assert_awaited_once()

    async def test_persistence_failure_prevents_risky_forwarding(self):
        self.live.publish = AsyncMock(side_effect=OSError("journal unavailable"))
        with self.assertRaisesRegex(OSError, "journal unavailable"):
            await self.recovery.before_request(
                SESSION_ID, CLIENT_ID, {"tools": [{"type": "web_search"}]}
            )
        self.assertFalse(self.recovery._checkpoints[SESSION_ID].exposed)

    async def test_final_admission_fence_revokes_on_user_interrupt(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        source = self.recovery.source(checkpoint, "generation-2")
        fence = await self.recovery.admission(self.live, source, "successor")
        self.assertIsNotNone(fence)
        self.assertTrue(fence.current())
        await self.live.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {
                "text": "system continuation",
                "client_turn_id": "successor",
                "origin": "recovery",
            },
            turn_id="successor",
            idempotency_key="successor-user",
        )
        self.live.last_submission_id = "successor"
        self.assertTrue(fence.current())
        self.live.interrupt_generation += 1
        self.assertFalse(fence.current())

    async def test_final_admission_fence_revokes_on_new_queue_or_hil(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        source = self.recovery.source(checkpoint, "generation-2")
        fence = await self.recovery.admission(self.live, source, "successor")
        self.live.pending_hil_snapshot.return_value = [{"request_id": "new-hil"}]
        self.assertFalse(fence.current())
        self.live.pending_hil_snapshot.return_value = []
        self.catalog.enqueue_message(
            SESSION_ID, "new", {"input": [{"type": "text", "text": "user"}]}
        )
        self.assertFalse(fence.current())

    async def test_late_old_stream_cannot_forward_after_seal(self):
        await self.recover()
        with self.assertRaisesRegex(RuntimeError, RECOVERY_STALE):
            await self.recovery.before_output(
                SESSION_ID,
                CLIENT_ID,
                sse({"type": "response.output_item.done", "item": {"type": "function_call"}}),
            )

    async def test_unknown_submission_without_model_observation_can_retry(self):
        self.catalog.enqueue_message(
            SESSION_ID,
            CLIENT_ID,
            {"client_user_message_id": CLIENT_ID, "input": [{"type": "text", "text": "original"}]},
        )
        self.catalog.begin_queued_submission(SESSION_ID, CLIENT_ID)
        self.catalog.fail_queued_submission(
            SESSION_ID, CLIENT_ID, unknown=True, safe_error="process_exit"
        )
        self.recovery._checkpoints[SESSION_ID].observed = False
        self.runtime.snapshot.return_value = {"resume_turns": []}
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_completed_turn_does_not_continue(self):
        self.runtime.snapshot.return_value["resume_turns"][0]["terminal_status"] = "completed"
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_missing_or_mismatched_native_identity_does_not_continue(self):
        self.runtime.snapshot.return_value["resume_turns"][0]["client_id"] = "other"
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_unknown_operation_blocks_even_without_turn_unknown_flag(self):
        self.live.ledger.uncertainty_snapshot.return_value = [
            {"kind": "tool_response", "state": "unknown"}
        ]
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_precrash_hil_remains_a_blocker_after_card_expires(self):
        await self.live.publish(
            PRODUCT_EVENT_HIL_REQUESTED,
            {"request_id": "old-hil"},
            turn_id=NATIVE_ID,
            idempotency_key="old-hil",
        )
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_incomplete_or_busy_execution_tree_does_not_continue(self):
        self.runtime.activity.return_value = replace(
            self.runtime.activity.return_value, execution_tree_complete=False
        )
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_new_user_message_and_user_interrupt_stop_automatic_work(self):
        self.live.interrupt_generation += 1
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_new_user_history_supersedes_original_task(self):
        await self.live.publish(
            PRODUCT_EVENT_USER_MESSAGE,
            {"text": "new task"},
            turn_id="new",
            idempotency_key="new-user",
        )
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_actor_change_does_not_continue_the_previous_users_task(self):
        self.live.user_id = "other-owner"
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_maintenance_does_not_wait_or_resume_automatic_work(self):
        generation = self.activities.begin()
        await self.recover()
        self.callback.assert_not_awaited()
        self.assertTrue(self.activities.seal(generation))

    async def test_automatic_successor_cannot_start_another_recovery_chain(self):
        self.recovery._checkpoints[SESSION_ID].payload["automatic"] = True
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_cancelled_maintenance_still_invalidates_automatic_continuation(self):
        generation = self.activities.begin()
        self.activities.resume(generation)
        await self.recover()
        self.callback.assert_not_awaited()

    async def test_missing_model_observation_does_not_block_authorized_recovery(self):
        self.recovery._checkpoints[SESSION_ID].observed = False
        await self.recover()
        self.callback.assert_awaited_once()

    async def test_adapter_without_native_admission_capability_cannot_continue(self):
        self.runtime.binding.capabilities = CapabilitySet()
        await self.recover()
        self.callback.assert_not_awaited()

    async def queued_recovery(self):
        original_body = {
            "client_user_message_id": CLIENT_ID,
            "input": [{"type": "text", "text": "original"}],
        }
        self.catalog.enqueue_message(SESSION_ID, CLIENT_ID, original_body)
        self.catalog.begin_queued_submission(SESSION_ID, CLIENT_ID)
        self.catalog.mark_queue_running(SESSION_ID, CLIENT_ID, NATIVE_ID)
        self.catalog.fail_queued_submission(
            SESSION_ID, CLIENT_ID, unknown=True, safe_error="process_exit"
        )
        turns = TurnService(
            self.sessions,
            logging.getLogger(__name__),
            activities=self.activities,
            catalog=self.catalog,
            events=self.events,
        )
        self.addAsyncCleanup(turns.aclose)
        turns.recovery = self.recovery
        turns._schedule_locked = Mock()
        self.recovery._continue = turns._enqueue_recovery
        return turns

    async def test_interrupted_unknown_queue_creates_one_automatic_successor(self):
        turns = await self.queued_recovery()
        await self.recover()
        turns._schedule_locked.assert_called_once()
        queued = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(len(queued), 1)
        self.assertNotEqual(queued[0].queued_message_id, CLIENT_ID)
        self.assertEqual(queued[0].purpose, QUEUE_PURPOSE_RECOVERY)
        self.assertEqual(queued[0].body[RECOVERY_SOURCE]["action"], RecoveryAction.CONTINUE.value)
        self.assertIsNotNone(
            ProductEventStore(self.events.database).by_key(
                SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED)
            )
        )
        await turns._enqueue_recovery(
            self.live, self.recovery._checkpoints[SESSION_ID], "generation-2"
        )
        turns._schedule_locked.assert_called_once()
        self.assertEqual(self.catalog.queued_messages(SESSION_ID), queued)

    async def test_reconciled_original_still_creates_exactly_one_automatic_successor(self):
        turns = await self.queued_recovery()
        self.catalog.claim_uncertainty(
            SESSION_ID, UncertaintyKind.TURN, NATIVE_ID, state=UncertaintyState.UNKNOWN
        )
        self.catalog.transition_uncertainty(
            SESSION_ID, UncertaintyKind.TURN, NATIVE_ID, UncertaintyState.RECONCILED
        )
        original = self.catalog.queued_message(SESSION_ID, CLIENT_ID)
        self.assertTrue(
            self.catalog.remove_reconciled_unknown_message(
                SESSION_ID, CLIENT_ID, original.operation_seq
            )
        )
        await self.recover()
        turns._schedule_locked.assert_called_once()
        await turns._enqueue_recovery(
            self.live, self.recovery._checkpoints[SESSION_ID], "generation-2"
        )
        turns._schedule_locked.assert_called_once()
        queued = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].purpose, QUEUE_PURPOSE_RECOVERY)

    async def refreshed_recovery(self, *, authority=None):
        turns = await self.queued_recovery()
        binding = RuntimeBinding(
            SESSION_ID,
            "codex",
            "adapter",
            "runtime",
            "protocol",
            "schema",
            THREAD_ID,
            self.runtime.binding.capabilities,
        )
        self.runtime.binding = binding
        self.runtime.resource_evidence = None
        self.live.runtime_binding = binding
        self.live.runtime_driver = object()
        self.live.attachment_generation = 1
        self.live.reasoning_effort = ""
        self.live.thinking = None
        self.live.runtime_workdir = self.root
        self.live.project_path = None
        self.live.output_root = self.root
        self.live.writable_roots = ()
        self.live.process_environment = {}
        self.live.skill_configurations = ()
        self.live.previous_turn_blockers = AsyncMock(return_value=())
        self.recovery._checkpoints[SESSION_ID].authority = authority
        await self.recover()
        queued = self.catalog.queued_messages(SESSION_ID)[0]
        original = self.runtime

        async def prepare(live, *, request_id, **_kwargs):
            self.assertIs(live.runtime_session, original)
            live.runtime_session = SimpleNamespace(
                binding=binding,
                activity=AsyncMock(
                    return_value=replace(original.activity.return_value, generation="new-host:1")
                ),
                snapshot=AsyncMock(return_value=original.snapshot.return_value),
                resource_evidence=ResourceEvidence(
                    "event",
                    f"{request_id}:{uuid.uuid4().hex}",
                    "reservation",
                    "host",
                    "lease",
                    "execution",
                    "attached",
                    1.0,
                    (),
                    1,
                ),
            )
            live.runtime_driver = object()
            live.attachment_generation += 1

        turns._prepare = AsyncMock(side_effect=prepare)
        self.live.resource_task = asyncio.current_task()
        self.live.waiting_request_id = queued.queued_message_id
        turns._defer_queue = Mock()
        return turns, queued

    async def test_normal_turn_preparation_readmits_the_same_recovery_successor_once(self):
        turns, queued = await self.refreshed_recovery()
        source = dict(queued.body[RECOVERY_SOURCE])
        claim = self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED))
        admissions = []

        async def admit(live, body, *, recovery):
            admission = await self.recovery.admission(live, recovery, queued.queued_message_id)
            self.assertIsNotNone(admission)
            self.assertEqual(admission.generation, "new-host:1")
            self.assertTrue(admission.current())
            admissions.append(admission)

            async def completed():
                return TurnResult(queued.queued_message_id, TurnStatus.COMPLETED)

            return {"ok": True}, 200, asyncio.create_task(completed())

        turns._admit_turn_locked = AsyncMock(side_effect=admit)
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertIs(result.status, TurnStatus.COMPLETED)
        self.assertEqual(len(admissions), 1)
        self.assertEqual(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED)), claim
        )
        self.assertEqual(queued.body[RECOVERY_SOURCE], source)
        self.assertTrue(await self.recovery.current(self.live, source))
        self.live.attachment_generation += 1
        self.assertFalse(await self.recovery.current(self.live, source))
        self.assertFalse(admissions[0].current())

    async def native_recovery_result(self, turns, queued):
        turns._typed_input = AsyncMock(
            return_value=TurnAdmission(
                TurnInput((InputItem(InputKind.TEXT, text="continue"),), queued.queued_message_id),
                "continue",
                {},
                (),
            )
        )
        self.live.product_turn_generation = 0
        self.live.trace_turn_input = Mock()
        self.live.refresh_skills = AsyncMock()
        self.live.ledger.record_unknown_submission = AsyncMock()

        async def record_user(text, *, turn_id, origin, **_kwargs):
            await self.live.publish(
                PRODUCT_EVENT_USER_MESSAGE,
                {"text": text, "client_turn_id": turn_id, "origin": origin},
                turn_id=turn_id,
                idempotency_key=f"successor-user:{turn_id}",
            )

        self.live.record_user_history = record_user
        fences = []

        async def execute(live, turn_input):
            self.assertEqual(
                self.recovery._checkpoints[SESSION_ID].client_id, queued.queued_message_id
            )
            self.assertIsNotNone(turn_input.admission)
            self.assertTrue(turn_input.admission.current())
            self.assertTrue(turn_input.admission.current())
            self.assertIsNone(
                await self.recovery.admission(
                    live, queued.body[RECOVERY_SOURCE], queued.queued_message_id
                )
            )
            fences.append(turn_input.admission)
            return TurnResult(queued.queued_message_id, TurnStatus.COMPLETED)

        turns._execute = AsyncMock(side_effect=execute)
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertIs(result.status, TurnStatus.COMPLETED)
        self.assertEqual(len(fences), 1)
        return result, fences

    async def test_readmitted_native_fence_survives_the_real_successor_checkpoint_begin(self):
        turns, queued = await self.refreshed_recovery()
        _result, fences = await self.native_recovery_result(turns, queued)
        await self.recovery.begin(self.live, "unrelated-user-command")
        self.assertFalse(fences[0].current())

    async def bridge_recovery(self, *, change=None, revoke=False):
        bridge = CompletionBridge("http://127.0.0.1")
        self.addAsyncCleanup(bridge.close)
        intent = {"model": "model", "policy": "ask", "credential_generation": 1}
        parameters = {
            "endpoint": TRUSTED_RESPONSES,
            "responses_endpoint": TRUSTED_RESPONSES,
            "wire_protocol": ModelWireProtocol.RESPONSES,
            "api_key": "contract-only",
            "session_id": SESSION_ID,
            "owner_id": "owner",
            "connection_id": "connection",
            "renewal_source": lambda: dict(intent),
        }
        registration = bridge.register(**parameters)
        authority = bridge._request_authority(
            bridge._upstreams[registration.bridge_id],
            TRUSTED_RESPONSES,
            ModelWireProtocol.RESPONSES,
        )
        authority.capture_renewal()
        turns, queued = await self.refreshed_recovery(authority=authority)
        normal_prepare = turns._prepare

        async def prepare(live, **kwargs):
            self.assertEqual(bridge.release(SESSION_ID), 1)
            self.assertFalse(authority.current())
            if change is not None:
                intent.update(change)
            if revoke:
                bridge.revoke_connection("owner", "connection")
            bridge.register(**parameters)
            await normal_prepare(live, **kwargs)

        turns._prepare = AsyncMock(side_effect=prepare)
        return turns, queued, authority, bridge

    async def test_real_bridge_release_and_renewal_survive_successor_native_admission(self):
        turns, queued, old_authority, bridge = await self.bridge_recovery()
        _result, fences = await self.native_recovery_result(turns, queued)
        self.assertFalse(old_authority.current())
        consumption = self.recovery._consumptions[SESSION_ID]
        renewed = consumption.handoff.authority
        self.assertIsNotNone(renewed)
        self.assertTrue(renewed.current())
        self.assertNotEqual(renewed.identity, old_authority.identity)
        self.assertTrue(fences[0].current())
        record = self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_PREPARED))
        self.assertEqual(record.payload["source_authority"], old_authority.identity)
        self.assertEqual(record.payload["authority"], renewed.identity)
        bridge.revoke_connection("owner", "connection")
        self.assertFalse(renewed.current())
        self.assertFalse(fences[0].current())

    async def test_same_attachment_without_bridge_release_keeps_its_live_authority(self):
        turns, queued, old_authority, _bridge = await self.bridge_recovery()
        turns._prepare = AsyncMock()
        _result, fences = await self.native_recovery_result(turns, queued)
        self.assertTrue(old_authority.current())
        retained = self.recovery._consumptions[SESSION_ID].handoff.authority
        self.assertIsNot(retained, old_authority)
        self.assertEqual(retained.identity, old_authority.identity)
        self.assertTrue(retained.current())
        self.assertEqual(fences[0].generation, "generation-2")

    async def test_same_attachment_source_revoked_during_prepare_cannot_fall_back_to_old_authority(
        self,
    ):
        turns, queued, old_authority, bridge = await self.bridge_recovery()
        upstream = next(iter(bridge._upstreams.values()))

        async def prepare(_live, **_kwargs):
            upstream.renewal_source = lambda: {"credential_generation": 2}

        turns._prepare = AsyncMock(side_effect=prepare)
        turns._admit_turn_locked = AsyncMock(
            return_value=({"ok": False, "error": "unexpected_admission"}, 409, None)
        )
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        self.assertTrue(old_authority.current())
        turns._admit_turn_locked.assert_not_awaited()

    async def test_same_attachment_writer_fence_rechecks_renewal_source_after_issue(self):
        turns, queued, old_authority, bridge = await self.bridge_recovery()
        turns._prepare = AsyncMock()
        _result, fences = await self.native_recovery_result(turns, queued)
        upstream = next(iter(bridge._upstreams.values()))
        upstream.renewal_source = lambda: {"credential_generation": 2}
        self.assertTrue(old_authority.current())
        self.assertFalse(fences[0].current())

    async def test_rejected_renewal_factory_never_enters_normal_preparation(self):
        authority = CompletionAuthority(
            "rejected-renewal", frozenset(), lambda: True, lambda _successor: None
        )
        turns, queued = await self.refreshed_recovery(authority=authority)
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        turns._prepare.assert_not_awaited()

    async def test_real_source_changed_before_capture_never_enters_normal_preparation(self):
        turns, queued, _old_authority, bridge = await self.bridge_recovery()
        upstream = next(iter(bridge._upstreams.values()))
        upstream.renewal_source = lambda: {"credential_generation": 2}
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        turns._prepare.assert_not_awaited()

    async def test_legacy_authority_without_renewal_requires_an_unchanged_attachment(self):
        authority = CompletionAuthority("legacy", frozenset(), lambda: True)
        turns, queued = await self.refreshed_recovery(authority=authority)
        turns._prepare = AsyncMock()
        _result, fences = await self.native_recovery_result(turns, queued)
        self.assertIs(self.recovery._consumptions[SESSION_ID].handoff.authority, authority)
        self.assertEqual(fences[0].generation, "generation-2")

    async def test_changed_attachment_without_typed_authority_renewal_fails_closed(self):
        old_authority = CompletionAuthority("unsupported", frozenset(), lambda: True)
        turns, queued = await self.refreshed_recovery(authority=old_authority)
        turns._admit_turn_locked = AsyncMock()
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        turns._admit_turn_locked.assert_not_awaited()

    async def test_real_bridge_changed_credential_source_during_prepare_rejects_successor(self):
        turns, queued, old_authority, _bridge = await self.bridge_recovery(
            change={"credential_generation": 2}
        )
        turns._admit_turn_locked = AsyncMock()
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        self.assertFalse(old_authority.current())
        turns._admit_turn_locked.assert_not_awaited()
        self.assertNotIn(SESSION_ID, self.recovery._readmissions)

    async def test_real_bridge_revocation_in_release_gap_rejects_successor(self):
        turns, queued, old_authority, _bridge = await self.bridge_recovery(revoke=True)
        turns._admit_turn_locked = AsyncMock()
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        self.assertFalse(old_authority.current())
        turns._admit_turn_locked.assert_not_awaited()

    async def prepared_recovery(self):
        turns, queued = await self.refreshed_recovery()
        source = queued.body[RECOVERY_SOURCE]
        async with self.live.lifecycle_lock:
            token = await self.recovery.prepare_readmission(
                self.live, source, queued.queued_message_id
            )
        self.assertIsNotNone(token)
        await turns._prepare(self.live, request_id=queued.queued_message_id)
        return token, queued, source

    async def test_preparation_keeps_the_original_generation_on_an_unchanged_attachment(self):
        turns, queued = await self.refreshed_recovery()
        source = queued.body[RECOVERY_SOURCE]
        token = await self.recovery.prepare_readmission(self.live, source, queued.queued_message_id)
        turns._prepare = AsyncMock()
        await turns._prepare(self.live, request_id=queued.queued_message_id)
        self.assertTrue(await self.recovery.complete_readmission(self.live, token))
        fence = await self.recovery.admission(self.live, source, queued.queued_message_id)
        self.assertIsNotNone(fence)
        self.assertEqual(fence.generation, "generation-2")
        self.live.process_environment["CHANGED"] = "new-value"
        self.assertFalse(fence.current())

    async def test_preparation_requires_the_actual_resource_owner_before_any_refresh(self):
        turns, queued = await self.refreshed_recovery()
        self.live.resource_task = None
        turns._admit_turn_locked = AsyncMock()
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        turns._prepare.assert_not_awaited()
        turns._admit_turn_locked.assert_not_awaited()

    async def test_unchanged_attachment_cannot_silently_adopt_another_resource_lease(self):
        _turns, queued = await self.refreshed_recovery()
        token = await self.recovery.prepare_readmission(
            self.live, queued.body[RECOVERY_SOURCE], queued.queued_message_id
        )
        self.runtime.resource_evidence = ResourceEvidence(
            "event",
            f"{queued.queued_message_id}:{uuid.uuid4().hex}",
            "other-reservation",
            "other-host",
            "other-lease",
            "execution",
            "attached",
            1.0,
            (),
            1,
        )
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_successor_started_by_another_owner_during_prepare_cannot_be_readmitted(self):
        token, queued, _source = await self.prepared_recovery()
        self.assertIsNotNone(
            self.catalog.begin_queued_submission(SESSION_ID, queued.queued_message_id)
        )
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_checkpoint_identity_changed_during_prepare_invalidates_its_token(self):
        token, _queued, _source = await self.prepared_recovery()
        token.checkpoint.incident_id = "another-incident"
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_unresolved_unknown_retry_never_enters_normal_preparation(self):
        turns, queued = await self.refreshed_recovery()
        self.recovery._checkpoints[SESSION_ID].action = RecoveryAction.RETRY
        self.live.ledger = await self.unknown_ledger()
        result = await turns._prepare_queued(self.live, queued.queued_message_id)
        self.assertEqual(result.error, RECOVERY_STALE)
        turns._prepare.assert_not_awaited()
        self.assertTrue(self.live.ledger.has_unknown_outcome)

    async def test_completed_native_snapshot_cannot_be_readmitted_as_continue(self):
        token, _queued, source = await self.prepared_recovery()
        self.live.runtime_session.snapshot.return_value["resume_turns"][0][
            "terminal_status"
        ] = "completed"
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertFalse(await self.recovery.current(self.live, source))
        self.assertNotIn(SESSION_ID, self.recovery._readmissions)

    async def test_unrelated_resource_admission_does_not_authorize_a_refreshed_host(self):
        token, queued, _source = await self.prepared_recovery()
        session = self.live.runtime_session
        session.resource_evidence = replace(
            session.resource_evidence,
            request_id=f"{queued.queued_message_id}:external:{uuid.uuid4().hex}",
        )
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertIsNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_PREPARED))
        )

    async def test_readmission_rejects_a_second_attachment_created_during_preparation(self):
        token, _queued, _source = await self.prepared_recovery()
        self.live.attachment_generation += 1
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_readmission_rejects_another_native_thread(self):
        token, _queued, _source = await self.prepared_recovery()
        binding = replace(self.live.runtime_binding, opaque_session_ref="other-thread")
        self.live.runtime_session.binding = binding
        self.live.runtime_binding = binding
        self.live.vendor_thread_id = "other-thread"
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_selected_model_intent_change_during_preparation_stops_readmission(self):
        token, _queued, _source = await self.prepared_recovery()
        self.catalog.set_model(SESSION_ID, SessionPrincipal("owner"), "different-model")
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_incomplete_execution_tree_after_refresh_cannot_be_readmitted(self):
        token, _queued, _source = await self.prepared_recovery()
        session = self.live.runtime_session
        session.activity.return_value = replace(
            session.activity.return_value, execution_tree_complete=False
        )
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_new_unknown_during_preparation_never_authorizes_the_successor(self):
        token, _queued, _source = await self.prepared_recovery()
        self.live.ledger = await self.unknown_ledger()
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertTrue(self.live.ledger.has_unknown_outcome)

    async def test_prepared_writer_fence_rechecks_static_intent_and_resource_ownership(self):
        token, queued, source = await self.prepared_recovery()
        self.assertTrue(await self.recovery.complete_readmission(self.live, token))
        fence = await self.recovery.admission(self.live, source, queued.queued_message_id)
        self.assertIsNotNone(fence)
        self.assertTrue(fence.current())
        for attribute, changed in (
            ("reasoning_effort", "different"),
            ("thinking", object()),
            ("runtime_workdir", self.root / "changed"),
            ("project_path", self.root / "changed"),
            ("output_root", self.root / "changed"),
            ("writable_roots", (self.root,)),
            ("skill_configurations", (object(),)),
            ("interrupt_generation", 1),
            ("runtime_driver", object()),
        ):
            with self.subTest(attribute=attribute):
                original = getattr(self.live, attribute)
                setattr(self.live, attribute, changed)
                self.assertFalse(fence.current())
                setattr(self.live, attribute, original)
                self.assertTrue(fence.current())
        self.live.runtime_session.resource_evidence = replace(
            self.live.runtime_session.resource_evidence, lease_id="another-lease"
        )
        self.assertFalse(fence.current())

    async def test_preparation_refuses_a_generation_changed_before_token_capture(self):
        _turns, queued = await self.refreshed_recovery()
        activity = self.runtime.activity.return_value
        self.runtime.activity.side_effect = [
            activity,
            activity,
            replace(activity, generation="third"),
        ]
        self.assertIsNone(
            await self.recovery.prepare_readmission(
                self.live, queued.body[RECOVERY_SOURCE], queued.queued_message_id
            )
        )

    async def test_nested_queued_body_mutation_cannot_reuse_the_preparation_proof(self):
        token, queued, _source = await self.prepared_recovery()
        queued.body["input"][0]["text"] = "changed after preparation started"
        self.catalog.update_queued_message(SESSION_ID, queued.queued_message_id, queued.body)
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_new_approval_during_preparation_preserves_the_failed_readmission_fence(self):
        token, _queued, source = await self.prepared_recovery()
        self.live.pending_hil_snapshot.return_value = [{"request_id": "approval"}]
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.live.pending_hil_snapshot.return_value = []
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertFalse(await self.recovery.current(self.live, source))

    async def test_cancelled_successor_during_preparation_cannot_be_readmitted(self):
        token, queued, _source = await self.prepared_recovery()
        self.catalog.delete_queued_message(SESSION_ID, queued.queued_message_id)
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))

    async def test_persist_failure_never_installs_a_usable_prepared_handoff(self):
        token, queued, source = await self.prepared_recovery()
        with patch.object(self.recovery, "_record", AsyncMock(side_effect=OSError("disk full"))):
            with self.assertRaisesRegex(OSError, "disk full"):
                await self.recovery.complete_readmission(self.live, token)
        self.assertNotIn(SESSION_ID, self.recovery._readmissions)
        self.assertFalse(await self.recovery.current(self.live, source))
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertIsNone(
            await self.recovery.prepare_readmission(self.live, source, queued.queued_message_id)
        )

    async def test_cancel_while_persisting_prepared_state_never_installs_a_handoff(self):
        token, queued, source = await self.prepared_recovery()
        publish = self.live.publish

        async def cancel(kind, payload, **kwargs):
            record = await publish(kind, payload, **kwargs)
            self.catalog.delete_queued_message(SESSION_ID, queued.queued_message_id)
            return record

        self.live.publish = cancel
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertIsNotNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_PREPARED))
        )
        self.assertNotIn(SESSION_ID, self.recovery._readmissions)
        self.assertFalse(await self.recovery.current(self.live, source))

    async def test_prepared_successor_cannot_be_refreshed_or_readmitted_twice(self):
        token, queued, source = await self.prepared_recovery()
        self.assertTrue(await self.recovery.complete_readmission(self.live, token))
        record = self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_PREPARED))
        self.assertEqual(record.payload["successor"], queued.queued_message_id)
        self.assertEqual(record.payload["source"], source)
        self.assertEqual(record.payload["from_generation"], "generation-2")
        self.assertEqual(record.payload["generation"], "new-host:1")
        self.assertIsNone(record.payload["source_authority"])
        self.assertIsNone(record.payload["authority"])
        self.assertFalse(await self.recovery.complete_readmission(self.live, token))
        self.assertIsNone(
            await self.recovery.prepare_readmission(self.live, source, queued.queued_message_id)
        )
        self.recovery._readmissions.clear()
        self.assertFalse(await self.recovery.current(self.live, source))

    async def test_unknown_retry_preserves_original_input_and_confirms_before_schedule(self):
        turns = await self.queued_recovery()
        self.runtime.snapshot.return_value = {"resume_turns": []}
        self.live.ledger = await self.unknown_ledger()
        self.recovery._checkpoints[SESSION_ID].observed = False
        self.runtime.activity.return_value = replace(
            self.runtime.activity.return_value, blockers=("unsettled",)
        )

        async def confirm(live, turn_id):
            self.assertTrue(live.lifecycle_lock.locked())
            self.assertIsNotNone(
                self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED))
            )
            turns._schedule_locked.assert_not_called()
            confirmed = await live.ledger.confirm_unknown_turn(turn_id, automatic_retry=True)
            self.runtime.activity.return_value = replace(
                self.runtime.activity.return_value, blockers=()
            )
            return confirmed

        self.recovery.bind_confirmation(confirm)
        await self.recover()
        turns._schedule_locked.assert_called_once()
        queued = self.catalog.queued_messages(SESSION_ID)
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0].body["input"], [{"type": "text", "text": "original"}])
        self.assertEqual(queued[0].body[RECOVERY_SOURCE]["action"], RecoveryAction.RETRY.value)
        self.assertFalse(self.live.ledger.has_unknown_outcome)

    async def test_interrupt_during_confirmation_prevents_automatic_retry(self):
        turns = await self.queued_recovery()
        self.runtime.snapshot.return_value = {"resume_turns": []}
        self.live.ledger = await self.unknown_ledger()

        async def confirm(live, turn_id):
            confirmed = await live.ledger.confirm_unknown_turn(turn_id, automatic_retry=True)
            live.interrupt_generation += 1
            return confirmed

        self.recovery.bind_confirmation(confirm)
        await self.recover()
        turns._schedule_locked.assert_not_called()
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_enqueue_failure_preserves_original_and_consumes_one_attempt(self):
        turns = await self.queued_recovery()
        turns._enqueue = AsyncMock(return_value=({"ok": False}, 409))
        await self.recover()
        self.assertIsNotNone(
            self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED))
        )
        await turns._enqueue_recovery(
            self.live, self.recovery._checkpoints[SESSION_ID], "generation-2"
        )
        turns._enqueue.assert_awaited_once()
        turns._schedule_locked.assert_not_called()
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_confirmation_failure_preserves_unknown_and_never_schedules(self):
        turns = await self.queued_recovery()
        self.runtime.snapshot.return_value = {"resume_turns": []}
        self.live.ledger = await self.unknown_ledger()
        self.recovery.bind_confirmation(AsyncMock(return_value=False))
        await self.recover()
        turns._schedule_locked.assert_not_called()
        self.assertTrue(self.live.ledger.has_unknown_outcome)
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_authorized_retry_releases_retained_product_turn_before_preparation(self):
        turns = await self.queued_recovery()
        self.live.active_product_turn_id = CLIENT_ID

        async def release(client_id):
            self.assertEqual(client_id, CLIENT_ID)
            self.live.active_product_turn_id = ""
            return True

        self.live.release_product_turn = AsyncMock(side_effect=release)
        await self.recover()
        self.live.release_product_turn.assert_awaited_once_with(CLIENT_ID)
        self.assertEqual(self.live.active_product_turn_id, "")
        turns._schedule_locked.assert_called_once()

    async def test_failed_product_turn_release_keeps_original_queue(self):
        turns = await self.queued_recovery()
        self.live.active_product_turn_id = CLIENT_ID
        self.live.end_browser_scope = AsyncMock(return_value=False)

        async def release(client_id):
            return await LiveSession.release_product_turn(self.live, client_id)

        self.live.release_product_turn = release
        await self.recover()
        turns._schedule_locked.assert_not_called()
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_scope_cleanup_failure_does_not_release_product_provenance(self):
        for runtime in (self.runtime, None):
            live = SimpleNamespace(
                active_product_turn_id=CLIENT_ID,
                runtime_session=runtime,
                end_browser_scope=AsyncMock(return_value=False),
            )
            self.assertFalse(await LiveSession.release_product_turn(live, CLIENT_ID))
            self.assertEqual(live.active_product_turn_id, CLIENT_ID)

    async def test_stale_recovery_retains_failed_request_instead_of_silently_removing_it(self):
        turns = await self.queued_recovery()
        await self.recover()
        queued = self.catalog.queued_messages(SESSION_ID)[0]
        self.runtime.activity.return_value = replace(
            self.runtime.activity.return_value, generation="generation-3"
        )
        turns._defer_queue = Mock()
        await turns._prepare_queued(self.live, queued.queued_message_id)
        failed = self.catalog.queued_message(SESSION_ID, queued.queued_message_id)
        self.assertIs(failed.state, QueuedMessageState.FAILED)
        self.assertEqual(failed.safe_error, RECOVERY_STALE)

    async def test_original_queue_cas_failure_never_schedules(self):
        turns = await self.queued_recovery()
        with patch.object(self.catalog, "remove_reconciled_unknown_message", return_value=False):
            await self.recover()
        turns._schedule_locked.assert_not_called()
        self.assertIs(
            self.catalog.queued_message(SESSION_ID, CLIENT_ID).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )

    async def test_completed_unknown_queue_is_settled_without_new_submission(self):
        turns = await self.queued_recovery()
        self.runtime.snapshot.return_value["resume_turns"][0]["terminal_status"] = "completed"
        await self.recover()
        turns._schedule_locked.assert_not_called()
        self.assertEqual(self.catalog.queued_messages(SESSION_ID), ())
        self.assertIsNone(self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_CLAIMED)))

    async def test_stream_guard_finishes_before_any_tool_bytes_are_sent(self):
        sent = []
        tool = sse({"type": "response.output_item.added", "item": {"type": "function_call"}})

        async def content():
            yield tool

        async def send(message):
            if message.get("body"):
                self.assertIsNotNone(
                    self.events.by_key(SESSION_ID, recovery_key(CLIENT_ID, RECOVERY_EXPOSED))
                )
                sent.append(message["body"])

        async def receive():
            await asyncio.Future()

        call = CompletionCall(
            asyncio.get_running_loop(),
            None,
            lambda _call: None,
            CompletionDiagnostic(SESSION_ID, "model", turn_id=CLIENT_ID),
            before_output=self.recovery.before_output,
        )
        response = CompletionStream(content(), call)
        await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        self.assertEqual(sent, [tool])

    async def test_automatic_recovery_does_not_ask_for_another_retry_decision(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        source = self.recovery.source(checkpoint, "generation-2")
        turns = TurnService(
            self.sessions,
            logging.getLogger(__name__),
            activities=self.activities,
            catalog=self.catalog,
            events=self.events,
        )
        self.addAsyncCleanup(turns.aclose)
        turns.recovery = self.recovery
        turns._typed_input = AsyncMock(
            return_value=TurnAdmission(
                TurnInput((InputItem(InputKind.TEXT, text="original"),), "successor"),
                "original",
                {},
                (),
            )
        )
        self.live.project_path = None
        self.live.product_turn_generation = 0
        self.live.trace_turn_input = Mock()
        self.live.refresh_skills = AsyncMock()
        self.live.record_user_history = AsyncMock()
        turns._execute = AsyncMock()
        payload, _status, task = await turns._admit_turn_locked(self.live, {}, recovery=source)
        self.assertTrue(payload["ok"])
        await task
        instruction = turns._execute.call_args.args[1].items[0].text
        self.assertNotIn("ask before repeating", instruction)
        self.assertIn("already authorized", instruction)

    async def test_delivery_baseline_wait_cannot_authorize_a_new_process_generation(self):
        await self.recover()
        checkpoint = self.recovery._checkpoints[SESSION_ID]
        await self.recovery.claim(self.live, checkpoint, "generation-2")
        source = self.recovery.source(checkpoint, "generation-2")
        started = asyncio.Event()
        release = asyncio.Event()

        async def baseline(*_args):
            started.set()
            await release.wait()
            return SimpleNamespace(model_context="")

        turns = TurnService(
            self.sessions,
            logging.getLogger(__name__),
            activities=self.activities,
            catalog=self.catalog,
            events=self.events,
            deliveries=SimpleNamespace(begin_turn=baseline),
        )
        self.addAsyncCleanup(turns.aclose)
        turns.recovery = self.recovery
        turns._typed_input = AsyncMock(
            return_value=TurnAdmission(
                TurnInput((InputItem(InputKind.TEXT, text="continue"),), "successor"),
                "continue",
                {},
                (),
            )
        )
        self.live.project_path = self.root
        self.live.trace_turn_input = Mock()
        self.live.refresh_skills = AsyncMock()
        self.live.record_user_history = AsyncMock()
        turns._execute = AsyncMock()
        operation = asyncio.create_task(turns._admit_turn_locked(self.live, {}, recovery=source))
        await started.wait()
        self.runtime.activity.return_value = replace(
            self.runtime.activity.return_value, generation="generation-3"
        )
        release.set()
        payload, _status, task = await operation
        self.assertIsNone(task)
        self.assertEqual(payload["error"], RECOVERY_STALE)
        turns._execute.assert_not_awaited()
        self.live.record_user_history.assert_not_awaited()

    async def test_cancelled_and_queued_automatic_input_never_impersonates_the_user(self):
        queued = self.catalog.enqueue_message(
            SESSION_ID,
            "successor",
            {
                "input": [{"type": "text", "text": "internal recovery prompt"}],
            },
            purpose=QUEUE_PURPOSE_RECOVERY,
        )
        projected = queued_message_payload(queued)
        self.assertNotIn("internal recovery prompt", str(projected))
        await LiveSession.record_cancelled_user_history(self.live, queued)
        cancelled = self.events.latest_kind(SESSION_ID, PRODUCT_EVENT_USER_MESSAGE)
        self.assertEqual(cancelled.payload["origin"], "recovery")
        self.assertNotIn("internal recovery prompt", cancelled.payload["text"])


class HandoffContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="handoff-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.owner = SessionPrincipal("owner")
        self.catalog.register(
            "source",
            self.owner,
            runtime_id="codex",
            vendor_thread_id="source-thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="contract",
            model_id="original-model",
            policy_id="ask",
            status=SessionStatus.ERROR,
            title="Original task",
            created_at=1,
        )
        self.events = ProductEventStore(self.catalog.database)
        self.sessions = {}
        self.runtime = Mock()
        self.service = SessionService(
            self.root,
            self.sessions,
            activities=Activities(),
            access=self.catalog,
            events=self.events,
            runtime=self.runtime,
            workspaces=Mock(),
            artifacts=Mock(),
            settings=Mock(),
            credentials=Mock(),
            logger=Mock(),
        )
        self.sequence = 0

    def append(self, kind, text="", *, turn="done", item=None, **payload):
        self.sequence += 1
        if text:
            payload["text" if kind == PRODUCT_EVENT_USER_MESSAGE else "delta"] = text
        return self.events.append(
            session_id="source",
            runtime_id="codex",
            vendor_thread_id="source-thread",
            vendor_turn_id=turn,
            vendor_item_id=item or f"item-{self.sequence}",
            kind=kind,
            payload=payload,
            idempotency_key=f"handoff-{self.sequence}",
        )

    def history(self):
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Original objective",
            client_turn_id="first",
            binding="admitted",
            origin="turn",
            refs=[{"text": "private attachment body"}],
        )
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Original objective",
            client_turn_id="first",
            binding="bound",
            origin="turn",
        )
        self.append(PRODUCT_EVENT_MESSAGE_DELTA, "partial", item="answer")
        self.append(
            PRODUCT_EVENT_MESSAGE_DELTA, "Completed answer", item="answer", phase="final_answer"
        )
        self.append(PRODUCT_EVENT_MESSAGE_DELTA, "commentary only", phase="commentary")
        self.append(PRODUCT_EVENT_REASONING_DELTA, "private reasoning")
        self.append(PRODUCT_EVENT_TOOL_OUTPUT_DELTA, "private tool output")
        self.append(PRODUCT_EVENT_TURN_COMPLETED, status="completed")
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Cancelled request",
            client_turn_id="cancelled",
            binding="admitted",
            turn="cancelled",
        )
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Cancelled request",
            client_turn_id="cancelled",
            binding="cancelled",
            turn="cancelled",
        )
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "internal recovery prompt",
            origin="recovery",
            turn="recovery",
        )
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Latest request",
            client_turn_id="last",
            origin="turn",
            binding="bound",
            turn="failed",
        )
        self.append(PRODUCT_EVENT_MESSAGE_DELTA, "Unfinished response", turn="failed")
        return self.append(PRODUCT_EVENT_TURN_FAILED, turn="failed", code="known-capability-error")

    def live(self):
        return SimpleNamespace(
            lifecycle_lock=asyncio.Lock(),
            running=False,
            closing=False,
            interrupting=False,
            steer_lock=asyncio.Lock(),
            resource_task=None,
            active_product_turn_id="",
            ledger=SimpleNamespace(has_unknown_outcome=False),
        )

    async def test_visible_completed_text_only_and_no_source_write_or_runtime_call(self):
        terminal = self.history()
        self.catalog.set_model("source", self.owner, "selected-model")
        before = self.catalog.get("source")
        events_before = self.events.replay("source")
        with patch.object(
            self.catalog, "model_state", side_effect=AssertionError("read backfill forbidden")
        ):
            payload, status = await self.service.continuation(
                "source", self.owner, turn_id="failed"
            )
        self.assertEqual(status, 200)
        self.assertEqual(payload["source_session_id"], "source")
        self.assertEqual(payload["source_product_seq"], terminal.product_seq)
        self.assertEqual(payload["source_title"], "Original task")
        self.assertIsNone(payload["project_path"])
        self.assertEqual(payload["model_id"], "selected-model")
        self.assertEqual(
            payload["messages"],
            [
                {"role": "user", "text": "Original objective"},
                {"role": "assistant", "text": "Completed answer"},
                {"role": "user", "text": "Latest request"},
            ],
        )
        self.assertEqual(payload["included_messages"], 3)
        self.assertEqual(payload["omitted_messages"], 0)
        self.assertEqual(payload["omitted_characters"], 0)
        self.assertFalse(payload["truncated"])
        self.assertIn("encrypted_content", payload["excluded_categories"])
        self.assertIn("attachments", payload["excluded_categories"])
        self.assertEqual(self.catalog.get("source"), before)
        self.assertEqual(self.events.replay("source"), events_before)
        self.assertEqual(self.sessions, {})
        self.assertEqual(self.runtime.mock_calls, [])

    async def test_source_access_missing_model_and_stale_turn_are_explicit(self):
        self.history()
        with self.assertRaises(Exception) as denied:
            await self.service.continuation("source", SessionPrincipal("other"))
        self.assertEqual(type(denied.exception).__name__, "SessionAccessError")
        payload, status = await self.service.continuation("source", self.owner, turn_id="done")
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "session_continuation_stale")
        with patch.object(self.catalog, "continuation_state", return_value=("", False)):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "session_continuation_model_unavailable")

    async def test_product_busy_queue_hil_and_unknown_result_reject_without_reading_history(self):
        self.history()
        with patch.object(
            self.events, "continuation_records", side_effect=AssertionError("unsafe history read")
        ):
            for field in ("running", "closing", "interrupting", "active_product_turn_id"):
                live = self.live()
                setattr(live, field, True)
                self.sessions["source"] = live
                payload, status = await self.service.continuation("source", self.owner)
                self.assertEqual((status, payload["error"]), (409, "session_continuation_busy"))
            self.sessions.clear()
            self.catalog.enqueue_message("source", "queued", {"text": "queued private input"})
            payload, status = await self.service.continuation("source", self.owner)
            self.assertEqual(status, 409)
            self.catalog.delete_queued_message("source", "queued")
            self.catalog.record_hil(
                product_request_id="hil",
                session_id="source",
                vendor_request_id="vendor",
                vendor_turn_id="failed",
                vendor_item_id=None,
                method="approval",
                payload={"private": "tool input"},
            )
            payload, status = await self.service.continuation("source", self.owner)
            self.assertEqual(status, 409)
            self.catalog.expire_pending_hil("source")
            self.catalog.claim_uncertainty(
                "source",
                UncertaintyKind.TURN,
                "failed",
                state=UncertaintyState.UNKNOWN,
                payload={"private": "unknown input"},
            )
            payload, status = await self.service.continuation("source", self.owner)
            self.assertEqual(status, 409)

    async def test_failed_queue_is_preserved_but_unknown_queue_still_blocks_manual_handoff(self):
        self.history()
        self.catalog.enqueue_message("source", "failed-request", {"text": "private queued body"})
        self.catalog.begin_queued_submission("source", "failed-request")
        self.catalog.fail_queued_submission(
            "source", "failed-request", unknown=False, safe_error="terminal_capability_rejection"
        )
        failed = self.catalog.queued_message("source", "failed-request")
        self.assertEqual(failed.state, QueuedMessageState.FAILED)
        self.assertEqual(self.catalog.queued_messages("source"), (failed,))
        source = self.catalog.get("source")
        payload, status = await self.service.continuation("source", self.owner, turn_id="failed")
        self.assertEqual(status, 200)
        self.assertEqual(payload["messages"][-1], {"role": "user", "text": "Latest request"})
        self.assertNotIn("private queued body", str(payload))
        self.assertEqual(self.catalog.queued_message("source", "failed-request"), failed)
        self.assertEqual(self.catalog.get("source"), source)
        self.catalog.enqueue_message("source", "unknown-request", {"text": "unknown queued body"})
        self.catalog.begin_queued_submission("source", "unknown-request")
        self.catalog.fail_queued_submission(
            "source", "unknown-request", unknown=True, safe_error="transport_lost"
        )
        unknown = self.catalog.queued_message("source", "unknown-request")
        self.assertEqual(unknown.state, QueuedMessageState.OUTCOME_UNKNOWN)
        with patch.object(
            self.events, "continuation_records", side_effect=AssertionError("unsafe history read")
        ):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual((status, payload["error"]), (409, "session_continuation_busy"))
        self.assertEqual(self.catalog.queued_message("source", "unknown-request"), unknown)
        self.assertEqual(self.catalog.queued_message("source", "failed-request"), failed)
        self.assertEqual(self.runtime.mock_calls, [])

    async def test_lifecycle_lock_is_held_for_snapshot_and_watermark_is_bounded(self):
        terminal = self.history()
        live = self.live()
        self.sessions["source"] = live
        await live.lifecycle_lock.acquire()
        pending = asyncio.create_task(self.service.continuation("source", self.owner))
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        live.running = True
        live.lifecycle_lock.release()
        self.assertEqual((await pending)[1], 409)
        live.running = False
        project = self.events.continuation_records

        def concurrent_append(*args, **kwargs):
            self.assertTrue(live.lifecycle_lock.locked())
            self.append(PRODUCT_EVENT_USER_MESSAGE, "after snapshot", turn="future")
            return project(*args, **kwargs)

        with patch.object(self.events, "continuation_records", side_effect=concurrent_append):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(status, 200)
        self.assertEqual(payload["source_product_seq"], terminal.product_seq)
        self.assertNotIn("after snapshot", str(payload))

    async def test_message_character_and_utf8_json_budgets_preserve_first_goal_and_recent_text(
        self,
    ):
        self.append(PRODUCT_EVENT_USER_MESSAGE, "FIRST GOAL " + "中" * 5000, client_turn_id="first")
        for index in range(40):
            self.append(
                PRODUCT_EVENT_USER_MESSAGE,
                f"recent-{index}:" + '"\\😀' * 600,
                turn=f"turn-{index}",
                client_turn_id=f"client-{index}",
            )
        self.append(PRODUCT_EVENT_TURN_FAILED, turn="turn-39")
        payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(status, 200)
        self.assertLessEqual(len(payload["messages"]), 30)
        self.assertLessEqual(sum(len(message["text"]) for message in payload["messages"]), 24000)
        self.assertLessEqual(
            len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()), 96 * 1024
        )
        self.assertTrue(payload["messages"][0]["text"].startswith("FIRST GOAL"))
        self.assertTrue(payload["messages"][-1]["text"].startswith("recent-39:"))
        self.assertTrue(payload["truncated"])
        self.assertGreater(payload["omitted_messages"], 0)
        self.assertGreater(payload["omitted_characters"], 0)
        total_characters = len("FIRST GOAL " + "中" * 5000) + sum(
            len(f"recent-{index}:" + '"\\😀' * 600) for index in range(40)
        )
        self.assertEqual(
            payload["omitted_characters"],
            total_characters - sum(len(message["text"]) for message in payload["messages"]),
        )

    async def test_utf8_serialization_budget_counts_escaped_characters_and_marks_partial_messages(
        self,
    ):
        self.append(PRODUCT_EVENT_USER_MESSAGE, "Original goal", client_turn_id="first")
        self.append(
            PRODUCT_EVENT_USER_MESSAGE,
            "Newest request " + '\x00😀\\"' * 10000,
            turn="failed",
            client_turn_id="newest",
        )
        self.append(PRODUCT_EVENT_TURN_FAILED, turn="failed")
        with patch("service.chat.service.handoff.CONTINUATION_MAX_BYTES", 1024):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(status, 200)
        self.assertLessEqual(
            len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()), 1024
        )
        self.assertEqual(payload["messages"][0], {"role": "user", "text": "Original goal"})
        self.assertTrue(payload["messages"][-1]["text"].startswith("Newest request"))
        self.assertEqual(payload["omitted_messages"], 0)
        self.assertGreater(payload["omitted_characters"], 0)
        self.assertTrue(payload["truncated"])

    async def test_query_only_connections_and_missing_model_row_never_backfill(self):
        self.history()
        catalog_connect = self.catalog._connect
        events_connect = self.events._connect

        def read_only(connect):
            def open_read_only():
                connection = connect()
                connection.execute("PRAGMA query_only = ON")
                return connection

            return open_read_only

        with (
            patch.object(self.catalog, "_connect", side_effect=read_only(catalog_connect)),
            patch.object(self.events, "_connect", side_effect=read_only(events_connect)),
        ):
            payload, status = await self.service.continuation("source", self.owner)
            self.assertEqual(status, 200)
            self.assertEqual(payload["model_id"], "original-model")
        connection = catalog_connect()
        try:
            connection.execute("DELETE FROM session_model_state WHERE session_id = ?", ("source",))
            connection.commit()
        finally:
            connection.close()
        with patch.object(self.catalog, "_connect", side_effect=read_only(catalog_connect)):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(
            (status, payload["error"]), (409, "session_continuation_model_unavailable")
        )

    async def test_persisted_running_state_and_event_scan_limit_fail_closed(self):
        self.history()
        self.catalog.update_status("source", SessionStatus.RUNNING)
        self.assertEqual((await self.service.continuation("source", self.owner))[1], 409)
        self.catalog.update_status("source", SessionStatus.ERROR)
        with patch("service.chat.service.sessions.CONTINUATION_MAX_SOURCE_EVENTS", 1):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual((status, payload["error"]), (409, "session_continuation_unavailable"))
        with patch("service.chat.service.sessions.CONTINUATION_MAX_SOURCE_BYTES", 1):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual((status, payload["error"]), (409, "session_continuation_unavailable"))

    async def test_child_thread_messages_cannot_be_published_as_main_history(self):
        self.history()
        for kind in (PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_TURN_COMPLETED):
            with self.assertRaises(SessionBindingConflictError):
                self.events.append(
                    session_id="source",
                    runtime_id="codex",
                    vendor_thread_id="child-thread",
                    vendor_turn_id="child-turn",
                    vendor_item_id="child-message",
                    kind=kind,
                    payload={"delta": "private child message"},
                    idempotency_key=f"child-{kind}",
                )
        self.append(PRODUCT_EVENT_SUBAGENT_COMPLETED, "private child activity body", turn="failed")
        record = self.events._record

        def allowed_body_only(row):
            self.assertIn(
                row["kind"],
                {
                    PRODUCT_EVENT_USER_MESSAGE,
                    PRODUCT_EVENT_MESSAGE_DELTA,
                    PRODUCT_EVENT_TURN_COMPLETED,
                },
            )
            return record(row)

        with patch.object(self.events, "_record", side_effect=allowed_body_only):
            payload, status = await self.service.continuation("source", self.owner)
        self.assertEqual(status, 200)
        self.assertNotIn("private child", str(payload))
        self.assertEqual(payload["messages"][1], {"role": "assistant", "text": "Completed answer"})

    async def test_inline_resource_budget_is_checked_before_materialization(self):
        original = self.append(PRODUCT_EVENT_USER_MESSAGE, "original", client_turn_id="first")
        connection = self.catalog._connect()
        try:
            connection.execute(
                "UPDATE product_event SET payload = ?, payload_ref = NULL, "
                "payload_bytes = NULL, client_turn_id = NULL WHERE event_id = ?",
                (json.dumps({"text": "large inline body " * 200}), original.event_id),
            )
            connection.commit()
        finally:
            connection.close()
        with (
            patch.object(
                self.events, "_materialize", side_effect=AssertionError("body materialized")
            ),
            patch.object(blocks.BlockStore, "_decode", side_effect=AssertionError("block decoded")),
        ):
            with self.assertRaises(ValueError):
                self.events.continuation_records(
                    "source", through_seq=original.product_seq, limit=100, byte_limit=1024
                )

    async def test_journal_physical_record_budget_is_checked_before_materialization(self):
        original = self.append(PRODUCT_EVENT_USER_MESSAGE, '\\"😀' * 100, client_turn_id="first")
        connection = self.catalog._connect()
        try:
            metadata = connection.execute(
                "SELECT event.payload_bytes, body.length FROM product_event AS event "
                f"JOIN {journal.BODY_TABLE} AS body ON body.digest = substr(event.payload_ref, ?) "
                "WHERE event.event_id = ?",
                (len(journal.REFERENCE_PREFIX) + 1, original.event_id),
            ).fetchone()
        finally:
            connection.close()
        budget = metadata["payload_bytes"] + 1
        self.assertGreater(metadata["length"], budget)
        with (
            patch.object(
                self.events, "_materialize", side_effect=AssertionError("body materialized")
            ),
            patch.object(
                journal.Journal, "_read_indexed", side_effect=AssertionError("journal read")
            ),
        ):
            with self.assertRaises(ValueError):
                self.events.continuation_records(
                    "source", through_seq=original.product_seq, limit=100, byte_limit=budget
                )

    async def test_all_scanned_block_extents_are_checked_before_decode(self):
        original = self.append(PRODUCT_EVENT_MESSAGE_DELTA, "completed text " * 100, item="answer")
        self.append(PRODUCT_EVENT_MESSAGE_DELTA, "completed text " * 101, item="answer")
        connection = self.catalog._connect()
        try:
            metadata = connection.execute(
                f"SELECT SUM((committed_end - offset) * count) AS decoded_bound FROM {blocks.TABLE} WHERE session_id = ?",
                ("source",),
            ).fetchone()
        finally:
            connection.close()
        budget = metadata["decoded_bound"] - 1
        with (
            patch.object(
                self.events, "_materialize", side_effect=AssertionError("body materialized")
            ),
            patch.object(blocks.BlockStore, "_decode", side_effect=AssertionError("block decoded")),
        ):
            with self.assertRaises(ValueError):
                self.events.continuation_records(
                    "source", through_seq=original.product_seq, limit=100, byte_limit=budget
                )

    async def test_ordinary_and_block_preflight_share_one_cumulative_budget(self):
        terminal = self.history()
        connection = self.catalog._connect()
        try:
            ordinary = connection.execute(
                "SELECT SUM(length(CAST(event.payload AS BLOB)) + "
                "COALESCE(length(CAST(event.payload_ref AS BLOB)), 0) + COALESCE(body.length, 0)) "
                "FROM product_event AS event "
                f"LEFT JOIN {journal.BODY_TABLE} AS body ON body.digest = substr(event.payload_ref, ?) "
                "WHERE event.session_id = ? AND event.kind IN (?, ?)",
                (
                    len(journal.REFERENCE_PREFIX) + 1,
                    "source",
                    PRODUCT_EVENT_USER_MESSAGE,
                    PRODUCT_EVENT_MESSAGE_DELTA,
                ),
            ).fetchone()[0]
            blocked = connection.execute(
                f"SELECT SUM((committed_end - offset) * count) FROM {blocks.TABLE} WHERE session_id = ?",
                ("source",),
            ).fetchone()[0]
        finally:
            connection.close()
        budget = max(ordinary, blocked)
        self.assertGreater(ordinary, 0)
        self.assertGreater(blocked, 0)
        with (
            patch.object(
                self.events, "_materialize", side_effect=AssertionError("body materialized")
            ),
            patch.object(blocks.BlockStore, "_decode", side_effect=AssertionError("block decoded")),
        ):
            with self.assertRaises(ValueError):
                self.events.continuation_records(
                    "source", through_seq=terminal.product_seq, limit=100, byte_limit=budget
                )

    async def test_http_get_is_authorized_passive_and_rejects_stale_card(self):
        self.history()
        app = FastAPI()
        mount_session_routes(
            app,
            sessions=self.service,
            turns=Mock(),
            events=Mock(),
            artifacts=Mock(),
            credentials=Mock(),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://contract"
        ) as client:
            with patch("service.chat.api.sessions.request_owner_id", return_value="owner"):
                response = await client.get(
                    "/api/serve/sessions/source/continuation?turn_id=failed"
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers.get("cache-control"), "no-store")
                self.assertEqual(response.json()["source_session_id"], "source")
                self.assertEqual(
                    (
                        await client.get("/api/serve/sessions/source/continuation?turn_id=done")
                    ).status_code,
                    409,
                )
            with patch("service.chat.api.sessions.request_owner_id", return_value="other"):
                self.assertEqual(
                    (await client.get("/api/serve/sessions/source/continuation")).status_code, 404
                )
        self.assertEqual(self.runtime.mock_calls, [])


if __name__ == "__main__":
    unittest.main()
