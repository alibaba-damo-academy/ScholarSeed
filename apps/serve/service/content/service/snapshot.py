"""Immutable content objects with descriptor-relative, no-follow filesystem access."""

from __future__ import annotations

import errno
import hashlib
import json
import logging
import os
import re
import stat
import time
import uuid
from dataclasses import asdict
from pathlib import Path
from threading import Lock

from service.content.domain.model import ContentError
from service.content.persistence import snapshots
from service.content.service.native import copy_descriptor_exclusive, creation_marker
from service.content.service.utils import directory
from service.platform.content import (
    DIRECTORY_MANIFEST_VERSION,
    ArtifactContentKind,
    ArtifactDirectoryEntry,
    ArtifactDirectoryManifest,
    ArtifactFileEntry,
    ArtifactScope,
    ArtifactSnapshotFailure,
    ArtifactStorageLocation,
    VerifiedArtifactContent,
)
from service.platform.files import CONTENT_SNIFF_BYTES, guess_media_type
from service.platform.storage import (
    FILE_ATTRIBUTE_REPARSE_POINT,
    NOFOLLOW,
    NONBLOCK,
    DirectoryHandle,
    preserve_mode,
)

CHUNK_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
MAX_DIRECTORY_ENTRIES = 2048
MAX_DIRECTORY_DEPTH = 32
DIRECTORY_MEDIA_TYPE = "application/vnd.scholarseed.directory+json"
OBJECT_MODE = 0o400
TEMP_MODE = 0o600
DEFAULT_MEDIA_TYPE = "application/octet-stream"
DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}")
PATH_INVALID = "artifact_snapshot_path_invalid"
SOURCE_CHANGED = "artifact_snapshot_source_changed"
INTEGRITY_MISMATCH = "artifact_snapshot_integrity_mismatch"
TOO_LARGE = "artifact_snapshot_too_large"
UNAVAILABLE = ArtifactSnapshotFailure.UNAVAILABLE.value
WINDOWS_SHARING_VIOLATION = 32
WINDOWS_LOCK_VIOLATION = 33
WINDOWS_NOT_SUPPORTED = 50
WINDOWS_INVALID_FUNCTION = 1
CAPTURE_RETRY_DELAYS = (0.1, 0.2)
TEMP_PREFIX = ".capture-"
_COPY_LOCKS_GUARD = Lock()
_COPY_LOCKS: dict[tuple[str, str, str, str], Lock] = {}
logger = logging.getLogger(__name__)


def _signature(value: os.stat_result) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _failure_code(error: OSError) -> str:
    windows_code = getattr(error, "winerror", None)
    if windows_code in (WINDOWS_SHARING_VIOLATION, WINDOWS_LOCK_VIOLATION):
        return ArtifactSnapshotFailure.BUSY.value
    if error.errno in (errno.EACCES, errno.EPERM):
        return ArtifactSnapshotFailure.ACCESS_DENIED.value
    if error.errno == errno.ENOSPC:
        return ArtifactSnapshotFailure.DISK_FULL.value
    if windows_code in (WINDOWS_NOT_SUPPORTED, WINDOWS_INVALID_FUNCTION) or error.errno in (
        errno.ENOTSUP,
        errno.ENOSYS,
    ):
        return ArtifactSnapshotFailure.UNSUPPORTED.value
    return UNAVAILABLE


def _copy_lock(location: ArtifactStorageLocation, scope: ArtifactScope, digest: str) -> Lock:
    key = (location.database, scope.kind.value, scope.id, digest)
    with _COPY_LOCKS_GUARD:
        return _COPY_LOCKS.setdefault(key, Lock())


