#!/usr/bin/env scholarseed-skill-python
"""Normalize heterogeneous search records into the stable paper contract."""

from __future__ import annotations

import hashlib
import re
import urllib.parse
from typing import Any


DOCUMENT_TYPES = {"paper", "blog", "documentation", "dataset", "web_page", "unknown"}
IDENTITY_STATUSES = {"verified", "probable", "unverified"}
SCHOLARLY_SOURCES = {
    "arxiv", "crossref", "openalex", "paperhub", "pubmed", "semantic_scholar",
}
SCHOLARLY_HOSTS = {
    "acm.org", "arxiv.org", "doi.org", "ieee.org", "nature.com", "nih.gov",
    "openreview.net", "sciencedirect.com", "springer.com", "wiley.com",
    "papers.nips.cc", "papers.neurips.cc", "proceedings.neurips.cc",
}


def _first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def _external_ids(paper: dict[str, Any]) -> dict[str, Any]:
    value = _first(paper, "external_ids", "externalIds", "externalids")
    return dict(value) if isinstance(value, dict) else {}


def _doi(paper: dict[str, Any]) -> str | None:
    value = paper.get("doi")
    if not value:
        for key, candidate in _external_ids(paper).items():
            if str(key).casefold() == "doi":
                value = candidate
                break
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = re.sub(
        r"^https?://(?:dx\.)?doi\.org/", "", value.strip(), flags=re.I
    )
    normalized = re.sub(r"^doi:\s*", "", normalized, flags=re.I)
    return normalized or None


def _arxiv_id(paper: dict[str, Any]) -> str | None:
    value = _first(paper, "arxiv_id", "arxivId")
    if not value:
        for key, candidate in _external_ids(paper).items():
            if str(key).casefold() in {"arxiv", "arxiv_id", "arxivid"}:
                value = candidate
                break
    if not value:
        for key in ("url", "landing_page_url", "landingPageUrl", "pdf_url", "pdfUrl"):
            candidate = paper.get(key)
            if isinstance(candidate, str) and "arxiv.org/" in candidate.casefold():
                value = candidate
                break
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = re.sub(r"^arxiv:\s*", "", value.strip(), flags=re.I)
    normalized = re.sub(
        r"^https?://arxiv\.org/(?:abs|pdf)/", "", normalized, flags=re.I
    )
    return normalized.removesuffix(".pdf") or None


def _authors(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for author in value:
        name = author.get("name") if isinstance(author, dict) else author
        if isinstance(name, str) and name.strip():
            result.append(name.strip())
    return result

def _year(paper: dict[str, Any]) -> int | None:
    value = _first(paper, "year", "publication_year", "publicationYear")
    if value is None:
        publication_date = paper.get("publicationdate")
        if isinstance(publication_date, str):
            match = re.match(r"^\s*(\d{4})", publication_date)
            value = match.group(1) if match else None
    if isinstance(value, bool) or value is None:
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        return None
    return year if 1000 <= year <= 9999 else None


def _venue(paper: dict[str, Any]) -> str | None:
    value = _first(
        paper, "venue", "journal", "conference", "publication_venue",
        "publicationVenue", "journal_name",
    )
    if isinstance(value, dict):
        value = _first(value, "name", "title")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _open_access(paper: dict[str, Any], arxiv_id: str | None) -> str:
    if arxiv_id:
        return "yes"
    value = _first(
        paper, "open_access", "openAccess", "is_open_access", "isOpenAccess",
        "isopenaccess", "access"
    )
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, str):
        normalized = value.strip().casefold().replace("-", "_").replace(" ", "_")
        if normalized in {"yes", "true", "open", "open_access", "oa", "gold", "green"}:
            return "yes"
        if normalized in {"no", "false", "closed", "paywalled", "restricted"}:
            return "no"
    return "unknown"


