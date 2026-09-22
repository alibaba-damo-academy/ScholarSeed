"""Initial discovery and ignore policy for resource versions."""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from dataclasses import dataclass, replace
from enum import Enum
from hashlib import sha256
from pathlib import PurePosixPath
from time import perf_counter
from typing import Callable

from pathspec import GitIgnoreSpec

from service.content.domain.model import ROOT_UNAVAILABLE_ERROR, ContentError
from service.platform.content import (
    ContentPort,
    ContentWriteReceipt,
    FileEventKind,
    ResourceEntry,
    RootKind,
)
from service.platform.resources import (
    VERSION_FILE_SIZE_KILOBYTE,
    VERSION_MAX_BYTES,
    ManagementState,
    ProductMutationKind,
    ResourceCapability,
    ResourceFormatPolicy,
    ResourceProjectPreparation,
    ResourceVersionSettings,
)
from service.resources.domain.jobs import VersionInitializationProgress
from service.resources.domain.policy import AdmissionPolicy, VersionMode
from service.resources.service.events import ResourceVersionEvent, emit
from service.resources.service.history import ResourceVersionError, ResourceVersionService

GITIGNORE_FILENAME = ".gitignore"
OFFICE_LOCK_PREFIX = "~$"
TEMPORARY_SUFFIXES = (".swp", ".swo", ".tmp", ".lock")
OBSERVATION_DEBOUNCE_SECONDS = 0.15
PROJECT_REFRESH_SECONDS = 2.0
PREPARATION_UNBOUND_ERROR = "resource_project_preparation_unbound"
PREPARATION_REBOUND_ERROR = "resource_project_preparation_rebound"
UNKNOWN_PROJECT_ERROR = "unknown_project"

_log = logging.getLogger("scholarseed.resources.versions")


@dataclass(frozen=True)
class ScanOutcome:
    """One bounded scan summary for trace and tests."""

    visited: int
    managed: int
    created: int
    ignored: int
    oversized: int
    unsupported: int
    failed: int


class ScanStatus(str, Enum):
    """Transient aggregate scan state exposed by the settings projection."""

    IDLE = "idle"
    SCANNING = "scanning"


@dataclass(frozen=True)
class ScanSummary:
    """Latest bounded outcomes across projects activated in this process."""

    status: ScanStatus
    projects: int
    managed: int
    created: int
    ignored: int
    oversized: int
    unsupported: int
    failed: int


