"""Context-lifecycle evidence over trace ``context.*`` events (02 context-ledger; 03 compaction).

damoatrace 是 trace jsonl **wire 格式**上的只读证据层 (records.py 同философ: 按字符串 key 读 raw
event, 零 runtime 依赖)。ContextLedger (``agent/core/harness/context/ledger.py``) 每个 turn 落三类
durable trace event (顶层 ``kind == "context"``, ``name`` 区分子类):

- ``context.op``         每次账本 operation —— channel 生命周期迁移 (attributes: op_id/kind/channel/
                         items/context_span_id/trace_span_id/trace_ref/visible_index_id)。
- ``context.compose``    每次 compose —— 组装 model-visible working set (见 ``visible.py``)。
- ``context.compaction`` 每次压缩血缘 run (attributes: run_id/sources/edges/token_before/token_after)。

本模块把它们摊平成 per-session 的 context 证据, 每条都回带指针地址 (span_id / trace_ref /
visible_index_id / run_id), 结论可继续解引用回真实账本 —— 与 Trace Evidence Contract v1 一致:
damoatrace 不是语义 source of truth, 只投影已落账的 trace 证据。

事件名常量是历史 trace 的 ``TRACE_CONTEXT_*`` wire 契约; damoatrace 不
import 该重模块, 只读它落下的 jsonl。
"""

from __future__ import annotations

from typing import Any, Dict, List

# wire 契约: 镜像 ledger.TRACE_CONTEXT_KIND / TRACE_CONTEXT_OP / _COMPOSE / _COMPACTION。
CONTEXT_KIND = "context"
EVENT_OP = "context.op"
EVENT_COMPOSE = "context.compose"
EVENT_COMPACTION = "context.compaction"

# attribute keys (ledger emit_event attributes 契约)。
ATTR_OP_ID = "op_id"
ATTR_KIND = "kind"
ATTR_CHANNEL = "channel"
ATTR_ITEMS = "items"
ATTR_RUN_ID = "run_id"
ATTR_SOURCES = "sources"
ATTR_EDGES = "edges"
ATTR_TOKEN_BEFORE = "token_before"
ATTR_TOKEN_AFTER = "token_after"
ATTR_OPERATION_ID = "operation_id"
ATTR_TARGET_SCOPE = "target_scope"
ATTR_SELECTION_POLICY = "selection_policy"
ATTR_REMOVED_ITEM_REFS = "removed_item_refs"
ATTR_OUTPUT_ITEM_REFS = "output_item_refs"
ATTR_RETAINED_ITEM_REFS = "retained_item_refs"
ATTR_ITEM_TRANSITIONS = "item_transitions"
ATTR_REMOVED_ITEMS = "removed_items"
ATTR_OUTPUT_ITEMS = "output_items"
ATTR_RETAINED_ITEMS = "retained_items"
ATTR_CONTEXT_SPANS = "context_spans"
ATTR_USED = "used"
ATTR_EXCLUDED = "excluded"
ATTR_CONTEXT_SPAN_ID = "context_span_id"
ATTR_TRACE_SPAN_ID = "trace_span_id"
ATTR_TRACE_REF = "trace_ref"
ATTR_VISIBLE_INDEX_ID = "visible_index_id"


def _attrs(event: Dict[str, Any]) -> Dict[str, Any]:
    return event.get("attributes") or {}


def _name(event: Dict[str, Any]) -> str:
    return event.get("name") or ""


def context_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """从任意 event 流筛出 context.* 事件, 按 started_at 排序 (时间线证据)。"""
    ctx = [e for e in events if (e.get("kind") or "") == CONTEXT_KIND]
    ctx.sort(key=lambda e: e.get("started_at") or "")
    return ctx


def _pointers(attrs: Dict[str, Any]) -> Dict[str, Any]:
    """一条 context event 的可解引用指针 (span/trace_ref/visible_index) —— Evidence Contract 面。"""
    return {
        ATTR_CONTEXT_SPAN_ID: attrs.get(ATTR_CONTEXT_SPAN_ID),
        ATTR_TRACE_SPAN_ID: attrs.get(ATTR_TRACE_SPAN_ID),
        ATTR_TRACE_REF: attrs.get(ATTR_TRACE_REF),
    }


