"""Offline plugin declarations, independent of installation and execution authority."""

from __future__ import annotations

import json
import re
from enum import StrEnum
from pathlib import PurePosixPath
from typing import Annotated, Any, Literal, Mapping, cast

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from jsonschema.exceptions import ValidationError as SchemaValidationError
from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

from service.capabilities.domain import COMPONENT_ANSWER_CAPABILITY
from service.capabilities.service.utils import json_object

PLUGIN_DESCRIPTOR = ".scholarseed-plugin.json"
PLUGIN_SCHEMA = 2
PLUGIN_SKILL_ENTRY = "SKILL.md"
HOST_COMPONENT_PLUGIN = "host"
HOST_COMPONENT_REVISION = "host-v1"
SYSTEM_UI_PLUGIN = "official-ui"
PUBLIC_COMPONENT_PROVIDERS = {
    "interaction.question": HOST_COMPONENT_PLUGIN,
    "display.literature-search": HOST_COMPONENT_PLUGIN,
    "preview.literature-results": HOST_COMPONENT_PLUGIN,
    "literature.selection": SYSTEM_UI_PLUGIN,
    "literature.authorization": HOST_COMPONENT_PLUGIN,
    "display.literature-downloads": HOST_COMPONENT_PLUGIN,
    "display.literature-delivery": HOST_COMPONENT_PLUGIN,
    "display.literature-references": HOST_COMPONENT_PLUGIN,
}
PUBLIC_COMPONENT_SLOTS = frozenset(PUBLIC_COMPONENT_PROVIDERS)
MAX_COMPONENT_VALUE_BYTES = 256 * 1024
MAX_DESCRIPTOR_BYTES = 64 * 1024
MAX_PREVIEW_BYTES = 256 * 1024
MAX_DECLARATIONS = 64
MAX_LABEL_LENGTH = 200
MAX_SCENARIO_DEPTH = 32
SCENARIO_REFERENCES = frozenset({"$input", "$state", "$data"})
SCENARIO_DEFAULT = "$default"
SCENARIO_CONDITION = "$if"
SCENARIO_BRANCH_KEYS = frozenset({SCENARIO_CONDITION, "equals", "then", "else"})
SCENARIO_UNSAFE_KEYS = frozenset({"__proto__", "constructor", "prototype"})
SEMANTIC_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\Z")
PORTABLE_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{number}" for number in range(1, 10)),
        *(f"LPT{number}" for number in range(1, 10)),
    }
)
PORTABLE_FORBIDDEN_CHARACTERS = frozenset('\\:%<>"|?*')
Identifier = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,63}$")]
Capability = Annotated[
    str, StringConstraints(pattern=r"^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$", max_length=128)
]
Label = Annotated[str, StringConstraints(min_length=1, max_length=MAX_LABEL_LENGTH)]


class ConfigurationKind(StrEnum):
    STRING = "string"
    INTEGER = "integer"
    BOOLEAN = "boolean"


