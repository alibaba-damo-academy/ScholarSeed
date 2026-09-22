"""Assistant HTTP 路由（assistant 域，开发 6 拥有）。

本模块暴露 Session 级上下文资源的读取与整体替换，也编排 AI 回答/产物进入
资料库。前端只提交稳定 ID、结构化内容和 `expected_revision`；路由不直接读取
资料库、文献库、Workbench 或 Documents 的存储。

来源解析发生在 Turn 准入阶段，并通过 assistant 域注册的 Provider 完成；会话
产物导入只接收稳定 ID、可选内容摘要和资料库相对位置，由服务端解析真实路径。
两条链路都避免 Renderer 持有或提交任意绝对路径。
"""

from __future__ import annotations

import uuid
from dataclasses import asdict, replace

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.status import (
    HTTP_400_BAD_REQUEST,
    HTTP_404_NOT_FOUND,
    HTTP_409_CONFLICT,
)

from service.assistant.api.schema import (
    AnswerAnnotationBatchDeleteRequest,
    AnswerAnnotationContextRequest,
    AnswerAnnotationCreateRequest,
    AnswerAnnotationDeleteRequest,
    AnswerAnnotationUpdateRequest,
    AssistantAttachmentImportRequest,
    AssistantContextPatchRequest,
    AssistantInvocationStartRequest,
    AssistantLiteratureImportRequest,
    AssistantResourceCreateRequest,
    AssistantResourceImportRequest,
    AssistantTranslationStartRequest,
    CitationResolveRequest,
)
from service.assistant.domain.model import AnswerAnnotation
from service.assistant.persistence.invocations import (
    AssistantInvocationConflictError,
    AssistantInvocationRecord,
)
from service.assistant.persistence.links import LINK_CONFLICT, ArtifactLinkError
from service.assistant.persistence.store import (
    AnswerAnnotationClaimedError,
    AnswerAnnotationMissingError,
    AnswerAnnotationOverlapError,
    AnswerAnnotationRevisionConflictError,
    AssistantRevisionConflictError,
    AssistantSessionMissingError,
    AssistantStateConflictError,
)
from service.assistant.service.actions import (
    ACTION_RUNTIME_UNAVAILABLE,
    AssistantActionService,
    AssistantInvocationRequest,
    AssistantTranslationRequest,
)
from service.assistant.service.annotations import (
    AnswerAnnotationService,
    AnswerAnnotationValidationError,
)
from service.assistant.service.citations import CitationService
from service.assistant.service.context import AssistantService
from service.assistant.service.literature import AssistantLiteratureService
from service.assistant.service.resources import (
    ANSWER_RESOURCE_NOT_FOUND,
    ANSWER_RESOURCE_RANGE_INVALID,
    ANSWER_RESOURCE_REVISION_CONFLICT,
    ANSWER_RESOURCE_SELECTION_MISMATCH,
    ASSISTANT_PROJECT_UNAVAILABLE,
    AnswerResourceSource,
    AssistantResourceError,
    AssistantResourceService,
)
from service.chat.constants import SESSION_NOT_FOUND_ERROR, SessionTitleFallback
from service.chat.persistence.catalog import (
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.service.artifacts import (
    ARTIFACT_INTEGRITY_MISMATCH,
    ARTIFACT_NOT_FOUND,
    ARTIFACT_PATH_FORBIDDEN,
    ARTIFACT_REVISION_CONFLICT,
    ArtifactReadError,
)
from service.chat.service.history import HistoryError, HistoryService
from service.content.domain.model import (
    PREPARED_CONFLICT,
    PREPARED_UNAVAILABLE,
    ROOT_UNAVAILABLE_ERROR,
    ContentError,
)
from service.identity.utils import request_owner_id, request_user_id
from service.literature.domain.model import IMPORT_COLLECTION_UNAVAILABLE
from service.literature.domain.model import IMPORT_CONFLICT as LITERATURE_IMPORT_CONFLICT
from service.literature.domain.model import LIBRARY_INVALID, LiteratureError
from service.literature.service.importer import LiteratureImportError
from service.platform.bridge import HISTORY_MAX_LIMIT, HistoryRead
from service.platform.content import FileAssetRef
from service.platform.context import (
    AssistantContextSelection,
    ContextLabelFallback,
    ContextRef,
    SelectionAnchor,
)
from service.platform.inference import ModelInvocationStatus
from service.resources.domain.model import IMPORT_CONFLICT, IMPORT_UNAVAILABLE, ResourceLocationRef

ASSISTANT_ROUTE_PREFIX = "/api/assistant"
HTTP_UNPROCESSABLE_CONTENT = 422
HTTP_ACCEPTED = 202
HTTP_SERVICE_UNAVAILABLE = 503
HTTP_OK = 200
HTTP_BAD_GATEWAY = 502
HTTP_FORBIDDEN = 403
CITATION_PREVIEW_CACHE_SECONDS = 300
ASSISTANT_RESOURCES_UNAVAILABLE = "assistant_resources_unavailable"
ASSISTANT_LITERATURE_UNAVAILABLE = "assistant_literature_unavailable"
ASSISTANT_RESOURCE_ERROR_STATUS = {
    ASSISTANT_PROJECT_UNAVAILABLE: HTTP_409_CONFLICT,
    ANSWER_RESOURCE_NOT_FOUND: HTTP_404_NOT_FOUND,
    ANSWER_RESOURCE_RANGE_INVALID: HTTP_400_BAD_REQUEST,
    ANSWER_RESOURCE_REVISION_CONFLICT: HTTP_409_CONFLICT,
    ANSWER_RESOURCE_SELECTION_MISMATCH: HTTP_409_CONFLICT,
    ARTIFACT_NOT_FOUND: HTTP_404_NOT_FOUND,
    ARTIFACT_PATH_FORBIDDEN: HTTP_FORBIDDEN,
    ARTIFACT_INTEGRITY_MISMATCH: HTTP_409_CONFLICT,
    ARTIFACT_REVISION_CONFLICT: HTTP_409_CONFLICT,
    IMPORT_CONFLICT: HTTP_409_CONFLICT,
    IMPORT_UNAVAILABLE: HTTP_409_CONFLICT,
    PREPARED_CONFLICT: HTTP_409_CONFLICT,
    PREPARED_UNAVAILABLE: HTTP_409_CONFLICT,
    ROOT_UNAVAILABLE_ERROR: HTTP_409_CONFLICT,
    LINK_CONFLICT: HTTP_409_CONFLICT,
    LITERATURE_IMPORT_CONFLICT: HTTP_409_CONFLICT,
    IMPORT_COLLECTION_UNAVAILABLE: HTTP_409_CONFLICT,
    LIBRARY_INVALID: HTTP_409_CONFLICT,
}


def _assistant(request: Request) -> AssistantService:
    """取 bootstrap 注入的 assistant 域服务。"""

    service = getattr(request.app.state, "assistant", None)
    if not isinstance(service, AssistantService):
        raise HTTPException(status_code=503, detail="assistant_unavailable")
    return service


def _actions(request: Request) -> AssistantActionService:
    """取 bootstrap 注入的非会话 Assistant action 服务。"""

    service = getattr(request.app.state, "assistant_actions", None)
    if not isinstance(service, AssistantActionService):
        raise HTTPException(
            status_code=HTTP_SERVICE_UNAVAILABLE, detail="assistant_actions_unavailable"
        )
    return service


def _annotations(request: Request) -> AnswerAnnotationService:
    service = getattr(request.app.state, "assistant_annotations", None)
    if not isinstance(service, AnswerAnnotationService):
        raise HTTPException(
            status_code=HTTP_SERVICE_UNAVAILABLE,
            detail="assistant_annotations_unavailable",
        )
    return service


def _catalog(request: Request) -> SessionCatalogStore:
    """取 Session 权限校验的权威目录。"""

    store = getattr(request.app.state, "session_catalog", None)
    if not isinstance(store, SessionCatalogStore):
        raise HTTPException(status_code=503, detail="session_catalog_unavailable")
    return store


def _history(request: Request) -> HistoryService:
    """取组合根注入的产品历史读取服务。"""

    service = getattr(request.app.state, "history_service", None)
    if not isinstance(service, HistoryService):
        raise HTTPException(status_code=HTTP_SERVICE_UNAVAILABLE, detail="history_unavailable")
    return service


def _resources(request: Request) -> AssistantResourceService:
    """取组合根注入的会话→资料库编排服务。"""

    service = getattr(request.app.state, "assistant_resources", None)
    if not isinstance(service, AssistantResourceService):
        raise HTTPException(
            status_code=HTTP_SERVICE_UNAVAILABLE,
            detail=ASSISTANT_RESOURCES_UNAVAILABLE,
        )
    return service


def _require_session(request: Request, session_id: str) -> None:
    """按当前请求主体校验 Session；不可访问统一表现为不存在。"""

    try:
        _catalog(request).require(session_id, SessionPrincipal(request_owner_id(request)))
    except SessionAccessError as exc:
        raise HTTPException(HTTP_404_NOT_FOUND, SESSION_NOT_FOUND_ERROR) from exc


def _literature(request: Request) -> AssistantLiteratureService:
    service = getattr(request.app.state, "assistant_literature", None)
    if not isinstance(service, AssistantLiteratureService):
        raise HTTPException(HTTP_SERVICE_UNAVAILABLE, ASSISTANT_LITERATURE_UNAVAILABLE)
    return service


def _selection_payload(
    selection: AssistantContextSelection,
    service: AssistantService,
) -> dict:
    """把领域对象投影为 Desktop 使用的页面安全响应。"""

    return {
        "session_id": selection.session_id,
        "revision": selection.revision,
        "project_policy": selection.project_policy.value,
        "search_scope": selection.search_scope.value,
        "refs": [asdict(ref) for ref in selection.refs],
        "updated_at": selection.updated_at,
        "capabilities": [asdict(capability) for capability in service.capabilities()],
    }


def _resource_payload(asset: FileAssetRef) -> dict:
    """资料写入结果投影为与 `/api/resource/node` 一致的节点形状。"""

    return {
        "path": asset.path,
        "assetId": asset.asset_id,
        "name": asset.name,
        "kind": asset.kind.value,
        "origin": asset.origin.value,
    }


def _resource_failure(error: AssistantResourceError) -> HTTPException:
    return HTTPException(
        status_code=ASSISTANT_RESOURCE_ERROR_STATUS.get(error.code, HTTP_400_BAD_REQUEST),
        detail=error.code,
    )


def _invocation_payload(record: AssistantInvocationRecord) -> dict:
    """只投影动作状态和产品结果，不返回 prompt、原文、凭证或网关 header。"""

    return {
        "invocation_id": record.invocation_id,
        "client_action_id": record.client_action_id,
        "client_attempt_id": record.client_attempt_id,
        "retry_of_attempt_id": record.retry_of_attempt_id,
        "kind": record.kind,
        "project_id": record.project_id,
        "source": {
            "source_id": record.source_id,
            "source_revision": record.source_revision,
        },
        "prompt_version": record.prompt_version,
        "status": record.status.value,
        "detected_source_language": record.detected_source_language or None,
        "target_language": record.target_language,
        "model_key": record.model_key or None,
        "output": ({"type": "text", "text": record.output_text} if record.output_text else None),
        "usage": {
            "input_tokens": record.input_tokens,
            "output_tokens": record.output_tokens,
            "receipt_id": record.receipt_id or None,
        },
        "error": (
            {"code": record.error_code, "detail": record.error_detail}
            if record.error_code
            else None
        ),
        "created_at": record.created_at,
        "updated_at": record.updated_at,
    }


def _annotation_payload(annotation: AnswerAnnotation) -> dict:
    return asdict(annotation)


def _annotation_error(exc: Exception, service: AssistantService) -> HTTPException:
    if isinstance(exc, AssistantRevisionConflictError):
        return HTTPException(
            HTTP_409_CONFLICT,
            detail={
                "error": "assistant_context_revision_conflict",
                "latest": _selection_payload(exc.latest, service),
            },
        )
    if isinstance(exc, AnswerAnnotationRevisionConflictError):
        return HTTPException(
            HTTP_409_CONFLICT,
            detail={
                "error": "answer_annotation_revision_conflict",
                "latest": _annotation_payload(exc.latest),
            },
        )
    if isinstance(exc, AnswerAnnotationOverlapError):
        return HTTPException(HTTP_409_CONFLICT, detail="answer_annotation_overlap")
    if isinstance(exc, AnswerAnnotationClaimedError):
        return HTTPException(HTTP_409_CONFLICT, detail="answer_annotation_claimed")
    if isinstance(exc, (AnswerAnnotationMissingError, AssistantSessionMissingError)):
        return HTTPException(HTTP_404_NOT_FOUND, detail="answer_annotation_not_found")
    if isinstance(exc, AssistantStateConflictError):
        return HTTPException(HTTP_409_CONFLICT, detail=str(exc))
    if isinstance(exc, AnswerAnnotationValidationError):
        return HTTPException(HTTP_UNPROCESSABLE_CONTENT, detail=exc.code)
    return HTTPException(HTTP_UNPROCESSABLE_CONTENT, detail=str(exc))


def _invocation_status(record: AssistantInvocationRecord) -> int:
    if record.status in (
        ModelInvocationStatus.PENDING,
        ModelInvocationStatus.RUNNING,
        ModelInvocationStatus.UNKNOWN,
    ):
        return HTTP_ACCEPTED
    if record.error_code == ACTION_RUNTIME_UNAVAILABLE:
        return HTTP_SERVICE_UNAVAILABLE
    if record.error_code:
        return HTTP_BAD_GATEWAY
    return HTTP_OK


def register_assistant_routes(app: FastAPI) -> None:
    @app.get(
        f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/citations/{{handle}}/raw"
    )
    def citation_raw(
        session_id: str, answer_id: str, handle: str, answer_revision: str, request: Request
    ) -> Response:
        _require_session(request, session_id)
        try:
            payload = request.app.state.assistant_citations.raw(
                session_id, answer_id, answer_revision, handle
            )
        except (ValueError, ContentError, OSError) as error:
            raise HTTPException(HTTP_409_CONFLICT, str(error)) from error
        return Response(
            payload, media_type="application/pdf", headers={"Cache-Control": "no-store"}
        )

    @app.get(
        f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/citations/{{handle}}/preview"
    )
    def citation_preview(
        session_id: str,
        answer_id: str,
        handle: str,
        answer_revision: str,
        request: Request,
        page: int = Query(ge=1),
    ) -> Response:
        _require_session(request, session_id)
        try:
            payload = request.app.state.assistant_citations.preview(
                session_id, answer_id, answer_revision, handle, page
            )
        except (ValueError, ContentError, OSError) as error:
            raise HTTPException(HTTP_409_CONFLICT, str(error)) from error
        return Response(
            payload,
            media_type="image/png",
            headers={"Cache-Control": f"private, max-age={CITATION_PREVIEW_CACHE_SECONDS}"},
        )

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/resources/citation")
    def saved_resource_citation(request: Request, project: str, path: str, handle: str) -> dict:
        try:
            return _resources(request).resolve_saved_citation(project, path, handle)
        except (AssistantResourceError, ValueError) as error:
            raise HTTPException(HTTP_409_CONFLICT, str(error)) from error

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/sources")
    def answer_sources(
        session_id: str,
        answer_id: str,
        answer_revision: str,
        request: Request,
        start_utf16: int | None = Query(default=None, ge=0),
        end_utf16: int | None = Query(default=None, ge=0),
    ) -> dict:
        _require_session(request, session_id)
        try:
            return request.app.state.assistant_citations.sources(
                session_id, answer_id, answer_revision, start_utf16, end_utf16
            )
        except ValueError as error:
            raise HTTPException(HTTP_409_CONFLICT, str(error)) from error

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/citation")
    def resolve_citation(
        session_id: str, answer_id: str, body: CitationResolveRequest, request: Request
    ) -> dict:
        _require_session(request, session_id)
        service = getattr(request.app.state, "assistant_citations", None)
        if not isinstance(service, CitationService):
            raise HTTPException(HTTP_SERVICE_UNAVAILABLE, "citations_unavailable")
        try:
            return service.resolve(session_id, answer_id, **body.model_dump())
        except (ValueError, ContentError) as exc:
            raise HTTPException(HTTP_409_CONFLICT, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(HTTP_404_NOT_FOUND, "source_unavailable") from exc

    """把最终的 Session 上下文资源接口挂到应用上。"""

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/context")
    def assistant_context(session_id: str, request: Request) -> dict:
        _require_session(request, session_id)
        service = _assistant(request)
        try:
            return _selection_payload(service.selection(session_id), service)
        except AssistantSessionMissingError as exc:
            raise HTTPException(HTTP_404_NOT_FOUND, SESSION_NOT_FOUND_ERROR) from exc

    @app.get(
        f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/context/" "{snapshot_id}/session-preview"
    )
    def session_reference_preview(
        session_id: str,
        snapshot_id: str,
        request: Request,
        source_id: str,
        cursor: str = "",
    ) -> dict:
        """预览发送时已冻结的会话引用，不改变当前会话。"""

        _require_session(request, session_id)
        scope = _assistant(request).history_reference_scope(session_id, snapshot_id, source_id)
        if scope is None:
            raise HTTPException(HTTP_404_NOT_FOUND, "assistant_session_reference_not_found")
        reference = scope.refs[0]
        try:
            source = _history(request).source(session_id, source_id)
            readable_scope = replace(
                scope,
                refs=(replace(reference, source_revision=source.revision),),
            )
            result = _history(request).query(
                session_id,
                readable_scope,
                HistoryRead(
                    session_id=source_id,
                    order="asc",
                    limit=HISTORY_MAX_LIMIT,
                    cursor=cursor,
                ),
            )
        except HistoryError as exc:
            raise HTTPException(HTTP_409_CONFLICT, str(exc)) from exc
        return {
            **result,
            "title": source.title,
            "label_fallback": (
                (
                    ContextLabelFallback.NEW_SESSION
                    if source.title_fallback is SessionTitleFallback.NEW_SESSION
                    else None
                )
                if source.title
                else reference.label_fallback
            ),
            "expected_revision": reference.source_revision,
            "source_revision": source.revision,
            "changed": bool(
                reference.source_revision and reference.source_revision != source.revision
            ),
        }

    @app.patch(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/context")
    def replace_assistant_context(
        session_id: str,
        body: AssistantContextPatchRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        service = _assistant(request)
        refs = tuple(
            ContextRef(
                ref_id=ref.ref_id.strip() or uuid.uuid4().hex,
                kind=ref.kind,
                source_id=ref.source_id.strip(),
                source_revision=(ref.source_revision or "").strip() or None,
                label=ref.label.strip(),
                label_fallback=ref.label_fallback,
                selection_source_label=ref.selection_source_label,
                anchor=(
                    SelectionAnchor(**ref.anchor.model_dump()) if ref.anchor is not None else None
                ),
                retention=ref.retention,
                origin=ref.origin,
            )
            for ref in body.refs
        )
        try:
            selection = service.replace_selection(
                session_id=session_id,
                expected_revision=body.expected_revision,
                project_policy=body.project_policy,
                search_scope=body.search_scope,
                refs=refs,
            )
        except AssistantRevisionConflictError as exc:
            return_data = _selection_payload(exc.latest, service)
            raise HTTPException(
                status_code=HTTP_409_CONFLICT,
                detail={"error": "assistant_context_revision_conflict", "latest": return_data},
            ) from exc
        except AssistantStateConflictError as exc:
            latest = _selection_payload(service.selection(session_id), service)
            raise HTTPException(
                status_code=HTTP_409_CONFLICT,
                detail={"error": str(exc), "latest": latest},
            ) from exc
        except AssistantSessionMissingError as exc:
            raise HTTPException(HTTP_404_NOT_FOUND, SESSION_NOT_FOUND_ERROR) from exc
        except ValueError as exc:
            raise HTTPException(HTTP_UNPROCESSABLE_CONTENT, str(exc)) from exc
        return _selection_payload(selection, service)

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/resources/create")
    def create_resource_from_assistant(
        session_id: str,
        body: AssistantResourceCreateRequest,
        request: Request,
    ) -> dict:
        """把 AI 回答内容通过 ResourceWriter 新建为 Markdown 资料。"""

        _require_session(request, session_id)
        try:
            source = (
                AnswerResourceSource(
                    answer_id=body.source.answer_id,
                    answer_revision=body.source.answer_revision,
                    start_utf16=body.source.start_utf16,
                    end_utf16=body.source.end_utf16,
                    selected_text_hash=body.source.selected_text_hash,
                )
                if body.source is not None
                else None
            )
            location = (
                ResourceLocationRef(
                    parent=body.location.parent,
                    name=body.location.name,
                )
                if body.location is not None
                else None
            )
            asset = _resources(request).create(
                session_id,
                body.project_id,
                body.name,
                body.content,
                location,
                source=source,
            )
        except AssistantResourceError as error:
            raise _resource_failure(error) from error
        return {"node": _resource_payload(asset)}

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/resources/import")
    def import_resource_from_assistant(
        session_id: str,
        body: AssistantResourceImportRequest,
        request: Request,
    ) -> dict:
        """把当前 Session 的结构化产物复制进资料库。"""

        _require_session(request, session_id)
        try:
            location = (
                ResourceLocationRef(
                    parent=body.location.parent,
                    name=body.location.name,
                )
                if body.location is not None
                else None
            )
            asset = _resources(request).import_artifact(
                session_id,
                body.project_id,
                body.artifact_id,
                body.expected_sha256,
                location,
                body.idempotency_key,
            )
        except AssistantResourceError as error:
            raise _resource_failure(error) from error
        return {"node": _resource_payload(asset)}

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/resources/links")
    def artifact_resource_links(session_id: str, request: Request) -> dict:
        """Session-authorized durable links; source bytes are not needed to reopen a copy."""
        _require_session(request, session_id)
        try:
            links = _resources(request).library_links(session_id)
        except AssistantResourceError as error:
            raise _resource_failure(error) from error
        return {
            "links": [
                {
                    "link_id": link.record.link_id,
                    "project_id": link.record.project_id,
                    "session_id": link.record.session_id,
                    "artifact_id": link.record.artifact_id,
                    "source_sha256": link.record.source_sha256,
                    "destination": link.record.destination.value,
                    "state": link.record.state.value,
                    "target_ids": link.record.target_ids,
                    "node": _resource_payload(link.asset) if link.asset is not None else None,
                    "error": link.error or None,
                }
                for link in links
            ]
        }

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/literature/import")
    def import_literature_from_assistant(
        session_id: str,
        body: AssistantLiteratureImportRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        try:
            receipt = _literature(request).import_artifact(
                session_id,
                body.artifact_id,
                body.expected_sha256,
                body.idempotency_key,
                body.collection,
            )
        except (
            ArtifactReadError,
            ArtifactLinkError,
            ContentError,
            LiteratureImportError,
            LiteratureError,
        ) as error:
            raise HTTPException(
                ASSISTANT_RESOURCE_ERROR_STATUS.get(error.code, HTTP_400_BAD_REQUEST), error.code
            ) from error
        return {
            "operation_id": receipt.operation_id,
            "item_ids": [item.id for item in receipt.items],
            "added": receipt.added,
            "skipped": receipt.skipped,
        }

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/literature/links")
    def artifact_literature_links(session_id: str, request: Request) -> dict:
        _require_session(request, session_id)
        try:
            links = _literature(request).library_links(session_id)
        except (ArtifactReadError, ArtifactLinkError, ContentError) as error:
            raise HTTPException(
                ASSISTANT_RESOURCE_ERROR_STATUS.get(error.code, HTTP_409_CONFLICT), error.code
            ) from error
        return {
            "links": [
                {
                    "link_id": link.record.link_id,
                    "project_id": link.record.project_id,
                    "session_id": link.record.session_id,
                    "artifact_id": link.record.artifact_id,
                    "source_sha256": link.record.source_sha256,
                    "destination": link.record.destination.value,
                    "state": link.record.state.value,
                    "target_ids": link.record.target_ids,
                    "items": [{"id": item.id, "title": item.title} for item in link.items],
                    "missing_ids": link.missing_ids,
                    "error": link.error or None,
                }
                for link in links
            ]
        }

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/resources/attachment")
    def import_sent_attachment(
        session_id: str,
        body: AssistantAttachmentImportRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        try:
            asset = _resources(request).import_attachment(
                session_id,
                body.project_id,
                body.reference_id,
                ResourceLocationRef(parent=body.location.parent, name=body.location.name),
            )
        except AssistantResourceError as error:
            raise _resource_failure(error) from error
        return {"node": _resource_payload(asset)}

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations")
    def answer_annotations(session_id: str, request: Request) -> dict:
        _require_session(request, session_id)
        return {
            "annotations": [
                _annotation_payload(annotation)
                for annotation in _annotations(request).annotations(session_id)
            ]
        }

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/annotations")
    def answer_annotations_for_answer(
        session_id: str,
        answer_id: str,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        try:
            annotations = _annotations(request).annotations(session_id, answer_id=answer_id)
        except AnswerAnnotationValidationError as exc:
            raise _annotation_error(exc, _assistant(request)) from exc
        return {"annotations": [_annotation_payload(item) for item in annotations]}

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/answers/{{answer_id}}/annotations")
    def create_answer_annotation(
        session_id: str,
        answer_id: str,
        body: AnswerAnnotationCreateRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            annotation, selection = _annotations(request).create(
                session_id=session_id,
                answer_id=answer_id,
                client_annotation_id=body.client_annotation_id,
                expected_context_revision=body.expected_context_revision,
                answer_revision=body.answer_revision,
                start_utf16=body.start_utf16,
                end_utf16=body.end_utf16,
                selected_text_hash=body.selected_text_hash,
                preview_text=body.preview_text,
                comment=body.comment,
                enqueue=body.enqueue,
            )
        except (
            AnswerAnnotationOverlapError,
            AssistantRevisionConflictError,
            AssistantStateConflictError,
            AnswerAnnotationValidationError,
        ) as exc:
            raise _annotation_error(exc, assistant) from exc
        return {
            "annotation": _annotation_payload(annotation),
            "selection": _selection_payload(selection, assistant),
        }

    @app.patch(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations/{{annotation_id}}")
    def update_answer_annotation(
        session_id: str,
        annotation_id: str,
        body: AnswerAnnotationUpdateRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            annotation, selection = _annotations(request).update(
                session_id=session_id,
                annotation_id=annotation_id,
                comment=body.comment,
                expected_annotation_revision=body.expected_annotation_revision,
                expected_context_revision=body.expected_context_revision,
            )
        except (
            AnswerAnnotationClaimedError,
            AnswerAnnotationMissingError,
            AnswerAnnotationRevisionConflictError,
            AssistantRevisionConflictError,
            AnswerAnnotationValidationError,
        ) as exc:
            raise _annotation_error(exc, assistant) from exc
        return {
            "annotation": _annotation_payload(annotation),
            "selection": _selection_payload(selection, assistant),
        }

    @app.post(
        f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations/{{annotation_id}}/context"
    )
    def enqueue_answer_annotation(
        session_id: str,
        annotation_id: str,
        body: AnswerAnnotationContextRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            selection = _annotations(request).enqueue(
                session_id=session_id,
                annotation_id=annotation_id,
                expected_context_revision=body.expected_context_revision,
            )
        except (
            AnswerAnnotationMissingError,
            AssistantRevisionConflictError,
            AnswerAnnotationValidationError,
        ) as exc:
            raise _annotation_error(exc, assistant) from exc
        return _selection_payload(selection, assistant)

    @app.delete(
        f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations/{{annotation_id}}/context"
    )
    def remove_answer_annotation_context(
        session_id: str,
        annotation_id: str,
        body: AnswerAnnotationContextRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            selection = _annotations(request).remove_context(
                session_id=session_id,
                annotation_id=annotation_id,
                expected_context_revision=body.expected_context_revision,
            )
        except (AnswerAnnotationClaimedError, AssistantRevisionConflictError) as exc:
            raise _annotation_error(exc, assistant) from exc
        return _selection_payload(selection, assistant)

    @app.delete(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations/{{annotation_id}}")
    def delete_answer_annotation(
        session_id: str,
        annotation_id: str,
        body: AnswerAnnotationDeleteRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            selection = _annotations(request).delete(
                session_id=session_id,
                annotation_id=annotation_id,
                expected_annotation_revision=body.expected_annotation_revision,
                expected_context_revision=body.expected_context_revision,
            )
        except (
            AnswerAnnotationClaimedError,
            AnswerAnnotationMissingError,
            AnswerAnnotationRevisionConflictError,
            AssistantRevisionConflictError,
        ) as exc:
            raise _annotation_error(exc, assistant) from exc
        return _selection_payload(selection, assistant)

    @app.delete(f"{ASSISTANT_ROUTE_PREFIX}/sessions/{{session_id}}/annotations")
    def delete_answer_annotations(
        session_id: str,
        body: AnswerAnnotationBatchDeleteRequest,
        request: Request,
    ) -> dict:
        _require_session(request, session_id)
        assistant = _assistant(request)
        try:
            selection = _annotations(request).delete_many(
                session_id=session_id,
                expected_annotation_revisions=tuple(
                    (item.annotation_id, item.expected_annotation_revision)
                    for item in body.annotations
                ),
                expected_context_revision=body.expected_context_revision,
            )
        except (
            AnswerAnnotationClaimedError,
            AnswerAnnotationRevisionConflictError,
            AssistantRevisionConflictError,
        ) as exc:
            raise _annotation_error(exc, assistant) from exc
        return _selection_payload(selection, assistant)

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/invocations/capabilities")
    def assistant_invocation_capabilities(request: Request) -> dict:
        return {"actions": list(_actions(request).capabilities())}

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/invocations")
    async def start_assistant_invocation(
        body: AssistantInvocationStartRequest,
        request: Request,
    ) -> JSONResponse:
        try:
            record = await _actions(request).complete(
                AssistantInvocationRequest(
                    owner_id=request_user_id(request),
                    client_action_id=body.client_action_id,
                    client_attempt_id=body.client_attempt_id,
                    retry_of_attempt_id=body.retry_of_attempt_id,
                    project_id=body.project_id,
                    input_text=body.input_text,
                    instructions=body.instructions,
                    model_key=body.model_key,
                )
            )
        except AssistantInvocationConflictError as exc:
            raise HTTPException(HTTP_409_CONFLICT, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(HTTP_UNPROCESSABLE_CONTENT, str(exc)) from exc
        return JSONResponse(_invocation_payload(record), status_code=_invocation_status(record))

    @app.post(f"{ASSISTANT_ROUTE_PREFIX}/translations")
    async def start_assistant_translation(
        body: AssistantTranslationStartRequest,
        request: Request,
    ) -> JSONResponse:
        try:
            record = await _actions(request).translate(
                AssistantTranslationRequest(
                    owner_id=request_user_id(request),
                    client_action_id=body.client_action_id,
                    client_attempt_id=body.client_attempt_id,
                    retry_of_attempt_id=body.retry_of_attempt_id,
                    project_id=body.project_id,
                    text=body.text,
                    target_language=body.target_language,
                    source_id=body.source_id.strip(),
                    source_revision=(body.source_revision or "").strip() or None,
                    model_key=body.model_key,
                )
            )
        except AssistantInvocationConflictError as exc:
            raise HTTPException(HTTP_409_CONFLICT, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(HTTP_UNPROCESSABLE_CONTENT, str(exc)) from exc
        return JSONResponse(_invocation_payload(record), status_code=_invocation_status(record))

    @app.get(f"{ASSISTANT_ROUTE_PREFIX}/invocations/{{invocation_id}}")
    def assistant_invocation(invocation_id: str, request: Request) -> dict:
        record = _actions(request).get(invocation_id, request_user_id(request))
        if record is None:
            raise HTTPException(HTTP_404_NOT_FOUND, "assistant_invocation_not_found")
        return _invocation_payload(record)


__all__ = ["ASSISTANT_ROUTE_PREFIX", "register_assistant_routes"]
