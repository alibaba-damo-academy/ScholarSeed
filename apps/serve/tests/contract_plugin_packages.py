"""Bundled plugin references preserve complete scenarios without owning public slots."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from service.capabilities.service.authoring import inspect_package
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR, inspect_plugin
from service.capabilities.service.package import pack_skill
from service.capabilities.service.plugins import PLUGIN_CAPABILITIES

SOURCE = Path(__file__).resolve().parents[3] / "skills" / "community"
HOST_VERSION = "0.3.0"
PUBLIC_SLOTS = frozenset(
    {
        "interaction.question",
        "display.literature-search",
        "preview.literature-results",
        "literature.selection",
        "literature.authorization",
        "display.literature-downloads",
        "display.literature-delivery",
        "display.literature-references",
    }
)
PACKAGE_NAMES = (
    "agentic-search",
    "precise-literature-search",
    "literature-review",
    "research-idea-partner",
)
PRIVATE_SLOTS = frozenset({"literature.outline", "display.literature-review"})
AUTHOR_PLUGIN = "method-comparison"
AUTHOR_VERSION = "0.1.0"


class BundledPluginContract(unittest.TestCase):
    def test_author_package_can_combine_public_reference_and_new_custom_slot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text(
                f"---\nname: {AUTHOR_PLUGIN}\nversion: {AUTHOR_VERSION}\ndescription: Compare methods\n---\n"
            )
            components = [
                {"id": "question", "slot": "interaction.question", "public": True},
                {
                    "id": "comparison",
                    "slot": "research.method-comparison",
                    "entry": "comparison.js",
                },
            ]
            for component in components:
                component["preview"] = "scenario.json"
                component["actions"] = [{"id": "choose", "capability": "interaction.answer"}]
            descriptor = {
                "schema": 2,
                "id": AUTHOR_PLUGIN,
                "version": AUTHOR_VERSION,
                "host": ">=0.2.0,<0.4.0",
                "skill": "SKILL.md",
                "capabilities": ["interaction.answer"],
                "components": components,
            }
            (source / PLUGIN_DESCRIPTOR).write_text(json.dumps(descriptor))
            (source / "comparison.js").write_text("window.plugin.onState(() => {});")
            (source / "scenario.json").write_text(
                json.dumps({"data": {}, "responses": {"choose": {"state": "resolved", "data": {}}}})
            )
            archive = root / "plugin.zip"
            pack_skill(source, archive, AUTHOR_VERSION, {}, expected_name=AUTHOR_PLUGIN)
            checked = inspect_package(archive.read_bytes(), host_version=HOST_VERSION)
            self.assertTrue(checked["valid"], checked)
            self.assertTrue(checked["integrity_verified"])
            self.assertFalse(checked["authorized"])
            self.assertFalse(checked["runtime_verified"])

    def test_bundled_components_reference_host_without_overriding_it(self):
        for name in PACKAGE_NAMES:
            with self.subTest(name=name):
                root = SOURCE / name
                descriptor = json.loads((root / PLUGIN_DESCRIPTOR).read_text())
                custom = set()
                for component in descriptor["components"]:
                    if component["slot"] in PUBLIC_SLOTS:
                        self.assertIs(component.get("public"), True)
                        self.assertNotIn("entry", component)
                    else:
                        custom.add(component["slot"])
                        self.assertFalse(component.get("public", False))
                        self.assertTrue((root / component["entry"]).is_file())
                    scenario = json.loads((root / component["preview"]).read_text())
                    self.assertEqual(
                        set(scenario["responses"]),
                        {action["id"] for action in component["actions"]},
                    )
                self.assertEqual(custom, PRIVATE_SLOTS if name == "literature-review" else set())
                if not custom:
                    self.assertEqual(
                        {path.suffix for path in (root / "components").iterdir() if path.is_file()},
                        {".json"},
                    )

    def test_bundled_public_references_pass_real_descriptor_inspection(self):
        for name in PACKAGE_NAMES:
            with self.subTest(name=name):
                root = SOURCE / name
                descriptor = json.loads((root / PLUGIN_DESCRIPTOR).read_text())
                files = {PLUGIN_DESCRIPTOR: (root / PLUGIN_DESCRIPTOR).read_bytes()}
                for component in descriptor["components"]:
                    for field in ("entry", "preview"):
                        if field in component:
                            files[component[field]] = (root / component[field]).read_bytes()
                files["SKILL.md"] = (root / "SKILL.md").read_bytes()
                result = inspect_plugin(
                    files,
                    skill_name=name,
                    skill_version=descriptor["version"],
                    host_version=HOST_VERSION,
                    available_capabilities=PLUGIN_CAPABILITIES,
                )
                self.assertTrue(result["valid"], result)
                self.assertFalse(result["runtime_verified"])


if __name__ == "__main__":
    unittest.main()
