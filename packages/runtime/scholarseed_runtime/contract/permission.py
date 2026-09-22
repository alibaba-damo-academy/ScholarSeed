"""Product permission intent interpreted by an external runtime adapter."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class RuntimePermissionMode(str, Enum):
    ASK = "ask"
    SAFE_AUTO = "safe_auto"
    BYPASS = "bypassPermissions"
    READ_ONLY = "read_only"


@dataclass(frozen=True)
class PermissionIntent:
    mode: RuntimePermissionMode = RuntimePermissionMode.ASK
    revision: str = ""
    writable_roots: tuple[Path, ...] = ()
    local_sockets: tuple[Path, ...] = ()
    network_access: bool = False


__all__ = ["PermissionIntent", "RuntimePermissionMode"]
