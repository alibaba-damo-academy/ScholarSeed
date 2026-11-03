"""Durable empty-thread replacement contracts, not desktop acceptance."""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx

from scholarseed_runtime.contract import CapabilitySet, CommandReceipt, CommandState, RuntimeBinding
from scholarseed_runtime.contract.command import (
    EmptyThreadReplacementProof,
    SubmissionRetryProof,
    ThreadReplacementProof,
    TurnRequest,
)
from scholarseed_runtime.contract.event import DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.input import SubmissionRetry, TurnAdmission, TurnInput
from scholarseed_runtime.contract.model import ModelWireProtocol
from scholarseed_runtime.gateway.driver import (
    RuntimeDriver,
    RuntimeDriverError,
    RuntimeTurnNotSubmittedError,
)
from service.chat.constants import PRODUCT_EVENT_USER_MESSAGE, PRODUCT_TURN_OUTCOME_UNKNOWN
from service.chat.persistence.catalog import (
    SESSION_MESSAGE_QUEUE_TABLE,
    SESSION_REPLACEMENT_TABLE,
    QueuedMessageState,
    ReplacementKind,
    ReplacementState,
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    UncertaintyKind,
    UncertaintyState,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.persistence.utils import WriteBusy
from service.chat.runtime.activation import SESSION_OPEN_UNKNOWN, SessionActivationError
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.incidents import incident_data
from service.chat.runtime.live import LiveSession
from service.chat.service.completions import CompletionBridge
from service.chat.service.recovery import (
    RECOVERY_CHECKPOINT,
    RECOVERY_SEALED,
    RecoveryService,
    recovery_key,
)
from service.platform.activity import Activities


def binding() -> RuntimeBinding:
    return RuntimeBinding(
        product_session_id="product",
        runtime_id="codex",
        adapter_version="test",
        runtime_version="test",
        protocol_version="test",
        protocol_schema_hash="test",
        opaque_session_ref="empty",
        capabilities=CapabilitySet(),
    )


def evidence() -> RuntimeEvent:
    return RuntimeEvent(
        schema_version=1,
        event_id="event",
        runtime_id="codex",
        product_session_id="product",
        native_session_id="empty",
        process_generation=2,
        sequence=1,
        kind=RuntimeEventKind.TURN_NOT_SUBMITTED,
        delivery=DeliveryClass.MUST_PERSIST,
        observed_at="2026-10-29T00:00:00Z",
        correlation_id="command",
        call_id="call",
        payload={
            "proof_id": "proof",
            "failed_generation": 1,
            "absence_generation": 2,
            "submission_deadline": 2000000000.0,
            "submission_attempts": 1,
        },
    )


class ReplacementContracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = SessionCatalogStore(Path(self.temporary.name).resolve() / "catalog.sqlite3")
        self.original = binding()
        self.proof = EmptyThreadReplacementProof.from_event(evidence(), self.original)
        self.candidate = replace(self.original, opaque_session_ref="replacement")
        self.catalog.allocate(
            "product",
            SessionPrincipal("owner"),
            runtime_id="codex",
            runtime_workdir=self.temporary.name,
            project_path=None,
            output_root=self.temporary.name,
        )
        self.catalog.begin_open("product", "first")
        self.catalog.bind_open("product", "first", self.original, unsubmitted=True)
        self.catalog.begin_attachment("product")
        self.catalog.enqueue_message("product", "command", {"content": "same frozen input"})
        self.catalog.begin_queued_submission("product", "command")

    def claim(self):
        self.catalog.record_replacement(self.proof, "revision")
        self.catalog.begin_replacement(self.proof, "revision", "reservation")

    def test_replacement_reauthorizes_real_bridge_boundary_without_unsealing_the_old_checkpoint(
        self,
    ):
        self.bridge_reauthorization(replacing=True)

    def test_same_thread_retry_reauthorizes_bridge_without_unsealing_the_old_checkpoint(self):
        self.bridge_reauthorization(replacing=False)

    def bridge_reauthorization(self, *, replacing):
        async def scenario():
            events = ProductEventStore(self.catalog.database)
            activities = Activities()

            async def publish(kind, payload, *, turn_id="", idempotency_key="", **_kwargs):
                return events.append(
                    session_id="product",
                    runtime_id="codex",
                    vendor_thread_id=live.vendor_thread_id,
                    vendor_turn_id=turn_id or None,
                    vendor_item_id=None,
                    kind=kind,
                    payload=dict(payload),
                    idempotency_key=idempotency_key,
                )

            live = SimpleNamespace(
                id="product",
                catalog=self.catalog,
                runtime_session=SimpleNamespace(binding=self.original),
                vendor_thread_id="empty",
                model_id="",
                user_id="owner",
                interrupt_generation=0,
                last_submission_id="command",
                interrupting=False,
                closing=False,
                terminating=False,
                terminated=False,
                pending_hil_snapshot=lambda: [],
                ledger=SimpleNamespace(active_turn_id="", uncertainty_snapshot=lambda: []),
                publish=publish,
            )
            recovery = RecoveryService(
                {"product": live}, events, activities, logging.getLogger(__name__), AsyncMock()
            )
            bridge = CompletionBridge("http://127.0.0.1", turn_ids=lambda _session: "command")
            try:
                bridge.bind_output_guard(
                    recovery.before_output, before_request=recovery.before_request
                )
                recovery.bind_quiescence(bridge.quiesce_turn)
                await publish(
                    PRODUCT_EVENT_USER_MESSAGE,
                    {"text": "original", "client_turn_id": "command"},
                    turn_id="command",
                    idempotency_key="original-user",
                )
                await recovery.begin(live, "command")
                old = recovery._checkpoints["product"]
                incident = RuntimeIncident(
                    "exit",
                    RuntimeIncidentScope.PROCESS,
                    RuntimeIncidentState.DETECTED,
                    RuntimeIncidentKind.PROCESS_EXIT,
                    RuntimeRecoveryStrategy.AUTO_RESTART,
                    RuntimeRetryability.IN_PROGRESS,
                    "agent_runtime_exit",
                    process_generation=1,
                    vendor_thread_id="empty",
                )
                await recovery.observe(
                    live,
                    replace(
                        evidence(),
                        kind=RuntimeEventKind.RUNTIME_INCIDENT,
                        process_generation=1,
                        payload={"incident": incident_data(incident)},
                    ),
                )
                self.assertTrue(old.sealed)
                if replacing:
                    self.claim()
                    self.catalog.settle_replacement(
                        "product", "proof", ReplacementState.OPENING, self.candidate
                    )
                    self.catalog.replace_runtime_binding(
                        self.original, self.candidate, proof=self.proof, revision="revision"
                    )
                    live.runtime_session.binding = self.candidate
                    live.vendor_thread_id = "replacement"
                    current = await recovery.replace_unsubmitted(live, self.proof)
                    epoch = "proof"
                else:
                    retry = SubmissionRetryProof(
                        self.original, "command", "call", 0, SubmissionRetry(1, 2, 2000000000.0, 1)
                    )
                    current = await recovery.retry_unsubmitted(live, retry)
                    epoch = "call:1"
                self.assertTrue(current())
                self.assertTrue(old.sealed)
                self.assertFalse(old.observed)
                self.assertIsNotNone(
                    events.by_key("product", recovery_key("command", RECOVERY_SEALED))
                )
                successor = recovery._checkpoints["product"]
                self.assertIsNot(successor, old)
                self.assertIsNotNone(
                    events.by_key("product", recovery_key("command", RECOVERY_CHECKPOINT, epoch))
                )
                received = []

                async def upstream(request):
                    received.append(request)
                    return httpx.Response(200, json={"object": "response", "output": []})

                bridge._clients[False] = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
                registration = bridge.register(
                    endpoint="https://contract.example/responses",
                    responses_endpoint="https://contract.example/responses",
                    api_key="contract-only",
                    session_id="product",
                    wire_protocol=ModelWireProtocol.RESPONSES,
                )
                await bridge.forward(
                    registration.bridge_id, {"model": "model", "input": "original", "tools": []}
                )
                self.assertEqual(len(received), 1)
                self.assertTrue(successor.observed)
                self.assertFalse(old.observed)
                successor.sealed = True
                self.assertFalse(current())
            finally:
                await recovery.aclose()
                await bridge.close()

        asyncio.run(scenario())

    def test_replacement_commits_binding_and_generation_without_mutating_input(self):
        queued = self.catalog.queued_message("product", "command")
        generation = self.catalog.activation("product").generation
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        self.catalog.replace_runtime_binding(
            self.original, self.candidate, proof=self.proof, revision="revision"
        )
        self.assertEqual(self.catalog.runtime_binding("product"), self.candidate)
        self.assertEqual(self.catalog.get("product").vendor_thread_id, "replacement")
        self.assertEqual(self.catalog.queued_message("product", "command"), queued)
        self.assertEqual(self.catalog.activation("product").generation, generation + 1)
        self.assertIs(self.catalog.replacement("product")["state"], ReplacementState.BOUND)
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.begin_replacement(self.proof, "revision", "second")

    def test_process_restart_fences_both_unconsumed_and_opening_proofs(self):
        self.catalog.record_replacement(self.proof, "revision")
        self.catalog.recover_inflight()
        reopened = SessionCatalogStore(self.catalog.database)
        self.assertIs(reopened.replacement("product")["state"], ReplacementState.UNKNOWN)
        self.assertIs(
            reopened.queued_message("product", "command").state, QueuedMessageState.OUTCOME_UNKNOWN
        )
        with self.assertRaises(SessionBindingConflictError):
            reopened.begin_replacement(self.proof, "revision", "second")

    def test_opening_ack_loss_keeps_candidate_and_fence_across_restart(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        self.catalog.recover_inflight()
        self.assertIs(self.catalog.replacement("product")["state"], ReplacementState.UNKNOWN)
        self.assertEqual(
            self.catalog.replacement("product")["candidate"]["opaque_session_ref"], "replacement"
        )
        self.assertEqual(self.catalog.runtime_binding("product"), self.original)
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                self.original, self.candidate, proof=self.proof, revision="revision"
            )

    def test_same_proof_can_be_claimed_by_only_one_connection(self):
        other = SessionCatalogStore(self.catalog.database)
        self.catalog.record_replacement(self.proof, "revision")
        barrier = threading.Barrier(2)

        def claim(store, reservation):
            barrier.wait(timeout=5)
            try:
                store.begin_replacement(self.proof, "revision", reservation)
            except (SessionBindingConflictError, WriteBusy):
                return None
            return reservation

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(claim, store, reservation)
                for store, reservation in ((self.catalog, "one"), (other, "two"))
            ]
            winners = [future.result(timeout=10) for future in futures]
        self.assertEqual(sum(winner is not None for winner in winners), 1)
        self.assertEqual(
            self.catalog.replacement("product")["reservation_id"],
            next(winner for winner in winners if winner is not None),
        )

    def test_cas_rechecks_database_configuration_after_native_ack(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        generation = self.catalog.activation("product").generation
        with closing(sqlite3.connect(self.catalog.database)) as connection, connection:
            connection.execute("UPDATE session_catalog SET policy_id = ?", ("changed-permission",))
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                self.original, self.candidate, proof=self.proof, revision="revision"
            )
        self.assertEqual(self.catalog.runtime_binding("product"), self.original)
        self.assertEqual(self.catalog.activation("product").generation, generation)

    def test_cas_rechecks_persisted_hil_after_native_ack(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        self.catalog.record_hil(
            product_request_id="approval",
            session_id="product",
            vendor_request_id="native-request",
            vendor_turn_id="native-turn",
            vendor_item_id="item",
            method="exec",
            payload={},
        )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                self.original, self.candidate, proof=self.proof, revision="revision"
            )
        self.assertEqual(self.catalog.runtime_binding("product"), self.original)

    def test_unknown_queue_and_changed_operation_cannot_consume_proof(self):
        self.catalog.record_replacement(self.proof, "revision")
        with closing(sqlite3.connect(self.catalog.database)) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?",
                (QueuedMessageState.OUTCOME_UNKNOWN.value,),
            )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.begin_replacement(self.proof, "revision", "reservation")
        with closing(sqlite3.connect(self.catalog.database)) as connection, connection:
            connection.execute(
                f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET state = ?, operation_seq = operation_seq + 1",
                (QueuedMessageState.SUBMITTING.value,),
            )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.begin_replacement(self.proof, "revision", "reservation")

    def test_configuration_and_full_binding_changes_fail_cas(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                self.original, self.candidate, proof=self.proof, revision="changed"
            )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                replace(self.original, profile="changed"), self.candidate
            )
        self.assertEqual(self.catalog.runtime_binding("product"), self.original)

    def test_only_explicit_failed_message_retry_reauthorizes_a_not_applied_open(self):
        self.claim()
        self.catalog.settle_replacement("product", "proof", ReplacementState.NOT_APPLIED)
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.begin_replacement(self.proof, "revision", "automatic")
        self.catalog.fail_queued_submission(
            "product", "command", safe_error="runtime_turn_not_submitted", unknown=False
        )
        with closing(sqlite3.connect(self.catalog.database)) as connection, connection:
            connection.execute(f"UPDATE {SESSION_MESSAGE_QUEUE_TABLE} SET deadline = ?", (1.0,))
        self.catalog.authorize_replacement_retry("product", "command")
        self.assertIsNone(self.catalog.queued_message("product", "command").deadline)
        self.assertIs(
            self.catalog.queued_message("product", "command").state,
            QueuedMessageState.WAITING_RESOURCES,
        )
        proof = self.catalog.manual_replacement_proof("product", "command")
        self.assertIsNotNone(proof)
        self.catalog.begin_replacement(proof, "manual-revision", "manual-reservation", manual=True)
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        self.catalog.replace_runtime_binding(
            self.original, self.candidate, proof=proof, revision="manual-revision", manual=True
        )
        self.assertIs(self.catalog.replacement("product")["state"], ReplacementState.BOUND)

    def test_unknown_replacement_can_never_be_reauthorized_by_manual_retry(self):
        self.claim()
        self.catalog.settle_replacement("product", "proof", ReplacementState.UNKNOWN)
        self.catalog.authorize_replacement_retry("product", "command")
        self.assertIsNone(self.catalog.manual_replacement_proof("product", "command"))
        self.assertIs(self.catalog.replacement("product")["state"], ReplacementState.UNKNOWN)

    def test_preview_uses_original_journal_and_retains_candidate_after_bound_restart(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "proof", ReplacementState.OPENING, self.candidate
        )
        self.catalog.replace_runtime_binding(
            self.original, self.candidate, proof=self.proof, revision="revision"
        )
        with (
            closing(sqlite3.connect(self.catalog.database)) as source,
            closing(sqlite3.connect(":memory:")) as preview,
        ):
            source.backup(preview)
            preview.row_factory = sqlite3.Row
            SessionCatalogStore.inspect_rows(preview, database=self.catalog.database)
            SessionCatalogStore.recover_inflight_rows(
                preview, now=2000000000.0, database=self.catalog.database
            )
            self.assertEqual(
                preview.execute(f"SELECT state FROM {SESSION_REPLACEMENT_TABLE}").fetchone()[0],
                ReplacementState.BOUND.value,
            )
        self.catalog.recover_inflight()
        self.assertEqual(self.catalog.runtime_binding("product"), self.candidate)


