"""Component package contracts; these checks are not product acceptance."""

from __future__ import annotations

import base64
import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from contract_ui_dependency import ui_payload

from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.descriptor import (
    HOST_COMPONENT_PLUGIN,
    HOST_COMPONENT_REVISION,
    PLUGIN_DESCRIPTOR,
    PUBLIC_COMPONENT_PROVIDERS,
    PUBLIC_COMPONENT_SLOTS,
    inspect_plugin,
)
from service.capabilities.service.plugins import (
    PLUGIN_CAPABILITIES,
    component_action,
    installed_snapshot,
)
from service.capabilities.service.presentation import TurnSkillBinding, component_reference
from service.capabilities.service.ui import read_ui, resolve_ui
from service.chat.runtime.live import LiveSession
from service.literature.service.cards import LiteratureReferences
from service.literature.service.result import SearchResult
from service.literature.service.review import ReviewSnapshot


class ComponentContract(unittest.TestCase):
    def test_pre_task_binding_requires_one_admitted_skill_and_current_turn(self):
        selected = InputItem(InputKind.SKILL, name="review", path=Path("/skills/review/SKILL.md"))
        turn = TurnInput((selected,), client_user_message_id="turn-one")
        binding = TurnSkillBinding.from_input(turn, {"review": "1.0.0"}, 3)
        self.assertIsNotNone(binding)
        self.assertEqual(binding.skill_path, "/skills/review")
        self.assertTrue(binding.current("turn-one", 3))
        self.assertFalse(binding.current("turn-two", 3))
        self.assertFalse(binding.current("turn-one", 4))
        self.assertIsNone(TurnSkillBinding.from_input(turn, {}, 3))
        self.assertIsNone(TurnSkillBinding.from_input(TurnInput(()), {}, 3))
        multiple = TurnInput((selected, selected), client_user_message_id="turn-one")
        self.assertIsNone(TurnSkillBinding.from_input(multiple, {"review": "1.0.0"}, 3))

    def setUp(self):
        self.component = {
            "id": "selection",
            "entry": "components/selection.js",
            "preview": "scenarios/selection.json",
            "actions": [{"id": "select", "capability": "interaction.answer"}],
        }
        self.descriptor = {
            "schema": 2,
            "id": "comparison",
            "version": "1.0.0",
            "host": ">=0.2.0,<0.3.0",
            "skill": "SKILL.md",
            "capabilities": ["interaction.answer"],
            "components": [self.component],
        }
        self.scenario = {
            "data": {"papers": [{"id": "paper-a", "label": "Paper A"}]},
            "responses": {"select": {"state": "resolved", "data": {"message": "Selected"}}},
        }
        self.files = {
            "SKILL.md": b"---\nname: comparison\nversion: 1.0.0\ndescription: Compare\n---\n",
            "components/selection.js": b"document.body.textContent = 'comparison';",
            "scenarios/selection.json": json.dumps(self.scenario).encode(),
        }

    def inspect(self):
        return inspect_plugin(
            {**self.files, PLUGIN_DESCRIPTOR: json.dumps(self.descriptor).encode()},
            skill_name="comparison",
            skill_version="1.0.0",
            host_version="0.2.0",
            available_capabilities=("interaction.answer",),
        )

    def test_javascript_component_is_valid_without_html(self):
        result = self.inspect()
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["scenarios"]["selection"], self.scenario)
        self.assertFalse(result["authorized"])
        self.assertFalse(result["runtime_verified"])

    def test_component_identity_is_unique(self):
        self.descriptor["components"].append(copy.deepcopy(self.component))
        self.assertFalse(self.inspect()["valid"])

    def test_missing_code_and_scenario_fail_closed(self):
        for path in tuple(self.files)[1:]:
            with self.subTest(path=path):
                payload = self.files.pop(path)
                self.assertFalse(self.inspect()["valid"])
                self.files[path] = payload

    def test_scenario_cannot_invent_actions(self):
        self.scenario["responses"]["download"] = {"state": "resolved", "data": {}}
        self.files["scenarios/selection.json"] = json.dumps(self.scenario).encode()
        self.assertFalse(self.inspect()["valid"])

    def test_scenario_requires_every_declared_action(self):
        self.scenario["responses"] = {}
        self.files["scenarios/selection.json"] = json.dumps(self.scenario).encode()
        self.assertFalse(self.inspect()["valid"])

    def test_preview_rejects_invalid_expressions_and_navigation(self):
        for value in (
            {"$input": "constructor.secret"},
            {"$input": "choice", "$state": "batch"},
            {"$if": True, "then": "missing branches"},
            {"target": {"component": "not-installed", "data": {}}},
        ):
            with self.subTest(value=value):
                self.scenario["responses"]["select"]["data"] = value
                self.files["scenarios/selection.json"] = json.dumps(self.scenario).encode()
                self.assertFalse(self.inspect()["valid"])

    def test_no_standalone_page_contract(self):
        self.descriptor["ui"] = {"entry": "index.html", "preview": "preview.json"}
        self.assertFalse(self.inspect()["valid"])

    def test_component_cannot_claim_undeclared_capability(self):
        self.component["actions"][0]["capability"] = "files.delete"
        self.assertFalse(self.inspect()["valid"])

    def test_action_identity_is_scoped_to_component(self):
        descriptor = {
            "capabilities": ["skills.list", "navigation.skills"],
            "components": [
                {"id": "inventory", "actions": [{"id": "open", "capability": "skills.list"}]},
                {"id": "settings", "actions": [{"id": "open", "capability": "navigation.skills"}]},
            ],
        }
        self.assertEqual(
            component_action(descriptor, "settings", "open")["capability"], "navigation.skills"
        )
        self.assertIsNone(component_action(descriptor, "missing", "open"))
        self.assertIsNone(component_action(descriptor, "settings", "missing"))

    def test_changed_skill_version_cannot_bind_to_running_task(self):
        with self.assertRaisesRegex(ValueError, "plugin_component_stale"):
            component_reference(
                {"path": "plugin/SKILL.md", "version": "2.0.0"},
                slot="literature.selection",
                skill_path="plugin",
                skill_version="1.0.0",
            )

    def test_preview_data_uses_the_real_domain_shapes(self):
        source = Path(__file__).resolve().parents[3] / "skills" / "community"
        cases = (
            ("agentic-search", "results", SearchResult),
            ("literature-review", "outline", ReviewSnapshot),
            ("literature-review", "review", ReviewSnapshot),
            ("research-idea-partner", "references", LiteratureReferences),
        )
        for name, component, schema in cases:
            data = json.loads((source / name / "components" / f"{component}.json").read_text())[
                "data"
            ]
            payload = {
                key: value
                for key, value in data.items()
                if key not in {"options", "answers", "question", "context"}
            }
            schema.model_validate(payload)

    def test_search_previews_match_serialized_product_payloads(self):
        source = Path(__file__).resolve().parents[3] / "skills" / "community"
        for name in (
            "agentic-search",
            "precise-literature-search",
            "literature-review",
            "research-idea-partner",
        ):
            with self.subTest(name=name):
                scenario = json.loads((source / name / "components" / "results.json").read_text())
                payload = {
                    key: value for key, value in scenario["data"].items() if key != "context"
                }
                self.assertEqual(
                    SearchResult.model_validate(payload).model_dump(mode="json"), payload
                )

    def test_remaining_bundled_packages_have_verified_components_and_scenarios(self):
        source = Path(__file__).resolve().parents[3] / "skills" / "community"
        expected = {
            "agentic-search": {
                "display.literature-search",
                "preview.literature-results",
                "interaction.question",
            },
            "precise-literature-search": {
                "preview.literature-results",
                "display.literature-search",
                "display.literature-downloads",
                "display.literature-delivery",
                "interaction.question",
                "literature.selection",
            },
            "literature-review": {
                "preview.literature-results",
                "literature.authorization",
                "literature.outline",
                "display.literature-search",
                "display.literature-downloads",
                "display.literature-delivery",
                "display.literature-review",
                "interaction.question",
            },
            "research-idea-partner": {
                "preview.literature-results",
                "literature.authorization",
                "display.literature-references",
                "display.literature-search",
                "display.literature-downloads",
                "display.literature-delivery",
                "interaction.question",
            },
        }
        custom_slots = {"literature.outline", "display.literature-review"}
        self.assertEqual(set().union(*expected.values()) - custom_slots, PUBLIC_COMPONENT_SLOTS)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        registry = ComponentRegistry(Path(temporary.name) / "components.sqlite3")
        official_ui = read_ui(ui_payload(exports=["Button", "React", "mount", "Conversation"]))
        registry.install_ui(official_ui)
        snapshots = {
            name: installed_snapshot(
                source / name,
                host_version="0.2.0",
                capabilities=PLUGIN_CAPABILITIES,
                bundled=True,
            )
            for name in expected
        }
        registry.publish(list(snapshots.values()))
        for name, slots in expected.items():
            with self.subTest(name=name):
                snapshot = snapshots[name]
                self.assertEqual(
                    {component["slot"] for component in snapshot["descriptor"]["components"]}, slots
                )
                for component in snapshot["descriptor"]["components"]:
                    reference = registry.resolve(
                        component["slot"],
                        session_id=name,
                        turn_id="preview-and-runtime",
                        user_id="developer",
                        interaction_id=component["id"],
                    )
                    self.assertIsNotNone(reference)
                    resolved = registry.snapshot(reference, user_id="developer")
                    if component["slot"] in PUBLIC_COMPONENT_SLOTS:
                        self.assertIs(component["public"], True)
                        self.assertIsNone(component["entry"])
                        self.assertEqual(reference["plugin"], HOST_COMPONENT_PLUGIN)
                        self.assertEqual(reference["component"], component["slot"])
                        self.assertEqual(resolved["files"], {})
                        if PUBLIC_COMPONENT_PROVIDERS[component["slot"]] == HOST_COMPONENT_PLUGIN:
                            self.assertEqual(reference["fingerprint"], HOST_COMPONENT_REVISION)
                            self.assertEqual(
                                {item["slot"] for item in resolved["descriptor"]["components"]},
                                PUBLIC_COMPONENT_SLOTS,
                            )
                        else:
                            self.assertEqual(reference["fingerprint"], official_ui["fingerprint"])
                            self.assertEqual(resolved["ui"], official_ui)
                            self.assertEqual(
                                resolved["descriptor"]["components"][0]["entry"],
                                "__ui__/selection.js",
                            )
                    else:
                        self.assertEqual(name, "literature-review")
                        self.assertIn(component["slot"], custom_slots)
                        self.assertIs(component["public"], False)
                        self.assertEqual(reference["plugin"], name)
                        self.assertEqual(reference["component"], component["id"])
                        self.assertEqual(
                            reference["fingerprint"],
                            resolve_ui(snapshot, official_ui)["fingerprint"],
                        )
                        self.assertTrue(component["entry"] in resolved["files"])
                        self.assertEqual(resolved["ui"], official_ui)
                        for asset in (source / name / "components").iterdir():
                            if asset.is_file():
                                asset_path = asset.relative_to(source / name).as_posix()
                                self.assertTrue(asset_path in resolved["files"], asset_path)
                                self.assertEqual(
                                    base64.b64decode(resolved["files"][asset_path]),
                                    asset.read_bytes(),
                                    asset_path,
                                )
                    self.assertTrue(component["preview"] in snapshot["files"])
                    self.assertEqual(
                        set(snapshot["scenarios"][component["id"]]["responses"]),
                        {action["id"] for action in component["actions"]},
                    )


