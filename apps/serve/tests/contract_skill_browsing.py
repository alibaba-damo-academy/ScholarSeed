"""Installed skill browsing must not depend on model execution credentials."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.management import SkillManagement, SkillManagementError
from service.capabilities.service.skills import SkillCatalog, SkillProductState
from service.platform.activity import Activities


class SkillBrowsingContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.bundled = self.root / "bundled"
        self.user = self.root / "skills"
        self.bundled.mkdir()
        self.user.mkdir()
        self.manifest = self.user / "papers" / "SKILL.md"
        self.manifest.parent.mkdir()
        self.manifest.write_text("---\nname: papers\ndescription: Read papers\n---\nInstructions\n")
        self.catalog = SkillCatalog(bundled_root=self.bundled, user_root=self.user)
        self.manager = SkillManagement(
            self.catalog, self.no_runtime, lambda: self.root, lambda: "", activities=Activities()
        )
        state = patch(
            "service.capabilities.service.management.load_skill_state",
            return_value=SkillProductState(),
        )
        state.start()
        self.addCleanup(state.stop)

    @staticmethod
    def no_runtime():
        raise AssertionError("Browsing must not acquire a model host")

    async def test_anonymous_listing_and_document_do_not_acquire_host(self):
        result = await self.manager.list_skills(user_id="local", surface="settings")
        self.assertEqual([row["name"] for row in result["skills"]], ["papers"])
        self.assertEqual(result["errors"], [])
        document = await self.manager.skill_document("papers", user_id="local")
        self.assertIn("Instructions", document["document"])

    async def test_malformed_installation_is_explicit_and_does_not_hide_valid_skills(self):
        broken = self.user / "broken" / "SKILL.md"
        broken.parent.mkdir()
        broken.write_text("---\nname: [broken\n---\n")
        result = await self.manager.list_skills(user_id="local")
        self.assertIn("papers", [row["name"] for row in result["skills"]])
        self.assertEqual([row["path"] for row in result["errors"]], [str(broken)])

    async def test_missing_bundled_pack_is_reported(self):
        self.bundled.rmdir()
        result = await self.manager.list_skills(user_id="local")
        self.assertEqual([row["path"] for row in result["errors"]], [str(self.bundled)])
        self.assertEqual([row["name"] for row in result["skills"]], ["papers"])

    async def test_browsing_keeps_login_policy_and_dependency_failures(self):
        manifest = self.bundled / "literature-review" / "SKILL.md"
        manifest.parent.mkdir()
        manifest.write_text("---\nname: literature-review\ndescription: Review papers\n---\n")
        interface = self.manifest.parent / "agents" / "openai.yaml"
        interface.parent.mkdir()
        interface.write_text(
            "dependencies:\n  tools:\n    - type: mcp\n      value: missing-paper-service\n"
        )
        anonymous = await self.manager.list_skills(user_id="local")
        rows = {row["name"]: row for row in anonymous["skills"]}
        self.assertFalse(rows["literature-review"]["active"])
        self.assertEqual(rows["literature-review"]["unavailable_reason"], "login_required")
        self.assertFalse(rows["papers"]["active"])
        self.assertIsNone(rows["papers"]["runtime_enabled"])
        self.catalog.bind_authentication(lambda user_id: user_id == "account")
        authenticated = await self.manager.list_skills(user_id="account")
        self.assertTrue(
            next(row for row in authenticated["skills"] if row["name"] == "literature-review")[
                "active"
            ]
        )

    async def test_symlinked_package_is_reported_without_reading_external_manifest(self):
        external = self.root / "external"
        external.mkdir()
        (external / "SKILL.md").write_text(
            "---\nname: external\ndescription: Must not browse\n---\n"
        )
        try:
            (self.user / "linked").symlink_to(external, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"host cannot create directory symlink: {error}")
        result = await self.manager.list_skills(user_id="local")
        self.assertEqual([row["name"] for row in result["skills"]], ["papers"])
        self.assertEqual(
            [row["path"] for row in result["errors"]], [str(self.user / "linked" / "SKILL.md")]
        )

    async def test_read_only_catalog_remains_visible_while_execution_is_draining(self):
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.skill_catalog = self.catalog
        activities = Activities()
        register_capability_routes(app, activities=activities, workspace=self.root)
        activities.begin()
        with TestClient(app) as client:
            response = client.get("/api/capabilities/skills")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["skills"][0]["name"], "papers")
            blocked = client.post("/api/capabilities/skills/papers/activate")
            self.assertEqual(blocked.status_code, 503, blocked.text)

    async def test_document_rejects_manifest_replaced_with_symlink_after_discovery(self):
        external = self.root / "external"
        external.mkdir()
        target = external / "SKILL.md"
        target.write_text("External document must not be returned")
        probe = self.root / "link-probe"
        try:
            probe.symlink_to(target)
        except OSError as error:
            self.skipTest(f"host cannot create file symlink: {error}")
        probe.unlink()
        find = self.catalog.find

        def replace_after_find(*args):
            skill = find(*args)
            self.manifest.unlink()
            self.manifest.symlink_to(target)
            return skill

        with patch.object(self.catalog, "find", side_effect=replace_after_find):
            with self.assertRaises(SkillManagementError) as caught:
                await self.manager.skill_document("papers", user_id="local")
        self.assertEqual(caught.exception.status, 422)


if __name__ == "__main__":
    unittest.main()
