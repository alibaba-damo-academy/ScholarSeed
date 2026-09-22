"""Contract for durable, idempotent, session-scoped product events."""

from __future__ import annotations

import logging
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from scholarseed_runtime.contract import CapabilitySet, RuntimeBinding
from service.chat.constants import (
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_EVENT_VERSION,
    PRODUCT_EVENT_VERSION_V1,
)
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.persistence.events import (
    PRODUCT_EVENT_TABLE,
    ProductEventSchemaError,
    ProductEventStore,
    upcast_product_event,
)
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.service.estimate import SkillDurationEstimator
from service.chat.service.events import EventService
from service.chat.service.history import HistoryService

SESSION_ID = "product-session"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "thread-123"
OWNER = SessionPrincipal("event-owner")
CONCURRENT_EVENT_COUNT = 16


def register_session(database: Path) -> SessionCatalogStore:
    catalog = SessionCatalogStore(database)
    catalog.register(
        SESSION_ID,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=VENDOR_THREAD_ID,
        vendor_session_id="process-1",
        runtime_workdir="/tmp/product-session",
        project_path=None,
        output_root="/tmp/product-session/outputs",
        codex_version="0.42.0",
        model_id="gpt-5-codex",
        policy_id="workspace-write",
        status=SessionStatus.READY,
        title="",
        created_at=1.0,
    )
    return catalog