class PresentationBindingContract(unittest.IsolatedAsyncioTestCase):
    async def test_enabled_registry_resolves_without_explicit_skill(self):
        reference = {
            "plugin": "host",
            "component": "interaction.question",
            "fingerprint": "host-v1",
        }
        registry = Mock()
        registry.resolve.return_value = reference
        live = SimpleNamespace(
            id="session-one",
            user_id="user-one",
            _skills=SimpleNamespace(components=registry),
            active_task_lease=None,
            active_skill_presentation=None,
            active_product_turn_id="turn-one",
            skill_state_by_name=AsyncMock(),
        )
        self.assertEqual(await LiveSession.component_for(live, "interaction.question"), reference)
        registry.resolve.assert_called_once_with(
            "interaction.question",
            session_id="session-one",
            turn_id="turn-one",
            user_id="user-one",
            interaction_id="",
        )
        live.skill_state_by_name.assert_not_called()

    async def test_explicit_skill_name_cannot_override_slot_registry(self):
        registry = Mock()
        registry.resolve.return_value = None
        live = SimpleNamespace(
            id="session-one",
            user_id="user-one",
            active_product_turn_id="turn-one",
            _skills=SimpleNamespace(components=registry),
        )
        self.assertIsNone(
            await LiveSession.component_for(live, "custom.absent", skill_name="old-skill")
        )


if __name__ == "__main__":
    unittest.main()
