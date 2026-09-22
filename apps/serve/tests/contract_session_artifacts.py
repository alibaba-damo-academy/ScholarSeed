"""Contract for structured, session-isolated artifact attribution."""

from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook

from scholarseed_runtime.contract.artifact import ArtifactRole
from service.chat.persistence.artifacts import (
    ArtifactSource,
    ArtifactStatus,
    SessionArtifactStore,
    artifact_identity,
    current_artifact_records,
    product_artifact_id,
)
from service.chat.persistence.catalog import (
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.service.artifacts import (
    ARTIFACT_EDIT_UNAVAILABLE,
    ARTIFACT_INTEGRITY_MISMATCH,
    ARTIFACT_NOT_FOUND,
    ARTIFACT_PATH_FORBIDDEN,
    ARTIFACT_REVISION_CONFLICT,
    ArtifactReadError,
    ArtifactService,
)
from service.chat.service.attachments import AttachmentService
from service.chat.service.publication import (
    PublicationCommand,
    PublicationService,
    SessionArtifactStorage,
)
from service.content.persistence.catalog import ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.content import ArtifactScopeKind
from service.workbench.domain.model import WorkbenchFormatPolicy

SESSION_ID = "product-a"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "thread-a"
OWNER = SessionPrincipal("artifact-owner")


class SessionArtifactContract(unittest.TestCase):
    def test_sent_pdf_keeps_original_attachment_after_rebinding(self) -> None:
        before = self.catalog.get(SESSION_ID)
        attachments = Path(before.runtime_workdir).resolve() / "attachments"
        attachments.mkdir()
        pdf = attachments / "source.pdf"
        pdf.write_bytes(b"%PDF original attachment")
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="pdf-turn",
            vendor_item_id=None,
            kind="user_message",
            payload={
                "refs": [
                    {
                        "id": "pdf",
                        "type": "file",
                        "path": str(pdf),
                        "sha256": sha256(pdf.read_bytes()).hexdigest(),
                    }
                ]
            },
            idempotency_key="pdf-message",
        )
        with self.events.transaction() as connection:
            self.events.bind_workspace(before, initial=True, connection=connection)
            moved = self.catalog.relocate(
                SESSION_ID,
                OWNER,
                runtime_workdir=str(self.root / "new"),
                project_path=str(self.root),
                output_root=str(self.root / "new"),
                connection=connection,
            )
            self.events.bind_workspace(moved, connection=connection)
        reader = AttachmentService(self.catalog, self.events)
        self.assertEqual(reader.source_path(SESSION_ID, "pdf"), str(pdf))
        self.assertEqual(
            reader.pdf_document(SESSION_ID, "pdf-turn", "pdf").payload, pdf.read_bytes()
        )

    def test_rebinding_preserves_original_file_instead_of_new_same_name(self) -> None:
        source = self.root / SESSION_ID / "outputs" / "report.md"
        source.write_text("original", encoding="utf-8")
        artifact = self.index()
        before = self.catalog.get(SESSION_ID)
        target = self.root / "second-project"
        (target / "outputs").mkdir(parents=True)
        (target / "outputs" / "report.md").write_text("wrong source", encoding="utf-8")
        with self.events.transaction() as connection:
            self.events.bind_workspace(before, initial=True, connection=connection)
            moved = self.catalog.relocate(
                SESSION_ID,
                OWNER,
                runtime_workdir=str(target),
                project_path=str(target),
                output_root=str(target),
                connection=connection,
            )
            self.events.bind_workspace(moved, connection=connection)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        self.assertEqual(
            reader.read_text(SESSION_ID, artifact_identity(artifact))["content"], "original"
        )
        source.unlink()
        with self.assertRaises(ArtifactReadError):
            reader.read_text(SESSION_ID, artifact_identity(artifact))

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="session-artifacts-")
        self.root = Path(self._temporary.name)
        self.database = self.root / "sessions.sqlite3"
        (self.root / SESSION_ID / "outputs").mkdir(parents=True)
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            SESSION_ID,
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id="process-a",
            runtime_workdir=str(self.root / SESSION_ID),
            project_path=None,
            output_root=str(self.root / SESSION_ID / "outputs"),
            codex_version="0.42.0",
            model_id="gpt-5-codex",
            policy_id="workspace-write",
            status=SessionStatus.RUNNING,
            title="",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.database)
        self.event = self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-a",
            vendor_item_id="item-a",
            kind="tool_completed",
            payload={"type": "fileChange", "status": "completed"},
            idempotency_key="file-event-a",
            created_at=2.0,
        )
        self.artifacts = SessionArtifactStore(self.database)

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def index(
        self,
        *,
        key: str = "artifact-a",
        original_path: str = "outputs/report.md",
        canonical_path: str | None = None,
        content_sha256: str = "abc123",
        size_bytes: int = 128,
        mime_type: str = "text/markdown",
        source_kind: ArtifactSource = ArtifactSource.FILE_CHANGE,
        connection=None,
        source_product_seq: int | None = None,
        saved_to: str | None = None,
    ):
        path = canonical_path or str(self.root / SESSION_ID / original_path)
        return self.artifacts.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-a",
            vendor_item_id="item-a",
            source_kind=source_kind,
            source_product_seq=source_product_seq or self.event.product_seq,
            original_path=original_path,
            canonical_path=path,
            role="report",
            status=(
                ArtifactStatus.PUBLISHED
                if source_kind is ArtifactSource.ARTIFACT_PUBLISH
                else ArtifactStatus.COMPLETED
            ),
            mime_type=mime_type,
            content_sha256=content_sha256,
            size_bytes=size_bytes,
            metadata={"label": "实验报告"},
            idempotency_key=key,
            saved_to=saved_to,
            created_at=3.0,
            connection=connection,
        )

    def test_event_index_and_cursor_share_commit_or_rollback(self) -> None:
        baseline = self.catalog.get(SESSION_ID).last_product_seq
        for fail in (True, False):
            try:
                with self.events.transaction() as connection:
                    event = self.events.append(
                        session_id=SESSION_ID,
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id=VENDOR_THREAD_ID,
                        vendor_turn_id="turn-a",
                        vendor_item_id="item-a",
                        kind="artifact_published",
                        payload={"path": "outputs/report.md"},
                        idempotency_key="publication",
                        connection=connection,
                    )
                    self.index(connection=connection, source_product_seq=event.product_seq)
                    self.events.append(
                        session_id=SESSION_ID,
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id=VENDOR_THREAD_ID,
                        vendor_turn_id="turn-a",
                        vendor_item_id="item-a",
                        kind="artifact_changed",
                        payload={"op": "upsert"},
                        idempotency_key="publication-card",
                        connection=connection,
                    )
                    if fail:
                        raise RuntimeError("contract crash before commit")
            except RuntimeError:
                if not fail:
                    raise
            if fail:
                self.assertEqual(self.catalog.get(SESSION_ID).last_product_seq, baseline)
                self.assertEqual(self.artifacts.list_session(SESSION_ID), ())
                self.assertEqual(self.events.replay(SESSION_ID, after_seq=baseline), ())
            else:
                self.assertEqual(self.catalog.get(SESSION_ID).last_product_seq, baseline + 2)
                self.assertEqual(len(self.artifacts.list_session(SESSION_ID)), 1)
                self.assertEqual(len(self.events.replay(SESSION_ID, after_seq=baseline)), 2)

    def test_cross_database_transaction_is_rejected(self) -> None:
        other = ProductEventStore(self.root / "other.sqlite3")
        with other.transaction() as connection:
            with self.assertRaises(ValueError):
                self.index(connection=connection)

    def test_structured_artifact_is_durable_and_idempotent(self) -> None:
        first = self.index()
        repeated = self.index()

        self.assertEqual(first, repeated)
        reopened = SessionArtifactStore(self.database).list_session(SESSION_ID)
        self.assertEqual(reopened, (first,))
        self.assertEqual(first.vendor_turn_id, "turn-a")
        self.assertEqual(first.vendor_item_id, "item-a")
        self.assertEqual(first.source_product_seq, self.event.product_seq)

    def test_file_change_markdown_can_be_saved_with_revision_guard(self) -> None:
        source = self.root / SESSION_ID / "outputs" / "report.md"
        source.write_text("before", encoding="utf-8")
        artifact = self.index(content_sha256=sha256(source.read_bytes()).hexdigest())
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        revision = f"sha256:{sha256(source.read_bytes()).hexdigest()}"

        receipt = reader.write_raw(SESSION_ID, artifact_identity(artifact), b"after", revision)

        self.assertEqual(source.read_text(encoding="utf-8"), "after")
        self.assertEqual(receipt.revision, f"sha256:{sha256(b'after').hexdigest()}")
        self.assertEqual(
            tuple(event.kind for event in receipt.events),
            ("file_changed", "artifact_changed"),
        )
        working_head = current_artifact_records(self.artifacts.list_session(SESSION_ID))[0]
        self.assertEqual(working_head.content_sha256, sha256(b"after").hexdigest())
        content, media_type, editable, current_revision = reader.read_document(
            SESSION_ID, artifact_identity(artifact)
        )
        self.assertEqual(content, b"after")
        self.assertEqual(media_type, "text/markdown")
        self.assertTrue(editable)
        self.assertEqual(current_revision, receipt.revision)
        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_REVISION_CONFLICT):
            reader.write_raw(SESSION_ID, artifact_identity(artifact), b"stale", revision)

    def test_file_change_text_and_code_formats_can_be_saved(self) -> None:
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        cases = (
            ("plain-text", "outputs/notes.txt", "text/plain", b"before text", b"after text"),
            (
                "python-code",
                "outputs/script.py",
                "text/x-python",
                b"print('before')\n",
                b"print('after')\n",
            ),
        )

        for key, original_path, mime_type, before, after in cases:
            with self.subTest(original_path=original_path):
                target = self.root / SESSION_ID / original_path
                target.write_bytes(before)
                artifact = self.index(
                    key=key,
                    original_path=original_path,
                    content_sha256=sha256(before).hexdigest(),
                    size_bytes=len(before),
                    mime_type=mime_type,
                )
                artifact_id = artifact_identity(artifact)

                self.assertTrue(reader.editable(SESSION_ID, artifact_id))
                receipt = reader.write_raw(
                    SESSION_ID,
                    artifact_id,
                    after,
                    f"sha256:{sha256(before).hexdigest()}",
                )

                self.assertEqual(target.read_bytes(), after)
                self.assertEqual(receipt.revision, f"sha256:{sha256(after).hexdigest()}")

    def test_file_change_safe_spreadsheet_can_be_saved(self) -> None:
        def workbook_bytes(value: str) -> bytes:
            workbook = Workbook()
            workbook.active["A1"] = value
            output = BytesIO()
            workbook.save(output)
            workbook.close()
            return output.getvalue()

        before = workbook_bytes("before")
        after = workbook_bytes("after")
        original_path = "outputs/data.xlsx"
        target = self.root / SESSION_ID / original_path
        target.write_bytes(before)
        artifact = self.index(
            key="safe-spreadsheet",
            original_path=original_path,
            content_sha256=sha256(before).hexdigest(),
            size_bytes=len(before),
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        artifact_id = artifact_identity(artifact)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())

        self.assertTrue(reader.editable(SESSION_ID, artifact_id))
        reader.write_raw(
            SESSION_ID,
            artifact_id,
            after,
            f"sha256:{sha256(before).hexdigest()}",
        )

        self.assertEqual(target.read_bytes(), after)

    def test_file_change_rejects_unsafe_spreadsheet_replacement(self) -> None:
        workbook = Workbook()
        workbook.active["A1"] = "safe"
        output = BytesIO()
        workbook.save(output)
        workbook.close()
        before = output.getvalue()
        original_path = "outputs/data.xlsx"
        target = self.root / SESSION_ID / original_path
        target.write_bytes(before)
        artifact = self.index(
            key="unsafe-spreadsheet-replacement",
            original_path=original_path,
            content_sha256=sha256(before).hexdigest(),
            size_bytes=len(before),
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())

        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_EDIT_UNAVAILABLE):
            reader.write_raw(
                SESSION_ID,
                artifact_identity(artifact),
                b"not a spreadsheet",
                f"sha256:{sha256(before).hexdigest()}",
            )

        self.assertEqual(target.read_bytes(), before)

    def test_publication_without_verified_content_cannot_be_edited(self) -> None:
        artifact = self.index(source_kind=ArtifactSource.ARTIFACT_PUBLISH)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())

        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_NOT_FOUND):
            reader.write_raw(
                SESSION_ID,
                artifact_identity(artifact),
                b"changed",
                "sha256:baseline",
            )

    def test_published_document_draft_is_durable_and_snapshot_is_immutable(self) -> None:
        content_catalog = ContentCatalog(self.root / "content.sqlite3")
        content = ContentService(ProjectRegistry(str(self.root), content_catalog), content_catalog)
        content.bind_artifact_scope(
            ArtifactScopeKind.SESSION, SessionArtifactStorage(self.catalog, self.root).resolve
        )
        publications = PublicationService(content)

        def workbook_bytes(value: str) -> bytes:
            workbook = Workbook()
            workbook.active["A1"] = value
            output = BytesIO()
            workbook.save(output)
            workbook.close()
            return output.getvalue()

        cases = (
            ("report.md", b"original = 1\n", b"edited = 2\n"),
            ("notes.txt", b"original = 1\n", b"edited = 2\n"),
            ("script.py", b"original = 1\n", b"edited = 2\n"),
            ("table.xlsx", workbook_bytes("original"), workbook_bytes("edited")),
        )
        for filename, original, changed in cases:
            with self.subTest(filename=filename):
                (self.root / SESSION_ID / filename).write_bytes(original)
                publication = publications.publish(
                    PublicationCommand(
                        "", SESSION_ID, "turn-a", filename, filename, ArtifactRole.FINAL, filename
                    ),
                    provenance={},
                )
                payload, _events = publications.project(
                    publication, self.catalog.get(SESSION_ID), self.events, self.artifacts
                )
                artifact_id = payload["artifact_id"]
                reader = ArtifactService(
                    self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy()
                )
                reader.bind_content(content)
                raw, _media, editable, revision = reader.read_document(SESSION_ID, artifact_id)
                self.assertTrue(editable)
                self.assertEqual(raw, original)
                receipt = reader.write_raw(SESSION_ID, artifact_id, changed, revision)
                with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_REVISION_CONFLICT):
                    reader.write_raw(SESSION_ID, artifact_id, original, revision)
                reader = ArtifactService(
                    self.catalog,
                    SessionArtifactStore(self.database),
                    self.events,
                    WorkbenchFormatPolicy(),
                )
                reader.bind_content(content)
                self.assertEqual(reader.read_document(SESSION_ID, artifact_id)[0], changed)
                self.assertEqual(reader.export_bytes(SESSION_ID, artifact_id)[0], original)
                self.assertEqual(
                    reader.export_document_bytes(
                        SESSION_ID, artifact_id, sha256(changed).hexdigest()
                    )[0],
                    changed,
                )
                self.assertEqual(content.read_artifact(publication.content), original)
                reader.write_raw(SESSION_ID, artifact_id, original, receipt.revision)

    def test_working_changes_never_replace_or_delete_publications(self) -> None:
        published = replace(self.index(source_kind=ArtifactSource.ARTIFACT_PUBLISH), role="final")
        newer = replace(published, artifact_id="new-publication", content_sha256="new-hash")
        working = replace(
            published,
            artifact_id="working",
            source_kind=ArtifactSource.FILE_CHANGE,
            status=ArtifactStatus.COMPLETED,
            role="intermediate",
        )
        for records in ((working, published, newer), (published, newer, working)):
            current = current_artifact_records(records)
            self.assertEqual(
                {artifact_identity(record) for record in current},
                {
                    published.artifact_id,
                    newer.artifact_id,
                    product_artifact_id(working.session_id, working.canonical_path),
                },
            )
        deleted = replace(working, metadata={"change": "delete"})
        current = current_artifact_records((working, published, newer, deleted))
        self.assertEqual(
            {record.artifact_id for record in current},
            {
                published.artifact_id,
                newer.artifact_id,
            },
        )

    def test_same_key_cannot_be_reused_for_another_path(self) -> None:
        self.index()
        with self.assertRaises(SessionStateConflictError):
            self.index(canonical_path=str(self.root / "different.md"))

    def test_saved_destination_is_durable_and_mutable_outside_event_identity(self) -> None:
        record = self.index(saved_to="resources/existing.md")
        self.assertEqual(record.saved_to, "resources/existing.md")

        updated = self.artifacts.mark_saved(record.artifact_id, "resources/reports/report.md")
        reopened = SessionArtifactStore(self.database).list_session(SESSION_ID)

        self.assertEqual(updated.saved_to, "resources/reports/report.md")
        self.assertEqual(reopened[0].saved_to, "resources/reports/report.md")

    def test_cross_session_or_unrelated_event_attribution_is_rejected(self) -> None:
        with self.assertRaises(SessionBindingConflictError):
            self.artifacts.index(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id="another-thread",
                vendor_turn_id="turn-a",
                vendor_item_id="item-a",
                source_kind=ArtifactSource.STRUCTURED_TOOL,
                source_product_seq=self.event.product_seq,
                original_path="outputs/report.md",
                canonical_path=str(self.root / "report.md"),
                role="report",
                status=ArtifactStatus.COMPLETED,
                mime_type=None,
                content_sha256=None,
                size_bytes=None,
                metadata={},
                idempotency_key="wrong-thread",
            )
        with self.assertRaises(SessionStateConflictError):
            self.artifacts.index(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="wrong-turn",
                vendor_item_id="item-a",
                source_kind=ArtifactSource.ARTIFACT_PUBLISH,
                source_product_seq=self.event.product_seq,
                original_path="outputs/report.md",
                canonical_path=str(self.root / "report.md"),
                role="report",
                status=ArtifactStatus.PUBLISHED,
                mime_type=None,
                content_sha256=None,
                size_bytes=None,
                metadata={},
                idempotency_key="wrong-event",
            )

    def test_file_change_must_be_completed_and_path_must_be_canonical(self) -> None:
        with self.assertRaises(ValueError):
            self.artifacts.index(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-a",
                vendor_item_id="item-a",
                source_kind=ArtifactSource.FILE_CHANGE,
                source_product_seq=self.event.product_seq,
                original_path="outputs/report.md",
                canonical_path="outputs/report.md",
                role="report",
                status=ArtifactStatus.PUBLISHED,
                mime_type=None,
                content_sha256=None,
                size_bytes=None,
                metadata={},
                idempotency_key="invalid-file-change",
            )

    def test_session_artifact_reader_uses_index_identity_and_runtime_root(self) -> None:
        content = "# 验收\n\nSCHOLARSEED-UAT-artifact-preview\n"
        target = self.root / SESSION_ID / "outputs" / "report.md"
        target.write_text(content, encoding="utf-8")
        digest = sha256(content.encode("utf-8")).hexdigest()
        record = self.index(
            key="readable-artifact",
            canonical_path=str(target),
            content_sha256=digest,
            size_bytes=len(content.encode("utf-8")),
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        artifact_id = product_artifact_id(record.session_id, record.canonical_path)

        text = reader.read_text(SESSION_ID, artifact_id)
        raw, media_type = reader.read_raw(SESSION_ID, artifact_id)

        self.assertEqual(text["content"], content)
        self.assertFalse(text["binary"])
        self.assertEqual(raw, content.encode("utf-8"))
        self.assertEqual(media_type, "text/markdown")

    def test_session_artifact_reader_rejects_escape(self) -> None:
        outside = self.root / "outside.md"
        outside.write_text("outside", encoding="utf-8")
        outside_record = self.index(
            key="outside-artifact",
            canonical_path=str(outside),
            content_sha256=sha256(b"outside").hexdigest(),
            size_bytes=len(b"outside"),
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        outside_id = product_artifact_id(
            outside_record.session_id,
            outside_record.canonical_path,
        )
        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_PATH_FORBIDDEN):
            reader.read_text(SESSION_ID, outside_id)

    def test_file_change_reader_follows_the_current_session_path(self) -> None:
        target = self.root / SESSION_ID / "outputs" / "current.md"
        target.write_text("before", encoding="utf-8")
        current_record = self.index(
            key="current-artifact",
            canonical_path=str(target),
            content_sha256=sha256(b"before").hexdigest(),
            size_bytes=len(b"before"),
        )
        target.write_text("after", encoding="utf-8")
        current_id = product_artifact_id(
            current_record.session_id,
            current_record.canonical_path,
        )

        self.assertEqual(
            ArtifactService(
                self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy()
            ).read_text(SESSION_ID, current_id)["content"],
            "after",
        )

    def test_legacy_publication_without_snapshot_never_reads_current_source(self) -> None:
        target = self.root / SESSION_ID / "outputs" / "published.md"
        target.write_text("before", encoding="utf-8")
        stale_record = self.index(
            key="published-artifact",
            canonical_path=str(target),
            content_sha256=sha256(b"before").hexdigest(),
            size_bytes=len(b"before"),
            source_kind=ArtifactSource.ARTIFACT_PUBLISH,
        )
        target.write_text("after", encoding="utf-8")
        stale_id = artifact_identity(stale_record)
        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_NOT_FOUND):
            ArtifactService(
                self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy()
            ).read_text(SESSION_ID, stale_id)


if __name__ == "__main__":
    unittest.main()