class Declaration(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


def portable_resource(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or path.as_posix() != value
        or any(
            character in PORTABLE_FORBIDDEN_CHARACTERS or ord(character) < 32 for character in value
        )
        or any(
            part in (".", "..")
            or part.endswith((" ", "."))
            or part.split(".")[0].upper() in PORTABLE_RESERVED_NAMES
            for part in path.parts
        )
    ):
        raise ValueError("resource must be a portable package-relative path")
    return value


def validate_component_schema(value: dict[str, Any]) -> dict[str, Any]:
    def check(node: Any, depth: int = 0) -> None:
        if depth > MAX_SCENARIO_DEPTH:
            raise ValueError("component_schema_too_deep")
        if isinstance(node, dict):
            if "$ref" in node or "$dynamicRef" in node:
                raise ValueError("component_schema_references_forbidden")
            for child in node.values():
                check(child, depth + 1)
        elif isinstance(node, list):
            for child in node:
                check(child, depth + 1)

    check(value)
    try:
        Draft202012Validator.check_schema(value)
    except SchemaError as error:
        raise ValueError("component_schema_invalid") from error
    return value


class ComponentValidationError(ValueError):
    def __init__(self, error: SchemaValidationError) -> None:
        super().__init__("component_value_invalid")
        self.detail = {
            "path": list(error.absolute_path),
            "schema_path": list(error.absolute_schema_path),
            "keyword": error.validator,
        }
        if error.validator == "required" and isinstance(error.instance, dict):
            self.detail["missing"] = [
                key for key in cast(list[str], error.validator_value) if key not in error.instance
            ]


def validate_component_value(schema: Mapping[str, Any], value: Any) -> None:
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
    if len(encoded) > MAX_COMPONENT_VALUE_BYTES:
        raise ValueError("component_value_oversized")
    try:
        Draft202012Validator(schema).validate(value)
    except SchemaValidationError as error:
        raise ComponentValidationError(error) from error


def validate_component_submission(
    component: Mapping[str, Any], action_id: str, values: Any
) -> None:
    action = next((item for item in component.get("actions", []) if item["id"] == action_id), None)
    if action is None:
        raise ValueError("plugin_action_undeclared")
    schemas = [("action.input_schema", action.get("input_schema", {"type": "object"}))]
    if action["capability"] == COMPONENT_ANSWER_CAPABILITY:
        schemas.append(
            ("component.output_schema", component.get("output_schema", {"type": "object"}))
        )
    for layer, schema in schemas:
        try:
            validate_component_value(schema, values)
        except ComponentValidationError as error:
            error.detail.update(component=component["id"], action=action_id, layer=layer)
            raise


class PluginAction(Declaration):
    id: Identifier
    capability: Capability
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})

    @field_validator("input_schema")
    @classmethod
    def schema_valid(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_component_schema(value)


class PluginComponent(Declaration):
    id: Identifier
    slot: Capability | None = None
    public: bool = False
    entry: str | None = Field(
        default=None, description="Package-relative compiled JavaScript component entry"
    )
    preview: str = Field(description="Package-relative conversation scenario JSON")
    actions: list[PluginAction] = Field(default_factory=list, max_length=MAX_DECLARATIONS)
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})
    output_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object"})

    @field_validator("input_schema", "output_schema")
    @classmethod
    def schema_valid(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_component_schema(value)

    @field_validator("entry", "preview")
    @classmethod
    def resource_path(cls, value: str | None) -> str | None:
        return portable_resource(value) if value is not None else None

    @model_validator(mode="after")
    def unique_actions(self) -> PluginComponent:
        if len({action.id for action in self.actions}) != len(self.actions):
            raise ValueError("UI action IDs must be unique")
        if self.public:
            if self.slot not in PUBLIC_COMPONENT_SLOTS or self.entry is not None:
                raise ValueError("public component must reference a host slot without code")
        elif self.slot in PUBLIC_COMPONENT_SLOTS:
            raise ValueError("component_slot_reserved")
        elif not self.entry or PurePosixPath(self.entry).suffix.lower() != ".js":
            raise ValueError("component entry must be a JavaScript resource")
        if PurePosixPath(self.preview).suffix.lower() != ".json":
            raise ValueError("UI preview must be a JSON resource")
        return self


class ScenarioStep(Declaration):
    state: Literal["resolved", "failed", "cancelled"]
    data: dict[str, Any]
    set: dict[str, Any] = Field(default_factory=dict)
    append: dict[str, Any] = Field(default_factory=dict)


class ScenarioResponse(ScenarioStep):
    steps: list[ScenarioStep] = Field(default_factory=list, max_length=MAX_DECLARATIONS)


class ScenarioOption(Declaration):
    label: str
    description: str | None = None


class ScenarioPaper(Declaration):
    id: str
    label: str
    description: str | None = None


class ScenarioQuestion(Declaration):
    id: str
    header: str
    question: str
    options: list[ScenarioOption]
    papers: list[ScenarioPaper] | None = None
    multiSelect: bool = False


class ScenarioInteraction(Declaration):
    questions: list[ScenarioQuestion] = Field(min_length=1, max_length=MAX_DECLARATIONS)
    respond: list[ScenarioStep] = Field(default_factory=list, max_length=MAX_DECLARATIONS)
    interrupt: list[ScenarioStep] = Field(default_factory=list, max_length=MAX_DECLARATIONS)


class ScenarioCase(Declaration):
    label: Label
    data: dict[str, Any] | None = None
    state: dict[str, Any] | None = None
    responses: dict[str, ScenarioResponse] | None = None
    interaction: ScenarioInteraction | None = None


class ComponentScenario(Declaration):
    data: dict[str, Any]
    state: dict[str, Any] = Field(default_factory=dict)
    responses: dict[str, ScenarioResponse]
    interaction: ScenarioInteraction | None = None
    cases: list[ScenarioCase] = Field(default_factory=list, max_length=MAX_DECLARATIONS)
    submissions: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)


