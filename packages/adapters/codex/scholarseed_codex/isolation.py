"""Managed Codex discovery isolation for ScholarSeed App Server processes."""

from __future__ import annotations

import json
import os
import re
import tomllib
from pathlib import Path
from typing import Mapping

from scholarseed_codex.environment import (
    CODEX_DISCOVERY_HOME_DIRNAME,
    CODEX_HOME_ENV,
    CODEX_SQLITE_HOME_ENV,
    ENVIRONMENT_NAME_CASE_INSENSITIVE,
    PRIVATE_DIRECTORY_MODE,
    runtime_sqlite_home,
)
from scholarseed_codex.launcher import MCP_SECRET_ENVIRONMENT_PREFIX
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument
from scholarseed_runtime.contract import RuntimeValue

XDG_CONFIG_DIRNAME = "xdg-config"
CLAUDE_CONFIG_DIRNAME = "claude"

HOME_ENV = "HOME"
USERPROFILE_ENV = "USERPROFILE"
XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME"
CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"
CODEX_REMOTE_CONTROL_DISABLED_ENV = "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED"
CODEX_REMOTE_CONTROL_DISABLED_VALUE = "1"

CONFIG_OPTION = "-c"
CONFIG_LONG_OPTION = "--config"
MCP_DISABLED_OVERRIDE = "mcp_servers={}"
MCP_CONFIG_TABLE = "mcp_servers"
MCP_PROJECTED_OVERRIDE_INVALID = "mcp_projected_override_invalid"
STRICT_CONFIG_OPTION = "--strict-config"
SHELL_ENVIRONMENT_POLICY_CONFIG = "shell_environment_policy"
SHELL_ENVIRONMENT_INHERIT = "inherit"
SHELL_ENVIRONMENT_SET = "set"
SHELL_ENVIRONMENT_CORE = "core"
MCP_TOOL_ENVIRONMENT_FORBIDDEN = "mcp_tool_environment_forbidden"
TOOL_ENVIRONMENT_INVALID = "tool_environment_invalid"
TOOL_ENVIRONMENT_CONFLICT = "tool_environment_conflict"
ENVIRONMENT_NAME_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MANAGED_SHELL_HOME_ENVIRONMENT = frozenset(
    {HOME_ENV, USERPROFILE_ENV, XDG_CONFIG_HOME_ENV, CLAUDE_CONFIG_DIR_ENV}
)

MANAGED_CONFIG_VALUES = (
    "project_root_markers=[]",
    "project_doc_max_bytes=0",
    MCP_DISABLED_OVERRIDE,
    # Empty maps do not disable the built-in curated marketplace startup sync.
    "features.plugins=false",
    "plugins={}",
    "marketplaces={}",
    "hooks={}",
)


def projected_mcp_arguments(arguments: tuple[str, ...]) -> tuple[str, ...]:
    result: list[str] = []
    index = 0
    removed = False
    while index < len(arguments):
        option = arguments[index]
        if option not in (CONFIG_OPTION, CONFIG_LONG_OPTION):
            if option.startswith(CONFIG_OPTION) or option.startswith(CONFIG_LONG_OPTION):
                raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID)
            result.append(option)
            index += 1
            continue
        if index + 1 >= len(arguments):
            raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID)
        value = arguments[index + 1]
        key, separator, _value = value.partition("=")
        if not separator:
            raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID)
        try:
            configuration = tomllib.loads(f"{key}=false")
        except tomllib.TOMLDecodeError:
            raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID) from None
        if MCP_CONFIG_TABLE in configuration:
            if value != MCP_DISABLED_OVERRIDE or removed:
                raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID)
            removed = True
        else:
            result.extend((option, value))
        index += 2
    if not removed or STRICT_CONFIG_OPTION not in result:
        raise ValueError(MCP_PROJECTED_OVERRIDE_INVALID)
    return tuple(result)


def managed_shell_environment(
    tool_environment: Mapping[str, str],
    *,
    execution_environment: Mapping[str, str] | None = None,
) -> dict[str, RuntimeValue]:
    ordinary = dict(execution_environment or {})
    normalize = str.upper if ENVIRONMENT_NAME_CASE_INSENSITIVE else str
    ordinary_names = {normalize(name) for name in ordinary}
    secret_names = {normalize(name) for name in tool_environment}
    if (
        len(ordinary_names) != len(ordinary)
        or len(secret_names) != len(tool_environment)
        or ordinary_names & secret_names
        or ordinary_names & MANAGED_SHELL_HOME_ENVIRONMENT
    ):
        raise ValueError(TOOL_ENVIRONMENT_CONFLICT)
    environment = {**ordinary, **tool_environment}
    if any(
        not ENVIRONMENT_NAME_PATTERN.fullmatch(name) or not isinstance(value, str)
        for name, value in environment.items()
    ):
        raise ValueError(TOOL_ENVIRONMENT_INVALID)
    if any(
        name.casefold().startswith(MCP_SECRET_ENVIRONMENT_PREFIX.casefold()) for name in environment
    ):
        raise ValueError(MCP_TOOL_ENVIRONMENT_FORBIDDEN)
    policy: dict[str, RuntimeValue] = {
        f"{SHELL_ENVIRONMENT_POLICY_CONFIG}.{SHELL_ENVIRONMENT_SET}.{name}": value
        for name, value in environment.items()
    }
    if tool_environment:
        policy[f"{SHELL_ENVIRONMENT_POLICY_CONFIG}.{SHELL_ENVIRONMENT_INHERIT}"] = (
            SHELL_ENVIRONMENT_CORE
        )
    return policy


