"""Model-facing product bridge request contracts."""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator

from service.chat.runtime.tools import SERVICE_BRIDGE_TOOL, execute_service_tool
from service.platform.bridge import BRIDGE_REQUESTS, PdfQuery, PlanWrite


class BridgeToolContracts(unittest.TestCase):
    def activation(self, **updates):
        request = {
            "task_type": "literature_review",
            "skill_name": "literature-review",
            "skill_version": "1.0",
            "skill_path": "/skills/literature-review",
            "workspace": "survey",
        }
        request.update(updates)
        return request

    def invalid(self, capability, operation, request):
        return asyncio.run(
            execute_service_tool(
                {"capability": capability, "operation": operation, "request": request},
                session_id="session",
                token="token",
                local_socket=Path("/missing/socket"),
            )
        )

    def test_schema_covers_every_operation_and_resolves_nested_models(self):
        schema = SERVICE_BRIDGE_TOOL.input_schema
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        pairs = set()
        for branch in schema["oneOf"]:
            fields = branch["properties"]
            operation = fields["operation"]
            for name in operation.get("enum", [operation.get("const")]):
                pairs.add((fields["capability"]["const"], name))
        self.assertEqual(pairs, set(BRIDGE_REQUESTS))
        self.assertEqual(
            schema["properties"]["capability"]["enum"],
            list(dict.fromkeys(capability for capability, _operation in BRIDGE_REQUESTS)),
        )
        self.assertEqual(
            schema["properties"]["operation"]["enum"],
            list(dict.fromkeys(operation for _capability, operation in BRIDGE_REQUESTS)),
        )
        self.assertNotIn("update", schema["properties"]["operation"]["enum"])
        self.assertIn(
            "outer operation is always write", schema["properties"]["operation"]["description"]
        )
        self.assertLess(len(json.dumps(schema, separators=(",", ":")).encode()), 5000)
        version = schema["$defs"]["TaskActivate"]["properties"]["skill_version"]
        self.assertIn('"minLength":1', version["description"])
        self.assertIn('"maxLength":128', version["description"])
        model, _route = BRIDGE_REQUESTS[("task", "activate")]
        self.assertIn(
            "task/activate: " + json.dumps(model.model_json_schema(), separators=(",", ":")),
            SERVICE_BRIDGE_TOOL.description,
        )
        validator.validate(
            {"capability": "task", "operation": "activate", "request": self.activation()}
        )
        validator.validate(
            {
                "capability": "display-card",
                "operation": "publish",
                "request": {"type": "test", "content": {"data": {}}},
            }
        )
        for request in (
            self.activation(task_type="literature-review"),
            self.activation(workspace=3),
            {},
        ):
            with self.subTest(request=request):
                self.assertFalse(
                    validator.is_valid(
                        {"capability": "task", "operation": "activate", "request": request}
                    )
                )
        self.assertFalse(
            validator.is_valid(
                {"capability": "history", "operation": "activate", "request": self.activation()}
            )
        )

    def test_validation_reports_literal_type_length_and_required_errors(self):
        for field, value, error_type in (
            ("task_type", "literature-review", "literal_error"),
            ("workspace", 42, "string_type"),
            ("skill_version", "", "string_too_short"),
            ("skill_version", "v" * 129, "string_too_long"),
        ):
            with self.subTest(field=field, error_type=error_type):
                result = self.invalid("task", "activate", self.activation(**{field: value}))
                self.assertEqual(result["error"], "bridge_invalid_parameters")
                self.assertIn(field, result["invalid_parameters"])
                self.assertEqual(result["validation_errors"][0]["path"], ["request", field])
                self.assertEqual(result["validation_errors"][0]["type"], error_type)
                self.assertNotIn("input", result["validation_errors"][0])
                self.assertNotIn("ctx", result["validation_errors"][0])
                self.assertIn(
                    "literature_review", result["request_schema"]["properties"]["task_type"]["enum"]
                )
        result = self.invalid("task", "activate", {})
        self.assertEqual(set(result["required_parameters"]), set(self.activation()))

    def test_every_operation_has_a_complete_model_visible_contract(self):
        for (capability, operation), (model, _route) in BRIDGE_REQUESTS.items():
            with self.subTest(capability=capability, operation=operation):
                self.assertIn(
                    f"{capability}/{operation}: "
                    + json.dumps(model.model_json_schema(), separators=(",", ":")),
                    SERVICE_BRIDGE_TOOL.description,
                )

    def test_plan_schema_rejects_both_reported_mistakes(self):
        schema = SERVICE_BRIDGE_TOOL.input_schema
        validator = Draft202012Validator(schema)
        request = {
            "operation": "create",
            "plan_id": "plan",
            "expected_revision": 0,
            "request_id": "create-plan",
            "turn_id": "turn",
            "items": [{"id": "step", "content": "Research", "status": "pending"}],
        }
        validator.validate({"capability": "plan", "operation": "get", "request": {}})
        for operation in ("create", "update", "revise", "release"):
            validator.validate(
                {
                    "capability": "plan",
                    "operation": "write",
                    "request": {**request, "operation": operation},
                }
            )
        for operation, invalid_request in (
            ("write", {"action": "create", "items": request["items"]}),
            ("update", request),
            (
                "write",
                {**request, "items": [{"id": "step", "content": "Research", "status": "unknown"}]},
            ),
            ("get", {"unexpected": True}),
        ):
            with self.subTest(operation=operation, request=invalid_request):
                self.assertFalse(
                    validator.is_valid(
                        {"capability": "plan", "operation": operation, "request": invalid_request}
                    )
                )
        self.assertEqual(
            schema["$defs"]["PlanWrite"]["required"], PlanWrite.model_json_schema()["required"]
        )
        for guidance in (
            "plan/get",
            "plan/write",
            "request.operation",
            "not action",
            "expected_revision",
            "complete flat items",
            "optional parent_id",
            "No children field is supported",
            "For normal completion, use update",
            "Release opts out of structured planning",
        ):
            self.assertIn(guidance, SERVICE_BRIDGE_TOOL.description)

    def test_unknown_operation_lists_registered_choices_and_recovery(self):
        result = self.invalid("plan", "update", {})
        self.assertEqual(result["error"], "bridge_operation_unknown")
        self.assertEqual(result["valid_operations"], ["get", "write"])
        self.assertEqual(set(result["request_schemas"]), {"get", "write"})
        self.assertEqual(result["request_schemas"]["write"], PlanWrite.model_json_schema())
        self.assertIn("request.operation", result["next_action"])
        self.assertIn(
            "request.operation",
            result["request_schemas"]["write"]["properties"]["operation"].get("description", ""),
        )
        unknown = self.invalid("unknown", "update", {})
        self.assertEqual(unknown["valid_operations"], [])
        self.assertEqual(
            set(unknown["valid_capabilities"]),
            {capability for capability, _operation in BRIDGE_REQUESTS},
        )
        self.assertNotIn("request", unknown)

    def test_model_and_nested_errors_keep_full_path_without_input(self):
        for request, expected_path in (
            ({"type": "test", "content": {}}, ["request", "content"]),
            ({"type": "test", "content": {"path": 42}}, ["request", "content", "path"]),
            ([], ["request"]),
        ):
            result = self.invalid("display-card", "publish", request)
            self.assertEqual(result["error"], "bridge_invalid_parameters")
            self.assertEqual(result["validation_errors"][0]["path"], expected_path)
            self.assertTrue(result["invalid_parameters"])
            json.dumps(result)

    def test_array_errors_preserve_indexes_and_allowed_values(self):
        result = self.invalid(
            "literature",
            "acquire",
            {
                "run": "survey",
                "papers": [{"paper_id": "paper", "identifier": "id", "identifier_kind": "invalid"}],
            },
        )
        self.assertEqual(
            result["validation_errors"][0]["path"], ["request", "papers", 0, "identifier_kind"]
        )
        definition = result["request_schema"]["$defs"]["LiteratureAcquirePaper"]
        self.assertEqual(definition["properties"]["identifier_kind"]["enum"], ["arxiv", "doi"])
        json.dumps(result)

    def test_pdf_contract_exposes_supported_arguments(self) -> None:
        description = SERVICE_BRIDGE_TOOL.description
        for operation in ("pdf/list", "pdf/read", "pdf/search"):
            self.assertIn(operation, description)
        for field in PdfQuery.model_fields:
            self.assertIn(field, description)
        self.assertIn("offset", description)
        self.assertIn("not PDF page numbers", description)
        self.assertIn(
            "selected capability/operation",
            SERVICE_BRIDGE_TOOL.input_schema["properties"]["request"]["description"],
        )
        self.assertNotIn(
            "PDF", SERVICE_BRIDGE_TOOL.input_schema["properties"]["request"]["description"]
        )

    def test_invalid_pdf_parameters_name_rejected_and_allowed_fields(self) -> None:
        for operation, request, rejected in (
            (
                "search",
                {"ref_id": "attachment", "query": "Section 4", "max_results": 20},
                "max_results",
            ),
            ("read", {"ref_id": "attachment", "start_page": 1, "end_page": 5}, "start_page"),
        ):
            result = asyncio.run(
                execute_service_tool(
                    {"capability": "pdf", "operation": operation, "request": request},
                    session_id="session",
                    token="token",
                    local_socket=Path("/missing/socket"),
                )
            )
            self.assertEqual(result["error"], "bridge_invalid_parameters")
            self.assertIn(rejected, result["invalid_parameters"])
            self.assertEqual(result["valid_parameters"], list(PdfQuery.model_fields))

    def test_other_operation_keeps_its_own_request_contract(self) -> None:
        request_type, _route = BRIDGE_REQUESTS[("history", "list")]
        result = asyncio.run(
            execute_service_tool(
                {"capability": "history", "operation": "list", "request": {"unknown": True}},
                session_id="session",
                token="token",
                local_socket=Path("/missing/socket"),
            )
        )
        self.assertEqual(result["valid_parameters"], list(request_type.model_fields))
        self.assertEqual(result["invalid_parameters"], ["unknown"])


if __name__ == "__main__":
    unittest.main()
