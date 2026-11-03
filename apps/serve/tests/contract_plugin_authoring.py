"""Offline author commands exercise actual ZIP bytes without installing or executing."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR, validate_component_submission
from service.capabilities.service.package import PACKAGE_MANIFEST
from service.cli.plugins import main
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    CONTRACT_CAPABILITY,
    CONTRACT_DESCRIBE_OPERATION,
    ComponentInvocation,
)
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES


class AuthoringContract(unittest.TestCase):
    def test_authoring_reuses_registered_plan_contract_without_session_state(self):
        status, result = self.call("describe")
        self.assertEqual(status, 0, result)
        planning = result["planning"]
        self.assertFalse(planning["grants_permissions"])
        for operation in ("get", "write"):
            self.assertEqual(
                planning["operations"][operation],
                BRIDGE_REQUESTS[("plan", operation)].request_type.model_json_schema(),
            )
        self.assertNotIn("expected_revision", planning)
        self.assertNotIn("turn_id", planning)

    def test_authoring_discovers_native_contracts_without_executing_operations(self):
        status, result = self.call("describe")
        self.assertEqual(status, 0, result)
        discovery = result["native_contract_discovery"]
        entry = BRIDGE_REQUESTS[(CONTRACT_CAPABILITY, CONTRACT_DESCRIBE_OPERATION)]
        self.assertEqual(discovery["capability"], CONTRACT_CAPABILITY)
        self.assertEqual(discovery["operation"], CONTRACT_DESCRIBE_OPERATION)
        self.assertEqual(discovery["request_schema"], entry.request_type.model_json_schema())
        self.assertFalse(discovery["grants_permissions"])
        request = entry.request_type.model_validate(discovery["example"])
        self.assertIn((request.target_capability, request.target_operation), BRIDGE_REQUESTS)

    def test_prepare_reuses_only_exact_contract_snapshot(self):
        snapshot = self.root / "contract.json"
        _, contract = self.call("describe")
        snapshot.write_text(json.dumps(contract))
        status, prepared = self.call("prepare", snapshot)
        self.assertEqual(status, 0, prepared)
        self.assertTrue(prepared["matched"])
        self.assertNotIn("contract", prepared)
        self.assertEqual(prepared["identity"], contract["identity"])
        self.assertFalse(prepared["authorized"])
        contract["component_sdk"]["state"]["draft"] = "wrong shape"
        snapshot.write_text(json.dumps(contract))
        status, prepared = self.call("prepare", snapshot)
        self.assertEqual(status, 0, prepared)
        self.assertFalse(prepared["matched"])
        self.assertNotEqual(prepared["contract"]["component_sdk"], contract["component_sdk"])

    def test_prepare_rejects_stale_planning_contract_even_with_claimed_identity(self):
        snapshot = self.root / "contract.json"
        _, current = self.call("describe")
        for missing in (False, True):
            with self.subTest(missing=missing):
                candidate = json.loads(json.dumps(current))
                if missing:
                    del candidate["planning"]
                else:
                    candidate["planning"]["operations"]["write"]["required"] = []
                snapshot.write_text(json.dumps(candidate))
                status, prepared = self.call("prepare", snapshot)
                self.assertEqual(status, 0, prepared)
                self.assertFalse(prepared["matched"])
                self.assertEqual(prepared["contract"], current)
                self.assertFalse(prepared["authorized"])

    def test_bundled_authoring_snapshot_matches_current_contract(self):
        snapshot = (
            Path(__file__).resolve().parents[3]
            / "skills/community/plugin-create/references/contract.json"
        )
        status, actual = self.call("describe")
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(snapshot.read_text()), actual)

    def test_templates_generate_inspectable_sources_without_overwriting(self):
        script = (
            Path(__file__).resolve().parents[3]
            / "skills/community/plugin-create/scripts/scaffold.py"
        )
        for kind, count in (("selection", 1), ("comparison", 2), ("stages", 2)):
            with self.subTest(kind=kind):
                source = self.root / kind
                command = [
                    sys.executable,
                    str(script),
                    kind,
                    str(source),
                    "--name",
                    f"test-{kind}",
                    "--host",
                    ">=0.2.0,<0.4.0",
                ]
                generated = subprocess.run(command, capture_output=True, text=True, check=True)
                self.assertFalse(json.loads(generated.stdout)["ready_for_delivery"])
                status, result = self.call(
                    "pack",
                    source,
                    "--name",
                    f"test-{kind}",
                    "--version",
                    "0.1.0",
                    "--output",
                    self.root / f"{kind}.zip",
                )
                self.assertEqual(status, 0, result)
                self.assertEqual(len(result["descriptor"]["components"]), count)
                self.assertFalse(result["runtime_verified"])
                for component in result["descriptor"]["components"]:
                    request_path = source / "requests" / f"{component['id']}.json"
                    request = json.loads(request_path.read_text())
                    self.assertEqual(request["slot"], component["slot"])
                    self.assertEqual(
                        request["data"]["actions"],
                        [action["id"] for action in component["actions"]],
                    )
                    status, validation = self.call(
                        "validate", source / PLUGIN_DESCRIPTOR, request_path
                    )
                    self.assertEqual(status, 0, validation)
                    self.assertIn(
                        f"requests/{component['id']}.json",
                        (source / "SKILL.md").read_text(),
                    )
                before = (source / "SKILL.md").read_bytes()
                duplicate = subprocess.run(command, capture_output=True)
                self.assertNotEqual(duplicate.returncode, 0)
                self.assertEqual(before, (source / "SKILL.md").read_bytes())

    def test_contract_identity_matches_full_contract_and_is_compact(self):
        status, full = self.call("describe")
        self.assertEqual(status, 0)
        identity = full.pop("identity")
        canonical = json.dumps(full, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        self.assertEqual(identity["sha256"], hashlib.sha256(canonical.encode()).hexdigest())
        self.assertEqual(identity["version"], "1.0.0")
        status, compact = self.call("describe", "--identity")
        self.assertEqual(status, 0)
        self.assertEqual(compact, identity)
        self.assertNotIn("schema", compact)

    def test_describe_exposes_actual_component_invocation_and_transport_limit(self):
        status, result = self.call("describe")
        self.assertEqual(status, 0)
        self.assertEqual(
            result["component_invocation_schema"], ComponentInvocation.model_json_schema()
        )
        self.assertIn("title", result["component_invocation_schema"]["required"])
        self.assertEqual(result["bridge_request_max_bytes"], BRIDGE_MAX_REQUEST_BYTES)
        self.assertFalse(result["grants_permissions"])

    def test_validate_request_preserves_input_and_reports_missing_material_id(self):
        self.descriptor["capabilities"] = ["interaction.answer"]
        self.descriptor["components"] = [
            {
                "id": "scope",
                "slot": "sample.scope",
                "entry": "scope.js",
                "preview": "scope.json",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "materials": {
                            "type": "array",
                            "items": {"type": "object", "required": ["ref_id"]},
                        }
                    },
                },
                "actions": [{"id": "confirm", "capability": "interaction.answer"}],
            }
        ]
        self.save_descriptor()
        request = self.root / "request.json"
        original = json.dumps(
            {
                "request_id": "scope-1",
                "slot": "sample.scope",
                "title": "Scope",
                "data": {"materials": [{"title": "keep material"}], "goal": "keep goal"},
            }
        )
        request.write_text(original)
        status, result = self.call("validate", self.source / PLUGIN_DESCRIPTOR, request)
        self.assertEqual(status, 1)
        self.assertEqual(result["issues"][0]["detail"]["missing"], ["ref_id"])
        self.assertEqual(request.read_text(), original)
        updated = json.loads(original)
        updated["data"]["materials"][0]["ref_id"] = "actual-reference"
        request.write_text(json.dumps(updated))
        status, result = self.call("validate", self.source / PLUGIN_DESCRIPTOR, request)
        self.assertEqual(status, 0)
        self.assertTrue(result["valid"])
        self.assertFalse(result["authorized"])
        self.assertFalse(result["runtime_verified"])

    def test_submission_validates_values_not_the_action_envelope(self):
        schema = {
            "type": "object",
            "required": ["feedback"],
            "properties": {"feedback": {"type": "string"}},
            "additionalProperties": False,
        }
        component = {
            "id": "scope",
            "actions": [
                {"id": "confirm", "capability": "interaction.answer", "input_schema": schema}
            ],
            "output_schema": schema,
        }
        validate_component_submission(component, "confirm", {"feedback": "keep scope"})
        with self.assertRaisesRegex(ValueError, "component_value_invalid") as failure:
            validate_component_submission(
                component, "confirm", {"feedback": "keep scope", "stage": "scope"}
            )
        self.assertEqual(failure.exception.detail["layer"], "action.input_schema")
        self.assertNotIn("keep scope", json.dumps(failure.exception.detail))
        component["output_schema"] = {"type": "object", "required": ["action"]}
        with self.assertRaisesRegex(ValueError, "component_value_invalid") as failure:
            validate_component_submission(component, "confirm", {"feedback": "keep scope"})
        self.assertEqual(failure.exception.detail["layer"], "component.output_schema")
        self.assertEqual(failure.exception.detail["keyword"], "required")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "SKILL.md").write_text(
            "---\nname: sample-plugin\nversion: 0.1.0\ndescription: Test plugin\n---\nUse the available tools.\n",
            encoding="utf-8",
        )
        self.descriptor = {
            "schema": 2,
            "id": "sample-plugin",
            "version": "0.1.0",
            "host": ">=0.2.0,<0.3.0",
            "skill": "SKILL.md",
            "capabilities": [],
        }
        self.save_descriptor()

    def save_descriptor(self):
        (self.source / PLUGIN_DESCRIPTOR).write_text(json.dumps(self.descriptor), encoding="utf-8")

    def call(self, *args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = main(["--host-version", "0.2.0", *map(str, args)])
        return status, json.loads(output.getvalue())

    def pack(self, output):
        return self.call(
            "pack", self.source, "--name", "sample-plugin", "--version", "0.1.0", "--output", output
        )

    def test_describe_has_no_runtime_claim(self):
        status, result = self.call("describe")
        self.assertEqual(status, 0)
        self.assertFalse(result["runtime_verified"])

    def test_pack_checks_actual_submission_examples(self):
        schema = {
            "type": "object",
            "properties": {"feedback": {"type": "string"}},
            "required": ["feedback"],
            "additionalProperties": False,
        }
        self.descriptor["capabilities"] = ["interaction.answer"]
        self.descriptor["components"] = [
            {
                "id": "scope",
                "entry": "scope.js",
                "preview": "scope.json",
                "actions": [
                    {"id": "confirm", "capability": "interaction.answer", "input_schema": schema}
                ],
                "output_schema": schema,
            }
        ]
        self.save_descriptor()
        (self.source / "scope.js").write_text("window.plugin.onState(() => {});")
        scenario = {
            "data": {},
            "responses": {"confirm": {"state": "resolved", "data": {}}},
            "submissions": {"confirm": [{"feedback": "private", "stage": "scope"}]},
        }
        (self.source / "scope.json").write_text(json.dumps(scenario))
        archive = self.root / "sample.zip"
        status, result = self.pack(archive)
        self.assertNotEqual(status, 0)
        self.assertFalse(archive.exists())
        issue = next(
            issue for issue in result["issues"] if issue["code"] == "component_value_invalid"
        )
        self.assertEqual(issue["detail"]["layer"], "action.input_schema")
        self.assertNotIn("private", json.dumps(result))
        scenario["submissions"]["confirm"][0].pop("stage")
        (self.source / "scope.json").write_text(json.dumps(scenario))
        status, result = self.pack(archive)
        self.assertEqual(status, 0, result)

    def test_pack_and_check_share_the_same_descriptor(self):
        archive = self.root / "sample.zip"
        status, packed = self.pack(archive)
        self.assertEqual(status, 0, packed)
        status, checked = self.call("check", archive)
        self.assertEqual(status, 0, checked)
        self.assertEqual(checked["sha256"], packed["sha256"])
        self.assertEqual(checked["descriptor"]["id"], "sample-plugin")
        self.assertEqual(checked["validation_stage"], "offline")
        self.assertFalse(checked["authorized"])
        self.assertFalse(checked["runtime_verified"])

    def test_invalid_plugin_does_not_publish_archive(self):
        self.descriptor["ui"] = {"entry": "missing.html", "preview": "preview.json"}
        self.save_descriptor()
        archive = self.root / "invalid.zip"
        status, result = self.pack(archive)
        self.assertEqual(status, 1)
        self.assertFalse(result["valid"])
        self.assertFalse(archive.exists())

    def test_pack_never_overwrites_existing_output(self):
        archive = self.root / "existing.zip"
        archive.write_bytes(b"previous release")
        status, result = self.pack(archive)
        self.assertEqual(status, 1)
        self.assertFalse(result["valid"])
        self.assertEqual(archive.read_bytes(), b"previous release")

    def test_check_rejects_corrupt_archives(self):
        archive = self.root / "broken.zip"
        archive.write_bytes(b"not a zip")
        status, result = self.call("check", archive)
        self.assertEqual(status, 1)
        self.assertEqual(result["issues"][0]["code"], "package_invalid")

    def test_plugin_scripts_are_not_executed(self):
        sentinel = self.root / "executed"
        (self.source / "install.py").write_text(
            f"from pathlib import Path\nPath({str(sentinel)!r}).touch()\n",
            encoding="utf-8",
        )
        archive = self.root / "sample.zip"
        status, result = self.pack(archive)
        self.assertEqual(status, 0, result)
        self.assertEqual(self.call("check", archive)[0], 0)
        self.assertFalse(sentinel.exists())

    def test_existing_dependency_declaration_is_preserved(self):
        dependencies = {"python": ["numpy==2.1.0"], "skills": ["agentic-search"]}
        (self.source / PACKAGE_MANIFEST).write_text(
            json.dumps({"dependencies": dependencies}), encoding="utf-8"
        )
        archive = self.root / "sample.zip"
        status, result = self.pack(archive)
        self.assertEqual(status, 0, result)
        with zipfile.ZipFile(archive) as package:
            manifest = json.loads(package.read(PACKAGE_MANIFEST))
        self.assertEqual(manifest["dependencies"], dependencies)
        self.assertFalse(result["dependencies_verified"])

    def test_non_directory_pack_returns_json_error(self):
        self.source = self.root / "broken.txt"
        self.source.write_text("not an archive", encoding="utf-8")
        status, result = self.pack(self.root / "sample.zip")
        self.assertEqual(status, 1)
        self.assertFalse(result["valid"])

    def test_duplicate_package_keys_are_rejected(self):
        archive = self.root / "sample.zip"
        self.assertEqual(self.pack(archive)[0], 0)
        with zipfile.ZipFile(archive) as package:
            payloads = {name: package.read(name) for name in package.namelist()}
        original = payloads[PACKAGE_MANIFEST]
        payloads[PACKAGE_MANIFEST] = b'{"dependencies": {},' + original.lstrip()[1:]
        changed = self.root / "duplicate.zip"
        with zipfile.ZipFile(changed, "w") as package:
            for name, payload in payloads.items():
                package.writestr(name, payload)
        status, result = self.call("check", changed)
        self.assertEqual(status, 1)
        self.assertFalse(result["valid"])


if __name__ == "__main__":
    unittest.main()
