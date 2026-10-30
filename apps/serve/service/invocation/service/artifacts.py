"""Workspace-bound artifact publication and download for one-shot runs."""

from __future__ import annotations

import mimetypes
import os
import stat
import tempfile
from collections.abc import Callable
from dataclasses import replace
from hashlib import sha256
from pathlib import Path
from typing import BinaryIO

from service.invocation.service.metadata import InvocationMetadata
from service.invocation.service.model import InvocationArtifact, InvocationRecord
from service.paths import ONE_SHOT_WORKSPACE_DIRNAME
from service.platform.bridge import ArtifactPublishFailure
from service.platform.storage import NOFOLLOW, canonical_root, open_directory

FILE_HASH_CHUNK_BYTES = 1024 * 1024
ARTIFACT_SPOOL_MEMORY_BYTES = 8 * 1024 * 1024
ARTIFACT_MAX_BYTES = 512 * 1024 * 1024
ARTIFACT_PATH_INVALID = "invocation_artifact_path_invalid"
ARTIFACT_FILE_NOT_FOUND = "invocation_artifact_file_not_found"
ARTIFACT_INTEGRITY_MISMATCH = "invocation_artifact_integrity_mismatch"
ARTIFACT_FILE_TOO_LARGE = "invocation_artifact_file_too_large"

FILE_OPEN_FLAGS = os.O_RDONLY | NOFOLLOW


class InvocationArtifactError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _ArtifactTooLarge(RuntimeError):
    pass


