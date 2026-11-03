"""Checked candidates bind consent to immutable package bytes."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scholarseed_runtime.contract.inventory import SkillAvailability, SkillInventory, SkillView
from service.capabilities.service.candidates import Candidates
from service.capabilities.service.delivery import installation_result
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR
from service.capabilities.service.install import install_skill_archive
from service.capabilities.service.package import pack_skill, read_package
from service.capabilities.service.plugins import PLUGIN_ORIGIN_KIND, installed_snapshot
from service.capabilities.service.skills import SkillCatalog, SkillPresentation, SkillProductState


class CandidateContract(unittest.TestCase):
    def test_delivery_reconciles_unknown_without_overwriting_another_revision(self):
        report = {
            "fingerprint": "one",
            "sha256": "zip",
            "descriptor": {"id": "test", "version": "1"},
        }
        self.assertEqual(
            installation_result(report, {"status": "skipped"}, None, True)["status"], "skipped"
        )
        self.assertEqual(
            installation_result(report, {"status": "installing"}, None, True)["status"], "failed"
        )
        self.assertEqual(
            installation_result(report, {}, {"fingerprint": "two"}, True)["status"], "unknown"
        )
        result = installation_result(report, {"status": "unknown"}, {"fingerprint": "one"}, False)
        self.assertEqual(result["status"], "installed")
        self.assertFalse(result["receipt"]["enabled"])

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        source = self.root / "source"
        source.mkdir()
        (source / "SKILL.md").write_text(
            "---\nname: candidate-test\ndescription: Candidate test\n---\nInstructions.\n"
        )
        (source / PLUGIN_DESCRIPTOR).write_text(
            json.dumps(
                {
                    "schema": 2,
                    "id": "candidate-test",
                    "version": "0.1.0",
                    "host": ">=0.2.0",
                    "skill": "SKILL.md",
                    "capabilities": [],
                }
            )
        )
        archive = self.root / "plugin.zip"
        pack_skill(
            source, archive, expected_name="candidate-test", version="0.1.0", dependencies={}
        )
        self.payload = archive.read_bytes()
        self.store = Candidates(host_version="0.2.0", capabilities=())

    def test_confirmation_requires_exact_digest_and_grants(self):
        report = self.store.check(self.payload)
        with self.assertRaises(ValueError):
            self.store.confirm(report["candidate"], "changed", [])
        with self.assertRaises(ValueError):
            self.store.confirm(report["candidate"], report["sha256"], ["extra.read"])
        self.assertEqual(
            self.store.confirm(report["candidate"], report["sha256"], []), self.payload
        )

    def test_installed_plugin_shadows_bundled_and_tampering_disables_both(self):
        package = read_package(self.payload)
        bundled = install_skill_archive(self.payload, self.root / "bundled")
        installed = install_skill_archive(
            self.payload,
            self.root / "installed",
            origin={"kind": PLUGIN_ORIGIN_KIND, "fingerprint": package.fingerprint, "grants": []},
        )
        catalog = SkillCatalog(
            bundled_root=self.root / "bundled", user_root=self.root / "installed"
        )
        manifests = [entry.path / "SKILL.md" for entry in (bundled, installed)]
        views = tuple(
            SkillView(
                name=package.name,
                path=path,
                description="Test",
                enabled=True,
                availability=SkillAvailability.AVAILABLE,
            )
            for path in manifests
        )
        for order in (views, tuple(reversed(views))):
            inventory = SkillInventory(cwd=self.root, revision="test", skills=order)
            self.assertEqual(catalog.product_skills(inventory)[0].path, manifests[1])
            payload = catalog.payloads(inventory, SkillProductState())[0]
            self.assertEqual(payload["version"], package.version)
            self.assertTrue(payload["active"])
            self.assertEqual(
                dict(catalog.desired_enablement(inventory, SkillProductState())),
                {
                    manifests[0]: False,
                    manifests[1]: True,
                },
            )
            self.assertEqual(
                dict(catalog.session_enablement(inventory, SkillProductState(), user_id="")),
                {
                    manifests[0]: False,
                    manifests[1]: True,
                },
            )
        manifests[1].write_text("tampered")
        self.assertEqual(catalog.product_skills(inventory)[0].path, manifests[1])
        self.assertFalse(
            any(dict(catalog.desired_enablement(inventory, SkillProductState())).values())
        )

    def test_candidate_is_one_use(self):
        report = self.store.check(self.payload)
        self.store.confirm(report["candidate"], report["sha256"], [])
        with self.assertRaises(ValueError):
            self.store.confirm(report["candidate"], report["sha256"], [])

    def test_installed_override_preserves_product_login_requirement(self):
        package = read_package(self.payload)
        installed = install_skill_archive(
            self.payload,
            self.root / "installed",
            origin={"kind": PLUGIN_ORIGIN_KIND, "fingerprint": package.fingerprint, "grants": []},
        )
        catalog = SkillCatalog(
            bundled_root=self.root / "bundled",
            user_root=self.root / "installed",
            presentation=SkillPresentation(
                surfaces={}, required=frozenset(), requires_login=frozenset({package.name})
            ),
        )
        manifest = installed.path / "SKILL.md"
        inventory = SkillInventory(
            cwd=self.root,
            revision="test",
            skills=(
                SkillView(
                    name=package.name,
                    path=manifest,
                    description="Test",
                    enabled=True,
                    availability=SkillAvailability.AVAILABLE,
                ),
            ),
        )
        state = SkillProductState()
        self.assertFalse(catalog.payloads(inventory, state)[0]["active"])
        self.assertEqual(
            dict(catalog.session_enablement(inventory, state, user_id="")), {manifest: False}
        )
        catalog.bind_authentication(lambda _user: True)
        self.assertTrue(catalog.payloads(inventory, state)[0]["active"])

    def test_discarded_candidate_is_rejected(self):
        report = self.store.check(self.payload)
        self.store.discard(report["candidate"])
        with self.assertRaises(ValueError):
            self.store.preview(report["candidate"], report["sha256"])

    def test_inspection_does_not_install(self):
        report = self.store.check(self.payload)
        self.assertTrue(report["valid"])
        self.assertFalse(report["authorized"])
        self.assertFalse((self.root / "candidate-test").exists())

    def test_installed_snapshot_rechecks_exact_package_bytes(self):
        package = read_package(self.payload)
        installed = install_skill_archive(
            self.payload,
            self.root / "installed",
            origin={
                "kind": PLUGIN_ORIGIN_KIND,
                "fingerprint": package.fingerprint,
                "grants": [],
            },
        )
        snapshot = installed_snapshot(installed.path, host_version="0.2.0", capabilities=())
        self.assertEqual(snapshot["fingerprint"], package.fingerprint)
        (installed.path / "SKILL.md").write_text("modified after approval")
        with self.assertRaises(ValueError):
            installed_snapshot(installed.path, host_version="0.2.0", capabilities=())

    def test_unapproved_installation_cannot_open_ui(self):
        installed = install_skill_archive(self.payload, self.root / "installed")
        with self.assertRaises((ValueError, OSError)):
            installed_snapshot(installed.path, host_version="0.2.0", capabilities=())

    def test_intact_legacy_public_slot_is_contract_incompatible_not_tampered(self):
        source = self.root / "source"
        descriptor_path = source / PLUGIN_DESCRIPTOR
        descriptor = json.loads(descriptor_path.read_text())
        descriptor["components"] = [
            {
                "id": "results",
                "slot": "display.literature-search",
                "entry": "card.js",
                "preview": "preview.json",
                "actions": [],
            }
        ]
        descriptor_path.write_text(json.dumps(descriptor))
        (source / "card.js").write_text("export default {}")
        (source / "preview.json").write_text('{"data":{},"responses":{}}')
        output = self.root / "legacy.zip"
        package = pack_skill(source, output, "0.1.0", {}, expected_name="candidate-test")
        installed = install_skill_archive(
            output.read_bytes(),
            self.root / "installed",
            origin={
                "kind": PLUGIN_ORIGIN_KIND,
                "fingerprint": package.fingerprint,
                "grants": [],
            },
        )
        with self.assertRaisesRegex(ValueError, "plugin_contract_incompatible"):
            installed_snapshot(installed.path, host_version="0.2.0", capabilities=())

    def test_incompatible_host_does_not_create_candidate(self):
        constrained = Candidates(host_version="0.1.0", capabilities=())
        report = constrained.check(self.payload)
        self.assertFalse(report["valid"])
        self.assertNotIn("candidate", report)

    def test_repeated_check_reuses_immutable_candidate(self):
        first = self.store.check(self.payload)
        for _ in range(10):
            self.assertEqual(self.store.check(self.payload)["candidate"], first["candidate"])
        self.assertEqual(len(self.store.entries), 1)

    def test_existing_plugin_cannot_be_overwritten(self):
        destination = self.root / "installed"
        install_skill_archive(self.payload, destination)
        with self.assertRaisesRegex(ValueError, "installed_plugin_cannot_be_overwritten"):
            install_skill_archive(self.payload, destination, overwrite=True)


if __name__ == "__main__":
    unittest.main()