class ThreadRebuildingContracts(unittest.TestCase):
    def setUp(self):
        ReplacementContracts.setUp(self)
        self.proof = ThreadReplacementProof(
            "rebuild", self.original, "command", "resume-missing", 1, 2, 1
        )
        self.catalog.mark_queue_running("product", "command", "native-turn")
        self.catalog.fail_queued_submission(
            "product", "command", unknown=True, safe_error="process_exit"
        )
        self.unknown = replace(
            evidence(),
            kind=RuntimeEventKind.TURN_UNKNOWN,
            native_turn_id="native-turn",
            process_generation=1,
            payload={"incident": {"incident_id": "process-exit"}},
        )
        self.catalog.record_unknown_turn(
            "product", "native-turn", self.unknown, safe_error="process_exit"
        )
        self.catalog.record_turn_settlement("product", "command", self.unknown)

    def claim(self):
        self.catalog.record_replacement(self.proof, "revision")
        self.catalog.begin_replacement(self.proof, "revision", "reservation")

    def bind(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "rebuild", ReplacementState.OPENING, self.candidate
        )
        self.catalog.replace_runtime_binding(
            self.original, self.candidate, proof=self.proof, revision="revision"
        )

    def test_rebuild_preserves_unknown_source_and_uses_a_distinct_proof_kind(self):
        original = self.catalog.queued_message("product", "command")
        self.bind()
        self.assertEqual(self.catalog.runtime_binding("product"), self.candidate)
        self.assertEqual(self.catalog.queued_message("product", "command"), original)
        self.assertEqual(
            self.catalog.replacement("product")["kind"], ReplacementKind.HISTORY_REBUILD
        )
        self.assertIsNotNone(self.catalog.pending_turn_settlement("product"))
        self.assertIs(
            self.catalog.uncertainty("product", UncertaintyKind.TURN, "native-turn").state,
            UncertaintyState.UNKNOWN,
        )

    def test_confirmation_preserves_unknown_audit_and_does_not_resubmit_the_source(self):
        self.bind()
        self.assertTrue(self.catalog.confirm_thread_replacement(self.proof))
        uncertainty = self.catalog.uncertainty("product", UncertaintyKind.TURN, "native-turn")
        self.assertIs(uncertainty.state, UncertaintyState.CONFIRMED)
        self.assertEqual(uncertainty.payload["outcome"], PRODUCT_TURN_OUTCOME_UNKNOWN)
        self.assertEqual(uncertainty.payload["runtime_event"]["native_session_id"], "empty")
        self.assertEqual(uncertainty.payload["resolution"], ReplacementKind.HISTORY_REBUILD.value)
        self.assertIsNone(self.catalog.pending_turn_settlement("product"))
        self.assertIs(
            self.catalog.queued_message("product", "command").state,
            QueuedMessageState.OUTCOME_UNKNOWN,
        )
        self.assertTrue(self.catalog.confirm_thread_replacement(self.proof))

    def test_ack_loss_and_process_restart_never_authorize_a_second_creation(self):
        self.claim()
        self.catalog.recover_inflight()
        reopened = SessionCatalogStore(self.catalog.database)
        self.assertIs(reopened.replacement("product")["state"], ReplacementState.UNKNOWN)
        with self.assertRaises(SessionBindingConflictError):
            reopened.begin_replacement(self.proof, "revision", "second")
        self.assertFalse(reopened.confirm_thread_replacement(self.proof))

    def test_hil_and_unrelated_uncertainty_block_rebuilding(self):
        self.catalog.claim_uncertainty(
            "product", UncertaintyKind.TOOL_RESPONSE, "tool", state=UncertaintyState.UNKNOWN
        )
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.record_replacement(self.proof, "revision")

    def test_changed_configuration_and_stale_proof_do_not_replace_binding(self):
        self.claim()
        self.catalog.settle_replacement(
            "product", "rebuild", ReplacementState.OPENING, self.candidate
        )
        with closing(sqlite3.connect(self.catalog.database)) as connection, connection:
            connection.execute("UPDATE session_catalog SET policy_id = ?", ("changed",))
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.replace_runtime_binding(
                self.original, self.candidate, proof=self.proof, revision="revision"
            )
        self.assertFalse(self.catalog.confirm_thread_replacement(self.proof))

    def test_wrong_failure_generation_cannot_claim_an_unknown_request(self):
        with self.assertRaises(SessionBindingConflictError):
            self.catalog.record_replacement(
                replace(self.proof, failed_generation=2, absence_generation=3), "revision"
            )

    def test_confirmation_rechecks_new_hil_after_binding(self):
        self.bind()
        self.catalog.record_hil(
            product_request_id="new-approval",
            session_id="product",
            vendor_request_id="native-request",
            vendor_turn_id="native-turn",
            vendor_item_id="item",
            method="exec",
            payload={},
        )
        self.assertFalse(self.catalog.confirm_thread_replacement(self.proof))
        self.assertIs(
            self.catalog.uncertainty("product", UncertaintyKind.TURN, "native-turn").state,
            UncertaintyState.UNKNOWN,
        )

    def test_new_user_queue_blocks_confirmation_after_binding(self):
        self.bind()
        self.catalog.enqueue_message("product", "new-user", {"content": "new task"})
        self.assertFalse(self.catalog.confirm_thread_replacement(self.proof))

    def test_later_explicit_task_can_rebuild_without_erasing_the_previous_audit(self):
        self.bind()
        self.assertTrue(self.catalog.confirm_thread_replacement(self.proof))
        original = self.catalog.queued_message("product", "command")
        self.catalog.remove_reconciled_unknown_message("product", "command", original.operation_seq)
        self.catalog.enqueue_message("product", "later", {"content": "later task"})
        self.catalog.begin_queued_submission("product", "later")
        self.catalog.mark_queue_running("product", "later", "later-native")
        self.catalog.fail_queued_submission("product", "later", unknown=True, safe_error="exit")
        later = replace(
            self.proof,
            proof_id="later-proof",
            binding=self.candidate,
            command_id="later",
            failed_generation=2,
            absence_generation=3,
        )
        self.catalog.record_replacement(later, "later-revision")
        record = self.catalog.replacement("product")
        self.assertEqual(record["proof_id"], "later-proof")
        self.assertEqual(record["previous"]["proof_id"], "rebuild")
        self.assertEqual(record["previous"]["candidate"]["opaque_session_ref"], "replacement")


