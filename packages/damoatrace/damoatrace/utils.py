"""damoatrace utils — 跨模块共用的纯函数 (无状态/无 I/O)。

三类: 时间解析 (parse_ts/parse_since/percentile) · 事件分类映射
(span_type/agent_identity/session_role + KIND/NOISE 表) · 成本估算
(estimate_cost + 价格表)。cli/data/search/evidence/server 各面共用。
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

# ───────────────────────── 数据映射 helpers (TraceEvent → UI 模型) ─────────────────────────


def _parse_ts(value: Any) -> Optional[float]:
    """ISO8601 (naive 或带 tz) → epoch 秒. 解析失败返回 None.

    tracer 落盘的 started_at 是 naive **UTC** (datetime.utcnow), 不能按本地时区解释
    (否则 UTC+8 环境一切显示偏早 8 小时), naive 一律按 UTC 处理。
    """
    if not value:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value)
    try:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except Exception:  # noqa: BLE001
        return None


# kind → UI span type (root/llm/tool/user/retrieval/system). 决定瀑布图颜色 + 详情 badge。
_KIND_TYPE = {
    "task.start": "root",
    "llm.stream": "llm",
    "agent.response": "llm",
    "side.query": "llm",
    "tool.exec": "tool",
    "tool.dispatch": "tool",
    "tool.reload": "tool",
    "user.message": "user",
    "hil.request": "user",
    "hil.response": "user",
    "memory": "retrieval",
    "memory.recall": "retrieval",
    "memory.write": "retrieval",
    "memory.inject": "retrieval",
    "subagent.start": "subagent",
    "subagent.stop": "subagent",
    "turn.start": "turn",
}

# 高噪声 kind: 默认在瀑布图里折叠 (一个 turn 可能有几十上百条)，可在 UI 里一键展开。
# 注意 turn.start 不算噪声 —— 它是有 duration 的真 span, 在 UI 里作为一级分组节点 (Turn k)。
_NOISE_KINDS = frozenset(
    {
        "hook.fire",
        "prompt.stage",
        "prompt.block",
        "turn.end",
        "run.outcome",
        "mode.transition",
        "background",
        "bootstrap",
        "policy.rule.added",
        "reminder.registered",
        "reminder.expired",
        "reminder.injected",
        "cache.hit",
        "cache.miss",
        "backend.fallback",
        "middleware.run",
        "channel.receive",
        "channel.send",
        "evolve.signal",
        "evolve.write",
    }
)


def _span_type(kind: str) -> str:
    if kind in _KIND_TYPE:
        return _KIND_TYPE[kind]
    head = (kind or "").split(".", 1)[0]
    return {
        "llm": "llm",
        "tool": "tool",
        "user": "user",
        "memory": "retrieval",
        "hil": "user",
        "subagent": "subagent",
        "task": "root",
        "turn": "turn",
    }.get(head, "system")


def _agent_identity(component_id: Optional[str]) -> Dict[str, Any]:
    """从 component_id (agent:NAME@ver / agent:subagent:NAME@ver) 解析 agent 身份。

    返回 {agent: 短名, agentId: 原始, role: main|subagent}。
    """
    cid = component_id or ""
    body = cid[len("agent:") :] if cid.startswith("agent:") else cid
    body = body.split("@", 1)[0]
    role = "main"
    if body.startswith("subagent:"):
        role = "subagent"
        body = body[len("subagent:") :]
    return {"agent": body or None, "agentId": cid or None, "role": role}


def _session_role(session_id: str) -> str:
    """按 session_id 命名约定粗分 agent 角色 (侧栏分组用)。"""
    s = session_id or ""
    if s.startswith("sub_"):
        return "subagent"
    if "worker" in s or "memory" in s or "consolidator" in s or "organizer" in s:
        return "worker"
    if s.startswith("workflow") or s.startswith("planner"):
        return "workflow"
    if s == "_orphan":
        return "background"
    return "main"


# 估算成本: 每百万 token 美元 (input / output)。trace 自带 cost_usd 时优先用真值，
# 否则按 model 前缀估一个近似值 (UI 里标注为估算)。价格随官方调整，仅供长等待/花费排查参考。
_PRICE_PER_MTOK = {
    "opus": (15.0, 75.0),
    "sonnet": (3.0, 15.0),
    "haiku": (0.80, 4.0),
}


def _estimate_cost(model: Optional[str], usage: Optional[Dict[str, Any]]) -> Optional[float]:
    if not usage:
        return None
    direct = usage.get("cost_usd")
    if direct is not None:
        try:
            return float(direct)
        except (TypeError, ValueError):
            pass
    if not model:
        return None
    lo = str(model).lower()
    price = next((p for key, p in _PRICE_PER_MTOK.items() if key in lo), None)
    if not price:
        return None
    pin, pout = price
    inp = float(usage.get("input_tokens") or 0) + float(usage.get("cache_creation_tokens") or 0)
    cache_read = float(usage.get("cache_read_tokens") or 0)
    out = float(usage.get("output_tokens") or 0)
    # cache_read 约 0.1x input 价；cache_creation 约 1.25x，这里粗估按 input 价计入。
    return round((inp * pin + cache_read * pin * 0.1 + out * pout) / 1_000_000, 6)


def _parse_since(spec: str) -> Optional[float]:
    """'30s' / '5m' / '2h' / '3d' / ISO8601 → epoch 秒 (相对当前)。失败返回 None。"""
    spec = (spec or "").strip()
    if not spec:
        return None
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    if spec[-1] in units and spec[:-1].replace(".", "", 1).isdigit():
        return time.time() - float(spec[:-1]) * units[spec[-1]]
    return _parse_ts(spec)


def _percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)
