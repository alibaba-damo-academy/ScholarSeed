"""Shared helpers for product session service operations."""

import logging
import os
import time
from collections.abc import Iterator
from contextlib import contextmanager
from enum import Enum
from pathlib import Path

from fastapi import HTTPException

from scholarseed_runtime.contract.artifact import ArtifactRole
from service.chat.persistence.artifacts import (
    ArtifactStatus,
    SessionArtifactRecord,
    current_artifact_records,
)
from service.chat.persistence.catalog import PendingTurnSettlement, SessionCatalogRecord
from service.chat.runtime.live import LiveSession
from service.paths import PROJECT_SESSION_OUTPUT_DIRNAME, SESSION_OUTPUT_DIRNAME
from service.platform.content import ArtifactContentKind
from service.platform.files import resolve_child

RESUME_TIMING_LOGGER = logging.getLogger(__name__).getChild("open_timing")


def is_resource_finalizing(
    live: LiveSession | None,
    record: SessionCatalogRecord | None,
    pending: PendingTurnSettlement | None,
) -> bool:
    return (
        live is not None
        and pending is not None
        and pending.resource_finalizing(
            record, live_terminal_turn_id=live.resource_finalizing_turn_id
        )
    )


def artifact_directory(
    records: tuple[SessionArtifactRecord, ...], root: Path, authorized_roots: tuple[Path, ...]
) -> str | None:
    current = current_artifact_records(records)
    outputs = tuple(
        record
        for record in current
        if record.status is ArtifactStatus.PUBLISHED
        and record.role in {ArtifactRole.FINAL.value, ArtifactRole.SUPPORTING.value}
    )
    candidates = outputs or current
    directories: list[Path] = []
    boundaries: list[Path] = []
    try:
        roots = sorted(
            {path.resolve(strict=True) for path in (root, *authorized_roots) if path.is_dir()},
            key=lambda path: (path != root, -len(path.parts)),
        )
        for record in candidates:
            target = Path(record.canonical_path)
            if (
                not target.is_absolute()
                or ".." in target.parts
                or any(ord(character) < 32 or ord(character) == 127 for character in str(target))
            ):
                return None
            boundary = next((path for path in roots if target.is_relative_to(path)), None)
            if boundary is None:
                return None
            target = resolve_child(boundary, target.relative_to(boundary).as_posix())
            content = record.metadata.get("content")
            directory = (
                isinstance(content, dict)
                and content.get("kind") == ArtifactContentKind.DIRECTORY.value
            )
            if not (target.is_dir() if directory else target.is_file()):
                return None
            selected = target if directory else target.parent
            relative = selected.relative_to(boundary)
            if len(relative.parts) >= 2 and relative.parts[0] in {
                PROJECT_SESSION_OUTPUT_DIRNAME,
                SESSION_OUTPUT_DIRNAME,
            }:
                selected = resolve_child(boundary, Path(*relative.parts[:2]).as_posix())
            directories.append(selected)
            boundaries.append(boundary)
        if not directories or len(set(boundaries)) != 1:
            return None
        selected = Path(os.path.commonpath(directories))
        if selected == root or selected == Path(selected.anchor):
            return None
        selected = resolve_child(boundaries[0], selected.relative_to(boundaries[0]).as_posix())
        return str(selected) if selected.is_dir() else None
    except (OSError, ValueError, HTTPException):
        return None


class ResumeStage(str, Enum):
    ACCESS = "access"
    PROJECT = "project"
    READINESS = "readiness"
    MODEL = "model"
    OPEN = "open"
    ACTIVATE = "activate"
    FORK = "fork"
    SNAPSHOT = "snapshot"


@contextmanager
def resume_stage(session_id: str, stage: ResumeStage) -> Iterator[None]:
    started = time.perf_counter()
    outcome = "ok"
    RESUME_TIMING_LOGGER.info(
        "session_resume_stage session_id=%s stage=%s event=started", session_id, stage.value
    )
    try:
        yield
    except BaseException as error:
        outcome = type(error).__name__
        raise
    finally:
        RESUME_TIMING_LOGGER.info(
            "session_resume_stage session_id=%s stage=%s event=finished duration_ms=%.1f outcome=%s",
            session_id,
            stage.value,
            (time.perf_counter() - started) * 1000,
            outcome,
        )
