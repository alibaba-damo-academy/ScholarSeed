"""Atomic literature admission and durable replay of one downloaded paper."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing
from dataclasses import asdict, dataclass
from datetime import timedelta
from hashlib import sha256

from service.literature.domain.delivery import DELIVERY_COLLECTION_INVALID
from service.literature.persistence.files import (
    LiteratureFileBatch,
    delete_attachments,
    managed_object,
    payload_revision,
    read_attachment,
)
from service.literature.persistence.store import LiteratureRepository, connect
from service.literature.schema import PDF_MEDIA_TYPE, AttachmentRole, LiteratureItem
from service.paths import SERVICE_LITERATURE_FILES_DIR

LOGGER = logging.getLogger(__name__)
DOWNLOAD_ADMISSION_SCOPE_FIELDS = ("session_id", "run", "project_id")
DOWNLOAD_SCOPE_COLUMN = "TEXT NOT NULL DEFAULT ''"
DOWNLOAD_ADMISSION_TABLE = "literature_download_admission"
DOWNLOAD_ADMISSION_CONFLICT = "download_admission_conflict"
DOWNLOAD_ADMISSION_UNAVAILABLE = "download_admission_unavailable"
DOWNLOAD_RESULT_TABLE = "literature_download_result"
DOWNLOAD_RECEIPT_INVALID = "download_receipt_invalid"
DOWNLOAD_RESULT_RETENTION_SECONDS = timedelta(days=1).total_seconds()
DOWNLOAD_RESULT_DDL = f"""
CREATE TABLE IF NOT EXISTS {DOWNLOAD_RESULT_TABLE} (
    receipt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    run TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
)
"""
PDF_SUFFIX = ".pdf"
PDF_KIND = "pdf"
DOWNLOAD_ADMISSION_DDL = f"""
CREATE TABLE IF NOT EXISTS {DOWNLOAD_ADMISSION_TABLE} (
    operation_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    paper_id TEXT NOT NULL,
    literature_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    title TEXT NOT NULL,
    revision TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    run TEXT NOT NULL DEFAULT '',
    project_id TEXT NOT NULL DEFAULT ''
)
"""


@dataclass(frozen=True)
class DownloadReceipt:
    paper_id: str
    literature_id: str
    attachment_id: str
    title: str
    revision: str
    operation_id: str = ""

    def payload(self) -> dict[str, str]:
        return asdict(self)


def _prepare_results(connection: sqlite3.Connection, now: float) -> None:
    connection.execute("BEGIN IMMEDIATE")
    connection.execute(DOWNLOAD_RESULT_DDL)
    columns = {
        row["name"] for row in connection.execute(f"PRAGMA table_info({DOWNLOAD_RESULT_TABLE})")
    }
    if "created_at" not in columns:
        connection.execute(
            f"ALTER TABLE {DOWNLOAD_RESULT_TABLE} ADD COLUMN created_at REAL NOT NULL DEFAULT 0"
        )
    connection.execute(
        f"UPDATE {DOWNLOAD_RESULT_TABLE} SET created_at=? WHERE created_at=0", (now,)
    )
    connection.execute(
        f"DELETE FROM {DOWNLOAD_RESULT_TABLE} WHERE created_at<=?",
        (now - DOWNLOAD_RESULT_RETENTION_SECONDS,),
    )


def prune_download_results(project_id: str | None = None) -> None:
    with closing(connect(LiteratureRepository().database)) as connection, connection:
        if (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (DOWNLOAD_RESULT_TABLE,),
            ).fetchone()
            is None
        ):
            return
        _prepare_results(connection, time.time())
        if project_id is not None:
            connection.execute(
                f"DELETE FROM {DOWNLOAD_RESULT_TABLE} WHERE project_id=?", (project_id,)
            )


def save_download_result(result: dict) -> str:
    payload = json.dumps(result, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    receipt_id = sha256(payload.encode()).hexdigest()
    with closing(connect(LiteratureRepository().database)) as connection, connection:
        now = time.time()
        _prepare_results(connection, now)
        connection.execute(
            f"INSERT OR IGNORE INTO {DOWNLOAD_RESULT_TABLE} (receipt_id,session_id,project_id,run,payload,created_at) VALUES(?,?,?,?,?,?)",
            (receipt_id, result["session_id"], result["project_id"], result["run"], payload, now),
        )
    return receipt_id


def load_download_result(receipt_id: str, session_id: str, project_id: str, run: str) -> dict:
    with closing(connect(LiteratureRepository().database)) as connection, connection:
        if (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                (DOWNLOAD_RESULT_TABLE,),
            ).fetchone()
            is None
        ):
            raise ValueError(DOWNLOAD_RECEIPT_INVALID)
        _prepare_results(connection, time.time())
        row = connection.execute(
            f"SELECT payload FROM {DOWNLOAD_RESULT_TABLE} "
            "WHERE receipt_id=? AND session_id=? AND project_id=? AND run=?",
            (receipt_id, session_id, project_id, run),
        ).fetchone()
    if row is None:
        raise ValueError(DOWNLOAD_RECEIPT_INVALID)
    return json.loads(row["payload"])


def _prepare_admissions(connection: sqlite3.Connection) -> None:
    connection.execute(DOWNLOAD_ADMISSION_DDL)
    columns = {
        row["name"] for row in connection.execute(f"PRAGMA table_info({DOWNLOAD_ADMISSION_TABLE})")
    }
    for field in DOWNLOAD_ADMISSION_SCOPE_FIELDS:
        if field not in columns:
            connection.execute(
                f"ALTER TABLE {DOWNLOAD_ADMISSION_TABLE} ADD COLUMN {field} {DOWNLOAD_SCOPE_COLUMN}"
            )


def _download_receipt(row: sqlite3.Row) -> DownloadReceipt:
    return DownloadReceipt(**{field: row[field] for field in DownloadReceipt.__dataclass_fields__})


def _receipt_available(connection: sqlite3.Connection, receipt: DownloadReceipt) -> bool:
    attachment = connection.execute(
        "SELECT a.path,a.revision FROM literature_attachments a "
        "JOIN literature_items i ON i.id=a.literature_id "
        "WHERE a.id=? AND a.literature_id=? AND a.media_type=?",
        (
            receipt.attachment_id,
            receipt.literature_id,
            PDF_MEDIA_TYPE,
        ),
    ).fetchone()
    if attachment is None or attachment["revision"] != receipt.revision:
        return False
    try:
        return payload_revision(read_attachment(attachment["path"])) == receipt.revision
    except (OSError, ValueError):
        return False


def read_download_receipt(operation_id: str, session_id: str) -> DownloadReceipt | None:
    if not operation_id or not session_id:
        return None
    with closing(connect(LiteratureRepository().database)) as connection:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({DOWNLOAD_ADMISSION_TABLE})")
        }
        if not set(DOWNLOAD_ADMISSION_SCOPE_FIELDS).issubset(columns):
            return None
        row = connection.execute(
            f"SELECT * FROM {DOWNLOAD_ADMISSION_TABLE} WHERE operation_id=? AND session_id=?",
            (operation_id, session_id),
        ).fetchone()
        if row is None:
            return None
        receipt = _download_receipt(row)
        return receipt if _receipt_available(connection, receipt) else None


def read_download_receipts(
    session_id: str, run: str, project_id: str
) -> tuple[DownloadReceipt, ...]:
    if not session_id or not run:
        raise ValueError(DOWNLOAD_RECEIPT_INVALID)
    with closing(connect(LiteratureRepository().database)) as connection:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({DOWNLOAD_ADMISSION_TABLE})")
        }
        if not set(DOWNLOAD_ADMISSION_SCOPE_FIELDS).issubset(columns):
            return ()
        rows = connection.execute(
            f"SELECT * FROM {DOWNLOAD_ADMISSION_TABLE} "
            "WHERE session_id=? AND run=? AND project_id=? ORDER BY rowid",
            (session_id, run, project_id),
        ).fetchall()
        return tuple(_download_receipt(row) for row in rows)


def download_literature_ids(
    session_id: str, run: str, project_id: str, excluded_papers: tuple[str, ...] = ()
) -> tuple[str, ...]:
    if not session_id or not run:
        raise ValueError(DOWNLOAD_RECEIPT_INVALID)
    with closing(connect(LiteratureRepository().database)) as connection:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({DOWNLOAD_ADMISSION_TABLE})")
        }
        if not set(DOWNLOAD_ADMISSION_SCOPE_FIELDS).issubset(columns):
            return ()
        rows = connection.execute(
            f"SELECT paper_id, literature_id FROM {DOWNLOAD_ADMISSION_TABLE} "
            "WHERE session_id=? AND run=? AND project_id=?",
            (session_id, run, project_id),
        ).fetchall()
        excluded_ids = {row["literature_id"] for row in rows if row["paper_id"] in excluded_papers}
        return tuple(
            dict.fromkeys(
                row["literature_id"] for row in rows if row["literature_id"] not in excluded_ids
            )
        )


def _validate_collection(
    connection: sqlite3.Connection, collection_id: str, project_id: str
) -> None:
    if (
        collection_id
        and not connection.execute(
            "SELECT 1 FROM literature_collections WHERE id=? AND project_id IS ?",
            (collection_id, project_id or None),
        ).fetchone()
    ):
        raise ValueError(DELIVERY_COLLECTION_INVALID)


def _link_download(
    connection: sqlite3.Connection,
    literature_id: str,
    project_id: str,
    collection_id: str,
) -> None:
    if project_id:
        connection.execute(
            "INSERT OR IGNORE INTO literature_projects(project_id,literature_id,created_at) "
            "VALUES(?,?,?)",
            (project_id, literature_id, time.time()),
        )
    if collection_id:
        connection.execute(
            "INSERT OR IGNORE INTO literature_collection_items(collection_id,literature_id) "
            "VALUES(?,?)",
            (collection_id, literature_id),
        )


def _save_admission(
    connection: sqlite3.Connection,
    receipt: DownloadReceipt,
    fingerprint: str,
    session_id: str,
    run: str,
    project_id: str,
) -> None:
    connection.execute(
        f"INSERT INTO {DOWNLOAD_ADMISSION_TABLE} "
        "(operation_id,fingerprint,paper_id,literature_id,attachment_id,title,revision,"
        "session_id,run,project_id) VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(operation_id) DO UPDATE SET "
        "fingerprint=excluded.fingerprint,paper_id=excluded.paper_id,"
        "literature_id=excluded.literature_id,attachment_id=excluded.attachment_id,"
        "title=excluded.title,revision=excluded.revision,"
        "session_id=CASE WHEN excluded.session_id='' THEN session_id ELSE excluded.session_id END,"
        "run=CASE WHEN excluded.run='' THEN run ELSE excluded.run END,"
        "project_id=CASE WHEN excluded.project_id='' THEN project_id ELSE excluded.project_id END",
        (
            receipt.operation_id,
            fingerprint,
            receipt.paper_id,
            receipt.literature_id,
            receipt.attachment_id,
            receipt.title,
            receipt.revision,
            session_id,
            run,
            project_id,
        ),
    )


def _restore_admissions(
    connection: sqlite3.Connection,
    previous: sqlite3.Row | dict | None,
    receipt: DownloadReceipt,
) -> None:
    if previous is None:
        return
    connection.execute(
        f"UPDATE {DOWNLOAD_ADMISSION_TABLE} SET literature_id=?,attachment_id=? "
        "WHERE literature_id=? AND revision=?",
        (
            receipt.literature_id,
            receipt.attachment_id,
            previous["literature_id"],
            receipt.revision,
        ),
    )


def admit_download(
    repository: LiteratureRepository,
    operation_id: str,
    fingerprint: str,
    paper_id: str,
    item: LiteratureItem,
    payload: bytes,
    project_id: str,
    *,
    restore: bool = False,
    collection_id: str = "",
    candidates: Callable[[sqlite3.Connection], list[dict]] | None = None,
    session_id: str = "",
    run: str = "",
) -> DownloadReceipt:
    revision = payload_revision(payload)
    with closing(connect(repository.database)) as connection, connection:
        connection.execute("BEGIN IMMEDIATE")
        _prepare_admissions(connection)
        _validate_collection(connection, collection_id, project_id)
        previous = connection.execute(
            f"SELECT * FROM {DOWNLOAD_ADMISSION_TABLE} WHERE operation_id=?", (operation_id,)
        ).fetchone()
        receipt_session_id = session_id or (previous["session_id"] if previous else "")
        receipt_run = run or (previous["run"] if previous else "")
        receipt_project_id = project_id or (previous["project_id"] if previous else "")
        if previous is not None:
            if previous["fingerprint"] != fingerprint or previous["revision"] != revision:
                raise ValueError(DOWNLOAD_ADMISSION_CONFLICT)
            if any(
                previous[field] and incoming and previous[field] != incoming
                for field, incoming in (
                    ("session_id", session_id),
                    ("run", run),
                    ("project_id", project_id),
                )
            ):
                raise ValueError(DOWNLOAD_ADMISSION_CONFLICT)
            receipt = _download_receipt(previous)
            if _receipt_available(connection, receipt):
                _link_download(connection, receipt.literature_id, project_id, collection_id)
                _save_admission(
                    connection,
                    receipt,
                    fingerprint,
                    receipt_session_id,
                    receipt_run,
                    receipt_project_id,
                )
                return receipt
            if not restore:
                raise ValueError(DOWNLOAD_ADMISSION_UNAVAILABLE)
            connection.execute(
                f"DELETE FROM {DOWNLOAD_ADMISSION_TABLE} WHERE operation_id=?", (operation_id,)
            )
        available = candidates(connection) if candidates is not None else []
        duplicate = next((entry for entry in available if entry["revision"] == revision), None)
        incomplete = next((entry for entry in available if not entry["revision"]), None)
        existing = duplicate or incomplete
        literature_id = existing["literature_id"] if existing else item.id
        title_row = connection.execute(
            "SELECT title FROM literature_items WHERE id=?", (literature_id,)
        ).fetchone()
        if existing and title_row is None:
            raise ValueError(DOWNLOAD_ADMISSION_UNAVAILABLE)
        title = title_row["title"] if title_row is not None else item.title
        if duplicate:
            receipt = DownloadReceipt(
                paper_id, literature_id, duplicate["attachment_id"], title, revision, operation_id
            )
            if not _receipt_available(connection, receipt):
                raise ValueError(DOWNLOAD_ADMISSION_UNAVAILABLE)
            _link_download(connection, literature_id, project_id, collection_id)
            if restore:
                _restore_admissions(connection, previous or existing, receipt)
            _save_admission(
                connection,
                receipt,
                fingerprint,
                receipt_session_id,
                receipt_run,
                receipt_project_id,
            )
            return receipt
        managed = managed_object(literature_id, payload, PDF_SUFFIX)
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            location = batch.stage(managed.name, payload)

            def publish() -> DownloadReceipt:
                if existing is None:
                    repository.save(item, project_id, connection)
                elif existing.get("attachment_id"):
                    connection.execute(
                        "DELETE FROM literature_attachments WHERE id=? AND literature_id=?",
                        (existing["attachment_id"], literature_id),
                    )
                attachment = repository.add_attachment(
                    literature_id,
                    title + PDF_SUFFIX,
                    location,
                    PDF_KIND,
                    revision=managed.revision,
                    role=AttachmentRole.PRIMARY,
                    media_type=PDF_MEDIA_TYPE,
                    connection=connection,
                )
                receipt = DownloadReceipt(
                    paper_id, literature_id, attachment["id"], title, revision, operation_id
                )
                _link_download(connection, literature_id, project_id, collection_id)
                if restore:
                    _restore_admissions(connection, previous or existing, receipt)
                _save_admission(
                    connection,
                    receipt,
                    fingerprint,
                    receipt_session_id,
                    receipt_run,
                    receipt_project_id,
                )
                connection.commit()
                return receipt

            receipt = batch.commit_operation(publish)
        if existing and existing.get("path"):
            try:
                delete_attachments((existing["path"],))
            except (OSError, ValueError) as error:
                LOGGER.warning("download_replaced_attachment_cleanup_failed error=%s", error)
        return receipt
