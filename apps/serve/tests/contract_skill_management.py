"""Contracts for session-bound skill discovery and confirmed local mutations."""

from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, call, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
)
from service.capabilities.api.management import register_skill_management
from service.capabilities.api.routes import register_capability_routes
from service.capabilities.domain import SKILL_MANAGEMENT_ROUTE
from service.capabilities.service.management import SkillManagement, SkillManagementError
from service.capabilities.service.skills import SkillCatalog, SkillProductState
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import BRIDGE_CALLBACK_REQUEST_HEADER, BRIDGE_CALLBACK_TURN_HEADER
from service.platform.vocabulary import BRIDGE_SESSION_HEADER, BRIDGE_TOKEN_HEADER


class SkillManagementContracts(unittest.TestCase):
    def setUp(self):
        self.activities = Activities()
        self.activity = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.activity.close)
        self.live = SimpleNamespace(
            id="session",
            bridge_token="token",
            turn_activity=self.activity,
            publication_turn_id="turn",
            active_product_turn_id="product-turn",
            product_turn_generation=1,
            interrupt_generation=0,
            attachment_generation=0,
            user_id="account",
            interactions=SimpleNamespace(
                request_product_input=AsyncMock(
                    return_value={"answers": {"confirmation": "确认执行"}}
                )
            ),
        )
        self.sessions = SimpleNamespace(
            bridge_caller=lambda identity: self.live if identity == "session" else None,
            mode=lambda _identity: {"mode": "ask", "active_mode": "ask"},
        )
        self.manager = SimpleNamespace(
            marketplace=AsyncMock(return_value={"items": [], "nextCursor": "2"}),
            marketplace_detail=AsyncMock(return_value={"slug": "papers", "version": "1.0.0"}),
            list_skills=AsyncMock(return_value={"skills": []}),
            skill_document=AsyncMock(return_value={"document": "untrusted"}),
            marketplace_install=AsyncMock(return_value={"installed": {"name": "papers"}}),
            activate_skill=AsyncMock(return_value={"name": "papers", "active": True}),
            deactivate_skill=AsyncMock(return_value={"name": "papers", "active": False}),
            update_skill=AsyncMock(return_value={"installed": {"name": "papers"}}),
            delete_skill=AsyncMock(return_value={"name": "papers", "deleted": True}),
        )
        app = FastAPI()
        register_skill_management(app, self.sessions, self.manager, activities=self.activities)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {
            BRIDGE_SESSION_HEADER: "session",
            BRIDGE_TOKEN_HEADER: "token",
            BRIDGE_CALLBACK_REQUEST_HEADER: "callback",
            BRIDGE_CALLBACK_TURN_HEADER: "turn",
        }

    def call(self, operation, body):
        return self.client.post(SKILL_MANAGEMENT_ROUTE + operation, headers=self.headers, json=body)

    def test_search_preserves_cursor_and_does_not_ask_or_write(self):
        result = self.call("search", {"query": "论文", "cursor": "1", "locale": "zh"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["nextCursor"], "2")
        self.manager.marketplace.assert_awaited_once_with(query="论文", cursor="1", locale="zh")
        self.live.interactions.request_product_input.assert_not_awaited()
        self.manager.marketplace_install.assert_not_awaited()

    def test_install_requires_real_confirmation_and_replays_same_request(self):
        body = {"slug": "papers", "version": "1.0.0", "client_op_id": "install-papers"}
        first = self.call("install", body)
        second = self.call("install", body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["ok"])
        self.assertTrue(second.json()["replayed"])
        self.live.interactions.request_product_input.assert_awaited_once()
        self.manager.marketplace_install.assert_awaited_once()
        self.assertIn("authorize", self.manager.marketplace_install.call_args.kwargs)
        conflict = self.call("install", {**body, "version": "2.0.0"})
        self.assertEqual(conflict.status_code, 409)

    def test_denied_confirmation_never_mutates(self):
        self.live.interactions.request_product_input.return_value = {
            "answers": {"confirmation": "取消"}
        }
        result = self.call("delete", {"name": "papers", "client_op_id": "delete-papers"})
        self.assertEqual(result.json()["error"], "user_denied")
        self.manager.delete_skill.assert_not_awaited()

    def test_mode_change_while_confirming_fails_closed(self):
        async def change_mode(*_args, **_kwargs):
            self.sessions.mode = lambda _: {"mode": "read_only", "active_mode": "read_only"}
            return {"answers": {"confirmation": "确认执行"}}

        self.live.interactions.request_product_input.side_effect = change_mode
        result = self.call("enable", {"name": "papers", "client_op_id": "enable-papers"})
        self.assertEqual(result.status_code, 403, result.text)
        self.manager.activate_skill.assert_not_awaited()

    def test_turn_change_while_confirming_fails_closed(self):
        async def change_turn(*_args, **_kwargs):
            self.live.interrupt_generation += 1
            return {"answers": {"confirmation": "确认执行"}}

        self.live.interactions.request_product_input.side_effect = change_turn
        result = self.call("disable", {"name": "papers", "client_op_id": "disable-papers"})
        self.assertEqual(result.status_code, 403, result.text)
        self.manager.deactivate_skill.assert_not_awaited()

    def test_identity_registry_path_and_confirmation_cannot_be_supplied(self):
        for body in (
            {"query": "pdf", "registry": "https://evil.invalid"},
            {"query": "pdf", "user_id": "other"},
            {"query": " "},
        ):
            self.assertEqual(self.call("search", body).status_code, 400)
        for body in (
            {"name": "../private", "client_op_id": "bad"},
            {"name": "papers", "client_op_id": "bad", "confirmed": True},
        ):
            self.assertEqual(self.call("delete", body).status_code, 400)
        self.manager.marketplace.assert_not_awaited()
        self.manager.delete_skill.assert_not_awaited()

    def test_authentication_and_callback_scope_are_required(self):
        for missing in (
            BRIDGE_TOKEN_HEADER,
            BRIDGE_CALLBACK_REQUEST_HEADER,
            BRIDGE_CALLBACK_TURN_HEADER,
        ):
            headers = {key: value for key, value in self.headers.items() if key != missing}
            result = self.client.post(SKILL_MANAGEMENT_ROUTE + "list", headers=headers, json={})
            self.assertEqual(result.status_code, 403)
        self.manager.list_skills.assert_not_awaited()

    def test_local_list_receives_trusted_identity(self):
        result = self.call("list", {})
        self.assertEqual(result.status_code, 200, result.text)
        self.manager.list_skills.assert_awaited_once_with(user_id="account")

    def test_local_operations_keep_the_trusted_session_identity(self):
        operations = (
            ("document", "skill_document", {"name": "papers"}),
            ("install", "marketplace_install", {"slug": "papers", "version": "1.0.0"}),
            ("enable", "activate_skill", {"name": "papers"}),
            ("disable", "deactivate_skill", {"name": "papers"}),
            (
                "update",
                "update_skill",
                {"name": "papers", "version": "2.0.0", "expected_version": "1.0.0"},
            ),
            ("delete", "delete_skill", {"name": "papers"}),
        )
        for operation, method, body in operations:
            with self.subTest(operation=operation):
                if operation != "document":
                    body = {**body, "client_op_id": operation + "-identity"}
                result = self.call(operation, body)
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(
                    getattr(self.manager, method).await_args.kwargs.get("user_id"),
                    self.live.user_id,
                )


class SkillManagementIdentityContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()

        async def inventory(*, cwd, user_id, executable="", force_reload=False):
            return SkillInventory(cwd=cwd)

        async def cached(*, cwd, state, user_id):
            return SkillInventory(cwd=cwd)

        async def configure(*, cwd, state, user_id):
            return SkillInventory(cwd=cwd)

        self.runtime = SimpleNamespace(
            skill_inventory=AsyncMock(side_effect=inventory),
            cached_skill_inventory=AsyncMock(side_effect=cached),
            configure_skills=AsyncMock(side_effect=configure),
        )
        self.previous = SkillProductState()
        self.next_state = SkillProductState(disabled_skills=frozenset({"papers"}))
        self.manager = SkillManagement(
            SkillCatalog(bundled_root=self.root / "bundled", user_root=self.root / "skills"),
            lambda: self.runtime,
            lambda: self.root,
            lambda: "codex-fixture",
            activities=Activities(),
        )
        self.state_patch = patch(
            "service.capabilities.service.management.load_skill_state", return_value=self.previous
        )
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)

    async def test_inventory_and_cache_preserve_each_request_identity(self):
        await self.manager.inventory(user_id="account-a", force_reload=True)
        await self.manager.inventory(user_id="account-b")
        await self.manager.list_skills(user_id="account-b")
        self.assertEqual(
            self.runtime.skill_inventory.await_args_list,
            [
                call(
                    cwd=self.root,
                    user_id="account-a",
                    executable="codex-fixture",
                    force_reload=True,
                ),
                call(
                    cwd=self.root,
                    user_id="account-b",
                    executable="codex-fixture",
                    force_reload=False,
                ),
            ],
        )
        self.runtime.cached_skill_inventory.assert_not_awaited()

    async def test_http_inventory_uses_middleware_identity_and_preserves_busy(self):
        manifest = self.root / "bundled" / "find-skill" / "SKILL.md"
        manifest.parent.mkdir(parents=True)
        manifest.write_text("---\nname: find-skill\ndescription: Manage skills\n---\n")
        interface = manifest.parent / "agents" / "openai.yaml"
        interface.parent.mkdir()
        interface.write_text("interface:\n  display_name: Native title\n")
        identities = []
        self.manager.catalog.bind_authentication(lambda user_id: identities.append(user_id) or True)
        self.runtime.cached_skill_inventory.side_effect = None
        self.runtime.cached_skill_inventory.return_value = SkillInventory(
            cwd=self.root,
            skills=(
                SkillView(
                    name="find-skill",
                    path=manifest,
                    description="Manage skills",
                    display_name="Native title",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                ),
            ),
        )
        app = FastAPI()
        app.state.auth_enabled = True
        app.state.skill_catalog = self.manager.catalog
        app.state.runtime_service = self.runtime
        principal = {"user_id": "account-a"}

        @app.middleware("http")
        async def identity(request, call_next):
            request.state.user_id = principal["user_id"]
            return await call_next(request)

        register_capability_routes(app, activities=Activities(), workspace=self.root)
        with TestClient(app) as client:
            for user_id in ("account-a", "account-b"):
                principal["user_id"] = user_id
                for locale, title in (
                    ("zh-CN", "查找与管理技能"),
                    ("en-US", "Find and Manage Skills"),
                    ("fr-FR", "Native title"),
                    (None, "Native title"),
                ):
                    with (
                        self.subTest(user_id=user_id, locale=locale),
                        patch("service.capabilities.service.management.ClawHub") as marketplace,
                    ):
                        marketplace.return_value.enrich_local = AsyncMock(
                            side_effect=lambda rows: rows
                        )
                        parameters = {"user_id": "untrusted", "surface": "settings"}
                        if locale is not None:
                            parameters["locale"] = locale
                        response = client.get("/api/capabilities/skills", params=parameters)
                        self.assertEqual(response.status_code, 200, response.text)
                        row = response.json()["skills"][0]
                        self.assertEqual(row["name"], "find-skill")
                        self.assertEqual(row["path"], str(manifest))
                        self.assertEqual(row["display_name"], title)
                        self.assertEqual(identities[-1], user_id)
                        if locale is None:
                            marketplace.assert_not_called()
                        else:
                            marketplace.assert_called_once_with(locale=locale)
            self.runtime.cached_skill_inventory.side_effect = RuntimeError(RESOURCE_HOST_BUSY)
            response = client.get("/api/capabilities/skills")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIsNone(response.json()["skills"][0]["runtime_enabled"])
        self.runtime.cached_skill_inventory.assert_not_awaited()
        self.runtime.configure_skills.assert_not_awaited()

    async def test_read_refusals_keep_the_runtime_reason_and_status(self):
        for reason, status in (
            (RESOURCE_HOST_BUSY, 409),
            (RESOURCE_HOST_CONFIGURATION_CONFLICT, 409),
            (RESOURCE_HOST_CONFIGURATION_UNCERTAIN, 409),
            (RESOURCE_HOST_CONTEXT_REQUIRED, 503),
        ):
            for method, runtime_method, options in (("inventory", "skill_inventory", {}),):
                with self.subTest(reason=reason, method=method):
                    getattr(self.runtime, runtime_method).side_effect = RuntimeError(reason)
                    with self.assertRaises(SkillManagementError) as error:
                        await getattr(self.manager, method)(user_id="account-a", **options)
                    self.assertEqual(
                        (error.exception.status, error.exception.detail), (status, reason)
                    )

    async def test_inventory_diagnostics_keep_safe_reason_without_exception_body(self):
        self.runtime.skill_inventory.side_effect = RuntimeError("private-exception-body")
        with self.assertLogs("service.capabilities.service.management", level="WARNING") as logs:
            with self.assertRaises(SkillManagementError) as caught:
                await self.manager.inventory(user_id="account-a", force_reload=True)
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("reason=codex_skill_inventory_unavailable", " ".join(logs.output))
        self.assertNotIn("private-exception-body", " ".join(logs.output))

    async def test_known_configuration_refusals_do_not_retry_or_compensate(self):
        for reason, status in (
            (RESOURCE_HOST_BUSY, 409),
            (RESOURCE_HOST_CONFIGURATION_CONFLICT, 409),
            (RESOURCE_HOST_CONFIGURATION_UNCERTAIN, 409),
            (RESOURCE_HOST_CONTEXT_REQUIRED, 503),
        ):
            with self.subTest(reason=reason):
                self.runtime.configure_skills.reset_mock(side_effect=True)
                self.runtime.configure_skills.side_effect = RuntimeError(reason)
                with self.assertRaises(SkillManagementError) as error:
                    await self.manager.apply_state(self.next_state, user_id="account-a")
                self.assertEqual((error.exception.status, error.exception.detail), (status, reason))
                self.runtime.configure_skills.assert_awaited_once_with(
                    cwd=self.root, state=self.next_state, user_id="account-a"
                )

    async def test_ordinary_sync_failure_compensates_with_the_same_identity(self):
        self.runtime.configure_skills.side_effect = [RuntimeError("sync failed"), None]
        with self.assertRaises(SkillManagementError) as error:
            await self.manager.apply_state(self.next_state, user_id="account-a")
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(
            self.runtime.configure_skills.await_args_list,
            [
                call(cwd=self.root, state=self.next_state, user_id="account-a"),
                call(cwd=self.root, state=self.previous, user_id="account-a"),
            ],
        )

    async def test_revocation_after_application_preserves_compensation_and_denial(self):
        checks = 0

        def authorize():
            nonlocal checks
            checks += 1
            if checks == 2:
                raise SkillManagementError(403, "scope_expired")

        with self.assertRaises(SkillManagementError) as error:
            await self.manager.apply_state(
                self.next_state, user_id="account-a", authorize=authorize
            )
        self.assertEqual((error.exception.status, error.exception.detail), (403, "scope_expired"))
        self.assertEqual(
            self.runtime.configure_skills.await_args_list,
            [
                call(cwd=self.root, state=self.next_state, user_id="account-a"),
                call(cwd=self.root, state=self.previous, user_id="account-a"),
            ],
        )


