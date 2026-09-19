"""Composition-owned startup cutover for the final PDF record ownership schemas."""

from __future__ import annotations

import os
import shutil
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from service.literature.persistence.reading import RECORD_COLUMNS, RECORDS_TABLE
from service.literature.persistence.store import (
    ATTACHMENT_COLUMNS,
    PRIMARY_ATTACHMENT_INDEX,
)
from service.workbench.persistence.records import PDF_RECORD_COLUMNS, PDF_RECORD_TABLE

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


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _needs_literature_cutover(connection: sqlite3.Connection) -> bool:
    tables = _tables(connection)
    item_columns = _columns(connection, ITEM_TABLE)
    attachment_columns = _columns(connection, ATTACHMENT_TABLE)
    record_columns = _columns(connection, ATTACHMENT_RECORD_TABLE)
    return bool(
        set(OBSOLETE_LITERATURE_TABLES) & tables
        or set(OBSOLETE_ITEM_COLUMNS) & item_columns
        or (attachment_columns and attachment_columns != FINAL_ATTACHMENT_COLUMNS)
        or (record_columns and record_columns != FINAL_LITERATURE_RECORD_COLUMNS)
    )


def _needs_project_cutover(connection: sqlite3.Connection) -> bool:
    columns = _columns(connection, PDF_RECORD_TABLE)
    return bool(columns and columns != FINAL_PROJECT_RECORD_COLUMNS)


def _connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=5000")
    return connection


def _backup(target: CutoverTarget, stamp: int) -> Path:
    destination = target.path.with_name(f"{target.path.name}.{BACKUP_LABEL}.{stamp}.bak")
    source = _connect(target.path)
    backup = sqlite3.connect(destination)
    try:
        source.backup(backup)
    finally:
        backup.close()
        source.close()
    return destination


def _restore(target: CutoverTarget, backup_path: Path) -> None:
    source = sqlite3.connect(backup_path)
    destination = _connect(target.path)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()


def _cutover_literature(path: Path) -> None:
    connection = _connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=OFF")
        connection.execute("BEGIN IMMEDIATE")
        for table in (*OBSOLETE_LITERATURE_TABLES, ATTACHMENT_RECORD_TABLE):
            connection.execute(f"DROP TABLE IF EXISTS {table}")
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
        connection.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS {PRIMARY_ATTACHMENT_INDEX} "
            f"ON {ATTACHMENT_TABLE}(literature_id) WHERE role='{PRIMARY_ROLE}'"
        )
        connection.execute(
            f"CREATE TABLE {ATTACHMENT_RECORD_TABLE}("
            f"attachment_id TEXT PRIMARY KEY REFERENCES {ATTACHMENT_TABLE}(id) ON DELETE CASCADE,"
            "record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,"
            "payload BLOB NOT NULL,updated_at REAL NOT NULL)"
        )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _cutover_project(path: Path) -> None:
    connection = _connect(path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(f"DROP TABLE IF EXISTS {PDF_RECORD_TABLE}")
        connection.execute(
            f"CREATE TABLE {PDF_RECORD_TABLE}("
            "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),"
            "record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,"
            "payload BLOB NOT NULL,updated_at REAL NOT NULL)"
        )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def _verify(target: CutoverTarget) -> None:
    connection = _connect(target.path)
    try:
        if target.kind == "literature":
            if _needs_literature_cutover(connection):
                raise PdfRecordCutoverError("literature_cutover_incomplete")
            if _columns(connection, ATTACHMENT_RECORD_TABLE) != FINAL_LITERATURE_RECORD_COLUMNS:
                raise PdfRecordCutoverError("literature_record_schema_invalid")
        elif _needs_project_cutover(connection):
            raise PdfRecordCutoverError("project_record_cutover_incomplete")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise PdfRecordCutoverError("pdf_record_cutover_foreign_key_failure")
    finally:
        connection.close()


def cutover_pdf_records(
    literature_database: Path, project_databases: Iterable[Path]
) -> tuple[Path, ...]:
    """Preflight, back up, cut over, and verify every existing owning database."""

    candidates = [CutoverTarget(literature_database, "literature")]
    candidates.extend(CutoverTarget(path, "project") for path in project_databases)
    targets: list[CutoverTarget] = []
    for target in candidates:
        if not target.path.exists():
            continue
        if not os.access(target.path, os.W_OK):
            raise PdfRecordCutoverError(f"pdf_record_cutover_not_writable:{target.path}")
        connection = _connect(target.path)
        try:
            needed = (
                _needs_literature_cutover(connection)
                if target.kind == "literature"
                else _needs_project_cutover(connection)
            )
        finally:
            connection.close()
        if needed:
            targets.append(target)
    if not targets:
        return ()
    required = sum(target.path.stat().st_size for target in targets)
    if any(shutil.disk_usage(target.path.parent).free < required for target in targets):
        raise PdfRecordCutoverError("pdf_record_cutover_insufficient_space")
    stamp = time.time_ns()
    backups = {target: _backup(target, stamp) for target in targets}
    changed: list[CutoverTarget] = []
    try:
        for target in targets:
            if target.kind == "literature":
                _cutover_literature(target.path)
            else:
                _cutover_project(target.path)
            changed.append(target)
        for target in targets:
            _verify(target)
    except BaseException as error:
        for target in reversed(changed):
            _restore(target, backups[target])
        raise PdfRecordCutoverError("pdf_record_cutover_failed") from error
    return tuple(backups[target] for target in targets)


__all__ = ["PdfRecordCutoverError", "cutover_pdf_records"]
