"""Fast PDF-to-TXT materialization contracts."""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.api.citations import register_citation_bridge
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.service.publication import SessionArtifactStorage
from service.cli.bridge import parser
from service.content.domain.model import ContentError
from service.content.persistence.catalog import ContentCatalog
from service.content.service import assets
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.bridge import (
    PDF_MATERIALIZE_OPERATION,
    PDF_REQUESTS,
    PDF_ROUTE_PREFIX,
    PdfMaterialize,
)
from service.platform.citations import CitationDocument
from service.platform.content import ArtifactScope, ArtifactScopeKind
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.workbench.service.materialize import PAGE_SEPARATOR, PdfMaterializer


def pdf_bytes(*pages: str) -> bytes:
    with pdf_fixture.open() as document:
        for text in pages:
            page = document.new_page()
            if text:
                page.insert_text((72, 72), text)
        return document.tobytes()


class PdfMaterializeContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.activities = Activities()
        catalog = ContentCatalog(self.root / "content.sqlite3")
        self.registry = ProjectRegistry(str(self.root), catalog)
        self.content = ContentService(self.registry, catalog, activities=self.activities)
        self.sessions = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.sessions.register(
            "session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            codex_version="contract",
            model_id="contract",
            policy_id="workspace-write",
            status=SessionStatus.RUNNING,
            title="materialize",
            created_at=1.0,
        )
        self.content.bind_artifact_scope(
            ArtifactScopeKind.SESSION,
            SessionArtifactStorage(self.sessions, self.root / "runtime").resolve,
        )
        self.materializer = PdfMaterializer(self.content)

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def document(payload: bytes) -> CitationDocument:
        return CitationDocument("project", "paper.pdf", "Paper", "sha256:paper", payload)

    def test_unregistered_session_cannot_publish(self) -> None:
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        with self.assertRaises(ValueError):
            self.materializer.materialize(document, "unknown-session", "unknown.txt")
        self.assertFalse((self.root / "unknown.txt").exists())

    def test_content_rejects_drive_and_stream_target_names(self) -> None:
        for path in ("C:/escape.txt", "paper.txt:stream"):
            with self.subTest(path=path):
                with self.assertRaises(ContentError):
                    self.content.publish_working_bytes(
                        ArtifactScope(ArtifactScopeKind.SESSION, "session"), path, b"text"
                    )

    def test_sealed_content_admission_rejects_publication(self) -> None:
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        generation = self.activities.begin()
        self.assertTrue(self.activities.seal(generation))
        with self.assertRaises(MaintenanceActive):
            self.materializer.materialize(document, "session", "blocked.txt")
        self.assertFalse((self.root / "blocked.txt").exists())

    def test_failed_publication_removes_staging_and_preserves_existing_target(self) -> None:
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        with patch.object(assets, "publish_descriptor", side_effect=OSError("publication failed")):
            with self.assertRaisesRegex(OSError, "publication failed"):
                self.materializer.materialize(document, "session", "failed.txt")
        self.assertFalse((self.root / "failed.txt").exists())
        self.assertEqual(list(self.root.glob(".create-*")), [])
        self.assertEqual(self.activities.snapshot().counts, {})

    def test_project_publication_notifies_changes_under_resource_activity(self) -> None:
        project = self.registry.seed_workspace()
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        observed = []
        original = self.content._wrote

        def record(project_id, *paths):
            observed.append((project_id, paths, self.activities.snapshot().counts))
            original(project_id, *paths)

        with patch.object(self.content, "_wrote", side_effect=record):
            self.materializer.materialize(document, "session", "paper.txt")
        self.assertEqual(
            observed, [(project.id, ("paper.txt",), {ActivityDomain.RESOURCE.value: 1})]
        )
        self.assertEqual(self.activities.snapshot().counts, {})

    def test_publication_rejects_directory_alias(self) -> None:
        outside = self.root / "outside"
        outside.mkdir()
        alias = self.root / "linked"
        if os.name == "nt":
            subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(alias), str(outside)],
                check=True,
                capture_output=True,
            )
        else:
            alias.symlink_to(outside, target_is_directory=True)
        try:
            document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
            with self.assertRaises(OSError):
                self.materializer.materialize(document, "session", "linked/paper.txt")
            self.assertEqual(list(outside.iterdir()), [])
        finally:
            if os.name == "nt":
                alias.rmdir()
            else:
                alias.unlink()

    def test_contract_and_cli_expose_a_separate_materialize_operation(self) -> None:
        request = PdfMaterialize.model_validate(
            {"ref_id": "literature:paper", "target": "materials/paper.txt"}
        )
        self.assertEqual(request.path, "")
        self.assertIs(PDF_REQUESTS[PDF_MATERIALIZE_OPERATION], PdfMaterialize)
        command = parser().parse_args(
            [
                "pdf",
                "materialize",
                "--json",
                '{"ref_id":"literature:paper","target":"materials/paper.txt"}',
            ]
        )
        self.assertEqual((command.capability, command.operation), ("pdf", "materialize"))
        with self.assertRaises(ValidationError):
            PdfMaterialize.model_validate(
                {"ref_id": "literature:paper", "target": "paper.txt", "workers": 8}
            )

    def test_materializes_utf8_pages_and_reuses_identical_output(self) -> None:
        document = self.document(pdf_bytes("First page text for materialization.", "第二页文本。"))
        first = self.materializer.materialize(document, "session", "materials/paper.txt")
        text = (self.root / "materials/paper.txt").read_text(encoding="utf-8")
        self.assertEqual(first["page_count"], 2)
        self.assertIn(PAGE_SEPARATOR, text)
        self.assertTrue(text.endswith("\n"))
        self.assertFalse(first["reused"])
        second = self.materializer.materialize(document, "session", "materials/paper.txt")
        self.assertTrue(second["reused"])
        self.assertEqual(second["digest"], first["digest"])

    def test_rejects_conflicts_unsafe_targets_and_missing_text_layers(self) -> None:
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        (self.root / "paper.txt").write_text("different", encoding="utf-8")
        for target, error in (
            ("paper.txt", "pdf_materialize_target_conflict"),
            ("../paper.txt", "pdf_materialize_target_invalid"),
            ("C:/paper.txt", "pdf_materialize_target_invalid"),
            ("materials:stream/paper.txt", "pdf_materialize_target_invalid"),
            ("paper.pdf", "pdf_materialize_target_invalid"),
        ):
            with self.subTest(target=target):
                with self.assertRaisesRegex(ValueError, error):
                    self.materializer.materialize(document, "session", target)
        with self.assertRaisesRegex(ValueError, "pdf_materialize_text_layer_missing"):
            self.materializer.materialize(self.document(pdf_bytes("")), "session", "empty.txt")
        with self.assertRaisesRegex(ValueError, "pdf_materialize_invalid_pdf"):
            self.materializer.materialize(self.document(b"not a pdf"), "session", "bad.txt")

    def test_http_route_resolves_authorized_document_and_writes_workdir_artifact(self) -> None:
        live = SimpleNamespace(
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            active_task_type="",
            runtime_workdir=self.root,
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        document = self.document(pdf_bytes("Bridge materialized source text."))
        citations = SimpleNamespace(
            document=Mock(return_value=SimpleNamespace(document=document)),
            commit_read=Mock(side_effect=AssertionError("materialization is not a citation read")),
        )
        app = FastAPI()
        activities = self.activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_citation_bridge(
            app, sessions, citations, activities=activities, materializer=self.materializer
        )
        headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }
        with TestClient(app) as client:
            response = client.post(
                PDF_ROUTE_PREFIX + PDF_MATERIALIZE_OPERATION,
                json={"ref_id": "literature:paper", "target": "raw/paper.txt"},
                headers=headers,
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["ref_id"], "literature:paper")
        self.assertTrue((self.root / "raw/paper.txt").is_file())
        citations.document.assert_called_once()
        live.publish.assert_awaited_once()

    def test_http_route_does_not_publish_after_active_scope_changes(self) -> None:
        live = SimpleNamespace(
            id="session",
            bridge_token="token",
            active_assistant_snapshot_id="snapshot",
            active_task_type="",
            runtime_workdir=self.root,
            ledger=SimpleNamespace(active_turn_id="turn"),
            publish=AsyncMock(),
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        document = self.document(pdf_bytes("Bridge materialized source text."))
        citations = SimpleNamespace(
            document=Mock(return_value=SimpleNamespace(document=document)),
            commit_read=Mock(),
        )
        materializer = Mock()

        def change_turn(_document):
            live.ledger.active_turn_id = "next-turn"
            return SimpleNamespace(payload=b"text", revision="revision", page_count=1)

        materializer.prepare.side_effect = change_turn
        app = FastAPI()
        activities = self.activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_citation_bridge(
            app, sessions, citations, activities=activities, materializer=materializer
        )
        headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }
        with TestClient(app) as client:
            response = client.post(
                PDF_ROUTE_PREFIX + PDF_MATERIALIZE_OPERATION,
                json={"ref_id": "literature:paper", "target": "raw/paper.txt"},
                headers=headers,
            )
        self.assertEqual(response.status_code, 403, response.text)
        materializer.publish.assert_not_called()
        self.assertFalse((self.root / "raw/paper.txt").exists())


if __name__ == "__main__":
    unittest.main()
