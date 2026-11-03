"""Delayed session storage maintenance with application-owned shutdown."""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Awaitable, Callable
from itertools import chain
from pathlib import Path
from typing import TypeVar

from service.chat.persistence import blocks, journal
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.persistence.project import transaction
from service.platform.activity import Activities, ActivityPhase, MaintenanceActive

MAINTENANCE_INTERVAL_SECONDS = 15 * 60
MAINTENANCE_BUDGET_SECONDS = 2.0
MIGRATION_RETRY_SECONDS = 60.0
COMPACTION_BUDGET_SECONDS = 30.0
Result = TypeVar("Result")
_log = logging.getLogger(__name__)


class SessionMaintenanceService:
    """Schedule work; the injected owner retains admission and filesystem duties.

    A callback must finish its physical work before returning, including when
    interrupted. This scheduler never cancels an in-flight callback or grants
    maintenance based on an observation of activity counts.
    """

    def __init__(
        self,
        activities: Activities,
        maintain: Callable[[], Awaitable[bool | None]],
        *,
        interval: float = MAINTENANCE_INTERVAL_SECONDS,
    ) -> None:
        if not math.isfinite(interval) or interval <= 0:
            raise ValueError("session maintenance interval must be finite and positive")
        self._activities = activities
        self._maintain = maintain
        self._interval = interval
        self._stopping = False
        self._task: asyncio.Task[None] | None = None
        self._idle: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._stopping:
            raise RuntimeError("session maintenance service is closed")
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name="session-storage-maintenance")

    async def _wait(self, delay: float) -> None:
        await asyncio.sleep(delay)
        await self._activities.wait_open()

    async def _run(self) -> None:
        delay = self._interval
        while not self._stopping:
            self._idle = asyncio.create_task(self._wait(delay))
            try:
                await self._idle
            except asyncio.CancelledError:
                if self._stopping:
                    return
                raise
            finally:
                self._idle = None
            if self._stopping:
                return
            delay = self._interval
            try:
                pending = await self._maintain()
                if pending:
                    delay = min(self._interval, MIGRATION_RETRY_SECONDS)
            except MaintenanceActive:
                # Another owner won admission. Retry after the full interval.
                continue
            except Exception:
                _log.exception("session_storage_maintenance_failed")
                if self._stopping or self._activities.snapshot().phase is not ActivityPhase.OPEN:
                    # Retain unresolved ownership failures, even before shutdown.
                    raise

    async def aclose(self) -> None:
        self._stopping = True
        if self._idle is not None:
            self._idle.cancel()
        if self._task is None:
            return
        cancellation: asyncio.CancelledError | None = None
        while True:
            try:
                await asyncio.shield(self._task)
                break
            except asyncio.CancelledError as error:
                if self._task.done():
                    # A cancelled callback is an unproven physical completion.
                    if self._task.cancelled():
                        raise
                    self._task.result()
                    cancellation = error
                    break
                cancellation = error
        if cancellation is not None:
            raise cancellation


def maintain_session_storage(database: Path) -> bool:
    """Bounded batches under the composition owner's sealed, exclusive domains.

    The time budget is checked between transactions. SQLite progress callbacks
    can interrupt a vacuum, but filesystem sync is not a hard-time operation.
    The caller must retain ownership and await actual completion in every case.
    """
    deadline = time.monotonic() + MAINTENANCE_BUDGET_SECONDS
    migrated = 0
    while time.monotonic() < deadline:
        with transaction(database) as connection:
            connection.execute("PRAGMA busy_timeout=0")
            connection.execute("BEGIN IMMEDIATE")
            count = SessionCatalogStore.migrate_bodies(connection, database)
            moved_blocks = ProductEventStore.migrate_blocks(connection, database)
            count += moved_blocks
            # Finish high-volume rows first so the sparse-body selector does
            # not rescan the remaining stream history on every batch.
            if not moved_blocks:
                count += ProductEventStore.migrate_bodies(connection, database)
        migrated += count
        if not count:
            removed_blocks = blocks.cleanup(database)
            compacted = journal.compact(
                database,
                lambda connection: chain(
                    SessionCatalogStore.body_references(connection),
                    ProductEventStore.body_references(connection),
                ),
                deadline=time.monotonic() + COMPACTION_BUDGET_SECONDS,
            )
            reclaimed = ProductEventStore.reclaim(
                database, deadline=time.monotonic() + MAINTENANCE_BUDGET_SECONDS
            )
            _log.info(
                "session_storage_maintenance_finished migrated=%s compacted=%s reclaimed=%s "
                "removed_block_files=%s",
                migrated,
                compacted,
                reclaimed,
                removed_blocks,
            )
            return False
    _log.info("session_storage_maintenance_deferred migrated=%s reason=budget", migrated)
    return True


async def await_storage_maintenance(operation: Callable[[], Result]) -> Result:
    """Join physical IO even if the awaiting lifecycle is cancelled repeatedly."""
    worker = asyncio.create_task(asyncio.to_thread(operation))
    cancellation: asyncio.CancelledError | None = None
    while True:
        try:
            result = await asyncio.shield(worker)
            break
        except asyncio.CancelledError as error:
            cancellation = error
            if worker.done():
                result = worker.result()
                break
    if cancellation is not None:
        raise cancellation
    return result
