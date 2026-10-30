"""Contract tests for real Content/Literature -> Assistant context adapters."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.context import AssistantService
from service.chat.active import RUNTIME_ID
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.content.persistence.catalog import ContentCatalog
from service.content.service.context import ContentContextProvider
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.schema import FulltextStatus, LiteratureItem, LiteratureView
from service.literature.service.context import LiteratureContextProvider
from service.platform.activity import Activities
from service.platform.context import (
    AssistantContextBudget,
    AssistantContextFailureKind,
    AssistantContextResolveRequest,
    AssistantTurnFinalization,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
    SelectionAnchor,
)
from service.workbench.domain.selection import SelectionEvidenceError, SelectionEvidenceReference
from service.workbench.service import doc as doc_selection
from service.workbench.service import docx as docx_selection
from service.workbench.service.context import SelectionContextProvider

SESSION_ID = "context-provider-session"
SELECTION_HASH_PREFIX = "sha256:"
FIXTURES = Path(__file__).parent / "fixtures"


def _selection_hash(text: str) -> str:
    return f"{SELECTION_HASH_PREFIX}{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


def _utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


class SelectionContextProviderContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="content-context-")
        root = Path(self.temporary.name)
        project_root = root / "project"
        project_root.mkdir()
        catalog = ContentCatalog(root / "content.sqlite3")
        registry = ProjectRegistry(str(project_root), catalog)
        project = registry.seed_workspace()
        if project is None:
            raise AssertionError("test project was not registered")
        self.project = project
        self.content = ContentService(registry, catalog, activities=Activities())
        self.provider = ContentContextProvider(self.content)
        self.selection_provider = SelectionContextProvider(self.content)
        self.literature_provider = LiteratureContextProvider(self.content)
        session_catalog = SessionCatalogStore(root / "sessions.sqlite3")
        session_catalog.register(
            SESSION_ID,
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-context-provider",
            vendor_session_id=None,
            runtime_workdir=str(project_root),
            project_path=str(project_root),
            output_root=str(project_root / "output"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=SESSION_ID,
            created_at=1.0,
        )
        self.assistant = AssistantService(
            AssistantStore(session_catalog.database),
            project_for_session=lambda _session_id: project.id,
            providers={
                ContextRefKind.FILE: self.provider,
                ContextRefKind.DIR: self.provider,
                ContextRefKind.LITERATURE: self.literature_provider,
                ContextRefKind.SELECTION: self.selection_provider,
            },
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def ref(kind: ContextRefKind, source_id: str, revision: str | None = None) -> ContextRef:
        return ContextRef(
            ref_id=f"ref-{kind.value}",
            kind=kind,
            source_id=source_id,
            label=Path(source_id).name,
            source_revision=revision,
        )

    def selection_ref(
        self,
        source_id: str,
        locator: dict[str, object],
        selected: str,
        *,
        preview: str = "forged preview must not be used",
        revision: str | None = None,
    ) -> ContextRef:
        return ContextRef(
            ref_id=f"selection-{Path(source_id).suffix}",
            selection_source_label=f"原始标题 {Path(source_id).name} · 划词",
            kind=ContextRefKind.SELECTION,
            source_id=source_id,
            label=Path(source_id).name,
            source_revision=revision or self.content.snapshot(self.project.id, source_id).revision,
            anchor=SelectionAnchor(
                selected_text_hash=_selection_hash(selected),
                preview_text=preview,
                snapshot_text=selected,
                locator=locator,
            ),
        )

    def resolve_selection(
        self,
        source_id: str,
        locator: dict[str, object],
        selected: str,
        **kwargs: object,
    ):
        ref = self.selection_ref(source_id, locator, selected, **kwargs)
        result = self.selection_provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=ref,
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
        )
        for item in result.items:
            self.assertEqual(item.selection_source_label, ref.selection_source_label)
            self.assertEqual(item.label, ref.label)
        return result

    def test_selection_base_title_preserves_empty_and_absent_values(self) -> None:
        self.content.write_text(self.project.id, "source.md", "chosen")
        ref = self.selection_ref(
            "source.md",
            {"kind": "markdown", "start": 0, "end": 6, "source_map_version": "v1"},
            "chosen",
        )
        for title in (None, "", " 标题 · 划词 "):
            request = AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=replace(ref, selection_source_label=title),
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
            result = self.selection_provider.resolve(request)
            self.assertEqual(result.state, ContextResolutionState.READY)
            self.assertEqual(result.items[0].selection_source_label, title)
            self.assertEqual(result.items[0].text, "chosen")
            self.assertEqual(result.items[0].label, ref.label)

    def test_doc_and_docx_use_independent_evidence_processors(self) -> None:
        self.assertEqual((doc_selection.FORMAT, doc_selection.SUFFIX), ("doc", ".doc"))
        self.assertEqual((docx_selection.FORMAT, docx_selection.SUFFIX), ("docx", ".docx"))
        self.assertIsNot(doc_selection.resolve_selection, docx_selection.resolve_selection)

    def test_pdf_action_resolves_declared_historical_revision_before_current_bytes(self) -> None:
        original_text = "Original PDF selection"
        original = pdf_fixture.open()
        page = original.new_page(width=500, height=400)
        page.insert_text((40, 120), original_text, fontsize=12)
        original_payload = original.tobytes()
        original.close()
        current = pdf_fixture.open()
        page = current.new_page(width=500, height=400)
        page.insert_text((40, 120), "Changed PDF selection", fontsize=12)
        current_payload = current.tobytes()
        current.close()
        self.content.create_bytes(self.project.id, "", "paper.pdf", current_payload)
        revision = "sha256:" + hashlib.sha256(original_payload).hexdigest()
        provider = SelectionContextProvider(
            self.content,
            revision_reader=lambda project_id, source_id, source_revision: (
                original_payload
                if (project_id, source_id, source_revision)
                == (self.project.id, "paper.pdf", revision)
                else None
            ),
        )
        reference = SelectionEvidenceReference(
            self.project.id,
            "paper.pdf",
            revision,
            "pdf",
            _selection_hash(original_text),
            {"kind": "pdf", "page": 1, "quads": [[0.05, 0.20, 0.95, 0.36]]},
        )

        evidence = provider.resolve_action(reference)

        self.assertEqual(evidence.selected_text, original_text)
        self.assertEqual(evidence.evidence_revision, revision)

    def test_text_and_markdown_snapshots_ignore_display_preview(self) -> None:
        text = "alpha\nβ😀gamma\nomega"
        self.content.write_text(self.project.id, "sample.py", text)
        text_item = self.resolve_selection(
            "sample.py",
            {
                "kind": "text",
                "start_line": 1,
                "start_column": 0,
                "end_line": 1,
                "end_column": 3,
            },
            "β😀",
        )

        markdown = "# title\nlead 😀selected tail"
        selected = "😀selected"
        self.content.write_text(self.project.id, "sample.md", markdown)
        start = _utf16_length(markdown[: markdown.index(selected)])
        markdown_item = self.resolve_selection(
            "sample.md",
            {
                "kind": "markdown",
                "start": start,
                "end": start + _utf16_length(selected),
                "source_map_version": "md-source-v1",
            },
            selected,
        )

        self.assertEqual(text_item.state, ContextResolutionState.READY)
        self.assertEqual(text_item.items[0].text, "β😀")
        self.assertEqual(markdown_item.state, ContextResolutionState.READY)
        self.assertEqual(markdown_item.items[0].text, selected)
        self.assertNotIn("forged preview", markdown_item.items[0].text)

        direct = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id="sample.md",
                source_revision=self.content.snapshot(self.project.id, "sample.md").revision,
                locator_kind="markdown",
                selected_text_hash=_selection_hash(selected),
                locator={
                    "kind": "markdown",
                    "start": start,
                    "end": start + _utf16_length(selected),
                    "source_map_version": "md-source-v1",
                },
            )
        )
        self.assertEqual(direct.selected_text, selected)
        self.assertEqual(direct.context_text, markdown)

    def test_markdown_selection_can_join_verified_source_segments(self) -> None:
        markdown = "**first second** and `run()`"
        selected = "**second**"
        self.content.write_text(self.project.id, "segments.md", markdown)
        segments = [
            {"start": 0, "end": 2},
            {"start": 8, "end": 14},
            {"start": 14, "end": 16},
        ]

        item = self.resolve_selection(
            "segments.md",
            {
                "kind": "markdown",
                "start": 0,
                "end": 16,
                "segments": segments,
                "source_map_version": "milkdown-source-map-v3",
            },
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_markdown_snapshot_does_not_validate_source_segments(self) -> None:
        markdown = "**first second**"
        self.content.write_text(self.project.id, "invalid-segments.md", markdown)
        locator = {
            "kind": "markdown",
            "start": 0,
            "end": 16,
            "segments": [{"start": 8, "end": 14}, {"start": 0, "end": 2}],
            "source_map_version": "milkdown-source-map-v3",
        }

        item = self.resolve_selection("invalid-segments.md", locator, "second**")

        self.assertEqual(item.state, ContextResolutionState.READY)

    def test_pdf_selection_resolves_normalized_page_quads(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "alpha chosen omega")
        selected = "hose"
        rect = page.search_for(selected)[0]
        width, height = page.rect.width, page.rect.height
        locator = {
            "kind": "pdf",
            "page": 1,
            "quads": [[rect.x0 / width, rect.y0 / height, rect.x1 / width, rect.y1 / height]],
        }
        (Path(self.project.root) / "sample.pdf").write_bytes(document.tobytes())
        document.close()

        item = self.resolve_selection("sample.pdf", locator, selected)

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_all_selection_snapshots_resolve_without_reading_or_revalidating_source(self) -> None:
        class UnreadableContent:
            def read_bytes(self, project_id: str, source_id: str):
                raise AssertionError(f"content read attempted: {project_id}/{source_id}")

        snapshot = "As scientific literature grows rapidly"
        ref = ContextRef(
            ref_id="pdf-snapshot",
            kind=ContextRefKind.SELECTION,
            source_id="changed.pdf",
            label="changed.pdf · 划词",
            source_revision="sha256:" + "0" * 64,
            anchor=SelectionAnchor(
                locator={"kind": "pdf", "page": 1, "quads": [[0.1, 0.1, 0.9, 0.2]]},
                selected_text_hash="sha256:" + "f" * 64,
                preview_text="display only",
                snapshot_text=snapshot,
            ),
        )

        for kind in ("pdf", "writer", "calc", "impress", "markdown", "text"):
            with self.subTest(kind=kind):
                candidate = replace(
                    ref,
                    anchor=replace(ref.anchor, locator={"kind": kind}),
                )
                result = SelectionContextProvider(UnreadableContent()).resolve(
                    AssistantContextResolveRequest(
                        requester_session_id=SESSION_ID,
                        project_id="",
                        question="这段话讲了什么？",
                        ref=candidate,
                        budget=AssistantContextBudget(max_chars=40000, max_items=1),
                    )
                )
                self.assertEqual(result.state, ContextResolutionState.READY)
                self.assertEqual(result.source_revision, ref.source_revision)
                self.assertEqual(result.items[0].text, snapshot)
                self.assertEqual(result.items[0].content_hash, _selection_hash(snapshot))

    def test_missing_selection_snapshot_requires_readding_without_reading_source(self) -> None:
        class UnreadableContent:
            def read_bytes(self, project_id: str, source_id: str):
                raise AssertionError("legacy selection must not read its source")

        ref = ContextRef(
            ref_id="legacy-selection",
            kind=ContextRefKind.SELECTION,
            source_id="missing.docx",
            label="missing.docx",
            anchor=SelectionAnchor(
                locator={"kind": "writer"},
                selected_text_hash=_selection_hash("display only"),
                preview_text="display only",
            ),
        )
        result = SelectionContextProvider(UnreadableContent()).resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=ref,
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
        )
        self.assertEqual(result.state, ContextResolutionState.UNAVAILABLE)
        self.assertEqual(result.issues[0].code, "selection_snapshot_required")
        self.assertFalse(result.items)

    def test_markdown_snapshot_survives_source_deletion_and_hash_mismatch(self) -> None:
        self.content.write_text(self.project.id, "source.md", "real selected source")
        ref = self.selection_ref(
            "source.md",
            {"kind": "markdown", "start": 5, "end": 13, "source_map_version": "v1"},
            "different",
        )
        ref = replace(ref, anchor=replace(ref.anchor, snapshot_text="selected snapshot"))
        (Path(self.project.root) / "source.md").unlink()

        result = self.selection_provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=ref,
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
        )

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, "selected snapshot")

    def test_pdf_selection_uses_visual_lines_across_text_fragments(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "alpha")
        page.insert_text((160, 72), "chosen")
        page.insert_text((72, 90), "second row")
        selected = "alpha chosen\nsecond row"
        width, height = page.rect.width, page.rect.height
        first_line = pdf_fixture.Rect(72, 60, 200, 76)
        second_line = pdf_fixture.Rect(72, 78, 130, 94)
        locator = {
            "kind": "pdf",
            "page": 1,
            "quads": [
                [
                    first_line.x0 / width,
                    first_line.y0 / height,
                    first_line.x1 / width,
                    first_line.y1 / height,
                ],
                [
                    second_line.x0 / width,
                    second_line.y0 / height,
                    second_line.x1 / width,
                    second_line.y1 / height,
                ],
            ],
        }
        (Path(self.project.root) / "fragmented.pdf").write_bytes(document.tobytes())
        document.close()

        item = self.resolve_selection("fragmented.pdf", locator, selected)

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_pdf_selection_respects_character_boundary_inside_pdf_word(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "alpha chosen. omega")
        selected = "chosen"
        rect = page.search_for(selected)[0]
        width, height = page.rect.width, page.rect.height
        locator = {
            "kind": "pdf",
            "page": 1,
            "quads": [[rect.x0 / width, rect.y0 / height, rect.x1 / width, rect.y1 / height]],
        }
        (Path(self.project.root) / "partial-word.pdf").write_bytes(document.tobytes())
        document.close()

        item = self.resolve_selection("partial-word.pdf", locator, selected)

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_pdf_snapshot_keeps_browser_text_while_actions_verify_cjk_shape(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        authoritative = "人口老龄化 2026"
        browser_aliases = "⼈⼜⽼龄化 2026"
        page.insert_text((72, 72), authoritative, fontname="china-s")
        rect = page.search_for(authoritative)[0]
        width, height = page.rect.width, page.rect.height
        locator = {
            "kind": "pdf",
            "page": 1,
            "quads": [
                [
                    rect.x0 / width,
                    rect.y0 / height,
                    rect.x1 / width,
                    rect.y1 / height,
                ]
            ],
            "text_length": len(browser_aliases),
            "text_shape_hash": _selection_hash("中中中中中 2026"),
        }
        (Path(self.project.root) / "cjk.pdf").write_bytes(document.tobytes())
        document.close()

        item = self.resolve_selection("cjk.pdf", locator, browser_aliases)
        direct = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id="cjk.pdf",
                source_revision=self.content.snapshot(self.project.id, "cjk.pdf").revision,
                locator_kind="pdf",
                selected_text_hash=_selection_hash(browser_aliases),
                locator=locator,
            )
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, browser_aliases)
        self.assertEqual(item.items[0].content_hash, _selection_hash(browser_aliases))
        self.assertEqual(direct.selected_text, authoritative)

    def test_docx_writer_selection_resolves_paragraph_and_utf16_offsets(self) -> None:
        document = Document()
        document.add_paragraph("first")
        paragraph = "prefix 😀selected suffix"
        document.add_paragraph(paragraph)
        output = BytesIO()
        document.save(output)
        (Path(self.project.root) / "sample.docx").write_bytes(output.getvalue())
        selected = "😀selected"
        start = _utf16_length(paragraph[: paragraph.index(selected)])

        item = self.resolve_selection(
            "sample.docx",
            {
                "kind": "writer",
                "format": "docx",
                "paragraph": "paragraph-2",
                "start": start,
                "end": start + _utf16_length(selected),
            },
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_docx_writer_selection_resolves_across_paragraphs(self) -> None:
        document = Document()
        first = "first prefix selected start"
        middle = "middle paragraph"
        last = "selected end suffix"
        document.add_paragraph(first)
        document.add_paragraph(middle)
        document.add_paragraph(last)
        output = BytesIO()
        document.save(output)
        (Path(self.project.root) / "multipage.docx").write_bytes(output.getvalue())
        selected = "selected start\nmiddle paragraph\nselected end"

        item = self.resolve_selection(
            "multipage.docx",
            {
                "kind": "writer",
                "format": "docx",
                "paragraph": "paragraph-1",
                "end_paragraph": "paragraph-3",
                "start": _utf16_length("first prefix "),
                "end": _utf16_length("selected end"),
            },
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_legacy_doc_writer_selection_is_separate_from_docx_resolution(self) -> None:
        (Path(self.project.root) / "legacy.doc").write_bytes(b"legacy-binary-doc")
        locator = {
            "kind": "writer",
            "format": "doc",
            "paragraph": "paragraph-1",
            "start": 0,
            "end": 6,
        }

        item = self.resolve_selection("legacy.doc", locator, "legacy")

        self.assertEqual(item.state, ContextResolutionState.READY)

    def test_writer_snapshot_does_not_validate_source_format(self) -> None:
        document = Document()
        document.add_paragraph("selected")
        output = BytesIO()
        document.save(output)
        (Path(self.project.root) / "sample.docx").write_bytes(output.getvalue())

        item = self.resolve_selection(
            "sample.docx",
            {
                "kind": "writer",
                "format": "doc",
                "paragraph": "paragraph-1",
                "start": 0,
                "end": 8,
            },
            "selected",
        )

        self.assertEqual(item.state, ContextResolutionState.READY)

    def test_xlsx_calc_selection_resolves_sheet_range(self) -> None:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Evidence"
        sheet["B2"] = "selected"
        sheet["C2"] = 47
        output = BytesIO()
        workbook.save(output)
        (Path(self.project.root) / "sample.xlsx").write_bytes(output.getvalue())
        selected = "selected\t47"

        item = self.resolve_selection(
            "sample.xlsx",
            {"kind": "calc", "sheet": "Evidence", "range": "B2:C2"},
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_large_calc_reference_reads_versioned_sheet_range_content(self) -> None:
        values = [f"value-{index}" for index in range(1, 152)]
        rows = "".join(
            f'<row r="{index}"><c r="A{index}" t="inlineStr"><is><t>{value}</t></is></c></row>'
            for index, value in enumerate(values, start=1)
        )
        output = BytesIO()
        with ZipFile(output, "w") as archive:
            archive.writestr(
                "[Content_Types].xml",
                '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
            )
            archive.writestr(
                "_rels/.rels",
                '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
            )
            archive.writestr(
                "xl/workbook.xml",
                '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Evidence" sheetId="1" r:id="rId1"/></sheets></workbook>',
            )
            archive.writestr(
                "xl/_rels/workbook.xml.rels",
                '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
            )
            archive.writestr(
                "xl/worksheets/sheet1.xml",
                f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{rows}</sheetData></worksheet>',
            )
        (Path(self.project.root) / "large.xlsx").write_bytes(output.getvalue())
        reference_text = "large.xlsx · Evidence!A1:A1048576"
        selected = "\n".join(values)
        locator = {
            "kind": "calc",
            "sheet": "Evidence",
            "range": "A1:A1048576",
            "content_mode": "reference",
        }
        ref = self.selection_ref("large.xlsx", locator, reference_text)
        evidence = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id="large.xlsx",
                source_revision=ref.source_revision or "",
                locator_kind="calc",
                selected_text_hash=_selection_hash(reference_text),
                locator=locator,
            )
        )

        ref = replace(ref, anchor=replace(ref.anchor, snapshot_text=evidence.selected_text))
        (Path(self.project.root) / "large.xlsx").unlink()
        result = self.selection_provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=ref,
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
        )

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, selected)
        self.assertEqual(result.items[0].content_hash, _selection_hash(selected))
        self.assertEqual(result.items[0].role.value, "material")
        self.assertEqual(result.items[0].model_locator, "")
        self.assertEqual(evidence.reference.locator["range"], "A1:A151")
        self.assertEqual(evidence.selected_text, selected)
        self.assertEqual(evidence.context_text, selected)
        self.assertEqual(evidence.mode.value, "persisted")
        self.assertFalse(evidence.can_edit)

        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        frozen = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-large-calc-reference",
            expected_revision=selection.revision,
            question="解释这个选区",
        )
        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        model_payload = json.loads(frozen.context.model_context.splitlines()[1])
        self.assertEqual(model_payload["scopes"] if "scopes" in model_payload else [], [])
        self.assertEqual(model_payload["evidence"][0]["content"], selected)
        self.assertIn("selected_material_policy", model_payload)

    def test_large_csv_column_reference_clips_to_last_populated_cell(self) -> None:
        rows = ["name,region"] + [f"item-{index},region-{index}" for index in range(1, 12)]
        (Path(self.project.root) / "large.csv").write_text("\n".join(rows), encoding="utf-8")
        reference_text = "large.csv · large!B1:B1048576"
        locator = {
            "kind": "calc",
            "sheet": "large",
            "range": "B1:B1048576",
            "content_mode": "reference",
        }
        ref = self.selection_ref("large.csv", locator, reference_text)

        evidence = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id="large.csv",
                source_revision=ref.source_revision or "",
                locator_kind="calc",
                selected_text_hash=_selection_hash(reference_text),
                locator=locator,
            )
        )

        self.assertEqual(
            evidence.selected_text,
            "region\n" + "\n".join(f"region-{index}" for index in range(1, 12)),
        )
        self.assertEqual(evidence.reference.locator["range"], "B1:B12")

    def test_large_csv_row_reference_clips_to_last_populated_cell(self) -> None:
        (Path(self.project.root) / "large.csv").write_text(
            "name,region\nitem-1,region-1\n",
            encoding="utf-8",
        )
        reference_text = "large.csv · large!A2:XFD2"
        locator = {
            "kind": "calc",
            "sheet": "large",
            "range": "A2:XFD2",
            "content_mode": "reference",
        }
        ref = self.selection_ref("large.csv", locator, reference_text)

        evidence = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id="large.csv",
                source_revision=ref.source_revision or "",
                locator_kind="calc",
                selected_text_hash=_selection_hash(reference_text),
                locator=locator,
            )
        )

        self.assertEqual(evidence.selected_text, "item-1\tregion-1")
        self.assertEqual(evidence.reference.locator["range"], "A2:B2")

    def test_large_xls_column_reference_reads_legacy_workbook(self) -> None:
        source = "legacy.xls"
        (Path(self.project.root) / source).write_bytes(
            (FIXTURES / "selection-range.xls").read_bytes()
        )
        reference_text = "legacy.xls · Evidence!C1:C65536"
        locator = {
            "kind": "calc",
            "sheet": "Evidence",
            "range": "C1:C65536",
            "content_mode": "reference",
        }
        ref = self.selection_ref(source, locator, reference_text)

        evidence = self.selection_provider.resolve_action(
            SelectionEvidenceReference(
                project_id=self.project.id,
                source_id=source,
                source_revision=ref.source_revision or "",
                locator_kind="calc",
                selected_text_hash=_selection_hash(reference_text),
                locator=locator,
            )
        )

        self.assertEqual(evidence.selected_text, "header\nalpha\nbeta\ngamma")
        self.assertEqual(evidence.reference.locator["range"], "C1:C4")

    def test_large_calc_reference_rejects_content_over_context_limit(self) -> None:
        cell_value = "x" * 300
        rows = [cell_value for _index in range(151)]
        (Path(self.project.root) / "oversized.csv").write_text("\n".join(rows), encoding="utf-8")
        reference_text = "oversized.csv · oversized!A1:A151"
        locator = {
            "kind": "calc",
            "sheet": "oversized",
            "range": "A1:A151",
            "content_mode": "reference",
        }
        ref = self.selection_ref("oversized.csv", locator, reference_text)
        ref = replace(ref, anchor=replace(ref.anchor, snapshot_text="\n".join(rows)))

        result = self.selection_provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="",
                ref=ref,
                budget=AssistantContextBudget(max_chars=40000, max_items=1),
            )
        )

        self.assertEqual(result.state, ContextResolutionState.TOO_LARGE)
        self.assertEqual(result.issues[0].code, "selection_budget_exceeded")
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_too_large"):
            self.selection_provider.resolve_action(
                SelectionEvidenceReference(
                    project_id=self.project.id,
                    source_id="oversized.csv",
                    source_revision=ref.source_revision or "",
                    locator_kind="calc",
                    selected_text_hash=_selection_hash(reference_text),
                    locator=locator,
                )
            )

    def test_small_xlsx_reference_reads_authoritative_dates_and_decimals(self) -> None:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Evidence"
        sheet["B2"] = datetime(2026, 10, 14, 9, 30)
        sheet["C2"] = 0.30000000000000004
        output = BytesIO()
        workbook.save(output)
        (Path(self.project.root) / "sample.xlsx").write_bytes(output.getvalue())
        descriptor = "sample.xlsx · Evidence!B2:C2"
        locator = {
            "kind": "calc",
            "sheet": "Evidence",
            "range": "B2:C2",
            "content_mode": "reference",
        }
        ref = self.selection_ref("sample.xlsx", locator, descriptor)
        reference = SelectionEvidenceReference(
            project_id=self.project.id,
            source_id="sample.xlsx",
            source_revision=ref.source_revision or "",
            locator_kind="calc",
            selected_text_hash=_selection_hash(descriptor),
            locator=locator,
        )

        evidence = self.selection_provider.resolve_action(reference)

        self.assertEqual(evidence.selected_text, "2026-10-14T09:30:00\t0.3")
        self.assertEqual(evidence.context_text, evidence.selected_text)
        self.assertEqual(evidence.evidence_revision, reference.source_revision)
        self.assertEqual(evidence.reference.locator["range"], "B2:C2")
        self.assertEqual(evidence.mode.value, "persisted")
        for forged in (
            replace(reference, selected_text_hash=_selection_hash("forged cell content")),
            replace(reference, source_revision="sha256:" + "a" * 64),
            replace(reference, locator={**locator, "sheet": "Wrong"}),
            replace(reference, locator={**locator, "range": "A1:C2"}),
        ):
            with self.subTest(reference=forged):
                with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
                    self.selection_provider.resolve_action(forged)

    def test_calc_reference_rejects_invalid_ranges_and_forged_text(self) -> None:
        class UnreadableContent:
            def read_bytes(self, project_id: str, source_id: str):
                raise AssertionError(f"content read attempted: {project_id}/{source_id}")

        provider = SelectionContextProvider(UnreadableContent())
        base = SelectionEvidenceReference(
            project_id=self.project.id,
            source_id="large.xlsx",
            source_revision="sha256:" + "a" * 64,
            locator_kind="calc",
            selected_text_hash=_selection_hash("large.xlsx · Evidence!A1:A151"),
            locator={
                "kind": "calc",
                "sheet": "Evidence",
                "range": "A1:A151",
                "content_mode": "reference",
            },
        )
        for selected_range in ("A2:A1", "B1:A1", "A0:A1", "not-a-range", "XFE1:XFE2"):
            with self.subTest(selected_range=selected_range):
                with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
                    provider.resolve_action(
                        replace(base, locator={**base.locator, "range": selected_range})
                    )
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            provider.resolve_action(
                replace(
                    base,
                    locator={**base.locator, "range": "A1:A151"},
                    selected_text_hash=_selection_hash("forged cell content"),
                )
            )

    def test_csv_calc_selection_resolves_the_same_tabular_locator(self) -> None:
        (Path(self.project.root) / "sample.csv").write_text(
            "sample,value\nalpha,47\nbeta,53\n",
            encoding="utf-8",
        )
        selected = "alpha\t47\nbeta\t53"

        item = self.resolve_selection(
            "sample.csv",
            {"kind": "calc", "sheet": "sample", "range": "A2:B3"},
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_csv_calc_selection_matches_calc_numeric_display_values(self) -> None:
        (Path(self.project.root) / "numeric.csv").write_text(
            "item,unit_price,total\nAPI Add-on,99.0,792.0\n",
            encoding="utf-8",
        )
        selected = "API Add-on\t99\t792"

        item = self.resolve_selection(
            "numeric.csv",
            {"kind": "calc", "sheet": "numeric", "range": "A2:C2"},
            selected,
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, selected)

    def test_pptx_impress_selection_resolves_named_shape(self) -> None:
        presentation = Presentation()
        slide = presentation.slides.add_slide(presentation.slide_layouts[6])
        shape = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
        shape.name = "EvidenceShape"
        shape.text = "prefix selected suffix"
        output = BytesIO()
        presentation.save(output)
        (Path(self.project.root) / "sample.pptx").write_bytes(output.getvalue())

        item = self.resolve_selection(
            "sample.pptx",
            {"kind": "impress", "slide": 1, "shape": "EvidenceShape", "start": 7, "end": 15},
            "selected",
        )

        self.assertEqual(item.state, ContextResolutionState.READY)
        self.assertEqual(item.items[0].text, "selected")

    def test_ppt_chat_uses_snapshot_while_actions_require_verified_evidence(self) -> None:
        payload = b"legacy-binary-ppt"
        source = Path(self.project.root) / "sample.ppt"
        source.write_bytes(payload)
        selected = "selected"
        reference = SelectionEvidenceReference(
            project_id=self.project.id,
            source_id="sample.ppt",
            source_revision="sha256:" + hashlib.sha256(payload).hexdigest(),
            locator_kind="impress",
            selected_text_hash=_selection_hash(selected),
            locator={
                "kind": "impress",
                "slide": 1,
                "shape": "EvidenceShape",
                "start": 0,
                "end": len(selected),
            },
        )

        item = self.resolve_selection(
            "sample.ppt",
            reference.locator,
            selected,
            revision=reference.source_revision,
        )
        self.assertEqual(item.state, ContextResolutionState.READY)

        with self.assertRaisesRegex(SelectionEvidenceError, "selection_snapshot_required"):
            self.selection_provider.resolve_action(reference)

        source.write_bytes(b"changed-legacy-binary-ppt")
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            self.selection_provider.resolve_action(reference)

    def test_selection_snapshot_preserves_original_revision_despite_source_changes(self) -> None:
        self.content.write_text(self.project.id, "stale.md", "real selected source")
        original_revision = self.content.snapshot(self.project.id, "stale.md").revision
        locator = {
            "kind": "markdown",
            "start": 5,
            "end": 13,
            "source_map_version": "md-source-v1",
        }
        self.content.write_text(
            self.project.id,
            "stale.md",
            "real selected source\nnew content outside the selection",
        )
        current_revision = self.content.snapshot(self.project.id, "stale.md").revision

        rebound = self.resolve_selection(
            "stale.md",
            locator,
            "selected",
            revision=original_revision,
        )
        stale_hash = self.resolve_selection("stale.md", locator, "different")
        self.content.write_text(
            self.project.id,
            "stale.md",
            "prefix real selected source\nnew content outside the selection",
        )
        shifted = self.resolve_selection(
            "stale.md",
            locator,
            "selected",
            revision=current_revision,
        )

        self.assertEqual(rebound.state, ContextResolutionState.READY)
        self.assertEqual(
            rebound.source_revision,
            original_revision,
        )
        self.assertEqual(rebound.items[0].text, "selected")
        self.assertEqual(stale_hash.state, ContextResolutionState.READY)
        self.assertEqual(stale_hash.items[0].text, "different")
        self.assertEqual(shifted.state, ContextResolutionState.READY)
        self.assertEqual(shifted.items[0].text, "selected")

    def test_released_snapshot_cannot_replay_or_consume_new_quotes(self) -> None:
        self.content.write_text(self.project.id, "claim.md", "selected")
        ref = self.selection_ref("claim.md", {"kind": "markdown", "start": 0, "end": 8}, "selected")
        ref = ContextRef(**{**ref.__dict__, "retention": ContextRetention.NEXT_TURN})
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        first = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="first",
            expected_revision=selection.revision,
            question="q",
        )
        self.assertIsNotNone(first.context)
        self.assistant.finalize(
            session_id=SESSION_ID,
            client_turn_id="first",
            outcome=AssistantTurnFinalization.REJECTED,
        )
        replay = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="first",
            expected_revision=selection.revision,
            question="q",
        )
        self.assertIsNotNone(replay.failure)
        self.assertEqual(replay.failure.kind, AssistantContextFailureKind.IDEMPOTENCY_CONFLICT)
        second = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="second",
            expected_revision=selection.revision,
            question="q2",
        )
        self.assertIsNotNone(second.context)
        replay = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="first",
            expected_revision=selection.revision,
            question="q",
        )
        self.assertIsNotNone(replay.failure)

    def test_assistant_freezes_selection_snapshot_without_using_preview(self) -> None:
        source = "before verified evidence after"
        selected_text = "verified evidence"
        self.content.write_text(self.project.id, "selection.md", source)
        start = _utf16_length(source[: source.index(selected_text)])
        ref = self.selection_ref(
            "selection.md",
            {
                "kind": "markdown",
                "start": start,
                "end": start + _utf16_length(selected_text),
                "source_map_version": "md-source-v1",
            },
            selected_text,
        )
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-selection-provider",
            expected_revision=selection.revision,
            question="Explain",
        )

        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        assert result.context is not None
        self.assertIn(selected_text, result.context.model_context)
        self.assertNotIn("forged preview", result.context.model_context)
        self.assertEqual(result.context.snapshot.items[0].ref.kind, ContextRefKind.SELECTION)


if __name__ == "__main__":
    unittest.main()
