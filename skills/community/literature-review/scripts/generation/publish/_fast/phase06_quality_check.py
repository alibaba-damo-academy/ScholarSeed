"""Compatibility quality-check CLI for older section workflows.

Not called by current manuscript_publication; its editorial heuristics must not
be added to the four-rule publication path."""
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
import re
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[4]
pass
from writing_contract import load_outline, explicit_length_budget
from _utils import (  # noqa: E402
    Workspace,
    load_json,
    log_script_start,
    now_iso,
    write_json,
    write_status,
)
from output_spec import read_output_spec  # noqa: E402

AI_BOILERPLATE_PATTERNS_EN = [
    r"\bIt is worth noting that\b",
    r"\bIn this paper, we\b",
    r"\bFurthermore, it is important to\b",
    r"\bIt should be noted that\b",
    r"\bIt can be seen that\b",
    r"\bAs can be seen\b",
    r"\bIn summary,\b",
    r"\bAt the same time,\b",
    r"\bIn other words,\b",
    r"\bIt is well known that\b",
]

WEASEL_PATTERNS_EN = [
    r"\bsome researchers\b",
    r"\bit is generally believed\b",
    r"\bmany works\b",
    r"\bvarious studies\b",
    r"\bnumerous works\b",
    r"\bcertain methods\b",
    r"\boften observed\b",
]

# Chinese boilerplate phrases — common LLM tells in academic Mandarin.
# No \b boundaries because Chinese has no whitespace tokenisation; the
# patterns are matched as substrings (re.IGNORECASE doesn't affect CJK).
AI_BOILERPLATE_PATTERNS_ZH = [
    r"值得注意的是",
    r"综上所述",
    r"由此可见",
    r"在本文中，我们",
    r"众所周知",
    r"需要指出的是",
    r"不难看出",
    r"显而易见",
    r"在某种程度上",
    r"总而言之",
    r"由此不难看出",
    r"可以看出",
    r"总的来说",
]

WEASEL_PATTERNS_ZH = [
    r"一些研究",
    r"众多工作",
    r"普遍认为",
    r"各种方法",
    r"许多工作",
    r"通常被观察到",
    r"普遍被观察到",
    r"在很大程度上",
]

# Backwards-compat aliases — older imports may still reference the
# unsuffixed names. These resolve to the English lists.
AI_BOILERPLATE_PATTERNS = AI_BOILERPLATE_PATTERNS_EN
WEASEL_PATTERNS = WEASEL_PATTERNS_EN

THRESHOLDS_SPEED = {
    "section_balance_ratio_max": 4.0,
    "ai_boilerplate_density_max": 0.05,
    "bullet_ratio_max": 0.30,
    "weasel_word_density_max": 0.02,
    "citation_count_min": 10,
    "recent_3y_citation_ratio_min": 0.20,
}

THRESHOLDS_DEEP = {
    "section_balance_ratio_max": 3.0,
    "ai_boilerplate_density_max": 0.05,
    "bullet_ratio_max": 0.25,
    "weasel_word_density_max": 0.01,
    "citation_count_min": 15,
    "recent_3y_citation_ratio_min": 0.30,
}

# Chinese thresholds — only the density-based ones differ. Boilerplate /
# weasel densities are computed against an effective-word count where
# each ~1.6 中文字符 counts as one "word" (see _effective_word_count),
# so the same density caps as English transfer naturally. We loosen
# section_balance slightly because Chinese sections vary more in
# character-count than English sections vary in word-count.
THRESHOLDS_SPEED_ZH = {
    **THRESHOLDS_SPEED,
    "section_balance_ratio_max": 4.5,
}

THRESHOLDS_DEEP_ZH = {
    **THRESHOLDS_DEEP,
    "section_balance_ratio_max": 3.5,
}


_CJK_RANGES = (
    (0x4E00, 0x9FFF),   # CJK Unified Ideographs
    (0x3400, 0x4DBF),   # CJK Extension A
    (0xF900, 0xFAFF),   # CJK Compatibility Ideographs
)


def _is_cjk_char(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _CJK_RANGES)