class ProductEventContract(unittest.TestCase):
    def test_rejected_history_is_filtered_only_for_model_and_survives_reopen(self) -> None:
        for index, code in enumerate(
            ("", "CONTENT_SAFETY_BLOCKED", "content_safety_unavailable", "")
        ):
            turn = f"turn-{index}"
            for role, kind in (
                ("user", PRODUCT_EVENT_USER_MESSAGE),
                ("assistant", PRODUCT_EVENT_MESSAGE_DELTA),
            ):
                self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id=turn,
                    vendor_item_id=f"{turn}-{role}",
                    kind=kind,
                    payload={
                        "text": f"{role}-{index}",
                        "delta": f"{role}-{index}",
                        "client_turn_id": turn,
                    },
                    idempotency_key=f"{turn}-{role}",
                )
            if code:
                self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id=turn,
                    vendor_item_id="",
                    kind=PRODUCT_EVENT_TURN_FAILED,
                    payload={"code": code},
                    idempotency_key=f"{turn}-failed",
                )
        reopened = ProductEventStore(self.database)
        self.assertEqual(len(reopened.portable_history(SESSION_ID)), 8)
        clean = reopened.portable_history(SESSION_ID, exclude_rejected=True)
        self.assertEqual(
            [e.turn_id for e in clean], ["turn-0", "turn-0", "turn-2", "turn-2", "turn-3", "turn-3"]
        )
        self.assertEqual(reopened.rejected_turns(SESSION_ID, "replacement"), frozenset())
        source = HistoryService(self.catalog, reopened).source(SESSION_ID, SESSION_ID)
        self.assertEqual(source.entries, clean)

    def test_binding_replacement_is_atomic_and_does_not_delete_events(self) -> None:
        previous = RuntimeBinding(
            SESSION_ID, RUNTIME_ID, "1", "1", "1", "hash", VENDOR_THREAD_ID, CapabilitySet()
        )
        connection = self.catalog._connect()
        try:
            self.catalog._store_runtime_binding(connection, previous, 1.0)
            connection.commit()
        finally:
            connection.close()
        self.append("kept")
        replacement = replace(previous, opaque_session_ref="clean-thread")
        self.catalog.replace_runtime_binding(previous, replacement)
        reopened = SessionCatalogStore(self.database)
        self.assertEqual(reopened.runtime_binding(SESSION_ID), replacement)
        self.assertEqual(reopened.get(SESSION_ID).vendor_thread_id, "clean-thread")
        self.assertEqual(len(self.events.replay(SESSION_ID)), 1)
        with self.assertRaises(SessionBindingConflictError):
            reopened.replace_runtime_binding(
                previous, replace(previous, opaque_session_ref="stale-thread")
            )
        self.assertEqual(reopened.runtime_binding(SESSION_ID), replacement)

    def test_answer_model_snapshot_survives_reopen_and_selection_changes(self) -> None:
        runs = [
            ModelRun("connection-a", "阿里云百炼", "chosen-a", "actual-a", "dashscope"),
            ModelRun("connection-b", "阿里云百炼", "chosen-b"),
        ]
        turns = []
        for index, run in enumerate(runs):
            turn_id, item_id = f"turn-{index}", f"answer-{index}"
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id=turn_id,
                vendor_item_id=item_id,
                kind=PRODUCT_EVENT_MESSAGE_DELTA,
                payload={
                    "delta": "answer",
                    # Simulate the old wire shape for the unmarked, same-name answer.
                    MODEL_RUN_FIELD: {
                        key: value
                        for key, value in run.payload().items()
                        if key != "provider_preset_id" or value
                    },
                },
                idempotency_key=item_id,
            )
            turns.append(
                {
                    "role": "assistant",
                    "kind": "text",
                    "text": "answer",
                    "turn_id": turn_id,
                    "item_id": item_id,
                }
            )
        self.catalog.set_model(SESSION_ID, OWNER, "unrelated-new-selection")
        reopened = ProductEventStore(self.catalog.database)
        service = EventService({}, reopened, logging.getLogger(__name__))
        restored = service.decorate_history(
            SESSION_ID,
            turns
            + [
                {
                    "role": "assistant",
                    "kind": "text",
                    "text": "old",
                    "turn_id": "legacy",
                    "item_id": "legacy",
                }
            ],
        )
        self.assertEqual(
            [row[MODEL_RUN_FIELD] for row in restored[:2]], [run.payload() for run in runs]
        )
        self.assertNotIn(MODEL_RUN_FIELD, restored[2])
        self.assertEqual(
            reopened.model_runs(SESSION_ID),
            {f"turn-{index}": run for index, run in enumerate(runs)},
        )

    def test_logical_events_precede_native_binding_without_inventing_a_thread(self) -> None:
        session_id = "logical-session"
        record = self.catalog.allocate(
            session_id,
            OWNER,
            runtime_id=RUNTIME_ID,
            runtime_workdir="/tmp/logical-session",
            project_path=None,
            output_root="/tmp/logical-session/outputs",
        )
        event = self.events.bind_workspace(record, initial=True)
        self.assertEqual(event.vendor_thread_id, "")
        self.assertEqual(self.catalog.get(session_id).last_product_seq, event.product_seq)
        with self.assertRaises(ValueError):
            self.events.append(
                session_id=session_id,
                runtime_id=RUNTIME_ID,
                vendor_thread_id="",
                vendor_turn_id="turn-without-thread",
                vendor_item_id=None,
                kind="turn.started",
                payload={},
                idempotency_key="invalid-native-event",
            )

    def test_workspace_binding_and_catalog_roll_back_together(self) -> None:
        original = self.catalog.get(SESSION_ID)
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with self.events.transaction() as connection:
                self.events.bind_workspace(original, initial=True, connection=connection)
                moved = self.catalog.relocate(
                    SESSION_ID,
                    OWNER,
                    runtime_workdir="/tmp/new/session",
                    project_path="/tmp/new",
                    output_root="/tmp/new/session",
                    connection=connection,
                )
                self.events.bind_workspace(moved, connection=connection)
                raise RuntimeError("abort")
        self.assertEqual(self.catalog.get(SESSION_ID), original)
        self.assertEqual(self.events.replay(SESSION_ID), ())

    def test_workspace_source_boundary_survives_multiple_rebindings(self) -> None:
        original = self.catalog.get(SESSION_ID)
        self.events.bind_workspace(original, initial=True)
        old_event = self.append("old")
        for index in range(2):
            with self.events.transaction() as connection:
                moved = self.catalog.relocate(
                    SESSION_ID,
                    OWNER,
                    runtime_workdir=f"/tmp/project-{index}/session",
                    project_path=f"/tmp/project-{index}",
                    output_root=f"/tmp/project-{index}/session",
                    connection=connection,
                )
                binding = self.events.bind_workspace(moved, connection=connection)
            current = self.catalog.get(SESSION_ID)
            self.assertEqual(
                self.events.workspace_for_sequence(current, old_event.product_seq).runtime_workdir,
                original.runtime_workdir,
            )
            self.assertEqual(
                self.events.workspace_for_sequence(current, binding.product_seq).runtime_workdir,
                moved.runtime_workdir,
            )

    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory(prefix="product-events-")
        self.database = Path(self._temporary.name) / "sessions.sqlite3"
        self.catalog = register_session(self.database)
        self.events = ProductEventStore(self.database)

    def tearDown(self) -> None:
        self._temporary.cleanup()

    def append(self, key: str, *, kind: str = "message_delta"):
        return self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-1",
            vendor_item_id="item-1",
            kind=kind,
            payload={"delta": key},
            idempotency_key=key,
            created_at=10.0,
        )

    def test_append_is_durable_monotonic_and_idempotent(self) -> None:
        first = self.append("event-1")
        repeated = self.append("event-1")
        second = self.append("event-2", kind="reasoning_delta")

        self.assertEqual(first, repeated)
        self.assertEqual((first.product_seq, second.product_seq), (1, 2))
        self.assertEqual(first.schema_version, PRODUCT_EVENT_VERSION)
        replayed = ProductEventStore(self.database).replay(SESSION_ID, after_seq=1)
        self.assertEqual(replayed, (second,))
        catalog_record = SessionCatalogStore(self.database).get(SESSION_ID)
        self.assertIsNotNone(catalog_record)
        assert catalog_record is not None
        self.assertEqual(catalog_record.last_product_seq, 2)

    def test_skill_duration_estimate_uses_durable_completed_turns(self) -> None:
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-estimate",
            vendor_item_id="skill-estimate",
            kind=PRODUCT_EVENT_SKILL_STARTED,
            payload={"skill_id": "skill-estimate", "skill": "survey", "status": "running"},
            idempotency_key="skill-estimate-started",
            created_at=100.0,
        )
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-estimate",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_TURN_COMPLETED,
            payload={"status": "completed"},
            idempotency_key="skill-estimate-completed",
            created_at=1_900.0,
        )

        estimate = SkillDurationEstimator(self.events).estimate("survey")

        self.assertIsNotNone(estimate)
        assert estimate is not None
        self.assertEqual(estimate.sample_count, 1)
        self.assertEqual(estimate.confidence, "low")
        self.assertLess(estimate.lower_seconds, 1_800)
        self.assertGreater(estimate.upper_seconds, 1_800)
        self.assertIsNone(
            SkillDurationEstimator(self.events, policies={}).estimate(
                "survey", excluded_session_id=SESSION_ID
            )
        )

    def test_recent_kind_query_preserves_chronological_order(self) -> None:
        self.append("first-kind", kind="kind-a")
        self.append("second-kind", kind="kind-b")

        records = self.events.recent_kinds(("kind-a", "kind-b"))

        self.assertEqual([record.kind for record in records], ["kind-a", "kind-b"])

    def test_registered_skill_baseline_is_available_before_history_exists(self) -> None:
        estimate = SkillDurationEstimator(self.events).estimate("literature-review")

        self.assertIsNotNone(estimate)
        assert estimate is not None
        self.assertEqual((estimate.lower_seconds, estimate.upper_seconds), (1_800, 2_700))
        self.assertEqual(estimate.basis, "product_baseline")
        self.assertEqual(estimate.sample_count, 0)

    def test_sparse_history_keeps_registered_baseline_range(self) -> None:
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-slr-estimate",
            vendor_item_id="skill-slr-estimate",
            kind=PRODUCT_EVENT_SKILL_STARTED,
            payload={"skill": "literature-review", "status": "running"},
            idempotency_key="skill-slr-estimate-started",
            created_at=100.0,
        )
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id="turn-slr-estimate",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_TURN_COMPLETED,
            payload={"status": "completed"},
            idempotency_key="skill-slr-estimate-completed",
            created_at=1_300.0,
        )

        estimate = SkillDurationEstimator(self.events).estimate("literature-review")

        self.assertIsNotNone(estimate)
        assert estimate is not None
        self.assertEqual(estimate.sample_count, 1)
        self.assertEqual((estimate.lower_seconds, estimate.upper_seconds), (900, 2_700))

    def test_legacy_rows_are_backfilled_as_v1_and_purely_upcast_to_v2(self) -> None:
        first = self.append("legacy-event")
        with sqlite3.connect(self.database) as connection:
            connection.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET schema_version = ? WHERE event_id = ?",
                (PRODUCT_EVENT_VERSION_V1, first.event_id),
            )

        persisted = ProductEventStore(self.database).replay(SESSION_ID)[0]
        upgraded = upcast_product_event(persisted)

        self.assertEqual(persisted.schema_version, PRODUCT_EVENT_VERSION_V1)
        self.assertEqual(upgraded.schema_version, PRODUCT_EVENT_VERSION)
        self.assertEqual(upgraded.payload, persisted.payload)
        with sqlite3.connect(self.database) as connection:
            stored = connection.execute(
                f"SELECT schema_version FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?",
                (first.event_id,),
            ).fetchone()
        self.assertEqual(stored, (PRODUCT_EVENT_VERSION_V1,))

    def test_unknown_event_schema_fails_closed(self) -> None:
        event = self.append("future-event")
        with self.assertRaises(ProductEventSchemaError):
            upcast_product_event(event.__class__(**{**event.__dict__, "schema_version": 999}))

    def test_reused_idempotency_key_with_different_payload_is_rejected(self) -> None:
        self.append("event-1")
        with self.assertRaises(SessionStateConflictError):
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-1",
                vendor_item_id="item-1",
                kind="message_delta",
                payload={"delta": "different"},
                idempotency_key="event-1",
            )

    def test_concurrent_append_allocates_each_sequence_once(self) -> None:
        def append_index(index: int) -> int:
            event = ProductEventStore(self.database).append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-concurrent",
                vendor_item_id=f"item-{index}",
                kind="tool_completed",
                payload={"index": index},
                idempotency_key=f"concurrent-{index}",
            )
            return event.product_seq

        with ThreadPoolExecutor(max_workers=4) as executor:
            sequences = list(executor.map(append_index, range(CONCURRENT_EVENT_COUNT)))

        self.assertEqual(sorted(sequences), list(range(1, CONCURRENT_EVENT_COUNT + 1)))
        replayed = self.events.replay(SESSION_ID)
        self.assertEqual(
            [event.product_seq for event in replayed],
            list(range(1, CONCURRENT_EVENT_COUNT + 1)),
        )

    def test_initialization_repairs_event_foreign_key_after_catalog_rebuild(self) -> None:
        self.append("event-before-repair")
        with sqlite3.connect(self.database) as connection:
            connection.row_factory = sqlite3.Row
            connection.execute(f"ALTER TABLE {PRODUCT_EVENT_TABLE} RENAME TO broken_event")
            connection.execute(f"""
                CREATE TABLE {PRODUCT_EVENT_TABLE} (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    runtime_id TEXT NOT NULL,
                    vendor_thread_id TEXT NOT NULL,
                    vendor_turn_id TEXT,
                    vendor_item_id TEXT,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    product_seq INTEGER NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    UNIQUE(session_id, product_seq),
                    UNIQUE(session_id, idempotency_key),
                    FOREIGN KEY(session_id) REFERENCES session_catalog_migration(session_id)
                        ON DELETE CASCADE
                )
                """)
            connection.execute(f"""
                INSERT INTO {PRODUCT_EVENT_TABLE} (
                    event_id, session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                    vendor_item_id, kind, payload, product_seq, idempotency_key, created_at
                )
                SELECT
                    event_id, session_id, runtime_id, vendor_thread_id, vendor_turn_id,
                    vendor_item_id, kind, payload, product_seq, idempotency_key, created_at
                FROM broken_event
                """)
            connection.execute("DROP TABLE broken_event")

        repaired = ProductEventStore(self.database)
        with sqlite3.connect(self.database) as connection:
            connection.row_factory = sqlite3.Row
            targets = {
                str(row["table"])
                for row in connection.execute(
                    f"PRAGMA foreign_key_list({PRODUCT_EVENT_TABLE})"
                ).fetchall()
            }

        self.assertEqual(targets, {SESSION_CATALOG_TABLE})
        self.assertEqual(
            [event.idempotency_key for event in repaired.replay(SESSION_ID)],
            ["event-before-repair"],
        )


if __name__ == "__main__":
    unittest.main()
