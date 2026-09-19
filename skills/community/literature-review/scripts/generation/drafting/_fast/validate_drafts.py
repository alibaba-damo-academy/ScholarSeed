"""Compatibility section-draft validator for explicit legacy callers.

Current chapter responses are retained without these editorial gates; only the
refined complete manuscript receives the current three content checks."""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

pass
pass
from _utils import (  # noqa: E402
    Workspace,
    _is_cjk_char,
    latex_word_count,
    load_json,
    log_script_start,
    normalize_latex_commands,
    require_workspace,
    shorten,
    write_json,
    write_status,
)
from output_spec import read_output_spec  # noqa: E402
from writing_contract import explicit_length_budget


_MARKDOWN_PATTERNS = [
    (re.compile(r"(?m)^\s{0,3}#{1,6}\s"), "markdown_heading"),
    (re.compile(r"\*\*[^*\n]{1,80}\*\*"), "markdown_bold"),
    (re.compile(r"```"), "markdown_fenced_block"),
]

# Idempotent: matches `<digit>%` only when the `%` is not already escaped.
# Mirrors scripts/generation/fix_percent_escape.py so drafts are clean before
# they reach the merge phase, not just inside the merged full_draft.tex.
_UNESCAPED_PERCENT_RE = re.compile(r"(?<!\\)(\d)%")

# Signal words for the technique-section depth lints (B3 / C4).
_LIMITATION_SIGNAL_RE = re.compile(
    r"\b(limitation|fail|failure|fails|boundary|trade[- ]?off|unquantified|"
    r"degrade|degrades|degradation|brittle|sensitive to|"
    r"struggles?|overfits?|overhead|cost|expensive|underexplored|"
    r"polysemous|hallucinat|OOD|out[- ]of[- ]distribution)\b",
    re.IGNORECASE,
)
_LIMITATION_SIGNAL_ZH_RE = re.compile(
    r"(局限|缺陷|失败|失效|边界|权衡|未量化|退化|脆弱|敏感|"
    r"额外开销|代价|偏置|偏差|过拟合|泛化不足|幻觉|分布外|OOD|"
    r"未充分|有待|尚未|过度依赖|不一致)"
)
_CRITICAL_CLOSER_SIGNAL_RE = re.compile(
    r"\b(however|remains?|unresolved|trade[- ]?off|gap|open|brittle|"
    r"limitation|fail|hallucinat|sensitive|untested|missing|"
    r"under[- ]explored|cost|expensive|degrade|unclear)\b",
    re.IGNORECASE,
)
_CRITICAL_CLOSER_SIGNAL_ZH_RE = re.compile(
    r"(然而|仍|尚未|未解|权衡|缺口|开放|局限|失败|幻觉|敏感|缺乏|缺失|"
    r"待|尚不|不清楚|代价|高昂|退化|脆弱|有待)"
)

# Paragraph openers that the prompts ban from appearing ≥2 times in a section.
_BANNED_REPEATED_OPENERS_EN = (
    "Building on",
    "Collectively",
    "These",  # checked together with "motivate" suffix
    "In contrast",
    "Moreover",
    "Furthermore",
    "As a result",
)
_BANNED_REPEATED_OPENERS_ZH = (
    "在",  # combined with 「基础上」/「之上」 suffix check
    "综合而言",
    "综上",
    "这些",
    "相比之下",
    "此外",
    "然而",
    "因此",
)


# ============================================================================
# Claim attribution: paper-level, and deliberately not finer
# ----------------------------------------------------------------------------
# A `claim` records what a section asserts and which papers it rests on. It
# used to also carry `supporting_quotes[]` — a quoted span plus a `card_path`
# locating that span inside the paper card — so that every claim could be
# traced to a sentence of source text.
#
# That machinery is gone, and the ~300 lines it took with it were the legal
# path set, the rewrite table for the paths an LLM guesses instead, the index
# suffix rules, and the two warnings they produced. Nothing consumed the
# result: there is no surface anywhere in this deployment that renders a
# citation → quote → evidence chain, so the quotes were written, validated,
# repaired and stored for a reader that does not exist.
#
# The cost was not storage. `claim_missing_supporting_quote` was the most
# expensive message this validator emitted — four of seven writers in one run
# answered it by reading this file, because the legal `card_path` values lived
# only in its source; one of them gave up and cleared the verdict flag instead
# of the defect. That is a lot of agent attention spent on an artefact nobody
# reads.
#
# Upstream is untouched: paper cards still carry `source_mapping`, so the
# sentence-level evidence still exists in `03_process/` and a future platform
# that can display a chain can rebuild this on top of it. What was removed is
# the demand that every drafting agent produce it by hand, in prose, into a
# schema, forty minutes before anyone could look at it.
#
# What survives is paper-level attribution, which is what a survey actually
# publishes: `claims[].cite_keys`, checked against the section's whitelist, and
# `\citep{}` in the prose. `scripts/verify/fast_audit` still pairs each claim's
# text against its cited papers' abstracts — that check reads `text` and
# `cite_keys` and never read the quotes.
# ============================================================================

