"""资料树取数语义契约: 纵向深度与横向单层都是分页, 不是可见性上限。

守的是同一条缺陷的两种形态 —— 树把没投影出来的条目**静默丢弃**, 于是用户的
文件在界面上凭空消失:

1. 纵向: 一次只扫 `DEFAULT_MAX_DEPTH` 层, 关联目录第 3 级之后的文件看不见;
2. 横向: 单层只取前 `PAGE_SIZE` 条, 第 501 个文件永远看不见。

修法是同一条语义: 每个目录都报出**条目总数**, 与已投影的 `children` 长度一比
就知道还有没有下文; 更深的层级由 `path` 续扫, 更多的条目由 `offset` 续取。
两者共用一个判据, 不是两套字段各说一半。

另一条必须钉住的是**关联目录不是特例**: 续扫进挂载点内部的节点仍须是 LINK,
否则用户以为在动项目内副本, 其实动的是项目外原文件。
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.domain.model import MANAGED_RESOURCES_ROOT_RELATIVE, ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.content.service.roots import OWNED_ROOT_CONFLICT
from service.content.service.tree import DEFAULT_MAX_DEPTH, PAGE_SIZE
from service.platform.content import AssetOrigin, AssetTree, RootKind
from service.resources.api.routes import register_resource_routes

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


def node_at(nodes: tuple[AssetTree, ...], *names: str) -> AssetTree:
    """按名字逐层往下取节点。缺任一层就是断言前提没成立, 直接抛。"""

    current = nodes
    node: AssetTree | None = None
    for name in names:
        node = next(item for item in current if item.asset.name == name)
        current = node.children
    assert node is not None
    return node


def payload_at(nodes: list[dict], *names: str) -> dict:
    current = nodes
    node: dict = {}
    for name in names:
        node = next(item for item in current if item["name"] == name)
        current = node.get("children", [])
    return node


def _scene() -> tuple[ContentService, str, Path, Path]:
    """一个 MANAGED 项目 + 一处关联外部根, 两侧都比默认深度更深。

    深度是 3, 所以两侧都铺到第 4 层 —— 只有真的比上限深, 才能证明「续扫」而不是
    「恰好一次扫完」。
    """

    root = Path(tempfile.mkdtemp(prefix="content-tree-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()

    external = root / "外部根"
    (external / "s1" / "s2" / "s3").mkdir(parents=True)
    (external / "s1" / "s2" / "s3" / "第四层.md").write_text("外部深处", encoding="utf-8")

    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog)
    project = content.create_project("深度测试")
    resources = Path(project.root) / MANAGED_RESOURCES_ROOT_RELATIVE
    (resources / "本地" / "一层" / "二层").mkdir(parents=True)
    (resources / "本地" / "一层" / "二层" / "第四层.md").write_text("项目内深处", encoding="utf-8")
    (resources / "本地" / "空目录").mkdir()
    content.authorize_root(project.id, str(external), "关联目录")
    return content, project.id, resources, external


def test_depth_limit_reports_how_much_it_skipped() -> None:
    """深度用尽的目录报出条目总数, 空目录报 0。"""

    content, project_id, _, _ = _scene()
    page = content.tree(project_id, RootKind.RESOURCES, DEFAULT_MAX_DEPTH)

    deep_local = node_at(page.children, "本地", "一层", "二层")
    check(
        "第 3 层目录没往下扫, 但报出它有多少条目",
        deep_local.children == () and deep_local.child_total == 1,
        f"children={len(deep_local.children)} total={deep_local.child_total}",
    )
    check(
        "空目录报 0 (「空」与「没扫」由同一个数区分, 不需要第二个字段)",
        node_at(page.children, "本地", "空目录").child_total == 0,
    )
    check(
        "文件节点不带条目数",
        node_at(page.children, "本地", "一层", "二层").child_total == 1
        and all(
            child.child_total is None
            for child in node_at(page.children, "本地").children
            if child.asset.kind.value == "file"
        ),
    )
    linked_deep = node_at(page.children, "关联目录", "s1", "s2")
    check("关联目录内第 3 层同样报出条目数", linked_deep.child_total == 1)
    check(
        "挂载点本身在深度 1 时也报数, 而不是看着像空目录",
        node_at(content.tree(project_id, RootKind.RESOURCES, 1).children, "关联目录").child_total
        == 1,
    )


def test_subtree_continues_past_the_depth_limit() -> None:
    """subtree 能从截断处接着往下扫, 关联目录内部也一样。"""

    content, project_id, _, _ = _scene()
    linked = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/关联目录"

    page = content.subtree(project_id, f"{linked}/s1/s2", depth=1)
    check(
        "关联目录第 3 级之后可续扫出下一层",
        [node.asset.name for node in page.children] == ["s3"],
        str([node.asset.name for node in page.children]),
    )
    check(
        "续扫出的节点路径仍相对项目根",
        page.children[0].asset.path == f"{linked}/s1/s2/s3",
        page.children[0].asset.path,
    )
    check(
        "续扫进挂载内部仍标 LINK (否则用户以为在动项目内副本)",
        page.children[0].asset.origin is AssetOrigin.LINK,
    )
    check("续扫也遵守 depth, 下一层继续只报数不下扫", page.children[0].child_total == 1)

    deeper = content.subtree(project_id, f"{linked}/s1/s2", depth=2)
    check(
        "续扫深度可调, 一次拿回第四层文件",
        node_at(deeper.children, "s3", "第四层.md").asset.path == f"{linked}/s1/s2/s3/第四层.md",
    )

    local = content.subtree(
        project_id, f"{MANAGED_RESOURCES_ROOT_RELATIVE}/本地/一层/二层", depth=1
    )
    check(
        "项目内深层目录同样可续扫, 且仍是 LOCAL",
        [node.asset.name for node in local.children] == ["第四层.md"]
        and local.children[0].asset.origin is AssetOrigin.LOCAL,
    )


def test_single_level_is_paged_not_truncated() -> None:
    """单层超过一页时报总数并可按 offset 续取, 不静默丢弃。"""

    content, project_id, resources, _ = _scene()
    crowded = resources / "海量"
    crowded.mkdir()
    overflow = PAGE_SIZE + 7
    for index in range(overflow):
        (crowded / f"f{index:05d}.md").write_text("x", encoding="utf-8")

    relative = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/海量"
    first = content.subtree(project_id, relative, depth=1)
    check(
        "第一页只回 PAGE_SIZE 条, 但报出真实总数",
        len(first.children) == PAGE_SIZE and first.total == overflow and first.offset == 0,
        f"len={len(first.children)} total={first.total}",
    )
    second = content.subtree(project_id, relative, depth=1, offset=PAGE_SIZE)
    check(
        "带 offset 取到剩下的条目, 一条不少",
        len(second.children) == overflow - PAGE_SIZE and second.offset == PAGE_SIZE,
        f"len={len(second.children)} offset={second.offset}",
    )
    check(
        "两页拼起来正好是全部, 无重复无遗漏",
        [node.asset.name for node in first.children + second.children]
        == sorted(f"f{index:05d}.md" for index in range(overflow)),
    )
    check(
        "父层看这个目录时也报的是真实总数, 不是一页的数",
        node_at(content.tree(project_id, RootKind.RESOURCES, 1).children, "海量").child_total
        == overflow,
    )
    check(
        "offset 超过总数回空页而不是报错 (磁盘随时在变, 越界翻页是常态)",
        content.subtree(project_id, relative, depth=1, offset=overflow * 2).children == (),
    )


def test_mounts_are_not_lost_to_paging() -> None:
    """挂载点并在同一层里参与分页, 不会被切页切掉。

    挂载点排在磁盘条目之后, 若先切页再合并就会被挤出第一页并**永远**取不到 ——
    关联目录整个消失, 而这正是分页最容易踩的坑。
    """

    content, project_id, resources, _ = _scene()
    for index in range(PAGE_SIZE):
        (resources / f"占位{index:05d}.md").write_text("x", encoding="utf-8")

    total = content.tree(project_id, RootKind.RESOURCES, 1).total
    names: list[str] = []
    for offset in range(0, total, PAGE_SIZE):
        page = content.tree(project_id, RootKind.RESOURCES, 1, offset)
        names.extend(node.asset.name for node in page.children)
    check(
        "翻完所有页后关联目录仍在结果里",
        "关联目录" in names,
        f"total={total} 取到 {len(names)} 条",
    )
    check("翻页覆盖全部条目", len(names) == total, f"{len(names)} != {total}")


def test_subtree_keeps_the_boundary_checks() -> None:
    """续扫不是绕过越界校验的后门。"""

    content, project_id, _, _ = _scene()
    linked = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/关联目录"

    check(
        "项目外路径不能作为续扫起点",
        code_of(lambda: content.subtree(project_id, "../外部根", depth=1))
        == "path_outside_project",
    )
    check(
        "挂载内部逃逸同样被拒",
        code_of(lambda: content.subtree(project_id, f"{linked}/../../外部根", depth=1))
        in {"path_outside_authorized_root", "path_outside_project"},
    )
    check(
        "起点不是目录时回空页而不是抛错 (树是磁盘投影, 文件没有子节点)",
        content.subtree(project_id, f"{linked}/s1/s2/s3/第四层.md", depth=1).children == (),
    )


def test_symlink_out_of_project_does_not_break_the_tree() -> None:
    """用户自建的、指向项目外的符号链接不得让整棵树失败。

    树曾对**每个节点**用 `relative()` 反查相对路径, 而那个调用会 `resolve()` 消掉
    符号链接、发现落在项目外就抛 `path_outside_project` —— 于是访达里随手链一个
    共享盘进来, 整个资料库就打不开了。节点路径改为逐层拼接后不再反查, 这条断言
    防的是回退。

    安全边界不在树上: 读写仍走 `absolute()` 的越界校验, 下面一并钉住。
    """

    content, project_id, resources, external = _scene()
    (resources / "外链").symlink_to(external)

    page = content.tree(project_id, RootKind.RESOURCES, DEFAULT_MAX_DEPTH)
    names = [node.asset.name for node in page.children]
    check("项目内有指向项目外的符号链接时, 树照常返回", "外链" in names, str(names))
    check(
        "符号链接节点的路径仍相对项目根",
        node_at(page.children, "外链").asset.path == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/外链",
    )
    check(
        "经符号链接读项目外文件仍被越界校验挡住 (树能显示 ≠ 能穿透)",
        code_of(
            lambda: content.read_text(
                project_id, f"{MANAGED_RESOURCES_ROOT_RELATIVE}/外链/s1/s2/s3/第四层.md"
            )
        )
        == "path_outside_project",
    )


def test_http_exposes_totals_and_accepts_path_offset() -> None:
    """线上形状: count 是总数, path/offset 可续取。"""

    content, project_id, resources, _ = _scene()
    crowded = resources / "海量"
    crowded.mkdir()
    overflow = PAGE_SIZE + 3
    for index in range(overflow):
        (crowded / f"f{index:05d}.md").write_text("x", encoding="utf-8")

    app = FastAPI()
    app.state.content = content
    register_resource_routes(app)
    client = TestClient(app)

    tree = client.get("/api/resource/tree", params={"project": project_id})
    check("默认树请求成功", tree.status_code == 200, tree.text[:200])
    body = tree.json()
    check(
        "响应带这一层的 total/offset (顶层没有父节点能承载这个数)",
        body["offset"] == 0 and body["total"] >= 3,
        str({"total": body.get("total"), "offset": body.get("offset")}),
    )
    check(
        "深度没扫到的目录, count 报的是真实条目数而不是 0",
        payload_at(body["nodes"], "关联目录", "s1", "s2")["count"] == 1,
        str(payload_at(body["nodes"], "关联目录", "s1", "s2")),
    )
    check(
        "空目录不带 count (徽标不显示 0)",
        payload_at(body["nodes"], "本地", "空目录").get("count") is None,
    )
    crowded_payload = payload_at(body["nodes"], "海量")
    check(
        "超一页的目录: count 是总数, children 只有一页",
        crowded_payload["count"] == overflow and len(crowded_payload["children"]) == PAGE_SIZE,
        f"count={crowded_payload['count']} children={len(crowded_payload['children'])}",
    )

    continued = client.get(
        "/api/resource/tree",
        params={
            "project": project_id,
            "path": f"{MANAGED_RESOURCES_ROOT_RELATIVE}/海量",
            "depth": 1,
            "offset": PAGE_SIZE,
        },
    )
    check("带 offset 的续取请求成功", continued.status_code == 200, continued.text[:200])
    check(
        "续取回的是这一层剩下的条目",
        len(continued.json()["nodes"]) == overflow - PAGE_SIZE
        and continued.json()["offset"] == PAGE_SIZE,
        continued.text[:200],
    )

    linked = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/关联目录"
    deep = client.get(
        "/api/resource/tree",
        params={"project": project_id, "path": f"{linked}/s1/s2", "depth": 2},
    )
    check(
        "带 path 的续扫仍能拿到第四层文件",
        payload_at(deep.json()["nodes"], "s3", "第四层.md")["path"]
        == f"{linked}/s1/s2/s3/第四层.md",
        deep.text[:300],
    )
    relative_deep = client.get(
        "/api/resource/tree",
        params={"project": project_id, "path": "关联目录/s1/s2", "depth": 2},
    )
    check(
        "关联目录可按资料根相对路径续扫",
        relative_deep.status_code == 200
        and payload_at(relative_deep.json()["nodes"], "s3", "第四层.md")["path"]
        == f"{linked}/s1/s2/s3/第四层.md",
        relative_deep.text[:300],
    )
    check(
        "越界 path 回 4xx 而不是静默空树",
        client.get(
            "/api/resource/tree",
            params={"project": project_id, "path": "../外部根"},
        ).status_code
        == 400,
    )
    check(
        "负 offset 被参数校验拒绝",
        client.get(
            "/api/resource/tree",
            params={"project": project_id, "offset": -1},
        ).status_code
        == 422,
    )


def test_http_candidates_page_complete_files_with_creation_time() -> None:
    content, project_id, resources, _ = _scene()
    candidate_total = 205
    for index in range(candidate_total):
        (resources / f"候选-{index:03d}.md").write_text("candidate", encoding="utf-8")

    app = FastAPI()
    app.state.content = content
    register_resource_routes(app)
    client = TestClient(app)

    first = client.get("/api/resource/candidates", params={"project": project_id})
    first_body = first.json()
    check("候选首屏请求成功", first.status_code == 200, first.text[:200])
    check(
        "候选首屏按稳定游标分页且带创建时间",
        len(first_body["items"]) == 200
        and bool(first_body["next_cursor"])
        and all(item["created_at"] > 0 for item in first_body["items"]),
        first.text[:300],
    )
    second = client.get(
        "/api/resource/candidates",
        params={"project": project_id, "cursor": first_body["next_cursor"]},
    )
    second_body = second.json()
    check(
        "候选续页覆盖剩余完整范围",
        second.status_code == 200
        and second_body["next_cursor"] is None
        and len(first_body["items"]) + len(second_body["items"]) >= candidate_total,
        second.text[:300],
    )


def test_http_count_enumerates_every_resource_file_once() -> None:
    """计数口径是完整枚举: 深度上限、单层分页、两条路可达都不改变「有多少」。

    `/tree` 回的是**投影** —— 一次只有 `DEFAULT_MAX_DEPTH` 层、每层一页, 所以拿它
    数条数, 数出来的是「这一页看见多少」。项目卡上的「资料」要的是「有多少」, 只能
    走完整枚举: 每个已授权逻辑资料文件恰好一次。
    """

    content, project_id, resources, external = _scene()
    app = FastAPI()
    app.state.content = content
    register_resource_routes(app)
    client = TestClient(app)

    def files() -> int:
        response = client.get("/api/resource/count", params={"project": project_id})
        assert response.status_code == 200, response.text[:200]
        return int(response.json()["files"])

    check(
        "只数文件: 深层文件计入, 沿途目录与空目录不计入",
        files() == 2,
        f"files={files()}",
    )

    (resources / "外链").symlink_to(external)
    check(
        "同一物理文件经挂载与用户符号链接两条路可达时按逻辑路径去重",
        files() == 2,
        f"files={files()}",
    )

    (resources / ".隐藏.md").write_text("x", encoding="utf-8")
    (resources / "node_modules").mkdir()
    (resources / "node_modules" / "依赖.md").write_text("x", encoding="utf-8")
    check("隐藏名与 IGNORED_NAMES 不是资料", files() == 2, f"files={files()}")

    crowded = resources / "海量"
    crowded.mkdir()
    overflow = PAGE_SIZE + 3
    for index in range(overflow):
        (crowded / f"f{index:05d}.md").write_text("x", encoding="utf-8")
    check(
        "单层分页上限不封顶计数 (树只回一页, 计数回全部)",
        files() == 2 + overflow,
        f"files={files()} 期望 {2 + overflow}",
    )
    tree = client.get("/api/resource/tree", params={"project": project_id}).json()
    check(
        "同一时刻树投影里 海量 只有一页 children —— 投影不能当计数用",
        payload_at(tree["nodes"], "海量")["count"] == overflow
        and len(payload_at(tree["nodes"], "海量")["children"]) == PAGE_SIZE,
        str(payload_at(tree["nodes"], "海量")["count"]),
    )

    missing = client.get("/api/resource/count", params={"project": "01不存在"})
    check(
        "未登记项目回 404 而不是 0 (0 会被读成「空项目」)",
        missing.status_code == 404,
        str(missing.status_code),
    )


def test_registered_artifact_roots_are_separate_and_portable() -> None:
    with tempfile.TemporaryDirectory(prefix="content-owned-roots-") as temporary:
        base = Path(temporary).resolve()
        workspace = base / "projects"
        workspace.mkdir()
        catalog = ContentCatalog(base / "catalog.sqlite3")
        registry = ProjectRegistry(str(workspace), catalog)
        content = ContentService(registry, catalog)
        legacy_path = workspace / "legacy"
        legacy_path.mkdir()
        projects = (registry.adopt(legacy_path), content.create_project("managed"))
        for project in projects:
            label = project.layout.value
            check(
                f"{label} 读取未登记产物根为空",
                content.tree(project.id, RootKind.ARTIFACTS).total == 0,
            )
            artifact_root = content.root(project.id, RootKind.ARTIFACTS)
            target = Path(content.resolve(project.id, artifact_root.path))
            (target / "report.md").write_text("unique-artifact-content", encoding="utf-8")
            resource_root = content.root(project.id, RootKind.RESOURCES)
            content.create_bytes(project.id, resource_root.path, "input.md", b"resource-content")
            check(
                f"{label} 登记根可重复打开",
                content.root(project.id, RootKind.ARTIFACTS) == artifact_root,
            )
            check(
                f"{label} 产物树独立可读", content.tree(project.id, RootKind.ARTIFACTS).total == 1
            )
            check(
                f"{label} 资料树不含产物根",
                all(
                    node.asset.path != artifact_root.path
                    for node in content.tree(project.id).children
                ),
            )
            check(
                f"{label} 资料续扫不能绕过根分离",
                content.subtree(project.id, artifact_root.path, 2).total == 0,
            )
            check(
                f"{label} 产物续扫使用显式根",
                content.subtree(project.id, artifact_root.path, 2, root=RootKind.ARTIFACTS).total
                == 1,
            )
            check(
                f"{label} 资料搜索不命中产物内容",
                content.search(project.id, "unique-artifact-content").hits == (),
            )
            reopened = ContentService(registry, catalog)
            check(
                f"{label} 重开保留根登记",
                reopened.root(project.id, RootKind.ARTIFACTS) == artifact_root,
            )
            directory = content.ensure_directory(project.id, artifact_root.path, "session-a")
            check(
                f"{label} 精确会话目录重试不改名",
                content.ensure_directory(project.id, artifact_root.path, "session-a") == directory,
            )
            check(
                f"{label} 文件冲突不能被当作输出目录",
                code_of(
                    lambda: content.ensure_directory(project.id, artifact_root.path, "report.md")
                )
                == "directory_conflict",
            )


def test_existing_artifacts_directory_is_not_claimed_or_hidden() -> None:
    with tempfile.TemporaryDirectory(prefix="content-root-conflict-") as temporary:
        base = Path(temporary).resolve()
        project_path = base / "legacy"
        project_path.mkdir()
        owned_by_user = project_path / "artifacts"
        owned_by_user.mkdir()
        original = owned_by_user / "keep.md"
        original.write_text("user-owned-artifact", encoding="utf-8")
        catalog = ContentCatalog(base / "catalog.sqlite3")
        registry = ProjectRegistry(str(base), catalog)
        project = registry.adopt(project_path)
        content = ContentService(registry, catalog)
        check(
            "已有用户产物同名目录拒绝认领",
            code_of(lambda: content.root(project.id, RootKind.ARTIFACTS)) == OWNED_ROOT_CONFLICT,
        )
        check("冲突不改写用户内容", original.read_text(encoding="utf-8") == "user-owned-artifact")
        check(
            "未登记的同名目录仍是用户资料",
            any(node.asset.name == "artifacts" for node in content.tree(project.id).children)
            and bool(content.search(project.id, "user-owned-artifact")),
        )


def main() -> int:
    print("content tree paging contract (depth + single-level are both paging)")
    test_depth_limit_reports_how_much_it_skipped()
    test_subtree_continues_past_the_depth_limit()
    test_single_level_is_paged_not_truncated()
    test_mounts_are_not_lost_to_paging()
    test_subtree_keeps_the_boundary_checks()
    test_symlink_out_of_project_does_not_break_the_tree()
    test_http_exposes_totals_and_accepts_path_offset()
    test_http_candidates_page_complete_files_with_creation_time()
    test_http_count_enumerates_every_resource_file_once()
    test_registered_artifact_roots_are_separate_and_portable()
    test_existing_artifacts_directory_is_not_claimed_or_hidden()
    print(f"\ncontract_content_tree: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
