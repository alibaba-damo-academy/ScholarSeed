"""Direct search over the current project's authorized resource files."""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from enum import IntEnum
from pathlib import PurePosixPath

from service.content.domain.model import ContentError
from service.content.service.extract import (
    ContentExtractionError,
    content_limit,
    extract_text,
)
from service.platform.content import (
    ResourceEntry,
    ResourceHit,
    ResourceMatch,
    ResourceReveal,
    ResourceRevealKind,
    ResourceSearchResult,
    StableContentSnapshot,
)

MAX_RESULTS = 80
SNIPPET_PADDING = 40
PATH_SEPARATOR = "/"

SnapshotReader = Callable[[str, int], StableContentSnapshot]


class MatchPriority(IntEnum):
    """Stable product ordering for one file's strongest match."""

    EXACT_NAME = 0
    NAME = 1
    PATH = 2
    CONTENT = 3


@dataclass(frozen=True)
class _Candidate:
    entry: ResourceEntry
    priority: MatchPriority
    matched: ResourceMatch
    snippet: str = ""
    reveal: ResourceReveal | None = None


def _snippet(text: str, start: int, end: int) -> str:
    fragment_start = max(0, start - SNIPPET_PADDING)
    fragment_end = min(len(text), end + SNIPPET_PADDING)
    fragment = text[fragment_start:fragment_end].replace("\n", " ").strip()
    prefix = "…" if fragment_start > 0 else ""
    suffix = "…" if fragment_end < len(text) else ""
    return f"{prefix}{fragment}{suffix}"


def _resource_relative(path: str, resource_root: str) -> str:
    root = resource_root.strip(PATH_SEPARATOR)
    if not root:
        return path
    prefix = f"{root}{PATH_SEPARATOR}"
    return path[len(prefix) :] if path.startswith(prefix) else path


def _candidate_key(candidate: _Candidate) -> tuple[int, str, str]:
    name = PurePosixPath(candidate.entry.path).name
    return int(candidate.priority), name.casefold(), candidate.entry.path.casefold()


def _metadata_candidate(
    entry: ResourceEntry,
    needle: str,
    resource_root: str,
) -> _Candidate | None:
    name = PurePosixPath(entry.path).name
    folded_name = name.casefold()
    if folded_name == needle:
        return _Candidate(entry, MatchPriority.EXACT_NAME, ResourceMatch.NAME)
    if needle in folded_name:
        return _Candidate(entry, MatchPriority.NAME, ResourceMatch.NAME)
    relative = _resource_relative(entry.path, resource_root)
    if needle in relative.casefold():
        return _Candidate(entry, MatchPriority.PATH, ResourceMatch.PATH)
    return None


def _content_candidate(
    entry: ResourceEntry,
    query: str,
    reader: SnapshotReader,
) -> _Candidate | None:
    max_bytes = content_limit(entry.path)
    if max_bytes is None:
        return None
    try:
        snapshot = reader(entry.path, max_bytes)
        text = extract_text(entry.path, snapshot.content)
    except (ContentError, ContentExtractionError, OSError):
        return None
    match = re.search(re.escape(query), text, flags=re.IGNORECASE)
    if match is None:
        return None
    return _Candidate(
        entry,
        MatchPriority.CONTENT,
        ResourceMatch.CONTENT,
        _snippet(text, match.start(), match.end()),
        ResourceReveal(
            kind=ResourceRevealKind.FIND,
            query=query,
            source_revision=snapshot.revision,
        ),
    )


def _hit(candidate: _Candidate) -> ResourceHit:
    return ResourceHit(
        path=candidate.entry.path,
        name=PurePosixPath(candidate.entry.path).name,
        matched=candidate.matched,
        snippet=candidate.snippet,
        reveal=candidate.reveal,
    )


def search_resources(
    entries: Sequence[ResourceEntry],
    query: str,
    reader: SnapshotReader,
    *,
    resource_root: str = "",
    limit: int = MAX_RESULTS,
) -> ResourceSearchResult:
    """Search files directly, rank globally, then apply the result window."""

    cleaned = query.strip()
    needle = cleaned.casefold()
    if not needle or limit < 1:
        return ResourceSearchResult(hits=())

    metadata: list[_Candidate] = []
    content_entries: list[ResourceEntry] = []
    for entry in entries:
        candidate = _metadata_candidate(entry, needle, resource_root)
        if candidate is None:
            content_entries.append(entry)
        else:
            metadata.append(candidate)
    metadata.sort(key=_candidate_key)
    if len(metadata) > limit:
        return ResourceSearchResult(
            hits=tuple(_hit(candidate) for candidate in metadata[:limit]),
            truncated=True,
        )

    content: list[_Candidate] = []
    content_entries.sort(
        key=lambda entry: (
            PurePosixPath(entry.path).name.casefold(),
            entry.path.casefold(),
        )
    )
    content_window = limit - len(metadata)
    for entry in content_entries:
        candidate = _content_candidate(entry, cleaned, reader)
        if candidate is not None:
            content.append(candidate)
            if len(content) > content_window:
                break

    candidates = metadata + content
    return ResourceSearchResult(
        hits=tuple(_hit(candidate) for candidate in candidates[:limit]),
        truncated=len(candidates) > limit,
    )


__all__ = ["MAX_RESULTS", "MatchPriority", "search_resources"]