def validate_scenario_value(value: Any, depth: int = 0) -> None:
    if depth > MAX_SCENARIO_DEPTH:
        raise ValueError("scenario expression is too deep")
    if isinstance(value, list):
        for item in value:
            validate_scenario_value(item, depth + 1)
        return
    if not isinstance(value, dict):
        return
    keys = set(value)
    if keys & SCENARIO_UNSAFE_KEYS:
        raise ValueError("scenario contains an unsafe key")
    references = keys & SCENARIO_REFERENCES
    if references:
        if len(references) != 1 or keys - references - {SCENARIO_DEFAULT}:
            raise ValueError("scenario reference must have one source")
        path = value[next(iter(references))]
        if not isinstance(path, str) or any(
            not part or part in SCENARIO_UNSAFE_KEYS for part in path.split(".")
        ):
            raise ValueError("scenario reference path is invalid")
    elif SCENARIO_CONDITION in keys and keys != SCENARIO_BRANCH_KEYS:
        raise ValueError("scenario condition requires both branches and a comparison")
    for item in value.values():
        validate_scenario_value(item, depth + 1)


def validate_scenario(scenario: ComponentScenario, component_ids: set[str]) -> None:
    for variant in (scenario, *scenario.cases):
        steps: list[ScenarioStep] = []
        for response in (variant.responses or {}).values():
            steps.extend((response, *response.steps))
        if variant.interaction:
            steps.extend(variant.interaction.respond)
            steps.extend(variant.interaction.interrupt)
        for step in steps:
            validate_scenario_value(step.model_dump(mode="json"))
            if "target" in step.data:
                target = step.data["target"]
                if not isinstance(target, dict) or target.get("component") not in component_ids:
                    raise ValueError("scenario target must name a declared component")
                if not isinstance(target.get("data"), dict):
                    raise ValueError("scenario target must provide component data")


class PluginConfiguration(Declaration):
    key: Identifier
    type: Literal["string", "integer", "boolean"]
    label: Label
    required: bool = False
    default: str | int | bool | None = None

    @model_validator(mode="after")
    def matching_default(self) -> PluginConfiguration:
        expected = {
            ConfigurationKind.STRING: str,
            ConfigurationKind.INTEGER: int,
            ConfigurationKind.BOOLEAN: bool,
        }[self.type]
        if self.default is not None and type(self.default) is not expected:
            raise ValueError("configuration default does not match its declared type")
        return self


class UIDependency(Declaration):
    compatibility: Literal["1.0"]
    exports: list[Label] = Field(max_length=MAX_DECLARATIONS)


