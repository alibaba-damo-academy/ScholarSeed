"""Model-facing product bridge request contracts."""

from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from jsonschema import Draft202012Validator

from service.chat.runtime.tools import SERVICE_BRIDGE_TOOL, SERVICE_PLAN_TOOL, execute_service_tool
from service.chat.service.contracts import describe_contract
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    CONTRACT_GUIDANCE_KEY,
    CONTRACT_PREREQUISITES_KEY,
    PdfQuery,
    PlanAction,
    PlanRead,
    PlanStructure,
)

TOOL_BYTES_LIMIT = 5000


class BridgeToolContracts(unittest.TestCase):
    def test_artifact_contract_distinguishes_explicit_stage_delivery_from_working_files(self):
        contract = describe_contract("artifact", "publish")
        schema = contract["request_schema"]
        validator = Draft202012Validator(schema)
        for role in ("final", "intermediate", "supporting"):
            with self.subTest(role=role):
                self.assertEqual(
                    list(validator.iter_errors({"path": "outputs/result.json", "role": role})),
                    [],
                )
        self.assertTrue(list(validator.iter_errors({"path": "input.csv", "role": "input"})))
        guidance = self.guidance(contract)
        self.assertIn("independent", guidance)
        self.assertIn("intermediate", guidance)
        self.assertIn("source inputs", guidance)

    def test_fill_intent_privacy_rule_is_described_and_reports_safe_validation_details(self):
        contract = describe_contract("browser", "interact")
        self.assertIn(
            "must not repeat", contract["request_schema"]["properties"]["intent"]["description"]
        )
        result = self.invalid(
            "browser",
            "interact",
            {
                "tab_id": "tab",
                "snapshot_id": "snapshot",
                "element_ref": "element",
                "action": "fill",
                "value": "private-query",
                "intent": "Search private-query",
            },
        )
        self.assertEqual(result["error"], "bridge_invalid_parameters")
        self.assertIn(
            "browser_fill_intent_must_not_repeat_value", json.dumps(result["validation_errors"])
        )
        self.assertNotIn("private-query", json.dumps(result))

    def test_conversation_search_contract_selects_browser_via_run_not_internal_callback(self):
        contract = describe_contract("search", "run")
        guidance = self.guidance(contract)
        self.assertIn('"profile":"browser"', guidance)
        self.assertIn("search/browser", guidance)
        internal = describe_contract("search", "browser")
        self.assertIn("Invocation", self.guidance(internal))
        self.assertIn("search/run", self.guidance(internal))
        self.assertIn('"profile":"browser"', SERVICE_BRIDGE_TOOL.description)
        self.assertIn("managed embedded browser", SERVICE_BRIDGE_TOOL.description)
        self.assertIn("response_path", self.guidance(internal))
        request = BRIDGE_REQUESTS[("search", "run")].request_type.model_validate(
            {"query": "A2UI 最近研究", "profile": "browser", "limit": 20}
        )
        self.assertEqual(request.profile, "browser")

    def test_product_plan_tool_schema_resolves_nested_steps_and_preserves_stable_ids(self):
        validator = Draft202012Validator(SERVICE_PLAN_TOOL.input_schema)
        validator.validate({"operation": "get"})
        for hidden_contract in ("$defs", "$ref", "oneOf"):
            self.assertNotIn(hidden_contract, json.dumps(SERVICE_PLAN_TOOL.input_schema))
        request = {
            "operation": "create",
            "plan_id": "data",
            "expected_revision": 0,
            "request_id": "new",
            "turn_id": "turn",
            "items": [
                {"id": "root", "content": "stage"},
                {"id": "child", "parent_id": "root", "content": "work"},
            ],
        }
        validator.validate(request)
        for wrong_item in (
            {"id": "root", "title": "stage", "status": "pending"},
            {"id": "root", "content": "stage", "status": "pending", "kind": "item"},
            {"id": "root", "content": "stage", "status": "completed"},
        ):
            self.assertFalse(validator.is_valid({**request, "items": [wrong_item]}))
        request["items"][1].pop("id")
        self.assertTrue(list(validator.iter_errors(request)))

    def test_plan_tool_schema_matches_operation_request_contracts(self):
        validator = Draft202012Validator(SERVICE_PLAN_TOOL.input_schema)
        Draft202012Validator.check_schema(SERVICE_PLAN_TOOL.input_schema)
        metadata = {
            "plan_id": "plan",
            "expected_revision": 0,
            "request_id": "request",
            "turn_id": "turn",
        }
        contracts = (
            (PlanRead, {"operation": "get"}),
            *(
                (
                    PlanStructure,
                    {
                        **metadata,
                        "operation": operation,
                        "items": [{"id": "step", "content": "work"}],
                    },
                )
                for operation in PlanStructure.model_json_schema()["properties"]["operation"][
                    "enum"
                ]
            ),
            *(
                (PlanAction, {**metadata, "operation": operation, "step_ids": ["step"]})
                for operation in PlanAction.model_json_schema()["properties"]["action"]["enum"]
            ),
        )
        invalid_values = (None, "", -1, True, [], {}, [""], [None])
        for contract, valid in contracts:
            candidates = [valid, {**valid, "reason": "observed reason"}]
            candidates.extend(
                {key: value for key, value in valid.items() if key != missing} for missing in valid
            )
            candidates.extend({**valid, key: value} for key in valid for value in invalid_values)
            candidates.extend(
                {**valid, key: value}
                for key, value in {
                    **metadata,
                    "items": [{"id": "step", "content": "work"}],
                    "step_ids": ["step"],
                    "action": "start",
                    "status": "completed",
                    "request": {},
                    "unknown": "value",
                }.items()
            )
            for candidate in candidates:
                request = dict(candidate)
                if contract is PlanRead:
                    operation = request.pop("operation", None)
                    valid_operation = operation == "get"
                elif contract is PlanAction:
                    valid_operation = "operation" in request and "action" not in request
                    request["action"] = request.pop("operation", None)
                else:
                    valid_operation = True
                try:
                    contract.model_validate(request)
                    accepted = valid_operation
                except ValueError:
                    accepted = False
                with self.subTest(operation=valid["operation"], candidate=candidate):
                    self.assertEqual(validator.is_valid(candidate), accepted)

    def test_mcp_stdio_argument_types_remain_strict(self):
        for arguments in ([42], "probe.py", [None], {"script": "probe.py"}):
            with self.subTest(arguments=arguments):
                result = self.invalid(
                    "mcp",
                    "plan",
                    {
                        "expected_revision": 0,
                        "mutation": {
                            "operation": "upsert",
                            "server": {
                                "id": "stdio-probe",
                                "transport": "stdio",
                                "command": "python",
                                "args": arguments,
                            },
                        },
                        "intent": "Register local test service",
                    },
                )
                self.assertEqual(result["error"], "bridge_invalid_parameters")
                self.assertIn("mutation", result["invalid_parameters"])

    def test_resource_import_contract_is_session_scoped_and_preserves_association(self):
        contract = describe_contract("resource", "import", project_id="project")
        self.assertTrue(contract["ok"], contract)
        self.assertEqual(contract["approval"], "none")
        self.assertEqual(contract["effect"], "write")
        self.assertEqual(contract["scope"], "current_project")
        self.assertIn("asset_id", contract["response_schema"]["properties"])
        request_type = BRIDGE_REQUESTS[("resource", "import")].request_type
        request_type.model_validate({"path": "outputs/file.pdf"})
        for request in (
            {},
            {"artifact_id": "id", "project_id": "foreign"},
            {"path": "p", "artifact_id": "id"},
        ):
            with self.assertRaises(ValueError):
                request_type.model_validate(request)

    def test_dialogue_import_contract_is_separate_from_download_ingest(self):
        contract = describe_contract("literature", "import", project_id="project")
        self.assertTrue(contract["ok"], contract)
        self.assertEqual(contract["approval"], "none")
        self.assertEqual(contract["scope"], "current_project")
        self.assertIsNotNone(contract["response_schema"])
        request_type = BRIDGE_REQUESTS[("literature", "import")].request_type
        request_type.model_validate({"artifact_id": "publication"})
        request_type.model_validate({"path": "outputs/paper.pdf"})
        for request in (
            {},
            {"artifact_id": "id", "path": "paper.pdf"},
            {"path": "paper.pdf", "expected_sha256": "wrong"},
        ):
            with self.assertRaises(ValueError):
                request_type.model_validate(request)
        self.assertIn("run", BRIDGE_REQUESTS[("literature", "ingest")].request_type.model_fields)

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

    def guidance(self, contract):
        guidance = contract["guidance"]
        return " ".join(guidance) if isinstance(guidance, list) else guidance

    def test_compact_schema_covers_every_operation_and_preserves_pairs(self):
        schema = SERVICE_BRIDGE_TOOL.input_schema
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        pairs = set()
        for branch in schema["oneOf"]:
            fields = branch["properties"]
            operation = fields["operation"]
            for name in operation.get("enum", [operation.get("const")]):
                pairs.add((fields["capability"]["const"], name))
        self.assertEqual(pairs, set(BRIDGE_REQUESTS) | {("contract", "describe")})
        self.assertNotIn("TaskActivate", schema.get("$defs", {}))
        for request in (self.activation(), self.activation(workspace=42), {}):
            validator.validate({"capability": "task", "operation": "activate", "request": request})
        self.assertFalse(
            validator.is_valid(
                {
                    "capability": "history",
                    "operation": "activate",
                    "request": {},
                }
            )
        )

    def test_whole_tool_has_bounded_size_and_no_eager_contracts(self):
        tool = {
            "name": SERVICE_BRIDGE_TOOL.name,
            "type": "function",
            "description": SERVICE_BRIDGE_TOOL.description,
            "parameters": SERVICE_BRIDGE_TOOL.input_schema,
        }
        self.assertLessEqual(
            len(json.dumps(tool, separators=(",", ":")).encode()), TOOL_BYTES_LIMIT
        )
        for entry in BRIDGE_REQUESTS.values():
            self.assertNotIn(
                json.dumps(entry.request_type.model_json_schema(), separators=(",", ":")),
                SERVICE_BRIDGE_TOOL.description,
            )

    def test_describe_request_is_fully_declared(self):
        validator = Draft202012Validator(SERVICE_BRIDGE_TOOL.input_schema)
        validator.validate(
            {
                "capability": "contract",
                "operation": "describe",
                "request": {
                    "target_capability": "task",
                    "target_operation": "activate",
                },
            }
        )
        for request in (
            {},
            {"target_capability": "task"},
            {"target_capability": "task", "target_operation": 42},
            {"target_capability": "task", "target_operation": "activate", "extra": True},
        ):
            self.assertFalse(
                validator.is_valid(
                    {
                        "capability": "contract",
                        "operation": "describe",
                        "request": request,
                    }
                )
            )

    def test_every_operation_has_a_complete_discoverable_contract(self):
        for (capability, operation), entry in BRIDGE_REQUESTS.items():
            with self.subTest(capability=capability, operation=operation):
                result = describe_contract(capability, operation)
                self.assertEqual(result["capability"], capability)
                self.assertEqual(result["operation"], operation)
                expected_schema = entry.request_type.model_json_schema()
                expected_schema.pop(CONTRACT_GUIDANCE_KEY, None)
                expected_schema.pop(CONTRACT_PREREQUISITES_KEY, None)
                self.assertEqual(result["request_schema"], expected_schema)
                Draft202012Validator.check_schema(result["request_schema"])
                self.assertIn("guidance", result)
                self.assertIn("prerequisites", result)
                self.assertTrue(result["contract_version"])

    def test_contract_versions_are_stable_and_operation_specific(self):
        self.assertEqual(
            describe_contract("task", "activate"), describe_contract("task", "activate")
        )
        self.assertNotEqual(
            describe_contract("task", "activate")["contract_version"],
            describe_contract("plan", "write")["contract_version"],
        )

    def test_oversized_contract_fails_without_truncated_schema(self):
        with patch("service.chat.service.contracts.BRIDGE_MAX_RESPONSE_BYTES", 1):
            self.assertEqual(
                describe_contract("plan", "write"),
                {
                    "ok": False,
                    "error": "bridge_contract_too_large",
                },
            )

    def test_prerequisites_are_registered_and_never_self_referential(self):
        for capability, operation in BRIDGE_REQUESTS:
            contract = describe_contract(capability, operation)
            for prerequisite in contract["prerequisites"]:
                target = (prerequisite["capability"], prerequisite["operation"])
                self.assertIn(target, BRIDGE_REQUESTS)
                self.assertNotEqual(target, (capability, operation))
        self.assertEqual(describe_contract("pdf", "list")["prerequisites"], [])

    def test_discovered_contracts_keep_length_numeric_and_optional_constraints(self):
        validator = Draft202012Validator(describe_contract("task", "activate")["request_schema"])
        for field, value in (
            ("skill_version", ""),
            ("skill_version", "x" * 129),
            ("workspace", "x" * 4097),
        ):
            with self.subTest(field=field):
                self.assertFalse(validator.is_valid(self.activation(**{field: value})))
        validator = Draft202012Validator(
            describe_contract("browser-history", "search")["request_schema"]
        )
        valid = {"search": "paper", "intent": "Find a previous page"}
        validator.validate(valid)
        for field, value in (
            ("search", ""),
            ("search", "x" * 257),
            ("intent", "x" * 513),
            ("offset", -1),
            ("offset", 1001),
            ("limit", 0),
            ("limit", 21),
        ):
            with self.subTest(field=field, value=value):
                self.assertFalse(validator.is_valid({**valid, field: value}))

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
                self.assertNotIn("request_schema", result)
                self.assertEqual(
                    result["describe"],
                    {
                        "capability": "contract",
                        "operation": "describe",
                        "request": {"target_capability": "task", "target_operation": "activate"},
                    },
                )
                self.assertEqual(
                    result["contract_version"],
                    describe_contract("task", "activate")["contract_version"],
                )
        result = self.invalid("task", "activate", {})
        self.assertEqual(set(result["required_parameters"]), set(self.activation()))

    def test_plan_contract_rejects_both_reported_mistakes(self):
        contract = describe_contract("plan", "write")
        validator = Draft202012Validator(contract["request_schema"])
        request = {
            "operation": "create",
            "plan_id": "plan",
            "expected_revision": 0,
            "request_id": "create-plan",
            "turn_id": "turn",
            "items": [{"id": "step", "content": "Research", "status": "pending"}],
        }
        for operation in ("create", "update", "revise", "release"):
            validator.validate({**request, "operation": operation})
        for invalid_request in (
            {"action": "create", "items": request["items"]},
            {**request, "items": [{"id": "step", "content": "Research", "status": "unknown"}]},
        ):
            self.assertFalse(validator.is_valid(invalid_request))
        self.assertFalse(
            Draft202012Validator(
                describe_contract("plan", "get")["request_schema"],
            ).is_valid({"unexpected": True})
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
            self.assertIn(guidance, self.guidance(contract))

    def test_unknown_operation_lists_registered_choices_without_eager_schemas(self):
        result = self.invalid("plan", "update", {})
        self.assertEqual(result["error"], "bridge_operation_unknown")
        self.assertEqual(result["valid_operations"], ["get", "write", "structure", "action"])
        self.assertEqual(result["capability"], "plan")
        self.assertIn(
            {
                "capability": "contract",
                "operation": "describe",
                "request": {"target_capability": "plan", "target_operation": "action"},
            },
            result["describe_choices"],
        )
        self.assertNotIn("request_schemas", result)
        described = describe_contract("plan", "update")
        self.assertFalse(described["ok"])
        self.assertEqual(described["valid_operations"], ["get", "write", "structure", "action"])
        self.assertNotIn("request_schemas", described)
        unknown = self.invalid("unknown", "update", {})
        self.assertEqual(unknown["valid_operations"], [])
        self.assertEqual(
            set(unknown["valid_capabilities"]),
            {capability for capability, _operation in BRIDGE_REQUESTS} | {"contract"},
        )
        self.assertNotIn("request", unknown)

    def test_missing_skill_operation_discovery_returns_exact_contract_queries(self):
        result = describe_contract("skill", "unknown")
        self.assertEqual(result["capability"], "skill")
        self.assertEqual(
            result["describe_choices"],
            [
                {
                    "capability": "contract",
                    "operation": "describe",
                    "request": {"target_capability": "skill", "target_operation": operation},
                }
                for operation in (
                    "admit",
                    "search",
                    "detail",
                    "list",
                    "document",
                    "install",
                    "enable",
                    "disable",
                    "update",
                    "delete",
                )
            ],
        )

    def test_plan_action_schema_requires_identity_but_not_a_complete_tree(self):
        validator = Draft202012Validator(SERVICE_PLAN_TOOL.input_schema)
        request = {
            "operation": "start",
            "plan_id": "review",
            "expected_revision": 1,
            "turn_id": "turn",
            "request_id": "start",
            "step_ids": ["leaf"],
        }
        validator.validate(request)
        for field in ("plan_id", "expected_revision", "turn_id", "request_id"):
            with self.subTest(field=field):
                result = asyncio.run(
                    execute_service_tool(
                        {name: value for name, value in request.items() if name != field},
                        session_id="contract",
                        token="contract",
                        local_socket=None,
                        tool_name="update_plan",
                    )
                )
                self.assertEqual(result["error"], "bridge_invalid_parameters")
                self.assertIn(field, result["required_parameters"])
                self.assertEqual(result["tool_schema"], SERVICE_PLAN_TOOL.input_schema)
                self.assertNotIn("describe", result)
                self.assertIn([field], [error["path"] for error in result["validation_errors"]])
        request["changes"] = [{"id": "leaf", "status": "completed"}]
        self.assertFalse(validator.is_valid(request))

    def test_model_plan_action_cannot_override_the_selected_operation(self):
        result = asyncio.run(
            execute_service_tool(
                {"operation": "start", "action": "finish", "step_ids": ["leaf"]},
                session_id="contract",
                token="contract",
                local_socket=None,
                tool_name="update_plan",
            )
        )
        self.assertEqual(result["error"], "bridge_invalid_parameters")
        self.assertEqual(result["invalid_parameters"], ["action"])
        self.assertEqual(result["tool_schema"], SERVICE_PLAN_TOOL.input_schema)

    def test_existing_native_plan_validation_keeps_its_request_envelope(self):
        result = asyncio.run(
            execute_service_tool(
                {"operation": "write", "request": {}},
                session_id="contract",
                token="contract",
                local_socket=None,
                tool_name="update_plan",
            )
        )
        self.assertEqual(result["error"], "bridge_invalid_parameters")
        self.assertIn(
            ["request", "plan_id"], [error["path"] for error in result["validation_errors"]]
        )
        self.assertIn("operation", result["request_schema"]["properties"])
        self.assertNotIn("tool_schema", result)

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

    def test_array_errors_preserve_indexes_and_discovery_retains_nested_values(self):
        result = self.invalid(
            "literature",
            "acquire",
            {
                "run": "survey",
                "papers": [
                    {"paper_id": "paper", "identifier": "id", "identifier_kind": "invalid"},
                ],
            },
        )
        self.assertEqual(
            result["validation_errors"][0]["path"], ["request", "papers", 0, "identifier_kind"]
        )
        self.assertNotIn("request_schema", result)
        definition = describe_contract("literature", "acquire")["request_schema"]["$defs"][
            "LiteratureAcquirePaper"
        ]
        self.assertEqual(definition["properties"]["identifier_kind"]["enum"], ["arxiv", "doi"])
        json.dumps(result)

    def test_pdf_contract_exposes_supported_arguments_and_workflow(self):
        contract = describe_contract("pdf", "read")
        for operation in ("pdf/list", "pdf/read", "pdf/search"):
            self.assertIn(operation, self.guidance(contract))
        for field in PdfQuery.model_fields:
            self.assertIn(field, contract["request_schema"]["properties"])
        self.assertIn("not PDF page numbers", self.guidance(contract))
        self.assertNotIn(
            "PDF", SERVICE_BRIDGE_TOOL.input_schema["properties"]["request"]["description"]
        )

    def test_invalid_pdf_parameters_name_rejected_and_allowed_fields(self):
        for operation, request, rejected in (
            (
                "search",
                {"ref_id": "attachment", "query": "Section 4", "max_results": 20},
                "max_results",
            ),
            ("read", {"ref_id": "attachment", "start_page": 1, "end_page": 5}, "start_page"),
        ):
            result = self.invalid("pdf", operation, request)
            self.assertEqual(result["error"], "bridge_invalid_parameters")
            self.assertIn(rejected, result["invalid_parameters"])
            self.assertEqual(result["valid_parameters"], list(PdfQuery.model_fields))

    def test_other_operation_keeps_its_own_request_contract(self):
        request_type = BRIDGE_REQUESTS[("history", "list")].request_type
        result = self.invalid("history", "list", {"unknown": True})
        self.assertEqual(result["valid_parameters"], list(request_type.model_fields))
        self.assertEqual(result["invalid_parameters"], ["unknown"])


if __name__ == "__main__":
    unittest.main()
