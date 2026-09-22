"""项目级业务库的落盘契约。

守住四条:

1. **位置**: 库落在 `<项目根>/.scholarseed/service/project.sqlite3`, 且路径只能经
   `ContentPort.resolve()` 得到 —— 越界路径必须被拒;
2. **惰性**: 没有域真正打开过库时, 项目目录下不出现 `.scholarseed/service/`。
   项目创建流程不预建空库;
3. **不污染资料树**: LEGACY 布局下资料库根**就是**项目根, `.scholarseed/` 因此物理位于
   资料树内。它必须被扫描忽略, 否则用户的资料列表里会冒出产品的内部库文件;
4. **机制真的生效**: WAL / 外键 / Row / 事务回滚与连接关闭 —— 这些是各域不再各写
   一遍的前提, 查 pragma 回值而不是查代码。
"""

from __future__ import annotations

import sqlite3
import tempfile
from pathlib import Path

from service.content.domain.model import (
    IGNORED_NAMES,
    LITERATURE_ROOT_RELATIVE,
    PROJECT_STATE_DIRNAME,
    ContentError,
    visible,
)
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_FILENAME, PROJECT_DB_RELATIVE, PROJECT_SERVICE_DIRNAME
from service.persistence import project as project_db
from service.platform.content import RootKind

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def collect_names(nodes: tuple) -> set[str]:
    """摊平一棵资产树的所有节点名。"""

    names: set[str] = set()
    for node in nodes:
        names.add(node.asset.name)
        names |= collect_names(node.children)
    return names


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="project-database-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()

    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    content = ContentService(registry, catalog)

    managed = registry.create("内置项目")
    project_root = Path(managed.root)

    # ---- 1. 位置与越界 ----
    check(
        "相对路径由三段真源拼出, 不含硬编码字面量",
        PROJECT_DB_RELATIVE
        == f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/{PROJECT_DB_FILENAME}",
        PROJECT_DB_RELATIVE,
    )

    database = Path(content.resolve(managed.id, PROJECT_DB_RELATIVE))
    project_database = project_db.ProjectDatabasePath(database, project_root)
    check(
        "resolve 把库解析到项目根内的 .scholarseed/service/",
        database
        == project_root / PROJECT_STATE_DIRNAME / PROJECT_SERVICE_DIRNAME / PROJECT_DB_FILENAME,
        str(database),
    )

    escaped = False
    try:
        content.resolve(managed.id, f"../{PROJECT_DB_RELATIVE}")
    except ContentError:
        escaped = True
    check("越界的库路径被 resolve 拒绝", escaped)

    # ---- 2. 惰性 ----
    check(
        "打开前项目目录下没有 .scholarseed/service/",
        not (project_root / PROJECT_STATE_DIRNAME / PROJECT_SERVICE_DIRNAME).exists(),
    )

    # ---- 4. 机制生效 (顺带产生库文件, 供第 3 条检验) ----
    connection = project_db.connect(project_database)
    try:
        journal = connection.execute("PRAGMA journal_mode").fetchone()[0]
        check("journal_mode 为 WAL", str(journal).lower() == "wal", str(journal))
        foreign_keys = connection.execute("PRAGMA foreign_keys").fetchone()[0]
        check("foreign_keys 已开", int(foreign_keys) == 1, str(foreign_keys))
        check("row_factory 为 sqlite3.Row", connection.row_factory is sqlite3.Row)
    finally:
        connection.close()

    check("打开后库文件落在预期位置", database.is_file(), str(database))

    # 单库多表: 两个域各建一张表, 互不影响。
    with project_db.transaction(project_database) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS alpha_item (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO alpha_item (id) VALUES ('a')")
    with project_db.transaction(project_database) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS beta_item (id TEXT PRIMARY KEY)")
        connection.execute("INSERT INTO beta_item (id) VALUES ('b')")
    with project_db.transaction(project_database) as connection:
        tables = {
            row["name"]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        alpha = connection.execute("SELECT id FROM alpha_item").fetchall()
        beta = connection.execute("SELECT id FROM beta_item").fetchall()
    check(
        "两个域的表共存于同一个库文件",
        {"alpha_item", "beta_item"} <= tables,
        str(sorted(tables)),
    )
    check(
        "各域数据互不干扰",
        [row["id"] for row in alpha] == ["a"] and [row["id"] for row in beta] == ["b"],
    )

    # 幂等建表: 同一段 CREATE TABLE IF NOT EXISTS 重跑不报错、不丢数据。
    with project_db.transaction(project_database) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS alpha_item (id TEXT PRIMARY KEY)")
    with project_db.transaction(project_database) as connection:
        kept = connection.execute("SELECT id FROM alpha_item").fetchall()
    check("幂等建表不丢既有行", [row["id"] for row in kept] == ["a"])

    # 事务语义: 异常回滚, 且连接一定被关闭。
    leaked: list[sqlite3.Connection] = []
    rolled_back = False
    try:
        with project_db.transaction(project_database) as connection:
            leaked.append(connection)
            connection.execute("INSERT INTO alpha_item (id) VALUES ('rollback')")
            raise RuntimeError("boom")
    except RuntimeError:
        rolled_back = True
    check("事务内异常向外抛出", rolled_back)
    with project_db.transaction(project_database) as connection:
        remaining = [row["id"] for row in connection.execute("SELECT id FROM alpha_item")]
    check("异常回滚了未提交的写入", remaining == ["a"], str(remaining))

    closed = False
    try:
        leaked[0].execute("SELECT 1")
    except sqlite3.ProgrammingError:
        closed = True
    check("事务退出后连接已关闭", closed)

    stale_root = root / "暂时离线项目"
    stale_root.mkdir()
    stale_database = stale_root / PROJECT_DB_RELATIVE
    offline_root = root / "暂时离线项目-offline"
    stale_root.rename(offline_root)
    stale_rejected = False
    stale_connection: sqlite3.Connection | None = None
    try:
        stale_connection = project_db.connect(
            project_db.ProjectDatabasePath(stale_database, stale_root)
        )
    except OSError:
        stale_rejected = True
    finally:
        if stale_connection is not None:
            stale_connection.close()
    check(
        "过期数据库路径不能重建已离线的项目根",
        stale_rejected and not stale_root.exists(),
        f"rejected={stale_rejected} exists={stale_root.exists()}",
    )

    # ---- 3. 不污染资料树 (LEGACY: 资料库根 == 项目根) ----
    legacy_root = root / "老项目"
    (legacy_root / LITERATURE_ROOT_RELATIVE).mkdir(parents=True)
    (legacy_root / "老资料.md").write_text("旧内容", encoding="utf-8")
    legacy = registry.adopt(legacy_root, "旧项目")
    legacy_database = Path(content.resolve(legacy.id, PROJECT_DB_RELATIVE))
    with project_db.transaction(
        project_db.ProjectDatabasePath(legacy_database, legacy_root)
    ) as connection:
        connection.execute("CREATE TABLE IF NOT EXISTS alpha_item (id TEXT PRIMARY KEY)")
    check(
        "LEGACY 项目的库确实落在资料库根内部",
        legacy_database.is_file() and legacy_database.is_relative_to(legacy_root),
        str(legacy_database),
    )

    check(f"{PROJECT_STATE_DIRNAME} 在扫描忽略名单里", PROJECT_STATE_DIRNAME in IGNORED_NAMES)
    check(f"visible({PROJECT_STATE_DIRNAME!r}) 为假", not visible(PROJECT_STATE_DIRNAME))
    names = collect_names(content.tree(legacy.id, RootKind.RESOURCES, 5).children)
    check(
        "资料树里看不到产品状态目录与库文件",
        PROJECT_STATE_DIRNAME not in names
        and PROJECT_SERVICE_DIRNAME not in names
        and PROJECT_DB_FILENAME not in names,
        str(sorted(names)),
    )
    check("资料树仍然看得到用户自己的文件", "老资料.md" in names, str(sorted(names)))

    print(f"\ncontract_project_database: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
