"""Provider ownership and secret retention contracts, without a real model call."""

from __future__ import annotations

import asyncio
import gc
import os
import tempfile
import unittest
import weakref
from dataclasses import replace
from pathlib import Path
from time import time
from unittest.mock import AsyncMock, patch

from scholarseed_codex.environment import (
    SCHOLARSEED_CODEX_HOME_ENV,
    SCHOLARSEED_CODEX_SOURCE_HOME_ENV,
)
from scholarseed_codex.protocol.session import CodexRuntimeReadiness, CodexRuntimeStatus
from scholarseed_codex.protocol.state import AppServerError, CodexActivationStage
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_runtime.contract import CommandState, OpenSessionRequest, ResumeSessionRequest
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import CapabilitySet
from scholarseed_runtime.contract.command import (
    InventoryRequest,
    RuntimeInspectionRequest,
    SkillConfigurationRequest,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_RESERVATION_INVALID,
    ResourcePurpose,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from tests.contract_codex_capacity import ControlledHost, TimingRecorder

WAIT_SECONDS = 0.05
SETTLEMENT_SECONDS = 0.2


class CodexAdmissionContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="provider-admission-")
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(
            os.environ,
            {
                SCHOLARSEED_CODEX_HOME_ENV: str(self.root / "runtime"),
                SCHOLARSEED_CODEX_SOURCE_HOME_ENV: str(self.root / "source"),
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.temporary.cleanup)
        readiness = CodexRuntimeReadiness(
            runtime_id="codex",
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable="/contract/codex",
            version="0.154.0",
        )
        self.probe = patch(
            "scholarseed_codex.pool._probe_codex_cli_readiness", AsyncMock(return_value=readiness)
        )
        self.host = patch("scholarseed_codex.pool.CodexProcessHost", ControlledHost)
        self.probe.start()
        self.host.start()
        self.addCleanup(self.probe.stop)
        self.addCleanup(self.host.stop)
        self.provider = CodexRuntimeProvider()
        self.configuration = ProviderConfiguration(
            "codex", {"capacity": {"wait_seconds": WAIT_SECONDS}}
        )
        self.assertIs(self.provider.configure(self.configuration).state, CommandState.APPLIED)
        self.addAsyncCleanup(self.provider.shutdown)

    def request(self, request_id: str = "admission") -> ResourceRequest:
        return ResourceRequest(
            request_id,
            ResourcePurpose.SESSION,
            time() + 10,
            OpenSessionRequest("product-session", self.root),
        )

    def test_timing_is_excluded_from_request_equality_and_repr(self) -> None:
        binding = RuntimeBinding(
            product_session_id="timed-session",
            runtime_id="codex",
            adapter_version="",
            runtime_version="",
            protocol_version="",
            protocol_schema_hash="",
            opaque_session_ref="timed-thread",
            capabilities=CapabilitySet(),
        )
        requests = (
            OpenSessionRequest(binding.product_session_id, self.root),
            ResumeSessionRequest(binding, self.root),
            RuntimeInspectionRequest(self.root, InventoryRequest(())),
            SkillConfigurationRequest(self.root, ()),
        )
        for request in requests:
            with self.subTest(request=type(request).__name__):
                timed = replace(request, timing=TimingRecorder())
                repeated = replace(request, timing=TimingRecorder())
                self.assertEqual(timed, request)
                self.assertEqual(timed, repeated)
                self.assertEqual(repr(timed), repr(request))
                self.assertEqual(repr(timed), repr(repeated))
                if isinstance(timed, (OpenSessionRequest, ResumeSessionRequest)):
                    self.assertIs(self.provider._open_request(timed).timing, timed.timing)

    async def test_provider_retry_with_new_timing_preserves_reservation(self) -> None:
        request = self.request("timed-idempotence")
        timed = replace(
            request, session_request=replace(request.session_request, timing=TimingRecorder())
        )
        receipt = await self.provider.reserve(timed)
        repeated = await self.provider.reserve(
            replace(timed, session_request=replace(timed.session_request, timing=TimingRecorder()))
        )
        self.assertEqual(receipt.reservation_id, repeated.reservation_id)
        await self.provider.cancel_resource(receipt.reservation_id)
        terminal = await self.provider.reserve(request)
        self.assertEqual(terminal.reservation_id, receipt.reservation_id)
        self.assertIs(terminal.state, ResourceState.CANCELLED)

    async def test_cancelled_prepare_wait_does_not_release_another_owners_lock(self) -> None:
        timing = TimingRecorder()
        request = self.request("timed-lock-cancel")
        request = replace(request, session_request=replace(request.session_request, timing=timing))
        await self.provider._prepare_lock.acquire()
        waiter = asyncio.create_task(self.provider.reserve(request))
        try:
            await asyncio.wait_for(
                timing.signal(CodexActivationStage.PREPARE_LOCK_WAIT).wait(), SETTLEMENT_SECONDS
            )
            self.assertFalse(waiter.done())
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertTrue(self.provider._prepare_lock.locked())
            self.assertEqual(
                timing.finished,
                [(CodexActivationStage.PREPARE_LOCK_WAIT, asyncio.CancelledError)],
            )
            self.assertNotIn(CodexActivationStage.LAUNCH_CREDENTIALS, timing.entered)
        finally:
            self.provider._prepare_lock.release()
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
        receipt = await self.provider.reserve(self.request("after-timed-cancel"))
        self.assertIs(receipt.state, ResourceState.GRANTED)
        await self.provider.cancel_resource(receipt.reservation_id)

    async def test_unclaimed_expiry_releases_prepared_session_and_preserves_receipt(self) -> None:
        request = self.request()
        receipt = await self.provider.reserve(request)
        session = weakref.ref(self.provider._prepared[receipt.reservation_id][1])
        await asyncio.sleep(SETTLEMENT_SECONDS)
        self.assertEqual(self.provider._prepared, {})
        gc.collect()
        self.assertIsNone(session())
        self.assertIs(
            (await self.provider.wait_resource(receipt.reservation_id)).state, ResourceState.EXPIRED
        )
        self.assertIs(
            (await self.provider.cancel_resource(receipt.reservation_id)).state,
            ResourceState.EXPIRED,
        )
        repeated = await self.provider.reserve(request)
        self.assertEqual(repeated.reservation_id, receipt.reservation_id)
        self.assertIs(repeated.state, ResourceState.EXPIRED)

    async def test_terminal_request_identity_cannot_be_reassigned(self) -> None:
        request = self.request()
        receipt = await self.provider.reserve(request)
        await self.provider.cancel_resource(receipt.reservation_id)
        changed = replace(
            request, session_request=replace(request.session_request, product_session_id="other")
        )
        with self.assertRaises(AppServerError):
            await self.provider.reserve(changed)

    async def test_duplicate_materialization_cannot_close_the_winning_session(self) -> None:
        resource = self.request("duplicate-materialization")
        receipt = await self.provider.reserve(resource)
        session = self.provider._prepared[receipt.reservation_id][1]
        request = replace(resource.session_request, reservation_id=receipt.reservation_id)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def open_session() -> None:
            entered.set()
            await release.wait()

        with patch.object(session, "open", open_session):
            winner = asyncio.create_task(self.provider.open(request))
            try:
                await asyncio.wait_for(entered.wait(), SETTLEMENT_SECONDS)
                lease = session._native.lease
                self.assertIsNotNone(lease)
                with self.assertRaises(AppServerError) as duplicate:
                    await self.provider.open(request)
                self.assertEqual(duplicate.exception.safe_error, RESOURCE_RESERVATION_INVALID)
                self.assertIs(session._native.lease, lease)
                self.assertFalse(lease.host.closed)
                self.assertEqual(self.provider._pool.snapshot()[0].used, 1)
                release.set()
                self.assertIs(await asyncio.wait_for(winner, SETTLEMENT_SECONDS), session)
                with self.assertRaises(AppServerError) as repeated:
                    await self.provider.open(request)
                self.assertEqual(repeated.exception.safe_error, RESOURCE_RESERVATION_INVALID)
                self.assertIs(session._native.lease, lease)
                self.assertFalse(lease.host.closed)
            finally:
                release.set()
                await asyncio.gather(winner, return_exceptions=True)
                await session.detach()
        self.assertEqual(self.provider._pool.snapshot()[0].used, 0)

    async def test_mismatched_request_cannot_claim_another_prepared_session(self) -> None:
        resource = self.request("invalid-materialization")
        receipt = await self.provider.reserve(resource)
        prepared = self.provider._prepared[receipt.reservation_id]
        invalid = replace(
            resource.session_request,
            product_session_id="different-session",
            reservation_id=receipt.reservation_id,
        )
        with self.assertRaises(AppServerError) as caught:
            await self.provider.open(invalid)
        self.assertEqual(caught.exception.safe_error, RESOURCE_RESERVATION_INVALID)
        self.assertIs(self.provider._prepared[receipt.reservation_id], prepared)
        self.assertIsNone(prepared[1]._native.lease)
        await self.provider.cancel_resource(receipt.reservation_id)

    async def test_configuration_is_idempotent_but_cannot_change_live_budgets(self) -> None:
        self.assertIs(self.provider.configure(self.configuration).state, CommandState.APPLIED)
        changed = ProviderConfiguration("codex", {"capacity": {"execution_hosts": 6}})
        self.assertIs(self.provider.configure(changed).state, CommandState.REJECTED)


if __name__ == "__main__":
    unittest.main()
