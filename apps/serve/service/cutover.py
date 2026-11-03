"""Composition-owned startup cutover for the final PDF record ownership schemas."""

from __future__ import annotations

import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from service.literature.persistence.reading import (
    RECORD_COLUMNS,
    RECORDS_TABLE,
    AttachmentRecordCatalog,
)
from service.literature.persistence.store import (
    ATTACHMENT_COLUMNS,
)
from service.literature.persistence.store import DDL as LITERATURE_DDL
from service.literature.persistence.store import (
    PRIMARY_ATTACHMENT_INDEX,
    LiteratureSchema,
    classify_schema,
)
from service.persistence.project import (
    DatabaseMode,
    database_files,
    open_database,
    sql_tokens,
    table_clauses,
)
from service.workbench.persistence.records import (
    PDF_RECORD_COLUMNS,
    PDF_RECORD_LINK_TABLE,
    PDF_RECORD_TABLE,
    PdfRecordCatalog,
)

ITEM_TABLE = "literature_items"
ATTACHMENT_TABLE = "literature_attachments"
ATTACHMENT_RECORD_TABLE = RECORDS_TABLE
OBSOLETE_LITERATURE_TABLES = ("literature_marks", "literature_reading_records")
OBSOLETE_ITEM_COLUMNS = ("pdf_path", "pdf_asset_id")
# 与 store.ATTACHMENT_COLUMNS 同形状: 附件行只有"自己独占的那份文件"与它的修订号,
# 不再有 asset_id / project_id 这两个指向别处的链接维度。
FINAL_ATTACHMENT_COLUMNS = {
    "id",
    "literature_id",
    "name",
    "path",
    "revision",
    "kind",
    "role",
    "media_type",
    "created_at",
}
FINAL_PROJECT_RECORD_COLUMNS = PDF_RECORD_COLUMNS
FINAL_LITERATURE_RECORD_COLUMNS = RECORD_COLUMNS
LEGACY_ATTACHMENT_COLUMNS = {
    "id",
    "literature_id",
    "name",
    "path",
    "asset_id",
    "kind",
    "created_at",
}
LEGACY_PROJECT_RECORD_COLUMNS = {"asset_id", "payload", "revision", "updated_at"}
# Actual owner declaration before 5d838f452; constraints are part of the format.
LEGACY_PROJECT_RECORD_DDL = (
    "CREATE TABLE workbench_pdf_record("
    "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),"
    "revision TEXT NOT NULL,payload BLOB NOT NULL,updated_at REAL NOT NULL)"
)
LEGACY_LITERATURE_RECORD_COLUMNS = {"attachment_id", "payload", "revision"}
LEGACY_OBSOLETE_COLUMNS = {
    "literature_marks": {"id", "attachment_id", "text", "page", "created_at"},
    "literature_reading_records": {"literature_id", "payload"},
}
LEGACY_LITERATURE_DDL = {
    "literature_attachments": "CREATE TABLE literature_attachments(id TEXT PRIMARY KEY,literature_id TEXT NOT NULL REFERENCES literature_items(id) ON DELETE CASCADE,name TEXT NOT NULL,path TEXT NOT NULL DEFAULT '',asset_id TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'file',created_at REAL NOT NULL)",
    "literature_marks": "CREATE TABLE literature_marks(id TEXT PRIMARY KEY,attachment_id TEXT NOT NULL REFERENCES literature_attachments(id) ON DELETE CASCADE,text TEXT NOT NULL,page INTEGER,created_at REAL NOT NULL)",
    "literature_reading_records": "CREATE TABLE literature_reading_records(literature_id TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    "literature_attachment_records": "CREATE TABLE literature_attachment_records(attachment_id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision TEXT NOT NULL)",
}
BACKUP_LABEL = "pre-pdf-record-v1"
PDF_KIND = "pdf"
PDF_MEDIA_TYPE = "application/pdf"
BINARY_MEDIA_TYPE = "application/octet-stream"
PRIMARY_ROLE = "primary"
SUPPLEMENTARY_ROLE = "supplementary"


