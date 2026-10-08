"""Product permission intent interpreted by an external runtime adapter."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Protocol, runtime_checkable

PERMISSION_MODE_KEY = "permission_mode"


class RuntimePermissionMode(str, Enum):
    ASK = "ask"
    SAFE_AUTO = "safe_auto"
    BYPASS = "bypassPermissions"
    READ_ONLY = "read_only"


class PermissionUpdateScope(str, Enum):
    TURN = "turn"
    NEXT_TURN = "next_turn"


@dataclass(frozen=True)
class PermissionIntent:
    mode: RuntimePermissionMode = RuntimePermissionMode.ASK
    revision: str = ""
    writable_roots: tuple[Path, ...] = ()
    local_sockets: tuple[Path, ...] = ()
    network_access: bool = False
    network_domains: tuple[str, ...] = ()
    #: Product-owned paths the runtime must not read. Neutral by construction: the
    #: product names them, the adapter decides whether its sandbox can enforce them.
    deny_read_roots: tuple[Path, ...] = ()


@runtime_checkable
class PermissionUpdatePreview(Protocol):
    def permission_update_scope(self, intent: PermissionIntent) -> PermissionUpdateScope: ...


__all__ = [
    "PERMISSION_MODE_KEY",
    "PermissionIntent",
    "PermissionUpdatePreview",
    "PermissionUpdateScope",
    "RuntimePermissionMode",
]
