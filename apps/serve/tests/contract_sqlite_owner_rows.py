"""Production row readers on migration copies; not update acceptance evidence."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.store import AssistantStore
from service.bootstrap import _startup_sqlite_owners
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import (
    BROWSER_ACTION_ADDITIVE_COLUMNS,
    SESSION_BROWSER_ACTION_TABLE,
    SESSION_BROWSER_ACTION_WATERMARK_TABLE,
    SessionCatalogStore,
    SessionPrincipal,
)
from service.chat.persistence.events import ProductEventStore
from service.content.persistence.catalog import (
    SEED_CHAT_REGISTRY,
    CatalogFormatError,
    ContentCatalog,
    ExternalRootRow,
    ProjectRow,
)
from service.content.service.port import ProjectRegistry
from service.cutover import initialize_pdf_schema, inspect_pdf_connection, inspect_pdf_rows
from service.identity.persistence.handoff import HandoffClaimStore
from service.literature.persistence.reading import AttachmentRecordCatalog
from service.literature.persistence.store import (
    LiteratureRepository,
    classify_schema,
    initialize_schema,
)
from service.literature.schema import LiteratureItem
from service.persistence.preview import SchemaOwner, preview_database, require_candidate_layout
from service.platform.context import (
    AssistantTurnItem,
    AssistantTurnSnapshot,
    ContextRef,
    ContextRefKind,
    ContextResolutionState,
    ProjectContextPolicy,
    SearchScope,
)
from service.platform.records import (
    EMPTY_RECORDS,
    RecordOwner,
    RecordTarget,
    encode_records,
    record_revision,
)
from service.settings.credentials import ModelCredentialStore, OAuthTokens
from service.workbench.persistence.records import PdfRecordCatalog


def owner(kind, name, *, database=None):
    read_rows = (
        (lambda connection: kind.inspect_rows(connection, database=database))
        if database is not None
        else kind.inspect_rows
    )
    return SchemaOwner(name, kind.inspect_connection, kind.initialize_schema, read_rows)


class SqliteOwnerRowContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / "private" / "data.sqlite3"

    def test_browser_legacy_scope_columns_are_projected_without_source_migration(self):
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for column in BROWSER_ACTION_ADDITIVE_COLUMNS:
                connection.execute(
                    f"ALTER TABLE {SESSION_BROWSER_ACTION_TABLE} DROP COLUMN {column}"
                )
            connection.commit()
        self.observe((owner(SessionCatalogStore, "session", database=self.database),))
        with closing(sqlite3.connect(self.database)) as connection:
            columns = {
                row[1]
                for row in connection.execute(f"PRAGMA table_info({SESSION_BROWSER_ACTION_TABLE})")
            }
        self.assertTrue(set(BROWSER_ACTION_ADDITIVE_COLUMNS).isdisjoint(columns))

    def test_browser_action_and_watermark_use_owner_row_checks(self):
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                f"INSERT INTO {SESSION_BROWSER_ACTION_TABLE} "
                "(request_id, session_id, turn_id, operation, signature_epoch, signature_mac, status, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("request", "session", "turn", "read", "epoch", "digest", "pending", 1.0, 1.0),
            )
            connection.execute(
                f"INSERT INTO {SESSION_BROWSER_ACTION_WATERMARK_TABLE} "
                "(session_id, instance_id, product_turn_id, turn_id, generation, interrupt_generation, lifecycle_epoch) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("session", "instance", "product-turn", "turn", 1, 0, 1),
            )
            connection.commit()
        owners = (owner(SessionCatalogStore, "session", database=self.database),)
        before = self.observe(owners)
        self.rejects_field(owners, SESSION_BROWSER_ACTION_TABLE, "status", "future-status")
        self.rejects_field(owners, SESSION_BROWSER_ACTION_WATERMARK_TABLE, "generation", 0)
        self.rejects_field(owners, SESSION_BROWSER_ACTION_WATERMARK_TABLE, "instance_id", "")
        self.assert_same_projection(owners, before)

    def observe(self, owners):
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
            preview = preview_database(self.database, "owner-rows", owners)
            check = require_candidate_layout(preview, preview, owners)
            self.assertEqual(check.row_readers, tuple(item.name for item in owners))
            self.assertEqual(tuple(connection.iterdump()), before)
        return preview

    def rejects_field(self, owners, table, column, value):
        with closing(sqlite3.connect(self.database)) as connection:
            before = connection.execute(f"SELECT {column} FROM {table}").fetchall()
            self.assertEqual(len(before), 1, "mutation must exercise one seeded record")
            connection.execute(f"UPDATE {table} SET {column}=?", (value,))
            connection.commit()
            mutated = tuple(connection.iterdump())
            try:
                with self.assertRaises((ValueError, TypeError, RuntimeError, CatalogFormatError)):
                    preview_database(self.database, "owner-rows", owners)
                self.assertEqual(tuple(connection.iterdump()), mutated)
            finally:
                connection.execute(f"UPDATE {table} SET {column}=?", before[0])
                connection.commit()

    def assert_same_projection(self, owners, before):
        # Corruption/restoration transactions in the fixture change SQLite's
        # source-page counter. Compare actual projected values and layout, not
        # the preimage digest belonging to an earlier committed snapshot.
        after = self.observe(owners)
        self.assertEqual(replace(after, source_digest=before.source_digest), before)

    def session(self):
        catalog = SessionCatalogStore(self.database)
        catalog.allocate(
            "session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            runtime_workdir=str(Path(self.directory.name)),
            project_path=None,
            output_root=str(Path(self.directory.name) / "output"),
            model_id="model",
        )
        return catalog

    def test_artifact_drafts_remain_private_and_reject_non_blob_storage(self):
        self.session()
        ProductEventStore(self.database)
        artifacts = SessionArtifactStore(self.database)
        payload = b"private-draft-marker\x00\xff"
        # Read every stored draft, including an orphan left by a broken writer;
        # a missing artifact index entry must not hide an unsupported value.
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                "INSERT INTO session_artifact_draft VALUES (?, ?)", ("draft", payload)
            )
        owners = (
            owner(SessionCatalogStore, "sessions", database=self.database),
            owner(ProductEventStore, "events", database=self.database),
            owner(SessionArtifactStore, "artifacts"),
        )
        before = self.observe(owners)
        self.assertEqual(artifacts.draft("draft"), payload)
        self.assertNotIn("private-draft-marker", repr(before))
        for value in ("future-text-format", 2**62):
            with self.subTest(value=value):
                self.rejects_field(owners, "session_artifact_draft", "content", value)
        self.assertEqual(artifacts.draft("draft"), payload)
        self.assert_same_projection(owners, before)

    def assistant(self):
        self.session()
        store = AssistantStore(self.database)
        ref = ContextRef("ref", ContextRefKind.FILE, "private-source", "Source")
        selection = store.replace_selection(
            session_id="session",
            expected_revision=0,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            refs=(ref,),
        )
        snapshot = AssistantTurnSnapshot(
            snapshot_id="snapshot",
            session_id="session",
            client_turn_id="turn",
            selection_revision=selection.revision,
            project_id=None,
            project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
            search_scope=SearchScope.DISABLED,
            model_card_hash="card",
            admission_hash="admission",
            items=(
                AssistantTurnItem(
                    "evidence", ref, ContextResolutionState.READY, excerpt_text="private-excerpt"
                ),
            ),
        )
        store.create_snapshot(snapshot)
        return store

    def test_session_queue_activation_and_task_binding_readers_run_without_recovery(self):
        catalog = self.session()
        catalog.enqueue_message("session", "queued", {"text": "private-message"})
        catalog.remember_task_binding("session", {"runtime": "codex"})
        owners = (owner(SessionCatalogStore, "sessions", database=self.database),)
        before = self.observe(owners)
        for table, column, value in (
            ("session_catalog", "status", "future-status"),
            ("session_message_queue", "state", "future-state"),
            ("session_message_queue", "body", "{broken"),
            ("session_activation", "required_capabilities", '["future-capability"]'),
            ("session_task_binding", "binding_json", "{broken"),
            ("session_model_state", "updated_at", "future-date"),
        ):
            with self.subTest(table=table, column=column):
                self.rejects_field(owners, table, column, value)
        self.assert_same_projection(owners, before)
        self.assertEqual(catalog.queued_messages("session")[0].body, {"text": "private-message"})

    def test_assistant_selection_and_snapshot_items_use_the_same_codecs(self):
        store = self.assistant()
        owners = (
            owner(SessionCatalogStore, "sessions", database=self.database),
            owner(AssistantStore, "assistant"),
        )
        before = self.observe(owners)
        snapshot = store.snapshot_by_id("session", "snapshot")
        for table, column, value in (
            ("assistant_context_selection", "project_policy", "future-policy"),
            ("assistant_context_ref", "kind", "future-kind"),
            ("assistant_turn_snapshot", "search_scope", "future-scope"),
            ("assistant_turn_item", "resolution_state", "future-state"),
            ("assistant_turn_item", "item_role", "future-role"),
            ("assistant_turn_item", "used_chars", "future-size"),
        ):
            with self.subTest(table=table, column=column):
                self.rejects_field(owners, table, column, value)
        self.assertEqual(store.snapshot_by_id("session", "snapshot"), snapshot)
        self.assert_same_projection(owners, before)

    def test_citation_reader_decodes_receipts_without_opening_the_referenced_pdf(self):
        self.assistant()
        citations = CitationStore(self.database)
        payload = {"handle": "receipt", "source": "private-unavailable.pdf", "page": 3}
        self.assertEqual(citations.record("session", "snapshot", "source", payload), payload)
        owners = (
            owner(SessionCatalogStore, "sessions", database=self.database),
            owner(AssistantStore, "assistant"),
            owner(CitationStore, "citations"),
        )
        before = self.observe(owners)
        self.rejects_field(owners, "assistant_pdf_citations", "payload", "{broken")
        self.assertEqual(citations.get("session", "snapshot", "receipt"), payload)
        self.assert_same_projection(owners, before)

    def test_credential_reader_does_not_rotate_or_disclose_private_values(self):
        store = ModelCredentialStore(self.database)
        tokens = OAuthTokens(
            "private-access-marker",
            "private-refresh-marker",
            2_000_000_000.0,
            client_id="oaiapp_contract",
            scopes=("chatgpt.tokens.use.direct",),
        )
        expected = store.replace("owner", "connection", tokens, expected_generation=0)
        owners = (owner(ModelCredentialStore, "credentials"),)
        before = self.observe(owners)
        self.assertNotIn("private-access-marker", repr(before))
        self.assertNotIn("private-refresh-marker", repr(before))
        for column, value in (
            ("state", "future-state"),
            ("access_token", "broken\nvalue"),
            ("expires_at", -1.0),
        ):
            self.rejects_field(owners, "model_credentials", column, value)
        self.assertEqual(store.read("owner", "connection"), expected)
        self.assert_same_projection(owners, before)

    def test_handoff_projection_never_takes_or_renews_a_delivered_code(self):
        store = HandoffClaimStore(self.database)
        store.claim("handoff-state", "owner")
        store.deliver("handoff-state", "private-code-marker", "other")
        owners = (owner(HandoffClaimStore, "handoff"),)
        before = self.observe(owners)
        self.assertNotIn("private-code-marker", repr(before))
        self.rejects_field(owners, "desktop_handoff_claims", "lease_expires_at", "future-date")
        self.assert_same_projection(owners, before)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute("SELECT code FROM desktop_handoff_claims").fetchone()[0],
                "private-code-marker",
            )

    def test_content_recovery_records_are_read_without_publishing_the_effect(self):
        self.database.parent.mkdir(parents=True)
        store = ContentCatalog(self.database)
        store.insert_project(
            ProjectRow("project", "Project", self.directory.name, "workspace", 1.0)
        )
        store.insert_external_root(
            ExternalRootRow(
                "root", "project", str(Path(self.directory.name) / "missing-external"), "mount", 2.0
            )
        )
        self.assertTrue(
            store.accept_operation("operation", "owner", "{}", limit=10, retention=3600)
        )
        store.start_operation("operation")
        store.record_operation_effect("operation", {"private-result": "kept"})
        owners = (owner(ContentCatalog, "content"),)
        before = self.observe(owners)
        for table, column, value in (
            ("projects", "created_at", "future-date"),
            ("external_roots", "source_kind", "future-kind"),
            ("content_operations", "state", "future-state"),
            ("content_operation_effects", "result_json", "[]"),
        ):
            with self.subTest(table=table, column=column):
                self.rejects_field(owners, table, column, value)
        self.assertEqual(store.operation_result("owner", "operation")["state"], "running")
        self.assert_same_projection(owners, before)

    def test_compiled_startup_groups_include_the_registered_readers(self):
        groups = {name: owners for _path, name, owners in _startup_sqlite_owners()}
        for group in ("sessions", "imports", "content", "handoff", "credentials"):
            self.assertTrue(all(item.read_rows is not None for item in groups[group]))

    def test_operation_recovery_on_copy_matches_normal_startup(self):
        self.database.parent.mkdir(parents=True)
        store = ContentCatalog(self.database)
        for identity in ("published", "abandoned"):
            self.assertTrue(
                store.accept_operation(identity, "owner", "{}", limit=10, retention=3600)
            )
            store.start_operation(identity)
        store.record_operation_effect("published", {"private-result": "kept"})
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            before = tuple(source.iterdump())
            with self.assertRaisesRegex(ValueError, "requires a transaction"):
                ContentCatalog.recover_operation_rows(projected, now=1234.0)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                ContentCatalog.recover_operation_rows(projected, now=1234.0)
                ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertEqual(tuple(source.iterdump()), before)
            self.assertEqual(store.operation_result("owner", "published")["state"], "running")
            with patch("service.content.persistence.catalog.time.time", return_value=1234.0):
                store.recover_operations()
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertEqual(store.operation_result("owner", "published")["state"], "succeeded")
            self.assertEqual(store.operation_result("owner", "abandoned")["state"], "failed")

    def test_legacy_registration_reuses_explicit_plan_on_private_copy(self):
        self.database.parent.mkdir(parents=True)
        catalog = ContentCatalog(self.database)
        root = Path(self.directory.name) / "not-created-by-registration"
        plan = ProjectRegistry.seed_plan(
            str(root),
            "  Legacy  ",
            SEED_CHAT_REGISTRY,
            project_id="01arz3ndektsv4rrffq69g5fav",
            created_at=1234.0,
        )
        self.assertEqual(plan.display_name, "Legacy")
        self.assertFalse(root.exists())
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            source.backup(projected)
            projected.row_factory = sqlite3.Row
            before = tuple(source.iterdump())
            with self.assertRaisesRegex(ValueError, "requires a transaction"):
                ContentCatalog.insert_project_rows(projected, plan)
            with projected:
                projected.execute("BEGIN IMMEDIATE")
                self.assertEqual(ContentCatalog.insert_project_rows(projected, plan), plan)
                ContentCatalog.inspect_rows(projected)
            expected = tuple(projected.iterdump())
            self.assertEqual(tuple(source.iterdump()), before)
            self.assertIsNone(catalog.project(plan.project_id))
            ProjectRegistry(None, catalog).commit_creation(plan)
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertEqual(catalog.project(plan.project_id), plan)
            with self.assertRaises(sqlite3.IntegrityError), projected:
                projected.execute("BEGIN IMMEDIATE")
                ContentCatalog.insert_project_rows(
                    projected, replace(plan, display_name="replacement")
                )
            self.assertEqual(tuple(projected.iterdump()), expected)
        self.assertFalse(root.exists())

    def test_literature_readers_preserve_notes_and_do_not_open_attachments(self):
        repository = LiteratureRepository(self.database)
        repository.save(LiteratureItem(id="paper", title="Private paper"))
        repository.create_note("paper", "private-note", "Note")
        missing = Path(self.directory.name) / "missing-attachment.pdf"
        repository.add_attachment("paper", "Attachment", str(missing), revision="revision")
        owners = (
            SchemaOwner(
                "literature", classify_schema, initialize_schema, LiteratureRepository.inspect_rows
            ),
        )
        before = self.observe(owners)
        for table, column, value in (
            ("literature_items", "fulltext", "future-state"),
            ("literature_items", "bib_type", "future-type"),
            ("literature_notes", "version", "future-version"),
            ("literature_attachments", "role", "future-role"),
        ):
            with self.subTest(table=table, column=column):
                self.rejects_field(owners, table, column, value)
        self.assertEqual(repository.notes("paper")[0].text, "private-note")
        self.assert_same_projection(owners, before)
        self.assertFalse(missing.exists())

    def test_literature_pdf_records_use_actual_revision_and_payload_validation(self):
        repository = LiteratureRepository(self.database)
        repository.save(LiteratureItem(id="paper", title="Paper"))
        repository.add_attachment(
            "paper", "Attachment", "missing.pdf", revision="source", attachment_id="attachment"
        )
        catalog = AttachmentRecordCatalog(self.database)
        target = RecordTarget(RecordOwner.LITERATURE_ATTACHMENT, "paper", "attachment")
        expected = catalog.snapshot(target, "source")
        owners = (
            SchemaOwner(
                "pdf",
                lambda connection: inspect_pdf_connection(connection, "literature"),
                lambda connection: initialize_pdf_schema(connection, "literature"),
                lambda connection: inspect_pdf_rows(connection, "literature"),
            ),
            SchemaOwner(
                "literature", classify_schema, initialize_schema, LiteratureRepository.inspect_rows
            ),
        )
        before = self.observe(owners)
        for column, value in (
            ("payload", b'{"schema_version":999,"marks":[],"notes":[],"comments":[]}'),
            ("payload", b"{broken"),
            ("record_revision", "sha256:incorrect"),
            ("source_revision", "changed-source"),
        ):
            self.rejects_field(owners, "literature_attachment_records", column, value)
        self.assert_same_projection(owners, before)
        self.assertEqual(catalog.snapshot(target, "source"), expected)

    def test_project_pdf_records_and_links_are_checked_without_asset_access(self):
        self.database.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.database)) as connection:
            # Owned declarations and codec bytes, with no Content resolver or
            # source PDF. These are persistence contracts, not product flows.
            PdfRecordCatalog._schema(connection)
            PdfRecordCatalog._link_schema(connection)
            connection.execute(
                "INSERT INTO workbench_pdf_record VALUES(?,?,?,?,?)",
                (
                    "asset",
                    record_revision("source", EMPTY_RECORDS),
                    "source",
                    encode_records(EMPTY_RECORDS),
                    1.0,
                ),
            )
            connection.execute(
                "INSERT INTO workbench_pdf_record_link VALUES(?,?,?,?)",
                ("asset", RecordOwner.LITERATURE_ATTACHMENT.value, "paper", "attachment"),
            )
            connection.commit()
        owners = (
            SchemaOwner(
                "pdf",
                lambda connection: inspect_pdf_connection(connection, "project"),
                lambda connection: initialize_pdf_schema(connection, "project"),
                lambda connection: inspect_pdf_rows(connection, "project"),
            ),
        )
        before = self.observe(owners)
        for table, column, value in (
            (
                "workbench_pdf_record",
                "payload",
                json.dumps(dict(EMPTY_RECORDS, schema_version=999)).encode(),
            ),
            ("workbench_pdf_record", "record_revision", "sha256:incorrect"),
            ("workbench_pdf_record_link", "owner", "future-owner"),
        ):
            with self.subTest(table=table, column=column):
                self.rejects_field(owners, table, column, value)
        self.assert_same_projection(owners, before)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("ALTER TABLE workbench_pdf_record_link ADD COLUMN future_data TEXT")
            connection.commit()
            original = tuple(connection.iterdump())
            with self.assertRaises(RuntimeError):
                preview_database(self.database, "owner-rows", owners)
            self.assertEqual(tuple(connection.iterdump()), original)


if __name__ == "__main__":
    unittest.main()
