"""Cross-domain contracts for turning source selections into resources.

The resources domain owns the resulting Markdown asset, while the source domain
owns source validation and revision lookup.  These records keep that dependency
point explicit without either sibling domain importing the other's store.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable


class ExcerptSourceKind(str, Enum):
    """Registered upstream domains that can produce resource excerpts."""

    LITERATURE = "literature"


class ExcerptLocatorKind(str, Enum):
    """Registered locator representations accepted by excerpt sources."""

    PDF = "pdf"


@dataclass(frozen=True)
class ExcerptSourceRef:
    """Validated source identity and the exact document revision being read."""

    kind: ExcerptSourceKind
    source_id: str
    title: str
    document_revision: str


class ExcerptSourceError(RuntimeError):
    """Stable source-resolution failure exposed by the resource endpoint."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@runtime_checkable
class ExcerptSourceResolver(Protocol):
    """Resolve and validate one upstream source inside a project."""

    def resolve(
        self,
        project_id: str,
        source_id: str,
        expected_document_revision: str | None = None,
    ) -> ExcerptSourceRef: ...


__all__ = [
    "ExcerptLocatorKind",
    "ExcerptSourceError",
    "ExcerptSourceKind",
    "ExcerptSourceRef",
    "ExcerptSourceResolver",
]
