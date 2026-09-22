"""Compatibility worklist builder for the explicit section-writing interface.

Current scripted chapter generation uses chapter_plan and chapter_pipeline packets;
no section-writer subagent or separate table author is dispatched."""
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
import sys
import time
from collections.abc import Callable
from pathlib import Path

pass
from writing_contract import load_outline, read_request, digest, preparation_identity, explicit_length_budget
from _utils import (  # noqa: E402
    Workspace,
    format_paper_card,
    format_paper_card_nested,
    load_json,
    log_script_start,
    read_query_meta,
    section_label,
    write_json,
    write_status,
)


# Per-kind title/description keywords, bilingual (English + Chinese). Chinese
# has no word boundaries, so substring matching is the natural fit; we prefer
# multi-character Chinese phrases over bare two-character words (基础 / 定义 /
# 评估 / 挑战) to avoid matching inside genuine technique titles such as
# "大模型技术基础" or "不确定性评估方法".
_KIND_KEYWORDS = {
    "abstract":      ("abstract", "摘要"),
    "introduction":  ("introduction", "引言", "绪论", "导论", "导言"),
    "background":    ("background", "preliminaries", "foundations", "definition",
                      "scope", "背景", "预备知识", "基础知识", "相关概念",
                      "基本概念", "问题定义", "问题描述", "术语"),
    "conclusion":    ("conclusion", "conclusions", "concluding", "summary",
                      "结论", "总结", "结语", "结束语"),
}


# Parent-section titles that force `narrative` for ALL their leaves: their job
# is discursive framing (papers cited as evidence) rather than per-paper
# technique unrolling or the rigid intro template. Mirrors the English
# intro / background / conclusion meta-sections in Chinese for parity.
_NARRATIVE_PARENT_HINTS = (
    "introduction", "引言", "绪论", "导论", "导言",
    "background", "preliminaries", "背景", "预备知识",
    "conclusion", "concluding", "结论", "总结", "结语", "结束语",
)


# Parent-section titles whose leaves stay `narrative` even when they carry
# papers. These fire while paper_ids is non-empty, so a false hit downgrades a
# real technique section — keep the Chinese terms specific (avoid bare 评估/挑战).
_EVAL_PARENT_HINTS = ("evaluation", "benchmark", "评测", "基准", "数据集")
_FUTURE_PARENT_HINTS = (
    "future", "challenge", "open problem",
    "未来工作", "研究展望", "未来方向", "发展趋势",
    "开放问题", "研究挑战", "局限性",
)


def _match(text: str, keywords) -> bool:
    """Substring match — works for both English words and Chinese phrases."""
    return any(k in text for k in keywords)


def classify_l1(section: dict) -> str:
    """The writing style for a whole L1 section.

    `classify_section` cannot answer this: it falls through to `empty` whenever
    `paper_ids` is absent, and by the outline contract an L1 section never
    carries papers -- they hang off its subsections. Asking it about an L1 would
    incorrectly classify every body section as empty.
    """
    title = (section.get("title") or "").strip().lower()
    desc = (section.get("description") or "").strip().lower()
    subs = section.get("subsections") or []

    if str(section.get("section_id") or "").strip() == "0":
        return "abstract"
    if _match(title, _KIND_KEYWORDS["abstract"]):
        return "abstract"
    if _match(title, _KIND_KEYWORDS["introduction"]):
        return "introduction"
    if _match(title, _KIND_KEYWORDS["conclusion"]):
        return "conclusion"
    for kind, hints in _KIND_KEYWORDS.items():
        if _match(title, hints) or (kind == "background" and _match(desc, hints)):
            return kind
    if _match(title, _EVAL_PARENT_HINTS) or _match(title, _FUTURE_PARENT_HINTS):
        return "narrative"
    # A body section is `technique` when anything under it carries papers, and
    # `empty` only when nothing does -- which is a framing section.
    if any(sub.get("paper_ids") for sub in subs) or section.get("paper_ids"):
        return "technique"
    return "empty"


