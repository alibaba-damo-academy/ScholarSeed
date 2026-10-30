"""Real SQLite initialization, connection ownership, and atomic transaction contracts."""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from errno import ENOSPC
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from service.assistant.persistence.citations import CitationStore
from service.assistant.persistence.invocations import AssistantInvocationStore
from service.assistant.persistence.store import AssistantStore
from service.chat.constants import PRODUCT_EVENT_MESSAGE_DELTA
from service.chat.persistence.artifacts import ArtifactSource, ArtifactStatus, SessionArtifactStore
from service.chat.persistence.catalog import (
    SessionCatalogStore,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.content.domain.model import ContentError
from service.content.persistence import snapshots
from service.content.service.space import prepare_project_storage, project_database
from service.identity.persistence.handoff import HandoffClaimStore
from service.paths import PROJECT_DB_RELATIVE
from service.persistence.project import (
    StorageFailureKind,
    classify_storage_failure,
    connect,
    reader,
    transaction,
)
from service.platform.content import ArtifactScope, ArtifactScopeKind
from service.platform.storage import (
    DarwinDirectoryNative,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
)
from service.resources.persistence.version import VersionStore
from service.settings.credentials import ModelCredentialStore

WORKERS = 8
FRESH_DATABASES = 24
LOCK_TEST_TIMEOUT = 0.05
LOCK_TEST_WALL_LIMIT = 1.0


class ObservedConnection(sqlite3.Connection):
    """Observe successful close on the owning thread, without disabling affinity."""

    closed = False

    def close(self):
        super().close()
        self.closed = True


class AssistantSchemaContracts(unittest.TestCase):
    def test_future_columns_do_not_hide_missing_required_columns(self):
        for store, table, required in (
            (CitationStore, "assistant_pdf_citations", "payload"),
            (AssistantInvocationStore, "assistant_model_invocation", "status"),
        ):
            with self.subTest(store=store.__name__), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "sessions.sqlite3"
                store(database)
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN future_data TEXT")
                    connection.execute(f"ALTER TABLE {table} DROP COLUMN {required}")
                    before = tuple(connection.iterdump())
                with patch.object(store, "_connect", side_effect=AssertionError("opened writer")):
                    with self.assertRaisesRegex(RuntimeError, "unsupported"):
                        store(database)
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_current_initialization_never_opens_writer(self):
        for store in (CitationStore, AssistantInvocationStore):
            with self.subTest(store=store.__name__), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "sessions.sqlite3"
                store(database)
                with patch.object(store, "_connect", side_effect=AssertionError("opened writer")):
                    store(database)

    def test_future_columns_accepted_without_mutation(self):
        for store, table in (
            (CitationStore, "assistant_pdf_citations"),
            (AssistantInvocationStore, "assistant_model_invocation"),
        ):
            with self.subTest(store=store.__name__), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "sessions.sqlite3"
                store(database)
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute(f"ALTER TABLE {table} ADD COLUMN future_data TEXT")
                    before = tuple(connection.iterdump())
                with patch.object(store, "_connect", side_effect=AssertionError("opened writer")):
                    store(database)
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_initialization_failure_rolls_back_actual_ddl(self):
        for store in (CitationStore, AssistantInvocationStore):
            with self.subTest(store=store.__name__), tempfile.TemporaryDirectory() as root:
                database = Path(root) / "sessions.sqlite3"
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.execute("CREATE TABLE unrelated(value TEXT)")
                    connection.execute("INSERT INTO unrelated VALUES ('keep')")
                    before = tuple(connection.iterdump())
                create = store._create_table

                def fail_after_create(connection, create=create):
                    create(connection)
                    if connection.execute("PRAGMA database_list").fetchone()[2]:
                        raise OSError("after actual DDL")

                with patch.object(store, "_create_table", side_effect=fail_after_create):
                    with self.assertRaisesRegex(OSError, "actual DDL"):
                        store(database)
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                store(database)
                self.assertFalse(store.inspect_schema(database).needs_write)

    def test_wal_index_creation_and_unknown_index_refusal(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "sessions.sqlite3"
            store = AssistantInvocationStore
            store(database)
            index = "idx_assistant_model_invocation_owner_updated"
            with closing(sqlite3.connect(database)) as writer:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute(f"DROP INDEX {index}")
                writer.commit()
                wal = Path(str(database) + "-wal")
                before = database.read_bytes(), wal.read_bytes()
                schema = store.inspect_schema(database)
                self.assertFalse(schema.create_table)
                self.assertTrue(schema.create_index)
                self.assertEqual((database.read_bytes(), wal.read_bytes()), before)
                store(database)
                self.assertFalse(store.inspect_schema(database).needs_write)
                writer.execute(f"DROP INDEX {index}")
                writer.execute(f"CREATE INDEX {index} ON assistant_model_invocation(status)")
                writer.commit()
                before = tuple(writer.iterdump())
                with patch.object(store, "_connect", side_effect=AssertionError("opened writer")):
                    with self.assertRaisesRegex(RuntimeError, "owned index"):
                        store(database)
                self.assertEqual(tuple(writer.iterdump()), before)

    def test_citation_historical_snapshot_rename_preserves_receipts(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "sessions.sqlite3"
            store = CitationStore(database)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute(
                    "CREATE TABLE assistant_turn_snapshot(snapshot_id TEXT PRIMARY KEY)"
                )
                connection.execute("INSERT INTO assistant_turn_snapshot VALUES ('snapshot')")
            payload = {"handle": "citation", "quote": "original evidence"}
            store.record("session", "snapshot", "source", payload)
            with closing(sqlite3.connect(database)) as connection, connection:
                connection.execute(
                    "ALTER TABLE assistant_pdf_citations ADD COLUMN future_data TEXT"
                )
                connection.execute(
                    "UPDATE assistant_pdf_citations SET future_data='keep receipt extension'"
                )
                connection.execute(
                    "ALTER TABLE assistant_turn_snapshot RENAME TO assistant_turn_snapshot_migration"
                )
                connection.execute(
                    "CREATE TABLE assistant_turn_snapshot(snapshot_id TEXT PRIMARY KEY)"
                )
                connection.execute(
                    "INSERT INTO assistant_turn_snapshot SELECT * FROM assistant_turn_snapshot_migration"
                )
                connection.execute("DROP TABLE assistant_turn_snapshot_migration")
                connection.execute(
                    "CREATE TABLE citation_child(handle TEXT REFERENCES assistant_pdf_citations(handle))"
                )
                connection.execute("INSERT INTO citation_child VALUES ('citation')")
                connection.execute(
                    "CREATE INDEX citation_source ON assistant_pdf_citations(source_key)"
                )
                before = tuple(connection.iterdump())
            schema = CitationStore.inspect_schema(database)
            self.assertTrue(schema.repair_foreign_key)
            inspect = CitationStore.inspect_connection
            calls = 0

            def fail_after_repair(connection):
                nonlocal calls
                result = inspect(connection)
                if connection.execute("PRAGMA database_list").fetchone()[2]:
                    calls += 1
                    if calls == 3:
                        self.assertFalse(result.needs_write)
                        raise OSError("after citation repair")
                return result

            with patch.object(CitationStore, "inspect_connection", side_effect=fail_after_repair):
                with self.assertRaisesRegex(OSError, "citation repair"):
                    CitationStore(database)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(tuple(connection.iterdump()), before)
            reopened = CitationStore(database)
            self.assertEqual(reopened.get("session", "snapshot", "citation"), payload)
            self.assertEqual(reopened.record("session", "snapshot", "source", payload), payload)
            self.assertFalse(CitationStore.inspect_schema(database).needs_write)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(
                    connection.execute(
                        "SELECT future_data FROM assistant_pdf_citations"
                    ).fetchall(),
                    [("keep receipt extension",)],
                )
                self.assertEqual(
                    connection.execute("SELECT * FROM citation_child").fetchall(), [("citation",)]
                )
                self.assertIsNotNone(
                    connection.execute(
                        "SELECT sql FROM sqlite_master WHERE name='citation_source'"
                    ).fetchone()
                )

    def test_citation_pragma_failure_closes_connection(self):
        with tempfile.TemporaryDirectory() as root:
            store = CitationStore(Path(root) / "sessions.sqlite3")
            connection = sqlite3.connect(":memory:")
            connection.set_authorizer(
                lambda action, *_: (
                    sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_PRAGMA else sqlite3.SQLITE_OK
                )
            )
            with patch("sqlite3.connect", return_value=connection):
                with self.assertRaises(sqlite3.DatabaseError):
                    store._connect()
            with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed database"):
                connection.execute("SELECT 1")

    def test_missing_inspection_creates_no_directory(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "absent" / "sessions.sqlite3"
            for store in (CitationStore, AssistantInvocationStore):
                self.assertTrue(store.inspect_schema(database).needs_write)
            self.assertFalse(database.parent.exists())


class ProjectPersistenceContracts(unittest.TestCase):
    def test_storage_failures_distinguish_exhaustion_from_other_io(self):
        full = sqlite3.OperationalError("database or disk is full")
        full.sqlite_errorcode = sqlite3.SQLITE_FULL
        io = sqlite3.OperationalError("disk I/O error")
        io.sqlite_errorcode = sqlite3.SQLITE_IOERR

        self.assertIs(classify_storage_failure(OSError(ENOSPC, "full")), StorageFailureKind.FULL)
        self.assertIs(classify_storage_failure(full), StorageFailureKind.FULL)
        self.assertIs(classify_storage_failure(io), StorageFailureKind.IO)
        self.assertIsNone(classify_storage_failure(sqlite3.OperationalError("database is locked")))

    def test_reader_never_creates_missing_paths_and_rejects_writes(self):
        with tempfile.TemporaryDirectory() as root:
            database = (
                Path(root)
                / ("project #%" if sys.platform == "win32" else "project #?")
                / "project.sqlite3"
            )
            with self.assertRaises(sqlite3.OperationalError):
                with reader(database):
                    pass
            self.assertFalse(database.parent.exists())
            with transaction(database) as connection:
                connection.execute("CREATE TABLE samples (id INTEGER)")
                connection.execute("INSERT INTO samples VALUES (1)")
            with reader(database) as connection:
                self.assertEqual(connection.execute("SELECT id FROM samples").fetchone()[0], 1)
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("INSERT INTO samples VALUES (2)")

    def test_concurrent_first_open_preserves_every_writer(self):
        with tempfile.TemporaryDirectory() as root:
            for iteration in range(FRESH_DATABASES):
                database = Path(root) / str(iteration) / "project.sqlite3"
                start = Barrier(WORKERS)

                def write(index, start=start, database=database):
                    start.wait(timeout=LOCK_TEST_WALL_LIMIT)
                    with transaction(database, immediate=True) as connection:
                        connection.execute(
                            "CREATE TABLE IF NOT EXISTS samples (id INTEGER PRIMARY KEY)"
                        )
                        connection.execute("INSERT INTO samples VALUES (?)", (index,))

                with ThreadPoolExecutor(max_workers=WORKERS) as executor:
                    list(executor.map(write, range(WORKERS)))
                with transaction(database) as connection:
                    self.assertEqual(
                        connection.execute("SELECT COUNT(*) FROM samples").fetchone()[0], WORKERS
                    )
                    self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
                    self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
                    self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 2)

    def test_continuing_lock_is_bounded_and_recovers_after_release(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "project.sqlite3"
            owner = sqlite3.connect(database)
            owner.execute("CREATE TABLE samples (id INTEGER)")
            owner.execute("BEGIN EXCLUSIVE")
            try:
                started = time.monotonic()
                with patch("service.persistence.project.SQLITE_TIMEOUT_SECONDS", LOCK_TEST_TIMEOUT):
                    with self.assertRaises(sqlite3.OperationalError) as caught:
                        connect(database)
                self.assertEqual(caught.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
                self.assertLess(time.monotonic() - started, LOCK_TEST_WALL_LIMIT)
            finally:
                owner.rollback()
                owner.close()
            with transaction(database) as connection:
                self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_corrupt_database_is_not_retried_and_failed_connection_is_closed(self):
        with tempfile.TemporaryDirectory() as root:
            database = Path(root) / "project.sqlite3"
            database.write_bytes(b"invalid database" * 100)
            opened = []
            original = sqlite3.connect

            def record(*args, **kwargs):
                connection = original(*args, **kwargs)
                opened.append(connection)
                return connection

            with patch("service.persistence.project.sqlite3.connect", side_effect=record):
                with self.assertRaises(sqlite3.DatabaseError):
                    connect(database)
            self.assertEqual(len(opened), 1)
            with self.assertRaises(sqlite3.ProgrammingError):
                opened[0].execute("SELECT 1")


SESSION_ID = "connection-owner"
RUNTIME_ID = "runtime-fixture"
VENDOR_THREAD_ID = "thread-fixture"
SESSION_OWNER = SessionPrincipal("connection-owner")
CONNECTION_WORKERS = 4
CONNECTION_ROUNDS = 8


class SessionPersistenceContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="session-connections-")
        self.root = Path(self.temporary.name)
        self.database = self.root / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.record = self.catalog.register(
            SESSION_ID,
            SESSION_OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "outputs"),
            codex_version=None,
            model_id="model-fixture",
            policy_id="ask",
            status=SessionStatus.READY,
            title="fixture",
            created_at=1.0,
        )
        self.events = ProductEventStore(self.database)
        self.artifacts = SessionArtifactStore(self.database)
        self.assistant = AssistantStore(self.database)
        self.invocations = AssistantInvocationStore(self.database)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @contextmanager
    def tracked_connections(self, *, deny_pragma: bool = False):
        # Strong references prevent GC from hiding a missing deterministic close.
        opened = []
        original = sqlite3.connect

        def connect_real(*args, **kwargs):
            connection = original(*args, factory=ObservedConnection, **kwargs)
            opened.append(connection)
            if deny_pragma:
                connection.set_authorizer(
                    lambda action, *_args: (
                        sqlite3.SQLITE_DENY
                        if action == sqlite3.SQLITE_PRAGMA
                        else sqlite3.SQLITE_OK
                    )
                )
            return connection

        try:
            with patch("sqlite3.connect", side_effect=connect_real):
                yield opened
        finally:
            for connection in opened:
                if not connection.closed:
                    connection.close()

    def assert_closed(self, connections) -> None:
        self.assertTrue(connections, "the operation did not exercise a real SQLite connection")
        for connection in connections:
            self.assertTrue(connection.closed, "owned SQLite connection was not closed")

    def append(self, key, *, connection=None):
        return self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-fixture",
            vendor_item_id="item-fixture",
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": "evidence"},
            idempotency_key=key,
            connection=connection,
        )

    def index(self, event, *, connection=None):
        return self.artifacts.index(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=event.vendor_turn_id,
            vendor_item_id=event.vendor_item_id,
            source_kind=ArtifactSource.FILE_CHANGE,
            source_product_seq=event.product_seq,
            original_path="result.txt",
            canonical_path=str(self.root / "result.txt"),
            role="data",
            status=ArtifactStatus.COMPLETED,
            mime_type="text/plain",
            content_sha256=None,
            size_bytes=None,
            metadata={},
            idempotency_key=event.idempotency_key,
            connection=connection,
        )

    def test_owned_connections_close_before_return_without_gc(self) -> None:
        event = self.append("owned-event")
        artifact = self.index(event)
        operations = (
            lambda: SessionCatalogStore(self.database),
            lambda: ProductEventStore(self.database),
            lambda: SessionArtifactStore(self.database),
            lambda: AssistantStore(self.database),
            lambda: AssistantInvocationStore(self.database),
            lambda: self.assistant.selection(SESSION_ID),
            lambda: self.assistant.annotations(SESSION_ID),
            lambda: self.assistant.snapshot_by_id(SESSION_ID, "missing-snapshot"),
            lambda: self.assistant.release_claim(
                session_id=SESSION_ID, client_turn_id="missing-turn"
            ),
            lambda: self.invocations.get("missing-invocation", SESSION_OWNER.user_id),
            lambda: self.catalog.get(SESSION_ID),
            lambda: self.catalog.model_state(SESSION_ID),
            lambda: self.catalog.activation(SESSION_ID),
            lambda: self.events.latest_kind(SESSION_ID, event.kind),
            lambda: self.events.sessions_with_kind(event.kind),
            lambda: self.events.workspace_for_sequence(self.record, event.product_seq),
            lambda: self.events.turn_records(
                SESSION_ID, "client-fixture", event.vendor_turn_id, kinds=(event.kind,)
            ),
            lambda: self.events.by_key(SESSION_ID, event.idempotency_key),
            lambda: self.events.replay(SESSION_ID),
            lambda: self.events.by_sequence(SESSION_ID, event.product_seq),
            lambda: self.events.user_message_for_turn(SESSION_ID, event.vendor_turn_id),
            lambda: self.events.answer_timeline(SESSION_ID, source_product_seq=event.product_seq),
            lambda: self.events.portable_history(SESSION_ID),
            lambda: self.events.turn_context(SESSION_ID, event.vendor_turn_id),
            lambda: self.artifacts.by_key(SESSION_ID, artifact.idempotency_key),
            lambda: self.artifacts.get_by_key(SESSION_ID, artifact.idempotency_key),
            lambda: self.artifacts.list_session(SESSION_ID),
            lambda: self.artifacts.mark_saved(artifact.artifact_id, "resource-fixture"),
        )
        with self.tracked_connections() as opened:
            for index, operation in enumerate(operations):
                with self.subTest(operation=index):
                    start = len(opened)
                    operation()
                    self.assert_closed(opened[start:])

    def test_failed_schema_initialization_closes_its_connection(self) -> None:
        for store in (
            SessionCatalogStore,
            ProductEventStore,
            SessionArtifactStore,
            AssistantStore,
            AssistantInvocationStore,
        ):
            with self.subTest(store=store.__name__):
                database = self.root / f"corrupt-{store.__name__}.sqlite3"
                database.write_bytes(b"invalid database" * 100)
                with self.tracked_connections() as opened:
                    with self.assertRaises(sqlite3.DatabaseError):
                        store(database)
                    self.assert_closed(opened)

    def test_failed_connection_configuration_closes_before_factory_returns(self) -> None:
        for store in (SessionCatalogStore, ProductEventStore, SessionArtifactStore, AssistantStore):
            with self.subTest(store=store.__name__):
                with self.tracked_connections(deny_pragma=True) as opened:
                    with self.assertRaises(sqlite3.DatabaseError):
                        store(self.database)
                    self.assert_closed(opened)

    def test_borrowed_transaction_remains_open_and_uncommitted_until_owner_exits(self) -> None:
        with self.tracked_connections() as opened:
            with self.events.transaction() as connection:
                event = self.append("borrowed-event", connection=connection)
                artifact = self.index(event, connection=connection)
                self.assertEqual(
                    self.events.by_key(SESSION_ID, event.idempotency_key, connection=connection),
                    event,
                )
                self.assertEqual(
                    self.events.latest_kind(SESSION_ID, event.kind, connection=connection), event
                )
                self.assertEqual(
                    self.events.turn_kind_usage(
                        SESSION_ID, event.vendor_turn_id, event.kind, connection=connection
                    )[0],
                    1,
                )
                self.assertTrue(connection.in_transaction)
                self.assertEqual(connection.execute("SELECT 1").fetchone()[0], 1)
                self.assertTrue(self.assistant.clear_for_relocation(SESSION_ID, connection))
                self.assertTrue(connection.in_transaction)
                self.assertIsNone(self.events.by_key(SESSION_ID, event.idempotency_key))
                self.assertIsNone(self.artifacts.by_key(SESSION_ID, artifact.idempotency_key))
            self.assert_closed(opened)
        self.assertEqual(self.events.by_key(SESSION_ID, event.idempotency_key), event)
        self.assertEqual(self.artifacts.by_key(SESSION_ID, artifact.idempotency_key), artifact)

    def test_borrowed_event_artifact_and_catalog_changes_rollback_together(self) -> None:
        with self.tracked_connections() as opened:
            with self.assertRaisesRegex(RuntimeError, "abort owner"):
                with self.events.transaction() as connection:
                    event = self.append("rolled-back-event", connection=connection)
                    self.index(event, connection=connection)
                    self.catalog.relocate(
                        SESSION_ID,
                        SESSION_OWNER,
                        runtime_workdir=str(self.root / "moved"),
                        project_path=str(self.root),
                        output_root=str(self.root / "moved" / "outputs"),
                        connection=connection,
                    )
                    self.assertTrue(connection.in_transaction)
                    raise RuntimeError("abort owner")
            self.assert_closed(opened)
        self.assertIsNone(self.events.by_key(SESSION_ID, "rolled-back-event"))
        self.assertIsNone(self.artifacts.by_key(SESSION_ID, "rolled-back-event"))
        self.assertEqual(self.catalog.get(SESSION_ID).runtime_workdir, self.record.runtime_workdir)
        self.assertEqual(
            self.catalog.get(SESSION_ID).last_product_seq, self.record.last_product_seq
        )

    def test_borrowed_operation_error_does_not_close_or_rollback_the_owner(self) -> None:
        with self.tracked_connections() as opened:
            with self.events.transaction() as connection:
                event = self.append("borrowed-conflict", connection=connection)
                with self.assertRaises(SessionStateConflictError):
                    self.events.append(
                        session_id=SESSION_ID,
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id=VENDOR_THREAD_ID,
                        vendor_turn_id=event.vendor_turn_id,
                        vendor_item_id=event.vendor_item_id,
                        kind=event.kind,
                        payload={"delta": "conflict"},
                        idempotency_key=event.idempotency_key,
                        connection=connection,
                    )
                self.assertTrue(connection.in_transaction)
                self.assertEqual(
                    self.events.by_key(SESSION_ID, event.idempotency_key, connection=connection),
                    event,
                )
                next_event = self.append("after-borrowed-conflict", connection=connection)
            self.assert_closed(opened)
        self.assertEqual(len(self.events.replay(SESSION_ID)), 2)
        self.assertEqual(self.events.by_key(SESSION_ID, next_event.idempotency_key), next_event)

    def test_concurrent_readers_and_writers_leave_no_owned_connections(self) -> None:
        def write(index):
            for turn in range(CONNECTION_ROUNDS):
                event = self.append(f"worker-{index}-event-{turn}")
                artifact = self.index(event)
                self.assertEqual(self.events.by_sequence(SESSION_ID, event.product_seq), event)
                self.assertEqual(
                    self.artifacts.by_key(SESSION_ID, artifact.idempotency_key), artifact
                )
                self.artifacts.list_session(SESSION_ID)

        with self.tracked_connections() as opened:
            with ThreadPoolExecutor(max_workers=CONNECTION_WORKERS) as executor:
                list(executor.map(write, range(CONNECTION_WORKERS)))
            self.assert_closed(opened)
        self.assertEqual(
            len(self.events.replay(SESSION_ID)), CONNECTION_WORKERS * CONNECTION_ROUNDS
        )
        self.assertEqual(
            len(self.artifacts.list_session(SESSION_ID)), CONNECTION_WORKERS * CONNECTION_ROUNDS
        )


class SchemaOnlyPreparationContracts(unittest.TestCase):
    def test_lazy_identity_owners_prepare_no_business_rows_and_skip_current_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            for owner, table in (
                (HandoffClaimStore, "desktop_handoff_claims"),
                (ModelCredentialStore, "model_credentials"),
            ):
                with self.subTest(owner=owner.__name__):
                    path = Path(folder) / (table + ".sqlite3")
                    store = owner(path)
                    store.ensure_schema()
                    self.assertFalse(owner.inspect_schema(path).needs_write)
                    with closing(sqlite3.connect(path)) as connection:
                        self.assertEqual(
                            connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0
                        )
                        connection.execute("BEGIN IMMEDIATE")
                        store.ensure_schema()
                        self.assertTrue(connection.in_transaction)
                        connection.rollback()


class SnapshotReadContracts(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory()
        self.addCleanup(self.area.cleanup)
        self.database = Path(self.area.name) / "private" / "claims.sqlite3"
        self.scope = ArtifactScope(ArtifactScopeKind.SESSION, "session")

    def test_missing_read_does_not_create_database_or_parent(self):
        self.assertIsNone(snapshots.get(self.database, self.scope, "digest"))
        self.assertFalse(self.database.parent.exists())

    def test_other_owner_database_is_unchanged(self):
        self.database.parent.mkdir()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("CREATE TABLE other_owner(value TEXT)")
            connection.execute("INSERT INTO other_owner VALUES ('keep')")
            before = tuple(connection.iterdump())
        self.assertIsNone(snapshots.get(self.database, self.scope, "digest"))
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_read_observes_committed_claim_while_writer_is_active(self):
        claim = snapshots.prepare(self.database, self.scope, "digest", 7)
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE content_snapshot_claims SET status = 'completed'")
            self.assertEqual(snapshots.get(self.database, self.scope, "digest"), claim)
            self.assertTrue(writer.in_transaction)
            writer.commit()
        self.assertEqual(
            snapshots.get(self.database, self.scope, "digest").status,
            snapshots.SnapshotClaimStatus.COMPLETED,
        )


class VersionSchemaContracts(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory()
        self.addCleanup(self.area.cleanup)
        self.root = Path(self.area.name).resolve()
        self.database = self.root / PROJECT_DB_RELATIVE
        self.store = VersionStore(self.database, self.root)

    def test_working_mutation_closes_connection_on_return_and_error(self):
        self.store.ensure()
        for query_error in (False, True):
            with (
                self.subTest(query_error=query_error),
                closing(connect(self.database)) as connection,
            ):
                if query_error:
                    connection.set_authorizer(lambda *_: sqlite3.SQLITE_DENY)
                with patch(
                    "service.resources.persistence.version.connect", return_value=connection
                ):
                    if query_error:
                        with self.assertRaises(sqlite3.DatabaseError):
                            self.store.working_mutation("missing")
                    else:
                        self.assertIsNone(self.store.working_mutation("missing"))
                with self.assertRaises(sqlite3.ProgrammingError):
                    connection.execute("SELECT 1")

    def test_missing_inspection_does_not_create_private_storage(self):
        schema = VersionStore.inspect_schema(self.database)
        self.assertTrue(schema.needs_write)
        self.assertEqual(len(schema.create_tables), 28)
        self.assertFalse(self.database.parent.exists())

    def test_current_schema_ensure_does_not_wait_for_writer(self):
        self.store.ensure()
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("BEGIN IMMEDIATE")
            self.store.ensure()
            self.assertTrue(writer.in_transaction)
            writer.rollback()

    def test_unknown_columns_are_rejected_without_changes(self):
        self.store.ensure()
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("ALTER TABLE resources_files ADD COLUMN future TEXT")
            before = tuple(writer.iterdump())
        with self.assertRaisesRegex(RuntimeError, "constraints or columns"):
            self.store.ensure()
        with closing(sqlite3.connect(self.database)) as reader:
            self.assertEqual(tuple(reader.iterdump()), before)

    def test_known_additive_column_is_restored_without_other_owner_changes(self):
        self.store.ensure()
        with closing(sqlite3.connect(self.database)) as writer, writer:
            writer.execute("ALTER TABLE resources_observations DROP COLUMN annotation_revision")
            writer.execute("CREATE TABLE other_owner(value TEXT)")
            writer.execute("INSERT INTO other_owner VALUES('kept')")
        self.assertIn(
            ("resources_observations", "annotation_revision"),
            VersionStore.inspect_schema(self.database).add_columns,
        )
        self.store.ensure()
        self.assertFalse(VersionStore.inspect_schema(self.database).needs_write)
        with closing(sqlite3.connect(self.database)) as reader:
            self.assertEqual(
                reader.execute("SELECT value FROM other_owner").fetchall(), [("kept",)]
            )

    def test_additive_initialization_failure_rolls_back_actual_ddl(self):
        self.store.ensure()
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("ALTER TABLE resources_observations DROP COLUMN annotation_revision")
            before = tuple(writer.iterdump())
        initialize = VersionStore._initialize

        def fail_file(connection):
            initialize(connection)
            if connection.execute("PRAGMA database_list").fetchone()[2]:
                raise OSError("after actual schema change")

        with patch.object(VersionStore, "_initialize", side_effect=fail_file):
            with self.assertRaisesRegex(OSError, "actual schema"):
                self.store.ensure()
        with closing(sqlite3.connect(self.database)) as reader:
            self.assertEqual(tuple(reader.iterdump()), before)
        self.store.ensure()
        self.assertFalse(VersionStore.inspect_schema(self.database).needs_write)


class ProjectDatabaseDiscovery(unittest.TestCase):
    def test_preparation_creates_only_private_parent_and_requires_existing_root(self):
        native = (
            WindowsDirectoryNative()
            if sys.platform == "win32"
            else DarwinDirectoryNative() if sys.platform == "darwin" else LinuxDirectoryNative()
        )
        base = Path(os.environ.get("SCHOLARSEED_LEASE_TEST_ROOT", tempfile.gettempdir())).resolve()
        root = base / ("private-preparation-" + uuid4().hex)
        pin = native.pin(str(root), True)
        native.release(pin)
        try:
            with self.assertRaises(FileNotFoundError):
                prepare_project_storage(root / "offline")
            self.assertFalse((root / "offline").exists())
            prepare_project_storage(root)
            with project_database(root) as database:
                self.assertIsNotNone(database)
                self.assertTrue(database.parent.is_dir())
                self.assertFalse(database.exists())
        finally:
            shutil.rmtree(root)

    def test_private_parent_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            target = root / "other"
            target.mkdir()
            relative = Path(PROJECT_DB_RELATIVE)
            try:
                (root / relative.parts[0]).symlink_to(target, target_is_directory=True)
            except OSError as error:
                if getattr(error, "winerror", None) == 1314:
                    self.skipTest("Windows account cannot create symlinks")
                raise
            with self.assertRaises((OSError, ContentError)):
                with project_database(root):
                    self.fail("symbolic private parent was followed")
            with self.assertRaises((OSError, ContentError)):
                prepare_project_storage(root)
            self.assertEqual(list(target.iterdir()), [])

    def test_missing_private_parent_is_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            with project_database(root) as database:
                self.assertIsNone(database)
            self.assertEqual(list(root.iterdir()), [])
            with self.assertRaises(FileNotFoundError):
                with project_database(root / "offline"):
                    self.fail("missing project must not be treated as empty storage")

    def test_existing_parent_does_not_create_database(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            expected = root / PROJECT_DB_RELATIVE
            expected.parent.mkdir(parents=True)
            with project_database(root) as database:
                self.assertEqual(database, expected)
                self.assertFalse(database.exists())
            self.assertFalse(expected.exists())


if __name__ == "__main__":
    unittest.main()
