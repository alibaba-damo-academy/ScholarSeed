"""项目身份层契约 (proposal 47 阶段一)。

守住四条会静默毁掉用户数据的边界:

1. 存量 (LEGACY) 项目的根解析取值与改造前逐字节一致 —— 否则老用户的资料树
   立刻空掉;
2. 新建 (MANAGED) 项目磁盘上真的出现资料库与文献库两处;
3. 改名只改显示名, 目录名一个字节都不动;
4. 身份只来自 `projects.project_id`, 位置只来自 `dir_root`, 时间只来自
   `created_at` —— 目录名不承载语义。
"""

from __future__ import annotations

import tempfile
import time
from pathlib import Path
from unittest.mock import patch

from service.content.domain import naming
from service.content.domain.model import (
    LITERATURE_ROOT_RELATIVE,
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
    RESOURCES_ROOT_RELATIVE,
    ContentError,
    resolve_root,
    root_relative,
)
from service.content.persistence.catalog import ContentCatalog
from service.content.service import native
from service.content.service.identity import (
    ASSET_TABLE,
    FILE_IDENTITY_PREFIX,
    _decode_file_identity,
    _encode_file_identity,
)
from service.content.service.port import ContentService, ProjectRegistry
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import transaction
from service.platform import storage
from service.platform.content import AssetState, ContentPort, ProjectLayout, RootKind

