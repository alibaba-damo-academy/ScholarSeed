"""Adapter suspension state contracts; fixtures do not constitute product acceptance."""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_codex.activity import NativeActivityState
from scholarseed_codex.diagnostic import THREAD_HISTORY_MISSING_ERROR
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.protocol.state import (
    AppServerError,
    CodexProcessState,
    CodexThreadAttachmentState,
)
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract import CapabilitySet, RuntimeBinding
from scholarseed_runtime.contract.command import ArchiveRequest, CommandState
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_STALE,
    RuntimeActivitySnapshot,
    SuspendState,
    ThreadReplacementTarget,
    TurnConfirmationTarget,
)

TEST_GENERATION = 1
TEST_CHANGED_GENERATION = 2
TEST_REVISION = 3
TEST_WATERMARK = 5
TEST_TIMEOUT_SECONDS = 5.0
TEST_ROOT = "suspension-root"
TEST_NAMESPACE = "suspension-attachment"


class SuspensionNative:
    """Controlled native acknowledgement boundary for adapter state-machine tests."""

    def __init__(self, *, fail: bool = False, blocked: bool = False) -> None:
        self.host = SimpleNamespace(process_generation=TEST_GENERATION)
        self.entered = asyncio.Event()
        self.gate = asyncio.Event()
        if not blocked:
            self.gate.set()
        self.fail = fail
        self.calls: list[tuple[int, bool]] = []
        self.lease = SimpleNamespace(
            evidence=ResourceEvidence(
                event_id="resource-observation",
                request_id="resource-request",
                reservation_id="reservation",
                host_id="host",
                lease_id="lease",
                role="execution",
                state="ready",
                observed_at=time(),
                capacity=(),
                process_generation=TEST_GENERATION,
            )
        )

    async def suspend(self, expected_generation: int, *, retry: bool = False) -> None:
        self.calls.append((expected_generation, retry))
        if expected_generation != self.host.process_generation:
            raise AppServerError(RUNTIME_SUSPEND_STALE, safe_error=RUNTIME_SUSPEND_STALE)
        self.entered.set()
        await self.gate.wait()
        if self.fail:
            self.fail = False
            raise AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY)
        self.lease.evidence = replace(self.lease.evidence, state="stopped")
        self.lease = None


def session_fixture(native: SuspensionNative) -> CodexRuntimeSession:
    # Populate only the owned state used by suspension: no home/auth/product setup.
    session = object.__new__(CodexRuntimeSession)
    session._native = native
    session._admission_lock = asyncio.Lock()
    session._active_operations = 0
    session._activity_revision = TEST_REVISION
    session._suspend_receipt = None
    session._suspend_task = None
    session._released_evidence = None
    session.activity = AsyncMock(
        return_value=RuntimeActivitySnapshot(
            f"{TEST_NAMESPACE}:{TEST_GENERATION}",
            TEST_REVISION,
            TEST_WATERMARK,
            True,
        )
    )
    return session


