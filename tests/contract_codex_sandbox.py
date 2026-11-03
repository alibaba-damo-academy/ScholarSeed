"""Windows native sandbox startup contracts; not product acceptance."""

from __future__ import annotations

import asyncio
import io
import json
import logging
import sys
import unittest
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_codex.diagnostic import DIAGNOSTIC_SCAN_LIMIT, native_diagnostic
from scholarseed_codex.environment import CODEX_RUNTIME_HOME
from scholarseed_codex.mutex import LOGGER as MUTEX_LOGGER
from scholarseed_codex.mutex import _error as startup_error
from scholarseed_codex.mutex import startup_mutex
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.protocol.state import (
    AppServerError,
    CodexProcessState,
    CodexThreadAttachmentState,
)
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_codex.rpc import PendingRequests
from scholarseed_codex.sandbox import (
    LOGGER,
    SANDBOX_ARGUMENT,
    SANDBOX_COMPLETED_METHOD,
    SANDBOX_EXECUTION_METHOD,
    SANDBOX_EXECUTION_TIMEOUT_MS,
    SANDBOX_MODE,
    SANDBOX_PERMISSION_METHOD,
    SANDBOX_READINESS_METHOD,
    SANDBOX_READONLY_ARGUMENT,
    SANDBOX_RESOURCE_ERROR,
    SANDBOX_SETUP_METHOD,
    SANDBOX_SETUP_TIMEOUT_SECONDS,
    SANDBOX_USERS_GROUP,
    WindowsSandboxBootstrap,
    windows_sandbox_arguments,
)
from scholarseed_runtime.contract.command import CommandState
from scholarseed_runtime.contract.evidence import RuntimeProcessEventKind
from scholarseed_runtime.contract.incident import (
    RuntimeIncident,
    RuntimeIncidentKind,
    RuntimeIncidentScope,
    RuntimeIncidentState,
    RuntimeRecoveryStrategy,
    RuntimeRetryability,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from scholarseed_runtime.contract.sandbox import (
    SANDBOX_CANCELLED_ERROR,
    SANDBOX_POLICY_ERROR,
    SANDBOX_SETUP_ERROR,
    SANDBOX_UNKNOWN_ERROR,
    SandboxProbe,
    SandboxRecoveryError,
)

GENERATION = 1
TEST_TIMEOUT_SECONDS = 0.01


class WindowsSandboxContracts(unittest.IsolatedAsyncioTestCase):
    def recovery_incident(self) -> RuntimeIncident:
        return RuntimeIncident(
            incident_id="original-process-exit",
            scope=RuntimeIncidentScope.PROCESS,
            state=RuntimeIncidentState.DETECTED,
            kind=RuntimeIncidentKind.PROCESS_EXIT,
            strategy=RuntimeRecoveryStrategy.AUTO_RESTART,
            retryability=RuntimeRetryability.IN_PROGRESS,
            safe_error="agent_runtime_exit",
            process_generation=GENERATION,
            vendor_thread_id="original-thread",
            vendor_turn_id="original-turn",
            rpc_method="turn/start",
            rpc_code=-32000,
            process_exit_code=57005,
            ambiguous_commit=True,
        )

    async def test_recovery_stops_after_sandbox_failure_and_keeps_its_cause(self) -> None:
        for safe_error, retryability in (
            (SANDBOX_CANCELLED_ERROR, RuntimeRetryability.USER_RETRYABLE),
            (SANDBOX_UNKNOWN_ERROR, RuntimeRetryability.UNKNOWN_OUTCOME),
        ):
            with self.subTest(safe_error=safe_error):
                host = CodexProcessHost(
                    max_recovery_attempts=3,
                    recovery_initial_delay=0,
                    recovery_max_delay=0,
                    recovery_jitter_ratio=0,
                )
                host._generation = GENERATION + 1
                host._threads["original-thread"] = SimpleNamespace()
                host._emitter.incident = AsyncMock()
                host._record_process_event = Mock()
                failure = AppServerError(
                    "native initialization failed",
                    safe_error=safe_error,
                    method=SANDBOX_EXECUTION_METHOD,
                    generation=GENERATION + 1,
                    rpc_code=-32603,
                    rpc_latency_ms=31,
                    retryability=retryability,
                )
                host._start_process = AsyncMock(side_effect=failure)
                original = self.recovery_incident()
                await host._recover_process(original)
                self.assertEqual(host._start_process.await_count, 1)
                final = host._emitter.incident.await_args.args[1]
                self.assertEqual(final.incident_id, original.incident_id)
                self.assertEqual(final.safe_error, safe_error)
                self.assertIs(final.retryability, retryability)
                self.assertEqual(final.rpc_method, SANDBOX_EXECUTION_METHOD)
                self.assertEqual(final.rpc_code, -32603)
                self.assertEqual(final.rpc_latency_ms, 31)
                self.assertEqual(final.process_generation, GENERATION + 1)
                self.assertEqual(final.vendor_turn_id, original.vendor_turn_id)
                self.assertEqual(final.vendor_thread_id, original.vendor_thread_id)
                self.assertEqual(final.process_exit_code, original.process_exit_code)
                self.assertTrue(final.ambiguous_commit)

    async def test_transient_recovery_keeps_existing_bounded_retry(self) -> None:
        host = CodexProcessHost(
            max_recovery_attempts=3,
            recovery_initial_delay=0,
            recovery_max_delay=0,
            recovery_jitter_ratio=0,
        )
        host._threads["original-thread"] = SimpleNamespace()
        host._emitter.incident = AsyncMock()
        host._record_process_event = Mock()
        host._start_process = AsyncMock(
            side_effect=AppServerError(
                "transport unavailable",
                safe_error="runtime_transport_lost",
                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
            )
        )
        await host._recover_process(self.recovery_incident())
        self.assertEqual(host._start_process.await_count, host.max_recovery_attempts)

    async def test_recovery_timeout_preserves_shielded_sandbox_startup_failure(self) -> None:
        for safe_error, retryability in (
            (SANDBOX_UNKNOWN_ERROR, RuntimeRetryability.UNKNOWN_OUTCOME),
            (SANDBOX_CANCELLED_ERROR, RuntimeRetryability.USER_RETRYABLE),
            ("runtime_transport_lost", RuntimeRetryability.UNKNOWN_OUTCOME),
        ):
            with self.subTest(safe_error=safe_error):
                host = CodexProcessHost(
                    max_recovery_attempts=3,
                    recovery_total_timeout=TEST_TIMEOUT_SECONDS,
                    recovery_initial_delay=0,
                    recovery_max_delay=0,
                    recovery_jitter_ratio=0,
                )
                host._threads = {name: SimpleNamespace() for name in ("first", "second")}
                host._emitter.incident = AsyncMock()
                entered, finish = asyncio.Event(), asyncio.Event()
                failure = AppServerError(
                    "native startup did not finish before recovery timeout",
                    safe_error=safe_error,
                    retryability=retryability,
                    method=SANDBOX_EXECUTION_METHOD,
                    generation=GENERATION,
                    rpc_code=-32603,
                    rpc_latency_ms=31,
                )

                async def launch():
                    host._generation = GENERATION
                    entered.set()
                    await finish.wait()
                    raise failure

                @asynccontextmanager
                async def coordination():
                    yield

                launch_mock = AsyncMock(side_effect=launch)
                with (
                    patch("scholarseed_codex.process.startup_mutex", coordination),
                    patch("scholarseed_codex.process.os", SimpleNamespace(name="nt")),
                    patch.object(host, "_launch_process", launch_mock),
                ):
                    original = self.recovery_incident()
                    recovery = asyncio.create_task(host._recover_process(original))
                    await entered.wait()
                    await asyncio.sleep(TEST_TIMEOUT_SECONDS * 2)
                    finish.set()
                    await recovery
                launch_mock.assert_awaited_once()
                failed = [
                    call.args[1]
                    for call in host._emitter.incident.await_args_list
                    if call.args[1].state == RuntimeIncidentState.FAILED
                ]
                self.assertEqual(len(failed), len(host._threads))
                sandbox_failure = safe_error != "runtime_transport_lost"
                for incident in failed:
                    self.assertEqual(incident.incident_id, original.incident_id)
                    self.assertEqual(
                        incident.safe_error, safe_error if sandbox_failure else original.safe_error
                    )
                    self.assertIs(
                        incident.retryability,
                        retryability if sandbox_failure else RuntimeRetryability.USER_RETRYABLE,
                    )
                    self.assertEqual(
                        incident.rpc_method,
                        SANDBOX_EXECUTION_METHOD if sandbox_failure else original.rpc_method,
                    )
                    self.assertEqual(incident.rpc_code, -32603 if sandbox_failure else -32000)
                    self.assertTrue(incident.ambiguous_commit)
                    self.assertEqual(incident.vendor_turn_id, original.vendor_turn_id)

    async def test_cancelled_startup_keeps_sandbox_cause_without_consuming_cancellation(
        self,
    ) -> None:
        host = CodexProcessHost()
        entered, finish = asyncio.Event(), asyncio.Event()
        failure = AppServerError(
            "native setup outcome unknown",
            safe_error=SANDBOX_UNKNOWN_ERROR,
            retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
        )

        async def launch():
            entered.set()
            await finish.wait()
            raise failure

        @asynccontextmanager
        async def coordination():
            yield

        with (
            patch("scholarseed_codex.process.startup_mutex", coordination),
            patch("scholarseed_codex.process.os", SimpleNamespace(name="nt")),
            patch.object(host, "_launch_process", launch),
        ):
            start = asyncio.create_task(host._start_process())
            await entered.wait()
            start.cancel()
            await asyncio.sleep(0)
            finish.set()
            with self.assertRaises(asyncio.CancelledError) as raised:
                await start
        self.assertIs(raised.exception.__cause__, failure)

    async def test_unknown_initialization_failure_keeps_original_rpc_when_cause_has_none(
        self,
    ) -> None:
        host = CodexProcessHost(max_recovery_attempts=1, recovery_initial_delay=0)
        host._generation = GENERATION + 1
        host._threads["original-thread"] = SimpleNamespace()
        host._emitter.incident = AsyncMock()
        host._record_process_event = Mock()
        host._start_process = AsyncMock(
            side_effect=AppServerError(
                "initialization unknown",
                safe_error=SANDBOX_UNKNOWN_ERROR,
                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
            )
        )
        original = self.recovery_incident()
        await host._recover_process(original)
        final = host._emitter.incident.await_args.args[1]
        self.assertEqual(final.safe_error, SANDBOX_UNKNOWN_ERROR)
        self.assertIs(final.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)
        self.assertEqual(final.rpc_method, original.rpc_method)
        self.assertEqual(final.rpc_code, original.rpc_code)
        self.assertTrue(final.ambiguous_commit)

    async def test_concurrent_cancelled_setup_shares_failure_until_a_new_generation(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        calls = []
        active_generation = GENERATION

        async def request(method, params):
            calls.append(method)
            if method == SANDBOX_SETUP_METHOD:
                bootstrap.completed(
                    {
                        "mode": SANDBOX_MODE,
                        "success": False,
                        "error": "orchestrator_helper_launch_canceled:1223",
                    },
                    active_generation,
                )
                return {"started": True}
            return {"status": "updateRequired"}

        results = await asyncio.gather(
            bootstrap.ensure_ready(request, Path.cwd(), GENERATION),
            bootstrap.ensure_ready(request, Path.cwd(), GENERATION),
            return_exceptions=True,
        )
        self.assertTrue(all(isinstance(result, AppServerError) for result in results))
        self.assertEqual([result.safe_error for result in results], [SANDBOX_CANCELLED_ERROR] * 2)
        self.assertEqual(calls.count(SANDBOX_SETUP_METHOD), 1)
        active_generation += 1
        with self.assertRaises(AppServerError):
            await bootstrap.ensure_ready(request, Path.cwd(), active_generation)
        self.assertEqual(calls.count(SANDBOX_SETUP_METHOD), 2)

    async def test_execution_check_normalizes_failure_without_guessing_native_message(self) -> None:
        for failure, expected in (
            (
                AppServerError(
                    "arbitrary rejection",
                    safe_error="runtime_rpc_rejected",
                    method=SANDBOX_EXECUTION_METHOD,
                    generation=GENERATION,
                    rpc_code=-32600,
                    rpc_latency_ms=29,
                ),
                SANDBOX_SETUP_ERROR,
            ),
            (
                AppServerError(
                    "transport ended",
                    safe_error="runtime_transport_lost",
                    method=SANDBOX_EXECUTION_METHOD,
                    generation=GENERATION,
                    rpc_code=-32603,
                    rpc_latency_ms=29,
                    retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                ),
                SANDBOX_UNKNOWN_ERROR,
            ),
            (TimeoutError(), SANDBOX_UNKNOWN_ERROR),
        ):
            bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
            with (
                patch("scholarseed_codex.sandbox.sys.platform", "win32"),
                patch("scholarseed_codex.sandbox._system_directory", return_value=Path.cwd()),
            ):
                with self.assertRaises(AppServerError) as raised:
                    await bootstrap.ensure_execution_ready(AsyncMock(side_effect=failure))
            self.assertEqual(raised.exception.safe_error, expected)
            self.assertEqual(raised.exception.method, SANDBOX_EXECUTION_METHOD)
            if isinstance(failure, AppServerError):
                self.assertEqual(raised.exception.rpc_code, failure.rpc_code)
                self.assertEqual(raised.exception.rpc_latency_ms, failure.rpc_latency_ms)
                self.assertEqual(raised.exception.generation, failure.generation)
            if expected == SANDBOX_UNKNOWN_ERROR:
                self.assertIs(raised.exception.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)

    async def test_execution_check_does_not_convert_caller_cancellation(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        with (
            patch("scholarseed_codex.sandbox.sys.platform", "win32"),
            patch("scholarseed_codex.sandbox._system_directory", return_value=Path.cwd()),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await bootstrap.ensure_execution_ready(
                    AsyncMock(side_effect=asyncio.CancelledError())
                )

    async def test_cleanup_failure_does_not_replace_initialization_or_cancellation(self) -> None:
        cleanup_error = RuntimeError("cleanup failed")
        for initial in (
            AppServerError("cancelled setup", safe_error=SANDBOX_CANCELLED_ERROR),
            asyncio.CancelledError(),
        ):
            bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
            with patch.object(bootstrap, "_ensure_ready", AsyncMock(side_effect=initial)):
                with self.assertRaises(type(initial)) as raised:
                    await bootstrap.ensure_ready(
                        AsyncMock(),
                        Path.cwd(),
                        GENERATION,
                        cleanup=AsyncMock(side_effect=cleanup_error),
                    )
            self.assertIs(raised.exception, initial)
            self.assertIs(raised.exception.__cause__, cleanup_error)

    async def test_failed_launch_preserves_sandbox_failure_when_process_wait_fails(self) -> None:
        for cancelled in (False, True):
            with self.subTest(cancelled=cancelled):
                host = CodexProcessHost(executable="codex", launch_arguments=(SANDBOX_ARGUMENT,))
                cleanup_error = OSError("process wait failed")
                process = SimpleNamespace(
                    pid=1,
                    stdin=Mock(),
                    returncode=None,
                    wait=AsyncMock(side_effect=cleanup_error),
                )
                calls = []

                async def request(method, params, **kwargs):
                    calls.append(method)
                    if method == SANDBOX_READINESS_METHOD:
                        return {"status": "updateRequired"}
                    if method == SANDBOX_SETUP_METHOD:
                        if cancelled:
                            raise asyncio.CancelledError()
                        host._sandbox.completed(
                            {
                                "mode": SANDBOX_MODE,
                                "success": False,
                                "error": "orchestrator_helper_launch_canceled:1223",
                            },
                            host._generation,
                        )
                        return {"started": True}
                    return {}

                spawn = AsyncMock(return_value=process)
                with (
                    patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn),
                    patch.object(host, "_read_stdout", AsyncMock()),
                    patch.object(host, "_drain_stderr", AsyncMock()),
                    patch.object(host, "_notify", AsyncMock()),
                    patch.object(host, "_request_connected", side_effect=request),
                    patch.object(host._sandbox, "verify_initialization_permissions", AsyncMock()),
                ):
                    with self.assertRaises(
                        asyncio.CancelledError if cancelled else AppServerError
                    ) as raised:
                        await host._launch_process()
                    await asyncio.gather(host._reader_task, host._stderr_task)
                    self.assertIs(raised.exception.__cause__, cleanup_error)
                    if not cancelled:
                        self.assertEqual(raised.exception.safe_error, SANDBOX_CANCELLED_ERROR)
                    self.assertIs(host.state, CodexProcessState.CRASHED)
                    self.assertIs(host._proc, process)
                    self.assertFalse(host.reusable)
                    self.assertEqual(process.wait.await_count, 2)
                    self.assertNotIn(
                        RuntimeProcessEventKind.EXITED,
                        [event.kind for event in host._process_events],
                    )
                    with self.assertRaises(AppServerError) as blocked:
                        await host.start()
                    self.assertEqual(blocked.exception.safe_error, "agent_runtime_unavailable")
                self.assertEqual(calls.count(SANDBOX_SETUP_METHOD), 1)
                spawn.assert_awaited_once()

    async def test_recovery_cleanup_failure_projects_sandbox_cause_to_all_threads(self) -> None:
        for safe_error, retryability in (
            (SANDBOX_CANCELLED_ERROR, RuntimeRetryability.USER_RETRYABLE),
            (SANDBOX_UNKNOWN_ERROR, RuntimeRetryability.UNKNOWN_OUTCOME),
        ):
            with self.subTest(safe_error=safe_error):
                host = CodexProcessHost(
                    max_recovery_attempts=3,
                    recovery_initial_delay=0,
                    recovery_max_delay=0,
                    recovery_jitter_ratio=0,
                )
                host._generation = GENERATION
                host._threads = {name: SimpleNamespace() for name in ("first", "second")}
                host._emitter.incident = AsyncMock()
                process = SimpleNamespace(
                    pid=1,
                    stdin=Mock(),
                    returncode=1,
                    wait=AsyncMock(side_effect=OSError("process wait failed")),
                )
                failure = AppServerError(
                    "sandbox initialization failed",
                    safe_error=safe_error,
                    retryability=retryability,
                    method=SANDBOX_EXECUTION_METHOD,
                    rpc_code=-32603,
                )

                async def start():
                    host._proc = process
                    raise failure

                host._start_process = AsyncMock(side_effect=start)
                original = self.recovery_incident()
                await host._recover_process(original)
                host._start_process.assert_awaited_once()
                self.assertIs(host._proc, process)
                self.assertFalse(host.reusable)
                self.assertIs(host.state, CodexProcessState.UNAVAILABLE)
                failed = [
                    call.args
                    for call in host._emitter.incident.await_args_list
                    if call.args[1].state == RuntimeIncidentState.FAILED
                ]
                self.assertEqual(len(failed), len(host._threads))
                for thread, incident in failed:
                    self.assertIn(thread, host._threads.values())
                    self.assertEqual(incident.incident_id, original.incident_id)
                    self.assertEqual(incident.safe_error, safe_error)
                    self.assertIs(incident.retryability, retryability)
                    self.assertEqual(incident.rpc_method, SANDBOX_EXECUTION_METHOD)
                    self.assertEqual(incident.rpc_code, -32603)
                    self.assertTrue(incident.ambiguous_commit)

    async def test_recovery_does_not_reuse_process_after_unconfirmed_launch_cleanup(self) -> None:
        for expected_error in (None, SANDBOX_CANCELLED_ERROR, SANDBOX_UNKNOWN_ERROR):
            with self.subTest(expected_error=expected_error):
                host = CodexProcessHost(
                    launch_arguments=(SANDBOX_ARGUMENT,),
                    max_recovery_attempts=3,
                    recovery_initial_delay=0,
                    recovery_max_delay=0,
                    recovery_jitter_ratio=0,
                )
                host._threads = {
                    name: SimpleNamespace(
                        thread_id=name,
                        attachment_state=CodexThreadAttachmentState.BROKEN,
                        attachment_incident=None,
                    )
                    for name in ("first", "second")
                }
                host._emitter.incident = AsyncMock()
                process = SimpleNamespace(
                    pid=1,
                    stdin=Mock(),
                    returncode=None,
                    wait=AsyncMock(side_effect=OSError("process wait failed")),
                )
                calls = []

                async def request(method, params, **kwargs):
                    calls.append(method)
                    if expected_error is None:
                        raise OSError("initialize failed")
                    if method == SANDBOX_READINESS_METHOD:
                        return {"status": "updateRequired"}
                    if method == SANDBOX_SETUP_METHOD:
                        if expected_error == SANDBOX_UNKNOWN_ERROR:
                            raise AppServerError(
                                "setup transport failed",
                                safe_error="runtime_transport_lost",
                                retryability=RuntimeRetryability.UNKNOWN_OUTCOME,
                            )
                        host._sandbox.completed(
                            {
                                "mode": SANDBOX_MODE,
                                "success": False,
                                "error": "orchestrator_helper_launch_canceled:1223",
                            },
                            host._generation,
                        )
                        return {"started": True}
                    return {}

                spawn = AsyncMock(return_value=process)
                resume = AsyncMock(return_value=True)
                with (
                    patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn),
                    patch.object(host, "_read_stdout", AsyncMock()),
                    patch.object(host, "_drain_stderr", AsyncMock()),
                    patch.object(host, "_notify", AsyncMock()),
                    patch.object(host, "_request_connected", side_effect=request),
                    patch.object(host._sandbox, "verify_initialization_permissions", AsyncMock()),
                    patch.object(host, "_resume_registered_threads", resume),
                ):
                    original = self.recovery_incident()
                    await host._recover_process(original)
                    await asyncio.gather(host._reader_task, host._stderr_task)
                spawn.assert_awaited_once()
                resume.assert_not_awaited()
                self.assertEqual(calls.count(SANDBOX_SETUP_METHOD), bool(expected_error))
                self.assertIs(host._proc, process)
                self.assertFalse(host.reusable)
                self.assertIs(host.state, CodexProcessState.UNAVAILABLE)
                self.assertEqual(
                    [call.args[1].state for call in host._emitter.incident.await_args_list],
                    [RuntimeIncidentState.RETRYING] * 2 + [RuntimeIncidentState.FAILED] * 2,
                )
                for call in host._emitter.incident.await_args_list[-2:]:
                    incident = call.args[1]
                    self.assertEqual(incident.safe_error, expected_error or original.safe_error)
                    self.assertTrue(incident.ambiguous_commit)
                    self.assertEqual(incident.vendor_turn_id, original.vendor_turn_id)
                    if expected_error == SANDBOX_UNKNOWN_ERROR:
                        self.assertIs(incident.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)
                self.assertNotIn(
                    RuntimeProcessEventKind.RECOVERED,
                    [event.kind for event in host._process_events],
                )

    async def test_thread_cleanup_does_not_start_a_new_process_after_disconnect(self) -> None:
        for suspend in (False, True):
            with self.subTest(suspend=suspend):
                host = CodexProcessHost()
                host._generation = GENERATION
                host.state = CodexProcessState.READY
                host._proc = Mock(returncode=None)
                turn = SimpleNamespace(replacement_sealed=False, close=AsyncMock())
                state = SimpleNamespace(
                    thread_id="cleanup-thread",
                    turn=turn,
                    permission_confirmation=None,
                    attachment_state=CodexThreadAttachmentState.ATTACHED,
                )
                host._threads[state.thread_id] = state
                start = AsyncMock(side_effect=AssertionError("cleanup must not start a process"))

                def disconnect(*args):
                    host._proc = None
                    host.state = CodexProcessState.CRASHED
                    if not suspend:
                        host._generation += 1
                    return ()

                with (
                    patch.object(host, "start", start),
                    patch.object(host, "suspend_blockers", side_effect=disconnect),
                    patch.object(host._watcher, "close", AsyncMock(side_effect=disconnect)),
                ):
                    with self.assertRaises(AppServerError) as raised:
                        if suspend:
                            await host.suspend_thread(state.thread_id, GENERATION)
                        else:
                            await host.close_thread(state.thread_id)
                self.assertEqual(raised.exception.safe_error, "runtime_transport_lost")
                self.assertEqual(raised.exception.generation, GENERATION)
                start.assert_not_awaited()
                if not suspend:
                    turn.close.assert_awaited_once_with(GENERATION, True)
                    self.assertEqual(host._unconfirmed_attachment_generations, {GENERATION})

    async def test_sandbox_resume_failure_is_not_an_automatic_retry(self) -> None:
        host = CodexProcessHost()
        state = SimpleNamespace(attachment_incident=None, thread_id="blocked")
        for safe_error, retryability in (
            (SANDBOX_CANCELLED_ERROR, RuntimeRetryability.USER_RETRYABLE),
            (SANDBOX_UNKNOWN_ERROR, RuntimeRetryability.UNKNOWN_OUTCOME),
        ):
            failure = AppServerError(
                "preparation failed",
                safe_error=safe_error,
                retryability=retryability,
                method=SANDBOX_EXECUTION_METHOD,
                rpc_code=-32603,
                rpc_latency_ms=23,
            )
            incident = host._resume_failure_incident(state, failure, GENERATION, True)
            self.assertIs(incident.state, RuntimeIncidentState.FAILED)
            self.assertIs(incident.retryability, retryability)
            self.assertIs(incident.strategy, RuntimeRecoveryStrategy.MANUAL_RETRY)
            self.assertEqual(incident.rpc_method, SANDBOX_EXECUTION_METHOD)
            self.assertEqual(incident.rpc_code, -32603)
            self.assertEqual(incident.rpc_latency_ms, 23)
            if retryability is RuntimeRetryability.UNKNOWN_OUTCOME:
                self.assertTrue(incident.ambiguous_commit)

    async def test_automatic_resume_skips_only_current_generation_sandbox_failure(self) -> None:
        host = CodexProcessHost()
        failure = host._resume_failure_incident(
            SimpleNamespace(attachment_incident=None, thread_id="blocked"),
            AppServerError("cancelled", safe_error=SANDBOX_CANCELLED_ERROR),
            GENERATION,
            True,
        )
        blocked = SimpleNamespace(
            thread_id="blocked",
            attachment_incident=failure,
            attachment_state=CodexThreadAttachmentState.BROKEN,
        )
        healthy = SimpleNamespace(
            thread_id="healthy",
            attachment_incident=None,
            attachment_state=CodexThreadAttachmentState.ATTACHING,
        )
        host._threads = {"blocked": blocked, "healthy": healthy}
        host._resume_thread = AsyncMock(return_value=True)
        self.assertTrue(await host._resume_registered_threads(GENERATION, self.recovery_incident()))
        self.assertEqual(host._resume_thread.await_count, 1)
        self.assertIs(host._resume_thread.await_args.args[0], healthy)
        host._resume_thread.reset_mock()
        self.assertTrue(
            await host._resume_registered_threads(GENERATION + 1, self.recovery_incident())
        )
        self.assertEqual(host._resume_thread.await_count, 2)

    async def test_manual_resume_can_recheck_a_cancelled_preparation(self) -> None:
        host = CodexProcessHost()
        failure = host._resume_failure_incident(
            SimpleNamespace(attachment_incident=None, thread_id="blocked"),
            AppServerError("cancelled", safe_error=SANDBOX_CANCELLED_ERROR),
            GENERATION,
            False,
        )
        state = SimpleNamespace(
            thread_id="blocked",
            attachment_incident=failure,
            attachment_state=CodexThreadAttachmentState.BROKEN,
        )
        host._threads = {"blocked": state}
        host._resume_thread = AsyncMock(return_value=True)
        self.assertTrue(await host._resume_registered_threads(GENERATION, None))
        host._resume_thread.assert_awaited_once()

    async def test_initial_execution_uses_only_unspent_setup_budget_once(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        loop = asyncio.get_running_loop()
        response_margin = 7.0
        base_timeout = SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + response_margin
        with patch.object(loop, "time", return_value=100.0) as clock:
            await bootstrap.ensure_ready(
                AsyncMock(return_value={"status": "ready"}), Path.cwd(), GENERATION
            )
            clock.return_value += 45.0
            self.assertEqual(
                bootstrap.initial_execution_timeout(GENERATION, response_margin),
                base_timeout + SANDBOX_SETUP_TIMEOUT_SECONDS - 45.0,
            )
            self.assertEqual(
                bootstrap.initial_execution_timeout(GENERATION, response_margin), base_timeout
            )

    async def test_initial_execution_budget_excludes_expired_or_other_generation(self) -> None:
        for expired, requested_generation in ((True, GENERATION), (False, GENERATION + 1)):
            with self.subTest(expired=expired, generation=requested_generation):
                bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
                loop = asyncio.get_running_loop()
                with patch.object(loop, "time", return_value=100.0) as clock:
                    await bootstrap.ensure_ready(
                        AsyncMock(return_value={"status": "ready"}), Path.cwd(), GENERATION
                    )
                    if expired:
                        clock.return_value += SANDBOX_SETUP_TIMEOUT_SECONDS + 1
                    self.assertEqual(
                        bootstrap.initial_execution_timeout(requested_generation, 7.0),
                        SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + 7.0,
                    )

    async def test_explicit_setup_consumes_the_same_initialization_budget(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        loop = asyncio.get_running_loop()
        with patch.object(loop, "time", return_value=100.0) as clock:

            async def request(method, params):
                if method == SANDBOX_SETUP_METHOD:
                    clock.return_value += 45.0
                    bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                    return {"started": True}
                return {"status": "ready" if clock.return_value > 100.0 else "updateRequired"}

            await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
            self.assertEqual(
                bootstrap.initial_execution_timeout(GENERATION, 7.0),
                SANDBOX_SETUP_TIMEOUT_SECONDS - 45.0 + SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + 7.0,
            )

    async def test_disabled_sandbox_does_not_allocate_setup_budget(self) -> None:
        bootstrap = WindowsSandboxBootstrap(())
        request = AsyncMock()
        await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
        request.assert_not_awaited()
        self.assertEqual(
            bootstrap.initial_execution_timeout(GENERATION, 7.0),
            SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + 7.0,
        )

    async def test_missing_setup_completion_has_bounded_unknown_outcome(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        cleanup = AsyncMock()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                return {"started": True}
            return {"status": "updateRequired"}

        with patch("scholarseed_codex.sandbox.SANDBOX_SETUP_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS):
            with self.assertRaises(AppServerError) as raised:
                await asyncio.wait_for(
                    bootstrap.ensure_ready(request, Path.cwd(), GENERATION, cleanup), 1.0
                )
        self.assertIs(raised.exception.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)
        cleanup.assert_awaited_once()
        replay = AsyncMock()
        with self.assertRaises(AppServerError):
            await bootstrap.ensure_ready(replay, Path.cwd(), GENERATION)
        replay.assert_not_awaited()
        self.assertEqual(
            bootstrap.initial_execution_timeout(GENERATION, 7.0),
            SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + 7.0,
        )

    async def test_host_initialization_refuses_disallowed_readonly_profile(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        for profiles in (
            [],
            [{"id": ":read-only", "allowed": False}],
            [{"id": ":workspace", "allowed": True}],
        ):
            request = AsyncMock(return_value={"data": profiles})
            with self.assertRaises(AppServerError):
                await bootstrap.verify_initialization_permissions(request, Path.cwd())
            request.assert_awaited_once_with(SANDBOX_PERMISSION_METHOD, {"cwd": str(Path.cwd())})
        await bootstrap.verify_initialization_permissions(
            AsyncMock(return_value={"data": [{"id": ":read-only", "allowed": True}]}), Path.cwd()
        )

    async def test_recovery_surrounds_native_setup_and_is_frozen(self) -> None:
        calls = []
        home = Path.cwd()

        async def prepare(actual_home, version, executable):
            self.assertEqual((actual_home, version), (home, "0.163.0"))
            self.assertEqual(executable, home / "codex.exe")
            calls.append("private")

        async def request(method, params):
            calls.append(method)
            return {"status": "ready"}

        recovery = Mock(prepare=AsyncMock(side_effect=prepare))
        bootstrap = WindowsSandboxBootstrap(
            (SANDBOX_ARGUMENT,),
            version="codex-cli 0.163.0",
            recovery=recovery,
            home=home,
            executable=home / "codex.exe",
        )
        await bootstrap.ensure_ready(request, home, GENERATION)
        self.assertEqual(calls, ["private", SANDBOX_READINESS_METHOD, "private"])
        provider = CodexRuntimeProvider()
        configuration = ProviderConfiguration("codex", sandbox_recovery=recovery)
        self.assertEqual(provider.configure(configuration).state, CommandState.APPLIED)
        self.assertEqual(provider.configure(configuration).state, CommandState.APPLIED)
        self.assertIs(provider._pool._sandbox_recovery, recovery)
        changed = ProviderConfiguration("codex", sandbox_recovery=Mock(prepare=AsyncMock()))
        self.assertEqual(provider.configure(changed).state, CommandState.REJECTED)

    async def test_private_recovery_failure_blocks_native_execution(self) -> None:
        for version in ("0.163.0", "0.165.0", "codex-cli 0.165.0"):
            for failure, expected in (
                (PermissionError("private detail"), SANDBOX_SETUP_ERROR),
                (SandboxRecoveryError(SANDBOX_POLICY_ERROR), SANDBOX_POLICY_ERROR),
                (SandboxRecoveryError(SANDBOX_CANCELLED_ERROR), SANDBOX_CANCELLED_ERROR),
                (SandboxRecoveryError("private detail"), SANDBOX_SETUP_ERROR),
            ):
                with self.subTest(version=version, expected=expected):
                    recovery = Mock(prepare=AsyncMock(side_effect=failure))
                    request, cleanup = AsyncMock(), AsyncMock()
                    bootstrap = WindowsSandboxBootstrap(
                        (SANDBOX_ARGUMENT,),
                        version=version,
                        recovery=recovery,
                        home=Path.cwd(),
                        executable=Path.cwd() / "codex.exe",
                    )
                    with self.assertRaises(AppServerError) as raised:
                        await bootstrap.ensure_ready(request, Path.cwd(), GENERATION, cleanup)
                    self.assertNotIn("private detail", str(raised.exception))
                    self.assertEqual(raised.exception.safe_error, expected)
                    request.assert_not_awaited()
                    cleanup.assert_awaited_once()

    async def test_only_exact_native_cancellation_gets_authorization_hint(self) -> None:
        for native_error, expected in (
            ("orchestrator_helper_launch_canceled: private detail", SANDBOX_CANCELLED_ERROR),
            ("orchestrator_helper_launch_failed: private detail", SANDBOX_SETUP_ERROR),
            ("private detail cancelled", SANDBOX_SETUP_ERROR),
        ):
            bootstrap = self.bootstrap()

            async def request(method, params):
                if method == SANDBOX_SETUP_METHOD:
                    bootstrap.completed(
                        {"mode": SANDBOX_MODE, "success": False, "error": native_error}, GENERATION
                    )
                    return {"started": True}
                return {"status": "updateRequired"}

            with self.assertRaises(AppServerError) as raised:
                await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
            self.assertEqual(raised.exception.safe_error, expected)
            self.assertNotIn("private detail", str(raised.exception))

    async def test_unreviewed_recovery_keeps_existing_native_startup(self) -> None:
        for version in ("0.159.0", "0.164.0", "0.166.0", "0.165.0-r1", "0.165.0\n"):
            recovery = Mock(prepare=AsyncMock())
            request = AsyncMock(return_value={"status": "ready"})
            bootstrap = WindowsSandboxBootstrap(
                (SANDBOX_ARGUMENT,), version=version, recovery=recovery
            )
            await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
            recovery.prepare.assert_not_awaited()
            request.assert_awaited_once_with(SANDBOX_READINESS_METHOD, None)

    async def test_control_host_never_prepares_private_sandbox(self) -> None:
        recovery = Mock(prepare=AsyncMock())
        await WindowsSandboxBootstrap((), recovery=recovery).ensure_ready(
            AsyncMock(), Path.cwd(), GENERATION
        )
        recovery.prepare.assert_not_awaited()

    async def test_native_failure_diagnostic_is_visible_and_redacted(self) -> None:
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        secret = "token=secret-value C:\\Users\\private\\file\nhttps://example.test/?key=secret"
        native_error = "orchestrator_helper_incomplete: " + secret
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger = LOGGER
        previous = logger.level
        logger.setLevel(logging.INFO)
        logger.addHandler(handler)

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                bootstrap.completed(
                    {"mode": SANDBOX_MODE, "success": False, "error": native_error},
                    GENERATION,
                )
                return {"started": True}
            return {"status": "updateRequired"}

        try:
            with self.assertRaises(AppServerError) as raised:
                await bootstrap.ensure_ready(request, Path.cwd(), GENERATION, pid=4321)
        finally:
            logger.removeHandler(handler)
            logger.setLevel(previous)
        text = output.getvalue()
        self.assertNotIn(secret, text + str(raised.exception))
        self.assertNotIn("secret-value", text)
        events = [json.loads(line.split(" ", 1)[1]) for line in text.splitlines()]
        completed = next(event for event in events if event["event"] == "completion")
        self.assertEqual(completed["native_code"], "orchestrator_helper_incomplete")
        self.assertEqual(completed["pid"], 4321)
        self.assertEqual(completed["generation"], GENERATION)
        self.assertEqual(len(completed["error_sha256"]), 64)
        self.assertEqual(len({event["setup_attempt_id"] for event in events}), 1)
        self.assertEqual(events[-1]["event"], "failed")
        self.assertEqual(events[-1]["stage"], "completion")

    async def test_failure_stages_and_cleanup_are_correlated(self) -> None:
        for responses, stage in (
            ([{"status": {"secret": "private"}}], "readiness"),
            ([{"status": "updateRequired"}, {"started": "private"}], "setup_start"),
            ([RuntimeError("private RPC detail")], "readiness"),
        ):
            with self.subTest(stage=stage):
                cleanup = AsyncMock()
                with self.assertLogs(LOGGER, level="INFO") as logs:
                    with self.assertRaises(Exception):
                        await self.bootstrap().ensure_ready(
                            AsyncMock(side_effect=responses),
                            Path.cwd(),
                            GENERATION,
                            cleanup,
                            pid=789,
                        )
                events = [
                    json.loads(record.getMessage().split(" ", 1)[1]) for record in logs.records
                ]
                self.assertEqual(events[-1]["event"], "failed")
                self.assertEqual(events[-1]["stage"], stage)
                self.assertEqual(events[-1]["pid"], 789)
                self.assertNotIn("private", "".join(logs.output))
                cleanup.assert_awaited_once()

    async def test_unknown_native_payloads_are_bounded(self) -> None:
        for error in ("unknown_code: token=private\r\n" * 10000, {"token": ["private"]}):
            bootstrap = self.bootstrap()

            async def request(method, params):
                if method == SANDBOX_SETUP_METHOD:
                    bootstrap.completed(
                        {"mode": "private", "success": "private", "error": error}, GENERATION
                    )
                    return {"started": True}
                return {"status": "updateRequired"}

            with self.assertLogs(LOGGER, level="INFO") as logs:
                with self.assertRaises(AppServerError):
                    await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
            text = "".join(logs.output)
            self.assertNotIn("private", text)
            self.assertLess(len(text), 4000)
            events = [json.loads(record.getMessage().split(" ", 1)[1]) for record in logs.records]
            completed = next(event for event in events if event["event"] == "completion")
            self.assertEqual(completed["native_code"], "unknown")
            self.assertEqual(completed["success"], "unknown")

    async def test_terminal_diagnostic_stages(self) -> None:
        for scenario, expected_event, expected_stage in (
            ("timeout", "timeout", "setup_start"),
            ("cancel", "cancelled", "completion"),
            ("disconnect", "failed", "completion"),
            ("readback", "failed", "readback"),
        ):
            with self.subTest(scenario=scenario):
                bootstrap = self.bootstrap()
                entered = asyncio.Event()
                cleanup = AsyncMock()

                async def request(method, params):
                    if method == SANDBOX_SETUP_METHOD:
                        entered.set()
                        if scenario == "timeout":
                            raise TimeoutError()
                        if scenario == "disconnect":
                            bootstrap.disconnected(GENERATION)
                        elif scenario == "readback":
                            bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                        return {"started": True}
                    return {"status": "updateRequired"}

                with self.assertLogs(LOGGER, level="INFO") as logs:
                    with patch(
                        "scholarseed_codex.sandbox.SANDBOX_SETUP_TIMEOUT_SECONDS",
                        TEST_TIMEOUT_SECONDS,
                    ):
                        task = asyncio.create_task(
                            bootstrap.ensure_ready(
                                request, Path.cwd(), GENERATION, cleanup, pid=456
                            )
                        )
                        await entered.wait()
                        if scenario == "cancel":
                            task.cancel()
                        with self.assertRaises(
                            asyncio.CancelledError if scenario == "cancel" else AppServerError
                        ):
                            await task
                events = [
                    json.loads(record.getMessage().split(" ", 1)[1]) for record in logs.records
                ]
                self.assertEqual(events[-1]["event"], expected_event)
                self.assertEqual(events[-1]["stage"], expected_stage)
                self.assertEqual(events[-1]["pid"], 456)
                cleanup.assert_awaited_once()

    def test_provider_freezes_resource_port(self) -> None:
        provider = CodexRuntimeProvider()
        resources = Mock(prepare=AsyncMock())
        configuration = ProviderConfiguration("codex", sandbox_resources=resources)
        self.assertEqual(provider.configure(configuration).state, CommandState.APPLIED)
        self.assertEqual(provider.configure(configuration).state, CommandState.APPLIED)
        self.assertIs(provider._pool._sandbox_resources, resources)
        changed = ProviderConfiguration("codex", sandbox_resources=Mock(prepare=AsyncMock()))
        self.assertEqual(provider.configure(changed).state, CommandState.REJECTED)

    async def test_ready_still_prepares_fixed_resources(self) -> None:
        for version in (
            "0.159.0",
            "codex-cli 0.159.0",
            "0.163.0",
            "codex-cli 0.163.0",
            "0.165.0",
            "codex-cli 0.165.0",
        ):
            with self.subTest(version=version):
                resources = Mock(prepare=AsyncMock())
                bootstrap = WindowsSandboxBootstrap(
                    (SANDBOX_ARGUMENT,), resources=resources, version=version
                )
                request = AsyncMock(return_value={"status": "ready"})
                await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
                await bootstrap.ensure_ready(request, Path.cwd(), GENERATION + 1)
                self.assertEqual(resources.prepare.await_count, 2)
                resources.prepare.assert_awaited_with(SANDBOX_USERS_GROUP, cwd=Path.cwd())

    async def test_current_runtime_keeps_recovery_setup_and_resource_order(self) -> None:
        for version in ("0.165.0", "codex-cli 0.165.0"):
            with self.subTest(version=version):
                calls = []
                home = Path.cwd()
                executable = home / "codex.exe"
                ready = False

                async def prepare_private(actual_home, actual_version, actual_executable):
                    self.assertEqual(
                        (actual_home, actual_version, actual_executable),
                        (home, "0.165.0", executable),
                    )
                    calls.append("private")

                async def prepare_resources(group, *, cwd):
                    self.assertEqual((group, cwd), (SANDBOX_USERS_GROUP, home))
                    calls.append("resources")

                async def request(method, params):
                    nonlocal ready
                    calls.append(method)
                    if method == SANDBOX_SETUP_METHOD:
                        ready = True
                        bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                        return {"started": True}
                    return {"status": "ready" if ready else "updateRequired"}

                bootstrap = WindowsSandboxBootstrap(
                    (SANDBOX_ARGUMENT,),
                    version=version,
                    recovery=Mock(prepare=AsyncMock(side_effect=prepare_private)),
                    resources=Mock(prepare=AsyncMock(side_effect=prepare_resources)),
                    home=home,
                    executable=executable,
                )
                await bootstrap.ensure_ready(request, home, GENERATION)
                self.assertEqual(
                    calls,
                    [
                        "private",
                        SANDBOX_READINESS_METHOD,
                        SANDBOX_SETUP_METHOD,
                        SANDBOX_READINESS_METHOD,
                        "private",
                        "resources",
                    ],
                )

    async def test_native_setup_precedes_resource_preparation(self) -> None:
        resources = Mock(prepare=AsyncMock())
        bootstrap = WindowsSandboxBootstrap(
            (SANDBOX_ARGUMENT,), resources=resources, version="0.159.0"
        )
        ready = False

        async def request(method, params):
            nonlocal ready
            resources.prepare.assert_not_awaited()
            if method == SANDBOX_SETUP_METHOD:
                ready = True
                bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                return {"started": True}
            return {"status": "ready" if ready else "updateRequired"}

        await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
        resources.prepare.assert_awaited_once_with(SANDBOX_USERS_GROUP, cwd=Path.cwd())

    async def test_resource_failure_blocks_and_cleans_up(self) -> None:
        resources = Mock(prepare=AsyncMock(side_effect=PermissionError("denied")))
        bootstrap = WindowsSandboxBootstrap(
            (SANDBOX_ARGUMENT,), resources=resources, version="0.159.0"
        )
        cleanup = AsyncMock()
        with self.assertRaises(AppServerError) as raised:
            await bootstrap.ensure_ready(
                AsyncMock(return_value={"status": "ready"}), Path.cwd(), GENERATION, cleanup
            )
        self.assertEqual(raised.exception.safe_error, SANDBOX_RESOURCE_ERROR)
        cleanup.assert_awaited_once()

    async def test_unreviewed_version_cannot_modify_acls(self) -> None:
        for version in ("codex-cli 0.160.0", "0.164.0", "0.166.0", "0.165.0-r1", "0.165.0\n"):
            with self.subTest(version=version):
                resources = Mock(prepare=AsyncMock())
                recovery = Mock(prepare=AsyncMock())
                bootstrap = WindowsSandboxBootstrap(
                    (SANDBOX_ARGUMENT,), resources=resources, recovery=recovery, version=version
                )
                request = AsyncMock(return_value={"status": "ready"})
                cleanup = AsyncMock()
                with self.assertRaises(AppServerError) as raised:
                    await bootstrap.ensure_ready(request, Path.cwd(), GENERATION, cleanup)
                self.assertEqual(raised.exception.safe_error, SANDBOX_RESOURCE_ERROR)
                request.assert_not_awaited()
                resources.prepare.assert_not_awaited()
                recovery.prepare.assert_not_awaited()
                cleanup.assert_awaited_once()

    async def test_unrestricted_host_never_prepares_resources(self) -> None:
        resources = Mock(prepare=AsyncMock())
        await WindowsSandboxBootstrap((), resources=resources, version="0.159.0").ensure_ready(
            AsyncMock(), Path.cwd(), GENERATION
        )
        resources.prepare.assert_not_awaited()

    def test_windows_sandbox_supports_managed_networking(self) -> None:
        self.assertEqual(SANDBOX_MODE, "elevated")
        self.assertEqual(SANDBOX_ARGUMENT.value, 'windows.sandbox="elevated"')

    def test_only_windows_restricted_sessions_select_native_backend(self) -> None:
        for platform in ("win32", "darwin", "linux"):
            for policy in ("workspace-write", "read-only", "danger-full-access"):
                with self.subTest(platform=platform, policy=policy):
                    with patch("scholarseed_codex.sandbox.sys.platform", platform):
                        arguments = windows_sandbox_arguments(policy)
                    expected = platform == "win32" and policy != "danger-full-access"
                    self.assertEqual(bool(arguments), expected)
                    self.assertEqual(WindowsSandboxBootstrap(arguments).enabled, expected)

    def bootstrap(self) -> WindowsSandboxBootstrap:
        with patch("scholarseed_codex.sandbox.sys.platform", "win32"):
            return WindowsSandboxBootstrap(windows_sandbox_arguments("workspace-write"))

    async def test_disabled_does_not_call_native_rpc(self) -> None:
        request = AsyncMock()
        await WindowsSandboxBootstrap(()).ensure_ready(request, Path.cwd(), GENERATION)
        request.assert_not_awaited()

    async def test_ready_skips_setup(self) -> None:
        request = AsyncMock(return_value={"status": "ready"})
        await self.bootstrap().ensure_ready(request, Path.cwd(), GENERATION)
        request.assert_awaited_once_with(SANDBOX_READINESS_METHOD, None)

    async def test_shared_home_serializes_setup_and_rechecks_readiness(self) -> None:
        setup_lock = asyncio.Lock()
        first = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), setup_lock)
        second = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), setup_lock)
        entered = asyncio.Event()
        release = asyncio.Event()
        ready = False
        setup_calls = []

        async def request(method, params):
            nonlocal ready
            if method == SANDBOX_SETUP_METHOD:
                setup_calls.append(params)
                entered.set()
                await release.wait()
                ready = True
                first.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                return {"started": True}
            return {"status": "ready" if ready else "updateRequired"}

        first_task = asyncio.create_task(first.ensure_ready(request, Path.cwd(), GENERATION))
        await entered.wait()
        second_request = AsyncMock(side_effect=request)
        second_task = asyncio.create_task(
            second.ensure_ready(second_request, Path.cwd(), GENERATION)
        )
        await asyncio.sleep(0)
        second_request.assert_not_awaited()
        release.set()
        await asyncio.gather(first_task, second_task)
        self.assertEqual(len(setup_calls), 1)
        second_request.assert_awaited_once_with(SANDBOX_READINESS_METHOD, None)

    async def test_completion_before_start_response_is_not_lost(self) -> None:
        bootstrap = self.bootstrap()
        calls = []

        async def request(method, params):
            calls.append((method, params))
            if method == SANDBOX_SETUP_METHOD:
                bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                return {"started": True}
            return {"status": "updateRequired" if len(calls) == 1 else "ready"}

        await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
        self.assertEqual(
            [method for method, _ in calls],
            [SANDBOX_READINESS_METHOD, SANDBOX_SETUP_METHOD, SANDBOX_READINESS_METHOD],
        )
        self.assertEqual(calls[1][1], {"mode": SANDBOX_MODE, "cwd": str(Path.cwd())})

    async def test_cancelled_setup_keeps_lock_until_process_cleanup(self) -> None:
        setup_lock = asyncio.Lock()
        first = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), setup_lock)
        second = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), setup_lock)
        entered = asyncio.Event()
        cleanup_entered = asyncio.Event()
        process_exited = asyncio.Event()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                entered.set()
                return {"started": True}
            return {"status": "updateRequired"}

        async def cleanup():
            cleanup_entered.set()
            await process_exited.wait()

        first_task = asyncio.create_task(
            first.ensure_ready(request, Path.cwd(), GENERATION, cleanup)
        )
        await entered.wait()
        first_task.cancel()
        await cleanup_entered.wait()
        second_request = AsyncMock(return_value={"status": "ready"})
        second_task = asyncio.create_task(
            second.ensure_ready(second_request, Path.cwd(), GENERATION)
        )
        await asyncio.sleep(0)
        second_request.assert_not_awaited()
        process_exited.set()
        with self.assertRaises(asyncio.CancelledError):
            await first_task
        await second_task
        second_request.assert_awaited_once()

    async def test_ui_timeout_does_not_cancel_native_completion(self) -> None:
        entered = asyncio.Event()
        bootstrap = self.bootstrap()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                entered.set()
                return {"started": True}
            return {"status": "updateRequired" if not entered.is_set() else "ready"}

        task = asyncio.create_task(bootstrap.ensure_ready(request, Path.cwd(), GENERATION))
        await entered.wait()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(task), TEST_TIMEOUT_SECONDS)
        self.assertFalse(task.done())
        bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
        await task

    async def test_failure_and_wrong_generation_cannot_mark_ready(self) -> None:
        for notification in (
            {"mode": SANDBOX_MODE, "success": False, "error": "sensitive native detail"},
            {"mode": SANDBOX_MODE, "success": "true"},
        ):
            bootstrap = self.bootstrap()

            async def request(method, params):
                if method == SANDBOX_SETUP_METHOD:
                    bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION - 1)
                    bootstrap.completed(notification, GENERATION)
                    return {"started": True}
                return {"status": "updateRequired"}

            with self.assertRaises(AppServerError) as raised:
                await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
            self.assertNotIn("sensitive native detail", str(raised.exception))

    async def test_disconnect_unblocks_setup(self) -> None:
        bootstrap = self.bootstrap()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                bootstrap.disconnected(GENERATION)
                return {"started": True}
            return {"status": "updateRequired"}

        with self.assertRaisesRegex(AppServerError, "disconnected"):
            await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)

        replay = AsyncMock(return_value={"status": "updateRequired"})
        with self.assertRaises(AppServerError) as raised:
            await bootstrap.ensure_ready(replay, Path.cwd(), GENERATION)
        self.assertIs(raised.exception.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)
        self.assertEqual(raised.exception.safe_error, "windows_sandbox_setup_unknown")
        replay.assert_not_awaited()
        reopened = AsyncMock(return_value={"status": "ready"})
        await bootstrap.ensure_ready(reopened, Path.cwd(), GENERATION + 1)
        reopened.assert_awaited_once_with(SANDBOX_READINESS_METHOD, None)

    async def test_protocol_failures_do_not_fall_back(self) -> None:
        for responses in (
            [{"status": "unknown"}],
            [{"status": "notConfigured"}],
            [{"status": "updateRequired"}, {"started": False}],
        ):
            with self.subTest(responses=responses):
                request = AsyncMock(side_effect=responses)
                with self.assertRaises(AppServerError):
                    await self.bootstrap().ensure_ready(request, Path.cwd(), GENERATION)

    async def test_success_notification_requires_ready_readback(self) -> None:
        bootstrap = self.bootstrap()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
                return {"started": True}
            return {"status": "updateRequired"}

        with self.assertRaises(AppServerError):
            await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)

    async def test_cancellation_clears_waiter_and_allows_next_generation(self) -> None:
        bootstrap = self.bootstrap()
        started = asyncio.Event()

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                started.set()
                return {"started": True}
            return {"status": "updateRequired"}

        task = asyncio.create_task(bootstrap.ensure_ready(request, Path.cwd(), GENERATION))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        bootstrap.completed({"mode": SANDBOX_MODE, "success": True}, GENERATION)
        ready = AsyncMock(return_value={"status": "ready"})
        await bootstrap.ensure_ready(ready, Path.cwd(), GENERATION + 1)
        ready.assert_awaited_once()

    async def test_host_consumes_completion_for_current_generation(self) -> None:
        bootstrap = self.bootstrap()
        host = CodexProcessHost(executable="codex")
        host._sandbox = bootstrap
        host._generation = GENERATION

        async def request(method, params):
            if method == SANDBOX_SETUP_METHOD:
                await host._handle_notification(
                    SANDBOX_COMPLETED_METHOD,
                    {"mode": SANDBOX_MODE, "success": True},
                    generation=GENERATION - 1,
                )
                await host._handle_notification(
                    SANDBOX_COMPLETED_METHOD,
                    {"mode": SANDBOX_MODE, "success": False},
                    generation=GENERATION,
                )
                return {"started": True}
            return {"status": "updateRequired"}

        with self.assertRaises(AppServerError):
            await bootstrap.ensure_ready(request, Path.cwd(), GENERATION)
        self.assertFalse(host._protocol_errors)

    async def test_process_is_not_ready_until_sandbox_is_ready(self) -> None:
        with patch("scholarseed_codex.sandbox.sys.platform", "win32"):
            arguments = windows_sandbox_arguments("workspace-write")
        host = CodexProcessHost(executable="codex", launch_arguments=arguments)
        process = Mock(returncode=None)
        calls = []

        async def request(method, params, **kwargs):
            calls.append(method)
            self.assertEqual(host.state, CodexProcessState.STARTING)
            if method == SANDBOX_PERMISSION_METHOD:
                return {"data": [{"id": ":read-only", "allowed": True}]}
            if method == SANDBOX_EXECUTION_METHOD:
                self.assertGreater(
                    kwargs["timeout"], SANDBOX_EXECUTION_TIMEOUT_MS / 1000 + host.rpc_timeout
                )
                self.assertLessEqual(
                    kwargs["timeout"],
                    SANDBOX_SETUP_TIMEOUT_SECONDS
                    + SANDBOX_EXECUTION_TIMEOUT_MS / 1000
                    + host.rpc_timeout,
                )
                self.assertEqual(params["timeoutMs"], SANDBOX_EXECUTION_TIMEOUT_MS)
                self.assertEqual(
                    params["sandboxPolicy"], {"type": "readOnly", "networkAccess": False}
                )
                self.assertEqual(params["command"][1:], ["/d", "/c", "exit", "0"])
                return {"exitCode": 0}
            return {"status": "ready"} if method == SANDBOX_READINESS_METHOD else {}

        with (
            patch(
                "scholarseed_codex.process.asyncio.create_subprocess_exec",
                AsyncMock(return_value=process),
            ),
            patch.object(host, "_read_stdout", AsyncMock()),
            patch.object(host, "_drain_stderr", AsyncMock()),
            patch.object(host, "_notify", AsyncMock()),
            patch.object(host, "_request_connected", side_effect=request),
        ):
            await host.start()
            await asyncio.gather(host._reader_task, host._stderr_task)
        self.assertEqual(
            calls,
            ["initialize", SANDBOX_PERMISSION_METHOD, SANDBOX_READINESS_METHOD]
            + ([SANDBOX_EXECUTION_METHOD] if sys.platform == "win32" else []),
        )
        self.assertEqual(host.state, CodexProcessState.READY)

    async def test_host_launch_pins_readonly_after_supplied_arguments(self) -> None:
        host = CodexProcessHost(
            executable="codex",
            launch_arguments=(
                SANDBOX_ARGUMENT,
                type(SANDBOX_ARGUMENT)(option="-c", value='default_permissions=":workspace"'),
            ),
        )
        spawn = AsyncMock(side_effect=OSError("stop before launch"))
        with patch("scholarseed_codex.process.asyncio.create_subprocess_exec", spawn):
            with self.assertRaisesRegex(OSError, "stop before launch"):
                await host._launch_process()
        self.assertEqual(spawn.call_args.args[-2:], ("-c", SANDBOX_READONLY_ARGUMENT.value))

    async def test_recovery_home_matches_effective_native_environment(self) -> None:
        inherited = Path.cwd() / "inherited"
        explicit = Path.cwd() / "explicit"
        for environment, removed, expected in (
            ({}, (), inherited),
            ({"CODEX_HOME": str(explicit)}, (), explicit),
            ({}, ("CODEX_HOME",), CODEX_RUNTIME_HOME),
        ):
            with self.subTest(expected=expected):
                recovery = Mock(prepare=AsyncMock())
                host = CodexProcessHost(
                    executable=str(Path.cwd() / "codex.exe"),
                    version="0.163.0",
                    launch_arguments=(SANDBOX_ARGUMENT,),
                    sandbox_recovery=recovery,
                    process_environment=environment,
                    remove_environment=removed,
                    launch_environment={} if removed else {"CODEX_HOME": str(expected)},
                )
                process = Mock(returncode=None)
                with (
                    patch.dict("os.environ", {"CODEX_HOME": str(inherited)}),
                    patch(
                        "scholarseed_codex.process.asyncio.create_subprocess_exec",
                        AsyncMock(return_value=process),
                    ),
                    patch.object(host, "_read_stdout", AsyncMock()),
                    patch.object(host, "_drain_stderr", AsyncMock()),
                    patch.object(host, "_notify", AsyncMock()),
                    patch.object(
                        host, "_request_connected", AsyncMock(return_value={"status": "ready"})
                    ),
                    patch.object(host._sandbox, "ensure_execution_ready", AsyncMock()),
                    patch.object(host._sandbox, "verify_initialization_permissions", AsyncMock()),
                ):
                    await host.start()
                    await asyncio.gather(host._reader_task, host._stderr_task)
                self.assertEqual(recovery.prepare.await_count, 2)
                recovery.prepare.assert_awaited_with(expected, "0.163.0", Path(host.executable))

    async def test_failed_bootstrap_discards_process(self) -> None:
        with patch("scholarseed_codex.sandbox.sys.platform", "win32"):
            arguments = windows_sandbox_arguments("read-only")
        host = CodexProcessHost(executable="codex", launch_arguments=arguments)
        process = Mock(returncode=None)

        async def discard_process(discarded, generation):
            self.assertIs(discarded, host._proc)
            self.assertEqual(generation, GENERATION)
            host._proc = None

        with (
            patch(
                "scholarseed_codex.process.asyncio.create_subprocess_exec",
                AsyncMock(return_value=process),
            ),
            patch.object(host, "_read_stdout", AsyncMock()),
            patch.object(host, "_drain_stderr", AsyncMock()),
            patch.object(host, "_notify", AsyncMock()),
            patch.object(
                host, "_request_connected", AsyncMock(side_effect=[{}, {"status": "notConfigured"}])
            ),
            patch.object(
                host, "_discard_process", AsyncMock(side_effect=discard_process)
            ) as discard,
        ):
            with self.assertRaises(AppServerError):
                await host.start()
            await asyncio.gather(host._reader_task, host._stderr_task)
        discard.assert_awaited_once_with(process, GENERATION)
        self.assertEqual(host.state, CodexProcessState.CRASHED)


class StartupCoordinationContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.mutex_name = "Global\\ScholarSeed.Startup.Test." + uuid.uuid4().hex
        coordination = patch("scholarseed_codex.mutex.STARTUP_MUTEX", self.mutex_name)
        coordination.start()
        self.addCleanup(coordination.stop)

    async def test_shared_execution_readiness_does_not_consume_thread_resources(self):
        resources = Mock()
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), resources=resources)
        request = AsyncMock(return_value={"exitCode": 0})
        system = Path.cwd() / "system"
        with (
            patch("scholarseed_codex.sandbox.sys.platform", "win32"),
            patch("scholarseed_codex.sandbox._system_directory", return_value=system),
        ):
            await bootstrap.ensure_execution_ready(request)
        parameters = request.call_args.args[1]
        self.assertEqual(parameters["cwd"], str(system))
        self.assertEqual(parameters["sandboxPolicy"], {"type": "readOnly", "networkAccess": False})
        resources.prepare.assert_not_called()
        resources.verification.assert_not_called()

    async def test_thread_preflight_keeps_each_workspace_and_permission(self):
        observations = []

        @asynccontextmanager
        async def verification(cwd, *, writable):
            observations.append((cwd, writable))
            yield (SandboxProbe("python", ("frozen-python.exe",)),)

        @asynccontextmanager
        async def mutex():
            yield

        resources = Mock(prepare=AsyncMock(), verification=verification, validate_probe=AsyncMock())
        host = CodexProcessHost(
            version="0.165.0", launch_arguments=(SANDBOX_ARGUMENT,), sandbox_resources=resources
        )
        host._proc = Mock(returncode=None)
        host._generation = GENERATION
        host.state = CodexProcessState.READY
        request = AsyncMock(return_value={"exitCode": 0, "stdout": "verified"})
        with (
            patch("scholarseed_codex.sandbox.sys.platform", "win32"),
            patch(
                "scholarseed_codex.sandbox._system_directory", return_value=Path.cwd() / "system"
            ),
            patch("scholarseed_codex.process.startup_mutex", mutex),
            patch.object(host, "_request_connected", request),
        ):
            for mode in ("read-only", "workspace-write"):
                workspace = Path.cwd() / mode
                await host._prepare_thread_resources(
                    CodexSessionOpenRequest(
                        request_id=mode,
                        runtime_id=mode,
                        cwd=workspace,
                        sandbox=mode,
                        writable_roots=(Path.cwd() / "extra",),
                        network_access=True,
                    ),
                    GENERATION,
                )
        self.assertEqual(
            observations,
            [(Path.cwd() / "read-only", False), (Path.cwd() / "workspace-write", True)],
        )
        self.assertEqual(resources.prepare.await_count, 2)
        self.assertEqual(resources.validate_probe.await_count, 2)
        self.assertEqual(request.await_count, 4)
        for index, mode in enumerate(("readOnly", "workspaceWrite")):
            parameters = request.await_args_list[index * 2 + 1].args[1]
            self.assertEqual(parameters["sandboxPolicy"]["type"], mode)
            self.assertFalse(parameters["sandboxPolicy"]["networkAccess"])
            self.assertNotIn("outputBytesCap", parameters)
            self.assertEqual(
                request.await_args_list[index * 2 + 1].kwargs["generation"], GENERATION
            )
        self.assertEqual(
            request.await_args_list[3].args[1]["sandboxPolicy"]["writableRoots"],
            [str(Path.cwd() / "workspace-write"), str(Path.cwd() / "extra")],
        )
        self.assertEqual(host.state, CodexProcessState.READY)
        host._generation += 1
        with self.assertRaises(AppServerError):
            request.await_args_list[-1].kwargs["before_write"]()

    async def test_thread_preflight_failure_never_closes_shared_host(self):
        @asynccontextmanager
        async def mutex():
            yield

        for failure in ("permission", "generation"):
            with self.subTest(failure=failure):
                resources = Mock(prepare=AsyncMock())
                host = CodexProcessHost(
                    version="0.165.0",
                    launch_arguments=(SANDBOX_ARGUMENT,),
                    sandbox_resources=resources,
                )
                process = Mock(returncode=None)
                host._proc = process
                host._generation = GENERATION
                host.state = CodexProcessState.READY

                async def prepare(*args, **kwargs):
                    if failure == "permission":
                        raise PermissionError("denied")
                    host._generation += 1

                resources.prepare.side_effect = prepare
                request = AsyncMock()
                with (
                    patch("scholarseed_codex.process.startup_mutex", mutex),
                    patch.object(host, "_request_connected", request),
                ):
                    with self.assertRaises(AppServerError):
                        await host._prepare_thread_resources(
                            CodexSessionOpenRequest(
                                request_id=failure, runtime_id=failure, cwd=Path.cwd()
                            ),
                            GENERATION,
                        )
                request.assert_not_awaited()
                self.assertIs(host._proc, process)
                self.assertIsNone(process.returncode)
                self.assertEqual(host.state, CodexProcessState.READY)

    async def test_thread_preflight_cancellation_drains_probe_without_closing_host(self):
        entered, finish = asyncio.Event(), asyncio.Event()

        @asynccontextmanager
        async def verification(cwd, *, writable):
            yield (SandboxProbe("python", ("frozen-python.exe",)),)

        @asynccontextmanager
        async def mutex():
            yield

        resources = Mock(prepare=AsyncMock(), verification=verification, validate_probe=AsyncMock())
        host = CodexProcessHost(
            version="0.165.0", launch_arguments=(SANDBOX_ARGUMENT,), sandbox_resources=resources
        )
        process = Mock(returncode=None)
        host._proc = process
        host._generation = GENERATION
        host.state = CodexProcessState.READY

        async def request(method, parameters, **kwargs):
            kwargs["before_write"]()
            if parameters["command"] == ["frozen-python.exe"]:
                entered.set()
                await finish.wait()
            return {"exitCode": 0}

        with (
            patch("scholarseed_codex.sandbox.sys.platform", "win32"),
            patch("scholarseed_codex.sandbox._system_directory", return_value=Path.cwd()),
            patch("scholarseed_codex.process.startup_mutex", mutex),
            patch.object(host, "_request_connected", request),
        ):
            preparation = asyncio.create_task(
                host._prepare_thread_resources(
                    CodexSessionOpenRequest(
                        request_id="cancel", runtime_id="cancel", cwd=Path.cwd()
                    ),
                    GENERATION,
                )
            )
            await asyncio.wait_for(entered.wait(), 1)
            preparation.cancel()
            await asyncio.sleep(0)
            self.assertFalse(preparation.done())
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await preparation
        resources.validate_probe.assert_awaited_once()
        self.assertIs(host._proc, process)
        self.assertIsNone(process.returncode)
        self.assertEqual(host.state, CodexProcessState.READY)

    async def test_tool_preflight_uses_windows_supported_command_contract(self):
        probes = (
            SandboxProbe("python", ("frozen-python.exe", "-I", "-B")),
            SandboxProbe(
                "node", ("frozen-electron.exe",), environment=(("ELECTRON_RUN_AS_NODE", "1"),)
            ),
        )

        @asynccontextmanager
        async def verification(cwd, *, writable):
            self.assertTrue(writable)
            yield probes

        for invalid_output in (False, True):
            with self.subTest(invalid_output=invalid_output):
                validation = AsyncMock(
                    side_effect=(
                        PermissionError("bundled_tool_probe_origin_mismatch")
                        if invalid_output
                        else None
                    )
                )
                resources = SimpleNamespace(verification=verification, validate_probe=validation)
                bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), resources=resources)
                kernel = Mock()

                def system_directory(buffer, capacity):
                    buffer.value = "C:\\Windows\\System32"
                    return len(buffer.value)

                kernel.GetSystemDirectoryW.side_effect = system_directory
                calls = []

                async def request(method, parameters):
                    self.assertEqual(method, "command/exec")
                    calls.append(parameters)
                    # Official Windows command/exec rejects a custom output cap
                    # before spawning, even for a trusted bundled executable.
                    if parameters.get("outputBytesCap") is not None:
                        raise AppServerError(
                            "custom outputBytesCap is not supported with windows sandbox"
                        )
                    return {"exitCode": 0, "stdout": "verified"}

                with (
                    patch("scholarseed_codex.sandbox.sys.platform", "win32"),
                    patch(
                        "scholarseed_codex.sandbox.ctypes.WinDLL", return_value=kernel, create=True
                    ),
                ):
                    if invalid_output:
                        with self.assertRaises(AppServerError) as raised:
                            await bootstrap.ensure_thread_execution_ready(
                                request,
                                Path.cwd(),
                                {"type": "workspaceWrite", "networkAccess": True},
                            )
                        self.assertEqual(
                            raised.exception.safe_error, "windows_sandbox_tool_probe_failed"
                        )
                        validation.assert_awaited_once()
                        self.assertEqual(len(calls), 2)
                    else:
                        await bootstrap.ensure_thread_execution_ready(
                            request, Path.cwd(), {"type": "workspaceWrite", "networkAccess": True}
                        )
                        self.assertEqual(validation.await_count, len(probes))
                        self.assertEqual(len(calls), 1 + len(probes))
                        self.assertEqual(calls[2]["env"], {"ELECTRON_RUN_AS_NODE": "1"})
                    for call in calls:
                        self.assertFalse(call["sandboxPolicy"]["networkAccess"])
                        self.assertGreater(call["timeoutMs"], 0)

    async def test_tool_probe_budget_preserves_unknown_command_outcome(self):
        probe = SandboxProbe("python", ("frozen-python.exe",), environment=(("fixed", "1"),))

        @asynccontextmanager
        async def verification(cwd, *, writable):
            self.assertTrue(writable)
            yield (probe,)

        resources = SimpleNamespace(verification=verification, validate_probe=AsyncMock())
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,), resources=resources)
        kernel = Mock()

        def system_directory(buffer, capacity):
            buffer.value = "C:\\Windows\\System32"
            return len(buffer.value)

        kernel.GetSystemDirectoryW.side_effect = system_directory
        calls = []

        async def request(method, parameters):
            calls.append(parameters)
            if len(calls) == 1:
                return {"exitCode": 0}
            await asyncio.sleep(1)
            return {"exitCode": 0}

        with (
            patch("scholarseed_codex.sandbox.sys.platform", "win32"),
            patch("scholarseed_codex.sandbox.ctypes.WinDLL", return_value=kernel, create=True),
            patch("scholarseed_codex.sandbox.SANDBOX_EXECUTION_TIMEOUT_MS", 1),
        ):
            with self.assertRaises(AppServerError) as raised:
                await bootstrap.ensure_thread_execution_ready(
                    request, Path.cwd(), {"type": "workspaceWrite", "networkAccess": True}
                )
        self.assertIs(raised.exception.retryability, RuntimeRetryability.UNKNOWN_OUTCOME)
        self.assertEqual(raised.exception.safe_error, "windows_sandbox_setup_unknown")
        self.assertEqual(calls[1]["command"], ["frozen-python.exe"])
        self.assertEqual(calls[1]["env"], {"fixed": "1"})
        self.assertFalse(calls[1]["sandboxPolicy"]["networkAccess"])
        resources.validate_probe.assert_not_awaited()

    @unittest.skipUnless(sys.platform == "win32", "real Windows system path required")
    async def test_execution_check_rejects_missing_nonzero_and_boolean_exit(self):
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        for result in ({}, {"exitCode": 1}, {"exitCode": False}):
            with self.subTest(result=result):
                with self.assertRaises(AppServerError):
                    await bootstrap.ensure_execution_ready(AsyncMock(return_value=result))

    @unittest.skipUnless(sys.platform == "win32", "real Windows system path required")
    async def test_host_execution_check_has_no_thread_write_roots_or_network(self):
        bootstrap = WindowsSandboxBootstrap((SANDBOX_ARGUMENT,))
        request = AsyncMock(return_value={"exitCode": 0})
        await bootstrap.ensure_execution_ready(request)
        params = request.await_args.args[1]
        self.assertNotEqual(params["cwd"], str(Path.cwd()))
        self.assertEqual(params["sandboxPolicy"], {"type": "readOnly", "networkAccess": False})

    async def test_host_startup_does_not_prepare_discovery_as_a_thread_workspace(self):
        resources = Mock(prepare=AsyncMock())
        bootstrap = WindowsSandboxBootstrap(
            (SANDBOX_ARGUMENT,), resources=resources, version="0.159.0"
        )
        await bootstrap.ensure_ready(
            AsyncMock(return_value={"status": "ready"}),
            Path.cwd() / "discovery",
            GENERATION,
            prepare_resources=False,
        )
        resources.prepare.assert_not_awaited()
        workspace = Path.cwd() / "thread-workspace"
        await bootstrap.prepare_resources(workspace)
        resources.prepare.assert_awaited_once_with(SANDBOX_USERS_GROUP, cwd=workspace)

    async def test_execution_rpc_budget_does_not_change_other_requests(self):
        host = CodexProcessHost(rpc_timeout=0.001)
        host._proc = Mock(pid=1234)

        async def write(
            message, *, generation, on_written, before_write=None, on_write_attempt=None
        ):
            if before_write is not None:
                before_write()
            self.assertTrue(callable(on_write_attempt))
            on_write_attempt()
            on_written()
            asyncio.get_running_loop().call_later(
                0.02,
                host._rpc_requests.resolve,
                {"id": message["id"], "result": {"exitCode": 0}},
                generation,
            )

        with patch.object(host._rpc_writer, "write", write):
            result = await host._request_connected("command/exec", {}, timeout=1)
            self.assertEqual(result, {"exitCode": 0})
            with self.assertRaises(AppServerError) as raised:
                await host._request_connected("ordinary/request", {})
            self.assertEqual(raised.exception.safe_error, "runtime_rpc_timeout")
            self.assertFalse(raised.exception.submission_not_applied)
        self.assertEqual(host.rpc_timeout, 0.001)

    async def test_cancelled_launch_preserves_concurrent_failure_diagnostic(self):
        host = CodexProcessHost()
        entered = asyncio.Event()
        finish = asyncio.Event()
        failure = OSError("startup failed during cancellation")

        async def launch():
            entered.set()
            await finish.wait()
            raise failure

        @asynccontextmanager
        async def coordination():
            yield

        with (
            patch("scholarseed_codex.process.startup_mutex", coordination),
            patch("scholarseed_codex.process.os", SimpleNamespace(name="nt")),
            patch.object(host, "_launch_process", launch),
            self.assertLogs("scholarseed_codex.process", level="WARNING") as logs,
        ):
            task = asyncio.create_task(host._start_process())
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIs(logs.records[0].exc_info[1], failure)
        self.assertIn("codex_launch_failed_during_cancellation", logs.output[0])

    async def test_cancelled_launch_preserves_cleanup_failure_and_cancellation(self):
        host = CodexProcessHost()
        entered, finish = asyncio.Event(), asyncio.Event()
        failure = OSError("cleanup failed during cancellation")

        @asynccontextmanager
        async def coordination():
            yield

        async def launch():
            entered.set()
            await finish.wait()
            host._proc = Mock()

        with (
            patch("scholarseed_codex.process.startup_mutex", coordination),
            patch("scholarseed_codex.process.os", SimpleNamespace(name="nt")),
            patch.object(host, "_launch_process", launch),
            patch.object(host, "_discard_process", AsyncMock(side_effect=failure)),
            self.assertLogs("scholarseed_codex.process", level="WARNING") as logs,
        ):
            task = asyncio.create_task(host._start_process())
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIs(logs.records[0].exc_info[1], failure)
        self.assertIn("codex_launch_cleanup_failed_during_cancellation", logs.output[0])

    async def test_launch_and_cleanup_remain_inside_coordination_on_cancel(self):
        host = CodexProcessHost()
        entered = asyncio.Event()
        finish = asyncio.Event()
        order = []

        @asynccontextmanager
        async def coordination():
            order.append("acquired")
            try:
                yield
            finally:
                order.append("released")

        async def launch():
            entered.set()
            await finish.wait()
            host._proc = Mock()
            order.append("terminal")

        async def cleanup(*args):
            order.append("cleanup")
            host._proc = None

        with (
            patch("scholarseed_codex.process.startup_mutex", coordination),
            patch("scholarseed_codex.process.os", SimpleNamespace(name="nt")),
            patch.object(host, "_launch_process", launch),
            patch.object(host, "_discard_process", cleanup),
        ):
            task = asyncio.create_task(host._start_process())
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertEqual(order, ["acquired"])
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(order, ["acquired", "terminal", "cleanup", "released"])

    @unittest.skipIf(sys.platform == "win32", "macOS/non-Windows no-op contract")
    async def test_non_windows_never_opens_native_coordination(self):
        with patch("scholarseed_codex.mutex._hold") as native:
            async with startup_mutex():
                pass
        native.assert_not_called()

    @unittest.skipUnless(sys.platform == "win32", "real Windows mutex required")
    async def test_coroutines_do_not_reenter_thread_owned_mutex(self):
        entered = asyncio.Event()

        async def second():
            async with startup_mutex():
                entered.set()

        async with startup_mutex():
            task = asyncio.create_task(second())
            await asyncio.sleep(0.2)
            self.assertFalse(entered.is_set())
        await asyncio.wait_for(task, 5)
        self.assertTrue(entered.is_set())

    @unittest.skipUnless(sys.platform == "win32", "real Windows mutex required")
    async def test_waiting_cancellation_does_not_leak_ownership(self):
        async def second():
            async with startup_mutex():
                self.fail("cancelled waiter entered")

        async with startup_mutex():
            task = asyncio.create_task(second())
            await asyncio.sleep(0.1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
        async with startup_mutex():
            pass

    @unittest.skipUnless(sys.platform == "win32", "real Windows mutex required")
    async def test_process_exit_allows_readiness_recheck(self):
        code = (
            "import asyncio; import scholarseed_codex.mutex as mutex\n"
            f"mutex.STARTUP_MUTEX = {self.mutex_name!r}\n"
            "from scholarseed_codex.mutex import startup_mutex\n"
            "async def main():\n"
            " async with startup_mutex():\n"
            "  print('owned', flush=True)\n"
            "  await asyncio.sleep(30)\n"
            "asyncio.run(main())\n"
        )
        owner = await asyncio.create_subprocess_exec(
            sys.executable, "-c", code, stdout=asyncio.subprocess.PIPE
        )

        async def wait_for_owner():
            async with startup_mutex():
                # This lock serializes readiness checks, not native setup.
                # An abandoned owner must not permanently prevent the recheck.
                return True

        try:
            self.assertEqual(await asyncio.wait_for(owner.stdout.readline(), 5), b"owned\r\n")
            waiter = asyncio.create_task(wait_for_owner())
            await asyncio.sleep(0.2)
            owner.kill()
            await owner.wait()
            self.assertTrue(await asyncio.wait_for(waiter, 5))
            async with startup_mutex():
                pass
        finally:
            if owner.returncode is None:
                owner.kill()
                await owner.wait()

    @unittest.skipUnless(sys.platform == "win32", "real Windows mutex required")
    async def test_wait_timeout_fails_closed_and_releases_handle(self):
        async with startup_mutex():
            with patch("scholarseed_codex.mutex.STARTUP_WAIT_SECONDS", 0.1):
                with self.assertRaises(AppServerError):
                    async with startup_mutex():
                        self.fail("contended mutex entered")
        async with startup_mutex():
            pass


class NativeDiagnosticContracts(unittest.IsolatedAsyncioTestCase):
    def test_known_errors_only_export_fixed_labels_and_numbers(self):
        cases = (
            (
                "windows sandbox: CreateProcessWithLogonW failed (os error 5)",
                "windows_sandbox_process_launch",
                "os_error=5",
            ),
            (
                "windows sandbox: Access is denied. (os error 5)",
                "windows_sandbox_access_denied",
                "os_error=5",
            ),
            (
                "windows sandbox: Logon failure (os error 1326)",
                "windows_sandbox_logon_failed",
                "os_error=1326",
            ),
            (
                "windows sandbox: timed out after 15000ms connecting runner pipe-out",
                "windows_sandbox_runner_pipe_timeout",
                "pipe=out",
            ),
            ("thread already has an active writer", "thread_writer_busy", "sha256="),
        )
        for raw, reason, field in cases:
            with self.subTest(reason=reason):
                result = native_diagnostic(
                    "rpc", raw + "\nBearer sensitive-token C:\\Users\\confidential\\file"
                )
                self.assertEqual(result.reason, reason)
                self.assertIn(field, result.summary)
                self.assertNotIn("sensitive-token", result.summary)
                self.assertNotIn("confidential", result.summary)
                self.assertNotIn("\n", result.summary)

    def test_untrusted_numbers_and_oversized_messages_are_not_copied(self):
        result = native_diagnostic(
            "rpc",
            "windows sandbox: timed out after secretms connecting runner pipe-secret "
            "(os error secret)",
        )
        self.assertEqual(result.reason, "windows_sandbox_failed")
        self.assertNotIn("secret", result.summary)
        self.assertNotIn("os_error=", result.summary)
        oversized = native_diagnostic(
            "rpc", "x" * DIAGNOSTIC_SCAN_LIMIT + "windows sandbox: logon failure"
        )
        self.assertEqual(oversized.reason, "unspecified")
        self.assertLess(len(oversized.summary), 150)

    async def test_rpc_timeout_keeps_safe_context(self):
        requests = PendingRequests()
        request_id, pending = requests.begin(7, "command/exec")
        raw = "exec failed: windows sandbox: timed out after 15000ms connecting runner pipe-in"
        with self.assertLogs("scholarseed_codex.rpc", level="WARNING") as logs:
            requests.resolve({"id": request_id, "error": {"code": -32603, "message": raw}}, 7)
        with self.assertRaises(AppServerError) as caught:
            await pending.future
        combined = " ".join(logs.output) + str(caught.exception)
        for expected in (
            "reason=windows_sandbox_runner_pipe_timeout",
            "timeout_ms=15000",
            "pipe=in",
            "generation=7",
            "request_id=1",
            "sha256=",
        ):
            self.assertIn(expected, combined)
        self.assertIn("windows_sandbox_runner_pipe_timeout", str(caught.exception))
        self.assertEqual(caught.exception.safe_error, "runtime_rpc_rejected")
        self.assertEqual(caught.exception.rpc_code, -32603)

    async def test_unknown_error_does_not_leak(self):
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "command/exec")
        raw = "C:\\Users\\private\\secret.txt Authorization: Bearer secret-token\nforged-log-entry"
        with self.assertLogs("scholarseed_codex.rpc", level="WARNING") as logs:
            requests.resolve({"id": request_id, "error": {"code": -32603, "message": raw}}, 1)
        with self.assertRaises(AppServerError) as caught:
            await pending.future
        combined = " ".join(logs.output) + str(caught.exception)
        self.assertIn("reason=unspecified", combined)
        self.assertIn("sha256=", combined)
        for forbidden in ("secret-token", "forged-log-entry", "private"):
            self.assertNotIn(forbidden, combined)

    async def test_stderr_preserves_reason_and_identity(self):
        stream = asyncio.StreamReader()
        stream.feed_data(
            b"ERROR windows sandbox: timed out after 15000ms connecting runner pipe-in\n"
        )
        stream.feed_eof()
        host = CodexProcessHost()
        host._generation = 2
        with self.assertLogs("scholarseed_codex.protocol.state", level="WARNING") as logs:
            await host._drain_stderr(SimpleNamespace(stderr=stream, pid=321), 2)
        self.assertIn("pid=321 generation=2", " ".join(logs.output))
        self.assertIn("windows_sandbox_runner_pipe_timeout", host._stderr_lines[-1])

    async def test_stale_rpc_cannot_emit_diagnostics(self):
        requests = PendingRequests()
        request_id, pending = requests.begin(2, "command/exec")
        with self.assertNoLogs("scholarseed_codex.rpc", level="WARNING"):
            requests.resolve({"id": request_id, "error": {"code": -32603, "message": "secret"}}, 1)
        self.assertFalse(pending.future.done())
        requests.discard(request_id)


class PermissionRejectionDiagnostics(unittest.TestCase):
    def test_native_access_denied_retains_runtime_error_and_safe_code(self):
        with self.assertLogs(MUTEX_LOGGER, level="WARNING") as logs:
            error = startup_error("credential-secret", 5)
        self.assertIsInstance(error, AppServerError)
        payload = json.loads(logs.output[0].split("permission_rejected ", 1)[1])
        self.assertEqual(payload["reason"], "os_access_denied")
        self.assertEqual(payload["system_code"], 5)
        self.assertEqual(payload["profile"], "startup_mutex")
        self.assertNotIn("credential-secret", logs.output[0])


if __name__ == "__main__":
    unittest.main()
