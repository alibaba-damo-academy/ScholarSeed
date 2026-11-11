"""Provider-owned persistent directory declarations, without filesystem IO."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable


class StorageInspection(Protocol):
    """Host-qualified, bounded reads for provider root discovery only."""

    def selected(self, root: str) -> bool: ...

    def read(self, root: str, name: str, max_bytes: int) -> bytes | None: ...


class RuntimeConfigurationStorage(Protocol):
    """Edit only host-authorized files under a physical storage lease.

    The transform is synchronous and receives a stable, bounded byte snapshot.
    Absence is None, distinct from empty content. Publication rejects observed
    identity/content changes and never follows the destination leaf on write.
    The returned digest identifies the published bytes, not runtime readiness.
    Implementations retain storage ownership through publication and cleanup.
    """

    def update(self, path: Path, transform: Callable[[bytes | None], bytes]) -> str: ...


@dataclass(frozen=True)
class RuntimeConfigurationPartition:
    path: Path
    storage: RuntimeConfigurationStorage


@runtime_checkable
class RuntimeConfigurationPartitioning(Protocol):
    """Allocate a fresh private child with an exact grant for the declared file.

    Allocation never copies parent configuration or credentials. The host owns
    directory creation and its lease; no caller-selected child path is accepted.
    """

    def partition(self, path: Path) -> RuntimeConfigurationPartition: ...


@runtime_checkable
class RuntimeConfigurationOwner(Protocol):
    """Optional read-only declarations; files must be children of owned roots."""

    def configuration_files(self) -> tuple[Path, ...]: ...


@dataclass(frozen=True)
class StorageRoot:
    """Declare a directory and whether the host may prepare missing structure.

    Creation permission covers directories only. It neither authorizes reading
    or writing stored data nor proves its compatibility with this provider.
    Existing directories must not have their ownership or permissions rewritten.
    False means a missing directory must be reported, never recreated.
    """

    path: Path
    create: bool


@dataclass(frozen=True)
class StorageSource:
    """Identity of a qualified read; absence differs from an empty file."""

    root: str
    name: str
    digest: str | None
    size: int


@dataclass(frozen=True)
class StorageInventory:
    """A discovery observation, never a data-format or activation approval."""

    roots: tuple[StorageRoot, ...]
    sources: tuple[StorageSource, ...]


__all__ = [
    "RuntimeConfigurationPartition",
    "RuntimeConfigurationPartitioning",
    "RuntimeConfigurationOwner",
    "RuntimeConfigurationStorage",
    "StorageInspection",
    "StorageInventory",
    "StorageRoot",
    "StorageSource",
]
