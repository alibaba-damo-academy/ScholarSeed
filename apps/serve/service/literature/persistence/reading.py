"""Canonical PDF records owned by literature attachments."""

from __future__ import annotations

import sqlite3
import time
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from service.literature.persistence.store import chunk_ids, connect
from service.platform.notifications import Change, ChangeHub, ChangeTopic
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

    def records(self) -> dict[str, Any]:
        records = decode_records(self.payload)
        if self.record_revision != record_revision(self.source_revision, records):
            raise ValueError("invalid attachment records")
        return records


class AttachmentRecordCatalog:
    def __init__(self, database: Path, *, changes: ChangeHub | None = None) -> None:
        self.database = database
        self._changes = changes

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
        records = row.records()
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
        with closing(connect(self.database)) as connection, connection:
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
        with closing(connect(self.database)) as connection, connection:
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
        if self._changes is not None:
            self._changes.publish((Change(ChangeTopic.RECORDS, subject=target.subject_id),))
        return self._snapshot(target, source_revision, self._row(row))

    def exists(self, attachment_id: str) -> bool:
        with closing(connect(self.database)) as connection, connection:
            self._schema(connection)
            return (
                connection.execute(
                    f"SELECT 1 FROM {RECORDS_TABLE} WHERE attachment_id=?", (attachment_id,)
                ).fetchone()
                is not None
            )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Read actual record codecs without creating records or opening PDFs."""
        if (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (RECORDS_TABLE,)
            ).fetchone()
            is None
        ):
            return
        for row in connection.execute(f"SELECT * FROM {RECORDS_TABLE}"):
            cls._row(row).records()

    def annotation_counts(self, literature_id: str) -> dict[str, int]:
        return self.annotation_counts_for((literature_id,)).get(literature_id, {})

    def annotation_counts_for(self, literature_ids: tuple[str, ...]) -> dict[str, dict[str, int]]:
        """整页取回 `{literature_id: {attachment_id: 批注数}}`。

        列表投影按页取数: 逐条调用会每条各开一个连接、各重跑一次 `_schema()` 的 PRAGMA 与
        建表检查, 50 行就是 50 次。这里把粒度对齐到「一页」, 单条路径也复用同一条查询。
        """

        ids = tuple(dict.fromkeys(str(value) for value in literature_ids))
        if not ids:
            return {}
        counts: dict[str, dict[str, int]] = {key: {} for key in ids}
        with closing(connect(self.database)) as connection, connection:
            self._schema(connection)
            for chunk in chunk_ids(ids):
                placeholders = ",".join("?" for _ in chunk)
                rows = connection.execute(
                    "SELECT a.literature_id,a.id,r.payload FROM literature_attachments a "
                    f"LEFT JOIN {RECORDS_TABLE} r ON r.attachment_id=a.id "
                    f"WHERE a.literature_id IN ({placeholders})",
                    chunk,
                ).fetchall()
                for row in rows:
                    counts[str(row["literature_id"])][str(row["id"])] = (
                        len(decode_records(bytes(row["payload"]))["marks"])
                        if row["payload"] is not None
                        else 0
                    )
        return counts


__all__ = [
    "AttachmentOwnerMismatch",
    "AttachmentRecordCatalog",
    "AttachmentRecordConflict",
]