def classify_section(leaf: dict, parent: dict | None) -> str:
    """Light heuristic that picks a writing style for the agent."""
    title = (leaf.get("title") or "").strip().lower()
    desc = (leaf.get("description") or "").strip().lower()
    parent_title = ((parent or {}).get("title") or "").strip().lower()
    # Children of an Introduction / Background / Conclusion meta-section are
    # always narrative regardless of paper_ids: their job is discursive
    # framing with papers cited as evidence, not per-paper technique unrolling
    # or the rigid 5-paragraph intro template.
    if parent_title and _match(parent_title, _NARRATIVE_PARENT_HINTS):
        return "narrative"
    # Abstract / Introduction / Conclusion are decided by the leaf's OWN title
    # regardless of whether it carries papers. These styles are discursive /
    # summarizing, so a paper-bearing intro leaf must NOT fall through to the
    # `technique` default below — it would otherwise get a per-paper-unrolling
    # prompt instead of a synthesis-oriented introduction.
    if _match(title, _KIND_KEYWORDS["abstract"]):
        return "abstract"
    if str(leaf.get("section_id") or "").strip() == "0":
        return "abstract"
    if _match(title, _KIND_KEYWORDS["introduction"]):
        return "introduction"
    if _match(title, _KIND_KEYWORDS["conclusion"]):
        return "conclusion"
    if not leaf.get("paper_ids"):
        for kind, hints in _KIND_KEYWORDS.items():
            if _match(title, hints) or (kind == "background" and _match(desc, hints)):
                return kind
        return "empty"
    if _match(parent_title, _EVAL_PARENT_HINTS):
        return "narrative"
    if _match(parent_title, _FUTURE_PARENT_HINTS):
        return "narrative"
    return "technique"


# User-facing synthesis definition shared by every execution profile.
_INSIGHT_DEFINITION = (
    "insight (洞察) refers to deep understanding or non-obvious findings about the "
    "research problem / phenomenon itself — synthesising patterns, gaps, or causal "
    "explanations across multiple papers — rather than a surface observation or "
    "restatement of any single paper's result."
)

_INSIGHT_DEFINITION_ZH = (
    "洞察 (insight) 指对研究问题或现象本身的深度理解或非显而易见的发现——"
    "在多篇论文之间归纳模式、识别空白、给出因果性解释——"
    "而非对任一篇论文结果的表面陈述或简单复述。"
)


def _insight_contract(scope: str, language: str) -> tuple[str, str]:
    """Return one synthesis contract for every execution profile.

    `scope` remains an orchestration/cost signal elsewhere in the pipeline. It
    must not turn a survey into a citation-bearing list of paper summaries.
    Keep it in the signature so callers make that separation explicit.
    """
    del scope
    definition = _INSIGHT_DEFINITION_ZH if language == "chinese" else _INSIGHT_DEFINITION
    return "required", definition


