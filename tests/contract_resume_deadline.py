"""Renderer resume deadline must never undercut the server's own cold-resume budget.

渲染端对 `POST /api/serve/sessions/open` (以及复用同一常量的 history 拉取) 施加固定硬截止。
若该截止早于服务端冷恢复自身的预算 (readiness 预检 + 整体恢复), 一次合法但耗时较长的冷恢复
会先被客户端 abort, 报「signal timed out」并在全局 _open_lock 后盲目重试, 把正常慢恢复呈现为
失败——这是 Aone #87119853 的根因。本守卫把渲染端常量钉到服务端权威预算上, 使两侧无法再各自漂移。
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from scholarseed_codex.protocol.state import (
    CODEX_PREFLIGHT_TIMEOUT_SECONDS,
    CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS,
)

ROOT = Path(__file__).resolve().parents[1]
RENDERER_API = ROOT / "apps/desktop/src/renderer/src/api.ts"
# open 与 history 两跳复用同一常量, 守卫常量即同时覆盖这两个失败点。
RESUME_TIMEOUT = re.compile(r"RESUME_REQUEST_TIMEOUT_MS\s*=\s*(\d[\d_]*)")
# 解析退化会让守卫假绿: 钉一个哨兵确认确实读到了一个合理的毫秒值。
SENTINEL_MIN_MS = 1_000


def renderer_resume_deadline_ms() -> int:
    source = RENDERER_API.read_text(encoding="utf-8")
    match = RESUME_TIMEOUT.search(source)
    if match is None:
        raise AssertionError(f"RESUME_REQUEST_TIMEOUT_MS not found in {RENDERER_API}")
    return int(match.group(1).replace("_", ""))


def server_cold_resume_budget_seconds() -> float:
    # 冷恢复自预算上限 = readiness 预检 + 整体恢复预算; 单次 RPC 30s 是恢复内的子预算, 不叠加。
    return CODEX_PREFLIGHT_TIMEOUT_SECONDS + CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS


class ResumeDeadlineInversionContract(unittest.TestCase):
    def test_constant_is_parsed_not_degenerate(self):
        self.assertGreaterEqual(renderer_resume_deadline_ms(), SENTINEL_MIN_MS)

    def test_renderer_deadline_covers_server_cold_resume_budget(self):
        deadline_seconds = renderer_resume_deadline_ms() / 1000.0
        budget_seconds = server_cold_resume_budget_seconds()
        self.assertGreaterEqual(
            deadline_seconds,
            budget_seconds,
            "renderer RESUME_REQUEST_TIMEOUT_MS undercuts the server's own cold-resume budget "
            f"({budget_seconds:g}s = preflight {CODEX_PREFLIGHT_TIMEOUT_SECONDS:g} + recovery "
            f"{CODEX_RECOVERY_TOTAL_TIMEOUT_SECONDS:g}); a legitimate slow resume would be "
            "falsely reported as a client timeout (Aone #87119853)",
        )


if __name__ == "__main__":
    unittest.main()
