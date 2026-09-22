"""Global newest-N retention planning and confirmed application."""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Callable
from uuid import uuid4

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE
from service.platform.content import ContentPort
from service.platform.resources import (
    DEFAULT_MAX_VERSION_FILE_SIZE_KB,
    MAX_MAX_VERSION_FILE_SIZE_KB,
    MAX_MAX_VERSIONS_PER_FILE,
    MIN_MAX_VERSION_FILE_SIZE_KB,
    MIN_MAX_VERSIONS_PER_FILE,
    MutableResourceVersionSettings,
)
from service.resources.domain.policy import (
    INVALID_VERSION_MODE_ERROR,
    VersionMode,
)
from service.resources.persistence.objects import CasEntryKind, CasStore
from service.resources.persistence.version import VersionStore, VersionStoreConflict
from service.resources.service.events import ResourceVersionEvent, emit

GC_GRACE_MILLISECONDS = 86_400_000
PROJECTS_UNAVAILABLE_ERROR = "projects_unavailable"
_log = logging.getLogger("scholarseed.resources.retention")


@dataclass(frozen=True)
class RetentionPreview:
    """Exact cross-project deletion impact bound by a confirmation token."""

    max_versions_per_file: int
    include_patterns: tuple[str, ...]
    ignore_patterns: tuple[str, ...]
    delete_versions: int
    delete_deliveries: int
    affected_files: int
    token: str
    mode: str = VersionMode.WHITELIST.value
    migration_required: bool = False
    added_paths: tuple[dict[str, str], ...] = ()
    removed_paths: tuple[dict[str, str], ...] = ()
    added_files: int = 0
    removed_files: int = 0
    max_file_size_kb: int = DEFAULT_MAX_VERSION_FILE_SIZE_KB


@dataclass(frozen=True)
class _ProjectPlan:
    project_id: str
    version_ids: tuple[str, ...]
    file_ids: tuple[str, ...]
    delivery_ids: tuple[str, ...]


