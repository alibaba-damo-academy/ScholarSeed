"""Verified source projection for one completed assistant answer."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from markdown_it.token import Token

from service.chat.constants import (
    PRODUCT_EVENT_NATIVE_SOURCES,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_SOURCE_CANDIDATES,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.events import ProductEventRecord
from service.platform.citations import CITATION_SCHEME

ANSWER_REVISION_PREFIX = "sha256:"
SEARCH_SOURCE_KIND = "searched"
RECEIPT_SOURCE_KIND = "receipt"
WEB_SEARCH_KIND = "web"
PAPER_SEARCH_KIND = "paper"
TOOL_DECLARED_ORIGIN = "tool_declared"
HTTP_SCHEMES = frozenset(("http", "https"))
AUTOLINK_PREFIXES = ("http://", "https://", "www.")
REFERENCE_LABEL = re.compile(r"\[([0-9]+)\](?!\(|\[(?![0-9]+\]))")
REFERENCE_URL = re.compile(r"https?://[^\s<>]+")
REFERENCE_URL_TRAILING_PUNCTUATION = ".,;!?，。；！？、"
REFERENCE_ENTRY_TOKEN = "citation_entry"
REFERENCE_LABEL_TOKEN = "citation_label"
REFERENCE_LINE_BREAKS = frozenset(("softbreak", "hardbreak"))
REFERENCE_STYLE_TOKENS = frozenset(("em_open", "em_close", "strong_open", "strong_close"))
REFERENCE_INLINE_SPACE = re.compile(r"[\t ]*")
NATIVE_CITATIONS_UNMATCHED = "unmatched"
NATIVE_CITATIONS_UNAVAILABLE = "unavailable"
NATIVE_CITATIONS_EMPTY = "empty"
NATIVE_CITATIONS_AVAILABLE = "available"
SEARCH_EXCERPT_FIELDS = ("snippet", "description", "content")
SEARCH_EXCERPT_MAX_CHARACTERS = 16000


def _reference_token(state: StateInline, silent: bool) -> bool:
    if state.linkLevel:
        return False
    match = REFERENCE_LABEL.match(state.src, state.pos)
    if match is None:
        return False
    line_start = state.src.rfind("\n", 0, state.pos) + 1
    prefix = state.src[line_start : state.pos]
    tail = state.src[match.end() :].split("\n", 1)[0]
    href = ""
    title = ""
    if not prefix.strip() and tail[:1].isspace():
        candidate = tail.strip()
        if REFERENCE_URL.fullmatch(candidate):
            href = candidate.rstrip(REFERENCE_URL_TRAILING_PUNCTUATION)
            title = href
        else:
            parsed = MarkdownIt("commonmark").parseInline(candidate)[0].children or []
            if (
                parsed
                and parsed[0].type == "link_open"
                and parsed[-1].type == "link_close"
                and sum(token.type == "link_open" for token in parsed) == 1
                and not any(token.type == "image" for token in parsed)
            ):
                href = str(parsed[0].attrGet("href") or "")
                title = "".join(token.content for token in parsed if token.type == "text")
    if not silent:
        token = state.push(REFERENCE_ENTRY_TOKEN if href else REFERENCE_LABEL_TOKEN, "", 0)
        token.content = match.group(1)
        token.meta = {"href": href, "title": title}
    state.pos = match.end() + (len(tail) if href else 0)
    return True


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
            PRODUCT_EVENT_SOURCE_CANDIDATES: WEB_SEARCH_KIND,
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
            declared = event.kind == PRODUCT_EVENT_SOURCE_CANDIDATES
            if identity is None:
                continue
            existing = candidates.get(identity)
            if existing is not None and (
                declared or existing.get("origin") != TOOL_DECLARED_ORIGIN
            ):
                continue
            candidates[identity] = {
                "kind": SEARCH_SOURCE_KIND,
                "url": url,
                "title": str(row.get("title") or url),
                "search_kind": search_kind,
                "search_id": str(event.payload.get("search_id") or ""),
            }
            if declared:
                candidates[identity]["origin"] = TOOL_DECLARED_ORIGIN
            excerpts = [
                row[key]
                for key in SEARCH_EXCERPT_FIELDS
                if isinstance(row.get(key), str) and row[key].strip()
            ]
            if excerpts and not declared:
                candidates[identity]["excerpt"] = "\n".join(excerpts)[
                    :SEARCH_EXCERPT_MAX_CHARACTERS
                ]
    return candidates, fallback


def _postfix_references(children: Iterable[Token]) -> list[tuple[str, str, str]]:
    lines: list[list[Token]] = [[]]
    for token in children:
        if token.type in REFERENCE_LINE_BREAKS:
            lines.append([])
        elif token.type not in REFERENCE_STYLE_TOKENS:
            lines[-1].append(token)
    declarations: list[tuple[str, str, str]] = []
    for line in lines:
        if any(token.type == "html_inline" for token in line):
            continue
        links = [
            index
            for index, token in enumerate(line)
            if token.type == "link_open"
            and not (
                index + 2 < len(line)
                and line[index + 1].type == "text"
                and line[index + 1].content.isdecimal()
                and line[index + 2].type == "link_close"
            )
        ]
        if len(links) != 1:
            continue
        link_index = links[0]
        closing = next(
            (
                index
                for index in range(link_index + 1, len(line))
                if line[index].type == "link_close"
            ),
            None,
        )
        if closing is None:
            continue
        following = [
            token
            for token in line[closing + 1 :]
            if token.type != "text" or REFERENCE_INLINE_SPACE.fullmatch(token.content) is None
        ]
        if (
            not following
            or following[0].type != REFERENCE_LABEL_TOKEN
            or (len(following) > 1 and following[1].type == REFERENCE_LABEL_TOKEN)
        ):
            continue
        content = line[link_index + 1 : closing]
        if not content or any(token.type != "text" for token in content):
            continue
        href = str(line[link_index].attrGet("href") or "")
        title = "".join(token.content for token in content)
        identity = canonical_url(href)
        if identity is None or canonical_url(title) != identity:
            continue
        declarations.append((following[0].content, href, title))
    return declarations


def _answer_links(markdown: str) -> tuple[list[tuple[str, str]], dict[str, str]]:
    parser = MarkdownIt("commonmark", {"linkify": True}).enable("linkify")
    parser.inline.ruler.before("link", "citation_reference", _reference_token)
    blocks = parser.parse(markdown)
    references: dict[str, dict[str, tuple[str, str]]] = {}
    for block in blocks:
        for label, href, title in _postfix_references(block.children or ()):
            identity = canonical_url(href)
            if identity is not None:
                references.setdefault(label, {})[identity] = (href, title)
        children = block.children or ()
        for index, token in enumerate(children):
            if token.type == REFERENCE_ENTRY_TOKEN:
                href = token.meta["href"]
                identity = canonical_url(href)
                if identity is not None:
                    references.setdefault(token.content, {})[identity] = (href, token.meta["title"])
            elif token.type == "link_open":
                label = ""
                for child in children[index + 1 :]:
                    if child.type == "link_close":
                        break
                    if child.type != "text":
                        label = ""
                        break
                    label += child.content
                href = str(token.attrGet("href") or "")
                identity = canonical_url(href)
                if label.isdecimal() and identity is not None:
                    references.setdefault(label, {})[identity] = (href, href)
    bindings = {
        label: next(iter(targets.values()))
        for label, targets in references.items()
        if len(targets) == 1
    }
    links: list[tuple[str, str]] = []
    for block in blocks:
        children = block.children or ()
        for index, token in enumerate(children):
            if token.type == REFERENCE_ENTRY_TOKEN:
                links.append((token.meta["href"], token.meta["title"]))
                continue
            if token.type == REFERENCE_LABEL_TOKEN:
                if token.content in bindings:
                    links.append(bindings[token.content])
                continue
            link_href = token.attrGet("href") if token.type == "link_open" else None
            if not link_href:
                continue
            if token.markup == "linkify" and index and children[index - 1].content.endswith("]("):
                continue
            label_parts: list[str] = []
            for child in children[index + 1 :]:
                if child.type == "link_close":
                    break
                if child.type in {"text", "code_inline"}:
                    label_parts.append(child.content)
            title = "".join(label_parts).strip()
            if token.markup == "linkify" and not title.lower().startswith(AUTOLINK_PREFIXES):
                continue
            links.append((str(link_href), title))
    return links, {label: href for label, (href, _) in bindings.items()}


def answer_sources(
    markdown: str, events: Iterable[ProductEventRecord], *, item_id: str = ""
) -> dict:
    """Project receipts and links backed by a same-turn completed search."""

    records = tuple(events)
    candidates, fallback = _search_candidates(records)
    revision = f"{ANSWER_REVISION_PREFIX}{hashlib.sha256(markdown.encode('utf-8')).hexdigest()}"
    sources: list[dict] = []
    projected: dict[tuple[str, str], dict] = {}
    links, references = _answer_links(markdown)
    for href, title in links:
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
            elif url_identity is not None and (
                (fallback is not None and not candidates)
                or title.isdecimal()
                or href in references.values()
            ):
                identity = (SEARCH_SOURCE_KIND, url_identity)
                source = {
                    "kind": SEARCH_SOURCE_KIND,
                    "url": href,
                    "title": title if title and not title.isdecimal() else href,
                    "search_kind": fallback.search_kind if fallback else WEB_SEARCH_KIND,
                    "search_id": "",
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
    for label, href in references.items():
        url_identity = canonical_url(href)
        if url_identity is None:
            continue
        registered = projected.get((SEARCH_SOURCE_KIND, url_identity))
        if registered is not None:
            registered.setdefault("reference_labels", []).append(label)
    native = next(
        (
            event.payload
            for event in reversed(records)
            if item_id
            and event.kind == PRODUCT_EVENT_NATIVE_SOURCES
            and event.payload.get("item_id") == item_id
            and event.payload.get("answer_revision") == revision
        ),
        {},
    )
    for citation in native.get("sources", []):
        href = citation.get("url", "")
        url_identity = canonical_url(href)
        if url_identity is None:
            continue
        identity = (SEARCH_SOURCE_KIND, url_identity)
        source = projected.get(identity)
        if source is None:
            source = {
                "number": len(sources) + 1,
                "kind": SEARCH_SOURCE_KIND,
                "url": href,
                "title": citation.get("title") or href,
                "search_kind": WEB_SEARCH_KIND,
                "search_id": "",
                "citation_urls": [href],
            }
            sources.append(source)
            projected[identity] = source
        occurrence = {key: citation[key] for key in ("start_utf16", "end_utf16")}
        occurrences = source.setdefault("occurrences", [])
        if occurrence not in occurrences:
            occurrences.append(occurrence)
    result: dict[str, Any] = {"answer_revision": revision, "sources": sources}
    if (
        candidates
        or fallback is not None
        or any(source["kind"] == SEARCH_SOURCE_KIND for source in sources)
    ):
        declared_sources: dict[str | None, dict[str, Any]] = {
            canonical_url(source["url"]): {
                key: source[key] for key in ("kind", "url", "title", "search_kind", "search_id")
            }
            for source in sources
            if source["kind"] == SEARCH_SOURCE_KIND
        }
        declared_sources.update(candidates)
        result["search_sources"] = list(declared_sources.values())
        result["coverage"] = {
            "status": "pending",
            "truncated_sources": any(
                bool(record.payload.get("results_truncated")) for record in records
            ),
        }
    if any(event.kind == PRODUCT_EVENT_NATIVE_SOURCES for event in records):
        result["native_citations"] = {
            "status": (
                NATIVE_CITATIONS_UNMATCHED
                if not native
                else (
                    NATIVE_CITATIONS_UNAVAILABLE
                    if not native.get("provided")
                    else (
                        NATIVE_CITATIONS_AVAILABLE
                        if native.get("sources")
                        else NATIVE_CITATIONS_EMPTY
                    )
                )
            ),
            "invalid": native.get("invalid", 0),
            "truncated": native.get("truncated", False),
        }
    return result


__all__ = ["answer_sources", "canonical_url"]
