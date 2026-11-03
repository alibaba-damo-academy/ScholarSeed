from __future__ import annotations

import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from service.capabilities.service.candidates import Candidates
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.descriptor import (
    HOST_COMPONENT_PLUGIN,
    PLUGIN_DESCRIPTOR,
    PUBLIC_COMPONENT_PROVIDERS,
)
from service.capabilities.service.package import PACKAGE_MANIFEST, Payload, json_bytes
from service.capabilities.service.ui import UI_MANIFEST, UIComponent, read_ui


def ui_payload(version="1.0.0", exports=None, catalog=None):
    descriptor = {
        "schema": 1,
        "id": "official-ui",
        "compatibility": "1.0",
        "version": version,
        "runtime": "ui.js",
        "exports": exports if exports is not None else ["Button"],
        "components": [
            {
                "slot": "literature.selection",
                "entry": "selection.js",
                "actions": [{"id": "select", "capability": "interaction.answer"}],
            }
        ],
    }
    files = {
        UI_MANIFEST: Payload(json_bytes(descriptor)),
        "ui.js": Payload(version.encode()),
        "selection.js": Payload(b"selection"),
    }
    if catalog is not None:
        files["catalog.json"] = Payload(json_bytes(catalog))
    files[PACKAGE_MANIFEST] = Payload(
        json_bytes(
            {
                "schema": 1,
                "name": "official-ui",
                "version": version,
                "dependencies": {},
                "files": [item.record(name) for name, item in files.items()],
            }
        )
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, item in files.items():
            archive.writestr(name, item.data)
    return buffer.getvalue()


def custom_payload():
    descriptor = {
        "schema": 2,
        "id": "custom",
        "version": "1.0.0",
        "host": ">=0.2.0",
        "skill": "SKILL.md",
        "capabilities": [],
        "ui": {"compatibility": "1.0", "exports": ["Button"]},
        "components": [
            {
                "id": "custom",
                "slot": "test.card",
                "entry": "card.js",
                "preview": "preview.json",
                "actions": [],
            }
        ],
    }
    files = {
        "SKILL.md": Payload(
            b"---\nname: custom\nversion: 1.0.0\ndescription: custom\n---\nUse card."
        ),
        PLUGIN_DESCRIPTOR: Payload(json_bytes(descriptor)),
        "card.js": Payload(b"card"),
        "preview.json": Payload(json_bytes({"data": {}, "responses": {}})),
    }
    files[PACKAGE_MANIFEST] = Payload(
        json_bytes(
            {
                "schema": 1,
                "name": "custom",
                "version": "1.0.0",
                "dependencies": {},
                "files": [item.record(name) for name, item in files.items()],
            }
        )
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, item in files.items():
            archive.writestr(name, item.data)
    return buffer.getvalue()


class UIDependencyContract(unittest.TestCase):
    def test_official_business_card_keeps_slot_scoped_capabilities(self):
        component = {
            "slot": "display.literature-search",
            "entry": "research.js",
            "actions": [{"id": "open-results", "capability": "navigation.open"}],
        }
        self.assertEqual(UIComponent.model_validate(component).actions[0].id, "open-results")
        for action in (
            {"id": "open-results", "capability": "literature.write"},
            {"id": "save", "capability": "literature.write"},
            {"id": "unknown", "capability": "interaction.answer"},
        ):
            with self.assertRaises(ValueError):
                UIComponent.model_validate({**component, "actions": [action]})

    def test_discovery_reports_missing_catalog_without_changing_existing_resources(self):
        self.assertFalse(self.registry.ui_catalog()["available"])
        self.registry.install_ui(read_ui(ui_payload()))
        result = self.registry.ui_catalog()
        self.assertFalse(result["available"])
        self.assertEqual(result["error"], "ui_catalog_unavailable")
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")

    def test_discovery_returns_verified_metadata_without_resources_or_authorization(self):
        descriptor = read_ui(ui_payload())
        catalog = {
            "schema": 1,
            **{
                key: descriptor[key]
                for key in ("id", "version", "compatibility", "exports", "components")
            },
            "grantsPermissions": False,
            "families": [
                {
                    "name": "Button",
                    "exports": ["Button"],
                    "intents": ["action"],
                    "use": "action",
                    "avoid": "navigation",
                }
            ],
            "bridge": {},
        }
        self.registry.install_ui(read_ui(ui_payload(catalog=catalog)))
        result = self.registry.ui_catalog()
        self.assertTrue(result["available"])
        self.assertFalse(result["authorized"])
        self.assertEqual(result["catalog"], catalog)
        self.assertNotIn("files", result)
        self.assertEqual(result["fingerprint"], self.registry.active_ui()["fingerprint"])
        result["catalog"]["exports"].append("NotInstalled")
        self.assertEqual(self.registry.ui_catalog()["catalog"]["exports"], ["Button"])
        raw_components = [
            {
                **component,
                "actions": [
                    {"id": action["id"], "capability": action["capability"]}
                    for action in component["actions"]
                ],
            }
            for component in catalog["components"]
        ]
        self.assertEqual(
            read_ui(ui_payload(catalog={**catalog, "components": raw_components}))["components"],
            descriptor["components"],
        )
        for key, value in (
            ("version", "9.0.0"),
            ("exports", ["Unknown"]),
            ("grantsPermissions", True),
        ):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "ui_catalog_invalid"):
                read_ui(ui_payload(catalog={**catalog, key: value}))

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "components.sqlite3"
        self.registry = ComponentRegistry(self.path)

    def test_ui_package_needs_no_skill_and_has_exact_integrity(self):
        self.assertEqual(read_ui(ui_payload())["version"], "1.0.0")
        buffer = io.BytesIO(ui_payload())
        with zipfile.ZipFile(buffer, "a") as archive:
            archive.writestr("undeclared.js", b"not declared")
        with self.assertRaises(ValueError):
            read_ui(buffer.getvalue())

    def test_update_keeps_bound_public_code_data_and_selection(self):
        self.registry.install_ui(read_ui(ui_payload()))
        reference = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="one", user_id="user"
        )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"selected": ["two"]},
            expected_revision=0,
        )
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        current = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="two", user_id="user"
        )
        old = ComponentRegistry(self.path).snapshot(reference, user_id="user")
        self.assertEqual(old["ui"]["version"], "1.0.0")
        self.assertEqual(old["interaction"]["state"], {"selected": ["two"]})
        self.assertEqual(old["interaction"]["data"], {"papers": ["one", "two"]})
        self.assertEqual(self.registry.snapshot(current, user_id="user")["ui"]["version"], "1.0.1")
        self.assertNotEqual(reference["fingerprint"], current["fingerprint"])

    def test_custom_dependency_fixed_and_incompatible_update_is_atomic(self):
        self.registry.install_ui(read_ui(ui_payload()))
        snapshot = {
            "descriptor": {
                "id": "custom",
                "ui": {"compatibility": "1.0", "exports": ["Button"]},
                "capabilities": [],
                "components": [
                    {"id": "custom", "slot": "test.card", "entry": "card.js", "actions": []}
                ],
            },
            "files": {},
            "scenarios": {},
            "fingerprint": "source",
        }
        self.registry.publish([snapshot])
        old = self.registry.resolve(
            "test.card", session_id="session", turn_id="one", user_id="user"
        )
        with self.assertRaisesRegex(ValueError, "ui_export_missing"):
            self.registry.install_ui(read_ui(ui_payload("1.0.1", [])))
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        new = self.registry.resolve(
            "test.card", session_id="session", turn_id="two", user_id="user"
        )
        self.assertNotEqual(old["fingerprint"], new["fingerprint"])
        self.assertEqual(self.registry.snapshot(old, user_id="user")["ui"]["version"], "1.0.0")

    def test_ui_candidates_reuse_explicit_digest_consent(self):
        candidates = Candidates(host_version="0.2.0", capabilities=(), components=self.registry)
        report = candidates.check(ui_payload())
        self.assertEqual(report["kind"], "ui")
        with self.assertRaisesRegex(ValueError, "plugin_consent_mismatch"):
            candidates.confirm(report["candidate"], report["sha256"], ["extra.permission"])
        self.assertEqual(
            candidates.confirm(report["candidate"], report["sha256"], []), ui_payload()
        )

    def test_candidate_pins_preview_dependency_and_rejects_drift_on_confirmation(self):
        self.registry.install_ui(read_ui(ui_payload()))
        candidates = Candidates(host_version="0.2.0", capabilities=(), components=self.registry)
        report = candidates.check(custom_payload())
        preview = candidates.preview(report["candidate"], report["sha256"])
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        self.assertEqual(candidates.preview(report["candidate"], report["sha256"]), preview)
        with self.assertRaisesRegex(ValueError, "plugin_dependency_changed"):
            candidates.confirm(report["candidate"], report["sha256"], [])
        checked = candidates.check(custom_payload())
        self.assertNotEqual(checked["candidate"], report["candidate"])
        self.assertEqual(
            candidates.preview(checked["candidate"], checked["sha256"])["ui"]["version"], "1.0.1"
        )

    def test_missing_dependency_fails_check_without_installation(self):
        candidates = Candidates(host_version="0.2.0", capabilities=(), components=self.registry)
        with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
            candidates.check(custom_payload())
        self.assertEqual(candidates.entries, {})

    def test_missing_ui_cannot_create_new_system_selection_binding(self):
        with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
            self.registry.resolve(
                "literature.selection", session_id="session", turn_id="one", user_id="user"
            )

    def test_legacy_binding_keeps_original_reference_without_new_system_ui(self):
        with patch.dict(
            PUBLIC_COMPONENT_PROVIDERS, {"literature.selection": HOST_COMPONENT_PLUGIN}
        ):
            reference = self.registry.resolve(
                "literature.selection",
                session_id="session",
                turn_id="old",
                user_id="user",
                interaction_id="selection",
            )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        self.registry.draft(
            reference,
            session_id="session",
            user_id="user",
            values={"selected": ["two"]},
            expected_revision=0,
        )
        reopened = ComponentRegistry(self.path)
        self.assertEqual(
            reopened.resolve(
                "literature.selection",
                session_id="session",
                turn_id="old",
                user_id="user",
                interaction_id="selection",
            ),
            reference,
        )
        snapshot = reopened.snapshot(reference, user_id="user")
        self.assertEqual(snapshot["fingerprint"], "host-v1")
        self.assertNotIn("ui", snapshot)
        self.assertEqual(snapshot["interaction"]["state"], {"selected": ["two"]})
        with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
            reopened.resolve(
                "literature.selection",
                session_id="session",
                turn_id="new",
                user_id="user",
                interaction_id="new-selection",
            )

    def test_corrupt_active_ui_is_diagnostic_and_preserves_old_bindings(self):
        self.registry.install_ui(read_ui(ui_payload()))
        reference = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="old", user_id="user"
        )
        with self.registry._database() as connection:
            connection.execute("UPDATE system_ui SET digest=?", ("broken",))
        with self.assertLogs("service.capabilities.service.components", level="WARNING"):
            self.assertIsNone(self.registry.active_ui())
            self.assertEqual(self.registry.ui_status()["error"], "ui_revision_invalid")
            self.registry.publish([])
            with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
                self.registry.resolve(
                    "literature.selection", session_id="session", turn_id="new", user_id="user"
                )
        self.assertEqual(
            self.registry.snapshot(reference, user_id="user")["ui"]["version"], "1.0.0"
        )

    def test_bundled_initialization_updates_new_bindings_and_retains_old_resources(self):
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        reference = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="old", user_id="user"
        )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        self.registry.install_ui(read_ui(ui_payload()), initialize=True)
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")
        self.assertEqual(
            self.registry.snapshot(reference, user_id="user")["ui"]["version"], "1.0.1"
        )

    def test_active_update_does_not_bypass_old_binding_permission(self):
        self.registry.install_ui(read_ui(ui_payload()))
        reference = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="one", user_id="user"
        )
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        self.registry.authorize = lambda _plugin, _user: False
        with self.assertRaisesRegex(ValueError, "component_permission_denied"):
            self.registry.snapshot(reference, user_id="user")

    def test_public_code_cannot_be_injected_without_dependency(self):
        with self.assertRaisesRegex(ValueError, "component_public_invalid"):
            self.registry.check(
                [
                    {
                        "descriptor": {
                            "id": "custom",
                            "components": [
                                {
                                    "id": "selection",
                                    "public": True,
                                    "slot": "literature.selection",
                                    "entry": "evil.js",
                                }
                            ],
                        },
                        "fingerprint": "evil",
                    }
                ]
            )

    def test_public_legacy_slot_remains_available(self):
        self.registry.install_ui(read_ui(ui_payload()))
        reference = self.registry.resolve(
            "interaction.question", session_id="session", turn_id="one", user_id="user"
        )
        self.assertEqual(reference["fingerprint"], "host-v1")

    def test_changed_action_semantics_reject_update(self):
        self.registry.install_ui(read_ui(ui_payload()))
        update = read_ui(ui_payload("1.0.1"))
        update["components"][0]["actions"] = []
        with self.assertRaisesRegex(ValueError, "ui_component_incompatible"):
            self.registry.install_ui(update)
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")


if __name__ == "__main__":
    unittest.main()
