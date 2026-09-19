"""Content quality / template detector — local copy."""

import re
from typing import NamedTuple


class TemplateMatch(NamedTuple):
    pattern_name: str
    matched_text: str
    line_number: int
    severity: str  # "critical" | "high" | "low"


TEMPLATE_PATTERNS = [
    ("placeholder_todo", re.compile(r'\[TODO[:\s][^\]]*\]', re.IGNORECASE), "critical"),
    ("placeholder_insert", re.compile(r'\[insert\s[^\]]*\]', re.IGNORECASE), "critical"),
    ("placeholder_xxx", re.compile(r'\bXXX+\b'), "critical"),
    ("placeholder_tbd", re.compile(r'\bTBD\b|\bTBC\b'), "critical"),
    ("lorem_ipsum", re.compile(r'lorem ipsum', re.IGNORECASE), "critical"),
    ("ai_certainly", re.compile(r'\bcertainly\b.*\b(delve|explore)\b', re.IGNORECASE), "low"),
    ("ai_delve", re.compile(r'\bdelve\b', re.IGNORECASE), "low"),
    ("ai_tapestry", re.compile(r'\btapestry\b', re.IGNORECASE), "low"),
    ("ai_landscape", re.compile(r'\blandscape of\b.*\breasoning\b', re.IGNORECASE), "low"),
    ("repeated_phrase", re.compile(r'(\b\w{4,}\b)\s+\1\s+\1', re.IGNORECASE), "high"),
    ("debug_print", re.compile(r'\bprint\s*\(|console\.log\(', re.IGNORECASE), "high"),
    ("debug_fixme", re.compile(r'\bFIXME\b|\bHACK\b', re.IGNORECASE), "critical"),
    # Chinese LLM boilerplate (severity=low to avoid pushing zh drafts to REJECTED).
    ("zh_overall_summary", re.compile(r'综上所述'), "low"),
    ("zh_worth_noting", re.compile(r'值得(?:注意|关注)的是'), "low"),
    ("zh_in_this_paper", re.compile(r'在本文中[，,]?\s*我们'), "low"),
]

# LaTeX macro-definition lines whose bodies legitimately contain placeholder-
# looking text (e.g. `\providecommand{\todo}[2][]{[TODO #1: #2]}`). The literal
# `[TODO #1: #2]` is the macro template, not residual TODO content, so any line
# starting (after whitespace) with one of these control sequences is skipped.
_LATEX_MACRO_DEF_RE = re.compile(
    r"\\(?:providecommand|newcommand|renewcommand|DeclareRobustCommand|"
    r"def|edef|gdef|xdef|let)\b"
)


def detect_template_content(text: str) -> list[TemplateMatch]:
    matches = []
    for line_num, line in enumerate(text.split("\n"), 1):
        if _LATEX_MACRO_DEF_RE.search(line):
            continue
        for name, pattern, severity in TEMPLATE_PATTERNS:
            for m in pattern.finditer(line):
                matches.append(TemplateMatch(
                    pattern_name=name,
                    matched_text=m.group()[:80],
                    line_number=line_num,
                    severity=severity,
                ))
    return matches


def check_strict_quality(text: str, threshold: float = 0.05) -> dict:
    matches = detect_template_content(text)
    total_lines = max(len(text.split("\n")), 1)
    matched_lines = len(set(m.line_number for m in matches))
    ratio = matched_lines / total_lines
    critical_count = sum(1 for m in matches if m.severity == "critical")
    return {
        "passed": ratio < threshold and critical_count == 0,
        "template_ratio": round(ratio, 4),
        "total_matches": len(matches),
        "critical_matches": critical_count,
        "template_matches": [
            {"pattern": m.pattern_name, "text": m.matched_text,
             "line": m.line_number, "severity": m.severity}
            for m in matches
        ],
    }
