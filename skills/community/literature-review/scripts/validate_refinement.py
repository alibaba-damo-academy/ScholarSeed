#!/usr/bin/env scholarseed-skill-python
"""Compatibility v1/v2 refinement validator for explicit legacy callers.

Current chapter_delta uses manuscript_delta patch integrity and the three content
rules, not this validator. No refiner subagent is part of the current workflow."""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths  # noqa: E402
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

# ============================================================================
# LaTeX safety DETECTOR (check-only — we DO NOT auto-rewrite).
#
# Bare `^` / `_` outside math mode (e.g. `O(n^2)`, `L_1 norm`) crashes
# xelatex with "Missing $ inserted". The refiner agent is responsible for
# wrapping these in `$..$`. This just COUNTS leftover occurrences so the report
# can surface "N unsafe sup/sub patterns left" — useful when the compile
# mysteriously dies on page 3.
#
# Why detect-only and not auto-fix: regex wrapping is hard to get right
# at the cosmetic level (e.g. `O(n^2)` should become `$O(n^2)$`, not
# `O($n^2$)`), and an over-eager wrapper can mangle valid LaTeX. We let
# the LLM handle the semantic call and we just verify.
# ============================================================================

# Regions whose contents are LEGITIMATELY allowed to contain ^ / _ — we
# mask them so the detector only fires on truly bare cases.
_MASK_PATTERNS = [
    re.compile(r"(?<!\\)%[^\n]*"),                                  # comments
    re.compile(
        r"\\begin\{(equation|align|gather|multline|displaymath|eqnarray)\*?\}.*?"
        r"\\end\{\1\*?\}",
        re.DOTALL,
    ),                                                              # display math
    re.compile(r"\\\[.*?\\\]", re.DOTALL),                          # \[..\]
    re.compile(r"\\\(.*?\\\)", re.DOTALL),                          # \(..\)
    re.compile(r"\$\$.*?\$\$", re.DOTALL),                          # $$..$$
    re.compile(r"(?<!\\)\$[^$\n]*?(?<!\\)\$"),                      # $..$
    # Commands whose braced argument is an IDENTIFIER — a cite key, a label, a
    # file path, a package or style name — rather than typeset prose. An
    # underscore there is part of the name and is perfectly legal LaTeX.
    #
    # Two of these fire on every document this pipeline produces:
    #   \bibliographystyle{unsrtnat_scholarseed}   \usepackage{neurips_2026}
    #
    # Order matters inside the alternation: a longer name must precede the
    # shorter one it starts with, or the shorter alternative matches and then
    # the following `\{` fails against the remaining letters. `bibliography`
    # ahead of `bibliographystyle` is exactly how this check used to report a
    # false positive on every run.
    #
    # Do NOT add prose-typesetting commands here (\textbf, \emph, ...): a bare
    # `_` inside those really does break the compile, and masking them would
    # turn this from a false positive into a missed defect.
    re.compile(
        r"\\(?:cite[tp]?|ref|eqref|label|input|includegraphics|include|"
        r"bibliographystyle|bibliography|bibitem|usepackage|documentclass|"
        r"newcommand|renewcommand|providecommand|thispagestyle|pagestyle|"
        r"url|href|texttt|verb|begin|end|caption|"
        r"section|subsection|subsubsection|paragraph)\s*(?:\[[^\]]*\])?\s*\{[^}]*\}"
    ),                                                              # identifier arguments
    re.compile(r"\\\^(?:\{[^}]*\})?"),                              # already-escaped \^
    re.compile(r"\\_"),                                             # already-escaped \_
]

_BARE_SUPSUB_RE = re.compile(
    r"[A-Za-z0-9Α-Ωα-ω]+"
    r"[\^_]"
    r"(?:\{[^}]+\}|[A-Za-z0-9Α-Ωα-ω]+)"
)


