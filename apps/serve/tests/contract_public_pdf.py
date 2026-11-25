"""Public PDF reads share bytes only within the owning live session."""

import asyncio
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase, main
from unittest.mock import AsyncMock, Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests.contract_pdf_materialize import pdf_bytes
from service.assistant.api.citations import register_citation_bridge
from service.assistant.service.public_pdf import PublicPdfCache
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import PDF_ROUTE_PREFIX
from service.platform.vocabulary import BRIDGE_SESSION_HEADER, BRIDGE_TOKEN_HEADER
from service.resources.service.fetcher import HtmlFetcher


class PublicPdfContracts(IsolatedAsyncioTestCase):
    async def test_private_target_is_denied(self):
        with self.assertRaisesRegex(ValueError, "web_unsafe_url"):
            await HtmlFetcher().fetch_pdf("http://127.0.0.1/paper.pdf")

    async def test_overlapping_reads_share_fetch_and_parser(self):
        url = "https://example.org/test.pdf"
        fetch = AsyncMock(return_value=(url, pdf_bytes("first page")))
        cache = PublicPdfCache()
        activities = Activities()
        a, b = await asyncio.gather(
            cache.open(url, fetch, activities, lambda: True),
            cache.open(url, fetch, activities, lambda: True),
        )
        self.assertIs(a, b)
        fetch.assert_awaited_once_with(url)

    async def test_revoked_scope_does_not_publish_or_cache(self):
        url = "https://example.org/test.pdf"
        cache = PublicPdfCache()
        with self.assertRaisesRegex(ValueError, "access_denied"):
            await cache.open(
                url,
                AsyncMock(return_value=(url, pdf_bytes("only when authorized"))),
                Activities(),
                Mock(side_effect=[True, False]),
            )
        self.assertFalse(cache.documents)

    def test_read_search_scope_and_reuse(self):
        activities = Activities()
        live = SimpleNamespace(
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            active_task_type="",
            ledger=SimpleNamespace(active_turn_id="turn"),
            interrupting=False,
            terminating=False,
            publish=AsyncMock(),
            public_pdf_cache=PublicPdfCache(),
            turn_activity=activities.enter(ActivityDomain.TURN),
        )
        self.addCleanup(live.turn_activity.close)
        url = "https://example.org/paper.pdf"
        fetch = AsyncMock(return_value=(url, pdf_bytes("Sample size: 27", "Limit: 128 tokens")))
        allowed = Mock(return_value=True)
        app = FastAPI()
        register_citation_bridge(
            app,
            SimpleNamespace(bridge_caller=lambda s: live if s == live.id else None),
            SimpleNamespace(web_read_allowed=allowed, commit_read=lambda s, t, response: response),
            activities=activities,
            fetch_public_pdf=fetch,
        )
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app, headers=headers) as client:
            first = client.post(PDF_ROUTE_PREFIX + "read-url", json={"url": url, "query": "Sample"})
            self.assertEqual(first.status_code, 200, first.text)
            ref = first.json()["ref_id"]
            self.assertEqual(first.json()["fragments"][0]["citation_url"], url + "#page=1")
            second = client.post(
                PDF_ROUTE_PREFIX + "search", json={"ref_id": ref, "query": "tokens"}
            )
            self.assertIn("128 tokens", second.json()["fragments"][0]["text"])
            self.assertEqual(second.json()["fragments"][0]["pages"], [2])
            window = client.post(
                PDF_ROUTE_PREFIX + "search", json={"ref_id": ref, "query": "Sample", "span": 2}
            )
            self.assertEqual(window.json()["fragments"][0]["pages"], [1, 2])
            self.assertIn("128 tokens", window.json()["fragments"][0]["text"])
            same = client.post(PDF_ROUTE_PREFIX + "read-url", json={"url": url})
            self.assertEqual(same.json()["ref_id"], ref)
            allowed.return_value = False
            self.assertEqual(
                client.post(PDF_ROUTE_PREFIX + "read", json={"ref_id": ref}).status_code, 403
            )
            self.assertEqual(
                client.post(
                    PDF_ROUTE_PREFIX + "read-url", json={"url": url + "/other"}
                ).status_code,
                403,
            )
            fetch.assert_awaited_once_with(url)
        with self.assertRaisesRegex(ValueError, "reference_unavailable"):
            PublicPdfCache().resolve(ref)

    async def test_ranked_multiword_query_and_cached_evidence_page(self):
        url = "https://example.org/tacl.pdf"
        fetch = AsyncMock(
            return_value=(
                url,
                pdf_bytes(
                    "157\nLost in the Middle\nAbstract overview of long context models.",
                    "158\n1 Introduction\nBackground on long input contexts.",
                    "159\n2.1 Experimental Setup\nWe instantiate this task with data\n"
                    "from NaturalQuestions-Open. We take the 2655 queries\n"
                    "and chunks of at most 100 tokens from Wikipedia.",
                ),
            )
        )
        cache = PublicPdfCache()
        paper = await cache.open(url, fetch, Activities(), lambda: True)
        excerpts = paper.excerpts(
            "multi-document question answering how many questions Natural Questions dataset",
            offset=0,
            limit=3,
        )
        self.assertTrue(excerpts["fragments"])
        self.assertEqual(excerpts["fragments"][0]["pages"], [3])
        self.assertIn("2655 queries", excerpts["fragments"][0]["text"])
        self.assertEqual(excerpts["fragments"][0].get("printed_pages"), ["159"])
        page = cache.evidence_page(url + "#page=3")
        self.assertIsNotNone(page)
        assert page is not None
        self.assertIn("chunks of at most 100 tokens", page.text)


if __name__ == "__main__":
    main()