class PdfRecordCutoverError(RuntimeError):
    """The schema cutover could not reach one coherent final state."""


@dataclass(frozen=True)
class CutoverTarget:
    path: Path
    kind: str


@dataclass(frozen=True)
class LiteratureStartupSchema:
    """Composition snapshot, not permission to admit writers or discard old records."""

    cutover: bool
    library: LiteratureSchema | None
    declarations: tuple[tuple[str, str, str, str | None], ...]

    @property
    def needs_write(self) -> bool:
        return self.cutover or self.library is None or self.library.needs_write


@dataclass(frozen=True)
class ProjectPdfSchema:
    """PDF state from one project database, not whole-project admission."""

    present: bool
    cutover: bool
    declarations: tuple[tuple[str, str, str, str | None], ...]

    @property
    def needs_write(self) -> bool:
        return self.cutover


@dataclass(frozen=True)
class PdfCutoverSchema:
    """One owner's actual cutover decision on a caller-owned connection."""

    needs_write: bool


def inspect_pdf_connection(connection: sqlite3.Connection, kind: str) -> PdfCutoverSchema:
    """Classify the actual PDF declarations without backups or source writes."""
    if kind == "literature":
        return PdfCutoverSchema(_needs_literature_cutover(connection))
    if kind == "project":
        return PdfCutoverSchema(_needs_project_cutover(connection))
    raise ValueError("unknown PDF storage owner")


def inspect_pdf_rows(connection: sqlite3.Connection, kind: str) -> None:
    """Read the post-cutover owner's actual records without attachment IO."""
    if kind == "literature":
        AttachmentRecordCatalog.inspect_rows(connection)
    elif kind == "project":
        PdfRecordCatalog.inspect_rows(connection)
    else:
        raise ValueError("unknown PDF storage owner")


def initialize_pdf_schema(connection: sqlite3.Connection, kind: str) -> None:
    """Apply the same owner cutover to a protected DB or private memory copy.

    The caller owns the transaction. Production also retains its pre-cutover
    backup; migration preview invokes this only on an isolated in-memory copy.
    This performs no attachment-file operations and grants no activation permit.
    """
    if not connection.in_transaction or connection.execute("PRAGMA foreign_keys").fetchone()[0]:
        raise PdfRecordCutoverError("PDF cutover requires a schema transaction")
    if not inspect_pdf_connection(connection, kind).needs_write:
        return
    if kind == "literature":
        _cutover_literature(connection)
    else:
        _cutover_project(connection)
    _verify(connection, kind)


def _declarations(connection: sqlite3.Connection) -> tuple[tuple[str, str, str, str | None], ...]:
    return tuple(
        tuple(row)
        for row in connection.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"
        )
    )


def inspect_project_pdf(database: Path) -> ProjectPdfSchema:
    """Read after Content resolves the path and the caller qualifies its directory.

    Missing databases are not created. This snapshot only describes PDF cutover;
    other project owners must still be inspected before any writer admission.
    """
    with database_files(database) as present:
        if not present:
            return ProjectPdfSchema(False, False, ())
        with closing(_connect(database, readonly=True)) as connection:
            connection.execute("BEGIN")
            needed = inspect_pdf_connection(connection, "project").needs_write
            return ProjectPdfSchema(True, needed, _declarations(connection))


def inspect_literature_startup(database: Path) -> LiteratureStartupSchema:
    """Keep PDF ownership and final library decisions in one qualified WAL snapshot.

    Legacy PDF detection is not full constraint validation. Such a snapshot can
    request maintenance, but cannot grant normal admission. The caller must
    re-read after cutover and initialization, with its directory locks retained.
    """
    with database_files(database) as present:
        with closing(
            _connect(database, readonly=True) if present else sqlite3.connect(":memory:")
        ) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("BEGIN")
            needed = inspect_pdf_connection(connection, "literature").needs_write
            return LiteratureStartupSchema(
                needed, None if needed else classify_schema(connection), _declarations(connection)
            )


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    rows = connection.execute(f"PRAGMA table_xinfo({table})").fetchall()
    if any(row[6] for row in rows):
        raise PdfRecordCutoverError(f"pdf_record_cutover_unknown_columns:{table}")
    return {str(row[1]) for row in rows}


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0]).casefold()
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _known_columns(table: str, columns: set[str], *known: set[str]) -> None:
    if columns and columns not in known:
        raise PdfRecordCutoverError(f"pdf_record_cutover_unknown_schema:{table}")


