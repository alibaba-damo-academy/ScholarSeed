"""Shared evidence projections for format-specific resource action processors."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Mapping

from service.resources.domain.ai import ResourceCommand
from service.workbench.domain.selection import VerifiedSelectionEvidence

UTF8_ENCODING = "utf-8"
SHA256_PREFIX = "sha256:"
MAX_RESOURCE_CONTEXT = 40_000


@dataclass(frozen=True)
class ResolvedResourceEvidence:
    selected_text: str
    context_text: str
    locator: Mapping[str, Any]
    can_edit: bool = False


def from_verified(evidence: VerifiedSelectionEvidence) -> ResolvedResourceEvidence:
    return ResolvedResourceEvidence(
        selected_text=evidence.selected_text,
        context_text=evidence.context_text,
        locator=evidence.reference.locator,
        can_edit=evidence.can_edit,
    )


def frozen_snapshot_matches(command: ResourceCommand, *, max_chars: int) -> bool:
    if command.selection is None:
        return False
    snapshot = command.selected_text_snapshot
    return (
        bool(snapshot.strip())
        and len(snapshot) <= max_chars
        and SHA256_PREFIX + sha256(snapshot.encode(UTF8_ENCODING)).hexdigest()
        == command.selection.selected_text_hash
    )


__all__ = [
    "ResolvedResourceEvidence",
    "from_verified",
    "frozen_snapshot_matches",
    "MAX_RESOURCE_CONTEXT",
]
