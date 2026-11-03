"""SQLite authority for Session-owned Assistant selections and snapshots."""

from __future__ import annotations

import json
import sqlite3
import time
from contextlib import closing
from dataclasses import asdict, dataclass
from pathlib import Path

from service.assistant.domain.model import AnswerAnnotation
from service.assistant.persistence.utils import extend, extensions
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SQLITE_TIMEOUT_SECONDS,
)
from service.chat.persistence.utils import validate_transaction
from service.persistence.project import (
    database_files,
    open_database,
    reader,
    rebuild_table,
    reject_schema_residue,
    schema_transaction,
    sql_tokens,
    table_clauses,
)
from service.platform.context import (
    ASSISTANT_ANSWER_ID_PREFIX,
    AssistantContextSelection,
    AssistantTurnItem,
    AssistantTurnSnapshot,
    ContextAuthority,
    ContextItemRole,
    ContextLabelFallback,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
    SelectionAnchor,
)

ASSISTANT_SELECTION_TABLE = "assistant_context_selection"
ASSISTANT_REF_TABLE = "assistant_context_ref"
ASSISTANT_SNAPSHOT_TABLE = "assistant_turn_snapshot"
ASSISTANT_ITEM_TABLE = "assistant_turn_item"
ASSISTANT_ANNOTATION_TABLE = "assistant_answer_annotation"
MIGRATION_SUFFIX = "_migration"
_FOREIGN_TARGETS = {
    ASSISTANT_SELECTION_TABLE: frozenset((SESSION_CATALOG_TABLE,)),
    ASSISTANT_REF_TABLE: frozenset((ASSISTANT_SELECTION_TABLE,)),
    ASSISTANT_SNAPSHOT_TABLE: frozenset((SESSION_CATALOG_TABLE,)),
    ASSISTANT_ITEM_TABLE: frozenset((ASSISTANT_SNAPSHOT_TABLE,)),
    ASSISTANT_ANNOTATION_TABLE: frozenset((SESSION_CATALOG_TABLE,)),
}
_ADDITIVE_COLUMNS = {
    ASSISTANT_REF_TABLE: {
        "project_id": "TEXT",
        "label_fallback": "TEXT",
        "selection_source_label": "TEXT",
        "retention": "TEXT NOT NULL DEFAULT 'session'",
        "origin": "TEXT NOT NULL DEFAULT 'explicit'",
        "claim_turn_id": "TEXT",
    },
    ASSISTANT_ITEM_TABLE: {
        "project_id": "TEXT",
        "label_fallback": "TEXT",
        "selection_source_label": "TEXT",
        "retention": "TEXT NOT NULL DEFAULT 'session'",
        "origin": "TEXT NOT NULL DEFAULT 'explicit'",
        "authority": "TEXT NOT NULL DEFAULT 'source_material'",
        "surface": "TEXT NOT NULL DEFAULT '{}'",
        "item_role": "TEXT NOT NULL DEFAULT 'material'",
        "model_locator": "TEXT NOT NULL DEFAULT ''",
    },
    ASSISTANT_SNAPSHOT_TABLE: {
        "question_hash": "TEXT NOT NULL DEFAULT ''",
    },
}

DEFAULT_SELECTION_REVISION = 0
DEFAULT_SEARCH_SCOPE = SearchScope.WEB
ASSISTANT_CLAIMED_REFS_IMMUTABLE = "assistant_claimed_refs_immutable"

SNAPSHOT_COLUMNS = (
    "snapshot_id",
    "session_id",
    "client_turn_id",
    "selection_revision",
    "project_id",
    "project_policy",
    "search_scope",
    "model_card_hash",
    "admission_hash",
    "question_hash",
    "created_at",
)
ITEM_COLUMNS = (
    "snapshot_id",
    "evidence_id",
    "ref_id",
    "kind",
    "source_id",
    "project_id",
    "source_revision",
    "label",
    "label_fallback",
    "selection_source_label",
    "anchor",
    "retention",
    "origin",
    "resolution_state",
    "item_role",
    "model_locator",
    "authority",
    "surface",
    "excerpt_text",
    "excerpt_hash",
    "used_chars",
    "reason",
    "order_index",
)
ANNOTATION_COLUMNS = (
    "annotation_id",
    "session_id",
    "client_annotation_id",
    "source_product_seq",
    "source_turn_id",
    "source_item_id",
    "answer_revision",
    "start_utf16",
    "end_utf16",
    "selected_text_hash",
    "preview_text",
    "comment",
    "revision",
    "created_at",
    "updated_at",
)


class AssistantSessionMissingError(LookupError):
    """The parent Session does not exist."""


class AssistantRevisionConflictError(RuntimeError):
    """A selection replacement used a stale expected revision."""

    def __init__(self, latest: AssistantContextSelection) -> None:
        super().__init__("assistant context revision conflict")
        self.latest = latest


class AssistantStateConflictError(RuntimeError):
    """An idempotency key was reused for a different immutable snapshot."""


class AnswerAnnotationMissingError(LookupError):
    """The requested answer annotation does not exist in the Session."""


class AnswerAnnotationOverlapError(RuntimeError):
    """An active annotation already covers part of the requested answer range."""


class AnswerAnnotationClaimedError(RuntimeError):
    """A running Turn currently owns the annotation's pending reference."""


class AnswerAnnotationRevisionConflictError(RuntimeError):
    """An annotation mutation used a stale revision."""

    def __init__(self, latest: AnswerAnnotation) -> None:
        super().__init__("answer annotation revision conflict")
        self.latest = latest


@dataclass(frozen=True)
class AssistantSchema:
    """Assistant-owned initialization requirements, not whole-product admission."""

    create_tables: tuple[str, ...]
    add_columns: tuple[tuple[str, str], ...]
    create_indexes: tuple[str, ...]
    rebuild_tables: tuple[str, ...]

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_tables or self.add_columns or self.create_indexes or self.rebuild_tables
        )


