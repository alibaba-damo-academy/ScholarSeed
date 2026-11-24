"""Verified component resource files and their SQLite references."""

from __future__ import annotations

import json
import shutil
import sqlite3
from collections.abc import Callable
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from sqlite3 import Connection, Row
from typing import Any

from service.capabilities.service.files import (
    REVISIONS_DIRECTORY,
    UI_DIRECTORY,
    ComponentFiles,
    resource_name,
)
from service.capabilities.service.package import PACKAGE_MANIFEST
from service.capabilities.service.ui import UI_MANIFEST
from service.persistence.project import connect, database_files

UI_REVISION_INVALID = "ui_revision_invalid"
COMPONENT_REVISION_INVALID = "component_revision_invalid"
UI_STORAGE_BATCH_SIZE = 4
VACUUM_SPACE_MULTIPLIER = 2
VACUUM_PROGRESS_OPCODES = 1000
UI_PACKAGE_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS component_ui_packages "
    "(fingerprint TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)"
)


class StoragePaused(Exception):
    """The owning runtime admitted foreground activity during a maintenance batch."""


def encode_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, allow_nan=False)


def payload_digest(body: str) -> str:
    return sha256(body.encode()).hexdigest()


def ensure_storage_schema(connection: Connection) -> None:
    additions = {
        "system_ui": (
            (
                "ui_fingerprint",
                "TEXT REFERENCES component_ui_packages(fingerprint)",
            ),
        ),
        "component_revisions": (
            ("ui_fingerprint", "TEXT REFERENCES component_ui_packages(fingerprint)"),
            ("file_digest", "TEXT"),
            ("original_ui_fingerprint", "TEXT"),
        ),
        "component_ui_packages": (("ref_count", "INTEGER NOT NULL DEFAULT 0"),),
        "component_bindings": (("external", "INTEGER NOT NULL DEFAULT 0"),),
    }
    for table, fields in additions.items():
        columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
        for name, declaration in fields:
            if name not in columns:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS component_binding_session ON component_bindings(session_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS component_binding_revision "
        "ON component_bindings(fingerprint,session_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS component_revision_ui ON component_revisions(ui_fingerprint)"
    )


def _verified_payload(body: str, digest: str, error: str) -> dict[str, Any]:
    if payload_digest(body) != digest:
        raise ValueError(error)
    data = json.loads(body)
    if not isinstance(data, dict):
        raise ValueError(error)
    return data


def _equivalent_ui(previous: dict[str, Any], current: dict[str, Any]) -> bool:
    if any(
        previous.get(key) != current.get(key)
        for key in ("id", "schema", "compatibility", "exports", "components", "runtime")
    ):
        return False
    metadata = {PACKAGE_MANIFEST, UI_MANIFEST}
    return {k: v for k, v in previous["files"].items() if k not in metadata} == {
        k: v for k, v in current["files"].items() if k not in metadata
    }


