"""Search-engine providers and result normalization for web-search."""

from __future__ import annotations

import base64
import re
import unicodedata
from dataclasses import asdict, dataclass
from typing import Protocol
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

BING_NAME = "bing"
BING_LANDING_URL = "https://www.bing.com"
BING_RESULT_PATH = "/search"
BING_QUERY_INPUT_SELECTOR = "#sb_form_q"
BING_FORM_SELECTOR = "#sb_form"
BING_FORM_SUBMIT_SCRIPT = "form => form.submit()"
BING_LOAD_STATE = "domcontentloaded"
BING_INPUT_WAIT_STATE = "visible"
BING_RESULT_SELECTOR = "#b_results .b_algo"
BING_LINK_SELECTORS = ("h2 a", "a.tilk")
BING_RESULT_LINK_SELECTOR = ", ".join(
    f"{BING_RESULT_SELECTOR} {selector}" for selector in BING_LINK_SELECTORS
)
BING_SNIPPET_SELECTORS = (".b_caption p", "p.b_lineclamp2", ".b_snippet", "p")
BING_CHALLENGE_SELECTORS = ("#b_captcha", "iframe[src*='captcha']", "[id*='captcha']")
BING_SEARCH_PATHS = frozenset(
    {BING_RESULT_PATH, "/images/search", "/news/search", "/videos/search"}
)
BING_REDIRECT_PATH = "/ck/a"
BING_REDIRECT_PARAMETER = "u"
BING_REDIRECT_PREFIX = "a1"
CHALLENGE_MARKERS = (
    "verify you are human",
    "unusual traffic",
    "complete the challenge",
    "请输入验证码",
    "验证你是人类",
)
HTTP_SCHEMES = frozenset({"http", "https"})
TRACKING_PARAMETER_PREFIXES = ("utm_",)
TRACKING_PARAMETERS = frozenset({"msclkid"})
ELEMENT_TIMEOUT_MS = 2_000
BODY_SAMPLE_CHARACTERS = 8_000
RESULT_CARD_SCAN_MULTIPLIER = 3
WHITESPACE = re.compile(r"\s+")


@dataclass(frozen=True)
class Candidate:
    """A direct result exposed by the search engine."""

    title: str
    url: str
    description: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


@dataclass(frozen=True)
class ExtractionDiagnostics:
    """Bounded counters that explain why result cards were accepted or rejected."""

    scanned_cards: int
    accepted_candidates: int
    missing_links: int
    timed_out_links: int
    invalid_candidates: int
    duplicate_candidates: int

    def to_dict(self) -> dict[str, int]:
        return asdict(self)


@dataclass(frozen=True)
class Extraction:
    """Validated candidates and safe extraction diagnostics."""

    candidates: tuple[Candidate, ...]
    diagnostics: ExtractionDiagnostics


class SearchProvider(Protocol):
    """Provider contract used by the browser lifecycle."""

    name: str
    result_selector: str
    result_link_selector: str

    def search(self, page: Page, query: str, timeout_ms: int) -> None: ...

    def matches_page(self, url: str, query: str) -> bool: ...

    def has_challenge(self, page: Page) -> bool: ...

    def extract(self, page: Page, limit: int) -> Extraction: ...


def _clean_text(value: str | None) -> str:
    return WHITESPACE.sub(" ", value or "").strip()


def _normalized_query(value: str) -> str:
    return _clean_text(unicodedata.normalize("NFKC", value)).casefold()


def _decode_bing_redirect(value: str) -> str | None:
    if not value.startswith(BING_REDIRECT_PREFIX):
        return value if value.startswith(("http://", "https://")) else None
    encoded = value[len(BING_REDIRECT_PREFIX) :]
    padding = "=" * (-len(encoded) % 4)
    try:
        decoded = base64.urlsafe_b64decode(encoded + padding).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return None
    return decoded if decoded.startswith(("http://", "https://")) else None


def normalize_url(value: str | None) -> str | None:
    """Return a direct, stable HTTP(S) URL or reject an opaque/search URL."""

    if not value:
        return None
    try:
        parsed = urlsplit(value.strip())
        host = (parsed.hostname or "").lower()
        if parsed.scheme.lower() not in HTTP_SCHEMES or not host or parsed.username:
            return None
        if host == "bing.com" or host.endswith(".bing.com"):
            if parsed.path == BING_REDIRECT_PATH:
                redirect = dict(parse_qsl(parsed.query, keep_blank_values=True)).get(
                    BING_REDIRECT_PARAMETER
                )
                return normalize_url(_decode_bing_redirect(redirect or ""))
            if parsed.path.rstrip("/") in BING_SEARCH_PATHS:
                return None
        port = parsed.port
    except ValueError:
        return None

    scheme = parsed.scheme.lower()
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    netloc = host if port is None or default_port else f"{host}:{port}"
    query = urlencode(
        [
            (key, item)
            for key, item in parse_qsl(parsed.query, keep_blank_values=True)
            if key.lower() not in TRACKING_PARAMETERS
            and not key.lower().startswith(TRACKING_PARAMETER_PREFIXES)
        ],
        doseq=True,
    )
    return urlunsplit((scheme, netloc, parsed.path or "/", query, ""))


