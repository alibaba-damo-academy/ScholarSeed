#!/usr/bin/env scholarseed-skill-python
"""Validate public-web paper candidates and write degraded metadata.json.

The host agent discovers candidates through the installed web-search skill and passes
only paper records as JSON on stdin (or through ``--input``). This script never
performs network requests and never tries to obtain a PaperHub credential.
"""

import argparse
from datetime import datetime, timezone
import json
import os
import re
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import state as search_state  # noqa: E402


MODE_BUDGETS = {
    "quick": (20, [4, 9, 7]),
    "balanced": (40, [5, 15, 20]),
    "quality": (40, [5, 15, 20]),
}
ERROR_REASONS = {
    "PAPERHUB_AUTH_MISSING": "credential_unavailable",
    "PAPERHUB_HTTP_401": "authentication_failed",
    "PAPERHUB_HTTP_403": "authentication_failed",
    "PAPERHUB_TRANSPORT_ERROR": "unreachable",
    "PAPERHUB_HTTP_500": "service_unavailable",
    "PAPERHUB_HTTP_502": "service_unavailable",
    "PAPERHUB_HTTP_503": "service_unavailable",
    "PAPERHUB_HTTP_504": "service_unavailable",
}


def _text(value):
    return str(value or "").strip()


def _title_key(value):
    return "".join(char for char in _text(value).casefold() if char.isalnum())


def _clean_doi(value):
    doi = _text(value)
    doi = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", doi, flags=re.I)
    return re.sub(r"^doi:\s*", "", doi, flags=re.I).strip()


def _clean_arxiv(value):
    arxiv_id = _text(value)
    arxiv_id = re.sub(r"^https?://arxiv\.org/(?:abs|pdf)/", "", arxiv_id, flags=re.I)
    arxiv_id = re.sub(r"\.pdf$", "", arxiv_id, flags=re.I)
    return re.sub(r"^arxiv:\s*", "", arxiv_id, flags=re.I).strip()


def _valid_url(value):
    url = _text(value)
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else ""


def _year(value):
    if isinstance(value, int) and 1000 <= value <= 9999:
        return value
    match = re.search(r"(?<!\d)((?:19|20|21)\d{2})(?!\d)", _text(value))
    return int(match.group(1)) if match else None


def _strings(value):
    if isinstance(value, list):
        return [_text(item) for item in value if _text(item)]
    if isinstance(value, str) and value.strip():
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _normalize_paper(raw):
    if not isinstance(raw, dict):
        return None, "candidate is not an object"
    title = _text(raw.get("title"))
    doi = _clean_doi(raw.get("doi"))
    arxiv_id = _clean_arxiv(raw.get("arxiv_id"))
    url = _valid_url(raw.get("url"))
    if not url and doi:
        url = "https://doi.org/" + doi
    if not url and arxiv_id:
        url = "https://arxiv.org/abs/" + arxiv_id
    if not title:
        return None, "candidate has no title"
    if not (url or doi or arxiv_id):
        return None, "candidate has no verifiable URL, DOI, or arXiv ID"
    open_access = raw.get("is_open_access")
    if not isinstance(open_access, bool):
        open_access = None
    found_by = _strings(raw.get("found_by")) or ["web_search_skill"]
    paper = {
        "paper_id": "",
        "title": title,
        "authors": _strings(raw.get("authors")),
        "year": _year(raw.get("year") or raw.get("publication_date")),
        "venue": _text(raw.get("venue")),
        "journal_name": _text(raw.get("journal_name")),
        "journal_pages": _text(raw.get("journal_pages")),
        "journal_volume": _text(raw.get("journal_volume")),
        "abstract": _text(raw.get("abstract")),
        "citation_count": 0,
        "doi": doi,
        "arxiv_id": arxiv_id,
        "is_open_access": open_access,
        "url": url,
        "publication_date": _text(raw.get("publication_date")),
        "reference_count": 0,
        "influential_citation_count": 0,
        "publication_types": _strings(raw.get("publication_types")),
        "source": "web_only",
        "found_by": found_by,
        "access": "open" if open_access is True else "closed_or_unknown",
        "reason": _text(raw.get("reason")) or (
            "Relevant scholarly result found through public web search."
        ),
        "subtopics_covered": _strings(raw.get("subtopics_covered")),
    }
    return paper, None