def _needs_literature_cutover(connection: sqlite3.Connection) -> bool:
    tables = _tables(connection)
    item_columns = _columns(connection, ITEM_TABLE)
    attachment_columns = _columns(connection, ATTACHMENT_TABLE)
    record_columns = _columns(connection, ATTACHMENT_RECORD_TABLE)
    _known_columns(
        ATTACHMENT_TABLE, attachment_columns, LEGACY_ATTACHMENT_COLUMNS, FINAL_ATTACHMENT_COLUMNS
    )
    _known_columns(
        ATTACHMENT_RECORD_TABLE,
        record_columns,
        LEGACY_LITERATURE_RECORD_COLUMNS,
        FINAL_LITERATURE_RECORD_COLUMNS,
    )
    for table, columns in LEGACY_OBSOLETE_COLUMNS.items():
        _known_columns(table, _columns(connection, table), columns)
    with closing(sqlite3.connect(":memory:")) as reference:
        for statement in LITERATURE_DDL:
            reference.execute(statement)
        AttachmentRecordCatalog._schema(reference)
        _create_primary_attachment_index(reference)
        expected_index = reference.execute(
            "SELECT sql FROM sqlite_master WHERE name=?", (PRIMARY_ATTACHMENT_INDEX,)
        ).fetchone()[0]
        current_index = connection.execute(
            "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=? COLLATE NOCASE",
            (PRIMARY_ATTACHMENT_INDEX,),
        ).fetchone()
        if current_index is not None and (
            current_index[0] != "index"
            or current_index[1].casefold() != ATTACHMENT_TABLE
            or sql_tokens(current_index[2] or "") != sql_tokens(expected_index)
        ):
            raise PdfRecordCutoverError("pdf_record_cutover_unknown_attachment_index")
        for column in OBSOLETE_ITEM_COLUMNS:
            if column in item_columns:
                reference.execute(
                    f"ALTER TABLE {ITEM_TABLE} ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                )
        for table, legacy in (
            (ITEM_TABLE, False),
            (ATTACHMENT_TABLE, attachment_columns == LEGACY_ATTACHMENT_COLUMNS),
            (ATTACHMENT_RECORD_TABLE, record_columns == LEGACY_LITERATURE_RECORD_COLUMNS),
            *((table, True) for table in OBSOLETE_LITERATURE_TABLES),
        ):
            expected = (
                LEGACY_LITERATURE_DDL[table]
                if legacy
                else reference.execute(
                    "SELECT sql FROM sqlite_master WHERE name=?", (table,)
                ).fetchone()[0]
            )
            _require_table_declaration(connection, table, expected)
    discarded = set[str](OBSOLETE_LITERATURE_TABLES) & tables
    if record_columns == LEGACY_LITERATURE_RECORD_COLUMNS:
        discarded.add(ATTACHMENT_RECORD_TABLE)
    if attachment_columns == LEGACY_ATTACHMENT_COLUMNS:
        discarded.add(ATTACHMENT_TABLE)
    if connection.execute(
        "SELECT 1 FROM sqlite_master WHERE name=?", (ATTACHMENT_TABLE + "_cutover",)
    ).fetchone():
        raise PdfRecordCutoverError("pdf_record_cutover_staging_exists")
    _require_no_dependencies(connection, discarded)
    return bool(
        set(OBSOLETE_LITERATURE_TABLES) & tables
        or set(OBSOLETE_ITEM_COLUMNS) & item_columns
        or (attachment_columns and attachment_columns != FINAL_ATTACHMENT_COLUMNS)
        or (record_columns and record_columns != FINAL_LITERATURE_RECORD_COLUMNS)
    )


def _require_table_declaration(connection: sqlite3.Connection, table: str, expected: str) -> None:
    current = connection.execute(
        "SELECT type,sql FROM sqlite_master WHERE name=? COLLATE NOCASE", (table,)
    ).fetchone()
    if current is None:
        return
    if current[0] != "table":
        raise PdfRecordCutoverError(f"pdf_record_cutover_unknown_object:{table}")
    try:
        actual_clauses = table_clauses(current[1], table)
        expected_clauses = table_clauses(expected, table)
    except ValueError as error:
        raise PdfRecordCutoverError(f"pdf_record_cutover_unknown_declaration:{table}") from error
    if len(actual_clauses) != len(expected_clauses) or set(actual_clauses) != set(expected_clauses):
        raise PdfRecordCutoverError(f"pdf_record_cutover_unknown_declaration:{table}")


def _needs_project_cutover(connection: sqlite3.Connection) -> bool:
    with closing(sqlite3.connect(":memory:")) as reference:
        PdfRecordCatalog._link_schema(reference)
        expected = reference.execute(
            "SELECT sql FROM sqlite_master WHERE name=?", (PDF_RECORD_LINK_TABLE,)
        ).fetchone()[0]
    _require_table_declaration(connection, PDF_RECORD_LINK_TABLE, expected)
    columns = _columns(connection, PDF_RECORD_TABLE)
    _known_columns(
        PDF_RECORD_TABLE, columns, LEGACY_PROJECT_RECORD_COLUMNS, FINAL_PROJECT_RECORD_COLUMNS
    )
    current = connection.execute(
        "SELECT type,sql FROM sqlite_master WHERE name=? COLLATE NOCASE", (PDF_RECORD_TABLE,)
    ).fetchone()
    if current is None:
        return False
    if current[0] != "table":
        raise PdfRecordCutoverError("pdf_record_cutover_unknown_object")
    legacy = columns == LEGACY_PROJECT_RECORD_COLUMNS
    with closing(sqlite3.connect(":memory:")) as reference:
        if legacy:
            reference.execute(LEGACY_PROJECT_RECORD_DDL)
        else:
            PdfRecordCatalog._schema(reference)
        expected = reference.execute(
            "SELECT sql FROM sqlite_master WHERE name=?", (PDF_RECORD_TABLE,)
        ).fetchone()[0]
    _require_table_declaration(connection, PDF_RECORD_TABLE, expected)
    if legacy:
        _require_no_dependencies(connection, {PDF_RECORD_TABLE})
    return legacy


def _require_no_dependencies(connection: sqlite3.Connection, discarded: set[str]) -> None:
    """Only known tables discarded together may depend on the old owner objects."""
    if not discarded:
        return
    for kind, name, owner, sql in connection.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_master"
    ):
        if kind in {"index", "trigger"} and owner.casefold() in discarded and sql is not None:
            raise PdfRecordCutoverError("pdf_record_cutover_has_dependencies")
        if kind in {"view", "trigger"} and sql and discarded.intersection(sql_tokens(sql)):
            raise PdfRecordCutoverError("pdf_record_cutover_has_dependencies")
        if kind == "table" and name.casefold() not in discarded:
            quoted = '"' + name.replace('"', '""') + '"'
            if any(
                str(row[2]).casefold() in discarded
                for row in connection.execute(f"PRAGMA foreign_key_list({quoted})")
            ):
                raise PdfRecordCutoverError("pdf_record_cutover_has_dependencies")


