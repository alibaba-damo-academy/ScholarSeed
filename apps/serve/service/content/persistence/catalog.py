"""content 域的落盘 (开发 1 拥有)。

proposal 47 §5.4 定死了两件事:

- 落 `~/.scholarseed/service/content.sqlite3`, 因为项目、授权根、授权回执、事件游标、
  审计需要事务与唯一约束, JSON 做不到;
- **不复用** `sessions.sqlite3` —— 那个库的迁移机制在任何列差异下都会触发
  破坏性重建并把全库压成只读兜底态。

建表用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER`, 不引入版本号驱动的迁移:
本库的所有列都是本提案一次性定下的, 真正需要迁移时再引机制, 提前引反而
多一处会把用户数据压成只读的地方。
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from service.content.domain import naming
from service.content.domain.model import OPERATION_INTERRUPTED, OperationState
from service.persistence.notifications import NotificationConnection, NotificationRule
from service.persistence.project import (
    DatabaseMode,
    database_files,
    open_database,
    rebuild_table,
    reject_schema_residue,
    schema_transaction,
    table_clauses,
)
from service.platform.content import AssetKind, ProjectLayout
from service.platform.notifications import ChangeHub, ChangeTopic

#: 表名。
PROJECTS_TABLE = "projects"
EXTERNAL_ROOTS_TABLE = "external_roots"
EXTERNAL_ROOT_MIGRATION_TABLE = f"{EXTERNAL_ROOTS_TABLE}_old"
EVENT_CURSOR_TABLE = "event_cursor"
AUDIT_TABLE = "audit"
ROOT_RECEIPTS_TABLE = "root_receipts"
OPERATIONS_TABLE = "content_operations"
OPERATION_EFFECTS_TABLE = "content_operation_effects"
AUTHORIZATION_RECONCILIATIONS_TABLE = "authorization_reconciliations"
PROJECT_REMOVALS_TABLE = "project_removals"
PROJECT_CREATIONS_TABLE = "project_creations"
PROJECT_CREATION_COMMAND = "CreateProject"
DEFAULT_PROJECT_CREATION_COMMAND = "EnsureDefaultProject"
PROJECT_CREATION_RECOVERY_REQUIRED = "project_creation_recovery_required"
PROJECT_CREATION_PRESERVED = "project_creation_preserved"
_CREATION_NONCE = re.compile(r"[a-f0-9]{32}")
AUTHORIZATION_SUPERSEDED = "content_authorization_superseded"

#: 外部挂载来源种类列。早期版本只有目录, 迁移时可安全回填为 DIR。
EXTERNAL_ROOT_KIND_COLUMN = "source_kind"
EXTERNAL_ROOT_REQUIRED_COLUMNS = frozenset(
    {
        "root_id",
        "project_id",
        "source_path",
        "mount_path",
        "authorized_at",
        "revoked_at",
    }
)
EXTERNAL_ROOT_COLUMNS = EXTERNAL_ROOT_REQUIRED_COLUMNS | {EXTERNAL_ROOT_KIND_COLUMN}

#: 项目归档时间列。非空即已归档; 归档是可逆的产品动作, 只影响列表可见性。
PROJECT_ARCHIVED_AT_COLUMN = "archived_at"
PROJECT_DESCRIPTION_COLUMN = "description"
PROJECT_PINNED_COLUMN = "pinned"

#: 审计动作 (§6.3: 只记授权、撤销、迁移、删除四类, 常规读写不记)。
AUDIT_AUTHORIZE = "authorize_root"
AUDIT_REVOKE = "revoke_root"
AUDIT_MIGRATE = "migrate_project"
AUDIT_TRASH = "trash_asset"

#: 种子来源标记, 落 `projects.seeded_from`。
SEED_WORKSPACE = "workspace"
SEED_CHAT_REGISTRY = "chat/projects.json"
#: 用户在产品里「添加已有文件夹」登记进来的项目。
SEED_ADOPTED = "adopted"

_EXTERNAL_ROOT_SCHEMA = f"""(
        root_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        mount_path TEXT NOT NULL,
        {EXTERNAL_ROOT_KIND_COLUMN} TEXT NOT NULL DEFAULT '{AssetKind.DIR.value}',
        authorized_at REAL NOT NULL,
        revoked_at REAL NULL
    )
    """

_SCHEMA = (
    f"""CREATE TABLE IF NOT EXISTS {PROJECT_CREATIONS_TABLE} (
        operation_id TEXT PRIMARY KEY REFERENCES {OPERATIONS_TABLE}(operation_id),
        project_id TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL UNIQUE,
        plan_json TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        directory_identity TEXT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {PROJECT_REMOVALS_TABLE} (
        operation_id TEXT PRIMARY KEY REFERENCES {OPERATIONS_TABLE}(operation_id),
        project_id TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {AUTHORIZATION_RECONCILIATIONS_TABLE} (
        operation_id TEXT PRIMARY KEY REFERENCES {OPERATIONS_TABLE}(operation_id),
        root_id TEXT NOT NULL UNIQUE,
        root_json TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {OPERATIONS_TABLE} (
        operation_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        command_json TEXT NOT NULL,
        state TEXT NOT NULL,
        result_json TEXT NULL,
        error TEXT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {OPERATION_EFFECTS_TABLE} (
        operation_id TEXT PRIMARY KEY REFERENCES {OPERATIONS_TABLE}(operation_id),
        result_json TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {ROOT_RECEIPTS_TABLE} (
        operation_id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        roots_json TEXT NOT NULL
    )""",
    f"""
    CREATE TABLE IF NOT EXISTS {PROJECTS_TABLE} (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        dir_root TEXT NOT NULL UNIQUE,
        layout TEXT NOT NULL,
        created_at REAL NOT NULL,
        seeded_from TEXT NULL,
        {PROJECT_ARCHIVED_AT_COLUMN} REAL NULL,
        {PROJECT_DESCRIPTION_COLUMN} TEXT NOT NULL DEFAULT '',
        {PROJECT_PINNED_COLUMN} INTEGER NOT NULL DEFAULT 0
    )
    """,
    f"CREATE TABLE IF NOT EXISTS {EXTERNAL_ROOTS_TABLE} {_EXTERNAL_ROOT_SCHEMA}",
    # 唯一性只约束**生效中**的行 (partial index)。若把已撤销的行也算进去,
    # 用户撤销一次授权后就永远无法再次授权同一个目录 / 同一个挂载名 ——
    # 而撤销是可逆的产品动作, 留痕不等于永久拉黑。
    f"""
    CREATE UNIQUE INDEX IF NOT EXISTS {EXTERNAL_ROOTS_TABLE}_active_source
        ON {EXTERNAL_ROOTS_TABLE}(project_id, source_path)
        WHERE revoked_at IS NULL
    """,
    f"""
    CREATE UNIQUE INDEX IF NOT EXISTS {EXTERNAL_ROOTS_TABLE}_active_mount
        ON {EXTERNAL_ROOTS_TABLE}(project_id, mount_path)
        WHERE revoked_at IS NULL
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {EVENT_CURSOR_TABLE} (
        project_id TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        last_seq INTEGER NOT NULL
    )
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {AUDIT_TABLE} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at REAL NOT NULL,
        project_id TEXT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
    )
    """,
)


@dataclass(frozen=True)
class ProjectRow:
    """`projects` 的一行。身份键是 `project_id`, 位置只来自 `dir_root`。"""

    project_id: str
    display_name: str
    dir_root: str
    layout: str
    created_at: float
    seeded_from: str | None = None
    archived_at: float | None = None
    description: str = ""
    pinned: bool = False


@dataclass(frozen=True)
class ExternalRootRow:
    """`external_roots` 的一行。`revoked_at` 非空即已撤销 (软撤销留痕)。"""

    root_id: str
    project_id: str
    source_path: str
    mount_path: str
    authorized_at: float
    kind: AssetKind = AssetKind.DIR
    revoked_at: float | None = None


@dataclass(frozen=True)
class RootReceipt:
    operation_id: str
    request_json: str
    roots: tuple[ExternalRootRow, ...]


@dataclass(frozen=True)
class ProjectRemoval:
    operation_id: str
    owner: str
    project_id: str
    root: str


@dataclass(frozen=True)
class ProjectCreation:
    operation_id: str
    owner: str
    plan: ProjectRow
    nonce: str
    directory_identity: str | None


@dataclass(frozen=True)
class AuthorizationReconciliation:
    operation_id: str
    owner: str
    root: ExternalRootRow


class CatalogFormatError(sqlite3.DatabaseError):
    """Existing content data needs a compatible owner; never rebuild it by guessing."""


class ProjectCreationActive(RuntimeError):
    """A running creation cannot be abandoned by a concurrent request."""


@dataclass(frozen=True)
class CatalogSchema:
    """Content-owned structural changes, not whole-product format permission."""

    create_tables: tuple[str, ...] = ()
    add_columns: tuple[tuple[str, str], ...] = ()
    create_indexes: tuple[str, ...] = ()
    rebuild_external_roots: bool = False

    @property
    def needs_write(self) -> bool:
        return bool(
            self.create_tables
            or self.add_columns
            or self.create_indexes
            or self.rebuild_external_roots
        )


@dataclass(frozen=True)
class CatalogRoots:
    """Topology and structural changes from one WAL snapshot, not admission."""

    present: bool
    schema: CatalogSchema
    projects: tuple[tuple[str, Path], ...] = ()
    external: tuple[tuple[str, str, Path, AssetKind], ...] = ()
    has_receipts: bool = False
    has_pending_operations: bool = False
    has_authorization_reconciliations: bool = False
    has_project_removals: bool = False
    has_project_creations: bool = False
    project_removal_plans: tuple[ProjectRemoval, ...] = ()
    project_creation_plans: tuple[ProjectCreation, ...] = ()
    authorization_plans: tuple[AuthorizationReconciliation, ...] = ()


def _inventory_path(value: object) -> Path:
    if not isinstance(value, str) or not value or "\0" in value:
        raise CatalogFormatError("invalid catalog root path")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise CatalogFormatError("catalog root path must be absolute")
    return path


class ContentCatalog:
    """content 域的关系存储。所有 SQL 只出现在本类里。"""

    @classmethod
    def read_roots(cls, path: Path) -> CatalogRoots:
        """Read before construction/DDL, while the caller protects the directory.

        mode=ro observes committed WAL data; immutable=1 would miss it. SQLite
        may create/update SHM, so this is not permission to access an unqualified
        bearing directory. Missing project directories remain in the inventory.
        """
        path = Path(path).absolute()
        with database_files(path, error_type=CatalogFormatError) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return CatalogRoots(present=False, schema=cls.inspect_connection(connection))
            with closing(open_database(path, mode=DatabaseMode.READ_ONLY)) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("BEGIN")
                schema = cls.inspect_connection(connection)
                tables = {
                    row["name"]: row["type"]
                    for row in connection.execute("SELECT name, type FROM sqlite_master")
                }
                if not tables:
                    return CatalogRoots(present=True, schema=schema)
                if tables.get(PROJECTS_TABLE) != "table" or EXTERNAL_ROOT_MIGRATION_TABLE in tables:
                    raise CatalogFormatError("unsupported catalog root inventory")
                projects = []
                for row in connection.execute(
                    f"SELECT project_id, dir_root FROM {PROJECTS_TABLE} ORDER BY project_id, dir_root"
                ):
                    if not isinstance(row["project_id"], str) or not row["project_id"]:
                        raise CatalogFormatError("invalid catalog project identity")
                    projects.append((row["project_id"], _inventory_path(row["dir_root"])))
                external = []
                if EXTERNAL_ROOTS_TABLE in tables:
                    if tables[EXTERNAL_ROOTS_TABLE] != "table":
                        raise CatalogFormatError("unsupported external root inventory")
                    columns = {
                        row["name"]
                        for row in connection.execute(f"PRAGMA table_xinfo({EXTERNAL_ROOTS_TABLE})")
                    }
                    if not EXTERNAL_ROOT_REQUIRED_COLUMNS <= columns <= EXTERNAL_ROOT_COLUMNS:
                        raise CatalogFormatError("unsupported external root schema")
                    kind = (
                        EXTERNAL_ROOT_KIND_COLUMN
                        if EXTERNAL_ROOT_KIND_COLUMN in columns
                        else "'dir'"
                    )
                    for row in connection.execute(
                        f"SELECT root_id, project_id, source_path, {kind} AS source_kind"
                        f" FROM {EXTERNAL_ROOTS_TABLE} WHERE revoked_at IS NULL"
                        " ORDER BY root_id, project_id, source_path"
                    ):
                        if any(
                            not isinstance(row[key], str) or not row[key]
                            for key in ("root_id", "project_id")
                        ):
                            raise CatalogFormatError("invalid external root identity")
                        try:
                            source_kind = AssetKind(row["source_kind"])
                        except (TypeError, ValueError) as error:
                            raise CatalogFormatError("invalid external root kind") from error
                        external.append(
                            (
                                row["root_id"],
                                row["project_id"],
                                _inventory_path(row["source_path"]),
                                source_kind,
                            )
                        )
                reconciliations = (
                    cls._authorization_reconciliations(connection)
                    if AUTHORIZATION_RECONCILIATIONS_TABLE in tables
                    else ()
                )
                pending_clause = (
                    f" AND operation_id NOT IN (SELECT operation_id FROM {AUTHORIZATION_RECONCILIATIONS_TABLE})"
                    if AUTHORIZATION_RECONCILIATIONS_TABLE in tables
                    else ""
                )
                removals = (
                    cls._project_removals(connection) if PROJECT_REMOVALS_TABLE in tables else ()
                )
                if PROJECT_REMOVALS_TABLE in tables:
                    pending_clause += f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_REMOVALS_TABLE})"
                creations = (
                    cls._project_creations(connection) if PROJECT_CREATIONS_TABLE in tables else ()
                )
                if PROJECT_CREATIONS_TABLE in tables:
                    pending_clause += f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_CREATIONS_TABLE})"
                return CatalogRoots(
                    True,
                    schema,
                    tuple(projects),
                    tuple(external),
                    ROOT_RECEIPTS_TABLE in tables
                    and connection.execute(
                        f"SELECT 1 FROM {ROOT_RECEIPTS_TABLE} LIMIT 1"
                    ).fetchone()
                    is not None,
                    (
                        OPERATIONS_TABLE in tables
                        and connection.execute(
                            f"SELECT 1 FROM {OPERATIONS_TABLE} WHERE state IN (?, ?){pending_clause} LIMIT 1",
                            (OperationState.QUEUED.value, OperationState.RUNNING.value),
                        ).fetchone()
                        is not None
                    )
                    or (
                        OPERATION_EFFECTS_TABLE in tables
                        and connection.execute(
                            f"SELECT 1 FROM {OPERATION_EFFECTS_TABLE} LIMIT 1"
                        ).fetchone()
                        is not None
                    ),
                    bool(reconciliations),
                    bool(removals),
                    bool(creations),
                    removals,
                    creations,
                    reconciliations,
                )

    @classmethod
    def inspect_schema(cls, path: Path) -> CatalogSchema:
        """Classify under directory qualification without changing source schema.

        mode=ro retains WAL visibility and may touch SHM. This does not validate
        all persisted row values, qualify directories, or authorize migration.
        """
        path = Path(path).absolute()
        with database_files(path, error_type=CatalogFormatError) as present:
            if not present:
                with closing(sqlite3.connect(":memory:")) as connection:
                    connection.row_factory = sqlite3.Row
                    return cls.inspect_connection(connection)
            with closing(open_database(path, mode=DatabaseMode.READ_ONLY)) as connection:
                connection.row_factory = sqlite3.Row
                connection.execute("BEGIN")
                return cls.inspect_connection(connection)

    @classmethod
    def inspect_connection(cls, connection: sqlite3.Connection) -> CatalogSchema:
        reject_schema_residue(connection, (EXTERNAL_ROOTS_TABLE,))
        objects = {
            row["name"]: row
            for row in connection.execute("SELECT name,type,tbl_name,sql FROM sqlite_master")
        }
        if EXTERNAL_ROOT_MIGRATION_TABLE in objects:
            raise CatalogFormatError("external root migration residue requires recovery")
        cls._external_root_columns(connection)
        create_tables: list[str] = []
        add_columns: list[tuple[str, str]] = []
        create_indexes: list[str] = []
        optional = {
            (PROJECTS_TABLE, PROJECT_ARCHIVED_AT_COLUMN),
            (PROJECTS_TABLE, PROJECT_DESCRIPTION_COLUMN),
            (PROJECTS_TABLE, PROJECT_PINNED_COLUMN),
            (EXTERNAL_ROOTS_TABLE, EXTERNAL_ROOT_KIND_COLUMN),
        }
        # The actual owner DDL is the only source of expected column definitions.
        with closing(sqlite3.connect(":memory:")) as expected:
            for statement in _SCHEMA:
                expected.execute(statement)
            for (table,) in expected.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence'"
            ):
                if table not in objects:
                    create_tables.append(table)
                    continue
                if objects[table]["type"] != "table":
                    raise CatalogFormatError("catalog table name is occupied by another object")
                declared = {
                    row[1]: tuple(row)[2:]
                    for row in expected.execute(f"PRAGMA table_xinfo({table})")
                }
                actual = {
                    row["name"]: tuple(row)[2:]
                    for row in connection.execute(f"PRAGMA table_xinfo({table})")
                }
                missing = declared.keys() - actual.keys()
                if actual.keys() - declared.keys() or any(
                    (table, column) not in optional for column in missing
                ):
                    raise CatalogFormatError(f"unsupported catalog schema:{table}")
                if any(actual[name] != declared[name] for name in actual):
                    raise CatalogFormatError(f"unsupported catalog column definition:{table}")
                add_columns.extend((table, name) for name in sorted(missing))
            for name, table, sql in expected.execute(
                "SELECT name,tbl_name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"
            ):
                if name not in objects:
                    create_indexes.append(name)
                    continue
                observed = objects[name]

                def normalize(value: object) -> str:
                    return re.sub(r"\s+", "", str(value)).casefold().replace("ifnotexists", "")

                if (
                    observed["type"] != "index"
                    or observed["tbl_name"] != table
                    or normalize(observed["sql"]) != normalize(sql)
                ):
                    raise CatalogFormatError("unsupported catalog owned index")
        rebuild = False
        if EXTERNAL_ROOTS_TABLE in objects:
            for index in connection.execute(f"PRAGMA index_list({EXTERNAL_ROOTS_TABLE})"):
                if index["origin"] != "u":
                    continue
                quoted = str(index["name"]).replace('"', '""')
                keys = [
                    row
                    for row in connection.execute(f'PRAGMA index_xinfo("{quoted}")')
                    if row["key"]
                ]
                if tuple(row["name"] for row in keys) not in (
                    ("project_id", "source_path"),
                    ("project_id", "mount_path"),
                ) or any(row["desc"] or row["coll"] != "BINARY" for row in keys):
                    raise CatalogFormatError("unsupported external root unique constraint")
                rebuild = True
        if rebuild:
            allowed = set(
                table_clauses(
                    f"CREATE TABLE {EXTERNAL_ROOTS_TABLE} {_EXTERNAL_ROOT_SCHEMA}",
                    EXTERNAL_ROOTS_TABLE,
                )
            )
            allowed.update(
                ("unique", "(", "project_id", ",", column, ")")
                for column in ("source_path", "mount_path")
            )
            # Column/index PRAGMAs omit CHECK, conflict policies and several
            # other table semantics. Rebuild only the definitions we own.
            try:
                clauses = table_clauses(objects[EXTERNAL_ROOTS_TABLE]["sql"], EXTERNAL_ROOTS_TABLE)
            except ValueError as error:
                raise CatalogFormatError("unsupported external root table definition") from error
            if any(clause not in allowed for clause in clauses):
                raise CatalogFormatError("unsupported external root rebuild definition")
        return CatalogSchema(
            tuple(sorted(create_tables)),
            tuple(sorted(add_columns)),
            tuple(sorted(create_indexes)),
            rebuild,
        )

    def __init__(self, path: Path) -> None:
        self.changes: ChangeHub | None = None
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, schema_transaction(connection):
            self.initialize_schema(connection)

    @classmethod
    def initialize_schema(cls, connection: sqlite3.Connection) -> None:
        """Apply owner migrations inside the caller's schema transaction."""
        schema = cls.inspect_connection(connection)
        for statement in _SCHEMA:
            connection.execute(statement)
        if schema.rebuild_external_roots:
            cls._retire_full_table_uniques(connection)
        cls._ensure_external_root_kind(connection)
        cls._ensure_project_archived_at(connection)
        cls._ensure_project_metadata(connection)
        if cls.inspect_connection(connection).needs_write:
            raise CatalogFormatError("catalog initialization did not converge")

    @staticmethod
    def _ensure_external_root_kind(connection: sqlite3.Connection) -> None:
        """给只有目录授权的存量库补来源种类列。

        存量行在旧产品中只能由目录选择器产生, 因而回填 DIR 不是猜测。使用幂等
        `ALTER` 而非版本号重建, 避免为了一个新增列触碰授权与审计历史。
        """

        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({EXTERNAL_ROOTS_TABLE})").fetchall()
        }
        if EXTERNAL_ROOT_KIND_COLUMN in columns:
            return
        connection.execute(
            f"ALTER TABLE {EXTERNAL_ROOTS_TABLE}"
            f" ADD COLUMN {EXTERNAL_ROOT_KIND_COLUMN} TEXT NOT NULL"
            f" DEFAULT '{AssetKind.DIR.value}'"
        )

    @staticmethod
    def _ensure_project_metadata(connection: sqlite3.Connection) -> None:
        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({PROJECTS_TABLE})").fetchall()
        }
        for column, declaration in (
            (PROJECT_DESCRIPTION_COLUMN, "TEXT NOT NULL DEFAULT ''"),
            (PROJECT_PINNED_COLUMN, "INTEGER NOT NULL DEFAULT 0"),
        ):
            if column not in columns:
                connection.execute(
                    f"ALTER TABLE {PROJECTS_TABLE} ADD COLUMN {column} {declaration}"
                )

    @staticmethod
    def _ensure_project_archived_at(connection: sqlite3.Connection) -> None:
        """给存量库补项目归档时间列。

        归档是后加的产品动作, 存量行一律未归档, 因而回填 NULL 不是猜测。
        同样使用幂等 `ALTER` 而非版本号重建, 避免为了一个新增列触碰项目登记历史。
        """

        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({PROJECTS_TABLE})").fetchall()
        }
        if PROJECT_ARCHIVED_AT_COLUMN in columns:
            return
        connection.execute(
            f"ALTER TABLE {PROJECTS_TABLE} ADD COLUMN {PROJECT_ARCHIVED_AT_COLUMN} REAL NULL"
        )

    @staticmethod
    def _external_root_columns(connection: sqlite3.Connection) -> frozenset[str]:
        # table_info omits generated/hidden columns; dropping those also loses
        # schema semantics even if a SELECT * projection appears unchanged.
        observed = connection.execute(f"PRAGMA table_xinfo({EXTERNAL_ROOTS_TABLE})").fetchall()
        columns = frozenset(str(column["name"]) for column in observed)
        if observed and (
            not EXTERNAL_ROOT_REQUIRED_COLUMNS <= columns <= EXTERNAL_ROOT_COLUMNS
            or any(column["hidden"] != 0 for column in observed)
        ):
            raise CatalogFormatError("unsupported external root schema")
        return columns

    @classmethod
    def _retire_full_table_uniques(cls, connection: sqlite3.Connection) -> None:
        """把早期建的「含已撤销行」唯一约束换成 partial index。

        schema inspection has already identified the known legacy constraints
        from SQLite index metadata inside this same schema transaction.
        """

        rebuild_table(connection, EXTERNAL_ROOTS_TABLE, cls._create_external_roots)
        # rebuild_table preserves the explicit indexes installed above. Do not
        # identify them by positional offsets in the aggregate schema list.

    @staticmethod
    def _create_external_roots(connection: sqlite3.Connection, table: str) -> None:
        connection.execute(f"CREATE TABLE {table} {_EXTERNAL_ROOT_SCHEMA}")

    def _connect(self) -> sqlite3.Connection:
        connection = open_database(str(self.path), timeout=5.0, factory=NotificationConnection)
        connection.row_factory = sqlite3.Row
        # 桌面端可能同时有 serve 与 CLI 进程读同一个库, WAL 让读不被写阻塞。
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        if self.changes is not None:
            connection.observe(
                self.changes.publish,
                (
                    NotificationRule(PROJECTS_TABLE, operation, ChangeTopic.PROJECTS)
                    for operation in ("INSERT", "UPDATE", "DELETE")
                ),
            )
        return connection

    @contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        """一次事务。`with connection` 只提交不关闭, 因此必须自己 close。"""

        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    # ---- 项目 ----

    def projects(self) -> tuple[ProjectRow, ...]:
        with self._tx() as connection:
            rows = connection.execute(
                f"SELECT * FROM {PROJECTS_TABLE} ORDER BY created_at ASC, project_id ASC"
            ).fetchall()
        return tuple(_project_row(row) for row in rows)

    def project(self, project_id: str) -> ProjectRow | None:
        with self._tx() as connection:
            return self.project_row(connection, project_id)

    @staticmethod
    def project_row(connection: sqlite3.Connection, project_id: str) -> ProjectRow | None:
        """Read the actual owner record from a live snapshot or private copy."""
        row = connection.execute(
            f"SELECT * FROM {PROJECTS_TABLE} WHERE project_id = ?", (project_id,)
        ).fetchone()
        return _project_row(row) if row is not None else None

    def project_by_root(self, dir_root: str) -> ProjectRow | None:
        with self._tx() as connection:
            row = connection.execute(
                f"SELECT * FROM {PROJECTS_TABLE} WHERE dir_root = ?", (dir_root,)
            ).fetchone()
        return _project_row(row) if row is not None else None

    def insert_project(
        self, row: ProjectRow, *, effect: tuple[str, dict[str, object]] | None = None
    ) -> ProjectRow:
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self.insert_project_rows(connection, row, effect=effect)

    @classmethod
    def insert_project_rows(
        cls,
        connection: sqlite3.Connection,
        row: ProjectRow,
        *,
        effect: tuple[str, dict[str, object]] | None = None,
    ) -> ProjectRow:
        """Commit an explicit owner plan on live storage or a private projection."""
        if not connection.in_transaction:
            raise ValueError("project registration requires a transaction")
        creations = tuple(
            creation
            for creation in cls._project_creations(connection)
            if creation.plan.project_id == row.project_id
            or creation.plan.dir_root == row.dir_root
            or (effect is not None and creation.operation_id == effect[0])
        )
        if creations:
            if (
                len(creations) != 1
                or creations[0].plan != row
                or effect is None
                or creations[0].operation_id != effect[0]
                or creations[0].directory_identity is None
            ):
                raise CatalogFormatError("project registration contradicts pending creation")
            connection.execute(
                f"DELETE FROM {PROJECT_CREATIONS_TABLE} WHERE operation_id = ?", (effect[0],)
            )
        connection.execute(
            f"INSERT INTO {PROJECTS_TABLE}"
            " (project_id, display_name, dir_root, layout, created_at, seeded_from)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                row.project_id,
                row.display_name,
                row.dir_root,
                row.layout,
                row.created_at,
                row.seeded_from,
            ),
        )
        if effect is not None:
            cls._record_operation_effect(connection, *effect)
        return row

    def rename_project(
        self,
        project_id: str,
        display_name: str,
        *,
        description: str | None = None,
        pinned: bool | None = None,
    ) -> bool:
        """只改显示名。目录名与 `dir_root` 一律不动 (§5.2)。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"UPDATE {PROJECTS_TABLE} SET display_name = ?,"
                f" {PROJECT_DESCRIPTION_COLUMN} = COALESCE(?, {PROJECT_DESCRIPTION_COLUMN}),"
                f" {PROJECT_PINNED_COLUMN} = COALESCE(?, {PROJECT_PINNED_COLUMN})"
                " WHERE project_id = ?",
                (display_name, description, pinned, project_id),
            )
        return cursor.rowcount > 0

    def set_project_archived(self, project_id: str, archived_at: float | None) -> bool:
        """只写归档时间。目录、会话、关联登记一律不动 —— 归档只影响列表可见性。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"UPDATE {PROJECTS_TABLE} SET {PROJECT_ARCHIVED_AT_COLUMN} = ?"
                " WHERE project_id = ?",
                (archived_at, project_id),
            )
        return cursor.rowcount > 0

    @staticmethod
    def _project_creations(connection: sqlite3.Connection) -> tuple[ProjectCreation, ...]:
        records = connection.execute(
            f"SELECT c.*, o.owner, o.state, o.command_json, o.result_json, o.error"
            f" FROM {PROJECT_CREATIONS_TABLE} c LEFT JOIN {OPERATIONS_TABLE} o"
            " ON o.operation_id = c.operation_id ORDER BY c.operation_id"
        ).fetchall()
        creations = []
        for record in records:
            try:
                plan = ProjectRow(**json.loads(record["plan_json"]))
                command = json.loads(record["command_json"])
                if (
                    any(
                        not isinstance(value, str) or not value or "\0" in value
                        for value in (
                            record["operation_id"],
                            record["owner"],
                            plan.project_id,
                            plan.display_name,
                        )
                    )
                    or (record["state"], record["error"])
                    not in (
                        (OperationState.RUNNING.value, None),
                        (OperationState.FAILED.value, PROJECT_CREATION_RECOVERY_REQUIRED),
                    )
                    or record["result_json"] is not None
                    or not isinstance(command, dict)
                    or not (
                        (
                            command.get("kind") == PROJECT_CREATION_COMMAND
                            and isinstance(command.get("parameters"), dict)
                            and isinstance(command["parameters"].get("name"), str)
                            and naming.creation_name_matches(
                                command["parameters"]["name"],
                                plan.display_name,
                                Path(plan.dir_root).name,
                            )
                        )
                        or (
                            command.get("kind") == DEFAULT_PROJECT_CREATION_COMMAND
                            and isinstance(command.get("parameters"), dict)
                            and set(command["parameters"]) <= {"name"}
                            and isinstance(
                                command["parameters"].get("name", naming.DEFAULT_PROJECT_NAME), str
                            )
                            and naming.creation_name_matches(
                                command["parameters"].get("name", naming.DEFAULT_PROJECT_NAME),
                                plan.display_name,
                                Path(plan.dir_root).name,
                            )
                        )
                    )
                    or len(plan.display_name) > naming.DISPLAY_NAME_MAX
                    or plan.project_id != record["project_id"]
                    or plan.dir_root != record["root_path"]
                    or plan.layout != ProjectLayout.MANAGED.value
                    or type(plan.created_at) not in (float, int)
                    or not math.isfinite(plan.created_at)
                    or plan.created_at < 0
                    or plan.seeded_from is not None
                    or plan.archived_at is not None
                    or not isinstance(record["nonce"], str)
                    or _CREATION_NONCE.fullmatch(record["nonce"]) is None
                    or (
                        record["directory_identity"] is not None
                        and (
                            not isinstance(record["directory_identity"], str)
                            or not record["directory_identity"]
                            or "\0" in record["directory_identity"]
                        )
                    )
                ):
                    raise ValueError("invalid creation record")
                _inventory_path(plan.dir_root)
                if (
                    connection.execute(
                        f"SELECT 1 FROM {PROJECTS_TABLE} WHERE project_id = ? OR dir_root = ?",
                        (plan.project_id, plan.dir_root),
                    ).fetchone()
                    is not None
                    or connection.execute(
                        f"SELECT 1 FROM {OPERATION_EFFECTS_TABLE} WHERE operation_id = ?",
                        (record["operation_id"],),
                    ).fetchone()
                    is not None
                ):
                    raise ValueError("creation contradicts committed state")
            except (TypeError, ValueError, KeyError, OverflowError) as error:
                raise CatalogFormatError("invalid project creation") from error
            creations.append(
                ProjectCreation(
                    record["operation_id"],
                    record["owner"],
                    plan,
                    record["nonce"],
                    record["directory_identity"],
                )
            )
        return tuple(creations)

    def project_creations(self) -> tuple[ProjectCreation, ...]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN")
            return self._project_creations(connection)

    def begin_project_creation(self, identity: str, plan: ProjectRow) -> ProjectCreation:
        """Freeze provenance before mkdir; this record alone grants no filesystem authority."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = next(
                (
                    row
                    for row in self._project_creations(connection)
                    if row.operation_id == identity
                ),
                None,
            )
            if existing is not None:
                if existing.plan != plan:
                    raise CatalogFormatError("project creation plan is immutable")
                return existing
            connection.execute(
                f"INSERT INTO {PROJECT_CREATIONS_TABLE} VALUES (?, ?, ?, ?, ?, NULL)",
                (identity, plan.project_id, plan.dir_root, json.dumps(asdict(plan)), uuid4().hex),
            )
            return next(
                row for row in self._project_creations(connection) if row.operation_id == identity
            )

    def record_project_creation_identity(self, identity: str, directory_identity: str) -> None:
        """Caller must verify the native receipt under full exclusive directory qualification."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.record_project_creation_identity_rows(connection, identity, directory_identity)

    @classmethod
    def record_project_creation_identity_rows(
        cls, connection: sqlite3.Connection, identity: str, directory_identity: str
    ) -> None:
        if not connection.in_transaction:
            raise ValueError("creation identity requires a transaction")
        if (
            not isinstance(directory_identity, str)
            or not directory_identity
            or "\0" in directory_identity
        ):
            raise ValueError("invalid directory identity")
        creation = next(
            (row for row in cls._project_creations(connection) if row.operation_id == identity),
            None,
        )
        if creation is None or creation.directory_identity not in (None, directory_identity):
            raise CatalogFormatError("project creation identity is immutable")
        connection.execute(
            f"UPDATE {PROJECT_CREATIONS_TABLE} SET directory_identity = ? WHERE operation_id = ?",
            (directory_identity, identity),
        )

    def defer_project_creation(self, identity: str, *, now: float | None = None) -> None:
        """Keep provenance for recovery while reporting that this attempt failed."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.defer_project_creation_rows(
                connection, identity, now=time.time() if now is None else now
            )

    @classmethod
    def defer_project_creation_rows(
        cls, connection: sqlite3.Connection, identity: str, *, now: float
    ) -> None:
        if not connection.in_transaction:
            raise ValueError("creation recovery requires a transaction")
        if type(now) not in (int, float) or not math.isfinite(now) or now <= 0:
            raise ValueError("invalid creation recovery timestamp")
        if not any(row.operation_id == identity for row in cls._project_creations(connection)):
            raise CatalogFormatError("project creation is missing")
        connection.execute(
            f"UPDATE {OPERATIONS_TABLE} SET state = ?, error = ?, updated_at = ?"
            " WHERE operation_id = ?",
            (OperationState.FAILED.value, PROJECT_CREATION_RECOVERY_REQUIRED, now, identity),
        )

    def resume_project_creation(
        self, identity: str, owner: str, *, now: float | None = None
    ) -> ProjectCreation:
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self.resume_project_creation_rows(
                connection, identity, owner, now=time.time() if now is None else now
            )

    @classmethod
    def resume_project_creation_rows(
        cls, connection: sqlite3.Connection, identity: str, owner: str, *, now: float
    ) -> ProjectCreation:
        if not connection.in_transaction:
            raise ValueError("creation recovery requires a transaction")
        if type(now) not in (int, float) or not math.isfinite(now) or now <= 0:
            raise ValueError("invalid creation recovery timestamp")
        creation = next(
            (
                row
                for row in cls._project_creations(connection)
                if row.operation_id == identity and row.owner == owner
            ),
            None,
        )
        if creation is None:
            raise CatalogFormatError("project creation is missing")
        connection.execute(
            f"UPDATE {OPERATIONS_TABLE} SET state = ?, error = NULL, updated_at = ?"
            " WHERE operation_id = ?",
            (OperationState.RUNNING.value, now, identity),
        )
        return creation

    def preserve_project_creation(self, identity: str, owner: str) -> bool:
        """End a failed creation intent atomically, without accessing its directory."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            creation = next(
                (
                    row
                    for row in self._project_creations(connection)
                    if row.operation_id == identity and row.owner == owner
                ),
                None,
            )
            if creation is None:
                prior = connection.execute(
                    f"SELECT state, error FROM {OPERATIONS_TABLE} WHERE operation_id = ? AND owner = ?",
                    (identity, owner),
                ).fetchone()
                return prior is not None and (prior["state"], prior["error"]) == (
                    OperationState.FAILED.value,
                    PROJECT_CREATION_PRESERVED,
                )
            updated = connection.execute(
                f"UPDATE {OPERATIONS_TABLE} SET error = ?, updated_at = ?"
                " WHERE operation_id = ? AND owner = ? AND state = ? AND error = ?",
                (
                    PROJECT_CREATION_PRESERVED,
                    time.time(),
                    identity,
                    owner,
                    OperationState.FAILED.value,
                    PROJECT_CREATION_RECOVERY_REQUIRED,
                ),
            )
            if updated.rowcount != 1:
                raise ProjectCreationActive("project creation is running")
            connection.execute(
                f"DELETE FROM {PROJECT_CREATIONS_TABLE} WHERE operation_id = ?", (identity,)
            )
            return True

    def begin_project_removal(self, identity: str, project_id: str) -> None:
        """Persist the accepted removal before any cross-store cleanup."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            operation = connection.execute(
                f"SELECT state FROM {OPERATIONS_TABLE} WHERE operation_id = ?", (identity,)
            ).fetchone()
            project = connection.execute(
                f"SELECT dir_root FROM {PROJECTS_TABLE} WHERE project_id = ?", (project_id,)
            ).fetchone()
            if (
                operation is None
                or operation["state"] != OperationState.RUNNING.value
                or project is None
            ):
                raise CatalogFormatError(
                    "project removal requires a running operation and registered project"
                )
            connection.execute(
                f"INSERT INTO {PROJECT_REMOVALS_TABLE} VALUES (?, ?, ?)",
                (identity, project_id, project["dir_root"]),
            )

    @staticmethod
    def _project_removals(connection: sqlite3.Connection) -> tuple[ProjectRemoval, ...]:
        records = connection.execute(
            f"SELECT r.*, o.owner, o.state, p.dir_root FROM {PROJECT_REMOVALS_TABLE} r"
            f" LEFT JOIN {OPERATIONS_TABLE} o ON o.operation_id = r.operation_id"
            f" LEFT JOIN {PROJECTS_TABLE} p ON p.project_id = r.project_id ORDER BY r.operation_id"
        ).fetchall()
        result = []
        for row in records:
            if (
                any(
                    not isinstance(row[key], str) or not row[key] or "\0" in row[key]
                    for key in ("operation_id", "owner", "project_id")
                )
                or row["state"] != OperationState.RUNNING.value
                or row["dir_root"] != row["root_path"]
                or connection.execute(
                    f"SELECT 1 FROM {OPERATION_EFFECTS_TABLE} WHERE operation_id = ?",
                    (row["operation_id"],),
                ).fetchone()
                is not None
            ):
                raise CatalogFormatError("invalid project removal")
            _inventory_path(row["root_path"])
            result.append(
                ProjectRemoval(
                    row["operation_id"], row["owner"], row["project_id"], row["root_path"]
                )
            )
        return tuple(result)

    def project_removals(self) -> tuple[ProjectRemoval, ...]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN")
            return self._project_removals(connection)

    def delete_project(
        self,
        project_id: str,
        *,
        effect: tuple[str, dict[str, object]] | None = None,
        now: float | None = None,
    ) -> bool:
        """Retire registration and grants atomically; never delete project files."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            return self.delete_project_rows(
                connection, project_id, now=time.time() if now is None else now, effect=effect
            )

    @classmethod
    def delete_project_rows(
        cls,
        connection: sqlite3.Connection,
        project_id: str,
        *,
        now: float,
        effect: tuple[str, dict[str, object]] | None = None,
    ) -> bool:
        """Run the owner transition on live storage or a private recovery projection.

        Directory provenance and the other stores remain composition's concern;
        this method grants no path access and commits no caller transaction.
        """
        if not connection.in_transaction:
            raise ValueError("project removal requires a transaction")
        if type(now) not in (int, float) or not math.isfinite(now) or now <= 0:
            raise ValueError("invalid project removal timestamp")
        removal = next(
            (row for row in cls._project_removals(connection) if row.project_id == project_id),
            None,
        )
        if (removal is None) != (effect is None) or (
            removal is not None and effect is not None and removal.operation_id != effect[0]
        ):
            raise CatalogFormatError("project removal does not match committed result")
        if (
            connection.execute(
                f"SELECT 1 FROM {PROJECTS_TABLE} WHERE project_id = ?", (project_id,)
            ).fetchone()
            is None
        ):
            return False
        for row in connection.execute(
            f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE project_id = ?", (project_id,)
        ).fetchall():
            cls._cancel_authorization_reconciliation(connection, row["root_id"], now=now)
            if row["revoked_at"] is None:
                connection.execute(
                    f"UPDATE {EXTERNAL_ROOTS_TABLE} SET revoked_at = ? WHERE root_id = ?",
                    (now, row["root_id"]),
                )
                connection.execute(
                    f"INSERT INTO {AUDIT_TABLE} (at, project_id, action, detail) VALUES (?, ?, ?, ?)",
                    (
                        now,
                        project_id,
                        AUDIT_REVOKE,
                        f"{row['mount_path']} <- {row['source_path']}",
                    ),
                )
        cursor = connection.execute(
            f"DELETE FROM {PROJECTS_TABLE} WHERE project_id = ?", (project_id,)
        )
        connection.execute(f"DELETE FROM {EVENT_CURSOR_TABLE} WHERE project_id = ?", (project_id,))
        if effect is not None:
            connection.execute(
                f"DELETE FROM {PROJECT_REMOVALS_TABLE} WHERE operation_id = ?", (effect[0],)
            )
            cls._record_operation_effect(connection, *effect)
        return cursor.rowcount > 0

    def set_layout(self, project_id: str, layout: str) -> bool:
        """改布局。只有迁移会调它 —— 布局与磁盘形态必须同时变。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"UPDATE {PROJECTS_TABLE} SET layout = ? WHERE project_id = ?",
                (layout, project_id),
            )
        return cursor.rowcount > 0

    # ---- 关联外部根 ----

    def external_roots(
        self, project_id: str, *, include_revoked: bool = False
    ) -> tuple[ExternalRootRow, ...]:
        with self._tx() as connection:
            return self.external_root_rows(connection, project_id, include_revoked=include_revoked)

    @staticmethod
    def external_root_rows(
        connection: sqlite3.Connection, project_id: str, *, include_revoked: bool = False
    ) -> tuple[ExternalRootRow, ...]:
        clause = "" if include_revoked else " AND revoked_at IS NULL"
        rows = connection.execute(
            f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE project_id = ?{clause}"
            " ORDER BY authorized_at ASC",
            (project_id,),
        ).fetchall()
        return tuple(_external_row(row) for row in rows)

    def external_root(self, root_id: str) -> ExternalRootRow | None:
        with self._tx() as connection:
            row = connection.execute(
                f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE root_id = ?", (root_id,)
            ).fetchone()
        return _external_row(row) if row is not None else None

    def insert_external_root(self, row: ExternalRootRow) -> ExternalRootRow:
        with self._tx() as connection:
            connection.execute(
                f"INSERT INTO {EXTERNAL_ROOTS_TABLE}"
                f" (root_id, project_id, source_path, mount_path, {EXTERNAL_ROOT_KIND_COLUMN},"
                " authorized_at, revoked_at)"
                " VALUES (?, ?, ?, ?, ?, ?, NULL)",
                (
                    row.root_id,
                    row.project_id,
                    row.source_path,
                    row.mount_path,
                    row.kind.value,
                    row.authorized_at,
                ),
            )
        return row

    def authorize_external_roots(
        self,
        rows: tuple[ExternalRootRow, ...],
        *,
        supersede_root_ids: tuple[str, ...] = (),
        at: float | None = None,
        receipt: tuple[str, str] | None = None,
        effect: tuple[str, dict[str, object]] | None = None,
        authorization_operation_id: str | None = None,
    ) -> tuple[ExternalRootRow, ...]:
        """Atomically restore or insert a fully preflighted root batch.

        `supersede_root_ids` 是被新根覆盖而要先软撤销的已生效关联 (新源是它们的
        父目录)。撤销与新授权必须在**同一个事务**里: 分两步会出现「子关联已撤、
        父挂载未成」的半态, 或反过来留下双身份窗口。
        """

        if authorization_operation_id is not None and (
            len(rows) != 1 or effect is not None or receipt is not None
        ):
            raise ValueError("authorization reconciliation requires one independent root")
        stamp = time.time() if at is None else at
        activated: list[ExternalRootRow] = []
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            for root_id in supersede_root_ids:
                superseded = connection.execute(
                    f"SELECT mount_path, source_path FROM {EXTERNAL_ROOTS_TABLE}"
                    " WHERE root_id = ? AND revoked_at IS NULL",
                    (root_id,),
                ).fetchone()
                if superseded is None:
                    continue
                self._cancel_authorization_reconciliation(connection, root_id)
                connection.execute(
                    f"UPDATE {EXTERNAL_ROOTS_TABLE} SET revoked_at = ? WHERE root_id = ?",
                    (stamp, root_id),
                )
                connection.execute(
                    f"INSERT INTO {AUDIT_TABLE} (at, project_id, action, detail)"
                    " VALUES (?, ?, ?, ?)",
                    (
                        stamp,
                        rows[0].project_id if rows else "",
                        AUDIT_REVOKE,
                        f"{superseded['mount_path']} <- {superseded['source_path']}",
                    ),
                )
            for proposed in rows:
                conflict = connection.execute(
                    f"SELECT root_id FROM {EXTERNAL_ROOTS_TABLE} WHERE project_id = ?"
                    " AND revoked_at IS NULL AND (source_path = ? OR mount_path = ?)",
                    (proposed.project_id, proposed.source_path, proposed.mount_path),
                ).fetchone()
                if conflict is not None:
                    raise sqlite3.IntegrityError("root_exists")
                restored = connection.execute(
                    f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE project_id = ?"
                    " AND source_path = ? AND mount_path = ?"
                    f" AND {EXTERNAL_ROOT_KIND_COLUMN} = ? AND revoked_at IS NOT NULL"
                    " ORDER BY authorized_at DESC LIMIT 1",
                    (
                        proposed.project_id,
                        proposed.source_path,
                        proposed.mount_path,
                        proposed.kind.value,
                    ),
                ).fetchone()
                if restored is not None:
                    self._cancel_authorization_reconciliation(connection, restored["root_id"])
                    connection.execute(
                        f"UPDATE {EXTERNAL_ROOTS_TABLE} SET authorized_at = ?, revoked_at = NULL"
                        " WHERE root_id = ?",
                        (proposed.authorized_at, restored["root_id"]),
                    )
                    row = ExternalRootRow(
                        root_id=restored["root_id"],
                        project_id=proposed.project_id,
                        source_path=proposed.source_path,
                        mount_path=proposed.mount_path,
                        authorized_at=proposed.authorized_at,
                        kind=proposed.kind,
                    )
                else:
                    connection.execute(
                        f"INSERT INTO {EXTERNAL_ROOTS_TABLE}"
                        f" (root_id, project_id, source_path, mount_path,"
                        f" {EXTERNAL_ROOT_KIND_COLUMN}, authorized_at, revoked_at)"
                        " VALUES (?, ?, ?, ?, ?, ?, NULL)",
                        (
                            proposed.root_id,
                            proposed.project_id,
                            proposed.source_path,
                            proposed.mount_path,
                            proposed.kind.value,
                            proposed.authorized_at,
                        ),
                    )
                    row = proposed
                connection.execute(
                    f"INSERT INTO {AUDIT_TABLE} (at, project_id, action, detail)"
                    " VALUES (?, ?, ?, ?)",
                    (
                        proposed.authorized_at,
                        proposed.project_id,
                        AUDIT_AUTHORIZE,
                        f"{proposed.mount_path} <- {proposed.source_path}",
                    ),
                )
                activated.append(row)
            if authorization_operation_id is not None:
                operation = connection.execute(
                    f"SELECT state FROM {OPERATIONS_TABLE} WHERE operation_id = ?",
                    (authorization_operation_id,),
                ).fetchone()
                if operation is None or operation["state"] != OperationState.RUNNING.value:
                    raise CatalogFormatError(
                        "authorization reconciliation requires a running operation"
                    )
                connection.execute(
                    f"INSERT INTO {AUTHORIZATION_RECONCILIATIONS_TABLE} VALUES (?, ?, ?)",
                    (
                        authorization_operation_id,
                        activated[0].root_id,
                        json.dumps(asdict(activated[0]), ensure_ascii=False, allow_nan=False),
                    ),
                )
            if receipt is not None:
                operation_id, request_json = receipt
                if not operation_id or not request_json or not activated:
                    raise ValueError("invalid root receipt")
                connection.execute(
                    f"INSERT INTO {ROOT_RECEIPTS_TABLE} VALUES (?, ?, ?)",
                    (
                        operation_id,
                        request_json,
                        json.dumps([asdict(row) for row in activated], ensure_ascii=False),
                    ),
                )
            if effect is not None:
                self._record_operation_effect(connection, *effect)
        return tuple(activated)

    @staticmethod
    def _record_operation_effect(
        connection: sqlite3.Connection, identity: str, result: dict[str, object]
    ) -> None:
        row = connection.execute(
            f"SELECT state FROM {OPERATIONS_TABLE} WHERE operation_id = ?", (identity,)
        ).fetchone()
        if row is None or row["state"] != OperationState.RUNNING.value:
            raise CatalogFormatError("content effect requires a running operation")
        if not isinstance(result, dict):
            raise ValueError("content effect requires a result object")
        connection.execute(
            f"INSERT INTO {OPERATION_EFFECTS_TABLE} VALUES (?, ?)",
            (identity, json.dumps(result, ensure_ascii=False, allow_nan=False)),
        )

    def record_operation_effect(self, identity: str, result: dict[str, object]) -> None:
        """Record a completed no-op under the caller's exclusive directory ownership."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self._record_operation_effect(connection, identity, result)

    def accept_operation(
        self, identity: str, owner: str, command_json: str, *, limit: int, retention: float
    ) -> bool:
        now = time.time()
        with self._tx() as connection:
            connection.execute(
                f"DELETE FROM {OPERATIONS_TABLE} WHERE state IN (?, ?) AND updated_at < ?"
                f" AND operation_id NOT IN (SELECT operation_id FROM {OPERATION_EFFECTS_TABLE})"
                f" AND operation_id NOT IN (SELECT operation_id FROM {AUTHORIZATION_RECONCILIATIONS_TABLE})"
                f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_REMOVALS_TABLE})"
                f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_CREATIONS_TABLE})",
                (OperationState.SUCCEEDED.value, OperationState.FAILED.value, now - retention),
            )
            count = connection.execute(f"SELECT COUNT(*) FROM {OPERATIONS_TABLE}").fetchone()[0]
            if count >= limit:
                return False
            connection.execute(
                f"INSERT INTO {OPERATIONS_TABLE} VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)",
                (identity, owner, command_json, OperationState.QUEUED.value, now, now),
            )
        return True

    def start_operation(self, identity: str) -> None:
        with self._tx() as connection:
            changed = connection.execute(
                f"UPDATE {OPERATIONS_TABLE} SET state = ?, updated_at = ?"
                " WHERE operation_id = ? AND state = ?",
                (OperationState.RUNNING.value, time.time(), identity, OperationState.QUEUED.value),
            )
            if changed.rowcount != 1:
                raise CatalogFormatError("content operation is not queued")

    def finish_operation(
        self,
        identity: str,
        state: OperationState,
        result: dict[str, object] | None,
        error: str | None,
        *,
        now: float | None = None,
    ) -> None:
        stamp = time.time() if now is None else now
        if type(stamp) not in (int, float) or not math.isfinite(stamp) or stamp <= 0:
            raise ValueError("invalid content operation timestamp")
        if state not in (OperationState.SUCCEEDED, OperationState.FAILED):
            raise ValueError("content operation result must be terminal")
        if (state is OperationState.SUCCEEDED) != (result is not None):
            raise ValueError("invalid content operation result")
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if (
                connection.execute(
                    f"SELECT 1 FROM {AUTHORIZATION_RECONCILIATIONS_TABLE} WHERE operation_id = ?",
                    (identity,),
                ).fetchone()
                is not None
            ):
                raise CatalogFormatError("authorization reconciliation is incomplete")
            if (
                connection.execute(
                    f"SELECT 1 FROM {PROJECT_REMOVALS_TABLE} WHERE operation_id = ?", (identity,)
                ).fetchone()
                is not None
            ):
                raise CatalogFormatError("project removal is incomplete")
            if (
                connection.execute(
                    f"SELECT 1 FROM {PROJECT_CREATIONS_TABLE} WHERE operation_id = ?", (identity,)
                ).fetchone()
                is not None
            ):
                raise CatalogFormatError("project creation is incomplete")
            effect = connection.execute(
                f"SELECT result_json FROM {OPERATION_EFFECTS_TABLE} WHERE operation_id = ?",
                (identity,),
            ).fetchone()
            if effect is not None and (
                state is not OperationState.SUCCEEDED or json.loads(effect["result_json"]) != result
            ):
                raise CatalogFormatError("content result contradicts committed effect")
            changed = connection.execute(
                f"UPDATE {OPERATIONS_TABLE} SET state = ?, result_json = ?, error = ?, updated_at = ?"
                " WHERE operation_id = ? AND state IN (?, ?)",
                (
                    state.value,
                    json.dumps(result, ensure_ascii=False) if result is not None else None,
                    error,
                    stamp,
                    identity,
                    OperationState.QUEUED.value,
                    OperationState.RUNNING.value,
                ),
            )
            if changed.rowcount != 1:
                existing = connection.execute(
                    f"SELECT state, result_json, error FROM {OPERATIONS_TABLE} WHERE operation_id = ?",
                    (identity,),
                ).fetchone()
                if existing is None or (
                    existing["state"] != state.value
                    or (
                        json.loads(existing["result_json"])
                        if existing["result_json"] is not None
                        else None
                    )
                    != result
                    or existing["error"] != error
                ):
                    raise CatalogFormatError("content operation is not pending")
            connection.execute(
                f"DELETE FROM {OPERATION_EFFECTS_TABLE} WHERE operation_id = ?", (identity,)
            )

    def operation_result(self, owner: str, identity: str) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                f"SELECT * FROM {OPERATIONS_TABLE} WHERE operation_id = ? AND owner = ?",
                (identity, owner),
            ).fetchone()
        if row is None:
            return None
        return self._operation_result(row, identity)

    @staticmethod
    def _operation_result(row: sqlite3.Row, identity: str) -> dict[str, object]:
        try:
            state = OperationState(row["state"])
            result = json.loads(row["result_json"]) if row["result_json"] is not None else None
            if (
                (state is OperationState.SUCCEEDED) != isinstance(result, dict)
                or (result is not None and not isinstance(result, dict))
                or (row["error"] is not None and not isinstance(row["error"], str))
            ):
                raise ValueError("invalid content operation result")
        except (TypeError, ValueError) as error:
            raise CatalogFormatError("invalid content operation result") from error
        return {
            "operation": identity,
            "state": state.value,
            "result": result,
            "error": row["error"],
        }

    def recover_operations(self) -> None:
        """Only cold exclusive startup may publish effects and fence abandoned intents."""
        with self.recovery_transaction() as connection:
            self.recover_operation_rows(connection, now=time.time())

    @contextmanager
    def recovery_transaction(self) -> Iterator[sqlite3.Connection]:
        """Open one recovery step while composition holds exclusive domains."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            yield connection

    @classmethod
    def recover_operation_rows(cls, connection: sqlite3.Connection, *, now: float) -> None:
        """Apply the actual recovery in a caller-owned transaction or private copy."""
        if not connection.in_transaction:
            raise ValueError("operation recovery requires a transaction")
        if (
            connection.execute(f"SELECT 1 FROM {ROOT_RECEIPTS_TABLE} LIMIT 1").fetchone()
            is not None
        ):
            raise CatalogFormatError("LINK receipts must be reconciled before operation recovery")
        cls._authorization_reconciliations(connection)
        cls._project_removals(connection)
        cls._project_creations(connection)
        effects = connection.execute(
            f"SELECT e.operation_id, e.result_json, o.state FROM {OPERATION_EFFECTS_TABLE} e"
            f" LEFT JOIN {OPERATIONS_TABLE} o ON o.operation_id = e.operation_id"
        ).fetchall()
        for effect in effects:
            cls._operation_effect(effect)
            connection.execute(
                f"UPDATE {OPERATIONS_TABLE} SET state = ?, result_json = ?, error = NULL,"
                " updated_at = ? WHERE operation_id = ?",
                (
                    OperationState.SUCCEEDED.value,
                    effect["result_json"],
                    now,
                    effect["operation_id"],
                ),
            )
        connection.execute(f"DELETE FROM {OPERATION_EFFECTS_TABLE}")
        connection.execute(
            f"UPDATE {OPERATIONS_TABLE} SET state = ?, error = ?, updated_at = ?"
            " WHERE state IN (?, ?)"
            f" AND operation_id NOT IN (SELECT operation_id FROM {AUTHORIZATION_RECONCILIATIONS_TABLE})"
            f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_REMOVALS_TABLE})"
            f" AND operation_id NOT IN (SELECT operation_id FROM {PROJECT_CREATIONS_TABLE})",
            (
                OperationState.FAILED.value,
                OPERATION_INTERRUPTED,
                now,
                OperationState.QUEUED.value,
                OperationState.RUNNING.value,
            ),
        )

    @staticmethod
    def _operation_effect(effect: sqlite3.Row) -> dict[str, object]:
        try:
            result = json.loads(effect["result_json"])
            if not isinstance(result, dict) or effect["state"] != OperationState.RUNNING.value:
                raise ValueError("invalid operation effect")
        except (TypeError, ValueError) as error:
            raise CatalogFormatError("invalid content operation effect") from error
        return result

    @staticmethod
    def _authorization_reconciliations(
        connection: sqlite3.Connection,
    ) -> tuple[AuthorizationReconciliation, ...]:
        records = connection.execute(
            f"SELECT r.*, o.owner, o.state FROM {AUTHORIZATION_RECONCILIATIONS_TABLE} r"
            f" LEFT JOIN {OPERATIONS_TABLE} o ON o.operation_id = r.operation_id ORDER BY r.operation_id"
        ).fetchall()
        result = []
        for record in records:
            try:
                payload = json.loads(record["root_json"])
                root = ExternalRootRow(**{**payload, "kind": AssetKind(payload["kind"])})
                if (
                    record["state"] != OperationState.RUNNING.value
                    or not isinstance(record["owner"], str)
                    or not record["owner"]
                    or any(
                        not isinstance(value, str) or not value or "\0" in value
                        for value in (
                            record["operation_id"],
                            root.root_id,
                            root.project_id,
                            root.mount_path,
                        )
                    )
                    or root.root_id != record["root_id"]
                    or root.revoked_at is not None
                    or type(root.authorized_at) not in (int, float)
                    or not math.isfinite(root.authorized_at)
                ):
                    raise ValueError("invalid authorization reconciliation")
                _inventory_path(root.source_path)
                current = connection.execute(
                    f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE root_id = ?", (root.root_id,)
                ).fetchone()
                effect = connection.execute(
                    f"SELECT 1 FROM {OPERATION_EFFECTS_TABLE} WHERE operation_id = ?",
                    (record["operation_id"],),
                ).fetchone()
                if current is None or _external_row(current) != root or effect is not None:
                    raise ValueError("authorization reconciliation contradicts authority")
            except (TypeError, ValueError, KeyError) as error:
                raise CatalogFormatError("invalid authorization reconciliation") from error
            result.append(
                AuthorizationReconciliation(record["operation_id"], record["owner"], root)
            )
        return tuple(result)

    def authorization_reconciliations(self) -> tuple[AuthorizationReconciliation, ...]:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN")
            return self._authorization_reconciliations(connection)

    def finish_authorization_reconciliation(self, identity: str, result: dict[str, object]) -> None:
        """Publish the result only after version reconciliation, under directory exclusion."""
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.finish_authorization_reconciliation_rows(connection, identity, result)

    @classmethod
    def finish_authorization_reconciliation_rows(
        cls, connection: sqlite3.Connection, identity: str, result: dict[str, object]
    ) -> None:
        """Consume the exact pending authorization after its resource owner completes.

        Shared by live completion and private startup projection. This method
        does not observe files, generate resource versions, or replace that work;
        the composition caller must finish it before publishing this result.
        """
        if not connection.in_transaction:
            raise ValueError("authorization reconciliation requires a transaction")
        records = cls._authorization_reconciliations(connection)
        if not any(row.operation_id == identity for row in records):
            raise CatalogFormatError("authorization reconciliation is missing")
        connection.execute(
            f"DELETE FROM {AUTHORIZATION_RECONCILIATIONS_TABLE} WHERE operation_id = ?",
            (identity,),
        )
        cls._record_operation_effect(connection, identity, result)

    @staticmethod
    def _cancel_authorization_reconciliation(
        connection: sqlite3.Connection, root_id: str, *, now: float | None = None
    ) -> None:
        connection.execute(
            f"UPDATE {OPERATIONS_TABLE} SET state = ?, result_json = NULL, error = ?, updated_at = ?"
            f" WHERE operation_id IN (SELECT operation_id FROM {AUTHORIZATION_RECONCILIATIONS_TABLE} WHERE root_id = ?)",
            (
                OperationState.FAILED.value,
                AUTHORIZATION_SUPERSEDED,
                time.time() if now is None else now,
                root_id,
            ),
        )
        connection.execute(
            f"DELETE FROM {AUTHORIZATION_RECONCILIATIONS_TABLE} WHERE root_id = ?", (root_id,)
        )

    def root_receipts(self) -> tuple[RootReceipt, ...]:
        with closing(self._connect()) as connection:
            return self.root_receipt_rows(connection)

    @staticmethod
    def root_receipt_rows(connection: sqlite3.Connection) -> tuple[RootReceipt, ...]:
        receipts = connection.execute(
            f"SELECT * FROM {ROOT_RECEIPTS_TABLE} ORDER BY operation_id"
        ).fetchall()
        result = []
        for receipt in receipts:
            try:
                payload = json.loads(receipt["roots_json"])
                if not isinstance(payload, list) or not payload:
                    raise ValueError("empty root receipt")
                roots = tuple(
                    ExternalRootRow(**{**row, "kind": AssetKind(row["kind"])}) for row in payload
                )
                for row in roots:
                    if (
                        any(
                            not isinstance(value, str) or not value or "\0" in value
                            for value in (row.root_id, row.project_id, row.mount_path)
                        )
                        or row.revoked_at is not None
                        or type(row.authorized_at) not in (int, float)
                        or not math.isfinite(row.authorized_at)
                    ):
                        raise ValueError("invalid root receipt result")
                    _inventory_path(row.source_path)
                if not receipt["operation_id"] or not receipt["request_json"]:
                    raise ValueError("invalid root receipt identity")
            except (TypeError, ValueError, KeyError) as error:
                raise CatalogFormatError("invalid root receipt") from error
            result.append(RootReceipt(receipt["operation_id"], receipt["request_json"], roots))
        return tuple(result)

    def acknowledge_root_receipt(self, operation_id: str, request_json: str) -> None:
        with self.recovery_transaction() as connection:
            self.acknowledge_root_receipt_rows(connection, operation_id, request_json)

    @staticmethod
    def acknowledge_root_receipt_rows(
        connection: sqlite3.Connection, operation_id: str, request_json: str
    ) -> None:
        """Acknowledge the exact recovered receipt in a caller-owned transaction."""
        if not connection.in_transaction:
            raise ValueError("receipt acknowledgement requires a transaction")
        connection.execute(
            f"DELETE FROM {ROOT_RECEIPTS_TABLE} WHERE operation_id = ? AND request_json = ?",
            (operation_id, request_json),
        )

    def revoke_external_root(
        self,
        root_id: str,
        at: float | None = None,
        *,
        effect: tuple[str, dict[str, object]] | None = None,
    ) -> bool:
        """Commit revocation, its audit, and any directory-command result together."""
        stamp = time.time() if at is None else at
        with self._tx() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE root_id = ? AND revoked_at IS NULL",
                (root_id,),
            ).fetchone()
            if row is None:
                return False
            self._cancel_authorization_reconciliation(connection, root_id)
            connection.execute(
                f"UPDATE {EXTERNAL_ROOTS_TABLE} SET revoked_at = ? WHERE root_id = ?",
                (stamp, root_id),
            )
            connection.execute(
                f"INSERT INTO {AUDIT_TABLE} (at, project_id, action, detail) VALUES (?, ?, ?, ?)",
                (
                    stamp,
                    row["project_id"],
                    AUDIT_REVOKE,
                    f"{row['mount_path']} <- {row['source_path']}",
                ),
            )
            if effect is not None:
                self._record_operation_effect(connection, *effect)
        return True

    def restore_external_root(
        self,
        project_id: str,
        source_path: str,
        mount_path: str,
        kind: AssetKind,
        at: float | None = None,
    ) -> ExternalRootRow | None:
        """Restore the exact revoked authorization lineage instead of minting a new root."""

        with self._tx() as connection:
            row = connection.execute(
                f"SELECT * FROM {EXTERNAL_ROOTS_TABLE}"
                " WHERE project_id = ? AND source_path = ? AND mount_path = ?"
                f" AND {EXTERNAL_ROOT_KIND_COLUMN} = ? AND revoked_at IS NOT NULL"
                " ORDER BY authorized_at DESC LIMIT 1",
                (project_id, source_path, mount_path, kind.value),
            ).fetchone()
            if row is None:
                return None
            self._cancel_authorization_reconciliation(connection, row["root_id"])
            connection.execute(
                f"UPDATE {EXTERNAL_ROOTS_TABLE} SET authorized_at = ?, revoked_at = NULL"
                " WHERE root_id = ?",
                (time.time() if at is None else at, row["root_id"]),
            )
            restored = connection.execute(
                f"SELECT * FROM {EXTERNAL_ROOTS_TABLE} WHERE root_id = ?", (row["root_id"],)
            ).fetchone()
        return _external_row(restored)

    # ---- 事件游标 ----

    def cursor(self, project_id: str) -> tuple[str, int] | None:
        with self._tx() as connection:
            row = connection.execute(
                f"SELECT epoch, last_seq FROM {EVENT_CURSOR_TABLE} WHERE project_id = ?",
                (project_id,),
            ).fetchone()
        return self._cursor(row) if row is not None else None

    @staticmethod
    def _cursor(row: sqlite3.Row) -> tuple[str, int]:
        return str(row["epoch"]), int(row["last_seq"])

    def bump_cursor(self, project_id: str, epoch: str, count: int = 1) -> int:
        """在给定 epoch 内推进 seq, 返回推进后的值。

        持久化而非进程内自增: 桌面端每次重启 serve 都会归零, 客户端拿旧
        `from_seq` 续传会**静默错位**, 比丢事件更糟。
        """

        with self._tx() as connection:
            row = connection.execute(
                f"SELECT epoch, last_seq FROM {EVENT_CURSOR_TABLE} WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if row is None or str(row["epoch"]) != epoch:
                connection.execute(
                    f"INSERT INTO {EVENT_CURSOR_TABLE} (project_id, epoch, last_seq)"
                    " VALUES (?, ?, ?)"
                    " ON CONFLICT(project_id) DO UPDATE SET epoch = excluded.epoch,"
                    " last_seq = excluded.last_seq",
                    (project_id, epoch, count),
                )
                return count
            updated = int(row["last_seq"]) + count
            connection.execute(
                f"UPDATE {EVENT_CURSOR_TABLE} SET last_seq = ? WHERE project_id = ?",
                (updated, project_id),
            )
        return updated

    # ---- 审计 ----

    def record(self, action: str, detail: str, project_id: str | None = None) -> None:
        with self._tx() as connection:
            connection.execute(
                f"INSERT INTO {AUDIT_TABLE} (at, project_id, action, detail) VALUES (?, ?, ?, ?)",
                (time.time(), project_id, action, detail),
            )

    def audit(self, limit: int = 100) -> tuple[sqlite3.Row, ...]:
        with self._tx() as connection:
            rows = connection.execute(
                f"SELECT * FROM {AUDIT_TABLE} ORDER BY seq DESC LIMIT ?", (limit,)
            ).fetchall()
        return tuple(rows)

    @classmethod
    def inspect_rows(cls, connection: sqlite3.Connection) -> None:
        """Read persisted authority and recovery receipts without publishing them.

        Path strings are decoded by their real readers. They do not authorize
        opening, creating, relocating or deleting the referenced directories.
        """
        for row in connection.execute(f"SELECT * FROM {PROJECTS_TABLE}"):
            _project_row(row)
        for row in connection.execute(f"SELECT * FROM {EXTERNAL_ROOTS_TABLE}"):
            _external_row(row)
        for row in connection.execute(f"SELECT * FROM {OPERATIONS_TABLE}"):
            cls._operation_result(row, row["operation_id"])
        for effect in connection.execute(
            f"SELECT e.operation_id, e.result_json, o.state FROM {OPERATION_EFFECTS_TABLE} e"
            f" LEFT JOIN {OPERATIONS_TABLE} o ON o.operation_id = e.operation_id"
        ):
            cls._operation_effect(effect)
        cls.root_receipt_rows(connection)
        cls._authorization_reconciliations(connection)
        cls._project_removals(connection)
        cls._project_creations(connection)
        for row in connection.execute(f"SELECT epoch,last_seq FROM {EVENT_CURSOR_TABLE}"):
            cls._cursor(row)
        # The audit API returns raw SQLite rows, with no additional codec.
        for row in connection.execute(f"SELECT * FROM {AUDIT_TABLE}"):
            tuple(row)


def _project_row(row: sqlite3.Row) -> ProjectRow:
    return ProjectRow(
        project_id=str(row["project_id"]),
        display_name=str(row["display_name"]),
        dir_root=str(row["dir_root"]),
        layout=str(row["layout"]),
        created_at=float(row["created_at"]),
        seeded_from=None if row["seeded_from"] is None else str(row["seeded_from"]),
        archived_at=None if row["archived_at"] is None else float(row["archived_at"]),
        description=str(row[PROJECT_DESCRIPTION_COLUMN]),
        pinned=bool(row[PROJECT_PINNED_COLUMN]),
    )


def _external_row(row: sqlite3.Row) -> ExternalRootRow:
    return ExternalRootRow(
        root_id=str(row["root_id"]),
        project_id=str(row["project_id"]),
        source_path=str(row["source_path"]),
        mount_path=str(row["mount_path"]),
        authorized_at=float(row["authorized_at"]),
        kind=AssetKind(str(row[EXTERNAL_ROOT_KIND_COLUMN])),
        revoked_at=None if row["revoked_at"] is None else float(row["revoked_at"]),
    )


__all__ = [
    "AUDIT_AUTHORIZE",
    "AUDIT_MIGRATE",
    "AUDIT_REVOKE",
    "AUDIT_TRASH",
    "SEED_ADOPTED",
    "SEED_CHAT_REGISTRY",
    "SEED_WORKSPACE",
    "EXTERNAL_ROOT_KIND_COLUMN",
    "PROJECT_ARCHIVED_AT_COLUMN",
    "ContentCatalog",
    "ExternalRootRow",
    "ProjectRow",
    "RootReceipt",
]
