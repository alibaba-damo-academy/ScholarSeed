"""Deterministic contract tests for the unified web-search Skill."""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode

import smoke
from browser import (
    DEFAULT_LIMIT,
    ERROR_BROWSER_LAUNCH_FAILED,
    ERROR_BROWSER_MISSING,
    ERROR_EXECUTION_DENIED,
    ERROR_INVALID_QUERY,
    MAXIMUM_LIMIT,
    SCHEMA,
    BrowserUnavailableError,
    _wait_for_results,
    _write_html_debug,
    _write_screenshot_debug,
    launch_browser,
    parse_args,
    search,
)
from invoke import BRIDGE_COMMAND, OUTPUT_PATH, publish
from official import (
    API_HOST,
    API_PATH,
    API_URL,
    ERROR_CREDENTIAL_UNAVAILABLE,
    ERROR_REQUEST,
    ERROR_RESPONSE,
)
from official import PROVIDER as OFFICIAL_PROVIDER
from official import parse_args as parse_official_args
from official import search as official_search
from playwright.sync_api import Error as PlaywrightError
from providers import (
    BING_FORM_SELECTOR,
    BING_FORM_SUBMIT_SCRIPT,
    BING_LANDING_URL,
    BING_QUERY_INPUT_SELECTOR,
    BingProvider,
    candidate_from_result,
    normalize_url,
)
from smoke import EXIT_FAILURE, EXIT_SUCCESS, EXIT_USAGE
from smoke import main as smoke_main


class FakeSearchInput:
    def __init__(self) -> None:
        self.waited = False
        self.value = ""

    def wait_for(self, *, state: str, timeout: int) -> None:
        self.waited = state == "visible" and timeout > 0

    def fill(self, value: str) -> None:
        self.value = value


class FakeSearchForm:
    def __init__(self) -> None:
        self.script = ""

    def evaluate(self, script: str) -> None:
        self.script = script


class FakeSearchPage:
    def __init__(self, result_url: str) -> None:
        self.result_url = result_url
        self.query_input = FakeSearchInput()
        self.form = FakeSearchForm()
        self.goto_call: tuple[str, str, int] | None = None
        self.waited_for_url = False

    def goto(self, url: str, *, wait_until: str, timeout: int) -> None:
        self.goto_call = (url, wait_until, timeout)

    def locator(self, selector: str):
        if selector == BING_QUERY_INPUT_SELECTOR:
            return self.query_input
        if selector == BING_FORM_SELECTOR:
            return self.form
        raise AssertionError(f"unexpected selector: {selector}")

    def wait_for_url(self, predicate, *, wait_until: str, timeout: int) -> None:
        self.waited_for_url = predicate(self.result_url) and wait_until == "domcontentloaded"
        if timeout <= 0 or not self.waited_for_url:
            raise AssertionError("result URL did not match the submitted query")


class FakeResultLocator:
    def __init__(self, counts: list[int]) -> None:
        self._counts = iter(counts)
        self._last = 0
        self.waited = False

    @property
    def first(self):
        return self

    def wait_for(self, *, state: str, timeout: int) -> None:
        self.waited = state == "attached" and timeout > 0

    def count(self) -> int:
        self._last = next(self._counts, self._last)
        return self._last


class FakeResultPage:
    def __init__(self, counts: list[int]) -> None:
        self.results = FakeResultLocator(counts)
        self.waits: list[int] = []

    def locator(self, selector: str) -> FakeResultLocator:
        self.selector = selector
        return self.results

    def wait_for_timeout(self, timeout: int) -> None:
        self.waits.append(timeout)


class FakeElement:
    def __init__(self, *, text: str | None = None, href: str | None = None) -> None:
        self._text = text
        self._href = href

    @property
    def first(self):
        return self

    def count(self) -> int:
        return 1

    def text_content(self, *, timeout: int) -> str | None:
        del timeout
        return self._text

    def get_attribute(self, name: str, *, timeout: int) -> str | None:
        del timeout
        return self._href if name == "href" else None


class FakeCard:
    def __init__(self, title: str | None, href: str | None, description: str = "") -> None:
        self._link = FakeElement(text=title, href=href) if href is not None else None
        self._snippet = FakeElement(text=description) if description else None

    def locator(self, selector: str):
        if selector in ("h2 a", "a.tilk"):
            return self._link or FakeMissingElement()
        return self._snippet or FakeMissingElement()


