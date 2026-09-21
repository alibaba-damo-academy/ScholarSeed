"""Cross-domain contract for projecting file bytes into the shared Workbench."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class DocumentFormatProjection:
    """Source-neutral viewer decision owned by the Workbench format registry."""

    viewer: str
    processor: str | None
    content_kind: str
    can_preview: bool
    can_edit: bool
    can_select: bool
    can_annotate: bool
    can_save: bool
    can_edit_artifact: bool
    pending: tuple[str, ...]


class DocumentFormatPort(Protocol):
    """Narrow projection boundary consumed by non-project document sources."""

    def project(self, path: str, payload: bytes) -> DocumentFormatProjection: ...

    def preview(self, path: str, payload: bytes) -> bytes: ...


__all__ = ["DocumentFormatPort", "DocumentFormatProjection"]
