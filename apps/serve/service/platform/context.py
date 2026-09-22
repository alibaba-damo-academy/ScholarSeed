"""AI 上下文的公共契约 (开发 6 拥有)。

架构文档 §2.2 把 `service.assistant` 定为跨域编排者: 它解析上下文、切检索源、
做溯源, 但**不直接读写其他域的数据库或文件**。本文件定义它与其他域之间的
两个方向:

- `AssistantTurnContextSource`: assistant 向外提供, 供 `service.chat` 在 Turn
  准入边界冻结上下文。chat 只依赖这个协议, 不反向 import 资料库、文献库、
  Workbench 或 Documents 的实现。
- policy / scope / ref / snapshot / failure: 前后端与 Service 各域共享的结构化形状。

`ContextRef` 与页面投影**不携带绝对路径**仍是本文件的硬约定 (架构文档 §2.3):
它们只带稳定 ID (项目内相对路径 / 资料或文献条目 id / 会话 id)。来源域可以在
模型专用快照中返回已校验的运行时 locator，供 Agent 按需使用；该 locator 不得投影
到 renderer。

同一不可变快照分别生成模型专用材料和页面安全引用, 二者不能混用；否则 Codex
恢复历史时会把内部上下文显示进用户气泡。

本文件零业务逻辑: 仅 Protocol + frozen dataclass + Enum。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol, TypedDict, runtime_checkable

ASSISTANT_CONTEXT_MARKER = "[SCHOLARSEED_ASSISTANT_CONTEXT v1]"
ASSISTANT_ANSWER_ID_PREFIX = "answer:"
SHA256_REVISION_PREFIX = "sha256:"


class ProjectContextPolicy(str, Enum):
    """项目上下文策略；与论文/网页检索范围相互独立。"""

    AUTO_PROJECT = "auto_project"
    EXPLICIT_ONLY = "explicit_only"


class SearchScope(str, Enum):
    """外部检索范围，不再把当前项目混进同一个三选一枚举。"""

    DISABLED = "disabled"
    ACADEMIC = "academic"
    WEB = "web"


class ContextRefKind(str, Enum):
    """上下文附加项的种类 (PRD「上下文附加」)。"""

    FILE = "file"
    DIR = "dir"
    RESOURCE = "resource"
    LITERATURE = "literature"
    LITERATURE_COLLECTION = "literature_collection"
    SESSION = "session"
    SELECTION = "selection"
    NOTE = "note"


class ContextLabelFallback(str, Enum):
    """Application-generated labels; not translated content or business identity."""

    UNTITLED_SESSION = "untitled_session"
    NEW_SESSION = "new_session"


class ContextRetention(str, Enum):
    """一条显式引用在成功发送后的保留方式。"""

    SESSION = "session"
    NEXT_TURN = "next_turn"


class ContextOrigin(str, Enum):
    """引用由用户、当前文档还是自动检索产生。"""

    EXPLICIT = "explicit"
    CURRENT_DOCUMENT = "current_document"
    IMPLICIT_RETRIEVAL = "implicit_retrieval"


class ContextAuthority(str, Enum):
    """模型材料的语义权威；用户反馈不得按外部来源降级。"""

    SOURCE_MATERIAL = "source_material"
    USER_FEEDBACK = "user_feedback"


class ContextItemRole(str, Enum):
    """解析项在模型上下文中的职责。"""

    MATERIAL = "material"
    SCOPE = "scope"


class ProductTaskType(str, Enum):
    """Structured product task identities admitted before model context is frozen."""

    RESEARCH_IDEA = "research_idea"
    PRECISE_SEARCH = "precise_search"
    LITERATURE_REVIEW = "literature_review"


class ContextResolutionState(str, Enum):
    """一条显式来源在快照时的解析结果；失败不能吞成空文本。"""

    READY = "ready"
    TRUNCATED = "truncated"
    STALE = "stale"
    MISSING = "missing"
    FORBIDDEN = "forbidden"
    UNSUPPORTED = "unsupported"
    UNAVAILABLE = "unavailable"
    TOO_LARGE = "too_large"


class AssistantContextFailureKind(str, Enum):
    """Assistant/Chat 接缝返回的稳定 Turn 准入失败类型。"""

    REVISION_REQUIRED = "revision_required"
    REVISION_CONFLICT = "revision_conflict"
    UNAVAILABLE = "unavailable"
    IDEMPOTENCY_CONFLICT = "idempotency_conflict"


class AssistantTurnFinalization(str, Enum):
    """Chat 对已冻结引用给出的确定性执行结果。"""

    ACCEPTED = "accepted"
    DISCARDED = "discarded"
    REJECTED = "rejected"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class SelectionAnchor:
    """Workbench/Viewer 产生的版本化选区锚点 (架构文档 §3.4)。

    PDF 页码和 Markdown UTF-16 区间复用同一个形状，避免 assistant 按文件类型
    硬编码分支。`preview_text` 只用于页面展示，不能充当模型事实源。
    """

    locator: Mapping[str, Any]
    selected_text_hash: str
    preview_text: str = ""
    document_id: str | None = None


@dataclass(frozen=True)
class ContextRef:
    """Session 选择中的一条结构化上下文引用。

    `source_id` 的含义随 `kind` 而定，但**永远是稳定 ID 而非绝对路径**：
    FILE/DIR → 项目内相对路径；LITERATURE → 条目 id；SESSION → 会话 id。
    待发送的普通 FILE 按 source_id 读取最新版；冻结后的 source_revision
    记录本轮实际读取的版本。精确锚点仍用版本校验来源变化。
    """

    ref_id: str
    kind: ContextRefKind
    source_id: str
    label: str
    source_revision: str | None = None
    anchor: SelectionAnchor | None = None
    retention: ContextRetention = ContextRetention.SESSION
    origin: ContextOrigin = ContextOrigin.EXPLICIT
    label_fallback: ContextLabelFallback | None = None
    selection_source_label: str | None = None


@dataclass(frozen=True)
class AssistantContextBudget:
    """来源 Provider 必须服从的单次解析预算。"""

    max_chars: int
    max_items: int


@dataclass(frozen=True)
class AssistantContextResolveRequest:
    """Assistant 在完成 Session → Project 绑定后交给来源域的请求。"""

    requester_session_id: str
    project_id: str
    question: str
    ref: ContextRef
    budget: AssistantContextBudget


@dataclass(frozen=True)
class AssistantContextResolvedItem:
    """来源域同一次观察返回的一条材料或可检索范围。"""

    item_id: str
    source_id: str
    label: str
    source_revision: str
    text: str
    role: ContextItemRole = ContextItemRole.MATERIAL
    model_locator: str = ""
    authority: ContextAuthority = ContextAuthority.SOURCE_MATERIAL
    surface: Mapping[str, Any] = field(default_factory=dict)
    content_hash: str = ""
    media_type: str = ""
    content_level: str = "fulltext"
    anchor: SelectionAnchor | None = None
    truncated: bool = False
    label_fallback: ContextLabelFallback | None = None
    selection_source_label: str | None = None


@dataclass(frozen=True)
class AssistantContextIssue:
    """不含正文、可安全记录和展示的来源问题。"""

    code: str
    detail: str = ""


@dataclass(frozen=True)
class AssistantContextResolution:
    """来源 Provider 的一对多解析结果。"""

    state: ContextResolutionState
    provider_version: str
    source_revision: str = ""
    items: tuple[AssistantContextResolvedItem, ...] = field(default_factory=tuple)
    issues: tuple[AssistantContextIssue, ...] = field(default_factory=tuple)


@runtime_checkable
class AssistantContextProvider(Protocol):
    """由来源域实现并在产品组合根注册的唯一解析端口。"""

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution: ...


@dataclass(frozen=True)
class AssistantContextSelection:
    """Session 当前可变选择；`revision` 通过 CAS 单调递增。"""

    session_id: str
    revision: int
    project_policy: ProjectContextPolicy
    search_scope: SearchScope
    refs: tuple[ContextRef, ...] = field(default_factory=tuple)
    updated_at: float = 0.0


@dataclass(frozen=True)
class AssistantCapability:
    """向 Desktop 暴露的一项来源或策略能力及不可用原因。"""

    name: str
    available: bool
    reason: str = ""


@dataclass(frozen=True)
class AssistantTurnItem:
    """Turn 快照中的一条不可变材料或范围解析结果。"""

    evidence_id: str
    ref: ContextRef
    state: ContextResolutionState
    role: ContextItemRole = ContextItemRole.MATERIAL
    model_locator: str = ""
    authority: ContextAuthority = ContextAuthority.SOURCE_MATERIAL
    surface: Mapping[str, Any] = field(default_factory=dict)
    excerpt_text: str = ""
    excerpt_hash: str = ""
    used_chars: int = 0
    reason: str = ""


@dataclass(frozen=True)
class AssistantTurnSnapshot:
    """为一次 client turn 冻结的不可变上下文证据快照。"""

    snapshot_id: str
    session_id: str
    client_turn_id: str
    selection_revision: int
    project_id: str | None
    project_policy: ProjectContextPolicy
    search_scope: SearchScope
    model_card_hash: str
    admission_hash: str
    question_hash: str = ""
    items: tuple[AssistantTurnItem, ...] = field(default_factory=tuple)
    created_at: float = 0.0


class MessageReferencePayload(TypedDict, total=False):
    """用户消息引用的服务端权威投影。

    生产者是 assistant 域 (`_surface_refs`), 消费者是 chat 域的 Turn 准入边界,
    所以契约放在共享层 —— 放在任一侧都会让另一侧退化成 `Mapping[str, Any]`,
    静态保证随之消失。

    `total=False`: 不同来源域只填自己有的键。
    """

    type: str
    id: str
    title: str
    status: str
    path: str
    media_type: str
    sha256: str
    size: int
    reference_id: str
    origin: str
    snapshot_id: str
    evidence_id: str
    kind: str
    source_id: str
    source_revision: str | None
    label: str
    ref_id: str
    state: str
    retention: str
    reason: str
    anchor: dict[str, Any] | None
    surface: dict[str, Any]
    label_fallback: ContextLabelFallback | None
    selection_source_label: str | None


@dataclass(frozen=True)
class AssistantTurnContext:
    """Assistant 交给 Chat 准入边界的模型投影与页面安全投影。"""

    snapshot: AssistantTurnSnapshot
    model_context: str
    surface_refs: tuple[MessageReferencePayload, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class AssistantContextFailureIssue:
    """Safe per-reference cause returned when Turn context cannot be admitted."""

    ref_id: str
    kind: ContextRefKind
    label: str
    state: ContextResolutionState
    reason: str
    label_fallback: ContextLabelFallback | None = None
    selection_source_label: str | None = None


@dataclass(frozen=True)
class AssistantContextFailure:
    """阻止产品事件落盘和 Agent 执行的类型化失败。"""

    kind: AssistantContextFailureKind
    detail: str
    latest_revision: int | None = None
    snapshot_id: str | None = None
    issues: tuple[AssistantContextFailureIssue, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class AssistantTurnContextResult:
    """`context` 与 `failure` 必须且只能存在一个。"""

    context: AssistantTurnContext | None = None
    failure: AssistantContextFailure | None = None


@dataclass(frozen=True)
class AssistantAnswer:
    """Chat 提供的已完成、可稳定寻址的产品回答。"""

    answer_id: str
    session_id: str
    turn_id: str
    source_product_seq: int
    vendor_item_id: str | None
    markdown: str
    revision: str
    completed_at: float


@runtime_checkable
class AssistantAnswerSource(Protocol):
    """按产品回答身份读取权威最终文本；不可标注时返回 ``None``。"""

    def answer(self, *, session_id: str, answer_id: str) -> AssistantAnswer | None: ...


@dataclass(frozen=True)
class HistoryScope:
    """Frozen reference selection or project boundary, never filesystem coordinates."""

    snapshot_id: str
    project_id: str | None
    created_at: float
    refs: tuple[ContextRef, ...] = ()
    unavailable: bool = False


class HistoryScopeSource(Protocol):
    """Resolve history scope from a frozen product snapshot, not mutable UI state."""

    def history_scope(self, session_id: str, snapshot_id: str) -> HistoryScope | None: ...


@runtime_checkable
class AssistantTurnContextSource(Protocol):
    """在产品事件和 Agent Turn 之前冻结一个 Session 的上下文选择。"""

    def freeze(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
        question: str,
        metadata_only: bool = False,
    ) -> AssistantTurnContextResult: ...

    def freeze_queued(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        expected_revision: int | None,
        question: str,
    ) -> AssistantTurnContextResult:
        """Freeze only context available to this queued turn."""

        ...

    def resume_queued(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        snapshot_id: str,
        question: str,
    ) -> AssistantTurnContextResult:
        """Replay a queued turn's immutable snapshot after selection revisions move."""

        ...

    def finalize(
        self,
        *,
        session_id: str,
        client_turn_id: str,
        outcome: AssistantTurnFinalization,
    ) -> AssistantContextSelection: ...


__all__ = [
    "ASSISTANT_ANSWER_ID_PREFIX",
    "AssistantCapability",
    "AssistantAnswer",
    "AssistantAnswerSource",
    "ASSISTANT_CONTEXT_MARKER",
    "AssistantContextBudget",
    "AssistantContextFailure",
    "AssistantContextFailureIssue",
    "AssistantContextFailureKind",
    "AssistantContextIssue",
    "AssistantContextProvider",
    "AssistantContextResolution",
    "AssistantContextResolvedItem",
    "AssistantContextResolveRequest",
    "AssistantContextSelection",
    "AssistantTurnContext",
    "AssistantTurnContextSource",
    "AssistantTurnContextResult",
    "AssistantTurnItem",
    "AssistantTurnSnapshot",
    "AssistantTurnFinalization",
    "ContextOrigin",
    "ContextAuthority",
    "ContextItemRole",
    "ContextRef",
    "ContextRefKind",
    "ContextLabelFallback",
    "ContextRetention",
    "ContextResolutionState",
    "HistoryScope",
    "HistoryScopeSource",
    "ProjectContextPolicy",
    "ProductTaskType",
    "SearchScope",
    "SHA256_REVISION_PREFIX",
    "SelectionAnchor",
]
