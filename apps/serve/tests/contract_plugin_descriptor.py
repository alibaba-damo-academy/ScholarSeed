"""Deterministic plugin descriptor checks; not runtime or UI acceptance."""

from __future__ import annotations

import copy
import json
import unittest

from service.capabilities.service.descriptor import (
    PLUGIN_DESCRIPTOR,
    inspect_plugin,
    plugin_contract,
)


class DescriptorContract(unittest.TestCase):
    def setUp(self) -> None:
        self.document = {
            "schema": 2,
            "id": "method-comparison",
            "version": "0.1.0",
            "host": ">=0.2.0,<0.3.0",
            "skill": "SKILL.md",
            "capabilities": ["artifact.open"],
            "components": [
                {
                    "id": "comparison",
                    "entry": "ui/index.js",
                    "preview": "examples/preview.json",
                    "actions": [{"id": "open-report", "capability": "artifact.open"}],
                }
            ],
            "configuration": [
                {"key": "language", "type": "string", "label": "Language", "default": "zh"}
            ],
        }
        self.files = {
            "SKILL.md": b"---\nname: method-comparison\nversion: 0.1.0\ndescription: compare\n---\n",
            "ui/index.js": b"<!doctype html><html><body>Comparison</body></html>",
            "examples/preview.json": b'{"data": {"papers": []}, "responses": {"open-report": {"state": "resolved", "data": {}}}}',
        }

    def inspect(self, document=None, files=None, capabilities=("artifact.open",)):
        payloads = dict(self.files if files is None else files)
        payloads[PLUGIN_DESCRIPTOR] = json.dumps(
            self.document if document is None else document
        ).encode()
        return inspect_plugin(
            payloads,
            skill_name="method-comparison",
            skill_version="0.1.0",
            host_version="0.2.0",
            available_capabilities=capabilities,
        )

    def test_valid_descriptor_does_not_claim_runtime_validation(self):
        result = self.inspect()
        self.assertTrue(result["valid"], result)
        self.assertEqual(result["scenarios"]["comparison"]["data"], {"papers": []})
        self.assertFalse(result["runtime_verified"])
        self.assertFalse(result["authorized"])

    def test_unknown_capability_is_not_granted(self):
        result = self.inspect(capabilities=())
        self.assertFalse(result["valid"])
        self.assertIn("capability_unavailable", {issue["code"] for issue in result["issues"]})

    def test_unresolved_capability_catalog_is_explicit(self):
        result = self.inspect(capabilities=None)
        self.assertTrue(result["valid"], result)
        self.assertFalse(result["capabilities_verified"])
        self.assertIn("capabilities_unchecked", {issue["code"] for issue in result["issues"]})

    def test_identity_and_host_mismatch(self):
        for key, value in (("id", "other"), ("version", "0.2.0"), ("host", ">=1.0.0")):
            with self.subTest(key=key):
                changed = {**self.document, key: value}
                self.assertFalse(self.inspect(changed)["valid"])

    def test_unknown_fields_and_schema_are_rejected(self):
        for change in ({"schema": 3}, {"schema": True}, {"startup": "python evil.py"}):
            with self.subTest(change=change):
                self.assertFalse(self.inspect({**self.document, **change})["valid"])

    def test_paths_are_portable_and_package_relative(self):
        for path in (
            "../index.html",
            "/index.html",
            "C:/index.html",
            "ui\\index.html",
            "https://example.org/index.html",
            "ui/./index.html",
            "ui//index.html",
            "ui/CON.html",
            "ui/trailing./index.html",
            "ui/a%2fb.html",
        ):
            with self.subTest(path=path):
                changed = copy.deepcopy(self.document)
                changed["components"][0]["entry"] = path
                self.assertFalse(self.inspect(changed)["valid"])

    def test_missing_and_invalid_resources_are_rejected(self):
        missing = dict(self.files)
        del missing["ui/index.js"]
        self.assertFalse(self.inspect(files=missing)["valid"])
        for value in (b"not json", b"[]", b'{"value": NaN}', b'{"value": 1, "value": 2}'):
            with self.subTest(value=value):
                self.assertFalse(
                    self.inspect(files={**self.files, "examples/preview.json": value})["valid"]
                )

    def test_actions_require_declared_capabilities(self):
        changed = copy.deepcopy(self.document)
        changed["capabilities"] = []
        self.assertFalse(self.inspect(changed)["valid"])
        changed = copy.deepcopy(self.document)
        changed["components"][0]["actions"] *= 2
        self.assertFalse(self.inspect(changed)["valid"])

    def test_configuration_is_typed_and_rejects_secret_kind(self):
        for field in (
            {"key": "limit", "type": "integer", "label": "Limit", "default": True},
            {"key": "token", "type": "secret", "label": "Token", "default": "password"},
            {"key": "flag", "type": "boolean", "label": "Flag", "default": "yes"},
        ):
            with self.subTest(field=field):
                self.assertFalse(self.inspect({**self.document, "configuration": [field]})["valid"])

    def test_plain_skill_is_not_implicitly_a_plugin(self):
        result = inspect_plugin(
            self.files,
            skill_name="method-comparison",
            skill_version="0.1.0",
            host_version="0.2.0",
            available_capabilities=(),
        )
        self.assertFalse(result["valid"])
        self.assertEqual(result["issues"][0]["code"], "descriptor_missing")

    def test_all_payload_paths_are_portable(self):
        for path in ("ui/NUL.txt", "scripts/aux.py", "ui/bad?.js"):
            with self.subTest(path=path):
                self.assertFalse(self.inspect(files={**self.files, path: b"payload"})["valid"])

    def test_preview_rejects_overflowing_json_numbers(self):
        for payload in (b'{"values": [1e309]}', b'{"values": [-1e309]}'):
            with self.subTest(payload=payload):
                self.assertFalse(
                    self.inspect(files={**self.files, "examples/preview.json": payload})["valid"]
                )

    def test_offline_contract_is_machine_readable(self):
        contract = plugin_contract()
        self.assertEqual(contract["descriptor"], PLUGIN_DESCRIPTOR)
        self.assertIn("properties", contract["schema"])
        self.assertFalse(contract["grants_permissions"])


if __name__ == "__main__":
    unittest.main()
