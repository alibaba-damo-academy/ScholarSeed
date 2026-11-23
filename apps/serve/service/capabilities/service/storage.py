"""Persist shared UI payloads and normalize existing component snapshots."""

from __future__ import annotations

import json
import shutil
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from sqlite3 import Connection, Row
from typing import Any

from service.persistence.project import connect

UI_REVISION_INVALID = "ui_revision_invalid"
COMPONENT_REVISION_INVALID = "component_revision_invalid"
UI_STORAGE_BATCH_SIZE = 4
VACUUM_SPACE_MULTIPLIER = 2
UI_PACKAGE_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS component_ui_packages "
    "(fingerprint TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)"
)


def encode_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False)


def payload_digest(body: str) -> str:
    return sha256(body.encode()).hexdigest()


def ensure_ui_storage(connection: Connection) -> None:
    for table in ("system_ui", "component_revisions"):
        columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
        if "ui_fingerprint" not in columns:
            connection.execute(
                f"ALTER TABLE {table} ADD COLUMN ui_fingerprint TEXT "
                "REFERENCES component_ui_packages(fingerprint)"
            )


def retain_ui_package(connection: Connection, ui: dict[str, Any]) -> str:
    fingerprint = ui["fingerprint"]
    body = encode_payload(ui)
    digest = payload_digest(body)
    connection.execute(
        "INSERT INTO component_ui_packages(fingerprint,body,digest) VALUES (?,?,?) "
        "ON CONFLICT(fingerprint) DO NOTHING",
        (fingerprint, body, digest),
    )
    verified = connection.execute(
        "SELECT 1 FROM component_ui_packages WHERE fingerprint=? AND digest=? AND body=?",
        (fingerprint, digest, body),
    ).fetchone()
    if verified is None:
        raise ValueError(UI_REVISION_INVALID)
    return fingerprint


def _verified_payload(body: str, digest: str, error: str) -> dict[str, Any]:
    if payload_digest(body) != digest:
        raise ValueError(error)
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError(error)
    return data


def _ui_package(connection: Connection, fingerprint: str) -> tuple[str, str]:
    row = connection.execute(
        "SELECT body,digest FROM component_ui_packages WHERE fingerprint=?", (fingerprint,)
    ).fetchone()
    if row is None:
        raise ValueError(UI_REVISION_INVALID)
    return row["body"], row["digest"]


def read_active_ui(connection: Connection, row: Row) -> dict[str, Any]:
    fingerprint = row["ui_fingerprint"]
    if fingerprint is None:
        return _verified_payload(row["body"], row["digest"], UI_REVISION_INVALID)
    body, digest = _ui_package(connection, fingerprint)
    ui = _verified_payload(body, row["digest"], UI_REVISION_INVALID)
    if digest != row["digest"] or ui.get("fingerprint") != fingerprint:
        raise ValueError(UI_REVISION_INVALID)
    return ui


def read_component_revision(connection: Connection, row: Row) -> dict[str, Any]:
    fingerprint = row["ui_fingerprint"]
    if fingerprint is None:
        return _verified_payload(row["body"], row["digest"], COMPONENT_REVISION_INVALID)
    snapshot = json.loads(row["body"])
    if not isinstance(snapshot, dict) or "ui" in snapshot:
        raise ValueError(COMPONENT_REVISION_INVALID)
    body, digest = _ui_package(connection, fingerprint)
    ui = _verified_payload(body, digest, UI_REVISION_INVALID)
    if ui.get("fingerprint") != fingerprint:
        raise ValueError(UI_REVISION_INVALID)
    snapshot["ui"] = ui
    if payload_digest(encode_payload(snapshot)) != row["digest"]:
        raise ValueError(COMPONENT_REVISION_INVALID)
    return snapshot


def store_component_payload(
    connection: Connection, snapshot: dict[str, Any]
) -> tuple[str, str | None]:
    ui = snapshot.get("ui")
    if ui is None:
        return encode_payload(snapshot), None
    fingerprint = retain_ui_package(connection, ui)
    return (
        encode_payload({key: value for key, value in snapshot.items() if key != "ui"}),
        fingerprint,
    )


def migrate_ui_storage(connection: Connection, batch_size: int) -> bool:
    """Move one batch under the registry writer transaction and signal remaining work."""
    active = connection.execute(
        "SELECT compatibility,body,digest,ui_fingerprint FROM system_ui "
        "WHERE ui_fingerprint IS NULL ORDER BY compatibility LIMIT ?",
        (batch_size + 1,),
    ).fetchall()
    for row in active[:batch_size]:
        fingerprint = retain_ui_package(connection, read_active_ui(connection, row))
        connection.execute(
            "UPDATE system_ui SET body='',ui_fingerprint=? WHERE compatibility=?",
            (fingerprint, row["compatibility"]),
        )
    if len(active) > batch_size:
        return True

    remaining = batch_size - len(active)
    revisions = connection.execute(
        "SELECT fingerprint,body,digest,ui_fingerprint FROM component_revisions "
        "WHERE ui_fingerprint IS NULL AND json_type(body,'$.ui')='object' "
        "ORDER BY fingerprint LIMIT ?",
        (remaining + 1,),
    ).fetchall()
    for row in revisions[:remaining]:
        snapshot = read_component_revision(connection, row)
        body, fingerprint = store_component_payload(connection, snapshot)
        if payload_digest(encode_payload(snapshot)) != row["digest"]:
            raise ValueError(COMPONENT_REVISION_INVALID)
        connection.execute(
            "UPDATE component_revisions SET body=?,ui_fingerprint=? WHERE fingerprint=?",
            (body, fingerprint, row["fingerprint"]),
        )
    return len(revisions) > remaining


def reclaim_ui_storage(database: Path) -> None:
    """Reclaim committed free pages while the caller holds exclusive storage admission."""
    with closing(connect(database)) as connection:
        connection.execute("PRAGMA busy_timeout=0")
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
            raise RuntimeError("component storage checkpoint is busy")
        if not connection.execute("PRAGMA freelist_count").fetchone()[0]:
            return
        if connection.execute(
            "SELECT 1 FROM pragma_table_list AS t WHERE t.schema='main' "
            "AND substr(t.name,1,7)<>'sqlite_' AND (t.type<>'table' OR NOT EXISTS "
            "(SELECT 1 FROM pragma_table_xinfo(t.name) AS c WHERE c.pk<>0)) LIMIT 1"
        ).fetchone():
            raise RuntimeError("component storage contains a table without a stable primary key")
        pages = connection.execute("PRAGMA page_count").fetchone()[0]
        page_size = connection.execute("PRAGMA page_size").fetchone()[0]
        if shutil.disk_usage(database.parent).free < pages * page_size * VACUUM_SPACE_MULTIPLIER:
            raise RuntimeError("insufficient disk space for component storage maintenance")
        connection.execute("VACUUM")
        if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
            raise RuntimeError("component storage checkpoint is busy")
