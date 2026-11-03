"""Product session permission policy shared by opening and reconfiguration."""

from __future__ import annotations

from pathlib import Path

from scholarseed_runtime.contract import PermissionIntent, RuntimePermissionMode
from service.paths import service_deny_read_roots

HARD_READ_DENIAL_MODES = frozenset({RuntimePermissionMode.READ_ONLY})


def session_permission(
    mode: RuntimePermissionMode,
    *,
    revision: str,
    writable_roots: tuple[Path, ...],
    local_socket: Path | None,
    network_domains: tuple[str, ...],
) -> PermissionIntent:
    return PermissionIntent(
        mode=mode,
        revision=revision,
        writable_roots=writable_roots,
        local_sockets=(local_socket,) if local_socket else (),
        network_domains=network_domains if mode is not RuntimePermissionMode.READ_ONLY else (),
        deny_read_roots=service_deny_read_roots() if mode in HARD_READ_DENIAL_MODES else (),
    )