class FakeMissingElement:
    def count(self) -> int:
        return 0


class FakeCards:
    def __init__(self, cards: list[FakeCard]) -> None:
        self._cards = cards

    def count(self) -> int:
        return len(self._cards)

    def nth(self, index: int) -> FakeCard:
        return self._cards[index]


class FakeExtractionPage:
    def __init__(self, cards: list[FakeCard]) -> None:
        self._cards = FakeCards(cards)

    def locator(self, selector: str) -> FakeCards:
        self.selector = selector
        return self._cards


class FakeHtmlPage:
    def __init__(self, content: str) -> None:
        self._content = content
        self.calls = 0

    def content(self) -> str:
        self.calls += 1
        return self._content


class FakeScreenshotPage:
    def __init__(self) -> None:
        self.calls: list[tuple[str, bool]] = []

    def screenshot(self, *, path: str, full_page: bool) -> None:
        self.calls.append((path, full_page))


class FakeResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self.reason = "Test response"
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self, _limit: int) -> bytes:
        return self._payload

    def getheaders(self) -> list[tuple[str, str]]:
        return [("Content-Type", "application/json"), ("X-Request-Id", "test-request")]


class FakeConnection:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.request_args: tuple | None = None
        self.closed = False

    def request(self, *args, **kwargs) -> None:
        self.request_args = (args, kwargs)

    def getresponse(self) -> FakeResponse:
        return self.response

    def close(self) -> None:
        self.closed = True


