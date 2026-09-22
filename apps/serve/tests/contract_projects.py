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
    content = ContentService(registry, catalog)
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
    content = ContentService(registry, catalog)
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
    content = ContentService(registry, catalog)
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


def main() -> int:
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


if __name__ == "__main__":
    raise SystemExit(main())
