"""Capacity contracts and process-lifecycle checks; these are not product acceptance."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from dataclasses import asdict, replace
from pathlib import Path
from time import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import scholarseed_codex.environment as environment_module
import scholarseed_codex.executable as executable_module
import scholarseed_codex.pool as pool_module
import scholarseed_codex.provider as provider_module
from scholarseed_codex.admission import NativeAdmission, NativeQuiescence
from scholarseed_codex.attachment import ThreadAttachment
from scholarseed_codex.capacity import (
    CODEX_HOST_START_FAILED,
    CODEX_THREAD_UNLOAD_CONFIG,
    DEFAULT_THREAD_UNLOAD_SECONDS,
    CapacityPolicy,
    HostRole,
    HostState,
)
from scholarseed_codex.control import CodexRuntimeControl
from scholarseed_codex.coordination import MCP_APPLICATION_FAILED, MCP_COORDINATOR_CLOSED
from scholarseed_codex.environment import CODEX_HOME_ENV, SCHOLARSEED_CODEX_HOME_ENV
from scholarseed_codex.isolation import managed_codex_launch
from scholarseed_codex.launch import (
    CODEX_MODEL_CONNECTION_REQUIRED,
    model_connection,
    validate_thread_model,
)
from scholarseed_codex.permission import WINDOWS_PLATFORM, thread_permission_config
from scholarseed_codex.pool import (
    POOL_READINESS_LOG,
    READINESS_LOGGER,
    CodexHostPool,
    PoolReservation,
)
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import (
    CodexRuntimeLaunchArgument,
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
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_codex.sandbox import SANDBOX_ARGUMENT, SANDBOX_SETUP_TIMEOUT_SECONDS
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_runtime.contract.command import CommandState, HostWarmupRequest, OpenSessionRequest
from scholarseed_runtime.contract.evidence import RuntimeProcessEventKind
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.inventory import SkillPolicy
from scholarseed_runtime.contract.model import ModelIntent, ModelTransport
from scholarseed_runtime.contract.provider import RuntimeOpenNotAppliedError
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
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
TEST_ROOT_THREAD_COUNT = 129
# The Windows venv redirector retains inherited pipes until its child exits.
# Use the same bundled base interpreter so EOF and process exit remain independent.
TEST_CHILD_EXECUTABLE = sys._base_executable
TEST_CHILD_READY = b"ready"
TEST_CHILD_EOF = b"eof"
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
        self.provider_configuration = arguments.get("provider_configuration", {})
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
        self.reusable = True
        self.admission = NativeAdmission()
        self.native_busy = False
        self.request = AsyncMock(return_value={})
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

    async def configuration_quiescence(self, revision: int) -> NativeQuiescence | None:
        if self.native_busy or not self.admission.frozen(revision):
            return None
        return NativeQuiescence(
            revision, self.readiness.process_generation, 0, self.admission.epoch
        )


class ModelConfigurationContracts(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_connection_overrides_untrusted_provider_tables(self):
        request = CodexSessionOpenRequest("request", "codex", Path.cwd())
        for providers in (None, False, 1, "provider", [], {"openai": {}}):
            with self.subTest(providers=providers):
                configured = await model_connection(
                    ModelIntent(transport=ModelTransport(endpoint="https://model.example.test")),
                    replace(request, thread_config={"model_providers": providers}),
                    None,
                    timing=request.timing,
                )
                self.assertEqual(set(configured.provider_configuration), {"scholarseed"})
                self.assertFalse(
                    configured.provider_configuration["scholarseed"]["requires_openai_auth"]
                )

    def test_remote_endpoint_requires_nonempty_text(self):
        request = CodexSessionOpenRequest(
            "request", "codex", Path.cwd(), model_provider="scholarseed"
        )
        for endpoint in (None, False, 1, 1.5, {}, [], "", " \t\n"):
            with self.subTest(endpoint=endpoint):
                configured = replace(
                    request,
                    thread_config={"model_providers": {"scholarseed": {"base_url": endpoint}}},
                )
                with self.assertRaises(AppServerError) as caught:
                    validate_thread_model(configured)
                self.assertEqual(caught.exception.safe_error, CODEX_MODEL_CONNECTION_REQUIRED)
        validate_thread_model(
            replace(
                request,
                thread_config={
                    "model_providers": {"scholarseed": {"base_url": "https://model.example.test"}}
                },
            )
        )

    def test_native_provider_does_not_require_remote_endpoint(self):
        validate_thread_model(
            CodexSessionOpenRequest("request", "codex", Path.cwd(), model_provider="openai")
        )


class CapacityContracts(unittest.IsolatedAsyncioTestCase):
    @contextmanager
    def warmup_provider(self):
        runtime = CodexRuntimeProvider()
        runtime._pool = self.pool()

        async def connection(intent, request, *args, **kwargs):
            return replace(
                request,
                model=intent.model_ref,
            )

        async def catalog(intent, request, **kwargs):
            return CodexRuntimeLaunchArgument(
                option="-c", value=f"model_catalog_json={intent.model_ref}"
            )

        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(runtime._pool, "prepare_home", return_value=Path(temporary)),
            patch.object(
                provider_module, "configured_codex_executable", return_value=TEST_EXECUTABLE
            ),
            patch.object(provider_module, "managed_codex_launch", return_value=({}, ())),
            patch.object(provider_module, "model_connection", side_effect=connection),
            patch.object(runtime._pool, "model_catalog_argument", side_effect=catalog) as compiled,
        ):

            def request(model):
                return HostWarmupRequest(
                    request_id=model,
                    cwd=Path(temporary),
                    process_sharing_scope="owner",
                    model=ModelIntent(
                        model_ref=model,
                        transport=ModelTransport(
                            endpoint="https://model.example.test/v1", supports_websockets=True
                        ),
                    ),
                )

            yield runtime, request, compiled

    async def test_official_runtime_rejects_denied_skills_without_starting_host(self):
        pool = CodexHostPool()
        await pool.require_skill_policy(SkillPolicy.INHERIT, TEST_EXECUTABLE)
        for policy in (SkillPolicy.DENY, "deny", None):
            with self.subTest(policy=policy):
                with self.assertRaises(AppServerError) as caught:
                    await pool.require_skill_policy(policy, TEST_EXECUTABLE)
                self.assertEqual(caught.exception.safe_error, "runtime_skill_policy_unsupported")
                self.assertFalse(pool._hosts)
                self.assertFalse(pool._commands)
        await pool.aclose()

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

    async def test_windows_thread_workspaces_do_not_define_host_startup_policy(self) -> None:
        pool = self.pool(execution_hosts=3)
        first = replace(
            self.request("startup-a"),
            sandbox="workspace-write",
            cwd=Path.cwd(),
            launch_cwd=Path.cwd() / "discovery",
            execution_scope="startup-a",
            process_sharing_scope="owner",
        )
        second = replace(first, request_id="startup-b", cwd=Path.cwd() / "second-workspace")
        with patch.object(
            pool_module, "os", SimpleNamespace(name="nt", path=os.path, environ=os.environ)
        ):
            leases = []
            for request in (first, second):
                reservation = await pool.reserve(
                    request,
                    role=HostRole.EXECUTION,
                    request_id=request.request_id,
                    deadline=time() + TEST_WAIT_SECONDS,
                )
                leases.append(await pool.consume(reservation))
        self.assertIs(leases[0].host, leases[1].host)
        for lease, request in zip(leases, (first, second)):
            self.assertNotIn("startup_sandbox_policy", lease.host.arguments)
            self.assertEqual(lease.host.arguments["launch_cwd"], first.launch_cwd.resolve())
            await lease.close()

    async def test_physical_owner_outlives_execution_lease_and_releases_after_exit(self) -> None:
        ownership = Mock()
        pool = CodexHostPool(resource_lease=lambda: ownership)
        self.pools.append(pool)
        first = await pool.acquire(self.request("owned-control"))
        host = first.host
        self.assertFalse(await pool.release_idle())
        self.assertFalse(host.closed)
        await first.close()
        ownership.close.assert_not_called()
        self.assertTrue(await pool.release_idle())
        self.assertTrue(host.closed)
        ownership.close.assert_called_once_with()
        self.assertEqual(host.safe_close_calls, 1)
        second = await pool.acquire(self.request("after-drain"))
        self.assertIsNot(second.host, host)
        await second.close()
        self.assertTrue(await pool.release_idle())
        self.assertEqual(ownership.close.call_count, 2)

    async def test_cancelled_idle_release_retains_ownership_until_native_exit(self) -> None:
        ownership = Mock()
        pool = CodexHostPool(resource_lease=lambda: ownership)
        self.pools.append(pool)
        lease = await pool.acquire(self.request("cancel-idle"))
        host = lease.host
        await lease.close()
        host.close_gate.clear()
        task = asyncio.create_task(pool.release_idle())
        try:
            await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            ownership.close.assert_not_called()
            self.assertEqual(self.capacity(pool).used, 1)
        finally:
            host.close_gate.set()
        self.assertTrue(await pool.release_idle())
        ownership.close.assert_called_once_with()

    async def test_idle_release_busy_native_check_keeps_ownership_and_can_retry(self) -> None:
        ownership = Mock()
        pool = CodexHostPool(resource_lease=lambda: ownership)
        self.pools.append(pool)
        lease = await pool.acquire(self.request("busy-idle"))
        host = lease.host
        await lease.close()
        host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
        host.close_gate.clear()
        first = asyncio.create_task(pool.release_idle())
        second = asyncio.create_task(pool.release_idle())
        try:
            await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
            await asyncio.sleep(0)
        finally:
            host.close_gate.set()
        self.assertEqual(await asyncio.gather(first, second), [False, False])
        self.assertEqual(host.safe_close_calls, 1)
        ownership.close.assert_not_called()
        self.assertFalse(host.closed)
        host.close_error = None
        self.assertTrue(await pool.release_idle())
        ownership.close.assert_called_once_with()

    async def test_busy_idle_release_wakes_compatible_waiters_without_new_admission(self) -> None:
        ownership = Mock()
        pool = CodexHostPool(resource_lease=lambda: ownership)
        self.pools.append(pool)
        lease = await pool.acquire(self.request("busy-idle-waiters"))
        host = lease.host
        await lease.close()
        host.close_error = AppServerError("busy", safe_error=RUNTIME_SUSPEND_BUSY)
        host.close_gate.clear()
        closing = asyncio.create_task(pool.release_idle())
        try:
            await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
            first = await self.reserve(pool, "busy-idle-first")
            second = await self.reserve(pool, "busy-idle-second")
            self.assertIs(first.state, ResourceState.WAITING)
            self.assertIs(second.state, ResourceState.WAITING)
        finally:
            host.close_gate.set()
        self.assertFalse(await asyncio.wait_for(closing, TEST_TIMEOUT_SECONDS))
        host.close_error = None
        self.assertIs(first.state, ResourceState.GRANTED)
        self.assertIs(second.state, ResourceState.GRANTED)
        ownership.close.assert_not_called()
        first_lease = await asyncio.wait_for(pool.consume(first), TEST_TIMEOUT_SECONDS)
        second_lease = await asyncio.wait_for(pool.consume(second), TEST_TIMEOUT_SECONDS)
        self.assertIs(first_lease.host, host)
        self.assertIs(second_lease.host, host)
        self.assertEqual(host.safe_close_calls, 1)
        await first_lease.close()
        await second_lease.close()
        self.assertTrue(await pool.release_idle())
        ownership.close.assert_called_once_with()

    async def test_rejected_resource_ownership_never_starts_native_process(self) -> None:
        def denied():
            raise RuntimeError("resource admission refused")

        pool = CodexHostPool(resource_lease=denied)
        self.pools.append(pool)
        reservation = await self.reserve(pool, "denied-owner")
        self.assertIs(reservation.state, ResourceState.REJECTED)
        self.assertTrue(all(host.start_calls == 0 for host in self.hosts))
        self.assertTrue(await pool.release_idle())

    async def test_shared_control_host_timing_belongs_to_each_request(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        first_timing = TimingRecorder()
        second_timing = TimingRecorder()
        first_request = replace(
            self.request("timed-control-first"),
            timing=first_timing,
        )
        first = await pool.acquire(first_request)
        control = CodexRuntimeControl(cwd=first_request.cwd, lease=first, host_pool=pool)
        await control.open()
        self.assertIs(control.host, first.host)
        await control.aclose()
        await first.close()
        first_finished = tuple(first_timing.finished)
        second = await pool.acquire(
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

    async def test_suspended_threads_reuse_resident_host_until_explicit_drain(self) -> None:
        pool = self.pool(execution_hosts=None)
        first = await pool.acquire(self.request("retained-first"))
        host = first.host
        await first.close(safe=True, retain=True)
        self.assertEqual(pool.snapshot()[0].used, 1)
        second = await pool.acquire(self.request("retained-second"))
        self.assertIs(second.host, host)
        self.assertEqual(host.start_calls, 1)
        await second.close(safe=True, retain=True)
        await asyncio.sleep(0.1)
        self.assertEqual(host.safe_close_calls, 0)
        self.assertEqual(pool.snapshot()[0].used, 1)
        self.assertTrue(await pool.release_idle())
        self.assertEqual(host.safe_close_calls, 1)
        self.assertEqual(pool.snapshot()[0].used, 0)

    async def test_thread_unload_delay_uses_existing_native_launch_configuration(self) -> None:
        pool = self.pool()
        lease = await pool.acquire(self.request("native-thread-delay"))
        arguments = lease.host.arguments["launch_arguments"]
        self.assertIn(
            CodexRuntimeLaunchArgument(
                option="-c", value=f"{CODEX_THREAD_UNLOAD_CONFIG}={DEFAULT_THREAD_UNLOAD_SECONDS}"
            ),
            arguments,
        )
        await lease.close()
        self.assertFalse(lease.host.closed)

    async def test_unknown_attachment_cleanup_is_not_shared_or_retained(self) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("unknown-first"))
        sibling = await pool.acquire(self.request("known-sibling"))
        first.host.reusable = False
        waiting = await pool.reserve(
            self.request("unknown-waiter"),
            role=HostRole.EXECUTION,
            request_id="unknown-waiter",
            deadline=time() + TEST_WAIT_SECONDS,
        )
        self.assertIs(waiting.state, ResourceState.WAITING)
        await first.close()
        self.assertFalse(sibling.host.closed)
        await sibling.close()
        replacement = await pool.consume(waiting)
        self.assertTrue(first.host.closed)
        self.assertIsNot(replacement.host, first.host)
        await replacement.close()

    async def test_execution_configuration_conflict_never_expands_or_switches_host(self) -> None:
        pool = self.pool(execution_hosts=None)
        first = await pool.acquire(self.request("pinned-first"))
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        for phase in ("active", "unowned", "drained"):
            if phase == "unowned":
                await first.close()
            elif phase == "drained":
                self.assertTrue(await pool.release_idle())
            rejected = await self.reserve(pool, f"conflict-{phase}", "incompatible")
            self.assertIs(rejected.state, ResourceState.REJECTED)
            self.assertEqual(rejected.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
            self.assertEqual(len(self.hosts), 1)
            self.assertEqual(self.capacity(pool).waiting, 0)
            self.assertTrue(pool.execution_configured)
            if phase != "drained":
                self.assertFalse(first.host.closed)
        probe.assert_not_awaited()
        replacement = await pool.acquire(self.request("same-config-recovery"))
        self.assertIsNot(first.host, replacement.host)
        self.assertEqual(self.capacity(pool).used, 1)
        await replacement.close()

    async def test_provider_reconfiguration_serializes_close_target_and_old_prewarm(self) -> None:
        with self.warmup_provider() as (runtime, request, _compiled):
            self.assertIs((await runtime.prewarm(request("first"))).state, CommandState.APPLIED)
            old = self.hosts[0]
            old.close_gate.clear()
            switching = asyncio.create_task(runtime.reconfigure(request("target")))
            await old.close_entered.wait()
            previous = asyncio.create_task(runtime.prewarm(request("first")))
            await asyncio.sleep(0)
            self.assertEqual(len(self.hosts), 1)
            self.assertFalse(switching.done())
            self.assertFalse(previous.done())
            old.close_gate.set()
            self.assertIs((await switching).state, CommandState.APPLIED)
            self.assertIs((await previous).state, CommandState.RESTART_REQUIRED)
            self.assertTrue(old.closed)
            self.assertEqual(len(self.hosts), 2)
            self.assertEqual(self.capacity(runtime._pool).used, 1)

    async def test_explicit_reconfiguration_transfers_drained_account_identity(self) -> None:
        with self.warmup_provider() as (runtime, request, _compiled):
            previous = replace(request("first"), process_sharing_scope="local")
            target = replace(request("target"), process_sharing_scope="account")
            self.assertIs((await runtime.prewarm(previous)).state, CommandState.APPLIED)
            self.assertIs((await runtime.prewarm(target)).state, CommandState.RESTART_REQUIRED)
            old = self.hosts[0]
            self.assertIs((await runtime.reconfigure(target)).state, CommandState.APPLIED)
            self.assertTrue(old.closed)
            self.assertIs((await runtime.prewarm(previous)).state, CommandState.RESTART_REQUIRED)
            self.assertIs((await runtime.prewarm(target)).state, CommandState.APPLIED)
            self.assertEqual(len(self.hosts), 2)

    async def test_provider_switch_cancellation_waits_for_real_transaction(self) -> None:
        with self.warmup_provider() as (runtime, request, _compiled):
            await runtime.prewarm(request("first"))
            old = self.hosts[0]
            old.close_gate.clear()
            switching = asyncio.create_task(runtime.reconfigure(request("target")))
            await old.close_entered.wait()
            switching.cancel()
            await asyncio.sleep(0)
            self.assertFalse(switching.done())
            self.assertEqual(len(self.hosts), 1)
            old.close_gate.set()
            with self.assertRaises(asyncio.CancelledError):
                await switching
            self.assertTrue(old.closed)
            self.assertEqual(len(self.hosts), 2)

    async def test_provider_catalog_preflight_failure_keeps_old_host(self) -> None:
        with self.warmup_provider() as (runtime, request, compiled):
            await runtime.prewarm(request("first"))
            compiled.side_effect = ValueError("catalog failed")
            with self.assertRaises(ValueError):
                await runtime.reconfigure(request("target"))
            self.assertFalse(self.hosts[0].closed)
            self.assertTrue(runtime._pool.execution_configured)

    async def test_provider_failure_after_reset_fences_default_prewarm(self) -> None:
        with self.warmup_provider() as (runtime, request, _compiled):
            await runtime.prewarm(request("first"))
            with patch.object(
                runtime._pool, "probe_readiness", side_effect=OSError("probe failed")
            ):
                with self.assertRaises(OSError):
                    await runtime.reconfigure(request("target"))
            self.assertTrue(self.hosts[0].closed)
            result = await runtime.prewarm(request("first"))
            self.assertIs(result.state, CommandState.RESTART_REQUIRED)
            self.assertEqual(result.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
            self.assertEqual(len(self.hosts), 1)

    async def test_explicit_reset_requires_physical_drain_and_keeps_authority(self) -> None:
        pool = self.pool()
        first = await pool.acquire(
            replace(self.request("reset-first"), process_sharing_scope="owner")
        )
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_BUSY):
            await pool.reset_execution_configuration("owner")
        await first.close()
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_BUSY):
            await pool.reset_execution_configuration("owner")
        self.assertTrue(await pool.release_idle())
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_CONFIGURATION_CONFLICT):
            await pool.reset_execution_configuration("other-owner")
        self.assertTrue(pool.execution_configured)
        await pool.reset_execution_configuration("owner")
        self.assertFalse(pool.execution_configured)
        second = await pool.acquire(
            replace(self.request("reset-second", "b"), process_sharing_scope="owner")
        )
        self.assertTrue(first.host.closed)
        self.assertIsNot(first.host, second.host)
        self.assertEqual(self.capacity(pool).used, 1)
        await second.close()

    async def test_reconfiguration_cannot_clear_uncertain_control_mutation(self) -> None:
        pool = self.pool()
        pool.fence_reconfiguration()
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_CONFIGURATION_UNCERTAIN):
            await pool.reset_execution_configuration("owner")
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_CONFIGURATION_UNCERTAIN):
            await pool.replace_execution_scope("another-owner")
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_CONFIGURATION_UNCERTAIN):
            await pool.acquire(self.request("fenced"))
        self.assertEqual(len(self.hosts), 0)

    async def test_identity_handover_requires_all_old_resources_to_finish(self) -> None:
        pool = self.pool()
        first = await pool.acquire(
            replace(self.request("identity-first"), process_sharing_scope="old")
        )
        for phase in ("active", "unowned"):
            if phase == "unowned":
                await first.close()
            with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_BUSY):
                await pool.replace_execution_scope("new")
            pool.authorize_scope("old")
        self.assertTrue(await pool.release_idle())
        gate = asyncio.Event()
        cleanup = pool._background(gate.wait())
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_BUSY):
            await pool.replace_execution_scope("new")
        gate.set()
        await cleanup
        await pool.replace_execution_scope("new")
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_CONFIGURATION_CONFLICT):
            pool.authorize_scope("old")
        pool.authorize_scope("new")

    async def test_identity_handover_failure_is_fenced_not_retryable_rejection(self) -> None:
        with self.warmup_provider() as (runtime, request, compiled):
            await runtime.prewarm(request("first"))
            compiled.side_effect = ValueError("catalog failed after identity handover")
            result = await runtime.reconfigure(
                replace(request("target"), process_sharing_scope="new")
            )
            self.assertIs(result.state, CommandState.RESTART_REQUIRED)
            self.assertEqual(result.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
            self.assertTrue(self.hosts[0].closed)
            self.assertEqual(
                (await runtime.prewarm(request("first"))).safe_error,
                RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
            )

    async def test_reset_rejects_pending_native_cleanup(self) -> None:
        pool = self.pool()
        gate = asyncio.Event()
        cleanup = pool._background(gate.wait())
        with self.assertRaisesRegex(AppServerError, RESOURCE_HOST_BUSY):
            await pool.reset_execution_configuration("owner")
        gate.set()
        await cleanup
        await pool.reset_execution_configuration("owner")

    async def test_removing_an_absent_variable_does_not_partition_frozen_environment(self) -> None:
        pool = self.pool()
        absent = "SCHOLARSEED_ABSENT_REMOVAL_FIXTURE"
        with patch.dict(os.environ, {}, clear=True):
            first = await pool.acquire(self.request("remove-first"))
            second = await pool.acquire(
                replace(
                    self.request("remove-second"),
                    remove_environment=(absent,),
                )
            )
            self.assertIs(first.host, second.host)
            with self.assertRaises(AppServerError):
                await pool.reserve(
                    self.request("remove-second"),
                    role=HostRole.EXECUTION,
                    request_id="remove-second",
                    deadline=time() + TEST_WAIT_SECONDS,
                )
            await asyncio.gather(first.close(), second.close())

    async def test_simultaneous_incompatible_admissions_publish_only_one_execution_host(
        self,
    ) -> None:
        pool = self.pool(execution_hosts=None)
        first, second = await asyncio.gather(
            self.reserve(pool, "race-a", "a"),
            self.reserve(pool, "race-b", "b"),
        )
        self.assertCountEqual(
            [first.state, second.state],
            [ResourceState.GRANTED, ResourceState.REJECTED],
        )
        self.assertEqual(len(self.hosts), 1)
        rejected = next(row for row in (first, second) if row.state is ResourceState.REJECTED)
        self.assertEqual(rejected.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        granted = next(row for row in (first, second) if row.state is ResourceState.GRANTED)
        await (await pool.consume(granted)).close()

    async def test_distinct_execution_scopes_never_share_process(self) -> None:
        pool = self.pool(execution_hosts=None)
        first = await pool.acquire(replace(self.request("account-a"), execution_scope="account-a"))
        with self.assertRaises(AppServerError) as caught:
            await pool.acquire(replace(self.request("account-b"), execution_scope="account-b"))
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertEqual(len(self.hosts), 1)
        self.assertFalse(first.host.closed)
        await first.close()

    async def test_authorized_sessions_share_startup_and_release_independent_leases(self) -> None:
        pool = self.pool(execution_hosts=None)
        first_request = replace(
            self.request("session-a"),
            execution_scope="session-a",
            process_sharing_scope="user-a",
        )
        second_request = replace(
            first_request,
            request_id="session-b",
            execution_scope="session-b",
            model="different-thread-model",
            developer_instructions="different-thread-instructions",
        )
        with patch.object(pool_module, "os", SimpleNamespace(name="posix", path=os.path)):
            first, second = await asyncio.gather(
                pool.acquire(first_request), pool.acquire(second_request)
            )
        self.assertIs(first.host, second.host)
        self.assertNotEqual(first.lease_id, second.lease_id)
        assert isinstance(first.host, ControlledHost)
        assert isinstance(second.host, ControlledHost)
        self.assertEqual(first.host.start_calls, 1)
        await first.close(safe=True, retain=True)
        self.assertFalse(second.host.closed)
        self.assertEqual(second.host.close_calls, 0)
        await second.close(safe=True, retain=True)
        self.assertEqual(second.host.close_calls, 0)
        self.assertTrue(await pool.release_idle())
        self.assertEqual(second.host.close_calls, 1)

    async def test_sharing_domain_never_merges_incompatible_process_configuration(self) -> None:
        pool = self.pool(execution_hosts=None)
        original = replace(
            self.request("session-a"),
            execution_scope="session-a",
            process_sharing_scope="user-a",
        )
        differences = (
            {"process_sharing_scope": "user-b"},
            {"process_sharing_scope": ""},
            {"cwd": original.cwd / "other-project"},
            {"skill_roots": (original.cwd / "other-skills",)},
            {"process_environment": {TEST_HOST_ENV: "rotated-credential"}},
            {"launch_arguments": (CodexRuntimeLaunchArgument(option="--other"),)},
        )
        with patch.object(pool_module, "os", SimpleNamespace(name="posix", path=os.path)):
            first = await pool.acquire(original)
            for index, difference in enumerate(differences):
                with self.subTest(difference=difference):
                    with self.assertRaises(AppServerError) as caught:
                        await pool.acquire(
                            replace(
                                original,
                                request_id=f"different-{index}",
                                execution_scope=f"different-{index}",
                                **difference,
                            )
                        )
                    self.assertEqual(
                        caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT
                    )
                    self.assertEqual(len(self.hosts), 1)
                    self.assertFalse(first.host.closed)
            await first.close()

    async def test_ephemeral_persistence_does_not_bypass_shared_skill_roots(self) -> None:
        application_roots = (Path(tempfile.gettempdir()) / "application-skills",)
        for ephemeral_first in (False, True):
            with self.subTest(ephemeral_first=ephemeral_first):
                pool = self.pool(execution_hosts=None)
                original = replace(
                    self.request("roots-first"),
                    process_sharing_scope="owner",
                    ephemeral=ephemeral_first,
                    skill_roots=() if ephemeral_first else application_roots,
                )
                first = await pool.acquire(original)
                host_count = len(self.hosts)
                incompatible = replace(
                    original,
                    request_id="roots-other",
                    ephemeral=not ephemeral_first,
                    skill_roots=application_roots if ephemeral_first else (),
                    thread_config={
                        "skills.include_instructions": False,
                        "skills.bundled.enabled": False,
                        "features.skip_host_skill_discovery": True,
                    },
                )
                for after_release in (False, True):
                    if after_release:
                        await first.close()
                    with self.assertRaises(AppServerError) as rejected:
                        await pool.acquire(
                            replace(incompatible, request_id=f"roots-other-{after_release}")
                        )
                    self.assertEqual(
                        rejected.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT
                    )
                    self.assertEqual(len(self.hosts), host_count)
                    self.assertFalse(first.host.closed)
                    self.assertEqual(first.host.start_calls, 1)
                compatible = await pool.acquire(
                    replace(original, request_id="roots-compatible", ephemeral=not ephemeral_first)
                )
                self.assertIs(compatible.host, first.host)
                await compatible.close()
                self.assertFalse(first.host.closed)

    async def test_launch_cwd_and_thread_environment_have_independent_compatibility(self) -> None:
        pool = self.pool(execution_hosts=None)
        launch_cwd = Path(tempfile.gettempdir()) / "managed-host"
        original = replace(
            self.request("session-a"),
            cwd=Path(tempfile.gettempdir()) / "session-a",
            launch_cwd=launch_cwd,
            execution_scope="session-a",
            process_sharing_scope="user-a",
            thread_config={"shell_environment_policy.set.TEXMFVAR": "cache-a"},
        )
        changed = replace(
            original,
            request_id="session-b",
            cwd=original.cwd.parent / "session-b",
            execution_scope="session-b",
            thread_config={"shell_environment_policy.set.TEXMFVAR": "cache-b"},
        )
        with patch.object(pool_module, "os", SimpleNamespace(name="posix", path=os.path)):
            first, second = await asyncio.gather(pool.acquire(original), pool.acquire(changed))
            self.assertIs(first.host, second.host)
            assert isinstance(first.host, ControlledHost)
            self.assertEqual(first.host.arguments["launch_cwd"], launch_cwd.resolve())
            reservation = await pool.reserve(
                changed,
                role=HostRole.EXECUTION,
                request_id=changed.request_id,
                deadline=time() + TEST_WAIT_SECONDS,
            )
            with self.assertRaises(AppServerError):
                await pool.reserve(
                    replace(changed, thread_config=original.thread_config),
                    role=HostRole.EXECUTION,
                    request_id=changed.request_id,
                    deadline=time() + TEST_WAIT_SECONDS,
                )
            self.assertIsNotNone(reservation)
            with self.assertRaises(AppServerError) as caught:
                await pool.acquire(
                    replace(changed, request_id="session-c", launch_cwd=launch_cwd / "other")
                )
            self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
            await asyncio.gather(first.close(), second.close())

    async def test_native_thread_policies_do_not_partition_authorized_hosts(self) -> None:
        for platform in ("posix", "nt"):
            with (
                self.subTest(platform=platform),
                patch.object(pool_module, "os", SimpleNamespace(name=platform, path=os.path)),
            ):
                pool = self.pool(execution_hosts=1)
                first_request = replace(
                    self.request(f"policy-a-{platform}"),
                    execution_scope="policy-a",
                    process_sharing_scope="owner",
                    launch_cwd=Path.cwd() / "discovery",
                    sandbox="workspace-write",
                    writable_roots=(Path.cwd() / "authorized-a",),
                )
                first = await pool.acquire(first_request)
                second_request = replace(
                    first_request,
                    request_id=f"policy-b-{platform}",
                    execution_scope="policy-b",
                    cwd=Path.cwd() / "workspace-b",
                    sandbox="read-only",
                    approval_policy="never",
                    network_access=True,
                    writable_roots=(),
                    thread_config={"permissions.independent": {"extends": ":read-only"}},
                )
                second = await pool.acquire(second_request)
                self.assertIs(first.host, second.host)
                with self.assertRaises(AppServerError):
                    await pool.reserve(
                        replace(second_request, network_access=False, sandbox="workspace-write"),
                        role=HostRole.EXECUTION,
                        request_id=second_request.request_id,
                        deadline=time() + TEST_WAIT_SECONDS,
                    )
                await asyncio.gather(first.close(), second.close())

    async def test_platforms_share_the_same_authorized_context(
        self,
    ) -> None:
        for platform in ("nt", "posix"):
            with (
                self.subTest(platform=platform),
                patch.object(pool_module, "os", SimpleNamespace(name=platform, path=os.path)),
            ):
                pool = self.pool(execution_hosts=None)
                original = replace(
                    self.request("session-a"),
                    execution_scope="session-a",
                    process_sharing_scope="user-a",
                    launch_cwd=Path(tempfile.gettempdir()) / "ignored-shared-host",
                )
                first = await pool.acquire(original)
                second = await pool.acquire(
                    replace(original, request_id="session-b", execution_scope="session-b")
                )
                self.assertIs(first.host, second.host)
                assert isinstance(first.host, ControlledHost)
                assert isinstance(second.host, ControlledHost)
                self.assertIn(
                    'cli_auth_credentials_store="ephemeral"',
                    [argument.value for argument in first.host.arguments["launch_arguments"]],
                )
                self.assertEqual(first.host.arguments["launch_cwd"], original.launch_cwd.resolve())
                await first.close(safe=True)
                self.assertFalse(first.host.closed)
                self.assertFalse(second.host.closed)
                replacement = await pool.consume(
                    await pool.reserve(
                        original,
                        role=HostRole.EXECUTION,
                        request_id="next-turn",
                        deadline=time() + TEST_WAIT_SECONDS,
                    )
                )
                self.assertIs(replacement.host, first.host)
                await asyncio.gather(replacement.close(), second.close())

    async def test_shared_host_does_not_make_reservation_identity_interchangeable(self) -> None:
        pool = self.pool(execution_hosts=None)
        original = replace(
            self.request("session-a"),
            execution_scope="session-a",
            process_sharing_scope="user-a",
        )
        with patch.object(pool_module, "os", SimpleNamespace(name="posix", path=os.path)):
            first = await pool.reserve(
                original,
                role=HostRole.EXECUTION,
                request_id="same-reservation",
                deadline=time() + TEST_WAIT_SECONDS,
            )
            with self.assertRaises(AppServerError):
                await pool.reserve(
                    replace(original, request_id="session-b", execution_scope="session-b"),
                    role=HostRole.EXECUTION,
                    request_id="same-reservation",
                    deadline=time() + TEST_WAIT_SECONDS,
                )
            await (await pool.consume(first)).close()

    async def test_inherited_environment_is_frozen_before_queued_host_creation(self) -> None:
        pool = self.pool(execution_hosts=1)
        original = replace(
            self.request("waiting"),
            launch_arguments=(
                CodexRuntimeLaunchArgument(option="--value", environment="FROZEN_VALUE"),
            ),
            remove_environment=("REMOVED_VALUE",),
        )
        with patch.dict(os.environ, {"FROZEN_VALUE": "before", "REMOVED_VALUE": "secret"}):
            busy = await pool.acquire(replace(original, request_id="busy"))
            closing = await self.begin_stop(busy)
            pending = await pool.reserve(
                original,
                role=HostRole.EXECUTION,
                request_id="queued",
                deadline=time() + TEST_WAIT_SECONDS,
            )
        self.assertIs(pending.state, ResourceState.WAITING)
        with patch.dict(os.environ, {"FROZEN_VALUE": "after", "REMOVED_VALUE": "secret"}):
            busy.host.close_gate.set()
            await closing
            lease = await pool.consume(pending)
            assert isinstance(lease.host, ControlledHost)
            snapshot = lease.host.arguments["launch_environment"]
            assert isinstance(snapshot, dict)
            self.assertEqual(snapshot["FROZEN_VALUE"], "before")
            self.assertNotIn("REMOVED_VALUE", snapshot)
            self.assertEqual(
                executable_module._resolve_launch_arguments(original.launch_arguments, snapshot),
                ("--value", "before"),
            )
            changed = await pool.reserve(
                replace(original, request_id="later"),
                role=HostRole.EXECUTION,
                request_id="later",
                deadline=time() + TEST_WAIT_SECONDS,
            )
            self.assertNotEqual(changed.key, pending.key)
            self.assertIs(changed.state, ResourceState.REJECTED)
            self.assertEqual(changed.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
            await pool.cancel(changed)
            await lease.close()

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

    async def test_readiness_resolves_home_without_creating_storage_and_keys_cache_by_home(
        self,
    ) -> None:
        pool = self.pool()
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        with tempfile.TemporaryDirectory() as temporary:
            first_home = Path(temporary) / "first"
            second_home = Path(temporary) / "second"
            with patch.dict(os.environ, {SCHOLARSEED_CODEX_HOME_ENV: str(first_home)}):
                await pool.probe_readiness(TEST_EXECUTABLE)
                await pool.probe_readiness(TEST_EXECUTABLE)
                self.assertEqual(probe.await_count, 1)
                self.assertEqual(
                    probe.await_args.kwargs["process_environment"][CODEX_HOME_ENV],
                    str(first_home.resolve()),
                )
                self.assertFalse(first_home.exists())
            with patch.dict(os.environ, {SCHOLARSEED_CODEX_HOME_ENV: str(second_home)}):
                await pool.probe_readiness(TEST_EXECUTABLE)
                self.assertEqual(probe.await_count, 2)
                self.assertEqual(
                    probe.await_args.kwargs["process_environment"][CODEX_HOME_ENV],
                    str(second_home.resolve()),
                )
                self.assertFalse(second_home.exists())
            self.assertEqual(tuple(Path(temporary).iterdir()), ())

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
        first_request = replace(
            self.request("timed-concurrent-first"),
            timing=first_timing,
        )
        first = asyncio.create_task(pool.acquire(first_request))
        await asyncio.wait_for(
            first_timing.signal(CodexActivationStage.PROCESS_START).wait(), TEST_TIMEOUT_SECONDS
        )
        second = asyncio.create_task(
            pool.acquire(
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
            controls = [
                CodexRuntimeControl(cwd=first_request.cwd, lease=lease, host_pool=pool)
                for lease in leases
            ]
            await asyncio.gather(*(control.open() for control in controls))
            self.assertEqual(controls[0].identity, controls[1].identity)
            self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 0)
            self.assertEqual(first_timing.entered.count(CodexActivationStage.PROCESS_START), 1)
            for timing in (first_timing, second_timing):
                self.assertEqual(
                    timing.finished.count((CodexActivationStage.PROCESS_READY_WAIT, None)), 1
                )
            await asyncio.gather(*(control.aclose() for control in controls))
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
                closing = await self.begin_stop(owner)
                request = replace(self.request("timed-queue-waiter"), timing=timing)
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
                        owner.host.close_gate.set()
                        await closing
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
                    owner.host.close_gate.set()
                    await closing

    async def test_retry_after_unsubscribe_failure_obeys_platform_host_retention(self) -> None:
        for platform, retained in (("darwin", True), (WINDOWS_PLATFORM, False)):
            with (
                self.subTest(platform=platform),
                patch("scholarseed_codex.thread.sys", SimpleNamespace(platform=platform)),
            ):
                pool = self.pool()
                request = replace(
                    self.request("unsubscribe-retry"), process_sharing_scope="fixture-owner"
                )
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
                self.assertEqual(
                    (await session.suspend_status(ticket)).state, SuspendState.COMMITTING
                )
                receipt = await session.commit_suspend(ticket, TEST_WATERMARK)
                self.assertEqual(receipt.state, SuspendState.RELEASED)
                self.assertEqual(pool.snapshot()[0].used, int(retained))
                expected_closes = int(not retained)
                self.assertEqual(host.safe_close_calls, expected_closes)
                self.assertEqual(host.suspend_thread.await_count, 2)
                self.assertIsNone(native.lease)
                self.assertEqual(
                    (await session.commit_suspend(ticket, TEST_WATERMARK)).state,
                    SuspendState.RELEASED,
                )
                self.assertEqual(host.safe_close_calls, expected_closes)
                self.assertTrue(await pool.release_idle())
                self.assertEqual(pool.snapshot()[0].used, 0)
                self.assertEqual(host.safe_close_calls, 1)

    async def test_first_safe_close_retry_rejects_a_different_generation_while_retaining_shared_host(
        self,
    ) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "unsubscribe-generation")
        lease = await pool.consume(reservation)
        generation = lease.host.readiness.process_generation
        with self.assertRaises(AppServerError) as caught:
            await lease.retry_close(expected_generation=generation + 1)
        self.assertEqual(caught.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertEqual(lease.host.safe_close_calls, 0)
        self.assertEqual(pool.snapshot()[0].used, 1)
        await lease.retry_close(expected_generation=generation, retain=True)
        self.assertEqual(lease.host.safe_close_calls, 0)
        self.assertEqual(pool.snapshot()[0].used, 1)

    async def test_stale_safe_release_preserves_other_shared_owners(self) -> None:
        for retain in (False, True):
            with self.subTest(retain=retain):
                pool = self.pool()
                first = await pool.acquire(self.request("stale-shared-first"))
                second = await pool.acquire(self.request("stale-shared-second"))
                reservation = first._reservation
                slot = reservation.slot
                owners = set(slot.owners)
                generation = first.host.readiness.process_generation
                first.host.readiness.process_generation = generation + 1
                with self.assertRaises(AppServerError) as raised:
                    await first.close(safe=True, expected_generation=generation, retain=retain)
                self.assertEqual(raised.exception.safe_error, RUNTIME_SUSPEND_STALE)
                self.assertFalse(reservation._released)
                self.assertIs(reservation.slot, slot)
                self.assertEqual(slot.owners, owners)
                self.assertEqual(first.host.close_calls, 0)
                await second.close(safe=True, expected_generation=generation + 1)
                self.assertTrue(second._reservation._released)
                self.assertIsNone(second._reservation.slot)
                self.assertEqual(slot.owners, {reservation.reservation_id})
                self.assertIs(reservation.slot, slot)
                self.assertEqual(first.host.close_calls, 0)

    @unittest.skipIf(sys.platform == "win32", "shared attachment retention is macOS-only")
    async def test_suspend_rejects_recovered_generation_after_unwatch_backpressure(self) -> None:
        unwatch_entered = asyncio.Event()
        unwatch_release = asyncio.Event()
        recovery_entered = asyncio.Event()
        recovery_release = asyncio.Event()
        request = replace(self.request("suspend-generation-race"), process_sharing_scope="owner")
        host = CodexProcessHost(
            executable=TEST_EXECUTABLE,
            recovery_initial_delay=0,
            recovery_max_delay=0,
        )
        host._generation = 1
        host.state = CodexProcessState.READY
        host.start = AsyncMock()
        host.aclose = AsyncMock()
        host.request = AsyncMock(return_value={"status": "unsubscribed"})
        host._emitter = SimpleNamespace(incident=AsyncMock())

        async def drain() -> None:
            unwatch_entered.set()
            await unwatch_release.wait()

        stream = SimpleNamespace(write=Mock(), drain=drain, is_closing=lambda: False)
        process = SimpleNamespace(pid=20032, returncode=None, wait=AsyncMock(return_value=0))
        host._proc = process
        host._rpc_writer.attach(stream, host.process_generation)
        attachment = ThreadAttachment(
            request=request,
            listener=None,
            thread_id="suspend-generation-root",
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=host.process_generation,
        )
        attachment.turn = SimpleNamespace(
            thread_id=attachment.thread_id,
            request=request,
            attached_generation=host.process_generation,
            fs_watch_id="suspend-generation-watch",
            turn_done=None,
            active_turn_id="",
            ambiguous_submission_id="",
            abandon_files=Mock(),
            connection_lost=AsyncMock(),
        )
        host._threads[attachment.thread_id] = attachment

        async def discard(_process, _generation) -> None:
            host._proc = None

        async def spawn(*_args, **_kwargs):
            recovery_entered.set()
            await recovery_release.wait()
            raise asyncio.CancelledError

        host._discard_process = AsyncMock(side_effect=discard)
        host._start_process = host._launch_process
        with (
            patch.object(pool_module, "CodexProcessHost", return_value=host),
            patch.object(asyncio, "create_subprocess_exec", side_effect=spawn),
        ):
            pool = self.pool()
            reservation = await self.reserve(pool, request.request_id)
            lease = await pool.consume(reservation)
            native = CodexThreadSession(request, lease=lease, host_pool=pool)
            native._opened = True
            native.session_id = attachment.thread_id
            session = session_fixture(native)
            ticket = await session.prepare_suspend(TEST_REVISION)
            committing = asyncio.create_task(session.commit_suspend(ticket, TEST_WATERMARK))
            recovery = None
            try:
                await asyncio.wait_for(unwatch_entered.wait(), TEST_TIMEOUT_SECONDS)
                self.assertEqual(host.process_generation, 1)
                self.assertFalse(reservation._released)
                self.assertIn(reservation.reservation_id, reservation.slot.owners)
                process.returncode = 0
                await host._handle_process_exit(proc=process, generation=host.process_generation)
                recovery = host.recovery_task
                self.assertIsNotNone(recovery)
                await asyncio.wait_for(recovery_entered.wait(), TEST_TIMEOUT_SECONDS)
                self.assertEqual(host.process_generation, 2)
                with self.assertLogs("scholarseed_codex.watch", level="ERROR"):
                    unwatch_release.set()
                    with self.assertRaises(AppServerError) as raised:
                        await asyncio.wait_for(committing, TEST_TIMEOUT_SECONDS)
                self.assertEqual(raised.exception.safe_error, RUNTIME_SUSPEND_STALE)
                self.assertFalse(reservation._released)
                self.assertIsNotNone(reservation.slot)
                self.assertIn(reservation.reservation_id, reservation.slot.owners)
                self.assertIs((await session.suspend_status(ticket)).state, SuspendState.COMMITTING)
            finally:
                unwatch_release.set()
                host._rpc_requests.fail(AppServerError("fixture cleanup"), generation=1)
                if recovery is not None:
                    recovery.cancel()
                    await asyncio.gather(recovery, return_exceptions=True)
                recovery_release.set()
                await asyncio.gather(committing, return_exceptions=True)

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

    async def begin_stop(self, lease):
        lease.host.reusable = False
        lease.host.close_gate.clear()
        closing = asyncio.create_task(lease.close(safe=True))
        await asyncio.wait_for(lease.host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
        return closing

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
        pool = self.pool()
        starting = await self.starting_host(pool, "pooled-starting", "a")
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertFalse(starting.readiness.ready)
        self.assertIsNot(readiness, starting.readiness)
        self.assertTrue(readiness.ready)
        self.assertEqual(probe.await_count, 1)

    async def test_pooled_readiness_reports_the_newest_ready_generation(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        self.host_hook = self.rank_host(2)
        older = await pool.acquire(self.request("older"))
        older.host.readiness.process_generation = 5
        newer = await pool.acquire(self.request("newer"))
        self.host_hook = lambda _host: None
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertIs(readiness, newer.host.readiness)
        self.assertEqual(readiness.process_generation, 5)
        self.assertIs(older.host, newer.host)
        self.assertEqual(len(self.hosts), 1)
        await asyncio.gather(older.close(), newer.close())

    async def test_physical_control_role_is_rejected_without_affecting_ready_execution(
        self,
    ) -> None:
        self.resolve_executable()
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "execution-ready"))
        with self.assertRaises(AppServerError) as caught:
            await self.reserve(pool, "control-starting", role=HostRole.CONTROL)
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONTEXT_REQUIRED)
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 0)
        self.assertEqual(len(self.hosts), 1)
        self.assertIs(readiness, lease.host.readiness)
        self.assertEqual(probe.await_count, 0)

    async def test_stopping_execution_is_not_pooled_readiness_evidence(self) -> None:
        self.resolve_executable()
        pool = self.pool()
        execution = await pool.consume(await self.reserve(pool, "execution-ready"))
        closing = await self.begin_stop(execution)
        execution.host.readiness.ready = False
        execution.host.readiness.process_state = CodexProcessState.CLOSING.value
        waiting = await self.reserve(pool, "execution-next")
        self.assertIs(waiting.state, ResourceState.WAITING)
        self.assertIs(self.slot(pool, execution.host).state, HostState.STOPPING)
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        readiness = await pool.probe_readiness(TEST_EXECUTABLE, prefer_pooled=True)
        self.assertIsNot(readiness, execution.host.readiness)
        self.assertEqual(probe.await_count, 1)
        execution.host.close_gate.set()
        await closing
        await pool.cancel(waiting)

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

    async def test_explicit_stop_waits_for_exit_before_same_configuration_recreation(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("execution-first"))
        await first.close()
        self.assertFalse(first.host.closed)
        self.assertEqual(self.capacity(pool).used, 1)
        second = await pool.acquire(self.request("execution-second"))
        self.assertIs(second.host, first.host)
        self.assertNotEqual(second.lease_id, first.lease_id)
        closing = await self.begin_stop(second)
        rejected = await self.reserve(pool, "execution-conflict", "other")
        self.assertIs(rejected.state, ResourceState.REJECTED)
        self.assertEqual(rejected.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        waiting = await self.reserve(pool, "execution-replacement")
        self.assertIs(waiting.state, ResourceState.WAITING)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertEqual(len(self.hosts), 1)
        self.assertEqual(first.host.safe_close_calls, 1)
        first.host.close_gate.set()
        await closing
        third = await asyncio.wait_for(pool.consume(waiting), TEST_TIMEOUT_SECONDS)
        self.assertTrue(first.host.closed)
        self.assertIsNot(third.host, first.host)
        self.assertEqual(self.capacity(pool).used, 1)
        await third.close()
        self.assertFalse(third.host.closed)
        await pool.aclose()
        self.assertTrue(third.host.closed)
        self.assertEqual(third.host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_execution_scope_shares_host_but_process_environment_separates(
        self,
    ) -> None:
        pool = self.pool(execution_hosts=2)
        first_request = self.request("logical-first")
        first = await pool.acquire(first_request)
        second = await pool.acquire(self.request("logical-second"))
        self.assertIs(first.host, second.host)
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
        self.assertIs(configured.state, ResourceState.GRANTED)
        third = await pool.consume(configured)
        self.assertIs(third.host, first.host)
        with self.assertRaises(AppServerError) as caught:
            await pool.acquire(self.request("isolated", "different-process-environment"))
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertEqual(self.capacity(pool).used, 1)
        await asyncio.gather(first.close(), second.close(), third.close())

    async def test_root_threads_have_no_implicit_subagent_capacity_limit(self) -> None:
        pool = self.pool(execution_hosts=None)
        leases = [
            await pool.acquire(self.request(f"thread-{index}"))
            for index in range(TEST_ROOT_THREAD_COUNT)
        ]
        self.assertEqual({id(lease.host) for lease in leases}, {id(leases[0].host)})
        extra = await pool.acquire(self.request("additional-root-thread"))
        self.assertIs(extra.host, leases[0].host)
        self.assertEqual(self.capacity(pool).used, 1)
        await leases[0].close()
        replacement = await pool.acquire(self.request("thread-replacement"))
        self.assertIs(replacement.host, leases[1].host)
        await asyncio.gather(*(lease.close() for lease in (*leases[1:], replacement, extra)))

    async def test_warm_execution_readiness_does_not_repeat_preflight_after_cache_expiry(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("warm-first"))
        await first.close()
        pool._readiness_cache.clear()
        probe = pool_module._probe_codex_cli_readiness
        probe.reset_mock()
        with patch.object(pool_module, "discover_codex_executable", return_value=TEST_EXECUTABLE):
            second = await pool.acquire(self.request("warm-second"))
        probe.assert_not_awaited()
        self.assertIs(second.host, first.host)
        await second.close()

    async def test_borrowed_control_does_not_release_the_callers_execution_lease(self) -> None:
        pool = self.pool()
        request = self.request("borrowed-control")
        lease = await pool.acquire(request)
        control = CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool)
        await control.open()
        host = control.host
        identity = control.identity
        self.assertEqual(identity, f"{lease.host_id}:{host.readiness.process_generation}")
        await control.aclose()
        self.assertFalse(host.closed)
        self.assertFalse(await pool.release_idle())
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 0)
        with self.assertRaises(AppServerError) as caught:
            await control.model_control.list_models()
        self.assertEqual(caught.exception.safe_error, RUNTIME_SUSPEND_STALE)
        await lease.close()
        self.assertTrue(await pool.release_idle())
        self.assertTrue(host.closed)

    async def test_control_mutation_waits_for_native_quiescence_without_poisoning_busy_host(
        self,
    ) -> None:
        pool = self.pool()
        request = self.request("control-native-busy")
        lease = await pool.acquire(request)
        control = CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool)
        await control.open()
        lease.host.native_busy = True
        with self.assertRaises(AppServerError) as caught:
            async with control.mutation():
                self.fail("busy native host admitted a configuration mutation")
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_BUSY)
        self.assertTrue(lease.host.admission.accepting)
        lease.host.native_busy = False
        async with control.mutation():
            self.assertFalse(lease.host.admission.accepting)
        self.assertTrue(lease.host.admission.accepting)
        await control.aclose()
        await lease.close()

    async def test_control_read_admission_rejects_concurrent_configuration_mutation(self) -> None:
        pool = self.pool()
        request = self.request("control-read-fence")
        leases = await asyncio.gather(
            pool.acquire(request), pool.acquire(replace(request, request_id="control-write-fence"))
        )
        controls = [
            CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool) for lease in leases
        ]
        await asyncio.gather(*(control.open() for control in controls))
        self.assertEqual(controls[0].identity, controls[1].identity)
        async with controls[0].reading():
            with self.assertRaises(AppServerError) as caught:
                async with controls[1].mutation():
                    self.fail("configuration mutation bypassed an active reader")
            self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_BUSY)
            self.assertEqual(leases[0].host.admission.active, 1)
        self.assertTrue(leases[0].host.admission.accepting)
        await asyncio.gather(*(control.aclose() for control in controls))
        await asyncio.gather(*(lease.close() for lease in leases))

    async def test_unknown_control_mutation_result_fences_every_owner_of_the_shared_host(
        self,
    ) -> None:
        pool = self.pool()
        request = self.request("control-mutation-unknown")
        owner = await pool.acquire(request)
        borrowed = await pool.acquire(replace(request, request_id="control-mutation-sibling"))
        control = CodexRuntimeControl(cwd=request.cwd, lease=borrowed, host_pool=pool)
        await control.open()
        failure = AppServerError("native configuration response was lost")
        with self.assertRaises(AppServerError) as caught:
            async with control.mutation():
                raise failure
        self.assertIs(caught.exception, failure)
        self.assertIs(owner.host, control.host)
        self.assertFalse(owner.host.admission.accepting)
        with self.assertRaises(AppServerError) as fenced:
            async with owner.host.admission.enter():
                self.fail("unknown mutation result admitted work")
        self.assertEqual(fenced.exception.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertFalse(owner.host.closed)
        await control.aclose()
        await asyncio.gather(owner.close(), borrowed.close())
        self.assertTrue(await pool.release_idle())
        self.assertTrue(owner.host.closed)
        self.assertEqual(self.capacity(pool).used, 0)
        with self.assertRaises(AppServerError) as rejected:
            await pool.acquire(replace(request, request_id="control-mutation-after-exit"))
        self.assertEqual(rejected.exception.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        self.assertEqual(len(self.hosts), 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_cancelled_control_mutation_keeps_unknown_result_fenced(self) -> None:
        pool = self.pool()
        request = self.request("control-mutation-cancelled")
        lease = await pool.acquire(request)
        control = CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool)
        await control.open()
        entered = asyncio.Event()
        waiting = asyncio.Event()

        async def mutate() -> None:
            async with control.mutation():
                entered.set()
                await waiting.wait()

        mutation = asyncio.create_task(mutate())
        await asyncio.wait_for(entered.wait(), TEST_TIMEOUT_SECONDS)
        mutation.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await mutation
        self.assertFalse(lease.host.admission.accepting)
        with self.assertRaises(AppServerError) as fenced:
            async with lease.host.admission.enter():
                self.fail("cancelled mutation reopened execution admission")
        self.assertEqual(fenced.exception.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        self.assertFalse(lease.host.closed)
        await control.aclose()
        await lease.close()

    async def test_control_mutation_rechecks_quiescence_before_reopening_admission(self) -> None:
        pool = self.pool()
        request = self.request("control-mutation-late-activity")
        lease = await pool.acquire(request)
        control = CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool)
        await control.open()
        with self.assertRaises(AppServerError) as caught:
            async with control.mutation():
                lease.host.native_busy = True
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        self.assertFalse(lease.host.admission.accepting)
        await control.aclose()
        await lease.close()

    async def test_control_read_cancellation_keeps_admission_until_native_rpc_settles(self) -> None:
        pool = self.pool()
        request = self.request("control-read-cancelled")
        lease = await pool.acquire(request)
        control = CodexRuntimeControl(cwd=request.cwd, lease=lease, host_pool=pool)
        await control.open()
        entered = asyncio.Event()
        release = asyncio.Event()

        async def respond(*arguments, **keywords):
            entered.set()
            await release.wait()
            return {"data": []}

        lease.host.request.side_effect = respond
        reading = asyncio.create_task(control.model_control.list_models())
        await asyncio.wait_for(entered.wait(), TEST_TIMEOUT_SECONDS)
        reading.cancel()
        try:
            await asyncio.sleep(0)
            self.assertFalse(reading.done())
            self.assertEqual(lease.host.admission.active, 1)
            with self.assertRaises(AppServerError) as caught:
                async with control.mutation():
                    self.fail("cancelled but unsettled read admitted mutation")
            self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_BUSY)
        finally:
            release.set()
            await asyncio.gather(reading, return_exceptions=True)
        self.assertTrue(reading.cancelled())
        lease.host.request.assert_awaited_once_with(
            "model/list",
            {"includeHidden": False},
            generation=lease.host.readiness.process_generation,
        )
        self.assertEqual(lease.host.admission.active, 0)
        self.assertTrue(lease.host.admission.accepting)
        await control.aclose()
        await lease.close()

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
            process_environment={CODEX_HOME_ENV: "/one"},
        )
        await first.probe_readiness(TEST_EXECUTABLE, process_environment={CODEX_HOME_ENV: "/two"})
        await second.probe_readiness(TEST_EXECUTABLE, process_environment={CODEX_HOME_ENV: "/one"})
        self.assertEqual(probe.await_count, 3)
        self.assertIsNot(first._readiness_probe_lock, second._readiness_probe_lock)

    async def test_borrowed_control_logs_only_execution_capacity_without_secrets(self) -> None:
        pool = self.pool(execution_hosts=4)
        leases = []
        with self.assertLogs(RESOURCE_LIFECYCLE_LOGGER, level="INFO") as captured:
            for index in range(4):
                leases.append(
                    await pool.acquire(self.request(f"execution-{index}", TEST_SECRET_VALUE))
                )
            control_lease = await pool.acquire(self.request("control-inspect", TEST_SECRET_VALUE))
            control = CodexRuntimeControl(
                cwd=Path(tempfile.gettempdir()), lease=control_lease, host_pool=pool
            )
            await control.open()
            self.assertIs(control.host, leases[0].host)
            await control.model_control.list_models()
            await control.aclose()
            await control_lease.close(safe=True)
            self.assertFalse(await pool.release_idle())
            for lease in leases:
                await lease.close()
            self.assertTrue(await pool.release_idle())
        records = [record.resource_evidence for record in captured.records]
        admitted = next(
            row
            for row in records
            if row["request_id"] == control_lease.request_id
            and row["transition"] == ResourceState.CONSUMED.value
        )
        self.assertEqual(
            {row["role"]: row["used"] for row in admitted["capacity"]},
            {HostRole.EXECUTION.value: 1, HostRole.CONTROL.value: 0},
        )
        self.assertTrue(admitted["host_id"])
        self.assertEqual(admitted["lease_id"], control_lease.lease_id)
        self.assertEqual(admitted["request_id"], control_lease.request_id)
        self.assertTrue(all(row["role"] == HostRole.EXECUTION.value for row in records))
        self.assertEqual(sum(row["transition"] == "exited" for row in records), 1)
        self.assertIn("released", {row["transition"] for row in records})
        self.assertIn("ready", {row["transition"] for row in records})
        exited = next(row for row in records if row["transition"] == "exited")
        self.assertEqual(exited["state"], "stopped")
        self.assertEqual(exited["process_generation"], 1)
        self.assertEqual(
            {row["role"]: row["used"] for row in exited["capacity"]},
            {HostRole.EXECUTION.value: 0, HostRole.CONTROL.value: 0},
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
            lease = await pool.acquire(self.request("logged-owner"))
            lease.host.close_error = AppServerError(
                RUNTIME_SUSPEND_BUSY, safe_error=RUNTIME_SUSPEND_BUSY
            )
            closing = await self.begin_stop(lease)
            waiting = await self.reserve(pool, "logged-waiter")
            rejected = await self.reserve(pool, "logged-rejected")
            self.assertIs(rejected.state, ResourceState.REJECTED)
            await pool.cancel(waiting)
            lease.host.close_gate.set()
            with self.assertRaises(AppServerError):
                await closing
            failed_rows = [
                record.resource_evidence
                for record in captured.records
                if record.resource_evidence["transition"] == "close_failed"
            ]
            self.assertEqual(len(failed_rows), 1)
            self.assertEqual(failed_rows[0]["state"], "stopping")
            self.assertEqual(
                next(
                    row["used"]
                    for row in failed_rows[0]["capacity"]
                    if row["role"] == HostRole.EXECUTION.value
                ),
                1,
            )
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
        self.assertEqual(first.host.close_calls, 0)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertTrue(await pool.release_idle())
        self.assertEqual(first.host.close_calls, 1)

    async def test_control_borrows_execution_without_a_second_role_budget(self) -> None:
        pool = self.pool()
        execution = await pool.acquire(self.request("execution"))
        borrowed = await pool.acquire(self.request("control"))
        control = CodexRuntimeControl(
            cwd=Path(tempfile.gettempdir()), lease=borrowed, host_pool=pool
        )
        await control.open()
        blocked = await self.reserve(pool, "blocked", "b")
        self.assertIs(blocked.state, ResourceState.REJECTED)
        self.assertEqual(blocked.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertIs(execution.host, control.host)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertEqual(self.capacity(pool, HostRole.CONTROL).used, 0)
        self.assertEqual(len(self.hosts), 1)
        await pool.cancel(blocked)
        await control.aclose()
        await asyncio.gather(execution.close(), borrowed.close())

    async def test_stopping_occupies_budget_and_same_configuration_waiters_share_after_exit(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("first"))
        closing = await self.begin_stop(first)
        second = await self.reserve(pool, "second")
        third = await self.reserve(pool, "third")
        try:
            same_key = await self.reserve(pool, "same-key")
            self.assertEqual(self.capacity(pool).used, 1)
            self.assertIs(second.state, ResourceState.WAITING)
            self.assertIs(third.state, ResourceState.WAITING)
            self.assertIs(same_key.state, ResourceState.WAITING)
            self.assertEqual(
                [reservation.request_id for reservation in pool._waiting[HostRole.EXECUTION]],
                ["second", "third", "same-key"],
            )
        finally:
            first.host.close_gate.set()
            await closing
        leases = await asyncio.gather(*(pool.consume(value) for value in (second, third, same_key)))
        self.assertTrue(first.host.closed)
        self.assertTrue(all(lease.host is leases[0].host for lease in leases))
        self.assertIsNot(leases[0].host, first.host)
        self.assertEqual(len(self.hosts), 2)
        await asyncio.gather(*(lease.close() for lease in leases))
        self.assertTrue(await pool.release_idle())
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_bounded_queue_rejects_without_spawning(self) -> None:
        pool = self.pool(queue_limit=1)
        first = await pool.acquire(self.request("first"))
        closing = await self.begin_stop(first)
        waiting = await self.reserve(pool, "waiting")
        rejected = await self.reserve(pool, "rejected")
        self.assertIs(rejected.state, ResourceState.REJECTED)
        self.assertEqual(rejected.safe_error, RESOURCE_QUEUE_FULL)
        self.assertEqual(len(self.hosts), 1)
        await pool.cancel(waiting)
        first.host.close_gate.set()
        await closing

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
        await reservation.slot.startup
        await asyncio.sleep(TEST_EXPIRY_GRACE_SECONDS)
        self.assertIs(reservation.state, ResourceState.EXPIRED)
        self.assertEqual(self.capacity(pool).used, 1)
        self.assertFalse(self.hosts[0].closed)
        self.assertTrue(await pool.release_idle())
        self.assertEqual(self.capacity(pool).used, 0)
        self.assertTrue(self.hosts[0].closed)

    async def test_waiting_reservation_expires_without_client_wait(self) -> None:
        pool = self.pool(queue_limit=1)
        first = await pool.acquire(self.request("first"))
        closing = await self.begin_stop(first)
        reservation = await self.reserve(pool, "abandoned", deadline=time() + TEST_EXPIRY_SECONDS)
        await asyncio.sleep(TEST_EXPIRY_GRACE_SECONDS)
        self.assertIs(reservation.state, ResourceState.EXPIRED)
        self.assertEqual(self.capacity(pool).waiting, 0)
        next_request = await self.reserve(pool, "next")
        self.assertIs(next_request.state, ResourceState.WAITING)
        await pool.cancel(next_request)
        first.host.close_gate.set()
        await closing

    async def test_shared_start_failure_logs_original_exception_once(self) -> None:
        pool = self.pool()
        failure = PermissionError(13, "private Windows DACL rejected")
        failure.__cause__ = OSError(5, "native access denied")

        def fail_start(host):
            host.start_gate.clear()
            host.start_error = failure

        self.host_hook = fail_start
        first = await self.reserve(pool, "first")
        second = await self.reserve(pool, "second")
        with self.assertLogs(RESOURCE_LIFECYCLE_LOGGER, level="ERROR") as logged:
            self.hosts[0].start_gate.set()
            await asyncio.wait_for(self.hosts[0].close_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertEqual(len(logged.records), 1)
        record = logged.records[0]
        self.assertIs(record.exc_info[1], failure)
        self.assertIsNotNone(record.exc_info[2])
        self.assertIs(record.exc_info[1].__cause__, failure.__cause__)
        self.assertIn("native access denied", logged.output[0])
        self.assertIn("codex_host_start_failed", record.getMessage())
        self.assertIn("host_id=", record.getMessage())
        self.assertNotIn(TEST_SECRET_VALUE, record.getMessage())
        self.assertEqual(first.safe_error, CODEX_HOST_START_FAILED)
        self.assertEqual(second.safe_error, first.safe_error)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_shared_start_failure_preserves_mcp_safe_error_for_every_waiter(self) -> None:
        for safe_error in (MCP_APPLICATION_FAILED, MCP_COORDINATOR_CLOSED):
            with self.subTest(safe_error=safe_error):
                pool = self.pool()

                def fail_start(host, error_code=safe_error):
                    host.start_gate.clear()
                    host.start_error = AppServerError(TEST_SECRET_VALUE, safe_error=error_code)

                self.host_hook = fail_start
                reservations = [await self.reserve(pool, name) for name in ("first", "second")]
                self.hosts[-1].start_gate.set()
                with self.assertLogs(RESOURCE_LIFECYCLE_LOGGER, level="ERROR"):
                    for reservation in reservations:
                        with self.assertRaises(AppServerError) as caught:
                            await pool.consume(reservation)
                        self.assertEqual(caught.exception.safe_error, safe_error)
                        self.assertNotIn(TEST_SECRET_VALUE, str(caught.exception))
                        self.assertEqual(reservation.safe_error, safe_error)
                self.assertEqual(self.capacity(pool).used, 0)

    async def test_closed_mcp_registration_rejects_reservation_and_releases_ownership(self) -> None:
        ownership = Mock()
        pool = CodexHostPool(
            resource_lease=lambda: ownership, mcp_editor=Mock(runtime_home=Path.cwd())
        )
        self.pools.append(pool)
        await pool._mcp.aclose()
        reservation = await self.reserve(pool, "closed-coordinator")
        with self.assertRaises(AppServerError) as caught:
            await pool.consume(reservation)
        self.assertEqual(caught.exception.safe_error, MCP_COORDINATOR_CLOSED)
        self.assertEqual(reservation.safe_error, MCP_COORDINATOR_CLOSED)
        self.assertEqual(reservation.state, ResourceState.REJECTED)
        self.assertEqual(self.capacity(pool).used, 0)
        self.assertFalse(pool._hosts)
        self.assertEqual(self.hosts[0].start_calls, 0)
        ownership.close.assert_called_once_with()

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
        first = await pool.acquire(self.request("first"))
        closing = await self.begin_stop(first)
        reservation = await self.reserve(pool, "waiting")
        waiting = asyncio.create_task(pool.wait(reservation))
        await asyncio.sleep(0)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertIs(reservation.state, ResourceState.CANCELLED)
        self.assertEqual(self.capacity(pool).waiting, 0)
        first.host.close_gate.set()
        await closing

    async def test_cancel_call_cancellation_does_not_orphan_stopping_host(self) -> None:
        pool = self.pool()
        reservation = await self.reserve(pool, "unconsumed")
        await reservation.slot.startup
        self.hosts[0].reusable = False
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

    async def test_shutdown_closes_transport_before_joining_pending_startup(self) -> None:
        pool = self.pool()
        host = await self.starting_host(pool, "shutdown-starting", "a")
        await asyncio.wait_for(pool.aclose(), TEST_TIMEOUT_SECONDS)
        self.assertTrue(host.closed)
        self.assertFalse(host.start_gate.is_set())
        self.assertEqual(host.close_calls, 1)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_compatible_arrival_does_not_bypass_an_older_waiter(self) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("first"))
        older = await self.reserve(pool, "older", "b")
        self.assertIs(older.state, ResourceState.REJECTED)
        self.assertEqual(older.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        compatible = await self.reserve(pool, "compatible")
        self.assertIs(compatible.state, ResourceState.GRANTED)
        compatible_lease = await pool.consume(compatible)
        self.assertIs(compatible_lease.host, first.host)
        await first.close()
        self.assertIs(older.state, ResourceState.REJECTED)
        await compatible_lease.close()
        self.assertEqual(len(self.hosts), 1)
        self.assertEqual(self.capacity(pool).waiting, 0)

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
        self.assertEqual(stopped["state"], "released")
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

    async def test_negative_open_proof_waits_for_real_pool_shutdown_barrier(self) -> None:
        pool = self.pool()

        def fail_start(host: ControlledHost) -> None:
            host.start_error = AppServerError("controlled startup failure")
            host.close_gate.clear()

        self.host_hook = fail_start
        reservation = await self.reserve(pool, "negative-proof")
        request = OpenSessionRequest(
            "opening",
            Path.cwd(),
            reservation_id=reservation.reservation_id,
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
        runtime = CodexRuntimeProvider()
        runtime._pool = pool
        session = SimpleNamespace(
            consume_resource=pool.consume, open=AsyncMock(), detach=AsyncMock()
        )
        runtime._prepared[reservation.reservation_id] = (
            SimpleNamespace(session_request=replace(request, reservation_id="")),
            session,
            reservation,
        )
        pending = asyncio.create_task(runtime.open(request))
        host = self.hosts[-1]
        try:
            await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)
            self.assertFalse(pending.done())
            self.assertEqual(self.capacity(pool).used, 1)
            session.open.assert_not_awaited()
        finally:
            host.close_gate.set()
        with self.assertRaises(RuntimeOpenNotAppliedError):
            await asyncio.wait_for(pending, TEST_TIMEOUT_SECONDS)
        self.assertTrue(host.closed)
        self.assertIsNone(reservation.slot)
        self.assertEqual(self.capacity(pool).used, 0)
        session.detach.assert_awaited_once()

    async def test_last_consumer_cancellation_detaches_from_pending_startup(self) -> None:
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        timing = TimingRecorder()
        request = replace(self.request("cancel-startup"), timing=timing)
        consumer = asyncio.create_task(pool.acquire(request))
        await asyncio.wait_for(
            timing.signal(CodexActivationStage.PROCESS_READY_WAIT).wait(), TEST_TIMEOUT_SECONDS
        )
        await self.hosts[0].start_entered.wait()
        with self.assertNoLogs(RESOURCE_LIFECYCLE_LOGGER, level="ERROR"):
            consumer.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(consumer, TEST_TIMEOUT_SECONDS)
        self.assertFalse(self.hosts[0].closed)
        self.assertFalse(self.hosts[0].start_gate.is_set())
        self.assertEqual(self.capacity(pool).used, 1)
        self.hosts[0].start_gate.set()
        await asyncio.wait_for(self.hosts[0].close_entered.wait(), TEST_TIMEOUT_SECONDS)
        for _ in range(TEST_CLEANUP_EVENT_LOOP_TURNS):
            await asyncio.sleep(0)
        self.assertEqual(self.capacity(pool).used, 0)

    async def test_reborrow_cancels_the_previous_idle_deadline(self) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("idle-first"))
        slot = first._reservation.slot
        await first.close(safe=True, retain=True)
        previous = slot.idle_timer
        self.assertIsNotNone(previous)
        second = await pool.acquire(self.request("idle-second"))
        self.assertIs(second.host, first.host)
        self.assertTrue(previous.cancelled())
        self.assertIsNone(slot.idle_timer)
        await second.close(safe=True, retain=True)
        self.assertIsNot(slot.idle_timer, previous)
        self.assertFalse(slot.idle_timer.cancelled())
        self.assertTrue(await pool.release_idle())

    async def test_native_windows_launch_arguments_select_the_startup_budget(self) -> None:
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        request = replace(
            self.request("native-startup-budget"), launch_arguments=(SANDBOX_ARGUMENT,)
        )
        with patch.object(
            pool_module, "os", SimpleNamespace(name="nt", path=os.path, environ=os.environ)
        ):
            reservation = await pool.reserve(
                request,
                role=HostRole.EXECUTION,
                request_id=request.request_id,
                deadline=time() + TEST_WAIT_SECONDS,
            )
        self.assertIsNotNone(reservation.slot)
        self.assertEqual(reservation.slot.startup_wait_seconds, SANDBOX_SETUP_TIMEOUT_SECONDS)

    async def test_startup_wait_budget_reports_preparing_without_closing_host(self) -> None:
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        reservation = await self.reserve(pool, "startup-budget")
        host = self.hosts[0]
        await host.start_entered.wait()
        reservation.slot.startup_wait_seconds = TEST_EXPIRY_SECONDS
        with self.assertRaises(AppServerError) as raised:
            await pool.consume(reservation)
        self.assertEqual(raised.exception.safe_error, "windows_sandbox_setup_in_progress")
        self.assertFalse(host.closed)
        self.assertEqual(self.capacity(pool).used, 1)
        host.start_gate.set()
        await asyncio.wait_for(host.close_entered.wait(), TEST_TIMEOUT_SECONDS)

    async def test_cancelling_one_owner_keeps_shared_startup(self) -> None:
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        first = await self.reserve(pool, "cancel-shared-first")
        second = await self.reserve(pool, "cancel-shared-second")
        self.assertIs(first.slot, second.slot)
        await self.hosts[0].start_entered.wait()
        await pool.cancel(first)
        self.assertFalse(self.hosts[0].closed)
        self.assertFalse(second.slot.startup.done())
        self.hosts[0].start_gate.set()
        lease = await asyncio.wait_for(pool.consume(second), TEST_TIMEOUT_SECONDS)
        await lease.close()

    async def test_setup_coordination_reuses_runtime_home_and_rejects_another_home(self) -> None:
        pool = self.pool(execution_hosts=3)
        home = Path(tempfile.gettempdir()) / "sandbox-contract-home"
        first = await pool.acquire(
            replace(self.request("sandbox-first"), process_environment={CODEX_HOME_ENV: str(home)}),
        )
        second = await pool.acquire(
            replace(
                self.request("sandbox-second"),
                process_environment={CODEX_HOME_ENV: str(home / ".")},
            ),
        )
        with self.assertRaises(AppServerError) as caught:
            await pool.acquire(
                replace(
                    self.request("sandbox-third"),
                    process_environment={CODEX_HOME_ENV: str(home / "other")},
                )
            )
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertIs(first.host, second.host)
        self.assertIs(
            first.host.arguments["sandbox_setup_lock"], second.host.arguments["sandbox_setup_lock"]
        )
        self.assertEqual(len(self.hosts), 1)
        await asyncio.gather(first.close(), second.close())

    async def test_shutdown_joins_safe_close_without_escalating(self) -> None:
        pool = self.pool()
        lease = await pool.consume(await self.reserve(pool, "safe-stop"))
        lease.host.reusable = False
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
        lease.host.reusable = False
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
        lease.host.reusable = False
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
        lease.host.reusable = False
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
        lease.host.reusable = False
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
        lease.host.reusable = False
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
                lease.host.reusable = False
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

    async def test_compatible_arrival_reuses_host_after_incompatible_request_is_rejected(
        self,
    ) -> None:
        pool = self.pool()
        first = await pool.acquire(self.request("first"))
        older = await self.reserve(pool, "older", "b")
        self.assertIs(older.state, ResourceState.REJECTED)
        self.assertEqual(older.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        compatible = await self.reserve(pool, "compatible")
        self.assertIs(compatible.state, ResourceState.GRANTED)
        compatible_lease = await pool.consume(compatible)
        self.assertIs(compatible_lease.host, first.host)
        await first.close()
        self.assertIs(older.state, ResourceState.REJECTED)
        await compatible_lease.close()
        self.assertEqual(len(self.hosts), 1)
        self.assertEqual(self.capacity(pool).waiting, 0)

    async def test_explicit_shutdown_after_last_consumer_cancellation_stops_pending_startup(
        self,
    ) -> None:
        pool = self.pool()
        self.host_hook = lambda host: host.start_gate.clear()
        timing = TimingRecorder()
        request = replace(self.request("cancel-startup"), timing=timing)
        consumer = asyncio.create_task(pool.acquire(request))
        await asyncio.wait_for(
            timing.signal(CodexActivationStage.PROCESS_READY_WAIT).wait(), TEST_TIMEOUT_SECONDS
        )
        await self.hosts[0].start_entered.wait()
        with self.assertNoLogs(RESOURCE_LIFECYCLE_LOGGER, level="ERROR"):
            consumer.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(consumer, TEST_TIMEOUT_SECONDS)
        self.assertFalse(self.hosts[0].closed)
        await asyncio.wait_for(pool.aclose(), TEST_TIMEOUT_SECONDS)
        self.assertTrue(self.hosts[0].closed)
        self.assertFalse(self.hosts[0].start_gate.is_set())
        self.assertEqual(self.capacity(pool).used, 0)


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
    def test_only_windows_provider_refreshes_execution_before_turn(self) -> None:
        provider = CodexRuntimeProvider()
        for platform, refresh in (("win32", True), ("darwin", False), ("linux", False)):
            with (
                self.subTest(platform=platform),
                patch.object(sys, "platform", platform),
            ):
                self.assertIs(provider.resource_policy.refresh_before_turn, refresh)

    def test_process_hosts_have_no_default_numeric_limit(self) -> None:
        policy = CapacityPolicy()
        self.assertIsNone(policy.limit(HostRole.EXECUTION))
        self.assertIsNone(policy.limit(HostRole.CONTROL))

    def test_invalid_policy_values_fail_before_any_host_is_created(self) -> None:
        invalid = (
            {"execution_hosts": True},
            {"control_hosts": 0},
            {"queue_limit": -1},
            {"wait_seconds": float("nan")},
            {"idle_seconds": float("inf")},
            {"idle_seconds": 0.5},
            {"wait_seconds": False},
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValueError):
                CapacityPolicy(**values)
        for values in ({"unknown": {}}, {"capacity": {"unknown": 1}}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                CapacityPolicy.parse(values)


class ThreadAttachmentContracts(unittest.IsolatedAsyncioTestCase):
    def host(self) -> CodexProcessHost:
        host = CodexProcessHost(executable=TEST_EXECUTABLE)
        host._proc = SimpleNamespace(pid=123, returncode=None)
        host._generation = 1
        host.state = CodexProcessState.READY
        host.start = AsyncMock()
        host._discard_process = AsyncMock()
        return host

    async def test_exact_missing_rollout_preserves_host_and_unknown_submission(self) -> None:
        host = self.host()
        host._prepare_thread_resources = AsyncMock()
        host._emitter = SimpleNamespace(incident=AsyncMock(), emit=AsyncMock())
        state = ThreadAttachment(
            request=CodexSessionOpenRequest(
                request_id="missing", runtime_id="codex", cwd=Path.cwd()
            ),
            listener=None,
            thread_id="missing",
            attachment_state=CodexThreadAttachmentState.RECOVERY_PENDING,
        )
        state.turn = SimpleNamespace(ambiguous_submission_id="unknown-message")
        host._threads[state.thread_id] = state
        methods = []

        async def write(
            message, *, generation, on_written, before_write=None, on_write_attempt=None
        ):
            if before_write is not None:
                before_write()
            methods.append(message["method"])
            if on_write_attempt is not None:
                on_write_attempt()
            on_written()
            if message["method"] in {"thread/loaded/list", "mcpServerStatus/list"}:
                host._rpc_requests.resolve(
                    {"id": message["id"], "result": {"data": []}}, generation
                )
                return
            self.assertEqual(message["method"], "thread/resume")
            self.assertEqual(message["params"]["threadId"], "missing")
            host._rpc_requests.resolve(
                {
                    "id": message["id"],
                    "error": {"code": -32600, "message": "no rollout found for thread id missing"},
                },
                generation,
            )

        host._rpc_writer.write = AsyncMock(side_effect=write)
        self.assertFalse(await host._resume_thread(state, 1))
        self.assertEqual(state.absent_generation, 1)
        self.assertTrue(host.reusable)
        self.assertEqual(host.configuration_blockers, ())
        for _attempt in range(2):
            with self.assertRaises(AppServerError) as failed:
                await host.ensure_attached("missing")
            self.assertIs(failed.exception.retryability, RuntimeRetryability.TERMINAL)
        host._rpc_writer.write.assert_awaited_once()
        host.admission.freeze(1)
        ticket = await host.configuration_quiescence(1)
        self.assertIsNotNone(ticket)
        inventory = await host.verify_mcp_configuration(ticket, frozenset())
        self.assertTrue(inventory.can_admit)
        self.assertEqual(
            methods,
            ["thread/resume", "thread/loaded/list", "thread/loaded/list", "mcpServerStatus/list"],
        )
        host._generation = 2
        self.assertTrue(await host._resume_registered_threads(2, None))
        self.assertEqual(state.absent_generation, 2)
        self.assertEqual(methods.count("thread/resume"), 2)
        self.assertEqual(state.turn.ambiguous_submission_id, "unknown-message")
        self.assertIs(host._threads["missing"], state)
        host._discard_process.assert_not_awaited()

    async def test_cancelled_native_start_settles_and_unsubscribes_only_new_thread(self) -> None:
        host = self.host()
        sibling = object()
        host._threads["sibling"] = sibling
        entered, release = asyncio.Event(), asyncio.Event()

        async def request(method, params, **kwargs):
            if method == "thread/start":
                entered.set()
                await release.wait()
                return {"thread": {"id": "created"}}
            self.assertEqual((method, params), ("thread/unsubscribe", {"threadId": "created"}))
            return {"status": "unsubscribed"}

        host._request_connected = AsyncMock(side_effect=request)
        pending = asyncio.create_task(host._request_thread_attachment("thread/start", {}, 1))
        await entered.wait()
        pending.cancel()
        await asyncio.sleep(0)
        pending.cancel()
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertIs(host._threads["sibling"], sibling)
        self.assertIn("created", host.known_roots)
        self.assertEqual(host._request_connected.await_count, 2)
        host._discard_process.assert_not_awaited()

    async def test_missing_rollout_proof_does_not_cross_process_or_registration_epoch(self) -> None:
        for changed in ("generation", "process", "registration"):
            with self.subTest(changed=changed):
                host = self.host()
                host._prepare_thread_resources = AsyncMock()
                host._emitter = SimpleNamespace(incident=AsyncMock(), emit=AsyncMock())
                state = ThreadAttachment(
                    request=CodexSessionOpenRequest(
                        request_id="missing", runtime_id="codex", cwd=Path.cwd()
                    ),
                    listener=None,
                    thread_id="missing",
                    attachment_state=CodexThreadAttachmentState.RECOVERY_PENDING,
                )
                host._threads["missing"] = state

                async def reject(*args, change=changed, target=host, attachment=state, **kwargs):
                    if change == "generation":
                        target._generation += 1
                    elif change == "process":
                        target._proc = SimpleNamespace(pid=124, returncode=None)
                    else:
                        attachment.registration_epoch += 1
                    raise AppServerError(
                        "rejected",
                        safe_error="codex_thread_history_missing",
                        generation=1,
                        retryability=RuntimeRetryability.TERMINAL,
                    )

                host._request_connected = AsyncMock(side_effect=reject)
                self.assertFalse(await host._resume_thread(state, 1))
                self.assertEqual(state.absent_generation, 0)
                host._emitter.incident.assert_not_awaited()

    async def test_cancelled_resume_does_not_unsubscribe_unconfirmed_or_existing_identity(
        self,
    ) -> None:
        for returned, expected in (("sibling", "requested"), ("sibling", "sibling")):
            host = self.host()
            host._threads["sibling"] = object()
            entered, release = asyncio.Event(), asyncio.Event()

            async def request(
                method,
                params,
                *,
                entered_event=entered,
                release_event=release,
                returned_thread=returned,
                **kwargs,
            ):
                entered_event.set()
                await release_event.wait()
                return {"thread": {"id": returned_thread}}

            host._request_connected = AsyncMock(side_effect=request)
            pending = asyncio.create_task(
                host._request_thread_attachment("thread/resume", {}, 1, expected_thread_id=expected)
            )
            await entered.wait()
            pending.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await pending
            self.assertEqual(host._request_connected.await_count, 1)
            host._discard_process.assert_not_awaited()

    async def test_cancelled_watch_registration_rolls_back_local_attachment(self) -> None:
        host = self.host()
        entered, release = asyncio.Event(), asyncio.Event()

        async def watch(*args):
            entered.set()
            await release.wait()

        host._watcher = SimpleNamespace(open=AsyncMock(side_effect=watch), close=AsyncMock())
        host._request_connected = AsyncMock(
            side_effect=[
                {"thread": {"id": "created"}, "model": "model-a", "modelProvider": "provider-a"},
                {"status": "unsubscribed"},
            ]
        )
        request = CodexSessionOpenRequest(
            request_id="watch-cancel",
            runtime_id="codex",
            cwd=Path.cwd(),
            model="model-a",
            model_provider="provider-a",
        )
        pending = asyncio.create_task(host.open_thread(request, None))
        await entered.wait()
        pending.cancel()
        await asyncio.sleep(0)
        self.assertFalse(pending.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertNotIn("created", host._threads)
        self.assertIn("created", host.known_roots)
        host._watcher.close.assert_awaited_once()
        host._discard_process.assert_not_awaited()

    async def test_model_mismatch_unsubscribes_only_uncommitted_thread(self) -> None:
        host = self.host()
        sibling = object()
        host._threads["sibling"] = sibling
        host._request_connected = AsyncMock(
            side_effect=[
                {"thread": {"id": "created"}, "model": "unexpected", "modelProvider": "provider-a"},
                {"status": "unsubscribed"},
            ]
        )
        request = CodexSessionOpenRequest(
            request_id="model-mismatch",
            runtime_id="codex",
            cwd=Path.cwd(),
            model="requested",
            model_provider="provider-a",
        )
        with self.assertRaises(AppServerError):
            await host.open_thread(request, None)
        self.assertIs(host._threads["sibling"], sibling)
        self.assertNotIn("created", host._threads)
        self.assertIn("created", host.known_roots)
        self.assertEqual(
            host._request_connected.call_args.args[:2],
            ("thread/unsubscribe", {"threadId": "created"}),
        )
        host._discard_process.assert_not_awaited()

    async def test_native_result_from_replaced_generation_is_not_published(self) -> None:
        host = self.host()

        async def request(*args, **kwargs):
            host._generation += 1
            return {"thread": {"id": "stale"}}

        host._request_connected = AsyncMock(side_effect=request)
        with self.assertRaises(AppServerError) as failure:
            await host._request_thread_attachment("thread/start", {}, 1)
        self.assertEqual(failure.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertNotIn("stale", host._threads)

    async def test_generation_change_during_watch_does_not_publish_old_attachment(self) -> None:
        host = self.host()

        async def watch(*args):
            host._generation += 1

        host._watcher = SimpleNamespace(open=AsyncMock(side_effect=watch), close=AsyncMock())
        host._emitter = SimpleNamespace(emit=AsyncMock())
        host._request_connected = AsyncMock(
            return_value={
                "thread": {"id": "created"},
                "model": "model-a",
                "modelProvider": "provider-a",
            }
        )
        request = CodexSessionOpenRequest(
            request_id="stale-watch",
            runtime_id="codex",
            cwd=Path.cwd(),
            model="model-a",
            model_provider="provider-a",
        )
        with self.assertRaises(AppServerError) as failure:
            await host.open_thread(request, None)
        self.assertEqual(failure.exception.safe_error, RUNTIME_SUSPEND_STALE)
        self.assertNotIn("created", host._threads)
        host._emitter.emit.assert_not_awaited()
        self.assertEqual(host._request_connected.await_count, 1)

    async def test_resource_queue_revalidates_process_and_generation(self) -> None:
        for changed in ("generation", "process", "exit", "state"):
            host = self.host()
            host._sandbox = SimpleNamespace(enabled=True, prepare_resources=AsyncMock())
            entered, release = asyncio.Event(), asyncio.Event()

            @asynccontextmanager
            async def mutex(entered_event=entered, release_event=release):
                entered_event.set()
                await release_event.wait()
                yield

            request = CodexSessionOpenRequest(
                request_id=changed, runtime_id="codex", cwd=Path.cwd()
            )
            with patch("scholarseed_codex.process.startup_mutex", mutex):
                pending = asyncio.create_task(host._prepare_thread_resources(request, 1))
                await entered.wait()
                if changed == "generation":
                    host._generation += 1
                elif changed == "process":
                    host._proc = SimpleNamespace(pid=124, returncode=None)
                elif changed == "exit":
                    host._proc.returncode = 1
                else:
                    host.state = CodexProcessState.CRASHED
                release.set()
                with self.assertRaises(AppServerError) as failure:
                    await pending
            self.assertEqual(failure.exception.safe_error, RUNTIME_SUSPEND_STALE)
            host._sandbox.prepare_resources.assert_not_awaited()

    async def test_resource_cancellation_holds_mutex_until_operation_finishes(self) -> None:
        host = self.host()
        entered, release = asyncio.Event(), asyncio.Event()
        lock = asyncio.Lock()

        async def prepare(cwd):
            entered.set()
            await release.wait()

        @asynccontextmanager
        async def mutex():
            async with lock:
                yield

        host._sandbox = SimpleNamespace(
            enabled=True, prepare_resources=AsyncMock(side_effect=prepare)
        )
        request = CodexSessionOpenRequest(
            request_id="resource-cancel", runtime_id="codex", cwd=Path.cwd()
        )
        with patch("scholarseed_codex.process.startup_mutex", mutex):
            pending = asyncio.create_task(host._prepare_thread_resources(request, 1))
            await entered.wait()
            pending.cancel()
            await asyncio.sleep(0)
            self.assertTrue(lock.locked())
            self.assertFalse(pending.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        self.assertFalse(lock.locked())
        host._discard_process.assert_not_awaited()


class ThreadOpeningRecoveryContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.host = CodexProcessHost(
            executable=TEST_EXECUTABLE,
            max_recovery_attempts=2,
            recovery_initial_delay=0,
            recovery_max_delay=0,
            recovery_total_timeout=TEST_TIMEOUT_SECONDS,
        )
        self.exit_gate = asyncio.Event()
        self.exit_gate.set()
        self.crashes: dict[int, asyncio.Event] = {}
        self.disconnections: dict[int, asyncio.Event] = {}
        self.readers = []
        self.host._watcher = SimpleNamespace(
            reset=Mock(), open=AsyncMock(), close=AsyncMock(), abandon_turn=Mock()
        )
        self.host.ensure_skill_roots = AsyncMock()
        self.host._prepare_thread_resources = AsyncMock()
        self.host._start_process = AsyncMock(side_effect=self.launch)
        await self.launch()

    async def asyncTearDown(self) -> None:
        self.host._closed = True
        self.exit_gate.set()
        tasks = [*self.readers]
        if self.host.recovery_task is not None:
            tasks.append(self.host.recovery_task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def launch(self) -> None:
        self.assertIsNone(self.host._proc)
        self.host._generation += 1
        generation = self.host.process_generation
        crash = asyncio.Event()
        self.crashes[generation] = crash
        disconnected = asyncio.Event()
        self.disconnections[generation] = disconnected
        process = SimpleNamespace(returncode=None, pid=generation, stdin=None)

        async def wait():
            disconnected.set()
            await self.exit_gate.wait()
            process.returncode = 1
            return process.returncode

        process.wait = wait
        self.host._proc = process
        self.host.state = CodexProcessState.READY

        async def read():
            await crash.wait()
            await self.host._handle_process_exit(proc=process, generation=generation)

        self.host._reader_task = asyncio.create_task(read())
        self.readers.append(self.host._reader_task)

    def request(self, thread_id="saved"):
        return CodexSessionOpenRequest(
            request_id=thread_id or "new",
            runtime_id=TEST_RUNTIME_ID,
            cwd=Path.cwd(),
            resume_session_id=thread_id,
        )

    def configure_rpc(self, *, failures=1, acknowledge=False):
        async def request(method, params, *, generation):
            self.assertIn(method, ("thread/start", "thread/resume"))
            if generation <= failures:
                self.crashes[generation].set()
                if acknowledge:
                    self.host._proc.returncode = 1
                else:
                    await self.disconnections[generation].wait()
                    raise AppServerError("connection closed", safe_error="agent_runtime_exit")
            return {
                "thread": {"id": params.get("threadId", "created"), "turns": []},
                "model": "model",
                "modelProvider": "provider",
            }

        self.host._request_connected = AsyncMock(side_effect=request)

    async def test_saved_thread_open_recovers_before_initial_resume_ack(self):
        self.configure_rpc()
        result = await self.host.open_thread(self.request(), None)
        self.assertEqual(result[:2], ("saved", "model"))
        self.assertEqual(self.host.process_generation, 2)
        self.assertEqual(self.host._threads["saved"].attached_generation, 2)
        self.host._start_process.assert_awaited_once()
        self.assertFalse(self.host._opening_threads)
        self.assertTrue(self.host.reusable)

    async def test_new_thread_ack_is_preserved_before_failed_process_check(self):
        self.configure_rpc(acknowledge=True)
        result = await self.host.open_thread(self.request(""), None)
        self.assertEqual(result[0], "created")
        calls = self.host._request_connected.await_args_list
        self.assertEqual([call.args[0] for call in calls], ["thread/start", "thread/resume"])
        self.assertEqual(calls[1].args[1]["threadId"], "created")

    async def test_unknown_thread_creation_is_not_replayed(self):
        self.configure_rpc()
        with self.assertRaises(AppServerError):
            await self.host.open_thread(self.request(""), None)
        await asyncio.gather(*self.readers)
        self.host._request_connected.assert_awaited_once()
        self.host._start_process.assert_not_awaited()
        self.assertFalse(self.host._opening_threads)

    async def test_concurrent_openings_share_one_process_recovery(self):
        self.configure_rpc()
        results = await asyncio.gather(
            self.host.open_thread(self.request("first"), None),
            self.host.open_thread(self.request("second"), None),
        )
        self.assertEqual({result[0] for result in results}, {"first", "second"})
        self.host._start_process.assert_awaited_once()
        self.assertEqual(self.host.thread_count, 2)

    async def test_recovery_waits_for_exit_and_cancellation_does_not_restart(self):
        self.configure_rpc()
        self.exit_gate.clear()
        opening = asyncio.create_task(self.host.open_thread(self.request(), None))
        async with asyncio.timeout(TEST_TIMEOUT_SECONDS):
            while self.host.state != CodexProcessState.CRASHED:
                await asyncio.sleep(0)
        self.assertFalse(opening.done())
        self.host._start_process.assert_not_awaited()
        opening.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await opening
        self.exit_gate.set()
        await asyncio.gather(*self.readers)
        self.host._start_process.assert_not_awaited()
        self.assertFalse(self.host._opening_threads)

    async def test_repeated_crashes_exhaust_opening_attempts(self):
        self.configure_rpc(failures=10)
        with self.assertRaises(AppServerError):
            await self.host.open_thread(self.request(), None)
        self.assertEqual(self.host._request_connected.await_count, 3)
        self.assertEqual(self.host._start_process.await_count, 2)
        self.assertFalse(self.host._opening_threads)

    async def test_live_rpc_timeout_is_not_a_process_restart(self):
        self.host._request_connected = AsyncMock(
            side_effect=AppServerError("timeout", safe_error="runtime_rpc_timeout")
        )
        with self.assertRaises(AppServerError):
            await self.host.open_thread(self.request(), None)
        self.host._request_connected.assert_awaited_once()
        self.host._start_process.assert_not_awaited()
        self.assertFalse(self.host._opening_threads)

    async def test_exit_wait_is_bounded_without_starting_a_second_process(self):
        self.configure_rpc()
        self.exit_gate.clear()
        self.host.recovery_total_timeout = TEST_EXPIRY_SECONDS
        with self.assertRaises(AppServerError) as caught:
            await self.host.open_thread(self.request(), None)
        self.assertEqual(caught.exception.safe_error, "agent_runtime_unavailable")
        self.host._start_process.assert_not_awaited()
        self.assertIsNotNone(self.host._proc)
        self.assertFalse(self.host._opening_threads)

    async def test_wrong_thread_ack_is_terminal_even_if_process_exits(self):
        async def request(*args, **kwargs):
            self.crashes[1].set()
            self.host._proc.returncode = 1
            return {"thread": {"id": "wrong"}}

        self.host._request_connected = AsyncMock(side_effect=request)
        with self.assertRaises(AppServerError) as caught:
            await self.host.open_thread(self.request(), None)
        self.assertEqual(caught.exception.safe_error, "codex_thread_identity_mismatch")
        self.assertEqual(caught.exception.retryability, RuntimeRetryability.TERMINAL)
        self.host._request_connected.assert_awaited_once()
        self.assertFalse(self.host._threads)

    async def test_exit_cleanup_failure_preserves_cause_and_blocks_restart(self):
        self.configure_rpc()
        failure = OSError("controlled cleanup failure")
        self.host._discard_process = AsyncMock(side_effect=failure)
        with self.assertLogs("scholarseed_codex.process", level="ERROR") as logs:
            with self.assertRaises(AppServerError) as caught:
                await self.host.open_thread(self.request(), None)
        self.assertIs(caught.exception.__cause__, failure)
        self.assertIs(logs.records[0].exc_info[1], failure)
        self.host._start_process.assert_not_awaited()
        self.assertIsNotNone(self.host._proc)

    async def test_projection_failure_does_not_skip_physical_exit_cleanup(self):
        state = ThreadAttachment(
            request=self.request(),
            listener=None,
            thread_id="saved",
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=1,
        )
        failure = ValueError("controlled projection failure")
        state.turn = SimpleNamespace(connection_lost=AsyncMock(side_effect=failure))
        self.host._threads["saved"] = state
        sibling = ThreadAttachment(
            request=self.request("sibling"), listener=None, thread_id="sibling"
        )
        sibling.turn = SimpleNamespace(connection_lost=AsyncMock())
        self.host._threads["sibling"] = sibling
        self.host._schedule_recovery = Mock()
        self.crashes[1].set()
        with self.assertLogs("scholarseed_codex.process", level="ERROR"):
            with self.assertRaises(ValueError) as caught:
                await self.readers[0]
        self.assertIs(caught.exception, failure)
        sibling.turn.connection_lost.assert_awaited_once()
        self.assertEqual(sibling.attachment_state, CodexThreadAttachmentState.RECOVERY_PENDING)
        self.assertEqual(sibling.attached_generation, 0)
        self.assertIsNone(self.host._proc)
        self.assertIn(1, self.host._exited_generations)
        self.assertEqual(state.disconnected_generation, 1)
        self.host._schedule_recovery.assert_called_once()

    async def test_late_old_generation_fault_cannot_taint_or_clear_new_generation(self):
        self.configure_rpc()
        await self.host.open_thread(self.request(), None)
        self.assertTrue(self.host.reusable)
        self.host._unconfirm_attachment(1)
        self.assertTrue(self.host.reusable)
        self.host._unconfirm_attachment(2)
        await self.host.open_thread(self.request("other"), None)
        self.assertFalse(self.host.reusable)
        self.assertEqual(self.host._unconfirmed_attachment_generations, {2})

    async def test_close_while_waiting_for_exit_does_not_resurrect_host(self):
        self.configure_rpc()
        self.exit_gate.clear()
        opening = asyncio.create_task(self.host.open_thread(self.request(), None))
        await self.disconnections[1].wait()
        self.host._closed = True
        self.exit_gate.set()
        with self.assertRaises(AppServerError):
            await opening
        self.host._start_process.assert_not_awaited()
        self.assertFalse(self.host._opening_threads)

    async def test_turn_unknown_bookkeeping_survives_disconnect_projection_failure(self):
        self.configure_rpc(failures=0)
        await self.host.open_thread(self.request(), None)
        turn = self.host._threads["saved"].turn
        turn.active_turn_id = "inflight"
        turn.active_turn_client_id = "client"
        turn.turn_done = asyncio.get_running_loop().create_future()
        failure = OSError("controlled stale request projection failure")
        turn._stale_requests = AsyncMock(side_effect=failure)
        incident = RuntimeIncident(
            incident_id="disconnect-contract",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
        )
        with self.assertRaises(OSError) as caught:
            await turn.connection_lost(incident, 1)
        self.assertIs(caught.exception, failure)
        self.assertEqual(turn.active_turn_id, "")
        self.assertEqual(turn.interrupted_turn_id, "inflight")
        self.assertEqual(turn.turn_done.result()["status"], "unknown")


class ThreadRecoveryContracts(unittest.IsolatedAsyncioTestCase):
    async def recover(
        self,
        failures: int,
        *,
        reconcile_failures: int = 0,
        timeout: bool = False,
        terminal: bool = False,
        recrash: bool = False,
    ) -> tuple[CodexProcessHost, dict[str, int]]:
        host = CodexProcessHost(
            executable=TEST_EXECUTABLE,
            max_recovery_attempts=3,
            recovery_initial_delay=0,
            recovery_max_delay=0,
            recovery_total_timeout=0.03 if timeout else 5,
        )
        host._emitter = SimpleNamespace(incident=AsyncMock(), emit=AsyncMock())
        host._watcher = SimpleNamespace(open=AsyncMock())
        host._record_process_event = Mock()
        host._discard_process = AsyncMock()
        counts = {"healthy": 0, "recovering": 0}
        for thread_id in counts:
            state = ThreadAttachment(
                request=CodexSessionOpenRequest(
                    request_id=thread_id, runtime_id="codex", cwd=Path.cwd()
                ),
                listener=None,
                thread_id=thread_id,
                attachment_state=CodexThreadAttachmentState.RECOVERY_PENDING,
            )
            state.turn = SimpleNamespace(reconcile=AsyncMock())
            host._threads[thread_id] = state
        if timeout:
            host._threads["recovering"].turn.reconcile = AsyncMock(side_effect=asyncio.Event().wait)
        elif reconcile_failures:
            host._threads["recovering"].turn.reconcile = AsyncMock(
                side_effect=[AppServerError("reconcile unavailable")] * reconcile_failures + [None]
            )

        async def start() -> None:
            host._generation += 1
            host._proc = SimpleNamespace(returncode=None, pid=20032)

        async def request(method: str, params: dict, **_kwargs: object) -> dict:
            self.assertEqual(method, "thread/resume")
            thread_id = params["threadId"]
            counts[thread_id] += 1
            if thread_id == "recovering" and counts[thread_id] <= failures:
                raise AppServerError(
                    "resume rejected",
                    safe_error="runtime_rpc_rejected",
                    retryability=(
                        RuntimeRetryability.TERMINAL
                        if terminal
                        else RuntimeRetryability.USER_RETRYABLE
                    ),
                )
            return {"thread": {"id": thread_id}, "model": "model", "modelProvider": "provider"}

        host._start_process = AsyncMock(side_effect=start)
        host._request_connected = AsyncMock(side_effect=request)
        crashed = False

        async def publish(_state: ThreadAttachment, update: RuntimeIncident) -> None:
            nonlocal crashed
            if (
                recrash
                and not crashed
                and update.scope is RuntimeIncidentScope.PROCESS
                and update.state is RuntimeIncidentState.RECOVERED
            ):
                crashed = True
                host._proc.returncode = 1
                host.state = CodexProcessState.CRASHED
                for state in host._threads.values():
                    state.attachment_state = CodexThreadAttachmentState.RECOVERY_PENDING
                    state.attached_generation = 0

        host._emitter.incident.side_effect = publish
        incident = RuntimeIncident(
            incident_id="process-recovery-contract",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=0,
        )
        await host._recover_process(incident)
        return host, counts

    async def test_thread_resume_retries_without_restarting_healthy_process(self) -> None:
        host, counts = await self.recover(1)
        self.assertEqual(counts, {"healthy": 1, "recovering": 2})
        host._start_process.assert_awaited_once()
        host._discard_process.assert_not_awaited()
        self.assertEqual(host.state, CodexProcessState.READY)
        self.assertEqual(host._threads["recovering"].attached_generation, 1)
        incidents = [call.args[1] for call in host._emitter.incident.await_args_list]
        self.assertFalse(any(item.state is RuntimeIncidentState.FAILED for item in incidents))

    async def test_exhausted_thread_recovery_keeps_healthy_process_and_threads(self) -> None:
        host, counts = await self.recover(10)
        self.assertEqual(counts, {"healthy": 1, "recovering": 3})
        host._start_process.assert_awaited_once()
        host._discard_process.assert_not_awaited()
        self.assertEqual(host.state, CodexProcessState.READY)
        self.assertEqual(host._threads["healthy"].attached_generation, 1)
        self.assertEqual(
            host._threads["recovering"].attachment_state, CodexThreadAttachmentState.BROKEN
        )
        failures = [
            call.args[1]
            for call in host._emitter.incident.await_args_list
            if call.args[1].state is RuntimeIncidentState.FAILED
        ]
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0].scope, RuntimeIncidentScope.THREAD)
        self.assertEqual(failures[0].attempt, 3)

    async def test_reconcile_failure_is_automatically_retried(self) -> None:
        host, counts = await self.recover(0, reconcile_failures=1)
        self.assertEqual(counts, {"healthy": 1, "recovering": 2})
        self.assertEqual(
            host._threads["recovering"].attachment_state, CodexThreadAttachmentState.ATTACHED
        )
        self.assertFalse(
            any(
                call.args[1].state is RuntimeIncidentState.FAILED
                for call in host._emitter.incident.await_args_list
            )
        )

    async def test_reconcile_timeout_does_not_leave_false_attached_state(self) -> None:
        host, _counts = await self.recover(0, timeout=True)
        self.assertEqual(host.state, CodexProcessState.READY)
        self.assertEqual(
            host._threads["recovering"].attachment_state, CodexThreadAttachmentState.BROKEN
        )
        host._discard_process.assert_not_awaited()

    async def test_terminal_resume_error_is_not_retried(self) -> None:
        host, counts = await self.recover(10, terminal=True)
        self.assertEqual(counts, {"healthy": 1, "recovering": 1})
        self.assertEqual(host.state, CodexProcessState.READY)
        self.assertEqual(
            host._threads["recovering"].attachment_incident.retryability,
            RuntimeRetryability.TERMINAL,
        )

    async def test_broken_thread_is_not_announced_as_recovered(self) -> None:
        host, counts = await self.recover(10, terminal=True)
        self.assertEqual(counts, {"healthy": 1, "recovering": 1})
        recovered = [
            call.args[0].thread_id
            for call in host._emitter.incident.await_args_list
            if call.args[1].state is RuntimeIncidentState.RECOVERED
        ]
        self.assertEqual(recovered, ["healthy"])

    async def test_absent_native_member_does_not_poison_configuration(self) -> None:
        host, _counts = await self.recover(10, terminal=True)
        missing = host._threads["recovering"]
        missing.absent_generation = host.process_generation
        for state in host._threads.values():
            state.turn.active_turn_id = ""
            state.turn.ambiguous_submission_id = "unknown-message" if state is missing else ""
            state.turn.turn_done = None
        host.admission.freeze(1)
        ticket = NativeQuiescence(
            1, host.process_generation, host.activity_revision, host.admission.epoch
        )
        self.assertTrue(host.configuration_quiescence_current(ticket))
        calls = []

        async def inventory(method, params, **kwargs):
            self.assertEqual(method, "mcpServerStatus/list")
            calls.append(params["threadId"])
            if params["threadId"] == "recovering":
                raise AppServerError("thread not found")
            return {"data": []}

        host._request_connected.side_effect = inventory
        result = await host.verify_mcp_configuration(ticket, frozenset())
        self.assertTrue(result.can_admit)
        self.assertEqual(calls, [None, "healthy"])
        self.assertIs(host._threads["recovering"], missing)
        self.assertEqual(missing.turn.ambiguous_submission_id, "unknown-message")
        self.assertIn("native_command_unsettled", host.suspend_blockers("recovering"))

    async def test_unconfirmed_missing_member_and_unsettled_writes_remain_fenced(self) -> None:
        host, _counts = await self.recover(10, terminal=True)
        for state in host._threads.values():
            state.turn.active_turn_id = ""
            state.turn.ambiguous_submission_id = "unknown-message"
            state.turn.turn_done = None
        host.admission.freeze(1)
        ticket = NativeQuiescence(
            1, host.process_generation, host.activity_revision, host.admission.epoch
        )
        self.assertFalse(host.configuration_quiescence_current(ticket))
        for state in host._threads.values():
            state.absent_generation = host.process_generation
        _request_id, pending = host._rpc_requests.begin(
            host.process_generation, "config/mcpServer/reload"
        )
        pending.mark_written()
        self.assertFalse(host.configuration_quiescence_current(ticket))
        host._rpc_requests.close(AppServerError("fixture closed"))
        with self.assertRaises(AppServerError):
            await pending.future

    async def test_absent_member_reappearance_invalidates_configuration_ticket(self) -> None:
        host, _counts = await self.recover(10, terminal=True)
        for state in host._threads.values():
            state.turn.active_turn_id = ""
            state.turn.ambiguous_submission_id = ""
            state.turn.turn_done = None
        missing = host._threads["recovering"]
        missing.absent_generation = host.process_generation
        host.admission.freeze(1)
        activity = SimpleNamespace(
            complete=True,
            blockers=(),
            loaded_thread_ids=("recovering",),
            process_generation=host.process_generation,
        )
        with patch(
            "scholarseed_codex.process.NativeActivity.inspect", new=AsyncMock(return_value=activity)
        ):
            self.assertIsNone(await host.configuration_quiescence(1))
        self.assertEqual(missing.absent_generation, 0)

    async def test_configuration_inventory_rejects_membership_change_during_read(self) -> None:
        host, _counts = await self.recover(10, terminal=True)
        missing = host._threads["recovering"]
        missing.absent_generation = host.process_generation
        host.admission.freeze(1)
        ticket = NativeQuiescence(
            1, host.process_generation, host.activity_revision, host.admission.epoch
        )

        async def inventory(method, params, **kwargs):
            missing.absent_generation = 0
            return {"data": []}

        host._request_connected.side_effect = inventory
        with self.assertRaises(AppServerError) as stale:
            await host.verify_mcp_configuration(ticket, frozenset())
        self.assertEqual(stale.exception.safe_error, "runtime_suspend_stale")

    async def test_exit_during_recovery_publication_uses_remaining_budget(self) -> None:
        host, counts = await self.recover(0, recrash=True)
        self.assertEqual(host._start_process.await_count, 2)
        self.assertEqual(counts, {"healthy": 2, "recovering": 2})
        self.assertEqual(host.process_generation, 2)
        self.assertEqual(host.state, CodexProcessState.READY)


class RealProcessLifecycleContracts(unittest.IsolatedAsyncioTestCase):
    async def test_owned_process_is_rejected_before_entering_startup_coordination(self) -> None:
        for returncode in (None, 0):
            with self.subTest(returncode=returncode):
                scope = Mock(
                    side_effect=AssertionError("owned process must not enter startup coordination")
                )
                host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE, startup_scope=scope)
                host._proc = SimpleNamespace(returncode=returncode)
                host.state = CodexProcessState.CRASHED
                generation = host.process_generation
                try:
                    with self.assertRaises(AppServerError) as blocked:
                        await host.start()
                    self.assertEqual(blocked.exception.safe_error, "agent_runtime_unavailable")
                    self.assertIs(blocked.exception.retryability, RuntimeRetryability.IN_PROGRESS)
                    self.assertEqual(host.process_generation, generation)
                    scope.assert_not_called()
                finally:
                    host._proc = None

    async def test_launch_uses_frozen_environment_without_late_argument_fallback(self) -> None:
        with patch.dict(os.environ, {"FROZEN_VALUE": "before", "REMOVED_VALUE": "private"}):
            host = CodexProcessHost(
                executable=TEST_EXECUTABLE,
                remove_environment=("REMOVED_VALUE",),
                launch_arguments=(
                    CodexRuntimeLaunchArgument(option="--value", environment="FROZEN_VALUE"),
                    CodexRuntimeLaunchArgument(option="--removed", environment="REMOVED_VALUE"),
                    CodexRuntimeLaunchArgument(option="--late", environment="LATE_VALUE"),
                ),
            )
        spawn = AsyncMock(side_effect=OSError("stop before process creation"))
        with (
            patch.dict(os.environ, {"FROZEN_VALUE": "after", "LATE_VALUE": "late"}),
            patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn),
        ):
            with self.assertRaisesRegex(OSError, "stop before process creation"):
                await host._launch_process()
        self.assertEqual(spawn.call_args.kwargs["env"]["FROZEN_VALUE"], "before")
        self.assertNotIn("REMOVED_VALUE", spawn.call_args.kwargs["env"])
        self.assertNotIn("LATE_VALUE", spawn.call_args.kwargs["env"])
        self.assertEqual(spawn.call_args.args[-2:], ("--value", "before"))

    async def test_windows_environment_snapshot_normalizes_removal_and_overrides(self) -> None:
        with (
            patch.dict(os.environ, {"Mixed_Key": "inherited", "Remove_Key": "private"}, clear=True),
            patch.object(environment_module, "ENVIRONMENT_NAME_CASE_INSENSITIVE", True),
            patch.object(executable_module, "ENVIRONMENT_NAME_CASE_INSENSITIVE", True),
        ):
            snapshot = environment_module.process_environment_snapshot(
                {"mixed_KEY": "override"}, ("REMOVE_KEY",)
            )
            self.assertEqual(snapshot, {"MIXED_KEY": "override"})
            self.assertEqual(
                executable_module._resolve_launch_arguments(
                    (CodexRuntimeLaunchArgument(option="--value", environment="Mixed_Key"),),
                    snapshot,
                ),
                ("--value", "override"),
            )

    @staticmethod
    async def reap_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        await process.communicate()

    async def test_stdout_eof_retains_process_until_os_exit_before_recovery(self) -> None:
        child = "import os,sys; print('ready',flush=True); " "os.close(1); sys.stdin.buffer.read(1)"
        process = await asyncio.create_subprocess_exec(
            TEST_CHILD_EXECUTABLE,
            "-c",
            child,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.addAsyncCleanup(self.reap_process, process)
        assert process.stdin is not None
        assert process.stdout is not None
        self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_READY)
        host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE)
        host._proc = process
        host._generation = 1
        host.state = CodexProcessState.READY
        disconnected = asyncio.Event()
        attachment = ThreadAttachment(
            request=CodexSessionOpenRequest(
                request_id="eof-root", runtime_id="codex", cwd=Path.cwd()
            ),
            listener=None,
            thread_id="eof-root",
            attachment_state=CodexThreadAttachmentState.ATTACHED,
            attached_generation=host.process_generation,
        )
        attachment.turn = SimpleNamespace(
            connection_lost=AsyncMock(side_effect=lambda *_: disconnected.set())
        )
        host._threads[attachment.thread_id] = attachment
        with patch.object(host, "_schedule_recovery", Mock()) as recovery:
            reader = asyncio.create_task(host._read_stdout(process, host.process_generation))
            host._reader_task = reader
            try:
                try:
                    await asyncio.wait_for(disconnected.wait(), TEST_TIMEOUT_SECONDS)
                except TimeoutError:
                    if reader.done():
                        await reader
                    raise
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
                TEST_CHILD_EXECUTABLE,
                "-c",
                child,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self.addAsyncCleanup(self.reap_process, process)
            assert process.stdout is not None
            self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_READY)
            host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE)
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
                TEST_CHILD_EXECUTABLE,
                "-c",
                child,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            self.addAsyncCleanup(self.reap_process, process)
            assert process.stdout is not None
            self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_READY)
            host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE)
            host._proc = process
            host._generation = 1
            host.state = CodexProcessState.CRASHED
            discarding = asyncio.create_task(
                host._discard_process(process, host.process_generation)
            )
            try:
                self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_EOF)
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

    async def test_safe_stop_does_not_wait_for_inherited_output_pipes_after_os_exit(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-inherited-pipes-") as directory:
            release = Path(directory) / "release"
            descendant = (
                "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); "
                "\nwhile not p.exists(): time.sleep(0.01)"
            )
            child = (
                "import subprocess,sys; "
                f"subprocess.Popen([sys.executable,'-c',{descendant!r},{str(release)!r}],"
                "stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stderr); "
                "print('ready',flush=True); sys.stdin.buffer.read()"
            )
            process = await asyncio.create_subprocess_exec(
                TEST_CHILD_EXECUTABLE,
                "-c",
                child,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            assert process.stdout is not None and process.stderr is not None
            host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE)
            host._proc = process
            host._generation = 1
            host.state = CodexProcessState.READY
            stopping = None
            try:
                self.assertEqual((await process.stdout.readline()).strip(), TEST_CHILD_READY)
                stopping = asyncio.create_task(host.stop_idle(host.process_generation))
                await asyncio.wait_for(asyncio.shield(stopping), 1.0)
                self.assertEqual(process.returncode, 0)
                self.assertIsNone(host._proc)
                self.assertFalse(process.stdout.at_eof())
                self.assertFalse(process.stderr.at_eof())
            finally:
                release.touch()
                await self.reap_process(process)
                if stopping is not None:
                    await asyncio.gather(stopping, return_exceptions=True)
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
            TEST_CHILD_EXECUTABLE,
            "-c",
            child,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self.addAsyncCleanup(self.reap_process, process)
        assert process.stdout is not None
        self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_READY)
        host = CodexProcessHost(executable=TEST_CHILD_EXECUTABLE)
        host._proc = process
        host._generation = 1
        host.state = CodexProcessState.READY
        stopping = asyncio.create_task(host.stop_idle(host.process_generation))
        try:
            self.assertEqual((await process.stdout.readline()).rstrip(b"\r\n"), TEST_CHILD_EOF)
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
    async def test_real_codex_shared_threads_keep_independent_native_lifetimes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-sharing-contract-") as directory:
            root = Path(directory).resolve()
            runtime_home = root / "codex-home"
            environment, arguments = managed_codex_launch(runtime_home, {}, ())
            workdirs = [root / f"session-{index}" for index in range(3)]
            for workdir in workdirs:
                workdir.mkdir()
            pool = CodexHostPool(CapacityPolicy(execution_hosts=1))
            sessions = [
                CodexThreadSession(
                    CodexSessionOpenRequest(
                        request_id=f"sharing-{index}",
                        runtime_id=TEST_RUNTIME_ID,
                        cwd=workdirs[index],
                        launch_cwd=runtime_home / "host",
                        thread_config={
                            "shell_environment_policy.set.TEXMFVAR": str(workdirs[index] / "cache")
                        },
                        execution_scope=f"sharing-{index}",
                        process_sharing_scope="contract-owner",
                        executable=os.environ[TEST_EXECUTABLE_ENV],
                        process_environment=environment,
                        launch_arguments=arguments,
                        sandbox="read-only",
                        approval_policy="never",
                    ),
                    host_pool=pool,
                )
                for index in range(3)
            ]
            try:
                await asyncio.wait_for(
                    asyncio.gather(*(session.open() for session in sessions)), TEST_WAIT_SECONDS
                )
                host = sessions[0].host
                process = host._proc
                assert process is not None
                self.assertEqual(len({session.session_id for session in sessions}), 3)
                self.assertTrue(all(session.host is host for session in sessions))
                self.assertEqual(host.launch_cwd, runtime_home / "host")
                for index, session in enumerate(sessions):
                    self.assertEqual(host._threads[session.session_id].request.cwd, workdirs[index])
                self.assertEqual(sum(row.used for row in pool.snapshot()), 1)
                await sessions[0].suspend(host.process_generation)
                self.assertIsNone(process.returncode)
                result = await host.request("thread/loaded/list", {"limit": 10})
                self.assertTrue(
                    {session.session_id for session in sessions[1:]} <= set(result["data"])
                )
                self.assertTrue(all(session.host is host for session in sessions[1:]))
                await sessions[1].suspend(host.process_generation)
                self.assertIsNone(process.returncode)
                await sessions[2].suspend(host.process_generation)
                if sys.platform == WINDOWS_PLATFORM:
                    self.assertEqual(process.returncode, 0)
                    self.assertEqual(sum(row.used for row in pool.snapshot()), 0)
                else:
                    self.assertIsNone(process.returncode)
                    self.assertEqual(sum(row.used for row in pool.snapshot()), 1)
                self.assertTrue(await pool.release_idle())
                self.assertEqual(process.returncode, 0)
                self.assertEqual(sum(row.used for row in pool.snapshot()), 0)
                self.assertFalse((runtime_home / "auth.json").exists())
            finally:
                await asyncio.gather(*(session.aclose() for session in sessions))
                await pool.aclose()

    @unittest.skipUnless(os.environ.get(TEST_EXECUTABLE_ENV), "explicit Codex test binary required")
    async def test_real_codex_thread_profiles_override_readonly_host(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-profile-contract-") as directory:
            root = Path(directory).resolve()
            (root / "host").mkdir()
            environment, arguments = managed_codex_launch(
                root / "codex-home",
                {},
                (
                    CodexRuntimeLaunchArgument(
                        option="-c", value='default_permissions=":read-only"'
                    ),
                ),
            )
            host = CodexProcessHost(
                executable=os.environ[TEST_EXECUTABLE_ENV],
                process_environment=environment,
                launch_arguments=arguments,
                launch_cwd=root / "host",
            )
            try:
                await host.start()
                process = host._proc
                cases = (
                    ("read-only", "never", ()),
                    ("workspace-write", "on-request", ()),
                    ("workspace-write", "on-request", ("one.example.com",)),
                )
                for index, (sandbox, approval, domains) in enumerate(cases):
                    cwd = root / f"workspace-{index}"
                    cwd.mkdir()
                    profile, config = thread_permission_config(sandbox, (), network_domains=domains)
                    if os.name == "nt":
                        config["windows.sandbox"] = "elevated"
                    request = CodexSessionOpenRequest(
                        request_id=f"profile-{index}",
                        runtime_id="codex",
                        cwd=cwd,
                        sandbox=sandbox,
                        approval_policy=approval,
                        permissions_profile=profile,
                        thread_config=config,
                    )
                    result = await host.request(
                        "thread/start", host._thread_params(request, include_dynamic_tools=False)
                    )
                    self.assertIs(host._proc, process)
                    self.assertEqual(result["cwd"], str(cwd))
                    self.assertEqual(result["approvalPolicy"], approval)
                    self.assertEqual(
                        result["sandbox"]["type"],
                        "readOnly" if sandbox == "read-only" else "workspaceWrite",
                    )
                    if profile:
                        self.assertEqual(result["activePermissionProfile"]["id"], profile)
                    if sandbox == "workspace-write":
                        self.assertNotIn(str(host.launch_cwd), result["sandbox"]["writableRoots"])
                    await host.request("thread/unsubscribe", {"threadId": result["thread"]["id"]})
            finally:
                await host.aclose()

    @unittest.skipUnless(os.environ.get(TEST_EXECUTABLE_ENV), "explicit Codex test binary required")
    async def test_real_codex_initialize_and_safe_eof_exit_without_account(self) -> None:
        with tempfile.TemporaryDirectory(prefix="codex-capacity-contract-") as directory:
            runtime_home = Path(directory) / "codex-home"
            runtime_home.mkdir()
            ownership = Mock()
            pool = CodexHostPool(
                CapacityPolicy(execution_hosts=1, control_hosts=1),
                resource_lease=lambda: ownership,
            )
            request = CodexSessionOpenRequest(
                request_id="real-execution-capacity",
                runtime_id=TEST_RUNTIME_ID,
                cwd=Path(directory),
                executable=os.environ[TEST_EXECUTABLE_ENV],
                process_environment={CODEX_HOME_ENV: str(runtime_home)},
            )
            try:
                reservation = await pool.reserve(
                    request,
                    role=HostRole.EXECUTION,
                    request_id=request.request_id,
                    deadline=time() + TEST_WAIT_SECONDS,
                )
                lease = await asyncio.wait_for(pool.consume(reservation), TEST_TIMEOUT_SECONDS)
                self.assertTrue(lease.host.readiness.ready)
                self.assertIsNotNone(lease.host.pid)
                process = lease.host._proc
                self.assertIsNotNone(process)
                borrowed = await pool.acquire(replace(request, request_id="real-control-borrow"))
                control = CodexRuntimeControl(cwd=request.cwd, lease=borrowed, host_pool=pool)
                await control.open()
                self.assertIs(control.host, lease.host)
                self.assertEqual(control.host.pid, process.pid)
                self.assertEqual(
                    next(row.used for row in pool.snapshot() if row.role == HostRole.CONTROL.value),
                    0,
                )
                await control.aclose()
                await asyncio.wait_for(borrowed.close(), TEST_TIMEOUT_SECONDS)
                await asyncio.wait_for(lease.close(), TEST_TIMEOUT_SECONDS)
                self.assertIsNone(process.returncode)
                ownership.close.assert_not_called()
                self.assertTrue(await asyncio.wait_for(pool.release_idle(), TEST_TIMEOUT_SECONDS))
                self.assertEqual(process.returncode, 0)
                ownership.close.assert_called_once_with()
                self.assertEqual(sum(row.used for row in pool.snapshot()), 0)
                self.assertFalse((runtime_home / "auth.json").exists())
            finally:
                await pool.aclose()


class VersionProbeStorageContracts(unittest.IsolatedAsyncioTestCase):
    def test_relative_executable_is_resolved_before_switching_probe_cwd(self) -> None:
        with patch.object(executable_module.shutil, "which", return_value="./runtime/codex"):
            self.assertEqual(
                executable_module.discover_codex_executable("./runtime/codex"),
                os.path.abspath("./runtime/codex"),
            )

    async def test_version_command_uses_private_home_without_inherited_secrets(self) -> None:
        homes: list[Path] = []
        with tempfile.TemporaryDirectory() as temporary:
            persisted = Path(temporary) / "provider"
            persisted.mkdir()
            marker = persisted / "existing.json"
            original = b'{"preserve":true}'
            marker.write_bytes(original)

            async def command(executable, *arguments, timeout, environment, cwd, output_limit):
                self.assertEqual(executable, TEST_EXECUTABLE)
                self.assertEqual(arguments, ("--version",))
                self.assertGreater(timeout, 0)
                self.assertIsInstance(cwd, Path)
                self.assertTrue(cwd.is_dir())
                self.assertNotEqual(cwd, persisted)
                homes.append(cwd)
                self.assertEqual(output_limit, executable_module.CODEX_PREFLIGHT_OUTPUT_LIMIT_BYTES)
                for key in environment_module.ISOLATED_HOME_ENVIRONMENT:
                    self.assertEqual(environment[key], str(cwd))
                for key in (
                    "OPENAI_API_KEY",
                    "NODE_OPTIONS",
                    "LD_PRELOAD",
                    "SCHOLARSEED_CODEX_HOME",
                    "PATH",
                ):
                    self.assertNotIn(key, environment)
                self.assertEqual(
                    {key.upper(): value for key, value in environment.items()}["SYSTEMROOT"],
                    "system-directory",
                )
                # Simulate a CLI that writes even during version discovery.
                (Path(environment["CODEX_HOME"]) / "migration.json").write_text("{}")
                return 0, b"codex-cli 0.159.0\n", b""

            with (
                patch.dict(
                    os.environ,
                    {
                        "SystemRoot": "system-directory",
                        "OPENAI_API_KEY": TEST_SECRET_VALUE,
                        "NODE_OPTIONS": TEST_SECRET_VALUE,
                        "LD_PRELOAD": TEST_SECRET_VALUE,
                        "HOME": str(persisted),
                        "CODEX_HOME": str(persisted),
                        "SCHOLARSEED_CODEX_HOME": str(persisted),
                    },
                    clear=True,
                ),
                patch.object(executable_module, "run_command", side_effect=command),
            ):
                for _ in range(2):
                    self.assertEqual(
                        await executable_module._preflight_command(
                            TEST_EXECUTABLE,
                            "--version",
                            process_environment={"CODEX_HOME": str(persisted)},
                        ),
                        (0, "codex-cli 0.159.0"),
                    )
            self.assertEqual(marker.read_bytes(), original)
            self.assertEqual(tuple(persisted.iterdir()), (marker,))
        self.assertNotEqual(homes[0], homes[1])
        self.assertTrue(all(not home.exists() for home in homes))

    async def test_cancel_keeps_probe_home_until_command_cleanup_finishes(self) -> None:
        entered = asyncio.Event()
        cleaning = asyncio.Event()
        drained = asyncio.Event()
        homes: list[Path] = []

        async def command(_executable, *_arguments, **options):
            home = options["cwd"]
            homes.append(home)
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await drained.wait()
                self.assertTrue(home.is_dir())

        with patch.object(executable_module, "run_command", side_effect=command):
            pending = asyncio.create_task(
                executable_module._preflight_command(TEST_EXECUTABLE, "--version")
            )
            try:
                await asyncio.wait_for(entered.wait(), TEST_TIMEOUT_SECONDS)
                pending.cancel()
                await asyncio.wait_for(cleaning.wait(), TEST_TIMEOUT_SECONDS)
                self.assertFalse(pending.done())
                self.assertTrue(homes[0].is_dir())
            finally:
                drained.set()
                if not entered.is_set():
                    pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
        self.assertFalse(homes[0].exists())

    async def test_native_login_retains_explicit_authentication_environment(self) -> None:
        command = AsyncMock(return_value=(0, b"logged in", b""))
        with patch.object(executable_module, "run_command", command):
            await executable_module._preflight_command(
                TEST_EXECUTABLE,
                "login",
                "status",
                process_environment={"CODEX_HOME": "/native-auth"},
            )
        self.assertEqual(command.await_args.kwargs["environment"]["CODEX_HOME"], "/native-auth")
        self.assertNotIn("cwd", command.await_args.kwargs)


class OpeningContracts(unittest.IsolatedAsyncioTestCase):
    def prepared_open(self):
        runtime = CodexRuntimeProvider()
        request = OpenSessionRequest(
            product_session_id="opening",
            cwd=Path.cwd(),
            reservation_id="reservation",
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                )
            ),
        )
        reservation = SimpleNamespace(slot=None)
        session = SimpleNamespace(
            consume_resource=AsyncMock(), open=AsyncMock(), detach=AsyncMock()
        )
        runtime._prepared[request.reservation_id] = (
            SimpleNamespace(session_request=replace(request, reservation_id="")),
            session,
            reservation,
        )
        runtime._pool.cancel = AsyncMock()
        return runtime, request, session, reservation

    async def test_resource_failure_produces_proof_only_after_cleanup(self):
        runtime, request, session, reservation = self.prepared_open()
        failure = AppServerError("startup failed", safe_error="runtime_rpc_rejected")
        session.consume_resource.side_effect = failure
        cleanup_entered = asyncio.Event()
        cleanup_finished = asyncio.Event()
        reservation.slot = object()

        async def cleanup(_reservation):
            cleanup_entered.set()
            await cleanup_finished.wait()
            reservation.slot = None

        runtime._pool.cancel.side_effect = cleanup
        task = asyncio.create_task(runtime.open(request))
        await asyncio.wait_for(cleanup_entered.wait(), TEST_TIMEOUT_SECONDS)
        self.assertFalse(task.done())
        session.open.assert_not_awaited()
        cleanup_finished.set()
        with self.assertRaises(RuntimeOpenNotAppliedError) as caught:
            await task
        self.assertEqual(caught.exception.reservation_id, request.reservation_id)
        self.assertEqual(caught.exception.safe_error, failure.safe_error)
        self.assertIs(caught.exception.__cause__, failure)
        session.detach.assert_awaited_once()

    async def test_open_errors_and_cancellation_are_not_negative_proof(self):
        for at_open, failure in (
            (True, AppServerError("acknowledgement lost")),
            (False, asyncio.CancelledError()),
        ):
            with self.subTest(at_open=at_open):
                runtime, request, session, _reservation = self.prepared_open()
                operation = session.open if at_open else session.consume_resource
                operation.side_effect = failure
                with self.assertRaises(type(failure)) as caught:
                    await runtime.open(request)
                self.assertNotIsInstance(caught.exception, RuntimeOpenNotAppliedError)

    async def test_cleanup_failure_keeps_primary_and_cleanup_causes(self):
        for failed_cleanup, cleanup_failure in (
            ("cancel", OSError("cleanup failed")),
            ("detach", OSError("cleanup failed")),
            ("cancel", asyncio.CancelledError()),
            ("detach", asyncio.CancelledError()),
        ):
            with self.subTest(failed_cleanup=failed_cleanup, failure=type(cleanup_failure)):
                runtime, request, session, _reservation = self.prepared_open()
                failure = AppServerError("startup failed")
                session.consume_resource.side_effect = failure
                cleanup = runtime._pool.cancel if failed_cleanup == "cancel" else session.detach
                cleanup.side_effect = cleanup_failure
                with self.assertRaises(BaseExceptionGroup) as caught:
                    await runtime.open(request)
                self.assertIn(failure, caught.exception.exceptions)
                self.assertIn(cleanup_failure, caught.exception.exceptions)
                session.detach.assert_awaited_once()

    async def test_residual_ownership_does_not_produce_negative_proof(self):
        runtime, request, session, reservation = self.prepared_open()
        reservation.slot = object()
        failure = AppServerError("startup failed")
        session.consume_resource.side_effect = failure
        with self.assertRaises(AppServerError):
            await runtime.open(request)

    async def test_duplicate_redeemer_cannot_produce_proof_or_close_winner(self):
        runtime, request, session, _reservation = self.prepared_open()
        runtime._prepared.clear()
        with self.assertRaises(AppServerError):
            await runtime.open(request)
        session.detach.assert_not_awaited()
        runtime._pool.cancel.assert_not_awaited()

    async def test_mismatched_request_cannot_consume_or_clean_another_reservation(self):
        runtime, request, session, _reservation = self.prepared_open()
        with self.assertRaises(AppServerError):
            await runtime.open(replace(request, product_session_id="other-session"))
        session.consume_resource.assert_not_awaited()
        session.detach.assert_not_awaited()
        runtime._pool.cancel.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
