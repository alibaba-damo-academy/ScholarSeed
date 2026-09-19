"""Immutable content objects with descriptor-relative, no-follow filesystem access."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import stat
import uuid
from pathlib import Path

from service.content.domain.model import ContentError
from service.content.service.native import publish_descriptor, sync_published_descriptor
from service.content.service.utils import directory
from service.platform.content import ArtifactScope, ArtifactStorageLocation, VerifiedArtifactContent
from service.platform.storage import NOFOLLOW, NONBLOCK, DirectoryHandle, preserve_mode

CHUNK_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
OBJECT_MODE = 0o400
TEMP_MODE = 0o600
DEFAULT_MEDIA_TYPE = "application/octet-stream"
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
PATH_INVALID = "artifact_snapshot_path_invalid"
SOURCE_CHANGED = "artifact_snapshot_source_changed"
INTEGRITY_MISMATCH = "artifact_snapshot_integrity_mismatch"
TOO_LARGE = "artifact_snapshot_too_large"
UNAVAILABLE = "artifact_snapshot_unavailable"
TEMP_PREFIX = ".capture-"


def _signature(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _read_object(directory: DirectoryHandle, digest: str) -> bytes:
    descriptor = directory.open(digest, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ContentError(PATH_INVALID)
        if before.st_size > MAX_ARTIFACT_BYTES:
            raise ContentError(TOO_LARGE)
        payload = stream.read(MAX_ARTIFACT_BYTES + 1)
        if len(payload) > MAX_ARTIFACT_BYTES:
            raise ContentError(TOO_LARGE)
        if _signature(before) != _signature(os.fstat(stream.fileno())):
            raise ContentError(INTEGRITY_MISMATCH)
        if hashlib.sha256(payload).hexdigest() != digest:
            raise ContentError(INTEGRITY_MISMATCH)
    return payload


def capture(
    location: ArtifactStorageLocation,
    scope: ArtifactScope,
    source: Path,
    *,
    expected_sha256: str = "",
) -> VerifiedArtifactContent:
    """Copy one stable file, then atomically install it under its verified digest."""

    root = Path(location.source_root).expanduser().resolve()
    storage_root = Path(location.storage_root)
    try:
        relative = source.relative_to(root)
    except ValueError as exc:
        raise ContentError(PATH_INVALID) from exc
    if not relative.parts or (expected_sha256 and not DIGEST_PATTERN.fullmatch(expected_sha256)):
        raise ContentError(PATH_INVALID)
    try:
        with directory(root, relative.parts[:-1]) as parent:
            descriptor = parent.open(relative.name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
            with os.fdopen(descriptor, "rb") as source_stream:
                before = os.fstat(source_stream.fileno())
                if not stat.S_ISREG(before.st_mode):
                    raise ContentError(PATH_INVALID)
                if before.st_size > MAX_ARTIFACT_BYTES:
                    raise ContentError(TOO_LARGE)
                with directory(
                    storage_root, Path(location.objects_relative).parts, create=True
                ) as objects:
                    temporary = f"{TEMP_PREFIX}{uuid.uuid4().hex}"
                    output = objects.open(
                        temporary,
                        os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                        TEMP_MODE,
                    )
                    try:
                        digest = hashlib.sha256()
                        size = 0
                        with os.fdopen(os.dup(output), "wb") as target:
                            while chunk := source_stream.read(CHUNK_BYTES):
                                size += len(chunk)
                                if size > MAX_ARTIFACT_BYTES:
                                    raise ContentError(TOO_LARGE)
                                digest.update(chunk)
                                target.write(chunk)
                            target.flush()
                            preserve_mode(target.fileno(), OBJECT_MODE)
                            os.fsync(target.fileno())
                        if _signature(before) != _signature(os.fstat(source_stream.fileno())):
                            raise ContentError(SOURCE_CHANGED)
                        value = digest.hexdigest()
                        if expected_sha256 and expected_sha256 != value:
                            raise ContentError(SOURCE_CHANGED)
                        try:
                            publish_descriptor(output, objects, value)
                        except FileExistsError:
                            pass
                        else:
                            sync_published_descriptor(output, objects, value)
                        # Newly published and pre-existing objects share the same check;
                        # never repair a corrupted revision from the working source.
                        _read_object(objects, value)
                        objects.sync()
                    finally:
                        try:
                            current = objects.stat(temporary)
                            owned = os.fstat(output)
                            if (current.st_dev, current.st_ino) != (owned.st_dev, owned.st_ino):
                                raise ContentError(INTEGRITY_MISMATCH)
                            objects.unlink(temporary)
                        finally:
                            os.close(output)
        return VerifiedArtifactContent(
            scope=scope,
            source_path=relative.as_posix(),
            name=relative.name,
            media_type=mimetypes.guess_type(relative.name)[0] or DEFAULT_MEDIA_TYPE,
            size=size,
            sha256=value,
        )
    except OSError as exc:
        raise ContentError(UNAVAILABLE) from exc


def read(location: ArtifactStorageLocation, content: VerifiedArtifactContent) -> bytes:
    """An unavailable/corrupted object is an error, even when the source still exists."""

    if DIGEST_PATTERN.fullmatch(content.sha256) is None:
        raise ContentError(PATH_INVALID)
    try:
        with directory(
            Path(location.storage_root), Path(location.objects_relative).parts
        ) as objects:
            payload = _read_object(objects, content.sha256)
    except OSError as exc:
        raise ContentError(UNAVAILABLE) from exc
    if len(payload) != content.size:
        raise ContentError(INTEGRITY_MISMATCH)
    return payload