class PluginDescriptor(Declaration):
    schema_version: int = Field(alias="schema", ge=PLUGIN_SCHEMA, le=PLUGIN_SCHEMA)
    id: Identifier
    version: str
    host: str = Field(description="Explicit PEP 440 host version range, for example >=0.2.0,<0.3.0")
    skill: Literal["SKILL.md"]
    ui: UIDependency | None = None
    capabilities: list[Capability] = Field(max_length=MAX_DECLARATIONS)
    components: list[PluginComponent] = Field(default_factory=list, max_length=MAX_DECLARATIONS)
    configuration: list[PluginConfiguration] = Field(
        default_factory=list, max_length=MAX_DECLARATIONS
    )

    @field_validator("version")
    @classmethod
    def semantic_version(cls, value: str) -> str:
        if not SEMANTIC_VERSION.fullmatch(value):
            raise ValueError("plugin version must be a semantic version")
        return value

    @field_validator("host")
    @classmethod
    def host_range(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("host compatibility must be explicit")
        try:
            SpecifierSet(value)
        except InvalidSpecifier as exc:
            raise ValueError("invalid host compatibility range") from exc
        return value

    @model_validator(mode="after")
    def declared_actions(self) -> PluginDescriptor:
        if len(set(self.capabilities)) != len(self.capabilities):
            raise ValueError("capabilities must be unique")
        if len({field.key for field in self.configuration}) != len(self.configuration):
            raise ValueError("configuration keys must be unique")
        if len({component.id for component in self.components}) != len(self.components):
            raise ValueError("component IDs must be unique")
        slots = [component.slot for component in self.components if component.slot is not None]
        if len(set(slots)) != len(slots):
            raise ValueError("component slots must be unique")
        if any(
            action.capability not in self.capabilities
            for component in self.components
            for action in component.actions
        ):
            raise ValueError("every UI action must reference a declared capability")
        return self


def plugin_contract() -> dict[str, Any]:
    return {
        "descriptor": PLUGIN_DESCRIPTOR,
        "schema": PluginDescriptor.model_json_schema(),
        "scenario_schema": ComponentScenario.model_json_schema(),
        "grants_permissions": False,
        "runtime_verified": False,
        "public_slots": sorted(PUBLIC_COMPONENT_SLOTS),
        "public_providers": PUBLIC_COMPONENT_PROVIDERS,
    }


def inspect_plugin(
    files: Mapping[str, bytes],
    *,
    skill_name: str,
    skill_version: str,
    host_version: str,
    available_capabilities: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    result: dict[str, Any] = {
        "valid": False,
        "descriptor": None,
        "scenarios": {},
        "issues": issues,
        "capabilities_verified": available_capabilities is not None,
        "runtime_verified": False,
        "authorized": False,
    }
    if PLUGIN_DESCRIPTOR not in files:
        issues.append(
            {
                "code": "descriptor_missing",
                "path": PLUGIN_DESCRIPTOR,
                "message": "plugin descriptor is required",
                "severity": "error",
            }
        )
        return result
    try:
        descriptor = PluginDescriptor.model_validate(
            json_object(files[PLUGIN_DESCRIPTOR], limit=MAX_DESCRIPTOR_BYTES)
        )
    except ValidationError as exc:
        for error in exc.errors(include_url=False, include_context=False, include_input=False):
            issues.append(
                {
                    "code": "descriptor_invalid",
                    "path": "/".join(str(part) for part in error["loc"]),
                    "message": error["msg"],
                    "severity": "error",
                }
            )
        return result
    except (ValueError, UnicodeError, RecursionError):
        issues.append(
            {
                "code": "descriptor_invalid",
                "path": PLUGIN_DESCRIPTOR,
                "message": "descriptor must be bounded, unique-key UTF-8 JSON",
                "severity": "error",
            }
        )
        return result
    result["descriptor"] = descriptor.model_dump(mode="json", by_alias=True)
    if descriptor.ui is None:
        result["descriptor"].pop("ui")
    for path in files:
        try:
            portable_resource(path)
        except ValueError:
            issues.append(
                {
                    "code": "resource_path_invalid",
                    "path": path,
                    "message": "payload path is not portable",
                    "severity": "error",
                }
            )
    if descriptor.id != skill_name or descriptor.version != skill_version:
        issues.append(
            {
                "code": "identity_mismatch",
                "path": "id/version",
                "message": "plugin and Skill identities must match",
                "severity": "error",
            }
        )
    if descriptor.skill not in files:
        issues.append(
            {
                "code": "skill_missing",
                "path": descriptor.skill,
                "message": "Skill entry is missing",
                "severity": "error",
            }
        )
    try:
        compatible = Version(host_version) in SpecifierSet(descriptor.host)
    except InvalidVersion:
        compatible = False
    if not compatible:
        issues.append(
            {
                "code": "host_incompatible",
                "path": "host",
                "message": "host version is not compatible",
                "severity": "error",
            }
        )
    if available_capabilities is None:
        issues.append(
            {
                "code": "capabilities_unchecked",
                "path": "capabilities",
                "message": "offline inspection does not verify host capability availability",
                "severity": "warning",
            }
        )
    else:
        for capability in descriptor.capabilities:
            if capability not in available_capabilities:
                issues.append(
                    {
                        "code": "capability_unavailable",
                        "path": capability,
                        "message": "capability is not available from this host",
                        "severity": "error",
                    }
                )
    for component in descriptor.components:
        for resource in filter(None, (component.entry, component.preview)):
            if resource not in files:
                issues.append(
                    {
                        "code": "resource_missing",
                        "path": resource,
                        "message": "declared UI resource is missing",
                        "severity": "error",
                    }
                )
        if component.entry in files:
            try:
                files[component.entry].decode("utf-8")
            except UnicodeError:
                issues.append(
                    {
                        "code": "ui_encoding_invalid",
                        "path": component.entry,
                        "message": "UI entry must be UTF-8",
                        "severity": "error",
                    }
                )
        if component.preview in files:
            try:
                scenario = ComponentScenario.model_validate(
                    json_object(files[component.preview], limit=MAX_PREVIEW_BYTES)
                )
                if set(scenario.responses) != {action.id for action in component.actions}:
                    raise ValueError("scenario responses must match declared actions")
                for case in scenario.cases:
                    if case.responses and not set(case.responses).issubset(scenario.responses):
                        raise ValueError("scenario case contains undeclared actions")
                validate_scenario(
                    scenario,
                    {entry.id for entry in descriptor.components},
                )
                for action_id, samples in scenario.submissions.items():
                    if not samples or len(samples) > MAX_DECLARATIONS:
                        raise ValueError("component_submission_samples_invalid")
                    for values in samples:
                        validate_component_submission(component.model_dump(), action_id, values)
                if not component.public:
                    for action in component.actions:
                        if (
                            action.capability == COMPONENT_ANSWER_CAPABILITY
                            and action.id not in scenario.submissions
                        ):
                            issues.append(
                                {
                                    "code": "component_submission_samples_missing",
                                    "path": component.preview,
                                    "message": f"No submission example for action {action.id}; runtime payload remains unverified",
                                    "severity": "warning",
                                }
                            )
                result["scenarios"][component.id] = scenario.model_dump(
                    mode="json", exclude_none=True, exclude_unset=True
                )
            except ComponentValidationError as error:
                issues.append(
                    {
                        "code": str(error),
                        "path": component.preview,
                        "detail": error.detail,
                        "message": "preview submission does not satisfy component schemas",
                        "severity": "error",
                    }
                )
            except (ValueError, UnicodeError, RecursionError):
                issues.append(
                    {
                        "code": "preview_invalid",
                        "path": component.preview,
                        "message": "preview data must be bounded, unique-key UTF-8 JSON object",
                        "severity": "error",
                    }
                )
    result["valid"] = not any(issue["severity"] == "error" for issue in issues)
    return result
