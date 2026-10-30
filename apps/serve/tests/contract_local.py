"""Real Unix HTTP transport shutdown contracts, not Desktop acceptance."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from contextlib import AsyncExitStack
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import APIRouter

from service.platform.local import UNIX_SOCKET_FAMILY, local_listener


@unittest.skipUnless(os.name != "nt" and UNIX_SOCKET_FAMILY is not None, "Unix listener only")
class LocalShutdownContract(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_owner_cancellation_waits_for_request_completion(self) -> None:
        entered, release, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()
        router = APIRouter()

        @router.get("/work")
        async def work():
            entered.set()
            try:
                await release.wait()
                return {"ok": True}
            finally:
                finished.set()

        with tempfile.TemporaryDirectory(prefix="local-drain-", dir="/tmp") as directory:
            listener = AsyncExitStack()
            endpoint = await listener.enter_async_context(local_listener(router, Path(directory)))
            async with httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=str(endpoint)),
                base_url="http://localhost",
                trust_env=False,
            ) as client:
                request = asyncio.create_task(client.get("/work"))
                await asyncio.wait_for(entered.wait(), 2)
                closing = asyncio.create_task(listener.aclose())
                try:
                    await asyncio.sleep(0.15)
                    closing.cancel()
                    await asyncio.sleep(0.05)
                    closing.cancel()
                    await asyncio.sleep(0.05)
                    self.assertFalse(
                        closing.done(), "listener claimed completion with a live request"
                    )
                    release.set()
                    response = await asyncio.wait_for(request, 2)
                    self.assertEqual(response.status_code, 200)
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(closing, 2)
                    self.assertTrue(finished.is_set())
                    self.assertFalse(endpoint.exists())
                finally:
                    release.set()
                    await asyncio.gather(request, closing, return_exceptions=True)

    async def test_grace_timeout_with_live_request_is_failure(self) -> None:
        entered, release, cancelled, finished = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        router = APIRouter()

        @router.get("/work")
        async def work():
            entered.set()
            try:
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    await release.wait()
                return {"ok": True}
            finally:
                finished.set()

        with (
            tempfile.TemporaryDirectory(prefix="local-timeout-", dir="/tmp") as directory,
            patch("service.platform.local.STOP_TIMEOUT_SECONDS", 0.05),
        ):
            listener = AsyncExitStack()
            endpoint = await listener.enter_async_context(local_listener(router, Path(directory)))
            async with httpx.AsyncClient(
                transport=httpx.AsyncHTTPTransport(uds=str(endpoint)),
                base_url="http://localhost",
                trust_env=False,
            ) as client:
                request = asyncio.create_task(client.get("/work"))
                await asyncio.wait_for(entered.wait(), 2)
                closing = asyncio.create_task(listener.aclose())
                try:
                    with self.assertRaisesRegex(RuntimeError, "local_listener_shutdown_incomplete"):
                        await asyncio.wait_for(closing, 2)
                    self.assertFalse(finished.is_set())
                finally:
                    release.set()
                    await asyncio.gather(request, closing, return_exceptions=True)
                self.assertTrue(cancelled.is_set())
                self.assertTrue(finished.is_set())


if __name__ == "__main__":
    unittest.main()