class AssistantStore:
    """Own Assistant tables inside the Session aggregate database."""

    def __init__(self, database: Path) -> None:
        # SessionCatalogStore owns and initializes this aggregate database path.
        # Assistant only adds its own tables; it must not become a second filesystem owner.
        self._database = database
        if not self.inspect_schema(database).needs_write:
            return
        with closing(self._connect()) as connection, schema_transaction(connection):
            self.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Apply owned startup migrations inside the caller's transaction.

        Uses the same code for qualified startup and isolated compatibility
        projection; this method neither opens files nor grants write access.
        """
        schema = cls.inspect_connection(connection)
        if schema.needs_write:
            cls._repair_foreign_keys(connection, schema.rebuild_tables)
            cls._create_tables(connection)
            cls._ensure_columns(connection)
        if cls.inspect_connection(connection).needs_write:
            raise RuntimeError("assistant initialization did not reach the supported format")

    @property
    def database(self) -> Path:
        return self._database

    @classmethod
    def inspect_schema(cls, database: Path) -> AssistantSchema:
        """Read a WAL snapshot under the caller's directory qualification.

        Does not create a missing database or execute source DDL/DML. SQLite
        may touch SHM; filesystem binding and maintenance remain caller duties.
        """
        with database_files(database) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with reader(database) as connection:
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> AssistantSchema:
        reject_schema_residue(connection, _FOREIGN_TARGETS)
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        if any(table + MIGRATION_SUFFIX in objects for table in _FOREIGN_TARGETS):
            raise RuntimeError("assistant migration residue exists; recovery required")
        create_tables: list[str] = []
        add_columns: list[tuple[str, str]] = []
        create_indexes: list[str] = []
        rebuild_tables: list[str] = []
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_tables(reference)
            for table, definition in reference.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='table'"
            ):
                if table not in objects:
                    create_tables.append(table)
                    continue
                if objects[table]["type"] != "table":
                    raise RuntimeError("unsupported assistant table object")
                declared = {row[1] for row in reference.execute(f"PRAGMA table_xinfo({table})")}
                actual = {row["name"] for row in connection.execute(f"PRAGMA table_xinfo({table})")}
                missing = declared - actual
                if missing - _ADDITIVE_COLUMNS.get(table, {}).keys():
                    raise RuntimeError("unsupported assistant missing columns")
                add_columns.extend((table, name) for name in sorted(missing))
                required = {
                    clause
                    for clause in table_clauses(definition, table)
                    if clause[0] not in missing
                }
                try:
                    clauses = table_clauses(objects[table]["sql"], table)
                    extra = extensions(connection, table, declared)
                except ValueError as error:
                    raise RuntimeError("unsupported assistant table definition") from error
                corrected = set()
                rebuild = False
                for clause in clauses:
                    if clause[0] in extra:
                        continue
                    normalized = clause
                    if clause[:2] == ("foreign", "key") and "references" in clause:
                        position = clause.index("references") + 1
                        target = next(iter(_FOREIGN_TARGETS[table]))
                        if clause[position] not in {target, target + MIGRATION_SUFFIX}:
                            raise RuntimeError("unsupported assistant foreign key target")
                        normalized = (*clause[:position], target, *clause[position + 1 :])
                        rebuild |= normalized != clause
                    if normalized in corrected or normalized not in required:
                        raise RuntimeError("unsupported assistant schema declaration")
                    corrected.add(normalized)
                if corrected != required:
                    raise RuntimeError("unsupported assistant missing constraints")
                if rebuild:
                    rebuild_tables.append(table)
            for name, table, sql in reference.execute(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ):
                if name not in objects:
                    create_indexes.append(name)
                elif (
                    objects[name]["type"] != "index"
                    or objects[name]["tbl_name"] != table
                    or sql_tokens(objects[name]["sql"]) != sql_tokens(sql)
                ):
                    raise RuntimeError("unsupported assistant owned index")
        return AssistantSchema(
            tuple(sorted(create_tables)),
            tuple(sorted(add_columns)),
            tuple(sorted(create_indexes)),
            tuple(rebuild_tables),
        )

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(
            str(self._database),
            check_same_thread=False,
            timeout=SQLITE_TIMEOUT_SECONDS,
            isolation_level=None,
        )
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            return connection
        except BaseException:
            connection.close()
            raise

    @classmethod
    def _repair_foreign_keys(cls, connection: sqlite3.Connection, tables: tuple[str, ...]) -> None:
        if not tables:
            return
        with closing(sqlite3.connect(":memory:")) as reference:
            cls._create_tables(reference)
            definitions = dict(
                reference.execute("SELECT name,sql FROM sqlite_master WHERE type='table'")
            )
        for table in tables:
            definition = definitions[table]
            known = {clause[0] for clause in table_clauses(definition, table)}
            extra = extensions(connection, table, known)

            def create(
                target: sqlite3.Connection,
                temporary: str,
                *,
                schema: str = definition,
                original: str = table,
                columns: dict[str, tuple[str, ...]] = extra,
            ) -> None:
                target.execute(
                    schema.replace(f"CREATE TABLE {original} ", f'CREATE TABLE "{temporary}" ', 1)
                )
                extend(target, temporary, columns)

            rebuild_table(connection, table, create)

    @staticmethod
    def _ensure_columns(connection: sqlite3.Connection) -> None:
        """升级已存在的 selection DB；`CREATE TABLE IF NOT EXISTS` 不会补列。"""

        for table, columns in _ADDITIVE_COLUMNS.items():
            existing = frozenset(
                str(row["name"])
                for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
            )
            for name, declaration in columns.items():
                if name not in existing:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")

    @classmethod
    def _create_tables(cls, connection: sqlite3.Connection) -> None:
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_SELECTION_TABLE} (
                session_id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                project_policy TEXT NOT NULL,
                search_scope TEXT NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_REF_TABLE} (
                session_id TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_id TEXT NOT NULL,
                project_id TEXT,
                source_revision TEXT,
                label TEXT NOT NULL,
                label_fallback TEXT,
                selection_source_label TEXT,
                anchor TEXT,
                retention TEXT NOT NULL DEFAULT 'session',
                origin TEXT NOT NULL DEFAULT 'explicit',
                claim_turn_id TEXT,
                order_index INTEGER NOT NULL,
                PRIMARY KEY(session_id, ref_id),
                UNIQUE(session_id, order_index),
                FOREIGN KEY(session_id) REFERENCES {ASSISTANT_SELECTION_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_SNAPSHOT_TABLE} (
                snapshot_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                client_turn_id TEXT NOT NULL,
                selection_revision INTEGER NOT NULL,
                project_id TEXT,
                project_policy TEXT NOT NULL,
                search_scope TEXT NOT NULL,
                model_card_hash TEXT NOT NULL,
                admission_hash TEXT NOT NULL,
                question_hash TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                UNIQUE(session_id, client_turn_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_ITEM_TABLE} (
                snapshot_id TEXT NOT NULL,
                evidence_id TEXT NOT NULL,
                ref_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                source_id TEXT NOT NULL,
                project_id TEXT,
                source_revision TEXT,
                label TEXT NOT NULL,
                label_fallback TEXT,
                selection_source_label TEXT,
                anchor TEXT,
                retention TEXT NOT NULL DEFAULT 'session',
                origin TEXT NOT NULL DEFAULT 'explicit',
                resolution_state TEXT NOT NULL,
                item_role TEXT NOT NULL DEFAULT 'material',
                model_locator TEXT NOT NULL DEFAULT '',
                authority TEXT NOT NULL DEFAULT 'source_material',
                surface TEXT NOT NULL DEFAULT '{{}}',
                excerpt_text TEXT NOT NULL,
                excerpt_hash TEXT NOT NULL,
                used_chars INTEGER NOT NULL,
                reason TEXT NOT NULL,
                order_index INTEGER NOT NULL,
                PRIMARY KEY(snapshot_id, evidence_id),
                UNIQUE(snapshot_id, order_index),
                FOREIGN KEY(snapshot_id) REFERENCES {ASSISTANT_SNAPSHOT_TABLE}(snapshot_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(f"""
            CREATE TABLE IF NOT EXISTS {ASSISTANT_ANNOTATION_TABLE} (
                annotation_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                client_annotation_id TEXT NOT NULL,
                source_product_seq INTEGER NOT NULL,
                source_turn_id TEXT NOT NULL,
                source_item_id TEXT,
                answer_revision TEXT NOT NULL,
                start_utf16 INTEGER NOT NULL,
                end_utf16 INTEGER NOT NULL,
                selected_text_hash TEXT NOT NULL,
                preview_text TEXT NOT NULL,
                comment TEXT NOT NULL,
                revision INTEGER NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                UNIQUE(session_id, client_annotation_id),
                FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id)
                    ON DELETE CASCADE
            )
            """)
        connection.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{ASSISTANT_ANNOTATION_TABLE}_answer "
            f"ON {ASSISTANT_ANNOTATION_TABLE}(session_id, source_product_seq, start_utf16, created_at)"
        )
        connection.execute(
            f"CREATE UNIQUE INDEX IF NOT EXISTS idx_{ASSISTANT_REF_TABLE}_note "
            f"ON {ASSISTANT_REF_TABLE}(session_id, kind, source_id) WHERE kind = 'note'"
        )

    @staticmethod
    def _anchor_json(anchor: SelectionAnchor | None) -> str | None:
        if anchor is None:
            return None
        return json.dumps(asdict(anchor), ensure_ascii=False, sort_keys=True, separators=(",", ":"))

    @staticmethod
    def _anchor(raw: object) -> SelectionAnchor | None:
        if not raw:
            return None
        try:
            value = json.loads(str(raw))
        except (TypeError, ValueError):
            return None
        if not isinstance(value, dict):
            return None
        locator = value.get("locator")
        return SelectionAnchor(
            locator=(
                locator
                if isinstance(locator, dict)
                else {
                    "kind": str(value.get("locator_kind") or ""),
                    **({"page": int(value["page"])} if value.get("page") is not None else {}),
                    **(
                        {"start": int(value["start_utf16"])}
                        if value.get("start_utf16") is not None
                        else {}
                    ),
                    **(
                        {"end": int(value["end_utf16"])}
                        if value.get("end_utf16") is not None
                        else {}
                    ),
                }
            ),
            selected_text_hash=str(value.get("selected_text_hash") or ""),
            preview_text=str(value.get("preview_text") or ""),
            snapshot_text=str(value.get("snapshot_text") or ""),
            document_id=(str(value["document_id"]) if value.get("document_id") else None),
        )

    @staticmethod
    def _mapping(raw: object) -> dict[str, object]:
        if not raw:
            return {}
        try:
            value = json.loads(str(raw))
        except (TypeError, ValueError):
            return {}
        return dict(value) if isinstance(value, dict) else {}

    @staticmethod
    def _annotation(row: sqlite3.Row) -> AnswerAnnotation:
        source_product_seq = int(row["source_product_seq"])
        source_item_id = str(row["source_item_id"]) if row["source_item_id"] else None
        # Prefer the item-based identifier for any row that recorded a stable
        # vendor item id (agent, thinking, tool). Falls back to the legacy
        # seq-based identifier only when the item id was never captured.
        answer_id = (
            f"item:{source_item_id}"
            if source_item_id
            else f"{ASSISTANT_ANSWER_ID_PREFIX}{source_product_seq}"
        )
        return AnswerAnnotation(
            annotation_id=str(row["annotation_id"]),
            client_annotation_id=str(row["client_annotation_id"]),
            session_id=str(row["session_id"]),
            answer_id=answer_id,
            source_product_seq=source_product_seq,
            source_turn_id=str(row["source_turn_id"]),
            source_item_id=source_item_id,
            answer_revision=str(row["answer_revision"]),
            start_utf16=int(row["start_utf16"]),
            end_utf16=int(row["end_utf16"]),
            selected_text_hash=str(row["selected_text_hash"]),
            preview_text=str(row["preview_text"]),
            comment=str(row["comment"]),
            revision=int(row["revision"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    @staticmethod
    def _label_fallback(value: object) -> ContextLabelFallback | None:
        # Unknown persisted presentation codes never change the original label.
        return next((item for item in ContextLabelFallback if item.value == value), None)

    @classmethod
    def _ref(cls, row: sqlite3.Row) -> ContextRef:
        return ContextRef(
            ref_id=str(row["ref_id"]),
            kind=ContextRefKind(str(row["kind"])),
            source_id=str(row["source_id"]),
            project_id=row["project_id"],
            source_revision=str(row["source_revision"]) if row["source_revision"] else None,
            label=str(row["label"]),
            label_fallback=cls._label_fallback(row["label_fallback"]),
            selection_source_label=row["selection_source_label"],
            anchor=cls._anchor(row["anchor"]),
            retention=ContextRetention(str(row["retention"])),
            origin=ContextOrigin(str(row["origin"])),
        )

    @classmethod
    def _selection(
        cls,
        connection: sqlite3.Connection,
        session_id: str,
    ) -> AssistantContextSelection:
        session = connection.execute(
            f"SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if session is None:
            raise AssistantSessionMissingError(session_id)
        row = connection.execute(
            f"SELECT * FROM {ASSISTANT_SELECTION_TABLE} WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        if row is None:
            return AssistantContextSelection(
                session_id=session_id,
                revision=DEFAULT_SELECTION_REVISION,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=DEFAULT_SEARCH_SCOPE,
            )
        refs = connection.execute(
            f"SELECT * FROM {ASSISTANT_REF_TABLE} WHERE session_id = ? ORDER BY order_index",
            (session_id,),
        ).fetchall()
        return AssistantContextSelection(
            session_id=session_id,
            revision=int(row["revision"]),
            project_policy=ProjectContextPolicy(str(row["project_policy"])),
            search_scope=SearchScope(str(row["search_scope"])),
            refs=tuple(cls._ref(ref) for ref in refs),
            updated_at=float(row["updated_at"]),
            claimed_ref_ids=tuple(str(ref["ref_id"]) for ref in refs if ref["claim_turn_id"]),
        )

    def selection(self, session_id: str) -> AssistantContextSelection:
        with closing(self._connect()) as connection, connection:
            return self._selection(connection, session_id)

    def clear_for_relocation(self, session_id: str, connection: sqlite3.Connection) -> bool:
        """Invalidate mutable selections in the same transaction as project rebinding.

        Frozen turn snapshots and annotation records retain their original scope.
        A queued/admitted reference cannot be discarded by a workspace operation.
        """
        validate_transaction(connection, self._database)
        current = self._selection(connection, session_id)
        claimed = connection.execute(
            f"SELECT 1 FROM {ASSISTANT_REF_TABLE} WHERE session_id = ? AND claim_turn_id IS NOT NULL LIMIT 1",
            (session_id,),
        ).fetchone()
        if claimed is not None:
            return False
        if not current.refs:
            return True
        self._write_selection_header(
            connection, current, revision=current.revision + 1, updated_at=time.time()
        )
        connection.execute(f"DELETE FROM {ASSISTANT_REF_TABLE} WHERE session_id = ?", (session_id,))
        return True

    def annotations(
        self,
        session_id: str,
        *,
        source_product_seq: int | None = None,
    ) -> tuple[AnswerAnnotation, ...]:
        with closing(self._connect()) as connection, connection:
            self._selection(connection, session_id)
            where = "session_id = ?"
            values: tuple[object, ...] = (session_id,)
            if source_product_seq is not None:
                where += " AND source_product_seq = ?"
                values = (*values, source_product_seq)
            rows = connection.execute(
                f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE} "
                f"WHERE {where} ORDER BY source_product_seq, start_utf16, created_at",
                values,
            ).fetchall()
        return tuple(self._annotation(row) for row in rows)

    def answer_annotation(
        self,
        session_id: str,
        annotation_id: str,
    ) -> AnswerAnnotation | None:
        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE} "
                "WHERE session_id = ? AND annotation_id = ?",
                (session_id, annotation_id),
            ).fetchone()
        return self._annotation(row) if row is not None else None

    @staticmethod
    def _write_selection_header(
        connection: sqlite3.Connection,
        selection: AssistantContextSelection,
        *,
        revision: int,
        updated_at: float,
    ) -> None:
        connection.execute(
            f"""
            INSERT INTO {ASSISTANT_SELECTION_TABLE} (
                session_id, revision, project_policy, search_scope, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                revision = excluded.revision,
                project_policy = excluded.project_policy,
                search_scope = excluded.search_scope,
                updated_at = excluded.updated_at
            """,
            (
                selection.session_id,
                revision,
                selection.project_policy.value,
                selection.search_scope.value,
                updated_at,
            ),
        )

    @staticmethod
    def _next_order(connection: sqlite3.Connection, session_id: str) -> int:
        row = connection.execute(
            f"SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order "
            f"FROM {ASSISTANT_REF_TABLE} WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        return int(row["next_order"] if row is not None else 0)

    def create_answer_annotation(
        self,
        annotation: AnswerAnnotation,
        *,
        expected_context_revision: int,
        enqueue: bool,
        ref_id: str,
        label: str,
    ) -> tuple[AnswerAnnotation, AssistantContextSelection]:
        timestamp = annotation.created_at
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, annotation.session_id)
                existing_row = connection.execute(
                    f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE} "
                    "WHERE session_id = ? AND client_annotation_id = ?",
                    (annotation.session_id, annotation.client_annotation_id),
                ).fetchone()
                if existing_row is not None:
                    existing = self._annotation(existing_row)
                    if (
                        existing.answer_id,
                        existing.start_utf16,
                        existing.end_utf16,
                        existing.selected_text_hash,
                        existing.comment,
                    ) != (
                        annotation.answer_id,
                        annotation.start_utf16,
                        annotation.end_utf16,
                        annotation.selected_text_hash,
                        annotation.comment,
                    ):
                        raise AssistantStateConflictError("answer annotation client id was reused")
                    connection.execute("COMMIT")
                    return existing, current
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                overlap = connection.execute(
                    f"""
                    SELECT 1 FROM {ASSISTANT_ANNOTATION_TABLE}
                    WHERE session_id = ? AND source_product_seq = ?
                      AND start_utf16 < ? AND end_utf16 > ?
                    LIMIT 1
                    """,
                    (
                        annotation.session_id,
                        annotation.source_product_seq,
                        annotation.end_utf16,
                        annotation.start_utf16,
                    ),
                ).fetchone()
                if overlap is not None:
                    raise AnswerAnnotationOverlapError("answer_annotation_overlap")
                connection.execute(
                    f"INSERT INTO {ASSISTANT_ANNOTATION_TABLE} "
                    f"({', '.join(ANNOTATION_COLUMNS)}) VALUES ({', '.join('?' for _ in ANNOTATION_COLUMNS)})",
                    (
                        annotation.annotation_id,
                        annotation.session_id,
                        annotation.client_annotation_id,
                        annotation.source_product_seq,
                        annotation.source_turn_id,
                        annotation.source_item_id,
                        annotation.answer_revision,
                        annotation.start_utf16,
                        annotation.end_utf16,
                        annotation.selected_text_hash,
                        annotation.preview_text,
                        annotation.comment,
                        annotation.revision,
                        annotation.created_at,
                        annotation.updated_at,
                    ),
                )
                if enqueue:
                    revision = current.revision + 1
                    self._write_selection_header(
                        connection,
                        current,
                        revision=revision,
                        updated_at=timestamp,
                    )
                    anchor = SelectionAnchor(
                        locator={
                            "kind": "answer",
                            "answer_id": annotation.answer_id,
                            "start_utf16": annotation.start_utf16,
                            "end_utf16": annotation.end_utf16,
                        },
                        selected_text_hash=annotation.selected_text_hash,
                        preview_text=annotation.preview_text,
                    )
                    connection.execute(
                        f"""
                        INSERT INTO {ASSISTANT_REF_TABLE} (
                            session_id, ref_id, kind, source_id, source_revision,
                            label, anchor, retention, origin, claim_turn_id, order_index
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                        """,
                        (
                            annotation.session_id,
                            ref_id,
                            ContextRefKind.NOTE.value,
                            annotation.annotation_id,
                            str(annotation.revision),
                            label,
                            self._anchor_json(anchor),
                            ContextRetention.NEXT_TURN.value,
                            ContextOrigin.EXPLICIT.value,
                            self._next_order(connection, annotation.session_id),
                        ),
                    )
                selection = self._selection(connection, annotation.session_id)
                connection.execute("COMMIT")
                return annotation, selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    @staticmethod
    def _annotation_row(
        connection: sqlite3.Connection,
        session_id: str,
        annotation_id: str,
    ) -> sqlite3.Row:
        row = connection.execute(
            f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE} "
            "WHERE session_id = ? AND annotation_id = ?",
            (session_id, annotation_id),
        ).fetchone()
        if row is None:
            raise AnswerAnnotationMissingError(annotation_id)
        return row

    @staticmethod
    def _annotation_ref_row(
        connection: sqlite3.Connection,
        session_id: str,
        annotation_id: str,
    ) -> sqlite3.Row | None:
        return connection.execute(
            f"SELECT * FROM {ASSISTANT_REF_TABLE} "
            "WHERE session_id = ? AND kind = ? AND source_id = ?",
            (session_id, ContextRefKind.NOTE.value, annotation_id),
        ).fetchone()

    def update_answer_annotation(
        self,
        *,
        session_id: str,
        annotation_id: str,
        comment: str,
        expected_annotation_revision: int,
        expected_context_revision: int,
        updated_at: float | None = None,
    ) -> tuple[AnswerAnnotation, AssistantContextSelection]:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                annotation = self._annotation(
                    self._annotation_row(connection, session_id, annotation_id)
                )
                if annotation.revision != expected_annotation_revision:
                    raise AnswerAnnotationRevisionConflictError(annotation)
                ref_row = self._annotation_ref_row(connection, session_id, annotation_id)
                if ref_row is not None and ref_row["claim_turn_id"]:
                    raise AnswerAnnotationClaimedError(annotation_id)
                revision = annotation.revision + 1
                connection.execute(
                    f"UPDATE {ASSISTANT_ANNOTATION_TABLE} "
                    "SET comment = ?, revision = ?, updated_at = ? "
                    "WHERE session_id = ? AND annotation_id = ?",
                    (comment, revision, timestamp, session_id, annotation_id),
                )
                if ref_row is not None:
                    context_revision = current.revision + 1
                    self._write_selection_header(
                        connection,
                        current,
                        revision=context_revision,
                        updated_at=timestamp,
                    )
                    connection.execute(
                        f"UPDATE {ASSISTANT_REF_TABLE} SET source_revision = ? "
                        "WHERE session_id = ? AND ref_id = ?",
                        (str(revision), session_id, str(ref_row["ref_id"])),
                    )
                updated = self._annotation(
                    self._annotation_row(connection, session_id, annotation_id)
                )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return updated, selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def enqueue_answer_annotation(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_context_revision: int,
        ref_id: str,
        label: str,
        updated_at: float | None = None,
    ) -> AssistantContextSelection:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                existing = self._annotation_ref_row(connection, session_id, annotation_id)
                if existing is not None:
                    connection.execute("COMMIT")
                    return current
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                annotation = self._annotation(
                    self._annotation_row(connection, session_id, annotation_id)
                )
                revision = current.revision + 1
                self._write_selection_header(
                    connection,
                    current,
                    revision=revision,
                    updated_at=timestamp,
                )
                anchor = SelectionAnchor(
                    locator={
                        "kind": "answer",
                        "answer_id": annotation.answer_id,
                        "start_utf16": annotation.start_utf16,
                        "end_utf16": annotation.end_utf16,
                    },
                    selected_text_hash=annotation.selected_text_hash,
                    preview_text=annotation.preview_text,
                )
                connection.execute(
                    f"""
                    INSERT INTO {ASSISTANT_REF_TABLE} (
                        session_id, ref_id, kind, source_id, source_revision,
                        label, anchor, retention, origin, claim_turn_id, order_index
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
                    """,
                    (
                        session_id,
                        ref_id,
                        ContextRefKind.NOTE.value,
                        annotation_id,
                        str(annotation.revision),
                        label,
                        self._anchor_json(anchor),
                        ContextRetention.NEXT_TURN.value,
                        ContextOrigin.EXPLICIT.value,
                        self._next_order(connection, session_id),
                    ),
                )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def remove_answer_annotation_context(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_context_revision: int,
        updated_at: float | None = None,
    ) -> AssistantContextSelection:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                ref_row = self._annotation_ref_row(connection, session_id, annotation_id)
                if ref_row is None:
                    connection.execute("COMMIT")
                    return current
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                if ref_row["claim_turn_id"]:
                    raise AnswerAnnotationClaimedError(annotation_id)
                connection.execute(
                    f"DELETE FROM {ASSISTANT_REF_TABLE} WHERE session_id = ? AND ref_id = ?",
                    (session_id, str(ref_row["ref_id"])),
                )
                self._write_selection_header(
                    connection,
                    current,
                    revision=current.revision + 1,
                    updated_at=timestamp,
                )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def delete_answer_annotation(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_annotation_revision: int,
        expected_context_revision: int,
        updated_at: float | None = None,
    ) -> AssistantContextSelection:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                annotation = self._annotation(
                    self._annotation_row(connection, session_id, annotation_id)
                )
                if annotation.revision != expected_annotation_revision:
                    raise AnswerAnnotationRevisionConflictError(annotation)
                ref_row = self._annotation_ref_row(connection, session_id, annotation_id)
                if ref_row is not None and ref_row["claim_turn_id"]:
                    raise AnswerAnnotationClaimedError(annotation_id)
                if ref_row is not None:
                    connection.execute(
                        f"DELETE FROM {ASSISTANT_REF_TABLE} WHERE session_id = ? AND ref_id = ?",
                        (session_id, str(ref_row["ref_id"])),
                    )
                    self._write_selection_header(
                        connection,
                        current,
                        revision=current.revision + 1,
                        updated_at=timestamp,
                    )
                connection.execute(
                    f"DELETE FROM {ASSISTANT_ANNOTATION_TABLE} "
                    "WHERE session_id = ? AND annotation_id = ?",
                    (session_id, annotation_id),
                )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def delete_answer_annotations(
        self,
        *,
        session_id: str,
        expected_annotation_revisions: tuple[tuple[str, int], ...],
        expected_context_revision: int,
        updated_at: float | None = None,
    ) -> AssistantContextSelection:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                annotations: list[AnswerAnnotation] = []
                expected_revisions: dict[str, int] = {}
                ref_rows: dict[str, sqlite3.Row] = {}
                for annotation_id, expected_annotation_revision in expected_annotation_revisions:
                    row = connection.execute(
                        f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE} "
                        "WHERE session_id = ? AND annotation_id = ?",
                        (session_id, annotation_id),
                    ).fetchone()
                    if row is None:
                        continue
                    annotation = self._annotation(row)
                    annotations.append(annotation)
                    expected_revisions[annotation_id] = expected_annotation_revision
                    ref_row = self._annotation_ref_row(connection, session_id, annotation_id)
                    if ref_row is not None:
                        ref_rows[annotation_id] = ref_row
                if not annotations:
                    connection.execute("COMMIT")
                    return current
                if current.revision != expected_context_revision:
                    raise AssistantRevisionConflictError(current)
                for annotation in annotations:
                    if annotation.revision != expected_revisions[annotation.annotation_id]:
                        raise AnswerAnnotationRevisionConflictError(annotation)
                    ref_row = ref_rows.get(annotation.annotation_id)
                    if ref_row is not None and ref_row["claim_turn_id"]:
                        raise AnswerAnnotationClaimedError(annotation.annotation_id)
                for annotation in annotations:
                    ref_row = ref_rows.get(annotation.annotation_id)
                    if ref_row is not None:
                        connection.execute(
                            f"DELETE FROM {ASSISTANT_REF_TABLE} "
                            "WHERE session_id = ? AND ref_id = ?",
                            (session_id, str(ref_row["ref_id"])),
                        )
                    connection.execute(
                        f"DELETE FROM {ASSISTANT_ANNOTATION_TABLE} "
                        "WHERE session_id = ? AND annotation_id = ?",
                        (session_id, annotation.annotation_id),
                    )
                if ref_rows:
                    self._write_selection_header(
                        connection,
                        current,
                        revision=current.revision + 1,
                        updated_at=timestamp,
                    )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def replace_selection(
        self,
        *,
        session_id: str,
        expected_revision: int,
        project_policy: ProjectContextPolicy,
        search_scope: SearchScope,
        refs: tuple[ContextRef, ...],
        updated_at: float | None = None,
    ) -> AssistantContextSelection:
        timestamp = float(updated_at if updated_at is not None else time.time())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                current = self._selection(connection, session_id)
                if current.revision != expected_revision:
                    raise AssistantRevisionConflictError(current)
                claimed_rows = connection.execute(
                    f"""
                    SELECT * FROM {ASSISTANT_REF_TABLE}
                    WHERE session_id = ? AND claim_turn_id IS NOT NULL
                    ORDER BY order_index
                    """,
                    (session_id,),
                ).fetchall()
                claimed = tuple((self._ref(row), str(row["claim_turn_id"])) for row in claimed_rows)
                incoming_claimed = tuple(
                    ref for ref in refs if any(ref.ref_id == item.ref_id for item, _turn in claimed)
                )
                if incoming_claimed != tuple(item for item, _turn in claimed):
                    # claim 是 Turn 与队列之间的并发所有权；PATCH 可以改其它项，
                    # 但不能让页面在模型执行期间删改或重排这批一次性引用。
                    raise AssistantStateConflictError(ASSISTANT_CLAIMED_REFS_IMMUTABLE)
                claim_ids = {item.ref_id: turn for item, turn in claimed}
                revision = current.revision + 1
                connection.execute(
                    f"""
                    INSERT INTO {ASSISTANT_SELECTION_TABLE} (
                        session_id, revision, project_policy, search_scope, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(session_id) DO UPDATE SET
                        revision = excluded.revision,
                        project_policy = excluded.project_policy,
                        search_scope = excluded.search_scope,
                        updated_at = excluded.updated_at
                    """,
                    (
                        session_id,
                        revision,
                        project_policy.value,
                        search_scope.value,
                        timestamp,
                    ),
                )
                connection.execute(
                    f"DELETE FROM {ASSISTANT_REF_TABLE} WHERE session_id = ?",
                    (session_id,),
                )
                for index, ref in enumerate(refs):
                    connection.execute(
                        f"""
                        INSERT INTO {ASSISTANT_REF_TABLE} (
                            session_id, ref_id, kind, source_id, source_revision,
                            label, label_fallback, selection_source_label, anchor, retention, origin, claim_turn_id, order_index, project_id
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            session_id,
                            ref.ref_id,
                            ref.kind.value,
                            ref.source_id,
                            ref.source_revision,
                            ref.label,
                            ref.label_fallback,
                            ref.selection_source_label,
                            self._anchor_json(ref.anchor),
                            ref.retention.value,
                            ref.origin.value,
                            claim_ids.get(ref.ref_id),
                            index,
                            ref.project_id,
                        ),
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return AssistantContextSelection(
            session_id=session_id,
            revision=revision,
            project_policy=project_policy,
            search_scope=search_scope,
            refs=refs,
            updated_at=timestamp,
            claimed_ref_ids=tuple(ref.ref_id for ref in refs if ref.ref_id in claim_ids),
        )

    def claim_for_turn(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
    ) -> AssistantContextSelection:
        """Claim the available one-shot refs without touching queued owners."""

        return self._claim_available_for_turn(
            session_id=session_id,
            client_turn_id=client_turn_id,
            expected_revision=expected_revision,
        )

    def claim_for_queued_turn(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
    ) -> AssistantContextSelection:
        """Claim the available one-shot refs for one durable queued turn."""

        return self._claim_available_for_turn(
            session_id=session_id,
            client_turn_id=client_turn_id,
            expected_revision=expected_revision,
        )

    def _claim_available_for_turn(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
    ) -> AssistantContextSelection:
        """Atomically scope shared refs and one-shot refs to their owning turn."""

        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                selection = self._selection(connection, session_id)
                if expected_revision is not None and expected_revision != selection.revision:
                    raise AssistantRevisionConflictError(selection)
                connection.execute(
                    f"""
                    UPDATE {ASSISTANT_REF_TABLE}
                    SET claim_turn_id = ?
                    WHERE session_id = ? AND retention = ? AND claim_turn_id IS NULL
                    """,
                    (client_turn_id, session_id, ContextRetention.NEXT_TURN.value),
                )
                rows = connection.execute(
                    f"""
                    SELECT * FROM {ASSISTANT_REF_TABLE}
                    WHERE session_id = ?
                      AND (retention = ? OR claim_turn_id = ?)
                    ORDER BY order_index
                    """,
                    (session_id, ContextRetention.SESSION.value, client_turn_id),
                ).fetchall()
                scoped = AssistantContextSelection(
                    session_id=selection.session_id,
                    revision=selection.revision,
                    project_policy=selection.project_policy,
                    search_scope=selection.search_scope,
                    refs=tuple(self._ref(row) for row in rows),
                    updated_at=selection.updated_at,
                )
                connection.execute("COMMIT")
                return scoped
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def validate_snapshot_claim(self, snapshot: AssistantTurnSnapshot) -> None:
        """Replay may use only the immutable refs still owned by this exact turn.

        Released/consumed snapshots require a new client turn id. Never re-claim the
        current queue: it can contain new quotes absent from the saved snapshot.
        """
        expected = {
            item.ref.ref_id
            for item in snapshot.items
            if item.ref.retention is ContextRetention.NEXT_TURN
            and item.ref.origin
            not in (ContextOrigin.CURRENT_DOCUMENT, ContextOrigin.CURRENT_SELECTION)
        }
        if not expected:
            return
        with closing(self._connect()) as connection, connection:
            claimed = {
                str(row["ref_id"])
                for row in connection.execute(
                    f"SELECT ref_id FROM {ASSISTANT_REF_TABLE} "
                    "WHERE session_id = ? AND claim_turn_id = ?",
                    (snapshot.session_id, snapshot.client_turn_id),
                )
            }
        if claimed != expected:
            raise AssistantStateConflictError(
                "assistant snapshot claim no longer owned; use a new turn id"
            )

    def release_claim(self, *, session_id: str, client_turn_id: str) -> AssistantContextSelection:
        """明确失败时幂等释放 claim，保留引用供用户重试。"""

        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    f"""
                    UPDATE {ASSISTANT_REF_TABLE}
                    SET claim_turn_id = NULL
                    WHERE session_id = ? AND claim_turn_id = ?
                    """,
                    (session_id, client_turn_id),
                )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def consume_claim(self, *, session_id: str, client_turn_id: str) -> AssistantContextSelection:
        """确定受理后只删除本轮认领项，不覆盖用户为下一轮加入的新项。"""

        timestamp = time.time()
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                deleted = connection.execute(
                    f"""
                    DELETE FROM {ASSISTANT_REF_TABLE}
                    WHERE session_id = ? AND claim_turn_id = ?
                    """,
                    (session_id, client_turn_id),
                ).rowcount
                if deleted:
                    connection.execute(
                        f"""
                        UPDATE {ASSISTANT_SELECTION_TABLE}
                        SET revision = revision + 1, updated_at = ?
                        WHERE session_id = ?
                        """,
                        (timestamp, session_id),
                    )
                selection = self._selection(connection, session_id)
                connection.execute("COMMIT")
                return selection
            except Exception:
                connection.execute("ROLLBACK")
                raise

    def create_snapshot(self, snapshot: AssistantTurnSnapshot) -> AssistantTurnSnapshot:
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing = self._snapshot_by_client(
                    connection, snapshot.session_id, snapshot.client_turn_id
                )
                if existing is not None:
                    if existing.admission_hash != snapshot.admission_hash:
                        raise AssistantStateConflictError(
                            "assistant snapshot client turn id was reused"
                        )
                    connection.execute("COMMIT")
                    return existing
                connection.execute(
                    f"""
                    INSERT INTO {ASSISTANT_SNAPSHOT_TABLE} ({", ".join(SNAPSHOT_COLUMNS)})
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        snapshot.snapshot_id,
                        snapshot.session_id,
                        snapshot.client_turn_id,
                        snapshot.selection_revision,
                        snapshot.project_id,
                        snapshot.project_policy.value,
                        snapshot.search_scope.value,
                        snapshot.model_card_hash,
                        snapshot.admission_hash,
                        snapshot.question_hash,
                        snapshot.created_at,
                    ),
                )
                for index, item in enumerate(snapshot.items):
                    connection.execute(
                        f"""
                        INSERT INTO {ASSISTANT_ITEM_TABLE} ({", ".join(ITEM_COLUMNS)})
                        VALUES ({", ".join("?" for _ in ITEM_COLUMNS)})
                        """,
                        (
                            snapshot.snapshot_id,
                            item.evidence_id,
                            item.ref.ref_id,
                            item.ref.kind.value,
                            item.ref.source_id,
                            item.ref.project_id,
                            item.ref.source_revision,
                            item.ref.label,
                            item.ref.label_fallback,
                            item.ref.selection_source_label,
                            self._anchor_json(item.ref.anchor),
                            item.ref.retention.value,
                            item.ref.origin.value,
                            item.state.value,
                            item.role.value,
                            item.model_locator,
                            item.authority.value,
                            json.dumps(
                                dict(item.surface),
                                ensure_ascii=False,
                                sort_keys=True,
                                separators=(",", ":"),
                            ),
                            item.excerpt_text,
                            item.excerpt_hash,
                            item.used_chars,
                            item.reason,
                            index,
                        ),
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        return snapshot

    @classmethod
    def _snapshot_by_client(
        cls,
        connection: sqlite3.Connection,
        session_id: str,
        client_turn_id: str,
    ) -> AssistantTurnSnapshot | None:
        row = connection.execute(
            f"""
            SELECT * FROM {ASSISTANT_SNAPSHOT_TABLE}
            WHERE session_id = ? AND client_turn_id = ?
            """,
            (session_id, client_turn_id),
        ).fetchone()
        return cls._snapshot(connection, row) if row is not None else None

    @classmethod
    def _snapshot(
        cls,
        connection: sqlite3.Connection,
        row: sqlite3.Row,
    ) -> AssistantTurnSnapshot:
        item_rows = connection.execute(
            f"SELECT * FROM {ASSISTANT_ITEM_TABLE} WHERE snapshot_id = ? ORDER BY order_index",
            (str(row["snapshot_id"]),),
        ).fetchall()
        items = tuple(cls._item(item) for item in item_rows)
        return AssistantTurnSnapshot(
            snapshot_id=str(row["snapshot_id"]),
            session_id=str(row["session_id"]),
            client_turn_id=str(row["client_turn_id"]),
            selection_revision=int(row["selection_revision"]),
            project_id=str(row["project_id"]) if row["project_id"] else None,
            project_policy=ProjectContextPolicy(str(row["project_policy"])),
            search_scope=SearchScope(str(row["search_scope"])),
            model_card_hash=str(row["model_card_hash"]),
            admission_hash=str(row["admission_hash"]),
            question_hash=str(row["question_hash"]),
            items=items,
            created_at=float(row["created_at"]),
        )

    @classmethod
    def _item(cls, item: sqlite3.Row) -> AssistantTurnItem:
        return AssistantTurnItem(
            evidence_id=str(item["evidence_id"]),
            ref=cls._ref(item),
            state=ContextResolutionState(str(item["resolution_state"])),
            role=ContextItemRole(str(item["item_role"])),
            model_locator=str(item["model_locator"]),
            authority=ContextAuthority(str(item["authority"])),
            surface=cls._mapping(item["surface"]),
            excerpt_text=str(item["excerpt_text"]),
            excerpt_hash=str(item["excerpt_hash"]),
            used_chars=int(item["used_chars"]),
            reason=str(item["reason"]),
        )

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Use production selection, evidence and annotation readers in memory.

        All child records are decoded, including records not returned by a
        parent lookup. No claim, release, annotation edit or recovery executes.
        """
        for row in connection.execute(f"SELECT session_id FROM {ASSISTANT_SELECTION_TABLE}"):
            cls._selection(connection, str(row["session_id"]))
        for row in connection.execute(f"SELECT * FROM {ASSISTANT_REF_TABLE}"):
            cls._ref(row)
        for row in connection.execute(f"SELECT * FROM {ASSISTANT_SNAPSHOT_TABLE}"):
            cls._snapshot(connection, row)
        for row in connection.execute(f"SELECT * FROM {ASSISTANT_ITEM_TABLE}"):
            cls._item(row)
        for row in connection.execute(f"SELECT * FROM {ASSISTANT_ANNOTATION_TABLE}"):
            cls._annotation(row)

    def snapshot_for_turn(
        self,
        session_id: str,
        client_turn_id: str,
    ) -> AssistantTurnSnapshot | None:
        with closing(self._connect()) as connection, connection:
            return self._snapshot_by_client(connection, session_id, client_turn_id)

    def snapshot_by_id(self, session_id: str, snapshot_id: str) -> AssistantTurnSnapshot | None:
        """Read one immutable evidence snapshot without crossing Session ownership."""

        with closing(self._connect()) as connection, connection:
            row = connection.execute(
                f"""
                SELECT * FROM {ASSISTANT_SNAPSHOT_TABLE}
                WHERE session_id = ? AND snapshot_id = ?
                """,
                (session_id, snapshot_id),
            ).fetchone()
            return self._snapshot(connection, row) if row is not None else None


__all__ = [
    "ASSISTANT_ANNOTATION_TABLE",
    "ASSISTANT_ITEM_TABLE",
    "ASSISTANT_REF_TABLE",
    "ASSISTANT_SELECTION_TABLE",
    "ASSISTANT_SNAPSHOT_TABLE",
    "AnswerAnnotationClaimedError",
    "AnswerAnnotationMissingError",
    "AnswerAnnotationOverlapError",
    "AnswerAnnotationRevisionConflictError",
    "AssistantRevisionConflictError",
    "AssistantSessionMissingError",
    "AssistantStateConflictError",
    "AssistantStore",
]
