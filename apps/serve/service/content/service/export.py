from __future__ import annotations

import os
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from service.platform.storage import DirectoryHandle, canonical_root, open_directory

EXPORT_STAGE_PREFIX = ".scholarseed-export-"
EXPORT_STAGE_FILE = "payload"
EXPORT_CONFLICT = "literature_delivery_target_conflict"
EXPORT_SOURCE_CHANGED = "literature_delivery_source_changed"
REVISION_PREFIX = "sha256:"
EXPORT_DIRECTORY_INVALID = "content_export_directory_invalid"
EXPORT_ENTRY_LIMIT = 100000


def identical_export(directory: DirectoryHandle, payload: bytes) -> str | None:
    for name in sorted(directory.names(EXPORT_ENTRY_LIMIT)):
        if Path(name).suffix.casefold() != ".pdf":
            continue
        try:
            descriptor = directory.open_regular(name)
        except OSError:
            continue
        with os.fdopen(descriptor, "rb") as handle:
            before = os.fstat(handle.fileno())
            if before.st_size != len(payload):
                continue
            existing = handle.read(len(payload) + 1)
            after = os.fstat(handle.fileno())
            if existing == payload and (before.st_size, before.st_mtime_ns) == (
                after.st_size,
                after.st_mtime_ns,
            ):
                return str(directory.child(name))
    return None


def open_export_directory(absolute: str) -> DirectoryHandle:
    root = Path(absolute)
    if not root.is_absolute():
        raise ValueError(EXPORT_DIRECTORY_INVALID)
    return open_directory(canonical_root(root), ())


def export_bytes(directory: DirectoryHandle, name: str, payload: bytes, revision: str) -> str:
    if REVISION_PREFIX + sha256(payload).hexdigest() != revision:
        raise ValueError(EXPORT_SOURCE_CHANGED)
    try:
        descriptor = directory.open_regular(name)
    except FileNotFoundError:
        descriptor = None
    if descriptor is not None:
        with os.fdopen(descriptor, "rb") as handle:
            if handle.read(len(payload) + 1) != payload:
                raise ValueError(EXPORT_CONFLICT)
        return str(directory.child(name))
    stage_name = EXPORT_STAGE_PREFIX + uuid4().hex
    directory.mkdir(stage_name)
    stage = directory.directory(stage_name)
    try:
        descriptor = stage.open_private(EXPORT_STAGE_FILE, os.O_RDWR | os.O_CREAT | os.O_EXCL)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        stage.replace_private(
            EXPORT_STAGE_FILE, name, exclusive=True, destination_directory=directory
        )
        directory.sync()
        return str(directory.child(name))
    finally:
        try:
            stage.remove_private(EXPORT_STAGE_FILE)
        except FileNotFoundError:
            pass
        stage.close()
        directory.rmdir(stage_name)
