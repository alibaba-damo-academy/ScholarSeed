"""Local plugin admission and pinned bindings through the HTTP boundary, without models."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx

from scholarseed_runtime.contract import CommandReceipt, CommandState
from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.candidates import Candidates
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR
from service.capabilities.service.install import ORIGIN_FILE_NAME, install_skill_archive
from service.capabilities.service.management import SkillManagementError
from service.capabilities.service.package import pack_skill, read_package
from service.capabilities.service.plugins import PLUGIN_ORIGIN_KIND
from service.capabilities.service.skills import (
    SkillCatalog,
    SkillPresentation,
    SkillProductState,
    load_skill_state,
    save_skill_state,
)
from service.capabilities.service.ui import read_ui
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.runtime.composition import LiveSessionService
from service.identity.utils import require_host_process
from service.platform.activity import Activities
from service.platform.http_activity import ServeApplication
from tests._host import HostContextFixture
from tests.contract_ui_dependency import custom_payload, ui_payload


class PluginAdmissionContract(unittest.IsolatedAsyncioTestCase):
    async def test_preview_validation_is_read_only_and_uses_real_submission_contract(self):
        schema = {
            "type": "object",
            "required": ["feedback"],
            "properties": {"feedback": {"type": "string"}},
            "additionalProperties": False,
        }
        component = {
            "id": "scope",
            "entry": "scope.js",
            "preview": "scope.json",
            "actions": [
                {"id": "confirm", "capability": "interaction.answer", "input_schema": schema}
            ],
            "output_schema": schema,
        }
        payload = {
            "component": component,
            "action": "confirm",
            "values": {"feedback": "private feedback", "stage": "scope"},
        }
        response = await self.client.post("/api/capabilities/skills/plugins/validate", json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["valid"])
        self.assertFalse(response.json()["authorized"])
        self.assertEqual(response.json()["detail"]["layer"], "action.input_schema")
        self.assertNotIn("private feedback", response.text)
        payload["values"].pop("stage")
        response = await self.client.post("/api/capabilities/skills/plugins/validate", json=payload)
        self.assertEqual(response.json(), {"valid": True, "authorized": False})
        self.assertFalse(self.user_root.exists())

    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.user_root = self.root / "installed"
        self.state_file = self.root / "state.json"
        self.registry = ComponentRegistry(self.root / "components.sqlite3")
        self.catalog = SkillCatalog(
            bundled_root=self.root / "bundled",
            user_root=self.user_root,
            presentation=SkillPresentation(surfaces={}, required=frozenset()),
            components=self.registry,
        )
        self.activities = Activities()
        self.app = ServeApplication(activities=self.activities)
        self.app.state.skill_catalog = self.catalog
        self.app.state.runtime_service = SimpleNamespace(
            skill_inventory=self.inventory,
            cached_skill_inventory=self.inventory,
            configure_skills=self.configure,
            invalidate_skill_inventory=Mock(),
        )
        self.app.dependency_overrides[require_host_process] = lambda: None
        self.enterContext(
            patch("service.capabilities.api.routes.SERVICE_SKILLS_DIR", self.user_root)
        )
        self.enterContext(
            patch("service.capabilities.api.routes.SERVICE_BUNDLED_UI", self.root / "ui.zip")
        )
        self.enterContext(
            patch("service.capabilities.api.routes.load_skill_state", side_effect=self.state)
        )
        self.enterContext(
            patch(
                "service.capabilities.service.management.load_skill_state", side_effect=self.state
            )
        )
        self.enterContext(
            patch(
                "service.capabilities.service.skills.save_skill_state",
                side_effect=lambda state: save_skill_state(state, self.state_file),
            )
        )
        register_capability_routes(self.app, activities=self.activities, workspace=self.root)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(self.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)
        await self.configure(cwd=self.root, state=SkillProductState())

    def state(self):
        return load_skill_state(self.state_file)

    async def test_delivery_survives_skip_candidate_loss_and_restart(self):
        records = SessionCatalogStore(self.root / "sessions.sqlite3")
        records.allocate(
            "delivery-session",
            SessionPrincipal(user_id="owner"),
            runtime_id="test",
            runtime_workdir=str(self.root),
            project_path=str(self.root),
            output_root=str(self.root / "outputs"),
            model_id="test",
            required_capabilities=(),
        )
        self.app.state.session_catalog = records
        payload = self.package("delivered-late", "research.delivery")
        (self.root / "delivery.zip").write_bytes(payload)
        report = self.catalog.installation_report(
            self.root, "delivery.zip", __import__("hashlib").sha256(payload).hexdigest()
        )
        records.record_hil(
            product_request_id="delivery-request",
            session_id="delivery-session",
            vendor_request_id="vendor",
            vendor_turn_id="turn",
            vendor_item_id=None,
            method="user_input",
            payload={
                "questions": [
                    {
                        "id": "delivery-request",
                        "plugin_installation": report,
                        "installation_path": "delivery.zip",
                    }
                ]
            },
        )
        scope = {"session": "delivery-session", "request": "delivery-request"}
        prefix = "/api/capabilities/skills/plugins"
        with patch("service.capabilities.api.routes.request_owner_id", return_value="owner"):
            skipped = await self.client.post(prefix + "/delivery", json={**scope, "action": "skip"})
            self.assertEqual(skipped.json()["status"], "skipped", skipped.text)
            records.resolve_hil("delivery-request", {"cancelled": True})
            self.catalog.candidates.entries.clear()
            checked = await self.client.post(
                prefix + "/delivery", json={**scope, "action": "check"}
            )
            fresh = checked.json()["report"]
            self.assertNotEqual(fresh["candidate"], report["candidate"])
            generated = await self.client.post(
                prefix + "/delivery", json={**scope, "action": "directory"}
            )
            self.assertEqual(generated.json()["directory"], str(self.root))
            (self.root / "delivery.zip").write_bytes(b"changed")
            rejected = await self.client.post(
                prefix + "/confirm",
                json={
                    "candidate": fresh["candidate"],
                    "sha256": fresh["sha256"],
                    "confirmed": True,
                    "grants": [],
                    "enable": True,
                },
            )
            self.assertEqual(rejected.status_code, 422, rejected.text)
            self.assertEqual(
                records.hil("delivery-request").payload["installation_state"]["status"], "failed"
            )
            self.assertFalse((self.user_root / "delivered-late").exists())
            (self.root / "delivery.zip").write_bytes(payload)
            retry = await self.client.post(prefix + "/delivery", json={**scope, "action": "check"})
            self.assertEqual(retry.json()["status"], "failed")
            fresh = retry.json()["report"]
            confirmed = await self.client.post(
                prefix + "/confirm",
                json={
                    "candidate": fresh["candidate"],
                    "sha256": fresh["sha256"],
                    "confirmed": True,
                    "grants": [],
                    "enable": True,
                },
            )
            self.assertEqual(confirmed.status_code, 200, confirmed.text)
            self.app.state.session_catalog = SessionCatalogStore(records.database)
            self.catalog.candidates.entries.clear()
            result = await self.client.post(
                prefix + "/delivery", json={**scope, "action": "directory"}
            )
            self.assertEqual(result.json()["status"], "installed", result.text)
            self.assertEqual(result.json()["directory"], str(self.user_root / "delivered-late"))
            self.assertEqual(records.hil("delivery-request").decision, {"cancelled": True})
            (self.user_root / "delivered-late" / "SKILL.md").write_text("tampered")
            result = await self.client.post(prefix + "/delivery", json={**scope, "action": "check"})
            self.assertEqual(result.json()["status"], "unknown")
            self.assertNotIn("report", result.json())
        with patch("service.capabilities.api.routes.request_owner_id", return_value="other"):
            with self.assertRaises(SessionAccessError):
                await self.client.post(prefix + "/delivery", json=scope)

    async def test_ui_package_cannot_be_installed_through_user_plugin_routes(self):
        prefix = "/api/capabilities/skills/plugins"
        before = self.registry.active_ui()
        for release in ("1.0.0", "1.0.1"):
            response = await self.client.post(
                prefix + "/check",
                files={"file": ("ui.zip", ui_payload(release), "application/zip")},
            )
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(response.json()["detail"], "ui_desktop_distribution_only")
            self.assertEqual(self.registry.active_ui(), before)
        self.assertFalse(self.user_root.exists())

    async def test_skill_install_rejects_changed_preview_dependency(self):
        prefix = "/api/capabilities/skills/plugins"
        self.registry.install_ui(read_ui(ui_payload()))
        checked = await self.client.post(
            prefix + "/check", files={"file": ("custom.zip", custom_payload(), "application/zip")}
        )
        self.assertEqual(checked.status_code, 200, checked.text)
        custom = checked.json()
        preview = await self.client.post(
            prefix + "/preview", json={"candidate": custom["candidate"], "sha256": custom["sha256"]}
        )
        self.assertEqual(preview.json()["ui"]["version"], "1.0.0")
        self.registry.install_ui(read_ui(ui_payload("1.0.1")), initialize=True)
        rejected = await self.client.post(
            prefix + "/confirm",
            json={
                "candidate": custom["candidate"],
                "sha256": custom["sha256"],
                "confirmed": True,
                "grants": [],
            },
        )
        self.assertEqual(rejected.status_code, 422, rejected.text)
        self.assertEqual(rejected.json()["detail"], "plugin_dependency_changed")
        self.assertFalse((self.user_root / "custom").exists())

    async def test_broken_bundled_ui_does_not_remove_skill_routes(self):
        self.install(self.package("healthy", "research.healthy"))
        (self.root / "ui.zip").write_bytes(b"invalid zip")
        app = ServeApplication(activities=self.activities)
        app.state.skill_catalog = self.catalog
        app.state.runtime_service = self.app.state.runtime_service
        with self.assertLogs("service.capabilities.api.routes", level="WARNING") as logs:
            register_capability_routes(app, activities=self.activities, workspace=self.root)
        self.assertTrue(any("ui_initialization_failed" in row for row in logs.output))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            response = await client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["system_ui"]["error"], "ui_initialization_failed")
        self.assertIn("healthy", {row["name"] for row in response.json()["skills"]})
        with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
            self.registry.resolve(
                "literature.selection", session_id="session", turn_id="new", user_id="local"
            )

    async def test_concurrent_confirm_consumes_plugin_candidate_once(self):
        prefix = "/api/capabilities/skills/plugins"
        checked = await self.client.post(
            prefix + "/check",
            files={
                "file": (
                    "plugin.zip",
                    self.package("concurrent", "research.concurrent"),
                    "application/zip",
                )
            },
        )
        self.assertEqual(checked.status_code, 200, checked.text)
        report = checked.json()
        request = {
            "candidate": report["candidate"],
            "sha256": report["sha256"],
            "confirmed": True,
            "grants": [],
            "update": False,
        }
        entered = asyncio.Event()
        count = 0
        original_get = Candidates.get

        def observed_get(store, token, digest):
            nonlocal count
            candidate = original_get(store, token, digest)
            count += 1
            if count == 2:
                entered.set()
            return candidate

        await self.registry.mutation.acquire()
        with patch.object(Candidates, "get", observed_get):
            requests = [
                asyncio.create_task(self.client.post(prefix + "/confirm", json=request))
                for _ in range(2)
            ]
            try:
                await asyncio.wait_for(entered.wait(), timeout=5)
            finally:
                self.registry.mutation.release()
            responses = await asyncio.gather(*requests)
        self.assertEqual(sorted(response.status_code for response in responses), [200, 422])
        self.assertEqual(
            next(
                response.json()["detail"] for response in responses if response.status_code == 422
            ),
            "plugin_candidate_expired",
        )

    async def test_workspace_delivery_installs_once_and_returns_stable_receipt(self):
        payload = self.package("delivered", "research.delivered")
        archive = self.root / "delivered.zip"
        archive.write_bytes(payload)
        report = self.catalog.installation_report(
            self.root, archive.name, __import__("hashlib").sha256(payload).hexdigest()
        )
        request = {
            "candidate": report["candidate"],
            "sha256": report["sha256"],
            "confirmed": True,
            "grants": [],
            "enable": True,
            "update": False,
        }
        first = await self.client.post("/api/capabilities/skills/plugins/confirm", json=request)
        second = await self.client.post("/api/capabilities/skills/plugins/confirm", json=request)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(
            first.json()["receipt"],
            {
                "name": "delivered",
                "version": "1.0.0",
                "enabled": True,
                "sha256": report["sha256"],
            },
        )

    async def test_workspace_delivery_rechecks_source_before_installing(self):
        payload = self.package("changed", "research.changed")
        archive = self.root / "changed.zip"
        archive.write_bytes(payload)
        report = self.catalog.installation_report(
            self.root, archive.name, __import__("hashlib").sha256(payload).hexdigest()
        )
        archive.write_bytes(payload + b"changed")
        response = await self.client.post(
            "/api/capabilities/skills/plugins/confirm",
            json={
                "candidate": report["candidate"],
                "sha256": report["sha256"],
                "confirmed": True,
                "grants": [],
                "enable": True,
                "update": False,
            },
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"], "plugin_delivery_changed")
        self.assertFalse((self.user_root / "changed").exists())

    async def inventory(self, **_kwargs):
        await asyncio.sleep(0)
        return SkillInventory(
            cwd=self.root,
            revision="fixture",
            skills=tuple(
                SkillView(
                    name=manifest.parent.name,
                    path=manifest,
                    description="Admission fixture",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                )
                for manifest in sorted(
                    [
                        *self.user_root.glob("*/SKILL.md"),
                        *(self.root / "bundled").glob("*/SKILL.md"),
                    ]
                )
                if not manifest.parent.name.startswith(".")
            ),
        )

    async def configure(self, *, cwd, state, user_id="local"):
        discovered = await self.inventory(cwd=cwd)
        unavailable = set()
        snapshots = self.catalog.component_snapshots(discovered, state, unavailable=unavailable)
        self.registry.check(snapshots)
        save_skill_state(state, self.state_file)
        self.registry.publish(snapshots, unavailable=frozenset(unavailable))
        return discovered

    async def test_explicit_user_duplicate_removal_restores_verified_bundled_preview(self):
        payload = self.package("duplicate", "research.duplicate")
        bundled = install_skill_archive(payload, self.root / "bundled")
        installed = self.install(payload)
        before = {path.name: path.read_bytes() for path in bundled.path.iterdir() if path.is_file()}
        rows = (await self.client.get("/api/capabilities/skills")).json()["skills"]
        self.assertEqual([(row["source"], row["builtin"]) for row in rows], [("user", False)])
        deleted = await self.client.delete("/api/capabilities/skills/duplicate")
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertFalse(installed.path.exists())
        self.assertEqual(
            before,
            {path.name: path.read_bytes() for path in bundled.path.iterdir() if path.is_file()},
        )
        enabled = await self.client.post("/api/capabilities/skills/duplicate/activate")
        self.assertEqual(enabled.status_code, 200, enabled.text)
        rows = (await self.client.get("/api/capabilities/skills")).json()["skills"]
        self.assertEqual([(row["source"], row["builtin"]) for row in rows], [("builtin", True)])
        preview = await self.client.get("/api/capabilities/skills/duplicate/plugin")
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["fingerprint"], read_package(payload).fingerprint)
        denied = await self.client.delete("/api/capabilities/skills/duplicate")
        self.assertEqual(denied.status_code, 403)

    def use_runtime_reconciliation(self):
        enabled = {}

        async def discover(**kwargs):
            inventory = await self.inventory(**kwargs)
            return replace(
                inventory,
                skills=tuple(
                    replace(skill, enabled=enabled.get(skill.path.resolve(), True))
                    for skill in inventory.skills
                ),
            )

        async def configure(request):
            enabled.update({item.path: item.enabled for item in request.skills})
            return CommandReceipt("skills.configure", CommandState.APPLIED)

        runtime = self.app.state.runtime_service
        runtime._activities = self.activities
        runtime._skills = self.catalog
        runtime._gateway = SimpleNamespace(
            provider=lambda _: SimpleNamespace(configure_skills=configure)
        )
        runtime.runtime_id = "fixture"
        runtime._skill_inventory_cache = {}
        runtime.skill_inventory = discover
        fixture = HostContextFixture(self.root)

        async def inspect(request, _runtime_id):
            return fixture.inventory(await discover(cwd=request.cwd))

        async def reconcile(*, cwd, state, user_id):
            async with fixture.context(cwd=cwd, user_id=user_id) as (host, identity):
                return await LiveSessionService._reconcile_skills(
                    runtime, host=host, key=(user_id, identity, host.cwd), state=state
                )

        runtime._inspect = inspect
        self.reconcile_runtime = reconcile
        self.enterContext(
            patch("service.chat.runtime.composition.load_skill_state", side_effect=self.state)
        )
        self.enterContext(
            patch(
                "service.chat.runtime.composition.save_skill_state",
                side_effect=lambda state: save_skill_state(state, self.state_file),
            )
        )

    async def test_invalid_plugin_is_visible_but_cannot_release_trusted_slot_claim(self):
        damaged = self.install(self.package("alpha", "research.shared"))
        self.install(self.package("healthy", "research.healthy"))
        self.install(self.package("challenger", "research.shared"))
        await self.configure(
            cwd=self.root, state=SkillProductState(disabled_skills=frozenset({"challenger"}))
        )
        reference = self.registry.resolve(
            "research.shared",
            session_id="session",
            turn_id="turn",
            user_id="local",
            interaction_id="pending",
        )
        self.registry.bind_data(reference, {"selection": "original"})
        (damaged.path / "card.js").write_text("tampered component")
        self.use_runtime_reconciliation()
        await self.reconcile_runtime(cwd=self.root, state=self.state(), user_id="local")
        response = await self.client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200, response.text)
        rows = {row["name"]: row for row in response.json()["skills"]}
        self.assertIn("plugin_invalid", rows["alpha"]["unavailable_reason"])
        self.assertFalse(rows["alpha"]["active"])
        self.assertFalse(rows["alpha"]["runtime_enabled"])
        self.assertTrue(rows["healthy"]["active"])
        self.assertNotIn("alpha", {row["plugin"] for row in self.registry.catalog(user_id="local")})
        with self.assertRaisesRegex(ValueError, "component_plugin_unavailable"):
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="new-turn", user_id="local"
            )
        self.registry.validate(reference, session_id="session", user_id="local")
        self.assertEqual(
            self.registry.snapshot(reference, user_id="local")["interaction"]["data"],
            {"selection": "original"},
        )
        self.assertEqual(
            self.registry.resolve(
                "research.shared",
                session_id="session",
                turn_id="turn",
                user_id="local",
                interaction_id="pending",
            ),
            reference,
        )
        blocked = await self.client.post("/api/capabilities/skills/challenger/activate")
        self.assertEqual(blocked.status_code, 409, blocked.text)
        self.assertEqual(blocked.json()["detail"]["code"], "component_slot_conflict")
        self.assertIn("challenger", self.state().disabled_skills)
        self.assertEqual((damaged.path / "card.js").read_text(), "tampered component")
        reopened = ComponentRegistry(self.registry.path)
        recovering_catalog = SkillCatalog(
            bundled_root=self.root / "bundled",
            user_root=self.user_root,
            presentation=SkillPresentation(surfaces={}, required=frozenset()),
            components=reopened,
        )
        unavailable = set()
        retained = recovering_catalog.component_snapshots(
            await self.inventory(), self.state(), unavailable=unavailable
        )
        reopened.publish(retained, unavailable=frozenset(unavailable))
        with self.assertRaisesRegex(ValueError, "component_plugin_unavailable"):
            reopened.resolve(
                "research.shared", session_id="session", turn_id="after-restart", user_id="local"
            )
        reopened.validate(reference, session_id="session", user_id="local")
        disabled = await self.client.delete("/api/capabilities/skills/alpha/activate")
        self.assertEqual(disabled.status_code, 200, disabled.text)
        admitted = await self.client.post("/api/capabilities/skills/challenger/activate")
        self.assertEqual(admitted.status_code, 200, admitted.text)
        current = self.registry.resolve(
            "research.shared", session_id="session", turn_id="replacement", user_id="local"
        )
        self.assertEqual(current["plugin"], "challenger")
        self.registry.validate(reference, session_id="session", user_id="local")

    async def test_verified_repair_restores_new_bindings_without_replacing_old_interactions(self):
        installed = self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        self.registry.bind_data(reference, {"original": True})
        component = installed.path / "card.js"
        original = component.read_bytes()
        component.write_text("tampered")
        self.use_runtime_reconciliation()
        await self.reconcile_runtime(cwd=self.root, state=self.state(), user_id="local")
        unavailable = await self.client.get("/api/capabilities/skills")
        self.assertEqual(unavailable.status_code, 200, unavailable.text)
        with self.assertRaisesRegex(ValueError, "component_plugin_unavailable"):
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="blocked", user_id="local"
            )
        component.write_bytes(original)
        await self.reconcile_runtime(cwd=self.root, state=self.state(), user_id="local")
        repaired = await self.client.get("/api/capabilities/skills")
        self.assertEqual(repaired.status_code, 200, repaired.text)
        self.assertTrue(repaired.json()["skills"][0]["active"])
        current = self.registry.resolve(
            "research.shared", session_id="session", turn_id="after-repair", user_id="local"
        )
        self.assertNotEqual(current["binding"], reference["binding"])
        self.assertEqual(
            self.registry.snapshot(reference, user_id="local")["interaction"]["data"],
            {"original": True},
        )

    async def test_initial_invalid_package_does_not_register_untrusted_slot(self):
        damaged = self.install(self.package("alpha", "research.untrusted"))
        (damaged.path / "card.js").write_text("tampered before registration")
        self.use_runtime_reconciliation()
        await self.reconcile_runtime(cwd=self.root, state=self.state(), user_id="local")
        response = await self.client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["skills"][0]["active"])
        self.assertIsNone(
            self.registry.resolve(
                "research.untrusted", session_id="session", turn_id="turn", user_id="local"
            )
        )
        self.assertEqual(self.registry.enabled_snapshots(), [])

    async def test_non_plugin_inventory_failure_still_returns_unavailable(self):
        self.app.state.runtime_service.skill_inventory = AsyncMock(
            side_effect=RuntimeError("runtime transport unavailable sensitive-secret-example")
        )
        response = await self.client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200, response.text)
        self.app.state.runtime_service.skill_inventory.assert_not_awaited()
        with (
            self.assertLogs("service.capabilities.service.management", level="WARNING") as logs,
            self.assertRaises(SkillManagementError) as unavailable,
        ):
            await self.app.state.skill_management.inventory(user_id="local", force_reload=True)
        self.assertEqual(unavailable.exception.status, 503)
        self.assertEqual(unavailable.exception.detail, "codex_skill_inventory_unavailable")
        self.assertIn("failure_type=RuntimeError", "\n".join(logs.output))
        self.assertNotIn("sensitive-secret-example", "\n".join(logs.output))

    async def test_removing_plugin_metadata_does_not_release_registered_slot(self):
        installed = self.install(self.package("alpha", "research.shared"))
        self.install(self.package("challenger", "research.shared"))
        await self.configure(
            cwd=self.root, state=SkillProductState(disabled_skills=frozenset({"challenger"}))
        )
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        (installed.path / PLUGIN_DESCRIPTOR).unlink()
        (installed.path / ORIGIN_FILE_NAME).unlink()
        self.use_runtime_reconciliation()
        await self.reconcile_runtime(cwd=self.root, state=self.state(), user_id="local")
        response = await self.client.get("/api/capabilities/skills")
        self.assertEqual(response.status_code, 200, response.text)
        alpha = next(row for row in response.json()["skills"] if row["name"] == "alpha")
        self.assertFalse(alpha["active"])
        self.assertIn("plugin_invalid", alpha["unavailable_reason"])
        blocked = await self.client.post("/api/capabilities/skills/challenger/activate")
        self.assertEqual(blocked.status_code, 409, blocked.text)
        with self.assertRaisesRegex(ValueError, "component_plugin_unavailable"):
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="next", user_id="local"
            )
        self.registry.validate(reference, session_id="session", user_id="local")

    def package(self, name, slot, version="1.0.0"):
        source = self.root / f"source-{name}-{version}"
        source.mkdir()
        (source / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Admission fixture\n---\nUse the card.\n"
        )
        (source / "card.js").write_text(f"export const version = '{version}';\n")
        (source / "preview.json").write_text(json.dumps({"data": {}, "responses": {}}))
        (source / PLUGIN_DESCRIPTOR).write_text(
            json.dumps(
                {
                    "schema": 2,
                    "id": name,
                    "version": version,
                    "host": ">=0.2.0",
                    "skill": "SKILL.md",
                    "capabilities": [],
                    "components": [
                        {
                            "id": "card",
                            "slot": slot,
                            "entry": "card.js",
                            "preview": "preview.json",
                            "actions": [],
                        }
                    ],
                }
            )
        )
        archive = source.with_suffix(".zip")
        pack_skill(source, archive, expected_name=name, version=version, dependencies={})
        return archive.read_bytes()

    def install(self, payload):
        package = read_package(payload)
        return install_skill_archive(
            payload,
            self.user_root,
            origin={"kind": PLUGIN_ORIGIN_KIND, "fingerprint": package.fingerprint, "grants": []},
        )

    async def checked(self, payload):
        response = await self.client.post(
            "/api/capabilities/skills/plugins/check",
            files={"file": ("plugin.zip", payload, "application/zip")},
        )
        self.assertEqual(response.status_code, 200, response.text)
        report = response.json()
        self.assertTrue(report["valid"], report)
        return {
            "candidate": report["candidate"],
            "sha256": report["sha256"],
            "grants": [],
            "confirmed": True,
        }

    async def test_concurrent_enabling_conflicting_slots_has_one_winner_without_lost_state(self):
        for name in ("alpha", "beta"):
            self.install(self.package(name, "research.shared"))
        await self.configure(
            cwd=self.root,
            state=SkillProductState(disabled_skills=frozenset({"alpha", "beta", "unrelated"})),
        )
        responses = await asyncio.gather(
            *(
                self.client.post(f"/api/capabilities/skills/{name}/activate")
                for name in ("alpha", "beta")
            )
        )
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        winner = next(
            response.json()["name"] for response in responses if response.status_code == 200
        )
        conflict = next(
            response.json()["detail"] for response in responses if response.status_code == 409
        )
        loser = ({"alpha", "beta"} - {winner}).pop()
        self.assertEqual(conflict["code"], "component_slot_conflict")
        self.assertEqual(conflict["slot"], "research.shared")
        self.assertEqual(set(conflict["plugins"]), {"alpha", "beta"})
        self.assertEqual(self.state().disabled_skills, frozenset({loser, "unrelated"}))
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        self.assertEqual(reference["plugin"], winner)

    async def test_first_conflict_can_be_installed_disabled_without_replacing_registration(self):
        self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        body = await self.checked(self.package("beta", "research.shared"))
        conflict = await self.client.post("/api/capabilities/skills/plugins/confirm", json=body)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertFalse((self.user_root / "beta").exists())
        installed = await self.client.post(
            "/api/capabilities/skills/plugins/confirm", json={**body, "enable": False}
        )
        self.assertEqual(installed.status_code, 200, installed.text)
        self.assertFalse(installed.json()["enabled"])
        self.assertTrue((self.user_root / "beta" / "card.js").is_file())
        self.assertEqual(self.state().disabled_skills, frozenset({"beta"}))
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        self.assertEqual(reference["plugin"], "alpha")

    async def test_conflicting_update_preserves_files_state_and_registration_even_when_disabled(
        self,
    ):
        self.install(self.package("alpha", "research.alpha"))
        installed = self.install(self.package("beta", "research.beta"))
        await self.configure(
            cwd=self.root, state=SkillProductState(disabled_skills=frozenset({"unrelated"}))
        )
        before_files = {
            str(path.relative_to(installed.path)): path.read_bytes()
            for path in installed.path.rglob("*")
            if path.is_file()
        }
        before_state = self.state_file.read_bytes()
        before_registry = self.registry.catalog(user_id="local")
        body = await self.checked(self.package("beta", "research.alpha", "2.0.0"))
        for enabled in (True, False):
            response = await self.client.post(
                "/api/capabilities/skills/plugins/confirm",
                json={**body, "update": True, "enable": enabled},
            )
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], "component_slot_conflict")
            self.assertEqual(self.state_file.read_bytes(), before_state)
            self.assertEqual(self.registry.catalog(user_id="local"), before_registry)
            self.assertEqual(
                {
                    str(path.relative_to(installed.path)): path.read_bytes()
                    for path in installed.path.rglob("*")
                    if path.is_file()
                },
                before_files,
            )

    async def test_copy_content_is_durable_scoped_and_invalidated_by_drafts(self):
        self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        self.registry.bind_data(reference, {"topic": "evidence"})
        request = {"reference": reference, "session_id": "session"}
        content = {"text": "阅读重点：证据", "markdown": "**阅读重点：证据**"}
        saved = await self.client.post(
            "/api/capabilities/skills/plugins/copy",
            json={**request, "content": content, "expected_revision": 0},
        )
        self.assertEqual(saved.status_code, 200, saved.text)
        read = await self.client.post("/api/capabilities/skills/plugins/copy", json=request)
        self.assertEqual(read.json()["content"], content)
        reopened = ComponentRegistry(self.registry.path)
        self.assertEqual(
            reopened.copy_content(reference, session_id="session", user_id="local")["content"],
            content,
        )
        for foreign in [
            {**request, "session_id": "other"},
            {**request, "reference": {**reference, "fingerprint": "other"}},
        ]:
            response = await self.client.post("/api/capabilities/skills/plugins/copy", json=foreign)
            self.assertEqual(response.status_code, 409, response.text)
        with self.assertRaises(ValueError):
            reopened.copy_content(reference, session_id="session", user_id="another-user")
        changed = await self.client.post(
            "/api/capabilities/skills/plugins/draft",
            json={**request, "values": {"focus": "method"}, "expected_revision": 0},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        stale = await self.client.post(
            "/api/capabilities/skills/plugins/copy",
            json={**request, "content": content, "expected_revision": 0},
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        read = await self.client.post("/api/capabilities/skills/plugins/copy", json=request)
        self.assertIsNone(read.json()["content"])
        for invalid in [{"text": "", "html": "bad"}, {"text": "字" * 65536}, {"text": 1}]:
            response = await self.client.post(
                "/api/capabilities/skills/plugins/copy",
                json={**request, "content": invalid, "expected_revision": 1},
            )
            self.assertEqual(response.status_code, 422, response.text)
        self.registry.finish(reference)
        saved = await self.client.post(
            "/api/capabilities/skills/plugins/copy",
            json={**request, "content": content, "expected_revision": 1},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

    async def test_disabled_binding_preserves_code_data_and_draft_across_update(self):
        self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        disabled = await self.client.delete("/api/capabilities/skills/alpha/activate")
        self.assertEqual(disabled.status_code, 200, disabled.text)
        self.assertIsNone(
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="next", user_id="local"
            )
        )
        draft = await self.client.post(
            "/api/capabilities/skills/plugins/draft",
            json={
                "reference": reference,
                "session_id": "session",
                "values": {"selected": ["two"]},
                "expected_revision": 0,
            },
        )
        self.assertEqual(draft.status_code, 200, draft.text)
        before = await self.client.post(
            "/api/capabilities/skills/plugins/binding", json={"reference": reference}
        )
        self.assertEqual(before.status_code, 200, before.text)
        body = await self.checked(self.package("alpha", "research.shared", "2.0.0"))
        updated = await self.client.post(
            "/api/capabilities/skills/plugins/confirm", json={**body, "update": True}
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        after = await self.client.post(
            "/api/capabilities/skills/plugins/binding", json={"reference": reference}
        )
        self.assertEqual(after.json(), before.json())
        self.assertEqual(after.json()["interaction"]["state"], {"selected": ["two"]})
        self.assertEqual(after.json()["interaction"]["data"], {"papers": ["one", "two"]})
        current = self.registry.resolve(
            "research.shared", session_id="session", turn_id="next", user_id="local"
        )
        self.assertNotEqual(current["fingerprint"], reference["fingerprint"])
        self.assertEqual(
            self.registry.snapshot(current, user_id="local")["descriptor"]["version"], "2.0.0"
        )
        stale = await self.client.post(
            "/api/capabilities/skills/plugins/draft",
            json={
                "reference": reference,
                "session_id": "session",
                "values": {},
                "expected_revision": 0,
            },
        )
        self.assertEqual(stale.status_code, 409, stale.text)
        crossed = await self.client.post(
            "/api/capabilities/skills/plugins/draft",
            json={
                "reference": reference,
                "session_id": "other-session",
                "values": {},
                "expected_revision": 1,
            },
        )
        self.assertEqual(crossed.status_code, 409, crossed.text)

    async def test_failed_recovery_blocks_new_bindings_but_keeps_existing_interactions(self):
        installed = self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        reference = self.registry.resolve(
            "research.shared", session_id="session", turn_id="turn", user_id="local"
        )
        original = (installed.path / "SKILL.md").read_bytes()
        body = await self.checked(self.package("alpha", "research.shared", "2.0.0"))
        attempts = 0

        async def failing_configure(*, cwd, state, user_id):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                await self.configure(cwd=cwd, state=state)
            raise RuntimeError("runtime synchronization failed")

        self.app.state.runtime_service.configure_skills = failing_configure
        response = await self.client.post(
            "/api/capabilities/skills/plugins/confirm", json={**body, "update": True}
        )
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"], "component_recovery_unavailable")
        self.assertEqual(attempts, 2)
        self.assertEqual((installed.path / "SKILL.md").read_bytes(), original)
        self.registry.validate(reference, session_id="session", user_id="local")
        with self.assertRaisesRegex(ValueError, "component_registry_updating"):
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="next", user_id="local"
            )
        await self.configure(cwd=self.root, state=self.state())
        self.assertEqual(
            self.registry.resolve(
                "research.shared", session_id="session", turn_id="next", user_id="local"
            )["fingerprint"],
            reference["fingerprint"],
        )

    async def test_failed_update_rolls_back_files_state_and_registration(self):
        installed = self.install(self.package("alpha", "research.shared"))
        await self.configure(cwd=self.root, state=SkillProductState())
        before_files = {
            str(path.relative_to(installed.path)): path.read_bytes()
            for path in installed.path.rglob("*")
            if path.is_file()
        }
        before_state = self.state_file.read_bytes()
        before_registry = self.registry.catalog(user_id="local")
        body = await self.checked(self.package("alpha", "research.shared", "2.0.0"))
        fail_next = True

        async def failing_configure(*, cwd, state, user_id):
            nonlocal fail_next
            result = await self.configure(cwd=cwd, state=state)
            if fail_next:
                fail_next = False
                raise RuntimeError("runtime synchronization failed")
            return result

        self.app.state.runtime_service.configure_skills = failing_configure
        response = await self.client.post(
            "/api/capabilities/skills/plugins/confirm", json={**body, "update": True}
        )
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(self.state_file.read_bytes(), before_state)
        self.assertEqual(self.registry.catalog(user_id="local"), before_registry)
        self.assertEqual(
            {
                str(path.relative_to(installed.path)): path.read_bytes()
                for path in installed.path.rglob("*")
                if path.is_file()
            },
            before_files,
        )


if __name__ == "__main__":
    unittest.main()