def candidate_from_result(
    title: str | None, href: str | None, description: str | None
) -> Candidate | None:
    direct_url = normalize_url(href)
    clean_title = _clean_text(title)
    if not clean_title or direct_url is None:
        return None
    return Candidate(
        title=clean_title,
        url=direct_url,
        description=_clean_text(description),
    )


class BingProvider:
    """Extract organic result cards from Bing without visiting destinations."""

    name = BING_NAME
    result_selector = BING_RESULT_SELECTOR
    result_link_selector = BING_RESULT_LINK_SELECTOR

    def search(self, page: Page, query: str, timeout_ms: int) -> None:
        page.goto(
            BING_LANDING_URL,
            wait_until=BING_LOAD_STATE,
            timeout=timeout_ms,
        )
        query_input = page.locator(BING_QUERY_INPUT_SELECTOR)
        query_input.wait_for(state=BING_INPUT_WAIT_STATE, timeout=timeout_ms)
        query_input.fill(query)
        page.locator(BING_FORM_SELECTOR).evaluate(BING_FORM_SUBMIT_SCRIPT)
        page.wait_for_url(
            lambda url: self.matches_page(url, query),
            wait_until=BING_LOAD_STATE,
            timeout=timeout_ms,
        )

    def matches_page(self, url: str, query: str) -> bool:
        try:
            parsed = urlsplit(url)
            host = (parsed.hostname or "").lower()
            parameters = parse_qs(parsed.query, keep_blank_values=True)
            query_values = parameters.get("q", [])
        except ValueError:
            return False
        return (
            parsed.scheme.lower() in HTTP_SCHEMES
            and (host == "bing.com" or host.endswith(".bing.com"))
            and parsed.path.rstrip("/") == BING_RESULT_PATH
            and len(query_values) == 1
            and _normalized_query(query_values[0]) == _normalized_query(query)
        )

    def has_challenge(self, page: Page) -> bool:
        for selector in BING_CHALLENGE_SELECTORS:
            if page.locator(selector).count():
                return True
        try:
            body = page.locator("body").text_content(timeout=ELEMENT_TIMEOUT_MS) or ""
        except PlaywrightTimeoutError:
            return False
        sample = body[:BODY_SAMPLE_CHARACTERS].casefold()
        return any(marker in sample for marker in CHALLENGE_MARKERS)

    def extract(self, page: Page, limit: int) -> Extraction:
        cards = page.locator(self.result_selector)
        candidates: list[Candidate] = []
        seen: set[str] = set()
        scanned_cards = 0
        missing_links = 0
        timed_out_links = 0
        invalid_candidates = 0
        duplicate_candidates = 0
        maximum_cards = limit * RESULT_CARD_SCAN_MULTIPLIER
        for index in range(min(cards.count(), maximum_cards)):
            if len(candidates) >= limit:
                break
            scanned_cards += 1
            card = cards.nth(index)
            link = None
            for selector in BING_LINK_SELECTORS:
                located = card.locator(selector)
                if located.count():
                    link = located.first
                    break
            if link is None:
                missing_links += 1
                continue
            try:
                title = link.text_content(timeout=ELEMENT_TIMEOUT_MS)
                href = link.get_attribute("href", timeout=ELEMENT_TIMEOUT_MS)
            except PlaywrightTimeoutError:
                timed_out_links += 1
                continue
            description = ""
            for selector in BING_SNIPPET_SELECTORS:
                snippet = card.locator(selector)
                if not snippet.count():
                    continue
                try:
                    description = snippet.first.text_content(timeout=ELEMENT_TIMEOUT_MS) or ""
                except PlaywrightTimeoutError:
                    description = ""
                if _clean_text(description):
                    break
            candidate = candidate_from_result(title, href, description)
            if candidate is None:
                invalid_candidates += 1
                continue
            if candidate.url in seen:
                duplicate_candidates += 1
                continue
            seen.add(candidate.url)
            candidates.append(candidate)
        return Extraction(
            candidates=tuple(candidates),
            diagnostics=ExtractionDiagnostics(
                scanned_cards=scanned_cards,
                accepted_candidates=len(candidates),
                missing_links=missing_links,
                timed_out_links=timed_out_links,
                invalid_candidates=invalid_candidates,
                duplicate_candidates=duplicate_candidates,
            ),
        )


_PROVIDERS: dict[str, SearchProvider] = {}


def register_provider(provider: SearchProvider) -> None:
    if provider.name in _PROVIDERS:
        raise ValueError(f"duplicate search provider: {provider.name}")
    _PROVIDERS[provider.name] = provider


def provider_names() -> tuple[str, ...]:
    return tuple(sorted(_PROVIDERS))


def get_provider(name: str) -> SearchProvider:
    try:
        return _PROVIDERS[name]
    except KeyError as exc:
        raise ValueError(f"unknown search provider: {name}") from exc


register_provider(BingProvider())
