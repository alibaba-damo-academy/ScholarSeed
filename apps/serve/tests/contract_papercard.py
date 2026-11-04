"""Deterministic PaperCard provenance contracts; not real model acceptance."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
)
from service.chat.service.tasks import ProductTaskLease
from service.literature.api.evidence import prepare_bundle, register_card_bridge
from service.literature.domain.anchors import SentenceAnchors, original_text, sentence_pattern
from service.literature.domain.cards import normalize_bundle
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.evidence import LiteratureEvidenceService
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    PDF_ROUTE_PREFIX,
    PdfQuery,
)
from service.platform.citations import CitationPage, PdfFragment, PdfIndex, PdfSpan
from service.platform.context import ProductTaskType
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.workbench.service.extraction import decode_index, extract
from tests import contract_citations as fixtures


def bundle(text="A documented result.", sid="1"):
    return {
        "paper_card": {"findings": "Generated synthesis"},
        "source_mapping": {"card_mapping": {"findings": [sid]}, "sentences": {sid: text}},
    }


class PaperCardContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repository = LiteratureRepository(Path(self.temp.name) / "literature.sqlite3")
        self.repository.save(
            LiteratureItem(id="paper", title="Evidence Paper"), project_id="project"
        )
        self.cards = PaperCards(self.repository.database)
        self.fixture = fixtures.CitationContracts()
        self.fixture.setUp()
        self.evidence = LiteratureEvidenceService(self.fixture.indexes, self.repository, self.cards)
        self.fixture.service._literature = self.evidence
        self.fixture.snapshot = replace(self.fixture.snapshot, items=())

    def tearDown(self):
        self.fixture.tearDown()
        self.temp.cleanup()

    def test_current_skill_card_output_and_foreign_id_rejection(self):
        skill = Path(__file__).resolve().parents[3] / "skills/community/literature-review"
        source = {
            "info_type": "card",
            "paper_card": {
                "paper_type": "theory",
                "card": {"findings": "Generated synthesis"},
                "common_fields": {"core_contribution": "A documented result."},
            },
            "source_mapping": {
                "card_mapping": {"card.findings": [1]},
                "sentences": {"1": "A documented result."},
            },
        }
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "import asyncio,json,sys; from run_pipeline import _process_single_paper; "
                "result=asyncio.run(_process_single_paper(None,'paper',"
                "{'title':'Evidence Paper'},json.load(sys.stdin),'full','theory',"
                "with_source_map=True)); "
                "assert result[0]['info_type']=='card'; "
                "assert result[0]['card']['findings']=='Generated synthesis'; "
                "print(json.dumps({'paper_card':result[0],'source_mapping':result[3]}))",
            ],
            input=json.dumps(source),
            env={
                **os.environ,
                "PYTHONPATH": os.pathsep.join(
                    (str(skill / "scripts/processing"), str(skill / "lib"))
                ),
            },
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        root = Path(self.temp.name)
        target = root / "card.json"
        raw = json.loads(result.stdout)
        target.write_text(json.dumps(raw), encoding="utf-8")
        original = normalize_bundle(prepare_bundle(root, target.name))
        self.assertEqual(original["sentences"], {"1": "A documented result."})
        self.assertEqual(original["card_mapping"], {"card.findings": ["1"]})
        raw["source_mapping"]["card_mapping"]["card.findings"] = [99]
        target.write_text(json.dumps(raw), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "papercard_sources_missing"):
            prepare_bundle(root, target.name)
        raw["source_mapping"]["card_mapping"]["card.findings"] = [1]
        raw["source_mapping"]["sentences"]["1"] = "Different original."
        target.write_text(json.dumps(raw), encoding="utf-8")
        changed = normalize_bundle(prepare_bundle(root, target.name))
        self.assertNotEqual(changed["revision"], original["revision"])

    def test_registration_scope_identity_and_persistence(self):
        root = Path(self.temp.name)
        raw = bundle()
        raw["paper_card"]["title"] = "Evidence Paper"
        (root / "card.json").write_text(json.dumps(raw))
        (root / "link.json").symlink_to(root / "card.json")
        live = SimpleNamespace(
            id="session",
            bridge_token="test-token",
            publication_turn_id="turn",
            runtime_workdir=root,
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == live.id else None)
        app = FastAPI()
        with patch(
            "service.literature.api.evidence.LiteratureRepository", return_value=self.repository
        ):
            activities = Activities()
            live.turn_activity = activities.enter(ActivityDomain.TURN)
            self.addCleanup(live.turn_activity.close)
            register_card_bridge(app, sessions, activities=activities)
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        route = PDF_ROUTE_PREFIX + "register-card"
        with TestClient(app) as client:
            body = {"ref_id": "literature:paper", "path": "card.json"}
            self.assertEqual(client.post(route, json=body).status_code, 403)
            response = client.post(route, json=body, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertIs(response.json()["ok"], True)
            self.assertEqual(self.cards.get("paper")["revision"], response.json()["card_revision"])
            for bad in ("../card.json", str(root / "card.json"), "link.json"):
                self.assertEqual(
                    client.post(route, json={**body, "path": bad}, headers=headers).status_code, 400
                )
            raw["paper_card"]["title"] = "Different paper"
            (root / "card.json").write_text(json.dumps(raw))
            self.assertEqual(client.post(route, json=body, headers=headers).status_code, 400)
            live.publication_turn_id = ""
            self.assertEqual(client.post(route, json=body, headers=headers).status_code, 403)

    def test_protected_task_registration_is_gated_before_papercard_file_read(self):
        root = Path(self.temp.name)
        raw = bundle()
        raw["paper_card"]["title"] = "Evidence Paper"
        (root / "card.json").write_text(json.dumps(raw))
        cases = (
            ("research_idea", RESEARCH_IDEA_FULLTEXT),
            ("precise_search", PRECISE_SEARCH_FULLTEXT),
            ("literature_review", LITERATURE_REVIEW_FULLTEXT),
        )
        for task_type, authorization_type in cases:
            with self.subTest(task_type=task_type):
                live = SimpleNamespace(
                    id="session",
                    bridge_token="test-token",
                    publication_turn_id="turn",
                    active_assistant_snapshot_id="snapshot",
                    active_product_turn_id="product-turn",
                    active_task_type=task_type,
                    product_turn_generation=1,
                    current_task=SimpleNamespace(done=lambda: False),
                    active_task_lease=(
                        ProductTaskLease(
                            task_type=ProductTaskType(task_type),
                            turn_id="product-turn",
                            generation=1,
                            source="skill_run",
                            workspace="run",
                            run_id="run",
                        )
                        if task_type != "research_idea"
                        else None
                    ),
                    runtime_workdir=root,
                    publish=AsyncMock(),
                )
                sessions = SimpleNamespace(
                    bridge_caller=lambda sid, caller=live: caller if sid == caller.id else None
                )
                authorizer = SimpleNamespace(
                    require=Mock(side_effect=ValueError("fulltext_authorization_required"))
                )
                app = FastAPI()
                with patch(
                    "service.literature.api.evidence.LiteratureRepository",
                    return_value=self.repository,
                ):
                    activities = Activities()
                    live.turn_activity = activities.enter(ActivityDomain.TURN)
                    self.addCleanup(live.turn_activity.close)
                    register_card_bridge(app, sessions, authorizer, activities=activities)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                }
                with (
                    patch("service.literature.api.evidence.prepare_bundle") as prepare,
                    TestClient(app) as client,
                ):
                    response = client.post(
                        PDF_ROUTE_PREFIX + "register-card",
                        json={"ref_id": "literature:paper", "path": "card.json"},
                        headers=headers,
                    )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["error"], "fulltext_authorization_required")
                authorizer.require.assert_called_once_with(
                    session_id=live.id,
                    snapshot_id=live.active_assistant_snapshot_id,
                    turn_id=live.publication_turn_id,
                    authorization_type=authorization_type,
                    ref_id="literature:paper",
                    client_turn_id=live.active_product_turn_id,
                    task_context=None,
                )
                prepare.assert_not_called()

    def test_mapping_cannot_reference_foreign_sentence(self):
        value = bundle()
        value["source_mapping"]["card_mapping"]["findings"] = [99]
        with self.assertRaisesRegex(ValueError, "papercard_sources_missing"):
            normalize_bundle(value)

    def test_missing_mapping_does_not_turn_generated_text_into_original(self):
        with self.assertRaises(ValueError):
            normalize_bundle({"paper_card": {"findings": "unsupported"}, "source_mapping": {}})

    def test_read_scope_is_excerpt_not_claimed_fulltext(self):
        self.assertEqual(normalize_bundle(bundle())["content_level"], "source_excerpt")

    def test_revisions_preserve_original_pool(self):
        old = self.cards.save("paper", bundle(), "import")
        new = self.cards.save("paper", bundle("Changed result."), "import")
        self.assertNotEqual(old["revision"], new["revision"])
        self.assertEqual(
            self.cards.get("paper", old["revision"])["sentences"]["1"], "A documented result."
        )

    def test_empty_context_search_and_actual_original_receipt(self):
        self.cards.save("paper", bundle(), "import")
        service = self.fixture.service
        discovered = service.query("session", "snapshot", "library", PdfQuery(query="Evidence"))
        self.assertEqual(discovered["sources"][0]["ref_id"], "literature:paper")
        prepared = service.query("session", "snapshot", "read", PdfQuery(ref_id="literature:paper"))
        receipt = prepared["pending_receipts"][0]
        self.assertEqual(receipt["quote"], "A documented result.")
        self.assertEqual(receipt["pages"], [])
        self.assertFalse(receipt["can_open_pdf"])
        self.assertEqual(receipt["pipeline"], "papercard")
        committed = service.commit_read("session", "snapshot", prepared)
        self.assertTrue(committed["fragments"][0]["citation_url"].startswith("scholarseed-cite:"))
        self.assertNotIn("Generated synthesis", committed["fragments"][0]["text"])

    def test_card_without_pdf_recovers_positions_without_mutating_receipt(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((70, 100), "First sentence.")
            self.fixture.source.payload = pdf.tobytes()
        self.cards.save("paper", bundle("First sentence."), "import")
        service = self.fixture.service
        prepared = service.query("session", "snapshot", "read", PdfQuery(ref_id="literature:paper"))
        committed = service.commit_read("session", "snapshot", prepared)
        url = committed["fragments"][0]["citation_url"]
        handle = url.split(":", 1)[1]
        revision = self.fixture.answer_for(f"[1]({url})")
        before = self.fixture.store.get("session", "snapshot", handle)
        self.assertEqual(
            service.resolve("session", "answer:1", revision, 0, 0, handle)["state"], "unavailable"
        )
        document = self.fixture.source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        with patch.object(self.evidence, "document", return_value=document):
            restored = service.resolve("session", "answer:1", revision, 0, 0, handle)
            self.assertEqual(restored["state"], "exact")
            self.assertTrue(restored["can_open_pdf"])
            self.assertTrue(restored["pages"])
            self.assertEqual(restored["revision"], document.revision)
            self.assertEqual(service.raw("session", "answer:1", revision, handle), document.payload)
        self.assertEqual(self.fixture.store.get("session", "snapshot", handle), before)

    def test_resolved_literature_citation_names_primary_attachment_record_owner(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((70, 100), "First sentence.")
            payload = pdf.tobytes()
        self.cards.save("paper", bundle("First sentence."), "import")
        service = self.fixture.service
        prepared = service.query("session", "snapshot", "read", PdfQuery(ref_id="literature:paper"))
        committed = service.commit_read("session", "snapshot", prepared)
        url = committed["fragments"][0]["citation_url"]
        handle = url.split(":", 1)[1]
        revision = self.fixture.answer_for(f"[1]({url})")
        with (
            patch.object(
                self.evidence._pdf,
                "read_attachment",
                return_value=(payload, "application/pdf", "revision"),
            ) as read_attachment,
            patch.object(self.evidence._pdf, "primary", return_value=SimpleNamespace(id="pdf")),
        ):
            resolved = service.resolve("session", "answer:1", revision, 0, 0, handle)
        read_attachment.assert_called_once_with("paper", "pdf")
        self.assertTrue(resolved["can_open_pdf"])
        self.assertEqual(
            resolved["record_target"],
            {"owner": "literature_attachment", "scope_id": "paper", "subject_id": "pdf"},
        )
        # The owner is resolved per navigation and never written into the immutable receipt.
        self.assertNotIn("record_target", self.fixture.store.get("session", "snapshot", handle))

    def test_lost_literature_pdf_is_unavailable_not_changed(self):
        prepared = self.fallback_query()
        service = self.fixture.service
        committed = service.commit_read("session", "snapshot", prepared)
        url = committed["fragments"][0]["citation_url"]
        handle = url.split(":", 1)[1]
        revision = self.fixture.answer_for(f"[1]({url})")
        resolved = service.resolve("session", "answer:1", revision, 0, 0, handle)
        self.assertEqual(resolved["state"], "unavailable")
        self.assertFalse(resolved["can_open_pdf"])
        self.assertTrue(resolved["pages"])
        with self.assertRaisesRegex(ValueError, "citation_source_unavailable"):
            service.raw("session", "answer:1", revision, handle)

    def test_discovery_searches_card_text_without_issuing_citations(self):
        saved = self.cards.save("paper", bundle(), "import")
        result = self.evidence.discover("project", "synthesis", 0, 8)
        self.assertEqual(len(result["sources"]), 1)
        match = result["sources"][0]["matches"][0]
        self.assertEqual(match["text"], "Generated synthesis")
        self.assertEqual(match["card_revision"], saved["revision"])
        self.assertNotIn("citation_url", match)
        self.assertNotIn("pending_receipts", result)

    def test_discovery_does_not_search_original_pool_or_old_card(self):
        old = bundle()
        old["paper_card"] = {"findings": "OldCompression"}
        self.cards.save("paper", old, "import")
        self.cards.save("paper", bundle(), "import")
        for query in ("OldCompression", "documented"):
            self.assertEqual(self.evidence.discover("project", query, 0, 8)["sources"], [])

    def test_discovery_abstract_without_card_and_cross_field_terms(self):
        self.repository.save(
            LiteratureItem(id="abstract", title="Compression study", abstract="Fast inference"),
            project_id="project",
        )
        result = self.evidence.discover("project", "compression inference", 0, 8)
        self.assertEqual([r["source_id"] for r in result["sources"]], ["abstract"])
        self.assertEqual(
            {m["field"] for m in result["sources"][0]["matches"]}, {"title", "abstract"}
        )
        self.assertEqual(
            self.evidence.discover("project", "compression nonexistent", 0, 8)["sources"], []
        )

    def test_discovery_title_priority_and_stable_pagination(self):
        self.repository.save(LiteratureItem(id="named", title="Synthesis"), project_id="project")
        self.cards.save("paper", bundle(), "import")
        first = self.evidence.discover("project", "synthesis", 0, 1)
        self.assertEqual(first["sources"][0]["source_id"], "named")
        self.assertEqual(first["next_offset"], 1)
        second = self.evidence.discover("project", "synthesis", first["next_offset"], 1)
        self.assertEqual(second["sources"][0]["source_id"], "paper")
        self.assertIsNone(second["next_offset"])

    def test_discovery_treats_wildcards_and_sql_as_literal_text(self):
        self.repository.save(
            LiteratureItem(id="percent", title="50% fewer parameters"), project_id="project"
        )
        self.assertEqual(len(self.evidence.discover("project", "%", 0, 8)["sources"]), 1)
        for query in ("_", "' OR 1=1 --"):
            self.assertEqual(self.evidence.discover("project", query, 0, 8)["sources"], [])

    def test_discovery_handles_nested_card_arrays_and_chinese(self):
        value = bundle()
        value["paper_card"] = {"findings": [{"method": "跨层参数共享"}]}
        self.cards.save("paper", value, "import")
        result = self.evidence.discover("project", "参数共享", 0, 8)
        self.assertEqual(result["sources"][0]["matches"][0]["text"], "跨层参数共享")

    def test_discovery_empty_query_lists_unique_papers(self):
        self.cards.save("paper", bundle(), "import")
        result = self.evidence.discover("project", "", 0, 8)
        self.assertEqual(len(result["sources"]), 1)
        self.assertIsNone(result["next_offset"])

    def test_discovery_empty_matches_guide_browsing_without_invented_candidates(self):
        result = self.evidence.discover("project", "unmatched", 0, 8)
        self.assertEqual(result["sources"], [])
        self.assertIn("empty query", result["instruction"])
        self.assertNotIn("pending_receipts", result)

    def test_discovery_excerpt_includes_hit_in_long_card_text(self):
        value = bundle()
        value["paper_card"] = {"findings": "prefix " * 200 + "needle" + " suffix" * 200}
        self.cards.save("paper", value, "import")
        match = self.evidence.discover("project", "needle", 0, 8)["sources"][0]["matches"][0]
        self.assertIn("needle", match["text"])
        self.assertLess(len(match["text"]), len(value["paper_card"]["findings"]))

    def test_missing_card_and_pdf_returns_no_evidence(self):
        with patch.dict("os.environ", {"PAPER_HUB_URL": ""}):
            result = self.fixture.service.query(
                "session", "snapshot", "read", PdfQuery(ref_id="literature:paper")
            )
        self.assertEqual(result["state"], "unavailable")
        self.assertNotIn("pending_receipts", result)

    def test_snapshot_mismatch_blocks_library_search(self):
        with self.assertRaisesRegex(ValueError, "citation_scope_unavailable"):
            self.fixture.service.query("other", "snapshot", "library", PdfQuery())

    def test_selected_pdf_uses_card_then_missing_card_uses_local_parser(self):
        snapshot = replace(
            self.fixture.snapshot,
            items=(
                fixtures.AssistantTurnItem(
                    "e_01",
                    fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
                    fixtures.ContextResolutionState.READY,
                ),
            ),
        )
        self.fixture.snapshot = snapshot
        self.fixture.ready()
        document = self.fixture.source.citation_document("project", snapshot.items[0].ref)
        fragment = self.fixture.indexes.index(document).fragments[0]
        self.cards.save("paper", bundle(fragment.text), "import", document.revision)
        prepared = self.fixture.service.query("session", "snapshot", "read", PdfQuery(ref_id="ref"))
        receipts = prepared["pending_receipts"]
        self.assertEqual(receipts[0]["pipeline"], "local_pdf")
        self.assertEqual(receipts[0]["fallback_reason"], "papercard_original_unlocated")
        self.assertEqual(receipts[0]["card_revision"], "")
        self.assertTrue(receipts[0]["pages"])
        # The fixture repeats on two pages: never choose an arbitrary occurrence.
        self.assertTrue(all(r["pipeline"] == "local_pdf" for r in receipts))
        self.assertEqual(self.cards.get("paper")["sentences"]["1"], fragment.text)
        self.fixture.source.payload += b"\n"
        self.fixture.ready()
        prepared = self.fixture.service.query("session", "snapshot", "read", PdfQuery(ref_id="ref"))
        self.assertEqual(prepared["pending_receipts"][0]["pipeline"], "local_pdf")
        self.assertEqual(prepared["pending_receipts"][0]["fallback_reason"], "papercard_missing")
        self.assertTrue(prepared["pending_receipts"][0]["pages"])

    def test_wrapped_hyphen_equivalence_does_not_ignore_interior_math(self):
        pattern = sentence_pattern("Unlike left-to-\nright, the ob-\njective uses pre-\ntraining.")
        self.assertIsNotNone(
            pattern.fullmatch(
                original_text("Unlike left-to-right, the objective uses pre-training.")
            )
        )
        self.assertIsNone(sentence_pattern("a-b differs.").fullmatch(original_text("ab differs.")))
        self.assertIsNone(
            sentence_pattern("A result is 50%.").fullmatch(original_text("A result is 80%."))
        )

    def fallback_query(self, query=None, *, failed=False):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page()
            page.insert_text((100, 100), "First sentence. Repeated sentence.")
            self.fixture.source.payload = pdf.tobytes()
        document = self.fixture.source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        self.assertIsNotNone(self.fixture.indexes.index(document, wait=True))
        value = bundle()
        value["source_mapping"] = {
            "card_mapping": {"findings": ["1", "2"]},
            "sentences": {"1": "First sentence.", "2": "Repeated sentence has 99%."},
        }
        self.cards.save("paper", value, "import", document.revision)
        with patch.object(self.evidence, "document", return_value=document):
            if failed:
                with (
                    patch.object(self.fixture.indexes, "prepare", return_value={"state": "failed"}),
                    patch.object(self.fixture.indexes, "index", return_value=None),
                ):
                    return self.fixture.service.query(
                        "session", "snapshot", "read", query or PdfQuery(ref_id="literature:paper")
                    )
            return self.fixture.service.query(
                "session", "snapshot", "read", query or PdfQuery(ref_id="literature:paper")
            )

    def test_partial_card_failure_preserves_priority_and_separate_provenance(self):
        prepared = self.fallback_query()
        self.assertIn("PaperCard", prepared["coverage_notice"])
        self.assertEqual(prepared["omitted_regions"], [])
        records = prepared["pending_receipts"]
        self.assertEqual(records[0]["pipeline"], "papercard")
        self.assertTrue(records[0]["pages"])
        local = [r for r in records if r["pipeline"] == "local_pdf"]
        self.assertTrue(local)
        self.assertTrue(all(r["pages"] and not r["card_revision"] for r in local))
        self.assertTrue(all(r["fallback_reason"] == "papercard_original_unlocated" for r in local))
        self.assertTrue(all("99%" not in r["quote"] for r in local))
        self.assertTrue(all("99%" not in r["quote"] for r in records))
        self.assertEqual(self.cards.get("paper")["sentences"]["2"], "Repeated sentence has 99%.")
        committed = self.fixture.service.commit_read("session", "snapshot", prepared)
        self.assertEqual(
            [r["pipeline"] for r in committed["fragments"]], [r["pipeline"] for r in records]
        )

    def test_local_fallback_respects_the_same_search_query(self):
        result = self.fallback_query(PdfQuery(ref_id="literature:paper", query="Repeated"))
        records = result["pending_receipts"]
        self.assertEqual(records[0]["pipeline"], "local_pdf")
        self.assertEqual(records[0]["quote"], "Repeated sentence.")
        self.assertTrue(all("Repeated" in r["quote"] for r in records))

    def test_unmatched_local_search_never_substitutes_unrelated_evidence(self):
        result = self.fallback_query(PdfQuery(ref_id="literature:paper", query="99%"))
        records = result["pending_receipts"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["pipeline"], "papercard")
        self.assertFalse(records[0]["pages"])

    def test_located_card_query_does_not_add_local_fallback(self):
        result = self.fallback_query(PdfQuery(ref_id="literature:paper", query="First"))
        self.assertEqual(len(result["pending_receipts"]), 1)
        self.assertEqual(result["pending_receipts"][0]["pipeline"], "papercard")

    def test_partial_card_fallback_pagination_uses_combined_order(self):
        result = self.fallback_query(PdfQuery(ref_id="literature:paper", offset=1, limit=1))
        self.assertEqual(result["pending_receipts"][0]["pipeline"], "local_pdf")
        self.assertEqual(result["next_offset"], 2)

    def test_failed_local_index_preserves_unlocated_card_evidence(self):
        result = self.fallback_query(failed=True)
        self.assertEqual(len(result["pending_receipts"]), 2)
        self.assertTrue(
            all(r["pipeline"] == "papercard" and not r["pages"] for r in result["pending_receipts"])
        )

    def test_slr_array_paths_remain_readable(self):
        value = {
            "paper_card": {"card": {"discussion": {"limitations": ["Generated"]}}},
            "source_mapping": {
                "card_mapping": {"card.discussion.limitations[0]": [1]},
                "sentences": {"1": "Original limitation."},
            },
        }
        normalized = normalize_bundle(value)
        self.assertEqual(normalized["card_mapping"], {"card.discussion.limitations.0": ["1"]})

    def test_pdf_failure_preserves_card_original(self):
        self.cards.save("paper", bundle(), "import")
        document = replace(self.evidence.document("project", "paper"), payload=b"bad PDF")
        with (
            patch.object(self.fixture.indexes, "prepare", return_value={"state": "failed"}),
            patch.object(self.fixture.indexes, "index", return_value=None),
        ):
            result = self.evidence.preferred(document, "paper")
        self.assertEqual(result["pipeline"], "papercard")
        self.assertEqual(result["fragments"][0]["text"], "A documented result.")
        self.assertEqual(result["fragments"][0]["pages"], [])

    def test_newer_card_never_reuses_old_pdf_association(self):
        self.cards.save("paper", bundle(), "import", "sha256:old")
        self.cards.save("paper", bundle("New result."), "import", "sha256:new")
        document = replace(
            self.evidence.document("project", "paper"), revision="sha256:old", payload=b"old"
        )
        self.assertEqual(
            self.evidence.preferred(document)["fallback_reason"], "papercard_pdf_version_mismatch"
        )

    def test_arxiv_identifier_survives_library_persistence(self):
        self.repository.save(LiteratureItem(id="arxiv-paper", title="Research", arxiv="1810.04805"))
        self.assertEqual(self.repository.get("arxiv-paper").arxiv, "1810.04805")

    def test_same_filename_does_not_associate_pdf(self):
        self.cards.save("paper", bundle(), "import", "sha256:another-file")
        self.assertIsNone(self.cards.match_pdf("sha256:different-file"))


def positioned(text, page=1, y=0.2):
    spans = tuple(
        PdfSpan(m.start(), m.end(), page, (0.1 + i * 0.02, y, 0.115 + i * 0.02, y + 0.01))
        for i, m in enumerate(re.finditer(r"\S+", text))
    )
    return PdfFragment(
        str((text, page, y)), text, (CitationPage(page, tuple(x.quad for x in spans)),), spans=spans
    )


def anchors(*fragments):
    return SentenceAnchors(
        PdfIndex("index", "revision", fragments, max(p.page for f in fragments for p in f.pages))
    )


class AnchorContracts(unittest.TestCase):
    def test_known_typesetting_keeps_operators_and_values(self):
        source = r"Cost falls from $O(V \times H)$ to $O(V \times E + E \times H)$."
        fragment = positioned("Cost falls from O(V × H) to O(V × E + E × H).")
        self.assertTrue(anchors(fragment).locate(source))
        self.assertFalse(anchors(fragment).locate(source.replace("+", "-")))
        self.assertFalse(anchors(positioned("Value is 50%.")).locate(r"Value is 80\%."))
        self.assertFalse(anchors(positioned("a-b differs.")).locate("ab differs."))

    def test_unknown_math_is_not_discarded(self):
        self.assertFalse(
            anchors(positioned("The value xcorrupt is replaced.")).locate(
                r"The value $\bfx$ is replaced."
            )
        )
        self.assertFalse(anchors(positioned("H (cid:29) E.")).locate(r"$H \gg E$."))
        self.assertFalse(anchors(positioned("The value x is 50.")).locate("The value is 50."))

    def test_negation_and_word_boundaries_stay_significant(self):
        self.assertFalse(
            anchors(positioned("The model does not improve accuracy.")).locate(
                "The model does improve accuracy."
            )
        )
        self.assertFalse(anchors(positioned("This is notable.")).locate("This is not able."))
        self.assertFalse(anchors(positioned("An unstable system.")).locate("stable system."))

    def test_quotes_and_ligatures(self):
        self.assertTrue(
            anchors(positioned("It is “real” and efﬁcient.")).locate('It is ``real" and efficient.')
        )

    def test_prime_operators_are_not_treated_as_closing_quotes(self):
        self.assertFalse(
            anchors(positioned('The derivative f" is zero.')).locate("The derivative f'' is zero.")
        )
        self.assertTrue(
            anchors(positioned("The derivative f'' is zero.")).locate("The derivative f'' is zero.")
        )

    def test_substring_crops_to_its_positioned_words(self):
        fragment = positioned("An unrelated formula. The generator is trained with MLM.")
        pages = anchors(fragment).locate("The generator is trained with MLM.")
        self.assertEqual(len(pages), 1)
        self.assertAlmostEqual(pages[0].quads[0][0], fragment.spans[3].quad[0])
        self.assertFalse(anchors(fragment).locate("The generator is trained with NSP."))

    def test_multiple_identical_occurrences_are_not_first_match(self):
        a = positioned("The model is efficient.")
        self.assertFalse(anchors(a, positioned(a.text, page=2)).locate(a.text))
        self.assertFalse(anchors(positioned(a.text + " " + a.text)).locate(a.text))

    def test_cross_fragment_requires_complete_source(self):
        a = positioned("The model separates topic prediction and")
        b = positioned("coherence prediction into distinct tasks.", y=0.3)
        engine = anchors(a, b)
        self.assertTrue(engine.locate(a.text + " " + b.text))
        self.assertFalse(engine.locate(a.text + " coherence prediction."))
        self.assertFalse(engine.locate(a.text + " not " + b.text))

    def test_adjacent_page_continuation_with_intervening_table(self):
        a = positioned("As formulated, the objective combines topic and", y=0.9)
        header = positioned("Table 1. Model configuration.", page=2)
        b = positioned("coherence prediction in one task.", page=2, y=0.5)
        source = a.text + " " + b.text
        self.assertEqual([p.page for p in anchors(a, header, b).locate(source)], [1, 2])
        self.assertFalse(anchors(positioned(a.text), header, b).locate(source))
        self.assertFalse(anchors(a, positioned(b.text, page=3)).locate(source))
        self.assertFalse(anchors(a, b, positioned(b.text, page=2, y=0.6)).locate(source))

    def test_cross_page_does_not_skip_other_prose(self):
        a = positioned("As formulated, the objective combines topic and", y=0.9)
        intervening = positioned("Different evidence contradicts the original result.", page=2)
        b = positioned("coherence prediction in one task.", page=2, y=0.5)
        self.assertFalse(anchors(a, intervening, b).locate(a.text + " " + b.text))

    def test_extra_footnote_number_is_not_silently_dropped(self):
        a = positioned("As formulated, the objective combines topic and", y=0.9)
        b = positioned("coherence prediction in one task2.", page=2)
        self.assertFalse(anchors(a, b).locate(a.text + " coherence prediction in one task."))

    def test_parsed_spans_survive_serialization_rotation_and_crop(self):
        for rotation in (0, 90, 180, 270):
            parsed = extract(fixtures.pdf_bytes(rotation=rotation, crop=True))
            self.assertEqual(decode_index(asdict(parsed)), parsed)
            for fragment in parsed.fragments:
                self.assertTrue(fragment.spans)
                self.assertTrue(
                    all(0 <= s.start < s.end <= len(fragment.text) for s in fragment.spans)
                )
                self.assertTrue(
                    all(
                        0 <= s.quad[0] < s.quad[2] <= 1 and 0 <= s.quad[1] < s.quad[3] <= 1
                        for s in fragment.spans
                    )
                )

    def test_navigation_prepares_missing_local_index(self):
        fixture = fixtures.CitationContracts()
        fixture.setUp()
        try:
            document = fixture.source.citation_document(
                "project",
                fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
            )
            self.assertIsNone(fixture.indexes.index(document))
            self.assertIsNotNone(fixture.indexes.index(document, wait=True))
        finally:
            fixture.tearDown()


if __name__ == "__main__":
    unittest.main()
