"""trace digest — 把一个 session 的事件按 turn / LLM call 顺序摊平, 帮你 30 秒读懂这轮跑了啥.

输出格式 (示意):

    Session abc123… — workdir=/foo, turns=3, tool_calls=8, errors=1

    ── turn 1  06:29:44 → 06:29:45 (420ms) ──
      LLM  claude-opus-4-7  in=1200/out=80  cache_r=800  stop=tool_use
        ⚙ Read(file_path=…) → ok  8ms
        ⚙ Bash(command=…)   → ERROR PermissionDenied: policy=ask denied
      ↩ assistant: "好, 我来读这个文件…"

每个 turn 块:
  1. turn span 的开始/结束时间 + 时长
  2. LLM call (turn 里的 llm.stream span) 的 model / tokens / stop_reason
  3. 该 LLM call 之后的 tool.exec spans (即本轮被调度的 tool), 按时间顺序
  4. assistant 回复文本预览 (从 agent.response event 拿, 如果有)

用法:
    python -m trace digest --latest                  # 最近一个 session
    python -m trace digest --session=<full-or-prefix>
    python -m trace digest --task-run-id=<trid>
    python -m trace digest --latest --include-content  # 显示 tool 输出 / LLM 回复全文
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from damoatrace.paths import TRACE_DIR

# ───────────────────────── 数据读取 ─────────────────────────


def _iter_events(trace_dir: Path) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for p in sorted(trace_dir.glob("*.jsonl")):
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        except OSError:
            continue
    return out


def _resolve_session(
    events: List[Dict[str, Any]],
    *,
    session: Optional[str] = None,
    task_run_id: Optional[str] = None,
    latest: bool = False,
) -> Optional[str]:
    """返回完整的 session_id (用了 prefix 时), 或 None."""
    # build task_run → session map from task.start events
    tr2sid: Dict[str, str] = {}
    sid_last_seen: Dict[str, str] = {}  # session_id → latest started_at
    for e in events:
        if e.get("kind") == "task.start":
            sid = (e.get("attributes") or {}).get("session_id")
            if sid:
                tr2sid[e["task_run_id"]] = sid
                t = e.get("started_at") or ""
                if t > sid_last_seen.get(sid, ""):
                    sid_last_seen[sid] = t

    if task_run_id:
        return tr2sid.get(task_run_id)
    if session:
        cands = [sid for sid in sid_last_seen if sid.startswith(session)]
        if len(cands) == 1:
            return cands[0]
        if not cands:
            print(f"no session matches prefix {session!r}", file=sys.stderr)
            return None
        print(f"ambiguous prefix {session!r}; matches:", file=sys.stderr)
        for c in cands:
            print(f"  {c}", file=sys.stderr)
        return None
    if latest:
        if not sid_last_seen:
            return None
        return max(sid_last_seen, key=lambda k: sid_last_seen[k])
    return None


def _events_for_session(events: List[Dict[str, Any]], session_id: str) -> List[Dict[str, Any]]:
    tr2sid: Dict[str, str] = {}
    for e in events:
        if e.get("kind") == "task.start":
            sid = (e.get("attributes") or {}).get("session_id")
            if sid:
                tr2sid[e["task_run_id"]] = sid
    out = [e for e in events if tr2sid.get(e.get("task_run_id", "")) == session_id]
    out.sort(key=lambda e: e.get("started_at") or "")
    return out


# ───────────────────────── span tree helpers ─────────────────────────

# ───────────────────────── 摘要逻辑 ─────────────────────────


def _short_iso(s: Optional[str]) -> str:
    if not s:
        return "—"
    # 06:29:44.123
    if "T" in s:
        return s.split("T", 1)[1][:12]
    return s[:12]


def _short_json(d: Any, max_len: int) -> str:
    try:
        s = json.dumps(d, ensure_ascii=False, default=str)
    except Exception:
        s = str(d)
    if len(s) > max_len:
        s = s[:max_len] + "…"
    return s


def digest(
    events: List[Dict[str, Any]],
    session_id: str,
    *,
    include_content: bool = False,
    max_content: int = 200,
) -> str:
    """返回 session 的 turn-by-turn digest 文本.

    用 task_run_id + 时间范围聚合 — 不依赖 parent_span_id 链是否完整
    (实际 runtime 用 async ctx mgr 自动维护栈, 但本地手写脚本 / 旧 trace
     可能没链上). 实现:
      1. 找到所有 turn.start (按 task_run_id 分组)
      2. 把同 task_run_id 里, started_at 落在 [turn.start.start, turn.start.end]
         区间的 llm.stream / tool.exec / agent.response 都算作该 turn 的内容
      3. tool 按时间归到时间上最近的 (之前的) llm.stream
    """
    sess_events = _events_for_session(events, session_id)
    if not sess_events:
        return f"session {session_id} has no events"

    first_task_start = next((e for e in sess_events if e.get("kind") == "task.start"), None)
    workdir = (
        (first_task_start.get("attributes") or {}).get("workdir", "?") if first_task_start else "?"
    )
    turn_starts = [e for e in sess_events if e.get("kind") == "turn.start"]
    tool_total = sum(1 for e in sess_events if e.get("kind") == "tool.exec")
    err_total = sum(1 for e in sess_events if e.get("status") not in (None, "ok"))

    lines: List[str] = []
    lines.append(f"Session {session_id[:16]}…  workdir={workdir}")
    lines.append(
        f"  turns={len(turn_starts)}  tool_calls={tool_total}  errors={err_total}  events={len(sess_events)}"
    )
    lines.append("")

    # turn 列表: 用 turn.start; 没 turn.start 时, 用 task.start 当 turn
    turns = turn_starts or [e for e in sess_events if e.get("kind") == "task.start"]
    turns = sorted(turns, key=lambda e: e.get("started_at") or "")

    def _in_range(ev: Dict[str, Any], lo: str, hi: str, trid: str) -> bool:
        if ev.get("task_run_id") != trid:
            return False
        t = ev.get("started_at") or ""
        if not t:
            return False
        return lo <= t <= hi if hi else lo <= t

    for i, turn in enumerate(turns, 1):
        trid = turn.get("task_run_id", "")
        lo = turn.get("started_at") or ""
        hi_self = turn.get("ended_at") or ""
        # 下一个同 task_run 的 turn 的 start, 防止 turn 时间重叠时跨界把对方的 LLM 也抢过来
        next_starts = [t.get("started_at") or "" for t in turns[i:] if t.get("task_run_id") == trid]
        next_lo = min(next_starts) if next_starts else ""
        # hi = min(turn.end, next_turn.start), 任一为空就用另一个; 都空就 "9999"
        candidates = [x for x in (hi_self, next_lo) if x]
        hi = min(candidates) if candidates else "9999"

        started = _short_iso(lo)
        ended = _short_iso(turn.get("ended_at"))
        dur = turn.get("duration_ms") or 0
        lines.append(f"── turn {i}  {started} → {ended} ({dur}ms)  task_run={trid[:8]} ──")

        llms = sorted(
            (
                e
                for e in sess_events
                if e.get("kind") == "llm.stream" and _in_range(e, lo, hi, trid)
            ),
            key=lambda e: e.get("started_at") or "",
        )
        tools = sorted(
            (e for e in sess_events if e.get("kind") == "tool.exec" and _in_range(e, lo, hi, trid)),
            key=lambda e: e.get("started_at") or "",
        )
        responses = sorted(
            (
                e
                for e in sess_events
                if e.get("kind") == "agent.response" and _in_range(e, lo, hi, trid)
            ),
            key=lambda e: e.get("started_at") or "",
        )

        # 把 tools 归到 (started_at 之前最后一个) LLM call
        tools_by_llm: Dict[int, List[Dict[str, Any]]] = {idx: [] for idx in range(len(llms))}
        unattached_tools: List[Dict[str, Any]] = []
        for t in tools:
            t_start = t.get("started_at") or ""
            chosen_idx = None
            for idx, l in enumerate(llms):
                if (l.get("ended_at") or l.get("started_at") or "") <= t_start:
                    chosen_idx = idx
                else:
                    break
            if chosen_idx is None:
                unattached_tools.append(t)
            else:
                tools_by_llm[chosen_idx].append(t)

        for idx, l in enumerate(llms):
            _print_llm(lines, l)
            for t in tools_by_llm[idx]:
                _print_tool(lines, t, include_content=include_content, max_content=max_content)

        # 没归到任何 LLM 的 tool 单独印 (例如 turn 开头就触发的 tool)
        if unattached_tools:
            lines.append("  (tools before any LLM call:)")
            for t in unattached_tools:
                _print_tool(lines, t, include_content=include_content, max_content=max_content)

        for r in responses:
            attrs = r.get("attributes") or {}
            text = attrs.get("text") or _short_json(r.get("outputs"), max_content)
            if text:
                preview = (
                    text if include_content else (text[:120] + ("…" if len(text) > 120 else ""))
                )
                lines.append(f"  ↩ assistant: {preview}")

        lines.append("")

    return "\n".join(lines)


def _print_llm(lines: List[str], ev: Dict[str, Any]) -> None:
    attrs = ev.get("attributes") or {}
    usage = attrs.get("usage") or {}
    model = attrs.get("model", "?")
    stop = attrs.get("stop_reason") or "—"
    dur = ev.get("duration_ms") or 0
    head = (
        f"  LLM  {model}  in={usage.get('input_tokens', 0)}/out={usage.get('output_tokens', 0)}"
        f"  cache_r={usage.get('cache_read_tokens', 0)}  stop={stop}  {dur}ms"
    )
    if ev.get("status") not in (None, "ok"):
        head += f"  ⚠ {ev.get('status')}"
    lines.append(head)
    err = ev.get("error")
    if err:
        lines.append(f"      ERROR {err.get('code', '')}: {err.get('message', '')}")


def _print_tool(
    lines: List[str], ev: Dict[str, Any], *, include_content: bool, max_content: int
) -> None:
    attrs = ev.get("attributes") or {}
    name = attrs.get("tool_name") or ev.get("name", "?")
    inp = _short_json(ev.get("inputs"), 120)
    ok = ev.get("status") in (None, "ok")
    mark = "✓" if ok else "✗"
    dur = ev.get("duration_ms") or 0
    lines.append(f"    {mark} {name}({inp}) → {dur}ms")
    if not ok and ev.get("error"):
        e = ev["error"]
        lines.append(f"        ERROR {e.get('code', '')}: {e.get('message', '')}")
    if include_content:
        out = _short_json(ev.get("outputs"), max_content)
        if out and out != "null":
            lines.append(f"        ↪ {out}")


# ───────────────────────── CLI ─────────────────────────


def list_sessions(events: List[Dict[str, Any]], limit: int = 20) -> str:
    """单独 subcommand `list` — 列最近 N session, 给 --session 选."""
    seen: Dict[str, Dict[str, Any]] = {}
    for e in events:
        if e.get("kind") != "task.start":
            continue
        sid = (e.get("attributes") or {}).get("session_id")
        wd = (e.get("attributes") or {}).get("workdir")
        ts = e.get("started_at") or ""
        if not sid:
            continue
        s = seen.setdefault(sid, {"sid": sid, "workdir": wd, "first": ts, "last": ts, "runs": 0})
        s["runs"] += 1
        if ts < s["first"]:
            s["first"] = ts
        if ts > s["last"]:
            s["last"] = ts
    rows = sorted(seen.values(), key=lambda r: r["last"], reverse=True)[:limit]
    if not rows:
        return "(no sessions in trace dir)"
    out = ["sessions (most recent first):"]
    for r in rows:
        out.append(
            f"  {r['sid'][:16]}  runs={r['runs']:>3}  last={_short_iso(r['last'])}  {r['workdir'] or ''}"
        )
    return "\n".join(out)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="python -m trace digest",
        description="按 turn / LLM call 顺序输出 session 的 tool + 回复摘要",
    )
    p.add_argument("--session", help="session_id (完整或前缀)")
    p.add_argument("--task-run-id", help="task_run_id (任一即可)")
    p.add_argument("--latest", action="store_true", help="挑最新的 session")
    p.add_argument("--list", action="store_true", help="列最近 session 后退出")
    p.add_argument(
        "--include-content",
        action="store_true",
        help="显示 tool outputs 和 assistant 全文 (默认只预览)",
    )
    p.add_argument(
        "--max-content",
        type=int,
        default=200,
        help="content 截断长度 (默认 200, 配合 --include-content)",
    )
    p.add_argument("--trace-dir", default=None, help=f"trace 目录 (默认: {TRACE_DIR})")
    args = p.parse_args(argv)

    tdir = Path(args.trace_dir).expanduser() if args.trace_dir else TRACE_DIR
    if not tdir.exists():
        print(f"trace dir not found: {tdir}", file=sys.stderr)
        return 2
    events = _iter_events(tdir)
    if not events:
        print(f"no events in {tdir}", file=sys.stderr)
        return 2

    if args.list:
        print(list_sessions(events))
        return 0

    sid = _resolve_session(
        events, session=args.session, task_run_id=args.task_run_id, latest=args.latest
    )
    if sid is None:
        if not (args.session or args.task_run_id or args.latest):
            print("specify --latest / --session / --task-run-id / --list", file=sys.stderr)
        return 2

    print(digest(events, sid, include_content=args.include_content, max_content=args.max_content))
    return 0


if __name__ == "__main__":
    sys.exit(main())
