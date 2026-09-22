"""Adaptive immutable CAS for project resource versions."""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import threading
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from enum import Enum
from hashlib import sha256
from pathlib import Path
from typing import BinaryIO, Iterator, Protocol, cast
from uuid import uuid4

from fastcdc import fastcdc  # type: ignore[import-untyped]

from service.platform.storage import NOFOLLOW, canonical_root, open_directory
from service.resources.persistence.chunks import (
    CHUNK_AVG_BYTES,
    CHUNK_MAX_BYTES,
    CHUNK_MIN_BYTES,
    CHUNKER_PROFILE,
    ChunkRef,
    digest,
    split,
)
from service.resources.persistence.codecs import WholeCodec, decode_whole, encode_whole


class _WindowsLockApi(Protocol):
    LK_LOCK: int
    LK_UNLCK: int

    def locking(self, descriptor: int, mode: int, byte_count: int) -> None: ...


if os.name == "nt":
    import msvcrt as _msvcrt

    windows_lock_api: _WindowsLockApi | None = cast(_WindowsLockApi, _msvcrt)
else:
    import fcntl

    windows_lock_api = None

CAS_FORMAT_VERSION = 1
MANIFEST_VERSION = 1
WHOLE_MAX_BYTES = 1024 * 1024
CHUNK_PREFERRED_MIN_BYTES = 8 * 1024 * 1024
TRANSITION_CHUNK_MIN_SAVING_RATIO = 0.10
LARGE_TEXT_WHOLE_MIN_SAVING_RATIO = 0.35
DESCRIPTOR_FILENAME = "meta.json"
PAYLOAD_FILENAME = "payload"
MANIFEST_FILENAME = "manifest.json"
WRITER_LOCK_FILENAME = "writer.lock"
CAS_FILE_MODE = 0o666
CAS_DURABLE_WRITE_PARENT_MISMATCH = "cas_durable_write_parent_mismatch"
CAS_DESCRIPTOR_CLEANUP_FAILED_NOTE = "descriptor cleanup failed: {error}"
TEXT_MEDIA_PREFIX = "text/"
TRASH_DIRECTORY = "trash"
CHUNK_PREFERRED_MEDIA_TYPES = frozenset(
    {
        "application/pdf",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
)

_PROCESS_LOCKS: dict[Path, threading.RLock] = {}
_PROCESS_LOCKS_GUARD = threading.Lock()
_LOCK_DEPTH = threading.local()


def _lock(stream: BinaryIO) -> None:
    if os.name == "nt":
        if windows_lock_api is None:
            raise RuntimeError("Windows CAS lock API is unavailable")
        stream.seek(0)
        if not stream.read(1):
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        windows_lock_api.locking(stream.fileno(), windows_lock_api.LK_LOCK, 1)
    else:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)


def _unlock(stream: BinaryIO) -> None:
    if os.name == "nt":
        if windows_lock_api is None:
            raise RuntimeError("Windows CAS lock API is unavailable")
        stream.seek(0)
        windows_lock_api.locking(stream.fileno(), windows_lock_api.LK_UNLCK, 1)
    else:
        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


class CasLayout(str, Enum):
    """Internal physical layouts hidden behind object_id."""

    WHOLE = "WHOLE"
    CHUNKED = "CHUNKED"


class CasEntryKind(str, Enum):
    """Physical CAS entity types collected independently."""

    OBJECT = "object"
    CHUNK = "chunk"


class CasCorruptError(RuntimeError):
    """A published CAS representation failed integrity verification."""


@dataclass(frozen=True)
class ObjectDescriptor:
    """Self-describing immutable object metadata."""

    format_version: int
    object_id: str
    layout: CasLayout
    codec: WholeCodec | str
    raw_size_bytes: int
    stored_size_bytes: int
    descriptor_digest: str
    payload_digest: str | None = None
    manifest_digest: str | None = None
    chunks: tuple[ChunkRef, ...] = ()


