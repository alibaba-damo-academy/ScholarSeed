"""Passive observers close only after execution drains and cleanup finishes."""

from __future__ import annotations

import asyncio
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import httpx
import uvicorn
from fastapi import FastAPI
from starlette.responses import StreamingResponse
from uvicorn.config import STARTUP_FAILURE

from service.platform.activity import Activities, ActivityDomain
from service.platform.passive_events import passive_events
from service.platform.server import ProductServer


class StorageCloseProbe:
    def __init__(self):
        self.closed = False

    def close(self):
        if self.closed:
            raise AssertionError("storage closed twice")
        self.closed = True


class ServerExitContract(unittest.TestCase):
    def test_interruption_before_storage_release_is_not_success(self):
        storage = StorageCloseProbe()
        server = ProductServer(uvicorn.Config(FastAPI()), Activities(), domains=storage)
        with patch.object(uvicorn.Server, "run", side_effect=KeyboardInterrupt):
            with self.assertRaisesRegex(RuntimeError, "serve_shutdown_incomplete"):
                server.run()
        self.assertFalse(storage.closed)

    def test_failed_lifespan_cleanup_is_not_a_successful_process_exit(self):
        program = """
import asyncio, sys
from contextlib import asynccontextmanager
from fastapi import FastAPI
import uvicorn
from service.platform.activity import Activities
from service.platform.server import ProductServer


class StorageCloseProbe:
    def __init__(self):
        self.closed = False

    def close(self):
        if self.closed:
            raise AssertionError("storage closed twice")
        self.closed = True
@asynccontextmanager
async def lifespan(app):
    print('ready', flush=True)
    yield
    print('cleanup-started', flush=True)
    if sys.argv[1] == 'cancel':
        raise asyncio.CancelledError('cleanup cancelled')
    raise OSError('cleanup failed')
ProductServer(uvicorn.Config(FastAPI(lifespan=lifespan), port=0, log_level='warning'), Activities(), domains=StorageCloseProbe(), parent_stdin=True).run()
print('returned-successfully', flush=True)
"""
        for failure in ("error", "cancel"):
            with (
                self.subTest(failure=failure),
                subprocess.Popen(
                    [sys.executable, "-c", program, failure],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                ) as process,
            ):
                try:
                    self.assertEqual(process.stdout.readline().rstrip(b"\r\n"), b"ready")
                    output, errors = process.communicate(timeout=10)
                    self.assertIn(b"cleanup-started", output)
                    self.assertNotEqual(process.returncode, 0, errors.decode())
                    self.assertNotIn(b"returned-successfully", output)
                    self.assertIn(b"serve_shutdown_incomplete", errors)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)

    def test_inherited_pipe_eof_runs_actual_lifespan_cleanup(self):
        program = """
import asyncio, sys
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
import uvicorn
from service.platform.activity import Activities
from service.platform.server import ProductServer


class StorageCloseProbe:
    def __init__(self):
        self.closed = False

    def close(self):
        if self.closed:
            raise AssertionError("storage closed twice")
        self.closed = True
@asynccontextmanager
async def lifespan(app):
    print('ready', flush=True)
    yield
    await asyncio.sleep(.1)
    Path(sys.argv[1]).write_text('closed')
ProductServer(uvicorn.Config(FastAPI(lifespan=lifespan), port=0, log_level='warning'), Activities(), domains=StorageCloseProbe(), parent_stdin=True).run()
"""
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "closed"
            with subprocess.Popen(
                [sys.executable, "-c", program, str(marker)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ) as process:
                try:
                    self.assertEqual(process.stdout.readline().rstrip(b"\r\n"), b"ready")
                    self.assertIsNone(process.poll())
                    self.assertFalse(marker.exists())
                    process.stdin.close()
                    process.wait(timeout=10)
                    self.assertEqual(process.returncode, 0, process.stderr.read().decode())
                    self.assertEqual(marker.read_text(), "closed")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=5)

    def test_lifespan_startup_failure_keeps_uvicorn_failure_exit_code(self):
        @asynccontextmanager
        async def lifespan(_app):
            raise RuntimeError("intentional startup failure")
            yield

        server = ProductServer(
            uvicorn.Config(FastAPI(lifespan=lifespan), port=0, log_level="warning"),
            Activities(),
            domains=StorageCloseProbe(),
        )
        with self.assertLogs("uvicorn.error", level="ERROR"):
            with self.assertRaises(SystemExit) as error:
                server.run()
        self.assertEqual(error.exception.code, STARTUP_FAILURE)
        self.assertFalse(server.started)


