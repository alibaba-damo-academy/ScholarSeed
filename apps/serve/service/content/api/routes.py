"""content 域 HTTP 路由 (开发 1 拥有)。

暴露项目身份和项目目录树的原生文件操作。资料库/文献库/文档的专属读写路由
仍属于各自的域, 它们经 `ContentPort` 拿路径。

工作区根的读写在 chat 域的设置路由上 —— 那个域拥有产品设置文件, 而 content
不得 import 任何上层域 (§6.1); 取值由组合根读设置后注入本域。

新建项目只收显示名: 目录名与身份键都由 content 生成 (proposal 47 §5.2),
客户端不参与命名, 也不能提交绝对路径 —— 「任意本机目录即项目」正是本提案
要消掉的旧定义。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from contextlib import aclosing
from dataclasses import asdict
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from service.content.domain.model import ContentError, visible
from service.content.service.operations import (
    AdoptProject,
    AuthorizeRoot,
    ContentOperations,
    CreateProject,
    ForgetProject,
    RevokeRoot,
)
from service.identity.utils import (
    require_host_process,
)
from service.platform.content import (
    AssetKind,
    ExternalRootRef,
    FileEvent,
    ImportMode,
    ProjectRef,
    RootKind,
)
from service.platform.passive_events import passive_events

CONTENT_ROUTE_PREFIX = "/api/content"

#: 请求不合法统一用该状态码, 与其他域一致。
INVALID_REQUEST_STATUS = 400


def _content(request: Request) -> Any:
    content = getattr(request.app.state, "content", None)
    if content is None:
        raise HTTPException(status_code=503, detail="content_unavailable")
    return content


def _project_payload(project: ProjectRef) -> dict[str, Any]:
    """ProjectRef → JSON。layout 取 value, 前端按码分支不按文案。"""

    payload = asdict(project)
    payload["layout"] = project.layout.value
    return payload


def _tree_path(path: str, *, allow_root: bool = False) -> str:
    if not path and allow_root:
        return path
    if not path or any(not visible(part) for part in path.split("/")):
        raise ContentError("project_tree_path_unavailable")
    return path


def _root_payload(ref: ExternalRootRef) -> dict[str, Any]:
    """ExternalRootRef → JSON。

    `source_path` 照实回报: 关联的价值就是让用户知道自己授权了机器上的哪个
    文件或目录, 藏起来只会让「我授权了什么」无法核对。它不参与业务寻址 ——
    寻址一律用 `mount_path`。
    """

    payload = asdict(ref)
    payload["kind"] = ref.kind.value
    return payload


#: SSE 帧前缀与分隔 (与既有会话事件流一致)。
SSE_DATA_PREFIX = "data: "
SSE_FRAME_SUFFIX = "\n\n"


def _event_payload(event: FileEvent) -> dict[str, Any]:
    """FileEvent → JSON。Enum 取 value, 前端按码分支不按文案。"""

    return {
        "epoch": event.epoch,
        "seq": event.seq,
        "project_id": event.project_id,
        "root": event.root.value,
        "kind": event.kind.value,
        "path": event.path,
        "source": event.source.value,
        "previous_path": event.previous_path,
    }


async def _event_frames(stream: Any) -> AsyncGenerator[str, None]:
    """把事件流打成 SSE 帧。

    必须是异步生成器: 同步阻塞迭代器会把事件循环堵住 (既有会话 SSE 端点的
    异步性同样在传给 StreamingResponse 的那个生成器里, 不在路由函数上)。
    """

    async with aclosing(stream):
        async for event in stream:
            yield f"{SSE_DATA_PREFIX}{json.dumps(_event_payload(event), ensure_ascii=False)}{SSE_FRAME_SUFFIX}"


def register_content_routes(app: FastAPI) -> None:
    """把项目身份与工作区根路由挂到应用上。"""

    @app.get(f"{CONTENT_ROUTE_PREFIX}/projects")
    async def list_projects(  # type: ignore[unused-ignore]
        request: Request,
        include_archived: bool = Query(default=False, alias="includeArchived"),
    ) -> dict[str, Any]:
        """项目列表 + 当前项目 id。

        默认只回未归档项目: 归档的产品语义就是「从各处的默认列表里收起来」,
        在服务端过滤才能让所有既有列表表面一致生效。`includeArchived=true`
        回全量, 供归档视图列出与恢复。过滤放在路由层: 服务内部的 GC、观察、
        投递这些消费方仍需要看到全部项目。

        顺序同理放在这里: 新建的项目排在最前 (创建时间倒序), 各处列表表面
        才不必各自排一遍。创建时间相同时按 id 定序, 避免同秒建的两个项目
        每次刷新换位置。

        当前项目解析失败 (工作区根不可用) 时仍回列表: 让界面能进「选项目」,
        而不是整页报错。
        """

        content = _content(request)
        try:
            current = content.project().id
        except ContentError:
            current = ""
        refs = content.projects()
        if not include_archived:
            refs = tuple(entry for entry in refs if entry.archived_at is None)
        refs = tuple(
            sorted(refs, key=lambda entry: (entry.created_at or 0.0, entry.id), reverse=True)
        )
        return {
            "projects": [_project_payload(entry) for entry in refs],
            "current": current,
            "workspaceRoot": str(getattr(request.app.state, "workspace", "")),
        }

    @app.get(f"{CONTENT_ROUTE_PREFIX}/projects/recoveries")
    async def project_recoveries(request: Request) -> JSONResponse:
        operations: ContentOperations = request.app.state.content_operations
        rows = operations.creation_recoveries(str(getattr(request.state, "user_id", "local")))
        return JSONResponse({"creations": rows}, headers={"Cache-Control": "no-store"})

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/recoveries/{{identity}}/retry")
    async def retry_project_creation(request: Request, identity: str) -> JSONResponse:
        operations: ContentOperations = request.app.state.content_operations
        try:
            operations.retry_creation(str(getattr(request.state, "user_id", "local")), identity)
        except ContentError as error:
            raise HTTPException(status_code=404, detail=error.code) from error
        return JSONResponse(
            {"operation": identity, "state": "running"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/recoveries/{{identity}}/preserve")
    async def preserve_project_creation(request: Request, identity: str) -> JSONResponse:
        operations: ContentOperations = request.app.state.content_operations
        try:
            operations.preserve_creation(str(getattr(request.state, "user_id", "local")), identity)
        except ContentError as error:
            raise HTTPException(status_code=404, detail=error.code) from error
        return JSONResponse(
            {"operation": identity, "files_kept": True}, headers={"Cache-Control": "no-store"}
        )

    @app.get(f"{CONTENT_ROUTE_PREFIX}/projects/directory")
    async def project_directory(request: Request, name: str = Query(default="")) -> dict[str, str]:
        return {"root": _content(request).preview_project_directory(name)}

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects")
    async def create_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> JSONResponse:
        """Create only after directory preparation and initialization finish."""
        operations: ContentOperations = request.app.state.content_operations
        identity = operations.submit(
            str(getattr(request.state, "user_id", "local")),
            CreateProject(str(payload.get("name") or "")),
        )
        return JSONResponse(
            {"operation": identity, "state": "queued"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/adopt")
    async def adopt_project(request: Request, payload: dict[str, Any] = Body(...)) -> JSONResponse:
        if not isinstance(payload.get("path"), str) or not payload["path"].strip():
            raise HTTPException(status_code=400, detail="project_directory_not_found")
        operations: ContentOperations = request.app.state.content_operations
        identity = operations.submit(
            str(getattr(request.state, "user_id", "local")),
            AdoptProject(str(payload.get("path") or ""), str(payload.get("name") or "")),
        )
        return JSONResponse(
            {"operation": identity, "state": "queued"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.get(f"{CONTENT_ROUTE_PREFIX}/operations/{{identity}}")
    async def operation_result(request: Request, identity: str) -> JSONResponse:
        operations: ContentOperations = request.app.state.content_operations
        try:
            result = operations.result(str(getattr(request.state, "user_id", "local")), identity)
        except ContentError as error:
            raise HTTPException(status_code=404, detail=error.code) from error
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.patch(f"{CONTENT_ROUTE_PREFIX}/projects")
    async def rename_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """改显示名。目录名不跟随改名, 已开会话与关联登记都不受影响。"""

        try:
            description = payload.get("description")
            pinned = payload.get("pinned")
            if description is not None and not isinstance(description, str):
                raise ContentError("invalid_description")
            if pinned is not None and not isinstance(pinned, bool):
                raise ContentError("invalid_pinned")
            project = _content(request).rename_project(
                str(payload.get("id") or ""),
                str(payload.get("name") or ""),
                description=description,
                pinned=pinned,
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return _project_payload(project)

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/{{project_id}}/archive")
    async def set_project_archived(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """归档/解归档项目。只影响默认列表可见性, 目录与会话数据一个字节都不动。"""

        try:
            project = _content(request).set_project_archived(
                project_id, bool(payload.get("archived"))
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return _project_payload(project)

    @app.delete(f"{CONTENT_ROUTE_PREFIX}/projects/{{project_id}}")
    async def forget_project(request: Request, project_id: str) -> JSONResponse:
        """Retire registration only after all project execution has drained."""
        operations: ContentOperations = request.app.state.content_operations
        identity = operations.submit(
            str(getattr(request.state, "user_id", "local")), ForgetProject(project_id)
        )
        return JSONResponse(
            {"operation": identity, "state": "queued"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.get(f"{CONTENT_ROUTE_PREFIX}/project")
    async def project(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> dict[str, Any]:
        """单个项目引用。不传 id 取当前项目。"""

        try:
            return _project_payload(_content(request).project(project_id))
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc

    @app.get(f"{CONTENT_ROUTE_PREFIX}/roots")
    async def external_roots(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> dict[str, Any]:
        """该项目当前有效的关联根 + 可写根集合。

        `writableRoots` 与主进程授权白名单、Agent 沙箱的 `writableRoots` 是
        **同一个**来源 (§6.9): 两套来源必然漂移成一处能写一处不能写。
        """

        content = _content(request)
        try:
            roots = content.external_roots(project_id)
            writable = content.writable_roots(project_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {
            "roots": [_root_payload(entry) for entry in roots],
            "writableRoots": list(writable),
        }

    @app.post(f"{CONTENT_ROUTE_PREFIX}/roots")
    async def authorize_root(request: Request, payload: dict[str, Any] = Body(...)) -> JSONResponse:
        """Qualify the source before publishing a new external-root authorization."""
        operations: ContentOperations = request.app.state.content_operations
        identity = operations.submit(
            str(getattr(request.state, "user_id", "local")),
            AuthorizeRoot(
                str(payload.get("project") or ""),
                str(payload.get("source") or ""),
                str(payload.get("mount") or ""),
                bool(payload.get("supersede") or False),
            ),
        )
        return JSONResponse(
            {"operation": identity, "state": "queued"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.delete(f"{CONTENT_ROUTE_PREFIX}/roots/{{root_id}}")
    async def revoke_root(
        request: Request,
        root_id: str,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> JSONResponse:
        """Drain owners before revoking and releasing the external directory."""
        operations: ContentOperations = request.app.state.content_operations
        identity = operations.submit(
            str(getattr(request.state, "user_id", "local")),
            RevokeRoot(root_id, project_id),
        )
        return JSONResponse(
            {"operation": identity, "state": "queued"},
            status_code=202,
            headers={"Cache-Control": "no-store"},
        )

    @app.get(f"{CONTENT_ROUTE_PREFIX}/cursor")
    async def event_cursor(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> dict[str, Any]:
        """当前事件游标。客户端据此发起续传。"""

        content = _content(request)
        try:
            epoch, last_seq = content.event_cursor(project_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"epoch": epoch, "last_seq": last_seq}

    @app.get(f"{CONTENT_ROUTE_PREFIX}/events")
    def content_events(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
        epoch: str = Query(default=""),
        from_seq: int = Query(default=0, ge=0),
    ) -> StreamingResponse:
        """文件事件 SSE。

        带上次的 `epoch` 与 `from_seq` 续传; epoch 不匹配 (serve 重启过) 时第一条
        一定是 RESCAN —— 从一个不可比的 seq 往后读是静默错位, 比丢事件更糟。
        """

        content = _content(request)
        try:
            stream = content.subscribe(project_id or "", epoch, from_seq)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return StreamingResponse(
            passive_events(_event_frames(stream), request.app.state.activities),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post(f"{CONTENT_ROUTE_PREFIX}/trash-token")
    async def issue_trash_token(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """签发一次性删除令牌 (§6.6)。渲染层只拿到令牌, 拿不到绝对路径。"""

        content = _content(request)
        try:
            issued = content.issue_trash_token(
                str(payload.get("project") or ""),
                str(payload.get("path") or ""),
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"token": issued}

    @app.post(f"{CONTENT_ROUTE_PREFIX}/trash-token/redeem")
    async def redeem_trash_token(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """兑换令牌 → 待删绝对路径。仅限 Electron 主进程。

        主进程密钥缺失时直接拒: 「没配密钥就放行」等于把这道闸留成装饰。
        """

        require_host_process(request)
        content = _content(request)
        try:
            absolute = content.redeem_trash_token(str(payload.get("token") or ""))
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"absolute": absolute}

    @app.post(f"{CONTENT_ROUTE_PREFIX}/trash-token/complete")
    async def complete_trash_token(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """Accept the host's success receipt after `shell.trashItem` completes."""

        require_host_process(request)
        try:
            path = _content(request).complete_trash_token(str(payload.get("token") or ""))
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"path": path}

    @app.get(f"{CONTENT_ROUTE_PREFIX}/migration")
    async def migration_plan(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> dict[str, Any]:
        """迁移 dry-run。列出会搬什么、多大、有没有冲突, 不动任何文件。"""

        content = _content(request)
        try:
            plan = content.migration_plan(project_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {
            "project_id": plan.project_id,
            "name": plan.display_name,
            "root": plan.root,
            "blocked": plan.blocked,
            "totalSize": plan.total_size,
            "entries": [asdict(entry) for entry in plan.entries],
        }

    @app.post(f"{CONTENT_ROUTE_PREFIX}/migration")
    async def migrate_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """执行迁移。`skip` 里的条目保持原位 (用户选了「暂不迁移」)。

        逐项移动 + 逐项校验 + 单项失败只回滚该项: 文件系统给不了事务, 整体回滚
        在大目录上本身就是第二次危险操作。失败项逐条回报, 不汇总成一句「部分失败」。
        """

        content = _content(request)
        raw_skip = payload.get("skip") or ()
        skip = tuple(str(item) for item in raw_skip) if isinstance(raw_skip, (list, tuple)) else ()
        try:
            outcome = content.migrate_project(str(payload.get("project") or ""), skip)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {
            "project_id": outcome.project_id,
            "moved": list(outcome.moved),
            "moves": [asdict(move) for move in outcome.moves],
            "failed": [{"source": source, "reason": reason} for source, reason in outcome.failed],
            "layout": outcome.layout.value,
        }

    @app.get(f"{CONTENT_ROUTE_PREFIX}/projects/{{project_id}}/tree")
    def project_tree(
        request: Request,
        project_id: str,
        path: str = Query(default=""),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        content = _content(request)
        try:
            project = content.project(project_id)
            page = content.project_tree(project.id, path, offset)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {
            "root": project.root,
            "path": path,
            "total": page.total,
            "offset": page.offset,
            "nodes": [
                {
                    "path": node.asset.path,
                    "name": node.asset.name,
                    "kind": node.asset.kind.value,
                    "available": node.available,
                    "count": node.child_total,
                    "artifact": node.asset.kind is AssetKind.FILE
                    and node.asset.path.startswith(
                        f"{content.root_relative(project.id, RootKind.ARTIFACTS)}/"
                    ),
                }
                for node in page.children
            ],
        }

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/{{project_id}}/nodes")
    async def project_node(
        request: Request, project_id: str, payload: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        content = _content(request)
        action = str(payload.get("action") or "")
        path = str(payload.get("path") or "")
        parent = str(payload.get("parent") or "")
        name = str(payload.get("name") or "")
        target_dir = str(payload.get("target_dir") or "")
        try:
            if action in {"create_document", "create_folder"}:
                _tree_path(parent, allow_root=True)
                if not visible(name):
                    raise ContentError("project_tree_path_unavailable")
                kind = AssetKind.FILE if action == "create_document" else AssetKind.DIR
                asset = await asyncio.to_thread(content.create, project_id, parent, name, kind)
            elif action == "rename":
                _tree_path(path)
                if not visible(name):
                    raise ContentError("project_tree_path_unavailable")
                asset = await asyncio.to_thread(content.rename, project_id, path, name)
            elif action == "move":
                _tree_path(path)
                _tree_path(target_dir, allow_root=True)
                asset = await asyncio.to_thread(
                    content.move, project_id, path, target_dir, exact=True
                )
            elif action == "copy":
                _tree_path(path)
                _tree_path(target_dir, allow_root=True)
                asset = await asyncio.to_thread(content.copy, project_id, path, target_dir)
            else:
                raise ContentError("bad_action")
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"path": asset.path, "name": asset.name, "kind": asset.kind.value}

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/{{project_id}}/import")
    async def project_import(
        request: Request, project_id: str, payload: dict[str, Any] = Body(...)
    ) -> dict[str, Any]:
        content = _content(request)
        target_dir = str(payload.get("target_dir") or "")
        sources = payload.get("sources")
        if (
            not isinstance(sources, list)
            or not sources
            or not all(isinstance(item, str) for item in sources)
        ):
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail="invalid_sources")
        try:
            _tree_path(target_dir, allow_root=True)
            imported = await asyncio.to_thread(
                content.import_sources, project_id, tuple(sources), target_dir, ImportMode.COPY
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"paths": [item.path for item in imported]}

    @app.get(f"{CONTENT_ROUTE_PREFIX}/trash")
    async def trashed_history(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str | None = Query(default=None, alias="project"),
        limit: int = Query(default=50, ge=1, le=200),
    ) -> dict[str, Any]:
        """最近被移入废纸篓的资料 (来自审计)。

        为什么只回「原位置」而不提供一键回迁: 系统废纸篓不告诉调用方文件被放到
        了哪里, 没有这个信息的「恢复」只能是假的。这里给用户真实可用的东西 ——
        原位置 + 时间, 配合系统废纸篓自己的「放回原处」完成恢复。
        """

        content = _content(request)
        try:
            project = content.project(project_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        entries = [
            {"at": float(row["at"]), "path": str(row["detail"])}
            for row in content.trash_history(project.id, limit)
        ]
        return {"project_id": project.id, "entries": entries}


__all__ = ["CONTENT_ROUTE_PREFIX", "register_content_routes"]
