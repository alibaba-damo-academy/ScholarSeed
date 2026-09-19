"""Trace Evidence Contract — normalized 读模型 (proposal 26 §5.0).

trace 的 source of truth 是 append-only jsonl, 但同一条 event 的"成败/错误分类/通道/指针"
在不同消费面 (TraceQuery / tracekit CLI / server / bench) 曾各算各的, 口径漂移
(典型: `run.outcome` 顶层 status 恒为 "ok", 真实成败在 attributes.status —— 旧口径会漏统计)。

本模块是 trace 系统**内部**共享的纯函数规范化层 (实现 ABI):
- CLI / UI / bench 对同一条 event 必须得出同一个 status / error_class / channel / span_pointer;
- 它不是 Reviewer/evolve agent 的依赖 —— agent 侧的稳定协议只有 CLI 的 JSON stdout (envelope)。

全部函数对 **dict (raw jsonl) 和 TraceEvent dataclass 双形态** 鸭子类型兼容, 零外部依赖。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

# CLI JSON envelope 版本号 (字段只增不删; 破坏性变更必须 bump)
CONTRACT_VERSION = 1

_OK_STATUSES = ("ok", "success", "cancelled")


# ─────────────────────── 取值基元 (dict / dataclass 双形态) ───────────────────────


def _get(e: Any, key: str, default: Any = None) -> Any:
    if isinstance(e, dict):
        return e.get(key, default)
    return getattr(e, key, default)


def _attrs(e: Any) -> Dict[str, Any]:
    return _get(e, "attributes") or {}


def _error(e: Any) -> Any:
    """event 的 error 字段: dict / TraceError / None."""
    return _get(e, "error")


def _error_field(err: Any, key: str) -> Any:
    if err is None:
        return None
    if isinstance(err, dict):
        return err.get(key)
    return getattr(err, key, None)


# ─────────────────────── status 口径 ───────────────────────


def event_status(e: Any) -> str:
    """event 顶层 status 的原始状态 (ok/error/cancelled), 不混同 run outcome."""
    return _get(e, "status") or "ok"


def run_status(e: Any) -> Optional[str]:
    """kind=="run.outcome" 时读 attributes.status (归一: success→ok); 否则 None."""
    if (_get(e, "kind") or "") != "run.outcome":
        return None
    s = _attrs(e).get("status")
    if s is None:
        return None
    return "ok" if str(s) == "success" else str(s)


def effective_status(e: Any) -> str:
    """统一展示/过滤口径: run.outcome 看 attributes.status, 其余看顶层 status."""
    return run_status(e) or event_status(e)


def is_failed_event(e: Any) -> bool:
    """event 顶层视角的失败 (cancelled 是中性终态, 不进入 failure 聚合)."""
    return event_status(e) not in _OK_STATUSES or _error(e) is not None


def is_failed_run(e: Any) -> bool:
    """run 级失败: kind=="run.outcome" 且 attributes.status 非 success/ok."""
    if (_get(e, "kind") or "") != "run.outcome":
        return False
    s = _attrs(e).get("status")
    return s is not None and str(s) not in _OK_STATUSES


def is_failed(e: Any) -> bool:
    """统一失败判定: run.outcome 看 attributes (顶层恒 ok 会骗人), 其余看顶层."""
    if (_get(e, "kind") or "") == "run.outcome":
        return is_failed_run(e)
    return is_failed_event(e)


# ─────────────────────── error_class 口径 ───────────────────────


def error_class_of(e: Any) -> str:
    """四桶分类的统一读取: e.error.error_class > attributes.error_class > "_unknown".

    注意: 只对"失败的 event"有意义; 过滤时应配合 is_failed() 使用,
    否则 "_unknown" 会吸入全部正常 event。
    """
    ec = (
        _error_field(_error(e), "error_class")
        or _error_field(_error(e), "class")
        or _error_field(_error(e), "code")
    )
    if ec:
        return str(ec)
    ec = _attrs(e).get("error_class")
    if ec:
        return str(ec)
    return "_unknown"


# ─────────────────────── 指针 / 通道 / 内容引用 ───────────────────────


def span_pointer(
    e: Any, *, trace_file: Optional[str] = None, event_index: Optional[int] = None
) -> Dict[str, Any]:
    """可重放证据指针: 任何聚合结论都必须能由它查回原文 (`span <id>`)."""
    out: Dict[str, Any] = {
        "span_id": _get(e, "span_id") or "",
        "task_run_id": _get(e, "task_run_id") or "",
        "session_id": _get(e, "session_id") or "",
    }
    if trace_file:
        out["trace_file"] = str(trace_file)
    if event_index is not None:
        out["event_index"] = int(event_index)
    return out


# kind 前缀 → 基础通道。tool/llm 配合 field 细分为 *_in / *_out (provenance 用)。
_CHANNEL_PREFIX = (
    ("user.", "user"),
    ("prompt.", "prompt"),
    ("ctxproc", "prompt"),
    ("context.", "prompt"),
    ("memory", "memory"),
    ("tool.", "tool"),
    ("llm.", "llm"),
    ("agent.response", "llm"),
    ("side.query", "llm"),
    ("policy.", "policy"),
    ("hil.", "policy"),
    ("subagent", "subagent"),
)


def channel_of(e: Any, field: Optional[str] = None) -> str:
    """event 的内容通道: user/prompt/memory/tool[_in|_out]/llm[_in|_out]/policy/subagent/obs.

    field ∈ {"inputs","outputs"} 时把 tool/llm 细分为 tool_in/tool_out/llm_in/llm_out
    (provenance 按命中字段细分); 其余 kind (hook/turn/task/run/bootstrap/…) 归 "obs"。
    """
    kind = _get(e, "kind") or ""
    base = "obs"
    for prefix, ch in _CHANNEL_PREFIX:
        if kind.startswith(prefix) or kind == prefix.rstrip("."):
            base = ch
            break
    if base in ("tool", "llm") and field in ("inputs", "outputs"):
        return f"{base}_{'in' if field == 'inputs' else 'out'}"
    return base


def _to_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        return str(v)


def content_refs(e: Any, *, excerpt_chars: int = 200) -> Dict[str, Any]:
    """inputs/outputs 的统一内容引用: {chars, content_hash, excerpt} (不回吐全量 payload)."""
    out: Dict[str, Any] = {}
    for fld in ("inputs", "outputs"):
        v = _get(e, fld)
        if not v:
            continue
        if isinstance(v, dict) and isinstance(v.get("blocks"), list):
            out[fld] = {
                "blocks": [
                    {
                        key: value
                        for key, value in block.items()
                        if key not in {"data", "text", "excerpt"}
                    }
                    for block in v["blocks"]
                    if isinstance(block, dict)
                ]
            }
            continue
        txt = _to_text(v)
        out[fld] = {
            "chars": len(txt),
            "content_hash": hashlib.sha1(txt.encode("utf-8", "replace")).hexdigest()[:12],
            "excerpt": txt[:excerpt_chars],
        }
    return out


# ─────────────────────── memory 证据引用 ───────────────────────

MEMORY_REF_KEYS = (
    "memory_entry_id",
    "memory_kit",
    "retrieved_entry_ids",
    "injected_entry_ids",
    "source_span_ids",
    "derived_from_entry_ids",
    "used_by_span_ids",
    "trust_label",
)


def memory_refs(e: Any) -> Dict[str, Any]:
    """memory 事件的链路字段规范化提取; 写入侧缺的字段显式列在 missing_fields
    (验收规则: 缺字段必须如实报告, 不得当成功)."""
    a = _attrs(e)
    out: Dict[str, Any] = {}
    missing: List[str] = []
    for k in MEMORY_REF_KEYS:
        if k in a and a[k] not in (None, "", []):
            out[k] = a[k]
        else:
            missing.append(k)
    out["missing_fields"] = missing
    return out


# ─────────────────────── CLI 输出 envelope ───────────────────────


def envelope(
    query: Dict[str, Any],
    rows: List[Any],
    *,
    total: Optional[int] = None,
    truncated: bool = False,
    evidence: Optional[List[Dict[str, Any]]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """所有 JSON 子命令的统一输出形态 (proposal 26 §5.0). 字段只增不删."""
    out: Dict[str, Any] = {
        "v": CONTRACT_VERSION,
        "query": query,
        "rows": rows,
        "total": len(rows) if total is None else int(total),
        "truncated": bool(truncated),
        "evidence": evidence or [],
    }
    if extra:
        out.update(extra)
    return out


__all__ = [
    "CONTRACT_VERSION",
    "event_status",
    "run_status",
    "effective_status",
    "is_failed_event",
    "is_failed_run",
    "is_failed",
    "error_class_of",
    "span_pointer",
    "channel_of",
    "content_refs",
    "memory_refs",
    "MEMORY_REF_KEYS",
    "envelope",
]
