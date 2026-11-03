"""Project-literature directory, page parsing, cache and Bridge contracts."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.api.citations import register_citation_bridge
from service.assistant.service.authorization import (
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_FULLTEXT,
    AuthorizationDisposition,
    FulltextAuthorizer,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.service.tasks import ProductTaskLease
from service.cli.bridge import parser
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.persistence import files as literature_files
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE, AttachmentRole, LiteratureItem
from service.literature.service.attachment import (
    PATH_NOT_AUTHORIZED,
    LiteratureAttachmentContent,
)
from service.literature.service.evidence import LiteratureEvidenceService
from service.literature.service.records import AttachmentRecords
from service.paths import PROJECT_DB_RELATIVE
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    ANNOTATIONS_OPERATION,
    BRIDGE_REQUESTS,
    FULLTEXT_AUTHORIZATION_MAX_REFS,
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
    MANAGED_STORAGE_SCOPE,
    PDF_FORMULA,
    CitationDocument,
    CitationPage,
    PdfFragment,
    PdfPageContent,
)
from service.platform.context import (
    AssistantTurnItem,
    ContextItemRole,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ProductTaskType,
)
from service.platform.records import RecordOwner, RecordTarget
from service.platform.taxonomy import TAXONOMY_REQUESTS
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
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
AUTHORIZATION_WAIT_SECONDS = 3.0
AUTHORIZATION_REMAINDER_REFS = 4
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
        # 附件是文献独占的托管副本；目录及附件行均使用同一绝对路径身份。
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

    def _stage(
        self,
        literature_id: str,
        name: str,
        payload: bytes,
        role: AttachmentRole = AttachmentRole.PRIMARY,
        media_type: str = PDF_MEDIA_TYPE,
    ) -> dict[str, Any]:
        """Write one literature-owned attachment copy and register its row."""
        published = literature_files.managed_object(literature_id, payload, ".pdf")
        location = self.files / published.name
        location.write_bytes(payload)
        return self.repository.add_attachment(
            literature_id,
            name,
            str(location),
            revision=published.revision,
            role=role,
            media_type=media_type,
        )

    def _reference_whole_paper(self) -> None:
        self.citations.snapshot = replace(
            self.citations.snapshot,
            items=(
                AssistantTurnItem(
                    "e_paper",
                    ContextRef("literature:paper", ContextRefKind.LITERATURE, "paper", "Paper"),
                    ContextResolutionState.READY,
                    role=ContextItemRole.SCOPE,
                ),
            ),
        )

    def test_whole_literature_exposes_and_reads_supplementary_text_in_chunks(self) -> None:
        attachment = self._stage(
            "paper",
            "uploaded.md",
            "附件标记: supplemental-text".encode(),
            role=AttachmentRole.SUPPLEMENTARY,
            media_type="text/markdown",
        )
        self._reference_whole_paper()
        listed = self.citations.service.literature_list("session", "snapshot", LiteratureList())
        self.assertIn(
            attachment["id"], [entry["id"] for entry in listed["sources"][0]["attachments"]]
        )
        request = LiteratureRead(
            ref_id="literature:paper",
            attachment_id=attachment["id"],
            start_page=1,
            end_page=1,
            limit=5,
        )
        first = self.citations.service.literature_read("session", "snapshot", request, "turn")
        second = self.citations.service.literature_read(
            "session",
            "snapshot",
            request.model_copy(update={"offset": first["next_offset"], "limit": 100}),
            "turn",
        )
        self.assertEqual(first["text"] + second["text"], "附件标记: supplemental-text")
        self.assertIsNone(second["next_offset"])
        self.assertEqual(first["revision"], attachment["revision"])
        self.assertEqual(first["attachment_id"], attachment["id"])
        self.assertIn("/api/v1/literatures/paper?project_id=project", first["source_url"])
        self.assertNotIn("pages", first)

    def test_whole_literature_reads_supplementary_pdf_without_opening_it(self) -> None:
        attachment = self._stage(
            "paper",
            "supplementary.pdf",
            self._pdf("Supplementary"),
            role=AttachmentRole.SUPPLEMENTARY,
        )
        self._reference_whole_paper()
        prepared = self.citations.service.literature_read(
            "session",
            "snapshot",
            LiteratureRead(
                ref_id="literature:paper", attachment_id=attachment["id"], start_page=1, end_page=1
            ),
            "turn",
        )
        result = self.citations.service.commit_literature_read("session", "snapshot", prepared)
        fragment = result["pages"][0]["fragments"][0]
        receipt = self.citations.store.get(
            "session", "snapshot", fragment["citation_url"].split(":", 1)[1]
        )
        self.assertEqual(receipt["attachment_id"], attachment["id"])
        self.assertIn("Supplementary", result["pages"][0]["text"])

    def test_explicit_primary_uses_same_library_scope_as_implicit_primary(self) -> None:
        request = LiteratureRead(ref_id="literature:paper", start_page=1, end_page=1)
        implicit = self.citations.service.literature_read("session", "snapshot", request, "turn")
        explicit = self.citations.service.literature_read(
            "session",
            "snapshot",
            request.model_copy(update={"attachment_id": self.paper_attachment["id"]}),
            "turn",
        )
        implicit_result = self.citations.service.commit_literature_read(
            "session", "snapshot", implicit
        )
        explicit_result = self.citations.service.commit_literature_read(
            "session", "snapshot", explicit
        )
        self.assertEqual(explicit_result["pages"], implicit_result["pages"])
        with self.assertRaisesRegex(ValueError, "literature_not_found"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                request.model_copy(
                    update={
                        "ref_id": "literature:foreign",
                        "attachment_id": self.repository.attachments("foreign")[0]["id"],
                    }
                ),
                "turn",
            )

    def test_attachment_read_rejects_foreign_unsupported_and_unselected_sources(self) -> None:
        attachment = self._stage(
            "paper",
            "uploaded.md",
            b"supplement",
            role=AttachmentRole.SUPPLEMENTARY,
            media_type="text/markdown",
        )
        request = LiteratureRead(
            ref_id="literature:paper", attachment_id=attachment["id"], start_page=1, end_page=1
        )
        with self.assertRaisesRegex(ValueError, "citation_source_not_authorized"):
            self.citations.service.literature_read("session", "snapshot", request, "turn")
        self._reference_whole_paper()
        with self.assertRaisesRegex(ContentError, "literature_attachment_missing"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                request.model_copy(
                    update={"attachment_id": self.repository.attachments("foreign")[0]["id"]}
                ),
                "turn",
            )
        binary = self._stage(
            "paper",
            "image.png",
            b"unsupported",
            role=AttachmentRole.SUPPLEMENTARY,
            media_type="image/png",
        )
        with self.assertRaisesRegex(ValueError, "literature_attachment_format_unsupported"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                request.model_copy(update={"attachment_id": binary["id"]}),
                "turn",
            )

    def test_absolute_attachment_requires_registered_path_identity(self) -> None:
        content = LiteratureAttachmentContent(self.repository)
        path = self.paper_attachment["path"]
        attachment_id = self.paper_attachment["id"]
        self.assertEqual(content.absolute_location("paper", attachment_id), path)
        payload, media_type = content.read_absolute(path)
        self.assertEqual(payload, Path(path).read_bytes())
        self.assertEqual(media_type, PDF_MEDIA_TYPE)
        unregistered = self.files / "unregistered.pdf"
        unregistered.write_bytes(payload)
        for location in (str(unregistered), Path(path).name):
            with self.subTest(location=location):
                with self.assertRaisesRegex(ContentError, PATH_NOT_AUTHORIZED):
                    content.read_absolute(location)

    def test_absolute_attachment_rejects_unregistered_directory_alias(self) -> None:
        content = LiteratureAttachmentContent(self.repository)
        alias = self.root / "attachment-alias"
        if os.name == "nt":
            subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(self.files)],
                check=True,
                capture_output=True,
            )
        else:
            alias.symlink_to(self.files, target_is_directory=True)
        try:
            location = alias / Path(self.paper_attachment["path"]).name
            self.assertEqual(
                location.read_bytes(), Path(self.paper_attachment["path"]).read_bytes()
            )
            with self.assertRaisesRegex(ContentError, PATH_NOT_AUTHORIZED):
                content.read_absolute(str(location))
        finally:
            if os.name == "nt":
                alias.rmdir()
            else:
                alias.unlink()

    def test_request_schemas_are_page_based_and_exclude_scope_inputs(self) -> None:
        listed = LiteratureList.model_validate({"limit": 8})
        self.assertEqual(listed.model_dump(), {"offset": 0, "limit": 8})
        read = LiteratureRead.model_validate(
            {
                "ref_id": "literature:paper",
                "start_page": 1,
                "end_page": 3,
            }
        )
        self.assertEqual((read.start_page, read.end_page), (1, 3))
        self.assertNotIn("project_id", LiteratureList.model_fields)
        self.assertNotIn("project_id", LiteratureRead.model_fields)
        self.assertNotIn("path", LiteratureRead.model_fields)
        self.assertNotIn("query", LiteratureRead.model_fields)
        annotations = LiteratureAnnotations.model_validate(
            {
                "ref_id": "literature:paper",
                "limit": 8,
            }
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
            {
                "list",
                "read",
                "authorize",
                ANNOTATIONS_OPERATION,
                "result",
                "review",
                "acquire",
                "delivery",
                "ingest",
                "import",
                "receipt",
            }
            | set(TAXONOMY_REQUESTS),
        )
        self.assertEqual(
            (
                BRIDGE_REQUESTS[("literature", "list")].request_type,
                BRIDGE_REQUESTS[("literature", "list")].route,
            ),
            (LiteratureList, LITERATURE_ROUTE_PREFIX + "list"),
        )
        self.assertEqual(
            (
                BRIDGE_REQUESTS[("literature", "read")].request_type,
                BRIDGE_REQUESTS[("literature", "read")].route,
            ),
            (LiteratureRead, LITERATURE_ROUTE_PREFIX + "read"),
        )
        self.assertEqual(BRIDGE_REQUESTS[("literature", "result")].route, LITERATURE_RESULT_ROUTE)
        self.assertEqual(BRIDGE_REQUESTS[("pdf", "read")].route, PDF_ROUTE_PREFIX + "read")
        self.assertEqual(
            BRIDGE_REQUESTS[("literature", ANNOTATIONS_OPERATION)].route,
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

    def test_current_supplementary_pdf_reads_and_cites_exact_attachment(self) -> None:
        attachment = self._stage(
            "paper",
            "supplementary.pdf",
            self._pdf("Supplementary"),
            role=AttachmentRole.SUPPLEMENTARY,
        )
        current = AssistantTurnItem(
            "e_02",
            ContextRef(
                "current-paper",
                ContextRefKind.LITERATURE,
                "paper",
                "Project Paper",
                source_revision=attachment["revision"],
                origin=ContextOrigin.CURRENT_DOCUMENT,
            ),
            ContextResolutionState.READY,
            role=ContextItemRole.SCOPE,
            model_locator="literature:paper",
            surface={"kind": "literature", "attachment_id": attachment["id"]},
        )
        self.citations.snapshot = replace(
            self.citations.snapshot,
            items=(*self.citations.snapshot.items, current),
        )
        request = LiteratureRead(ref_id="literature:paper", start_page=2, end_page=2)
        prepared = self.citations.service.literature_read("session", "snapshot", request, "turn")
        result = self.citations.service.commit_literature_read("session", "snapshot", prepared)
        self.assertIn("Supplementary page 2", result["pages"][0]["text"])
        self.assertNotIn("Project page 2", result["pages"][0]["text"])
        handle = result["pages"][0]["fragments"][0]["citation_url"].split(":", 1)[1]
        receipt = self.citations.store.get("session", "snapshot", handle)
        self.assertEqual(receipt["attachment_id"], attachment["id"])
        document = self.citations.service._document(receipt)
        self.assertEqual(document.record_target.subject_id, attachment["id"])
        self.assertEqual(document.revision, attachment["revision"])
        with self.assertRaisesRegex(ValueError, "citation_source_not_authorized"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                LiteratureRead(
                    ref_id="literature:paper",
                    start_page=1,
                    end_page=1,
                    attachment_id=self.paper_attachment["id"],
                ),
            )

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
            bridge_caller=lambda session_id, _live=live: (_live if session_id == _live.id else None)
        )
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_citation_bridge(app, sessions, self.citations.service, activities=activities)
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

    def test_authorization_waits_for_product_decision_and_rechecks_task(self) -> None:
        async def exercise(outcome: str) -> None:
            database = Path(self.citations.temp.name) / f"authorization-{outcome}.sqlite3"
            catalog = SessionCatalogStore(database)
            catalog.register(
                "session",
                SessionPrincipal("local"),
                runtime_id="codex",
                vendor_thread_id="session",
                vendor_session_id=None,
                runtime_workdir=self.citations.temp.name,
                project_path=None,
                output_root=self.citations.temp.name,
                codex_version="contract",
                model_id="contract",
                policy_id="on-request",
                status=SessionStatus.READY,
                title="contract",
                created_at=1.0,
            )
            authorizer = FulltextAuthorizer(database, catalog)
            requested, release = asyncio.Event(), asyncio.Event()
            questions: list[dict] = []

            async def request_product_input(question, *, turn_id, activity=None):
                questions.append(question)
                requested.set()
                await release.wait()
                decision = (
                    {"cancelled": True}
                    if outcome == "cancelled"
                    else {
                        "answers": {question["id"]: "拒绝" if outcome == "rejected" else "一键授权"}
                    }
                )
                catalog.record_hil(
                    product_request_id=question["id"],
                    session_id="session",
                    vendor_request_id=question["id"],
                    vendor_turn_id=turn_id,
                    vendor_item_id=None,
                    method="item/tool/requestUserInput",
                    payload={"questions": [question]},
                )
                catalog.resolve_hil(question["id"], decision)
                return decision

            live: Any = SimpleNamespace(
                component_for=AsyncMock(return_value=None),
                id="session",
                bridge_token="token",
                active_assistant_snapshot_id="snapshot",
                active_task_type="literature_review",
                active_product_turn_id="turn",
                product_turn_generation=1,
                current_task=SimpleNamespace(done=lambda: False),
                active_task_lease=ProductTaskLease(
                    task_type=ProductTaskType.LITERATURE_REVIEW,
                    turn_id="turn",
                    generation=1,
                    source="skill_run",
                    workspace="run",
                    run_id="run",
                ),
                ledger=SimpleNamespace(active_turn_id="turn"),
                publish=AsyncMock(),
                interactions=SimpleNamespace(request_product_input=request_product_input),
            )
            sessions: Any = SimpleNamespace(
                bridge_caller=lambda session_id: live if session_id == live.id else None
            )
            activities = Activities()
            live.turn_activity = activities.enter(ActivityDomain.TURN)
            app = FastAPI()
            citations = self.citations.service
            batches = [
                f"literature:paper-{index}"
                for index in range(FULLTEXT_AUTHORIZATION_MAX_REFS + AUTHORIZATION_REMAINDER_REFS)
            ]
            if outcome == "batched":
                citations = Mock(wraps=citations)
                citations.authorization_sources.side_effect = (
                    lambda _session, _snapshot, _turn, refs: tuple(
                        {"ref_id": ref, "title": ref} for ref in refs
                    )
                )
            register_citation_bridge(app, sessions, citations, authorizer, activities=activities)
            headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
            payload = {
                "authorization_type": LITERATURE_REVIEW_FULLTEXT,
                "refs": (
                    batches[:FULLTEXT_AUTHORIZATION_MAX_REFS]
                    if outcome == "batched"
                    else ["literature:paper"]
                ),
            }
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test", headers=headers
            ) as client:
                authorization = asyncio.create_task(
                    client.post(LITERATURE_ROUTE_PREFIX + "authorize", json=payload)
                )
                waiting = asyncio.create_task(requested.wait())
                try:
                    await asyncio.wait(
                        (authorization, waiting),
                        timeout=AUTHORIZATION_WAIT_SECONDS,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    self.assertTrue(
                        requested.is_set(),
                        f"authorize must publish the real product question: {authorization.result().text if authorization.done() else 'still waiting'}",
                    )
                    self.assertFalse(
                        authorization.done(), "authorize must wait for the durable decision"
                    )
                    denied = await client.post(
                        LITERATURE_ROUTE_PREFIX + "read",
                        json={"ref_id": "literature:paper", "start_page": 1, "end_page": 1},
                    )
                    self.assertEqual(denied.json()["error"], "fulltext_authorization_required")
                    if outcome == "stale":
                        live.active_task_lease = replace(
                            live.active_task_lease, run_id="another-run"
                        )
                    elif outcome == "stale_type":
                        live.active_task_type = "research_idea"
                    release.set()
                    response = await authorization
                    if outcome in ("stale", "stale_type"):
                        self.assertFalse(response.json()["ok"])
                        return
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    if outcome == "batched":
                        self.assertEqual(
                            result["granted_refs"], batches[:FULLTEXT_AUTHORIZATION_MAX_REFS]
                        )
                        remainder = {**payload, "refs": batches[FULLTEXT_AUTHORIZATION_MAX_REFS:]}
                        second = await client.post(
                            LITERATURE_ROUTE_PREFIX + "authorize", json=remainder
                        )
                        self.assertEqual(second.json()["granted_refs"], remainder["refs"])
                        self.assertEqual(
                            second.json()["disposition"], AuthorizationDisposition.AUTHORIZED.value
                        )
                        repeated = await client.post(
                            LITERATURE_ROUTE_PREFIX + "authorize", json=payload
                        )
                        self.assertEqual(repeated.json()["granted_refs"], payload["refs"])
                        oversized = await client.post(
                            LITERATURE_ROUTE_PREFIX + "authorize", json={**payload, "refs": batches}
                        )
                        self.assertEqual(oversized.status_code, 400)
                        self.assertEqual(len(questions), 2)
                        return
                    expected = (
                        AuthorizationDisposition.AUTHORIZED
                        if outcome == "authorized"
                        else AuthorizationDisposition.REJECTED
                    )
                    self.assertEqual(result["disposition"], expected.value)
                    self.assertEqual(
                        result["granted_refs"],
                        ["literature:paper"] if outcome == "authorized" else [],
                    )
                    self.assertIsNone(result.get("question"))
                    read = await client.post(
                        LITERATURE_ROUTE_PREFIX + "read",
                        json={"ref_id": "literature:paper", "start_page": 1, "end_page": 1},
                    )
                    self.assertEqual(read.status_code, 200 if outcome == "authorized" else 400)
                    outside = await client.post(
                        LITERATURE_ROUTE_PREFIX + "read",
                        json={"ref_id": "literature:foreign", "start_page": 1, "end_page": 1},
                    )
                    self.assertEqual(outside.json()["error"], "fulltext_authorization_required")
                    if outcome != "cancelled":
                        repeated = await client.post(
                            LITERATURE_ROUTE_PREFIX + "authorize", json=payload
                        )
                        self.assertEqual(repeated.json()["disposition"], expected.value)
                        self.assertEqual(
                            len(questions), 1, "reuse the durable decision for the same scope"
                        )
                finally:
                    release.set()
                    waiting.cancel()
                    authorization.cancel()
                    await asyncio.gather(waiting, authorization, return_exceptions=True)
                    live.turn_activity.close()

        for outcome in ("authorized", "rejected", "cancelled", "stale", "stale_type", "batched"):
            with self.subTest(outcome=outcome):
                asyncio.run(exercise(outcome))

    def test_protected_tasks_allow_lists_and_block_fulltext_before_read(self) -> None:
        cases = (
            ("research_idea", RESEARCH_IDEA_FULLTEXT, "想法原文授权"),
            ("precise_search", PRECISE_SEARCH_FULLTEXT, "精准检索授权"),
            ("literature_review", LITERATURE_REVIEW_FULLTEXT, "综述检索授权"),
        )
        for task_type, authorization_type, header in cases:
            with self.subTest(task_type=task_type):
                live = SimpleNamespace(
                    component_for=AsyncMock(return_value=None),
                    id="session",
                    bridge_token="token",
                    active_assistant_snapshot_id="snapshot",
                    active_task_type=task_type,
                    active_product_turn_id="turn",
                    product_turn_generation=1,
                    current_task=SimpleNamespace(done=lambda: False),
                    active_task_lease=(
                        ProductTaskLease(
                            task_type=ProductTaskType(task_type),
                            turn_id="turn",
                            generation=1,
                            source="skill_run",
                            workspace="run",
                            run_id="run",
                        )
                        if task_type != "research_idea"
                        else None
                    ),
                    ledger=SimpleNamespace(active_turn_id="turn"),
                    publish=AsyncMock(),
                    interactions=SimpleNamespace(
                        request_product_input=AsyncMock(return_value={"cancelled": True})
                    ),
                )
                sessions = SimpleNamespace(
                    bridge_caller=lambda session_id, _live=live: (
                        _live if session_id == _live.id else None
                    )
                )
                authorizer = SimpleNamespace(
                    effective_scope=lambda **scope: SimpleNamespace(
                        allowed=(), denied=(), unknown=scope.get("refs", ()), authorizations=()
                    ),
                    require=Mock(side_effect=ValueError("fulltext_authorization_required")),
                    prepare=Mock(
                        return_value=SimpleNamespace(
                            authorization_type=authorization_type,
                            scope_digest="digest",
                            question_id=f"{authorization_type}:challenge",
                            turn_id="turn",
                        )
                    ),
                )
                app = FastAPI()
                activities = Activities()
                live.turn_activity = activities.enter(ActivityDomain.TURN)
                self.addCleanup(live.turn_activity.close)
                register_citation_bridge(
                    app, sessions, self.citations.service, authorizer, activities=activities
                )
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
                    self.assertIsNone(authorization.json()["question"])
                    self.assertEqual(authorization.json()["disposition"], "rejected")
                    question = live.interactions.request_product_input.await_args.args[0]
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
            component_for=AsyncMock(return_value=None),
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            active_task_type="research_idea",
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id, _live=live: (_live if session_id == _live.id else None)
        )
        database = Path(self.citations.temp.name) / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        authorizer = FulltextAuthorizer(database, catalog)

        async def request_product_input(question, *, turn_id, activity=None):
            catalog.record_hil(
                product_request_id=question["id"],
                session_id=live.id,
                vendor_request_id=question["id"],
                vendor_turn_id=turn_id,
                vendor_item_id=None,
                method="item/tool/requestUserInput",
                payload={"questions": [question]},
            )
            decision = {"answers": {question["id"]: "一键授权"}}
            catalog.resolve_hil(question["id"], decision)
            return decision

        live.interactions = SimpleNamespace(request_product_input=request_product_input)
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_citation_bridge(
            app, sessions, self.citations.service, authorizer, activities=activities
        )
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
            before = list(self.page_indexes.reads)
            denied = client.post(
                LITERATURE_ROUTE_PREFIX + "read", json=read_request, headers=headers
            )
            self.assertEqual(denied.json()["error"], "fulltext_authorization_required")
            self.assertEqual(self.page_indexes.reads, before)
            authorization = client.post(
                LITERATURE_ROUTE_PREFIX + "authorize",
                json={
                    "authorization_type": "research_idea_fulltext",
                    "refs": ["literature:paper"],
                },
                headers=headers,
            )
            self.assertEqual(authorization.status_code, 200, authorization.text)
            self.assertEqual(authorization.json()["granted_refs"], ["literature:paper"])
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
        self.assertTrue(all(source["readable"] for source in result["sources"]))

    def test_global_read_uses_managed_copy_and_refuses_missing_bytes(self) -> None:
        self.citations.snapshot = replace(self.citations.snapshot, project_id=None)
        self.citations.service._project = lambda _session_id: None
        request = LiteratureRead(ref_id="literature:paper", start_page=1, end_page=1)
        result = self.citations.service.literature_read("session", "snapshot", request, "turn")
        self.assertEqual(result["scope"], "global_literature_catalogue")
        self.assertIn("Project page 1", result["pending_pages"][0]["text"])
        # A cached index cannot substitute for the actual managed source bytes.
        location = self.evidence._pdf.location(self.repository.get("paper"))
        Path(location).unlink()
        with self.assertRaisesRegex(ValueError, "literature_pdf_unavailable"):
            self.citations.service.literature_read("session", "snapshot", request, "turn")

        self.repository.save(LiteratureItem(id="unmanaged", title="Unmanaged"))
        external = self.root / "outside.pdf"
        external_payload = self._pdf("Outside")
        external.write_bytes(external_payload)
        self.repository.add_attachment(
            "unmanaged",
            "outside.pdf",
            str(external),
            revision=literature_files.payload_revision(external_payload),
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        with self.assertRaisesRegex(ValueError, "literature_pdf_unavailable"):
            self.citations.service.literature_read(
                "session",
                "snapshot",
                LiteratureRead(ref_id="literature:unmanaged", start_page=1, end_page=1),
            )

    def test_bounded_extraction_and_persistent_page_cache(self) -> None:
        source = fixtures.SourceFixture(self.root / "cache")
        document = source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        indexes = PdfIndexService(source, activities=Activities())
        try:
            pages = indexes.pages(document, 2, 2)
            self.assertEqual([page.page for page in pages], [2])
            self.assertTrue(
                all(anchor.page == 2 for item in pages[0].fragments for anchor in item.pages)
            )
        finally:
            indexes.close()
        database = Path(source.resolve("project", PROJECT_DB_RELATIVE))
        with closing(sqlite3.connect(database)) as connection:
            cached_pages = [
                row[0] for row in connection.execute(f"SELECT page_number FROM {PAGE_TABLE}")
            ]
        self.assertEqual(cached_pages, [2])
        reopened = PdfIndexService(source, activities=Activities())
        try:
            original = reopened._parse_pages
            with patch.object(reopened, "_parse_pages", wraps=original) as parse_pages:
                self.assertEqual([page.page for page in reopened.pages(document, 1, 2)], [1, 2])
                parse_pages.assert_called_once_with(document, 1, 1)
            with patch.object(reopened, "_parse_pages", side_effect=AssertionError("cache miss")):
                self.assertEqual([page.page for page in reopened.pages(document, 1, 2)], [1, 2])
        finally:
            reopened.close()

    def test_visual_regions_survive_the_persistent_page_cache(self) -> None:
        source = fixtures.SourceFixture(self.root / "region-cache")
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            page.insert_text(
                (170, 100),
                "L(theta) = E[r] - beta * D_KL(pi || pi_ref)",
                fontsize=13,
            )
            source.payload = pdf.tobytes()
        document = source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        indexes = PdfIndexService(source, activities=Activities())
        try:
            regions = indexes.pages(document, 1, 1)[0].regions
            self.assertEqual([item.kind for item in regions], [PDF_FORMULA])
        finally:
            indexes.close()
        reopened = PdfIndexService(source, activities=Activities())
        try:
            with patch.object(reopened, "_parse_pages", side_effect=AssertionError("cache miss")):
                self.assertEqual(reopened.pages(document, 1, 1)[0].regions, regions)
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
        indexes = PdfIndexService(source, activities=Activities())
        try:
            with patch.object(indexing, "SERVICE_LITERATURE_DATABASE", database):
                self.assertEqual([page.page for page in indexes.pages(forgotten, 1, 1)], [1])
                self.assertIsNotNone(indexes.index(forgotten, wait=True))
                self.assertEqual([page.page for page in indexes.pages(surviving, 1, 1)], [1])

                def counts() -> list[int]:
                    with closing(sqlite3.connect(database)) as connection:
                        return [
                            connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                            for table in (INDEX_TABLE, METADATA_TABLE, PAGE_TABLE)
                        ]

                self.assertEqual(counts(), [1, 2, 2])
                self.assertEqual(indexes.forget_literature((forgotten.revision,)), 1)
                self.assertEqual(counts(), [0, 1, 1])
                with closing(sqlite3.connect(database)) as connection:
                    remaining = [
                        row[0] for row in connection.execute(f"SELECT revision FROM {PAGE_TABLE}")
                    ]
                self.assertEqual(remaining, [surviving.revision])
                # 已删的修订号再传一次是空操作, 不能误报删除数。
                self.assertEqual(indexes.forget_literature((forgotten.revision,)), 0)
                self.assertEqual(indexes.forget_literature(()), 0)
        finally:
            indexes.close()

    def test_managed_fulltext_indexes_use_user_storage_without_a_project(self) -> None:
        """Serve-held full texts must index in sessions that have no project.

        Literature-overview sessions carry an empty project id while managed
        bytes live in the user-level literature store; dispatching them to a
        project database raised ``no_project_selected`` (Bug 87345701). The same
        dispatch keeps project-bound sessions from writing serve-held indexes
        into ``project.sqlite3``.
        """
        catalog = ContentCatalog(self.root / "content.sqlite3")
        registry = ProjectRegistry(str(self.root / "workspace"), catalog)
        activities = Activities()
        content = ContentService(registry, catalog, activities=activities)
        project = registry.create("托管索引项目")
        indexes = PdfIndexService(content, activities=activities)
        database = self.root / "managed-indexes.sqlite3"
        reference = fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper")
        source = fixtures.SourceFixture(self.root / "managed")
        managed = replace(
            source.citation_document("", reference), storage_scope=MANAGED_STORAGE_SCOPE
        )
        bound = replace(managed, project_id=project.id)
        try:
            with patch.object(indexing, "SERVICE_LITERATURE_DATABASE", database):
                self.assertEqual([page.page for page in indexes.pages(managed, 1, 1)], [1])
                self.assertIsNotNone(indexes.index(managed, wait=True))
                self.assertEqual([page.page for page in indexes.pages(bound, 1, 1)], [1])
                with closing(sqlite3.connect(database)) as connection:
                    revisions = {
                        row[0] for row in connection.execute(f"SELECT revision FROM {PAGE_TABLE}")
                    }
        finally:
            indexes.close()
        self.assertEqual(revisions, {managed.revision})
        self.assertEqual(list(self.root.rglob("project.sqlite3")), [])

    def test_page_count_reads_metadata_without_running_the_text_parser(self) -> None:
        source = fixtures.SourceFixture(self.root / "metadata")
        document = source.citation_document(
            "project",
            fixtures.ContextRef("ref", fixtures.ContextRefKind.FILE, "paper.pdf", "Paper"),
        )
        indexes = PdfIndexService(source, activities=Activities())
        try:
            with patch.object(indexes, "_run_parser", side_effect=AssertionError("text parsed")):
                self.assertEqual(indexes.page_count(document), 2)
                self.assertEqual(indexes.page_count(document), 2)
        finally:
            indexes.close()


if __name__ == "__main__":
    unittest.main()
