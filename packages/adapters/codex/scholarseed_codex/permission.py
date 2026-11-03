"""Codex-native permission profile construction."""

from __future__ import annotations

import json
import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scholarseed_codex.protocol.session import (
    CodexApprovalReviewer,
    CodexRuntimeLaunchArgument,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import CODEX_DEFAULT_SANDBOX_MODE, CODEX_SANDBOX_MODES
from scholarseed_runtime.contract import RuntimePermissionMode, RuntimeValue

DANGER_FULL_ACCESS_SANDBOX = "danger-full-access"
THREAD_SETTINGS_UPDATE_METHOD = "thread/settings/update"
TURN_SETTINGS_UPDATE_METHOD = "turn/settings/update"
THREAD_SETTINGS_UPDATED_METHOD = "thread/settings/updated"
PERMISSION_SCOPE_TURN = "turn"
PERMISSION_SCOPE_SESSION = "session"
PERMISSION_SCOPE_NEXT_TURN = "next_turn"
TURN_SETTINGS_APPLIED = "applied"
TURN_SETTINGS_UNAVAILABLE = "targetUnavailable"
PERMISSION_SETTINGS_UNCONFIRMED = "codex_permission_settings_unconfirmed"


@dataclass(frozen=True)
class PermissionUpdate:
    scope: str
    safe_error: str = ""
    turn_id: str = ""


@dataclass(frozen=True)
class CodexPermissionPolicy:
    sandbox: str
    approval_policy: str
    approval_reviewer: CodexApprovalReviewer | None


def reviewer_only_update(
    previous: CodexSessionOpenRequest, requested: CodexSessionOpenRequest
) -> bool:
    return (
        previous.sandbox == requested.sandbox
        and previous.approval_policy == requested.approval_policy
        and previous.permissions_profile == requested.permissions_profile
        and previous.network_access == requested.network_access
        and previous.writable_roots == requested.writable_roots
        and requested.approval_reviewer is not None
    )


CODEX_PERMISSION_POLICIES = {
    RuntimePermissionMode.ASK: CodexPermissionPolicy(
        "workspace-write",
        "on-request",
        CodexApprovalReviewer.USER,
    ),
    RuntimePermissionMode.SAFE_AUTO: CodexPermissionPolicy(
        "workspace-write",
        "on-request",
        CodexApprovalReviewer.AUTO_REVIEW,
    ),
    RuntimePermissionMode.BYPASS: CodexPermissionPolicy(
        DANGER_FULL_ACCESS_SANDBOX,
        "never",
        None,
    ),
    RuntimePermissionMode.READ_ONLY: CodexPermissionPolicy("read-only", "never", None),
}


LOCAL_PERMISSION_PROFILE = "local-services"
LOCAL_PERMISSION_PARENTS = {"workspace-write": ":workspace", "read-only": ":read-only"}
CONFIG_OPTION = "-c"
STRICT_CONFIG_OPTION = "--strict-config"
DARWIN_PLATFORM = "darwin"
WINDOWS_PLATFORM = "win32"
WINDOWS_NETWORK_PROXY_CONFIG = ("features.network_proxy.enable_socks5_udp=false",)
FILESYSTEM_DENY = "deny"
NETWORK_DOMAIN_PATTERN = re.compile(
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+"
)


def local_socket_permissions(
    sandbox: str,
    sockets: tuple[Path, ...],
    *,
    network_access: bool = False,
    network_domains: tuple[str, ...] = (),
    deny_read_roots: tuple[Path, ...] = (),
) -> tuple[str, tuple[CodexRuntimeLaunchArgument, ...]]:
    """Project local sockets, exact domains and read denials into a native profile."""

    # Denials ride on the sandboxed profile, so they exist only where the sandbox does:
    # danger-full-access runs unsandboxed, and on platforms whose sandbox refuses a
    # filesystem table (Windows fails closed) the roots are dropped rather than faked —
    # and a profile holding nothing but unenforceable denials is not created at all.
    enforced_denials = deny_read_roots if sys.platform == DARWIN_PLATFORM else ()
    if (not sockets and not network_domains and not enforced_denials) or sandbox == (
        DANGER_FULL_ACCESS_SANDBOX
    ):
        return "", ()
    parent = LOCAL_PERMISSION_PARENTS[sandbox]
    if any(not path.is_absolute() or not path.is_socket() for path in sockets):
        raise ValueError("local service grants require existing absolute Unix sockets")
    if any(NETWORK_DOMAIN_PATTERN.fullmatch(domain) is None for domain in network_domains):
        raise ValueError("network domain grants require exact lowercase hostnames")
    if any(not path.is_absolute() for path in deny_read_roots):
        raise ValueError("read denials require absolute paths")
    allowed = ", ".join(f'{json.dumps(str(path.resolve()))} = "allow"' for path in sockets)
    profile = LOCAL_PERMISSION_PROFILE
    domains = ("*",) if network_access else tuple(sorted(set(network_domains)))
    domain_rules = ", ".join(f'{json.dumps(domain)} = "allow"' for domain in domains)
    network_values = (
        (
            f'permissions.{profile}.network.mode="full"',
            f"permissions.{profile}.network.domains={{ {domain_rules} }}",
        )
        if domains
        else ()
    )
    # A denial is keyed by path and evaluated on access, so roots that do not exist yet
    # (a fresh database, its WAL sidecar, an empty managed store) are still enforced.
    denied = ", ".join(
        f'{json.dumps(str(path.resolve()))} = "{FILESYSTEM_DENY}"'
        for path in sorted(set(enforced_denials))
    )
    filesystem_values = (f"permissions.{profile}.filesystem={{ {denied} }}",) if denied else ()
    values = (
        f"default_permissions={json.dumps(profile)}",
        "features.network_proxy.enabled=true",
        "features.network_proxy.domains={}",
        "features.network_proxy.allow_local_binding=false",
        "features.network_proxy.dangerously_allow_all_unix_sockets=false",
        *(WINDOWS_NETWORK_PROXY_CONFIG if sys.platform == WINDOWS_PLATFORM else ()),
        f"permissions.{profile}.extends={json.dumps(parent)}",
        f"permissions.{profile}.network.enabled=true",
        *network_values,
        f"permissions.{profile}.network.unix_sockets={{ {allowed} }}",
        *filesystem_values,
    )
    return profile, (
        CodexRuntimeLaunchArgument(option=STRICT_CONFIG_OPTION),
        *(CodexRuntimeLaunchArgument(option=CONFIG_OPTION, value=value) for value in values),
    )


def thread_permission_config(
    sandbox: str,
    sockets: tuple[Path, ...],
    *,
    network_access: bool = False,
    network_domains: tuple[str, ...] = (),
    deny_read_roots: tuple[Path, ...] = (),
) -> tuple[str, dict[str, RuntimeValue]]:
    profile, arguments = local_socket_permissions(
        sandbox,
        sockets,
        network_access=network_access,
        network_domains=network_domains,
        deny_read_roots=deny_read_roots,
    )
    values: dict[str, RuntimeValue] = {}
    definition: dict[str, Any] = {}
    prefix = f"permissions.{profile}."
    for argument in arguments:
        if argument.option != CONFIG_OPTION:
            continue
        name, _, literal = argument.value.partition("=")
        value = tomllib.loads(f"value={literal}")["value"]
        if name.startswith(prefix):
            parts = name.removeprefix(prefix).split(".")
            target = definition
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = value
        else:
            values[name] = value
    if profile:
        values[f"permissions.{profile}"] = definition
    return profile, values


def sandbox_policy(
    request: CodexSessionOpenRequest,
    writable_roots: tuple[str, ...] = (),
) -> dict[str, Any]:
    """App Server 的 `sandboxPolicy`。

    `writableRoots` = cwd + 调用方给的额外授权根。额外根由产品侧显式授权
    并可撤销, 因此这里不做任何补齐或猜测: 传进来什么就是什么。
    `read-only` 与 `danger-full-access` 两个分支不涉及可写根。
    """

    sandbox = request.sandbox or CODEX_DEFAULT_SANDBOX_MODE
    if sandbox not in CODEX_SANDBOX_MODES:
        raise ValueError(f"unsupported Codex sandbox {sandbox!r}; expected {CODEX_SANDBOX_MODES}")
    if sandbox == "read-only":
        return {"type": "readOnly", "networkAccess": False}
    if sandbox == DANGER_FULL_ACCESS_SANDBOX:
        return {"type": "dangerFullAccess"}
    cwd = str(request.cwd.expanduser().resolve())
    roots = [cwd, *(root for root in sorted(set(writable_roots)) if root != cwd)]
    return {
        "type": "workspaceWrite",
        "writableRoots": roots,
        "networkAccess": request.network_access,
    }
