"""Metadata-bound, no-follow reads of individually approved external files."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import closing
from pathlib import Path

from service.content.domain.model import PROJECT_STATE_DIRNAME, ContentError
from service.paths import global_home, service_deny_read_roots
from service.platform.content import ExternalFileSnapshot
from service.platform.files import guess_media_type
from service.platform.storage import (
    PATH_CHANGE_TIME_COMPARABLE,
    WINDOWS_PLATFORM,
    DirectoryHandle,
    filesystem_path,
    open_parent,
)

EXTERNAL_PATH_REQUIRED = "external_absolute_file_required"
EXTERNAL_FILE_CHANGED = "external_file_changed"
EXTERNAL_FILE_FORBIDDEN = "external_file_forbidden"
EXTERNAL_FILE_NOT_REGULAR = "external_regular_file_required"
EXTERNAL_OFFSET_INVALID = "external_offset_out_of_range"
DOCUMENT_SUFFIXES = frozenset((".txt", ".md", ".csv", ".tsv", ".pdf", ".docx", ".xlsx", ".pptx"))
SENSITIVE_NAMES = frozenset(
    ("credentials", "credentials.json", "auth.json", "secrets", "secrets.txt", "passwd", "shadow")
)
EXTERNAL_DEFAULT_MEDIA_TYPE = "application/octet-stream"


def _path(source: str) -> Path:
    path = Path(source)
    if not path.is_absolute() or not path.name or "\0" in source or ".." in path.parts:
        raise ContentError(EXTERNAL_PATH_REQUIRED)
    if os.name != WINDOWS_PLATFORM:
        path = path.parent.resolve(strict=True) / path.name
    normalized = Path(str(filesystem_path(path)).casefold())
    forbidden = (global_home(), *service_deny_read_roots())
    if PROJECT_STATE_DIRNAME.casefold() in (part.casefold() for part in path.parts) or any(
        normalized.is_relative_to(Path(str(filesystem_path(root.resolve())).casefold()))
        for root in forbidden
    ):
        raise ContentError(EXTERNAL_FILE_FORBIDDEN)
    return path


def _snapshot(parent: DirectoryHandle, name: str, identity: os.stat_result) -> ExternalFileSnapshot:
    if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1:
        raise ContentError(EXTERNAL_FILE_NOT_REGULAR)
    path = parent.child(name)
    fingerprint = (
        str(path),
        parent.identity(),
        identity.st_dev,
        identity.st_ino,
        identity.st_size,
        identity.st_mtime_ns,
        identity.st_ctime_ns if PATH_CHANGE_TIME_COMPARABLE else None,
    )
    revision = hashlib.sha256(json.dumps(fingerprint).encode()).hexdigest()
    return ExternalFileSnapshot(
        path=str(path),
        revision=revision,
        size=identity.st_size,
        media_type=guess_media_type(name) or EXTERNAL_DEFAULT_MEDIA_TYPE,
        automatic_eligible=path.suffix.lower() in DOCUMENT_SUFFIXES
        and not any(part.startswith(".") or part.lower() in SENSITIVE_NAMES for part in path.parts),
    )


def inspect(source: str) -> ExternalFileSnapshot:
    path = _path(source)
    parent, name = open_parent(path)
    with closing(parent):
        if parent.child(name) != path:
            raise ContentError(EXTERNAL_FILE_CHANGED)
        return _snapshot(parent, name, parent.stat(name))


def read(snapshot: ExternalFileSnapshot, offset: int, limit: int) -> bytes:
    if offset < 0 or offset > snapshot.size or limit <= 0:
        raise ContentError(EXTERNAL_OFFSET_INVALID)
    path = _path(snapshot.path)
    if str(path) != snapshot.path:
        raise ContentError(EXTERNAL_FILE_CHANGED)
    parent, name = open_parent(path)
    with closing(parent):
        if parent.child(name) != path:
            raise ContentError(EXTERNAL_FILE_CHANGED)
        if _snapshot(parent, name, parent.stat(name)) != snapshot:
            raise ContentError(EXTERNAL_FILE_CHANGED)
        with os.fdopen(parent.open_regular(name), "rb") as stream:
            before = os.fstat(stream.fileno())
            if _snapshot(parent, name, before) != snapshot:
                raise ContentError(EXTERNAL_FILE_CHANGED)
            stream.seek(offset)
            payload = stream.read(min(limit, snapshot.size - offset))
            after = os.fstat(stream.fileno())
            if (
                _snapshot(parent, name, after) != snapshot
                or before.st_ctime_ns != after.st_ctime_ns
            ):
                raise ContentError(EXTERNAL_FILE_CHANGED)
        if (
            _snapshot(parent, name, parent.stat(name)) != snapshot
            or inspect(snapshot.path) != snapshot
        ):
            raise ContentError(EXTERNAL_FILE_CHANGED)
    return payload
