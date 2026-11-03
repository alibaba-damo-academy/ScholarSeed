"""Bounded native recovery transport contracts, not Windows acceptance."""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_codex.sandbox import SANDBOX_ARGUMENT, WindowsSandboxBootstrap
from service.platform.recovery import (
    NATIVE_OUTPUT_LIMIT,
    RECOVERY_HELPER_ENV,
    SandboxRecovery,
    load_sandbox_recovery,
)


class RecoveryContracts(unittest.IsolatedAsyncioTestCase):
    def recovery(self):
        return SandboxRecovery(Path("/installed/helper.exe"), frozenset({Path("/authorized")}))

    def test_unused_helper_discovery_does_not_require_executable_to_exist(self):
        with tempfile.TemporaryDirectory() as temporary:
            missing = Path(temporary).resolve() / "not-installed.exe"
            with (
                patch("service.platform.recovery.sys.platform", "win32"),
                patch.dict(os.environ, {RECOVERY_HELPER_ENV: str(missing)}),
            ):
                transport = load_sandbox_recovery(())
            self.assertIsNotNone(transport)
            self.assertEqual(transport.helper, missing)

    async def test_fixed_0159_never_invokes_unused_recovery_helper(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            helper = root / "missing-helper.exe"
            with (
                patch("service.platform.recovery.sys.platform", "win32"),
                patch.dict(os.environ, {RECOVERY_HELPER_ENV: str(helper)}),
            ):
                recovery = load_sandbox_recovery(())
            native = WindowsSandboxBootstrap(
                (SANDBOX_ARGUMENT,),
                recovery=recovery,
                version="0.159.0",
                home=root,
                executable=root / "codex.exe",
            )
            with patch.object(SandboxRecovery, "prepare", new_callable=AsyncMock) as prepare:
                await native.ensure_ready(AsyncMock(return_value={"status": "ready"}), root, 1)
            prepare.assert_not_awaited()

    async def test_launch_denial_preserves_numeric_system_error(self):
        error = PermissionError(13, "private-token-and-path")
        error.winerror = 5
        with (
            patch(
                "service.platform.recovery.asyncio.create_subprocess_exec",
                AsyncMock(side_effect=error),
            ),
            self.assertLogs("service.platform.recovery", level="WARNING") as logs,
        ):
            with self.assertRaises(PermissionError):
                await self.recovery().prepare(
                    Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                )
        self.assertIn("system_error=5", " ".join(logs.output))
        self.assertNotIn("private-token-and-path", " ".join(logs.output))

    async def test_response_is_bounded_and_original_arguments_are_not_shell_commands(self):
        stream = asyncio.StreamReader()
        stream.feed_data(b'{"event":')
        stream.feed_data(b'"repaired"}')
        stream.feed_eof()
        process = SimpleNamespace(stdout=stream, wait=AsyncMock(return_value=0))
        create = AsyncMock(return_value=process)
        with patch("service.platform.recovery.asyncio.create_subprocess_exec", create):
            await self.recovery().prepare(Path("/authorized"), "0.163.0", Path("/native/codex.exe"))
        self.assertEqual(
            create.call_args.args,
            (
                str(Path("/installed/helper.exe")),
                "--sandbox-home",
                str(Path("/authorized")),
                "--sandbox-version",
                "0.163.0",
                "--sandbox-runtime",
                str(Path("/native/codex.exe")),
            ),
        )
        process.wait.assert_awaited_once()

    async def test_rejects_unqualified_homes_without_launching_helper(self):
        with patch(
            "service.platform.recovery.asyncio.create_subprocess_exec", AsyncMock()
        ) as create:
            with self.assertRaises(PermissionError):
                await self.recovery().prepare(Path("/other"), "0.163.0", Path("/native/codex.exe"))
        create.assert_not_awaited()

    async def test_invalid_native_responses_fail_closed(self):
        for output, code in (
            (b'{"event":"repaired"}', 1),
            (b'{"event":"unknown"}', 0),
            (b'{"event":"repaired","path":"private"}', 0),
            (b'"repaired"', 0),
            (b'{"event":"repaired"}\n{"event":"repaired"}', 0),
            (b"x" * (NATIVE_OUTPUT_LIMIT + 1), 0),
        ):
            with self.subTest(code=code, size=len(output)):
                stream = asyncio.StreamReader()
                stream.feed_data(output)
                stream.feed_eof()
                process = SimpleNamespace(stdout=stream, wait=AsyncMock(return_value=code))
                with patch(
                    "service.platform.recovery.asyncio.create_subprocess_exec",
                    AsyncMock(return_value=process),
                ):
                    with self.assertRaises(PermissionError) as raised:
                        await self.recovery().prepare(
                            Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                        )
                self.assertNotIn("private", str(raised.exception))
                process.wait.assert_awaited_once()

    async def test_cancellation_waits_for_native_terminal_state(self):
        entered, terminal = asyncio.Event(), asyncio.Event()

        async def run(recovery, home, version, executable):
            entered.set()
            await terminal.wait()

        with patch.object(SandboxRecovery, "_run", run):
            task = asyncio.create_task(
                self.recovery().prepare(Path("/authorized"), "0.163.0", Path("/native/codex.exe"))
            )
            await entered.wait()
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            terminal.set()
            with self.assertRaises(asyncio.CancelledError):
                await task

    async def test_native_failure_keeps_safe_stage_and_reason(self):
        for stage, reason, system_error in (
            ("identity", "policy_rejected", 0),
            ("ancestor_profile", "policy_rejected", 0),
            ("elevation", "cancelled", 0),
            ("elevation", "access_denied", 5),
            ("worker_privilege", "privilege_missing", 1314),
        ):
            with self.subTest(stage=stage, reason=reason):
                stream = asyncio.StreamReader()
                stream.feed_data(
                    (
                        '{"event":"failed","stage":"%s","reason":"%s","system_error":%d}'
                        % (stage, reason, system_error)
                    ).encode()
                )
                stream.feed_eof()
                process = SimpleNamespace(stdout=stream, wait=AsyncMock(return_value=1))
                with (
                    patch(
                        "service.platform.recovery.asyncio.create_subprocess_exec",
                        AsyncMock(return_value=process),
                    ),
                    self.assertLogs("service.platform.recovery", level="WARNING") as logs,
                ):
                    with self.assertRaises(PermissionError) as raised:
                        await self.recovery().prepare(
                            Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                        )
                expected = {
                    "policy_rejected": "windows_sandbox_policy_rejected",
                    "cancelled": "windows_sandbox_setup_cancelled",
                }.get(reason, "windows_sandbox_setup_failed")
                self.assertEqual(getattr(raised.exception, "safe_error", None), expected)
                message = " ".join(logs.output)
                self.assertIn("stage=" + stage, message)
                self.assertIn("reason=" + reason, message)
                self.assertIn("system_error=" + str(system_error), message)

    async def test_untrusted_native_details_are_never_logged(self):
        for output in (
            b'{"event":"failed","stage":"private-token","reason":"policy_rejected"}',
            b'{"event":"failed","stage":"ancestor_profile","reason":"private-token"}',
            b'{"event":"failed","stage":"ancestor_profile","reason":"policy_rejected","path":"private-token"}',
            b'{"event":"failed","stage":"ancestor_profile","reason":"policy_rejected","system_error":true}',
            b'{"event":"failed","stage":"ancestor_profile","reason":"policy_rejected","system_error":-1}',
            b'{"event":"error","message":"private-token"}',
            b"private-token",
            b"[" * 1100 + b"]" * 1100,
            b"private-token" * NATIVE_OUTPUT_LIMIT,
        ):
            stream = asyncio.StreamReader()
            stream.feed_data(output)
            stream.feed_eof()
            process = SimpleNamespace(stdout=stream, wait=AsyncMock(return_value=1))
            with (
                patch(
                    "service.platform.recovery.asyncio.create_subprocess_exec",
                    AsyncMock(return_value=process),
                ),
                self.assertLogs("service.platform.recovery", level="WARNING") as logs,
            ):
                with self.assertRaises(PermissionError) as raised:
                    await self.recovery().prepare(
                        Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                    )
            self.assertNotIn("private-token", str(raised.exception) + " ".join(logs.output))
            self.assertIn("stage=transport", " ".join(logs.output))
            self.assertEqual(raised.exception.safe_error, "windows_sandbox_setup_failed")
            process.wait.assert_awaited_once()

    async def test_native_launch_failure_is_not_labelled_uac_cancellation(self):
        with (
            patch(
                "service.platform.recovery.asyncio.create_subprocess_exec",
                AsyncMock(side_effect=OSError("private-token")),
            ),
            self.assertLogs("service.platform.recovery", level="WARNING") as logs,
        ):
            with self.assertRaises(PermissionError) as raised:
                await self.recovery().prepare(
                    Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                )
        message = str(raised.exception) + " ".join(logs.output)
        self.assertIn("stage=helper_launch", message)
        self.assertIn("reason=launch_failed", message)
        self.assertNotIn("cancelled", message)
        self.assertNotIn("private-token", message)

    async def test_custom_home_unsupported_is_not_reported_as_repaired(self):
        stream = asyncio.StreamReader()
        stream.feed_data(b'{"event":"unsupported"}')
        stream.feed_eof()
        process = SimpleNamespace(stdout=stream, wait=AsyncMock(return_value=0))
        with patch(
            "service.platform.recovery.asyncio.create_subprocess_exec",
            AsyncMock(return_value=process),
        ):
            with self.assertLogs("service.platform.recovery", level="INFO") as logs:
                await self.recovery().prepare(
                    Path("/authorized"), "0.163.0", Path("/native/codex.exe")
                )
        self.assertIn("event=unsupported", " ".join(logs.output))
        self.assertNotIn("event=repaired", " ".join(logs.output))


if __name__ == "__main__":
    unittest.main()
