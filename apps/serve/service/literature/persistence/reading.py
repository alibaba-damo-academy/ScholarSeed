"""Canonical PDF records owned by literature attachments."""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from service.literature.persistence.store import connect
from service.platform.records import (
    EMPTY_RECORDS,
    PdfRecordSnapshot,
    RecordOwner,
    RecordTarget,
    decode_records,
    encode_records,
    project_anchors,
    record_revision,
)

RECORDS_TABLE = "literature_attachment_records"
RECORD_COLUMNS = {
    "attachment_id",
    "record_revision",
    "source_revision",
    "payload",
    "updated_at",
}


class AttachmentRecordConflict(ValueError):
    pass


class AttachmentOwnerMismatch(ValueError):
    pass


@dataclass(frozen=True)
class AttachmentRecordRow:
    attachment_id: str
    record_revision: str
    source_revision: str
    payload: bytes


class AttachmentRecordCatalog:
    def __init__(self, database: Path) -> None:
        self.database = database

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({RECORDS_TABLE})")}
        if columns and columns != RECORD_COLUMNS:
            raise RuntimeError("literature_attachment_records_requires_cutover")
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {RECORDS_TABLE}("
            "attachment_id TEXT PRIMARY KEY REFERENCES literature_attachments(id) "
            "ON DELETE CASCADE,record_revision TEXT NOT NULL,source_revision TEXT NOT NULL,"
            "payload BLOB NOT NULL,updated_at REAL NOT NULL)"
        )

    @staticmethod
    def _owner(connection: sqlite3.Connection, target: RecordTarget) -> None:
        if target.owner is not RecordOwner.LITERATURE_ATTACHMENT:
            raise AttachmentOwnerMismatch
        row = connection.execute(
            "SELECT literature_id FROM literature_attachments WHERE id=?",
            (target.subject_id,),
        ).fetchone()
        if row is None or str(row["literature_id"]) != target.scope_id:
            raise AttachmentOwnerMismatch

    @staticmethod
    def _row(row: sqlite3.Row) -> AttachmentRecordRow:
        return AttachmentRecordRow(
            attachment_id=str(row["attachment_id"]),
            record_revision=str(row["record_revision"]),
            source_revision=str(row["source_revision"]),
            payload=bytes(row["payload"]),
        )

    @staticmethod
    def _snapshot(
        target: RecordTarget,
        current_source_revision: str,
        row: AttachmentRecordRow,
    ) -> PdfRecordSnapshot:
        records = decode_records(row.payload)
        if row.record_revision != record_revision(row.source_revision, records):
            raise ValueError("invalid attachment records")
        return PdfRecordSnapshot(
            record_target=target,
            record_revision=row.record_revision,
            source_revision=current_source_revision,
            source_state="available",
            records=project_anchors(records, row.source_revision != current_source_revision),
        )

    def snapshot(
        self,
        target: RecordTarget,
        source_revision: str,
        initial_records: dict[str, Any] | None = None,
    ) -> PdfRecordSnapshot:
        initial = EMPTY_RECORDS if initial_records is None else initial_records
        payload = encode_records(initial)
        initial_revision = record_revision(source_revision, initial)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            self._owner(connection, target)
            connection.execute(
                f"INSERT OR IGNORE INTO {RECORDS_TABLE}"
                "(attachment_id,record_revision,source_revision,payload,updated_at) "
                "VALUES(?,?,?,?,?)",
                (target.subject_id, initial_revision, source_revision, payload, time.time()),
            )
            row = connection.execute(
                f"SELECT * FROM {RECORDS_TABLE} WHERE attachment_id=?",
                (target.subject_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("attachment record insert did not produce a row")
        return self._snapshot(target, source_revision, self._row(row))

    def commit(
        self,
        target: RecordTarget,
        source_revision: str,
        records: dict[str, Any],
        expected_record_revision: str,
    ) -> PdfRecordSnapshot:
        normalized = decode_records(records)
        payload = encode_records(normalized)
        revision = record_revision(source_revision, normalized)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            self._owner(connection, target)
            cursor = connection.execute(
                f"UPDATE {RECORDS_TABLE} SET record_revision=?,source_revision=?,payload=?,"
                "updated_at=? WHERE attachment_id=? AND record_revision=?",
                (
                    revision,
                    source_revision,
                    payload,
                    time.time(),
                    target.subject_id,
                    expected_record_revision,
                ),
            )
            if cursor.rowcount != 1:
                raise AttachmentRecordConflict
            row = connection.execute(
                f"SELECT * FROM {RECORDS_TABLE} WHERE attachment_id=?",
                (target.subject_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("attachment record update lost its row")
        return self._snapshot(target, source_revision, self._row(row))

    def exists(self, attachment_id: str) -> bool:
        with connect(self.database) as connection:
            self._schema(connection)
            return (
                connection.execute(
                    f"SELECT 1 FROM {RECORDS_TABLE} WHERE attachment_id=?", (attachment_id,)
                ).fetchone()
                is not None
            )

    def annotation_counts(self, literature_id: str) -> dict[str, int]:
        with connect(self.database) as connection:
            self._schema(connection)
            rows = connection.execute(
                f"SELECT a.id,r.payload FROM literature_attachments a LEFT JOIN {RECORDS_TABLE} r "
                "ON r.attachment_id=a.id WHERE a.literature_id=?",
                (literature_id,),
            ).fetchall()
        return {
            str(row["id"]): (
                len(decode_records(bytes(row["payload"]))["marks"])
                if row["payload"] is not None
                else 0
            )
            for row in rows
        }


__all__ = [
    "AttachmentOwnerMismatch",
    "AttachmentRecordCatalog",
    "AttachmentRecordConflict",
]
