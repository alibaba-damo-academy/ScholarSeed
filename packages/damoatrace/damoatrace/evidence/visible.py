"""Model-visible working-set evidence over trace ``context.compose`` events (02 context-ledger).

每次 compose 落一条 ``context.compose`` trace event, 记录那一次 model-call 的 model-visible
working set (attributes: snapshot_id / model_call_id / request_id / visible_index_id / used /
excluded / rendered_hash + span 指针)。本模块投影"模型这一刻看见了什么"的证据摘要:

- ``used`` / ``excluded``: 该次 compose 纳入 / 排除的 context item 计数;
- ``rendered_hash``: 组装后 wire payload 的内容 hash (可对不同 compose 判等 / 回归);
- ``visible_index_id``: 指针 —— 可解引用回 ledger ``visible_indexes.jsonl`` 取具体 item 列表。

具体可见 item 清单在 ledger store (非 trace), 本模块只到指针级 —— 与 Evidence Contract v1 一致
(结论引用指针, damoatrace 不是语义 source of truth)。事件名/attribute 键镜像
历史 context ledger 事件的 wire 契约。
"""

from __future__ import annotations

from typing import Any, Dict, List

from damoatrace.evidence.context import (
    ATTR_EXCLUDED,
    ATTR_USED,
    ATTR_VISIBLE_INDEX_ID,
    CONTEXT_KIND,
    EVENT_COMPOSE,
    _pointers,
)

ATTR_SNAPSHOT_ID = "snapshot_id"
ATTR_MODEL_CALL_ID = "model_call_id"
ATTR_REQUEST_ID = "request_id"
ATTR_RENDERED_HASH = "rendered_hash"
EVENT_INPUT_BUDGET = "model.input_budget"
ATTR_FINAL_WIRE_HASH = "final_wire_hash"
ATTR_CACHE_EPOCH_ID = "cache_epoch_id"
ATTR_UPPER_BOUND_INPUT_TOKENS = "upper_bound_input_tokens"
ATTR_SERIALIZED_BYTES = "serialized_bytes"
ATTR_WATERMARK = "watermark"
ATTR_MEDIA_OCCURRENCES = "media_occurrences"
ATTR_COUNT_SOURCE = "count_source"
ATTR_ESTIMATOR_VERSION = "estimator_version"
ATTR_CONFIDENCE = "confidence"


def _compose_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = [
        e
        for e in events
        if (e.get("kind") or "") == CONTEXT_KIND and (e.get("name") or "") == EVENT_COMPOSE
    ]
    out.sort(key=lambda e: e.get("started_at") or "")
    return out


def _snapshot_row(
    event: Dict[str, Any], budget_event: Dict[str, Any] | None = None
) -> Dict[str, Any]:
    a = event.get("attributes") or {}
    budget = (budget_event or {}).get("attributes") or {}
    return {
        "at": event.get("started_at"),
        "span_id": event.get("span_id"),
        ATTR_SNAPSHOT_ID: a.get(ATTR_SNAPSHOT_ID),
        ATTR_MODEL_CALL_ID: a.get(ATTR_MODEL_CALL_ID),
        ATTR_REQUEST_ID: a.get(ATTR_REQUEST_ID),
        ATTR_VISIBLE_INDEX_ID: a.get(ATTR_VISIBLE_INDEX_ID),
        ATTR_USED: a.get(ATTR_USED),
        ATTR_EXCLUDED: a.get(ATTR_EXCLUDED),
        ATTR_RENDERED_HASH: a.get(ATTR_RENDERED_HASH),
        ATTR_FINAL_WIRE_HASH: budget.get(ATTR_FINAL_WIRE_HASH),
        ATTR_CACHE_EPOCH_ID: budget.get(ATTR_CACHE_EPOCH_ID),
        ATTR_UPPER_BOUND_INPUT_TOKENS: budget.get(ATTR_UPPER_BOUND_INPUT_TOKENS),
        ATTR_SERIALIZED_BYTES: budget.get(ATTR_SERIALIZED_BYTES),
        ATTR_WATERMARK: budget.get(ATTR_WATERMARK),
        ATTR_MEDIA_OCCURRENCES: budget.get(ATTR_MEDIA_OCCURRENCES),
        ATTR_COUNT_SOURCE: budget.get(ATTR_COUNT_SOURCE),
        ATTR_ESTIMATOR_VERSION: budget.get(ATTR_ESTIMATOR_VERSION),
        ATTR_CONFIDENCE: budget.get(ATTR_CONFIDENCE),
        "pointers": _pointers(a),
    }


def visible_snapshots(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """每次 compose 的 model-visible working-set 摘要行 (时间线)。"""
    budgets: dict[str, Dict[str, Any]] = {}
    for event in events:
        if (event.get("kind") or "") != CONTEXT_KIND or (
            event.get("name") or ""
        ) != EVENT_INPUT_BUDGET:
            continue
        visible_index_id = str((event.get("attributes") or {}).get(ATTR_VISIBLE_INDEX_ID) or "")
        if visible_index_id:
            budgets[visible_index_id] = event
    return [
        _snapshot_row(
            event,
            budgets.get(str((event.get("attributes") or {}).get(ATTR_VISIBLE_INDEX_ID) or "")),
        )
        for event in _compose_events(events)
    ]


def visible_evidence(events: List[Dict[str, Any]], *, session_id: str = "") -> Dict[str, Any]:
    """把 context.compose 事件流投影成 per-session model-visible 证据。

    返回: {session_id, snapshots[], totals{model_calls, used_total, excluded_total}}。
    """
    snaps = visible_snapshots(events)
    used_total = sum(int(s[ATTR_USED]) for s in snaps if isinstance(s.get(ATTR_USED), (int, float)))
    excluded_total = sum(
        int(s[ATTR_EXCLUDED]) for s in snaps if isinstance(s.get(ATTR_EXCLUDED), (int, float))
    )
    return {
        "session_id": session_id,
        "snapshots": snaps,
        "totals": {
            "model_calls": len(snaps),
            "used_total": used_total,
            "excluded_total": excluded_total,
        },
    }