class ProofContracts(unittest.IsolatedAsyncioTestCase):
    async def test_retry_authority_matches_receipt_attempt_and_revokes_before_write(self):
        requests = []

        async def submit(request):
            requests.append(request)
            return CommandReceipt("command", CommandState.ACCEPTED, "call")

        observations = asyncio.Queue()

        async def events():
            while True:
                yield await observations.get()

        session = SimpleNamespace(
            binding=binding(), submit=submit, events=events, detach=AsyncMock()
        )
        product_current = Mock(return_value=True)
        authorize = AsyncMock(return_value=product_current)
        driver = RuntimeDriver(session, AsyncMock())
        driver.start()
        task = asyncio.create_task(
            driver.submit(TurnRequest("command", ("frozen input",), retry_authorizer=authorize))
        )
        await asyncio.sleep(0)
        retry = SubmissionRetryProof(
            binding(),
            "command",
            "call",
            0,
            SubmissionRetry(1, 2, asyncio.get_running_loop().time() + 1, 1),
        )
        try:
            with self.assertRaises(RuntimeDriverError):
                await requests[0].retry_authorizer(replace(retry, call_id="stale-call"))
            authorize.assert_not_awaited()
            current = await requests[0].retry_authorizer(retry)
            self.assertTrue(current())
            with self.assertRaises(RuntimeDriverError):
                await requests[0].retry_authorizer(retry)
            product_current.return_value = False
            self.assertFalse(current())
            product_current.return_value = True
            driver._reduce(replace(evidence(), kind=RuntimeEventKind.TOOL_STARTED))
            self.assertFalse(current())
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await driver.close()

    async def test_replacement_resubmits_frozen_runtime_context_and_nonterminal_projection(self):
        live = object.__new__(LiveSession)
        live.runtime_driver = SimpleNamespace(submit=AsyncMock(return_value="result"))
        live.model_run = None
        live._trace = SimpleNamespace(runtime_event=Mock())
        live._persistence = SimpleNamespace(run=AsyncMock())
        live.ledger = SimpleNamespace(terminal=AsyncMock())
        frozen = TurnRequest(
            "command",
            ({"kind": "text", "text": "frozen task context"}, "original input"),
            model="frozen-model",
        )
        fence = TurnAdmission("new-attachment", 1, 1, lambda: True)
        current = TurnInput(
            (),
            client_user_message_id="command",
            admission=fence,
            submission_deadline=2000000000.0,
            submission_attempts=1,
        )
        result = await live.run_runtime(current, frozen_request=frozen)
        self.assertEqual(result, "result")
        sent = live.runtime_driver.submit.await_args.args[0]
        self.assertIs(sent.items, frozen.items)
        self.assertEqual(sent.model, "frozen-model")
        self.assertIs(sent.admission, fence)
        await live._project_runtime_event(evidence())
        live._persistence.run.assert_awaited_once_with(live._trace.runtime_event, evidence())
        live.ledger.terminal.assert_not_called()

    async def test_gateway_accepts_only_proof_for_the_current_receipt_call(self):
        for early in (False, True):
            for call_id in ("call", "another-call"):
                with self.subTest(early=early, call_id=call_id):
                    session = SimpleNamespace(binding=binding())
                    driver = RuntimeDriver(session, AsyncMock())

                    async def submit(request, early=early, driver=driver, call_id=call_id):
                        if early:
                            driver._reduce(evidence())
                        return CommandReceipt(request.command_id, CommandState.ACCEPTED, call_id)

                    session.submit = submit
                    task = asyncio.create_task(
                        driver.submit(TurnRequest("command", ("same input",)))
                    )
                    await asyncio.sleep(0)
                    if not early:
                        if call_id == "call":
                            driver._reduce(evidence())
                        else:
                            with self.assertRaises(RuntimeDriverError):
                                driver._reduce(evidence())
                            task.cancel()
                    if call_id == "call":
                        with self.assertRaises(RuntimeTurnNotSubmittedError):
                            await task
                    elif early:
                        with self.assertRaises(RuntimeDriverError):
                            await task
                    else:
                        await asyncio.gather(task, return_exceptions=True)

    async def test_started_turn_cannot_be_replaced_and_stale_proof_does_not_resolve_new_call(self):
        session = SimpleNamespace(
            binding=binding(),
            submit=AsyncMock(return_value=CommandReceipt("command", CommandState.ACCEPTED, "call")),
        )
        driver = RuntimeDriver(session, AsyncMock())
        task = asyncio.create_task(driver.submit(TurnRequest("command", ("input",))))
        await asyncio.sleep(0)
        driver._reduce(
            replace(evidence(), kind=RuntimeEventKind.TURN_STARTED, native_turn_id="executed")
        )
        with self.assertRaises(RuntimeDriverError):
            driver._reduce(evidence())
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        driver._reduce(evidence())
        self.assertFalse(driver._proofs)

    async def test_skill_inventory_notifications_do_not_imply_execution(self):
        for kind, native_turn_id, native_item_id, accepted in (
            (RuntimeEventKind.SKILLS_CHANGED, "", "", True),
            (RuntimeEventKind.RUNTIME_WARNING, "", "", True),
            (RuntimeEventKind.RUNTIME_WARNING, "observed-turn", "", False),
            (RuntimeEventKind.RUNTIME_WARNING, "", "observed-item", False),
            (RuntimeEventKind.SKILLS_CHANGED, "observed-turn", "", False),
            (RuntimeEventKind.RUNTIME_EXTENSION, "", "", False),
        ):
            with self.subTest(kind=kind, native_turn_id=native_turn_id):
                observations = asyncio.Queue()

                async def events(observations=observations):
                    while True:
                        yield await observations.get()

                session = SimpleNamespace(
                    binding=binding(),
                    events=events,
                    detach=AsyncMock(),
                    submit=AsyncMock(
                        return_value=CommandReceipt("command", CommandState.ACCEPTED, "call")
                    ),
                )
                projected = AsyncMock()
                driver = RuntimeDriver(session, projected)
                driver.start()
                task = asyncio.create_task(driver.submit(TurnRequest("command", ("same input",))))
                await asyncio.sleep(0)
                await observations.put(
                    replace(
                        evidence(),
                        kind=kind,
                        native_turn_id=native_turn_id,
                        native_item_id=native_item_id,
                    )
                )
                await observations.put(
                    replace(evidence(), event_id="proof-after-inventory", sequence=2)
                )
                try:
                    with self.assertRaises(
                        RuntimeTurnNotSubmittedError if accepted else RuntimeDriverError
                    ):
                        await task
                    self.assertEqual(projected.await_count, 2)
                finally:
                    await driver.close()