def _measure_length(body: str, unit: str) -> int:
    """Count `body` in the unit its target is expressed in."""
    if unit == "words":
        return latex_word_count(body)
    stripped = re.sub(r"\\[a-zA-Z]+\*?\{[^}]*\}", " ", body)
    stripped = re.sub(r"\\[a-zA-Z]+\*?", " ", stripped)
    if unit == "characters":
        return sum(not ch.isspace() for ch in stripped)
    if unit != "cjk_chars":
        raise ValueError(f"unsupported length measurement unit: {unit!r}")
    return sum(1 for ch in stripped if _is_cjk_char(ch))


def document_length_check(bodies: list[str], budget: dict) -> dict:
    """Judge only explicit whole-output limits; a target alone is descriptive."""
    if not budget:
        return {"constrained": False}
    result = {"constrained": True, "budget": budget, "violations": []}
    if budget["unit"] == "pages":
        result["deferred"] = "Page limits require the rendered deliverable."
        return result
    measured = _measure_length("\n\n".join(bodies), budget["unit"])
    result["measured"] = measured
    for bound, relation in (("min", "below"), ("max", "above")):
        limit = budget.get(bound)
        if limit is not None and ((bound == "min" and measured < limit)
                                  or (bound == "max" and measured > limit)):
            result["violations"].append(f"document length {measured} {budget['unit']} "
                                        f"is {relation} the explicit {bound} {limit}")
    return result


def _ref_present(body: str, label: str) -> bool:
    """True if `\\ref{label}` (or \\Cref{label} / \\autoref{label}) appears in body."""
    if not label:
        return False
    pattern = re.compile(r"\\(?:ref|Cref|cref|autoref|eqref)\{[^}]*\b" + re.escape(label) + r"\b[^}]*\}")
    return bool(pattern.search(body))


def _check_missing_refs(body: str, planned: list[dict], key: str) -> list[str]:
    """Return list of labels in `planned` that are not referenced anywhere in body."""
    missing: list[str] = []
    for item in planned or []:
        if not isinstance(item, dict):
            continue
        label = item.get("label") or ""
        if label and not _ref_present(body, label):
            missing.append(label)
    return missing


def _split_paragraphs(body: str) -> list[str]:
    """Naive paragraph split — blank lines separate paragraphs."""
    return [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]


def _paragraph_openers(paragraphs: list[str], language: str) -> dict[str, int]:
    """Count how many paragraphs begin with each banned opener."""
    bans = _BANNED_REPEATED_OPENERS_ZH if language == "chinese" else _BANNED_REPEATED_OPENERS_EN
    counts: dict[str, int] = {}
    for p in paragraphs:
        # Strip LaTeX inline markup at the start (\noindent, \textbf{...}).
        head = re.sub(r"^\\noindent\s+", "", p)
        head = re.sub(r"^\\textbf\{[^}]*\}[\.\s]*", "", head)
        head = head.lstrip()
        # Trim a leading sentence-initial \citet{...} so we see the verb after.
        head_for_match = head
        for opener in bans:
            if head_for_match.startswith(opener):
                # Refine the "These … motivate" pattern: only count when "motivate" is
                # in the first sentence — a common templated cadence in current drafts.
                if opener == "These":
                    first_sentence = re.split(r"[\.。]", head_for_match, maxsplit=1)[0]
                    if "motivate" not in first_sentence.lower():
                        continue
                if opener == "在":
                    # Match Chinese "在 …… 的基础上/之上" template
                    first_clause = re.split(r"[，,。]", head_for_match, maxsplit=1)[0]
                    if not re.search(r"(基础上|之上)", first_clause):
                        continue
                counts[opener] = counts.get(opener, 0) + 1
    return counts


def _last_sentences(body: str, n: int = 2) -> str:
    """Return the trailing `n` sentences of body, language-agnostic."""
    pieces = re.split(r"(?<=[\.。!?！？])\s+", body.strip())
    if not pieces:
        return ""
    return " ".join(pieces[-n:])


# ============================================================================
# Markdown-dialect lints
# ----------------------------------------------------------------------------
# Each of these exists because the merge step is about to concatenate this body
# into a document whose structure it, not the drafter, owns. A heading at the
# wrong depth silently re-parents every following section; raw HTML survives
# into the deliverable and then into whatever renders it; a LaTeX table in a
# Markdown document is a block of source code in the middle of the prose.
# ============================================================================

_ATX_HEADING_RE = re.compile(r"(?m)^(#{1,6})\s+(.*)$")
# `<a id="x">` style anchors, `<br>`, `<table>` — anything that is a tag rather
# than a comparison operator. Requires a letter or `/` right after the `<` so a
# genuine `a < b` in prose is not flagged.
_RAW_HTML_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?/?>")
_LATEX_TABLE_RE = re.compile(r"\\begin\{(tabular\*?|tabularx|table\*?)\}")
_LATEX_FIGURE_RE = re.compile(r"\\begin\{(figure\*?)\}|\\includegraphics\b")
_FENCE_RE = re.compile(r"(?m)^\s*```")
# `\ cite{...}` — the one LaTeX repair that still matters in Markdown, because
# the citation command survives in both dialects and a spaced one is invisible
# to every cite-key scan in the pipeline.
_MD_SPACED_CITE_RE = re.compile(r"\\[ \t]+(cite[tp]?)\b")


