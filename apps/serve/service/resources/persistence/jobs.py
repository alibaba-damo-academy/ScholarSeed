"""SQLite-backed cross-project resource import job ledger."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from service.paths import RESOURCE_IMPORTS_DB
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
)
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
EVENT_SEQUENCE = f"COALESCE((SELECT MAX(seq) FROM {EVENTS_TABLE} WHERE {EVENTS_TABLE}.job_id = {JOBS_TABLE}.job_id),0)"
SQLITE_TIMEOUT_SECONDS = 15.0
LEASE_RENEWAL_SECONDS = 30.0
ADDITIVE_JOB_COLUMNS = {
    "scan_discovered_items": "INTEGER NOT NULL DEFAULT 0",
    "version_discovered_items": "INTEGER NOT NULL DEFAULT 0",
    "version_completed_items": "INTEGER NOT NULL DEFAULT 0",
    "version_total_items": "INTEGER NOT NULL DEFAULT 0",
    "event_seq": "INTEGER NOT NULL DEFAULT 0",
}


@dataclass(frozen=True)
class ImportSchema:
    """Import-owned structural and data initialization requirements."""

    create_tables: tuple[str, ...]
    add_columns: tuple[str, ...]
    create_indexes: tuple[str, ...]
    results_backfill: bool
    events_backfill: bool

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_tables
            or self.add_columns
            or self.create_indexes
            or self.results_backfill
            or self.events_backfill
        )


class ImportJobStore:
    def __init__(self, database: Path = RESOURCE_IMPORTS_DB) -> None:
        self.database = Path(database)
        if not self.inspect_schema(self.database).needs_write:
            return
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection, schema_transaction(connection):
            self.initialize_schema(connection)
            if self.inspect_connection(connection).needs_write:
                raise RuntimeError("import initialization did not reach the supported format")

    @classmethod
    def inspect_schema(cls, database: Path) -> ImportSchema:
        """Classify a WAL snapshot under caller-held directory qualification.

        Does not create missing source data or execute source DDL/DML. SQLite
        mode=ro may touch SHM; this is not filesystem or maintenance permission.
        """
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> ImportSchema:
        reject_schema_residue(connection, (JOBS_TABLE, RESULTS_TABLE, EVENTS_TABLE))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        create_tables, add_columns, create_indexes = [], [], []
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_schema(reference)
            for table, definition in reference.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'"
            ):
                if table not in objects:
                    create_tables.append(table)
                    continue
                if objects[table]["type"] != "table":
                    raise RuntimeError("unsupported import table object")
                declared = {row[1] for row in reference.execute(f"PRAGMA table_xinfo({table})")}
                actual = {row["name"] for row in connection.execute(f"PRAGMA table_xinfo({table})")}
                missing = declared - actual
                if missing - (ADDITIVE_JOB_COLUMNS.keys() if table == JOBS_TABLE else set()):
                    raise RuntimeError("unsupported import missing columns")
                add_columns.extend(sorted(missing))
                required = {
                    clause
                    for clause in table_clauses(definition, table)
                    if clause[0] not in missing
                }
                try:
                    clauses = table_clauses(objects[table]["sql"], table)
                except ValueError as error:
                    raise RuntimeError("unsupported import table definition") from error
                if len(clauses) != len(required) or set(clauses) != required:
                    raise RuntimeError("unsupported import schema declaration")
            for name, table, sql in reference.execute(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ):
                if name not in objects:
                    create_indexes.append(name)
                elif (
                    objects[name]["type"] != "index"
                    or objects[name]["tbl_name"] != table
                    or sql_tokens(objects[name]["sql"]) != sql_tokens(sql)
                ):
                    raise RuntimeError("unsupported import owned index")
        results_backfill = (
            bool(cls._pending_results(connection, RESULTS_TABLE in objects))
            if JOBS_TABLE in objects
            else False
        )
        events_backfill = False
        if JOBS_TABLE in objects and EVENTS_TABLE in objects:
            current = "0" if "event_seq" in add_columns else "event_seq"
            events_backfill = (
                connection.execute(
                    f"SELECT 1 FROM {JOBS_TABLE} WHERE {current} = 0 AND {EVENT_SEQUENCE} != 0 LIMIT 1"
                ).fetchone()
                is not None
            )
        return ImportSchema(
            tuple(sorted(create_tables)),
            tuple(add_columns),
            tuple(sorted(create_indexes)),
            results_backfill,
            events_backfill,
        )

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = open_database(self.database, timeout=SQLITE_TIMEOUT_SECONDS)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute(f"PRAGMA busy_timeout={int(SQLITE_TIMEOUT_SECONDS * 1000)}")
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _create_schema(connection: sqlite3.Connection) -> None:
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

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        schema = cls.inspect_connection(connection)
        if not schema.needs_write:
            return
        cls._create_schema(connection)
        if schema.results_backfill:
            now = time.time()
            for job_id, count in cls._pending_results(connection, True):
                connection.executemany(
                    f"INSERT INTO {RESULTS_TABLE} (job_id, source_index, status, updated_at) VALUES (?, ?, ?, ?)",
                    (
                        (job_id, index, ImportSourceStatus.PENDING.value, now)
                        for index in range(count)
                    ),
                )
        if schema.events_backfill:
            connection.execute(
                f"UPDATE {JOBS_TABLE} SET event_seq = {EVENT_SEQUENCE} WHERE event_seq = 0 AND {EVENT_SEQUENCE} != 0"
            )

    @staticmethod
    def _pending_results(
        connection: sqlite3.Connection, results_present: bool
    ) -> tuple[tuple[str, int], ...]:
        absent = (
            f"AND NOT EXISTS (SELECT 1 FROM {RESULTS_TABLE} WHERE {RESULTS_TABLE}.job_id = {JOBS_TABLE}.job_id)"
            if results_present
            else ""
        )
        pending = []
        for row in connection.execute(
            f"SELECT job_id,sources_json FROM {JOBS_TABLE} WHERE status IN (?,?) {absent}",
            (ImportJobStatus.QUEUED.value, ImportJobStatus.RUNNING.value),
        ):
            try:
                sources = json.loads(row["sources_json"])
            except (TypeError, ValueError) as error:
                raise RuntimeError("invalid import migration sources") from error
            if not isinstance(sources, list) or any(
                not isinstance(value, str) or not value for value in sources
            ):
                raise RuntimeError("invalid import migration sources")
            if not isinstance(row["job_id"], str) or not row["job_id"]:
                raise RuntimeError("invalid import migration identity")
            if sources:
                pending.append((row["job_id"], len(sources)))
        return tuple(pending)

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

    def record_source_results(
        self,
        job_id: str,
        worker_id: str,
        generation: int,
        results: tuple[ImportSourceResult, ...],
    ) -> bool:
        """Commit a source batch and its events together, never partial receipts."""
        indices = {result.source_index for result in results}
        if not results or len(indices) != len(results):
            raise ValueError("source result batch must contain unique indices")
        if any(result.status is ImportSourceStatus.PENDING for result in results):
            raise ValueError("source results must be terminal")
        now = time.time()
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active = connection.execute(
                f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ? AND worker_id = ?"
                " AND lease_generation = ? AND status = ?",
                (job_id, worker_id, generation, ImportJobStatus.RUNNING.value),
            ).fetchone()
            if active is None:
                return False
            pending = {
                row["source_index"]
                for row in connection.execute(
                    f"SELECT source_index FROM {RESULTS_TABLE} WHERE job_id = ? AND status = ?",
                    (job_id, ImportSourceStatus.PENDING.value),
                )
            }
            if not indices <= pending:
                return False
            for result in results:
                connection.execute(
                    f"UPDATE {RESULTS_TABLE} SET status = ?, error = ?, target_path = ?,"
                    " updated_at = ? WHERE job_id = ? AND source_index = ?",
                    (
                        result.status.value,
                        result.error,
                        result.target_path,
                        now,
                        job_id,
                        result.source_index,
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

    def recover_link(
        self, job_id: str, request_json: str, mounts: tuple[tuple[str, str], ...]
    ) -> None:
        with self.recovery_transaction() as connection:
            self.recover_link_rows(connection, job_id, request_json, mounts, now=time.time())

    @contextmanager
    def recovery_transaction(self) -> Iterator[sqlite3.Connection]:
        """Commit one recovery step before another owner acknowledges it."""
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            yield connection

    @classmethod
    def recover_link_rows(
        cls,
        connection: sqlite3.Connection,
        job_id: str,
        request_json: str,
        mounts: tuple[tuple[str, str], ...],
        *,
        now: float,
    ) -> None:
        """Validate and recover one receipt without opening another database."""
        if not connection.in_transaction:
            raise ValueError("LINK recovery requires a transaction")
        request = json.loads(request_json)
        keys = {
            "version",
            "owner_id",
            "project_id",
            "sources",
            "target_dir",
            "generation",
            "indices",
        }
        if (
            not isinstance(request, dict)
            or set(request) != keys
            or type(request["version"]) is not int
            or request["version"] != 1
        ):
            raise ValueError("unsupported LINK receipt")
        row = connection.execute(
            f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ? AND owner_id = ?",
            (job_id, request["owner_id"]),
        ).fetchone()
        job = cls._job(connection, row) if row is not None else None
        if (
            job is None
            or job.mode is not ImportMode.LINK
            or request["project_id"] != job.project_id
            or request["sources"] != list(job.sources)
            or request["target_dir"] != job.target_dir
            or type(request["generation"]) is not int
            or request["generation"] <= 0
            or request["generation"] != job.lease_generation
        ):
            raise ValueError("LINK receipt identity mismatch")
        indices = request["indices"]
        if (
            not isinstance(indices, list)
            or not indices
            or len(indices) != len(mounts)
            or any(type(index) is not int or not 0 <= index < len(job.sources) for index in indices)
            or len(set(indices)) != len(indices)
            or any(project != job.project_id or not path for project, path in mounts)
        ):
            raise ValueError("invalid LINK receipt sources")
        results = tuple(
            ImportSourceResult(index, ImportSourceStatus.SUCCEEDED, "", mount)
            for index, (_, mount) in zip(indices, mounts)
        )
        cls.recover_source_result_rows(connection, job, results, now=now)

    def recover_source_results(
        self, expected: ImportJob, results: tuple[ImportSourceResult, ...]
    ) -> None:
        """Reconcile committed effects without replaying external authorization."""
        with self.recovery_transaction() as connection:
            self.recover_source_result_rows(connection, expected, results, now=time.time())

    @classmethod
    def recover_source_result_rows(
        cls,
        connection: sqlite3.Connection,
        expected: ImportJob,
        results: tuple[ImportSourceResult, ...],
        *,
        now: float,
    ) -> None:
        """Share startup receipt recovery with isolated migration projections."""
        if not connection.in_transaction:
            raise ValueError("source result recovery requires a transaction")
        if (
            not results
            or len({row.source_index for row in results}) != len(results)
            or any(row.status is not ImportSourceStatus.SUCCEEDED for row in results)
        ):
            raise ValueError("invalid committed source results")
        row = connection.execute(
            f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (expected.job_id,)
        ).fetchone()
        if row is None:
            raise ValueError("root receipt job missing")
        current = cls._job(connection, row)
        if current.mode is not ImportMode.LINK or any(
            getattr(current, field) != getattr(expected, field)
            for field in (
                "owner_id",
                "project_id",
                "mode",
                "target_dir",
                "sources",
                "lease_generation",
            )
        ):
            raise ValueError("root receipt job identity mismatch")
        existing = {result.source_index: result for result in current.source_results}
        needs_repair = False
        for result in results:
            previous = existing.get(result.source_index)
            if previous is None or (
                previous.status is ImportSourceStatus.SUCCEEDED and previous != result
            ):
                raise ValueError("root receipt conflicts with source result")
            needs_repair |= previous != result
        if current.status is not ImportJobStatus.RUNNING and not needs_repair:
            return
        if current.status is ImportJobStatus.COMPLETED:
            raise ValueError("root receipt conflicts with completed job")
        for result in results:
            connection.execute(
                f"UPDATE {RESULTS_TABLE} SET status = ?, error = '', target_path = ?, updated_at = ?"
                " WHERE job_id = ? AND source_index = ?",
                (
                    result.status.value,
                    result.target_path,
                    now,
                    current.job_id,
                    result.source_index,
                ),
            )
        connection.execute(
            f"UPDATE {RESULTS_TABLE} SET status = ?, error = ?, updated_at = ?"
            " WHERE job_id = ? AND status = ?",
            (
                ImportSourceStatus.FAILED.value,
                "resource_import_interrupted",
                now,
                current.job_id,
                ImportSourceStatus.PENDING.value,
            ),
        )
        succeeded = sum(
            result.status is ImportSourceStatus.SUCCEEDED
            for result in cls._source_results(connection, current.job_id)
        )
        connection.execute(
            f"UPDATE {JOBS_TABLE} SET status = ?, phase = ?, error = ?, completed_items = ?,"
            " worker_id = NULL, lease_deadline = NULL, updated_at = ? WHERE job_id = ?",
            (
                (
                    ImportJobStatus.CANCELLED.value
                    if current.cancel_requested
                    else ImportJobStatus.PARTIAL.value
                ),
                ImportJobPhase.COMPLETED.value,
                "resource_import_interrupted",
                succeeded,
                now,
                current.job_id,
            ),
        )
        updated = connection.execute(
            f"SELECT * FROM {JOBS_TABLE} WHERE job_id = ?", (current.job_id,)
        ).fetchone()
        cls._append(
            connection,
            current.job_id,
            "job.recovered",
            cls._event_data(connection, updated),
            now,
        )

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
        return tuple(self._event(row) for row in rows)

    @staticmethod
    def _event(row: sqlite3.Row) -> ImportJobEvent:
        return ImportJobEvent(
            seq=int(row["seq"]),
            job_id=row["job_id"],
            event_type=row["event_type"],
            data=json.loads(row["data_json"]),
            created_at=float(row["created_at"]),
        )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Read jobs, their results and events through the normal record codecs.

        No worker is claimed, cancelled, recovered or launched by this pass.
        """
        for row in connection.execute(f"SELECT * FROM {JOBS_TABLE}"):
            cls._job(connection, row)
        for row in connection.execute(f"SELECT * FROM {EVENTS_TABLE}"):
            cls._event(row)

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
