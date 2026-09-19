"""
Step 2: Reading Depth 决策 + 内容准备 + Partial 截断
"""
from __future__ import annotations

import re


# ============================================================================
# Reading Depth Logic
# ============================================================================

def _has_full_text(paper_info_entry: dict) -> bool:
    """Check if paper_info entry has full text (sections/sentences with content)."""
    parse_dict = paper_info_entry.get("parse_dict")
    if isinstance(parse_dict, dict):
        sections = parse_dict.get("sections", [])
    else:
        sections = paper_info_entry.get("sections") or paper_info_entry.get("sentences") or []
    return bool(sections)


def _get_sections(paper_info_entry: dict) -> list:
    """Extract sections from paper_info entry, supporting sections/sentences/parse_dict."""
    parse_dict = paper_info_entry.get("parse_dict")
    if isinstance(parse_dict, dict):
        return parse_dict.get("sections", [])
    return paper_info_entry.get("sections") or paper_info_entry.get("sentences") or []


def _determine_reading_depth(relevance_level: str, has_full_text: bool) -> str:
    """Map relevance_level + has_full_text to reading depth."""
    if not has_full_text:
        return "metadata_only"
    if relevance_level == "L3":
        return "metadata_only"
    if relevance_level == "L2":
        return "partial"
    # L1 (default)
    return "full"


# Partial 模式动态截断参数
# 策略：≤ NO_TRIM_THRESHOLD 不截断；超过则取前 TRIM_RATIO，上限 TRIM_CAP
PARTIAL_NO_TRIM_THRESHOLD = 60000   # ≤ 60k 不截断 (覆盖 ~62% 论文)
PARTIAL_TRIM_RATIO = 0.70           # 取前 70%
PARTIAL_TRIM_CAP = 80000            # 最多保留 80k chars ≈ 20k tokens

_SENT_LINE_RE = re.compile(r"^#(\d+)\s+(.*)$")


def _parse_sentences_index(sentences_blob: str) -> dict[int, str]:
    """Parse sentences text (with #N prefix) into {id: text} dict."""
    idx: dict[int, str] = {}
    for line in sentences_blob.splitlines():
        m = _SENT_LINE_RE.match(line)
        if m:
            idx[int(m.group(1))] = m.group(2)
    return idx


def _number_abstract_sentences(abstract: str) -> str:
    """Split abstract into sentences and add #N prefix for source_map tracing."""
    import re as _re
    sentences = _re.split(r'(?<=[.!?])\s+', abstract.strip())
    sentences = [s.strip() for s in sentences if s.strip()]
    if not sentences:
        return abstract
    return "\n".join(f"#{i + 1} {s}" for i, s in enumerate(sentences))


def trim_content_partial(text: str) -> tuple[str, bool]:
    """Partial 模式动态截断。

    策略：
      - ≤ 60k chars：不截断
      - > 60k chars：取前 min(len * 0.7, 80k) chars，按行边界截断
    """
    if len(text) <= PARTIAL_NO_TRIM_THRESHOLD:
        return text, False
    budget = min(int(len(text) * PARTIAL_TRIM_RATIO), PARTIAL_TRIM_CAP)
    # 按行边界截断，保证 #N 行完整性
    kept: list[str] = []
    used = 0
    for line in text.splitlines(keepends=True):
        if used + len(line) > budget and kept:
            break
        kept.append(line)
        used += len(line)
    # 兜底：如果没有换行符，直接按字符截断
    if not kept:
        return text[:budget] + "\n\n[...content truncated...]", True
    return "".join(kept) + "\n\n[...content truncated...]", True
