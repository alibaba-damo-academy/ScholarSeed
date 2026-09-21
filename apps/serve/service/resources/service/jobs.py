"""Lifecycle and orchestration for durable local resource imports."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import uuid4

from service.content.domain.model import ContentError
from service.persistence.project import StorageFailureKind, classify_storage_failure
from service.platform.content import (
    DISK_FULL_ERROR,
    IMPORT_CANCELLED_ERROR,
    ContentImportProgress,
    ContentImportSourceResult,
    ContentImportStage,
    ContentPort,
    ImportFailurePolicy,
    ImportMode,
)
from service.resources.domain.jobs import (
    TERMINAL_IMPORT_STATUSES,
    ImportJob,
    ImportJobPhase,
    ImportJobStatus,
    ImportSourceResult,
    ImportSourceStatus,
    VersionInitializationProgress,
)
from service.resources.persistence.jobs import ImportJobStore

IMPORT_POLL_SECONDS = 0.1
IMPORT_IDLE_SECONDS = 0.25
IMPORT_LEASE_SECONDS = 30.0
IMPORT_PROGRESS_FLUSH_SECONDS = 2.0
LOCAL_SOURCE_FALLBACK = "本地来源"
RESOURCE_IMPORT_PARTIAL = "resource_import_partial"
RESOURCE_IMPORT_FAILED = "resource_import_failed"
STORAGE_IO_FAILED_ERROR = "storage_io_failed"

_log = logging.getLogger("scholarseed.resources.imports")


class ResourceImportError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ResourceImportService:
    def __init__(self, content: ContentPort, store: ImportJobStore) -> None:
        self._content = content
        self._store = store
        self._worker_id = uuid4().hex
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self._roots_publisher: Callable[[str], Awaitable[None]] | None = None
        self._version_initializer: (
            Callable[
                [str, tuple[str, ...], Callable[[VersionInitializationProgress], None]], object
            ]
            | None
        ) = None

    def bind_roots_publisher(self, publisher: Callable[[str], Awaitable[None]]) -> None:
        self._roots_publisher = publisher

    def bind_version_initializer(
        self,
        initializer: Callable[
            [str, tuple[str, ...], Callable[[VersionInitializationProgress], None]], object
        ],
    ) -> None:
        self._version_initializer = initializer

    async def start(self) -> None:
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="resource-import-worker")

    async def aclose(self) -> None:
        self._stopping = True
        task = self._task
        self._task = None
        if task is None:
            return
        # Shutdown may already have cancelled the lifespan task that owns this
        # worker.  Treat that cancellation as normal shutdown and never let it
        # turn Ctrl+C into an ERROR traceback.
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    def create(
        self,
        *,
        owner_id: str,
        project_id: str,
        mode: ImportMode,
        target_dir: str,
        sources: tuple[str, ...],
        idempotency_key: str,
    ) -> ImportJob:
        if not sources:
            raise ResourceImportError("sources_required")
        project = self._content.project(project_id)
        digest = hashlib.sha256(
            json.dumps(
                {
                    "project": project.id,
                    "mode": mode.value,
                    "target_dir": target_dir,
                    "sources": sources,
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        try:
            return self._store.create(
                owner_id=owner_id,
                project_id=project.id,
                mode=mode,
                target_dir=target_dir,
                sources=sources,
                request_digest=digest,
                idempotency_key=idempotency_key,
            )
        except ValueError as error:
            raise ResourceImportError(str(error)) from error

    def get(self, job_id: str, *, owner_id: str) -> ImportJob:
        job = self._store.get(job_id, owner_id)
        if job is None:
            raise ResourceImportError("resource_import_job_not_found")
        return job

    def list(self, *, owner_id: str) -> tuple[ImportJob, ...]:
        return self._store.list(owner_id)

    def cancel(self, job_id: str, *, owner_id: str) -> ImportJob:
        job = self._store.request_cancel(job_id, owner_id)
        if job is None:
            raise ResourceImportError("resource_import_job_not_found")
        return job

    def retry(self, job_id: str, *, owner_id: str) -> ImportJob:
        job = self._store.retry(job_id, owner_id)
        if job is None:
            raise ResourceImportError("resource_import_job_not_retryable")
        return job

    async def events(
        self, job_id: str, *, owner_id: str, after_seq: int
    ) -> AsyncIterator[dict[str, Any] | None]:
        self.get(job_id, owner_id=owner_id)
        cursor = after_seq
        while True:
            events = self._store.events(job_id, cursor)
            for event in events:
                cursor = event.seq
                yield {
                    "seq": event.seq,
                    "type": event.event_type,
                    "data": event.data,
                }
            job = self.get(job_id, owner_id=owner_id)
            if job.status in TERMINAL_IMPORT_STATUSES and not events:
                return
            if not events:
                yield None
            await asyncio.sleep(IMPORT_POLL_SECONDS)

    async def _run(self) -> None:
        while not self._stopping:
            interrupted = await asyncio.to_thread(self._store.interrupt_expired)
            if interrupted:
                _log.warning("Marked %d expired resource import jobs interrupted", interrupted)
            job = await asyncio.to_thread(self._store.claim, self._worker_id, IMPORT_LEASE_SECONDS)
            if job is None:
                await asyncio.sleep(IMPORT_IDLE_SECONDS)
                continue
            await self._execute(job)

    async def _execute(self, job: ImportJob) -> None:
        generation = job.lease_generation
        completed_items = job.completed_items
        completed_bytes = job.completed_bytes
        total_bytes = job.total_bytes
        scan_discovered_items = job.scan_discovered_items
        version_discovered_items = job.version_discovered_items
        version_completed_items = job.version_completed_items
        version_total_items = job.version_total_items
        last_flush = 0.0
        last_version_flush = 0.0
        previous_version_total = version_total_items
        pending_results = tuple(
            result for result in job.source_results if result.status is ImportSourceStatus.PENDING
        )
        pending_sources = tuple(job.sources[result.source_index] for result in pending_results)

        def cancelled() -> bool:
            return self._stopping or self._store.cancelled(job.job_id, self._worker_id, generation)

        def observe(progress: ContentImportProgress) -> None:
            nonlocal completed_items, completed_bytes, total_bytes, scan_discovered_items, last_flush
            if progress.stage is ContentImportStage.SCANNING:
                scan_discovered_items = progress.completed_items
            else:
                completed_items = progress.completed_items
                completed_bytes = progress.completed_bytes
                total_bytes = progress.total_bytes
            now = time.monotonic()
            stage_finished = (
                progress.total_items > 0
                and progress.completed_items >= progress.total_items
                and progress.completed_bytes >= progress.total_bytes
            )
            if now - last_flush < IMPORT_PROGRESS_FLUSH_SECONDS and not stage_finished:
                return
            last_flush = now
            self._store.update(
                job.job_id,
                self._worker_id,
                generation,
                status=ImportJobStatus.RUNNING,
                phase=ImportJobPhase(progress.stage.value),
                completed_items=completed_items,
                total_items=progress.total_items,
                completed_bytes=completed_bytes,
                total_bytes=total_bytes,
                scan_discovered_items=scan_discovered_items,
            )

        try:
            if job.mode is ImportMode.COPY:

                def record_source(result: ContentImportSourceResult) -> None:
                    source_index = pending_results[result.source_index].source_index
                    status = (
                        ImportSourceStatus.SUCCEEDED
                        if result.imported is not None
                        else ImportSourceStatus.FAILED
                    )
                    self._store.record_source_result(
                        job.job_id,
                        self._worker_id,
                        generation,
                        source_index,
                        status,
                        error=result.error,
                        target_path=result.imported.path if result.imported is not None else "",
                    )

                if pending_sources:
                    await asyncio.to_thread(
                        self._content.import_sources,
                        job.project_id,
                        pending_sources,
                        job.target_dir,
                        job.mode,
                        None,
                        observe,
                        cancelled,
                        failure_policy=ImportFailurePolicy.CONTINUE,
                        result_observer=record_source,
                    )
            else:
                self._store.update(
                    job.job_id,
                    self._worker_id,
                    generation,
                    status=ImportJobStatus.RUNNING,
                    phase=ImportJobPhase.LINKING,
                    completed_items=0,
                    completed_bytes=0,
                    total_bytes=0,
                    scan_discovered_items=0,
                )
                if cancelled():
                    raise ContentError(IMPORT_CANCELLED_ERROR)
                try:
                    linked = await asyncio.to_thread(
                        self._content.authorize_import_roots,
                        job.project_id,
                        pending_sources,
                        job.target_dir,
                    )
                except ContentError as error:
                    for result in pending_results:
                        self._store.record_source_result(
                            job.job_id,
                            self._worker_id,
                            generation,
                            result.source_index,
                            ImportSourceStatus.FAILED,
                            error=error.code,
                        )
                    linked = ()
                else:
                    for result, root in zip(pending_results, linked):
                        self._store.record_source_result(
                            job.job_id,
                            self._worker_id,
                            generation,
                            result.source_index,
                            ImportSourceStatus.SUCCEEDED,
                            target_path=root.mount_path,
                        )
                completed_items = len(linked)
                self._store.update(
                    job.job_id,
                    self._worker_id,
                    generation,
                    status=ImportJobStatus.RUNNING,
                    phase=ImportJobPhase.LINKING,
                    completed_items=completed_items,
                    completed_bytes=0,
                    total_bytes=0,
                )
                if linked and self._roots_publisher is not None:
                    await self._roots_publisher(job.project_id)
            current = self._store.get(job.job_id, job.owner_id)
            current_results = current.source_results if current is not None else ()
            paths = tuple(
                result.target_path
                for result in current_results
                if result.status is ImportSourceStatus.SUCCEEDED and result.target_path
            )
            if self._version_initializer is not None and paths:

                def version_progress(progress: VersionInitializationProgress) -> None:
                    nonlocal last_version_flush, previous_version_total
                    nonlocal version_completed_items, version_discovered_items
                    nonlocal version_total_items
                    version_discovered_items = progress.discovered_items
                    version_completed_items = progress.completed_items
                    version_total_items = progress.total_items
                    now = time.monotonic()
                    total_discovered = previous_version_total <= 0 and progress.total_items > 0
                    stage_finished = (
                        progress.total_items > 0
                        and progress.completed_items >= progress.total_items
                    )
                    previous_version_total = progress.total_items
                    if (
                        now - last_version_flush < IMPORT_PROGRESS_FLUSH_SECONDS
                        and not total_discovered
                        and not stage_finished
                    ):
                        return
                    last_version_flush = now
                    self._store.update(
                        job.job_id,
                        self._worker_id,
                        generation,
                        status=ImportJobStatus.RUNNING,
                        phase=ImportJobPhase.VERSIONING,
                        completed_items=completed_items,
                        completed_bytes=completed_bytes,
                        total_bytes=total_bytes,
                        version_discovered_items=progress.discovered_items,
                        version_completed_items=progress.completed_items,
                        version_total_items=progress.total_items,
                    )

                await asyncio.to_thread(
                    self._version_initializer,
                    job.project_id,
                    paths,
                    version_progress,
                )
            current = self._store.get(job.job_id, job.owner_id)
            current_results = current.source_results if current is not None else ()
            succeeded_sources = sum(
                result.status is ImportSourceStatus.SUCCEEDED for result in current_results
            )
            failed_sources = sum(
                result.status is ImportSourceStatus.FAILED for result in current_results
            )
            source_failure_codes = {
                result.error
                for result in current_results
                if result.status is ImportSourceStatus.FAILED and result.error
            }
            source_failure_code = (
                next(iter(source_failure_codes))
                if len(source_failure_codes) == 1
                else RESOURCE_IMPORT_FAILED
            )
            self._store.update(
                job.job_id,
                self._worker_id,
                generation,
                status=(
                    ImportJobStatus.CANCELLED
                    if self._store.cancelled(job.job_id, self._worker_id, generation)
                    else (
                        ImportJobStatus.PARTIAL
                        if succeeded_sources and failed_sources
                        else ImportJobStatus.FAILED if failed_sources else ImportJobStatus.COMPLETED
                    )
                ),
                phase=ImportJobPhase.COMPLETED,
                completed_items=completed_items,
                completed_bytes=completed_bytes,
                total_bytes=total_bytes,
                version_discovered_items=version_discovered_items,
                version_completed_items=version_completed_items,
                version_total_items=version_total_items,
                error=(
                    RESOURCE_IMPORT_PARTIAL
                    if succeeded_sources and failed_sources
                    else source_failure_code if failed_sources else ""
                ),
            )
        except ContentError as error:
            self._store.mark_pending_sources(
                job.job_id,
                self._worker_id,
                generation,
                (
                    ImportSourceStatus.CANCELLED
                    if error.code == IMPORT_CANCELLED_ERROR or cancelled()
                    else ImportSourceStatus.FAILED
                ),
                error="" if error.code == IMPORT_CANCELLED_ERROR else error.code,
            )
            current = self._store.get(job.job_id, job.owner_id)
            succeeded_sources = sum(
                result.status is ImportSourceStatus.SUCCEEDED
                for result in (current.source_results if current is not None else ())
            )
            status = (
                (ImportJobStatus.PARTIAL if succeeded_sources else ImportJobStatus.FAILED)
                if self._stopping
                else (
                    ImportJobStatus.CANCELLED
                    if error.code == IMPORT_CANCELLED_ERROR or cancelled()
                    else ImportJobStatus.PARTIAL if succeeded_sources else ImportJobStatus.FAILED
                )
            )
            self._store.update(
                job.job_id,
                self._worker_id,
                generation,
                status=status,
                phase=ImportJobPhase.COMPLETED,
                completed_items=completed_items,
                completed_bytes=completed_bytes,
                total_bytes=total_bytes,
                version_discovered_items=version_discovered_items,
                version_completed_items=version_completed_items,
                version_total_items=version_total_items,
                error=(
                    "resource_import_interrupted"
                    if self._stopping
                    else "" if status is ImportJobStatus.CANCELLED else error.code
                ),
            )
        except Exception as error:
            _log.exception(
                "Resource import job failed",
                extra={"job_id": job.job_id, "project_id": job.project_id},
            )
            storage_failure = classify_storage_failure(error)
            failure_code = (
                {
                    StorageFailureKind.FULL: DISK_FULL_ERROR,
                    StorageFailureKind.IO: STORAGE_IO_FAILED_ERROR,
                }.get(storage_failure, RESOURCE_IMPORT_FAILED)
                if storage_failure is not None
                else RESOURCE_IMPORT_FAILED
            )
            self._store.mark_pending_sources(
                job.job_id,
                self._worker_id,
                generation,
                ImportSourceStatus.FAILED,
                error=failure_code,
            )
            current = self._store.get(job.job_id, job.owner_id)
            succeeded_sources = sum(
                result.status is ImportSourceStatus.SUCCEEDED
                for result in (current.source_results if current is not None else ())
            )
            self._store.update(
                job.job_id,
                self._worker_id,
                generation,
                status=(ImportJobStatus.PARTIAL if succeeded_sources else ImportJobStatus.FAILED),
                phase=ImportJobPhase.COMPLETED,
                completed_items=completed_items,
                completed_bytes=completed_bytes,
                total_bytes=total_bytes,
                version_discovered_items=version_discovered_items,
                version_completed_items=version_completed_items,
                version_total_items=version_total_items,
                error=("resource_import_interrupted" if self._stopping else failure_code),
            )


def _source_name(source: str) -> str:
    normalized = source.rstrip("/\\").replace("\\", "/")
    return normalized.rsplit("/", 1)[-1] if normalized else LOCAL_SOURCE_FALLBACK


def public_import_job(job: ImportJob) -> dict[str, object]:
    """Project a job without exposing absolute local source paths."""

    source_results = [
        {
            "source_index": result.source_index,
            "source_name": _source_name(job.sources[result.source_index]),
            "status": result.status.value,
            "error": result.error,
            "retryable": result.status in {ImportSourceStatus.FAILED, ImportSourceStatus.CANCELLED},
        }
        for result in job.source_results
    ]
    succeeded_sources = sum(
        result.status is ImportSourceStatus.SUCCEEDED for result in job.source_results
    )
    failed_sources = sum(
        result.status is ImportSourceStatus.FAILED for result in job.source_results
    )
    cancelled_sources = sum(
        result.status is ImportSourceStatus.CANCELLED for result in job.source_results
    )

    return {
        "id": job.job_id,
        "project_id": job.project_id,
        "mode": job.mode.value,
        "status": job.status.value,
        "phase": job.phase.value,
        "source_names": [_source_name(source) for source in job.sources],
        "source_summary": {
            "total": len(job.source_results),
            "succeeded": succeeded_sources,
            "failed": failed_sources,
            "cancelled": cancelled_sources,
        },
        "source_results": source_results,
        "scan_discovered_items": job.scan_discovered_items,
        "completed_items": job.completed_items,
        "total_items": job.total_items,
        "completed_bytes": job.completed_bytes,
        "total_bytes": job.total_bytes,
        "version_discovered_items": job.version_discovered_items,
        "version_completed_items": job.version_completed_items,
        "version_total_items": job.version_total_items,
        "event_seq": job.event_seq,
        "cancel_requested": job.cancel_requested,
        "error": job.error,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


__all__ = ["ResourceImportError", "ResourceImportService", "public_import_job"]
