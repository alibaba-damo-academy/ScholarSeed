#!/usr/bin/env scholarseed-skill-python
"""Hydrate a model-authored selection and render validated final artifacts.

The agent chooses paper IDs/titles, tiers, reasons, and covered subtopics. This
tool deterministically restores full metadata from pool.json, validates the set,
and writes metadata.json plus report.md.
"""

import argparse
import json
import os
import re
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state as search_state  # noqa: E402


def _title_key(title):
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def _load_selection(path):
    with open(path, encoding="utf-8") as f:
        value = json.load(f)
    if isinstance(value, list):
        return {"papers": value}
    if not isinstance(value, dict) or not isinstance(value.get("papers"), list):
        raise ValueError("selection must be a paper list or an object with papers[]")
    return value


def _hydrate(selection_papers, pool):
    by_id = {
        str(paper.get("paper_id")): paper for paper in pool.values()
        if paper.get("paper_id") not in (None, "")
    }
    by_title = {_title_key(paper.get("title")): paper for paper in pool.values()}
    hydrated = []
    unmatched = []
    for choice in selection_papers:
        if not isinstance(choice, dict):
            raise ValueError("every selected paper must be an object")
        paper_id = str(choice.get("paper_id") or "")
        title_key = _title_key(choice.get("title", ""))
        base = by_id.get(paper_id) if paper_id else None
        if base is None and title_key:
            base = by_title.get(title_key)
        if base is None:
            # Web-only papers may legitimately be absent from the PaperHub pool.
            base = {}
            unmatched.append(choice.get("title") or paper_id or "<missing identifier>")
        item = dict(base)
        item.update({key: value for key, value in choice.items() if value is not None})
        item.pop("_relevance_score", None)
        item.pop("relevance_score", None)
        item.setdefault("authors", [])
        item.setdefault("abstract", "")
        item.setdefault("venue", "")
        item.setdefault("journal_name", "")
        item.setdefault("journal_pages", "")
        item.setdefault("journal_volume", "")
        item.setdefault("citation_count", 0)
        item.setdefault("doi", "")
        item.setdefault("arxiv_id", "")
        item.setdefault("source", "web_only" if not base else "paperhub")
        item.setdefault(
            "access", "open" if item.get("is_open_access") is True else "closed_or_unknown",
        )
        item.setdefault("reason", "")
        item.setdefault("subtopics_covered", [])
        hydrated.append(item)
    return hydrated, unmatched


def _exclusive_cutoff_year(query):
    # Year-only and "before January" constraints are safe to validate by year.
    match = re.search(
        r"\bbefore\s+(?:(?:jan(?:uary)?)\s+(?:1(?:st)?\s*,?\s*)?)?"
        r"((?:19|20|21)\d{2})\b",
        query, re.I,
    )
    return int(match.group(1)) if match else None


def _validate(papers, query):
    errors = []
    warnings = []
    keys = []
    for index, paper in enumerate(papers, 1):
        title = str(paper.get("title") or "").strip()
        if not title:
            errors.append(f"paper {index} has no title")
        else:
            keys.append(_title_key(title))
        if paper.get("tier") not in (1, 2, 3):
            errors.append(f"{title or 'paper ' + str(index)} has invalid tier")
        if not str(paper.get("reason") or "").strip():
            warnings.append(f"{title or 'paper ' + str(index)} has no selection reason")
    duplicates = [key for key, count in Counter(keys).items() if key and count > 1]
    if duplicates:
        errors.append(f"selection contains {len(duplicates)} duplicate normalized titles")

    tiers = Counter(paper.get("tier") for paper in papers)
    if not 30 <= len(papers) <= 40:
        warnings.append(f"selected count {len(papers)} is outside the recommended 30-40")
    if not 3 <= tiers[1] <= 5:
        warnings.append(f"Tier 1 count {tiers[1]} is outside the recommended 3-5")
    if not 10 <= tiers[2] <= 18:
        warnings.append(f"Tier 2 count {tiers[2]} is outside the recommended 10-18")
    if not 10 <= tiers[3] <= 20:
        warnings.append(f"Tier 3 count {tiers[3]} is outside the recommended 10-20")

    cutoff = _exclusive_cutoff_year(query)
    if cutoff:
        invalid = [
            paper.get("title", "") for paper in papers
            if isinstance(paper.get("year"), int) and paper["year"] >= cutoff
        ]
        if invalid:
            errors.append(
                f"{len(invalid)} selected papers violate the before-{cutoff} year cutoff: "
                + "; ".join(invalid[:5])
            )
    return errors, warnings, tiers


