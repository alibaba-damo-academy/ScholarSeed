"""Project-page read-model contract for registered local roots."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.service.projects import summarize_project
from service.content.api.routes import register_content_routes
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def scenario(root: Path) -> None:
    project = root / "project"
    project.mkdir()
    visible_file = project / "paper.md"
    visible_file.write_text("evidence", encoding="utf-8")
    (project / "results").mkdir()
    (project / ".git").mkdir()
    hidden_file = project / ".private"
    hidden_file.write_text("hidden", encoding="utf-8")
    expected_mtime = 2_000_000_000
    os.utime(visible_file, (expected_mtime, expected_mtime))

    summary = summarize_project({"name": "Research", "path": str(project), "added_at": 100})
    check(
        "summary counts visible top-level entries without leaking hidden state",
        summary.get("available") is True and summary.get("file_count") == 2,
        str(summary),
    )
    check(
        "summary reports latest real top-level activity",
        summary.get("updated_at") == expected_mtime,
        str(summary),
    )

    unavailable = summarize_project(
        {"name": "Missing", "path": str(root / "missing"), "added_at": 101}
    )
    check(
        "unavailable roots fail closed without fabricated file counts",
        unavailable.get("available") is False and unavailable.get("file_count") is None,
        str(unavailable),
    )


def legacy_route_is_retired(root: Path) -> None:
    """`/api/serve/projects` 已随 proposal 47 阶段四下线, 项目只由 content 域提供。

    两套项目定义并存时, 会话侧与文件侧对「项目」的理解会分叉 —— 那种分叉不报错,
    只会让同一个目录在两个界面里是两个项目。因此这里钉两件事: 旧路由不存在了,
    且 content 的项目路由能给出同一份身份。
    """

    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    preview = Path(content.preview_project_directory("研究项目"))
    check("default directory follows project name", preview.name == "研究项目")
    check("preview does not create files", not preview.exists())
    created = content.create_project("研究项目")
    check("creation uses the previewed directory", created.root == str(preview))
    check(
        "duplicate names receive a suffix",
        Path(content.preview_project_directory("研究项目")).name == "研究项目-2",
    )
    check(
        "Windows reserved names are safe on all hosts",
        Path(content.preview_project_directory("CON")).name == "project-CON",
    )
    created = content.create_project("身份层项目")

    app = FastAPI()
    app.state.content = content
    app.state.workspace = str(workspace)
    register_content_routes(app)
    client = TestClient(app)

    for method in ("GET", "POST", "PATCH", "DELETE"):
        response = client.request(method, "/api/serve/projects", json={"path": created.root})
        check(
            f"legacy {method} /api/serve/projects is retired",
            response.status_code in {404, 405},
            f"{method} -> {response.status_code}",
        )
    listed = client.get("/api/content/projects")
    payload = listed.json()
    check(
        "content route is the single source of project identity",
        listed.status_code == 200
        and any(
            entry.get("id") == created.id and entry.get("root") == created.root
            for entry in payload["projects"]
        ),
        listed.text[:200],
    )


def generated_project_names(root: Path) -> None:
    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    original = registry.create("同名创建测试")
    evidence = Path(original.root) / "original.txt"
    evidence.write_text("preserved", encoding="utf-8")
    for expected in ("同名创建测试-2", "同名创建测试-3"):
        preview = registry.creation_directory("同名创建测试")
        created = registry.create("同名创建测试")
        check(
            "duplicate project name follows its final generated directory",
            created.name == expected == Path(created.root).name
            and created.root == str(preview)
            and created.id != original.id,
            str(created),
        )
        reopened = ProjectRegistry(str(workspace), ContentCatalog(root / "content.sqlite3"))
        check("generated project name persists", reopened.resolve(created.id) == created)
    check(
        "duplicate creation preserves the original project and content",
        registry.resolve(original.id) == original
        and evidence.read_text(encoding="utf-8") == "preserved",
    )
    for requested, expected in (
        ("独立项目", "独立项目"),
        ("空格 项目", "空格-项目"),
        ("CON", "project-CON"),
        ("???", "project"),
        ("长" * 25, "长" * 24),
    ):
        created = registry.create(requested)
        check(
            "initial project name matches the normalized automatic directory",
            created.name == expected == Path(created.root).name,
            str(created),
        )
    renamed = registry.rename(original.id, "后续显示名称")
    check("rename retains its existing directory", renamed.root == original.root)
    selected = root / "selected"
    selected.mkdir()
    adopted = registry.adopt(selected, "手选目录名称")
    check("selected directory retains its explicit display name", adopted.name == "手选目录名称")


def archive_routes(root: Path) -> None:
    """归档只改默认列表可见性: 服务端过滤 + 可逆 + 当前项目拒绝。

    列表过滤钉在路由层而不是服务层: GC、观察、投递这些内部消费方仍要看到
    全部项目, 而所有 HTTP 列表表面必须一致地收起已归档项目。
    """

    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    current = content.project()
    target = content.create_project("待归档项目")

    app = FastAPI()
    app.state.content = content
    app.state.workspace = str(workspace)
    register_content_routes(app)
    client = TestClient(app)

    def listed_ids(query: str = "") -> set[str]:
        payload = client.get(f"/api/content/projects{query}").json()
        return {entry["id"] for entry in payload["projects"]}

    check("archive 前默认列表含目标项目", target.id in listed_ids())

    archived = client.post(f"/api/content/projects/{target.id}/archive", json={"archived": True})
    check(
        "archive 端点回 200 且带归档时间",
        archived.status_code == 200 and archived.json().get("archived_at"),
        archived.text[:200],
    )
    check("归档后默认列表收起目标项目", target.id not in listed_ids())
    check(
        "includeArchived=true 回全量且带归档时间",
        target.id in listed_ids("?includeArchived=true")
        and any(
            entry["id"] == target.id and entry["archived_at"]
            for entry in client.get("/api/content/projects?includeArchived=true").json()["projects"]
        ),
    )
    check(
        "服务层 projects() 仍见已归档项目 (内部消费方不受列表过滤影响)",
        any(entry.id == target.id for entry in content.projects()),
    )

    rejected = client.post(f"/api/content/projects/{current.id}/archive", json={"archived": True})
    check(
        "当前项目拒绝归档",
        rejected.status_code == 400
        and rejected.json().get("detail") == "cannot_archive_current_project",
        rejected.text[:200],
    )
    unknown = client.post("/api/content/projects/nope/archive", json={"archived": True})
    check(
        "未登记 id 归档被明确拒绝",
        unknown.status_code == 400 and unknown.json().get("detail") == "unknown_project",
        unknown.text[:200],
    )

    renamed = client.patch("/api/content/projects", json={"id": target.id, "name": "归档中改名"})
    check(
        "归档期间改名仍可用",
        renamed.status_code == 200 and renamed.json().get("name") == "归档中改名",
        renamed.text[:200],
    )

    restored = client.post(f"/api/content/projects/{target.id}/archive", json={"archived": False})
    check(
        "解归档清空归档时间",
        restored.status_code == 200 and restored.json().get("archived_at") is None,
        restored.text[:200],
    )
    check("解归档后回到默认列表", target.id in listed_ids())


def creation_order(root: Path) -> None:
    """列表按创建时间倒序: 新建的项目排最前, 归档视图同序。

    顺序钉在路由层而不是各个界面: 三处项目列表 (首页卡片、顶栏下拉、项目面板)
    共用这一个端点, 分头排序会各自漂移。
    """

    workspace = root / "workspace"
    workspace.mkdir()
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    seeded = content.project()
    first = content.create_project("先建的项目")
    second = content.create_project("后建的项目")

    app = FastAPI()
    app.state.content = content
    app.state.workspace = str(workspace)
    register_content_routes(app)
    client = TestClient(app)

    listed = client.get("/api/content/projects").json()["projects"]
    check(
        "列表按创建时间倒序",
        [entry["id"] for entry in listed] == [second.id, first.id, seeded.id],
        str([entry["name"] for entry in listed]),
    )
    check(
        "列表带出登记时间供界面展示",
        all(isinstance(entry.get("created_at"), float) for entry in listed),
        str([entry.get("created_at") for entry in listed]),
    )

    client.post(f"/api/content/projects/{first.id}/archive", json={"archived": True})
    archived_view = client.get("/api/content/projects?includeArchived=true").json()["projects"]
    check(
        "归档视图同样按创建时间倒序",
        [entry["id"] for entry in archived_view] == [second.id, first.id, seeded.id],
        str([entry["name"] for entry in archived_view]),
    )


def metadata_roundtrip(root: Path) -> None:
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(root), catalog)
    content = ContentService(registry, catalog, activities=Activities())
    project = content.create_project("Before")
    app = FastAPI()
    app.state.content = content
    register_content_routes(app)
    client = TestClient(app)
    response = client.patch(
        "/api/content/projects",
        json={
            "id": project.id,
            "name": "After",
            "description": "Research",
            "pinned": True,
        },
    )
    check(
        "project metadata updates without moving its root",
        response.status_code == 200
        and response.json()["root"] == project.root
        and Path(project.root).is_dir(),
    )
    reopened = ProjectRegistry(str(root), ContentCatalog(root / "content.sqlite3"))
    saved = reopened.resolve(project.id)
    check("description and pin persist", saved.description == "Research" and saved.pinned)
    renamed = content.rename_project(project.id, "Again")
    check(
        "name-only update preserves metadata", renamed.description == "Research" and renamed.pinned
    )
    invalid = client.patch(
        "/api/content/projects",
        json={
            "id": project.id,
            "name": "Invalid",
            "pinned": "false",
        },
    )
    check(
        "invalid metadata is rejected before writes",
        invalid.status_code == 400 and content.project(project.id).name == "Again",
    )
    unpinned = client.patch(
        "/api/content/projects",
        json={"id": project.id, "name": "Again", "pinned": False},
    )
    reopened = ProjectRegistry(str(root), ContentCatalog(root / "content.sqlite3"))
    check(
        "unpin persists across a fresh catalog connection without changing project metadata",
        unpinned.status_code == 200
        and not reopened.resolve(project.id).pinned
        and reopened.resolve(project.id).description == "Research"
        and reopened.resolve(project.id).root == project.root,
    )


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="project-names-") as tmp:
        generated_project_names(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-tree-") as tmp:
        project_tree(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-explorer-") as tmp:
        project_explorer(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-metadata-") as tmp:
        metadata_roundtrip(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-summary-") as tmp:
        scenario(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-routes-") as tmp:
        legacy_route_is_retired(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-archive-") as tmp:
        archive_routes(Path(tmp).resolve())
    with tempfile.TemporaryDirectory(prefix="project-order-") as tmp:
        creation_order(Path(tmp).resolve())
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


def project_tree(root: Path) -> None:
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(root / "workspace"), catalog)
    content = ContentService(registry, catalog, activities=Activities())
    project = content.create_project("Explorer")
    folder = Path(project.root) / "results"
    folder.mkdir()
    (folder / "paper.md").write_text("test", encoding="utf-8")
    app = FastAPI()
    app.state.content = content
    register_content_routes(app)
    client = TestClient(app)
    url = f"/api/content/projects/{project.id}/tree"
    response = client.get(url)
    check(
        "project tree lists real root directories",
        response.status_code == 200
        and any(node["name"] == "results" for node in response.json()["nodes"]),
    )
    nested = client.get(url, params={"path": "results"})
    check(
        "project tree expands real files",
        nested.status_code == 200 and nested.json()["nodes"][0]["path"] == "results/paper.md",
    )
    check(
        "project tree rejects parent escape",
        client.get(url, params={"path": "../"}).status_code == 400,
    )
    check(
        "project tree rejects unknown projects",
        client.get("/api/content/projects/unknown/tree").status_code == 400,
    )
    check(
        "project tree validates pagination",
        client.get(url, params={"offset": -1}).status_code == 422,
    )


def project_explorer(root: Path) -> None:
    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(root / "workspace"), catalog)
    content = ContentService(registry, catalog, activities=Activities())
    project = content.create_project("Explorer actions")
    app = FastAPI()
    app.state.content = content
    register_content_routes(app)
    client = TestClient(app)
    nodes = f"/api/content/projects/{project.id}/nodes"
    imports = f"/api/content/projects/{project.id}/import"

    invalid_name = "新建新建2026年10月27日16:51:39"
    for action in ("create_document", "create_folder"):
        rejected = client.post(nodes, json={"action": action, "name": invalid_name})
        check(
            f"explorer rejects colon names before {action}",
            rejected.status_code == 400 and rejected.json()["detail"] == "invalid_name",
        )
    check(
        "invalid names create no filesystem entries",
        not any(entry.name.startswith(invalid_name) for entry in Path(project.root).iterdir()),
    )
    valid_name = invalid_name.replace(":", "-")
    corrected = client.post(nodes, json={"action": "create_document", "name": valid_name})
    check(
        "corrected timestamp name creates readable Markdown",
        corrected.status_code == 200
        and (Path(project.root) / f"{valid_name}.md").read_text(encoding="utf-8") == "",
    )
    rejected_rename = client.post(
        nodes,
        json={"action": "rename", "path": f"{valid_name}.md", "name": f"{invalid_name}.md"},
    )
    check(
        "rename uses the same name rule and preserves the original",
        rejected_rename.status_code == 400
        and rejected_rename.json()["detail"] == "invalid_name"
        and (Path(project.root) / f"{valid_name}.md").is_file(),
    )

    folder = client.post(nodes, json={"action": "create_folder", "name": "notes"})
    check(
        "explorer creates folder at project root",
        folder.status_code == 200 and folder.json()["path"] == "notes",
    )
    document = client.post(
        nodes, json={"action": "create_document", "parent": "notes", "name": "draft.md"}
    )
    check(
        "explorer creates Markdown in selected folder",
        document.status_code == 200 and (Path(project.root) / "notes" / "draft.md").is_file(),
    )
    other = client.post(nodes, json={"action": "create_folder", "name": "other"})
    check("explorer creates another folder", other.status_code == 200)
    moved = client.post(
        nodes, json={"action": "move", "path": "notes/draft.md", "target_dir": "other"}
    )
    check(
        "explorer moves exact file with content",
        moved.status_code == 200
        and moved.json()["path"] == "other/draft.md"
        and (Path(project.root) / "other" / "draft.md").read_text(encoding="utf-8") == "",
    )
    (Path(project.root) / "notes" / "draft.md").write_text("stay", encoding="utf-8")
    collision = client.post(
        nodes, json={"action": "move", "path": "notes/draft.md", "target_dir": "other"}
    )
    check(
        "explorer collision does not overwrite either file",
        collision.status_code == 400
        and collision.json()["detail"] == "name_exists"
        and (Path(project.root) / "notes" / "draft.md").read_text(encoding="utf-8") == "stay",
    )
    renamed = client.post(
        nodes, json={"action": "rename", "path": "notes/draft.md", "name": "final.md"}
    )
    check(
        "explorer renames file",
        renamed.status_code == 200 and (Path(project.root) / "notes" / "final.md").is_file(),
    )
    source = root / "outside.txt"
    source.write_text("copied", encoding="utf-8")
    imported = client.post(imports, json={"sources": [str(source)], "target_dir": "notes"})
    check(
        "explorer imports a copy into selected folder",
        imported.status_code == 200
        and (Path(project.root) / "notes" / "outside.txt").read_text(encoding="utf-8") == "copied"
        and source.is_file(),
    )
    hidden = client.post(nodes, json={"action": "create_folder", "name": ".scholarseed"})
    check("explorer blocks hidden internal targets", hidden.status_code == 400)
    escaped = client.post(nodes, json={"action": "create_folder", "parent": "../", "name": "bad"})
    check("explorer blocks path escape", escaped.status_code == 400 and not (root / "bad").exists())
    artifact_folder = client.post(nodes, json={"action": "create_folder", "name": "artifacts"})
    check("explorer creates artifact test folder", artifact_folder.status_code == 200)
    artifact = client.post(
        nodes,
        json={"action": "create_document", "parent": "artifacts", "name": "result.md"},
    )
    tree = client.get(f"/api/content/projects/{project.id}/tree", params={"path": "artifacts"})
    check(
        "explorer identifies task output files",
        artifact.status_code == 200
        and tree.status_code == 200
        and tree.json()["nodes"][0]["artifact"] is True,
    )
    copied = client.post(
        nodes,
        json={"action": "copy", "path": "artifacts/result.md", "target_dir": "resources"},
    )
    check(
        "explorer copies artifact to library without moving source",
        copied.status_code == 200
        and (Path(project.root) / "artifacts" / "result.md").is_file()
        and (Path(project.root) / "resources" / "result.md").is_file(),
    )


if __name__ == "__main__":
    raise SystemExit(main())