PASS = 0
FAIL = 0
SQLITE_MAX_INTEGER = (1 << 63) - 1
WINDOWS_MAX_DEVICE = (1 << 64) - 1
WINDOWS_MAX_INODE = (1 << 128) - 1
LEGACY_IDENTITY = 42


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="content-identity-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    legacy = root / "老项目"
    (legacy / LITERATURE_ROOT_RELATIVE).mkdir(parents=True)
    (legacy / "老资料.md").write_text("旧内容", encoding="utf-8")

    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_legacy(((legacy, "旧项目"),))
    registry.seed_workspace()
    content = ContentService(registry, catalog)

    identity_boundaries = (
        SQLITE_MAX_INTEGER,
        SQLITE_MAX_INTEGER + 1,
        WINDOWS_MAX_DEVICE,
        WINDOWS_MAX_INODE,
    )
    windows_inode = WINDOWS_MAX_INODE
    encoded_inode = _encode_file_identity(windows_inode)
    check(
        "SQLite 与 Windows 文件身份边界均可无损编码",
        encoded_inode.startswith(FILE_IDENTITY_PREFIX)
        and all(
            _decode_file_identity(_encode_file_identity(value)) == value
            for value in identity_boundaries
        ),
    )
    check(
        "旧版 SQLite INTEGER 文件身份仍可读取",
        _decode_file_identity(LEGACY_IDENTITY) == LEGACY_IDENTITY,
    )
    with transaction(root / "identity-affinity.sqlite3") as connection:
        connection.execute("CREATE TABLE identity_value (value INTEGER NOT NULL)")
        connection.execute("INSERT INTO identity_value VALUES (?)", (encoded_inode,))
        stored_identity = connection.execute(
            "SELECT value, typeof(value) AS storage FROM identity_value"
        ).fetchone()
    check(
        "旧 INTEGER affinity 列不会把带前缀身份降级为 REAL",
        stored_identity["storage"] == "text"
        and _decode_file_identity(stored_identity["value"]) == windows_inode,
    )

    check(
        "ContentService 结构性满足 ContentPort",
        isinstance(content, ContentPort),
    )

    # ---- 1. LEGACY 取值不变 ----
    check(
        "LEGACY 布局的两个根取值与改造前一致",
        root_relative(ProjectLayout.LEGACY, RootKind.RESOURCES) == RESOURCES_ROOT_RELATIVE
        and root_relative(ProjectLayout.LEGACY, RootKind.LITERATURE) == LITERATURE_ROOT_RELATIVE,
    )
    seeded = [entry for entry in content.projects() if entry.root == str(legacy)]
    check(
        "存量目录被种成 LEGACY 项目", len(seeded) == 1 and seeded[0].layout is ProjectLayout.LEGACY
    )
    legacy_ref = seeded[0]
    check(
        "LEGACY 项目的资料库根就是项目根本身",
        resolve_root(legacy_ref, RootKind.RESOURCES).absolute == legacy,
    )
    names = {
        node.asset.name for node in content.tree(legacy_ref.id, RootKind.RESOURCES, 2).children
    }
    check(
        "LEGACY 项目的资料树仍看得见根下资料",
        names == {"老资料.md", LITERATURE_ROOT_RELATIVE},
        str(names),
    )

    # ---- 2. MANAGED 内置双库 ----
    created = content.create_project("我的 研究/项目 2026")
    directory = Path(created.root)
    check(
        "新建项目磁盘上出现内置双库",
        (directory / MANAGED_RESOURCES_ROOT_RELATIVE).is_dir()
        and (directory / MANAGED_LITERATURE_ROOT_RELATIVE).is_dir(),
    )
    check("新建项目落在工作区根下", directory.parent == workspace)
    check("新建项目布局是 MANAGED", created.layout is ProjectLayout.MANAGED)
    check(
        "MANAGED 的资料库根是 resources/",
        resolve_root(created, RootKind.RESOURCES).absolute
        == directory / MANAGED_RESOURCES_ROOT_RELATIVE,
    )
    check(
        "root() 按种类回相对路径, 不泄露绝对路径",
        content.root(created.id, RootKind.LITERATURE).path == MANAGED_LITERATURE_ROOT_RELATIVE
        and content.root(legacy_ref.id, RootKind.LITERATURE).path == LITERATURE_ROOT_RELATIVE,
    )

    # ---- 3. 改名不动目录 ----
    before = directory.name
    renamed = content.rename_project(created.id, "换了个名字")
    check(
        "改名只改显示名, 目录名不动",
        renamed.name == "换了个名字"
        and Path(renamed.root).name == before
        and Path(renamed.root).is_dir(),
    )

    # ---- 3.1 归档只影响可见性 ----
    archived_ref = content.set_project_archived(created.id, True)
    check(
        "归档只写归档时间, 目录与布局不动",
        archived_ref.archived_at is not None
        and Path(archived_ref.root).name == before
        and Path(archived_ref.root).is_dir(),
    )
    check(
        "归档后路径反查与单查仍可用 (身份不受可见性影响)",
        content.project_for_path(str(directory)).id == created.id
        and content.project(created.id).archived_at is not None,
    )
    current_code = ""
    try:
        content.set_project_archived(content.project().id, True)
    except ContentError as exc:
        current_code = exc.code
    check("当前默认项目拒绝归档", current_code == "cannot_archive_current_project")
    check(
        "解归档可逆",
        content.set_project_archived(created.id, False).archived_at is None,
    )
    content.set_project_archived(created.id, True)

    # ---- 4. 身份与命名规则 ----
    project_id = created.id
    check("project_id 是 26 位 ULID", len(project_id) == naming.ULID_LENGTH)
    check(
        "目录名 = 日期-shortid-slug, shortid 取 ULID 尾部",
        before.split("-")[1] == project_id[-naming.SHORTID_LENGTH :],
        before,
    )
    check(
        "目录名日期段是创建当天",
        before.startswith(time.strftime(naming.DATE_FORMAT)),
        before,
    )
    check(
        "slug 保留中文与数字, 其余压成连字符",
        naming.slugify("我的 研究/项目 2026") == "我的-研究-项目-2026",
    )
    check(
        "slug 清洗后为空时目录名退化为两段",
        naming.directory_name("0" * 26, "///", time.time()).count("-") == 1,
    )
    check(
        "slug 截断不超过上限",
        len(naming.slugify("研究" * 40)) == naming.SLUG_MAX_CHARS,
    )
    check(
        "同毫秒批量创建的 shortid 不撞",
        len({naming.shortid(naming.new_project_id()) for _ in range(200)}) == 200,
    )

    # ---- 身份查询 ----
    check(
        "绝对路径能反查回项目 (会话侧仍存绝对路径)",
        (
            content.project_for_path(
                str(directory / MANAGED_RESOURCES_ROOT_RELATIVE / "x.md")
            )  # noqa: W504
            or content.project_for_path(str(directory))
        ).id
        == project_id,
    )
    check("项目外路径反查为空", content.project_for_path(str(root)) is None)
    check("默认项目 = 工作区根对应的记录", content.project().root == str(workspace))
    check(
        "CURRENT 别名与 None 等价",
        content.project(ProjectRegistry.CURRENT).id == content.project().id,
    )

    unknown = ""
    try:
        content.project("nope")
    except ContentError as exc:
        unknown = exc.code
    check("未登记的 project_id 被明确拒绝", unknown == "unknown_project")

    # ---- 落盘 ----
    reopened = ProjectRegistry(str(workspace), ContentCatalog(root / "content.sqlite3"))
    check(
        "身份跨进程重启仍在 (落 content.sqlite3, 不是进程内状态)",
        {entry.id for entry in reopened.projects()} == {entry.id for entry in content.projects()},
    )
    check(
        "改名后的显示名也落了盘",
        reopened.resolve(project_id).name == "换了个名字",
    )
    check(
        "归档态也落了盘",
        reopened.resolve(project_id).archived_at is not None,
    )

    # ---- write_text 按确定路径写, 不走同名避让 ----
    content.write_text(project_id, ".scholarseed/state.json", "{}")
    content.write_text(project_id, ".scholarseed/state.json", '{"again": true}')
    state = directory / ".scholarseed"
    check(
        "确定路径写入不产生 `xxx (2)` 副本",
        [item.name for item in state.iterdir() if item.name.startswith("state")] == ["state.json"],
        str(list(state.iterdir())),
    )

    observed_path = "resources/remount.pdf"
    content.write_text(project_id, observed_path, "unchanged bytes")
    original = content.identify(project_id, observed_path)
    database = content.resolve(project_id, PROJECT_DB_RELATIVE)
    with transaction(database) as connection:
        connection.execute(f"UPDATE {ASSET_TABLE} SET device = device + 1")
    rebound = content.identify(project_id, observed_path)
    check("挂载设备号变化保留相同文件身份", rebound.asset.asset_id == original.asset.asset_id)
    with transaction(database) as connection:
        connection.execute(f"UPDATE {ASSET_TABLE} SET device = device + 1, sha256 = 'different'")
    rejected = False
    try:
        content.identify(project_id, observed_path)
    except ContentError:
        rejected = True
    check("设备号及内容变化仍拒绝自动认领", rejected)

    replaced_path = "resources/replaced.pdf"
    content.write_text(project_id, replaced_path, "same PDF bytes")
    replaced_original = content.identify(project_id, replaced_path)
    replacement = directory / "resources" / "replacement.tmp"
    replacement.write_text("same PDF bytes", encoding="utf-8")
    replacement.replace(directory / replaced_path)
    replaced_reopened = content.identify(project_id, replaced_path)
    check(
        "同路径替换文件获得新身份且重复识别稳定",
        replaced_reopened.asset.asset_id != replaced_original.asset.asset_id
        and content.identify(project_id, replaced_path).asset.asset_id
        == replaced_reopened.asset.asset_id,
    )
    check(
        "同路径替换不继承旧身份",
        content.asset_status(project_id, replaced_original.asset.asset_id).state
        is AssetState.CONFLICT
        and content.asset_status(project_id, replaced_reopened.asset.asset_id).state
        is AssetState.AVAILABLE,
    )
    renamed_replacement = content.rename(project_id, replaced_path, "replaced-renamed.pdf")
    check(
        "同路径替换后的当前身份仍可重命名",
        renamed_replacement.asset_id == replaced_reopened.asset.asset_id
        and content.asset_status(project_id, replaced_original.asset.asset_id).state
        is AssetState.CONFLICT
        and content.asset_status(project_id, replaced_reopened.asset.asset_id).state
        is AssetState.AVAILABLE,
    )

    with (
        patch.object(native, "CREATION_ATTRIBUTE", native.LEGACY_CREATION_ATTRIBUTE),
        patch.object(
            storage,
            "WINDOWS_NAMED_STREAM",
            storage.LEGACY_WINDOWS_NAMED_STREAM,
        ),
    ):
        prepared = content.prepare_bytes(project_id, "resources", "managed-remount.md", b"managed")
        managed = content.materialize(prepared)
    with transaction(database) as connection:
        connection.execute(
            f"UPDATE {ASSET_TABLE} SET device = device + 1 WHERE asset_id = ?",
            (managed.asset_id,),
        )
    rebound = content.identify(project_id, managed.path)
    check(
        "旧版创建标记与 inode 一致时恢复 managed 设备号", rebound.asset.asset_id == managed.asset_id
    )
    with transaction(database) as connection:
        connection.execute(
            f"UPDATE {ASSET_TABLE} SET device = device + 1, creation_marker = ? WHERE asset_id = ?",
            ("wrong-marker", managed.asset_id),
        )
    rejected = False
    try:
        content.identify(project_id, managed.path)
    except ContentError:
        rejected = True
    check("managed 标记不匹配时禁止自动认领", rejected)

    print(f"\ncontract_content_identity: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
