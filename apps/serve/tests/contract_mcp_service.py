"""Deterministic MCP settings service and HTTP contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import os
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

from scholarseed_runtime.contract.mcp import (
    MCP_CONFIGURATION_UNSUPPORTED,
    McpApplicationState,
    McpConfigurationReceipt,
    McpConfigurationRequest,
    McpHostApplication,
    McpServerObservation,
    McpServerState,
)
from service.chat.api.mcp import MCP_SETTINGS_ROUTE, mount_mcp_routes
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV
from service.platform.activity import Activities
from service.platform.mcp import McpHttpServer
from service.settings.mcp import (
    MCP_APPLICATION_FAILED,
    McpConfigurationConflict,
    McpConfigurationError,
    McpConfigurationService,
    McpConfigurationStore,
    McpConfigurationUnsupported,
    McpDocument,
    McpState,
)
from tests._host import USER_ID, HostContextFixture

HOST_KEY = "test-host-key"
SERVER_URL = "https://example.invalid/mcp"
PUBLICATION_TEST_TIMEOUT_SECONDS = 5


class McpServerStatusTests(unittest.TestCase):
    def document(self):
        return McpDocument(
            revision=3,
            servers=(
                McpHttpServer(id="healthy", url=SERVER_URL),
                McpHttpServer(id="broken", url=SERVER_URL),
                McpHttpServer(id="disabled", url=SERVER_URL, enabled=False),
            ),
        )

    def test_mixed_observations_and_disabled_declaration_remain_independent(self):
        receipt = McpConfigurationReceipt(
            3,
            (
                McpHostApplication(
                    "host",
                    1,
                    3,
                    3,
                    McpApplicationState.FAILED,
                    servers=(
                        McpServerObservation("healthy", McpServerState.READY, 2),
                        McpServerObservation(
                            "broken", McpServerState.FAILED, safe_error="safe_failure"
                        ),
                    ),
                ),
            ),
        )
        view = McpConfigurationService._view(self.document(), receipt)
        statuses = {server.id: server for server in view.servers}
        self.assertEqual(view.state, McpState.FAILED)
        self.assertEqual(view.safe_error, "")
        self.assertEqual(statuses["healthy"].state, McpState.READY)
        self.assertEqual(statuses["healthy"].tool_count, 2)
        self.assertEqual(statuses["broken"].state, McpState.FAILED)
        self.assertEqual(statuses["disabled"].state, McpState.DISABLED)

    def test_server_failure_does_not_repeat_as_global_error(self):
        receipt = McpConfigurationReceipt(
            3,
            (
                McpHostApplication(
                    "host",
                    1,
                    3,
                    3,
                    McpApplicationState.FAILED,
                    safe_error="safe_failure",
                    servers=(
                        McpServerObservation(
                            "broken", McpServerState.FAILED, safe_error="safe_failure"
                        ),
                    ),
                ),
            ),
        )
        self.assertEqual(McpConfigurationService._view(self.document(), receipt).safe_error, "")
        global_failure = replace(receipt, safe_error="publication_failed")
        self.assertEqual(
            McpConfigurationService._view(self.document(), global_failure).safe_error,
            MCP_APPLICATION_FAILED,
        )
        unexplained_host = replace(receipt.hosts[0], safe_error="inventory_mismatch")
        self.assertEqual(
            McpConfigurationService._view(
                self.document(), replace(receipt, hosts=(unexplained_host,))
            ).safe_error,
            MCP_APPLICATION_FAILED,
        )

    def test_reload_observations_distinguish_reconnecting_from_changed_servers(self):
        receipt = McpConfigurationReceipt(
            3,
            (
                McpHostApplication(
                    "host",
                    1,
                    3,
                    2,
                    McpApplicationState.PENDING,
                    servers=(McpServerObservation("healthy", McpServerState.CONNECTING),),
                ),
            ),
        )
        statuses = McpConfigurationService._view(self.document(), receipt).servers
        self.assertEqual(statuses[0].state, McpState.CONNECTING)
        self.assertIsNone(statuses[0].tool_count)
        self.assertEqual(statuses[1].state, McpState.PENDING_APPLY)
        self.assertEqual(statuses[2].state, McpState.DISABLED)

    def test_stale_or_missing_observations_do_not_inherit_global_ready(self):
        for observed_host in (
            McpHostApplication("host", 1, 3, 3, McpApplicationState.READY),
            McpHostApplication(
                "host",
                1,
                3,
                2,
                McpApplicationState.READY,
                servers=(McpServerObservation("healthy", McpServerState.READY, 1),),
            ),
        ):
            with self.subTest(host=observed_host):
                view = McpConfigurationService._view(
                    self.document(), McpConfigurationReceipt(3, (observed_host,))
                )
                self.assertEqual(view.servers[0].state, McpState.PENDING_APPLY)
                self.assertIsNone(view.servers[0].tool_count)

    def test_cross_host_authentication_failure_wins_and_tool_count_is_conservative(self):
        hosts = tuple(
            McpHostApplication(
                str(index),
                1,
                3,
                3,
                McpApplicationState.READY,
                servers=(
                    McpServerObservation("healthy", McpServerState.READY, count),
                    McpServerObservation(
                        "broken",
                        state,
                        safe_error="safe_auth" if state is McpServerState.AUTH_REQUIRED else "",
                    ),
                ),
            )
            for index, count, state in (
                (1, 3, McpServerState.READY),
                (2, 1, McpServerState.AUTH_REQUIRED),
            )
        )
        view = McpConfigurationService._view(self.document(), McpConfigurationReceipt(3, hosts))
        self.assertEqual(view.servers[0].tool_count, 1)
        self.assertEqual(view.servers[1].state, McpState.AUTH_REQUIRED)


class RuntimeProbe:
    def __init__(self) -> None:
        self.receipt = McpConfigurationReceipt(desired_revision=0)
        self.requests: list[McpConfigurationRequest] = []
        self.fail = False
        self.ready = False
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def configure_mcp(self, request: McpConfigurationRequest) -> McpConfigurationReceipt:
        self.requests.append(request)
        self.started.set()
        await self.release.wait()
        if self.fail:
            raise RuntimeError("sensitive-native-error")
        self.receipt = McpConfigurationReceipt(
            desired_revision=request.revision,
            hosts=(host(request.revision, McpApplicationState.READY),) if self.ready else (),
        )
        return self.receipt

    async def mcp_configuration(self) -> McpConfigurationReceipt:
        return self.receipt


def host(
    revision: int, state: McpApplicationState, *, identifier: str = "host"
) -> McpHostApplication:
    return McpHostApplication(identifier, 1, revision, revision, state)


class McpServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_settings_wait_returns_final_observation_without_resubmitting(self) -> None:
        initial = await self.service.replace((self.server,), expected_revision=0)
        final = initial.model_copy(
            update={
                "state": McpState.READY,
                "servers": tuple(
                    server.model_copy(update={"state": McpState.READY, "tool_count": 1})
                    for server in initial.servers
                ),
            }
        )
        with patch.object(self.service, "status", AsyncMock(return_value=final)) as status:
            self.assertEqual(await self.service.wait_application(initial), final)
        status.assert_awaited_once()
        self.assertEqual(len(self.runtime.requests), 1)

    async def test_settings_wait_preserves_timeout_snapshot_and_saved_revision(self) -> None:
        initial = await self.service.replace((self.server,), expected_revision=0)
        with patch("service.settings.mcp.MCP_APPLICATION_WAIT_SECONDS", 0):
            self.assertEqual(await self.service.wait_application(initial), initial)
        self.assertEqual(self.store.read().revision, initial.configuration.revision)

    async def test_settings_wait_stops_on_superseding_revision_or_global_failure(self) -> None:
        initial = await self.service.replace((self.server,), expected_revision=0)
        for final in (
            initial.model_copy(
                update={"configuration": initial.configuration.model_copy(update={"revision": 2})}
            ),
            initial.model_copy(update={"safe_error": MCP_APPLICATION_FAILED}),
        ):
            with patch.object(self.service, "status", AsyncMock(return_value=final)) as status:
                self.assertEqual(await self.service.wait_application(initial), final)
            status.assert_awaited_once()

    async def asyncSetUp(self) -> None:
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.store = McpConfigurationStore(Path(self.home.name) / "mcp.json")
        self.runtime = RuntimeProbe()
        self.service = McpConfigurationService(
            self.store, lambda: self.runtime, activities=Activities()
        )
        self.server = McpHttpServer(id="example", url=SERVER_URL)

    async def test_publication_guard_runs_on_event_loop_not_file_worker(self) -> None:
        owner_thread = threading.get_ident()
        authorization_threads = []

        def authorize():
            authorization_threads.append(threading.get_ident())

        result = await self.service.replace(
            (self.server,), expected_revision=0, authorize=authorize
        )
        self.assertEqual(result.configuration.revision, 1)
        self.assertEqual(len(authorization_threads), 3)
        self.assertTrue(all(identity == owner_thread for identity in authorization_threads))

    async def test_revoked_scope_after_preparation_cannot_publish(self) -> None:
        allowed = True
        prepared = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = self.store.prepare

        def authorize():
            if not allowed:
                raise PermissionError("scope expired")

        def prepare(*args, **kwargs):
            publication = original(*args, **kwargs)
            loop.call_soon_threadsafe(prepared.set)
            release.wait(PUBLICATION_TEST_TIMEOUT_SECONDS)
            return publication

        with patch.object(self.store, "prepare", side_effect=prepare):
            applying = asyncio.create_task(
                self.service.replace((self.server,), expected_revision=0, authorize=authorize)
            )
            try:
                await asyncio.wait_for(prepared.wait(), PUBLICATION_TEST_TIMEOUT_SECONDS)
                allowed = False
            finally:
                release.set()
            with self.assertRaises(PermissionError):
                await applying
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.runtime.requests, [])
        self.assertEqual(list(self.store.path.parent.glob(".mcp-*")), [])

    async def test_prepared_publication_rechecks_current_config_before_commit(self) -> None:
        publication = self.store.prepare((self.server,), expected_revision=0)
        try:
            other = self.store.decode(b'{"revision":3}')
            self.store.path.touch(mode=0o600)
            self.store.path.write_bytes(other.model_dump_json().encode())
            with self.assertRaises(McpConfigurationConflict):
                publication.publish(lambda: None)
        finally:
            publication.close()
        self.assertEqual(self.store.read().revision, 3)
        self.assertEqual(list(self.store.path.parent.glob(".mcp-*")), [])

    async def test_reconcile_replays_saved_revision_without_rewriting(self) -> None:
        document = self.store.replace((self.server,), expected_revision=0)
        before = self.store.path.read_bytes()
        result = await self.service.reconcile()
        self.assertEqual(result.configuration, document)
        self.assertEqual(result.state, McpState.PENDING_APPLY)
        self.assertEqual(self.runtime.requests[0].revision, document.revision)
        self.assertEqual(self.store.path.read_bytes(), before)

    async def test_reconcile_missing_file_applies_empty_without_creating_file(self) -> None:
        result = await self.service.reconcile()
        self.assertEqual(result.configuration.revision, 0)
        self.assertEqual(self.runtime.requests[0].servers, ())
        self.assertFalse(self.store.path.exists())

    async def test_reconcile_corrupt_file_does_not_apply_empty_fallback(self) -> None:
        self.store.path.touch(mode=0o600)
        self.store.path.write_bytes(b"{broken")
        with self.assertRaises(McpConfigurationError):
            await self.service.reconcile()
        self.assertEqual(self.runtime.requests, [])
        self.assertEqual(self.store.path.read_bytes(), b"{broken")

    async def test_reconcile_failure_is_retryable_without_new_revision(self) -> None:
        self.store.replace((self.server,), expected_revision=0)
        self.runtime.fail = True
        self.assertEqual((await self.service.reconcile()).state, McpState.FAILED)
        self.runtime.fail = False
        result = await self.service.reconcile()
        self.assertEqual(result.state, McpState.PENDING_APPLY)
        self.assertEqual([request.revision for request in self.runtime.requests], [1, 1])
        self.assertEqual(self.store.read().revision, 1)

    async def test_startup_preserves_invalid_configuration_without_applying(self) -> None:
        self.store.path.touch(mode=0o600)
        self.store.path.write_bytes(b"{broken")
        with self.assertLogs("service.settings.mcp", level="ERROR") as captured:
            await self.service.start()
        self.assertEqual(self.runtime.requests, [])
        self.assertEqual(self.store.path.read_bytes(), b"{broken")
        self.assertNotIn("{broken", "".join(captured.output))

    async def test_reconcile_is_serialized_before_next_save(self) -> None:
        self.store.replace((self.server,), expected_revision=0)
        self.runtime.release.clear()
        reconciliation = asyncio.create_task(self.service.reconcile())
        await self.runtime.started.wait()
        saving = asyncio.create_task(self.service.replace((), expected_revision=1))
        await asyncio.sleep(0)
        self.assertEqual(self.store.read().revision, 1)
        self.runtime.release.set()
        await reconciliation
        await saving
        self.assertEqual([request.revision for request in self.runtime.requests], [1, 2])

    async def test_save_without_observed_hosts_is_pending(self) -> None:
        result = await self.service.replace((self.server,), expected_revision=0)
        self.assertEqual(result.state, McpState.PENDING_APPLY)
        self.assertEqual(self.store.read().revision, 1)
        self.assertEqual(self.runtime.requests[0].servers[0].name, self.server.id)

    async def test_unsupported_runtime_rejects_before_writing(self) -> None:
        service = McpConfigurationService(self.store, lambda: None, activities=Activities())
        self.assertFalse((await service.status()).supported)
        with self.assertRaises(McpConfigurationUnsupported):
            await service.replace((self.server,), expected_revision=0)
        self.assertFalse(self.store.path.exists())

    async def test_present_but_unauthorized_runtime_rejects_before_writing(self) -> None:
        self.runtime.receipt = McpConfigurationReceipt(0, safe_error=MCP_CONFIGURATION_UNSUPPORTED)
        self.assertFalse((await self.service.status()).supported)
        with self.assertRaises(McpConfigurationUnsupported):
            await self.service.replace((self.server,), expected_revision=0)
        self.assertFalse(self.store.path.exists())
        self.assertEqual(self.runtime.requests, [])

    async def test_ready_requires_every_current_host(self) -> None:
        await self.service.replace((self.server,), expected_revision=0)
        self.runtime.receipt = McpConfigurationReceipt(
            1,
            (
                host(1, McpApplicationState.READY),
                host(0, McpApplicationState.READY, identifier="old"),
            ),
        )
        self.assertEqual((await self.service.status()).state, McpState.PENDING_APPLY)
        self.runtime.receipt = McpConfigurationReceipt(1, (host(1, McpApplicationState.READY),))
        self.assertEqual((await self.service.status()).state, McpState.READY)

    async def test_failure_preserves_desired_configuration_and_redacts_error(self) -> None:
        self.runtime.fail = True
        result = await self.service.replace((self.server,), expected_revision=0)
        self.assertEqual(result.state, McpState.FAILED)
        self.assertEqual(result.safe_error, MCP_APPLICATION_FAILED)
        self.assertNotIn("sensitive-native-error", result.model_dump_json())
        self.assertEqual(self.store.read().servers, (self.server,))

    async def test_stale_failed_receipt_cannot_override_new_configuration(self) -> None:
        await self.service.replace((self.server,), expected_revision=0)
        self.runtime.receipt = McpConfigurationReceipt(0, safe_error="old-failure")
        self.assertEqual((await self.service.status()).state, McpState.PENDING_APPLY)

    async def test_later_save_overwrites_stale_revision(self) -> None:
        await self.service.replace((self.server,), expected_revision=0)
        result = await self.service.replace((), expected_revision=0)
        self.assertEqual(result.configuration.revision, 2)
        self.assertEqual(result.configuration.servers, ())
        self.assertEqual(len(self.runtime.requests), 2)

    async def test_contradictory_host_error_is_not_ready(self) -> None:
        await self.service.replace((self.server,), expected_revision=0)
        self.runtime.receipt = McpConfigurationReceipt(
            1, (replace(host(1, McpApplicationState.READY), safe_error="native-error"),)
        )
        self.assertEqual((await self.service.status()).state, McpState.FAILED)

    async def test_another_writer_advancing_revision_prevents_stale_ready(self) -> None:
        self.runtime.ready = True
        self.runtime.release.clear()
        first = asyncio.create_task(self.service.replace((self.server,), expected_revision=0))
        await self.runtime.started.wait()
        second_runtime = RuntimeProbe()
        second_service = McpConfigurationService(
            McpConfigurationStore(self.store.path), lambda: second_runtime, activities=Activities()
        )
        await second_service.replace((), expected_revision=1)
        self.runtime.release.set()
        result = await first
        self.assertEqual(result.configuration.revision, 2)
        self.assertEqual(result.state, McpState.PENDING_APPLY)

    async def test_missing_secret_resolver_rejects_before_write(self) -> None:
        protected = McpHttpServer(
            id="protected", url=SERVER_URL, header_secrets={"Authorization": "opaque-ref"}
        )
        with self.assertRaisesRegex(ValueError, "mcp_credentials_unavailable"):
            await self.service.replace((protected,), expected_revision=0)
        self.assertFalse(self.store.path.exists())

    async def test_cancellation_waits_for_inflight_apply_before_releasing_serialization(
        self,
    ) -> None:
        self.runtime.release.clear()
        task = asyncio.create_task(self.service.replace((self.server,), expected_revision=0))
        await self.runtime.started.wait()
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.runtime.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.store.read().revision, 1)
        self.assertEqual((await self.service.status()).state, McpState.PENDING_APPLY)

    async def test_http_requires_host_and_never_echoes_invalid_input(self) -> None:
        app = FastAPI()
        app.state.host_context_fixture = HostContextFixture(Path.cwd())
        app.state.runtime_service = SimpleNamespace(
            host_control=app.state.host_context_fixture.control
        )

        @app.middleware("http")
        async def actor(request, call_next):
            request.state.user_id = USER_ID
            return await call_next(request)

        mount_mcp_routes(app, self.service)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            with patch.dict(os.environ, {HOST_PROCESS_KEY_ENV: HOST_KEY}):
                denied = await client.get(MCP_SETTINGS_ROUTE)
                self.assertEqual(denied.status_code, 403)
                self.assertFalse(app.state.host_context_fixture.calls)
                invalid = await client.put(
                    MCP_SETTINGS_ROUTE,
                    headers={HOST_PROCESS_HEADER: HOST_KEY},
                    json={"expected_revision": 0, "servers": [{"secret": "do-not-echo"}]},
                )
                self.assertEqual(invalid.status_code, 422)
                self.assertNotIn("do-not-echo", invalid.text)
                saved = await client.put(
                    MCP_SETTINGS_ROUTE,
                    headers={HOST_PROCESS_HEADER: HOST_KEY},
                    json={"expected_revision": 0, "servers": [self.server.model_dump(mode="json")]},
                )
                self.assertEqual(saved.status_code, 200, saved.text)
                self.assertEqual(saved.json()["state"], McpState.PENDING_APPLY)
                self.assertEqual(len(app.state.host_context_fixture.calls), 1)
                host = app.state.host_context_fixture.calls[0][0]
                self.assertEqual(host.process_sharing_scope, USER_ID)


if __name__ == "__main__":
    unittest.main()
