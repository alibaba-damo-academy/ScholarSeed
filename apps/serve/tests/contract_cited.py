"""Contracts for cited-paper publication through literature search results."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD, PRODUCT_EVENT_VERSION
from service.chat.persistence.events import ProductEventRecord
from service.chat.service.events import EventService
from service.literature.api.result import register_result_routes
from service.literature.service.cited import CITATIONS_ORIGIN, prepare_citations, project_citations
from service.literature.service.result import search_card_slot
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import LITERATURE_RESULT_ROUTE
from service.platform.vocabulary import BRIDGE_SESSION_HEADER, BRIDGE_TOKEN_HEADER


class CitationContract(unittest.TestCase):
    def test_publication_and_snapshot_read_do_not_enter_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "ideas"
            run.mkdir()
            value = {
                "references": [
                    {"ref_id": f"R{index}", "title": f"Cited paper {index}"} for index in range(8)
                ]
            }
            (run / "references.json").write_text(json.dumps(value), encoding="utf-8")
            (run / "literature_report.md").write_text("Prior art", encoding="utf-8")
            snapshots = {}
            cards = []
            activities = Activities()
            turn = activities.enter(ActivityDomain.TURN)
            self.addCleanup(turn.close)

            async def publish_artifact(path, role, **scope):
                snapshots[path] = (root / path).read_bytes()
                return {"artifact_id": path, "sha256": scope["expected_sha256"], "path": path}

            async def display_card(kind, content, **scope):
                cards.append({"type": kind, "card_id": "cited", "content": content.data})
                return cards[-1]

            live = SimpleNamespace(
                id="s1",
                bridge_token="private",
                publication_turn_id="t1",
                runtime_workdir=root,
                turn_activity=turn,
                publish_artifact=publish_artifact,
                display_card=display_card,
            )
            sessions = SimpleNamespace(bridge_caller=lambda key: live if key == live.id else None)
            authorizer = Mock()
            gate = Mock()
            app = FastAPI()
            register_result_routes(
                app,
                sessions,
                SimpleNamespace(require=lambda *args: None),
                SimpleNamespace(),
                Mock(),
                SimpleNamespace(
                    export_bytes=lambda session, artifact, digest: (snapshots[artifact], artifact)
                ),
                gate,
                authorizer,
                activities=activities,
            )
            with TestClient(app) as client:
                response = client.post(
                    LITERATURE_RESULT_ROUTE,
                    headers={
                        BRIDGE_SESSION_HEADER: live.id,
                        BRIDGE_TOKEN_HEADER: live.bridge_token,
                    },
                    json={"run": "ideas", "checkpoint": "citations"},
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertNotIn("authorization", response.json())
                self.assertEqual(len(cards[0]["content"]["papers"]), 3)
                self.assertFalse(cards[0]["content"]["selection"])
                (run / "references.json").unlink()
                with patch("service.literature.api.result.session_cards", return_value=cards):
                    restored = client.get("/api/sessions/s1/literature/results/cited")
                self.assertEqual(restored.status_code, 200, restored.text)
                self.assertEqual(len(restored.json()["papers"]), 8)
                self.assertEqual(restored.json()["origin"], CITATIONS_ORIGIN)
            self.assertEqual(authorizer.mock_calls, [])
            self.assertEqual(gate.mock_calls, [])

    def test_retired_list_is_hidden_without_mutating_saved_events(self) -> None:
        record = ProductEventRecord(
            event_id=1,
            session_id="s1",
            runtime_id="codex",
            vendor_thread_id="thread-1",
            vendor_turn_id=None,
            vendor_item_id=None,
            schema_version=PRODUCT_EVENT_VERSION,
            idempotency_key="retired-card",
            created_at=1.0,
            kind=PRODUCT_EVENT_DISPLAY_CARD,
            payload={"type": "literature-references"},
            product_seq=1,
        )
        events = Mock()
        events.replay.return_value = [record]
        self.assertEqual(EventService({}, events, Mock()).activity_snapshot("s1"), [])
        self.assertEqual(events.method_calls[0][0], "replay")
        self.assertEqual(record.payload["type"], "literature-references")

    def test_citations_have_an_independent_slot_and_no_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run = root / "ideas"
            run.mkdir()
            (run / "references.json").write_text(
                json.dumps({"references": [{"ref_id": "R1", "title": "Cited paper"}]}),
                encoding="utf-8",
            )
            (run / "literature_report.md").write_text("Prior art", encoding="utf-8")
            prepared = prepare_citations(root, "ideas")
            self.assertEqual(prepared.card.origin, CITATIONS_ORIGIN)
            self.assertEqual(prepared.card.retained, 1)
            self.assertEqual(prepared.authorization_refs, ())
            self.assertFalse(prepared.card.selection)
            self.assertFalse(prepared.card.fulltext)
            candidate = prepared.card.model_copy(update={"origin": "agentic-search"})
            self.assertNotEqual(
                search_card_slot(prepared.card.model_dump()),
                search_card_slot(candidate.model_dump()),
            )

    def test_complete_cited_subset_preserves_titles_authors_and_links(self) -> None:
        title = "A long title " * 500
        authors = [f"Author {index}" for index in range(45)]
        papers = project_citations(
            {
                "references": [
                    {"ref_id": "R1", "title": title, "authors": authors, "arxiv_id": "2305.12345"},
                    {"ref_id": "R2", "title": "Another cited paper", "doi": "10.1000/example"},
                ]
            },
            complete=True,
        )
        self.assertEqual(len(papers), 2)
        self.assertEqual(papers[0].title, title.strip())
        self.assertEqual(papers[0].authors, authors)
        self.assertEqual(papers[0].url, "https://arxiv.org/abs/2305.12345")
        self.assertEqual(papers[1].url, "https://doi.org/10.1000/example")

    def test_invalid_citations_and_unsafe_paths_fail(self) -> None:
        with self.assertRaises(ValueError):
            project_citations({"references": [{"title": "  "}]})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                prepare_citations(Path(directory), "../outside")


if __name__ == "__main__":
    unittest.main()
