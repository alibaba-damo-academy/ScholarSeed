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
from pypdf import PdfReader, PdfWriter

from service.inference.transport import thinking_for
from service.literature.api.insights import register_insight_routes
from service.literature.schema import LiteratureNote
from service.literature.service.insights import (
    InsightMaterial,
    InsightRequest,
    command,
    deliver,
    failure_detail,
    material,
    result,
    select_records,
    snapshot_pdf,
)
from service.platform.activity import Activities
from service.platform.inference import (
    ModelInvocationLimits,
    ModelInvocationRequest,
)
from service.platform.pdf import PDF_ANNOTATIONS_ATTACHMENT
from service.platform.records import PdfRecordSnapshot, RecordOwner, RecordTarget


class InsightMaterialContract(unittest.TestCase):
    def test_failure_detail_rejects_free_text_and_supports_both_languages(self):
        data = {
            "error": "runtime_failed",
            "diagnostic": {
                "phase": "activation.attach",
                "exception_types": ["PermissionError", "private credential"],
                "errno": 13,
                "winerror": 5,
                "rpc_code": True,
                "message": "private credential",
                "path": r"C:\Users\private\cache",
            },
        }
        for language, message in (("en", "Access to"), ("zh", "访问所需资源")):
            detail = failure_detail(data, phase="invocation.execute", language=language)
            payload = json.loads(detail)
            self.assertEqual(payload["phase"], "activation.attach")
            self.assertEqual(payload["exception_types"], ["PermissionError"])
            self.assertEqual(payload["winerror"], 5)
            self.assertNotIn("rpc_code", payload)
            self.assertIn(message, payload["reason"])
            self.assertNotIn("private", detail)
        detail = failure_detail(
            {"error": "private credential", "diagnostic": {"phase": "private credential"}},
            phase="invocation.execute",
            language="en",
        )
        self.assertNotIn("private", detail)
        self.assertIn("without a more specific diagnostic", detail)

    def test_text_first_keeps_raw_markers_when_provenance_is_missing_or_invalid(self):
        raw = b"##### Original\n\nKeep this. [[hint:reader_thought|A048]]\n"
        frozen = InsightMaterial(b"pdf", [])
        for mapping in (
            None,
            b"{broken",
            b"{}",
            b'{"schema_version":2,"document":[]}',
            b'{"schema_version":2,"document":{},"note":[]}',
        ):
            title, body, metadata = deliver(b"other note", mapping, raw, frozen, "en")
            self.assertEqual(title, "Original")
            self.assertEqual(body, raw.decode())
            self.assertEqual(metadata, {"version": 1, "paragraphs": [], "status": "unverified"})
        with self.assertRaises(ValueError):
            deliver(None, None, b" ", frozen, "en")
        with self.assertRaises(ValueError):
            deliver(None, None, None, frozen, "en")

    def test_note_writer_disables_declared_thinking(self):
        compiled = command(self.request, "exact:model")
        request = ModelInvocationRequest(
            invocation_id="writer",
            owner_id="owner",
            project_id="",
            purpose="session_generation",
            model_key=compiled.model_id,
            instructions="Write a note",
            input_text="Body and marks",
            limits=ModelInvocationLimits(1000, None),
            reasoning_effort=compiled.execution.reasoning_effort or "",
            reasoning_policy=compiled.execution.generation_reasoning_policy,
        )
        controls = thinking_for(
            request,
            {
                "wire_api": "chat_completions",
                "provider": "qwen",
                "reasoning_options": [
                    {
                        "kind": "effort",
                        "values": ["low", "medium", "xhigh"],
                        "wire": {"chat_completions": "reasoning_effort"},
                    },
                    {"kind": "toggle", "wire": {"chat_completions": "enable_thinking"}},
                ],
            },
        )
        self.assertEqual(controls.parameters, {"enable_thinking": False})

    def test_clean_note_keeps_many_to_many_provenance_separate(self):
        note = b"#### Note\n\nFirst paragraph.\n\nSecond paragraph.\n"
        sources = [
            {
                "record_target": {
                    "owner": "literature_attachment",
                    "scope_id": "paper",
                    "subject_id": "pdf",
                },
                "source_revision": "sha256:one",
                "mark_id": mark,
                "comment_id": None,
                "kind": "text",
                "page": 1,
                "text": mark,
                "attachment_name": "paper.pdf",
            }
            for mark in ("one", "two", "unreferenced")
        ]
        frozen = InsightMaterial(b"pdf", sources)
        mapping = {
            "schema_version": 2,
            "note": {"sha256": hashlib.sha256(note).hexdigest()},
            "document": {"sha256": hashlib.sha256(frozen.pdf).hexdigest()},
            "paragraphs": [
                {
                    "paragraph_id": pid,
                    "source_ids": ids,
                    "markdown_lines": {"start": line, "end": line},
                    "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                }
                for pid, ids, line, text in (
                    ("p01", ["A001", "A002"], 3, "First paragraph."),
                    ("p02", ["A002"], 5, "Second paragraph."),
                )
            ],
            "entries": [
                {"id": sid, "record_ids": [rid]} for sid, rid in (("A001", "r1"), ("A002", "r2"))
            ],
            "records": [
                {"id": rid, "source_refs": [{"channel": "embedded_mark", "raw": {"id": mark}}]}
                for rid, mark in (("r1", "one"), ("r2", "two"))
            ],
        }
        title, body, provenance = result(note, json.dumps(mapping).encode(), frozen, "en")
        self.assertEqual((title, body), ("Note", note.decode()))
        self.assertEqual(
            [p["text"] for p in provenance["paragraphs"]], ["First paragraph.", "Second paragraph."]
        )
        self.assertEqual(
            [[s["mark_id"] for s in p["sources"]] for p in provenance["paragraphs"]],
            [["one", "two"], ["two"]],
        )
        self.assertEqual(provenance["unreferenced_sources"], [sources[2]])
        paper_only = {
            **mapping,
            "entries": [{"id": "B001", "record_ids": []}],
            "paragraphs": [{**p, "source_ids": ["B001"]} for p in mapping["paragraphs"]],
        }
        with self.assertRaisesRegex(ValueError, "insight_sources_missing"):
            result(note, json.dumps(paper_only).encode(), frozen, "en")
        # A valid selection can contain more reading signals than selected marks.
        for index in range(101):
            source = {**sources[0], "mark_id": f"extra-{index}"}
            sources.append(source)
            sid, rid = f"A{index + 3:03d}", f"extra-record-{index}"
            mapping["entries"].append({"id": sid, "record_ids": [rid]})
            mapping["records"].append(
                {
                    "id": rid,
                    "source_refs": [{"channel": "embedded_mark", "raw": {"id": source["mark_id"]}}],
                }
            )
            mapping["paragraphs"][0]["source_ids"].append(sid)
        _, _, expanded = result(note, json.dumps(mapping).encode(), frozen, "en")
        self.assertEqual(len(expanded["paragraphs"][0]["sources"]), 103)
        mapping["paragraphs"][0]["markdown_lines"]["start"] = 5
        with self.assertRaises(ValueError):
            result(note, json.dumps(mapping).encode(), frozen, "en")

    def test_generation_uses_selected_model_without_network_or_search(self):
        compiled = command(self.request, "exact:model")
        self.assertEqual(compiled.model_id, "exact:model")
        self.assertFalse(compiled.execution.web_search)
        self.assertFalse(compiled.execution.network_access)
        self.assertEqual(compiled.skill.id, "builtin:highlights-to-insights")

    def test_note_import_requires_matching_accepted_note_and_document_hashes(self):
        note = b"#### Test note\n\nA reading insight.\n"
        frozen = InsightMaterial(b"frozen selected pdf", [])
        mapping = {
            "schema_version": 2,
            "note": {"sha256": hashlib.sha256(note).hexdigest()},
            "document": {"sha256": hashlib.sha256(frozen.pdf).hexdigest()},
        }
        title, body, provenance = result(note, json.dumps(mapping).encode(), frozen, "en")
        self.assertEqual(title, "Test note")
        self.assertEqual(body, note.decode())
        with self.assertRaises(ValueError):
            result(note + b"changed", json.dumps(mapping).encode(), frozen, "en")
        with self.assertRaises(ValueError):
            result(note, json.dumps(mapping).encode(), InsightMaterial(b"other PDF", []), "en")

    def setUp(self):
        self.snapshot = PdfRecordSnapshot(
            RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", "pdf"),
            "records:one",
            "sha256:one",
            "available",
            {
                "schema_version": 1,
                "marks": [
                    {"id": "chosen", "style": "comment", "anchor_state": "anchored"},
                    {"id": "excluded", "style": "highlight", "anchor_state": "anchored"},
                ],
                "comments": [
                    {"id": "thought", "mark_id": "chosen", "body": "Keep this thought"},
                    {"id": "secret", "mark_id": "excluded", "body": "Not selected"},
                ],
                "notes": [{"text": "Not selected either"}],
            },
        )
        self.request = InsightRequest(
            attachment_id="pdf",
            source_revision="sha256:one",
            record_revision="records:one",
            mark_ids=["chosen"],
            model_key="configured-model",
            language="zh",
        )

    def test_selection_keeps_point_comment_but_excludes_other_material(self):
        records = select_records(self.snapshot, self.request)
        self.assertEqual([mark["id"] for mark in records["marks"]], ["chosen"])
        self.assertEqual([comment["id"] for comment in records["comments"]], ["thought"])
        self.assertEqual(records["notes"], [])

    def test_frozen_sources_keep_location_identity_separate_from_comment(self):
        self.snapshot.records["marks"][0].update(page=1, text="")
        with patch("service.literature.service.insights.snapshot_pdf", return_value=b"pdf"):
            frozen = material(self.snapshot, self.request, b"pdf", "paper.pdf")
        self.assertEqual(
            [(s["mark_id"], s["comment_id"], s["kind"]) for s in frozen.sources],
            [("chosen", None, "location"), ("chosen", "thought", "user_comment")],
        )

    def test_revision_stale_missing_and_duplicate_choices_fail_closed(self):
        for override in (
            {"record_revision": "old"},
            {"source_revision": "old"},
            {"mark_ids": ["missing"]},
            {"mark_ids": ["chosen", "chosen"]},
        ):
            with self.subTest(patch=override), self.assertRaises(ValueError):
                select_records(self.snapshot, self.request.model_copy(update=override))
        self.snapshot.records["marks"][0]["anchor_state"] = "stale"
        with self.assertRaises(ValueError):
            select_records(self.snapshot, self.request)

    def test_pdf_snapshot_replaces_embedded_records_and_leaves_original_unchanged(self):
        original = PdfWriter()
        original.add_blank_page(width=200, height=300)
        original.add_attachment(PDF_ANNOTATIONS_ATTACHMENT, json.dumps(self.snapshot.records))
        original.add_attachment("unselected.txt", b"Not selected")
        stream = BytesIO()
        original.write(stream)
        payload = stream.getvalue()
        selected = select_records(self.snapshot, self.request)
        frozen = PdfReader(BytesIO(snapshot_pdf(payload, selected)))
        self.assertEqual(set(frozen.attachments), {PDF_ANNOTATIONS_ATTACHMENT})
        self.assertEqual(json.loads(frozen.attachments[PDF_ANNOTATIONS_ATTACHMENT][0]), selected)
        self.assertIn("unselected.txt", PdfReader(BytesIO(payload)).attachments)


class InsightRouteContract(unittest.TestCase):
    def test_only_successful_validated_deliverable_creates_a_new_note(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            writes = []
            commands = []
            settled = []
            mode = "success"
            frozen = InsightMaterial(b"selected input", [])
            note = b"#### Generated\n\nEvidence based note.\n"
            mapping = json.dumps(
                {
                    "schema_version": 2,
                    "note": {"sha256": hashlib.sha256(note).hexdigest()},
                    "document": {"sha256": hashlib.sha256(frozen.pdf).hexdigest()},
                }
            ).encode()

            async def prepare(command, *, input_files, **identity):
                self.assertEqual(input_files, {"selected.pdf": frozen.pdf})
                commands.append((command, identity))
                workspace = root / str(len(commands))
                workspace.mkdir()
                return SimpleNamespace(
                    record=SimpleNamespace(invocation_id="run", workspace=str(workspace))
                )

            async def stream(_prepared):
                yield {
                    "type": "generation_preview",
                    "data": {
                        "preview_id": "writer",
                        "revision": 1,
                        "status": "streaming",
                        "verified": False,
                        "blocks": [{"id": "/markdown", "kind": "paragraph", "text": "Draft"}],
                    },
                }
                yield {"type": "content.delta", "data": {"text": "Orchestration only"}}
                if mode in ("failure", "interrupted", "unknown"):
                    yield {
                        "type": "invocation.failed" if mode == "failure" else f"invocation.{mode}",
                        "data": {
                            "error": "upstream",
                            "diagnostic": {
                                "phase": "activation.attach",
                                "exception_types": ["PermissionError"],
                                "errno": 13,
                                "winerror": 5,
                                "message": "private credential",
                            },
                        },
                    }
                    settled.append(mode)
                    return
                if mode == "missing":
                    yield {"type": "result.completed", "data": {"text": "Preparation failed"}}
                    settled.append(mode)
                    return
                names = ("note.raw.md",) if mode == "text" else ("note.md", "source-map.json")
                if mode == "invalid_with_raw":
                    names += ("note.raw.md",)
                if mode in ("large_index", "unreadable_index", "duplicate_index"):
                    names = ("note.raw.md", "reading.json")
                    if mode == "duplicate_index":
                        names += ("reading.json",)
                for name in names:
                    yield {
                        "type": "artifact.published",
                        "data": {"artifact_id": name, "relative_path": f"final/{name}"},
                    }
                yield {"type": "result.completed", "data": {}}
                settled.append(mode)

            async def artifact(_invocation_id, artifact_id, **identity):
                if artifact_id == "reading.json":
                    if mode == "unreadable_index":
                        raise OSError("unreadable index")
                    return SimpleNamespace(size_bytes=5 * 1024 * 1024), BytesIO(b"index")
                payload = (
                    note
                    if artifact_id in ("note.md", "note.raw.md")
                    else (b"{}" if mode in ("invalid", "invalid_with_raw") else mapping)
                )
                return SimpleNamespace(size_bytes=len(payload)), BytesIO(payload)

            def create_note(item_id, body, title, *, provenance):
                self.assertEqual(settled[-1:], [mode])
                writes.append((item_id, body, title))
                return LiteratureNote(id="new-note", text=body, title=title)

            app = FastAPI()
            app.state.ownership_axis = "machine"
            target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", "pdf")
            snapshot = PdfRecordSnapshot(target, "records:one", "sha256:one", "available", {})
            with (
                patch(
                    "service.literature.api.insights.AttachmentRecords",
                    return_value=SimpleNamespace(peek_target=lambda _target: snapshot),
                ),
                patch("service.literature.api.insights.material", return_value=frozen),
            ):
                register_insight_routes(
                    app,
                    repository=SimpleNamespace(create_note=create_note),
                    attachments=SimpleNamespace(
                        read_attachment=lambda *_args, **_kwargs: (
                            b"original",
                            "application/pdf",
                            "sha256:one",
                        ),
                        attachment=lambda *_args, **_kwargs: SimpleNamespace(name="paper.pdf"),
                    ),
                    invocations=SimpleNamespace(prepare=prepare, stream=stream, artifact=artifact),
                    models=SimpleNamespace(selected_model_key=lambda key, **_kwargs: key),
                    activities=Activities(),
                )
                with TestClient(app) as client:
                    request = {
                        "attachment_id": "pdf",
                        "source_revision": "sha256:one",
                        "record_revision": "records:one",
                        "mark_ids": ["selected"],
                        "model_key": "chosen:model",
                        "language": "en",
                    }
                    response = client.post("/api/v1/literatures/paper/notes/generate", json=request)
                    self.assertEqual(response.status_code, 200)
                    self.assertIn('"new-note"', response.text)
                    self.assertIn('"generation_preview"', response.text)
                    self.assertLess(
                        response.text.index('"Draft"'), response.text.index('"new-note"')
                    )
                    self.assertNotIn("Orchestration only", response.text)
                    self.assertEqual(len(writes), 1)
                    self.assertEqual(commands[0][0].model_id, "chosen:model")
                    for mode in ("failure", "interrupted", "unknown", "invalid", "missing"):
                        with self.subTest(mode=mode):
                            response = client.post(
                                "/api/v1/literatures/paper/notes/generate", json=request
                            )
                            self.assertIn('"error"', response.text)
                            self.assertIn('"generation_preview"', response.text)
                            self.assertEqual(len(writes), 1)
                            self.assertEqual(settled[-1], mode)
                            self.assertIn('"invocation_id":"run"', response.text)
                            self.assertNotIn("private", response.text)
                            if mode in ("failure", "interrupted", "unknown"):
                                events = [
                                    json.loads(line.removeprefix("data: "))
                                    for line in response.text.splitlines()
                                    if line.startswith("data: ")
                                ]
                                detail = json.loads(events[-1]["detail"])
                                self.assertEqual(detail["phase"], "activation.attach")
                                self.assertEqual(detail["error_code"], "upstream")
                                self.assertEqual(detail["winerror"], 5)
                            if mode == "missing":
                                self.assertIn("insight.deliver", response.text)
                                self.assertNotIn("Preparation failed", response.text)
                    for mode in (
                        "text",
                        "invalid_with_raw",
                        "large_index",
                        "unreadable_index",
                        "duplicate_index",
                    ):
                        response = client.post(
                            "/api/v1/literatures/paper/notes/generate", json=request
                        )
                        self.assertIn('"new-note"', response.text)
                        self.assertEqual(writes[-1][1], note.decode())
                    self.assertEqual(len(writes), 6)


if __name__ == "__main__":
    unittest.main()
