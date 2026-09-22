"""content 域的落盘 (开发 1 拥有)。

proposal 47 §5.4 定死了两件事:

- 落 `~/.scholarseed/service/content.sqlite3`, 因为项目、授权根、事件游标、审计
  四类关系需要事务与唯一约束, JSON 做不到;
- **不复用** `sessions.sqlite3` —— 那个库的迁移机制在任何列差异下都会触发
  破坏性重建并把全库压成只读兜底态。

建表用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER`, 不引入版本号驱动的迁移:
本库的所有列都是本提案一次性定下的, 真正需要迁移时再引机制, 提前引反而
多一处会把用户数据压成只读的地方。
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from service.platform.content import AssetKind

#: 表名。
PROJECTS_TABLE = "projects"
EXTERNAL_ROOTS_TABLE = "external_roots"
EVENT_CURSOR_TABLE = "event_cursor"
AUDIT_TABLE = "audit"

#: 外部挂载来源种类列。早期版本只有目录, 迁移时可安全回填为 DIR。
EXTERNAL_ROOT_KIND_COLUMN = "source_kind"

#: 项目归档时间列。非空即已归档; 归档是可逆的产品动作, 只影响列表可见性。
PROJECT_ARCHIVED_AT_COLUMN = "archived_at"

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

_SCHEMA = (
    f"""
    CREATE TABLE IF NOT EXISTS {PROJECTS_TABLE} (
        project_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        dir_root TEXT NOT NULL UNIQUE,
        layout TEXT NOT NULL,
        created_at REAL NOT NULL,
        seeded_from TEXT NULL,
        {PROJECT_ARCHIVED_AT_COLUMN} REAL NULL
    )
    """,
    f"""
    CREATE TABLE IF NOT EXISTS {EXTERNAL_ROOTS_TABLE} (
        root_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        mount_path TEXT NOT NULL,
        {EXTERNAL_ROOT_KIND_COLUMN} TEXT NOT NULL DEFAULT '{AssetKind.DIR.value}',
        authorized_at REAL NOT NULL,
        revoked_at REAL NULL
    )
    """,
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


class ContentCatalog:
    """content 域的关系存储。所有 SQL 只出现在本类里。"""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._tx() as connection:
            for statement in _SCHEMA:
                connection.execute(statement)
            self._retire_full_table_uniques(connection)
            self._ensure_external_root_kind(connection)
            self._ensure_project_archived_at(connection)

    def _ensure_external_root_kind(self, connection: sqlite3.Connection) -> None:
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

    def _ensure_project_archived_at(self, connection: sqlite3.Connection) -> None:
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

    def _retire_full_table_uniques(self, connection: sqlite3.Connection) -> None:
        """把早期建的「含已撤销行」唯一约束换成 partial index。

        SQLite 无法 DROP CONSTRAINT, 所以按新形状重建一次表。识别方式是查
        `sqlite_master` 里的建表语句是否还带 UNIQUE —— 只有开发期建过库的机器
        会命中, 判定与执行都在这一处, 不留一个"以后再说"的半迁移。
        """

        row = connection.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
            (EXTERNAL_ROOTS_TABLE,),
        ).fetchone()
        if row is None or "UNIQUE" not in str(row["sql"]).upper():
            return
        connection.execute(
            f"ALTER TABLE {EXTERNAL_ROOTS_TABLE} RENAME TO {EXTERNAL_ROOTS_TABLE}_old"
        )
        connection.execute(_SCHEMA[1])
        connection.execute(
            f"INSERT INTO {EXTERNAL_ROOTS_TABLE}"
            f" (root_id, project_id, source_path, mount_path, {EXTERNAL_ROOT_KIND_COLUMN},"
            " authorized_at, revoked_at)"
            " SELECT root_id, project_id, source_path, mount_path,"
            f" '{AssetKind.DIR.value}', authorized_at, revoked_at"
            f" FROM {EXTERNAL_ROOTS_TABLE}_old"
        )
        connection.execute(f"DROP TABLE {EXTERNAL_ROOTS_TABLE}_old")
        connection.execute(_SCHEMA[2])
        connection.execute(_SCHEMA[3])

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self.path), timeout=5.0)
        connection.row_factory = sqlite3.Row
        # 桌面端可能同时有 serve 与 CLI 进程读同一个库, WAL 让读不被写阻塞。
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
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

    def insert_project(self, row: ProjectRow) -> ProjectRow:
        with self._tx() as connection:
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
        return row

    def rename_project(self, project_id: str, display_name: str) -> bool:
        """只改显示名。目录名与 `dir_root` 一律不动 (§5.2)。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"UPDATE {PROJECTS_TABLE} SET display_name = ? WHERE project_id = ?",
                (display_name, project_id),
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

    def delete_project(self, project_id: str) -> bool:
        """摘掉登记行。**不动磁盘** —— 「从书深移除」不等于删用户的资料。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"DELETE FROM {PROJECTS_TABLE} WHERE project_id = ?", (project_id,)
            )
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
        clause = "" if include_revoked else " AND revoked_at IS NULL"
        with self._tx() as connection:
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
    ) -> tuple[ExternalRootRow, ...]:
        """Atomically restore or insert a fully preflighted root batch.

        `supersede_root_ids` 是被新根覆盖而要先软撤销的已生效关联 (新源是它们的
        父目录)。撤销与新授权必须在**同一个事务**里: 分两步会出现「子关联已撤、
        父挂载未成」的半态, 或反过来留下双身份窗口。
        """

        stamp = time.time() if at is None else at
        activated: list[ExternalRootRow] = []
        with self._tx() as connection:
            for root_id in supersede_root_ids:
                superseded = connection.execute(
                    f"SELECT mount_path, source_path FROM {EXTERNAL_ROOTS_TABLE}"
                    " WHERE root_id = ? AND revoked_at IS NULL",
                    (root_id,),
                ).fetchone()
                if superseded is None:
                    continue
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
        return tuple(activated)

    def revoke_external_root(self, root_id: str, at: float | None = None) -> bool:
        """软撤销。已撤销的行保留, 因为「谁曾能写项目外文件」必须留痕。"""

        with self._tx() as connection:
            cursor = connection.execute(
                f"UPDATE {EXTERNAL_ROOTS_TABLE} SET revoked_at = ?"
                " WHERE root_id = ? AND revoked_at IS NULL",
                (time.time() if at is None else at, root_id),
            )
        return cursor.rowcount > 0

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
        return (str(row["epoch"]), int(row["last_seq"])) if row is not None else None

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


def _project_row(row: sqlite3.Row) -> ProjectRow:
    return ProjectRow(
        project_id=str(row["project_id"]),
        display_name=str(row["display_name"]),
        dir_root=str(row["dir_root"]),
        layout=str(row["layout"]),
        created_at=float(row["created_at"]),
        seeded_from=None if row["seeded_from"] is None else str(row["seeded_from"]),
        archived_at=None if row["archived_at"] is None else float(row["archived_at"]),
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
]
