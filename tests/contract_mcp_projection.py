"""Real native configuration publication, distinct from Desktop acceptance."""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import tomllib
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import tomlkit

from scholarseed_codex.admission import NativeAdmission, NativeQuiescence
from scholarseed_codex.configuration import NativeMcpConfiguration
from scholarseed_codex.coordination import (
    MCP_APPLICATION_POLL_SECONDS,
    MCP_UNAPPLIED_REVISION,
    McpCoordinator,
)
from scholarseed_codex.environment import CODEX_HOME_ENV
from scholarseed_codex.executable import _resolve_launch_arguments
from scholarseed_codex.isolation import managed_codex_launch
from scholarseed_codex.mcp import NativeMcpInventory
from scholarseed_codex.pool import CodexHostPool
from scholarseed_codex.process import (
    NATIVE_CALLBACK_PENDING,
    NATIVE_COMMAND_UNSETTLED,
    CodexProcessHost,
)
from scholarseed_codex.projection import CodexConfigurationEditor, McpProjectionError
from scholarseed_codex.protocol.mcp import McpReloadRequest, McpToolCallRequest
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_codex.thread import CodexThreadSession
from scholarseed_runtime.contract.mcp import (
    McpApplicationState,
    McpConfigurationRequest,
    McpServerConfiguration,
    McpStdioTransport,
)
from scholarseed_runtime.gateway.catalog import RuntimeCatalog
from service.chat.runtime.selection import RuntimeDiscovery, RuntimeGatewayError
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.storage import DirectoryHandle
from tests.integration.appserver import AppServer

DISABLED_MCP_OVERRIDE = "mcp_servers={}"
MCP_CONTRACT_SERVER = "contract"
MCP_CONTRACT_TOOL = "revision"
MCP_CONTRACT_TIMEOUT = 15
MCP_CONTRACT_POLL_SECONDS = 0.02


class McpQuiescenceDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(self.coordinator.aclose)
        self.configuration = NativeMcpConfiguration(1, b"{}", ())
        self.coordinator.submit(self.configuration)
        await self.coordinator._worker
        self.host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=2,
            pid=123,
            admission=NativeAdmission(),
            readiness=SimpleNamespace(ready=True),
            configuration_blockers=(NATIVE_COMMAND_UNSETTLED,),
            configuration_quiescence=AsyncMock(return_value=None),
            reload_mcp=AsyncMock(),
            verify_mcp_configuration=AsyncMock(return_value=NativeMcpInventory("verified")),
        )
        self.coordinator.register("diagnostic-host", self.host)

    async def test_quiescence_wait_logs_only_changed_safe_state(self) -> None:
        with self.assertLogs("scholarseed_codex.coordination", level="INFO") as logs:
            self.assertFalse(await self.coordinator._apply(self.configuration))
            self.assertFalse(await self.coordinator._apply(self.configuration))
            self.host.configuration_blockers = (NATIVE_CALLBACK_PENDING,)
            self.assertFalse(await self.coordinator._apply(self.configuration))
            self.host.process_generation = 3
            self.assertFalse(await self.coordinator._apply(self.configuration))
            changed = replace(self.configuration, revision=2)
            self.coordinator._desired = changed
            self.assertFalse(await self.coordinator._apply(changed))
        self.assertEqual(len(logs.records), 4)
        self.assertIn("host_id=diagnostic-host", logs.output[0])
        self.assertIn("generation=2", logs.output[0])
        self.assertIn("revision=1", logs.output[0])
        self.assertIn("admission_active=0", logs.output[0])
        self.assertIn("native_command_unsettled", logs.output[0])
        self.assertIn("native_callback_pending", logs.output[1])
        self.assertIn("generation=3", logs.output[2])
        self.assertIn("revision=2", logs.output[3])
        self.assertNotIn(str(Path.cwd()), " ".join(logs.output))
        self.assertTrue(self.host.admission.accepting)
        self.host.reload_mcp.assert_not_awaited()
        self.host.verify_mcp_configuration.assert_not_awaited()

    async def test_resolved_wait_does_not_suppress_a_later_identical_wait(self) -> None:
        with self.assertLogs("scholarseed_codex.coordination", level="INFO") as logs:
            self.assertFalse(await self.coordinator._apply(self.configuration))
            self.host.configuration_quiescence.return_value = NativeQuiescence(1, 2, 0, 1)
            self.assertTrue(await self.coordinator._apply(self.configuration))
            self.assertTrue(self.host.admission.accepting)
            entry = self.coordinator._hosts["diagnostic-host"]
            entry.inventory = NativeMcpInventory()
            entry.applied_revision = MCP_UNAPPLIED_REVISION
            self.host.admission.freeze(1)
            self.host.configuration_quiescence.return_value = None
            self.assertFalse(await self.coordinator._apply(self.configuration))
            self.assertFalse(await self.coordinator._apply(self.configuration))
        self.assertEqual(len(logs.records), 2)
        self.assertEqual(logs.records[0].getMessage(), logs.records[1].getMessage())
        self.assertTrue(self.host.admission.accepting)

    async def test_active_operation_wait_logs_count_without_requesting_quiescence(self) -> None:
        self.host.admission.applied(1)
        with self.assertLogs("scholarseed_codex.coordination", level="INFO") as logs:
            async with self.host.admission.enter():
                self.host.admission.freeze(1)
                self.assertFalse(await self.coordinator._apply(self.configuration))
                self.assertFalse(await self.coordinator._apply(self.configuration))
                self.host.configuration_quiescence.assert_not_awaited()
            self.assertFalse(await self.coordinator._apply(self.configuration))
        self.assertEqual(len(logs.records), 2)
        self.assertIn("admission_active=1", logs.output[0])
        self.assertIn("admission_active=0", logs.output[1])
        self.assertTrue(self.host.admission.accepting)


class McpProjectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        executable = os.environ.get("SCHOLARSEED_CODEX_EXECUTABLE", "")
        if not executable:
            raise RuntimeError("Explicit reviewed binary is required")
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.root = Path(self.home.name).resolve()
        self.path = self.root / "config.toml"
        self.path.touch(mode=0o600)
        self.path.write_text('# retained\nmodel="retained-model"\n', encoding="utf-8")
        environment, arguments = managed_codex_launch(self.root, {}, ())
        self.server = AppServer(
            executable, self.root, environment, _resolve_launch_arguments(arguments, environment)
        )
        self.addCleanup(self.server.close)
        await self.request(
            "initialize",
            {
                "clientInfo": {"name": "mcp-contract", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
        )
        self.server.notify("initialized", {})
        self.activities = Activities()
        self.resource_lease = lambda: self.activities.enter(ActivityDomain.RESOURCE)
        self.provider = CodexRuntimeProvider()
        environment_patch = patch.dict(
            os.environ, {"SCHOLARSEED_CODEX_HOME": str(self.root), "CODEX_SQLITE_HOME": ""}
        )
        environment_patch.start()
        self.addCleanup(environment_patch.stop)
        with (
            patch.object(RuntimeCatalog, "discover", return_value=RuntimeCatalog((self.provider,))),
            patch("service.chat.runtime.selection.enabled_runtimes", return_value=("codex",)),
            patch("service.chat.runtime.selection.resolve_runtime_id", return_value="codex"),
            patch(
                "service.chat.runtime.selection.registrations",
                return_value={"codex": SimpleNamespace(settings={})},
            ),
        ):
            self.discovery = RuntimeDiscovery.discover()
            self.discovery.configure(resource_lease=self.resource_lease)
        self.storage = self.provider._configuration_storage
        self.assertIsNotNone(self.storage)
        self.editor = CodexConfigurationEditor(self.storage, self.root)

    async def request(self, method: str, params: dict) -> dict:
        return await asyncio.to_thread(self.server.request, method, params)

    async def test_replacement_removal_and_unrelated_configuration(self) -> None:
        first = {"first": {"command": "unused", "enabled": False}}
        second = {"second": {"command": "unused-next", "enabled": False}}
        for servers in (first, second, {}):
            version = await asyncio.to_thread(self.editor.publish, servers)
            self.assertTrue(version.startswith("sha256:"))
            payload = self.path.read_text(encoding="utf-8")
            self.assertIn('# retained\nmodel="retained-model"', payload)
            self.assertEqual(tomllib.loads(payload).get("mcp_servers", {}), servers)
            observed = await self.request("config/read", {"includeLayers": True})
            layer = next(row for row in observed["layers"] if row["name"]["type"] == "user")
            self.assertEqual(layer["config"].get("mcp_servers", {}), servers)

    async def test_provider_publication_preserves_mcp_and_other_definitions(self) -> None:
        await asyncio.to_thread(
            self.editor.publish, {"existing": {"command": "unused", "enabled": False}}
        )
        first = {"first": {"name": "first", "wire_api": "responses", "requires_openai_auth": False}}
        second = {
            "second": {
                "name": "second",
                "wire_api": "responses",
                "http_headers": {"x-private": "literal-credential"},
            }
        }
        await asyncio.to_thread(self.editor.publish_provider, first)
        await asyncio.to_thread(self.editor.publish_provider, second)
        configuration = tomllib.loads(self.path.read_text())
        self.assertEqual(configuration["model_providers"], {**first, **second})
        self.assertEqual(
            configuration["mcp_servers"], {"existing": {"command": "unused", "enabled": False}}
        )
        self.assertEqual(configuration["model"], "retained-model")

    async def test_concurrent_external_change_is_not_overwritten(self) -> None:
        original = tomlkit.dumps

        def racing_render(document):
            self.path.write_text('model="external-model"\n', encoding="utf-8")
            return original(document)

        with patch.object(tomlkit, "dumps", racing_render), self.assertRaises(McpProjectionError):
            await asyncio.to_thread(self.editor.publish, {})
        self.assertEqual(self.path.read_text(), 'model="external-model"\n')

    async def test_first_publication_creates_missing_configuration(self) -> None:
        self.path.unlink()
        servers = {"first": {"command": "unused", "enabled": False}}
        version = await asyncio.to_thread(self.editor.publish, servers)
        self.assertTrue(version.startswith("sha256:"))
        self.assertEqual(tomllib.loads(self.path.read_text())["mcp_servers"], servers)

    async def test_native_thread_creation_waits_for_host_configuration(self) -> None:
        environment, arguments = managed_codex_launch(self.root, {}, ())
        host = CodexProcessHost(
            executable=os.environ["SCHOLARSEED_CODEX_EXECUTABLE"],
            launch_cwd=self.root,
            process_environment=environment,
            launch_arguments=arguments,
        )
        self.addAsyncCleanup(host.aclose)
        request = CodexSessionOpenRequest(
            request_id="admission-contract",
            runtime_id="codex",
            cwd=self.root,
            ephemeral=True,
        )
        host.admission.freeze(1)
        opening = asyncio.create_task(host.open_thread(request, None))
        await asyncio.sleep(0)
        self.assertFalse(opening.done())
        self.assertEqual(host.process_generation, 0)
        host.admission.applied(1)
        thread_id, _, _ = await asyncio.wait_for(opening, timeout=15)
        self.assertTrue(thread_id)
        self.assertEqual(host.admission.active, 0)
        self.assertIs(host.attachment(thread_id).turn._admission, host.admission)
        self.assertIsNone(await host.configuration_quiescence(1))
        host.admission.freeze(2)
        ticket = await host.configuration_quiescence(2)
        self.assertIsNotNone(ticket)
        self.assertTrue(host.configuration_quiescence_current(ticket))
        request_id, pending = host._rpc_requests.begin(host.process_generation, "contract")
        pending.mark_written()
        host._rpc_requests.discard(request_id)
        self.assertFalse(host.configuration_quiescence_current(ticket))
        self.assertIsNone(await host.configuration_quiescence(2))
        host._rpc_requests.resolve({"id": request_id, "result": {}}, host.process_generation)
        self.assertTrue(host.configuration_quiescence_current(ticket))
        host.admission.applied(2)
        host.admission.freeze(2)
        self.assertFalse(host.configuration_quiescence_current(ticket))
        ticket = await host.configuration_quiescence(2)
        self.assertIsNotNone(ticket)
        host.admission.freeze(3)
        self.assertFalse(host.configuration_quiescence_current(ticket))
        host.admission.applied(3)
        await host.open_thread(
            replace(request, request_id="persistent-contract", ephemeral=False), None
        )
        host.admission.freeze(4)
        self.assertIsNotNone(await host.configuration_quiescence(4))

    async def test_candidate_projection_reloads_existing_and_new_threads(self) -> None:
        self.server.close()
        environment, arguments = managed_codex_launch(self.root, {}, ())
        resolved = list(_resolve_launch_arguments(arguments, environment))
        override_index = resolved.index(DISABLED_MCP_OVERRIDE)
        self.assertEqual(resolved[override_index - 1], "-c")
        del resolved[override_index - 1 : override_index + 1]
        candidate = AppServer(
            os.environ["SCHOLARSEED_CODEX_EXECUTABLE"],
            self.root,
            environment,
            tuple(resolved),
        )
        self.addCleanup(candidate.close)

        async def request(method, params):
            return await asyncio.to_thread(candidate.request, method, params)

        await request(
            "initialize",
            {
                "clientInfo": {"name": "mcp-reload-contract", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
        )
        candidate.notify("initialized", {})
        threads = []
        for revision in ("one", "two"):
            started = await request("thread/start", {"cwd": str(self.root), "ephemeral": True})
            threads.append(started["thread"]["id"])
            self.assertIs(started["thread"]["ephemeral"], True)
            for method, reason in (
                ("thread/goal/get", "ephemeral thread does not support goals"),
                ("thread/queue/list", "ephemeral thread does not support queued submissions"),
            ):
                with self.assertRaisesRegex(RuntimeError, reason):
                    await request(method, {"threadId": threads[-1]})
            servers = {
                MCP_CONTRACT_SERVER: {
                    "command": sys.executable,
                    "args": [str(Path(__file__).parent / "integration" / "mcp.py"), revision],
                }
            }
            await asyncio.to_thread(self.editor.publish, servers)
            await request("config/mcpServer/reload", {})
            for thread_id in threads:
                inventory = await request(
                    "mcpServerStatus/list", {"threadId": thread_id, "detail": "toolsAndAuthOnly"}
                )
                self.assertEqual([row["name"] for row in inventory["data"]], [MCP_CONTRACT_SERVER])
                result = await request(
                    "mcpServer/tool/call",
                    {
                        "threadId": thread_id,
                        "server": MCP_CONTRACT_SERVER,
                        "tool": MCP_CONTRACT_TOOL,
                        "arguments": {},
                    },
                )
                self.assertEqual(result["content"][0]["text"], revision)
        await asyncio.to_thread(self.editor.publish, {})
        await request("config/mcpServer/reload", {})
        for thread_id in threads:
            inventory = await request("mcpServerStatus/list", {"threadId": thread_id})
            self.assertEqual(inventory["data"], [])

    async def test_host_reload_verifies_all_threads_and_invalidates_caches(self) -> None:
        self.server.close()
        environment, arguments = managed_codex_launch(self.root, {}, ())
        pool = CodexHostPool()
        self.addAsyncCleanup(pool.aclose)
        sessions = []
        for request_id in ("first", "second"):
            session = CodexThreadSession(
                CodexSessionOpenRequest(
                    request_id=request_id,
                    runtime_id="codex",
                    cwd=self.root,
                    ephemeral=True,
                    executable=os.environ["SCHOLARSEED_CODEX_EXECUTABLE"],
                    process_environment=environment,
                    launch_arguments=tuple(
                        argument
                        for argument in arguments
                        if argument.value != DISABLED_MCP_OVERRIDE
                    ),
                ),
                host_pool=pool,
            )
            await session.open()
            self.assertEqual((await session.mcp_control.snapshot()).servers, ())
            sessions.append(session)
        host = sessions[0].host
        self.assertIs(sessions[1].host, host)
        for revision, value in enumerate(("one", "two", ""), start=1):
            servers = (
                {
                    MCP_CONTRACT_SERVER: {
                        "command": sys.executable,
                        "args": [str(Path(__file__).parent / "integration" / "mcp.py"), value],
                    }
                }
                if value
                else {}
            )
            host.admission.freeze(revision)
            async with asyncio.timeout(MCP_CONTRACT_TIMEOUT):
                while (ticket := await host.configuration_quiescence(revision)) is None:
                    await asyncio.sleep(MCP_CONTRACT_POLL_SECONDS)
            await asyncio.to_thread(self.editor.publish, servers)
            await host.reload_mcp(ticket)
            async with asyncio.timeout(MCP_CONTRACT_TIMEOUT):
                while True:
                    inventory = await host.verify_mcp_configuration(ticket, frozenset(servers))
                    if inventory.revision:
                        break
                    await asyncio.sleep(MCP_CONTRACT_POLL_SECONDS)
            self.assertFalse(inventory.safe_error)
            host.admission.applied(revision)
            for session in sessions:
                snapshot = await session.mcp_control.snapshot()
                self.assertEqual({row.name for row in snapshot.servers}, set(servers))
                if value:
                    result = await session.mcp_control.call_tool(
                        McpToolCallRequest(
                            server=MCP_CONTRACT_SERVER, tool=MCP_CONTRACT_TOOL, arguments={}
                        )
                    )
                    self.assertTrue(result.ok)
                    self.assertEqual(result.content[0]["text"], value)

    async def test_pool_applies_shared_projection_to_shared_host_threads(self) -> None:
        self.server.close()
        pool = self.provider._pool
        self.addAsyncCleanup(pool.aclose)
        await self.provider.configure_mcp(McpConfigurationRequest(0, ()))
        environment, arguments = managed_codex_launch(self.root, {}, ())
        sessions = []
        for request_id in ("first-host", "second-host"):
            session = CodexThreadSession(
                CodexSessionOpenRequest(
                    request_id=request_id,
                    runtime_id="codex",
                    cwd=self.root,
                    execution_scope=request_id,
                    process_sharing_scope="mcp-contract-owner",
                    executable=os.environ["SCHOLARSEED_CODEX_EXECUTABLE"],
                    process_environment=environment,
                    launch_arguments=arguments,
                ),
                host_pool=pool,
            )
            await session.open()
            sessions.append(session)
        self.assertIs(sessions[0].host, sessions[1].host)
        for revision, value in enumerate(("one", "two", ""), start=1):
            servers = (
                (
                    McpServerConfiguration(
                        MCP_CONTRACT_SERVER,
                        McpStdioTransport(
                            sys.executable,
                            (str(Path(__file__).parent / "integration" / "mcp.py"), value),
                        ),
                    ),
                )
                if value
                else ()
            )
            configuration = McpConfigurationRequest(revision, servers)
            joining = None
            async with sessions[0].host.admission.enter():
                receipt = await self.provider.configure_mcp(configuration)
                if revision == 1:
                    session = CodexThreadSession(
                        replace(
                            sessions[0].request,
                            request_id="joining-host",
                            execution_scope="joining-host",
                        ),
                        host_pool=pool,
                    )
                    sessions.append(session)
                    joining = asyncio.create_task(session.open())
                async with asyncio.timeout(MCP_CONTRACT_TIMEOUT):
                    while pool._mcp._published.revision != revision:
                        await asyncio.sleep(MCP_CONTRACT_POLL_SECONDS)
                    if joining is not None:
                        await joining
                self.assertEqual(
                    set(tomllib.loads(self.path.read_text())["mcp_servers"]),
                    {MCP_CONTRACT_SERVER} if value else set(),
                )
            self.assertEqual(receipt.desired_revision, revision)
            self.assertTrue(all(row.state is McpApplicationState.PENDING for row in receipt.hosts))
            async with asyncio.timeout(MCP_CONTRACT_TIMEOUT):
                while True:
                    receipt = await self.provider.mcp_configuration()
                    self.assertFalse(receipt.safe_error)
                    if len(receipt.hosts) == 1 and all(
                        row.state is McpApplicationState.READY for row in receipt.hosts
                    ):
                        break
                    await asyncio.sleep(MCP_CONTRACT_POLL_SECONDS)
            if joining is not None:
                await asyncio.wait_for(joining, MCP_CONTRACT_TIMEOUT)
            self.assertTrue(all(session.host is sessions[0].host for session in sessions))
            if revision == 2:
                async with sessions[0].host.admission.enter():
                    receipt = await asyncio.wait_for(
                        sessions[0].mcp_control.reload(McpReloadRequest()),
                        MCP_CONTRACT_TIMEOUT,
                    )
                    self.assertEqual(receipt.desired_revision, revision)
                    self.assertTrue(
                        all(row.state is McpApplicationState.PENDING for row in receipt.hosts)
                    )
                async with asyncio.timeout(MCP_CONTRACT_TIMEOUT):
                    while True:
                        receipt = await self.provider.mcp_configuration()
                        if all(row.state is McpApplicationState.READY for row in receipt.hosts):
                            break
                        await asyncio.sleep(MCP_CONTRACT_POLL_SECONDS)
            for session in sessions:
                snapshot = await session.mcp_control.snapshot()
                self.assertEqual(len(snapshot.servers), int(bool(value)))
                if value:
                    result = await session.mcp_control.call_tool(
                        McpToolCallRequest(
                            server=MCP_CONTRACT_SERVER, tool=MCP_CONTRACT_TOOL, arguments={}
                        )
                    )
                    self.assertEqual(result.content[0]["text"], value)

    async def test_changed_file_declaration_rejects_before_configuration(self) -> None:
        with patch.object(
            self.provider, "configuration_files", return_value=(self.root / "other.toml",)
        ):
            with self.assertRaises(RuntimeGatewayError):
                self.discovery.configure()
        self.assertFalse((self.root / "other.toml").exists())

    async def test_repeated_configuration_preserves_storage_identity(self) -> None:
        self.discovery.configure(resource_lease=self.resource_lease)
        self.assertIs(self.provider._configuration_storage, self.storage)
        with self.assertRaises(RuntimeGatewayError):
            self.discovery.configure(
                resource_lease=lambda: self.activities.enter(ActivityDomain.RESOURCE)
            )
        self.assertIs(self.provider._configuration_storage, self.storage)

    async def test_outside_root_declaration_is_rejected(self) -> None:
        with patch.object(
            self.provider, "configuration_files", return_value=(self.root.parent / "other.toml",)
        ):
            with self.assertRaises(RuntimeGatewayError):
                self.discovery.revalidate_storage()

    async def test_host_maintenance_denies_publication(self) -> None:
        before = self.path.read_bytes()
        self.activities.begin()
        with self.assertRaises(MaintenanceActive):
            self.storage.update(self.path, lambda _: b"forbidden")
        self.assertEqual(self.path.read_bytes(), before)

    async def test_skill_settings_and_comments_survive_mcp_replacement(self) -> None:
        original = (
            '# independent settings\nmodel="retained-model"\n'
            'mcp_servers = {old = {command="unused", enabled=false}}\n'
            "\n# keep skill preference\n[[skills.config]]\n"
            'path="/example/skill"\nenabled=false\n'
        )
        self.path.write_text(original, encoding="utf-8")
        servers = {"含点.name": {"command": "unused", "args": ["a\\b", '"quoted"']}}
        await asyncio.to_thread(self.editor.publish, servers)
        payload = self.path.read_text(encoding="utf-8")
        expected = {**tomllib.loads(original), "mcp_servers": servers}
        self.assertEqual(tomllib.loads(payload), expected)
        self.assertIn("# keep skill preference", payload)
        self.assertIn("# independent settings", payload)

    async def test_invalid_existing_document_is_not_replaced(self) -> None:
        for payload in (b"broken = [", b"\xff"):
            self.path.write_bytes(payload)
            with self.subTest(payload=payload), self.assertRaises(McpProjectionError):
                await asyncio.to_thread(self.editor.publish, {})
            self.assertEqual(self.path.read_bytes(), payload)

    async def test_native_editor_rejects_independent_stage(self) -> None:
        original_payload = self.path.read_bytes()
        stage = self.root / "staged.toml"
        stage.write_bytes(original_payload)
        previous = await self.request("config/read", {"includeLayers": True})
        version = next(
            layer["version"] for layer in previous["layers"] if layer["name"]["type"] == "user"
        )
        servers = {"staged": {"command": "unused", "enabled": False}}
        with self.assertRaisesRegex(RuntimeError, "configLayerReadonly"):
            await self.request(
                "config/batchWrite",
                {
                    "edits": [
                        {"keyPath": "mcp_servers", "mergeStrategy": "replace", "value": servers}
                    ],
                    "filePath": str(stage),
                    "expectedVersion": version,
                    "reloadUserConfig": False,
                },
            )
        self.assertEqual(self.path.read_bytes(), original_payload)
        self.assertEqual(stage.read_bytes(), original_payload)

    @unittest.skipIf(os.name == "nt", "Windows reparse validation requires its native target")
    async def test_symlink_swap_before_publication_does_not_modify_target(self) -> None:
        target = self.root / "unrelated.toml"
        original_payload = self.path.read_bytes()
        target.write_bytes(original_payload)
        original = DirectoryHandle.replace_private

        def racing_replace(directory, source, destination, **options):
            self.path.unlink()
            self.path.symlink_to(target)
            return original(directory, source, destination, **options)

        with patch.object(DirectoryHandle, "replace_private", racing_replace):
            await asyncio.to_thread(
                self.editor.publish, {"requested": {"command": "unused", "enabled": False}}
            )
        self.assertEqual(target.read_bytes(), original_payload)
        self.assertFalse(self.path.is_symlink())

    async def test_wrong_runtime_home_is_rejected_before_write(self) -> None:
        editor = CodexConfigurationEditor(self.storage, self.root / "not-the-native-home")
        before = self.path.read_bytes()
        with self.assertRaises(McpProjectionError):
            await asyncio.to_thread(editor.publish, {})
        self.assertEqual(self.path.read_bytes(), before)

    @unittest.skipIf(os.name == "nt", "Windows reparse validation requires its native target")
    async def test_existing_symlink_is_rejected_without_touching_target(self) -> None:
        target = self.root / "unrelated.toml"
        target.write_text('model="unrelated"\n', encoding="utf-8")
        self.path.unlink()
        self.path.symlink_to(target)
        with self.assertRaises(McpProjectionError):
            await asyncio.to_thread(self.editor.publish, {})
        self.assertEqual(target.read_text(), 'model="unrelated"\n')


if __name__ == "__main__":
    unittest.main()
