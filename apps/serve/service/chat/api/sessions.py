"""HTTP routes for the Codex-backed product session API."""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any, BinaryIO, Iterator, Mapping

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask
from starlette.datastructures import UploadFile
from starlette.status import HTTP_404_NOT_FOUND, HTTP_422_UNPROCESSABLE_CONTENT

from scholarseed_runtime.contract.input import InputKind
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONTEXT_REQUIRED,
)
from service.chat.constants import (
    RUNTIME_CAPABILITY_UNAVAILABLE,
    SESSION_ARCHIVED_ERROR,
    SESSION_LIST_PROJECT_REQUIRED_ERROR,
    SESSION_LIST_PROJECT_UNEXPECTED_ERROR,
    SESSION_NOT_FOUND_CODE,
    SESSION_NOT_FOUND_ERROR,
)
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionListScope,
    SessionPrincipal,
)
from service.chat.runtime.reconfiguration import (
    PREPARATION_INVALID,
    RECONFIGURATION_NOT_FOUND,
    PreparationError,
)
from service.chat.schema import (
    RuntimePreparationRequest,
    SessionArchiveRequest,
    SessionModelRequest,
    SessionPinRequest,
    SessionRenameRequest,
    thinking_from_payload,
)
from service.chat.service.artifacts import (
    ARTIFACT_EDIT_UNAVAILABLE,
    ARTIFACT_INTEGRITY_MISMATCH,
    ARTIFACT_NOT_FOUND,
    ARTIFACT_PATH_FORBIDDEN,
    ARTIFACT_REVISION_CONFLICT,
    ARTIFACT_TOO_LARGE,
    ArtifactDocument,
    ArtifactReadError,
    ArtifactService,
)
from service.chat.service.events import EventService
from service.chat.service.sessions import (
    MCP_DIRECT_APPROVAL_REQUIRED,
    SESSION_LIST_MAX_LIMIT,
    SESSION_PERMISSION_CONTINUATION_TEXT,
    PermissionApplication,
    SessionService,
)
from service.chat.service.turns import TurnService
from service.chat.utils import SESSION_LIST_CURSOR_INVALID, parse_session_list_cursor
from service.identity.service.skill_credentials import SkillCredentialService
from service.identity.utils import (
    bearer_or_cookie,
    request_owner_id,
    request_user_id,
    require_host_process,
)
from service.platform.activity import ActivityDomain
from service.platform.limits import ATTACHMENT_MAX_BYTES, UPLOAD_CHUNK_BYTES
from service.platform.passive_events import passive_events

HTTP_OK = 200
HTTP_CONFLICT = 409
HTTP_BAD_REQUEST = 400
HTTP_BAD_GATEWAY = 502
HTTP_FORBIDDEN = 403
HTTP_PAYLOAD_TOO_LARGE = 413
HTTP_PRECONDITION_FAILED = 412
HTTP_PRECONDITION_REQUIRED = 428
HTTP_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
ARTIFACT_EDITABLE_HEADER = "X-ScholarSeed-Artifact-Editable"
MCP_CONTROL_FAILED = "mcp_control_failed"
CONTINUATION_CACHE_HEADERS = {"Cache-Control": "no-store"}
PERMISSION_CONTINUATION_CONTEXT_FIELDS = (
    "client_user_message_id",
    "assistant_context_revision",
    "active_document",
    "selected_literature_ids",
    "task_type",
)


def _document_chunks(stream: BinaryIO) -> Iterator[bytes]:
    with stream:
        while chunk := stream.read(UPLOAD_CHUNK_BYTES):
            yield chunk


def _artifact_response(document: ArtifactDocument, *, head: bool = False) -> Response:
    headers = {
        ARTIFACT_EDITABLE_HEADER: str(document.editable).lower(),
        "ETag": f'"{document.revision}"',
        "Content-Length": str(document.size),
    }
    if isinstance(document.body, bytes):
        return Response(
            content=b"" if head else document.body,
            media_type=document.media_type,
            headers=headers,
        )
    if head:
        document.body.close()
        return Response(media_type=document.media_type, headers=headers)
    return StreamingResponse(
        _document_chunks(document.body),
        media_type=document.media_type,
        headers=headers,
        background=BackgroundTask(document.body.close),
    )


def _mcp_failure(error: Exception) -> JSONResponse:
    return JSONResponse(
        {
            "ok": False,
            "error": MCP_CONTROL_FAILED,
            "failure_type": type(error).__name__,
        },
        status_code=HTTP_BAD_GATEWAY,
    )