def _own_heading_level(item: dict) -> int:
    """The heading depth the merge step will give this section.

    `# Title` is the survey, `## N Section` an L1, `### N.M Subsection` an L2 —
    the same ladder `phase05_merge_full_draft.py` emits. A leaf with a parent is
    an L2; one without is an L1.
    """
    return 3 if (item.get("parent_id") or "").strip() else 2


def _md_heading_warnings(body: str, own_level: int) -> list[str]:
    """Headings inside the body must sit BELOW the section's own heading.

    The drafter does not write its own title — the merge step does, exactly as
    it writes `\\subsection{}` on the LaTeX path. So any heading here is an
    internal subdivision, and one at the section's own level or above escapes
    the section and re-parents everything after it.
    """
    out: list[str] = []
    for match in _ATX_HEADING_RE.finditer(body):
        level = len(match.group(1))
        if level <= own_level:
            out.append(
                f"md_heading_level: '{shorten(match.group(2).strip(), 40)}' is "
                f"h{level}; this section is h{own_level}, so its own headings "
                f"must be h{own_level + 1} or deeper"
            )
    return out


def _md_structure_warnings(body: str) -> list[str]:
    """Raw HTML and non-pipe tables — the two ways a Markdown draft stops being
    Markdown."""
    out: list[str] = []
    html = _RAW_HTML_RE.findall(body)
    if html:
        out.append(f"md_raw_html: {sorted(set(html))[:5]}")
    if _LATEX_TABLE_RE.search(body):
        out.append("md_latex_table: use a GitHub pipe table, not \\begin{tabular}")
    if "<table" in body.lower():
        out.append("md_html_table: use a GitHub pipe table, not <table>")
    return out


def _latex_float_warnings(body: str, item: dict) -> list[str]:
    """A LaTeX section draft carries prose, never a float body.

    The section writer builds its section's tables — but into
    `05_generation/tables/{table_id}.tex`, which `phase05b_insert_assets`
    then `\\input`s at the paragraph where the prose first references it. A
    table written into the prose INSTEAD is a draft that reads fine and merges
    fine; a table written into the prose AS WELL is two floats sharing one
    `\\label`, `\\ref{}` resolving to whichever LaTeX defined last, and a
    caption printing its number twice. One survey shipped that, and nothing in
    six offline checks saw it — a human found it in the PDF, and repairing it
    cost 23% of the run's working window.

    The check was Markdown-only until then, which is why it never fired: the
    dialect where a LaTeX table is merely ugly was guarded, and the dialect
    where it is a duplicate-label defect was not.
    """
    if not _LATEX_TABLE_RE.search(body) and not _LATEX_FIGURE_RE.search(body):
        return []

    planned = [t.get("label", "") for t in (item.get("planned_tables") or [])]
    where = (f"this section's table(s) belong in "
             f"05_generation/tables/{{table_id}}.tex — "
             f"{', '.join(t.get('table_id', '?') for t in (item.get('planned_tables') or [])) or 'none planned here'}")
    out: list[str] = []
    if _LATEX_TABLE_RE.search(body):
        out.append(
            "latex_float_in_prose: body_md contains a table environment. "
            "Move the whole `\\begin{table}…\\end{table}` out of body_md into "
            f"its own file and leave only `Table~\\ref{{{planned[0] if planned else 'tab:<id>'}}}` "
            f"in the prose. {where}"
        )
    if _LATEX_FIGURE_RE.search(body):
        out.append(
            "latex_float_in_prose: body_md contains a figure environment. "
            "Figures are drawn by a later, scripted stage from the figure "
            "worklist — the prose carries `Figure~\\ref{fig:<id>}` and nothing "
            "else. Delete the environment."
        )
    return out


def _normalize_markdown_commands(text: str) -> tuple[str, dict[str, int]]:
    """The Markdown counterpart of `normalize_latex_commands`.

    Repairs `\\ citet{}` — which breaks citation resolution in either dialect —
    and nothing else. The escaped-math-delimiter repair its LaTeX sibling also
    performs is not applied: `\\$\\beta\\$` is not a thing a Markdown document
    can mean, and rewriting it to `$\\beta$` would quietly invent inline maths
    the drafter did not ask for. Returns the same dict shape so the status row
    is identical on both paths.
    """
    text, n_cite = _MD_SPACED_CITE_RE.subn(r"\\\1", text)
    return text, {"spaced_cite": n_cite, "escaped_math_macro": 0}


# ============================================================================
# The per-section citation floor
# ============================================================================


