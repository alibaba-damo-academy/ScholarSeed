"""Deterministic citation-style registry shared by task input and publication.

All supported LaTeX styles are vendored under ``assets/``.  The registry also
owns the examples shown to users and the metadata contract used by the corpus
audit; keeping those together prevents the menu from promising a style whose
renderer or required fields say something different.

Issue numbers and page ranges are render-only metadata: preserve supplied values,
but never require them for completeness or report their absence as a warning.
"""

from __future__ import annotations

from pathlib import Path

import slr_paths

PAPERHUB_FIELD_AVAILABILITY = {
    "direct": {
        "author",
        "title",
        "year",
        "journal",
        "doi",
        "eprint",
    },
    "optional_or_upstream_bibtex": {
        "entry_type",
        "booktitle",
        "volume",
        "number",
        "pages",
        "publisher",
        "address",
        "location",
        "month",
        "date",
        "editor",
        "edition",
        "series",
        "organization",
        "institution",
        "school",
        "url",
    },
    "not_provided": {
        "accessed",
        "urldate",
        "translator",
        "originalyear",
    },
}


CITATION_STYLES: dict[str, dict] = {
    "gbt7714_2025": {
        "label": "GB/T 7714—2025（顺序编码制）",
        "labels": {
            "CHINESE": {
                "option": "GB/T 7714—2025 顺序编码制（国标精确排版请选择 PDF）",
                "timeout": "GB/T 7714—2025 引用",
            },
            "ENGLISH": {
                "option": "GB/T 7714—2025 numeric (choose PDF for standard-conformant typesetting)",
                "timeout": "GB/T 7714—2025 citations",
            },
        },
        "wanted": "gbt7714-2025-numeric",
        "bst": "gbt7714-2025-numeric",
        "asset": "assets/citation-styles/gbt7714/gbt7714-2025-numeric.bst",
        "natbib_options": "numbers,sort&compress",
        "latex_preamble": "\\usepackage[UTF8,scheme=plain]{ctex}",
        "fidelity": "exact",
        "inline_example": "……如已有研究所示 [1]。",
        "reference_example": "[1] Smith A，Li Bo. Agentic literature review[J]. Journal of Research，2024，12（3）：45-60.",
        "required": ["author", "title", "year"],
        "recommended": ["doi|url"],
        "recommended_by_type": {
            "article": ["journal", "volume"],
            "inproceedings": ["booktitle", "address|location", "publisher"],
            "conference": ["booktitle", "address|location", "publisher"],
            "book": ["address|location", "publisher"],
            "misc": ["url", "urldate|accessed"],
            "online": ["url", "urldate|accessed"],
        },
        "style_critical": ["entry_type", "journal|booktitle", "publisher"],
        "metadata_risk": "出版地、出版者和引用日期可能缺失；按校验结果报告缺项，不能编造。期号和页码仅在有值时输出，缺失不告警、不影响完整率。",
        "note": "PDF 使用固定版本的 CTAN gbt7714 样式。Markdown 为简化的确定性布局，不作为国标投稿级排版验收。",
    },
    "numeric": {
        "label": "通用数字顺序制",
        "labels": {
            "CHINESE": {"option": "数字编号条目", "timeout": "数字引用"},
            "ENGLISH": {"option": "Numbered references", "timeout": "numeric citations"},
        },
        "wanted": "unsrtnat_scholarseed",
        "bst": "unsrtnat_scholarseed",
        "asset": "assets/unsrtnat_scholarseed.bst",
        "natbib_options": "numbers,sort&compress",
        "fidelity": "exact",
        "inline_example": "……如已有研究所示 [1]。",
        "reference_example": (
            "[1] Alice Smith and Bo Li. Agentic Literature Review. " "Journal of Research, 2024."
        ),
        "required": ["author", "title"],
        "recommended": ["year"],
        "style_critical": ["journal|booktitle|publisher|doi|url|eprint"],
        "metadata_risk": "低：正文编号不依赖年份；缺失出版信息只会使文后条目较薄。",
        "note": ("方括号数字按首次引用顺序排列；作者超过十人时截断为 et al.。"),
    },
    "author_year": {
        "label": "通用作者—年份制",
        "labels": {
            "CHINESE": {"option": "作者—年份条目", "timeout": "作者—年份引用"},
            "ENGLISH": {"option": "Author–year references", "timeout": "author-year citations"},
        },
        "wanted": "plainnat author-year",
        "bst": "plainnat",
        "asset": "assets/citation-styles/author-year/plainnat.bst",
        "natbib_options": "authoryear,round",
        "fidelity": "exact",
        "inline_example": "……如 Smith and Li (2024) 所示，亦可写作 (Smith and Li, 2024)。",
        "reference_example": (
            "Smith, A. and Li, B. (2024). Agentic Literature Review. " "Journal of Research."
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
        "labels": {
            "CHINESE": {"option": "IEEE 编号条目", "timeout": "IEEE 引用"},
            "ENGLISH": {"option": "IEEE numbered references", "timeout": "IEEE citations"},
        },
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
        "recommended": ["journal|booktitle", "volume", "doi"],
        "style_critical": ["volume"],
        "metadata_risk": (
            "PaperHub 搜索契约不保证卷号；按校验结果报告出版信息缺项。"
            "期号和页码仅在有值时输出，缺失不告警、不影响完整率。"
        ),
        "note": (
            "使用 CTAN 的 natbib 兼容 IEEEtranN.bst；引用和参考文献格式可确定复现。"
            "这不等于采用 IEEE 的整篇论文模板。"
        ),
    },
    "acm": {
        "label": "ACM Reference Format",
        "labels": {
            "CHINESE": {"option": "ACM 参考文献格式", "timeout": "ACM 引用"},
            "ENGLISH": {"option": "ACM Reference Format", "timeout": "ACM citations"},
        },
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
        "recommended": ["journal|booktitle", "volume", "doi", "publisher"],
        "style_critical": ["publisher"],
        "metadata_risk": (
            "出版社和会议书目信息不在 PaperHub 搜索的保证字段中；"
            "按校验结果报告缺项。期号和页码仅在有值时输出，缺失不告警、不影响完整率。"
        ),
        "note": (
            "使用 ACM 发布的 ACM-Reference-Format.bst；参考文献格式可确定复现。"
            "这不等于采用 acmart 整篇论文模板。"
        ),
    },
}


def style_ids() -> tuple[str, ...]:
    return tuple(CITATION_STYLES)


def style_labels(style_id: str, language: str) -> dict[str, str]:
    return CITATION_STYLES[style_id]["labels"]["CHINESE" if language == "CHINESE" else "ENGLISH"]


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
