"""Session-local page text for explicitly web-enabled PDF evidence reads."""

from __future__ import annotations

import asyncio
import math
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from hashlib import sha256
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from service.platform.activity import Activities, ActivityDomain
from service.platform.citations import WebEvidencePage
from service.platform.pdf import pdf_document_text

PUBLIC_PDF_PREFIX = "public-pdf:"
MAX_CHARACTERS = 2_000_000
MAX_EVIDENCE_CHARACTERS = 60_000
WINDOW = 400
TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]+")
PRINTED_PAGE_LINE_PATTERN = re.compile(r"^\d{1,5}$")
STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "do",
        "does",
        "for",
        "from",
        "how",
        "in",
        "into",
        "is",
        "it",
        "its",
        "many",
        "much",
        "of",
        "on",
        "or",
        "our",
        "that",
        "the",
        "their",
        "these",
        "this",
        "those",
        "to",
        "use",
        "used",
        "using",
        "was",
        "we",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "with",
    }
)


def _canonical_pdf_url(url: str) -> str:
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    return urlunsplit((scheme, netloc, path, parsed.query, ""))


def _printed_page_label(raw_page: str) -> str:
    lines = [line.strip() for line in raw_page.splitlines() if line.strip()]
    if not lines:
        return ""
    for candidate in (lines[0], lines[-1]):
        if PRINTED_PAGE_LINE_PATTERN.fullmatch(candidate):
            return candidate
    return ""


def _query_terms(needle: str) -> tuple[str, ...]:
    raw_tokens = TOKEN_PATTERN.findall(needle)
    filtered = [
        token
        for token in raw_tokens
        if token not in STOPWORDS and (len(token) > 1 or token.isdigit())
    ]
    chosen = filtered or raw_tokens
    return tuple(dict.fromkeys(chosen))