def _count_unsafe_supsub(text: str, sample_limit: int = 5) -> tuple[int, list[str]]:
    """Return (count, up-to-sample_limit example snippets) of bare ^/_ in prose."""
    masked = text
    for pat in _MASK_PATTERNS:
        masked = pat.sub(lambda m: " " * len(m.group(0)), masked)
    hits = _BARE_SUPSUB_RE.findall(masked)
    return len(hits), hits[:sample_limit]


# ============================================================================
# Sanity checks
# ============================================================================

_SECTION_RE = re.compile(r"\\section\{")
_LABEL_RE = re.compile(r"\\label\{(sec:s[^}]+)\}")
_ALL_LABEL_RE = re.compile(r"\\label\{([^}]+)\}")
_REF_RE = re.compile(r"\\ref\{([^}]+)\}")
_CITE_KEY_RE = re.compile(r"\\cite[tp]?\{([^}]+)\}")


def _section_count(text: str) -> int:
    return len(_SECTION_RE.findall(text))


def _labels(text: str) -> set[str]:
    return set(_LABEL_RE.findall(text))


def _cite_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for m in _CITE_KEY_RE.findall(text):
        for k in m.split(","):
            k = k.strip()
            if k:
                keys.add(k)
    return keys


def _sanity_check(v1: str, v2: str) -> list[str]:
    """Return a list of human-readable problem strings; empty list = pass."""
    problems: list[str] = []
    v2_stripped = v2.strip()
    if not v2_stripped.startswith("\\documentclass"):
        problems.append("v2 does not start with \\documentclass")
    if "\\end{document}" not in v2_stripped:
        problems.append("v2 missing \\end{document}")

    # If v1 carried an abstract envelope, the abstract-refinement edit must not
    # drop it. Losing \begin{abstract} / \end{abstract} silently removes the
    # abstract from the PDF; treat it as a sanity failure.
    if "\\begin{abstract}" in v1 and (
        "\\begin{abstract}" not in v2 or "\\end{abstract}" not in v2
    ):
        problems.append("abstract envelope dropped in v2")

    sec_v1 = _section_count(v1)
    sec_v2 = _section_count(v2)
    if sec_v1 != sec_v2:
        problems.append(f"section count drift: v1={sec_v1} v2={sec_v2}")

    labels_v1 = _labels(v1)
    labels_v2 = _labels(v2)
    missing_labels = labels_v1 - labels_v2
    if missing_labels:
        problems.append(f"missing labels in v2: {sorted(missing_labels)[:5]}")

    keys_v1 = _cite_keys(v1)
    keys_v2 = _cite_keys(v2)
    new_keys = keys_v2 - keys_v1
    if new_keys:
        problems.append(f"new cite_keys introduced in v2: {sorted(new_keys)[:5]}")

    all_labels_v2 = set(_ALL_LABEL_RE.findall(v2))
    dangling_refs = set(_REF_RE.findall(v2)) - all_labels_v2
    if dangling_refs:
        problems.append(f"dangling \\ref targets in v2 (no matching \\label): {sorted(dangling_refs)[:5]}")

    if v1.strip():
        deviation = abs(len(v2) - len(v1)) / max(len(v1), 1)
        if deviation > 0.35:
            problems.append(f"length deviation > 35%: |v2-v1|/v1 = {deviation:.2%}")

    return problems


# Presentation only. `_sanity_check` compares \section{ *counts*; naming which
# titles went missing makes the instruction actionable without touching the
# rule that decides pass/fail.
_SECTION_TITLE_RE = re.compile(r"\\section\{([^}]*)\}")

_MAX_LISTED = 8  # cap on items named inside one instruction


def _fmt(items: list[str]) -> str:
    shown = items[:_MAX_LISTED]
    tail = "" if len(items) <= _MAX_LISTED else f" (+{len(items) - _MAX_LISTED} more)"
    return ", ".join(shown) + tail


