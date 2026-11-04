"""Runtime inspection/prewarm lifetime contracts, not native process acceptance."""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import tempfile
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

import httpx

from scholarseed_runtime.contract import (
    CapabilitySet,
    CapabilityState,
    CommandReceipt,
    CommandState,
    ModelIntent,
    OpenSessionRequest,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeInventory,
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.command import HostWarmupRequest
from scholarseed_runtime.contract.provider import RUNTIME_HOST_WARMUP_COMMAND
from service.bootstrap import create_app
from service.capabilities.api.routes import register_capability_routes
from service.capabilities.service.skills import (
    SkillCatalog,
    SkillEnablementPlan,
    SkillProductState,
    load_skill_state,
    save_skill_state,
)
from service.chat.api.skills import mount_skill_routes
from service.chat.persistence.catalog import OpenState, SessionCatalogStore, SessionPrincipal
from service.chat.runtime.activation import ActivationPlan
from service.chat.runtime.composition import LiveSessionService, RuntimeOpening
from service.cli import serve
from service.platform.activity import (
    Activities,
    ActivityDomain,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.http_activity import ServeApplication
from service.platform.parent_control import ParentControl
from service.platform.toolchain import ToolchainReadiness, ToolchainState
from tests._host import HOST_ID, USER_ID, HostContextFixture


class RuntimeInventoryDrainContracts(unittest.IsolatedAsyncioTestCase):
    def start_preparation(self, warm, *, request_id=None):
        return self.runtime.reconfiguration.start(
            request_id=request_id or str(uuid4()),
            session_id=None,
            user_id=USER_ID,
            model_id="restored-model",
            wait_seconds=1,
            validate=Mock(),
            apply=AsyncMock(),
            warm=warm,
        )

    async def wait_preparation(self, operation):
        return await self.runtime.reconfiguration.wait(operation["request_id"], None, USER_ID)

    async def test_shared_control_requires_capability_before_resolving_host_credentials(self):
        provider = SimpleNamespace(
            descriptor=SimpleNamespace(capabilities=CapabilitySet()),
            prewarm=AsyncMock(),
        )
        self.gateway.provider.return_value = provider
        self.runtime._host_environment = AsyncMock(return_value={})
        with self.assertRaisesRegex(ValueError, "runtime_host_context_required"):
            async with LiveSessionService._host_context(
                self.runtime, cwd=self.root, user_id=USER_ID
            ):
                self.fail("unsupported shared control admitted")
        provider.prewarm.assert_not_awaited()
        self.runtime._host_environment.assert_not_awaited()
        self.gateway.inspect.assert_not_awaited()

    async def test_shared_control_keeps_actor_model_and_host_identity_without_opening_thread(self):
        provider = SimpleNamespace(
            descriptor=SimpleNamespace(
                capabilities=CapabilitySet(
                    (
                        RuntimeCapability(
                            RuntimeCapabilityName.SHARED_HOST_CONTROL.value,
                            CapabilityState.SUPPORTED,
                        ),
                        RuntimeCapability(
                            RuntimeCapabilityName.HOST_WARMUP.value,
                            CapabilityState.SUPPORTED,
                        ),
                    )
                )
            ),
            prewarm=AsyncMock(
                return_value=CommandReceipt(
                    RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
                )
            ),
            open=AsyncMock(),
        )
        self.gateway.provider.return_value = provider
        self.runtime._host_environment = AsyncMock(return_value={})
        intent = ModelIntent(model_ref="actor-model")
        self.runtime._models = SimpleNamespace(
            selected_model_key=Mock(return_value="selected-actor-model"),
            session_spec=Mock(
                return_value=SimpleNamespace(runtime_model=Mock(return_value=(intent, None)))
            ),
            release_session=Mock(),
        )
        async with LiveSessionService._host_context(
            self.runtime, cwd=self.root, user_id=USER_ID, model_id="actor-choice"
        ) as (host, identity):
            self.assertEqual(identity, HOST_ID)
            self.assertEqual(host.process_sharing_scope, USER_ID)
            self.assertEqual(host.model, intent)
            self.assertEqual(host.cwd, self.root)
        self.runtime._models.selected_model_key.assert_called_once_with(
            "actor-choice", user_id=USER_ID
        )
        self.runtime._host_environment.assert_awaited_once_with(USER_ID)
        self.runtime._models.release_session.assert_called_once_with(host.request_id)
        provider.prewarm.assert_awaited_once_with(host)
        provider.open.assert_not_awaited()

    async def test_inventory_from_another_host_is_rejected(self):
        self.gateway.inspect.return_value = RuntimeInventory(
            "wrong", {}, host_identity="other-host"
        )
        with self.assertRaisesRegex(RuntimeError, "runtime_host_configuration_conflict"):
            await self.runtime.skill_inventory(cwd=self.root, user_id=USER_ID)
        request = self.gateway.inspect.await_args.args[0]
        self.assertEqual(request.host.process_sharing_scope, USER_ID)
        self.assertEqual(request.host.cwd, self.root)

    async def test_startup_does_not_guess_an_execution_identity(self):
        self.runtime.schedule_readiness = Mock()
        try:
            await self.runtime.start()
            self.runtime.schedule_readiness.assert_called_once_with()
            self.gateway.provider.assert_not_called()
            self.gateway.inspect.assert_not_awaited()
            self.runtime._models.session_spec.assert_not_called()
            self.assertFalse(self.runtime._host_models)
        finally:
            await self.runtime.activation.aclose()

    async def test_explicit_preparation_waits_for_toolchain_before_host_intent(self):
        self.runtime.bind_host_warmup(cwd=self.root, environment=AsyncMock(return_value={}))
        self.runtime.toolchain.defer()
        receipt = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
        )
        provider = SimpleNamespace(prewarm=AsyncMock(return_value=receipt))
        self.gateway.provider.return_value = provider
        intents = []

        @asynccontextmanager
        async def intent(**options):
            intents.append(options)
            yield HostWarmupRequest(
                request_id="preparation", cwd=self.root, process_sharing_scope=USER_ID
            )

        self.runtime._host_intent = intent
        operation = self.start_preparation(
            lambda owner: self.runtime.warm_host(
                user_id=USER_ID, model_id="restored-model", owner=owner
            )
        )
        await asyncio.sleep(0)
        self.assertEqual(intents, [])
        self.gateway.provider.assert_not_called()
        self.runtime._models.session_spec.assert_not_called()
        self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
        self.runtime.toolchain.complete(True)
        self.assertEqual((await self.wait_preparation(operation))["state"], "applied")
        self.assertEqual(len(intents), 1)
        self.assertEqual(intents[0]["model_id"], "restored-model")
        self.assertEqual(intents[0]["expected_model_id"], "restored-model")
        self.assertEqual(self.runtime._host_models, {USER_ID: "restored-model"})
        provider.prewarm.assert_awaited_once()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_explicit_preparation_is_singleflight_and_queryable_after_completion(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def warmup(owner):
            self.assertIs(owner.domain, ActivityDomain.RESOURCE)
            entered.set()
            await release.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
            )

        warm = AsyncMock(side_effect=warmup)
        first = self.start_preparation(warm)
        await entered.wait()
        self.assertEqual(self.start_preparation(warm, request_id=first["request_id"]), first)
        release.set()
        completed = await self.wait_preparation(first)
        self.assertEqual(self.start_preparation(warm, request_id=first["request_id"]), completed)
        warm.assert_awaited_once()
        second = self.start_preparation(warm)
        self.assertNotEqual(second["request_id"], first["request_id"])
        self.assertEqual((await self.wait_preparation(second))["state"], "applied")
        self.assertEqual(warm.await_count, 2)

    async def test_toolchain_gate_is_per_instance_and_only_opens_after_success(self):
        gate = ToolchainReadiness()
        independent = ToolchainReadiness()
        gate.defer()
        independent.require_ready()
        with self.assertRaisesRegex(RuntimeError, "toolchain_preparing"):
            gate.require_ready()
        waiting = asyncio.create_task(gate.wait())
        await asyncio.sleep(0)
        self.assertFalse(waiting.done())
        gate.complete(True)
        await waiting
        gate.require_ready()
        with self.assertRaises(ValueError):
            gate.complete(False)

    async def test_failed_toolchain_wakes_waiters_without_granting_execution(self):
        gate = ToolchainReadiness()
        gate.defer()
        waiting = asyncio.create_task(gate.wait())
        gate.complete(False)
        with self.assertRaisesRegex(RuntimeError, "toolchain_unavailable"):
            await waiting
        with self.assertRaisesRegex(RuntimeError, "toolchain_unavailable"):
            gate.require_ready()

    async def test_runtime_probe_and_inventory_respect_toolchain_admission(self):
        self.runtime.toolchain.defer()
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", ready=True, status=RuntimeStatus.READY
            )
        )
        readiness = await self.runtime.readiness()
        self.assertFalse(readiness.ready)
        self.assertEqual(readiness.safe_error, "toolchain_preparing")
        self.gateway.readiness.assert_not_awaited()
        inventory = asyncio.create_task(
            self.runtime.model_inventory(cwd=self.root, user_id=USER_ID)
        )
        await asyncio.sleep(0)
        self.gateway.inspect.assert_not_awaited()
        with self.assertRaisesRegex(RuntimeError, "toolchain_preparing"):
            self.runtime._runtime_resource_lease()
        self.runtime.toolchain.complete(True)
        await inventory
        self.gateway.inspect.assert_awaited_once()
        self.assertTrue((await self.runtime.readiness()).ready)
        self.gateway.readiness.assert_awaited_once_with("fixture")

    async def test_skill_configuration_waits_for_toolchain_success(self):
        self.runtime.toolchain.defer()
        state = SkillProductState()
        with patch.object(self.runtime, "_reconcile_skills", new=AsyncMock()) as reconcile:
            pending = asyncio.create_task(
                self.runtime.configure_skills(cwd=self.root, state=state, user_id=USER_ID)
            )
            await asyncio.sleep(0)
            finished_early = pending.done()
            calls_before_ready = reconcile.await_count
            self.runtime.toolchain.complete(True)
            result = await asyncio.wait_for(pending, 5)
            self.assertFalse(finished_early)
            self.assertEqual(calls_before_ready, 0)
            self.assertIs(result, reconcile.return_value)
            reconcile.assert_awaited_once()
        self.assertFalse(self.activities.snapshot().counts)

    async def test_failed_toolchain_rejects_skill_configuration_without_reconcile(self):
        self.runtime.toolchain.defer()
        with patch.object(self.runtime, "_reconcile_skills", new=AsyncMock()) as reconcile:
            pending = asyncio.create_task(
                self.runtime.configure_skills(
                    cwd=self.root, state=SkillProductState(), user_id=USER_ID
                )
            )
            await asyncio.sleep(0)
            self.runtime.toolchain.complete(False)
            with self.assertRaisesRegex(RuntimeError, "toolchain_unavailable"):
                await asyncio.wait_for(pending, 5)
            reconcile.assert_not_awaited()
        self.assertFalse(self.activities.snapshot().counts)

    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.activities = Activities()
        self.gateway = SimpleNamespace(
            default_runtime_id="fixture",
            inspect=AsyncMock(return_value=RuntimeInventory("r1", {}, host_identity=HOST_ID)),
            provider=Mock(),
        )
        self.host_context = HostContextFixture(self.root)
        self.skills = Mock()
        self.runtime = LiveSessionService(
            activities=self.activities,
            catalog=Mock(),
            events=Mock(),
            artifacts=Mock(),
            skills=self.skills,
            models=Mock(),
            logger=logging.getLogger(__name__),
            gateway=self.gateway,
        )
        self.runtime._host_context = self.host_context.context

    async def test_shutdown_continues_after_activation_and_driver_close_failures(self):
        activation_error = RuntimeError("activation close failed")
        driver_error = RuntimeError("driver close failed")
        self.runtime.activation.aclose = AsyncMock(side_effect=activation_error)
        driver = SimpleNamespace(close=AsyncMock(side_effect=driver_error))
        self.runtime._one_shot_drivers["invocation"] = ("owner", driver)
        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ("first", "second"))
        first = SimpleNamespace(
            shutdown=AsyncMock(return_value=SimpleNamespace(state=CommandState.ACCEPTED))
        )
        second = SimpleNamespace(
            shutdown=AsyncMock(return_value=SimpleNamespace(state=CommandState.APPLIED))
        )
        self.gateway.provider.side_effect = lambda name: {"first": first, "second": second}[name]
        leases = {
            name: self.activities.enter(ActivityDomain.RUNTIME) for name in ("first", "second")
        }
        self.runtime._uncertain_attachments.update(
            {
                name: RuntimeOpening(name, name, lease, settled=True)
                for name, lease in leases.items()
            }
        )
        with self.assertRaises(BaseExceptionGroup) as caught:
            await self.runtime.aclose()
        first.shutdown.assert_awaited_once()
        second.shutdown.assert_awaited_once()
        self.assertIn(activation_error, caught.exception.exceptions)
        self.assertIn(driver_error, caught.exception.exceptions)
        self.assertIn("first", self.runtime._uncertain_attachments)
        self.assertNotIn("second", self.runtime._uncertain_attachments)
        self.assertIn("invocation", self.runtime._one_shot_drivers)
        generation = self.activities.begin()
        self.assertFalse(self.activities.seal(generation))
        leases["first"].close()
        self.assertTrue(self.activities.seal(generation))

    async def test_shutdown_rejects_waiting_for_its_own_invocation(self):
        task = asyncio.current_task()
        self.runtime._one_shot_tasks["self"] = ("owner", task)
        try:
            with self.assertRaisesRegex(RuntimeError, "active one-shot"):
                await self.runtime.aclose()
            self.assertFalse(self.runtime._closed)
        finally:
            self.runtime._one_shot_tasks.pop("self")

    async def test_update_interrupts_owned_invocations_without_releasing_their_leases(self):
        lease = self.activities.enter(ActivityDomain.INVOCATION)
        finishing = asyncio.Event()
        task = asyncio.create_task(finishing.wait())
        interrupt = AsyncMock(return_value=SimpleNamespace(state=CommandState.ACCEPTED))
        self.runtime._one_shot_tasks["invocation"] = ("owner", task)
        self.runtime._one_shot_drivers["invocation"] = (
            "owner",
            SimpleNamespace(session=SimpleNamespace(interrupt=interrupt)),
        )
        try:
            with self.assertRaises(MaintenanceStale):
                await self.runtime.interrupt_invocations_for_update()
            interrupt.assert_not_awaited()
            generation = self.activities.begin()
            await self.runtime.interrupt_invocations_for_update()
            interrupt.assert_awaited_once()
            self.assertTrue(interrupt.await_args.args[0].cleanup_background_processes)
            self.assertFalse(task.done())
            self.assertFalse(self.activities.seal(generation))
        finally:
            finishing.set()
            await task
            lease.close()

    async def test_update_rejects_unaccepted_invocation_interrupt(self):
        task = asyncio.create_task(asyncio.sleep(10))
        self.runtime._one_shot_tasks["invocation"] = ("owner", task)
        self.runtime._one_shot_drivers["invocation"] = (
            "owner",
            SimpleNamespace(
                session=SimpleNamespace(
                    interrupt=AsyncMock(return_value=SimpleNamespace(state=CommandState.REJECTED))
                )
            ),
        )
        self.activities.begin()
        try:
            with self.assertRaisesRegex(RuntimeError, "invocation interruption failed"):
                await self.runtime.interrupt_invocations_for_update()
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_resource_drain_requires_generation_and_confirmed_receipts(self):
        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ("fixture",))
        release = AsyncMock(return_value=SimpleNamespace(state=CommandState.ACCEPTED))
        self.gateway.provider.return_value = SimpleNamespace(release_idle_resources=release)
        with self.assertRaises(MaintenanceStale):
            await self.runtime.drain_resources("not-a-maintenance-generation")
        release.assert_not_awaited()
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_resources(generation), ("fixture",))
        release.return_value = SimpleNamespace(state=CommandState.APPLIED)
        self.assertEqual(await self.runtime.drain_resources(generation), ())
        self.activities.resume(generation)
        with self.assertRaises(MaintenanceStale):
            await self.runtime.drain_resources(generation)
        self.assertEqual(release.await_count, 2)

    def failed_opening(self, identity="opening", runtime_id="fixture", *, settled=True):
        opening = RuntimeOpening(
            runtime_id=runtime_id,
            session_id=identity,
            activity=self.activities.enter(ActivityDomain.RUNTIME),
            settled=settled,
        )
        self.runtime._uncertain_attachments[identity] = opening
        self.addCleanup(opening.activity.close)
        return opening

    def update_provider(self, state=CommandState.APPLIED):
        provider = SimpleNamespace(
            release_idle_resources=AsyncMock(return_value=SimpleNamespace(state=state)),
            shutdown=AsyncMock(),
        )
        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ("fixture",))
        self.gateway.provider.return_value = provider
        self.runtime.activation.drain_attachments = AsyncMock(return_value=())
        return provider

    async def test_update_reclaims_failed_open_only_after_confirmed_resource_exit(self):
        self.failed_opening()
        provider = self.update_provider()
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ())
        self.assertEqual(self.runtime._uncertain_attachments, {})
        self.assertTrue(self.activities.seal(generation))
        provider.release_idle_resources.assert_awaited_once()
        provider.shutdown.assert_not_awaited()
        self.assertEqual(self.runtime._catalog.mock_calls, [])
        self.activities.resume(generation)
        with self.activities.enter(ActivityDomain.RUNTIME):
            self.assertFalse(self.runtime._closed)

    async def test_failed_native_open_can_drain_without_rewriting_durable_session(self):
        catalog = SessionCatalogStore(self.root / "catalog.sqlite3")
        session_id = "failed-session"
        catalog.allocate(
            session_id,
            SessionPrincipal("owner"),
            runtime_id="fixture",
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root),
            model_id="model",
        )
        self.runtime._catalog = catalog
        provider = self.update_provider()
        provider.open = AsyncMock(side_effect=ConnectionError("native startup failed"))
        live = SimpleNamespace(id=session_id, runtime_id="fixture")
        plan = ActivationPlan(provider, OpenSessionRequest(session_id, self.root), ("model", "ask"))
        with self.assertRaises(ConnectionError):
            await self.runtime._attach_runtime(live, plan, "reservation")
        self.assertEqual(len(self.runtime._uncertain_attachments), 1)
        opening = next(iter(self.runtime._uncertain_attachments.values()))
        self.addCleanup(opening.activity.close)
        self.assertTrue(opening.settled)
        before = catalog.activation(session_id)
        self.assertEqual(before.open_state, OpenState.OPEN_UNKNOWN)
        generation = self.activities.begin()
        self.assertFalse(self.activities.seal(generation))
        self.assertEqual(await self.runtime.drain_for_update(generation), ())
        self.assertTrue(self.activities.seal(generation))
        self.assertEqual(catalog.activation(session_id), before)
        self.assertIsNone(catalog.runtime_binding(session_id))
        provider.shutdown.assert_not_awaited()

    async def test_update_does_not_release_an_unregistered_provider_opening(self):
        self.failed_opening(runtime_id="unregistered")
        self.update_provider()
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ("unregistered",))
        self.assertFalse(self.activities.seal(generation))

    async def test_update_releases_only_provider_with_confirmed_exit(self):
        self.failed_opening("first", "first")
        self.failed_opening("second", "second")
        self.update_provider()
        self.gateway.catalog.runtime_ids = lambda: ("first", "second")
        self.gateway.provider.side_effect = lambda runtime_id: SimpleNamespace(
            release_idle_resources=AsyncMock(
                return_value=SimpleNamespace(
                    state=CommandState.APPLIED if runtime_id == "first" else CommandState.REJECTED
                )
            )
        )
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ("second",))
        self.assertEqual(set(self.runtime._uncertain_attachments), {"second"})

    async def test_update_retains_opening_while_provider_call_is_still_running(self):
        self.failed_opening(settled=False)
        provider = self.update_provider()
        generation = self.activities.begin()
        await self.runtime.drain_for_update(generation)
        self.assertIn("opening", self.runtime._uncertain_attachments)
        self.assertFalse(self.activities.seal(generation))
        provider.shutdown.assert_not_awaited()

    async def test_update_does_not_release_known_active_attachment_or_other_owner(self):
        self.failed_opening()
        owner = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(owner.close)
        provider = self.update_provider()
        self.runtime.activation.drain_attachments.return_value = ("running-session",)
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ("running-session",))
        provider.release_idle_resources.assert_not_awaited()
        self.assertIn("opening", self.runtime._uncertain_attachments)
        self.assertEqual(self.activities.snapshot().counts["turn"], 1)

    async def test_update_retains_failed_opening_when_resource_exit_is_not_confirmed(self):
        self.failed_opening()
        provider = self.update_provider(CommandState.REJECTED)
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ("fixture",))
        self.assertIn("opening", self.runtime._uncertain_attachments)
        provider.release_idle_resources.side_effect = OSError("resource exit failed")
        with self.assertRaises(OSError):
            await self.runtime.drain_for_update(generation)
        self.assertFalse(self.activities.seal(generation))

    async def test_update_retains_failed_opening_after_generation_changes(self):
        self.failed_opening()
        provider = self.update_provider()
        generation = self.activities.begin()

        async def release():
            self.activities.resume(generation)
            return SimpleNamespace(state=CommandState.APPLIED)

        provider.release_idle_resources.side_effect = release
        with self.assertRaises(MaintenanceStale):
            await self.runtime.drain_for_update(generation)
        self.assertIn("opening", self.runtime._uncertain_attachments)

    async def test_update_retains_failed_opening_when_release_is_cancelled(self):
        self.failed_opening()
        provider = self.update_provider()
        provider.release_idle_resources.side_effect = asyncio.CancelledError
        generation = self.activities.begin()
        with self.assertRaises(asyncio.CancelledError):
            await self.runtime.drain_for_update(generation)
        self.assertIn("opening", self.runtime._uncertain_attachments)
        self.assertFalse(self.activities.seal(generation))

    async def test_update_does_not_clear_opening_replaced_during_resource_release(self):
        original = self.failed_opening()
        provider = self.update_provider()
        generation = self.activities.begin()

        async def release():
            original.activity.close()
            self.runtime._uncertain_attachments["opening"] = RuntimeOpening(
                "fixture", "replacement", self.activities.enter(ActivityDomain.RUNTIME)
            )
            return SimpleNamespace(state=CommandState.APPLIED)

        async def release_with_owner():
            with self.activities.continue_from(original.activity, ActivityDomain.RUNTIME):
                return await release()

        provider.release_idle_resources.side_effect = release_with_owner
        try:
            self.assertEqual(await self.runtime.drain_for_update(generation), ("fixture",))
            replacement = self.runtime._uncertain_attachments["opening"]
            self.assertEqual(replacement.session_id, "replacement")
            self.assertFalse(self.activities.seal(generation))
        finally:
            self.runtime._uncertain_attachments["opening"].activity.close()

    async def test_resource_drain_does_not_clear_other_owners_or_report_stale_success(self):
        owner = self.activities.enter(ActivityDomain.RUNTIME)
        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ("fixture",))
        generation = self.activities.begin()

        async def release():
            self.activities.resume(generation)
            return SimpleNamespace(state=CommandState.APPLIED)

        self.gateway.provider.return_value = SimpleNamespace(release_idle_resources=release)
        with self.assertRaises(MaintenanceStale):
            await self.runtime.drain_resources(generation)
        current = self.activities.begin()
        self.assertFalse(self.activities.seal(current))
        owner.close()
        self.assertTrue(self.activities.seal(current))

    async def test_cancelled_readiness_retains_real_probe_process_until_exit(self):
        started = asyncio.Event()
        release = self.root / "release-probe"
        process = None

        async def readiness(runtime_id):
            nonlocal process
            self.assertEqual(runtime_id, "fixture")
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                "-c",
                "import pathlib,sys,time; p=pathlib.Path(sys.argv[1]); "
                "exec('while not p.exists(): time.sleep(0.01)')",
                str(release),
            )
            started.set()
            await process.wait()
            return "ready"

        self.gateway.readiness = AsyncMock(side_effect=readiness)
        task = asyncio.create_task(self.runtime.readiness())
        try:
            await asyncio.wait_for(started.wait(), 5)
            generation = self.activities.begin()
            for _ in range(2):
                task.cancel()
                await asyncio.sleep(0.01)
                self.assertFalse(task.done())
                self.assertIsNone(process.returncode)
                self.assertFalse(self.activities.seal(generation))
            with self.assertRaises(MaintenanceActive):
                await self.runtime.readiness()
        finally:
            release.touch()
            await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 5)
            if process is not None and process.returncode is None:
                process.kill()
                await process.wait()
        self.assertEqual(process.returncode, 0)
        self.assertTrue(self.activities.seal(generation))
        self.gateway.readiness.assert_awaited_once()

    async def test_health_route_refuses_new_probe_and_host_control_during_drain(self):
        app = create_app(self.root, auth=False)
        self.addCleanup(app.state.storage_domains.close)
        activities = app.state.activities
        generation = activities.begin()
        provider = Mock()
        with (
            patch.object(app.state.runtime_service, "_gateway", SimpleNamespace(provider=provider)),
            patch.object(app.state.runtime_service, "readiness", new_callable=AsyncMock) as probe,
        ):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                basic = await client.get("/api/healthz/backend")
                self.assertEqual(basic.status_code, 503)
                response = await client.get("/api/healthz")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"detail": "update_maintenance"})
            self.assertEqual(response.headers["Retry-After"], "1")
            provider.assert_not_called()
            probe.assert_not_awaited()
        self.assertTrue(activities.seal(generation))

    async def test_model_catalog_reads_and_refresh_never_prepare_or_switch_host(self):
        app = create_app(self.root, auth=False)
        self.addCleanup(app.state.storage_domains.close)
        runtime = app.state.runtime_service
        payload = {"configured": True, "current_model": "qwen3.8-flash", "available_models": []}
        gateway = SimpleNamespace(provider=Mock(), inspect=AsyncMock())
        with (
            patch.object(app.state.model_service, "catalog", new_callable=AsyncMock) as catalog,
            patch.object(runtime, "_gateway", gateway),
            patch.object(runtime, "warm_host", new_callable=AsyncMock) as warm,
            patch.object(runtime, "reconfigure_host", new_callable=AsyncMock) as reconfigure,
        ):
            catalog.return_value = payload
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                for refresh in (False, True):
                    response = await client.get(
                        "/api/serve/models", params={"refresh": str(refresh).lower()}
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json(), payload)
                    self.assertEqual(
                        catalog.await_args.kwargs, {"refresh": refresh, "user_id": "local"}
                    )
                    await asyncio.sleep(0)
            self.assertEqual(catalog.await_count, 2)
            gateway.provider.assert_not_called()
            gateway.inspect.assert_not_awaited()
            warm.assert_not_awaited()
            reconfigure.assert_not_awaited()
            self.assertIsNone(runtime.reconfiguration.state)
            self.assertFalse(runtime._host_models)

    async def test_basic_health_does_not_wait_for_runtime(self):
        app = create_app(self.root, auth=True)
        self.addCleanup(app.state.storage_domains.close)
        app.state.runtime_service.toolchain.defer()
        started = asyncio.Event()
        release = asyncio.Event()

        async def readiness(**kwargs):
            started.set()
            await release.wait()
            return RuntimeReadiness(
                runtime_id="codex", status=RuntimeStatus.READY, ready=True, executable="codex"
            )

        with patch.object(app.state.runtime_service, "readiness", side_effect=readiness):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app), base_url="http://test"
            ) as client:
                pending = asyncio.create_task(client.get("/api/healthz"))
                await asyncio.wait_for(started.wait(), 5)
                try:
                    response = await asyncio.wait_for(
                        client.get(
                            "/api/healthz/backend", headers={"Origin": "http://localhost:5173"}
                        ),
                        1,
                    )
                    self.assertEqual(response.status_code, 200)
                    self.assertTrue(response.json()["workbench_ready"])
                    self.assertNotIn("readiness", response.json())
                    self.assertEqual(
                        response.headers["access-control-allow-origin"], "http://localhost:5173"
                    )
                    self.assertFalse(pending.done())
                finally:
                    release.set()
                    detailed = await pending
                self.assertTrue(detailed.json()["readiness"]["ready"])

    async def test_startup_readiness_is_single_owned_task_and_shutdown_joins_it(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def readiness(runtime_id):
            started.set()
            await release.wait()
            return RuntimeReadiness(runtime_id="fixture", status=RuntimeStatus.READY, ready=True)

        self.gateway.readiness = AsyncMock(side_effect=readiness)
        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ())
        self.runtime.schedule_readiness()
        self.runtime.schedule_readiness()
        await asyncio.wait_for(started.wait(), 5)
        closing = asyncio.create_task(self.runtime.aclose())
        try:
            await asyncio.sleep(0.01)
            self.assertFalse(closing.done())
            self.assertTrue(self.activities.snapshot().counts)
        finally:
            release.set()
            await asyncio.wait_for(closing, 5)
        self.gateway.readiness.assert_awaited_once()
        self.assertFalse(self.activities.snapshot().counts)

    async def test_startup_probe_waits_for_toolchain_receipt(self):
        self.runtime.toolchain.defer()
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", status=RuntimeStatus.READY, ready=True
            )
        )
        self.addAsyncCleanup(self.runtime.stop_readiness)
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.gateway.readiness.assert_not_awaited()
        self.assertFalse(self.activities.snapshot().counts)
        self.runtime.toolchain.complete(True)
        await asyncio.wait_for(self.runtime._readiness_task, 1)
        self.gateway.readiness.assert_awaited_once_with("fixture")
        self.assertFalse(self.activities.snapshot().counts)

    async def test_startup_probe_waits_for_workbench_after_receipt(self):
        workbench = asyncio.Event()
        self.activities._workbench_ready = workbench.is_set
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", status=RuntimeStatus.READY, ready=True
            )
        )
        self.addAsyncCleanup(self.runtime.stop_readiness)
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.gateway.readiness.assert_not_awaited()
        workbench.set()
        self.activities.workbench_changed()
        await asyncio.wait_for(self.runtime._readiness_task, 1)
        self.gateway.readiness.assert_awaited_once()

    async def test_public_readiness_does_not_probe_pending_or_failed_toolchain(self):
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", status=RuntimeStatus.READY, ready=True
            )
        )
        self.runtime.toolchain.defer()
        pending = await self.runtime.readiness()
        self.assertFalse(pending.ready)
        self.assertEqual(pending.safe_error, ToolchainState.PREPARING.value)
        self.runtime.toolchain.complete(False)
        failed = await self.runtime.readiness()
        self.assertFalse(failed.ready)
        self.assertEqual(failed.safe_error, ToolchainState.UNAVAILABLE.value)
        self.gateway.readiness.assert_not_awaited()

    async def test_waiting_startup_probe_does_not_block_maintenance(self):
        self.runtime.toolchain.defer()
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", status=RuntimeStatus.READY, ready=True
            )
        )
        self.update_provider()
        self.addAsyncCleanup(self.runtime.stop_readiness)
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        generation = self.activities.begin()
        self.assertEqual(await self.runtime.drain_for_update(generation), ())
        await asyncio.wait_for(self.activities.wait_business_drained(generation), 0.1)
        self.assertTrue(self.activities.seal(generation))
        self.runtime.toolchain.complete(True)
        await asyncio.sleep(0)
        self.gateway.readiness.assert_not_awaited()
        self.activities.resume(generation)
        await asyncio.wait_for(self.runtime._readiness_task, 1)
        self.gateway.readiness.assert_awaited_once_with("fixture")

    async def test_workbench_waiting_probe_does_not_block_maintenance(self):
        self.activities._workbench_ready = lambda: False
        self.gateway.readiness = AsyncMock()
        self.addAsyncCleanup(self.runtime.stop_readiness)
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        generation = self.activities.begin()
        await asyncio.wait_for(self.activities.wait_business_drained(generation), 0.1)
        self.assertTrue(self.activities.seal(generation))
        self.gateway.readiness.assert_not_awaited()

    async def test_pending_probe_stop_joins_without_executing_probe(self):
        self.runtime.toolchain.defer()
        self.gateway.readiness = AsyncMock()
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        await self.runtime.stop_readiness()
        self.gateway.readiness.assert_not_awaited()
        self.assertTrue(self.runtime._readiness_task.done())
        self.assertFalse(self.activities.snapshot().counts)

    async def test_failed_toolchain_receipt_never_runs_startup_probe(self):
        self.runtime.toolchain.defer()
        self.gateway.readiness = AsyncMock()
        self.addAsyncCleanup(self.runtime.stop_readiness)
        self.runtime.schedule_readiness()
        await asyncio.sleep(0)
        with self.assertLogs(__name__, level="ERROR"):
            self.runtime.toolchain.complete(False)
            await asyncio.wait_for(self.runtime._readiness_task, 1)
        self.gateway.readiness.assert_not_awaited()

    async def test_authenticated_tcp_toolchain_receipt_precedes_runtime_probe(self):
        self.runtime.toolchain.defer()
        receipt = asyncio.get_running_loop().create_future()
        release = asyncio.Event()
        self.gateway.readiness = AsyncMock(
            return_value=RuntimeReadiness(
                runtime_id="fixture", status=RuntimeStatus.READY, ready=True
            )
        )

        async def peer(reader, writer):
            try:
                greeting = json.loads(await reader.readline())
                self.assertEqual(greeting, {"token": "a" * 64})
                self.gateway.readiness.assert_not_awaited()
                writer.write(b"ready\n")
                writer.write(
                    json.dumps(
                        {
                            "operation": "toolchain",
                            "ready": True,
                            "resources": {
                                "version": "2026-r3",
                                "archiveSha256": "a" * 64,
                                "fontDirectories": [str(self.root / "fonts")],
                            },
                        }
                    ).encode()
                    + b"\n"
                )
                await writer.drain()
                length = int.from_bytes(await reader.readexactly(4), "big")
                self.assertEqual(await reader.readexactly(length), b"\x01")
                receipt.set_result(None)
                await release.wait()
            except Exception as error:
                if not receipt.done():
                    receipt.set_exception(error)
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(peer, "127.0.0.1", 0)
        control = ParentControl(self.activities, toolchain_complete=self.runtime.toolchain.complete)
        self.runtime.schedule_readiness()
        try:
            control.start(
                json.dumps(
                    {"version": 1, "port": server.sockets[0].getsockname()[1], "token": "a" * 64}
                ).encode()
            )
            await asyncio.wait_for(receipt, 2)
            await asyncio.wait_for(self.runtime._readiness_task, 1)
            self.gateway.readiness.assert_awaited_once_with("fixture")
        finally:
            release.set()
            await control.aclose()
            server.close()
            await server.wait_closed()
            await self.runtime.stop_readiness()

    async def test_failed_lifespan_entry_joins_startup_probe(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def readiness(runtime_id):
            started.set()
            await release.wait()
            return RuntimeReadiness(runtime_id="fixture", status=RuntimeStatus.READY, ready=True)

        @asynccontextmanager
        async def previous(application):
            await started.wait()
            raise RuntimeError("listener failed")
            yield

        application = ServeApplication(activities=self.activities)
        application.state.runtime_service = self.runtime
        application.state.activities = self.activities
        application.router.lifespan_context = previous
        self.gateway.readiness = AsyncMock(side_effect=readiness)
        serve._prepare_startup(application)

        async def enter():
            async with application.router.lifespan_context(application):
                self.fail("failed listener cannot serve")

        with patch.object(serve, "_ensure_skill_python_path", new=AsyncMock()):
            pending = asyncio.create_task(enter())
            await asyncio.wait_for(started.wait(), 5)
            try:
                await asyncio.sleep(0.01)
                self.assertFalse(pending.done())
                self.assertTrue(self.activities.snapshot().counts)
            finally:
                release.set()
            with self.assertRaisesRegex(RuntimeError, "listener failed"):
                await asyncio.wait_for(pending, 5)
        self.assertFalse(self.activities.snapshot().counts)

    async def test_stop_readiness_delays_repeated_cancellation_and_is_idempotent(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def readiness(runtime_id):
            started.set()
            await release.wait()

        self.gateway.readiness = AsyncMock(side_effect=readiness)
        self.runtime.schedule_readiness()
        await asyncio.wait_for(started.wait(), 5)
        stopping = asyncio.create_task(self.runtime.stop_readiness())
        try:
            await asyncio.sleep(0.01)
            for _ in range(2):
                stopping.cancel()
                await asyncio.sleep(0.01)
                self.assertFalse(stopping.done())
                self.assertTrue(self.activities.snapshot().counts)
        finally:
            release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(stopping, 5)
        await self.runtime.stop_readiness()
        self.assertFalse(self.activities.snapshot().counts)

    async def test_explicit_preparation_refuses_new_work_until_resume(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def warmup(owner):
            self.assertIs(owner.domain, ActivityDomain.RESOURCE)
            entered.set()
            await release.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
            )

        warm = AsyncMock(side_effect=warmup)
        generation = self.activities.begin()
        with self.assertRaises(MaintenanceActive):
            self.start_preparation(warm)
        warm.assert_not_awaited()
        self.gateway.inspect.assert_not_awaited()
        self.assertTrue(self.activities.seal(generation))
        self.activities.resume(generation)
        operation = self.start_preparation(warm)
        await asyncio.wait_for(entered.wait(), 3)
        generation = self.activities.begin()
        self.assertFalse(self.activities.seal(generation))
        self.assertEqual(
            self.start_preparation(warm, request_id=operation["request_id"]), operation
        )
        release.set()
        self.assertEqual((await self.wait_preparation(operation))["state"], "applied")
        self.assertFalse(self.runtime.reconfiguration.pending)
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_preparation_waiter_retains_cleanup_until_runtime_close(self):
        entered, release, closed = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def warmup(owner):
            try:
                entered.set()
                await release.wait()
                return CommandReceipt(
                    RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
                )
            finally:
                closed.set()

        self.gateway.catalog = SimpleNamespace(runtime_ids=lambda: ())
        operation = self.start_preparation(warmup)
        waiting = asyncio.create_task(self.wait_preparation(operation))
        stopping = None
        try:
            await asyncio.wait_for(entered.wait(), 3)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            self.assertFalse(closed.is_set())
            generation = self.activities.begin()
            stopping = asyncio.create_task(self.runtime.aclose())
            await asyncio.sleep(0.02)
            stopping.cancel()
            await asyncio.sleep(0.02)
            self.assertFalse(stopping.done())
            self.assertFalse(self.activities.seal(generation))
        finally:
            release.set()
            if stopping is not None:
                await asyncio.gather(stopping, return_exceptions=True)
        self.assertTrue(closed.is_set())
        self.assertFalse(self.runtime.reconfiguration.pending)
        self.assertEqual(
            self.runtime.reconfiguration.status(operation["request_id"], None, USER_ID)["state"],
            "applied",
        )
        self.assertTrue(self.activities.seal(generation))

    async def test_cancel_before_first_preparation_wait_preserves_service_owned_operation(self):
        warm = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id=HOST_ID
            )
        )
        operation = self.start_preparation(warm)
        waiting = asyncio.create_task(self.wait_preparation(operation))
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        self.assertEqual((await self.wait_preparation(operation))["state"], "applied")
        warm.assert_awaited_once()
        self.gateway.inspect.assert_not_awaited()
        generation = self.activities.begin()
        self.assertTrue(self.activities.seal(generation))

    async def test_model_and_skill_inspections_retain_cleanup_after_caller_cancel(self):
        for operation in (self.runtime.model_inventory, self.runtime.skill_inventory):
            with self.subTest(operation=operation.__name__):
                entered, release = asyncio.Event(), asyncio.Event()

                async def inspect(*args, entered=entered, release=release):
                    try:
                        return RuntimeInventory("r1", {}, host_identity=HOST_ID)
                    finally:
                        entered.set()
                        await release.wait()

                self.gateway.inspect.side_effect = inspect
                request = asyncio.create_task(operation(cwd=self.root, user_id=USER_ID))
                try:
                    await asyncio.wait_for(entered.wait(), 3)
                    generation = self.activities.begin()
                    request.cancel()
                    await asyncio.sleep(0.02)
                    self.assertFalse(request.done())
                    self.assertFalse(self.activities.seal(generation))
                finally:
                    release.set()
                    await asyncio.gather(request, return_exceptions=True)
                self.assertTrue(self.activities.seal(generation))
                self.activities.resume(generation)

    async def test_cancelled_configuration_finishes_verification_and_durable_state(self):
        entered, release = asyncio.Event(), asyncio.Event()
        manifest = self.root / "SKILL.md"
        desired = SkillProductState(disabled_skills=frozenset({"fixture"}))
        state_file = self.root / "state.json"
        self.skills.manifest.side_effect = lambda path: path
        self.skills.enablement_plan.return_value = SkillEnablementPlan(
            ((manifest, False),), desired
        )
        self.gateway.inspect.side_effect = [
            RuntimeInventory(
                "r1",
                {
                    "skills": {
                        "skills": [{"name": "fixture", "path": str(manifest), "enabled": True}]
                    }
                },
                host_identity=HOST_ID,
            ),
            RuntimeInventory(
                "r2",
                {
                    "skills": {
                        "skills": [{"name": "fixture", "path": str(manifest), "enabled": False}]
                    }
                },
                host_identity=HOST_ID,
            ),
        ]

        async def configure(request):
            entered.set()
            await release.wait()
            return SimpleNamespace(state=CommandState.APPLIED)

        provider = SimpleNamespace(configure_skills=AsyncMock(side_effect=configure))
        self.gateway.provider.return_value = provider
        with (
            patch(
                "service.chat.runtime.composition.load_skill_state",
                side_effect=lambda: load_skill_state(state_file),
            ),
            patch(
                "service.chat.runtime.composition.save_skill_state",
                side_effect=lambda state: save_skill_state(state, state_file),
            ),
        ):
            task = asyncio.create_task(
                self.runtime.configure_skills(cwd=self.root, state=desired, user_id=USER_ID)
            )
            try:
                await asyncio.wait_for(entered.wait(), 3)
                generation = self.activities.begin()
                task.cancel()
                await asyncio.sleep(0.02)
                self.assertFalse(task.done())
                self.assertFalse(state_file.exists())
                self.assertFalse(self.activities.seal(generation))
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)
        self.assertEqual(load_skill_state(state_file), desired)
        self.assertEqual(self.gateway.inspect.await_count, 2)
        self.assertTrue(self.activities.seal(generation))

    async def test_maintenance_rejects_public_skill_routes_without_inspection_or_credentials(self):
        app = ServeApplication(activities=self.activities)
        app.state.skill_catalog = SkillCatalog(
            bundled_root=self.root / "bundled", user_root=self.root / "user"
        )
        app.state.runtime_service = self.runtime
        public_skills = SimpleNamespace(payload=AsyncMock(), document=AsyncMock())
        credentials = SimpleNamespace(ensure=AsyncMock())
        mount_skill_routes(
            app, activities=self.activities, skills=public_skills, credentials=credentials
        )
        register_capability_routes(app, activities=self.activities, workspace=self.root)
        generation = self.activities.begin()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            for method, route, kwargs in (
                ("GET", "/api/serve/skills", {}),
                ("GET", "/api/serve/skills/fixture/document", {}),
                ("POST", "/api/capabilities/skills/create", {"json": {}}),
                ("POST", "/api/capabilities/skills/fixture/activate", {}),
                ("DELETE", "/api/capabilities/skills/fixture", {}),
            ):
                response = await client.request(method, route, **kwargs)
                self.assertEqual(response.status_code, 503, response.text)
                self.assertEqual(response.json()["detail"], "update_maintenance")
            # Installed-package browsing is passive; it never opens a runtime.
            catalog = await client.get("/api/capabilities/skills")
            self.assertEqual(catalog.status_code, 200, catalog.text)
            self.assertEqual(catalog.json()["skills"], [])
        credentials.ensure.assert_not_awaited()
        public_skills.payload.assert_not_awaited()
        self.gateway.inspect.assert_not_awaited()
        self.assertTrue(self.activities.seal(generation))
        with self.assertRaises(MaintenanceActive):
            await self.runtime.skill_inventory(cwd=self.root, user_id=USER_ID)


if __name__ == "__main__":
    unittest.main()
