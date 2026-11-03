"""Authorized content reads for structured, session-scoped artifacts."""

from __future__ import annotations

import mimetypes
import os
import stat
import tempfile
import threading
import uuid
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PureWindowsPath
from typing import Any, BinaryIO

from service.chat.constants import (
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_ARTIFACT_UPSERT,
    PRODUCT_EVENT_FILE_CHANGED,
)
from service.chat.persistence.artifacts import (
    ArtifactSource,
    ArtifactStatus,
    SessionArtifactRecord,
    SessionArtifactStore,
    artifact_identity,
    current_artifact_records,
)
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.runtime.projection import ARTIFACT_CHANGE_UPDATE, artifact_payload
from service.content.domain.model import ContentError
from service.platform.content import (
    ArtifactScope,
    ArtifactScopeKind,
    ContentPort,
    VerifiedArtifactContent,
)
from service.platform.files import export_file_name, guess_media_type
from service.platform.limits import DOCUMENT_PREVIEW_MAX_BYTES
from service.platform.storage import NOFOLLOW, NONBLOCK, open_directory, preserve_mode
from service.platform.workbench import DocumentFormatPort

ARTIFACT_TEXT_MAX_BYTES = 512 * 1024
ARTIFACT_RAW_MAX_BYTES = 16 * 1024 * 1024
ARTIFACT_PREVIEW_MAX_BYTES = DOCUMENT_PREVIEW_MAX_BYTES
ARTIFACT_HASH_CHUNK_BYTES = 64 * 1024
ARTIFACT_EXPORT_MAX_BYTES = 128 * 1024 * 1024

ARTIFACT_NOT_FOUND = "session_artifact_not_found"
ARTIFACT_PATH_FORBIDDEN = "session_artifact_path_forbidden"
ARTIFACT_INTEGRITY_MISMATCH = "session_artifact_integrity_mismatch"
ARTIFACT_TOO_LARGE = "session_artifact_too_large"
ARTIFACT_REVISION_CONFLICT = "session_artifact_revision_conflict"
ARTIFACT_EDIT_UNAVAILABLE = "session_artifact_edit_unavailable"
ARTIFACT_PATH_AMBIGUOUS = "session_artifact_path_ambiguous"
ARTIFACT_PUBLICATION_REQUIRED = "session_artifact_publication_required"
ARTIFACT_REVISION_PREFIX = "sha256:"
ARTIFACT_EDIT_EVENT_KEY_PREFIX = "artifact-edit"
HASH_BOUND_ARTIFACT_SOURCES = frozenset(
    {
        ArtifactSource.STRUCTURED_TOOL,
        ArtifactSource.ARTIFACT_PUBLISH,
    }
)


