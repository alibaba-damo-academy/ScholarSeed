"""Deterministic display-card bridge and payload contracts."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft7Validator

from service.capabilities.service.skills import SkillCatalog
from service.chat.api.cards import register_card_routes
from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.live import LiveSession
from service.chat.service.cards import (
    DISPLAY_CARD_MAX_PER_TURN,
    CardRegistry,
    DisplayCardError,
    card_identity,
    normalize_card,
)
from service.chat.service.events import HISTORY_ACTIVITY_EVENT_KINDS, EventService
from service.cli.bridge import parser
from service.literature.service.cards import (
    LITERATURE_REFERENCES_CARD,
    validate_references_card,
)
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    DisplayCard,
    DisplayCardContent,
)

SESSION_ID = "display-card-session"
BRIDGE_TOKEN = "display-card-token"
TURN_ID = "display-card-turn"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "display-card-vendor-thread"
REFERENCES_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "skills/community/research-idea-partner/references.schema.json"
)


def reference_payload() -> dict:
    return {
        "schema_version": "1.0",
        "project": "agent-ui",
        "references": [
            {
                "ref_id": "R1",
                "paper_id": "unified_1",
                "id_source": "paperhub",
                "title_key": None,
                "doi": None,
                "arxiv_id": "2305.18290",
                "url": "https://arxiv.org/abs/2305.18290",
                "title": "A useful paper",
                "authors": ["A. Researcher"],
                "year": 2024,
                "venue": "TestConf",
                "cited_by": ["idea-1"],
                "claim": "A scoped claim",
                "verification": "verified",
                "evidence": "Section 3",
                "has_fulltext": True,
            }
        ],
    }


class DisplayCardContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="display-card-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.registry = CardRegistry()
        self.registry.register(LITERATURE_REFERENCES_CARD, validate_references_card)

    def test_cli_uses_single_display_card_command(self) -> None:
        args = parser().parse_args(
            [
                "display-card",
                "--json",
                '{"type":"literature-references","content":{"data":{}}}',
            ]
        )
        self.assertEqual((args.capability, args.operation), ("display-card", "publish"))

    def test_request_requires_exactly_one_content_source(self) -> None:
        with self.assertRaises(ValueError):
            DisplayCard.model_validate({"type": LITERATURE_REFERENCES_CARD, "content": {}})
        with self.assertRaises(ValueError):
            DisplayCard.model_validate(
                {
                    "type": LITERATURE_REFERENCES_CARD,
                    "content": {"path": "references.json", "data": {}},
                }
            )

    def test_minimal_payload_and_optional_metadata(self) -> None:
        payload = {
            "schema_version": "2",
            "source": "external",
            "references": [
                {
                    "title": f"Paper {index}",
                    "actions": ["ignored"],
                    "verification": "other",
                    "authors": None,
                    "year": "unknown",
                    "url": "javascript:alert(1)",
                }
                for index in range(45)
            ],
        }
        schema = json.loads(REFERENCES_SCHEMA.read_text(encoding="utf-8"))
        self.assertTrue(Draft7Validator(schema).is_valid(payload))
        normalized = self.registry.validate(LITERATURE_REFERENCES_CARD, payload)
        self.assertEqual(len(normalized["references"]), 45)
        self.assertEqual(normalized["schema_version"], "1.0")
        self.assertEqual(len({row["ref_id"] for row in normalized["references"]}), 45)
        for row in normalized["references"]:
            self.assertEqual(row["verification"], "unverified")
            self.assertEqual(row["authors"], [])
            self.assertIsNone(row["year"])
            self.assertIsNone(row["url"])
            self.assertNotIn("actions", row)
        for invalid in (
            {},
            {"references": {}},
            {"references": [{}]},
            {"references": [{"title": "  "}]},
        ):
            with self.assertRaises(DisplayCardError):
                self.registry.validate(LITERATURE_REFERENCES_CARD, invalid)

    def test_display_keeps_long_titles_and_complete_author_lists(self) -> None:
        payload = {"references": [{"title": "Long " * 500, "authors": ["Author"] * 45}]}
        normalized = self.registry.validate(LITERATURE_REFERENCES_CARD, payload)
        self.assertEqual(normalized["references"][0]["title"], payload["references"][0]["title"])
        self.assertEqual(len(normalized["references"][0]["authors"]), 45)

    def test_inline_and_path_content_have_same_digest(self) -> None:
        payload = reference_payload()
        source = self.root / "references.json"
        source.write_text(json.dumps(payload), encoding="utf-8")
        inline, inline_digest, inline_size = normalize_card(
            self.root,
            self.registry,
            LITERATURE_REFERENCES_CARD,
            DisplayCardContent(data=payload),
        )
        stored, stored_digest, stored_size = normalize_card(
            self.root,
            self.registry,
            LITERATURE_REFERENCES_CARD,
            DisplayCardContent(path="references.json"),
        )
        self.assertEqual(inline, stored)
        self.assertEqual(inline_digest, stored_digest)
        self.assertEqual(inline_size, stored_size)

    def test_card_identity_is_stable_and_turn_scoped(self) -> None:
        first = card_identity("session", "turn-1", LITERATURE_REFERENCES_CARD, "abc")
        repeated = card_identity("session", "turn-1", LITERATURE_REFERENCES_CARD, "abc")
        next_turn = card_identity("session", "turn-2", LITERATURE_REFERENCES_CARD, "abc")
        self.assertEqual(first, repeated)
        self.assertNotEqual(first, next_turn)

    def test_unknown_type_path_escape_and_unsafe_url_fail(self) -> None:
        with self.assertRaisesRegex(DisplayCardError, "display_card_type_unknown"):
            normalize_card(self.root, self.registry, "unknown", DisplayCardContent(data={}))
        with self.assertRaisesRegex(DisplayCardError, "display_card_path_invalid"):
            normalize_card(
                self.root,
                self.registry,
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(path="../references.json"),
            )
        with self.assertRaisesRegex(DisplayCardError, "display_card_path_invalid"):
            normalize_card(
                self.root,
                self.registry,
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(path="bad\0path.json"),
            )

    def test_duplicate_handles_preserve_all_references(self) -> None:
        payload = reference_payload()
        payload["references"].append(dict(payload["references"][0]))
        payload["references"].append({"title": "Minimal", "ref_id": "R2"})
        normalized = self.registry.validate(LITERATURE_REFERENCES_CARD, payload)
        self.assertEqual(len(normalized["references"]), 3)
        handles = [row["ref_id"] for row in normalized["references"]]
        self.assertEqual(len(set(handles)), 3)
        self.assertEqual(handles[0], "R1")
        self.assertEqual(handles[2], "R2")

    def test_display_card_is_part_of_durable_history_snapshot(self) -> None:
        self.assertIn(PRODUCT_EVENT_DISPLAY_CARD, HISTORY_ACTIVITY_EVENT_KINDS)

    def _live(self) -> tuple[LiveSession, ProductEventStore]:
        database = self.root / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        if catalog.get(SESSION_ID) is None:
            catalog.register(
                SESSION_ID,
                SessionPrincipal("display-card-owner"),
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_session_id=None,
                runtime_workdir=str(self.root),
                project_path=None,
                output_root=str(self.root / "outputs"),
                codex_version="contract",
                model_id="contract",
                policy_id="on-request",
                status=SessionStatus.READY,
                title="display card contract",
                created_at=1.0,
            )
        events = ProductEventStore(database)
        logger = SimpleNamespace(
            debug=lambda *_args, **_kwargs: None,
            info=lambda *_args, **_kwargs: None,
            warning=lambda *_args, **_kwargs: None,
            error=lambda *_args, **_kwargs: None,
        )
        trace = SessionTrace(
            SESSION_ID,
            self.root,
            runtime_id=RUNTIME_ID,
            trace_dir=self.root / "trace",
        )
        self.addCleanup(trace.close)
        live = LiveSession(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            runtime_workdir=self.root,
            project_path=None,
            output_root=self.root / "outputs",
            model_id="contract",
            catalog=catalog,
            events=events,
            artifacts=SessionArtifactStore(database),
            skills=SkillCatalog(
                bundled_root=self.root / "bundled-skills",
                user_root=self.root / "user-skills",
            ),
            logger=logger,
            trace=trace,
            cards=self.registry,
        )
        live.vendor_thread_id = VENDOR_THREAD_ID
        return live, events

    def test_snapshot_is_idempotent_and_survives_source_deletion_and_reopen(self) -> None:
        source = self.root / "references.json"
        source.write_text(json.dumps(reference_payload()), encoding="utf-8")
        live, events = self._live()
        first = asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(path=source.name),
                turn_id=TURN_ID,
            )
        )
        repeated = asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(path=source.name),
                turn_id=TURN_ID,
            )
        )
        source.unlink()
        reopened = ProductEventStore(events.database)
        snapshot = EventService({}, reopened, SimpleNamespace()).activity_snapshot(SESSION_ID)
        self.assertEqual(first, repeated)
        self.assertEqual(len(reopened.replay(SESSION_ID)), 1)
        self.assertEqual(snapshot[0]["type"], PRODUCT_EVENT_DISPLAY_CARD)
        self.assertEqual(snapshot[0]["data"], first)

    def test_turn_card_count_limit_does_not_charge_idempotent_retry(self) -> None:
        live, events = self._live()
        first_payload = reference_payload()
        first = asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(data=first_payload),
                turn_id=TURN_ID,
            )
        )
        repeated = asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(data=first_payload),
                turn_id=TURN_ID,
            )
        )
        for index in range(1, DISPLAY_CARD_MAX_PER_TURN):
            payload = reference_payload()
            payload["project"] = f"project-{index}"
            asyncio.run(
                live.display_card(
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(data=payload),
                    turn_id=TURN_ID,
                )
            )
        overflow = reference_payload()
        overflow["project"] = "overflow"
        with self.assertRaisesRegex(DisplayCardError, "display_card_turn_limit_exceeded"):
            asyncio.run(
                live.display_card(
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(data=overflow),
                    turn_id=TURN_ID,
                )
            )
        self.assertEqual(first, repeated)
        self.assertEqual(len(events.replay(SESSION_ID)), DISPLAY_CARD_MAX_PER_TURN)

    def test_turn_card_byte_budget_is_cumulative(self) -> None:
        live, _events = self._live()
        payload = reference_payload()
        template = payload["references"][0]
        payload["references"] = []
        for index in range(10):
            reference = dict(template)
            reference["ref_id"] = f"R{index}"
            reference["title"] = f"{index}-" + ("t" * 1_500)
            reference["claim"] = "c" * 1_500
            reference["evidence"] = "e" * 1_500
            payload["references"].append(reference)
        for index in range(2):
            value = dict(payload)
            value["project"] = f"large-{index}"
            asyncio.run(
                live.display_card(
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(data=value),
                    turn_id=TURN_ID,
                )
            )
        overflow = dict(payload)
        overflow["project"] = "large-overflow"
        with self.assertRaisesRegex(DisplayCardError, "display_card_turn_bytes_exceeded"):
            asyncio.run(
                live.display_card(
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(data=overflow),
                    turn_id=TURN_ID,
                )
            )

    def test_route_requires_active_authenticated_turn(self) -> None:
        published = []

        async def display_card(card_type, content, *, turn_id):
            published.append((card_type, content, turn_id))
            return {"card_id": "card-1", "type": card_type, "content": content.data}

        caller = SimpleNamespace(
            id=SESSION_ID,
            bridge_token=BRIDGE_TOKEN,
            publication_turn_id=TURN_ID,
            display_card=display_card,
        )
        app = FastAPI()
        register_card_routes(app, lambda scope_id: caller if scope_id == SESSION_ID else None)
        headers = {
            BRIDGE_SESSION_HEADER: SESSION_ID,
            BRIDGE_TOKEN_HEADER: BRIDGE_TOKEN,
        }
        with TestClient(app) as client:
            denied = client.post(
                "/api/internal/bridge/display-card",
                json={"type": LITERATURE_REFERENCES_CARD, "content": {"data": {}}},
            )
            accepted = client.post(
                "/api/internal/bridge/display-card",
                headers=headers,
                json={
                    "type": LITERATURE_REFERENCES_CARD,
                    "content": {"data": reference_payload()},
                },
            )
            caller.publication_turn_id = ""
            inactive = client.post(
                "/api/internal/bridge/display-card",
                headers=headers,
                json={
                    "type": LITERATURE_REFERENCES_CARD,
                    "content": {"data": reference_payload()},
                },
            )
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(inactive.status_code, 403)
        self.assertEqual(len(published), 1)
        self.assertEqual(published[0][2], TURN_ID)


if __name__ == "__main__":
    unittest.main()