def _citation_floor(ws: Workspace) -> dict:
    """Read `min_papers_per_section` out of `01_input/writing_request.json`.

    Only a requirement the intake stage declared enforceable counts: mode
    `validator` and `outline` among the stages that must act on it. A
    `prompt_only` copy of the same wish is passed to the drafting subagents and
    deliberately not checked here — that distinction is the whole point of the
    enforcement field, and quietly promoting a prompt_only requirement to a hard
    gate would fail runs for a rule the user was told was advisory.

    Returns a dict that is always the same shape, so callers and status rows do
    not branch: `{"floor": int|None, "requirement_id": str|None, "reason": str}`.
    """
    result = {"floor": None, "requirement_id": None, "reason": ""}
    from task_contract import read_request, constraints
    doc = {'constraints': constraints(read_request(ws.input.parent))}

    for req in doc.get("constraints") or []:
        if not isinstance(req, dict) or req.get("kind") != "min_papers_per_section":
            continue
        enforcement = req.get("enforcement") or {}
        if enforcement.get("mode") != "validator":
            continue
        if "outline" not in (enforcement.get("where") or []):
            continue
        value = req.get("value")
        if isinstance(value, dict):
            value = value.get("min")
        if isinstance(value, int) and value > 0:
            result["floor"] = value
            result["requirement_id"] = req.get("id")
            result["reason"] = f"{req.get('id', '?')}: at least {value} paper(s) per section"
            return result

    result["reason"] = "no enforceable min_papers_per_section requirement"
    return result


def _distinct_cited(body: str, allowed: set[str]) -> set[str]:
    """Whitelisted cite keys actually used in the prose, deduplicated.

    Distinct, not total: a section that names the same paper six times has cited
    one paper, and counting the calls would let it clear any floor by repetition.
    """
    used: set[str] = set()
    for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", body):
        for key in raw.split(","):
            key = key.strip()
            if key in allowed:
                used.add(key)
    return used


def _floor_shortfall(item: dict, body: str, floor: int) -> dict | None:
    """Check one section against the floor. Returns a shortfall record or None.

    The required count is capped at the size of the section's own whitelist. A
    section handed two papers cannot cite three, and failing it for that would
    be blaming the drafter for an allocation the outline made — that failure
    belongs to `validate_outline.py`, which checks the same requirement against
    the plan. Sections with no papers at all (abstract, introduction,
    conclusion) are exempt for the same reason.
    """
    allowed = set(item.get("allowed_cite_keys") or [])
    if not allowed:
        return None
    required = min(floor, len(allowed))
    cited = _distinct_cited(body, allowed)
    if len(cited) >= required:
        return None
    return {
        "section_id": item["section_id"],
        "cited": sorted(cited),
        "distinct_cited": len(cited),
        "required": required,
        "floor": floor,
        "whitelist_size": len(allowed),
    }


# ----------------------------------------------------------------------------
# Whole-section structure: the checks that replace the per-leaf boundary
# ----------------------------------------------------------------------------
# A writer now owns a whole L1 section and may move a paper between its
# subsections -- that freedom is the point, since the outline allocated papers
# without having read a word of prose. But a freedom with nothing checking it is
# just the removal of a constraint, and the two ways it goes wrong are specific
# enough to be machine-checkable: every paper crammed into one subsection, and
# one paper carrying the whole section by being cited everywhere.

_LATEX_SUBSECTION_RE = re.compile(r"\\subsection\*?\s*\{")
_MD_SUB_HEADING_RE = re.compile(r"(?m)^\s{0,3}(#{3,6})\s+(.+?)\s*$")

# At least this many distinct whitelisted papers per subsection, and at most
# this many subsections may cite the same paper. Both are floors on spread
# rather than targets: two is the smallest number that distinguishes "spread"
# from "not spread", and tightening either would start dictating the argument.
MIN_CITES_PER_SUBSECTION = 1
MAX_SUBSECTIONS_PER_KEY = 2


def _split_by_subsection(body: str, dialect: str) -> list[str]:
    """The body's prose, one chunk per subsection heading it contains.

    Text before the first heading is dropped: it is the section's own opening
    paragraph, which belongs to no subsection and should not be credited to one.
    """
    pattern = _LATEX_SUBSECTION_RE if dialect != "markdown" else _MD_SUB_HEADING_RE
    starts = [m.start() for m in pattern.finditer(body)]
    if not starts:
        return []
    bounds = starts + [len(body)]
    return [body[bounds[i]:bounds[i + 1]] for i in range(len(starts))]


def _subsection_warnings(item: dict, body: str, dialect: str) -> list[str]:
    """Structure and spread checks for an item that owns subsections."""
    planned = item.get("subsections") or []
    if not planned:
        return []

    out: list[str] = []
    allowed = set(item.get("allowed_cite_keys") or [])

    if dialect == "markdown":
        found = len(_MD_SUB_HEADING_RE.findall(body))
        if found < len(planned):
            out.append(f"subsection_headings_missing: found {found} sub-heading(s), "
                       f"the section plans {len(planned)}")
    else:
        found = len(_LATEX_SUBSECTION_RE.findall(body))
        if found < len(planned):
            out.append(f"subsection_headings_missing: found {found} "
                       f"\\subsection(s), the section plans {len(planned)}")
        # Labels are checked by name, not by count: `\ref{sec:s3_2}` elsewhere
        # in the document resolves to this exact string or to nothing, and the
        # worklist is where that string is decided.
        for sub in planned:
            label = sub.get("label") or ""
            if label and f"\\label{{{label}}}" not in body:
                out.append(f"subsection_label_missing: {label} "
                           f"({sub.get('section_id')})")

    chunks = _split_by_subsection(body, dialect)
    if not chunks or not allowed:
        return out

    # Spread. Skipped when the section simply does not have enough papers to
    # give each subsection one -- that is an outline allocation, and blaming the
    # drafter for it is the mistake `_floor_shortfall` already refuses to make.
    if len(allowed) >= len(chunks) * MIN_CITES_PER_SUBSECTION:
        for index, chunk in enumerate(chunks, 1):
            cited = _distinct_cited(chunk, allowed)
            if len(cited) < MIN_CITES_PER_SUBSECTION:
                out.append(f"subsection_uncited: subsection {index} of "
                           f"{len(chunks)} cites nothing; the section's papers "
                           f"belong across its subsections, not in one of them")

    # Reuse. A paper discussed in three subsections is usually a section that
    # found one paper to talk about rather than a paper that genuinely spans.
    spread: dict[str, int] = {}
    for chunk in chunks:
        for key in _distinct_cited(chunk, allowed):
            spread[key] = spread.get(key, 0) + 1
    for key, count in sorted(spread.items()):
        if count > MAX_SUBSECTIONS_PER_KEY:
            out.append(f"cite_key_overused: {key} appears in {count} of "
                       f"{len(chunks)} subsections")
    return out