async def _json(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 - malformed HTTP input is an empty object
        return {}
    return dict(payload) if isinstance(payload, Mapping) else {}


def _result(payload: dict[str, Any], status: int) -> dict[str, Any] | JSONResponse:
    return payload if status == HTTP_OK else JSONResponse(payload, status_code=status)


def mount_session_routes(
    app: FastAPI,
    *,
    sessions: SessionService,
    turns: TurnService,
    events: EventService,
    artifacts: ArtifactService,
    credentials: SkillCredentialService,
) -> None:
    """Mount stable product routes without exposing native-harness controls."""

    @app.exception_handler(SessionAccessError)
    async def session_access_error(_request: Request, _error: SessionAccessError) -> JSONResponse:
        return JSONResponse(
            {"detail": SESSION_NOT_FOUND_ERROR, "code": SESSION_NOT_FOUND_CODE},
            status_code=HTTP_404_NOT_FOUND,
        )

    def principal(user_id: str) -> SessionPrincipal:
        return SessionPrincipal(user_id=user_id)

    def request_principal(request: Request) -> SessionPrincipal:
        return principal(request_owner_id(request))

    def require_session_access(session_id: str, request: Request) -> None:
        sessions.require_access(session_id, request_principal(request))

    async def align_session_metering_identity(session_id: str, request: Request) -> None:
        if request.method in HTTP_SAFE_METHODS:
            return
        deleting_session = (
            request.method == "DELETE"
            and request.scope["route"].path == "/api/serve/sessions/{session_id}"
        )
        if not deleting_session and sessions.is_readonly(session_id):
            raise HTTPException(HTTP_CONFLICT, SESSION_ARCHIVED_ERROR)
        actor_id = str(getattr(request.state, "user_id", "") or "").strip()
        if actor_id:
            try:
                await sessions.align_metering_identity(session_id, actor_id)
            except (RuntimeError, ValueError) as error:
                reason = str(getattr(error, "safe_error", "") or error)
                if reason == RESOURCE_HOST_CONFIGURATION_CONFLICT:
                    raise HTTPException(HTTP_CONFLICT, reason) from None
                raise HTTPException(503, RESOURCE_HOST_CONTEXT_REQUIRED) from None

    session_guard = [
        Depends(require_session_access),
        Depends(align_session_metering_identity),
    ]

    @app.exception_handler(PreparationError)
    async def preparation_error(_request: Request, error: PreparationError) -> JSONResponse:
        return JSONResponse(
            {"ok": False, "error": str(error), "preparation_error": True},
            status_code=HTTP_CONFLICT,
        )

    @app.post("/api/serve/runtime/prepare")
    async def prepare_runtime(body: RuntimePreparationRequest, request: Request) -> Any:
        try:
            return sessions.prepare_model(
                body.model_id,
                actor_id=request_user_id(request),
                request_id=body.request_id,
                service_instance_id=body.service_instance_id,
                persist_default=body.persist_default,
            )
        except (ValueError, RuntimeError) as error:
            return JSONResponse({"ok": False, "error": str(error)}, status_code=HTTP_CONFLICT)

    @app.get("/api/serve/runtime/prepare/{request_id}")
    def runtime_preparation_status(request_id: str, request: Request) -> Any:
        try:
            return sessions.preparation_status(request_id, actor_id=request_user_id(request))
        except ValueError:
            return JSONResponse(
                {"ok": False, "error": RECONFIGURATION_NOT_FOUND}, status_code=HTTP_404_NOT_FOUND
            )

    @app.get(
        "/api/serve/sessions/{session_id}/navigation",
        dependencies=[Depends(require_session_access)],
    )
    def navigation(session_id: str, request: Request) -> Any:
        # The service enforces ownership; restoring navigation must not realign
        # credentials, activate the runtime, or repair persisted session state.
        payload, status = sessions.navigation(session_id, request_principal(request))
        return _result(payload, status)

    async def open_live_session(body: Mapping[str, Any], principal_id: str) -> dict[str, Any]:
        payload, _status = await sessions.open(
            body,
            principal(principal_id),
            actor_id=principal_id,
        )
        return payload

    async def list_recoverable_sessions(*, principal_id: str) -> list[dict[str, Any]]:
        return await sessions.recoverable(principal(principal_id))

    async def rename_owned_session(
        *, session_id: str, principal_id: str, title: str
    ) -> tuple[dict[str, Any], int]:
        return await sessions.rename(session_id, title, principal(principal_id))

    async def delete_owned_session(
        *, session_id: str, principal_id: str
    ) -> tuple[dict[str, Any], int]:
        return await sessions.delete(session_id, principal(principal_id), actor_id=principal_id)

    async def update_live_session_skills(
        session_id: str,
        load: list[str],
        unload: list[str],
        principal_id: str,
    ) -> dict[str, Any]:
        sessions.require_access(session_id, principal(principal_id))
        return await sessions.update_skills(session_id, load=load, unload=unload)

    def is_live_session_running(session_id: str, principal_id: str) -> bool:
        return sessions.is_running(session_id, principal(principal_id))

    def require_owned_session_access(session_id: str, principal_id: str) -> None:
        sessions.require_access(session_id, principal(principal_id))

    def inspect_live_session_context(session_id: str, principal_id: str) -> dict[str, Any]:
        return sessions.inspect_context(session_id, principal(principal_id))

    async def apply_live_session_context_operation(
        session_id: str,
        operation: Mapping[str, Any],
        principal_id: str,
    ) -> dict[str, Any]:
        return await sessions.apply_context_operation(
            session_id,
            operation,
            principal(principal_id),
        )

    app.state.open_live_session = open_live_session
    app.state.list_recoverable_sessions = list_recoverable_sessions
    app.state.rename_owned_session = rename_owned_session
    app.state.delete_owned_session = delete_owned_session
    app.state.update_live_session_skills = update_live_session_skills
    app.state.is_live_session_running = is_live_session_running
    app.state.require_owned_session_access = require_owned_session_access
    app.state.inspect_live_session_context = inspect_live_session_context
    app.state.apply_live_session_context_operation = apply_live_session_context_operation

    @app.get("/api/serve/sessions")
    async def list_sessions(
        request: Request,
        limit: int = 60,
        scope: SessionListScope = SessionListScope.ALL,
        project_path: str | None = None,
        query: str | None = None,
        cursor: str = "",
        archived: bool = False,
        include_last_agent_reply: bool = False,
    ) -> dict[str, Any]:
        if scope is SessionListScope.PROJECT and not str(project_path or "").strip():
            raise HTTPException(422, SESSION_LIST_PROJECT_REQUIRED_ERROR)
        if scope is not SessionListScope.PROJECT and project_path is not None:
            raise HTTPException(422, SESSION_LIST_PROJECT_UNEXPECTED_ERROR)
        try:
            parse_session_list_cursor(cursor)
        except ValueError as error:
            raise HTTPException(
                HTTP_422_UNPROCESSABLE_CONTENT, SESSION_LIST_CURSOR_INVALID
            ) from error
        return await sessions.list(
            limit,
            request_principal(request),
            scope=scope,
            project_path=project_path,
            query=query,
            history=events.portable_history,
            cursor=cursor,
            archived=archived,
            include_last_agent_reply=include_last_agent_reply,
        )

    @app.get("/api/serve/interactions/pending")
    def pending_interactions(request: Request) -> dict[str, Any]:
        return sessions.pending_interactions(request_principal(request))

    @app.post("/api/serve/sessions/open")
    async def open_session(request: Request) -> Any:
        # 会话进程的 env 只能在这里解析: 用户 JWT 只存在于本次请求 (middleware 验签后即
        # 丢弃), 而 App Server / skill 要的那把 API Key 得拿它去账号服务换。默认 Codex
        # 拿不到仍可按订阅登录运行; 需要该 key 的自定义 Codex 会由 launch contract fail closed。
        owner = request_principal(request)
        actor_id = request_user_id(request)
        skill_environment = await credentials.environment(
            actor_id,
            bearer_or_cookie(request),
        )
        body = await _json(request)
        prepare = body.pop("prepare_runtime", False)
        instance_id = body.pop("service_instance_id", "")
        if not isinstance(prepare, bool) or (
            prepare
            and (
                not isinstance(body.get("model_id"), str)
                or not body["model_id"]
                or not isinstance(instance_id, str)
                or not instance_id
                or body.get("resume_session_id")
            )
        ):
            return JSONResponse(
                {"ok": False, "error": PREPARATION_INVALID}, status_code=HTTP_BAD_REQUEST
            )
        admission = (
            sessions.model_admission(
                body["model_id"],
                actor_id=actor_id,
                domain=ActivityDomain.RUNTIME,
                service_instance_id=instance_id,
            )
            if prepare
            else nullcontext()
        )
        async with admission:
            payload, status = await sessions.open(
                body,
                owner,
                actor_id=actor_id,
                skill_environment=skill_environment,
            )
        return _result(payload, status)

    @app.get(
        "/api/serve/sessions/{session_id}/continuation",
        dependencies=[Depends(require_session_access)],
    )
    async def session_continuation(
        session_id: str, request: Request, turn_id: str = Query(default="")
    ) -> Any:
        payload, status = await sessions.continuation(
            session_id, request_principal(request), turn_id=turn_id
        )
        return JSONResponse(payload, status_code=status, headers=CONTINUATION_CACHE_HEADERS)

    @app.get("/api/serve/sessions/{session_id}/events", dependencies=session_guard)
    def session_events(session_id: str, request: Request, from_seq: int = 0) -> StreamingResponse:
        return StreamingResponse(
            passive_events(events.open(session_id, from_seq), request.app.state.activities),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/serve/sessions/{session_id}/interrupt", dependencies=session_guard)
    async def interrupt_session(session_id: str) -> dict[str, Any]:
        return await sessions.interrupt(session_id)

    @app.post("/api/serve/sessions/{session_id}/terminate", dependencies=session_guard)
    async def terminate_session(session_id: str) -> Any:
        payload, status = await sessions.terminate(session_id)
        return _result(payload, status)

    @app.post(
        "/api/serve/sessions/{session_id}/turns", dependencies=[Depends(require_session_access)]
    )
    async def post_turn(session_id: str, request: Request) -> Any:
        # 凭据检查归 prepare_turn 的实际执行准入；排队消息出队时也必须重新检查。
        body = await _json(request)
        model_id = body.pop("expected_model_id", None)
        instance_id = body.pop("service_instance_id", None)
        if (model_id is not None and (not isinstance(model_id, str) or not model_id)) or (
            instance_id is not None and (not isinstance(instance_id, str) or not instance_id)
        ):
            raise PreparationError(PREPARATION_INVALID)
        model_id = model_id or sessions.model(session_id)["model_id"]
        async with sessions.turn_admission(
            session_id,
            request_principal(request),
            actor_id=request_user_id(request),
            model_id=model_id,
            service_instance_id=instance_id,
        ):
            payload, status = await turns.post(
                session_id,
                body,
                side=False,
                expected_model_id=model_id,
                prepared_activity=True,
            )
        return _result(payload, status)

    # 登录成功后、以及打开账号设置页时由客户端各调一次: 确保这把凭据已经存在, 好让设置页
    # 立刻看得到它 —— 否则它要等到用户第一次开会话才被签发, 在设置页里表现成「怎么没有」。
    #
    # 与 /refresh 的区别是**只补不换**: 已有就原样沿用, 连校验都不打 (理由见
    # SkillCredentialService.ensure)。登录若强制重签, 会把这台机器上正在跑的会话手里那把
    # 当场作废, 白白触发一轮迁移。字段叫 ready 而不是 issued: 沿用那把也算齐备, 说成
    # 「签发了」会让读日志的人以为每次登录都换了一把。
    @app.post("/api/serve/skill-credential")
    async def ensure_skill_credential(request: Request) -> dict[str, Any]:
        environment = await credentials.ensure(request_user_id(request), bearer_or_cookie(request))
        return {"ok": True, "ready": bool(environment)}

    # 用户在账号页点完轮换后由客户端通知过来: 强制重签一把, 并把他名下空闲会话当场对齐。
    # 不通知的话缓存里仍是那把已死的 key, 与会话 env 相等, turn 前的比较发现不了差异。
    @app.post("/api/serve/skill-credential/refresh")
    async def refresh_skill_credential(request: Request) -> dict[str, Any]:
        environment = await credentials.refresh(request_user_id(request), bearer_or_cookie(request))
        return {
            "ok": True,
            "issued": bool(environment),
            "aligned": await sessions.align_owned_skill_environments(request_principal(request)),
        }

    @app.post("/api/serve/sessions/{session_id}/attachments", dependencies=session_guard)
    async def upload_attachment(session_id: str, request: Request) -> Any:
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile) or not upload.filename:
            return JSONResponse({"ok": False, "error": "file_required"}, status_code=400)
        content = bytearray()
        while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
            content.extend(chunk)
            if len(content) > ATTACHMENT_MAX_BYTES:
                return JSONResponse(
                    {"ok": False, "error": "attachment_too_large"},
                    status_code=413,
                )
        try:
            result = sessions.save_attachment(
                session_id,
                filename=upload.filename,
                content=bytes(content),
                media_type=upload.content_type or "",
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)
        return {"ok": True, **result}

    @app.post("/api/serve/sessions/{session_id}/file-references", dependencies=session_guard)
    async def register_local_references(session_id: str, request: Request) -> Any:
        body = await _json(request)
        raw_paths = body.get("paths")
        if not isinstance(raw_paths, list) or not all(isinstance(path, str) for path in raw_paths):
            return JSONResponse(
                {"ok": False, "error": "local_file_paths_required"},
                status_code=HTTP_BAD_REQUEST,
            )
        try:
            references = sessions.register_local_paths(session_id, tuple(raw_paths))
        except ValueError as exc:
            return JSONResponse(
                {"ok": False, "error": str(exc)},
                status_code=HTTP_BAD_REQUEST,
            )
        return {"ok": True, "references": references}

    @app.get("/api/serve/sessions/{session_id}/files", dependencies=session_guard)
    def session_files(
        session_id: str,
        path: str = Query(default=""),
        offset: int = Query(default=0, ge=0),
        outputs_only: bool = False,
    ) -> dict[str, Any]:
        return sessions.files(session_id, path, offset, outputs_only=outputs_only)

    @app.get("/api/serve/sessions/{session_id}/files/content", dependencies=session_guard)
    def session_file_content(session_id: str, path: str = Query(...)) -> dict[str, Any]:
        return sessions.file_content(session_id, path)

    @app.get("/api/serve/sessions/{session_id}/files/raw", dependencies=session_guard)
    def session_file_raw(session_id: str, path: str = Query(...)) -> Response:
        content, media_type = sessions.file_raw(session_id, path)
        return Response(content=content, media_type=media_type)

    def artifact_failure(error: ArtifactReadError) -> JSONResponse:
        status_by_code = {
            ARTIFACT_NOT_FOUND: HTTP_404_NOT_FOUND,
            ARTIFACT_PATH_FORBIDDEN: HTTP_FORBIDDEN,
            ARTIFACT_INTEGRITY_MISMATCH: HTTP_CONFLICT,
            ARTIFACT_TOO_LARGE: HTTP_PAYLOAD_TOO_LARGE,
            ARTIFACT_REVISION_CONFLICT: HTTP_PRECONDITION_FAILED,
            ARTIFACT_EDIT_UNAVAILABLE: HTTP_FORBIDDEN,
        }
        return JSONResponse(
            {"ok": False, "error": error.code, "detail": {"code": error.code}},
            status_code=status_by_code.get(error.code, HTTP_BAD_REQUEST),
        )

    @app.get(
        "/api/serve/sessions/{session_id}/artifacts/{artifact_id}/content",
        dependencies=session_guard,
    )
    def artifact_content(session_id: str, artifact_id: str) -> Any:
        try:
            return artifacts.read_text(session_id, artifact_id)
        except ArtifactReadError as error:
            return artifact_failure(error)

    @app.get(
        "/api/serve/sessions/{session_id}/artifacts/{artifact_id}/raw",
        dependencies=session_guard,
    )
    def artifact_raw(session_id: str, artifact_id: str) -> Response:
        try:
            document = artifacts.open_document(session_id, artifact_id)
        except ArtifactReadError as error:
            return artifact_failure(error)
        return _artifact_response(document)

    @app.head(
        "/api/serve/sessions/{session_id}/artifacts/{artifact_id}/raw",
        dependencies=session_guard,
    )
    def artifact_raw_revision(session_id: str, artifact_id: str) -> Response:
        try:
            document = artifacts.open_document(session_id, artifact_id)
        except ArtifactReadError as error:
            return artifact_failure(error)
        return _artifact_response(document, head=True)

    @app.put(
        "/api/serve/sessions/{session_id}/artifacts/{artifact_id}/raw",
        dependencies=session_guard,
    )
    async def update_artifact_raw(session_id: str, artifact_id: str, request: Request) -> Response:
        expected_revision = request.headers.get("if-match", "").strip().strip('"')
        if not expected_revision:
            return JSONResponse(
                {"ok": False, "error": ARTIFACT_REVISION_CONFLICT},
                status_code=HTTP_PRECONDITION_REQUIRED,
            )
        try:
            receipt = artifacts.write_raw(
                session_id,
                artifact_id,
                await request.body(),
                expected_revision,
            )
        except ArtifactReadError as error:
            return artifact_failure(error)
        sessions.broadcast_product_events(session_id, receipt.events)
        return Response(status_code=204, headers={"ETag": f'"{receipt.revision}"'})

    @app.get("/api/serve/sessions/{session_id}/mcp", dependencies=session_guard)
    async def mcp_snapshot(session_id: str, request_id: str = "") -> Any:
        try:
            return await sessions.mcp_snapshot(session_id, request_id=request_id)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.get("/api/serve/sessions/{session_id}/mcp/tools", dependencies=session_guard)
    async def mcp_tools(
        session_id: str,
        server: str = "",
        cursor: str = "",
        limit: int = 100,
        request_id: str = "",
    ) -> Any:
        try:
            return await sessions.mcp_tools(
                session_id,
                server=server,
                cursor=cursor,
                limit=limit,
                request_id=request_id,
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.get("/api/serve/sessions/{session_id}/mcp/resources", dependencies=session_guard)
    async def mcp_resources(
        session_id: str,
        server: str = "",
        cursor: str = "",
        limit: int = 100,
        request_id: str = "",
    ) -> Any:
        try:
            return await sessions.mcp_resources(
                session_id,
                server=server,
                cursor=cursor,
                limit=limit,
                request_id=request_id,
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/resources/read", dependencies=session_guard)
    async def mcp_read_resource(session_id: str, request: Request) -> Any:
        body = await _json(request)
        try:
            return await sessions.mcp_read_resource(
                session_id,
                server=str(body.get("server") or ""),
                uri=str(body.get("uri") or ""),
                request_id=str(body.get("request_id") or ""),
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_BAD_REQUEST)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/reload", dependencies=session_guard)
    async def mcp_reload(session_id: str, request: Request) -> Any:
        body = await _json(request)
        try:
            return await sessions.mcp_reload(
                session_id,
                server=str(body.get("server") or ""),
                request_id=str(body.get("request_id") or ""),
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/tools/call", dependencies=session_guard)
    async def mcp_call_tool(session_id: str, request: Request) -> Any:
        body = await _json(request)
        arguments = body.get("arguments")
        meta = body.get("meta")
        try:
            return await sessions.mcp_call_tool(
                session_id,
                server=str(body.get("server") or ""),
                tool=str(body.get("tool") or ""),
                arguments=dict(arguments) if isinstance(arguments, Mapping) else {},
                meta=dict(meta) if isinstance(meta, Mapping) else {},
                request_id=str(body.get("request_id") or ""),
                explicitly_approved=body.get("approved") is True,
            )
        except ValueError as exc:
            status = HTTP_CONFLICT if str(exc) == MCP_DIRECT_APPROVAL_REQUIRED else HTTP_BAD_REQUEST
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=status)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/login", dependencies=session_guard)
    async def mcp_login(session_id: str, request: Request) -> Any:
        body = await _json(request)
        raw_scopes = body.get("scopes")
        scopes = tuple(str(value) for value in raw_scopes) if isinstance(raw_scopes, list) else ()
        try:
            return await sessions.mcp_begin_login(
                session_id,
                server=str(body.get("server") or ""),
                scopes=scopes,
                request_id=str(body.get("request_id") or ""),
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_BAD_REQUEST)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.get("/api/serve/sessions/{session_id}/mcp/prompts", dependencies=session_guard)
    async def mcp_prompts(session_id: str, server: str = "", request_id: str = "") -> Any:
        try:
            return await sessions.mcp_prompts(
                session_id,
                server=server,
                request_id=request_id,
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/logout", dependencies=session_guard)
    async def mcp_logout(session_id: str, request: Request) -> Any:
        body = await _json(request)
        try:
            return await sessions.mcp_logout(
                session_id,
                server=str(body.get("server") or ""),
                request_id=str(body.get("request_id") or ""),
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/mcp/trust", dependencies=session_guard)
    async def mcp_trust(session_id: str, request: Request) -> Any:
        body = await _json(request)
        try:
            return await sessions.mcp_trust(
                session_id,
                server=str(body.get("server") or ""),
                decision=str(body.get("decision") or ""),
                request_id=str(body.get("request_id") or ""),
            )
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_CONFLICT)
        except (OSError, RuntimeError) as exc:
            return _mcp_failure(exc)

    @app.post("/api/serve/sessions/{session_id}/side", dependencies=session_guard)
    async def post_side(session_id: str, request: Request) -> Any:
        payload, status = await turns.post(session_id, await _json(request), side=True)
        return _result(payload, status)

    @app.get("/api/serve/sessions/{session_id}/queue", dependencies=session_guard)
    async def list_queue(session_id: str) -> Any:
        payload, status = sessions.queued(session_id)
        return _result(payload, status)

    @app.patch(
        "/api/serve/sessions/{session_id}/queue/{queued_message_id}",
        dependencies=session_guard,
    )
    async def update_queue(session_id: str, queued_message_id: str, request: Request) -> Any:
        payload, status = await turns.update_queued(
            session_id,
            queued_message_id,
            await _json(request),
        )
        return _result(payload, status)

    @app.delete(
        "/api/serve/sessions/{session_id}/queue/{queued_message_id}",
        dependencies=session_guard,
    )
    async def delete_queue(session_id: str, queued_message_id: str) -> Any:
        payload, status = await turns.delete_queued(session_id, queued_message_id)
        return _result(payload, status)

    @app.post(
        "/api/serve/sessions/{session_id}/queue/{queued_message_id}/send",
        dependencies=session_guard,
    )
    async def send_queue(session_id: str, queued_message_id: str) -> Any:
        payload, status = await turns.send_queued(session_id, queued_message_id)
        return _result(payload, status)

    @app.post(
        "/api/serve/sessions/{session_id}/queue/{queued_message_id}/reconcile",
        dependencies=session_guard,
    )
    async def reconcile_queue(session_id: str, queued_message_id: str) -> Any:
        payload, status = await turns.reconcile_queued(session_id, queued_message_id)
        return _result(payload, status)

    @app.post("/api/serve/sessions/{session_id}/hil/{request_id}", dependencies=session_guard)
    async def respond_hil(session_id: str, request_id: str, request: Request) -> Any:
        if sessions.requires_host_for_hil(request_id):
            require_host_process(request)
        payload, status = await sessions.respond_hil(session_id, request_id, await _json(request))
        return _result(payload, status)

    @app.post(
        "/api/serve/sessions/{session_id}/turns/{turn_id}/confirm-unknown",
        dependencies=session_guard,
    )
    async def confirm_unknown_turn(session_id: str, turn_id: str, request: Request) -> Any:
        payload, status = await sessions.confirm_unknown_turn(
            session_id,
            turn_id,
            await _json(request),
        )
        return _result(payload, status)

    @app.post(
        "/api/serve/sessions/{session_id}/recovery/check",
        dependencies=session_guard,
    )
    async def check_recovery(session_id: str, request: Request) -> Any:
        actor_id = request_user_id(request)
        skill_environment = await credentials.environment(
            actor_id,
            bearer_or_cookie(request),
        )
        payload, status = await sessions.check_recovery(
            session_id,
            request_principal(request),
            actor_id=actor_id,
            skill_environment=skill_environment,
        )
        return _result(payload, status)

    @app.delete("/api/serve/sessions/{session_id}", dependencies=session_guard)
    async def delete_session(session_id: str, request: Request) -> Any:
        payload, status = await sessions.delete(
            session_id, request_principal(request), actor_id=request_user_id(request)
        )
        return _result(payload, status)

    @app.patch("/api/serve/sessions/{session_id}", dependencies=session_guard)
    async def rename_session(
        session_id: str,
        body: SessionRenameRequest,
        request: Request,
    ) -> Any:
        payload, status = await sessions.rename(session_id, body.title, request_principal(request))
        return _result(payload, status)

    @app.put(
        "/api/serve/sessions/{session_id}/archive",
        dependencies=[Depends(require_session_access)],
    )
    async def set_session_archived(
        session_id: str, body: SessionArchiveRequest, request: Request
    ) -> Any:
        payload, status = await sessions.set_archived(
            session_id,
            body.archived,
            request_principal(request),
            actor_id=request_user_id(request),
        )
        return _result(payload, status)

    @app.put("/api/serve/sessions/{session_id}/pin", dependencies=session_guard)
    def set_session_pinned(
        session_id: str,
        body: SessionPinRequest,
        request: Request,
    ) -> dict[str, Any]:
        return sessions.set_pinned(session_id, body.pinned, request_principal(request))

    @app.get("/api/serve/task-files")
    async def task_files(
        request: Request,
        project_path: str,
        cursor: str = "",
        limit: int = Query(default=SESSION_LIST_MAX_LIMIT, ge=1, le=SESSION_LIST_MAX_LIMIT),
    ) -> dict[str, Any]:
        try:
            parse_session_list_cursor(cursor)
        except ValueError as error:
            raise HTTPException(
                HTTP_422_UNPROCESSABLE_CONTENT, SESSION_LIST_CURSOR_INVALID
            ) from error
        payload = await sessions.list(
            limit,
            request_principal(request),
            scope=SessionListScope.PROJECT,
            project_path=project_path,
            cursor=cursor,
        )
        entries = []
        for session in payload["sessions"]:
            try:
                listing = await request.app.state.activities.to_thread(
                    ActivityDomain.RESOURCE,
                    sessions.files,
                    session["session_id"],
                    outputs_only=True,
                )
            except (HTTPException, OSError, ValueError):
                entries.append({"session": session, "files": None})
                continue
            if listing["has_files"]:
                entries.append({"session": session, "files": listing})
        return {"entries": entries, "next_cursor": payload.get("next_cursor")}

    @app.get("/api/serve/history/{session_id}", dependencies=session_guard)
    def history(session_id: str) -> dict[str, Any]:
        payload = sessions.history(session_id)
        payload["turns"] = events.decorate_history(session_id, payload["turns"])
        payload["activity_events"] = events.activity_snapshot(session_id)
        payload["turn_activity"] = events.turn_activity_snapshot(session_id)
        return payload

    @app.get("/api/serve/sessions/{session_id}/mode", dependencies=session_guard)
    def get_mode(session_id: str) -> dict[str, Any]:
        return sessions.mode(session_id)

    @app.get(
        "/api/serve/sessions/{session_id}/runtime/reconfigure",
        dependencies=[Depends(require_session_access)],
    )
    def current_reconfiguration(session_id: str, request: Request) -> Any:
        current = sessions.current_reconfiguration(session_id, actor_id=request_user_id(request))
        return current if current is not None else Response(status_code=204)

    @app.get(
        "/api/serve/sessions/{session_id}/runtime/reconfigure/{request_id}",
        dependencies=[Depends(require_session_access)],
    )
    def reconfiguration_status(session_id: str, request_id: str, request: Request) -> Any:
        try:
            return sessions.reconfiguration_status(
                session_id, request_id, actor_id=request_user_id(request)
            )
        except ValueError:
            return JSONResponse(
                {"error": RECONFIGURATION_NOT_FOUND}, status_code=HTTP_404_NOT_FOUND
            )

    @app.get("/api/serve/sessions/{session_id}/model", dependencies=session_guard)
    def get_model(session_id: str) -> dict[str, Any]:
        return sessions.model(session_id)

    @app.post("/api/serve/sessions/{session_id}/model", dependencies=session_guard)
    async def set_model(
        session_id: str,
        body: SessionModelRequest,
        request: Request,
    ) -> Any:
        try:
            thinking = thinking_from_payload(body.thinking)
        except ValueError as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=HTTP_BAD_REQUEST)
        payload, status = await sessions.set_model(
            session_id,
            request_principal(request),
            body.model_id,
            reasoning_effort=body.reasoning_effort,
            thinking=thinking,
            remember_default=body.remember_default,
            actor_id=request_user_id(request),
        )
        return _result(payload, status)

    @app.post("/api/serve/sessions/{session_id}/mode", dependencies=session_guard)
    async def set_mode(session_id: str, request: Request) -> Any:
        activities = request.app.state.activities
        with activities.enter(ActivityDomain.RUNTIME, root=True) as activity:
            body = await _json(request)

            async def change_mode() -> Any:
                payload, status = await sessions.set_mode(
                    session_id,
                    request_principal(request),
                    str(body.get("mode") or ""),
                    application=str(body.get("application") or PermissionApplication.AUTO.value),
                )
                continuation = payload.pop("continuation", None)
                if status == HTTP_OK and continuation:
                    context = body.get("continuation_context")
                    context = context if isinstance(context, Mapping) else {}
                    result, result_status = await turns.post(
                        session_id,
                        {
                            "input": [
                                {
                                    "type": InputKind.TEXT.value,
                                    "text": SESSION_PERMISSION_CONTINUATION_TEXT,
                                }
                            ],
                            **{
                                key: context[key]
                                for key in PERMISSION_CONTINUATION_CONTEXT_FIELDS
                                if key in context
                            },
                        },
                        side=False,
                        expected_submission_id=continuation["submission_id"],
                        expected_interrupt_generation=continuation["interrupt_generation"],
                        expected_permission_mode=str(payload["mode"]),
                        continuation_activity=activity,
                    )
                    payload["continued"] = bool(result.get("ok"))
                    if result_status >= HTTP_BAD_REQUEST:
                        return _result({**payload, **result}, result_status)
                return _result(payload, status)

            return await activities.finish(ActivityDomain.RUNTIME, change_mode)

    @app.api_route(
        "/api/serve/sessions/{session_id}/command",
        methods=["POST"],
        dependencies=session_guard,
    )
    @app.api_route(
        "/api/serve/sessions/{session_id}/rewind",
        methods=["POST"],
        dependencies=session_guard,
    )
    @app.api_route(
        "/api/serve/sessions/{session_id}/workflow",
        methods=["GET", "POST"],
        dependencies=session_guard,
    )
    @app.api_route(
        "/api/serve/sessions/{session_id}/auto-review",
        methods=["GET", "POST"],
        dependencies=session_guard,
    )
    async def unavailable_session_capability(session_id: str) -> JSONResponse:
        return JSONResponse(
            {
                "ok": False,
                "session_id": session_id,
                "error": RUNTIME_CAPABILITY_UNAVAILABLE,
            },
            status_code=HTTP_CONFLICT,
        )


__all__ = ["mount_session_routes"]