class EmptyReplacementLifecycleContracts(unittest.IsolatedAsyncioTestCase):
    async def test_closing_or_archived_session_never_records_or_starts_replacement(self):
        proof = EmptyThreadReplacementProof.from_event(evidence(), binding())
        for closing_session, archived in ((True, False), (False, True)):
            with self.subTest(closing=closing_session, archived=archived):
                service = object.__new__(LiveSessionService)
                service._activation_revision = Mock(return_value=("revision",))
                service._catalog = SimpleNamespace(
                    get=Mock(return_value=SimpleNamespace(archived=archived)),
                    record_replacement=Mock(),
                )
                live = SimpleNamespace(
                    id=proof.binding.product_session_id,
                    interrupt_generation=0,
                    runtime_session=SimpleNamespace(binding=proof.binding),
                    runtime_driver=SimpleNamespace(close=AsyncMock()),
                    active_product_turn_id=proof.command_id,
                    pending_hil_snapshot=Mock(return_value=[]),
                    closing=closing_session,
                    terminating=False,
                    terminated=False,
                    persistence=SimpleNamespace(
                        run=AsyncMock(
                            side_effect=AssertionError("replacement persistence must not run")
                        )
                    ),
                )
                with self.assertRaises(SessionActivationError) as error:
                    await service._recover_empty(live, proof)
                self.assertEqual(error.exception.safe_error, SESSION_OPEN_UNKNOWN)
                live.persistence.run.assert_not_awaited()
                live.runtime_driver.close.assert_not_awaited()

    async def test_activation_revision_fences_closing_and_archiving(self):
        record = SimpleNamespace(policy_id="ask", archived=False)
        model = SimpleNamespace(
            selected_model_id="model", selected_reasoning_effort="", selected_thinking=None
        )
        service = object.__new__(LiveSessionService)
        service._catalog = SimpleNamespace(
            get=Mock(return_value=record),
            model_state=Mock(return_value=model),
            runtime_binding=Mock(return_value=binding()),
        )
        service._skills = SimpleNamespace(availability_revision=Mock(return_value=("policy",)))
        live = SimpleNamespace(
            id="product",
            runtime_workdir=Path.cwd(),
            project_path=None,
            output_root=Path.cwd(),
            writable_roots=(),
            user_id="owner",
            process_environment={},
            closing=False,
        )
        original = service._activation_revision(live)
        live.closing = True
        self.assertNotEqual(service._activation_revision(live), original)
        live.closing = False
        record.archived = True
        self.assertNotEqual(service._activation_revision(live), original)


if __name__ == "__main__":
    unittest.main()
