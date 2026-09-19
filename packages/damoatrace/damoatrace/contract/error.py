"""proto/trace/error.py — trace 失败分类 + 错误 record (06 §8.1)。"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Optional


class ErrorClass(str, Enum):
    """trace 失败四桶分类 (06 §8.1; evolve 归因 + failure_patterns 分组的统一维度)。"""

    PARSE = "parse"  # 输出/参数解析失败
    CONTRACT_MISMATCH = "contract_mismatch"  # 用错工具 / 参数语义不符 / 越权被拒
    TRAJECTORY_DEGENERATE = "trajectory_degenerate"  # 轨迹退化 (循环/停滞/超 budget/取消)
    REASONING = "reasoning"  # 推理错误 (逻辑/事实/任务理解); 兜底桶


@dataclass
class TraceError:
    """trace event 失败时的错误。"""

    code: str
    message: str
    error_class: Optional[str] = None  # ★Phase0: ErrorClass value (四桶); None=未分类
