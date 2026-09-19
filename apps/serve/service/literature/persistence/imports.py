"""Literature-owned durable batch imports and atomic repository completion."""

from __future__ import annotations

import json
import sqlite3
from contextlib import ExitStack
from dataclasses import asdict, dataclass, replace
from enum import Enum
from pathlib import Path, PurePath

from service.literature.domain.model import (
    IMPORT_COLLECTION_UNAVAILABLE,
    IMPORT_CONFLICT,
    LIBRARY_INVALID,
    LiteratureError,
)
from service.literature.persistence.files import (
    LiteratureFileBatch,
    ManagedObject,
    managed_object,
)
from service.literature.persistence.store import (
    PDF_ATTACHMENT_KIND,
    LiteratureRepository,
    connect,
    decode,
    edit_library,
    encode,
    load_library,
)
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    AttachmentFile,
    AttachmentRole,
    FulltextStatus,
    LiteratureItem,
    LiteratureView,
)
from service.literature.service.catalog import append_items
from service.paths import SERVICE_LITERATURE_FILES_DIR
from service.platform.content import ContentPort, ImportSourceContent, PreparedContent, RootKind

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
        if columns and columns != expected:
            connection.execute(f"DROP TABLE {IMPORT_TABLE}")
        connection.execute(f"""CREATE TABLE IF NOT EXISTS {IMPORT_TABLE} (
            project_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
            prepared TEXT NOT NULL, candidates TEXT NOT NULL, attachments TEXT NOT NULL,
            skipped INTEGER NOT NULL,
            state TEXT NOT NULL, result TEXT, PRIMARY KEY(project_id, operation_id)
        )""")

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
            if not isinstance(result, dict) or set(result) != {
                "items",
                "asset_ids",
                "added",
                "skipped",
                "total",
            }:
                raise ValueError("invalid receipt")
            counts = tuple(result[key] for key in ("added", "skipped", "total"))
            if any(type(value) is not int or value < 0 for value in counts):
                raise ValueError("invalid counts")
            assets = result["asset_ids"]
            if not isinstance(assets, list) or any(not isinstance(x, str) or not x for x in assets):
                raise ValueError("invalid assets")
            items = decode(result["items"]).items
            if not items or not assets or len(set(assets)) != len(assets):
                raise ValueError("empty or duplicate receipt")
            return ImportReceipt(operation_id, items, tuple(assets), *counts)
        except (TypeError, ValueError, KeyError) as error:
            raise LiteratureError(LIBRARY_INVALID) from error

    @classmethod
    def _receipt(cls, row: sqlite3.Row) -> ImportReceipt:
        return cls._decode_receipt(row["operation_id"], row["result"])

    def _prepared(self, project_id: str, row: sqlite3.Row):
        try:
            if type(row["skipped"]) is not int or row["skipped"] < 0:
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
            prepared = tuple(PreparedContent(**item) for item in raw_prepared)
            if not candidates or not prepared:
                raise ValueError("empty preparation")
            paths = {item.path for item in prepared}
            if len(paths) != len(prepared):
                raise ValueError("duplicate prepared target")
            for item in prepared:
                self._content.validate_prepared(item)
                if item.project_id != project_id:
                    raise LiteratureError(IMPORT_CONFLICT)
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
        except (TypeError, ValueError) as error:
            raise LiteratureError(LIBRARY_INVALID) from error

    def resume(
        self, project_id: str, operation_id: str, fingerprint: str, *, completed_only: bool = False
    ) -> ImportReceipt | None:
        if not self._database.is_file():
            return None
        with connect(self._database) as connection:
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
    ) -> None:
        # Bad existing libraries must fail before preparing or publishing any files.
        view = load_library(project_id, self._database)
        self.validate_collections(view, tuple(item for _, items in admitted for item in items))
        root = self._content.root(project_id, RootKind.LITERATURE).path
        with ExitStack() as cleanup:
            with connect(self._database) as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._schema(connection)
                if self._row(connection, project_id, operation_id, fingerprint) is not None:
                    return
                reserved: list[str] = []
                for row in connection.execute(
                    f"SELECT prepared FROM {IMPORT_TABLE} WHERE project_id = ?", (project_id,)
                ):
                    reserved.extend(entry["path"] for entry in json.loads(row["prepared"]))
                preparations: list[PreparedContent] = []
                candidates: list[LiteratureItem] = []
                attachments: list[dict[str, str]] = []
                for source, items in admitted:
                    prepared = self._content.prepare_bytes(
                        project_id, root, source.name, source.content, tuple(reserved)
                    )
                    cleanup.callback(self._content.release_prepared, prepared)
                    preparations.append(prepared)
                    reserved.append(prepared.path)
                    candidates.extend(items)
                    attachments.extend(
                        {"literature_id": item.id, "prepared_path": prepared.path}
                        for item in items
                        if item.fulltext is FulltextStatus.READY
                    )
                connection.execute(
                    f"INSERT INTO {IMPORT_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
                    (
                        project_id,
                        operation_id,
                        fingerprint,
                        json.dumps([asdict(item) for item in preparations], ensure_ascii=False),
                        json.dumps([encode(LiteratureView(items=(item,))) for item in candidates]),
                        json.dumps(attachments, ensure_ascii=False),
                        skipped,
                        ImportState.PREPARED.value,
                    ),
                )
            cleanup.pop_all()

    def finish(self, project_id: str, operation_id: str, fingerprint: str) -> ImportReceipt:
        with connect(self._database) as connection:
            row = self._row(connection, project_id, operation_id, fingerprint)
            if row is None:
                raise LiteratureError(IMPORT_CONFLICT)
            if row["state"] == ImportState.COMPLETED.value:
                return self._receipt(row)
            if row["state"] != ImportState.PREPARED.value:
                raise LiteratureError(LIBRARY_INVALID)
            candidates, prepared, attachments = self._prepared(project_id, row)
        # Content owns its own project transaction. Never nest it under our write lock.
        assets = tuple(self._content.materialize(item) for item in prepared)
        if any(not asset.asset_id for asset in assets):
            raise LiteratureError(LIBRARY_INVALID)
        published = {item.path: asset.path for item, asset in zip(prepared, assets, strict=True)}
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            owned = tuple(
                self._own_copy(batch, project_id, literature_id, published[prepared_path])
                for literature_id, prepared_path in attachments
            )
            return batch.commit_operation(
                lambda: self._commit(
                    project_id, operation_id, fingerprint, row, candidates, owned, assets
                )
            )

    def _own_copy(
        self,
        batch: LiteratureFileBatch,
        project_id: str,
        literature_id: str,
        project_path: str,
    ) -> AttachmentFile:
        """Give one imported item its own copy of the file published into the project.

        项目里那份照旧发布 (资料库视图与导入台账都指着它), 但文献附件不再指向它:
        附件是文献库托管目录里独占的一份, 于是删文献只删这份副本, 用户在项目里改
        那份文件也不会悄悄换掉文献的全文。代价是同一个 PDF 存两份, 这是"附件随
        文献走"的必然结果。
        """

        payload, _media_type = self._content.read_bytes(project_id, project_path)
        published: ManagedObject = managed_object(
            literature_id, payload, PurePath(project_path).suffix.lower()
        )
        return AttachmentFile(
            literature_id=literature_id,
            path=batch.stage(published.name, payload),
            name=Path(project_path).name,
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
        assets: tuple,
    ) -> ImportReceipt:
        """Bind the already published copies to their items inside one library write."""

        with edit_library(project_id, self._database) as edit:
            current = self._row(edit.connection, project_id, operation_id, fingerprint)
            if current is None:
                raise LiteratureError(IMPORT_CONFLICT)
            if current["state"] == ImportState.COMPLETED.value:
                return self._receipt(current)
            if any(
                current[key] != row[key]
                for key in ("prepared", "candidates", "attachments", "skipped", "state")
            ):
                raise LiteratureError(IMPORT_CONFLICT)
            self.validate_collections(edit.view, candidates)
            edit.view, added = append_items(edit.view, candidates)
            self._repository.replace_view(edit.view, project_id, edit.connection)
            for attachment in owned:
                self._repository.add_attachment(
                    attachment.literature_id,
                    attachment.name,
                    attachment.path,
                    PDF_ATTACHMENT_KIND,
                    revision=attachment.revision,
                    role=AttachmentRole.PRIMARY,
                    media_type=PDF_MEDIA_TYPE,
                    connection=edit.connection,
                )
            attached_ids = {attachment.literature_id for attachment in owned}
            committed = tuple(
                replace(item, has_pdf=item.id in attached_ids)
                for item in dict((item.id, item) for item in candidates).values()
            )
            result = {
                "items": encode(LiteratureView(items=committed)),
                "asset_ids": [asset.asset_id for asset in assets],
                "added": added,
                "skipped": row["skipped"],
                "total": len(edit.view.items),
            }
            encoded_result = json.dumps(result, ensure_ascii=False)
            receipt = self._decode_receipt(operation_id, encoded_result)
            edit.connection.execute(
                f"UPDATE {IMPORT_TABLE} SET state = ?, result = ? "
                "WHERE project_id = ? AND operation_id = ?",
                (ImportState.COMPLETED.value, encoded_result, project_id, operation_id),
            )
            return receipt
