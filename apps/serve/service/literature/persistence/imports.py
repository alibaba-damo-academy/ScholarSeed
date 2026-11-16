"""Literature-owned durable batch imports and atomic repository completion."""

from __future__ import annotations

import base64
import binascii
import json
import sqlite3
from contextlib import closing
from dataclasses import asdict, dataclass, replace
from enum import Enum
from pathlib import Path, PurePath

from service.literature.domain.model import (
    IMPORT_COLLECTION_UNAVAILABLE,
    IMPORT_CONFLICT,
    LIBRARY_INVALID,
    LIBRARY_UNAVAILABLE,
    MAX_IMPORT_BYTES,
    LiteratureError,
)
from service.literature.persistence.assets import MaterialAssets
from service.literature.persistence.files import (
    LiteratureFileBatch,
    managed_object,
)
from service.literature.persistence.store import (
    PDF_ATTACHMENT_KIND,
    LiteratureRepository,
    connect,
    decode,
    encode,
    load_library,
)
from service.literature.schema import (
    BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    AttachmentFile,
    AttachmentRole,
    FulltextStatus,
    LiteratureItem,
    LiteratureView,
)
from service.literature.service.catalog import append_items
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.content import ContentPort, ImportSourceContent, PreparedContent

IMPORT_TABLE = "literature_import_operation"


class ImportState(str, Enum):
    PREPARED = "prepared"
    COMPLETED = "completed"


@dataclass(frozen=True)
class ImportReceipt:
    """Original committed outcome, not a claim that its targets still exist."""

    operation_id: str
    items: tuple[LiteratureItem, ...]
    asset_ids: tuple[str, ...]
    added: int
    skipped: int
    total: int


