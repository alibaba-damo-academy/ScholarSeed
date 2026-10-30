"""Actual resource owners on private startup ledgers and qualified content.

The composition caller retains every project, database parent and external root
for the whole operation. This module does not acquire authority, create source
storage, or replace the normal authorization result transaction.
"""

from __future__ import annotations

import io
import sqlite3
import time
from pathlib import Path
from typing import Callable

from service.content.domain.model import ContentError, resolve_root
from service.content.service import enumeration, repository, roots
from service.content.service.port import ContentService
from service.content.service.space import ProjectSpace
from service.platform.content import RootKind
from service.platform.resources import VERSION_MAX_BYTES, ManagementState, VersionOrigin
from service.resources.domain.policy import VersionPolicyInputs
from service.resources.domain.version import ObservationState, SnapshotVersion
from service.resources.persistence.inspection import (
    MAX_OBJECTS,
    MAX_SECONDS,
    MAX_TOTAL_BYTES,
    CasProjection,
)
from service.resources.persistence.objects import ObjectDescriptor
from service.resources.persistence.version import InitialVersionPlan, VersionStore
from service.resources.service.history import ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor

MAX_RECOVERY_ENTRIES = 65536


class ResourceProjection:
    """One recovery batch's bounded captures and private CAS namespaces."""

    def __init__(
        self, *, emit_file: Callable[[str, str, str, str, str, bytes], None] | None = None
    ) -> None:
        self._deadline = time.monotonic() + MAX_SECONDS
        self._captured_bytes = 0
        self._entries = 0
        self._failed = False
        self._cas: dict[str, CasProjection] = {}
        self._bindings: dict[str, tuple] = {}
        self._emit_file = emit_file

    def check(self) -> None:
        if self._failed:
            raise RuntimeError("resource recovery projection already failed")
        if time.monotonic() > self._deadline:
            raise ValueError("resource recovery exceeded time budget")
        if (
            self._captured_bytes + sum(cas.source_read_bytes for cas in self._cas.values())
            > MAX_TOTAL_BYTES
        ):
            raise ValueError("resource recovery exceeded read budget")
        if sum(cas.object_count for cas in self._cas.values()) > MAX_OBJECTS:
            raise ValueError("resource recovery exceeded object budget")

    def visit(self) -> None:
        self._entries += 1
        if self._entries > MAX_RECOVERY_ENTRIES:
            raise ValueError("resource recovery exceeded entry budget")
        self.check()

    def objects(self) -> tuple[tuple[str, tuple[ObjectDescriptor, ...]], ...]:
        self.check()
        return tuple((project, self._cas[project].descriptors()) for project in sorted(self._cas))

    def _capture(self, scope: ProjectSpace, path: str, cas: CasProjection):
        with _CaptureBuffer(self) as captured:
            source = ContentService.capture_from_space(
                scope, scope.project.id, path, VERSION_MAX_BYTES, captured, check=self.check
            )
            sink = self._emit_file
            emit = (
                None
                if sink is None
                else lambda kind, identifier, name, data: sink(
                    scope.project.id, source.revision, kind, identifier, name, data
                )
            )
            descriptor = cas.project_stream(
                captured,
                raw_size_bytes=source.size,
                expected_object_id=source.revision,
                emit_file=emit,
            )
            self.check()
            return source, descriptor

    def linked_root(
        self,
        scope: ProjectSpace,
        ledger: sqlite3.Connection,
        storage: Path | None,
        mount_path: str,
        *,
        policy: VersionPolicyInputs,
        default_patterns: tuple[str, ...],
        attempt: str,
        operation: str,
        now_ms: int,
    ) -> None:
        try:
            self._linked_root(
                scope,
                ledger,
                storage,
                mount_path,
                policy=policy,
                default_patterns=default_patterns,
                attempt=attempt,
                operation=operation,
                now_ms=now_ms,
            )
        except BaseException:
            self._failed = True
            raise

    def _linked_root(
        self,
        scope: ProjectSpace,
        ledger: sqlite3.Connection,
        storage: Path | None,
        mount_path: str,
        *,
        policy: VersionPolicyInputs,
        default_patterns: tuple[str, ...],
        attempt: str,
        operation: str,
        now_ms: int,
    ) -> None:
        self.check()
        if not ledger.in_transaction:
            raise ValueError("resource recovery requires a private transaction")
        root = mount_path.rstrip("/")
        if not root:
            return
        plan = InitialVersionPlan.for_recovery(
            attempt, operation, scope.project.id, root, now_ms=now_ms
        )
        binding = (scope.root, scope.mounts, storage, ledger)
        previous = self._bindings.get(scope.project.id)
        if previous is not None and previous != binding:
            raise ValueError("resource recovery project binding changed")
        cas = self._cas.get(scope.project.id)
        if cas is None:
            cas = CasProjection(storage)
            self._cas[scope.project.id] = cas
            self._bindings[scope.project.id] = binding
        owned = roots.registered_root_rows(ledger)
        resource_scope = ProjectSpace(
            scope.project, scope.mounts, owned_roots=owned, excluded_paths=tuple(owned.values())
        )
        managed = tuple(
            path
            for path in VersionStore.tracked_path_rows(ledger)
            if path == root or path.startswith(root + "/")
        )
        for path in managed:
            self.visit()
            if repository.repository_roots(resource_scope, (path,))[path] is not None:
                continue
            identity = VersionStore.identity_rows(ledger, path)
            if identity is None:
                continue
            try:
                source, descriptor = self._capture(scope, path, cas)
                observation = ResourceVersionService.captured_observation(source)
                snapshot: SnapshotVersion | None = ResourceVersionService._complete_snapshot(
                    path, source, descriptor.object_id, VersionOrigin.USER
                )
            except ContentError as error:
                observation = ResourceVersionService.failed_observation(error)
                snapshot = (
                    ResourceVersionService.deleted_snapshot(path)
                    if observation.state is ObservationState.TOMBSTONE
                    else None
                )
                descriptor = None
            VersionStore.reconcile_external_rows(
                ledger, identity[0], path, observation, snapshot, descriptor, now=now_ms
            )
        if root in managed or ContentService.directory_in_space(scope, root):
            return
        entries = enumeration.scan_files(resource_scope, check=self.visit)
        if repository.repository_roots(resource_scope, (root,))[root] is not None:
            return
        entry = next((entry for entry in entries if entry.path == root), None)
        if entry is None:
            return
        resource_root = resolve_root(scope.project, RootKind.RESOURCES).relative
        relative = ResourceVersionSupervisor._relative_to_root(root, resource_root)
        manual = VersionStore.manual_admitted_rows(ledger, (root,)).get(root, False)
        if (
            policy.classify(relative, entry.size, manual=manual, default_patterns=default_patterns)
            is not ManagementState.MANAGED
        ):
            return
        if not VersionStore.initial_version_state_rows(ledger, root).required:
            return
        source, descriptor = self._capture(scope, root, cas)
        snapshot = ResourceVersionService._complete_snapshot(
            root, source, descriptor.object_id, VersionOrigin.INITIAL_SCAN
        )
        VersionStore.initialize_first_rows(ledger, snapshot, descriptor, plan=plan)
        self.check()


class _CaptureBuffer(io.BytesIO):
    """Count every actual capture write, including unstable-read retries."""

    def __init__(self, projection: ResourceProjection):
        super().__init__()
        self._projection = projection

    def write(self, data):
        self._projection._captured_bytes += len(data)
        self._projection.check()
        return super().write(data)
