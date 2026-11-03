"""Private launcher lifecycle contracts; not packaged update acceptance."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from service.chat.runtime.composition import LiveSessionService
from service.chat.service.sessions import SessionService
from service.platform.activity import (
    Activities,
    ActivityDomain,
    ActivityPhase,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.parent_control import ParentControl, ParentControlError
from service.platform.toolchain import CompilerResources, ToolchainReadiness

COMPILER_DESCRIPTION = {
    "version": "2026-r3",
    "archiveSha256": "a" * 64,
    "fontDirectories": [str(Path(tempfile.gettempdir()).resolve() / "fonts")],
}


class ParentControlContracts(unittest.IsolatedAsyncioTestCase):
    async def test_restart_takeover_failure_and_cancellation_restore_terminal_fence(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel):
                activities = Activities()
                resource = activities.enter(ActivityDomain.RESOURCE, root=True)
                fence = activities.begin()
                activities.release_for_restart(fence)
                entered = asyncio.Event()

                async def drain(generation):
                    self.assertNotEqual(generation, fence)
                    self.assertFalse(activities.seal(generation))
                    entered.set()
                    if cancel:
                        await asyncio.Event().wait()
                    raise RuntimeError("resource cleanup unknown")

                control = ParentControl(activities, drain_attachments=drain)
                task = asyncio.create_task(
                    control._command({"operation": "quiesce", "generation": None})
                )
                await entered.wait()
                if cancel:
                    task.cancel()
                try:
                    with self.assertRaises(asyncio.CancelledError if cancel else RuntimeError):
                        await task
                    self.assertIsNone(control._generation)
                    self.assertEqual(activities.snapshot().generation, fence)
                    self.assertEqual(activities.snapshot().counts, {"resource": 1})
                    with self.assertRaises(MaintenanceActive):
                        activities.enter(ActivityDomain.TURN, root=True)
                finally:
                    resource.close()

    async def test_skill_python_receipt_is_independent_and_single_use(self):
        skill = Mock()
        tex = Mock()
        control = ParentControl(Activities(), toolchain_complete=tex, skill_python_complete=skill)
        for ready in ["true", 1, None]:
            with self.assertRaises(ParentControlError):
                await control._command({"operation": "skill-python", "ready": ready})
        self.assertEqual(
            await control._command({"operation": "skill-python", "ready": True}), b"\x01"
        )
        skill.assert_called_once_with(True)
        tex.assert_not_called()
        with self.assertRaises(ParentControlError):
            await control._command({"operation": "skill-python", "ready": True})
        await control.aclose()
        skill.assert_called_once_with(True)
        tex.assert_called_once_with(False, None)

    async def test_pending_skill_python_fails_closed_on_disconnect(self):
        complete = Mock()
        control = ParentControl(Activities(), skill_python_complete=complete)
        await control.aclose()
        await control.aclose()
        complete.assert_called_once_with(False)

    async def test_idle_quiesce_refuses_live_work_without_interruption(self):
        for domain in (ActivityDomain.TURN, ActivityDomain.RUNTIME, ActivityDomain.INVOCATION):
            with self.subTest(domain=domain):
                activities = Activities()
                lease = activities.enter(domain, root=True)
                interrupted = Mock()
                control = ParentControl(activities, interrupt_running=interrupted)
                with self.assertRaises(ParentControlError):
                    await control._command({"operation": "quiesce_if_idle", "generation": None})
                interrupted.assert_not_called()
                self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
                self.assertIsNone(control._generation)
                lease.close()

    async def test_idle_quiesce_closes_admission_and_drains_without_interruption(self):
        activities = Activities()
        resource = activities.enter(ActivityDomain.RESOURCE, root=True)
        interrupted = Mock()
        drained = []

        async def drain(generation):
            self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
            with self.assertRaises(MaintenanceActive):
                activities.enter(ActivityDomain.TURN, root=True)
            drained.append(generation)
            resource.close()
            return ()

        control = ParentControl(activities, interrupt_running=interrupted, drain_attachments=drain)
        response = await control._command({"operation": "quiesce_if_idle", "generation": None})
        interrupted.assert_not_called()
        self.assertEqual(response, b"\x01" + drained[0].encode("ascii"))
        await control._command({"operation": "resume", "generation": drained[0]})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_idle_quiesce_failed_drain_restores_only_its_admission(self):
        activities = Activities()

        async def drain(_generation):
            raise RuntimeError("drain failed")

        control = ParentControl(activities, drain_attachments=drain)
        with self.assertRaisesRegex(RuntimeError, "drain failed"):
            await control._command({"operation": "quiesce_if_idle", "generation": None})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertIsNone(control._generation)
        generation = activities.begin()
        with self.assertRaises(ParentControlError):
            await control._command({"operation": "quiesce_if_idle", "generation": None})
        self.assertEqual(activities.snapshot().generation, generation)
        self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)

    async def test_idle_quiesce_cancellation_reopens_admission_without_interruption(self):
        activities = Activities()
        entered = asyncio.Event()
        interrupted = Mock()

        async def drain(_generation):
            entered.set()
            await asyncio.Event().wait()

        control = ParentControl(activities, interrupt_running=interrupted, drain_attachments=drain)
        pending = asyncio.create_task(
            control._command({"operation": "quiesce_if_idle", "generation": None})
        )
        await entered.wait()
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        interrupted.assert_not_called()
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertIsNone(control._generation)

    async def test_idle_quiesce_unsettled_resources_refuse_without_interruption(self):
        activities = Activities()
        resource = activities.enter(ActivityDomain.RESOURCE, root=True)
        interrupted = Mock()

        async def drain(_generation):
            return ("busy-provider",)

        control = ParentControl(activities, interrupt_running=interrupted, drain_attachments=drain)
        try:
            with patch("service.platform.parent_control.MAINTENANCE_SETTLE_SECONDS", 0.01):
                with self.assertRaises(ParentControlError):
                    await control._command({"operation": "quiesce_if_idle", "generation": None})
            interrupted.assert_not_called()
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertEqual(activities.snapshot().counts, {"resource": 1})
        finally:
            resource.close()

    async def test_connection_failure_logs_stage_and_os_code_without_secrets(self):
        complete = Mock()
        control = ParentControl(Activities(), toolchain_complete=complete)
        secret = "private-bootstrap-token"
        error = OSError(13, secret)
        error.winerror = 10013
        with patch("asyncio.open_connection", new=AsyncMock(side_effect=error)):
            with self.assertLogs("service.platform.parent_control", level="INFO") as logs:
                await control._run(12345, secret)
        output = "\n".join(logs.output)
        self.assertIn("stage=connect", output)
        self.assertIn("errno=13 winerror=10013", output)
        self.assertIn("parent_control_preparation_missing", output)
        self.assertNotIn(secret, output)
        complete.assert_called_once_with(False, None)

    async def test_authentication_failure_is_distinct_and_does_not_log_peer_frame(self):
        complete = Mock()
        control = ParentControl(Activities(), toolchain_complete=complete)
        secret = b"credential-in-peer-frame"

        async def peer(reader, writer):
            await reader.readline()
            writer.write(secret + b"\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(peer, "127.0.0.1", 0)
        try:
            with self.assertLogs("service.platform.parent_control", level="INFO") as logs:
                await control._run(server.sockets[0].getsockname()[1], "a" * 64)
            output = "\n".join(logs.output)
            self.assertIn("parent_control_connected", output)
            self.assertIn("stage=auth_receive", output)
            self.assertNotIn(secret.decode(), output)
            self.assertNotIn("a" * 64, output)
            complete.assert_called_once_with(False, None)
        finally:
            await control.aclose()
            server.close()
            await server.wait_closed()

    async def test_toolchain_receipt_is_boolean_single_use_and_not_maintenance(self):
        activities = Activities()
        complete = Mock()
        control = ParentControl(activities, toolchain_complete=complete)
        for ready in ["true", 1, None]:
            with self.assertRaises(ParentControlError):
                await control._command(
                    {"operation": "toolchain", "ready": ready, "resources": COMPILER_DESCRIPTION}
                )
        self.assertEqual(
            await control._command(
                {"operation": "toolchain", "ready": True, "resources": COMPILER_DESCRIPTION}
            ),
            b"\x01",
        )
        complete.assert_called_once_with(
            True, CompilerResources.from_description(COMPILER_DESCRIPTION)
        )
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        with self.assertRaises(ParentControlError):
            await control._command(
                {"operation": "toolchain", "ready": True, "resources": COMPILER_DESCRIPTION}
            )
        with self.assertRaises(ParentControlError):
            await ParentControl(activities)._command(
                {"operation": "toolchain", "ready": True, "resources": COMPILER_DESCRIPTION}
            )

    async def test_toolchain_close_before_receipt_fails_closed(self):
        complete = Mock()
        control = ParentControl(Activities(), toolchain_complete=complete)
        await control.aclose()
        await control.aclose()
        complete.assert_called_once_with(False, None)

    async def test_failed_toolchain_receipt_requires_no_resources(self):
        readiness = ToolchainReadiness()
        readiness.defer()
        control = ParentControl(Activities(), toolchain_complete=readiness.complete)
        with self.assertRaises(ParentControlError):
            await control._command(
                {"operation": "toolchain", "ready": False, "resources": COMPILER_DESCRIPTION}
            )
        with self.assertRaises(RuntimeError):
            readiness.require_ready()
        self.assertEqual(
            await control._command({"operation": "toolchain", "ready": False, "resources": None}),
            b"\x01",
        )
        self.assertIsNone(readiness.resources)
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            readiness.require_ready()

    async def test_invalid_compiler_resources_never_publish_ready_or_partial_state(self):
        readiness = ToolchainReadiness()
        readiness.defer()
        control = ParentControl(Activities(), toolchain_complete=readiness.complete)
        for resources in (
            None,
            {},
            {**COMPILER_DESCRIPTION, "extra": True},
            {**COMPILER_DESCRIPTION, "archiveSha256": "invalid"},
            {**COMPILER_DESCRIPTION, "fontDirectories": ["relative"]},
        ):
            with self.subTest(resources=resources):
                with self.assertRaises(ParentControlError):
                    await control._command(
                        {"operation": "toolchain", "ready": True, "resources": resources}
                    )
                self.assertIsNone(readiness.resources)
                with self.assertRaises(RuntimeError):
                    readiness.require_ready()
        await control.aclose()
        self.assertIsNone(readiness.resources)
        with self.assertRaises(RuntimeError):
            readiness.require_ready()

    async def test_restart_interrupts_every_open_session_and_rejects_failed_receipt(self):
        sessions = SessionService.__new__(SessionService)
        sessions._runtime = Mock(interrupt_invocations_for_update=AsyncMock())
        sessions._sessions = {
            "first": Mock(running=False, runtime_session=None),
            "second": Mock(running=False, runtime_session=None),
        }
        sessions._logger = Mock()
        called = []

        async def interrupt(session_id):
            called.append(session_id)
            return {"ok": session_id != "second"}

        sessions.interrupt = interrupt
        with self.assertRaisesRegex(RuntimeError, "interruption failed"):
            await sessions.interrupt_running_for_update()
        self.assertEqual(set(called), {"first", "second"})

    async def test_restart_interrupts_attached_tree_after_root_turn_ended(self):
        sessions = SessionService.__new__(SessionService)
        sessions._runtime = Mock(interrupt_invocations_for_update=AsyncMock())
        sessions._logger = Mock()
        live = Mock(running=False, runtime_session=object(), interrupt=AsyncMock())
        sessions._sessions = {"parent": live}
        sessions.interrupt = AsyncMock()
        await sessions.interrupt_running_for_update()
        live.interrupt.assert_awaited_once_with(cleanup_background_processes=True)
        sessions.interrupt.assert_not_awaited()

    async def test_parent_control_interrupts_multiple_real_session_owners(self):
        activities = Activities()
        sessions = SessionService.__new__(SessionService)
        sessions._runtime = Mock(runtime_id="codex", interrupt_invocations_for_update=AsyncMock())
        sessions._logger = Mock()
        interrupted = []

        class RunningSession:
            resource_task = None
            running = True
            ledger = Mock(active_turn_id="native-turn")

            def __init__(self, session_id):
                self.session_id = session_id
                self.lease = activities.enter(ActivityDomain.TURN, root=True)

            async def interrupt(self, *, cleanup_background_processes):
                self.assert_cleanup = cleanup_background_processes
                interrupted.append(self.session_id)
                self.lease.close()

            async def publish(self, *_args):
                return None

        sessions._sessions = {
            session_id: RunningSession(session_id) for session_id in ("first", "second")
        }
        control = ParentControl(activities, interrupt_running=sessions.interrupt_running_for_update)
        response = await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(set(interrupted), {"first", "second"})
        self.assertTrue(all(live.assert_cleanup for live in sessions._sessions.values()))
        self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))

    async def test_restart_waits_for_admitted_turn_to_get_native_identity(self):
        sessions = SessionService.__new__(SessionService)
        sessions._runtime = Mock(interrupt_invocations_for_update=AsyncMock())
        live = Mock(running=True, resource_task=None)
        sessions._logger = Mock()
        live.ledger.active_turn_id = ""
        sessions._sessions = {"starting": live}
        observed = []

        async def interrupt(session_id):
            observed.append((session_id, live.ledger.active_turn_id))
            return {"ok": True}

        sessions.interrupt = interrupt

        async def start_native_turn():
            await asyncio.sleep(0)
            live.ledger.active_turn_id = "native-turn"

        starter = asyncio.create_task(start_native_turn())
        with patch("service.chat.service.sessions.SESSION_RELOCATE_STOP_POLL_SECONDS", 0.001):
            await sessions.interrupt_running_for_update()
        await starter
        self.assertEqual(observed, [("starting", "native-turn")])

    async def test_restart_interrupts_invocation_before_waiting_for_parent_session(self):
        activities = Activities()
        invocation = activities.enter(ActivityDomain.INVOCATION, root=True)
        turn = activities.enter(ActivityDomain.TURN, root=True)
        stopped = asyncio.Event()
        sessions = SessionService.__new__(SessionService)
        sessions._logger = Mock()
        sessions._sessions = {"parent": Mock(running=True, resource_task=None)}

        async def stop_invocation():
            self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
            invocation.close()
            stopped.set()

        async def stop_parent(_identity):
            await stopped.wait()
            turn.close()
            return {"ok": True}

        sessions._runtime = Mock(interrupt_invocations_for_update=stop_invocation)
        sessions.interrupt = stop_parent
        control = ParentControl(activities, interrupt_running=sessions.interrupt_running_for_update)
        try:
            with patch("service.platform.parent_control.MAINTENANCE_INTERRUPT_SECONDS", 0.1):
                response = await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(response[:1], b"\x01")
            self.assertFalse(activities.snapshot().counts)
        finally:
            invocation.close()
            turn.close()

    async def test_restart_rejects_invocation_interruption_failure(self):
        sessions = SessionService.__new__(SessionService)
        sessions._logger = Mock()
        sessions._sessions = {}
        sessions._runtime = Mock(
            interrupt_invocations_for_update=AsyncMock(side_effect=RuntimeError("unconfirmed"))
        )
        with self.assertRaisesRegex(RuntimeError, "interruption failed"):
            await sessions.interrupt_running_for_update()

    async def test_confirmed_restart_interrupts_running_work_before_maintenance_grant(self):
        activities = Activities()
        turn = activities.enter(ActivityDomain.TURN, root=True)
        runtime = activities.enter(ActivityDomain.RUNTIME, root=True)
        called = []

        async def interrupt_running():
            called.append(activities.snapshot().phase)
            turn.close()
            runtime.close()

        control = ParentControl(activities, interrupt_running=interrupt_running)
        response = await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(called, [ActivityPhase.DRAINING])
        self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))
        self.assertEqual(activities.snapshot().counts, {})

    async def test_quiesce_suspends_idle_runtime_attachment_after_interruption(self):
        activities = Activities()
        runtime = activities.enter(ActivityDomain.RUNTIME, root=True)
        observed = []

        async def interrupt_running():
            observed.append("interrupt")

        async def drain_attachments(generation):
            observed.append("drain")
            self.assertEqual(activities.snapshot().generation, generation)
            self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
            runtime.close()
            return ()

        control = ParentControl(
            activities,
            interrupt_running=interrupt_running,
            drain_attachments=drain_attachments,
        )
        response = await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(observed, ["interrupt", "drain"])
        self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))
        self.assertEqual(activities.snapshot().counts, {})

    async def test_quiesce_retries_runtime_suspension_after_running_session_settles(self):
        activities = Activities()
        runtime = activities.enter(ActivityDomain.RUNTIME, root=True)
        attempts = 0

        async def interrupt_running():
            return None

        async def drain_attachments(_generation):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                return ("settling-session",)
            runtime.close()
            return ()

        control = ParentControl(
            activities,
            interrupt_running=interrupt_running,
            drain_attachments=drain_attachments,
        )
        response = await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(attempts, 2)
        self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))
        self.assertEqual(activities.snapshot().counts, {})

    async def test_unsettled_native_runtime_still_refuses_quiesce(self):
        activities = Activities()
        runtime = activities.enter(ActivityDomain.RUNTIME, root=True)

        async def drain_attachments(_generation):
            return ("busy-session",)

        control = ParentControl(activities, drain_attachments=drain_attachments)
        try:
            with patch("service.platform.parent_control.MAINTENANCE_SETTLE_SECONDS", 0.01):
                with self.assertRaises(ParentControlError):
                    await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        finally:
            runtime.close()

    async def test_failed_interruption_reopens_admission_without_claiming_drain(self):
        activities = Activities()
        turn = activities.enter(ActivityDomain.TURN, root=True)

        async def interrupt_running():
            raise RuntimeError("runtime rejected interrupt")

        control = ParentControl(activities, interrupt_running=interrupt_running)
        try:
            with self.assertRaisesRegex(RuntimeError, "runtime rejected interrupt"):
                await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertEqual(activities.snapshot().counts, {"turn": 1})
            self.assertIsNone(control._generation)
        finally:
            turn.close()

    async def test_interrupt_receipt_without_real_turn_exit_cannot_grant_maintenance(self):
        activities = Activities()
        turn = activities.enter(ActivityDomain.TURN, root=True)

        async def interrupt_running():
            return None

        control = ParentControl(activities, interrupt_running=interrupt_running)
        try:
            with patch("service.platform.parent_control.MAINTENANCE_INTERRUPT_SECONDS", 0.01):
                with self.assertRaises(ParentControlError):
                    await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertEqual(activities.snapshot().counts, {"turn": 1})
        finally:
            turn.close()

    async def test_idle_import_poll_settles_under_closed_admission(self):
        activities = Activities()
        control = ParentControl(activities)
        lease = activities.enter(ActivityDomain.IMPORT, root=True)
        quiesce = asyncio.create_task(
            control._command({"operation": "quiesce", "generation": None})
        )
        try:
            await asyncio.sleep(0)
            self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
            with self.assertRaises(MaintenanceActive):
                activities.enter(ActivityDomain.IMPORT, root=True)
            self.assertFalse(quiesce.done())
            lease.close()
            response = await asyncio.wait_for(quiesce, 3)
            self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))
            self.assertEqual(activities.snapshot().counts, {})
        finally:
            lease.close()
            if not quiesce.done():
                quiesce.cancel()
            await asyncio.gather(quiesce, return_exceptions=True)

    async def test_cancelled_settle_reopens_admission_without_closing_business_lease(self):
        activities = Activities()
        control = ParentControl(activities)
        lease = activities.enter(ActivityDomain.IMPORT, root=True)
        quiesce = asyncio.create_task(
            control._command({"operation": "quiesce", "generation": None})
        )
        try:
            await asyncio.sleep(0)
            quiesce.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await quiesce
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertEqual(activities.snapshot().counts, {"import": 1})
            self.assertIsNone(control._generation)
            self.assertEqual(activities._drain_waiters, set())
        finally:
            lease.close()

    async def test_resumed_generation_cannot_finish_a_pending_business_drain(self):
        activities = Activities()
        lease = activities.enter(ActivityDomain.IMPORT, root=True)
        generation = activities.begin()
        draining = asyncio.create_task(activities.wait_business_drained(generation))
        try:
            await asyncio.sleep(0)
            activities.resume(generation, expected_phase=ActivityPhase.DRAINING)
            with self.assertRaises(MaintenanceStale):
                await asyncio.wait_for(draining, 3)
            self.assertEqual(activities._drain_waiters, set())
        finally:
            lease.close()
            if not draining.done():
                draining.cancel()
            await asyncio.gather(draining, return_exceptions=True)

    def _runtime_resource_lease(self, activities):
        gateway = Mock()
        discovery = Mock()
        discovery.sandbox_resources = None
        discovery.configure.return_value = gateway
        gateway.default_runtime_id = "codex"
        LiveSessionService(
            activities=activities,
            catalog=Mock(),
            events=Mock(),
            artifacts=Mock(),
            skills=Mock(),
            models=Mock(),
            logger=Mock(),
            discovery=discovery,
        )
        return discovery.configure.call_args.kwargs["resource_lease"]

    async def test_warm_runtime_host_allows_quiesce_but_does_not_prove_exit(self):
        activities = Activities()
        control = ParentControl(activities)
        host = self._runtime_resource_lease(activities)()
        try:
            # An actual inspection still blocks maintenance while the host is warm.
            with activities.enter(ActivityDomain.RUNTIME, root=True):
                with self.assertRaises(ParentControlError):
                    await control._command({"operation": "quiesce", "generation": None})
            await control._command({"operation": "quiesce", "generation": None})
            generation = activities.snapshot().generation
            self.assertFalse(activities.seal(generation))
            host.close()
            self.assertTrue(activities.seal(generation))
        finally:
            host.close()

    async def test_persistent_runtime_host_cannot_borrow_startup_readiness(self):
        activities = Activities(workbench_ready=lambda: False)
        resource = self._runtime_resource_lease(activities)
        with activities.enter(ActivityDomain.STARTUP):
            with self.assertRaises(MaintenanceActive):
                resource()
            with self.assertRaises(MaintenanceActive):
                activities.enter(ActivityDomain.RESOURCE, allow_startup_probe=False)

    async def test_quiesce_retains_generation_until_exact_resume(self):
        activities = Activities()
        control = ParentControl(activities)
        response = await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(response[:1], b"\x01")
        generation = response[1:].decode("ascii")
        self.assertEqual(generation, activities.snapshot().generation)
        self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
        self.assertEqual(len(generation), 32)
        for command in (
            {"operation": "resume", "generation": "f" * 32},
            {"operation": "quiesce", "generation": None},
            {"operation": "capture", "generation": None},
        ):
            with self.assertRaises(ParentControlError):
                await control._command(command)
            self.assertEqual(activities.snapshot().generation, generation)
        await control._command({"operation": "resume", "generation": generation})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_retired_capture_does_not_begin_maintenance(self):
        activities = Activities()
        control = ParentControl(activities)
        with self.assertRaises(ParentControlError):
            await control._command({"operation": "capture", "generation": None})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertIsNone(control._generation)

    async def test_busy_workbench_releases_only_failed_quiesce(self):
        activities = Activities()
        control = ParentControl(activities)
        lease = activities.enter(ActivityDomain.TURN)
        try:
            with self.assertRaises(ParentControlError):
                await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertIsNone(control._generation)
        finally:
            lease.close()
        await control._command({"operation": "quiesce", "generation": None})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)

    async def test_resume_does_not_reopen_a_sealed_generation(self):
        activities = Activities()
        control = ParentControl(activities)
        await control._command({"operation": "quiesce", "generation": None})
        generation = activities.snapshot().generation
        self.assertTrue(activities.seal(generation))
        with self.assertRaises(MaintenanceStale):
            await control._command({"operation": "resume", "generation": generation})
        self.assertEqual(activities.snapshot().phase, ActivityPhase.SEALED)
        self.assertEqual(control._generation, generation)

    async def test_transport_refusal_distinguishes_open_from_retained_maintenance(self):
        for retained in (False, True):
            with self.subTest(retained=retained):
                activities = Activities()
                generation = activities.begin() if retained else None
                received = asyncio.get_running_loop().create_future()

                async def peer(reader, writer, received=received):
                    try:
                        await reader.readline()
                        writer.write(b'ready\n{"operation":"capture","generation":null}\n')
                        await writer.drain()
                        size = int.from_bytes(await reader.readexactly(4), "big")
                        received.set_result(await reader.readexactly(size))
                    except Exception as error:
                        received.set_exception(error)
                    finally:
                        writer.close()
                        await writer.wait_closed()

                server = await asyncio.start_server(peer, "127.0.0.1", 0)
                control = ParentControl(activities)
                try:
                    control.start(
                        json.dumps(
                            {
                                "version": 1,
                                "port": server.sockets[0].getsockname()[1],
                                "token": "a" * 64,
                            }
                        ).encode()
                    )
                    self.assertEqual(
                        await asyncio.wait_for(received, 3), b"\x02" if retained else b"\x00"
                    )
                    self.assertEqual(activities.snapshot().generation, generation)
                    self.assertEqual(
                        activities.snapshot().phase,
                        ActivityPhase.DRAINING if retained else ActivityPhase.OPEN,
                    )
                finally:
                    await control.aclose()
                    server.close()
                    await server.wait_closed()

    async def test_transport_disconnect_does_not_resume_maintenance(self):
        activities = Activities()
        received = asyncio.get_running_loop().create_future()
        token = "a" * 64

        async def peer(reader, writer, received=received):
            try:
                self.assertEqual(json.loads(await reader.readline()), {"token": token})
                writer.write(b'ready\n{"operation":"quiesce","generation":null}\n')
                await writer.drain()
                size = int.from_bytes(await reader.readexactly(4), "big")
                received.set_result(await reader.readexactly(size))
            except Exception as error:
                received.set_exception(error)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(peer, "127.0.0.1", 0)
        control = ParentControl(activities)
        try:
            control.start(
                json.dumps(
                    {
                        "version": 1,
                        "port": server.sockets[0].getsockname()[1],
                        "token": token,
                    }
                ).encode()
            )
            response = await asyncio.wait_for(received, 5)
            self.assertEqual(response, b"\x01" + activities.snapshot().generation.encode("ascii"))
            await asyncio.wait_for(asyncio.shield(control._task), 5)
            self.assertEqual(activities.snapshot().phase, ActivityPhase.DRAINING)
        finally:
            await control.aclose()
            server.close()
            await server.wait_closed()

    async def test_shutdown_joins_channel_cleanup_under_concurrent_and_repeated_cancellation(self):
        control = ParentControl(Activities())
        started, cleaning, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        finished = asyncio.Event()

        async def channel():
            started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                finished.set()
                raise

        control._task = asyncio.create_task(channel())
        await asyncio.wait_for(started.wait(), 3)
        first = asyncio.create_task(control.aclose())
        await asyncio.wait_for(cleaning.wait(), 3)
        second = asyncio.create_task(control.aclose())
        try:
            first.cancel()
            await asyncio.sleep(0)
            first.cancel()
            await asyncio.sleep(0)
            self.assertFalse(first.done())
            self.assertFalse(second.done())
            with self.assertRaises(ParentControlError):
                await control._command({"operation": "quiesce", "generation": None})
        finally:
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(first, 3)
            await asyncio.wait_for(second, 3)
        self.assertTrue(finished.is_set())
        await control.aclose()


if __name__ == "__main__":
    unittest.main()
