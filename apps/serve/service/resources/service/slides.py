"""Format dispatch for isolated PPT and PPTX resource action processors."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Protocol

from service.resources.domain.ai import ResourceCommand
from service.resources.service.evidence import MAX_RESOURCE_CONTEXT, ResolvedResourceEvidence
from service.resources.service.ppt import PptActionProcessor
from service.resources.service.pptx import PptxActionProcessor
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceProvider
from service.workbench.domain.slides import PPT_SUFFIX, PPTX_SUFFIX


class PresentationActionProcessor(Protocol):
    def resolve(
        self,
        command: ResourceCommand,
        evidence: SelectionEvidenceProvider,
        *,
        max_chars: int = MAX_RESOURCE_CONTEXT,
    ) -> ResolvedResourceEvidence: ...


PRESENTATION_ACTION_PROCESSORS: dict[str, PresentationActionProcessor] = {
    PPT_SUFFIX: PptActionProcessor(),
    PPTX_SUFFIX: PptxActionProcessor(),
}


def presentation_action_processor_for(source_id: str) -> PresentationActionProcessor:
    processor = PRESENTATION_ACTION_PROCESSORS.get(PurePosixPath(source_id).suffix.lower())
    if processor is None:
        raise SelectionEvidenceError("selection_unsupported")
    return processor


__all__ = ["presentation_action_processor_for"]
