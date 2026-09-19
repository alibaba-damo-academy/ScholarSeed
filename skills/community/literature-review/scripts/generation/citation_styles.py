"""Deterministic citation-style registry shared by generation and verification.

All supported LaTeX styles are vendored under ``assets/``.  The registry also
owns the examples shown to users and the metadata contract used by the corpus
audit; keeping those together prevents the menu from promising a style whose
renderer or required fields say something different.
"""
from __future__ import annotations

from pathlib import Path

import slr_paths


PAPERHUB_FIELD_AVAILABILITY = {
    "direct": {
        "author", "title", "year", "journal", "doi", "eprint",
    },
    "optional_or_upstream_bibtex": {
        "entry_type", "booktitle", "volume", "number", "pages", "publisher",
        "address", "location", "month", "date", "editor", "edition", "series",
        "organization", "institution", "school", "url",
    },
    "not_provided": {
        "accessed", "urldate", "translator", "originalyear",
    },
}


CITATION_STYLES: dict[str, dict] = {
    "numeric": {
        "label": "通用数字顺序制",
        "wanted": "unsrtnat_scholarseed",
        "bst": "unsrtnat_scholarseed",
        "asset": "assets/unsrtnat_scholarseed.bst",
        "natbib_options": "numbers,sort&compress",
        "fidelity": "exact",
        "inline_example": "……如已有研究所示 [1]。",
        "reference_example": (
            "[1] Alice Smith and Bo Li. Agentic Literature Review. "
            "Journal of Research, 2024."
        ),
        "required": ["author", "title"],
        "recommended": ["year"],
        "style_critical": ["journal|booktitle|publisher|doi|url|eprint"],
        "metadata_risk": "低：正文编号不依赖年份；缺失出版信息只会使文后条目较薄。",
        "note": (
            "方括号数字按首次引用顺序排列；作者超过十人时截断为 et al.。"
        ),
    },
    "author_year": {
        "label": "通用作者—年份制",
        "wanted": "plainnat author-year",
        "bst": "plainnat",
        "asset": "assets/citation-styles/author-year/plainnat.bst",
        "natbib_options": "authoryear,round",
        "fidelity": "exact",
        "inline_example": "……如 Smith and Li (2024) 所示，亦可写作 (Smith and Li, 2024)。",
        "reference_example": (
            "Smith, A. and Li, B. (2024). Agentic Literature Review. "
            "Journal of Research."
        ),
        "required": ["author", "title", "year"],
        "recommended": ["journal|booktitle|publisher"],
        "style_critical": ["doi|url"],
        "metadata_risk": (
            "中：PaperHub 可返回作者和年份，但个别记录可能无年份；这会直接变成 n.d.。"
        ),
        "note": (
            "通用的 (Author, Year) / Author (Year) 格式，按作者排序。"
            "它不是 APA 7；需要 APA 7 时不得用此选项代替。"
        ),
    },
    "ieee": {
        "label": "IEEE",
        "wanted": "IEEEtranN",
        "bst": "IEEEtranN",
        "asset": "assets/citation-styles/ieee/IEEEtranN.bst",
        "natbib_options": "numbers,sort&compress",
        "fidelity": "exact",
        "inline_example": "……如已有研究所示 [1]。",
        "reference_example": (
            "[1] A. Smith and B. Li, “Agentic Literature Review,” "
            "Journal of Research, vol. 12, no. 3, pp. 45–60, 2024."
        ),
        "required": ["author", "title", "year"],
        "recommended": ["journal|booktitle", "volume", "number", "pages", "doi"],
        "style_critical": ["volume", "number", "pages"],
        "metadata_risk": (
            "高：PaperHub 搜索契约不保证卷、期、页码；这些字段属于可选透传，"
            "通常只有上游 BibTeX 恰好携带时才可获得，因此 IEEE 条目可能格式正确"
            "但出版信息不完整。"
        ),
        "note": (
            "使用 CTAN 的 natbib 兼容 IEEEtranN.bst；引用和参考文献格式可确定复现。"
            "这不等于采用 IEEE 的整篇论文模板。"
        ),
    },
    "acm": {
        "label": "ACM Reference Format",
        "wanted": "ACM-Reference-Format",
        "bst": "ACM-Reference-Format",
        "asset": "assets/citation-styles/acm/ACM-Reference-Format.bst",
        "natbib_options": "numbers,sort",
        "fidelity": "exact",
        "inline_example": "……如已有研究所示 [1]。",
        "reference_example": (
            "[1] Alice Smith and Bo Li. 2024. Agentic Literature Review. "
            "Journal of Research 12, 3 (2024), 45–60."
        ),
        "required": ["author", "title", "year"],
        "recommended": ["journal|booktitle", "volume", "number", "pages", "doi", "publisher"],
        "style_critical": ["pages", "publisher"],
        "metadata_risk": (
            "高：页码、出版社和会议书目信息不在 PaperHub 搜索的保证字段中；"
            "缺失时仍能渲染，但不能视为完整的 ACM 投稿级参考文献。"
        ),
        "note": (
            "使用 ACM 发布的 ACM-Reference-Format.bst；参考文献格式可确定复现。"
            "这不等于采用 acmart 整篇论文模板。"
        ),
    },
}


def style_ids() -> tuple[str, ...]:
    return tuple(CITATION_STYLES)


def style_asset(style_id: str) -> Path:
    return slr_paths.HOME / CITATION_STYLES[style_id]["asset"]


def style_examples() -> list[dict]:
    return [
        {
            "id": sid,
            "label": spec["label"],
            "inline": spec["inline_example"],
            "reference": spec["reference_example"],
            "metadata_risk": spec["metadata_risk"],
        }
        for sid, spec in CITATION_STYLES.items()
    ]
