"""Credential projection and real launcher subprocess contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import ctypes
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from scholarseed_codex import diagnostic, launcher
from scholarseed_codex.configuration import native_mcp_configuration
from scholarseed_codex.diagnostic import (
    MCP_STDERR_LOG_FILTER,
    enable_mcp_diagnostics,
    native_diagnostic,
)
from scholarseed_codex.isolation import managed_shell_environment
from scholarseed_codex.launcher import MCP_SECRET_ENVIRONMENT_PREFIX, server_environment
from scholarseed_runtime.contract.mcp import (
    McpConfigurationRequest,
    McpCredentialBinding,
    McpCredentialTarget,
    McpHttpTransport,
    McpServerConfiguration,
    McpStdioTransport,
)
from scholarseed_runtime.contract.secret import RuntimeSecret

FIRST_SECRET = "first-private-value"
SECOND_SECRET = "second-private-value"
FIRST_REFERENCE = "opaque-first"
SECOND_REFERENCE = "opaque-second"
SUBPROCESS_TIMEOUT_SECONDS = 10


class SecretProbe:
    def __init__(self) -> None:
        self.references: list[str] = []
        self.override: str | None = None

    async def resolve(self, reference: str) -> RuntimeSecret:
        self.references.append(reference)
        return RuntimeSecret(
            self.override
            if self.override is not None
            else {FIRST_REFERENCE: FIRST_SECRET, SECOND_REFERENCE: SECOND_SECRET}[reference]
        )


def stdio(name: str, reference: str, *, enabled: bool = True) -> McpServerConfiguration:
    return McpServerConfiguration(
        name,
        McpStdioTransport(sys.executable, ("-c", "print('unused')")),
        enabled=enabled,
        credentials=(McpCredentialBinding(McpCredentialTarget.ENVIRONMENT, "TOKEN", reference),),
    )


class McpCredentialTests(unittest.IsolatedAsyncioTestCase):
    async def test_startup_timeout_is_independent_and_omitted_by_default(self) -> None:
        server = McpServerConfiguration(
            "remote",
            McpHttpTransport("https://example.invalid/mcp"),
            startup_timeout_ms=1250,
            tool_timeout_ms=9000,
        )
        projection = await native_mcp_configuration(McpConfigurationRequest(1, (server,)))
        self.assertEqual(projection.servers()["remote"]["startup_timeout_sec"], 1.25)
        self.assertEqual(projection.servers()["remote"]["tool_timeout_sec"], 9)
        for invalid in (True, 0, 999, 1.5, 2**53):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                await native_mcp_configuration(
                    McpConfigurationRequest(
                        2,
                        (
                            McpServerConfiguration(
                                "bad", server.transport, startup_timeout_ms=invalid
                            ),
                        ),
                    )
                )
        default = await native_mcp_configuration(
            McpConfigurationRequest(3, (McpServerConfiguration("default", server.transport),))
        )
        self.assertNotIn("startup_timeout_sec", default.servers()["default"])

    def test_launcher_access_denied_and_invalid_binding_diagnostics(self) -> None:
        denied = PermissionError(13, "private-path-and-token")
        denied.winerror = 5
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["launcher", "{}", "unused"]),
            patch.object(launcher, "windows_family", return_value=1),
            patch.object(launcher.os, "execvpe", side_effect=denied),
            patch.object(launcher.subprocess, "call", side_effect=denied),
            redirect_stderr(output),
        ):
            self.assertEqual(launcher.main(), 1)
        event = json.loads(output.getvalue())
        self.assertEqual((event["errno"], event["winerror"]), (13, 5))
        self.assertNotIn("private-path-and-token", output.getvalue())
        diagnostic = native_diagnostic("stderr", output.getvalue())
        self.assertIn("winerror=5", diagnostic.summary)
        envelope = json.dumps({"fields": {"message": "MCP server stderr: " + output.getvalue()}})
        self.assertEqual(native_diagnostic("stderr", envelope).reason, "mcp_launch_failed")
        event["private"] = "do-not-log"
        self.assertEqual(
            native_diagnostic("stderr", json.dumps(event, sort_keys=True)).reason, "unspecified"
        )
        event.pop("private")
        event["winerror"] = True
        self.assertEqual(
            native_diagnostic("stderr", json.dumps(event, sort_keys=True)).reason, "unspecified"
        )
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["launcher", "private-invalid-json", "unused"]),
            redirect_stderr(output),
        ):
            self.assertEqual(launcher.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["stage"], "bindings")
        self.assertNotIn("private-invalid-json", output.getvalue())

    def test_launcher_missing_program_retains_codes_without_secret_or_command(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                str(Path(launcher.__file__)),
                "{}",
                "missing-mcp-private-command",
            ],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        event = json.loads(result.stderr)
        self.assertEqual(event["event"], "scholarseed_mcp_launch_failed")
        self.assertEqual(event["stage"], "exec")
        self.assertEqual(event["errno"], 2)
        self.assertEqual(len(event["correlation_id"]), 32)
        self.assertNotIn("missing-mcp-private-command", result.stderr)
        diagnostic = native_diagnostic("stderr", "MCP server stderr: " + result.stderr)
        self.assertEqual(diagnostic.reason, "mcp_launch_failed")
        self.assertIn("errno=2", diagnostic.summary)
        self.assertIn(event["correlation_id"], diagnostic.summary)

    async def test_shared_launch_credential_is_stable_across_server_changes(self) -> None:
        probe = SecretProbe()
        binding = McpCredentialBinding(McpCredentialTarget.HEADER, "Authorization", FIRST_REFERENCE)
        first = await native_mcp_configuration(
            McpConfigurationRequest(0, (), probe, shared_credentials=(binding,))
        )
        servers = tuple(
            McpServerConfiguration(
                name, McpHttpTransport("http://127.0.0.1:12345/mcp"), credentials=(binding,)
            )
            for name in ("first", "second")
        )
        second = await native_mcp_configuration(
            McpConfigurationRequest(1, servers, probe, shared_credentials=(binding,))
        )
        self.assertEqual(first.environment, second.environment)
        self.assertEqual(len(second.environment), 1)
        for server in second.servers().values():
            self.assertEqual(server["env_http_headers"]["Authorization"], second.environment[0][0])
        for private in (FIRST_SECRET, FIRST_REFERENCE):
            self.assertNotIn(private, second.document.decode())

    async def test_tool_timeout_is_projected_in_seconds_without_losing_milliseconds(self) -> None:
        server = McpServerConfiguration(
            "remote", McpHttpTransport("https://example.invalid/mcp"), tool_timeout_ms=1250
        )
        projection = await native_mcp_configuration(McpConfigurationRequest(1, (server,)))
        self.assertEqual(projection.servers()["remote"]["tool_timeout_sec"], 1.25)

    def test_shell_policy_preserves_explicit_product_credentials(self) -> None:
        self.assertEqual(managed_shell_environment({}), {})
        self.assertEqual(
            managed_shell_environment({"SCHOLARSEED_BRIDGE_TOKEN": "bridge-fixture"}),
            {
                "shell_environment_policy.inherit": "core",
                "shell_environment_policy.set.SCHOLARSEED_BRIDGE_TOKEN": "bridge-fixture",
            },
        )

    def test_shell_policy_rejects_explicit_internal_alias_even_with_different_case(self) -> None:
        for name in (
            MCP_SECRET_ENVIRONMENT_PREFIX + "EXAMPLE",
            MCP_SECRET_ENVIRONMENT_PREFIX.lower() + "example",
        ):
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(ValueError, "mcp_tool_environment_forbidden"),
            ):
                managed_shell_environment({name: FIRST_SECRET})

    async def test_same_variable_on_two_servers_has_distinct_bindings(self) -> None:
        probe = SecretProbe()
        projection = await native_mcp_configuration(
            McpConfigurationRequest(
                1, (stdio("first", FIRST_REFERENCE), stdio("second", SECOND_REFERENCE)), probe
            )
        )
        servers = projection.servers()
        first = servers["first"]["env_vars"][0]
        second = servers["second"]["env_vars"][0]
        self.assertNotEqual(first, second)
        self.assertEqual(dict(projection.environment)[first], FIRST_SECRET)
        self.assertEqual(dict(projection.environment)[second], SECOND_SECRET)
        for private in (FIRST_SECRET, SECOND_SECRET, FIRST_REFERENCE, SECOND_REFERENCE):
            self.assertNotIn(private, projection.document.decode())
            self.assertNotIn(private, repr(projection))

    async def test_http_secret_uses_environment_header_and_preserves_plain_header(self) -> None:
        server = McpServerConfiguration(
            "http",
            McpHttpTransport("https://example.invalid/mcp", (("X-Option", "plain"),)),
            credentials=(
                McpCredentialBinding(McpCredentialTarget.HEADER, "Authorization", FIRST_REFERENCE),
            ),
        )
        projection = await native_mcp_configuration(
            McpConfigurationRequest(1, (server,), SecretProbe())
        )
        native = projection.servers()["http"]
        self.assertEqual(native["http_headers"], {"X-Option": "plain"})
        alias = native["env_http_headers"]["Authorization"]
        self.assertEqual(dict(projection.environment)[alias], FIRST_SECRET)

    async def test_disabled_server_does_not_resolve_credentials(self) -> None:
        probe = SecretProbe()
        projection = await native_mcp_configuration(
            McpConfigurationRequest(1, (stdio("disabled", FIRST_REFERENCE, enabled=False),), probe)
        )
        self.assertEqual(probe.references, [])
        self.assertEqual(projection.environment, ())
        self.assertFalse(projection.servers()["disabled"]["enabled"])

    async def test_enabled_secret_requires_resolver(self) -> None:
        with self.assertRaisesRegex(ValueError, "mcp_secret_resolution_failed"):
            await native_mcp_configuration(
                McpConfigurationRequest(1, (stdio("server", FIRST_REFERENCE),))
            )

    async def test_transport_credential_mismatch_rejected(self) -> None:
        server = McpServerConfiguration(
            "invalid",
            McpHttpTransport("https://example.invalid/mcp"),
            credentials=(
                McpCredentialBinding(McpCredentialTarget.ENVIRONMENT, "TOKEN", FIRST_REFERENCE),
            ),
        )
        with self.assertRaisesRegex(ValueError, "mcp_configuration_invalid"):
            await native_mcp_configuration(McpConfigurationRequest(1, (server,), SecretProbe()))

    async def test_invalid_header_rejected_before_secret_resolution(self) -> None:
        probe = SecretProbe()
        server = McpServerConfiguration(
            "invalid",
            McpHttpTransport("https://example.invalid/mcp"),
            credentials=(
                McpCredentialBinding(McpCredentialTarget.HEADER, "X-Bad\nHeader", FIRST_REFERENCE),
            ),
        )
        with self.assertRaisesRegex(ValueError, "mcp_configuration_invalid"):
            await native_mcp_configuration(McpConfigurationRequest(1, (server,), probe))
        self.assertEqual(probe.references, [])

    async def test_http_secret_rejects_line_injection_and_nul(self) -> None:
        server = McpServerConfiguration(
            "http",
            McpHttpTransport("https://example.invalid/mcp"),
            credentials=(
                McpCredentialBinding(McpCredentialTarget.HEADER, "Authorization", FIRST_REFERENCE),
            ),
        )
        for value in ("token\rX-Injected: 1", "token\n", "token\x00"):
            probe = SecretProbe()
            probe.override = value
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "mcp_secret_resolution_failed"),
            ):
                await native_mcp_configuration(McpConfigurationRequest(1, (server,), probe))

    async def test_launcher_keeps_argv_and_only_selected_credential(self) -> None:
        argument = "literal ; $(echo not-a-command) with spaces"
        program = "import json,os,sys;print(json.dumps({'token':os.environ.get('TOKEN'),'argv':sys.argv[1:],'aliases':[name for name in os.environ if name.startswith('SCHOLARSEED_MCP_SECRET_')]}),flush=True)"
        server = McpServerConfiguration(
            "subprocess",
            McpStdioTransport(sys.executable, ("-u", "-c", program, argument)),
            credentials=(
                McpCredentialBinding(McpCredentialTarget.ENVIRONMENT, "TOKEN", FIRST_REFERENCE),
            ),
        )
        projection = await native_mcp_configuration(
            McpConfigurationRequest(1, (server,), SecretProbe())
        )
        native = projection.servers()["subprocess"]
        environment = {
            **os.environ,
            **dict(projection.environment),
            MCP_SECRET_ENVIRONMENT_PREFIX + "OTHER": SECOND_SECRET,
        }
        result = await asyncio.to_thread(
            subprocess.run,
            [native["command"], *native["args"]],
            env=environment,
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout), {"token": FIRST_SECRET, "argv": [argument], "aliases": []}
        )

    async def test_stderr_overflow_is_bounded_and_next_event_survives(self) -> None:
        reader = asyncio.StreamReader(limit=64)
        event = {
            "event": "scholarseed_mcp_launch_failed",
            "schema_version": 1,
            "stage": "containment",
            "error_type": "os_error",
            "errno": 13,
            "winerror": 5,
            "correlation_id": "a" * 32,
        }
        private = b"private-command-and-token" * 10000
        reader.feed_data(private + b"\n" + json.dumps(event, sort_keys=True).encode() + b"\n")
        reader.feed_eof()
        records = [row async for row in diagnostic.stream_diagnostics(reader)]
        self.assertEqual(
            [row.reason for row in records], ["native_stderr_truncated", "mcp_launch_failed"]
        )
        self.assertNotIn("private-command-and-token", repr(records))
        self.assertIn("winerror=5", records[1].summary)

    async def test_stderr_truncated_eof_remains_redacted(self) -> None:
        reader = asyncio.StreamReader(limit=32)
        reader.feed_data(b"private-token" * diagnostic.STDERR_LINE_LIMIT)
        reader.feed_eof()
        rows = [row async for row in diagnostic.stream_diagnostics(reader)]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].reason, "native_stderr_truncated")
        self.assertNotIn("private-token", rows[0].summary)

    def test_native_stdio_forwarding_enables_only_the_reviewed_module(self) -> None:
        for prior in ("", "warn,codex_core=debug"):
            environment = {"RUST_LOG": prior, "PRIVATE": FIRST_SECRET}
            enable_mcp_diagnostics(environment)
            self.assertEqual(
                environment["RUST_LOG"], (prior or "error") + "," + MCP_STDERR_LOG_FILTER
            )
            self.assertEqual(environment["PRIVATE"], FIRST_SECRET)
            if os.name == "nt":
                environment = {"rust_log": "warn"}
                enable_mcp_diagnostics(environment)
                self.assertNotIn("rust_log", environment)
                self.assertEqual(environment["RUST_LOG"], "warn," + MCP_STDERR_LOG_FILTER)

    @unittest.skipUnless(os.name == "nt", "native Windows process ownership")
    def test_windows_job_is_required_before_process_creation(self) -> None:
        output = io.StringIO()
        with (
            patch.object(sys, "argv", ["launcher", "{}", "unused"]),
            patch.object(
                launcher, "windows_family", side_effect=PermissionError(13, "private-job-policy")
            ),
            patch.object(launcher.subprocess, "call") as spawn,
            redirect_stderr(output),
        ):
            self.assertEqual(launcher.main(), 1)
        spawn.assert_not_called()
        event = json.loads(output.getvalue())
        self.assertEqual(event["stage"], "containment")
        self.assertNotIn("private-job-policy", output.getvalue())
        self.assertEqual(native_diagnostic("stderr", output.getvalue()).reason, "mcp_launch_failed")

    @unittest.skipUnless(os.name == "nt", "native Windows process ownership")
    def test_windows_job_reaps_descendants_after_parent_kill_and_normal_exit(self) -> None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        kernel.WaitForSingleObject.restype = ctypes.c_uint
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle.restype = ctypes.c_int
        program = "import subprocess,sys,os,json;child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);print(json.dumps([os.getpid(),child.pid]),flush=True);input();raise SystemExit(7)"
        for mode in ("parent_kill", "normal_exit"):
            with self.subTest(mode=mode):
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-I",
                        str(Path(launcher.__file__)),
                        "{}",
                        sys.executable,
                        "-u",
                        "-c",
                        program,
                    ],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                handles = []
                try:
                    pids = json.loads(process.stdout.readline())
                    for pid in pids:
                        handle = kernel.OpenProcess(0x100000, False, pid)
                        self.assertTrue(handle)
                        handles.append(handle)
                    if mode == "parent_kill":
                        process.kill()
                    else:
                        process.stdin.write("exit\n")
                        process.stdin.flush()
                    process.wait(timeout=SUBPROCESS_TIMEOUT_SECONDS)
                    if mode == "normal_exit":
                        self.assertEqual(process.returncode, 7)
                    for handle in handles:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=SUBPROCESS_TIMEOUT_SECONDS)
                    for handle in handles:
                        kernel.CloseHandle(handle)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        stream.close()

    def test_launcher_propagates_child_exit_status(self) -> None:
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                str(Path(launcher.__file__)),
                "{}",
                sys.executable,
                "-c",
                "raise SystemExit(7)",
            ],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS,
        )
        self.assertEqual(result.returncode, 7)
        self.assertEqual(result.stdout, "")

    def test_missing_or_case_ambiguous_alias_fails(self) -> None:
        alias = MCP_SECRET_ENVIRONMENT_PREFIX + "EXAMPLE"
        for environment in ({}, {alias: FIRST_SECRET, alias.lower(): SECOND_SECRET}):
            with self.subTest(environment=environment), self.assertRaises(ValueError):
                server_environment({"TOKEN": alias}, environment)

    def test_target_cannot_export_internal_alias(self) -> None:
        alias = MCP_SECRET_ENVIRONMENT_PREFIX + "EXAMPLE"
        with self.assertRaises(ValueError):
            server_environment({alias: alias}, {alias: FIRST_SECRET})


if __name__ == "__main__":
    unittest.main()