def _effective_word_count(text: str) -> int:
    """Language-aware effective word count.

    English words are counted by whitespace split. Chinese characters are
    counted individually then divided by 1.6 (the academic-prose ratio
    between a Chinese 字 and an English word). The two are summed so the
    same density thresholds work for mixed-language drafts.
    """
    if not text:
        return 1
    cjk = sum(1 for ch in text if _is_cjk_char(ch))
    # Strip CJK chars before splitting so they don't pollute the English count.
    non_cjk = "".join(" " if _is_cjk_char(ch) else ch for ch in text)
    en = len(non_cjk.split())
    return max(1, en + int(round(cjk / 1.6)))


def _density(text: str, patterns: list[str]) -> tuple[float, list[dict]]:
    word_count = _effective_word_count(text)
    hits = []
    total = 0
    for pat in patterns:
        cnt = len(re.findall(pat, text, flags=re.IGNORECASE))
        if cnt:
            hits.append({"phrase": pat, "count": cnt})
            total += cnt
    return total / word_count, hits


def _latex_effective_word_count(tex: str) -> int:
    """Strip LaTeX commands then run language-aware effective counting.

    Replaces `latex_word_count` from `_utils` for phase 6 only — the
    upstream helper uses bare `text.split()` which severely undercounts
    Chinese sections.
    """
    t = re.sub(r"\\[a-zA-Z]+\*?\{[^}]*\}", " ", tex)
    t = re.sub(r"\\[a-zA-Z]+\*?", " ", t)
    t = re.sub(r"[{}%]", " ", t)
    return _effective_word_count(t)


def _bullet_ratio(text: str) -> float:
    lines = [l for l in text.splitlines() if l.strip()]
    if not lines:
        return 0.0
    bullets = sum(1 for l in lines if l.strip().startswith("\\item") or l.strip().startswith("- "))
    return bullets / len(lines)


# ---------------------------------------------------------------------------
# Which sections to score
#
# The drafting fan-out is one subagent per TOP-LEVEL section, and each writes
# one file named for its top-level id — `section_drafts/3.json`, never
# `3.1.json`. Scoring used to iterate the outline's LEAF sections instead, so
# every id with a dot resolved to no file and hit a silent `continue`. Only ids
# that happen to be both a leaf and a top-level section (a section with no
# subsections — typically the abstract and the conclusion) were ever scored,
# and `by_section` was non-empty, so the "no section bodies" guard never fired.
# A 17-leaf outline was reported PASS on 2 sections.
#
# The worklist is the authority on what was actually dispatched; the outline
# tree is the fallback for a workspace where prep did not run.
# ---------------------------------------------------------------------------

# Kinds excluded from the balance ratio. An abstract is a fifth the length of a
# body section by design, so comparing them measures the template, not the
# draft.
_NON_BODY_KINDS = {"abstract", "introduction", "conclusion"}


def _drafted_sections(ws: Workspace, outline: dict) -> list[dict]:
    """(section_id, title, kind) for every section the fan-out owns, in order."""
    wl_path = ws.drafting_worklist_path()
    if wl_path.exists():
        items = (load_json(wl_path) or {}).get("items") or []
        if items:
            return [{"section_id": str(i.get("section_id") or ""),
                     "title": i.get("title") or "",
                     "kind": (i.get("section_kind") or "").lower()}
                    for i in items if i.get("section_id") is not None]
    out = []
    for sec in outline.get("outline_tree", []):
        sid = str(sec.get("section_id") or "")
        title = sec.get("title") or ""
        kind = "abstract" if sid == "0" or title.strip().lower() == "abstract" else ""
        out.append({"section_id": sid, "title": title, "kind": kind})
    return out


def _norm_title(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w一-鿿]+", " ", (s or "").lower())).strip()