def _connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    mode = DatabaseMode.READ_ONLY if readonly else DatabaseMode.EXISTING
    connection = open_database(path.resolve(), mode=mode, timeout=5)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        return connection
    except BaseException:
        connection.close()
        raise


def _backup(target: CutoverTarget) -> Path:
    # The caller holds BEGIN IMMEDIATE on another connection. A separate reader
    # sees the committed pre-cutover snapshot without backing up a write transaction.
    descriptor, name = tempfile.mkstemp(
        prefix=f"{target.path.name}.{BACKUP_LABEL}.", suffix=".bak", dir=target.path.parent
    )
    os.close(descriptor)
    destination = Path(name)
    source = open_database(target.path.resolve(), mode=DatabaseMode.READ_ONLY)
    try:
        backup = open_database(destination)
        try:
            source.backup(backup)
        finally:
            backup.close()
    finally:
        source.close()
    return destination


def _cutover_literature(connection: sqlite3.Connection) -> None:
    for table in OBSOLETE_LITERATURE_TABLES:
        connection.execute(f"DROP TABLE IF EXISTS {table}")
    if _columns(connection, ATTACHMENT_RECORD_TABLE) == LEGACY_LITERATURE_RECORD_COLUMNS:
        connection.execute(f"DROP TABLE {ATTACHMENT_RECORD_TABLE}")
    for column in OBSOLETE_ITEM_COLUMNS:
        if column in _columns(connection, ITEM_TABLE):
            connection.execute(f"ALTER TABLE {ITEM_TABLE} DROP COLUMN {column}")
    attachment_columns = _columns(connection, ATTACHMENT_TABLE)
    if attachment_columns and attachment_columns != FINAL_ATTACHMENT_COLUMNS:
        source_table = f"{ATTACHMENT_TABLE}_cutover"
        connection.execute(f"ALTER TABLE {ATTACHMENT_TABLE} RENAME TO {source_table}")
        connection.execute(f"CREATE TABLE {ATTACHMENT_TABLE}{ATTACHMENT_COLUMNS}")
        # 遗留行没有 revision 可继承 (那时修订号靠内容寻址的文件名反推), 只能留空:
        # 这样的行删除时清不掉它派生的全文索引, 属于一次性迁移的已知代价。
        connection.execute(
            f"INSERT INTO {ATTACHMENT_TABLE}"
            "(id,literature_id,name,path,revision,kind,role,media_type,created_at) "
            f"SELECT source.id,source.literature_id,source.name,source.path,'',"
            "source.kind,CASE WHEN source.id=(SELECT candidate.id "
            f"FROM {source_table} candidate WHERE candidate.literature_id=source.literature_id "
            "ORDER BY CASE WHEN lower(candidate.kind)=? OR lower(candidate.path) LIKE ? "
            "THEN 0 ELSE 1 END,candidate.created_at,candidate.id LIMIT 1) THEN ? ELSE ? END,"
            "CASE WHEN lower(source.kind)=? OR lower(source.path) LIKE ? THEN ? ELSE ? END,"
            f"source.created_at FROM {source_table} source",
            (
                PDF_KIND,
                "%.pdf",
                PRIMARY_ROLE,
                SUPPLEMENTARY_ROLE,
                PDF_KIND,
                "%.pdf",
                PDF_MEDIA_TYPE,
                BINARY_MEDIA_TYPE,
            ),
        )
        connection.execute(f"DROP TABLE {source_table}")
    elif not attachment_columns:
        connection.execute(f"CREATE TABLE {ATTACHMENT_TABLE}{ATTACHMENT_COLUMNS}")
    _create_primary_attachment_index(connection)
    connection.execute(
        f"CREATE TABLE IF NOT EXISTS {ATTACHMENT_RECORD_TABLE}("
        f"attachment_id TEXT PRIMARY KEY REFERENCES {ATTACHMENT_TABLE}(id) ON DELETE CASCADE,"
        "record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,"
        "payload BLOB NOT NULL,updated_at REAL NOT NULL)"
    )


