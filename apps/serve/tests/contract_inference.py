"""Deterministic tool-free transport contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import json
import unittest
from contextlib import asynccontextmanager
from dataclasses import replace
from unittest.mock import Mock, patch

import httpx

from service.chat.service.completions import CompletionBridge, CompletionCleanupUnknown
from service.chat.service.models import API_BILLING, ModelService, SessionModelUnavailableError
from service.inference.transport import (
    CHAT_PROTOCOL,
    GENERATION_ERROR,
    INVOCATION_ACTIVE,
    RESPONSES_PROTOCOL,
    TOOL_FREE_UNSUPPORTED,
    TOOL_OUTPUT_UNSUPPORTED,
    InferenceProvider,
    chat_body,
    receive,
    responses_body,
)
from service.platform.inference import (
    ModelInvocationEventKind,
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationStatus,
)

HTTP_CLIENT = httpx.AsyncClient
REQUEST = ModelInvocationRequest(
    "invocation",
    "owner",
    "project",
    "assistant.translate",
    "model",
    "translate",
    "source",
    ModelInvocationLimits(100, 50),
)


def connection(protocol=RESPONSES_PROTOCOL):
    return {
        "key": "resolved-model",
        "billing": API_BILLING,
        "endpoint": "https://model.example.test/v1/responses",
        "headers": {"Authorization": "Bearer private-test-credential"},
        "wire_api": protocol,
        "model": "wire-model",
        "image_input": True,
        "pdf_input": True,
    }


def completed(protocol=RESPONSES_PROTOCOL, text="translated"):
    if protocol == RESPONSES_PROTOCOL:
        events = [
            {"type": "response.reasoning_summary_text.delta", "delta": "private reasoning"},
            {"type": "response.output_text.delta", "delta": text},
            {
                "type": "response.completed",
                "response": {
                    "id": "receipt",
                    "status": "completed",
                    "output": [
                        {"type": "message", "content": [{"type": "output_text", "text": text}]}
                    ],
                    "usage": {"input_tokens": 11, "output_tokens": 3},
                },
            },
        ]
    else:
        events = [
            {
                "id": "receipt",
                "choices": [{"delta": {"reasoning_content": "private reasoning", "content": text}}],
            },
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 3}},
        ]
    return httpx.Response(
        200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events)
    )


class InferenceContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.models = Mock(spec=ModelService)
        self.models.inference_connection.return_value = connection()

        @asynccontextmanager
        async def inference(*args, **kwargs):
            yield self.models.inference_connection(*args, **kwargs)

        self.models.inference.side_effect = inference
        self.provider = InferenceProvider(self.models)

    def client(self, handler):
        transport = httpx.MockTransport(handler)
        return patch(
            "service.inference.transport.httpx.AsyncClient",
            side_effect=lambda **kwargs: HTTP_CLIENT(transport=transport, **kwargs),
        )

    async def test_two_protocols_use_one_tool_free_request_and_preserve_usage(self):
        for protocol in (RESPONSES_PROTOCOL, CHAT_PROTOCOL):
            with self.subTest(protocol=protocol):
                self.models.inference_connection.return_value = connection(protocol)
                requests = []
                observed = []

                def handler(request):
                    requests.append(request)
                    return completed(protocol)

                async def observer(event):
                    observed.append(event)

                with self.client(handler):
                    result = await self.provider.invoke(REQUEST, observer=observer)
                self.assertEqual(len(requests), 1)
                body = json.loads(requests[0].content)
                self.assertEqual(body["tools"], [])
                self.assertEqual(body["tool_choice"], "none")
                self.assertEqual(body["model"], "wire-model")
                budget_key = "max_output_tokens" if protocol == RESPONSES_PROTOCOL else "max_tokens"
                self.assertEqual(body[budget_key], REQUEST.limits.max_output_tokens)
                self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
                self.assertEqual(result.model_key, "resolved-model")
                self.assertEqual(result.output_text, "translated")
                self.assertEqual((result.usage.input_tokens, result.usage.output_tokens), (11, 3))
                self.assertEqual(result.usage.receipt_id, "receipt")
                self.assertEqual(
                    [event.kind for event in observed],
                    [
                        ModelInvocationEventKind.STARTED,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        ModelInvocationEventKind.OUTPUT_COMPLETED,
                    ],
                )
                self.assertNotIn("private reasoning", str(observed))
                self.assertNotIn("private-test-credential", str(result))
                self.assertFalse(self.provider._active)

    async def test_unauthorized_direct_route_never_falls_back_to_agent_or_http(self):
        self.models.inference_connection.side_effect = SessionModelUnavailableError(
            TOOL_FREE_UNSUPPORTED
        )
        for tool_free in (False, True):
            with self.subTest(require_tool_free=tool_free), self.client(Mock()) as client:
                result = await self.provider.invoke(replace(REQUEST, require_tool_free=tool_free))
                self.assertEqual(result.status, ModelInvocationStatus.FAILED)
                self.assertEqual(result.error_code, TOOL_FREE_UNSUPPORTED)
                self.assertEqual(result.model_key, REQUEST.model_key)
                client.assert_not_called()

    async def test_connection_failure_submits_nothing_and_redacts_exception(self):
        self.models.inference_connection.side_effect = RuntimeError("private credential and input")
        with self.client(Mock()) as client:
            result = await self.provider.invoke(REQUEST)
        client.assert_not_called()
        self.assertEqual(result.status, ModelInvocationStatus.FAILED)
        self.assertNotIn("private credential", str(result))

    async def test_http_error_does_not_retry_or_fall_back(self):
        handler = Mock(return_value=httpx.Response(403, json={"error": {"code": "denied"}}))
        with self.client(handler):
            result = await self.provider.invoke(REQUEST)
        self.assertEqual(handler.call_count, 1)
        self.assertEqual(result.error_code, GENERATION_ERROR)
        self.assertNotIn("private-test-credential", str(result))

    async def test_cleanup_failure_keeps_the_invocation_unknown(self):
        @asynccontextmanager
        async def inference(*args, **kwargs):
            try:
                yield connection()
            finally:
                raise CompletionCleanupUnknown("private cleanup detail")

        self.models.inference.side_effect = inference
        with self.client(lambda request: completed()):
            result = await self.provider.invoke(REQUEST)
        self.assertEqual(result.status, ModelInvocationStatus.UNKNOWN)
        self.assertNotIn("private cleanup detail", str(result))

    async def test_registration_retirement_drains_despite_caller_cancellation(self):
        bridge = CompletionBridge("http://127.0.0.1:8770")
        registration = bridge.register(endpoint="https://model.example.test", api_key="")
        entered, finish = asyncio.Event(), asyncio.Event()

        async def close():
            entered.set()
            await finish.wait()

        call = Mock()
        call.task = None
        call.close = close
        bridge._upstreams[registration.bridge_id].calls.add(call)
        task = asyncio.create_task(bridge.release_registration(registration))
        await entered.wait()
        try:
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
            call.revoke.assert_called_once()
            self.assertNotIn(registration.bridge_id, bridge._upstreams)
        finally:
            finish.set()
            await asyncio.gather(task, return_exceptions=True)
            await bridge.close()

    async def test_cancel_is_owned_drains_transport_and_keeps_other_invocation(self):
        first_started, second_started = asyncio.Event(), asyncio.Event()
        second_finish, first_closed = asyncio.Event(), asyncio.Event()

        async def handler(request):
            if json.loads(request.content)["input"][0]["content"][0]["text"] == "first":
                first_started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    first_closed.set()
            second_started.set()
            await second_finish.wait()
            return completed()

        with self.client(handler):
            first = asyncio.create_task(self.provider.invoke(replace(REQUEST, input_text="first")))
            second = asyncio.create_task(
                self.provider.invoke(replace(REQUEST, invocation_id="second"))
            )
            await first_started.wait()
            await second_started.wait()
            try:
                rejected = await self.provider.cancel(invocation_id="invocation", owner_id="other")
                self.assertEqual(rejected.status, ModelInvocationStatus.UNKNOWN)
                self.assertFalse(first_closed.is_set())
                duplicate = await self.provider.invoke(REQUEST)
                self.assertEqual(duplicate.error_code, INVOCATION_ACTIVE)
                cancelled = await self.provider.cancel(invocation_id="invocation", owner_id="owner")
                self.assertEqual(cancelled.status, ModelInvocationStatus.CANCELLED)
                self.assertTrue(first.done())
                self.assertTrue(first_closed.is_set())
                self.assertEqual((await first).status, ModelInvocationStatus.CANCELLED)
                self.assertFalse(second.done())
                second_finish.set()
                self.assertEqual((await second).status, ModelInvocationStatus.COMPLETED)
            finally:
                second_finish.set()
                first.cancel()
                await asyncio.gather(first, second, return_exceptions=True)
        self.assertFalse(self.provider._active)

    async def test_early_observer_cancellation_does_not_deadlock_or_submit_http(self):
        async def observer(event):
            if event.kind is ModelInvocationEventKind.STARTED:
                result = await self.provider.cancel(invocation_id="invocation", owner_id="owner")
                self.assertEqual(result.status, ModelInvocationStatus.RUNNING)

        with self.client(Mock()) as client:
            result = await self.provider.invoke(REQUEST, observer=observer)
        client.assert_not_called()
        self.assertEqual(result.status, ModelInvocationStatus.CANCELLED)
        self.assertFalse(self.provider._active)

    async def test_sparse_completed_response_uses_done_items_but_never_partial_deltas(self):
        item = {"type": "message", "content": [{"type": "output_text", "text": "done"}]}
        done = {"type": "response.output_item.done", "output_index": 0, "item": item}
        terminal = {
            "type": "response.completed",
            "response": {
                "status": "completed",
                "output": [],
                "id": "sparse",
                "usage": {"input_tokens": 11, "output_tokens": 3},
            },
        }
        cases = (
            ([done, terminal], ModelInvocationStatus.COMPLETED),
            ([done], ModelInvocationStatus.FAILED),
            (
                [{"type": "response.output_text.delta", "delta": "partial"}, terminal],
                ModelInvocationStatus.FAILED,
            ),
            ([done, {"type": "response.incomplete", "response": {}}], ModelInvocationStatus.FAILED),
            (
                [
                    done,
                    {
                        "type": "response.completed",
                        "response": {"status": "incomplete", "output": []},
                    },
                ],
                ModelInvocationStatus.FAILED,
            ),
            (
                [
                    {
                        "type": "response.output_item.done",
                        "output_index": 0,
                        "item": {"type": "function_call"},
                    },
                    terminal,
                ],
                ModelInvocationStatus.FAILED,
            ),
        )
        for events, status in cases:
            with (
                self.subTest(events=events),
                self.client(
                    lambda request: httpx.Response(
                        200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events)
                    )
                ),
            ):
                result = await self.provider.invoke(REQUEST)
            self.assertEqual(result.status, status)
            if status is ModelInvocationStatus.COMPLETED:
                self.assertEqual(result.output_text, "done")
                self.assertEqual(result.usage.receipt_id, "sparse")
                self.assertEqual(result.usage.output_tokens, 3)

    async def test_tool_output_and_unterminated_streams_are_rejected(self):
        for protocol, events in (
            (CHAT_PROTOCOL, [{"choices": [{"delta": {"tool_calls": [{"id": "tool"}]}}]}]),
            (CHAT_PROTOCOL, [{"choices": [{"delta": {"function_call": {"name": "shell"}}}]}]),
            (
                RESPONSES_PROTOCOL,
                [{"type": "response.output_item.added", "item": {"type": "function_call"}}],
            ),
            (
                RESPONSES_PROTOCOL,
                [
                    {
                        "type": "response.completed",
                        "response": {"output": [{"type": "web_search_call"}]},
                    }
                ],
            ),
        ):
            with (
                self.subTest(protocol=protocol, events=events),
                self.assertRaisesRegex(ValueError, TOOL_OUTPUT_UNSUPPORTED),
            ):
                await receive(
                    httpx.Response(
                        200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events)
                    ),
                    protocol,
                )
        for protocol in (CHAT_PROTOCOL, RESPONSES_PROTOCOL):
            with self.subTest(protocol=protocol), self.assertRaises(ValueError):
                await receive(httpx.Response(200, text="data: [DONE]\n\n"), protocol)

    def test_tool_free_is_not_an_optional_prompt_setting(self):
        for encoder in (responses_body, chat_body):
            for required in (False, True):
                body = encoder(replace(REQUEST, require_tool_free=required), connection(), {})
                self.assertEqual(body["tools"], [])
                self.assertEqual(body["tool_choice"], "none")

    def test_responses_plain_text_input_has_no_json_directive(self):
        body = responses_body(REQUEST, connection(), {})
        self.assertEqual(
            body["input"],
            [{"role": "user", "content": [{"type": "input_text", "text": "source"}]}],
        )
        self.assertNotIn("text", body)


if __name__ == "__main__":
    unittest.main()