class LiteratureImports:
    """Only this owner commits an import receipt alongside repository changes."""

    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._repository = LiteratureRepository()
        self._database = self._repository.database

    @staticmethod
    def validate_collections(view: LiteratureView, items: tuple[LiteratureItem, ...]) -> None:
        available = {collection.name for collection in view.collections}
        if any(item.collection and item.collection not in available for item in items):
            raise LiteratureError(IMPORT_COLLECTION_UNAVAILABLE)

    def validate_collection_target(self, project_id: str, collection_id: str) -> None:
        if collection_id:
            with closing(connect(self._database)) as connection:
                self._validate_collection_target(connection, project_id, collection_id)

    @staticmethod
    def _validate_collection_target(
        connection: sqlite3.Connection, project_id: str, collection_id: str
    ) -> None:
        if (
            collection_id
            and connection.execute(
                "SELECT 1 FROM literature_collections WHERE id = ? "
                "AND (project_id IS NULL OR project_id = ?)",
                (collection_id, project_id),
            ).fetchone()
            is None
        ):
            raise LiteratureError(IMPORT_COLLECTION_UNAVAILABLE)

    @staticmethod
    def _schema(connection: sqlite3.Connection) -> None:
        columns = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({IMPORT_TABLE})")}
        expected = {
            "project_id",
            "operation_id",
            "fingerprint",
            "prepared",
            "candidates",
            "attachments",
            "skipped",
            "state",
            "result",
        }
        if columns and not expected.issubset(columns):
            raise LiteratureError(LIBRARY_INVALID)
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {IMPORT_TABLE} (
            project_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            prepared TEXT NOT NULL, candidates TEXT NOT NULL, attachments TEXT NOT NULL,
            skipped INTEGER NOT NULL,
            state TEXT NOT NULL, result TEXT, collection_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY(project_id, operation_id)
        )""")
        if columns and "collection_id" not in columns:
            connection.execute(
                f"ALTER TABLE {IMPORT_TABLE} ADD COLUMN collection_id TEXT NOT NULL DEFAULT ''"
            )

    @staticmethod
    def _row(
        connection: sqlite3.Connection,
        project_id: str,
        operation_id: str,
        fingerprint: str,
    ):
        row = connection.execute(
            f"SELECT * FROM {IMPORT_TABLE} WHERE project_id = ? AND operation_id = ?",
            (project_id, operation_id),
        ).fetchone()
        if row is not None and row["fingerprint"] != fingerprint:
            raise LiteratureError(IMPORT_CONFLICT)
        return row

    @staticmethod
    def _decode_receipt(operation_id: str, payload: str) -> ImportReceipt:
        try:
            result = json.loads(payload)
            if not isinstance(result, dict) or set(result) not in (
                {
                    "items",
                    "asset_ids",
                    "added",
                    "skipped",
                    "total",
                },
                {"items", "added", "skipped", "total"},
            ):
                raise ValueError("invalid receipt")
            counts = tuple(result[key] for key in ("added", "skipped", "total"))
            if any(
                not isinstance(value, int) or isinstance(value, bool) or value < 0
                for value in counts
            ):
                raise ValueError("invalid counts")
            assets = result.get("asset_ids", [])
            if not isinstance(assets, list) or any(not isinstance(x, str) or not x for x in assets):
                raise ValueError("invalid assets")
            items = decode(result["items"]).items
            if (
                not items
                or ("asset_ids" in result and not assets)
                or len(set(assets)) != len(assets)
            ):
                raise ValueError("empty or duplicate receipt")
            return ImportReceipt(operation_id, items, tuple(assets), *counts)
        except (TypeError, ValueError, KeyError) as error:
            raise LiteratureError(LIBRARY_INVALID) from error

    @classmethod
    def _receipt(cls, row: sqlite3.Row) -> ImportReceipt:
        return cls._decode_receipt(row["operation_id"], row["result"])

    def _prepared(self, project_id: str, row: sqlite3.Row):
        try:
            skipped = row["skipped"]
            if not isinstance(skipped, int) or isinstance(skipped, bool) or skipped < 0:
                raise ValueError("invalid skipped count")
            raw_candidates = json.loads(row["candidates"])
            raw_prepared = json.loads(row["prepared"])
            raw_attachments = json.loads(row["attachments"])
            if (
                not isinstance(raw_candidates, list)
                or not isinstance(raw_prepared, list)
                or not isinstance(raw_attachments, list)
            ):
                raise ValueError("invalid prepared containers")
            candidates = tuple(
                item for encoded_view in raw_candidates for item in decode(encoded_view).items
            )
            prepared = tuple(
                (
                    PreparedContent(**item)
                    if "project_id" in item
                    else ImportSourceContent(
                        item["name"],
                        base64.b64decode(item["content"], validate=True),
                        BINARY_MEDIA_TYPE,
                    )
                )
                for item in raw_prepared
            )
            if not candidates or not prepared:
                raise ValueError("empty preparation")
            paths = {
                item.path if isinstance(item, PreparedContent) else str(index)
                for index, item in enumerate(prepared)
            }
            if len(paths) != len(prepared):
                raise ValueError("duplicate prepared target")
            for item in prepared:
                if isinstance(item, PreparedContent):
                    self._content.validate_prepared(item)
                    if item.project_id != project_id:
                        raise LiteratureError(IMPORT_CONFLICT)
                elif not isinstance(item.name, str) or not item.name:
                    raise ValueError("invalid source name")
            if (
                sum(
                    item.size if isinstance(item, PreparedContent) else len(item.content)
                    for item in prepared
                )
                > MAX_IMPORT_BYTES
            ):
                raise ValueError("import too large")
            attachments = tuple(
                (str(entry["literature_id"]), str(entry["prepared_path"]))
                for entry in raw_attachments
                if isinstance(entry, dict)
            )
            if len(attachments) != len(raw_attachments) or any(
                not literature_id or path not in paths for literature_id, path in attachments
            ):
                raise ValueError("invalid PDF mapping")
            return candidates, prepared, attachments
        except (TypeError, ValueError, KeyError, binascii.Error) as error:
            raise LiteratureError(LIBRARY_INVALID) from error

    def resume(
        self, project_id: str, operation_id: str, fingerprint: str, *, completed_only: bool = False
    ) -> ImportReceipt | None:
        if not self._database.is_file():
            return None
        with closing(connect(self._database)) as connection, connection:
            if (
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (IMPORT_TABLE,)
                ).fetchone()
                is None
            ):
                return None
            row = self._row(connection, project_id, operation_id, fingerprint)
            if row is None:
                return None
            if completed_only:
                if row["state"] != ImportState.COMPLETED.value:
                    raise LiteratureError(IMPORT_CONFLICT)
                return self._receipt(row)
        return self.finish(project_id, operation_id, fingerprint)

    def reserve(
        self,
        project_id: str,
        operation_id: str,
        fingerprint: str,
        admitted: tuple[tuple[ImportSourceContent, tuple[LiteratureItem, ...]], ...],
        skipped: int,
        collection_id: str = "",
    ) -> None:
        # Bad existing libraries must fail before preparing or publishing any files.
        view = load_library(project_id, self._database)
        self.validate_collections(view, tuple(item for _, items in admitted for item in items))
        if not admitted or sum(len(source.content) for source, _ in admitted) > MAX_IMPORT_BYTES:
            raise LiteratureError(LIBRARY_INVALID)
        self._content.project(project_id)
        with closing(connect(self._database)) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            self._schema(connection)
            self._validate_collection_target(connection, project_id, collection_id)
            if self._row(connection, project_id, operation_id, fingerprint) is not None:
                return
            preparations: list[dict[str, str]] = []
            candidates: list[LiteratureItem] = []
            attachments: list[dict[str, str]] = []
            for index, (source, items) in enumerate(admitted):
                preparations.append(
                    {
                        "name": source.name,
                        "content": base64.b64encode(source.content).decode("ascii"),
                    }
                )
                candidates.extend(items)
                attachments.extend(
                    {"literature_id": item.id, "prepared_path": str(index)}
                    for item in items
                    if item.fulltext is FulltextStatus.READY
                )
            connection.execute(
                f"INSERT INTO {IMPORT_TABLE} "
                "(project_id, operation_id, fingerprint, prepared, candidates, attachments, "
                "skipped, state, result, collection_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                (
                    project_id,
                    operation_id,
                    fingerprint,
                    json.dumps(preparations, ensure_ascii=False),
                    json.dumps([encode(LiteratureView(items=(item,))) for item in candidates]),
                    json.dumps(attachments, ensure_ascii=False),
                    skipped,
                    ImportState.PREPARED.value,
                    collection_id,
                ),
            )

    def finish(self, project_id: str, operation_id: str, fingerprint: str) -> ImportReceipt:
        with closing(connect(self._database)) as connection, connection:
            self._schema(connection)
            row = self._row(connection, project_id, operation_id, fingerprint)
            if row is None:
                raise LiteratureError(IMPORT_CONFLICT)
            if row["state"] == ImportState.COMPLETED.value:
                return self._receipt(row)
            if row["state"] != ImportState.PREPARED.value:
                raise LiteratureError(LIBRARY_INVALID)
            candidates, prepared, attachments = self._prepared(project_id, row)
        sources = {
            item.path if isinstance(item, PreparedContent) else str(index): (
                ImportSourceContent(
                    Path(item.path).name,
                    self._content.read_prepared(item),
                    BINARY_MEDIA_TYPE,
                )
                if isinstance(item, PreparedContent)
                else item
            )
            for index, item in enumerate(prepared)
        }
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            owned = tuple(
                self._own_copy(batch, literature_id, sources[prepared_path])
                for literature_id, prepared_path in attachments
            )
            attached = {item.literature_id for item in owned}
            cached = []
            for item in candidates:
                if item.id in attached:
                    continue
                payload = MaterialAssets(self._database).source_for(asdict(item))
                if payload is not None:
                    document = managed_object(item.id, payload, ".pdf")
                    cached.append(
                        AttachmentFile(
                            literature_id=item.id,
                            path=batch.stage(document.name, payload),
                            name="source.pdf",
                            revision=document.revision,
                        )
                    )
            owned = (*owned, *cached)
            try:
                receipt = batch.commit_operation(
                    lambda: self._commit(
                        project_id, operation_id, fingerprint, row, candidates, owned
                    )
                )
            except LiteratureError as error:
                if error.code != IMPORT_CONFLICT:
                    raise
                with closing(connect(self._database)) as connection:
                    current = self._row(connection, project_id, operation_id, fingerprint)
                    if current is None or current["state"] != ImportState.COMPLETED.value:
                        raise
                    return self._receipt(current)
            except (sqlite3.Error, OSError) as error:
                raise LiteratureError(LIBRARY_UNAVAILABLE) from error
        for item in prepared:
            if isinstance(item, PreparedContent):
                self._content.release_prepared(item)
        return receipt

    def _own_copy(
        self,
        batch: LiteratureFileBatch,
        literature_id: str,
        source: ImportSourceContent,
    ) -> AttachmentFile:
        """Give each literature item its own global attachment, not a project copy."""
        published = managed_object(
            literature_id, source.content, PurePath(source.name).suffix.lower()
        )
        return AttachmentFile(
            literature_id=literature_id,
            path=batch.stage(published.name, source.content),
            name=source.name,
            revision=published.revision,
        )

    def _commit(
        self,
        project_id: str,
        operation_id: str,
        fingerprint: str,
        row: sqlite3.Row,
        candidates: tuple[LiteratureItem, ...],
        owned: tuple[AttachmentFile, ...],
    ) -> ImportReceipt:
        """Bind the already published copies to their items inside one library write."""

        with closing(connect(self._database)) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            current = self._row(connection, project_id, operation_id, fingerprint)
            if current is None:
                raise LiteratureError(IMPORT_CONFLICT)
            if current["state"] == ImportState.COMPLETED.value:
                raise LiteratureError(IMPORT_CONFLICT)
            if any(
                current[key] != row[key]
                for key in (
                    "prepared",
                    "candidates",
                    "attachments",
                    "skipped",
                    "state",
                    "collection_id",
                )
            ):
                raise LiteratureError(IMPORT_CONFLICT)
            view = self._repository.view(project_id, connection)
            self.validate_collections(view, candidates)
            collection_id = current["collection_id"]
            self._validate_collection_target(connection, project_id, collection_id)
            view, added = append_items(view, candidates)
            for item in candidates:
                self._repository.save(item, project_id, connection)
            if collection_id:
                connection.executemany(
                    "INSERT OR IGNORE INTO literature_collection_items(collection_id,literature_id) "
                    "VALUES (?, ?)",
                    ((collection_id, item.id) for item in candidates),
                )
            for attachment in owned:
                self._repository.add_attachment(
                    attachment.literature_id,
                    attachment.name,
                    attachment.path,
                    PDF_ATTACHMENT_KIND,
                    revision=attachment.revision,
                    role=AttachmentRole.PRIMARY,
                    media_type=PDF_MEDIA_TYPE,
                    connection=connection,
                )
            attached_ids = {attachment.literature_id for attachment in owned}
            committed = tuple(
                replace(item, has_pdf=item.id in attached_ids)
                for item in dict((item.id, item) for item in candidates).values()
            )
            result = {
                "items": encode(LiteratureView(items=committed)),
                "added": added,
                "skipped": row["skipped"],
                "total": len(view.items),
            }
            encoded_result = json.dumps(result, ensure_ascii=False)
            receipt = self._decode_receipt(operation_id, encoded_result)
            connection.execute(
                f"UPDATE {IMPORT_TABLE} SET state = ?, result = ?, prepared = '[]', attachments = '[]' "
                "WHERE project_id = ? AND operation_id = ?",
                (ImportState.COMPLETED.value, encoded_result, project_id, operation_id),
            )
            return receipt
