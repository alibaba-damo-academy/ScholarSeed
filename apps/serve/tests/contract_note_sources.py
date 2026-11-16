from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from apps.serve.tests import pdf as pdf_fixture
from service.content.domain.model import ContentError
from service.literature.api.reading import register_reading_routes
from service.literature.persistence import files as literature_files
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import LiteratureRepository, read
from service.literature.schema import PDF_MEDIA_TYPE, LiteratureItem
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.records import AttachmentRecords
from service.literature.service.sources import NoteSources, validate_source_group
from service.platform.records import PdfRecordSnapshot, RecordOwner, RecordTarget


class NoteSourcesContract(unittest.TestCase):
    def setUp(self) -> None:
        self.target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", "attachment")
        self.mark = {
            "id": "mark",
            "style": "highlight",
            "page": 2,
            "text": "Original source",
            "anchor_state": "anchored",
        }
        self.comments = [
            {"id": "comment-one", "mark_id": "mark", "body": "User observation one"},
            {"id": "comment-two", "mark_id": "mark", "body": "User observation two"},
        ]
        self.snapshot = PdfRecordSnapshot(
            self.target,
            "records:one",
            "sha256:document",
            "available",
            {"schema_version": 1, "marks": [self.mark], "comments": self.comments, "notes": []},
            "",
        )
        self.reads = []

        def read(target):
            self.reads.append(target)
            if target != self.target:
                raise ContentError("record_source_unavailable")
            return self.snapshot

        attachment = SimpleNamespace(id="attachment", media_type=PDF_MEDIA_TYPE, name="paper.pdf")
        self.item = SimpleNamespace(attachments=(attachment,))
        self.service = NoteSources(
            SimpleNamespace(
                get=lambda item_id, **_options: self.item if item_id == "paper" else None,
                attachments=lambda _item_id, **_options: [vars(attachment)],
            ),
            SimpleNamespace(peek_target=read),
        )

    def test_candidates_keep_text_and_each_comment_distinct(self) -> None:
        result = self.service.candidates("paper")
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(
            [item["kind"] for item in result["items"]], ["text", "user_comment", "user_comment"]
        )
        self.assertEqual(
            [item["comment_id"] for item in result["items"]], [None, "comment-one", "comment-two"]
        )
        self.assertTrue(
            all(item["record_target"] == self.target.response() for item in result["items"])
        )

    def test_point_comments_never_become_original_text(self) -> None:
        self.mark.update(style="comment", text="", point=[0.4, 0.5])
        result = self.service.candidates("paper")
        self.assertEqual(len(result["items"]), 3)
        self.assertEqual(result["items"][0]["kind"], "location")
        self.assertEqual(result["items"][0]["text"], "")
        self.assertTrue(all(item["kind"] == "user_comment" for item in result["items"][1:]))
        resolved = self.service.resolve("paper", {"version": 1, "sources": result["items"]})
        self.assertTrue(all(item["state"] == "available" for item in resolved["items"]))

    def test_exact_resolution_beyond_candidate_limit_only_projects_requested_source(self) -> None:
        self.comments[:] = [
            {"id": f"comment-{index}", "mark_id": "mark", "body": f"Comment {index}"}
            for index in range(1001)
        ]
        candidates = self.service.candidates("paper")
        self.assertEqual(len(candidates["items"]), 1000)
        self.assertEqual(candidates["omitted_count"], 2)
        source = {**candidates["items"][1], "comment_id": "comment-1000", "text": "Comment 1000"}
        with patch(
            "service.literature.service.sources.validate_source_group", wraps=validate_source_group
        ) as validation:
            result = self.service.resolve("paper", {"version": 1, "sources": [source]})
        self.assertEqual(result["items"][0]["state"], "available")
        self.assertEqual(validation.call_count, 2)

    def test_resolution_rechecks_revision_identity_and_exact_comment(self) -> None:
        sources = self.service.candidates("paper")["items"]
        group = {"version": 1, "sources": sources}
        self.assertTrue(
            all(
                item["state"] == "available"
                for item in self.service.resolve("paper", group)["items"]
            )
        )
        self.comments.pop()
        resolved = self.service.resolve("paper", group)["items"]
        self.assertEqual(
            [item["state"] for item in resolved], ["available", "available", "unavailable"]
        )
        self.assertEqual(resolved[-1]["source"]["text"], "User observation two")
        forged = {**sources[0], "record_target": {**self.target.response(), "scope_id": "other"}}
        self.assertEqual(
            self.service.resolve("paper", {"version": 1, "sources": [forged]})["items"][0]["state"],
            "unavailable",
        )
        self.assertTrue(all(target.scope_id == "paper" for target in self.reads))

    def test_changed_snapshot_and_stale_mark_are_not_navigable(self) -> None:
        source = self.service.candidates("paper")["items"][0]
        self.mark["text"] = "Changed text"
        result = self.service.resolve("paper", {"version": 1, "sources": [source]})
        self.assertEqual(result["items"][0]["state"], "changed")
        self.mark["anchor_state"] = "stale"
        self.assertEqual(
            self.service.resolve("paper", {"version": 1, "sources": [source]})["items"][0]["state"],
            "unavailable",
        )

    def test_payload_boundaries_reject_malformed_or_unbounded_sources(self) -> None:
        source = self.service.candidates("paper")["items"][0]
        invalid = [
            {"version": 1, "sources": [{**source, "kind": []}]},
            {"version": 1, "sources": [{**source, "kind": {}}]},
            {"version": 2, "sources": [source]},
            {"version": True, "sources": [source]},
            {"version": 1, "sources": []},
            {"version": 1, "sources": [source] * 101},
            {"version": 1, "sources": [{**source, "page": True}]},
            {"version": 1, "sources": [{**source, "kind": "html"}]},
            {"version": 1, "sources": [{**source, "text": "x" * 16385}]},
            {"version": 1, "sources": [{**source, "unexpected": "field"}]},
        ]
        for payload in invalid:
            with self.subTest(payload=str(payload)[:70]), self.assertRaises(ValueError):
                validate_source_group(payload)

    def test_real_owned_attachment_reads_do_not_create_or_mutate_records(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = root / "files"
            files.mkdir()
            with pdf_fixture.open() as document:
                document.new_page()
                records = {
                    "schema_version": 1,
                    "marks": [
                        {
                            **self.mark,
                            "page": 1,
                            "color": "yellow",
                            "quads": [[0.1, 0.1, 0.3, 0.2]],
                            "created_at": 1.0,
                            "updated_at": 1.0,
                        }
                    ],
                    "comments": [{**comment, "created_at": 1.0} for comment in self.comments],
                    "notes": [],
                }
                document.embfile_add("scholarseed-annotations.json", json.dumps(records).encode())
                payload = document.tobytes()
            with patch.object(literature_files, "SERVICE_LITERATURE_FILES_DIR", files):
                repository = LiteratureRepository(root / "literature.sqlite3")
                repository.save(LiteratureItem(id="paper", title="Paper"))
                published = literature_files.managed_object("paper", payload, ".pdf")
                path = files / published.name
                path.write_bytes(payload)
                attachment = repository.add_attachment(
                    "paper",
                    "paper.pdf",
                    str(path),
                    revision=published.revision,
                    media_type=PDF_MEDIA_TYPE,
                )
                attachments = LiteratureAttachmentContent(repository)
                app = FastAPI()
                register_reading_routes(app, repository, attachments, None, None)
                client = TestClient(app)
                route = "/api/v1/literatures/paper/note-sources"
                with read(repository.database) as connection:
                    before = list(connection.iterdump())
                    self.assertIsNone(
                        connection.execute(
                            "SELECT name FROM sqlite_master WHERE name='literature_attachment_records'"
                        ).fetchone()
                    )
                candidates = client.get(route)
                self.assertEqual(candidates.status_code, 200, candidates.text)
                sources = candidates.json()["items"]
                self.assertTrue(sources)
                response = client.post(route + "/resolve", json={"version": 1, "sources": sources})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(
                    all(item["state"] == "available" for item in response.json()["items"])
                )
                with read(repository.database) as connection:
                    self.assertEqual(before, list(connection.iterdump()))
                self.assertEqual(
                    client.post(route + "/resolve", content=b"broken").status_code, 422
                )
                self.assertEqual(
                    client.get("/api/v1/literatures/missing/note-sources").status_code, 404
                )
                target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", attachment["id"])
                snapshot = AttachmentRecords(attachments, repository).snapshot_target(target)
                with read(repository.database) as connection:
                    materialized = list(connection.iterdump())
                self.assertEqual(
                    client.post(
                        route + "/resolve", json={"version": 1, "sources": sources}
                    ).status_code,
                    200,
                )
                with read(repository.database) as connection:
                    self.assertEqual(materialized, list(connection.iterdump()))
                self.assertEqual(
                    AttachmentRecordCatalog(repository.database)
                    .peek(target, snapshot.source_revision)
                    .record_revision,
                    snapshot.record_revision,
                )
                self.assertEqual(path.read_bytes(), payload)


def run() -> None:
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(NoteSourcesContract)
    )
    if not result.wasSuccessful():
        raise AssertionError("note source contracts failed")


if __name__ == "__main__":
    run()
