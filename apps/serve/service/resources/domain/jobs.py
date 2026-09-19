"""Persistent local resource-import job contracts."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from service.platform.content import ImportMode


class ImportJobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ImportJobPhase(str, Enum):
    QUEUED = "queued"
    SCANNING = "scanning"
    COPYING = "copying"
    LINKING = "linking"
    VERSIONING = "versioning"
    COMPLETED = "completed"


class ImportSourceStatus(str, Enum):
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class VersionInitializationProgress:
    """Observable progress for discovery and initialization inside versioning."""

    discovered_items: int
    completed_items: int
    total_items: int


@dataclass(frozen=True)
class ImportSourceResult:
    source_index: int
    status: ImportSourceStatus
    error: str
    target_path: str


TERMINAL_IMPORT_STATUSES = frozenset(
    {
        ImportJobStatus.COMPLETED,
        ImportJobStatus.PARTIAL,
        ImportJobStatus.FAILED,
        ImportJobStatus.CANCELLED,
    }
)


@dataclass(frozen=True)
class ImportJob:
    job_id: str
    owner_id: str
    project_id: str
    mode: ImportMode
    target_dir: str
    sources: tuple[str, ...]
    source_results: tuple[ImportSourceResult, ...]
    status: ImportJobStatus
    phase: ImportJobPhase
    scan_discovered_items: int
    completed_items: int
    total_items: int
    completed_bytes: int
    total_bytes: int
    version_discovered_items: int
    version_completed_items: int
    version_total_items: int
    cancel_requested: bool
    error: str
    created_at: float
    updated_at: float
    lease_generation: int
    event_seq: int


@dataclass(frozen=True)
class ImportJobEvent:
    seq: int
    job_id: str
    event_type: str
    data: dict[str, object]
    created_at: float


__all__ = [
    "ImportJob",
    "ImportJobEvent",
    "ImportJobPhase",
    "ImportJobStatus",
    "ImportSourceResult",
    "ImportSourceStatus",
    "TERMINAL_IMPORT_STATUSES",
    "VersionInitializationProgress",
]
