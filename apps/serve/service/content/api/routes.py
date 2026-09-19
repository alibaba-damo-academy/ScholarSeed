"""content 域 HTTP 路由 (开发 1 拥有)。

只暴露**项目身份**: 资料库/文献库/文档的读写路由分别属于各自的域, 它们经
`ContentPort` 拿路径, 不从这里过。

工作区根的读写在 chat 域的设置路由上 —— 那个域拥有产品设置文件, 而 content
不得 import 任何上层域 (§6.1); 取值由组合根读设置后注入本域。

新建项目只收显示名: 目录名与身份键都由 content 生成 (proposal 47 §5.2),
客户端不参与命名, 也不能提交绝对路径 —— 「任意本机目录即项目」正是本提案
要消掉的旧定义。
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from service.content.domain.model import ContentError
from service.identity.utils import (
    HOST_PROCESS_HEADER,
    HOST_PROCESS_KEY_ENV,
    require_host_process,
)
from service.platform.content import ExternalRootRef, FileEvent, ProjectRef

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


def _root_payload(ref: ExternalRootRef) -> dict[str, Any]:
    """ExternalRootRef → JSON。

    `source_path` 照实回报: 关联的价值就是让用户知道自己授权了机器上的哪个
    文件或目录, 藏起来只会让「我授权了什么」无法核对。它不参与业务寻址 ——
    寻址一律用 `mount_path`。
    """

    payload = asdict(ref)
    payload["kind"] = ref.kind.value
    return payload


async def _publish_writable_roots(
    request: Request, content: Any, project_id: str
) -> tuple[str, ...]:
    """把该项目最新的可写根集合推给活跃会话。

    Agent 面的生效时机是**下一个 turn**; 产品面与主进程 OS 动作是即时的
    (每次调用都回查 `external_roots` 当前有效行)。
    """

    sessions = getattr(request.app.state, "session_service", None)
    if sessions is None:
        return ()
    project = content.project(project_id)
    roots = tuple(Path(root) for root in content.writable_roots(project.id))
    return await sessions.publish_writable_roots(Path(project.root), roots)


async def _reconcile_linked_root(request: Request, ref: ExternalRootRef) -> None:
    """Refresh persisted version facts before the newly linked root is rendered.

    Re-authorizing a root can expose a previously versioned path whose latest
    observation says that the mount was absent.  The resource tree must not race
    that stale fact against the background watcher.  Only existing identities are
    read here; first-time files remain owned by bounded background discovery.
    """

    supervisor = getattr(request.app.state, "resource_version_supervisor", None)
    if supervisor is None:
        return
    await asyncio.to_thread(
        supervisor.reconcile_linked_root,
        ref.project_id,
        ref.mount_path,
    )
    supervisor.schedule_scan(ref.project_id)


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


async def _event_frames(stream: Any) -> Any:
    """把事件流打成 SSE 帧。

    必须是异步生成器: 同步阻塞迭代器会把事件循环堵住 (既有会话 SSE 端点的
    异步性同样在传给 StreamingResponse 的那个生成器里, 不在路由函数上)。
    """

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

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects")
    async def create_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """新建项目 (只填名字)。磁盘上同时出现资料库与文献库两处。"""

        try:
            project = _content(request).create_project(str(payload.get("name") or ""))
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return _project_payload(project)

    @app.post(f"{CONTENT_ROUTE_PREFIX}/projects/adopt")
    async def adopt_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """把一个已存在的本地目录登记成项目 (布局按 LEGACY)。

        这是唯一接受客户端绝对路径的项目端点, 因为「选一个已有文件夹」这件事
        本身就是给路径。登记之后身份仍是 ULID —— 路径只是位置, 不是身份。
        """

        try:
            project = _content(request).adopt_project(
                str(payload.get("path") or ""),
                str(payload.get("name") or ""),
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return _project_payload(project)

    @app.patch(f"{CONTENT_ROUTE_PREFIX}/projects")
    async def rename_project(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """改显示名。目录名不跟随改名, 已开会话与关联登记都不受影响。"""

        try:
            project = _content(request).rename_project(
                str(payload.get("id") or ""),
                str(payload.get("name") or ""),
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
    async def forget_project(  # type: ignore[unused-ignore]
        request: Request,
        project_id: str,
    ) -> dict[str, Any]:
        """把项目从书深移除。只摘登记, 磁盘上的资料一个字节都不动。"""

        try:
            _content(request).forget_project(project_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        return {"id": project_id, "removed": True, "files_kept": True}

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
    async def authorize_root(  # type: ignore[unused-ignore]
        request: Request,
        payload: dict[str, Any] = Body(...),
    ) -> dict[str, Any]:
        """授权一处项目外文件或目录, 登记成项目内虚拟挂载点。

        挂载点撞真实同名条目时回 `mount_conflict` 而不是静默避让: 遮蔽会让用户
        以为自己的真实资料消失了, 改名让用户自己决定。
        """

        content = _content(request)
        project_id = str(payload.get("project") or "")
        try:
            ref = content.authorize_root(
                project_id,
                str(payload.get("source") or ""),
                str(payload.get("mount") or ""),
            )
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        await _reconcile_linked_root(request, ref)
        agent_sessions = await _publish_writable_roots(request, content, project_id)
        payload_out = _root_payload(ref)
        # 回报哪些活跃会话拿到了新集合: 它们要到**下一个 turn** 才生效, UI 得能说实话。
        payload_out["agentSessionsUpdated"] = list(agent_sessions)
        return payload_out

    @app.delete(f"{CONTENT_ROUTE_PREFIX}/roots/{{root_id}}")
    async def revoke_root(  # type: ignore[unused-ignore]
        request: Request,
        root_id: str,
        project_id: str | None = Query(default=None, alias="project"),
    ) -> dict[str, Any]:
        """撤销授权 (软撤销, 行保留留痕)。

        生效语义 (§6.9): 产品 API 与主进程 OS 级动作即时失效; Agent 沙箱在
        **下一个 turn** 生效 —— 已下发给 vendor 的那个 turn 无法中途剥夺,
        能做到的上界是让用户勾「立即中断」。
        """

        content = _content(request)
        try:
            content.revoke_root(root_id)
        except ContentError as exc:
            raise HTTPException(status_code=INVALID_REQUEST_STATUS, detail=exc.code) from exc
        agent_sessions = await _publish_writable_roots(request, content, project_id or "")
        try:
            writable = content.writable_roots(project_id)
        except ContentError:
            writable = ()
        return {
            "root_id": root_id,
            "revoked": True,
            "writableRoots": list(writable),
            "agentSessionsUpdated": list(agent_sessions),
        }

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
            _event_frames(stream),
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
