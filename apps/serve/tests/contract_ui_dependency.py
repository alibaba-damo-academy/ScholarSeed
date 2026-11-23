from __future__ import annotations

import base64
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from copy import deepcopy
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from service.capabilities.service.candidates import Candidates
from service.capabilities.service.components import COMPONENT_SCHEMA, ComponentRegistry
from service.capabilities.service.descriptor import (
    HOST_COMPONENT_FINGERPRINT,
    HOST_COMPONENT_PLUGIN,
    HOST_COMPONENT_REVISION,
    MAX_DECLARATIONS,
    PLUGIN_DESCRIPTOR,
    PUBLIC_COMPONENT_PROVIDERS,
    RETIRED_COMPONENT_SLOTS,
    SYSTEM_UI_PLUGIN,
    UIDependency,
)
from service.capabilities.service.package import PACKAGE_MANIFEST, Payload, json_bytes
from service.capabilities.service.ui import (
    UI_COMPATIBILITY,
    UI_COMPONENT_ACTIONS,
    UI_MANIFEST,
    UI_RESOURCE_PREFIX,
    UIComponent,
    public_snapshot,
    read_declarative_catalog,
    read_ui,
)


def ui_payload(
    version="1.0.0", exports=None, catalog=None, components=None, compatibility=UI_COMPATIBILITY
):
    descriptor = {
        "schema": 1,
        "id": "official-ui",
        "compatibility": compatibility,
        "version": version,
        "runtime": "ui.js",
        "exports": exports if exports is not None else ["Button"],
        "components": (
            components
            if components is not None
            else [
                {
                    "slot": "literature.selection",
                    "entry": "selection.js",
                    "actions": [{"id": "select", "capability": "interaction.answer"}],
                }
            ]
        ),
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
        "ui": {"compatibility": UI_COMPATIBILITY, "exports": ["Button"]},
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
    def test_component_revisions_share_one_stored_ui_package(self):
        ui = read_ui(ui_payload())
        self.registry.install_ui(ui)
        candidates = Candidates(host_version="0.3.2", capabilities=(), components=self.registry)
        report = candidates.check(custom_payload())
        first = candidates.get(report["candidate"], report["sha256"]).snapshot
        second = deepcopy(first)
        second["source_fingerprint"] = "second-plugin-revision"
        self.registry.publish([first])
        self.registry.publish([second])
        with self.registry._database() as connection:
            revisions = connection.execute("SELECT body FROM component_revisions").fetchall()
            active = connection.execute("SELECT body FROM system_ui").fetchone()
            self.assertEqual(len(revisions), 2)
            self.assertTrue(all("ui" not in json.loads(row["body"]) for row in revisions))
            self.assertEqual(active["body"], "")
            packages = connection.execute("SELECT body FROM component_ui_packages").fetchall()
        self.assertEqual([json.loads(row["body"]) for row in packages], [ui])
        self.assertEqual(self.registry.active_ui(), ui)

    def test_display_only_major_preserves_the_previous_immutable_ui(self):
        old = read_ui(ui_payload(compatibility="1.0"))
        self.registry.install_ui(old)
        current = read_ui(ui_payload(version="2.0.0", components=[], compatibility="2.0"))
        self.registry.install_ui(current, initialize=True)
        self.assertEqual(self.registry.active_ui()["fingerprint"], current["fingerprint"])
        with self.registry._database() as connection:
            self.assertEqual(self.registry._ui(connection, "1.0"), old)

    def test_offline_maintenance_keeps_legacy_snapshot_identity_and_interaction(self):
        ui = read_ui(ui_payload())
        ui_body = json.dumps(ui, sort_keys=True, ensure_ascii=False)
        legacy = {
            "descriptor": {"id": "custom", "components": []},
            "fingerprint": "legacy-revision",
            "ui": ui,
        }
        body = json.dumps(legacy, sort_keys=True, ensure_ascii=False)
        with closing(sqlite3.connect(self.registry.path)) as connection, connection:
            connection.executescript(
                "CREATE TABLE system_ui (compatibility TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL);"
                "CREATE TABLE component_revisions (fingerprint TEXT PRIMARY KEY, plugin TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, extra TEXT);"
                "CREATE TABLE component_bindings (binding TEXT PRIMARY KEY, plugin TEXT NOT NULL, component TEXT NOT NULL, fingerprint TEXT NOT NULL REFERENCES component_revisions(fingerprint), session_id TEXT NOT NULL, turn_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL);"
            )
            for table in ("component_slots", "component_unavailable", "component_copies"):
                connection.execute(COMPONENT_SCHEMA[table])
            connection.execute(
                "ALTER TABLE component_bindings ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0"
            )
            connection.execute(
                "INSERT INTO system_ui VALUES (?,?,?)",
                (UI_COMPATIBILITY, ui_body, sha256(ui_body.encode()).hexdigest()),
            )
            connection.execute(
                "INSERT INTO component_revisions VALUES (?,?,?,?,?)",
                (legacy["fingerprint"], "custom", body, sha256(body.encode()).hexdigest(), "keep"),
            )
            connection.execute(
                "INSERT INTO component_bindings (binding,plugin,component,fingerprint,session_id,"
                "turn_id,user_id,data,state,revision,status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "binding",
                    "custom",
                    "card",
                    legacy["fingerprint"],
                    "session",
                    "turn",
                    "user",
                    '{"input": 1}',
                    '{"draft": 2}',
                    3,
                    "pending",
                ),
            )
        reference = {
            "binding": "binding",
            "plugin": "custom",
            "component": "card",
            "fingerprint": legacy["fingerprint"],
        }
        self.assertEqual(self.registry.active_ui(), ui)
        before = self.registry.snapshot(reference, user_id="user")
        self.assertTrue(self.registry.maintain_storage(batch_size=1))
        self.assertEqual(self.registry.snapshot(reference, user_id="user"), before)
        reopened = ComponentRegistry(self.registry.path)
        self.assertFalse(reopened.maintain_storage(batch_size=1))
        self.assertFalse(reopened.maintain_storage(batch_size=1))
        self.assertEqual(reopened.snapshot(reference, user_id="user"), before)
        self.assertEqual(reopened.active_ui(), ui)
        with reopened._database() as connection:
            revision = connection.execute(
                "SELECT body,digest,extra FROM component_revisions"
            ).fetchone()
            self.assertNotIn("ui", json.loads(revision["body"]))
            self.assertEqual(revision["digest"], sha256(body.encode()).hexdigest())
            self.assertEqual(revision["extra"], "keep")
            self.assertEqual(
                connection.execute("SELECT count(*) FROM component_ui_packages").fetchone()[0], 1
            )

    def test_declarative_and_sandbox_discovery_are_separate_budgeted_responses(self):
        declarative = {"schema": {"properties": {}}, "prompt": "registered"}
        sandbox = {"exports": ["Button"]}
        with (
            patch.object(self.registry, "active_ui", return_value={"fingerprint": "exact"}),
            patch(
                "service.capabilities.service.components.read_catalog", return_value=sandbox
            ) as sdk,
            patch(
                "service.capabilities.service.components.read_declarative_catalog",
                return_value=declarative,
            ) as host,
        ):
            result = self.registry.ui_catalog()
            self.assertEqual(result["declarative"], {"prompt": "registered"})
            self.assertIsNone(result["catalog"])
            self.assertTrue(result["available"])
            sdk.assert_not_called()
            host.assert_called_once()
            result = self.registry.ui_catalog("sandbox")
            self.assertEqual(result["catalog"], sandbox)
            self.assertIsNone(result["declarative"])
            sdk.assert_called_once()
            host.assert_called_once()
            with self.assertRaisesRegex(ValueError, "ui_catalog_mode"):
                self.registry.ui_catalog("all")
            with self.assertRaisesRegex(ValueError, "ui_catalog_mode"):
                self.registry.ui_catalog(detail="all")
            self.assertEqual(
                self.registry.ui_catalog(detail="schema")["declarative"],
                {"schema": {"properties": {}}},
            )

    def test_declarative_catalog_requires_the_current_host_registry_not_an_sdk_label(self):
        catalog = {
            "format": "openui-lang",
            "version": 1,
            "host_revision": HOST_COMPONENT_REVISION,
            "root": "Conversation",
            "schema": {"properties": {"Conversation": {}}},
            "prompt": "registered",
            "groups": [],
        }
        encode = lambda value: {
            "files": {"conversation.json": base64.b64encode(json_bytes(value)).decode()}
        }
        self.assertEqual(read_declarative_catalog(encode(catalog)), catalog)
        self.assertIsNone(read_declarative_catalog(encode({**catalog, "host_revision": "host-v1"})))
        for key, value in [
            ("format", "react"),
            ("version", 2),
            ("root", "Unregistered"),
            ("schema", "not a schema"),
        ]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "ui_catalog_invalid"):
                read_declarative_catalog(encode({**catalog, key: value}))

    def test_fulltext_decisions_use_only_the_declared_answer_capability(self):
        for slot in ("literature.authorization", "literature.selection"):
            for action in ("authorize", "reject"):
                component = {
                    "slot": slot,
                    "entry": "choices.js",
                    "actions": [{"id": action, "capability": "interaction.answer"}],
                }
                self.assertEqual(UIComponent.model_validate(component).actions[0].id, action)
                component["actions"][0]["capability"] = "literature.write"
                with self.assertRaisesRegex(ValueError, "ui_action_unsupported"):
                    UIComponent.model_validate(component)

    def test_library_exports_are_bounded_by_complete_families_not_one_plugin(self):
        exports = [f"Control{index}" for index in range(MAX_DECLARATIONS + 1)]
        catalog = {
            "schema": 1,
            "id": "official-ui",
            "compatibility": UI_COMPATIBILITY,
            "version": "1.0.0",
            "exports": exports,
            "components": read_ui(ui_payload())["components"],
            "grantsPermissions": False,
            "families": [
                {"name": "First", "exports": exports[:MAX_DECLARATIONS]},
                {"name": "Second", "exports": exports[MAX_DECLARATIONS:]},
            ],
            "bridge": {},
        }
        self.assertEqual(read_ui(ui_payload(exports=exports, catalog=catalog))["exports"], exports)
        with self.assertRaisesRegex(ValueError, "ui_catalog_required"):
            read_ui(ui_payload(exports=exports))
        for families in (
            [{"name": "Oversized", "exports": exports}],
            [{"name": "Incomplete", "exports": exports[:MAX_DECLARATIONS]}],
            [*catalog["families"], catalog["families"][0]],
            [catalog["families"][0], {"name": "First", "exports": exports[MAX_DECLARATIONS:]}],
            [{"name": f"Family{index}", "exports": [name]} for index, name in enumerate(exports)],
        ):
            with (
                self.subTest(families=families),
                self.assertRaisesRegex(ValueError, "ui_catalog_invalid"),
            ):
                read_ui(ui_payload(exports=exports, catalog={**catalog, "families": families}))
        with self.assertRaises(ValueError):
            UIDependency.model_validate({"compatibility": UI_COMPATIBILITY, "exports": exports})
        with self.assertRaises(ValueError):
            read_ui(ui_payload(exports=["Oversized" * 10000]))

    def test_official_business_card_keeps_slot_scoped_capabilities(self):
        component = {
            "slot": "display.literature-search",
            "entry": "research.js",
            "actions": [{"id": "open-results", "capability": "navigation.open"}],
        }
        self.assertEqual(UIComponent.model_validate(component).actions[0].id, "open-results")
        self.assertEqual(
            UIComponent.model_validate(
                {**component, "actions": [{"id": "open-source", "capability": "navigation.open"}]}
            )
            .actions[0]
            .id,
            "open-source",
        )
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
        result = self.registry.ui_catalog("sandbox")
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
        result = self.registry.ui_catalog("sandbox")
        self.assertTrue(result["available"])
        self.assertFalse(result["authorized"])
        self.assertEqual(result["catalog"], catalog)
        self.assertNotIn("files", result)
        self.assertEqual(result["fingerprint"], self.registry.active_ui()["fingerprint"])
        result["catalog"]["exports"].append("NotInstalled")
        self.assertEqual(self.registry.ui_catalog("sandbox")["catalog"]["exports"], ["Button"])
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

    def test_resource_update_does_not_replace_native_binding_data_or_selection(self):
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
        self.assertNotIn("ui", old)
        self.assertEqual(old["files"], {})
        self.assertEqual(old["interaction"]["state"], {"selected": ["two"]})
        self.assertEqual(old["interaction"]["data"], {"papers": ["one", "two"]})
        self.assertNotIn("ui", self.registry.snapshot(current, user_id="user"))
        self.assertEqual(reference["fingerprint"], current["fingerprint"])
        self.assertNotEqual(reference["binding"], current["binding"])

    def test_additive_ui_actions_do_not_change_bound_interaction_authority(self):
        component = {
            "slot": "display.literature-search",
            "entry": "selection.js",
            "actions": [{"id": "open-results", "capability": "navigation.open"}],
        }
        original_ui = read_ui(ui_payload(components=[component]))
        self.registry.install_ui(original_ui)
        old = self.registry.resolve(
            component["slot"], session_id="session", turn_id="one", user_id="user"
        )
        updated = {
            **component,
            "actions": [
                *component["actions"],
                {"id": "open-source", "capability": "navigation.open"},
            ],
        }
        updated_ui = read_ui(ui_payload("1.0.1", components=[updated]))
        self.registry.install_ui(updated_ui)
        new = self.registry.resolve(
            component["slot"], session_id="session", turn_id="two", user_id="user"
        )
        self.assertEqual(
            self.registry.snapshot(old, user_id="user")["descriptor"]["components"],
            self.registry.snapshot(new, user_id="user")["descriptor"]["components"],
        )
        self.assertEqual(
            self.registry.snapshot(old, user_id="user")["fingerprint"],
            HOST_COMPONENT_FINGERPRINT,
        )
        with self.assertRaisesRegex(ValueError, "ui_component_incompatible"):
            self.registry.install_ui(read_ui(ui_payload("1.0.2", components=[component])))
        self.assertEqual(self.registry.active_ui()["version"], "1.0.1")

    def test_custom_dependency_fixed_and_incompatible_update_is_atomic(self):
        self.registry.install_ui(read_ui(ui_payload()))
        snapshot = {
            "descriptor": {
                "id": "custom",
                "ui": {"compatibility": UI_COMPATIBILITY, "exports": ["Button"]},
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

    def test_retiring_unused_exports_preserves_pinned_bindings(self):
        self.registry.install_ui(read_ui(ui_payload(exports=["Button", "RetiredControl"])))
        self.registry.publish(
            [
                {
                    "descriptor": {
                        "id": "custom",
                        "ui": {"compatibility": UI_COMPATIBILITY, "exports": ["Button"]},
                        "capabilities": [],
                        "components": [
                            {"id": "custom", "slot": "test.card", "entry": "card.js", "actions": []}
                        ],
                    },
                    "files": {},
                    "scenarios": {},
                    "fingerprint": "source",
                }
            ]
        )
        old = self.registry.resolve(
            "test.card", session_id="session", turn_id="one", user_id="user"
        )
        self.registry.install_ui(read_ui(ui_payload("1.0.1", exports=["Button"])))
        self.assertEqual(self.registry.active_ui()["version"], "1.0.1")
        self.assertIn(
            "RetiredControl", self.registry.snapshot(old, user_id="user")["ui"]["exports"]
        )
        new = self.registry.resolve(
            "test.card", session_id="session", turn_id="two", user_id="user"
        )
        self.assertNotIn(
            "RetiredControl", self.registry.snapshot(new, user_id="user")["ui"]["exports"]
        )

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

    def test_native_decisions_do_not_require_executable_ui_resources(self):
        for slot in (
            "interaction.question",
            "literature.authorization",
            "literature.selection",
            "literature.outline",
        ):
            with self.subTest(slot=slot):
                reference = self.registry.resolve(
                    slot, session_id="session", turn_id="one", user_id="user"
                )
                snapshot = self.registry.snapshot(reference, user_id="user")
                self.assertEqual(snapshot["fingerprint"], HOST_COMPONENT_FINGERPRINT)
                self.assertEqual(snapshot["files"], {})
                self.assertNotIn("ui", snapshot)

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
        self.assertEqual(snapshot["fingerprint"], HOST_COMPONENT_FINGERPRINT)
        self.assertNotIn("ui", snapshot)
        self.assertEqual(snapshot["interaction"]["state"], {"selected": ["two"]})
        new = reopened.resolve(
            "literature.selection",
            session_id="session",
            turn_id="new",
            user_id="user",
            interaction_id="new-selection",
        )
        self.assertNotEqual(new["binding"], reference["binding"])
        self.assertNotIn("ui", reopened.snapshot(new, user_id="user"))

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
            current = self.registry.resolve(
                "literature.selection", session_id="session", turn_id="new", user_id="user"
            )
        self.assertNotIn("ui", self.registry.snapshot(reference, user_id="user"))
        self.assertNotIn("ui", self.registry.snapshot(current, user_id="user"))
        candidates = Candidates(host_version="0.2.0", capabilities=(), components=self.registry)
        with self.assertRaisesRegex(ValueError, "ui_dependency_unavailable"):
            candidates.check(custom_payload())

    def test_bundled_initialization_updates_new_bindings_and_retains_old_resources(self):
        self.registry.install_ui(read_ui(ui_payload("1.0.1")))
        reference = self.registry.resolve(
            "literature.selection", session_id="session", turn_id="old", user_id="user"
        )
        self.registry.bind_data(reference, {"papers": ["one", "two"]})
        self.registry.install_ui(read_ui(ui_payload()), initialize=True)
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")
        snapshot = self.registry.snapshot(reference, user_id="user")
        self.assertNotIn("ui", snapshot)
        self.assertEqual(snapshot["interaction"]["data"], {"papers": ["one", "two"]})

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
        self.assertEqual(reference["fingerprint"], HOST_COMPONENT_FINGERPRINT)

    def test_changed_action_semantics_reject_update(self):
        self.registry.install_ui(read_ui(ui_payload()))
        update = read_ui(ui_payload("1.0.1"))
        update["components"][0]["actions"] = []
        with self.assertRaisesRegex(ValueError, "ui_component_incompatible"):
            self.registry.install_ui(update)
        self.assertEqual(self.registry.active_ui()["version"], "1.0.0")

    def test_native_owned_slots_can_leave_ui_without_rebinding_history(self):
        selection = read_ui(ui_payload())["components"][0]
        native_components = [
            {"slot": slot, "entry": "selection.js", "actions": []}
            for slot in ("interaction.question", "literature.authorization")
        ]
        original = read_ui(ui_payload(components=[selection, *native_components]))
        self.registry.install_ui(original)
        custom = {
            "descriptor": {
                "id": "custom",
                "ui": {"compatibility": UI_COMPATIBILITY, "exports": ["Button"]},
                "capabilities": [],
                "components": [
                    {"id": "custom", "slot": "test.card", "entry": "card.js", "actions": []},
                    {
                        "id": "question",
                        "slot": "interaction.question",
                        "public": True,
                        "actions": [],
                    },
                ],
            },
            "files": {},
            "scenarios": {},
            "fingerprint": "source",
        }
        self.registry.publish([custom])
        old_custom = self.registry.resolve(
            "test.card", session_id="session", turn_id="old", user_id="user"
        )
        assert old_custom is not None
        legacy = public_snapshot(selection["slot"])
        legacy["fingerprint"] = original["fingerprint"]
        legacy["ui"] = original
        for component in legacy["descriptor"]["components"]:
            implementation = next(
                (item for item in original["components"] if item["slot"] == component["slot"]),
                None,
            )
            if implementation:
                component["entry"] = UI_RESOURCE_PREFIX + implementation["entry"]
        with patch("service.capabilities.service.components.public_snapshot", return_value=legacy):
            references = [
                self.registry.resolve(
                    component["slot"], session_id="session", turn_id="old", user_id="user"
                )
                for component in [selection, *native_components]
            ]
        updated = read_ui(ui_payload("1.0.1"))
        self.registry.install_ui(updated, initialize=True)
        active = self.registry.active_ui()
        assert active is not None
        self.assertEqual(active["fingerprint"], updated["fingerprint"])
        new_custom = self.registry.resolve(
            "test.card", session_id="session", turn_id="new", user_id="user"
        )
        assert new_custom is not None
        old_snapshot = self.registry.snapshot(old_custom, user_id="user")
        new_snapshot = self.registry.snapshot(new_custom, user_id="user")
        self.assertIn("entry", old_snapshot["descriptor"]["components"][1])
        self.assertNotIn("entry", new_snapshot["descriptor"]["components"][1])
        self.assertEqual(old_snapshot["ui"]["fingerprint"], original["fingerprint"])
        self.assertEqual(new_snapshot["ui"]["fingerprint"], updated["fingerprint"])
        for reference in references:
            assert reference is not None
            self.assertEqual(
                self.registry.snapshot(reference, user_id="user")["ui"]["fingerprint"],
                original["fingerprint"],
            )
            current = self.registry.resolve(
                reference["component"], session_id="session", turn_id="new", user_id="user"
            )
            assert current is not None
            self.assertEqual(current["fingerprint"], HOST_COMPONENT_FINGERPRINT)

    def test_retiring_literature_cards_updates_ui_without_replacing_history(self):
        providers = dict.fromkeys(RETIRED_COMPONENT_SLOTS, HOST_COMPONENT_PLUGIN)
        legacy_components = [
            {"slot": slot, "entry": "selection.js", "actions": []}
            for slot in sorted(RETIRED_COMPONENT_SLOTS)
        ]
        retained_slot = "display.literature-search"
        custom_slot = "test.card"
        with (
            patch.dict(PUBLIC_COMPONENT_PROVIDERS, providers),
            patch.dict(UI_COMPONENT_ACTIONS, {slot: {} for slot in providers}),
            patch(
                "service.capabilities.service.ui.PUBLIC_COMPONENT_SLOTS",
                frozenset(providers) | {retained_slot},
            ),
            patch(
                "service.capabilities.service.components.PUBLIC_COMPONENT_SLOTS",
                frozenset(providers) | {retained_slot},
            ),
            patch("service.capabilities.service.components.RETIRED_COMPONENT_SLOTS", frozenset()),
            patch(
                "service.capabilities.service.ui.HOST_COMPONENT_FINGERPRINT",
                HOST_COMPONENT_REVISION,
            ),
        ):
            legacy = read_ui(ui_payload(components=legacy_components))
            self.registry.install_ui(legacy)
            self.registry.publish(
                [
                    {
                        "descriptor": {
                            "id": "legacy",
                            "ui": {"compatibility": UI_COMPATIBILITY, "exports": ["Button"]},
                            "components": [
                                {"id": "card", "slot": custom_slot, "public": False},
                                *[
                                    {"id": slot, "slot": slot, "public": True}
                                    for slot in sorted(providers)
                                ],
                            ],
                        },
                        "fingerprint": "legacy-package",
                        "files": {},
                        "scenarios": {},
                    }
                ]
            )
            existing = self.registry.resolve(
                retained_slot, session_id="session", turn_id="old", user_id="user"
            )
            frozen = self.registry.snapshot(existing, user_id="user")
            existing_custom = self.registry.resolve(
                custom_slot, session_id="session", turn_id="old", user_id="user"
            )
            frozen_custom = self.registry.snapshot(existing_custom, user_id="user")

        updated = read_ui(ui_payload("1.0.1", components=[]))
        self.registry.install_ui(updated, initialize=True)
        self.assertEqual(self.registry.active_ui()["fingerprint"], updated["fingerprint"])
        self.assertEqual(self.registry.snapshot(existing, user_id="user"), frozen)
        self.assertEqual(self.registry.snapshot(existing_custom, user_id="user"), frozen_custom)
        current = self.registry.resolve(
            retained_slot, session_id="session", turn_id="new", user_id="user"
        )
        self.assertEqual(current["fingerprint"], HOST_COMPONENT_FINGERPRINT)
        current_custom = self.registry.resolve(
            custom_slot, session_id="session", turn_id="new", user_id="user"
        )
        updated_custom = self.registry.snapshot(current_custom, user_id="user")
        self.assertEqual(
            [component["slot"] for component in updated_custom["descriptor"]["components"]],
            [custom_slot],
        )
        for slot in RETIRED_COMPONENT_SLOTS:
            self.assertIsNone(
                self.registry.resolve(slot, session_id="session", turn_id="new", user_id="user")
            )

    def test_ui_owned_slot_removal_keeps_active_revision(self):
        original = read_ui(ui_payload())
        self.registry.install_ui(original)
        with patch.dict(PUBLIC_COMPONENT_PROVIDERS, {"literature.selection": SYSTEM_UI_PLUGIN}):
            with self.assertRaisesRegex(ValueError, "ui_component_incompatible"):
                self.registry.install_ui(read_ui(ui_payload("1.0.1", components=[])))
        active = self.registry.active_ui()
        assert active is not None
        self.assertEqual(active["fingerprint"], original["fingerprint"])


if __name__ == "__main__":
    unittest.main()
