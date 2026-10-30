"""SQLite migration interruption contracts through actual store constructors."""

from __future__ import annotations

import multiprocessing
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from service.chat.persistence.artifacts import (
    SESSION_ARTIFACT_DRAFT_TABLE,
    SESSION_ARTIFACT_TABLE,
    SessionArtifactStore,
)
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SESSION_HIL_TABLE,
    SessionCatalogStore,
)
from service.persistence.project import rebuild_table, schema_transaction
from tests.contract_session_artifacts import SessionArtifactContract


def interrupted_open(path: str):
    original = SessionArtifactStore._connect

    def connection(store):
        database = original(store)

        def authorize(action, name, *_):
            if action == sqlite3.SQLITE_INSERT and name in (
                SESSION_ARTIFACT_TABLE,
                SESSION_ARTIFACT_TABLE + "_schema_rebuild",
            ):
                os._exit(73)
            return sqlite3.SQLITE_OK

        database.set_authorizer(authorize)
        return database

    with patch.object(SessionArtifactStore, "_connect", connection):
        SessionArtifactStore(Path(path))


class SchemaRepair(unittest.TestCase):
    def setUp(self):
        self.fixture = SessionArtifactContract()
        self.fixture.addCleanup = self.addCleanup
        self.fixture.setUp()
        self.path = self.fixture.database
        artifact = self.fixture.index()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(
                f"INSERT INTO {SESSION_ARTIFACT_DRAFT_TABLE} VALUES (?, ?)",
                (artifact.artifact_id, b"unsaved user draft"),
            )
            schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = ?", (SESSION_ARTIFACT_TABLE,)
            ).fetchone()[0]
            rows = connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_TABLE}").fetchall()
            connection.execute(f"DROP TABLE {SESSION_ARTIFACT_TABLE}")
            connection.execute(
                schema.replace(
                    f"REFERENCES {SESSION_CATALOG_TABLE}",
                    f"REFERENCES {SESSION_CATALOG_TABLE}_migration",
                )
            )
            connection.executemany(
                f"INSERT INTO {SESSION_ARTIFACT_TABLE} VALUES ({','.join('?' for _ in rows[0])})",
                rows,
            )
        self.before = self.snapshot()

    def snapshot(self):
        with closing(sqlite3.connect(self.path)) as connection:
            tables = connection.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
            rows = {
                name: connection.execute(f'SELECT * FROM "{name}"').fetchall() for name, _ in tables
            }
            return tables, rows

    def test_child_references_and_draft_survive_repair(self):
        SessionArtifactStore(self.path)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute(
                    f"SELECT content FROM {SESSION_ARTIFACT_DRAFT_TABLE}"
                ).fetchone()[0],
                b"unsaved user draft",
            )
            self.assertEqual(
                connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_TABLE}").fetchall(),
                self.before[1][SESSION_ARTIFACT_TABLE],
            )

    def test_unknown_foreign_target_is_rejected_without_changes(self):
        with closing(sqlite3.connect(self.path)) as connection, connection:
            schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = ?", (SESSION_ARTIFACT_TABLE,)
            ).fetchone()[0]
            rows = connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_TABLE}").fetchall()
            connection.execute(f"DROP TABLE {SESSION_ARTIFACT_TABLE}")
            connection.execute(
                schema.replace(
                    f"REFERENCES {SESSION_CATALOG_TABLE}_migration", "REFERENCES legacy_sessions"
                )
            )
            connection.executemany(
                f"INSERT INTO {SESSION_ARTIFACT_TABLE} VALUES ({','.join('?' for _ in rows[0])})",
                rows,
            )
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "unsupported artifact schema declaration"):
            SessionArtifactStore(self.path)
        self.assertEqual(self.snapshot(), before)

    def test_failed_copy_rolls_back_schema_and_rows(self):
        original = SessionArtifactStore._connect

        def connection(store):
            database = original(store)
            database.set_authorizer(
                lambda action, name, *_: (
                    sqlite3.SQLITE_DENY
                    if action == sqlite3.SQLITE_INSERT
                    and name in (SESSION_ARTIFACT_TABLE, SESSION_ARTIFACT_TABLE + "_schema_rebuild")
                    else sqlite3.SQLITE_OK
                )
            )
            return database

        with patch.object(SessionArtifactStore, "_connect", connection):
            with self.assertRaises(sqlite3.DatabaseError):
                SessionArtifactStore(self.path)
        self.assertEqual(self.snapshot(), self.before)

    def test_process_death_rolls_back_schema_and_rows(self):
        child = multiprocessing.get_context("spawn").Process(
            target=interrupted_open, args=(str(self.path),)
        )
        child.start()
        try:
            child.join(15)
            self.assertEqual(child.exitcode, 73)
        finally:
            if child.is_alive():
                child.kill()
                child.join(5)
        self.assertEqual(self.snapshot(), self.before)
        SessionArtifactStore(self.path)

    def test_existing_staging_table_is_preserved(self):
        name = SESSION_ARTIFACT_TABLE + "_schema_rebuild"
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(f"CREATE TABLE {name} (data TEXT)")
            connection.execute(f"INSERT INTO {name} VALUES ('preserve unknown work')")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "staging object"):
            SessionArtifactStore(self.path)
        self.assertEqual(self.snapshot(), before)

    def test_legacy_interrupted_table_is_not_deleted_on_reopen(self):
        SessionArtifactStore(self.path)
        name = SESSION_ARTIFACT_TABLE + "_foreign_key_migration"
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(f"CREATE TABLE {name} (data TEXT)")
            connection.execute(f"INSERT INTO {name} VALUES ('old interrupted user data')")
        before = self.snapshot()
        with self.assertRaisesRegex(RuntimeError, "recovery required"):
            SessionArtifactStore(self.path)
        self.assertEqual(self.snapshot(), before)

    def test_concurrent_initializers_preserve_rows(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: SessionArtifactStore(self.path), range(8)))
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute(f"SELECT * FROM {SESSION_ARTIFACT_TABLE}").fetchall(),
                self.before[1][SESSION_ARTIFACT_TABLE],
            )

    def test_generated_column_is_rejected_without_data_or_schema_loss(self):
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(
                "CREATE TABLE future_table (id TEXT, value INTEGER, extra INTEGER GENERATED ALWAYS AS (value * 2) STORED)"
            )
            connection.execute("INSERT INTO future_table(id,value) VALUES ('keep',7)")
        before = self.snapshot()
        with closing(sqlite3.connect(self.path)) as connection:
            with self.assertRaisesRegex(RuntimeError, "generated columns"):
                with schema_transaction(connection):
                    rebuild_table(
                        connection,
                        "future_table",
                        lambda c, name: c.execute(f"CREATE TABLE {name} (id TEXT, value INTEGER)"),
                    )
        self.assertEqual(self.snapshot(), before)

    def test_catalog_repair_preserves_index_trigger_and_hil(self):
        # Fix the independent artifact fixture first; then make only HIL stale.
        SessionArtifactStore(self.path)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            schema = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name = ?", (SESSION_HIL_TABLE,)
            ).fetchone()[0]
            connection.execute(f"DROP TABLE {SESSION_HIL_TABLE}")
            connection.execute(
                schema.replace(
                    f"REFERENCES {SESSION_CATALOG_TABLE}", "REFERENCES session_catalog_migration"
                )
            )
            connection.execute(
                f"INSERT INTO {SESSION_HIL_TABLE} (product_request_id,session_id,vendor_request_id,method,payload,status,created_at) VALUES ('request','product-a','vendor','tool','{{}}','pending',1)"
            )
            connection.execute(f"CREATE INDEX custom_hil_index ON {SESSION_HIL_TABLE}(method)")
            connection.execute("CREATE TABLE hil_audit (request TEXT)")
            connection.execute(
                f"CREATE TRIGGER custom_hil_trigger AFTER UPDATE ON {SESSION_HIL_TABLE} BEGIN INSERT INTO hil_audit VALUES (new.product_request_id); END"
            )
        SessionCatalogStore(self.path)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            self.assertEqual(
                connection.execute(
                    f"SELECT product_request_id FROM {SESSION_HIL_TABLE}"
                ).fetchall(),
                [("request",)],
            )
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertIsNotNone(
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='custom_hil_index'"
                ).fetchone()
            )
            connection.execute(f"UPDATE {SESSION_HIL_TABLE} SET status='resolved'")
            self.assertEqual(
                connection.execute("SELECT * FROM hil_audit").fetchall(), [("request",)]
            )


