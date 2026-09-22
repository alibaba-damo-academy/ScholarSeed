"""Contracts shared by format-specific presentation selection processors."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

PPT_SUFFIX = ".ppt"
PPTX_SUFFIX = ".pptx"
IMPRESS_LOCATOR_KIND = "impress"


class SlideSelectionError(ValueError):
    """A presentation locator cannot be resolved by its format processor."""


class SlideSnapshotRequired(SlideSelectionError):
    """The legacy format requires a revision-bound client selection snapshot."""


class SlideSelectionProcessor(Protocol):
    def resolve_selection(self, payload: bytes, locator: Mapping[str, Any]) -> str: ...

    def resolve_context(
        self,
        payload: bytes,
        locator: Mapping[str, Any],
        selected: str,
        *,
        max_chars: int,
    ) -> str: ...


__all__ = [
    "IMPRESS_LOCATOR_KIND",
    "PPT_SUFFIX",
    "PPTX_SUFFIX",
    "SlideSelectionError",
    "SlideSelectionProcessor",
    "SlideSnapshotRequired",
]
