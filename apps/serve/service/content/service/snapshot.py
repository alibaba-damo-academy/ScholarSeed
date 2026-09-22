"""Immutable content objects with descriptor-relative, no-follow filesystem access."""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import stat
import uuid
from pathlib import Path
from threading import Lock

from service.content.domain.model import ContentError
from service.content.persistence import snapshots
from service.content.service.native import copy_descriptor_exclusive, creation_marker
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
_COPY_LOCKS_GUARD = Lock()
_COPY_LOCKS: dict[tuple[str, str, str, str], Lock] = {}


def _signature(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _copy_lock(location: ArtifactStorageLocation, scope: ArtifactScope, digest: str) -> Lock:
    key = (location.database, scope.kind.value, scope.id, digest)
    with _COPY_LOCKS_GUARD:
        return _COPY_LOCKS.setdefault(key, Lock())


def _read_object(directory: DirectoryHandle, digest: str, marker: str = "") -> bytes:
    descriptor = directory.open(digest, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or (
            marker and creation_marker(stream.fileno()) != marker
        ):
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


def _recover_prepared_object(
    objects: DirectoryHandle,
    digest: str,
    claim: snapshots.SnapshotClaim,
) -> bool:
    try:
        _read_object(objects, digest, claim.marker)
    except FileNotFoundError:
        return False
    except ContentError:
        descriptor = objects.open(digest, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        with os.fdopen(descriptor, "rb") as stream:
            if creation_marker(stream.fileno()) != claim.marker:
                raise ContentError(INTEGRITY_MISMATCH)
            identity = os.fstat(stream.fileno())
        current = objects.stat(digest)
        if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
            raise ContentError(INTEGRITY_MISMATCH)
        objects.unlink(digest)
        return False
    return True


def _publish_object(
    location: ArtifactStorageLocation,
    scope: ArtifactScope,
    objects: DirectoryHandle,
    source: int,
    digest: str,
    size: int,
) -> None:
    with _copy_lock(location, scope, digest):
        claim = snapshots.get(location.database, scope, digest)
        if claim is None:
            try:
                _read_object(objects, digest)
                return
            except FileNotFoundError:
                claim = snapshots.prepare(location.database, scope, digest, size)
        if claim.size != size:
            raise ContentError(INTEGRITY_MISMATCH)
        if claim.status is snapshots.SnapshotClaimStatus.COMPLETED:
            try:
                _read_object(objects, digest, claim.marker)
            except FileNotFoundError as error:
                raise ContentError(INTEGRITY_MISMATCH) from error
            return
        if _recover_prepared_object(objects, digest, claim):
            snapshots.complete(location.database, scope, digest, claim.marker)
            return
        copy_descriptor_exclusive(
            source,
            objects,
            digest,
            OBJECT_MODE,
            marker=claim.marker,
        )
        _read_object(objects, digest, claim.marker)
        snapshots.complete(location.database, scope, digest, claim.marker)


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
                        _publish_object(location, scope, objects, output, value, size)
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
            claim = snapshots.get(location.database, content.scope, content.sha256)
            if claim is not None and claim.status is not snapshots.SnapshotClaimStatus.COMPLETED:
                raise ContentError(UNAVAILABLE)
            payload = _read_object(objects, content.sha256, claim.marker if claim else "")
    except OSError as exc:
        raise ContentError(UNAVAILABLE) from exc
    if len(payload) != content.size:
        raise ContentError(INTEGRITY_MISMATCH)
    return payload