def _collect_planned_assets(
    outline: dict,
    table_papers: Callable[[list], list[dict]],
) -> tuple[dict[str, list[dict]], dict[str, list[dict]]]:
    """Map leaf section_id -> planned figure/table specs the drafter must reference.

    Label convention mirrors what phase 4 figure/table generators emit and what
    phase 5B asset-injection wires up:
      - figures: ``\\label{fig:<figure_id>}``  → reference as ``Figure~\\ref{fig:F1}``
      - tables : ``\\label{tab:<table_id>}``   → reference as ``Table~\\ref{tab:T1}``

    Binding rule (decoupled from where assets physically land in v3):
      - A subsection's own figures/tables bind to that subsection.
      - A parent section's figures/tables bind to its FIRST subsection so taxonomy /
        comparison assets are introduced upfront with a forward ``\\ref``. (Asset
        injection still puts the figure/table block at the END of the parent, but
        LaTeX ``\\ref`` is order-independent.)
      - If a section has no subsections, its assets bind to itself.
    """

    def _fig_spec(f: dict) -> dict | None:
        fid = f.get("figure_id") or f.get("id") or ""
        if not fid:
            return None
        # Everything the architect wrote about this figure travels with it. The
        # writer does not draw it, but it writes the sentence that introduces
        # it, and "as Figure 2 shows" is only writable by someone who knows
        # what Figure 2 shows. A caption and a type string were not enough.
        spec = {k: v for k, v in f.items()
                if k not in ("figure_id", "paper_ids") and v not in (None, "", [], {})}
        spec.update({
            "figure_id": fid,
            "label": f"fig:{fid}",
            "caption": f.get("caption_draft", ""),
        })
        return spec

    def _tab_spec(t: dict) -> dict | None:
        # Unlike a figure, a planned table is not just something the prose has
        # to reference — the section writer BUILDS it. So the spec carries the
        # rows: which papers belong in the table, and their full cards.
        #
        # It used to carry id/label/caption only. That left the writer holding
        # a label it was required to `\ref{}` and no material to build the
        # table from, while a separate `legacy table author` built the same
        # table from the same outline node — and one run shipped both, sharing
        # one `\label`, two floats apart in the PDF.
        tid = t.get("table_id") or t.get("id") or ""
        if not tid:
            return None
        paper_ids = [pid for pid in (t.get("paper_ids") or []) if pid]
        return {
            "table_id": tid,
            "label": f"tab:{tid}",
            "caption": t.get("caption_draft", ""),
            "paper_ids": paper_ids,
            "papers": table_papers(paper_ids),
        }

    planned_figs: dict[str, list[dict]] = {}
    planned_tabs: dict[str, list[dict]] = {}

    for sec in outline.get("outline_tree", []):
        sid = sec.get("section_id") or ""
        subs = sec.get("subsections") or []

        # 1) Subsection-owned assets bind to that subsection.
        for sub in subs:
            sub_sid = sub.get("section_id") or ""
            if not sub_sid:
                continue
            for f in sub.get("figures") or []:
                spec = _fig_spec(f)
                if spec:
                    planned_figs.setdefault(sub_sid, []).append(spec)
            for t in sub.get("tables") or []:
                spec = _tab_spec(t)
                if spec:
                    planned_tabs.setdefault(sub_sid, []).append(spec)

        # 2) Parent-owned assets bind to the FIRST subsection (or to this section
        #    itself when it has no subsections).
        anchor_sid = (subs[0].get("section_id") if subs else sid) or ""
        if not anchor_sid:
            continue
        for f in sec.get("figures") or []:
            spec = _fig_spec(f)
            if spec:
                planned_figs.setdefault(anchor_sid, []).append(spec)
        for t in sec.get("tables") or []:
            spec = _tab_spec(t)
            if spec:
                planned_tabs.setdefault(anchor_sid, []).append(spec)

    return planned_figs, planned_tabs


def _build_survey_skeleton(outline: dict) -> list[dict]:
    """Compact titles and optional short-purpose tree of the whole survey.

    Citation-free leaves (abstract / conclusion) carry no allowed_papers and
    otherwise see only their own title/description; the drafter renders this
    skeleton for those kinds so they can name the taxonomy / distinctive
    contributions instead of guessing from topic_precise alone.
    """
    skeleton: list[dict] = []
    for sec in outline.get("outline_tree", []):
        skeleton.append({
            "section_id": sec.get("section_id", ""),
            "title": sec.get("title", ""),
            "purpose": (sec.get("summary") or "").strip(),
            "subsections": [
                {
                    "section_id": sub.get("section_id", ""),
                    "title": sub.get("title", ""),

                }
                for sub in (sec.get("subsections") or [])
            ],
        })
    return skeleton


