"""User-level literature repository and its project-scoped projections."""

from __future__ import annotations

import builtins
import json
import math
import sqlite3
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass, fields, replace
from enum import Enum
from pathlib import Path
from typing import Any, Iterator

from service.literature.domain.model import (
    COLLECTION_CYCLE,
    COLLECTION_NAME_REQUIRED,
    COLLECTION_NOT_FOUND,
    COLLECTION_PARENT_INVALID,
    IMPORT_COLLECTION_UNAVAILABLE,
    LIBRARY_INVALID,
    LIBRARY_UNAVAILABLE,
    NOTE_BODY_REQUIRED,
    NOTE_NOT_FOUND,
    NOTE_TITLE_REQUIRED,
    NOTE_VERSION_CONFLICT,
    LiteratureError,
)
from service.literature.schema import (
    BINARY_MEDIA_TYPE,
    PDF_MEDIA_TYPE,
    AttachmentFile,
    AttachmentRole,
    DeletedAttachment,
    FulltextStatus,
    LiteratureAttachment,
    LiteratureCollection,
    LiteratureItem,
    LiteratureNote,
    LiteratureView,
    PublicationType,
)
from service.paths import SERVICE_LITERATURE_DATABASE

LITERATURE_DB = SERVICE_LITERATURE_DATABASE
LIBRARY_RELATIVE_PATH = str(LITERATURE_DB)
# 一行 = 一份文献独占的文件: path 恒为托管目录里的副本, revision 是这批字节的
# 内容修订号 (全文索引缓存的键)。没有 asset_id / project_id —— 附件不指向项目
# 里的文件, 因此文献删除就一定连文件一起删, 不存在"文件还挂在别处"的状态。
ATTACHMENT_COLUMNS = "(id TEXT PRIMARY KEY,literature_id TEXT NOT NULL REFERENCES literature_items(id) ON DELETE CASCADE,name TEXT NOT NULL,path TEXT NOT NULL,revision TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT 'file',role TEXT NOT NULL,media_type TEXT NOT NULL,created_at REAL NOT NULL)"
ATTACHMENT_DDL = f"CREATE TABLE IF NOT EXISTS literature_attachments{ATTACHMENT_COLUMNS};"
PRIMARY_ATTACHMENT_INDEX = "literature_primary_attachment"
DDL = (
    """CREATE TABLE IF NOT EXISTS literature_items(id TEXT PRIMARY KEY,citation_key TEXT NOT NULL DEFAULT '',item_type TEXT NOT NULL,bib_type TEXT NOT NULL,title TEXT NOT NULL,subtitle TEXT NOT NULL DEFAULT '',authors TEXT NOT NULL DEFAULT '',publication TEXT NOT NULL DEFAULT '',year INTEGER,published_date TEXT NOT NULL DEFAULT '',abstract TEXT NOT NULL DEFAULT '',doi TEXT NOT NULL DEFAULT '',arxiv TEXT NOT NULL DEFAULT '',isbn TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',volume TEXT NOT NULL DEFAULT '',number TEXT NOT NULL DEFAULT '',pages TEXT NOT NULL DEFAULT '',publisher TEXT NOT NULL DEFAULT '',address TEXT NOT NULL DEFAULT '',fulltext TEXT NOT NULL DEFAULT 'none',created_at REAL NOT NULL,updated_at REAL NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS literature_collections(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE,project_id TEXT,parent_id TEXT REFERENCES literature_collections(id) ON DELETE RESTRICT,created_at REAL NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS literature_collection_sibling_names ON literature_collections(COALESCE(project_id,''),COALESCE(parent_id,''),name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS literature_collection_items(collection_id TEXT REFERENCES literature_collections(id) ON DELETE CASCADE,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,PRIMARY KEY(collection_id,literature_id));
CREATE TABLE IF NOT EXISTS literature_tags(id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE UNIQUE,color TEXT NOT NULL DEFAULT '',created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS literature_item_tags(literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,tag_id TEXT REFERENCES literature_tags(id) ON DELETE CASCADE,PRIMARY KEY(literature_id,tag_id));
CREATE TABLE IF NOT EXISTS literature_projects(project_id TEXT,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,created_at REAL NOT NULL,PRIMARY KEY(project_id,literature_id));
CREATE TABLE IF NOT EXISTS literature_notes(id TEXT,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at REAL NOT NULL,title TEXT NOT NULL DEFAULT '',updated_at REAL NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(literature_id,id));
"""
    + ATTACHMENT_DDL
)

ITEMS_KEY = "items"
COLLECTIONS_KEY = "collections"
JSON_INDENT = 2
PRIMARY_ATTACHMENT_SUFFIX = ":primary"
DEFAULT_ATTACHMENT_NAME = "附件"
PDF_ATTACHMENT_KIND = "pdf"
DEFAULT_NOTE_TITLE_PREFIX = "笔记"
NOTE_MIGRATION_COLUMNS = {
    "title": "TEXT NOT NULL DEFAULT ''",
    "updated_at": "REAL NOT NULL DEFAULT 0",
    "version": "INTEGER NOT NULL DEFAULT 1",
    "position": "INTEGER NOT NULL DEFAULT 0",
}

SORT_ASCENDING = "ASC"
SORT_DESCENDING = "DESC"
#: 列表原始序：新增时间倒序，同一时间按 id 收敛。附件排序的次级键复用它，
#: 这样「有附件的整组提前」之后组内仍是用户在未排序列表里看到的顺序。
DEFAULT_SORT_KEY = "created_at"
DEFAULT_SORT_COLUMN = "i.created_at"
DEFAULT_SORT_DIRECTION = SORT_DESCENDING
#: 所有排序共用的稳定兜底键，避免同值行的顺序随查询计划漂移。
ROW_TIEBREAK = f"i.id {SORT_ASCENDING}"
#: 「最近」窗口的长度。列表、计数与标签 facet 共用同一份定义。
RECENT_WINDOW_SECONDS = 7 * 86400
#: 曲别针列的排序键。
ATTACHMENT_SORT_KEY = "attachment"
ATTACHMENT_PRESENT = 0
ATTACHMENT_ABSENT = 1
ATTACHMENT_SORT_COLUMN = (
    "CASE WHEN EXISTS (SELECT 1 FROM literature_attachments a WHERE a.literature_id=i.id)"
    f" THEN {ATTACHMENT_PRESENT} ELSE {ATTACHMENT_ABSENT} END"
)
#: 可排序列 → SQL 表达式。不可排序的键落到原始序，与既有行为一致。
SORT_COLUMNS = {
    "title": "i.title",
    "citation_key": "i.citation_key",
    "item_type": "i.item_type",
    "bib_type": "i.bib_type",
    "subtitle": "i.subtitle",
    "creator": "i.authors",
    "publication": "i.publication",
    "year": "i.year",
    "published_date": "i.published_date",
    "doi": "i.doi",
    "arxiv": "i.arxiv",
    "isbn": "i.isbn",
    "url": "i.url",
    "volume": "i.volume",
    "number": "i.number",
    "pages": "i.pages",
    "publisher": "i.publisher",
    "address": "i.address",
    "created_at": "i.created_at",
    "updated_at": "i.updated_at",
}


def _sort_direction(order: str) -> str:
    """把 API 的 order 参数翻译成 SQL 方向。"""

    return SORT_ASCENDING if order == "asc" else SORT_DESCENDING


def _order_by(sort: str, order: str) -> str:
    """构造列表 ORDER BY 子句。

    附件排序只有「有 / 没有」两个值，因此次级键必须是原始序而不是全局 id 兜底，
    否则组内顺序会被 id 重排、和用户在默认列表里看到的不一致。
    """

    direction = _sort_direction(order)
    if sort == ATTACHMENT_SORT_KEY:
        return (
            f"{ATTACHMENT_SORT_COLUMN} {direction},"
            f"{DEFAULT_SORT_COLUMN} {DEFAULT_SORT_DIRECTION},{ROW_TIEBREAK}"
        )
    column = SORT_COLUMNS.get(sort, DEFAULT_SORT_COLUMN)
    return f"{column} {direction},{ROW_TIEBREAK}"