def _split_merged_draft(text: str, source_format: str,
                        sections: list[dict]) -> dict[str, str]:
    """Recover per-section bodies from the merged draft, keyed by section_id.

    `legacy refiner` rewrites the whole document into `full_draft_v2`, so without
    this the quality report scores the *pre-refinement* section drafts and
    silently describes a document that is not the one being published.
    Splitting the merged file back apart recovers the published text by section.

    Matching is by heading title rather than by position, because a positional
    zip against the outline drifts by one for the rest of the document the
    first time a heading does not correspond to a section. Anything that fails
    to match is simply absent from the result and reported as uncovered.
    """
    by_norm = {_norm_title(s["title"]): s["section_id"] for s in sections if s["title"]}
    found: dict[str, str] = {}

    if source_format == "markdown":
        # `## <section_id> <title>` — the id prefix is optional.
        heads = [(m.start(), m.end(), m.group(1)) for m in
                 re.finditer(r"^##[ \t]+(.+?)[ \t]*$", text, flags=re.MULTILINE)]
    else:
        heads = [(m.start(), m.end(), m.group(1)) for m in
                 re.finditer(r"\\section\*?\{([^}]*)\}", text)]
        # The abstract is emitted as an envelope, not as a \section.
        env = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", text, flags=re.DOTALL)
        if env:
            abstract_sid = next((s["section_id"] for s in sections
                                 if s["kind"] == "abstract"), None)
            if abstract_sid is not None:
                found[abstract_sid] = env.group(1).strip()

    for i, (_start, end, raw_title) in enumerate(heads):
        stop = heads[i + 1][0] if i + 1 < len(heads) else len(text)
        title = raw_title.strip()
        if source_format == "markdown":
            # Strip a leading outline number: "2.1 Sparse Attention" → "Sparse …"
            title = re.sub(r"^[\d.]+\s+", "", title)
        sid = by_norm.get(_norm_title(title))
        if sid is not None and sid not in found:
            found[sid] = text[end:stop].strip()
    return found


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--scope", default="speed", choices=["speed", "deep"])
    p.add_argument("--language", default=None, choices=["english", "chinese"])
    args = p.parse_args()

    started = time.time()
    ws = Workspace()
    ws.ensure_output_dirs()
    log_script_start(ws, "phase06_quality_check",
                     scope=getattr(args, "scope", None),
                     language=getattr(args, "language", None))

    outline = load_outline(ws.root)
    selected_papers = load_json(ws.selected_papers_path)
    cite_keys = load_json(ws.cite_keys_path())
    pid_by_key = {ck: pid for pid, ck in cite_keys.items()}

    if args.language:
        language = args.language
    elif ws.query_meta_path().exists():
        language = (load_json(ws.query_meta_path()) or {}).get("language", "english")
    else:
        language = "english"

    # Post 2026-05 refactor: the merged-draft pipeline is split into
    #   v1 (sections only) → v2 (refined by agent) → v3 (assets placed).
    # Quality check runs against v3 — that is the file phase 7 publishes.
    # If v3 is missing, fall back through v2 → v1 so a partial pipeline run
    # still gets a quality report (used during dev / smoke tests).
    #
    # Every metric below is computed from the per-section bodies, not from the
    # merged file, so this check is dialect-independent by construction: the
    # merged draft is read only to assert that a document exists at all. The
    # dialect still decides which file to look for, because a run that produced
    # `full_draft_v3.md` and is asked for `full_draft_v3.tex` would report a
    # missing draft for a document that is sitting right there.
    spec = read_output_spec(ws.root)
    source_format = "markdown" if spec["format"] == "markdown" else "latex"
    suffix = "md" if source_format == "markdown" else "tex"
    candidates = [
        (ws.gen / f"full_draft_v{n}.{suffix}", f"full_draft_v{n}.{suffix}")
        for n in (3, 2, 1)
    ]
    merged_path, merged_label = next(
        ((path, label) for path, label in candidates if path.exists()),
        candidates[0],
    )

    if not merged_path.exists():
        write_status(ws, "phase06_quality_check", "FAILED",
                     duration_sec=round(time.time() - started, 2),
                     message=f"{merged_label} missing; run phase 5 first.")
        return 2
    full_text = merged_path.read_text(encoding="utf-8")
    if not full_text.strip():
        write_status(ws, "phase06_quality_check", "FAILED",
                     duration_sec=round(time.time() - started, 2),
                     message=f"{merged_label} is empty.")
        return 2

    if language == "chinese":
        thresholds = THRESHOLDS_DEEP_ZH if args.scope == "deep" else THRESHOLDS_SPEED_ZH
        ai_patterns = AI_BOILERPLATE_PATTERNS_EN + AI_BOILERPLATE_PATTERNS_ZH
        weasel_patterns = WEASEL_PATTERNS_EN + WEASEL_PATTERNS_ZH
    else:
        thresholds = THRESHOLDS_DEEP if args.scope == "deep" else THRESHOLDS_SPEED
        ai_patterns = AI_BOILERPLATE_PATTERNS_EN
        weasel_patterns = WEASEL_PATTERNS_EN

    # Per-section word counts and citation counts.
    #
    # Two sources, in order of how well they describe the document that is
    # actually being published:
    #   1. the merged draft, split by heading — refined text, recovered
    #   2. `section_drafts/{sid}.json` — pre-refinement text
    # Which one supplied each section is recorded, because "PASS" computed on
    # pre-refinement prose is a different claim from "PASS" on the deliverable.
    sections = _drafted_sections(ws, outline)
    if not outline.get('outline_tree') and (ws.gen/'_internal/manuscript_contract.json').exists():
        # Content-only tasks have no chapter balance/coverage metric. Their
        # content, citations, tables and explicit bounds were checked by accept.
        sys.path.insert(0, str(_slr_paths.HOME/'scripts'))
        from manuscript import verify_accepted
        verify_accepted(ws.root)
        report = {'verdict':'PASS', 'mode':'unsectioned_component', 'rules_only':True,
                  'scientific_review_complete':False, 'fatal_violations':0, 'warning_violations':0}
        write_json(ws.quality_report_path, report)
        write_status(ws, 'phase06_quality_check', 'SUCCESS', **report)
        return 0
    from_merged = _split_merged_draft(full_text, source_format, sections)

    by_section = []
    section_bodies: dict[str, str] = {}
    body_sources: dict[str, str] = {}
    missing_sections: list[str] = []
    for sec in sections:
        sid = sec["section_id"]
        draft_path = ws.section_drafts_dir / f"{sid}.json"
        if sid in from_merged:
            body = from_merged[sid]
            source = merged_label
        elif draft_path.exists():
            body = (load_json(draft_path) or {}).get("body_md") or ""
            source = "section_drafts"
        else:
            missing_sections.append(sid)
            continue
        section_bodies[sid] = body
        body_sources[sid] = source
        wc = _latex_effective_word_count(body)
        cite_count = sum(len(raw.split(",")) for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", body))
        by_section.append({"section_id": sid, "title": sec["title"], "kind": sec["kind"],
                           "word_count": wc, "citations": cite_count, "source": source,
                           "counted_in_balance": sec["kind"] not in _NON_BODY_KINDS})

    if not by_section:
        write_status(ws, "phase06_quality_check", "FAILED",
                     duration_sec=round(time.time() - started, 2),
                     message="No section bodies found.")
        return 2

    # Coverage. Every metric below is computed from `section_bodies`, so a
    # metric derived from three of seven sections is a statement about three of
    # seven sections and must not be reported as a verdict on the survey.
    coverage_ratio = len(by_section) / len(sections) if sections else 0.0
    if coverage_ratio < 0.5:
        write_status(
            ws, "phase06_quality_check", "FAILED",
            duration_sec=round(time.time() - started, 2),
            message=(f"Only {len(by_section)} of {len(sections)} sections could be scored "
                     f"(missing: {', '.join(missing_sections)}); the quality report would "
                     f"describe a minority of the document."),
        )
        return 2

    # Balance over BODY sections only. An abstract is a fifth the length of a
    # body section by design, so including it measures the template.
    word_counts = [s["word_count"] for s in by_section
                   if s["counted_in_balance"] and s["word_count"] > 0]
    if len(word_counts) < 2:
        # Nothing to compare — report the neutral ratio rather than 0.0, which
        # would read as a perfect score on a document that was never measured.
        balance_ratio = 1.0
    else:
        balance_ratio = max(word_counts) / min(word_counts)
    min_wc = min(word_counts) if word_counts else 0
    max_wc = max(word_counts) if word_counts else 0

    full_body_text = "\n\n".join(section_bodies.values())

    ai_density, ai_hits = _density(full_body_text, ai_patterns)
    weasel_density, weasel_hits = _density(full_body_text, weasel_patterns)
    bullet_ratio = _bullet_ratio(full_body_text)

    # Citation totals — scanned from per-section LaTeX bodies plus the
    # tables/*.tex and figures/*.tex asset files, so cite keys used only inside
    # a table or figure caption are counted too. Matches the cite-key set that
    # phase05b_insert_assets.py collects for citations.bib.
    all_keys = []
    for body in section_bodies.values():
        for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", body):
            all_keys.extend(k.strip() for k in raw.split(",") if k.strip())
    for asset_dir in (ws.tables_dir, ws.figures_dir):
        if not asset_dir.exists():
            continue
        for tex_file in sorted(asset_dir.glob("*.tex")):
            asset_text = tex_file.read_text(encoding="utf-8", errors="replace")
            for raw in re.findall(r"\\cite[tp]?\{([^}]+)\}", asset_text):
                all_keys.extend(k.strip() for k in raw.split(",") if k.strip())
    unique_keys = set(all_keys)

    # Recency
    this_year = datetime.now().year
    recent_keys = 0
    year_dist = Counter()
    for ck in unique_keys:
        pid = pid_by_key.get(ck)
        year = (selected_papers.get(pid, {}) or {}).get("year")
        if isinstance(year, int):
            year_dist[str(year)] += 1
            if this_year - year <= 3:
                recent_keys += 1
    recent_ratio = (recent_keys / len(unique_keys)) if unique_keys else 0.0

    # Claims recorded. REPORTED, NOT SCORED.
    #
    # This was `claim_grounded`, a scored metric: the fraction of claims
    # carrying at least one `supporting_quotes[]` entry, against a floor of
    # 0.70 / 0.85. The quote layer was removed — nothing in this deployment can
    # display a citation → quote → evidence chain, so every quote was written,
    # validated and stored for a reader that does not exist, at a measurable
    # cost in drafting-agent attention.
    #
    # It is not re-derived from `cite_keys` instead, which would be the obvious
    # move. `validate_drafts` drops any claim whose cite keys all fall outside
    # the section whitelist, so by the time this runs every surviving claim has
    # a key by construction and the ratio is 1.0 whatever the drafts say. A
    # metric that cannot fail is worse than an absent one: it reads as evidence.
    #
    # So the count is reported and the verdict does not move. The real
    # claim-level check is `scripts/verify/fast_audit`, which pairs each
    # claim's text against its cited papers' abstracts and never read the
    # quotes.
    claim_total = 0
    claim_with_keys = 0
    for sid in section_bodies:
        path = ws.section_drafts_dir / f"{sid}.json"
        if not path.exists():
            continue
        data = load_json(path)
        for c in data.get("claims") or []:
            claim_total += 1
            if c.get("cite_keys"):
                claim_with_keys += 1

    fatal_violations = 0
    warning_violations = 0
    statuses = {}

    def status_for(key: str, value: float, kind: str) -> str:
        nonlocal fatal_violations, warning_violations
        threshold = thresholds[key]
        ok = (value <= threshold) if kind == "max" else (value >= threshold)
        if ok:
            return "PASS"
        if key in ("citation_count_min", "section_balance_ratio_max"):
            warning_violations += 1
            return "WARNING"
        warning_violations += 1
        return "WARNING"

    # Coverage is not a threshold comparison — it is a statement about how much
    # of the document every other metric was computed from. A partially scored
    # report must not read as a clean one.
    if missing_sections:
        statuses["section_coverage"] = "WARNING"
        warning_violations += 1
    else:
        statuses["section_coverage"] = "PASS"

    statuses["section_balance"] = status_for("section_balance_ratio_max", balance_ratio, "max")
    statuses["ai_boilerplate"] = status_for("ai_boilerplate_density_max", ai_density, "max")
    statuses["bullet_ratio"] = status_for("bullet_ratio_max", bullet_ratio, "max")
    statuses["weasel_words"] = status_for("weasel_word_density_max", weasel_density, "max")
    statuses["citation_density"] = status_for("citation_count_min", len(all_keys), "min")
    statuses["citation_recency"] = status_for("recent_3y_citation_ratio_min", recent_ratio, "min")

    verdict = "PASS" if all(s == "PASS" for s in statuses.values()) else (
        "PASS_WITH_WARNINGS" if fatal_violations == 0 else "FAIL"
    )

    report = {
        "task_id": outline.get("task_id"),
        "topic": outline.get("topic"),
        "generated_at": now_iso(),
        "schema_version": "1.0",
        "scope": args.scope,
        "language": language,
        "source_format": source_format,
        "source_path": str(merged_path),
        "overall": {
            "verdict": verdict,
            "fatal_violations": fatal_violations,
            "warning_violations": warning_violations,
            "rewrite_triggered": False,
        },
        "thresholds": thresholds,
        "metrics": {
            "section_coverage": {
                "sections_expected": len(sections),
                "sections_scored": len(by_section),
                "missing_section_ids": missing_sections,
                "ratio": round(coverage_ratio, 4),
                "scored_from": sorted(set(body_sources.values())),
                "status": statuses["section_coverage"],
                "note": ("every other metric in this report is computed from the "
                         f"{len(by_section)} section(s) listed under section_balance.by_section"),
            },
            # The one authoritative length for this document, in both units it
            # is ever quoted in. Report these numbers; do not re-count the file,
            # because a raw character count and an effective-word count differ
            # by 1.6× and one run has quoted a budget verdict from each.
            "document_length": {
                "effective_words": _effective_word_count(full_body_text),
                "cjk_characters": sum(1 for ch in full_body_text if _is_cjk_char(ch)),
                "unit_note": ("effective_words counts English tokens plus CJK characters / 1.6; "
                              "cjk_characters is reported separately. Explicit budgets keep "
                              "their user-requested unit; no default budget is inferred."),
                "requested": explicit_length_budget(ws.root, language),
            },
            "section_balance": {
                "min_word_count": min_wc, "max_word_count": max_wc,
                "ratio": round(balance_ratio, 2), "status": statuses["section_balance"],
                "by_section": by_section,
            },
            "ai_boilerplate": {
                "density": round(ai_density, 4), "status": statuses["ai_boilerplate"],
                "matched_phrases": ai_hits,
            },
            "bullet_ratio": {"ratio": round(bullet_ratio, 4), "status": statuses["bullet_ratio"]},
            "weasel_words": {"density": round(weasel_density, 4), "status": statuses["weasel_words"], "hits": weasel_hits},
            "citation_density": {
                "total_citations": len(all_keys),
                "unique_cite_keys": len(unique_keys),
                "status": statuses["citation_density"],
            },
            "citation_recency": {
                "recent_3y_count": recent_keys,
                "recent_3y_ratio": round(recent_ratio, 4),
                "year_distribution": dict(sorted(year_dist.items())),
                "status": statuses["citation_recency"],
            },
            "claims_recorded": {
                "total_claims": claim_total,
                "claims_with_cite_keys": claim_with_keys,
                "status": "REPORTED",
                "note": "informational — see the comment beside the count. "
                        "Claim-level checking lives in 07_verifier/fast_audit, "
                        "which pairs each claim against its cited abstracts",
            },
        },
    }

    write_json(ws.quality_report_path, report)

    final = "SUCCESS" if verdict == "PASS" else "PARTIAL_SUCCESS"
    write_status(ws, "phase06_quality_check", final,
                 duration_sec=round(time.time() - started, 2),
                 verdict=verdict,
                 language=language,
                 output_format=spec["format"],
                 source=str(merged_path),
                 sections_scored=f"{len(by_section)}/{len(sections)}",
                 scored_from=sorted(set(body_sources.values())),
                 effective_words=_effective_word_count(full_body_text),
                 fatal_violations=fatal_violations,
                 warning_violations=warning_violations,
                 statuses=statuses)
    return 0


if __name__ == "__main__":
    sys.exit(main())