def _author_label(authors):
    if not authors:
        return "Unknown authors"
    if len(authors) == 1:
        return str(authors[0])
    return f"{authors[0]} et al."


def _render_report(metadata):
    summary = metadata["search_summary"]
    lines = [
        "# Literature Search Report", "", "## Search summary", "",
        f"Query: {summary.get('query', '')}", "",
        f"Search rounds: {summary.get('total_rounds', 0)}", "",
        f"Pool size: {summary.get('pool_size', 0)} papers → "
        f"{summary.get('selected_count', 0)} selected", "",
    ]
    labels = {1: "core papers", 2: "extension papers", 3: "recall layer"}
    for tier in (1, 2, 3):
        tier_papers = [paper for paper in metadata["papers"] if paper["tier"] == tier]
        lines.extend([f"## Tier {tier}: {labels[tier]} ({len(tier_papers)})", ""])
        for index, paper in enumerate(tier_papers, 1):
            year = paper.get("year") or "n.d."
            lines.extend([
                f"### {index}. {paper['title']} ({_author_label(paper.get('authors', []))}, {year})",
                "",
                f"- Source: {paper.get('venue') or paper.get('source') or 'unknown'} | "
                f"Citations: {paper.get('citation_count', 0)}",
                f"- Reason for selection: {paper.get('reason') or 'Not provided'}",
            ])
            subtopics = paper.get("subtopics_covered") or []
            if subtopics:
                lines.append(f"- Subtopics: {', '.join(str(item) for item in subtopics)}")
            lines.append("")
    lines.extend([
        "## Coverage assessment", "",
        summary.get("coverage_assessment") or "No coverage assessment provided.", "",
    ])
    closed = [
        paper for paper in metadata["papers"]
        if paper.get("access") not in ("open", "open_access")
    ]
    if closed:
        lines.extend(["## Closed or unknown access", ""])
        for paper in closed:
            identifier = paper.get("doi") or paper.get("url") or "no public identifier"
            lines.append(f"- {paper['title']} — {identifier}")
        lines.append("")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Hydrate and render final search results")
    parser.add_argument("--session", required=True, help="search session directory")
    parser.add_argument("--selection", required=True, help="model-authored selection JSON")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--json-only", action="store_true")
    parser.add_argument(
        "--strict-counts", action="store_true",
        help="treat tier/count recommendations as validation errors",
    )
    args = parser.parse_args()

    try:
        selection = _load_selection(args.selection)
        state = search_state.read_state(args.session)
        if state is None:
            raise ValueError("session is not initialized")
        pool = search_state.read_pool(args.session)
        papers, unmatched = _hydrate(selection["papers"], pool)
        supplied_summary = selection.get("search_summary", {})
        if not isinstance(supplied_summary, dict):
            raise ValueError("search_summary must be an object")
        query = str(supplied_summary.get("query") or state.get("query") or "")
        errors, warnings, tiers = _validate(papers, query)
        if unmatched:
            warnings.append(
                f"{len(unmatched)} selections were not in pool.json and were kept as web-only"
            )
        if args.strict_counts:
            count_warnings = [
                warning for warning in warnings
                if "outside the recommended" in warning
            ]
            errors.extend(count_warnings)
        if errors:
            json.dump({"errors": errors, "warnings": warnings}, sys.stdout, ensure_ascii=False, indent=2)
            print()
            return 1

        summary = {
            **supplied_summary,
            "query": query,
            "total_rounds": state.get("rounds_completed", 0),
            "total_queries": len(state.get("searched_queries", [])),
            "pool_size": len(pool),
            "selected_count": len(papers),
            "subtopics": supplied_summary.get("subtopics", state.get("subtopics", [])),
            "coverage_assessment": supplied_summary.get("coverage_assessment", ""),
        }
        metadata = {"search_summary": summary, "papers": papers}
        os.makedirs(args.output_dir, exist_ok=True)
        metadata_path = os.path.join(args.output_dir, "metadata.json")
        search_state._atomic_json_write(metadata_path, metadata)
        report_path = None
        if not args.json_only:
            report_path = os.path.join(args.output_dir, "report.md")
            with open(report_path, "w", encoding="utf-8") as f:
                f.write(_render_report(metadata))

        json.dump({
            "metadata": os.path.abspath(metadata_path),
            "report": os.path.abspath(report_path) if report_path else None,
            "selected_count": len(papers),
            "tier_counts": {str(tier): tiers[tier] for tier in (1, 2, 3)},
            "warnings": warnings,
        }, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        json.dump({"error": str(exc)}, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
