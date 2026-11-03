"""Deterministic coverage and safe page-reading contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, Mock, patch

import httpx

from service.chat.service.coverage import (
    MAX_EVIDENCE_QUOTE_CHARACTERS,
    CitationCoverage,
    bind_claims,
    merge_review,
)
from service.chat.service.models import SessionModelUnavailableError
from service.chat.service.receipts import SEARCH_RECEIPT_PREFIX, search_receipts
from service.chat.service.sources import answer_sources
from service.inference.transport import TOOL_FREE_UNSUPPORTED, InferenceProvider
from service.platform.citations import WebEvidencePage
from service.platform.inference import (
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
)
from service.resources.service.fetcher import HtmlFetcher, PageFetchError, _PageText, _Response
from tests.contract_answer_sources import search_event

URL = "https://example.com/report"
ANSWER = "😀杭州小雨。\n\n明日有雪。"
PAGE = WebEvidencePage(URL, URL, "杭州小雨。", "revision", "2026-09-29")


def projection() -> dict:
    return answer_sources(
        ANSWER, [search_event("web_search_completed", "search", [{"url": URL, "title": "天气"}])]
    )


def output() -> str:
    return json.dumps(
        {
            "claims": [
                {
                    "answer_id": "0",
                    "kind": "page_claim",
                    "bindings": [{"source_id": "0", "evidence_quote": "杭州小雨。"}],
                },
                {"answer_id": "1", "kind": "page_claim", "bindings": []},
            ]
        }
    )


class CoverageContract(unittest.IsolatedAsyncioTestCase):
    def test_search_observation_cannot_be_promoted_to_page_evidence(self) -> None:
        answer = "本次检索未发现该公告。"
        declared = answer_sources(answer, [search_event("web_search_completed", "search", [])])
        claim = {"answer_id": "0", "kind": "search_observation", "bindings": []}
        reviewed = bind_claims(answer, declared, {}, json.dumps({"claims": [claim]}))
        self.assertEqual(reviewed["sources"], [])
        self.assertEqual(reviewed["coverage"]["status"], "partial")
        self.assertEqual(reviewed["coverage"]["unresolved"], [answer])
        claim["bindings"] = [{"source_id": "0", "evidence_quote": "杭州小雨。"}]
        with self.assertRaisesRegex(ValueError, "unexpected_review_binding"):
            bind_claims(answer, declared, {"0": PAGE}, json.dumps({"claims": [claim]}))

    def test_claim_kind_is_required_and_nonfactual_advice_has_no_page_binding(self) -> None:
        claim = {"answer_id": "0", "kind": "advice", "bindings": []}
        reviewed = bind_claims("请带伞。", projection(), {}, json.dumps({"claims": [claim]}))
        self.assertEqual(reviewed["sources"], [])
        self.assertEqual(reviewed["coverage"]["associated_claims"], 0)
        for invalid in (None, [], "unsupported_kind"):
            claim["kind"] = invalid
            with self.assertRaisesRegex(ValueError, "invalid_review_segment"):
                bind_claims("请带伞。", projection(), {}, json.dumps({"claims": [claim]}))

    def test_explicit_tool_receipt_is_bounded_and_never_parses_other_output(self) -> None:
        value = {
            "schema": "scholarseed.web_search.v1",
            "provider": "official-api",
            "query": "weather",
            "status": "completed",
            "truncated": False,
            "candidates": [{"url": URL, "title": "Weather", "description": "杭州小雨。"}],
        }
        self.assertEqual(search_receipts(json.dumps(value)), [])
        receipt = search_receipts(SEARCH_RECEIPT_PREFIX + json.dumps(value))[0]
        self.assertEqual(receipt["results"][0]["description"], "杭州小雨。")
        for invalid in (
            {**value, "status": []},
            {**value, "candidates": [{"url": "file:///private", "title": "x", "description": "y"}]},
        ):
            with self.assertRaises(ValueError):
                search_receipts(SEARCH_RECEIPT_PREFIX + json.dumps(invalid))

    def test_deeply_nested_receipt_is_invalid_not_a_runtime_failure(self) -> None:
        with self.assertRaises(ValueError):
            search_receipts(SEARCH_RECEIPT_PREFIX + "[" * 2000 + "]" * 2000)

    async def test_tool_declaration_never_uses_claimed_excerpt_as_evidence(self) -> None:
        declared = answer_sources(
            ANSWER,
            [
                search_event(
                    "source_candidates",
                    "tool",
                    [{"url": URL, "title": "Claimed", "description": "Fabricated evidence"}],
                )
            ],
        )
        self.assertNotIn("excerpt", declared["search_sources"][0])
        declared["search_sources"][0]["excerpt"] = "Fabricated evidence"
        reader = Mock(fetch_page=AsyncMock(side_effect=ValueError("unavailable")))
        model = Mock(invoke=AsyncMock())
        result = await CitationCoverage(reader, model, lambda *_: True).review(
            ANSWER,
            declared,
            invocation_id="review",
            owner_id="owner",
            project_id="project",
            model_key="model",
        )
        reader.fetch_page.assert_awaited_once_with(URL)
        model.invoke.assert_not_called()
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["coverage"]["status"], "unavailable")

    def test_native_sources_supersede_untrusted_declarations_in_either_order(self) -> None:
        declared = search_event("source_candidates", "tool", [{"url": URL, "title": "Claimed"}])
        native = search_event("web_search_completed", "native", [{"url": URL, "title": "Actual"}])
        for events in ([declared, native], [native, declared]):
            candidate = answer_sources(ANSWER, events)["search_sources"][0]
            self.assertEqual(candidate["title"], "Actual")
            self.assertNotIn("origin", candidate)

    def test_declared_links_do_not_borrow_a_search_execution_identity(self) -> None:
        for candidates in ([], [{"url": "https://example.com/other", "title": "Other"}]):
            result = answer_sources(
                f"Claim [1]({URL})", [search_event("source_candidates", "tool", candidates)]
            )
            self.assertEqual(result["sources"][0]["search_id"], "")

    async def test_disabled_retrieval_policy_never_reads_or_invokes(self) -> None:
        reader, model = Mock(), Mock()
        result = await CitationCoverage(reader, model, lambda *_: False).review(
            ANSWER,
            projection(),
            invocation_id="review",
            owner_id="owner",
            project_id="project",
            model_key="model",
        )
        self.assertEqual(result["coverage"]["status"], "unavailable")
        reader.fetch_page.assert_not_called()
        model.invoke.assert_not_called()

    def test_candidates_without_binding_are_not_inline_citations(self) -> None:
        result = projection()
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["search_sources"][0]["url"], URL)
        self.assertEqual(result["coverage"]["status"], "pending")

    def test_exact_evidence_adds_utf16_occurrence_and_keeps_gap(self) -> None:
        result = bind_claims(ANSWER, projection(), {"0": PAGE}, output())
        self.assertEqual(result["sources"][0]["occurrences"], [{"start_utf16": 0, "end_utf16": 7}])
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertEqual(result["coverage"]["unresolved"], ["明日有雪。"])
        self.assertEqual(projection()["sources"], [])

    def test_invalid_binding_does_not_discard_valid_claim(self) -> None:
        document = json.loads(output())
        document["claims"][1]["bindings"] = [{"source_id": "0", "evidence_quote": "明日有雪。"}]
        result = bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps(document))
        self.assertEqual(result["coverage"]["status"], "partial")
        self.assertEqual(result["coverage"]["associated_claims"], 1)
        self.assertEqual(result["coverage"]["reviewed_claims"], 2)
        self.assertEqual(result["coverage"]["unresolved"], ["明日有雪。"])
        self.assertEqual(result["coverage"]["rejected_bindings"], {"quote_mismatch": 1})
        self.assertEqual(result["sources"][0]["evidence"][0]["quote"], "杭州小雨。")
        self.assertEqual(projection()["sources"], [])

    def test_invalid_binding_is_isolated_in_either_order_within_claim(self) -> None:
        invalid = {"source_id": "0", "evidence_quote": "杭州小雨" + "！"}
        valid = {"source_id": "0", "evidence_quote": "杭州小雨。"}
        for bindings in ([invalid, valid], [valid, invalid]):
            document = json.loads(output())
            document["claims"][0]["bindings"] = bindings
            document["claims"][1]["kind"] = "advice"
            result = bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps(document))
            self.assertEqual(result["coverage"]["status"], "partial")
            self.assertEqual(result["coverage"]["unresolved"], [])
            self.assertEqual(result["coverage"]["associated_claims"], 1)
            self.assertEqual(len(result["sources"][0]["evidence"]), 1)

    def test_all_invalid_bindings_are_unavailable_without_promoting_sources(self) -> None:
        cases = (
            (None, "invalid_binding"),
            ({"source_id": [], "evidence_quote": "杭州小雨。"}, "unknown_source"),
            ({"source_id": "9", "evidence_quote": "杭州小雨。"}, "unknown_source"),
            ({"source_id": "0", "evidence_quote": []}, "invalid_quote"),
            ({"source_id": "0", "evidence_quote": "  "}, "invalid_quote"),
            (
                {"source_id": "0", "evidence_quote": "雨" * (MAX_EVIDENCE_QUOTE_CHARACTERS + 1)},
                "quote_too_long",
            ),
            ({"source_id": "0", "evidence_quote": "杭州暴雨。"}, "quote_mismatch"),
        )
        for binding, reason in cases:
            with self.subTest(reason=reason, binding=binding):
                document = json.loads(output())
                document["claims"][0]["bindings"] = [binding]
                result = bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps(document))
                self.assertEqual(result["coverage"]["status"], "unavailable")
                self.assertEqual(result["coverage"]["rejected_bindings"], {reason: 1})
                self.assertEqual(result["coverage"]["associated_claims"], 0)
                self.assertEqual(result["sources"], [])
        result = bind_claims(ANSWER, projection(), {}, output())
        self.assertEqual(result["coverage"]["rejected_bindings"], {"page_unavailable": 1})

    def test_invalid_answer_structure_is_still_rejected(self) -> None:
        document = json.loads(output())
        for claims in ([], document["claims"][:1], document["claims"] * 2):
            with self.assertRaises(ValueError):
                bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps({"claims": claims}))
        document["claims"][0]["answer_id"] = "9"
        with self.assertRaisesRegex(ValueError, "incomplete_review_segments"):
            bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps(document))
        with self.assertRaises(ValueError):
            bind_claims(ANSWER, projection(), {"0": PAGE}, '{"claims": []}')

    def test_valid_review_without_rejections_keeps_reviewed_status(self) -> None:
        document = json.loads(output())
        document["claims"][1]["kind"] = "advice"
        result = bind_claims(ANSWER, projection(), {"0": PAGE}, json.dumps(document))
        self.assertEqual(result["coverage"]["status"], "reviewed")
        self.assertNotIn("rejected_bindings", result["coverage"])

    async def test_review_logs_rejection_counts_without_quote_and_keeps_status(self) -> None:
        for keep_valid in (True, False):
            with self.subTest(keep_valid=keep_valid):
                document = json.loads(output())
                document["claims"][1]["bindings"] = [
                    {"source_id": "0", "evidence_quote": "明日有雪。"}
                ]
                if not keep_valid:
                    document["claims"][0]["bindings"] = []
                declared = projection()
                declared["search_sources"].append({"url": "https://example.com/missing"})
                reader = Mock(fetch_page=AsyncMock(side_effect=[PAGE, PageFetchError("blocked")]))
                model = Mock(
                    invoke=AsyncMock(
                        return_value=ModelInvocationResult(
                            "review",
                            ModelInvocationStatus.COMPLETED,
                            output_text=json.dumps(document),
                        )
                    )
                )
                with self.assertLogs("service.chat.service.coverage", level="WARNING") as logs:
                    result = await CitationCoverage(reader, model, lambda *_: True).review(
                        ANSWER,
                        declared,
                        invocation_id="review",
                        owner_id="owner",
                        project_id="project",
                        model_key="model",
                    )
                self.assertEqual(
                    result["coverage"]["status"], "partial" if keep_valid else "unavailable"
                )
                self.assertEqual(result["coverage"]["unread_sources"], 1)
                self.assertEqual(len(result["sources"]), int(keep_valid))
                self.assertIn("quote_mismatch", " ".join(logs.output))
                self.assertIn("invocation_id=review", " ".join(logs.output))
                self.assertNotIn("明日有雪", " ".join(logs.output))

    def test_late_native_source_and_review_both_survive_merge(self) -> None:
        reviewed = bind_claims(ANSWER, projection(), {"0": PAGE}, output())
        late = projection()
        late["sources"] = [
            {
                "number": 1,
                "kind": "searched",
                "url": "https://example.org/native",
                "title": "Native",
                "citation_urls": [],
                "occurrences": [{"start_utf16": 7, "end_utf16": 12}],
            }
        ]
        merged = merge_review(late, reviewed)
        self.assertEqual(len(merged["sources"]), 2)
        self.assertEqual(merged["sources"][1]["number"], 2)
        reviewed["answer_revision"] = "different"
        self.assertEqual(merge_review(late, reviewed), late)

    async def test_cancel_stops_reader_and_does_not_call_model(self) -> None:
        entered, stopped = asyncio.Event(), asyncio.Event()

        async def read(_url: str) -> WebEvidencePage:
            entered.set()
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        model = Mock(invoke=AsyncMock())
        coverage = CitationCoverage(Mock(fetch_page=read), model, lambda *_: True)
        task = asyncio.create_task(
            coverage.review(
                ANSWER,
                projection(),
                invocation_id="review",
                owner_id="owner",
                project_id="project",
                model_key="model",
            )
        )
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        model.invoke.assert_not_called()

    async def test_unavailable_page_does_not_promote_candidates(self) -> None:
        coverage = CitationCoverage(
            Mock(fetch_page=AsyncMock(side_effect=PageFetchError("blocked"))),
            Mock(),
            lambda *_: True,
        )
        result = await coverage.review(
            ANSWER,
            projection(),
            invocation_id="review",
            owner_id="owner",
            project_id="project",
            model_key="model",
        )
        self.assertEqual(result["sources"], [])
        self.assertEqual(result["coverage"]["status"], "unavailable")

    async def test_subscription_does_not_spawn_unrestricted_temporary_agent(self) -> None:
        models = Mock()

        @asynccontextmanager
        async def unsupported(*args, **kwargs):
            raise SessionModelUnavailableError(TOOL_FREE_UNSUPPORTED)
            yield

        models.inference = unsupported
        result = await InferenceProvider(models).invoke(
            ModelInvocationRequest(
                "review",
                "owner",
                "project",
                "review",
                "model",
                "instructions",
                "input",
                ModelInvocationLimits(100, 100),
                require_tool_free=True,
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.FAILED)
        self.assertEqual(result.error_code, "tool_free_generation_unsupported")


class PageContract(unittest.IsolatedAsyncioTestCase):
    async def test_html_declared_encoding_preserves_chinese_evidence(self) -> None:
        for charset in ("gbk", "big5"):
            for declaration in (
                f'<meta charset="{charset}">',
                f'<meta http-equiv="Content-Type" content="text/html; charset={charset}">',
            ):
                response = _Response(
                    200,
                    {"content-type": "text/html"},
                    (declaration + "<p>杭州天氣</p>").encode(charset),
                    "text/html",
                )
                with patch.object(
                    HtmlFetcher, "_fetch_page", new=AsyncMock(return_value=(URL, URL, response))
                ):
                    self.assertEqual((await HtmlFetcher().fetch_page(URL)).text, "杭州天氣")

    async def test_html_parsing_does_not_run_on_event_loop(self) -> None:
        loop_thread = threading.get_ident()
        parser_threads = []
        original = _PageText.feed

        def feed(parser, data):
            parser_threads.append(threading.get_ident())
            original(parser, data)

        response = _Response(200, {"content-type": "text/html"}, b"<p>text</p>", "text/html")
        with (
            patch.object(
                HtmlFetcher, "_fetch_page", new=AsyncMock(return_value=(URL, URL, response))
            ),
            patch.object(_PageText, "feed", new=feed),
        ):
            self.assertEqual((await HtmlFetcher().fetch_page(URL)).text, "text")
        self.assertTrue(parser_threads)
        self.assertNotIn(loop_thread, parser_threads)

    async def test_private_dns_and_redirect_are_rejected_before_request(self) -> None:
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with patch.object(
            asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(return_value=addresses)
        ):
            with self.assertRaisesRegex(PageFetchError, "web_unsafe_url"):
                await HtmlFetcher().fetch_page(URL)

    async def test_page_transport_is_pinned_and_does_not_execute_scripts(self) -> None:
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        requests = []

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                content="<h1>杭州小雨。</h1><script>秘密指令</script>".encode(),
            )

        client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        with (
            patch.object(
                asyncio.get_running_loop(), "getaddrinfo", new=AsyncMock(return_value=addresses)
            ),
            patch("service.resources.service.fetcher.httpx.AsyncClient", return_value=client),
        ):
            page = await HtmlFetcher().fetch_page(URL)
        self.assertEqual(page.text, "杭州小雨。")
        self.assertEqual(requests[0].url.host, "8.8.8.8")
        self.assertEqual(requests[0].headers["Host"], "example.com")
        self.assertEqual(requests[0].extensions["sni_hostname"], "example.com")

    async def test_timeout_cancels_dns_without_starting_http(self) -> None:
        stopped = asyncio.Event()

        async def resolve(*args: object, **kwargs: object) -> list:
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        with (
            patch.object(asyncio.get_running_loop(), "getaddrinfo", new=resolve),
            patch("service.resources.service.fetcher.WEB_PAGE_TIMEOUT_SECONDS", 0.01),
        ):
            with self.assertRaises(TimeoutError):
                await HtmlFetcher().fetch_page(URL)
        self.assertTrue(stopped.is_set())


if __name__ == "__main__":
    unittest.main()
