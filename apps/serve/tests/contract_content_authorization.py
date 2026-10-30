"""关联根授权与删除接缝契约 (proposal 47 §5.1 / §6.6)。

这套件守的是「能写用户项目外文件」这项能力的四条边界:

1. 授权必须显式登记、可枚举, 并且**留痕** (软撤销, 行不删);
2. 挂载点与真实同名目录冲突时直接拒绝, 不静默避让也不遮蔽用户目录;
3. `writable_roots()` 是主进程白名单与 Agent 沙箱 `sandboxPolicy` 的**同一**
   来源 —— 两套来源必然漂移成一处能写一处不能写;
4. 删除令牌一次性、短时效, 渲染层拿不到绝对路径。
"""

from __future__ import annotations

import errno
import io
import os
import sqlite3
import tempfile
from contextlib import closing, contextmanager
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch

from service.content.domain.model import (
    MANAGED_RESOURCES_ROOT_RELATIVE,
    ContentError,
    ContentReadPermissionError,
)
from service.content.persistence.catalog import (
    AUDIT_AUTHORIZE,
    AUDIT_REVOKE,
    CatalogFormatError,
    ContentCatalog,
)
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.token import TrashTokenVault
from service.platform.activity import Activities
from service.platform.content import AssetKind, AssetOrigin, RootKind
from service.platform.storage import DirectoryHandle

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


def code_of(action) -> str:
    try:
        action()
    except ContentError as exc:
        return exc.code
    return ""


def test_root_inventory(root: Path) -> None:
    missing = root / "missing" / "content.sqlite3"
    check(
        "根发现不创建缺失catalog",
        not ContentCatalog.read_roots(missing).present and not missing.parent.exists(),
    )
    database = root / "inventory.sqlite3"
    ContentCatalog(database)
    with closing(sqlite3.connect(database)) as writer:
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute(
            "INSERT INTO projects (project_id, display_name, dir_root, layout, created_at, seeded_from, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("offline", "offline", str(root / "unavailable"), "managed", 1, None, 1),
        )
        for identity, kind, revoked in (
            ("file", "file", None),
            ("directory", "dir", None),
            ("revoked", "dir", 1),
        ):
            writer.execute(
                "INSERT INTO external_roots VALUES (?, ?, ?, ?, ?, ?, ?)",
                (identity, "offline", str(root / identity), identity, kind, 1, revoked),
            )
        writer.commit()
        wal = Path(str(database) + "-wal")
        before = (database.read_bytes(), wal.read_bytes())
        inventory = ContentCatalog.read_roots(database)
        check(
            "根发现读取WAL内尚未checkpoint项目且保留离线归档根",
            inventory.present and inventory.projects == (("offline", root / "unavailable"),),
        )
        check(
            "根发现保留文件类型并排除已撤销授权",
            inventory.external
            == (
                ("directory", "offline", root / "directory", AssetKind.DIR),
                ("file", "offline", root / "file", AssetKind.FILE),
            ),
        )
        check("根发现不迁移或改写database/WAL", before == (database.read_bytes(), wal.read_bytes()))
        writer.execute("UPDATE projects SET dir_root='relative'")
        writer.commit()
        rejected = False
        try:
            ContentCatalog.read_roots(database)
        except CatalogFormatError:
            rejected = True
        check("根发现拒绝无效项目路径而非丢行", rejected)
        writer.execute("UPDATE projects SET dir_root=?", (str(root / "unavailable"),))
        writer.execute("UPDATE external_roots SET source_kind='unknown' WHERE root_id='file'")
        writer.commit()
        rejected = False
        try:
            ContentCatalog.read_roots(database)
        except CatalogFormatError:
            rejected = True
        check("根发现拒绝未知文件类型", rejected)
    broken = root / "broken.sqlite3"
    broken.write_bytes(b"not a SQLite database")
    rejected = False
    try:
        ContentCatalog.read_roots(broken)
    except sqlite3.DatabaseError:
        rejected = True
    check(
        "根发现不把损坏catalog当空库", rejected and broken.read_bytes() == b"not a SQLite database"
    )


