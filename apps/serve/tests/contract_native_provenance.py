"""Native provenance extraction contracts; not product acceptance evidence."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.model import ModelWireProtocol
from service.chat.constants import (
    PRODUCT_EVENT_ANSWER_SOURCES,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_NATIVE_SOURCES,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.worker import PersistenceWorker
from service.chat.runtime.live import LiveSession
from service.chat.service.provenance import (
    PROVENANCE_SOURCE_LIMIT,
    ProvenanceStream,
    item_provenance,
    response_provenance,
    text_revision,
)

from .contract_completion_bridge import forward_contract


def citation(**overrides: object) -> dict:
    return {
        "type": "url_citation",
        "url": "https://example.test/source",
        "title": "Source",
        "start_index": 0,
        "end_index": 3,
        **overrides,
    }


def message(text: str = "原生引用", annotations: object = None) -> dict:
    part = {"type": "output_text", "text": text}
    if annotations is not None:
        part["annotations"] = annotations
    return {"id": "message-native", "type": "message", "role": "assistant", "content": [part]}


def event_bytes(item: dict, newline: bytes = b"\n") -> bytes:
    payload = {"type": "response.output_item.done", "item": item}
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode() + newline + newline


class NativeProvenanceContracts(unittest.TestCase):
    def test_native_bridge_preserves_wire_and_freezes_turn_identity(self) -> None:
        item = message(annotations=[citation()])
        completed = {"id": "response-native", "status": "completed", "output": [item]}
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                sources = []
                calls = []

                def turn_provider(session_id: str) -> str:
                    calls.append(session_id)
                    return "original-turn" if len(calls) == 1 else "later-turn"

                body = (
                    event_bytes(item)
                    + b"data: "
                    + json.dumps({"type": "response.completed", "response": completed}).encode()
                    + b"\n\n"
                    if streaming
                    else json.dumps(completed).encode()
                )
                response, _requests = forward_contract(
                    {"model": "selected-model", "input": "Search", "stream": streaming},
                    body,
                    wire_protocol=ModelWireProtocol.RESPONSES,
                    turn_id_provider=turn_provider,
                    sources=sources,
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.content, body)
                self.assertGreaterEqual(len(sources), 1)
                self.assertTrue(
                    all(
                        session == "search-contract" and turn == "original-turn"
                        for session, turn, _record in sources
                    )
                )
                self.assertTrue(
                    all(record == item_provenance(item) for _session, _turn, record in sources)
                )

    def test_chat_completion_bridge_does_not_invent_native_sources(self) -> None:
        sources = []
        body = json.dumps(
            {
                "id": "chat",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "Search answer",
                            "annotations": [citation()],
                        },
                        "finish_reason": "stop",
                    }
                ],
            }
        ).encode()
        response, _requests = forward_contract(
            {"model": "selected-model", "input": "Search", "stream": False},
            body,
            wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
            turn_id_provider=lambda _session: "turn",
            sources=sources,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(sources, [])

    def test_revision_matches_exact_utf8_text(self) -> None:
        text = "引用😀\r\n"
        self.assertEqual(text_revision(text), "sha256:" + hashlib.sha256(text.encode()).hexdigest())
        self.assertNotEqual(text_revision(text), text_revision(text.rstrip()))

    def test_unicode_ranges_are_utf16_and_keep_multiple_parts(self) -> None:
        item = message("😀甲乙", [citation(start_index=1, end_index=3)])
        item["content"].append(
            {
                "type": "output_text",
                "text": "后😀",
                "annotations": [citation(start_index=0, end_index=2)],
            }
        )
        result = item_provenance(item)
        self.assertEqual(result["answer_revision"], text_revision("😀甲乙后😀"))
        self.assertEqual(
            [(source["start_utf16"], source["end_utf16"]) for source in result["sources"]],
            [(2, 4), (4, 7)],
        )

    def test_missing_and_empty_annotations_are_distinct(self) -> None:
        for annotations, provided in ((None, False), ([], True), ({}, False)):
            with self.subTest(annotations=annotations):
                result = item_provenance(message(annotations=annotations))
                self.assertEqual(result["provided"], provided)
                self.assertEqual(result["sources"], [])

    def test_search_candidates_are_not_answer_ranges(self) -> None:
        for action, provided in (({}, False), ({"sources": []}, True), ({"sources": None}, False)):
            result = item_provenance({"id": "search", "type": "web_search_call", "action": action})
            self.assertEqual(result["provided"], provided)
            self.assertEqual(result["sources"], [])
        result = item_provenance(
            {"id": "search", "type": "web_search_call", "action": {"sources": [citation()]}}
        )
        self.assertEqual(
            result["sources"], [{"url": "https://example.test/source", "title": "Source"}]
        )
        self.assertNotIn("answer_revision", result)

    def test_invalid_urls_and_ranges_are_rejected(self) -> None:
        invalid = [
            citation(url="javascript:alert(1)"),
            citation(url="file:///tmp/private"),
            citation(url="https://user:password@example.test"),
            citation(url="not a url"),
            citation(start_index=-1),
            citation(start_index=3, end_index=2),
            citation(end_index=99),
            citation(start_index=True),
            citation(end_index=2.5),
        ]
        result = item_provenance(message(annotations=invalid + [citation()]))
        self.assertEqual(result["invalid"], len(invalid))
        self.assertEqual(len(result["sources"]), 1)

    def test_duplicate_annotations_do_not_duplicate_sources(self) -> None:
        result = item_provenance(message(annotations=[citation(), citation()]))
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["invalid"], 0)

    def test_non_assistant_and_unusable_items_are_ignored(self) -> None:
        for item in (
            {},
            {**message(), "id": ""},
            {**message(), "role": "user"},
            {**message(), "content": []},
        ):
            with self.subTest(item=item):
                self.assertIsNone(item_provenance(item))

    def test_source_limit_is_observable(self) -> None:
        rows = [
            citation(url=f"https://example.test/{index}")
            for index in range(PROVENANCE_SOURCE_LIMIT + 1)
        ]
        result = item_provenance(message(annotations=rows))
        self.assertEqual(len(result["sources"]), PROVENANCE_SOURCE_LIMIT)
        self.assertTrue(result["truncated"])

    def test_nonstream_and_terminal_response_preserve_same_record(self) -> None:
        item = message(annotations=[citation()])
        response = {"id": "response", "status": "completed", "output": [item]}
        expected = [item_provenance(item)]
        self.assertEqual(response_provenance(response), expected)
        self.assertEqual(
            response_provenance({"type": "response.completed", "response": response}), expected
        )
        self.assertEqual(response_provenance({**response, "status": "incomplete"}), [])

    def test_every_byte_split_and_crlf_preserve_unicode(self) -> None:
        item = message("😀原生引用", [citation()])
        expected = [item_provenance(item)]
        for newline in (b"\n", b"\r\n"):
            wire = event_bytes(item, newline)
            for split in range(len(wire) + 1):
                with self.subTest(newline=newline, split=split):
                    stream = ProvenanceStream()
                    self.assertEqual(
                        stream.feed(wire[:split]) + stream.feed(wire[split:]), expected
                    )
            stream = ProvenanceStream()
            records = []
            for value in wire:
                records.extend(stream.feed(bytes([value])))
            self.assertEqual(records, expected)

    def test_multiline_data_comments_and_done(self) -> None:
        item = message(annotations=[citation()])
        wire = b": keepalive\r\nevent: response.output_item.done\r\n"
        wire += b'data: {"type":"response.output_item.done",\r\n'
        wire += b'data: "item":' + json.dumps(item).encode() + b"}\r\n\r\n"
        wire += b"data: [DONE]\n\n"
        stream = ProvenanceStream()
        self.assertEqual(stream.feed(wire), [item_provenance(item)])
        self.assertEqual(stream.invalid_events, 0)

    def test_item_done_and_terminal_are_available_for_store_deduplication(self) -> None:
        item = message(annotations=[citation()])
        terminal = {
            "type": "response.completed",
            "response": {"status": "completed", "output": [item]},
        }
        wire = event_bytes(item) + b"data: " + json.dumps(terminal).encode() + b"\n\n"
        self.assertEqual(ProvenanceStream().feed(wire), [item_provenance(item)] * 2)

    def test_invalid_event_does_not_poison_following_event(self) -> None:
        item = message(annotations=[citation()])
        stream = ProvenanceStream()
        self.assertEqual(
            stream.feed(b"data: {broken}\n\ndata: []\n\n" + event_bytes(item)),
            [item_provenance(item)],
        )
        self.assertEqual(stream.invalid_events, 1)

    def test_oversize_event_is_dropped_and_parser_recovers(self) -> None:
        item = message(annotations=[citation()])
        wire = event_bytes(item)
        with patch("service.chat.service.provenance.PROVENANCE_EVENT_LIMIT", len(wire) + 10):
            stream = ProvenanceStream()
            self.assertEqual(stream.feed(b"data: " + b"x" * (len(wire) + 20)), [])
            self.assertEqual(stream.feed(b"\r\n\r\n" + wire), [item_provenance(item)])
            self.assertEqual(stream.invalid_events, 1)

    def test_oversize_event_recovers_only_after_blank_line(self) -> None:
        item = message(annotations=[citation()])
        wire = event_bytes(item)
        with patch("service.chat.service.provenance.PROVENANCE_EVENT_LIMIT", len(wire) + 10):
            stream = ProvenanceStream()
            self.assertEqual(stream.feed(b":" + b"x" * (len(wire) + 20)), [])
            self.assertEqual(stream.feed(b"\n"), [])
            self.assertEqual(stream.feed(wire), [])
            self.assertEqual(stream.feed(wire), [item_provenance(item)])
            self.assertEqual(stream.invalid_events, 1)


class NativeProvenanceLedgerContracts(unittest.IsolatedAsyncioTestCase):
    async def test_sources_bind_vendor_turn_and_reopen_without_memory_cache(self) -> None:
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
            live = LiveSession.__new__(LiveSession)
            live.id = "session"
            live.runtime_id = "codex"
            live.vendor_thread_id = "thread"
            live.active_product_turn_id = "client-turn"
            live.ledger = SimpleNamespace(active_turn_id="vendor-turn")
            live._events = ProductEventStore(database)
            live._persistence = PersistenceWorker()
            self.addAsyncCleanup(live._persistence.close)
            live._publication_lock = asyncio.Lock()
            live._broadcast_sequence = 0
            live._publication_error = None
            live._publication_task = None
            live._trace = Mock()
            live._logger = logging.getLogger(__name__)
            fields = item_provenance(message(annotations=[citation()]))
            with patch.object(live, "_broadcast_product_event"):
                await live.observe_sources("old-client-turn", fields)
                self.assertEqual(
                    live._events.turn_records(
                        "session",
                        "client-turn",
                        "vendor-turn",
                        kinds=(PRODUCT_EVENT_NATIVE_SOURCES,),
                    ),
                    (),
                )
                await live.observe_sources("client-turn", fields)
                await live.observe_sources("client-turn", fields)
            records = ProductEventStore(database).turn_records(
                "session", "client-turn", "vendor-turn", kinds=(PRODUCT_EVENT_NATIVE_SOURCES,)
            )
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0].vendor_turn_id, "vendor-turn")
            self.assertEqual(records[0].vendor_item_id, fields["item_id"])
            self.assertEqual(records[0].payload, {**fields, "client_turn_id": "client-turn"})
            live._model_bridge_failure = None
            live._trace = Mock()
            live._activity_observer = None
            cases = (
                (
                    "provided",
                    {"sources": [{"url": "https://example.test/search", "title": "Found"}]},
                    1,
                ),
                ("empty", {"sources": []}, 0),
                ("missing", {}, None),
            )
            with patch.object(live, "_broadcast_product_event"):
                for item_id, action, count in cases:
                    with self.subTest(search=item_id):
                        native = item_provenance(
                            {"id": item_id, "type": "web_search_call", "action": action}
                        )
                        await live.observe_sources("client-turn", native)
                        await live._project_runtime_event(
                            RuntimeEvent(
                                schema_version=1,
                                event_id=item_id,
                                runtime_id="codex",
                                product_session_id="session",
                                native_session_id="thread",
                                process_generation=1,
                                sequence=1,
                                kind=RuntimeEventKind.RUNTIME_EXTENSION,
                                delivery=DeliveryClass.MUST_PERSIST,
                                observed_at="2026-09-29T00:00:00Z",
                                native_turn_id="vendor-turn",
                                native_item_id=item_id,
                                payload={
                                    "extension_kind": "web_search_completed",
                                    "query": "Search",
                                    "action": {"type": "search"},
                                },
                            )
                        )
                        search_records = ProductEventStore(database).turn_records(
                            "session",
                            "client-turn",
                            "vendor-turn",
                            kinds=(PRODUCT_EVENT_WEB_SEARCH_COMPLETED,),
                        )
                        projected = next(
                            record.payload
                            for record in search_records
                            if record.vendor_item_id == item_id
                        )
                        if count is None:
                            self.assertNotIn("result_count", projected)
                            self.assertNotIn("results", projected)
                        else:
                            self.assertEqual(projected["result_count"], count)
                            self.assertEqual(projected["results"], native["sources"])
                            self.assertTrue(
                                all("end_utf16" not in source for source in projected["results"])
                            )
                late_search = item_provenance(
                    {
                        "id": "missing",
                        "type": "web_search_call",
                        "action": {
                            "sources": [
                                {"url": "https://example.test/late", "title": "Late search"}
                            ]
                        },
                    }
                )
                await live.observe_sources("client-turn", late_search)
                await live.observe_sources("client-turn", late_search)
                refreshed = ProductEventStore(database).turn_records(
                    "session",
                    "client-turn",
                    "vendor-turn",
                    kinds=(PRODUCT_EVENT_WEB_SEARCH_COMPLETED,),
                )
                matched = [record for record in refreshed if record.vendor_item_id == "missing"]
                self.assertEqual(len(matched), 2)
                self.assertEqual(matched[-1].payload["results"], late_search["sources"])
                self.assertEqual(matched[-1].payload["result_count"], 1)

                text = "晚到的原生引用😀"
                item = {**message(text, []), "id": "late-answer"}
                await live.publish(
                    PRODUCT_EVENT_MESSAGE_DELTA,
                    {"delta": text, "phase": "final_answer"},
                    turn_id="vendor-turn",
                    item_id="late-answer",
                )
                await live.observe_sources("client-turn", item_provenance(item))
                item["content"][0]["annotations"] = [citation(start_index=0, end_index=len(text))]
                await live.observe_sources("client-turn", item_provenance(item))
                await live.observe_sources("client-turn", item_provenance(item))
                answers = ProductEventStore(database).turn_records(
                    "session", "client-turn", "vendor-turn", kinds=(PRODUCT_EVENT_ANSWER_SOURCES,)
                )
                matched_answers = [
                    record for record in answers if record.vendor_item_id == "late-answer"
                ]
                self.assertEqual(len(matched_answers), 2)
                self.assertEqual(matched_answers[0].payload["native_citations"]["status"], "empty")
                self.assertEqual(
                    matched_answers[-1].payload["native_citations"]["status"], "available"
                )
                self.assertEqual(
                    matched_answers[-1].payload["sources"][0]["occurrences"],
                    [{"start_utf16": 0, "end_utf16": len(text) + 1}],
                )
                wrong_text = {**message("另一个不相同的回答", [citation()]), "id": "late-answer"}
                await live.observe_sources("client-turn", item_provenance(wrong_text))
                after_mismatch = ProductEventStore(database).turn_records(
                    "session", "client-turn", "vendor-turn", kinds=(PRODUCT_EVENT_ANSWER_SOURCES,)
                )
                self.assertEqual(len(after_mismatch), len(answers))


if __name__ == "__main__":
    unittest.main()