class Resources:
    def __init__(self, files: ComponentFiles) -> None:
        self.files = files

    def _read(self, directory: str, fingerprint: str, error: str) -> str:
        try:
            return self.files.read((directory,), resource_name(fingerprint))
        except FileNotFoundError as missing:
            raise ValueError(error) from missing

    def _write(
        self,
        directory: str,
        fingerprint: str,
        body: str,
        checkpoint: Callable[[], None] | None = None,
    ) -> None:
        name = resource_name(fingerprint)
        try:
            previous = self.files.read((directory,), name)
        except FileNotFoundError:
            self.files.write((directory,), name, body, checkpoint)
        else:
            if previous != body:
                raise ValueError(COMPONENT_REVISION_INVALID)

    def retain_ui(
        self,
        connection: Connection,
        ui: dict[str, Any],
        checkpoint: Callable[[], None] | None = None,
    ) -> str:
        fingerprint = ui["fingerprint"]
        body = encode_payload(ui)
        digest = payload_digest(body)
        row = connection.execute(
            "SELECT body,digest FROM component_ui_packages WHERE fingerprint=?", (fingerprint,)
        ).fetchone()
        if row is not None:
            if row["digest"] != digest or (row["body"] and row["body"] != body):
                raise ValueError(UI_REVISION_INVALID)
            if row["body"]:
                return fingerprint
        self._write(UI_DIRECTORY, fingerprint, body, checkpoint)
        connection.execute(
            "INSERT OR IGNORE INTO component_ui_packages(fingerprint,body,digest) VALUES (?,'',?)",
            (fingerprint, digest),
        )
        return fingerprint

    def _ui_package(self, connection: Connection, fingerprint: str) -> tuple[str, str]:
        row = connection.execute(
            "SELECT body,digest FROM component_ui_packages WHERE fingerprint=?", (fingerprint,)
        ).fetchone()
        if row is None:
            raise ValueError(UI_REVISION_INVALID)
        return (
            row["body"] or self._read(UI_DIRECTORY, fingerprint, UI_REVISION_INVALID),
            row["digest"],
        )

    def read_ui(self, connection: Connection, row: Row) -> dict[str, Any]:
        fingerprint = row["ui_fingerprint"]
        if fingerprint is None:
            return _verified_payload(row["body"], row["digest"], UI_REVISION_INVALID)
        body, digest = self._ui_package(connection, fingerprint)
        ui = _verified_payload(body, digest, UI_REVISION_INVALID)
        if digest != row["digest"] or ui.get("fingerprint") != fingerprint:
            raise ValueError(UI_REVISION_INVALID)
        return ui

    def read_revision(self, connection: Connection, fingerprint: str) -> dict[str, Any]:
        row = connection.execute(
            "SELECT * FROM component_revisions WHERE fingerprint=?", (fingerprint,)
        ).fetchone()
        if row is None:
            raise ValueError(COMPONENT_REVISION_INVALID)
        ui_fingerprint = row["ui_fingerprint"]
        if row["file_digest"] is not None:
            body = self._read(REVISIONS_DIRECTORY, fingerprint, COMPONENT_REVISION_INVALID)
            record = _verified_payload(body, row["file_digest"], COMPONENT_REVISION_INVALID)
            snapshot = record.get("snapshot")
            if (
                not isinstance(snapshot, dict)
                or snapshot.get("fingerprint") != fingerprint
                or record.get("original_ui_fingerprint") != row["original_ui_fingerprint"]
            ):
                raise ValueError(COMPONENT_REVISION_INVALID)
        elif ui_fingerprint is None:
            return _verified_payload(row["body"], row["digest"], COMPONENT_REVISION_INVALID)
        else:
            snapshot = json.loads(row["body"])
            if not isinstance(snapshot, dict) or "ui" in snapshot:
                raise ValueError(COMPONENT_REVISION_INVALID)
        if ui_fingerprint is not None:
            body, digest = self._ui_package(connection, ui_fingerprint)
            ui = _verified_payload(body, digest, UI_REVISION_INVALID)
            if ui.get("fingerprint") != ui_fingerprint:
                raise ValueError(UI_REVISION_INVALID)
            snapshot["ui"] = ui
        if row["file_digest"] is None and payload_digest(encode_payload(snapshot)) != row["digest"]:
            raise ValueError(COMPONENT_REVISION_INVALID)
        return snapshot

    def _write_revision(
        self,
        connection: Connection,
        snapshot: dict[str, Any],
        checkpoint: Callable[[], None] | None = None,
    ) -> tuple[str, str | None]:
        ui = snapshot.get("ui")
        ui_fingerprint = None if ui is None else self.retain_ui(connection, ui, checkpoint)
        content = (
            snapshot
            if ui is None
            else {key: value for key, value in snapshot.items() if key != "ui"}
        )
        body = encode_payload(
            {
                "snapshot": content,
                "original_ui_fingerprint": ui_fingerprint,
            }
        )
        self._write(REVISIONS_DIRECTORY, snapshot["fingerprint"], body, checkpoint)
        return payload_digest(body), ui_fingerprint

    def retain_revision(self, connection: Connection, snapshot: dict[str, Any]) -> None:
        fingerprint = snapshot["fingerprint"]
        digest = payload_digest(encode_payload(snapshot))
        previous = connection.execute(
            "SELECT digest, file_digest, original_ui_fingerprint, ui_fingerprint "
            "FROM component_revisions WHERE fingerprint=?",
            (fingerprint,),
        ).fetchone()
        if previous is not None:
            if previous["digest"] != digest:
                current = self.read_revision(connection, fingerprint)
                if previous["original_ui_fingerprint"] == previous["ui_fingerprint"] or (
                    payload_digest(encode_payload(current)) != digest
                ):
                    raise ValueError("component_revision_changed")
            elif previous["file_digest"] is not None and (
                previous["original_ui_fingerprint"] == previous["ui_fingerprint"]
            ):
                # A collector interrupted after unlink may leave an unreferenced index row.
                self._write_revision(connection, snapshot)
            return
        file_digest, ui_fingerprint = self._write_revision(connection, snapshot)
        connection.execute(
            "INSERT INTO component_revisions("
            "fingerprint,plugin,body,digest,file_digest,ui_fingerprint,original_ui_fingerprint"
            ") VALUES(?,?,'',?,?,?,?)",
            (
                fingerprint,
                snapshot["descriptor"]["id"],
                digest,
                file_digest,
                ui_fingerprint,
                ui_fingerprint,
            ),
        )

    def replace_equivalent_ui(
        self, connection: Connection, previous: dict[str, Any], ui: dict[str, Any]
    ) -> None:
        if not _equivalent_ui(previous, ui):
            return
        connection.execute(
            "UPDATE component_revisions SET ui_fingerprint=? "
            "WHERE ui_fingerprint=? AND file_digest IS NOT NULL",
            (ui["fingerprint"], previous["fingerprint"]),
        )

    def migrate(self, connection: Connection, checkpoint: Callable[[], None]) -> bool:
        active = connection.execute(
            "SELECT * FROM system_ui WHERE ui_fingerprint IS NULL ORDER BY compatibility LIMIT 1"
        ).fetchone()
        if active is not None:
            ui = self.read_ui(connection, active)
            checkpoint()
            fingerprint = self.retain_ui(connection, ui, checkpoint)
            connection.execute(
                "UPDATE system_ui SET body='',ui_fingerprint=? WHERE compatibility=?",
                (fingerprint, active["compatibility"]),
            )
            return True
        row = connection.execute(
            "SELECT fingerprint,digest FROM component_revisions "
            "WHERE file_digest IS NULL ORDER BY fingerprint LIMIT 1"
        ).fetchone()
        if row is not None:
            snapshot = self.read_revision(connection, row["fingerprint"])
            if payload_digest(encode_payload(snapshot)) != row["digest"]:
                raise ValueError(COMPONENT_REVISION_INVALID)
            checkpoint()
            file_digest, ui_fingerprint = self._write_revision(connection, snapshot, checkpoint)
            effective_ui = ui_fingerprint
            if ui_fingerprint is not None:
                previous = snapshot["ui"]
                active = connection.execute(
                    "SELECT body,digest,ui_fingerprint FROM system_ui WHERE compatibility=?",
                    (previous["compatibility"],),
                ).fetchone()
                if active is not None and active["ui_fingerprint"] != ui_fingerprint:
                    checkpoint()
                    current = self.read_ui(connection, active)
                    if _equivalent_ui(previous, current):
                        effective_ui = current["fingerprint"]
            connection.execute(
                "UPDATE component_revisions SET body='',file_digest=?,ui_fingerprint=?,"
                "original_ui_fingerprint=? WHERE fingerprint=?",
                (file_digest, effective_ui, ui_fingerprint, row["fingerprint"]),
            )
            return True
        package = connection.execute(
            "SELECT fingerprint,body,digest FROM component_ui_packages "
            "WHERE body<>'' ORDER BY fingerprint LIMIT 1"
        ).fetchone()
        if package is not None:
            ui = _verified_payload(package["body"], package["digest"], UI_REVISION_INVALID)
            if ui.get("fingerprint") != package["fingerprint"]:
                raise ValueError(UI_REVISION_INVALID)
            checkpoint()
            self._write(UI_DIRECTORY, package["fingerprint"], package["body"], checkpoint)
            connection.execute(
                "UPDATE component_ui_packages SET body='' WHERE fingerprint=?",
                (package["fingerprint"],),
            )
            return True
        return False

    @staticmethod
    def recount(connection: Connection, revision: str | None = None) -> None:
        query = (
            "UPDATE component_ui_packages AS package SET ref_count=("
            " SELECT count(DISTINCT binding.session_id) FROM component_bindings AS binding"
            " JOIN component_revisions AS revision ON revision.fingerprint=binding.fingerprint"
            " WHERE revision.ui_fingerprint=package.fingerprint"
            ")+(SELECT count(*) FROM system_ui WHERE ui_fingerprint=package.fingerprint"
            ")+(SELECT count(DISTINCT revision.fingerprint) FROM component_slots AS slot"
            " JOIN component_revisions AS revision ON revision.fingerprint=slot.fingerprint"
            " WHERE revision.ui_fingerprint=package.fingerprint)"
        )
        if revision is None:
            connection.execute(query)
        else:
            connection.execute(
                query + " WHERE fingerprint=(SELECT ui_fingerprint FROM component_revisions "
                "WHERE fingerprint=?)",
                (revision,),
            )

    def collect(self, connection: Connection) -> None:
        revisions = connection.execute(
            "SELECT r.fingerprint,r.file_digest FROM component_revisions AS r WHERE "
            " NOT EXISTS (SELECT 1 FROM component_bindings WHERE fingerprint=r.fingerprint)"
            " AND NOT EXISTS (SELECT 1 FROM component_slots WHERE fingerprint=r.fingerprint)"
        ).fetchall()
        for row in revisions:
            fingerprint = row["fingerprint"]
            connection.execute(
                "DELETE FROM component_revisions WHERE fingerprint=?", (fingerprint,)
            )
            if row["file_digest"] is not None:
                self.files.discard((REVISIONS_DIRECTORY,), resource_name(fingerprint))
        self.recount(connection)
        packages = connection.execute(
            "SELECT fingerprint FROM component_ui_packages WHERE ref_count=0"
        ).fetchall()
        for row in packages:
            fingerprint = row["fingerprint"]
            connection.execute(
                "DELETE FROM component_ui_packages WHERE fingerprint=?", (fingerprint,)
            )
            self.files.discard((UI_DIRECTORY,), resource_name(fingerprint))


def reclaim_ui_storage(database: Path, can_continue: Callable[[], bool]) -> None:
    """Reclaim free pages with the component database and sidecars qualified."""
    with database_files(database, stable_sidecars=False) as present:
        if not present or not can_continue():
            return
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
                raise RuntimeError(
                    "component storage contains a table without a stable primary key"
                )
            pages = connection.execute("PRAGMA page_count").fetchone()[0]
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            if (
                shutil.disk_usage(database.parent).free
                < pages * page_size * VACUUM_SPACE_MULTIPLIER
            ):
                raise RuntimeError("insufficient disk space for component storage maintenance")
            connection.set_progress_handler(
                lambda: int(not can_continue()), VACUUM_PROGRESS_OPCODES
            )
            try:
                connection.execute("VACUUM")
            except sqlite3.OperationalError as error:
                if error.sqlite_errorcode != sqlite3.SQLITE_INTERRUPT:
                    raise
                raise StoragePaused from error
            finally:
                connection.set_progress_handler(None, 0)
            if connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0]:
                raise RuntimeError("component storage checkpoint is busy")