class BrowserSearchContractTest(unittest.TestCase):
    def test_default_and_maximum_candidate_limit_are_twenty(self) -> None:
        self.assertEqual(DEFAULT_LIMIT, 20)
        self.assertEqual(MAXIMUM_LIMIT, 20)
        defaults = parse_args(["--query", "test"])
        self.assertEqual(defaults.limit, 20)
        self.assertFalse(defaults.headless)
        self.assertEqual(parse_args(["--query", "test", "--limit", "20"]).limit, 20)
        with self.assertRaises(SystemExit):
            parse_args(["--query", "test", "--limit", "21"])

    def test_browser_launch_failures_keep_safe_distinct_reasons(self) -> None:
        class FailingChromium:
            def __init__(self, messages: dict[str, str]) -> None:
                self.messages = messages

            def launch(self, *, channel: str | None, headless: bool):
                del headless
                name = channel or "chromium"
                raise PlaywrightError(self.messages[name])

        cases = (
            (
                {
                    "chrome": "Executable doesn't exist",
                    "msedge": "Executable not found",
                    "chromium": "Browser was not found",
                },
                ERROR_BROWSER_MISSING,
            ),
            (
                {
                    "chrome": "Operation not permitted",
                    "msedge": "Executable not found",
                    "chromium": "Executable not found",
                },
                ERROR_EXECUTION_DENIED,
            ),
            (
                {
                    "chrome": "Target page, context or browser has been closed",
                    "msedge": "Executable not found",
                    "chromium": "Executable not found",
                },
                ERROR_BROWSER_LAUNCH_FAILED,
            ),
        )
        for messages, expected in cases:
            with self.subTest(expected=expected):
                playwright = SimpleNamespace(chromium=FailingChromium(messages))
                with self.assertRaises(BrowserUnavailableError) as caught:
                    launch_browser(
                        playwright,
                        "auto",
                        locale="zh-CN",
                        headless=True,
                        debug=False,
                    )
                self.assertEqual(caught.exception.code, expected)
                self.assertNotIn("Target page", str(caught.exception))

    def test_bing_opens_landing_page_and_submits_exact_query(self) -> None:
        provider = BingProvider()
        query = "本机 browser search"
        page = FakeSearchPage(f"https://cn.bing.com/search?{urlencode({'q': query})}")

        provider.search(page, query, 1_000)

        self.assertEqual(page.goto_call, (BING_LANDING_URL, "domcontentloaded", 1_000))
        self.assertTrue(page.query_input.waited)
        self.assertEqual(page.query_input.value, query)
        self.assertEqual(page.form.script, BING_FORM_SUBMIT_SCRIPT)
        self.assertTrue(page.waited_for_url)
        self.assertEqual(provider.result_selector, "#b_results .b_algo")

    def test_bing_page_identity_requires_same_search_query(self) -> None:
        provider = BingProvider()
        self.assertTrue(
            provider.matches_page(
                "https://cn.bing.com/search?q=%E6%9C%AC%E6%9C%BA+Browser+Search&form=QBLH",
                " 本机  browser search ",
            )
        )
        self.assertFalse(provider.matches_page("https://www.bing.com/", "browser search"))
        self.assertFalse(
            provider.matches_page("https://www.bing.com/search?q=unrelated", "browser search")
        )

    def test_result_wait_requires_precise_links_and_stable_count(self) -> None:
        provider = BingProvider()
        stable_page = FakeResultPage([2, 2])
        readiness = _wait_for_results(stable_page, provider, 1_000)
        self.assertTrue(readiness.present)
        self.assertTrue(readiness.stable)
        self.assertEqual(readiness.count, 2)
        self.assertTrue(stable_page.results.waited)
        self.assertEqual(stable_page.selector, provider.result_link_selector)

        unstable_page = FakeResultPage([1, 2, 3, 4, 5, 6, 7, 8])
        readiness = _wait_for_results(unstable_page, provider, 1_000)
        self.assertTrue(readiness.present)
        self.assertFalse(readiness.stable)
        self.assertEqual(readiness.count, 8)

    def test_bing_extraction_reports_rejected_and_duplicate_cards(self) -> None:
        provider = BingProvider()
        page = FakeExtractionPage(
            [
                FakeCard("missing", None),
                FakeCard("Example", "https://example.com", "snippet"),
                FakeCard("", "https://invalid.example", "invalid title"),
                FakeCard("Duplicate", "https://example.com", "duplicate"),
            ]
        )
        extraction = provider.extract(page, 20)
        self.assertEqual([item.url for item in extraction.candidates], ["https://example.com/"])
        self.assertEqual(
            extraction.diagnostics.to_dict(),
            {
                "scanned_cards": 4,
                "accepted_candidates": 1,
                "missing_links": 1,
                "timed_out_links": 0,
                "invalid_candidates": 1,
                "duplicate_candidates": 1,
            },
        )

    def test_html_debug_dump_requires_explicit_environment_path(self) -> None:
        page = FakeHtmlPage("<html><body>Bing result</body></html>")
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "bing.html"
            self.assertIsNone(_write_html_debug(page, {}))
            self.assertFalse(target.exists())
            self.assertEqual(
                _write_html_debug(page, {"WEB_SEARCH_HTML_DEBUG": str(target)}),
                "written",
            )
            self.assertEqual(target.read_text(encoding="utf-8"), page._content)
        self.assertEqual(page.calls, 1)

    def test_screenshot_debug_requires_explicit_environment_path(self) -> None:
        page = FakeScreenshotPage()
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "bing.png"
            self.assertIsNone(_write_screenshot_debug(page, {}))
            self.assertEqual(
                _write_screenshot_debug(page, {"WEB_SEARCH_SCREENSHOT_DEBUG": str(target)}),
                "written",
            )
        self.assertEqual(page.calls, [(str(target), True)])

    def test_normalization_removes_tracking_and_fragment(self) -> None:
        self.assertEqual(
            normalize_url("HTTPS://Example.COM:443/a?utm_source=bing&id=2&msclkid=x#part"),
            "https://example.com/a?id=2",
        )

    def test_bing_redirect_decodes_direct_destination(self) -> None:
        target = "https://example.com/docs?q=browser"
        encoded = base64.urlsafe_b64encode(target.encode("utf-8")).decode("ascii").rstrip("=")
        self.assertEqual(
            normalize_url(f"https://www.bing.com/ck/a?u=a1{encoded}"),
            target,
        )

    def test_search_and_non_http_urls_are_rejected(self) -> None:
        self.assertIsNone(normalize_url("https://www.bing.com/search?q=loop"))
        self.assertIsNone(normalize_url("javascript:alert(1)"))

    def test_candidate_requires_real_title_and_destination(self) -> None:
        self.assertIsNone(candidate_from_result("", "https://example.com", "snippet"))
        self.assertIsNone(candidate_from_result("Example", None, "snippet"))
        self.assertEqual(
            candidate_from_result(
                "  Example   title ", "https://example.com", " Search   snippet "
            ).to_dict(),
            {
                "title": "Example title",
                "url": "https://example.com/",
                "description": "Search snippet",
            },
        )

    def test_empty_query_fails_without_launching_browser(self) -> None:
        payload, exit_code = search(parse_args(["--query", "   "]))
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["schema"], SCHEMA)
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["error"]["code"], ERROR_INVALID_QUERY)
        self.assertEqual(payload["candidates"], [])
        started_at = datetime.fromisoformat(payload["started_at"].replace("Z", "+00:00"))
        completed_at = datetime.fromisoformat(payload["completed_at"].replace("Z", "+00:00"))
        self.assertLessEqual(started_at, completed_at)
        self.assertGreaterEqual(payload["duration_ms"], 0)

    def test_official_search_skips_network_without_api_key(self) -> None:
        called = False

        def connection_factory(*_args, **_kwargs):
            nonlocal called
            called = True
            raise AssertionError("network must not be called")

        payload, exit_code = official_search(
            parse_official_args(["--query", "test"]),
            environment={},
            connection_factory=connection_factory,
        )

        self.assertEqual(exit_code, 0)
        self.assertFalse(called)
        self.assertEqual(payload["provider"], OFFICIAL_PROVIDER)
        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["error"]["code"], ERROR_CREDENTIAL_UNAVAILABLE)

    def test_official_search_posts_bearer_request_and_normalizes_results(self) -> None:
        self.assertEqual(
            API_URL,
            "https://scholarseed.damo.alibaba.com/paperhub/generalsearch/",
        )
        connection = FakeConnection(
            FakeResponse(
                200,
                {
                    "success": True,
                    "data": [
                        {
                            "title": " Example ",
                            "url": "https://example.com/?utm_source=official",
                            "brief": " Search result ",
                        }
                    ],
                },
            )
        )

        payload, exit_code = official_search(
            parse_official_args(["--query", "test", "--limit", "2"]),
            environment={"SCHOLARSEED_API_KEY": "secret"},
            connection_factory=lambda host, timeout: (
                connection
                if host == API_HOST and timeout > 0
                else (_ for _ in ()).throw(AssertionError("invalid connection"))
            ),
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(
            payload["candidates"],
            [
                {
                    "title": "Example",
                    "url": "https://example.com/",
                    "description": "Search result",
                }
            ],
        )
        args, kwargs = connection.request_args
        self.assertEqual(args[:2], ("POST", API_PATH))
        self.assertEqual(kwargs["headers"]["Authorization"], "Bearer secret")
        self.assertNotIn(b"secret", kwargs["body"])
        self.assertEqual(json.loads(kwargs["body"]), {"q": "test", "num": 2})
        self.assertTrue(connection.closed)

    def test_official_search_logs_safe_transport_failure_diagnostics(self) -> None:
        api_key = "secret-api-key"
        query = "private diagnostic query"

        class FailingConnection:
            closed = False

            def request(self, *_args, **_kwargs) -> None:
                raise TimeoutError("sensitive upstream timeout detail")

            def close(self) -> None:
                self.closed = True

        connection = FailingConnection()
        with self.assertLogs("scholarseed.web_search.official", level="INFO") as captured:
            payload, exit_code = official_search(
                parse_official_args(["--query", query]),
                environment={"SCHOLARSEED_API_KEY": api_key},
                connection_factory=lambda _host, timeout: (
                    connection
                    if timeout > 0
                    else (_ for _ in ()).throw(AssertionError("invalid timeout"))
                ),
            )

        diagnostics = "\n".join(captured.output)
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["error"]["code"], ERROR_REQUEST)
        self.assertEqual(
            payload["diagnostics"],
            {"phase": "request", "error_type": "TimeoutError"},
        )
        self.assertTrue(connection.closed)
        self.assertIn('"event": "official_search_request_failed"', diagnostics)
        self.assertIn('"error_type": "TimeoutError"', diagnostics)
        self.assertIn('"status": "failed"', diagnostics)
        self.assertNotIn(api_key, diagnostics)
        self.assertNotIn(query, diagnostics)
        self.assertNotIn("sensitive upstream timeout detail", diagnostics)

    def test_official_search_logs_safe_http_failure_diagnostics(self) -> None:
        api_key = "secret-api-key"
        query = "private diagnostic query"
        connection = FakeConnection(FakeResponse(503, {"message": f"do not log {api_key}"}))

        with self.assertLogs("scholarseed.web_search.official", level="INFO") as captured:
            payload, exit_code = official_search(
                parse_official_args(["--query", query]),
                environment={"SCHOLARSEED_API_KEY": api_key},
                connection_factory=lambda _host, timeout: (
                    connection
                    if timeout > 0
                    else (_ for _ in ()).throw(AssertionError("invalid timeout"))
                ),
            )

        diagnostics = "\n".join(captured.output)
        self.assertEqual(exit_code, 1)
        self.assertEqual(payload["error"]["code"], ERROR_RESPONSE)
        self.assertEqual(
            payload["diagnostics"],
            {
                "phase": "response",
                "upstream_http_status": 503,
                "response_bytes": len(connection.response._payload),
                "response_oversized": False,
            },
        )
        self.assertIn('"http_status": 503', diagnostics)
        self.assertIn('"response_bytes":', diagnostics)
        self.assertNotIn(api_key, diagnostics)
        self.assertNotIn(query, diagnostics)

    def test_official_smoke_requires_credential_without_interactive_prompt(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            exit_code = smoke_main(
                ["--query", "test"],
                environment={},
                interactive=False,
            )

        self.assertEqual(exit_code, EXIT_USAGE)
        self.assertIn("SCHOLARSEED_API_KEY is missing", stderr.getvalue())

    def test_official_smoke_hides_prompted_credential(self) -> None:
        stdout = io.StringIO()
        prompted: list[str] = []
        original_search = official_search

        def search(args, *, environment, connection_factory=None):
            del args, connection_factory
            prompted.append(environment["SCHOLARSEED_API_KEY"])
            return ({"status": "completed", "candidates": []}, EXIT_SUCCESS)

        smoke.official.search = search
        try:
            with redirect_stdout(stdout):
                exit_code = smoke_main(
                    ["--query", "test"],
                    environment={},
                    interactive=True,
                    prompt=lambda _message: "secret-smoke-key",
                )
        finally:
            smoke.official.search = original_search

        self.assertEqual(exit_code, EXIT_SUCCESS)
        self.assertEqual(prompted, ["secret-smoke-key"])
        self.assertNotIn("secret-smoke-key", stdout.getvalue())

    def test_official_smoke_debug_reports_response_without_leaking_credential(self) -> None:
        api_key = "secret-smoke-key"
        connection = FakeConnection(
            FakeResponse(
                200,
                {
                    "success": False,
                    "code": "unexpected_schema",
                    "message": f"diagnostic {api_key}",
                },
            )
        )
        connection.response.reason = f"diagnostic {api_key}"
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = smoke_main(
                ["--query", "test", "--debug"],
                environment={"SCHOLARSEED_API_KEY": api_key},
                interactive=False,
                connection_factory=lambda host, timeout: connection,
            )

        self.assertEqual(exit_code, EXIT_FAILURE)
        self.assertIn("official_api_response_invalid", stdout.getvalue())
        self.assertIn('"status": 200', stderr.getvalue())
        self.assertIn("unexpected_schema", stderr.getvalue())
        self.assertIn("<redacted>", stderr.getvalue())
        self.assertNotIn(api_key, stdout.getvalue())
        self.assertNotIn(api_key, stderr.getvalue())

    def test_invocation_publishes_exact_structured_artifact(self) -> None:
        payload = {"schema": "scholarseed.web_search.v1", "status": "failed"}
        calls: list[tuple] = []

        def runner(*args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            previous = Path.cwd()
            try:
                os.chdir(root)
                self.assertEqual(
                    publish(payload, runner=runner, bridge_command=BRIDGE_COMMAND), 0
                )
            finally:
                os.chdir(previous)
            self.assertEqual(json.loads((root / OUTPUT_PATH).read_text(encoding="utf-8")), payload)
        self.assertEqual(calls[0][0][0][:2], [BRIDGE_COMMAND, "artifact"])


if __name__ == "__main__":
    unittest.main()
