"""Contract for structured, session-isolated artifact attribution."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

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
from service.chat.runtime.projection import ARTIFACT_CHANGE_UPDATE, artifact_payload
from service.chat.service.artifacts import (
    ARTIFACT_EDIT_UNAVAILABLE,
    ARTIFACT_NOT_FOUND,
    ARTIFACT_PATH_FORBIDDEN,
    ARTIFACT_REVISION_CONFLICT,
    ARTIFACT_TOO_LARGE,
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
from service.platform.activity import Activities
from service.platform.content import ArtifactScopeKind
from service.platform.files import export_file_name
from service.platform.limits import DOCUMENT_PREVIEW_MAX_BYTES
from service.workbench.domain.model import WorkbenchFormatPolicy

SESSION_ID = "product-a"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "thread-a"
OWNER = SessionPrincipal("artifact-owner")


class SessionArtifactContract(unittest.TestCase):
    def test_current_schema_does_not_open_writer(self) -> None:
        with patch.object(
            SessionArtifactStore,
            "_connect",
            side_effect=AssertionError("current format opened writer"),
        ):
            SessionArtifactStore(self.database)

    def test_unknown_draft_column_rejected_before_writes(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE session_artifact_draft ADD COLUMN future_data TEXT")
            before = tuple(connection.iterdump())
        with self.assertRaises(RuntimeError):
            SessionArtifactStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_missing_schema_inspection_does_not_create_directory(self) -> None:
        database = self.root / "absent" / "sessions.sqlite3"
        self.assertTrue(SessionArtifactStore.inspect_schema(database).needs_write)
        self.assertFalse(database.parent.exists())

    def legacy_artifact(
        self,
        session_target="session_catalog",
        event_target="product_event",
        draft_target="session_artifact",
        *,
        missing_saved=False,
    ):
        record = self.index()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            main_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name='session_artifact'"
            ).fetchone()[0]
            draft_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name='session_artifact_draft'"
            ).fetchone()[0]
            connection.execute("DROP TABLE session_artifact_draft")
            connection.execute("ALTER TABLE session_artifact RENAME TO artifact_before")
            definition = main_sql.replace(
                "REFERENCES session_catalog", "REFERENCES " + session_target
            ).replace("REFERENCES session_artifact_source", "REFERENCES " + event_target)
            if missing_saved:
                definition = definition.replace("saved_to TEXT,", "")
            connection.execute(definition)
            columns = ",".join(
                row[1] for row in connection.execute("PRAGMA table_info(session_artifact)")
            )
            connection.execute(
                f"INSERT INTO session_artifact ({columns}) SELECT {columns} FROM artifact_before"
            )
            connection.execute("DROP TABLE artifact_before")
            connection.execute(
                draft_sql.replace("REFERENCES session_artifact", "REFERENCES " + draft_target)
            )
            connection.execute(
                "INSERT INTO session_artifact_draft VALUES (?,?)",
                (record.artifact_id, b"unpublished draft"),
            )
        return record

    def test_known_foreign_targets_preserve_artifacts_and_drafts(self) -> None:
        for session_target, event_target, draft_target in (
            ("session_catalog_migration", "product_event", "session_artifact"),
            ("session_catalog", "product_event_migration", "session_artifact"),
            ("session_catalog", "product_event", "session_artifact_foreign_key_migration"),
            (
                "session_catalog_migration",
                "product_event_migration",
                "session_artifact_foreign_key_migration",
            ),
        ):
            with self.subTest(
                session_target=session_target, event_target=event_target, draft_target=draft_target
            ):
                record = self.legacy_artifact(
                    session_target, event_target, draft_target, missing_saved=True
                )
                before = SessionArtifactStore.inspect_schema(self.database)
                self.assertTrue(before.add_saved_to)
                self.assertTrue(before.rebuild_tables)
                store = SessionArtifactStore(self.database)
                self.assertEqual(store.list_session(SESSION_ID), (record,))
                self.assertEqual(store.draft(record.artifact_id), b"unpublished draft")
                self.assertFalse(store.inspect_schema(self.database).needs_write)
                with closing(sqlite3.connect(self.database)) as connection:
                    self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_artifact_repair_preserves_external_dependents_and_rolls_back_failures(self) -> None:
        record = self.legacy_artifact(
            "session_catalog_migration",
            "product_event_migration",
            "session_artifact_foreign_key_migration",
        )
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "CREATE TABLE user_note (artifact TEXT REFERENCES session_artifact(artifact_id), note TEXT)"
            )
            connection.execute(
                "INSERT INTO user_note VALUES (?, 'preserve')", (record.artifact_id,)
            )
            connection.execute("CREATE INDEX user_artifact_role ON session_artifact(role)")
            connection.execute("CREATE TABLE user_audit (artifact TEXT)")
            connection.execute(
                "CREATE TRIGGER user_artifact_update AFTER UPDATE ON session_artifact BEGIN INSERT INTO user_audit VALUES (new.artifact_id); END"
            )
            before = tuple(connection.iterdump())
        create_indexes = SessionArtifactStore._create_indexes

        def fail_after_repair(connection):
            create_indexes(connection)
            if connection.execute("PRAGMA database_list").fetchone()[2]:
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                raise OSError("after real repair")

        with patch.object(SessionArtifactStore, "_create_indexes", side_effect=fail_after_repair):
            with self.assertRaisesRegex(OSError, "after real repair"):
                SessionArtifactStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)
        store = SessionArtifactStore(self.database)
        self.assertEqual(store.draft(record.artifact_id), b"unpublished draft")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(
                connection.execute("SELECT * FROM user_note").fetchall(),
                [(record.artifact_id, "preserve")],
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='user_artifact_role'"
                ).fetchone()
            )
            connection.execute("UPDATE session_artifact SET role=role")
            self.assertEqual(
                connection.execute("SELECT * FROM user_audit").fetchall(), [(record.artifact_id,)]
            )

    def test_wal_only_saved_to_and_index_migration(self) -> None:
        record = self.index()
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("ALTER TABLE session_artifact DROP COLUMN saved_to")
            writer.execute("DROP INDEX idx_session_artifact_path")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            schema = SessionArtifactStore.inspect_schema(self.database)
            self.assertTrue(schema.add_saved_to)
            self.assertEqual(schema.rebuild_tables, ())
            self.assertEqual(schema.create_indexes, ("idx_session_artifact_path",))
            self.assertEqual(before, (self.database.read_bytes(), wal.read_bytes()))
            self.assertEqual(
                SessionArtifactStore(self.database).list_session(SESSION_ID), (record,)
            )
            self.assertFalse(SessionArtifactStore.inspect_schema(self.database).needs_write)

    def test_unknown_foreign_target_is_preserved_without_writer(self) -> None:
        self.legacy_artifact(event_target="unknown_events")
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
        with patch.object(
            SessionArtifactStore, "_connect", side_effect=AssertionError("opened writer")
        ):
            with self.assertRaises(RuntimeError):
                SessionArtifactStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_source_anchors_are_sparse_and_session_deletion_cascades(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact_source").fetchone()[0], 0
            )
        record = self.index()
        self.index(key="second-artifact")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("PRAGMA foreign_keys=ON")
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact_source").fetchone()[0], 1
            )
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(session_artifact_source)")
            }
            self.assertEqual(
                columns,
                {
                    "session_id",
                    "product_seq",
                    "runtime_id",
                    "vendor_thread_id",
                    "vendor_turn_id",
                    "vendor_item_id",
                },
            )
            connection.execute(
                "DELETE FROM product_event WHERE session_id=? AND product_seq=?",
                (SESSION_ID, self.event.product_seq),
            )
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM session_artifact WHERE artifact_id=?", (record.artifact_id,)
                ).fetchone()
            )
            connection.execute("DELETE FROM session_catalog WHERE session_id=?", (SESSION_ID,))
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact_source").fetchone()[0], 0
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact").fetchone()[0], 0
            )
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_legacy_sources_backfill_only_referenced_event_identity(self) -> None:
        record = self.legacy_artifact()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DROP TABLE session_artifact_source")
        with patch(
            "service.chat.persistence.journal.Journal.put",
            side_effect=AssertionError("schema moved body"),
        ):
            migrated = SessionArtifactStore(self.database)
        self.assertEqual(migrated.list_session(SESSION_ID), (record,))
        self.assertEqual(migrated.draft(record.artifact_id), b"unpublished draft")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT * FROM session_artifact_source").fetchall(),
                [
                    (
                        SESSION_ID,
                        self.event.product_seq,
                        RUNTIME_ID,
                        VENDOR_THREAD_ID,
                        "turn-a",
                        "item-a",
                    )
                ],
            )
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertFalse(migrated.inspect_schema(self.database).needs_write)

    def test_legacy_missing_source_refuses_migration_and_rolls_back(self) -> None:
        self.legacy_artifact()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DROP TABLE session_artifact_source")
            connection.execute("DELETE FROM product_event")
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "source event missing"):
            SessionArtifactStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_source_anchor_rollback_and_corruption_are_not_hidden(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with self.events.transaction() as connection:
                self.index(connection=connection)
                raise RuntimeError("abort")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact_source").fetchone()[0], 0
            )
        self.index()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.row_factory = sqlite3.Row
            connection.execute("UPDATE session_artifact_source SET vendor_item_id='forged'")
            with self.assertRaisesRegex(RuntimeError, "source anchor"):
                SessionArtifactStore.inspect_rows(connection)
        with self.assertRaisesRegex(SessionStateConflictError, "source anchor"):
            self.index(key="another-artifact")
        with self.assertRaisesRegex(SessionStateConflictError, "source anchor"):
            self.index()

    def test_blocked_source_is_verified_in_the_same_transaction(self) -> None:
        with self.events.transaction() as connection:
            event = self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-a",
                vendor_item_id="item-a",
                kind="message_delta",
                payload={"text": "structured source context"},
                idempotency_key="block-source",
                connection=connection,
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM product_event WHERE session_id=? AND product_seq=?",
                    (SESSION_ID, event.product_seq),
                ).fetchone()
            )
            artifact = self.index(source_product_seq=event.product_seq, connection=connection)
        self.assertEqual(self.artifacts.list_session(SESSION_ID), (artifact,))
        with closing(sqlite3.connect(self.database)) as connection:
            connection.row_factory = sqlite3.Row
            SessionArtifactStore.inspect_rows(connection)
            ProductEventStore.inspect_rows(connection, database=self.database)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute("SELECT product_seq FROM session_artifact_source").fetchone()[0],
                event.product_seq,
            )
            connection.execute("UPDATE session_artifact_source SET runtime_id='forged-runtime'")
            with self.assertRaisesRegex(ValueError, "source anchor does not match"):
                ProductEventStore.inspect_rows(connection, database=self.database)
            connection.rollback()
            connection.execute("UPDATE session_artifact_source SET product_seq=999")
            with self.assertRaisesRegex(ValueError, "source anchor has no logical event"):
                ProductEventStore.inspect_rows(connection, database=self.database)

    def test_nonexistent_event_does_not_create_anchor(self) -> None:
        with self.assertRaisesRegex(SessionStateConflictError, "source event does not exist"):
            self.index(source_product_seq=100)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM session_artifact_source").fetchone()[0], 0
            )

    def test_large_pdf_can_stream_without_becoming_editable(self) -> None:
        source = self.root / SESSION_ID / "outputs" / "large.pdf"
        with source.open("wb") as stream:
            stream.write(b"%PDF-1.7\n")
            stream.truncate(17 * 1024 * 1024)
        artifact = self.index(
            original_path="outputs/large.pdf",
            mime_type="application/pdf",
            size_bytes=source.stat().st_size,
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())

        document = reader.open_document(SESSION_ID, artifact_identity(artifact))

        self.assertFalse(document.editable)
        self.assertEqual(document.size, source.stat().st_size)
        self.assertEqual(document.media_type, "application/pdf")
        assert not isinstance(document.body, bytes)
        self.assertEqual(document.body.read(8), b"%PDF-1.7")
        document.body.close()

    def test_pdf_above_preview_limit_has_stable_error(self) -> None:
        source = self.root / SESSION_ID / "outputs" / "oversized.pdf"
        with source.open("wb") as stream:
            stream.write(b"%PDF-1.7\n")
            stream.truncate(DOCUMENT_PREVIEW_MAX_BYTES + 1)
        artifact = self.index(
            original_path="outputs/oversized.pdf",
            mime_type="application/pdf",
            size_bytes=source.stat().st_size,
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())

        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_TOO_LARGE):
            reader.open_document(SESSION_ID, artifact_identity(artifact))

    def test_sent_pdf_keeps_original_attachment_after_rebinding(self) -> None:
        before = self.catalog.get(SESSION_ID)
        assert before is not None
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
        assert before is not None
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
        self.addCleanup(self._temporary.cleanup)
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

    def test_pdf_card_names_preserve_source_locators(self) -> None:
        for filename, expected in (
            ("1706.03762_Attention", "1706.03762_Attention.pdf"),
            ("report.txt", "report.pdf"),
            ("report.PDF", "report.PDF"),
        ):
            with self.subTest(filename=filename):
                record = self.index(
                    key=filename,
                    original_path=f"outputs/{filename}",
                    mime_type="application/pdf",
                )
                payload = artifact_payload(record, change=ARTIFACT_CHANGE_UPDATE)
                self.assertEqual(payload["name"], expected)
                self.assertEqual(payload["path"], record.original_path)
                self.assertEqual(payload["absolute_path"], record.canonical_path)
                self.assertEqual(payload["sha256"], record.content_sha256)
                self.assertEqual(payload["media_type"], "application/pdf")

    def test_export_recovers_pdf_names_without_changing_source_bytes(self) -> None:
        pdf = b"%PDF-1.7\ncontract bytes\x00"
        cases = (
            ("paper", pdf, "paper.pdf"),
            (
                "1706.03762_Attention_Is_All_You_Need",
                pdf,
                "1706.03762_Attention_Is_All_You_Need.pdf",
            ),
            ("paper.pdf", pdf, "paper.pdf"),
            ("paper.PDF", pdf, "paper.PDF"),
            ("paper.txt", pdf, "paper.pdf"),
            ("paper.download", pdf, "paper.download.pdf"),
            ("notes.md", b"# Notes\n", "notes.md"),
            ("unknown", b"\x00unregistered binary", "unknown"),
        )
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        for filename, payload, expected in cases:
            with self.subTest(filename=filename):
                source = self.root / SESSION_ID / "outputs" / filename
                source.write_bytes(payload)
                record = self.index(
                    key=filename,
                    original_path=f"outputs/{filename}",
                    mime_type="application/octet-stream",
                    content_sha256=sha256(payload).hexdigest(),
                    size_bytes=len(payload),
                )
                actual, name = reader.export_document_bytes(SESSION_ID, artifact_identity(record))
                self.assertEqual(name, expected)
                self.assertEqual(actual, payload)
                self.assertEqual(source.read_bytes(), payload)
                self.assertEqual(record.original_path, f"outputs/{filename}")

    def test_export_draft_uses_current_bytes_for_pdf_filename(self) -> None:
        source = self.root / SESSION_ID / "outputs" / "draft"
        source.write_bytes(b"original\x00")
        record = self.index(original_path="outputs/draft", mime_type="application/octet-stream")
        draft = b"%PDF-1.7\nupdated\x00"
        with self.events.transaction() as connection:
            self.artifacts.save_draft(record.artifact_id, draft, connection=connection)
        reader = ArtifactService(self.catalog, self.artifacts, self.events, WorkbenchFormatPolicy())
        self.assertEqual(
            reader.export_document_bytes(SESSION_ID, artifact_identity(record)),
            (draft, "draft.pdf"),
        )
        self.assertEqual(source.read_bytes(), b"original\x00")
        with self.assertRaisesRegex(ArtifactReadError, ARTIFACT_REVISION_CONFLICT):
            reader.export_document_bytes(
                SESSION_ID, artifact_identity(record), sha256(b"old").hexdigest()
            )

    def test_filename_hint_does_not_rewrite_invalid_target_names(self) -> None:
        for name in ("", ".", "..", "../escape", "..\\escape"):
            with self.subTest(name=name):
                self.assertEqual(export_file_name(name, "application/pdf", b"%PDF-1.7"), name)

    def test_event_index_and_cursor_share_commit_or_rollback(self) -> None:
        session = self.catalog.get(SESSION_ID)
        assert session is not None
        baseline = session.last_product_seq
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
            session = self.catalog.get(SESSION_ID)
            assert session is not None
            if fail:
                self.assertEqual(session.last_product_seq, baseline)
                self.assertEqual(self.artifacts.list_session(SESSION_ID), ())
                self.assertEqual(self.events.replay(SESSION_ID, after_seq=baseline), ())
            else:
                self.assertEqual(session.last_product_seq, baseline + 2)
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
            sheet = workbook.active
            assert sheet is not None
            sheet["A1"] = value
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
        sheet = workbook.active
        assert sheet is not None
        sheet["A1"] = "safe"
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
        content = ContentService(
            ProjectRegistry(str(self.root), content_catalog),
            content_catalog,
            activities=Activities(),
        )
        content.bind_artifact_scope(
            ArtifactScopeKind.SESSION, SessionArtifactStorage(self.catalog, self.root).resolve
        )
        publications = PublicationService(content)

        def workbook_bytes(value: str) -> bytes:
            workbook = Workbook()
            sheet = workbook.active
            assert sheet is not None
            sheet["A1"] = value
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
                session = self.catalog.get(SESSION_ID)
                assert session is not None
                payload, _events = publications.project(
                    publication, session, self.events, self.artifacts
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
        target.write_bytes(content.encode("utf-8"))
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
