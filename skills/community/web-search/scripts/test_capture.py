"""Deterministic capture and local DOM contracts, not product acceptance."""

from __future__ import annotations

import unittest
from dataclasses import replace
from time import monotonic
from unittest.mock import patch

from browser import launch_browser, parse_args
from capture import ResultPolicy, capture, remaining_ms
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from providers import BingProvider, Candidate, Extraction, ExtractionDiagnostics, SearchSnapshot

QUERY = "attention"
SEARCH_URL = "https://www.bing.com/search?q=attention"
CARD = '<li class="b_algo"><h2><a href="https://example.com/paper">Paper</a></h2><div class="b_caption"><p>Real snippet</p></div></li>'


def snapshot(**overrides) -> SearchSnapshot:
    return replace(
        SearchSnapshot(
            document_id=1.0,
            url=SEARCH_URL,
            ready=True,
            empty=False,
            challenged=False,
            signature="document-1-results",
            extraction=Extraction(
                (Candidate("Paper", "https://example.com/paper", "Real snippet"),),
                ExtractionDiagnostics(1, 1, 0, 0, 0, 0),
            ),
        ),
        **overrides,
    )


class CaptureClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.waits = []

    def monotonic(self) -> float:
        return self.now

    def wait_for_timeout(self, milliseconds: int) -> None:
        self.waits.append(milliseconds)
        self.now += milliseconds / 1_000


class SequenceProvider:
    def __init__(self, values) -> None:
        self.values = list(values)
        self.calls = 0
        self.reveal_calls = []

    def snapshot(self, _page, _query, _limit) -> SearchSnapshot:
        value = self.values[min(self.calls, len(self.values) - 1)]
        self.calls += 1
        if isinstance(value, Exception):
            raise value
        return value

    def reveal(self, _page, target: int, timeout_ms: int) -> None:
        self.reveal_calls.append((self.calls, target, timeout_ms))


class CaptureContract(unittest.TestCase):
    def run_capture(self, values, *, deadline=5):
        clock = CaptureClock()
        provider = SequenceProvider(values)
        with patch("capture.monotonic", clock.monotonic):
            result = capture(clock, provider, QUERY, 10, deadline=deadline)
        return result, provider, clock

    def test_two_identical_atomic_snapshots_are_required(self) -> None:
        result, provider, clock = self.run_capture([snapshot()])
        self.assertEqual(provider.calls, 2)
        self.assertEqual(result.samples, 2)
        self.assertEqual(clock.waits, [250])
        self.assertEqual(result.diagnostics()["policy"], ResultPolicy.VISIBLE_SNAPSHOT.value)

    def test_nonready_sample_resets_stability(self) -> None:
        result, provider, _clock = self.run_capture(
            [snapshot(), snapshot(ready=False), snapshot(), snapshot()]
        )
        self.assertEqual(provider.calls, 4)
        self.assertEqual(result.samples, 4)

    def test_document_change_resets_stability(self) -> None:
        result, provider, _clock = self.run_capture(
            [
                snapshot(),
                snapshot(document_id=2.0, signature="document-2-results"),
                snapshot(document_id=2.0, signature="document-2-results"),
            ]
        )
        self.assertEqual(provider.calls, 3)
        self.assertEqual(result.document_changes, 1)
        self.assertEqual(result.snapshot.document_id, 2.0)

    def test_same_document_render_target_is_revealed_only_once(self) -> None:
        result, provider, _clock = self.run_capture(
            [
                snapshot(ready=False, render_target=3),
                snapshot(ready=False, render_target=3),
                snapshot(),
                snapshot(),
            ]
        )
        self.assertEqual(provider.reveal_calls, [(1, 3, 5000)])
        self.assertEqual(result.render_actions, 1)
        self.assertEqual(result.diagnostics()["render_actions"], 1)
        self.assertEqual(result.samples, 4)

    def test_new_document_may_reveal_same_target_with_remaining_budget(self) -> None:
        result, provider, _clock = self.run_capture(
            [
                snapshot(ready=False, render_target=2),
                snapshot(ready=False, render_target=2),
                snapshot(document_id=2.0, ready=False, render_target=2),
                snapshot(document_id=2.0, signature="document-2-ready"),
                snapshot(document_id=2.0, signature="document-2-ready"),
            ],
            deadline=2,
        )
        self.assertEqual(provider.reveal_calls, [(1, 2, 2000), (3, 2, 1500)])
        self.assertEqual(result.render_actions, 2)
        self.assertEqual(result.document_changes, 1)

    def test_render_action_resets_already_ready_stability(self) -> None:
        result, provider, _clock = self.run_capture(
            [snapshot(), snapshot(render_target=3), snapshot(), snapshot()]
        )
        self.assertEqual(provider.reveal_calls, [(2, 3, 4750)])
        self.assertEqual(result.samples, 4)
        self.assertEqual(result.render_actions, 1)

    def test_ready_snapshot_with_persistent_render_target_does_not_loop(self) -> None:
        result, provider, _clock = self.run_capture([snapshot(render_target=3)])
        self.assertEqual(provider.reveal_calls, [(1, 3, 5000)])
        self.assertEqual(result.samples, 3)

    def test_challenged_snapshot_never_triggers_render_action(self) -> None:
        result, provider, _clock = self.run_capture(
            [snapshot(ready=False, challenged=True, render_target=3)]
        )
        self.assertEqual(provider.reveal_calls, [])
        self.assertEqual(result.render_actions, 0)

    def test_navigation_context_destruction_is_retryable_and_resets_stability(self) -> None:
        for message in ("Execution context was destroyed", "Cannot find context with specified id"):
            with self.subTest(message=message):
                result, provider, _clock = self.run_capture(
                    [snapshot(), PlaywrightError(message), snapshot(), snapshot()]
                )
                self.assertEqual(provider.calls, 4)
                self.assertEqual(result.samples, 3)

    def test_other_browser_errors_propagate(self) -> None:
        with self.assertRaisesRegex(PlaywrightError, "Target closed"):
            self.run_capture([PlaywrightError("Target closed")])

    def test_challenge_returns_immediately_without_claiming_empty(self) -> None:
        result, provider, clock = self.run_capture([snapshot(ready=False, challenged=True)])
        self.assertEqual(provider.calls, 1)
        self.assertTrue(result.snapshot.challenged)
        self.assertFalse(result.snapshot.empty)
        self.assertEqual(clock.waits, [])

    def test_deadline_bounds_all_waits_and_never_returns_unready_empty(self) -> None:
        clock = CaptureClock()
        provider = SequenceProvider([snapshot(ready=False, empty=False)])
        with patch("capture.monotonic", clock.monotonic), self.assertRaises(PlaywrightTimeoutError):
            capture(clock, provider, QUERY, 10, deadline=0.4)
        self.assertEqual(clock.waits, [250, 150])
        self.assertEqual(provider.calls, 2)
        self.assertAlmostEqual(clock.now, 0.4)

    def test_expired_deadline_does_not_sample(self) -> None:
        with patch("capture.monotonic", return_value=1), self.assertRaises(PlaywrightTimeoutError):
            remaining_ms(1)

    def test_ordinary_cli_defaults_remain_standard(self) -> None:
        self.assertEqual(parse_args(["--query", QUERY]).result_policy, ResultPolicy.STANDARD.value)
        self.assertEqual(
            parse_args(["--query", QUERY, "--result-policy", "visible-snapshot"]).result_policy,
            ResultPolicy.VISIBLE_SNAPSHOT.value,
        )


class BingSnapshotDomContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.playwright = sync_playwright().start()
        try:
            cls.session = launch_browser(
                cls.playwright, "auto", locale="en-US", headless=True, debug=False
            )
            cls.browser = cls.session.browser
        except Exception:
            cls.playwright.stop()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls.session.close()
        cls.playwright.stop()

    def setUp(self) -> None:
        self.page = self.browser.new_page(viewport={"width": 640, "height": 480})
        self.addCleanup(self.page.close)
        self.provider = BingProvider()

    def load(self, cards=CARD, *, extra="", query=QUERY, url=SEARCH_URL) -> None:
        html = f'<html><body><input id="sb_form_q" value="{query}"><ol id="b_results">{cards}</ol>{extra}</body></html>'
        self.page.route(
            "**/*", lambda route: route.fulfill(status=200, content_type="text/html", body=html)
        )
        self.page.goto(url, wait_until="load")

    def test_same_document_is_read_in_one_atomic_evaluation(self) -> None:
        self.load()
        with patch.object(self.page, "evaluate", wraps=self.page.evaluate) as evaluate:
            result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertEqual(evaluate.call_count, 1)
        self.assertTrue(result.ready)
        self.assertEqual(result.document_id, self.page.evaluate("performance.timeOrigin"))
        self.assertEqual(result.extraction.candidates[0].description, "Real snippet")

    def test_below_fold_result_needs_no_viewport_intersection(self) -> None:
        self.load(extra="<style>#b_results {margin-top:2000px}</style>")
        self.assertGreater(self.page.locator(".b_algo").bounding_box()["y"], 480)
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(result.ready)
        self.assertEqual(len(result.extraction.candidates), 1)

    def test_offscreen_auto_content_preserves_actual_title_and_snippet(self) -> None:
        cards = (
            '<li class="b_algo"><a class="tilk" href="https://example.com/paper">Site name</a>'
            '<h2><a href="https://example.com/paper">Actual <span style="display:none">Hidden</span>title</a></h2>'
            '<div class="b_caption"><p>Real <span hidden>Hidden</span>snippet</p></div></li>'
        )
        self.load(
            cards=cards,
            extra=(
                "<style>#b_results {margin-top:20000px}"
                "h2,.b_caption {content-visibility:auto;contain-intrinsic-size:auto 40px}</style>"
            ),
        )
        initial = self.provider.snapshot(self.page, QUERY, 10)
        self.assertFalse(initial.ready)
        self.assertEqual(initial.render_target, 0)
        self.assertEqual(self.page.evaluate("scrollY"), 0)
        result = capture(self.page, self.provider, QUERY, 10, deadline=monotonic() + 5)
        self.assertTrue(result.snapshot.ready)
        self.assertEqual(result.snapshot.document_id, initial.document_id)
        self.assertEqual(len(result.snapshot.extraction.candidates), 1)
        self.assertEqual(result.snapshot.extraction.candidates[0].title, "Actual title")
        self.assertEqual(result.snapshot.extraction.candidates[0].description, "Real snippet")
        self.assertEqual(result.render_actions, 1)
        self.assertGreater(self.page.evaluate("scrollY"), 0)

    def test_hidden_card_or_ancestor_is_not_ready(self) -> None:
        for style in ("display:none", "visibility:hidden", "opacity:0"):
            with self.subTest(style=style):
                self.load(extra=f"<style>#b_results {{{style}}}</style>")
                self.assertFalse(self.provider.snapshot(self.page, QUERY, 10).ready)

    def test_missing_snippet_is_optional_and_candidate_is_retained(self) -> None:
        self.load(
            cards='<li class="b_algo"><h2><a href="https://example.com/paper">Paper</a></h2></li>'
        )
        result = capture(self.page, self.provider, QUERY, 10, deadline=monotonic() + 5)
        self.assertTrue(result.snapshot.ready)
        self.assertEqual(result.samples, 2)
        self.assertEqual(
            result.snapshot.extraction.candidates,
            (Candidate("Paper", "https://example.com/paper", ""),),
        )
        self.assertEqual(dict(result.snapshot.readiness)["incomplete_descriptions"], 1)

    def test_missing_title_or_invalid_url_is_still_not_ready(self) -> None:
        for title, url in (("", "https://example.com/paper"), ("Paper", "javascript:void(0)")):
            with self.subTest(title=title, url=url):
                self.load(cards=f'<li class="b_algo"><h2><a href="{url}">{title}</a></h2></li>')
                self.assertFalse(self.provider.snapshot(self.page, QUERY, 10).ready)

    def test_only_skipped_snippet_still_triggers_normal_scroll(self) -> None:
        self.load(
            extra=(
                "<style>#b_results {margin-top:20000px}.b_caption {content-visibility:auto;"
                "contain-intrinsic-size:auto 40px}</style>"
            )
        )
        initial = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(initial.ready)
        self.assertEqual(initial.render_target, 0)
        result = capture(self.page, self.provider, QUERY, 10, deadline=monotonic() + 5)
        self.assertEqual(result.render_actions, 1)
        self.assertGreaterEqual(result.samples, 3)
        self.assertEqual(result.snapshot.extraction.candidates[0].description, "Real snippet")

    def test_rich_card_reads_only_the_visible_panel_snippet(self) -> None:
        self.load(
            cards=(
                '<li class="b_algo"><h2><a href="https://example.com/paper">Paper</a></h2>'
                '<div class="b_caption"><div class="b_richcard">'
                '<ul role="tablist"><li>Menu label is not a snippet</li></ul>'
                '<div role="tabpanel" style="display:none"><ul class="b_vList">'
                "<li><span>Hidden panel text</span></li></ul></div>"
                '<div role="tabpanel"><ul class="b_vList"><li>Introduction<br>'
                "<span>Real visible rich snippet</span></li></ul></div></div></div></li>"
            )
        )
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(result.ready)
        self.assertEqual(result.extraction.candidates[0].description, "Real visible rich snippet")

    def test_rich_card_accepts_wrapper_and_excludes_hidden_spans(self) -> None:
        self.load(
            cards=(
                '<li class="b_algo"><h2><a href="https://example.com/paper">Paper</a></h2>'
                '<div class="b_caption"><div role="tabpanel"><ul class="b_vList"><li><div>'
                "<span hidden>Hidden text</span><span>Real wrapped rich snippet</span>"
                "</div></li></ul></div></div></li>"
            )
        )
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(result.ready)
        self.assertEqual(result.extraction.candidates[0].description, "Real wrapped rich snippet")
        self.assertEqual(dict(result.readiness)["rich_snippets"], 1)

    def test_query_input_and_page_url_must_both_match(self) -> None:
        for query, url in (
            ("unrelated", SEARCH_URL),
            (QUERY, "https://www.bing.com/search?q=other"),
        ):
            with self.subTest(query=query, url=url):
                self.load(query=query, url=url)
                self.assertFalse(self.provider.snapshot(self.page, QUERY, 10).ready)

    def test_no_cards_is_not_empty_without_explicit_visible_empty_marker(self) -> None:
        self.load(cards="")
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertFalse(result.ready)
        self.assertFalse(result.empty)
        self.page.locator("#b_results").evaluate(
            "element => element.innerHTML='<li class=\"b_no\">No results</li>'"
        )
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(result.empty)
        self.assertTrue(result.ready)

    def test_challenge_is_observed_in_same_snapshot(self) -> None:
        self.load(cards="", extra='<div id="b_captcha">Verify you are human</div>')
        result = self.provider.snapshot(self.page, QUERY, 10)
        self.assertTrue(result.challenged)
        self.assertFalse(result.empty)


if __name__ == "__main__":
    unittest.main()