class SkillMutationSafetyContracts(unittest.IsolatedAsyncioTestCase):
    async def test_install_revocation_and_sync_failure_leave_no_new_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            user = root / "skills"
            payload = io.BytesIO()
            with zipfile.ZipFile(payload, "w") as archive:
                archive.writestr("SKILL.md", "---\nname: papers\ndescription: Read papers\n---\n")
            runtime = SimpleNamespace(
                skill_inventory=AsyncMock(return_value=SkillInventory(cwd=root)),
                configure_skills=AsyncMock(),
            )
            manager = SkillManagement(
                SkillCatalog(bundled_root=root / "bundled", user_root=user),
                lambda: runtime,
                lambda: root,
                lambda: "",
                activities=Activities(),
            )
            remote = SimpleNamespace(
                base="https://registry.invalid",
                detail=AsyncMock(
                    return_value={
                        "moderation": "clean",
                        "namespace": "global",
                    }
                ),
                download=AsyncMock(return_value=payload.getvalue()),
            )
            with (
                patch("service.capabilities.service.management.SERVICE_SKILLS_DIR", user),
                patch("service.capabilities.service.management.ClawHub", return_value=remote),
                patch(
                    "service.capabilities.service.management.load_skill_state",
                    return_value=SkillProductState(),
                ),
            ):

                def revoked():
                    raise SkillManagementError(403, "scope_expired")

                with self.assertRaises(SkillManagementError) as error:
                    await manager.marketplace_install(
                        "papers", {"version": "1.0.0"}, user_id="account", authorize=revoked
                    )
                self.assertEqual(error.exception.status, 403)
                self.assertFalse((user / "papers").exists())
                runtime.configure_skills.side_effect = [RuntimeError("sync failed"), None]
                with self.assertRaises(SkillManagementError) as error:
                    await manager.marketplace_install(
                        "papers", {"version": "1.0.0"}, user_id="account"
                    )
                self.assertEqual(error.exception.status, 503)
                self.assertFalse((user / "papers").exists())


if __name__ == "__main__":
    unittest.main()
