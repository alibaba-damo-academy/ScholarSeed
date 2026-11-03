"""AI 上下文选择、不可变快照与模型材料编排（assistant 域，开发 6 拥有）。

assistant 域是跨域编排者：保存 Session 当前选择，在 Chat Turn 准入边界冻结
不可变快照，并分别生成模型专用材料和页面安全引用。

**本域不直接读写其他域的 Store、数据库或物理文件**。资料库、文献库、
Workbench、Documents 等来源由各自业务域实现 `AssistantContextProvider`，在
应用组合根注册；Chat 只依赖 `service.platform.context` 中的协议，不反向导入
这些业务实现。

部分显式来源不可用时保留失败记录，并使用其余有效材料继续；全部材料不可用
或项目策略不支持时拒绝 Turn。不可用来源的旧正文不得进入模型材料。
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from dataclasses import asdict, replace
from pathlib import PurePath, PurePosixPath
from typing import Any, Callable, Mapping

from service.assistant.persistence.store import (
    DEFAULT_SELECTION_REVISION,
    AssistantRevisionConflictError,
    AssistantStateConflictError,
    AssistantStore,
)
from service.platform.context import (
    ASSISTANT_CONTEXT_MARKER,
    ActiveDocumentKind,
    ActiveDocumentResolver,
    AssistantCapability,
    AssistantContextBudget,
    AssistantContextFailure,
    AssistantContextFailureIssue,
    AssistantContextFailureKind,
    AssistantContextProvider,
    AssistantContextResolveRequest,
    AssistantContextSelection,
    AssistantTurnContext,
    AssistantTurnContextResult,
    AssistantTurnFinalization,
    AssistantTurnItem,
    AssistantTurnSnapshot,
    ContextAuthority,
    ContextItemRole,
    ContextLabelFallback,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    HistoryScope,
    MessageReferencePayload,
    ProjectContextPolicy,
    SearchScope,
)

ASSISTANT_CONTEXT_HEADER = ASSISTANT_CONTEXT_MARKER
ASSISTANT_CONTEXT_FOOTER = "[/SCHOLARSEED_ASSISTANT_CONTEXT]"
CURRENT_DOCUMENT_REF_PREFIX = "current_document:"
CURRENT_SELECTION_REF_PREFIX = "literature:"
CURRENT_DOCUMENT_POLICY = (
    "This document was focused when the user submitted this turn. It is not part of the "
    "user's request and its content has not been read. Use it only when the user's request "
    "refers to the currently open document; otherwise ignore it and answer normally. "
    "Explicitly named or attached sources take precedence. Read the exact locator with the "
    "matching product tool before making claims about document content. For literature "
    "read, pass the locator verbatim as ref_id and include attachment_id when present."
)
LOGGER = logging.getLogger(__name__)
SELECTION_CONTENT_LEVEL = "selection"
PDF_SELECTION_LOCATOR_KIND = "pdf"
SELECTED_MATERIAL_NOTICE = (
    "An evidence item with content_level=selection is the exact text explicitly selected "
    "by the user and is the referent of deictic questions such as 'this' or '这是什么'. "
    "Answer from its content directly when sufficient. Never inspect the session working "
    "directory or project files merely to rediscover an explicit selection. Follow the "
    "item's surrounding_context_policy only when more source context is required; do not "
    "substitute ls, find, cat, or a filesystem scan."
)
LITERATURE_SELECTION_CONTEXT_NOTICE = (
    "For surrounding pages from this project literature item, use scholarseed_bridge literature "
    "read with this item's locator."
)
PDF_SELECTION_CONTEXT_NOTICE = (
    "For surrounding context from this selected PDF, use scholarseed_bridge pdf read/search "
    "with this item's locator."
)
USER_FEEDBACK_INDEX_FIELD = "feedback_index"
INTERNAL_CONTEXT_PREFIXES = ("[SCHOLARSEED_", "[/SCHOLARSEED_")
INTERNAL_CONTEXT_BLOCKED_ANSWER = "回答包含内部上下文，已阻止展示。请重试。"
USER_FEEDBACK_NOTICE = (
    "Items with authority=user_feedback are explicit user instructions. "
    "Respond to every feedback item exactly once in ascending feedback_index order, "
    "and prefix each response with [批注 N]. If an item cannot be addressed, keep its "
    "numbered response and state both the reason and the next step; never omit or silently "
    "merge feedback items."
)


def protect_answer(markdown: str, complete: bool) -> str:
    if any(prefix in markdown for prefix in INTERNAL_CONTEXT_PREFIXES):
        return INTERNAL_CONTEXT_BLOCKED_ANSWER
    if complete:
        return markdown
    pending = max(
        (
            size
            for prefix in INTERNAL_CONTEXT_PREFIXES
            for size in range(1, len(prefix))
            if markdown.endswith(prefix[:size])
        ),
        default=0,
    )
    return markdown[:-pending] if pending else markdown


MAXIMUM_REF_LABEL_CHARS = 256
MAXIMUM_SOURCE_ID_CHARS = 2_048
# 单条和总量同时限额：避免一份长文档吃掉全部上下文，使后续引用失效。
# 截断是确定性的，同一份快照能够稳定复现模型实际读取的材料。
MAXIMUM_ITEM_CHARS = 20_000
MAXIMUM_MODEL_CONTEXT_CHARS = 60_000
DEFAULT_PROVIDER_ITEM_BUDGET = 64
CAPABILITY_UNAVAILABLE_REASON = "upstream_port_unavailable"
PROJECT_BINDING_UNAVAILABLE_REASON = "project_binding_port_unavailable"
PROVIDER_EMPTY_RESULT_REASON = "provider_returned_no_items"
CONTEXT_BUDGET_EXHAUSTED_REASON = "context_budget_exhausted"
SCOPE_INSTRUCTION = (
    "Scopes are user-authorized sources, not pre-read evidence. Use the locator and the "
    "source kind to choose the matching product tool, and inspect only what the question "
    "needs. For filesystem scopes, identify the files actually read. For literature scopes, "
    "use scholarseed_bridge literature read with the supplied literature ref locator. Do not "
    "claim an entire scope was read unless it was enumerated and inspected."
)
READABLE_CONTEXT_STATES = (ContextResolutionState.READY, ContextResolutionState.TRUNCATED)
UNAVAILABLE_MATERIAL_NOTICE = (
    "Use only readable supplied material. Explain which sources are unavailable and how "
    "this limits the answer. Never cite unavailable sources or reuse their earlier content. "
    "Do not expand the user's scope to compensate for missing material; ask for replacement "
    "material when the remaining evidence cannot answer the question."
)


class AssistantContextError(RuntimeError):
    """稳定的 Assistant 上下文准入失败基类。"""

    code = "assistant_context_error"


class AssistantContextRevisionRequiredError(AssistantContextError):
    """非默认选择必须由调用方携带 revision 明确认领。"""

    code = "assistant_context_revision_required"


class AssistantContextUnavailableError(AssistantContextError):
    """显式来源或项目策略无法解析。"""

    code = "assistant_context_unavailable"

    def __init__(self, snapshot: AssistantTurnSnapshot) -> None:
        super().__init__(self.code)
        self.snapshot = snapshot


class AssistantService:
    """持有 Assistant 状态，并作为 Chat 唯一的 Turn 上下文来源。"""

    def __init__(
        self,
        store: AssistantStore,
        *,
        project_for_session: Callable[[str], str | None] | None = None,
        providers: Mapping[ContextRefKind, AssistantContextProvider] | None = None,
        active_document_resolvers: Mapping[ContextRefKind, ActiveDocumentResolver] | None = None,
    ) -> None:
        self._store = store
        self._project_for_session = project_for_session or (lambda _session_id: None)
        self._providers = dict(providers or {})
        self._active_document_resolvers = dict(active_document_resolvers or {})

    def selection(self, session_id: str) -> AssistantContextSelection:
        return self._store.selection(session_id)

    def history_scope(self, session_id: str, snapshot_id: str) -> HistoryScope | None:
        """Read only the active turn's frozen scope, never the mutable UI selection."""

        snapshot = self._store.snapshot_by_id(session_id, snapshot_id)
        if snapshot is None:
            return None
        items = tuple(item for item in snapshot.items if item.ref.kind is ContextRefKind.SESSION)
        return HistoryScope(
            snapshot_id=snapshot.snapshot_id,
            project_id=snapshot.project_id,
            created_at=snapshot.created_at,
            refs=tuple(item.ref for item in items),
            unavailable=any(item.state not in READABLE_CONTEXT_STATES for item in items),
        )

    def history_reference_scope(
        self,
        session_id: str,
        snapshot_id: str,
        source_id: str,
    ) -> HistoryScope | None:
        """Read one session reference from its frozen turn snapshot."""

        snapshot = self._store.snapshot_by_id(session_id, snapshot_id)
        if snapshot is None:
            return None
        items = tuple(
            item
            for item in snapshot.items
            if item.ref.kind is ContextRefKind.SESSION and item.ref.source_id == source_id
        )
        if not items:
            return None
        return HistoryScope(
            snapshot_id=snapshot.snapshot_id,
            project_id=snapshot.project_id,
            created_at=snapshot.created_at,
            refs=tuple(item.ref for item in items),
            unavailable=any(item.state not in READABLE_CONTEXT_STATES for item in items),
        )

    def replace_selection(
        self,
        *,
        session_id: str,
        expected_revision: int,
        project_policy: ProjectContextPolicy,
        search_scope: SearchScope,
        refs: tuple[ContextRef, ...],
    ) -> AssistantContextSelection:
        self._validate_refs(refs)
        current = self._store.selection(session_id)
        current_notes = tuple(ref for ref in current.refs if ref.kind is ContextRefKind.NOTE)
        incoming_notes = tuple(ref for ref in refs if ref.kind is ContextRefKind.NOTE)
        if incoming_notes != current_notes:
            raise AssistantStateConflictError(
                "answer annotation refs require the annotation context endpoint"
            )
        return self._store.replace_selection(
            session_id=session_id,
            expected_revision=expected_revision,
            project_policy=project_policy,
            search_scope=search_scope,
            refs=refs,
        )

    def capabilities(self) -> tuple[AssistantCapability, ...]:
        context_capabilities = tuple(
            AssistantCapability(
                name=kind.value,
                available=kind in self._providers,
                reason="" if kind in self._providers else CAPABILITY_UNAVAILABLE_REASON,
            )
            for kind in ContextRefKind
        )
        return (
            AssistantCapability(
                name=ProjectContextPolicy.AUTO_PROJECT.value,
                available=False,
                reason=PROJECT_BINDING_UNAVAILABLE_REASON,
            ),
            AssistantCapability(name=ProjectContextPolicy.EXPLICIT_ONLY.value, available=True),
            AssistantCapability(name=SearchScope.ACADEMIC.value, available=True),
            AssistantCapability(name=SearchScope.WEB.value, available=True),
            *context_capabilities,
        )

    def freeze(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
        question: str,
        metadata_only: bool = False,
        active_document: Mapping[str, Any] | None = None,
        selected_literature_ids: tuple[str, ...] = (),
    ) -> AssistantTurnContextResult:
        try:
            return AssistantTurnContextResult(
                context=self._freeze_context(
                    session_id=session_id,
                    client_turn_id=client_turn_id,
                    expected_revision=expected_revision,
                    question=question,
                    queued=False,
                    metadata_only=metadata_only,
                    active_document=active_document,
                    selected_literature_ids=selected_literature_ids,
                )
            )
        except AssistantContextRevisionRequiredError as exc:
            latest = self._store.selection(session_id)
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.REVISION_REQUIRED,
                    detail=exc.code,
                    latest_revision=latest.revision,
                )
            )
        except AssistantRevisionConflictError as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.REVISION_CONFLICT,
                    detail="assistant_context_revision_conflict",
                    latest_revision=exc.latest.revision,
                )
            )
        except AssistantContextUnavailableError as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.UNAVAILABLE,
                    detail=exc.code,
                    latest_revision=exc.snapshot.selection_revision,
                    snapshot_id=exc.snapshot.snapshot_id,
                    issues=self._failure_issues(exc.snapshot),
                )
            )
        except (AssistantContextError, AssistantStateConflictError) as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.IDEMPOTENCY_CONFLICT,
                    detail=str(exc),
                )
            )

    def freeze_queued(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
        question: str,
        active_document: Mapping[str, Any] | None = None,
        selected_literature_ids: tuple[str, ...] = (),
    ) -> AssistantTurnContextResult:
        try:
            return AssistantTurnContextResult(
                context=self._freeze_context(
                    session_id=session_id,
                    client_turn_id=client_turn_id,
                    expected_revision=expected_revision,
                    question=question,
                    queued=True,
                    active_document=active_document,
                    selected_literature_ids=selected_literature_ids,
                )
            )
        except AssistantContextRevisionRequiredError as exc:
            latest = self._store.selection(session_id)
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.REVISION_REQUIRED,
                    detail=exc.code,
                    latest_revision=latest.revision,
                )
            )
        except AssistantRevisionConflictError as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.REVISION_CONFLICT,
                    detail="assistant_context_revision_conflict",
                    latest_revision=exc.latest.revision,
                )
            )
        except AssistantContextUnavailableError as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.UNAVAILABLE,
                    detail=exc.code,
                    latest_revision=exc.snapshot.selection_revision,
                    snapshot_id=exc.snapshot.snapshot_id,
                    issues=self._failure_issues(exc.snapshot),
                )
            )
        except (AssistantContextError, AssistantStateConflictError) as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.IDEMPOTENCY_CONFLICT,
                    detail=str(exc),
                )
            )

    def resume_queued(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        snapshot_id: str,
        question: str,
    ) -> AssistantTurnContextResult:
        try:
            snapshot = self._store.snapshot_for_turn(session_id, client_turn_id)
            if snapshot is None or snapshot.snapshot_id != snapshot_id:
                raise AssistantStateConflictError("assistant queued snapshot is unavailable")
            if snapshot.question_hash != self._question_hash(question):
                raise AssistantStateConflictError("assistant queued snapshot question changed")
            return AssistantTurnContextResult(context=self._context_from_snapshot(snapshot))
        except AssistantContextUnavailableError as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.UNAVAILABLE,
                    detail=exc.code,
                    latest_revision=exc.snapshot.selection_revision,
                    snapshot_id=exc.snapshot.snapshot_id,
                    issues=self._failure_issues(exc.snapshot),
                )
            )
        except (AssistantContextError, AssistantStateConflictError) as exc:
            return AssistantTurnContextResult(
                failure=AssistantContextFailure(
                    kind=AssistantContextFailureKind.IDEMPOTENCY_CONFLICT,
                    detail=str(exc),
                )
            )

    def finalize(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        outcome: AssistantTurnFinalization,
    ) -> AssistantContextSelection:
        if outcome in (
            AssistantTurnFinalization.ACCEPTED,
            AssistantTurnFinalization.DISCARDED,
        ):
            return self._store.consume_claim(
                session_id=session_id,
                client_turn_id=client_turn_id,
            )
        if outcome is AssistantTurnFinalization.REJECTED:
            return self._store.release_claim(
                session_id=session_id,
                client_turn_id=client_turn_id,
            )
        return self._store.selection(session_id)

    def _freeze_context(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
        question: str,
        queued: bool,
        metadata_only: bool = False,
        active_document: Mapping[str, Any] | None = None,
        selected_literature_ids: tuple[str, ...] = (),
    ) -> AssistantTurnContext:
        active_identity = self._active_identity(active_document)
        selected_ids = self._selected_literature_ids(selected_literature_ids)
        existing = self._store.snapshot_for_turn(session_id, client_turn_id)
        if existing is not None:
            question_hash = self._question_hash(question)
            revision_matches = expected_revision == existing.selection_revision or (
                expected_revision is None
                and existing.selection_revision == DEFAULT_SELECTION_REVISION
            )
            if (
                not existing.question_hash
                or existing.question_hash != question_hash
                or not revision_matches
                or self._snapshot_active_identity(existing) != active_identity
                or self._snapshot_selected_identity(existing) != selected_ids
            ):
                raise AssistantStateConflictError("assistant snapshot client turn id was reused")
            return self._context_from_snapshot(existing)

        selection = self._store.selection(session_id)
        if expected_revision is None and self._requires_revision(selection):
            raise AssistantContextRevisionRequiredError
        if expected_revision is not None and expected_revision != selection.revision:
            raise AssistantRevisionConflictError(selection)

        claim = self._store.claim_for_queued_turn if queued else self._store.claim_for_turn
        selection = claim(
            session_id=session_id,
            client_turn_id=client_turn_id,
            expected_revision=expected_revision,
        )
        try:
            project_id = self._project_for_session(session_id)
            admission_hash = self._admission_hash(
                selection,
                client_turn_id,
                question,
                metadata_only=metadata_only,
                active_identity=active_identity,
                selected_literature_ids=selected_ids,
            )
            selected_refs = tuple(
                ContextRef(
                    ref_id=f"{CURRENT_SELECTION_REF_PREFIX}{source_id}",
                    kind=ContextRefKind.LITERATURE,
                    source_id=source_id,
                    label=source_id,
                    origin=ContextOrigin.CURRENT_SELECTION,
                )
                for source_id in selected_ids
            )
            selected_selection = replace(selection, refs=selected_refs)
            items = (
                (
                    *self._metadata_items(selection),
                    *self._resolve_items(
                        selected_selection, project_id=project_id, question=question
                    ),
                )
                if metadata_only
                else self._resolve_items(
                    replace(selection, refs=(*selection.refs, *selected_refs)),
                    project_id=project_id,
                    question=question,
                )
            )
            items = tuple(
                replace(item, evidence_id=f"e_{index + 1:02d}") for index, item in enumerate(items)
            )
            active_item = self._active_item(project_id, active_identity)
            if active_item is not None:
                items = (*items, replace(active_item, evidence_id=f"e_{len(items) + 1:02d}"))
            provisional = AssistantTurnSnapshot(
                snapshot_id=uuid.uuid4().hex,
                session_id=session_id,
                client_turn_id=client_turn_id,
                selection_revision=selection.revision,
                project_id=project_id,
                project_policy=selection.project_policy,
                search_scope=selection.search_scope,
                model_card_hash="",
                admission_hash=admission_hash,
                question_hash=self._question_hash(question),
                items=items,
                created_at=time.time(),
            )
            model_context = self._render_model_card(provisional)
            snapshot = replace(
                provisional,
                model_card_hash=hashlib.sha256(model_context.encode("utf-8")).hexdigest(),
            )
            snapshot = self._store.create_snapshot(snapshot)
            model_context = self._render_model_card(snapshot)
            if (
                snapshot.model_card_hash
                != hashlib.sha256(model_context.encode("utf-8")).hexdigest()
            ):
                raise AssistantStateConflictError("assistant snapshot model card hash mismatch")
            if self._failed_snapshot(snapshot):
                raise AssistantContextUnavailableError(snapshot)
            return AssistantTurnContext(
                snapshot=snapshot,
                model_context=model_context,
                surface_refs=self._surface_refs(snapshot),
            )
        except Exception:
            self._store.release_claim(session_id=session_id, client_turn_id=client_turn_id)
            raise

    def _context_from_snapshot(
        self,
        snapshot: AssistantTurnSnapshot,
    ) -> AssistantTurnContext:
        if self._failed_snapshot(snapshot):
            raise AssistantContextUnavailableError(snapshot)
        self._store.validate_snapshot_claim(snapshot)
        model_context = self._render_model_card(snapshot)
        if snapshot.model_card_hash != hashlib.sha256(model_context.encode("utf-8")).hexdigest():
            raise AssistantStateConflictError("assistant snapshot model card hash mismatch")
        return AssistantTurnContext(
            snapshot=snapshot,
            model_context=model_context,
            surface_refs=self._surface_refs(snapshot),
        )

    @staticmethod
    def _requires_revision(selection: AssistantContextSelection) -> bool:
        return (
            selection.revision != DEFAULT_SELECTION_REVISION
            or selection.project_policy is not ProjectContextPolicy.EXPLICIT_ONLY
            or bool(selection.refs)
        )

    def _resolve_items(
        self,
        selection: AssistantContextSelection,
        *,
        project_id: str | None,
        question: str,
    ) -> tuple[AssistantTurnItem, ...]:
        resolved: list[AssistantTurnItem] = []
        remaining = MAXIMUM_MODEL_CONTEXT_CHARS
        item_budget = max(DEFAULT_PROVIDER_ITEM_BUDGET, len(selection.refs))
        for ref_index, ref in enumerate(selection.refs):
            provider = self._providers.get(ref.kind)
            if provider is None:
                resolved.append(
                    AssistantTurnItem(
                        evidence_id=f"e_{len(resolved) + 1:02d}",
                        ref=ref,
                        state=ContextResolutionState.UNAVAILABLE,
                        reason=CAPABILITY_UNAVAILABLE_REASON,
                    )
                )
                continue
            resolution = provider.resolve(
                AssistantContextResolveRequest(
                    requester_session_id=selection.session_id,
                    project_id=project_id or "",
                    question=question,
                    ref=ref,
                    budget=AssistantContextBudget(
                        max_chars=min(MAXIMUM_ITEM_CHARS, remaining),
                        # 为队列里尚未处理的每个顶层引用至少保留一个状态槽；目录等
                        # 一对多 Provider 只能使用剩余配额，不能把后续显式引用挤掉。
                        max_items=max(
                            1,
                            item_budget - len(resolved) - (len(selection.refs) - ref_index - 1),
                        ),
                    ),
                )
            )
            if not resolution.items:
                if resolution.state is ContextResolutionState.TRUNCATED:
                    resolved.append(
                        AssistantTurnItem(
                            evidence_id=f"e_{len(resolved) + 1:02d}",
                            ref=ref,
                            state=ContextResolutionState.TRUNCATED,
                            reason=CONTEXT_BUDGET_EXHAUSTED_REASON,
                        )
                    )
                    continue
                reason = (
                    resolution.issues[0].code if resolution.issues else PROVIDER_EMPTY_RESULT_REASON
                )
                state: ContextResolutionState = (
                    resolution.state
                    if resolution.state
                    not in (ContextResolutionState.READY, ContextResolutionState.TRUNCATED)
                    else ContextResolutionState.UNAVAILABLE
                )
                resolved.append(
                    AssistantTurnItem(
                        evidence_id=f"e_{len(resolved) + 1:02d}",
                        ref=ref,
                        state=state,
                        reason=reason,
                    )
                )
                continue
            for source in resolution.items:
                if len(resolved) >= item_budget:
                    break
                excerpt = (
                    source.text[: min(MAXIMUM_ITEM_CHARS, remaining)]
                    if resolution.state in READABLE_CONTEXT_STATES
                    else ""
                )
                truncated = source.truncated or len(excerpt) < len(source.text)
                state = (
                    ContextResolutionState.TRUNCATED
                    if truncated and resolution.state in READABLE_CONTEXT_STATES
                    else resolution.state
                )
                excerpt_hash = (
                    hashlib.sha256(excerpt.encode("utf-8")).hexdigest() if excerpt else ""
                )
                resolved_ref = replace(
                    ref,
                    source_revision=resolution.source_revision or source.source_revision,
                    label=source.label,
                    label_fallback=source.label_fallback,
                    selection_source_label=source.selection_source_label,
                    anchor=source.anchor or ref.anchor,
                )
                resolved.append(
                    AssistantTurnItem(
                        evidence_id=f"e_{len(resolved) + 1:02d}",
                        ref=resolved_ref,
                        state=state,
                        role=source.role,
                        model_locator=source.model_locator,
                        reason=resolution.issues[0].code if resolution.issues else "",
                        authority=source.authority,
                        surface=source.surface,
                        excerpt_text=excerpt,
                        excerpt_hash=excerpt_hash,
                        used_chars=len(excerpt),
                    )
                )
                remaining = max(0, remaining - len(excerpt))
        return tuple(resolved)

    @staticmethod
    def _metadata_items(selection: AssistantContextSelection) -> tuple[AssistantTurnItem, ...]:
        """Project selected-source identities without resolving source bytes or excerpts."""

        return tuple(
            AssistantTurnItem(
                evidence_id=f"e_{index + 1:02d}",
                ref=ref,
                state=ContextResolutionState.READY,
                role=ContextItemRole.SCOPE,
                model_locator=ref.ref_id,
                surface={"content_level": "metadata"},
            )
            for index, ref in enumerate(selection.refs)
        )

    @staticmethod
    def _failed_snapshot(snapshot: AssistantTurnSnapshot) -> bool:
        explicit_items = tuple(
            item for item in snapshot.items if item.ref.origin is not ContextOrigin.CURRENT_DOCUMENT
        )
        return snapshot.project_policy is ProjectContextPolicy.AUTO_PROJECT or (
            bool(explicit_items)
            and not any(item.state in READABLE_CONTEXT_STATES for item in explicit_items)
        )

    @staticmethod
    def _failure_issues(
        snapshot: AssistantTurnSnapshot,
    ) -> tuple[AssistantContextFailureIssue, ...]:
        return tuple(
            AssistantContextFailureIssue(
                ref_id=item.ref.ref_id,
                kind=item.ref.kind,
                label=item.ref.label,
                label_fallback=item.ref.label_fallback,
                selection_source_label=item.ref.selection_source_label,
                state=item.state,
                reason=item.reason,
            )
            for item in snapshot.items
            if item.state not in READABLE_CONTEXT_STATES
            and item.ref.origin is not ContextOrigin.CURRENT_DOCUMENT
        )

    @staticmethod
    def _render_model_card(snapshot: AssistantTurnSnapshot) -> str:
        visible_items = tuple(
            item
            for item in snapshot.items
            if item.ref.origin is not ContextOrigin.CURRENT_DOCUMENT
            or item.state in READABLE_CONTEXT_STATES
        )
        if (
            not visible_items
            and snapshot.project_policy is ProjectContextPolicy.EXPLICIT_ONLY
            and snapshot.search_scope is SearchScope.WEB
        ):
            return ""
        payload: dict[str, object] = {}
        if snapshot.search_scope is not SearchScope.WEB:
            payload["search_scope"] = snapshot.search_scope.value
        if any(item.state not in READABLE_CONTEXT_STATES for item in visible_items):
            payload["unavailable_material_policy"] = UNAVAILABLE_MATERIAL_NOTICE
        active = next(
            (item for item in snapshot.items if item.ref.origin is ContextOrigin.CURRENT_DOCUMENT),
            None,
        )
        if active is not None and active.state in READABLE_CONTEXT_STATES:
            media_type = str(active.surface.get("media_type", ""))
            attachment_id = str(active.surface.get("attachment_id", ""))
            payload["current_document_policy"] = CURRENT_DOCUMENT_POLICY
            payload["current_document"] = {
                "kind": active.surface.get("kind"),
                "name": active.ref.label,
                "attachment_name": active.surface.get("attachment_name") or None,
                "locator": active.model_locator,
                "media_type": media_type,
                "attachment_id": attachment_id or None,
                "read_tool": (
                    "scholarseed_bridge literature read"
                    if active.ref.kind is ContextRefKind.LITERATURE
                    else (
                        "scholarseed_bridge pdf read/search"
                        if media_type == "application/pdf"
                        else "scholarseed_bridge resource read"
                    )
                ),
                "pdf_ref_id": (
                    active.ref.ref_id
                    if active.ref.kind is ContextRefKind.FILE and media_type == "application/pdf"
                    else None
                ),
            }
        scopes = [
            item
            for item in snapshot.items
            if item.role is ContextItemRole.SCOPE
            and item.ref.origin is not ContextOrigin.CURRENT_DOCUMENT
        ]
        if scopes:
            payload["scope_policy"] = SCOPE_INSTRUCTION
            payload["scopes"] = [
                {
                    "scope_id": item.evidence_id,
                    "kind": item.ref.kind.value,
                    "source_id": item.ref.source_id,
                    **(
                        {}
                        if item.ref.origin is ContextOrigin.CURRENT_SELECTION
                        else {"source_revision": item.ref.source_revision}
                    ),
                    "label": item.ref.label,
                    "state": item.state.value,
                    "reason": item.reason,
                    "locator": (
                        item.model_locator if item.state in READABLE_CONTEXT_STATES else ""
                    ),
                }
                for item in scopes
            ]
        evidence: list[dict[str, object]] = []
        has_selected_material = False
        feedback_index = 0
        for item in snapshot.items:
            if item.role is not ContextItemRole.MATERIAL:
                continue
            rendered: dict[str, object] = {
                "evidence_id": item.evidence_id,
                "kind": item.ref.kind.value,
                "source_id": item.ref.source_id,
                "source_revision": item.ref.source_revision,
                "label": item.ref.label,
                "state": item.state.value,
                "reason": item.reason,
                "authority": item.authority.value,
                # 正文是 JSON string，而不是可伪造的自定义闭合标签；来源里即使
                # 出现 [/evidence] 或 Assistant footer 也无法改变结构边界。
                "content": item.excerpt_text if item.state in READABLE_CONTEXT_STATES else "",
            }
            if item.ref.project_id:
                rendered["project_id"] = item.ref.project_id
                rendered["read_tool"] = "scholarseed_bridge resource read"
                rendered["read_request"] = {
                    "project_id": item.ref.project_id,
                    "path": item.ref.source_id,
                }
            if item.authority is ContextAuthority.USER_FEEDBACK:
                feedback_index += 1
                rendered[USER_FEEDBACK_INDEX_FIELD] = feedback_index
            if item.ref.anchor is not None:
                has_selected_material = True
                rendered["content_level"] = SELECTION_CONTENT_LEVEL
                if item.model_locator:
                    rendered["locator"] = item.model_locator
                if (
                    item.ref.kind is ContextRefKind.LITERATURE
                    and snapshot.project_id
                    and item.ref.anchor.locator.get("kind") == PDF_SELECTION_LOCATOR_KIND
                ):
                    rendered["surrounding_context_policy"] = LITERATURE_SELECTION_CONTEXT_NOTICE
                elif item.ref.anchor.locator.get("kind") == PDF_SELECTION_LOCATOR_KIND:
                    rendered["surrounding_context_policy"] = PDF_SELECTION_CONTEXT_NOTICE
                page = item.ref.anchor.locator.get("page")
                if isinstance(page, int) and not isinstance(page, bool):
                    rendered["page"] = page
            evidence.append(rendered)
        if evidence:
            payload["evidence"] = evidence
        if has_selected_material:
            payload["selected_material_policy"] = SELECTED_MATERIAL_NOTICE
        if feedback_index:
            payload["user_feedback_policy"] = USER_FEEDBACK_NOTICE
        return "\n".join(
            (
                ASSISTANT_CONTEXT_HEADER,
                json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                ASSISTANT_CONTEXT_FOOTER,
            )
        )

    @staticmethod
    def _surface_refs(snapshot: AssistantTurnSnapshot) -> tuple[MessageReferencePayload, ...]:
        refs: list[MessageReferencePayload] = []
        projected_ref_ids: set[str] = set()
        for item in snapshot.items:
            if item.ref.origin in (ContextOrigin.CURRENT_DOCUMENT, ContextOrigin.CURRENT_SELECTION):
                continue
            # A provider may resolve one user selection into many evidence items
            # (a directory is the common case).  The chat surface represents the
            # user's selection, not that internal expansion.
            if item.ref.ref_id in projected_ref_ids:
                continue
            projected_ref_ids.add(item.ref.ref_id)
            title = (
                PurePosixPath(item.ref.source_id).name
                if item.ref.kind is ContextRefKind.DIR
                else item.ref.label
            )
            refs.append(
                {
                    "type": "assistant_context",
                    # Chat 的通用用户消息引用投影消费 id/title/status；同时保留
                    # Assistant 自己的结构化字段，供溯源和恢复检查使用。
                    "id": item.evidence_id,
                    "title": title or item.ref.label,
                    "status": item.state.value,
                    "snapshot_id": snapshot.snapshot_id,
                    "evidence_id": item.evidence_id,
                    "kind": item.ref.kind.value,
                    "source_id": item.ref.source_id,
                    "source_revision": item.ref.source_revision,
                    **({"project_id": item.ref.project_id} if item.ref.project_id else {}),
                    "label": item.ref.label,
                    "label_fallback": item.ref.label_fallback,
                    "selection_source_label": item.ref.selection_source_label,
                    "ref_id": item.ref.ref_id,
                    "state": item.state.value,
                    "reason": item.reason,
                    "retention": item.ref.retention.value,
                    "origin": item.ref.origin.value,
                    "anchor": asdict(item.ref.anchor) if item.ref.anchor is not None else None,
                    "surface": dict(item.surface),
                }
            )
        return tuple(refs)

    @staticmethod
    def _active_identity(
        value: Mapping[str, Any] | None,
    ) -> tuple[ActiveDocumentKind, str, str] | None:
        if not isinstance(value, Mapping):
            return None
        try:
            kind = ActiveDocumentKind(value.get("kind"))
        except (TypeError, ValueError):
            return None
        source_id = value.get(
            "path" if kind is ActiveDocumentKind.PROJECT_FILE else "literature_id"
        )
        attachment_id = value.get("attachment_id", "")
        if (
            not isinstance(source_id, str)
            or not source_id
            or len(source_id) > MAXIMUM_SOURCE_ID_CHARS
            or not isinstance(attachment_id, str)
            or len(attachment_id) > MAXIMUM_SOURCE_ID_CHARS
            or (kind is ActiveDocumentKind.LITERATURE and not attachment_id)
            or (kind is ActiveDocumentKind.PROJECT_FILE and attachment_id)
        ):
            return None
        return kind, source_id, attachment_id

    @staticmethod
    def _snapshot_active_identity(
        snapshot: AssistantTurnSnapshot,
    ) -> tuple[ActiveDocumentKind, str, str] | None:
        item = next(
            (
                candidate
                for candidate in snapshot.items
                if candidate.ref.origin is ContextOrigin.CURRENT_DOCUMENT
            ),
            None,
        )
        if item is None:
            return None
        return (
            ActiveDocumentKind(str(item.surface["kind"])),
            item.ref.source_id,
            str(item.surface.get("attachment_id", "")),
        )

    @staticmethod
    def _selected_literature_ids(value: tuple[str, ...]) -> tuple[str, ...]:
        if not isinstance(value, (tuple, list)):
            raise AssistantContextError("invalid selected literature")
        if any(
            not isinstance(item, str) or not item or len(item) > MAXIMUM_SOURCE_ID_CHARS
            for item in value
        ):
            raise AssistantContextError("invalid selected literature")
        return tuple(dict.fromkeys(value))

    @staticmethod
    def _snapshot_selected_identity(snapshot: AssistantTurnSnapshot) -> tuple[str, ...]:
        return tuple(
            item.ref.source_id
            for item in snapshot.items
            if item.ref.origin is ContextOrigin.CURRENT_SELECTION
        )

    def _active_item(
        self,
        project_id: str | None,
        identity: tuple[ActiveDocumentKind, str, str] | None,
    ) -> AssistantTurnItem | None:
        if identity is None:
            return None
        kind, source_id, attachment_id = identity
        ref_kind = (
            ContextRefKind.FILE
            if kind is ActiveDocumentKind.PROJECT_FILE
            else ContextRefKind.LITERATURE
        )
        resolver = self._active_document_resolvers.get(ref_kind)
        resolved = None
        reason = "active_document_unavailable"
        if kind is ActiveDocumentKind.PROJECT_FILE and not project_id:
            reason = "active_document_project_required"
        elif resolver is not None:
            try:
                resolved = resolver.resolve_active_document(
                    project_id or "", source_id, attachment_id
                )
            except Exception as error:
                LOGGER.warning(
                    "active_document_unavailable kind=%s reason=%s",
                    kind.value,
                    type(error).__name__,
                    exc_info=True,
                )
        if resolved is None:
            LOGGER.info("active_document_ignored kind=%s reason=%s", kind.value, reason)
        ref_id = (
            CURRENT_DOCUMENT_REF_PREFIX
            + hashlib.sha256(
                f"{kind.value}\0{source_id}\0{attachment_id}".encode("utf-8")
            ).hexdigest()
        )
        return AssistantTurnItem(
            evidence_id="",
            ref=ContextRef(
                ref_id=ref_id,
                kind=ref_kind,
                source_id=source_id,
                label=resolved.label if resolved is not None else "",
                source_revision=resolved.source_revision if resolved is not None else "",
                retention=ContextRetention.NEXT_TURN,
                origin=ContextOrigin.CURRENT_DOCUMENT,
            ),
            state=(
                ContextResolutionState.READY
                if resolved is not None
                else ContextResolutionState.UNAVAILABLE
            ),
            role=ContextItemRole.SCOPE,
            model_locator=resolved.locator if resolved is not None else "",
            reason="" if resolved is not None else reason,
            surface={
                "kind": kind.value,
                "attachment_id": attachment_id,
                "attachment_name": resolved.attachment_name if resolved is not None else "",
                "media_type": resolved.media_type if resolved is not None else "",
            },
        )

    @staticmethod
    def _admission_hash(
        selection: AssistantContextSelection,
        client_turn_id: str,
        question: str,
        *,
        metadata_only: bool = False,
        active_identity: tuple[ActiveDocumentKind, str, str] | None = None,
        selected_literature_ids: tuple[str, ...] = (),
    ) -> str:
        payload = {
            "client_turn_id": client_turn_id,
            "question_hash": hashlib.sha256(question.encode("utf-8")).hexdigest(),
            "revision": selection.revision,
            "project_policy": selection.project_policy.value,
            "search_scope": selection.search_scope.value,
            "refs": [
                {
                    key: value
                    for key, value in asdict(ref).items()
                    if key not in ("label_fallback", "selection_source_label")
                    and (key != "project_id" or value is not None)
                }
                for ref in selection.refs
            ],
        }
        if metadata_only:
            payload["metadata_only"] = True
        if active_identity is not None:
            payload["active_document"] = (
                active_identity[0].value,
                active_identity[1],
                active_identity[2],
            )
        if selected_literature_ids:
            payload["selected_literature_ids"] = selected_literature_ids
        encoded = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    @staticmethod
    def _question_hash(question: str) -> str:
        return hashlib.sha256(question.encode("utf-8")).hexdigest()

    @staticmethod
    def _validate_refs(refs: tuple[ContextRef, ...]) -> None:
        seen: set[str] = set()
        for ref in refs:
            if not ref.ref_id or ref.ref_id in seen:
                raise ValueError("assistant context ref id must be non-empty and unique")
            seen.add(ref.ref_id)
            if ref.project_id is not None and (
                not ref.project_id.strip()
                or ref.kind is not ContextRefKind.FILE
                or ref.origin is not ContextOrigin.EXPLICIT
                or ref.anchor is not None
                or PurePosixPath(ref.source_id).is_absolute()
                or "\\" in ref.source_id
            ):
                raise ValueError("project-scoped context requires an explicit relative file")
            if not ref.source_id or len(ref.source_id) > MAXIMUM_SOURCE_ID_CHARS:
                raise ValueError("assistant context source id is invalid")
            if ref.label_fallback is not None and not isinstance(
                ref.label_fallback, ContextLabelFallback
            ):
                raise ValueError("assistant label fallback is invalid")
            if ref.label_fallback is not None and ref.kind is not ContextRefKind.SESSION:
                raise ValueError("assistant label fallback requires a session reference")
            if ref.selection_source_label is not None and (
                not isinstance(ref.selection_source_label, str)
                or ref.kind not in (ContextRefKind.SELECTION, ContextRefKind.LITERATURE)
                or ref.anchor is None
            ):
                raise ValueError(
                    "assistant selection source label requires an anchored selection or literature reference"
                )
            if not ref.label or len(ref.label) > MAXIMUM_REF_LABEL_CHARS:
                raise ValueError("assistant context ref label is invalid")
            if ref.kind in (
                ContextRefKind.FILE,
                ContextRefKind.DIR,
                ContextRefKind.RESOURCE,
            ):
                source = PurePosixPath(ref.source_id)
                absolute = source.is_absolute() or PurePath(ref.source_id).is_absolute()
                if ".." in source.parts or (absolute and ref.kind is not ContextRefKind.FILE):
                    raise ValueError("assistant file source id must be project-relative")


__all__ = [
    "AssistantContextError",
    "AssistantContextRevisionRequiredError",
    "AssistantContextUnavailableError",
    "AssistantService",
]
