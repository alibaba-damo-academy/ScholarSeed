"""Fast PDF-to-TXT materialization contracts."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from apps.serve.tests import pdf as pdf_fixture
from service.assistant.api.citations import register_citation_bridge
from service.cli.bridge import parser
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    PDF_MATERIALIZE_OPERATION,
    PDF_REQUESTS,
    PDF_ROUTE_PREFIX,
    PdfMaterialize,
)
from service.platform.citations import CitationDocument
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
        self.root = Path(self.temp.name)
        self.materializer = PdfMaterializer()

    def tearDown(self) -> None:
        self.temp.cleanup()

    @staticmethod
    def document(payload: bytes) -> CitationDocument:
        return CitationDocument("project", "paper.pdf", "Paper", "sha256:paper", payload)

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
        first = self.materializer.materialize(document, self.root, "materials/paper.txt")
        text = (self.root / "materials/paper.txt").read_text(encoding="utf-8")
        self.assertEqual(first["page_count"], 2)
        self.assertIn(PAGE_SEPARATOR, text)
        self.assertTrue(text.endswith("\n"))
        self.assertFalse(first["reused"])
        second = self.materializer.materialize(document, self.root, "materials/paper.txt")
        self.assertTrue(second["reused"])
        self.assertEqual(second["digest"], first["digest"])

    def test_rejects_conflicts_unsafe_targets_and_missing_text_layers(self) -> None:
        document = self.document(pdf_bytes("Enough text for a valid PDF text layer."))
        (self.root / "paper.txt").write_text("different", encoding="utf-8")
        for target, error in (
            ("paper.txt", "pdf_materialize_target_conflict"),
            ("../paper.txt", "pdf_materialize_target_invalid"),
            ("paper.pdf", "pdf_materialize_target_invalid"),
        ):
            with self.subTest(target=target):
                with self.assertRaisesRegex(ValueError, error):
                    self.materializer.materialize(document, self.root, target)
        with self.assertRaisesRegex(ValueError, "pdf_materialize_text_layer_missing"):
            self.materializer.materialize(self.document(pdf_bytes("")), self.root, "empty.txt")
        with self.assertRaisesRegex(ValueError, "pdf_materialize_invalid_pdf"):
            self.materializer.materialize(self.document(b"not a pdf"), self.root, "bad.txt")

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
        register_citation_bridge(app, sessions, citations, materializer=self.materializer)
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
        register_citation_bridge(app, sessions, citations, materializer=materializer)
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