def _single_sentence(value: str, limit: int = 360) -> str:
    text = " ".join(value.split())
    text = re.sub(r"^abstract\s*[:.-]\s*", "", text, flags=re.I)
    if not text:
        return ""
    match = re.search(r"(?<=[.!?])(?:\s|$)", text)
    sentence = text[: match.start()].rstrip() if match else text
    if len(sentence) > limit:
        clipped = sentence[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
        sentence = f"{clipped or sentence[:limit - 1].rstrip()}…"
    if sentence[-1] not in ".!?…":
        sentence = f"{sentence}."
    return sentence


def abstract_summary(title: str, abstract: str | None) -> str:
    if abstract:
        return _single_sentence(abstract)
    return _single_sentence(
        f"{title} is a candidate paper, but the search source did not provide an abstract."
    )


def _stable_id(paper: dict[str, Any], title: str, doi: str | None, arxiv_id: str | None) -> str:
    value = _first(paper, "id", "paper_id", "paperId")
    if value is not None and str(value).strip():
        return str(value).strip()
    if doi:
        return f"doi:{doi.casefold()}"
    if arxiv_id:
        return f"arxiv:{arxiv_id.casefold()}"
    digest = hashlib.sha256(title.casefold().encode("utf-8")).hexdigest()[:20]
    return f"title:{digest}"


def _url_parts(url: Any) -> tuple[str, str] | None:
    if not isinstance(url, str):
        return None
    try:
        parsed = urllib.parse.urlsplit(url.strip())
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    return parsed.hostname.casefold(), parsed.path.casefold()


def _document_type(
    paper: dict[str, Any], source: str, doi: str | None, arxiv_id: str | None, url: Any,
) -> str:
    explicit = _first(paper, "document_type", "documentType")
    if isinstance(explicit, str) and explicit.strip().casefold() in DOCUMENT_TYPES:
        return explicit.strip().casefold()
    if doi or arxiv_id:
        return "paper"
    publication_type = _first(paper, "publication_type", "publicationType", "type")
    if isinstance(publication_type, str) and any(
        marker in publication_type.casefold()
        for marker in ("article", "conference", "journal", "paper", "preprint", "review")
    ):
        return "paper"
    parts = _url_parts(url)
    if parts:
        host, path = parts
        if host.startswith("docs.") or any(marker in path for marker in ("/docs/", "/documentation/", "/manual/", "/reference/")):
            return "documentation"
        if host.startswith("blog.") or host.endswith(".substack.com") or any(marker in path for marker in ("/blog/", "/posts/")):
            return "blog"
        if host in {"data.gov", "kaggle.com"} or host.endswith(".data.gov") or "/datasets/" in path:
            return "dataset"
        if any(host == known or host.endswith(f".{known}") for known in SCHOLARLY_HOSTS):
            return "paper"
        return "web_page"
    if source.casefold() in SCHOLARLY_SOURCES:
        return "paper"
    return "unknown"


def _identity_status(
    paper: dict[str, Any], source: str, doi: str | None, arxiv_id: str | None, url: Any,
) -> str:
    explicit = _first(paper, "identity_status", "identityStatus")
    if isinstance(explicit, str) and explicit.strip().casefold() in IDENTITY_STATUSES:
        return explicit.strip().casefold()
    if doi or arxiv_id:
        return "verified"
    native_id = _first(paper, "id", "paper_id", "paperId")
    if native_id is not None and str(native_id).strip() and source.casefold() in SCHOLARLY_SOURCES:
        return "verified"
    if _url_parts(url):
        return "probable"
    return "unverified"


def _relevance(paper: dict[str, Any]) -> dict[str, Any]:
    existing = paper.get("relevance")
    if isinstance(existing, dict):
        score = existing.get("score")
        reasons = existing.get("reasons")
    else:
        score = _first(paper, "relevance_score", "score", "_score")
        reason = _first(paper, "selection_reason", "reason")
        reasons = [reason] if isinstance(reason, str) and reason.strip() else []
    if not isinstance(score, (int, float)) or isinstance(score, bool):
        score = None
    if not isinstance(reasons, list):
        reasons = []
    normalized_reasons = [str(reason).strip() for reason in reasons if str(reason).strip()]
    if not normalized_reasons:
        normalized_reasons = ["Recalled by the configured literature search sources."]
    return {"score": score, "reasons": normalized_reasons}


def normalize_paper(paper: dict[str, Any], source: str | None = None) -> dict[str, Any] | None:
    title_value = paper.get("title")
    if not isinstance(title_value, str) or not title_value.strip():
        return None
    title = title_value.strip()
    doi = _doi(paper)
    arxiv_id = _arxiv_id(paper)
    paper_id = _stable_id(paper, title, doi, arxiv_id)
    abstract_value = paper.get("abstract")
    abstract = abstract_value.strip() if isinstance(abstract_value, str) and abstract_value.strip() else None
    url = _first(paper, "url", "landing_page_url", "landingPageUrl")
    if not isinstance(url, str) or not url.strip():
        url = f"https://doi.org/{doi}" if doi else (
            f"https://arxiv.org/abs/{arxiv_id}" if arxiv_id else None
        )
    source_value = str(source or paper.get("source") or "unknown").strip() or "unknown"
    availability = _first(paper, "fulltext_availability", "fulltextAvailability")
    result: dict[str, Any] = {
        "id": paper_id,
        "title": title,
        "authors": _authors(paper.get("authors")),
        "year": _year(paper),
        "abstract": abstract,
        "abstract_summary": abstract_summary(title, abstract),
        "doi": doi,
        "venue": _venue(paper),
        "open_access": _open_access(paper, arxiv_id),
        "source": source_value,
        "document_type": _document_type(paper, source_value, doi, arxiv_id, url),
        "identity_status": _identity_status(paper, source_value, doi, arxiv_id, url),
        "relevance": _relevance(paper),
        "is_placeholder": paper.get("is_placeholder") is True,
    }
    optional = {
        "arxiv_id": arxiv_id,
        "url": url,
        "citation_count": _first(
            paper, "citation_count", "citationCount", "citationcount"
        ),
        "publication_type": _first(paper, "publication_type", "publicationType", "type"),
        "publication_types": _first(paper, "publication_types", "publicationtypes"),
        "fulltext_availability": availability,
        "external_ids": _external_ids(paper),
        "subtopics_covered": paper.get("subtopics_covered"),
        "tier": paper.get("tier"),
        "language": paper.get("language"),
        "intent_review": paper.get("intent_review"),
        "selection_reason": _first(paper, "selection_reason", "reason"),
    }
    for key, value in optional.items():
        if value is not None and value != [] and value != {} and value != "":
            result[key] = value
    result["full_text_expected"] = bool(
        arxiv_id or (isinstance(availability, str) and availability.casefold() == "full")
    )
    return result
