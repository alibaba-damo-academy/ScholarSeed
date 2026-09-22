"""Durable resource import requests, target reservations and committed outcomes."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from enum import Enum
from pathlib import Path
from typing import Callable

from service.content.domain.model import ContentError
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform.content import ContentPort, FileAssetRef, PreparedContent
from service.resources.domain.model import IMPORT_CONFLICT, IMPORT_INVALID, IMPORT_UNAVAILABLE

IMPORT_TABLE = "resources_import_operation"


class ImportState(str, Enum):
    PREPARED = "prepared"
    COMPLETED = "completed"


class ResourceImportConflict(ValueError):
    pass


@dataclass(frozen=True)
class ResourceImportOperation:
    operation_id: str
    fingerprint: str
    prepared: PreparedContent
    state: ImportState


class ResourceImportCatalog:
    """Serialize reservations in the project's shared database, never in memory."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {IMPORT_TABLE} (
            operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
            target_path TEXT NOT NULL UNIQUE, prepared TEXT NOT NULL,
            state TEXT NOT NULL, asset_id TEXT
        )""")
        columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({IMPORT_TABLE})")}
        if "asset_id" not in columns:
            connection.execute(f"ALTER TABLE {IMPORT_TABLE} ADD COLUMN asset_id TEXT")

    def _operation(
        self, project_id: str, fingerprint: str, row: sqlite3.Row
    ) -> ResourceImportOperation:
        if row["fingerprint"] != fingerprint:
            raise ResourceImportConflict(IMPORT_CONFLICT)
        try:
            prepared = PreparedContent(**json.loads(row["prepared"]))
            state = ImportState(row["state"])
            self._content.validate_prepared(prepared)
        except (TypeError, ValueError, ContentError) as error:
            # Unsupported receipts remain evidence, never a reason to recreate a file.
            raise ResourceImportConflict(IMPORT_UNAVAILABLE) from error
        if prepared.project_id != project_id or prepared.path != row["target_path"]:
            raise ResourceImportConflict(IMPORT_CONFLICT)
        return ResourceImportOperation(row["operation_id"], fingerprint, prepared, state)

    def resume(self, project_id: str, operation_id: str, fingerprint: str) -> FileAssetRef | None:
        """Recover only an existing exact request, without reading its original source."""
        if not operation_id or not fingerprint:
            raise ResourceImportConflict(IMPORT_INVALID)
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        if not Path(database).is_file():
            return None
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
                    (IMPORT_TABLE,),
                ).fetchone()
                is None
            ):
                return None
            row = connection.execute(
                f"SELECT * FROM {IMPORT_TABLE} WHERE operation_id = ?", (operation_id,)
            ).fetchone()
            if row is None:
                return None
            operation = self._operation(project_id, fingerprint, row)
            self._schema(connection)
        # finish owns its transactions and revalidates the persisted receipt.
        return self.finish(project_id, operation)

    def reserve(
        self,
        project_id: str,
        operation_id: str,
        fingerprint: str,
        prepare: Callable[[tuple[str, ...]], PreparedContent],
    ) -> ResourceImportOperation:
        if not operation_id or not fingerprint:
            raise ResourceImportConflict(IMPORT_INVALID)
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            row = connection.execute(
                f"SELECT * FROM {IMPORT_TABLE} WHERE operation_id = ?", (operation_id,)
            ).fetchone()
            if row is not None:
                return self._operation(project_id, fingerprint, row)
            reserved = tuple(
                row["target_path"]
                for row in connection.execute(f"SELECT target_path FROM {IMPORT_TABLE}")
            )
            prepared = prepare(reserved)
            if prepared.project_id != project_id:
                raise ResourceImportConflict(IMPORT_CONFLICT)
            connection.execute(
                f"INSERT INTO {IMPORT_TABLE} (operation_id, fingerprint, target_path, prepared, state) VALUES (?, ?, ?, ?, ?)",
                (
                    operation_id,
                    fingerprint,
                    prepared.path,
                    json.dumps(asdict(prepared), ensure_ascii=False),
                    ImportState.PREPARED.value,
                ),
            )
            return ResourceImportOperation(
                operation_id, fingerprint, prepared, ImportState.PREPARED
            )

    def finish(self, project_id: str, operation: ResourceImportOperation) -> FileAssetRef:
        database = self._content.resolve(project_id, PROJECT_DB_RELATIVE)
        with transaction(database) as connection:
            row = connection.execute(
                f"SELECT * FROM {IMPORT_TABLE} WHERE operation_id = ?",
                (operation.operation_id,),
            ).fetchone()
            if row is None or row["fingerprint"] != operation.fingerprint:
                raise ResourceImportConflict(IMPORT_CONFLICT)
            try:
                persisted_receipt = json.loads(row["prepared"])
                state = ImportState(row["state"])
            except (TypeError, ValueError) as error:
                raise ResourceImportConflict(IMPORT_UNAVAILABLE) from error
            if persisted_receipt != asdict(operation.prepared):
                raise ResourceImportConflict(IMPORT_CONFLICT)
            asset_id = row["asset_id"]
            receipt = row["prepared"]
        # Content owns its transaction; never nest it inside a Resource write lock.
        asset = (
            self._content.asset(project_id, asset_id, creation=operation.prepared)
            if state is ImportState.COMPLETED and asset_id
            else self._content.materialize(operation.prepared)
        )
        if not asset.asset_id:
            raise ResourceImportConflict(IMPORT_UNAVAILABLE)
        with transaction(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = connection.execute(
                f"SELECT * FROM {IMPORT_TABLE} WHERE operation_id = ?", (operation.operation_id,)
            ).fetchone()
            if (
                current is None
                or current["fingerprint"] != operation.fingerprint
                or current["prepared"] != receipt
                or current["asset_id"] not in (None, asset.asset_id)
            ):
                raise ResourceImportConflict(IMPORT_CONFLICT)
            connection.execute(
                f"UPDATE {IMPORT_TABLE} SET state = ?, asset_id = ? WHERE operation_id = ?",
                (ImportState.COMPLETED.value, asset.asset_id, operation.operation_id),
            )
        return asset
