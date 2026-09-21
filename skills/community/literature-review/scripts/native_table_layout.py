"""Deterministic layout preflight for tables authored inside native chapters."""
from __future__ import annotations

from pathlib import Path
import re
import sys

TABLES_DIR = Path(__file__).resolve().parent / "generation" / "tables"
if str(TABLES_DIR) not in sys.path:
    sys.path.insert(0, str(TABLES_DIR))

from table_checks import collect_problems  # noqa: E402


_TABLE_RE = re.compile(r"\\begin\{table\*?\}.*?\\end\{table\*?\}", re.S)
_LABEL_RE = re.compile(r"\\label\{([^}]+)\}")
_STRAY_RULE_SLASH_RE = re.compile(r"\\(?:top|mid|bottom)rule\\(?=\s)")
_LAYOUT_PREFIXES = (
    "bare_tabular_without_resizebox_or_tabularx", "missing_layout_shell",
    "resizebox_", "tabular_star_has_X_column", "tabularx_",
    "row_too_wide_for_nonwrapping_shell", "narrow_fixed_text_cols_wrap_beside_X",
    "x_column_underfilled_while_fixed_col_wraps", "cite_in_nonwrapping_column",
    "unbreakable_ascii_run", "column_count_out_of_range", "unescaped_percent",
    "length_without_unit", "missing_caption",
)


def _layout_problem(problem: str) -> bool:
    return problem.startswith(_LAYOUT_PREFIXES)


def _column_spec(block: str) -> str | None:
    for pattern in (
        r"\\begin\{tabularx\}\s*\{[^}]*\}\s*\{([^}]*)\}",
        r"\\begin\{tabular\*\}\s*\{[^}]*\}\s*\{([^}]*)\}",
        r"\\begin\{tabular\}\s*\{([^}]*)\}",
    ):
        match = re.search(pattern, block)
        if match:
            return match.group(1)
    return None


def inspect_native_tables(source: str, planned_tables: list[dict]) -> dict:
    """Return compact warnings for planned LaTeX tables without changing source."""
    planned = {item["label"]: item for item in planned_tables}
    blocks = list(_TABLE_RE.finditer(source))
    found: set[str] = set()
    issues: list[dict] = []
    for match in blocks:
        block = match.group(0)
        labels = _LABEL_RE.findall(block)
        label = next((value for value in labels if value in planned), labels[0] if labels else "")
        item = planned.get(label, {})
        if label in planned:
            found.add(label)
        raw = collect_problems(block, expected_label=label if label in planned else "",
                               allowed_cite_keys=item.get("allowed_cite_keys"))
        problems = [problem for problem in raw if _layout_problem(problem)]
        if _STRAY_RULE_SLASH_RE.search(block):
            problems.append("stray_backslash_after_rule_command")
        if problems:
            issues.append({"table_id": item.get("table_id"), "label": label or None,
                           "source_line": source.count("\n", 0, match.start()) + 1,
                           "column_spec": _column_spec(block), "problems": problems})
    for match in re.finditer(r'\\begin\{longtable\}.*?\\end\{longtable\}', source, re.S):
        found.update(value for value in _LABEL_RE.findall(match[0]) if value in planned)
    for label, item in planned.items():
        if label not in found:
            issues.append({"table_id": item.get("table_id"), "label": label,
                           "source_line": None, "column_spec": None,
                           "problems": ["planned_table_missing_from_assembled_source"]})
    return {"status": "WARNING" if issues else "SUCCESS",
            "tables_checked": len(blocks), "issues": issues}