@dataclass(frozen=True)
class PublicPaper:
    ref_id: str
    url: str
    pages: tuple[str, ...]
    printed_pages: tuple[str, ...] = ()

    def _build_fragment(self, page: int, left: int, right: int, span: int) -> dict:
        text = self.pages[page - 1]
        parts = [text[left:right]]
        pages = [page]
        next_page, next_offset = page, right
        for _ in range(span - 1):
            if next_offset >= len(self.pages[next_page - 1]):
                next_page += 1
                next_offset = 0
            if next_page > len(self.pages) or not self.pages[next_page - 1]:
                break
            part = self.pages[next_page - 1][next_offset : next_offset + 2 * WINDOW]
            parts.append(part)
            if pages[-1] != next_page:
                pages.append(next_page)
            next_offset += len(part)
        fragment: dict = {
            "pages": pages,
            "text": " ".join(parts),
            "citation_url": f"{self.url}#page={page}",
        }
        if self.printed_pages:
            labels = [
                self.printed_pages[p - 1]
                for p in pages
                if 1 <= p <= len(self.printed_pages) and self.printed_pages[p - 1]
            ]
            if labels:
                fragment["printed_pages"] = labels
        return fragment

    def _ranked_term_windows(self, needle: str) -> list[tuple[int, int, int]]:
        terms = _query_terms(needle)
        if not terms or not self.pages:
            return []
        lower_pages = [page.lower() for page in self.pages]
        total_pages = len(lower_pages)
        idf: dict[str, float] = {}
        for term in terms:
            df = sum(1 for lower in lower_pages if term in lower)
            if df > 0:
                idf[term] = math.log(1.0 + total_pages / df)
        if not idf:
            return []
        active_terms = tuple(idf.keys())
        min_matched = (
            1
            if len(terms) == 1
            else max(2, min(len(active_terms), int(math.ceil(len(terms) * 0.4))))
        )
        if len(active_terms) < min_matched:
            return []
        stride = max(1, WINDOW // 2)
        window_size = 2 * WINDOW
        scored: list[tuple[float, int, int, int, int, int]] = []
        for page_idx, lower in enumerate(lower_pages, 1):
            if not lower:
                continue
            page_hits = [term for term in active_terms if term in lower]
            if len(page_hits) < min_matched:
                continue
            length = len(lower)
            starts = list(range(0, max(1, length - window_size + 1), stride))
            if length > window_size and starts[-1] + window_size < length:
                starts.append(length - window_size)
            best_for_page: list[tuple[float, int, int, int, int, int]] = []
            for left in starts:
                right = min(length, left + window_size)
                chunk = lower[left:right]
                matched_terms = [term for term in page_hits if term in chunk]
                if len(matched_terms) < min_matched:
                    continue
                score = sum(idf[term] for term in matched_terms)
                occurrences = sum(chunk.count(term) for term in matched_terms)
                candidate = (score, len(matched_terms), occurrences, -page_idx, -left, right)
                best_for_page.append(candidate)
            best_for_page.sort(reverse=True)
            kept_ranges: list[tuple[int, int]] = []
            for item in best_for_page:
                cand_left = -item[4]
                cand_right = item[5]
                if any(
                    min(cand_right, existing_right) - max(cand_left, existing_left) > WINDOW
                    for existing_left, existing_right in kept_ranges
                ):
                    continue
                kept_ranges.append((cand_left, cand_right))
                scored.append(item)
        scored.sort(reverse=True)
        return [(-item[3], -item[4], item[5]) for item in scored]

    def excerpts(self, query: str, offset: int, limit: int, span: int = 1) -> dict:
        needle = " ".join(query.lower().split())
        fragments = []
        matched = 0
        for page, text in enumerate(self.pages, 1):
            lower = text.lower()
            start = 0
            while start < len(text):
                position = lower.find(needle, start) if needle else start
                if position < 0:
                    break
                left = max(0, position - WINDOW) if needle else start
                right = min(
                    len(text), position + len(needle) + WINDOW if needle else start + 2 * WINDOW
                )
                if matched >= offset and len(fragments) < limit:
                    fragments.append(self._build_fragment(page, left, right, span))
                matched += 1
                start = right
        if matched == 0 and needle:
            ranked = self._ranked_term_windows(needle)
            matched = len(ranked)
            for page, left, right in ranked[offset : offset + limit]:
                fragments.append(self._build_fragment(page, left, right, span))
        end = offset + len(fragments)
        return {
            "ok": True,
            "ref_id": self.ref_id,
            "source_url": self.url,
            "page_count": len(self.pages),
            "fragments": fragments,
            "next_offset": end if end < matched else None,
        }


class PublicPdfCache:
    def __init__(self) -> None:
        self.documents: dict[str, PublicPaper] = {}
        self.lock = asyncio.Lock()

    async def open(
        self,
        url: str,
        fetch: Callable[[str], Awaitable[tuple[str, bytes]]],
        activities: Activities,
        authorized: Callable[[], bool],
    ) -> PublicPaper:
        async with self.lock:
            if not authorized():
                raise ValueError("public_pdf_access_denied")
            cached = self._cached(url)
            if cached is not None:
                return cached
            final, payload = await fetch(url)
            raw_pages = await activities.to_thread(
                ActivityDomain.BRIDGE, pdf_document_text, payload
            )
            if sum(map(len, raw_pages)) > MAX_CHARACTERS:
                raise ValueError("public_pdf_text_too_large")
            printed_pages = tuple(_printed_page_label(page) for page in raw_pages)
            pages = tuple(" ".join(page.split()) for page in raw_pages)
            if not any(pages):
                raise ValueError("public_pdf_no_text_layer")
            if not authorized():
                raise ValueError("public_pdf_access_denied")
            paper = PublicPaper(
                PUBLIC_PDF_PREFIX + uuid4().hex,
                final.split("#", 1)[0],
                pages,
                printed_pages if any(printed_pages) else (),
            )
            if len(self.documents) >= 4:
                self.documents.pop(next(iter(self.documents)))
            self.documents[url] = paper
            return paper

    def _cached(self, url: str) -> PublicPaper | None:
        # A fragment never reaches the server, so "#page=N" citation URLs and the
        # redirected final URL name the same bytes already read in this session.
        canonical = _canonical_pdf_url(url.split("#", 1)[0])
        for key, paper in tuple(self.documents.items()):
            if canonical in (
                _canonical_pdf_url(key.split("#", 1)[0]),
                _canonical_pdf_url(paper.url),
            ):
                # Keep recently used papers out of the bounded eviction order.
                self.documents[key] = self.documents.pop(key)
                return paper
        return None

    def resolve(self, ref_id: str) -> PublicPaper:
        for paper in self.documents.values():
            if paper.ref_id == ref_id:
                return paper
        raise ValueError("public_pdf_reference_unavailable")

    def evidence_page(self, url: str) -> WebEvidencePage | None:
        if not url or not self.documents:
            return None
        base, _, fragment = url.partition("#")
        canonical = _canonical_pdf_url(base)
        matched = next(
            (
                paper
                for key, paper in self.documents.items()
                if _canonical_pdf_url(paper.url) == canonical
                or _canonical_pdf_url(key) == canonical
            ),
            None,
        )
        if matched is None:
            return None
        text = ""
        lower_fragment = fragment.strip().lower()
        if lower_fragment.startswith("page="):
            page_token = lower_fragment[len("page=") :].split("&", 1)[0]
            if page_token.isdigit():
                page_number = int(page_token)
                if 1 <= page_number <= len(matched.pages):
                    text = matched.pages[page_number - 1]
        if not text:
            text = "\n\n".join(page for page in matched.pages if page)[:MAX_EVIDENCE_CHARACTERS]
        if not text:
            return None
        return WebEvidencePage(
            url,
            matched.url,
            text,
            sha256(text.encode()).hexdigest(),
            "",
            "public_pdf",
        )
