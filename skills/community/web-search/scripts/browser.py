#!/usr/bin/env scholarseed-skill-python
"""Run a bounded web search in a visible, isolated local browser."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

from playwright.sync_api import (
    Browser,
    BrowserContext,
)
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import (
    Page,
    Playwright,
)
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import (
    sync_playwright,
)
from providers import Extraction, SearchProvider, get_provider, provider_names

SCHEMA = "scholarseed.web_search.v1"
PROVIDER = "visible-browser"
DEFAULT_ENGINE = "bing"
DEFAULT_BROWSER = "auto"
DEFAULT_LOCALE = "zh-CN"
DEFAULT_LIMIT = 20
MINIMUM_LIMIT = 1
MAXIMUM_LIMIT = 20
DEFAULT_TIMEOUT_SECONDS = 30
MAXIMUM_TIMEOUT_SECONDS = 60
DEFAULT_CHALLENGE_WAIT_SECONDS = 0
MAXIMUM_CHALLENGE_WAIT_SECONDS = 60
MILLISECONDS_PER_SECOND = 1_000
UTC_OFFSET = "+00:00"
UTC_SUFFIX = "Z"
TIMESTAMP_TIMESPEC = "milliseconds"
BROWSER_CHANNELS: dict[str, str | None] = {
    "chrome": "chrome",
    "msedge": "msedge",
    "chromium": None,
}
AUTOMATIC_BROWSER_ORDER = ("chrome", "msedge", "chromium")
STATUS_COMPLETED = "completed"
STATUS_EMPTY = "empty"
STATUS_ACTION_REQUIRED = "action_required"
STATUS_FAILED = "failed"
ERROR_INVALID_QUERY = "invalid_query"
ERROR_VERIFICATION_REQUIRED = "verification_required"
ERROR_EXECUTION_DENIED = "execution_denied"
ERROR_BROWSER_MISSING = "browser_missing"
ERROR_BROWSER_LAUNCH_FAILED = "browser_launch_failed"
ERROR_NAVIGATION_TIMEOUT = "navigation_timeout"
ERROR_BROWSER = "browser_error"
WAIT_STATE_ATTACHED = "attached"
RESULT_STABILITY_REQUIRED_SAMPLES = 2
RESULT_STABILITY_MAXIMUM_SAMPLES = 8
RESULT_STABILITY_INTERVAL_MS = 250
HTML_DEBUG_ENVIRONMENT = "WEB_SEARCH_HTML_DEBUG"
SCREENSHOT_DEBUG_ENVIRONMENT = "WEB_SEARCH_SCREENSHOT_DEBUG"
HTML_ENCODING = "utf-8"
EXECUTION_DENIED_MARKERS = (
    "operation not permitted",
    "permission denied",
    "sandbox",
)
BROWSER_MISSING_MARKERS = (
    "executable doesn't exist",
    "executable not found",
    "browser was not found",
)
BROWSER_LAUNCH_MESSAGES = {
    ERROR_EXECUTION_DENIED: "Local browser launch was denied by the execution environment.",
    ERROR_BROWSER_MISSING: "No supported Chrome, Edge, or Playwright Chromium executable was found.",
    ERROR_BROWSER_LAUNCH_FAILED: "Installed browser processes could not be launched.",
}


@dataclass
class BrowserSession:
    """Own and close an isolated browser context."""

    name: str
    browser: Browser
    context: BrowserContext

    def close(self) -> None:
        try:
            self.context.close()
        finally:
            self.browser.close()


@dataclass(frozen=True)
class ResultReadiness:
    """Whether precise result links appeared and stopped changing."""

    present: bool
    stable: bool
    count: int


class BrowserUnavailableError(RuntimeError):
    """None of the requested local browser channels could be launched."""

    def __init__(self, code: str, browsers: Sequence[str]) -> None:
        self.code = code
        attempted = ", ".join(browsers)
        super().__init__(f"{BROWSER_LAUNCH_MESSAGES[code]} Attempted: {attempted}.")


def bounded_integer(minimum: int, maximum: int):
    def parse(value: str) -> int:
        number = int(value)
        if not minimum <= number <= maximum:
            raise argparse.ArgumentTypeError(f"must be between {minimum} and {maximum}")
        return number

    return parse


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Search Bing through a visible isolated local browser."
    )
    parser.add_argument("--query", required=True, help="Public-web search query.")
    parser.add_argument(
        "--engine",
        choices=provider_names(),
        default=DEFAULT_ENGINE,
        help="Registered search provider (default: Bing).",
    )
    parser.add_argument(
        "--browser",
        choices=(DEFAULT_BROWSER, *BROWSER_CHANNELS),
        default=DEFAULT_BROWSER,
        help="Local browser channel; auto tries Chrome, Edge, then installed Chromium.",
    )
    parser.add_argument(
        "--limit",
        type=bounded_integer(MINIMUM_LIMIT, MAXIMUM_LIMIT),
        default=DEFAULT_LIMIT,
        help=f"Maximum candidates ({MINIMUM_LIMIT}-{MAXIMUM_LIMIT}).",
    )
    parser.add_argument("--locale", default=DEFAULT_LOCALE, help="Browser and Bing locale.")
    parser.add_argument(
        "--timeout",
        type=bounded_integer(MINIMUM_LIMIT, MAXIMUM_TIMEOUT_SECONDS),
        default=DEFAULT_TIMEOUT_SECONDS,
        metavar="SECONDS",
        help="Navigation/result timeout in seconds.",
    )
    parser.add_argument(
        "--challenge-wait",
        type=bounded_integer(DEFAULT_CHALLENGE_WAIT_SECONDS, MAXIMUM_CHALLENGE_WAIT_SECONDS),
        default=DEFAULT_CHALLENGE_WAIT_SECONDS,
        metavar="SECONDS",
        help="Time to keep the visible page open for manual challenge completion.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Diagnostic mode only; normal searches use a visible browser.",
    )
    parser.add_argument("--debug", action="store_true", help="Print safe diagnostics to stderr.")
    return parser.parse_args(argv)


def _launch_one(
    playwright: Playwright, name: str, *, locale: str, headless: bool
) -> BrowserSession:
    channel = BROWSER_CHANNELS[name]
    browser = playwright.chromium.launch(channel=channel, headless=headless)
    try:
        context = browser.new_context(locale=locale)
    except BaseException:
        browser.close()
        raise
    return BrowserSession(name=name, browser=browser, context=context)


def _launch_failure_code(error: PlaywrightError) -> str:
    normalized = str(error).lower()
    if any(marker in normalized for marker in EXECUTION_DENIED_MARKERS):
        return ERROR_EXECUTION_DENIED
    if any(marker in normalized for marker in BROWSER_MISSING_MARKERS):
        return ERROR_BROWSER_MISSING
    return ERROR_BROWSER_LAUNCH_FAILED


def launch_browser(
    playwright: Playwright, requested: str, *, locale: str, headless: bool, debug: bool
) -> BrowserSession:
    names = AUTOMATIC_BROWSER_ORDER if requested == DEFAULT_BROWSER else (requested,)
    failures: list[tuple[str, str]] = []
    for name in names:
        try:
            return _launch_one(playwright, name, locale=locale, headless=headless)
        except PlaywrightError as exc:
            code = _launch_failure_code(exc)
            failures.append((name, code))
            if debug:
                print(f"browser-search: {name} launch failed: {code}", file=sys.stderr)
    codes = {code for _name, code in failures}
    if ERROR_EXECUTION_DENIED in codes:
        failure_code = ERROR_EXECUTION_DENIED
    elif codes == {ERROR_BROWSER_MISSING}:
        failure_code = ERROR_BROWSER_MISSING
    else:
        failure_code = ERROR_BROWSER_LAUNCH_FAILED
    raise BrowserUnavailableError(failure_code, [name for name, _code in failures])


def _error(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def _utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec=TIMESTAMP_TIMESPEC)
        .replace(UTC_OFFSET, UTC_SUFFIX)
    )


def _payload(
    *,
    started_at: str,
    started_tick: float,
    status: str,
    query: str,
    engine: str,
    browser: str | None,
    candidates: list[dict[str, str]],
    error: dict[str, str] | None,
) -> dict[str, Any]:
    completed_at = _utc_timestamp()
    duration_ms = max(0, round((monotonic() - started_tick) * MILLISECONDS_PER_SECOND))
    return {
        "schema": SCHEMA,
        "status": status,
        "provider": PROVIDER,
        "query": query,
        "engine": engine,
        "browser": browser,
        "started_at": started_at,
        "completed_at": completed_at,
        "duration_ms": duration_ms,
        "candidates": candidates,
        "error": error,
    }


def _failure(
    *,
    started_at: str,
    started_tick: float,
    query: str,
    engine: str,
    browser: str | None,
    code: str,
    message: str,
    status: str = STATUS_FAILED,
    exit_code: int = 1,
) -> tuple[dict[str, Any], int]:
    return (
        _payload(
            started_at=started_at,
            started_tick=started_tick,
            status=status,
            query=query,
            engine=engine,
            browser=browser,
            candidates=[],
            error=_error(code, message),
        ),
        exit_code,
    )


def _wait_for_results(page: Page, provider: SearchProvider, timeout_ms: int) -> ResultReadiness:
    links = page.locator(provider.result_link_selector)
    try:
        links.first.wait_for(state=WAIT_STATE_ATTACHED, timeout=timeout_ms)
    except PlaywrightTimeoutError:
        return ResultReadiness(present=False, stable=False, count=0)

    previous_count: int | None = None
    matching_samples = 0
    current_count = 0
    for sample in range(RESULT_STABILITY_MAXIMUM_SAMPLES):
        current_count = links.count()
        if current_count > 0 and current_count == previous_count:
            matching_samples += 1
        else:
            matching_samples = 1 if current_count > 0 else 0
        if matching_samples >= RESULT_STABILITY_REQUIRED_SAMPLES:
            return ResultReadiness(present=True, stable=True, count=current_count)
        previous_count = current_count
        if sample + 1 < RESULT_STABILITY_MAXIMUM_SAMPLES:
            page.wait_for_timeout(RESULT_STABILITY_INTERVAL_MS)
    return ResultReadiness(present=True, stable=False, count=current_count)


def _page_identity(url: str) -> dict[str, str]:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return {"host": "", "path": ""}
    return {"host": (parsed.hostname or "").lower(), "path": parsed.path}


def _write_html_debug(page: Page, environment: Mapping[str, str]) -> str | None:
    target = environment.get(HTML_DEBUG_ENVIRONMENT, "").strip()
    if not target:
        return None
    try:
        Path(target).expanduser().write_text(page.content(), encoding=HTML_ENCODING)
    except (OSError, PlaywrightError):
        return "failed"
    return "written"


def _write_screenshot_debug(page: Page, environment: Mapping[str, str]) -> str | None:
    target = environment.get(SCREENSHOT_DEBUG_ENVIRONMENT, "").strip()
    if not target:
        return None
    try:
        page.screenshot(path=str(Path(target).expanduser()), full_page=True)
    except (OSError, PlaywrightError):
        return "failed"
    return "written"


def _debug_result(
    *,
    enabled: bool,
    page: Page,
    readiness: ResultReadiness,
    extraction: Extraction | None = None,
    html_debug: str | None = None,
    screenshot_debug: str | None = None,
) -> None:
    if not enabled:
        return
    diagnostic: dict[str, Any] = {
        "event": "browser_search_result",
        "page": _page_identity(page.url),
        "result_links": readiness.count,
        "result_links_present": readiness.present,
        "result_links_stable": readiness.stable,
    }
    if extraction is not None:
        diagnostic["extraction"] = extraction.diagnostics.to_dict()
    if html_debug is not None:
        diagnostic["html_debug"] = html_debug
    if screenshot_debug is not None:
        diagnostic["screenshot_debug"] = screenshot_debug
    print(json.dumps(diagnostic, ensure_ascii=True, sort_keys=True), file=sys.stderr)


def search(args: argparse.Namespace) -> tuple[dict[str, Any], int]:
    started_at = _utc_timestamp()
    started_tick = monotonic()
    query = args.query.strip()
    if not query:
        return (
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query="",
                engine=args.engine,
                browser=None,
                candidates=[],
                error=_error(ERROR_INVALID_QUERY, "Search query cannot be empty."),
            ),
            1,
        )
    provider = get_provider(args.engine)
    timeout_ms = args.timeout * MILLISECONDS_PER_SECOND
    selected_browser: str | None = None
    try:
        with sync_playwright() as playwright:
            session = launch_browser(
                playwright,
                args.browser,
                locale=args.locale,
                headless=args.headless,
                debug=args.debug,
            )
            selected_browser = session.name
            try:
                page = session.context.new_page()
                provider.search(page, query, timeout_ms)
                if not provider.matches_page(page.url, query):
                    html_debug = _write_html_debug(page, os.environ)
                    screenshot_debug = _write_screenshot_debug(page, os.environ)
                    _debug_result(
                        enabled=args.debug,
                        page=page,
                        readiness=ResultReadiness(False, False, 0),
                        html_debug=html_debug,
                        screenshot_debug=screenshot_debug,
                    )
                    return _failure(
                        started_at=started_at,
                        started_tick=started_tick,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        code=ERROR_BROWSER,
                        message="Bing did not remain on the requested search page.",
                    )
                readiness = _wait_for_results(page, provider, timeout_ms)
                if not readiness.present and provider.has_challenge(page) and args.challenge_wait:
                    print(
                        "browser-search: complete Bing's visible verification if appropriate.",
                        file=sys.stderr,
                    )
                    readiness = _wait_for_results(
                        page,
                        provider,
                        args.challenge_wait * MILLISECONDS_PER_SECOND,
                    )
                html_debug = _write_html_debug(page, os.environ)
                screenshot_debug = _write_screenshot_debug(page, os.environ)
                if not provider.matches_page(page.url, query):
                    _debug_result(
                        enabled=args.debug,
                        page=page,
                        readiness=readiness,
                        html_debug=html_debug,
                        screenshot_debug=screenshot_debug,
                    )
                    return _failure(
                        started_at=started_at,
                        started_tick=started_tick,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        code=ERROR_BROWSER,
                        message="Bing changed away from the requested search page.",
                    )
                if not readiness.present and provider.has_challenge(page):
                    _debug_result(
                        enabled=args.debug,
                        page=page,
                        readiness=readiness,
                        html_debug=html_debug,
                        screenshot_debug=screenshot_debug,
                    )
                    return _failure(
                        started_at=started_at,
                        started_tick=started_tick,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        code=ERROR_VERIFICATION_REQUIRED,
                        message="Bing requires manual verification in the visible browser.",
                        status=STATUS_ACTION_REQUIRED,
                        exit_code=2,
                    )
                if readiness.present and not readiness.stable:
                    _debug_result(
                        enabled=args.debug,
                        page=page,
                        readiness=readiness,
                        html_debug=html_debug,
                        screenshot_debug=screenshot_debug,
                    )
                    return _failure(
                        started_at=started_at,
                        started_tick=started_tick,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        code=ERROR_NAVIGATION_TIMEOUT,
                        message="Bing results did not become stable before extraction.",
                    )
                extraction = provider.extract(page, args.limit)
                if not provider.matches_page(page.url, query):
                    _debug_result(
                        enabled=args.debug,
                        page=page,
                        readiness=readiness,
                        extraction=extraction,
                        html_debug=html_debug,
                        screenshot_debug=screenshot_debug,
                    )
                    return _failure(
                        started_at=started_at,
                        started_tick=started_tick,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        code=ERROR_BROWSER,
                        message="Bing changed pages while extracting search results.",
                    )
                _debug_result(
                    enabled=args.debug,
                    page=page,
                    readiness=readiness,
                    extraction=extraction,
                    html_debug=html_debug,
                    screenshot_debug=screenshot_debug,
                )
                candidates = [item.to_dict() for item in extraction.candidates]
                return (
                    _payload(
                        started_at=started_at,
                        started_tick=started_tick,
                        status=STATUS_COMPLETED if candidates else STATUS_EMPTY,
                        query=query,
                        engine=provider.name,
                        browser=selected_browser,
                        candidates=candidates,
                        error=None,
                    ),
                    0,
                )
            finally:
                session.close()
    except BrowserUnavailableError as exc:
        return (
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                engine=provider.name,
                browser=selected_browser,
                candidates=[],
                error=_error(exc.code, str(exc)),
            ),
            1,
        )
    except PlaywrightTimeoutError:
        return (
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                engine=provider.name,
                browser=selected_browser,
                candidates=[],
                error=_error(
                    ERROR_NAVIGATION_TIMEOUT,
                    "Bing did not finish loading before timeout.",
                ),
            ),
            1,
        )
    except PlaywrightError as exc:
        if args.debug:
            print(f"browser-search: Playwright failed: {type(exc).__name__}", file=sys.stderr)
        return (
            _payload(
                started_at=started_at,
                started_tick=started_tick,
                status=STATUS_FAILED,
                query=query,
                engine=provider.name,
                browser=selected_browser,
                candidates=[],
                error=_error(ERROR_BROWSER, "The local browser search session failed."),
            ),
            1,
        )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    payload, exit_code = search(args)
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
