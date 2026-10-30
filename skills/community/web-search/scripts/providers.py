"""Search-engine providers and result normalization for web-search."""

from __future__ import annotations

import base64
import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Callable, Protocol
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit

from playwright.sync_api import Page
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

BING_NAME = "bing"
BING_LANDING_URL = "https://www.bing.com"
BING_RESULT_PATH = "/search"
BING_QUERY_INPUT_SELECTOR = "#sb_form_q"
BING_SEARCH_BUTTON_SELECTOR = "#search_icon"
BING_LOAD_STATE = "domcontentloaded"
BING_INPUT_WAIT_STATE = "visible"
BING_RESULT_SELECTOR = "#b_results .b_algo"
BING_CONTAINER_SELECTOR = "#b_results"
BING_EMPTY_SELECTOR = "#b_results .b_no"
BING_BUSY_SELECTOR = '[aria-busy="true"]'
BING_LINK_SELECTORS = ("h2 a", "a.tilk")
BING_RESULT_LINK_SELECTOR = ", ".join(
    f"{BING_RESULT_SELECTOR} {selector}" for selector in BING_LINK_SELECTORS
)
BING_SNIPPET_SELECTORS = (".b_caption p", "p.b_lineclamp2", ".b_snippet", "p")
BING_RICH_SNIPPET_SELECTOR = '.b_caption [role="tabpanel"] .b_vList li span'
BING_SNAPSHOT_SNIPPET_SELECTORS = (*BING_SNIPPET_SELECTORS, BING_RICH_SNIPPET_SELECTOR)
BING_CHALLENGE_SELECTORS = ("#b_captcha", "iframe[src*='captcha']", "[id*='captcha']")
BING_RESOURCE_WAIT_SELECTOR = ", ".join((BING_CONTAINER_SELECTOR, *BING_CHALLENGE_SELECTORS))
BING_FORM_SUBMIT_SCRIPT = "input => input.form.submit()"
RESOURCE_HOME_WAIT_MS = 1_000
RESOURCE_RESULTS_WAIT_MS = 1_500
RESULT_CONTAINER_WAIT_STATE = "attached"
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
DOCUMENT_COMPLETE = "complete"
BING_SNAPSHOT_SCRIPT = """selectors => {
    const visible = element => {
        if (!element || !Array.from(element.getClientRects()).some(rect =>
            rect.width > 0 && rect.height > 0)) return false;
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || Number(style.opacity) === 0 ||
                ancestor.getAttribute('aria-hidden') === 'true') return false;
        }
        return true;
    };
    const first = (element, choices) => choices.flatMap(choice =>
        Array.from(element.querySelectorAll(choice)))
        .find(item => visible(item) && item.innerText?.trim());
    const container = document.querySelector(selectors.container);
    const rows = Array.from(document.querySelectorAll(selectors.cards)).map(card => {
        const link = selectors.links.map(selector => card.querySelector(selector)).find(Boolean);
        const snippet = first(card, selectors.snippets);
        const skipped = Array.from(card.querySelectorAll(selectors.content)).some(element =>
            element.checkVisibility && element.checkVisibility() &&
            !element.checkVisibility({contentVisibilityAuto: true}));
        return {
            visible: visible(card), linkVisible: visible(link), skipped,
            title: link?.innerText || '', href: link?.href || '',
            description: snippet?.innerText || '',
            rich: snippet?.matches(selectors.richSnippet) || false
        };
    });
    const body = document.body?.innerText || '';
    return {
        documentId: performance.timeOrigin, url: location.href,
        query: document.querySelector(selectors.input)?.value || '',
        state: document.readyState, visible: visible(container),
        busy: !!container && (Array.from(container.querySelectorAll(selectors.busy)).some(visible) ||
            !!container.closest(selectors.busy)),
        empty: Array.from(document.querySelectorAll(selectors.empty)).some(visible),
        challenged: selectors.challenges.some(selector =>
            Array.from(document.querySelectorAll(selector)).some(visible)) ||
            selectors.markers.some(marker => body.slice(0, selectors.bodyLimit)
                .toLowerCase().includes(marker)),
        rows
    };
}"""


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


@dataclass(frozen=True)
class SearchSnapshot:
    document_id: float
    url: str
    ready: bool
    empty: bool
    challenged: bool
    signature: str
    extraction: Extraction
    readiness: tuple[tuple[str, object], ...] = ()
    render_target: int | None = None


class Submission(str, Enum):
    BUTTON = "button"
    FORM = "form"


@dataclass(frozen=True)
class SearchInteraction:
    submission: Submission = Submission.BUTTON
    home_wait_ms: int = 0
    results_wait_ms: int = 0


DEFAULT_INTERACTION = SearchInteraction()
RESOURCE_INTERACTION = SearchInteraction(
    Submission.FORM, RESOURCE_HOME_WAIT_MS, RESOURCE_RESULTS_WAIT_MS
)


def _click_search(page: Page, timeout_ms: int) -> None:
    page.locator(BING_SEARCH_BUTTON_SELECTOR).click(timeout=timeout_ms)


def _submit_search(page: Page, timeout_ms: int) -> None:
    page.locator(BING_QUERY_INPUT_SELECTOR).evaluate(BING_FORM_SUBMIT_SCRIPT, timeout=timeout_ms)


SUBMISSIONS = {Submission.BUTTON: _click_search, Submission.FORM: _submit_search}


def _wait(page: Page, milliseconds: int, budget: Callable[[], int]) -> None:
    if milliseconds:
        if budget() < milliseconds:
            raise PlaywrightTimeoutError("Insufficient search budget for provider readiness wait.")
        page.wait_for_timeout(milliseconds)
        budget()