def _build_evidence_overview(ws: Workspace) -> dict:
    """Compact, factual review-protocol context shared with isolated writers."""
    corpus_path = ws.process / "corpus_summary.json"
    retrieval_path = ws.retrieval / "retrieval_report.json"
    corpus = load_json(corpus_path) if corpus_path.exists() else {}
    retrieval = load_json(retrieval_path) if retrieval_path.exists() else {}
    search = retrieval.get("search_summary") or {}

    return {
        "corpus_size": corpus.get("total_papers", retrieval.get("output_count")),
        "fulltext_coverage": corpus.get("fulltext_coverage"),
        "year_distribution": corpus.get("by_year") or retrieval.get("year_histogram") or {},
        "paper_type_distribution": corpus.get("by_paper_type") or {},
        "search": {
            "literature_search_intent": search.get("query"),
            "rounds": search.get("total_rounds"),
            "queries": search.get("total_queries"),
            "candidate_pool_size": search.get("pool_size"),
            "selected_count": search.get("selected_count", retrieval.get("output_count")),
            "subtopics": search.get("subtopics") or [],
            "coverage_assessment": search.get("coverage_assessment"),
        },
        "screens_applied": retrieval.get("screens_applied") or [],
        "degradations": retrieval.get("degradations") or [],
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.parse_args()

    started = time.time()
    ws = Workspace()
    log_script_start(ws, "collect_drafting_worklist")

    if not ws.cite_keys_path().exists() or not (ws.internal_dir / "leaf_index.json").exists():
        write_status(
            ws, "collect_drafting_worklist", "FAILED",
            duration_sec=round(time.time() - started, 2),
            message="cite_keys.json or leaf_index.json missing — run phase00_bootstrap first.",
        )
        return 2

    selected_papers = load_json(ws.selected_papers_path)
    paper_cards = load_json(ws.paper_cards_path)
    outline = load_outline(ws.root)
    writing_request = read_request(ws.input.parent)
    cite_keys = load_json(ws.cite_keys_path())
    leaf_index = load_json(ws.internal_dir / "leaf_index.json")

    # Resolve query meta (scope / language / topic / task_id). Prefer the
    # cached file from phase 0 bootstrap; fall back to a fresh parse for
    # direct re-runs. We read into `query_meta` (not `meta`) because the
    # inner per-paper loop below uses `meta` for `selected_papers[pid]`.
    if ws.query_meta_path().exists():
        query_meta = load_json(ws.query_meta_path())
    else:
        query = __import__("task_contract").read_query(ws.input.parent)
        query_meta = read_query_meta(query, outline)
    scope = query_meta.get("scope", "speed")
    language = query_meta.get("language", "english")

    # Length belongs to the whole requested output. Never turn paper count,
    # section kind, or a default scale into paragraph/section quotas.
    length_unit = "cjk_chars" if language == "chinese" else "words"
    length_rule = ("No default length constraint. Cover the evidence at the depth "
                   "needed by the user's request. Any explicit document budget "
                   "applies to the whole output, never to each section.")
    insight_requirement, insight_definition = _insight_contract(scope, language)

    parent_by_sid = {s["section_id"]: s for s in outline.get("outline_tree", [])}
    leaf_by_sid = {leaf["section_id"]: leaf for leaf in leaf_index}
    def table_papers(paper_ids) -> list[dict]:
        """Resolve a planned table's paper_ids into FULL cards.

        Deliberately not the `drafting` depth used for `allowed_papers`. That
        view selects the fields useful for prose while preserving their values
        in full; a table may need card fields outside that prose selection.

        A table's `paper_ids` are a small subset the
        outline architect chose (eight on a forty-paper corpus), so the full
        card is affordable. This is the same projection `collect_table_specs.py`
        builds for the standalone table builder.
        """
        rows = []
        for pid in paper_ids or []:
            ck = cite_keys.get(pid)
            if not ck:
                raise ValueError(f"paper_id {pid!r} has no citation key; repair the outline before drafting")
            rows.append({"cite_key": ck, "paperId": pid,
                         **format_paper_card(paper_cards.get(pid),
                                             selected_papers.get(pid, {}))})
        return rows

    planned_figs, planned_tabs = _collect_planned_assets(outline, table_papers)

    # Re-derive parent dict per leaf
    leaf_to_parent: dict[str, dict | None] = {}
    for sec in outline.get("outline_tree", []):
        for sub in sec.get("subsections") or []:
            leaf_to_parent[sub["section_id"]] = sec
        if not sec.get("subsections"):
            leaf_to_parent[sec["section_id"]] = None

    def papers_for(paper_ids) -> list[dict]:
        """Resolve outline paper_ids into the drafter's card summaries."""
        out = []
        for pid in paper_ids or []:
            ck = cite_keys.get(pid)
            if not ck:
                raise ValueError(f"paper_id {pid!r} has no citation key; repair the outline before drafting")
            # `drafting` depth: the section-writing field whitelist, with every
            # selected value intact. Per-section item files keep the evidence
            # local even when a top-level section owns many papers.
            summary = format_paper_card_nested(paper_cards.get(pid),
                                               selected_papers.get(pid, {}),
                                               depth="drafting", scope=scope)
            out.append({"cite_key": ck, "paperId": pid, **summary})
        return out

    # ------------------------------------------------------------------------
    # One item per L1 SECTION, not per leaf subsection.
    #
    # Subsections of one section are the likeliest place for two drafts to
    # collide: they share a paper pool and a topic, so drafted apart they
    # introduce the same concept twice under different names and neither
    # acknowledges the other. `legacy refiner` exists to sand those seams down
    # afterwards; drafting the section whole means the worst of them never form.
    #
    # It also aligns two rules that used to disagree. `min_papers_per_section`
    # is defined over an L1 section's DISTINCT papers -- union, not sum -- which
    # is how `validate_outline.py` checks the plan. Judging drafts per leaf
    # measured something else and could fail a section whose union was fine.
    #
    # The subsection plan travels inside the item. The writer emits the
    # subsection headings itself and may rebalance papers across them, so the
    # outline's per-subsection allocation is guidance here rather than a
    # boundary; the whitelist that binds is the union below.
    # ------------------------------------------------------------------------
    leaves_by_parent: dict[str, list[dict]] = {}
    for leaf in leaf_index:
        parent = leaf_to_parent.get(leaf["section_id"])
        key = (parent or {}).get("section_id") or leaf["section_id"]
        leaves_by_parent.setdefault(key, []).append(leaf)

    work: list[dict] = []
    for sec in outline.get("outline_tree", []):
        sid = sec.get("section_id") or ""
        leaves = leaves_by_parent.get(sid) or []
        if not leaves:
            continue

        # A section with no subsections is its own leaf: one flat body, and the
        # subsection plan stays empty so nothing downstream expects headings.
        flat = len(leaves) == 1 and leaves[0]["section_id"] == sid

        subsections: list[dict] = []
        if not flat:
            for leaf in leaves:
                sub_sid = leaf["section_id"]
                sub_kind = classify_section(leaf, sec)
                subsections.append({
                    "section_id": sub_sid,
                    "title": leaf.get("title", ""),
                    "description": leaf.get("description", ""),
                    "label": section_label(sub_sid),
                    "section_kind": sub_kind,
                    # What the outline allocated here. Guidance, not a boundary.
                    "suggested_cite_keys": [a["cite_key"]
                                            for a in papers_for(leaf.get("paper_ids"))],
                    "planned_figures": planned_figs.get(sub_sid, []),
                    "planned_tables": [{k: v for k, v in t.items() if k != "papers"}
                                       for t in planned_tabs.get(sub_sid, [])],
                })

        # The union, in first-appearance order, deduplicated: one paper placed
        # in two subsections is one entry, and the card is not repeated.
        allowed, seen = [], set()
        for leaf in leaves:
            for paper in papers_for(leaf.get("paper_ids")):
                if paper["cite_key"] in seen:
                    continue
                seen.add(paper["cite_key"])
                allowed.append(paper)

        section_tables = [table for leaf in leaves
                          for table in planned_tabs.get(leaf["section_id"], [])]
        # A table's evidence belongs to its owning section too. The row-level
        # table whitelist remains narrower, while prose/claims may discuss any
        # evidence actually supplied to this section's writer.
        for table in section_tables:
            for paper in papers_for([p["paperId"] for p in table.get("papers", [])]):
                if paper["cite_key"] not in seen:
                    seen.add(paper["cite_key"])
                    allowed.append(paper)

        kind = classify_section(leaves[0], leaf_to_parent.get(sid)) if flat else classify_l1(sec)
        if not allowed and kind == "conclusion":
            # Conclusions synthesise the corpus, even when they have no subsections.
            allowed = papers_for(list(cite_keys))
        if not allowed and kind not in ("abstract", "empty"):
            raise ValueError(f"section {sid} requires evidence but has no allowed papers")

        item = {
            "section_id": sid,
            "title": sec.get("title", ""),
            "description": sec.get("description", ""),
            "user_instructions": writing_request["section_instructions"].get(sid, ""),
            "label": section_label(sid),
            "section_kind": kind,
            "scope": scope,
            "language": language,
            # An L1 item has no parent by construction. The field stays so that
            # `_own_heading_level` and the other consumers keep their one shape.
            "parent_id": None,
            "parent_title": None,
            "parent_description": None,
            "prev_section_id": leaves[0].get("prev_section_id"),
            "next_section_id": leaves[-1].get("next_section_id"),
            "subsections": subsections,
            "allowed_papers": allowed,
            "allowed_cite_keys": [a["cite_key"] for a in allowed],
            "cite_key_table": [
                {"cite_key": a["cite_key"], "title": a.get("title", "")} for a in allowed
            ],
            "planned_figures": [f for leaf in leaves
                                for f in planned_figs.get(leaf["section_id"], [])],
            "planned_tables": section_tables,
            "insight_requirement": insight_requirement,
            "insight_definition": insight_definition,
            "existing_draft": (ws.section_drafts_dir / f"{sid}.json").exists(),
        }
        work.append(item)

    budget = explicit_length_budget(ws.root, language)

    survey_skeleton = _build_survey_skeleton(outline)
    evidence_overview = _build_evidence_overview(ws)
    write_json(ws.drafting_worklist_path(), {
        "task_id": query_meta.get("task_id"),
        "topic": query_meta.get("topic"),
        "topic_precise": query_meta.get("topic_precise"),
        "scope": scope,
        "language": language,
        "length_unit": length_unit,
        "length_rule": length_rule,
        "length_budget": budget,
        "survey_skeleton": survey_skeleton,
        "evidence_overview": evidence_overview,
        "items": work,
        "writing_contract_sha256": preparation_identity(ws.root),
    })

    # One file per item. The aggregate worklist reached 478 KB on a 48-paper
    # corpus because every item embeds its own papers' cards, and each of seven
    # writers paid to load the whole thing to reach its own slice — the largest
    # spent 4.6 of its 9.3 minutes on nothing else. A writer now reads one file
    # that contains only its own assignment.
    items_dir = ws.internal_dir / "drafting_items"
    items_dir.mkdir(parents=True, exist_ok=True)
    shared = {"task_id": query_meta.get("task_id"),
              "topic": query_meta.get("topic"),
              "topic_precise": query_meta.get("topic_precise"),
              "scope": scope, "language": language,
              "length_unit": length_unit, "length_rule": length_rule,
              "document_length_budget": budget,
              "survey_skeleton": survey_skeleton,
              "evidence_overview": evidence_overview,
              "user_instructions": writing_request["user_instructions"],
              "requirements": __import__("task_contract").read_request(ws.input.parent),
              "output_scope": writing_request["output_scope"]}
    # Written compact: the only reader is a section writer loading the whole
    # file, and indentation on a 21-paper item costs 12 KB it cannot use.
    for item in work:
        item["input_sha256"] = digest({**shared, "item": {k: v for k, v in item.items() if k != "existing_draft"}})
        write_json(items_dir / f"{item['section_id']}.json",
                   {**shared, "item": item}, indent=None)

    write_status(
        ws, "collect_drafting_worklist", "SUCCESS",
        duration_sec=round(time.time() - started, 2),
        scope=scope,
        language=language,
        items=len(work),
        already_drafted=sum(1 for w in work if w["existing_draft"]),
        length_unit=length_unit,
        length_budget=budget,
        worklist_path=str(ws.drafting_worklist_path()),
        items_dir=str(items_dir),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
