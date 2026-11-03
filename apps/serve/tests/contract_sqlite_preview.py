"""Actual owner migrations on isolated SQLite copies; not update acceptance."""

from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing, contextmanager, nullcontext
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Never
from unittest.mock import patch

from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.persistence.store import AssistantStore
from service.assistant.service.authorization import FULLTEXT_AUTHORIZATION_TABLE, FulltextAuthorizer
from service.bootstrap import (
    ProjectCreationRecovery,
    ProjectStartupSource,
    StartupSources,
    check_startup_publications,
    check_startup_sqlite,
    export_startup_sqlite,
    preview_startup_sqlite,
    projected_startup_recovery,
    recover_startup_rows,
    startup_creation_recovery,
    startup_removal_plans,
)
from service.chat.constants import PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_USER_MESSAGE
from service.chat.persistence import journal
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.content.domain.model import ContentError, OperationState
from service.content.persistence.catalog import ContentCatalog, ProjectRow
from service.content.service.port import ProjectRegistry
from service.content.service.provenance import CreationObservation, _receipt
from service.cutover import (
    initialize_pdf_schema,
    inspect_literature_startup,
    inspect_pdf_connection,
    inspect_pdf_rows,
)
from service.identity.persistence.handoff import HandoffClaimStore
from service.literature.persistence.store import LiteratureRepository
from service.literature.persistence.store import classify_schema as inspect_literature
from service.literature.persistence.store import connect as connect_literature
from service.literature.persistence.store import initialize_schema as initialize_literature
from service.paths import PROJECT_DB_RELATIVE, PROJECT_VERSIONS_RELATIVE, SESSION_BLOCK_SUFFIX
from service.persistence.preview import (
    CandidateRowsRequired,
    SchemaObject,
    SchemaOwner,
    SnapshotBudgetExceeded,
    decode_previews,
    preview_database,
    projected_database,
    require_candidate_layout,
)
from service.persistence.rows import rows_digest
from service.platform.content import ImportMode
from service.platform.domains import DomainChangedError
from service.platform.inference import ModelInvocationStatus
from service.resources.persistence.catalog import (
    AGENT_IMPORTS_TABLE,
    initialize_catalog_schema,
    initialize_resource_catalog,
    inspect_catalog_connection,
    inspect_catalog_rows,
)
from service.resources.persistence.chunks import digest
from service.resources.persistence.inspection import CasPublication
from service.resources.persistence.jobs import ImportJobStore
from service.resources.persistence.objects import CasEntryKind, CasStore, GcEntry, GcPlan
from service.resources.persistence.version import VersionStore
from service.settings.credentials import ModelCredentialStore


@dataclass(frozen=True)
class FixtureSchema:
    """SchemaState for synthetic tables whose real readers are under test."""

    needs_write: bool


class InspectionFixture:
    """Composition-only inspection; unexpected native capabilities fail closed."""

    @contextmanager
    def inspection(self, root: str):
        yield root

    def unexpected(self, *args: object, **kwargs: object) -> Never:
        raise AssertionError("unexpected directory capability in composition fixture")

    selected = unexpected
    locator_hint = unexpected
    directory_identity = unexpected
    directory_path = unexpected
    entry_kind = unexpected
    directory_metadata = unexpected
    directory_entries = unexpected
    read = unexpected
    batch_inspection = unexpected
    snapshots = unexpected


def startup_fixture(root: Path) -> StartupSources:
    """Build a complete typed snapshot from real owners' absent-database schemas.

    These read-only inspections create no files. Individual composition tests
    replace only the actual source inventories exercised by their scenario.
    """
    absent = root / "absent-startup-fixture.sqlite3"
    return StartupSources(
        roots=(),
        workspace=root,
        legacy_seeds=(),
        catalog=ContentCatalog.read_roots(absent),
        sessions=SessionCatalogStore.inspect_schema(absent),
        events=ProductEventStore.inspect_schema(absent),
        artifacts=SessionArtifactStore.inspect_schema(absent),
        citations=CitationStore.inspect_schema(absent),
        invocations=AssistantInvocationStore.inspect_schema(absent),
        assistant=AssistantStore.inspect_schema(absent),
        fulltext_authorizations=FulltextAuthorizer.inspect_schema(absent),
        imports=ImportJobStore.inspect_schema(absent),
        handoff=HandoffClaimStore.inspect_schema(absent),
        credentials=ModelCredentialStore.inspect_schema(absent),
        literature=inspect_literature_startup(absent),
        project_storage=(),
        trace=None,
        settings_data=None,
        projects_data=None,
        pending_legacy_seeds=(),
        config_data=None,
        config_seed=None,
        profiles_data=None,
        auth_data=None,
        config_seed_source=None,
        config_seed_data=None,
        trace_projection=None,
        trace_formats=None,
        trace_history=None,
    )


STORES = (
    SessionCatalogStore,
    ProductEventStore,
    SessionArtifactStore,
    CitationStore,
    AssistantInvocationStore,
    AssistantStore,
)
ROW_READERS = {
    SessionCatalogStore: SessionCatalogStore.inspect_rows,
    ProductEventStore: ProductEventStore.inspect_rows,
    SessionArtifactStore: SessionArtifactStore.inspect_rows,
    AssistantInvocationStore: AssistantInvocationStore.inspect_rows,
    AssistantStore: AssistantStore.inspect_rows,
    CitationStore: CitationStore.inspect_rows,
}
OWNERS = tuple(
    SchemaOwner(
        owner.__name__, owner.inspect_connection, owner.initialize_schema, ROW_READERS.get(owner)
    )
    for owner in STORES
)
PROJECT_OWNERS = (
    SchemaOwner(
        "pdf",
        lambda connection: inspect_pdf_connection(connection, "project"),
        lambda connection: initialize_pdf_schema(connection, "project"),
        lambda connection: inspect_pdf_rows(connection, "project"),
    ),
    SchemaOwner(
        "resource-versions",
        VersionStore.inspect_connection,
        VersionStore.initialize_schema,
        VersionStore.inspect_rows,
        triggers=VersionStore.preview_triggers,
    ),
    SchemaOwner(
        "resource-catalog",
        inspect_catalog_connection,
        initialize_catalog_schema,
        inspect_catalog_rows,
    ),
)


class SqlitePreviewContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.directory.cleanup)
        self.database = Path(self.directory.name) / "storage" / "sessions.sqlite3"
        bound = {
            "SessionCatalogStore": lambda connection: SessionCatalogStore.inspect_rows(
                connection, database=self.database
            ),
            "ProductEventStore": lambda connection: ProductEventStore.inspect_rows(
                connection, database=self.database
            ),
        }
        self.owners = (
            SchemaOwner(
                "session-journal",
                journal.inspect_connection,
                journal.initialize,
                lambda connection: journal.inspect_index_rows(connection, self.database),
            ),
            *(replace(owner, read_rows=bound.get(owner.name, owner.read_rows)) for owner in OWNERS),
        )

    def _journal_event(self, kind=PRODUCT_EVENT_USER_MESSAGE):
        catalog = SessionCatalogStore(self.database)
        catalog.register(
            "journal-session",
            SessionPrincipal("owner"),
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_session_id="process",
            runtime_workdir=str(self.database.parent),
            project_path=None,
            output_root=str(self.database.parent),
            codex_version="test",
            model_id="model",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="",
            created_at=1.0,
        )
        events = ProductEventStore(self.database)
        record = events.append(
            session_id="journal-session",
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_turn_id="turn",
            vendor_item_id="answer",
            kind=kind,
            payload={"delta": "canonical-private-body"},
            idempotency_key="journal-event",
            created_at=2.0,
        )
        return catalog, events, record

    def test_block_projection_preserves_source_and_arbitrary_reconnect_cursor(self):
        _, events, first = self._journal_event(PRODUCT_EVENT_MESSAGE_DELTA)
        second = events.append(
            session_id="journal-session",
            runtime_id="codex",
            vendor_thread_id="thread",
            vendor_turn_id="turn",
            vendor_item_id="answer",
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": "canonical-private-body plus suffix"},
            idempotency_key="journal-event-next",
            created_at=3.0,
        )
        directory = self.database.with_suffix(SESSION_BLOCK_SUFFIX)
        before = {path.name: path.read_bytes() for path in directory.iterdir()}
        source = preview_database(self.database, "sessions", self.owners)
        require_candidate_layout(source, source, self.owners)
        self.assertEqual(events.replay("journal-session", after_seq=first.product_seq), (second,))
        self.assertEqual(before, {path.name: path.read_bytes() for path in directory.iterdir()})
        self.assertNotIn("canonical-private-body", repr(source))

    def test_block_body_damage_refuses_readonly_projection(self):
        self._journal_event(PRODUCT_EVENT_MESSAGE_DELTA)
        directory = self.database.with_suffix(SESSION_BLOCK_SUFFIX)
        paths = tuple(directory.glob("*.jsonl"))
        self.assertEqual(len(paths), 1)
        path = paths[0]
        original = path.read_bytes()
        for damage in ("missing", "corrupt", "truncated"):
            with self.subTest(damage=damage):
                preview_database(self.database, "sessions", self.owners)
                # Preserve the original file's native ACL when exercising a
                # missing reference; recreating it with chmod is not private on Windows.
                held = path.with_suffix(".held")
                try:
                    if damage == "missing":
                        path.rename(held)
                    elif damage == "corrupt":
                        path.write_bytes(
                            original.replace(b"canonical-private-body", b"tampered--private-body")
                        )
                    else:
                        path.write_bytes(original[:-1])
                    with self.assertRaises(Exception):
                        preview_database(self.database, "sessions", self.owners)
                finally:
                    if damage == "missing":
                        held.rename(path)
                    else:
                        path.write_bytes(original)
                preview_database(self.database, "sessions", self.owners)

    def _journal_path(self):
        with closing(sqlite3.connect(self.database)) as connection:
            with journal.Journal(connection, self.database) as bodies:
                return bodies.path

    def _journal_candidate_recovery(self):
        source = preview_database(self.database, "sessions", self.owners)

        def recover(connection):
            SessionCatalogStore.initialize_schema(connection)
            SessionCatalogStore.recover_inflight_rows(connection, now=100.0)

        recovering = tuple(
            replace(owner, initialize=recover) if owner.name == "SessionCatalogStore" else owner
            for owner in self.owners
        )
        chunks = []
        with projected_database(self.database, "sessions", recovering) as (
            candidate,
            connection,
            deadline,
        ):
            rows_digest(connection, deadline=deadline, emit=chunks.append)
        self.assertNotEqual(candidate.rows_digest, source.rows_digest)
        return source, candidate, chunks

    def test_journal_owner_projection_reads_same_and_recovered_rows_without_source_writes(self):
        catalog, events, original = self._journal_event()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE session_activation SET open_state='opening'")
            connection.commit()
            before = tuple(connection.iterdump())
        path = self._journal_path()
        body = path.read_bytes()
        identity = (path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns)
        source, candidate, chunks = self._journal_candidate_recovery()
        same = require_candidate_layout(source, source, self.owners)
        checked = require_candidate_layout(
            candidate,
            source,
            self.owners,
            read_candidate=lambda _, chunks=tuple(chunks): iter(chunks),
        )
        self.assertIn("session-journal", same.row_readers)
        self.assertEqual(checked.row_readers, same.row_readers)
        self.assertNotIn("canonical-private-body", repr(source))
        self.assertEqual(events.by_sequence("journal-session", original.product_seq), original)
        activation = catalog.activation("journal-session")
        assert activation is not None
        self.assertEqual(activation.open_state.value, "opening")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)
        self.assertEqual(path.read_bytes(), body)
        self.assertEqual(
            (path.stat().st_ino, path.stat().st_size, path.stat().st_mtime_ns), identity
        )

    def test_journal_missing_corrupt_and_truncated_bodies_refuse_projection_and_source_check(self):
        self._journal_event()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE session_activation SET open_state='opening'")
            connection.commit()
            before = tuple(connection.iterdump())
        source, candidate, chunks = self._journal_candidate_recovery()
        path = self._journal_path()
        body = path.read_bytes()
        for damage in ("missing", "corrupt", "truncated"):
            with self.subTest(damage=damage):
                if damage == "missing":
                    path.unlink()
                elif damage == "corrupt":
                    path.write_bytes(
                        body.replace(b"canonical-private-body", b"tampered--private-body")
                    )
                else:
                    path.write_bytes(body[:-1])
                try:
                    for operation in (
                        lambda: preview_database(self.database, "sessions", self.owners),
                        lambda: require_candidate_layout(
                            candidate,
                            source,
                            self.owners,
                            read_candidate=lambda _, chunks=tuple(chunks): iter(chunks),
                        ),
                    ):
                        with self.assertRaises((OSError, ValueError, RuntimeError)):
                            operation()
                    if damage == "missing":
                        self.assertFalse(path.exists())
                    with closing(sqlite3.connect(self.database)) as connection:
                        self.assertEqual(tuple(connection.iterdump()), before)
                finally:
                    path.write_bytes(body)

    def test_empty_journal_projection_does_not_create_body_file(self):
        for owner in STORES:
            owner(self.database)
        # No canonical body means no journal storage, including generation directories.
        path = self.database.with_suffix(journal.JOURNAL_SUFFIX)
        self.assertFalse(path.exists())
        self.assertFalse(self.database.with_suffix(SESSION_BLOCK_SUFFIX).exists())
        preview_database(self.database, "sessions", self.owners)
        self.assertFalse(path.exists())
        self.assertFalse(self.database.with_suffix(SESSION_BLOCK_SUFFIX).exists())

    def test_schema_initialization_leaves_legacy_body_for_scheduled_migration(self):
        _catalog, events, record = self._journal_event()
        record = replace(record, kind=PRODUCT_EVENT_MESSAGE_DELTA)
        encoded = json.dumps(record.payload, ensure_ascii=False, separators=(",", ":"))
        path = self._journal_path()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "UPDATE product_event SET kind=?,payload=?,payload_ref=NULL,payload_bytes=NULL,client_turn_id=NULL",
                (record.kind, encoded),
            )
            connection.execute(f"DELETE FROM {journal.BODY_TABLE}")
            connection.execute(f"UPDATE {journal.JOURNAL_TABLE} SET committed_bytes=0")
            connection.commit()
            before = tuple(connection.iterdump())
        path.unlink()
        with (
            patch.object(
                ProductEventStore, "reclaim", side_effect=AssertionError("startup vacuum")
            ),
            patch.object(
                ProductEventStore, "migrate_bodies", side_effect=AssertionError("startup migration")
            ),
            patch.object(
                ProductEventStore,
                "migrate_blocks",
                side_effect=AssertionError("startup block migration"),
            ),
            patch.object(
                journal.Journal, "put_many", side_effect=AssertionError("startup body write")
            ),
        ):
            ProductEventStore.inspect_schema(self.database)
            ProductEventStore(self.database)
            with projected_database(self.database, "sessions", self.owners) as (_, connection, _):
                row = connection.execute("SELECT payload,payload_ref FROM product_event").fetchone()
                self.assertEqual(tuple(row), (encoded, None))
        self.assertFalse(path.exists())
        self.assertEqual(events.by_sequence("journal-session", record.product_seq), record)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_fulltext_authorization_legacy_migration_matches_real_startup_without_touching_source(
        self,
    ):
        catalog = SessionCatalogStore(self.database)
        ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.row_factory = sqlite3.Row
            FulltextAuthorizer._create_schema(connection, continuation=False)
            connection.commit()
            before = tuple(connection.iterdump())
        self.assertTrue(FulltextAuthorizer.inspect_schema(self.database).add_continuation)
        owners = (
            *self.owners,
            SchemaOwner(
                "fulltext-authorizations",
                FulltextAuthorizer.inspect_connection,
                FulltextAuthorizer.initialize_schema,
                FulltextAuthorizer.inspect_rows,
            ),
        )
        with projected_database(self.database, "sessions", owners) as (
            preview,
            projected,
            _deadline,
        ):
            expected = tuple(projected.iterdump())
            self.assertIn("fulltext-authorizations", preview.row_readers)
            self.assertFalse(FulltextAuthorizer.inspect_connection(projected).needs_write)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)
        # Match the same ordered session owners used by the startup projector.
        for owner in STORES:
            owner(self.database)
        FulltextAuthorizer(self.database, catalog)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), expected)
        self.assertFalse(FulltextAuthorizer.inspect_schema(self.database).needs_write)

    def test_fulltext_authorization_rejects_unknown_schema_and_row_state(self):
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.row_factory = sqlite3.Row
            FulltextAuthorizer.initialize_schema(connection)
            connection.execute(
                f"INSERT INTO {FULLTEXT_AUTHORIZATION_TABLE} "
                "(authorization_id,session_id,snapshot_id,turn_id,authorization_type,scope_json,"
                "scope_digest,question_id,state,created_at,continuation_turn_id) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "authorization",
                    "session",
                    "snapshot",
                    "turn",
                    "research_idea_fulltext",
                    '["paper"]',
                    "digest",
                    "question",
                    "future-state",
                    1234.0,
                    "",
                ),
            )
            with self.assertRaises(ValueError):
                FulltextAuthorizer.inspect_rows(connection)
            connection.execute(
                f"ALTER TABLE {FULLTEXT_AUTHORIZATION_TABLE} ADD COLUMN future_field TEXT"
            )
            with self.assertRaises(RuntimeError):
                FulltextAuthorizer.initialize_schema(connection)

    def test_source_publication_comparison_holds_project_and_reads_real_codec(self):
        root = Path(self.directory.name)
        active = []

        expected_root = str(root)

        class Qualified(InspectionFixture):
            def selected(self, root: str) -> bool:
                if active:
                    raise AssertionError("nested directory qualification")
                return root == expected_root

            @contextmanager
            def inspection(self, root: str):
                if active:
                    raise AssertionError("nested inspection")
                active.append(root)
                try:
                    yield root
                finally:
                    active.pop()

        raw = b"future authorized content"
        image = CasPublication(digest(raw))
        CasStore.preview_new_stream(
            io.BytesIO(raw),
            raw_size_bytes=len(raw),
            expected_object_id=image.object_id,
            max_raw_bytes=len(raw),
            max_chunks=32,
            check=lambda: None,
            emit_file=image.add,
        )
        image.verify()
        reports = {"project.fixture": (image.preview(),)}
        entry = ProjectStartupSource(root, None, None)
        requests = []

        def receive(name, wanted):
            self.assertTrue(active)
            requests.append((name, wanted))
            return image

        with patch(
            "service.bootstrap._project_sqlite_owners",
            return_value=((entry, "project.fixture", ()),),
        ):
            result = check_startup_publications(
                Qualified(), startup_fixture(root), reports, receive
            )
            self.assertEqual(result, {"project.fixture": (image,)})
            self.assertEqual(requests, [("project.fixture", image.preview())])
            self.assertEqual(active, [])
            self.assertEqual(tuple(root.iterdir()), ())
            with self.assertRaisesRegex(ValueError, "coverage differs"):
                check_startup_publications(Qualified(), startup_fixture(root), {}, receive)
            changed = {"project.fixture": (replace(image.preview(), digest="0" * 64),)}
            with self.assertRaises(DomainChangedError):
                check_startup_publications(Qualified(), startup_fixture(root), changed, receive)
            self.assertEqual(active, [])
            self.assertEqual(tuple(root.iterdir()), ())

    def test_joint_recovery_projection_is_repeatable_and_matches_startup(self):
        root = Path(self.directory.name)
        content_path, imports_path = root / "content.sqlite3", root / "imports.sqlite3"
        catalog, imports = ContentCatalog(content_path), ImportJobStore(imports_path)
        catalog.accept_operation("operation", "owner", "{}", limit=10, retention=3600)
        catalog.start_operation("operation")
        catalog.record_operation_effect("operation", {"value": "private-result"})
        with closing(sqlite3.connect(content_path)) as source:
            before = tuple(source.iterdump())
            with (
                patch("service.bootstrap.CONTENT_DB", content_path),
                patch("service.bootstrap.RESOURCE_IMPORTS_DB", imports_path),
            ):
                with projected_startup_recovery(now=1234.0) as copies:
                    first = {name: value[0] for name, value in copies.items()}
                    expected = tuple(copies["content"][1].iterdump())
                    self.assertEqual(
                        copies["content"][1].execute("PRAGMA foreign_keys").fetchone()[0], 1
                    )
                    for preview, connection, deadline in copies.values():
                        self.assertEqual(
                            rows_digest(connection, deadline=deadline), preview.rows_digest
                        )
                        self.assertEqual(connection.execute("PRAGMA query_only").fetchone()[0], 1)
                with projected_startup_recovery(now=1234.0) as copies:
                    self.assertEqual({name: value[0] for name, value in copies.items()}, first)
                with projected_startup_recovery(now=1235.0) as copies:
                    self.assertNotEqual(
                        copies["content"][0].rows_digest, first["content"].rows_digest
                    )
                    self.assertEqual(
                        copies["content"][0].source_digest, first["content"].source_digest
                    )
            self.assertEqual(tuple(source.iterdump()), before)
            recover_startup_rows(
                catalog.recovery_transaction,
                imports.recovery_transaction,
                now=1234.0,
                recover_operations=True,
            )
            self.assertEqual(tuple(source.iterdump()), expected)

    def test_project_removal_projects_both_stores_and_matches_frozen_live_completion(self):
        root = Path(self.directory.name)
        content_path, imports_path, literature_path = (
            root / name for name in ("content.sqlite3", "imports.sqlite3", "literature.sqlite3")
        )
        catalog = ContentCatalog(content_path)
        ImportJobStore(imports_path)
        literature = LiteratureRepository(literature_path)
        catalog.insert_project(
            ProjectRow("removed", "Removed", str(root / "project"), "managed", 1.0)
        )
        catalog.accept_operation("remove", "owner", "{}", limit=10, retention=3600)
        catalog.start_operation("remove")
        catalog.begin_project_removal("remove", "removed")
        literature.create_collection("Removed collection", project_id="removed")
        literature.create_collection("Kept collection", project_id="other")
        pending = catalog.project_removals()
        with (
            closing(sqlite3.connect(content_path)) as content_source,
            closing(sqlite3.connect(literature_path)) as literature_source,
        ):
            before = tuple(content_source.iterdump()), tuple(literature_source.iterdump())
            with (
                patch("service.bootstrap.CONTENT_DB", content_path),
                patch("service.bootstrap.RESOURCE_IMPORTS_DB", imports_path),
                patch("service.bootstrap.SERVICE_LITERATURE_DATABASE", literature_path),
            ):
                with projected_startup_recovery(now=1234.0, project_removals=pending) as copies:
                    expected = tuple(copies["content"][1].iterdump()), tuple(
                        copies["literature"][1].iterdump()
                    )
                    previews = {name: value[0] for name, value in copies.items()}
                with projected_startup_recovery(now=1234.0, project_removals=pending) as copies:
                    self.assertEqual({name: value[0] for name, value in copies.items()}, previews)
                with self.assertRaises(DomainChangedError):
                    with projected_startup_recovery(
                        now=1234.0, project_removals=(replace(pending[0], operation_id="other"),)
                    ):
                        self.fail("changed removal plan accepted")
            self.assertEqual(
                (tuple(content_source.iterdump()), tuple(literature_source.iterdump())), before
            )
            literature.drop_project_links("removed")
            result = {"id": "removed", "removed": True, "files_kept": True}
            catalog.delete_project("removed", effect=("remove", result), now=1234.0)
            catalog.finish_operation("remove", OperationState.SUCCEEDED, result, None, now=1234.0)
            self.assertEqual(
                (tuple(content_source.iterdump()), tuple(literature_source.iterdump())), expected
            )
            self.assertEqual(len(literature.collections("other")), 1)
            self.assertFalse((root / "project").exists())

    def test_creation_recovery_projects_actual_results_and_preserves_failed_provenance(self):
        # This fixture covers owner row transitions. Native qualification and
        # receipt reads use the real platform owners in contract_lease.
        root = Path(self.directory.name)
        content_path, imports_path = root / "content.sqlite3", root / "imports.sqlite3"
        catalog, imports = ContentCatalog(content_path), ImportJobStore(imports_path)
        recoveries = []
        for operation in ("good", "unproven", "lost"):
            project = root / operation
            if operation != "lost":
                project.mkdir()
                (project / "user.txt").write_bytes(b"keep these bytes")
            catalog.accept_operation(
                operation,
                "owner",
                json.dumps({"kind": "CreateProject", "parameters": {"name": operation}}),
                limit=10,
                retention=3600,
            )
            catalog.start_operation(operation)
            creation = catalog.begin_project_creation(
                operation, ProjectRow(operation, operation, str(project), "managed", 1.0)
            )
            identity = "fixture-directory-" + operation
            if operation == "lost":
                catalog.record_project_creation_identity(operation, identity)
                creation = replace(creation, directory_identity=identity)
            catalog.defer_project_creation(operation, now=1000.0)
            observation = CreationObservation(
                operation,
                project,
                "verified" if operation == "good" else "unproven",
                identity,
                _receipt(creation, identity) if operation == "good" else b"unowned receipt",
            )
            if operation == "lost":
                observation = CreationObservation(operation, project, "lost")
            reference = (
                ProjectRegistry.creation_result(creation.plan) if operation == "good" else None
            )
            recoveries.append(ProjectCreationRecovery(creation, observation, reference))
        recoveries.sort(key=lambda row: row.creation.operation_id)
        with (
            closing(sqlite3.connect(content_path)) as source,
            patch("service.bootstrap.CONTENT_DB", content_path),
            patch("service.bootstrap.RESOURCE_IMPORTS_DB", imports_path),
        ):
            before = tuple(source.iterdump())
            with projected_startup_recovery(
                now=1234.0, project_creations=tuple(recoveries)
            ) as copies:
                expected = tuple(copies["content"][1].iterdump())
                preview = copies["content"][0]
            with projected_startup_recovery(
                now=1234.0, project_creations=tuple(recoveries)
            ) as copies:
                self.assertEqual(copies["content"][0], preview)
            with self.assertRaises(DomainChangedError):
                with projected_startup_recovery(
                    now=1234.0, project_creations=tuple(recoveries[:1])
                ):
                    self.fail("incomplete creation inventory projected")
            self.assertEqual(tuple(source.iterdump()), before)
            recover_startup_rows(
                catalog.recovery_transaction,
                imports.recovery_transaction,
                now=1234.0,
                recover_operations=True,
            )
            registry = ProjectRegistry(str(root), catalog)
            for recovery in recoveries:
                operation = recovery.creation.operation_id
                catalog.resume_project_creation(operation, "owner", now=1234.0)
                if recovery.result is None:
                    catalog.defer_project_creation(operation, now=1234.0)
                else:
                    catalog.record_project_creation_identity(
                        operation, recovery.observation.identity
                    )
                    result = registry.commit_creation(
                        recovery.creation.plan, operation_id=operation
                    )
                    self.assertEqual(result, recovery.result)
                    catalog.finish_operation(
                        operation, OperationState.SUCCEEDED, asdict(result), None, now=1234.0
                    )
            self.assertEqual(tuple(source.iterdump()), expected)
            self.assertEqual(
                catalog.project_creations(),
                tuple(
                    sorted(
                        (row.creation for row in recoveries if row.result is None),
                        key=lambda row: row.operation_id,
                    )
                ),
            )
            self.assertFalse((root / "lost").exists())
            operation_result = catalog.operation_result("owner", "good")
            assert operation_result is not None
            self.assertEqual(operation_result["result"], asdict(recoveries[0].result))
            for operation in ("good", "unproven"):
                self.assertEqual((root / operation / "user.txt").read_bytes(), b"keep these bytes")

    def test_absent_creation_is_deferred_without_predicting_identity_or_mutating_source(self):
        root = Path(self.directory.name)
        catalog = ContentCatalog(root / "content.sqlite3")
        catalog.accept_operation(
            "create",
            "owner",
            json.dumps({"kind": "CreateProject", "parameters": {"name": "New"}}),
            limit=10,
            retention=3600,
        )
        catalog.start_operation("create")
        plan = ProjectRow("new", "New", str(root / "missing"), "managed", 1.0)
        creation = catalog.begin_project_creation("create", plan)
        snapshot = replace(
            startup_fixture(root),
            unavailable_projects=(),
            catalog=ContentCatalog.read_roots(catalog.path),
            workspace=root,
            creation_observations=(CreationObservation("create", Path(plan.dir_root), "absent"),),
            pending_legacy_seeds=(),
            project_storage=(),
        )
        self.assertIsNone(startup_creation_recovery(InspectionFixture(), snapshot))
        imports = root / "imports.sqlite3"
        ImportJobStore(imports)
        groups = (
            (
                catalog.path,
                "content",
                (
                    SchemaOwner(
                        "content",
                        ContentCatalog.inspect_connection,
                        ContentCatalog.initialize_schema,
                        ContentCatalog.inspect_rows,
                    ),
                ),
            ),
            (
                imports,
                "imports",
                (
                    SchemaOwner(
                        "imports",
                        ImportJobStore.inspect_connection,
                        ImportJobStore.initialize_schema,
                        ImportJobStore.inspect_rows,
                    ),
                ),
            ),
        )

        class Qualified(InspectionFixture):
            def inspection(self, root: str):
                return nullcontext(root)

        with (
            closing(sqlite3.connect(catalog.path)) as source,
            patch("service.bootstrap._startup_sqlite_owners", return_value=groups),
        ):
            before = tuple(source.iterdump())
            coverage = {}
            # The deferred batch must not even ask for future directory results.
            with (
                patch(
                    "service.bootstrap.startup_creation_recovery",
                    side_effect=AssertionError("predicted future identity"),
                ),
                patch(
                    "service.bootstrap.startup_removal_plans",
                    side_effect=AssertionError("removal overtook creation"),
                ),
            ):
                previews = preview_startup_sqlite(
                    Qualified(),
                    snapshot,
                    recovery_at=1234,
                    recovery_id="a" * 64,
                    recovery_report=coverage,
                )
                self.assertEqual(coverage["blocked"], [])
                for wanted in previews:
                    chunks = []
                    export_startup_sqlite(
                        Qualified(),
                        snapshot,
                        wanted,
                        chunks.append,
                        recovery_at=1234,
                        recovery_id="a" * 64,
                    )
                    self.assertTrue(chunks)
            self.assertEqual(tuple(source.iterdump()), before)
        self.assertEqual(catalog.project_creations(), (creation,))
        self.assertFalse(Path(plan.dir_root).exists())

    def test_removal_plan_requires_complete_qualified_roots_and_real_workspace_rule(self):
        root = Path(self.directory.name).resolve()
        catalog = ContentCatalog(root / "content.sqlite3")
        project = root / "project"
        workspace = root / "workspace"
        legacy = root / "legacy"
        catalog.insert_project(ProjectRow("removed", "Removed", str(project), "managed", 1.0))
        catalog.accept_operation("remove", "owner", "{}", limit=10, retention=3600)
        catalog.start_operation("remove")
        catalog.begin_project_removal("remove", "removed")
        inventory = ContentCatalog.read_roots(catalog.path)
        self.assertEqual(inventory.project_removal_plans, catalog.project_removals())
        snapshot = replace(
            startup_fixture(root),
            unavailable_projects=(),
            catalog=inventory,
            workspace=workspace,
            legacy_seeds=((legacy, "legacy"),),
        )
        service = root / "service"
        service_patch = patch("service.bootstrap.SERVICE_DIR", service)
        service_patch.start()
        self.addCleanup(service_patch.stop)
        qualified = {str(service), str(workspace), str(project)}
        active = set()

        @contextmanager
        def inspection(path):
            self.assertIn(path, qualified)
            self.assertNotIn(path, active)
            active.add(path)
            try:
                yield path
            finally:
                active.remove(path)

        class Qualified(InspectionFixture):
            def selected(self, root: str) -> bool:
                return root in qualified

            def inspection(self, root: str):
                return inspection(root)

        domains = Qualified()
        with startup_removal_plans(domains, snapshot) as plans:
            self.assertIsNone(plans)
            self.assertEqual(active, {str(service)})
        qualified.add(str(legacy))
        with startup_removal_plans(domains, snapshot) as plans:
            self.assertEqual(plans, catalog.project_removals())
            self.assertEqual(len(active), 1)
        self.assertEqual(active, set())
        snapshot = replace(snapshot, workspace=project)
        with self.assertRaises(ContentError):
            with startup_removal_plans(domains, snapshot):
                self.fail("current workspace removal accepted")
        self.assertEqual(active, set())
        snapshot = replace(
            snapshot, workspace=workspace, catalog=replace(inventory, project_removal_plans=())
        )
        with self.assertRaises(DomainChangedError):
            with startup_removal_plans(domains, snapshot):
                self.fail("incomplete removal inventory accepted")

    def test_legacy_seed_plan_survives_reprojection_without_creating_roots(self):
        root = Path(self.directory.name)
        content_path, imports_path = root / "content.sqlite3", root / "imports.sqlite3"
        catalog = ContentCatalog(content_path)
        ImportJobStore(imports_path)
        entries = ((root / "legacy", " First "), (root / "legacy", "Duplicate"))
        plans = ProjectRegistry.legacy_plans(entries, now=1234.0, attempt="a" * 64)
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0].display_name, "First")
        self.assertEqual(ProjectRegistry.legacy_plans(entries, now=1234.0, attempt="a" * 64), plans)
        self.assertNotEqual(
            ProjectRegistry.legacy_plans(entries, now=1234.0, attempt="b" * 64)[0].project_id,
            plans[0].project_id,
        )
        self.assertRegex(plans[0].project_id, r"^[0-9a-hjkmnp-tv-z]{26}$")
        with (
            patch("service.bootstrap.CONTENT_DB", content_path),
            patch("service.bootstrap.RESOURCE_IMPORTS_DB", imports_path),
        ):
            with projected_startup_recovery(now=1234.0, legacy_plans=plans) as copies:
                expected = tuple(copies["content"][1].iterdump())
                preview = copies["content"][0]
            with projected_startup_recovery(now=1234.0, legacy_plans=plans) as copies:
                self.assertEqual(copies["content"][0], preview)
        self.assertEqual(catalog.projects(), ())
        with catalog.recovery_transaction() as connection:
            for plan in plans:
                ContentCatalog.insert_project_rows(connection, plan)
        with closing(sqlite3.connect(content_path)) as connection:
            self.assertEqual(tuple(connection.iterdump()), expected)
        self.assertEqual(ProjectRegistry.pending_legacy_seeds(entries, (root / "legacy",)), ())
        self.assertEqual(catalog.project(plans[0].project_id), plans[0])
        self.assertFalse((root / "legacy").exists())

    def test_recovered_preview_exports_the_same_rows_without_touching_sources(self):
        # Directory admission is supplied by the native owner in production;
        # this fixture exercises only composition and the private row transport.
        class Qualified(InspectionFixture):
            @contextmanager
            def inspection(self, root):
                yield root

        root = Path(self.directory.name)
        content_path, imports_path = root / "content.sqlite3", root / "imports.sqlite3"
        catalog = ContentCatalog(content_path)
        ImportJobStore(imports_path)
        catalog.accept_operation("operation", "owner", "{}", limit=10, retention=3600)
        catalog.start_operation("operation")
        snapshot = replace(
            startup_fixture(root),
            unavailable_projects=(),
            pending_legacy_seeds=((root / "legacy", "Legacy"),),
            project_storage=(),
            catalog=ContentCatalog.read_roots(content_path),
        )
        groups = (
            (
                content_path,
                "content",
                (
                    SchemaOwner(
                        "content",
                        ContentCatalog.inspect_connection,
                        ContentCatalog.initialize_schema,
                        ContentCatalog.inspect_rows,
                    ),
                ),
            ),
            (
                imports_path,
                "imports",
                (
                    SchemaOwner(
                        "imports",
                        ImportJobStore.inspect_connection,
                        ImportJobStore.initialize_schema,
                        ImportJobStore.inspect_rows,
                    ),
                ),
            ),
        )
        with (
            closing(sqlite3.connect(content_path)) as source,
            patch("service.bootstrap._startup_sqlite_owners", return_value=groups),
        ):
            before = tuple(source.iterdump())
            coverage = {}
            previews = preview_startup_sqlite(
                Qualified(),
                snapshot,
                recovery_at=1234,
                recovery_id="a" * 64,
                recovery_report=coverage,
            )
            self.assertEqual(
                coverage, {"version": 1, "at": 1234, "attempt": "a" * 64, "blocked": []}
            )
            # Partial SQL projections remain useful for discovery, but their
            # native consumer must not mistake them for full recovery coverage.
            incomplete = {}
            with patch("service.bootstrap.startup_creation_recovery", return_value=None):
                partial = preview_startup_sqlite(
                    Qualified(),
                    snapshot,
                    recovery_at=1234,
                    recovery_id="a" * 64,
                    recovery_report=incomplete,
                )
            self.assertTrue(partial)
            self.assertEqual(incomplete["blocked"], ["project-creations"])
            self.assertEqual(tuple(source.iterdump()), before)

            for wanted in previews:
                chunks = []
                export_startup_sqlite(
                    Qualified(),
                    snapshot,
                    wanted,
                    chunks.append,
                    recovery_at=1234,
                    recovery_id="a" * 64,
                )
                self.assertTrue(chunks)
                # Decode through the source-version layout/row path, not a
                # fixture parser with different validation rules.
                owners = next(owners for _, name, owners in groups if name == wanted.name)
                current = preview_database(
                    next(path for path, name, _ in groups if name == wanted.name),
                    wanted.name,
                    owners,
                )
                check = require_candidate_layout(
                    wanted,
                    current,
                    owners,
                    read_candidate=lambda _, chunks=tuple(chunks): iter(chunks),
                )
                self.assertEqual(check.row_readers, wanted.row_readers)
            self.assertEqual(tuple(source.iterdump()), before)
            with self.assertRaisesRegex(RuntimeError, "changed before row export"):
                export_startup_sqlite(
                    Qualified(),
                    snapshot,
                    previews[0],
                    lambda _: None,
                    recovery_at=1235,
                    recovery_id="a" * 64,
                )
            self.assertEqual(tuple(source.iterdump()), before)
        self.assertEqual(catalog.projects(), ())
        self.assertFalse((root / "legacy").exists())

    def test_absent_database_preview_matches_actual_startup_without_creating_sources(self):
        preview = preview_database(self.database, "sessions", self.owners)
        self.assertFalse(preview.present)
        self.assertFalse(self.database.parent.exists())
        for owner in STORES:
            owner(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            actual = tuple(
                SchemaObject(*row)
                for row in connection.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
                )
                if not row[1].lower().startswith("sqlite_")
            )
        self.assertEqual(preview.objects, actual)

    def test_source_readers_accept_own_candidate_layout_without_initializing_source(self):
        preview = preview_database(self.database, "sessions", self.owners)
        candidate = decode_previews(json.loads(json.dumps([asdict(preview)])))[0]
        check = require_candidate_layout(candidate, preview, self.owners)
        self.assertEqual(check.source_digest, preview.source_digest)
        self.assertEqual(check.owners, preview.owners)
        self.assertEqual(
            check.row_readers,
            tuple(owner.name for owner in self.owners if owner.read_rows is not None),
        )
        self.assertFalse(self.database.parent.exists())

    def test_different_candidate_rows_require_direct_source_reading(self):
        preview = preview_database(self.database, "sessions", self.owners)
        candidate = replace(preview, rows_digest="0" * 64)
        with self.assertRaises(CandidateRowsRequired):
            require_candidate_layout(candidate, preview, self.owners)
        with self.assertRaisesRegex(ValueError, "reader coverage changed"):
            require_candidate_layout(preview, replace(preview, row_readers=()), self.owners)

    def test_user_database_previews_match_their_actual_initializers(self):
        cases = (
            (
                "imports",
                SchemaOwner(
                    "imports", ImportJobStore.inspect_connection, ImportJobStore.initialize_schema
                ),
                ImportJobStore,
            ),
            (
                "content",
                SchemaOwner(
                    "content", ContentCatalog.inspect_connection, ContentCatalog.initialize_schema
                ),
                ContentCatalog,
            ),
            (
                "handoff",
                SchemaOwner(
                    "handoff",
                    HandoffClaimStore.inspect_connection,
                    HandoffClaimStore.initialize_schema,
                ),
                lambda path: HandoffClaimStore(path).ensure_schema(),
            ),
            (
                "credentials",
                SchemaOwner(
                    "credentials",
                    ModelCredentialStore.inspect_connection,
                    ModelCredentialStore.initialize_schema,
                ),
                lambda path: ModelCredentialStore(path).ensure_schema(),
            ),
            (
                "literature",
                SchemaOwner("literature", inspect_literature, initialize_literature),
                lambda path: connect_literature(path).close(),
            ),
        )
        for name, owner, initialize in cases:
            with self.subTest(owner=name):
                database = Path(self.directory.name) / name / "database.sqlite3"
                preview = preview_database(database, name, (owner,))
                require_candidate_layout(preview, preview, (owner,))
                self.assertFalse(database.parent.exists())
                initialize(database)
                with closing(sqlite3.connect(database)) as connection:
                    actual = tuple(
                        SchemaObject(*row)
                        for row in connection.execute(
                            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
                        )
                        if not row[1].lower().startswith("sqlite_")
                    )
                self.assertEqual(preview.objects, actual)

    def test_credential_values_remain_private_and_untouched(self):
        store = ModelCredentialStore(self.database)
        store.ensure_schema()
        owners = (SchemaOwner("credentials", store.inspect_connection, store.initialize_schema),)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "INSERT INTO model_credentials (owner_id,connection_id,generation,state,access_token,refresh_token) VALUES (?,?,?,?,?,?)",
                (
                    "owner",
                    "connection",
                    4,
                    "active",
                    "private-access-marker",
                    "private-refresh-marker",
                ),
            )
            connection.commit()
            before = tuple(connection.iterdump())
            preview = preview_database(self.database, "credentials", owners)
            require_candidate_layout(preview, preview, owners)
            self.assertEqual(tuple(connection.iterdump()), before)
            self.assertNotIn("private-access-marker", repr(preview))
            self.assertNotIn("private-refresh-marker", repr(preview))

    def test_missing_project_storage_preview_matches_actual_initialization(self):
        root = Path(self.directory.name) / "project"
        root.mkdir()
        database = root / PROJECT_DB_RELATIVE
        with patch(
            "service.persistence.preview.database_files",
            side_effect=AssertionError("absent directory must not be opened"),
        ):
            preview = preview_database(None, "project.missing", PROJECT_OWNERS)
        self.assertFalse(preview.present)
        self.assertFalse(database.parent.exists())
        require_candidate_layout(preview, preview, PROJECT_OWNERS)
        VersionStore(database, root).ensure()
        initialize_resource_catalog(database, root)
        with closing(sqlite3.connect(database)) as connection:
            actual = tuple(
                SchemaObject(*row)
                for row in connection.execute(
                    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name,tbl_name"
                )
                if not row[1].lower().startswith("sqlite_")
            )
        self.assertEqual(preview.objects, actual)

    def test_source_checks_streamed_candidate_ledger_against_physical_cas(self):
        # Contract composition fixture; directory qualification itself is covered
        # by native suites, not by this no-op inspection capability.
        root = Path(self.directory.name) / "candidate-project"
        root.mkdir()
        cas = CasStore(root / PROJECT_VERSIONS_RELATIVE)
        identifier = cas.put(b"candidate ledger object", "text/plain")
        descriptor = cas.verify(identifier)
        name = "project.contract"
        source = preview_database(None, name, PROJECT_OWNERS)

        def initialize_candidate(connection):
            VersionStore.initialize_schema(connection)
            VersionStore._record_object(connection, descriptor, 1)

        owners = tuple(
            (
                replace(owner, initialize=initialize_candidate)
                if owner.name == "resource-versions"
                else owner
            )
            for owner in PROJECT_OWNERS
        )
        with projected_database(None, name, owners) as (candidate, connection, deadline):
            chunks = []
            rows_digest(connection, deadline=deadline, emit=chunks.append)
        location = ProjectStartupSource(root, None, None)
        domains = InspectionFixture()
        with (
            patch("service.bootstrap._startup_sqlite_owners", return_value=()),
            patch(
                "service.bootstrap._project_sqlite_owners",
                return_value=((location, name, PROJECT_OWNERS),),
            ),
        ):
            arguments = (
                json.loads(json.dumps([asdict(candidate)])),
                (source,),
                startup_fixture(root),
            )
            check_startup_sqlite(
                *arguments, domains=domains, read_candidate=lambda _preview: iter(chunks)
            )
            # Remove the complete object through the real GC transition. The
            # candidate rows still declare it READY and must no longer pass.
            cas.apply_gc(GcPlan((GcEntry(CasEntryKind.OBJECT, identifier, "epoch"),), ()))
            with self.assertRaisesRegex(ValueError, "unavailable CAS object"):
                check_startup_sqlite(
                    *arguments, domains=domains, read_candidate=lambda _preview: iter(chunks)
                )

    def test_project_provenance_unknown_row_version_is_rejected_without_writes(self):
        root = Path(self.directory.name)
        VersionStore(self.database, root).ensure()
        initialize_resource_catalog(self.database, root)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                f"INSERT INTO {AGENT_IMPORTS_TABLE} (import_id,resource_path,source_kind,source_session_id,schema_version,imported_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                ("import", "private/resource", "message", "session", 999, 1, 1),
            )
            connection.commit()
            before = tuple(connection.iterdump())
            with self.assertRaisesRegex(RuntimeError, "unsupported resource provenance version"):
                preview_database(self.database, "project.invalid", PROJECT_OWNERS)
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_legacy_literature_note_migration_is_only_applied_to_memory(self):
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "CREATE TABLE literature_notes(id TEXT,literature_id TEXT REFERENCES literature_items(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at REAL NOT NULL,PRIMARY KEY(literature_id,id))"
            )
            connection.execute(
                "INSERT INTO literature_notes VALUES ('note','paper','private-note-marker',1)"
            )
            connection.commit()
            before = tuple(connection.iterdump())
            owner = SchemaOwner("literature", inspect_literature, initialize_literature)
            preview = preview_database(self.database, "literature", (owner,))
            require_candidate_layout(preview, preview, (owner,))
            self.assertEqual(tuple(connection.iterdump()), before)
            self.assertNotIn("private-note-marker", repr(preview))
            note = next(row for row in preview.objects if row.name == "literature_notes")
            self.assertIn("position", note.sql)

    def test_direct_layout_call_rejects_unsupported_extra_objects(self):
        preview = preview_database(self.database, "sessions", self.owners)
        candidate = replace(
            preview,
            objects=(
                *preview.objects,
                SchemaObject("trigger", "escape", SESSION_CATALOG_TABLE, "CREATE TRIGGER escape"),
            ),
        )
        with self.assertRaises(ValueError):
            require_candidate_layout(candidate, preview, self.owners)

    def test_project_receipt_trigger_is_compiled_from_the_owner_and_not_wire_authority(self):
        preview = preview_database(None, "project", PROJECT_OWNERS)
        trigger = next(row for row in preview.objects if row.kind == "trigger")
        self.assertEqual(trigger.name, "resources_operation_version_expired")
        candidate = decode_previews(json.loads(json.dumps([asdict(preview)])))[0]
        require_candidate_layout(candidate, preview, PROJECT_OWNERS)
        altered = replace(
            trigger, sql=trigger.sql.replace("resources_operations", "resources_versions")
        )
        candidate = replace(
            preview, objects=tuple(altered if row == trigger else row for row in preview.objects)
        )
        with self.assertRaisesRegex(ValueError, "trigger declaration"):
            require_candidate_layout(candidate, preview, PROJECT_OWNERS)

    def test_missing_receipt_trigger_is_projected_without_repairing_source(self):
        store = VersionStore(self.database, Path(self.directory.name))
        store.ensure()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("DROP TRIGGER resources_operation_version_expired")
            connection.commit()
            before = tuple(connection.iterdump())
            self.assertEqual(
                store.inspect_schema(self.database).create_triggers,
                ("resources_operation_version_expired",),
            )
            preview = preview_database(self.database, "project", PROJECT_OWNERS)
            self.assertTrue(any(row.kind == "trigger" for row in preview.objects))
            self.assertEqual(tuple(connection.iterdump()), before)
        store.ensure()
        self.assertFalse(store.inspect_schema(self.database).needs_write)

    def test_streamed_rows_are_imported_before_owned_insert_triggers_are_installed(self):
        # Transport mechanism fixture: an INSERT trigger would duplicate the
        # captured audit rows if replay installed it before loading the data.
        trigger = "CREATE TRIGGER record_write AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(new.id,new.value); END"
        observed = []

        def inspect(connection):
            objects = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
            return FixtureSchema(needs_write=not {"items", "audit", "record_write"} <= objects)

        def initialize(connection):
            connection.execute("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT)")
            connection.execute("CREATE TABLE audit(id INTEGER PRIMARY KEY,value TEXT)")
            connection.execute(trigger)

        def migrate(connection):
            initialize(connection)
            connection.execute("INSERT INTO items VALUES(7,'private-row')")

        def read_rows(connection):
            observed.append(
                (
                    tuple(connection.execute("SELECT * FROM items")),
                    tuple(connection.execute("SELECT * FROM audit")),
                )
            )

        own = SchemaOwner(
            "records", inspect, initialize, read_rows, lambda: (("record_write", "items", trigger),)
        )
        candidate_owner = replace(own, initialize=migrate)
        source = preview_database(None, "records", (own,))
        with projected_database(None, "records", (candidate_owner,)) as (
            candidate,
            connection,
            deadline,
        ):
            chunks = []
            rows_digest(connection, deadline=deadline, emit=chunks.append)
            observed.clear()
            check = require_candidate_layout(
                candidate, source, (own,), read_candidate=lambda _wanted: iter(chunks)
            )
            self.assertEqual(check.row_readers, ("records",))
            self.assertEqual(len(observed), 1)
            self.assertEqual(tuple(observed[0][0][0]), (7, "private-row"))
            self.assertEqual(tuple(observed[0][1][0]), (7, "private-row"))

    def test_changed_source_receipt_trigger_is_preserved_and_never_repaired_silently(self):
        store = VersionStore(self.database, Path(self.directory.name))
        store.ensure()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("DROP TRIGGER resources_operation_version_expired")
            connection.execute(
                "CREATE TRIGGER resources_operation_version_expired AFTER DELETE ON resources_operation_versions BEGIN DELETE FROM resources_versions; END"
            )
            connection.commit()
            before = tuple(connection.iterdump())
            for operation in (
                lambda: store.inspect_schema(self.database),
                store.ensure,
                lambda: preview_database(self.database, "project", PROJECT_OWNERS),
            ):
                with self.assertRaises((ValueError, RuntimeError)):
                    operation()
                self.assertEqual(tuple(connection.iterdump()), before)

    def test_source_readers_reject_candidate_missing_owned_table(self):
        preview = preview_database(self.database, "sessions", self.owners)
        candidate = replace(
            preview,
            objects=tuple(row for row in preview.objects if row.table != SESSION_CATALOG_TABLE),
        )
        with self.assertRaises((ValueError, RuntimeError, sqlite3.Error)):
            require_candidate_layout(candidate, preview, self.owners)
        self.assertFalse(self.database.parent.exists())

    def test_source_digest_and_owner_coverage_cannot_be_substituted(self):
        preview = preview_database(self.database, "sessions", self.owners)
        for candidate in (
            replace(preview, source_digest="0" * 64),
            replace(preview, owners=preview.owners[:-1]),
            replace(preview, present=True),
        ):
            with self.assertRaisesRegex(ValueError, "source or ownership"):
                require_candidate_layout(candidate, preview, self.owners)

    def test_layout_wire_rejects_unknown_and_executable_object_kinds(self):
        preview = asdict(preview_database(self.database, "sessions", self.owners))
        value = json.loads(json.dumps(preview))
        for invalid in (
            {**value, "approved": True},
            {
                **value,
                "objects": [
                    {
                        "kind": "view",
                        "name": "escape",
                        "table": "escape",
                        "sql": "CREATE VIEW escape",
                    }
                ],
            },
            {**value, "owners": value["owners"] * 2},
        ):
            with self.assertRaises(ValueError):
                decode_previews([invalid])

    def test_sql_replay_cannot_attach_a_database(self):
        preview = preview_database(self.database, "sessions", self.owners)
        outside = Path(self.directory.name) / "outside.sqlite3"
        candidate = replace(
            preview,
            objects=(
                SchemaObject("table", "escape", "escape", f"ATTACH DATABASE '{outside}' AS escape"),
            ),
        )
        with self.assertRaises(ValueError):
            require_candidate_layout(candidate, preview, self.owners)
        self.assertFalse(outside.exists())

    def test_committed_wal_rows_affect_identity_but_never_leave_the_preview(self):
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("CREATE TABLE private_payload (body TEXT)")
            writer.execute("INSERT INTO private_payload VALUES (?)", ("private-preview-marker",))
            writer.commit()
            before = tuple(writer.iterdump())
            first = preview_database(self.database, "sessions", self.owners)
            self.assertEqual(tuple(writer.iterdump()), before)
            self.assertNotIn("private-preview-marker", repr(first))
            writer.execute("UPDATE private_payload SET body = ?", ("changed-private-marker",))
            writer.commit()
            second = preview_database(self.database, "sessions", self.owners)
            self.assertNotEqual(first.source_digest, second.source_digest)
            self.assertNotEqual(first.rows_digest, second.rows_digest)
            self.assertEqual(first.objects, second.objects)
            self.assertNotIn("changed-private-marker", repr(second))

    def test_unsupported_source_layout_is_retained_without_migration(self):
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(f"CREATE TABLE {SESSION_CATALOG_TABLE} (unsupported TEXT)")
            connection.execute(f"INSERT INTO {SESSION_CATALOG_TABLE} VALUES ('keep')")
            connection.commit()
            before = tuple(connection.iterdump())
            with self.assertRaises(RuntimeError):
                preview_database(self.database, "sessions", self.owners)
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_large_snapshot_and_changed_candidate_rows_preserve_source(self):
        # Exceed the former 256 MiB total with small individual values. Keep
        # transport bytes in a scoped file, never a whole-stream Python list.
        self.database.parent.mkdir()
        payload_bytes = 1024 * 1024
        row_count = 272

        def inspect(connection):
            return FixtureSchema(needs_write=False)

        def initialize(connection):
            pass

        def read_rows(connection):
            self.assertEqual(
                connection.execute("SELECT count(*),sum(length(payload)) FROM records").fetchone()[
                    :
                ],
                (row_count, row_count * payload_bytes),
            )

        owner = SchemaOwner("records", inspect, initialize, read_rows)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute(
                "CREATE TABLE records (id INTEGER PRIMARY KEY, payload BLOB, marker INTEGER)"
            )
            connection.executemany(
                "INSERT INTO records VALUES (?,zeroblob(?),0)",
                ((i, payload_bytes) for i in range(row_count)),
            )
            connection.commit()

        def source_digest():
            with self.database.open("rb") as source:
                return hashlib.file_digest(source, "sha256").hexdigest()

        before = source_digest()
        source = preview_database(self.database, "records", (owner,))

        def migrate(connection):
            connection.execute("UPDATE records SET marker=1 WHERE id=0")

        candidate_owner = replace(owner, initialize=migrate)
        with tempfile.TemporaryFile(dir=self.directory.name) as stream:
            with projected_database(self.database, "records", (candidate_owner,)) as (
                candidate,
                connection,
                deadline,
            ):
                self.assertNotEqual(source.rows_digest, candidate.rows_digest)

                def emit(chunk: bytes) -> None:
                    stream.write(chunk)

                rows_digest(connection, deadline=deadline, emit=emit)
            self.assertGreater(stream.tell(), 256 * 1024 * 1024)
            stream.seek(0)
            checked = require_candidate_layout(
                candidate,
                source,
                (owner,),
                read_candidate=lambda _: iter(lambda: stream.read(64 * 1024), b""),
            )
        self.assertEqual(checked.row_readers, ("records",))
        self.assertEqual(source_digest(), before)

    def test_snapshot_limit_rejects_before_running_owner_migrations(self):
        SessionCatalogStore(self.database)
        with patch("service.persistence.preview.MAX_SNAPSHOT_BYTES", 1):
            with self.assertRaisesRegex(SnapshotBudgetExceeded, "budget exceeded"):
                preview_database(self.database, "sessions", self.owners)
        self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)

    def test_invocation_projection_reads_real_records_and_rejects_unknown_status(self):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        store = AssistantInvocationStore(self.database)
        store.claim(
            AssistantInvocationRecord(
                invocation_id="invocation",
                owner_id="owner",
                client_action_id="action",
                client_attempt_id="attempt",
                retry_of_attempt_id=None,
                kind="translate",
                request_hash="hash",
                project_id="project",
                source_id="source",
                source_revision=None,
                prompt_version="1",
                status=ModelInvocationStatus.PENDING,
                target_language="en",
                output_text="private-output-marker",
            )
        )
        owner = SchemaOwner(
            "invocations", store.inspect_connection, store.initialize_schema, store.inspect_rows
        )
        preview = preview_database(self.database, "invocations", (owner,))
        self.assertNotIn("private-output-marker", repr(preview))
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute(
                "UPDATE assistant_model_invocation SET status='future-unsupported-state'"
            )
            writer.commit()
            before = tuple(writer.iterdump())
            with self.assertRaises(ValueError):
                preview_database(self.database, "invocations", (owner,))
            self.assertEqual(tuple(writer.iterdump()), before)

    def test_import_projection_decodes_jobs_results_and_events_without_recovery(self):
        store = ImportJobStore(self.database)
        job = store.create(
            owner_id="owner",
            project_id="project",
            mode=ImportMode.COPY,
            target_dir="resources",
            sources=("/private-source-marker",),
            request_digest="request",
            idempotency_key="attempt",
        )
        owner = SchemaOwner(
            "imports", store.inspect_connection, store.initialize_schema, store.inspect_rows
        )
        before_job = store.get(job.job_id, "owner")
        preview = preview_database(self.database, "imports", (owner,))
        self.assertEqual(store.get(job.job_id, "owner"), before_job)
        self.assertNotIn("private-source-marker", repr(preview))
        for statement in (
            "UPDATE resource_import_jobs SET status='future-state'",
            "UPDATE resource_import_results SET status='future-result'",
            "UPDATE resource_import_events SET data_json='{broken'",
        ):
            with (
                self.subTest(statement=statement),
                closing(sqlite3.connect(self.database)) as writer,
            ):
                writer.execute(statement)
                writer.commit()
                before = tuple(writer.iterdump())
                with self.assertRaises(ValueError):
                    preview_database(self.database, "imports", (owner,))
                self.assertEqual(tuple(writer.iterdump()), before)
                # Restore only this test's intentionally corrupted field before
                # checking another actual reader; never run recovery workers.
                writer.execute("UPDATE resource_import_jobs SET status='queued'")
                writer.execute("UPDATE resource_import_results SET status='pending'")
                writer.execute("UPDATE resource_import_events SET data_json='{}'")
                writer.commit()

    def test_row_reader_has_no_write_authority_on_the_projected_copy(self):
        def forbidden_write(connection):
            connection.execute("CREATE TABLE unexpected(value TEXT)")

        owner = SchemaOwner(
            "invocations",
            AssistantInvocationStore.inspect_connection,
            AssistantInvocationStore.initialize_schema,
            forbidden_write,
        )
        with self.assertRaisesRegex(sqlite3.OperationalError, "readonly"):
            preview_database(self.database, "invocations", (owner,))
        self.assertFalse(self.database.parent.exists())

    def test_source_invocation_reader_checks_actual_changed_candidate_rows(self):
        self.database.parent.mkdir(parents=True, exist_ok=True)
        store = AssistantInvocationStore(self.database)
        store.claim(
            AssistantInvocationRecord(
                invocation_id="invocation",
                owner_id="owner",
                client_action_id="action",
                client_attempt_id="attempt",
                retry_of_attempt_id=None,
                kind="translate",
                request_hash="hash",
                project_id="project",
                source_id="source",
                source_revision=None,
                prompt_version="1",
                status=ModelInvocationStatus.PENDING,
                target_language="en",
                output_text="private-original",
            )
        )
        owner = SchemaOwner(
            "invocations", store.inspect_connection, store.initialize_schema, store.inspect_rows
        )
        source = preview_database(self.database, "invocations", (owner,))
        for status in ("pending", "future-unsupported-state"):

            def initialize(connection, status=status):
                store.initialize_schema(connection)
                connection.execute(
                    "UPDATE assistant_model_invocation SET output_text='private-candidate',status=?",
                    (status,),
                )

            # A candidate may introduce a new codec; only the old version's
            # actual reader determines whether its output remains readable.
            candidate_owner = SchemaOwner(owner.name, owner.inspect, initialize)
            with projected_database(self.database, "invocations", (candidate_owner,)) as (
                candidate,
                connection,
                deadline,
            ):
                chunks = []
                rows_digest(connection, deadline=deadline, emit=chunks.append)
                self.assertNotEqual(candidate.rows_digest, source.rows_digest)
                received = []

                def receive(wanted, candidate=candidate, chunks=tuple(chunks), received=received):
                    self.assertEqual(wanted, candidate)
                    received.append(wanted.name)
                    return iter(chunks)

                if status == "pending":
                    check = require_candidate_layout(
                        candidate, source, (owner,), read_candidate=receive
                    )
                    self.assertEqual(check.row_readers, ("invocations",))
                else:
                    with self.assertRaises(ValueError):
                        require_candidate_layout(
                            candidate, source, (owner,), read_candidate=receive
                        )
                self.assertEqual(received, ["invocations"])
        self.assertEqual(preview_database(self.database, "invocations", (owner,)), source)


if __name__ == "__main__":
    unittest.main()
