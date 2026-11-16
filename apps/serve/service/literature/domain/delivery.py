from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum

FULLTEXT_BINDING_CONFLICT = "fulltext_binding_conflict"
FULLTEXT_BINDING_REQUIRED = "fulltext_binding_required"
FULLTEXT_BINDING_INTEGRITY_FAILED = "fulltext_binding_integrity_failed"
PDF_SUFFIX = ".pdf"


@dataclass(frozen=True)
class AcquisitionScope:
    session_id: str
    project_id: str
    run: str
    authorizations: Mapping[str, str] = field(default_factory=dict)


class DeliveryState(StrEnum):
    ACQUIRING = "acquiring"
    PENDING = "pending"
    SAVING = "saving"
    SAVED = "saved"
    PARTIAL = "partial"
    CANCELED = "canceled"


class DeliveryItemState(StrEnum):
    PENDING = "pending"
    SAVED = "saved"
    FAILED = "failed"
    SKIPPED = "skipped"