class PassiveEventContract(unittest.IsolatedAsyncioTestCase):
    async def test_finished_http_request_does_not_hide_live_thread_writer(self):
        await self.writer_shutdown(drain=False)

    async def test_lifespan_joined_thread_allows_normal_shutdown(self):
        await self.writer_shutdown(drain=True)

    async def writer_shutdown(self, *, drain: bool):
        fixture = tempfile.TemporaryDirectory(prefix="shutdown-writer-")
        self.addCleanup(fixture.cleanup)
        marker = Path(fixture.name) / "result.txt"
        gate = Activities()
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()

        def write():
            entered.set()
            release.wait(5)
            marker.write_text("writer completed", encoding="utf-8")
            finished.set()

        @asynccontextmanager
        async def lifespan(_app):
            yield
            if drain:
                release.set()
                async with asyncio.timeout(5):
                    while gate.snapshot().counts:
                        await asyncio.sleep(0.001)

        app = FastAPI(lifespan=lifespan)
        writer = None

        @app.post("/start")
        async def start():
            nonlocal writer
            writer = asyncio.create_task(gate.to_thread(ActivityDomain.RESOURCE, write))
            while not entered.is_set():
                await asyncio.sleep(0.001)
            writer.cancel()
            await asyncio.gather(writer, return_exceptions=True)
            return {"accepted": True}

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            storage = StorageCloseProbe()
            server = ProductServer(uvicorn.Config(app, log_level="warning"), gate, domains=storage)
            task = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                async with asyncio.timeout(5):
                    while not server.started:
                        if task.done():
                            await task
                        await asyncio.sleep(0)
                    async with httpx.AsyncClient(trust_env=False) as client:
                        response = await client.post(
                            f"http://127.0.0.1:{listener.getsockname()[1]}/start"
                        )
                        self.assertEqual(response.status_code, 200)
                    server.should_exit = True
                    if drain:
                        await task
                    else:
                        with self.assertRaisesRegex(RuntimeError, "serve_shutdown_incomplete"):
                            await task
                    self.assertFalse(server.server_state.tasks)
                    self.assertFalse(server.lifespan.shutdown_failed)
                    self.assertEqual(storage.closed, drain)
                    self.assertEqual(finished.is_set(), drain)
                    self.assertEqual(marker.exists(), drain)
                    self.assertEqual(gate.snapshot().counts, {} if drain else {"resource": 1})
            finally:
                release.set()
                server.should_exit = True
                await asyncio.gather(task, return_exceptions=True)
                async with asyncio.timeout(5):
                    while gate.snapshot().counts:
                        await asyncio.sleep(0.001)
            self.assertTrue(finished.is_set())
            self.assertEqual(marker.read_text(encoding="utf-8"), "writer completed")

    async def test_http_timeout_does_not_certify_unfinished_request_cleanup(self):
        entered, cleaning, release, closed = (asyncio.Event() for _ in range(4))
        app = FastAPI()

        @app.get("/pending")
        async def pending():
            entered.set()
            try:
                await asyncio.Future()
            finally:
                cleaning.set()
                await release.wait()
                closed.set()

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            server = ProductServer(
                uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=0),
                Activities(),
                domains=StorageCloseProbe(),
            )
            task = asyncio.create_task(server.serve(sockets=[listener]))
            async with httpx.AsyncClient(trust_env=False) as client:
                request = None
                try:
                    async with asyncio.timeout(5):
                        while not server.started:
                            if task.done():
                                await task
                            await asyncio.sleep(0)
                        request = asyncio.create_task(
                            client.get(f"http://127.0.0.1:{listener.getsockname()[1]}/pending")
                        )
                        await entered.wait()
                        server.should_exit = True
                        with self.assertRaisesRegex(RuntimeError, "serve_shutdown_incomplete"):
                            await task
                        self.assertTrue(cleaning.is_set())
                        self.assertFalse(closed.is_set())
                finally:
                    release.set()
                    server.should_exit = True
                    await asyncio.gather(task, return_exceptions=True)
                    if request is not None:
                        await asyncio.wait_for(request, 5)
        self.assertTrue(closed.is_set())

    async def test_forced_exit_cannot_report_completed_lifespan_cleanup(self):
        closed = asyncio.Event()

        async def stop():
            while not server.started:
                await asyncio.sleep(0)
            server.force_exit = True
            server.should_exit = True

        @asynccontextmanager
        async def lifespan(_app):
            stopper = asyncio.create_task(stop())
            yield
            await stopper
            closed.set()

        server = ProductServer(
            uvicorn.Config(FastAPI(lifespan=lifespan), port=0, log_level="warning"),
            Activities(),
            domains=StorageCloseProbe(),
        )
        try:
            with self.assertRaisesRegex(RuntimeError, "serve_shutdown_incomplete"):
                await server.serve()
            self.assertFalse(closed.is_set())
        finally:
            await server.lifespan.shutdown()
        self.assertTrue(closed.is_set())

    async def test_server_stop_closes_observers_without_releasing_execution(self):
        gate = Activities()
        execution = gate.enter(ActivityDomain.TURN)
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def source():
            try:
                entered.set()
                await asyncio.Future()
                yield "unreachable"
            finally:
                cleaning.set()
                await release.wait()

        async def consume():
            with gate.observe_request():
                async for _ in passive_events(source(), gate):
                    self.fail("unexpected event")

        task = asyncio.create_task(consume())
        await asyncio.wait_for(entered.wait(), 2)
        try:
            gate.stop_observers()
            await asyncio.wait_for(cleaning.wait(), 2)
            self.assertFalse(task.done())
            self.assertEqual(gate.snapshot().counts, {"turn": 1, "request": 1})
            generation = gate.begin()
            self.assertFalse(gate.seal(generation))
            release.set()
            await asyncio.wait_for(task, 2)
            self.assertEqual(gate.snapshot().counts, {"turn": 1})
            self.assertFalse(gate.seal(generation))
        finally:
            release.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            execution.close()

    async def test_http_shutdown_ends_open_sse_before_lifespan(self):
        gate = Activities()
        closed, lifespan_closed = asyncio.Event(), asyncio.Event()

        @asynccontextmanager
        async def lifespan(_app):
            yield
            self.assertTrue(closed.is_set())
            lifespan_closed.set()

        app = FastAPI(lifespan=lifespan)

        async def source():
            try:
                yield "data: connected\n\n"
                await asyncio.Future()
            finally:
                closed.set()

        @app.get("/events")
        async def events():
            return StreamingResponse(passive_events(source(), gate), media_type="text/event-stream")

        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            storage = StorageCloseProbe()
            server = ProductServer(uvicorn.Config(app, log_level="warning"), gate, domains=storage)
            task = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                async with asyncio.timeout(5):
                    while not server.started:
                        if task.done():
                            await task
                            self.fail("server exited before startup")
                        await asyncio.sleep(0.01)
                    async with httpx.AsyncClient(trust_env=False) as client:
                        url = f"http://127.0.0.1:{listener.getsockname()[1]}/events"
                        async with client.stream("GET", url) as response:
                            self.assertEqual(response.status_code, 200)
                            self.assertEqual(await anext(response.aiter_lines()), "data: connected")
                            server.should_exit = True
                            await asyncio.shield(task)
                            self.assertTrue(lifespan_closed.is_set())
            finally:
                server.should_exit = True
                await asyncio.wait_for(task, 5)

    async def test_server_stop_is_sticky_and_instance_local(self):
        stopped, other = Activities(), Activities()
        stopped.stop_observers()
        stopped.stop_observers()
        await asyncio.wait_for(stopped.wait_observers_stopped(), 2)
        waiter = asyncio.create_task(other.wait_observers_stopped())
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        waiter.cancel()
        await asyncio.gather(waiter, return_exceptions=True)

    async def test_cancelled_thread_waiter_does_not_close_observers_early(self):
        gate = Activities()
        started, release = threading.Event(), threading.Event()

        def write():
            started.set()
            release.wait(5)

        caller = asyncio.create_task(gate.to_thread(ActivityDomain.RESOURCE, write))
        while not started.is_set():
            await asyncio.sleep(0.001)
        generation = gate.begin()
        waiter = asyncio.create_task(gate.wait_execution_drained())
        try:
            caller.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await caller
            await asyncio.sleep(0)
            self.assertFalse(waiter.done())
        finally:
            release.set()
        self.assertEqual(await asyncio.wait_for(waiter, 2), generation)

    async def test_running_turn_keeps_hil_events_available_until_completion(self):
        gate = Activities()
        turn = gate.enter(ActivityDomain.TURN)
        queue = asyncio.Queue()
        listening, closed = asyncio.Event(), asyncio.Event()

        async def source():
            try:
                listening.set()
                while True:
                    yield await queue.get()
            finally:
                closed.set()

        stream = passive_events(source(), gate)
        first = asyncio.create_task(anext(stream))
        await asyncio.wait_for(listening.wait(), 2)
        generation = gate.begin()
        await queue.put("hil-request")
        self.assertEqual(await asyncio.wait_for(first, 2), "hil-request")
        self.assertFalse(closed.is_set())
        ending = asyncio.create_task(anext(stream))
        turn.close()
        with self.assertRaises(StopAsyncIteration):
            await asyncio.wait_for(ending, 2)
        self.assertTrue(closed.is_set())
        self.assertTrue(gate.seal(generation))

    async def test_request_remains_busy_until_observer_cleanup_finishes(self):
        gate = Activities()
        entered, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def source():
            try:
                entered.set()
                await asyncio.Future()
                yield "unreachable"
            finally:
                cleaning.set()
                await release.wait()

        async def consume():
            with gate.observe_request():
                async for _ in passive_events(source(), gate):
                    self.fail("unexpected event")

        task = asyncio.create_task(consume())
        await asyncio.wait_for(entered.wait(), 2)
        generation = gate.begin()
        try:
            await asyncio.wait_for(cleaning.wait(), 2)
            self.assertFalse(gate.seal(generation))
            self.assertEqual(gate.snapshot().counts, {"request": 1})
        finally:
            release.set()
            await asyncio.wait_for(task, 2)
        self.assertTrue(gate.seal(generation))

    async def test_resume_before_execution_ends_keeps_observer_open(self):
        gate = Activities()
        lease = gate.enter(ActivityDomain.ACTION)
        waiter = asyncio.create_task(gate.wait_execution_drained())
        await asyncio.sleep(0)
        generation = gate.begin()
        gate.resume(generation)
        lease.close()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertFalse(waiter.done())
        next_generation = gate.begin()
        self.assertEqual(await asyncio.wait_for(waiter, 2), next_generation)

    async def test_disconnect_closes_iterator_and_removes_drain_waiter(self):
        gate = Activities()
        entered, closed = asyncio.Event(), asyncio.Event()

        async def source():
            try:
                entered.set()
                await asyncio.Future()
                yield "unreachable"
            finally:
                closed.set()

        stream = passive_events(source(), gate)
        pending = asyncio.create_task(anext(stream))
        await asyncio.wait_for(entered.wait(), 2)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(closed.is_set())
        self.assertEqual(gate._drain_waiters, set())

    async def test_natural_end_does_not_leave_maintenance_listener(self):
        gate = Activities()

        async def source():
            yield "terminal"

        self.assertEqual([item async for item in passive_events(source(), gate)], ["terminal"])
        self.assertEqual(gate._drain_waiters, set())


if __name__ == "__main__":
    unittest.main()
