"""Subscription composition contracts; mocked issuer is not product acceptance."""

from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.api.settings import mount_setting_routes
from service.chat.service.completions import CompletionBridge, mount_completion_bridge
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.chat.service.subscriptions import SubscriptionService
from service.identity.utils import LOCAL_USER_ID, OWNERSHIP_AXIS_MACHINE
from service.settings.connections import ModelProfileStore, UnknownProfileError, personal_model_key
from service.settings.credentials import CredentialState, ModelCredentialStore, OAuthTokens
from service.settings.oauth import OAuthFailure

OWNER = "owner"
OTHER = "other"
MODEL = "authorized-model"


class SubscriptionContract(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.profiles = ModelProfileStore(root / "profiles.json")
        self.credentials = ModelCredentialStore(root / "credentials.sqlite3", root / "locks")
        self.bridge = CompletionBridge("http://127.0.0.1:8770")
        self.requests = []

        def upstream(request):
            self.requests.append(request)
            return httpx.Response(
                200,
                json={
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
                },
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        self.subscriptions = SubscriptionService(
            self.profiles, self.credentials, self.bridge, client=client
        )
        self.addAsyncCleanup(self.subscriptions.close)
        self.models = ModelService(
            SimpleNamespace(runtime_model=lambda: "", runtime_executable=lambda: ""),
            self.bridge,
            profiles=self.profiles,
            subscriptions=self.subscriptions,
        )
        self.values = {
            "authentication": "oauth",
            "oauth_provider": "chatgpt",
            "selected_models": [],
        }

    async def connected(self):
        result = await self.models.save_profile(self.values, user_id=OWNER)
        connection = result["profile"]["id"]
        self.credentials.replace(
            OWNER,
            connection,
            OAuthTokens("access", "refresh", time.time() + 3600, "account"),
            expected_generation=0,
        )
        await self.models.save_profile(
            {**self.values, "selected_models": [{"id": MODEL}]}, connection, user_id=OWNER
        )
        return connection

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
            {"type": "item_reference", "id": "reference-1"},
        ]
        result = SubscriptionService.request_policy(
            {"input": items, "tools": [{"type": "web_search"}]}
        )
        self.assertNotIn("id", result["input"][0])
        self.assertNotIn("id", result["input"][1])
        self.assertEqual(result["input"][1]["call_id"], result["input"][2]["call_id"])
        self.assertEqual(result["input"][3], items[3])
        self.assertEqual(items[0]["id"], "foreign-message")
        self.assertEqual(result["tools"], [{"type": "web_search"}])
        self.assertFalse(result["store"])

    async def test_default_subscription_client_inherits_environment_proxy(self):
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"models": []}))
        )
        bridge = CompletionBridge("http://127.0.0.1:8771")
        with patch(
            "service.chat.service.subscriptions.httpx.AsyncClient", return_value=client
        ) as create:
            subscriptions = SubscriptionService(self.profiles, self.credentials, bridge)
        try:
            self.assertIs(subscriptions.client, client)
            self.assertIs(create.call_args.kwargs["trust_env"], True)
        finally:
            await subscriptions.close()

    async def test_authorized_catalog_and_session_are_owned_subscription_transport(self):
        connection = await self.connected()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer access")
        self.assertEqual(self.requests[0].headers["chatgpt-account-id"], "account")
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
            self.assertNotIn("access", repr(intent))
        self.assertNotIn("access", json.dumps(self.models.profiles(user_id=OWNER)))
        self.assertNotIn("refresh", self.profiles.path.read_text())
        await self.subscriptions.logout(OWNER)
        self.assertEqual(self.bridge.registration_count(), 0)
        self.assertEqual(self.credentials.read(OWNER, connection).state, CredentialState.CONNECTED)
        self.subscriptions.disconnect(OWNER, connection)
        self.assertEqual(
            self.credentials.read(OWNER, connection).state, CredentialState.DISCONNECTED
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
            self.subscriptions.disconnect(OTHER, connection)
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
                self.subscriptions.disconnect(OWNER, connection)
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

    async def test_missing_subscription_selection_never_falls_back_to_api_billing(self):
        connection = await self.connected()
        self.models._settings.runtime_model = lambda: personal_model_key(connection, MODEL)
        builtin = {"key": "paid-model", "billing": "api", "model_name": "paid-model"}
        with (
            patch("service.chat.service.models.load_builtin_work_config", return_value={}),
            patch("service.chat.service.models.available_models", return_value=[builtin]),
            patch("service.chat.service.models.current_model_key", return_value="paid-model"),
        ):
            self.subscriptions.disconnect(OWNER, connection)
            catalog = await self.models.catalog(user_id=OWNER)
            subscription = next(
                row for row in catalog["available_models"] if row["billing"] == "subscription"
            )
            self.assertTrue(subscription["disabled"])
            self.assertEqual(
                subscription["disabled_reason_code"], "subscription_connection_required"
            )
            self.assertEqual(subscription["disabled_reason"], "请在模型服务中连接 ChatGPT")
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
            self.profiles, self.credentials, self.bridge, client=client, shared_ownership=True
        )
        self.addAsyncCleanup(self.subscriptions.close)
        self.models = ModelService(
            SimpleNamespace(runtime_model=lambda: "", runtime_executable=lambda: ""),
            self.bridge,
            account_tokens=SimpleNamespace(current=lambda user_id: f"token-{user_id}"),
            profiles=self.profiles,
            subscriptions=self.subscriptions,
            ownership_axis=OWNERSHIP_AXIS_MACHINE,
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
            OAuthTokens("access", "refresh", time.time() + 3600, "chatgpt-account"),
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

        self.subscriptions.disconnect(LOCAL_USER_ID, connection)

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
