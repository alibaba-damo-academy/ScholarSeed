"""Host admission contracts, separate from native idle and product acceptance."""

from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from scholarseed_codex.admission import NativeAdmission, NativeQuiescence
from scholarseed_codex.configuration import NativeMcpConfiguration
from scholarseed_codex.coordination import (
    MCP_APPLICATION_FAILED,
    MCP_COORDINATOR_CLOSED,
    MCP_HOST_ALREADY_REGISTERED,
    MCP_UNAPPLIED_REVISION,
    McpCoordinator,
)
from scholarseed_codex.environment import CODEX_HOME_ENV
from scholarseed_codex.isolation import (
    CONFIG_OPTION,
    MCP_DISABLED_OVERRIDE,
    STRICT_CONFIG_OPTION,
    projected_mcp_arguments,
)
from scholarseed_codex.mcp import MCP_INVENTORY_PENDING, MCP_STARTUP_ERROR, NativeMcpInventory
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.rpc import JsonLineWriter, PendingRequests, RpcSubmission, RpcSubmissionState
from scholarseed_runtime.contract.mcp import (
    McpApplicationState,
    McpServerObservation,
    McpServerState,
)


class McpProjectionArgumentTests(unittest.TestCase):
    def test_only_managed_disable_override_is_removed(self) -> None:
        arguments = (
            STRICT_CONFIG_OPTION,
            CONFIG_OPTION,
            "model=unquoted-native-model",
            CONFIG_OPTION,
            MCP_DISABLED_OVERRIDE,
        )
        self.assertEqual(projected_mcp_arguments(arguments), arguments[:-2])

    def test_other_mcp_overrides_and_missing_isolation_are_rejected(self) -> None:
        prefix = (STRICT_CONFIG_OPTION, CONFIG_OPTION, MCP_DISABLED_OVERRIDE)
        cases = (
            prefix + (CONFIG_OPTION, MCP_DISABLED_OVERRIDE),
            prefix + (CONFIG_OPTION, 'mcp_servers.other.command="unsafe"'),
            prefix + (CONFIG_OPTION, '"mcp_servers".other.command="unsafe"'),
            prefix + ("--config=mcp_servers={}",),
            prefix + ("-cmcp_servers={}",),
            prefix + (CONFIG_OPTION,),
            (STRICT_CONFIG_OPTION,),
            (CONFIG_OPTION, MCP_DISABLED_OVERRIDE),
        )
        for arguments in cases:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                projected_mcp_arguments(arguments)


class McpCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_configuration_reload_runs_during_active_execution(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
        await coordinator._worker
        admission = NativeAdmission()
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=2,
            pid=1,
            admission=admission,
            readiness=SimpleNamespace(ready=True),
            configuration_quiescence=AsyncMock(return_value=None),
            mcp_launch_matches=Mock(return_value=True),
            reload_mcp=AsyncMock(),
        )
        coordinator.register("active", host)
        admission.applied(1)
        epoch = admission.epoch
        async with admission.enter():
            coordinator.submit(NativeMcpConfiguration(2, b"{}", ()))
            await asyncio.wait_for(asyncio.shield(coordinator._worker), 0.5)
            host.reload_mcp.assert_awaited_once_with(2)
            host.configuration_quiescence.assert_not_awaited()
            self.assertTrue(admission.accepting)
            self.assertEqual(admission.active, 1)
            self.assertEqual(admission.epoch, epoch)
            self.assertEqual(coordinator._hosts["active"].applied_revision, 2)

    async def test_busy_host_does_not_block_publication_or_new_host(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(0, b"{}", ()))
        await coordinator._worker
        admission = NativeAdmission()
        busy = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            thread_count=1,
            admission=admission,
            readiness=SimpleNamespace(ready=True),
            configuration_quiescence=AsyncMock(return_value=None),
            reload_mcp=AsyncMock(),
        )
        coordinator.register("busy", busy)
        admission.applied(0)
        coordinator.submit(NativeMcpConfiguration(3, b'{"disabled":{"enabled":false}}', ()))
        await asyncio.sleep(0.2)
        self.assertTrue(admission.accepting)
        self.assertEqual(coordinator._published.revision, 3)
        incoming = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=2,
            thread_count=0,
            admission=NativeAdmission(),
            readiness=SimpleNamespace(ready=True),
            verify_mcp_startup=AsyncMock(return_value=NativeMcpInventory("verified")),
        )
        coordinator.register("incoming", incoming)
        async with asyncio.timeout(1):
            async with coordinator.startup("incoming"):
                pass
            async with incoming.admission.enter():
                self.assertTrue(incoming.admission.accepting)

    async def test_slow_mcp_inventory_does_not_delay_startup(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
        await coordinator._worker
        waiting = asyncio.Event()

        async def inventory(*args, **kwargs):
            await waiting.wait()
            return NativeMcpInventory("verified")

        incoming = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            thread_count=0,
            admission=NativeAdmission(),
            readiness=SimpleNamespace(ready=True),
            verify_mcp_startup=AsyncMock(side_effect=inventory),
        )
        coordinator.register("incoming", incoming)
        async with asyncio.timeout(1):
            async with coordinator.startup("incoming"):
                pass
            async with incoming.admission.enter():
                self.assertTrue(incoming.admission.accepting)
        waiting.set()

    async def test_verified_partial_failure_releases_admission_without_claiming_ready(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b'{"broken":{}}', ()))
        await coordinator._worker
        admission = NativeAdmission()
        inventory = NativeMcpInventory(
            safe_error=MCP_STARTUP_ERROR,
            servers=(
                McpServerObservation("broken", McpServerState.FAILED, safe_error=MCP_STARTUP_ERROR),
            ),
            configuration_verified=True,
        )
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            admission=admission,
            readiness=SimpleNamespace(ready=True),
            configuration_quiescence=AsyncMock(return_value=NativeQuiescence(1, 1, 0, 0)),
            reload_mcp=AsyncMock(),
            verify_mcp_configuration=AsyncMock(return_value=inventory),
            verify_mcp_startup=AsyncMock(return_value=inventory),
        )
        coordinator.register("host", host)
        admission.applied(1)
        coordinator.reload()
        await asyncio.wait_for(coordinator._worker, 2)
        await coordinator.refresh()
        await coordinator._observer
        self.assertFalse(admission.frozen(1))
        async with asyncio.timeout(1):
            async with admission.enter():
                self.assertEqual(admission.active, 1)
        receipt = coordinator.receipt().hosts[0]
        self.assertEqual(receipt.state, McpApplicationState.FAILED)
        self.assertEqual(receipt.servers, inventory.servers)
        self.assertEqual(host.verify_mcp_configuration.await_count, 0)
        host.verify_mcp_startup = AsyncMock(return_value=NativeMcpInventory("recovered"))
        refreshed = await coordinator.refresh()
        refreshed = await coordinator._observer
        self.assertEqual(refreshed.hosts[0].state, McpApplicationState.READY)
        host.verify_mcp_startup.assert_awaited_once_with(
            frozenset({"broken"}), disabled_servers=frozenset(), include_threads=True
        )
        self.assertEqual(host.reload_mcp.await_count, 1)

        entered = asyncio.Event()
        released = asyncio.Event()

        async def delayed_refresh(*args, **kwargs):
            entered.set()
            await released.wait()
            return NativeMcpInventory("recovered")

        host.verify_mcp_startup.reset_mock(side_effect=True)
        host.verify_mcp_startup.side_effect = delayed_refresh
        first = asyncio.create_task(coordinator.refresh())
        await entered.wait()
        second = asyncio.create_task(coordinator.refresh())
        await second
        self.assertEqual(host.verify_mcp_startup.await_count, 1)
        released.set()
        await asyncio.gather(first, second)
        await coordinator._observer
        self.assertEqual(host.verify_mcp_startup.await_count, 1)

        async def invalidated_refresh(*args, **kwargs):
            admission.freeze(1)
            return inventory

        host.verify_mcp_startup.side_effect = invalidated_refresh
        await coordinator.refresh()
        await coordinator._observer
        self.assertEqual(coordinator._hosts["host"].inventory.revision, "recovered")
        admission.applied(1)

        async def stale_refresh(*args, **kwargs):
            host.process_generation += 1
            return inventory

        host.verify_mcp_startup.side_effect = stale_refresh
        await coordinator.refresh()
        await coordinator._observer
        self.assertEqual(coordinator._hosts["host"].inventory.revision, "recovered")

    async def test_pending_inventory_and_later_save_do_not_block_dialogue(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
        await coordinator._worker
        entered = asyncio.Event()
        release = asyncio.Event()

        async def inventory(*args, **kwargs):
            entered.set()
            await release.wait()
            return NativeMcpInventory(safe_error=MCP_INVENTORY_PENDING)

        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            thread_count=0,
            admission=NativeAdmission(),
            readiness=SimpleNamespace(ready=True),
            verify_mcp_startup=AsyncMock(side_effect=inventory),
            configuration_quiescence=AsyncMock(return_value=None),
        )
        coordinator.register("host", host)
        async with coordinator.startup("host"):
            pass
        await coordinator.refresh()
        await asyncio.wait_for(entered.wait(), 1)
        async with asyncio.timeout(1):
            await coordinator.refresh()
            async with host.admission.enter():
                coordinator.submit(NativeMcpConfiguration(2, b"{}", ()))
                while coordinator._published.revision != 2:
                    await asyncio.sleep(0)
        release.set()
        await coordinator._observer
        self.assertEqual(coordinator.receipt().desired_revision, 2)
        self.assertTrue(host.admission.accepting)

    async def test_failed_host_reload_releases_only_its_gate(self):
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
        await coordinator._worker
        admission = NativeAdmission()
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            admission=admission,
            readiness=SimpleNamespace(ready=True),
            configuration_quiescence=AsyncMock(return_value=NativeQuiescence(1, 1, 0, 0)),
            mcp_launch_matches=Mock(return_value=True),
            reload_mcp=AsyncMock(side_effect=AppServerError("reload failed")),
        )
        coordinator.register("host", host)
        admission.applied(1)
        with self.assertLogs("scholarseed_codex.coordination", level="ERROR"):
            coordinator.reload()
            await coordinator._worker
        self.assertTrue(admission.accepting)
        self.assertEqual(coordinator.receipt().hosts[0].state, McpApplicationState.FAILED)

    async def test_configuration_change_retains_only_current_unchanged_connections(self) -> None:
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        original = NativeMcpConfiguration(1, b'{"healthy":{},"changed":{}}', ())
        coordinator.submit(original)
        await coordinator._worker
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            admission=NativeAdmission(),
        )
        coordinator.register("host", host)
        entry = coordinator._hosts["host"]
        entry.generation = 1
        entry.applied_revision = 1
        host.admission.applied(1)
        entry.inventory = NativeMcpInventory(
            "verified",
            servers=(
                McpServerObservation("healthy", McpServerState.READY, 2),
                McpServerObservation("changed", McpServerState.READY, 1),
            ),
        )
        receipt = coordinator.submit(
            NativeMcpConfiguration(2, b'{"healthy":{},"changed":{"enabled":false}}', ())
        )
        self.assertEqual(receipt.hosts[0].state, McpApplicationState.PENDING)
        self.assertEqual(
            receipt.hosts[0].servers, (McpServerObservation("healthy", McpServerState.CONNECTING),)
        )
        self.assertTrue(host.admission.accepting)
        host.process_generation = 2
        self.assertEqual(coordinator.receipt().hosts[0].servers, ())

    async def test_overlapping_reload_discards_previous_schedule_ticket(self) -> None:
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
        await coordinator._worker
        admission = NativeAdmission()
        entered = asyncio.Event()
        released = asyncio.Event()
        reload_generations = []

        async def reload(generation):
            reload_generations.append(generation)
            if len(reload_generations) == 1:
                entered.set()
                await released.wait()

        async def verify(expected, *, disabled_servers, include_threads):
            self.assertTrue(admission.accepting)
            self.assertTrue(include_threads)
            self.assertEqual(expected, frozenset())
            self.assertEqual(disabled_servers, frozenset())
            return NativeMcpInventory("verified")

        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            pid=1,
            admission=admission,
            readiness=SimpleNamespace(ready=True),
            reload_mcp=AsyncMock(side_effect=reload),
            verify_mcp_startup=AsyncMock(side_effect=verify),
        )
        coordinator.register("host", host)
        admission.applied(1)
        epoch = admission.epoch
        coordinator.reload()
        await asyncio.wait_for(entered.wait(), 1)
        coordinator.reload()
        released.set()
        await asyncio.wait_for(coordinator._worker, 2)
        await coordinator.refresh()
        self.assertEqual(reload_generations, [1, 1])
        await coordinator._observer
        self.assertEqual(admission.epoch, epoch)
        self.assertEqual(host.verify_mcp_startup.await_count, 1)
        self.assertEqual(coordinator.receipt().hosts[0].state, McpApplicationState.READY)
        self.assertEqual(coordinator.receipt().safe_error, "")

    async def test_inventory_starting_is_pending_without_failure_error(self) -> None:
        editor = Mock(runtime_home=Path.cwd())
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=0,
            admission=NativeAdmission(),
            pid=None,
            readiness=SimpleNamespace(ready=False),
        )
        coordinator = McpCoordinator(editor)
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.register("host", host)
        coordinator._hosts["host"].inventory = NativeMcpInventory(safe_error=MCP_INVENTORY_PENDING)
        receipt = coordinator.receipt()
        self.assertEqual(receipt.hosts[0].state, McpApplicationState.PENDING)
        self.assertEqual(receipt.hosts[0].safe_error, "")

    async def test_failed_publication_can_retry_identical_revision(self) -> None:
        editor = Mock()
        original = PermissionError("private diagnostic")
        original.__cause__ = OSError("native access denied")
        editor.publish.side_effect = [original, "digest"]
        coordinator = McpCoordinator(editor)
        self.addAsyncCleanup(coordinator.aclose)
        configuration = NativeMcpConfiguration(1, b"{}", ())
        with self.assertLogs("scholarseed_codex.coordination", level="ERROR") as logs:
            coordinator.submit(configuration)
            await coordinator._worker
        self.assertEqual(len(logs.records), 1)
        self.assertIs(logs.records[0].exc_info[1], original)
        self.assertIn("native access denied", logs.output[0])
        self.assertEqual(coordinator.receipt().safe_error, MCP_APPLICATION_FAILED)
        coordinator.submit(configuration)
        await coordinator._worker
        self.assertEqual(coordinator.receipt().safe_error, "")
        self.assertEqual(editor.publish.call_count, 2)
        coordinator.submit(configuration)
        self.assertEqual(editor.publish.call_count, 2)

    async def test_failed_publication_keeps_safe_error_at_host_start_and_catalog(self) -> None:
        editor = Mock(runtime_home=Path.cwd())
        editor.publish.side_effect = PermissionError("private configuration diagnostic")
        coordinator = McpCoordinator(editor)
        self.addAsyncCleanup(coordinator.aclose)
        with self.assertLogs("scholarseed_codex.coordination", level="ERROR"):
            coordinator.submit(NativeMcpConfiguration(0, b"{}", ()))
            await coordinator._worker
        for context in (coordinator.startup("host"), coordinator.catalog_configuration({})):
            with self.assertRaises(AppServerError) as caught:
                async with context:
                    self.fail("unpublished configuration admitted")
            self.assertEqual(caught.exception.safe_error, MCP_APPLICATION_FAILED)
            self.assertNotIn("private", str(caught.exception))

    async def test_cancelled_application_is_not_logged_as_failure(self) -> None:
        coordinator = McpCoordinator(Mock())
        self.addAsyncCleanup(coordinator.aclose)
        coordinator._apply = AsyncMock(side_effect=asyncio.CancelledError)
        with self.assertNoLogs("scholarseed_codex.coordination", level="ERROR"):
            coordinator.submit(NativeMcpConfiguration(1, b"{}", ()))
            with self.assertRaises(asyncio.CancelledError):
                await coordinator._worker
        self.assertEqual(coordinator.receipt().safe_error, "")

    async def test_same_revision_different_secret_or_document_is_conflict(self) -> None:
        coordinator = McpCoordinator(Mock())
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(2, b"{}", ()))
        for configuration in (
            NativeMcpConfiguration(1, b"{}", ()),
            NativeMcpConfiguration(2, b'{"other": {}}', ()),
            NativeMcpConfiguration(2, b"{}", (("SECRET", "changed"),)),
        ):
            with self.subTest(revision=configuration.revision), self.assertRaises(ValueError):
                coordinator.submit(configuration)
        await coordinator._worker

    async def test_closed_mutation_guards_keep_safe_error(self) -> None:
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        await coordinator.aclose()
        configuration = NativeMcpConfiguration(0, b"{}", ())
        for operation in (
            lambda: coordinator.register("host", Mock()),
            lambda: coordinator.submit(configuration),
            coordinator.reload,
        ):
            with self.subTest(operation=operation):
                with self.assertRaises(AppServerError) as caught:
                    operation()
                self.assertEqual(caught.exception.safe_error, MCP_COORDINATOR_CLOSED)
        self.assertEqual(coordinator.receipt().hosts, ())

    async def test_duplicate_registration_is_not_reported_as_closed(self) -> None:
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        host = Mock(process_environment={CODEX_HOME_ENV: str(Path.cwd())})
        coordinator.register("host", host)
        members = tuple(coordinator._hosts.items())
        with self.assertRaises(AppServerError) as caught:
            coordinator.register("host", Mock())
        self.assertEqual(caught.exception.safe_error, MCP_HOST_ALREADY_REGISTERED)
        self.assertIs(coordinator._hosts["host"].host, host)
        self.assertEqual(tuple(coordinator._hosts.items()), members)
        await coordinator.aclose()
        with self.assertRaises(AppServerError) as caught:
            coordinator.register("host", host)
        self.assertEqual(caught.exception.safe_error, MCP_COORDINATOR_CLOSED)

    async def test_close_during_startup_keeps_safe_error_without_applying_host(self) -> None:
        coordinator = McpCoordinator(Mock(runtime_home=Path.cwd()))
        self.addAsyncCleanup(coordinator.aclose)
        coordinator.submit(NativeMcpConfiguration(0, b"{}", ()))
        await coordinator._worker
        host = Mock(
            process_environment={CODEX_HOME_ENV: str(Path.cwd())},
            process_generation=1,
            thread_count=0,
            admission=NativeAdmission(),
            verify_mcp_startup=AsyncMock(return_value=NativeMcpInventory()),
        )
        coordinator.register("host", host)
        with self.assertRaises(AppServerError) as caught:
            async with coordinator.startup("host"):
                await coordinator.aclose()
        self.assertEqual(caught.exception.safe_error, MCP_COORDINATOR_CLOSED)
        self.assertEqual(coordinator._hosts["host"].generation, 0)
        self.assertEqual(coordinator._hosts["host"].applied_revision, MCP_UNAPPLIED_REVISION)
        self.assertTrue(host.admission.frozen(0))
        host.verify_mcp_startup.assert_not_awaited()


