"""Subscription composition contracts; mocked issuer is not product acceptance."""

from __future__ import annotations

import asyncio
import copy
import json
import socket
import sqlite3
import ssl
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import ModelToolProtocol, ModelWireProtocol
from service.chat.api.settings import mount_setting_routes
from service.chat.service.completions import (
    CompletionBridge,
    CompletionCleanupUnknown,
    CompletionCredentialError,
    mount_completion_bridge,
)
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.chat.service.subscriptions import (
    SUBSCRIPTION_MODELS_RETRY_ATTEMPTS,
    SUBSCRIPTION_TRUST_ENV,
    SubscriptionService,
)
from service.identity.utils import LOCAL_USER_ID, OWNERSHIP_AXIS_MACHINE
from service.inference.transport import InferenceProvider
from service.platform.activity import (
    Activities,
    ActivityDomain,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.inference import (
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationStatus,
)
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL
from service.settings.connections import ModelProfileStore, UnknownProfileError, personal_model_key
from service.settings.credentials import CredentialState, ModelCredentialStore, OAuthTokens
from service.settings.oauth import CHATGPT_PROVIDER, OAuthFailure
from tests.siwc import ISSUER, JWK

OWNER = "owner"
OTHER = "other"
MODEL = "authorized-model"
UPSTREAM_MODELS_PAYLOAD = {
    "models": [
        {
            "slug": MODEL,
            "display_name": "Authorized model",
            "visibility": "list",
            "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}],
            "default_reasoning_level": "low",
            "input_modalities": ["text", "image", "pdf"],
            "tool_mode": "code_mode",
            "use_responses_lite": True,
            "model_messages": {"instructions_template": "provider instructions"},
        },
        {"slug": "hidden-model", "visibility": "hide"},
    ]
}


class SubscriptionContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.profiles = ModelProfileStore(root / "profiles.json")
        self.credentials = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        self.bridge = CompletionBridge("http://127.0.0.1:8770")
        self.requests = []
        self.reinstall(lambda request: httpx.Response(200, json=UPSTREAM_MODELS_PAYLOAD))
        self.values = {
            "authentication": "oauth",
            "oauth_provider": "chatgpt",
            "selected_models": [],
        }

    def reinstall(self, handler, *, turn_activities=None) -> None:
        """Rebuild the subscription service against another mocked upstream."""

        def tracking(request):
            # Identity preflight is exercised separately by OAuth contracts;
            # these counters measure catalog and token operations.
            if request.url.path.endswith("openid-configuration"):
                return httpx.Response(200, json={"issuer": ISSUER, "jwks_uri": ISSUER + "/jwks"})
            if request.url.path == "/jwks":
                return httpx.Response(200, json={"keys": [JWK]})
            self.requests.append(request)
            return handler(request)

        self.activities = Activities()
        self.requests.clear()
        client = httpx.AsyncClient(transport=httpx.MockTransport(tracking))
        self.subscriptions = SubscriptionService(
            self.profiles,
            self.credentials,
            self.bridge,
            client=client,
            activities=self.activities,
            turn_activities=turn_activities,
        )
        for resolver in self.subscriptions.resolvers.values():
            resolver.protocol.revoke = AsyncMock()
        self.addAsyncCleanup(self.subscriptions.close)
        self.models = ModelService(
            SimpleNamespace(runtime_model=lambda: "", runtime_executable=lambda: ""),
            self.bridge,
            profiles=self.profiles,
            subscriptions=self.subscriptions,
            activities=self.activities,
        )

    async def connected(self):
        result = await self.models.save_profile(self.values, user_id=OWNER)
        connection = result["profile"]["id"]
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "access",
                "refresh",
                time.time() + 3600,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=0,
        )
        await self.models.save_profile(
            {**self.values, "selected_models": [{"id": MODEL}]}, connection, user_id=OWNER
        )
        return connection

    async def test_storage_failure_isolated_in_inventory_catalog_and_recovers(self):
        connection = await self.connected()
        healthy = (await self.models.save_profile(self.values, user_id=OWNER))["profile"]["id"]
        api_connection = self.profiles.upsert(
            {
                "provider": "openai",
                "base_url": "https://example.invalid/v1",
                "api_key": "test-only-key",
                "selected_models": [{"id": "api-model"}],
            },
            owner_id=OWNER,
        )["id"]
        original = self.credentials.read
        app = FastAPI()
        app.state.auth_enabled = True

        @app.middleware("http")
        async def identity(request, call_next):
            request.state.user_id = OWNER
            return await call_next(request)

        mount_setting_routes(
            app,
            models=self.models,
            settings=SimpleNamespace(),
            runtime=SimpleNamespace(),
            subscriptions=self.subscriptions,
        )
        before = self.profiles.path.read_bytes()
        for error in (
            PermissionError(13, "private-secret"),
            sqlite3.OperationalError("private-secret"),
        ):

            def fail_one(owner, identifier):
                if identifier == connection:
                    raise error
                return original(owner, identifier)

            with (
                patch.object(self.credentials, "read", side_effect=fail_one),
                self.assertLogs("service.chat.service.subscriptions", level="WARNING") as logs,
            ):
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app), base_url="http://test"
                ) as client:
                    response = await client.get("/api/serve/model-profiles")
                self.assertEqual(response.status_code, 200)
                rows = {row["id"]: row for row in response.json()["profiles"]}
                self.assertEqual(rows[connection]["oauth"]["state"], "unavailable")
                self.assertEqual(rows[connection]["oauth"]["error"], "oauth_storage_unavailable")
                self.assertEqual(rows[healthy]["oauth"]["state"], "disconnected")
                self.assertIn(api_connection, rows)
                self.assertNotIn("oauth", rows[api_connection])
                self.assertNotIn("test-only-key", response.text)
                self.assertNotIn("private-secret", response.text)
                for refresh in (False, True):
                    catalog = await self.models.catalog(
                        user_id=OWNER, refresh=refresh, auto_switch=False
                    )
                    row = next(
                        row
                        for row in catalog["available_models"]
                        if row.get("profile_id") == connection
                    )
                    self.assertTrue(row["disabled"])
                    self.assertEqual(row["disabled_reason_code"], "oauth_storage_unavailable")
                with self.assertRaises(SessionModelUnavailableError):
                    self.models.inference_connection(
                        personal_model_key(connection, MODEL), user_id=OWNER
                    )
                with self.assertRaises(SessionModelUnavailableError):
                    self.models.selected_model_key(
                        personal_model_key(connection, MODEL), user_id=OWNER
                    )
            self.assertNotIn("private-secret", "\n".join(logs.output))
            self.assertEqual(self.profiles.path.read_bytes(), before)
            restored = self.models.profiles(user_id=OWNER)
            row = next(row for row in restored["profiles"] if row["id"] == connection)
            self.assertEqual(row["oauth"]["state"], "connected")
            self.assertNotIn("error", row["oauth"])
            self.assertEqual(original(OWNER, connection).tokens.access_token, "access")

    async def test_subscription_renewal_requires_the_exact_stored_credential_intent(self):
        connection = await self.connected()

        def register():
            registration = self.subscriptions.register(OWNER, connection, MODEL, "renewal", {})
            upstream = self.bridge._upstreams[registration.bridge_id]
            authority = self.bridge._request_authority(
                upstream, upstream.responses_endpoint, ModelWireProtocol.RESPONSES
            )
            authority.capture_renewal()
            return authority

        authority = register()
        renewal = authority.prepare_renewal("successor")
        with renewal.capture():
            self.bridge.release("renewal")
            register()
        self.assertTrue(renewal.complete().current())
        self.assertFalse(authority.current())
        self.bridge.release("renewal")
        authority = register()
        renewal = authority.prepare_renewal("different-successor")
        with renewal.capture():
            self.bridge.release("renewal")
            register()
        with patch.object(self.credentials, "read", return_value=None):
            self.assertIsNone(renewal.complete())

    async def test_status_does_not_hide_programming_or_unknown_profile_errors(self):
        connection = (await self.models.save_profile(self.values, user_id=OWNER))["profile"]["id"]
        with patch.object(self.credentials, "read", side_effect=RuntimeError("unexpected")):
            with self.assertRaisesRegex(RuntimeError, "unexpected"):
                self.models.profiles(user_id=OWNER)
        with self.assertRaises(UnknownProfileError):
            self.subscriptions.status(OWNER, "missing")

    async def test_background_sync_is_coalesced_and_drains_through_snapshot_write(self):
        connection = await self.connected()
        await asyncio.gather(*tuple(self.models._directory_tasks.values()))
        requested, respond = asyncio.Event(), asyncio.Event()
        original = self.subscriptions._fetch_models

        async def delayed(*args, **kwargs):
            requested.set()
            await respond.wait()
            return await original(*args, **kwargs)

        with patch.object(self.subscriptions, "_fetch_models", delayed):
            self.models._schedule_directory_sync(OWNER, connection)
            self.models._schedule_directory_sync(OWNER, connection)
            self.assertEqual(len(self.models._directory_tasks), 1)
            await asyncio.wait_for(requested.wait(), 2)
            generation = self.activities.begin()
            self.assertFalse(self.activities.seal(generation))
            self.models._schedule_directory_sync(OWNER, "not-admitted")
            self.assertNotIn((OWNER, "not-admitted"), self.models._directory_tasks)
            respond.set()
            await self.models.close()
        self.assertTrue(self.activities.seal(generation))
        profile = self.profiles.profile(connection, owner_id=OWNER)
        self.assertTrue(profile["model_directory"]["models"])

    async def test_inline_history_ids_are_portable_without_losing_tool_links(self):
        items = [
            {"type": "message", "id": "foreign-message", "role": "assistant", "content": []},
            {
                "type": "function_call",
                "id": "foreign-call",
                "call_id": "call-1",
                "name": "tool",
                "arguments": "{}",
            },
            {"type": "function_call_output", "call_id": "call-1", "output": "result"},
        ]
        result = SubscriptionService.request_policy(
            {
                "input": items,
                "tools": [{"type": "web_search"}],
            }
        )
        self.assertNotIn("id", result["input"][0])
        self.assertNotIn("id", result["input"][1])
        self.assertEqual(result["input"][1]["call_id"], result["input"][2]["call_id"])
        self.assertEqual(items[0]["id"], "foreign-message")
        self.assertEqual(result["tools"], [{"type": "web_search"}])
        self.assertFalse(result["store"])
        self.assertTrue(result["stream"])

    def test_unsupported_requests_fail_before_upstream(self):
        for payload in (
            {"input": "text"},
            {"input": [], "temperature": 0.5},
            {"input": [], "previous_response_id": "resp_old"},
            {"input": [{"type": "item_reference", "id": "resp_old"}]},
            {"input": [{"role": "system", "content": "rules"}]},
            {"input": [], "tools": [{"type": "tool_search"}]},
            {"input": [], "tools": [{"type": "namespace", "tools": [{"type": "file_search"}]}]},
            {"input": [{"type": "additional_tools", "tools": [{"type": "tool_search"}]}]},
        ):
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(OAuthFailure, "oauth_capability_unsupported"):
                    SubscriptionService.request_policy(payload)

    def test_hosted_agent_items_fail_without_modifying_history(self):
        for itemType in ("agent_message", "multi_agent_call", "multi_agent_call_output"):
            item = {
                "type": itemType,
                "id": "native-original",
                "author": "/root",
                "recipient": "/root/reviewer",
                "content": [{"type": "encrypted_content", "encrypted_content": "opaque"}],
            }
            payload = {"input": [item]}
            with self.subTest(itemType=itemType):
                with self.assertRaisesRegex(
                    ValueError, "subscription_sharing_unsupported_capability"
                ):
                    SubscriptionService.request_policy(payload)
                self.assertEqual(item["id"], "native-original")
                self.assertEqual(item["content"][0]["encrypted_content"], "opaque")
                self.assertIs(payload["input"][0], item)

    async def test_remote_revocation_failure_keeps_local_disconnect(self):
        connection = await self.connected()
        self.subscriptions.resolvers["chatgpt"].protocol.revoke.side_effect = OAuthFailure(
            "oauth_network_unavailable"
        )
        with self.assertRaisesRegex(OAuthFailure, "oauth_revocation_unconfirmed"):
            await self.subscriptions.disconnect(OWNER, connection)
        record = self.credentials.read(OWNER, connection)
        self.assertEqual(record.state, CredentialState.DISCONNECTED)
        self.assertIsNone(record.tokens)
        self.assertEqual(record.client_id, "oaiapp_contract")

    async def test_runtime_catalog_reuses_full_configuration_for_three_hours(self):
        connection = await self.connected()
        clock = SimpleNamespace(monotonic=lambda: 1000.0, time=time.time)
        with patch("service.chat.service.subscriptions.time", clock):
            first = await self.subscriptions.catalog(OWNER, connection)
            self.requests.clear()
            for age in (61.0, 3600.0, 10799.0):
                clock.monotonic = lambda age=age: 1000.0 + age
                self.assertEqual(await self.subscriptions.catalog(OWNER, connection), first)
                self.assertEqual(self.requests, [])
            clock.monotonic = lambda: 11800.0
            await self.subscriptions.catalog(OWNER, connection)
            self.assertEqual(len(self.requests), 1)
        self.assertEqual(
            first["models"][0]["model_messages"],
            UPSTREAM_MODELS_PAYLOAD["models"][0]["model_messages"],
        )

    async def test_model_requests_use_public_endpoint_without_codex_identity(self):
        connection = await self.connected()
        self.requests.clear()
        visible = await self.subscriptions.models(OWNER, connection, fresh=True)
        await self.subscriptions.catalog(OWNER, connection)
        self.assertEqual(len(self.requests), 2)
        for request in self.requests:
            self.assertEqual(str(request.url), "https://api.openai.com/v1/models")
            self.assertNotIn("originator", request.headers)
            self.assertNotIn("chatgpt-account-id", request.headers)
        self.assertEqual([model["id"] for model in visible["models"]], [MODEL])

    async def test_model_list_keeps_short_ttl_and_fresh_bypasses_cache(self):
        connection = await self.connected()
        clock = SimpleNamespace(monotonic=lambda: 1000.0, time=time.time)
        with patch("service.chat.service.subscriptions.time", clock):
            await self.subscriptions.models(OWNER, connection, fresh=True)
            self.requests.clear()
            clock.monotonic = lambda: 1059.0
            await self.subscriptions.models(OWNER, connection)
            self.assertEqual(self.requests, [])
            clock.monotonic = lambda: 1060.0
            await self.subscriptions.models(OWNER, connection)
            self.assertEqual(len(self.requests), 1)
            await self.subscriptions.models(OWNER, connection, fresh=True)
            self.assertEqual(len(self.requests), 2)

    async def test_explicit_directory_refresh_invalidates_cached_runtime_configuration(self):
        connection = await self.connected()
        await self.subscriptions.catalog(OWNER, connection)
        self.requests.clear()
        await self.subscriptions.sync_directory(OWNER, connection)
        await self.subscriptions.catalog(OWNER, connection)
        self.assertEqual(len(self.requests), 2)

    async def test_logout_invalidates_runtime_catalog_and_disconnect_rejects_cached_config(self):
        connection = await self.connected()
        await self.subscriptions.catalog(OWNER, connection)
        self.requests.clear()
        await self.subscriptions.logout(OWNER)
        await self.subscriptions.catalog(OWNER, connection)
        self.assertEqual(len(self.requests), 1)
        await self.subscriptions.disconnect(OWNER, connection)
        with self.assertRaises(CompletionCredentialError):
            await self.subscriptions.catalog(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "new-access",
                "refresh",
                time.time() + 3600,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=self.credentials.read(OWNER, connection).generation,
        )
        self.requests.clear()
        await self.subscriptions.catalog(OWNER, connection)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer new-access")

    async def test_default_subscription_client_inherits_environment_proxy(self):
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"models": []}))
        )
        bridge = CompletionBridge("http://127.0.0.1:8771")
        with patch(
            "service.chat.service.subscriptions.httpx.AsyncClient", return_value=client
        ) as create:
            subscriptions = SubscriptionService(
                self.profiles, self.credentials, bridge, activities=Activities()
            )
        try:
            self.assertIs(subscriptions.client, client)
            self.assertIs(create.call_args.kwargs["trust_env"], True)
        finally:
            await subscriptions.close()

    async def test_suspended_subscription_reference_restores_the_child_endpoint(self):
        connection = await self.connected()
        first = self.subscriptions.register(OWNER, connection, MODEL, "paused-parent", {})
        upstream = self.bridge._upstreams[first.bridge_id]
        repeated = self.subscriptions.register(OWNER, connection, MODEL, "paused-parent", {})
        self.assertEqual(repeated, first)
        self.assertIs(self.bridge._upstreams[first.bridge_id], upstream)
        await self.models.suspend_session("paused-parent")
        self.assertNotIn(first.bridge_id, self.bridge._upstreams)
        self.assertEqual((await self.bridge.forward(first.bridge_id, {})).status_code, 404)
        self.assertEqual(len(self.bridge._references), 1)
        reference = next(iter(self.bridge._references.values()))
        self.assertEqual(
            set(vars(reference)),
            {"bridge_id", "session_id", "owner_id", "connection_id", "scope", "state"},
        )
        restored = self.subscriptions.register(OWNER, connection, MODEL, "paused-parent", {})
        self.assertEqual(restored, first)
        self.assertIsNot(self.bridge._upstreams[first.bridge_id], upstream)
        self.assertIsNot(
            self.bridge._upstreams[first.bridge_id].credential_resolver,
            upstream.credential_resolver,
        )
        self.assertEqual((await self.bridge.catalog(first.bridge_id)).status_code, 200)
        self.models.release_session("paused-parent")
        self.assertEqual(len(self.bridge._references), 0)
        reopened = self.subscriptions.register(OWNER, connection, MODEL, "paused-parent", {})
        self.assertNotEqual(reopened, first)

    async def test_suspended_reference_never_crosses_policy_or_revocation_boundaries(self):
        connection = await self.connected()
        original = self.subscriptions.register(
            OWNER, connection, MODEL, "policy-parent", {}, reasoning_effort="low"
        )
        await self.models.suspend_session("policy-parent")
        changed_effort = self.subscriptions.register(
            OWNER, connection, MODEL, "policy-parent", {}, reasoning_effort="high"
        )
        changed_catalog = self.subscriptions.register(
            OWNER,
            connection,
            MODEL,
            "policy-parent",
            {},
            reasoning_effort="low",
            catalog_identity="changed-schema",
        )
        self.assertNotEqual(changed_effort, original)
        self.assertNotEqual(changed_catalog, original)
        await self.models.suspend_session("policy-parent")
        self.bridge.revoke_connection(OWNER, connection)
        self.assertEqual(len(self.bridge._references), 0)
        restored = self.subscriptions.register(
            OWNER, connection, MODEL, "policy-parent", {}, reasoning_effort="low"
        )
        self.assertNotEqual(restored, original)

    async def test_active_subscription_reregistration_preserves_calls_and_resolvers(self):
        connection = await self.connected()
        originalCatalog = AsyncMock(return_value={"models": []})
        replacementCatalog = AsyncMock(return_value={"models": []})
        first = self.subscriptions.register(
            OWNER, connection, MODEL, "active-parent", {}, catalog_resolver=originalCatalog
        )
        upstream = self.bridge._upstreams[first.bridge_id]
        originalCredentials = upstream.credential_resolver
        originalPolicy = upstream.request_policy
        originalResolver = upstream.catalog_resolver
        pendingCall = Mock(spec=["revoke", "close", "task"])
        pendingCall.task = None
        pendingCall.close = AsyncMock()
        upstream.calls.add(pendingCall)
        repeated = self.subscriptions.register(
            OWNER, connection, MODEL, "active-parent", {}, catalog_resolver=replacementCatalog
        )
        self.assertEqual(repeated, first)
        self.assertIs(self.bridge._upstreams[first.bridge_id], upstream)
        self.assertEqual(upstream.calls, {pendingCall})
        self.assertIs(upstream.credential_resolver, originalCredentials)
        self.assertIs(upstream.request_policy, originalPolicy)
        self.assertIs(upstream.catalog_resolver, originalResolver)
        await upstream.catalog_resolver(OWNER, connection)
        originalCatalog.assert_awaited_once_with(OWNER, connection)
        replacementCatalog.assert_not_awaited()
        pendingCall.revoke.assert_not_called()
        pendingCall.close.assert_not_awaited()

    async def test_subscription_pause_waits_for_call_cleanup_before_reactivation(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "waiting-parent", {})
        upstream = self.bridge._upstreams[registration.bridge_id]
        entered, finished = asyncio.Event(), asyncio.Event()

        async def close():
            entered.set()
            await finished.wait()

        pendingCall = Mock(spec=["revoke", "close", "task"])
        pendingCall.task = None
        pendingCall.close = AsyncMock(side_effect=close)
        upstream.calls.add(pendingCall)
        task = asyncio.create_task(self.bridge.suspend("waiting-parent"))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            pendingCall.revoke.assert_called_once()
            self.assertFalse(task.done())
            self.assertNotIn(registration.bridge_id, self.bridge._upstreams)
            self.assertEqual(self.bridge._references[registration.bridge_id].state.value, "pausing")
            with self.assertRaises(CompletionCleanupUnknown):
                self.subscriptions.register(OWNER, connection, MODEL, "waiting-parent", {})
            finished.set()
            await task
            pendingCall.close.assert_awaited_once()
            self.assertEqual(self.bridge._references[registration.bridge_id].state.value, "paused")
            restored = self.subscriptions.register(OWNER, connection, MODEL, "waiting-parent", {})
            self.assertEqual(restored, registration)
            self.assertIsNot(self.bridge._upstreams[registration.bridge_id], upstream)
        finally:
            finished.set()
            await asyncio.gather(task, return_exceptions=True)

    async def test_subscription_pause_cleanup_failure_remains_fenced(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "unknown-parent", {})
        pendingCall = Mock(spec=["revoke", "close", "task"])
        pendingCall.task = None
        pendingCall.close = AsyncMock(side_effect=OSError("cleanup unknown"))
        self.bridge._upstreams[registration.bridge_id].calls.add(pendingCall)
        with self.assertRaises(CompletionCleanupUnknown):
            await self.bridge.suspend("unknown-parent")
        self.assertNotIn(registration.bridge_id, self.bridge._upstreams)
        self.assertEqual(self.bridge._references[registration.bridge_id].state.value, "pausing")
        with self.assertRaises(CompletionCleanupUnknown):
            self.subscriptions.register(OWNER, connection, MODEL, "unknown-parent", {})
        self.assertEqual((await self.bridge.forward(registration.bridge_id, {})).status_code, 404)

    async def test_pause_never_restores_references_revoked_during_cleanup(self):
        connection = await self.connected()
        for operation in ("release", "owner", "connection"):
            with self.subTest(operation=operation):
                sessionId = f"revoked-parent-{operation}"
                registration = self.subscriptions.register(OWNER, connection, MODEL, sessionId, {})
                entered, finished = asyncio.Event(), asyncio.Event()

                async def close():
                    entered.set()
                    await finished.wait()

                pendingCall = Mock(spec=["revoke", "close", "task"])
                pendingCall.task = None
                pendingCall.close = AsyncMock(side_effect=close)
                self.bridge._upstreams[registration.bridge_id].calls.add(pendingCall)
                task = asyncio.create_task(self.bridge.suspend(sessionId))
                try:
                    await asyncio.wait_for(entered.wait(), 1)
                    if operation == "release":
                        removed = self.bridge.release(sessionId)
                    elif operation == "owner":
                        removed = self.bridge.revoke_owner(OWNER)
                    else:
                        removed = self.bridge.revoke_connection(OWNER, connection)
                    self.assertEqual(removed, 1)
                    finished.set()
                    await task
                    self.assertNotIn(registration.bridge_id, self.bridge._references)
                    self.assertNotIn(registration.bridge_id, self.bridge._upstreams)
                    self.assertEqual(
                        (await self.bridge.forward(registration.bridge_id, {})).status_code, 404
                    )
                finally:
                    finished.set()
                    await asyncio.gather(task, return_exceptions=True)

    async def test_pause_waits_for_call_task_that_defers_credential_cancellation(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "resolver-parent", {})
        entered, cancelled, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def resolver():
            entered.set()
            try:
                await finished.wait()
            except asyncio.CancelledError:
                cancelled.set()
                await finished.wait()

        resolverTask = asyncio.create_task(resolver())
        await asyncio.wait_for(entered.wait(), 1)
        pendingCall = Mock(spec=["revoke", "close", "task"])
        pendingCall.task = resolverTask
        pendingCall.revoke.side_effect = resolverTask.cancel
        pendingCall.close = AsyncMock()
        self.bridge._upstreams[registration.bridge_id].calls.add(pendingCall)
        task = asyncio.create_task(self.bridge.suspend("resolver-parent"))
        try:
            await asyncio.wait_for(cancelled.wait(), 1)
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(asyncio.shield(task), 0.05)
            self.assertFalse(task.done())
            self.assertFalse(resolverTask.done())
            with self.assertRaises(CompletionCleanupUnknown):
                self.subscriptions.register(OWNER, connection, MODEL, "resolver-parent", {})
            finished.set()
            await task
            self.assertTrue(resolverTask.done())
        finally:
            finished.set()
            await asyncio.gather(task, resolverTask, return_exceptions=True)

    async def test_registration_release_excludes_its_current_call_task(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "own-task-parent", {})
        pendingCall = Mock(spec=["revoke", "close", "task"])
        pendingCall.task = asyncio.current_task()
        pendingCall.close = AsyncMock()
        self.bridge._upstreams[registration.bridge_id].calls.add(pendingCall)
        async with asyncio.timeout(1):
            await self.bridge.release_registration(registration)
        pendingCall.close.assert_awaited_once()
        self.assertNotIn(registration.bridge_id, self.bridge._references)

    async def test_reference_capacity_fails_closed_without_crossing_connection_scope(self):
        connection = await self.connected()
        values = {
            "endpoint": "https://subscription.example/responses",
            "responses_endpoint": "https://subscription.example/responses",
            "wire_protocol": ModelWireProtocol.RESPONSES,
            "api_key": "",
            "owner_id": OWNER,
            "connection_id": connection,
            "session_id": "bounded-parent",
            "credential_resolver": AsyncMock(),
            "resume_scope": json.dumps({"model": MODEL, "catalog": "original"}),
        }
        with patch("service.chat.service.completions.BRIDGE_REFERENCE_LIMIT", 1):
            first = self.bridge.register(**values)
            upstream = self.bridge._upstreams[first.bridge_id]
            for changes in (
                {"owner_id": OTHER},
                {"connection_id": "another-connection"},
                {"session_id": "another-parent"},
                {"resume_scope": json.dumps({"model": "another-model", "catalog": "original"})},
                {"resume_scope": json.dumps({"model": MODEL, "catalog": "changed"})},
                {"model_routes": {"alias": MODEL}},
                {"reasoning_effort": "high"},
            ):
                with self.subTest(changes=changes):
                    with self.assertRaisesRegex(ValueError, "model_bridge_reference_limit"):
                        self.bridge.register(**{**values, **changes})
                    self.assertEqual(self.bridge.register(**values), first)
                    self.assertIs(self.bridge._upstreams[first.bridge_id], upstream)
                    self.assertTrue(upstream.active)
                    self.assertEqual(set(self.bridge._references), {first.bridge_id})
            await self.bridge.suspend("bounded-parent")
            self.assertEqual(self.bridge.register(**values), first)

    async def test_authorized_catalog_and_session_are_owned_subscription_transport(self):
        connection = await self.connected()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer access")
        self.assertNotIn("chatgpt-account-id", self.requests[0].headers)
        self.assertNotIn("client_version", self.requests[0].url.params)
        # 配置时加载：上游目录在 sync_directory 落快照，读路径(catalog)只读快照。
        await self.subscriptions.sync_directory(OWNER, connection)
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            catalog = await self.models.catalog(user_id=OWNER)
            self.assertEqual(len(catalog["available_models"]), 1)
            self.assertEqual(catalog["available_models"][0]["billing"], "subscription")
            self.assertEqual(catalog["available_models"][0]["reasoning_efforts"], ["low", "high"])
            self.assertEqual(
                catalog["available_models"][0]["input_modalities"],
                ["text", "image", "pdf"],
            )
            self.assertTrue(catalog["available_models"][0]["image_input"])
            self.assertTrue(
                self.models.inference_connection(
                    personal_model_key(connection, MODEL), user_id=OWNER
                )["image_input"]
            )
            await self.models.validate_effort(
                personal_model_key(connection, MODEL), "high", user_id=OWNER
            )
            with self.assertRaises(SessionModelUnavailableError):
                await self.models.validate_effort(
                    personal_model_key(connection, MODEL), "xhigh", user_id=OWNER
                )
            self.assertEqual((await self.models.catalog(user_id=OTHER))["available_models"], [])
            spec = self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="session", user_id=OWNER
            )
            registration = next(iter(self.bridge._upstreams.values()))
            self.assertTrue(registration.trust_env)
            intent, port = spec.runtime_model()
            self.assertEqual(intent.transport.mode.value, "remote")
            self.assertEqual(intent.transport.wire_protocol.value, "responses")
            self.assertTrue(intent.transport.endpoint.startswith("http://127.0.0.1:8770/"))
            self.assertIsNone(port)
            self.assertEqual(intent.capabilities.tool_protocol.value, "provider_native")
            self.assertIs(getattr(spec.capabilities, "native_agent_messages", None), False)
            self.assertIs(getattr(intent.capabilities, "native_agent_messages", None), False)
            self.assertNotIn("access", repr(intent))
        self.assertNotIn("access", json.dumps(self.models.profiles(user_id=OWNER)))
        self.assertNotIn("refresh", self.profiles.path.read_text())
        await self.subscriptions.logout(OWNER)
        self.assertEqual(self.bridge.registration_count(), 0)
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        await self.subscriptions.disconnect(OWNER, connection)
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.DISCONNECTED
        )

    async def test_direct_inference_preserves_oauth_endpoint_owner_and_metering(self):
        connection = await self.connected()
        key = personal_model_key(connection, MODEL)
        other = self.subscriptions.register(OWNER, connection, MODEL, "other-invocation", {})
        async with self.models.inference(
            key, user_id=OWNER, invocation_id="direct-invocation"
        ) as prepared:
            self.assertEqual(prepared["billing"], "subscription")
            self.assertEqual(prepared["model"], MODEL)
            self.assertEqual(prepared["headers"], {})
            self.assertFalse(prepared["trust_env"])
            self.assertNotIn("access", repr(prepared))
            upstream = next(
                value
                for value in self.bridge._upstreams.values()
                if value.session_id == "direct-invocation"
            )
            self.assertEqual(upstream.endpoint, CHATGPT_PROVIDER.responses_endpoint)
            self.assertEqual(upstream.responses_endpoint, CHATGPT_PROVIDER.responses_endpoint)
            self.assertEqual(upstream.owner_id, OWNER)
            self.assertEqual(upstream.turn_id(), "direct-invocation")
            self.assertEqual(
                (await upstream.credential_resolver(OWNER, connection)).api_key, "access"
            )
            self.assertEqual(self.bridge.registration_count(), 2)
        self.assertEqual(set(self.bridge._upstreams), {other.bridge_id})

    async def test_tool_free_inference_crosses_bridge_without_unsupported_output_budget(self):
        connection = await self.connected()
        app = FastAPI()
        mount_completion_bridge(app, self.bridge)
        sent = []

        def upstream(request):
            sent.append(request)
            event = {
                "type": "response.completed",
                "response": {
                    "id": "one-shot",
                    "status": "completed",
                    "output": [
                        {
                            "type": "message",
                            "content": [{"type": "output_text", "text": '{"translation":"done"}'}],
                        }
                    ],
                    "usage": {"input_tokens": 11, "output_tokens": 3},
                },
            }
            return httpx.Response(200, text="data: " + json.dumps(event) + "\n\n")

        http_client = httpx.AsyncClient
        upstream_client = http_client(transport=httpx.MockTransport(upstream))
        self.bridge._clients[SUBSCRIPTION_TRUST_ENV] = upstream_client
        request = ModelInvocationRequest(
            "one-shot",
            OWNER,
            "project",
            "assistant.translate",
            personal_model_key(connection, MODEL),
            "translate",
            "source",
            ModelInvocationLimits(100, 50),
            json_output=True,
            require_tool_free=True,
        )
        with patch(
            "service.inference.transport.httpx.AsyncClient",
            side_effect=lambda **kwargs: http_client(
                transport=httpx.ASGITransport(app=app), **kwargs
            ),
        ):
            result = await InferenceProvider(self.models).invoke(request)
        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        self.assertEqual(result.output_text, '{"translation":"done"}')
        self.assertEqual((result.usage.input_tokens, result.usage.output_tokens), (11, 3))
        self.assertEqual(len(sent), 1)
        self.assertEqual(str(sent[0].url), CHATGPT_PROVIDER.responses_endpoint)
        self.assertEqual(sent[0].headers["authorization"], "Bearer access")
        body = json.loads(sent[0].content)
        self.assertNotIn("max_output_tokens", body)
        self.assertNotIn("output_token_limit_supported", body)
        self.assertEqual(body["instructions"], "translate")
        content = body["input"][0]["content"]
        self.assertEqual(content[0], {"type": "input_text", "text": "source"})
        self.assertEqual(len(content), 2)
        self.assertEqual(content[1]["type"], "input_text")
        self.assertIn("JSON object", content[1]["text"])
        self.assertEqual(body["text"], {"format": {"type": "json_object"}})
        self.assertEqual(body["tools"], [])
        self.assertEqual(body["tool_choice"], "none")
        self.assertTrue(body["stream"])
        self.assertFalse(body["store"])
        self.assertEqual(self.bridge.registration_count(), 0)

    async def test_cancelled_direct_scope_retires_only_its_own_registration(self):
        connection = await self.connected()
        key = personal_model_key(connection, MODEL)
        entered = asyncio.Event()
        other = self.subscriptions.register(OWNER, connection, MODEL, "other-invocation", {})

        async def invoke():
            async with self.models.inference(
                key, user_id=OWNER, invocation_id="cancelled-invocation"
            ):
                entered.set()
                await asyncio.Event().wait()

        task = asyncio.create_task(invoke())
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(set(self.bridge._upstreams), {other.bridge_id})

    async def test_transient_tls_connect_failure_retries_before_serving_directory(self):
        attempts = {"count": 0}

        def flaky(request):
            attempts["count"] += 1
            if attempts["count"] == 1:
                error = httpx.ConnectError("peer closed during handshake")
                error.__cause__ = ssl.SSLEOFError(ssl.SSL_ERROR_EOF, "eof in handshake")
                raise error
            return httpx.Response(200, json=UPSTREAM_MODELS_PAYLOAD)

        self.reinstall(flaky)
        with patch(
            "service.chat.service.subscriptions.SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS", 0.0
        ):
            connection = await self.connected()
        self.assertEqual(attempts["count"], SUBSCRIPTION_MODELS_RETRY_ATTEMPTS - 1)
        self.assertEqual(len(self.requests), SUBSCRIPTION_MODELS_RETRY_ATTEMPTS - 1)
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        self.assertFalse(self.subscriptions.sync_on_cooldown(OWNER, connection))

    async def test_transient_dns_failure_retries_before_serving_directory(self):
        attempts = {"count": 0}

        def flaky(request):
            attempts["count"] += 1
            if attempts["count"] == 1:
                error = httpx.ConnectError("temporary name resolution failure")
                error.__cause__ = socket.gaierror(socket.EAI_AGAIN, "temporary failure")
                raise error
            return httpx.Response(200, json=UPSTREAM_MODELS_PAYLOAD)

        self.reinstall(flaky)
        with patch(
            "service.chat.service.subscriptions.SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS", 0.0
        ):
            connection = await self.connected()
        self.assertEqual(attempts["count"], 2)
        self.assertEqual(len(self.requests), 2)
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        self.assertFalse(self.subscriptions.sync_on_cooldown(OWNER, connection))

    async def test_retryable_transport_failures_exhaust_attempts_before_unavailable(self):
        connection = await self.connected()
        self.assertEqual(len(self.requests), 1)

        def always_fail(request):
            raise httpx.ConnectError("handshake never completes")

        self.reinstall(always_fail)
        with patch(
            "service.chat.service.subscriptions.SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS", 0.0
        ):
            with self.assertRaises(OAuthFailure):
                await self.subscriptions.sync_directory(OWNER, connection)
        self.assertEqual(len(self.requests), SUBSCRIPTION_MODELS_RETRY_ATTEMPTS)
        self.assertTrue(self.subscriptions.sync_on_cooldown(OWNER, connection))

    async def test_non_retryable_transport_failure_fails_without_retry(self):
        connection = await self.connected()

        def read_failure(request):
            raise httpx.ReadError("connection reset mid-body")

        self.reinstall(read_failure)
        with self.assertRaises(OAuthFailure):
            await self.subscriptions.sync_directory(OWNER, connection)
        self.assertEqual(len(self.requests), 1)

    async def test_upstream_token_revoked_marks_credential_reauth_required(self):
        """上游对未过期令牌返回 401 token_revoked → 回写 REAUTH_REQUIRED，不再停在 connected。"""

        connection = await self.connected()
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        self.reinstall(
            lambda request: httpx.Response(
                401,
                json={
                    "error": {
                        "message": "Encountered invalidated oauth token for user",
                        "type": None,
                        "code": "token_revoked",
                        "param": None,
                    },
                    "status": 401,
                },
            )
        )
        with self.assertRaises(OAuthFailure) as raised:
            await self.subscriptions.sync_directory(OWNER, connection)
        self.assertEqual(raised.exception.code, "oauth_reauth_required")
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )
        self.assertEqual(
            self.subscriptions.status(OWNER, connection)["state"],
            CredentialState.REAUTH_REQUIRED.value,
        )

    async def test_catalog_refresh_remains_owned_until_credential_refresh_finishes(self):
        connection = await self.connected()
        await asyncio.gather(*tuple(self.models._directory_tasks.values()))
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        self.reinstall(
            lambda request: httpx.Response(
                200,
                json={
                    "access_token": "refreshed-access",
                    "refresh_token": "refreshed-refresh",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )
        )
        entered, finish = asyncio.Event(), asyncio.Event()
        original = self.subscriptions.refresh_expiring

        async def delayed(owner_id, profile_id, *, wait=False):
            entered.set()
            await finish.wait()
            await original(owner_id, profile_id, wait=wait)

        with patch.object(self.subscriptions, "refresh_expiring", delayed):
            reading = asyncio.create_task(self.models.catalog(user_id=OWNER, refresh=True))
            await asyncio.wait_for(entered.wait(), 2)
            generation = self.activities.begin()
            self.assertFalse(self.activities.seal(generation))
            with self.assertRaises(MaintenanceActive):
                await self.models.catalog(user_id=OWNER)
            finish.set()
            await asyncio.wait_for(reading, 2)
        self.assertTrue(self.activities.seal(generation))
        self.assertEqual(
            self.credentials.read(OWNER, connection).tokens.access_token, "refreshed-access"
        )
        self.activities.resume(generation)

    async def test_expired_refresh_401_is_removed_from_model_catalog(self):
        connection = await self.connected()
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        self.reinstall(
            lambda request: httpx.Response(401, json={"error": {"message": "invalid grant"}})
        )
        payload = await self.models.catalog(user_id=OWNER, refresh=True)
        row = next(
            model
            for model in payload["available_models"]
            if model["key"] == personal_model_key(connection, MODEL)
        )
        self.assertTrue(row["disabled"])
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )
        self.assertEqual(len(self.requests), 1)

    async def test_catalog_refreshes_expiring_oauth_only_once(self):
        connection = await self.connected()
        self.profiles.set_directory(connection, {"models": [{"id": MODEL}]}, owner_id=OWNER)
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        self.reinstall(
            lambda request: httpx.Response(
                200,
                json={
                    "access_token": "refreshed-access",
                    "refresh_token": "refreshed-refresh",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )
        )
        await self.models.catalog(user_id=OWNER)
        await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
        await self.models.catalog(user_id=OWNER)
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)

    async def test_catalog_projects_reauth_after_background_refresh_finishes(self):
        connection = await self.connected()
        self.profiles.set_directory(connection, {"models": [{"id": MODEL}]}, owner_id=OWNER)
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        requested, respond = asyncio.Event(), asyncio.Event()

        async def handler(request):
            requested.set()
            await respond.wait()
            return httpx.Response(400, json={"error": "invalid_grant"})

        self.reinstall(handler)
        try:
            first = await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
            await asyncio.wait_for(requested.wait(), 2)
            row = next(
                item for item in first["available_models"] if item.get("profile_id") == connection
            )
            self.assertFalse(row.get("disabled", False))
        finally:
            respond.set()
        with self.assertRaisesRegex(OAuthFailure, "^oauth_reauth_required$"):
            await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
        second = await self.models.catalog(user_id=OWNER)
        row = next(
            item for item in second["available_models"] if item.get("profile_id") == connection
        )
        self.assertTrue(row["disabled"])
        self.assertEqual(len(self.requests), 1)

    async def test_catalog_keeps_connection_on_transient_refresh_failure(self):
        connection = await self.connected()
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )

        def unavailable(request):
            raise httpx.ConnectError("issuer unavailable", request=request)

        self.reinstall(unavailable)
        payload = await self.models.catalog(user_id=OWNER)
        with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
            await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
        await self.models.catalog(user_id=OWNER)
        with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
            await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
        self.assertEqual(len(self.requests), 1)
        row = next(
            model
            for model in payload["available_models"]
            if model["key"] == personal_model_key(connection, MODEL)
        )
        self.assertFalse(row.get("disabled", False))
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)

    async def test_catalog_returns_while_shared_refresh_is_pending(self):
        connection = await self.connected()
        self.profiles.set_directory(connection, {"models": [{"id": MODEL}]}, owner_id=OWNER)
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        requested, respond = asyncio.Event(), asyncio.Event()

        async def handler(request):
            requested.set()
            await respond.wait()
            return httpx.Response(
                200,
                json={
                    "access_token": "refreshed-access",
                    "refresh_token": "refreshed-refresh",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )

        self.reinstall(handler)
        builtin = {"key": "paid-model", "billing": "api", "model_name": "paid-model"}
        try:
            with (
                patch("service.chat.service.models.load_builtin_work_config", return_value={}),
                patch("service.chat.service.models.available_models", return_value=[builtin]),
            ):
                payload = await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
                await asyncio.wait_for(requested.wait(), 2)
                self.assertTrue(
                    any(
                        row["key"] == "paid-model" and not row.get("disabled")
                        for row in payload["available_models"]
                    )
                )
                await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
                self.assertEqual(len(self.requests), 1)
        finally:
            respond.set()
        await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)

    async def test_missing_snapshot_sync_and_catalog_share_refresh_failure_cooldown(self):
        connection = await self.connected()
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        self.profiles.set_directory(connection, {"models": []}, owner_id=OWNER)
        requested, respond, syncFinished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        syncCount = [0]

        async def handler(request):
            requested.set()
            await respond.wait()
            raise httpx.ConnectError("issuer unavailable", request=request)

        self.reinstall(handler)
        originalSync = self.subscriptions.sync_directory

        async def sync(owner_id, connection_id):
            try:
                return await originalSync(owner_id, connection_id)
            finally:
                syncCount[0] += 1
                if syncCount[0] == 1:
                    syncFinished.set()

        try:
            with patch.object(self.subscriptions, "sync_directory", side_effect=sync):
                await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
                await asyncio.wait_for(requested.wait(), 2)
                await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
                respond.set()
                await asyncio.wait_for(syncFinished.wait(), 2)
                self.assertEqual(syncCount[0], 1)
                with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
                    await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
                await self.models.catalog(user_id=OWNER)
                with self.assertRaisesRegex(OAuthFailure, "^oauth_network_unavailable$"):
                    await self.subscriptions.resolvers["chatgpt"].resolve(OWNER, connection)
                self.assertEqual(len(self.requests), 1)
        finally:
            respond.set()

    async def test_deleting_connection_fences_pending_catalog_refresh(self):
        connection = await self.connected()
        self.profiles.set_directory(connection, {"models": [{"id": MODEL}]}, owner_id=OWNER)
        record = self.credentials.read(OWNER, connection)
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens(
                "expired-access",
                "expired-refresh",
                time.time() - 1,
                "account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=record.generation,
        )
        requested, respond = asyncio.Event(), asyncio.Event()

        async def handler(request):
            requested.set()
            await respond.wait()
            return httpx.Response(
                200,
                json={
                    "access_token": "refreshed-access",
                    "refresh_token": "refreshed-refresh",
                    "expires_in": 3600,
                    "token_type": "Bearer",
                },
            )

        self.reinstall(handler)
        resolver = self.subscriptions.resolvers["chatgpt"]
        try:
            await asyncio.wait_for(self.models.catalog(user_id=OWNER), 2)
            await asyncio.wait_for(requested.wait(), 2)
            rotation = resolver.prefetch(OWNER, connection)
            await asyncio.wait_for(self.models.delete_profile(connection, user_id=OWNER), 2)
        finally:
            respond.set()
        with self.assertRaisesRegex(OAuthFailure, "^oauth_connection_changed$"):
            await rotation
        self.assertIsNone(self.profiles.profile(connection, owner_id=OWNER))
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.DISCONNECTED
        )

    async def test_bridge_catalog_surfaces_reauth_instead_of_generic_502(self):
        """模型桥目录端点遇到吊销令牌时透出 401+reauth 码，而不是通用 502。"""

        connection = await self.connected()
        self.reinstall(
            lambda request: httpx.Response(
                401, json={"error": {"code": "token_revoked"}, "status": 401}
            )
        )
        registration = self.subscriptions.register(OWNER, connection, MODEL, "reauth-catalog", {})
        result = await self.bridge.catalog(registration.bridge_id)
        self.assertEqual(result.status_code, 401)
        self.assertEqual(json.loads(result.body)["error"]["code"], "oauth_reauth_required")
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )

    async def test_revocation_is_not_masked_by_stale_directory_cache(self):
        """已缓存目录 + 上游转为吊销：TTL 过期后重拉遇 401，必须上抛 reauth 而非回落旧缓存。"""

        mode = {"status": 200}

        def handler(request):
            if mode["status"] == 200:
                return httpx.Response(200, json=UPSTREAM_MODELS_PAYLOAD)
            return httpx.Response(401, json={"error": {"code": "token_revoked"}, "status": 401})

        self.reinstall(handler)
        connection = await self.connected()
        await self.subscriptions.models(OWNER, connection)
        mode["status"] = 401
        with patch("service.chat.service.subscriptions.SUBSCRIPTION_DIRECTORY_CACHE_SECONDS", 0.0):
            with self.assertRaises(OAuthFailure) as raised:
                await self.subscriptions.models(OWNER, connection)
        self.assertEqual(raised.exception.code, "oauth_reauth_required")
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )

    async def test_non_revocation_upstream_error_does_not_mark_reauth(self):
        """5xx/普通 401（非白名单 code）不得被误判为登录失效；吊销回写幂等。"""

        connection = await self.connected()
        handle = self.subscriptions._handle_upstream_revocation
        self.assertEqual(handle(OWNER, connection, 401, "unauthorized"), "")
        self.assertEqual(handle(OWNER, connection, 503, "token_revoked"), "")
        self.assertEqual(handle(OWNER, connection, 401, ""), "")
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        self.assertEqual(handle(OWNER, connection, 401, "token_revoked"), "oauth_reauth_required")
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )
        self.assertEqual(handle(OWNER, connection, 401, "invalid_token"), "oauth_reauth_required")
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.REAUTH_REQUIRED
        )

    async def test_runtime_catalog_preserves_the_selected_connection_metadata(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "catalog-session", {})
        result = await self.bridge.catalog(registration.bridge_id)
        self.assertEqual(result.status_code, 200)
        payload = json.loads(result.body)
        selected = payload["models"][0]
        self.assertEqual(selected["tool_mode"], "code_mode")
        self.assertTrue(selected["use_responses_lite"])
        self.assertEqual(
            selected["model_messages"]["instructions_template"], "provider instructions"
        )
        self.assertEqual(payload["models"][1]["slug"], "hidden-model")
        self.assertEqual(self.requests[-1].headers["authorization"], "Bearer access")
        self.bridge.release("catalog-session")
        self.assertEqual((await self.bridge.catalog(registration.bridge_id)).status_code, 404)

    async def test_product_bridge_sessions_share_catalog_without_sharing_call_permission(self):
        connection = await self.connected()
        await self.models.save_profile(
            {
                **self.values,
                "selected_models": [
                    {
                        "id": MODEL,
                        "reasoning_efforts": ["low", "high"],
                        "input_modalities": ["text", "image", "pdf"],
                    }
                ],
            },
            connection,
            user_id=OWNER,
        )
        config = {"model_name": "qwen3.8-flash", "base_url": DEEPRD_GATEWAY_BASE_URL}
        self.models._account_tokens = SimpleNamespace(current=lambda owner: f"token-{owner}")
        with (
            patch("service.chat.service.models.load_builtin_work_config", return_value=config),
            patch.object(
                self.subscriptions, "resolve", wraps=self.subscriptions.resolve
            ) as secrets,
        ):
            qwen = self.models.session_spec("qwen3.8-flash", session_id="qwen", user_id=OWNER)
            native = self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="native", user_id=OWNER
            )
            self.assertEqual(self.bridge.registration_count(), 2)
            secrets.assert_not_called()
            self.assertEqual(qwen.catalog_models, native.catalog_models)
            qwen_intent, _ = qwen.runtime_model()
            native_intent, _ = native.runtime_model()
            self.assertEqual(qwen_intent.transport.proxy_bypass_hosts, ("127.0.0.1",))
            self.assertEqual(
                qwen_intent.transport.proxy_bypass_hosts,
                native_intent.transport.proxy_bypass_hosts,
            )
            entries = {entry.model_ref: entry for entry in qwen.catalog_models}
            self.assertIs(
                getattr(entries[MODEL].capabilities, "native_agent_messages", None), False
            )
            self.assertIs(getattr(native_intent.capabilities, "native_agent_messages", None), False)
            self.assertIsNone(getattr(qwen_intent.capabilities, "native_agent_messages", None))
            self.assertEqual(
                entries[MODEL].capabilities.tool_protocol, ModelToolProtocol.PROVIDER_NATIVE
            )
            self.assertEqual(entries[MODEL].capabilities.reasoning_efforts, ("low", "high"))
            self.assertIn("pdf", entries[MODEL].capabilities.input_modalities)
            self.assertEqual(entries[MODEL].approval_model_ref, "")
            self.assertEqual(
                entries["qwen3.8-flash"].capabilities.tool_protocol, ModelToolProtocol.JSON_SCHEMA
            )
            reviewer = qwen_intent.approval_model_ref
            self.assertIsNone(
                getattr(entries["qwen3.8-flash"].capabilities, "native_agent_messages", None)
            )
            self.assertIsNone(
                getattr(entries[reviewer].capabilities, "native_agent_messages", None)
            )
            self.assertEqual(entries["qwen3.8-flash"].approval_model_ref, reviewer)
            self.assertEqual(entries[reviewer].approval_model_ref, reviewer)
            self.assertNotEqual(
                entries["qwen3.8-flash"].context_window, entries[MODEL].context_window
            )
            upstreams = {item.session_id: item for item in self.bridge._upstreams.values()}
            qwen_upstream = upstreams["qwen"]
            native_upstream = upstreams["native"]
            self.assertEqual(qwen_upstream.owner_id, OWNER)
            self.assertEqual(native_upstream.connection_id, connection)
            payloads = [
                await upstream.catalog_resolver(upstream.owner_id, upstream.connection_id)
                for upstream in (qwen_upstream, native_upstream)
            ]
            self.assertEqual(payloads[0], payloads[1])
            self.assertEqual(payloads[0]["models"][0], UPSTREAM_MODELS_PAYLOAD["models"][0])
            for model in ("qwen3.8-flash", reviewer):
                self.assertEqual(qwen_upstream.request_policy({"model": model})["model"], model)
            with self.assertRaises(SessionModelUnavailableError):
                qwen_upstream.request_policy({"model": MODEL})
            with self.assertRaises(OAuthFailure):
                native_upstream.request_policy({"model": "qwen3.8-flash"})

    async def test_unified_catalog_resolver_keeps_frozen_dependencies_when_models_are_added(self):
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="frozen", user_id=OWNER
            )
            upstream = next(iter(self.bridge._upstreams.values()))
            resolver = upstream.catalog_resolver
            original = await resolver(OWNER, connection)
            self.profiles.upsert(
                {
                    "provider": "openai",
                    "base_url": "https://added.example/v1",
                    "api_key": "test-only",
                    "selected_models": [{"id": "later-model"}],
                },
                owner_id=OWNER,
            )
            self.assertEqual(await resolver(OWNER, connection), original)
            with self.assertRaises(OAuthFailure):
                await resolver(OTHER, connection)
            with self.assertRaises(OAuthFailure):
                await resolver(OWNER, "another-connection")
            self.profiles.set_enabled(connection, False, owner_id=OWNER)
            with self.assertRaisesRegex(SessionModelUnavailableError, "model_catalog_changed"):
                await resolver(OWNER, connection)

    async def test_unified_catalog_rejects_missing_or_conflicting_native_definitions(self):
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="native-validation", user_id=OWNER
            )
            upstream = next(iter(self.bridge._upstreams.values()))
            original = copy.deepcopy(UPSTREAM_MODELS_PAYLOAD)
            for payload in (
                {"models": []},
                {"models": [{"slug": "not-the-authorized-model"}]},
                {"models": [{"slug": MODEL}, {"slug": MODEL, "tool_mode": "different"}]},
            ):
                with patch.object(self.subscriptions, "catalog", return_value=payload):
                    with self.assertRaises(SessionModelUnavailableError):
                        await upstream.catalog_resolver(OWNER, connection)
            changed = copy.deepcopy(original)
            changed["models"][0]["provider_extension"] = {"future": [1, 2, 3]}
            with patch.object(self.subscriptions, "catalog", return_value=changed):
                actual = await upstream.catalog_resolver(OWNER, connection)
            self.assertEqual(actual["models"][0]["provider_extension"], {"future": [1, 2, 3]})
            actual["models"][0]["provider_extension"]["future"].append(4)
            self.assertEqual(changed["models"][0]["provider_extension"], {"future": [1, 2, 3]})

    async def test_unified_catalog_revalidates_required_connection_after_fetch(self):
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="metadata-race", user_id=OWNER
            )
            upstream = next(iter(self.bridge._upstreams.values()))

            async def revoke(owner, identifier):
                self.assertEqual((owner, identifier), (OWNER, connection))
                self.profiles.set_enabled(connection, False, owner_id=OWNER)
                return UPSTREAM_MODELS_PAYLOAD

            with patch.object(self.subscriptions, "catalog", side_effect=revoke):
                with self.assertRaisesRegex(SessionModelUnavailableError, "model_catalog_changed"):
                    await upstream.catalog_resolver(OWNER, connection)

    async def test_unified_catalog_merges_connected_native_connections_only(self):
        second_model = "second-native-model"
        second_definition = {
            "slug": second_model,
            "visibility": "list",
            "vendor_extension": "second",
        }
        payload = {"models": [*UPSTREAM_MODELS_PAYLOAD["models"], second_definition]}
        self.reinstall(lambda request: httpx.Response(200, json=payload))
        first = await self.connected()
        second = await self.connected()
        await self.models.save_profile(
            {**self.values, "selected_models": [{"id": second_model}]}, second, user_id=OWNER
        )
        disconnected = await self.connected()
        await self.subscriptions.disconnect(OWNER, disconnected)
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            first_spec = self.models.session_spec(
                personal_model_key(first, MODEL), session_id="first-native", user_id=OWNER
            )
            second_spec = self.models.session_spec(
                personal_model_key(second, second_model), session_id="second-native", user_id=OWNER
            )
            self.assertEqual(first_spec.catalog_models, second_spec.catalog_models)
            self.assertEqual(
                {entry.model_ref for entry in first_spec.catalog_models}, {MODEL, second_model}
            )
            upstream = next(
                item
                for item in self.bridge._upstreams.values()
                if item.session_id == "first-native"
            )
            calls = []

            async def catalog(owner, identifier):
                self.assertEqual(owner, OWNER)
                calls.append(identifier)
                return {
                    "models": [
                        (
                            UPSTREAM_MODELS_PAYLOAD["models"][0]
                            if identifier == first
                            else second_definition
                        )
                    ]
                }

            with patch.object(self.subscriptions, "catalog", side_effect=catalog):
                actual = await upstream.catalog_resolver(OWNER, first)
            self.assertEqual(set(calls), {first, second})
            self.assertEqual(
                actual["models"], [UPSTREAM_MODELS_PAYLOAD["models"][0], second_definition]
            )
            with patch.object(self.subscriptions, "catalog", return_value=UPSTREAM_MODELS_PAYLOAD):
                with self.assertRaisesRegex(
                    SessionModelUnavailableError, "model_catalog_unavailable"
                ):
                    await upstream.catalog_resolver(OWNER, first)

    async def test_custom_catalog_resolver_keeps_owner_and_activity_guards(self):
        connection = await self.connected()
        calls = []

        async def shared(owner, identifier):
            calls.append((owner, identifier))
            return UPSTREAM_MODELS_PAYLOAD

        owner = self.activities.enter(ActivityDomain.RESOURCE, root=True)
        registration = self.subscriptions.register(
            OWNER,
            connection,
            MODEL,
            "shared-continuation",
            {},
            catalog_activity=owner,
            catalog_resolver=shared,
        )
        resolver = self.bridge._upstreams[registration.bridge_id].catalog_resolver
        generation = self.activities.begin()
        try:
            self.assertEqual(await resolver(OWNER, connection), UPSTREAM_MODELS_PAYLOAD)
            self.assertEqual(calls, [(OWNER, connection)])
            with self.assertRaises(OAuthFailure):
                await resolver(OTHER, connection)
            with self.assertRaises(OAuthFailure):
                await resolver(OWNER, "another-connection")
            owner.close()
            with self.assertRaises(MaintenanceStale):
                await resolver(OWNER, connection)
        finally:
            owner.close()
            self.activities.resume(generation)

    async def test_switch_catalog_uses_only_its_live_server_held_continuation(self):
        connection = await self.connected()
        owner = self.activities.enter(ActivityDomain.RESOURCE, root=True)
        registration = self.subscriptions.register(
            OWNER, connection, MODEL, "switch-session", {}, catalog_activity=owner
        )
        self.subscriptions._directory_cache.clear()
        generation = self.activities.begin()
        try:
            response = await self.bridge.catalog(registration.bridge_id)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(self.requests)
            self.subscriptions._directory_cache.clear()
            owner.close()
            response = await self.bridge.catalog(registration.bridge_id)
            self.assertNotEqual(response.status_code, 200)
        finally:
            owner.close()
            self.activities.resume(generation)

    async def test_admitted_turn_credentials_continue_during_drain_but_not_other_sessions(self):
        holders = {}
        self.reinstall(
            lambda request: httpx.Response(200, json=UPSTREAM_MODELS_PAYLOAD),
            turn_activities=holders.get,
        )
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "admitted", {})
        other = self.subscriptions.register(OWNER, connection, MODEL, "other", {})
        turn = self.activities.enter(ActivityDomain.TURN, root=True)
        holders["admitted"] = turn
        generation = self.activities.begin()
        try:
            resolve = self.bridge._upstreams[registration.bridge_id].credential_resolver
            self.assertEqual((await resolve(OWNER, connection)).api_key, "access")
            with self.assertRaises(MaintenanceActive):
                await self.bridge._upstreams[other.bridge_id].credential_resolver(OWNER, connection)
            holders.clear()
            with self.assertRaises(MaintenanceActive):
                await resolve(OWNER, connection)
            holders["admitted"] = turn
            turn.close()
            with self.assertRaises(MaintenanceStale):
                await resolve(OWNER, connection)
        finally:
            turn.close()
            self.activities.resume(generation)

    async def test_catalog_route_requires_loopback(self):
        app = FastAPI()
        mount_completion_bridge(app, self.bridge)
        with TestClient(app, client=("192.0.2.1", 80)) as client:
            self.assertEqual(
                client.get("/api/internal/model-bridge/unknown/v1/models").status_code, 403
            )

    async def test_revoked_catalog_cannot_return_inflight_metadata(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "catalog-race", {})
        pending = asyncio.Event()
        resume = asyncio.Event()

        async def resolve(owner, identity):
            self.assertEqual((owner, identity), (OWNER, connection))
            pending.set()
            await resume.wait()
            return {"models": [{"slug": MODEL}]}

        self.bridge._upstreams[registration.bridge_id].catalog_resolver = resolve
        request = asyncio.create_task(self.bridge.catalog(registration.bridge_id))
        await pending.wait()
        self.bridge.release("catalog-race")
        resume.set()
        self.assertEqual((await request).status_code, 410)

    async def test_model_permissions_are_validated_before_save(self):
        connection = await self.connected()
        with self.assertRaises(OAuthFailure):
            await self.models.save_profile(
                {**self.values, "selected_models": [{"id": "hidden-model"}]},
                connection,
                user_id=OWNER,
            )
        self.assertEqual(
            self.profiles.profile(connection, owner_id=OWNER)["selected_models"][0]["id"], MODEL
        )
        with self.assertRaises(ValueError):
            await self.models.save_profile(
                {**self.values, "selected_models": [{"id": MODEL}]}, user_id=OWNER
            )

    async def test_other_owner_cannot_read_modify_or_admit_connection(self):
        connection = await self.connected()
        self.assertEqual(self.models.profiles(user_id=OTHER)["profiles"], [])
        for action in (
            lambda: self.models.save_profile(self.values, connection, user_id=OTHER),
            lambda: self.models.delete_profile(connection, user_id=OTHER),
            lambda: self.models.set_profile_enabled(connection, False, user_id=OTHER),
            lambda: self.subscriptions.models(OTHER, connection),
            lambda: self.subscriptions.login(OTHER, connection),
        ):
            with self.assertRaises(UnknownProfileError):
                await action()
        with self.assertRaises(UnknownProfileError):
            await self.subscriptions.disconnect(OTHER, connection)
        with self.assertRaises(ValueError):
            self.models.session_spec(personal_model_key(connection, MODEL), user_id=OTHER)

    async def test_disable_and_delete_revoke_capabilities(self):
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="session", user_id=OWNER
            )
            await self.models.set_profile_enabled(connection, False, user_id=OWNER)
            self.assertEqual(self.bridge.registration_count(), 0)
            await self.models.delete_profile(connection, user_id=OWNER)
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.DISCONNECTED
        )
        self.assertIsNone(self.profiles.profile(connection, owner_id=OWNER))

    async def test_http_routes_use_authenticated_owner_and_guard_browser_login(self):
        app = FastAPI()
        app.state.auth_enabled = True

        @app.middleware("http")
        async def identity(request, call_next):
            request.state.user_id = request.headers.get("test-owner", OWNER)
            return await call_next(request)

        mount_setting_routes(
            app,
            models=self.models,
            settings=SimpleNamespace(),
            runtime=SimpleNamespace(),
            subscriptions=self.subscriptions,
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            created = await client.post(
                "/api/serve/model-profiles", json={**self.values, "owner_id": OTHER}
            )
            self.assertEqual(created.status_code, 200, created.text)
            connection = created.json()["profile"]["id"]
            self.assertIsNotNone(self.profiles.profile(connection, owner_id=OWNER))
            listed = await client.get("/api/serve/model-profiles", headers={"test-owner": OTHER})
            self.assertEqual(listed.json()["profiles"], [])
            denied = await client.put(
                f"/api/serve/model-profiles/{connection}",
                json=self.values,
                headers={"test-owner": OTHER},
            )
            self.assertEqual(denied.status_code, 404)
            login = await client.post(f"/api/settings/model-connections/{connection}/login")
            self.assertEqual(login.status_code, 403)
            deleted = await client.delete(
                f"/api/serve/model-profiles/{connection}", headers={"test-owner": OTHER}
            )
            self.assertEqual(deleted.status_code, 404)

    async def test_logout_cancels_pending_model_selection_without_saving(self):
        connection = await self.connected()
        entered = asyncio.Event()

        async def pending(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        with patch.object(self.subscriptions.client, "get", side_effect=pending):
            saving = asyncio.create_task(
                self.models.save_profile(
                    {**self.values, "selected_models": [{"id": "late-model"}]},
                    connection,
                    user_id=OWNER,
                )
            )
            await asyncio.wait_for(entered.wait(), 2)
            await self.subscriptions.logout(OWNER)
            with self.assertRaises(asyncio.CancelledError):
                await saving
        self.assertFalse(self.subscriptions._directories)
        self.assertEqual(
            self.profiles.profile(connection, owner_id=OWNER)["selected_models"][0]["id"], MODEL
        )

    async def test_removing_selected_model_revokes_existing_bridge_and_rejects_model_swap(self):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "session", {})
        rejected = await self.bridge.forward(registration.bridge_id, {"model": "unselected-model"})
        self.assertEqual(rejected.status_code, 400)
        await self.models.save_profile(self.values, connection, user_id=OWNER)
        self.assertEqual(self.bridge.registration_count(), 0)
        self.assertEqual(
            (await self.bridge.forward(registration.bridge_id, {"model": MODEL})).status_code, 404
        )

    async def assert_catalog_cancelled(self, *, disconnect: bool):
        connection = await self.connected()
        registration = self.subscriptions.register(OWNER, connection, MODEL, "catalog-cancel", {})
        entered = asyncio.Event()

        async def pending(*args, **kwargs):
            entered.set()
            await asyncio.Event().wait()

        with patch.object(self.subscriptions.client, "get", side_effect=pending):
            request = asyncio.create_task(self.bridge.catalog(registration.bridge_id))
            await asyncio.wait_for(entered.wait(), 2)
            if disconnect:
                await self.subscriptions.disconnect(OWNER, connection)
            else:
                await self.subscriptions.logout(OWNER)
            with self.assertRaises(asyncio.CancelledError):
                await request
        self.assertFalse(self.subscriptions._directories)
        self.assertEqual((await self.bridge.catalog(registration.bridge_id)).status_code, 404)

    async def test_logout_cancels_complete_runtime_catalog(self):
        await self.assert_catalog_cancelled(disconnect=False)

    async def test_disconnect_cancels_complete_runtime_catalog(self):
        await self.assert_catalog_cancelled(disconnect=True)

    async def test_disconnected_subscription_never_switches_billing_source(self):
        connection = await self.connected()
        selected = {"model": personal_model_key(connection, MODEL)}
        self.models._settings.runtime_model = lambda: selected["model"]
        self.models._settings.set_runtime_model = lambda value: selected.__setitem__("model", value)
        builtin = {"key": "paid-model", "billing": "api", "model_name": "paid-model"}
        with (
            patch("service.chat.service.models.load_builtin_work_config", return_value={}),
            patch("service.chat.service.models.available_models", return_value=[builtin]),
            patch("service.chat.service.models.current_model_key", return_value="paid-model"),
        ):
            await self.subscriptions.disconnect(OWNER, connection)
            catalog = await self.models.catalog(user_id=OWNER)
            subscription = next(
                row for row in catalog["available_models"] if row["billing"] == "subscription"
            )
            self.assertTrue(subscription["disabled"])
            self.assertEqual(
                subscription["disabled_reason_code"], "subscription_connection_required"
            )
            self.assertEqual(subscription["disabled_reason"], "请在模型服务中连接 ChatGPT")
            self.assertEqual(catalog["current_model"], personal_model_key(connection, MODEL))
            self.assertEqual(selected["model"], personal_model_key(connection, MODEL))
            with self.assertRaises(SessionModelUnavailableError):
                self.models.selected_model_key(selected["model"], user_id=OWNER)
            with self.assertRaises(SessionModelUnavailableError):
                self.models.inference_connection(selected["model"], user_id=OWNER)
            self.assertEqual((await self.models.catalog(user_id=OTHER))["current_model"], "")
            await self.models.delete_profile(connection, user_id=OWNER)
            self.assertEqual((await self.models.catalog(user_id=OWNER))["current_model"], "")


class SharedOwnershipSubscriptionContract(unittest.IsolatedAsyncioTestCase):
    """machine 轴: 订阅连接归这台机器, 与 ScholarSeed 账号登录态解耦。

    钉住的四件事, 少一条用户就会看到"自己配的 ChatGPT 连接不见了/要重新连接":
    可见性、凭据可用性、登出不撕热桥、切号不 churn 热桥。
    """

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.profiles = ModelProfileStore(root / "profiles.json", shared_ownership=True)
        self.credentials = ModelCredentialStore(
            root / "credentials.sqlite3", root / "locks", shared_ownership=True
        )
        self.bridge = CompletionBridge("http://127.0.0.1:8772", shared_ownership=True)
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    json={
                        "models": [
                            {
                                "slug": MODEL,
                                "display_name": "Authorized model",
                                "visibility": "list",
                                "supported_reasoning_levels": [{"effort": "low"}],
                                "default_reasoning_level": "low",
                            }
                        ]
                    },
                )
            )
        )
        self.subscriptions = SubscriptionService(
            self.profiles,
            self.credentials,
            self.bridge,
            client=client,
            shared_ownership=True,
            activities=Activities(),
        )
        for resolver in self.subscriptions.resolvers.values():
            resolver.protocol.revoke = AsyncMock()
        self.addAsyncCleanup(self.subscriptions.close)
        self.models = ModelService(
            SimpleNamespace(runtime_model=lambda: "", runtime_executable=lambda: ""),
            self.bridge,
            account_tokens=SimpleNamespace(current=lambda user_id: f"token-{user_id}"),
            profiles=self.profiles,
            subscriptions=self.subscriptions,
            ownership_axis=OWNERSHIP_AXIS_MACHINE,
            activities=Activities(),
        )
        self.values = {
            "authentication": "oauth",
            "oauth_provider": "chatgpt",
            "selected_models": [],
        }

    async def connected(self, account: str = OWNER) -> str:
        """走真实产品路径建连并授权: 归属身份由轴投影, 凭据戳记真实账号。"""

        result = await self.models.save_profile(self.values, user_id=account)
        connection = result["profile"]["id"]
        self.credentials.replace(
            account,
            connection,
            OAuthTokens(
                "access",
                "refresh",
                time.time() + 3600,
                "chatgpt-account",
                client_id="oaiapp_contract",
                scopes=("chatgpt.tokens.use.direct",),
            ),
            expected_generation=0,
        )
        await self.models.save_profile(
            {**self.values, "selected_models": [{"id": MODEL}]}, connection, user_id=account
        )
        return connection

    async def catalog_rows(self, user_id: str) -> list[dict]:
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            catalog = await self.models.catalog(user_id=user_id)
        return catalog["available_models"]

    async def test_shared_catalog_keeps_actor_and_storage_owner_distinct(self) -> None:
        connection = await self.connected()
        config = {"model_name": "qwen3.8-flash", "base_url": DEEPRD_GATEWAY_BASE_URL}
        with patch("service.chat.service.models.load_builtin_work_config", return_value=config):
            qwen = self.models.session_spec("qwen3.8-flash", session_id="actor-qwen", user_id=OTHER)
            native = self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="machine-native", user_id=OTHER
            )
            self.assertEqual(qwen.catalog_models, native.catalog_models)
            upstreams = {item.session_id: item for item in self.bridge._upstreams.values()}
            self.assertEqual(upstreams["actor-qwen"].owner_id, OTHER)
            self.assertEqual(upstreams["machine-native"].owner_id, LOCAL_USER_ID)
            seen = []

            async def catalog(owner, identifier):
                seen.append((owner, identifier))
                return {"models": [{"slug": MODEL, "vendor_extension": "machine"}]}

            with patch.object(self.subscriptions, "catalog", side_effect=catalog):
                for upstream in upstreams.values():
                    payload = await upstream.catalog_resolver(
                        upstream.owner_id, upstream.connection_id
                    )
                    self.assertEqual(payload["models"][0]["vendor_extension"], "machine")
            self.assertEqual(seen, [(LOCAL_USER_ID, connection), (LOCAL_USER_ID, connection)])

    async def test_connection_survives_the_account_logging_out(self) -> None:
        connection = await self.connected()

        await self.subscriptions.logout(OWNER)

        self.assertEqual(
            self.subscriptions.status(LOCAL_USER_ID, connection)["state"],
            CredentialState.CONNECTED.value,
        )
        rows = await self.catalog_rows(LOCAL_USER_ID)
        self.assertEqual([row["key"] for row in rows], [personal_model_key(connection, MODEL)])
        self.assertFalse(rows[0].get("disabled"), str(rows[0]))

    async def test_connection_survives_switching_to_another_account(self) -> None:
        connection = await self.connected()

        rows = await self.catalog_rows(OTHER)
        self.assertEqual([row["key"] for row in rows], [personal_model_key(connection, MODEL)])
        self.assertFalse(rows[0].get("disabled"), str(rows[0]))
        # 凭据行的 owner 戳仍是原建者: 共享归属只退化谓词, 不改写历史事实。
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)

    async def test_a_connection_configured_while_signed_out_survives_signing_in(self) -> None:
        """本机现场就是这一形态（owner 戳为 local）: 登录后不能反而消失。"""

        connection = await self.connected(account=LOCAL_USER_ID)

        rows = await self.catalog_rows(OWNER)
        self.assertEqual([row["key"] for row in rows], [personal_model_key(connection, MODEL)])
        self.assertFalse(rows[0].get("disabled"), str(rows[0]))

    async def test_disconnect_from_the_machine_identity_revokes_the_real_row(self) -> None:
        connection = await self.connected()

        await self.subscriptions.disconnect(LOCAL_USER_ID, connection)

        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.DISCONNECTED
        )
        self.assertEqual(
            self.credentials.read(LOCAL_USER_ID, connection).state, CredentialState.DISCONNECTED
        )
        rows = await self.catalog_rows(LOCAL_USER_ID)
        self.assertTrue(rows[0]["disabled"])

    async def test_account_logout_does_not_tear_down_the_machine_bridge(self) -> None:
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="machine-session", user_id=OWNER
            )
        self.assertEqual(self.bridge.registration_count(), 1)

        await self.subscriptions.logout(OWNER)

        self.assertEqual(self.bridge.registration_count(), 1)

    async def test_account_switch_does_not_churn_the_machine_bridge(self) -> None:
        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="machine-session", user_id=OWNER
            )
        upstream = next(iter(self.bridge._upstreams.values()))
        self.assertEqual(upstream.owner_id, LOCAL_USER_ID)

        moved = self.models.rebind_owner("machine-session", OTHER)

        self.assertEqual(moved, 0)
        self.assertEqual(self.bridge.registration_count(), 1)

    async def test_disabling_authentication_does_not_tear_down_machine_connections(self) -> None:
        """``logout_all`` 遍历的是归属身份键 —— machine 轴下那正是本机连接自己。

        没有显式守卫时它会顺着这个键把本机所有订阅热桥吊销掉, 而用户什么账号也没登出。
        """

        connection = await self.connected()
        with patch("service.chat.service.models.load_builtin_work_config", return_value={}):
            self.models.session_spec(
                personal_model_key(connection, MODEL), session_id="machine-session", user_id=OWNER
            )
        self.assertEqual(self.bridge.registration_count(), 1)

        await self.subscriptions.logout_all()

        self.assertEqual(self.bridge.registration_count(), 1)
        self.assertEqual(
            self.subscriptions.status(LOCAL_USER_ID, connection)["state"],
            CredentialState.CONNECTED.value,
        )


if __name__ == "__main__":
    unittest.main()
