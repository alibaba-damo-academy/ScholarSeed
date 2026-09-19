"""Deterministic wire contracts, not real-model product acceptance."""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.model import ModelWireProtocol
from service.chat.service.completions import CompletionBridge, mount_completion_bridge


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

    def model_response(self, body, *, native=False, streaming=False, session_id="session"):
        observed = []
        turn = ["original-turn"]
        bridge = CompletionBridge(
            "http://127.0.0.1",
            on_model=lambda *values: observed.append(values),
            turn_ids=lambda session: turn[0],
        )
        registration = bridge.register(
            endpoint="https://provider.example/v1/chat/completions",
            responses_endpoint="https://provider.example/v1/responses",
            wire_protocol=(
                ModelWireProtocol.RESPONSES if native else ModelWireProtocol.CHAT_COMPLETIONS
            ),
            api_key="",
            session_id=session_id,
        )
        app = FastAPI()
        mount_completion_bridge(app, bridge)
        transport = httpx.MockTransport(
            lambda request: httpx.Response(
                200, stream=FragmentedBody(body, lambda: turn.__setitem__(0, "later-turn"))
            )
        )
        client_type = httpx.AsyncClient
        with patch(
            "service.chat.service.completions.httpx.AsyncClient",
            side_effect=lambda **kwargs: client_type(transport=transport, **kwargs),
        ):
            with TestClient(app) as client:
                response = client.post(
                    f"/api/internal/model-bridge/{registration.bridge_id}/v1/responses",
                    json={"model": "selected", "input": "hello", "stream": streaming},
                )
        self.assertEqual(response.status_code, 200)
        return observed, response.content

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
