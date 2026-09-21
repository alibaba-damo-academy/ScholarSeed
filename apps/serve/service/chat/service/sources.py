"""Verified source projection for one completed assistant answer."""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from urllib.parse import urlsplit, urlunsplit

from markdown_it import MarkdownIt

from service.chat.constants import (
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.events import ProductEventRecord
from service.platform.citations import CITATION_SCHEME

ANSWER_REVISION_PREFIX = "sha256:"
SEARCH_SOURCE_KIND = "searched"
RECEIPT_SOURCE_KIND = "receipt"
WEB_SEARCH_KIND = "web"
PAPER_SEARCH_KIND = "paper"
HTTP_SCHEMES = frozenset(("http", "https"))


@dataclass(frozen=True)
class SearchFallback:
    search_kind: str
    search_id: str


def canonical_url(value: str) -> str | None:
    """Return the conservative URL identity used for search-result matching."""

    try:
        parsed = urlsplit(value.strip())
        port = parsed.port
    except ValueError:
        return None
    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    if (
        scheme not in HTTP_SCHEMES
        or not hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        return None
    normalized_host = f"[{hostname}]" if ":" in hostname else hostname
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    authority = f"{normalized_host}{'' if port is None or default_port else f':{port}'}"
    return urlunsplit((scheme, authority, parsed.path or "/", parsed.query, ""))


def _search_candidates(
    events: Iterable[ProductEventRecord],
) -> tuple[dict[str, dict], SearchFallback | None]:
    candidates: dict[str, dict] = {}
    fallback: SearchFallback | None = None
    for event in events:
        search_kind = {
            PRODUCT_EVENT_WEB_SEARCH_COMPLETED: WEB_SEARCH_KIND,
            PRODUCT_EVENT_PAPER_SEARCH_COMPLETED: PAPER_SEARCH_KIND,
        }.get(event.kind)
        if search_kind is None:
            continue
        fallback = SearchFallback(
            search_kind=search_kind,
            search_id=str(event.payload.get("search_id") or ""),
        )
        results = event.payload.get("results")
        if not isinstance(results, list):
            continue
        for row in results:
            if not isinstance(row, Mapping):
                continue
            url = str(row.get("url") or "").strip()
            identity = canonical_url(url)
            if identity is None or identity in candidates:
                continue
            candidates[identity] = {
                "kind": SEARCH_SOURCE_KIND,
                "url": url,
                "title": str(row.get("title") or url),
                "search_kind": search_kind,
                "search_id": str(event.payload.get("search_id") or ""),
            }
    return candidates, fallback if not candidates else None


def _answer_links(markdown: str) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    for block in MarkdownIt("commonmark").parse(markdown):
        children = block.children or ()
        for index, token in enumerate(children):
            href = token.attrGet("href") if token.type == "link_open" else None
            if not href:
                continue
            label: list[str] = []
            for child in children[index + 1 :]:
                if child.type == "link_close":
                    break
                if child.type in {"text", "code_inline"}:
                    label.append(child.content)
            title = "".join(label).strip()
            links.append((str(href), title))
    return links


def answer_sources(markdown: str, events: Iterable[ProductEventRecord]) -> dict:
    """Project receipts and links backed by a same-turn completed search."""

    candidates, fallback = _search_candidates(events)
    sources: list[dict] = []
    projected: dict[tuple[str, str], dict] = {}
    for href, title in _answer_links(markdown):
        source: dict | None = None
        identity: tuple[str, str] | None = None
        if href.startswith(CITATION_SCHEME):
            handle = href[len(CITATION_SCHEME) :].strip()
            if handle:
                identity = (RECEIPT_SOURCE_KIND, handle)
                source = {
                    "kind": RECEIPT_SOURCE_KIND,
                    "handle": handle,
                    "citation_urls": [href],
                }
        else:
            url_identity = canonical_url(href)
            if url_identity is not None and url_identity in candidates:
                identity = (SEARCH_SOURCE_KIND, url_identity)
                source = dict(candidates[url_identity])
                source["citation_urls"] = [href]
            elif url_identity is not None and fallback is not None:
                identity = (SEARCH_SOURCE_KIND, url_identity)
                source = {
                    "kind": SEARCH_SOURCE_KIND,
                    "url": href,
                    "title": title if title and not title.isdecimal() else href,
                    "search_kind": fallback.search_kind,
                    "search_id": fallback.search_id,
                    "citation_urls": [href],
                }
        if source is None or identity is None:
            continue
        existing = projected.get(identity)
        if existing is not None:
            if href not in existing["citation_urls"]:
                existing["citation_urls"].append(href)
            continue
        source["number"] = len(sources) + 1
        sources.append(source)
        projected[identity] = source
    revision = hashlib.sha256(markdown.encode("utf-8")).hexdigest()
    return {"answer_revision": f"{ANSWER_REVISION_PREFIX}{revision}", "sources": sources}


__all__ = ["answer_sources", "canonical_url"]
