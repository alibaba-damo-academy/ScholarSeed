"""Adapter suspension state contracts; fixtures do not constitute product acceptance."""

from __future__ import annotations

import asyncio
import unittest
from dataclasses import replace
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.session import CodexRuntimeSession
from scholarseed_runtime.contract.command import ArchiveRequest
from scholarseed_runtime.contract.resource import ResourceEvidence
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_STALE,
    RuntimeActivitySnapshot,
    SuspendState,
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


if __name__ == "__main__":
    unittest.main()
