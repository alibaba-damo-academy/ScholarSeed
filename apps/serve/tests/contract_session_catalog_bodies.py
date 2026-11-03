"""File-backed catalog body references preserve public records and recovery."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scholarseed_runtime.contract import ActorKind, DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.history import HistoryEntry, MessagePhase
from service.chat.persistence import journal
from service.chat.persistence.catalog import (
    CATALOG_BODY_FIELDS,
    CATALOG_BODY_KEYS,
    SESSION_HIL_TABLE,
    SESSION_MESSAGE_QUEUE_TABLE,
    SESSION_PORTABLE_HISTORY_TABLE,
    SESSION_TURN_SETTLEMENT_TABLE,
    SESSION_UNCERTAINTY_TABLE,
    HilStatus,
    SessionCatalogStore,
    SessionPrincipal,
    UncertaintyKind,
    UncertaintyState,
)

SESSION = "body-session"
OWNER = SessionPrincipal("body-owner")
BODY = "用户正文 with Unicode 🔬 and a reference-like \\u001escholarseed-body-v1: string"


class SessionCatalogBodiesContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.allocate(
            SESSION,
            OWNER,
            runtime_id="codex",
            runtime_workdir=self.temporary.name,
            output_root=self.temporary.name,
            project_path=None,
        )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _body_path(self) -> Path:
        with closing(self._connect()) as connection:
            return journal.Journal(connection, self.database).path

    def _hil(self, request: str = "permission") -> None:
        self.catalog.record_hil(
            product_request_id=request,
            session_id=SESSION,
            vendor_request_id=request,
            vendor_turn_id="turn",
            vendor_item_id="item",
            method="approval",
            payload={"question": BODY},
        )

    def test_new_bodies_are_external_and_records_survive_reopen(self) -> None:
        queued = self.catalog.enqueue_message(SESSION, "request", {"text": BODY})
        self.assertEqual(self.catalog.enqueue_message(SESSION, "request", {"text": BODY}), queued)
        self._hil()
        self.assertTrue(self.catalog.resolve_hil("permission", {"answer": BODY}))
        self.assertTrue(
            self.catalog.claim_uncertainty(
                SESSION, UncertaintyKind.TURN, "turn", payload={"input": BODY}
            )
        )
        history = (HistoryEntry("assistant", BODY, "turn", "item", MessagePhase.FINAL_ANSWER),)
        with closing(self._connect()) as connection, connection:
            SessionCatalogStore._replace_portable_history(connection, SESSION, history)
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.queued_message(SESSION, "request"), queued)
        self.assertEqual(reopened.hil("permission").payload, {"question": BODY})
        self.assertEqual(reopened.hil("permission").decision, {"answer": BODY})
        self.assertEqual(reopened.portable_history(SESSION), history)
        uncertainty = reopened.uncertainty(SESSION, UncertaintyKind.TURN, "turn")
        assert uncertainty is not None
        self.assertEqual(uncertainty.payload, {"input": BODY})
        with closing(self._connect()) as connection:
            for table, fields in CATALOG_BODY_FIELDS.items():
                for row in connection.execute(f"SELECT * FROM {table}"):
                    for field in fields:
                        if row[field + "_ref"] is not None:
                            self.assertEqual(row[field], "")
            SessionCatalogStore.inspect_rows(connection)
        self.assertTrue(self._body_path().is_file())

    def test_legacy_inline_is_not_moved_at_initialize_and_migration_is_bounded(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executemany(
                f"INSERT INTO {SESSION_PORTABLE_HISTORY_TABLE} (session_id,ordinal,role,text) VALUES (?,?,?,?)",
                ((SESSION, index, "user", BODY + str(index)) for index in range(3)),
            )
        before = self.catalog.portable_history(SESSION)
        SessionCatalogStore(self.database)
        self.assertFalse(self.database.with_suffix(journal.JOURNAL_SUFFIX).exists())
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(
                SessionCatalogStore.migrate_bodies(
                    connection, self.database, limit=2, byte_limit=1
                ),
                1,
            )
        self.assertEqual(self.catalog.portable_history(SESSION), before)
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(
                SessionCatalogStore.migrate_bodies(connection, self.database, limit=1), 1
            )
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(SessionCatalogStore.migrate_bodies(connection, self.database), 1)
            self.assertEqual(SessionCatalogStore.migrate_bodies(connection, self.database), 0)
        self.assertEqual(self.catalog.portable_history(SESSION), before)

    def test_outer_transaction_rolls_back_body_indexes_and_product_state(self) -> None:
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.catalog.record_browser_hil(
                connection=connection,
                request_id="rolled-back",
                session_id=SESSION,
                turn_id="turn",
                payload={"question": BODY},
                method="approval",
            )
            connection.rollback()
            self.assertEqual(
                connection.execute(f"SELECT COUNT(*) FROM {SESSION_HIL_TABLE}").fetchone()[0], 0
            )
            self.assertEqual(
                connection.execute(f"SELECT COUNT(*) FROM {journal.BODY_TABLE}").fetchone()[0], 0
            )
        self._hil("committed")
        self.assertEqual(self.catalog.hil("committed").payload, {"question": BODY})

    def test_projection_requires_explicit_source_path_and_does_not_write_journal(self) -> None:
        self.catalog.enqueue_message(SESSION, "request", {"text": BODY})
        path = self._body_path()
        original = path.read_bytes()
        with closing(self._connect()) as source, closing(sqlite3.connect(":memory:")) as projected:
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            with self.assertRaisesRegex(RuntimeError, "original database path"):
                SessionCatalogStore.inspect_rows(projected)
            projected.execute("PRAGMA query_only=ON")
            SessionCatalogStore.inspect_rows(projected, database=self.database)
        self.assertEqual(path.read_bytes(), original)

    def test_inspection_reuses_one_reader_across_rows_and_catalog_owners(self) -> None:
        self.catalog.enqueue_message(SESSION, "first", {"text": BODY})
        self.catalog.enqueue_message(SESSION, "second", {"text": BODY + " second"})
        self._hil()
        self.catalog.resolve_hil("permission", {"answer": BODY})
        path = self._body_path()
        original = path.read_bytes()
        journal_type = journal.Journal
        with closing(self._connect()) as source, closing(sqlite3.connect(":memory:")) as projected:
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            projected.execute("PRAGMA query_only=ON")
            with patch.object(journal, "Journal", side_effect=journal_type) as opened:
                SessionCatalogStore.inspect_rows(projected, database=self.database)
                opened.assert_called_once_with(projected, self.database)
        self.assertEqual(path.read_bytes(), original)

    def test_inspection_without_references_needs_no_reader_or_database_path(self) -> None:
        with closing(self._connect()) as source, closing(sqlite3.connect(":memory:")) as projected:
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            projected.execute("PRAGMA query_only=ON")
            with patch.object(journal, "Journal", side_effect=AssertionError("unexpected reader")):
                SessionCatalogStore.inspect_rows(projected)
        self.assertFalse(self.database.with_suffix(journal.JOURNAL_SUFFIX).exists())

    def test_inspection_propagates_shared_reader_close_failure(self) -> None:
        self.catalog.enqueue_message(SESSION, "request", {"text": BODY})
        closed = []

        class FailingClose(journal.Journal):
            def close(self, *, validate: bool = True) -> None:
                super().close(validate=validate)
                closed.append(True)
                raise OSError("journal binding changed at close")

        with closing(self._connect()) as connection:
            with patch.object(journal, "Journal", FailingClose):
                with self.assertRaisesRegex(OSError, "binding changed at close"):
                    SessionCatalogStore.inspect_rows(connection, database=self.database)
        self.assertEqual(closed, [True])

    def test_missing_body_fails_instead_of_returning_empty_history(self) -> None:
        self.catalog.enqueue_message(SESSION, "request", {"text": BODY})
        self._body_path().unlink()
        with self.assertRaises(OSError):
            self.catalog.queued_message(SESSION, "request")
        with closing(self._connect()) as connection:
            with self.assertRaises(OSError):
                SessionCatalogStore.inspect_rows(connection)

    def test_mixed_inline_and_reference_corruption_is_rejected(self) -> None:
        self.catalog.enqueue_message(SESSION, "request", {"text": BODY})
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET body=?", (json.dumps({"text": "wrong"}),)
            )
        with self.assertRaisesRegex(RuntimeError, "both inline"):
            self.catalog.queued_message(SESSION, "request")

    def test_decisions_updates_and_uncertainty_recovery_keep_reference_semantics(self) -> None:
        self._hil()
        self.assertTrue(
            self.catalog.seal_hil_uncertainty(
                "permission",
                {"answer": BODY},
                UncertaintyKind.HIL_RESPONSE,
                payload={"submission": BODY},
            )
        )
        self.assertEqual(self.catalog.hil("permission").status, HilStatus.UNKNOWN)
        self.assertEqual(self.catalog.hil("permission").decision, {"answer": BODY})
        self.assertTrue(
            self.catalog.transition_uncertainty(
                SESSION, UncertaintyKind.HIL_RESPONSE, "permission", UncertaintyState.RECONCILED
            )
        )
        uncertainty = self.catalog.uncertainty(SESSION, UncertaintyKind.HIL_RESPONSE, "permission")
        assert uncertainty is not None
        self.assertEqual(uncertainty.payload, {"submission": BODY})
        self.assertTrue(
            self.catalog.transition_uncertainty(
                SESSION,
                UncertaintyKind.HIL_RESPONSE,
                "permission",
                UncertaintyState.CONFIRMED,
                payload={"response": BODY},
            )
        )
        uncertainty = self.catalog.uncertainty(SESSION, UncertaintyKind.HIL_RESPONSE, "permission")
        assert uncertainty is not None
        self.assertEqual(uncertainty.payload, {"response": BODY})
        with closing(self._connect()) as connection:
            self.assertEqual(
                connection.execute(f"SELECT payload FROM {SESSION_UNCERTAINTY_TABLE}").fetchone()[
                    0
                ],
                "",
            )

    def test_all_legacy_body_columns_migrate_without_changing_records_and_rollback(self) -> None:
        self.catalog.enqueue_message(SESSION, "legacy-queue", {"text": BODY})
        self._hil()
        self.catalog.resolve_hil("permission", {"answer": BODY})
        self.catalog.claim_uncertainty(
            SESSION, UncertaintyKind.TURN, "legacy-turn", payload={"request": BODY}
        )
        before = (
            self.catalog.queued_message(SESSION, "legacy-queue"),
            self.catalog.hil("permission"),
            self.catalog.uncertainty(SESSION, UncertaintyKind.TURN, "legacy-turn"),
        )
        # Recreate old inline values through the same decoded bytes, without changing identities.
        with closing(self._connect()) as connection, connection:
            with journal.Journal(connection, self.database) as bodies:
                for table, fields in CATALOG_BODY_FIELDS.items():
                    for row in connection.execute(f"SELECT rowid,* FROM {table}").fetchall():
                        for field in fields:
                            reference = row[field + "_ref"]
                            if reference is not None:
                                connection.execute(
                                    f"UPDATE {table} SET {field}=?, {field}_ref=NULL WHERE rowid=?",
                                    (bodies.get(reference), row["rowid"]),
                                )
        with closing(self._connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(SessionCatalogStore.migrate_bodies(connection, self.database), 4)
            connection.rollback()
            self.assertEqual(
                connection.execute(
                    f"SELECT body_ref FROM {SESSION_MESSAGE_QUEUE_TABLE}"
                ).fetchone()[0],
                None,
            )
        with closing(self._connect()) as connection, connection:
            connection.execute("BEGIN IMMEDIATE")
            self.assertEqual(SessionCatalogStore.migrate_bodies(connection, self.database), 4)
        after = (
            self.catalog.queued_message(SESSION, "legacy-queue"),
            self.catalog.hil("permission"),
            self.catalog.uncertainty(SESSION, UncertaintyKind.TURN, "legacy-turn"),
        )
        self.assertEqual(after, before)
        self.catalog.enqueue_message(SESSION, "recover", {"text": BODY})
        self.catalog.begin_queued_submission(SESSION, "recover")
        self.catalog.recover_inflight()
        recovered = self.catalog.queued_message(SESSION, "recover")
        assert recovered is not None
        self.assertEqual(recovered.body, {"text": BODY})

    def test_pending_migration_uses_owned_partial_indexes(self) -> None:
        with closing(self._connect()) as connection:
            for table, fields in CATALOG_BODY_FIELDS.items():
                for body_field in fields:
                    plan = connection.execute(
                        f"EXPLAIN QUERY PLAN SELECT rowid,length(CAST({body_field} AS BLOB)) "
                        f"FROM {table} WHERE {body_field}_ref IS NULL "
                        f"AND {body_field} IS NOT NULL AND {body_field} != '' "
                        f"ORDER BY {','.join(CATALOG_BODY_KEYS[table])} LIMIT ?",
                        (1,),
                    ).fetchall()
                    self.assertTrue(
                        any(f"idx_{table}_{body_field}_inline" in row[3] for row in plan), plan
                    )

    def test_terminal_event_body_roundtrips_with_runtime_enums(self) -> None:
        event = RuntimeEvent(
            schema_version=1,
            event_id="terminal",
            runtime_id="codex",
            product_session_id=SESSION,
            native_session_id="thread",
            process_generation=2,
            sequence=8,
            kind=RuntimeEventKind.TURN_FAILED,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-10-14T00:00:00Z",
            native_turn_id="turn",
            actor_kind=ActorKind.MAIN,
            payload={"reason": BODY},
        )
        expected = self.catalog.record_turn_settlement(SESSION, "client-turn", event)
        self.assertEqual(
            SessionCatalogStore(self.database).pending_turn_settlement(SESSION), expected
        )
        with closing(self._connect()) as connection:
            row = connection.execute(
                f"SELECT event_json,event_json_ref FROM {SESSION_TURN_SETTLEMENT_TABLE}"
            ).fetchone()
            self.assertEqual(row["event_json"], "")
            self.assertTrue(row["event_json_ref"])
            SessionCatalogStore.inspect_rows(connection)


if __name__ == "__main__":
    unittest.main()
