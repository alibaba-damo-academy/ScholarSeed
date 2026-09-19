"""Durable PDF reading records keyed by Content-owned asset identity."""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.content import ContentPort
from service.platform.records import RecordOwner, RecordTarget

PDF_RECORD_LINK_TABLE = "workbench_pdf_record_link"

PDF_RECORD_TABLE = "workbench_pdf_record"
PDF_RECORD_COLUMNS = {
    "asset_id",
    "record_revision",
    "source_revision",
    "payload",
    "updated_at",
}


@dataclass(frozen=True)
class PdfRecordRow:
    asset_id: str
    record_revision: str
    source_revision: str
    payload: bytes


class PdfRecordCatalog:
    """Store one canonical record document per logical PDF asset."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    def _database(self, project_id: str) -> str:
        return self._content.resolve(project_id, PROJECT_DB_RELATIVE)

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        columns = {
            str(row[1]) for row in connection.execute(f"PRAGMA table_info({PDF_RECORD_TABLE})")
        }
        if columns and columns != PDF_RECORD_COLUMNS:
            raise RuntimeError("workbench_pdf_record_requires_cutover")
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {PDF_RECORD_TABLE} (
                asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),
                record_revision TEXT NOT NULL,
                source_revision TEXT NOT NULL,
                payload BLOB NOT NULL,
                updated_at REAL NOT NULL
            )""")

    @staticmethod
    def _row(row: sqlite3.Row | None) -> PdfRecordRow | None:
        if row is None:
            return None
        return PdfRecordRow(
            asset_id=str(row["asset_id"]),
            record_revision=str(row["record_revision"]),
            source_revision=str(row["source_revision"]),
            payload=bytes(row["payload"]),
        )

    @staticmethod
    def _link_schema(connection: sqlite3.Connection) -> None:
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {PDF_RECORD_LINK_TABLE} ("
            "asset_id TEXT PRIMARY KEY REFERENCES content_asset(asset_id),"
            "owner TEXT NOT NULL,scope_id TEXT NOT NULL,subject_id TEXT NOT NULL)"
        )

    def linked_target(self, project_id: str, asset_id: str) -> RecordTarget | None:
        with transaction(self._database(project_id)) as connection:
            self._link_schema(connection)
            row = connection.execute(
                f"SELECT owner,scope_id,subject_id FROM {PDF_RECORD_LINK_TABLE} WHERE asset_id=?",
                (asset_id,),
            ).fetchone()
        return (
            RecordTarget(RecordOwner(row["owner"]), row["scope_id"], row["subject_id"])
            if row
            else None
        )

    def link(self, project_id: str, asset_id: str, target: RecordTarget) -> None:
        with transaction(self._database(project_id)) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._link_schema(connection)
            connection.execute(
                f"INSERT OR IGNORE INTO {PDF_RECORD_LINK_TABLE} (asset_id,owner,scope_id,subject_id) VALUES(?,?,?,?)",
                (asset_id, target.owner.value, target.scope_id, target.subject_id),
            )
            row = connection.execute(
                f"SELECT owner,scope_id,subject_id FROM {PDF_RECORD_LINK_TABLE} WHERE asset_id=?",
                (asset_id,),
            ).fetchone()
            if row is None or (row["owner"], row["scope_id"], row["subject_id"]) != (
                target.owner.value,
                target.scope_id,
                target.subject_id,
            ):
                raise ValueError("record_link_conflict")

    def get(self, project_id: str, asset_id: str) -> PdfRecordRow | None:
        database = self._database(project_id)
        with transaction(database) as connection:
            self._schema(connection)
            row = connection.execute(
                f"SELECT * FROM {PDF_RECORD_TABLE} WHERE asset_id = ?", (asset_id,)
            ).fetchone()
        return self._row(row)

    def create(
        self,
        project_id: str,
        asset_id: str,
        record_revision: str,
        source_revision: str,
        payload: bytes,
    ) -> PdfRecordRow:
        database = self._database(project_id)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            connection.execute(
                f"INSERT OR IGNORE INTO {PDF_RECORD_TABLE}"
                " (asset_id, record_revision, source_revision, payload, updated_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (asset_id, record_revision, source_revision, payload, time.time()),
            )
            row = connection.execute(
                f"SELECT * FROM {PDF_RECORD_TABLE} WHERE asset_id = ?", (asset_id,)
            ).fetchone()
        result = self._row(row)
        if result is None:
            raise RuntimeError("pdf record insert did not produce a row")
        return result

    def commit(
        self,
        project_id: str,
        asset_id: str,
        expected_record_revision: str,
        record_revision: str,
        source_revision: str,
        payload: bytes,
    ) -> PdfRecordRow | None:
        database = self._database(project_id)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            cursor = connection.execute(
                f"UPDATE {PDF_RECORD_TABLE} SET record_revision = ?, source_revision = ?,"
                " payload = ?, updated_at = ? WHERE asset_id = ? AND record_revision = ?",
                (
                    record_revision,
                    source_revision,
                    payload,
                    time.time(),
                    asset_id,
                    expected_record_revision,
                ),
            )
            row = (
                connection.execute(
                    f"SELECT * FROM {PDF_RECORD_TABLE} WHERE asset_id = ?", (asset_id,)
                ).fetchone()
                if cursor.rowcount == 1
                else None
            )
        return self._row(row)


__all__ = ["PDF_RECORD_COLUMNS", "PdfRecordCatalog", "PdfRecordRow"]
