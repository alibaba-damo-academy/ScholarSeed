"""Aggregate provenance-bearing selections into user-visible Markdown resources."""

from __future__ import annotations

import hashlib
import json
import unicodedata
from collections.abc import Collection, Mapping
from pathlib import PurePosixPath

from service.content.domain.model import ContentError
from service.platform.content import AssetKind, AssetOrigin, ContentPort, FileAssetRef
from service.platform.excerpts import (
    ExcerptLocatorKind,
    ExcerptSourceKind,
    ExcerptSourceRef,
    ExcerptSourceResolver,
)
from service.resources.domain.model import (
    ExcerptOperation,
    PdfExcerptSelection,
    ResourceExcerptOutcome,
    ResourceLocationRef,
)
from service.resources.persistence.catalog import ResourceExcerptCatalog
from service.resources.service.writer import ResourceWriter, ResourceWriterError

EXCERPT_SCHEMA_VERSION = 1
EXCERPT_HEADER_PREFIX = "<!-- scholarseed-resource-excerpts:"
EXCERPT_MARKER_PREFIX = "<!-- scholarseed-excerpt:"
COMMENT_SUFFIX = " -->"
HASH_SEPARATOR = "\0"
UTF8_ENCODING = "utf-8"
MAX_EXCERPT_DOCUMENT_BYTES = 512 * 1024
MAX_EXCERPT_NAME_CHARS = 180
INVALID_EXCERPT_RESOURCE = "invalid_excerpt_resource"
AMBIGUOUS_EXCERPT_RESOURCE = "ambiguous_excerpt_resource"
EXCERPT_TOO_LARGE = "excerpt_too_large"
UNSUPPORTED_EXCERPT_SOURCE = "unsupported_excerpt_source"


