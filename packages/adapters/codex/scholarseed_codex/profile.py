"""Codex protocol identity and supported Runtime capabilities."""

from typing import Mapping

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeValue,
)

CODEX_DISPLAY_NAME = "Codex"
CODEX_PROTOCOL_VERSION = "2"
CODEX_PROTOCOL_SCHEMA_HASH = "f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2"
CODEX_MIN_SUPPORTED_VERSION = (0, 147, 0)
CODEX_MAX_TESTED_VERSION = (0, 147, 0)
CODEX_ALLOW_UNTESTED_NEWER = True
CODEX_DEVELOPMENT_VERSION = (0, 0, 0)
CODEX_ALLOW_DEVELOPMENT_VERSION_ENV = "DAMOAGENT_CODEX_ALLOW_DEVELOPMENT_VERSION"
CODEX_ENV_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
CODEX_RUNTIME_VERSION_RANGE = ">=" + ".".join(map(str, CODEX_MIN_SUPPORTED_VERSION))
if not CODEX_ALLOW_UNTESTED_NEWER:
    CODEX_RUNTIME_VERSION_RANGE += ",<=" + ".".join(map(str, CODEX_MAX_TESTED_VERSION))

CODEX_WEB_SEARCH_MODE_KEY = "web_search"
CODEX_WEB_SEARCH_LIVE_MODE = "live"
CODEX_PLAN_TOOL_ENABLED_CONFIG = "tools.update_plan.enabled"
CODEX_USER_INPUT_ENABLED_CONFIG = "features.default_mode_request_user_input"

_SUPPORTED_CAPABILITIES = frozenset(
    {
        RuntimeCapabilityName.STEER,
        RuntimeCapabilityName.RESUME,
        RuntimeCapabilityName.INTERRUPT,
        RuntimeCapabilityName.HUMAN_IN_THE_LOOP,
        RuntimeCapabilityName.TOOL_APPROVAL,
        RuntimeCapabilityName.TOOL_EVENTS,
        RuntimeCapabilityName.WEB_SEARCH,
        RuntimeCapabilityName.PLAN_SNAPSHOT,
        RuntimeCapabilityName.FILE_EVENTS,
        RuntimeCapabilityName.ARTIFACT_DECLARATIONS,
        RuntimeCapabilityName.TYPED_INPUT,
        RuntimeCapabilityName.LOCAL_IMAGES,
        RuntimeCapabilityName.FILE_INPUTS,
        RuntimeCapabilityName.SANDBOX,
        RuntimeCapabilityName.MODEL_INVENTORY,
        RuntimeCapabilityName.SKILL_INVENTORY,
        RuntimeCapabilityName.MCP_INVENTORY,
        RuntimeCapabilityName.COLLABORATION_MODES,
        RuntimeCapabilityName.SKILLS,
        RuntimeCapabilityName.SUBAGENT_LIFECYCLE,
        RuntimeCapabilityName.TERMINATE_SESSION,
        RuntimeCapabilityName.RESOURCE_ADMISSION,
    }
)


_SESSION_CAPABILITY_CONFIGS: Mapping[RuntimeCapabilityName, Mapping[str, RuntimeValue]] = {
    RuntimeCapabilityName.WEB_SEARCH: {
        CODEX_WEB_SEARCH_MODE_KEY: CODEX_WEB_SEARCH_LIVE_MODE,
    },
}
SESSION_SCOPED_CAPABILITIES = frozenset(_SESSION_CAPABILITY_CONFIGS)


def capabilities(
    enabled_session_capabilities: frozenset[RuntimeCapabilityName] | None = None,
) -> CapabilitySet:
    enabled = (
        SESSION_SCOPED_CAPABILITIES
        if enabled_session_capabilities is None
        else enabled_session_capabilities
    )
    supported = (_SUPPORTED_CAPABILITIES - SESSION_SCOPED_CAPABILITIES) | enabled
    return CapabilitySet(
        tuple(
            RuntimeCapability(
                name.value,
                (
                    CapabilityState.SUPPORTED
                    if name in supported
                    else (
                        CapabilityState.DEGRADED
                        if name
                        in {RuntimeCapabilityName.SUBAGENT_CONTENT, RuntimeCapabilityName.SUSPEND}
                        else CapabilityState.UNSUPPORTED
                    )
                ),
                (
                    "upstream exposes lifecycle and recent activity, not a complete child transcript"
                    if name is RuntimeCapabilityName.SUBAGENT_CONTENT
                    else (
                        "safe suspension requires complete native activity queries"
                        if name is RuntimeCapabilityName.SUSPEND
                        else ""
                    )
                ),
            )
            for name in RuntimeCapabilityName
        )
    )


def required_capabilities(
    values: tuple[RuntimeCapabilityName, ...],
) -> frozenset[RuntimeCapabilityName]:
    required = frozenset(values)
    if len(required) != len(values):
        raise ValueError("required runtime capabilities must be unique")
    unsupported = required - _SUPPORTED_CAPABILITIES
    if unsupported:
        names = ", ".join(sorted(item.value for item in unsupported))
        raise ValueError(f"required runtime capabilities are unsupported: {names}")
    return required


def session_thread_config(
    capabilities: frozenset[RuntimeCapabilityName],
) -> dict[str, RuntimeValue]:
    config: dict[str, RuntimeValue] = {
        CODEX_PLAN_TOOL_ENABLED_CONFIG: True,
        CODEX_USER_INPUT_ENABLED_CONFIG: True,
    }
    for capability in sorted(capabilities, key=lambda item: item.value):
        contribution = _SESSION_CAPABILITY_CONFIGS.get(capability, {})
        for key, value in contribution.items():
            if key in config and config[key] != value:
                raise ValueError(f"conflicting runtime capability config: {key}")
            config[key] = value
    return config


def resumed_capabilities(binding: RuntimeBinding) -> tuple[RuntimeCapabilityName, ...]:
    supported = {
        item.name
        for item in binding.capabilities.entries
        if item.state is CapabilityState.SUPPORTED
    }
    return tuple(
        capability
        for capability in sorted(SESSION_SCOPED_CAPABILITIES, key=lambda item: item.value)
        if capability.value in supported
    )
