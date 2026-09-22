"""Capacity contracts and process-lifecycle checks; these are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import scholarseed_codex.pool as pool_module
from scholarseed_codex.capacity import CapacityPolicy, HostRole, HostState
from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.environment import CODEX_HOME_ENV
from scholarseed_codex.pool import (
    POOL_READINESS_LOG,
    READINESS_LOGGER,
    CodexHostPool,
    PoolReservation,
)
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.control import CodexControlRequest
from scholarseed_codex.protocol.session import (
    CodexRuntimeReadiness,
    CodexRuntimeStatus,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import (
    AGENT_RUNTIME_STOP_TIMEOUT_SECONDS,
    AppServerError,
    CodexActivationStage,
    CodexProcessState,
    CodexThreadAttachmentState,
)
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_runtime.contract.evidence import RuntimeProcessEventKind
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.contract.resource import (
    RESOURCE_LIFECYCLE_LOGGER,
    RESOURCE_QUEUE_FULL,
    ResourceState,
)
from scholarseed_runtime.contract.session import (
    RUNTIME_SUSPEND_BUSY,
    RUNTIME_SUSPEND_STALE,
    SuspendState,
)
from tests.contract_codex_suspension import TEST_REVISION, TEST_WATERMARK, session_fixture

TEST_TIMEOUT_SECONDS = 5.0
TEST_WAIT_SECONDS = 10.0
TEST_EXPIRY_SECONDS = 0.05
TEST_EXPIRY_GRACE_SECONDS = 0.15
TEST_HOST_ENV = "SCHOLARSEED_CAPACITY_TEST_HOST"
TEST_EXECUTABLE_ENV = "SCHOLARSEED_TEST_CODEX_BIN"
TEST_RUNTIME_ID = "codex"
TEST_EXECUTABLE = "/capacity-contract/codex"
TEST_VERSION = "codex-cli 0.154.0"
TEST_CHILD_DELAY_SECONDS = AGENT_RUNTIME_STOP_TIMEOUT_SECONDS + 1.0
TEST_CHILD_CHECK_SECONDS = AGENT_RUNTIME_STOP_TIMEOUT_SECONDS + 0.25
TEST_CLEANUP_EVENT_LOOP_TURNS = 5
TEST_TOMBSTONE_LIMIT = 2
TEST_SECRET_VALUE = "capacity-contract-sensitive-material"
TEST_CHILD_READY = b"ready\n"
TEST_CHILD_EOF = b"eof\n"
TEST_CHILD_RELEASE = b"x"
TERMINAL_STATES = frozenset(
    {ResourceState.REJECTED, ResourceState.CANCELLED, ResourceState.EXPIRED}
)


class TimingRecorder:
    def __init__(self) -> None:
        self.entered: list[str] = []
        self.finished: list[tuple[str, type[BaseException] | None]] = []
        self.signals: dict[str, asyncio.Event] = {}

    def signal(self, stage: str) -> asyncio.Event:
        return self.signals.setdefault(stage, asyncio.Event())

    @contextmanager
    def measure(self, stage: str) -> Iterator[None]:
        self.entered.append(stage)
        self.signal(stage).set()
        failure = None
        try:
            yield
        except BaseException as error:
            failure = type(error)
            raise
        finally:
            self.finished.append((stage, failure))


class ControlledHost:
    """A deterministic protocol fixture, deliberately not a product runtime."""

    def __init__(self, **arguments: object) -> None:
        self.arguments = arguments
        self.start_entered = asyncio.Event()
        self.start_gate = asyncio.Event()
        self.start_gate.set()
        self.close_entered = asyncio.Event()
        self.close_gate = asyncio.Event()
        self.close_gate.set()
        self.start_error: BaseException | None = None
        self.close_error: BaseException | None = None
        self.start_calls = 0
        self.close_calls = 0
        self.safe_close_calls = 0
        self.closed = False
        self.stop_committed = False
        self.readiness = SimpleNamespace(
            process_generation=1,
            ready=True,
            process_state=CodexProcessState.READY.value,
            executable=str(arguments.get("executable", TEST_EXECUTABLE)),
            version=TEST_VERSION,
        )

    async def start(self) -> None:
        self.start_calls += 1
        self.start_entered.set()
        await self.start_gate.wait()
        if self.start_error is not None:
            raise self.start_error

    async def aclose(self) -> None:
        self.close_calls += 1
        self.close_entered.set()
        await self.close_gate.wait()
        if self.close_error is not None:
            raise self.close_error
        self.closed = True

    async def stop_idle(self, expected_generation: int) -> None:
        self.safe_close_calls += 1
        if expected_generation != self.readiness.process_generation:
            raise AssertionError("wrong process generation")
        await self.aclose()


class CapacityContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.hosts: list[ControlledHost] = []
        self.pools: list[CodexHostPool] = []
        self.host_hook = lambda _host: None
        readiness = CodexRuntimeReadiness(
            runtime_id=TEST_RUNTIME_ID,
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable=TEST_EXECUTABLE,
            version=TEST_VERSION,
        )
        self.probe_patch = patch.object(
            pool_module, "_probe_codex_cli_readiness", AsyncMock(return_value=readiness)
        )
        self.host_patch = patch.object(pool_module, "CodexProcessHost", self.create_host)
        self.probe_patch.start()
        self.host_patch.start()

    async def asyncTearDown(self) -> None:
        for host in self.hosts:
            host.start_gate.set()
            host.close_gate.set()
        for pool in self.pools:
            await asyncio.wait_for(pool.aclose(), TEST_TIMEOUT_SECONDS)
        self.host_patch.stop()
        self.probe_patch.stop()

    async def test_shared_control_host_timing_belongs_to_each_request(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        first_timing = TimingRecorder()
        second_timing = TimingRecorder()
        first_request = CodexControlRequest(
            request_id="timed-control-first",
            runtime_id=TEST_RUNTIME_ID,
            cwd=Path(tempfile.gettempdir()),
            executable=TEST_EXECUTABLE,
            authentication_required=False,
            timing=first_timing,
        )
        first = await pool.acquire_control(first_request)
        await first.close()
        first_finished = tuple(first_timing.finished)
        second = await pool.acquire_control(
            replace(first_request, request_id="timed-control-second", timing=second_timing)
        )
        self.assertIs(first.host, second.host)
        self.assertEqual(first.host.start_calls, 1)
        self.assertEqual(tuple(first_timing.finished), first_finished)
        self.assertEqual(first_timing.entered.count(CodexActivationStage.PROCESS_START), 1)
        self.assertNotIn(CodexActivationStage.PROCESS_START, second_timing.entered)
        self.assertIn(CodexActivationStage.PROCESS_READY_WAIT, second_timing.entered)
        self.assertNotIn(CodexActivationStage.READINESS_PROBE, second_timing.entered)
        self.assertTrue(all(failure is None for _, failure in second_timing.finished))
        await second.close()

    async def test_readiness_cache_does_not_replay_probe_timings(self) -> None:
        pool = self.pool()
        first_timing = TimingRecorder()
        second_timing = TimingRecorder()
        first = await pool.probe_readiness(
            TEST_EXECUTABLE, process_environment={}, timing=first_timing
        )
        repeated = await pool.probe_readiness(
            TEST_EXECUTABLE, process_environment={}, timing=second_timing
        )
        self.assertIs(first, repeated)
        self.assertEqual(
            first_timing.entered,
            [CodexActivationStage.READINESS_LOCK_WAIT, CodexActivationStage.READINESS_PROBE],
        )
        self.assertEqual(second_timing.entered, [])
        pool_module._probe_codex_cli_readiness.assert_awaited_once()

    async def test_concurrent_readiness_waiter_records_wait_not_another_probe(self) -> None:
        pool = self.pool()
        first_timing = TimingRecorder()
        second_timing = TimingRecorder()
        probe_entered = asyncio.Event()
        release_probe = asyncio.Event()
        readiness = pool_module._probe_codex_cli_readiness.return_value

        async def probe(*arguments, **keywords):
            probe_entered.set()
            await release_probe.wait()
            return readiness

        pool_module._probe_codex_cli_readiness.side_effect = probe
        first = asyncio.create_task(
            pool.probe_readiness(TEST_EXECUTABLE, process_environment={}, timing=first_timing)
        )
        await asyncio.wait_for(probe_entered.wait(), TEST_TIMEOUT_SECONDS)
        second = asyncio.create_task(
            pool.probe_readiness(TEST_EXECUTABLE, process_environment={}, timing=second_timing)
        )
        try:
            await asyncio.wait_for(
                second_timing.signal(CodexActivationStage.READINESS_LOCK_WAIT).wait(),
                TEST_TIMEOUT_SECONDS,
            )
            self.assertFalse(second.done())
            release_probe.set()
            results = await asyncio.wait_for(asyncio.gather(first, second), TEST_TIMEOUT_SECONDS)
            self.assertIs(results[0], results[1])
            self.assertEqual(second_timing.entered, [CodexActivationStage.READINESS_LOCK_WAIT])
            self.assertEqual(
                second_timing.finished, [(CodexActivationStage.READINESS_LOCK_WAIT, None)]
            )
            pool_module._probe_codex_cli_readiness.assert_awaited_once()
        finally:
            release_probe.set()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_concurrent_control_consumers_do_not_share_timing_observers(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        first_timing = TimingRecorder()
        second_timing = TimingRecorder()
        first_request = CodexControlRequest(
            request_id="timed-concurrent-first",
            runtime_id=TEST_RUNTIME_ID,
            cwd=Path(tempfile.gettempdir()),
            executable=TEST_EXECUTABLE,
            authentication_required=False,
            timing=first_timing,
        )
        first = asyncio.create_task(pool.acquire_control(first_request))
        await asyncio.wait_for(
            first_timing.signal(CodexActivationStage.PROCESS_START).wait(), TEST_TIMEOUT_SECONDS
        )
        second = asyncio.create_task(
            pool.acquire_control(
                replace(first_request, request_id="timed-concurrent-second", timing=second_timing)
            )
        )
        try:
            await asyncio.wait_for(
                second_timing.signal(CodexActivationStage.PROCESS_READY_WAIT).wait(),
                TEST_TIMEOUT_SECONDS,
            )
            self.assertEqual(len(self.hosts), 1)
            self.assertNotIn(CodexActivationStage.PROCESS_START, second_timing.entered)
            self.assertFalse(first.done())
            self.assertFalse(second.done())
            self.hosts[0].start_gate.set()
            leases = await asyncio.wait_for(asyncio.gather(first, second), TEST_TIMEOUT_SECONDS)
            self.assertIs(leases[0].host, leases[1].host)
            self.assertEqual(first_timing.entered.count(CodexActivationStage.PROCESS_START), 1)
            for timing in (first_timing, second_timing):
                self.assertEqual(
                    timing.finished.count((CodexActivationStage.PROCESS_READY_WAIT, None)), 1
                )
            for lease in leases:
                await lease.close()
        finally:
            for host in self.hosts:
                host.start_gate.set()
            await asyncio.gather(first, second, return_exceptions=True)

    async def test_process_start_and_consumer_ready_wait_are_distinct_scopes(self) -> None:
        pool = self.pool()
        timing = TimingRecorder()
        self.host_hook = lambda host: host.start_gate.clear()
        request = replace(self.request("timed-process-wait"), timing=timing)
        reservation = await pool.reserve(
            request,
            role=HostRole.EXECUTION,
            request_id=request.request_id,
            deadline=time() + TEST_WAIT_SECONDS,
        )
        host = self.hosts[0]
        await asyncio.wait_for(host.start_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertIn(CodexActivationStage.PROCESS_START, timing.entered)
        self.assertNotIn(CodexActivationStage.PROCESS_READY_WAIT, timing.entered)
        consumer = asyncio.create_task(pool.consume(reservation))
        try:
            await asyncio.wait_for(
                timing.signal(CodexActivationStage.PROCESS_READY_WAIT).wait(),
                TEST_TIMEOUT_SECONDS,
            )
            self.assertFalse(consumer.done())
            self.assertNotIn((CodexActivationStage.PROCESS_START, None), timing.finished)
            self.assertNotIn((CodexActivationStage.PROCESS_READY_WAIT, None), timing.finished)
            host.start_gate.set()
            lease = await asyncio.wait_for(consumer, TEST_TIMEOUT_SECONDS)
            self.assertIn((CodexActivationStage.PROCESS_START, None), timing.finished)
            self.assertIn((CodexActivationStage.PROCESS_READY_WAIT, None), timing.finished)
            await lease.close()
        finally:
            host.start_gate.set()
            await asyncio.gather(consumer, return_exceptions=True)

    async def test_pool_timing_changes_do_not_change_reservation_identity(self) -> None:
        pool = self.pool()
        request = replace(self.request("timing-identity"), timing=TimingRecorder())
        repeated = replace(request, timing=TimingRecorder())
        self.assertEqual(request, repeated)
        self.assertEqual(repr(request), repr(repeated))
        deadline = time() + TEST_WAIT_SECONDS
        original = await pool.reserve(
            request, role=HostRole.EXECUTION, request_id=request.request_id, deadline=deadline
        )
        duplicate = await pool.reserve(
            repeated, role=HostRole.EXECUTION, request_id=request.request_id, deadline=deadline
        )
        self.assertIs(duplicate, original)
        await pool.cancel(original)

    async def test_explicit_resource_wait_records_queue_blocking_and_cancellation(self) -> None:
        for cancel_wait in (False, True):
            with self.subTest(cancel_wait=cancel_wait):
                pool = self.pool()
                owner = await pool.acquire(self.request("timed-queue-owner"))
                timing = TimingRecorder()
                request = replace(self.request("timed-queue-waiter", "other"), timing=timing)
                reservation = await pool.reserve(
                    request,
                    role=HostRole.EXECUTION,
                    request_id=request.request_id,
                    deadline=time() + TEST_WAIT_SECONDS,
                )
                self.assertIs(reservation.state, ResourceState.WAITING)
                waiter = asyncio.create_task(pool.wait(reservation))
                try:
                    await asyncio.wait_for(
                        timing.signal(CodexActivationStage.RESOURCE_WAIT).wait(),
                        TEST_TIMEOUT_SECONDS,
                    )
                    self.assertFalse(waiter.done())
                    self.assertNotIn((CodexActivationStage.RESOURCE_WAIT, None), timing.finished)
                    if cancel_wait:
                        waiter.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await waiter
                        self.assertIs(reservation.state, ResourceState.CANCELLED)
                        self.assertIn(
                            (CodexActivationStage.RESOURCE_WAIT, asyncio.CancelledError),
                            timing.finished,
                        )
                        self.assertNotIn(CodexActivationStage.PROCESS_START, timing.entered)
                        self.assertFalse(owner.host.closed)
                    else:
                        await owner.close()
                        receipt = await asyncio.wait_for(waiter, TEST_TIMEOUT_SECONDS)
                        self.assertIs(receipt.state, ResourceState.GRANTED)
                        self.assertEqual(
                            timing.finished.count((CodexActivationStage.RESOURCE_WAIT, None)), 1
                        )
                        lease = await pool.consume(reservation)
                        self.assertEqual(
                            timing.finished.count((CodexActivationStage.RESOURCE_WAIT, None)), 2
                        )
                        await lease.close()
                finally:
                    waiter.cancel()
                    await asyncio.gather(waiter, return_exceptions=True)
                    await owner.close()

    async def test_retry_after_unsubscribe_failure_starts_first_safe_lease_close(self) -> None:
        pool = self.pool()
        request = self.request("unsubscribe-retry")
        reservation = await self.reserve(pool, request.request_id)
        lease = await pool.consume(reservation)
        host = lease.host
        host.process_generation = host.readiness.process_generation
        host.suspend_thread = AsyncMock(
            side_effect=[
                AppServerError(RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY),
                None,
            ]
        )
        native = CodexThreadSession(request, lease=lease, host_pool=pool)
        native._opened = True
        native.session_id = "unsubscribe-root"
        session = session_fixture(native)
        ticket = await session.prepare_suspend(TEST_REVISION)
        with self.assertRaises(AppServerError) as first:
            await session.commit_suspend(ticket, TEST_WATERMARK)
        self.assertEqual(first.exception.safe_error, RUNTIME_SUSPEND_BUSY)
        self.assertEqual(pool.snapshot()[0].used, 1)
        self.assertEqual(host.safe_close_calls, 0)
        self.assertEqual((await session.suspend_status(ticket)).state, SuspendState.COMMITTING)
        receipt = await session.commit_suspend(ticket, TEST_WATERMARK)
        self.assertEqual(receipt.state, SuspendState.RELEASED)
        self.assertEqual(pool.snapshot()[0].used, 0)
        self.assertEqual(host.safe_close_calls, 1)
        self.assertEqual(host.suspend_thread.await_count, 2)
        self.assertIsNone(native.lease)
        self.assertEqual(
            (await session.commit_suspend(ticket, TEST_WATERMARK)).state, SuspendState.RELEASED
        )
        self.assertEqual(host.safe_close_calls, 1)

    async def test_first_safe_close_retry_rejects_a_different_generation(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "unsubscribe-generation")
        lease = await pool.consume(reservation)
        generation = lease.host.readiness.process_generation
        with self.assertRaises(AppServerError) as caught:
            await lease.retry_close(expected_generation=generation + 1)
        self.assertEqual(caught.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertEqual(lease.host.safe_close_calls, 0)
        self.assertEqual(pool.snapshot()[0].used, 1)
        await lease.retry_close(expected_generation=generation)
        self.assertEqual(lease.host.safe_close_calls, 1)
        self.assertEqual(pool.snapshot()[0].used, 0)

    def create_host(self, **arguments: object) -> ControlledHost:
        host = ControlledHost(**arguments)
        self.host_hook(host)
        self.hosts.append(host)
        return host

    def pool(self, **values: object) -> CodexHostPool:
        options = {
            "execution_hosts": 1,
            "control_hosts": 1,
            "queue_limit": 3,
            "wait_seconds": TEST_WAIT_SECONDS,
        }
        options.update(values)
        pool = CodexHostPool(CapacityPolicy(**options))
        self.pools.append(pool)
        return pool

    def request(self, request_id: str, host_key: str = "a") -> CodexSessionOpenRequest:
        return CodexSessionOpenRequest(
            request_id=request_id,
            runtime_id=TEST_RUNTIME_ID,
            cwd=Path(tempfile.gettempdir()),
            executable=TEST_EXECUTABLE,
            authentication_required=False,
            process_environment={TEST_HOST_ENV: host_key},
        )

    async def reserve(
        self,
        pool: CodexHostPool,
        request_id: str,
        host_key: str = "a",
        *,
        role: HostRole = HostRole.EXECUTION,
        deadline: float | None = None,
    ) -> PoolReservation:
        return await pool.reserve(
            replace(self.request(request_id, host_key), request_id=f"native-{host_key}"),
            role=role,
            request_id=request_id,
            deadline=time() + TEST_WAIT_SECONDS if deadline is None else deadline,
        )

    def capacity(self, pool: CodexHostPool, role: HostRole = HostRole.EXECUTION):
        return next(row for row in pool.snapshot() if row.role == role.value)

    def resolve_executable(self) -> None:
        """`shutil.which` cannot see a synthetic fixture path; pooled lookup needs it resolved."""

        patcher = patch.object(
            pool_module, "discover_codex_executable", Mock(return_value=TEST_EXECUTABLE)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def slot(self, pool: CodexHostPool, host: ControlledHost):
        return next(value for value in pool._hosts.values() if value.host is host)

    def rank_host(self, generation: int):
        """Stamp the next host's generation so the newest READY one stays identifiable."""

        def hook(host: ControlledHost) -> None:
            host.readiness.process_generation = generation

        return hook

    async def starting_host(
        self,
        pool: CodexHostPool,
        request_id: str,
        host_key: str,
        *,
        role: HostRole = HostRole.EXECUTION,
    ) -> ControlledHost:
        """A host held inside startup: registered in the pool, and not ready for anyone yet."""

        previous = self.host_hook

        def gate(host: ControlledHost) -> None:
            host.start_gate.clear()
            host.readiness.ready = False
            host.readiness.process_state = CodexProcessState.STARTING.value

        self.host_hook = gate
        try:
            await self.reserve(pool, request_id, host_key, role=role)
        finally:
            self.host_hook = previous
        host = self.hosts[-1]
        await asyncio.wait_for(host.start_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertIs(self.slot(pool, host).state, HostState.STARTING)
        return host

    async def test_pooled_readiness_accepts_only_a_ready_host_as_evidence(self) -> None:
        self.resolve_executable()
        pool = self.pool(execution_hosts=2)
        self.host_hook = self.rank_host(3)
        lease = await pool.consume(await self.reserve(pool, "pooled-ready", "ready"))
        self.host_hook = lambda _host: None
        starting = await self.starting_host(pool, "pooled-starting", "starting")
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        # 一台正在启动的 Host 是会话级瞬态, 不能代表 executable 不可用。
        self.assertFalse(starting.readiness.ready)
        self.assertIs(readiness, lease.host.readiness)
        self.assertTrue(readiness.ready)
        self.assertEqual(probe.await_count, 0)

    async def test_pooled_readiness_reports_the_newest_ready_generation(self) -> None:
        self.resolve_executable()
        pool = self.pool(execution_hosts=2)
        self.host_hook = self.rank_host(2)
        older = await pool.consume(await self.reserve(pool, "older", "older"))
        self.host_hook = self.rank_host(5)
        newer = await pool.consume(await self.reserve(pool, "newer", "newer"))
        self.host_hook = lambda _host: None
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertIs(readiness, newer.host.readiness)
        self.assertEqual(readiness.process_generation, 5)
        self.assertEqual(older.host.readiness.process_generation, 2)

    async def test_pooled_readiness_survives_a_starting_host_of_another_role(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "execution-ready"))
        control = await self.starting_host(
            pool, "control-starting", "control", role=HostRole.CONTROL
        )
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertIs(self.slot(pool, control).role, HostRole.CONTROL)
        self.assertIs(readiness, lease.host.readiness)
        self.assertEqual(probe.await_count, 0)

    async def test_pooled_readiness_survives_a_control_host_being_replaced(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        execution = await pool.consume(await self.reserve(pool, "execution-ready"))
        control = await pool.consume(await self.reserve(pool, "control", role=HostRole.CONTROL))
        await control.close()
        control.host.close_gate.clear()
        control.host.readiness.ready = False
        control.host.readiness.process_state = CodexProcessState.CLOSING.value
        # Control capacity is 1, so a second CODEX_HOME evicts the resident host on demand.
        waiting = await self.reserve(pool, "control-other", "other", role=HostRole.CONTROL)
        await asyncio.wait_for(control.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertIs(waiting.state, ResourceState.WAITING)
        self.assertIs(self.slot(pool, control.host).state, HostState.STOPPING)
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertIs(readiness, execution.host.readiness)
        self.assertEqual(probe.await_count, 0)
        control.host.close_gate.set()

    async def test_pooled_readiness_without_a_ready_host_probes_the_cli_and_logs_once(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        starting = await self.starting_host(pool, "only-starting", TEST_SECRET_VALUE)
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        # Admission already warmed the TTL cache; drop it so the fallback probe is observable.
        pool._readiness_cache.clear()
        with self.assertLogs(READINESS_LOGGER, level="INFO") as captured:
            first = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
            repeated = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        # 没有 READY 证据时回落真实 CLI 预检, 而不是把瞬态当成"运行时不可用"。
        self.assertTrue(first.ready)
        self.assertIs(repeated, first)
        self.assertEqual(probe.await_count, 1)
        self.assertEqual(len(captured.records), 1)
        message = captured.records[0].getMessage()
        self.assertTrue(message.startswith(POOL_READINESS_LOG))
        self.assertEqual(
            json.loads(message[len(POOL_READINESS_LOG) :]),
            {
                "slots": [
                    {
                        "host_id": self.slot(pool, starting).host_id,
                        "process_generation": 1,
                        "process_state": CodexProcessState.STARTING.value,
                        "role": HostRole.EXECUTION.value,
                        "slot_state": HostState.STARTING.value,
                    }
                ]
            },
        )
        self.assertNotIn(TEST_SECRET_VALUE, message)
        self.assertFalse(hasattr(captured.records[0], "resource_evidence"))
        with self.assertLogs(READINESS_LOGGER, level="INFO") as changed:
            starting.readiness.process_state = CodexProcessState.RECOVERING.value
            await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertEqual(len(changed.records), 1)
        self.assertIn(CodexProcessState.RECOVERING.value, changed.records[0].getMessage())

    async def test_pooled_readiness_ignores_hosts_of_another_executable(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "other-executable"))
        lease.host.readiness.ready = True
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        with patch.object(
            pool_module, "discover_codex_executable", Mock(return_value="/other/codex")
        ):
            readiness = await pool.probe_readiness("/other/codex", prefer_pooled=True)
        self.assertIsNot(readiness, lease.host.readiness)
        self.assertEqual(probe.await_count, 1)

    async def test_idle_control_replacement_waits_for_os_exit_and_shutdown_closes_warm_host(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "control-first", role=HostRole.CONTROL))
        await first.close()
        self.assertFalse(first.host.closed)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 1)
        second = await pool.consume(
            await self.reserve(pool, "control-second", role=HostRole.CONTROL)
        )
        self.assertIs(second.host, first.host)
        self.assertNotEqual(second.lease_id, first.lease_id)
        await second.close()
        first.host.close_gate.clear()
        waiting = await self.reserve(pool, "control-replacement", "other", role=HostRole.CONTROL)
        await asyncio.wait_for(first.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertIs(waiting.state, ResourceState.WAITING)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 1)
        self.assertEqual(len(self.hosts), 1)
        self.assertEqual(first.host.safe_close_calls, 1)
        first.host.close_gate.set()
        third = await asyncio.wait_for(pool.consume(waiting), TEST_TIMEOUT_SECONDS)
        self.assertTrue(first.host.closed)
        self.assertIsNot(third.host, first.host)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 1)
        await third.close()
        self.assertFalse(third.host.closed)
        await pool.aclose()
        self.assertTrue(third.host.closed)
        self.assertEqual(third.host.safe_close_calls, 1)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 0)

    async def test_execution_scope_and_thread_configuration_keep_writer_hosts_separate(
        self,
    ) -> None:
        pool = self.pool(execution_hosts=2)
        first_request = self.request("logical-first")
        first = await pool.acquire(first_request)
        second = await pool.acquire(self.request("logical-second"))
        self.assertIsNot(first.host, second.host)
        configured = await pool.reserve(
            replace(
                first_request,
                thread_config={
                    "model_providers": {"remote": {"base_url": "https://changed.example"}}
                },
            ),
            role=HostRole.EXECUTION,
            request_id="changed-configuration",
            deadline=time() + TEST_WAIT_SECONDS,
        )
        self.assertIs(configured.state, ResourceState.WAITING)
        first.host.close_gate.clear()
        closing = asyncio.create_task(first.close(safe=True))
        await asyncio.wait_for(first.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertIs(configured.state, ResourceState.WAITING)
        self.assertEqual(self.capacity(pool).used, 2)
        first.host.close_gate.set()
        await closing
        third = await asyncio.wait_for(pool.consume(configured), TEST_TIMEOUT_SECONDS)
        self.assertTrue(first.host.closed)
        self.assertIsNot(third.host, second.host)
        self.assertIsNot(third.host, first.host)
        await asyncio.gather(second.close(), third.close())

    async def test_warm_control_readiness_does_not_repeat_preflight_after_cache_expiry(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "warm-first", role=HostRole.CONTROL))
        await first.close()
        pool._readiness_cache.clear()
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        with patch.object(pool_module, "discover_codex_executable", return_value=TEST_EXECUTABLE):
            second = await pool.consume(
                await self.reserve(pool, "warm-second", role=HostRole.CONTROL)
            )
        probe.assert_not_awaited()
        self.assertIs(second.host, first.host)
        await second.close()

    async def test_standalone_control_closes_its_own_pool(self) -> None:
        def configure(host):
            host.ensure_skill_roots = AsyncMock()
            host.request = AsyncMock(return_value={})

        self.host_hook = configure
        control = CodexRuntimeControl(
            CodexControlRequest(
                request_id="standalone-control",
                runtime_id=TEST_RUNTIME_ID,
                cwd=Path(tempfile.gettempdir()),
                executable=TEST_EXECUTABLE,
                authentication_required=False,
            )
        )
        await control.open()
        host = control.host
        await control.aclose()
        self.assertTrue(host.closed)
        self.assertEqual(host.safe_close_calls, 1)
        self.assertTrue(all(row.used == 0 for row in control._host_pool.snapshot()))
        self.assertEqual(control._host_pool._reservations, {})

    async def test_readiness_cache_is_owned_by_pool_and_authentication_home(self) -> None:
        first = self.pool()
        second = self.pool()
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        await first.probe_readiness(
            TEST_EXECUTABLE,
            process_environment={CODEX_HOME_ENV: "/one", TEST_HOST_ENV: "first-secret"},
        )
        await first.probe_readiness(
            TEST_EXECUTABLE,
            process_environment={CODEX_HOME_ENV: "/one", TEST_HOST_ENV: "new-secret"},
        )
        self.assertEqual(probe.await_count, 1)
        await first.probe_readiness(
            TEST_EXECUTABLE,
            authentication_required=True,
            process_environment={CODEX_HOME_ENV: "/one"},
        )
        await first.probe_readiness(TEST_EXECUTABLE, process_environment={CODEX_HOME_ENV: "/two"})
        await second.probe_readiness(TEST_EXECUTABLE, process_environment={CODEX_HOME_ENV: "/one"})
        self.assertEqual(probe.await_count, 4)
        self.assertIsNot(first._readiness_probe_lock, second._readiness_probe_lock)

    async def test_lifecycle_logs_control_capacity_without_process_secrets(self) -> None:
        pool = self.pool(execution_hosts=4)
        leases = []
        with self.assertLogs(RESOURCE_LIFECYCLE_LOGGER, level="INFO") as captured:
            for index in range(4):
                leases.append(
                    await pool.acquire(
                        self.request(f"execution-{index}", f"{TEST_SECRET_VALUE}-{index}")
                    )
                )
            control = await pool.acquire_control(
                CodexControlRequest(
                    request_id="control-inspect",
                    runtime_id=TEST_RUNTIME_ID,
                    cwd=Path(tempfile.gettempdir()),
                    executable=TEST_EXECUTABLE,
                    authentication_required=False,
                    process_environment={TEST_HOST_ENV: TEST_SECRET_VALUE},
                )
            )
            leases.append(control)
            await control.close(safe=True)
            for lease in leases[:-1]:
                await lease.close()
        records = [record.resource_evidence for record in captured.records]
        admitted = next(
            row
            for row in records
            if row["role"] == HostRole.CONTROL.value
            and row["transition"] == ResourceState.CONSUMED.value
        )
        self.assertEqual(
            {row["role"]: row["used"] for row in admitted["capacity"]},
            {HostRole.EXECUTION.value: 4, HostRole.CONTROL.value: 1},
        )
        self.assertTrue(admitted["host_id"])
        self.assertEqual(admitted["lease_id"], control.lease_id)
        self.assertEqual(admitted["request_id"], control.request_id)
        control_rows = [row for row in records if row["role"] == HostRole.CONTROL.value]
        self.assertEqual(sum(row["transition"] == "exited" for row in control_rows), 1)
        self.assertIn("released", {row["transition"] for row in control_rows})
        self.assertIn("ready", {row["transition"] for row in control_rows})
        exited = next(row for row in control_rows if row["transition"] == "exited")
        self.assertEqual(exited["state"], "stopped")
        self.assertEqual(exited["process_generation"], 1)
        self.assertEqual(
            {row["role"]: row["used"] for row in exited["capacity"]},
            {HostRole.EXECUTION.value: 4, HostRole.CONTROL.value: 0},
        )
        for record in captured.records:
            payload = json.loads(record.getMessage().split(" ", 1)[1])
            self.assertEqual(payload, record.resource_evidence)
            self.assertEqual(
                set(payload),
                {
                    "event_id",
                    "request_id",
                    "reservation_id",
                    "host_id",
                    "lease_id",
                    "role",
                    "state",
                    "observed_at",
                    "capacity",
                    "process_generation",
                    "transition",
                    "reservation_state",
                },
            )
            self.assertNotIn(TEST_SECRET_VALUE, repr(record.__dict__))
            self.assertNotIn(TEST_HOST_ENV, repr(record.__dict__))
            self.assertNotIn("compatibility", repr(record.__dict__))

    async def test_lifecycle_logs_terminal_wait_and_retained_close_failure(self) -> None:
        pool = self.pool(queue_limit=1)
        with self.assertLogs(RESOURCE_LIFECYCLE_LOGGER, level="INFO") as captured:
            lease = await pool.consume(await self.reserve(pool, "logged-owner"))
            waiting = await self.reserve(pool, "logged-waiter", "different")
            rejected = await self.reserve(pool, "logged-rejected", "third")
            self.assertIs(rejected.state, ResourceState.REJECTED)
            await pool.cancel(waiting)
            lease.host.close_error = AppServerError(
                RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY
            )
            with self.assertRaises(AppServerError):
                await lease.close(safe=True)
            failed_rows = [
                record.resource_evidence
                for record in captured.records
                if record.resource_evidence["transition"] == "close_failed"
            ]
            self.assertEqual(len(failed_rows), 1)
            self.assertEqual(failed_rows[0]["state"], "stopping")
            self.assertEqual(failed_rows[0]["capacity"][0]["used"], 1)
            self.assertFalse(
                any(
                    record.resource_evidence["transition"] in {"released", "exited"}
                    for record in captured.records
                )
            )
            lease.host.close_error = None
            await lease.retry_close(expected_generation=1)
        transitions = {record.resource_evidence["transition"] for record in captured.records}
        self.assertTrue(
            {"waiting", "rejected", "cancelled", "close_failed", "exited", "released"}.issubset(
                transitions
            )
        )

    async def test_shared_host_has_independent_idempotent_leases(self) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "first"))
        second = await pool.consume(await self.reserve(pool, "second"))
        self.assertIs(first.host, second.host)
        self.assertNotEqual(first.lease_id, second.lease_id)
        self.assertEqual(self.capacity(pool).used, 1)
        await asyncio.gather(first.close(), first.close())
        self.assertFalse(first.host.closed)
        await asyncio.gather(second.close(), second.close())
        self.assertEqual(first.host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_role_budgets_are_independent_but_same_owner(self) -> None:
        pool = self.pool()
        execution = await pool.consume(await self.reserve(pool, "execution"))
        control = await pool.consume(await self.reserve(pool, "control", role=HostRole.CONTROL))
        blocked = await self.reserve(pool, "blocked", "b")
        self.assertIs(blocked.state, ResourceState.WAITING)
        self.assertIsNot(execution.host, control.host)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 1)
        await pool.cancel(blocked)
        await asyncio.gather(execution.close(), control.close())

    async def test_stopping_occupies_budget_and_waiters_keep_fifo(self) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "first", "a"))
        second = await self.reserve(pool, "second", "b")
        third = await self.reserve(pool, "third", "c")
        first.host.close_gate.clear()
        closing = asyncio.create_task(first.close())
        await asyncio.wait_for(first.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        try:
            same_key = await self.reserve(pool, "same-key", "a")
            self.assertEqual(self.capacity(pool).used, 1)
            self.assertIs(second.state, ResourceState.WAITING)
            self.assertIs(same_key.state, ResourceState.WAITING)
        finally:
            first.host.close_gate.set()
            await closing
        second_lease = await pool.consume(second)
        self.assertIs(third.state, ResourceState.WAITING)
        self.assertIs(same_key.state, ResourceState.WAITING)
        await second_lease.close()
        third_lease = await pool.consume(third)
        self.assertIs(same_key.state, ResourceState.WAITING)
        await third_lease.close()
        same_lease = await pool.consume(same_key)
        await same_lease.close()
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_bounded_queue_rejects_without_spawning(self) -> None:
        pool = self.pool(queue_limit=1)
        first = await pool.consume(await self.reserve(pool, "first", "a"))
        waiting = await self.reserve(pool, "waiting", "b")
        rejected = await self.reserve(pool, "rejected", "c")
        self.assertIs(rejected.state, ResourceState.REJECTED)
        self.assertEqual(rejected.safe_error, RESOURCE_QUEUE_FULL)
        self.assertEqual(len(self.hosts), 1)
        await pool.cancel(waiting)
        await first.close()

    async def test_request_id_remains_idempotent_after_cancel(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "same-request")
        await pool.cancel(reservation)
        retried = await self.reserve(pool, "same-request")
        self.assertEqual(retried.reservation_id, reservation.reservation_id)
        self.assertIs(retried.state, ResourceState.CANCELLED)
        self.assertEqual(len(self.hosts), 1)

    async def test_request_id_rejects_different_compatibility_key(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "same-request", "a")
        with self.assertRaises(AppServerError):
            await self.reserve(pool, "same-request", "b")
        await pool.cancel(reservation)

    async def test_cancel_preserves_existing_expiration_receipt(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "expired")
        await pool.cancel(reservation, expired=True)
        receipt = await pool.cancel(reservation)
        self.assertIs(receipt.state, ResourceState.EXPIRED)

    async def test_granted_reservation_expires_without_wait_or_consume(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "abandoned", deadline=time() + TEST_EXPIRY_SECONDS)
        await asyncio.sleep(TEST_EXPIRY_GRACE_SECONDS)
        self.assertIs(reservation.state, ResourceState.EXPIRED)
        self.assertEqual(self.capacity(pool).used, 0)
        self.assertTrue(self.hosts[0].closed)

    async def test_waiting_reservation_expires_without_client_wait(self) -> None:
        pool = self.pool(queue_limit=1)
        first = await pool.consume(await self.reserve(pool, "first", "a"))
        reservation = await self.reserve(
            pool, "abandoned", "b", deadline=time() + TEST_EXPIRY_SECONDS
        )
        await asyncio.sleep(TEST_EXPIRY_GRACE_SECONDS)
        self.assertIs(reservation.state, ResourceState.EXPIRED)
        self.assertEqual(self.capacity(pool).waiting, 0)
        next_request = await self.reserve(pool, "next", "c")
        self.assertIs(next_request.state, ResourceState.WAITING)
        await pool.cancel(next_request)
        await first.close()

    async def test_start_failure_finishes_unconsumed_reservation(self) -> None:
        pool = self.pool()
        failure = AppServerError("controlled startup failure")
        self.host_hook = lambda host: setattr(host, "start_error", failure)
        reservation = await self.reserve(pool, "abandoned")
        await asyncio.wait_for(self.hosts[0].close_entered.wait(), TEST_TIMEOUT_SECONDS)
        # Collect the fixture failure too, so a failed assertion does not leak a task.
        if reservation.slot is not None and reservation.slot.startup is not None:
            await asyncio.gather(reservation.slot.startup, return_exceptions=True)
        self.assertIn(reservation.state, TERMINAL_STATES)
        self.assertTrue(reservation.safe_error)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_cancelled_waiter_removes_queue_entry(self) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "first", "a"))
        reservation = await self.reserve(pool, "waiting", "b")
        waiting = asyncio.create_task(pool.wait(reservation))
        await asyncio.sleep(0)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertIs(reservation.state, ResourceState.CANCELLED)
        self.assertEqual(self.capacity(pool).waiting, 0)
        await first.close()

    async def test_cancel_call_cancellation_does_not_orphan_stopping_host(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "unconsumed")
        self.hosts[0].close_gate.clear()
        cancellation = asyncio.create_task(pool.cancel(reservation))
        await asyncio.wait_for(self.hosts[0].close_entered.wait(), TEST_TIMEOUT_SECONDS)
        cancellation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancellation
        self.hosts[0].close_gate.set()
        for _ in range(TEST_CLEANUP_EVENT_LOOP_TURNS):
            await asyncio.sleep(0)
        self.assertTrue(self.hosts[0].closed)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_concurrent_shutdown_closes_each_host_once(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "first"))
        lease.host.close_gate.clear()
        first_close = asyncio.create_task(pool.aclose())
        await asyncio.wait_for(lease.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        second_close = asyncio.create_task(pool.aclose())
        await asyncio.sleep(0)
        lease.host.close_gate.set()
        await asyncio.gather(first_close, second_close)
        self.assertEqual(lease.host.close_calls, 1)
        await lease.close()
        self.assertEqual(lease.host.close_calls, 1)

    async def test_compatible_arrival_does_not_bypass_an_older_waiter(self) -> None:
        pool = self.pool()
        first = await pool.consume(await self.reserve(pool, "first", "a"))
        older = await self.reserve(pool, "older", "b")
        compatible = await self.reserve(pool, "compatible", "a")
        self.assertIs(compatible.state, ResourceState.WAITING)
        await first.close()
        older_lease = await pool.consume(older)
        self.assertIs(compatible.state, ResourceState.WAITING)
        await older_lease.close()
        compatible_lease = await pool.consume(compatible)
        await compatible_lease.close()

    async def test_receipt_reports_actual_deadline_and_settled_outcome(self) -> None:
        pool = self.pool(wait_seconds=TEST_EXPIRY_SECONDS)
        reservation = await self.reserve(pool, "deadline")
        receipt = pool.receipt(reservation)
        self.assertEqual(receipt.deadline, reservation.deadline)
        self.assertLessEqual(receipt.deadline, time() + TEST_EXPIRY_SECONDS)
        self.assertFalse(reservation.settled.done())
        state = await asyncio.wait_for(asyncio.shield(reservation.settled), TEST_TIMEOUT_SECONDS)
        self.assertIs(state, ResourceState.EXPIRED)
        await pool.cancel(reservation)
        self.assertIs(pool.reservation(receipt.reservation_id), reservation)
        self.assertIs(pool.reservation_for(receipt.request_id), reservation)

    async def test_terminal_tombstones_are_bounded_and_expire(self) -> None:
        pool = self.pool(
            tombstone_limit=TEST_TOMBSTONE_LIMIT, tombstone_seconds=TEST_EXPIRY_SECONDS
        )
        rows = []
        for index in range(TEST_TOMBSTONE_LIMIT + 1):
            row = await self.reserve(pool, f"terminal-{index}")
            await pool.cancel(row)
            rows.append(row)
        self.assertIsNone(pool.reservation(rows[0].reservation_id))
        self.assertIsNone(pool.reservation_for(rows[0].request_id))
        self.assertIs(pool.reservation(rows[-1].reservation_id), rows[-1])
        self.assertIsNone(rows[-1].slot)
        self.assertEqual(rows[-1].arguments, {})
        await asyncio.sleep(TEST_EXPIRY_GRACE_SECONDS)
        self.assertIsNone(pool.reservation(rows[-1].reservation_id))
        self.assertIsNone(pool.reservation_for(rows[-1].request_id))

    async def test_evidence_preserves_ownership_without_compatibility_material(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "evidence", TEST_SECRET_VALUE)
        lease = await pool.consume(reservation)
        active = asdict(lease.evidence)
        self.assertEqual(active["host_id"], lease.host_id)
        self.assertEqual(active["lease_id"], lease.lease_id)
        self.assertEqual(active["process_generation"], 1)
        self.assertEqual(active["role"], HostRole.EXECUTION.value)
        self.assertNotIn(TEST_SECRET_VALUE, repr(reservation))
        self.assertNotIn(TEST_SECRET_VALUE, repr(active))
        self.assertNotIn(reservation.key[2], repr(active))
        await lease.close()
        stopped = asdict(lease.evidence)
        self.assertEqual(stopped["host_id"], active["host_id"])
        self.assertEqual(stopped["lease_id"], active["lease_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertIsNone(reservation.slot)

    async def test_shared_start_failure_finishes_all_reservations_once(self) -> None:
        pool = self.pool()

        def fail_start(host: ControlledHost) -> None:
            host.start_gate.clear()
            host.start_error = AppServerError("controlled startup failure")

        self.host_hook = fail_start
        first = await self.reserve(pool, "first")
        second = await self.reserve(pool, "second")
        host = self.hosts[0]
        host.start_gate.set()
        await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        await pool.cancel(first)
        await pool.cancel(second)
        self.assertIs(first.state, ResourceState.REJECTED)
        self.assertIs(second.state, ResourceState.REJECTED)
        self.assertEqual(host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_shutdown_joins_safe_close_without_escalating(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "safe-stop"))
        lease.host.close_gate.clear()
        safe_close = asyncio.create_task(lease.close(safe=True))
        await asyncio.wait_for(lease.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        shutdown = asyncio.create_task(pool.aclose())
        await asyncio.sleep(0)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertEqual(lease.host.safe_close_calls, 1)
        self.assertEqual(lease.host.close_calls, 1)
        lease.host.close_gate.set()
        await asyncio.gather(safe_close, shutdown)
        self.assertEqual(lease.host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_cancelled_shutdown_waiter_does_not_cancel_physical_shutdown(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "shutdown"))
        lease.host.close_gate.clear()
        shutdown = asyncio.create_task(pool.aclose())
        await asyncio.wait_for(lease.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        shutdown.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await shutdown
        self.assertEqual(self.capacity(pool).used, 1)
        lease.host.close_gate.set()
        await asyncio.wait_for(pool.aclose(), TEST_TIMEOUT_SECONDS)
        self.assertEqual(lease.host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_safe_close_failure_preserves_capacity_and_queryable_failure(self) -> None:
        pool = CodexHostPool(CapacityPolicy(execution_hosts=1, control_hosts=1))
        reservation = await self.reserve(pool, "stop-failure")
        lease = await pool.consume(reservation)
        lease.host.close_error = AppServerError("controlled close failure")
        with self.assertRaises(AppServerError):
            await lease.close(safe=True)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertIs(pool.reservation(reservation.reservation_id), reservation)
        self.assertEqual(lease.evidence.state, "stopping")
        with self.assertRaises(AppServerError):
            await lease.close(safe=True)
        self.assertEqual(lease.host.safe_close_calls, 1)
        with self.assertRaises(BaseExceptionGroup):
            await pool.aclose()
        self.assertEqual(self.capacity(pool).used, 1)

    async def test_explicit_retry_recovers_busy_pre_eof_close(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "retry-close"))
        lease.host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
        with self.assertRaises(AppServerError):
            await lease.close(safe=True, expected_generation=1)
        self.assertEqual(self.capacity(pool).used, 1)
        lease.host.close_error = None
        await lease.retry_close(expected_generation=1)
        self.assertEqual(lease.host.safe_close_calls, 2)
        self.assertEqual(self.capacity(pool).used, 0)
        await lease.close()
        self.assertEqual(lease.host.safe_close_calls, 2)

    async def test_concurrent_explicit_retries_share_one_physical_attempt(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "retry-shared"))
        lease.host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
        with self.assertRaises(AppServerError):
            await lease.close(safe=True, expected_generation=1)
        lease.host.close_error = None
        lease.host.close_gate.clear()
        first = asyncio.create_task(lease.retry_close(expected_generation=1))
        second = asyncio.create_task(lease.retry_close(expected_generation=1))
        await asyncio.sleep(0)
        self.assertEqual(self.capacity(pool).used, 1)
        lease.host.close_gate.set()
        await asyncio.gather(first, second)
        self.assertEqual(lease.host.safe_close_calls, 2)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_retry_does_not_replace_an_inflight_safe_close(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "retry-inflight"))
        lease.host.close_gate.clear()
        closing = asyncio.create_task(lease.close(safe=True, expected_generation=1))
        await asyncio.wait_for(lease.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        retry = asyncio.create_task(lease.retry_close(expected_generation=1))
        await asyncio.sleep(0)
        lease.host.close_gate.set()
        await asyncio.gather(closing, retry)
        self.assertEqual(lease.host.safe_close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_retry_refuses_changed_generation_and_preserves_ownership(self) -> None:
        pool = CodexHostPool(CapacityPolicy(execution_hosts=1, control_hosts=1))
        lease = await pool.consume(await self.reserve(pool, "retry-stale"))
        lease.host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
        with self.assertRaises(AppServerError):
            await lease.close(safe=True, expected_generation=1)
        lease.host.readiness.process_generation = 2
        with self.assertRaises(AppServerError) as context:
            await lease.retry_close(expected_generation=1)
        self.assertEqual(context.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertEqual(lease.host.safe_close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 1)

    async def test_retry_refuses_eof_committed_or_forced_close(self) -> None:
        for safe, committed in ((True, True), (False, False)):
            with self.subTest(safe=safe, committed=committed):
                pool = CodexHostPool(CapacityPolicy(execution_hosts=1, control_hosts=1))
                lease = await pool.consume(await self.reserve(pool, "retry-refused"))
                lease.host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
                with self.assertRaises(AppServerError):
                    await lease.close(safe=safe, expected_generation=1)
                lease.host.stop_committed = committed
                with self.assertRaises(AppServerError):
                    await lease.retry_close(expected_generation=1)
                self.assertEqual(lease.host.close_calls, 1)
                self.assertEqual(self.capacity(pool).used, 1)

    async def test_invalid_deadline_never_starts_a_host(self) -> None:
        pool = self.pool()
        for deadline in (float("nan"), float("inf"), True):
            with self.subTest(deadline=deadline), self.assertRaises(AppServerError):
                await self.reserve(pool, "invalid", deadline=deadline)
        self.assertEqual(self.hosts, [])


class PoolProbeOwnershipContracts(unittest.TestCase):
    def test_separate_event_loops_never_share_a_probe_lock_or_cached_result(self) -> None:
        locks = []
        readiness = CodexRuntimeReadiness(
            runtime_id=TEST_RUNTIME_ID,
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable=TEST_EXECUTABLE,
            version=TEST_VERSION,
        )

        async def scenario():
            pool = CodexHostPool()
            locks.append(pool._readiness_probe_lock)

            async def probe(*_args, **_kwargs):
                await asyncio.sleep(0)
                return readiness

            with patch.object(
                pool_module, "_probe_codex_cli_readiness", AsyncMock(side_effect=probe)
            ) as queried:
                await asyncio.gather(
                    *(
                        pool.probe_readiness(TEST_EXECUTABLE, process_environment={})
                        for _ in range(2)
                    )
                )
                self.assertEqual(queried.await_count, 1)
            await pool.aclose()

        asyncio.run(scenario())
        asyncio.run(scenario())
        self.assertIsNot(locks[0], locks[1])


class CapacityPolicyContracts(unittest.TestCase):
    def test_invalid_policy_values_fail_before_any_host_is_created(self) -> None:
        invalid = (
            {"execution_hosts": True},
            {"control_hosts": 0},
            {"queue_limit": -1},
            {"wait_seconds": float("nan")},
            {"idle_seconds": float("inf")},
            {"wait_seconds": False},
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValueError):
                CapacityPolicy(**values)
        for values in ({"unknown": {}}, {"capacity": {"unknown": 1}}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                CapacityPolicy.parse(values)


class RealProcessLifecycleContracts(unittest.IsolatedAsyncioTestCase):
    async def test_stdout_eof_retains_process_until_os_exit_before_recovery(self) -> None:
        child = "import os,sys; print('ready',flush=True); " "os.close(1); sys.stdin.buffer.read(1)"
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            child,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None
        self.assertEqual(await process.stdout.readline(), TEST_CHILD_READY)
        host = CodexProcessHost(executable=sys.executable)
        host._proc = process
        host._generation = 1
        host.state = CodexProcessState.READY
        disconnected = asyncio.Event()
        attachment = SimpleNamespace(
            thread_id="eof-root",
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=host.process_generation,
            turn=SimpleNamespace(
                connection_lost=AsyncMock(side_effect=lambda *_: disconnected.set())
            ),
        )
        host._threads[attachment.thread_id] = attachment
        with patch.object(host, "_schedule_recovery", Mock()) as recovery:
            reader = asyncio.create_task(host._read_stdout(process, host.process_generation))
            host._reader_task = reader
            try:
                await asyncio.wait_for(disconnected.wait(), TEST_TIMEOUT_SECONDS)
                self.assertIsNone(process.returncode)
                self.assertIs(host._proc, process)
                self.assertEqual(host.pid, process.pid)
                self.assertFalse(reader.done())
                self.assertIs(host.state, CodexProcessState.CRASHED)
                recovery.assert_not_called()
                self.assertFalse(
                    any(row.kind is RuntimeProcessEventKind.EXITED for row in host._process_events)
                )
                with patch("asyncio.create_subprocess_exec", AsyncMock()) as launch:
                    for start in (host.start, host._start_process):
                        with self.assertRaises(AppServerError) as blocked:
                            await start()
                        self.assertEqual(blocked.exception.safe_error, "agent_runtime_unavailable")
                        self.assertIs(
                            blocked.exception.retryability, RuntimeRetryability.IN_PROGRESS
                        )
                    launch.assert_not_called()
                process.stdin.write(TEST_CHILD_RELEASE)
                await process.stdin.drain()
                await asyncio.wait_for(reader, TEST_TIMEOUT_SECONDS)
                self.assertEqual(process.returncode, 0)
                self.assertIsNone(host._proc)
                recovery.assert_called_once()
                incident = recovery.call_args.args[0]
                self.assertEqual(incident.process_exit_code, 0)
                exited = [
                    row
                    for row in host._process_events
                    if row.kind is RuntimeProcessEventKind.EXITED
                ]
                self.assertEqual(len(exited), 1)
                self.assertEqual(exited[0].process_exit_code, 0)
            finally:
                host._threads.clear()
                if not process.stdin.is_closing():
                    process.stdin.close()
                await asyncio.wait_for(process.wait(), TEST_TIMEOUT_SECONDS)
                await asyncio.gather(reader, return_exceptions=True)
                await host.aclose()

    async def test_safe_close_after_stdout_eof_joins_the_owned_os_process(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-eof-close-") as directory:
            release = Path(directory) / "release"
            child = (
                "import os,pathlib,sys,time; print('ready',flush=True); "
                "os.close(1); sys.stdin.buffer.read(); "
                f"release=pathlib.Path({str(release)!r}); "
                "exec('while not release.exists(): time.sleep(0.01)')"
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                child,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None
            self.assertEqual(await process.stdout.readline(), TEST_CHILD_READY)
            host = CodexProcessHost(executable=sys.executable)
            host._proc = process
            host._generation = 1
            host.state = CodexProcessState.READY
            request_id, pending = host._rpc_requests.begin(host.process_generation, "eof-contract")
            reader = asyncio.create_task(host._read_stdout(process, host.process_generation))
            host._reader_task = reader
            stopping = None
            try:
                with self.assertRaises(AppServerError) as lost:
                    await asyncio.wait_for(pending.future, TEST_TIMEOUT_SECONDS)
                self.assertEqual(lost.exception.safe_error, "agent_runtime_exit")
                self.assertIs(host._proc, process)
                self.assertIsNone(process.returncode)
                stopping = asyncio.create_task(host.stop_idle(host.process_generation))
                async with asyncio.timeout(TEST_TIMEOUT_SECONDS):
                    while not host.stop_committed:
                        await asyncio.sleep(0)
                self.assertFalse(stopping.done())
                self.assertIs(host._proc, process)
                self.assertIs(host.state, CodexProcessState.CLOSING)
                release.touch()
                await asyncio.wait_for(stopping, TEST_TIMEOUT_SECONDS)
                self.assertEqual(process.returncode, 0)
                self.assertIs(host.state, CodexProcessState.STOPPED)
                self.assertIsNone(host._proc)
                self.assertIsNone(host.recovery_task)
            finally:
                release.touch()
                if process.stdin is not None and not process.stdin.is_closing():
                    process.stdin.close()
                await asyncio.wait_for(process.wait(), TEST_TIMEOUT_SECONDS)
                await asyncio.gather(reader, return_exceptions=True)
                if stopping is not None:
                    await asyncio.gather(stopping, return_exceptions=True)
                host._rpc_requests.discard(request_id)
                await host.aclose()

    async def test_explicit_discard_retains_process_until_os_exit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-discard-ownership-") as directory:
            release = Path(directory) / "release"
            child = (
                "import pathlib,sys,time; print('ready',flush=True); "
                "sys.stdin.buffer.read(); print('eof',flush=True); "
                f"release=pathlib.Path({str(release)!r}); "
                "exec('while not release.exists(): time.sleep(0.01)')"
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                child,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None
            self.assertEqual(await process.stdout.readline(), TEST_CHILD_READY)
            host = CodexProcessHost(executable=sys.executable)
            host._proc = process
            host._generation = 1
            host.state = CodexProcessState.CRASHED
            discarding = asyncio.create_task(
                host._discard_process(process, host.process_generation)
            )
            try:
                self.assertEqual(await process.stdout.readline(), TEST_CHILD_EOF)
                self.assertIsNone(process.returncode)
                self.assertIs(host._proc, process)
                self.assertFalse(discarding.done())
                with self.assertRaises(AppServerError) as blocked:
                    await host.start()
                self.assertEqual(blocked.exception.safe_error, "agent_runtime_unavailable")
                release.touch()
                await asyncio.wait_for(discarding, TEST_TIMEOUT_SECONDS)
                self.assertEqual(process.returncode, 0)
                self.assertIsNone(host._proc)
            finally:
                release.touch()
                await asyncio.wait_for(process.wait(), TEST_TIMEOUT_SECONDS)
                await asyncio.gather(discarding, return_exceptions=True)
                await host.aclose()

    async def test_safe_stop_waits_for_real_child_without_killing(self) -> None:
        child = (
            "import sys,time; "
            "print('ready',flush=True); "
            "sys.stdin.buffer.read(); "
            "print('eof',flush=True); "
            f"time.sleep({TEST_CHILD_DELAY_SECONDS!r})"
        )
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            child,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdout is not None
        self.assertEqual(await process.stdout.readline(), TEST_CHILD_READY)
        host = CodexProcessHost(executable=sys.executable)
        host._proc = process
        host._generation = 1
        host.state = CodexProcessState.READY
        stopping = asyncio.create_task(host.stop_idle(host.process_generation))
        try:
            self.assertEqual(await process.stdout.readline(), TEST_CHILD_EOF)
            await asyncio.sleep(TEST_CHILD_CHECK_SECONDS)
            self.assertIsNone(process.returncode)
            self.assertFalse(stopping.done())
            await asyncio.wait_for(stopping, TEST_TIMEOUT_SECONDS)
            self.assertEqual(process.returncode, 0)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            await asyncio.gather(stopping, return_exceptions=True)
            await host.aclose()

    @unittest.skipUnless(os.environ.get(TEST_EXECUTABLE_ENV), "explicit Codex test binary required")
    async def test_real_codex_initialize_and_safe_eof_exit_without_account(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-capacity-contract-") as directory:
            runtime_home = Path(directory) / "codex-home"
            runtime_home.mkdir()
            pool = CodexHostPool(CapacityPolicy(execution_hosts=1, control_hosts=1))
            request = CodexSessionOpenRequest(
                request_id="real-control-capacity",
                runtime_id=TEST_RUNTIME_ID,
                cwd=Path(directory),
                executable=os.environ[TEST_EXECUTABLE_ENV],
                authentication_required=False,
                process_environment={CODEX_HOME_ENV: str(runtime_home)},
            )
            try:
                reservation = await pool.reserve(
                    request,
                    role=HostRole.CONTROL,
                    request_id=request.request_id,
                    deadline=time() + TEST_WAIT_SECONDS,
                )
                lease = await asyncio.wait_for(pool.consume(reservation), TEST_TIMEOUT_SECONDS)
                self.assertTrue(lease.host.readiness.ready)
                self.assertIsNotNone(lease.host.pid)
                process = lease.host._proc
                self.assertIsNotNone(process)
                await asyncio.wait_for(lease.close(safe=True), TEST_TIMEOUT_SECONDS)
                self.assertEqual(process.returncode, 0)
                self.assertEqual(sum(row.used for row in pool.snapshot()), 0)
                self.assertFalse((runtime_home / "auth.json").exists())
            finally:
                await pool.aclose()


if __name__ == "__main__":
    unittest.main()
