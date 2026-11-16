"""Project-literature directory, page parsing, cache and Bridge contracts."""

from __future__ import annotations

import asyncio
import json
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
from service.assistant.service.excerpts import MODEL_EXCERPT_BYTES, model_excerpt
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.service.tasks import ProductTaskLease
from service.cli.bridge import parser
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.persistence import files as literature_files
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.cards import PaperCards
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE, AttachmentRole, LiteratureItem
from service.literature.service.abstracts import local_abstract
from service.literature.service.attachment import (
    PATH_NOT_AUTHORIZED,
    LiteratureAttachmentContent,
)
from service.literature.service.candidates import prepare_candidates
from service.literature.service.evidence import LiteratureEvidenceService
from service.literature.service.knowledge import KNOWLEDGE_MAX_BYTES, project_knowledge
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
    LiteratureKnowledge,
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
    evidence_blocks,
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
    "Copy the complete `fragments[].citation_url` verbatim into an inline link",
    "Never reconstruct a handle or print a raw-handle reference list.",
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
    def test_historical_literature_citation_preserves_excerpt_when_attachment_or_item_is_deleted(
        self,
    ):
        self._reference_whole_paper()
        prepared = self.citations.service.literature_read(
            "session",
            "snapshot",
            LiteratureRead(
                ref_id="literature:paper",
                attachment_id=self.paper_attachment["id"],
                start_page=1,
                end_page=1,
            ),
            "turn",
        )
        result = self.citations.service.commit_literature_read("session", "snapshot", prepared)
        handle = result["pages"][0]["fragments"][0]["citation_url"].split(":", 1)[1]
        receipt = self.citations.store.get("session", "snapshot", handle)
        original = self.citations.service.resolve_saved(receipt, "project")
        self.assertEqual(original["state"], "exact")
        denied = self.citations.service.resolve_saved({**receipt, "project_id": "other"}, "other")
        self.assertEqual(denied["state"], "unavailable")
        self.assertFalse(denied["source_missing"])
        path = Path(self.paper_attachment["path"])
        payload = path.read_bytes()
        path.unlink()
        missing_bytes = self.citations.service.resolve_saved(receipt, "project")
        self.assertTrue(missing_bytes["source_missing"])
        self.assertEqual(missing_bytes["quote"], original["quote"])
        path.write_bytes(payload)
        self.repository.delete_attachment("paper", self.paper_attachment["id"])
        missing_attachment = self.citations.service.resolve_saved(receipt, "project")
        self.assertTrue(missing_attachment["source_missing"])
        self.assertEqual(missing_attachment["state"], "unavailable")
        self.assertEqual(missing_attachment["quote"], original["quote"])
        self.repository.delete("paper", confirm=True)
        missing_item = self.citations.service.resolve_saved(receipt, "project")
        self.assertTrue(missing_item["source_missing"])
        self.assertEqual(missing_item["quote"], original["quote"])
        self.assertFalse(missing_item["can_open_pdf"])

    def test_citation_bibliography_uses_scoped_catalogue_metadata(self) -> None:
        self.repository.save(
            LiteratureItem(
                id="paper",
                title="Stored title",
                authors="Ada; 李明",
                year=2025,
                journal="Stored journal",
                url="https://example.org/paper",
                doi="10.1000/stored",
            ),
            project_id="project",
        )
        metadata = self.evidence.metadata("project", "paper")
        self.assertEqual(metadata["publication"], "Stored journal")
        self.assertEqual(metadata["url"], "https://example.org/paper")
        self.assertEqual(metadata["doi"], "10.1000/stored")
        projected = self.citations.service._bibliography(
            {"source_kind": "literature", "project_id": "project", "source_id": "paper"}
        )
        self.assertEqual(
            projected,
            {
                "version": 1,
                "title": "Stored title",
                "authors": "Ada; 李明",
                "year": "2025",
                "publication": "Stored journal",
                "url": "https://example.org/paper",
                "doi": "10.1000/stored",
            },
        )
        self.assertIsNone(
            self.citations.service._bibliography(
                {"source_kind": "literature", "project_id": "other", "source_id": "paper"}
            )
        )
        attachment = self._stage("paper", "bibliography.pdf", self._pdf("Bibliography"))
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
        handle = result["pages"][0]["fragments"][0]["citation_url"].split(":", 1)[1]
        receipt = self.citations.store.get("session", "snapshot", handle)
        resolved = self.citations.service.resolve_saved(receipt, "project")
        self.assertEqual(resolved["bibliography"], projected)
        self.assertEqual(resolved["state"], "exact")

    def test_project_literature_skill_exclusively_owns_opaque_citation_urls(self) -> None:
        skill = " ".join(PROJECT_LITERATURE_SKILL.read_text(encoding="utf-8").split())
        prompt = " ".join(HOST_PROMPT.read_text(encoding="utf-8").split())

        for rule in CITATION_IDENTITY_RULES:
            with self.subTest(rule=rule):
                self.assertIn(rule, skill)
                self.assertNotIn(rule, prompt)
        self.assertIn("[1](scholarseed-cite:HANDLE)", skill)
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
        self.analysis = AnalysisStore(self.repository.database)
        self.evidence._analysis = self.analysis
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

    def test_model_excerpt_preserves_citations_and_stored_geometry_without_page_duplication(self):
        prepared = self.citations.service.literature_read(
            "session",
            "snapshot",
            LiteratureRead(ref_id="literature:paper", start_page=1, end_page=2),
            "turn",
        )
        full = self.citations.service.commit_literature_read("session", "snapshot", prepared)
        before = json.dumps(full, ensure_ascii=False)
        projected = model_excerpt(full)
        self.assertEqual(json.dumps(full, ensure_ascii=False), before)
        self.assertNotIn("text", projected["pages"][0])
        for original_page, page in zip(full["pages"], projected["pages"]):
            for original, fragment in zip(original_page["fragments"], page["fragments"]):
                self.assertEqual(fragment["text"], original["text"])
                self.assertEqual(fragment["citation_url"], original["citation_url"])
                receipt = self.citations.store.get(
                    "session", "snapshot", fragment["citation_url"].split(":", 1)[1]
                )
                self.assertEqual(receipt["quote"], fragment["text"])
                self.assertEqual(receipt["fragment_ids"], original["fragment_ids"])
                self.assertEqual(receipt["pages"][0]["page"], page["page"])

    def test_model_excerpt_returns_result_evidence_and_keeps_uncited_summaries(self):
        self.analysis.publish(self._knowledge_asset(), "saved")
        prepared = self.citations.service.literature_knowledge(
            "session",
            "snapshot",
            LiteratureKnowledge(ref_id="literature:paper", sections=["overview", "results"]),
            "turn",
        )
        full = self.citations.service.commit_read("session", "snapshot", prepared)
        projected = model_excerpt(full)
        original = {item["path"]: item for item in full["fields"]}
        for field in projected["fields"]:
            if field["path"] == "card.experiments.results[0]":
                self.assertIsNone(field["value"])
                self.assertEqual(field["source"], "original_evidence")
                self.assertTrue(field["source_available"])
                self.assertEqual(
                    original[field["path"]]["value"]["conditions"], "Only this dataset"
                )
            else:
                self.assertEqual(field, original[field["path"]])
        self.assertEqual(projected["context_evidence_ids"], full["context_evidence_ids"])
        for original, fragment in zip(full["fragments"], projected["fragments"]):
            self.assertEqual(fragment["fragment_ids"], original["fragment_ids"])
            self.assertEqual(fragment["text"], original["text"])
            self.assertEqual(fragment["citation_url"], original["citation_url"])
            self.assertNotIn("title", fragment)

    def test_model_excerpt_bounds_utf8_pages_atomically_and_marks_unreturned_pages(self):
        pages = [
            {
                "page": number,
                "text": "条件与结论" * 800,
                "unavailable": False,
                "omitted_regions": [],
                "fragments": [
                    {
                        "text": "条件与结论" * 800,
                        "citation_url": f"scholarseed-cite:{number:032x}",
                        "pages": [number],
                    }
                ],
            }
            for number in range(1, 4)
        ]
        full = {"ok": True, "state": "ready", "pages": pages, "ref_id": "literature:paper"}
        projected = model_excerpt(full)
        self.assertLessEqual(
            len(json.dumps(projected, ensure_ascii=False).encode()), MODEL_EXCERPT_BYTES
        )
        self.assertEqual(len(projected["pages"]), 1)
        self.assertEqual(projected["pages"][0]["fragments"], pages[0]["fragments"])
        self.assertEqual(projected["model_delivery"]["omitted_pages"], [2, 3])
        self.assertEqual(projected["model_delivery"]["oversized_pages"], [])
        self.assertEqual(len(full["pages"]), 3)
        pages[0]["fragments"][0]["text"] *= 4
        projected = model_excerpt(full)
        self.assertIn(1, projected["model_delivery"]["oversized_pages"])
        self.assertNotIn(1, [page["page"] for page in projected["pages"]])

    def test_model_excerpt_bounds_l1_field_with_all_its_support_and_keeps_resume_offset(self):
        fields = [
            {"path": f"claims[{i}]", "value": "结论与实验条件", "evidence_ids": [f"s{i}"]}
            for i in range(3)
        ]
        fragments = [
            {
                "fragment_ids": [f"s{i}"],
                "text": "完整原文条件" * 800,
                "citation_url": f"scholarseed-cite:{i:032x}",
                "pages": [1],
            }
            for i in range(3)
        ]
        full = {
            "ok": True,
            "state": "ready",
            "fields": fields,
            "fragments": fragments,
            "context_evidence_ids": [],
            "next_offset": None,
            "truncated": False,
        }
        projected = model_excerpt(full, offset=4)
        self.assertLessEqual(
            len(json.dumps(projected, ensure_ascii=False).encode()), MODEL_EXCERPT_BYTES
        )
        self.assertEqual(projected["fields"], fields[:1])
        self.assertEqual(projected["fragments"], fragments[:1])
        self.assertEqual(projected["next_offset"], 5)
        self.assertEqual(projected["model_delivery"]["omitted_fields"], ["claims[1]", "claims[2]"])
        self.assertEqual(full["fields"], fields)
        self.assertIsNone(full["next_offset"])

    def test_model_excerpt_prefers_mapped_evidence_over_large_additional_context(self):
        primary = {
            "fragment_ids": ["primary"],
            "text": "完整实验条件及结果。",
            "pages": [2],
            "citation_url": "scholarseed-cite:" + "1" * 32,
        }
        context = {
            "fragment_ids": ["context"],
            "text": "额外上下文" * MODEL_EXCERPT_BYTES,
            "pages": [2],
            "citation_url": "scholarseed-cite:" + "2" * 32,
        }
        full = {
            "ok": True,
            "state": "ready",
            "fields": [{"path": "result", "value": "条件及结果", "evidence_ids": ["primary"]}],
            "fragments": [context, primary],
            "context_evidence_ids": ["context"],
            "next_offset": None,
        }
        projected = model_excerpt(full)
        self.assertEqual(projected["fields"], full["fields"])
        self.assertEqual(projected["fragments"], [primary])
        self.assertEqual(projected["context_evidence_ids"], [])
        self.assertEqual(projected["model_delivery"]["omitted_context_count"], 1)
        self.assertEqual(projected["model_delivery"]["omitted_fields"], [])
        self.assertIsNone(projected["next_offset"])
        self.assertFalse(projected["truncated"])

    def test_result_projection_never_repeats_inferred_configuration_or_discards_source(self):
        quote = {
            "fragment_ids": ["s1"],
            "text": "On population P, the reported outcome is 72%, with 8 samples.",
            "pages": [2],
            "citation_url": "scholarseed-cite:" + "a" * 32,
        }
        full = {
            "ok": True,
            "state": "ready",
            "fields": [
                {
                    "path": "card.experiments.results[0]",
                    "value": {
                        "method": "Invented configuration Z",
                        "value": "72%",
                        "conditions": "unreported treatment",
                    },
                    "evidence_ids": ["s1"],
                },
                {
                    "path": "card.experiments.results[1]",
                    "value": {"value": "99%"},
                    "evidence_ids": [],
                },
                {
                    "path": "common_fields.tldr",
                    "value": "Useful uncited summary",
                    "evidence_ids": [],
                },
            ],
            "fragments": [quote],
        }
        before = json.dumps(full)
        result = model_excerpt(full)
        self.assertNotIn("Invented configuration", json.dumps(result))
        self.assertNotIn("unreported treatment", json.dumps(result))
        self.assertNotIn("99%", json.dumps(result))
        self.assertEqual(result["fragments"], [quote])
        self.assertFalse(result["fields"][1]["source_available"])
        self.assertEqual(result["fields"][2], full["fields"][2])
        self.assertEqual(json.dumps(full), before)

    def test_evidence_blocks_preserve_all_text_ids_geometry_and_source_boundaries(self):
        def fragment(number, text, quad, **extra):
            return {
                "fragment_id": f"s{number}",
                "source_order": number,
                "kind": "sentence",
                "continuity": 0,
                "text": text,
                "pages": [{"page": 1, "quads": [quad]}],
                **extra,
            }

        first = fragment(0, "The outcome is 72%.", [0.1, 0.2, 0.4, 0.22])
        second = fragment(1, "This uses 8 samples only.", [0.405, 0.2, 0.8, 0.22])
        grouped = evidence_blocks([second, first])
        self.assertEqual(len(grouped), 1)
        self.assertEqual(grouped[0]["text"], first["text"] + "\n" + second["text"])
        self.assertEqual(grouped[0]["fragment_ids"], ["s0", "s1"])
        self.assertEqual(
            grouped[0]["pages"][0]["quads"],
            first["pages"][0]["quads"] + second["pages"][0]["quads"],
        )
        for changed in [
            dict(second, source_order=2),
            dict(second, continuity=1),
            dict(second, kind="table"),
            dict(second, kind="caption"),
            dict(second, pages=[{"page": 2, "quads": [[0.405, 0.2, 0.8, 0.22]]}]),
            dict(second, pages=[{"page": 1, "quads": [[0.405, 0.3, 0.8, 0.32]]}]),
            dict(second, pages=[{"page": 1, "quads": []}]),
        ]:
            with self.subTest(changed=changed):
                self.assertEqual(len(evidence_blocks([first, changed])), 2)

    def test_formula_evidence_preserves_members_and_fraction_geometry(self):
        def piece(number, text, quads, **extra):
            return {
                "fragment_id": f"f{number}",
                "source_order": number,
                "kind": "passage",
                "continuity": 8,
                "text": text,
                "pages": [{"page": 4, "quads": quads}],
                **extra,
            }

        first = piece(0, "Attention(Q,K,V) = softmax(", [[0.35, 0.59, 0.57, 0.61]])
        fraction = piece(1, "QKT √ dk", [[0.58, 0.58, 0.61, 0.59], [0.59, 0.60, 0.61, 0.62]])
        last = piece(2, ")V", [[0.62, 0.59, 0.64, 0.61]])
        members = [first, fraction, last]
        before = json.dumps(members)
        (block,) = evidence_blocks(members)
        self.assertEqual(block["fragment_ids"], ["f0", "f1", "f2"])
        self.assertEqual(block["sentence_ids"], [])
        self.assertEqual(block["text"], "\n".join(p["text"] for p in members))
        self.assertEqual(
            block["pages"][0]["quads"], [q for p in members for q in p["pages"][0]["quads"]]
        )
        self.assertEqual(json.dumps(members), before)
        for changed in [
            dict(fraction, source_order=3),
            {k: v for k, v in fraction.items() if k != "continuity"},
            dict(fraction, kind="table_text"),
            dict(fraction, kind="caption"),
            dict(fraction, text="x " * 20),
            dict(fraction, pages=[{"page": 5, "quads": fraction["pages"][0]["quads"]}]),
            dict(fraction, pages=[{"page": 4, "quads": []}]),
            dict(fraction, pages=[{"page": 4, "quads": [[0.58, 0.7, 0.61, 0.72]]}]),
            dict(fraction, pages=[{"page": 4, "quads": [[0.8, 0.59, 0.9, 0.61]]}]),
        ]:
            with self.subTest(changed=changed):
                self.assertEqual(len(evidence_blocks([first, changed])), 2)
        split_native = [dict(p, continuity=n) for n, p in enumerate(members)]
        (split_block,) = evidence_blocks(split_native)
        self.assertEqual(split_block["fragment_ids"], ["f0", "f1", "f2"])
        self.assertEqual(split_block["pages"], block["pages"])
        independent = [dict(first, text="x = 2"), dict(fraction, text="y = 3", continuity=9)]
        self.assertEqual(len(evidence_blocks(independent)), 2)
        self.assertEqual(
            len(evidence_blocks([independent[0], dict(independent[1], continuity=8)])), 2
        )
        prose = [dict(p, text="Ordinary text") for p in (first, fraction)]
        self.assertEqual(len(evidence_blocks(prose)), 2)
        statement = piece(
            0,
            "Where WQ ∈ R and WO ∈ R.",
            [[0.1, 0.2, 0.4, 0.22], [0.1, 0.23, 0.3, 0.25]],
            kind="sentence",
        )
        parameter = piece(1, "∈ Rd×dk, WK", [[0.41, 0.2, 0.55, 0.22]])
        (combined,) = evidence_blocks([statement, parameter])
        self.assertEqual(combined["fragment_ids"], ["f0", "f1"])
        self.assertEqual(combined["sentence_ids"], ["f0"])
        below = piece(2, "FFN(x) = xW", [[0.2, 0.3, 0.5, 0.32]])
        self.assertEqual(len(evidence_blocks([statement, parameter, below])), 2)

    def test_equation_band_keeps_sum_limits_and_rhs_together(self):
        # Distinct native paragraphs, and a lower limit that does not overlap
        # the next piece vertically. No open bracket can connect the first pair.
        layout = [
            ("L =", [[0.389, 0.583, 0.420, 0.597]]),
            ("1\nN", [[0.429, 0.574, 0.437, 0.587], [0.427, 0.592, 0.439, 0.604]]),
            ("N\n∑", [[0.451, 0.570, 0.461, 0.579], [0.444, 0.576, 0.468, 0.589]]),
            ("i=1", [[0.445, 0.601, 0.467, 0.610]]),
            ("H(y, f(x))", [[0.471, 0.583, 0.611, 0.597]]),
        ]
        pieces = [
            {
                "fragment_id": f"s{i}",
                "source_order": i,
                "kind": "passage",
                "continuity": i,
                "text": text,
                "pages": [{"page": 3, "quads": quads}],
            }
            for i, (text, quads) in enumerate(layout)
        ]
        before = json.dumps(pieces)
        (block,) = evidence_blocks(pieces)
        self.assertEqual(block["fragment_ids"], [p["fragment_id"] for p in pieces])
        self.assertEqual(block["text"], "\n".join(p["text"] for p in pieces))
        self.assertEqual(
            block["pages"][0]["quads"], [q for p in pieces for q in p["pages"][0]["quads"]]
        )
        self.assertEqual(json.dumps(pieces), before)
        for text, quad in [
            ("z = 3", [0.62, 0.583, 0.70, 0.597]),  # independent equation on same line
            ("Other results", [0.62, 0.583, 0.70, 0.597]),
            ("H(y,f(x))", [0.80, 0.583, 0.90, 0.597]),  # another column
            ("j=2", [0.445, 0.63, 0.467, 0.64]),  # unattached lower line
        ]:
            extra = dict(
                pieces[-1],
                fragment_id="other",
                source_order=5,
                continuity=6,
                text=text,
                pages=[{"page": 3, "quads": [quad]}],
            )
            with self.subTest(text=text, quad=quad):
                self.assertEqual(len(evidence_blocks([*pieces, extra])), 2)
        # A relation at the end is not enough to absorb nearby ordinary prose.
        prose = dict(pieces[1], text="ordinary explanation")
        self.assertEqual(len(evidence_blocks([pieces[0], prose])), 2)

    def test_equation_region_handles_closed_terms_fractions_and_operator_scripts(self):
        layouts = [
            [
                ("R(f) ≤ E", [0.10, 0.20, 0.25, 0.22]),
                ("P[1(f(x) > t)] + O", [0.249999, 0.20, 0.50, 0.22]),
                ("(a + b)", [0.51, 0.20, 0.60, 0.22]),
            ],
            [
                ("E(f) ≤ max", [0.10, 0.20, 0.25, 0.22]),
                ("{ a", [0.26, 0.19, 0.30, 0.21]),
                ("a − 1", [0.26, 0.22, 0.30, 0.24]),
                ("µ", [0.31, 0.20, 0.33, 0.22]),
            ],
            [
                ("R(f) = E[ max", [0.10, 0.20, 0.28, 0.22]),
                ("neighbor z′", [0.22, 0.225, 0.28, 0.235]),
                ("1(f(z) != f(z′))]", [0.29, 0.20, 0.50, 0.22]),
            ],
            [
                ("min\nf", [0.10, 0.20, 0.15, 0.23]),
                ("J(f) (cid:44) a + 1\na − 1", [0.16, 0.19, 0.33, 0.24]),
                ("L(f,h) +", [0.34, 0.20, 0.50, 0.22]),
            ],
        ]
        for layout in layouts:
            for scale, offset in [(1, 0), (0.7, 0.12)]:
                pieces = [
                    {
                        "fragment_id": str(i),
                        "source_order": i,
                        "kind": "passage",
                        "continuity": i,
                        "text": text,
                        "pages": [{"page": 2, "quads": [[x * scale + offset for x in quad]]}],
                    }
                    for i, (text, quad) in enumerate(layout)
                ]
                with self.subTest(layout=layout, scale=scale):
                    (block,) = evidence_blocks(pieces)
                    self.assertEqual(block["text"], "\n".join(p["text"] for p in pieces))
                    self.assertEqual(
                        block["pages"][0]["quads"], [p["pages"][0]["quads"][0] for p in pieces]
                    )
        # Ordinary neighboring prose, unrelated relations, missing native order,
        # page changes and tables must not be pulled into the equation region.
        first = {
            "fragment_id": "a",
            "source_order": 0,
            "kind": "passage",
            "continuity": 0,
            "text": "f(x) = 1",
            "pages": [{"page": 1, "quads": [[0.1, 0.2, 0.3, 0.22]]}],
        }
        second = {
            **first,
            "fragment_id": "b",
            "source_order": 1,
            "continuity": 1,
            "pages": [{"page": 1, "quads": [[0.31, 0.2, 0.4, 0.22]]}],
        }
        for changes in [
            {"text": "ordinary prose"},
            {"text": "g(x) = 2"},
            {"text": "+ 1", "source_order": 2},
            {"text": "+ 1", "kind": "table_text"},
            {"text": "+ 1", "pages": [{"page": 2, "quads": [[0.31, 0.2, 0.4, 0.22]]}]},
        ]:
            self.assertEqual(len(evidence_blocks([first, {**second, **changes}])), 2)

    def test_formula_parent_and_immediate_definition_share_one_source(self):
        def piece(n, text, quad, **extra):
            return {
                "fragment_id": f"f{n}",
                "source_order": n,
                "kind": "passage",
                "continuity": 7,
                "text": text,
                "pages": [{"page": 5, "quads": [quad]}],
                **extra,
            }

        parent = piece(0, "M(Q,K,V) = Concat(h1, h2)W", [0.3, 0.18, 0.67, 0.20])
        definition = piece(1, "where hi = Attention(QW", [0.36, 0.205, 0.58, 0.225])
        rest = piece(2, ", KW, VW)", [0.585, 0.205, 0.69, 0.225])
        (block,) = evidence_blocks([parent, definition, rest])
        self.assertEqual(block["fragment_ids"], ["f0", "f1", "f2"])
        self.assertEqual(
            block["pages"][0]["quads"],
            [p["pages"][0]["quads"][0] for p in (parent, definition, rest)],
        )
        for changed in [
            dict(definition, text="Another result = 2"),
            dict(definition, text="where a separate claim holds."),
            dict(definition, pages=[{"page": 5, "quads": [[0.36, 0.26, 0.58, 0.28]]}]),
            dict(definition, pages=[{"page": 5, "quads": [[0.75, 0.205, 0.9, 0.225]]}]),
            dict(definition, source_order=2),
            dict(definition, kind="caption"),
            dict(definition, pages=[{"page": 6, "quads": definition["pages"][0]["quads"]}]),
        ]:
            with self.subTest(changed=changed):
                self.assertEqual(len(evidence_blocks([parent, changed])), 2)

    def test_knowledge_question_precedes_expanded_query_without_removing_conditions(self):
        asset = self._knowledge_asset()
        asset["l1"]["card"]["problem"] = "问题是标注成本高。"
        result = project_knowledge(
            asset,
            asset["revision"],
            ["overview", "results"],
            0,
            16,
            "90% dataset result",
            question="要解决什么问题？",
        )
        self.assertEqual([item["path"] for item in result["fields"]], ["card.problem"])
        self.assertGreater(result["selection"]["excluded_fields"], 0)
        explicit = project_knowledge(
            asset,
            asset["revision"],
            ["results"],
            0,
            16,
            "nothing matches",
            ["card.experiments.results"],
        )
        self.assertEqual(explicit["fields"][0]["value"]["conditions"], "Only this dataset")

    def test_grouped_l1_receipt_retains_every_original_anchor_and_field_reference(self):
        asset = self._knowledge_asset()
        fragments = asset["source_snapshot"]["fragments"]
        fragments["1"].update(
            text="The measured outcome is 72%.",
            continuity=0,
            pages=[{"page": 1, "quads": [[0.1, 0.2, 0.4, 0.22]]}],
        )
        fragments["2"] = {
            "fragment_id": "original-2",
            "kind": "sentence",
            "continuity": 0,
            "text": "This applies only to population P with 8 samples.",
            "pages": [{"page": 1, "quads": [[0.405, 0.2, 0.9, 0.22]]}],
        }
        asset["source_mapping"]["card_mapping"]["card.experiments.results[0]"] = [1, 2]
        self.analysis.publish(asset, "saved")
        prepared = self.citations.service.literature_knowledge(
            "session",
            "snapshot",
            LiteratureKnowledge(ref_id="literature:paper", fields=["card.experiments.results"]),
            "turn",
        )
        full = self.citations.service.commit_read("session", "snapshot", prepared)
        projected = model_excerpt(full)
        self.assertEqual(len(projected["fragments"]), 1)
        quote = projected["fragments"][0]
        self.assertEqual(quote["fragment_ids"], ["original-1", "original-2"])
        self.assertEqual(projected["fields"][0]["evidence_ids"], quote["fragment_ids"])
        receipt = self.citations.store.get(
            "session", "snapshot", quote["citation_url"].split(":", 1)[1]
        )
        self.assertEqual(receipt["quote"], fragments["1"]["text"] + "\n" + fragments["2"]["text"])
        self.assertEqual(
            receipt["pages"][0]["quads"],
            fragments["1"]["pages"][0]["quads"] + fragments["2"]["pages"][0]["quads"],
        )
        self.assertEqual(self.page_indexes.reads, [])

    def test_knowledge_mapped_evidence_does_not_add_distant_query_hits(self):
        asset = self._knowledge_asset()
        asset["source_snapshot"]["fragments"]["2"] = {
            "fragment_id": "distant",
            "text": "Original unrelated ablation evidence.",
            "kind": "sentence",
            "pages": [{"page": 8, "quads": []}],
        }
        result = project_knowledge(
            asset, asset["revision"], ["overview"], 0, 16, "Original ablation"
        )
        self.assertEqual([item["fragment_id"] for item in result["evidence"]], ["original-1"])

    def test_model_excerpt_leaves_unavailable_assets_and_errors_unchanged(self):
        for result in (
            {"ok": False, "error": "source_changed"},
            {"ok": True, "state": "missing", "fallback": "literature/read"},
        ):
            self.assertIs(model_excerpt(result), result)

    def test_request_schemas_are_page_based_and_exclude_scope_inputs(self) -> None:
        listed = LiteratureList.model_validate({"limit": 8})
        self.assertEqual(
            listed.model_dump(), {"offset": 0, "limit": 8, "query": "", "view": "catalog"}
        )
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
            (LiteratureList, {"query": "x" * 513}),
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
                "knowledge",
                "authorize",
                ANNOTATIONS_OPERATION,
                "result",
                "review",
                "acquire",
                "import",
                "receipt",
                "confirm-search-start",
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

    def test_candidates_read_only_metadata_and_include_checkpoint_l1(self) -> None:
        asset = self._knowledge_asset()
        attachment = self.repository.primary_attachment("paper")
        self.analysis.save_l1("paper", attachment.revision, attachment.id, asset, "saved")
        self.repository.save(
            replace(
                self.repository.get("paper"),
                abstract="Real abstract",
                doi="10.1/example",
                arxiv="2401.00001",
            ),
            project_id="project",
        )
        with (
            patch.object(self.evidence._pdf, "describe", side_effect=AssertionError("PDF read")),
            patch.object(self.analysis, "reading_l1", side_effect=AssertionError("full L1 read")),
        ):
            result = self.citations.service.literature_list(
                "session", "snapshot", LiteratureList(view="candidates")
            )
        self.assertEqual(result["scope"], "project_literature")
        self.assertEqual(len(result["sources"]), 1)
        paper = result["sources"][0]
        self.assertEqual(paper["knowledge_state"], "ready")
        self.assertEqual(paper["abstract"], "Real abstract")
        self.assertEqual(paper["doi"], "10.1/example")
        self.assertEqual(paper["library_refs"], ["literature:paper"])
        self.assertIsNone(paper["citation_count"])
        self.assertNotIn("source_snapshot", paper)
        self.assertNotIn("paperhub_id", paper)

    def test_candidates_recover_local_abstract_without_paperhub_or_generation(self):
        with pdf_fixture.open() as pdf:
            page = pdf.new_page(width=600, height=800)
            for y, text in (
                (70, "Project Paper"),
                (100, "Abstract"),
                (130, "We evaluate learning with fewer labels."),
                (150, "The results depend on the evaluation protocol."),
                (180, "1. Introduction"),
                (210, "Body must stay private."),
            ):
                page.insert_text((72, y), text)
            payload = pdf.tobytes()
        self._stage("paper", "with-abstract.pdf", payload)
        original = self.repository.get("paper")
        assert original is not None
        with patch.object(self.analysis, "reading_l1", side_effect=AssertionError("L1 read")):
            result = self.evidence.catalog("project", 0, 20, view="candidates")
        paper = result["sources"][0]
        self.assertEqual(
            paper["abstract"],
            "We evaluate learning with fewer labels. "
            "The results depend on the evaluation protocol.",
        )
        self.assertEqual(paper["paper_id"], "literature:paper")
        self.assertNotIn("paperhub_id", paper)
        self.assertNotIn("Body must stay private", json.dumps(paper))
        attachment = self.repository.primary_attachment("paper")
        assert attachment is not None
        self.assertEqual(paper["abstract_provenance"]["attachment_id"], attachment.id)
        self.assertEqual(paper["abstract_provenance"]["pages"], [1])
        self.assertEqual(self.repository.get("paper"), original)

    def test_candidate_missing_or_unbounded_abstract_is_not_invented(self):
        result = self.evidence.catalog("project", 0, 20, view="candidates")
        self.assertEqual(result["sources"][0]["abstract"], "")
        with patch(
            "service.literature.service.abstracts.pdf_document_text",
            return_value=("Abstract\nUnfinished abstract",),
        ):
            result = self.evidence.catalog("project", 0, 20, view="candidates")
        self.assertEqual(result["sources"][0]["abstract"], "")
        self.assertNotIn("abstract_provenance", result["sources"][0])

    def test_missing_abstract_exports_labelled_bounded_source_preview(self):
        original = self.repository.get("paper")
        with patch(
            "service.literature.service.previews.pdf_document_text",
            return_value=("Original body " * 1000,),
        ):
            paper = self.evidence.catalog("project", 0, 20, view="candidates")["sources"][0]
        self.assertEqual(paper["abstract"], "")
        preview = paper["selection_evidence"]
        self.assertEqual(preview["kind"], "local_pdf_excerpt")
        self.assertFalse(preview["is_abstract"])
        self.assertEqual(len(preview["text"]), 6000)
        self.assertTrue(preview["spans"][0]["truncated"])
        self.assertEqual(self.repository.get("paper"), original)

    def test_local_abstract_requires_revision_and_complete_bounded_section(self):
        attachment = self.repository.primary_attachment("paper")
        assert attachment is not None
        payload, _, _ = self.evidence._pdf.read_attachment("paper", attachment.id)
        with self.assertRaisesRegex(ValueError, "revision_mismatch"):
            local_abstract(payload, "changed", attachment.id)
        with (
            patch(
                "service.literature.service.abstracts.pdf_document_info",
                return_value=SimpleNamespace(page_count=12),
            ),
            patch(
                "service.literature.service.abstracts.pdf_document_text",
                return_value=("Abstract\nFirst part", "Second part.\n1 Introduction\nBody"),
            ) as text,
        ):
            abstract, provenance = local_abstract(payload, attachment.revision, attachment.id)
        self.assertEqual(abstract, "First part Second part.")
        self.assertEqual(provenance["pages"], [1, 2])
        self.assertEqual(text.call_args.kwargs["page_numbers"], (1, 2))
        for page in (
            "Abstracting a method\nBody\n1 Introduction",
            "Abstract\nCut…\n1 Introduction",
            "Abstract\nOne\nAbstract\nTwo\n1 Introduction",
        ):
            with patch(
                "service.literature.service.abstracts.pdf_document_text", return_value=(page,)
            ):
                self.assertEqual(
                    local_abstract(payload, attachment.revision, attachment.id), ("", {})
                )

    def test_candidates_preserve_metadata_and_refuse_changed_pdf(self):
        original = self.repository.get("paper")
        assert original is not None
        self.repository.save(replace(original, abstract="Existing abstract"), project_id="project")
        with patch.object(
            self.evidence._pdf, "read_attachment", side_effect=AssertionError("PDF read")
        ):
            self.assertEqual(
                self.evidence.catalog("project", 0, 20, view="candidates")["sources"][0][
                    "abstract"
                ],
                "Existing abstract",
            )
        self.repository.save(original, project_id="project")
        with patch.object(
            self.evidence._pdf,
            "read_attachment",
            return_value=(b"changed", PDF_MEDIA_TYPE, "sha256:other"),
        ):
            self.assertEqual(
                self.evidence.catalog("project", 0, 20, view="candidates")["sources"][0][
                    "abstract"
                ],
                "",
            )

    def test_candidate_export_is_scoped_frozen_and_uses_all_pages(self) -> None:
        for index in range(3):
            self.repository.save(
                LiteratureItem(id=f"candidate-{index}", title=f"Candidate {index}"),
                project_id="project",
            )
        with patch("service.literature.service.candidates.CATALOGUE_PAGE", 2):
            result = prepare_candidates(
                self.evidence, "project", self.root, "survey", "run"
            ).publish()
        path = self.root / result["library_candidates"]["path"]
        original = path.read_bytes()
        bundle = json.loads(original)
        self.assertEqual(len(bundle["sources"]), 4)
        self.assertNotIn("literature:foreign", str(bundle))
        self.assertIsNone(bundle["next_offset"])
        self.repository.save(LiteratureItem(id="later", title="Later"), project_id="project")
        self.assertEqual(
            prepare_candidates(self.evidence, "project", self.root, "survey", "run").publish(),
            result,
        )
        self.assertEqual(path.read_bytes(), original)
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            prepare_candidates(self.evidence, "other", self.root, "survey", "run")
        empty = prepare_candidates(self.evidence, None, self.root, "empty", "run").publish()
        self.assertEqual(empty["library_candidates"]["count"], 0)

    def test_candidate_export_refuses_linked_destination(self) -> None:
        target = self.root / "outside.json"
        target.write_text("{}")
        folder = self.root / "linked" / "02_retrieval"
        folder.mkdir(parents=True)
        (folder / "library_candidates.json").symlink_to(target)
        with self.assertRaises((ValueError, OSError)):
            prepare_candidates(self.evidence, "project", self.root, "linked", "run")
        self.assertEqual(target.read_text(), "{}")

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
        self.assertEqual(missing["knowledge_state"], "unavailable")

    def test_catalog_filters_within_scope_and_returns_saved_l1_state(self) -> None:
        self.analysis.publish(self._knowledge_asset(), "saved")
        request = LiteratureList(query="Project Paper")
        with patch.object(
            self.evidence._pdf, "read_attachment", wraps=self.evidence._pdf.read_attachment
        ) as read:
            result = self.citations.service.literature_list("session", "snapshot", request)
        self.assertEqual(read.call_count, 1)
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["sources"][0]["knowledge_state"], "ready")
        self.assertEqual(self.page_indexes.reads, [])
        self.assertEqual(
            self.citations.service.literature_list(
                "session", "snapshot", LiteratureList(query="Foreign")
            )["sources"],
            [],
        )

    def test_global_catalog_exposes_l1_and_missing_fallback_without_extracting(self) -> None:
        self.citations.snapshot = replace(self.citations.snapshot, project_id=None)
        self.citations.service._project = lambda _session: None
        self.analysis.publish(self._knowledge_asset(), "saved")
        result = self.citations.service.literature_list("session", "snapshot", LiteratureList())
        states = {item["ref_id"]: item["knowledge_state"] for item in result["sources"]}
        self.assertEqual(states, {"literature:paper": "ready", "literature:foreign": "missing"})
        self.assertEqual(self.page_indexes.reads, [])

    def test_catalog_reuses_knowledge_compatibility_and_checks_actual_pdf_revision(self) -> None:
        asset = self._knowledge_asset()
        asset["metadata"]["schema_version"] = "unsupported"
        self.analysis.publish(asset, "saved")
        self.assertEqual(
            self.evidence.catalog("project", 0, 20)["sources"][0]["knowledge_state"], "incompatible"
        )
        asset["metadata"]["schema_version"] = "l1-reading/v2"
        self.analysis.publish(asset, "saved")
        # A changed file must not be advertised as ready using the stale attachment row.
        Path(self.paper_attachment["path"]).write_bytes(self._pdf("Changed"))
        self.assertEqual(
            self.evidence.catalog("project", 0, 20)["sources"][0]["knowledge_state"], "missing"
        )

    def test_catalog_resolves_arxiv_identifier_without_web_search(self) -> None:
        self.repository.save(
            LiteratureItem(id="identified", title="Identified", arxiv="2001.07685"),
            project_id="project",
        )
        result = self.evidence.catalog("project", 0, 20, "2001.07685")
        self.assertEqual([item["ref_id"] for item in result["sources"]], ["literature:identified"])

    def _knowledge_asset(self):
        document = self.evidence.document("project", "paper")
        return {
            "literature_id": "paper",
            "revision": document.revision.removeprefix("sha256:"),
            "modules": {"summary": {}},
            "metadata": {"schema_version": "l1-reading/v2"},
            "l1": {
                "paper_type": "method",
                "common_fields": {
                    "tldr": "Uncited summary",
                    "claims": [{"claim": "Supported result", "type": "empirical"}],
                },
                "card": {
                    "idea": "Idea",
                    "experiments": {
                        "results": [{"value": "90%", "conditions": "Only this dataset"}]
                    },
                },
            },
            "source_mapping": {
                "card_mapping": {
                    "card.idea": [1],
                    "common_fields.claims[0].claim": [1],
                    "card.experiments.results[0]": [1],
                }
            },
            "source_snapshot": {
                "source_revision": document.revision,
                "fragments": {
                    "1": {
                        "fragment_id": "original-1",
                        "text": "Original evidence.",
                        "kind": "sentence",
                        "pages": [{"page": 1, "quads": []}],
                    }
                },
                "images": {},
            },
        }

    def test_page_read_completes_only_saved_same_revision_native_table(self):
        asset = self._knowledge_asset()
        table = {
            "fragment_id": "table_native",
            "text": "Table 2.\nModel | labels | score\nA | 1% | 85.8",
            "kind": "table_text",
            "pages": [{"page": 1, "quads": [[0.1, 0.1, 0.9, 0.9]]}],
        }
        asset["source_snapshot"]["fragments"]["2"] = table
        self.analysis.publish(asset, "saved")
        caption = PdfFragment("caption", "Table 2. Results", (CitationPage(1, ()),))
        self.page_indexes.pages = Mock(return_value=(PdfPageContent(1, (caption,)),))
        result = self.evidence.read_pages("project", "paper", 1, 1)
        self.assertEqual(
            [f.fragment_id for f in result.pages[0].fragments], ["caption", "table_native"]
        )
        self.assertIn("labels", result.pages[0].fragments[-1].text)
        self.page_indexes.pages = Mock(return_value=result.pages)
        self.assertEqual(
            len(self.evidence.read_pages("project", "paper", 1, 1).pages[0].fragments), 2
        )
        self.page_indexes.pages = Mock(return_value=(PdfPageContent(1, (caption,)),))
        asset["source_snapshot"]["source_revision"] = "another-version"
        self.analysis.publish(asset, "stale")
        self.assertEqual(
            len(self.evidence.read_pages("project", "paper", 1, 1).pages[0].fragments), 1
        )

    def test_saved_knowledge_preserves_uncited_summary_deduplicates_and_never_reads_pdf_pages(self):
        asset = self._knowledge_asset()
        self.analysis.publish(asset, "saved")
        request = LiteratureKnowledge(ref_id="literature:paper", sections=["overview", "results"])
        prepared = self.citations.service.literature_knowledge(
            "session", "snapshot", request, "turn"
        )
        self.assertEqual(self.page_indexes.reads, [])
        self.assertEqual(len(prepared["pending_receipts"]), 1)
        fields = {item["path"]: item for item in prepared["fields"]}
        self.assertEqual(fields["common_fields.tldr"]["evidence_ids"], [])
        self.assertEqual(
            fields["card.experiments.results[0]"]["value"]["conditions"], "Only this dataset"
        )
        self.assertEqual(fields["common_fields.claims[0]"]["evidence_ids"], ["original-1"])
        result = self.citations.service.commit_read("session", "snapshot", prepared)
        notice = model_excerpt(result)["notice"]
        self.assertIn("Citation links may use [1](citation_url)", notice)
        self.assertIn("copying the full returned citation_url exactly", notice)
        self.assertIn("rather than displaying bare addresses", notice)
        self.assertIn("In reader-facing answers and reports", notice)
        self.assertIn("Do not expose internal source identifiers", notice)
        self.assertIn(
            "unless the user explicitly requests raw addresses or debugging information", notice
        )
        fragment = result["fragments"][0]
        receipt = self.citations.store.get(
            "session", "snapshot", fragment["citation_url"].split(":", 1)[1]
        )
        self.assertEqual(receipt["quote"], "Original evidence.")
        self.assertEqual(receipt["attachment_id"], self.paper_attachment["id"])
        self.assertEqual(receipt["source_turn_id"], "turn")

    def test_conversation_reuses_extraction_checkpoint_before_body_is_organized(self):
        asset = self._knowledge_asset()
        self.analysis.save_l1(
            "paper", asset["revision"], self.paper_attachment["id"], asset, "saved"
        )
        self.assertIsNone(self.analysis.summary("paper", asset["revision"]))
        self.assertEqual(
            self.evidence.catalog("project", 0, 20)["sources"][0]["knowledge_state"], "ready"
        )
        prepared = self.citations.service.literature_knowledge(
            "session", "snapshot", LiteratureKnowledge(ref_id="literature:paper"), "turn"
        )
        result = self.citations.service.commit_read("session", "snapshot", prepared)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["fragments"][0]["text"], "Original evidence.")
        self.assertEqual(self.page_indexes.reads, [])
        self.assertIsNone(self.analysis.summary("paper", asset["revision"]))
        self.assertEqual(
            self.analysis.reading_l1("paper", asset["revision"], self.paper_attachment["id"]), asset
        )

    def test_original_pdf_fallback_survives_saved_asset_without_snapshot_fragments(self):
        asset = self._knowledge_asset()
        asset["source_snapshot"].pop("fragments")
        self.analysis.publish(asset, "saved")
        result = self.citations.service.literature_read(
            "session",
            "snapshot",
            LiteratureRead(ref_id="literature:paper", start_page=1, end_page=1),
        )
        result = self.citations.service.commit_literature_read("session", "snapshot", result)
        self.assertEqual(len(result["pages"]), 1)
        self.assertIn("Project", result["pages"][0]["text"])
        self.assertEqual(self.page_indexes.reads, [(1, 1)])

    def test_knowledge_missing_stale_and_incompatible_do_not_extract(self):
        request = LiteratureKnowledge(ref_id="literature:paper")
        result = self.citations.service.literature_knowledge("session", "snapshot", request)
        self.assertEqual(result["state"], "missing")
        asset = self._knowledge_asset()
        asset["source_snapshot"]["source_revision"] = "different"
        self.analysis.publish(asset, "saved")
        self.assertEqual(
            self.citations.service.literature_knowledge("session", "snapshot", request)["state"],
            "stale",
        )
        asset.pop("l1")
        self.analysis.publish(asset, "saved")
        self.assertEqual(
            self.citations.service.literature_knowledge("session", "snapshot", request)["state"],
            "incompatible",
        )
        self.assertEqual(self.page_indexes.reads, [])

    def test_knowledge_attachment_and_project_scope_are_not_bypassed(self):
        for request in (
            LiteratureKnowledge(ref_id="literature:foreign"),
            LiteratureKnowledge(ref_id="literature:paper", attachment_id="not-authorized"),
        ):
            with self.assertRaises(ValueError):
                self.citations.service.literature_knowledge("session", "snapshot", request)

    def test_knowledge_core_results_precede_long_auxiliary_lists(self):
        asset = self._knowledge_asset()
        asset["l1"]["card"]["experiments"]["baselines"] = [f"baseline-{i}" for i in range(40)]
        result = project_knowledge(asset, asset["revision"], ["overview", "results"], 0, 16)
        self.assertIn("card.experiments.results[0]", [item["path"] for item in result["fields"]])
        self.assertFalse(result["truncated"])
        asset["source_mapping"]["card_mapping"] = None
        asset["source_snapshot"]["fragments"] = None
        asset["metadata"]["coverage"] = None
        result = project_knowledge(asset, asset["revision"], ["overview"], 0, 16)
        self.assertEqual(result["state"], "ready")
        self.assertTrue(result["fields"])
        self.assertEqual(result["evidence"], [])

    def test_knowledge_paginates_whole_items_and_marks_oversized_fields(self):
        asset = self._knowledge_asset()
        revision = asset["revision"]
        first = project_knowledge(asset, revision, ["overview", "results"], 0, 1)
        self.assertEqual(len(first["fields"]), 1)
        self.assertEqual(first["next_offset"], 1)
        self.assertTrue(first["truncated"])
        asset["l1"]["common_fields"]["tldr"] = "x" * KNOWLEDGE_MAX_BYTES
        oversized = project_knowledge(asset, revision, ["overview"], 0, 16)
        self.assertIn("common_fields.tldr", oversized["oversized_fields"])
        self.assertTrue(oversized["fields"])

    def test_knowledge_query_searches_saved_snapshot_without_pdf_parse(self):
        asset = self._knowledge_asset()
        asset["source_snapshot"]["fragments"]["2"] = {
            "fragment_id": "original-2",
            "text": "Teacher weights update after each training step.",
            "pages": [{"page": 2, "quads": []}],
            "kind": "sentence",
        }
        self.analysis.publish(asset, "saved")
        prepared = self.citations.service.literature_knowledge(
            "session",
            "snapshot",
            LiteratureKnowledge(ref_id="literature:paper", query="teacher weights"),
            "turn",
        )
        self.assertEqual(self.page_indexes.reads, [])
        self.assertIn("original-2", prepared["context_evidence_ids"])
        self.assertEqual(prepared["selection"]["matched_fields"], 0)
        self.assertTrue(prepared["fields"])
        result = self.citations.service.commit_read("session", "snapshot", prepared)
        hit = next(
            fragment for fragment in result["fragments"] if "original-2" in fragment["fragment_ids"]
        )
        self.assertEqual(hit["pages"], [2])
        self.assertIn("Teacher weights", hit["text"])
        self.assertTrue(hit["citation_url"].startswith("scholarseed-cite:"))

    def test_knowledge_preserves_indexed_formula_evidence_and_conditions(self):
        asset = self._knowledge_asset()
        asset["l1"]["card"]["method"] = {"key_formulas": ["first formula", "second formula"]}
        asset["source_snapshot"]["fragments"]["2"] = {
            "fragment_id": "original-2",
            "text": "Second formula under assumption B.",
            "pages": [{"page": 1, "quads": []}],
        }
        asset["source_mapping"]["card_mapping"].update(
            {
                "card.method.key_formulas": [1, 2],
                "card.method.key_formulas[0]": [1],
                "card.method.key_formulas[1]": [2],
            }
        )
        result = project_knowledge(asset, asset["revision"], ["method", "results"], 0, 16)
        fields = {field["path"]: field for field in result["fields"]}
        self.assertEqual(fields["card.method.key_formulas[0]"]["evidence_ids"], ["original-1"])
        self.assertEqual(fields["card.method.key_formulas[1]"]["evidence_ids"], ["original-2"])
        self.assertEqual(
            fields["card.experiments.results[0]"]["value"]["conditions"], "Only this dataset"
        )

    def test_knowledge_query_does_not_fill_unmatched_fields_and_keeps_explicit_requests(self):
        asset = self._knowledge_asset()
        asset["l1"]["common_fields"]["limitations"] = ["Only when condition B holds"]
        result = project_knowledge(
            asset, asset["revision"], ["overview", "limitations"], 0, 16, "condition"
        )
        self.assertEqual(result["fields"][0]["path"], "common_fields.limitations")
        self.assertEqual(
            [field["path"] for field in result["fields"]], ["common_fields.limitations"]
        )
        self.assertIsNone(result["next_offset"])
        self.assertEqual(result["selection"]["matched_fields"], 1)
        self.analysis.publish(asset, "saved")
        filtered = self.citations.service.literature_knowledge(
            "session",
            "snapshot",
            LiteratureKnowledge(ref_id="literature:paper", fields=["common_fields.limitations"]),
            "turn",
        )
        self.assertEqual(
            [field["path"] for field in filtered["fields"]], ["common_fields.limitations"]
        )

    def test_knowledge_context_stays_on_same_page_and_does_not_become_mapped_support(self):
        asset = self._knowledge_asset()
        for number, page in [(2, 1), (3, 2)]:
            asset["source_snapshot"]["fragments"][str(number)] = {
                "fragment_id": f"original-{number}",
                "text": f"Context {number}.",
                "pages": [{"page": page, "quads": []}],
            }
        result = project_knowledge(asset, asset["revision"], ["overview"], 0, 16)
        idea = next(field for field in result["fields"] if field["path"] == "card.idea")
        self.assertEqual(idea["evidence_ids"], ["original-1"])
        self.assertEqual(result["context_evidence_ids"], ["original-2"])
        self.assertNotIn("original-3", [entry["fragment_id"] for entry in result["evidence"]])

    def test_knowledge_query_rejects_paths_and_unbounded_inputs(self):
        for values in ({"fields": ["../../secret"]}, {"fields": ["card.*"]}, {"query": "x" * 513}):
            with self.subTest(values=values), self.assertRaises(ValidationError):
                LiteratureKnowledge(ref_id="literature:paper", **values)

    def test_knowledge_context_budget_preserves_primary_evidence_and_public_response(self):
        asset = self._knowledge_asset()
        self.repository.save(LiteratureItem(id="paper", title="长标题" * 100), project_id="project")
        for number in range(2, 18):
            asset["source_snapshot"]["fragments"][str(number)] = {
                "fragment_id": f"original-{number}",
                "text": "原文上下文" * 500,
                "pages": [{"page": 1, "quads": []}],
            }
        self.analysis.publish(asset, "saved")
        prepared = self.citations.service.literature_knowledge(
            "session",
            "snapshot",
            LiteratureKnowledge(ref_id="literature:paper", query="原文"),
            "turn",
        )
        self.assertTrue(prepared["context_truncated"])
        result = self.citations.service.commit_read("session", "snapshot", prepared)
        self.assertIn(
            "original-1",
            [identity for fragment in result["fragments"] for identity in fragment["fragment_ids"]],
        )
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), KNOWLEDGE_MAX_BYTES)
        self.assertEqual(self.page_indexes.reads, [])

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
            page = read.json()["pages"][0]
            self.assertNotIn("text", page)
            self.assertNotIn("sentence_ids", page["fragments"][0])
            self.assertTrue(page["fragments"][0]["citation_url"].startswith("scholarseed-cite:"))
            knowledge = client.post(
                LITERATURE_ROUTE_PREFIX + "knowledge",
                json={"ref_id": "literature:paper"},
                headers=headers,
            )
            self.assertEqual(knowledge.status_code, 200, knowledge.text)
            self.assertEqual(knowledge.json()["state"], "missing")
            annotations = client.post(
                LITERATURE_ROUTE_PREFIX + ANNOTATIONS_OPERATION,
                json={"ref_id": "literature:paper"},
                headers=headers,
            )
            self.assertEqual(annotations.status_code, 200, annotations.text)
            self.assertEqual(annotations.json()["authority"], "user_feedback")
        self.assertEqual(live.publish.await_count, 4)

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

            async def request_product_input(
                question, *, turn_id, activity=None, automatic_decision=None
            ):
                self.assertIsNone(automatic_decision)
                self.assertTrue(question["requires_user_confirmation"])
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
                decision["decision_source"] = "user_explicit"
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
                        (LITERATURE_ROUTE_PREFIX + "knowledge", {"ref_id": "literature:paper"}),
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
                self.assertEqual(authorizer.require.call_count, 9)
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

        async def request_product_input(
            question, *, turn_id, activity=None, automatic_decision=None
        ):
            self.assertIsNone(automatic_decision)
            self.assertTrue(question["requires_user_confirmation"])
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
            decision["decision_source"] = "user_explicit"
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