class BlockingStream:
    def __init__(self) -> None:
        self.written = asyncio.Event()
        self.draining = asyncio.Event()

    def is_closing(self) -> bool:
        return False

    def write(self, payload: bytes) -> None:
        self.written.set()

    async def drain(self) -> None:
        await self.draining.wait()


class PendingRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_late_rejection_cannot_undo_observed_acceptance(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(3, "turn/start")
        pending.submission.state = RpcSubmissionState.ACCEPTED
        pending.submission.attempt()
        self.assertEqual(pending.submission.state, RpcSubmissionState.ACCEPTED)
        requests.resolve({"id": request_id, "error": {"code": -32601}}, 3)
        with self.assertRaises(AppServerError):
            await pending.future
        self.assertEqual(pending.submission.state, RpcSubmissionState.ACCEPTED)

    async def test_write_attempt_is_recorded_before_stream_write_can_fail(self) -> None:
        for failure in (BrokenPipeError, ConnectionError, OSError, RuntimeError):
            with self.subTest(failure=failure):
                requests = PendingRequests()
                request_id, pending = requests.begin(3, "turn/start")
                stream = Mock(is_closing=Mock(return_value=False))
                stream.write.side_effect = failure("write failed")
                writer = JsonLineWriter()
                writer.attach(stream, 3)
                with self.assertRaises((AppServerError, RuntimeError)):
                    await writer.write(
                        {"id": request_id},
                        generation=3,
                        on_write_attempt=pending.submission.attempt,
                        on_written=pending.mark_written,
                    )
                self.assertEqual(pending.submission.state, RpcSubmissionState.UNKNOWN)
                self.assertFalse(pending.written)
                requests.discard(request_id)
                self.assertTrue(requests.unsettled(3))
                requests.retire(3)

    async def test_disconnected_waiter_never_crosses_write_boundary(self) -> None:
        submission = RpcSubmission()
        writer = JsonLineWriter()
        stream = Mock(is_closing=Mock(return_value=False))
        writer.attach(stream, 3)
        await writer._lock.acquire()
        task = asyncio.create_task(
            writer.write(
                {},
                generation=3,
                on_write_attempt=submission.attempt,
            )
        )
        await asyncio.sleep(0)
        writer.detach(3)
        writer._lock.release()
        with self.assertRaises(AppServerError):
            await task
        self.assertEqual(submission.state, RpcSubmissionState.NOT_SUBMITTED)
        stream.write.assert_not_called()

    async def test_only_dispatch_rejection_proves_no_native_acceptance(self) -> None:
        for code in (-32601, -32600, -32602, -32603, -32000, True, "-32601"):
            with self.subTest(code=code):
                requests = PendingRequests()
                request_id, pending = requests.begin(3, "turn/start")
                pending.submission.attempt()
                requests.resolve({"id": request_id, "error": {"code": code}}, 2)
                self.assertFalse(pending.future.done())
                self.assertEqual(pending.submission.state, RpcSubmissionState.UNKNOWN)
                requests.resolve({"id": request_id, "error": {"code": code}}, 3)
                with self.assertRaises(AppServerError):
                    await pending.future
                self.assertEqual(
                    pending.submission.state,
                    (
                        RpcSubmissionState.NOT_SUBMITTED
                        if type(code) is int and code == -32601
                        else RpcSubmissionState.UNKNOWN
                    ),
                )

    async def test_missing_history_is_terminal_only_for_the_matching_resume(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(2, "thread/resume", thread_id="missing-thread")
        requests.resolve(
            {
                "id": request_id,
                "error": {
                    "code": -32600,
                    "message": "no rollout found for thread id missing-thread",
                },
            },
            2,
        )
        with self.assertRaises(AppServerError) as raised:
            await pending.future
        self.assertEqual(raised.exception.safe_error, "codex_thread_history_missing")
        self.assertEqual(raised.exception.retryability.value, "terminal")
        self.assertEqual(raised.exception.generation, 2)

    async def test_missing_thread_classification_requires_exact_response_identity(self) -> None:
        cases = (
            ("thread/resume", -32600, "no rollout found for thread id another-thread"),
            ("thread/resume", -32602, "no rollout found for thread id missing-thread"),
            ("turn/start", -32600, "no rollout found for thread id missing-thread"),
            ("thread/resume", -32600, "no rollout found for thread id missing-thread\nprivate"),
            ("thread/resume", -32600, "thread already has an active writer"),
        )
        for method, code, message in cases:
            with self.subTest(method=method, code=code, message=message):
                requests = PendingRequests()
                request_id, pending = requests.begin(2, method, thread_id="missing-thread")
                requests.resolve({"id": request_id, "error": {"code": code, "message": message}}, 2)
                with self.assertRaises(AppServerError) as raised:
                    await pending.future
                self.assertEqual(raised.exception.safe_error, "runtime_rpc_rejected")
                self.assertEqual(raised.exception.retryability.value, "user_retryable")

    async def test_cancel_during_drain_retains_sent_request(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        stream = BlockingStream()
        writer = JsonLineWriter()
        writer.attach(stream, 1)
        writing = asyncio.create_task(
            writer.write({"id": request_id}, generation=1, on_written=pending.mark_written)
        )
        await stream.written.wait()
        writing.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await writing
        requests.discard(request_id)
        self.assertTrue(requests.unsettled(1))
        requests.resolve({"id": request_id, "result": {}}, 1)
        self.assertFalse(requests.unsettled(1))

    async def test_abandoned_written_request_remains_until_native_response(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        pending.mark_written()
        requests.discard(request_id)
        requests.discard(request_id)
        self.assertTrue(pending.future.cancelled())
        self.assertTrue(requests.unsettled(1))
        requests.resolve({"id": request_id, "result": {}}, 2)
        self.assertTrue(requests.unsettled(1))
        requests.resolve({"id": request_id, "result": {}}, 1)
        self.assertFalse(requests.unsettled(1))

    async def test_late_rejection_settles_without_unobserved_future_error(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        pending.mark_written()
        requests.discard(request_id)
        requests.resolve({"id": request_id, "error": {"code": -1}}, 1)
        self.assertFalse(requests.unsettled(1))
        self.assertTrue(pending.future.cancelled())

    async def test_unwritten_cancellation_does_not_block(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        requests.discard(request_id)
        self.assertTrue(pending.future.cancelled())
        self.assertFalse(requests.unsettled(1))

    async def test_transport_failure_is_not_process_exit_evidence(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        pending.mark_written()
        requests.fail(AppServerError("transport lost"), generation=1)
        requests.discard(request_id)
        self.assertTrue(requests.unsettled(1))
        self.assertTrue(pending.future.done())
        requests.retire(1)
        self.assertFalse(requests.unsettled(1))

    async def test_process_exit_clears_only_its_abandoned_requests(self) -> None:
        requests = PendingRequests()
        for generation in (1, 2):
            request_id, pending = requests.begin(generation, "mcpServer/tool/call")
            pending.mark_written()
            requests.discard(request_id)
        requests.fail(AppServerError("exited"), generation=1)
        self.assertTrue(requests.unsettled(1))
        requests.retire(1)
        self.assertFalse(requests.unsettled(1))
        self.assertTrue(requests.unsettled(2))
        requests.close(AppServerError("closed"))
        self.assertFalse(requests.unsettled(2))

    async def test_normal_completion_and_discard_are_settled(self) -> None:
        requests = PendingRequests()
        request_id, pending = requests.begin(1, "mcpServer/tool/call")
        pending.mark_written()
        self.assertTrue(requests.unsettled(1))
        requests.resolve({"id": request_id, "result": {}}, 1)
        self.assertEqual(await pending.future, {})
        self.assertFalse(requests.unsettled(1))
        requests.discard(request_id)

    async def test_abandoned_requests_are_bounded_without_forgetting_work(self) -> None:
        requests = PendingRequests(capacity=2)
        request_ids = []
        for _index in range(2):
            request_id, pending = requests.begin(1, "mcpServer/tool/call")
            request_ids.append(request_id)
            pending.mark_written()
            requests.discard(request_id)
        with self.assertRaises(AppServerError) as raised:
            requests.begin(1, "mcpServer/tool/call")
        self.assertEqual(raised.exception.safe_error, "runtime_rpc_capacity_exhausted")
        self.assertTrue(requests.unsettled(1))
        requests.resolve({"id": request_ids[0], "result": {}}, 1)
        request_id, _pending = requests.begin(1, "mcpServer/tool/call")
        requests.discard(request_id)
        requests.retire(1)


class AdmissionTests(unittest.IsolatedAsyncioTestCase):
    async def test_freeze_does_not_wait_for_invoking_operation(self) -> None:
        gate = NativeAdmission()
        async with gate.enter():
            self.assertTrue(gate.freeze(1))
            drained = asyncio.create_task(gate.wait_drained(1))
            await asyncio.sleep(0)
            self.assertFalse(drained.done())
            self.assertEqual(gate.active, 1)
        self.assertTrue(await drained)
        self.assertTrue(gate.applied(1))

    async def test_waiting_work_is_not_counted_or_started_before_apply(self) -> None:
        gate = NativeAdmission()
        gate.freeze(1)
        entered = asyncio.Event()

        async def work():
            async with gate.enter():
                entered.set()

        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        self.assertFalse(entered.is_set())
        self.assertEqual(gate.active, 0)
        gate.applied(1)
        await waiting
        self.assertTrue(entered.is_set())

    async def test_old_completion_cannot_reopen_newer_revision(self) -> None:
        gate = NativeAdmission()
        gate.freeze(1)
        gate.freeze(2)
        self.assertFalse(gate.freeze(1))
        self.assertFalse(await gate.wait_drained(1))
        self.assertFalse(gate.applied(1))
        self.assertTrue(gate.applied(2))

    async def test_cancelled_waiter_does_not_leak_count(self) -> None:
        gate = NativeAdmission()
        gate.freeze(1)

        async def work():
            async with gate.enter():
                self.fail("cancelled waiter entered")

        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual(gate.active, 0)
        self.assertTrue(await gate.wait_drained(1))

    async def test_close_wakes_waiters_with_explicit_failure(self) -> None:
        gate = NativeAdmission()
        gate.freeze(1)

        async def work():
            async with gate.enter():
                self.fail("closed gate entered")

        waiting = asyncio.create_task(work())
        await asyncio.sleep(0)
        gate.close()
        with self.assertRaises(AppServerError):
            await waiting
        self.assertFalse(gate.applied(1))
        self.assertFalse(await gate.wait_drained(1))

    async def test_multiple_operations_run_without_serializing_turns(self) -> None:
        gate = NativeAdmission()
        async with gate.enter():
            async with gate.enter():
                self.assertEqual(gate.active, 2)
                gate.freeze(1)
                with self.assertRaises(RuntimeError):
                    gate.applied(1)
        self.assertEqual(gate.active, 0)


if __name__ == "__main__":
    unittest.main()
