"""trace CLI v2 — agent 一等消费者的 trace 查询面 (proposal 26).

定位: **配套服务** —— 提供 trace 数据查询的基础原语 (过滤/检索/树范围/聚合/溯源/装配),
不承诺任何需求一键可得; 复合命令 (why/trajectory/evidence/distill) 只是高频组合的糖,
全部可由原语 + `sql` 复现。CLI 零 LLM 调用, 同输入必同输出 (§5.5)。

全局契约 (Evidence Contract, §5.0/§5.2):
- 默认 **JSON 到 stdout** (envelope: v/query/rows/total/truncated/evidence), 诊断走 stderr;
  `--pretty` 给人看。
- `--fields a,b,c` 投影 (各命令有保守默认投影), `--full` 全字段。
- 默认 `--limit` (事件类 50 / 聚合类 20); 超限 `truncated: true` + `total`。
- `--fail-if 'field>value'` 阈值判定 → 违反时退出码 3 (调度器/CI 直接消费)。
- 成败/error_class/channel 一律走 `damoatrace.recording.records` 统一口径。

跑法: `python -m damoatrace <cmd> ...`

数据/输出/usage 基元已拆分: 取数/聚合 → damoatrace.data.store (TraceStore) +
damoatrace.search.fts (FtsSearch); 映射/价格表/时间解析 → damoatrace.utils;
envelope/投影/fail-if 输出 → damoatrace.cli.output; usage rollup → damoatrace.data.usage。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import duckdb

import damoatrace.recording.records as _rec
from damoatrace.cli.output import (
    EXIT_ERROR,
    EXIT_NOTFOUND,
    EXIT_OK,
    EXIT_USAGE,
    _diag,
    _emit,
)
from damoatrace.data.actions import read_service_actions
from damoatrace.data.store import TraceStore, is_consumption_usage_event
from damoatrace.data.usage import _run_summary
from damoatrace.evidence.digest import digest as digest_text
from damoatrace.paths import APP_LOG_DIR, METRICS_DIR, TRACE_DIR, ensure_home
from damoatrace.recording.content import UnsupportedContentVersion
from damoatrace.recording.diagnostics import verify_diagnostic_directory
from damoatrace.search.fts import FtsSearch
from damoatrace.utils import _parse_since, _parse_ts, _percentile

# ───────────────────────── 数据选取管道 ─────────────────────────


SLOW_SPAN_KINDS = frozenset({"llm", "tool", "turn", "subagent", "hil", "runtime"})

OFFLINE_COMMANDS = frozenset(
    {
        "list",
        "sessions",
        "session",
        "events",
        "errors",
        "tools",
        "summary",
        "span",
        "runs",
        "llms",
    }
)
SESSION_EVIDENCE_LIMIT = 20


def _store(args) -> TraceStore:
    selected = getattr(args, "evidence_store", None)
    if selected is not None:
        return selected
    ensure_home()
    return TraceStore(TRACE_DIR, include_content=getattr(args, "include_content", False))


def _resolve_session(store: TraceStore, args) -> Optional[str]:
    """--session 前缀匹配 / --latest 最近活跃的 main session。无则 None (= 全量)。"""
    sid = getattr(args, "session", None)
    if sid:
        sessions = store.sessions()
        exact = [s["session_id"] for s in sessions if s["session_id"] == sid]
        if exact:
            return exact[0]
        pref = [s["session_id"] for s in sessions if s["session_id"].startswith(sid)]
        if len(pref) == 1:
            return pref[0]
        if len(pref) > 1:
            _diag(f"session 前缀 {sid!r} 命中 {len(pref)} 个: {pref[:5]}")
            return pref[0]
        _diag(f"session {sid!r} 不存在")
        return sid
    if getattr(args, "latest", False):
        for s in store.sessions():
            if s.get("role") == "main":
                return s["session_id"]
        ss = store.sessions()
        return ss[0]["session_id"] if ss else None
    return None


def _subtree_ids(events: List[Dict[str, Any]], root_span: str) -> set:
    keep = {root_span}
    frontier = {root_span}
    while frontier:
        nxt: set[str] = set()
        for e in events:
            pid = e.get("parent_span_id")
            sid = e.get("span_id")
            if isinstance(sid, str) and pid in frontier and sid not in keep:
                keep.add(sid)
                nxt.add(sid)
        frontier = nxt
    return keep


def _select_events(
    store: TraceStore, args, *, session: Optional[str] = None
) -> List[Dict[str, Any]]:
    """统一过滤管道: session/run/kind/status(effective)/since/until/scope(subtree|root)。时间正序。"""
    sid = session if session is not None else _resolve_session(store, args)
    events = store.session_events(sid) if sid else store.all_events()
    run = getattr(args, "run", None)
    if run:
        events = [e for e in events if (e.get("task_run_id") or "").startswith(run)]
    kind = getattr(args, "kind", None)
    if kind:
        events = [e for e in events if (e.get("kind") or "").startswith(kind)]
    status = getattr(args, "status", None)
    if status:
        events = [e for e in events if _rec.effective_status(e) == status]
    since = getattr(args, "since", None)
    if since:
        cut = _parse_since(since)
        if cut:
            events = [e for e in events if (_parse_ts(e.get("started_at")) or 0) >= cut]
    until = getattr(args, "until", None)
    if until:
        cut = _parse_since(until)
        if cut:
            events = [e for e in events if (_parse_ts(e.get("started_at")) or 0) < cut]
    scope = getattr(args, "scope", None)
    under = getattr(args, "under", None)
    if scope == "subtree" and under:
        full = [e for e in events]
        ids = _subtree_ids(full, _expand_span_prefix(full, under))
        events = [e for e in full if e.get("span_id") in ids]
    elif scope == "root":
        events = [e for e in events if not e.get("parent_span_id")]
    events.sort(key=lambda e: e.get("started_at") or "")
    return events


def _expand_span_prefix(events: List[Dict[str, Any]], prefix: str) -> str:
    for e in events:
        if (e.get("span_id") or "").startswith(prefix):
            return e["span_id"]
    return prefix


def _row(e: Dict[str, Any]) -> Dict[str, Any]:
    """event dict → 输出行 (统一口径 + 内容引用, 不回吐全量 payload)。"""
    r = {
        "span_id": e.get("span_id"),
        "parent_span_id": e.get("parent_span_id"),
        "kind": e.get("kind"),
        "name": e.get("name"),
        "status": _rec.effective_status(e),
        "error_class": _rec.error_class_of(e) if _rec.is_failed(e) else None,
        "duration_ms": e.get("duration_ms"),
        "started_at": e.get("started_at"),
        "session_id": e.get("session_id") or e.get("_sid"),
        "task_run_id": e.get("task_run_id"),
        "component_id": e.get("component_id"),
        "channel": _rec.channel_of(e),
    }
    r.update({f"{k}_ref": v for k, v in _rec.content_refs(e).items()})
    return r


def _full_event(e: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in e.items() if k != "_sid"}


def _limit_rows(rows: List[Any], args, default: int) -> Tuple[List[Any], int, bool]:
    limit = getattr(args, "limit", None)
    limit = default if limit is None else limit
    total = len(rows)
    if limit and total > limit:
        return rows[:limit], total, True
    return rows, total, False


def _tool_signature(e: Dict[str, Any]) -> str:
    refs = _rec.content_refs(e)
    in_hash = (refs.get("inputs") or {}).get("content_hash", "")
    return f"{e.get('name')}#{in_hash}"


# ───────────────────────── 基础取数命令 ─────────────────────────


def cmd_sessions(args) -> int:
    store = _store(args)
    rows = store.sessions()
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(args, "sessions", {}, rows, total=total, truncated=trunc)


def cmd_session(args) -> int:
    store = _store(args)
    sid = _resolve_session(store, args)
    if not sid:
        _diag("需要 --session/-s 或 --latest")
        return EXIT_USAGE
    meta = next((s for s in store.sessions() if s["session_id"] == sid), None)
    if meta is None:
        return EXIT_NOTFOUND
    events = store.session_events(sid)
    by_kind = Counter(e.get("kind") for e in events)
    runs = [_run_row(e) for e in events if e.get("kind") == "run.outcome"]
    extra = {"by_kind": dict(by_kind.most_common()), "runs": runs}
    return _emit(
        args,
        "session",
        {"session": sid},
        [meta],
        extra=extra,
        evidence=[_rec.span_pointer(event) for event in events if event.get("span_id")][
            :SESSION_EVIDENCE_LIMIT
        ],
    )


def _run_row(e: Dict[str, Any]) -> Dict[str, Any]:
    a = e.get("attributes") or {}
    return {
        "task_run_id": e.get("task_run_id"),
        "status": _rec.effective_status(e),
        "error_class": a.get("error_class"),
        "stop_reason": a.get("stop_reason"),
        "turns": a.get("turns"),
        "harness_version": a.get("harness_version"),
        "evolved_from": a.get("evolved_from"),
        "session_id": e.get("session_id") or e.get("_sid"),
        "started_at": e.get("started_at"),
        "usage": a.get("usage"),
    }


def cmd_runs(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    outcomes = [e for e in events if e.get("kind") == "run.outcome"]
    rows = [_run_row(e) for e in outcomes]
    want = getattr(args, "run_status", None)
    if want:
        want = "ok" if want == "success" else want
        rows = [
            r
            for r in rows
            if (("ok" if str(r["status"]) in ("ok", "success") else r["status"])) == want
        ]
    rows.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    rows, total, trunc = _limit_rows(rows, args, 50)
    failed = sum(1 for r in rows if r["status"] not in ("ok", "success"))
    evidence = [_rec.span_pointer(o) for o in outcomes[:10]]
    return _emit(
        args,
        "runs",
        {"status": want},
        rows,
        total=total,
        truncated=trunc,
        evidence=evidence,
        extra={"failed": failed},
    )


def cmd_events(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    rows = [_full_event(e) if getattr(args, "full", False) else _row(e) for e in events]
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(
        args,
        "events",
        {
            "session": getattr(args, "session", None),
            "run": getattr(args, "run", None),
            "kind": getattr(args, "kind", None),
            "status": getattr(args, "status", None),
            "scope": getattr(args, "scope", None),
            "under": getattr(args, "under", None),
        },
        rows,
        total=total,
        truncated=trunc,
    )


def cmd_span(args) -> int:
    store = _store(args)
    events = store.all_events()
    hits = [e for e in events if (e.get("span_id") or "").startswith(args.span_id)]
    if not hits:
        _diag(f"span {args.span_id!r} 不存在")
        return EXIT_NOTFOUND
    target = hits[0]
    extra: Dict[str, Any] = {}
    n = getattr(args, "context", 0) or 0
    if n:
        run_events = [e for e in events if e.get("task_run_id") == target.get("task_run_id")]
        run_events.sort(key=lambda e: e.get("started_at") or "")
        idx = next(
            (i for i, e in enumerate(run_events) if e.get("span_id") == target.get("span_id")), 0
        )
        before = [_row(e) for e in run_events[max(0, idx - n) : idx]]
        after = [_row(e) for e in run_events[idx + 1 : idx + 1 + n]]
        extra = {"context_before": before, "context_after": after}
    return _emit(
        args,
        "span",
        {"span_id": args.span_id, "context": n},
        [_full_event(target)],
        evidence=[_rec.span_pointer(target)],
        extra=extra,
    )


def cmd_search(args) -> int:
    store = _store(args)
    sid = _resolve_session(store, args)
    rows: List[Dict[str, Any]] = []
    used = "memory_scan"
    limit = getattr(args, "limit", None) or 50
    if not getattr(args, "no_index", False) and not getattr(args, "include_content", False):
        fts = FtsSearch(TRACE_DIR)
        hits = fts.search(
            args.query,
            scope=args.scope,
            limit=limit,
            session_id=sid,
            kind=getattr(args, "kind", None),
        )
        if hits is not None:
            used = "fts5"
            rows = hits
    if used == "memory_scan":
        needle = args.query.lower()
        events = _select_events(store, args, session=sid)
        for e in events:
            blob = json.dumps(
                {k: e.get(k) for k in ("name", "inputs", "outputs", "attributes", "error")},
                ensure_ascii=False,
                default=str,
            ).lower()
            if needle in blob:
                rows.append(_row(e))
                if len(rows) >= limit:
                    break
    rows, total, trunc = _limit_rows(rows, args, limit)
    return _emit(
        args,
        "search",
        {"q": args.query, "scope": args.scope, "engine": used},
        rows,
        total=total,
        truncated=trunc,
    )


def cmd_logs(args) -> int:
    store = _store(args)
    res = store.logs(
        q=getattr(args, "grep", "") or "",
        level=getattr(args, "level", "") or "",
        session=getattr(args, "session", "") or "",
        since=_parse_since(args.since) if getattr(args, "since", None) else None,
        limit=getattr(args, "limit", None) or 50,
    )
    rows = res["rows"]
    return _emit(
        args,
        "logs",
        {"grep": getattr(args, "grep", None), "level": getattr(args, "level", None)},
        rows,
        total=res["total"],
        truncated=len(rows) < res["total"],
        extra={
            "by_level": res["by_level"],
            "top_loggers": res["top_loggers"],
            "errors": res["by_level"].get("error", 0),
        },
    )


def cmd_metrics(args) -> int:
    store = _store(args)
    res = store.metrics(session=getattr(args, "session", "") or "")
    rows, total, trunc = _limit_rows(res["timings"], args, 20)
    flat = {f"{t['name']}_p95": t["p95"] for t in res["timings"]}
    return _emit(
        args,
        "metrics",
        {},
        rows,
        total=total,
        truncated=trunc,
        extra={"counters": res["counters"], **flat},
    )


def cmd_summary(args) -> int:
    store = _store(args)
    sid = _resolve_session(store, args)
    if not sid:
        _diag("需要 --session/-s 或 --latest")
        return EXIT_USAGE
    if getattr(args, "pretty", False):
        print(
            digest_text(
                store.all_events(), sid, include_content=getattr(args, "include_content", False)
            )
        )
        return EXIT_OK
    traces = store.session_traces(sid)
    outcomes = {
        event.get("task_run_id"): event
        for event in store.session_events(sid)
        if event.get("kind") == "run.outcome"
    }
    rows = []
    evidence: List[Dict[str, Any]] = []
    for t in traces:
        turns = []
        for s in t["spans"]:
            if s.get("type") != "turn":
                continue
            kids = [x for x in t["spans"] if x.get("parentId") == s["id"]]
            turns.append(
                {
                    "turn": s.get("turnIndex"),
                    "duration_ms": s.get("dur"),
                    "llm": [
                        {
                            "name": k["name"],
                            "model": k.get("model"),
                            "duration_ms": k["dur"],
                            "span_id": k["id"],
                        }
                        for k in kids
                        if k.get("type") == "llm"
                    ],
                    "tools": [
                        {
                            "name": k["name"],
                            "status": k["status"],
                            "duration_ms": k["dur"],
                            "span_id": k["id"],
                        }
                        for k in kids
                        if k.get("type") == "tool"
                    ],
                    "errors": [k["id"] for k in kids if k.get("status") == "error"],
                    "span_ids": [k["id"] for k in kids],
                }
            )
        rows.append(
            {
                "trace_id": t["id"],
                "task_run_id": t.get("runId"),
                "title": t["name"],
                "status": (
                    _rec.effective_status(outcomes[t.get("runId")])
                    if t.get("runId") in outcomes
                    else "unknown"
                ),
                "outcome_evidence": (
                    _rec.span_pointer(outcomes[t.get("runId")])
                    if t.get("runId") in outcomes
                    else None
                ),
                "agent": t.get("agent"),
                "duration_ms": t["duration"],
                "tokens_in": t.get("tokensIn"),
                "tokens_out": t.get("tokensOut"),
                "span_count": t.get("spanCount"),
                "turns": turns,
                "children": t.get("children") or [],
            }
        )
        root = next((s for s in t["spans"] if s.get("type") == "root"), None)
        if root:
            evidence.append(
                {"span_id": root["id"], "task_run_id": t.get("runId") or "", "session_id": sid}
            )
    rows, total, trunc = _limit_rows(rows, args, 20)
    evidence.extend(row["outcome_evidence"] for row in rows if row.get("outcome_evidence"))
    return _emit(
        args, "summary", {"session": sid}, rows, total=total, truncated=trunc, evidence=evidence
    )


# ───────────────────────── 统计聚合命令 ─────────────────────────


def cmd_slow(args) -> int:
    store = _store(args)
    res = store.metrics(session=getattr(args, "session", "") or "")
    timings = res["timings"]  # 已按 p95 倒序
    events = _select_events(store, args)
    spans = [
        e
        for e in events
        if e.get("duration_ms") and (e.get("kind") or "").split(".")[0] in SLOW_SPAN_KINDS
    ]
    spans.sort(key=lambda e: e.get("duration_ms") or 0, reverse=True)
    top = getattr(args, "top", None) or 10
    top_spans = [{**_row(e)} for e in spans[:top]]
    rows, total, trunc = _limit_rows(timings, args, 20)
    flat = {f"{t['name']}_p95": t["p95"] for t in timings}
    max_p95 = max((t["p95"] for t in timings), default=0)
    return _emit(
        args,
        "slow",
        {"top": top},
        rows,
        total=total,
        truncated=trunc,
        evidence=[_rec.span_pointer(e) for e in spans[:top]],
        extra={"top_spans": top_spans, "max_p95": max_p95, **flat},
    )


def _failure_clusters(events: List[Dict[str, Any]], by: str) -> Dict[str, Dict[str, Any]]:
    groups: Dict[str, Dict[str, Any]] = {}
    for e in events:
        if not _rec.is_failed(e):
            continue
        if by == "error_class":
            key = _rec.error_class_of(e)
        elif by == "tool":
            key = str(e.get("name") or "_unknown") if e.get("kind") == "tool.exec" else "_other"
        elif by == "stage":
            key = (
                str(e.get("name") or "_unknown")
                if (e.get("kind") or "").startswith("prompt.stage")
                else "_other"
            )
        elif by == "component":
            key = e.get("component_id") or "_unknown"
        else:
            key = "_unknown"
        g = groups.setdefault(
            key, {"cluster": key, "count": 0, "examples": [], "first_seen": None, "last_seen": None}
        )
        g["count"] += 1
        if len(g["examples"]) < 5:
            g["examples"].append(_rec.span_pointer(e))
        ts = e.get("started_at")
        if ts:
            g["first_seen"] = (
                ts if g["first_seen"] is None or ts < g["first_seen"] else g["first_seen"]
            )
            g["last_seen"] = ts if g["last_seen"] is None or ts > g["last_seen"] else g["last_seen"]
    return groups


def _first_failure(events: List[Dict[str, Any]], task_run_id: str) -> Optional[Dict[str, Any]]:
    run = sorted(
        [
            e
            for e in events
            if e.get("task_run_id") == task_run_id and e.get("kind") != "run.outcome"
        ],
        key=lambda e: e.get("started_at") or "",
    )
    return next((e for e in run if _rec.is_failed(e)), None)


def cmd_failures(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    groups = _failure_clusters(events, args.by)
    rows = sorted(groups.values(), key=lambda g: (g["count"], g["last_seen"] or ""), reverse=True)
    if getattr(args, "locate", False):
        by_span = {e.get("span_id"): e for e in events}
        for g in rows:
            ptr = g["examples"][0] if g["examples"] else None
            if not ptr:
                continue
            ev = by_span.get(ptr["span_id"])
            first = _first_failure(events, ptr["task_run_id"]) if ptr["task_run_id"] else None
            g["locate"] = {
                "representative": _row(ev) if ev else None,
                "first_failure_in_run": _row(first) if first else None,
                "parent_chain": _parent_chain(events, ev) if ev else [],
            }
    rows, total, trunc = _limit_rows(rows, args, 20)
    evidence = [p for g in rows for p in g["examples"][:2]]
    total_failures = sum(g["count"] for g in groups.values())
    return _emit(
        args,
        "failures",
        {"by": args.by, "locate": getattr(args, "locate", False)},
        rows,
        total=total,
        truncated=trunc,
        evidence=evidence,
        extra={"total_failures": total_failures, "clusters": len(groups)},
    )


def _parent_chain(
    events: List[Dict[str, Any]], e: Dict[str, Any], max_depth: int = 6
) -> List[Dict[str, Any]]:
    by_span = {x.get("span_id"): x for x in events}
    chain: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = e
    while cur is not None and len(chain) < max_depth:
        pid = cur.get("parent_span_id")
        cur = by_span.get(pid) if pid else None
        if cur is not None:
            chain.append(
                {"span_id": cur.get("span_id"), "kind": cur.get("kind"), "name": cur.get("name")}
            )
    return chain


def cmd_usage(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    by = args.by
    groups: Dict[str, Dict[str, Any]] = defaultdict(
        lambda: {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_tokens": 0,
            "cache_creation_tokens": 0,
            "calls": 0,
        }
    )
    for e in events:
        a = e.get("attributes") or {}
        if not is_consumption_usage_event(e):
            continue
        usage = a.get("usage") or {}
        if by == "model":
            key = a.get("model") or "_unknown"
        elif by == "tool":
            key = a.get("tool_name") or (
                e.get("name") if (e.get("kind") or "").startswith("tool") else "_other"
            )
        elif by == "component":
            key = e.get("component_id") or "_unknown"
        elif by == "task_run":
            key = e.get("task_run_id") or "_unknown"
        elif by == "session":
            key = e.get("session_id") or e.get("_sid") or "_unknown"
        else:
            key = e.get("kind") or "_unknown"
        g = groups[str(key)]
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"):
            g[k] += int(usage.get(k, 0) or 0)
        g["calls"] += 1
    rows = [
        {"key": k, **v, "total_tokens": v["input_tokens"] + v["output_tokens"]}
        for k, v in groups.items()
    ]
    rows.sort(key=lambda r: r["total_tokens"], reverse=True)
    rows, total, trunc = _limit_rows(rows, args, 20)
    grand = sum(r["total_tokens"] for r in rows)
    return _emit(
        args, "usage", {"by": by}, rows, total=total, truncated=trunc, extra={"total_tokens": grand}
    )


def cmd_diff(args) -> int:
    store = _store(args)
    events = store.all_events()
    sa = _run_summary(events, args.run_a)
    sb = _run_summary(events, args.run_b)
    if sa["events"] == 0 or sb["events"] == 0:
        _diag(f"run 不存在或为空: a={sa['events']} b={sb['events']} events")
        return EXIT_NOTFOUND
    div = None
    for i, (x, y) in enumerate(zip(sa["action_seq"], sb["action_seq"])):
        if x != y:
            div = {"index": i, "a": x, "b": y}
            break
    delta = {
        "events": sb["events"] - sa["events"],
        "errors": sb["errors"] - sa["errors"],
        "by_error_class": {
            k: sb["by_error_class"].get(k, 0) - sa["by_error_class"].get(k, 0)
            for k in set(sa["by_error_class"]) | set(sb["by_error_class"])
        },
        "tokens": (sb["usage_total"]["input_tokens"] + sb["usage_total"]["output_tokens"])
        - (sa["usage_total"]["input_tokens"] + sa["usage_total"]["output_tokens"]),
    }
    for s in (sa, sb):
        s.pop("action_seq", None)
    return _emit(
        args,
        "diff",
        {"a": args.run_a, "b": args.run_b},
        [{"a": sa, "b": sb, "delta": delta, "first_divergence": div}],
        extra={"errors_delta": delta["errors"]},
    )


def cmd_cohort_diff(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    outcomes = [e for e in events if e.get("kind") == "run.outcome"]
    if args.by == "harness_version":
        key = (
            lambda e: (e.get("attributes") or {}).get("harness_version") or "_unknown"
        )  # noqa: E731
        a_runs = [e for e in outcomes if key(e) == args.a]
        b_runs = [e for e in outcomes if key(e) == args.b]
    else:  # window: a/b 是 --since 风格表达式
        ta, tb = _parse_since(args.a), _parse_since(args.b)
        if ta is None or tb is None:
            _diag("--by window 时 a/b 需是时间表达式 (如 7d / 1d)")
            return EXIT_USAGE
        lo, hi = (min(ta, tb), max(ta, tb))
        a_runs = [e for e in outcomes if lo <= (_parse_ts(e.get("started_at")) or 0) < hi]
        b_runs = [e for e in outcomes if (_parse_ts(e.get("started_at")) or 0) >= hi]

    def _cohort(runs: List[Dict[str, Any]]) -> Dict[str, Any]:
        fails = [e for e in runs if _rec.is_failed(e)]
        ec = Counter(_rec.error_class_of(e) for e in fails)
        durs = []
        toks = 0
        for e in runs:
            a = e.get("attributes") or {}
            u = a.get("usage") or {}
            toks += int(u.get("input_tokens", 0) or 0) + int(u.get("output_tokens", 0) or 0)
            run_events = [
                x
                for x in events
                if x.get("task_run_id") == e.get("task_run_id") and x.get("kind") == "task.start"
            ]
            for x in run_events:
                if x.get("duration_ms"):
                    durs.append(float(x["duration_ms"]))
        return {
            "runs": len(runs),
            "failed": len(fails),
            "fail_rate": round(len(fails) / len(runs), 4) if runs else None,
            "by_error_class": dict(ec),
            "p95_duration_ms": round(_percentile(durs, 0.95), 1) if durs else None,
            "tokens": toks,
        }

    ca, cb = _cohort(a_runs), _cohort(b_runs)
    new_failures = [k for k in cb["by_error_class"] if k not in ca["by_error_class"]]
    fr_a, fr_b = ca["fail_rate"] or 0, cb["fail_rate"] or 0
    verdict = "improved" if fr_b < fr_a else ("regressed" if fr_b > fr_a else "unchanged")
    row = {
        "a": {"key": args.a, **ca},
        "b": {"key": args.b, **cb},
        "verdict": verdict,
        "new_failures": new_failures,
        "fail_rate_delta": round(fr_b - fr_a, 4),
    }
    return _emit(
        args,
        "cohort-diff",
        {"by": args.by, "a": args.a, "b": args.b},
        [row],
        extra={
            "fail_rate_delta": row["fail_rate_delta"],
            "fail_rate_b": fr_b,
            "new_failure_count": len(new_failures),
        },
    )


# ───────────────────────── 轨迹与证据命令 ─────────────────────────


def cmd_attribute(args) -> int:
    store = _store(args)
    events = store.all_events()
    first = _first_failure(events, args.run)
    outcome = next(
        (
            e
            for e in events
            if (e.get("task_run_id") or "").startswith(args.run) and e.get("kind") == "run.outcome"
        ),
        None,
    )
    if first is None and (outcome is None or not _rec.is_failed(outcome)):
        return _emit(
            args,
            "attribute",
            {"run": args.run},
            [{"result": "no_failure_found"}],
            extra={"hint": "该 run 无失败 event 且 run.outcome 非失败"},
        )
    target = first or outcome
    assert target is not None  # 上面分支已保证
    run_events = sorted(
        [e for e in events if e.get("task_run_id") == target.get("task_run_id")],
        key=lambda e: e.get("started_at") or "",
    )
    idx = next(
        (i for i, e in enumerate(run_events) if e.get("span_id") == target.get("span_id")), 0
    )
    n = getattr(args, "context", 3) or 3
    task_start = next((e for e in run_events if e.get("kind") == "task.start"), None)
    agent_id = (task_start or {}).get("component_id")
    row = {
        "first_failure": _row(target),
        "error": target.get("error"),
        "error_class": _rec.error_class_of(target),
        "agent": agent_id,
        "run_outcome": _run_row(outcome) if outcome else None,
        "parent_chain": _parent_chain(run_events, target),
        "context_before": [_row(e) for e in run_events[max(0, idx - n) : idx]],
        "context_after": [_row(e) for e in run_events[idx + 1 : idx + 1 + n]],
    }
    return _emit(args, "attribute", {"run": args.run}, [row], evidence=[_rec.span_pointer(target)])


def cmd_loops(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    by_run: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for e in events:
        if e.get("task_run_id"):
            by_run[e["task_run_id"]].append(e)
    rows: list[dict[str, Any]] = []
    min_repeat = getattr(args, "min_repeat", 3) or 3
    for run_id, evs in by_run.items():
        evs.sort(key=lambda e: e.get("started_at") or "")
        tools = [e for e in evs if e.get("kind") == "tool.exec"]
        streak_sig, streak, streak_start = None, 0, None
        for e in tools:
            sig = _tool_signature(e)
            if sig == streak_sig:
                streak += 1
            else:
                if streak >= min_repeat:
                    rows.append(
                        {
                            "flag": "repeat_call",
                            "run": run_id,
                            "signature": streak_sig,
                            "count": streak,
                            "example": _rec.span_pointer(streak_start),
                        }
                    )
                streak_sig, streak, streak_start = sig, 1, e
        if streak >= min_repeat:
            rows.append(
                {
                    "flag": "repeat_call",
                    "run": run_id,
                    "signature": streak_sig,
                    "count": streak,
                    "example": _rec.span_pointer(streak_start),
                }
            )
        turns = sum(1 for e in evs if e.get("kind") == "turn.start")
        if turns >= 3 and not tools:
            rows.append(
                {
                    "flag": "zero_tool_turns",
                    "run": run_id,
                    "count": turns,
                    "example": _rec.span_pointer(evs[0]),
                }
            )
        oc = next((e for e in evs if e.get("kind") == "run.outcome"), None)
        if oc and ((oc.get("attributes") or {}).get("stop_reason") or "") in (
            "max_turns",
            "max_turn",
        ):
            rows.append(
                {
                    "flag": "max_turns_hit",
                    "run": run_id,
                    "count": turns,
                    "example": _rec.span_pointer(oc),
                }
            )
    rows, total, trunc = _limit_rows(rows, args, 20)
    return _emit(
        args,
        "loops",
        {"min_repeat": min_repeat},
        rows,
        total=total,
        truncated=trunc,
        evidence=[r["example"] for r in rows],
        extra={"flagged": total},
    )


def cmd_trajectory(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    if getattr(args, "run", None):
        events = [e for e in events if (e.get("task_run_id") or "").startswith(args.run)]
    if not events:
        return EXIT_NOTFOUND
    events.sort(key=lambda e: e.get("started_at") or "")
    actions: list[dict[str, Any]] = []
    seen_out_hash: Dict[str, str] = {}
    read_paths: Dict[str, Dict[str, Any]] = {}
    referenced: set = set()
    turn_no = 0
    prev_fail_sig: Optional[str] = None
    for e in events:
        kind = e.get("kind") or ""
        if kind == "turn.start":
            turn_no += 1
            continue
        if kind not in ("tool.exec", "llm.stream", "user.message", "agent.response", "hil.request"):
            continue
        refs = _rec.content_refs(e)
        flags: List[str] = []
        if kind == "tool.exec":
            sig = _tool_signature(e)
            out_hash = (refs.get("outputs") or {}).get("content_hash", "")
            if sig in seen_out_hash and seen_out_hash[sig] == out_hash and out_hash:
                flags.append("repeat_noop")
            seen_out_hash[sig] = out_hash
            in_txt = (refs.get("inputs") or {}).get("excerpt", "")
            if e.get("name") in ("tool.Read", "tool.fs_read"):
                read_paths[in_txt[:80]] = e
            else:
                for p in list(read_paths):
                    if p and p[:40] in in_txt:
                        referenced.add(p)
            if _rec.is_failed(e):
                if prev_fail_sig == sig:
                    flags.append("retry_chain")
                prev_fail_sig = sig
            else:
                prev_fail_sig = None
        actions.append(
            {
                "turn": turn_no,
                "kind": kind,
                "name": e.get("name"),
                "status": _rec.effective_status(e),
                "duration_ms": e.get("duration_ms"),
                "span_id": e.get("span_id"),
                "flags": flags,
            }
        )
    for p, e in read_paths.items():
        if p not in referenced:
            for a in actions:
                if a["span_id"] == e.get("span_id"):
                    a["flags"].append("read_unused")
    tool_actions = [a for a in actions if a["kind"] == "tool.exec"]
    churn = sum(1 for a in actions if a["flags"])
    durs = [a["duration_ms"] for a in actions if a["duration_ms"]]
    scorecard = {
        "steps": len(actions),
        "turns": turn_no,
        "llm_calls": sum(1 for a in actions if a["kind"] == "llm.stream"),
        "tool_calls": len(tool_actions),
        "error_rate": (
            round(sum(1 for a in actions if a["status"] not in ("ok",)) / len(actions), 3)
            if actions
            else 0
        ),
        "churn_ratio": round(churn / len(actions), 3) if actions else 0,
        "flagged_steps": churn,
        "p95_step_ms": round(_percentile([float(d) for d in durs], 0.95), 1) if durs else 0,
    }
    rows, total, trunc = _limit_rows(actions, args, 100)
    return _emit(
        args,
        "trajectory",
        {"run": getattr(args, "run", None)},
        rows,
        total=total,
        truncated=trunc,
        evidence=[
            {
                "span_id": a["span_id"],
                "task_run_id": getattr(args, "run", "") or "",
                "session_id": getattr(args, "session", "") or "",
            }
            for a in actions
            if a["flags"]
        ][:10],
        extra={
            "scorecard": scorecard,
            "churn_ratio": scorecard["churn_ratio"],
            "error_rate": scorecard["error_rate"],
        },
    )


_TEXT_FIELDS = ("inputs", "outputs", "attributes")


def cmd_provenance(args) -> int:
    store = _store(args)
    sid = _resolve_session(store, args)
    events = _select_events(store, args, session=sid)
    needle = args.text.lower()
    hits = []
    for e in events:
        for fld in _TEXT_FIELDS:
            v = e.get(fld)
            if not v:
                continue
            txt = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, default=str)
            pos = txt.lower().find(needle)
            if pos < 0:
                continue
            lo = max(0, pos - 60)
            hits.append(
                {
                    **_rec.span_pointer(e),
                    "ts": e.get("started_at"),
                    "kind": e.get("kind"),
                    "name": e.get("name"),
                    "channel": _rec.channel_of(e, fld if fld != "attributes" else None),
                    "field": fld,
                    "excerpt": txt[lo : pos + len(needle) + 60],
                }
            )
            break
    if not hits:
        return _emit(
            args,
            "provenance",
            {"text": args.text, "session": sid},
            [],
            extra={"missing_fields": [], "hint": "无命中; 可换关键词或去掉 --session"},
        )
    first = hits[0]
    rows = [first] if getattr(args, "first", False) else hits
    rows, total, trunc = _limit_rows(rows, args, 20)
    return _emit(
        args,
        "provenance",
        {"text": args.text, "session": sid},
        rows,
        total=total,
        truncated=trunc,
        evidence=[{k: h[k] for k in ("span_id", "task_run_id", "session_id")} for h in hits[:10]],
        extra={
            "first_channel": first["channel"],
            "first_span_id": first["span_id"],
            "chain_length": len(hits),
        },
    )


_GATEWAY_KW = (
    "irc-001",
    "gateway",
    "502",
    "503",
    "rate limit",
    "ratelimit",
    "connection",
    "hook timeout",
)


def cmd_why(args) -> int:
    store = _store(args)
    events = store.all_events()
    # 解析目标: span 前缀 或 run 前缀的首个失败
    target = next(
        (
            e
            for e in events
            if (e.get("span_id") or "").startswith(args.target) and _rec.is_failed(e)
        ),
        None,
    )
    if target is None:
        target = _first_failure(events, args.target)
    if target is None:
        oc = next(
            (
                e
                for e in events
                if (e.get("task_run_id") or "").startswith(args.target)
                and e.get("kind") == "run.outcome"
                and _rec.is_failed(e)
            ),
            None,
        )
        target = oc
    if target is None:
        _diag(f"{args.target!r} 下没有失败 event")
        return EXIT_NOTFOUND
    ec = _rec.error_class_of(target)
    err = target.get("error") or {}
    msg = (
        (err.get("message") if isinstance(err, dict) else "")
        or json.dumps(target.get("attributes") or {}, ensure_ascii=False, default=str)
    ).lower()
    evidence = [{"span_id": target.get("span_id"), "reason": f"first failure, error_class={ec}"}]
    next_queries: List[str] = []
    missing: List[str] = []
    layer, confidence = "unknown", "low"
    # §5.4 判定顺序: schema → harness → prompt → model
    if ec in ("parse", "contract_mismatch"):
        layer, confidence = "schema", "high"
        evidence.append(
            {
                "span_id": target.get("span_id"),
                "reason": "error_class 属 parse/contract_mismatch (参数/解析/契约)",
            }
        )
        next_queries.append(f"python -m damoatrace span {target.get('span_id')} --context 3")
    elif any(k in msg for k in _GATEWAY_KW) or (target.get("kind") or "").startswith(
        ("hook", "policy")
    ):
        layer, confidence = "harness", "high"
        evidence.append(
            {"span_id": target.get("span_id"), "reason": "网关/环境/hook/policy 证据关键词命中"}
        )
    else:
        comp = target.get("component_id")
        if comp:
            comp_fails = [e for e in events if e.get("component_id") == comp and _rec.is_failed(e)]
            comp_runs = {e.get("task_run_id") for e in comp_fails}
            if len(comp_runs) >= 2:
                layer, confidence = "harness", "medium"
                evidence.append(
                    {
                        "span_id": target.get("span_id"),
                        "reason": f"组件 {comp} 跨 {len(comp_runs)} 个 run 反复失败 (工具实现问题特征)",
                    }
                )
        if layer == "unknown" and ec == "reasoning":
            run_id = target.get("task_run_id")
            run_evs = [e for e in events if e.get("task_run_id") == run_id]
            mem = [e for e in run_evs if (e.get("kind") or "").startswith("memory")]
            stages = [e for e in run_evs if (e.get("kind") or "").startswith("prompt.stage")]
            if mem or stages:
                layer, confidence = "prompt", "medium"
                evidence.append(
                    {
                        "span_id": (mem or stages)[0].get("span_id"),
                        "reason": f"同 run 有 {len(mem)} memory 注入 / {len(stages)} prompt stage; 上下文可疑",
                    }
                )
                next_queries.append(
                    'python -m damoatrace provenance "<可疑内容片段>" --session '
                    + (target.get("session_id") or "")
                )
            else:
                layer = "model"
                confidence = "low"
                missing.append("prompt.stage/memory 证据缺失, 无法区分 prompt 与 model 层")
    next_queries.append(f"python -m damoatrace attribute {target.get('task_run_id')}")
    row = {
        "layer": layer,
        "confidence": confidence,
        "error_class": ec,
        "target": _row(target),
        "evidence": evidence,
        "next_queries": next_queries,
        "missing_fields": missing,
    }
    return _emit(args, "why", {"target": args.target}, [row], evidence=[_rec.span_pointer(target)])


def cmd_evidence(args) -> int:
    store = _store(args)
    events = store.all_events()
    run_id = args.run
    run_evs = [e for e in events if (e.get("task_run_id") or "").startswith(run_id)]
    if not run_evs:
        return EXIT_NOTFOUND
    run_id = str(run_evs[0].get("task_run_id") or "")
    sid = run_evs[0].get("session_id") or run_evs[0].get("_sid") or ""
    # 组装: 摘要 + 失败簇 + 归因(why 的确定性部分) + 成功对照 + harness 引用
    summary = _run_summary(events, run_id)
    summary.pop("action_seq", None)
    clusters = list(_failure_clusters(run_evs, "error_class").values())
    first = _first_failure(events, run_id)
    # 成功对照: 同 session 最近一个无失败 run
    success_diff = None
    outcomes = [
        e
        for e in events
        if (e.get("session_id") or e.get("_sid")) == sid
        and e.get("kind") == "run.outcome"
        and not _rec.is_failed(e)
    ]
    if outcomes and first is not None:
        ok_run = str(outcomes[-1].get("task_run_id") or "")
        sa, sb = _run_summary(events, ok_run), _run_summary(events, run_id)
        sa.pop("action_seq", None)
        sb.pop("action_seq", None)
        success_diff = {"success_run": ok_run, "a": sa, "b": sb}
    stages = sorted(
        {
            str(e.get("name") or "_unknown")
            for e in run_evs
            if (e.get("kind") or "").startswith("prompt.stage")
        }
    )
    comps = sorted({str(e["component_id"]) for e in run_evs if e.get("component_id")})
    task_start = next((e for e in run_evs if e.get("kind") == "task.start"), None)
    harness_refs = {
        "harness_version": ((task_start or {}).get("attributes") or {}).get("harness_version"),
        "prompt_stages": stages,
        "components": comps,
    }
    pointers = [_rec.span_pointer(e) for e in run_evs if _rec.is_failed(e)][:20]
    row = {
        "run": run_id,
        "session": sid,
        "summary": summary,
        "failure_clusters": clusters,
        "first_failure": _row(first) if first else None,
        "success_diff": success_diff,
        "harness_refs": harness_refs,
    }
    # 35 §9: 可选附上该 session 的 service action envelope (产品操作怎么进来的)。
    if getattr(args, "include_actions", False):
        row["service_actions"] = read_service_actions(
            session=sid,
            limit=200,
            db=getattr(args, "actions_db", None),
        )
    return _emit(args, "evidence", {"run": args.run}, [row], evidence=pointers)


def _mine_sequences(
    events: List[Dict[str, Any]], *, min_count: int = 2, max_n: int = 3
) -> List[Dict[str, Any]]:
    """确定性 n-gram 子序列挖掘 (成功 run 的 tool/llm 动作序列)。"""
    outcomes = {
        e.get("task_run_id"): not _rec.is_failed(e)
        for e in events
        if e.get("kind") == "run.outcome"
    }
    seqs: Dict[str, List[str]] = defaultdict(list)
    for e in sorted(events, key=lambda x: x.get("started_at") or ""):
        if outcomes.get(e.get("task_run_id")) and e.get("kind") in ("tool.exec", "llm.stream"):
            seqs[e["task_run_id"]].append(e.get("name") or "")
    grams: Counter = Counter()
    for seq in seqs.values():
        for n in range(2, max_n + 1):
            for i in range(len(seq) - n + 1):
                grams[tuple(seq[i : i + n])] += 1
    return [
        {"sequence": list(g), "n": len(g), "count": c}
        for g, c in grams.most_common()
        if c >= min_count
    ]


def cmd_actions(args) -> int:
    # 35 §9: service action 只读面 (SERVICE_ACTIONS_DB) — 产品操作 envelope, 与
    # trace 动作流 (tool.exec/llm.stream) 不同源。--source service 切到 service 库。
    if getattr(args, "source", None) == "service":
        rows = read_service_actions(
            namespace=getattr(args, "namespace", None),
            source=getattr(args, "src", None),  # service 库内 source 列 (webui/cli/...)
            session=getattr(args, "session", None),
            since_seq=getattr(args, "since_seq", 0) or 0,
            limit=getattr(args, "limit", None) or 200,
            db=getattr(args, "actions_db", None),
        )
        return _emit(
            args, "actions.v1", {"source": "service"}, rows, total=len(rows), truncated=False
        )
    store = _store(args)
    events = _select_events(store, args)
    if getattr(args, "sequences", False):
        rows = _mine_sequences(events, min_count=getattr(args, "min_count", 2) or 2)
        rows, total, trunc = _limit_rows(rows, args, 20)
        return _emit(args, "actions", {"sequences": True}, rows, total=total, truncated=trunc)
    rows = [
        _row(e)
        for e in events
        if e.get("kind") in ("tool.exec", "llm.stream", "user.message", "agent.response")
    ]
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(args, "actions", {}, rows, total=total, truncated=trunc)


_LAYER_TARGET = {"schema": "tool", "harness": "tool", "prompt": "prompt", "model": "prompt"}


def cmd_distill(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    rows: List[Dict[str, Any]] = []
    # 失败教训 (模板化候选 — 语义措辞留给消费侧 agent, §5.5)
    for g in _failure_clusters(events, "error_class").values():
        if g["cluster"] == "_unknown" and g["count"] < 2:
            continue
        rows.append(
            {
                "kind": "failure_lesson",
                "summary": f"error_class={g['cluster']} 失败 {g['count']} 次 "
                f"({g['first_seen']} → {g['last_seen']})",
                "evidence_span_ids": [p["span_id"] for p in g["examples"]],
                "frequency": g["count"],
                "suggested_target": _LAYER_TARGET.get(
                    {
                        "parse": "schema",
                        "contract_mismatch": "schema",
                        "trajectory_degenerate": "harness",
                    }.get(g["cluster"], "prompt"),
                    "prompt",
                ),
            }
        )
    for g in _failure_clusters(events, "tool").values():
        if g["cluster"] in ("_other",) or g["count"] < 2:
            continue
        rows.append(
            {
                "kind": "failure_lesson",
                "summary": f"工具 {g['cluster']} 反复失败 {g['count']} 次 (工具实现/用法问题特征)",
                "evidence_span_ids": [p["span_id"] for p in g["examples"]],
                "frequency": g["count"],
                "suggested_target": "tool",
            }
        )
    # 成功模式 (确定性序列挖掘)
    for s in _mine_sequences(events)[:10]:
        rows.append(
            {
                "kind": "success_pattern",
                "summary": f"成功 run 常用动作序列: {' → '.join(s['sequence'])} (出现 {s['count']} 次)",
                "evidence_span_ids": [],
                "frequency": s["count"],
                "suggested_target": "memory",
            }
        )
    rows.sort(key=lambda r: r["frequency"], reverse=True)
    rows, total, trunc = _limit_rows(rows, args, 20)
    return _emit(
        args,
        "distill",
        {},
        rows,
        total=total,
        truncated=trunc,
        extra={
            "lesson_candidates": total,
            "note": "确定性候选素材; 语义蒸馏/写入决策归消费侧 agent (proposal 26 §5.5)",
        },
    )


# ───────────────────────── sql 逃生口 ─────────────────────────


def cmd_sql(args) -> int:
    con = duckdb.connect()
    # Materialize the same consent/expiry projection as every other query. Never
    # give user SQL a view that can re-open the underlying diagnostic JSONL.
    events = _store(args).all_events()
    if events:
        con.execute(
            "CREATE TEMP TABLE projected AS SELECT unnest(?::JSON[]) AS record",
            [[json.dumps(event, default=str) for event in events]],
        )
        structure_row = con.execute("SELECT json_group_structure(record) FROM projected").fetchone()
        if structure_row is None:
            raise RuntimeError("projected trace structure is unavailable")
        structure = structure_row[0]
        con.execute(
            "CREATE TABLE trace AS SELECT expanded.* FROM "
            "(SELECT from_json(record, ?) AS expanded FROM projected)",
            [structure],
        )
        con.execute("DROP TABLE projected")
    views = {
        "logs": APP_LOG_DIR / "*.jsonl",
        "metrics": METRICS_DIR / "*.jsonl",
    }
    for name, glob in views.items():
        try:
            con.execute(
                f"CREATE TABLE {name} AS SELECT * FROM read_json_auto('{glob}', "
                f"union_by_name=true, format='newline_delimited')"
            )
        except Exception as e:  # noqa: BLE001
            _diag(f"view {name} 不可用: {type(e).__name__}: {e}")
    con.execute("SET enable_external_access=false")
    con.execute("SET lock_configuration=true")
    try:
        cur = con.execute(args.sql_query)
        cols = [d[0] for d in cur.description]
        limit = getattr(args, "limit", None) or 100
        data = cur.fetchmany(limit + 1)
        truncated = len(data) > limit
        rows = [dict(zip(cols, r)) for r in data[:limit]]
    except Exception as e:  # noqa: BLE001
        _diag(f"SQL 执行失败: {type(e).__name__}: {e}")
        return EXIT_USAGE
    finally:
        con.close()
    return _emit(args, "sql", {"sql": args.sql_query}, rows, total=len(rows), truncated=truncated)


# ───────────────────────── 旧命令 (保留, 走新管道) ─────────────────────────


def cmd_errors(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    fails = [e for e in events if _rec.is_failed(e)]
    rows = []
    for e in fails:
        err = e.get("error") or {}
        msg = err.get("message") if isinstance(err, dict) else (str(err) if err else "")
        rows.append({**_row(e), "error_message": (msg or "")[:200]})
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(
        args,
        "errors",
        {},
        rows,
        total=total,
        truncated=trunc,
        evidence=[_rec.span_pointer(e) for e in fails[:10]],
        extra={"total_failures": total},
    )


def cmd_llms(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    rows = []
    for e in events:
        if e.get("kind") not in ("llm.stream", "side.query"):
            continue
        a = e.get("attributes") or {}
        u = a.get("usage") or {}
        rows.append(
            {
                **_row(e),
                "model": a.get("model"),
                "input_tokens": u.get("input_tokens"),
                "output_tokens": u.get("output_tokens"),
                "cache_read_tokens": u.get("cache_read_tokens"),
                "stop_reason": a.get("stop_reason"),
            }
        )
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(args, "llms", {}, rows, total=total, truncated=trunc)


def cmd_tools(args) -> int:
    store = _store(args)
    events = _select_events(store, args)
    rows = []
    for e in events:
        if e.get("kind") != "tool.exec":
            continue
        refs = _rec.content_refs(e)
        rows.append(
            {
                **_row(e),
                "name": (e.get("attributes") or {}).get("tool_name") or e.get("name"),
                "event_name": e.get("name"),
                "tool_status": (e.get("attributes") or {}).get("tool_status"),
                "input_preview": (refs.get("inputs") or {}).get("excerpt", "")[:120],
            }
        )
    rows, total, trunc = _limit_rows(rows, args, 50)
    return _emit(
        args,
        "tools",
        {"session": getattr(args, "session", None)},
        rows,
        total=total,
        truncated=trunc,
        evidence=[_rec.span_pointer(row) for row in rows],
    )


def cmd_export(args) -> int:
    store = _store(args)
    sid = _resolve_session(store, args)
    if not sid:
        _diag("需要 --session/-s 或 --latest")
        return EXIT_USAGE
    events = store.session_events(sid)
    fmt = getattr(args, "format", "jsonl")
    out_path = getattr(args, "out", None)
    if fmt == "digest":
        body = digest_text(
            store.all_events(), sid, include_content=getattr(args, "include_content", False)
        )
    elif fmt == "json":
        body = json.dumps(
            {"session_id": sid, "events": [_full_event(e) for e in events]},
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    else:
        body = (
            "\n".join(json.dumps(_full_event(e), ensure_ascii=False, default=str) for e in events)
            + "\n"
        )
    if out_path:
        Path(out_path).write_text(body, encoding="utf-8")
        _diag(f"written: {out_path} ({len(body)} bytes)")
        return EXIT_OK
    print(body)
    return EXIT_OK


def cmd_stats(args) -> int:
    store = _store(args)
    files = sorted(TRACE_DIR.glob("*.jsonl"))
    total_bytes = sum(f.stat().st_size for f in files)
    sessions = store.sessions()
    events = store.all_events()
    failures = sum(1 for e in events if _rec.is_failed(e))
    row = {
        "files": len(files),
        "bytes": total_bytes,
        "sessions": len(sessions),
        "events": len(events),
        "failures": failures,
    }
    return _emit(args, "stats", {}, [row], extra=row)


def cmd_clean(args) -> int:
    store = _store(args)
    cut = _parse_since(args.older_than)
    if cut is None:
        _diag("--older-than 需要 7d/24h/30m 或 ISO 时间")
        return EXIT_USAGE
    victims = []
    for p in sorted(TRACE_DIR.glob("*.jsonl")):
        if p.stat().st_mtime < cut:
            victims.append(p)
    # 防悬空证据: 删除前列出受影响 session (proposal 26 §2.2)
    affected: set = set()
    for p in victims:
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                affected.add(json.loads(line).get("session_id") or "")
            except Exception:  # noqa: BLE001
                continue
    rows = [{"file": p.name, "bytes": p.stat().st_size} for p in victims]
    if getattr(args, "dry_run", False):
        return _emit(
            args,
            "clean",
            {"older_than": args.older_than, "dry_run": True},
            rows,
            extra={"affected_sessions": sorted(a for a in affected if a)},
        )
    for p in victims:
        p.unlink()
    return _emit(
        args,
        "clean",
        {"older_than": args.older_than},
        rows,
        extra={"deleted": len(victims), "affected_sessions": sorted(a for a in affected if a)},
    )


# ───────────────────────── argparse ─────────────────────────


def _add_common(sp, *, session=True, timewin=True, limit=True):
    sp.add_argument(
        "--include-content",
        action="store_true",
        help="显式读取未过期诊断正文；--full 本身不授权正文",
    )
    sp.add_argument("--fields", default=None, help="输出字段投影 (逗号分隔)")
    sp.add_argument("--full", action="store_true", help="输出全字段 (默认保守投影)")
    sp.add_argument("--pretty", action="store_true", help="人读表格 (默认 JSON envelope)")
    sp.add_argument(
        "--fail-if", dest="fail_if", default=None, help="阈值判定 'field>value'; 命中退出码 3"
    )
    if session:
        sp.add_argument("--session", "-s", default=None)
        sp.add_argument("--latest", action="store_true", help="最近活跃的 main session")
    if timewin:
        sp.add_argument("--since", default=None, help="7d/2h/30m 或 ISO")
        sp.add_argument("--until", default=None)
    if limit:
        sp.add_argument("--limit", type=int, default=None)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m damoatrace",
        description="trace 查询 CLI — agent 一等消费者 (Evidence Contract v1; JSON to stdout)",
    )
    source = p.add_mutually_exclusive_group()
    source.add_argument("--trace-file", type=Path, help="只读指定 JSONL，不扫描邻接文件")
    source.add_argument("--trace-dir", type=Path, help="只读指定目录中的 JSONL")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("sessions", help="session 列表 (含挂靠链)")
    _add_common(sp, session=False, timewin=False)
    sp.set_defaults(fn=cmd_sessions)
    sub._name_parser_map["list"] = sp  # 兼容旧名

    sp = sub.add_parser("session", help="单 session 详情 + by_kind + runs")
    _add_common(sp, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_session)

    sp = sub.add_parser("runs", help="per-run 成败标签 (run.outcome)")
    _add_common(sp)
    sp.add_argument(
        "--status", dest="run_status", default=None, choices=["ok", "success", "error", "cancelled"]
    )
    sp.set_defaults(fn=cmd_runs)

    sp = sub.add_parser("events", help="事件流 (过滤/树范围)")
    _add_common(sp)
    sp.add_argument("--run", default=None, help="task_run_id 前缀")
    sp.add_argument("--kind", default=None, help="kind 前缀 (llm/tool.exec/…)")
    sp.add_argument("--status", default=None)
    sp.add_argument("--scope", choices=["run", "root", "subtree"], default=None)
    sp.add_argument("--under", default=None, help="--scope subtree 的根 span (前缀)")
    sp.set_defaults(fn=cmd_events)

    sp = sub.add_parser("span", help="单 span 全字段 (+--context N 邻接)")
    sp.add_argument("span_id")
    sp.add_argument("--context", type=int, default=0)
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_span)

    sp = sub.add_parser("search", help="关键词检索 (FTS5, 降级内存扫描)")
    sp.add_argument("query")
    sp.add_argument("--scope", choices=["all", "text", "tool_input", "error"], default="all")
    sp.add_argument("--kind", default=None)
    sp.add_argument("--no-index", dest="no_index", action="store_true")
    _add_common(sp)
    sp.set_defaults(fn=cmd_search)

    sp = sub.add_parser("summary", help="episode digest (JSON 带 span 指针; --pretty 文本)")
    _add_common(sp, timewin=False)
    sp.set_defaults(fn=cmd_summary)

    sp = sub.add_parser("logs", help="app 日志 (obs)")
    sp.add_argument("--grep", default=None)
    sp.add_argument("--level", default=None)
    _add_common(sp)
    sp.set_defaults(fn=cmd_logs)

    sp = sub.add_parser("metrics", help="timing/counter 聚合 (p95 倒序)")
    _add_common(sp, timewin=False)
    sp.set_defaults(fn=cmd_metrics)

    sp = sub.add_parser("slow", help="长等待: timing p95 倒序 + 最慢 span")
    sp.add_argument("--top", type=int, default=10)
    _add_common(sp)
    sp.set_defaults(fn=cmd_slow)

    sp = sub.add_parser("failures", help="失败聚类 (--by/--locate/--rank)")
    sp.add_argument(
        "--by", choices=["error_class", "tool", "stage", "component"], default="error_class"
    )
    sp.add_argument("--locate", action="store_true", help="附代表 span 定位 + 首错")
    sp.add_argument("--rank", action="store_true", help="(默认已按 count+recency 排序)")
    _add_common(sp)
    sp.set_defaults(fn=cmd_failures)

    sp = sub.add_parser("usage", help="token 聚合")
    sp.add_argument(
        "--by",
        choices=["model", "tool", "component", "task_run", "session", "kind"],
        default="model",
    )
    _add_common(sp)
    sp.set_defaults(fn=cmd_usage)

    sp = sub.add_parser("diff", help="两 run 对比 (摘要+首分歧)")
    sp.add_argument("run_a")
    sp.add_argument("run_b")
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_diff)

    sp = sub.add_parser("cohort-diff", help="队列级 A/B (--by harness_version|window)")
    sp.add_argument("--by", choices=["harness_version", "window"], default="harness_version")
    sp.add_argument("--a", required=True, help="队列 A (版本号 或 时间表达式)")
    sp.add_argument("--b", required=True, help="队列 B")
    _add_common(sp)
    sp.set_defaults(fn=cmd_cohort_diff)

    sp = sub.add_parser("attribute", help="单 run 归因: 首错 span + 上下文 + agent")
    sp.add_argument("run")
    sp.add_argument("--context", type=int, default=3)
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_attribute)

    sp = sub.add_parser("loops", help="重复/停滞检测")
    sp.add_argument("--min-repeat", dest="min_repeat", type=int, default=3)
    _add_common(sp)
    sp.set_defaults(fn=cmd_loops)

    sp = sub.add_parser("trajectory", help="轨迹叙事 + 记分卡 + 空转 flags")
    sp.add_argument("--run", default=None)
    _add_common(sp)
    sp.set_defaults(fn=cmd_trajectory)

    sp = sub.add_parser("provenance", help="内容溯源: 首跳 + 通道 + 传播链")
    sp.add_argument("text")
    sp.add_argument("--first", action="store_true", help="只回首跳")
    sp.add_argument("--chain", action="store_true", help="(默认即传播链)")
    _add_common(sp)
    sp.set_defaults(fn=cmd_provenance)

    sp = sub.add_parser("why", help="失败分层归因 schema/prompt/harness/model (§5.4)")
    sp.add_argument("target", help="span_id 前缀 或 task_run_id 前缀")
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_why)

    sp = sub.add_parser("evidence", help="Reviewer 证据包 (自包含 JSON)")
    sp.add_argument("run")
    sp.add_argument(
        "--include-actions",
        dest="include_actions",
        action="store_true",
        help="附上该 session/run 的 service action envelope (35 §9)",
    )
    sp.add_argument(
        "--actions-db",
        dest="actions_db",
        type=Path,
        help="product action SQLite path (or set DAMOATRACE_ACTIONS_DB)",
    )
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_evidence)

    sp = sub.add_parser("distill", help="经验蒸馏素材 (确定性候选)")
    _add_common(sp)
    sp.set_defaults(fn=cmd_distill)

    sp = sub.add_parser(
        "actions", help="动作流 / --sequences 频繁子序列 / --source service 产品操作 envelope"
    )
    sp.add_argument("--sequences", action="store_true")
    sp.add_argument("--min-count", dest="min_count", type=int, default=2)
    sp.add_argument(
        "--source",
        choices=["trace", "service"],
        default="trace",
        help="trace=trace 动作流 (默认); service=SERVICE_ACTIONS_DB 产品操作 (35 §9)",
    )
    sp.add_argument("--src", help="service 库内 source 列过滤 (webui/cli/agent_tool/scheduler)")
    sp.add_argument("--namespace", help="service action namespace (research/serve/cases/...)")
    sp.add_argument("--since-seq", dest="since_seq", type=int, default=0)
    sp.add_argument(
        "--actions-db",
        dest="actions_db",
        type=Path,
        help="product action SQLite path (or set DAMOATRACE_ACTIONS_DB)",
    )
    _add_common(sp)
    sp.set_defaults(fn=cmd_actions)

    sp = sub.add_parser("sql", help="DuckDB 逃生口 (视图: trace/logs/metrics)")
    sp.add_argument("sql_query")
    _add_common(sp, session=False, timewin=False)
    sp.set_defaults(fn=cmd_sql)

    sp = sub.add_parser("errors", help="失败 event 流")
    _add_common(sp)
    sp.set_defaults(fn=cmd_errors)

    sp = sub.add_parser("llms", help="LLM 调用 + 用量")
    _add_common(sp)
    sp.set_defaults(fn=cmd_llms)

    sp = sub.add_parser("tools", help="tool 调用 + 输入预览")
    _add_common(sp)
    sp.set_defaults(fn=cmd_tools)

    sp = sub.add_parser("export", help="导出 session (jsonl/json/digest)")
    sp.add_argument("--format", choices=["jsonl", "json", "digest"], default="jsonl")
    sp.add_argument("--out", default=None)
    _add_common(sp, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_export)

    sp = sub.add_parser("stats", help="trace 目录统计")
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_stats)

    sp = sub.add_parser("clean", help="按 mtime 删老 jsonl (先列受影响 session)")
    sp.add_argument("--older-than", dest="older_than", required=True)
    sp.add_argument("--dry-run", dest="dry_run", action="store_true")
    _add_common(sp, session=False, timewin=False, limit=False)
    sp.set_defaults(fn=cmd_clean)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.trace_file is not None or args.trace_dir is not None:
        if args.cmd not in OFFLINE_COMMANDS:
            parser.error(f"{args.cmd} is not available for offline evidence")
        selected = (args.trace_file or args.trace_dir).expanduser().resolve()
        if args.trace_file is not None and not selected.is_file():
            parser.error("trace file does not exist")
        if args.trace_dir is not None and not selected.is_dir():
            parser.error("trace directory does not exist")
        snapshot_at = None
        if args.trace_dir is not None:
            try:
                snapshot_at = verify_diagnostic_directory(selected)
            except (OSError, ValueError) as error:
                parser.error(str(error))
        args.evidence_store = TraceStore(
            selected.parent if args.trace_file is not None else selected,
            trace_file=selected if args.trace_file is not None else None,
            offline=True,
            include_content=getattr(args, "include_content", False),
            snapshot_at=snapshot_at,
        )
    t0 = time.time()
    try:
        rc = args.fn(args)
    except BrokenPipeError:
        return EXIT_OK
    except (OSError, UnicodeError, UnsupportedContentVersion) as error:
        _diag(f"Trace query failed ({type(error).__name__}): {error}")
        return EXIT_ERROR
    _diag(f"[{args.cmd}] {int((time.time() - t0) * 1000)}ms")
    return rc


if __name__ == "__main__":
    sys.exit(main())