class SearchProvider(Protocol):
    """Provider contract used by the browser lifecycle."""

    name: str
    result_selector: str
    result_link_selector: str

    def search(
        self,
        page: Page,
        query: str,
        timeout_ms: int,
        *,
        remaining: Callable[[], int] | None = None,
        interaction: SearchInteraction = DEFAULT_INTERACTION,
    ) -> None: ...

    def snapshot(self, page: Page, query: str, limit: int) -> SearchSnapshot: ...

    def reveal(self, page: Page, target: int, timeout_ms: int) -> None: ...

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

    def search(
        self,
        page: Page,
        query: str,
        timeout_ms: int,
        *,
        remaining: Callable[[], int] | None = None,
        interaction: SearchInteraction = DEFAULT_INTERACTION,
    ) -> None:
        budget = remaining or (lambda: timeout_ms)
        page.goto(
            BING_LANDING_URL,
            wait_until=BING_LOAD_STATE,
            timeout=budget(),
        )
        query_input = page.locator(BING_QUERY_INPUT_SELECTOR)
        query_input.wait_for(state=BING_INPUT_WAIT_STATE, timeout=budget())
        _wait(page, interaction.home_wait_ms, budget)
        if remaining is None:
            query_input.fill(query)
        else:
            query_input.fill(query, timeout=budget())
        SUBMISSIONS[interaction.submission](page, budget())
        page.wait_for_url(
            lambda url: self.matches_page(url, query),
            wait_until=BING_LOAD_STATE,
            timeout=budget(),
        )
        if interaction.results_wait_ms:
            page.locator(BING_RESOURCE_WAIT_SELECTOR).first.wait_for(
                state=RESULT_CONTAINER_WAIT_STATE, timeout=budget()
            )
            if page.locator(BING_CONTAINER_SELECTOR).count():
                _wait(page, interaction.results_wait_ms, budget)

    def snapshot(self, page: Page, query: str, limit: int) -> SearchSnapshot:
        raw = page.evaluate(
            BING_SNAPSHOT_SCRIPT,
            {
                "container": BING_CONTAINER_SELECTOR,
                "cards": BING_RESULT_SELECTOR,
                "input": BING_QUERY_INPUT_SELECTOR,
                "links": BING_LINK_SELECTORS,
                "snippets": BING_SNAPSHOT_SNIPPET_SELECTORS,
                "richSnippet": BING_RICH_SNIPPET_SELECTOR,
                "content": ", ".join((*BING_LINK_SELECTORS, *BING_SNAPSHOT_SNIPPET_SELECTORS)),
                "empty": BING_EMPTY_SELECTOR,
                "busy": BING_BUSY_SELECTOR,
                "challenges": BING_CHALLENGE_SELECTORS,
                "markers": CHALLENGE_MARKERS,
                "bodyLimit": BODY_SAMPLE_CHARACTERS,
            },
        )
        candidates: list[Candidate] = []
        seen: set[str] = set()
        missing_links = invalid_candidates = duplicate_candidates = 0
        visible_rows = [row for row in raw["rows"] if row["visible"]]
        complete = bool(visible_rows)
        for row in raw["rows"]:
            if not row["visible"]:
                continue
            candidate = candidate_from_result(row["title"], row["href"], row["description"])
            if not row["linkVisible"]:
                complete = False
            if not row["href"]:
                missing_links += 1
                complete = False
            elif candidate is None:
                invalid_candidates += 1
                complete = False
            elif candidate.url in seen:
                duplicate_candidates += 1
            else:
                seen.add(candidate.url)
                if len(candidates) < limit:
                    candidates.append(candidate)
        empty = raw["empty"] and not visible_rows
        settled = (
            self.matches_page(raw["url"], query)
            and _normalized_query(raw["query"]) == _normalized_query(query)
            and raw["state"] == DOCUMENT_COMPLETE
            and raw["visible"]
            and not raw["busy"]
        )
        ready = settled and (complete or empty)
        skipped = [
            index for index, row in enumerate(raw["rows"]) if row["visible"] and row["skipped"]
        ]
        stable = {**raw, "rows": visible_rows}
        return SearchSnapshot(
            document_id=raw["documentId"],
            url=raw["url"],
            ready=ready,
            render_target=skipped[-1] if settled and skipped else None,
            empty=empty,
            challenged=raw["challenged"],
            signature=json.dumps(stable, ensure_ascii=True, sort_keys=True),
            readiness=tuple(
                {
                    "document_complete": raw["state"] == DOCUMENT_COMPLETE,
                    "url_matches": self.matches_page(raw["url"], query),
                    "input_matches": _normalized_query(raw["query"]) == _normalized_query(query),
                    "container_visible": raw["visible"],
                    "busy": raw["busy"],
                    "visible_cards": len(visible_rows),
                    "rich_snippets": sum(row["rich"] for row in visible_rows),
                    "incomplete_descriptions": sum(
                        not row["description"].strip() for row in visible_rows
                    ),
                    "incomplete_titles": tuple(
                        row["title"] for row in visible_rows if not row["description"].strip()
                    ),
                    "invalid_candidates": invalid_candidates,
                    "missing_links": missing_links,
                }.items()
            ),
            extraction=Extraction(
                tuple(candidates),
                ExtractionDiagnostics(
                    len(raw["rows"]),
                    len(candidates),
                    missing_links,
                    0,
                    invalid_candidates,
                    duplicate_candidates,
                ),
            ),
        )

    def reveal(self, page: Page, target: int, timeout_ms: int) -> None:
        page.locator(self.result_selector).nth(target).scroll_into_view_if_needed(
            timeout=timeout_ms
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