class ArtifactReadError(RuntimeError):
    """Stable product error raised before any untrusted path is exposed."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ResolvedArtifact:
    """Authorized artifact bytes plus the durable event identity that produced them."""

    source_path: str
    artifact_id: str
    session_id: str
    turn_id: str | None
    item_id: str | None
    source_event_seq: int
    media_type: str | None


@dataclass(frozen=True)
class ArtifactWriteReceipt:
    """Committed mutable working-head revision and its product events."""

    revision: str
    events: tuple[ProductEventRecord, ...]


@dataclass(frozen=True)
class ArtifactDocument:
    body: bytes | BinaryIO
    media_type: str
    editable: bool
    revision: str
    size: int


class ArtifactService:
    """Authorize reads and guarded edits for session-attributed artifacts."""

    def __init__(
        self,
        catalog: SessionCatalogStore,
        artifacts: SessionArtifactStore,
        events: ProductEventStore,
        formats: DocumentFormatPort,
    ) -> None:
        self._catalog = catalog
        self._artifacts = artifacts
        self._events = events
        self._formats = formats
        self._content: ContentPort | None = None
        self._write_locks: dict[str, threading.Lock] = {}
        self._write_locks_guard = threading.Lock()

    def bind_content(self, content: ContentPort) -> None:
        self._content = content

    def _published_bytes(self, record: SessionArtifactRecord) -> bytes:
        raw = record.metadata.get("content")
        if self._content is None or not isinstance(raw, dict):
            raise ArtifactReadError(ARTIFACT_NOT_FOUND)
        try:
            value = dict(raw)
            scope = value.pop("scope")
            handle = VerifiedArtifactContent(
                scope=ArtifactScope(ArtifactScopeKind(scope["kind"]), scope["id"]), **value
            )
            if (
                handle.scope.kind is ArtifactScopeKind.SESSION
                and handle.scope.id != record.session_id
            ):
                raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN)
            if handle.sha256 != record.content_sha256 or handle.size != record.size_bytes:
                raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH)
            return self._content.read_artifact(handle)
        except (KeyError, TypeError, ValueError, ContentError) as error:
            raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH) from error

    def export_bytes(
        self, session_id: str, artifact_id: str, expected_sha256: str | None = None
    ) -> tuple[bytes, str]:
        record = self._record(session_id, artifact_id)
        if record.status is ArtifactStatus.PUBLISHED:
            raw = self._published_bytes(record)
        else:
            _, target = self._path(session_id, artifact_id)
            with target.open("rb") as stream:
                raw = stream.read(ARTIFACT_EXPORT_MAX_BYTES + 1)
            if len(raw) > ARTIFACT_EXPORT_MAX_BYTES:
                raise ArtifactReadError(ARTIFACT_TOO_LARGE)
            if (
                record.source_kind in HASH_BOUND_ARTIFACT_SOURCES
                and record.content_sha256
                and sha256(raw).hexdigest() != record.content_sha256
            ):
                raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH)
        if expected_sha256 and sha256(raw).hexdigest() != expected_sha256:
            raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
        return raw, export_file_name(Path(record.original_path).name, record.mime_type, raw)

    def published_artifact_id(
        self,
        session_id: str,
        workdir: Path,
        *,
        artifact_id: str | None = None,
        path: str | None = None,
        expected_sha256: str | None = None,
    ) -> str:
        if artifact_id is not None:
            record = self._record(session_id, artifact_id)
            if record.status is not ArtifactStatus.PUBLISHED:
                raise ArtifactReadError(ARTIFACT_PUBLICATION_REQUIRED)
            return artifact_id
        if path is None:
            raise ArtifactReadError(ARTIFACT_NOT_FOUND)
        relative = Path(path.replace("\\", "/"))
        if (
            relative.is_absolute()
            or PureWindowsPath(path).drive
            or ".." in relative.parts
            or "\x00" in path
        ):
            raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN)
        root = workdir.resolve()
        target = (root / relative).resolve()
        if not target.is_relative_to(root):
            raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN)
        candidates = tuple(
            record
            for record in current_artifact_records(self._artifacts.list_session(session_id))
            if record.status is ArtifactStatus.PUBLISHED
            and Path(record.canonical_path).resolve() == target
        )
        if not candidates:
            raise ArtifactReadError(ARTIFACT_NOT_FOUND)
        if expected_sha256 is not None:
            candidates = tuple(
                record for record in candidates if record.content_sha256 == expected_sha256
            )
            if not candidates:
                raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
        if len(candidates) != 1:
            raise ArtifactReadError(ARTIFACT_PATH_AMBIGUOUS)
        return artifact_identity(candidates[0])

    def export_document_bytes(
        self, session_id: str, artifact_id: str, expected_sha256: str | None = None
    ) -> tuple[bytes, str]:
        record = self._record(session_id, artifact_id)
        draft = self._artifacts.draft(record.artifact_id)
        if draft is None:
            return self.export_bytes(session_id, artifact_id, expected_sha256)
        if expected_sha256 and sha256(draft).hexdigest() != expected_sha256:
            raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
        return draft, export_file_name(Path(record.original_path).name, record.mime_type, draft)

    def _record(self, session_id: str, artifact_id: str) -> SessionArtifactRecord:
        records = current_artifact_records(self._artifacts.list_session(session_id))
        for record in records:
            if artifact_identity(record) == artifact_id:
                return record
        raise ArtifactReadError(ARTIFACT_NOT_FOUND)

    @staticmethod
    def _hash(path: Path) -> str:
        digest = sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(ARTIFACT_HASH_CHUNK_BYTES):
                digest.update(chunk)
        return digest.hexdigest()

    @staticmethod
    def _revision(raw: bytes) -> str:
        return f"{ARTIFACT_REVISION_PREFIX}{sha256(raw).hexdigest()}"

    def _editable(self, record: SessionArtifactRecord, content: bytes) -> bool:
        projection = self._formats.project(record.original_path, content)
        artifact_editable = projection.can_edit and projection.can_save
        if record.source_kind in {ArtifactSource.FILE_CHANGE, ArtifactSource.ARTIFACT_PUBLISH}:
            artifact_editable = artifact_editable or projection.can_edit_artifact
        return (
            record.source_kind is ArtifactSource.FILE_CHANGE
            or (
                record.source_kind is ArtifactSource.ARTIFACT_PUBLISH
                and record.status is ArtifactStatus.PUBLISHED
            )
        ) and artifact_editable

    def editable(self, session_id: str, artifact_id: str) -> bool:
        _content, _media_type, editable, _revision = self.read_document(session_id, artifact_id)
        return editable

    def read_document(self, session_id: str, artifact_id: str) -> tuple[bytes, str, bool, str]:
        record = self._record(session_id, artifact_id)
        content, _media_type = self.read_raw(session_id, artifact_id)
        editable = len(content) <= ARTIFACT_RAW_MAX_BYTES and self._editable(record, content)
        return content, _media_type, editable, self._revision(content)

    def open_document(self, session_id: str, artifact_id: str) -> ArtifactDocument:
        record = self._record(session_id, artifact_id)
        if record.status is ArtifactStatus.PUBLISHED:
            content, media_type, editable, revision = self.read_document(session_id, artifact_id)
            return ArtifactDocument(content, media_type, editable, revision, len(content))
        record, target = self._path(session_id, artifact_id)
        if target.stat().st_size <= ARTIFACT_RAW_MAX_BYTES:
            content, media_type, editable, revision = self.read_document(session_id, artifact_id)
            return ArtifactDocument(content, media_type, editable, revision, len(content))
        directory = open_directory(target.parent, ())
        try:
            descriptor = directory.open(target.name, os.O_RDONLY | NOFOLLOW | NONBLOCK)
        finally:
            directory.close()
        stream = os.fdopen(descriptor, "rb")
        try:
            identity = os.fstat(stream.fileno())
            if not stat.S_ISREG(identity.st_mode):
                raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN)
            if identity.st_size > ARTIFACT_PREVIEW_MAX_BYTES:
                raise ArtifactReadError(ARTIFACT_TOO_LARGE)
            digest = sha256()
            while chunk := stream.read(ARTIFACT_HASH_CHUNK_BYTES):
                digest.update(chunk)
            after = os.fstat(stream.fileno())
            if (identity.st_size, identity.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH)
            if (
                record.source_kind in HASH_BOUND_ARTIFACT_SOURCES
                and record.content_sha256 != digest.hexdigest()
            ):
                raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH)
            stream.seek(0)
            media_type = (
                record.mime_type or guess_media_type(target.name) or "application/octet-stream"
            )
            return ArtifactDocument(
                stream,
                media_type,
                False,
                f"{ARTIFACT_REVISION_PREFIX}{digest.hexdigest()}",
                identity.st_size,
            )
        except BaseException:
            stream.close()
            raise

    def _write_lock(self, target: Path) -> threading.Lock:
        key = str(target)
        with self._write_locks_guard:
            return self._write_locks.setdefault(key, threading.Lock())

    @staticmethod
    def _replace(target: Path, content: bytes, mode: int) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=target.parent
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                preserve_mode(stream.fileno(), mode)
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def _path(self, session_id: str, artifact_id: str) -> tuple[SessionArtifactRecord, Path]:
        record = self._record(session_id, artifact_id)
        session = self._catalog.get(session_id)
        if session is None:
            raise ArtifactReadError(ARTIFACT_NOT_FOUND)
        try:
            origin = self._events.workspace_for_sequence(session, record.source_product_seq)
        except ValueError as error:
            raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN) from error
        root = Path(origin.runtime_workdir).expanduser().resolve()
        target = Path(record.canonical_path).expanduser().resolve()
        try:
            target.relative_to(root)
        except ValueError as error:
            raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN) from error
        if not target.is_file():
            raise ArtifactReadError(ARTIFACT_NOT_FOUND)
        # fileChange identifies the current file at a session-owned path. A
        # later successful edit may legitimately replace its bytes while the
        # stable product artifact id continues to identify that path. Explicit
        # structured/published artifacts remain content-bound snapshots.
        if (
            record.source_kind in HASH_BOUND_ARTIFACT_SOURCES
            and record.content_sha256
            and self._hash(target) != record.content_sha256
        ):
            raise ArtifactReadError(ARTIFACT_INTEGRITY_MISMATCH)
        return record, target

    def read_text(self, session_id: str, artifact_id: str) -> dict[str, Any]:
        record = self._record(session_id, artifact_id)
        if record.status is ArtifactStatus.PUBLISHED:
            raw = self._published_bytes(record)
            truncated = len(raw) > ARTIFACT_TEXT_MAX_BYTES
            binary = b"\x00" in raw[:4096]
            return {
                "path": record.original_path,
                "size": len(raw),
                "binary": binary,
                "truncated": truncated,
                "content": "" if truncated or binary else raw.decode("utf-8", errors="replace"),
            }
        record, target = self._path(session_id, artifact_id)
        size = target.stat().st_size
        if size > ARTIFACT_TEXT_MAX_BYTES:
            return {
                "path": record.original_path,
                "size": size,
                "binary": False,
                "truncated": True,
                "content": "",
            }
        raw = target.read_bytes()
        binary = b"\x00" in raw[:4096]
        return {
            "path": record.original_path,
            "size": size,
            "binary": binary,
            "truncated": False,
            "content": "" if binary else raw.decode("utf-8", errors="replace"),
        }

    def source(
        self,
        session_id: str,
        artifact_id: str,
        expected_sha256: str | None = None,
    ) -> ResolvedArtifact:
        """返回经会话归属、根目录与内容完整性校验的内部来源。

        绝对路径只供后端组合服务复制文件，不会通过 HTTP 返回给 Renderer；
        其余字段让目标业务域能保留来源关系，而不必读取 chat 的数据库。
        """

        if self._record(session_id, artifact_id).status is ArtifactStatus.PUBLISHED:
            raise ArtifactReadError(ARTIFACT_PATH_FORBIDDEN)
        record, target = self._path(session_id, artifact_id)
        if expected_sha256 and self._hash(target) != expected_sha256:
            raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
        return ResolvedArtifact(
            source_path=str(target),
            artifact_id=artifact_id,
            session_id=record.session_id,
            turn_id=record.vendor_turn_id,
            item_id=record.vendor_item_id,
            source_event_seq=record.source_product_seq,
            media_type=record.mime_type,
        )

    def provenance(self, session_id: str, artifact_id: str) -> ResolvedArtifact:
        """Return attribution only; paths are not authority to read published bytes."""
        record = self._record(session_id, artifact_id)
        return ResolvedArtifact(
            source_path=record.original_path,
            artifact_id=artifact_id,
            session_id=record.session_id,
            turn_id=record.vendor_turn_id,
            item_id=record.vendor_item_id,
            source_event_seq=record.source_product_seq,
            media_type=record.mime_type,
        )

    def mark_saved(
        self,
        session_id: str,
        artifact_id: str,
        saved_to: str,
    ) -> SessionArtifactRecord:
        """Persist the resource destination on the current session artifact."""

        record = self._record(session_id, artifact_id)
        return self._artifacts.mark_saved(record.artifact_id, saved_to)

    def saved_to(self, session_id: str, artifact_id: str) -> str | None:
        """Return the persisted resource destination for the current artifact."""

        return self._record(session_id, artifact_id).saved_to

    def read_raw(self, session_id: str, artifact_id: str) -> tuple[bytes, str]:
        record = self._record(session_id, artifact_id)
        if record.status is ArtifactStatus.PUBLISHED:
            draft = self._artifacts.draft(record.artifact_id)
            raw = draft if draft is not None else self._published_bytes(record)
            if len(raw) > ARTIFACT_PREVIEW_MAX_BYTES:
                raise ArtifactReadError(ARTIFACT_TOO_LARGE)
            return raw, record.mime_type or "application/octet-stream"
        record, target = self._path(session_id, artifact_id)
        if target.stat().st_size > ARTIFACT_PREVIEW_MAX_BYTES:
            raise ArtifactReadError(ARTIFACT_TOO_LARGE)
        guessed = guess_media_type(target.name)
        return target.read_bytes(), record.mime_type or guessed or "application/octet-stream"

    def write_raw(
        self,
        session_id: str,
        artifact_id: str,
        content: bytes,
        expected_revision: str,
    ) -> ArtifactWriteReceipt:
        record = self._record(session_id, artifact_id)
        if (
            record.source_kind is ArtifactSource.ARTIFACT_PUBLISH
            and record.status is ArtifactStatus.PUBLISHED
        ):
            return self._write_draft(record, content, expected_revision)
        if record.source_kind is not ArtifactSource.FILE_CHANGE:
            raise ArtifactReadError(ARTIFACT_EDIT_UNAVAILABLE)
        record, target = self._path(session_id, artifact_id)
        if len(content) > ARTIFACT_RAW_MAX_BYTES:
            raise ArtifactReadError(ARTIFACT_TOO_LARGE)
        lock = self._write_lock(target)
        with lock:
            current = target.read_bytes()
            if self._revision(current) != expected_revision:
                raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
            if not self._editable(record, current) or not self._editable(record, content):
                raise ArtifactReadError(ARTIFACT_EDIT_UNAVAILABLE)
            mode = stat.S_IMODE(target.stat().st_mode)
            if self._revision(target.read_bytes()) != expected_revision:
                raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
            self._replace(target, content, mode)
            try:
                events = self._record_edit(record, content)
            except Exception:
                self._replace(target, current, mode)
                raise
        return ArtifactWriteReceipt(self._revision(content), events)

    def _write_draft(
        self, record: SessionArtifactRecord, content: bytes, expected_revision: str
    ) -> ArtifactWriteReceipt:
        if len(content) > ARTIFACT_RAW_MAX_BYTES:
            raise ArtifactReadError(ARTIFACT_TOO_LARGE)
        snapshot = self._published_bytes(record)
        with self._events.transaction() as connection:
            draft = self._artifacts.draft(record.artifact_id, connection=connection)
            current = draft if draft is not None else snapshot
            if self._revision(current) != expected_revision:
                raise ArtifactReadError(ARTIFACT_REVISION_CONFLICT)
            if not self._editable(record, current) or not self._editable(record, content):
                raise ArtifactReadError(ARTIFACT_EDIT_UNAVAILABLE)
            self._artifacts.save_draft(record.artifact_id, content, connection=connection)
            event = self._events.append(
                session_id=record.session_id,
                runtime_id=record.runtime_id,
                vendor_thread_id=record.vendor_thread_id,
                vendor_turn_id=record.vendor_turn_id,
                vendor_item_id=record.vendor_item_id,
                kind=PRODUCT_EVENT_ARTIFACT_CHANGED,
                payload={
                    "op": PRODUCT_EVENT_ARTIFACT_UPSERT,
                    "artifact": artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE),
                },
                idempotency_key=f"{ARTIFACT_EDIT_EVENT_KEY_PREFIX}:{uuid.uuid4().hex}",
                connection=connection,
            )
        return ArtifactWriteReceipt(self._revision(content), (event,))

    def _record_edit(
        self,
        previous: SessionArtifactRecord,
        content: bytes,
    ) -> tuple[ProductEventRecord, ...]:
        edit_id = uuid.uuid4().hex
        key = f"{ARTIFACT_EDIT_EVENT_KEY_PREFIX}:{edit_id}"
        with self._events.transaction() as connection:
            changed_file = self._events.append(
                session_id=previous.session_id,
                runtime_id=previous.runtime_id,
                vendor_thread_id=previous.vendor_thread_id,
                vendor_turn_id=previous.vendor_turn_id,
                vendor_item_id=previous.vendor_item_id,
                kind=PRODUCT_EVENT_FILE_CHANGED,
                payload={"change": ARTIFACT_CHANGE_UPDATE, "path": previous.original_path},
                idempotency_key=f"{key}:file",
                connection=connection,
            )
            record = self._artifacts.index(
                session_id=previous.session_id,
                runtime_id=previous.runtime_id,
                vendor_thread_id=previous.vendor_thread_id,
                vendor_turn_id=previous.vendor_turn_id,
                vendor_item_id=previous.vendor_item_id,
                source_kind=ArtifactSource.FILE_CHANGE,
                source_product_seq=changed_file.product_seq,
                original_path=previous.original_path,
                canonical_path=previous.canonical_path,
                role=previous.role,
                status=ArtifactStatus.COMPLETED,
                mime_type=previous.mime_type,
                content_sha256=sha256(content).hexdigest(),
                size_bytes=len(content),
                metadata={**previous.metadata, "change": ARTIFACT_CHANGE_UPDATE},
                saved_to=previous.saved_to,
                idempotency_key=f"{key}:record",
                connection=connection,
            )
            changed_artifact = self._events.append(
                session_id=previous.session_id,
                runtime_id=previous.runtime_id,
                vendor_thread_id=previous.vendor_thread_id,
                vendor_turn_id=previous.vendor_turn_id,
                vendor_item_id=previous.vendor_item_id,
                kind=PRODUCT_EVENT_ARTIFACT_CHANGED,
                payload={
                    "op": PRODUCT_EVENT_ARTIFACT_UPSERT,
                    "artifact": artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE),
                },
                idempotency_key=f"{key}:artifact",
                connection=connection,
            )
        return changed_file, changed_artifact
