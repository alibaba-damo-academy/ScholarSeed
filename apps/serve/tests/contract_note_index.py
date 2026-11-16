from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from service.literature.api.insights import register_insight_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE, LiteratureItem
from service.literature.service.indexing import index_note
from service.literature.service.insights import InsightMaterial, deliver, snapshot_pdf
from service.platform.activity import Activities
from service.platform.records import (
    POINT_COMMENT_STYLE,
    PdfRecordSnapshot,
    RecordOwner,
    RecordTarget,
)


class NoteIndexContract(unittest.TestCase):
    def setUp(self):
        self.pdf = b"frozen selected PDF"
        self.source = {
            "record_target": {
                "owner": "literature_attachment",
                "scope_id": "paper",
                "subject_id": "pdf",
            },
            "source_revision": "revision",
            "mark_id": "mark",
            "comment_id": None,
            "kind": "location",
            "page": 1,
            "text": "",
            "attachment_name": "paper.pdf",
        }
        self.comment = {
            **self.source,
            "comment_id": "comment",
            "kind": "user_comment",
            "text": "Question",
        }
        self.reading = {
            "document": {"sha256": hashlib.sha256(self.pdf).hexdigest()},
            "source_aliases": {"A001": "A00001", "A002": "A00002", "B001": "B00001"},
            "catalog": [
                {"id": "A00001", "kind": "embedded_mark", "record_ids": ["r1"], "page": 1},
                {"id": "A00002", "kind": "embedded_comment", "record_ids": ["r2"], "page": 1},
                {"id": "B00001", "kind": "paper_text", "line_ids": ["line"], "page": 1},
            ],
            "records": [
                {"id": "r1", "source_refs": [{"channel": "embedded_mark", "raw": {"id": "mark"}}]},
                {
                    "id": "r2",
                    "source_refs": [
                        {"channel": "embedded_comment", "raw": {"id": "comment", "mark_id": "mark"}}
                    ],
                },
            ],
            "lines": [{"id": "line", "text": "Paper evidence", "page": 1}],
        }

    def index(self, text):
        return index_note(text, self.reading, self.pdf, [self.source, self.comment])

    def test_exact_ids_many_to_many_and_unused_comments(self):
        text = "##### Title\n\nFirst. [[hint:reader_thought|A001,B001]]\n\nSecond. [A001]"
        result = self.index(text)
        self.assertEqual(result["status"], "indexed")
        self.assertEqual(len(result["paragraphs"]), 2)
        self.assertEqual(result["paragraphs"][0]["display_text"], "First.")
        self.assertEqual(result["paragraphs"][0]["sources"], [self.source])
        self.assertEqual(result["paragraphs"][0]["paper_sources"][0]["text"], "Paper evidence")
        self.assertEqual(result["unreferenced_sources"], [self.comment])
        self.assertEqual(result["note_sha256"], hashlib.sha256(text.encode()).hexdigest())

    def test_unknown_ids_do_not_reject_known_ids_or_other_paragraphs(self):
        result = self.index("# T\n\nKnown and unknown. [[mixed:A001,A999]]\n\nNo references.")
        self.assertEqual(result["unresolved_source_ids"], ["A999"])
        self.assertEqual(result["paragraphs"][0]["sources"], [self.source])
        self.assertIn("A999", result["paragraphs"][0]["display_text"])
        self.assertEqual(result["unreferenced_sources"], [self.comment])

    def test_windows_newlines_and_emphasis_keep_preview_formatting(self):
        for paragraph, expected in (
            ("Line one\r\nLine two [A001]", "Line one\nLine two"),
            ("**First [A001]**.", "**First**."),
            ("**[A001] First**.", "**First**."),
            ("**First [A001][A002]**.", "**First**."),
        ):
            result = self.index("# T\r\n\r\n" + paragraph)
            self.assertEqual(result["skipped_paragraphs"], 0)
            self.assertEqual(result["paragraphs"][0]["text"], paragraph)
            self.assertEqual(result["paragraphs"][0]["display_text"], expected)

    def test_markdown_literals_and_links_are_not_source_usage(self):
        result = self.index(
            "# T\n\n`[A001]` \\[A002] [A001](https://example.com).\n\n```\n[A002]\n```\n\nActual [A002]."
        )
        self.assertEqual(len(result["paragraphs"]), 1)
        self.assertEqual(result["paragraphs"][0]["sources"], [self.comment])
        self.assertEqual(result["unreferenced_sources"], [self.source])

    def test_document_binding_and_ambiguous_catalog_are_rejected(self):
        self.reading["document"]["sha256"] = "other"
        with self.assertRaises(ValueError):
            self.index("Body [A001]")

        self.reading["document"]["sha256"] = hashlib.sha256(self.pdf).hexdigest()
        self.reading["catalog"].append(self.reading["catalog"][0])
        with self.assertRaises(ValueError):
            self.index("Body [A001]")

    def test_delivery_keeps_text_if_index_fails_and_indexes_without_semantic_rejection(self):
        raw = b"##### T\n\nBody [[hint:reader_thought|A001]]"
        frozen = InsightMaterial(self.pdf, [self.source, self.comment])
        for reading in (b"{}", b"{bad", b"null"):
            _, text, provenance = deliver(None, None, raw, frozen, "en", reading)
            self.assertEqual(text.encode(), raw)
            self.assertEqual(provenance["status"], "unverified")
        _, text, provenance = deliver(
            None, None, raw, frozen, "en", json.dumps(self.reading).encode()
        )
        self.assertEqual(text.encode(), raw)
        self.assertEqual(provenance["status"], "indexed")

    def test_public_import_checks_document_and_note_version_and_persists_only_index(self):
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        stream = BytesIO()
        writer.write(stream)
        original_pdf = stream.getvalue()
        records = {
            "schema_version": 1,
            "marks": [
                {
                    "id": "mark",
                    "style": POINT_COMMENT_STYLE,
                    "page": 1,
                    "text": "",
                    "anchor_state": "anchored",
                }
            ],
            "comments": [{"id": "comment", "mark_id": "mark", "body": "Question"}],
            "notes": [],
        }
        self.reading["document"]["sha256"] = hashlib.sha256(
            snapshot_pdf(original_pdf, records)
        ).hexdigest()
        snapshot = PdfRecordSnapshot(
            RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", "pdf"),
            "records:one",
            "revision",
            "available",
            records,
        )
        with tempfile.TemporaryDirectory() as root:
            repository = LiteratureRepository(Path(root) / "literature.sqlite3")
            repository.save(LiteratureItem(id="paper", title="Paper"))
            note = repository.create_note("paper", "Body [[reader_thought:A001]]", "T")
            attachments = SimpleNamespace(
                read_attachment=lambda *args, **kwargs: (original_pdf, PDF_MEDIA_TYPE, "revision"),
                attachment=lambda *args, **kwargs: SimpleNamespace(name="paper.pdf"),
            )
            app = FastAPI()
            with (
                patch(
                    "service.literature.api.insights.AttachmentRecords",
                    return_value=SimpleNamespace(peek_target=lambda target: snapshot),
                ),
                patch.object(
                    repository,
                    "attachments",
                    return_value=[{"id": "pdf", "media_type": PDF_MEDIA_TYPE}],
                ),
            ):
                register_insight_routes(
                    app,
                    repository=repository,
                    attachments=attachments,
                    invocations=None,
                    models=None,
                    activities=Activities(),
                )
                with TestClient(app) as client:
                    route = f"/api/v1/literatures/paper/notes/{note.id}/index"
                    payload = {"version": note.version, "reading": self.reading}
                    self.reading["document"]["sha256"] = "different document"
                    self.assertEqual(client.post(route, json=payload).status_code, 422)
                    self.assertIsNone(repository.notes("paper")[0].provenance)
                    self.reading["document"]["sha256"] = hashlib.sha256(
                        snapshot_pdf(original_pdf, records)
                    ).hexdigest()
                    response = client.post(route, json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["text"], note.text)
                    self.assertEqual(response.json()["version"], note.version + 1)
                    self.assertEqual(client.post(route, json=payload).status_code, 409)
                    self.assertEqual(
                        client.post(route, json={"reading": {}, "version": True}).status_code, 422
                    )
            reopened = LiteratureRepository(Path(root) / "literature.sqlite3").notes("paper")[0]
            self.assertEqual(reopened.text, note.text)
            self.assertEqual(reopened.provenance["status"], "indexed")


if __name__ == "__main__":
    unittest.main()
