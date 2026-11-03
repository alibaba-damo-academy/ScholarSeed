"""Deterministic display-card bridge and payload contracts."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft7Validator

from service.assistant.service.nextsteps import NEXT_STEPS_CARD, validate_next_steps_card
from service.capabilities.service.components import ComponentRegistry
from service.capabilities.service.descriptor import validate_component_value
from service.capabilities.service.skills import SkillCatalog
from service.chat.api.cards import register_card_routes
from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.evidence import SessionTrace
from service.chat.runtime.live import LiveSession
from service.chat.service.cards import (
    DISPLAY_CARD_PATH_UNAVAILABLE,
    CardRegistry,
    DisplayCardError,
    card_identity,
    normalize_card,
)
from service.chat.service.events import HISTORY_ACTIVITY_EVENT_KINDS, EventService
from service.cli.bridge import parser
from service.literature.domain.delivery import (
    DELIVERY_CARD,
    delivery_card_slot,
    validate_delivery_card,
)
from service.literature.service.cards import (
    LITERATURE_REFERENCES_CARD,
    validate_references_card,
)
from service.literature.service.downloads import (
    DOWNLOADS_CARD,
    download_card_slot,
    validate_download_card,
)
from service.literature.service.result import SEARCH_CARD, search_card_slot, validate_search_card
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BLOCKING_OPERATIONS,
    COMPONENT_CAPABILITY,
    COMPONENT_REQUEST_OPERATION,
    PLUGIN_INSTALL_ROUTE,
    ComponentInvocation,
    DisplayCard,
    DisplayCardContent,
    PluginInstallation,
)
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
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

    def test_cli_component_commands_use_registered_contracts_and_request_waits(self) -> None:
        for operation in ("catalog", "request", "display"):
            args = parser().parse_args(["component", operation, "--json", "{}"])
            self.assertEqual((args.capability, args.operation), ("component", operation))
        self.assertIn((COMPONENT_CAPABILITY, COMPONENT_REQUEST_OPERATION), BLOCKING_OPERATIONS)

    def test_component_display_pins_identical_request_and_rejects_reuse(self) -> None:
        live, events = self._live()
        components = Mock()
        reference = {"plugin": "comparison", "component": "matrix", "fingerprint": "fixed"}
        components.resolve.return_value = reference
        components.snapshot.return_value = {
            "descriptor": {"components": [{"id": "matrix", "actions": []}]}
        }
        live._skills = SimpleNamespace(components=components)
        command = ComponentInvocation(
            request_id="show", slot="custom.matrix", data={"papers": ["A"]}, title="Papers"
        )
        first = asyncio.run(live.component_interaction(command, turn_id=TURN_ID, waiting=False))
        components.resolve.return_value = {**reference, "fingerprint": "updated"}
        self.assertEqual(
            asyncio.run(live.component_interaction(command, turn_id=TURN_ID, waiting=False)), first
        )
        components.resolve.assert_called_once()
        self.assertEqual(first["type"], "plugin-component")
        self.assertEqual(len(events.replay(SESSION_ID)), 1)
        with self.assertRaisesRegex(ValueError, "component_request_conflict"):
            asyncio.run(
                live.component_interaction(
                    command.model_copy(update={"data": {}}), turn_id=TURN_ID, waiting=False
                )
            )

    def test_display_snapshot_retains_revision_data_and_draft_after_disable_and_update(
        self,
    ) -> None:
        live, events = self._live()
        registry = ComponentRegistry(self.root / "components.sqlite3")
        snapshot = {
            "fingerprint": "revision-one",
            "descriptor": {
                "id": "comparison",
                "components": [{"id": "matrix", "slot": "custom.matrix", "actions": []}],
            },
            "files": {"card.js": "first"},
            "scenarios": {},
        }
        registry.publish([snapshot])
        live._skills.components = registry
        command = ComponentInvocation(
            request_id="show", slot="custom.matrix", data={"papers": ["A"]}, title="Papers"
        )
        first = asyncio.run(live.component_interaction(command, turn_id=TURN_ID, waiting=False))
        reference = first["component"]
        registry.draft(
            reference,
            session_id=SESSION_ID,
            user_id=live.user_id,
            values={"selected": ["A"]},
            expected_revision=0,
        )
        registry.publish([])
        registry.validate(reference, session_id=SESSION_ID, user_id=live.user_id)
        registry.publish(
            [{**snapshot, "fingerprint": "revision-two", "files": {"card.js": "second"}}]
        )
        repeated = asyncio.run(live.component_interaction(command, turn_id=TURN_ID, waiting=False))
        self.assertEqual(repeated, first)
        retained = registry.snapshot(reference, user_id=live.user_id)
        self.assertEqual(retained["files"], {"card.js": "first"})
        self.assertEqual(retained["interaction"]["data"], {"papers": ["A"]})
        self.assertEqual(retained["interaction"]["state"], {"selected": ["A"]})
        next_card = asyncio.run(
            live.component_interaction(
                command.model_copy(update={"request_id": "next"}), turn_id=TURN_ID, waiting=False
            )
        )
        self.assertEqual(next_card["component"]["fingerprint"], "revision-two")
        self.assertEqual(len(events.replay(SESSION_ID)), 2)

    def test_generic_component_cannot_forge_host_business_card(self) -> None:
        live, _ = self._live()
        components = Mock()
        components.resolve.return_value = {
            "plugin": "host",
            "component": "literature.authorization",
            "fingerprint": "host-v1",
        }
        live._skills = SimpleNamespace(components=components)
        command = ComponentInvocation(
            request_id="fake", slot="literature.authorization", data={}, title="Authorize"
        )
        with self.assertRaisesRegex(ValueError, "component_requires_domain_publication"):
            asyncio.run(live.component_interaction(command, turn_id=TURN_ID, waiting=False))
        components.bind_data.assert_not_called()

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

    def test_unreadable_card_path_has_stable_failure(self) -> None:
        source = self.root / "references.json"
        source.write_text(json.dumps(reference_payload()), encoding="utf-8")
        with patch.object(Path, "stat", side_effect=PermissionError(13, "denied")):
            with self.assertRaisesRegex(DisplayCardError, DISPLAY_CARD_PATH_UNAVAILABLE):
                normalize_card(
                    self.root,
                    self.registry,
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(path=source.name),
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

    def test_installation_publication_is_nonblocking_and_revision_bound(self) -> None:
        live, _events = self._live()
        first = PluginInstallation(request_id="revision-one", path="v1.zip", sha256="a" * 64)
        second = PluginInstallation(request_id="revision-two", path="v2.zip", sha256="b" * 64)
        reports = [
            {"valid": True, "descriptor": {"id": "example", "version": version}, "sha256": digest}
            for version, digest in [("1.0.0", first.sha256), ("1.0.1", second.sha256)]
        ]

        async def publish(command: PluginInstallation) -> dict:
            return await asyncio.wait_for(live.plugin_installation(command, turn_id=TURN_ID), 1)

        with patch.object(live._skills, "installation_report", side_effect=reports) as inspect:
            receipt = asyncio.run(publish(first))
            self.assertTrue(receipt["published"])
            self.assertNotIn("installed", receipt)
            self.assertEqual(asyncio.run(publish(first)), receipt)
            with self.assertRaisesRegex(ValueError, "plugin_installation_request_conflict"):
                asyncio.run(publish(first.model_copy(update={"sha256": second.sha256})))
            updated = asyncio.run(publish(second))
            self.assertEqual(inspect.call_count, 2)
        self.assertEqual(live._catalog.pending_hil(SESSION_ID), ())
        self.assertEqual(live.pending_hil_snapshot(), [])
        self.assertEqual(asyncio.run(live.previous_turn_blockers()), ())
        self.assertEqual(len(live.pending_hil_snapshot(blocking_only=False)), 2)
        records = live._catalog.pending_hil(SESSION_ID, blocking_only=False)
        self.assertEqual(len(records), 2)
        old = live._catalog.hil(receipt["request_id"])
        new = live._catalog.hil(updated["request_id"])
        self.assertFalse(old.payload["blocking"])
        self.assertEqual(old.payload["questions"][0]["installation_path"], "v1.zip")
        self.assertEqual(new.payload["questions"][0]["installation_path"], "v2.zip")
        self.assertEqual(receipt["package"]["version"], "1.0.0")
        self.assertEqual(updated["package"]["version"], "1.0.1")

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

    def test_component_reference_is_durable_and_part_of_card_identity(self) -> None:
        live, events = self._live()
        reference = {"plugin": "example", "component": "references", "fingerprint": "first"}

        async def resolve(slot, *, skill_name="", interaction_id=""):
            self.assertEqual(slot, "display.literature-references")
            self.assertEqual(skill_name, "example")
            return reference.copy()

        live.component_for = resolve
        live._skills = SimpleNamespace(components=Mock())
        content = DisplayCardContent(data=reference_payload(), skill="example")
        first = asyncio.run(live.display_card(LITERATURE_REFERENCES_CARD, content, turn_id=TURN_ID))
        repeated = asyncio.run(
            live.display_card(LITERATURE_REFERENCES_CARD, content, turn_id=TURN_ID)
        )
        self.assertEqual(first, repeated)
        reference["fingerprint"] = "second"
        second = asyncio.run(
            live.display_card(LITERATURE_REFERENCES_CARD, content, turn_id=TURN_ID)
        )
        self.assertNotEqual(first["card_id"], second["card_id"])
        self.assertEqual(first["component"]["fingerprint"], "first")
        reopened = ProductEventStore(events.database)
        snapshot = EventService({}, reopened, SimpleNamespace()).activity_snapshot(SESSION_ID)
        self.assertEqual(
            [item["data"]["component"]["fingerprint"] for item in snapshot], ["first", "second"]
        )

    def test_next_steps_publish_without_creating_a_pending_question(self) -> None:
        self.registry.register(NEXT_STEPS_CARD, validate_next_steps_card)
        live, events = self._live()
        payload = {
            "title": "Next step",
            "options": [
                {"label": "Deep", "description": "Check prior work."},
                {"label": "Validation", "description": "Design the experiment."},
            ],
            "free_text_label": "Other requests",
            "submit_label": "Send",
        }
        activities = Activities()
        lease = activities.enter(ActivityDomain.TURN)
        self.addCleanup(lease.close)
        caller = SimpleNamespace(
            id=SESSION_ID,
            bridge_token=BRIDGE_TOKEN,
            publication_turn_id=TURN_ID,
            bridge_activity=lease,
            display_card=live.display_card,
        )
        app = FastAPI()
        register_card_routes(app, lambda _: caller, self.registry, activities=activities)
        with TestClient(app) as client:
            response = client.post(
                "/api/internal/bridge/display-card",
                headers={BRIDGE_SESSION_HEADER: SESSION_ID, BRIDGE_TOKEN_HEADER: BRIDGE_TOKEN},
                json={"type": NEXT_STEPS_CARD, "content": {"data": payload}},
            )
        self.assertEqual(response.status_code, 200, response.text)
        card = response.json()["card"]
        records = events.replay(SESSION_ID)
        self.assertEqual([record.kind for record in records], [PRODUCT_EVENT_DISPLAY_CARD])
        self.assertEqual(card["content"], payload)
        self.assertEqual(card["type"], NEXT_STEPS_CARD)
        reopened = ProductEventStore(events.database)
        self.assertEqual(reopened.replay(SESSION_ID)[0].payload, card)

    def test_turn_accepts_more_than_four_cards_and_keeps_idempotent_retry(self) -> None:
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
        for index in range(1, 8):
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
        asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(data=overflow),
                turn_id=TURN_ID,
            )
        )
        self.assertEqual(first, repeated)
        self.assertEqual(len(events.replay(SESSION_ID)), 9)

    def test_product_slot_can_return_to_an_earlier_payload_and_replay_latest(self) -> None:
        self.registry.register("product-slot", dict, direct=False, slot=lambda value: value["slot"])
        live, events = self._live()
        first = asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "run",
                        "revision": 1,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "run",
                        "revision": 2,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        third = asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "run",
                        "revision": 1,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        repeated = asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "run",
                        "revision": 1,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        self.assertEqual(len(events.replay(SESSION_ID)), 3)
        self.assertEqual(events.replay(SESSION_ID)[-1].payload, third)
        self.assertNotEqual(first["card_id"], third["card_id"])
        self.assertEqual(third, repeated)

    def test_product_slots_preserve_snapshots_and_reopened_byte_budget(self) -> None:
        self.registry.register(
            "product-stage",
            dict,
            direct=False,
            slot=lambda value: value["slot"],
        )
        live, events = self._live()
        for index in range(6):
            asyncio.run(
                live.display_card(
                    "product-stage",
                    DisplayCardContent(data={"slot": str(index), "revision": 1}),
                    turn_id=TURN_ID,
                )
            )
        for index in range(3):
            payload = reference_payload()
            payload["project"] = f"project-{index}"
            asyncio.run(
                live.display_card(
                    LITERATURE_REFERENCES_CARD,
                    DisplayCardContent(data=payload),
                    turn_id=TURN_ID,
                )
            )
        live, reopened = self._live()
        payload = {"slot": "next-round", "revision": 1}
        first = asyncio.run(
            live.display_card(
                "product-stage",
                DisplayCardContent(data=payload),
                turn_id=TURN_ID,
            )
        )
        self.assertEqual(
            first,
            asyncio.run(
                live.display_card(
                    "product-stage",
                    DisplayCardContent(data=payload),
                    turn_id=TURN_ID,
                )
            ),
        )
        overflow = reference_payload()
        overflow["project"] = "overflow"
        asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(data=overflow),
                turn_id=TURN_ID,
            )
        )
        records = reopened.replay(SESSION_ID)
        stages = [record for record in records if record.payload["type"] == "product-stage"]
        self.assertEqual(len(stages), 7)
        self.assertEqual(len({record.vendor_item_id for record in stages}), len(stages))
        for index in range(2):
            asyncio.run(
                live.display_card(
                    "product-stage",
                    DisplayCardContent(
                        data={"slot": "next-round", "text": "x" * 48_000, "revision": index}
                    ),
                    turn_id=TURN_ID,
                )
            )
        with self.assertRaisesRegex(DisplayCardError, "display_card_turn_bytes_exceeded"):
            asyncio.run(
                live.display_card(
                    "product-stage",
                    DisplayCardContent(
                        data={"slot": "next-round", "text": "x" * 48_000, "revision": 3}
                    ),
                    turn_id=TURN_ID,
                )
            )
        asyncio.run(
            live.display_card(
                LITERATURE_REFERENCES_CARD,
                DisplayCardContent(data=overflow),
                turn_id="next-user-turn",
            )
        )

    def test_literature_rounds_and_delivery_batches_keep_independent_snapshots(self) -> None:
        for card_type, validator, selector in (
            (SEARCH_CARD, validate_search_card, search_card_slot),
            (DOWNLOADS_CARD, validate_download_card, download_card_slot),
            (DELIVERY_CARD, validate_delivery_card, delivery_card_slot),
        ):
            self.registry.register(card_type, validator, direct=False, slot=selector)
        live, events = self._live()
        search = {
            "session_id": SESSION_ID,
            "run_id": "run",
            "round": 1,
            "criteria": [],
            "status": "success",
            "sources": [],
            "candidates": 20,
            "deduplicated": 20,
            "retained": 20,
            "papers": [],
            "warnings": [],
        }
        downloads = {"session_id": SESSION_ID, "run": "run", "project_id": "project", "papers": []}
        delivery = {
            "session_id": SESSION_ID,
            "delivery_id": "batch-one",
            "project_id": "project",
            "count": 19,
        }

        def publish(card_type, value):
            return asyncio.run(
                live.display_card(card_type, DisplayCardContent(data=value), turn_id=TURN_ID)
            )

        first = publish(SEARCH_CARD, search)
        publish(SEARCH_CARD, {**search, "selection": {"path": "selection.json"}})
        publish(DOWNLOADS_CARD, downloads)
        first_delivery = publish(DELIVERY_CARD, delivery)
        updated_delivery = publish(DELIVERY_CARD, {**delivery, "count": 20})
        second_delivery = publish(
            DELIVERY_CARD, {**delivery, "delivery_id": "batch-two", "count": 1}
        )
        second = publish(SEARCH_CARD, {**search, "round": 2})
        publish(SEARCH_CARD, {**search, "round": 2, "selection": {"path": "selection-2.json"}})
        publish(DOWNLOADS_CARD, {**downloads, "omitted_papers": 1})
        publish(SEARCH_CARD, search)
        self.assertNotEqual(first["card_id"], second["card_id"])
        self.assertNotEqual(first_delivery["card_id"], updated_delivery["card_id"])
        self.assertNotEqual(updated_delivery["card_id"], second_delivery["card_id"])
        reopened = ProductEventStore(events.database)
        records = reopened.replay(SESSION_ID)
        self.assertEqual(len(records), 10)
        self.assertEqual(len({record.vendor_item_id for record in records}), 5)
        self.assertEqual(records[-1].payload["content"], first["content"])
        search_slots = [
            record.vendor_item_id for record in records if record.payload["type"] == SEARCH_CARD
        ]
        self.assertEqual(search_slots[0], search_slots[1])
        self.assertNotEqual(search_slots[0], search_slots[2])
        self.assertEqual(search_slots[0], search_slots[-1])
        for changed in (
            {**search, "session_id": "another-session"},
            {**search, "run_id": "another-run"},
            {**search, "origin": "agentic-search"},
        ):
            self.assertNotEqual(search_card_slot(search), search_card_slot(changed))
        self.assertNotEqual(
            delivery_card_slot(delivery),
            delivery_card_slot({**delivery, "project_id": "other-project"}),
        )

    def test_product_slot_updates_preserve_cumulative_byte_limit_without_count_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "display_card_slot_requires_product_owner"):
            self.registry.register("untrusted-slot", dict, slot=lambda value: value["slot"])
        self.registry.register("product-slot", dict, direct=False, slot=lambda value: value["slot"])
        live, events = self._live()
        for index in range(6):
            asyncio.run(
                live.display_card(
                    "product-slot",
                    DisplayCardContent(
                        data={
                            "slot": str(index),
                            "revision": 1,
                        }
                    ),
                    turn_id=TURN_ID,
                )
            )
        asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "0",
                        "revision": 2,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        asyncio.run(
            live.display_card(
                "product-slot",
                DisplayCardContent(
                    data={
                        "slot": "overflow",
                        "revision": 1,
                    }
                ),
                turn_id=TURN_ID,
            )
        )
        self.assertEqual(len(events.replay(SESSION_ID)), 8)
        for index in range(2):
            asyncio.run(
                live.display_card(
                    "product-slot",
                    DisplayCardContent(
                        data={
                            "slot": "0",
                            "revision": index,
                            "text": "x" * 48_000,
                        }
                    ),
                    turn_id=TURN_ID,
                )
            )
        with self.assertRaisesRegex(DisplayCardError, "display_card_turn_bytes_exceeded"):
            asyncio.run(
                live.display_card(
                    "product-slot",
                    DisplayCardContent(
                        data={
                            "slot": "0",
                            "revision": 3,
                            "text": "x" * 48_000,
                        }
                    ),
                    turn_id=TURN_ID,
                )
            )

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
        activities = Activities()
        self.activities = activities
        caller.bridge_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(caller.bridge_activity.close)
        register_card_routes(
            app, lambda scope_id: caller if scope_id == SESSION_ID else None, activities=activities
        )
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

    def test_component_routes_require_scoped_turn_and_validate_payload(self) -> None:
        activities = Activities()
        owner = activities.enter(ActivityDomain.TURN)
        self.addCleanup(owner.close)
        caller = SimpleNamespace(
            id=SESSION_ID,
            bridge_token=BRIDGE_TOKEN,
            publication_turn_id=TURN_ID,
            bridge_activity=owner,
            component_catalog=Mock(return_value=[{"slot": "custom.matrix"}]),
            component_ui_catalog=Mock(
                return_value={
                    "available": True,
                    "authorized": False,
                    "catalog": {"version": "1.0.3"},
                }
            ),
            component_preflight=Mock(
                return_value={"slots": [], "authorized": False, "reserved": False}
            ),
            component_interaction=AsyncMock(return_value={"answers": {"question": "chosen"}}),
        )
        app = FastAPI()
        register_card_routes(
            app, lambda scope: caller if scope == SESSION_ID else None, activities=activities
        )
        headers = {BRIDGE_SESSION_HEADER: SESSION_ID, BRIDGE_TOKEN_HEADER: BRIDGE_TOKEN}
        command = {"request_id": "choose", "slot": "custom.matrix", "data": {}, "title": "Choose"}
        with TestClient(app) as client:
            preflight = "/api/internal/bridge/component/preflight"
            self.assertEqual(
                client.post(preflight, json={"slots": ["custom.new"]}).status_code, 403
            )
            self.assertEqual(
                client.post(preflight, headers=headers, json={"slots": []}).status_code, 400
            )
            checked = client.post(preflight, headers=headers, json={"slots": ["custom.new"]})
            self.assertEqual(checked.status_code, 200)
            self.assertFalse(checked.json()["result"]["authorized"])
            caller.component_preflight.assert_called_once_with(["custom.new"])
            self.assertEqual(
                client.post("/api/internal/bridge/component/catalog", json={}).status_code, 403
            )
            self.assertEqual(
                client.post(
                    "/api/internal/bridge/component/catalog", headers=headers, json={}
                ).json()["components"],
                [{"slot": "custom.matrix"}],
            )
            caller.component_ui_catalog.assert_not_called()
            discovery = client.post(
                "/api/internal/bridge/component/catalog", headers=headers, json={"include_ui": True}
            )
            self.assertEqual(discovery.status_code, 200)
            self.assertEqual(discovery.json()["ui"]["catalog"]["version"], "1.0.3")
            self.assertFalse(discovery.json()["ui"]["authorized"])
            caller.component_ui_catalog.assert_called_once_with()
            self.assertEqual(
                client.post(
                    "/api/internal/bridge/component/catalog", json={"include_ui": True}
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    "/api/internal/bridge/component/request",
                    headers=headers,
                    json={**command, "permission": "all"},
                ).status_code,
                400,
            )
            result = client.post(
                "/api/internal/bridge/component/request", headers=headers, json=command
            )
            self.assertEqual(result.status_code, 200, result.text)
            caller.component_interaction.assert_awaited_once_with(
                ComponentInvocation.model_validate(command), turn_id=TURN_ID, waiting=True
            )
            schema = {
                "type": "object",
                "properties": {
                    "materials": {
                        "type": "array",
                        "items": {"type": "object", "required": ["ref_id"]},
                    }
                },
            }
            payload = {"materials": [{"title": "private material"}], "goal": "retain goal"}

            async def validate_input(command, **kwargs):
                validate_component_value(schema, command.data)

            caller.component_interaction.side_effect = validate_input
            rejected = client.post(
                "/api/internal/bridge/component/request",
                headers=headers,
                json={**command, "data": payload},
            )
            self.assertEqual(rejected.status_code, 400)
            self.assertEqual(rejected.json()["error"], "component_value_invalid")
            self.assertEqual(rejected.json()["detail"]["path"], ["materials", 0])
            self.assertEqual(rejected.json()["detail"]["missing"], ["ref_id"])
            self.assertNotIn("private material", rejected.text)
            self.assertNotIn("retain goal", rejected.text)
            self.assertEqual(
                payload, {"materials": [{"title": "private material"}], "goal": "retain goal"}
            )
            caller.publication_turn_id = ""
            self.assertEqual(
                client.post(preflight, headers=headers, json={"slots": ["custom.new"]}).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    "/api/internal/bridge/component/display", headers=headers, json=command
                ).status_code,
                403,
            )

    def test_plugin_install_route_requires_scoped_turn_and_exact_payload(self) -> None:
        activities = Activities()
        owner = activities.enter(ActivityDomain.TURN)
        self.addCleanup(owner.close)
        caller = SimpleNamespace(
            id=SESSION_ID,
            bridge_token=BRIDGE_TOKEN,
            publication_turn_id=TURN_ID,
            bridge_activity=owner,
            plugin_installation=AsyncMock(return_value={"answers": {"install": "receipt"}}),
        )
        app = FastAPI()
        register_card_routes(
            app, lambda scope: caller if scope == SESSION_ID else None, activities=activities
        )
        headers = {BRIDGE_SESSION_HEADER: SESSION_ID, BRIDGE_TOKEN_HEADER: BRIDGE_TOKEN}
        command = {"request_id": "install", "path": "generated.zip", "sha256": "a" * 64}
        with TestClient(app) as client:
            self.assertEqual(client.post(PLUGIN_INSTALL_ROUTE, json=command).status_code, 403)
            self.assertEqual(
                client.post(
                    PLUGIN_INSTALL_ROUTE, headers=headers, json={**command, "confirmed": True}
                ).status_code,
                400,
            )
            result = client.post(PLUGIN_INSTALL_ROUTE, headers=headers, json=command)
            self.assertEqual(result.status_code, 200, result.text)
            caller.plugin_installation.assert_awaited_once_with(
                PluginInstallation.model_validate(command), turn_id=TURN_ID
            )
            caller.publication_turn_id = ""
            self.assertEqual(
                client.post(PLUGIN_INSTALL_ROUTE, headers=headers, json=command).status_code, 403
            )


if __name__ == "__main__":
    unittest.main()