def _instructions(v1: str, v2: str, raw_problems: list[str],
                  allow_v1_inherited: bool) -> tuple[list[str], list[str]]:
    """Turn `_sanity_check` labels into repair instructions.

    Returns (errors, notes). `notes` carries problems that were demoted rather
    than dropped, so nothing the source flagged ever vanishes from the report.
    """
    errors: list[str] = []
    notes: list[str] = []

    for raw in raw_problems:
        # --- structural envelope -----------------------------------------
        if raw.startswith("v2 does not start with \\documentclass"):
            errors.append(
                "v2 must begin with \\documentclass — the first characters of the "
                "file are something else (a prose preamble, a ``` fence, or a lost "
                "preamble). Re-emit the document starting at \\documentclass."
            )
        elif raw.startswith("v2 missing \\end{document}"):
            errors.append(
                "v2 has no \\end{document} — the file is truncated. Re-emit the "
                "whole document through its closing \\end{document}."
            )
        elif raw.startswith("abstract envelope dropped in v2"):
            errors.append(
                "v1 wraps its abstract in \\begin{abstract} … \\end{abstract} and v2 "
                "does not — restore both markers around the abstract text; without "
                "them the abstract disappears from the PDF."
            )

        # --- section / label structure ------------------------------------
        elif raw.startswith("section count drift"):
            t1 = _SECTION_TITLE_RE.findall(v1)
            t2 = _SECTION_TITLE_RE.findall(v2)
            lost = [t for t in t1 if t not in t2]
            added = [t for t in t2 if t not in t1]
            detail = ""
            if lost:
                detail += f" Missing from v2: {_fmt(lost)}."
            if added:
                detail += f" Not in v1: {_fmt(added)}."
            errors.append(
                f"v2 has {_section_count(v2)} \\section{{}} commands, v1 has "
                f"{_section_count(v1)} — refinement must not add, merge or delete "
                f"sections.{detail} Restore v1's section structure."
            )
        elif raw.startswith("missing labels in v2"):
            missing = sorted(_labels(v1) - _labels(v2))
            errors.append(
                "v2 dropped section label(s) that v1 defines: "
                + _fmt([f"\\label{{{k}}}" for k in missing])
                + " — put each one back on the same section it labelled in v1; "
                  "\\ref targets elsewhere in the document point at them."
            )

        # --- citations -----------------------------------------------------
        elif raw.startswith("new cite_keys introduced in v2"):
            new_keys = sorted(_cite_keys(v2) - _cite_keys(v1))
            errors.append(
                "v2 cites key(s) that never appear in v1: "
                + _fmt([f"\\citep{{{k}}}" for k in new_keys])
                + " — refinement may not introduce citations, and these keys are "
                  "not guaranteed to exist in citations.bib. Delete them or "
                  "replace them with a key already used in v1."
            )

        # --- cross-references ----------------------------------------------
        elif raw.startswith("dangling \\ref targets in v2"):
            dangling_v2 = set(_REF_RE.findall(v2)) - set(_ALL_LABEL_RE.findall(v2))
            dangling_v1 = set(_REF_RE.findall(v1)) - set(_ALL_LABEL_RE.findall(v1))
            introduced = sorted(dangling_v2 - dangling_v1)
            inherited = sorted(dangling_v2 & dangling_v1)
            if introduced:
                errors.append(
                    "v2 references target(s) it never defines: "
                    + _fmt([f"\\ref{{{k}}}" for k in introduced])
                    + " — v1 resolved these, so v2 deleted the matching \\label. "
                      "Restore the \\label, or remove the \\ref."
                )
            if inherited:
                message = (
                    "v2 references " + _fmt([f"\\ref{{{k}}}" for k in inherited])
                    + " with no matching \\label — but v1 dangles the same way. "
                      "Figure and table labels are injected later by the "
                      "insert_assets phase; do NOT invent them here, and do not "
                      "delete the \\ref."
                )
                (notes if allow_v1_inherited else errors).append(message)

        # --- length ---------------------------------------------------------
        elif raw.startswith("length deviation"):
            delta = len(v2) - len(v1)
            pct = abs(delta) / max(len(v1), 1)
            direction = "longer" if delta > 0 else "shorter"
            fix = ("Cut the padding you added" if delta > 0
                   else "Restore the material you cut")
            errors.append(
                f"v2 is {pct:.1%} {direction} than v1 ({len(v1)} → {len(v2)} chars); "
                f"refinement must stay within ±35%. {fix} — this is a polish pass, "
                f"not a rewrite."
            )

        # --- anything `_sanity_check` grew after this mapper was written ----
        else:
            errors.append(
                f"[unmapped rule from _sanity_check] {raw}"
            )

    return errors, notes


