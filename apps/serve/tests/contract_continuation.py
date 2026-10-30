"""Crash continuation gates with real stores; fixtures are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx

from scholarseed_runtime.contract.capability import (
    CapabilitySet,
    CapabilityState,
    RuntimeCapability,
)
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
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
from scholarseed_runtime.contract.session import RuntimeActivitySnapshot
from service.chat.constants import PRODUCT_EVENT_HIL_REQUESTED, PRODUCT_EVENT_USER_MESSAGE
from service.chat.persistence.catalog import (
    QUEUE_PURPOSE_RECOVERY,
    QueuedMessageState,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
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
    RECOVERY_SOURCE,
    RECOVERY_STALE,
    RecoveryAction,
    RecoveryService,
    recovery_key,
    safe_model_output,
    safe_model_request,
)
from service.chat.service.streams import SSE_BUFFER_LIMIT, CompletionDiagnostic
from service.chat.service.turns import TurnAdmission, TurnService
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
                vendor_thread_id=THREAD_ID,
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


if __name__ == "__main__":
    unittest.main()
