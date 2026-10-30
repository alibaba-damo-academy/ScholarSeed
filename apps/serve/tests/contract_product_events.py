"""Contract for durable, idempotent, session-scoped product events."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest.mock import patch

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
from service.chat.persistence import blocks
from service.chat.persistence import events as event_storage
from service.chat.persistence import journal
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStateConflictError,
    SessionStatus,
)
from service.chat.persistence.events import (
    MIGRATION_BATCH_EVENTS,
    PRODUCT_EVENT_MIGRATION_TABLE,
    PRODUCT_EVENT_TABLE,
    ProductEventSchemaError,
    ProductEventStore,
    upcast_product_event,
)
from service.chat.persistence.worker import PersistenceWorker
from service.chat.provenance import MODEL_RUN_FIELD, ModelRun
from service.chat.service.estimate import SkillDurationEstimator
from service.chat.service.events import EventService
from service.chat.service.history import HistoryService
from service.persistence.rows import rows_digest

SESSION_ID = "product-session"
RUNTIME_ID = "codex"
VENDOR_THREAD_ID = "thread-123"
OWNER = SessionPrincipal("event-owner")
CONCURRENT_EVENT_COUNT = 16


def register_session(database: Path, session_id: str = SESSION_ID) -> SessionCatalogStore:
    catalog = SessionCatalogStore(database)
    catalog.register(
        session_id,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=VENDOR_THREAD_ID if session_id == SESSION_ID else f"thread:{session_id}",
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
            (
                "",
                "CONTENT_SAFETY_BLOCKED",
                "content_safety_unavailable",
                "",
            )
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
        session = reopened.get(SESSION_ID)
        assert session is not None
        self.assertEqual(session.vendor_thread_id, "clean-thread")
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
        session = self.catalog.get(session_id)
        assert session is not None
        self.assertEqual(session.last_product_seq, event.product_seq)
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
        assert original is not None
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
        assert original is not None
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
            assert current is not None
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

    def append(self, key: str, *, kind: str = "tool_completed"):
        """Default to a sparse event so SQL schema fixtures retain real rows."""
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

    def test_transaction_batch_deduplicates_and_rolls_back_failed_flush(self) -> None:
        def append_batch():
            with self.events.transaction() as connection, self.events.batch(connection) as store:
                return [
                    self.events.append(
                        session_id=SESSION_ID,
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id=VENDOR_THREAD_ID,
                        vendor_turn_id="turn-1",
                        vendor_item_id="item-1",
                        kind="message_delta",
                        payload={"delta": key},
                        idempotency_key=key,
                        connection=connection,
                        block_store=store,
                    )
                    for key in ("first", "first", "second")
                ]

        with patch.object(blocks.os, "fsync", side_effect=OSError("flush failed")):
            with self.assertRaises(OSError):
                append_batch()
        self.assertEqual(self.events.replay(SESSION_ID), ())
        self.assertEqual(self.catalog.get(SESSION_ID).last_product_seq, 0)
        records = append_batch()
        self.assertEqual([record.product_seq for record in records], [1, 1, 2])
        self.assertEqual(
            [record.payload["delta"] for record in self.events.replay(SESSION_ID)],
            ["first", "second"],
        )

    def test_blocks_preserve_interleaved_cursors_keys_and_global_ids(self) -> None:
        other = "other-session"
        register_session(self.database, other)
        expected = {SESSION_ID: [], other: []}
        all_events = []
        for index in range(620):
            session = SESSION_ID if index % 2 == 0 else other
            kind = "tool_completed" if index % 31 == 0 else "message_delta"
            record = self.events.append(
                session_id=session,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID if session == SESSION_ID else f"thread:{session}",
                vendor_turn_id="turn-1",
                vendor_item_id="item-1",
                kind=kind,
                payload={"delta": "正文🧬" * (index % 7) + str(index)},
                idempotency_key=f"opaque:{index}",
                created_at=float((index * 17) % 53),
            )
            expected[session].append(record)
            all_events.append(record)
        self.assertEqual([event.event_id for event in all_events], list(range(1, 621)))
        reopened = ProductEventStore(self.database)
        for session, records in expected.items():
            self.assertEqual(list(reopened.replay(session)), records)
            for after in (1, 19, 255, 256, 301, 310):
                self.assertEqual(
                    list(reopened.replay(session, after_seq=after, limit=13)),
                    records[after : after + 13],
                )
            self.assertEqual(reopened.item_events(session, vendor_item_id="item-1"), tuple(records))
            self.assertEqual(reopened.by_sequence(session, 257), records[256])
            self.assertEqual(
                reopened.latest_kind(session, "message_delta"),
                next(record for record in reversed(records) if record.kind == "message_delta"),
            )
        recent = sorted(all_events, key=lambda event: (event.created_at, event.event_id))[-23:]
        self.assertEqual(
            list(reopened.recent_kinds(("message_delta", "tool_completed"), limit=23)), recent
        )
        anchor = expected[SESSION_ID][1]
        self.assertEqual(reopened.by_key(SESSION_ID, anchor.idempotency_key), anchor)
        self.assertIsNone(reopened.by_key(SESSION_ID, "absent-opaque-key"))
        arguments: dict[str, Any] = dict(
            session_id=anchor.session_id,
            runtime_id=anchor.runtime_id,
            vendor_thread_id=anchor.vendor_thread_id,
            vendor_turn_id=anchor.vendor_turn_id,
            vendor_item_id=anchor.vendor_item_id,
            kind=anchor.kind,
            payload=anchor.payload,
            idempotency_key=anchor.idempotency_key,
        )
        self.assertEqual(reopened.append(**arguments), anchor)
        with self.assertRaises(SessionStateConflictError):
            reopened.append(**{**arguments, "payload": {"delta": "changed"}})
        with reopened.transaction() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM product_event").fetchone()[0],
                sum(event.kind == "tool_completed" for event in all_events),
            )
            self.assertLess(
                connection.execute(f"SELECT COUNT(*) FROM {blocks.TABLE}").fetchone()[0], 40
            )
            reopened.inspect_rows(connection, database=self.database)

    def test_blocks_reconstruct_revisions_and_transaction_rollback(self) -> None:
        values = ["初稿🧬", "初稿🧬继续", "修订🧬", "", "重新开始"]
        records = []
        for index, text in enumerate(values):
            records.append(
                self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id="turn-1",
                    vendor_item_id="item-1",
                    kind="message_delta",
                    payload={"delta": text, "phase": "final_answer"},
                    idempotency_key=f"snapshot:{index}",
                )
            )
        try:
            with self.events.transaction() as connection:
                failed = self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id="turn-1",
                    vendor_item_id="item-1",
                    kind="message_delta",
                    payload={"delta": "not committed"},
                    idempotency_key="rolled-back",
                    connection=connection,
                )
                self.assertEqual(
                    self.events.by_sequence(SESSION_ID, failed.product_seq, connection=connection),
                    failed,
                )
                self.assertEqual(
                    self.events.by_key(SESSION_ID, "rolled-back", connection=connection), failed
                )
                self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id="turn-1",
                    vendor_item_id="item-1",
                    kind="tool_completed",
                    payload={"output": "also aborted"},
                    idempotency_key="rolled-back-row",
                    connection=connection,
                )
                raise RuntimeError("abort transaction")
        except RuntimeError as error:
            self.assertEqual(str(error), "abort transaction")
        reopened = ProductEventStore(self.database)
        self.assertEqual(list(reopened.replay(SESSION_ID)), records)
        self.assertIsNone(reopened.by_key(SESSION_ID, "rolled-back"))
        self.assertIsNone(reopened.by_key(SESSION_ID, "rolled-back-row"))
        self.assertEqual(reopened.portable_history(SESSION_ID)[-1].text, values[-1])
        self.assertEqual(reopened.answer_timeline(SESSION_ID, source_product_seq=1), tuple(records))
        replacement = self.append("after-abort", kind="reasoning_delta")
        self.assertEqual(replacement.event_id, records[-1].event_id + 1)
        self.assertEqual(replacement.product_seq, records[-1].product_seq + 1)
        self.assertEqual(
            list(ProductEventStore(self.database).replay(SESSION_ID)), records + [replacement]
        )

    def test_scheduled_block_migration_interleaves_new_writes_without_history_loss(self) -> None:
        legacy = [self.append(f"legacy-block-{index}") for index in range(11)]
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET kind='message_delta'")
        legacy = [replace(event, kind="message_delta") for event in legacy]
        live = [self.append("live-before-migration", kind="reasoning_delta")]
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with self.events.transaction() as connection:
                self.assertEqual(self.events.migrate_blocks(connection, self.database, limit=3), 3)
                raise RuntimeError("abort")
        self.assertEqual(list(self.events.replay(SESSION_ID)), legacy + live)
        counts = []
        while True:
            with self.events.transaction() as connection:
                count = self.events.migrate_blocks(connection, self.database, limit=3)
                counts.append(count)
            if not count:
                break
            live.append(
                self.append(f"live-during-migration-{count}-{len(live)}", kind="message_delta")
            )
            self.assertEqual(
                list(ProductEventStore(self.database).replay(SESSION_ID)), legacy + live
            )
        self.assertEqual(counts, [3, 3, 3, 2, 0])
        with self.events.transaction() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM product_event").fetchone()[0], 0
            )
            self.assertEqual(self.events.migrate_bodies(connection, self.database), 0)
            self.events.inspect_rows(connection, database=self.database)
        for event in legacy + live:
            self.assertEqual(self.events.by_key(SESSION_ID, event.idempotency_key), event)
            self.assertEqual(self.events.by_sequence(SESSION_ID, event.product_seq), event)

    def test_inspection_rejects_row_block_identity_collisions_and_stale_cursors(self) -> None:
        original = self.append("block-authority", kind="message_delta")
        original_fields = {name: getattr(original, name) for name in original.__dataclass_fields__}
        original_fields["payload"] = json.dumps(
            original.payload, ensure_ascii=False, separators=(",", ":")
        )
        for collision, overrides in (
            (
                "id",
                {"event_id": original.event_id, "product_seq": 2, "idempotency_key": "other-key"},
            ),
            (
                "sequence",
                {
                    "event_id": 2,
                    "product_seq": original.product_seq,
                    "idempotency_key": "other-key",
                },
            ),
            (
                "idempotency key",
                {"event_id": 2, "product_seq": 2, "idempotency_key": original.idempotency_key},
            ),
        ):
            with self.subTest(collision=collision), self.events.transaction() as connection:
                connection.execute("SAVEPOINT corrupt_fixture")
                values = {**original_fields, **overrides}
                columns = tuple(values)
                connection.execute(
                    f"INSERT INTO product_event ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                    tuple(values.values()),
                )
                connection.execute(
                    "UPDATE session_catalog SET last_product_seq=2 WHERE session_id=?",
                    (SESSION_ID,),
                )
                with self.assertRaisesRegex(ValueError, "duplicate logical event " + collision):
                    self.events.inspect_rows(connection, database=self.database)
                connection.execute("ROLLBACK TO corrupt_fixture")
                connection.execute("RELEASE corrupt_fixture")
        for statement, error in (
            ("UPDATE sqlite_sequence SET seq=0 WHERE name='product_event'", "high water"),
            ("UPDATE session_catalog SET last_product_seq=0", "catalog cursor"),
        ):
            with self.subTest(error=error), self.events.transaction() as connection:
                connection.execute("SAVEPOINT stale_cursor")
                connection.execute(statement)
                with self.assertRaisesRegex(ValueError, error):
                    self.events.inspect_rows(connection, database=self.database)
                connection.execute("ROLLBACK TO stale_cursor")
                connection.execute("RELEASE stale_cursor")
        self.assertEqual(self.events.replay(SESSION_ID), (original,))

    def test_inspection_rejects_duplicate_identity_between_blocks(self) -> None:
        first = self.append("first-key", kind="message_delta")
        for attribute, error in (("event_id", "id"), ("idempotency_key", "idempotency key")):
            with self.subTest(attribute=attribute), self.events.transaction() as connection:
                connection.execute("SAVEPOINT corrupt_fixture")
                corrupt = {name: getattr(first, name) for name in first.__dataclass_fields__}
                corrupt.update(
                    event_id=2,
                    product_seq=2,
                    idempotency_key="second-key",
                    payload=json.dumps(first.payload),
                )
                corrupt[attribute] = getattr(first, attribute)
                # Manufacture otherwise valid durable bytes with an invalid
                # cross-block identity, bypassing writer key admission only.
                with (
                    patch.object(blocks, "MAX_EVENTS", 1),
                    patch.object(blocks.BlockStore, "by_key", return_value=None),
                    blocks.BlockStore(connection, self.database) as store,
                ):
                    store.append(corrupt)
                connection.execute("UPDATE sqlite_sequence SET seq=2 WHERE name='product_event'")
                connection.execute(
                    "UPDATE session_catalog SET last_product_seq=2 WHERE session_id=?",
                    (SESSION_ID,),
                )
                with self.assertRaisesRegex(ValueError, "duplicate logical event " + error):
                    self.events.inspect_rows(connection, database=self.database)
                connection.execute("ROLLBACK TO corrupt_fixture")
                connection.execute("RELEASE corrupt_fixture")
        self.assertEqual(self.events.replay(SESSION_ID), (first,))

    def test_block_migration_delete_failure_is_atomic_even_if_caller_commits(self) -> None:
        expected = [self.append(f"migration-delete-{index}") for index in range(3)]
        expected = [replace(record, kind="message_delta") for record in expected]
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET kind='message_delta'")
            connection.execute(
                "CREATE TRIGGER refuse_second_event_delete BEFORE DELETE ON product_event WHEN OLD.product_seq=2 BEGIN SELECT RAISE(ABORT,'injected delete failure'); END"
            )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "injected delete failure"):
                self.events.migrate_blocks(connection, self.database)
            # Explicitly finish the surrounding transaction after the caught
            # failure: a published block must not escape its failed migration.
            connection.execute("DROP TRIGGER refuse_second_event_delete")
        reopened = ProductEventStore(self.database)
        self.assertEqual(list(reopened.replay(SESSION_ID)), expected)
        with reopened.transaction() as connection:
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM product_event").fetchone()[0], 3
            )
            self.assertEqual(
                connection.execute(f"SELECT COUNT(*) FROM {blocks.TABLE}").fetchone()[0], 0
            )
            self.assertEqual(reopened.migrate_blocks(connection, self.database), 3)
            reopened.inspect_rows(connection, database=self.database)
        self.assertEqual(list(ProductEventStore(self.database).replay(SESSION_ID)), expected)

    def test_block_migration_range_readback_checks_every_envelope_field_and_missing_rows(
        self,
    ) -> None:
        originals = [self.append(f"range-check-{index}") for index in range(3)]
        expected = [replace(record, kind="message_delta") for record in originals]
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET kind='message_delta'")
        normal_rows = blocks.BlockStore.rows

        def altered_rows(field: str, value: Any):
            def readback(store, *args, **kwargs):
                with closing(normal_rows(store, *args, **kwargs)) as rows:
                    for row in rows:
                        if row["product_seq"] == expected[1].product_seq:
                            if field == "missing":
                                continue
                            yield {**row, field: value}
                        else:
                            yield row

            return readback

        changes = {
            "event_id": 1000,
            "session_id": "wrong-session",
            "runtime_id": "wrong-runtime",
            "vendor_thread_id": "wrong-thread",
            "vendor_turn_id": "wrong-turn",
            "vendor_item_id": "wrong-item",
            "kind": "reasoning_delta",
            "payload": "{}",
            "schema_version": 999,
            "product_seq": 1000,
            "idempotency_key": "wrong-key",
            "created_at": -1000.0,
            "missing": None,
        }
        for field, value in changes.items():
            with self.subTest(field=field), self.events.transaction() as connection:
                with patch.object(blocks.BlockStore, "rows", altered_rows(field, value)):
                    with self.assertRaisesRegex(ValueError, "event block publication"):
                        self.events.migrate_blocks(connection, self.database, limit=2)
            self.assertEqual(list(ProductEventStore(self.database).replay(SESSION_ID)), expected)
        calls = []

        def recording_rows(store, *args, **kwargs):
            calls.append(kwargs)
            yield from normal_rows(store, *args, **kwargs)

        with self.events.transaction() as connection:
            self.assertEqual(self.events.migrate_blocks(connection, self.database, limit=1), 1)
        with (
            self.events.transaction() as connection,
            patch.object(blocks.BlockStore, "rows", recording_rows),
        ):
            self.assertEqual(self.events.migrate_blocks(connection, self.database, limit=2), 2)
        self.assertEqual(calls, [{"session_id": SESSION_ID, "after_seq": 1}])
        self.assertEqual(list(ProductEventStore(self.database).replay(SESSION_ID)), expected)

    def test_block_migration_selection_does_not_sort_remaining_history(self) -> None:
        expected = [self.append(f"plan-{index}") for index in range(24)]
        expected = [replace(record, kind="message_delta") for record in expected]
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET kind='message_delta'")
            statements: list[str] = []
            connection.set_trace_callback(statements.append)
            try:
                self.assertEqual(self.events.migrate_blocks(connection, self.database, limit=3), 3)
            finally:
                connection.set_trace_callback(None)
            selections = [
                statement
                for statement in statements
                if statement.startswith("SELECT * FROM product_event ")
                and "ORDER BY event_id LIMIT" in statement
            ]
            self.assertEqual(len(selections), 1)
            plan = connection.execute("EXPLAIN QUERY PLAN " + selections[0]).fetchall()
            details = " ".join(str(row[3]) for row in plan)
            self.assertNotIn("TEMP B-TREE", details)
            self.assertNotIn("idx_product_event_kind_recent", details)
        self.assertEqual(list(self.events.replay(SESSION_ID)), expected)

    def test_journal_history_preserves_every_cursor_and_idempotent_record(self) -> None:
        expected = [
            self.append(f"piece-{index}-正文", kind="reasoning_delta")
            for index in range(MIGRATION_BATCH_EVENTS + 7)
        ]
        reopened = ProductEventStore(self.database)
        self.assertEqual(list(reopened.replay(SESSION_ID)), expected)
        for cursor in (0, 1, MIGRATION_BATCH_EVENTS - 1, MIGRATION_BATCH_EVENTS):
            self.assertEqual(
                list(reopened.replay(SESSION_ID, after_seq=cursor, limit=9)),
                expected[cursor : cursor + 9],
            )
        anchor = expected[MIGRATION_BATCH_EVENTS // 2]
        self.assertEqual(reopened.by_sequence(SESSION_ID, anchor.product_seq), anchor)
        self.assertEqual(reopened.by_key(SESSION_ID, anchor.idempotency_key), anchor)
        self.assertEqual(self.append(anchor.idempotency_key, kind=anchor.kind), anchor)
        with reopened.transaction() as connection:
            self.assertEqual(
                reopened.turn_kind_usage(
                    SESSION_ID, "turn-1", "reasoning_delta", connection=connection
                )[1],
                sum(
                    len(
                        json.dumps(
                            record.payload, ensure_ascii=False, separators=(",", ":")
                        ).encode()
                    )
                    for record in expected
                ),
            )
            reopened.inspect_rows(connection, database=self.database)
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM product_event WHERE payload='{}' AND payload_ref IS NOT NULL"
                ).fetchone()[0],
                0,
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='idx_product_event_replay'"
                ).fetchone()
            )

    def _inline_events(self) -> None:
        """Represent already persisted records in the supported legacy inline format."""
        with self.events.transaction() as connection:
            materialized = tuple(
                self.events._materialize(
                    connection,
                    connection.execute("SELECT * FROM product_event"),
                    database=self.database,
                )
            )
            connection.executemany(
                "UPDATE product_event SET payload=?,payload_ref=NULL,payload_bytes=NULL,client_turn_id=NULL WHERE event_id=?",
                ((row["payload"], row["event_id"]) for row in materialized),
            )

    def test_scheduled_migration_is_bounded_preserves_history_and_rolls_back(self) -> None:
        expected = [self.append(f"legacy-{index}") for index in range(9)]
        self._inline_events()
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with self.events.transaction() as connection:
                self.assertEqual(self.events.migrate_bodies(connection, self.database, limit=3), 3)
                raise RuntimeError("abort")
        with self.events.transaction() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM product_event WHERE payload_ref IS NULL"
                ).fetchone()[0],
                len(expected),
            )
        self.assertEqual(list(self.events.replay(SESSION_ID)), expected)
        counts = []
        while True:
            with self.events.transaction() as connection:
                count = self.events.migrate_bodies(connection, self.database, limit=3)
                counts.append(count)
            if not count:
                break
        self.assertEqual(counts, [3, 3, 3, 0])
        self.assertEqual(list(ProductEventStore(self.database).replay(SESSION_ID)), expected)
        self.assertEqual(self.append("after-migration").product_seq, len(expected) + 1)
        invalid_limits: tuple[Any, ...] = (0, -1, True, 1.5)
        for limit in invalid_limits:
            with self.events.transaction() as connection:
                with self.assertRaisesRegex(ValueError, "positive"):
                    self.events.migrate_bodies(connection, self.database, limit=limit)

    def test_schema_initialization_never_scans_migrates_or_reclaims_bodies(self) -> None:
        expected = self.append("legacy-unscanned")
        self._inline_events()
        with self.events.transaction() as connection:
            connection.execute(
                "CREATE INDEX idx_product_event_replay ON product_event(session_id,product_seq)"
            )
        with (
            patch.object(
                ProductEventStore,
                "migrate_bodies",
                side_effect=AssertionError("body migration at startup"),
            ),
            patch.object(
                ProductEventStore,
                "_reclaim_needed",
                side_effect=AssertionError("vacuum scan at startup"),
            ),
            patch.object(
                journal.Journal, "get", side_effect=AssertionError("body read at startup")
            ),
        ):
            reopened = ProductEventStore(self.database)
            self.assertFalse(reopened.inspect_schema(self.database).needs_write)
        self.assertEqual(reopened.replay(SESSION_ID), (expected,))
        with reopened.transaction() as connection:
            self.assertIsNone(
                connection.execute("SELECT payload_ref FROM product_event").fetchone()[0]
            )

    def test_qualified_projection_reads_original_bodies_without_writes(self) -> None:
        expected = self.append("qualified-source")
        with self.events.transaction() as connection:
            path = journal.Journal(connection, self.database).path
        before = path.read_bytes()
        with (
            closing(sqlite3.connect(self.database)) as source,
            closing(sqlite3.connect(":memory:")) as projected,
        ):
            projected.row_factory = sqlite3.Row
            source.backup(projected)
            projected.execute("PRAGMA query_only=ON")
            ProductEventStore.inspect_rows(projected, database=self.database)
            with self.assertRaisesRegex(ValueError, "qualified database"):
                ProductEventStore.inspect_rows(projected)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.events.replay(SESSION_ID), (expected,))

    def test_duplicate_missing_and_corrupt_journal_bodies_fail_closed(self) -> None:
        self.append("integrity-body")
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET payload='duplicate'")
        with self.assertRaisesRegex(ValueError, "duplicate authoritative"):
            self.events.replay(SESSION_ID)
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET payload='{}',payload_bytes=0")
        with self.assertRaisesRegex(ValueError, "length"):
            self.events.replay(SESSION_ID)
        with self.events.transaction() as connection:
            connection.execute("UPDATE product_event SET payload_ref='missing'")
        with self.assertRaisesRegex(ValueError, "reference"):
            self.events.replay(SESSION_ID)

    def test_existing_rows_migrate_without_changing_history_or_cursor(self) -> None:
        expected = [self.append("old-piece-" + str(index)) for index in range(30)]
        self._inline_events()
        with self.events.transaction() as connection:
            connection.execute(
                "CREATE INDEX idx_product_event_replay ON product_event(session_id,product_seq)"
            )
        reopened = ProductEventStore(self.database)
        with reopened.transaction() as connection:
            self.assertEqual(reopened.migrate_bodies(connection, self.database), len(expected))
            reopened.inspect_rows(connection, database=self.database)
            plans = connection.execute(
                "EXPLAIN QUERY PLAN SELECT * FROM product_event WHERE session_id=? AND product_seq>? ORDER BY product_seq LIMIT 9",
                (SESSION_ID, 10),
            ).fetchall()
            self.assertTrue(any("sqlite_autoindex_product_event_1" in row[3] for row in plans))
        self.assertEqual(list(reopened.replay(SESSION_ID)), expected)
        self.assertEqual(reopened.by_key(SESSION_ID, expected[5].idempotency_key), expected[5])
        self.assertEqual(self.append("after-migration").product_seq, len(expected) + 1)

    def test_scheduled_reclaim_interrupt_preserves_rows_and_retries(self) -> None:
        expected = self.append("retained-history")
        with self.events.transaction() as connection:
            connection.execute("CREATE TABLE retained_padding(id INTEGER PRIMARY KEY, data BLOB)")
            connection.executemany(
                "INSERT INTO retained_padding VALUES(?,?)",
                ((index, b"x" * 4096) for index in range(400)),
            )
            connection.execute("DELETE FROM retained_padding WHERE id%2=0")
        with closing(self.events._connect()) as connection:
            connection.execute("PRAGMA query_only=ON")
            before = rows_digest(connection, deadline=time.monotonic() + 30)
        vacuum_started = []
        original_connect = ProductEventStore._connect

        def connect_with_trace(store):
            connection = original_connect(store)
            connection.set_trace_callback(
                lambda sql: vacuum_started.append(sql) if sql == "VACUUM" else None
            )
            return connection

        with (
            patch.object(event_storage, "RECLAIM_MIN_BYTES", 1),
            patch.object(ProductEventStore, "_connect", connect_with_trace),
            patch.object(
                event_storage.time, "monotonic", side_effect=lambda: 2.0 if vacuum_started else 0.0
            ),
        ):
            self.assertFalse(self.events.reclaim(self.database, deadline=1.0))
        self.assertEqual(vacuum_started, ["VACUUM"])
        with closing(self.events._connect()) as connection:
            connection.execute("PRAGMA query_only=ON")
            self.assertEqual(rows_digest(connection, deadline=time.monotonic() + 30), before)
        self.assertEqual(self.events.replay(SESSION_ID), (expected,))
        with patch.object(event_storage, "RECLAIM_MIN_BYTES", 1):
            self.assertTrue(self.events.reclaim(self.database, deadline=time.monotonic() + 30))
        with closing(self.events._connect()) as connection:
            connection.execute("PRAGMA query_only=ON")
            self.assertEqual(rows_digest(connection, deadline=time.monotonic() + 30), before)
        self.assertEqual(ProductEventStore(self.database).replay(SESSION_ID), (expected,))

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
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET schema_version = ? WHERE event_id = ?",
                (PRODUCT_EVENT_VERSION_V1, first.event_id),
            )

        persisted = ProductEventStore(self.database).replay(SESSION_ID)[0]
        upgraded = upcast_product_event(persisted)

        self.assertEqual(persisted.schema_version, PRODUCT_EVENT_VERSION_V1)
        self.assertEqual(upgraded.schema_version, PRODUCT_EVENT_VERSION)
        self.assertEqual(upgraded.payload, persisted.payload)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            stored = connection.execute(
                f"SELECT schema_version FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?",
                (first.event_id,),
            ).fetchone()
        self.assertEqual(stored, (PRODUCT_EVENT_VERSION_V1,))

    def test_unknown_event_schema_fails_closed(self) -> None:
        event = self.append("future-event")
        with self.assertRaises(ProductEventSchemaError):
            upcast_product_event(event.__class__(**{**event.__dict__, "schema_version": 999}))

    def test_persisted_versions_are_not_coerced_or_acknowledged_as_idempotent(self) -> None:
        event = self.append("invalid-schema")
        for value in (1.5, 2.5, -1, 999, "future", b"2"):
            with closing(sqlite3.connect(self.database)) as connection, connection:
                connection.execute(
                    f"UPDATE {PRODUCT_EVENT_TABLE} SET schema_version = ? WHERE event_id = ?",
                    (value, event.event_id),
                )
                before = connection.execute(f"SELECT * FROM {PRODUCT_EVENT_TABLE}").fetchall()
                sequence = connection.execute(
                    f"SELECT last_product_seq FROM {SESSION_CATALOG_TABLE}"
                ).fetchall()
            for label, operation in (
                ("inspection", lambda: ProductEventStore.inspect_schema(self.database)),
                ("initialization", lambda: ProductEventStore(self.database)),
                ("replay", lambda: self.events.replay(SESSION_ID)),
                ("idempotency", lambda: self.append("invalid-schema")),
            ):
                with self.subTest(value=value, operation=label):
                    with self.assertRaises(ProductEventSchemaError):
                        operation()
            with closing(sqlite3.connect(self.database)) as connection:
                self.assertEqual(
                    connection.execute(f"SELECT * FROM {PRODUCT_EVENT_TABLE}").fetchall(), before
                )
                self.assertEqual(
                    connection.execute(
                        f"SELECT last_product_seq FROM {SESSION_CATALOG_TABLE}"
                    ).fetchall(),
                    sequence,
                )

    def test_upcast_requires_integer_source_and_target_versions(self) -> None:
        event = self.append("strict-schema")
        for version in (True, 1.0, 2.0, "2", b"2", None):
            with self.subTest(source=version):
                with self.assertRaises(ProductEventSchemaError):
                    upcast_product_event(replace(event, schema_version=version))
        for target in (True, 2.0, "2", None):
            with self.subTest(target=target):
                with self.assertRaises(ProductEventSchemaError):
                    upcast_product_event(event, target_version=target)

    def test_reused_idempotency_key_with_different_payload_is_rejected(self) -> None:
        self.append("event-1")
        with self.assertRaises(SessionStateConflictError):
            self.events.append(
                session_id=SESSION_ID,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=VENDOR_THREAD_ID,
                vendor_turn_id="turn-1",
                vendor_item_id="item-1",
                kind="tool_completed",
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

    def test_current_initialization_does_not_open_write_connection(self) -> None:
        with patch.object(
            ProductEventStore,
            "_connect",
            side_effect=AssertionError("current format opened writer"),
        ):
            ProductEventStore(self.database)

    def test_current_unknown_column_is_rejected_without_changes(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {PRODUCT_EVENT_TABLE} ADD COLUMN future_data TEXT")
            before = tuple(connection.iterdump())
        with self.assertRaises(RuntimeError):
            ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_missing_inspection_does_not_create_paths(self) -> None:
        path = self.database.parent / "absent" / "events.sqlite3"
        schema = ProductEventStore.inspect_schema(path)
        self.assertTrue(schema.needs_write)
        self.assertFalse(path.parent.exists())

    def test_inspection_records_supported_event_versions_without_rewriting(self) -> None:
        self.assertEqual(ProductEventStore.inspect_schema(self.database).versions, ())
        first = self.append("historical-version")
        self.append("current-version")
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET schema_version = ? WHERE event_id = ?",
                (PRODUCT_EVENT_VERSION_V1, first.event_id),
            )
            before = tuple(connection.iterdump())
        schema = ProductEventStore.inspect_schema(self.database)
        self.assertEqual(schema.versions, (PRODUCT_EVENT_VERSION_V1, PRODUCT_EVENT_VERSION))
        self.assertFalse(schema.needs_write)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_wal_future_event_prevents_index_repair_without_writing(self) -> None:
        event = self.append("future-wal-version")
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(f"DROP INDEX idx_{PRODUCT_EVENT_TABLE}_kind_recent")
            writer.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET schema_version = ? WHERE event_id = ?",
                (999, event.event_id),
            )
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            for operation in (
                lambda: ProductEventStore.inspect_schema(self.database),
                lambda: ProductEventStore(self.database),
            ):
                with self.assertRaises(ProductEventSchemaError):
                    operation()
                self.assertEqual(before, (self.database.read_bytes(), wal.read_bytes()))
            self.assertIsNone(
                writer.execute(
                    "SELECT name FROM sqlite_master WHERE name=?",
                    (f"idx_{PRODUCT_EVENT_TABLE}_kind_recent",),
                ).fetchone()
            )

    def test_wal_missing_column_and_index_are_classified_without_writing(self) -> None:
        original = self.append("wal-event")
        with closing(sqlite3.connect(self.database)) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(f"ALTER TABLE {PRODUCT_EVENT_TABLE} DROP COLUMN schema_version")
            writer.execute(f"DROP INDEX idx_{PRODUCT_EVENT_TABLE}_kind_recent")
            writer.commit()
            wal = Path(str(self.database) + "-wal")
            before = self.database.read_bytes(), wal.read_bytes()
            schema = ProductEventStore.inspect_schema(self.database)
            self.assertTrue(schema.add_schema_version)
            self.assertEqual(schema.versions, (PRODUCT_EVENT_VERSION_V1,))
            self.assertFalse(schema.repair_foreign_key)
            self.assertEqual(schema.create_indexes, (f"idx_{PRODUCT_EVENT_TABLE}_kind_recent",))
            self.assertEqual(before, (self.database.read_bytes(), wal.read_bytes()))
            restored = ProductEventStore(self.database).replay(SESSION_ID)[0]
            self.assertEqual(restored.payload, original.payload)
            self.assertEqual(restored.schema_version, PRODUCT_EVENT_VERSION_V1)
            self.assertFalse(ProductEventStore.inspect_schema(self.database).needs_write)

    def test_completed_repair_is_rolled_back_when_index_creation_fails(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
        create_indexes = ProductEventStore._create_indexes
        exercised = []

        def fail_after_indexes(connection):
            create_indexes(connection)
            if connection.execute("PRAGMA database_list").fetchone()[2]:
                exercised.append(
                    connection.execute(
                        f"PRAGMA foreign_key_list({PRODUCT_EVENT_TABLE})"
                    ).fetchone()[2]
                )
                raise OSError("injected after real repair")

        with patch.object(ProductEventStore, "_create_indexes", side_effect=fail_after_indexes):
            with self.assertRaisesRegex(OSError, "after real repair"):
                ProductEventStore(self.database)
        self.assertEqual(exercised, [SESSION_CATALOG_TABLE])
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_unknown_constraints_and_targets_are_rejected_without_write_connection(self) -> None:
        self.append("preserved")
        for name, old, new in (
            ("check", "payload TEXT NOT NULL", "payload TEXT NOT NULL CHECK(length(payload)>0)"),
            ("target", "REFERENCES session_catalog", "REFERENCES unknown_catalog"),
            ("unique", "UNIQUE(session_id, product_seq),", ""),
        ):
            with self.subTest(name=name):
                database = self.database.parent / (name + ".sqlite3")
                with (
                    closing(sqlite3.connect(self.database)) as source,
                    closing(sqlite3.connect(database)) as connection,
                ):
                    source.backup(connection)
                    definition = connection.execute(
                        "SELECT sql FROM sqlite_master WHERE name=?", (PRODUCT_EVENT_TABLE,)
                    ).fetchone()[0]
                    self.assertIn(old, definition)
                    connection.execute(
                        f"ALTER TABLE {PRODUCT_EVENT_TABLE} RENAME TO original_event"
                    )
                    connection.execute(definition.replace(old, new))
                    connection.execute(
                        f"INSERT INTO {PRODUCT_EVENT_TABLE} SELECT * FROM original_event"
                    )
                    connection.execute("DROP TABLE original_event")
                    connection.commit()
                    before = tuple(connection.iterdump())
                with patch.object(
                    ProductEventStore, "_connect", side_effect=AssertionError("opened writer")
                ):
                    with self.assertRaises(RuntimeError):
                        ProductEventStore(database)
                with closing(sqlite3.connect(database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def _legacy_event_table(self, *, nullable_payload: bool = False) -> None:
        self.append("event-before-repair")
        self._inline_events()
        payload_constraint = "" if nullable_payload else "NOT NULL"
        with closing(sqlite3.connect(self.database)) as connection, connection:
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
                    payload TEXT {payload_constraint},
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

    def test_initialization_repairs_event_foreign_key_after_catalog_rebuild(self) -> None:
        self._legacy_event_table()
        repaired = ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
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

    def test_unknown_nullable_payload_is_rejected_before_repair(self) -> None:
        self._legacy_event_table(nullable_payload=True)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"UPDATE {PRODUCT_EVENT_TABLE} SET payload = NULL")
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())

        for attempt in range(2):
            with self.subTest(attempt=attempt):
                with self.assertRaises(RuntimeError):
                    ProductEventStore(self.database)
                with closing(sqlite3.connect(self.database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)

    def test_owned_index_view_is_rejected_before_repair(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"CREATE VIEW idx_{PRODUCT_EVENT_TABLE}_replay AS "
                f"SELECT event_id FROM {PRODUCT_EVENT_TABLE}"
            )
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
        with self.assertRaises(RuntimeError):
            ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_repair_does_not_disable_foreign_keys_for_event_writers(self) -> None:
        self._legacy_event_table()
        repaired = ProductEventStore(self.database)
        with closing(repaired._connect()) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    f"UPDATE {PRODUCT_EVENT_TABLE} SET session_id = ?", ("missing-session",)
                )
        self.assertEqual(len(repaired.replay(SESSION_ID)), 1)

    def test_repair_preserves_child_references_indexes_and_triggers(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"CREATE TABLE event_child (event INTEGER REFERENCES {PRODUCT_EVENT_TABLE}(event_id), data TEXT)"
            )
            connection.execute(
                f"INSERT INTO event_child SELECT event_id, 'user draft' FROM {PRODUCT_EVENT_TABLE}"
            )
            connection.execute(f"CREATE INDEX event_kind_index ON {PRODUCT_EVENT_TABLE}(kind)")
            connection.execute("CREATE TABLE event_audit (event INTEGER)")
            connection.execute(
                f"CREATE TRIGGER event_audit_trigger AFTER UPDATE ON {PRODUCT_EVENT_TABLE} "
                "BEGIN INSERT INTO event_audit VALUES (new.event_id); END"
            )
            before_child = connection.execute("SELECT * FROM event_child").fetchall()
            before_dependents = connection.execute(
                "SELECT name, sql FROM sqlite_master WHERE name IN (?, ?) ORDER BY name",
                ("event_kind_index", "event_audit_trigger"),
            ).fetchall()
        ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection, connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute("SELECT * FROM event_child").fetchall(), before_child
            )
            self.assertEqual(
                connection.execute(
                    "SELECT name, sql FROM sqlite_master WHERE name IN (?, ?) ORDER BY name",
                    ("event_kind_index", "event_audit_trigger"),
                ).fetchall(),
                before_dependents,
            )
            connection.execute(f"UPDATE {PRODUCT_EVENT_TABLE} SET kind = 'updated'")
            self.assertEqual(
                connection.execute("SELECT * FROM event_audit").fetchall(),
                [(before_child[0][0],)],
            )

    def test_repair_rejects_unknown_columns_without_losing_values(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(f"ALTER TABLE {PRODUCT_EVENT_TABLE} ADD COLUMN future_data BLOB")
            connection.execute(
                f"UPDATE {PRODUCT_EVENT_TABLE} SET future_data = ?", (b"future user value",)
            )
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
        with self.assertRaises(RuntimeError):
            ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_repair_rejects_generated_columns_without_losing_schema(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"ALTER TABLE {PRODUCT_EVENT_TABLE} ADD COLUMN future_data INTEGER "
                "GENERATED ALWAYS AS (event_id * 2) VIRTUAL"
            )
        with closing(sqlite3.connect(self.database)) as connection:
            before = tuple(connection.iterdump())
        with self.assertRaisesRegex(RuntimeError, "generated"):
            ProductEventStore(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(tuple(connection.iterdump()), before)

    def test_existing_repair_residue_is_preserved_even_with_healthy_current_table(self) -> None:
        self.append("healthy-current")
        for residue in (
            PRODUCT_EVENT_MIGRATION_TABLE,
            PRODUCT_EVENT_TABLE + "_schema_rebuild",
            PRODUCT_EVENT_TABLE + "_foreign_key_migration",
        ):
            with self.subTest(residue=residue):
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.execute(f"CREATE TABLE {residue} (data BLOB)")
                    connection.execute(f"INSERT INTO {residue} VALUES (?)", (b"unrecovered",))
                with closing(sqlite3.connect(self.database)) as connection:
                    before = tuple(connection.iterdump())
                with self.assertRaisesRegex(RuntimeError, "recovery required"):
                    ProductEventStore(self.database)
                with closing(sqlite3.connect(self.database)) as connection:
                    self.assertEqual(tuple(connection.iterdump()), before)
                with closing(sqlite3.connect(self.database)) as connection, connection:
                    connection.execute(f"DROP TABLE {residue}")

    def test_repair_preserves_deleted_event_autoincrement_high_water_mark(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.execute(
                f"INSERT INTO {PRODUCT_EVENT_TABLE} "
                "SELECT event_id + 1, session_id, runtime_id, vendor_thread_id, vendor_turn_id, "
                "vendor_item_id, kind, payload, product_seq + 1, 'deleted-event', created_at "
                f"FROM {PRODUCT_EVENT_TABLE}"
            )
            deleted_id = connection.execute(
                f"SELECT MAX(event_id) FROM {PRODUCT_EVENT_TABLE}"
            ).fetchone()[0]
            connection.execute(
                f"DELETE FROM {PRODUCT_EVENT_TABLE} WHERE event_id = ?", (deleted_id,)
            )
        self.events = ProductEventStore(self.database)
        self.assertGreater(self.append("event-after-repair").event_id, deleted_id)

    def test_repair_preserves_autoincrement_when_all_events_were_deleted(self) -> None:
        self._legacy_event_table()
        with closing(sqlite3.connect(self.database)) as connection, connection:
            deleted_id = connection.execute(
                f"SELECT MAX(event_id) FROM {PRODUCT_EVENT_TABLE}"
            ).fetchone()[0]
            connection.execute(f"DELETE FROM {PRODUCT_EVENT_TABLE}")
        self.events = ProductEventStore(self.database)
        self.assertGreater(self.append("first-after-empty-repair").event_id, deleted_id)


class LockedPublicationContract(unittest.IsolatedAsyncioTestCase):
    async def test_lock_release_preserves_accepted_append_and_event_loop(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "sessions.sqlite3"
            register_session(database)
            events = ProductEventStore(database)
            worker = PersistenceWorker()
            attempted = threading.Event()
            original_connect = events._connect

            def connect() -> sqlite3.Connection:
                connection = original_connect()
                connection.execute("PRAGMA busy_timeout=0")
                attempted.set()
                return connection

            blocker = sqlite3.connect(database)
            blocker.execute("BEGIN IMMEDIATE")
            with patch.object(events, "_connect", side_effect=connect):
                task = asyncio.create_task(
                    worker.run(
                        events.append,
                        session_id=SESSION_ID,
                        runtime_id=RUNTIME_ID,
                        vendor_thread_id=VENDOR_THREAD_ID,
                        vendor_turn_id="locked-turn",
                        vendor_item_id=None,
                        kind="tool_completed",
                        payload={"ok": True},
                        idempotency_key="locked-event",
                    )
                )
                try:
                    self.assertTrue(await asyncio.to_thread(attempted.wait, 2))
                    await asyncio.sleep(0.05)
                    self.assertFalse(task.done(), "lock contention must preserve the append")
                    blocker.rollback()
                    record = await asyncio.wait_for(task, 2)
                    self.assertEqual(record.product_seq, 1)
                    self.assertEqual(len(events.replay(SESSION_ID)), 1)
                finally:
                    blocker.rollback()
                    blocker.close()
                    await asyncio.gather(task, return_exceptions=True)
                    await worker.close()


if __name__ == "__main__":
    unittest.main()
