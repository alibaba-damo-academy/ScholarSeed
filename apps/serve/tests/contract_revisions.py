"""Revision receipts never replace strict schema checks or own user data."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.persistence.project import schema_transaction
from service.persistence.revisions import (
    Migration,
    Revisions,
    SchemaRevisionInvalid,
    SchemaUpgradeRequired,
)


class RevisionContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "sessions.sqlite3"

    def test_legacy_migration_preserves_rows_and_reopen_is_read_only(self) -> None:
        store = SessionCatalogStore(self.database)
        store.register(
            "retained-session",
            SessionPrincipal("retained-owner"),
            runtime_id="codex",
            vendor_thread_id="retained-thread",
            vendor_session_id="retained-process",
            runtime_workdir="/retained",
            project_path="/retained",
            output_root="/retained/outputs",
            codex_version="0.42.0",
            model_id="test",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="Retained",
            created_at=1.0,
        )
        policy = store._revisions()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"DROP TABLE {policy.table}")
            connection.execute("ALTER TABLE session_catalog DROP COLUMN display_order")
            connection.execute(
                "ALTER TABLE session_catalog ADD COLUMN work TEXT NOT NULL DEFAULT ''"
            )
            connection.execute("UPDATE session_catalog SET work='retained content'")
        self.assertTrue(store.inspect_schema(self.database).needs_write)
        migrated = SessionCatalogStore(self.database)
        self.assertEqual(migrated.get("retained-session").principal_id, "retained-owner")
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(policy.inspect(connection), policy.current)
            self.assertEqual(
                connection.execute("SELECT work FROM session_catalog").fetchone()[0],
                "retained content",
            )
            before = tuple(connection.iterdump())
        with patch.object(SessionCatalogStore, "_connect", side_effect=AssertionError("write")):
            SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_future_revision_precedes_structural_rejection_without_writes(self) -> None:
        store = SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"UPDATE {store._revisions().table} SET revision=2")
            connection.execute("ALTER TABLE session_catalog ADD COLUMN future_column TEXT")
        before = self.database.read_bytes()
        with patch.object(SessionCatalogStore, "_connect", side_effect=AssertionError("write")):
            with self.assertRaisesRegex(SchemaUpgradeRequired, "revision=2 supported=1"):
                SessionCatalogStore(self.database)
        self.assertEqual(self.database.read_bytes(), before)

    def test_current_revision_does_not_admit_unknown_schema(self) -> None:
        store = SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("ALTER TABLE session_catalog ADD COLUMN unknown_column TEXT")
        before = self.database.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "unsupported session schema declaration"):
            SessionCatalogStore(self.database)
        self.assertEqual(self.database.read_bytes(), before)

    def test_unsupported_legacy_is_not_stamped(self) -> None:
        store = SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"DROP TABLE {store._revisions().table}")
            connection.execute("ALTER TABLE session_catalog ADD COLUMN unexpected TEXT")
        before = self.database.read_bytes()
        with self.assertRaises(RuntimeError):
            SessionCatalogStore(self.database)
        self.assertEqual(self.database.read_bytes(), before)

    def test_corrupt_receipts_never_become_upgrade_advice(self) -> None:
        changes = (
            "DELETE FROM session_catalog_schema_revision",
            "PRAGMA ignore_check_constraints=ON; UPDATE session_catalog_schema_revision SET revision=0",
            "UPDATE session_catalog_schema_revision SET revision='future'",
            "UPDATE session_catalog_schema_revision SET revision=1.5",
            "ALTER TABLE session_catalog_schema_revision ADD COLUMN extra TEXT",
            "CREATE TRIGGER revision_mutation AFTER UPDATE ON session_catalog_schema_revision BEGIN SELECT 1; END",
        )
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                database = self.database.with_name(f"invalid-{index}.sqlite3")
                SessionCatalogStore(database)
                with closing(sqlite3.connect(database)) as connection, connection:
                    connection.executescript(change)
                before = database.read_bytes()
                with self.assertRaises(SchemaRevisionInvalid):
                    SessionCatalogStore(database)
                self.assertEqual(database.read_bytes(), before)

    def test_migration_error_rolls_back_ddl_rows_and_receipt(self) -> None:
        with closing(sqlite3.connect(":memory:")) as connection:
            connection.execute("CREATE TABLE asset(value TEXT)")
            connection.execute("INSERT INTO asset VALUES ('keep')")
            connection.commit()
            before = tuple(connection.iterdump())

            def first(db):
                db.execute("ALTER TABLE asset ADD COLUMN label TEXT")

            def second(db):
                db.execute("UPDATE asset SET value='must roll back'")
                raise RuntimeError("injected migration failure")

            policy = Revisions("test_owner", (Migration(1, 0, first), Migration(2, 1, second)))
            with schema_transaction(connection):
                with self.assertRaisesRegex(RuntimeError, "injected migration failure"):
                    policy.migrate(connection, validate=lambda db: False, repair=lambda db: None)
                self.assertTrue(connection.in_transaction)
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_ordered_chain_and_known_revision_upgrade_are_idempotent(self) -> None:
        with closing(sqlite3.connect(":memory:")) as connection:
            calls = []

            def first(db):
                calls.append(1)
                db.execute("CREATE TABLE asset(value TEXT)")
                db.execute("INSERT INTO asset VALUES ('keep')")

            def second(db):
                calls.append(2)
                db.execute("ALTER TABLE asset ADD COLUMN label TEXT")

            old = Revisions("test_owner", (Migration(1, 0, first),))
            old.migrate(connection, validate=lambda db: False, repair=lambda db: None)
            newer = Revisions("test_owner", (*old.steps, Migration(2, 1, second)))
            newer.migrate(connection, validate=lambda db: False, repair=lambda db: None)
            newer.migrate(connection, validate=lambda db: False, repair=lambda db: None)
            self.assertEqual(calls, [1, 2])
            self.assertEqual(newer.inspect(connection), 2)
            self.assertEqual(connection.execute("SELECT value FROM asset").fetchone()[0], "keep")
            with self.assertRaises(SchemaUpgradeRequired):
                old.inspect(connection)

    def test_nonconvergent_migration_is_not_stamped(self) -> None:
        with closing(sqlite3.connect(":memory:")) as connection:
            policy = Revisions(
                "test_owner",
                (Migration(1, 0, lambda db: db.execute("CREATE TABLE asset(value TEXT)")),),
            )
            with self.assertRaisesRegex(RuntimeError, "did not converge"):
                policy.migrate(connection, validate=lambda db: True, repair=lambda db: None)
            self.assertEqual(connection.execute("SELECT name FROM sqlite_master").fetchall(), [])

    def test_policy_rejects_gaps_duplicates_and_wrong_parent(self) -> None:
        for steps in (
            (Migration(2, 0, lambda db: None),),
            (Migration(1, 1, lambda db: None),),
            (Migration(True, 0, lambda db: None),),
        ):
            with self.assertRaises(ValueError):
                Revisions("test_owner", steps)


if __name__ == "__main__":
    unittest.main()