class RetentionError(RuntimeError):
    """Stable retention validation or preflight error."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ResourceRetentionService:
    """Apply one global setting to every independent project ledger."""

    def __init__(self, content: ContentPort, settings: MutableResourceVersionSettings) -> None:
        self._content = content
        self._settings = settings
        self._policy_impact: (
            Callable[
                [str, tuple[str, ...], tuple[str, ...], int],
                tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]],
            ]
            | None
        ) = None

    def bind_policy_impact(
        self,
        impact: Callable[
            [str, tuple[str, ...], tuple[str, ...], int],
            tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]],
        ],
    ) -> None:
        """Bind Resources-owned scanning without importing its composition service."""
        self._policy_impact = impact

    def preview(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: str = VersionMode.WHITELIST.value,
        max_file_size_kb: int | None = None,
    ) -> RetentionPreview:
        """Calculate exact current impact without deleting any history."""

        self._validate(max_versions_per_file)
        file_size_kb = self._file_size(max_file_size_kb)
        includes = self._normalize_includes(include_patterns)
        ignores = self._normalize(ignore_patterns)
        if mode not in tuple(VersionMode):
            raise RetentionError(INVALID_VERSION_MODE_ERROR)
        try:
            added, removed = (
                self._policy_impact(mode, includes, ignores, file_size_kb)
                if self._policy_impact
                else ((), ())
            )
        except ContentError as exc:
            raise RetentionError(PROJECTS_UNAVAILABLE_ERROR) from exc
        all_plans = self._plans(max_versions_per_file)
        plans = all_plans if max_versions_per_file < self._settings.max_versions_per_file() else ()
        unsigned = {
            "current_policy": {
                "mode": self._settings.version_mode(),
                "include_patterns": self._settings.version_include_patterns(),
                "ignore_patterns": self._settings.version_ignore_patterns(),
                "max_versions_per_file": self._settings.max_versions_per_file(),
                "max_file_size_kb": self._settings.max_version_file_size_kb(),
            },
            "mode": mode,
            "migration_required": self._settings.version_migration_required(),
            "added": added,
            "removed": removed,
            "max_versions_per_file": max_versions_per_file,
            "max_file_size_kb": file_size_kb,
            "include_patterns": includes,
            "ignore_patterns": ignores,
            "projects": [
                {"project_id": plan.project_id, "version_ids": plan.version_ids} for plan in plans
            ],
            "delivery_ids": [delivery_id for plan in plans for delivery_id in plan.delivery_ids],
        }
        token = f"sha256:{sha256(self._canonical(unsigned)).hexdigest()}"
        preview = RetentionPreview(
            max_versions_per_file=max_versions_per_file,
            include_patterns=includes,
            ignore_patterns=ignores,
            delete_versions=sum(len(plan.version_ids) for plan in plans),
            delete_deliveries=sum(len(plan.delivery_ids) for plan in plans),
            affected_files=sum(len(plan.file_ids) for plan in plans),
            token=token,
            mode=mode,
            migration_required=self._settings.version_migration_required(),
            added_paths=tuple({"project_id": project, "path": path} for project, path in added),
            removed_paths=tuple({"project_id": project, "path": path} for project, path in removed),
            added_files=len(added),
            removed_files=len(removed),
            max_file_size_kb=file_size_kb,
        )
        emit(
            _log,
            ResourceVersionEvent.RETENTION_PREVIEW,
            delete_versions=preview.delete_versions,
            delete_deliveries=preview.delete_deliveries,
        )
        return preview

    def configure(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        mode: str = VersionMode.WHITELIST.value,
        max_file_size_kb: int | None = None,
    ) -> RetentionPreview:
        """Validate and persist settings without inspecting or mutating project history."""

        self._validate(max_versions_per_file)
        file_size_kb = self._file_size(max_file_size_kb)
        includes = self._normalize_includes(include_patterns)
        ignores = self._normalize(ignore_patterns)
        if mode not in tuple(VersionMode):
            raise RetentionError(INVALID_VERSION_MODE_ERROR)
        self._settings.set_file_version_settings(
            max_versions_per_file,
            includes,
            ignores,
            VersionMode(mode),
            max_file_size_kb=file_size_kb,
        )
        return RetentionPreview(
            max_versions_per_file,
            includes,
            ignores,
            0,
            0,
            0,
            "",
            mode=mode,
            max_file_size_kb=file_size_kb,
        )

    def apply(
        self,
        max_versions_per_file: int,
        include_patterns: tuple[str, ...],
        ignore_patterns: tuple[str, ...],
        token: str,
        mode: str = VersionMode.WHITELIST.value,
        max_file_size_kb: int | None = None,
    ) -> RetentionPreview:
        """Recheck preview, delete exact sets, then atomically persist global settings."""

        preview = self.preview(
            max_versions_per_file,
            include_patterns,
            ignore_patterns,
            mode,
            max_file_size_kb,
        )
        if preview.token != token:
            raise RetentionError("retention_preview_stale")
        plans = (
            self._plans(max_versions_per_file)
            if max_versions_per_file < self._settings.max_versions_per_file()
            else ()
        )
        try:
            for plan in plans:
                cas = self._cas(plan.project_id)
                with cas.writer():
                    self._store(plan.project_id).apply_retention(
                        plan.version_ids, plan.delivery_ids
                    )
                    self.collect(plan.project_id)
        except VersionStoreConflict as exc:
            raise RetentionError(exc.code) from exc
        self._settings.set_file_version_settings(
            max_versions_per_file,
            preview.include_patterns,
            preview.ignore_patterns,
            VersionMode(mode),
            max_file_size_kb=preview.max_file_size_kb,
        )
        emit(
            _log,
            ResourceVersionEvent.RETENTION_APPLIED,
            delete_versions=preview.delete_versions,
            delete_deliveries=preview.delete_deliveries,
        )
        return preview

    def _file_size(self, value: int | None) -> int:
        file_size_kb = self._settings.max_version_file_size_kb() if value is None else value
        if not (
            isinstance(file_size_kb, int)
            and not isinstance(file_size_kb, bool)
            and MIN_MAX_VERSION_FILE_SIZE_KB <= file_size_kb <= MAX_MAX_VERSION_FILE_SIZE_KB
        ):
            raise RetentionError("invalid_max_file_size")
        return file_size_kb

    @staticmethod
    def _normalize(patterns: tuple[str, ...]) -> tuple[str, ...]:
        return tuple(line for item in patterns if (line := str(item).strip()))

    def _normalize_includes(self, patterns: tuple[str, ...]) -> tuple[str, ...]:
        normalized = self._normalize(patterns)
        return normalized

    def collect(
        self,
        project_id: str,
        *,
        now_ms: int | None = None,
        grace_ms: int = GC_GRACE_MILLISECONDS,
    ) -> int:
        """Mark unreachable entries, then delete them after the recovery grace period."""

        cas = self._cas(project_id)
        timestamp = int(time.time() * 1000) if now_ms is None else now_ms
        transaction_id = uuid4().hex
        with cas.writer():
            plan = self._store(project_id).plan_gc(
                transaction_id,
                cas.inventory(CasEntryKind.OBJECT),
                cas.inventory(CasEntryKind.CHUNK),
                now_ms=timestamp,
                grace_ms=grace_ms,
            )
            emit(
                _log,
                ResourceVersionEvent.GC_MARKED,
                project_id=project_id,
                marked_entries=len(plan.trash) + len(plan.delete),
                transaction_id=transaction_id,
            )
            try:
                reclaimed = cas.apply_gc(plan)
            except OSError as exc:
                emit(
                    _log,
                    ResourceVersionEvent.GC_FAILED,
                    project_id=project_id,
                    result_code=type(exc).__name__,
                )
                raise
            emit(
                _log,
                ResourceVersionEvent.GC_TRASHED,
                project_id=project_id,
                trashed_entries=len(plan.trash),
                transaction_id=transaction_id,
            )
            emit(
                _log,
                ResourceVersionEvent.GC_DELETED,
                project_id=project_id,
                size_bytes=reclaimed,
                deleted_entries=len(plan.delete),
                transaction_id=transaction_id,
            )
            return reclaimed

    def enforce(self, project_id: str) -> int:
        """Apply the configured newest-N limit after a logical version mutation."""

        cas = self._cas(project_id)
        with cas.writer():
            store = self._store(project_id)
            version_ids, _file_ids, delivery_ids = store.retention_plan(
                self._settings.max_versions_per_file()
            )
            deleted = store.apply_retention(version_ids, delivery_ids)
            self.collect(project_id)
            return deleted

    def _plans(self, limit: int) -> tuple[_ProjectPlan, ...]:
        plans: list[_ProjectPlan] = []
        for project in self._content.projects():
            if not project.available:
                raise RetentionError(PROJECTS_UNAVAILABLE_ERROR)
            versions, files, deliveries = self._store(project.id).retention_plan(limit)
            plans.append(_ProjectPlan(project.id, versions, files, deliveries))
        return tuple(plans)

    def _store(self, project_id: str) -> VersionStore:
        return VersionStore(
            self._content.resolve(project_id, PROJECT_DB_RELATIVE),
            self._content.project(project_id).root,
        )

    def _cas(self, project_id: str) -> CasStore:
        return CasStore(
            self._content.resolve(project_id, PROJECT_VERSIONS_RELATIVE),
            project_root=self._content.project(project_id).root,
        )

    @staticmethod
    def _validate(limit: int) -> None:
        if not isinstance(limit, int) or not (
            MIN_MAX_VERSIONS_PER_FILE <= limit <= MAX_MAX_VERSIONS_PER_FILE
        ):
            raise RetentionError("invalid_max_versions")

    @staticmethod
    def _canonical(payload: dict) -> bytes:
        return json.dumps(
            payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")


__all__ = [
    "PROJECTS_UNAVAILABLE_ERROR",
    "ResourceRetentionService",
    "RetentionError",
    "RetentionPreview",
]
