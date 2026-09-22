"""Contracts for direct AI actions over version-bound Workbench selections."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol, runtime_checkable

from service.platform.inference import ModelInvocationStatus

CALC_LOCATOR_KIND = "calc"
CALC_REFERENCE_CONTENT_STATUS = "not_inlined"
CALC_REFERENCE_RESOLVED_STATUS = "resolved"
CALC_REFERENCE_KIND = "spreadsheet_range"
REFERENCE_CONTENT_MODE = "reference"
REFERENCE_CONTENT_MODE_KEY = "content_mode"


def is_calc_reference(locator: Mapping[str, Any]) -> bool:
    """Return whether a selection is a metadata-only spreadsheet range reference."""

    return (
        locator.get("kind") == CALC_LOCATOR_KIND
        and locator.get(REFERENCE_CONTENT_MODE_KEY) == REFERENCE_CONTENT_MODE
    )


def calc_reference_descriptor(
    source_id: str,
    sheet: str,
    selected_range: str,
    *,
    content_status: str = CALC_REFERENCE_CONTENT_STATUS,
) -> dict[str, str]:
    """Build the model-facing description of a spreadsheet selection."""

    return {
        "kind": CALC_REFERENCE_KIND,
        "source": source_id,
        "sheet": sheet,
        "range": selected_range,
        "content_status": content_status,
    }


class SelectionActionKind(str, Enum):
    """Direct actions supported by the Workbench selection surface."""

    INTERPRET = "interpret"
    TRANSLATE = "translate"
    POLISH = "polish"


class SelectionEvidenceMode(str, Enum):
    """Whether action evidence came from persisted bytes or an unsaved editor draft."""

    PERSISTED = "persisted"
    DRAFT = "draft"
    REFERENCE = "reference"


@dataclass(frozen=True)
class SelectionEvidenceReference:
    """Client-carried locator for evidence that must be re-verified server-side."""

    project_id: str
    source_id: str
    source_revision: str
    locator_kind: str
    selected_text_hash: str
    locator: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class SelectionDraftEvidence:
    """Explicit transient editor evidence bound to one persisted baseline revision."""

    change_version: int
    selected_text: str
    context_text: str
    selected_text_hash: str


@dataclass(frozen=True)
class VerifiedSelectionEvidence:
    """Evidence resolved from the authoritative source at an exact revision."""

    reference: SelectionEvidenceReference
    selected_text: str
    context_text: str
    evidence_revision: str
    mode: SelectionEvidenceMode = SelectionEvidenceMode.PERSISTED
    change_version: int | None = None
    can_edit: bool = False


class SelectionEvidenceError(RuntimeError):
    """Stable evidence-resolution failure safe to project through the API."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code


@runtime_checkable
class SelectionEvidenceProvider(Protocol):
    """Resolves a locator against its authoritative, versioned document source."""

    def resolve_action(
        self,
        reference: SelectionEvidenceReference,
        draft: SelectionDraftEvidence | None = None,
    ) -> VerifiedSelectionEvidence: ...


@dataclass(frozen=True)
class SelectionActionInput:
    """Validated action command after transport decoding."""

    action: SelectionActionKind
    selection: SelectionEvidenceReference
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None = None
    question: str = ""
    target_language: str = ""
    owner_id: str = ""
    draft: SelectionDraftEvidence | None = None


@dataclass(frozen=True)
class SelectionActionEvidence:
    """Safe evidence identity returned to the renderer for provenance."""

    project_id: str
    source_id: str
    source_revision: str
    evidence_revision: str
    locator_kind: str
    selected_text_hash: str
    locator: Mapping[str, Any] = field(default_factory=dict)
    mode: SelectionEvidenceMode = SelectionEvidenceMode.PERSISTED
    change_version: int | None = None


@dataclass(frozen=True)
class SelectionActionResult:
    """Stable selection-action response independent of the configured runtime."""

    action: SelectionActionKind
    prompt_version: str
    output: str
    evidence: SelectionActionEvidence
    invocation_id: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None
    status: ModelInvocationStatus
    error_code: str = ""


__all__ = [
    "CALC_LOCATOR_KIND",
    "CALC_REFERENCE_CONTENT_STATUS",
    "CALC_REFERENCE_RESOLVED_STATUS",
    "CALC_REFERENCE_KIND",
    "REFERENCE_CONTENT_MODE",
    "REFERENCE_CONTENT_MODE_KEY",
    "SelectionActionEvidence",
    "SelectionActionInput",
    "SelectionActionKind",
    "SelectionActionResult",
    "SelectionDraftEvidence",
    "SelectionEvidenceError",
    "SelectionEvidenceMode",
    "SelectionEvidenceProvider",
    "SelectionEvidenceReference",
    "VerifiedSelectionEvidence",
    "calc_reference_descriptor",
    "is_calc_reference",
]