def _read_object(directory: DirectoryHandle, digest: str, marker: str = "") -> bytes:
    descriptor = directory.open(digest, os.O_RDONLY | NOFOLLOW | NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ContentError(PATH_INVALID)
        if marker and creation_marker(stream.fileno()) != marker:
            raise ContentError(INTEGRITY_MISMATCH)
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
    for attempt in range(len(CAPTURE_RETRY_DELAYS) + 1):
        try:
            return _capture_once(location, scope, source, expected_sha256=expected_sha256)
        except ContentError as error:
            if str(error) != ArtifactSnapshotFailure.BUSY.value or attempt == len(
                CAPTURE_RETRY_DELAYS
            ):
                raise
            logger.warning(
                "artifact_snapshot_retry attempt=%s delay=%s",
                attempt + 1,
                CAPTURE_RETRY_DELAYS[attempt],
            )
            time.sleep(CAPTURE_RETRY_DELAYS[attempt])
    raise ContentError(UNAVAILABLE)


def _capture_once(
    location: ArtifactStorageLocation,
    scope: ArtifactScope,
    source: Path,
    *,
    expected_sha256: str = "",
) -> VerifiedArtifactContent:
    root = Path(location.source_root).expanduser().resolve()
    try:
        relative = source.relative_to(root)
    except ValueError as error:
        raise ContentError(PATH_INVALID) from error
    if not relative.parts:
        raise ContentError(PATH_INVALID)
    try:
        with directory(root, relative.parts[:-1]) as parent:
            identity = parent.stat(relative.name)
        if _linked(identity):
            raise ContentError(PATH_INVALID)
        if stat.S_ISDIR(identity.st_mode):
            return _capture_directory_once(location, scope, source, expected_sha256=expected_sha256)
    except OSError as error:
        logger.exception(
            "artifact_snapshot_capture_failed errno=%s winerror=%s",
            error.errno,
            getattr(error, "winerror", None),
        )
        raise ContentError(_failure_code(error)) from error
    return _capture_file_once(location, scope, source, expected_sha256=expected_sha256)


def _capture_file_once(
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
                        prefix = b""
                        with os.fdopen(os.dup(output), "wb") as target:
                            while chunk := source_stream.read(CHUNK_BYTES):
                                if not prefix:
                                    prefix = chunk[:CONTENT_SNIFF_BYTES]
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
            media_type=guess_media_type(relative.name, prefix) or DEFAULT_MEDIA_TYPE,
            size=size,
            sha256=value,
        )
    except OSError as exc:
        logger.exception(
            "artifact_snapshot_capture_failed errno=%s winerror=%s",
            exc.errno,
            getattr(exc, "winerror", None),
        )
        raise ContentError(_failure_code(exc)) from exc


def _linked(identity: os.stat_result) -> bool:
    return stat.S_ISLNK(identity.st_mode) or bool(
        getattr(identity, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT
    )


def _directory_inventory(
    location: ArtifactStorageLocation, source: Path
) -> dict[str, tuple[int, ...]]:
    root = Path(location.source_root).expanduser().resolve()
    relative = source.relative_to(root)
    inventory: dict[str, tuple[int, ...]] = {}
    total = 0

    def visit(parent: DirectoryHandle, name: str, prefix: str, depth: int) -> None:
        nonlocal total
        if depth > MAX_DIRECTORY_DEPTH or len(inventory) > MAX_DIRECTORY_ENTRIES:
            raise ContentError(TOO_LARGE)
        identity = parent.stat(name)
        if _linked(identity):
            raise ContentError(PATH_INVALID)
        if not prefix and not stat.S_ISDIR(identity.st_mode):
            raise ContentError(SOURCE_CHANGED)
        inventory[prefix] = (identity.st_mode, *_signature(identity))
        if stat.S_ISDIR(identity.st_mode):
            child = parent.directory(name)
            try:
                if child.identity() != (identity.st_dev, identity.st_ino):
                    raise ContentError(SOURCE_CHANGED)
                try:
                    names = child.names(MAX_DIRECTORY_ENTRIES + 1)
                except OSError as error:
                    if error.errno == errno.ENOSPC:
                        raise ContentError(TOO_LARGE) from error
                    raise
                for member in sorted(names):
                    if (
                        not member
                        or member in {".", ".."}
                        or any(value in member for value in ("/", "\\", ":", "\x00"))
                    ):
                        raise ContentError(PATH_INVALID)
                    visit(child, member, f"{prefix}/{member}" if prefix else member, depth + 1)
            finally:
                child.close()
        elif stat.S_ISREG(identity.st_mode):
            total += identity.st_size
            if total > MAX_ARTIFACT_BYTES:
                raise ContentError(TOO_LARGE)
        else:
            raise ContentError(PATH_INVALID)

    with directory(root, relative.parts[:-1]) as parent:
        visit(parent, relative.name, "", 0)
    if len(inventory) - 1 > MAX_DIRECTORY_ENTRIES:
        raise ContentError(TOO_LARGE)
    return inventory


def _store_payload(location: ArtifactStorageLocation, scope: ArtifactScope, payload: bytes) -> str:
    digest = hashlib.sha256(payload).hexdigest()
    with directory(
        Path(location.storage_root), Path(location.objects_relative).parts, create=True
    ) as objects:
        name = f"{TEMP_PREFIX}{uuid.uuid4().hex}"
        descriptor = objects.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | NOFOLLOW, TEMP_MODE)
        try:
            with os.fdopen(os.dup(descriptor), "wb") as stream:
                stream.write(payload)
                stream.flush()
                preserve_mode(stream.fileno(), OBJECT_MODE)
                os.fsync(stream.fileno())
            _publish_object(location, scope, objects, descriptor, digest, len(payload))
        finally:
            try:
                identity = os.fstat(descriptor)
                objects.unlink(name, expected=identity)
            finally:
                os.close(descriptor)
    return digest


def _capture_directory_once(
    location: ArtifactStorageLocation,
    scope: ArtifactScope,
    source: Path,
    *,
    expected_sha256: str = "",
) -> VerifiedArtifactContent:
    if expected_sha256 and not DIGEST_PATTERN.fullmatch(expected_sha256):
        raise ContentError(PATH_INVALID)
    objects = Path(location.storage_root) / location.objects_relative
    if objects.is_relative_to(source):
        raise ContentError(PATH_INVALID)
    before = _directory_inventory(location, source)
    entries: list[ArtifactDirectoryEntry | ArtifactFileEntry] = []
    total = 0
    for path, identity in sorted(before.items()):
        if not path:
            continue
        if stat.S_ISDIR(identity[0]):
            entries.append(ArtifactDirectoryEntry(path))
        else:
            content = _capture_file_once(location, scope, source / path)
            entries.append(
                ArtifactFileEntry(path, content.sha256, content.size, content.media_type)
            )
            total += content.size
            if total > MAX_ARTIFACT_BYTES:
                raise ContentError(TOO_LARGE)
    if before != _directory_inventory(location, source):
        raise ContentError(SOURCE_CHANGED)
    value = ArtifactDirectoryManifest(tuple(entries), total, DIRECTORY_MANIFEST_VERSION)
    try:
        payload = json.dumps(
            asdict(value), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
    except UnicodeError as error:
        raise ContentError(PATH_INVALID) from error
    digest = hashlib.sha256(payload).hexdigest()
    if expected_sha256 and expected_sha256 != digest:
        raise ContentError(SOURCE_CHANGED)
    _store_payload(location, scope, payload)
    relative = source.relative_to(Path(location.source_root).expanduser().resolve())
    return VerifiedArtifactContent(
        scope,
        relative.as_posix(),
        relative.name,
        DIRECTORY_MEDIA_TYPE,
        len(payload),
        digest,
        ArtifactContentKind.DIRECTORY,
    )


def manifest(
    location: ArtifactStorageLocation, content: VerifiedArtifactContent
) -> ArtifactDirectoryManifest:
    if content.kind != ArtifactContentKind.DIRECTORY:
        raise ContentError(PATH_INVALID)
    try:
        payload = read(location, content)
        raw = json.loads(payload)
        if (
            set(raw) != {"version", "total_size", "entries"}
            or raw["version"] != DIRECTORY_MANIFEST_VERSION
            or not isinstance(raw["entries"], list)
            or len(raw["entries"]) > MAX_DIRECTORY_ENTRIES
        ):
            raise ValueError(INTEGRITY_MISMATCH)
        entries: list[ArtifactDirectoryEntry | ArtifactFileEntry] = []
        directories = {""}
        previous = ""
        total = 0
        for value in raw["entries"]:
            path = value["path"]
            if (
                not isinstance(path, str)
                or not path
                or path <= previous
                or path.startswith("/")
                or any(part in {"", ".", ".."} for part in path.split("/"))
                or any(char in path for char in ("\\", ":", "\x00"))
                or len(path.split("/")) > MAX_DIRECTORY_DEPTH
                or path.rpartition("/")[0] not in directories
            ):
                raise ValueError(INTEGRITY_MISMATCH)
            if value["kind"] == ArtifactContentKind.DIRECTORY:
                if set(value) != {"path", "kind"}:
                    raise ValueError(INTEGRITY_MISMATCH)
                entries.append(ArtifactDirectoryEntry(path))
                directories.add(path)
            elif value["kind"] == ArtifactContentKind.FILE:
                if (
                    set(value) != {"path", "kind", "sha256", "size", "media_type"}
                    or not isinstance(value["sha256"], str)
                    or not DIGEST_PATTERN.fullmatch(value["sha256"])
                    or (not isinstance(value["size"], int) or isinstance(value["size"], bool))
                    or not 0 <= value["size"] <= MAX_ARTIFACT_BYTES
                    or not isinstance(value["media_type"], str)
                    or not value["media_type"]
                ):
                    raise ValueError(INTEGRITY_MISMATCH)
                entries.append(
                    ArtifactFileEntry(path, value["sha256"], value["size"], value["media_type"])
                )
                total += value["size"]
            else:
                raise ValueError(INTEGRITY_MISMATCH)
            previous = path
        result = ArtifactDirectoryManifest(tuple(entries), total, DIRECTORY_MANIFEST_VERSION)
        if (
            total > MAX_ARTIFACT_BYTES
            or (not isinstance(raw["total_size"], int) or isinstance(raw["total_size"], bool))
            or raw["total_size"] != total
            or json.dumps(
                asdict(result), ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            != payload
        ):
            raise ValueError(INTEGRITY_MISMATCH)
        return result
    except (KeyError, TypeError, ValueError, UnicodeError) as error:
        raise ContentError(INTEGRITY_MISMATCH) from error


def remove(location: ArtifactStorageLocation, content: VerifiedArtifactContent) -> None:
    """Release a caller-proven unreferenced immutable snapshot, retaining unknown bytes."""
    if not DIGEST_PATTERN.fullmatch(content.sha256):
        raise ContentError(PATH_INVALID)
    with _copy_lock(location, content.scope, content.sha256):
        claim = snapshots.get(location.database, content.scope, content.sha256)
        if claim is None:
            try:
                with directory(
                    Path(location.storage_root), Path(location.objects_relative).parts
                ) as objects:
                    objects.stat(content.sha256)
            except FileNotFoundError:
                return
            raise ContentError(INTEGRITY_MISMATCH)
        try:
            with directory(
                Path(location.storage_root), Path(location.objects_relative).parts
            ) as objects:
                try:
                    _read_object(objects, content.sha256, claim.marker)
                except FileNotFoundError:
                    pass
                else:
                    objects.unlink(content.sha256, expected=objects.stat(content.sha256))
        except FileNotFoundError:
            pass
        snapshots.remove(location.database, content.scope, content.sha256, claim.marker)


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
        logger.exception(
            "artifact_snapshot_read_failed errno=%s winerror=%s",
            exc.errno,
            getattr(exc, "winerror", None),
        )
        raise ContentError(_failure_code(exc)) from exc
    if len(payload) != content.size:
        raise ContentError(INTEGRITY_MISMATCH)
    return payload
