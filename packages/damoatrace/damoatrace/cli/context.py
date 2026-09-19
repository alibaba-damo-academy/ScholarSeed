"""``python -m damoatrace context <sid|--latest>`` — context-ledger 证据投影 (02/03; Evidence Contract v1).

对一个 session 回答"context 这一轮怎么演化的":

- 默认: channel 生命周期 operation 摘要 + 压缩血缘 run (token before/after/saved) + 每条指针地址;
- ``--visible``: 改看每次 compose 的 model-visible working set (used/excluded/rendered_hash/
  visible_index_id 指针)。
- ``--expand``: 在 ``--visible`` 输出中展开 visible-index 指向的持久化 context entries。

数据源 = trace jsonl 里 ``kind == "context"`` 的 event (ContextLedger 落账), 经 ``TraceStore`` 读取
(与其余 damoatrace CLI 同一读面, 带 session 归属 + 缓存)。只读, 无副作用, damoatrace 不是语义
source of truth —— 只投影已落账的 trace 证据。

用法:
    python -m damoatrace context --latest
    python -m damoatrace context <session-prefix> --pretty
    python -m damoatrace context --latest --visible
    python -m damoatrace context --latest --visible --expand
    python -m damoatrace context --task-run-id=<trid> -f json | jq '.compactions[].token_saved'
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict, List, Optional

from damoatrace.data.store import TraceStore
from damoatrace.evidence.context import context_evidence
from damoatrace.evidence.visible import visible_evidence
from damoatrace.paths import TRACE_DIR

_FORMAT_JSON = "json"
_FORMAT_PRETTY = "pretty"
VISIBLE_INDEX_KEY = "visible_index_id"
VISIBLE_ENTRIES_KEY = "entries"


def _resolve_session(
    store: TraceStore,
    *,
    session: Optional[str],
    task_run_id: Optional[str],
    latest: bool,
) -> Optional[str]:
    if task_run_id:
        for e in store.all_events():
            if e.get("kind") == "task.start":
                attrs = e.get("attributes") or {}
                if e.get("task_run_id") == task_run_id and attrs.get("session_id"):
                    return attrs["session_id"]
        print(f"no session for task-run-id {task_run_id!r}", file=sys.stderr)
        return None
    rows = store.sessions()
    if session:
        cands = [r["session_id"] for r in rows if str(r["session_id"]).startswith(session)]
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
        dated = [r for r in rows if r.get("last_at")]
        if not dated:
            return None
        return max(dated, key=lambda r: r.get("last_at") or "")["session_id"]
    return None


def _print_pretty(payload: Dict[str, Any], *, visible: bool, expanded: bool) -> None:
    lines: List[str] = [
        f"# context {'visible' if visible else 'ops'} — session {payload['session_id']}"
    ]
    if visible:
        t = payload["totals"]
        lines.append(
            f"  model calls={t['model_calls']} used_total={t['used_total']} "
            f"excluded_total={t['excluded_total']}"
        )
        for s in payload["snapshots"]:
            lines.append(
                f"    {s['at']}  used={s['used']} excluded={s['excluded']} "
                f"hash={s['rendered_hash']} final_wire={s.get('final_wire_hash')} "
                f"epoch={s.get('cache_epoch_id')} upper={s.get('upper_bound_input_tokens')} "
                f"watermark={s.get('watermark')} media={s.get('media_occurrences')} "
                f"visible_index={s['visible_index_id']}"
            )
            if expanded:
                for entry in s.get(VISIBLE_ENTRIES_KEY, []):
                    item = entry.get("item") or {}
                    lines.append(
                        f"      [{entry.get('ordinal')}] {entry.get('channel_id')} "
                        f"{entry.get('item_id')}: {item.get('content')!r}"
                    )
        print("\n".join(lines))
        return
    t = payload["totals"]
    lines.append(
        f"  ops={t['ops']} composes={t['composes']} compactions={t['compactions']} "
        f"token_saved={t['token_saved']}"
    )
    if payload["channels"]:
        lines.append("  channels: " + ", ".join(f"{k}={v}" for k, v in payload["channels"].items()))
    if payload["op_kinds"]:
        lines.append("  op kinds: " + ", ".join(f"{k}={v}" for k, v in payload["op_kinds"].items()))
    for c in payload["compactions"]:
        lines.append(
            f"    compaction {c['run_id']}  {c['token_before']}→{c['token_after']} "
            f"(saved {c['token_saved']}) edges={c['edges']} sources={c['sources']}"
        )
    print("\n".join(lines))


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="damoatrace context", description="context-ledger 证据投影 (02/03)"
    )
    p.add_argument("session", nargs="?", default=None, help="session id / prefix")
    p.add_argument(
        "--session", dest="session_opt", default=None, help="session id / prefix (同位置参数)"
    )
    p.add_argument(
        "--task-run-id", dest="task_run_id", default=None, help="按 task_run_id 定位 session"
    )
    p.add_argument("--latest", action="store_true", help="最近一个 session")
    p.add_argument(
        "--visible", action="store_true", help="看 model-visible working set (compose) 而非 ops"
    )
    p.add_argument(
        "--expand",
        action="store_true",
        help="展开 --visible 中 visible-index 指向的持久化 context entries",
    )
    p.add_argument("--pretty", action="store_true", help="人读文本 (默认 JSON)")
    p.add_argument("-f", "--format", choices=(_FORMAT_JSON, _FORMAT_PRETTY), default=None)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = _build_parser().parse_args(argv if argv is not None else sys.argv[1:])
    store = TraceStore(TRACE_DIR)
    session_id = _resolve_session(
        store,
        session=args.session or args.session_opt,
        task_run_id=args.task_run_id,
        latest=args.latest,
    )
    if not session_id:
        print(
            "no session selected (use <sid> / --session / --latest / --task-run-id)",
            file=sys.stderr,
        )
        return 2
    events = store.session_events(session_id)
    if args.expand and not args.visible:
        print("--expand requires --visible", file=sys.stderr)
        return 2
    if args.visible:
        payload = visible_evidence(events, session_id=session_id)
        if args.expand:
            for snapshot in payload["snapshots"]:
                visible_index_id = str(snapshot.get(VISIBLE_INDEX_KEY) or "")
                expanded = (
                    store.session_visible_index(session_id, visible_index_id)
                    if visible_index_id
                    else None
                )
                snapshot[VISIBLE_ENTRIES_KEY] = (
                    list(expanded.get(VISIBLE_ENTRIES_KEY) or []) if expanded else []
                )
    else:
        payload = context_evidence(events, session_id=session_id)
    pretty = args.pretty or args.format == _FORMAT_PRETTY
    if pretty:
        _print_pretty(payload, visible=args.visible, expanded=args.expand)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