def test_inventory_files(root: Path) -> None:
    for suffix in ("", "-wal", "-shm", "-journal"):
        for kind in ("symlink", "hardlink", "directory"):
            case = root / ("leaf-" + (suffix or "db") + "-" + kind)
            case.mkdir()
            database = case / "content.sqlite3"
            ContentCatalog(database)
            leaf = Path(str(database) + suffix)
            target = case / "outside.sqlite3"
            if leaf.exists():
                leaf.replace(target)
            else:
                target.write_bytes(b"outside data must not change")
            original = target.read_bytes()
            if kind == "symlink":
                leaf.symlink_to(target)
            elif kind == "hardlink":
                os.link(target, leaf)
            else:
                leaf.mkdir()
            rejected = False
            try:
                ContentCatalog.read_roots(database)
            except CatalogFormatError:
                rejected = True
            except sqlite3.DatabaseError:
                pass
            check(f"catalog拒绝{suffix or '主库'}的{kind}", rejected)
            check(f"catalog保留{suffix or '主库'}的{kind}外部字节", target.read_bytes() == original)

    for suffix in ("-wal", "-shm", "-journal"):
        missing = root / ("orphan" + suffix + ".sqlite3")
        sidecar = Path(str(missing) + suffix)
        sidecar.write_bytes(b"unrecovered data")
        rejected = False
        try:
            ContentCatalog.read_roots(missing)
        except CatalogFormatError:
            rejected = True
        check(
            f"catalog缺失主库但有{suffix}时拒绝当空库",
            rejected and not missing.exists() and sidecar.read_bytes() == b"unrecovered data",
        )
    dangling = root / "dangling.sqlite3"
    dangling.symlink_to(root / "absent.sqlite3")
    rejected = False
    try:
        ContentCatalog.read_roots(dangling)
    except CatalogFormatError:
        rejected = True
    check("catalog悬空链接不被当作新库", rejected and dangling.is_symlink())

    database = root / "replacement.sqlite3"
    replacement = root / "new.sqlite3"
    ContentCatalog(database)
    ContentCatalog(replacement)

    @contextmanager
    def replace_after_close(connection):
        inspected_path = connection.execute("PRAGMA database_list").fetchone()[2]
        try:
            yield connection
        finally:
            connection.close()
            if inspected_path and Path(inspected_path) == database:
                os.replace(replacement, database)

    rejected = False
    with patch("service.content.persistence.catalog.closing", replace_after_close):
        try:
            ContentCatalog.read_roots(database)
        except CatalogFormatError:
            rejected = True
    check("catalog读取结束后主库替换不得返回旧清单", rejected)


