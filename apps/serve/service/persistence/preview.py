"""Bounded SQLite migration projection on an isolated in-memory snapshot.

This primitive supplies layout, typed row identity and explicit reader coverage,
never whole-data compatibility or a write grant. Persistence owners supply their
actual migration and inspection functions; directory qualification remains the
composition owner's duty.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import closing, contextmanager, nullcontext
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Protocol

from service.persistence.limits import SQLITE_TOTAL_BYTES
from service.persistence.project import (
    database_files,
    reader,
    schema_transaction,
    sql_tokens,
    table_clauses,
)
from service.persistence.rows import restore_rows, rows_digest

MAX_SNAPSHOT_BYTES = SQLITE_TOTAL_BYTES
MAX_LAYOUT_BYTES = 8 * 1024 * 1024
PREVIEW_SECONDS = 30
MAX_LAYOUT_OBJECTS = 4096
MAX_LAYOUT_DATABASES = 4096


class SnapshotBudgetExceeded(RuntimeError):
    """A qualified SQLite source or its private projection exceeds the byte cap."""


class SchemaState(Protocol):
    @property
    def needs_write(self) -> bool: ...


@dataclass(frozen=True)
class SchemaOwner:
    name: str
    inspect: Callable[[sqlite3.Connection], SchemaState]
    initialize: Callable[[sqlite3.Connection], None]
    # Some owners expose only schema inspection so far. Absence is not a row
    # compatibility claim; whole-product activation stays with composition.
    read_rows: Callable[[sqlite3.Connection], None] | None = None
    # Declarations come only from this version's code, never from wire data.
    triggers: Callable[[], Sequence[tuple[str, str, str]]] | None = None


@dataclass(frozen=True)
class SchemaObject:
    kind: str
    name: str
    table: str
    sql: str


@dataclass(frozen=True)
class DatabasePreview:
    name: str
    present: bool
    source_digest: str
    owners: tuple[str, ...]
    objects: tuple[SchemaObject, ...]
    rows_digest: str
    row_readers: tuple[str, ...]


@dataclass(frozen=True)
class LayoutCheck:
    name: str
    source_digest: str
    owners: tuple[str, ...]
    row_readers: tuple[str, ...]


class CandidateRowsRequired(ValueError):
    """Different projections need direct source reads, not an incompatibility guess."""


def decode_previews(value: object) -> tuple[DatabasePreview, ...]:
    """Decode the closed private wire representation, without executing SQL."""
    if not isinstance(value, list) or not 0 < len(value) <= MAX_LAYOUT_DATABASES:
        raise ValueError("invalid SQLite preview collection")
    previews = []
    names = set()
    budget = 0
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {
            "name",
            "present",
            "source_digest",
            "owners",
            "objects",
            "rows_digest",
            "row_readers",
        }:
            raise ValueError("invalid SQLite preview fields")
        name, present, digest, owners, objects = (
            entry[key] for key in ("name", "present", "source_digest", "owners", "objects")
        )
        row_digest, row_readers = entry["rows_digest"], entry["row_readers"]
        if (
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", name)
            or name in names
            or not isinstance(present, bool)
            or not isinstance(digest, str)
            or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or not isinstance(owners, list)
            or not 0 < len(owners) <= 64
            or any(
                not isinstance(owner, str)
                or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,127}", owner)
                for owner in owners
            )
            or len(set(owners)) != len(owners)
            or not isinstance(objects, list)
            or len(objects) > MAX_LAYOUT_OBJECTS
            or not isinstance(row_digest, str)
            or not re.fullmatch(r"[a-f0-9]{64}", row_digest)
            or not isinstance(row_readers, list)
            or len(row_readers) > len(owners)
            or any(not isinstance(owner, str) or owner not in owners for owner in row_readers)
            or len(set(row_readers)) != len(row_readers)
        ):
            raise ValueError("invalid SQLite preview identity")
        decoded = []
        object_names = set()
        for row in objects:
            if not isinstance(row, dict) or set(row) != {"kind", "name", "table", "sql"}:
                raise ValueError("invalid SQLite layout object")
            if any(
                not isinstance(row[key], str) or not row[key] or "\0" in row[key] for key in row
            ):
                raise ValueError("invalid SQLite layout text")
            if (
                row["kind"] not in {"table", "index", "trigger"}
                or row["name"] in object_names
                or row["name"].lower().startswith("sqlite_")
            ):
                raise ValueError("unsupported SQLite layout object")
            if len(row["name"]) > 512 or len(row["table"]) > 512:
                raise ValueError("invalid SQLite layout identifier")
            budget += len(row["sql"].encode("utf-8"))
            if budget > MAX_LAYOUT_BYTES:
                raise ValueError("SQLite layout exceeds budget")
            object_names.add(row["name"])
            decoded.append(SchemaObject(**row))
        names.add(name)
        previews.append(
            DatabasePreview(
                name, present, digest, tuple(owners), tuple(decoded), row_digest, tuple(row_readers)
            )
        )
    return tuple(previews)


def _require_owned_triggers(
    objects: Sequence[SchemaObject], owners: Sequence[SchemaOwner], *, complete: bool = True
) -> tuple[SchemaObject, ...]:
    declared: dict[str, SchemaObject] = {}
    for owner in owners:
        if owner.triggers is None:
            continue
        for name, table, sql in owner.triggers():
            if name in declared or len(declared) >= MAX_LAYOUT_OBJECTS:
                raise ValueError("SQLite trigger ownership overlaps or exceeds budget")
            declared[name] = SchemaObject("trigger", name, table, sql)
    actual = {row.name: row for row in objects if row.kind == "trigger"}
    if (complete and set(actual) != set(declared)) or not set(actual) <= set(declared):
        raise ValueError("unsupported SQLite trigger ownership")
    for name, row in actual.items():
        expected = declared[name]
        if row.table != expected.table or sql_tokens(row.sql) != sql_tokens(expected.sql):
            raise ValueError("unsupported SQLite trigger declaration")
    return tuple(declared.values())


def require_candidate_layout(
    candidate: DatabasePreview,
    source: DatabasePreview,
    owners: Sequence[SchemaOwner],
    *,
    read_candidate: Callable[[DatabasePreview], Iterable[bytes]] | None = None,
) -> LayoutCheck:
    """Use this version's real readers on a candidate layout in memory only.

    No initializer is called on candidate declarations. A layout needing
    source-side repair cannot prove direct reading. Equal row observations bind
    only the source's explicitly executed row readers; missing readers and
    different projected rows still require additional owner checks.
    """
    expected = tuple(owner.name for owner in owners)
    if (candidate.name, candidate.present, candidate.source_digest, candidate.owners) != (
        source.name,
        source.present,
        source.source_digest,
        expected,
    ) or source.owners != expected:
        raise ValueError("SQLite preview source or ownership changed")
    readers = tuple(owner.name for owner in owners if owner.read_rows is not None)
    if source.row_readers != readers:
        raise ValueError("SQLite source row reader coverage changed")
    # Direct in-process callers obey the same closed representation as pipe
    # callers. In particular, never silently skip an unknown object kind.
    if len(candidate.objects) > MAX_LAYOUT_OBJECTS:
        raise ValueError("SQLite layout exceeds object budget")
    decode_previews(
        [
            {
                "name": candidate.name,
                "present": candidate.present,
                "source_digest": candidate.source_digest,
                "owners": list(candidate.owners),
                "objects": [
                    {"kind": row.kind, "name": row.name, "table": row.table, "sql": row.sql}
                    for row in candidate.objects
                ],
                "rows_digest": candidate.rows_digest,
                "row_readers": list(candidate.row_readers),
            }
        ]
    )
    triggers = _require_owned_triggers(candidate.objects, owners)
    deadline = time.monotonic() + PREVIEW_SECONDS
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("PRAGMA trusted_schema=OFF")
        page_size = int(connection.execute("PRAGMA page_size").fetchone()[0])
        connection.execute(f"PRAGMA max_page_count={MAX_SNAPSHOT_BYTES // page_size}")
        connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)

        installing_triggers = False

        def authorize(action, _first, second, _database, _trigger):
            if action in {
                sqlite3.SQLITE_ATTACH,
                sqlite3.SQLITE_DETACH,
                sqlite3.SQLITE_CREATE_VIEW,
                sqlite3.SQLITE_CREATE_VTABLE,
            }:
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_CREATE_TRIGGER and not installing_triggers:
                return sqlite3.SQLITE_DENY
            if action == sqlite3.SQLITE_FUNCTION and str(second).casefold() == "load_extension":
                return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK

        connection.set_authorizer(authorize)
        for kind in ("table", "index"):
            for row in candidate.objects:
                if row.kind != kind:
                    continue
                tokens = sql_tokens(row.sql)
                if kind == "table":
                    table_clauses(row.sql, row.name)
                    if row.name != row.table:
                        raise ValueError("SQLite table identity changed")
                elif tokens[:2] != ("create", "index") and tokens[:3] != (
                    "create",
                    "unique",
                    "index",
                ):
                    raise ValueError("unsupported SQLite index declaration")
                connection.execute(row.sql)
                actual = connection.execute(
                    "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?", (row.name,)
                ).fetchone()
                if (
                    actual is None
                    or actual[0] != kind
                    or actual[1] != row.table
                    or sql_tokens(actual[2]) != tokens
                ):
                    raise ValueError("SQLite replay changed declared identity")
                if time.monotonic() >= deadline:
                    raise RuntimeError("SQLite layout read budget exceeded")
        different_rows = candidate.rows_digest != source.rows_digest
        if different_rows:
            if read_candidate is None:
                raise CandidateRowsRequired("candidate rows require direct source reading")
            restore_rows(
                connection, read_candidate(candidate), candidate.rows_digest, deadline=deadline
            )
        # Populate rows before installing triggers: reconstruction must not run
        # even a trusted INSERT/DELETE trigger and alter the observed candidate.
        # Execute this version's compiled declaration, never candidate SQL here.
        connection.execute("PRAGMA query_only=OFF")
        installing_triggers = True
        for trigger in triggers:
            connection.execute(trigger.sql)
        installing_triggers = False
        connection.execute("PRAGMA query_only=ON")
        for owner in owners:
            if owner.inspect(connection).needs_write:
                raise ValueError("candidate layout is not directly readable by source")
            if different_rows and owner.read_rows is not None:
                owner.read_rows(connection)
            if time.monotonic() >= deadline:
                raise RuntimeError("SQLite source row read budget exceeded")
        return LayoutCheck(source.name, source.source_digest, expected, readers)


def preview_database(
    database: Path | None, name: str, owners: Sequence[SchemaOwner]
) -> DatabasePreview:
    with projected_database(database, name, owners) as (preview, _connection, _deadline):
        return preview


@contextmanager
def projected_database(
    database: Path | None, name: str, owners: Sequence[SchemaOwner]
) -> Iterator[tuple[DatabasePreview, sqlite3.Connection, float]]:
    """Run the real owner migrations on a private copy of one committed WAL snapshot.

    Rows stay on this private connection unless explicitly streamed to the
    source inspector through its private pipe. The result describes DDL and typed row
    identity, with explicit reader coverage; external files, provider state and
    other row codecs still need owner contracts. Failure
    discards the copy and cannot modify the qualified source database. A None
    path is only for a caller that has proved the private database directory
    absent under its qualified parent; it performs no filesystem access.
    """
    if not owners or not name or len({owner.name for owner in owners}) != len(owners):
        raise ValueError("invalid SQLite preview owners")
    deadline = time.monotonic() + PREVIEW_SECONDS

    def progress(_status: int, _remaining: int, total: int) -> None:
        if total * page_size > MAX_SNAPSHOT_BYTES:
            raise SnapshotBudgetExceeded("SQLite preview snapshot budget exceeded")
        if time.monotonic() >= deadline:
            raise RuntimeError("SQLite preview deadline exceeded")

    files = database_files(database) if database is not None else nullcontext(False)
    with files as present, closing(sqlite3.connect(":memory:")) as projected:
        projected.row_factory = sqlite3.Row
        projected.execute("PRAGMA temp_store=MEMORY")
        projected.execute("PRAGMA trusted_schema=OFF")
        digest = hashlib.sha256(b"empty-sqlite").hexdigest()
        if present:
            if database is None:
                raise ValueError("present SQLite preview requires its source path")
            with reader(database) as source:
                source.execute("BEGIN")
                page_size = int(source.execute("PRAGMA page_size").fetchone()[0])
                pages = int(source.execute("PRAGMA page_count").fetchone()[0])
                progress(0, pages, pages)
                digest = hashlib.sha256(
                    source.serialize() if pages else b"empty-sqlite"
                ).hexdigest()
                source.backup(projected, pages=256, progress=progress)
        pages = int(projected.execute("PRAGMA page_count").fetchone()[0])
        page_size = int(projected.execute("PRAGMA page_size").fetchone()[0])
        projected.execute(f"PRAGMA max_page_count={MAX_SNAPSHOT_BYTES // page_size}")
        projected.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        _require_owned_triggers(
            tuple(
                SchemaObject(*row)
                for row in projected.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type='trigger'"
                )
            ),
            owners,
            complete=False,
        )
        for owner in owners:
            with schema_transaction(projected):
                owner.inspect(projected)
                owner.initialize(projected)
                if owner.inspect(projected).needs_write:
                    raise RuntimeError("SQLite owner migration did not converge")
            size = int(projected.execute("PRAGMA page_count").fetchone()[0]) * int(
                projected.execute("PRAGMA page_size").fetchone()[0]
            )
            if size > MAX_SNAPSHOT_BYTES:
                raise SnapshotBudgetExceeded("SQLite preview snapshot budget exceeded")
            if time.monotonic() >= deadline:
                raise RuntimeError("SQLite preview deadline exceeded")
        # A later owner may share FK targets with an earlier one. Recheck the
        # final aggregate so success of an intermediate step cannot hide damage.
        for owner in owners:
            if owner.inspect(projected).needs_write:
                raise RuntimeError("SQLite aggregate migration did not converge")
        # Use the candidate's real record readers after every owner has reached
        # its final state. They receive a read-only copy, never source files.
        # This is self-readability only: source-version checks of these same
        # candidate rows must still precede whole-product format admission.
        projected.execute("PRAGMA query_only=ON")
        for owner in owners:
            if owner.read_rows is not None:
                owner.read_rows(projected)
                if time.monotonic() >= deadline:
                    raise RuntimeError("SQLite row read budget exceeded")
        rows = projected.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
        ).fetchall()
        objects = tuple(
            SchemaObject(*row) for row in rows if not row[1].lower().startswith("sqlite_")
        )
        _require_owned_triggers(objects, owners)
        if sum(len(row.sql.encode("utf-8")) for row in objects) > MAX_LAYOUT_BYTES:
            raise RuntimeError("SQLite preview layout exceeds budget")
        preview = DatabasePreview(
            name,
            present,
            digest,
            tuple(owner.name for owner in owners),
            objects,
            rows_digest(projected, deadline=deadline),
            tuple(owner.name for owner in owners if owner.read_rows is not None),
        )
        yield preview, projected, deadline


def observe_recovered_database(
    preview: DatabasePreview,
    connection: sqlite3.Connection,
    owners: Sequence[SchemaOwner],
    *,
    deadline: float,
) -> DatabasePreview:
    """Re-read a private projection after composition runs actual recovery steps.

    The original source digest remains the preimage identity. Recovery may alter
    rows but cannot silently change the owner set or schema. This does not admit
    writes to source files or prove another version can read the resulting rows.
    """
    if connection.in_transaction or tuple(owner.name for owner in owners) != preview.owners:
        raise ValueError("invalid completed recovery projection")
    if time.monotonic() >= deadline:
        raise RuntimeError("SQLite recovery preview budget exceeded")
    connection.execute("PRAGMA query_only=ON")
    objects = tuple(
        SchemaObject(*row)
        for row in connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
        )
        if not row[1].lower().startswith("sqlite_")
    )
    if objects != preview.objects:
        raise ValueError("startup recovery changed SQLite layout")
    for owner in owners:
        if owner.inspect(connection).needs_write:
            raise ValueError("startup recovery invalidated owner schema")
        if owner.read_rows is not None:
            owner.read_rows(connection)
    digest = rows_digest(connection, deadline=deadline)
    return replace(preview, rows_digest=digest)
