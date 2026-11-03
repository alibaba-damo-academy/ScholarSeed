"""MVP 0.2 工作台三个新域的契约门 (资料库 / 文献库 / 全局搜索)。

这里钉死的是「不能回退」的不变量, 而不是把实现重述一遍:

1. **写操作真落盘**: PRD「本地文件同步」要求书深里的操作与本地真实文件一致。
   因此断言的是磁盘状态, 而不是接口回了 200。
2. **越界必须被拦**: 项目外路径、项目根自身、把目录搬进自己子树, 三类都拒绝。
   这是安全边界, 一旦松掉就是任意文件读写。
3. **同名不覆盖**: 用户资料不能被静默冲掉, 冲突时自动避让。
4. **删除不永久**: 后端只签一次性令牌, 不自己删 —— 真正的删除走 Electron
   系统废纸篓；关联资料连令牌都不能签，只能取消关联并保留原文件。
5. **重复导入去重**: 同一篇文献重复入库只留一条, 且已有的非空字段不被空值冲掉。

用 TestClient 直连 FastAPI 应用, 是这三个域的真实 HTTP 路径; 项目根用临时目录,
不碰用户真实工作区。
"""

# isort: skip_file -- SCHOLARSEED_HOME must be isolated before importing service modules.

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
import threading
import time
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import patch

# 文献库是**用户级**仓储 (`$SCHOLARSEED_HOME/service/literature.sqlite3`), /api/v1 的
# 导入、分类、标签、批量与笔记全部落它; 不 pin 家目录就会把夹具行写进开发机真实的
# ~/.scholarseed (泄漏 = FAIL)。service.paths 在 import 时即求值, 所以隔离必须发生在
# 任何 first-party import 之前。
_HOME = tempfile.TemporaryDirectory(prefix="v02-workbench-home-")
os.environ["SCHOLARSEED_HOME"] = _HOME.name

import httpx  # noqa: E402  (隔离先于 first-party import)
from docx import Document  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from service.content.domain.model import (  # noqa: E402
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
)
from service.content.persistence.catalog import ContentCatalog  # noqa: E402
from service.content.service.port import ContentService, ProjectRegistry  # noqa: E402
from service.content.service.search import MAX_RESULTS  # noqa: E402
from service.literature.api.catalogue import register_global_routes  # noqa: E402
from service.literature.domain.model import LiteratureError  # noqa: E402
from service.literature.persistence.store import decode, load_library  # noqa: E402
from service.literature.schema import (  # noqa: E402
    FulltextStatus,
    LiteratureItem,
    LiteratureNote,
    LiteratureView,
)
from service.literature.service.catalog import append_items  # noqa: E402
from service.platform.activity import Activities  # noqa: E402
from service.platform.search import register_search_routes  # noqa: E402
from service.resources.api.routes import register_resource_routes  # noqa: E402
from service.resources.service.activation import ResourceActivation  # noqa: E402
from service.resources.service.delivery import ResourceDeliveryService  # noqa: E402
from service.resources.service.history import ResourceVersionService  # noqa: E402
from service.resources.service.importer import (  # noqa: E402
    IMPORT_BACKGROUND_REQUIRED,
    ResourceImportService,
)
from service.resources.service.migration import ResourceReviewMigration  # noqa: E402
from service.resources.service.observe import ResourceVersionSupervisor  # noqa: E402
from service.resources.service.recovery import ResourceRecoveryService  # noqa: E402
from service.resources.service.retention import ResourceRetentionService  # noqa: E402
from service.workbench.domain.model import WorkbenchFormatPolicy  # noqa: E402
from service.workbench.service.records import PdfRecordStore  # noqa: E402

PASS = 0
FAIL = 0
RESOURCE_TREE_BLOCK_SECONDS = 0.5
RESOURCE_TREE_HEALTH_MAX_SECONDS = 0.2


class ResourceVersionSettings:
    """Deterministic version policy used by the resources HTTP fixture."""

    def max_versions_per_file(self) -> int:
        return 50

    def max_version_file_size_kb(self) -> int:
        return 1024

    def version_ignore_patterns(self) -> tuple[str, ...]:
        return ()

    def version_mode(self) -> str:
        return "whitelist"

    def version_migration_required(self) -> bool:
        return False

    def version_include_patterns(self) -> tuple[str, ...] | None:
        return None


#: 一份真实的 BibTeX, 覆盖多作者、`Last, First` 语序与跨行摘要。
SAMPLE_BIB = """@article{zhang2023,
  title = {Humidity-induced degradation in perovskite cells},
  author = {Zhang, Wei and Nakamura, Yuki},
  journal = {Nature Energy},
  year = {2023},
  doi = {10.1038/s41560-023-01234-8},
  keywords = {perovskite, humidity},
  abstract = {A systematic study of moisture ingress
              across three encapsulation strategies.}
}
"""

