"""Shutdown budgets, failure boundaries and private listener logging contracts."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import uvicorn
from fastapi import APIRouter, FastAPI

from service.platform.activity import Activities, ActivityPhase
from service.platform.local import UNIX_SOCKET_FAMILY, local_listener
from service.platform.server import ProductServer
from service.platform.shutdown import Shutdown
from tests._directories import LEASE_TEST_ROOT_ENV


class ShutdownContracts(unittest.IsolatedAsyncioTestCase):
    def server(self, seconds):
        domains = Mock()
        server = ProductServer(
            uvicorn.Config(FastAPI(), log_config=None, log_level=None),
            Activities(),
            domains=domains,
            shutdown_seconds=seconds,
        )
        server.lifespan = Mock()
        return server, domains

    async def test_total_deadline_covers_lifespan_and_retains_storage_on_timeout(self):
        server, domains = self.server(0.04)

        async def lifespan(_server, _sockets):
            await asyncio.sleep(1)

        with (
            patch.object(uvicorn.Server, "shutdown", lifespan),
            self.assertLogs("service.platform.shutdown", level="INFO") as logs,
        ):
            with self.assertRaises(TimeoutError):
                await server.shutdown()
        domains.close.assert_not_called()
        self.assertFalse(server._storage_released)
        events = [json.loads(record.getMessage().split(" ", 1)[1]) for record in logs.records]
        self.assertEqual(events[-1]["event"], "failed")
        self.assertNotIn("complete", [event["event"] for event in events])

    async def test_eof_deadline_is_not_restarted_when_shutdown_begins(self):
        server, domains = self.server(0.04)
        server._parent_closed(False)
        deadline = server._shutdown.deadline
        await asyncio.sleep(0.06)
        with patch.object(uvicorn.Server, "shutdown", AsyncMock()):
            with self.assertRaises(TimeoutError):
                await server.shutdown()
        self.assertEqual(server._shutdown.deadline, deadline)
        domains.close.assert_not_called()

    async def test_success_releases_storage_last_and_reports_completion(self):
        server, domains = self.server(1)

        async def draining(_server, _sockets):
            domains.close.assert_not_called()
            await asyncio.sleep(0)

        with (
            patch.object(uvicorn.Server, "shutdown", draining),
            self.assertLogs("service.platform.shutdown", level="INFO") as logs,
        ):
            await server.shutdown()
        domains.close.assert_called_once()
        self.assertTrue(server._storage_released)
        self.assertIn('"event": "complete"', logs.records[-1].getMessage())

    async def test_failed_owner_does_not_release_storage(self):
        server, domains = self.server(1)
        with patch.object(
            uvicorn.Server, "shutdown", AsyncMock(side_effect=RuntimeError("owner failed"))
        ):
            with self.assertRaisesRegex(RuntimeError, "owner failed"):
                await server.shutdown()
        domains.close.assert_not_called()

    async def test_model_producer_stops_before_http_drain_and_storage_release(self):
        server, domains = self.server(1)
        producer_closed = asyncio.Event()

        async def close_producer():
            domains.close.assert_not_called()
            producer_closed.set()

        async def drain(_server, _sockets):
            await producer_closed.wait()
            domains.close.assert_not_called()

        server._close_model_streams = close_producer
        with patch.object(uvicorn.Server, "shutdown", drain):
            await server.shutdown()
        domains.close.assert_called_once()

    async def test_failed_model_shutdown_keeps_storage_and_does_not_report_clean_drain(self):
        server, domains = self.server(1)
        server._close_model_streams = AsyncMock(side_effect=OSError("stream close failed"))
        with patch.object(uvicorn.Server, "shutdown", AsyncMock()) as drain:
            with self.assertRaisesRegex(OSError, "stream close failed"):
                await server.shutdown()
        drain.assert_not_awaited()
        domains.close.assert_not_called()

    async def test_active_turns_stop_before_model_streams_disconnect(self):
        server, domains = self.server(1)
        actions = []

        async def interrupt():
            self.assertIs(server._activities.snapshot().phase, ActivityPhase.DRAINING)
            actions.append("interrupted")

        async def close_models():
            self.assertEqual(actions, ["interrupted"])
            actions.append("models-closed")

        server._interrupt_running = interrupt
        server._close_model_streams = close_models
        with patch.object(uvicorn.Server, "shutdown", AsyncMock()):
            await server.shutdown()
        self.assertEqual(actions, ["interrupted", "models-closed"])
        domains.close.assert_called_once()

    async def test_private_listener_preserves_shared_logging_configuration(self):
        names = ("uvicorn.error", "uvicorn.access", "uvicorn.asgi", "")
        before = [
            (
                logging.getLogger(name),
                logging.getLogger(name).level,
                tuple(logging.getLogger(name).handlers),
                logging.getLogger(name).propagate,
            )
            for name in names
        ]
        # A suite TMPDIR already includes its own random child directory. Keep
        # socket fixtures directly under the explicitly owned root instead of
        # stacking that path with both fixture and listener random directories.
        with tempfile.TemporaryDirectory(
            prefix="uds-", dir=os.environ.get(LEASE_TEST_ROOT_ENV)
        ) as directory:
            root = Path(directory).resolve(strict=True)
            endpoint = None
            async with local_listener(APIRouter(), root) as endpoint:
                if os.name == "nt" or UNIX_SOCKET_FAMILY is None:
                    self.assertIsNone(endpoint)
                else:
                    self.assertTrue(endpoint.is_socket())
                    self.assertEqual(endpoint.parent.parent, root)
                for logger, level, handlers, propagate in before:
                    self.assertEqual(logger.level, level)
                    self.assertEqual(tuple(logger.handlers), handlers)
                    self.assertEqual(logger.propagate, propagate)
            if endpoint is not None:
                self.assertFalse(endpoint.exists())
                self.assertFalse(endpoint.parent.exists())
        self.assertFalse(root.exists())

    def test_non_finite_or_non_positive_budget_is_rejected(self):
        for budget in (0, -1, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                Shutdown(budget)


class ShutdownProcessContracts(unittest.TestCase):
    def test_real_lifespan_timeout_exits_nonzero_without_releasing_storage(self):
        program = """
import asyncio, logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
import uvicorn
from service.platform.activity import Activities
from service.platform.server import ProductServer
logging.basicConfig(level=logging.INFO)
class Storage:
    def close(self):
        print('storage-released', flush=True)
@asynccontextmanager
async def lifespan(app):
    print('ready', flush=True)
    yield
    with app.state.shutdown.stage('slow-owner'):
        await asyncio.sleep(10)
ProductServer(uvicorn.Config(FastAPI(lifespan=lifespan), port=0, log_level='warning'),
              Activities(), domains=Storage(), parent_stdin=True, shutdown_seconds=.25).run()
"""
        with subprocess.Popen(
            [sys.executable, "-c", program],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ) as process:
            try:
                self.assertEqual(process.stdout.readline().strip(), b"ready")
                output, errors = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0)
                self.assertNotIn(b"storage-released", output)
                self.assertIn(b'"event": "failed"', errors)
                self.assertNotIn(b'"event": "complete"', errors)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