def _strip_bogus_citations(body: str, allowed: set[str]) -> tuple[str, set[str]]:
    bogus: set[str] = set()
    for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", body):
        for k in raw.split(","):
            k = k.strip()
            if k and k not in allowed:
                bogus.add(k)
    if not bogus:
        return body, set()
    for bad in sorted(bogus, key=len, reverse=True):
        body = re.sub(
            r"\\cite[tp]?\{[^}]*\b" + re.escape(bad) + r"\b[^}]*\}",
            "",
            body,
        )
    body = re.sub(r"\\cite[tp]?\{\s*,*\s*\}", "", body)
    body = re.sub(r"\s{2,}", " ", body).strip()
    return body, bogus


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "workspace", nargs="?", default=None, metavar="WORKSPACE",
        help=("The run workspace. Optional only because the merge stage runs "
              "this script with cwd already set to it; a section writer "
              "self-checking from its own Bash tool inherits the launch "
              "directory instead and must pass it."),
    )
    p.add_argument(
        "--only", action="append", metavar="SECTION_ID",
        help=("Check only these sections. A section writer self-checking its own "
              "draft has no use for its siblings' verdicts, and a report full of "
              "`missing` ids for sections that are still being written elsewhere "
              "reads like a failure. Repeatable. The merge gate passes nothing "
              "and checks everything."),
    )
    args = p.parse_args()

    started = time.time()
    ws = Workspace(args.workspace)
    require_workspace(ws, "validate_drafts.py")
    log_script_start(ws, "validate_drafts")

    worklist = load_json(ws.drafting_worklist_path())
    items = worklist["items"]
    if args.only:
        wanted = {str(s) for s in args.only}
        known = {str(i["section_id"]) for i in items}
        unknown = sorted(wanted - known)
        if unknown:
            print(f"[warn] --only names section(s) not in the worklist: {', '.join(unknown)}",
                  file=sys.stderr)
        items = [i for i in items if str(i["section_id"]) in wanted]

    spec = read_output_spec(ws.root)
    dialect = "markdown" if spec["format"] == "markdown" else "latex"
    floor_info = _citation_floor(ws)
    floor = floor_info["floor"]

    drafted = 0
    checked_bodies = []
    missing: list[str] = []
    repaired: list[dict] = []
    degraded: list[str] = []
    writer_flagged: list[dict] = []
    invalid: list[dict] = []
    floor_shortfalls: list[dict] = []

    for w in items:
        sid = w["section_id"]
        path = ws.section_drafts_dir / f"{sid}.json"
        if not path.exists():
            missing.append(sid)
            continue
        try:
            draft = load_json(path)
        except Exception as e:  # noqa: BLE001
            invalid.append({"section_id": sid, "error": f"json_load_failed: {e}"})
            continue
        if not isinstance(draft, dict):
            invalid.append({"section_id": sid, "error": "draft is not an object"})
            continue

        if draft.get("writing_input_sha256"):
            # Scripted drafts must still describe the current packet. This
            # prevents a failed redraft from leaving an older deliverable that
            # could otherwise pass ordinary citation/shape checks.
            sys.path.insert(0, str(_slr_paths.HOME / "scripts"))
            from writing import packet
            from writing_contract import digest
            try:
                current = digest(packet(ws.root, sid))
            except (OSError, ValueError, KeyError) as exc:
                invalid.append({"section_id": sid, "error": f"writing_packet_unavailable: {exc}"})
                continue
            if current != draft["writing_input_sha256"]:
                invalid.append({"section_id": sid, "error": "stale_scripted_draft: input changed; regenerate or explicitly review as a manual draft"})
                continue

        # Enforce required identity fields
        draft["section_id"] = sid
        if not draft.get("title"):
            draft["title"] = w["title"]

        # ---- Separate the writer's self-report from this validator's verdict.
        #
        # `warnings` and `degraded` used to be one field each, shared between
        # the agent that wrote the section and the script that judges it. The
        # writer has write access to its own draft, so "fix the content" and
        # "clear the verdict" were mechanically indistinguishable — and one
        # run took the second route: a writer that could not find a supporting
        # quote for one claim ran
        #
        #     d['warnings'] = []; d['degraded'] = False; json.dump(...)
        #
        # re-ran this validator, got a clean report, and reported clean. That
        # claim is still on disk with no support, marked green.
        #
        # It also failed in the honest direction. `degraded` was read back with
        # `setdefault`, so a writer that truthfully set `degraded: true` with a
        # free-text warning matching no trigger prefix kept the flag in its own
        # file and never appeared in this status object's `degraded[]` — the
        # one place every downstream consumer reads.
        #
        # So: the writer's account is preserved verbatim under `writer_notes`
        # and `writer_degraded`, and `warnings` / `degraded` are recomputed
        # here from the draft's CONTENT every run. Clearing them buys nothing;
        # the trigger scan below can no longer be steered by a string the
        # writer planted; and an honest self-report still reaches `degraded[]`.
        writer_notes = [n for n in (draft.get("writer_notes", draft.get("warnings")) or []) if isinstance(n, str)]
        writer_degraded = bool(draft.get("writer_degraded", draft.get("degraded")))
        draft["writer_notes"] = writer_notes
        draft["writer_degraded"] = writer_degraded
        draft["warnings"] = []
        draft["degraded"] = False

        # Schema-drift coercion for claims / insights (warn + repair, never fail).
        raw_claims = draft.get("claims")
        if raw_claims is None:
            draft["claims"] = []
        elif not isinstance(raw_claims, list):
            draft["warnings"] = draft.get("warnings") or []
            draft["warnings"].append("claim_schema_drift: claims_not_list")
            draft["claims"] = []
        raw_insights = draft.get("insights")
        if raw_insights is None:
            draft["insights"] = []
        elif not isinstance(raw_insights, list):
            draft["warnings"] = draft.get("warnings") or []
            draft["warnings"].append("insight_schema_drift: insights_not_list")
            draft["insights"] = []
        draft.setdefault("warnings", [])

        body = draft.get("body_md") or ""
        if not isinstance(body, str) or not body.strip():
            invalid.append({"section_id": sid, "error": "body_md is empty or not text"})
            draft["degraded"] = True
            draft["warnings"].append("body_md_empty")
            write_json(path, draft)
            continue

        # Repair `\ citet{}`-style malformations FIRST — before the whitelist
        # scan below. `_strip_bogus_citations` keys off `\\cite[tp]?\{`, which
        # would otherwise miss a `\ citet{bad}` key and let it slip past the
        # allowlist. Fixing the source JSON here also keeps it clean for the
        # refinement stage and human review. The Markdown variant skips the
        # escaped-math half of the repair; see `_normalize_markdown_commands`.
        if dialect == "markdown":
            body_norm, latex_fixes = _normalize_markdown_commands(body)
        else:
            body_norm, latex_fixes = normalize_latex_commands(body)
        if latex_fixes["spaced_cite"] or latex_fixes["escaped_math_macro"]:
            body = body_norm
            draft["body_md"] = body
            draft["warnings"].append(f"latex_command_normalized: {latex_fixes}")
            repaired.append({"section_id": sid, "latex_fixes": latex_fixes})

        allowed = set(w["allowed_cite_keys"])

        # Strip bogus body cites
        _, bogus_body = _strip_bogus_citations(body, allowed)
        if bogus_body:
            invalid.append({"section_id": sid, "error": "citation_keys_outside_assignment", "cite_keys": sorted(bogus_body)})
            continue
        body_repaired = body
        if bogus_body:
            draft["body_md"] = body_repaired
            draft["warnings"].append(f"whitelist_violation_stripped_body: {sorted(bogus_body)}")
            repaired.append({"section_id": sid, "stripped_from_body": sorted(bogus_body)})

        # Auto-escape unescaped percent signs after digits ("10%" -> "10\%").
        # Idempotent (lookbehind ignores already-escaped \%); non-blocking
        # (warning only, does NOT mark the section degraded). LaTeX only: in
        # Markdown `%` is an ordinary character and `10\%` would render the
        # backslash, so the "repair" would be the defect.
        if dialect == "latex":
            body_pre_pct = draft.get("body_md") or ""
            body_pct_fixed, n_pct = _UNESCAPED_PERCENT_RE.subn(r"\1\\%", body_pre_pct)
            if n_pct:
                draft["body_md"] = body_pct_fixed
                draft["warnings"].append(f"latex_percent_escaped: {n_pct} occurrence(s)")
                repaired.append({"section_id": sid, "percent_escaped": n_pct})

        # Filter claims against the section's whitelist. Paper-level and no
        # finer — see the banner at the top of this file for why the
        # quote-level layer was removed rather than made easier to satisfy.
        cleaned_claims = []
        dropped_quotes = 0
        for i, claim in enumerate(draft.get("claims") or []):
            if not isinstance(claim, dict):
                draft["warnings"].append(f"claim_schema_drift: c{i}_not_dict")
                continue
            if "text" not in claim or not str(claim.get("text") or "").strip():
                draft["warnings"].append(f"claim_schema_drift: c{i}_missing_text")
                continue
            ck = [k for k in (claim.get("cite_keys") or []) if k in allowed]
            if not ck and (claim.get("cite_keys") or []):
                draft["warnings"].append(f"claim_dropped_whitelist: c{i} {claim.get('cite_keys')}")
                continue
            claim["cite_keys"] = ck
            claim["id"] = claim.get("id") or f"{sid}-c{len(cleaned_claims) + 1}"
            claim.setdefault("evidence", "weak")
            # A draft written against the old schema still parses. Drop the
            # field silently rather than warning: the writer did more work than
            # was asked for, which is not a defect in the draft, and a warning
            # here would send it back to fix something that no longer exists.
            if claim.pop("supporting_quotes", None):
                dropped_quotes += 1
            cleaned_claims.append(claim)
        draft["claims"] = cleaned_claims
        if dropped_quotes:
            repaired.append({"section_id": sid,
                             "supporting_quotes_dropped": dropped_quotes})

        # Insight handling is identical across execution profiles. `scope`
        # controls orchestration cost elsewhere; it must neither discard
        # synthesis the writer produced nor lower the section's writing bar.
        insights = draft.get("insights") or []
        # Preserve the existing schema-normalisation only; the role contract,
        # not a new validator rule, is responsible for whether insight exists.
        cleaned_insights = []
        for j, ins in enumerate(insights):
            if not isinstance(ins, dict) or not str(ins.get("text") or "").strip():
                draft["warnings"].append(f"insight_schema_drift: s{j}")
                continue
            ins["id"] = ins.get("id") or f"{sid}-s{len(cleaned_insights) + 1}"
            cleaned_insights.append({"id": ins["id"], "text": ins["text"]})
        draft["insights"] = cleaned_insights

        # Dialect-specific structure lints on the (potentially repaired) body.
        body_for_check = draft.get("body_md") or ""
        if dialect == "markdown":
            # Fenced code blocks are still out — a survey has no code listings,
            # and a stray fence swallows the rest of the section on merge.
            if _FENCE_RE.search(body_for_check):
                draft["warnings"].append("markdown_residue: markdown_fenced_block")
            for warning in _md_heading_warnings(body_for_check, _own_heading_level(w)):
                draft["warnings"].append(warning)
            for warning in _md_structure_warnings(body_for_check):
                draft["warnings"].append(warning)
        else:
            for pat, label in _MARKDOWN_PATTERNS:
                if pat.search(body_for_check):
                    draft["warnings"].append(f"markdown_residue: {label}")
            for warning in _latex_float_warnings(body_for_check, w):
                draft["warnings"].append(warning)

        # Whole-section structure: subsection headings, their labels, and how
        # the section's papers are spread across them.
        for warning in _subsection_warnings(w, body_for_check, dialect):
            draft["warnings"].append(warning)

        # ----- F3 / B3 / C4 / B1 quality lints (all soft warnings; the runner
        # cannot retry on these but the agent can use them to decide whether to
        # re-prompt the model). They mark `degraded` so coherency-refinement
        # knows the section needs follow-up.
        section_kind = (w.get("section_kind") or "").lower()
        language = (w.get("language") or "english").lower()

        # F3: every planned figure / table must be referenced at least once.
        missing_fig_labels = _check_missing_refs(body_for_check, w.get("planned_figures") or [], "figure")
        for lab in missing_fig_labels:
            draft["warnings"].append(f"figure_ref_missing: {lab}")
        missing_tab_labels = _check_missing_refs(body_for_check, w.get("planned_tables") or [], "table")
        for lab in missing_tab_labels:
            draft["warnings"].append(f"table_ref_missing: {lab}")

        # B3 / C4 depth lints for technique sections with ≥3 papers.
        if section_kind == "technique" and len(w.get("allowed_papers") or []) >= 3:
            limit_re = _LIMITATION_SIGNAL_ZH_RE if language == "chinese" else _LIMITATION_SIGNAL_RE
            if not limit_re.search(body_for_check):
                draft["warnings"].append("technique_missing_limitation_discussion")
            close_re = _CRITICAL_CLOSER_SIGNAL_ZH_RE if language == "chinese" else _CRITICAL_CLOSER_SIGNAL_RE
            tail = _last_sentences(body_for_check, 2)
            if tail and not close_re.search(tail):
                draft["warnings"].append("technique_missing_critical_closer")

        # B1: paragraph-opener repetition.
        paragraphs = _split_paragraphs(body_for_check)
        if len(paragraphs) >= 3:
            opener_counts = _paragraph_openers(paragraphs, language)
            for opener, n in opener_counts.items():
                if n >= 2:
                    draft["warnings"].append(f"opener_repetition: '{opener}' x{n}")

        # This validator runs again on every re-run of the merge stage, and it
        # appends to the warnings already on disk. Left alone, a section that
        # went through three rounds carries each of its warnings three times,
        # and a reader of the status object reads a repetition count as an
        # emphasis it was never given. Deduplicate in place, keeping
        # first-seen order. Everything in here was derived by this run; the
        # writer's own notes live in `writer_notes` and are not merged in.
        seen_warnings, unique_warnings = set(), []
        for warning in draft.get("warnings", []):
            if warning in seen_warnings:
                continue
            seen_warnings.add(warning)
            unique_warnings.append(warning)
        draft["warnings"] = unique_warnings

        degraded_triggers = (
            "whitelist", "claim_dropped", "claim_schema_drift",
            "insight_schema_drift",
            "markdown_residue",
            "md_",  # md_heading_level / md_raw_html / md_latex_table / md_html_table
            # A float body in the prose. Degrading rather than blocking: the
            # draft is usable and phase05b now refuses to inject a second float
            # over it, so the document is correct either way. But it names the
            # section whose writer needs re-delegating, which is the whole
            # point of catching it here rather than in the PDF.
            "latex_float_in_prose",
            "figure_ref_missing", "table_ref_missing",
            "technique_missing_limitation_discussion",
            "opener_repetition",
            # Whole-section structure. Degrading rather than blocking: a section
            # whose papers cluster is a worse section, not an unusable one, and
            # the refiner reads `degraded` to know where to look. A missing
            # subsection label is the exception in spirit -- it dangles a
            # `\ref` -- but `fix_broken_refs` in the merge step already handles
            # a dangling target, so failing the stage here would cost a redraft
            # to fix something downstream repairs deterministically.
            "subsection_headings_missing", "subsection_label_missing",
            "subsection_uncited",
        )
        # Two independent routes to degraded, and both reach `degraded[]`:
        # something this run detected, or the writer saying so itself. The
        # second used to stop at the writer's own file.
        if any(
            wn == "body_md_empty" or wn.startswith(degraded_triggers)
            for wn in draft["warnings"]
        ):
            draft["degraded"] = True
        if draft["writer_degraded"]:
            draft["degraded"] = True
            writer_flagged.append({"section_id": sid, "notes": draft["writer_notes"]})
        if draft["degraded"] and sid not in degraded:
            degraded.append(sid)

        # ---- The per-section citation floor (blocking) ---------------------
        # Last, and on the repaired body, so a section is judged on the
        # citations that survived the whitelist strip rather than the ones it
        # claimed. Blocking rather than degrading because the requirement
        # declared itself `enforcement.mode: validator`, and a validator that
        # only warns is a requirement the user was told is enforced and is not.
        # The draft is still written first: the repairs above are worth keeping
        # for the re-draft, which starts from what is on disk.
        if floor is not None:
            shortfall = _floor_shortfall(w, body_for_check, floor)
            if shortfall is not None:
                draft["degraded"] = True
                draft["warnings"].append(
                    f"citation_floor_short: cites {shortfall['distinct_cited']} "
                    f"distinct paper(s), needs {shortfall['required']}"
                )
                write_json(path, draft)
                floor_shortfalls.append(shortfall)
                invalid.append({
                    "section_id": sid,
                    "error": (
                        f"citation_floor_short: section cites "
                        f"{shortfall['distinct_cited']} distinct paper(s) "
                        f"({shortfall['cited']}) but this run requires "
                        f"{shortfall['required']} "
                        f"(min_papers_per_section={floor}, capped at the "
                        f"section's whitelist of {shortfall['whitelist_size']})"
                    ),
                })
                continue

        write_json(path, draft)
        drafted += 1
        checked_bodies.append(body_for_check)

    length_check = {"deferred": "Full-output check requires every section."}
    if not args.only and not missing and not invalid:
        budget = explicit_length_budget(ws.root, worklist.get("language", "english"))
        length_check = document_length_check(checked_bodies, budget)
        invalid.extend({"scope": "document", "error": error}
                       for error in length_check.get("violations", []))

    final_status = "SUCCESS"
    if missing or invalid:
        final_status = "PARTIAL_SUCCESS" if drafted else "FAILED"
    elif degraded:
        final_status = "PARTIAL_SUCCESS"

    write_status(
        ws, "validate_drafts", final_status,
        duration_sec=round(time.time() - started, 2),
        # A `--only` run is a self-check, not the gate. The merge stage re-runs
        # this over every item, so a filtered SUCCESS must never be mistaken for
        # "the fan-out is complete".
        scope_checked=(sorted(args.only) if args.only else "all"),
        dialect=dialect,
        output_format=spec["format"],
        output_spec_source=spec["spec_source"],
        output_spec_error=spec["spec_error"],
        citation_floor={
            "floor": floor,
            "requirement_id": floor_info["requirement_id"],
            "reason": floor_info["reason"],
            "sections_checked": sum(
                1 for it in items if (it.get("allowed_cite_keys") or [])
            ) if floor is not None else 0,
            "sections_short": floor_shortfalls,
        },
        document_length=length_check,
        drafted=drafted,
        missing=missing,
        invalid=invalid,
        repaired=repaired,
        degraded=degraded,
        # Sections whose writer declared itself degraded, separately from what
        # this run detected. Usually the honest case — "four of my claims have
        # no citable support in the papers I was given" — and the one kind of
        # degradation no offline check can find, so it is worth naming rather
        # than folding into the count above.
        writer_flagged=writer_flagged,
    )
    return 0 if final_status != "FAILED" else 3


if __name__ == "__main__":
    sys.exit(main())