@dataclass(frozen=True)
class GcEntry:
    """One idempotent physical CAS transition."""

    kind: CasEntryKind
    identifier: str
    trash_epoch: str


@dataclass(frozen=True)
class GcPlan:
    """Ledger-derived mark/sweep actions for one collection pass."""

    trash: tuple[GcEntry, ...]
    delete: tuple[GcEntry, ...]


def _canonical(payload: object) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _hex(identifier: str) -> str:
    prefix, separator, value = identifier.partition(":")
    if prefix != "sha256" or separator != ":" or len(value) != 64:
        raise CasCorruptError("invalid_object_id")
    return value


def _fsync_directory(path: Path) -> None:
    directory = open_directory(canonical_root(path), ())
    try:
        directory.sync()
    finally:
        directory.close()


def _write_durable_files(parent: Path, files: tuple[tuple[Path, bytes], ...]) -> None:
    """Write new CAS leaves durably without reopening them read-only.

    Windows ``os.fsync`` rejects a CRT descriptor backed by a read-only handle.
    CAS staging owns these fresh leaves, so keep each writable descriptor open
    through write, flush and sync, then publish the parent directory through the
    shared platform boundary.
    """

    directory = open_directory(canonical_root(parent), ())
    try:
        for path, payload in files:
            if path.parent != parent:
                raise ValueError(CAS_DURABLE_WRITE_PARENT_MISMATCH)
            descriptor = directory.open(
                path.name,
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | NOFOLLOW,
                CAS_FILE_MODE,
            )
            try:
                stream = os.fdopen(descriptor, "wb")
            except BaseException as error:
                try:
                    os.close(descriptor)
                except OSError as cleanup_error:
                    error.add_note(CAS_DESCRIPTOR_CLEANUP_FAILED_NOTE.format(error=cleanup_error))
                raise
            with stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
        directory.sync()
    finally:
        directory.close()


def _ensure_directory(path: Path, project_root: Path | None) -> None:
    """Create CAS descendants without ever recreating a missing project root."""

    if project_root is None:
        path.mkdir(parents=True, exist_ok=True)
        return
    try:
        relative = path.relative_to(project_root)
    except ValueError as exc:
        raise ValueError("cas_path_outside_project") from exc
    if not project_root.is_dir():
        raise FileNotFoundError(project_root)
    current = project_root
    for part in relative.parts:
        current = current / part
        current.mkdir(exist_ok=True)


@contextmanager
def _exclusive(path: Path, project_root: Path | None) -> Iterator[None]:
    canonical = path.resolve()
    with _PROCESS_LOCKS_GUARD:
        process_lock = _PROCESS_LOCKS.setdefault(canonical, threading.RLock())
    with process_lock:
        depths = getattr(_LOCK_DEPTH, "paths", {})
        depth = depths.get(canonical, 0)
        if depth:
            depths[canonical] = depth + 1
            _LOCK_DEPTH.paths = depths
            try:
                yield
            finally:
                depths[canonical] -= 1
            return
        _ensure_directory(path.parent, project_root)
        stream = path.open("a+b")
        _lock(stream)
        depths[canonical] = 1
        _LOCK_DEPTH.paths = depths
        try:
            yield
        finally:
            depths.pop(canonical, None)
            _unlock(stream)
            stream.close()