class CodexSuspensionContracts(unittest.IsolatedAsyncioTestCase):
    async def test_failed_commit_is_queryable_and_keeps_command_gate_closed(self) -> None:
        native = SuspensionNative(fail=True)
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        with self.assertRaises(AppServerError):
            await session.commit_suspend(ticket, TEST_WATERMARK)
        receipt = await session.suspend_status(ticket)
        self.assertIs(receipt.state, SuspendState.COMMITTING)
        self.assertTrue(receipt.finished)
        self.assertTrue(receipt.safe_error)
        with self.assertRaises(AppServerError) as context:
            await session.archive(ArchiveRequest("archive-during-commit"))
        self.assertEqual(context.exception.safe_error, RUNTIME_SUSPEND_BUSY)
        aborted = await session.abort_suspend(ticket)
        self.assertIs(aborted.state, SuspendState.COMMITTING)

    async def test_same_ticket_explicit_retry_finishes_original_generation(self) -> None:
        native = SuspensionNative(fail=True)
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        with self.assertRaises(AppServerError):
            await session.commit_suspend(ticket, TEST_WATERMARK)
        receipt = await session.commit_suspend(ticket, TEST_WATERMARK)
        self.assertIs(receipt.state, SuspendState.RELEASED)
        self.assertTrue(receipt.finished)
        self.assertEqual(native.calls, [(TEST_GENERATION, False), (TEST_GENERATION, True)])
        self.assertIs(
            (await session.commit_suspend(ticket, TEST_WATERMARK)).state, SuspendState.RELEASED
        )
        self.assertEqual(len(native.calls), 2)

    async def test_retry_never_substitutes_a_new_process_generation(self) -> None:
        native = SuspensionNative(fail=True)
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        with self.assertRaises(AppServerError):
            await session.commit_suspend(ticket, TEST_WATERMARK)
        native.host.process_generation = TEST_CHANGED_GENERATION
        with self.assertRaises(AppServerError) as context:
            await session.commit_suspend(ticket, TEST_WATERMARK)
        self.assertEqual(context.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertTrue(all(generation == TEST_GENERATION for generation, _ in native.calls))
        self.assertIs((await session.suspend_status(ticket)).state, SuspendState.COMMITTING)

    async def test_released_evidence_survives_native_lease_detachment(self) -> None:
        native = SuspensionNative()
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        await session.commit_suspend(ticket, TEST_WATERMARK)
        self.assertIsNone(native.lease)
        evidence = session.resource_evidence
        self.assertIsNotNone(evidence)
        self.assertEqual(evidence.host_id, "host")
        self.assertEqual(evidence.lease_id, "lease")
        self.assertEqual(evidence.state, "stopped")
        self.assertEqual(evidence.process_generation, TEST_GENERATION)

    async def test_cancellation_during_commit_joins_original_native_operation(self) -> None:
        native = SuspensionNative(blocked=True)
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        committing = asyncio.create_task(session.commit_suspend(ticket, TEST_WATERMARK))
        await asyncio.wait_for(native.entered.wait(), TEST_TIMEOUT_SECONDS)
        committing.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await committing
        receipt = await session.suspend_status(ticket)
        self.assertIs(receipt.state, SuspendState.COMMITTING)
        self.assertFalse(receipt.finished)
        self.assertIs((await session.abort_suspend(ticket)).state, SuspendState.COMMITTING)
        native.gate.set()
        receipt = await asyncio.wait_for(
            session.commit_suspend(ticket, TEST_WATERMARK), TEST_TIMEOUT_SECONDS
        )
        self.assertIs(receipt.state, SuspendState.RELEASED)
        self.assertEqual(native.calls, [(TEST_GENERATION, False)])

    async def test_ticket_identity_and_checkpoint_are_enforced(self) -> None:
        native = SuspensionNative()
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        with self.assertRaises(AppServerError):
            await session.commit_suspend(
                replace(ticket, ticket_id="different-ticket"), TEST_WATERMARK
            )
        with self.assertRaises(AppServerError):
            await session.commit_suspend(ticket, TEST_WATERMARK - 1)
        self.assertEqual(native.calls, [])
        self.assertIs((await session.suspend_status(ticket)).state, SuspendState.PREPARED)
        receipt = await session.abort_suspend(ticket)
        self.assertIs(receipt.state, SuspendState.ABORTED)
        await session.archive(ArchiveRequest("archive-after-abort"))


class CodexConfirmationContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.host = CodexProcessHost(launch_cwd=Path.cwd())
        self.host._generation = TEST_CHANGED_GENERATION
        self.host._proc = SimpleNamespace(returncode=None)
        self.host.state = CodexProcessState.READY
        self.host._exited_generations.append(TEST_GENERATION)
        self.turn = SimpleNamespace(
            ambiguous_submission_id="unknown-client",
            ambiguous_incident_id="unknown-incident",
            ambiguous_generation=TEST_GENERATION,
            active_turn_id="",
            interrupted_turn_id="",
            turn_done=None,
        )
        self.host._threads[TEST_ROOT] = SimpleNamespace(
            turn=self.turn,
            registration_epoch=1,
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=TEST_CHANGED_GENERATION,
        )
        self.session = object.__new__(CodexRuntimeSession)
        self.session._native = SimpleNamespace(host=self.host, session_id=TEST_ROOT)
        self.session._binding = RuntimeBinding(
            "confirmation-product", "codex", "1", "1", "1", "schema", TEST_ROOT, CapabilitySet()
        )
        self.session._admission_lock = asyncio.Lock()
        self.session._active_command_id = ""
        self.session._active_operations = 0
        self.session._tasks = set()
        self.session._suspend_receipt = None
        self.session._activity_revision = TEST_REVISION
        self.session._watermark = TEST_WATERMARK
        self.session._event_namespace = TEST_NAMESPACE
        self.session._confirmation_ticket = None
        self.session._confirmation_receipt = None
        self.session._confirmation_host = None
        self.session._confirmation_registration_epoch = 0
        self.session._confirmation_admission_epoch = 0
        self.target = TurnConfirmationTarget(
            "confirmation-product", TEST_ROOT, "unknown-client", "unknown-incident", TEST_GENERATION
        )
        self.inspection = patch(
            "scholarseed_codex.session.NativeActivity.inspect",
            new=AsyncMock(
                return_value=NativeActivityState(
                    True, (), (), (TEST_ROOT,), TEST_CHANGED_GENERATION
                )
            ),
        )
        self.inspection.start()
        self.addCleanup(self.inspection.stop)

    async def test_confirmation_bypasses_freeze_but_does_not_unfreeze_configuration(self) -> None:
        self.host.admission.freeze(1)
        ticket = await self.session.prepare_turn_confirmation(self.target)
        receipt = await self.session.commit_turn_confirmation(ticket, TEST_WATERMARK)
        self.assertIs(receipt.state, CommandState.APPLIED)
        self.assertFalse(self.turn.ambiguous_submission_id)
        self.assertFalse(self.host.admission.accepting)
        self.assertEqual(self.host.suspend_blockers(TEST_ROOT), ())

    async def test_mismatched_or_historical_targets_never_clear_ambiguity(self) -> None:
        for target in (
            replace(self.target, product_session_id="wrong-product"),
            replace(self.target, native_session_id="wrong-thread"),
            replace(self.target, client_submission_id="wrong-client"),
            replace(self.target, incident_id="wrong-incident"),
            replace(self.target, process_generation=0),
            replace(self.target, process_generation=TEST_CHANGED_GENERATION),
        ):
            with self.subTest(target=target), self.assertRaises(AppServerError):
                await self.session.prepare_turn_confirmation(target)
            self.assertEqual(self.turn.ambiguous_submission_id, self.target.client_submission_id)

    async def test_generation_change_without_physical_exit_is_not_proof(self) -> None:
        self.host._exited_generations.clear()
        with self.assertRaises(AppServerError):
            await self.session.prepare_turn_confirmation(self.target)

    async def test_unattached_or_active_native_turn_refuses_confirmation(self) -> None:
        attachment = self.host._threads[TEST_ROOT]
        for attribute, value in (
            ("attachment_state", CodexThreadAttachmentState.RESUMING),
            ("attached_generation", TEST_GENERATION),
        ):
            original = getattr(attachment, attribute)
            setattr(attachment, attribute, value)
            with self.subTest(attribute=attribute), self.assertRaises(AppServerError):
                await self.session.prepare_turn_confirmation(self.target)
            setattr(attachment, attribute, original)
        self.turn.active_turn_id = "real-active-turn"
        with self.assertRaises(AppServerError):
            await self.session.prepare_turn_confirmation(self.target)

    async def test_native_activity_must_be_complete_and_idle(self) -> None:
        for complete, blockers in (
            (False, ()),
            (True, ("native_background_terminal_active",)),
            (True, ("native_turn_active",)),
        ):
            with (
                patch(
                    "scholarseed_codex.session.NativeActivity.inspect",
                    new=AsyncMock(
                        return_value=NativeActivityState(
                            complete, blockers, (), (TEST_ROOT,), TEST_CHANGED_GENERATION
                        )
                    ),
                ),
                self.subTest(complete=complete, blockers=blockers),
                self.assertRaises(AppServerError),
            ):
                await self.session.prepare_turn_confirmation(self.target)

    async def test_stale_tickets_never_clear_new_activity(self) -> None:
        mutations = (
            lambda: self.host._record_activity(TEST_ROOT),
            lambda: self.host.admission.freeze(2),
            lambda: setattr(self.session, "_watermark", TEST_WATERMARK + 1),
            lambda: setattr(self.host._threads[TEST_ROOT], "registration_epoch", 2),
            lambda: setattr(self.turn, "ambiguous_submission_id", "new-client"),
        )
        for mutate in mutations:
            await self.asyncSetUp()
            ticket = await self.session.prepare_turn_confirmation(self.target)
            mutate()
            receipt = await self.session.commit_turn_confirmation(ticket, TEST_WATERMARK + 1)
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertTrue(self.turn.ambiguous_submission_id)

    async def test_unpersisted_or_forged_ticket_is_rejected(self) -> None:
        ticket = await self.session.prepare_turn_confirmation(self.target)
        for candidate, watermark in (
            (ticket, TEST_WATERMARK - 1),
            (replace(ticket, ticket_id="forged"), TEST_WATERMARK),
        ):
            receipt = await self.session.commit_turn_confirmation(candidate, watermark)
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertTrue(self.turn.ambiguous_submission_id)

    async def test_applied_confirmation_retry_never_clears_later_unknown(self) -> None:
        ticket = await self.session.prepare_turn_confirmation(self.target)
        receipt = await self.session.commit_turn_confirmation(ticket, TEST_WATERMARK)
        self.turn.ambiguous_submission_id = "later-client"
        self.turn.ambiguous_incident_id = "later-incident"
        self.turn.ambiguous_generation = TEST_CHANGED_GENERATION
        self.assertEqual(await self.session.prepare_turn_confirmation(self.target), ticket)
        self.assertEqual(
            await self.session.commit_turn_confirmation(ticket, TEST_WATERMARK), receipt
        )
        self.assertEqual(self.turn.ambiguous_submission_id, "later-client")


class CodexThreadReplacementContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.host = CodexProcessHost(launch_cwd=Path.cwd())
        self.host._generation = TEST_CHANGED_GENERATION
        self.host._proc = SimpleNamespace(returncode=None)
        self.host.state = CodexProcessState.READY
        self.host._exited_generations.append(TEST_GENERATION)
        self.turn = SimpleNamespace(
            ambiguous_submission_id="unknown-client",
            ambiguous_incident_id="unknown-incident",
            ambiguous_generation=TEST_GENERATION,
            active_turn_id="",
            interrupted_turn_id="previous-native-turn",
            interrupted_turn_client_id="unknown-client",
            interrupted_turn_generation=TEST_GENERATION,
            turn_done=None,
            replacement_sealed=False,
            submission_attempted=True,
            execution_observed=True,
        )
        self.turn.seal_replacement = Mock(
            side_effect=lambda: setattr(self.turn, "replacement_sealed", True)
        )
        self.incident = RuntimeIncident(
            "missing-thread-incident",
            RuntimeIncidentScope.THREAD,
            RuntimeIncidentState.FAILED,
            RuntimeIncidentKind.RESUME_FAILED,
            RuntimeRecoveryStrategy.MANUAL_RETRY,
            RuntimeRetryability.TERMINAL,
            THREAD_HISTORY_MISSING_ERROR,
            process_generation=TEST_CHANGED_GENERATION,
            vendor_thread_id=TEST_ROOT,
        )
        self.attachment = SimpleNamespace(
            thread_id=TEST_ROOT,
            turn=self.turn,
            registration_epoch=1,
            attachment_state=CodexThreadAttachmentState.BROKEN,
            attached_generation=0,
            absent_generation=TEST_CHANGED_GENERATION,
            disconnected_generation=TEST_GENERATION,
            attachment_incident=self.incident,
            history=("preserved product history",),
        )
        self.host._threads[TEST_ROOT] = self.attachment
        self.session = object.__new__(CodexRuntimeSession)
        self.session._native = SimpleNamespace(host=self.host, session_id=TEST_ROOT)
        self.session._binding = RuntimeBinding(
            "replacement-product", "codex", "1", "1", "1", "schema", TEST_ROOT, CapabilitySet()
        )
        self.session._admission_lock = asyncio.Lock()
        self.session._active_command_id = ""
        self.session._active_operations = 0
        self.session._tasks = set()
        self.session._suspend_receipt = None
        self.session._activity_revision = TEST_REVISION
        self.session._watermark = TEST_WATERMARK
        self.session._event_namespace = TEST_NAMESPACE
        self.session._replacement_ticket = None
        self.session._replacement_receipt = None
        self.session._replacement_host = None
        self.session._replacement_registration_epoch = 0
        self.session._replacement_admission_epoch = 0
        self.target = ThreadReplacementTarget(
            self.session.binding,
            "unknown-client",
            self.incident.incident_id,
            TEST_GENERATION,
        )
        self.inspection = patch(
            "scholarseed_codex.session.NativeActivity.inspect_absence",
            new=AsyncMock(
                return_value=NativeActivityState(True, (), (), (), TEST_CHANGED_GENERATION)
            ),
        )
        self.inspection.start()
        self.addCleanup(self.inspection.stop)

    async def test_replacement_seals_missing_nonempty_thread_without_erasing_unknown(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        self.assertEqual(ticket.proof.binding, self.session.binding)
        self.assertEqual(ticket.proof.command_id, self.target.command_id)
        self.assertEqual(ticket.proof.incident_id, self.incident.incident_id)
        self.assertEqual(ticket.proof.failed_generation, TEST_GENERATION)
        self.assertEqual(ticket.proof.absence_generation, TEST_CHANGED_GENERATION)
        self.assertEqual(ticket.proof.watermark, TEST_WATERMARK)
        self.assertFalse(self.turn.replacement_sealed)
        receipt = await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.assertIs(receipt.state, CommandState.APPLIED)
        self.assertTrue(self.turn.replacement_sealed)
        self.assertEqual(self.turn.ambiguous_submission_id, "unknown-client")
        self.assertEqual(self.turn.interrupted_turn_id, "previous-native-turn")
        self.assertTrue(self.turn.submission_attempted)
        self.assertTrue(self.turn.execution_observed)

    async def test_wrong_identity_and_unrelated_exited_generation_are_rejected(self) -> None:
        self.host._exited_generations.append(TEST_GENERATION + TEST_CHANGED_GENERATION)
        for target in (
            replace(self.target, binding=replace(self.target.binding, opaque_session_ref="other")),
            replace(self.target, command_id=""),
            replace(self.target, command_id="unrelated-client"),
            replace(self.target, incident_id="process-exit-incident"),
            replace(self.target, failed_generation=0),
            replace(self.target, failed_generation=TEST_CHANGED_GENERATION),
        ):
            with self.subTest(target=target), self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(target)
        self.assertFalse(self.turn.replacement_sealed)

    async def test_process_exit_and_exact_current_absence_are_required(self) -> None:
        mutations = (
            lambda: self.host._exited_generations.clear(),
            lambda: setattr(self.attachment, "disconnected_generation", 0),
            lambda: setattr(self.attachment, "absent_generation", TEST_GENERATION),
            lambda: setattr(
                self.attachment, "attachment_state", CodexThreadAttachmentState.ATTACHED
            ),
            lambda: setattr(self.host, "state", CodexProcessState.RECOVERING),
            lambda: setattr(self.host._proc, "returncode", 1),
            lambda: setattr(
                self.attachment, "attachment_incident", replace(self.incident, safe_error="other")
            ),
        )
        for mutate in mutations:
            await self.asyncSetUp()
            mutate()
            with self.subTest(mutation=mutate), self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(self.target)
            self.assertFalse(self.turn.replacement_sealed)

    async def test_pending_activity_and_callbacks_block_replacement(self) -> None:
        mutations = (
            lambda: setattr(self.turn, "active_turn_id", "still-active"),
            lambda: setattr(self.turn, "turn_done", asyncio.get_running_loop().create_future()),
            lambda: setattr(self.session, "_active_command_id", "still-active"),
            lambda: setattr(self.session, "_active_operations", 1),
            lambda: self.host._pending_hil.update(
                {"request": SimpleNamespace(thread_id=TEST_ROOT)}
            ),
            lambda: self.host._pending_tools.update(
                {"request": SimpleNamespace(thread_id=TEST_ROOT)}
            ),
        )
        for mutate in mutations:
            await self.asyncSetUp()
            mutate()
            with self.subTest(mutation=mutate), self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(self.target)

    async def test_absent_execution_tree_inspection_must_be_complete_and_idle(self) -> None:
        for complete, blockers in ((False, ()), (True, ("native_turn_active",))):
            with (
                patch(
                    "scholarseed_codex.session.NativeActivity.inspect_absence",
                    new=AsyncMock(
                        return_value=NativeActivityState(
                            complete, blockers, (), (), TEST_CHANGED_GENERATION
                        )
                    ),
                ),
                self.subTest(complete=complete, blockers=blockers),
                self.assertRaises(AppServerError),
            ):
                await self.session.prepare_thread_replacement(self.target)

    async def test_stale_unpersisted_and_forged_tickets_do_not_seal(self) -> None:
        mutations = (
            lambda: self.host._record_activity(TEST_ROOT),
            lambda: self.host.admission.freeze(2),
            lambda: setattr(self.session, "_watermark", TEST_WATERMARK + 1),
            lambda: setattr(self.attachment, "registration_epoch", 2),
            lambda: setattr(self.attachment, "absent_generation", 0),
            lambda: setattr(self.turn, "ambiguous_submission_id", "new-client"),
        )
        for mutate in mutations:
            await self.asyncSetUp()
            ticket = await self.session.prepare_thread_replacement(self.target)
            mutate()
            receipt = await self.session.commit_thread_replacement(ticket, TEST_WATERMARK + 1)
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertFalse(self.turn.replacement_sealed)
        await self.asyncSetUp()
        ticket = await self.session.prepare_thread_replacement(self.target)
        for candidate, watermark in (
            (ticket, TEST_WATERMARK - 1),
            (replace(ticket, proof=replace(ticket.proof, proof_id="forged")), TEST_WATERMARK),
        ):
            receipt = await self.session.commit_thread_replacement(candidate, watermark)
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertFalse(self.turn.replacement_sealed)

    async def test_applied_receipt_is_idempotent_without_resealing_later_state(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        receipt = await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.turn.ambiguous_submission_id = "later-unknown"
        self.assertEqual(await self.session.prepare_thread_replacement(self.target), ticket)
        self.assertEqual(
            await self.session.commit_thread_replacement(ticket, TEST_WATERMARK), receipt
        )
        self.turn.seal_replacement.assert_called_once()
        self.assertEqual(self.turn.ambiguous_submission_id, "later-unknown")

    async def test_prepare_waits_for_existing_host_recovery_before_minting_ticket(self) -> None:
        self.host.state = CodexProcessState.RECOVERING
        release = asyncio.Event()

        async def finish_recovery() -> None:
            await release.wait()
            self.host.state = CodexProcessState.READY

        recovering = asyncio.create_task(finish_recovery())
        self.host._recovery_task = recovering
        preparing = asyncio.create_task(self.session.prepare_thread_replacement(self.target))
        try:
            await asyncio.sleep(0)
            self.assertFalse(preparing.done())
            self.assertIsNone(self.session._replacement_ticket)
            release.set()
            ticket = await asyncio.wait_for(preparing, TEST_TIMEOUT_SECONDS)
            self.assertTrue(recovering.done())
            self.assertEqual(ticket.proof.absence_generation, TEST_CHANGED_GENERATION)
        finally:
            release.set()
            await asyncio.gather(recovering, preparing, return_exceptions=True)

    async def test_prepare_joins_original_submission_waiting_for_host_recovery(self) -> None:
        self.host.state = CodexProcessState.RECOVERING
        release_recovery = asyncio.Event()
        release_submission = asyncio.Event()
        submission_resumed = asyncio.Event()

        async def recover() -> None:
            await release_recovery.wait()
            self.host.state = CodexProcessState.READY

        async def original_submission() -> None:
            await self.host.start()
            submission_resumed.set()
            await release_submission.wait()
            self.session._active_command_id = ""

        recovering = asyncio.create_task(recover())
        self.host._recovery_task = recovering
        self.session._active_command_id = self.target.command_id
        submitting = asyncio.create_task(original_submission())
        self.session._tasks.add(submitting)
        preparing = asyncio.create_task(self.session.prepare_thread_replacement(self.target))
        try:
            await asyncio.sleep(0)
            self.assertFalse(preparing.done())
            release_recovery.set()
            await asyncio.wait_for(submission_resumed.wait(), TEST_TIMEOUT_SECONDS)
            self.assertFalse(preparing.done())
            self.assertIsNone(self.session._replacement_ticket)
            release_submission.set()
            ticket = await asyncio.wait_for(preparing, TEST_TIMEOUT_SECONDS)
            self.assertTrue(submitting.done())
            self.assertFalse(submitting.cancelled())
            self.assertEqual(ticket.proof.command_id, self.target.command_id)
        finally:
            release_recovery.set()
            release_submission.set()
            await asyncio.gather(recovering, submitting, preparing, return_exceptions=True)

    async def test_cancelled_prepare_does_not_cancel_original_submission(self) -> None:
        release_submission = asyncio.Event()

        async def original_submission() -> None:
            await release_submission.wait()
            self.session._active_command_id = ""

        self.session._active_command_id = self.target.command_id
        submitting = asyncio.create_task(original_submission())
        self.session._tasks.add(submitting)
        preparing = asyncio.create_task(self.session.prepare_thread_replacement(self.target))
        try:
            await asyncio.sleep(0)
            self.assertFalse(preparing.done())
            preparing.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await preparing
            self.assertFalse(submitting.done())
            self.assertFalse(self.turn.replacement_sealed)
        finally:
            release_submission.set()
            await asyncio.gather(submitting, preparing, return_exceptions=True)

    async def test_preparation_budget_never_cancels_original_submission(self) -> None:
        release_submission = asyncio.Event()

        async def original_submission() -> None:
            await release_submission.wait()
            self.session._active_command_id = ""

        self.host.recovery_total_timeout = 0.01
        self.session._active_command_id = self.target.command_id
        submitting = asyncio.create_task(original_submission())
        self.session._tasks.add(submitting)
        try:
            with self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(self.target)
            self.assertFalse(submitting.done())
            self.assertFalse(self.turn.replacement_sealed)
            self.assertIsNone(self.session._replacement_ticket)
        finally:
            release_submission.set()
            await asyncio.gather(submitting, return_exceptions=True)

    async def test_observation_changes_retry_inspection_within_existing_host_budget(self) -> None:
        calls = 0

        async def inspect_absence() -> NativeActivityState:
            nonlocal calls
            calls += 1
            if calls == 1:
                self.session._activity_revision += 1
                self.session._watermark += 1
            return NativeActivityState(True, (), (), (), TEST_CHANGED_GENERATION)

        with patch(
            "scholarseed_codex.session.NativeActivity.inspect_absence",
            new=AsyncMock(side_effect=inspect_absence),
        ):
            ticket = await self.session.prepare_thread_replacement(self.target)
        self.assertEqual(calls, 2)
        self.assertEqual(ticket.watermark, TEST_WATERMARK + 1)
        receipt = await self.session.commit_thread_replacement(ticket, ticket.watermark)
        self.assertIs(receipt.state, CommandState.APPLIED)

    async def test_cancelled_prepare_does_not_cancel_host_recovery_or_seal_attachment(self) -> None:
        self.host.state = CodexProcessState.RECOVERING
        release = asyncio.Event()

        async def finish_recovery() -> None:
            await release.wait()
            self.host.state = CodexProcessState.READY

        recovering = asyncio.create_task(finish_recovery())
        self.host._recovery_task = recovering
        preparing = asyncio.create_task(self.session.prepare_thread_replacement(self.target))
        try:
            await asyncio.sleep(0)
            preparing.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await preparing
            self.assertFalse(recovering.done())
            self.assertFalse(self.turn.replacement_sealed)
            self.assertIsNone(self.session._replacement_ticket)
        finally:
            release.set()
            await asyncio.gather(recovering, preparing, return_exceptions=True)

    async def test_configuration_change_during_inspection_is_not_retried(self) -> None:
        async def inspect_absence() -> NativeActivityState:
            self.host.admission.freeze(2)
            return NativeActivityState(True, (), (), (), TEST_CHANGED_GENERATION)

        with patch(
            "scholarseed_codex.session.NativeActivity.inspect_absence",
            new=AsyncMock(side_effect=inspect_absence),
        ) as inspect:
            with self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(self.target)
        self.assertEqual(inspect.await_count, 1)
        self.assertFalse(self.turn.replacement_sealed)

    async def test_repeated_observation_changes_exhaust_preparation_without_sealing(self) -> None:
        async def inspect_absence() -> NativeActivityState:
            self.session._watermark += 1
            return NativeActivityState(True, (), (), (), TEST_CHANGED_GENERATION)

        with patch(
            "scholarseed_codex.session.NativeActivity.inspect_absence",
            new=AsyncMock(side_effect=inspect_absence),
        ) as inspect:
            with self.assertRaises(AppServerError):
                await self.session.prepare_thread_replacement(self.target)
        self.assertEqual(inspect.await_count, self.host.max_recovery_attempts)
        self.assertFalse(self.turn.replacement_sealed)

    async def test_sealed_attachment_is_not_resumed_after_another_process_crash(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.host._generation += 1
        sibling = SimpleNamespace(
            thread_id="recoverable-sibling",
            attachment_state=CodexThreadAttachmentState.RECOVERY_PENDING,
            attachment_incident=None,
            absent_generation=0,
        )
        self.host._threads[sibling.thread_id] = sibling
        self.host._resume_thread = AsyncMock(return_value=True)
        self.assertTrue(
            await self.host._resume_registered_threads(self.host.process_generation, None)
        )
        self.host._resume_thread.assert_awaited_once_with(
            sibling, self.host.process_generation, None, process_reused=True
        )
        self.assertEqual(self.turn.ambiguous_submission_id, "unknown-client")
        self.assertEqual(self.turn.interrupted_turn_id, "previous-native-turn")
        self.assertIs(self.host._threads[TEST_ROOT], self.attachment)
        self.assertEqual(self.host._configuration_threads(), (sibling.thread_id,))

    async def test_ensure_attached_cannot_restart_a_sealed_attachment(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.host._generation += 1
        self.host.start = AsyncMock()
        self.host._resume_thread = AsyncMock(return_value=True)
        with self.assertRaises(AppServerError):
            await self.host.ensure_attached(TEST_ROOT)
        self.host.start.assert_not_awaited()
        self.host._resume_thread.assert_not_awaited()

    async def test_direct_resume_never_reopens_a_sealed_attachment(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.host._generation += 1
        self.host._proc.pid = 123
        self.attachment.attachment_lock = asyncio.Lock()
        self.attachment.mcp_invalidate = None
        self.attachment.request = CodexSessionOpenRequest(
            request_id="sealed-attachment",
            runtime_id="codex",
            cwd=Path.cwd(),
            model="selected",
            model_provider="provider",
        )
        self.turn.reconcile = AsyncMock()
        self.host._watcher.open = AsyncMock()
        self.host._prepare_thread_resources = AsyncMock()
        self.host._request_thread_attachment = AsyncMock(
            return_value={
                "thread": {"id": TEST_ROOT},
                "model": "selected",
                "modelProvider": "provider",
            }
        )
        self.host._emitter = SimpleNamespace(incident=AsyncMock(), emit=AsyncMock())
        self.assertFalse(
            await self.host._resume_thread(self.attachment, self.host.process_generation)
        )
        self.host._request_thread_attachment.assert_not_awaited()
        self.assertEqual(self.turn.ambiguous_submission_id, "unknown-client")

    async def test_closing_sealed_attachment_never_unsubscribes_a_later_generation(self) -> None:
        ticket = await self.session.prepare_thread_replacement(self.target)
        await self.session.commit_thread_replacement(ticket, TEST_WATERMARK)
        self.host._generation += 1
        self.attachment.permission_confirmation = None
        self.host._watcher.close = AsyncMock()
        self.turn.close = AsyncMock()
        self.host.request = AsyncMock(return_value={"status": "unsubscribed"})
        await self.host.close_thread(TEST_ROOT)
        self.host.request.assert_not_awaited()
        self.turn.close.assert_awaited_once_with(self.host.process_generation, False)
        self.assertEqual(self.turn.ambiguous_submission_id, "unknown-client")

    async def test_empty_thread_replacement_also_stays_closed_across_generations(self) -> None:
        self.attachment.fresh_generation = TEST_GENERATION
        self.attachment.history = ()
        self.turn.resume_turns = ()
        self.turn.submission_attempted = False
        self.turn.execution_observed = False
        self.turn.ambiguous_submission_id = ""
        self.turn.interrupted_turn_id = ""
        self.assertEqual(
            self.host.seal_empty_replacement(TEST_ROOT),
            (TEST_GENERATION, TEST_CHANGED_GENERATION),
        )
        self.host._generation += 1
        self.host._resume_thread = AsyncMock(return_value=True)
        await self.host._resume_registered_threads(self.host.process_generation, None)
        self.host._resume_thread.assert_not_awaited()
        with self.assertRaises(AppServerError):
            await self.host.ensure_attached(TEST_ROOT)
        self.assertEqual(self.host._configuration_threads(), ())


if __name__ == "__main__":
    unittest.main()
