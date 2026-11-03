"""Contract for the final product session catalog and durable HIL state."""

from __future__ import annotations

import asyncio
import dataclasses
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Thread
from typing import Any, Mapping, TypedDict, TypeVar
from unittest.mock import patch

from scholarseed_runtime.contract import (
    ActorKind,
    CapabilitySet,
    CapabilityState,
    DeliveryClass,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeEvent,
    RuntimeEventKind,
    SkillPolicy,
)
from scholarseed_runtime.contract.incident import RUNTIME_TURN_NOT_SUBMITTED
from service.assistant.service.authorization import (
    AUTHORIZATION_REQUIRED,
    LITERATURE_REVIEW_AUTHORIZATION_HEADER,
    LITERATURE_REVIEW_FULLTEXT,
    PRECISE_SEARCH_AUTHORIZATION_HEADER,
    PRECISE_SEARCH_FULLTEXT,
    RESEARCH_IDEA_AUTHORIZATION_HEADER,
    RESEARCH_IDEA_FULLTEXT,
    FulltextAuthorizer,
    authorization_question,
)
from service.chat.constants import (
    PRODUCT_EVENT_VERSION,
    SESSION_TITLE_DEFAULT,
    SessionTitleFallback,
)
from service.chat.persistence.catalog import (
    CATALOG_COLUMNS,
    LEGACY_RUNTIME_ID,
    MAX_QUEUED_MESSAGES_PER_SESSION,
    QUEUE_RECOVERY_WAIT_INTERRUPTED,
    SESSION_CATALOG_TABLE,
    SESSION_HIL_TABLE,
    SESSION_MESSAGE_QUEUE_TABLE,
    SESSION_UNCERTAINTY_TABLE,
    HilStatus,
    OpenState,
    QueuedMessageState,
    SessionAccessError,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionListScope,
    SessionPrincipal,
    SessionQueueCapacityError,
    SessionStateConflictError,
    SessionStatus,
    SubmissionMode,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventRecord, ProductEventStore
from service.chat.runtime.interaction import SessionInteractions
from service.platform.activity import Activities, ActivityDomain

OWNER = SessionPrincipal("catalog-owner")
OTHER_OWNER = SessionPrincipal("other-owner")
RUNTIME_ID = "codex"
TEST_DEADLINE = 2_000_000_000.0
ATTACHMENT_COUNT = 8


Record = TypeVar("Record")


def require_present(value: Record | None) -> Record:
    """Fail at the lookup when a fixture expects a durable record to exist."""
    assert value is not None
    return value


class TitleAllocation(TypedDict):
    runtime_id: str
    runtime_workdir: str
    project_path: str | None
    output_root: str
    title: str


def published_event(kind: str, data: Mapping[str, Any]) -> ProductEventRecord:
    return ProductEventRecord(
        event_id=1,
        session_id="publisher-fixture",
        runtime_id=RUNTIME_ID,
        vendor_thread_id="",
        vendor_turn_id=None,
        vendor_item_id=None,
        kind=kind,
        payload=dict(data),
        schema_version=PRODUCT_EVENT_VERSION,
        product_seq=1,
        idempotency_key="publisher-fixture",
        created_at=20.0,
    )


def allocate_session(catalog: SessionCatalogStore, session_id: str) -> None:
    catalog.allocate(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        runtime_workdir=f"/research/{session_id}",
        project_path="/research",
        output_root=f"/research/{session_id}/outputs",
        model_id="gpt-5-codex",
        created_at=20.0,
        required_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
    )


def native_binding(session_id: str, thread_id: str) -> RuntimeBinding:
    return RuntimeBinding(
        product_session_id=session_id,
        runtime_id=RUNTIME_ID,
        adapter_version="0.2.0",
        runtime_version="0.147.0",
        protocol_version="2",
        protocol_schema_hash="a" * 64,
        opaque_session_ref=thread_id,
        capabilities=CapabilitySet(),
    )


def register_session(
    catalog: SessionCatalogStore,
    session_id: str,
    vendor_thread_id: str,
    *,
    runtime_binding: RuntimeBinding | None = None,
) -> None:
    catalog.register(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=vendor_thread_id,
        vendor_session_id="vendor-process-1",
        runtime_workdir=f"/research/{session_id}",
        project_path="/research",
        output_root=f"/research/{session_id}/outputs",
        codex_version="0.42.0",
        model_id="gpt-5-codex",
        policy_id="workspace-write",
        status=SessionStatus.READY,
        title="新研究会话",
        created_at=20.0,
        runtime_binding=runtime_binding,
    )


class SessionCatalogContract(unittest.TestCase):
    def test_archive_migration_preserves_existing_columns_and_history(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "old", "thread-old")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {SESSION_CATALOG_TABLE} DROP COLUMN archived")
            connection.execute(
                f"ALTER TABLE {SESSION_CATALOG_TABLE} ADD COLUMN work TEXT NOT NULL DEFAULT ''"
            )
            connection.execute(f"UPDATE {SESSION_CATALOG_TABLE} SET work = 'keep'")
        upgraded = SessionCatalogStore(self.database)
        self.assertFalse(require_present(upgraded.get("old")).archived)
        upgraded.set_archived("old", OWNER, True)
        self.assertTrue(require_present(SessionCatalogStore(self.database).get("old")).archived)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(f"SELECT work FROM {SESSION_CATALOG_TABLE}").fetchone(),
                ("keep",),
            )

    def test_archive_is_owned_durable_and_filtered_before_pagination(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "archived", "thread-archive")
        register_session(catalog, "active", "thread-active")
        original = require_present(catalog.get("archived"))
        for archived in (True, True, False, True):
            self.assertEqual(
                catalog.set_archived("archived", OWNER, archived),
                dataclasses.replace(original, archived=archived),
            )
        reopened = SessionCatalogStore(self.database)
        self.assertTrue(require_present(reopened.get("archived")).archived)
        for principal, session_id in ((OTHER_OWNER, "archived"), (OWNER, "missing")):
            with self.assertRaises(SessionAccessError):
                reopened.set_archived(session_id, principal, False)
        for archived, expected in ((True, "archived"), (False, "active")):
            rows = reopened.listed(
                OWNER,
                runtime_id=RUNTIME_ID,
                scope=SessionListScope.PROJECT,
                project_path="/research",
                limit=1,
                archived=archived,
            )
            self.assertEqual([record.session_id for record in rows], [expected])
        reopened.update_status("archived", SessionStatus.COMPLETED)
        self.assertTrue(require_present(reopened.get("archived")).archived)

    def test_pinning_is_durable_owned_and_does_not_change_activity(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "older", "thread-older")
        register_session(catalog, "newer", "thread-newer")
        catalog.rename("newer", OWNER, "newer", updated_at=30.0)
        original = require_present(catalog.get("older"))
        self.assertFalse(original.pinned)
        for pinned in (True, True, False, False, True):
            changed = catalog.set_pinned("older", OWNER, pinned)
            self.assertEqual(changed, dataclasses.replace(original, pinned=pinned))
        reopened = SessionCatalogStore(self.database)
        self.assertTrue(require_present(reopened.get("older")).pinned)
        for principal, session_id in ((OTHER_OWNER, "older"), (OWNER, "missing")):
            with self.assertRaises(SessionAccessError):
                reopened.set_pinned(session_id, principal, False)
        invalid: Any = "false"
        with self.assertRaises(ValueError):
            reopened.set_pinned("older", OWNER, invalid)
        for scope, project, expected in (
            (SessionListScope.PROJECT, "/research", "older"),
            (SessionListScope.ALL, None, "newer"),
        ):
            rows = reopened.listed(
                OWNER, runtime_id=RUNTIME_ID, scope=scope, project_path=project, limit=1
            )
            self.assertEqual([record.session_id for record in rows], [expected])
        reopened.set_pinned("older", OWNER, False)
        rows = reopened.listed(
            OWNER,
            runtime_id=RUNTIME_ID,
            scope=SessionListScope.PROJECT,
            project_path="/research",
            limit=1,
        )
        self.assertEqual([record.session_id for record in rows], ["newer"])

    def test_pinning_migration_preserves_old_rows_and_extra_columns(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "old", "thread-old")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {SESSION_CATALOG_TABLE} DROP COLUMN pinned")
            connection.execute(
                f"ALTER TABLE {SESSION_CATALOG_TABLE} ADD COLUMN work TEXT NOT NULL DEFAULT ''"
            )
            connection.execute(f"UPDATE {SESSION_CATALOG_TABLE} SET work = 'preserve'")
        self.assertTrue(SessionCatalogStore.inspect_schema(self.database).needs_write)
        upgraded = SessionCatalogStore(self.database)
        self.assertFalse(require_present(upgraded.get("old")).pinned)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(f"SELECT work FROM {SESSION_CATALOG_TABLE}").fetchone(),
                ("preserve",),
            )
        self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)

    def test_schema_inspection_does_not_create_missing_database(self) -> None:
        missing = self.database.parent / "missing" / "sessions.sqlite3"
        self.assertTrue(SessionCatalogStore.inspect_schema(missing).needs_write)
        self.assertFalse(missing.parent.exists())

    def test_current_constructor_does_not_open_a_write_connection(self) -> None:
        SessionCatalogStore(self.database)
        with patch.object(
            SessionCatalogStore,
            "_connect",
            side_effect=AssertionError("unexpected writable connection"),
        ):
            SessionCatalogStore(self.database)

    def test_schema_inspection_detects_binding_and_activation_backfills(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "binding-session", "binding-thread")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM session_runtime_binding")
            connection.execute("DELETE FROM session_activation")
        schema = SessionCatalogStore.inspect_schema(self.database)
        self.assertTrue(schema.binding_backfill)
        self.assertTrue(schema.activation_backfill)
        SessionCatalogStore(self.database)
        self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DELETE FROM session_activation")
        schema = SessionCatalogStore.inspect_schema(self.database)
        self.assertFalse(schema.binding_backfill)
        self.assertTrue(schema.activation_backfill)
        SessionCatalogStore(self.database)
        self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)

    def test_empty_binding_is_not_evidence_for_activation_backfill(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "empty-binding", "existing-thread")
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("UPDATE session_runtime_binding SET opaque_session_ref=''")
            connection.execute("DELETE FROM session_activation")
        self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)
        with patch.object(
            SessionCatalogStore, "_connect", side_effect=AssertionError("unexpected write")
        ):
            SessionCatalogStore(self.database)

    def test_schema_inspection_sees_wal_without_writing_and_repairs_missing_index(self) -> None:
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute("DROP INDEX idx_session_hil_pending")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            schema = SessionCatalogStore.inspect_schema(self.database)
            self.assertEqual(schema.create_indexes, ("idx_session_hil_pending",))
            self.assertEqual((self.database.read_bytes(), wal.read_bytes()), before)
            SessionCatalogStore(self.database)
            self.assertFalse(SessionCatalogStore.inspect_schema(self.database).needs_write)

    def test_schema_inspection_rejects_unknown_structure_before_constructor_writes(self) -> None:
        changes = (
            "ALTER TABLE session_catalog ADD COLUMN future_scope TEXT",
            "CREATE TABLE session_access (data TEXT)",
            "CREATE TABLE session_catalog_migration (data TEXT)",
            "DROP INDEX idx_session_hil_pending; CREATE INDEX idx_session_hil_pending ON session_hil(method)",
            "DROP TABLE session_message_queue; CREATE TABLE session_message_queue AS SELECT 1 AS queued_message_id",
        )
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                path = self.database.with_name(f"unknown-{index}.sqlite3")
                SessionCatalogStore(path)
                with closing(sqlite3.connect(path)) as connection, connection:
                    connection.executescript(change)
                    before = tuple(connection.iterdump())
                with self.assertRaises(RuntimeError):
                    SessionCatalogStore.inspect_schema(path)
                with patch.object(
                    SessionCatalogStore, "_connect", side_effect=AssertionError("unexpected write")
                ):
                    with self.assertRaises(RuntimeError):
                        SessionCatalogStore(path)
                with closing(sqlite3.connect(path)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_schema_inspection_refuses_queue_missing_historical_constraints(self) -> None:
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE name='session_message_queue'"
            ).fetchone()[0]
            connection.execute("DROP TABLE session_message_queue")
            connection.execute(sql.replace("UNIQUE(session_id, enqueue_seq),", ""))
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "missing constraints"):
            SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_known_foreign_key_repairs_are_read_only_to_inspect_and_preserve_rows(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "known-session", "known-thread")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            for table in (SESSION_HIL_TABLE, SESSION_UNCERTAINTY_TABLE):
                sql = connection.execute(
                    "SELECT sql FROM sqlite_master WHERE name=?", (table,)
                ).fetchone()[0]
                connection.execute(f"DROP TABLE {table}")
                connection.execute(
                    sql.replace(
                        "REFERENCES session_catalog(", "REFERENCES session_catalog_migration("
                    )
                )
            connection.execute(
                f"INSERT INTO {SESSION_HIL_TABLE} (product_request_id,session_id,vendor_request_id,method,payload,status,created_at) VALUES ('request','known-session','vendor','tool','{{}}','pending',1)"
            )
            connection.execute(
                f"INSERT INTO {SESSION_UNCERTAINTY_TABLE} (session_id,kind,correlation_id,state,created_at) VALUES ('known-session','turn','correlation','unknown',1)"
            )
            rows = {
                table: connection.execute(f"SELECT * FROM {table}").fetchall()
                for table in (SESSION_HIL_TABLE, SESSION_UNCERTAINTY_TABLE)
            }
        with closing(sqlite3.connect(self.database)) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            before = tuple(connection.iterdump())
            self.assertEqual(
                SessionCatalogStore._foreign_key_repairs(connection),
                (SESSION_HIL_TABLE, SESSION_UNCERTAINTY_TABLE),
            )
            self.assertEqual(tuple(connection.iterdump()), before)
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            for table, expected in rows.items():
                self.assertEqual(connection.execute(f"SELECT * FROM {table}").fetchall(), expected)
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_foreign_key_repair_refuses_unknown_definitions_without_changes(self) -> None:
        for table in (SESSION_HIL_TABLE, SESSION_UNCERTAINTY_TABLE):
            for change in ("target", "check", "extra_foreign_key", "missing_constraint"):
                with self.subTest(table=table, change=change):
                    path = self.database.with_name(table + "-" + change + ".sqlite3")
                    SessionCatalogStore(path)
                    with closing(sqlite3.connect(path)) as connection, connection:
                        sql = connection.execute(
                            "SELECT sql FROM sqlite_master WHERE name=?", (table,)
                        ).fetchone()[0]
                        sql = sql.replace(
                            "REFERENCES session_catalog(", "REFERENCES session_catalog_migration("
                        )
                        if change == "target":
                            sql = sql.replace("session_catalog_migration", "unknown_sessions")
                        elif change == "check":
                            sql = sql.replace(
                                "created_at REAL NOT NULL",
                                "created_at REAL NOT NULL CHECK(created_at >= 0)",
                            )
                        elif change == "extra_foreign_key":
                            end = sql.rindex(")")
                            sql = (
                                sql[:end]
                                + ", FOREIGN KEY(session_id) REFERENCES session_catalog(session_id) ON DELETE CASCADE"
                                + sql[end:]
                            )
                        else:
                            sql = sql.replace("session_id TEXT NOT NULL", "session_id TEXT")
                        connection.execute(f"DROP TABLE {table}")
                        connection.execute(sql)
                        before = tuple(connection.iterdump())
                    with self.assertRaisesRegex(RuntimeError, "unsupported session"):
                        SessionCatalogStore(path)
                    with closing(sqlite3.connect(path)) as connection:
                        self.assertEqual(tuple(connection.iterdump()), before)

    def test_foreign_key_repair_validates_whole_set_before_rebuilding(self) -> None:
        SessionCatalogStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            for table in (SESSION_HIL_TABLE, SESSION_UNCERTAINTY_TABLE):
                sql = (
                    connection.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,))
                    .fetchone()[0]
                    .replace("REFERENCES session_catalog(", "REFERENCES session_catalog_migration(")
                )
                if table == SESSION_UNCERTAINTY_TABLE:
                    sql = sql.replace(
                        "created_at REAL NOT NULL",
                        "created_at REAL NOT NULL CHECK(created_at >= 0)",
                    )
                connection.execute(f"DROP TABLE {table}")
                connection.execute(sql)
            before = tuple(connection.iterdump())
        with patch("service.chat.persistence.catalog.rebuild_table") as rebuild:
            with self.assertRaisesRegex(RuntimeError, "unsupported session"):
                SessionCatalogStore(self.database)
            rebuild.assert_not_called()
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_queue_error_details_survive_additive_migration_and_clear_on_retry(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "permission-session")
        catalog.enqueue_message("permission-session", "denied", {"text": "continue"})
        with closing(sqlite3.connect(self.database)) as connection, connection:
            columns = {
                row[1]
                for row in connection.execute(f"PRAGMA table_info({SESSION_MESSAGE_QUEUE_TABLE})")
            }
            if "safe_error_details" in columns:
                connection.execute(
                    f"ALTER TABLE {SESSION_MESSAGE_QUEUE_TABLE} DROP COLUMN safe_error_details"
                )
        catalog = SessionCatalogStore(self.database)
        self.assertEqual(
            require_present(
                catalog.queued_message("permission-session", "denied")
            ).safe_error_details,
            {},
        )
        catalog.begin_queued_submission("permission-session", "denied")
        details = {"path": "resources/受限文件.md"}
        catalog.fail_queued_submission(
            "permission-session",
            "denied",
            unknown=False,
            safe_error="resource_baseline_permission_denied",
            safe_error_details=details,
        )
        reopened = SessionCatalogStore(self.database)
        failed = reopened.queued_message("permission-session", "denied")
        self.assertEqual(require_present(failed).safe_error_details, details)
        self.assertEqual(require_present(failed).state, QueuedMessageState.FAILED)
        retried = reopened.begin_queued_submission("permission-session", "denied")
        self.assertEqual(require_present(retried).safe_error_details, {})
        self.assertEqual(require_present(retried).safe_error, "")

    def test_browser_action_ledger_is_durable_monotonic_and_redacts_request(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-ledger", "thread-browser")
        scope = {
            "session_id": "browser-ledger",
            "instance_id": "instance-browser",
            "product_turn_id": "product-turn",
            "turn_id": "native-turn",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        payload = {
            "tab_id": "tab-browser",
            "snapshot_id": "snapshot-browser",
            "element_ref": "element-browser",
            "value": "secret-low-entropy-value",
            "intent": "secret-low-entropy-intent",
        }
        first = catalog.reserve_browser_action(
            request_id="browser-action-1", scope=scope, operation="fill", payload=payload
        )
        self.assertTrue(first.created)
        self.assertEqual(first.record.status.value, "pending")
        self.assertFalse(
            catalog.reserve_browser_action(
                request_id="browser-action-1", scope=scope, operation="fill", payload=payload
            ).created
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.reserve_browser_action(
                request_id="browser-action-1",
                scope=scope,
                operation="fill",
                payload={**payload, "value": "different"},
            )
        self.assertEqual(
            require_present(
                catalog.transition_browser_action("browser-action-1", "pending", "approved")
            ).status.value,
            "approved",
        )
        self.assertEqual(
            require_present(
                catalog.transition_browser_action("browser-action-1", "approved", "dispatching")
            ).status.value,
            "dispatching",
        )
        self.assertIsNone(
            catalog.transition_browser_action("browser-action-1", "approved", "succeeded")
        )
        self.assertEqual(
            require_present(
                catalog.transition_browser_action("browser-action-1", "dispatching", "unknown")
            ).status.value,
            "unknown",
        )
        self.assertIsNone(
            catalog.transition_browser_action("browser-action-1", "unknown", "succeeded")
        )
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(
            require_present(reopened.browser_action("browser-action-1")).status.value, "unknown"
        )
        with self.assertRaises(SessionStateConflictError):
            reopened.reserve_browser_action(
                request_id="browser-action-1", scope=scope, operation="fill", payload=payload
            )
        database_bytes = self.database.read_bytes()
        self.assertNotIn(b"secret-low-entropy-value", database_bytes)
        self.assertNotIn(b"secret-low-entropy-intent", database_bytes)

    def test_browser_action_capacity_fails_closed_without_dropping_tombstones(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-ledger", "thread-browser")
        scope = {
            "session_id": "browser-ledger",
            "instance_id": "instance-browser",
            "product_turn_id": "product-turn",
            "turn_id": "native-turn",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        with patch("service.chat.persistence.catalog.MAX_BROWSER_ACTION_RECORDS", 1):
            catalog.reserve_browser_action(
                request_id="browser-action-1", scope=scope, operation="read", payload={}
            )
            with self.assertRaisesRegex(RuntimeError, "browser action capacity"):
                catalog.reserve_browser_action(
                    request_id="browser-action-2", scope=scope, operation="read", payload={}
                )
        self.assertIsNotNone(catalog.browser_action("browser-action-1"))
        self.assertIsNone(catalog.browser_action("browser-action-2"))

    def test_browser_action_startup_recovers_inflight_without_replaying_old_ids(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-recovery", "thread-browser")
        scope = {
            "session_id": "browser-recovery",
            "instance_id": "instance-browser",
            "product_turn_id": "product-turn",
            "turn_id": "native-turn",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        for index, status in enumerate(
            ("pending", "approved", "dispatching", "succeeded", "denied")
        ):
            request_id = f"browser-recovery-{index}"
            catalog.reserve_browser_action(
                request_id=request_id, scope=scope, operation="read", payload={}
            )
            if status != "pending":
                catalog.transition_browser_action(request_id, "pending", "approved")
            if status in ("dispatching", "succeeded"):
                catalog.transition_browser_action(request_id, "approved", "dispatching")
            if status == "succeeded":
                catalog.transition_browser_action(request_id, "dispatching", "succeeded")
            if status == "denied":
                catalog.transition_browser_action(request_id, "approved", "denied")
        reopened = SessionCatalogStore(self.database)
        reopened.recover_inflight()
        self.assertEqual(
            [
                require_present(reopened.browser_action(f"browser-recovery-{index}")).status.value
                for index in range(5)
            ],
            ["unknown", "unknown", "unknown", "succeeded", "denied"],
        )
        self.assertIsNone(
            reopened.transition_browser_action("browser-recovery-2", "dispatching", "succeeded")
        )
        with self.assertRaises(SessionStateConflictError):
            reopened.reserve_browser_action(
                request_id="browser-recovery-0", scope=scope, operation="read", payload={}
            )

    def test_browser_action_release_cleans_only_authorized_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-deleted", "thread-browser")
        scope = {
            "session_id": "browser-deleted",
            "instance_id": "instance-browser",
            "product_turn_id": "product-turn",
            "turn_id": "native-turn",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        catalog.reserve_browser_action(
            request_id="browser-deleted-action", scope=scope, operation="read", payload={}
        )
        catalog.release("browser-deleted", OTHER_OWNER)
        self.assertIsNotNone(catalog.browser_action("browser-deleted-action"))
        catalog.release("browser-deleted", OWNER)
        self.assertIsNone(catalog.get("browser-deleted"))
        self.assertIsNone(catalog.browser_action("browser-deleted-action"))
        with self.assertRaises(SessionAccessError):
            catalog.reserve_browser_action(
                request_id="browser-deleted-action", scope=scope, operation="read", payload={}
            )

    def test_browser_action_closed_scope_reclaims_capacity_but_rejects_replay(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-long-lived", "thread-browser")
        scope = {
            "session_id": "browser-long-lived",
            "instance_id": "instance-browser",
            "product_turn_id": "product-one",
            "turn_id": "native-one",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        with patch("service.chat.persistence.catalog.MAX_BROWSER_ACTION_RECORDS", 2):
            for request_id in ("browser-old-success", "browser-old-denied"):
                catalog.reserve_browser_action(
                    request_id=request_id, scope=scope, operation="click", payload={}
                )
                catalog.transition_browser_action(request_id, "pending", "approved")
            catalog.transition_browser_action("browser-old-success", "approved", "dispatching")
            catalog.transition_browser_action("browser-old-success", "dispatching", "succeeded")
            catalog.transition_browser_action("browser-old-denied", "approved", "denied")
            next_scope = {
                **scope,
                "product_turn_id": "product-two",
                "turn_id": "native-two",
                "generation": 2,
            }
            with self.assertRaisesRegex(RuntimeError, "browser action capacity"):
                catalog.reserve_browser_action(
                    request_id="browser-new", scope=next_scope, operation="read", payload={}
                )
            catalog.archive_browser_action_scope(scope)
            self.assertIsNone(catalog.browser_action("browser-old-success"))
            self.assertIsNone(catalog.browser_action("browser-old-denied"))
            catalog.reserve_browser_action(
                request_id="browser-new", scope=next_scope, operation="read", payload={}
            )
            catalog.transition_browser_action("browser-new", "pending", "approved")
            catalog.transition_browser_action("browser-new", "approved", "dispatching")
            catalog.transition_browser_action("browser-new", "dispatching", "succeeded")
            catalog.archive_browser_action_scope(next_scope)
            for generation in range(3, 24):
                rotating_scope = {
                    **scope,
                    "product_turn_id": f"product-{generation}",
                    "turn_id": f"native-{generation}",
                    "generation": generation,
                }
                request_id = f"browser-turn-{generation}"
                catalog.reserve_browser_action(
                    request_id=request_id, scope=rotating_scope, operation="read", payload={}
                )
                catalog.transition_browser_action(request_id, "pending", "approved")
                catalog.transition_browser_action(request_id, "approved", "dispatching")
                catalog.transition_browser_action(request_id, "dispatching", "succeeded")
                catalog.archive_browser_action_scope(rotating_scope)
            with self.assertRaises(SessionStateConflictError):
                catalog.reserve_browser_action(
                    request_id="browser-old-success", scope=scope, operation="click", payload={}
                )
            with self.assertRaises(SessionStateConflictError):
                catalog.archive_browser_action_scope(
                    {**scope, "instance_id": "other-instance", "generation": 24}
                )
            reopened = SessionCatalogStore(self.database)
            with self.assertRaises(SessionStateConflictError):
                reopened.reserve_browser_action(
                    request_id="browser-old-success", scope=scope, operation="click", payload={}
                )

    def test_browser_action_unknown_scope_is_not_evicted_after_confirmed_end(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-unknown", "thread-browser")
        scope = {
            "session_id": "browser-unknown",
            "instance_id": "instance-browser",
            "product_turn_id": "product-one",
            "turn_id": "native-one",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        catalog.reserve_browser_action(
            request_id="browser-uncertain", scope=scope, operation="click", payload={}
        )
        catalog.archive_browser_action_scope(scope)
        self.assertEqual(
            require_present(catalog.browser_action("browser-uncertain")).status.value, "unknown"
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.reserve_browser_action(
                request_id="browser-uncertain", scope=scope, operation="click", payload={}
            )

    def test_browser_action_migration_preserves_rows_without_scope_identity(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "browser-legacy", "thread-browser")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("DROP TABLE session_browser_action")
            connection.execute(
                "CREATE TABLE session_browser_action ("
                "request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, "
                "operation TEXT NOT NULL, signature_epoch TEXT NOT NULL, signature_mac TEXT NOT NULL, "
                "status TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL)"
            )
            connection.execute(
                "INSERT INTO session_browser_action VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "browser-legacy-id",
                    "browser-legacy",
                    "native-one",
                    "read",
                    "old",
                    "mac",
                    "succeeded",
                    1.0,
                    1.0,
                ),
            )
        migrated = SessionCatalogStore(self.database)
        scope = {
            "session_id": "browser-legacy",
            "instance_id": "instance-browser",
            "product_turn_id": "product-one",
            "turn_id": "native-one",
            "generation": 1,
            "interrupt_generation": 0,
            "lifecycle_epoch": 1,
        }
        migrated.archive_browser_action_scope(scope)
        self.assertIsNotNone(migrated.browser_action("browser-legacy-id"))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(session_browser_action)")
            }
        self.assertIn("lifecycle_epoch", columns)

    def test_browser_requested_broadcast_failure_durably_denies_without_orphan_waiter(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-request-broadcast", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            def broadcast(record):
                if record.kind == "hil_requested":
                    raise RuntimeError("subscriber failure")

            interactions = SessionInteractions(
                "browser-request-broadcast", catalog, publish, events=events, broadcast=broadcast
            )
            result = await interactions.request_browser_approval(
                request_id="broadcast-request",
                turn_id="turn-browser",
                runtime_id=RUNTIME_ID,
                vendor_thread_id="thread-browser",
                tab_id="tab-browser",
                target_instance_id="instance-browser",
                target_generation=3,
                origin="https://example.com",
                action="read",
                intent="Read page",
                expires_at=TEST_DEADLINE,
            )
            self.assertEqual(result["decision"], "deny")
            self.assertEqual(catalog.pending_hil("browser-request-broadcast"), ())
            self.assertEqual(
                [record.kind for record in events.replay("browser-request-broadcast")],
                ["hil_requested", "hil_resolved"],
            )

        asyncio.run(scenario())

    def test_browser_requested_broadcast_failure_cleans_waiter_when_resolution_fails(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-request-cleanup", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            def broadcast(_record):
                raise RuntimeError("subscriber failure")

            interactions = SessionInteractions(
                "browser-request-cleanup",
                catalog,
                publish,
                events=events,
                broadcast=broadcast,
            )
            with patch.object(
                interactions, "_resolve_browser", side_effect=RuntimeError("database failure")
            ):
                with self.assertRaisesRegex(RuntimeError, "database failure"):
                    await interactions.request_browser_approval(
                        request_id="cleanup-request",
                        turn_id="turn-browser",
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id="thread-browser",
                        tab_id="tab-browser",
                        target_instance_id="instance-browser",
                        target_generation=3,
                        origin="https://example.com",
                        action="read",
                        intent="Read page",
                        expires_at=TEST_DEADLINE,
                    )
            self.assertNotIn("cleanup-request", interactions._browser_waiters)

        asyncio.run(scenario())

    def test_browser_resolved_broadcast_failure_keeps_committed_approval_result(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-resolved-broadcast", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            def broadcast(record):
                if record.kind == "hil_resolved":
                    raise RuntimeError("subscriber failure")

            interactions = SessionInteractions(
                "browser-resolved-broadcast", catalog, publish, events=events, broadcast=broadcast
            )
            waiting = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="resolved-broadcast",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="read",
                    intent="Read page",
                    expires_at=TEST_DEADLINE,
                )
            )
            await asyncio.sleep(0)
            resolved = await interactions.resolve(
                None,
                "resolved-broadcast",
                {"decision": "allow_once"},
                active_turn_id="turn-browser",
            )
            self.assertEqual(require_present(resolved)["decision"], "allow_once")
            self.assertEqual((await waiting)["decision"], "allow_once")
            self.assertEqual(catalog.pending_hil("browser-resolved-broadcast"), ())
            self.assertEqual(
                [record.kind for record in events.replay("browser-resolved-broadcast")],
                ["hil_requested", "hil_resolved"],
            )

        asyncio.run(scenario())

    def test_browser_approval_expiry_is_rechecked_after_lock_wait(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-lock-expiry", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-lock-expiry",
                catalog,
                publish,
                events=events,
                broadcast=lambda _record: None,
            )
            waiting = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="lock-expiry",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="read",
                    intent="Read page",
                    expires_at=time.time() + 0.1,
                )
            )
            await asyncio.sleep(0)
            async with interactions._lock:
                resolving = asyncio.create_task(
                    interactions.resolve(
                        None,
                        "lock-expiry",
                        {"decision": "allow_once"},
                        active_turn_id="turn-browser",
                    )
                )
                await asyncio.sleep(0.15)
            await resolving
            self.assertEqual((await waiting)["decision"], "deny")
            self.assertEqual(
                require_present(catalog.hil("lock-expiry").decision)["reason"], "expired"
            )

        asyncio.run(scenario())

    def test_browser_approval_expiry_is_rechecked_after_sqlite_write_lock(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-sqlite-expiry", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-sqlite-expiry",
                catalog,
                publish,
                events=events,
                broadcast=lambda _record: None,
            )
            waiting = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="sqlite-expiry",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="read",
                    intent="Read page",
                    expires_at=time.time() + 0.1,
                )
            )
            await asyncio.sleep(0)
            blocker = sqlite3.connect(self.database, check_same_thread=False)
            blocker.execute("BEGIN IMMEDIATE")

            def release() -> None:
                time.sleep(0.15)
                blocker.rollback()
                blocker.close()

            release_thread = Thread(target=release)
            release_thread.start()
            try:
                resolved = await interactions.resolve(
                    None,
                    "sqlite-expiry",
                    {"decision": "allow_once"},
                    active_turn_id="turn-browser",
                )
            finally:
                release_thread.join()
            self.assertEqual(require_present(resolved)["decision"], "deny")
            self.assertEqual((await waiting)["decision"], "deny")
            self.assertEqual(
                require_present(catalog.hil("sqlite-expiry").decision)["reason"], "expired"
            )

        asyncio.run(scenario())

    def test_browser_approval_event_failure_rolls_back_hil(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-rollback", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-rollback", catalog, publish, events=events, broadcast=lambda _record: None
            )
            with patch.object(events, "append", side_effect=RuntimeError("event write failed")):
                with self.assertRaisesRegex(RuntimeError, "event write failed"):
                    await interactions.request_browser_approval(
                        request_id="browser-failed",
                        turn_id="turn-browser",
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id="thread-browser",
                        tab_id="tab-browser",
                        target_instance_id="instance-browser",
                        target_generation=3,
                        origin="https://example.com",
                        action="read",
                        intent="Read page",
                        expires_at=TEST_DEADLINE,
                    )
            self.assertEqual(catalog.pending_hil("browser-rollback"), ())
            self.assertEqual(events.replay("browser-rollback"), ())

        asyncio.run(scenario())

    def test_browser_approval_cancel_cannot_authorize(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-cancel", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-cancel", catalog, publish, events=events, broadcast=lambda _record: None
            )
            pending = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="browser-cancelled",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="interact",
                    intent="Click element",
                    expires_at=TEST_DEADLINE,
                )
            )
            await asyncio.sleep(0)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertEqual(
                require_present(catalog.hil("browser-cancelled").decision)["decision"], "deny"
            )
            self.assertEqual(catalog.pending_hil("browser-cancel"), ())
            self.assertEqual(len(events.replay("browser-cancel")), 2)

        asyncio.run(scenario())

    def test_browser_approval_timeout_and_turn_change_fail_closed(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-expiry", "thread-browser")
            events = ProductEventStore(self.database)
            broadcast = []

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-expiry", catalog, publish, events=events, broadcast=broadcast.append
            )
            pending = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="browser-expiring",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="submit",
                    proof_id="submit-proof",
                    prepared_id="prepared-submit",
                    snapshot_id="snapshot-submit",
                    element_ref="element-submit",
                    browser_action="submit",
                    element={"role": "button", "name": "Send"},
                    intent="Submit form",
                    expires_at=time.time() + 0.1,
                )
            )
            await asyncio.sleep(0)
            self.assertIsNone(
                await interactions.resolve(
                    None,
                    "browser-expiring",
                    {"decision": "allow_once"},
                    active_turn_id="replaced-turn",
                )
            )
            self.assertEqual((await pending)["decision"], "deny")
            self.assertEqual(
                require_present(catalog.hil("browser-expiring").decision)["reason"], "turn_inactive"
            )
            expired = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="browser-timeout",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="read",
                    intent="Read page",
                    expires_at=time.time() + 0.05,
                )
            )
            self.assertEqual((await expired)["decision"], "deny")
            self.assertEqual(
                require_present(catalog.hil("browser-timeout").decision)["reason"], "expired"
            )
            self.assertEqual(catalog.pending_hil("browser-expiry"), ())
            self.assertEqual(len(events.replay("browser-expiry")), 4)

        asyncio.run(scenario())

    def test_browser_approval_is_structured_atomic_and_once_only(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-approval", "thread-browser")
            events = ProductEventStore(self.database)
            broadcast = []

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must not use non-atomic generic publication")

            interactions = SessionInteractions(
                "browser-approval", catalog, publish, events=events, broadcast=broadcast.append
            )
            pending = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="browser-request",
                    proof_id="main-proof",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://destination.example",
                    action="navigate",
                    source_origin=None,
                    destination_url="https://destination.example/path?q=1#section",
                    destination_origin="https://destination.example",
                    intent="Open public page",
                    expires_at=TEST_DEADLINE,
                    scope={
                        "session_id": "browser-approval",
                        "instance_id": "scope-instance",
                        "product_turn_id": "product-turn",
                        "turn_id": "turn-browser",
                        "generation": 4,
                        "interrupt_generation": 1,
                        "lifecycle_epoch": 2,
                    },
                )
            )
            await asyncio.sleep(0)
            self.assertEqual(len(catalog.pending_hil("browser-approval")), 1)
            self.assertEqual([record.kind for record in broadcast], ["hil_requested"])
            requested = broadcast[0].payload
            self.assertEqual(requested["origin"], "https://destination.example")
            self.assertIsNone(requested["source_origin"])
            self.assertEqual(
                requested["destination_url"], "https://destination.example/path?q=1#section"
            )
            self.assertEqual(requested["destination_origin"], "https://destination.example")
            self.assertEqual(requested["target_instance_id"], "instance-browser")
            self.assertEqual(requested["target_generation"], 3)
            self.assertIsNone(
                await interactions.resolve(
                    None,
                    "browser-request",
                    {"answers": {"browser-request": "允许"}},
                    active_turn_id="turn-browser",
                )
            )
            self.assertEqual(len(catalog.pending_hil("browser-approval")), 1)
            resolved = await interactions.resolve(
                None,
                "browser-request",
                {"decision": "deny"},
                active_turn_id="turn-browser",
            )
            self.assertEqual(require_present(resolved)["decision"], "deny")
            for field in (
                "origin",
                "source_origin",
                "destination_url",
                "destination_origin",
                "target_instance_id",
                "target_generation",
                "proof_id",
            ):
                self.assertEqual(require_present(resolved)[field], requested[field])
            self.assertEqual(require_present(resolved)["proof_id"], "main-proof")
            self.assertEqual(require_present(resolved)["instance_id"], "scope-instance")
            self.assertEqual(require_present(resolved)["product_turn_id"], "product-turn")
            self.assertEqual(require_present(resolved)["generation"], 4)
            self.assertEqual(require_present(resolved)["interrupt_generation"], 1)
            self.assertEqual(require_present(resolved)["lifecycle_epoch"], 2)
            self.assertEqual((await pending)["decision"], "deny")
            self.assertIsNone(
                await interactions.resolve(
                    None,
                    "browser-request",
                    {"decision": "allow_once"},
                    active_turn_id="turn-browser",
                )
            )
            self.assertEqual(
                [record.kind for record in broadcast], ["hil_requested", "hil_resolved"]
            )
            self.assertEqual(
                [record.kind for record in events.replay("browser-approval")],
                ["hil_requested", "hil_resolved"],
            )

        asyncio.run(scenario())

    def test_browser_navigate_approval_rejects_missing_or_mismatched_destination(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-invalid-navigate", "thread-browser")
            events = ProductEventStore(self.database)

            async def publish(*_args, **_kwargs):
                self.fail("invalid browser approval must not publish")

            interactions = SessionInteractions(
                "browser-invalid-navigate",
                catalog,
                publish,
                events=events,
                broadcast=lambda _record: self.fail("invalid browser approval must not broadcast"),
            )
            valid = {
                "request_id": "navigate-request",
                "proof_id": "main-proof",
                "turn_id": "turn-browser",
                "runtime_id": RUNTIME_ID,
                "vendor_thread_id": "thread-browser",
                "tab_id": "tab-browser",
                "target_instance_id": "instance-browser",
                "target_generation": 3,
                "origin": "https://destination.example",
                "action": "navigate",
                "source_origin": "https://source.example",
                "destination_url": "https://destination.example/path",
                "destination_origin": "https://destination.example",
                "intent": "Open public page",
                "expires_at": TEST_DEADLINE,
            }
            invalids = (
                {"destination_url": None},
                {"destination_origin": None},
                {"destination_origin": "https://other.example"},
                {"origin": "https://source.example"},
                {"source_origin": "about:blank"},
                {"source_origin": "https://source.example/path"},
                {"destination_url": "HTTPS://destination.example/path"},
                {"destination_url": "https://destination.example:443/path"},
                {"destination_url": "https://destination.example/a/../path"},
                {"destination_url": "https://user@destination.example/path"},
                {"destination_url": "javascript:alert(1)"},
            )
            for changed in invalids:
                with self.subTest(changed=changed), self.assertRaises(ValueError):
                    await interactions.request_browser_approval(**{**valid, **changed})
            self.assertEqual(catalog.pending_hil("browser-invalid-navigate"), ())
            self.assertEqual(events.replay("browser-invalid-navigate"), ())

        asyncio.run(scenario())

    def test_browser_fill_approval_records_proof_and_element_without_value(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            register_session(catalog, "browser-fill-approval", "thread-browser")
            events = ProductEventStore(self.database)
            broadcast = []

            async def publish(*_args, **_kwargs):
                self.fail("browser approval must use atomic event publication")

            interactions = SessionInteractions(
                "browser-fill-approval",
                catalog,
                publish,
                events=events,
                broadcast=broadcast.append,
            )
            pending = asyncio.create_task(
                interactions.request_browser_approval(
                    request_id="fill-request",
                    proof_id="proof-fill",
                    turn_id="turn-browser",
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id="thread-browser",
                    tab_id="tab-browser",
                    target_instance_id="instance-browser",
                    target_generation=3,
                    origin="https://example.com",
                    action="fill",
                    intent="Fill the selected search field",
                    expires_at=TEST_DEADLINE,
                    prepared_id="prepared-fill",
                    snapshot_id="snapshot-fill",
                    element_ref="element-fill",
                    browser_action="fill",
                    element={"role": "textbox", "name": "Search"},
                )
            )
            await asyncio.sleep(0)
            requested = broadcast[0].payload
            self.assertEqual(requested["browser_action"], "fill")
            self.assertEqual(requested["prepared_id"], "prepared-fill")
            self.assertEqual(requested["snapshot_id"], "snapshot-fill")
            self.assertEqual(requested["element_ref"], "element-fill")
            self.assertEqual(requested["element"], {"role": "textbox", "name": "Search"})
            self.assertNotIn("value", requested)
            await interactions.resolve(
                None,
                "fill-request",
                {"decision": "deny"},
                active_turn_id="turn-browser",
            )
            self.assertEqual((await pending)["decision"], "deny")

        asyncio.run(scenario())

    def test_nonblocking_product_card_survives_turn_and_resolves_without_waiter(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "independent-card")
            events = []

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                events.append((kind, data))
                return published_event(kind, data)

            interactions = SessionInteractions("independent-card", catalog, publish)
            question = {"id": "package-v1", "question": "Install version one"}
            await interactions.publish_product_input(question, turn_id="turn-1")
            self.assertFalse(catalog.hil("package-v1").payload["blocking"])
            self.assertNotEqual(catalog.get("independent-card").status, SessionStatus.WAITING_HIL)
            self.assertIsNone(interactions.product_activity("package-v1"))
            self.assertEqual(catalog.pending_hil("independent-card"), ())
            self.assertEqual(len(catalog.pending_hil("independent-card", blocking_only=False)), 1)
            self.assertEqual(catalog.expire_pending_hil("independent-card"), ())
            await interactions.cancel_product_requests()
            self.assertEqual(catalog.hil("package-v1").status, HilStatus.PENDING)
            catalog.update_status(
                "independent-card",
                SessionStatus.COMPLETED,
                turn_id="turn-2",
                turn_status="completed",
            )
            restored = SessionInteractions("independent-card", catalog, publish)
            result = await restored.resolve(
                None, "package-v1", {"answers": {"package-v1": "receipt"}}, active_turn_id="turn-2"
            )
            self.assertEqual(result["state"], "resolved")
            self.assertEqual(catalog.get("independent-card").status, SessionStatus.COMPLETED)
            self.assertEqual(catalog.hil("package-v1").payload["questions"], [question])
            self.assertEqual(len(events), 2)

        asyncio.run(scenario())

    def test_late_product_question_preserves_terminal_status(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "late-question")
            catalog.update_status(
                "late-question", SessionStatus.COMPLETED, turn_id="turn-1", turn_status="completed"
            )

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                return published_event(kind, data)

            interactions = SessionInteractions("late-question", catalog, publish)
            waiting = asyncio.create_task(
                interactions.request_product_input({"id": "late"}, turn_id="turn-1")
            )
            await asyncio.sleep(0)
            self.assertEqual(
                require_present(catalog.get("late-question")).last_turn_status, "completed"
            )
            await interactions.resolve(
                None, "late", {"answers": {"late": "一键授权"}}, active_turn_id="turn-1"
            )
            await waiting
            self.assertEqual(
                require_present(catalog.get("late-question")).status, SessionStatus.COMPLETED
            )

        asyncio.run(scenario())

    def test_product_answer_does_not_resurrect_completed_turn(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "completed-question")
            events = []

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                events.append((kind, data))
                return published_event(kind, data)

            interactions = SessionInteractions("completed-question", catalog, publish)
            waiting = asyncio.create_task(
                interactions.request_product_input({"id": "authorization"}, turn_id="turn-1")
            )
            await asyncio.sleep(0)
            catalog.update_status(
                "completed-question",
                SessionStatus.COMPLETED,
                turn_id="turn-1",
                turn_status="completed",
            )
            await interactions.resolve(
                None, "authorization", {"answers": {"authorization": "拒绝"}}
            )
            await waiting
            self.assertEqual(
                require_present(catalog.get("completed-question")).status, SessionStatus.COMPLETED
            )
            self.assertEqual(events[0][1]["lifetime"], "session")
            self.assertIsNone(await interactions.resolve(None, "authorization", {}))

        asyncio.run(scenario())

    def test_product_owned_question_resolves_without_runtime_delivery(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "product-question")
            events = []

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                events.append((kind, data, kwargs))
                return published_event(kind, data)

            interactions = SessionInteractions("product-question", catalog, publish)
            question = {
                "id": "literature-review-fulltext:opaque",
                "header": "综述检索授权",
                "question": "是否允许读取全文？",
                "options": [{"label": "一键授权 (Recommended)"}, {"label": "拒绝"}],
            }
            waiting = asyncio.create_task(
                interactions.request_product_input(question, turn_id="turn-1")
            )
            await asyncio.sleep(0)
            resolved = await interactions.resolve(
                None,
                question["id"],
                {"answers": {question["id"]: "一键授权"}},
            )
            self.assertIsNotNone(resolved)
            self.assertEqual(await waiting, {"answers": {question["id"]: "一键授权"}})
            self.assertEqual(catalog.hil(question["id"]).status, HilStatus.RESOLVED)
            self.assertEqual([event[0] for event in events], ["hil_requested", "hil_resolved"])

        asyncio.run(scenario())

    def test_product_question_timeout_is_durable_and_not_a_user_answer(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "timed-question")
            events = []

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                events.append((kind, data))
                return published_event(kind, data)

            interactions = SessionInteractions("timed-question", catalog, publish)
            question = {"id": "timed", "question": "Continue?"}
            decision = await interactions.request_product_input(
                question, turn_id="turn-1", timeout_seconds=0.01
            )
            self.assertTrue(decision["timed_out"])
            self.assertNotIn("answers", decision)
            self.assertEqual(catalog.hil("timed").decision, decision)
            self.assertEqual(
                await interactions.request_product_input(
                    question, turn_id="turn-1", timeout_seconds=0.01
                ),
                decision,
            )
            self.assertEqual([event[0] for event in events], ["hil_requested", "hil_resolved"])

        asyncio.run(scenario())

    def test_product_question_answer_wins_and_duplicate_waits_share_result(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "shared-question")

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                return published_event(kind, data)

            interactions = SessionInteractions("shared-question", catalog, publish)
            question = {"id": "shared", "question": "Continue?"}
            activities = Activities()
            owner = activities.enter(ActivityDomain.BRIDGE)
            duplicate = activities.enter(ActivityDomain.BRIDGE)
            pending = [
                asyncio.create_task(
                    interactions.request_product_input(
                        question, turn_id="turn-1", timeout_seconds=1, activity=activity
                    )
                )
                for activity in (owner, duplicate)
            ]
            await asyncio.sleep(0)
            activities.begin()
            self.assertIs(interactions.product_activity("shared"), owner)
            with activities.continue_from(
                interactions.product_activity("shared"), ActivityDomain.BRIDGE
            ):
                self.assertEqual(activities.snapshot().counts["bridge"], 3)
            answer = {"answers": {"shared": "Please modify the outline"}}
            await interactions.resolve(None, "shared", answer, active_turn_id="turn-1")
            decisions = await asyncio.gather(*pending)
            self.assertEqual(decisions, [answer, answer])
            self.assertIsNone(interactions.product_activity("shared"))
            owner.close()
            duplicate.close()
            self.assertEqual(activities.snapshot().counts, {})
            self.assertIsNone(await interactions.resolve(None, "shared", answer))

        asyncio.run(scenario())

    def test_product_question_stale_and_cancelled_never_timeout_to_approval(self) -> None:
        async def scenario() -> None:
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "stale-question")

            async def publish(kind: str, data: Mapping[str, Any], **kwargs) -> ProductEventRecord:
                return published_event(kind, data)

            interactions = SessionInteractions("stale-question", catalog, publish)
            question = {"id": "stale", "question": "Continue?"}
            waiting = asyncio.create_task(
                interactions.request_product_input(question, turn_id="turn-1", timeout_seconds=0.01)
            )
            await asyncio.sleep(0)
            catalog.stale_hil("stale")
            self.assertTrue((await waiting)["cancelled"])
            self.assertTrue(
                (
                    await interactions.request_product_input(
                        question, turn_id="turn-1", timeout_seconds=0.01
                    )
                )["cancelled"]
            )
            waiting = asyncio.create_task(
                interactions.request_product_input(
                    {"id": "cancel", "question": "Continue?"}, turn_id="turn-1"
                )
            )
            await asyncio.sleep(0)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            self.assertTrue(require_present(catalog.hil("cancel").decision)["cancelled"])
            self.assertEqual(interactions._product_waiters, {})

        asyncio.run(scenario())

    def test_default_title_provenance_is_explicit_durable_and_cleared_atomically(self) -> None:
        catalog = SessionCatalogStore(self.database)
        values = TitleAllocation(
            runtime_id=RUNTIME_ID,
            runtime_workdir="/research/title-source",
            project_path=None,
            output_root="/research/title-source/outputs",
            title=SESSION_TITLE_DEFAULT,
        )
        original = catalog.allocate(
            "generated", OWNER, **values, title_fallback=SessionTitleFallback.NEW_SESSION
        )
        self.assertEqual(catalog.allocate("generated", OWNER, **values), original)
        self.assertEqual(
            require_present(SessionCatalogStore(self.database).get("generated")).title_fallback,
            SessionTitleFallback.NEW_SESSION,
        )
        untouched = catalog.adopt_generated_title(
            "generated", "ignored", replaceable_titles=("different",)
        )
        self.assertEqual(untouched, original)
        adopted = catalog.adopt_generated_title(
            "generated", "First message", replaceable_titles=(SESSION_TITLE_DEFAULT,)
        )
        self.assertEqual(adopted.title, "First message")
        self.assertIsNone(adopted.title_fallback)
        same_name = catalog.allocate("user", OWNER, **values)
        self.assertIsNone(same_name.title_fallback)
        catalog.allocate(
            "renamed", OWNER, **values, title_fallback=SessionTitleFallback.NEW_SESSION
        )
        renamed = catalog.rename("renamed", OWNER, SESSION_TITLE_DEFAULT)
        self.assertEqual(renamed.title, SESSION_TITLE_DEFAULT)
        self.assertIsNone(renamed.title_fallback)
        protected = catalog.adopt_generated_title(
            "renamed", "Generated task", replaceable_titles=(SESSION_TITLE_DEFAULT,)
        )
        self.assertEqual(protected, renamed)
        legacy = catalog.adopt_generated_title(
            "user", "Generated task", replaceable_titles=(SESSION_TITLE_DEFAULT,)
        )
        self.assertEqual(legacy, same_name)

    def test_old_title_column_upgrades_without_guessing_same_name_or_unknown_sources(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "legacy-empty")
        allocate_session(catalog, "legacy-same-name")
        catalog.rename("legacy-same-name", OWNER, SESSION_TITLE_DEFAULT)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {SESSION_CATALOG_TABLE} DROP COLUMN title_fallback")
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET output_root = '', updated_at = 0"
            )
        upgraded = SessionCatalogStore(self.database)
        self.assertEqual(require_present(upgraded.get("legacy-empty")).title, "")
        self.assertEqual(
            require_present(upgraded.get("legacy-same-name")).title, SESSION_TITLE_DEFAULT
        )
        self.assertIsNone(require_present(upgraded.get("legacy-empty")).title_fallback)
        self.assertIsNone(require_present(upgraded.get("legacy-same-name")).title_fallback)
        self.assertEqual(require_present(upgraded.get("legacy-empty")).output_root, "")
        self.assertEqual(require_present(upgraded.get("legacy-empty")).updated_at, 0)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_CATALOG_TABLE} SET title_fallback = 'future-title'"
            )
        self.assertIsNone(require_present(upgraded.get("legacy-same-name")).title_fallback)

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="session-catalog-")
        self.database = Path(self._temporary.name) / "sessions.sqlite3"

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def test_runtime_binding_is_committed_with_the_product_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        binding = RuntimeBinding(
            product_session_id="product-bound",
            runtime_id=RUNTIME_ID,
            adapter_version="0.2.0",
            runtime_version="0.147.0",
            protocol_version="2",
            protocol_schema_hash="a" * 64,
            opaque_session_ref="thread-bound",
            capabilities=CapabilitySet(
                (RuntimeCapability("interrupt", CapabilityState.SUPPORTED),)
            ),
            profile="official",
        )
        catalog.register(
            "product-bound",
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id="thread-bound",
            vendor_session_id=None,
            runtime_workdir="/research/product-bound",
            project_path="/research",
            output_root="/research/product-bound/outputs",
            codex_version="0.147.0",
            model_id="gpt-5-codex",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="绑定会话",
            created_at=20.0,
            runtime_binding=binding,
        )

        self.assertEqual(catalog.runtime_binding("product-bound"), binding)

    def test_optional_capability_intent_round_trips_without_schema_migration(self) -> None:
        binding = dataclasses.replace(
            native_binding("optional-session", "optional-thread"),
            optional_capabilities=(RuntimeCapabilityName.WEB_SEARCH,),
        )
        catalog = SessionCatalogStore(self.database)
        catalog.register(
            "optional-session",
            OWNER,
            runtime_id=RUNTIME_ID,
            vendor_thread_id="optional-thread",
            vendor_session_id=None,
            runtime_workdir="/research/optional",
            project_path="/research",
            output_root="/research/optional/outputs",
            codex_version="fixture",
            model_id="fixture",
            policy_id="workspace-write",
            status=SessionStatus.READY,
            title="Optional",
            created_at=20.0,
            runtime_binding=binding,
        )
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.runtime_binding("optional-session"), binding)

    def test_denied_skills_binding_survives_reopen_and_refuses_downgrade(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(
            catalog,
            "denied-session",
            "original-thread",
            runtime_binding=native_binding("denied-session", "original-thread"),
        )
        original = require_present(catalog.runtime_binding("denied-session"))
        denied = dataclasses.replace(
            original, opaque_session_ref="denied-thread", skill_policy=SkillPolicy.DENY
        )
        catalog.replace_runtime_binding(original, denied)
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.runtime_binding("denied-session"), denied)
        with self.assertRaises(SessionBindingConflictError):
            reopened.replace_runtime_binding(
                denied,
                dataclasses.replace(
                    denied, opaque_session_ref="relaxed-thread", skill_policy=SkillPolicy.INHERIT
                ),
            )
        self.assertEqual(reopened.runtime_binding("denied-session"), denied)

    def test_obsolete_work_schema_is_extended_without_rebuilding_rows(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute("""
                CREATE TABLE session_access (
                    session_id TEXT PRIMARY KEY,
                    principal_id TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    work TEXT NOT NULL DEFAULT '',
                    runtime_workdir TEXT NOT NULL DEFAULT '',
                    project_path TEXT,
                    assignment_known INTEGER NOT NULL DEFAULT 0,
                    todos TEXT NOT NULL DEFAULT ''
                )
                """)
            connection.execute(
                "INSERT INTO session_access VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "legacy",
                    OWNER.user_id,
                    10.0,
                    "scholar",
                    "/legacy/workdir",
                    None,
                    1,
                    '[{"content":"旧待办"}]',
                ),
            )

        catalog = SessionCatalogStore(self.database)
        legacy = catalog.get("legacy")

        self.assertIsNotNone(legacy)
        assert legacy is not None
        self.assertEqual(legacy.runtime_id, LEGACY_RUNTIME_ID)
        self.assertEqual(legacy.status, SessionStatus.LEGACY_READONLY)
        self.assertIsNone(legacy.vendor_thread_id)
        self.assertEqual(legacy.todos, ({"content": "旧待办"},))
        with closing(sqlite3.connect(self.database)) as connection, connection:
            columns = {
                str(row[1])
                for row in connection.execute(
                    f"PRAGMA table_info({SESSION_CATALOG_TABLE})"
                ).fetchall()
            }
        self.assertTrue(set(CATALOG_COLUMNS).issubset(columns))
        self.assertIn("work", columns)
        self.assertIn("assignment_known", columns)

    def test_binding_is_immutable_and_vendor_thread_is_unique(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        original = catalog.get("product-a")

        register_session(catalog, "product-a", "thread-a")
        self.assertEqual(catalog.get("product-a"), original)

        with self.assertRaises(SessionBindingConflictError):
            register_session(catalog, "product-b", "thread-a")
        with self.assertRaises(SessionBindingConflictError):
            catalog.register(
                "product-a",
                OWNER,
                runtime_id=RUNTIME_ID,
                vendor_thread_id="thread-b",
                vendor_session_id=None,
                runtime_workdir="/other",
                project_path=None,
                output_root="/other/outputs",
                codex_version=None,
                model_id=None,
                policy_id=None,
                status=SessionStatus.READY,
                title="",
                created_at=99.0,
            )

    def test_status_title_and_full_plan_survive_reopen(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.update_status(
            "product-a",
            SessionStatus.RUNNING,
            turn_id="turn-1",
            turn_status="in_progress",
            updated_at=30.0,
        )
        catalog.rename("product-a", OWNER, "材料疲劳研究", updated_at=31.0)
        first_plan = [{"step": "检索文献", "status": "completed"}]
        second_plan = [{"step": "运行实验", "status": "in_progress"}]
        catalog.save_todos(
            "product-a",
            first_plan,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation="initial",
        )
        catalog.save_todos(
            "product-a",
            second_plan,
            vendor_turn_id="turn-1",
            product_seq=2,
            explanation="replanned",
        )
        stale = catalog.save_todos(
            "product-a",
            first_plan,
            vendor_turn_id="turn-1",
            product_seq=1,
            explanation="initial",
        )

        self.assertEqual(stale, tuple(second_plan))
        reopened = SessionCatalogStore(self.database).get("product-a")
        self.assertIsNotNone(reopened)
        assert reopened is not None
        self.assertEqual(reopened.title, "材料疲劳研究")
        self.assertEqual(reopened.status, SessionStatus.RUNNING)
        self.assertEqual(reopened.last_turn_id, "turn-1")
        self.assertEqual(reopened.todos, tuple(second_plan))
        self.assertEqual(reopened.todo_product_seq, 2)
        self.assertEqual(reopened.todo_explanation, "replanned")

        with self.assertRaises(SessionStateConflictError):
            catalog.save_todos(
                "product-a",
                first_plan,
                vendor_turn_id="turn-1",
                product_seq=2,
                explanation="conflict",
            )

    def test_permission_policy_can_be_updated_for_existing_session(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")

        updated = catalog.set_policy("product-a", OWNER, "safe_auto", updated_at=40.0)

        self.assertEqual(updated.policy_id, "safe_auto")
        self.assertEqual(updated.updated_at, 40.0)
        reopened = SessionCatalogStore(self.database).get("product-a")
        self.assertIsNotNone(reopened)
        assert reopened is not None
        self.assertEqual(reopened.policy_id, "safe_auto")

    def test_hil_mapping_is_durable_and_consumed_once(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        payload = {"command": "python experiment.py", "choices": ["accept", "decline"]}
        first = catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id="turn-1",
            vendor_item_id="item-2",
            method="item/commandExecution/requestApproval",
            payload=payload,
            created_at=40.0,
        )
        repeated = catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id="turn-1",
            vendor_item_id="item-2",
            method="item/commandExecution/requestApproval",
            payload=payload,
            created_at=40.0,
        )

        self.assertEqual(first, repeated)
        self.assertEqual(SessionCatalogStore(self.database).pending_hil("product-a"), (first,))
        self.assertEqual(catalog.pending_hil_for_principal(OWNER), (first,))
        self.assertEqual(catalog.pending_hil_for_principal(OTHER_OWNER), ())
        decision = {"decision": "accept"}
        self.assertTrue(catalog.resolve_hil("hil-product-1", decision, resolved_at=41.0))
        self.assertFalse(catalog.resolve_hil("hil-product-1", decision, resolved_at=42.0))
        resolved = catalog.hil("hil-product-1")
        self.assertEqual(resolved.status, HilStatus.RESOLVED)
        self.assertEqual(resolved.decision, decision)
        self.assertEqual(catalog.acknowledge_hil("hil-product-1").decision, decision)
        self.assertEqual(catalog.pending_hil("product-a"), ())

    def test_fulltext_authorization_is_exact_turn_scope_and_fail_closed(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        first = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:b", "literature:a", "literature:a"),
        )
        self.assertEqual(first.refs, ("literature:a", "literature:b"))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        reopened = FulltextAuthorizer(self.database, SessionCatalogStore(self.database))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            reopened.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        catalog.record_hil(
            product_request_id="hil-product-idea",
            session_id="product-a",
            vendor_request_id="rpc-idea",
            vendor_turn_id="turn-1",
            vendor_item_id="item-idea",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": first.question_id}]},
        )
        catalog.resolve_hil(
            "hil-product-idea",
            {"answers": {first.question_id: "一键授权"}},
        )
        authorizer.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            ref_id="literature:a",
        )
        reopened.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            ref_id="literature:a",
        )
        for snapshot_id, turn_id, ref_id in (
            ("snapshot-1", "turn-1", "literature:c"),
            ("snapshot-2", "turn-1", "literature:a"),
            ("snapshot-1", "turn-2", "literature:a"),
        ):
            with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
                authorizer.require(
                    session_id="product-a",
                    snapshot_id=snapshot_id,
                    turn_id=turn_id,
                    authorization_type=RESEARCH_IDEA_FULLTEXT,
                    ref_id=ref_id,
                )

    def test_fulltext_authorization_policies_are_typed_and_isolated(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        cases = (
            (RESEARCH_IDEA_FULLTEXT, RESEARCH_IDEA_AUTHORIZATION_HEADER),
            (PRECISE_SEARCH_FULLTEXT, PRECISE_SEARCH_AUTHORIZATION_HEADER),
            (LITERATURE_REVIEW_FULLTEXT, LITERATURE_REVIEW_AUTHORIZATION_HEADER),
        )
        records = {}
        for authorization_type, header in cases:
            record = authorizer.prepare(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=authorization_type,
                refs=("literature:a",),
            )
            records[authorization_type] = record
            question = authorization_question(record)
            self.assertEqual(question["header"], header)
            options = question["options"]
            assert isinstance(options, list)
            assert all(isinstance(option, dict) for option in options)
            self.assertEqual(
                [option["label"] for option in options],
                ["一键授权 (Recommended)", "拒绝"],
            )

        granted = records[PRECISE_SEARCH_FULLTEXT]
        catalog.record_hil(
            product_request_id="hil-precise",
            session_id="product-a",
            vendor_request_id="rpc-precise",
            vendor_turn_id="turn-1",
            vendor_item_id="item-precise",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": granted.question_id}]},
        )
        catalog.resolve_hil(
            "hil-precise",
            {"answers": {granted.question_id: "一键授权"}},
        )
        authorizer.require(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=PRECISE_SEARCH_FULLTEXT,
            ref_id="literature:a",
        )
        for authorization_type in (RESEARCH_IDEA_FULLTEXT, LITERATURE_REVIEW_FULLTEXT):
            with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
                authorizer.require(
                    session_id="product-a",
                    snapshot_id="snapshot-1",
                    turn_id="turn-1",
                    authorization_type=authorization_type,
                    ref_id="literature:a",
                )

    def test_denied_or_superseded_fulltext_authorization_never_grants(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        authorizer = FulltextAuthorizer(self.database, catalog)
        denied = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:a",),
        )
        catalog.record_hil(
            product_request_id="hil-denied",
            session_id="product-a",
            vendor_request_id="rpc-denied",
            vendor_turn_id="turn-1",
            vendor_item_id="item-denied",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": denied.question_id}]},
        )
        catalog.resolve_hil(
            "hil-denied",
            {"answers": {denied.question_id: {"answers": ["拒绝"]}}},
        )
        replacement = authorizer.prepare(
            session_id="product-a",
            snapshot_id="snapshot-1",
            turn_id="turn-1",
            authorization_type=RESEARCH_IDEA_FULLTEXT,
            refs=("literature:b",),
        )
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:a",
            )
        catalog.record_hil(
            product_request_id="hil-stale",
            session_id="product-a",
            vendor_request_id="rpc-stale",
            vendor_turn_id="turn-1",
            vendor_item_id="item-stale",
            method="item/tool/requestUserInput",
            payload={"questions": [{"id": replacement.question_id}]},
        )
        self.assertTrue(catalog.stale_hil("hil-stale"))
        with self.assertRaisesRegex(ValueError, AUTHORIZATION_REQUIRED):
            authorizer.require(
                session_id="product-a",
                snapshot_id="snapshot-1",
                turn_id="turn-1",
                authorization_type=RESEARCH_IDEA_FULLTEXT,
                ref_id="literature:b",
            )

    def test_release_is_owner_scoped_and_cascades_hil(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.record_hil(
            product_request_id="hil-product-1",
            session_id="product-a",
            vendor_request_id="rpc-7",
            vendor_turn_id=None,
            vendor_item_id=None,
            method="item/fileChange/requestApproval",
            payload={},
        )

        catalog.release("product-a", OTHER_OWNER)
        self.assertIsNotNone(catalog.get("product-a"))
        catalog.release("product-a", OWNER)
        self.assertIsNone(catalog.get("product-a"))
        self.assertEqual(catalog.pending_hil("product-a"), ())

    def test_message_queue_preserves_enqueue_and_operation_order(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        one = catalog.enqueue_message(
            "product-a",
            "queue-1",
            {"input": [{"type": "text", "text": "1"}]},
            submission_mode=SubmissionMode.DIRECT,
        )
        two = catalog.enqueue_message(
            "product-a", "queue-2", {"input": [{"type": "text", "text": "2"}]}
        )
        three = catalog.enqueue_message(
            "product-a", "queue-3", {"input": [{"type": "text", "text": "3"}]}
        )
        self.assertEqual((one.enqueue_seq, two.enqueue_seq, three.enqueue_seq), (1, 2, 3))
        self.assertEqual(one.submission_mode, SubmissionMode.DIRECT)
        self.assertEqual(two.submission_mode, SubmissionMode.QUEUED)

        third_submission = catalog.begin_queued_submission("product-a", "queue-3")
        first_submission = catalog.begin_queued_submission("product-a", "queue-1")
        self.assertIsNotNone(third_submission)
        self.assertIsNotNone(first_submission)
        self.assertEqual(
            (
                require_present(third_submission).operation_seq,
                require_present(first_submission).operation_seq,
            ),
            (1, 2),
        )
        self.assertEqual(
            require_present(catalog.queued_message("product-a", "queue-2")).state,
            QueuedMessageState.QUEUED,
        )
        self.assertTrue(catalog.remove_queued_message("product-a", "queue-3"))
        self.assertEqual(
            [
                record.queued_message_id
                for record in SessionCatalogStore(self.database).queued_messages("product-a")
            ],
            ["queue-1", "queue-2"],
        )

    def test_message_queue_never_resubmits_an_unknown_outcome(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.enqueue_message(
            "product-a", "queue-unknown", {"input": [{"type": "text", "text": "once"}]}
        )
        claimed = catalog.begin_queued_submission("product-a", "queue-unknown")
        self.assertIsNotNone(claimed)
        catalog.fail_queued_submission(
            "product-a",
            "queue-unknown",
            unknown=True,
            safe_error="delivery_unknown",
        )

        self.assertIsNone(catalog.begin_queued_submission("product-a", "queue-unknown"))
        retained = catalog.queued_message("product-a", "queue-unknown")
        self.assertIsNotNone(retained)
        assert retained is not None
        self.assertEqual(retained.state, QueuedMessageState.OUTCOME_UNKNOWN)
        self.assertEqual(retained.operation_seq, 1)

    def test_message_queue_reconcile_applied_removes_only_the_exact_operation(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        catalog.enqueue_message(
            "product-a", "queue-applied", {"input": [{"type": "text", "text": "once"}]}
        )
        claimed = catalog.begin_queued_submission("product-a", "queue-applied")
        assert claimed is not None and claimed.operation_seq is not None
        catalog.fail_queued_submission(
            "product-a",
            "queue-applied",
            unknown=True,
            safe_error="delivery_unknown",
        )

        removed = catalog.remove_reconciled_unknown_message(
            "product-a",
            "queue-applied",
            claimed.operation_seq,
        )

        self.assertTrue(removed)
        self.assertEqual(
            require_present(catalog.queued_message("product-a", "queue-applied")).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertEqual(catalog.queued_messages("product-a"), ())
        self.assertFalse(
            catalog.remove_reconciled_unknown_message(
                "product-a", "queue-applied", claimed.operation_seq
            )
        )

    def test_first_open_is_durable_and_only_one_attempt_can_claim_it(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        before = catalog.activation("product-new")
        self.assertEqual(require_present(before).open_state, OpenState.NEVER_STARTED)
        self.assertIsNone(require_present(catalog.get("product-new")).vendor_thread_id)
        self.assertIsNone(catalog.runtime_binding("product-new"))
        self.assertEqual(
            require_present(before).required_capabilities, (RuntimeCapabilityName.WEB_SEARCH,)
        )
        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = tuple(
                executor.map(
                    lambda attempt: catalog.begin_open("product-new", attempt),
                    ("attempt-a", "attempt-b"),
                )
            )
        winners = tuple(claim for claim in claims if claim is not None)
        self.assertEqual(len(winners), 1)
        winner = winners[0]
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.activation("product-new"), winner)
        self.assertIsNone(reopened.begin_open("product-new", winner.open_attempt_id))
        self.assertFalse(reopened.mark_open_unknown("product-new", "wrong-attempt"))

    def test_open_binding_and_generation_are_committed_atomically(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        catalog.begin_open("product-new", "attempt-a")
        binding = native_binding("product-new", "thread-new")
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open("product-new", "wrong-attempt", binding)
        self.assertIsNone(catalog.runtime_binding("product-new"))
        self.assertIsNone(require_present(catalog.get("product-new")).vendor_thread_id)
        self.assertEqual(catalog.begin_attachment("product-new"), 1)
        record = catalog.bind_open("product-new", "attempt-a", binding)
        self.assertEqual(record.vendor_thread_id, "thread-new")
        self.assertEqual(catalog.runtime_binding("product-new"), binding)
        self.assertEqual(
            require_present(catalog.activation("product-new")).open_state, OpenState.BOUND
        )
        self.assertEqual(catalog.bind_open("product-new", "attempt-a", binding), record)
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open("product-new", "attempt-a", native_binding("product-new", "other"))
        with ThreadPoolExecutor(max_workers=4) as executor:
            generations = tuple(
                executor.map(
                    lambda _: catalog.begin_attachment("product-new"), range(ATTACHMENT_COUNT)
                )
            )
        self.assertEqual(sorted(generations), list(range(2, ATTACHMENT_COUNT + 2)))
        self.assertEqual(
            require_present(
                SessionCatalogStore(self.database).activation("product-new")
            ).generation,
            ATTACHMENT_COUNT + 1,
        )

    def test_unsubmitted_binding_survives_restart_until_submission_is_claimed(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        catalog.begin_open("product-new", "attempt-a")
        binding = native_binding("product-new", "empty-thread")
        catalog.bind_open("product-new", "attempt-a", binding, unsubmitted=True)
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.activation("product-new").open_state.value, "unsubmitted")
        reopened.enqueue_message("product-new", "cancelled", {"input": []})
        self.assertTrue(reopened.delete_queued_message("product-new", "cancelled"))
        self.assertIsNone(reopened.begin_queued_submission("product-new", "cancelled"))
        self.assertEqual(reopened.activation("product-new").open_state.value, "unsubmitted")
        replacement = native_binding("product-new", "replacement-thread")
        reopened.replace_runtime_binding(binding, replacement)
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.runtime_binding("product-new"), replacement)
        self.assertEqual(reopened.activation("product-new").open_state.value, "unsubmitted")
        reopened.enqueue_message("product-new", "next", {"input": []})
        self.assertIsNotNone(reopened.begin_queued_submission("product-new", "next"))
        recovered = SessionCatalogStore(self.database)
        self.assertEqual(recovered.activation("product-new").open_state, OpenState.BOUND)
        self.assertEqual(recovered.runtime_binding("product-new"), replacement)

    def test_native_binding_conflict_rolls_back_all_open_state(self) -> None:
        catalog = SessionCatalogStore(self.database)
        for session_id in ("product-a", "product-b"):
            allocate_session(catalog, session_id)
            catalog.begin_open(session_id, session_id)
        catalog.bind_open("product-a", "product-a", native_binding("product-a", "shared-thread"))
        with self.assertRaises(SessionBindingConflictError):
            catalog.bind_open(
                "product-b", "product-b", native_binding("product-b", "shared-thread")
            )
        self.assertEqual(
            require_present(catalog.activation("product-b")).open_state, OpenState.OPENING
        )
        self.assertIsNone(require_present(catalog.get("product-b")).vendor_thread_id)
        self.assertIsNone(catalog.runtime_binding("product-b"))

    def test_unknown_open_requires_positive_evidence_before_binding(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        with self.assertRaises(SessionStateConflictError):
            catalog.begin_attachment("product-new")
        catalog.begin_open("product-new", "attempt-a")
        self.assertTrue(catalog.mark_open_unknown("product-new", "attempt-a"))
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(
            require_present(reopened.activation("product-new")).open_state, OpenState.OPEN_UNKNOWN
        )
        self.assertIsNone(reopened.begin_open("product-new", "attempt-b"))
        with self.assertRaises(SessionStateConflictError):
            reopened.begin_attachment("product-new")
        reopened.bind_open(
            "product-new",
            "attempt-a",
            native_binding("product-new", "known-thread"),
            unsubmitted=True,
        )
        self.assertEqual(
            require_present(reopened.activation("product-new")).open_state, OpenState.BOUND
        )

    def test_existing_bindings_seed_bound_but_missing_bindings_do_not_seed_new(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-old", "thread-old")
        self.assertEqual(
            require_present(catalog.activation("product-old")).open_state, OpenState.BOUND
        )
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"INSERT INTO {SESSION_CATALOG_TABLE} "
                "(session_id, principal_id, runtime_id, runtime_workdir, output_root, status, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                ("unbound-old", OWNER.user_id, RUNTIME_ID, "/old", "/old/out", "ready", 1.0, 1.0),
            )
        reopened = SessionCatalogStore(self.database)
        self.assertIsNone(reopened.activation("unbound-old"))
        self.assertIsNone(reopened.begin_open("unbound-old", "unsafe-retry"))

    def test_owned_connections_close_after_commit_and_rollback(self) -> None:
        real_connect = sqlite3.connect
        connections: list[sqlite3.Connection] = []

        def connect(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            connections.append(connection)
            return connection

        with patch("service.chat.persistence.catalog.sqlite3.connect", side_effect=connect):
            catalog = SessionCatalogStore(self.database)
            allocate_session(catalog, "connection-owner")
            catalog.get("connection-owner")
            catalog.activation("connection-owner")
            catalog.enqueue_message("connection-owner", "request", {"text": "hello"})
            with self.assertRaises(Exception):
                catalog.enqueue_message("connection-owner", "request", {"text": "changed"})
            catalog.recover_inflight()
        self.assertGreater(len(connections), 5)
        for connection in connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_private_recovery_materializes_persisted_negative_proof_from_qualified_database(
        self,
    ) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "proof-session", "proof-thread")
        catalog.enqueue_message("proof-session", "proof-command", {"text": "not sent"})
        catalog.begin_queued_submission("proof-session", "proof-command")
        catalog.record_turn_settlement(
            "proof-session",
            "proof-command",
            RuntimeEvent(
                schema_version=1,
                event_id="proof:event",
                runtime_id=RUNTIME_ID,
                product_session_id="proof-session",
                native_session_id="proof-thread",
                native_turn_id="proof-command",
                process_generation=1,
                sequence=1,
                kind=RuntimeEventKind.TURN_FAILED,
                delivery=DeliveryClass.MUST_PERSIST,
                observed_at="2026-10-29T00:00:00Z",
                correlation_id="proof-command",
                payload={
                    "safe_error": RUNTIME_TURN_NOT_SUBMITTED,
                    "error_code": RUNTIME_TURN_NOT_SUBMITTED,
                },
            ),
        )
        frozen = 1700000000.25
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            with projected:
                SessionCatalogStore.recover_inflight_rows(
                    projected, now=frozen, database=self.database
                )
            row = projected.execute(
                "SELECT state FROM session_message_queue WHERE queued_message_id = ?",
                ("proof-command",),
            ).fetchone()
            self.assertEqual(row["state"], QueuedMessageState.FAILED.value)
            self.assertEqual(
                require_present(catalog.queued_message("proof-session", "proof-command")).state,
                QueuedMessageState.SUBMITTING,
            )
            expected = tuple(projected.iterdump())
            catalog.recover_inflight(now=frozen)
            self.assertEqual(tuple(source.iterdump()), expected)

    def test_private_recovery_projection_matches_actual_startup_with_frozen_clock(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "projection-session")
        catalog.begin_open("projection-session", "opening")
        catalog.enqueue_message("projection-session", "submitted", {"text": "recover"})
        catalog.begin_queued_submission("projection-session", "submitted")
        frozen = 1700000000.25
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            with projected:
                SessionCatalogStore.initialize_schema(projected)
                self.assertEqual(
                    SessionCatalogStore.recover_inflight_rows(projected, now=frozen), (1, 1)
                )
            expected = tuple(projected.iterdump())
            self.assertEqual(
                require_present(catalog.activation("projection-session")).open_state,
                OpenState.OPENING,
            )
            with patch(
                "service.chat.persistence.catalog.time.time",
                side_effect=AssertionError("unfrozen recovery clock"),
            ):
                self.assertEqual(catalog.recover_inflight(now=frozen), (1, 1))
                self.assertEqual(catalog.recover_inflight(now=frozen), (0, 0))
            self.assertEqual(tuple(source.iterdump()), expected)

    def test_explicit_restart_recovery_pauses_waiting_and_preserves_completed_requests(
        self,
    ) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        catalog.begin_open("product-new", "attempt-a")
        for request_id in ("waiting", "submitted", "running", "completed"):
            catalog.enqueue_message("product-new", request_id, {"text": request_id})
            if request_id != "waiting":
                catalog.begin_queued_submission("product-new", request_id)
        catalog.begin_resource_wait(
            "product-new", "waiting", purpose="turn", deadline=TEST_DEADLINE
        )
        catalog.mark_queue_running("product-new", "running", "native-turn")
        catalog.complete_queued_message("product-new", "completed")
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(
            require_present(reopened.activation("product-new")).open_state, OpenState.OPENING
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "running")).state,
            QueuedMessageState.RUNNING,
        )
        self.assertEqual(reopened.recover_inflight(), (1, 2))
        self.assertEqual(reopened.recover_inflight(), (0, 0))
        uncertainties = reopened.uncertainties("product-new", unresolved_only=True)
        self.assertEqual(
            {row.correlation_id for row in uncertainties}, {"submitted", "native-turn"}
        )
        self.assertTrue(all(row.state.value == "unknown" for row in uncertainties))
        self.assertEqual(
            require_present(reopened.activation("product-new")).open_state, OpenState.OPEN_UNKNOWN
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "waiting")).state,
            QueuedMessageState.FAILED,
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "waiting")).safe_error,
            QUEUE_RECOVERY_WAIT_INTERRUPTED,
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "waiting")).deadline,
            TEST_DEADLINE,
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "running")).native_turn_id,
            "native-turn",
        )
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "running")).state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.assertIsNone(reopened.begin_queued_submission("product-new", "submitted"))
        self.assertEqual(
            require_present(reopened.queued_message("product-new", "completed")).state,
            QueuedMessageState.COMPLETED,
        )

    def test_cancel_and_complete_keep_exact_request_idempotency(self) -> None:
        catalog = SessionCatalogStore(self.database)
        allocate_session(catalog, "product-new")
        body = {"text": "once"}
        catalog.enqueue_message("product-new", "cancelled", body)
        waiting = catalog.begin_resource_wait(
            "product-new", "cancelled", purpose="turn", deadline=TEST_DEADLINE
        )
        self.assertEqual(require_present(waiting).deadline, TEST_DEADLINE)
        self.assertTrue(catalog.delete_queued_message("product-new", "cancelled"))
        self.assertEqual(
            catalog.enqueue_message("product-new", "cancelled", body).state,
            QueuedMessageState.CANCELLED,
        )
        self.assertIsNone(catalog.begin_queued_submission("product-new", "cancelled"))
        with self.assertRaises(SessionStateConflictError):
            catalog.enqueue_message("product-new", "cancelled", {"text": "different"})
        catalog.enqueue_message("product-new", "typed-value", {"value": True})
        with self.assertRaises(SessionStateConflictError):
            catalog.enqueue_message("product-new", "typed-value", {"value": 1})
        catalog.delete_queued_message("product-new", "typed-value")
        catalog.enqueue_message("product-new", "complete", body)
        catalog.begin_queued_submission("product-new", "complete")
        running = catalog.mark_queue_running("product-new", "complete", "native-turn")
        self.assertEqual(require_present(running).state, QueuedMessageState.RUNNING)
        self.assertEqual(catalog.queued_messages("product-new"), ())
        catalog.fail_queued_submission(
            "product-new", "complete", unknown=False, safe_error="late-rejection"
        )
        self.assertEqual(
            require_present(catalog.queued_message("product-new", "complete")).state,
            QueuedMessageState.RUNNING,
        )
        self.assertEqual(
            catalog.mark_queue_running("product-new", "complete", "native-turn"), running
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.mark_queue_running("product-new", "complete", "different-turn")
        self.assertTrue(catalog.complete_queued_message("product-new", "complete"))
        self.assertEqual(
            catalog.enqueue_message("product-new", "complete", body).state,
            QueuedMessageState.COMPLETED,
        )
        self.assertIsNone(catalog.begin_queued_submission("product-new", "complete"))

    def test_old_queue_schema_is_extended_in_place(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-old", "thread-old")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"DROP TABLE {SESSION_MESSAGE_QUEUE_TABLE}")
            connection.execute(f"""
                CREATE TABLE {SESSION_MESSAGE_QUEUE_TABLE} (
                    queued_message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    enqueue_seq INTEGER NOT NULL, operation_seq INTEGER, state TEXT NOT NULL,
                    body TEXT NOT NULL, safe_error TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    UNIQUE(session_id, enqueue_seq),
                    UNIQUE(session_id, operation_seq),
                    FOREIGN KEY(session_id) REFERENCES session_catalog(session_id) ON DELETE CASCADE
                )
                """)
            connection.execute(
                f"INSERT INTO {SESSION_MESSAGE_QUEUE_TABLE} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "old-request",
                    "product-old",
                    1,
                    None,
                    "queued",
                    '{"text":"preserved"}',
                    "",
                    1.0,
                    1.0,
                ),
            )
        reopened = SessionCatalogStore(self.database)
        record = reopened.queued_message("product-old", "old-request")
        self.assertEqual(require_present(record).body, {"text": "preserved"})
        self.assertEqual(require_present(record).purpose, "turn")
        self.assertIsNone(require_present(record).deadline)
        self.assertEqual(require_present(record).native_turn_id, "")
        self.assertEqual(require_present(record).submission_mode, SubmissionMode.QUEUED)
        self.assertEqual(
            reopened.enqueue_message("product-old", "old-request", {"text": "preserved"}), record
        )

    def test_pending_turn_settlement_survives_reopen_and_rejects_other_turns(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-settlement", "thread-settlement")
        event = RuntimeEvent(
            schema_version=1,
            event_id="terminal-event",
            runtime_id=RUNTIME_ID,
            product_session_id="product-settlement",
            native_session_id="thread-settlement",
            process_generation=2,
            sequence=8,
            kind=RuntimeEventKind.TURN_FAILED,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-09-24T00:00:00Z",
            native_turn_id="native-turn",
            actor_kind=ActorKind.MAIN,
            payload={"reason": "native failure", "details": ["one", "two"]},
        )
        recorded = catalog.record_turn_settlement("product-settlement", "client-turn", event)
        reopened = SessionCatalogStore(self.database)
        restored = reopened.pending_turn_settlement("product-settlement")
        self.assertEqual(restored, recorded)
        self.assertIs(type(require_present(restored).event.kind), RuntimeEventKind)
        self.assertIs(type(require_present(restored).event.delivery), DeliveryClass)
        self.assertIs(type(require_present(restored).event.actor_kind), ActorKind)
        self.assertEqual(
            reopened.record_turn_settlement("product-settlement", "client-turn", event), recorded
        )
        self.assertTrue(reopened.mark_turn_recovery_blocked("product-settlement", True))
        blocked = SessionCatalogStore(self.database).pending_turn_settlement("product-settlement")
        self.assertIsNotNone(blocked)
        self.assertTrue(require_present(blocked).recovery_blocked)
        self.assertTrue(reopened.mark_turn_recovery_blocked("product-settlement", False))
        self.assertFalse(
            require_present(
                SessionCatalogStore(self.database).pending_turn_settlement("product-settlement")
            ).recovery_blocked
        )
        with self.assertRaises(SessionStateConflictError):
            reopened.record_turn_settlement("product-settlement", "other-client-turn", event)
        with self.assertRaises(SessionStateConflictError):
            reopened.record_turn_settlement(
                "product-settlement",
                "client-turn",
                dataclasses.replace(event, event_id="other-event"),
            )
        with self.assertRaises(SessionStateConflictError):
            reopened.record_turn_settlement(
                "product-settlement",
                "client-turn",
                dataclasses.replace(event, native_turn_id="other-native-turn"),
            )
        self.assertFalse(reopened.clear_turn_settlement("product-settlement", "other-native-turn"))
        self.assertEqual(reopened.pending_turn_settlement("product-settlement"), recorded)
        self.assertTrue(reopened.clear_turn_settlement("product-settlement", "native-turn"))
        self.assertIsNone(reopened.pending_turn_settlement("product-settlement"))

    def test_unknown_turn_settlement_promotes_only_matching_resolution(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-unknown", "thread-unknown")
        unknown = RuntimeEvent(
            schema_version=1,
            event_id="unknown-event",
            runtime_id=RUNTIME_ID,
            product_session_id="product-unknown",
            native_session_id="thread-unknown",
            process_generation=2,
            sequence=8,
            kind=RuntimeEventKind.TURN_UNKNOWN,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-09-24T00:00:00Z",
            native_turn_id="client-turn",
            correlation_id="client-turn",
            actor_kind=ActorKind.MAIN,
            payload={"incident": {"incident_id": "incident-unknown"}},
        )
        recorded = catalog.record_turn_settlement("product-unknown", "client-turn", unknown)
        completed = dataclasses.replace(
            unknown,
            event_id="completed-event",
            process_generation=3,
            sequence=9,
            kind=RuntimeEventKind.TURN_COMPLETED,
            native_turn_id="native-turn",
            payload={"resolved_ambiguous_incident_id": "incident-unknown"},
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.record_turn_settlement(
                "product-unknown",
                "client-turn",
                dataclasses.replace(
                    completed, payload={"resolved_ambiguous_incident_id": "other-incident"}
                ),
            )
        promoted = catalog.record_turn_settlement("product-unknown", "client-turn", completed)
        self.assertEqual(promoted.event, completed)
        self.assertEqual(promoted.created_at, recorded.created_at)
        self.assertEqual(catalog.pending_turn_settlement("product-unknown"), promoted)
        self.assertEqual(
            catalog.record_turn_settlement("product-unknown", "client-turn", completed), promoted
        )
        with self.assertRaises(SessionStateConflictError):
            catalog.record_turn_settlement(
                "product-unknown", "client-turn", dataclasses.replace(completed, event_id="other")
            )

    def test_submission_unknown_and_process_exit_share_one_pending_settlement(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-unknown", "thread-unknown")
        submission = RuntimeEvent(
            schema_version=1,
            event_id="submission-unknown",
            runtime_id=RUNTIME_ID,
            product_session_id="product-unknown",
            native_session_id="thread-unknown",
            process_generation=2,
            sequence=8,
            kind=RuntimeEventKind.TURN_UNKNOWN,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-10-26T00:00:00Z",
            native_turn_id="client-turn",
            correlation_id="client-turn",
            actor_kind=ActorKind.MAIN,
            payload={
                "incident": {
                    "incident_id": "submission-incident",
                    "scope": "turn",
                    "kind": "transport_lost",
                    "retryability": "unknown_outcome",
                    "process_generation": 2,
                    "native_session_id": "thread-unknown",
                    "native_turn_id": "client-turn",
                    "rpc_method": "turn/start",
                    "ambiguous_commit": True,
                }
            },
        )
        exited = dataclasses.replace(
            submission,
            event_id="exit-unknown",
            payload={
                "incident": {
                    "incident_id": "process-incident",
                    "scope": "process",
                    "kind": "process_exit",
                    "process_generation": 2,
                    "native_session_id": "thread-unknown",
                }
            },
        )
        for first, second in ((submission, exited), (exited, submission)):
            with self.subTest(first=first.event_id):
                late_session = f"product-late-{first.event_id}"
                late_database = self.database.with_name(f"{late_session}.sqlite3")
                late_catalog = SessionCatalogStore(late_database)
                register_session(late_catalog, late_session, "thread-unknown")
                late_first = dataclasses.replace(first, product_session_id=late_session)
                late_second = dataclasses.replace(
                    second, product_session_id=late_session, sequence=9
                )
                original = late_catalog.record_unknown_turn(
                    late_session, "client-turn", late_first, safe_error="unknown"
                )
                refined = late_catalog.record_unknown_turn(
                    late_session, "client-turn", late_second, safe_error="unknown"
                )
                self.assertEqual(refined.incident_id, "submission-incident")
                self.assertEqual(refined.created_at, original.created_at)
                self.assertEqual(refined.state, UncertaintyState.UNKNOWN)
                reopened_unknown = SessionCatalogStore(late_database)
                self.assertEqual(
                    reopened_unknown.uncertainty(late_session, UncertaintyKind.TURN, "client-turn"),
                    refined,
                )
                self.assertTrue(
                    reopened_unknown.confirm_turn_uncertainty(
                        late_session,
                        "client-turn",
                        turn_status="confirmed",
                        resolution="continue_without_replay",
                    )
                )
                confirmed = reopened_unknown.uncertainty(
                    late_session, UncertaintyKind.TURN, "client-turn"
                )
                self.assertEqual(
                    reopened_unknown.record_unknown_turn(
                        late_session, "client-turn", late_second, safe_error="late"
                    ),
                    confirmed,
                )
                catalog.clear_turn_settlement("product-unknown", "client-turn")
                recorded = catalog.record_turn_settlement("product-unknown", "client-turn", first)
                self.assertTrue(catalog.mark_turn_recovery_blocked("product-unknown", True))
                merged = catalog.record_turn_settlement(
                    "product-unknown", "client-turn", dataclasses.replace(second, sequence=9)
                )
                self.assertEqual(merged.event.event_id, submission.event_id)
                self.assertEqual(merged.created_at, recorded.created_at)
                self.assertTrue(merged.recovery_blocked)
                reopened = SessionCatalogStore(self.database)
                self.assertEqual(reopened.pending_turn_settlement("product-unknown"), merged)
                resolved = dataclasses.replace(
                    submission,
                    event_id="resolved-event",
                    kind=RuntimeEventKind.TURN_COMPLETED,
                    native_turn_id="native-turn",
                    process_generation=3,
                    sequence=10,
                    payload={"resolved_ambiguous_incident_id": "submission-incident"},
                )
                promoted = reopened.record_turn_settlement(
                    "product-unknown", "client-turn", resolved
                )
                self.assertEqual(promoted.event, resolved)
                self.assertTrue(reopened.clear_turn_settlement("product-unknown", "native-turn"))

        assert isinstance(submission.payload, dict)
        submission_values = submission.payload["incident"]
        assert isinstance(submission_values, dict)
        for method in ("turn/steer", "turn/interrupt", "", None):
            incident = dict(submission_values)
            if method is None:
                incident.pop("rpc_method")
            else:
                incident["rpc_method"] = method
            different_operation = dataclasses.replace(submission, payload={"incident": incident})
            for first, second in ((different_operation, exited), (exited, different_operation)):
                with self.subTest(method=method, first=first.event_id):
                    catalog.clear_turn_settlement("product-unknown", "client-turn")
                    previous = catalog.record_turn_settlement(
                        "product-unknown", "client-turn", first
                    )
                    with self.assertRaises(SessionStateConflictError):
                        catalog.record_turn_settlement("product-unknown", "client-turn", second)
                    self.assertEqual(catalog.pending_turn_settlement("product-unknown"), previous)
        catalog.clear_turn_settlement("product-unknown", "client-turn")
        recorded = catalog.record_turn_settlement("product-unknown", "client-turn", submission)
        for mismatch in (
            {"runtime_id": "other-runtime"},
            {"native_session_id": "other-thread"},
            {"native_turn_id": "other-turn"},
            {"correlation_id": "other-client"},
            {"process_generation": 3},
            {"actor_kind": ActorKind.SUBAGENT},
            {"event_id": submission.event_id},
            {"kind": RuntimeEventKind.TURN_FAILED},
        ):
            with self.subTest(mismatch=mismatch), self.assertRaises(SessionStateConflictError):
                catalog.record_turn_settlement(
                    "product-unknown", "client-turn", dataclasses.replace(exited, **mismatch)
                )
            self.assertEqual(catalog.pending_turn_settlement("product-unknown"), recorded)

        assert isinstance(exited.payload, dict)
        exit_incident = exited.payload["incident"]
        assert isinstance(exit_incident, dict)
        for incident_mismatch in (
            {"native_session_id": "other-thread"},
            {"native_turn_id": "other-turn"},
            {"process_generation": 3},
            {"process_generation": True},
            {"kind": "transport_lost"},
            {"scope": "turn"},
            {"incident_id": ""},
        ):
            invalid = dataclasses.replace(
                exited,
                payload={"incident": {**exit_incident, **incident_mismatch}},
            )
            with self.subTest(incident_mismatch=incident_mismatch):
                with self.assertRaises(SessionStateConflictError):
                    catalog.record_turn_settlement("product-unknown", "client-turn", invalid)
                self.assertEqual(catalog.pending_turn_settlement("product-unknown"), recorded)

        self.assertTrue(
            catalog.claim_uncertainty(
                "product-unknown",
                UncertaintyKind.TURN,
                "client-turn",
                incident_id="legacy-incident",
                process_generation=2,
                state=UncertaintyState.UNKNOWN,
                payload={"retained": "yes"},
            )
        )
        legacy = catalog.uncertainty("product-unknown", UncertaintyKind.TURN, "client-turn")
        self.assertEqual(
            catalog.record_unknown_turn(
                "product-unknown", "client-turn", submission, safe_error="unknown"
            ),
            legacy,
        )

    def test_message_queue_has_a_durable_per_session_capacity(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "product-a", "thread-a")
        for index in range(MAX_QUEUED_MESSAGES_PER_SESSION):
            catalog.enqueue_message(
                "product-a",
                f"queue-{index}",
                {"input": [{"type": "text", "text": str(index)}]},
            )

        with self.assertRaises(SessionQueueCapacityError):
            catalog.enqueue_message(
                "product-a",
                "queue-overflow",
                {"input": [{"type": "text", "text": "overflow"}]},
            )
        self.assertEqual(
            len(SessionCatalogStore(self.database).queued_messages("product-a")),
            MAX_QUEUED_MESSAGES_PER_SESSION,
        )
        catalog.begin_queued_submission("product-a", "queue-0")
        catalog.mark_queue_running("product-a", "queue-0", "native-turn")
        with self.assertRaises(SessionQueueCapacityError):
            catalog.enqueue_message("product-a", "still-full", {"text": "later"})
        self.assertTrue(catalog.complete_queued_message("product-a", "queue-0"))
        replacement = catalog.enqueue_message("product-a", "after-completion", {"text": "later"})
        self.assertEqual(replacement.enqueue_seq, MAX_QUEUED_MESSAGES_PER_SESSION + 1)
        self.assertTrue(catalog.delete_queued_message("product-a", "queue-1"))
        catalog.enqueue_message("product-a", "after-cancellation", {"text": "later"})
        self.assertEqual(len(catalog.queued_messages("product-a")), MAX_QUEUED_MESSAGES_PER_SESSION)

    def test_turn_confirmation_matches_exact_uncertainty_and_retains_evidence(self) -> None:
        catalog = SessionCatalogStore(self.database)
        register_session(catalog, "confirm-session", "confirm-thread")
        evidence = {"runtime_event": {"event_id": "unknown-event"}, "outcome": "unknown"}
        catalog.claim_uncertainty(
            "confirm-session",
            UncertaintyKind.TURN,
            "confirm-client",
            incident_id="confirm-incident",
            process_generation=4,
            state=UncertaintyState.UNKNOWN,
            payload=evidence,
        )
        for expected in ((3, "confirm-incident"), (4, "wrong-incident")):
            with self.subTest(expected=expected):
                self.assertFalse(
                    catalog.confirm_turn_uncertainty(
                        "confirm-session",
                        "confirm-client",
                        turn_status="confirmed",
                        resolution="continue_without_replay",
                        expected_uncertainty=expected,
                    )
                )
        self.assertTrue(
            catalog.confirm_turn_uncertainty(
                "confirm-session",
                "confirm-client",
                turn_status="confirmed",
                resolution="continue_without_replay",
                expected_uncertainty=(4, "confirm-incident"),
            )
        )
        row = require_present(
            catalog.uncertainty("confirm-session", UncertaintyKind.TURN, "confirm-client")
        )
        self.assertEqual(row.state, UncertaintyState.CONFIRMED)
        self.assertEqual(row.payload["runtime_event"], evidence["runtime_event"])
        self.assertEqual(row.payload["outcome"], "unknown")


if __name__ == "__main__":
    unittest.main()