def managed_codex_launch(
    runtime_home: Path,
    process_environment: Mapping[str, str],
    launch_arguments: tuple[CodexRuntimeLaunchArgument, ...],
    *,
    inherited_environment: Mapping[str, str] | None = None,
) -> tuple[dict[str, str], tuple[CodexRuntimeLaunchArgument, ...]]:
    """Return a fail-closed App Server environment and highest-precedence config."""

    inherited = os.environ if inherited_environment is None else inherited_environment
    sqlite_home = runtime_sqlite_home(inherited)
    requested_sqlite_home = runtime_sqlite_home({**inherited, **process_environment})
    if requested_sqlite_home != sqlite_home:
        raise ValueError("managed Codex cannot override its declared SQLite storage root")
    resolved_runtime_home = runtime_home.expanduser().resolve()
    discovery_home = resolved_runtime_home / CODEX_DISCOVERY_HOME_DIRNAME
    _prepare_directory(discovery_home)

    original_home = str(inherited.get(HOME_ENV, "") or Path.home()).strip()
    original_userprofile = str(inherited.get(USERPROFILE_ENV, "") or "").strip()
    original_xdg = str(inherited.get(XDG_CONFIG_HOME_ENV, "") or "").strip()
    original_claude = str(inherited.get(CLAUDE_CONFIG_DIR_ENV, "") or "").strip()

    environment = dict(process_environment)
    if ENVIRONMENT_NAME_CASE_INSENSITIVE:
        environment = {
            name: value
            for name, value in environment.items()
            if name.casefold() != CODEX_SQLITE_HOME_ENV.casefold()
        }
    environment[CODEX_HOME_ENV] = str(resolved_runtime_home)
    # Explicitly project absence too: the eventual child environment is merged
    # with os.environ again, after declaration and process-pool preparation.
    environment[CODEX_SQLITE_HOME_ENV] = str(sqlite_home) if sqlite_home is not None else ""
    environment[CODEX_REMOTE_CONTROL_DISABLED_ENV] = CODEX_REMOTE_CONTROL_DISABLED_VALUE
    environment[HOME_ENV] = str(discovery_home)
    if original_userprofile or os.name == "nt":
        environment[USERPROFILE_ENV] = str(discovery_home)
    if original_xdg:
        isolated_xdg = discovery_home / XDG_CONFIG_DIRNAME
        _prepare_directory(isolated_xdg)
        environment[XDG_CONFIG_HOME_ENV] = str(isolated_xdg)
    if original_claude:
        isolated_claude = discovery_home / CLAUDE_CONFIG_DIRNAME
        _prepare_directory(isolated_claude)
        environment[CLAUDE_CONFIG_DIR_ENV] = str(isolated_claude)

    arguments = tuple(
        argument for argument in launch_arguments if argument.option.strip() != STRICT_CONFIG_OPTION
    )
    managed = (
        CodexRuntimeLaunchArgument(option=STRICT_CONFIG_OPTION),
        *(
            CodexRuntimeLaunchArgument(option=CONFIG_OPTION, value=value)
            for value in MANAGED_CONFIG_VALUES
        ),
        _shell_environment_argument(HOME_ENV, original_home),
        *(
            (_shell_environment_argument(USERPROFILE_ENV, original_userprofile),)
            if original_userprofile
            else ()
        ),
        *(
            (_shell_environment_argument(XDG_CONFIG_HOME_ENV, original_xdg),)
            if original_xdg
            else ()
        ),
        *(
            (_shell_environment_argument(CLAUDE_CONFIG_DIR_ENV, original_claude),)
            if original_claude
            else ()
        ),
    )
    return environment, (*arguments, *managed)


def _shell_environment_argument(name: str, value: str) -> CodexRuntimeLaunchArgument:
    return CodexRuntimeLaunchArgument(
        option=CONFIG_OPTION,
        value=f"shell_environment_policy.set.{name}={json.dumps(value)}",
    )


def _prepare_directory(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)


__all__ = [
    "CODEX_DISCOVERY_HOME_DIRNAME",
    "XDG_CONFIG_DIRNAME",
    "managed_codex_launch",
]
