"""damoatrace usage rollup — 单 run 的事件/错误/token 汇总 (proposal 26).

从 damoatrace/query.py 拆出: _run_summary 把一个 task_run 的事件聚成
{events, errors, by_error_class, usage_total, action_seq}, 供 CLI 的 diff/evidence
等命令复用。成败/error_class 口径走 damoatrace.recording.records。
"""

from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List

import damoatrace.recording.records as _rec


def _run_summary(events: List[Dict[str, Any]], run_id: str) -> Dict[str, Any]:
    evs = [e for e in events if (e.get("task_run_id") or "").startswith(run_id)]
    errors = [e for e in evs if _rec.is_failed(e)]
    by_ec = Counter(_rec.error_class_of(e) for e in errors)
    usage = {"input_tokens": 0, "output_tokens": 0}
    for e in evs:
        u = (e.get("attributes") or {}).get("usage")
        if u:
            usage["input_tokens"] += int(u.get("input_tokens", 0) or 0)
            usage["output_tokens"] += int(u.get("output_tokens", 0) or 0)
    seq = [
        f"{e.get('kind')}:{e.get('name')}"
        for e in sorted(evs, key=lambda x: x.get("started_at") or "")
        if (e.get("kind") or "").split(".")[0] in ("llm", "tool", "user", "agent")
    ]
    return {
        "run": run_id,
        "events": len(evs),
        "errors": len(errors),
        "by_error_class": dict(by_ec),
        "usage_total": usage,
        "action_seq": seq,
    }
