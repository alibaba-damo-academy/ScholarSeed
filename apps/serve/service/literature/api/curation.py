"""Bridge management plane for the literature catalogue.

The product API (``/api/v1``) and this bridge share one implementation: every
handler here calls the same repository/service functions as
``service/literature/api/catalogue.py`` (counts/facets/notes/bulk/patch/delete
were extracted there as ``*_payload`` / ``purge_*`` / ``fetch_arxiv_fulltext``).
This module only adds what the conversation side needs: session admission, the
permission-mode gate, the destructive-operation confirmation card, idempotent
replay of ``client_op_id`` and the model-facing summary envelope.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from typing import Any

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.status import HTTP_400_BAD_REQUEST, HTTP_403_FORBIDDEN

from scholarseed_runtime.contract import RuntimePermissionMode
from service.assistant.service.literature import AssistantLiteratureService
from service.chat.api.bridge import bridge_caller, session_bridge_admission
from service.chat.runtime.live import LiveSession
from service.chat.service.artifacts import ArtifactReadError
from service.chat.service.invalidation import SCOPE_LITERATURE, announce
from service.chat.service.sessions import SessionService
from service.content.domain.model import ContentError
from service.literature.api.catalogue import (
    AVAILABLE,
    IDENTIFIER_BIBLIOGRAPHY_NAME,
    LITERATURE_NOT_FOUND,
    counts_payload,
    facets_payload,
    fetch_arxiv_fulltext,
    note_payload,
    project_scope,
    projects_payload,
    purge_attachment,
    purge_literatures,
    summarize_items,
    tag_facets_payload,
)
from service.literature.api.papermeta import resolve_timeout_seconds
from service.literature.domain.model import NOTE_NOT_FOUND, LiteratureError
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PublicationType
from service.literature.service.attachment import (
    ARXIV_ALREADY_ATTACHED,
    AttachmentConflictError,
    AttachmentFormatError,
    attach_primary_pdf,
)
from service.literature.service.bibliography import (
    BibliographyError,
    fetch_identifier_bibliography,
)
from service.literature.service.importer import LiteratureImportError, parse_import
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_CURATION_DESTRUCTIVE,
    LITERATURE_CURATION_READS,
    LITERATURE_CURATION_REQUESTS,
    LITERATURE_CURATION_ROUTES,
)
from service.platform.citations import PDF_INDEX_STATE
from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
)

CURATION_CLIP_CHARS = 512
CONFIRM_TIMEOUT_SECONDS = 120.0
CONFIRM_APPROVE = "确认执行"
CONFIRM_DENY = "取消"
CONFIRM_HEADER = "文献库操作确认"
CONFIRM_TITLES = 5
CONFIRM_PRESENTATION = "literature-curation"
USER_DENIED = "user_denied"
PERMISSION_DENIED = "permission_mode_denied"
REVISION_CONFLICT = "revision_conflict"
COLLECTION_NAME_EXISTS = "COLLECTION_NAME_EXISTS"
IDENTIFIER_ENTRY_INCOMPLETE = "identifier_entry_incomplete"
NEXT_ACTIONS = {
    LITERATURE_NOT_FOUND: "Locate ids first with literature/search or literature/list.",
    NOTE_NOT_FOUND: "Reread literature/notes for current note ids and versions.",
    REVISION_CONFLICT: "Reread the target, then retry with the returned current version.",
    COLLECTION_NAME_EXISTS: "Pick another name or reuse the existing collection id.",
    ARXIV_ALREADY_ATTACHED: (
        "A usable primary attachment (the full text) already exists and is never replaced; "
        "read it, or ask the user to delete it with literature/attachment-delete first."
    ),
    USER_DENIED: "The user refused this mutation; explain and do not retry it unchanged.",
    PERMISSION_DENIED: "This session permission mode forbids the operation; tell the user.",
}


def _clip(value: Any) -> Any:
    if isinstance(value, str) and len(value) > CURATION_CLIP_CHARS:
        return value[:CURATION_CLIP_CHARS]
    return value


def _skinny(summary: dict[str, Any]) -> dict[str, Any]:
    """Model-facing projection: identity + display fields, never the full record."""

    attachments = summary.get("attachments") or []
    return {
        "id": summary.get("id"),
        "title": _clip(summary.get("title")),
        "year": summary.get("year"),
        "creators_display": _clip(summary.get("creators_display")),
        "has_fulltext": any(
            attachment.get("role") == "primary" and attachment.get("availability") == AVAILABLE
            for attachment in attachments
        ),
        "tag_names": [entry.get("name") for entry in summary.get("tags") or []],
        "collection_names": [entry.get("name") for entry in summary.get("collections") or []],
        "version": summary.get("version"),
    }


def _item_summary(item: Any, project_id: str = "") -> dict[str, Any]:
    return _skinny(summarize_items((item,), LiteratureRepository(), {}, project_id)[0])


def _note_error(error: LiteratureError) -> HTTPException:
    if error.code == NOTE_NOT_FOUND:
        return HTTPException(status_code=404, detail={"code": error.code})
    return HTTPException(status_code=409, detail={"code": REVISION_CONFLICT, "current": str(error)})


def _affected(name: str, data: dict[str, Any]) -> tuple[list[str], int]:
    """Titles the confirmation card names; count is the affected row count."""

    repository = LiteratureRepository()
    if name == "delete":
        identifiers = tuple(data["literature_ids"])
        titles = [
            item.title
            for identifier in identifiers
            if (item := repository.get(identifier)) is not None
        ]
        return titles, len(identifiers)
    if name == "attachment-delete":
        item = repository.get(data["literature_id"])
        titles = [item.title] if item is not None else []
        return titles, 1
    if name == "tag-delete":
        entry = next((tag for tag in repository.tags() if tag["id"] == data["tag_id"]), None)
        return [str(entry["name"])] if entry else [], int(entry.get("total", 0)) if entry else 0
    entry = next(
        (
            collection
            for collection in repository.collections(data.get("project_id") or "")
            if collection["id"] == data["collection_id"]
        ),
        None,
    )
    return [str(entry["name"])] if entry else [], int(entry.get("count", 0)) if entry else 0


def _bulk_result(requested: tuple[str, ...], succeeded: tuple[str, ...]) -> dict[str, Any]:
    """批量写的统一回执: succeeded 只列真正改到的, 其余逐条给出原因。

    这几个动作过去一律回「请求里的全部 id 都成功」, 调用方 (AI) 因此会把已经删掉的
    条目当成改成功了, 后面的推理全建在假的成功面上。
    """

    hit = set(succeeded)
    return {
        "succeeded": list(succeeded),
        "failed": [
            {"id": identifier, "code": LITERATURE_NOT_FOUND}
            for identifier in dict.fromkeys(requested)
            if identifier not in hit
        ],
    }


def _execute(name: str, data: dict[str, Any], content: Any) -> dict[str, Any]:
    repository = LiteratureRepository()
    scope = project_scope(content, data.get("project_id") or "")
    if name == "counts":
        return counts_payload(repository, scope)
    if name == "facets":
        return facets_payload(repository, scope)
    if name == "tag-facets":
        return tag_facets_payload(
            repository,
            project_id=scope,
            collection_ids=tuple(data["collection_ids"]),
            recent_only=bool(data["recent"]),
        )
    if name == "projects":
        return projects_payload(content, repository)
    if name == "notes":
        notes = repository.notes(data["literature_id"])
        if notes is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return {"items": [note_payload(note) for note in notes]}
    if name == "note-add":
        try:
            note = repository.create_note(data["literature_id"], data["text"], data["title"])
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        return {"note": note_payload(note)}
    if name == "note-update":
        try:
            note = repository.update_note(
                data["literature_id"],
                data["note_id"],
                title=data["title"],
                text=data["text"],
                expected_version=data["expected_version"],
            )
        except LiteratureError as error:
            raise _note_error(error) from error
        return {"note": note_payload(note)}
    if name == "note-remove":
        if not repository.delete_note(data["literature_id"], data["note_id"]):
            raise HTTPException(status_code=404, detail={"code": NOTE_NOT_FOUND})
        return {"deleted": data["note_id"]}
    if name == "bulk-tag":
        identifiers = tuple(data["literature_ids"])
        succeeded, _ = repository.organize_tags(
            identifiers,
            tuple(str(tag) for tag in data["tags"]),
            str(data["action"]),
        )
        return _bulk_result(identifiers, succeeded)
    if name == "bulk-collection":
        identifiers = tuple(data["literature_ids"])
        succeeded = repository.associate(
            identifiers,
            project_id=scope,
            collection_ids=tuple(data["collection_ids"]),
            tag_ids=(),
        )
        return _bulk_result(identifiers, succeeded)
    if name == "bulk-project":
        identifiers = tuple(data["literature_ids"])
        if data["action"] == "link":
            succeeded, _ = repository.link_project(
                identifiers, scope, tuple(data["collection_ids"])
            )
            return _bulk_result(identifiers, succeeded)
        return _bulk_result(identifiers, repository.unlink_project(identifiers, scope))
    if name == "patch":
        fields: dict[str, Any] = {}
        for key in (
            "title",
            "subtitle",
            "authors",
            "publication",
            "published_date",
            "abstract",
            "doi",
            "arxiv",
            "isbn",
            "citation_key",
            "item_type",
        ):
            if data.get(key) is not None:
                fields[key] = data[key]
        if data.get("clear_year"):
            fields["year"] = None
        elif data.get("year") is not None:
            fields["year"] = data["year"]
        if data.get("bib_type") is not None:
            try:
                fields["bib_type"] = PublicationType(str(data["bib_type"])).value
            except ValueError as error:
                raise HTTPException(status_code=400, detail={"code": "LIBRARY_INVALID"}) from error
        collection_ids = data.get("collection_ids")
        tag_ids = data.get("tag_ids")
        try:
            item = repository.update(
                data["literature_id"],
                fields,
                tuple(collection_ids) if collection_ids is not None else None,
                tuple(tag_ids) if tag_ids is not None else None,
            )
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        if item is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        return {"item": _item_summary(item)}
    if name == "tag-create":
        return {"tag": repository.create_tag(data["name"])}
    if name == "collection-create":
        try:
            return {
                "collection": repository.create_collection(
                    data["name"], data.get("parent_id") or None, scope
                )
            }
        except LiteratureError as error:
            raise HTTPException(status_code=400, detail={"code": error.code}) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail={"code": COLLECTION_NAME_EXISTS}) from error
    if name == "tag-delete":
        result = repository.delete_tag(data["tag_id"])
        if not result["tags"]:
            raise HTTPException(status_code=404, detail={"code": "TAG_NOT_FOUND"})
        return {"deleted": data["tag_id"], **result}
    if name == "collection-delete":
        result = repository.delete_collection(data["collection_id"], scope)
        if not result["collections"]:
            raise HTTPException(status_code=404, detail={"code": "COLLECTION_NOT_FOUND"})
        return {"deleted": data["collection_id"], **result}
    raise HTTPException(status_code=400, detail={"code": "bridge_operation_unknown"})


def register_curation_bridge(
    app: FastAPI,
    sessions: SessionService,
    *,
    assistant: AssistantLiteratureService,
    activities: Activities,
) -> APIRouter:
    router = APIRouter(dependencies=[Depends(session_bridge_admission(sessions, activities))])
    #: (session_id, client_op_id) → first response; a retry replays instead of
    #: mutating twice. In-process on purpose: serve owns the turn that created it.
    replays: dict[tuple[str, str], dict[str, Any]] = {}

    async def _body(request: Request) -> bytes:
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > BRIDGE_MAX_REQUEST_BYTES:
                raise ValueError("bridge_request_too_large")
        return bytes(raw)

    def _active_scope(live: LiveSession, snapshot_id: str, turn_id: str) -> bool:
        return (
            sessions.bridge_caller(live.id) is live
            and live.active_assistant_snapshot_id == snapshot_id
            and live.ledger.active_turn_id == turn_id
        )

    async def _confirm(
        live: LiveSession, turn_id: str, name: str, titles: list[str], count: int
    ) -> bool:
        listed = "、".join(_clip(title) for title in titles[:CONFIRM_TITLES]) or "(未知条目)"
        question = {
            "id": f"literature-curation-{uuid.uuid4().hex}",
            "header": CONFIRM_HEADER,
            "presentation": {
                "kind": CONFIRM_PRESENTATION,
                "operation": name,
                "count": count,
                "titles": [_clip(title) for title in titles[:CONFIRM_TITLES]],
            },
            "question": (f"AI 请求执行破坏性操作 {name}, 影响 {count} 条: {listed}。是否允许?"),
            "options": [
                {"label": CONFIRM_APPROVE, "description": "立即执行, 不可撤销。"},
                {"label": CONFIRM_DENY, "description": "拒绝本次操作, 库保持不变。"},
            ],
        }
        decision = await live.interactions.request_product_input(
            question, turn_id=turn_id, timeout_seconds=CONFIRM_TIMEOUT_SECONDS
        )
        if decision.get("cancelled") or decision.get("timed_out"):
            return False
        answers = decision.get("answers") or {}
        chosen = str(next(iter(answers.values()), ""))
        return chosen.startswith(CONFIRM_APPROVE)

    async def _handle(name: str, request: Request) -> JSONResponse:
        live = bridge_caller(request, sessions)
        if live is None:
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        snapshot_id, turn_id = live.active_assistant_snapshot_id, live.ledger.active_turn_id
        try:
            raw = await _body(request)
            payload = LITERATURE_CURATION_REQUESTS[name].model_validate(json.loads(raw))
        except ValueError as error:
            return JSONResponse({"ok": False, "error": str(error)}, HTTP_400_BAD_REQUEST)
        if not _active_scope(live, snapshot_id, turn_id):
            return JSONResponse({"ok": False, "error": "bridge_access_denied"}, HTTP_403_FORBIDDEN)
        data = payload.model_dump()
        mode = str(getattr(live, "applied_permission_mode", "") or RuntimePermissionMode.ASK.value)
        if name not in LITERATURE_CURATION_READS and mode == RuntimePermissionMode.READ_ONLY.value:
            return JSONResponse(
                {
                    "ok": False,
                    "error": PERMISSION_DENIED,
                    "next_action": NEXT_ACTIONS[PERMISSION_DENIED],
                },
                HTTP_403_FORBIDDEN,
            )
        client_op_id = str(data.get("client_op_id") or "")
        replay_key = (live.id, client_op_id) if client_op_id else None
        if replay_key is not None and replay_key in replays:
            return JSONResponse({**replays[replay_key], "replayed": True})
        content = getattr(request.app.state, "content", None)
        pdf_indexes = getattr(request.app.state, PDF_INDEX_STATE, None)
        try:
            if name in LITERATURE_CURATION_DESTRUCTIVE:
                titles, count = await activities.to_thread(
                    ActivityDomain.BRIDGE, _affected, name, data
                )
                if mode != RuntimePermissionMode.BYPASS.value and not await _confirm(
                    live, turn_id, name, titles, count
                ):
                    result: dict[str, Any] = {
                        "ok": False,
                        "error": USER_DENIED,
                        "next_action": NEXT_ACTIONS[USER_DENIED],
                    }
                else:
                    result = {
                        "ok": True,
                        **await activities.to_thread(
                            ActivityDomain.BRIDGE,
                            _purge,
                            name,
                            data,
                            content,
                            pdf_indexes,
                        ),
                    }
            elif name == "fulltext":
                saved = await activities.to_thread(
                    ActivityDomain.BRIDGE, fetch_arxiv_fulltext, data["literature_id"]
                )
                result = {"ok": True, "item": _item_summary(saved)}
            elif name == "fulltext-attach":
                result = {"ok": True, **await _attach_fulltext(data, live, pdf_indexes)}
            elif name == "import-identifier":
                result = {"ok": True, **await _import_identifier(data, content)}
            else:
                result = {
                    "ok": True,
                    **await activities.to_thread(
                        ActivityDomain.BRIDGE, _execute, name, data, content
                    ),
                }
        except HTTPException as error:
            detail = error.detail if isinstance(error.detail, dict) else {"code": str(error.detail)}
            code = str(detail.get("code") or "literature_error")
            result = {
                "ok": False,
                "error": code,
                **({"detail": detail.get("message")} if detail.get("message") else {}),
                "next_action": NEXT_ACTIONS.get(
                    code, "Read the error code and adjust the request."
                ),
            }
        except (LiteratureError, sqlite3.IntegrityError) as error:
            code = getattr(error, "code", COLLECTION_NAME_EXISTS)
            result = {
                "ok": False,
                "error": str(code),
                "next_action": NEXT_ACTIONS.get(str(code), "Retry with corrected arguments."),
            }
        if replay_key is not None and result.get("ok"):
            replays[replay_key] = result
        # 写成功了就让界面立刻过期重取; 读操作、被用户拒绝与失败的调用都不发事件。
        # 判据取自 bridge 注册表里 READ_EFFECT 的那一组, 新增操作自动继承这个语义。
        if result.get("ok") and name not in LITERATURE_CURATION_READS:
            await announce(live, turn_id, (SCOPE_LITERATURE,))
        response = JSONResponse(result)
        if len(response.body) > BRIDGE_MAX_RESPONSE_BYTES:
            return JSONResponse(
                {"ok": False, "error": "bridge_response_too_large; narrow the scope"},
                HTTP_400_BAD_REQUEST,
            )
        return response

    async def _attach_fulltext(
        data: dict[str, Any], live: LiveSession, pdf_indexes: Any
    ) -> dict[str, Any]:
        """把一份已发布的会话 PDF 挂成这条文献的主附件。

        字节不经 bridge (请求体上限 16KB), 所以这里只解析指针: artifact 解析归 assistant
        层, 挂载与「已有可用主附件就拒绝」的不变式归附件域 owner —— 与产品上传腿
        (``POST /api/v1/literatures/{id}/attachments?primary=true``) 同一份实现。
        """

        try:
            payload, artifact_name = await activities.to_thread(
                ActivityDomain.BRIDGE,
                assistant.export_publication_bytes,
                live.id,
                live.runtime_workdir,
                artifact_id=data.get("artifact_id"),
                path=data.get("path"),
                expected_sha256=data.get("expected_sha256"),
            )
        except (ArtifactReadError, ContentError) as error:
            code = str(getattr(error, "code", "") or error)
            raise HTTPException(status_code=400, detail={"code": code}) from error
        repository = LiteratureRepository()
        item = repository.get(data["literature_id"])
        if item is None:
            raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
        try:
            attached = await activities.to_thread(
                ActivityDomain.BRIDGE,
                attach_primary_pdf,
                item,
                artifact_name,
                payload,
                pdf_indexes=pdf_indexes,
                repository=repository,
            )
        except AttachmentConflictError as error:
            raise HTTPException(status_code=409, detail={"code": error.code}) from error
        except AttachmentFormatError as error:
            raise HTTPException(status_code=422, detail={"code": error.code}) from error
        return {"item": _item_summary(attached.item)}

    async def _import_identifier(data: dict[str, Any], content: Any) -> dict[str, Any]:

        scope = project_scope(content, data.get("project_id") or "")
        try:
            text = await fetch_identifier_bibliography(
                data["identifier"], timeout=resolve_timeout_seconds()
            )
        except BibliographyError as error:
            raise HTTPException(status_code=error.status, detail={"code": error.code}) from error
        try:
            outcome = parse_import(IDENTIFIER_BIBLIOGRAPHY_NAME, text.encode("utf-8"))
        except LiteratureImportError as error:
            raise HTTPException(
                status_code=422, detail={"code": IDENTIFIER_ENTRY_INCOMPLETE}
            ) from error

        def save() -> dict[str, Any]:
            repository = LiteratureRepository()
            imported = repository.save_all(
                outcome.items,
                collection_id=data.get("collection_id") or "",
                project_id=scope,
            )
            return {"item": _item_summary(imported[0], scope)}

        return await activities.to_thread(ActivityDomain.BRIDGE, save)

    def _purge(name: str, data: dict[str, Any], content: Any, pdf_indexes: Any) -> dict[str, Any]:
        if name == "delete":
            return {"deleted": purge_literatures(tuple(data["literature_ids"]), pdf_indexes)}
        if name == "attachment-delete":
            deleted = purge_attachment(data["literature_id"], data["attachment_id"], pdf_indexes)
            if deleted is None:
                raise HTTPException(status_code=404, detail={"code": LITERATURE_NOT_FOUND})
            return {"deleted": deleted}
        return _execute(name, data, content)

    for operation in LITERATURE_CURATION_REQUESTS:
        route = LITERATURE_CURATION_ROUTES[operation]

        def make(name: str = operation):
            async def endpoint(request: Request) -> JSONResponse:
                return await _handle(name, request)

            return endpoint

        router.add_api_route(route, make(operation), methods=["POST"])

    app.include_router(router)
    return router


__all__ = ["register_curation_bridge"]