def _op_row(event: Dict[str, Any]) -> Dict[str, Any]:
    a = _attrs(event)
    items = a.get(ATTR_ITEMS) or []
    return {
        "at": event.get("started_at"),
        "span_id": event.get("span_id"),
        ATTR_OP_ID: a.get(ATTR_OP_ID),
        "op_kind": a.get(ATTR_KIND),
        ATTR_CHANNEL: a.get(ATTR_CHANNEL),
        "item_count": len(items) if isinstance(items, list) else 0,
        "items": list(items) if isinstance(items, list) else [],
        ATTR_VISIBLE_INDEX_ID: a.get(ATTR_VISIBLE_INDEX_ID),
        "pointers": _pointers(a),
    }


def _compaction_row(event: Dict[str, Any]) -> Dict[str, Any]:
    a = _attrs(event)
    before = a.get(ATTR_TOKEN_BEFORE)
    after = a.get(ATTR_TOKEN_AFTER)
    saved = None
    if isinstance(before, (int, float)) and isinstance(after, (int, float)):
        saved = before - after
    return {
        "at": event.get("started_at"),
        "span_id": event.get("span_id"),
        ATTR_RUN_ID: a.get(ATTR_RUN_ID),
        ATTR_OPERATION_ID: a.get(ATTR_OPERATION_ID),
        ATTR_SOURCES: a.get(ATTR_SOURCES),
        ATTR_EDGES: a.get(ATTR_EDGES),
        ATTR_TOKEN_BEFORE: before,
        ATTR_TOKEN_AFTER: after,
        ATTR_TARGET_SCOPE: a.get(ATTR_TARGET_SCOPE),
        ATTR_SELECTION_POLICY: a.get(ATTR_SELECTION_POLICY),
        ATTR_REMOVED_ITEM_REFS: a.get(ATTR_REMOVED_ITEM_REFS) or [],
        ATTR_OUTPUT_ITEM_REFS: a.get(ATTR_OUTPUT_ITEM_REFS) or [],
        ATTR_RETAINED_ITEM_REFS: a.get(ATTR_RETAINED_ITEM_REFS) or [],
        ATTR_ITEM_TRANSITIONS: a.get(ATTR_ITEM_TRANSITIONS) or [],
        ATTR_REMOVED_ITEMS: a.get(ATTR_REMOVED_ITEMS) or [],
        ATTR_OUTPUT_ITEMS: a.get(ATTR_OUTPUT_ITEMS) or [],
        ATTR_RETAINED_ITEMS: a.get(ATTR_RETAINED_ITEMS) or [],
        ATTR_CONTEXT_SPANS: a.get(ATTR_CONTEXT_SPANS) or [],
        "token_saved": saved,
        "pointers": _pointers(a),
    }


def context_evidence(events: List[Dict[str, Any]], *, session_id: str = "") -> Dict[str, Any]:
    """把 context.* 事件流投影成 per-session 证据摘要。

    返回: {session_id, ops[], compactions[], channels{channel: op_count}, op_kinds{kind: count},
    totals{ops, composes, compactions, token_saved}}。compose 的可见集摘要在 ``visible.py``。
    """
    ctx = context_events(events)
    ops: List[Dict[str, Any]] = []
    compactions: List[Dict[str, Any]] = []
    composes = 0
    channels: Dict[str, int] = {}
    op_kinds: Dict[str, int] = {}
    token_saved = 0

    for e in ctx:
        name = _name(e)
        if name == EVENT_OP:
            row = _op_row(e)
            ops.append(row)
            ch = row.get(ATTR_CHANNEL) or "?"
            channels[ch] = channels.get(ch, 0) + 1
            kind = row.get("op_kind") or "?"
            op_kinds[kind] = op_kinds.get(kind, 0) + 1
        elif name == EVENT_COMPACTION:
            row = _compaction_row(e)
            compactions.append(row)
            if isinstance(row.get("token_saved"), (int, float)):
                token_saved += int(row["token_saved"])
        elif name == EVENT_COMPOSE:
            composes += 1

    return {
        "session_id": session_id,
        "ops": ops,
        "compactions": compactions,
        "channels": channels,
        "op_kinds": op_kinds,
        "totals": {
            "ops": len(ops),
            "composes": composes,
            "compactions": len(compactions),
            "token_saved": token_saved,
        },
    }
