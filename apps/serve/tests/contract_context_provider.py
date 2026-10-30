"""Contract tests for real Content/Literature -> Assistant context adapters."""

from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import patch

from docx import Document
from docx.enum.section import WD_SECTION_START
from docx.parts.hdrftr import FooterPart, HeaderPart
from fastapi import FastAPI
from fastapi.testclient import TestClient
from openpyxl import Workbook

from apps.serve.tests import pdf as pdf_fixture
from scholarseed_runtime.contract.history import HistoryEntry
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.context import AssistantService
from service.chat.active import RUNTIME_ID
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_USER_MESSAGE,
    USER_MESSAGE_BINDING_ADMITTED,
    USER_MESSAGE_BINDING_BOUND,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.service.context import SessionContextProvider
from service.chat.service.history import HistoryService
from service.content.persistence.catalog import ContentCatalog
from service.content.service.context import ContentContextProvider
from service.content.service.extract import decode_docx
from service.content.service.port import ContentService, ProjectRegistry
from service.literature.api.reading import register_reading_routes
from service.literature.persistence import files as literature_files
from service.literature.persistence.store import LiteratureRepository, edit_library
from service.literature.schema import (
    PDF_MEDIA_TYPE,
    AttachmentRole,
    FulltextStatus,
    LiteratureItem,
    LiteratureView,
)
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.context import LiteratureContextProvider
from service.literature.service.pdf import LiteraturePdf
from service.platform.activity import Activities
from service.platform.context import (
    AssistantContextBudget,
    AssistantContextResolveRequest,
    ContextItemRole,
    ContextOrigin,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ProjectContextPolicy,
    SearchScope,
    SelectionAnchor,
)
from service.workbench.domain.model import WorkbenchFormatPolicy
from service.workbench.domain.selection import (
    SelectionDraftEvidence,
    SelectionEvidenceError,
    SelectionEvidenceMode,
    SelectionEvidenceReference,
)
from service.workbench.service.context import SelectionContextProvider

SESSION_ID = "context-provider-session"


def _selection_hash(text: str) -> str:
    return f"sha256:{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


class ContentExtractionContract(unittest.TestCase):
    def test_docx_extraction_does_not_create_missing_headers_or_footers(self) -> None:
        document = Document()
        document.add_paragraph("body evidence")
        output = BytesIO()
        document.save(output)
        package = document.part.package
        assert package is not None
        original_parts = tuple(part.partname for part in package.parts)

        with patch("service.content.service.extract.Document", return_value=document):
            self.assertEqual(decode_docx(output.getvalue()), "body evidence")

        self.assertEqual(tuple(part.partname for part in package.parts), original_parts)

    def test_docx_extraction_preserves_existing_and_inherited_header_footer_variants(self) -> None:
        document = Document()
        document.add_paragraph("body evidence")
        section = document.sections[0]
        containers = (
            section.header,
            section.first_page_header,
            section.even_page_header,
            section.footer,
            section.first_page_footer,
            section.even_page_footer,
        )
        expected = ["body evidence"]
        for index, container in enumerate(containers):
            text = f"variant evidence {index}"
            container.paragraphs[0].text = text
            expected.append(text)
        document.add_section(WD_SECTION_START.NEW_PAGE)
        final_section = document.add_section(WD_SECTION_START.NEW_PAGE)
        final_section.header.is_linked_to_previous = False
        final_section.header.paragraphs[0].text = "independent header"
        expected.append("independent header")
        output = BytesIO()
        document.save(output)

        self.assertEqual(decode_docx(output.getvalue()).splitlines(), expected)


