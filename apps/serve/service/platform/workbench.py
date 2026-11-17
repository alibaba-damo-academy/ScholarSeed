"""Cross-domain contract for projecting file bytes into the shared Workbench."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Callable, Protocol
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict

REFERENCE_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024
REFERENCE_LINK_MAX_LENGTH = 4096
REFERENCE_SUFFIXES = frozenset((".md", ".markdown"))
REFERENCE_INVALID = "document_reference_invalid"
REFERENCE_FRAGMENT_PREFIX = "ref-"
REFERENCE_ENCODED_SEPARATOR = re.compile(r"%(?:2f|5c)", re.IGNORECASE)
REFERENCE_INVALID_ESCAPE = re.compile(r"%(?![a-fA-F0-9]{2})")


class ArtifactDocumentSource(BaseModel):
    model_config = ConfigDict(extra="forbid", str_min_length=1)
    session_id: str
    artifact_id: str
    member: str | None = None


ArtifactDocumentReader = Callable[[ArtifactDocumentSource, str], tuple[bytes, str]]


@dataclass(frozen=True)
class DocumentReference:
    path: str
    fragment: str


def parse_document_reference(href: str) -> DocumentReference:
    if (
        not href
        or len(href) > REFERENCE_LINK_MAX_LENGTH
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in href)
        or REFERENCE_ENCODED_SEPARATOR.search(href)
        or REFERENCE_INVALID_ESCAPE.search(href)
    ):
        raise ValueError(REFERENCE_INVALID)
    parsed = urlsplit(href)
    path = unquote(parsed.path, errors="strict")
    fragment = unquote(parsed.fragment, errors="strict")
    if (
        parsed.scheme
        or parsed.netloc
        or parsed.query
        or not path
        or path.startswith("/")
        or any(character in path for character in '\\:%?#<>|*"')
        or any(part in {"", ".", ".."} for part in path.split("/"))
        or PurePosixPath(path).suffix.lower() not in REFERENCE_SUFFIXES
        or not fragment.startswith(REFERENCE_FRAGMENT_PREFIX)
        or len(fragment) <= len(REFERENCE_FRAGMENT_PREFIX)
        or any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in path + fragment)
    ):
        raise ValueError(REFERENCE_INVALID)
    return DocumentReference(path, "#" + fragment)


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


__all__ = [
    "ArtifactDocumentSource",
    "ArtifactDocumentReader",
    "DocumentFormatPort",
    "DocumentFormatProjection",
    "DocumentReference",
    "REFERENCE_DOCUMENT_MAX_BYTES",
    "REFERENCE_INVALID",
    "REFERENCE_SUFFIXES",
    "parse_document_reference",
]