def _read(path: Path, label: str) -> tuple[str | None, str | None]:
    if not path.is_file():
        return None, f"{label} not found at {path}"
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return None, f"{label} is not readable: {exc}"
    if not text.strip():
        return None, f"{label} is empty at {path}"
    return text, None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("workspace", nargs="?", default=".", help="run workspace (default: cwd)")
    ap.add_argument("--v1", default=None, help="override the original draft path")
    ap.add_argument("--v2", default=None, help="override the refined draft path")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    ap.add_argument("--allow-v1-inherited", action="store_true",
                    help="demote dangling \\ref targets that already dangle in v1 "
                         "from errors to notes (default: off — the strict verdict)")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    gen = workspace / "05_generation"
    v1_path = Path(args.v1).resolve() if args.v1 else gen / "full_draft_v1.tex"
    v2_path = Path(args.v2).resolve() if args.v2 else gen / "full_draft_v2.tex"

    v1, err1 = _read(v1_path, "full_draft_v1.tex")
    if v1 is None:
        print(f"[FAIL] {err1}", file=sys.stderr)
        return 2
    v2, err2 = _read(v2_path, "full_draft_v2.tex")
    if v2 is None:
        print(f"[FAIL] {err2}", file=sys.stderr)
        return 2

    raw_problems = _sanity_check(v1, v2)
    errors, notes = _instructions(v1, v2, raw_problems, args.allow_v1_inherited)

    v1_unsafe, _ = _count_unsafe_supsub(v1)
    v2_unsafe, v2_unsafe_examples = _count_unsafe_supsub(v2)

    stats = {
        "v1_chars": len(v1),
        "v2_chars": len(v2),
        "length_deviation": round(abs(len(v2) - len(v1)) / max(len(v1), 1), 4),
        "sections_v1": _section_count(v1),
        "sections_v2": _section_count(v2),
        "section_labels_v1": len(_labels(v1)),
        "section_labels_v2": len(_labels(v2)),
        "cite_keys_v1": len(_cite_keys(v1)),
        "cite_keys_v2": len(_cite_keys(v2)),
        # Non-fatal, reported but never failed on: bare ^/_ outside
        # math mode crash xelatex, but the LLM — not this gate — is responsible
        # for wrapping them, so they are reported and never failed on.
        "unsafe_supsub_v1": v1_unsafe,
        "unsafe_supsub_v2": v2_unsafe,
        "unsafe_supsub_examples": v2_unsafe_examples,
        "raw_problems": raw_problems,
    }

    report = {
        "valid": not errors,
        "errors": errors,
        "stats": stats,
        "v1": str(v1_path),
        "v2": str(v2_path),
    }
    if notes:
        report["notes"] = notes

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if errors else 0

    for note in notes:
        print(f"[NOTE] {note}")
    if errors:
        print(f"[FAIL] v2 violates {len(errors)} refinement rule(s):")
        for err in errors:
            print(f"  - {err}")
    else:
        print("[OK] v2 satisfies the refinement contract: " + ", ".join(
            f"{k}={stats[k]}" for k in
            ("v1_chars", "v2_chars", "length_deviation", "sections_v2",
             "section_labels_v2", "cite_keys_v2")))
        if v2_unsafe:
            print(f"[WARN] {v2_unsafe} bare ^/_ outside math mode remain in v2 "
                  f"(xelatex may fail): {v2_unsafe_examples} — wrap each in $…$.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
