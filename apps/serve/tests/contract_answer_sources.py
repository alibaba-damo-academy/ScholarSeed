"""Verified answer-source projection contracts (mechanism tests, not acceptance)."""

from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from service.chat.constants import (
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.service.events import HISTORY_ACTIVITY_EVENT_KINDS
from service.chat.service.sources import answer_sources, canonical_url


def search_event(kind: str, search_id: str, results: list[dict]) -> ProductEventRecord:
    return ProductEventRecord(
        event_id=1,
        session_id="session",
        runtime_id="codex",
        vendor_thread_id="thread",
        vendor_turn_id="turn",
        vendor_item_id=search_id,
        kind=kind,
        payload={"search_id": search_id, "query": "query", "results": results},
        schema_version=2,
        product_seq=1,
        idempotency_key=search_id,
        created_at=1.0,
    )


class AnswerSourceContracts(unittest.TestCase):
    def test_mixed_receipt_and_searched_links_share_first_appearance_numbers(self) -> None:
        events = (
            search_event(
                PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                "web-1",
                [
                    {"title": "Second", "url": "https://example.test/second"},
                    {"title": "First", "url": "https://example.test/first"},
                ],
            ),
            search_event(
                PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
                "paper-1",
                [{"title": "Paper", "url": "https://papers.test/item"}],
            ),
        )
        result = answer_sources(
            "A [48](https://example.test/first) B [9](scholarseed-cite:receipt-1) "
            "C [54](https://papers.test/item) D [48](https://example.test/first).",
            events,
        )
        self.assertEqual(
            result["sources"],
            [
                {
                    "kind": "searched",
                    "url": "https://example.test/first",
                    "title": "First",
                    "search_kind": "web",
                    "search_id": "web-1",
                    "citation_urls": ["https://example.test/first"],
                    "number": 1,
                },
                {
                    "kind": "receipt",
                    "handle": "receipt-1",
                    "citation_urls": ["scholarseed-cite:receipt-1"],
                    "number": 2,
                },
                {
                    "kind": "searched",
                    "url": "https://papers.test/item",
                    "title": "Paper",
                    "search_kind": "paper",
                    "search_id": "paper-1",
                    "citation_urls": ["https://papers.test/item"],
                    "number": 3,
                },
            ],
        )
        self.assertRegex(result["answer_revision"], r"^sha256:[0-9a-f]{64}$")

    def test_unsearched_code_image_and_escaped_links_are_not_registered(self) -> None:
        events = (
            search_event(
                PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                "web-1",
                [{"title": "Allowed", "url": "https://allowed.test/page"}],
            ),
        )
        result = answer_sources(
            "[ordinary](https://other.test) "
            "`[code](https://allowed.test/page)` "
            "![image](https://allowed.test/page) "
            r"\[escaped](https://allowed.test/page)",
            events,
        )
        self.assertEqual(result["sources"], [])

    def test_completed_search_without_structured_results_registers_answer_links(self) -> None:
        result = answer_sources(
            "Use [UnionPay International](https://example.test/payments) and "
            "[risk notes](https://risk.test/report#summary).",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web-1", []),),
        )

        self.assertEqual(
            result["sources"],
            [
                {
                    "kind": "searched",
                    "url": "https://example.test/payments",
                    "title": "UnionPay International",
                    "search_kind": "web",
                    "search_id": "web-1",
                    "citation_urls": ["https://example.test/payments"],
                    "number": 1,
                },
                {
                    "kind": "searched",
                    "url": "https://risk.test/report#summary",
                    "title": "risk notes",
                    "search_kind": "web",
                    "search_id": "web-1",
                    "citation_urls": ["https://risk.test/report#summary"],
                    "number": 2,
                },
            ],
        )

    def test_answer_links_are_not_fallback_sources_without_a_completed_search(self) -> None:
        result = answer_sources("[ordinary](https://other.test)", ())

        self.assertEqual(result["sources"], [])

    def test_url_identity_is_conservative_and_ignores_fragments(self) -> None:
        self.assertEqual(
            canonical_url("HTTPS://Example.TEST:443/path?q=1#section"),
            "https://example.test/path?q=1",
        )
        self.assertEqual(
            canonical_url("https://[2001:db8::1]:443/path"), "https://[2001:db8::1]/path"
        )
        self.assertIsNone(canonical_url("javascript:alert(1)"))
        self.assertIsNone(canonical_url("https://user:secret@example.test/path"))
        result = answer_sources(
            "[7](https://example.test/path?q=1#claim)",
            (
                search_event(
                    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                    "web-1",
                    [{"title": "Matched", "url": "https://example.test/path?q=1"}],
                ),
            ),
        )
        self.assertEqual(result["sources"][0]["number"], 1)

    def test_projection_reopens_from_the_existing_product_event_ledger(self) -> None:
        self.assertIn(PRODUCT_EVENT_ANSWER_SOURCES, HISTORY_ACTIVITY_EVENT_KINDS)
        with TemporaryDirectory() as directory:
            database = Path(directory) / "sessions.sqlite3"
            SessionCatalogStore(database).register(
                "session",
                SessionPrincipal("owner"),
                runtime_id="codex",
                vendor_thread_id="thread",
                vendor_session_id="process",
                runtime_workdir=directory,
                project_path=None,
                output_root=str(Path(directory) / "outputs"),
                codex_version="test",
                model_id="test",
                policy_id="workspace-write",
                status=SessionStatus.READY,
                title="",
                created_at=1.0,
            )
            events = ProductEventStore(database)
            events.append(
                session_id="session",
                runtime_id="codex",
                vendor_thread_id="thread",
                vendor_turn_id="turn",
                vendor_item_id="answer",
                kind=PRODUCT_EVENT_ANSWER_SOURCES,
                payload=answer_sources(
                    "[48](https://example.test/source)",
                    (
                        search_event(
                            PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                            "web-1",
                            [{"title": "Source", "url": "https://example.test/source"}],
                        ),
                    ),
                ),
                idempotency_key="answer-sources:answer",
            )
            reopened = ProductEventStore(database).replay("session")

        self.assertEqual(len(reopened), 1)
        self.assertEqual(reopened[0].kind, PRODUCT_EVENT_ANSWER_SOURCES)
        self.assertEqual(reopened[0].payload["sources"][0]["number"], 1)


if __name__ == "__main__":
    unittest.main()
