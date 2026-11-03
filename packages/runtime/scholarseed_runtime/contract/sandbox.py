"""Host-owned dynamic directory metadata, independent of installed tool admission."""

from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

SANDBOX_SETUP_ERROR = "windows_sandbox_setup_failed"
SANDBOX_PREPARING_ERROR = "windows_sandbox_setup_in_progress"
SANDBOX_UNKNOWN_ERROR = "windows_sandbox_setup_unknown"
SANDBOX_POLICY_ERROR = "windows_sandbox_policy_rejected"
SANDBOX_CANCELLED_ERROR = "windows_sandbox_setup_cancelled"
SANDBOX_RESOURCE_ERROR = "windows_sandbox_tool_access_failed"
SANDBOX_PROBE_ERROR = "windows_sandbox_tool_probe_failed"
SANDBOX_STARTUP_ERRORS = frozenset(
    {
        SANDBOX_SETUP_ERROR,
        SANDBOX_PREPARING_ERROR,
        SANDBOX_UNKNOWN_ERROR,
        SANDBOX_RESOURCE_ERROR,
        SANDBOX_PROBE_ERROR,
        SANDBOX_POLICY_ERROR,
        SANDBOX_CANCELLED_ERROR,
    }
)


class SandboxRecoveryError(PermissionError):
    """Bounded host failure category; raw native details remain in host diagnostics."""

    def __init__(self, safe_error: str = SANDBOX_SETUP_ERROR) -> None:
        self.safe_error = (
            safe_error if safe_error in SANDBOX_STARTUP_ERRORS else SANDBOX_SETUP_ERROR
        )
        super().__init__(self.safe_error)


class SandboxRecovery(Protocol):
    async def prepare(self, home: Path, version: str, executable: Path) -> None:
        """Prepare reviewed private storage without weakening its access policy.

        The host authenticates the original user and directory independently.
        Elevation, if needed, is bounded to that operation. Cancellation must
        wait for the native operation to finish before releasing its lease.
        """
        ...


@dataclass(frozen=True)
class SandboxProbe:
    """Fixed host-owned command; no grant or installation receipt semantics."""

    kind: str
    command: tuple[str, ...]
    environment: tuple[tuple[str, str], ...] = ()
    expected: tuple[tuple[str, str], ...] = ()
    path_root: str = ""
    artifact: Path | None = None


class SandboxResources(Protocol):
    async def prepare(self, local_group: str, *, cwd: Path) -> None:
        """Prepare container/workspace metadata; never scan or grant fixed tool trees.

        cwd is the current execution directory, not a grant of read/write access.
        Changes may persist across sessions. Implementations must preserve other
        permissions and finish native work before propagating cancellation.
        Fixed assets must already be admitted by the installation owner. Missing
        or changed admission cannot fall back to a session-time tree scan.
        """
        ...

    def verification(
        self, cwd: Path, *, writable: bool
    ) -> AbstractAsyncContextManager[tuple[SandboxProbe, ...]]:
        """Bind fixed execution probes and any output to already-authorized roots."""
        ...

    async def validate_probe(self, probe: SandboxProbe, result: Mapping[str, Any]) -> None:
        """Validate bounded output and artifacts; never change ACLs or grant rights."""
        ...
