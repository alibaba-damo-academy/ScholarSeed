"""Numerical fabrication detector — local copy."""

import re
from typing import NamedTuple

from .integrity_registry import VerifiedRegistry


class UnverifiedNumber(NamedTuple):
    value: float
    section: str
    context: str
    is_strict: bool


class FabricatedCondition(NamedTuple):
    name: str
    context: str


class VerificationResult:
    def __init__(self):
        self.total_numbers: int = 0
        self.verified_numbers: int = 0
        self.unverified_numbers: list[UnverifiedNumber] = []
        self.fabricated_conditions: list[FabricatedCondition] = []
        self.strict_violations: int = 0
        self.lenient_violations: int = 0

    @property
    def severity(self) -> str:
        if self.strict_violations > 0 or len(self.fabricated_conditions) > 0:
            return "REJECT"
        if self.lenient_violations > 0:
            return "WARN"
        return "PASS"

    @property
    def fabrication_rate(self) -> float:
        if self.total_numbers == 0:
            return 0.0
        return len(self.unverified_numbers) / self.total_numbers

    def to_dict(self) -> dict:
        return {
            "severity": self.severity,
            "total_numbers": self.total_numbers,
            "verified_numbers": self.verified_numbers,
            "unverified_count": len(self.unverified_numbers),
            "strict_violations": self.strict_violations,
            "lenient_violations": self.lenient_violations,
            "fabrication_rate": round(self.fabrication_rate, 4),
            "fabricated_conditions": [
                {"name": fc.name, "context": fc.context}
                for fc in self.fabricated_conditions
            ],
            "unverified_numbers": [
                {"value": un.value, "section": un.section,
                 "context": un.context, "is_strict": un.is_strict}
                for un in self.unverified_numbers
            ],
        }


STRICT_SECTIONS = {
    "results", "experiments", "experimental", "evaluation",
    "ablation", "analysis", "comparison", "performance",
}
LENIENT_SECTIONS = {
    "introduction", "related work", "discussion", "conclusion",
    "background", "method", "methodology", "approach",
    "future work", "limitation", "abstract",
}

_NUMBER_RE = re.compile(r'(?<![a-zA-Z_])(\d+\.?\d*(?:[eE][+-]?\d+)?)\s*[%]?')
_CITE_RE = re.compile(r'\\cite\{[^}]*\}')
_LABEL_RE = re.compile(r'\\label\{[^}]*\}')
_REF_RE = re.compile(r'\\ref\{[^}]*\}')
_COMMENT_RE = re.compile(r'%[^\n]*')
_SECTION_RE_LATEX = re.compile(
    r'\\(?:section|subsection|subsubsection)\{([^}]+)\}', re.IGNORECASE,
)
_SECTION_RE_MD = re.compile(r'^#{1,3}\s+(.+)$', re.MULTILINE)


def _classify_section(name: str) -> str:
    name_lower = name.lower().strip()
    for s in STRICT_SECTIONS:
        if s in name_lower:
            return "strict"
    for s in LENIENT_SECTIONS:
        if s in name_lower:
            return "lenient"
    return "unknown"


def _preprocess_text(text: str) -> str:
    text = _COMMENT_RE.sub("", text)
    text = _CITE_RE.sub("", text)
    text = _LABEL_RE.sub("", text)
    text = _REF_RE.sub("", text)
    return text


def _split_sections(text: str) -> list[tuple[str, str]]:
    sections: list[tuple[str, str]] = []
    latex_matches = list(_SECTION_RE_LATEX.finditer(text))
    if latex_matches:
        for i, m in enumerate(latex_matches):
            start = m.end()
            end = latex_matches[i + 1].start() if i + 1 < len(latex_matches) else len(text)
            sections.append((m.group(1), text[start:end]))
        return sections
    md_matches = list(_SECTION_RE_MD.finditer(text))
    if md_matches:
        for i, m in enumerate(md_matches):
            start = m.end()
            end = md_matches[i + 1].start() if i + 1 < len(md_matches) else len(text)
            sections.append((m.group(1), text[start:end]))
        return sections
    return [("Body", text)]


def _extract_numbers(text: str) -> list[tuple[float, str]]:
    results = []
    for m in _NUMBER_RE.finditer(text):
        try:
            val = float(m.group(1))
            start = max(0, m.start() - 40)
            end = min(len(text), m.end() + 40)
            results.append((val, text[start:end].strip()))
        except (ValueError, OverflowError):
            continue
    return results


def verify_paper_numbers(text: str, registry: VerifiedRegistry) -> VerificationResult:
    result = VerificationResult()
    processed = _preprocess_text(text)
    sections = _split_sections(processed)

    for sec_name, sec_text in sections:
        sec_type = _classify_section(sec_name)
        for val, ctx in _extract_numbers(sec_text):
            result.total_numbers += 1
            if registry.is_verified(val):
                result.verified_numbers += 1
            else:
                is_strict = sec_type == "strict"
                result.unverified_numbers.append(
                    UnverifiedNumber(val, sec_name, ctx, is_strict)
                )
                if is_strict:
                    result.strict_violations += 1
                elif sec_type == "lenient":
                    result.lenient_violations += 1

    return result


def check_conditions(text: str, registry: VerifiedRegistry) -> list[FabricatedCondition]:
    if not registry.condition_names:
        return []
    fabricated: list[FabricatedCondition] = []
    table_row_re = re.compile(
        r'^\s*\|?\s*([A-Za-z][\w\s\+\-]*?)\s*(?:\||&|\\\\)', re.MULTILINE,
    )
    for m in table_row_re.finditer(text):
        name = m.group(1).strip()
        if name and len(name) > 1 and not name.startswith(("Method", "Model", "---")):
            if not registry.is_known_condition(name):
                ctx_start = max(0, m.start() - 20)
                ctx_end = min(len(text), m.end() + 40)
                fabricated.append(FabricatedCondition(name, text[ctx_start:ctx_end].strip()))
    return fabricated


def run_integrity(text: str, experiment_data: dict) -> dict:
    """Top-level integrity entry used by the CLI."""
    reg = VerifiedRegistry.from_dict(experiment_data or {})
    result = verify_paper_numbers(text, reg)
    for fc in check_conditions(text, reg):
        result.fabricated_conditions.append(fc)
    return result.to_dict()
