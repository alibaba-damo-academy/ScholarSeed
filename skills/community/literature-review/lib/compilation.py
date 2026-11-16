"""Bounded diagnostics from the current compiler invocation, not stale logs."""

import re

BIB_ERROR = "BIBLIOGRAPHY_COMPILE_ERROR"
BIB_UNAVAILABLE = "BIBLIOGRAPHY_TOOL_UNAVAILABLE"
BIB_AUX_MISSING = "BIBLIOGRAPHY_AUX_MISSING"
LAYOUT_ERROR = "LATEX_LAYOUT_ERROR"
LAYOUT_TOLERANCE_PT = 1.0
FLOAT_OVERFLOW = re.compile(r'Float too large for page by ([0-9.]+)pt')
BOX_OVERFLOW = re.compile(r'Overfull \\([hv])box \(([0-9.]+)pt too (?:wide|high)\)')
MAX_DETAILS = 8
MAX_LINE = 1000
BIB_MARKERS = (
    "Too many commas",
    "Repeated entry",
    "I was expecting",
    "I couldn't open",
    "Illegal",
    "You can't pop",
    "error message",
)


def layout(text):
    """Material overflow is a publication defect even with a successful TeX exit."""
    lines = text.splitlines()
    issues = []
    for index, line in enumerate(lines):
        floating = FLOAT_OVERFLOW.search(line)
        box = BOX_OVERFLOW.search(line)
        if not floating and not box:
            continue
        points = float(floating[1] if floating else box[2])
        if points <= LAYOUT_TOLERANCE_PT:
            continue
        issues.append({'kind': 'float_too_large' if floating else 'overfull_' + box[1] + 'box',
                       'overflow_pt': points, 'message': line.strip(),
                       'context': '\n'.join(lines[index:index + 3])[:MAX_LINE]})
    return {'status': 'FAILED' if issues else 'SUCCESS',
            'code': LAYOUT_ERROR if issues else None,
            'issues': issues[:MAX_DETAILS], 'issues_truncated': len(issues) > MAX_DETAILS,
            'next_action': 'Reflow the reported source within page and cell widths. Use an unboxed multipage longtable for an overheight table; preserve all rows, formulas and qualifications. Republish and inspect the affected pages.'}


def bibliography(required, available, aux_exists, result):
    if not required:
        return {"status": "NOT_REQUIRED", "returncode": None, "issues": []}
    if not available:
        return {
            "status": "FAILED",
            "code": BIB_UNAVAILABLE,
            "returncode": None,
            "issues": [],
            "next_action": "Restore the configured BibTeX tool; keep the manuscript and bibliography.",
        }
    if not aux_exists:
        return {
            "status": "FAILED",
            "code": BIB_AUX_MISSING,
            "returncode": None,
            "issues": [],
            "next_action": "Resolve the first LaTeX pass failure before running BibTeX.",
        }
    if result is None:
        return {
            "status": "FAILED",
            "code": BIB_ERROR,
            "returncode": None,
            "issues": [],
            "next_action": "Inspect the failed bibliography process; do not regenerate chapters.",
        }
    output = result.stdout + result.stderr
    lines = output.splitlines()
    issues = []
    for index, line in enumerate(lines):
        if any(marker in line for marker in BIB_MARKERS):
            context = "\n".join(lines[index : index + 2])[:MAX_LINE]
            key = re.search(r"for entry\s+(\S+)", line)
            issue = {"message": context}
            if key:
                issue["cite_key"] = key[1]
            if "Too many commas" in line:
                # BibTeX uses the same name parser for authors and editors.
                # This message alone does not identify which field failed.
                issue["field"] = "name"
                issue["possible_fields"] = ["author", "editor"]
            issues.append(issue)
    if result.returncode and not issues:
        issues = [{"message": "\n".join(lines[-MAX_DETAILS:])[:MAX_LINE]}]
    return {
        "status": "SUCCESS" if result.returncode == 0 else "FAILED",
        "code": None if result.returncode == 0 else BIB_ERROR,
        "returncode": result.returncode,
        "issues": issues[:MAX_DETAILS],
        "issues_truncated": len(issues) > MAX_DETAILS,
        "next_action": "Repair the named bibliography entries or style using verified metadata; keep cite keys and completed chapters, then republish.",
    }
