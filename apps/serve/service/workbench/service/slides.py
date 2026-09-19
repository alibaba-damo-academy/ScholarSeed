"""Format dispatch for isolated PPT and PPTX selection processors."""

from __future__ import annotations

from pathlib import PurePosixPath

from service.workbench.domain.slides import (
    PPT_SUFFIX,
    PPTX_SUFFIX,
    SlideSelectionError,
    SlideSelectionProcessor,
)
from service.workbench.service.ppt import PptSelectionProcessor
from service.workbench.service.pptx import PptxSelectionProcessor

PPT_PROCESSOR = PptSelectionProcessor()
PPTX_PROCESSOR = PptxSelectionProcessor()
SLIDE_PROCESSORS: dict[str, SlideSelectionProcessor] = {
    PPT_SUFFIX: PPT_PROCESSOR,
    PPTX_SUFFIX: PPTX_PROCESSOR,
}


def slide_processor_for(source_id: str) -> SlideSelectionProcessor:
    processor = SLIDE_PROCESSORS.get(PurePosixPath(source_id).suffix.lower())
    if processor is None:
        raise SlideSelectionError("presentation_format")
    return processor


__all__ = ["slide_processor_for"]
