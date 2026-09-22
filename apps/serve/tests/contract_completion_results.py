"""Deterministic wire contracts, not real-model product acceptance."""

from __future__ import annotations

import asyncio
import copy
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.model import ModelWireProtocol
from service.chat.service.completions import (
    CompletionBridge,
    mount_completion_bridge,
    normalize_response_input,
)
from service.chat.service.rejections import terminal_provider_failure
from service.chat.service.streams import (
    INPUT_SHAPE_LIMIT,
    SSE_BUFFER_LIMIT,
    CompletionDiagnostic,
    StreamObservation,
)


class BrokenBody(httpx.AsyncByteStream):
    async def __aiter__(self):
        raise httpx.ReadTimeout("body interrupted after upstream accepted")
        yield b""


class FragmentedBody(httpx.AsyncByteStream):
    def __init__(self, body, advance):
        self.body = body
        self.advance = advance

    async def __aiter__(self):
        self.advance()
        for byte in self.body:
            yield bytes([byte])


class InterruptedBody(httpx.AsyncByteStream):
    def __init__(self, error):
        self.error = error

    async def __aiter__(self):
        yield b'data: {"type":"response.created"}\n\n'
        raise self.error


class CompletionBridgeContract(unittest.TestCase):
    def invoke(self, response: httpx.Response):
        requests = []

        def capture(request):
            requests.append(request)
            return response

        client = httpx.AsyncClient(transport=httpx.MockTransport(capture))
        bridge = CompletionBridge("http://127.0.0.1")
        registration = bridge.register(
            endpoint="https://provider.example/v1/chat/completions", api_key="", session_id="turn"
        )
        try:
            with patch("service.chat.service.completions.httpx.AsyncClient", return_value=client):
                result = asyncio.run(
                    bridge.forward(
                        registration.bridge_id,
                        {
                            "model": "model",
                            "instructions": "Trusted policy",
                            "input": "Untrusted document",
                            "stream": False,
                            "tools": [],
                            "max_output_tokens": 128,
                        },
                    )
                )
            self.assertEqual(len(requests), 1)
            return json.loads(result.body)
        finally:
            bridge.release("turn")
            self.assertEqual(bridge.registration_count(), 0)
            self.assertTrue(client.is_closed)

    def model_response(
        self,
        body,
        *,
        native=False,
        streaming=False,
        session_id="session",
        status=200,
        inputs="hello",
    ):
        observed = []
        self.diagnostics = []
        self.requests = []
        turn = ["original-turn"]
        bridge = CompletionBridge(
            "http://127.0.0.1",
            on_model=lambda *values: observed.append(values),
            turn_ids=lambda session: turn[0],
            on_diagnostic=lambda session, fields: self.diagnostics.append((session, fields)),
        )
        registration = bridge.register(
            endpoint="https://provider.example/v1/chat/completions",
            responses_endpoint="https://provider.example/v1/responses",
            wire_protocol=(
                ModelWireProtocol.RESPONSES if native else ModelWireProtocol.CHAT_COMPLETIONS
            ),
            api_key="",
            session_id=session_id,
            model_routes={"codex-auto-review": "selected"},
        )
        app = FastAPI()
        mount_completion_bridge(app, bridge)

        def respond(request):
            self.requests.append(json.loads(request.content))
            return httpx.Response(
                status,
                headers={"content-type": "text/event-stream", "x-request-id": "upstream-id"},
                stream=(
                    body
                    if isinstance(body, httpx.AsyncByteStream)
                    else FragmentedBody(body, lambda: turn.__setitem__(0, "later-turn"))
                ),
            )

        transport = httpx.MockTransport(respond)
        client_type = httpx.AsyncClient
        with patch(
            "service.chat.service.completions.httpx.AsyncClient",
            side_effect=lambda **kwargs: client_type(transport=transport, **kwargs),
        ):
            with TestClient(app) as client:
                response = client.post(
                    f"/api/internal/model-bridge/{registration.bridge_id}/v1/responses",
                    json={"model": "codex-auto-review", "input": inputs, "stream": streaming},
                )
        self.assertEqual(response.status_code, status)
        return observed, response.content

    def test_diagnostics_distinguish_eof_from_completion_and_preserve_stream(self):
        for terminal in ("response.completed", "response.failed", "response.incomplete", ""):
            body = b'data: {"type":"response.created","secret":"do-not-log"}\n\n'
            if terminal:
                body += f'data: {{"type":"{terminal}"}}\n\n'.encode()
            _, returned = self.model_response(body, native=True, streaming=True)
            self.assertEqual(returned, body)
            self.assertEqual(len(self.diagnostics), 3)
            fields = self.diagnostics[-1][1]
            self.assertEqual(fields["requested_model"], "codex-auto-review")
            self.assertEqual(fields["routed_model"], "selected")
            self.assertEqual(fields["client_user_message_id"], "original-turn")
            self.assertEqual(fields["upstream_request_id"], "upstream-id")
            self.assertEqual(fields["status_code"], 200)
            self.assertEqual(fields["content_type"], "text/event-stream")
            self.assertEqual(fields["end_reason"], "eof")
            self.assertEqual(fields["upstream_end"], "eof")
            for boundary in ("upstream", "downstream"):
                self.assertEqual(fields[boundary]["terminal_event"], terminal)
            self.assertNotIn("do-not-log", json.dumps(self.diagnostics))
            self.assertEqual(len({item[1]["request_id"] for item in self.diagnostics}), 1)

    def test_diagnostics_observe_chat_conversion_boundaries(self):
        body = (
            b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'
            b"data: [DONE]\n\n"
        )
        self.model_response(body, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["wire_protocol"], "chat_completions")
        self.assertTrue(fields["upstream"]["done_seen"])
        self.assertEqual(fields["upstream"]["finish_reason"], "stop")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.completed")

    def test_diagnostics_record_transport_failure_without_exception_message(self):
        with self.assertRaises(httpx.ReadTimeout):
            self.model_response(
                InterruptedBody(httpx.ReadTimeout("secret-url-and-token")),
                native=True,
                streaming=True,
            )
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream_end"], "transport_error")
        self.assertEqual(fields["failure_type"], "ReadTimeout")
        self.assertEqual(fields["upstream"]["last_event"], "response.created")
        self.assertNotIn("secret-url-and-token", json.dumps(self.diagnostics))

    def test_diagnostics_record_upstream_http_rejection(self):
        self.model_response(b'{"error":{"code":"rejected"}}', streaming=True, status=429)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["status_code"], 429)
        self.assertEqual(fields["end_reason"], "http_error")

    def test_sse_observation_is_bounded_and_does_not_invent_terminal_frame(self):
        observer = StreamObservation()
        observer.feed(b"data: " + b"x" * (SSE_BUFFER_LIMIT + 1))
        self.assertLessEqual(len(observer.pending) + observer.size, SSE_BUFFER_LIMIT)
        observer.feed(b"\n\n")
        observer.feed(
            b'event: response.completed\r\ndata: {"type":\r\ndata: "response.completed"}\r\n\r\n'
        )
        self.assertEqual(observer.oversized_events, 1)
        self.assertEqual(observer.terminal, "response.completed")
        truncated = StreamObservation()
        truncated.feed(b'data: {"type":"response.completed"}\n')
        self.assertEqual(truncated.terminal, "")
        self.assertGreater(truncated.snapshot()["pending_bytes"], 0)

    def test_oversized_named_terminal_remains_observable(self):
        observer = StreamObservation()
        observer.feed(b"event: response.completed\r\n")
        observer.feed(b"data: " + b"x" * (SSE_BUFFER_LIMIT + 1))
        observer.feed(b"\r\n\r\n")
        self.assertEqual(observer.terminal, "response.completed")
        self.assertEqual(observer.oversized_events, 1)
        self.assertEqual(observer.snapshot()["pending_bytes"], 0)

    def test_flat_sse_error_is_observed_and_credentials_are_redacted(self):
        diagnostic = CompletionDiagnostic("session", "codex-auto-review")
        diagnostic.protect({"Authorization": "Bearer opaque-credential-value"})
        event = {
            "type": "error",
            "code": "invalid_request",
            "param": "text.format",
            "message": "unsupported schema opaque-credential-value https://host/?key=hidden",
        }
        diagnostic.upstream.feed(f"data: {json.dumps(event)}\n\n".encode())
        fields = diagnostic.upstream.snapshot()
        self.assertEqual(fields["last_event"], "error")
        self.assertEqual(fields["error_code"], "invalid_request")
        self.assertEqual(fields["error_param"], "text.format")
        self.assertIn("unsupported schema", fields["error_message"])
        self.assertNotIn("opaque-credential-value", json.dumps(fields))
        self.assertNotIn("hidden", json.dumps(fields))

    def test_stream_cancellation_is_not_reported_as_transport_failure(self):
        self.model_response(InterruptedBody(asyncio.CancelledError()), native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream_end"], "cancelled")
        self.assertEqual(fields["end_reason"], "consumer_closed")
        self.assertEqual(fields["failure_type"], "")

    def test_invalid_sse_json_cannot_break_observation(self):
        observer = StreamObservation()
        observer.feed(b"data: {invalid json}\n\n")
        observer.feed(b"data: [1,2]\n\n")
        self.assertEqual(observer.invalid_events, 2)
        self.assertEqual(observer.terminal, "")

    def test_input_diagnostics_are_bounded_structural_metadata(self):
        diagnostic = CompletionDiagnostic("session", "model")
        diagnostic.observe_input(
            {
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "id": "msg_private",
                        "content": "private-body",
                    }
                ]
                * (INPUT_SHAPE_LIMIT + 1)
            }
        )
        self.assertEqual(len(diagnostic.input_shapes), INPUT_SHAPE_LIMIT)
        self.assertEqual(diagnostic.input_shapes[0]["id_prefix"], "msg")
        self.assertNotIn("private", json.dumps(diagnostic.input_shapes))

    def test_tool_prefix_is_projected_without_mutating_messages_or_tool_schemas(self):
        tools = [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
        payload = {
            "input": [
                {"type": "additional_tools", "id": "at_local", "role": "developer", "tools": tools},
                {"type": "message", "id": "at_local", "role": "user", "content": "review"},
                {"id": "local_id", "role": "assistant", "content": [{"text": "msg_literal"}]},
                {"type": "message", "id": "msg_server", "role": "assistant", "content": "ok"},
                {"type": "function_call", "id": "fc_call", "call_id": "at_call"},
                {"type": "function_call_output", "call_id": "at_call", "output": "at_literal"},
                {"type": "reasoning", "id": "rs_reasoning", "summary": []},
                {"type": "item_reference", "id": "msg_server"},
            ],
            "instructions": "Preserve policy",
            "text": {"format": {"type": "json_schema"}},
        }
        original = copy.deepcopy(payload)
        normalized, counts = normalize_response_input(payload)
        self.assertEqual(payload, original)
        self.assertEqual(counts, {"additional_tools": 1})
        self.assertEqual(normalized["input"], original["input"][1:])
        self.assertEqual(normalized["tools"], tools)
        self.assertEqual(normalized["instructions"], original["instructions"])
        self.assertEqual(normalized["text"], original["text"])

    def test_referenced_tool_prefix_is_rejected_not_dangling(self):
        with self.assertRaisesRegex(ValueError, "model_bridge_invalid_tool_input"):
            normalize_response_input(
                {
                    "input": [
                        {
                            "type": "additional_tools",
                            "id": "at_local",
                            "role": "developer",
                            "tools": [],
                        },
                        {"type": "item_reference", "id": "at_local"},
                    ]
                }
            )

    def test_standard_input_is_unchanged(self):
        for inputs in (
            "hi",
            [{"type": "item_reference", "id": "at_local"}],
            [{"type": "message", "id": "at_incomplete"}],
            [{"type": "custom", "role": "user", "content": "hi", "id": "at_id"}],
        ):
            payload = {"input": inputs, "previous_response_id": "resp_original"}
            normalized, counts = normalize_response_input(payload)
            self.assertEqual(normalized, payload)
            self.assertEqual(counts, {})

    def test_native_error_has_explicit_failed_terminal_without_success(self):
        body = (
            b'data: {"type":"error","code":"InvalidParameter","message":"invalid message id"}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        events = [
            json.loads(line[6:]) for line in returned.splitlines() if line.startswith(b"data: ")
        ]
        self.assertEqual([event["type"] for event in events], ["error", "response.failed"])
        self.assertEqual(events[-1]["response"]["error"]["code"], "InvalidParameter")
        self.assertEqual(events[-1]["response"]["error"]["message"], "invalid message id")
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream"]["last_event"], "error")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["end_reason"], "provider_error")

    def test_existing_failed_terminal_is_not_duplicated(self):
        body = b'data: {"type":"response.failed","response":{"error":{"code":"bad","message":"failed"}}}\n\n'
        _, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)

    def test_native_content_safety_failure_is_normalized_before_codex(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"server_error","message":"<400> InternalError.Algo.DataInspectionFailed: '
            b'Output data may contain inappropriate content."}}}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        event = json.loads(returned.removeprefix(b"data: ").strip())
        error = event["response"]["error"]
        self.assertEqual(error["code"], "invalid_prompt")
        self.assertEqual(error["type"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(error["message"], "The request did not pass content safety review.")
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["upstream"]["error_code"], "server_error")
        self.assertEqual(fields["downstream"]["error_code"], "invalid_prompt")
        self.assertEqual(fields["downstream"]["error_type"], "CONTENT_SAFETY_BLOCKED")
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "The request did not pass content safety review.",
                "error_code": "CONTENT_SAFETY_BLOCKED",
                "safe_error": "The request did not pass content safety review.",
                "retryability": "terminal",
                "provider_http_status": 400,
            },
        )
        unrelated = dict(fields)
        unrelated["downstream"] = dict(fields["downstream"], error_type="")
        self.assertEqual(terminal_provider_failure(unrelated), {})

    def test_native_response_failed_invalid_parameter_is_provider_error_and_recovered(self):
        # 工单 87102385 的形态：HTTP200 + 原生 response.failed 终态携 InvalidParameter。
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"InvalidParameter","message":"Unsupported model: \'minimax-m2.1\'"}}}\n\n'
        )
        _, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)
        fields = self.diagnostics[-1][1]
        # R4：带 error 的 response.failed 终态升格，serve 记录不再是 eof/failure_type=""。
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "InvalidParameter")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["downstream"]["error_code"], "InvalidParameter")
        # R1/R2：bridge 是最后结构化观测点，恢复真实码 + 有界 message + 终态。
        self.assertEqual(
            terminal_provider_failure(fields),
            {
                "error": "Unsupported model: 'minimax-m2.1'",
                "error_code": "InvalidParameter",
                "safe_error": "Unsupported model: 'minimax-m2.1'",
                "retryability": "terminal",
                "provider_http_status": 400,
            },
        )

    def test_recovered_message_is_bounded_and_url_redacted(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"InvalidParameter","message":"Unsupported model, see '
            b'https://secret.example/key?token=abc"}}}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        recovered = terminal_provider_failure(self.diagnostics[-1][1])
        self.assertEqual(recovered["error_code"], "InvalidParameter")
        self.assertNotIn("https://secret.example", recovered["safe_error"])
        self.assertNotIn("token=abc", recovered["safe_error"])
        self.assertIn("[URL]", recovered["safe_error"])

    def test_unregistered_code_upgrades_diagnostic_but_is_not_released(self):
        body = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"weird_vendor_code","message":"internal detail"}}}\n\n'
        )
        self.model_response(body, native=True, streaming=True)
        fields = self.diagnostics[-1][1]
        # R4 升格与白名单无关：任何带 error 的 response.failed 终态都记 provider_error。
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "weird_vendor_code")
        # 白名单外的码不放行到产品面，继续折叠（恢复源返回空）。
        self.assertEqual(terminal_provider_failure(fields), {})

    def test_chat_structured_error_terminal_upgrades_to_provider_error(self):
        # chat 路合成 response.failed 终态后同样升格 provider_error（与原生路共用 settle）。
        error_content = json.dumps(
            {
                "error": {
                    "message": "You exceeded your current quota.",
                    "type": "insufficient_quota",
                    "code": "insufficient_quota",
                }
            }
        )
        body = (
            b"data: "
            + json.dumps(
                {
                    "id": "chat-response",
                    "choices": [{"delta": {"content": error_content}, "finish_reason": "stop"}],
                }
            ).encode()
            + b"\n\ndata: [DONE]\n\n"
        )
        self.model_response(body, streaming=True)
        fields = self.diagnostics[-1][1]
        self.assertEqual(fields["wire_protocol"], "chat_completions")
        self.assertEqual(fields["downstream"]["terminal_event"], "response.failed")
        self.assertEqual(fields["end_reason"], "provider_error")
        self.assertEqual(fields["failure_type"], "insufficient_quota")
        # quota 不在 bridge 终态白名单（Codex 自带白名单已保码，adapter 直接分类），
        # 故恢复源返回空——R4 只修诊断记录，不改产品归因来源。
        self.assertEqual(terminal_provider_failure(fields), {})

    def test_bridge_preserves_native_lite_and_only_translates_chat_tools(self):
        tools = [{"type": "function", "name": "exec", "parameters": {"type": "object"}}]
        items = [
            {"type": "additional_tools", "role": "developer", "id": "at_local", "tools": tools},
            {
                "type": "message",
                "role": "user",
                "id": "msg_keep",
                "content": [{"type": "input_text", "text": "review"}],
            },
        ]
        for native in (True, False):
            self.model_response(b'{"choices":[]}', native=native, inputs=items)
            if native:
                self.assertEqual(self.requests[0]["input"], items)
                self.assertNotIn("tools", self.requests[0])
            else:
                self.assertEqual(
                    self.requests[0]["messages"], [{"role": "user", "content": "review"}]
                )
                self.assertEqual(self.requests[0]["tools"][0]["function"]["name"], "exec")
            self.assertEqual(
                self.diagnostics[-1][1]["converted_input_items"],
                {} if native else {"additional_tools": 1},
            )
        self.assertEqual(items[0]["id"], "at_local")

    def test_ambiguous_tool_inputs_fail_closed(self):
        prefix = {"type": "additional_tools", "role": "developer", "tools": []}
        for payload in (
            {"input": [prefix, prefix]},
            {"input": [{"type": "message"}, prefix]},
            {"input": [{**prefix, "role": "user"}]},
            {"input": [{**prefix, "tools": "bad"}]},
            {"input": [{**prefix, "tools": [None]}]},
            {"input": [prefix], "tools": [{"type": "function", "name": "other"}]},
        ):
            with (
                self.subTest(payload=payload),
                self.assertRaisesRegex(ValueError, "model_bridge_invalid_tool_input"),
            ):
                normalize_response_input(payload)

    def test_bridge_rejects_ambiguous_tool_input_before_upstream(self):
        self.model_response(
            b"",
            status=400,
            inputs=[{"type": "additional_tools", "role": "user", "tools": []}],
        )
        self.assertEqual(self.requests, [])

    def test_lite_tools_cannot_bypass_chat_native_tool_capability_check(self):
        self.model_response(
            b"",
            status=400,
            inputs=[
                {"type": "additional_tools", "role": "developer", "tools": [{"type": "web_search"}]}
            ],
        )
        self.assertEqual(self.requests, [])

    def test_empty_and_repeated_identical_tools_preserve_definitions(self):
        tools = [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [{"type": "function", "name": "exec"}],
            }
        ]
        for definitions in ([], tools):
            payload = {
                "input": [{"type": "additional_tools", "role": "developer", "tools": definitions}],
                "tools": definitions,
            }
            normalized, _ = normalize_response_input(payload)
            self.assertEqual(normalized, {"input": [], "tools": definitions})

    def test_response_model_is_captured_before_turn_changes(self):
        for native in (False, True):
            with self.subTest(native=native):
                observed, _ = self.model_response(
                    b'{"model":"actual-version","choices":[]}', native=native
                )
                self.assertEqual(observed, [("session", "original-turn", "actual-version")])

    def test_native_sse_fragments_are_unchanged_and_deduplicated(self):
        body = (
            b'data: {"response":{"model":"actual-version"}}\r\n\r\n'
            b'data: {"response":{"model":"actual-version"}}\r\n\r\n'
            b"data: [DONE]\r\n\r\n"
        )
        observed, returned = self.model_response(body, native=True, streaming=True)
        self.assertEqual(returned, body)
        self.assertEqual(observed, [("session", "original-turn", "actual-version")])

    def test_chat_stream_reports_model_changes_once(self):
        body = (
            b'data: {"model":"actual-a","choices":[]}\n\n'
            b'data: {"model":"actual-a","choices":[]}\n\n'
            b'data: {"model":"actual-b","choices":[]}\n\n'
            b"data: [DONE]\n\n"
        )
        observed, _ = self.model_response(body, streaming=True)
        self.assertEqual(
            observed,
            [
                ("session", "original-turn", "actual-a"),
                ("session", "original-turn", "actual-b"),
            ],
        )

    def test_missing_model_or_identity_is_not_invented(self):
        observed, _ = self.model_response(b'{"choices":[]}')
        self.assertEqual(observed, [])
        observed, _ = self.model_response(b'{"model":"actual","choices":[]}', session_id="")
        self.assertEqual(observed, [])

    def test_budget_truncation_is_not_a_complete_translation(self):
        for reason in ("length", "content_filter"):
            with self.subTest(reason=reason):
                result = self.invoke(
                    httpx.Response(
                        200,
                        json={
                            "choices": [
                                {"message": {"content": "half translated"}, "finish_reason": reason}
                            ],
                        },
                    )
                )
                self.assertEqual(result["status"], "incomplete")

    def test_body_disconnect_has_unknown_outcome(self):
        with self.assertRaises(httpx.ReadTimeout):
            self.invoke(httpx.Response(200, stream=BrokenBody()))

    def test_success_carries_actual_usage(self):
        result = self.invoke(
            httpx.Response(
                200,
                json={
                    "id": "receipt",
                    "choices": [{"message": {"content": "translated"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 6, "completion_tokens": 3},
                },
            )
        )
        self.assertEqual(result["output"][0]["content"][0]["text"], "translated")
        self.assertEqual(result["usage"]["input_tokens"], 6)
        self.assertEqual(result["usage"]["output_tokens"], 3)
        self.assertEqual(result["id"], "receipt")


if __name__ == "__main__":
    unittest.main()
