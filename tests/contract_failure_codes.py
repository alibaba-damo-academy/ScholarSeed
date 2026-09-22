"""Provider failure codes must stay classified on both sides of the adapter/desktop seam."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from scholarseed_codex.failure import CODEX_PROVIDER_FAILED, provider_codes

ROOT = Path(__file__).resolve().parents[1]
RENDERER_FAILURES = ROOT / "apps/desktop/src/renderer/src/failures.ts"
KIND_TABLE = re.compile(r"FAILURE_KIND_BY_CODE[^=]*=\s*\{(.*?)\n\}", re.DOTALL)
KIND_ENTRY = re.compile(r"^\s*'?([A-Za-z0-9_.-]+)'?\s*:\s*'", re.MULTILINE)
# 解析退化会让守卫假绿，两侧各钉一个已知码作哨兵。
SENTINEL = "insufficient_quota"


def adapter_codes() -> set[str]:
    return {code.casefold() for code in provider_codes()}


def renderer_codes() -> set[str]:
    source = RENDERER_FAILURES.read_text(encoding="utf-8")
    table = KIND_TABLE.search(source)
    if table is None:
        raise AssertionError(f"FAILURE_KIND_BY_CODE not found in {RENDERER_FAILURES}")
    return {entry.group(1).casefold() for entry in KIND_ENTRY.finditer(table.group(1))}


class FailureCodeParityContract(unittest.TestCase):
    def test_vocabulary_is_parsed_not_empty(self):
        self.assertIn(SENTINEL, adapter_codes())
        self.assertIn(SENTINEL, renderer_codes())

    def test_fallback_code_is_not_vocabulary(self):
        # codex_provider_failed 意为「一个码都没认出来」，不是可分类词表的一员；
        # 把它登记进任一侧都会让真正的兜底路径伪装成已分类。
        self.assertEqual(CODEX_PROVIDER_FAILED.casefold(), "codex_provider_failed")
        self.assertNotIn(CODEX_PROVIDER_FAILED.casefold(), adapter_codes())
        self.assertNotIn(CODEX_PROVIDER_FAILED.casefold(), renderer_codes())

    def test_every_adapter_code_reaches_a_classified_card(self):
        # 适配器能产出、渲染层却没登记的码会塌缩成 kind='unknown'：脱敏文案不命中任何
        # 兜底正则，用户只剩「生成过程中发生异常」，且拿不到可改变结果的下一步。
        self.assertEqual(
            adapter_codes() - renderer_codes(),
            set(),
            "adapter codes missing from FAILURE_KIND_BY_CODE",
        )

    def test_renderer_registers_no_dead_code(self):
        self.assertEqual(
            renderer_codes() - adapter_codes(),
            set(),
            "FAILURE_KIND_BY_CODE entries the adapter never emits",
        )


if __name__ == "__main__":
    unittest.main()
