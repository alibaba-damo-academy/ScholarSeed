"""Project-literature directory, page parsing, cache and Bridge contracts."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.api.citations import register_citation_bridge
from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
)
from service.chat.persistence.catalog import SessionCatalogStore
from service.cli.bridge import parser
from service.literature.persistence import files as literature_files
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE, AttachmentRole, LiteratureItem
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.evidence import LiteratureEvidenceService
from service.literature.service.records import AttachmentRecords
from service.paths import PROJECT_DB_RELATIVE
from service.platform.bridge import (
    ANNOTATIONS_OPERATION,
    BRIDGE_REQUESTS,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    LITERATURE_MAX_PAGE_RANGE,
    LITERATURE_REQUESTS,
    LITERATURE_RESULT_ROUTE,
    LITERATURE_ROUTE_PREFIX,
    PDF_ROUTE_PREFIX,
    LiteratureAnnotations,
    LiteratureList,
    LiteratureRead,
)
from service.platform.citations import (
    LITERATURE_STORAGE,
    CitationDocument,
    CitationPage,
    PdfFragment,
    PdfPageContent,
)
from service.platform.records import RecordOwner, RecordTarget
from service.workbench.service import indexing
from service.workbench.service.extraction import extract
from service.workbench.service.indexing import (
    INDEX_TABLE,
    METADATA_TABLE,
    PAGE_TABLE,
    PdfIndexService,
)
from tests import contract_citations as fixtures

REPO_ROOT = Path(__file__).resolve().parents[3]
PROJECT_LITERATURE_SKILL = REPO_ROOT / "skills" / "community" / "project-literature" / "SKILL.md"
HOST_PROMPT = (
    REPO_ROOT / "apps" / "serve" / "service" / "chat" / "prompts" / "developerInstructions.md"
)
CITATION_IDENTITY_RULES = (
    "A `citation_url` is an opaque, immutable identifier.",
    "Copy the entire returned value",
    "Never split, parse, shorten, truncate, slice, hash, summarize, or reconstruct",
    "If the full value was not preserved, read the fragment again instead of guessing it.",
)


class PageIndexFixture:
    def __init__(self) -> None:
        self.reads: list[tuple[int, int]] = []

    @staticmethod
    def page_count(document: CitationDocument) -> int:
        return extract(document.payload).page_count

    def pages(
        self, document: CitationDocument, start_page: int, end_page: int
    ) -> tuple[PdfPageContent, ...]:
        self.reads.append((start_page, end_page))
        index = extract(document.payload, start_page, end_page)
        return tuple(
            PdfPageContent(
                page_number,
                tuple(
                    fragment
                    for fragment in index.fragments
                    if any(anchor.page == page_number for anchor in fragment.pages)
                ),
                page_number in index.unavailable_pages,
                tuple(
                    omission
                    for omission in index.omissions
                    if any(anchor.page == page_number for anchor in omission.pages)
                ),
            )
            for page_number in range(start_page, end_page + 1)
        )


class LiteratureBridgeContracts(unittest.TestCase):
    def test_project_literature_skill_exclusively_owns_opaque_citation_urls(self) -> None:
        skill = " ".join(PROJECT_LITERATURE_SKILL.read_text(encoding="utf-8").split())
        prompt = " ".join(HOST_PROMPT.read_text(encoding="utf-8").split())

        for rule in CITATION_IDENTITY_RULES:
            with self.subTest(rule=rule):
                self.assertIn(rule, skill)
                self.assertNotIn(rule, prompt)
        self.assertIn('print(fragment["citation_url"], "|", preview)', skill)
        self.assertNotIn('fragment["citation_url"][:', skill)

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.citations = fixtures.CitationContracts()
        self.citations.setUp()
        self.repository = LiteratureRepository(self.root / "literature.sqlite3")
        self.repository.save(
            LiteratureItem(
                id="paper",
                title="Project Paper",
                authors="Ada Author",
                year=2026,
            ),
            project_id="project",
        )
        self.repository.save(
            LiteratureItem(id="foreign", title="Foreign Paper"),
            project_id="other",
        )
        # 附件是文献独占的托管副本, 托管目录必须落在本次测试的临时根里 (read_absolute
        # 会把入参 resolve 后再与行里的 path 比对, 所以这里存 resolve 之后的形式)。
        self.files = self.root / "literature-files"
        self.files.mkdir()
        self.files = self.files.resolve()
        store_patch = patch.object(
            literature_files,
            "SERVICE_LITERATURE_FILES_DIR",
            self.files,
        )
        store_patch.start()
        self.addCleanup(store_patch.stop)
        self.paper_attachment = self._stage("paper", "paper.pdf", self._pdf("Project"))
        self._stage("foreign", "foreign.pdf", self._pdf("Foreign"))
        self.page_indexes = PageIndexFixture()
        self.attachment_records = AttachmentRecords(
            LiteratureAttachmentContent(self.repository), self.repository
        )
        self.evidence = LiteratureEvidenceService(
            self.page_indexes,
            self.repository,
            PaperCards(self.repository.database),
            self.attachment_records,
        )
        self.citations.service._literature = self.evidence

    def tearDown(self) -> None:
        self.citations.tearDown()
        self.temp.cleanup()

    @staticmethod
    def _pdf(prefix: str) -> bytes:
        with pdf_fixture.open() as pdf:
            for page_number in range(1, 4):
                page = pdf.new_page(width=600, height=800)
                page.insert_text((72, 72), f"{prefix} page {page_number} unique text.")
            return pdf.tobytes()

    def _stage(self, literature_id: str, name: str, payload: bytes) -> dict[str, Any]:
        """Write one literature-owned attachment copy and register its row."""
        published = literature_files.managed_object(literature_id, payload, ".pdf")
        location = self.files / published.name
        location.write_bytes(payload)
        return self.repository.add_attachment(
            literature_id,
            name,
            str(location),
            revision=published.revision,
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )

    def test_request_schemas_are_page_based_and_exclude_scope_inputs(self) -> None:
        listed = LiteratureList.model_validate({"limit": 8})
        self.assertEqual(listed.model_dump(), {"offset": 0, "limit": 8})
        read = LiteratureRead.model_validate(
            {"ref_id": "literature:paper", "start_page": 1, "end_page": 3}
        )
        self.assertEqual((read.start_page, read.end_page), (1, 3))
        self.assertNotIn("project_id", LiteratureList.model_fields)
        self.assertNotIn("project_id", LiteratureRead.model_fields)
        self.assertNotIn("path", LiteratureRead.model_fields)
        self.assertNotIn("query", LiteratureRead.model_fields)
        annotations = LiteratureAnnotations.model_validate(
            {"ref_id": "literature:paper", "limit": 8}
        )
        self.assertEqual(
            annotations.model_dump(), {"ref_id": "literature:paper", "offset": 0, "limit": 8}
        )
        self.assertNotIn("project_id", LiteratureAnnotations.model_fields)
        self.assertNotIn("path", LiteratureAnnotations.model_fields)

    def test_request_schemas_reject_search_scope_and_large_or_reversed_ranges(self) -> None:
        for model, payload in (
            (LiteratureList, {"query": "transformer"}),
            (LiteratureList, {"project_id": "other"}),
            (
                LiteratureRead,
                {"ref_id": "literature:paper", "start_page": 1, "end_page": 1, "path": "x"},
            ),
            (LiteratureRead, {"ref_id": "attachment:paper", "start_page": 1, "end_page": 1}),
            (LiteratureRead, {"ref_id": "literature:paper", "start_page": 2, "end_page": 1}),
            (
                LiteratureRead,
                {
                    "ref_id": "literature:paper",
                    "start_page": 1,
                    "end_page": LITERATURE_MAX_PAGE_RANGE + 1,
                },
            ),
        ):
            with self.subTest(model=model.__name__, payload=payload):
                with self.assertRaises(ValidationError):
                    model.model_validate(payload)

    def test_commands_use_independent_literature_routes_and_keep_pdf_routes(self) -> None:
        self.assertEqual(
            set(LITERATURE_REQUESTS),
            {"list", "read", "authorize", ANNOTATIONS_OPERATION, "result", "review"},
        )
        self.assertEqual(
            BRIDGE_REQUESTS[("literature", "list")],
            (LiteratureList, LITERATURE_ROUTE_PREFIX + "list"),
        )
        self.assertEqual(
            BRIDGE_REQUESTS[("literature", "read")],
            (LiteratureRead, LITERATURE_ROUTE_PREFIX + "read"),
        )
        self.assertEqual(BRIDGE_REQUESTS[("literature", "result")][1], LITERATURE_RESULT_ROUTE)
        self.assertEqual(BRIDGE_REQUESTS[("pdf", "read")][1], PDF_ROUTE_PREFIX + "read")
        self.assertEqual(
            BRIDGE_REQUESTS[("literature", ANNOTATIONS_OPERATION)][1],
            LITERATURE_ROUTE_PREFIX + ANNOTATIONS_OPERATION,
        )

    def test_cli_exposes_page_contract(self) -> None:
        command = parser().parse_args(
            [
                "literature",
                "read",
                "--json",
                '{"ref_id":"literature:paper","start_page":1,"end_page":2}',
            ]
        )
        self.assertEqual((command.capability, command.operation), ("literature", "read"))
        annotations = parser().parse_args(
            [
                "literature",
                ANNOTATIONS_OPERATION,
                "--json",
                '{"ref_id":"literature:paper"}',
            ]
        )
        self.assertEqual(
            (annotations.capability, annotations.operation),
            ("literature", ANNOTATIONS_OPERATION),
        )

    def test_annotations_merge_attachment_records_and_entry_notes_without_citations(self) -> None:
        self.repository.create_note("paper", "entry note body", "Entry note")
        target = RecordTarget(
            RecordOwner.LITERATURE_ATTACHMENT,
            "paper",
            self.paper_attachment["id"],
        )
        initial = self.attachment_records.snapshot_target(target)
        records = {
            "schema_version": 1,
            "marks": [
                {
                    "id": "mark",
                    "style": "underline",
                    "color": "blue",
                    "page": 2,
                    "quads": [[0.1, 0.1, 0.4, 0.2]],
                    "text": "marked source text",
                    "anchor_state": "anchored",
                    "created_at": 1.0,
                    "updated_at": 2.0,
                }
            ],
            "comments": [
                {"id": "comment", "mark_id": "mark", "body": "reader comment", "created_at": 3.0}
            ],
            "notes": [
                {
                    "id": "pdf-note",
                    "title": "PDF note",
                    "body": "pdf note body",
                    "excerpts": [
                        {"id": "excerpt", "mark_id": "mark", "text": "note excerpt", "page": 2}
                    ],
                }
            ],
        }
        self.attachment_records.commit_target(
            target,
            records,
            initial.record_revision,
            initial.source_revision,
        )

        first = self.citations.service.literature_annotations(
            "session",
            "snapshot",
            LiteratureAnnotations(ref_id="literature:paper", limit=2),
        )
        second = self.citations.service.literature_annotations(
            "session",
            "snapshot",
            LiteratureAnnotations(ref_id="literature:paper", offset=2, limit=10),
        )
        items = first["items"] + second["items"]
        self.assertEqual(first["authority"], "user_feedback")
        self.assertEqual(
            {item["kind"] for item in items},
            {"literature_note", "mark", "comment", "pdf_note", "pdf_note_excerpt"},
        )
        self.assertEqual(first["revision"], second["revision"])
        self.assertEqual(first["next_offset"], 2)
        self.assertIsNone(second["next_offset"])
        self.assertNotIn("citation_url", str(items))
        self.assertTrue(all(item.get("attachment") == "paper.pdf" for item in items[1:]))

    def test_annotations_reject_foreign_literature(self) -> None:
        with self.assertRaisesRegex(ValueError, "literature_not_found"):
            self.citations.service.literature_annotations(
                "session",
                "snapshot",
                LiteratureAnnotations(ref_id="literature:foreign"),
            )

    def test_catalog_is_project_scoped_and_reports_total_pages(self) -> None:
        result = self.citations.service.literature_list("session", "snapshot", LiteratureList())
        self.assertEqual([source["ref_id"] for source in result["sources"]], ["literature:paper"])
        self.assertEqual(result["sources"][0]["total_pages"], 3)
        self.assertTrue(result["sources"][0]["readable"])
        self.assertIsNone(result["next_offset"])

    def test_catalog_keeps_an_item_whose_pdf_is_missing(self) -> None:
        self.repository.save(
            LiteratureItem(id="missing", title="Missing PDF"),
            project_id="project",
        )
        result = self.citations.service.literature_list("session", "snapshot", LiteratureList())
        missing = next(
            source for source in result["sources"] if source["ref_id"] == "literature:missing"
        )
        self.assertIsNone(missing["total_pages"])
        self.assertFalse(missing["readable"])
        self.assertEqual(missing["error"], "literature_pdf_missing")

    def test_read_returns_only_requested_pages_and_commits_fragment_receipts(self) -> None:
        request = LiteratureRead(ref_id="literature:paper", start_page=2, end_page=3)
        prepared = self.citations.service.literature_read("session", "snapshot", request, "turn")
        result = self.citations.service.commit_literature_read("session", "snapshot", prepared)
        self.assertEqual(self.page_indexes.reads, [(2, 3)])
        self.assertEqual([page["page"] for page in result["pages"]], [2, 3])
        self.assertIn("Project page 2", result["pages"][0]["text"])
        self.assertNotIn("Project page 1", result["pages"][0]["text"])
        self.assertIsNone(result["pages"][0]["citation_url"])
        fragment = result["pages"][0]["fragments"][0]
        self.assertTrue(fragment["citation_url"].startswith("scholarseed-cite:"))
        handle = fragment["citation_url"].split(":", 1)[1]
        receipt = self.citations.store.get("session", "snapshot", handle)
        self.assertEqual(receipt["fragment_kind"], "sentence")
        self.assertEqual(receipt["quote"], fragment["text"])
        self.assertEqual(receipt["pages"][0]["page"], 2)

    def test_read_keeps_sentence_receipts_separate_with_precise_geometry(self) -> None:
        first = PdfFragment(
            "sentence-one",
            "First supporting sentence.",
            (CitationPage(2, ((0.1, 0.1, 0.4, 0.2),)),),
            "sentence",
        )
        second = PdfFragment(
            "sentence-two",
            "Second supporting sentence.",
            (CitationPage(2, ((0.1, 0.3, 0.5, 0.4),)),),
            "sentence",
        )
        self.page_indexes.pages = Mock(return_value=(PdfPageContent(2, (first, second)),))

        request = LiteratureRead(ref_id="literature:paper", start_page=2, end_page=2)
        prepared = self.citations.service.literature_read("session", "snapshot", request, "turn")
        result = self.citations.service.commit_literature_read("session", "snapshot", prepared)

        page = result["pages"][0]
        self.assertEqual(page["text"], first.text + "\n\n" + second.text)
        self.assertIsNone(page["citation_url"])
        self.assertEqual([item["text"] for item in page["fragments"]], [first.text, second.text])
        handles = [item["citation_url"].split(":", 1)[1] for item in page["fragments"]]
        self.assertEqual(len(set(handles)), 2)
        receipts = [self.citations.store.get("session", "snapshot", handle) for handle in handles]
        self.assertEqual([receipt["quote"] for receipt in receipts], [first.text, second.text])
        self.assertEqual(
            [receipt["pages"][0]["quads"] for receipt in receipts],
            [[list(first.pages[0].quads[0])], [list(second.pages[0].quads[0])]],
        )

    def test_read_rejects_foreign_reference_and_document_overflow(self) -> None:
        with self.assertRaisesRegex(ValueError, "literature_not_found"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                LiteratureRead(ref_id="literature:foreign", start_page=1, end_page=1),
            )
        with self.assertRaisesRegex(ValueError, "literature_page_range_invalid"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                LiteratureRead(ref_id="literature:paper", start_page=3, end_page=4),
            )

    def test_independent_http_routes_enforce_active_bridge_scope(self) -> None:
        live = SimpleNamespace(
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        app = FastAPI()
        register_citation_bridge(app, sessions, self.citations.service)
        headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }
        with TestClient(app) as client:
            self.assertEqual(
                client.post(LITERATURE_ROUTE_PREFIX + "list", json={}).status_code,
                403,
            )
            listed = client.post(LITERATURE_ROUTE_PREFIX + "list", json={}, headers=headers)
            self.assertEqual(listed.status_code, 200, listed.text)
            read = client.post(
                LITERATURE_ROUTE_PREFIX + "read",
                json={"ref_id": "literature:paper", "start_page": 1, "end_page": 1},
                headers=headers,
            )
            self.assertEqual(read.status_code, 200, read.text)
            self.assertEqual(read.json()["pages"][0]["page"], 1)
            annotations = client.post(
                LITERATURE_ROUTE_PREFIX + ANNOTATIONS_OPERATION,
                json={"ref_id": "literature:paper"},
                headers=headers,
            )
            self.assertEqual(annotations.status_code, 200, annotations.text)
            self.assertEqual(annotations.json()["authority"], "user_feedback")
        self.assertEqual(live.publish.await_count, 3)

    def test_protected_tasks_allow_lists_and_block_fulltext_before_read(self) -> None:
        cases = (
            ("research_idea", RESEARCH_IDEA_FULLTEXT, "想法原文授权"),
            ("precise_search", PRECISE_SEARCH_FULLTEXT, "精准检索授权"),
            ("literature_review", LITERATURE_REVIEW_FULLTEXT, "综述检索授权"),
        )
        for task_type, authorization_type, header in cases:
            with self.subTest(task_type=task_type):
                live = SimpleNamespace(
                    id="session",
                    bridge_token="token",
                    active_assistant_snapshot_id="snapshot",
                    active_task_type=task_type,
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    publish=AsyncMock(),
                )
                sessions = SimpleNamespace(
                    bridge_caller=lambda session_id: live if session_id == live.id else None
                )
                authorizer = SimpleNamespace(
                    require=Mock(side_effect=ValueError("fulltext_authorization_required")),
                    prepare=Mock(
                        return_value=SimpleNamespace(
                            authorization_type=authorization_type,
                            scope_digest="digest",
                            question_id=f"{authorization_type}:challenge",
                        )
                    ),
                )
                app = FastAPI()
                register_citation_bridge(app, sessions, self.citations.service, authorizer)
                headers = {
                    BRIDGE_SESSION_HEADER: live.id,
                    BRIDGE_TOKEN_HEADER: live.bridge_token,
                }
                with TestClient(app) as client:
                    listed = client.post(LITERATURE_ROUTE_PREFIX + "list", json={}, headers=headers)
                    self.assertEqual(listed.status_code, 200, listed.text)
                    pdf_listed = client.post(PDF_ROUTE_PREFIX + "list", json={}, headers=headers)
                    self.assertEqual(pdf_listed.status_code, 200, pdf_listed.text)
                    mismatched_type = (
                        PRECISE_SEARCH_FULLTEXT
                        if authorization_type != PRECISE_SEARCH_FULLTEXT
                        else RESEARCH_IDEA_FULLTEXT
                    )
                    mismatched = client.post(
                        LITERATURE_ROUTE_PREFIX + "authorize",
                        json={
                            "authorization_type": mismatched_type,
                            "refs": ["literature:paper"],
                        },
                        headers=headers,
                    )
                    self.assertEqual(mismatched.status_code, 400, mismatched.text)
                    self.assertEqual(
                        mismatched.json()["error"], "fulltext_authorization_type_mismatch"
                    )
                    authorization = client.post(
                        LITERATURE_ROUTE_PREFIX + "authorize",
                        json={
                            "authorization_type": authorization_type,
                            "refs": ["literature:paper"],
                        },
                        headers=headers,
                    )
                    self.assertEqual(authorization.status_code, 200, authorization.text)
                    question = authorization.json()["question"]
                    self.assertEqual(question["header"], header)
                    self.assertEqual(
                        [option["label"] for option in question["options"]],
                        ["一键授权 (Recommended)", "拒绝"],
                    )
                    self.assertEqual(
                        [option["description"] for option in question["options"]],
                        [
                            "允许在本次任务和已展示文献范围内读取全文。",
                            "不读取全文，并停止本次全文处理。",
                        ],
                    )
                    before = list(self.page_indexes.reads)
                    for route, payload in (
                        (
                            LITERATURE_ROUTE_PREFIX + "read",
                            {
                                "ref_id": "literature:paper",
                                "start_page": 1,
                                "end_page": 1,
                            },
                        ),
                        (PDF_ROUTE_PREFIX + "read", {"ref_id": "ref"}),
                        (PDF_ROUTE_PREFIX + "search", {"ref_id": "ref", "query": "Project"}),
                        (PDF_ROUTE_PREFIX + "prepare", {"ref_id": "ref"}),
                        (PDF_ROUTE_PREFIX + "status", {"ref_id": "ref"}),
                        (
                            LITERATURE_ROUTE_PREFIX + ANNOTATIONS_OPERATION,
                            {"ref_id": "literature:paper"},
                        ),
                        (PDF_ROUTE_PREFIX + ANNOTATIONS_OPERATION, {"ref_id": "ref"}),
                        (
                            PDF_ROUTE_PREFIX + "materialize",
                            {"ref_id": "ref", "target": "materials/ref.txt"},
                        ),
                    ):
                        with self.subTest(route=route):
                            denied = client.post(route, json=payload, headers=headers)
                            self.assertEqual(denied.status_code, 400, denied.text)
                            self.assertEqual(
                                denied.json()["error"], "fulltext_authorization_required"
                            )
                    self.assertEqual(self.page_indexes.reads, before)
                self.assertEqual(authorizer.require.call_count, 8)
                authorizer.prepare.assert_called_once()

    def test_research_idea_literature_read_requires_durable_matching_hil_grant(self) -> None:
        live = SimpleNamespace(
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            active_task_type="research_idea",
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        database = Path(self.citations.temp.name) / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        authorizer = FulltextAuthorizer(database, catalog)
        app = FastAPI()
        register_citation_bridge(app, sessions, self.citations.service, authorizer)
        headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }
        read_request = {
            "ref_id": "literature:paper",
            "start_page": 1,
            "end_page": 1,
        }
        with TestClient(app) as client:
            authorization = client.post(
                LITERATURE_ROUTE_PREFIX + "authorize",
                json={
                    "authorization_type": "research_idea_fulltext",
                    "refs": ["literature:paper"],
                },
                headers=headers,
            )
            self.assertEqual(authorization.status_code, 200, authorization.text)
            question_id = authorization.json()["question"]["id"]
            before = list(self.page_indexes.reads)
            denied = client.post(
                LITERATURE_ROUTE_PREFIX + "read", json=read_request, headers=headers
            )
            self.assertEqual(denied.json()["error"], "fulltext_authorization_required")
            self.assertEqual(self.page_indexes.reads, before)
            catalog.record_hil(
                product_request_id="hil-research-idea",
                session_id=live.id,
                vendor_request_id="rpc-research-idea",
                vendor_turn_id="turn",
                vendor_item_id="item-research-idea",
                method="item/tool/requestUserInput",
                payload={"questions": [{"id": question_id}]},
            )
            catalog.resolve_hil("hil-research-idea", {"answers": {question_id: "一键授权"}})
            granted = client.post(
                LITERATURE_ROUTE_PREFIX + "read", json=read_request, headers=headers
            )
            self.assertEqual(granted.status_code, 200, granted.text)
            self.assertEqual(granted.json()["pages"][0]["page"], 1)
            # A product continuation runs as a new native turn; only the exact bound
            # client turn inherits the grant.
            (challenge,) = authorizer.session_scope(
                session_id=live.id,
                authorization_type="research_idea_fulltext",
                refs=("literature:paper",),
            )
            authorizer.bind_continuation(challenge, "continuation-turn")
            live.ledger.active_turn_id = "continuation-native-turn"
            live.active_product_turn_id = "unrelated-turn"
            unrelated = client.post(
                LITERATURE_ROUTE_PREFIX + "read", json=read_request, headers=headers
            )
            self.assertEqual(unrelated.json()["error"], "fulltext_authorization_required")
            live.active_product_turn_id = "continuation-turn"
            continued = client.post(
                LITERATURE_ROUTE_PREFIX + "read", json=read_request, headers=headers
            )
            self.assertEqual(continued.status_code, 200, continued.text)
        self.assertEqual(self.page_indexes.reads, [(1, 1), (1, 1)])

    def test_global_catalog_lists_user_literature_without_project_fallback(self) -> None:
        self.citations.snapshot = replace(self.citations.snapshot, project_id=None)
        self.citations.service._project = lambda _session_id: None
        result = self.citations.service.literature_list("session", "snapshot", LiteratureList())
        self.assertEqual(result["scope"], "global_literature_catalogue")
        self.assertEqual(
            {source["ref_id"] for source in result["sources"]},
            {"literature:foreign", "literature:paper"},
        )
        self.assertTrue(all(not source["readable"] for source in result["sources"]))

    def test_global_read_accepts_only_catalogue_managed_pdf(self) -> None:
        self.citations.snapshot = replace(self.citations.snapshot, project_id=None)
        self.citations.service._project = lambda _session_id: None
        request = LiteratureRead(ref_id="literature:paper", start_page=1, end_page=1)
        with self.assertRaisesRegex(ValueError, "literature_pdf_unavailable"):
            self.citations.service.literature_read("session", "snapshot", request)
        with (
            patch(
                "service.literature.service.evidence.is_managed_attachment",
                return_value=True,
            ),
            patch.object(
                self.evidence._pdf,
                "read",
                return_value=(self._pdf("Global"), "application/pdf"),
            ),
        ):
            result = self.citations.service.literature_read("session", "snapshot", request, "turn")
        self.assertEqual(result["scope"], "global_literature_catalogue")
        self.assertIn("Global page 1", result["pending_pages"][0]["text"])

    def test_bounded_extraction_and_persistent_page_cache(self) -> None:
        source = fixtures.SourceFixture(self.root / "cache")
        document = source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        indexes = PdfIndexService(source)
        try:
            pages = indexes.pages(document, 2, 2)
            self.assertEqual([page.page for page in pages], [2])
            self.assertTrue(
                all(anchor.page == 2 for item in pages[0].fragments for anchor in item.pages)
            )
        finally:
            indexes.close()
        database = Path(source.resolve("project", PROJECT_DB_RELATIVE))
        with sqlite3.connect(database) as connection:
            cached_pages = [
                row[0] for row in connection.execute(f"SELECT page_number FROM {PAGE_TABLE}")
            ]
        self.assertEqual(cached_pages, [2])
        reopened = PdfIndexService(source)
        try:
            original = reopened._parse_pages
            with patch.object(reopened, "_parse_pages", wraps=original) as parse_pages:
                self.assertEqual([page.page for page in reopened.pages(document, 1, 2)], [1, 2])
                parse_pages.assert_called_once_with(document, 1, 1)
            with patch.object(reopened, "_parse_pages", side_effect=AssertionError("cache miss")):
                self.assertEqual([page.page for page in reopened.pages(document, 1, 2)], [1, 2])
        finally:
            reopened.close()

    def test_forget_literature_drops_index_rows_of_unlinked_content(self) -> None:
        """Unlinking an attachment must take its cached full text with it.

        Literature index rows are keyed by content revision alone, so once the
        file is gone nothing can ever resolve them again; leaving them behind
        keeps the deleted paper's text readable inside the literature database
        and leaks storage forever. Rows of any other revision must survive.
        """
        source = fixtures.SourceFixture(self.root / "forget")
        database = self.root / "forget-literature.sqlite3"
        reference = fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper")
        forgotten = replace(
            source.citation_document("project", reference), storage_scope=LITERATURE_STORAGE
        )
        surviving_source = fixtures.SourceFixture(self.root / "forget-survivor")
        surviving_source.payload = fixtures.pdf_bytes(rotation=90)
        surviving = replace(
            surviving_source.citation_document("project", reference),
            storage_scope=LITERATURE_STORAGE,
        )
        indexes = PdfIndexService(source)
        try:
            with patch.object(indexing, "SERVICE_LITERATURE_DATABASE", database):
                self.assertEqual([page.page for page in indexes.pages(forgotten, 1, 1)], [1])
                self.assertIsNotNone(indexes.index(forgotten, wait=True))
                self.assertEqual([page.page for page in indexes.pages(surviving, 1, 1)], [1])

                def counts() -> list[int]:
                    with sqlite3.connect(database) as connection:
                        return [
                            connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                            for table in (INDEX_TABLE, METADATA_TABLE, PAGE_TABLE)
                        ]

                self.assertEqual(counts(), [1, 2, 2])
                self.assertEqual(indexes.forget_literature((forgotten.revision,)), 1)
                self.assertEqual(counts(), [0, 1, 1])
                with sqlite3.connect(database) as connection:
                    remaining = [
                        row[0] for row in connection.execute(f"SELECT revision FROM {PAGE_TABLE}")
                    ]
                self.assertEqual(remaining, [surviving.revision])
                # 已删的修订号再传一次是空操作, 不能误报删除数。
                self.assertEqual(indexes.forget_literature((forgotten.revision,)), 0)
                self.assertEqual(indexes.forget_literature(()), 0)
        finally:
            indexes.close()

    def test_page_count_reads_metadata_without_running_the_text_parser(self) -> None:
        source = fixtures.SourceFixture(self.root / "metadata")
        document = source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        indexes = PdfIndexService(source)
        try:
            with patch.object(indexes, "_run_parser", side_effect=AssertionError("text parsed")):
                self.assertEqual(indexes.page_count(document), 2)
                self.assertEqual(indexes.page_count(document), 2)
        finally:
            indexes.close()


if __name__ == "__main__":
    unittest.main()
