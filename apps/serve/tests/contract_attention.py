from __future__ import annotations

import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import DeliveryClass, RuntimeEvent, RuntimeEventKind
from service.chat.api.attention import mount_attention_routes
from service.chat.constants import (
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_USER_MESSAGE,
)
from service.chat.persistence.artifacts import SessionArtifactStore
from service.chat.persistence.attention import AttentionStore
from service.chat.persistence.catalog import HilStatus, SessionCatalogStore, SessionPrincipal
from service.chat.persistence.events import ProductEventStore
from service.chat.service.attention import AttentionService
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities
from tests.contract_product_events import (
    OWNER,
    RUNTIME_ID,
    SESSION_ID,
    VENDOR_THREAD_ID,
    register_session,
)


class AttentionContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name).resolve() / "catalog.sqlite3"
        self.catalog = register_session(self.database)
        self.events = ProductEventStore(self.database)
        self.attention = AttentionStore(self.catalog)

    def emit(
        self, kind: str, key: str, turn: str = "turn-1", item: str | None = None, **payload: object
    ) -> None:
        self.events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=turn,
            vendor_item_id=item,
            kind=kind,
            payload=dict(payload),
            idempotency_key=key,
        )

    def test_distinct_requests_and_rounds_are_counted_once(self) -> None:
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request-1", request_id="one")
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request-1", request_id="one")
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request-2", request_id="two")
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-1")
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-2", turn="turn-2")
        snapshot = self.attention.snapshot(OWNER)
        self.assertEqual(snapshot["unread_count"], 4)
        self.assertEqual(snapshot["by_session"], {SESSION_ID: 4})

    def test_independent_card_does_not_create_waiting_attention(self) -> None:
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "offer-1", request_id="offer", blocking=False)
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-1")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)

    def test_read_all_preserves_concurrent_new_reminders_and_survives_reopen(self) -> None:
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request-1", request_id="one")
        snapshot = self.attention.snapshot(OWNER)
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-1")
        self.attention.read(OWNER, through_revision=snapshot["revision"])
        reopened = AttentionStore(self.catalog).snapshot(OWNER)
        self.assertEqual(reopened["unread_count"], 1)
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request-1", request_id="one")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)

    def test_waiting_summaries_use_specific_browser_and_permission_content(self) -> None:
        cases = (
            (
                {"intent": "Search local browser history", "title": "Approval"},
                "Search local browser history",
            ),
            (
                {"body": "Read research files token=secret", "title": "Permission request"},
                "Read research files [redacted]",
            ),
            (
                {
                    "body": "Confirm data source",
                    "method": "mcpServer/elicitation/request",
                    "title": "Input",
                },
                "Confirm data source",
            ),
            (
                {
                    "body": "item/fileChange/requestApproval",
                    "method": "item/fileChange/requestApproval",
                    "path": "/research/report.md",
                    "title": "Permission",
                },
                "/research/report.md",
            ),
            ({"prompt": "Choose the candidate papers"}, "Choose the candidate papers"),
        )
        for index, (payload, expected) in enumerate(cases):
            with self.subTest(payload=payload):
                self.emit(
                    PRODUCT_EVENT_HIL_REQUESTED,
                    f"summary-{index}",
                    request_id=f"summary-{index}",
                    **payload,
                )
                self.assertEqual(self.attention.snapshot(OWNER)["items"][-1]["body"], expected)

    def test_only_definitive_failures_and_completed_rounds_create_terminal_items(self) -> None:
        self.emit(PRODUCT_EVENT_TURN_UNKNOWN, "unknown")
        self.emit(PRODUCT_EVENT_TURN_INTERRUPTED, "interrupt", turn="turn-2")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)
        self.emit(
            PRODUCT_EVENT_TURN_FAILED, "failure", message="Service unavailable", retryable=True
        )
        self.emit(
            PRODUCT_EVENT_TURN_FAILED,
            "failure-replay",
            message="Service unavailable",
            retryable=True,
        )
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "contradictory-terminal")
        snapshot = self.attention.snapshot(OWNER)
        self.assertEqual(snapshot["unread_count"], 1)
        self.assertEqual(snapshot["items"][0]["kind"], "failed")
        self.assertEqual(snapshot["items"][0]["body"], "Service unavailable")

    def test_recovery_blockage_does_not_consume_later_completion_slot(self) -> None:
        self.emit(PRODUCT_EVENT_SESSION_STATE, "ordinary-failed", state="failed")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)
        payload = {
            "state": "failed",
            "recovery_blocked": True,
            "recovery_pending": True,
            "incident_id": "incident",
            "reason": "Recovery unavailable",
        }
        self.emit(PRODUCT_EVENT_SESSION_STATE, "blocked", **payload)
        self.emit(PRODUCT_EVENT_SESSION_STATE, "blocked-replay", **payload)
        reminder = self.attention.snapshot(OWNER)["items"][0]
        self.assertEqual(reminder["anchor_kind"], "recovery")
        self.assertEqual(reminder["incident_id"], "incident")
        self.assertEqual(reminder["source_seq"], 2)
        self.assertEqual(
            self.events.recovery_snapshot(SESSION_ID, "turn-1"),
            {"recovery_incident_id": "incident", "recovery_source_seq": 3},
        )
        sessions = Mock(spec=SessionService)
        sessions.navigation.return_value = ({"session_id": SESSION_ID}, 200)
        service = AttentionService(self.attention, self.catalog, self.events, sessions)
        self.assertEqual(service.navigation(reminder["id"], OWNER)[0]["focus"]["kind"], "recovery")
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "recovered")
        self.assertEqual(service.navigation(reminder["id"], OWNER)[0]["focus"]["kind"], "completed")
        snapshot = self.attention.snapshot(OWNER)
        self.assertEqual([item["kind"] for item in snapshot["items"]], ["failed", "completed"])
        self.assertEqual(snapshot["items"][0]["body"], "Recovery unavailable")

    def test_detached_history_returns_only_recovery_card_watermark(self) -> None:
        self.emit(
            PRODUCT_EVENT_SESSION_STATE,
            "blocked",
            state="failed",
            recovery_blocked=True,
            recovery_pending=True,
            incident_id="recovery-incident",
        )
        event = RuntimeEvent(
            schema_version=1,
            event_id="settlement",
            runtime_id=RUNTIME_ID,
            product_session_id=SESSION_ID,
            native_session_id=VENDOR_THREAD_ID,
            process_generation=1,
            sequence=1,
            kind=RuntimeEventKind.TURN_COMPLETED,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="fixture",
            native_turn_id="turn-1",
            correlation_id="client-turn",
            payload={"status": "completed"},
        )
        self.catalog.record_turn_settlement(SESSION_ID, "client-turn", event)
        self.catalog.mark_turn_recovery_blocked(SESSION_ID, True)
        service = SessionService(
            self.database.parent,
            {},
            activities=Activities(),
            access=self.catalog,
            events=self.events,
            runtime=Mock(),
            workspaces=Mock(),
            artifacts=SessionArtifactStore(self.database),
            settings=Mock(),
            credentials=Mock(),
            logger=Mock(),
        )
        history = service.history(SESSION_ID)
        self.assertTrue(history["recovery_blocked"])
        self.assertEqual(history["recovery_incident_id"], "recovery-incident")
        self.assertEqual(history["recovery_source_seq"], 1)
        self.assertNotIn("last_seq", history)

    def test_completed_summary_and_anchor_read_committed_message_blocks(self) -> None:
        self.emit(PRODUCT_EVENT_MESSAGE_DELTA, "message-1", item="answer", delta="Old draft")
        self.emit(
            PRODUCT_EVENT_MESSAGE_DELTA,
            "message-2",
            item="answer",
            delta="Final result",
            phase="final_answer",
        )
        self.emit(
            PRODUCT_EVENT_MESSAGE_DELTA,
            "commentary",
            item="commentary",
            delta="Not final",
            phase="commentary",
        )
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-1")
        reminder = self.attention.snapshot(OWNER)["items"][0]
        self.assertEqual(reminder["body"], "Final result")
        self.assertEqual(reminder["item_id"], "answer")

    def test_terminal_identity_uses_product_round_across_native_binding(self) -> None:
        self.emit(
            PRODUCT_EVENT_USER_MESSAGE,
            "bound-a",
            turn="native-a",
            client_turn_id="round",
            binding="bound",
            text="Hello",
        )
        self.emit(PRODUCT_EVENT_TURN_FAILED, "failed-a", turn="native-a")
        self.emit(
            PRODUCT_EVENT_USER_MESSAGE,
            "bound-b",
            turn="native-b",
            client_turn_id="round",
            binding="bound",
            text="Hello",
        )
        self.emit(PRODUCT_EVENT_TURN_FAILED, "failed-b", turn="native-b")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)

    def test_event_transaction_rollback_does_not_publish_reminder(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "rollback"):
            with self.events.transaction() as connection:
                self.events.append(
                    session_id=SESSION_ID,
                    runtime_id=RUNTIME_ID,
                    vendor_thread_id=VENDOR_THREAD_ID,
                    vendor_turn_id="turn",
                    vendor_item_id=None,
                    kind=PRODUCT_EVENT_TURN_COMPLETED,
                    payload={},
                    idempotency_key="rollback",
                    connection=connection,
                )
                raise RuntimeError("rollback")
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)

    def test_epoch_scope_and_explicit_item_acknowledgement(self) -> None:
        self.emit(PRODUCT_EVENT_HIL_REQUESTED, "request", request_id="one")
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done")
        snapshot = self.attention.snapshot(OWNER)
        self.assertNotEqual(
            snapshot["epoch"], self.attention.snapshot(SessionPrincipal("stranger"))["epoch"]
        )
        with self.assertRaisesRegex(ValueError, "epoch changed"):
            self.attention.read(OWNER, through_revision=snapshot["revision"], epoch="stale")
        self.attention.read(
            OWNER,
            through_revision=snapshot["revision"],
            epoch=snapshot["epoch"],
            ids=(snapshot["items"][0]["id"],),
        )
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)
        shared = AttentionStore(SessionCatalogStore(self.database, shared_ownership=True))
        self.assertEqual(
            shared.snapshot(OWNER)["epoch"], shared.snapshot(SessionPrincipal("stranger"))["epoch"]
        )

    def test_read_all_preserves_hil_business_state_and_deletion_cascades_reminders(self) -> None:
        self.record_request("one")
        self.emit(PRODUCT_EVENT_TURN_FAILED, "failed")
        snapshot = self.attention.snapshot(OWNER)
        self.attention.read(OWNER, through_revision=snapshot["revision"])
        self.assertEqual(self.catalog.hil("one").status, HilStatus.PENDING)
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "next", turn="next")
        self.catalog.release(SESSION_ID, OWNER)
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)
        self.assertIsNone(self.attention.get(OWNER, snapshot["items"][0]["id"]))

    def test_concurrent_append_and_read_all_retains_new_reminder(self) -> None:
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done")
        snapshot = self.attention.snapshot(OWNER)
        with ThreadPoolExecutor(max_workers=2) as executor:
            append = executor.submit(self.emit, PRODUCT_EVENT_TURN_COMPLETED, "next", "next")
            read = executor.submit(
                self.attention.read, OWNER, through_revision=snapshot["revision"]
            )
            append.result()
            read.result()
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)

    def test_initialization_never_backfills_old_events(self) -> None:
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "historic")
        with sqlite3.connect(self.database) as connection:
            connection.execute("DROP TABLE session_attention")
            connection.execute("DROP TABLE session_attention_clock")
        ProductEventStore(self.database)
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 0)

    def test_layout_inspection_does_not_replace_clock_row_validation(self) -> None:
        for mutation in (
            "DELETE FROM session_attention_clock",
            "UPDATE session_attention_clock SET epoch=''",
            "UPDATE session_attention_clock SET revision=-1",
        ):
            with self.subTest(mutation=mutation):
                with sqlite3.connect(self.database) as connection:
                    connection.row_factory = sqlite3.Row
                    original = tuple(connection.execute("SELECT * FROM session_attention_clock"))
                    connection.execute(mutation)
                    connection.commit()
                    before = tuple(connection.iterdump())
                    self.assertFalse(ProductEventStore.inspect_connection(connection).needs_write)
                    with self.assertRaisesRegex(RuntimeError, "invalid attention clock"):
                        ProductEventStore.inspect_rows(connection, database=self.database)
                    with self.assertRaisesRegex(RuntimeError, "invalid attention clock"):
                        ProductEventStore.initialize_schema(connection)
                    with self.assertRaisesRegex(RuntimeError, "invalid attention clock"):
                        ProductEventStore(self.database)
                    self.assertEqual(tuple(connection.iterdump()), before)
                    connection.execute("DELETE FROM session_attention_clock")
                    connection.executemany(
                        "INSERT INTO session_attention_clock VALUES (?,?,?)", original
                    )

    def record_request(self, identity: str) -> None:
        self.catalog.record_hil(
            product_request_id=identity,
            session_id=SESSION_ID,
            vendor_request_id=identity,
            vendor_turn_id="turn-1",
            vendor_item_id="question",
            method="request_user_input",
            payload={"questions": [{"question": "Confirm scope"}]},
        )
        self.emit(
            PRODUCT_EVENT_HIL_REQUESTED,
            identity,
            request_id=identity,
            questions=[{"question": "Confirm scope"}],
        )

    def test_routes_and_navigation_resolve_current_state_without_actions(self) -> None:
        sessions = Mock(spec=SessionService)
        sessions.navigation.return_value = ({"session_id": SESSION_ID, "project_path": None}, 200)
        service = AttentionService(self.attention, self.catalog, self.events, sessions)
        app = FastAPI()

        @app.middleware("http")
        async def identity(request: Request, call_next):
            request.state.user_id = request.headers.get("test-owner", OWNER.user_id)
            return await call_next(request)

        mount_attention_routes(app, service)
        self.record_request("one")
        with TestClient(app) as client:
            snapshot = client.get("/api/serve/attention").json()
            reminder = snapshot["items"][0]
            navigation = f"/api/serve/attention/{reminder['id']}/navigation"
            self.assertEqual(client.get(navigation).json()["focus"]["request_id"], "one")
            self.assertEqual(
                client.get(navigation, headers={"test-owner": "stranger"}).status_code, 404
            )
            self.assertEqual(
                client.post(
                    "/api/serve/attention/read-all",
                    json={"epoch": "wrong", "through_revision": snapshot["revision"]},
                ).status_code,
                409,
            )
            self.catalog.resolve_hil("one", {"approved": True})
            self.record_request("two")
            self.assertEqual(client.get(navigation).json()["focus"]["request_id"], "two")
            self.catalog.resolve_hil("two", {"approved": True})
            self.emit(
                PRODUCT_EVENT_MESSAGE_DELTA, "partial", item="partial", delta="Partial output"
            )
            self.emit(PRODUCT_EVENT_TURN_FAILED, "failed", message="Unavailable")
            focus = client.get(navigation).json()["focus"]
            self.assertEqual(
                focus,
                {
                    "kind": "failed",
                    "incident_id": None,
                    "request_id": None,
                    "turn_id": "turn-1",
                    "item_id": None,
                },
            )
            self.emit(PRODUCT_EVENT_SESSION_STATE, "resumed", turn="", state="idle")
            self.emit(
                PRODUCT_EVENT_USER_MESSAGE,
                "cancelled",
                turn="",
                client_turn_id="cancelled",
                binding="cancelled",
                text="Cancelled queue",
            )
            self.assertEqual(client.get(navigation).json()["focus"], focus)
            self.emit(
                PRODUCT_EVENT_SESSION_STATE,
                "retry",
                turn="turn-2",
                active_turn_id="turn-2",
                state="running",
            )
            focus = client.get(navigation).json()["focus"]
            self.assertEqual(focus["kind"], "progress")
            self.assertEqual(focus["turn_id"], "turn-2")
            self.assertEqual(
                client.post(
                    "/api/serve/attention/read",
                    json={
                        "epoch": snapshot["epoch"],
                        "through_revision": snapshot["revision"],
                        "ids": [reminder["id"]],
                    },
                ).status_code,
                200,
            )
            latest = client.get("/api/serve/attention").json()
            self.assertEqual(latest["unread_count"], 2)
            cleared = client.post(
                "/api/serve/attention/read-all",
                json={"epoch": latest["epoch"], "through_revision": latest["revision"]},
            ).json()
            self.assertEqual(cleared["unread_count"], 0)
            self.assertEqual(client.get(navigation).status_code, 200)
            self.assertEqual(client.get("/api/serve/attention/missing/navigation").status_code, 404)
        sessions.open.assert_not_called()

    def test_ownership_filters_counts_and_read_all(self) -> None:
        self.emit(PRODUCT_EVENT_TURN_COMPLETED, "done-1")
        stranger = SessionPrincipal("another-owner")
        self.assertEqual(self.attention.snapshot(stranger)["unread_count"], 0)
        self.attention.read(stranger, through_revision=self.attention.snapshot(OWNER)["revision"])
        self.assertEqual(self.attention.snapshot(OWNER)["unread_count"], 1)


if __name__ == "__main__":
    unittest.main()
