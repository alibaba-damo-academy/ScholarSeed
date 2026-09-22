"""Resource action processor for OOXML PPTX selections."""

from __future__ import annotations

from pathlib import PurePosixPath

from service.resources.domain.ai import ResourceCommand
from service.resources.service.evidence import (
    MAX_RESOURCE_CONTEXT,
    ResolvedResourceEvidence,
    from_verified,
)
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceProvider
from service.workbench.domain.slides import PPTX_SUFFIX


class PptxActionProcessor:
    def resolve(
        self,
        command: ResourceCommand,
        evidence: SelectionEvidenceProvider,
        *,
        max_chars: int = MAX_RESOURCE_CONTEXT,
    ) -> ResolvedResourceEvidence:
        if (
            command.selection is None
            or PurePosixPath(command.source_id).suffix.lower() != PPTX_SUFFIX
        ):
            raise SelectionEvidenceError("selection_unsupported")
        return from_verified(evidence.resolve_action(command.selection, command.draft))


__all__ = ["PptxActionProcessor"]
