"""Private startup document projections read by the source version's owners.

These records carry sensitive bytes. They are neither diagnostics nor complete
data admission: callers still own directory qualification and writer coverage.
"""

from __future__ import annotations

import base64
import hashlib
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

MAX_DOCUMENT_BYTES = 1024 * 1024
MAX_DOCUMENTS = 64
MAX_DOCUMENT_SET_BYTES = 8 * 1024 * 1024


@dataclass(frozen=True)
class DocumentSource:
    name: str
    observed: bytes | None = field(repr=False)
    prepared: bytes | None = field(repr=False)
    read: Callable[[bytes | None], object] = field(repr=False)


@dataclass(frozen=True)
class DocumentPreview:
    name: str
    source_present: bool
    source_digest: str
    payload: str | None = field(repr=False)


@dataclass(frozen=True)
class DocumentCheck:
    name: str
    source_digest: str
    prepared_digest: str


def _digest(payload: bytes | None) -> str:
    # Absence and an empty existing file are different startup observations.
    return hashlib.sha256(b"absent" if payload is None else b"present\0" + payload).hexdigest()


def _sources(values: Sequence[DocumentSource]) -> dict[str, DocumentSource]:
    if not 0 < len(values) <= MAX_DOCUMENTS:
        raise ValueError("invalid startup document coverage")
    result = {}
    for value in values:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", value.name) or value.name in result:
            raise ValueError("invalid startup document identity")
        for payload in (value.observed, value.prepared):
            if payload is not None and (
                not isinstance(payload, bytes) or len(payload) > MAX_DOCUMENT_BYTES
            ):
                raise ValueError("startup document exceeds budget")
        result[value.name] = value
    return result


def preview_documents(values: Sequence[DocumentSource]) -> tuple[DocumentPreview, ...]:
    sources = _sources(values)
    previews = []
    size = 0
    for name, source in sources.items():
        source.read(source.prepared)
        payload = (
            None if source.prepared is None else base64.b64encode(source.prepared).decode("ascii")
        )
        size += len(payload or "")
        if size > MAX_DOCUMENT_SET_BYTES:
            raise ValueError("startup documents exceed budget")
        previews.append(
            DocumentPreview(name, source.observed is not None, _digest(source.observed), payload)
        )
    return tuple(previews)


def check_documents(value: object, values: Sequence[DocumentSource]) -> tuple[DocumentCheck, ...]:
    """Read exact candidate bytes using each actual source-version reader.

    The wire chooses no file paths, callbacks or defaults. Every report must
    match the source's own observed bytes and compiled document owner set.
    """
    sources = _sources(values)
    if not isinstance(value, list) or len(value) != len(sources):
        raise ValueError("startup document coverage differs")
    seen = set()
    checks = []
    size = 0
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {
            "name",
            "source_present",
            "source_digest",
            "payload",
        }:
            raise ValueError("invalid startup document fields")
        name = entry["name"]
        if not isinstance(name, str) or name not in sources or name in seen:
            raise ValueError("startup document coverage differs")
        source = sources[name]
        if (
            type(entry["source_present"]) is not bool
            or entry["source_present"] != (source.observed is not None)
            or entry["source_digest"] != _digest(source.observed)
        ):
            raise ValueError("startup document source changed")
        payload = entry["payload"]
        prepared = None
        if payload is not None:
            if not isinstance(payload, str) or len(payload) > 4 * ((MAX_DOCUMENT_BYTES + 2) // 3):
                raise ValueError("invalid startup document payload")
            size += len(payload)
            if size > MAX_DOCUMENT_SET_BYTES:
                raise ValueError("startup documents exceed budget")
            try:
                prepared = base64.b64decode(payload, validate=True)
            except (ValueError, TypeError) as error:
                raise ValueError("invalid startup document payload") from error
            if (
                len(prepared) > MAX_DOCUMENT_BYTES
                or base64.b64encode(prepared).decode("ascii") != payload
            ):
                raise ValueError("invalid startup document payload")
        source.read(prepared)
        checks.append(DocumentCheck(name, _digest(source.observed), _digest(prepared)))
        seen.add(name)
    return tuple(checks)