class InvocationArtifactService:
    def __init__(self, root: Path, metadata: InvocationMetadata) -> None:
        self._root = root
        self._metadata = metadata

    def publish(
        self,
        record: InvocationRecord,
        *,
        path: str,
        role: str,
        turn_id: str,
        validate: Callable[[bytes], None] | None = None,
        maximum_bytes: int = ARTIFACT_MAX_BYTES,
    ) -> tuple[InvocationRecord, InvocationArtifact]:
        try:
            relative = self._relative(path)
            handle = self._open_regular(Path(record.workspace), relative)
        except FileNotFoundError as error:
            raise ArtifactPublishFailure(ARTIFACT_FILE_NOT_FOUND) from error
        except (OSError, ValueError) as error:
            raise ArtifactPublishFailure(ARTIFACT_PATH_INVALID) from error
        try:
            with (
                handle,
                tempfile.SpooledTemporaryFile(max_size=ARTIFACT_SPOOL_MEMORY_BYTES) as snapshot,
            ):
                content_sha256, size_bytes = self._handle_digest(
                    handle,
                    snapshot if validate is not None else None,
                    maximum_bytes=maximum_bytes,
                )
                if validate is not None:
                    snapshot.seek(0)
                    validate(snapshot.read(maximum_bytes + 1))
        except _ArtifactTooLarge as error:
            raise ArtifactPublishFailure(ARTIFACT_FILE_TOO_LARGE) from error
        artifact_id = sha256(
            f"{record.invocation_id}\0{turn_id}\0{relative}\0{role}\0{content_sha256}".encode(
                "utf-8"
            )
        ).hexdigest()
        artifact = InvocationArtifact(
            artifact_id=artifact_id,
            relative_path=relative,
            role=role,
            mime_type=mimetypes.guess_type(Path(relative).name)[0] or "",
            size_bytes=size_bytes,
            content_sha256=content_sha256,
            vendor_turn_id=turn_id,
        )
        artifacts = tuple(
            existing
            for existing in record.artifacts
            if existing.artifact_id != artifact.artifact_id
        ) + (artifact,)
        updated = replace(record, artifacts=artifacts)
        self._metadata.write(updated)
        return updated, artifact

    def read(
        self,
        invocation_id: str,
        artifact_id: str,
        *,
        owner_id: str,
    ) -> tuple[InvocationArtifact, tempfile.SpooledTemporaryFile[bytes]]:
        workspace = self._workspace(invocation_id)
        record = self._metadata.read(invocation_id, workspace)
        artifact = (
            next(
                (row for row in record.artifacts if row.artifact_id == artifact_id),
                None,
            )
            if record is not None and record.owner_id == owner_id
            else None
        )
        if record is None or artifact is None or Path(record.workspace).resolve() != workspace:
            raise InvocationArtifactError(ARTIFACT_FILE_NOT_FOUND)
        try:
            source = self._open_regular(workspace, artifact.relative_path)
        except FileNotFoundError as error:
            raise InvocationArtifactError(ARTIFACT_FILE_NOT_FOUND) from error
        except (OSError, ValueError) as error:
            raise InvocationArtifactError(ARTIFACT_PATH_INVALID) from error
        snapshot = tempfile.SpooledTemporaryFile(max_size=ARTIFACT_SPOOL_MEMORY_BYTES)
        try:
            with source:
                content_sha256, _size_bytes = self._handle_digest(source, snapshot)
            snapshot.seek(0)
            if content_sha256 != artifact.content_sha256:
                raise InvocationArtifactError(ARTIFACT_INTEGRITY_MISMATCH)
            snapshot.seek(0)
            return artifact, snapshot
        except _ArtifactTooLarge as error:
            snapshot.close()
            raise InvocationArtifactError(ARTIFACT_FILE_TOO_LARGE) from error
        except Exception:
            snapshot.close()
            raise

    def is_current(self, record: InvocationRecord, artifact: InvocationArtifact) -> bool:
        try:
            with self._open_regular(Path(record.workspace), artifact.relative_path) as handle:
                content_sha256, _size_bytes = self._handle_digest(handle)
        except (OSError, ValueError, _ArtifactTooLarge):
            return False
        return content_sha256 == artifact.content_sha256

    def _workspace(self, invocation_id: str) -> Path:
        run = (self._root / invocation_id).resolve()
        if run.parent != self._root:
            raise InvocationArtifactError(ARTIFACT_FILE_NOT_FOUND)
        return run / ONE_SHOT_WORKSPACE_DIRNAME

    @staticmethod
    def _relative(path: str) -> str:
        candidate = Path(path)
        if (
            candidate.is_absolute()
            or not candidate.parts
            or any(part in {"", ".", ".."} for part in candidate.parts)
        ):
            raise ValueError(ARTIFACT_PATH_INVALID)
        return candidate.as_posix()

    @staticmethod
    def _open_regular(workspace: Path, relative_path: str) -> BinaryIO:
        parts = Path(relative_path).parts
        if not parts or any(part in {"", ".", ".."} for part in parts):
            raise ValueError(ARTIFACT_PATH_INVALID)
        directory = None
        file_descriptor = -1
        try:
            directory = open_directory(canonical_root(workspace), tuple(parts[:-1]))
            file_descriptor = directory.open(parts[-1], FILE_OPEN_FLAGS)
            if not stat.S_ISREG(os.fstat(file_descriptor).st_mode):
                raise ValueError(ARTIFACT_PATH_INVALID)
            handle = os.fdopen(file_descriptor, "rb")
            file_descriptor = -1
            return handle
        finally:
            if file_descriptor >= 0:
                os.close(file_descriptor)
            if directory is not None:
                directory.close()

    @staticmethod
    def _handle_digest(
        handle: BinaryIO,
        sink: tempfile.SpooledTemporaryFile[bytes] | None = None,
        *,
        maximum_bytes: int = ARTIFACT_MAX_BYTES,
    ) -> tuple[str, int]:
        digest = sha256()
        size_bytes = 0
        while chunk := handle.read(FILE_HASH_CHUNK_BYTES):
            size_bytes += len(chunk)
            if size_bytes > min(maximum_bytes, ARTIFACT_MAX_BYTES):
                raise _ArtifactTooLarge
            digest.update(chunk)
            if sink is not None:
                sink.write(chunk)
        return digest.hexdigest(), size_bytes


__all__ = [
    "ARTIFACT_FILE_NOT_FOUND",
    "ARTIFACT_INTEGRITY_MISMATCH",
    "ARTIFACT_FILE_TOO_LARGE",
    "ARTIFACT_PATH_INVALID",
    "InvocationArtifactError",
    "InvocationArtifactService",
]
