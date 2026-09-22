"""Codex-native permission profile construction."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scholarseed_codex.protocol.session import (
    CodexApprovalReviewer,
    CodexRuntimeLaunchArgument,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import CODEX_DEFAULT_SANDBOX_MODE, CODEX_SANDBOX_MODES
from scholarseed_runtime.contract import RuntimePermissionMode


@dataclass(frozen=True)
class CodexPermissionPolicy:
    sandbox: str
    approval_policy: str
    approval_reviewer: CodexApprovalReviewer | None


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
        "danger-full-access",
        "never",
        None,
    ),
    RuntimePermissionMode.READ_ONLY: CodexPermissionPolicy("read-only", "never", None),
}


LOCAL_PERMISSION_PROFILE = "local-services"
LOCAL_PERMISSION_PARENTS = {"workspace-write": ":workspace", "read-only": ":read-only"}
CONFIG_OPTION = "-c"
STRICT_CONFIG_OPTION = "--strict-config"


def local_socket_permissions(
    sandbox: str, sockets: tuple[Path, ...], *, network_access: bool = False
) -> tuple[str, tuple[CodexRuntimeLaunchArgument, ...]]:
    """Project explicit local-service grants into a deny-by-default native profile."""

    if not sockets or sandbox == "danger-full-access":
        return "", ()
    parent = LOCAL_PERMISSION_PARENTS[sandbox]
    if any(not path.is_absolute() or not path.is_socket() for path in sockets):
        raise ValueError("local service grants require existing absolute Unix sockets")
    allowed = ", ".join(f'{json.dumps(str(path.resolve()))} = "allow"' for path in sockets)
    profile = LOCAL_PERMISSION_PROFILE
    network_values = (
        (
            f'permissions.{profile}.network.mode="full"',
            f'permissions.{profile}.network.domains={{ "*" = "allow" }}',
        )
        if network_access
        else ()
    )
    values = (
        f"default_permissions={json.dumps(profile)}",
        "features.network_proxy.enabled=true",
        "features.network_proxy.domains={}",
        "features.network_proxy.allow_local_binding=false",
        "features.network_proxy.dangerously_allow_all_unix_sockets=false",
        f"permissions.{profile}.extends={json.dumps(parent)}",
        f"permissions.{profile}.network.enabled=true",
        *network_values,
        f"permissions.{profile}.network.unix_sockets={{ {allowed} }}",
    )
    return profile, (
        CodexRuntimeLaunchArgument(option=STRICT_CONFIG_OPTION),
        *(CodexRuntimeLaunchArgument(option=CONFIG_OPTION, value=value) for value in values),
    )


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
    if sandbox == "danger-full-access":
        return {"type": "dangerFullAccess"}
    cwd = str(request.cwd.expanduser().resolve())
    roots = [cwd, *(root for root in sorted(set(writable_roots)) if root != cwd)]
    return {
        "type": "workspaceWrite",
        "writableRoots": roots,
        "networkAccess": request.network_access,
    }