class CasStore:
    """Publish, open and verify immutable raw-byte-addressed objects."""

    def __init__(self, root: Path | str, *, project_root: Path | str | None = None) -> None:
        self._root = Path(root)
        self._project_root = Path(project_root) if project_root is not None else None
        self._cas = self._root / "cas" / "v1"
        self._objects = self._cas / "objects" / "sha256"
        self._chunks = self._cas / "chunks" / "sha256"
        self._staging = self._root / "staging"
        self._lock = self._root / WRITER_LOCK_FILENAME

    def put(self, raw: bytes, media_hint: str = "application/octet-stream") -> str:
        """Publish raw bytes once and return their layout-independent identity."""

        object_id = digest(raw)
        with _exclusive(self._lock, self._project_root):
            target = self._object_path(object_id)
            if target.is_dir():
                self.verify(object_id)
                return object_id
            encoded = encode_whole(raw)
            chunked = split(raw) if len(raw) > WHOLE_MAX_BYTES else ()
            layout = self._choose_layout(raw, media_hint, encoded.payload, chunked)
            stage = self._staging / uuid4().hex / "object"
            try:
                _ensure_directory(stage, self._project_root)
                if layout is CasLayout.WHOLE:
                    self._publish_whole(stage, object_id, raw, encoded.codec, encoded.payload)
                else:
                    self._publish_chunks(chunked)
                    self._publish_chunked(stage, object_id, len(raw), chunked)
                _ensure_directory(target.parent, self._project_root)
                os.replace(stage, target)
                _fsync_directory(target.parent)
            finally:
                shutil.rmtree(stage.parent, ignore_errors=True)
            self.verify(object_id)
        return object_id

    def put_stream(
        self,
        raw: BinaryIO,
        *,
        raw_size_bytes: int,
        expected_object_id: str,
        media_hint: str = "application/octet-stream",
    ) -> str:
        """Publish a seekable stream without constructing the complete object in memory."""

        _hex(expected_object_id)
        if raw_size_bytes <= WHOLE_MAX_BYTES:
            raw.seek(0)
            payload = raw.read(raw_size_bytes + 1)
            if len(payload) != raw_size_bytes or digest(payload) != expected_object_id:
                raise CasCorruptError("object_digest_mismatch")
            return self.put(payload, media_hint)
        with _exclusive(self._lock, self._project_root):
            target = self._object_path(expected_object_id)
            if target.is_dir():
                descriptor = self.verify(expected_object_id)
                if descriptor.raw_size_bytes != raw_size_bytes:
                    raise CasCorruptError("object_size_mismatch")
                return expected_object_id
            stage = self._staging / uuid4().hex / "object"
            try:
                _ensure_directory(stage, self._project_root)
                chunks = self._publish_stream_chunks(
                    raw,
                    raw_size_bytes=raw_size_bytes,
                    expected_object_id=expected_object_id,
                )
                self._publish_chunked(
                    stage,
                    expected_object_id,
                    raw_size_bytes,
                    chunks,
                )
                _ensure_directory(target.parent, self._project_root)
                os.replace(stage, target)
                _fsync_directory(target.parent)
            finally:
                shutil.rmtree(stage.parent, ignore_errors=True)
            self.verify(expected_object_id)
        return expected_object_id

    @contextmanager
    def writer(self) -> Iterator[None]:
        """Serialize all version-domain writes for this project across processes."""

        with _exclusive(self._lock, self._project_root):
            yield

    @contextmanager
    def spool(self) -> Iterator[BinaryIO]:
        """Provide a same-filesystem seekable spool for stable content capture."""

        _ensure_directory(self._staging, self._project_root)
        with tempfile.TemporaryFile(dir=self._staging) as stream:
            yield stream

    def stage(self, object_id: str, transaction_id: str, ordinal: int) -> Path:
        """Durably materialize a verified object for a restore transaction."""

        directory = self._staging / transaction_id
        _ensure_directory(directory, self._project_root)
        target = directory / f"{ordinal}.raw"
        self.materialize(object_id, target)
        _fsync_directory(directory)
        return target

    @contextmanager
    def stage_stream(
        self,
        object_id: str,
        transaction_id: str,
        ordinal: int,
    ) -> Iterator[BinaryIO]:
        """Open one durably staged restore object without exposing an unbounded read."""

        target = self.stage(object_id, transaction_id, ordinal)
        with target.open("rb") as stream:
            yield stream

    def clear_stage(self, transaction_id: str) -> None:
        """Remove staging only after a restore is durably committed."""

        shutil.rmtree(self._staging / transaction_id, ignore_errors=True)

    def inventory(self, kind: CasEntryKind) -> frozenset[str]:
        """List canonical physical entries without trusting SQLite indexes."""

        root = self._objects if kind is CasEntryKind.OBJECT else self._chunks
        if not root.exists():
            return frozenset()
        return frozenset(
            f"sha256:{entry.name}"
            for prefix in root.iterdir()
            if prefix.is_dir()
            for entry in prefix.iterdir()
            if entry.is_dir() and len(entry.name) == 64
        )

    def apply_gc(self, plan: GcPlan) -> int:
        """Apply idempotent trash/delete actions while holding the project writer lock."""

        reclaimed = 0
        with self.writer():
            for entry in plan.trash:
                source = self._entry_path(entry.kind, entry.identifier)
                target = self._trash_path(entry)
                if not source.exists():
                    continue
                _ensure_directory(target.parent, self._project_root)
                if target.exists():
                    shutil.rmtree(source, ignore_errors=True)
                else:
                    os.replace(source, target)
                    _fsync_directory(target.parent)
            for entry in plan.delete:
                for target in (
                    self._entry_path(entry.kind, entry.identifier),
                    self._trash_path(entry),
                ):
                    reclaimed += self._directory_size(target)
                    shutil.rmtree(target, ignore_errors=True)
        return reclaimed

    def open(self, object_id: str) -> BinaryIO:
        """Return a verified raw-byte stream independent of physical layout."""

        return io.BytesIO(self._read_verified(object_id))

    def iter_bytes(self, object_id: str) -> Iterator[bytes]:
        """Yield verified original bytes with memory bounded by one physical chunk."""

        metadata = self.verify(object_id)
        if metadata.layout is CasLayout.WHOLE:
            yield self._read_verified(object_id, metadata)
            return
        yield from self._verified_chunks(metadata)

    def iter_range(self, object_id: str, start: int, end: int) -> Iterator[bytes]:
        """Yield one verified inclusive range with memory bounded by one physical chunk."""

        metadata = self.verify(object_id)
        if start < 0 or end < start or end >= metadata.raw_size_bytes:
            raise ValueError("invalid_object_range")
        if metadata.layout is CasLayout.WHOLE:
            yield self._read_verified(object_id, metadata)[start : end + 1]
            return
        for reference, payload in zip(
            metadata.chunks, self._verified_chunks(metadata), strict=True
        ):
            chunk_start = reference.raw_offset
            chunk_end = chunk_start + reference.raw_size_bytes - 1
            if chunk_end < start or chunk_start > end:
                continue
            yield payload[max(start - chunk_start, 0) : min(end - chunk_start + 1, len(payload))]

    def read_range(self, object_id: str, start: int, end: int) -> bytes:
        """Read one verified inclusive range for bounded in-process consumers."""

        return b"".join(self.iter_range(object_id, start, end))

    def materialize(self, object_id: str, target: Path | str) -> None:
        """Atomically materialize verified original bytes at a target path."""

        metadata = self._load_descriptor(object_id)
        destination = Path(target)
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                if metadata.layout is CasLayout.WHOLE:
                    stream.write(self._read_verified(object_id, metadata))
                else:
                    for payload in self._verified_chunks(metadata):
                        stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def verify(self, object_id: str) -> ObjectDescriptor:
        """Fail closed unless descriptor, payload/chunks and full bytes agree."""

        descriptor = self._load_descriptor(object_id)
        if descriptor.layout is CasLayout.WHOLE:
            self._read_verified(object_id, descriptor)
        else:
            for _payload in self._verified_chunks(descriptor):
                pass
        return descriptor

    def chunk_payload_path(self, chunk_id: str) -> Path:
        """Expose a chunk path for scrubbers and deterministic corruption tests."""

        return self._chunk_path(chunk_id) / PAYLOAD_FILENAME

    def _choose_layout(
        self,
        raw: bytes,
        media_hint: str,
        whole_payload: bytes,
        chunked: tuple[tuple[ChunkRef, bytes], ...],
    ) -> CasLayout:
        size = len(raw)
        if size <= WHOLE_MAX_BYTES:
            return CasLayout.WHOLE
        whole_saving = 1.0 - (len(whole_payload) / size) if size else 0.0
        if size >= CHUNK_PREFERRED_MIN_BYTES:
            if media_hint.startswith(TEXT_MEDIA_PREFIX):
                return (
                    CasLayout.WHOLE
                    if whole_saving >= LARGE_TEXT_WHOLE_MIN_SAVING_RATIO
                    else CasLayout.CHUNKED
                )
            if media_hint in CHUNK_PREFERRED_MEDIA_TYPES:
                return CasLayout.CHUNKED
        manifest_size = len(self._manifest_bytes(digest(raw), size, chunked))
        missing_size = sum(
            len(payload)
            for reference, payload in chunked
            if not self._chunk_path(reference.chunk_id).is_dir()
        )
        chunked_size = manifest_size + missing_size
        saving = 1.0 - (chunked_size / len(whole_payload)) if whole_payload else 0.0
        return CasLayout.CHUNKED if saving >= TRANSITION_CHUNK_MIN_SAVING_RATIO else CasLayout.WHOLE

    def _publish_whole(
        self,
        stage: Path,
        object_id: str,
        raw: bytes,
        codec: WholeCodec,
        payload: bytes,
    ) -> None:
        payload_path = stage / PAYLOAD_FILENAME
        descriptor: dict[str, object] = {
            "codec": codec.value,
            "format_version": CAS_FORMAT_VERSION,
            "layout": CasLayout.WHOLE.value,
            "object_id": object_id,
            "payload_digest": digest(payload),
            "raw_size_bytes": len(raw),
            "stored_size_bytes": len(payload),
        }
        _write_durable_files(
            stage,
            (
                (payload_path, payload),
                (stage / DESCRIPTOR_FILENAME, self._descriptor_bytes(descriptor)),
            ),
        )

    def _publish_chunks(self, chunks: tuple[tuple[ChunkRef, bytes], ...]) -> None:
        for reference, payload in chunks:
            target = self._chunk_path(reference.chunk_id)
            if target.is_dir():
                if self.chunk_payload_path(reference.chunk_id).read_bytes() != payload:
                    raise CasCorruptError("chunk_digest_mismatch")
                continue
            stage = self._staging / uuid4().hex / "chunk"
            try:
                _ensure_directory(stage, self._project_root)
                payload_path = stage / PAYLOAD_FILENAME
                metadata = {
                    "chunk_id": reference.chunk_id,
                    "codec": WholeCodec.IDENTITY.value,
                    "format_version": CAS_FORMAT_VERSION,
                    "raw_size_bytes": len(payload),
                    "stored_size_bytes": len(payload),
                }
                _write_durable_files(
                    stage,
                    (
                        (payload_path, payload),
                        (stage / DESCRIPTOR_FILENAME, self._descriptor_bytes(metadata)),
                    ),
                )
                _ensure_directory(target.parent, self._project_root)
                os.replace(stage, target)
                _fsync_directory(target.parent)
            finally:
                shutil.rmtree(stage.parent, ignore_errors=True)

    def _publish_stream_chunks(
        self,
        raw: BinaryIO,
        *,
        raw_size_bytes: int,
        expected_object_id: str,
    ) -> tuple[tuple[ChunkRef, bytes], ...]:
        references: list[tuple[ChunkRef, bytes]] = []
        object_digest = sha256()
        offset = 0
        raw.seek(0)
        for ordinal, chunk in enumerate(
            fastcdc(
                raw,
                min_size=CHUNK_MIN_BYTES,
                avg_size=CHUNK_AVG_BYTES,
                max_size=CHUNK_MAX_BYTES,
            )
        ):
            if chunk.offset != offset or chunk.length <= 0:
                raise CasCorruptError("chunk_order_mismatch")
            raw.seek(chunk.offset)
            payload = raw.read(chunk.length)
            if len(payload) != chunk.length:
                raise CasCorruptError("object_size_mismatch")
            object_digest.update(payload)
            reference = ChunkRef(
                ordinal=ordinal,
                chunk_id=digest(payload),
                raw_offset=chunk.offset,
                raw_size_bytes=chunk.length,
            )
            self._publish_chunks(((reference, payload),))
            references.append((reference, b""))
            offset += chunk.length
        if offset != raw_size_bytes:
            raise CasCorruptError("object_size_mismatch")
        if f"sha256:{object_digest.hexdigest()}" != expected_object_id:
            raise CasCorruptError("object_digest_mismatch")
        return tuple(references)

    def _publish_chunked(
        self,
        stage: Path,
        object_id: str,
        raw_size_bytes: int,
        chunks: tuple[tuple[ChunkRef, bytes], ...],
    ) -> None:
        manifest = self._manifest_bytes(object_id, raw_size_bytes, chunks)
        manifest_path = stage / MANIFEST_FILENAME
        descriptor = {
            "codec": "MANIFEST",
            "format_version": CAS_FORMAT_VERSION,
            "layout": CasLayout.CHUNKED.value,
            "manifest_digest": digest(manifest),
            "object_id": object_id,
            "raw_size_bytes": raw_size_bytes,
            "stored_size_bytes": len(manifest),
        }
        _write_durable_files(
            stage,
            (
                (manifest_path, manifest),
                (stage / DESCRIPTOR_FILENAME, self._descriptor_bytes(descriptor)),
            ),
        )

    @staticmethod
    def _manifest_bytes(
        object_id: str,
        raw_size: int,
        chunks: tuple[tuple[ChunkRef, bytes], ...],
    ) -> bytes:
        return _canonical(
            {
                "chunker_profile": CHUNKER_PROFILE,
                "chunks": [asdict(reference) for reference, _payload in chunks],
                "manifest_version": MANIFEST_VERSION,
                "object_id": object_id,
                "raw_size_bytes": raw_size,
            }
        )

    @staticmethod
    def _descriptor_bytes(descriptor: dict[str, object]) -> bytes:
        body = dict(descriptor)
        body["descriptor_digest"] = digest(_canonical(descriptor))
        return _canonical(body)

    def _load_descriptor(self, object_id: str) -> ObjectDescriptor:
        path = self._object_path(object_id) / DESCRIPTOR_FILENAME
        try:
            body = json.loads(path.read_text(encoding="utf-8"))
            recorded_digest = str(body.pop("descriptor_digest"))
            if recorded_digest != digest(_canonical(body)):
                raise CasCorruptError("descriptor_digest_mismatch")
            if body.get("object_id") != object_id:
                raise CasCorruptError("descriptor_object_mismatch")
            layout = CasLayout(str(body["layout"]))
            chunks: tuple[ChunkRef, ...] = ()
            if layout is CasLayout.CHUNKED:
                manifest_bytes = (self._object_path(object_id) / MANIFEST_FILENAME).read_bytes()
                if digest(manifest_bytes) != body.get("manifest_digest"):
                    raise CasCorruptError("manifest_digest_mismatch")
                manifest = json.loads(manifest_bytes)
                if (
                    manifest.get("manifest_version") != MANIFEST_VERSION
                    or manifest.get("chunker_profile") != CHUNKER_PROFILE
                    or manifest.get("object_id") != object_id
                    or manifest.get("raw_size_bytes") != body.get("raw_size_bytes")
                ):
                    raise CasCorruptError("invalid_manifest")
                chunks = tuple(ChunkRef(**item) for item in manifest.get("chunks", ()))
            codec_value = str(body["codec"])
            codec: WholeCodec | str = (
                WholeCodec(codec_value) if layout is CasLayout.WHOLE else codec_value
            )
            return ObjectDescriptor(
                format_version=int(body["format_version"]),
                object_id=object_id,
                layout=layout,
                codec=codec,
                raw_size_bytes=int(body["raw_size_bytes"]),
                stored_size_bytes=int(body["stored_size_bytes"]),
                descriptor_digest=recorded_digest,
                payload_digest=body.get("payload_digest"),
                manifest_digest=body.get("manifest_digest"),
                chunks=chunks,
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise CasCorruptError("invalid_descriptor") from exc

    def _read_verified(
        self,
        object_id: str,
        descriptor: ObjectDescriptor | None = None,
    ) -> bytes:
        metadata = descriptor or self._load_descriptor(object_id)
        try:
            if metadata.layout is CasLayout.WHOLE:
                payload = (self._object_path(object_id) / PAYLOAD_FILENAME).read_bytes()
                if digest(payload) != metadata.payload_digest:
                    raise CasCorruptError("payload_digest_mismatch")
                raw = decode_whole(payload, WholeCodec(metadata.codec), metadata.raw_size_bytes)
            else:
                raw = b"".join(self._verified_chunks(metadata))
        except OSError as exc:
            raise CasCorruptError("cas_payload_missing") from exc
        if len(raw) != metadata.raw_size_bytes or digest(raw) != object_id:
            raise CasCorruptError("object_digest_mismatch")
        return raw

    def _verified_chunks(self, metadata: ObjectDescriptor) -> Iterator[bytes]:
        object_digest = sha256()
        offset = 0
        try:
            for ordinal, reference in enumerate(metadata.chunks):
                if reference.ordinal != ordinal or reference.raw_offset != offset:
                    raise CasCorruptError("chunk_order_mismatch")
                payload = self.chunk_payload_path(reference.chunk_id).read_bytes()
                if (
                    len(payload) != reference.raw_size_bytes
                    or digest(payload) != reference.chunk_id
                ):
                    raise CasCorruptError("chunk_digest_mismatch")
                object_digest.update(payload)
                offset += len(payload)
                yield payload
        except OSError as exc:
            raise CasCorruptError("cas_payload_missing") from exc
        if offset != metadata.raw_size_bytes:
            raise CasCorruptError("object_size_mismatch")
        if f"sha256:{object_digest.hexdigest()}" != metadata.object_id:
            raise CasCorruptError("object_digest_mismatch")

    def _object_path(self, object_id: str) -> Path:
        value = _hex(object_id)
        return self._objects / value[:2] / value

    def _chunk_path(self, chunk_id: str) -> Path:
        value = _hex(chunk_id)
        return self._chunks / value[:2] / value

    def _entry_path(self, kind: CasEntryKind, identifier: str) -> Path:
        return (
            self._object_path(identifier)
            if kind is CasEntryKind.OBJECT
            else self._chunk_path(identifier)
        )

    def _trash_path(self, entry: GcEntry) -> Path:
        value = _hex(entry.identifier)
        return (
            self._root
            / TRASH_DIRECTORY
            / entry.trash_epoch
            / f"{entry.kind.value}s"
            / value[:2]
            / value
        )

    @staticmethod
    def _directory_size(path: Path) -> int:
        if not path.exists():
            return 0
        return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


__all__ = [
    "CAS_FORMAT_VERSION",
    "CHUNK_PREFERRED_MIN_BYTES",
    "CasCorruptError",
    "CasEntryKind",
    "CasLayout",
    "CasStore",
    "GcEntry",
    "GcPlan",
    "ObjectDescriptor",
    "WHOLE_MAX_BYTES",
]
