"""Deterministic model connection policy and cancellation contracts."""

from __future__ import annotations

import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from scholarseed_runtime.contract.model import ModelCredential, ModelWireProtocol
from service.chat.service.completions import CompletionBridge, CompletionCredentialError
from service.identity.service.account_token import AccountTokenHolder
from service.identity.utils import LOCAL_USER_ID

OWNER = "owner"
CONNECTION = "connection"
SESSION = "session"
ENDPOINT = "https://subscription.example/responses"
GATEWAY_ENDPOINT = "https://gateway.example/v1/chat/completions"


class PausedStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        self.closed = False

    async def __aiter__(self):
        yield b'data: {"type":"response.created"}\n\n'
        await asyncio.Event().wait()

    async def aclose(self) -> None:
        self.closed = True


class OAuthBridgeContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.bridge = CompletionBridge("http://127.0.0.1:8770")
        self.addAsyncCleanup(self.bridge.close)

    def register(self, resolver, **kwargs):
        return self.bridge.register(
            endpoint=ENDPOINT,
            responses_endpoint=ENDPOINT,
            wire_protocol=ModelWireProtocol.RESPONSES,
            api_key="must-not-fallback",
            headers={"Authorization": "must-not-override"},
            owner_id=OWNER,
            connection_id=CONNECTION,
            session_id=SESSION,
            credential_resolver=resolver,
            **kwargs,
        )

    def transport(self, handler):
        client = httpx.AsyncClient
        clients = []

        def create(**kwargs):
            instance = client(transport=httpx.MockTransport(handler), **kwargs)
            clients.append(instance)
            return instance

        scope = patch("service.chat.service.completions.httpx.AsyncClient", side_effect=create)
        return scope, clients

    async def test_responses_policy_applies_with_no_tools_and_only_function_tools(self) -> None:
        calls, resolutions = [], []

        async def resolve(owner, connection):
            resolutions.append((owner, connection))
            return ModelCredential(
                api_key=f"access-{len(resolutions)}", headers={"ChatGPT-Account-Id": "account"}
            )

        def handler(request):
            calls.append(request)
            return httpx.Response(200, json={"object": "response", "output": []})

        registration = self.register(resolve)
        transport, clients = self.transport(handler)
        with transport:
            for tools in ([], [{"type": "function", "name": "read", "parameters": {}}]):
                payload = {
                    "model": "model",
                    "input": [
                        {"type": "function_call_output", "call_id": "call", "output": "result"}
                    ],
                    "tools": tools,
                }
                response = await self.bridge.forward(registration.bridge_id, payload)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(json.loads(calls[-1].content), payload)
        self.assertEqual([str(request.url) for request in calls], [ENDPOINT, ENDPOINT])
        self.assertEqual(
            [request.headers["authorization"] for request in calls],
            ["Bearer access-1", "Bearer access-2"],
        )
        self.assertTrue(all(client.is_closed for client in clients))
        self.assertEqual(resolutions, [(OWNER, CONNECTION), (OWNER, CONNECTION)])

    async def test_registered_environment_policy_reaches_upstream_client(self) -> None:
        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        registration = self.register(resolve, trust_env=True)
        direct_registration = self.register(resolve)
        captured = []
        client_type = httpx.AsyncClient

        def create(**kwargs):
            captured.append(kwargs["trust_env"])
            return client_type(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, json={"object": "response", "output": []})
                ),
                **kwargs,
            )

        with patch("service.chat.service.completions.httpx.AsyncClient", side_effect=create):
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
            direct_response = await self.bridge.forward(
                direct_registration.bridge_id, {"model": "model"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(direct_response.status_code, 200)
        self.assertEqual(captured, [True, False])

    async def test_credential_failure_never_calls_api_fallback(self) -> None:
        async def resolve(owner, connection):
            raise CompletionCredentialError("oauth_reauth_required")

        registration = self.register(resolve)
        transport, clients = self.transport(
            lambda request: self.fail("upstream must not be called")
        )
        with transport:
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(json.loads(response.body)["error"]["code"], "oauth_reauth_required")
        self.assertEqual(clients, [])

    async def test_disconnect_during_credential_resolution_never_sends_request(self) -> None:
        entered = asyncio.Event()

        async def resolve(owner, connection):
            entered.set()
            await asyncio.Event().wait()

        registration = self.register(resolve)
        transport, clients = self.transport(lambda request: self.fail("revoked request sent"))
        with transport:
            task = asyncio.create_task(
                self.bridge.forward(registration.bridge_id, {"model": "model"})
            )
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual(self.bridge.revoke_connection(OWNER, CONNECTION), 1)
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(clients, [])
        self.assertEqual((await self.bridge.forward(registration.bridge_id, {})).status_code, 404)

    async def test_logout_stops_active_sse_and_closes_upstream(self) -> None:
        stream = PausedStream()
        received = asyncio.Event()

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        registration = self.register(resolve)
        transport, clients = self.transport(lambda request: httpx.Response(200, stream=stream))
        with transport:
            response = await self.bridge.forward(
                registration.bridge_id, {"model": "model", "stream": True}
            )

            async def consume():
                async for data in response.body_iterator:
                    self.assertTrue(data.startswith(b"data:"))
                    received.set()

            task = asyncio.create_task(consume())
            await asyncio.wait_for(received.wait(), 2)
            self.assertEqual(self.bridge.revoke_owner(OWNER), 1)
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(stream.closed)
        self.assertTrue(clients[0].is_closed)
        self.assertEqual(self.bridge._calls, set())

    async def test_cancel_before_headers_closes_http_client(self) -> None:
        entered = asyncio.Event()

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        async def handler(request):
            entered.set()
            await asyncio.Event().wait()

        registration = self.register(resolve)
        transport, clients = self.transport(handler)
        with transport:
            task = asyncio.create_task(
                self.bridge.forward(registration.bridge_id, {"model": "model"})
            )
            await asyncio.wait_for(entered.wait(), 2)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(clients[0].is_closed)

    async def test_owner_switch_invalidates_instead_of_rebinding_oauth(self) -> None:
        async def resolve(owner, connection):
            self.fail("must not resolve after owner switch")

        registration = self.register(resolve)
        self.assertEqual(self.bridge.rebind_owner(SESSION, "other-user"), 1)
        self.assertEqual((await self.bridge.forward(registration.bridge_id, {})).status_code, 404)

    async def test_upstream_auth_error_is_redacted(self) -> None:
        async def resolve(owner, connection):
            return ModelCredential(api_key="secret-access")

        registration = self.register(resolve)
        transport, _ = self.transport(
            lambda request: httpx.Response(403, text="invalid secret-access")
        )
        with transport:
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(b"secret-access", response.body)

    async def test_transient_server_failure_retries_before_returning(self) -> None:
        calls = []

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        def handler(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(500, text="temporary")
            return httpx.Response(200, json={"object": "response", "output": []})

        async def no_delay(_seconds: float) -> None:
            return None

        registration = self.register(resolve)
        transport, _ = self.transport(handler)
        with transport, patch(
            "service.chat.service.completions.asyncio.sleep", new=no_delay
        ):
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(calls), 2)

    async def test_registered_product_error_code_passes_the_redaction_branch(self) -> None:
        async def resolve(owner, connection):
            return ModelCredential(api_key="secret-access")

        body = json.dumps(
            {
                "detail": {
                    "error": "credit_balance_exhausted",
                    "message": "积分余额已用尽，可在积分页申请补充后再试",
                    "balance_credits": 0,
                    "retry_after": 86400,
                }
            }
        ).encode("utf-8")
        registration = self.register(resolve)
        transport, _ = self.transport(lambda request: httpx.Response(429, content=body))
        with transport:
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(json.loads(response.body), {"error": {"code": "credit_balance_exhausted"}})

    async def test_unregistered_detail_code_stays_redacted(self) -> None:
        async def resolve(owner, connection):
            return ModelCredential(api_key="secret-access")

        body = json.dumps(
            {"detail": {"error": "some_future_code", "message": "leak secret-access"}}
        ).encode("utf-8")
        registration = self.register(resolve)
        transport, _ = self.transport(lambda request: httpx.Response(429, content=body))
        with transport:
            response = await self.bridge.forward(registration.bridge_id, {"model": "model"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(json.loads(response.body), {"error": {"code": "model_upstream_rejected"}})
        self.assertNotIn(b"secret-access", response.body)

    async def test_response_start_failure_closes_unstarted_stream(self) -> None:
        stream = PausedStream()

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        async def receive():
            await asyncio.Event().wait()

        async def send(message):
            self.assertEqual(message["type"], "http.response.start")
            raise RuntimeError("downstream closed before headers")

        registration = self.register(resolve)
        upstream = self.bridge._upstreams[registration.bridge_id]
        transport, clients = self.transport(lambda request: httpx.Response(200, stream=stream))
        with transport:
            response = await self.bridge.forward(
                registration.bridge_id, {"model": "model", "stream": True}
            )
            with self.assertRaisesRegex(RuntimeError, "downstream closed"):
                await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        self.assertTrue(stream.closed)
        self.assertTrue(clients[0].is_closed)
        self.assertFalse(upstream.calls)
        self.assertFalse(self.bridge._calls)

    async def test_revocation_finalizes_stream_that_was_never_consumed(self) -> None:
        stream = PausedStream()

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        registration = self.register(resolve)
        upstream = self.bridge._upstreams[registration.bridge_id]
        transport, clients = self.transport(lambda request: httpx.Response(200, stream=stream))
        with transport:
            await self.bridge.forward(registration.bridge_id, {"model": "model", "stream": True})
            calls = tuple(upstream.calls)
            self.bridge.revoke_connection(OWNER, CONNECTION)
            await asyncio.gather(*(call.close() for call in calls))
        self.assertTrue(stream.closed)
        self.assertTrue(clients[0].is_closed)
        self.assertFalse(upstream.calls)
        self.assertFalse(self.bridge._calls)

    async def test_shutdown_rejects_new_work_while_draining(self) -> None:
        entered, finish = asyncio.Event(), asyncio.Event()

        class ClosingStream(PausedStream):
            async def aclose(self):
                entered.set()
                await finish.wait()
                await super().aclose()

        stream = ClosingStream()

        async def resolve(owner, connection):
            return ModelCredential(api_key="access")

        registration = self.register(resolve)
        transport, clients = self.transport(lambda request: httpx.Response(200, stream=stream))
        with transport:
            await self.bridge.forward(registration.bridge_id, {"model": "model", "stream": True})
            closing = asyncio.create_task(self.bridge.close())
            await asyncio.wait_for(entered.wait(), 2)
            try:
                with self.assertRaisesRegex(ValueError, "model_bridge_closed"):
                    self.register(resolve)
                response = await self.bridge.forward(registration.bridge_id, {})
                self.assertEqual(response.status_code, 503)
            finally:
                finish.set()
                await closing
        self.assertTrue(clients[0].is_closed)
        self.assertFalse(self.bridge._upstreams)
        self.assertFalse(self.bridge._calls)


class SharedOwnershipBridgeContract(unittest.IsolatedAsyncioTestCase):
    """machine 轴: 订阅桥归这台机器, 计量桥仍归账号 —— 切号时两腿必须分治。"""

    def setUp(self) -> None:
        self.bridge = CompletionBridge("http://127.0.0.1:8771", shared_ownership=True)
        self.addAsyncCleanup(self.bridge.close)

    async def test_account_switch_moves_metering_but_keeps_the_machine_subscription(self) -> None:
        holder = AccountTokenHolder()
        holder.remember("u-old", "old.account.token")
        holder.remember("u-new", "new.account.token")

        async def resolve(owner, connection):
            return ModelCredential(api_key="secret-access")

        metering = self.bridge.register(
            endpoint=GATEWAY_ENDPOINT,
            api_key="dgw_test",
            token_provider=holder.current,
            owner_id="u-old",
            session_id=SESSION,
        )
        subscription = self.bridge.register(
            endpoint=ENDPOINT,
            responses_endpoint=ENDPOINT,
            wire_protocol=ModelWireProtocol.RESPONSES,
            api_key="",
            owner_id=LOCAL_USER_ID,
            connection_id=CONNECTION,
            session_id=SESSION,
            credential_resolver=resolve,
        )

        moved = self.bridge.rebind_owner(SESSION, "u-new")

        # 计量腿原地改写: 网关用量必须跟着当前真正驱动会话的账号。
        self.assertEqual(moved, 1)
        self.assertEqual(self.bridge._upstreams[metering.bridge_id].bearer(), "new.account.token")
        # 订阅腿不动: 它的凭据按 connection_id 解析、与账号无关, 摘掉它会让正在跑的
        # Codex 子进程脚下变成 404。
        self.assertEqual(self.bridge.registration_count(), 2)
        self.assertEqual(self.bridge._upstreams[subscription.bridge_id].owner_id, LOCAL_USER_ID)

    async def test_machine_subscription_upstream_survives_repeated_account_switches(self) -> None:
        async def resolve(owner, connection):
            return ModelCredential(api_key="secret-access")

        registration = self.bridge.register(
            endpoint=ENDPOINT,
            responses_endpoint=ENDPOINT,
            wire_protocol=ModelWireProtocol.RESPONSES,
            api_key="",
            owner_id=LOCAL_USER_ID,
            connection_id=CONNECTION,
            session_id=SESSION,
            credential_resolver=resolve,
        )

        for account in ("u-1", "u-2", LOCAL_USER_ID):
            self.assertEqual(self.bridge.rebind_owner(SESSION, account), 0, account)
        self.assertEqual(self.bridge.registration_count(), 1)
        self.assertIn(registration.bridge_id, self.bridge._upstreams)


if __name__ == "__main__":
    unittest.main()
