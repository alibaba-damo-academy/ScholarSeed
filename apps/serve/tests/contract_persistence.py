"""Real SQLite initialization, connection ownership, and atomic transaction contracts."""

from __future__ import annotations

import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from errno import ENOSPC
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

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
from service.persistence.project import (
    StorageFailureKind,
    classify_storage_failure,
    connect,
    reader,
    transaction,
)

WORKERS = 8
FRESH_DATABASES = 24
LOCK_TEST_TIMEOUT = 0.05
LOCK_TEST_WALL_LIMIT = 1.0


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
            database = Path(root) / "project #?" / "project.sqlite3"
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

                def write(index):
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
            connection = original(*args, **kwargs)
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
                connection.close()

    def assert_closed(self, connections) -> None:
        self.assertTrue(connections, "the operation did not exercise a real SQLite connection")
        for connection in connections:
            with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed database"):
                connection.execute("SELECT 1")

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


if __name__ == "__main__":
    unittest.main()
