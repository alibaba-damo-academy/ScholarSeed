"""Managed Codex discovery isolation for ScholarSeed App Server processes."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping

from scholarseed_codex.environment import CODEX_HOME_ENV, PRIVATE_DIRECTORY_MODE
from scholarseed_codex.protocol.session import CodexRuntimeLaunchArgument

CODEX_DISCOVERY_HOME_DIRNAME = "host"
XDG_CONFIG_DIRNAME = "xdg-config"
CLAUDE_CONFIG_DIRNAME = "claude"

HOME_ENV = "HOME"
USERPROFILE_ENV = "USERPROFILE"
XDG_CONFIG_HOME_ENV = "XDG_CONFIG_HOME"
CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR"

CONFIG_OPTION = "-c"
STRICT_CONFIG_OPTION = "--strict-config"

MANAGED_CONFIG_VALUES = (
    "project_root_markers=[]",
    "project_doc_max_bytes=0",
    "mcp_servers={}",
    "plugins={}",
    "marketplaces={}",
    "hooks={}",
    "features.skip_host_skill_discovery=true",
)


def managed_codex_launch(
    runtime_home: Path,
    process_environment: Mapping[str, str],
    launch_arguments: tuple[CodexRuntimeLaunchArgument, ...],
    *,
    inherited_environment: Mapping[str, str] | None = None,
) -> tuple[dict[str, str], tuple[CodexRuntimeLaunchArgument, ...]]:
    """Return a fail-closed App Server environment and highest-precedence config."""

    inherited = os.environ if inherited_environment is None else inherited_environment
    resolved_runtime_home = runtime_home.expanduser().resolve()
    discovery_home = resolved_runtime_home / CODEX_DISCOVERY_HOME_DIRNAME
    _prepare_directory(discovery_home)

    original_home = str(inherited.get(HOME_ENV, "") or Path.home()).strip()
    original_userprofile = str(inherited.get(USERPROFILE_ENV, "") or "").strip()
    original_xdg = str(inherited.get(XDG_CONFIG_HOME_ENV, "") or "").strip()
    original_claude = str(inherited.get(CLAUDE_CONFIG_DIR_ENV, "") or "").strip()

    environment = dict(process_environment)
    environment[CODEX_HOME_ENV] = str(resolved_runtime_home)
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
    try:
        path.chmod(PRIVATE_DIRECTORY_MODE)
    except OSError:
        pass


__all__ = [
    "CODEX_DISCOVERY_HOME_DIRNAME",
    "XDG_CONFIG_DIRNAME",
    "managed_codex_launch",
]