class FixtureLifecycle(unittest.TestCase):
    def exercise(
        self, failure=None, *, cleanup_failure=False, release_failure=False, delegated=True
    ):
        case = (
            SchemaRepair("test_child_references_and_draft_survive_repair")
            if delegated
            else SessionArtifactContract("test_current_schema_does_not_open_writer")
        )
        fixtures = []
        connections = []
        original_setup = SessionArtifactContract.setUp
        original_connect = sqlite3.connect
        original_cleanup = tempfile.TemporaryDirectory.cleanup

        def setup(fixture):
            fixtures.append(fixture)
            original_setup(fixture)

        def connect(*args, **kwargs):
            connection = original_connect(*args, **kwargs)
            connections.append(connection)
            return connection

        def cleanup(temporary):
            if release_failure:
                raise OSError("injected directory release failure")
            original_cleanup(temporary)
            if cleanup_failure:
                raise OSError("injected fixture cleanup failure")

        failures = {
            "catalog": (SessionCatalogStore, "register"),
            "artifact": (SessionArtifactContract, "index"),
            "snapshot": (SchemaRepair, "snapshot"),
        }
        result = unittest.TestResult()
        try:
            with (
                patch.object(SessionArtifactContract, "setUp", setup),
                patch.object(sqlite3, "connect", connect),
                patch.object(tempfile.TemporaryDirectory, "cleanup", cleanup),
            ):
                if failure is None:
                    case.run(result)
                else:
                    owner, method = failures[failure]
                    with patch.object(
                        owner, method, side_effect=RuntimeError("injected setup failure")
                    ):
                        case.run(result)
            self.assertEqual(len(fixtures), 1)
            self.assertTrue(connections)
            for connection in connections:
                with self.assertRaisesRegex(sqlite3.ProgrammingError, "closed database"):
                    connection.execute("SELECT 1")
            self.assertFalse(fixtures[0].root.exists(), "fixture directory leaked before exit")
            self.assertFalse(result.failures)
            self.assertEqual(result.testsRun, 1)
            self.assertEqual(len(result.errors), int(failure is not None) + int(cleanup_failure))
            diagnostics = "\n".join(message for _, message in result.errors)
            if failure is not None:
                self.assertIn("injected setup failure", diagnostics)
            if cleanup_failure:
                self.assertIn("injected fixture cleanup failure", diagnostics)
        finally:
            for connection in connections:
                connection.close()
            for fixture in fixtures:
                if hasattr(fixture, "_temporary"):
                    original_cleanup(fixture._temporary)

    def test_success_releases_database_connections_and_directory_before_exit(self):
        self.exercise()

    def test_setup_failures_release_resources_before_exit(self):
        for failure in ("catalog", "artifact", "snapshot"):
            with self.subTest(failure=failure):
                self.exercise(failure)
        self.exercise("catalog", delegated=False)

    def test_setup_and_cleanup_errors_both_remain_visible(self):
        self.exercise("snapshot", cleanup_failure=True)

    def test_failed_directory_release_is_detected(self):
        with self.assertRaisesRegex(AssertionError, "fixture directory leaked"):
            self.exercise("snapshot", release_failure=True)

    def test_missing_cleanup_registration_is_detected(self):
        for owner, failure, delegated in (
            (SessionArtifactContract, "catalog", False),
            (SchemaRepair, "snapshot", True),
        ):
            with self.subTest(owner=owner.__name__):
                with patch.object(owner, "addCleanup"):
                    with self.assertRaisesRegex(AssertionError, "fixture directory leaked"):
                        self.exercise(failure, delegated=delegated)


def main():
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestSuite(
            unittest.defaultTestLoader.loadTestsFromTestCase(case)
            for case in (SchemaRepair, FixtureLifecycle)
        )
    )
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