def test_root_migration_dependents(root: Path) -> None:
    path = root / "dependent-roots.sqlite3"
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE external_roots (
                root_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL,
                mount_path TEXT NOT NULL, authorized_at REAL NOT NULL, revoked_at REAL NULL,
                UNIQUE(project_id, source_path), UNIQUE(project_id, mount_path));
            INSERT INTO external_roots VALUES('root','project','/source','resources/source',1,NULL);
            CREATE TABLE root_notes(root_id TEXT REFERENCES external_roots(root_id) ON DELETE CASCADE,
                note TEXT);
            INSERT INTO root_notes VALUES('root','keep this note');
            CREATE TABLE root_changes(root_id TEXT);
            CREATE INDEX external_roots_authorized ON external_roots(authorized_at);
            CREATE TRIGGER remember_root_change AFTER UPDATE ON external_roots
                BEGIN INSERT INTO root_changes VALUES(NEW.root_id); END;
        """)
        before = connection.execute(
            "SELECT name,sql FROM sqlite_master WHERE name IN ('external_roots_authorized','remember_root_change') ORDER BY name"
        ).fetchall()
    with patch.object(
        ContentCatalog, "_ensure_external_root_kind", side_effect=RuntimeError("interrupted")
    ):
        try:
            ContentCatalog(path)
        except RuntimeError as error:
            check("授权依赖迁移中断传播", str(error) == "interrupted")
        else:
            check("授权依赖迁移中断传播", False)
    with closing(sqlite3.connect(path)) as connection:
        check(
            "授权依赖迁移中断保留子表",
            connection.execute("SELECT * FROM root_notes").fetchall()
            == [("root", "keep this note")],
        )
        check(
            "授权依赖迁移中断保留索引和触发器",
            connection.execute(
                "SELECT name,sql FROM sqlite_master WHERE name IN ('external_roots_authorized','remember_root_change') ORDER BY name"
            ).fetchall()
            == before,
        )
    ContentCatalog(path)
    with closing(sqlite3.connect(path)) as connection, connection:
        check(
            "授权迁移保留外键子表数据",
            connection.execute("SELECT * FROM root_notes").fetchall()
            == [("root", "keep this note")],
        )
        check(
            "授权迁移保留原外键目标",
            connection.execute("PRAGMA foreign_key_list(root_notes)").fetchone()[2]
            == "external_roots",
        )
        check(
            "授权迁移保留显式索引和触发器",
            connection.execute(
                "SELECT name,sql FROM sqlite_master WHERE name IN ('external_roots_authorized','remember_root_change') ORDER BY name"
            ).fetchall()
            == before,
        )
        connection.execute("UPDATE external_roots SET authorized_at=2 WHERE root_id='root'")
        check(
            "授权迁移后触发器仍实际执行",
            connection.execute("SELECT root_id FROM root_changes").fetchall() == [("root",)],
        )
        check("授权迁移外键完整", connection.execute("PRAGMA foreign_key_check").fetchall() == [])


def test_root_migration_residue(root: Path) -> None:
    for suffix in ("_old", "_schema_rebuild", "_foreign_key_migration"):
        path = root / ("residue" + suffix + ".sqlite3")
        table = "external_roots" + suffix
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute(f"CREATE TABLE {table}(payload TEXT)")
            connection.execute(f"INSERT INTO {table} VALUES('must recover')")
        rejected = False
        try:
            ContentCatalog(path)
        except (RuntimeError, CatalogFormatError):
            rejected = True
        with closing(sqlite3.connect(path)) as connection:
            check(
                f"拒绝授权迁移残留{suffix}且不创建新表",
                rejected
                and connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
                == [(table,)],
            )
            check(
                f"保留授权迁移残留{suffix}原始行",
                connection.execute(f"SELECT * FROM {table}").fetchall() == [("must recover",)],
            )


def test_catalog_schema_inspection(root: Path) -> None:
    missing = root / "absent-home" / "content.sqlite3"
    schema = ContentCatalog.inspect_schema(missing)
    check(
        "只读分类缺失库要求初始化且不创建目录",
        schema.needs_write
        and set(schema.create_tables)
        == {
            "projects",
            "external_roots",
            "event_cursor",
            "audit",
            "root_receipts",
            "content_operations",
            "content_operation_effects",
            "authorization_reconciliations",
            "project_removals",
            "project_creations",
        }
        and not missing.parent.exists(),
    )
    path = root / "schema-current.sqlite3"
    ContentCatalog(path)
    before = path.read_bytes()
    check("只读分类当前库不要求结构写入", not ContentCatalog.inspect_schema(path).needs_write)
    check("只读分类当前库保留字节", path.read_bytes() == before)
    with closing(sqlite3.connect(path)) as writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("ALTER TABLE projects ADD COLUMN future_scope TEXT")
        writer.commit()
        wal = Path(str(path) + "-wal")
        before = path.read_bytes(), wal.read_bytes()
        rejected = False
        try:
            ContentCatalog.inspect_schema(path)
        except CatalogFormatError:
            rejected = True
        check(
            "只读分类看到WAL内未知项目列且保留主库和WAL",
            rejected and before == (path.read_bytes(), wal.read_bytes()),
        )
    legacy = root / "schema-legacy.sqlite3"
    with closing(sqlite3.connect(legacy)) as connection, connection:
        connection.execute(
            "CREATE TABLE external_roots(root_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_path TEXT NOT NULL,mount_path TEXT NOT NULL,authorized_at REAL NOT NULL,revoked_at REAL NULL,UNIQUE(project_id,source_path),UNIQUE(project_id,mount_path))"
        )
    before = legacy.read_bytes()
    schema = ContentCatalog.inspect_schema(legacy)
    check(
        "只读分类定位旧授权重建及补列",
        schema.rebuild_external_roots
        and ("external_roots", "source_kind") in schema.add_columns
        and before == legacy.read_bytes(),
    )
    ContentCatalog(legacy)
    check("迁移与只读分类使用同一最终规则", not ContentCatalog.inspect_schema(legacy).needs_write)
    comment = root / "schema-comment.sqlite3"
    with closing(sqlite3.connect(comment)) as connection, connection:
        connection.execute(
            "CREATE TABLE external_roots(root_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_path TEXT NOT NULL,mount_path TEXT NOT NULL,source_kind TEXT NOT NULL DEFAULT 'dir',authorized_at REAL NOT NULL,revoked_at REAL NULL /* UNIQUE is only a comment */)"
        )
    check(
        "SQL注释UNIQUE不触发授权表重建",
        not ContentCatalog.inspect_schema(comment).rebuild_external_roots,
    )
    unknown = root / "schema-constraint.sqlite3"
    with closing(sqlite3.connect(unknown)) as connection, connection:
        connection.execute(
            "CREATE TABLE external_roots(root_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_path TEXT NOT NULL,mount_path TEXT NOT NULL,authorized_at REAL NOT NULL,revoked_at REAL NULL,UNIQUE(authorized_at))"
        )
    before = unknown.read_bytes()
    rejected = False
    try:
        ContentCatalog.inspect_schema(unknown)
    except CatalogFormatError:
        rejected = True
    check("未知授权唯一约束拒绝而非删除", rejected and unknown.read_bytes() == before)


def test_root_rebuild_definition(root: Path) -> None:
    declaration = (
        "CREATE TABLE external_roots(root_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,"
        "source_path TEXT NOT NULL,mount_path TEXT NOT NULL,authorized_at REAL NOT NULL,"
        "revoked_at REAL NULL,UNIQUE(project_id,source_path),UNIQUE(project_id,mount_path))"
    )
    variants = {
        "column-check": declaration.replace(
            "REAL NOT NULL", "REAL NOT NULL CHECK(authorized_at >= 0)"
        ),
        "table-check": declaration[:-1] + ", CHECK(authorized_at >= 0))",
        "reference": declaration.replace(
            "project_id TEXT NOT NULL", "project_id TEXT NOT NULL REFERENCES owners(id)"
        ),
        "collation": declaration.replace(
            "mount_path TEXT NOT NULL", "mount_path TEXT NOT NULL COLLATE NOCASE"
        ),
        "conflict": declaration.replace(
            "root_id TEXT PRIMARY KEY", "root_id TEXT PRIMARY KEY ON CONFLICT REPLACE"
        ),
        "descending": declaration.replace(
            "root_id TEXT PRIMARY KEY", "root_id TEXT PRIMARY KEY DESC"
        ),
    }
    for name, sql in variants.items():
        path = root / f"definition-{name}.sqlite3"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(sql)
            connection.execute(
                "INSERT INTO external_roots VALUES('root','project','/source','mount',1,NULL)"
            )
        before = path.read_bytes()
        rejected = False
        try:
            ContentCatalog.inspect_schema(path)
        except CatalogFormatError:
            rejected = True
        check(f"重建预检拒绝未知定义 {name}", rejected and before == path.read_bytes())
        rejected = False
        try:
            ContentCatalog(path)
        except CatalogFormatError:
            rejected = True
        check(f"实际初始化拒绝丢失定义 {name} 且保留原库", rejected and before == path.read_bytes())
    path = root / "definition-quoted.sqlite3"
    quoted = (
        declaration.replace("external_roots", '"external_roots"')
        .replace("root_id", "[root_id]")
        .replace("source_path", "`source_path`")
    )
    quoted = quoted.replace("REAL NOT NULL", "REAL /* CHECK('odd, /* text') */ NOT NULL")
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute(quoted)
    check(
        "带注释与标识符引号的已知旧定义允许迁移",
        ContentCatalog.inspect_schema(path).rebuild_external_roots,
    )
    ContentCatalog(path)
    check("已知旧定义迁移后无需再改结构", not ContentCatalog.inspect_schema(path).needs_write)


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="content-authorization-")).resolve()
    test_root_inventory(root)
    test_inventory_files(root)
    test_root_migration_dependents(root)
    test_root_migration_residue(root)
    test_catalog_schema_inspection(root)
    test_root_rebuild_definition(root)
    workspace = root / "workspace"
    workspace.mkdir()
    external = root / "外部资料"
    external.mkdir()
    (external / "原始文件.md").write_text("外部内容", encoding="utf-8")

    legacy_database = root / "legacy-content.sqlite3"
    with sqlite3.connect(legacy_database) as connection:
        connection.execute(
            "CREATE TABLE external_roots ("
            "root_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL,"
            "mount_path TEXT NOT NULL, authorized_at REAL NOT NULL, revoked_at REAL NULL)"
        )
        connection.execute(
            "INSERT INTO external_roots"
            " (root_id, project_id, source_path, mount_path, authorized_at, revoked_at)"
            " VALUES (?, ?, ?, ?, ?, NULL)",
            ("legacy-root", "legacy-project", str(external), "resources/外部资料", 1.0),
        )
    migrated_row = ContentCatalog(legacy_database).external_root("legacy-root")
    check(
        "存量目录授权幂等补 kind=dir 且保留原行",
        migrated_row is not None and migrated_row.kind is AssetKind.DIR,
    )

    for with_kind in (False, True):
        unique_database = root / f"unique-{with_kind}.sqlite3"
        kind_column = ", source_kind TEXT NOT NULL DEFAULT 'dir'" if with_kind else ""
        with closing(sqlite3.connect(unique_database)) as connection, connection:
            connection.execute(
                "CREATE TABLE external_roots ("
                "root_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL,"
                "mount_path TEXT NOT NULL, authorized_at REAL NOT NULL, revoked_at REAL NULL"
                + kind_column
                + ", UNIQUE(project_id, source_path), UNIQUE(project_id, mount_path))"
            )
            for index, kind in enumerate((AssetKind.FILE, AssetKind.DIR)):
                values = (
                    f"root-{index}",
                    "project",
                    f"/source-{index}",
                    f"resources/item-{index}",
                    10.0 + index,
                    20.0 if index else None,
                )
                connection.execute(
                    "INSERT INTO external_roots VALUES ("
                    + ",".join("?" for _ in values)
                    + (",?" if with_kind else "")
                    + ")",
                    (*values, kind.value) if with_kind else values,
                )
        with closing(sqlite3.connect(unique_database)) as connection, connection:
            original_schema = connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
            ).fetchall()
            original_rows = connection.execute(
                "SELECT * FROM external_roots ORDER BY root_id"
            ).fetchall()
        interrupted_database = root / f"interrupted-{with_kind}.sqlite3"
        with closing(sqlite3.connect(interrupted_database)) as connection, connection:
            for _, statement in original_schema:
                connection.execute(statement)
            connection.executemany(
                "INSERT INTO external_roots VALUES ("
                + ",".join("?" for _ in original_rows[0])
                + ")",
                original_rows,
            )
        with patch.object(
            ContentCatalog,
            "_ensure_external_root_kind",
            side_effect=RuntimeError("migration interrupted"),
        ):
            try:
                ContentCatalog(interrupted_database)
            except RuntimeError as error:
                check("迁移异常保留原错误", str(error) == "migration interrupted")
            else:
                check("迁移异常必须向上传播", False)
        with closing(sqlite3.connect(interrupted_database)) as connection, connection:
            restored_schema = connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
            ).fetchall()
            restored_rows = connection.execute(
                "SELECT * FROM external_roots ORDER BY root_id"
            ).fetchall()
        check(
            f"中断迁移回滚原schema与数据 kind={with_kind}",
            restored_schema == original_schema and restored_rows == original_rows,
        )
        ContentCatalog(interrupted_database)
        with closing(sqlite3.connect(interrupted_database)) as connection, connection:
            recovered_rows = connection.execute(
                "SELECT root_id, project_id, source_path, mount_path, authorized_at,"
                " revoked_at, source_kind FROM external_roots ORDER BY root_id"
            ).fetchall()
        for attempt in range(2):
            migrated = ContentCatalog(unique_database)
            with closing(sqlite3.connect(unique_database)) as connection, connection:
                rows = connection.execute(
                    "SELECT root_id, project_id, source_path, mount_path, authorized_at,"
                    " revoked_at, source_kind FROM external_roots ORDER BY root_id"
                ).fetchall()
            expected = [
                (
                    f"root-{index}",
                    "project",
                    f"/source-{index}",
                    f"resources/item-{index}",
                    10.0 + index,
                    20.0 if index else None,
                    kind.value if with_kind else AssetKind.DIR.value,
                )
                for index, kind in enumerate((AssetKind.FILE, AssetKind.DIR))
            ]
            if attempt == 0:
                check(f"中断后正常重试保留完整行 kind={with_kind}", recovered_rows == expected)
            check(
                f"旧 UNIQUE 迁移保留授权完整行 kind={with_kind} attempt={attempt}",
                rows == expected,
                str(rows),
            )
            check(
                f"旧 UNIQUE 迁移后文件类型不扩大为目录 kind={with_kind} attempt={attempt}",
                migrated.external_root("root-0").kind
                is (AssetKind.FILE if with_kind else AssetKind.DIR),
            )

    for declaration in (
        "future_scope TEXT DEFAULT 'retain-me'",
        "future_scope TEXT GENERATED ALWAYS AS (source_path) VIRTUAL",
    ):
        unknown_database = root / (
            "unknown-generated.sqlite3" if "GENERATED" in declaration else "unknown-column.sqlite3"
        )
        with closing(sqlite3.connect(unknown_database)) as connection, connection:
            connection.execute(
                "CREATE TABLE external_roots ("
                "root_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL,"
                "mount_path TEXT NOT NULL, authorized_at REAL NOT NULL, revoked_at REAL NULL,"
                + declaration
                + ", UNIQUE(project_id, source_path))"
            )
            connection.execute(
                "INSERT INTO external_roots (root_id,project_id,source_path,mount_path,authorized_at)"
                " VALUES ('future-root','project','/selected','resources/selected',1)"
            )
            original_schema = connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
            ).fetchall()
            original_rows = connection.execute("SELECT * FROM external_roots").fetchall()
        try:
            ContentCatalog(unknown_database)
        except sqlite3.DatabaseError as error:
            check(
                "未知授权列明确拒绝迁移",
                "unsupported external root schema" in str(error),
                str(error),
            )
        else:
            check("未知授权列明确拒绝迁移", False)
        with closing(sqlite3.connect(unknown_database)) as connection, connection:
            check(
                "未知授权格式保留schema和完整行",
                connection.execute(
                    "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name"
                ).fetchall()
                == original_schema
                and connection.execute("SELECT * FROM external_roots").fetchall() == original_rows,
            )

    database = root / "content.sqlite3"
    catalog = ContentCatalog(database)
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    project = content.create_project("授权测试")
    directory = Path(project.root)

    resource_directory = directory / MANAGED_RESOURCES_ROOT_RELATIVE
    resource_directory.rmdir()
    check(
        "资源根路径查询不补建目录",
        content.root_path(project.id, RootKind.RESOURCES) == MANAGED_RESOURCES_ROOT_RELATIVE
        and not resource_directory.exists(),
    )
    content.root(project.id, RootKind.RESOURCES)
    check("显式根准备仍创建目录", resource_directory.is_dir())

    streamed = directory / MANAGED_RESOURCES_ROOT_RELATIVE / "流式版本.bin"
    streamed_payload = b"streamed-version\0" * 131_072
    streamed.write_bytes(streamed_payload)
    with tempfile.TemporaryFile() as captured:
        capture = content.capture_stable(
            project.id,
            f"{MANAGED_RESOURCES_ROOT_RELATIVE}/流式版本.bin",
            len(streamed_payload),
            captured,
        )
        check("稳定采集返回完整大小", capture.size == len(streamed_payload))
        check(
            "稳定采集返回原始字节摘要",
            capture.revision == f"sha256:{sha256(streamed_payload).hexdigest()}",
            capture.revision,
        )
        check("稳定采集写入调用方流", captured.read() == streamed_payload)

    with (
        closing(sqlite3.connect(database)) as source,
        closing(sqlite3.connect(":memory:")) as copied,
    ):
        source.backup(copied)
        copied.row_factory = sqlite3.Row
        original_rows = tuple(source.iterdump())
        plan = ContentCatalog.project_row(copied, project.id)
        assert plan is not None
        reference = ProjectRegistry.creation_result(plan)
        mounts = ContentCatalog.external_root_rows(copied, project.id)
        scope = ContentService.project_space(reference, mounts)
        with (
            patch.object(
                ContentCatalog,
                "_connect",
                side_effect=AssertionError("private capture reopened catalog"),
            ),
            io.BytesIO() as captured,
        ):
            preview = ContentService.capture_from_space(
                scope,
                project.id,
                f"{MANAGED_RESOURCES_ROOT_RELATIVE}/流式版本.bin",
                len(streamed_payload),
                captured,
            )
            check(
                "私有目录视图复用实际稳定采集",
                preview == capture and captured.read() == streamed_payload,
            )
        check(
            "私有采集不修改目录记录或源文件",
            tuple(source.iterdump()) == original_rows and streamed.read_bytes() == streamed_payload,
        )

        def expired():
            raise TimeoutError("capture deadline")

        with io.BytesIO() as captured:
            try:
                ContentService.capture_from_space(
                    scope,
                    project.id,
                    f"{MANAGED_RESOURCES_ROOT_RELATIVE}/流式版本.bin",
                    len(streamed_payload),
                    captured,
                    check=expired,
                )
            except TimeoutError:
                check("预检采集遵守调用方时限", captured.getvalue() == b"")
            else:
                check("预检采集遵守调用方时限", False)

    capture_path = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/流式版本.bin"
    for failure in (
        PermissionError(errno.EPERM, "Operation not permitted", str(streamed)),
        PermissionError(errno.EACCES, "Permission denied", str(streamed)),
    ):
        with (
            tempfile.TemporaryFile() as captured,
            patch.object(DirectoryHandle, "open", side_effect=failure),
        ):
            try:
                content.capture_stable(project.id, capture_path, len(streamed_payload), captured)
            except ContentReadPermissionError as error:
                check("权限拒绝保留现有读取失败码", error.code == "read_failed")
                check("权限拒绝只公开项目相对路径", error.path == capture_path)
                check("保留原始系统异常用于诊断", error.__cause__ is failure)
            else:
                check("不可读文件不得采集成功", False)
    with (
        tempfile.TemporaryFile() as captured,
        patch.object(DirectoryHandle, "open", side_effect=OSError(errno.EIO, "I/O error")),
    ):
        check(
            "普通读取失败不误报权限拒绝",
            code_of(lambda: content.capture_stable(project.id, capture_path, 1024, captured))
            == "read_failed",
        )

    # ---- 1. 登记、枚举、留痕 ----
    ref = content.authorize_root(project.id, str(external), "外部资料")
    check(
        "授权后挂载点落在资料库根下",
        ref.mount_path.startswith(f"{MANAGED_RESOURCES_ROOT_RELATIVE}/"),
        ref.mount_path,
    )
    check("挂载点相对项目根, 不是绝对路径", not ref.mount_path.startswith("/"))
    check("source_path 记的是外部真实绝对路径", ref.source_path == str(external))
    check(
        "外部根可枚举",
        [entry.root_id for entry in content.external_roots(project.id)] == [ref.root_id],
    )
    check("外部根可用性是实测的", ref.available is True)

    # ---- 2. 冲突与非法输入 ----
    (directory / MANAGED_RESOURCES_ROOT_RELATIVE / "真实目录").mkdir()
    check(
        "挂载点撞真实同名目录时拒绝, 不遮蔽",
        code_of(lambda: content.authorize_root(project.id, str(external), "真实目录"))
        == "mount_conflict",
    )
    check(
        "同一外部根重复授权被拒",
        code_of(lambda: content.authorize_root(project.id, str(external), "另一个名字"))
        == "root_exists",
    )
    inside = directory / MANAGED_RESOURCES_ROOT_RELATIVE / "项目内目录"
    inside.mkdir()
    check(
        "项目内目录不需要授权, 显式拒绝",
        code_of(lambda: content.authorize_root(project.id, str(inside), "项目内"))
        == "source_inside_project",
    )
    check(
        "包含项目的祖先目录不能被授权",
        code_of(lambda: content.authorize_root(project.id, str(workspace), "工作区"))
        == "source_contains_project",
    )
    check(
        "挂载名不得含路径分隔符",
        code_of(lambda: content.authorize_root(project.id, str(external), "a/b"))
        == "invalid_mount",
    )

    # ---- 3. writable_roots 是唯一来源 ----
    writable = content.writable_roots(project.id)
    check(
        "writable_roots = 项目根 + 有效关联根",
        writable == (str(directory), str(external)),
        str(writable),
    )

    # ---- 4. 撤销: 软撤销留痕, 立即从有效集合摘除 ----
    content.revoke_root(ref.root_id)
    check("撤销后外部根不再出现在有效集合", content.external_roots(project.id) == ())
    check(
        "撤销后 writable_roots 立即收缩 (产品面即时生效)",
        content.writable_roots(project.id) == (str(directory),),
    )
    check(
        "撤销是软撤销, 行仍在库里留痕",
        len(catalog.external_roots(project.id, include_revoked=True)) == 1
        and catalog.external_root(ref.root_id).revoked_at is not None,
    )
    check(
        "重复撤销被拒", code_of(lambda: content.revoke_root(ref.root_id)) == "root_already_revoked"
    )
    check("未知 root_id 被拒", code_of(lambda: content.revoke_root("nope")) == "unknown_root")
    actions = [str(row["action"]) for row in catalog.audit()]
    check(
        "授权与撤销都写了审计",
        AUDIT_AUTHORIZE in actions and AUDIT_REVOKE in actions,
        str(actions),
    )

    # ---- 5. 单文件挂载: 只授权所选文件, 不扩大到父目录 ----
    external_file = root / "单独文件.md"
    external_file.write_text("单文件原文", encoding="utf-8")
    file_ref = content.authorize_root(project.id, str(external_file), "单独文件.md")
    check("单文件可授权且契约记录 kind=file", file_ref.kind is AssetKind.FILE)
    check(
        "单文件种类落库, 重开 catalog 后不依赖当前文件状态猜测",
        ContentCatalog(database).external_root(file_ref.root_id).kind is AssetKind.FILE,
    )
    file_node = next(
        node
        for node in content.tree(project.id, RootKind.RESOURCES, 2).children
        if node.asset.path == file_ref.mount_path
    )
    check(
        "关联单文件作为 LINK 叶子出现在资料树",
        file_node.asset.kind is AssetKind.FILE
        and file_node.asset.origin is AssetOrigin.LINK
        and file_node.children == (),
    )
    check(
        "关联单文件按挂载路径可读",
        content.read_text(project.id, file_ref.mount_path) == "单文件原文",
    )
    content.write_text(project.id, file_ref.mount_path, "单文件已修改")
    check(
        "写关联单文件只修改用户选中的原文件",
        external_file.read_text(encoding="utf-8") == "单文件已修改",
    )
    check(
        "单文件挂载不能解析虚构子路径",
        code_of(lambda: content.resolve(project.id, f"{file_ref.mount_path}/越界.md"))
        == "path_outside_authorized_root",
    )
    check(
        "单文件授权白名单是文件本身, 不扩大到父目录",
        content.writable_roots(project.id) == (str(directory), str(external_file)),
        str(content.writable_roots(project.id)),
    )
    content.revoke_root(file_ref.root_id)

    # ---- 6. 删除令牌 ----
    (directory / MANAGED_RESOURCES_ROOT_RELATIVE / "待删.md").write_text("x", encoding="utf-8")
    token = content.issue_trash_token(project.id, f"{MANAGED_RESOURCES_ROOT_RELATIVE}/待删.md")
    check("令牌本身不含绝对路径", str(directory) not in token)
    check(
        "兑换回的绝对路径就是待删目标",
        content.redeem_trash_token(token)
        == str(directory / MANAGED_RESOURCES_ROOT_RELATIVE / "待删.md"),
    )
    check(
        "令牌用后即焚",
        code_of(lambda: content.redeem_trash_token(token)) == "invalid_trash_token",
    )
    check(
        "越界路径签不出令牌",
        code_of(lambda: content.issue_trash_token(project.id, "../外部资料/原始文件.md"))
        == "path_outside_project",
    )
    expired = TrashTokenVault(ttl=-1.0)
    stale = expired.issue(project.id, str(directory))
    check(
        "过期令牌不可兑换",
        code_of(lambda: expired.redeem(stale)) == "invalid_trash_token",
    )

    # ---- 7. 虚拟挂载: 单一相对基 + 作用于原始物理文件 ----
    # 撤销过的目录必须能再次授权: 留痕不等于永久拉黑 (唯一性只约束生效中的行)。
    mounted = content.authorize_root(project.id, str(external), "外部资料")
    check("撤销后同一目录与同一挂载名恢复原身份", mounted.root_id == ref.root_id)
    tree_nodes = content.tree(project.id, RootKind.RESOURCES, 3).children
    mount_node = next(node for node in tree_nodes if node.asset.name == "外部资料")
    check(
        "挂载点出现在树里, 路径仍相对项目根",
        mount_node.asset.path == mounted.mount_path and not mount_node.asset.path.startswith("/"),
        mount_node.asset.path,
    )
    check(
        "挂载点及其子节点标 origin=LINK",
        mount_node.asset.origin is AssetOrigin.LINK
        and all(child.asset.origin is AssetOrigin.LINK for child in mount_node.children),
    )
    check(
        "关联文件按挂载路径可读",
        content.read_text(project.id, f"{mounted.mount_path}/原始文件.md") == "外部内容",
    )
    content.write_text(project.id, f"{mounted.mount_path}/原始文件.md", "产品改的")
    check(
        "写关联文件落在原始物理文件上",
        (external / "原始文件.md").read_text(encoding="utf-8") == "产品改的",
    )
    renamed = content.rename(project.id, f"{mounted.mount_path}/原始文件.md", "改名后.md")
    check(
        "改名作用于原始物理路径",
        (external / "改名后.md").is_file()
        and not (external / "原始文件.md").exists()
        and renamed.origin is AssetOrigin.LINK,
    )
    check(
        "挂载点本身不可改名 (取消关联只能走撤销授权)",
        code_of(lambda: content.rename(project.id, mounted.mount_path, "别动"))
        == "cannot_modify_mount",
    )
    check(
        "关联根与关联后代均不能签发物理删除令牌",
        code_of(lambda: content.issue_trash_token(project.id, mounted.mount_path))
        == "cannot_trash_linked"
        and code_of(
            lambda: content.issue_trash_token(project.id, f"{mounted.mount_path}/改名后.md")
        )
        == "cannot_trash_linked",
    )
    check(
        "挂载内的越界路径被拒",
        code_of(
            lambda: content.read_text(project.id, f"{mounted.mount_path}/../../外部资料/改名后.md")
        )
        in {"path_outside_authorized_root", "path_outside_project", "file_not_found"},
    )
    sibling = root / "外部资料2"
    sibling.mkdir()
    (sibling / "无关.md").write_text("不该被当成关联根", encoding="utf-8")
    second = content.authorize_root(project.id, str(sibling), "外部资料2")
    check(
        "相邻同前缀挂载名各自解析, 不互相吞并",
        content.read_text(project.id, f"{second.mount_path}/无关.md") == "不该被当成关联根"
        and content.resolve(project.id, f"{mounted.mount_path}/改名后.md")
        == str(external / "改名后.md"),
    )
    (external / "同根移动.md").write_text("same", encoding="utf-8")
    (external / "子目录").mkdir()
    same_scope = content.move(
        project.id,
        f"{mounted.mount_path}/同根移动.md",
        f"{mounted.mount_path}/子目录",
    )
    check(
        "关联资料只可在同一个关联根内移动",
        same_scope.path == f"{mounted.mount_path}/子目录/同根移动.md"
        and (external / "子目录" / "同根移动.md").is_file(),
        same_scope.path,
    )
    check(
        "两个关联根之间移动被 Content 权威拒绝且原文件保留",
        code_of(
            lambda: content.move(
                project.id,
                same_scope.path,
                second.mount_path,
            )
        )
        == "move_scope_mismatch"
        and (external / "子目录" / "同根移动.md").is_file(),
    )
    unavailable_source = root / "即将失效的关联目录"
    unavailable_source.mkdir()
    unavailable = content.authorize_root(project.id, str(unavailable_source), "失效关联目录")
    unavailable_source.rename(root / "已移动的关联目录")
    check(
        "关联目录失效后新建返回可执行的稳定错误码且不改存项目内",
        code_of(
            lambda: content.create(
                project.id,
                unavailable.mount_path,
                "不应创建",
                AssetKind.FILE,
            )
        )
        == "authorized_root_unavailable"
        and not (
            directory / MANAGED_RESOURCES_ROOT_RELATIVE / "失效关联目录" / "不应创建.md"
        ).exists(),
    )
    # 挂载点位置出现真实同名目录: 以登记的挂载为准, 但必须标出冲突。
    (directory / MANAGED_RESOURCES_ROOT_RELATIVE / "外部资料").mkdir()
    conflicted = next(
        node
        for node in content.tree(project.id, RootKind.RESOURCES, 2).children
        if node.asset.name == "外部资料"
    )
    check("挂载点与真实同名目录冲突时标 conflict", conflicted.conflict is True)
    check(
        "冲突时只出一个节点, 不出两个同名节点",
        sum(
            1
            for node in content.tree(project.id, RootKind.RESOURCES, 2).children
            if node.asset.name == "外部资料"
        )
        == 1,
    )
    content.revoke_root(mounted.root_id)
    check(
        "撤销后挂载路径立即解析回项目内 (关联窗口关闭)",
        content.resolve(project.id, f"{MANAGED_RESOURCES_ROOT_RELATIVE}/外部资料")
        == str(directory / MANAGED_RESOURCES_ROOT_RELATIVE / "外部资料"),
    )
    check(
        "撤销后不可用的关联根在树里标 available=False",
        all(
            node.available
            for node in content.tree(project.id, RootKind.RESOURCES, 1).children
            if node.asset.name == "外部资料2"
        ),
    )

    # ---- 8. 嵌套关联包含检测: 同一物理文件不得经两个挂载得到两条身份 ----
    # 用户实测: 关联 A 后再关联 A 的子目录 B, 从两条路径打开 B 下同一文件会各自漂移。
    nest = root / "嵌套关联"
    nest_a = nest / "A"
    nest_b = nest_a / "B"
    nest_b.mkdir(parents=True)
    (nest_b / "c.md").write_text("c", encoding="utf-8")
    nest_sibling = root / "嵌套无关"
    nest_sibling.mkdir()

    a_ref = content.authorize_root(project.id, str(nest_a), "嵌套A")
    check("父目录可正常关联", a_ref.mount_path.endswith("/嵌套A"), a_ref.mount_path)
    check(
        "子目录落在已生效关联根子树内被拒 (正向包含)",
        code_of(lambda: content.authorize_root(project.id, str(nest_b), "嵌套B"))
        == "source_overlap",
    )
    check(
        "包含已生效关联根的上级目录报 source_covers_links (反向, 交用户选择)",
        code_of(lambda: content.authorize_root(project.id, str(nest), "嵌套上级"))
        == "source_covers_links",
    )
    check(
        "关联导入只读预检对正向已覆盖来源报 source_overlap",
        code_of(lambda: content.assert_import_roots_linkable(project.id, (str(nest_b),)))
        == "source_overlap",
    )
    check(
        "关联导入只读预检对反向来源报 source_covers_links",
        code_of(lambda: content.assert_import_roots_linkable(project.id, (str(nest),)))
        == "source_covers_links",
    )
    check(
        "不相交的目录仍可关联",
        content.authorize_root(project.id, str(nest_sibling), "嵌套无关").mount_path.endswith(
            "/嵌套无关"
        ),
    )
    check(
        "supersede 不能救正向: 子目录即便带 supersede 仍被拒",
        code_of(lambda: content.authorize_root(project.id, str(nest_b), "嵌套B", supersede=True))
        == "source_overlap",
    )

    super_ref = content.authorize_root(project.id, str(nest), "嵌套上级", supersede=True)
    active_sources = {entry.source_path for entry in content.external_roots(project.id)}
    check(
        "supersede 取代子关联: 父挂载生效且原子撤销被覆盖的子关联",
        super_ref.mount_path.endswith("/嵌套上级")
        and str(nest) in active_sources
        and str(nest_a) not in active_sources,
        sorted(active_sources),
    )
    check(
        "取代后子目录落在新父挂载子树内, 再关联子目录仍被正向拒绝",
        code_of(lambda: content.authorize_root(project.id, str(nest_b), "嵌套B"))
        == "source_overlap",
    )
    content.revoke_root(super_ref.root_id)
    check(
        "父级关联撤销后, 原子目录不再被判重叠",
        content.authorize_root(project.id, str(nest_b), "嵌套B").mount_path.endswith("/嵌套B"),
    )

    batch_parent = root / "批量父"
    batch_child = batch_parent / "子"
    batch_child.mkdir(parents=True)
    check(
        "同批次内父子一起关联被拒 (批内包含)",
        code_of(
            lambda: content.authorize_roots(
                project.id, (str(batch_parent), str(batch_child)), ("批量父", "批量子")
            )
        )
        == "source_overlap",
    )

    print(f"\ncontract_content_authorization: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
