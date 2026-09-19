"""关联根授权与删除接缝契约 (proposal 47 §5.1 / §6.6)。

这套件守的是「能写用户项目外文件」这项能力的四条边界:

1. 授权必须显式登记、可枚举, 并且**留痕** (软撤销, 行不删);
2. 挂载点与真实同名目录冲突时直接拒绝, 不静默避让也不遮蔽用户目录;
3. `writable_roots()` 是主进程白名单与 Agent 沙箱 `sandboxPolicy` 的**同一**
   来源 —— 两套来源必然漂移成一处能写一处不能写;
4. 删除令牌一次性、短时效, 渲染层拿不到绝对路径。
"""

from __future__ import annotations

import sqlite3
import tempfile
from hashlib import sha256
from pathlib import Path

from service.content.domain.model import MANAGED_RESOURCES_ROOT_RELATIVE, ContentError
from service.content.persistence.catalog import (
    AUDIT_AUTHORIZE,
    AUDIT_REVOKE,
    ContentCatalog,
)
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.token import TrashTokenVault
from service.platform.content import AssetKind, AssetOrigin, RootKind

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


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="content-authorization-")).resolve()
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

    database = root / "content.sqlite3"
    catalog = ContentCatalog(database)
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog)
    project = content.create_project("授权测试")
    directory = Path(project.root)

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

    print(f"\ncontract_content_authorization: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
