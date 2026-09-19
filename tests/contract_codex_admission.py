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
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_runtime.contract import CommandState, OpenSessionRequest
from scholarseed_runtime.contract.resource import (
    RESOURCE_RESERVATION_INVALID,
    ResourcePurpose,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from tests.contract_codex_capacity import ControlledHost

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
