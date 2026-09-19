"""proto/trace/record.py — 统一可观测事件 record (Evidence Contract; design 01-core-abi §2)。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from damoatrace.contract.error import TraceError


@dataclass
class TraceEvent:
    """统一可观测事件 (跟 design 01-core-abi §2 对齐)。"""

    id: str
    task_run_id: str
    span_id: str
    parent_span_id: Optional[str]

    kind: str  # EventKind value
    name: str

    started_at: datetime
    ended_at: Optional[datetime] = None
    duration_ms: Optional[int] = None

    session_id: str = ""
    component_id: Optional[str] = None
    artifact_paths: List[str] = field(default_factory=list)
    policy_decision_id: Optional[str] = None
    hil_session_id: Optional[str] = None

    attributes: Dict[str, Any] = field(default_factory=dict)
    inputs: Optional[Dict[str, Any]] = None
    outputs: Optional[Dict[str, Any]] = None
    status: Literal["ok", "error", "cancelled"] = "ok"
    error: Optional[TraceError] = None
