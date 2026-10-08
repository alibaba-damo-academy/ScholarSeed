"""Windows native sandbox startup contracts; not product acceptance."""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.state import AppServerError, CodexProcessState
from scholarseed_codex.sandbox import (
    SANDBOX_ARGUMENT,
    SANDBOX_COMPLETED_METHOD,
    SANDBOX_MODE,
    SANDBOX_READINESS_METHOD,
    SANDBOX_SETUP_METHOD,
    WindowsSandboxBootstrap,
    windows_sandbox_arguments,
)

GENERATION = 1
TEST_TIMEOUT_SECONDS = 0.01


class WindowsSandboxContracts(unittest.IsolatedAsyncioTestCase):
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

    async def test_acceptance_without_completion_times_out(self) -> None:
        request = AsyncMock(side_effect=[{"status": "updateRequired"}, {"started": True}])
        with patch("scholarseed_codex.sandbox.SANDBOX_SETUP_TIMEOUT_SECONDS", TEST_TIMEOUT_SECONDS):
            with self.assertRaisesRegex(AppServerError, "timed out"):
                await self.bootstrap().ensure_ready(request, Path.cwd(), GENERATION)

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
        self.assertEqual(calls, ["initialize", SANDBOX_READINESS_METHOD])
        self.assertEqual(host.state, CodexProcessState.READY)

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


if __name__ == "__main__":
    unittest.main()