def _exclusive_cutoff_year(query):
    match = re.search(
        r"\bbefore\s+(?:(?:jan(?:uary)?)\s+(?:1(?:st)?\s*,?\s*)?)?"
        r"((?:19|20|21)\d{2})\b",
        query,
        re.I,
    )
    return int(match.group(1)) if match else None


def _tier_budget(count, mode):
    _, original = MODE_BUDGETS[mode]
    if count == sum(original):
        return list(original)
    tier1 = min(count, max(1, round(count * original[0] / sum(original))))
    remaining = count - tier1
    tier2 = min(
        remaining,
        max(1 if remaining else 0, round(count * original[1] / sum(original))),
    )
    return [tier1, tier2, count - tier1 - tier2]


def build_metadata(document, query, mode, count, error_code):
    raw_papers = document.get("papers") if isinstance(document, dict) else None
    if not isinstance(raw_papers, list):
        raise ValueError("input must be an object with papers[]")
    normalized = []
    warnings = []
    seen = set()
    cutoff = _exclusive_cutoff_year(query)
    for index, raw in enumerate(raw_papers[:200], 1):
        paper, warning = _normalize_paper(raw)
        if warning:
            warnings.append("paper %d: %s" % (index, warning))
            continue
        key = _title_key(paper["title"])
        identifiers = {value.casefold() for value in (paper["doi"], paper["arxiv_id"]) if value}
        if key in seen or identifiers.intersection(seen):
            continue
        if cutoff and isinstance(paper["year"], int) and paper["year"] >= cutoff:
            warnings.append("paper %d violates the before-%d cutoff" % (index, cutoff))
            continue
        seen.add(key)
        seen.update(identifiers)
        normalized.append(paper)
    selected = normalized[:count]
    if not selected:
        raise ValueError("web fallback produced no verifiable paper candidates")
    tier_budget = _tier_budget(len(selected), mode)
    tier_edges = (tier_budget[0], tier_budget[0] + tier_budget[1])
    for index, paper in enumerate(selected):
        paper["tier"] = 1 if index < tier_edges[0] else 2 if index < tier_edges[1] else 3
    queries = document.get("search_queries", []) if isinstance(document, dict) else []
    if not isinstance(queries, list):
        raise ValueError("input.search_queries must be a list")
    queries = [str(item).strip() for item in queries if str(item).strip()]
    if not queries:
        raise ValueError("input.search_queries must contain the Web queries used")
    status = "complete" if len(selected) == count else "partial"
    return {
        "search_summary": {
            "query": query,
            "mode": mode,
            "result_status": status,
            "degraded": True,
            "source_mode": "web_only",
            "source_status": {
                "paperhub": {
                    "available": False,
                    "reason": ERROR_REASONS.get(error_code, "unavailable"),
                    "error_code": error_code,
                },
                "web_search": {"available": True, "used": True},
            },
            "limitations": [
                "PaperHub structured metadata and citation expansion were unavailable.",
                "Coverage may favor publicly indexed and open-access papers.",
            ],
            "total_rounds": 1,
            "total_queries": len(queries),
            "pool_size": len(normalized),
            "selected_count": len(selected),
            "tier_budget": tier_budget,
            "selection_strategy": "model_ranked_web_candidates_with_deterministic_validation",
            "exclusive_cutoff_year": cutoff,
            "warnings": warnings,
            "fallback_event_file": "fallback_event.json",
        },
        "papers": selected,
    }


