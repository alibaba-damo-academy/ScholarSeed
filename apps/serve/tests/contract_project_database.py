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

import os
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from service.assistant.persistence.store import AssistantStore
from service.chat.persistence.catalog import SessionCatalogStore
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
from service.platform.activity import Activities
from service.platform.content import RootKind
from service.platform.storage import filesystem_path
from service.resources.persistence.jobs import ImportJobStore
from service.resources.persistence.version import VersionStore

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


CONNECTION_WORKERS = 8
CONNECTION_BATCH_SIZE = 24
CONNECTION_BATCHES = 10
LONG_DIRECTORY_SEGMENT = "database-path-" * 8


class ConnectionFilenameContract(unittest.TestCase):
    def test_long_native_and_ordinary_names_share_wal_and_preserve_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            ordinary = Path(directory) / LONG_DIRECTORY_SEGMENT / LONG_DIRECTORY_SEGMENT
            ordinary = ordinary / LONG_DIRECTORY_SEGMENT / "资料 #% database.sqlite3"
            native = filesystem_path(ordinary)
            native.parent.mkdir(parents=True)
            with closing(project_db.open_database(native)) as writer, writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("CREATE TABLE probe(id INTEGER PRIMARY KEY)")
                writer.execute("INSERT INTO probe VALUES (0)")
            with closing(project_db.open_database(native)) as writer:
                writer.execute("BEGIN IMMEDIATE")
                writer.execute("INSERT INTO probe VALUES (-1)")
                with project_db.reader(ordinary) as reader:
                    self.assertEqual(
                        [tuple(row) for row in reader.execute("SELECT id FROM probe")], [(0,)]
                    )
                    with self.assertRaises(sqlite3.OperationalError) as caught:
                        reader.execute("INSERT INTO probe VALUES (-2)")
                    self.assertEqual(caught.exception.sqlite_errorcode, sqlite3.SQLITE_READONLY)
                writer.rollback()

            def append(index):
                with project_db.reader(native) as reader:
                    reader.execute("BEGIN")
                    self.assertTrue(reader.execute("PRAGMA table_info(probe)").fetchall())
                # Alternate spellings while retaining concurrent connection churn.
                target = native if index % 2 else ordinary
                with closing(project_db.open_database(target)) as writer, writer:
                    writer.execute("PRAGMA journal_mode=WAL")
                    writer.execute("INSERT INTO probe VALUES (?)", (index,))

            with ThreadPoolExecutor(max_workers=CONNECTION_WORKERS) as pool:
                list(pool.map(append, range(1, CONNECTION_BATCH_SIZE * CONNECTION_BATCHES + 1)))
            with project_db.reader(native) as reader:
                self.assertEqual(
                    reader.execute("SELECT count(*) FROM probe").fetchone()[0],
                    CONNECTION_BATCH_SIZE * CONNECTION_BATCHES + 1,
                )
                self.assertEqual(reader.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_read_only_and_existing_modes_never_create_a_missing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "missing.sqlite3"
            for mode in (project_db.DatabaseMode.READ_ONLY, project_db.DatabaseMode.EXISTING):
                with self.subTest(mode=mode), self.assertRaises(sqlite3.OperationalError):
                    project_db.open_database(database, mode=mode)
                self.assertFalse(database.exists())
            database = Path(directory) / "missing-directory" / "missing.sqlite3"
            with self.assertRaises(sqlite3.OperationalError):
                project_db.open_database(database)
            self.assertFalse(database.parent.exists())

    @unittest.skipUnless(os.name == "nt", "native Windows verbatim filename semantics")
    def test_ambiguous_verbatim_filename_is_rejected_without_changing_its_meaning(self):
        for filename in (
            r"\\?\C:\state\database. ",
            r"\\?\C:\state\db:stream",
            r"\\?\C:\state\NUL.sqlite3",
        ):
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                project_db.open_database(filename)


class InspectionFilesContract(unittest.TestCase):
    def test_runtime_schema_reobserves_retired_sidecar_without_accepting_it(self):
        for persistent in (False, True):
            with self.subTest(persistent=persistent), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                database = root / "state" / "db.sqlite3"
                store = VersionStore(database, root)
                store.ensure()
                original = Path.lstat
                observations = []

                def observe(path, *args, **kwargs):
                    if path == Path(str(database) + "-shm") and (persistent or not observations):
                        observations.append(path)
                        info = original(database)
                        return SimpleNamespace(
                            st_mode=info.st_mode,
                            st_nlink=0,
                            st_dev=info.st_dev,
                            st_ino=info.st_ino,
                            st_file_attributes=0,
                        )
                    return original(path, *args, **kwargs)

                with patch.object(Path, "lstat", observe):
                    if persistent:
                        with self.assertRaises(project_db.DatabaseBindingError):
                            store.ensure()
                        self.assertGreater(len(observations), 1)
                        self.assertLessEqual(len(observations), 8)
                    else:
                        store.ensure()
                        self.assertEqual(len(observations), 1)
                with project_db.reader(database) as connection:
                    self.assertEqual(connection.execute("PRAGMA quick_check").fetchone()[0], "ok")

    def test_retired_sidecar_is_classified_but_main_and_unsafe_files_are_not(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            for links in (0, 2):
                with (
                    self.subTest(suffix=suffix, links=links),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    database = Path(directory) / "db.sqlite3"
                    database.write_bytes(b"main")
                    target = Path(str(database) + suffix)
                    original = Path.lstat

                    def observe(path, *args, **kwargs):
                        if path == target:
                            info = original(database) if suffix else original(path)
                            return SimpleNamespace(
                                st_mode=info.st_mode,
                                st_nlink=links,
                                st_dev=info.st_dev,
                                st_ino=info.st_ino,
                                st_file_attributes=0,
                            )
                        return original(path, *args, **kwargs)

                    with patch.object(Path, "lstat", observe):
                        with self.assertRaises(project_db.DatabaseBindingError) as caught:
                            with project_db.database_files(database, stable_sidecars=False):
                                self.fail("an unsafe observation must not enter SQLite")
                    self.assertEqual(
                        isinstance(
                            caught.exception.__cause__, project_db.DatabaseSidecarChangedError
                        ),
                        bool(suffix) and links == 0,
                    )
                    self.assertIn("file=", str(caught.exception))
                    self.assertNotIn(directory, str(caught.exception))

    def test_binding_diagnostics_preserve_owner_error_and_classify_only_sidecars(self):
        class OwnerError(sqlite3.DatabaseError):
            pass

        for suffix in ("", "-wal", "-shm", "-journal"):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as directory:
                database = Path(directory) / "catalog.sqlite3"
                database.write_bytes(b"main")
                leaf = Path(str(database) + suffix)
                if suffix:
                    leaf.write_bytes(b"sidecar")
                replacement = Path(directory) / "replacement"
                replacement.write_bytes(b"new")
                with self.assertRaises(OwnerError) as caught:
                    with project_db.database_files(database, error_type=OwnerError):
                        os.replace(replacement, leaf)
                self.assertIn("role=" + (suffix or "main"), str(caught.exception))
                self.assertIn("before=", str(caught.exception))
                self.assertNotIn(directory, str(caught.exception))
                self.assertEqual(
                    isinstance(caught.exception.__cause__, project_db.DatabaseSidecarChangedError),
                    bool(suffix),
                )

    def test_owners_reject_unsafe_database_and_sidecars_before_open(self):
        for owner in (SessionCatalogStore, AssistantStore, ImportJobStore, VersionStore):
            for suffix in ("", "-wal", "-shm", "-journal"):
                for kind in ("symlink", "hardlink", "directory"):
                    with self.subTest(owner=owner.__name__, suffix=suffix, kind=kind):
                        with tempfile.TemporaryDirectory() as directory:
                            root = Path(directory)
                            database, outside = root / "db.sqlite3", root / "outside"
                            SessionCatalogStore(database)
                            AssistantStore(database)
                            ImportJobStore(database)
                            leaf = Path(str(database) + suffix)
                            if leaf.exists():
                                leaf.replace(outside)
                            else:
                                outside.write_bytes(b"must preserve external data")
                            before = outside.read_bytes()
                            if kind == "symlink":
                                leaf.symlink_to(outside)
                            elif kind == "hardlink":
                                os.link(outside, leaf)
                            else:
                                leaf.mkdir()
                            with patch(
                                "sqlite3.connect",
                                side_effect=AssertionError("opened unsafe database"),
                            ):
                                with self.assertRaises(sqlite3.DatabaseError):
                                    owner.inspect_schema(database)
                            self.assertEqual(outside.read_bytes(), before)

    def test_binding_changes_and_sqlite_sidecar_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "db.sqlite3"
            for suffix in ("-wal", "-shm", "-journal"):
                leaf = Path(str(database) + suffix)
                with (
                    self.subTest(orphan=suffix),
                    self.assertRaises(project_db.DatabaseBindingError),
                ):
                    with project_db.database_files(database) as present:
                        self.assertFalse(present)
                        leaf.write_bytes(b"new orphan")
                leaf.unlink()
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE item (id INTEGER)")
            for suffix in ("", "-wal", "-shm", "-journal"):
                leaf = Path(str(database) + suffix)
                if suffix:
                    leaf.write_bytes(b"sidecar")
                replacement = root / "replacement"
                replacement.write_bytes(b"different identity")
                with (
                    self.subTest(replaced=suffix),
                    self.assertRaises(project_db.DatabaseBindingError),
                ):
                    with project_db.database_files(database):
                        os.replace(replacement, leaf)
                if suffix:
                    leaf.unlink()
            # Normal sidecar appearance/removal is allowed while the main file stays bound.
            for suffix in ("-wal", "-shm", "-journal"):
                leaf = Path(str(database) + suffix)
                with project_db.database_files(database):
                    leaf.write_bytes(b"sidecar")
                with project_db.database_files(database):
                    leaf.unlink()

    def test_live_binding_checks_still_reject_unsafe_files(self):
        for suffix in ("", "-wal", "-shm", "-journal"):
            for kind in ("symlink", "hardlink", "directory"):
                with (
                    self.subTest(suffix=suffix, kind=kind),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    root = Path(directory)
                    database = root / "db.sqlite3"
                    database.write_bytes(b"existing")
                    outside = root / "outside"
                    outside.write_bytes(b"preserve")
                    leaf = Path(str(database) + suffix)
                    with self.assertRaises(project_db.DatabaseBindingError):
                        with project_db.database_files(database, stable_sidecars=False):
                            if not suffix:
                                leaf.unlink()
                            if kind == "symlink":
                                leaf.symlink_to(outside)
                            elif kind == "hardlink":
                                os.link(outside, leaf)
                            else:
                                leaf.mkdir()
                    self.assertEqual(outside.read_bytes(), b"preserve")
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "db.sqlite3"
            replacement = Path(directory) / "replacement"
            database.write_bytes(b"old")
            replacement.write_bytes(b"new")
            with self.assertRaises(project_db.DatabaseBindingError):
                with project_db.database_files(database, stable_sidecars=False):
                    os.replace(replacement, database)
            database.unlink()
            with self.assertRaises(project_db.DatabaseBindingError):
                with project_db.database_files(database, stable_sidecars=False):
                    Path(str(database) + "-wal").write_bytes(b"orphan")

    def test_live_version_check_allows_sqlite_sidecar_rotation(self):
        from service.resources.persistence import version

        for strict in (False, True):
            with self.subTest(strict=strict), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                database = root / PROJECT_DB_RELATIVE
                store = VersionStore(database, root)
                store.ensure()
                keeper = project_db.connect(database)
                self.addCleanup(keeper.close)
                keeper.execute("SELECT * FROM resources_objects").fetchall()
                original_reader = project_db.reader

                @contextmanager
                def rotate_after_close(path):
                    nonlocal keeper
                    with original_reader(path) as connection:
                        yield connection
                    keeper.close()
                    # Let SQLite remove and recreate its own WAL/SHM; do not
                    # replace files manually or fabricate native identities.
                    keeper = project_db.connect(database)
                    self.addCleanup(keeper.close)
                    keeper.execute("SELECT * FROM resources_objects").fetchall()

                try:
                    with patch.object(project_db, "reader", rotate_after_close):
                        if strict:
                            with self.assertRaises(project_db.DatabaseBindingError):
                                store.inspect_schema(database)
                        else:
                            store.ensure()
                finally:
                    keeper.close()

    def test_owners_reject_replacement_after_reader_closed(self):
        for owner in (SessionCatalogStore, AssistantStore, ImportJobStore):
            with self.subTest(owner=owner.__name__), tempfile.TemporaryDirectory() as directory:
                database = Path(directory) / "db.sqlite3"
                replacement = Path(directory) / "replacement.sqlite3"
                SessionCatalogStore(database)
                AssistantStore(database)
                ImportJobStore(database)
                replacement.write_bytes(database.read_bytes())
                original_reader = project_db.reader

                @contextmanager
                def replace_after_close(
                    path,
                    original_reader=original_reader,
                    replacement=replacement,
                    database=database,
                ):
                    with original_reader(path) as connection:
                        yield connection
                    os.replace(replacement, database)

                with patch(owner.__module__ + ".reader", replace_after_close):
                    with self.assertRaises(project_db.DatabaseBindingError):
                        owner.inspect_schema(database)

    def test_missing_database_with_sidecars_is_not_empty(self):
        for owner in (SessionCatalogStore, AssistantStore, ImportJobStore):
            for suffix in ("-wal", "-shm", "-journal"):
                with self.subTest(owner=owner.__name__, suffix=suffix):
                    with tempfile.TemporaryDirectory() as directory:
                        database = Path(directory) / "missing.sqlite3"
                        sidecar = Path(str(database) + suffix)
                        sidecar.write_bytes(b"unrecovered data")
                        with self.assertRaises(sqlite3.DatabaseError):
                            owner.inspect_schema(database)
                        self.assertFalse(database.exists())
                        self.assertEqual(sidecar.read_bytes(), b"unrecovered data")


def main() -> int:
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    )
    if not result.wasSuccessful():
        return 1
    root = Path(tempfile.mkdtemp(prefix="project-database-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()

    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    content = ContentService(registry, catalog, activities=Activities())

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
