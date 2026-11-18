"""Inspection and bounded maintenance for qualified session storage."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from pathlib import Path

from service.chat.persistence import blocks, journal
from service.chat.persistence.catalog import SessionCatalogStore
from service.chat.persistence.events import ProductEventStore
from service.persistence.project import (
    SQLITE_PRIMARY_RESULT_MASK,
    DatabaseMode,
    database_files,
    open_database,
    transaction,
)
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive

MAINTENANCE_BUDGET_SECONDS = 2.0
COMPACTION_BUDGET_SECONDS = 30.0
PROBE_PROGRESS_OPCODES = 1000
_log = logging.getLogger(__name__)


@contextmanager
def session_storage_phase(phase: str) -> Iterator[None]:
    _log.info("session_storage_maintenance phase=%s event=started", phase)
    try:
        yield
    except BaseException as error:
        _log.error(
            "session_storage_maintenance phase=%s event=failed error_type=%s "
            "error_code=%s sqlite_error=%s errno=%s",
            phase,
            type(error).__name__,
            getattr(error, "code", None),
            getattr(error, "sqlite_errorname", None),
            getattr(error, "errno", None),
        )
        raise
    else:
        _log.info("session_storage_maintenance phase=%s event=finished", phase)


class SessionStorageCheck:
    """Coalesce signals into read-only observations while the service is online."""

    def __init__(self, activities: Activities, database: Path) -> None:
        self._activities = activities
        self._database = database
        self._requested = asyncio.Event()
        self._stopping = False

    def request(self) -> None:
        self._requested.set()

    async def run(self) -> None:
        while not self._stopping:
            await self._requested.wait()
            self._requested.clear()
            if self._stopping:
                return
            try:
                pending = await self._activities.finish_thread(
                    ActivityDomain.DIAGNOSTIC, inspect_session_storage, self._database
                )
            except MaintenanceActive:
                continue
            except Exception:
                _log.exception("session_storage_check_failed phase=read_only_probe")
            else:
                if pending:
                    _log.info("session_storage_maintenance_pending mode=offline")

    def stop(self) -> None:
        self._stopping = True
        self.request()


def _body_references(connection: sqlite3.Connection) -> Iterator[str]:
    yield from SessionCatalogStore.body_references(connection)
    yield from ProductEventStore.body_references(connection)


def inspect_session_storage(database: Path) -> bool | None:
    """Look for actionable work on a shared snapshot without acquiring write admission."""
    deadline = time.monotonic() + MAINTENANCE_BUDGET_SECONDS

    def check_budget() -> None:
        if time.monotonic() >= deadline:
            raise TimeoutError("session storage maintenance probe budget expired")

    try:
        with database_files(database, stable_sidecars=False) as present:
            if not present:
                raise FileNotFoundError(database)
            with closing(
                open_database(database, mode=DatabaseMode.READ_ONLY, timeout=0.0)
            ) as connection:
                connection.execute("PRAGMA temp_store=MEMORY")
                connection.set_progress_handler(
                    lambda: int(time.monotonic() >= deadline), PROBE_PROGRESS_OPCODES
                )
                connection.execute("BEGIN")
                needed = (
                    SessionCatalogStore.has_inline_bodies(connection)
                    or ProductEventStore.has_legacy_events(connection)
                    or ProductEventStore.reclaim_needed(connection)
                    or journal.maintenance_needed(connection, _body_references, check_budget)
                    or blocks.cleanup_needed(connection, database, check_budget)
                )
                check_budget()
                return needed
    except TimeoutError:
        _log.info("session_storage_maintenance_deferred reason=probe_budget")
    except sqlite3.OperationalError as error:
        code = getattr(error, "sqlite_errorcode", 0) & SQLITE_PRIMARY_RESULT_MASK
        if code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            _log.info("session_storage_maintenance_deferred reason=probe_busy")
        elif code == sqlite3.SQLITE_INTERRUPT and time.monotonic() >= deadline:
            _log.info("session_storage_maintenance_deferred reason=probe_budget")
        else:
            raise
    return None


def maintain_session_storage(database: Path) -> bool:
    """Bounded batches under the caller's exclusive directory qualification.

    The time budget is checked between transactions. SQLite progress callbacks
    can interrupt a vacuum, but filesystem sync is not a hard-time operation.
    The caller must retain ownership and await actual completion in every case.
    """
    with session_storage_phase("migration"):
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
                break
        else:
            _log.info(
                "session_storage_maintenance_deferred phase=migration migrated=%s reason=budget",
                migrated,
            )
            return True
    with session_storage_phase("event_block_cleanup"):
        removed_blocks = blocks.cleanup(database)
    with session_storage_phase("body_log_compaction"):
        compacted = journal.compact(
            database, _body_references, deadline=time.monotonic() + COMPACTION_BUDGET_SECONDS
        )
    with session_storage_phase("sqlite_reclamation"):
        reclaimed = ProductEventStore.reclaim(
            database, deadline=time.monotonic() + MAINTENANCE_BUDGET_SECONDS
        )
    _log.info(
        "session_storage_maintenance_finished migrated=%s compacted=%s reclaimed=%s removed_block_files=%s",
        migrated,
        compacted,
        reclaimed,
        removed_blocks,
    )
    return False
