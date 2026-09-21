#!/usr/bin/env scholarseed-skill-python
"""
adapt_search_output.py — turn an agentic search result into the pipeline's corpus.

Why this exists
---------------
Retrieval is now two things with a hard seam between them. Finding the papers is
an open-ended agent job: it needs judgement, many rounds, and it burns an
enormous amount of context doing it, so it runs as the `slr-searcher` subagent
and its context never reaches the orchestrator. What comes back is
`02_retrieval/metadata.json` in the search skill's own format.

Everything downstream, though, was written against a specific corpus shape and
is entirely mechanical about it. Bridging the two in the subagent's prompt would
mean trusting a model to emit an exact schema at the end of a long, expensive
session -- the point where models are least reliable and a mistake is most
costly. So the bridge is this script instead: deterministic, cheap, re-runnable,
and the only place the contract is written down.

It also owns **screening**, for the same reason. Citation floors and venue
restrictions are applied here rather than inside the search agent, because a
filter applied during search is
invisible -- papers vanish and nobody can say which or why. Applied here, every
drop is a row in `retrieval_report.json` with the paper, the rule and the value
that failed it.

Publication windows are the exception: agentic-search may deliberately retain
older foundational papers, and SLR preserves them while reporting their count.

The corpus contract (verified against every consumer)
-----------------------------------------------------
`02_retrieval/selected_paper.json` is a JSON **object keyed by paper_id**, never
a list. `relevance_level` is the load-bearing field: `scripts/processing`
derives per-paper reading depth from it (L1 full text, L2 truncated, L3
abstract-only) and `scripts/outline_digest.py` quotas the corpus digest by it.
A paper without one silently defaults to L1 and drags a whole abstract-only
corpus through full-text processing.

Usage
-----
    scholarseed-skill-python scripts/retrieval/adapt_search_output.py <workspace> [--json]

Exit status: 0 when the corpus is usable (SUCCESS or PARTIAL_SUCCESS), 1 when it
is not.
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
# --- end slr path bootstrap ---

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

TIER_TO_LEVEL = {1: "L1", 2: "L2", 3: "L3"}
DEFAULT_CORPUS_TARGET = 40


from search_metadata_eligibility import abstract_problem, author_objects, year_of, problems as metadata_problems


# ------------------------------------------------------------------ helpers --

def _norm_title(title: str) -> str:
    """Fold a title to a comparison key: NFKD, lowercase, alphanumerics only."""
    folded = unicodedata.normalize("NFKD", title or "")
    return re.sub(r"[^a-z0-9]+", "", folded.lower())


def _synth_id(paper: dict, used: set[str]) -> str:
    """
    A stable id for a paper the search returned without one.

    Derived from the normalised title so a re-run produces the same id, and
    salted with an ordinal on collision so two untitled papers can never fold
    into each other -- silently merging two distinct papers is a much worse
    failure than carrying an ugly id.
    """
    basis = _norm_title(paper.get("title", "")) or json.dumps(paper, sort_keys=True)
    stem = "synth_" + hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]
    if stem not in used:
        return stem
    n = 2
    while f"{stem}_{n}" in used:
        n += 1
    return f"{stem}_{n}"


def _as_author_objects(authors) -> list[dict]:
    """
    Downstream reads `authors[i]["name"]`. A search backend may hand back bare
    strings; normalise rather than letting `_author_lastname` fall through to
    "Anon" and poison every cite key.
    """
    return author_objects(authors)


def _as_venue_object(venue):
    if isinstance(venue, dict):
        return venue if venue.get("name") else None
    if isinstance(venue, str) and venue.strip():
        return {"name": venue.strip()}
    return None


def _year_of(paper: dict):
    return year_of(paper)


def _citations_of(paper: dict):
    value = paper.get("citation_count")
    # AS's web fallback uses zero as an unavailable-value sentinel.
    if paper.get("source") == "web_only" and value == 0:
        return None
    if isinstance(value, int):
        return value
    return None


# ------------------------------------------------------------- requirements --

def load_requirements(workspace: Path) -> tuple[dict, list[str]]:
    from task_contract import read_request, constraints
    request = read_request(workspace)
    return {**request, 'constraints':constraints(request)}, []


def screens_from(reqs: dict) -> list[dict]:
    """Every constraints the intake stage compiled down to a corpus filter."""
    return [
        r for r in reqs.get("constraints", [])
        if (r.get("enforcement") or {}).get("mode") == "screen"
    ]


# ------------------------------------------------------------------ mapping --

def to_corpus_record(pid: str, paper: dict) -> dict:
    """Map one search result onto the corpus contract."""
    tier = paper.get("tier")
    tier = tier if isinstance(tier, int) and tier in TIER_TO_LEVEL else 3

    record = {
        "paperId": pid,
        "title": (paper.get("title") or "").strip(),
        "abstract": (paper.get("abstract") or "").strip(),
        "year": _year_of(paper),
        "authors": _as_author_objects(paper.get("authors")),
        "venue": _as_venue_object(paper.get("venue") or paper.get("journal_name")),
        "arxiv_id": paper.get("arxiv_id") or None,
        "doi": paper.get("doi") or None,
        "external_ids": dict(paper.get("external_ids") or {}),
        "citation_count": _citations_of(paper),
        "relevance_level": TIER_TO_LEVEL[tier],
        "tier": tier,
        "selection_reason": paper.get("reason") or "",
        "subtopics_covered": list(paper.get("subtopics_covered") or []),
        "source": paper.get("source") or "unknown",
    }
    provenance = paper.get("publication_date_source") or {}
    hub_id = paper.get("paperhub_id")
    if not hub_id and isinstance(provenance, dict) and provenance.get("provider") == "PaperHub":
        hub_id = provenance.get("record_id")
    if not hub_id and "paperhub" in str(paper.get("source", "")).lower():
        hub_id = paper.get("paper_id")
    if hub_id:
        record["paperhub_id"] = str(hub_id)

    # Keep the identifiers reachable under the spellings the bibtex synthesiser
    # looks for, without inventing any we were not given.
    if record["arxiv_id"] and not record["external_ids"].get("ArXiv"):
        record["external_ids"]["ArXiv"] = record["arxiv_id"]
    if record["doi"] and not record["external_ids"].get("DOI"):
        record["external_ids"]["DOI"] = record["doi"]

    # These two are pass-through-or-absent. An empty `citationStyles.bibtex`
    # would beat the synthesiser's fallback, so omit the key rather than
    # emitting a blank one.
    styles = paper.get("citationStyles") or {}
    if isinstance(styles, dict) and styles:
        record["citationStyles"] = dict(styles)
    if paper.get("bibtex_id"):
        record["bibtex_id"] = paper["bibtex_id"]

    # Optional bibliographic details remain pass-through-only.  PaperHub's
    # normalized search contract does not guarantee them, but when a backend
    # deployment supplies them they must survive into references.bib.
    for field in ("volume", "number", "pages", "publisher", "booktitle",
                  "journal", "url", "publication_date", "publication_types",
                  "reference_count", "influential_citation_count",
                  "is_open_access", "journal_name", "journal_pages",
                  "journal_volume", "found_by", "access", "landing_page_url", "pdf_url", "pdf_urls"):
        if paper.get(field) not in (None, "", []):
            record[field] = paper[field]

    # Current AS names journal fields explicitly; retain the source spellings
    # and expose aliases consumed by the existing bibliography pipeline.
    for source, target in (("journal_name", "journal"),
                           ("journal_pages", "pages"),
                           ("journal_volume", "volume")):
        if target not in record and paper.get(source) not in (None, ""):
            record[target] = paper[source]

    return record


# ---------------------------------------------------------------- screening --

def apply_screens(records: dict, reqs: dict) -> tuple[dict, list[dict], list[dict]]:
    """
    Returns (kept, dropped, flagged).

    A drop is a decision the user asked for and can be defended row by row. A
    flag is a suspicion this script is not entitled to act on alone.
    """
    normal = reqs.get("retrieval") or {}
    dropped: list[dict] = []
    flagged: list[dict] = []
    kept = dict(records)

    def drop(pid, rule, detail, req_id=None):
        record = kept.pop(pid, None)
        if record is not None:
            dropped.append({
                "paper_id": pid, "title": record["title"], "tier": record["tier"],
                "rule": rule, "detail": detail, "req_id": req_id,
            })

    unknown_year = sum(1 for r in kept.values() if r["year"] is None)

    # --- constraints screens ------------------------------------------------
    for req in screens_from(reqs):
        kind, value, rid = req.get("kind"), req.get("value"), req.get("id")

        if kind == "min_paper_citations" and isinstance(value, int):
            for pid, rec in list(kept.items()):
                count = rec["citation_count"]
                # Unknown citation count is not "zero citations". Flag, do not drop.
                if count is None:
                    flagged.append({
                        "paper_id": pid, "title": rec["title"], "req_id": rid,
                        "reason": f"citation count unknown, floor is {value}",
                    })
                elif count < value:
                    drop(pid, "min_paper_citations", f"{count} < {value}", rid)

        elif kind == "venue_whitelist" and isinstance(value, list) and value:
            wanted = [str(v).lower() for v in value if str(v).strip()]
            for pid, rec in list(kept.items()):
                name = ((rec.get("venue") or {}).get("name") or "").lower()
                if not name:
                    flagged.append({
                        "paper_id": pid, "title": rec["title"], "req_id": rid,
                        "reason": "venue unknown, cannot match the whitelist",
                    })
                elif not any(w in name for w in wanted):
                    drop(pid, "venue_whitelist", f"venue {name!r} not in whitelist", rid)

        # Semantic excluded_topic constraints are executed by the search agent,
        # not repeated here through keyword flags or another model call.

    return kept, dropped, flagged


def check_must_include(records: dict, reqs: dict) -> list[dict]:
    out = []
    have = {_norm_title(r["title"]) for r in records.values()}
    for req in reqs.get("constraints", []):
        if req.get("kind") != "must_include_paper":
            continue
        value = req.get("value") or {}
        title = value.get("title") if isinstance(value, dict) else str(value)
        key = _norm_title(title or "")
        # Substring both ways: the corpus title may carry a subtitle the user omitted.
        found = any(key and (key in h or h in key) for h in have)
        out.append({"req_id": req.get("id"), "title": title, "found": found})
    return out


def trim_to_size(records: dict, reqs: dict) -> tuple[dict, dict]:
    """
    Trim from the lowest tier upward. Tier 3 is the search skill's recall layer;
    it is the right thing to shed first and the wrong thing to shed silently.
    """
    sizing = (reqs.get("retrieval") or {}).get("corpus_size") or {}
    target = sizing.get("target") or DEFAULT_CORPUS_TARGET
    ceiling = sizing.get("max") or target
    if len(records) <= ceiling:
        return records, {}

    ordered = sorted(records.items(), key=lambda kv: (-kv[1]["tier"], kv[1]["title"]))
    trimmed = Counter()
    kept = dict(records)
    for pid, rec in ordered:
        if len(kept) <= ceiling:
            break
        del kept[pid]
        trimmed[str(rec["tier"])] += 1
    return kept, dict(trimmed)


# -------------------------------------------------------------------- main --

def run(workspace: Path) -> tuple[dict, dict, dict]:
    reqs, degradations = load_requirements(workspace)

    from local_papers import load_local,sizing as corpus_sizing,merge_local
    local=load_local(workspace);local_plan=corpus_sizing(len(local),reqs)
    meta_path = workspace / "02_retrieval" / "metadata.json"
    if not meta_path.is_file() and not local:
        return (
            {}, {},
            {"status": "FAILED", "task": "PAPER_RETRIEVAL",
             "status_reason": f"{meta_path} not found — the slr-searcher subagent "
                              "did not produce a search result"},
        )
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {"papers":[],"search_summary":{"source_mode":"local_only"}}
    except (json.JSONDecodeError, OSError) as exc:
        return ({}, {}, {"status": "FAILED", "task": "PAPER_RETRIEVAL",
                         "status_reason": f"metadata.json unreadable: {exc}"})

    if not isinstance(meta, dict):
        return ({}, {}, {"status": "FAILED", "task": "PAPER_RETRIEVAL",
                         "status_reason": "metadata.json must contain an object"})
    papers = meta.get("papers")
    if not isinstance(papers, list) or not papers and not local:
        return ({}, {}, {"status": "FAILED", "task": "PAPER_RETRIEVAL",
                         "status_reason": "metadata.json does not satisfy the current "
                                          "agentic-search contract: papers must be a non-empty list"})

    # Metadata is the stable dependency contract. AS now stores its trace in
    # session/ or fallback_event.json and no longer emits legacy provenance.
    retrieval = workspace / "02_retrieval"
    trace_names = ("search_provenance.json", "session/search_state.json",
                   "fallback_event.json", "as_run/session/search_state.json",
                   "as_run/fallback_event.json", "as_run/search_provenance.json")
    trace_files = [name for name in trace_names if (retrieval / name).is_file()]
    if not trace_files and papers:
        degradations.append("search trace unavailable; only metadata.json was supplied")
    summary = meta.get("search_summary") or {}
    if not isinstance(summary, dict):
        return ({}, {}, {"status": "FAILED", "task": "PAPER_RETRIEVAL",
                         "status_reason": "search_summary must be an object"})
    if summary.get("degraded") or summary.get("source_mode") == "web_only":
        degradations.append("agentic-search used degraded retrieval (source_mode="
                            + str(summary.get("source_mode", "unknown")) + ")")
    if summary.get("result_status") == "partial":
        degradations.append("agentic-search returned a partial result")
    limitations = summary.get("limitations") or []
    if isinstance(limitations, list):
        degradations.extend(str(item) for item in limitations)

    # --- map, deduplicating on normalised title -----------------------------
    records: dict[str, dict] = {}
    seen_titles: dict[str, str] = {}
    duplicates = 0
    abstract_drops = []
    metadata_drops = []
    metadata_rejections = []
    for paper in papers:
        if not isinstance(paper, dict):
            return ({}, {}, {"status": "FAILED", "task": "PAPER_RETRIEVAL",
                             "status_reason": "metadata.json papers[] must contain objects"})
        pid = str(paper.get("paper_id") or "").strip()
        if not pid or pid in records:
            pid = _synth_id(paper, set(records))
        problems=metadata_problems(paper)
        if problems:
            entry={'paper_id':pid,'title':paper.get('title',''),'tier':paper.get('tier',3),
                   'rule':problems[0]['rule'],'detail':'; '.join(p['detail'] for p in problems),
                   'issues':problems,'req_id':None}
            metadata_rejections.append(entry)
            if any(p['rule']=='usable_abstract' for p in problems):abstract_drops.append(entry)
            else:metadata_drops.append(entry)
            continue
        key = _norm_title(paper.get("title", ""))
        if key and key in seen_titles:
            duplicates += 1
            # Keep whichever the search skill ranked higher (lower tier number).
            incumbent = records[seen_titles[key]]
            if (paper.get("tier") or 3) < incumbent["tier"]:
                del records[seen_titles[key]]
                records[pid] = to_corpus_record(pid, paper)
                seen_titles[key] = pid
            continue
        records[pid] = to_corpus_record(pid, paper)
        if key:
            seen_titles[key] = pid

    input_count = len(papers)
    kept, dropped, flagged = apply_screens(records, reqs)
    dropped = metadata_rejections + dropped
    if local:
        local,kept,local_duplicates=merge_local(kept,local)
        _,local_drops,local_flags=apply_screens(local,reqs)
        flagged.extend(local_flags)
        flagged.extend({**entry,'reason':'User-supplied PDF retained despite screen: '+str(entry.get('reason',entry.get('rule','')))} for entry in local_drops)
        if local_plan['search_target']:
            kept,trimmed=trim_to_size(kept,{'retrieval':{'corpus_size':{'target':local_plan['search_target']}}})
        else:
            trimmed=dict(Counter(str(p['tier']) for p in kept.values()));kept={}
        supplement_count=len(kept);kept={**local,**kept}
    else:
        local_duplicates=[];kept,trimmed=trim_to_size(kept,reqs);supplement_count=len(kept)
    must_include = check_must_include(kept, reqs)

    # --- status -------------------------------------------------------------
    sizing = (reqs.get("retrieval") or {}).get("corpus_size") or {}
    floor = sizing.get("min")
    target = local_plan["combined_target"]
    reasons = list(degradations)
    if abstract_drops:
        reasons.append(f"excluded {len(abstract_drops)} search papers without a usable complete abstract; no abstract recovery was requested")
        degradations.append('search abstracts filtered')
    if local and supplement_count<local_plan["search_target"]:
        reasons.append(f"retrieved {supplement_count}/{local_plan['search_target']} supplemental papers after deduplication/screening; all {len(local)} local PDFs retained")
        degradations.append("supplemental search shortfall")

    if not kept:
        status = "FAILED"
        reasons.append("every paper was screened out; report the eligibility shortfall without inventing metadata or weakening required fields")
    else:
        status = "PARTIAL_SUCCESS" if degradations else "SUCCESS"
        if floor and len(kept) < floor:
            status = "PARTIAL_SUCCESS"
            reasons.append(f"corpus is {len(kept)} papers, below the requested minimum of {floor}")
        elif len(kept) < target * 0.6:
            status = "PARTIAL_SUCCESS"
            reasons.append(f"corpus is {len(kept)} papers against a target of {target}")
        missing = [m["title"] for m in must_include if not m["found"]]
        if missing:
            status = "PARTIAL_SUCCESS"
            reasons.append("must-include papers not found: " + "; ".join(missing))

    fulltext_candidates = sum(1 for r in kept.values() if r["arxiv_id"] or r.get("paperhub_id") or r.get("local_source"))
    if kept and fulltext_candidates == 0:
        status = "PARTIAL_SUCCESS" if status == "SUCCESS" else status
        reasons.append("no paper carries an arxiv_id — full-text acquisition will "
                       "use the configured full-text sources or trusted abstracts")

    missing_abstracts = sum(1 for r in kept.values() if not r["abstract"] and not r.get("local_source"))
    if missing_abstracts:
        status = "PARTIAL_SUCCESS" if status == "SUCCESS" else status
        reasons.append(f"{missing_abstracts} papers lack abstracts; acquire text before "
                       "using them as evidence for paper cards")

    citation_metadata = {
        "papers": len(kept),
        "upstream_bibtex": sum(
            1 for r in kept.values()
            if isinstance(r.get("citationStyles"), dict)
            and (r["citationStyles"].get("bibtex") or "").strip()
        ),
        "venue": sum(1 for r in kept.values() if r.get("venue")),
        "volume": sum(1 for r in kept.values() if r.get("volume")),
        "number": sum(1 for r in kept.values() if r.get("number")),
        "pages": sum(1 for r in kept.values() if r.get("pages")),
        "publisher": sum(1 for r in kept.values() if r.get("publisher")),
        "booktitle": sum(1 for r in kept.values() if r.get("booktitle")),
    }
    citation_metadata["venue_only"] = sum(
        1 for r in kept.values()
        if r.get("venue") and not any(r.get(f) for f in ("volume", "number", "pages"))
    )

    # Agentic Search deliberately retains selected foundational papers outside
    # the preferred survey window.  SLR keeps those selections intact and makes
    # the exception visible instead of silently screening them out.
    window = ((reqs.get("retrieval") or {}).get("time_range") or {})
    start, end = window.get("start_year"), window.get("end_year")
    outside_window = [
        {"paper_id": pid, "title": rec["title"], "year": rec["year"]}
        for pid, rec in kept.items()
        if rec["year"] is not None and (
            (start is not None and rec["year"] < start) or
            (end is not None and rec["year"] > end)
        )
    ]
    if outside_window:
        reasons.append(
            f"retained {len(outside_window)} upstream-selected foundational paper(s) "
            "outside the preferred time range"
        )

    report = {
        "metadata_filter":{"policy":"complete_abstract_authors_year",
                           "rejected_count":len(metadata_rejections),
                           "reason_counts":dict(Counter(p['rule'] for entry in metadata_rejections for p in entry['issues']))},
        "abstract_filter": {"policy":"require_usable_complete_search_abstract",
                            "rejected_count":len(abstract_drops),
                            "retained_remote_missing":missing_abstracts},
        "input_count": input_count+len(local),
        "local_count":len(local),"supplement_count":supplement_count,"corpus_plan":local_plan,
        "local_duplicates_merged":local_duplicates,
        "duplicates_merged": duplicates,
        "output_count": len(kept),
        "dropped": dropped,
        "flagged_for_review": flagged,
        "trimmed": trimmed,
        "must_include": must_include,
        "screens_applied": [
            {"req_id": r.get("id"), "kind": r.get("kind"),
             "compiles_to": (r.get("enforcement") or {}).get("compiles_to", "")}
            for r in screens_from(reqs) if r.get('kind')!='excluded_topic'
        ],
        "delegated_exclusions": [{"req_id":r.get('id'),"topic":r.get('value'),
                                  "owner":"search_subagent","rechecked_by_adapter":False}
                                 for r in reqs.get('constraints',[]) if r.get('kind')=='excluded_topic'],
        "tier_counts": dict(Counter(str(r["tier"]) for r in kept.values())),
        "year_histogram": dict(sorted(Counter(
            str(r["year"]) for r in kept.values() if r["year"]).items())),
        "outside_time_range_retained": {
            "count": len(outside_window),
            "papers": outside_window,
            "policy": "retain upstream-selected foundations",
        },
        "unknown_year": sum(1 for r in kept.values() if r["year"] is None),
        "fulltext_candidates": fulltext_candidates,
        "search_summary": meta.get("search_summary", {}),
        "search_trace_files": trace_files,
        "missing_abstracts": missing_abstracts,
        "citation_metadata": citation_metadata,
        "degradations": degradations,
    }
    status_obj = {
        "status": status, "task": "PAPER_RETRIEVAL",
        "status_reason": "; ".join(reasons),
    }
    return kept, report, status_obj


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace", nargs="?", default=".")
    ap.add_argument("--json", action="store_true",
                    help="print the full report rather than the status line")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    corpus, report, status = run(workspace)

    out_dir = workspace / "02_retrieval"
    out_dir.mkdir(parents=True, exist_ok=True)
    if corpus or report:
        (out_dir / "selected_paper.json").write_text(
            json.dumps(corpus, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "retrieval_report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    (out_dir / "pipeline_status.json").write_text(
        json.dumps(status, indent=2, ensure_ascii=False), encoding="utf-8")

    if args.json:
        print(json.dumps({**status, "report": report}, indent=2, ensure_ascii=False))
    elif not report:
        print(json.dumps(status, indent=2, ensure_ascii=False))
    else:
        summary = {
            **status,
            "papers": report["output_count"],
            "dropped": len(report["dropped"]),
            "flagged": len(report["flagged_for_review"]),
            "fulltext_candidates": report["fulltext_candidates"],
            "outside_time_range_retained": report["outside_time_range_retained"]["count"],
            "tier_counts": report["tier_counts"],
        }
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if status["status"] in ("SUCCESS", "PARTIAL_SUCCESS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