def _create_primary_attachment_index(connection: sqlite3.Connection) -> None:
    connection.execute(
        f"CREATE UNIQUE INDEX IF NOT EXISTS {PRIMARY_ATTACHMENT_INDEX} "
        f"ON {ATTACHMENT_TABLE}(literature_id) WHERE role='{PRIMARY_ROLE}'"
    )


def _cutover_project(connection: sqlite3.Connection) -> None:
    connection.execute(f"DROP TABLE IF EXISTS {PDF_RECORD_TABLE}")
    connection.execute(
        f"CREATE TABLE {PDF_RECORD_TABLE}("
        "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),"
        "record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,"
        "payload BLOB NOT NULL,updated_at REAL NOT NULL)"
    )


def _verify(connection: sqlite3.Connection, kind: str) -> None:
    if kind == "literature":
        if _needs_literature_cutover(connection):
            raise PdfRecordCutoverError("literature_cutover_incomplete")
        if _columns(connection, ATTACHMENT_RECORD_TABLE) != FINAL_LITERATURE_RECORD_COLUMNS:
            raise PdfRecordCutoverError("literature_record_schema_invalid")
    elif _needs_project_cutover(connection):
        raise PdfRecordCutoverError("project_record_cutover_incomplete")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise PdfRecordCutoverError("pdf_record_cutover_foreign_key_failure")


