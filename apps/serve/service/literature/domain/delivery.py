from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DELIVERY_CARD = "literature-delivery"
DELIVERY_VERSION = "1.0"
DELIVERY_ROUTE = "/api/sessions/{session_id}/literature/deliveries"
DELIVERY_ID_CHARS = 128
DELIVERY_PATH_CHARS = 4096
DELIVERY_TICKET_SECONDS = 1800
DELIVERY_ERROR_CHARS = 240
DELIVERY_NOT_FOUND = "literature_delivery_not_found"
DELIVERY_NOT_READY = "literature_delivery_not_ready"
DELIVERY_SOURCE_CHANGED = "literature_delivery_source_changed"
DELIVERY_TARGET_REQUIRED = "literature_delivery_target_required"
DELIVERY_TARGET_CHANGED = "literature_delivery_target_changed"
DELIVERY_BUSY = "literature_delivery_busy"
DELIVERY_TARGET_CONFLICT = "literature_delivery_target_conflict"
DELIVERY_COLLECTION_INVALID = "literature_delivery_collection_invalid"
FULLTEXT_BINDING_CONFLICT = "fulltext_binding_conflict"
FULLTEXT_BINDING_REQUIRED = "fulltext_binding_required"
FULLTEXT_BINDING_INTEGRITY_FAILED = "fulltext_binding_integrity_failed"
PDF_SUFFIX = ".pdf"
DELIVERY_DESTINATION_FIELDS = ("target", "project_id", "parent", "directory", "directory_identity")
DELIVERY_ADMISSION_FIELDS = ("add_to_library", "collection_id")


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


class DeliveryTarget(StrEnum):
    PROJECT = "project"
    DIRECTORY = "directory"


class DeliveryItemState(StrEnum):
    PENDING = "pending"
    SAVED = "saved"
    FAILED = "failed"
    SKIPPED = "skipped"


class DeliveryVersionChoice(StrEnum):
    KEEP_BOTH = "keep_both"
    SKIP = "skip"


class DeliveryChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    target: str
    project_id: str = Field(default="", max_length=DELIVERY_ID_CHARS)
    parent: str = Field(default="", max_length=DELIVERY_PATH_CHARS)
    ticket: str = Field(default="", max_length=DELIVERY_ID_CHARS)
    add_to_library: bool = False
    collection_id: str = Field(default="", max_length=DELIVERY_ID_CHARS)
    versions: dict[str, Literal["keep_both", "skip"]] = Field(default_factory=dict)


class DeliveryDirectory(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    absolute: str = Field(min_length=1, max_length=DELIVERY_PATH_CHARS)


class DeliveryCard(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: str = DELIVERY_VERSION
    session_id: str
    delivery_id: str
    project_id: str
    count: int = Field(ge=0)


def validate_delivery_card(value: object) -> dict:
    return DeliveryCard.model_validate(value).model_dump(mode="json")


def delivery_card_slot(value: Mapping) -> str:
    card = DeliveryCard.model_validate(value)
    return json.dumps([card.session_id, card.project_id, card.delivery_id])
