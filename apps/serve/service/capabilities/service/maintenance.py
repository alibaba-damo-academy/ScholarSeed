"""Run component migration after readiness, yielding to active conversations."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
from collections.abc import Callable

from service.capabilities.service.components import ComponentRegistry
from service.persistence.project import SQLITE_PRIMARY_RESULT_MASK
from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceActive

MAINTENANCE_INTERVAL_SECONDS = 1.0
FOREGROUND = (
    ActivityDomain.BRIDGE,
    ActivityDomain.INVOCATION,
    ActivityDomain.MODEL,
    ActivityDomain.RUNTIME,
    ActivityDomain.SETTLEMENT,
    ActivityDomain.TURN,
)
logger = logging.getLogger(__name__)


class ComponentMaintenance:
    def __init__(
        self,
        registry: ComponentRegistry,
        activities: Activities,
        session_exists: Callable[[str], bool],
    ) -> None:
        self._registry = registry
        self._activities = activities
        self._session_exists = session_exists
        self._stopping = asyncio.Event()
        self._migration_pending = True

    def _idle(self) -> bool:
        state = self._activities.snapshot()
        return (
            not self._stopping.is_set()
            and state.phase is ActivityPhase.OPEN
            and self._activities.workbench_ready
            and not any(state.counts.get(domain.value) for domain in FOREGROUND)
        )

    def _step(self) -> None:
        if self._registry.cleanup_pending:
            self._registry.resume_session_deletions(self._session_exists)
            self._registry.collect_resources(background=True)
        if self._migration_pending and self._idle():
            self._migration_pending = self._registry.maintain_storage(
                batch_size=1, can_continue=self._idle
            )

    async def run(self) -> None:
        while not self._stopping.is_set():
            try:
                await asyncio.wait_for(self._stopping.wait(), MAINTENANCE_INTERVAL_SECONDS)
                return
            except TimeoutError:
                pass
            if not self._registry.cleanup_pending and (
                not self._migration_pending or not self._idle()
            ):
                continue
            try:
                await self._activities.finish_thread(ActivityDomain.DIAGNOSTIC, self._step)
            except MaintenanceActive:
                continue
            except sqlite3.OperationalError as error:
                code = getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_RESULT_MASK
                if code not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                    logger.exception("component_storage_maintenance_failed")
            except Exception:
                logger.exception("component_storage_maintenance_failed")

    def stop(self) -> None:
        self._stopping.set()
