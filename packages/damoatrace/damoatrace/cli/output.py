"""damoatrace CLI 输出层 — Evidence Contract envelope + JSON/表格格式化 + --fail-if 判定 (proposal 26 §5.0/§5.2).

从 damoatrace/query.py 拆出 CLI 的输出基元:
- 退出码常量、各命令保守默认投影 (_DEFAULT_FIELDS);
- _diag (stderr 诊断)、_project/_resolve_fields (字段投影)、_pretty_rows (人读表格);
- _emit (envelope 输出 + 投影 + fail-if)、_judge_fail_if (阈值判定 → 退出码 3)。
envelope/成败口径走 damoatrace.recording.records。
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Optional

import damoatrace.recording.records as _rec

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2
EXIT_FAILIF = 3  # --fail-if 阈值违反
EXIT_NOTFOUND = 4

# 各命令的保守默认投影 (--full 出全字段; --fields 自定义)
_DEFAULT_FIELDS: Dict[str, List[str]] = {
    "events": ["span_id", "kind", "name", "status", "duration_ms", "started_at"],
    "sessions": [
        "session_id",
        "role",
        "agents",
        "task_run_count",
        "errors",
        "last_at",
        "parent_session",
    ],
    "runs": [
        "task_run_id",
        "status",
        "error_class",
        "stop_reason",
        "turns",
        "harness_version",
        "session_id",
        "started_at",
    ],
    "logs": ["ts", "level", "logger", "event", "session_id"],
    "search": ["span_id", "kind", "name", "status", "session_id", "task_run_id", "started_at"],
    "llms": [
        "span_id",
        "name",
        "model",
        "duration_ms",
        "input_tokens",
        "output_tokens",
        "stop_reason",
        "started_at",
    ],
    "tools": ["span_id", "name", "status", "duration_ms", "input_preview", "started_at"],
    "errors": [
        "span_id",
        "kind",
        "name",
        "error_class",
        "error_message",
        "session_id",
        "task_run_id",
        "started_at",
    ],
}


# ───────────────────────── 输出基元 ─────────────────────────


def _diag(msg: str) -> None:
    print(msg, file=sys.stderr)


def _project(rows: List[Dict[str, Any]], fields: Optional[List[str]]) -> List[Dict[str, Any]]:
    if not fields:
        return rows
    return [{k: r.get(k) for k in fields if k in r or True} for r in rows]


def _resolve_fields(args, cmd: str) -> Optional[List[str]]:
    if getattr(args, "full", False):
        return None
    if getattr(args, "fields", None):
        return [f.strip() for f in args.fields.split(",") if f.strip()]
    return _DEFAULT_FIELDS.get(cmd)


def _pretty_rows(rows: List[Dict[str, Any]]) -> None:
    if not rows:
        print("(empty)")
        return
    cols = list(rows[0].keys())
    widths = {c: max(len(c), *(len(str(r.get(c, ""))[:48]) for r in rows)) for c in cols}
    print("  ".join(c.ljust(widths[c]) for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, ""))[:48].ljust(widths[c]) for c in cols))


def _emit(
    args,
    cmd: str,
    query: Dict[str, Any],
    rows: List[Dict[str, Any]],
    *,
    total: Optional[int] = None,
    truncated: bool = False,
    evidence: Optional[List[Dict[str, Any]]] = None,
    extra: Optional[Dict[str, Any]] = None,
) -> int:
    """envelope 输出 + --fields 投影 + --fail-if 判定。返回退出码。"""
    fields = _resolve_fields(args, cmd)
    store = getattr(args, "evidence_store", None)
    if store is not None:
        extra = {**(extra or {}), "completeness": store.completeness(query.get("session"))}
    out_rows = _project(rows, fields)
    env = _rec.envelope(
        {"cmd": cmd, **{k: v for k, v in query.items() if v is not None}},
        out_rows,
        total=total,
        truncated=truncated,
        evidence=evidence,
        extra=extra,
    )
    if getattr(args, "pretty", False):
        _pretty_rows(out_rows)
        if extra:
            print("--- extra ---")
            print(json.dumps(extra, ensure_ascii=False, indent=2, default=str)[:2000])
        if truncated:
            print(f"(truncated: showing {len(out_rows)}/{env['total']})")
    else:
        print(json.dumps(env, ensure_ascii=False, default=str))
    return _judge_fail_if(args, extra or {}, env)


_FAILIF_RE = re.compile(r"^\s*([A-Za-z_][\w.]*)\s*(>=|<=|>|<|==|!=)\s*([-\d.]+)\s*$")


def _judge_fail_if(args, scope: Dict[str, Any], env: Dict[str, Any]) -> int:
    expr = getattr(args, "fail_if", None)
    if not expr:
        return EXIT_OK
    m = _FAILIF_RE.match(expr)
    if not m:
        _diag(f"--fail-if 表达式无效: {expr!r} (形如 'error_rate>0.05')")
        return EXIT_USAGE
    field, op, raw = m.groups()
    # 取值: extra 优先, 其次 envelope 顶层 (total 等)
    val = scope.get(field, env.get(field))
    if isinstance(val, dict):
        val = None
    if val is None:
        _diag(
            f"--fail-if: 字段 {field!r} 不在本命令输出里 (可用: {sorted([k for k,v in scope.items() if isinstance(v,(int,float))])})"
        )
        return EXIT_USAGE
    try:
        lhs = float(val)
        rhs = float(raw)
    except (TypeError, ValueError):
        _diag(f"--fail-if: {field}={val!r} 不可比较")
        return EXIT_USAGE
    hit = {
        ">": lhs > rhs,
        ">=": lhs >= rhs,
        "<": lhs < rhs,
        "<=": lhs <= rhs,
        "==": lhs == rhs,
        "!=": lhs != rhs,
    }[op]
    if hit:
        _diag(f"fail-if 命中: {field}={lhs} {op} {rhs}")
        return EXIT_FAILIF
    return EXIT_OK