class ResourceExcerptError(RuntimeError):
    """Stable resource-excerpt failure exposed by the HTTP layer."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _compact(payload: dict[str, object]) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _metadata_line(prefix: str, payload: dict[str, object]) -> str:
    return f"{prefix}{_compact(payload)}{COMMENT_SUFFIX}"


def _metadata(line: str, prefix: str) -> dict[str, object] | None:
    if not line.startswith(prefix) or not line.endswith(COMMENT_SUFFIX):
        return None
    raw = line[len(prefix) : -len(COMMENT_SUFFIX)]
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _source_payload(source: ExcerptSourceRef) -> dict[str, object]:
    return {
        "schema_version": EXCERPT_SCHEMA_VERSION,
        "source_id": source.source_id,
        "source_kind": source.kind.value,
    }


def _source_matches(body: str, source: ExcerptSourceRef) -> bool:
    first_line, _, _remainder = body.partition("\n")
    payload = _metadata(first_line, EXCERPT_HEADER_PREFIX)
    return bool(
        payload
        and payload.get("schema_version") == EXCERPT_SCHEMA_VERSION
        and payload.get("source_kind") == source.kind.value
        and payload.get("source_id") == source.source_id
    )


def _fingerprint(selection: PdfExcerptSelection) -> str:
    basis = f"{selection.page}{HASH_SEPARATOR}{selection.text}"
    return hashlib.sha256(basis.encode(UTF8_ENCODING)).hexdigest()


def _stored_fingerprints(body: str) -> set[str]:
    fingerprints: set[str] = set()
    for line in body.splitlines():
        payload = _metadata(line, EXCERPT_MARKER_PREFIX)
        if payload is None:
            continue
        fingerprint = payload.get("fingerprint")
        if isinstance(fingerprint, str) and fingerprint:
            fingerprints.add(fingerprint)
    return fingerprints


def _display_title(title: str, source_id: str) -> str:
    normalized = unicodedata.normalize("NFC", " ".join(title.split())).strip()
    return normalized or source_id


def _default_name(title: str, source_id: str) -> str:
    display = _display_title(title, source_id)
    safe = "".join("-" if char in {"/", "\\", "\x00"} else char for char in display)
    safe = safe.strip().strip(".")[:MAX_EXCERPT_NAME_CHARS].strip()
    return safe or source_id


def _quote(text: str) -> str:
    return "\n".join(">" if not line else f"> {line}" for line in text.split("\n"))


def _selection_block(selection: PdfExcerptSelection, source: ExcerptSourceRef) -> str:
    marker = _metadata_line(
        EXCERPT_MARKER_PREFIX,
        {
            "document_revision": source.document_revision,
            "fingerprint": _fingerprint(selection),
            "locator": {
                "kind": ExcerptLocatorKind.PDF.value,
                "page": selection.page,
                "quads": [list(quad) for quad in selection.quads],
            },
        },
    )
    return f"## 第 {selection.page} 页\n\n{marker}\n\n{_quote(selection.text)}"


def _new_body(source: ExcerptSourceRef, selections: tuple[PdfExcerptSelection, ...]) -> str:
    header = _metadata_line(EXCERPT_HEADER_PREFIX, _source_payload(source))
    blocks = "\n\n".join(_selection_block(item, source) for item in selections)
    return f"{header}\n\n# {_display_title(source.title, source.source_id)}\n\n{blocks}\n"


def _appended_body(
    current: str,
    source: ExcerptSourceRef,
    selections: tuple[PdfExcerptSelection, ...],
) -> str:
    if not selections:
        return current
    blocks = "\n\n".join(_selection_block(item, source) for item in selections)
    return f"{current.rstrip()}\n\n{blocks}\n"


def _asset(project_id: str, path: str) -> FileAssetRef:
    return FileAssetRef(
        project_id=project_id,
        path=path,
        name=PurePosixPath(path).name,
        kind=AssetKind.FILE,
        origin=AssetOrigin.LOCAL,
    )


class ResourceExcerptService:
    """Create one aggregate resource per validated upstream source."""

    def __init__(
        self,
        content: ContentPort,
        writer: ResourceWriter,
        catalog: ResourceExcerptCatalog,
        resolvers: Mapping[ExcerptSourceKind, ExcerptSourceResolver],
    ) -> None:
        self._content = content
        self._writer = writer
        self._catalog = catalog
        self._resolvers = dict(resolvers)

    def add(
        self,
        project_id: str,
        source_kind: ExcerptSourceKind,
        source_id: str,
        expected_document_revision: str | None,
        location: ResourceLocationRef,
        selections: tuple[PdfExcerptSelection, ...],
    ) -> ResourceExcerptOutcome:
        try:
            project_id = self._content.project(project_id).id
        except ContentError as error:
            raise ResourceExcerptError(error.code) from error
        resolver = self._resolvers.get(source_kind)
        if resolver is None:
            raise ResourceExcerptError(UNSUPPORTED_EXCERPT_SOURCE)
        source = resolver.resolve(project_id, source_id, expected_document_revision)
        normalized = tuple(
            PdfExcerptSelection(
                text=item.text.replace("\r\n", "\n").replace("\r", "\n").strip(),
                page=item.page,
                quads=item.quads,
            )
            for item in selections
        )
        existing = self._existing(project_id, source)
        if existing is None:
            return self._create(project_id, source, location, normalized)
        asset, body, revision = existing
        return self._append(project_id, source, asset, body, revision, normalized)

    def _existing(
        self,
        project_id: str,
        source: ExcerptSourceRef,
    ) -> tuple[FileAssetRef, str, str] | None:
        indexed = self._catalog.get(project_id, source.kind, source.source_id)
        if indexed is not None:
            try:
                revision = self._content.snapshot(project_id, indexed.resource_path).revision
                body = self._content.read_text(project_id, indexed.resource_path)
            except ContentError as error:
                if error.code != "file_not_found":
                    raise ResourceExcerptError(error.code) from error
            else:
                if not _source_matches(body, source):
                    raise ResourceExcerptError(INVALID_EXCERPT_RESOURCE)
                return _asset(project_id, indexed.resource_path), body, revision
        return self._recover(project_id, source)

    def _recover(
        self,
        project_id: str,
        source: ExcerptSourceRef,
    ) -> tuple[FileAssetRef, str, str] | None:
        matches: list[tuple[FileAssetRef, str, str]] = []
        paths = {hit.path for hit in self._content.search(project_id, source.source_id).hits}
        for path in paths:
            try:
                revision = self._content.snapshot(project_id, path).revision
                body = self._content.read_text(project_id, path)
                if not _source_matches(body, source):
                    continue
            except ContentError:
                continue
            matches.append((_asset(project_id, path), body, revision))
        if len(matches) > 1:
            raise ResourceExcerptError(AMBIGUOUS_EXCERPT_RESOURCE)
        if not matches:
            return None
        asset, body, revision = matches[0]
        self._catalog.save(project_id, source.kind, source.source_id, asset.path, revision)
        return asset, body, revision

    def _create(
        self,
        project_id: str,
        source: ExcerptSourceRef,
        location: ResourceLocationRef,
        selections: tuple[PdfExcerptSelection, ...],
    ) -> ResourceExcerptOutcome:
        unique = self._unique((), selections)
        name = location.name.strip() or _default_name(source.title, source.source_id)
        body = _new_body(source, unique)
        self._check_size(body)
        try:
            asset = self._writer.write_markdown(
                project_id,
                ResourceLocationRef(parent=location.parent, name=name),
                body,
            )
            revision = self._content.snapshot(project_id, asset.path).revision
        except ResourceWriterError as error:
            raise ResourceExcerptError(error.code) from error
        except ContentError as error:
            raise ResourceExcerptError(error.code) from error
        self._catalog.save(project_id, source.kind, source.source_id, asset.path, revision)
        return ResourceExcerptOutcome(
            operation=ExcerptOperation.CREATED,
            asset_path=asset.path,
            asset_name=asset.name,
            source_id=source.source_id,
            added=len(unique),
            skipped=len(selections) - len(unique),
            total=len(unique),
        )

    def _append(
        self,
        project_id: str,
        source: ExcerptSourceRef,
        asset: FileAssetRef,
        body: str,
        revision: str,
        selections: tuple[PdfExcerptSelection, ...],
    ) -> ResourceExcerptOutcome:
        stored = _stored_fingerprints(body)
        unique = self._unique(stored, selections)
        updated = _appended_body(body, source, unique)
        self._check_size(updated)
        if unique:
            try:
                asset = self._writer.replace_markdown(
                    project_id,
                    asset.path,
                    updated,
                    revision,
                )
                revision = self._content.snapshot(project_id, asset.path).revision
            except ResourceWriterError as error:
                raise ResourceExcerptError(error.code) from error
            except ContentError as error:
                raise ResourceExcerptError(error.code) from error
        self._catalog.save(project_id, source.kind, source.source_id, asset.path, revision)
        return ResourceExcerptOutcome(
            operation=ExcerptOperation.UPDATED,
            asset_path=asset.path,
            asset_name=asset.name,
            source_id=source.source_id,
            added=len(unique),
            skipped=len(selections) - len(unique),
            total=len(stored) + len(unique),
        )

    @staticmethod
    def _unique(
        stored: Collection[str],
        selections: tuple[PdfExcerptSelection, ...],
    ) -> tuple[PdfExcerptSelection, ...]:
        seen = set(stored)
        unique = []
        for selection in selections:
            fingerprint = _fingerprint(selection)
            if fingerprint in seen:
                continue
            seen.add(fingerprint)
            unique.append(selection)
        return tuple(unique)

    @staticmethod
    def _check_size(body: str) -> None:
        if len(body.encode(UTF8_ENCODING)) > MAX_EXCERPT_DOCUMENT_BYTES:
            raise ResourceExcerptError(EXCERPT_TOO_LARGE)


__all__ = [
    "AMBIGUOUS_EXCERPT_RESOURCE",
    "EXCERPT_TOO_LARGE",
    "INVALID_EXCERPT_RESOURCE",
    "MAX_EXCERPT_DOCUMENT_BYTES",
    "ResourceExcerptError",
    "ResourceExcerptService",
    "UNSUPPORTED_EXCERPT_SOURCE",
]