#: 一份真实的 RIS, 每行一个作者且为 `Last, First` 语序。
SAMPLE_RIS = """TY  - JOUR
TI  - Turbulence modelling for satellite links
AU  - Ivanova, Elena
AU  - Dubois, Marc
JO  - Optics Express
PY  - 2024
DO  - 10.1364/OE.512345
KW  - turbulence
ER  -
"""


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def _client(project: Path) -> TestClient:
    """装一个只挂 0.2 三个域的应用, 项目根指向临时目录。

    content 域的注入与 `service.bootstrap` 保持一致: 业务域不自己构造
    ContentService, 因此测试也必须走同一条装配路径 —— 否则测的就不是
    真实运行时的接线方式。
    """

    app = FastAPI()
    app.state.workspace = str(project)
    # 身份落 content.sqlite3 (proposal 47): 库放在项目目录外的临时位置, 免得
    # 库文件本身出现在被断言的资料树里。
    catalog = ContentCatalog(project.parent / f"{project.name}-content.sqlite3")
    registry = ProjectRegistry(str(project), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    settings = ResourceVersionSettings()
    formats = WorkbenchFormatPolicy()
    retention = ResourceRetentionService(content, settings)
    annotations = PdfRecordStore(content)
    versions = ResourceVersionService(content, retention, formats, annotations)
    supervisor = ResourceVersionSupervisor(
        content, versions, formats, settings, activities=Activities()
    )
    deliveries = ResourceDeliveryService(
        content, versions, supervisor, activities=supervisor._activities
    )
    supervisor.bind_preparation(
        ResourceActivation(
            content,
            ResourceRecoveryService(content, retention, annotations),
            versions,
            deliveries,
            retention,
            ResourceReviewMigration(content, versions),
        )
    )
    content.bind_resource_changes(supervisor)
    app.state.content = content
    app.state.resource_versions = versions
    app.state.resource_version_supervisor = supervisor
    app.state.resource_importer = ResourceImportService(content, versions, supervisor)
    register_resource_routes(app)
    register_global_routes(app)
    register_search_routes(app)
    return TestClient(app)


def _seed(project: Path) -> None:
    """铺一个带中文目录名的真实项目, 中文路径是产品的常态。"""

    (project / "笔记").mkdir()
    (project / "笔记" / "想法.md").write_text(
        "# 湿度失效机理\n初步结论: 封装层针孔是主要通道。\n", encoding="utf-8"
    )
    (project / "实验数据.csv").write_text("run,rh,pce\n1,45,0.19\n", encoding="utf-8")


def _docx_bytes() -> bytes:
    """Build a real DOCX with text in the common visible containers."""

    document = Document()
    document.add_paragraph("正文暗号：深海蓝")
    table = document.add_table(rows=1, cols=1)
    table.cell(0, 0).text = "表格暗号：银杏叶"
    section = document.sections[0]
    section.header.paragraphs[0].text = "页眉暗号：晨星"
    section.footer.paragraphs[0].text = "页脚暗号：归航"
    payload = BytesIO()
    document.save(payload)
    return payload.getvalue()


def test_resource_writes_land_on_disk() -> None:
    """新建 / 重命名 / 复制 / 移动 都要在磁盘上真实发生 (PRD「本地文件同步」)。"""

    project = Path(tempfile.mkdtemp(prefix="v02-fs-"))
    try:
        _seed(project)
        client = _client(project)

        created = client.post(
            "/api/resource/node",
            json={"action": "create_folder", "parent": "", "name": "文献摘录"},
        )
        check(
            "create_folder 真实建目录",
            created.status_code == 200 and (project / "文献摘录").is_dir(),
            f"status={created.status_code}",
        )

        doc = client.post(
            "/api/resource/node",
            json={"action": "create_document", "parent": "文献摘录", "name": "摘录一"},
        )
        target = project / "文献摘录" / "摘录一.md"
        check(
            "create_document 自动补 .md、空正文落盘且不注入标题",
            doc.status_code == 200 and target.is_file() and target.read_bytes() == b"",
            f"status={doc.status_code}",
        )

        complete_body = "# 完整初始正文\n一次创建。\n"
        complete = client.post(
            "/api/resource/node",
            json={
                "action": "create_document",
                "parent": "文献摘录",
                "name": "完整摘录",
                "content": complete_body,
            },
        )
        complete_target = project / "文献摘录" / "完整摘录.md"
        check(
            "create_document 可一次落下完整初始正文",
            complete.status_code == 200
            and complete_target.read_text(encoding="utf-8") == complete_body,
            f"status={complete.status_code}",
        )

        body = "# 摘录\n针孔密度与 RH 正相关。\n"
        wrote = client.post(
            "/api/resource/write",
            json={"path": "文献摘录/摘录一.md", "content": body},
        )
        check(
            "write 内容真写进文件",
            wrote.status_code == 200 and target.read_text(encoding="utf-8") == body,
            f"status={wrote.status_code}",
        )

        read = client.get("/api/resource/read", params={"path": "文献摘录/摘录一.md"})
        check(
            "read 往返一致",
            read.status_code == 200 and read.json()["content"] == body,
            f"status={read.status_code}",
        )

        renamed = client.post(
            "/api/resource/node",
            json={"action": "rename", "path": "文献摘录/摘录一.md", "name": "终稿.md"},
        )
        check(
            "rename 旧名消失、新名出现且 Markdown 正文逐字保留",
            renamed.status_code == 200
            and not target.exists()
            and (project / "文献摘录" / "终稿.md").read_text(encoding="utf-8") == body,
            f"status={renamed.status_code}",
        )

        copied = client.post("/api/resource/node", json={"action": "copy", "path": "实验数据.csv"})
        check(
            "copy 保留原件并生成避让副本",
            copied.status_code == 200
            and (project / "实验数据.csv").is_file()
            and (project / "实验数据 (2).csv").is_file(),
            f"status={copied.status_code} node={copied.json()}",
        )

        moved = client.post(
            "/api/resource/node",
            json={"action": "move", "path": "实验数据 (2).csv", "target_dir": "笔记"},
        )
        check(
            "move 源消失目标出现",
            moved.status_code == 200
            and not (project / "实验数据 (2).csv").exists()
            and (project / "笔记" / "实验数据 (2).csv").is_file(),
            f"status={moved.status_code}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_name_collision_never_overwrites() -> None:
    """同名冲突自动避让, 用户已有资料不被静默覆盖。"""

    project = Path(tempfile.mkdtemp(prefix="v02-dup-"))
    try:
        original = project / "笔记.md"
        original.write_text("原始内容", encoding="utf-8")
        client = _client(project)
        client.post(
            "/api/resource/node",
            json={"action": "create_document", "parent": "", "name": "笔记"},
        )
        check(
            "同名新建不覆盖原文件，避让文件仍为空正文",
            original.read_text(encoding="utf-8") == "原始内容"
            and (project / "笔记 (2).md").read_bytes() == b"",
            f"entries={[p.name for p in project.iterdir()]}",
        )

        rename_source = project / "待改名.md"
        rename_source.write_text("待改名内容", encoding="utf-8")
        renamed = client.post(
            "/api/resource/node",
            json={"action": "rename", "path": "待改名.md", "name": "笔记.md"},
        )
        check(
            "同名重命名沿用统一避让规则且不覆盖",
            renamed.status_code == 200
            and renamed.json()["node"]["path"] == "笔记 (3).md"
            and (project / "笔记 (3).md").read_text(encoding="utf-8") == "待改名内容"
            and original.read_text(encoding="utf-8") == "原始内容",
            f"status={renamed.status_code} body={renamed.text[:160]}",
        )

        protected = project / "报告.final.PDF"
        protected.write_bytes(b"pdf")
        changed_suffix = client.post(
            "/api/resource/node",
            json={"action": "rename", "path": protected.name, "name": "报告.final.txt"},
        )
        check(
            "服务端拒绝重命名修改最后一个文件后缀",
            changed_suffix.status_code == 400
            and changed_suffix.json()["detail"] == "file_extension_change_forbidden"
            and protected.read_bytes() == b"pdf",
            f"status={changed_suffix.status_code} body={changed_suffix.text[:160]}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_path_escape_is_rejected() -> None:
    """项目外路径、项目根自身、移进自己子树 —— 三类越界都必须拒绝。"""

    project = Path(tempfile.mkdtemp(prefix="v02-esc-"))
    try:
        _seed(project)
        client = _client(project)

        escaped = client.get("/api/resource/read", params={"path": "../../../etc/passwd"})
        check(
            "读越界被拒",
            escaped.status_code == 400 and escaped.json()["detail"] == "path_outside_project",
            f"status={escaped.status_code} body={escaped.text[:120]}",
        )

        root_rename = client.post(
            "/api/resource/node", json={"action": "rename", "path": "", "name": "x"}
        )
        check(
            "项目根不可重命名",
            root_rename.status_code == 400 and root_rename.json()["detail"] == "cannot_modify_root",
            f"status={root_rename.status_code}",
        )

        into_self = client.post(
            "/api/resource/node",
            json={"action": "move", "path": "笔记", "target_dir": "笔记"},
        )
        check(
            "目录不可移进自己, 且原目录与子项完好",
            into_self.status_code == 400
            and into_self.json()["detail"] == "move_into_self"
            and (project / "笔记" / "想法.md").is_file(),
            f"status={into_self.status_code} body={into_self.text[:120]}",
        )

        raw_escape = client.get("/api/resource/raw", params={"path": "../../../etc/hosts"})
        check(
            "raw 字节流同样受越界保护",
            raw_escape.status_code == 400,
            f"status={raw_escape.status_code}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_delete_is_not_permanent() -> None:
    """旧 resource trash 已删除；资源域不再暴露绝对路径删除入口。"""

    project = Path(tempfile.mkdtemp(prefix="v02-trash-"))
    try:
        _seed(project)
        client = _client(project)
        victim = project / "笔记" / "想法.md"
        legacy = client.post("/api/resource/trash", json={"path": "笔记/想法.md"})
        check(
            "旧 resource trash 不再暴露且文件保持不变",
            legacy.status_code == 404 and victim.is_file(),
            f"legacy={legacy.status_code} exists={victim.is_file()}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_import_modes() -> None:
    """复制保留同步冲突决策；关联必须进入可恢复后台任务。"""

    project = Path(tempfile.mkdtemp(prefix="v02-imp-"))
    outside = Path(tempfile.mkdtemp(prefix="v02-src-"))
    try:
        source = outside / "外部论文.md"
        source.write_text("外部内容", encoding="utf-8")
        client = _client(project)

        copied = client.post(
            "/api/resource/import",
            json={"mode": "copy", "sources": [str(source)], "target_dir": ""},
        )
        check(
            "copy 模式保留同步冲突决策入口并创建副本",
            copied.status_code == 200 and (project / "外部论文.md").is_file() and source.is_file(),
            f"status={copied.status_code}",
        )

        linked = client.post(
            "/api/resource/import",
            json={"mode": "link", "sources": [str(source)], "target_dir": ""},
        )
        copies = [path.name for path in project.iterdir() if path.name.startswith("外部论文")]
        check(
            "link 模式拒绝绕过可恢复后台任务且不产生第二份副本",
            linked.status_code == 409
            and linked.json().get("detail") == IMPORT_BACKGROUND_REQUIRED
            and len(copies) == 1,
            f"status={linked.status_code} copies={copies}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def test_resource_tree_carries_authoritative_link_root_identity() -> None:
    """每个关联节点都能在同一份 tree 响应中解析到 Content 的 root_id。"""

    project = Path(tempfile.mkdtemp(prefix="v02-tree-link-"))
    outside = Path(tempfile.mkdtemp(prefix="v02-tree-source-"))
    try:
        (outside / "外部资料.md").write_text("linked", encoding="utf-8")
        client = _client(project)
        content = client.app.state.content
        current = content.project("")
        linked = content.authorize_root(current.id, str(outside), "关联资料")
        response = client.get("/api/resource/tree", params={"project": current.id})
        payload = response.json()
        nodes = list(payload.get("nodes", []))
        projected = next((node for node in nodes if node.get("path") == linked.mount_path), None)
        check(
            "tree 节点与响应级关联根字典共享权威 root_id",
            response.status_code == 200
            and projected is not None
            and projected.get("link_root_id") == linked.root_id
            and payload["linked_roots"][linked.root_id]["source_path"] == str(outside.resolve()),
            f"status={response.status_code} body={response.text[:300]}",
        )
        continued = client.get(
            "/api/resource/tree",
            params={"project": current.id, "path": "关联资料", "depth": 1},
        )
        check(
            "旧布局关联目录可按资料根相对路径续扫",
            continued.status_code == 200
            and any(node.get("name") == "外部资料.md" for node in continued.json()["nodes"]),
            f"status={continued.status_code} body={continued.text[:300]}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def test_resource_tree_scan_does_not_block_event_loop() -> None:
    project = Path(tempfile.mkdtemp(prefix="v02-tree-loop-"))
    client = _client(project)
    try:
        app = client.app
        content = app.state.content
        current = content.project("")
        original_tree = content.tree
        release = threading.Event()

        @app.get("/api/test-healthz")
        async def healthz() -> dict[str, bool]:
            return {"ok": True}

        def blocked_tree(*args, **kwargs):
            release.wait(RESOURCE_TREE_BLOCK_SECONDS)
            return original_tree(*args, **kwargs)

        async def exercise() -> tuple[int, int, float]:
            transport = httpx.ASGITransport(app=app)
            timer = threading.Timer(RESOURCE_TREE_BLOCK_SECONDS, release.set)
            timer.start()
            try:
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://test"
                ) as browser:
                    with patch.object(content, "tree", side_effect=blocked_tree):
                        tree_request = asyncio.create_task(
                            browser.get("/api/resource/tree", params={"project": current.id})
                        )
                        health_request = asyncio.create_task(browser.get("/api/test-healthz"))
                        started = time.monotonic()
                        health = await health_request
                        elapsed = time.monotonic() - started
                        tree = await tree_request
                        return health.status_code, tree.status_code, elapsed
            finally:
                release.set()
                timer.cancel()

        health_status, tree_status, elapsed = asyncio.run(exercise())
        check(
            "resource tree scan leaves the event loop available for health checks",
            health_status == 200
            and tree_status == 200
            and elapsed < RESOURCE_TREE_HEALTH_MAX_SECONDS,
            f"health={health_status} tree={tree_status} elapsed={elapsed:.3f}s",
        )
    finally:
        client.close()
        shutil.rmtree(project, ignore_errors=True)


def test_resource_search_matches_name_and_content() -> None:
    """资料搜索要同时命中文件名与正文, 并标明命中来源 (PRD「资料搜索」)。"""

    project = Path(tempfile.mkdtemp(prefix="v02-search-"))
    try:
        _seed(project)
        client = _client(project)

        by_name = client.get("/api/resource/search", params={"q": "想法"})
        hits = by_name.json()["hits"]
        check(
            "文件名命中标记为 name",
            by_name.status_code == 200
            and any(
                h["matched"] == "name" and h["name"] == "想法.md" and h["reveal"] is None
                for h in hits
            ),
            f"hits={hits}",
        )

        by_content = client.get("/api/resource/search", params={"q": "针孔"})
        content_hits = by_content.json()["hits"]
        check(
            "正文命中标记为 content 且带可重放的查找请求",
            by_content.status_code == 200
            and any(
                h["matched"] == "content"
                and h["snippet"]
                and h["reveal"]["kind"] == "find"
                and h["reveal"]["query"] == "针孔"
                and h["reveal"]["source_revision"].startswith("sha256:")
                for h in content_hits
            ),
            f"hits={content_hits}",
        )

        empty = client.get("/api/resource/search", params={"q": "   "})
        check(
            "空查询返回空结果而不是全量",
            empty.status_code == 200 and empty.json()["hits"] == [],
            f"body={empty.text[:120]}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_search_reads_current_plain_and_docx_bytes() -> None:
    """Text and DOCX searches read current stable bytes without an index or cache."""

    project = Path(tempfile.mkdtemp(prefix="v02-search-content-"))
    try:
        (project / "直接读取.txt").write_text("纯文本暗号：琥珀", encoding="utf-8")
        (project / "会议记录.docx").write_bytes(_docx_bytes())
        (project / "损坏文档.docx").write_bytes(b"not-a-docx")
        client = _client(project)

        for query, name in (
            ("琥珀", "直接读取.txt"),
            ("深海蓝", "会议记录.docx"),
            ("银杏叶", "会议记录.docx"),
            ("晨星", "会议记录.docx"),
            ("归航", "会议记录.docx"),
        ):
            response = client.get("/api/resource/search", params={"q": query})
            hits = response.json()["hits"]
            check(
                f"稳定字节正文可搜索: {query}",
                response.status_code == 200
                and any(
                    hit["name"] == name and hit["matched"] == "content" and query in hit["snippet"]
                    for hit in hits
                ),
                f"hits={hits}",
            )

        global_response = client.get("/api/search", params={"q": "银杏叶"})
        check(
            "全局搜索复用 DOCX 正文结果",
            global_response.status_code == 200
            and any(
                hit["domain"] == "resource"
                and hit["title"] == "会议记录.docx"
                and hit["reveal"]["query"] == "银杏叶"
                for hit in global_response.json()["hits"]
            ),
            global_response.text[:240],
        )

        live = project / "即时更新.md"
        live.write_text("旧版本暗号", encoding="utf-8")
        old_hits = client.get("/api/resource/search", params={"q": "旧版本暗号"}).json()["hits"]
        live.write_text("新版本暗号", encoding="utf-8")
        new_hits = client.get("/api/resource/search", params={"q": "新版本暗号"}).json()["hits"]
        stale_hits = client.get("/api/resource/search", params={"q": "旧版本暗号"}).json()["hits"]
        check(
            "文件改写后搜索立即读取当前字节",
            [hit["name"] for hit in old_hits] == ["即时更新.md"]
            and [hit["name"] for hit in new_hits] == ["即时更新.md"]
            and stale_hits == [],
            f"old={old_hits} new={new_hits} stale={stale_hits}",
        )

        broken = client.get("/api/resource/search", params={"q": "损坏文档.docx"})
        check(
            "损坏 DOCX 不拖垮搜索且仍可按文件名命中",
            broken.status_code == 200
            and [hit["name"] for hit in broken.json()["hits"]] == ["损坏文档.docx"],
            broken.text[:240],
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_search_ranks_metadata_before_content_and_limit() -> None:
    """Exact name, name, path and body ordering is global and file-only."""

    project = Path(tempfile.mkdtemp(prefix="v02-search-rank-"))
    try:
        query = "排序词.md"
        (project / query).write_text(f"正文也有 {query}", encoding="utf-8")
        (project / f"前缀-{query}-后缀.txt").write_text("无关正文", encoding="utf-8")
        path_directory = project / f"父目录-{query}"
        path_directory.mkdir()
        (path_directory / "路径候选.txt").write_text("无关正文", encoding="utf-8")
        (project / "正文候选.txt").write_text(f"只在正文出现 {query}", encoding="utf-8")
        client = _client(project)

        response = client.get("/api/resource/search", params={"q": query})
        hits = response.json()["hits"]
        check(
            "命中按完整文件名、文件名、路径、正文排序",
            [(hit["name"], hit["matched"]) for hit in hits]
            == [
                (query, "name"),
                (f"前缀-{query}-后缀.txt", "name"),
                ("路径候选.txt", "path"),
                ("正文候选.txt", "content"),
            ],
            f"hits={hits}",
        )
        check(
            "目录不作为资料命中且同一文件只返回最高优先级一条",
            len(hits) == 4 and sum(hit["name"] == query for hit in hits) == 1,
            f"hits={hits}",
        )

        limit_query = "窗口词.docx"
        for index in range(MAX_RESULTS):
            (project / f"正文窗口-{index:03d}.txt").write_text(
                f"正文中包含 {limit_query}", encoding="utf-8"
            )
        (project / limit_query).write_bytes(b"name-only")
        limited = client.get("/api/resource/search", params={"q": limit_query})
        limited_hits = limited.json()["hits"]
        check(
            "结果上限在全局排序后应用",
            limited.status_code == 200
            and len(limited_hits) == MAX_RESULTS
            and limited_hits[0]["name"] == limit_query
            and limited.json()["truncated"],
            limited.text[:240],
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_resource_search_includes_authorized_directory_and_file() -> None:
    """Logical resource enumeration includes both authorized mount kinds."""

    project = Path(tempfile.mkdtemp(prefix="v02-search-mount-project-"))
    outside = Path(tempfile.mkdtemp(prefix="v02-search-mount-source-"))
    try:
        external_directory = outside / "目录来源"
        external_directory.mkdir()
        (external_directory / "目录资料.md").write_text("关联检索暗号", encoding="utf-8")
        external_file = outside / "单文件资料.txt"
        external_file.write_text("关联检索暗号", encoding="utf-8")
        client = _client(project)
        content = client.app.state.content
        project_id = content.project().id
        directory_ref = content.authorize_root(project_id, str(external_directory), "关联目录")
        file_ref = content.authorize_root(project_id, str(external_file), "关联单文件.txt")

        response = client.get("/api/resource/search", params={"q": "关联检索暗号"})
        paths = {hit["path"] for hit in response.json()["hits"]}
        check(
            "资料搜索覆盖授权关联目录与关联单文件",
            response.status_code == 200
            and paths == {f"{directory_ref.mount_path}/目录资料.md", file_ref.mount_path},
            f"paths={paths}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)
        shutil.rmtree(outside, ignore_errors=True)


def _import_bibliography(
    client: TestClient, project_id: str, uploads: list[tuple[str, bytes]]
) -> Any:
    """v1 受理面: multipart `files` + query `project_id`, 成功回 201。"""

    return client.post(
        "/api/v1/imports/bibliography",
        params={"project_id": project_id} if project_id else None,
        files=[("files", (name, payload, "application/x-bibtex")) for name, payload in uploads],
    )


def _literatures(client: TestClient, project_id: str = "", **params: Any) -> dict:
    response = client.get(
        "/api/v1/literatures", params={"project_id": project_id, **params} if project_id else params
    )
    assert response.status_code == 200, response.text
    return response.json()


def _tag_id(client: TestClient, name: str) -> str:
    """v1 的标签筛选按 id 走, 先把名字换成 id。"""

    entries = client.get("/api/v1/tags").json()
    match = next((entry for entry in entries if entry["name"] == name), None)
    assert match is not None, f"tag {name!r} missing in {entries}"
    return str(match["id"])


def _add_tags(client: TestClient, identifiers: list[str], tags: list[str]) -> Any:
    return client.post(
        "/api/v1/literatures/bulk",
        json={
            "literature_ids": identifiers,
            "operation": "add_tags",
            "parameters": {"tags": tags},
        },
    )


def test_literature_import_parses_and_appends() -> None:
    """BIB/RIS 解析真实字段; 文献库不判重, 同一份文件再导入就是新增一条。"""

    project = Path(tempfile.mkdtemp(prefix="v02-lit-"))
    try:
        (project / "sample.bib").write_text(SAMPLE_BIB, encoding="utf-8")
        (project / "sample.ris").write_text(SAMPLE_RIS, encoding="utf-8")
        client = _client(project)
        project_id = client.app.state.content.project().id

        bib = _import_bibliography(client, project_id, [("sample.bib", SAMPLE_BIB.encode())])
        check(
            "BIB 入库 1 条",
            bib.status_code == 201 and bib.json()["count"] == 1,
            f"body={bib.text[:160]}",
        )

        ris = _import_bibliography(client, project_id, [("sample.ris", SAMPLE_RIS.encode())])
        check(
            "RIS 入库 1 条",
            ris.status_code == 201 and ris.json()["count"] == 1,
            f"body={ris.text[:160]}",
        )

        again = _import_bibliography(client, project_id, [("sample.bib", SAMPLE_BIB.encode())])
        check(
            "同一份 BIB 再导入是新增一条 (count=1)",
            again.status_code == 201 and again.json()["count"] == 1,
            f"body={again.text[:160]}",
        )

        items = _literatures(client, project_id)["items"]
        bib_item = next((i for i in items if "Humidity" in i["title"]), None)
        ris_item = next((i for i in items if "Turbulence" in i["title"]), None)
        check(
            "BibTeX 作者语序归一化为 First Last",
            bib_item is not None and bib_item["creators_display"] == "Wei Zhang, Yuki Nakamura",
            f"creators={bib_item and bib_item['creators_display']}",
        )
        check(
            "RIS 每行作者也归一化, 作者边界可分辨",
            ris_item is not None and ris_item["creators_display"] == "Elena Ivanova, Marc Dubois",
            f"creators={ris_item and ris_item['creators_display']}",
        )
        check(
            "跨行摘要与 DOI 被完整解析",
            bib_item is not None
            and "encapsulation strategies" in (bib_item["abstract"] or "")
            and bib_item["doi"] == "10.1038/s41560-023-01234-8",
            f"item={bib_item}",
        )
        counts = client.get("/api/v1/literatures/counts", params={"project_id": project_id})
        check(
            "题录入库时全文状态为未获取, 不虚标已就绪",
            counts.status_code == 200 and counts.json()["without_fulltext"] == len(items),
            f"counts={counts.text[:160]}",
        )

        library = load_library(project_id)
        check(
            "文献库落盘到全局仓储且项目投影条目数一致",
            len(library.items) == len(items),
            f"disk={len(library.items)} api={len(items)}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_literature_filter_sort_and_batch() -> None:
    """筛选 / 排序 / 批量打标要真实落盘, 批量移除要真减条目。"""

    project = Path(tempfile.mkdtemp(prefix="v02-litfilter-"))
    try:
        client = _client(project)
        project_id = client.app.state.content.project().id
        imported = _import_bibliography(
            client,
            project_id,
            [("a.bib", SAMPLE_BIB.encode()), ("b.ris", SAMPLE_RIS.encode())],
        )
        assert imported.status_code == 201, imported.text

        desc = _literatures(client, project_id, sort="year", order="desc")
        years = [item["year"] for item in desc["items"]]
        check("按年份倒序排序生效", years == sorted(years, reverse=True), f"years={years}")

        searched = _literatures(client, project_id, q="perovskite")
        check(
            "搜索按标题命中",
            len(searched["items"]) == 1 and "Humidity" in searched["items"][0]["title"],
            f"items={[i['title'] for i in searched['items']]}",
        )

        listed = _literatures(client, project_id)
        check("导入关键词不自动成为标签", all(not item["tags"] for item in listed["items"]))
        target_ids = [item["id"] for item in listed["items"] if "Turbulence" in item["title"]]
        explicit_tag = _add_tags(client, target_ids, ["turbulence"])
        check("显式添加筛选标签成功", explicit_tag.status_code == 200, explicit_tag.text[:160])
        tagged = _literatures(client, project_id, tag_id=_tag_id(client, "turbulence"))
        check(
            "按标签筛选生效",
            len(tagged["items"]) == 1 and "Turbulence" in tagged["items"][0]["title"],
            f"items={[i['title'] for i in tagged['items']]}",
        )

        ids = [item["id"] for item in listed["items"]]
        batched = _add_tags(client, ids, ["待阅读"])
        after = _literatures(client, project_id, tag_id=_tag_id(client, "待阅读"))
        check(
            "批量打标真实落盘并可被筛出",
            batched.status_code == 200 and len(after["items"]) == len(ids),
            f"batched={batched.text[:120]} filtered={len(after['items'])}",
        )

        removed = client.post("/api/v1/literatures/bulk-delete", json={"literature_ids": [ids[0]]})
        remaining = _literatures(client, project_id)
        check(
            "批量移除真实减少条目",
            removed.status_code == 200 and remaining["total"] == len(ids) - 1,
            f"total={remaining['total']}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_global_search_spans_domains() -> None:
    """全局搜索要同时给出资料与文献两域的命中 (PRD「全局搜索」)。"""

    project = Path(tempfile.mkdtemp(prefix="v02-gs-"))
    try:
        _seed(project)
        client = _client(project)
        project_id = client.app.state.content.project().id
        imported = _import_bibliography(client, project_id, [("a.bib", SAMPLE_BIB.encode())])
        assert imported.status_code == 201, imported.text

        resource_hit = client.get("/api/search", params={"q": "想法"})
        domains = {h["domain"] for h in resource_hit.json()["hits"]}
        check(
            "资料域命中",
            resource_hit.status_code == 200 and "resource" in domains,
            f"hits={resource_hit.json()['hits']}",
        )

        lit_hit = client.get("/api/search", params={"q": "perovskite"})
        lit_domains = {h["domain"] for h in lit_hit.json()["hits"]}
        check(
            "文献域命中",
            lit_hit.status_code == 200 and "literature" in lit_domains,
            f"hits={lit_hit.json()['hits']}",
        )

        blank = client.get("/api/search", params={"q": "  "})
        check(
            "空查询返回空命中",
            blank.status_code == 200 and blank.json()["hits"] == [],
            f"body={blank.text[:120]}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_foreign_project_paths_are_rejected() -> None:
    """文献库与全局搜索不得接受任意绝对路径作为 project。

    回归守卫：这两个端点曾各自写 `Path(project).expanduser()`，直接拿
    客户端传来的路径当项目根。全局搜索还会递归读文件正文，等于允许
    扫任意本机目录并回报命中内容。现在两者统一经 content 域解析。
    """

    project = Path(tempfile.mkdtemp(prefix="scholarseed-own-"))
    foreign = Path(tempfile.mkdtemp(prefix="scholarseed-foreign-"))
    try:
        (foreign / "私密.md").write_text("topsecret 别处的内容", encoding="utf-8")
        client = _client(project)

        listed = client.get("/api/v1/literatures", params={"project_id": str(foreign)})
        check(
            "文献库拒绝项目外绝对路径",
            listed.status_code >= 400,
            f"status={listed.status_code} body={listed.text[:100]}",
        )

        searched = client.get("/api/search", params={"q": "topsecret", "project": str(foreign)})
        check(
            "全局搜索拒绝项目外绝对路径且不泄内容",
            searched.status_code >= 400 and "topsecret" not in searched.text,
            f"status={searched.status_code} body={searched.text[:100]}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)
        shutil.rmtree(foreign, ignore_errors=True)


def test_literature_import_appends_without_touching_existing_rows() -> None:
    """文献库不做重复判定（proposal 91）：导入只追加，既存行的用户状态原样保留。"""

    existing = LiteratureItem(
        id="saved",
        title="Saved title",
        authors="Saved author",
        journal="",
        year=2024,
        fulltext=FulltextStatus.READY,
        tags=("saved",),
        collection="My collection",
        added_at=123.0,
        notes=(LiteratureNote("note", "Keep my note", 124.0),),
    )
    incoming = LiteratureItem(
        id="fresh",
        title="Saved title",
        authors="Incoming author",
        journal="New journal",
        year=2025,
        fulltext=FulltextStatus.NONE,
        tags=("new",),
        abstract="New abstract",
    )
    view, added = append_items(LiteratureView(items=(existing,)), (incoming,))
    check("同题录再导入是并列两条，不合并进既存条目", view.items == (existing, incoming))
    check("追加式入库按新增条数计数", added == 1)
    check(
        "既存条目的题录、全文状态、标签、分类、时间与笔记都不被触碰",
        view.items[0] == existing and existing.notes[0].text == "Keep my note",
    )


def test_literature_collections_are_not_tags() -> None:
    """分类与标签是两个维度，不得互相污染。

    回归守卫：`append_items` / 批量操作 / 全文状态三处曾都写
    `collections=collect_tags(items)`，把标签当成分类写回。后果是侧栏分类区
    出现一堆并不存在的「分类」，且用户真建的分类会在下一次批量操作后消失。
    """

    project = Path(tempfile.mkdtemp(prefix="scholarseed-litcol-"))
    try:
        source = project / "seed.bib"
        source.write_text(
            "@article{a, title={T1}, author={Ivanova, Elena}, journal={J1},"
            " year={2021}, doi={10.1/a}, keywords={观测方法, 低仰角}}\n"
            "@article{b, title={T2}, author={Chen, Wei}, journal={J2},"
            " year={2024}, doi={10.1/b}, keywords={综述}}\n",
            encoding="utf-8",
        )
        client = _client(project)
        project_id = client.app.state.content.project().id
        imported = _import_bibliography(client, project_id, [("seed.bib", source.read_bytes())])
        assert imported.status_code == 201, imported.text
        listed = _literatures(client, project_id)
        ids = [item["id"] for item in listed["items"]]
        check("导入不自动建标签", all(not item["tags"] for item in listed["items"]))
        check("导入不自动建分类", all(not item["collections"] for item in listed["items"]))

        for title, tags in (("T1", ("观测方法", "低仰角")), ("T2", ("综述",))):
            identifiers = [item["id"] for item in listed["items"] if item["title"] == title]
            for tag in tags:
                response = _add_tags(client, identifiers, [tag])
                check("分类测试显式打标成功", response.status_code == 200, response.text[:120])
        # 分类与标签都是**用户级**维度 (整个进程共用一份仓储), 所以断言按本项目的
        # facet 作用域收敛, 不与同一轮里其他用例的夹具互相干扰。
        facets = client.get("/api/v1/literatures/facets", params={"project_id": project_id})
        assert facets.status_code == 200, facets.text
        facet_names = {entry["name"] for entry in facets.json()["collections"]}
        check(
            "打标之后分类维度里没有标签名，标签不污染分类",
            not facet_names & {"观测方法", "低仰角", "综述", "核心"},
            f"collections={sorted(facet_names)}",
        )
        # 标签清单是全库的 (删除标签是全库操作), 计数才按请求的项目范围收敛;
        # 因此这里断言的是「本项目里被用到的标签」, 而不是标签表的全部内容。
        tag_names = {entry["name"] for entry in facets.json()["tags"] if entry["count"]}
        check(
            "标签单独成维度返回，且只有显式打的三个落在本项目",
            tag_names == {"观测方法", "低仰角", "综述"},
            f"tags={sorted(tag_names)}",
        )

        created = client.post("/api/v1/collections", json={"name": "大气湍流"})
        assert created.status_code == 201, created.text
        check("批量打标成功", _add_tags(client, ids, ["核心"]).status_code == 200)
        survived = [entry["name"] for entry in client.get("/api/v1/collections").json()]
        check("批量打标后用户建的分类仍在", "大气湍流" in survived, f"collections={survived}")

        noted = client.post(
            f"/api/v1/literatures/{ids[0]}/notes",
            json={"text": "重复导入后仍应保留的笔记"},
        )
        assert noted.status_code == 201, noted.text
        repeated = _import_bibliography(client, project_id, [("seed.bib", source.read_bytes())])
        assert repeated.status_code == 201, repeated.text
        notes = client.get(f"/api/v1/literatures/{ids[0]}/notes").json()
        reopened = _literatures(client, project_id)
        check(
            "HTTP 重复导入后既存条目的笔记仍在，且导入只追加",
            [note["text"] for note in notes["items"]] == ["重复导入后仍应保留的笔记"]
            and repeated.json()["count"] == len(ids)
            and reopened["total"] == len(ids) * 2,
            f"notes={notes} repeated={repeated.text[:120]} total={reopened['total']}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_literature_collection_delete_keeps_items() -> None:
    """删分类不删文献：里面的条目退回未分类。

    分类是组织方式而非容器。把它当容器删掉会连带删掉用户积累的题录。
    """

    project = Path(tempfile.mkdtemp(prefix="scholarseed-litdel-"))
    try:
        source = project / "seed.bib"
        source.write_text(
            "@article{a, title={T1}, author={Sato, Kenji}, journal={J},"
            " year={2023}, doi={10.1/z}}\n",
            encoding="utf-8",
        )
        client = _client(project)
        project_id = client.app.state.content.project().id
        imported = _import_bibliography(client, project_id, [("seed.bib", source.read_bytes())])
        assert imported.status_code == 201, imported.text
        ids = [item["id"] for item in imported.json()["items"]]

        created = client.post("/api/v1/collections", json={"name": "待阅读"})
        assert created.status_code == 201, created.text
        collection_id = str(created.json()["id"])
        moved = client.post(
            "/api/v1/literatures/bulk",
            json={
                "literature_ids": ids,
                "operation": "add_collections",
                "parameters": {"collection_ids": [collection_id]},
            },
        )
        assert moved.status_code == 200, moved.text
        scoped = _literatures(client, collection_id=collection_id)
        check("条目可移进分类并被筛出", len(scoped["items"]) == 1, f"n={len(scoped['items'])}")

        deleted = client.delete(f"/api/v1/collections/{collection_id}")
        check("删除分类成功", deleted.status_code == 200, deleted.text[:160])
        after = _literatures(client, project_id)
        check(
            "删分类后文献仍在且退回未分类",
            after["total"] == 1 and after["items"][0]["collections"] == [],
            f"total={after['total']} collections={after['items'][0]['collections']}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_metadata_patch_preserves_user_fields() -> None:
    """改元数据不得重建整行：笔记、分类与其余字段必须原样留着。"""

    with tempfile.TemporaryDirectory(prefix="scholarseed-litstatus-") as directory:
        project = Path(directory)
        with _client(project) as client:
            project_id = client.app.state.content.project().id
            imported = _import_bibliography(client, project_id, [("seed.bib", SAMPLE_BIB.encode())])
            assert imported.status_code == 201, imported.text
            item_id = str(imported.json()["items"][0]["id"])

            collection = client.post("/api/v1/collections", json={"name": "人工归档"})
            assert collection.status_code == 201, collection.text
            associated = client.post(
                "/api/v1/literatures/bulk",
                json={
                    "literature_ids": [item_id],
                    "operation": "add_collections",
                    "parameters": {"collection_ids": [str(collection.json()["id"])]},
                },
            )
            assert associated.status_code == 200, associated.text
            noted = client.post(
                f"/api/v1/literatures/{item_id}/notes",
                json={"text": "此笔记不能因修改元数据而消失"},
            )
            assert noted.status_code == 201, noted.text

            before = client.get(f"/api/v1/literatures/{item_id}").json()
            patched = client.patch(
                f"/api/v1/literatures/{item_id}",
                json={"fields": {"year": 2031, "title": "改写后的标题"}},
            )
            assert patched.status_code == 200, patched.text
            after = client.get(f"/api/v1/literatures/{item_id}").json()
            check(
                "元数据修改只变更被改字段，保留笔记、分类、入库时间和其余元数据",
                after["year"] == 2031
                and after["title"] == "改写后的标题"
                and [note["text"] for note in after["notes"]]
                == [note["text"] for note in before["notes"]]
                and [entry["id"] for entry in after["collections"]]
                == [entry["id"] for entry in before["collections"]]
                and after["created_at"] == before["created_at"]
                and after["doi"] == before["doi"]
                and after["abstract"] == before["abstract"]
                and after["creators_display"] == before["creators_display"],
                f"before={before}\nafter={after}",
            )


def test_collection_rename_preserves_hierarchy_and_rejects_collision() -> None:
    """分类名唯一性按**同级**判定 (v1 `literature_collection_sibling_names`)。

    改名不得丢子分类归属; 同一父级下撞名必须 409 且不动任何既有层级。
    """

    with tempfile.TemporaryDirectory(prefix="scholarseed-litrename-") as directory:
        with _client(Path(directory)) as client:
            created: dict[str, str] = {}
            for name, parent in (
                ("parent", ""),
                ("child", "parent"),
                ("sibling", "parent"),
                ("other", ""),
            ):
                response = client.post(
                    "/api/v1/collections",
                    json={"name": name, "parent_id": created.get(parent) or None},
                )
                assert response.status_code == 201, response.text
                created[name] = str(response.json()["id"])

            renamed = client.patch(
                f"/api/v1/collections/{created['parent']}", json={"name": "renamed"}
            )
            assert renamed.status_code == 200, renamed.text
            before = {
                entry["name"]: entry["parent_id"]
                for entry in client.get("/api/v1/collections").json()
            }
            check(
                "分类改名保留全部子分类归属",
                before["child"] == created["parent"] and before["sibling"] == created["parent"],
                str(before),
            )

            collision = client.patch(
                f"/api/v1/collections/{created['child']}", json={"name": "sibling"}
            )
            after = {
                entry["name"]: entry["parent_id"]
                for entry in client.get("/api/v1/collections").json()
            }
            check(
                "同级同名冲突拒绝且不覆盖任何层级",
                collision.status_code == 409
                and collision.json()["detail"]["code"] == "COLLECTION_NAME_EXISTS"
                and after == before,
                f"status={collision.status_code} body={collision.text[:120]} tree={after}",
            )

            renamed_child = client.patch(
                f"/api/v1/collections/{created['child']}", json={"name": "renamed-child"}
            )
            check(
                "子分类改名保留父级",
                renamed_child.status_code == 200
                and renamed_child.json()["parent_id"] == created["parent"],
                renamed_child.text[:160],
            )

            cross_level = client.post(
                "/api/v1/collections",
                json={"name": "renamed", "parent_id": created["parent"]},
            )
            check(
                "唯一性只约束同级：跨层级同名可以共存",
                cross_level.status_code == 201,
                cross_level.text[:160],
            )


def test_literature_bibtex_export_disambiguates_keys() -> None:
    """导出 .bib 时重复引用键必须错开。

    同作者同年的两篇否则生成同名条目，导入文献管理工具时后一条会静默覆盖前一条。
    """

    project = Path(tempfile.mkdtemp(prefix="scholarseed-litbib-"))
    try:
        source = project / "seed.bib"
        source.write_text(
            "@article{a, title={First}, author={Chen, Wei}, journal={J},"
            " year={2024}, doi={10.1/one}}\n"
            "@article{b, title={Second}, author={Chen, Wei}, journal={J},"
            " year={2024}, doi={10.1/two}}\n",
            encoding="utf-8",
        )
        client = _client(project)
        project_id = client.app.state.content.project().id
        imported = _import_bibliography(client, project_id, [("seed.bib", source.read_bytes())])
        assert imported.status_code == 201, imported.text
        ids = [item["id"] for item in imported.json()["items"]]
        exported = client.post("/api/v1/exports", json={"literature_ids": ids, "format": "bibtex"})
        body = exported.json().get("bibtex", "")
        keys = [
            line.split("{", 1)[1].rstrip(",") for line in body.splitlines() if line.startswith("@")
        ]
        check(
            "导出两条且引用键不重复",
            exported.status_code == 200 and len(keys) == 2 and len(set(keys)) == 2,
            f"status={exported.status_code} keys={keys}",
        )
    finally:
        shutil.rmtree(project, ignore_errors=True)


def test_managed_layout_tree_root_is_the_resources_library() -> None:
    """MANAGED 项目: 在资料树根上新建, 东西要落进 `resources/` 而不是项目根。

    资料树的根是资料库根, 而 `ContentPort` 的路径相对**项目根** —— 空串在两者里
    含义不同。翻译漏掉时, 新建的目录会落到 `resources/` 外面: 磁盘上有、界面上没有,
    且不报错。LEGACY 项目两个根重合, 所以这个坑只在内置双库布局下暴露, 必须专门守。
    """

    workspace = Path(tempfile.mkdtemp(prefix="v02-managed-")).resolve()
    catalog = ContentCatalog(workspace.parent / f"{workspace.name}-content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    project = content.create_project("内置双库项目")
    root = Path(project.root)

    app = FastAPI()
    app.state.workspace = str(workspace)
    app.state.content = content
    register_resource_routes(app)
    register_search_routes(app)
    client = TestClient(app)

    created = client.post(
        "/api/resource/node",
        json={"project": project.id, "action": "create_folder", "parent": "", "name": "树根目录"},
    )
    check(
        "树根新建落进资料库, 路径相对项目根",
        created.status_code == 200
        and created.json()["node"]["path"] == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/树根目录",
        created.text[:200],
    )
    check(
        "磁盘上确实在资料库里, 项目根下没有多出目录",
        (root / MANAGED_RESOURCES_ROOT_RELATIVE / "树根目录").is_dir()
        and not (root / "树根目录").exists(),
        str(sorted(item.name for item in root.iterdir())),
    )

    escaped = client.post(
        "/api/resource/node",
        json={
            "project": project.id,
            "action": "create_folder",
            "parent": "resources/../outside",
            "name": "不能创建",
        },
    )
    check(
        "资料树路径不能借助父目录段逃出资料库根",
        escaped.status_code == 400 and not (root / "outside" / "不能创建").exists(),
        escaped.text[:200],
    )

    document = client.post(
        "/api/resource/node",
        json={
            "project": project.id,
            "action": "create_document",
            "parent": "",
            "name": "树根笔记",
        },
    )
    document_path = document.json()["node"]["path"]
    check(
        "树根新建文档落进资料库、自动补 .md 且正文为空",
        document_path == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/树根笔记.md"
        and (root / MANAGED_RESOURCES_ROOT_RELATIVE / "树根笔记.md").read_text(encoding="utf-8")
        == "",
        document.text[:200],
    )

    client.post(
        "/api/resource/write",
        json={"project": project.id, "path": document_path, "content": "钙钛矿 perovskite 记录"},
    )
    tree = client.get("/api/resource/tree", params={"project": project.id})
    paths = {node["path"] for node in tree.json()["nodes"]}
    check(
        "资料树以项目根为唯一相对基",
        {
            f"{MANAGED_RESOURCES_ROOT_RELATIVE}/树根目录",
            f"{MANAGED_RESOURCES_ROOT_RELATIVE}/树根笔记.md",
        }
        <= paths,
        str(paths),
    )

    hits = client.get("/api/resource/search", params={"project": project.id, "q": "perovskite"})
    hit_paths = {hit["path"] for hit in hits.json()["hits"]}
    check(
        "资料搜索只扫资料库根, 命中路径仍相对项目根",
        f"{MANAGED_RESOURCES_ROOT_RELATIVE}/树根笔记.md" in hit_paths,
        str(hit_paths),
    )
    root_name_hits = client.get(
        "/api/resource/search",
        params={"project": project.id, "q": MANAGED_RESOURCES_ROOT_RELATIVE},
    )
    check(
        "路径匹配以资料库内部为相对基, 不让根名命中所有文件",
        root_name_hits.status_code == 200 and root_name_hits.json()["hits"] == [],
        root_name_hits.text[:200],
    )
    (root / MANAGED_LITERATURE_ROOT_RELATIVE / "不该被资料搜索命中.md").write_text(
        "perovskite", encoding="utf-8"
    )
    hits = client.get("/api/resource/search", params={"project": project.id, "q": "perovskite"})
    check(
        "文献库里的文件不进资料搜索结果",
        all(MANAGED_LITERATURE_ROOT_RELATIVE not in hit["path"] for hit in hits.json()["hits"]),
        hits.text[:200],
    )


def test_literature_serialization_rejects_corruption() -> None:
    cases = (
        ("truncated", b'{"items": ['),
        ("wrong-root", b"[]"),
        ("wrong-items", b'{"items": {}}'),
        ("bad-item", b'{"items": [null]}'),
        ("bad-collections", b'{"collections": [42]}'),
        ("bad-notes", b'{"items": [{"id": "a", "notes": ["keep me"]}]}'),
        ("bad-marks", b'{"items": [{"id": "a", "marks": {"text": "keep me"}}]}'),
        ("bad-status", b'{"items": [{"id": "a", "fulltext": "unknown"}]}'),
        ("bad-timestamp", b'{"items": [{"id": "a", "added_at": "invalid"}]}'),
        ("empty-id", b'{"items": [{"id": ""}]}'),
        (
            "duplicate-id",
            b'{"items": [{"id": "a", "title": "first"}, {"id": "a", "title": "second"}]}',
        ),
        (
            "duplicate-note",
            b'{"items": [{"id": "a", "notes": [{"id": "n"}, {"id": "n"}]}]}',
        ),
        ("tags-text", b'{"items": [{"id": "a", "tags": "keep me"}]}'),
        ("year-object", b'{"items": [{"id": "a", "year": {"value": 2024}}]}'),
        ("mark-page", b'{"items": [{"id": "a", "marks": [{"id": "m", "page": "12"}]}]}'),
        ("unknown-field", b'{"items": [{"id": "a", "future_notes": "keep me"}]}'),
        ("not-text", b"\xff\xfe"),
    )
    for label, payload in cases:
        try:
            decode(payload.decode("utf-8"))
        except (LiteratureError, UnicodeDecodeError):
            rejected = True
        else:
            rejected = False
        check(f"坏序列化 {label} 被明确拒绝", rejected)


def main() -> int:
    print("MVP 0.2 workbench domains contract (resource / literature / search)")
    test_resource_writes_land_on_disk()
    test_managed_layout_tree_root_is_the_resources_library()
    test_resource_name_collision_never_overwrites()
    test_resource_path_escape_is_rejected()
    test_resource_delete_is_not_permanent()
    test_resource_import_modes()
    test_resource_tree_carries_authoritative_link_root_identity()
    test_resource_tree_scan_does_not_block_event_loop()
    test_resource_search_matches_name_and_content()
    test_resource_search_reads_current_plain_and_docx_bytes()
    test_resource_search_ranks_metadata_before_content_and_limit()
    test_resource_search_includes_authorized_directory_and_file()
    test_literature_import_parses_and_appends()
    test_literature_filter_sort_and_batch()
    test_global_search_spans_domains()
    test_foreign_project_paths_are_rejected()
    test_literature_collections_are_not_tags()
    test_literature_import_appends_without_touching_existing_rows()
    test_literature_collection_delete_keeps_items()
    test_metadata_patch_preserves_user_fields()
    test_collection_rename_preserves_hierarchy_and_rejects_collision()
    test_literature_bibtex_export_disambiguates_keys()
    test_literature_serialization_rejects_corruption()
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