def _json_value(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, tuple):
        return [_json_value(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {key: _json_value(item) for key, item in asdict(value).items()}
    return value


def _records(raw: object, model: type, identity: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(raw, list) or any(not isinstance(entry, dict) for entry in raw):
        raise LiteratureError(LIBRARY_INVALID)
    supported = {field.name for field in fields(model)}
    identities: set[str] = set()
    result: list[dict[str, Any]] = []
    for entry in raw:
        key = entry.get(identity)
        if not isinstance(key, str) or not key or key in identities or set(entry) - supported:
            raise LiteratureError(LIBRARY_INVALID)
        identities.add(key)
        result.append(entry)
    return tuple(result)


def _finite(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise LiteratureError(LIBRARY_INVALID)
    return float(value)


def _note(payload: dict[str, Any]) -> LiteratureNote:
    return LiteratureNote(
        id=str(payload["id"]),
        text=str(payload.get("text", "")),
        created_at=_finite(payload.get("created_at", 0)),
        title=str(payload.get("title", "")),
        updated_at=_finite(payload.get("updated_at", payload.get("created_at", 0))),
        version=int(payload.get("version", 1)),
        position=int(payload.get("position", 0)),
    )


def _item_from_payload(payload: dict[str, Any]) -> LiteratureItem:
    year = payload.get("year")
    if year is not None and type(year) is not int:
        raise LiteratureError(LIBRARY_INVALID)
    values = dict(payload)
    values["fulltext"] = FulltextStatus(str(values.get("fulltext", FulltextStatus.NONE.value)))
    values["pubtype"] = PublicationType(str(values.get("pubtype", PublicationType.MISC.value)))
    values["year"] = year
    values["has_pdf"] = bool(values.get("has_pdf", False))
    for key in ("tags", "collections"):
        raw = values.get(key, ())
        if not isinstance(raw, (list, tuple)) or any(not isinstance(item, str) for item in raw):
            raise LiteratureError(LIBRARY_INVALID)
        values[key] = tuple(raw)
    values["notes"] = tuple(
        _note(entry) for entry in _records(values.get("notes", []), LiteratureNote, "id")
    )
    for key in ("added_at", "updated_at"):
        values[key] = _finite(values.get(key, 0))
    try:
        return LiteratureItem(**values)
    except (KeyError, TypeError, ValueError) as error:
        raise LiteratureError(LIBRARY_INVALID) from error


def _collection_names(item: LiteratureItem) -> tuple[str, ...]:
    """Reconcile the legacy primary collection with the global multi-value relation."""

    stored_primary = item.collections[0] if item.collections else ""
    if item.collection != stored_primary:
        return (item.collection,) if item.collection else ()
    return tuple(dict.fromkeys(item.collections))


def _collection_scope(project_id: str) -> str | None:
    """Map the public empty global scope to its persisted NULL identity."""

    return project_id or None


def _recent_window(sql: str, args: builtins.list[Any]) -> str:
    """把「最近」窗口追加到 `_selection` 的产物上, 并按引用补一个绑定参数。

    必须由调用方在 `_selection` 返回之后再追加: 那段 sql 以 `FROM` 开头, 外层还要
    接 `SELECT` 前缀、`ORDER BY` 与分页, 把窗口条件提前塞进去就会拼出非法 SQL。
    """

    sql += " AND i.created_at >= ?" if " WHERE " in sql else " WHERE i.created_at >= ?"
    args.append(time.time() - RECENT_WINDOW_SECONDS)
    return sql


def encode(view: LiteratureView) -> str:
    payload = {
        ITEMS_KEY: [_json_value(item) for item in view.items],
        COLLECTIONS_KEY: [_json_value(item) for item in view.collections],
    }
    try:
        result = json.dumps(payload, ensure_ascii=False, indent=JSON_INDENT, allow_nan=False)
        decode(result)
        return result
    except (TypeError, ValueError) as error:
        raise LiteratureError(LIBRARY_INVALID) from error


def decode(source: str) -> LiteratureView:
    try:
        raw = json.loads(source)
        if not isinstance(raw, dict) or set(raw) - {ITEMS_KEY, COLLECTIONS_KEY}:
            raise LiteratureError(LIBRARY_INVALID)
        items = tuple(
            _item_from_payload(entry)
            for entry in _records(raw.get(ITEMS_KEY, []), LiteratureItem, "id")
        )
        collections = tuple(
            LiteratureCollection(**entry)
            for entry in _records(raw.get(COLLECTIONS_KEY, []), LiteratureCollection, "name")
        )
        return LiteratureView(items=items, collections=collections)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise LiteratureError(LIBRARY_INVALID) from error


def connect(database: Path | str = LITERATURE_DB) -> sqlite3.Connection:
    target = Path(database)
    target.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(DDL)
    _migrate_notes(conn)
    _require_final_schema(conn)
    conn.execute("DROP INDEX IF EXISTS literature_global_collection_names")
    conn.execute("DROP INDEX IF EXISTS literature_project_collection_names")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS literature_collection_sibling_names "
        "ON literature_collections(COALESCE(project_id,''),COALESCE(parent_id,''),"
        "name COLLATE NOCASE)"
    )
    conn.execute(
        f"CREATE UNIQUE INDEX IF NOT EXISTS {PRIMARY_ATTACHMENT_INDEX} "
        "ON literature_attachments(literature_id) WHERE role='primary'"
    )
    return conn


def _migrate_notes(conn: sqlite3.Connection) -> None:
    """Add structured note fields without rebuilding or discarding user notes."""

    columns = {row[1] for row in conn.execute("PRAGMA table_info(literature_notes)")}
    added: set[str] = set()
    for column, declaration in NOTE_MIGRATION_COLUMNS.items():
        if column in columns:
            continue
        conn.execute(f"ALTER TABLE literature_notes ADD COLUMN {column} {declaration}")
        added.add(column)
    if not added:
        return
    rows = conn.execute(
        "SELECT rowid,literature_id,created_at FROM literature_notes "
        "ORDER BY literature_id,created_at,rowid"
    ).fetchall()
    positions: dict[str, int] = {}
    for row in rows:
        literature_id = str(row["literature_id"])
        position = positions.get(literature_id, 0) + 1
        positions[literature_id] = position
        assignments: list[str] = []
        values: list[Any] = []
        if "title" in added:
            assignments.append("title=?")
            values.append(f"{DEFAULT_NOTE_TITLE_PREFIX} {position}")
        if "updated_at" in added:
            assignments.append("updated_at=?")
            values.append(float(row["created_at"]))
        if "version" in added:
            assignments.append("version=1")
        if "position" in added:
            assignments.append("position=?")
            values.append(position)
        values.append(int(row["rowid"]))
        conn.execute(
            f"UPDATE literature_notes SET {','.join(assignments)} WHERE rowid=?",
            values,
        )


def _require_final_schema(conn: sqlite3.Connection) -> None:
    """Reject an uncut database; ordinary repository access never destroys user data."""

    item_columns = {row[1] for row in conn.execute("PRAGMA table_info(literature_items)")}
    attachment_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(literature_attachments)")
    }
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if (
        {"pdf_path", "pdf_asset_id"} & item_columns
        or {"literature_marks", "literature_reading_records"} & tables
        or (attachment_columns and {"role", "media_type", "revision"} - attachment_columns)
    ):
        raise LiteratureError(LIBRARY_INVALID)


class LiteratureRepository:
    def __init__(self, database: Path | str = LITERATURE_DB):
        self.database = Path(database)

    def list(
        self,
        q: str = "",
        project_id: str = "",
        collection_ids: tuple[str, ...] = (),
        tag_ids: tuple[str, ...] = (),
        without_collection: bool = False,
        without_project: bool = False,
        sort: str = DEFAULT_SORT_KEY,
        order: str = "desc",
        limit: int = 200,
        offset: int = 0,
        recent_only: bool = False,
    ) -> tuple[LiteratureItem, ...]:
        sql, args = self._selection(
            q=q,
            project_id=project_id,
            collection_ids=collection_ids,
            tag_ids=tag_ids,
            without_collection=without_collection,
            without_project=without_project,
        )
        if recent_only:
            sql = _recent_window(sql, args)
        sql = f"SELECT DISTINCT i.* {sql} ORDER BY {_order_by(sort, order)} LIMIT ? OFFSET ?"
        args.extend((limit, offset))
        with connect(self.database) as c:
            return tuple(self._item(c, r, project_id) for r in c.execute(sql, args))

    def filtered_total(
        self,
        q: str = "",
        project_id: str = "",
        collection_ids: tuple[str, ...] = (),
        tag_ids: tuple[str, ...] = (),
        without_collection: bool = False,
        without_project: bool = False,
        recent_only: bool = False,
    ) -> int:
        sql, args = self._selection(
            q=q,
            project_id=project_id,
            collection_ids=collection_ids,
            tag_ids=tag_ids,
            without_collection=without_collection,
            without_project=without_project,
        )
        if recent_only:
            sql = _recent_window(sql, args)
        with connect(self.database) as c:
            return int(c.execute(f"SELECT count(DISTINCT i.id) {sql}", args).fetchone()[0])

    @staticmethod
    def _selection(
        q: str,
        project_id: str,
        collection_ids: tuple[str, ...],
        tag_ids: tuple[str, ...],
        without_collection: bool,
        without_project: bool = False,
    ) -> tuple[str, builtins.list[Any]]:
        sql = "FROM literature_items i"
        args: builtins.list[Any] = []
        where: builtins.list[str] = []
        if project_id:
            sql += " JOIN literature_projects p ON p.literature_id=i.id"
            where.append("p.project_id=?")
            args.append(project_id)
        if without_project:
            where.append(
                "NOT EXISTS (SELECT 1 FROM literature_projects p WHERE p.literature_id=i.id)"
            )
        if collection_ids:
            placeholders = ",".join("?" for _ in collection_ids)
            sql += (
                " JOIN literature_collection_items ci ON ci.literature_id=i.id"
                " JOIN literature_collections c ON c.id=ci.collection_id"
            )
            where.append(
                "ci.collection_id IN (WITH RECURSIVE selected(id) AS ("
                f"SELECT id FROM literature_collections WHERE id IN ({placeholders}) "
                "UNION ALL SELECT child.id FROM literature_collections child "
                "JOIN selected parent ON child.parent_id=parent.id"
                ") SELECT id FROM selected)"
            )
            args.extend(collection_ids)
            if project_id:
                where.append("c.project_id=?")
                args.append(project_id)
            else:
                where.append("c.project_id IS NULL")
        elif without_collection:
            collection_scope = (
                "c.project_id=?"
                if project_id
                else "1=1" if without_project else "c.project_id IS NULL"
            )
            where.append(
                "NOT EXISTS (SELECT 1 FROM literature_collection_items ci "
                "JOIN literature_collections c ON c.id=ci.collection_id "
                f"WHERE ci.literature_id=i.id AND {collection_scope})"
            )
            if project_id:
                args.append(project_id)
        if tag_ids:
            # 多标签取交集: 命中的不同标签数必须等于请求的标签数。写成相关子查询
            # 而不是 JOIN + GROUP BY, 因为本函数返回的 sql 之后还要被调用方接上
            # 「最近」窗口与 ORDER BY / 分页, GROUP BY 夹在中间会把这些条件挤到
            # 非法位置; 子查询也不会让外层行翻倍, 已有的 DISTINCT 因此保持幂等。
            placeholders = ",".join("?" for _ in tag_ids)
            where.append(
                "(SELECT count(DISTINCT matched.tag_id) FROM literature_item_tags matched "
                "WHERE matched.literature_id=i.id "
                f"AND matched.tag_id IN ({placeholders})) = ?"
            )
            args.extend(tag_ids)
            args.append(len(tag_ids))
        if q:
            where.append(
                "(i.title LIKE ? OR i.authors LIKE ? OR i.publication LIKE ? "
                "OR i.doi LIKE ? OR CAST(i.year AS TEXT) LIKE ?)"
            )
            args.extend((f"%{q}%",) * 5)
        if where:
            sql += " WHERE " + " AND ".join(where)
        return sql, args

    def get(self, key: str) -> LiteratureItem | None:
        with connect(self.database) as c:
            row = c.execute("SELECT * FROM literature_items WHERE id=?", (key,)).fetchone()
            return self._item(c, row, "") if row else None

    def notes(self, literature_id: str) -> tuple[LiteratureNote, ...] | None:
        with connect(self.database) as connection:
            if (
                connection.execute(
                    "SELECT 1 FROM literature_items WHERE id=?", (literature_id,)
                ).fetchone()
                is None
            ):
                return None
            return self._notes(connection, literature_id)

    def create_note(self, literature_id: str, text: str, title: str = "") -> LiteratureNote:
        body = text.strip()
        if not body:
            raise LiteratureError(NOTE_BODY_REQUIRED)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT 1 FROM literature_items WHERE id=?", (literature_id,)
                ).fetchone()
                is None
            ):
                raise LiteratureError(NOTE_NOT_FOUND)
            existing_titles = {
                str(row[0])
                for row in connection.execute(
                    "SELECT title FROM literature_notes WHERE literature_id=?", (literature_id,)
                )
            }
            position = int(
                connection.execute(
                    "SELECT COALESCE(MAX(position),0)+1 FROM literature_notes WHERE literature_id=?",
                    (literature_id,),
                ).fetchone()[0]
            )
            resolved_title = title.strip()
            if not resolved_title:
                sequence = 1
                while f"{DEFAULT_NOTE_TITLE_PREFIX} {sequence}" in existing_titles:
                    sequence += 1
                resolved_title = f"{DEFAULT_NOTE_TITLE_PREFIX} {sequence}"
            now = time.time()
            note = LiteratureNote(
                id=str(uuid.uuid4()),
                text=body,
                created_at=now,
                title=resolved_title,
                updated_at=now,
                version=1,
                position=position,
            )
            connection.execute(
                "INSERT INTO literature_notes"
                "(id,literature_id,text,created_at,title,updated_at,version,position) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    note.id,
                    literature_id,
                    note.text,
                    note.created_at,
                    note.title,
                    note.updated_at,
                    note.version,
                    note.position,
                ),
            )
            connection.execute(
                "UPDATE literature_items SET updated_at=?,version=version+1 WHERE id=?",
                (now, literature_id),
            )
            return note

    def update_note(
        self,
        literature_id: str,
        note_id: str,
        *,
        title: str,
        text: str,
        expected_version: int,
    ) -> LiteratureNote:
        resolved_title = title.strip()
        body = text.strip()
        if not resolved_title:
            raise LiteratureError(NOTE_TITLE_REQUIRED)
        if not body:
            raise LiteratureError(NOTE_BODY_REQUIRED)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM literature_notes WHERE literature_id=? AND id=?",
                (literature_id, note_id),
            ).fetchone()
            if row is None:
                raise LiteratureError(NOTE_NOT_FOUND)
            if int(row["version"]) != expected_version:
                raise LiteratureError(NOTE_VERSION_CONFLICT)
            now = time.time()
            version = expected_version + 1
            connection.execute(
                "UPDATE literature_notes SET title=?,text=?,updated_at=?,version=? "
                "WHERE literature_id=? AND id=?",
                (resolved_title, body, now, version, literature_id, note_id),
            )
            connection.execute(
                "UPDATE literature_items SET updated_at=?,version=version+1 WHERE id=?",
                (now, literature_id),
            )
            return LiteratureNote(
                id=note_id,
                text=body,
                created_at=float(row["created_at"]),
                title=resolved_title,
                updated_at=now,
                version=version,
                position=int(row["position"]),
            )

    def delete_note(self, literature_id: str, note_id: str) -> bool:
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            removed = connection.execute(
                "DELETE FROM literature_notes WHERE literature_id=? AND id=?",
                (literature_id, note_id),
            ).rowcount
            if not removed:
                return False
            now = time.time()
            connection.execute(
                "UPDATE literature_items SET updated_at=?,version=version+1 WHERE id=?",
                (now, literature_id),
            )
            return True

    def update(
        self,
        key: str,
        fields: dict[str, Any],
        collection_ids: tuple[str, ...] | None = None,
        tag_ids: tuple[str, ...] | None = None,
    ) -> LiteratureItem | None:
        """Update editable metadata and global organization in one transaction."""

        columns = {
            "citation_key",
            "item_type",
            "bib_type",
            "title",
            "subtitle",
            "authors",
            "publication",
            "year",
            "published_date",
            "abstract",
            "doi",
            "arxiv",
            "isbn",
            "url",
            "volume",
            "number",
            "pages",
            "publisher",
            "address",
        }
        if set(fields) - columns:
            raise LiteratureError(LIBRARY_INVALID)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute("SELECT 1 FROM literature_items WHERE id=?", (key,)).fetchone()
                is None
            ):
                return None
            if fields:
                assignments = ",".join(f"{column}=?" for column in fields)
                connection.execute(
                    f"UPDATE literature_items SET {assignments},updated_at=?,version=version+1 "
                    "WHERE id=?",
                    (*fields.values(), time.time(), key),
                )
            if collection_ids is not None:
                self._replace_relations(
                    connection,
                    key,
                    "literature_collections",
                    "literature_collection_items",
                    "collection_id",
                    collection_ids,
                    "project_id IS NULL",
                    "collection_id IN (SELECT id FROM literature_collections "
                    "WHERE project_id IS NULL)",
                )
            if tag_ids is not None:
                self._replace_relations(
                    connection,
                    key,
                    "literature_tags",
                    "literature_item_tags",
                    "tag_id",
                    tag_ids,
                )
            if not fields and (collection_ids is not None or tag_ids is not None):
                connection.execute(
                    "UPDATE literature_items SET updated_at=?,version=version+1 WHERE id=?",
                    (time.time(), key),
                )
            return self._item_by_id(connection, key, "")

    @staticmethod
    def _replace_relations(
        connection: sqlite3.Connection,
        literature_id: str,
        dimension_table: str,
        relation_table: str,
        dimension_column: str,
        identifiers: tuple[str, ...],
        dimension_scope: str = "1=1",
        relation_scope: str = "1=1",
    ) -> None:
        unique_ids = tuple(dict.fromkeys(identifiers))
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            valid_ids = {
                str(row[0])
                for row in connection.execute(
                    f"SELECT id FROM {dimension_table} "
                    f"WHERE id IN ({placeholders}) AND {dimension_scope}",
                    unique_ids,
                )
            }
            if valid_ids != set(unique_ids):
                raise LiteratureError(LIBRARY_INVALID)
        connection.execute(
            f"DELETE FROM {relation_table} WHERE literature_id=? AND {relation_scope}",
            (literature_id,),
        )
        connection.executemany(
            f"INSERT INTO {relation_table}(literature_id,{dimension_column}) VALUES(?,?)",
            ((literature_id, identifier) for identifier in unique_ids),
        )

    def total(self) -> int:
        with connect(self.database) as c:
            return int(c.execute("SELECT count(*) FROM literature_items").fetchone()[0])

    def attachments(self, literature_id: str) -> builtins.list[dict[str, Any]]:
        with connect(self.database) as connection:
            return [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM literature_attachments WHERE literature_id=? "
                    "ORDER BY role='primary' DESC,created_at,id",
                    (literature_id,),
                )
            ]

    def attachment(self, literature_id: str, attachment_id: str) -> LiteratureAttachment | None:
        with connect(self.database) as connection:
            row = connection.execute(
                "SELECT * FROM literature_attachments WHERE id=? AND literature_id=?",
                (attachment_id, literature_id),
            ).fetchone()
        if row is None:
            return None
        return LiteratureAttachment(
            id=str(row["id"]),
            literature_id=str(row["literature_id"]),
            name=str(row["name"]),
            path=str(row["path"]),
            revision=str(row["revision"]),
            kind=str(row["kind"]),
            role=AttachmentRole(str(row["role"])),
            media_type=str(row["media_type"]),
            created_at=float(row["created_at"]),
        )

    def replace_attachment_location(
        self,
        literature_id: str,
        attachment_id: str,
        expected_path: str,
        path: str,
        revision: str,
        media_type: str,
        kind: str,
    ) -> bool:
        """CAS one attachment row onto a newly published file it now owns.

        ``revision`` 必须与 ``path`` 一起换: 它描述的就是这个文件里的字节, 留下旧值
        会让删除时忘掉的是别人那份索引。
        """

        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                "UPDATE literature_attachments SET path=?,revision=?,media_type=?,kind=? "
                "WHERE id=? AND literature_id=? AND path=?",
                (path, revision, media_type, kind, attachment_id, literature_id, expected_path),
            )
            return cursor.rowcount == 1

    def primary_attachment(self, literature_id: str) -> LiteratureAttachment | None:
        with connect(self.database) as connection:
            row = connection.execute(
                "SELECT id FROM literature_attachments "
                "WHERE literature_id=? AND role=? ORDER BY created_at DESC,id LIMIT 1",
                (literature_id, AttachmentRole.PRIMARY.value),
            ).fetchone()
        return self.attachment(literature_id, str(row["id"])) if row else None

    def attachment_files(self, literature_id: str) -> tuple[tuple[str, str], ...]:
        """Return ``(path, revision)`` of every file this item owns.

        删除文献时要在删行之前取走这两样: 文件要 unlink, revision 要拿去清掉派生
        的全文索引缓存 —— 行一删, 库里就再没有第二处记着这份字节的修订号。
        """

        with connect(self.database) as connection:
            return tuple(
                (str(row[0]), str(row[1]))
                for row in connection.execute(
                    "SELECT path,revision FROM literature_attachments "
                    "WHERE literature_id=? AND path<>'' ORDER BY id",
                    (literature_id,),
                )
            )

    def has_attachment_path(self, path: str) -> bool:
        with connect(self.database) as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM literature_attachments WHERE path=? LIMIT 1",
                    (path,),
                ).fetchone()
                is not None
            )

    def delete_attachment(self, literature_id: str, attachment_id: str) -> DeletedAttachment | None:
        """Drop one attachment row and converge the item state it fed, atomically.

        Annotation records follow through the row's ``ON DELETE CASCADE``. Losing
        the primary attachment also means the item no longer has readable full
        text, so ``fulltext`` falls back to ``none`` inside the same transaction:
        leaving it at its old value keeps the without-fulltext counts and filters
        lying, and the next metadata save would re-persist the stale value on top
        of it. The physical file and any full-text index derived from it are owned
        outside this transaction and are reported back through the return value.
        """
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT path,revision,role FROM literature_attachments "
                "WHERE id=? AND literature_id=?",
                (attachment_id, literature_id),
            ).fetchone()
            if row is None:
                return None
            role = AttachmentRole(str(row["role"]))
            connection.execute("DELETE FROM literature_attachments WHERE id=?", (attachment_id,))
            if role is AttachmentRole.PRIMARY:
                connection.execute(
                    "UPDATE literature_items SET fulltext=? WHERE id=?",
                    (FulltextStatus.NONE.value, literature_id),
                )
            return DeletedAttachment(
                literature_id=literature_id,
                attachment_id=attachment_id,
                path=str(row["path"]),
                revision=str(row["revision"]),
                role=role,
            )

    def add_attachment(
        self,
        literature_id: str,
        name: str,
        path: str,
        kind: str = "file",
        *,
        revision: str,
        role: AttachmentRole = AttachmentRole.SUPPLEMENTARY,
        media_type: str = BINARY_MEDIA_TYPE,
        attachment_id: str = "",
        connection: sqlite3.Connection | None = None,
    ) -> dict[str, Any]:
        """Bind one owned file to an item.

        ``revision`` 是必填关键字: 写行的这一刻是唯一还握有字节、能算出内容修订号
        的时机, 漏了它就等于让这条附件的全文索引永远清不掉。
        """

        attachment_id = attachment_id or str(uuid.uuid4())
        now = time.time()

        def insert(current: sqlite3.Connection) -> None:
            if role is AttachmentRole.PRIMARY:
                current.execute(
                    "UPDATE literature_attachments SET role=? WHERE literature_id=? AND role=?",
                    (
                        AttachmentRole.SUPPLEMENTARY.value,
                        literature_id,
                        AttachmentRole.PRIMARY.value,
                    ),
                )
            current.execute(
                "INSERT INTO literature_attachments"
                "(id,literature_id,name,path,revision,kind,role,media_type,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    attachment_id,
                    literature_id,
                    name,
                    path,
                    revision,
                    kind,
                    role.value,
                    media_type,
                    now,
                ),
            )
            # 与 delete_attachment 对称: 得到一份可读的主 PDF 就意味着全文就位,
            # 条目的 fulltext 必须在同一个事务里跟上, 否则「无全文」计数与筛选
            # 会对一条明明挂着主附件的文献撒谎。产品规则是主附件只允许 PDF
            # (见 attachments 上传路由的校验), 因此这里按 media_type 收口。
            if role is AttachmentRole.PRIMARY and media_type == PDF_MEDIA_TYPE:
                current.execute(
                    "UPDATE literature_items SET fulltext=? WHERE id=?",
                    (FulltextStatus.READY.value, literature_id),
                )

        if connection is None:
            with connect(self.database) as current:
                current.execute("BEGIN IMMEDIATE")
                insert(current)
        else:
            insert(connection)
        return {
            "id": attachment_id,
            "literature_id": literature_id,
            "name": name,
            "path": path,
            "revision": revision,
            "kind": kind,
            "role": role.value,
            "media_type": media_type,
            "created_at": now,
        }

    def save(
        self,
        item: LiteratureItem,
        project_id: str = "",
        connection: sqlite3.Connection | None = None,
    ) -> LiteratureItem:
        if connection is not None:
            self._save(connection, item, project_id)
            return self._item_by_id(connection, item.id, project_id)
        with connect(self.database) as current:
            self._save(current, item, project_id)
            return self._item_by_id(current, item.id, project_id)

    def save_all(
        self,
        items: tuple[LiteratureItem, ...],
        *,
        collection_id: str = "",
        project_id: str = "",
    ) -> tuple[LiteratureItem, ...]:
        """Persist one admitted batch atomically.

        文献库不做重复判定（proposal 91）：调用方交进来的每条都是一个新 id，
        这里只负责追加，不存在"命中既存条目就跳过/合并"的分支。
        """

        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                collection_id
                and not connection.execute(
                    "SELECT id FROM literature_collections WHERE id=? AND project_id IS ?",
                    (collection_id, _collection_scope(project_id)),
                ).fetchone()
            ):
                raise LiteratureError(IMPORT_COLLECTION_UNAVAILABLE)
            for item in items:
                self._save(connection, item, project_id)
                if project_id:
                    connection.execute(
                        "INSERT OR IGNORE INTO literature_projects VALUES(?,?,?)",
                        (project_id, item.id, time.time()),
                    )
                if collection_id:
                    connection.execute(
                        "INSERT OR IGNORE INTO literature_collection_items VALUES(?,?)",
                        (collection_id, item.id),
                    )
            return tuple(self._item_by_id(connection, item.id, project_id) for item in items)

    def save_external_tree(
        self,
        items: tuple[LiteratureItem, ...],
        collections: tuple[tuple[str, str, str | None], ...],
        memberships: tuple[tuple[str, str], ...],
        attachments: tuple[AttachmentFile, ...] = (),
        project_id: str = "",
        target_collection_id: str = "",
    ) -> tuple[LiteratureItem, ...]:
        """Persist items and an already validated external collection tree atomically.

        ``attachments`` carries the already published per-item file copies.
        ``target_collection_id`` is the landing collection the caller is looking at:
        the external tree is re-parented under it and items no external collection
        claimed become its direct members.

        两层身份刻意不同（proposal 91）：

        * 文献条目一律追加。同步两次 Zotero 就是两份条目，是否重复由用户判断，
          这里不做任何"已存在就跳过"的探测。
        * 分类树仍按外部键 ``zotero:<project>:<key>`` 就地更新。分类 id 用的是
          Zotero 自己的 collection key，不是元数据匹配；若一并追加，每次同步都会
          复制整套文件夹层级，那是结构性损坏，不是"文献重复"。

        每条附件都是这条文献独占的一份文件，重复条目各存各的字节；删条目就删文件，
        不需要任何跨条目的引用计数。
        """

        namespace = f"{project_id}:" if project_id else ""
        external_ids = {key: f"zotero:{namespace}{key}" for key, _name, _parent in collections}
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                target_collection_id
                and not connection.execute(
                    "SELECT id FROM literature_collections WHERE id=? AND project_id IS ?",
                    (target_collection_id, _collection_scope(project_id)),
                ).fetchone()
            ):
                raise LiteratureError(IMPORT_COLLECTION_UNAVAILABLE)
            for item in items:
                self._save(connection, replace(item, collections=(), collection=""), project_id)
            now = time.time()
            for key, name, parent_key in collections:
                identifier = external_ids[key]
                # 外部树在本作用域内的根挂到导入落点下面: 「落入当前分类」与
                # 「保留 Zotero 层级」同时成立, 而不是让两套分类并列成兄弟。
                parent_id = external_ids.get(parent_key) if parent_key else None
                if parent_id is None:
                    parent_id = target_collection_id or None
                existing = connection.execute(
                    "SELECT id FROM literature_collections WHERE id=?", (identifier,)
                ).fetchone()
                if existing:
                    connection.execute(
                        "UPDATE literature_collections SET name=?,parent_id=? WHERE id=?",
                        (name, parent_id, identifier),
                    )
                else:
                    connection.execute(
                        "INSERT INTO literature_collections "
                        "(id,name,project_id,parent_id,created_at) VALUES(?,?,?,?,?)",
                        (
                            identifier,
                            name,
                            _collection_scope(project_id),
                            parent_id,
                            now,
                        ),
                    )
            connection.executemany(
                "INSERT OR IGNORE INTO literature_collection_items VALUES(?,?)",
                (
                    (external_ids[collection_key], literature_id)
                    for collection_key, literature_id in memberships
                ),
            )
            if target_collection_id:
                # 没被任何外部分类收下的条目 (未整理文献, 或本次不保留分类结构)
                # 直接落进目标分类。否则它们会停在作用域的「未整理」里, 用户在
                # 自己正看着的分类下看不到刚导入的文献。
                claimed = {literature_id for _collection_key, literature_id in memberships}
                connection.executemany(
                    "INSERT OR IGNORE INTO literature_collection_items VALUES(?,?)",
                    ((target_collection_id, item.id) for item in items if item.id not in claimed),
                )
            for attachment in attachments:
                self.add_attachment(
                    attachment.literature_id,
                    attachment.name or Path(attachment.path).name,
                    attachment.path,
                    PDF_ATTACHMENT_KIND,
                    revision=attachment.revision,
                    role=AttachmentRole.PRIMARY,
                    media_type=PDF_MEDIA_TYPE,
                    connection=connection,
                )
            return tuple(self._item_by_id(connection, item.id, project_id) for item in items)

    def _save(self, c: sqlite3.Connection, item: LiteratureItem, project_id: str) -> None:
        """Write one row by primary key.

        ``ON CONFLICT(id) DO UPDATE`` 在这里**不是**导入去重：id 是 uuid4，导入路径
        永远拿到新主键（proposal 91）。冲突只可能来自调用方显式重写同一行——
        ``replace_view`` 的视图整体回写、题录编辑、批量打标签。因此 `created_at`
        从旧行继承、笔记只在首次插入时写入。
        """

        # Validate every nested record before changing the database.
        decode(encode(LiteratureView(items=(item,))))
        now = time.time()
        old = c.execute("SELECT created_at FROM literature_items WHERE id=?", (item.id,)).fetchone()
        created = float(old[0]) if old else item.added_at or now
        updated = item.updated_at or created
        version = max(item.version, 1)
        values = (
            item.id,
            item.citation_key,
            item.item_type,
            item.pubtype.value,
            item.title,
            item.subtitle,
            item.authors,
            item.venue or item.journal,
            item.year,
            item.published_date,
            item.abstract,
            item.doi,
            item.arxiv,
            item.isbn,
            item.url,
            item.volume,
            item.number,
            item.pages,
            item.publisher,
            item.address,
            item.fulltext.value,
            created,
            updated,
            version,
        )
        c.execute(
            """INSERT INTO literature_items
            (id,citation_key,item_type,bib_type,title,subtitle,authors,publication,year,
             published_date,abstract,doi,arxiv,isbn,url,volume,number,pages,publisher,address,
             fulltext,created_at,updated_at,version)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
             citation_key=excluded.citation_key,item_type=excluded.item_type,
             bib_type=excluded.bib_type,title=excluded.title,subtitle=excluded.subtitle,
             authors=excluded.authors,publication=excluded.publication,year=excluded.year,
             published_date=excluded.published_date,abstract=excluded.abstract,doi=excluded.doi,arxiv=excluded.arxiv,
             isbn=excluded.isbn,url=excluded.url,volume=excluded.volume,number=excluded.number,
             pages=excluded.pages,publisher=excluded.publisher,address=excluded.address,
             fulltext=excluded.fulltext,updated_at=excluded.updated_at,
             version=excluded.version""",
            values,
        )
        c.execute("DELETE FROM literature_item_tags WHERE literature_id=?", (item.id,))
        for name in item.tags:
            c.execute(
                "INSERT OR IGNORE INTO literature_tags VALUES(?,?,?,?)",
                (str(uuid.uuid4()), name, "", now),
            )
            tag = c.execute("SELECT id FROM literature_tags WHERE name=?", (name,)).fetchone()[0]
            c.execute("INSERT INTO literature_item_tags VALUES(?,?)", (item.id, tag))
        scope = _collection_scope(project_id)
        c.execute(
            "DELETE FROM literature_collection_items WHERE literature_id=? AND "
            "collection_id IN (SELECT id FROM literature_collections WHERE project_id IS ?)",
            (item.id, scope),
        )
        for name in _collection_names(item):
            existing_collection = c.execute(
                "SELECT id FROM literature_collections WHERE name=? AND project_id IS ?",
                (name, scope),
            ).fetchone()
            if existing_collection is None:
                collection = str(uuid.uuid4())
                c.execute(
                    "INSERT INTO literature_collections "
                    "(id,name,project_id,parent_id,created_at) VALUES(?,?,?,NULL,?)",
                    (collection, name, scope, now),
                )
            else:
                collection = str(existing_collection[0])
            c.execute("INSERT INTO literature_collection_items VALUES(?,?)", (collection, item.id))
        if old is None:
            c.executemany(
                "INSERT INTO literature_notes"
                "(id,literature_id,text,created_at,title,updated_at,version,position) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    (
                        note.id,
                        item.id,
                        note.text,
                        note.created_at,
                        note.title or f"{DEFAULT_NOTE_TITLE_PREFIX} {index}",
                        note.updated_at or note.created_at,
                        max(note.version, 1),
                        note.position or index,
                    )
                    for index, note in enumerate(item.notes, start=1)
                ),
            )
        if project_id:
            c.execute(
                "INSERT OR IGNORE INTO literature_projects VALUES(?,?,?)",
                (project_id, item.id, now),
            )

    def delete(self, key: str, confirm: bool = False) -> tuple[bool, tuple[str, ...]]:
        with connect(self.database) as c:
            projects = tuple(
                r[0]
                for r in c.execute(
                    "SELECT project_id FROM literature_projects WHERE literature_id=?", (key,)
                )
            )
            return (
                c.execute("DELETE FROM literature_items WHERE id=?", (key,)).rowcount > 0,
                projects,
            )

    def collections(self, project_id: str = "") -> builtins.list[dict[str, Any]]:
        with connect(self.database) as c:
            return [
                dict(r)
                for r in c.execute(
                    "SELECT c.*,count(x.literature_id) count FROM literature_collections c "
                    "LEFT JOIN literature_collection_items x ON x.collection_id=c.id "
                    "WHERE c.project_id IS ? GROUP BY c.id",
                    (_collection_scope(project_id),),
                )
            ]

    def drop_project_links(self, project_id: str) -> int:
        """永久删除项目时物理清理它在全库面的关联, 返回摘掉的行数总和。

        与 `unlink_project` 的区别是生命周期: 归档只隐藏关联 (名称表不解析),
        取消归档要能原样恢复, 所以不能删行; 只有 forget 的清理钩子才走到这里。
        文献条目本身不删 —— 清的是项目关联, 不是用户的文献。
        """

        with connect(self.database) as connection:
            collection_items = connection.execute(
                "DELETE FROM literature_collection_items WHERE collection_id IN "
                "(SELECT id FROM literature_collections WHERE project_id=?)",
                (project_id,),
            ).rowcount
            collections = connection.execute(
                "DELETE FROM literature_collections WHERE project_id=?",
                (project_id,),
            ).rowcount
            links = connection.execute(
                "DELETE FROM literature_projects WHERE project_id=?",
                (project_id,),
            ).rowcount
        return collection_items + collections + links

    def project_navigation(self, project_ids: tuple[str, ...]) -> dict[str, dict[str, Any]]:
        """Project-scoped literature facts, bounded by the caller's identity dimension."""

        if not project_ids:
            return {}
        placeholders = ",".join("?" for _ in project_ids)
        navigation: dict[str, dict[str, Any]] = {
            project_id: {"count": 0, "collections": []} for project_id in project_ids
        }
        with connect(self.database) as c:
            for row in c.execute(
                "SELECT project_id,count(DISTINCT literature_id) count "
                f"FROM literature_projects WHERE project_id IN ({placeholders}) "
                "GROUP BY project_id",
                project_ids,
            ):
                navigation[str(row["project_id"])]["count"] = int(row["count"])
            for row in c.execute(
                "SELECT c.*,count(DISTINCT x.literature_id) count "
                "FROM literature_collections c "
                "LEFT JOIN literature_collection_items x ON x.collection_id=c.id "
                f"WHERE c.project_id IN ({placeholders}) "
                "GROUP BY c.id ORDER BY c.created_at,c.name",
                project_ids,
            ):
                navigation[str(row["project_id"])]["collections"].append(dict(row))
        collection_ids = tuple(
            str(collection["id"])
            for project in navigation.values()
            for collection in project["collections"]
        )
        literature_ids: dict[str, set[str]] = {
            collection_id: set() for collection_id in collection_ids
        }
        if collection_ids:
            collection_placeholders = ",".join("?" for _ in collection_ids)
            with connect(self.database) as c:
                for relation in c.execute(
                    "SELECT collection_id,literature_id FROM literature_collection_items "
                    f"WHERE collection_id IN ({collection_placeholders})",
                    collection_ids,
                ):
                    literature_ids[str(relation["collection_id"])].add(
                        str(relation["literature_id"])
                    )
        for project in navigation.values():
            collections = project["collections"]
            parents = {
                str(collection["id"]): (
                    str(collection["parent_id"]) if collection["parent_id"] is not None else None
                )
                for collection in collections
            }
            project_collection_ids = tuple(parents)
            for collection_id in project_collection_ids:
                direct_ids = set(literature_ids[collection_id])
                visited = {collection_id}
                parent_id = parents[collection_id]
                while (
                    parent_id is not None
                    and parent_id in literature_ids
                    and parent_id not in visited
                ):
                    literature_ids[parent_id].update(direct_ids)
                    visited.add(parent_id)
                    parent_id = parents[parent_id]
            for collection in collections:
                collection["count"] = len(literature_ids[str(collection["id"])])
        return navigation

    def tags(self, project_id: str = "") -> builtins.list[dict[str, Any]]:
        """标签本身是全库实体, 计数按调用方的项目范围收敛。

        空的 project_id 是文献全览, 计全库; 指定项目时只计该项目下的成员关系, 项目内
        文献库的标签计数才不会和全览一样显示所有文献。计数条件放在 LEFT JOIN 的 ON 上
        而不是 WHERE, 项目内计数为 0 的标签仍然列出, 与 collections() 的行为一致。

        total 始终是全库计数: 删除标签是全库操作, 确认框必须用它, 否则在项目内会少报
        实际影响面。
        """

        select = (
            "SELECT t.*,count(x.literature_id) count FROM literature_tags t "
            "LEFT JOIN literature_item_tags x ON x.tag_id=t.id"
        )
        group_by = " GROUP BY t.id ORDER BY t.created_at DESC"
        with connect(self.database) as c:
            library_rows = [dict(row) for row in c.execute(f"{select}{group_by}")]
            for row in library_rows:
                row["total"] = row["count"]
            if not project_id:
                return library_rows
            library_counts = {row["id"]: row["total"] for row in library_rows}
            scoped = c.execute(
                f"{select} AND x.literature_id IN "
                "(SELECT literature_id FROM literature_projects WHERE project_id=?)"
                f"{group_by}",
                (project_id,),
            )
            rows = []
            for row in scoped:
                entry = dict(row)
                entry["total"] = library_counts.get(entry["id"], 0)
                rows.append(entry)
            return rows

    def scoped_tags(
        self,
        project_id: str = "",
        collection_ids: tuple[str, ...] = (),
        without_collection: bool = False,
        without_project: bool = False,
        recent_only: bool = False,
    ) -> builtins.list[dict[str, Any]]:
        """侧栏标签云的作用域 facet: 全库标签都列出, 计数按当前分类收敛后降序排。

        与 tags() 的差别只有计数口径: tags() 按项目收敛, 这里按分类 (含递归子孙)
        收敛, 因此选中分类后计数会掉到 0 —— 但标签照样列出, 用户要能看到全貌并且
        随时切回来, 而不是标签随分类忽隐忽现。

        作用域刻意不含 tag_ids: 交集筛选下被选中的维度不能过滤自己的 facet, 否则
        选中第一个标签之后其余标签的计数会退化成交集, 用户没法再叠加第二个。

        count 复用 _selection, 与列表共享同一份作用域定义 (含递归子孙分类), 侧栏
        计数因此不会和列表条数各说各话。total 仍由 tags() 给出并保持全库口径 ——
        删除标签是全库操作, 确认框必须报全库影响面。
        """

        sql, args = self._selection(
            q="",
            project_id=project_id,
            collection_ids=collection_ids,
            tag_ids=(),
            without_collection=without_collection,
            without_project=without_project,
        )
        if recent_only:
            sql = _recent_window(sql, args)
        with connect(self.database) as c:
            scoped = {
                str(row["tag_id"]): int(row["count"])
                for row in c.execute(
                    "SELECT matched.tag_id, count(DISTINCT matched.literature_id) count "
                    "FROM literature_item_tags matched WHERE matched.literature_id IN "
                    f"(SELECT DISTINCT i.id {sql}) GROUP BY matched.tag_id",
                    args,
                )
            }
        rows = []
        for entry in self.tags():
            entry["count"] = scoped.get(str(entry["id"]), 0)
            rows.append(entry)
        # 计数降序。tags() 已经按 created_at DESC 给出, 而 list.sort 是稳定的
        # (reverse=True 也不会翻转同值项), 所以同计数保持「新标签在前」。
        rows.sort(key=lambda row: row["count"], reverse=True)
        return rows

    def create_collection(
        self, name: str, parent_id: str | None = None, project_id: str = ""
    ) -> dict[str, Any]:
        key = str(uuid.uuid4())
        scope = _collection_scope(project_id)
        with connect(self.database) as c:
            if parent_id is not None:
                parent = c.execute(
                    "SELECT id FROM literature_collections "
                    "WHERE (id=? OR name=?) AND project_id IS ?",
                    (parent_id, parent_id, scope),
                ).fetchone()
                if parent is None:
                    raise LiteratureError(LIBRARY_INVALID)
                parent_id = str(parent[0])
            c.execute(
                "INSERT INTO literature_collections "
                "(id,name,project_id,parent_id,created_at) VALUES(?,?,?,?,?)",
                (key, name, scope, parent_id, time.time()),
            )
        return {
            "id": key,
            "name": name,
            "project_id": scope,
            "parent_id": parent_id,
            "count": 0,
        }

    def rename_collection(self, key: str, name: str, project_id: str = "") -> dict[str, Any]:
        return self.update_collection(key, {"name": name}, project_id)

    def update_collection(
        self, key: str, changes: dict[str, Any], project_id: str = ""
    ) -> dict[str, Any]:
        with connect(self.database) as c:
            c.execute("BEGIN IMMEDIATE")
            scope = _collection_scope(project_id)
            row = c.execute(
                "SELECT * FROM literature_collections "
                "WHERE (id=? OR name=?) AND project_id IS ?",
                (key, key, scope),
            ).fetchone()
            if row is None:
                raise LiteratureError(COLLECTION_NOT_FOUND)
            name = changes.get("name", row["name"])
            if not isinstance(name, str) or not name.strip():
                raise LiteratureError(COLLECTION_NAME_REQUIRED)
            parent_id = changes.get("parent_id", row["parent_id"])
            if parent_id is not None:
                if not isinstance(parent_id, str):
                    raise LiteratureError(COLLECTION_PARENT_INVALID)
                parent = c.execute(
                    "SELECT id FROM literature_collections WHERE id=? AND project_id IS ?",
                    (parent_id, scope),
                ).fetchone()
                if parent is None:
                    raise LiteratureError(COLLECTION_PARENT_INVALID)
                cycle = c.execute(
                    "WITH RECURSIVE subtree(id) AS ("
                    "SELECT id FROM literature_collections WHERE id=? "
                    "UNION SELECT child.id FROM literature_collections child "
                    "JOIN subtree ON child.parent_id=subtree.id"
                    ") SELECT id FROM subtree WHERE id=?",
                    (row["id"], parent_id),
                ).fetchone()
                if cycle is not None:
                    raise LiteratureError(COLLECTION_CYCLE)
            c.execute(
                "UPDATE literature_collections SET name=?,parent_id=? WHERE id=?",
                (name.strip(), parent_id, row["id"]),
            )
            updated = c.execute(
                "SELECT c.*,count(x.literature_id) count "
                "FROM literature_collections c "
                "LEFT JOIN literature_collection_items x ON x.collection_id=c.id "
                "WHERE c.id=? GROUP BY c.id",
                (row["id"],),
            ).fetchone()
            return dict(updated)

    def create_tag(self, name: str, color: str = "") -> dict[str, Any]:
        key = str(uuid.uuid4())
        with connect(self.database) as c:
            c.execute(
                "INSERT OR IGNORE INTO literature_tags VALUES(?,?,?,?)",
                (key, name, color, time.time()),
            )
            row = c.execute(
                "SELECT t.id,t.name,t.color,count(x.literature_id) count "
                "FROM literature_tags t LEFT JOIN literature_item_tags x ON x.tag_id=t.id "
                "WHERE t.name=? GROUP BY t.id",
                (name,),
            ).fetchone()
        if row is None:
            raise LiteratureError(LIBRARY_INVALID)
        return dict(row)

    def delete_collection(self, key: str, project_id: str = "") -> dict[str, int]:
        with connect(self.database) as c:
            scope = _collection_scope(project_id)
            row = c.execute(
                "SELECT id FROM literature_collections "
                "WHERE (id=? OR name=?) AND project_id IS ?",
                (key, key, scope),
            ).fetchone()
            if row is None:
                return {"collections": 0, "memberships": 0}
            collection_id = str(row[0])
            descendants = c.execute(
                "WITH RECURSIVE subtree(id,depth) AS ("
                "SELECT id,0 FROM literature_collections WHERE id=? AND project_id IS ? "
                "UNION ALL "
                "SELECT child.id,subtree.depth+1 FROM literature_collections child "
                "JOIN subtree ON child.parent_id=subtree.id WHERE child.project_id IS ?"
                ") SELECT id,depth FROM subtree ORDER BY depth DESC",
                (collection_id, scope, scope),
            ).fetchall()
            identifiers = tuple(str(entry["id"]) for entry in descendants)
            placeholders = ",".join("?" for _ in identifiers)
            memberships = int(
                c.execute(
                    f"SELECT count(*) FROM literature_collection_items "
                    f"WHERE collection_id IN ({placeholders})",
                    identifiers,
                ).fetchone()[0]
            )
            c.executemany(
                "DELETE FROM literature_collections WHERE id=?",
                ((identifier,) for identifier in identifiers),
            )
            return {"collections": len(identifiers), "memberships": memberships}

    def delete_tag(self, key: str) -> dict[str, int]:
        with connect(self.database) as c:
            row = c.execute(
                "SELECT id FROM literature_tags WHERE id=? OR name=?", (key, key)
            ).fetchone()
            if row is None:
                return {"tags": 0, "memberships": 0}
            tag_id = str(row[0])
            memberships = int(
                c.execute(
                    "SELECT count(*) FROM literature_item_tags WHERE tag_id=?", (tag_id,)
                ).fetchone()[0]
            )
            c.execute("DELETE FROM literature_tags WHERE id=?", (tag_id,))
            return {"tags": 1, "memberships": memberships}

    def projects(self, key: str) -> tuple[str, ...]:
        with connect(self.database) as c:
            return tuple(
                row[0]
                for row in c.execute(
                    "SELECT project_id FROM literature_projects WHERE literature_id=? ORDER BY project_id",
                    (key,),
                )
            )

    def project_collections(
        self, literature_id: str, project_id: str = ""
    ) -> tuple[dict[str, Any], ...]:
        with connect(self.database) as connection:
            scope = _collection_scope(project_id)
            return tuple(
                dict(row)
                for row in connection.execute(
                    "SELECT c.*,0 count FROM literature_collections c "
                    "JOIN literature_collection_items i ON i.collection_id=c.id "
                    "WHERE i.literature_id=? AND "
                    + ("c.project_id=?" if project_id else "c.project_id IS NOT NULL")
                    + " "
                    "ORDER BY c.created_at,c.name",
                    (literature_id, scope) if project_id else (literature_id,),
                )
            )

    def replace_project_collections(
        self, literature_id: str, project_id: str, collection_ids: tuple[str, ...]
    ) -> None:
        unique_ids = tuple(dict.fromkeys(collection_ids))
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            valid_ids: set[str] = set()
            if unique_ids:
                placeholders = ",".join("?" for _ in unique_ids)
                valid_ids = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT id FROM literature_collections "
                        f"WHERE id IN ({placeholders}) AND "
                        + ("project_id=?" if project_id else "project_id IS NOT NULL"),
                        (*unique_ids, project_id) if project_id else unique_ids,
                    )
                }
            if valid_ids != set(unique_ids):
                raise LiteratureError(LIBRARY_INVALID)
            connection.execute(
                "DELETE FROM literature_collection_items WHERE literature_id=? "
                "AND collection_id IN (SELECT id FROM literature_collections "
                + ("WHERE project_id=?)" if project_id else "WHERE project_id IS NOT NULL)"),
                (literature_id, project_id) if project_id else (literature_id,),
            )
            connection.executemany(
                "INSERT INTO literature_collection_items(collection_id,literature_id) VALUES(?,?)",
                ((collection_id, literature_id) for collection_id in unique_ids),
            )

    def replace_projects(self, literature_id: str, project_ids: tuple[str, ...]) -> None:
        """Replace one item's project memberships without persisting project metadata."""

        unique_ids = tuple(dict.fromkeys(project_ids))
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    "SELECT 1 FROM literature_items WHERE id=?", (literature_id,)
                ).fetchone()
                is None
            ):
                raise LiteratureError(LIBRARY_INVALID)
            connection.execute(
                "DELETE FROM literature_projects WHERE literature_id=?", (literature_id,)
            )
            linked_at = time.time()
            connection.executemany(
                "INSERT INTO literature_projects(project_id,literature_id,created_at) "
                "VALUES(?,?,?)",
                ((project_id, literature_id, linked_at) for project_id in unique_ids),
            )

    def associate(
        self,
        literature_ids: tuple[str, ...],
        *,
        project_id: str = "",
        collection_ids: tuple[str, ...] = (),
        tag_ids: tuple[str, ...] = (),
    ) -> tuple[str, ...]:
        """Add existing relationships without replacing an item's other memberships."""

        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = (
                {
                    str(row[0])
                    for row in connection.execute(
                        f"SELECT id FROM literature_items WHERE id IN ({','.join('?' for _ in literature_ids)})",
                        literature_ids,
                    )
                }
                if literature_ids
                else set()
            )
            scope = _collection_scope(project_id)
            valid_collections = (
                {
                    str(row[0])
                    for row in connection.execute(
                        f"SELECT id FROM literature_collections WHERE id IN ({','.join('?' for _ in collection_ids)}) AND project_id IS ?",
                        (*collection_ids, scope),
                    )
                }
                if collection_ids
                else set()
            )
            valid_tags = (
                {
                    str(row[0])
                    for row in connection.execute(
                        f"SELECT id FROM literature_tags WHERE id IN ({','.join('?' for _ in tag_ids)})",
                        tag_ids,
                    )
                }
                if tag_ids
                else set()
            )
            if valid_collections != set(collection_ids) or valid_tags != set(tag_ids):
                raise LiteratureError(LIBRARY_INVALID)
            now = time.time()
            if project_id:
                connection.executemany(
                    "INSERT OR IGNORE INTO literature_projects VALUES(?,?,?)",
                    ((project_id, identifier, now) for identifier in existing),
                )
            connection.executemany(
                "INSERT OR IGNORE INTO literature_collection_items VALUES(?,?)",
                (
                    (collection_id, identifier)
                    for identifier in existing
                    for collection_id in valid_collections
                ),
            )
            connection.executemany(
                "INSERT OR IGNORE INTO literature_item_tags VALUES(?,?)",
                ((identifier, tag_id) for identifier in existing for tag_id in valid_tags),
            )
            return tuple(identifier for identifier in literature_ids if identifier in existing)

    def link_project(
        self,
        identifiers: tuple[str, ...],
        project_id: str,
        collection_ids: tuple[str, ...] = (),
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """Associate existing catalogue items with one validated project atomically.

        ``collection_ids`` 是该项目下的分类。入项目与落分类必须在同一个事务里写完:
        分成两步时, 分类校验失败会把文献留在项目根上, 而调用方看到的是整体失败。
        分类按项目作用域校验, 别的项目 (或全局「我的分类」) 的 id 一律拒绝。
        """

        ordered = tuple(dict.fromkeys(identifiers))
        if not ordered:
            return (), ()
        unique_collections = tuple(dict.fromkeys(collection_ids))
        placeholders = ",".join("?" for _ in ordered)
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = {
                str(row[0])
                for row in connection.execute(
                    f"SELECT id FROM literature_items WHERE id IN ({placeholders})",
                    ordered,
                )
            }
            if unique_collections:
                scope = _collection_scope(project_id)
                collection_placeholders = ",".join("?" for _ in unique_collections)
                valid_collections = {
                    str(row[0])
                    for row in connection.execute(
                        "SELECT id FROM literature_collections "
                        f"WHERE id IN ({collection_placeholders}) AND project_id IS ?",
                        (*unique_collections, scope),
                    )
                }
                if valid_collections != set(unique_collections):
                    raise LiteratureError(LIBRARY_INVALID)
            succeeded = tuple(identifier for identifier in ordered if identifier in existing)
            linked_at = time.time()
            connection.executemany(
                "INSERT OR IGNORE INTO literature_projects VALUES(?,?,?)",
                ((project_id, identifier, linked_at) for identifier in succeeded),
            )
            connection.executemany(
                "INSERT OR IGNORE INTO literature_collection_items VALUES(?,?)",
                (
                    (collection_id, identifier)
                    for identifier in succeeded
                    for collection_id in unique_collections
                ),
            )
        failed = tuple(identifier for identifier in ordered if identifier not in existing)
        return succeeded, failed

    def unlink_project(self, identifiers: tuple[str, ...], project_id: str) -> tuple[str, ...]:
        """Remove project-local classifications and membership without deleting literature."""

        ordered = tuple(dict.fromkeys(identifiers))
        if not ordered:
            return ()
        placeholders = ",".join("?" for _ in ordered)
        with connect(self.database) as connection:
            linked = tuple(
                str(row[0])
                for row in connection.execute(
                    "SELECT literature_id FROM literature_projects "
                    f"WHERE project_id=? AND literature_id IN ({placeholders})",
                    (project_id, *ordered),
                )
            )
            if not linked:
                return ()
            linked_placeholders = ",".join("?" for _ in linked)
            connection.execute(
                "DELETE FROM literature_collection_items "
                f"WHERE literature_id IN ({linked_placeholders}) "
                "AND collection_id IN (SELECT id FROM literature_collections "
                "WHERE project_id=?)",
                (*linked, project_id),
            )
            connection.execute(
                "DELETE FROM literature_projects "
                f"WHERE project_id=? AND literature_id IN ({linked_placeholders})",
                (project_id, *linked),
            )
        linked_set = set(linked)
        return tuple(identifier for identifier in ordered if identifier in linked_set)

    def view(
        self, project_id: str = "", connection: sqlite3.Connection | None = None
    ) -> LiteratureView:
        if connection is None:
            with connect(self.database) as current:
                return self.view(project_id, current)
        sql, args = self._selection(
            project_id=project_id, q="", collection_ids=(), tag_ids=(), without_collection=False
        )
        items = tuple(
            self._item(connection, row, project_id)
            for row in connection.execute(f"SELECT DISTINCT i.* {sql} ORDER BY i.created_at", args)
        )
        collections = tuple(
            LiteratureCollection(
                id=row["id"],
                name=row["name"],
                parent=row["parent_name"] or "",
                count=row["count"],
                project_id=row["project_id"],
            )
            for row in connection.execute(
                "SELECT c.*,parent.name parent_name,count(x.literature_id) count "
                "FROM literature_collections c "
                "LEFT JOIN literature_collections parent ON parent.id=c.parent_id "
                "LEFT JOIN literature_collection_items x ON x.collection_id=c.id "
                "WHERE c.project_id IS ? GROUP BY c.id",
                (_collection_scope(project_id),),
            )
        )
        return LiteratureView(items=items, collections=collections)

    def replace_view(
        self, view: LiteratureView, project_id: str, connection: sqlite3.Connection
    ) -> None:
        decode(encode(view))
        self._replace_collections(
            connection,
            view.collections,
            project_id=project_id,
        )
        if project_id:
            connection.execute("DELETE FROM literature_projects WHERE project_id=?", (project_id,))
            for item in view.items:
                self._save(connection, item, project_id)
            return
        retained = {item.id for item in view.items}
        for row in connection.execute("SELECT id FROM literature_items").fetchall():
            if row[0] not in retained:
                connection.execute("DELETE FROM literature_items WHERE id=?", (row[0],))
        for item in view.items:
            self._save(connection, item, "")

    def replace(self, view: LiteratureView, project_id: str = "") -> None:
        with connect(self.database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.replace_view(view, project_id, connection)

    @staticmethod
    def _replace_collections(
        connection: sqlite3.Connection,
        collections: tuple[LiteratureCollection, ...],
        *,
        project_id: str,
    ) -> None:
        now = time.time()
        scope = _collection_scope(project_id)
        existing = {
            row["name"]: row["id"]
            for row in connection.execute(
                "SELECT id,name FROM literature_collections WHERE project_id IS ?", (scope,)
            )
        }
        identifiers: dict[str, str] = {}
        for entry in collections:
            identifier = existing.get(entry.name) or entry.id or str(uuid.uuid4())
            identifiers[entry.name] = identifier
            connection.execute(
                "INSERT OR IGNORE INTO literature_collections"
                "(id,name,project_id,parent_id,created_at) VALUES(?,?,?,NULL,?)",
                (identifier, entry.name, scope, now),
            )
        if identifiers:
            placeholders = ",".join("?" for _ in identifiers)
            connection.execute(
                f"UPDATE literature_collections SET parent_id=NULL WHERE id IN ({placeholders})",
                tuple(identifiers.values()),
            )
        for entry in collections:
            parent_id = identifiers.get(entry.parent)
            if entry.parent and parent_id is None:
                parent = connection.execute(
                    "SELECT id FROM literature_collections WHERE id=? AND project_id IS ?",
                    (entry.parent, scope),
                ).fetchone()
                parent_id = parent[0] if parent else None
            connection.execute(
                "UPDATE literature_collections SET parent_id=? WHERE id=?",
                (parent_id, identifiers[entry.name]),
            )
        retained = tuple(identifiers.values())
        if retained:
            placeholders = ",".join("?" for _ in retained)
            connection.execute(
                f"DELETE FROM literature_collections WHERE project_id IS ? "
                f"AND id NOT IN ({placeholders})",
                (scope, *retained),
            )
        else:
            connection.execute("DELETE FROM literature_collections WHERE project_id IS ?", (scope,))

    def _item_by_id(self, c: sqlite3.Connection, key: str, project_id: str) -> LiteratureItem:
        row = c.execute("SELECT * FROM literature_items WHERE id=?", (key,)).fetchone()
        if row is None:
            raise LiteratureError(LIBRARY_INVALID)
        return self._item(c, row, project_id)

    @staticmethod
    def _item(c: sqlite3.Connection, r: sqlite3.Row, project_id: str) -> LiteratureItem:
        tags = tuple(
            x[0]
            for x in c.execute(
                "SELECT t.name FROM literature_tags t JOIN literature_item_tags x ON x.tag_id=t.id WHERE x.literature_id=?",
                (r["id"],),
            )
        )
        cols = tuple(
            x[0]
            for x in c.execute(
                "SELECT q.name FROM literature_collections q "
                "JOIN literature_collection_items x ON x.collection_id=q.id "
                "WHERE x.literature_id=? AND q.project_id IS ?",
                (r["id"], _collection_scope(project_id)),
            )
        )
        notes = LiteratureRepository._notes(c, str(r["id"]))
        return LiteratureItem(
            id=r["id"],
            title=r["title"],
            authors=r["authors"],
            journal=r["publication"],
            venue=r["publication"],
            year=r["year"],
            fulltext=FulltextStatus(r["fulltext"]),
            pubtype=PublicationType(r["bib_type"]),
            item_type=r["item_type"],
            citation_key=r["citation_key"],
            subtitle=r["subtitle"],
            published_date=r["published_date"],
            abstract=r["abstract"],
            doi=r["doi"],
            arxiv=r["arxiv"],
            isbn=r["isbn"],
            url=r["url"],
            volume=r["volume"],
            number=r["number"],
            pages=r["pages"],
            publisher=r["publisher"],
            address=r["address"],
            tags=tags,
            collections=cols,
            collection=cols[0] if cols else "",
            added_at=r["created_at"],
            updated_at=r["updated_at"],
            version=r["version"],
            has_pdf=(
                c.execute(
                    "SELECT 1 FROM literature_attachments WHERE literature_id=? "
                    "AND media_type=? LIMIT 1",
                    (r["id"], PDF_MEDIA_TYPE),
                ).fetchone()
                is not None
            ),
            notes=notes,
        )

    @staticmethod
    def _notes(c: sqlite3.Connection, literature_id: str) -> tuple[LiteratureNote, ...]:
        return tuple(
            LiteratureNote(
                id=str(row["id"]),
                text=str(row["text"]),
                created_at=float(row["created_at"]),
                title=str(row["title"]),
                updated_at=float(row["updated_at"]),
                version=int(row["version"]),
                position=int(row["position"]),
            )
            for row in c.execute(
                "SELECT * FROM literature_notes WHERE literature_id=? "
                "ORDER BY position,created_at,id",
                (literature_id,),
            )
        )


def load_library(project_id: str = "", database: Path | str | None = None) -> LiteratureView:
    repository = LiteratureRepository(database) if database is not None else LiteratureRepository()
    return repository.view(project_id)


def save_library(project_id: str, view: LiteratureView) -> None:
    with edit_library(project_id) as edit:
        edit.view = view


@dataclass
class LibraryEdit:
    view: LiteratureView
    connection: sqlite3.Connection


@contextmanager
def edit_library(project_id: str = "", database: Path | str | None = None) -> Iterator[LibraryEdit]:
    repository = LiteratureRepository(database) if database is not None else LiteratureRepository()
    connection = connect(repository.database)
    try:
        connection.execute("BEGIN IMMEDIATE")
        edit = LibraryEdit(repository.view(project_id, connection), connection)
        yield edit
        repository.replace_view(edit.view, project_id, connection)
        connection.commit()
    except LiteratureError:
        connection.rollback()
        raise
    except (sqlite3.Error, OSError) as error:
        connection.rollback()
        raise LiteratureError(LIBRARY_UNAVAILABLE) from error
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()
