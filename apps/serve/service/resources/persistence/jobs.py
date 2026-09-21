"""SQLite-backed cross-project resource import job ledger."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from service.paths import RESOURCE_IMPORTS_DB
from service.platform.content import ImportMode
from service.resources.domain.jobs import (
    ImportJob,
    ImportJobEvent,
    ImportJobPhase,
    ImportJobStatus,
    ImportSourceResult,
    ImportSourceStatus,
)

JOBS_TABLE = "resource_import_jobs"
RESULTS_TABLE = "resource_import_results"
EVENTS_TABLE = "resource_import_events"
SQLITE_TIMEOUT_SECONDS = 15.0
LEASE_RENEWAL_SECONDS = 30.0
ADDITIVE_JOB_COLUMNS = {
    "scan_discovered_items": "INTEGER NOT NULL DEFAULT 0",
    "version_discovered_items": "INTEGER NOT NULL DEFAULT 0",
    "version_completed_items": "INTEGER NOT NULL DEFAULT 0",
    "version_total_items": "INTEGER NOT NULL DEFAULT 0",
    "event_seq": "INTEGER NOT NULL DEFAULT 0",
}


class ImportJobStore:
    def __init__(self, database: Path = RESOURCE_IMPORTS_DB) -> None:
        self.database = Path(database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            self._schema(connection)

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.database, timeout=SQLITE_TIMEOUT_SECONDS)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(f"PRAGMA busy_timeout={int(SQLITE_TIMEOUT_SECONDS * 1000)}")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {JOBS_TABLE} (
            job_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            target_dir TEXT NOT NULL,
            sources_json TEXT NOT NULL,
            request_digest TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            status TEXT NOT NULL,
            phase TEXT NOT NULL,
            scan_discovered_items INTEGER NOT NULL DEFAULT 0,
            completed_items INTEGER NOT NULL DEFAULT 0,
            total_items INTEGER NOT NULL DEFAULT 0,
            completed_bytes INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            version_discovered_items INTEGER NOT NULL DEFAULT 0,
            version_completed_items INTEGER NOT NULL DEFAULT 0,
            version_total_items INTEGER NOT NULL DEFAULT 0,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            worker_id TEXT,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            event_seq INTEGER NOT NULL DEFAULT 0,
            lease_deadline REAL,
            UNIQUE(owner_id, idempotency_key)
        )""")
        existing_columns = {
            row[1] for row in connection.execute(f"PRAGMA table_info({JOBS_TABLE})").fetchall()
        }
        for name, declaration in ADDITIVE_JOB_COLUMNS.items():
            if name not in existing_columns:
                connection.execute(f"ALTER TABLE {JOBS_TABLE} ADD COLUMN {name} {declaration}")
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {RESULTS_TABLE} (
            job_id TEXT NOT NULL REFERENCES {JOBS_TABLE}(job_id) ON DELETE CASCADE,
            source_index INTEGER NOT NULL,
            status TEXT NOT NULL,
            error TEXT NOT NULL DEFAULT '',
            target_path TEXT NOT NULL DEFAULT '',
            updated_at REAL NOT NULL,
            PRIMARY KEY(job_id, source_index)
        )""")
        active_rows = connection.execute(
            f"SELECT job_id, sources_json FROM {JOBS_TABLE} WHERE status IN (?, ?)"
            f" AND NOT EXISTS (SELECT 1 FROM {RESULTS_TABLE}"
            f" WHERE {RESULTS_TABLE}.job_id = {JOBS_TABLE}.job_id)",
            (ImportJobStatus.QUEUED.value, ImportJobStatus.RUNNING.value),
        ).fetchall()
        now = time.time()
        for row in active_rows:
            sources = tuple(json.loads(row["sources_json"]))
            connection.executemany(
                f"INSERT INTO {RESULTS_TABLE} (job_id, source_index, status, updated_at)"
                " VALUES (?, ?, ?, ?)",
                tuple(
                    (row["job_id"], source_index, ImportSourceStatus.PENDING.value, now)
                    for source_index, _source in enumerate(sources)
                ),
            )
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {EVENTS_TABLE} (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT NOT NULL REFERENCES {JOBS_TABLE}(job_id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at REAL NOT NULL
        )""")
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS {EVENTS_TABLE}_job_seq ON {EVENTS_TABLE}(job_id, seq)"
        )
        connection.execute(
            f"UPDATE {JOBS_TABLE} SET event_seq = COALESCE("
            f"(SELECT MAX(seq) FROM {EVENTS_TABLE} WHERE {EVENTS_TABLE}.job_id = {JOBS_TABLE}.job_id),"
            " 0) WHERE event_seq = 0"
        )

    def create(
        self,
        *,
        owner_id: str,
        project_id: str,
        mode: ImportMode,
        target_dir: str,
        sources: tuple[str, ...],
        request_digest: str,
        idempotency_key: str,
    ) -> ImportJob:
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE owner_id = ? AND idempotency_key = ?",
                (owner_id, idempotency_key),
            ).fetchone()
            if existing is not None:
                if existing["request_digest"] != request_digest:
                    raise ValueError("resource_import_idempotency_conflict")
                return self._job(connection, existing)
            job_id = uuid4().hex
            connection.execute(
                f"INSERT INTO {JOBS_TABLE} (job_id, owner_id, project_id, mode, target_dir,"
                " sources_json, request_digest, idempotency_key, status, phase, total_items,"
                " created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    job_id,
                    owner_id,
                    project_id,
                    mode.value,
                    target_dir,
                    json.dumps(sources, ensure_ascii=False),
                    request_digest,
                    idempotency_key,
                    ImportJobStatus.QUEUED.value,
                    ImportJobPhase.QUEUED.value,
                    len(sources),
                    now,
                    now,
                ),
            )
            connection.executemany(
                f"INSERT INTO {RESULTS_TABLE} (job_id, source_index, status, updated_at)"
                " VALUES (?, ?, ?, ?)",
                tuple(
                    (job_id, source_index, ImportSourceStatus.PENDING.value, now)
                    for source_index, _source in enumerate(sources)
                ),
            )
            self._append(connection, job_id, "job.queued", {"phase": "queued"}, now)
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            created = self._job(connection, row)
        return created

    def claim(self, worker_id: str, lease_seconds: float) -> ImportJob | None:
        now = time.time()
        deadline = now + lease_seconds
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE cancel_requested = 0 AND "
                "status = ? "
                "ORDER BY created_at ASC LIMIT 1",
                (ImportJobStatus.QUEUED.value,),
            ).fetchone()
            if row is None:
                return None
            generation = int(row["lease_generation"]) + 1
            cursor = connection.execute(
                f"UPDATE {JOBS_TABLE} SET status = ?, worker_id = ?, lease_generation = ?,"
                " lease_deadline = ?, updated_at = ? WHERE job_id = ? AND lease_generation = ?",
                (
                    ImportJobStatus.RUNNING.value,
                    worker_id,
                    generation,
                    deadline,
                    now,
                    row["job_id"],
                    row["lease_generation"],
                ),
            )
            if cursor.rowcount != 1:
                return None
            claimed = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (row["job_id"],)
            ).fetchone()
            job = self._job(connection, claimed)
        return job

    def interrupt_expired(self) -> int:
        """Fail expired work instead of replaying non-transactional filesystem effects."""

        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                f"SELECT job_id, completed_items, EXISTS("
                f"SELECT 1 FROM {RESULTS_TABLE} WHERE {RESULTS_TABLE}.job_id = "
                f"{JOBS_TABLE}.job_id AND status = ?) AS source_succeeded FROM {JOBS_TABLE}"
                " WHERE status = ? AND lease_deadline < ?",
                (
                    ImportSourceStatus.SUCCEEDED.value,
                    ImportJobStatus.RUNNING.value,
                    now,
                ),
            ).fetchall()
            for row in rows:
                status = (
                    ImportJobStatus.PARTIAL
                    if bool(row["source_succeeded"]) or int(row["completed_items"]) > 0
                    else ImportJobStatus.FAILED
                )
                connection.execute(
                    f"UPDATE {JOBS_TABLE} SET status = ?, phase = ?, error = ?,"
                    " worker_id = NULL, lease_deadline = NULL, updated_at = ? WHERE job_id = ?",
                    (
                        status.value,
                        ImportJobPhase.COMPLETED.value,
                        "resource_import_interrupted",
                        now,
                        row["job_id"],
                    ),
                )
                connection.execute(
                    f"UPDATE {RESULTS_TABLE} SET status = ?, error = ?, updated_at = ?"
                    " WHERE job_id = ? AND status = ?",
                    (
                        ImportSourceStatus.FAILED.value,
                        "resource_import_interrupted",
                        now,
                        row["job_id"],
                        ImportSourceStatus.PENDING.value,
                    ),
                )
                updated = connection.execute(
                    f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (row["job_id"],)
                ).fetchone()
                self._append(
                    connection,
                    row["job_id"],
                    "job.interrupted",
                    self._event_data(connection, updated),
                    now,
                )
        return len(rows)

    def update(
        self,
        job_id: str,
        worker_id: str,
        generation: int,
        *,
        status: ImportJobStatus,
        phase: ImportJobPhase,
        completed_items: int,
        completed_bytes: int,
        total_bytes: int,
        total_items: int | None = None,
        scan_discovered_items: int | None = None,
        version_discovered_items: int | None = None,
        version_completed_items: int | None = None,
        version_total_items: int | None = None,
        error: str = "",
    ) -> bool:
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"UPDATE {JOBS_TABLE} SET status = ?, phase = ?,"
                " scan_discovered_items = COALESCE(?, scan_discovered_items),"
                " completed_items = ?,"
                " total_items = COALESCE(?, total_items), completed_bytes = ?,"
                " total_bytes = ?,"
                " version_discovered_items = COALESCE(?, version_discovered_items),"
                " version_completed_items = COALESCE(?, version_completed_items),"
                " version_total_items = COALESCE(?, version_total_items),"
                " error = ?, updated_at = ?,"
                " lease_deadline = ?"
                " WHERE job_id = ? AND worker_id = ? AND lease_generation = ?",
                (
                    status.value,
                    phase.value,
                    scan_discovered_items,
                    completed_items,
                    total_items,
                    completed_bytes,
                    total_bytes,
                    version_discovered_items,
                    version_completed_items,
                    version_total_items,
                    error,
                    now,
                    now + LEASE_RENEWAL_SECONDS,
                    job_id,
                    worker_id,
                    generation,
                ),
            )
            if cursor.rowcount != 1:
                return False
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            self._append(
                connection,
                job_id,
                "job.updated",
                self._event_data(connection, row),
                now,
            )
        return True

    def request_cancel(self, job_id: str, owner_id: str) -> ImportJob | None:
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                f"UPDATE {JOBS_TABLE} SET cancel_requested = 1,"
                " status = CASE WHEN status = ? THEN ? ELSE status END,"
                " phase = CASE WHEN status = ? THEN ? ELSE phase END, updated_at = ?"
                " WHERE job_id = ? AND owner_id = ?",
                (
                    ImportJobStatus.QUEUED.value,
                    ImportJobStatus.CANCELLED.value,
                    ImportJobStatus.QUEUED.value,
                    ImportJobPhase.COMPLETED.value,
                    now,
                    job_id,
                    owner_id,
                ),
            )
            if cursor.rowcount != 1:
                return None
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            if row["status"] == ImportJobStatus.CANCELLED.value:
                connection.execute(
                    f"UPDATE {RESULTS_TABLE} SET status = ?, updated_at = ?"
                    " WHERE job_id = ? AND status = ?",
                    (
                        ImportSourceStatus.CANCELLED.value,
                        now,
                        job_id,
                        ImportSourceStatus.PENDING.value,
                    ),
                )
            self._append(
                connection,
                job_id,
                "job.cancel_requested",
                self._event_data(connection, row),
                now,
            )
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            job = self._job(connection, row)
        return job

    def retry(self, job_id: str, owner_id: str) -> ImportJob | None:
        now = time.time()
        terminal = tuple(
            status.value
            for status in (
                ImportJobStatus.FAILED,
                ImportJobStatus.PARTIAL,
                ImportJobStatus.CANCELLED,
            )
        )
        placeholders = ",".join("?" for _item in terminal)
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            result_count = connection.execute(
                f"SELECT COUNT(*) FROM {RESULTS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()[0]
            if int(result_count) == 0:
                return None
            cursor = connection.execute(
                f"UPDATE {JOBS_TABLE} SET status = ?, phase = ?, scan_discovered_items = 0,"
                " completed_items = 0, completed_bytes = 0, total_bytes = 0,"
                " version_discovered_items = 0, version_completed_items = 0,"
                " version_total_items = 0,"
                " cancel_requested = 0, error = '',"
                " worker_id = NULL, lease_deadline = NULL, updated_at = ?"
                f" WHERE job_id = ? AND owner_id = ? AND status IN ({placeholders})",
                (
                    ImportJobStatus.QUEUED.value,
                    ImportJobPhase.QUEUED.value,
                    now,
                    job_id,
                    owner_id,
                    *terminal,
                ),
            )
            if cursor.rowcount != 1:
                return None
            connection.execute(
                f"UPDATE {RESULTS_TABLE} SET status = ?, error = '', target_path = '',"
                " updated_at = ? WHERE job_id = ? AND status IN (?, ?)",
                (
                    ImportSourceStatus.PENDING.value,
                    now,
                    job_id,
                    ImportSourceStatus.FAILED.value,
                    ImportSourceStatus.CANCELLED.value,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            self._append(
                connection,
                job_id,
                "job.retried",
                self._event_data(connection, row),
                now,
            )
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            job = self._job(connection, row)
        return job

    def record_source_result(
        self,
        job_id: str,
        worker_id: str,
        generation: int,
        source_index: int,
        status: ImportSourceStatus,
        *,
        error: str = "",
        target_path: str = "",
    ) -> bool:
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                f"SELECT 1 FROM {JOBS_TABLE} WHERE job_id = ? AND worker_id = ?"
                " AND lease_generation = ?",
                (job_id, worker_id, generation),
            ).fetchone()
            if active is None:
                return False
            cursor = connection.execute(
                f"UPDATE {RESULTS_TABLE} SET status = ?, error = ?, target_path = ?,"
                " updated_at = ? WHERE job_id = ? AND source_index = ? AND status = ?",
                (
                    status.value,
                    error,
                    target_path,
                    now,
                    job_id,
                    source_index,
                    ImportSourceStatus.PENDING.value,
                ),
            )
            if cursor.rowcount != 1:
                return False
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            self._append(
                connection,
                job_id,
                "job.source_result",
                self._event_data(connection, row),
                now,
            )
        return True

    def mark_pending_sources(
        self,
        job_id: str,
        worker_id: str,
        generation: int,
        status: ImportSourceStatus,
        *,
        error: str = "",
    ) -> bool:
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                f"SELECT 1 FROM {JOBS_TABLE} WHERE job_id = ? AND worker_id = ?"
                " AND lease_generation = ?",
                (job_id, worker_id, generation),
            ).fetchone()
            if active is None:
                return False
            connection.execute(
                f"UPDATE {RESULTS_TABLE} SET status = ?, error = ?, updated_at = ?"
                " WHERE job_id = ? AND status = ?",
                (
                    status.value,
                    error,
                    now,
                    job_id,
                    ImportSourceStatus.PENDING.value,
                ),
            )
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (job_id,)
            ).fetchone()
            self._append(
                connection,
                job_id,
                "job.source_result",
                self._event_data(connection, row),
                now,
            )
        return True

    def cancelled(self, job_id: str, worker_id: str, generation: int) -> bool:
        with self._connection() as connection:
            row = connection.execute(
                f"SELECT cancel_requested, worker_id, lease_generation FROM {JOBS_TABLE}"
                " WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        return bool(
            row is None
            or row["worker_id"] != worker_id
            or int(row["lease_generation"]) != generation
            or row["cancel_requested"]
        )

    def get(self, job_id: str, owner_id: str) -> ImportJob | None:
        with self._connection() as connection:
            row = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ? AND owner_id = ?",
                (job_id, owner_id),
            ).fetchone()
            return self._job(connection, row) if row is not None else None

    def list(self, owner_id: str) -> tuple[ImportJob, ...]:
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE owner_id = ? ORDER BY created_at DESC",
                (owner_id,),
            ).fetchall()
            return tuple(self._job(connection, row) for row in rows)

    def events(self, job_id: str, after_seq: int) -> tuple[ImportJobEvent, ...]:
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM {EVENTS_TABLE} WHERE job_id = ? AND seq > ? ORDER BY seq ASC",
                (job_id, after_seq),
            ).fetchall()
        return tuple(
            ImportJobEvent(
                seq=int(row["seq"]),
                job_id=row["job_id"],
                event_type=row["event_type"],
                data=json.loads(row["data_json"]),
                created_at=float(row["created_at"]),
            )
            for row in rows
        )

    @staticmethod
    def _append(
        connection: sqlite3.Connection,
        job_id: str,
        event_type: str,
        data: dict[str, object],
        created_at: float,
    ) -> None:
        cursor = connection.execute(
            f"INSERT INTO {EVENTS_TABLE} (job_id, event_type, data_json, created_at)"
            " VALUES (?, ?, ?, ?)",
            (job_id, event_type, json.dumps(data, ensure_ascii=False), created_at),
        )
        event_sequence = cursor.lastrowid
        if event_sequence is None:
            raise RuntimeError("resource job event insert did not return a sequence")
        connection.execute(
            f"UPDATE {JOBS_TABLE} SET event_seq = ? WHERE job_id = ?",
            (event_sequence, job_id),
        )

    @staticmethod
    def _source_results(
        connection: sqlite3.Connection, job_id: str
    ) -> tuple[ImportSourceResult, ...]:
        rows = connection.execute(
            f"SELECT source_index, status, error, target_path FROM {RESULTS_TABLE}"
            " WHERE job_id = ? ORDER BY source_index ASC",
            (job_id,),
        ).fetchall()
        return tuple(
            ImportSourceResult(
                source_index=int(result["source_index"]),
                status=ImportSourceStatus(result["status"]),
                error=result["error"],
                target_path=result["target_path"],
            )
            for result in rows
        )

    @classmethod
    def _event_data(cls, connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, object]:
        source_results = cls._source_results(connection, row["job_id"])
        return {
            "status": row["status"],
            "phase": row["phase"],
            "scan_discovered_items": int(row["scan_discovered_items"]),
            "completed_items": int(row["completed_items"]),
            "total_items": int(row["total_items"]),
            "completed_bytes": int(row["completed_bytes"]),
            "total_bytes": int(row["total_bytes"]),
            "version_discovered_items": int(row["version_discovered_items"]),
            "version_completed_items": int(row["version_completed_items"]),
            "version_total_items": int(row["version_total_items"]),
            "source_results": [
                {
                    "source_index": result.source_index,
                    "status": result.status.value,
                    "error": result.error,
                }
                for result in source_results
            ],
            "error": row["error"],
            "updated_at": float(row["updated_at"]),
        }

    @classmethod
    def _job(cls, connection: sqlite3.Connection, row: sqlite3.Row) -> ImportJob:
        return ImportJob(
            job_id=row["job_id"],
            owner_id=row["owner_id"],
            project_id=row["project_id"],
            mode=ImportMode(row["mode"]),
            target_dir=row["target_dir"],
            sources=tuple(json.loads(row["sources_json"])),
            source_results=cls._source_results(connection, row["job_id"]),
            status=ImportJobStatus(row["status"]),
            phase=ImportJobPhase(row["phase"]),
            scan_discovered_items=int(row["scan_discovered_items"]),
            completed_items=int(row["completed_items"]),
            total_items=int(row["total_items"]),
            completed_bytes=int(row["completed_bytes"]),
            total_bytes=int(row["total_bytes"]),
            version_discovered_items=int(row["version_discovered_items"]),
            version_completed_items=int(row["version_completed_items"]),
            version_total_items=int(row["version_total_items"]),
            cancel_requested=bool(row["cancel_requested"]),
            error=row["error"],
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            lease_generation=int(row["lease_generation"]),
            event_seq=int(row["event_seq"]),
        )


__all__ = ["ImportJobStore"]