def inspect_pdf_records(
    literature_database: Path, project_databases: Iterable[Path]
) -> tuple[CutoverTarget, ...]:
    """Classify existing PDF schemas without migration or backup creation.

    Each owner is read in one WAL-consistent transaction. SQLite may touch SHM;
    startup must qualify the bearing directories before calling this inspector.
    A result describes PDF migration needs only, not global format admission.
    """

    candidates = [CutoverTarget(literature_database, "literature")]
    candidates.extend(CutoverTarget(path, "project") for path in project_databases)
    targets: list[CutoverTarget] = []
    for target in candidates:
        if target.kind == "project":
            if inspect_project_pdf(target.path).cutover:
                targets.append(target)
            continue
        with database_files(target.path) as present:
            if not present:
                continue
            with closing(_connect(target.path, readonly=True)) as connection:
                connection.execute("BEGIN")
                needed = inspect_pdf_connection(connection, "literature").needs_write
        if needed:
            targets.append(target)
    return tuple(targets)


def cutover_pdf_records(
    literature_database: Path, project_databases: Iterable[Path]
) -> tuple[Path, ...]:
    """Inspect, back up, cut over, and verify every existing owning database."""
    return _cutover_targets(inspect_pdf_records(literature_database, project_databases))


def cutover_project_pdf_records(project_databases: Iterable[Path]) -> tuple[Path, ...]:
    """Migrate only project-owned records; application storage has its own boundary."""
    return _cutover_targets(
        tuple(
            CutoverTarget(path, "project")
            for path in project_databases
            if inspect_project_pdf(path).cutover
        )
    )


def _cutover_targets(targets: tuple[CutoverTarget, ...]) -> tuple[Path, ...]:
    if not targets:
        return ()
    for target in targets:
        if not os.access(target.path, os.W_OK):
            raise PdfRecordCutoverError(f"pdf_record_cutover_not_writable:{target.path}")
    required = sum(target.path.stat().st_size for target in targets)
    if any(shutil.disk_usage(target.path.parent).free < required for target in targets):
        raise PdfRecordCutoverError("pdf_record_cutover_insufficient_space")
    backups: list[Path] = []
    for target in targets:
        connection = _connect(target.path)
        try:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute("BEGIN IMMEDIATE")
            # Another starter may have completed this target while we waited.
            needed = inspect_pdf_connection(connection, target.kind).needs_write
            if needed:
                backups.append(_backup(target))
                initialize_pdf_schema(connection, target.kind)
            connection.commit()
        except BaseException as error:
            connection.rollback()
            # Earlier databases are already committed and may have new user writes.
            # Never restore their backups; a later startup resumes from actual schema.
            raise PdfRecordCutoverError("pdf_record_cutover_failed") from error
        finally:
            connection.close()
    return tuple(backups)


__all__ = [
    "CutoverTarget",
    "LiteratureStartupSchema",
    "ProjectPdfSchema",
    "PdfCutoverSchema",
    "PdfRecordCutoverError",
    "inspect_literature_startup",
    "inspect_project_pdf",
    "inspect_pdf_records",
    "inspect_pdf_connection",
    "inspect_pdf_rows",
    "initialize_pdf_schema",
    "cutover_pdf_records",
    "cutover_project_pdf_records",
]