class ContentContextProviderContract(unittest.TestCase):
    def test_csv_draft_action_retains_literal_values_and_validates_evidence(self) -> None:
        payload = b"id,value\r\n001,1e3\r\n"
        path = Path(self.project.root) / "draft.csv"
        path.write_bytes(payload)
        revision = _selection_hash(payload.decode())
        selected = "0002\t2e3"
        reference = SelectionEvidenceReference(
            self.project.id,
            "draft.csv",
            revision,
            "calc",
            _selection_hash(selected),
            {"kind": "calc", "sheet": "draft", "range": "A2:B2"},
        )
        draft = SelectionDraftEvidence(1, selected, selected, _selection_hash(selected))
        provider = SelectionContextProvider(self.content)
        verified = provider.resolve_action(reference, draft)
        self.assertEqual(verified.mode, SelectionEvidenceMode.DRAFT)
        self.assertEqual(verified.selected_text, selected)
        self.assertTrue(verified.can_edit)
        self.assertEqual(path.read_bytes(), payload, "draft resolution never writes the source")
        for invalid in (
            replace(draft, change_version=0),
            replace(draft, selected_text_hash="sha256:invalid"),
            replace(draft, context_text="different context"),
        ):
            with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
                provider.resolve_action(reference, invalid)
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_stale"):
            provider.resolve_action(replace(reference, source_revision="sha256:stale"), draft)
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
            provider.resolve_action(
                replace(reference, locator={**reference.locator, "content_mode": "reference"}),
                draft,
            )
        invalid_payload = b'column,"unterminated'
        (Path(self.project.root) / "unsafe.csv").write_bytes(invalid_payload)
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
            provider.resolve_action(
                replace(
                    reference,
                    source_id="unsafe.csv",
                    source_revision="sha256:" + hashlib.sha256(invalid_payload).hexdigest(),
                ),
                draft,
            )
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
            provider.resolve_action(
                replace(reference, locator={"kind": "calc", "sheet": "draft", "range": "A0:B2"}),
                draft,
            )
        output = BytesIO()
        workbook = Workbook()
        workbook.active.append(["001", "1e3"])
        workbook.save(output)
        (Path(self.project.root) / "readonly.xlsx").write_bytes(output.getvalue())
        with self.assertRaisesRegex(SelectionEvidenceError, "selection_unsupported"):
            provider.resolve_action(
                replace(
                    reference,
                    source_id="readonly.xlsx",
                    source_revision="sha256:" + hashlib.sha256(output.getvalue()).hexdigest(),
                ),
                draft,
            )

    def test_literature_csv_open_and_put_remain_readonly(self) -> None:
        literature_id = "paper-readonly-csv"
        self.literature_repository.save(LiteratureItem(id=literature_id, title="CSV"))
        payload = b"id,value\r\n001,1e3\r\n"
        attachment = self.stage_attachment(literature_id, "evidence.csv", payload)
        app = FastAPI()
        attachments = LiteratureAttachmentContent(self.literature_repository)
        register_reading_routes(
            app,
            self.literature_repository,
            attachments,
            LiteraturePdf(self.literature_repository),
            WorkbenchFormatPolicy(),
        )
        route = f"/api/v1/literatures/{literature_id}/attachments/{attachment['id']}"
        with TestClient(app) as client:
            opened = client.get(f"{route}/open")
            self.assertEqual(opened.status_code, 200, opened.text)
            self.assertFalse(opened.json()["capabilities"]["can_edit"])
            self.assertFalse(opened.json()["capabilities"]["can_save"])
            self.assertTrue(opened.json()["capabilities"]["can_select"])
            denied = client.put(
                f"{route}/content",
                content=b"id,value\n002,2e3\n",
                headers={
                    "Content-Type": "application/octet-stream",
                    "If-Match": f'"{attachment["revision"]}"',
                },
            )
            self.assertEqual(denied.status_code, 415, denied.text)
            self.assertEqual(
                attachments.read_attachment(literature_id, attachment["id"])[0], payload
            )

    def test_literature_range_snapshot_is_materialized_when_added(self) -> None:
        literature_id = "paper-range-snapshot"
        self.literature_repository.save(LiteratureItem(id=literature_id, title="Range"))
        payload = "\n".join(f"row-{index}" for index in range(1, 152)).encode()
        attachment = self.stage_attachment(literature_id, "evidence.csv", payload)
        app = FastAPI()
        register_reading_routes(
            app,
            self.literature_repository,
            LiteratureAttachmentContent(self.literature_repository),
            LiteraturePdf(self.literature_repository),
            WorkbenchFormatPolicy(),
        )
        route = (
            f"/api/v1/literatures/{literature_id}/attachments/{attachment['id']}/selection-snapshot"
        )
        body = {"source_revision": attachment["revision"], "sheet": "evidence", "range": "A1:A151"}
        with TestClient(app) as client:
            response = client.post(route, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["snapshot_text"], payload.decode())
            self.assertEqual(response.json()["source_revision"], attachment["revision"])
            stale = client.post(route, json={**body, "source_revision": "sha256:stale"})
            self.assertEqual(stale.status_code, 412)

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
        self.literature_database = root / "literature.sqlite3"
        self.literature_repository = LiteratureRepository(self.literature_database)
        # 附件是文献独占的托管副本, 托管目录必须落在本次测试的临时根里 (并且是
        # resolve 之后的形式: read_absolute 会把入参 resolve 后再与行里的 path 比对),
        # 绝不能碰到真实的 SCHOLARSEED_HOME。
        self.attachment_root = root / "attachments"
        self.attachment_root.mkdir()
        self.attachment_root = self.attachment_root.resolve()
        store_patch = patch.object(
            literature_files,
            "SERVICE_LITERATURE_FILES_DIR",
            self.attachment_root,
        )
        store_patch.start()
        self.addCleanup(store_patch.stop)
        self.literature_provider = LiteratureContextProvider(
            self.content, self.literature_repository
        )
        self.session_catalog = SessionCatalogStore(root / "sessions.sqlite3")
        self.events = ProductEventStore(self.session_catalog.database)
        self.session_catalog.register(
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
            AssistantStore(self.session_catalog.database),
            project_for_session=lambda _session_id: project.id,
            providers={
                ContextRefKind.FILE: self.provider,
                ContextRefKind.DIR: self.provider,
                ContextRefKind.LITERATURE: self.literature_provider,
                ContextRefKind.SESSION: SessionContextProvider(
                    HistoryService(self.session_catalog, self.events),
                ),
            },
            active_document_resolvers={
                ContextRefKind.FILE: self.provider,
                ContextRefKind.LITERATURE: self.literature_provider,
            },
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def stage_attachment(
        self, literature_id: str, name: str, payload: bytes, **columns: Any
    ) -> dict[str, Any]:
        """Write one literature-owned attachment copy and register its row."""
        published = literature_files.managed_object(literature_id, payload, Path(name).suffix)
        location = self.attachment_root / published.name
        location.write_bytes(payload)
        return self.literature_repository.add_attachment(
            literature_id,
            name,
            str(location),
            revision=published.revision,
            **columns,
        )

    @staticmethod
    def ref(kind: ContextRefKind, source_id: str, revision: str | None = None) -> ContextRef:
        return ContextRef(
            ref_id=f"ref-{kind.value}",
            kind=kind,
            source_id=source_id,
            label=Path(source_id).name,
            source_revision=revision,
        )

    def resolve(self, provider, ref: ContextRef):
        return provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="contract question",
                ref=ref,
                budget=AssistantContextBudget(max_chars=60_000, max_items=64),
            )
        )

    def test_docx_reference_freezes_without_loading_missing_default_templates(self) -> None:
        document = Document()
        document.add_paragraph("attached document evidence")
        path = Path(self.project.root) / "evidence.docx"
        document.save(str(path))
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.FILE, path.name),),
        )

        with (
            patch.object(HeaderPart, "new", side_effect=OSError("default template unavailable")),
            patch.object(FooterPart, "new", side_effect=OSError("default template unavailable")),
        ):
            result = self.assistant.freeze(
                session_id=SESSION_ID,
                client_turn_id="docx-reference-turn",
                expected_revision=selection.revision,
                question="Read the attached document",
            )

        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        assert result.context is not None
        self.assertEqual(result.context.snapshot.items[0].state, ContextResolutionState.READY)
        self.assertEqual(
            result.context.snapshot.items[0].excerpt_text, "attached document evidence"
        )

    def test_file_reads_real_content_and_freezes_revision(self) -> None:
        self.content.write_text(self.project.id, "evidence.md", "nonce-context-47")

        result = self.resolve(self.provider, self.ref(ContextRefKind.FILE, "evidence.md"))
        item = result.items[0]

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(item.text, "nonce-context-47")
        self.assertTrue(item.source_revision.startswith("sha256:"))
        self.assertNotIn(self.project.root, item.source_id)

    def test_project_content_is_forbidden_without_a_project_scope(self) -> None:
        self.content.write_text(self.project.id, "evidence.md", "project-only")

        result = self.provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id="",
                question="contract question",
                ref=self.ref(ContextRefKind.FILE, "evidence.md"),
                budget=AssistantContextBudget(max_chars=60_000, max_items=64),
            )
        )

        self.assertEqual(result.state, ContextResolutionState.FORBIDDEN)
        self.assertEqual(result.issues[0].code, "source_forbidden")

    def test_allowlisted_absolute_file_uses_the_injected_reader(self) -> None:
        absolute = Path(self.temporary.name) / "literature-files" / "paper.txt"
        absolute.parent.mkdir()
        absolute.write_text("managed literature attachment", encoding="utf-8")
        reads: list[str] = []

        def read_absolute(path: str) -> tuple[bytes, str]:
            reads.append(path)
            if path != str(absolute):
                raise ValueError("untrusted_absolute_file")
            return absolute.read_bytes(), "text/plain"

        provider = ContentContextProvider(self.content, absolute_file_reader=read_absolute)
        assistant = AssistantService(
            AssistantStore(self.session_catalog.database),
            project_for_session=lambda _session_id: self.project.id,
            providers={ContextRefKind.FILE: provider},
        )
        selected = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.FILE, str(absolute)),),
        )
        frozen = assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="absolute-literature",
            expected_revision=selected.revision,
            question="summarize",
        ).context

        assert frozen is not None
        self.assertEqual(reads, [str(absolute)])
        self.assertEqual(frozen.snapshot.items[0].excerpt_text, "managed literature attachment")

    def test_absolute_file_without_an_allowlisted_reader_is_forbidden(self) -> None:
        absolute = str(Path(self.temporary.name) / "outside.txt")

        result = self.resolve(self.provider, self.ref(ContextRefKind.FILE, absolute))

        self.assertEqual(result.state, ContextResolutionState.FORBIDDEN)
        self.assertEqual(result.issues[0].code, "source_forbidden")

    def test_current_project_absolute_file_uses_existing_content_authority(self) -> None:
        self.content.write_text(self.project.id, "paper.txt", "project literature attachment")
        absolute = self.content.resolve(self.project.id, "paper.txt")

        result = self.resolve(self.provider, self.ref(ContextRefKind.FILE, absolute))

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, "project literature attachment")

    def test_literature_attachment_absolute_file_uses_attachment_authority(self) -> None:
        item = LiteratureItem(id="paper", title="Paper")
        self.literature_repository.save(item, project_id=self.project.id)
        attachment = self.stage_attachment(
            item.id,
            "paper.txt",
            b"literature attachment body",
            role=AttachmentRole.PRIMARY,
            media_type="text/plain",
        )
        attachments = LiteratureAttachmentContent(self.literature_repository)
        provider = ContentContextProvider(
            self.content,
            absolute_file_reader=attachments.read_absolute,
        )

        result = self.resolve(provider, self.ref(ContextRefKind.FILE, attachment["path"]))

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, "literature attachment body")

    def test_managed_literature_absolute_file_preserves_detected_media_type(self) -> None:
        attachments = LiteratureAttachmentContent(self.literature_repository)
        payload = b"managed literature attachment"
        with (
            patch(
                "service.literature.service.attachment.is_managed_attachment",
                return_value=True,
            ),
            patch(
                "service.literature.service.attachment.read_attachment",
                return_value=payload,
            ),
            patch.object(
                self.literature_repository,
                "has_attachment_path",
                return_value=True,
            ),
        ):
            read, media_type = attachments.read_absolute("/managed/paper.txt")

        self.assertEqual(read, payload)
        self.assertEqual(media_type, "application/octet-stream")

    def test_unregistered_absolute_file_cannot_use_attachment_authority(self) -> None:
        other_root = Path(self.temporary.name) / "unregistered-project"
        other_root.mkdir()
        project = self.content.adopt_project(str(other_root), "Unregistered")
        self.content.write_text(project.id, "secret.txt", "not a literature attachment")
        attachments = LiteratureAttachmentContent(self.literature_repository)
        provider = ContentContextProvider(
            self.content,
            absolute_file_reader=attachments.read_absolute,
        )
        absolute = self.content.resolve(project.id, "secret.txt")

        result = self.resolve(provider, self.ref(ContextRefKind.FILE, absolute))

        self.assertEqual(result.state, ContextResolutionState.FORBIDDEN)
        self.assertEqual(result.issues[0].code, "source_forbidden")

    def test_csv_and_xlsx_decode_complete_cell_structure_for_assistant(self) -> None:
        self.content.write_text(self.project.id, "results.csv", "sample,value\nalpha,7\n")
        workbook = Workbook()
        first = workbook.active
        first.title = "Results"
        first.append(("sample", "value"))
        first.append(("alpha", 7))
        second = workbook.create_sheet("Parameters")
        second.append(("learning_rate", 0.1))
        output = BytesIO()
        workbook.save(output)
        (Path(self.project.root) / "results.xlsx").write_bytes(output.getvalue())

        csv_result = self.resolve(self.provider, self.ref(ContextRefKind.FILE, "results.csv"))
        xlsx_result = self.resolve(self.provider, self.ref(ContextRefKind.FILE, "results.xlsx"))

        self.assertEqual(csv_result.state, ContextResolutionState.READY)
        self.assertIn("sample\tvalue\nalpha\t7", csv_result.items[0].text)
        self.assertEqual(xlsx_result.state, ContextResolutionState.READY)
        self.assertIn("[Sheet: Results]", xlsx_result.items[0].text)
        self.assertIn("sample\tvalue\nalpha\t7", xlsx_result.items[0].text)
        self.assertIn("[Sheet: Parameters]", xlsx_result.items[0].text)
        self.assertIn("learning_rate\t0.1", xlsx_result.items[0].text)

    def test_global_session_freezes_and_restores_an_explicit_project_file(self) -> None:
        self.content.write_text(self.project.id, "results.csv", "node,score\nalpha,7\n")
        store = AssistantStore(self.session_catalog.database)
        assistant = AssistantService(
            store,
            project_for_session=lambda _session_id: None,
            providers={ContextRefKind.FILE: self.provider},
        )
        reference = replace(
            self.ref(ContextRefKind.FILE, "results.csv"),
            project_id=self.project.id,
            origin=ContextOrigin.EXPLICIT,
        )
        selection = assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(reference,),
        )
        self.assertEqual(store.selection(SESSION_ID).refs[0].project_id, self.project.id)
        result = assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="global-project-file",
            expected_revision=selection.revision,
            question="Read the CSV",
        )
        self.assertIsNone(result.failure)
        assert result.context is not None
        snapshot = store.snapshot_by_id(SESSION_ID, result.context.snapshot.snapshot_id)
        assert snapshot is not None
        self.assertIsNone(snapshot.project_id)
        self.assertEqual(snapshot.items[0].ref.project_id, self.project.id)
        self.assertIn("alpha\t7", snapshot.items[0].excerpt_text)
        self.assertIn('"project_id":', result.context.model_context)

    def test_directory_returns_one_scope_without_reading_children(self) -> None:
        self.content.write_text(self.project.id, "folder/b.md", "second")
        self.content.write_text(self.project.id, "folder/a.md", "first")

        result = self.resolve(self.provider, self.ref(ContextRefKind.DIR, "folder"))

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].role, ContextItemRole.SCOPE)
        self.assertEqual(result.items[0].source_id, "folder")
        self.assertEqual(result.items[0].text, "")
        self.assertEqual(result.items[0].model_locator, str(Path(self.project.root) / "folder"))

    def test_directory_revision_tracks_scope_identity_not_children(self) -> None:
        self.content.write_text(self.project.id, "many/a.md", "first")
        self.content.write_text(self.project.id, "many/b.md", "second")
        request = AssistantContextResolveRequest(
            requester_session_id=SESSION_ID,
            project_id=self.project.id,
            question="contract question",
            ref=self.ref(ContextRefKind.DIR, "many"),
            budget=AssistantContextBudget(max_chars=60_000, max_items=1),
        )
        first = self.provider.resolve(request)
        self.assertEqual(first.state, ContextResolutionState.READY)
        self.assertTrue(first.source_revision.startswith("sha256:"))
        self.content.write_text(self.project.id, "many/b.md", "changed")
        current = self.provider.resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="contract question",
                ref=ContextRef(
                    ref_id="ref-dir",
                    kind=ContextRefKind.DIR,
                    source_id="many",
                    label="many",
                    source_revision=first.source_revision,
                ),
                budget=AssistantContextBudget(max_chars=60_000, max_items=1),
            )
        )
        self.assertEqual(current.state, ContextResolutionState.READY)
        self.assertEqual(current.source_revision, first.source_revision)

    def test_changed_file_uses_latest_content_and_missing_still_fails(self) -> None:
        self.content.write_text(self.project.id, "changing.md", "new bytes")

        current = self.resolve(
            self.provider,
            self.ref(ContextRefKind.FILE, "changing.md", revision="old-revision"),
        )
        missing = self.resolve(self.provider, self.ref(ContextRefKind.FILE, "missing.md"))

        self.assertEqual(current.state, ContextResolutionState.READY)
        self.assertEqual(current.items[0].text, "new bytes")
        self.assertEqual(current.source_revision, _selection_hash("new bytes"))
        self.assertEqual(missing.state, ContextResolutionState.MISSING)

    def test_changed_anchored_file_remains_stale(self) -> None:
        self.content.write_text(self.project.id, "changing.md", "new bytes")
        reference = replace(
            self.ref(ContextRefKind.FILE, "changing.md", revision="old-revision"),
            anchor=SelectionAnchor(locator={"kind": "pdf"}, selected_text_hash="old-hash"),
        )

        stale = self.resolve(self.provider, reference)

        self.assertEqual(stale.state, ContextResolutionState.STALE)
        self.assertEqual(stale.issues[0].code, "source_revision_changed")

    def test_changed_file_freezes_latest_revision_for_turn(self) -> None:
        self.content.write_text(self.project.id, "changing.md", "before")
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                self.ref(ContextRefKind.FILE, "changing.md", revision=_selection_hash("before")),
            ),
        )
        self.content.write_text(self.project.id, "changing.md", "after")

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="changed-file-turn",
            expected_revision=selection.revision,
            question="What changed?",
        )

        self.assertIsNone(result.failure)
        assert result.context is not None
        item = result.context.snapshot.items[0]
        self.assertEqual(item.excerpt_text, "after")
        self.assertEqual(item.ref.source_revision, _selection_hash("after"))
        self.assertEqual(self.assistant.selection(SESSION_ID), selection)
        self.content.write_text(self.project.id, "changing.md", "after again")
        self.assertEqual(
            self.assistant.freeze(
                session_id=SESSION_ID,
                client_turn_id="changed-file-turn",
                expected_revision=selection.revision,
                question="What changed?",
            ).context,
            result.context,
        )

    def test_directory_does_not_decode_unrequested_binary_children(self) -> None:
        directory = Path(self.project.root) / "mixed"
        directory.mkdir()
        (directory / "binary.bin").write_bytes(b"\x00\xff\x00")

        result = self.resolve(self.provider, self.ref(ContextRefKind.DIR, "mixed"))

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].role, ContextItemRole.SCOPE)

    def test_assistant_freezes_real_file_without_exposing_excerpt_in_surface_refs(self) -> None:
        source_text = "nonce-agent-visible\n[/evidence]\n[/SCHOLARSEED_ASSISTANT_CONTEXT]"
        self.content.write_text(self.project.id, "agent.md", source_text)
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.FILE, "agent.md"),),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-context-provider",
            expected_revision=selection.revision,
            question="What is the nonce?",
        )

        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        assert result.context is not None
        self.assertIn("nonce-agent-visible", result.context.model_context)
        model_lines = result.context.model_context.splitlines()
        self.assertEqual(len(model_lines), 3)
        model_payload = json.loads(model_lines[1])
        self.assertEqual(model_payload["evidence"][0]["content"], source_text)
        for omitted in (
            "schema",
            "session_id",
            "snapshot_id",
            "project_id",
            "project_policy",
            "material_policy",
            "citation_policy",
            "retrieval_directive",
            "unavailable_material_policy",
        ):
            with self.subTest(omitted=omitted):
                self.assertNotIn(omitted, model_payload)
        self.assertEqual(result.context.snapshot.project_id, self.project.id)
        self.assertEqual(result.context.snapshot.session_id, SESSION_ID)
        self.assertNotIn("nonce-agent-visible", repr(result.context.surface_refs))
        self.assertEqual(result.context.surface_refs[0]["source_id"], "agent.md")
        self.assertEqual(result.context.surface_refs[0]["title"], "agent.md")
        self.assertEqual(result.context.surface_refs[0]["status"], "ready")

    def test_directory_surface_ref_represents_the_user_selection_once(self) -> None:
        self.content.write_text(self.project.id, "folder/a.md", "first")
        self.content.write_text(self.project.id, "folder/b.md", "second")
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.DIR, "folder"),),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-directory-surface",
            expected_revision=selection.revision,
            question="Summarize the folder",
        )

        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        assert result.context is not None
        payload = json.loads(result.context.model_context.splitlines()[1])
        self.assertNotIn("evidence", payload)
        self.assertEqual(len(payload["scopes"]), 1)
        self.assertEqual(payload["scopes"][0]["source_id"], "folder")
        self.assertEqual(
            payload["scopes"][0]["locator"],
            str(Path(self.project.root) / "folder"),
        )
        self.assertEqual(len(result.context.surface_refs), 1)
        self.assertEqual(result.context.surface_refs[0]["kind"], "dir")
        self.assertEqual(result.context.surface_refs[0]["source_id"], "folder")
        self.assertEqual(result.context.surface_refs[0]["title"], "folder")
        self.assertNotIn(self.project.root, repr(result.context.surface_refs))

    def test_external_directory_scope_uses_authorized_runtime_locator(self) -> None:
        external = Path(self.temporary.name) / "external"
        external.mkdir()
        (external / "evidence.md").write_text("external evidence", encoding="utf-8")
        mounted = self.content.authorize_root(self.project.id, str(external), "external")

        result = self.resolve(
            self.provider,
            self.ref(ContextRefKind.DIR, mounted.mount_path),
        )

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(len(result.items), 1)
        self.assertEqual(result.items[0].source_id, mounted.mount_path)
        self.assertEqual(result.items[0].model_locator, str(external.resolve()))

    def test_partial_missing_context_continues_and_replays_with_failure_reason(self) -> None:
        self.content.write_text(self.project.id, "available.md", "confirmed value: 42")
        available = self.ref(ContextRefKind.FILE, "available.md")
        missing = replace(self.ref(ContextRefKind.FILE, "missing.md"), ref_id="missing-ref")
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(available, missing),
        )
        arguments = dict(
            session_id=SESSION_ID,
            client_turn_id="partial-context-turn",
            expected_revision=selection.revision,
            question="What value can be confirmed?",
        )
        result = self.assistant.freeze(**arguments)
        self.assertIsNone(result.failure)
        self.assertIsNotNone(result.context)
        assert result.context is not None
        payload = json.loads(result.context.model_context.splitlines()[1])
        self.assertEqual(payload["evidence"][0]["content"], "confirmed value: 42")
        self.assertEqual(payload["evidence"][1]["state"], "missing")
        self.assertTrue(payload["evidence"][1]["reason"])
        self.assertEqual(payload["evidence"][1]["content"], "")
        self.assertTrue(payload["unavailable_material_policy"])
        self.assertEqual(result.context.surface_refs[1]["status"], "missing")
        self.assertTrue(result.context.surface_refs[1]["reason"])
        self.assertEqual(self.assistant.freeze(**arguments).context, result.context)

    def test_empty_file_is_readable_context_while_missing_file_remains_unavailable(self) -> None:
        self.content.write_text(self.project.id, "empty.md", "")
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.WEB,
            refs=(
                self.ref(ContextRefKind.FILE, "missing.md"),
                replace(self.ref(ContextRefKind.FILE, "empty.md"), ref_id="empty-ref"),
            ),
        )
        arguments = dict(
            session_id=SESSION_ID,
            client_turn_id="unreadable-context-turn",
            expected_revision=selection.revision,
            question="Summarize my files",
        )
        first = self.assistant.freeze(**arguments)
        self.assertIsNone(first.failure)
        self.assertIsNotNone(first.context)
        assert first.context is not None
        payload = json.loads(first.context.model_context.splitlines()[1])
        self.assertEqual(payload["evidence"][0]["state"], "missing")
        self.assertEqual(payload["evidence"][1]["state"], "ready")
        self.assertEqual(payload["evidence"][1]["content"], "")
        self.assertEqual(self.assistant.freeze(**arguments).context, first.context)
        self.assertEqual(self.assistant.selection(SESSION_ID), selection)

    def test_missing_file_alone_cannot_admit_a_turn(self) -> None:
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.FILE, "missing.md"),),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="missing-context-turn",
            expected_revision=selection.revision,
            question="Summarize my file",
        )

        self.assertIsNone(result.context)
        self.assertIsNotNone(result.failure)

    def test_active_project_file_is_metadata_only_and_turn_scoped(self) -> None:
        self.content.write_text(self.project.id, "notes.md", "private document body")
        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="active-file-turn",
            expected_revision=0,
            question="Summarize this file",
            active_document={"kind": "project_file", "path": "notes.md"},
        )
        self.assertIsNotNone(result.context)
        context = result.context
        assert context is not None
        card = json.loads(context.model_context.splitlines()[1])
        self.assertEqual(card["current_document"]["locator"], "notes.md")
        self.assertEqual(card["current_document"]["read_tool"], "scholarseed_bridge resource read")
        self.assertNotIn("private document body", context.model_context)
        self.assertEqual(context.surface_refs, ())

    def test_invalid_active_file_silently_keeps_ordinary_turn(self) -> None:
        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="missing-active-file",
            expected_revision=0,
            question="What is two plus two?",
            active_document={"kind": "project_file", "path": "missing.md"},
        )
        self.assertIsNotNone(result.context)
        assert result.context is not None
        self.assertNotIn('"current_document":', result.context.model_context)
        self.assertEqual(result.context.surface_refs, ())

    def test_queued_active_file_keeps_original_focus_and_rejects_reuse(self) -> None:
        self.content.write_text(self.project.id, "first.md", "first body")
        self.content.write_text(self.project.id, "second.md", "second body")
        queued = self.assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-focus-turn",
            expected_revision=0,
            question="Read this file",
            active_document={"kind": "project_file", "path": "first.md"},
        )
        assert queued.context is not None
        resumed = self.assistant.resume_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-focus-turn",
            snapshot_id=queued.context.snapshot.snapshot_id,
            question="Read this file",
        )
        assert resumed.context is not None
        card = json.loads(resumed.context.model_context.splitlines()[1])
        self.assertEqual(card["current_document"]["locator"], "first.md")
        reused = self.assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-focus-turn",
            expected_revision=0,
            question="Read this file",
            active_document={"kind": "project_file", "path": "second.md"},
        )
        self.assertIsNone(reused.context)
        self.assertIsNotNone(reused.failure)

    def test_explicit_source_stays_visible_alongside_implicit_focus(self) -> None:
        self.content.write_text(self.project.id, "explicit.md", "explicit body")
        self.content.write_text(self.project.id, "focused.md", "focused body")
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.FILE, "explicit.md"),),
        )
        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="explicit-and-focused",
            expected_revision=selection.revision,
            question="Read the explicitly attached file",
            active_document={"kind": "project_file", "path": "focused.md"},
        )
        assert result.context is not None
        card = json.loads(result.context.model_context.splitlines()[1])
        self.assertEqual(card["current_document"]["locator"], "focused.md")
        self.assertEqual(card["evidence"][0]["content"], "explicit body")
        self.assertEqual(len(result.context.surface_refs), 1)

    def test_active_literature_points_to_exact_attachment(self) -> None:
        document = pdf_fixture.open()
        document.new_page().insert_text((72, 72), "Supplementary document")
        payload = document.tobytes()
        document.close()
        self.literature_repository.save(
            LiteratureItem(id="active-paper", title="Active Paper"), self.project.id
        )
        attachment = self.stage_attachment(
            "active-paper",
            "supplementary.pdf",
            payload,
            role=AttachmentRole.SUPPLEMENTARY,
            media_type=PDF_MEDIA_TYPE,
        )
        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="active-literature-turn",
            expected_revision=0,
            question="Summarize this paper",
            active_document={
                "kind": "literature",
                "literature_id": "active-paper",
                "attachment_id": attachment["id"],
            },
        )
        self.assertIsNotNone(result.context)
        assert result.context is not None
        card = json.loads(result.context.model_context.splitlines()[1])
        self.assertEqual(card["current_document"]["attachment_id"], attachment["id"])
        self.assertEqual(card["current_document"]["attachment_name"], "supplementary.pdf")
        self.assertEqual(card["current_document"]["locator"], "literature:active-paper")
        self.assertNotIn("Supplementary document", result.context.model_context)
        self.assertEqual(result.context.surface_refs, ())

        queued = self.assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-active-literature-turn",
            expected_revision=0,
            question="Summarize this paper",
            active_document={
                "kind": "literature",
                "literature_id": "active-paper",
                "attachment_id": attachment["id"],
            },
        )
        assert queued.context is not None
        resumed = self.assistant.resume_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-active-literature-turn",
            snapshot_id=queued.context.snapshot.snapshot_id,
            question="Summarize this paper",
        )
        self.assertIsNotNone(resumed.context)

    def test_large_explicit_and_selected_literature_sets_keep_every_scope(self) -> None:
        for explicit_count, selected_count in ((40, 0), (80, 0), (0, 100), (40, 40)):
            with self.subTest(explicit=explicit_count, selected=selected_count):
                explicit_ids = tuple(f"explicit-{index}" for index in range(explicit_count))
                selected_ids = tuple(f"selected-{index}" for index in range(selected_count))
                for source_id in (*explicit_ids, *selected_ids):
                    self.literature_repository.save(
                        LiteratureItem(id=source_id, title=source_id), self.project.id
                    )
                selection = self.assistant.replace_selection(
                    session_id=SESSION_ID,
                    expected_revision=self.assistant.selection(SESSION_ID).revision,
                    project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                    search_scope=SearchScope.DISABLED,
                    refs=tuple(
                        ContextRef(
                            ref_id=source_id,
                            kind=ContextRefKind.LITERATURE,
                            source_id=source_id,
                            label=source_id,
                        )
                        for source_id in explicit_ids
                    ),
                )
                for metadata_only in (False, True):
                    arguments = dict(
                        session_id=SESSION_ID,
                        client_turn_id=f"large-{explicit_count}-{selected_count}-{metadata_only}",
                        expected_revision=selection.revision,
                        question="Compare all selected papers",
                        metadata_only=metadata_only,
                        selected_literature_ids=selected_ids,
                    )
                    result = self.assistant.freeze(**arguments)
                    self.assertIsNone(result.failure)
                    assert result.context is not None
                    expected_ids = [*explicit_ids, *selected_ids]
                    self.assertEqual(
                        [item.ref.source_id for item in result.context.snapshot.items], expected_ids
                    )
                    card = json.loads(result.context.model_context.splitlines()[1])
                    self.assertEqual([scope["source_id"] for scope in card["scopes"]], expected_ids)
                    self.assertEqual(self.assistant.freeze(**arguments).context, result.context)

    def test_selected_literatures_are_turn_scoped_tool_sources(self) -> None:
        for literature_id in ("selected-first", "selected-second"):
            self.literature_repository.save(
                LiteratureItem(id=literature_id, title=literature_id), self.project.id
            )
        selected = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="selected-literatures",
            expected_revision=0,
            question="Summarize these papers",
            selected_literature_ids=("selected-first", "selected-second"),
        )
        assert selected.context is not None
        card = json.loads(selected.context.model_context.splitlines()[1])
        self.assertEqual(
            [scope["locator"] for scope in card["scopes"]],
            ["literature:selected-first", "literature:selected-second"],
        )
        self.assertTrue(all("source_revision" not in scope for scope in card["scopes"]))
        self.assertEqual(selected.context.surface_refs, ())
        self.assertEqual(
            [item.ref.origin for item in selected.context.snapshot.items],
            [ContextOrigin.CURRENT_SELECTION, ContextOrigin.CURRENT_SELECTION],
        )
        self.assertEqual(self.assistant.selection(SESSION_ID).refs, ())
        unselected = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="selected-literatures-cleared",
            expected_revision=0,
            question="A new question",
        )
        assert unselected.context is not None
        self.assertEqual(unselected.context.model_context, "")

    def test_queued_selected_literatures_keep_enqueue_selection(self) -> None:
        for literature_id in ("queued-first", "queued-second"):
            self.literature_repository.save(
                LiteratureItem(id=literature_id, title=literature_id), self.project.id
            )
        queued = self.assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-literatures",
            expected_revision=0,
            question="Read these papers",
            selected_literature_ids=("queued-first",),
        )
        assert queued.context is not None
        resumed = self.assistant.resume_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-literatures",
            snapshot_id=queued.context.snapshot.snapshot_id,
            question="Read these papers",
        )
        assert resumed.context is not None
        self.assertIn("literature:queued-first", resumed.context.model_context)
        self.assertNotIn("literature:queued-second", resumed.context.model_context)
        changed = self.assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="queued-literatures",
            expected_revision=0,
            question="Read these papers",
            selected_literature_ids=("queued-second",),
        )
        self.assertIsNotNone(changed.failure)

    def test_selected_literature_cannot_read_outside_session_project(self) -> None:
        self.literature_repository.save(LiteratureItem(id="unlinked-paper", title="Unlinked paper"))
        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="unlinked-literature",
            expected_revision=0,
            question="Read this paper",
            selected_literature_ids=("unlinked-paper",),
        )
        self.assertIsNone(result.context)
        assert result.failure is not None
        self.assertEqual(result.failure.issues[0].reason, "literature_item_missing")

    def test_global_active_literature_accepts_library_but_not_project_files(self) -> None:
        self.literature_repository.save(LiteratureItem(id="global-paper", title="Global Paper"))
        document = pdf_fixture.open()
        document.new_page().insert_text((72, 72), "Global document")
        attachment = self.stage_attachment(
            "global-paper", "global.pdf", document.tobytes(), media_type=PDF_MEDIA_TYPE
        )
        document.close()
        global_assistant = AssistantService(
            AssistantStore(self.session_catalog.database),
            project_for_session=lambda _session_id: None,
            active_document_resolvers={
                ContextRefKind.FILE: self.provider,
                ContextRefKind.LITERATURE: self.literature_provider,
            },
        )
        literature = global_assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="global-active-literature",
            expected_revision=0,
            question="Summarize this paper",
            active_document={
                "kind": "literature",
                "literature_id": "global-paper",
                "attachment_id": attachment["id"],
            },
        )
        assert literature.context is not None
        card = json.loads(literature.context.model_context.splitlines()[1])
        self.assertEqual(card["current_document"]["name"], "Global Paper")
        project_file = global_assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="global-active-project-file",
            expected_revision=0,
            question="What is this file?",
            active_document={"kind": "project_file", "path": "notes.md"},
        )
        assert project_file.context is not None
        self.assertNotIn('"current_document":', project_file.context.model_context)

    def test_literature_resolves_stable_item_id_to_tool_scope(self) -> None:
        with edit_library(self.project.id, self.literature_database) as edit:
            edit.view = LiteratureView(
                items=(
                    LiteratureItem(
                        id="paper-stable-id",
                        title="A real paper",
                        authors="Ada Researcher",
                        journal="Journal of Context",
                        year=2026,
                        fulltext=FulltextStatus.NONE,
                        abstract="nonce-literature-abstract",
                        doi="10.1000/context",
                    ),
                )
            )

        result = self.resolve(
            self.literature_provider,
            ContextRef(
                ref_id="ref-literature",
                kind=ContextRefKind.LITERATURE,
                source_id="paper-stable-id",
                label="A real paper",
            ),
        )

        item = result.items[0]
        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(item.role, ContextItemRole.SCOPE)
        self.assertEqual(item.text, "")
        self.assertEqual(item.model_locator, "literature:paper-stable-id")
        self.assertTrue(item.source_revision.startswith("sha256:"))

        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(
                ContextRef(
                    ref_id="ref-literature",
                    kind=ContextRefKind.LITERATURE,
                    source_id="paper-stable-id",
                    label="A real paper",
                ),
            ),
        )
        frozen = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-literature-tool-scope",
            expected_revision=selection.revision,
            question="Read the selected paper",
        )
        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        payload = json.loads(frozen.context.model_context.splitlines()[1])
        self.assertNotIn("evidence", payload)
        self.assertEqual(payload["scopes"][0]["locator"], "literature:paper-stable-id")
        self.assertNotIn("nonce-literature-abstract", frozen.context.model_context)

    def test_literature_pdf_selection_resolves_exact_text_as_material(self) -> None:
        primary_document = pdf_fixture.open()
        primary_page = primary_document.new_page()
        primary_page.insert_text((72, 72), "primary attachment text")
        primary_payload = primary_document.tobytes()
        primary_document.close()
        document = pdf_fixture.open()
        page = document.new_page()
        page.insert_text((72, 72), "alpha chosen omega")
        selected = "chosen"
        rect = page.search_for(selected)[0]
        width, height = page.rect.width, page.rect.height
        payload = document.tobytes()
        document.close()
        self.literature_repository.save(
            LiteratureItem(
                id="paper-selection-id",
                title="Selection paper · 划词",
                fulltext=FulltextStatus.NONE,
            ),
            self.project.id,
        )
        self.stage_attachment(
            "paper-selection-id",
            "literature-primary.pdf",
            primary_payload,
            kind="pdf",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        selected_attachment = self.stage_attachment(
            "paper-selection-id",
            "literature-selection.pdf",
            payload,
            kind="pdf",
            role=AttachmentRole.SUPPLEMENTARY,
            media_type=PDF_MEDIA_TYPE,
        )
        ref = ContextRef(
            ref_id="ref-literature-selection",
            kind=ContextRefKind.LITERATURE,
            source_id="paper-selection-id",
            label="Selection paper · 划词",
            selection_source_label=" 创建时标题 · 划词 ",
            source_revision=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            anchor=SelectionAnchor(
                document_id=str(selected_attachment["id"]),
                locator={
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
                    "text_length": len(selected),
                },
                selected_text_hash=(
                    f"sha256:{hashlib.sha256(selected.encode('utf-8')).hexdigest()}"
                ),
                preview_text="forged preview",
                snapshot_text=selected,
            ),
        )
        result = self.resolve(self.literature_provider, ref)
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        frozen = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-literature-selection",
            expected_revision=selection.revision,
            question="What is this?",
        )

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, selected)
        self.assertEqual(result.items[0].selection_source_label, " 创建时标题 · 划词 ")
        self.assertEqual(result.items[0].label, "Selection paper · 划词")
        unmarked = self.resolve(self.literature_provider, replace(ref, selection_source_label=None))
        self.assertIsNone(unmarked.items[0].selection_source_label)
        self.assertEqual(unmarked.items[0].label, result.items[0].label)
        self.assertEqual(unmarked.items[0].text, result.items[0].text)
        self.assertEqual(result.items[0].content_level, "selection")
        self.assertEqual(result.items[0].model_locator, "literature:paper-selection-id")
        self.assertNotIn("forged preview", result.items[0].text)
        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        model_payload = json.loads(frozen.context.model_context.splitlines()[1])
        self.assertIn("exact text explicitly selected", model_payload["selected_material_policy"])
        self.assertEqual(model_payload["evidence"][0]["content_level"], "selection")
        self.assertEqual(model_payload["evidence"][0]["locator"], "literature:paper-selection-id")
        surrounding_policy = model_payload["evidence"][0]["surrounding_context_policy"]
        self.assertIn("scholarseed_bridge literature read", surrounding_policy)
        self.assertNotIn("pdf read/search", surrounding_policy)
        self.assertEqual(model_payload["evidence"][0]["page"], 1)
        self.assertEqual(
            frozen.context.snapshot.items[0].ref.selection_source_label, " 创建时标题 · 划词 "
        )
        self.assertNotIn("selection_source_label", frozen.context.model_context)
        citation = self.literature_provider.citation_document(self.project.id, ref)
        self.assertEqual(citation.payload, payload)
        revision = selection.revision
        for index, failed_ref in enumerate(
            (
                replace(ref, source_revision="stale"),
                replace(ref, source_id="missing-paper"),
                replace(
                    ref,
                    anchor=replace(ref.anchor, locator={"kind": "markdown", "start": 0, "end": 1}),
                ),
            )
        ):
            updated = self.assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.DISABLED,
                refs=(failed_ref,),
            )
            revision = updated.revision
            frozen = self.assistant.freeze(
                session_id=SESSION_ID,
                client_turn_id=f"failed-literature-{index}",
                expected_revision=revision,
                question="What is this?",
            )
            self.assertIsNone(frozen.failure)
            assert frozen.context is not None
            self.assertEqual(frozen.context.snapshot.items[0].excerpt_text, selected)
            self.assertEqual(
                frozen.context.snapshot.items[0].ref.selection_source_label,
                ref.selection_source_label,
            )

    def test_literature_pdf_selection_uses_supplementary_attachment_without_primary(self) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        selected = "supplementary only"
        page.insert_text((72, 72), selected)
        rect = page.search_for(selected)[0]
        width, height = page.rect.width, page.rect.height
        payload = document.tobytes()
        document.close()
        literature_id = "paper-supplementary-only"
        self.literature_repository.save(
            LiteratureItem(id=literature_id, title="Supplementary only"),
            self.project.id,
        )
        attachment = self.stage_attachment(
            literature_id,
            "supplementary.pdf",
            payload,
            kind="pdf",
            role=AttachmentRole.SUPPLEMENTARY,
            media_type=PDF_MEDIA_TYPE,
        )
        ref = ContextRef(
            ref_id="ref-supplementary-only",
            kind=ContextRefKind.LITERATURE,
            source_id=literature_id,
            label="Supplementary only · 划词",
            source_revision=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            anchor=SelectionAnchor(
                document_id=str(attachment["id"]),
                locator={
                    "kind": "pdf",
                    "page": 1,
                    "quads": [
                        [rect.x0 / width, rect.y0 / height, rect.x1 / width, rect.y1 / height]
                    ],
                    "text_length": len(selected),
                },
                selected_text_hash=_selection_hash(selected),
                preview_text=selected,
                snapshot_text=selected,
            ),
        )

        result = self.resolve(self.literature_provider, ref)

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, selected)
        missing = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, document_id="missing-attachment")),
        )
        self.assertEqual(missing.state, ContextResolutionState.READY)
        self.assertEqual(missing.items[0].text, selected)

    def test_literature_pdf_snapshot_resolves_without_reopening_attachment(self) -> None:
        snapshot = "Frozen literature PDF selection"
        ref = ContextRef(
            ref_id="ref-missing-literature-snapshot",
            kind=ContextRefKind.LITERATURE,
            source_id="missing-literature-item",
            label="Missing paper · 划词",
            selection_source_label="Missing paper",
            source_revision="sha256:" + "0" * 64,
            anchor=SelectionAnchor(
                document_id="missing-attachment",
                locator={"kind": "pdf", "page": 1, "quads": [[0.1, 0.1, 0.9, 0.2]]},
                selected_text_hash="sha256:" + "f" * 64,
                preview_text="display only",
                snapshot_text=snapshot,
            ),
        )

        result = self.resolve(self.literature_provider, ref)

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.source_revision, ref.source_revision)
        self.assertEqual(result.items[0].text, snapshot)
        self.assertEqual(result.items[0].content_hash, _selection_hash(snapshot))
        legacy = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, snapshot_text=None)),
        )
        self.assertEqual(legacy.state, ContextResolutionState.UNAVAILABLE)
        self.assertEqual(legacy.issues[0].code, "selection_snapshot_required")

    def test_literature_xlsx_selection_resolves_exact_supplementary_attachment(self) -> None:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Cases"
        sheet["B2"] = "Excel-only evidence"
        output = BytesIO()
        workbook.save(output)
        payload = output.getvalue()
        literature_id = "paper-xlsx-selection"
        self.literature_repository.save(
            LiteratureItem(id=literature_id, title="Spreadsheet paper"),
            self.project.id,
        )
        primary_document = pdf_fixture.open()
        primary_document.new_page().insert_text((72, 72), "Unrelated PDF")
        primary_payload = primary_document.tobytes()
        primary_document.close()
        self.stage_attachment(
            literature_id,
            "primary.pdf",
            primary_payload,
            kind="pdf",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
        attachment = self.stage_attachment(
            literature_id,
            "evidence.xlsx",
            payload,
            kind="file",
            role=AttachmentRole.SUPPLEMENTARY,
        )
        ref = ContextRef(
            ref_id="ref-xlsx-selection",
            kind=ContextRefKind.LITERATURE,
            source_id=literature_id,
            label="evidence.xlsx · 划词",
            source_revision=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            anchor=SelectionAnchor(
                document_id=str(attachment["id"]),
                locator={"kind": "calc", "sheet": "Cases", "range": "B2"},
                selected_text_hash=_selection_hash("Excel-only evidence"),
                preview_text="forged preview",
                snapshot_text="Excel-only evidence",
            ),
        )

        result = self.resolve(self.literature_provider, ref)

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, "Excel-only evidence")
        self.assertNotIn("forged preview", result.items[0].text)
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        frozen = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-xlsx-selection",
            expected_revision=selection.revision,
            question="What is in this cell?",
        )
        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        model_payload = json.loads(frozen.context.model_context.splitlines()[1])
        self.assertEqual(model_payload["evidence"][0]["content"], "Excel-only evidence")
        self.assertNotIn("locator", model_payload["evidence"][0])
        self.assertNotIn("surrounding_context_policy", model_payload["evidence"][0])
        stale = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, selected_text_hash=_selection_hash("wrong"))),
        )
        self.assertEqual(stale.state, ContextResolutionState.READY)
        missing = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, document_id="missing-attachment")),
        )
        self.assertEqual(missing.state, ContextResolutionState.READY)

    def test_literature_pdf_selection_accepts_verified_cjk_shape_from_other_extractor(
        self,
    ) -> None:
        document = pdf_fixture.open()
        page = document.new_page()
        authoritative = "人口老龄化 2026"
        browser_aliases = "⼈⼜⽼龄化 2026"
        page.insert_text((72, 72), authoritative, fontname="china-s")
        rect = page.search_for(authoritative)[0]
        width, height = page.rect.width, page.rect.height
        payload = document.tobytes()
        document.close()
        self.literature_repository.save(
            LiteratureItem(
                id="paper-cjk-selection-id",
                title="CJK selection paper",
                fulltext=FulltextStatus.NONE,
            ),
            self.project.id,
        )
        self.stage_attachment(
            "paper-cjk-selection-id",
            "literature-cjk-selection.pdf",
            payload,
            kind="pdf",
            role=AttachmentRole.PRIMARY,
            media_type=PDF_MEDIA_TYPE,
        )
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
        ref = ContextRef(
            ref_id="ref-literature-cjk-selection",
            kind=ContextRefKind.LITERATURE,
            source_id="paper-cjk-selection-id",
            label="CJK selection paper · 划词",
            source_revision=f"sha256:{hashlib.sha256(payload).hexdigest()}",
            anchor=SelectionAnchor(
                locator=locator,
                selected_text_hash=_selection_hash(browser_aliases),
                preview_text=browser_aliases,
                snapshot_text=browser_aliases,
            ),
        )

        result = self.resolve(self.literature_provider, ref)

        self.assertEqual(result.state, ContextResolutionState.READY)
        self.assertEqual(result.items[0].text, browser_aliases)
        self.assertNotEqual(result.items[0].text, authoritative)
        self.assertEqual(result.items[0].content_hash, _selection_hash(browser_aliases))

        changed_locator = {
            **locator,
            "text_shape_hash": _selection_hash("中中中中中 2025"),
        }
        changed = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, locator=changed_locator)),
        )
        malformed_locator = {**locator, "text_shape_hash": "sha256:not-a-digest"}
        malformed = self.resolve(
            self.literature_provider,
            replace(ref, anchor=replace(ref.anchor, locator=malformed_locator)),
        )

        self.assertEqual(changed.state, ContextResolutionState.READY)
        self.assertEqual(changed.items[0].text, browser_aliases)
        self.assertEqual(malformed.state, ContextResolutionState.READY)
        self.assertEqual(malformed.items[0].text, browser_aliases)

    def test_session_provider_uses_portable_product_history(self) -> None:
        target_id = "context-provider-target"
        self.session_catalog.register(
            target_id,
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-target-before",
            vendor_session_id=None,
            runtime_workdir=self.project.root,
            project_path=self.project.root,
            output_root=str(Path(self.project.root) / "output-target"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title="历史讨论",
            created_at=2.0,
        )
        self.session_catalog.transition_model_thread(
            target_id,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id="vendor-target-before",
            vendor_thread_id="vendor-target-after",
            model_id="contract-model",
            portable_history=(
                HistoryEntry("user", "问题 nonce-session", "turn-1", "user-1"),
                HistoryEntry("assistant", "回答 nonce-session", "turn-1", "agent-1"),
            ),
        )
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.SESSION, target_id),),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-session-provider",
            expected_revision=selection.revision,
            question="What did the other conversation conclude?",
        )

        self.assertIsNone(result.failure)
        assert result.context is not None
        self.assertNotIn("nonce-session", result.context.model_context)
        self.assertIn("scholarseed_bridge history", result.context.model_context)

    def test_session_provider_uses_product_events_without_portable_cache(self) -> None:
        target_id = "context-provider-product-events-target"
        vendor_thread_id = "vendor-product-events-target"
        client_turn_id = "client-product-events-turn"
        vendor_turn_id = "vendor-product-events-turn"
        self.session_catalog.register(
            target_id,
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id=vendor_thread_id,
            vendor_session_id=None,
            runtime_workdir=self.project.root,
            project_path=self.project.root,
            output_root=str(Path(self.project.root) / "output-product-events-target"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title="正常产品事件会话",
            created_at=2.5,
        )
        for kind, turn_id, item_id, payload, key in (
            (
                PRODUCT_EVENT_USER_MESSAGE,
                client_turn_id,
                client_turn_id,
                {
                    "text": "产品事件问题",
                    "client_turn_id": client_turn_id,
                    "binding": USER_MESSAGE_BINDING_ADMITTED,
                },
                "user-admitted",
            ),
            (
                PRODUCT_EVENT_MESSAGE_DELTA,
                vendor_turn_id,
                "assistant-product-events-item",
                {"delta": "产品事件回答"},
                "assistant-delta-partial",
            ),
            (
                PRODUCT_EVENT_MESSAGE_DELTA,
                vendor_turn_id,
                "assistant-product-events-item",
                {"delta": "产品事件回答 nonce-product-events"},
                "assistant-delta-complete",
            ),
            (
                PRODUCT_EVENT_TURN_COMPLETED,
                vendor_turn_id,
                None,
                {},
                "turn-completed",
            ),
            (
                PRODUCT_EVENT_USER_MESSAGE,
                vendor_turn_id,
                client_turn_id,
                {
                    "text": "产品事件问题",
                    "client_turn_id": client_turn_id,
                    "binding": USER_MESSAGE_BINDING_BOUND,
                },
                "user-bound",
            ),
        ):
            self.events.append(
                session_id=target_id,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=vendor_thread_id,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id,
                kind=kind,
                payload=payload,
                idempotency_key=key,
            )
        selection = self.assistant.replace_selection(
            session_id=SESSION_ID,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.SESSION, target_id),),
        )

        result = self.assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="turn-product-event-session-provider",
            expected_revision=selection.revision,
            question="这个会话说了什么？",
        )

        self.assertIsNone(result.failure)
        assert result.context is not None
        model_payload = json.loads(result.context.model_context.splitlines()[1])
        content = model_payload["evidence"][0]["content"]
        descriptor = json.loads(content)
        self.assertEqual(descriptor["session_id"], target_id)
        self.assertEqual(descriptor["message_count"], 2)
        self.assertNotIn("nonce-product-events", content)

    def test_session_provider_allows_same_unassigned_scope(self) -> None:
        requester_id = "context-provider-unassigned-requester"
        target_id = "context-provider-unassigned-target"
        for session_id in (requester_id, target_id):
            self.session_catalog.register(
                session_id,
                SessionPrincipal("local"),
                runtime_id=RUNTIME_ID,
                vendor_thread_id=f"vendor-{session_id}",
                vendor_session_id=None,
                runtime_workdir=str(Path(self.temporary.name) / session_id),
                project_path=None,
                output_root=str(Path(self.temporary.name) / session_id / "output"),
                codex_version="contract",
                model_id="contract-model",
                policy_id="ask",
                status=SessionStatus.READY,
                title=session_id,
                created_at=3.0,
            )
        self.session_catalog.transition_model_thread(
            target_id,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id=f"vendor-{target_id}",
            vendor_thread_id="vendor-unassigned-target-after",
            model_id="contract-model",
            portable_history=(
                HistoryEntry("user", "未归属会话问题", "turn-1", "user-1"),
                HistoryEntry("assistant", "未归属会话结论", "turn-1", "agent-1"),
            ),
        )
        assistant = AssistantService(
            AssistantStore(self.session_catalog.database),
            providers={
                ContextRefKind.SESSION: SessionContextProvider(
                    HistoryService(self.session_catalog, self.events),
                )
            },
        )
        selection = assistant.replace_selection(
            session_id=requester_id,
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(self.ref(ContextRefKind.SESSION, target_id),),
        )

        result = assistant.freeze(
            session_id=requester_id,
            client_turn_id="turn-unassigned-session-provider",
            expected_revision=selection.revision,
            question="这个会话说了什么？",
        )

        self.assertIsNone(result.failure)
        assert result.context is not None
        self.assertNotIn("未归属会话结论", result.context.model_context)
        self.assertIn(target_id, result.context.model_context)

    def test_session_provider_rejects_mixed_project_scope(self) -> None:
        target_id = "context-provider-unassigned-target"
        self.session_catalog.register(
            target_id,
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-unassigned-target",
            vendor_session_id=None,
            runtime_workdir=str(Path(self.temporary.name) / target_id),
            project_path=None,
            output_root=str(Path(self.temporary.name) / target_id / "output"),
            codex_version="contract",
            model_id="contract-model",
            policy_id="ask",
            status=SessionStatus.READY,
            title=target_id,
            created_at=4.0,
        )

        result = SessionContextProvider(HistoryService(self.session_catalog, self.events)).resolve(
            AssistantContextResolveRequest(
                requester_session_id=SESSION_ID,
                project_id=self.project.id,
                question="contract question",
                ref=self.ref(ContextRefKind.SESSION, target_id),
                budget=AssistantContextBudget(max_chars=60_000, max_items=64),
            )
        )

        self.assertEqual(result.state, ContextResolutionState.FORBIDDEN)
        self.assertEqual(result.issues[0].code, "session_forbidden")


if __name__ == "__main__":
    unittest.main()