class ResourceVersionSupervisor:
    """Discover untracked stable files without versioning later external edits."""

    def __init__(
        self,
        content: ContentPort,
        versions: ResourceVersionService,
        formats: ResourceFormatPolicy,
        settings: ResourceVersionSettings,
    ) -> None:
        self._content = content
        self._versions = versions
        self._formats = formats
        self._settings = settings
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._streams: dict[str, asyncio.Task[None]] = {}
        self._dirty: dict[str, set[str]] = {}
        self._discover: set[str] = set()
        self._reconcile: set[str] = set()
        self._eligible_cache: dict[str, set[str]] = {}
        self._import_eligible: dict[str, set[str]] = {}
        self._scan_outcomes: dict[str, ScanOutcome] = {}
        self._scanning: set[str] = set()
        self._preparation: ResourceProjectPreparation | None = None
        self._prepared: set[str] = set()
        self._prepare_locks: dict[str, asyncio.Lock] = {}
        self._registry_task: asyncio.Task[None] | None = None
        self._stopping = False

    def bind_preparation(self, preparation: ResourceProjectPreparation) -> None:
        """Bind the project recovery barrier before the lifecycle starts."""

        if self._preparation is not None:
            raise RuntimeError(PREPARATION_REBOUND_ERROR)
        self._preparation = preparation

    def common_version_patterns(self) -> tuple[str, ...]:
        """Expose the format registry's supported patterns to personal settings."""

        return self._formats.version_patterns()

    def version_include_patterns(self) -> tuple[str, ...]:
        """Return persisted allow rules or every common supported file type by default."""

        configured = self._settings.version_include_patterns()
        if configured is not None:
            return configured
        return self.common_version_patterns()

    def max_size_bytes(self) -> int:
        """Return the configured ceiling without exceeding the storage safety limit."""

        return min(
            self._settings.max_version_file_size_kb() * VERSION_FILE_SIZE_KILOBYTE,
            VERSION_MAX_BYTES,
        )

    async def start(self) -> None:
        """Start lightweight maintenance without activating historical projects."""

        if self._preparation is None:
            raise RuntimeError(PREPARATION_UNBOUND_ERROR)
        self._registry_task = asyncio.create_task(self._refresh_registry())

    def schedule_scan(self, project_id: str) -> None:
        """Coalesce background discovery requested by real resource activity."""

        if self._stopping:
            return
        project_id = self._content.project(project_id).id
        self._discover.add(project_id)
        self._schedule(project_id)

    async def schedule_all(self) -> None:
        """Schedule activated projects after a global policy change."""

        self._eligible_cache.clear()
        for project_id in tuple(self._prepared):
            try:
                self.schedule_scan(project_id)
            except ContentError as exc:
                if exc.code != UNKNOWN_PROJECT_ERROR:
                    raise
                await self._retire(project_id)

    def reconcile_linked_root(self, project_id: str, mount_path: str) -> None:
        """Initialize one linked file or observe restored identities below a root.

        A revoked root leaves its version history intact.  When that root is
        restored, its last observation can still be a tombstone until the watcher
        refreshes.  Re-read only already-managed descendants so unchanged files
        immediately lose stale drift while bytes changed during revocation remain
        truthfully drifted.  A newly linked file is also bounded to one identity, so
        establish its initial version before the authorization response returns.
        Directory discovery remains asynchronous because it may contain many files.
        """

        project = self._content.project(project_id)
        root = mount_path.rstrip("/")
        if not root:
            return
        managed = tuple(
            path
            for path in self._versions.tracked_paths(project.id)
            if path == root or path.startswith(f"{root}/")
        )
        with self._versions.writer(project.id):
            for path in managed:
                self._versions.observe(project.id, path)
            if root in managed or self._content.is_directory(project.id, root):
                return
            entries = self._entries(project.id)
            if self._management_state(project.id, root, entries) is ManagementState.MANAGED:
                self._versions.ensure_initial(project.id, root)

    async def prepare_project(self, project_id: str) -> None:
        """Recover one availability cycle exactly once before file access."""

        project = await asyncio.to_thread(self._content.project, project_id)
        if not project.available:
            await self._deactivate(project.id)
            raise ContentError(ROOT_UNAVAILABLE_ERROR)
        if project.id in self._prepared:
            return
        preparation = self._preparation
        if preparation is None:
            raise RuntimeError(PREPARATION_UNBOUND_ERROR)
        lock = self._prepare_locks.setdefault(project.id, asyncio.Lock())
        async with lock:
            if project.id in self._prepared:
                return
            await asyncio.to_thread(preparation.prepare, project.id)
            refreshed = await asyncio.to_thread(self._content.project, project.id)
            if not refreshed.available:
                raise ContentError(ROOT_UNAVAILABLE_ERROR)
            self._prepared.add(project.id)

    async def activate_project(self, project_id: str) -> None:
        """Prepare and observe one project selected by a real product action."""

        await self.prepare_project(project_id)
        project = await asyncio.to_thread(self._content.project, project_id)
        await self._content.refresh_events(project.id)
        stream = self._streams.get(project.id)
        if stream is None or stream.done():
            self._streams[project.id] = asyncio.create_task(self._consume(project.id))
            self._reconcile.add(project.id)
        self.schedule_scan(project.id)

    async def aclose(self) -> None:
        """Finish or cancel discovery and stop the owned content event hub."""

        self._stopping = True
        if self._registry_task is not None:
            # Registry recovery also uses to_thread; let the active call finish.
            await asyncio.gather(self._registry_task, return_exceptions=True)
        listeners = list(self._streams.values())
        for task in listeners:
            task.cancel()
        await asyncio.gather(*listeners, return_exceptions=True)
        # Cancelling to_thread only cancels its waiter, not the disk writer.
        # Drain workers before releasing the content domain and project state.
        await asyncio.gather(*tuple(self._tasks.values()), return_exceptions=True)
        self._streams.clear()
        await self._content.close_events()

    async def _refresh_active_projects(self) -> None:
        """Retire or deactivate only projects already selected in this process."""

        active = (
            set(self._streams)
            | set(self._tasks)
            | self._prepared
            | set(self._eligible_cache)
            | set(self._dirty)
            | self._discover
            | self._reconcile
        )
        for project_id in active:
            try:
                project = await asyncio.to_thread(self._content.project, project_id)
            except ContentError as exc:
                if exc.code != UNKNOWN_PROJECT_ERROR:
                    raise
                await self._retire(project_id)
                continue
            if not project.available:
                await self._deactivate(project.id)

    async def _deactivate(self, project_id: str) -> None:
        """Invalidate one availability cycle without interpreting absence as deletion."""

        self._prepared.discard(project_id)
        self._eligible_cache.pop(project_id, None)
        self._scan_outcomes.pop(project_id, None)
        self._scanning.discard(project_id)
        self._dirty.pop(project_id, None)
        self._discover.discard(project_id)
        self._reconcile.discard(project_id)
        stream = self._streams.pop(project_id, None)
        if stream is not None and stream is not asyncio.current_task():
            stream.cancel()
            await asyncio.gather(stream, return_exceptions=True)

    async def _retire(self, project_id: str) -> None:
        """Permanently forget one project after its registry identity disappears."""

        await self._deactivate(project_id)
        self._prepare_locks.pop(project_id, None)

    async def _refresh_registry(self) -> None:
        while not self._stopping:
            await asyncio.sleep(PROJECT_REFRESH_SECONDS)
            if self._stopping:
                return
            try:
                await self._refresh_active_projects()
            except Exception:
                _log.exception("resource_version_registry_refresh_failed")

    async def _consume(self, project_id: str) -> None:
        try:
            epoch, sequence = self._content.event_cursor(project_id)
            async for event in self._content.subscribe(project_id, epoch, sequence):
                if event.root is not RootKind.RESOURCES:
                    continue
                self._discover.add(project_id)
                if event.kind is FileEventKind.RESCAN:
                    self._reconcile.add(project_id)
                elif PurePosixPath(event.path).name != GITIGNORE_FILENAME:
                    dirty = self._dirty.setdefault(project_id, set())
                    dirty.add(event.path)
                    if event.previous_path:
                        dirty.add(event.previous_path)
                self._schedule(project_id)
        except asyncio.CancelledError:
            raise
        except ContentError as exc:
            if exc.code == UNKNOWN_PROJECT_ERROR:
                await self._retire(project_id)
                return
            _log.exception("resource_version_subscription_failed", extra={"project_id": project_id})
        except Exception:
            _log.exception("resource_version_subscription_failed", extra={"project_id": project_id})

    def _schedule(self, project_id: str) -> None:
        if project_id not in self._tasks and not self._stopping:
            self._tasks[project_id] = asyncio.create_task(self._drain(project_id))

    async def _drain(self, project_id: str) -> None:
        try:
            try:
                await self.activate_project(project_id)
            except ContentError as exc:
                if exc.code == UNKNOWN_PROJECT_ERROR:
                    await self._retire(project_id)
                    return
                _log.exception(
                    "resource_project_activation_failed", extra={"project_id": project_id}
                )
                return
            except FileNotFoundError:
                await self._deactivate(project_id)
                return
            except Exception:
                _log.exception(
                    "resource_project_activation_failed", extra={"project_id": project_id}
                )
                return
            while not self._stopping and (
                project_id in self._discover or self._dirty.get(project_id)
            ):
                await asyncio.sleep(OBSERVATION_DEBOUNCE_SECONDS)
                if self._stopping:
                    break
                paths = self._dirty.pop(project_id, set())
                reconcile = project_id in self._reconcile
                self._discover.discard(project_id)
                self._reconcile.discard(project_id)
                try:
                    await asyncio.to_thread(self._process, project_id, paths, reconcile)
                except ContentError as exc:
                    if exc.code == UNKNOWN_PROJECT_ERROR:
                        await self._retire(project_id)
                        return
                    _log.exception(
                        "resource_version_observation_failed", extra={"project_id": project_id}
                    )
                except FileNotFoundError:
                    await self._deactivate(project_id)
                    return
                except Exception:
                    _log.exception(
                        "resource_version_observation_failed", extra={"project_id": project_id}
                    )
        finally:
            self._tasks.pop(project_id, None)

    def _process(self, project_id: str, paths: set[str], reconcile: bool) -> None:
        with self._versions.writer(project_id):
            previous = self._eligible_cache.get(project_id)
            self.scan_project(project_id)
            entries = self._entries(project_id)
            present = {entry.path for entry in entries}
            missing = set(self._versions.managed_paths(project_id)) - present
            candidates, _, _, _ = self._eligible(
                project_id,
                (*entries, *(ResourceEntry(path=path, size=0) for path in missing)),
            )
            selected = {
                path
                for path in candidates
                if (reconcile and (previous is None or path in previous))
                or any(path == dirty or path.startswith(f"{dirty}/") for dirty in paths)
            }
            for path in selected:
                self._versions.observe(project_id, path)

    def observe_path(self, project_id: str, path: str) -> bool:
        """Apply ignore/format policy before an explicit-open observation."""

        entries = self._entries(project_id)
        state = self._management_state(project_id, path, entries)
        return state is ManagementState.MANAGED and self._versions.observe(project_id, path)

    def capability(self, project_id: str, path: str) -> ResourceCapability:
        """Project the live eligibility policy without duplicating it in clients."""

        selected = (path,)
        projected = self.capability_states(project_id, selected)[path]
        if projected.managed and projected.management_state is ManagementState.MANAGED:
            self._versions.observe(project_id, path)
            projected = self.capability_states(project_id, selected)[path]
        if projected.managed:
            return projected
        live = self._versions.capability(project_id, path)
        return replace(projected, disk_revision=live.disk_revision)

    def capability_states(
        self,
        project_id: str,
        paths: tuple[str, ...],
        *,
        repositories: dict[str, str | None] | None = None,
    ) -> dict[str, ResourceCapability]:
        """Project tree state for selected paths without a repository-wide scan."""

        selected = tuple(dict.fromkeys(paths))
        if not selected:
            return {}
        entries = self._content.resource_entries(project_id, selected)
        by_path = {entry.path: entry for entry in entries}
        resource_root = self._content.root(project_id, RootKind.RESOURCES).path
        repository_states = repositories or self._content.repository_roots(project_id, selected)
        persisted = self._versions.capability_states(project_id, selected)
        manual_states = self._versions.manual_admitted_states(project_id, selected)
        projected: dict[str, ResourceCapability] = {}
        for path in selected:
            base = persisted.get(
                path,
                ResourceCapability(
                    path=path,
                    managed=False,
                    can_version=True,
                    can_diff=False,
                    can_preview_history=False,
                    max_size_bytes=self.max_size_bytes(),
                    management_state=ManagementState.MANAGED,
                ),
            )
            entry = by_path.get(path)
            state = (
                self._classify(
                    project_id,
                    entry,
                    resource_root,
                    repository_states,
                    manual_admitted=manual_states.get(path, False),
                )
                if entry is not None
                else ManagementState.MANAGED if base.managed else ManagementState.UNAVAILABLE
            )
            if repository_states[path] is not None:
                state = ManagementState.GIT
            projected[path] = replace(
                base,
                can_version=state is ManagementState.MANAGED,
                max_size_bytes=self.max_size_bytes(),
                management_state=state,
                pending=None if state is ManagementState.GIT else base.pending,
                drifted=False if state is ManagementState.GIT else base.drifted,
                manual_admitted=manual_states.get(path, False),
            )
        return projected

    def scan_project(self, project_id: str) -> ScanOutcome:
        """Seal only never-managed eligible files; existing history is observation-only."""

        started = perf_counter()
        self._scanning.add(project_id)
        emit(_log, ResourceVersionEvent.SCAN_STARTED, project_id=project_id)
        try:
            entries = self._entries(project_id)
            emit(
                _log,
                ResourceVersionEvent.SCAN_PROGRESS,
                project_id=project_id,
                visited=len(entries),
            )
            eligible, ignored, oversized, unsupported = self._eligible(project_id, entries)
            versioned = self._versions.versioned_paths(project_id)
            created = failed = 0
            for path in eligible:
                if path in versioned:
                    continue
                try:
                    result = self._versions.ensure_initial(project_id, path)
                except (ContentError, OSError):
                    failed += 1
                else:
                    created += int(result is not None and not result.unchanged)
            self._eligible_cache[project_id] = set(eligible)
            outcome = ScanOutcome(
                visited=len(entries),
                managed=len(eligible),
                created=created,
                ignored=ignored,
                oversized=oversized,
                unsupported=unsupported,
                failed=failed,
            )
            self._scan_outcomes[project_id] = outcome
            emit(
                _log,
                ResourceVersionEvent.SCAN_COMPLETED,
                project_id=project_id,
                duration_ms=round((perf_counter() - started) * 1000),
                result_code=ScanStatus.IDLE.value,
                visited_files=outcome.visited,
                managed_files=outcome.managed,
                created_files=outcome.created,
                ignored_files=outcome.ignored,
                oversized_files=outcome.oversized,
                unsupported_files=outcome.unsupported,
                failed_files=outcome.failed,
            )
            return outcome
        finally:
            self._scanning.discard(project_id)

    def initialize_paths(
        self,
        project_id: str,
        prefixes: tuple[str, ...],
        observer: Callable[[VersionInitializationProgress], None] | None = None,
    ) -> ScanOutcome:
        """Initialize only imported paths while reusing the authoritative policy."""

        def matches(entry: ResourceEntry) -> bool:
            return any(
                entry.path == prefix or entry.path.startswith(f"{prefix}/") for prefix in prefixes
            )

        discovered = 0

        def discover(entry: ResourceEntry) -> None:
            nonlocal discovered
            if not matches(entry):
                return
            discovered += 1
            if observer is not None:
                observer(VersionInitializationProgress(discovered, 0, 0))

        if observer is not None:
            observer(VersionInitializationProgress(0, 0, 0))
        entries = tuple(entry for entry in self._entries(project_id, discover) if matches(entry))
        eligible, ignored, oversized, unsupported = self._eligible(project_id, entries)
        created = failed = 0
        total = len(eligible)
        if observer is not None:
            observer(VersionInitializationProgress(discovered, 0, total))
        for index, path in enumerate(eligible, start=1):
            try:
                result = self._versions.ensure_initial(project_id, path)
            except (ContentError, OSError):
                failed += 1
            else:
                created += int(result is not None and not result.unchanged)
            if observer is not None:
                observer(VersionInitializationProgress(discovered, index, total))
        self._eligible_cache.setdefault(project_id, set()).update(eligible)
        return ScanOutcome(
            visited=len(entries),
            managed=len(eligible),
            created=created,
            ignored=ignored,
            oversized=oversized,
            unsupported=unsupported,
            failed=failed,
        )

    def scan_summary(self) -> ScanSummary:
        """Aggregate only transient last-scan outcomes; never trigger filesystem IO."""

        outcomes = tuple(self._scan_outcomes.values())
        return ScanSummary(
            status=(
                ScanStatus.SCANNING
                if self._scanning or self._discover or self._tasks
                else ScanStatus.IDLE
            ),
            projects=len(outcomes),
            managed=sum(item.managed for item in outcomes),
            created=sum(item.created for item in outcomes),
            ignored=sum(item.ignored for item in outcomes),
            oversized=sum(item.oversized for item in outcomes),
            unsupported=sum(item.unsupported for item in outcomes),
            failed=sum(item.failed for item in outcomes),
        )

    def present_paths(self, project_id: str) -> tuple[str, ...]:
        """Record pre-turn existence without reading excluded file contents."""

        return tuple(entry.path for entry in self._entries(project_id))

    def eligible_paths(
        self, project_id: str, *, include_missing: tuple[str, ...] = ()
    ) -> tuple[str, ...]:
        """Apply policy to current files and optional missing-path candidates.

        A missing candidate passes path policy only; callers must still prove
        absence through Content before recording a deletion.
        """

        cached = self._import_eligible.get(project_id)
        if cached is not None:
            if not include_missing:
                return tuple(cached)
            additions, _ignored, _oversized, _unsupported = self._eligible(
                project_id,
                tuple(ResourceEntry(path=path, size=0) for path in include_missing),
            )
            return tuple(cached | set(additions))
        entries = self._entries(project_id)
        present = {entry.path for entry in entries}
        entries = (
            *entries,
            *(ResourceEntry(path=path, size=0) for path in include_missing if path not in present),
        )
        eligible, _ignored, _oversized, _unsupported = self._eligible(project_id, entries)
        return eligible

    @contextmanager
    def import_scope(self, project_id: str):
        """Reuse one eligibility scan for the lifetime of a COPY import batch."""

        if project_id in self._import_eligible:
            yield
            return
        self._import_eligible[project_id] = set(self.eligible_paths(project_id))
        try:
            yield
        finally:
            self._import_eligible.pop(project_id, None)

    def is_eligible(self, project_id: str, path: str) -> bool:
        """Check one current path against the authoritative scan policy."""

        return path in self.eligible_paths(project_id)

    def record_changes(self, project_id: str, paths: tuple[str, ...]) -> None:
        """Filter product writes through ignore policy before advancing WorkingHead."""

        eligible = set(self.eligible_paths(project_id))
        selected = [
            candidate
            for candidate in eligible
            if any(candidate == path or candidate.startswith(f"{path}/") for path in paths)
        ]
        managed = self._versions.managed_paths(project_id)
        missing_managed = [
            candidate
            for candidate in managed
            if candidate not in eligible
            and any(candidate == path or candidate.startswith(f"{path}/") for path in paths)
        ]
        self._versions.record_changes(
            project_id, tuple(dict.fromkeys((*missing_managed, *selected)))
        )

    def record_move(self, project_id: str, source: str, target: str) -> None:
        """Map every managed descendant through an explicit product move."""

        managed = self._versions.managed_paths(project_id)
        pairs = tuple(
            (path, f"{target}{path[len(source):]}")
            for path in managed
            if path == source or path.startswith(f"{source}/")
        )
        self._versions.record_moves(project_id, pairs)
        eligible = tuple(
            path
            for path in self.eligible_paths(project_id)
            if path == target or path.startswith(f"{target}/")
        )
        self._versions.record_changes(project_id, eligible)

    def commit_product_bytes(
        self,
        project_id: str,
        path: str,
        content: bytes,
        kind: ProductMutationKind,
        idempotency_key: str,
        *,
        mode_bits: int | None = None,
        request_digest: str | None = None,
    ) -> ContentWriteReceipt | None:
        """Apply policy before entering the durable product mutation coordinator."""

        if len(content) > self.max_size_bytes() or not self._inside_version_root(project_id, path):
            return None
        candidates = self.eligible_paths(
            project_id,
            include_missing=(path,) if kind is ProductMutationKind.CREATE else (),
        )
        if path not in candidates:
            return None
        try:
            return self._versions.commit_product(
                project_id,
                path,
                content,
                kind,
                idempotency_key,
                mode_bits=mode_bits,
                request_digest=request_digest,
            )
        except ResourceVersionError as exc:
            raise ContentError(exc.code) from exc

    def create_managed_copy(
        self,
        project_id: str,
        name: str,
        content: bytes,
        idempotency_key: str,
    ) -> ContentWriteReceipt:
        """Create complete Workbench memory bytes as one managed resource v1."""

        request_digest = sha256(name.encode("utf-8")).hexdigest()
        try:
            target = self._versions.product_mutation_target(
                project_id, idempotency_key, request_digest
            )
        except ResourceVersionError as exc:
            raise ContentError(exc.code) from exc
        if target is None:
            root = self._content.root(project_id, RootKind.RESOURCES).path
            target = self._content.destination(project_id, root, name).path
        if len(content) > self.max_size_bytes():
            raise ContentError("file_too_large")
        if target not in self.eligible_paths(project_id, include_missing=(target,)):
            raise ContentError("version_management_disabled")
        try:
            return self._versions.commit_product(
                project_id,
                target,
                content,
                ProductMutationKind.CREATE,
                idempotency_key,
                request_digest=request_digest,
            )
        except ResourceVersionError as exc:
            raise ContentError(exc.code) from exc

    def _inside_version_root(self, project_id: str, path: str) -> bool:
        roots = (
            self._content.root(project_id, RootKind.RESOURCES).path,
            *(root.mount_path for root in self._content.external_roots(project_id)),
        )
        return any(not root or path == root or path.startswith(f"{root}/") for root in roots)

    def _eligible(
        self, project_id: str, entries: tuple[ResourceEntry, ...]
    ) -> tuple[tuple[str, ...], int, int, int]:
        resource_root = self._content.root(project_id, RootKind.RESOURCES).path
        eligible: list[str] = []
        ignored = oversized = unsupported = 0
        repositories = self._content.repository_roots(
            project_id, tuple(entry.path for entry in entries)
        )
        for entry in entries:
            state = self._classify(project_id, entry, resource_root, repositories)
            if state is ManagementState.IGNORED:
                ignored += 1
                continue
            if state is ManagementState.OVERSIZED:
                oversized += 1
                continue
            if state is not ManagementState.MANAGED:
                unsupported += 1
                continue
            eligible.append(entry.path)
        return tuple(eligible), ignored, oversized, unsupported

    def _management_state(
        self,
        project_id: str,
        path: str,
        entries: tuple[ResourceEntry, ...],
        *,
        managed: bool = False,
    ) -> ManagementState:
        if self._content.repository_roots(project_id, (path,))[path] is not None:
            return ManagementState.GIT
        entry = next((candidate for candidate in entries if candidate.path == path), None)
        if entry is None:
            return ManagementState.MANAGED if managed else ManagementState.UNAVAILABLE
        resource_root = self._content.root(project_id, RootKind.RESOURCES).path
        return self._classify(project_id, entry, resource_root)

    def _classify(
        self,
        project_id: str,
        entry: ResourceEntry,
        resource_root: str,
        repositories: dict[str, str | None] | None = None,
        *,
        manual_admitted: bool | None = None,
    ) -> ManagementState:
        roots = (
            repositories
            if repositories is not None
            else self._content.repository_roots(project_id, (entry.path,))
        )
        if roots[entry.path] is not None:
            return ManagementState.GIT
        relative = self._relative_to_root(entry.path, resource_root)
        manual = (
            self._versions.manual_admitted(project_id, entry.path)
            if manual_admitted is None
            else manual_admitted
        )
        if entry.size > self.max_size_bytes():
            return ManagementState.OVERSIZED
        if self._settings.version_migration_required():
            return ManagementState.MANAGED if manual else ManagementState.MIGRATION_REQUIRED
        policy = AdmissionPolicy(
            VersionMode(self._settings.version_mode()),
            self.version_include_patterns(),
            self._settings.version_ignore_patterns(),
            self.max_size_bytes(),
        )
        return policy.classify(relative, entry.size, manual=manual)

    def admission_state(self, project_id: str, path: str) -> ManagementState:
        """Shared eligibility gate for mutation capture and manual admission."""
        return self._management_state(project_id, path, self._entries(project_id))

    def invalidate(self, project_id: str) -> None:
        """Discard cached eligibility after a persisted file override."""
        self._eligible_cache.pop(project_id, None)

    def policy_impact(
        self,
        mode: str,
        includes: tuple[str, ...],
        ignores: tuple[str, ...],
        max_file_size_kb: int,
    ) -> tuple[tuple[tuple[str, str], ...], tuple[tuple[str, str], ...]]:
        """Compare every accessible project's old and proposed admission sets."""
        policy = AdmissionPolicy(
            VersionMode(mode),
            includes,
            ignores,
            min(max_file_size_kb * VERSION_FILE_SIZE_KILOBYTE, VERSION_MAX_BYTES),
        )
        added: list[tuple[str, str]] = []
        removed: list[tuple[str, str]] = []
        for project in self._content.projects():
            if not project.available:
                raise ContentError(ROOT_UNAVAILABLE_ERROR)
            entries = self._entries(project.id)
            repositories = self._content.repository_roots(
                project.id, tuple(entry.path for entry in entries)
            )
            root = self._content.root(project.id, RootKind.RESOURCES).path
            legacy = self._settings.version_migration_required()
            legacy_includes = (
                self._settings.version_include_patterns() or self.common_version_patterns()
            )
            include_spec = GitIgnoreSpec.from_lines(legacy_includes)
            ignore_spec = GitIgnoreSpec.from_lines(self._settings.version_ignore_patterns())
            nested: list[tuple[str, GitIgnoreSpec]] = []
            if legacy:
                for entry in entries:
                    if PurePosixPath(entry.path).name == GITIGNORE_FILENAME:
                        lines = self._content.read_text(project.id, entry.path).splitlines()
                        parent = str(PurePosixPath(entry.path).parent)
                        nested.append(
                            (root if parent == "." else parent, GitIgnoreSpec.from_lines(lines))
                        )
            for entry in entries:
                if (
                    self._content.repository_roots(project.id, (entry.path,))[entry.path]
                    is not None
                ):
                    continue
                relative = self._relative_to_root(entry.path, root)
                manual = self._versions.manual_admitted(project.id, entry.path)
                if legacy:
                    before = entry.size <= self.max_size_bytes() and (
                        manual
                        or (
                            PurePosixPath(entry.path).name != GITIGNORE_FILENAME
                            and not self._temporary(entry.path)
                            and not ignore_spec.match_file(relative)
                            and not any(
                                self._matches_nested(entry.path, base, spec)
                                for base, spec in nested
                            )
                            and include_spec.match_file(relative)
                            and self._formats.versionable(entry.path)
                        )
                    )
                else:
                    before = (
                        self._classify(project.id, entry, root, repositories)
                        is ManagementState.MANAGED
                    )
                after = (
                    policy.classify(relative, entry.size, manual=manual) is ManagementState.MANAGED
                )
                if after and not before:
                    added.append((project.id, entry.path))
                if before and not after:
                    removed.append((project.id, entry.path))
        return tuple(sorted(added)), tuple(sorted(removed))

    def _entries(
        self,
        project_id: str,
        observer: Callable[[ResourceEntry], None] | None = None,
    ) -> tuple[ResourceEntry, ...]:
        return self._content.scan_resources(project_id, observer)

    @staticmethod
    def _relative_to_root(path: str, root: str) -> str:
        cleaned_root = root.strip("/")
        if cleaned_root and path.startswith(f"{cleaned_root}/"):
            return path[len(cleaned_root) + 1 :]
        return path

    @staticmethod
    def _within(path: str, base: str) -> str | None:
        cleaned = base.strip("/")
        if not cleaned:
            return path
        if path == cleaned:
            return ""
        prefix = f"{cleaned}/"
        return path[len(prefix) :] if path.startswith(prefix) else None

    @classmethod
    def _matches_nested(cls, path: str, base: str, spec: GitIgnoreSpec) -> bool:
        relative = cls._within(path, base)
        return relative is not None and spec.match_file(relative)

    @staticmethod
    def _temporary(path: str) -> bool:
        name = PurePosixPath(path).name
        return name.startswith(OFFICE_LOCK_PREFIX) or name.endswith(TEMPORARY_SUFFIXES)


__all__ = [
    "ResourceVersionSupervisor",
    "ScanOutcome",
    "ScanStatus",
    "ScanSummary",
]
