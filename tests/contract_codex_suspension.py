"""Adapter suspension state contracts; fixtures do not constitute product acceptance."""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_codex.activity import NativeActivityState
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.state import (
    AppServerError,
    CodexProcessState,
    CodexThreadAttachmentState,
)
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract import CapabilitySet, RuntimeBinding
from scholarseed_runtime.contract.command import ArchiveRequest, CommandState
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_STALE,
    RuntimeActivitySnapshot,
    SuspendState,
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


if __name__ == "__main__":
    unittest.main()
