"""Verified answer-source projection contracts (mechanism tests, not acceptance)."""

from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from service.chat.constants import (
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_NATIVE_SOURCES,
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.service.events import HISTORY_ACTIVITY_EVENT_KINDS
from service.chat.service.provenance import item_provenance
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
    def test_native_annotations_do_not_require_markdown_links_or_search_skill(self) -> None:
        text = "😀这是原生搜索结论。"
        payload = item_provenance(
            {
                "type": "message",
                "role": "assistant",
                "id": "native-message",
                "content": [
                    {
                        "type": "output_text",
                        "text": text,
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://example.test/source",
                                "title": "原始来源",
                                "start_index": 1,
                                "end_index": len(text),
                            }
                        ],
                    }
                ],
            }
        )
        event = replace(
            search_event(PRODUCT_EVENT_NATIVE_SOURCES, "native-message", []), payload=payload
        )
        result = answer_sources(text, [event], item_id="native-message")
        self.assertEqual(result["sources"][0]["title"], "原始来源")
        self.assertEqual(
            result["sources"][0]["occurrences"], [{"start_utf16": 2, "end_utf16": len(text) + 1}]
        )
        self.assertEqual(answer_sources(text, [event], item_id="other")["sources"], [])
        self.assertEqual(
            answer_sources(text + "过滤改变正文", [event], item_id="native-message")["sources"], []
        )

    def test_search_candidates_alone_never_become_native_citations(self) -> None:
        payload = item_provenance(
            {
                "type": "web_search_call",
                "id": "native-search",
                "action": {"sources": [{"url": "https://example.test/source", "title": "候选"}]},
            }
        )
        event = replace(
            search_event(PRODUCT_EVENT_NATIVE_SOURCES, "native-search", []), payload=payload
        )
        self.assertEqual(
            answer_sources("没有引用", [event], item_id="native-search")["sources"], []
        )

    def test_bare_domains_are_not_gfm_links_or_sources(self) -> None:
        result = answer_sources(
            "python.org 版本说明；www.python.org/downloads/ 与 https://www.python.org/",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(
            [source["url"] for source in result["sources"]],
            ["http://www.python.org/downloads/", "https://www.python.org/"],
        )

    def test_bare_web_sources_are_registered_without_changing_prose(self) -> None:
        result = answer_sources(
            "参考资料：\n\n- 官网 https://example.test/source\n"
            "- 另一个 <https://example.test/second>",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(
            [source["url"] for source in result["sources"]],
            ["https://example.test/source", "https://example.test/second"],
        )

    def test_reference_url_excludes_sentence_punctuation(self) -> None:
        result = answer_sources(
            "正文[1]。\n\n[1] https://example.test/source。",
            (
                search_event(
                    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                    "web",
                    [{"title": "Source", "url": "https://example.test/source"}],
                ),
            ),
        )
        self.assertEqual(result["sources"][0]["reference_labels"], ["1"])

    def test_multiple_links_are_not_swallowed_as_one_reference(self) -> None:
        result = answer_sources(
            "[1] [A](https://a.test) and [B](https://b.test)",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual([source["title"] for source in result["sources"]], ["A", "B"])
        self.assertTrue(all(not source.get("reference_labels") for source in result["sources"]))

    def test_plain_references_share_body_order_and_do_not_lose_urls(self) -> None:
        result = answer_sources(
            "正文[9] 再引用[3]。\n\n[3] https://example.test/first\n"
            "[9] https://example.test/second",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(
            [
                (source["url"], source["number"], source["reference_labels"])
                for source in result["sources"]
            ],
            [("https://example.test/second", 1, ["9"]), ("https://example.test/first", 2, ["3"])],
        )

    def test_adjacent_references_preserve_body_order(self) -> None:
        result = answer_sources(
            "正文[9][10]。\n\n[10] https://example.test/second\n" "[9] https://example.test/first",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(
            [source["url"] for source in result["sources"]],
            ["https://example.test/first", "https://example.test/second"],
        )

    def test_reference_conflicts_and_untrusted_contexts_never_bind_labels(self) -> None:
        result = answer_sources(
            "正文[9]。\n\n[9] https://example.test/first\n"
            "[9] https://example.test/second\n\n"
            "`[7] https://example.test/code`\n\n"
            "\\[8] https://example.test/escaped\n\n"
            "```text\n[6] https://example.test/fenced\n```",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(
            [source["url"] for source in result["sources"]],
            [
                "https://example.test/first",
                "https://example.test/second",
                "https://example.test/escaped",
            ],
        )
        self.assertTrue(all(not source.get("reference_labels") for source in result["sources"]))

    def test_named_reference_entries_and_crlf_keep_explicit_aliases(self) -> None:
        result = answer_sources(
            "😀结论[12]\r\n\r\n[12] [网站](https://example.test/source)",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "web", []),),
        )
        self.assertEqual(result["sources"][0]["reference_labels"], ["12"])
        self.assertEqual(result["sources"][0]["title"], "网站")

    def test_postfix_references_register_explicit_sources_missing_from_candidates(self) -> None:
        declarations = (
            "https://example.test/source [7]",
            "<https://example.test/source> [7]",
            "**https://example.test/source** [7]",
            "[https://example.test/source](https://example.test/source) [7]",
            "- 官网：https://example.test/source [7]",
            "| 官网 | https://example.test/source [7] |",
        )
        events = (
            search_event(
                PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                "search",
                [{"url": "https://another.test/", "title": "Other candidate"}],
            ),
        )
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                result = answer_sources(f"😀正文[7]。\r\n\r\n{declaration}", events)
                self.assertEqual(len(result["sources"]), 1)
                source = result["sources"][0]
                self.assertEqual(source["url"], "https://example.test/source")
                self.assertEqual(source["reference_labels"], ["7"])
                self.assertEqual(source["number"], 1)
                self.assertEqual(source["search_id"], "")
                self.assertNotIn("evidence", source)

    def test_postfix_reference_conflicts_with_prefix_and_postfix_declarations(self) -> None:
        for other in (
            "[7] https://other.test/source",
            "https://other.test/source [7]",
            "[7](https://other.test/source)",
        ):
            with self.subTest(other=other):
                result = answer_sources(
                    f"正文[7]。\n\nhttps://example.test/source [7]\n\n{other}",
                    (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "search", []),),
                )
                self.assertTrue(result["sources"])
                self.assertTrue(
                    all(not source.get("reference_labels") for source in result["sources"])
                )

    def test_rust_installation_postfix_declaration_with_repeated_body_label(self) -> None:
        result = answer_sources(
            "**https://www.rust-lang.org/zh-CN/tools/install** [1]："
            "安装命令 `curl https://sh.rustup.rs | sh`，按照平台提示操作 [1]。",
            (),
        )
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(
            result["sources"][0]["url"], "https://www.rust-lang.org/zh-CN/tools/install"
        )
        self.assertEqual(result["sources"][0]["reference_labels"], ["1"])
        self.assertEqual(result["sources"][0]["search_id"], "")

    def test_numbered_markdown_and_postfix_conflict_on_the_same_line(self) -> None:
        result = answer_sources(
            "[7](https://first.test)；https://second.test [7]",
            (search_event(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, "search", []),),
        )
        self.assertEqual(len(result["sources"]), 2)
        self.assertTrue(all(not source.get("reference_labels") for source in result["sources"]))

    def test_postfix_reference_canonical_identity_reuses_number_and_body_order(self) -> None:
        result = answer_sources(
            "正文[9]，再引用[7]，又引用[9]。\n\n"
            "https://example.test/first [7]\n\n"
            "https://example.test/second [9]\n\n"
            "https://EXAMPLE.test:443/second#section [9]",
            (),
        )
        self.assertEqual(
            [(source["number"], source["reference_labels"]) for source in result["sources"]],
            [(1, ["9"]), (2, ["7"])],
        )

    def test_postfix_references_reject_ambiguous_or_nonprose_declarations(self) -> None:
        declarations = (
            "`https://example.test/source` [7]",
            "```text\nhttps://example.test/source [7]\n```",
            "https://example.test/source \\[7]",
            "[官网](https://example.test/source) [7]",
            "[https://different.test/source](https://example.test/source) [7]",
            "![https://example.test/source](https://example.test/source) [7]",
            "<span>https://example.test/source [7]</span>",
            "https://example.test/source\n[7]",
            "https://example.test/source  \n[7]",
            "https://example.test/source 说明 [7]",
            "https://example.test/source [7][8]",
            "https://example.test/source [7] [8]",
            "https://another.test https://example.test/source [7]",
        )
        for declaration in declarations:
            with self.subTest(declaration=declaration):
                result = answer_sources(f"正文[7]。\n\n{declaration}", ())
                self.assertEqual(result["sources"], [])

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
                    "reference_labels": ["48"],
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
                    "reference_labels": ["54"],
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
                    "search_id": "",
                    "citation_urls": ["https://example.test/payments"],
                    "number": 1,
                },
                {
                    "kind": "searched",
                    "url": "https://risk.test/report#summary",
                    "title": "risk notes",
                    "search_kind": "web",
                    "search_id": "",
                    "citation_urls": ["https://risk.test/report#summary"],
                    "number": 2,
                },
            ],
        )

    def test_answer_links_are_not_fallback_sources_without_a_completed_search(self) -> None:
        result = answer_sources("[ordinary](https://other.test)", ())

        self.assertEqual(result["sources"], [])

    def test_explicit_numbered_citation_survives_followup_without_new_search(self) -> None:
        result = answer_sources("Followup fact [1](https://example.test/read).", ())
        self.assertEqual(result["sources"][0]["url"], "https://example.test/read")
        self.assertEqual(result["sources"][0]["search_id"], "")
        self.assertEqual(result["coverage"]["status"], "pending")

    def test_numbered_page_read_reference_is_not_rejected_by_different_search_candidates(
        self,
    ) -> None:
        result = answer_sources(
            "Read [1](https://example.test/read) and [ordinary](https://other.test).",
            (
                search_event(
                    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
                    "search",
                    [{"url": "https://example.test/search"}],
                ),
            ),
        )
        self.assertEqual(
            [source["url"] for source in result["sources"]], ["https://example.test/read"]
        )

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