def build_fallback_event(
    document, metadata, error_code, requested_count, prior_event=None,
):
    prior = dict(prior_event) if isinstance(prior_event, dict) else {}
    now = datetime.now(timezone.utc).isoformat()
    paperhub = dict(prior.get("paperhub", {}))
    if not paperhub:
        paperhub = {
            "error_code": error_code,
            "reason": ERROR_REASONS.get(error_code, "unavailable"),
            "planned_queries": 0 if error_code == "PAPERHUB_AUTH_MISSING" else None,
            "executed_operations": 0 if error_code == "PAPERHUB_AUTH_MISSING" else None,
            "retry_attempts": 0 if error_code == "PAPERHUB_AUTH_MISSING" else None,
            "wall_elapsed_seconds": 0.0 if error_code == "PAPERHUB_AUTH_MISSING" else None,
            "failed_operations": [],
        }
    else:
        paperhub["error_code"] = error_code
        paperhub["reason"] = ERROR_REASONS.get(error_code, "unavailable")
    raw_papers = document.get("papers", []) if isinstance(document, dict) else []
    summary = metadata["search_summary"]
    return {
        "schema_version": 1,
        "event": "paperhub_fallback",
        "detected_at_utc": prior.get("detected_at_utc") or now,
        "finalized_at_utc": now,
        "query": summary["query"],
        "mode": summary["mode"],
        "paperhub": paperhub,
        "fallback": {
            "source": "web_search_skill",
            "search_query_count": summary["total_queries"],
            "received_candidate_count": len(raw_papers) if isinstance(raw_papers, list) else 0,
            "verifiable_candidate_count": summary["pool_size"],
            "selected_count": summary["selected_count"],
            "requested_count": requested_count,
            "result_status": summary["result_status"],
            "warnings": summary["warnings"],
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Finalize a Web-only degraded paper search")
    parser.add_argument("--query", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--mode", choices=sorted(MODE_BUDGETS), default="quick")
    parser.add_argument("--count", type=int)
    parser.add_argument("--paperhub-error-code", default="PAPERHUB_AUTH_MISSING")
    parser.add_argument("--input", help="candidate JSON path; defaults to stdin")
    args = parser.parse_args()
    default_count = MODE_BUDGETS[args.mode][0]
    count = args.count or default_count
    if not 1 <= count <= default_count:
        parser.error("count must be between 1 and %d for %s" % (default_count, args.mode))
    if not re.fullmatch(r"[A-Z0-9_]+", args.paperhub_error_code):
        parser.error("paperhub error code must contain only A-Z, 0-9, and underscore")
    metadata_path = os.path.join(args.output_dir, "metadata.json")
    event_path = os.path.join(args.output_dir, "fallback_event.json")
    if os.path.exists(metadata_path) or os.path.exists(event_path):
        parser.error("refusing to overwrite existing fallback output")
    try:
        if args.input:
            with open(args.input, encoding="utf-8") as handle:
                document = json.load(handle)
        else:
            document = json.load(sys.stdin)
        metadata = build_metadata(
            document, args.query, args.mode, count, args.paperhub_error_code,
        )
        prior_event = None
        prior_event_path = os.path.join(
            args.output_dir, "session", "fallback_event.json",
        )
        if os.path.isfile(prior_event_path):
            with open(prior_event_path, encoding="utf-8") as handle:
                prior_event = json.load(handle)
        event = build_fallback_event(
            document, metadata, args.paperhub_error_code, count, prior_event,
        )
        os.makedirs(args.output_dir, exist_ok=True)
        # Persist the source failure before the user-facing degraded result.
        search_state._atomic_json_write(event_path, event)
        search_state._atomic_json_write(metadata_path, metadata)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        json.dump({"error": str(exc)}, sys.stdout, ensure_ascii=False, indent=2)
        print()
        return 1
    json.dump({
        "metadata": os.path.abspath(metadata_path),
        "fallback_event": os.path.abspath(event_path),
        "selected_count": len(metadata["papers"]),
        "result_status": metadata["search_summary"]["result_status"],
        "source_mode": "web_only",
    }, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
