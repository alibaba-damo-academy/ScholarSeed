"""Deterministic shared-host switch contracts, not product acceptance."""

from __future__ import annotations

import asyncio
import logging
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

import httpx
from fastapi import FastAPI

from scholarseed_runtime.contract.command import CommandReceipt, CommandState
from scholarseed_runtime.contract.model import MODEL_CATALOG_UNAVAILABLE
from scholarseed_runtime.contract.provider import (
    RUNTIME_HOST_RECONFIGURATION_COMMAND,
    RUNTIME_HOST_WARMUP_COMMAND,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_BUSY,
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
)
from service.chat.api.sessions import mount_session_routes
from service.chat.constants import SESSION_ARCHIVED_ERROR
from service.chat.persistence.catalog import SessionAccessError, SessionPrincipal
from service.chat.runtime.activation import SessionActivationError
from service.chat.runtime.reconfiguration import (
    PREPARATION_CLOSED,
    PREPARATION_DEFAULT_FAILED,
    PREPARATION_INSTANCE_CHANGED,
    PREPARATION_INVALID,
    RECONFIGURATION_INVALID,
    RECONFIGURATION_NOT_FOUND,
    RECONFIGURATION_STALE,
    HostReconfiguration,
    PreparationError,
)
from service.chat.service.sessions import SessionService
from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceActive
from service.platform.parent_control import ParentControl


class ReconfigurationContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.activities = Activities()
        self.drain = AsyncMock(return_value=())
        self.apply = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_RECONFIGURATION_COMMAND,
                CommandState.APPLIED,
                correlation_id="new-host:1",
            )
        )
        self.manager = HostReconfiguration(
            activities=self.activities, drain=self.drain, logger=logging.getLogger(__name__)
        )
        self.model = "target"
        self.identity = str(uuid4())

    def start(self, **changes):
        def validate():
            if self.model != "target":
                raise ValueError(RECONFIGURATION_STALE)

        return self.manager.start(
            **{
                "request_id": self.identity,
                "session_id": "session",
                "user_id": "owner",
                "model_id": "target",
                "wait_seconds": 1,
                "validate": validate,
                "apply": self.apply,
                **changes,
            }
        )

    async def test_waits_for_existing_business_blocks_new_roots_then_switches(self):
        self.assertIsNone(self.manager.state)
        business = self.activities.enter(ActivityDomain.TURN, root=True)
        initial = self.start()
        self.assertEqual(initial["state"], "accepted")
        with self.assertRaises(MaintenanceActive):
            self.activities.enter(ActivityDomain.RUNTIME, root=True)
        await asyncio.sleep(0)
        self.drain.assert_not_awaited()
        business.close()
        await self.manager.aclose()
        self.drain.assert_awaited_once()
        self.apply.assert_awaited_once()
        self.assertEqual(self.manager.status(self.identity, "session", "owner")["state"], "applied")
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertIs(self.manager.state, CommandState.APPLIED)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_busy_timeout_preserves_task_and_does_not_drain(self):
        business = self.activities.enter(ActivityDomain.TURN, root=True)
        self.start(wait_seconds=0.001)
        await self.manager.aclose()
        self.assertEqual(
            self.manager.status(self.identity, "session", "owner")["error"],
            "runtime_resource_wait_timeout",
        )
        self.apply.assert_not_awaited()
        self.drain.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {"turn": 1})
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        business.close()

    async def test_waits_for_resource_cleanup_after_provider_drain(self):
        watcher = self.activities.enter(ActivityDomain.RESOURCE, root=True)
        native_wait = self.activities.enter(ActivityDomain.RESOURCE, root=True)
        drained = asyncio.Event()

        async def drain(generation):
            drained.set()
            return ()

        self.drain.side_effect = drain
        self.start()
        await drained.wait()
        await asyncio.sleep(0)
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
        native_wait.close()
        await asyncio.sleep(0)
        self.apply.assert_not_awaited()
        watcher.close()
        await self.manager.aclose()
        self.apply.assert_awaited_once()
        self.assertEqual(self.manager.status(self.identity, "session", "owner")["state"], "applied")
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_idempotent_request_and_concurrent_target_rejection(self):
        business = self.activities.enter(ActivityDomain.TURN, root=True)
        first = self.start()
        self.assertEqual(self.start(), first)
        with self.assertRaisesRegex(ValueError, "runtime_host_busy"):
            self.start(request_id=str(uuid4()))
        with self.assertRaisesRegex(ValueError, RECONFIGURATION_STALE):
            self.start(model_id="different")
        business.close()
        await self.manager.aclose()
        self.apply.assert_awaited_once()

    async def test_status_is_bound_to_actor_and_session(self):
        self.start()
        self.assertEqual(self.manager.current("session", "owner")["request_id"], self.identity)
        self.assertIsNone(self.manager.current("session", "another-owner"))
        with self.assertRaises(ValueError):
            self.manager.status(self.identity, "session", "another-owner")
        with self.assertRaises(ValueError):
            self.manager.status(self.identity, "another-session", "owner")
        await self.manager.aclose()

    async def test_model_changed_while_waiting_rejects_before_drain(self):
        business = self.activities.enter(ActivityDomain.TURN, root=True)
        self.start()
        self.model = "changed"
        business.close()
        await self.manager.aclose()
        self.assertEqual(
            self.manager.status(self.identity, "session", "owner")["error"], RECONFIGURATION_STALE
        )
        self.drain.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_unknown_resource_or_attachment_keeps_gate_closed(self):
        for extra_resource in (False, True):
            with self.subTest(extra_resource=extra_resource):
                self.setUp()
                resource = (
                    self.activities.enter(ActivityDomain.RESOURCE, root=True)
                    if extra_resource
                    else None
                )
                self.drain.return_value = () if extra_resource else ("unknown-session",)
                self.start()
                await self.manager.aclose()
                self.apply.assert_not_awaited()
                self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
                self.assertEqual(
                    self.manager.status(self.identity, "session", "owner")["error"],
                    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
                )
                if resource is not None:
                    resource.close()

    async def test_failed_target_never_reopens_for_default_prewarm(self):
        self.apply.side_effect = OSError("target startup failed")
        self.start()
        with self.assertLogs(__name__, level="ERROR"):
            await self.manager.aclose()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
        with self.assertRaises(MaintenanceActive):
            self.activities.enter(ActivityDomain.RUNTIME, root=True)
        self.assertEqual(
            self.manager.status(self.identity, "session", "owner")["state"], "restart_required"
        )

    async def test_shutdown_joins_switch_despite_repeated_cancellation(self):
        gate = asyncio.Event()
        entered = asyncio.Event()

        async def apply(owner):
            entered.set()
            await gate.wait()
            return CommandReceipt(RUNTIME_HOST_RECONFIGURATION_COMMAND, CommandState.APPLIED)

        self.start(apply=apply)
        await entered.wait()
        closing = asyncio.create_task(self.manager.aclose())
        await asyncio.sleep(0)
        for _attempt in range(2):
            closing.cancel()
            await asyncio.sleep(0)
        self.assertFalse(closing.done())
        gate.set()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertEqual(self.manager.status(self.identity, "session", "owner")["state"], "applied")
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_transport_request_does_not_prevent_drain_or_join(self):
        gate = asyncio.Event()
        entered = asyncio.Event()

        async def apply(owner):
            entered.set()
            await gate.wait()
            return CommandReceipt(RUNTIME_HOST_RECONFIGURATION_COMMAND, CommandState.APPLIED)

        with self.activities.observe_request():
            self.start(apply=apply)
            await entered.wait()
            closing = asyncio.create_task(self.manager.aclose())
            await asyncio.sleep(0)
            self.assertFalse(closing.done())
            self.assertEqual(self.activities.snapshot().counts, {"request": 1, "resource": 1})
            gate.set()
            await closing
        self.assertEqual(self.activities.snapshot().counts, {})


class PreparationContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.activities = Activities()
        self.drain = AsyncMock(return_value=())
        self.apply = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_RECONFIGURATION_COMMAND,
                CommandState.APPLIED,
                correlation_id="prepared-host:2",
            )
        )
        self.warm = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND,
                CommandState.APPLIED,
                correlation_id="compatible-host:1",
            )
        )
        self.validate = Mock()
        self.commit = Mock()
        self.identity = str(uuid4())
        self.manager = HostReconfiguration(
            activities=self.activities, drain=self.drain, logger=logging.getLogger(__name__)
        )

    async def asyncTearDown(self):
        await self.manager.aclose()

    def start(self, **changes):
        return self.manager.start(
            **{
                "request_id": self.identity,
                "session_id": None,
                "user_id": "owner",
                "model_id": "target",
                "wait_seconds": 1,
                "validate": self.validate,
                "apply": self.apply,
                "warm": self.warm,
                "commit": self.commit,
                **changes,
            }
        )

    async def wait(self):
        return await self.manager.wait(self.identity, None, "owner")

    async def test_compatible_warm_preserves_business_and_never_drains(self):
        business = self.activities.enter(ActivityDomain.TURN, root=True)

        def commit():
            operation = self.manager.status(self.identity, None, "owner")
            self.assertEqual(operation["state"], "accepted")
            self.assertIsNone(operation["session_id"])
            self.assertEqual(self.activities.snapshot().counts, {"turn": 1, "resource": 1})
            self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

        self.commit.side_effect = commit
        try:
            self.start()
            result = await self.wait()
            self.assertEqual(result["state"], "applied")
            self.commit.assert_called_once()
            self.warm.assert_awaited_once()
            self.apply.assert_not_awaited()
            self.drain.assert_not_awaited()
            self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
            self.assertEqual(self.activities.snapshot().counts, {"turn": 1})
        finally:
            business.close()

    async def assert_conflict_drains_after_business(self):
        business = self.activities.enter(ActivityDomain.TURN, root=True)
        try:
            self.start()
            await asyncio.sleep(0)
            self.warm.assert_awaited_once()
            self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
            self.drain.assert_not_awaited()
            self.apply.assert_not_awaited()
            with self.assertRaises(MaintenanceActive):
                self.activities.enter(ActivityDomain.RUNTIME, root=True)
        finally:
            business.close()
        result = await self.wait()
        self.assertEqual(result["state"], "applied")
        self.drain.assert_awaited_once()
        self.apply.assert_awaited_once()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_precise_conflict_receipt_enters_controlled_drain(self):
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND,
            CommandState.RESTART_REQUIRED,
            safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
        )
        await self.assert_conflict_drains_after_business()

    async def test_precise_conflict_exception_enters_controlled_drain(self):
        self.warm.side_effect = SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        await self.assert_conflict_drains_after_business()

    async def test_precise_conflict_value_error_enters_controlled_drain(self):
        self.warm.side_effect = ValueError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        await self.assert_conflict_drains_after_business()

    async def test_nonconflict_rejection_never_uses_reconfiguration(self):
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND,
            CommandState.REJECTED,
            safe_error=RESOURCE_HOST_BUSY,
        )
        self.start()
        result = await self.wait()
        self.assertEqual((result["state"], result["error"]), ("rejected", RESOURCE_HOST_BUSY))
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def assert_uncertain_fence(self):
        self.start()
        result = await self.wait()
        self.assertEqual(result["state"], "restart_required")
        self.assertEqual(result["error"], RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
        self.assertEqual(self.activities.snapshot().counts, {})
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        with self.assertRaises(MaintenanceActive):
            self.activities.enter(ActivityDomain.RUNTIME, root=True)

    async def test_uncertain_warm_receipt_fences_admission(self):
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND,
            CommandState.RESTART_REQUIRED,
            safe_error=RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
        )
        await self.assert_uncertain_fence()

    async def test_uncertain_warm_exception_fences_admission(self):
        self.warm.side_effect = RuntimeError(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        with self.assertLogs(__name__, level="ERROR"):
            await self.assert_uncertain_fence()

    async def test_failed_preparation_can_handoff_to_update_without_reopening(self):
        self.warm.side_effect = RuntimeError("runtime_rpc_timeout")
        with self.assertLogs(__name__, level="ERROR"):
            await self.assert_uncertain_fence()
        fence = self.activities.snapshot().generation
        interrupt = AsyncMock()
        drain = AsyncMock(return_value=())
        control = ParentControl(
            self.activities, interrupt_running=interrupt, drain_attachments=drain
        )
        for _attempt in range(2):
            response = await control._command({"operation": "quiesce", "generation": None})
            self.assertEqual(response[:1], b"\x01")
            generation = response[1:].decode("ascii")
            self.assertNotEqual(generation, fence)
            with self.assertRaises(MaintenanceActive):
                self.activities.enter(ActivityDomain.TURN, root=True)
            await control._command({"operation": "resume", "generation": generation})
            self.assertEqual(self.activities.snapshot().generation, fence)
            self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
            with self.assertRaises(MaintenanceActive):
                self.activities.enter(ActivityDomain.RUNTIME, root=True)
        self.assertEqual(interrupt.await_count, 2)
        self.assertEqual(drain.await_count, 2)
        self.assertIs(self.manager.state, CommandState.RESTART_REQUIRED)

    async def test_unknown_warm_value_error_fences_admission(self):
        self.warm.side_effect = ValueError("native outcome unavailable")
        await self.assert_uncertain_fence()

    async def test_unknown_warm_timeout_fences_admission(self):
        self.warm.side_effect = TimeoutError("native outcome unavailable")
        with self.assertLogs(__name__, level="WARNING"):
            await self.assert_uncertain_fence()

    async def test_uncertain_warm_receipt_is_not_overwritten_by_stale_intent(self):
        self.validate.side_effect = [None, ValueError(RECONFIGURATION_STALE)]
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND,
            CommandState.RESTART_REQUIRED,
            safe_error=RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
        )
        await self.assert_uncertain_fence()
        self.validate.assert_called_once()

    async def test_cancelled_warm_transaction_fences_admission(self):
        self.warm.side_effect = asyncio.CancelledError()
        with self.assertLogs(__name__, level="ERROR"):
            await self.assert_uncertain_fence()

    async def test_commit_failure_is_queryable_and_never_warms(self):
        self.commit.side_effect = PermissionError("default storage unavailable")
        with self.assertLogs(__name__, level="ERROR"):
            result = self.start()
        self.assertEqual(result["state"], "rejected")
        self.assertEqual(result["error"], PREPARATION_DEFAULT_FAILED)
        self.assertEqual(self.manager.status(self.identity, None, "owner"), result)
        self.warm.assert_not_awaited()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_invalid_intent_is_queryable_without_commit_or_warm(self):
        self.validate.side_effect = ValueError("model unavailable")
        result = self.start()
        self.assertEqual((result["state"], result["error"]), ("rejected", PREPARATION_INVALID))
        self.commit.assert_not_called()
        self.warm.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_uuid_actor_model_and_scope_bind_idempotent_preparation(self):
        first = self.start()
        self.assertEqual(self.start(), first)
        for change in (
            {"user_id": "another-owner"},
            {"model_id": "another-model"},
            {"session_id": "another-session"},
            {"commit": None},
        ):
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, RECONFIGURATION_STALE):
                    self.start(**change)
        self.assertIsNone(self.manager.current(None, "another-owner"))
        self.assertIsNone(self.manager.current("another-session", "owner"))
        with self.assertRaisesRegex(ValueError, RECONFIGURATION_NOT_FOUND):
            self.manager.status(self.identity, None, "another-owner")
        with self.assertRaisesRegex(ValueError, RECONFIGURATION_NOT_FOUND):
            self.manager.status(self.identity, "another-session", "owner")
        applied = await self.wait()
        self.assertEqual(self.start(), applied)
        self.commit.assert_called_once()
        self.warm.assert_awaited_once()

    async def test_uuid_without_commit_cannot_later_request_default_persistence(self):
        self.start(commit=None)
        with self.assertRaisesRegex(ValueError, RECONFIGURATION_STALE):
            self.start()
        self.assertEqual((await self.wait())["state"], "applied")
        self.commit.assert_not_called()
        self.warm.assert_awaited_once()

    async def test_invalid_uuid_has_no_operation_or_commit(self):
        with self.assertRaisesRegex(ValueError, RECONFIGURATION_INVALID):
            self.start(request_id="not-a-uuid")
        self.commit.assert_not_called()
        self.validate.assert_not_called()
        self.warm.assert_not_awaited()
        self.assertIsNone(self.manager.state)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_competing_target_is_not_committed_while_preparation_is_owned(self):
        entered = asyncio.Event()
        released = asyncio.Event()

        async def warm(_owner):
            entered.set()
            await released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        self.warm.side_effect = warm
        self.start()
        await entered.wait()
        competing_commit = Mock()
        try:
            with self.assertRaisesRegex(ValueError, RESOURCE_HOST_BUSY):
                self.start(
                    request_id=str(uuid4()), model_id="another-model", commit=competing_commit
                )
            competing_commit.assert_not_called()
            self.commit.assert_called_once()
            self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
        finally:
            released.set()
        self.assertEqual((await self.wait())["state"], "applied")

    async def test_stale_intent_after_warm_is_not_reported_ready_or_reconfigured(self):
        self.validate.side_effect = [None, ValueError(RECONFIGURATION_STALE)]
        self.start()
        result = await self.wait()
        self.assertEqual((result["state"], result["error"]), ("rejected", RECONFIGURATION_STALE))
        self.warm.assert_awaited_once()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_cancelled_waiter_does_not_cancel_service_owned_warm(self):
        entered = asyncio.Event()
        released = asyncio.Event()

        async def warm(_owner):
            entered.set()
            await released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        self.warm.side_effect = warm
        self.start()
        waiting = asyncio.create_task(self.wait())
        await entered.wait()
        waiting.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiting
        self.assertEqual(self.manager.status(self.identity, None, "owner")["state"], "accepted")
        self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
        released.set()
        result = await self.wait()
        self.assertEqual(result["state"], "applied")
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_shutdown_joins_warm_despite_repeated_cancellation(self):
        entered = asyncio.Event()
        released = asyncio.Event()

        async def warm(_owner):
            entered.set()
            await released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        self.warm.side_effect = warm
        self.start()
        await entered.wait()
        closing = asyncio.create_task(self.manager.aclose())
        await asyncio.sleep(0)
        for _attempt in range(2):
            closing.cancel()
            await asyncio.sleep(0)
        self.assertFalse(closing.done())
        self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
        released.set()
        with self.assertRaises(asyncio.CancelledError):
            await closing
        self.assertEqual(self.manager.status(self.identity, None, "owner")["state"], "applied")
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)


class ModelAdmissionContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.activities = Activities()
        self.drain = AsyncMock(return_value=())
        self.manager = HostReconfiguration(
            activities=self.activities, drain=self.drain, logger=logging.getLogger(__name__)
        )
        self.warm = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )
        )
        self.apply = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_RECONFIGURATION_COMMAND,
                CommandState.APPLIED,
                correlation_id="switched-host:2",
            )
        )
        self.selected = Mock(side_effect=lambda model_id, **_options: model_id)
        self.settings = SimpleNamespace(set_runtime_model=Mock())
        self.service = object.__new__(SessionService)
        self.service._activities = self.activities
        self.service._settings = self.settings
        self.record = SimpleNamespace(archived=False)
        self.service._access = SimpleNamespace(require=Mock(), get=Mock(return_value=self.record))
        self.service._sessions = {}
        self.service._runtime = SimpleNamespace(
            reconfiguration=self.manager,
            reconfiguration_wait_seconds=1,
            selected_model_key=self.selected,
            warm_host=self.warm,
            reconfigure_host=self.apply,
        )
        self.service.model = Mock(return_value={"model_id": "target"})
        self.service.align_metering_identity = AsyncMock(return_value=False)
        self.principal = SessionPrincipal("stored-owner")

    async def asyncTearDown(self):
        await self.manager.aclose()

    def admission(self, model_id="target"):
        return self.service.model_admission(
            model_id,
            actor_id="actor",
            domain=ActivityDomain.TURN,
            service_instance_id=self.activities.instance_id,
        )

    async def test_waiting_carries_only_service_operation_resource_then_admits_turn(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        admitted = []

        async def warm(**_options):
            entered.set()
            await released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        async def send():
            async with self.admission():
                admitted.append(self.activities.snapshot().counts)

        self.warm.side_effect = warm
        waiting = asyncio.create_task(send())
        await entered.wait()
        try:
            self.assertEqual(admitted, [])
            self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
            self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        finally:
            released.set()
            await waiting
        self.assertEqual(admitted, [{"turn": 1}])
        self.assertEqual(self.activities.snapshot().counts, {})
        self.settings.set_runtime_model.assert_not_called()

    async def test_competing_target_waits_without_own_lease_and_can_switch(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        admitted = []

        async def warm(*, model_id, **_options):
            if model_id == "first":
                entered.set()
                await released.wait()
                return CommandReceipt(
                    RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="first:1"
                )
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND,
                CommandState.RESTART_REQUIRED,
                safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )

        async def send():
            async with self.admission("second"):
                admitted.append(self.activities.snapshot().counts)

        self.warm.side_effect = warm
        self.service.prepare_model(
            "first",
            actor_id="actor",
            request_id=str(uuid4()),
            service_instance_id=self.activities.instance_id,
        )
        await entered.wait()
        waiting = asyncio.create_task(send())
        await asyncio.sleep(0)
        try:
            self.assertEqual(admitted, [])
            self.assertEqual(self.warm.await_count, 1)
            self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
        finally:
            released.set()
            await asyncio.wait_for(waiting, 1)
        self.assertEqual(self.warm.await_count, 2)
        self.apply.assert_awaited_once()
        self.assertEqual(self.apply.await_args.kwargs["model_id"], "second")
        self.assertEqual(admitted, [{"turn": 1}])
        self.assertEqual(self.activities.snapshot().counts, {})
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_multiple_waiters_with_distinct_actors_each_admit_once(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        admitted = []
        targets = (("second", "actor-a"), ("third", "actor-b"), ("fourth", "actor-a"))

        async def warm(*, model_id, **_options):
            if model_id == "initial":
                entered.set()
                await released.wait()
            await asyncio.sleep(0)
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="host:1"
            )

        async def send(model_id, actor_id):
            async with self.service.model_admission(
                model_id,
                actor_id=actor_id,
                domain=ActivityDomain.TURN,
                service_instance_id=self.activities.instance_id,
            ):
                admitted.append((model_id, actor_id, dict(self.activities.snapshot().counts)))

        self.warm.side_effect = warm
        self.service.prepare_model(
            "initial",
            actor_id="initial-actor",
            request_id=str(uuid4()),
            service_instance_id=self.activities.instance_id,
        )
        await entered.wait()
        waiting = [asyncio.create_task(send(*target)) for target in targets]
        await asyncio.sleep(0)
        try:
            self.assertEqual(admitted, [])
            self.assertEqual(self.warm.await_count, 1)
            self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
            released.set()
            await asyncio.wait_for(asyncio.gather(*waiting), 1)
        finally:
            released.set()
            await asyncio.gather(*waiting, return_exceptions=True)
        self.assertCountEqual(
            admitted, [(model_id, actor_id, {"turn": 1}) for model_id, actor_id in targets]
        )
        self.assertCountEqual(
            [
                (call.kwargs["model_id"], call.kwargs["user_id"])
                for call in self.warm.await_args_list
            ],
            [("initial", "initial-actor"), *targets],
        )
        self.assertEqual(
            {(call.args[0], call.kwargs["user_id"]) for call in self.selected.call_args_list},
            {("initial", "initial-actor"), *targets},
        )
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.settings.set_runtime_model.assert_not_called()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_cancelled_competing_waiter_does_not_cancel_other_preparation(self):
        initial_entered = asyncio.Event()
        initial_released = asyncio.Event()
        second_entered = asyncio.Event()
        second_released = asyncio.Event()
        admitted = []

        async def warm(*, model_id, **_options):
            if model_id == "initial":
                initial_entered.set()
                await initial_released.wait()
            if model_id == "second":
                second_entered.set()
                await second_released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="host:1"
            )

        async def send(model_id):
            async with self.admission(model_id):
                admitted.append(model_id)

        self.warm.side_effect = warm
        self.service.prepare_model(
            "initial",
            actor_id="actor",
            request_id=str(uuid4()),
            service_instance_id=self.activities.instance_id,
        )
        await initial_entered.wait()
        second = asyncio.create_task(send("second"))
        third = asyncio.create_task(send("third"))
        await asyncio.sleep(0)
        initial_released.set()
        try:
            await asyncio.wait_for(second_entered.wait(), 1)
            self.assertFalse(third.done())
            third.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await third
            self.assertTrue(self.manager.pending)
            self.assertFalse(second.done())
            self.assertEqual(self.activities.snapshot().counts, {"resource": 1})
            second_released.set()
            await asyncio.wait_for(second, 1)
        finally:
            initial_released.set()
            second_released.set()
            await asyncio.gather(second, third, return_exceptions=True)
        self.assertEqual(admitted, ["second"])
        self.assertEqual(self.warm.await_count, 2)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_competing_waiter_rechecks_instance_after_each_preparation(self):
        initial_entered = asyncio.Event()
        initial_released = asyncio.Event()
        second_entered = asyncio.Event()
        second_released = asyncio.Event()
        original_instance = self.activities.instance_id
        admitted = []

        async def warm(*, model_id, **_options):
            if model_id == "initial":
                initial_entered.set()
                await initial_released.wait()
            if model_id == "second":
                second_entered.set()
                await second_released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="host:1"
            )

        async def send(model_id):
            async with self.service.model_admission(
                model_id,
                actor_id="actor",
                domain=ActivityDomain.TURN,
                service_instance_id=original_instance,
            ):
                admitted.append(model_id)

        async def prepare_competitor():
            await self.manager.wait_pending()
            operation = self.service.prepare_model(
                "second",
                actor_id="actor",
                request_id=str(uuid4()),
                service_instance_id=original_instance,
            )
            await self.manager.wait(operation["request_id"], None, "actor")

        self.warm.side_effect = warm
        self.service.prepare_model(
            "initial",
            actor_id="actor",
            request_id=str(uuid4()),
            service_instance_id=original_instance,
        )
        await initial_entered.wait()
        second = asyncio.create_task(prepare_competitor())
        third = asyncio.create_task(send("third"))
        await asyncio.sleep(0)
        initial_released.set()
        try:
            await asyncio.wait_for(second_entered.wait(), 1)
            self.assertFalse(third.done())
            self.activities.instance_id = uuid4().hex
            second_released.set()
            await asyncio.wait_for(second, 1)
            with self.assertRaisesRegex(PreparationError, PREPARATION_INSTANCE_CHANGED):
                await asyncio.wait_for(third, 1)
        finally:
            initial_released.set()
            second_released.set()
            await asyncio.gather(second, third, return_exceptions=True)
        self.assertEqual(admitted, [])
        self.assertEqual(self.warm.await_count, 2)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_competing_waiter_rechecks_actor_model_authorization(self):
        initial_entered = asyncio.Event()
        initial_released = asyncio.Event()
        second_entered = asyncio.Event()
        second_released = asyncio.Event()
        admitted = []
        revoked = False

        def selected(model_id, *, user_id):
            if revoked and (model_id, user_id) == ("third", "actor-b"):
                raise ValueError(RECONFIGURATION_STALE)
            return model_id

        async def warm(*, model_id, **_options):
            if model_id == "initial":
                initial_entered.set()
                await initial_released.wait()
            if model_id == "second":
                second_entered.set()
                await second_released.wait()
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="host:1"
            )

        async def send(model_id, actor_id):
            async with self.service.model_admission(
                model_id,
                actor_id=actor_id,
                domain=ActivityDomain.TURN,
                service_instance_id=self.activities.instance_id,
            ):
                admitted.append((model_id, actor_id))

        self.selected.side_effect = selected
        self.warm.side_effect = warm
        self.service.prepare_model(
            "initial",
            actor_id="actor",
            request_id=str(uuid4()),
            service_instance_id=self.activities.instance_id,
        )
        await initial_entered.wait()
        second = asyncio.create_task(send("second", "actor-a"))
        third = asyncio.create_task(send("third", "actor-b"))
        await asyncio.sleep(0)
        initial_released.set()
        try:
            await asyncio.wait_for(second_entered.wait(), 1)
            self.assertFalse(third.done())
            revoked = True
            second_released.set()
            await asyncio.wait_for(second, 1)
            with self.assertRaisesRegex(PreparationError, PREPARATION_INVALID):
                await asyncio.wait_for(third, 1)
        finally:
            initial_released.set()
            second_released.set()
            await asyncio.gather(second, third, return_exceptions=True)
        self.assertEqual(admitted, [("second", "actor-a")])
        self.selected.assert_any_call("third", user_id="actor-b")
        self.assertEqual(self.warm.await_count, 2)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_rejected_busy_receipt_is_not_retried(self):
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND, CommandState.REJECTED, safe_error=RESOURCE_HOST_BUSY
        )
        with self.assertRaisesRegex(PreparationError, RESOURCE_HOST_BUSY):
            async with self.admission():
                self.fail("rejected preparation admitted")
        self.warm.assert_awaited_once()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_uncertain_receipt_is_not_retried_or_reopened(self):
        self.warm.return_value = CommandReceipt(
            RUNTIME_HOST_WARMUP_COMMAND,
            CommandState.RESTART_REQUIRED,
            safe_error=RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
        )
        with self.assertRaisesRegex(PreparationError, RESOURCE_HOST_CONFIGURATION_UNCERTAIN):
            async with self.admission():
                self.fail("uncertain preparation admitted")
        self.warm.assert_awaited_once()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.DRAINING)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_busy_without_pending_operation_is_terminal(self):
        async def send():
            async with self.admission():
                self.fail("busy preparation admitted")

        with patch.object(
            self.service, "prepare_model", side_effect=ValueError(RESOURCE_HOST_BUSY)
        ) as prepare:
            with self.assertRaisesRegex(PreparationError, RESOURCE_HOST_BUSY):
                await asyncio.wait_for(send(), 1)
        prepare.assert_called_once()
        self.warm.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_busy_error_from_admitted_body_is_not_retried(self):
        admitted = []
        with self.assertRaisesRegex(ValueError, RESOURCE_HOST_BUSY) as failure:
            async with self.admission():
                admitted.append("once")
                raise ValueError(RESOURCE_HOST_BUSY)
        self.assertIs(type(failure.exception), ValueError)
        self.assertEqual(admitted, ["once"])
        self.warm.assert_awaited_once()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_catalog_rejection_keeps_other_actor_and_new_retry_available(self):
        self.warm.side_effect = [
            CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND,
                CommandState.REJECTED,
                safe_error=MODEL_CATALOG_UNAVAILABLE,
            ),
            CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="other-host:1"
            ),
            CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="retry-host:1"
            ),
        ]
        with self.assertRaisesRegex(PreparationError, MODEL_CATALOG_UNAVAILABLE):
            async with self.admission():
                self.fail("failed directory preparation admitted")
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        admitted = []
        async with self.service.model_admission(
            "other-model",
            actor_id="other-actor",
            domain=ActivityDomain.TURN,
            service_instance_id=self.activities.instance_id,
        ):
            admitted.append(("other-actor", dict(self.activities.snapshot().counts)))
        async with self.admission():
            admitted.append(("actor", dict(self.activities.snapshot().counts)))
        self.assertEqual(admitted, [("other-actor", {"turn": 1}), ("actor", {"turn": 1})])
        self.assertEqual(self.warm.await_count, 3)
        self.assertEqual(
            [call.kwargs["user_id"] for call in self.warm.await_args_list],
            ["actor", "other-actor", "actor"],
        )
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.settings.set_runtime_model.assert_not_called()
        self.assertIs(self.activities.snapshot().phase, ActivityPhase.OPEN)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_exception_from_admitted_body_is_never_preparation_retry(self):
        admitted = []
        with self.assertRaises(MaintenanceActive):
            async with self.admission():
                admitted.append("once")
                raise MaintenanceActive("body failed after admission")
        self.assertEqual(admitted, ["once"])
        self.warm.assert_awaited_once()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_wrong_instance_has_no_validation_commit_or_warm_side_effect(self):
        with self.assertRaisesRegex(ValueError, PREPARATION_INSTANCE_CHANGED):
            self.service.prepare_model(
                "target",
                actor_id="actor",
                request_id=str(uuid4()),
                service_instance_id="another-instance",
                persist_default=True,
            )
        self.selected.assert_not_called()
        self.settings.set_runtime_model.assert_not_called()
        self.warm.assert_not_awaited()
        self.assertIsNone(self.manager.state)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_turn_metering_alignment_and_body_are_protected_by_turn_lease(self):
        observed = []

        async def align(session_id, actor_id):
            self.assertEqual((session_id, actor_id), ("session", "actor"))
            observed.append(self.activities.snapshot().counts)
            await asyncio.sleep(0)

        self.service.align_metering_identity.side_effect = align
        async with self.service.turn_admission(
            "session",
            self.principal,
            actor_id="actor",
            model_id="target",
            service_instance_id=self.activities.instance_id,
        ):
            observed.append(self.activities.snapshot().counts)
        self.assertEqual(observed, [{"turn": 1}, {"turn": 1}])
        self.assertEqual(self.service._access.require.call_count, 2)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_archived_turn_rejects_before_host_preparation(self):
        self.record.archived = True
        with self.assertRaisesRegex(PreparationError, SESSION_ARCHIVED_ERROR):
            async with self.service.turn_admission(
                "session",
                self.principal,
                actor_id="actor",
                model_id="target",
                service_instance_id=self.activities.instance_id,
            ):
                self.fail("archived task admitted")
        self.warm.assert_not_awaited()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.service.align_metering_identity.assert_not_awaited()
        self.assertIsNone(self.manager.state)
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_archiving_during_preparation_rejects_before_alignment_and_body(self):
        async def warm(**_options):
            self.record.archived = True
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        self.warm.side_effect = warm
        with self.assertRaisesRegex(PreparationError, SESSION_ARCHIVED_ERROR):
            async with self.service.turn_admission(
                "session",
                self.principal,
                actor_id="actor",
                model_id="target",
                service_instance_id=self.activities.instance_id,
            ):
                self.fail("task archived while waiting admitted")
        self.warm.assert_awaited_once()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.service.align_metering_identity.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_archived_turn_http_rejects_without_preparing_or_submitting(self):
        self.record.archived = True
        application = FastAPI()
        turns = SimpleNamespace(post=AsyncMock())
        mount_session_routes(
            application,
            sessions=self.service,
            turns=turns,
            events=Mock(),
            artifacts=Mock(),
            credentials=Mock(),
        )
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://contract.test"
        ) as client:
            response = await client.post(
                "/api/serve/sessions/session/turns",
                json={
                    "expected_model_id": "target",
                    "service_instance_id": self.activities.instance_id,
                    "input": [],
                },
            )
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], SESSION_ARCHIVED_ERROR)
        self.warm.assert_not_awaited()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        turns.post.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_stale_session_model_is_rejected_before_metering_or_body(self):
        self.service.model.return_value = {"model_id": "changed"}
        with self.assertRaisesRegex(PreparationError, RECONFIGURATION_STALE):
            async with self.service.turn_admission(
                "session",
                self.principal,
                actor_id="actor",
                model_id="target",
                service_instance_id=self.activities.instance_id,
            ):
                self.fail("stale model admitted")
        self.service.align_metering_identity.assert_not_awaited()
        self.warm.assert_not_awaited()
        self.drain.assert_not_awaited()
        self.apply.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_model_changed_during_preparation_rejects_before_alignment(self):
        async def warm(**_options):
            self.service.model.return_value = {"model_id": "changed"}
            return CommandReceipt(
                RUNTIME_HOST_WARMUP_COMMAND, CommandState.APPLIED, correlation_id="warm-host:1"
            )

        self.warm.side_effect = warm
        with self.assertRaisesRegex(PreparationError, RECONFIGURATION_STALE):
            async with self.service.turn_admission(
                "session",
                self.principal,
                actor_id="actor",
                model_id="target",
                service_instance_id=self.activities.instance_id,
            ):
                self.fail("changed model admitted")
        self.warm.assert_awaited_once()
        self.service.align_metering_identity.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_missing_session_rejects_before_readonly_model_or_preparation(self):
        self.service._access.require.side_effect = SessionAccessError("session not found")
        with self.assertRaises(SessionAccessError):
            async with self.service.turn_admission(
                "session",
                self.principal,
                actor_id="actor",
                model_id="target",
                service_instance_id=self.activities.instance_id,
            ):
                self.fail("missing session admitted")
        self.service._access.get.assert_not_called()
        self.service.model.assert_not_called()
        self.warm.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_maintenance_turn_is_not_reported_as_archived(self):
        generation = self.activities.begin()
        try:
            with self.assertRaisesRegex(PreparationError, RESOURCE_HOST_CONFIGURATION_UNCERTAIN):
                async with self.service.turn_admission(
                    "session",
                    self.principal,
                    actor_id="actor",
                    model_id="target",
                    service_instance_id=self.activities.instance_id,
                ):
                    self.fail("maintenance turn admitted")
            self.warm.assert_not_awaited()
            self.service.align_metering_identity.assert_not_awaited()
        finally:
            self.activities.resume(generation, expected_phase=ActivityPhase.DRAINING)

    async def test_closed_manager_returns_terminal_preparation_error_without_spinning(self):
        await self.manager.aclose()

        async def send():
            async with self.admission():
                self.fail("closed runtime admitted")

        with self.assertRaisesRegex(PreparationError, PREPARATION_CLOSED):
            await asyncio.wait_for(send(), 1)
        self.warm.assert_not_awaited()
        self.assertEqual(self.activities.snapshot().counts, {})


class AutomaticReconfigurationContracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.service = object.__new__(SessionService)
        self.service._runtime = SimpleNamespace(reconfiguration_supported=True)
        self.service._access = Mock()
        self.service._access.get.return_value = SimpleNamespace(principal_id="stored-owner")
        self.service._logger = Mock()
        self.service.model = Mock(return_value={"model_id": "persisted-target"})
        self.service._reconfigure_host = Mock()
        self.live = SimpleNamespace(id="session", user_id="actor", model_id="old-model")

    async def test_conflict_schedules_without_awaiting_the_triggering_business(self):
        activities = Activities()
        apply = AsyncMock(
            return_value=CommandReceipt(
                RUNTIME_HOST_RECONFIGURATION_COMMAND,
                CommandState.APPLIED,
                correlation_id="target:1",
            )
        )
        manager = HostReconfiguration(
            activities=activities,
            drain=AsyncMock(return_value=()),
            logger=logging.getLogger(__name__),
        )

        def schedule(session_id, principal, *, actor_id, request_id, model_id):
            self.assertEqual(principal.user_id, "stored-owner")
            self.assertEqual(actor_id, "actor")
            self.assertEqual(model_id, "persisted-target")
            return manager.start(
                request_id=request_id,
                session_id=session_id,
                user_id=actor_id,
                model_id=model_id,
                wait_seconds=1,
                validate=lambda: None,
                apply=lambda owner: apply(),
            )

        self.service._reconfigure_host.side_effect = schedule
        error = SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.service._prepare_turn = AsyncMock(side_effect=error)
        business = activities.enter(ActivityDomain.TURN, root=True)
        try:
            with self.assertRaises(SessionActivationError) as caught:
                await self.service.prepare_turn(self.live)
            self.assertIs(caught.exception, error)
            await asyncio.sleep(0)
            apply.assert_not_awaited()
            self.assertIs(activities.snapshot().phase, ActivityPhase.DRAINING)
        finally:
            business.close()
            await manager.aclose()
        apply.assert_awaited_once()
        self.assertIs(activities.snapshot().phase, ActivityPhase.OPEN)

    async def test_unknown_or_unrelated_failures_never_schedule_or_replay(self):
        for code in (
            "turn_outcome_unknown",
            "runtime_session_open_unknown",
            "credential_unavailable",
        ):
            with self.subTest(code=code):
                error = SessionActivationError(code)
                self.service._prepare_turn = AsyncMock(side_effect=error)
                with self.assertRaises(SessionActivationError):
                    await self.service.prepare_turn(self.live)
                self.service._prepare_turn.assert_awaited_once()
        self.service._reconfigure_host.assert_not_called()

    async def test_busy_scheduler_keeps_the_original_failure_and_does_not_replay(self):
        error = SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.service._prepare_turn = AsyncMock(side_effect=error)
        self.service._reconfigure_host.side_effect = ValueError("runtime_host_busy")
        with self.assertRaises(SessionActivationError) as caught:
            await self.service.prepare_turn(self.live)
        self.assertIs(caught.exception, error)
        self.service._reconfigure_host.assert_called_once()
        self.service._logger.warning.assert_called_once()
        self.service._prepare_turn.assert_awaited_once()

    async def test_unsupported_runtime_preserves_conflict_without_attempting_switch(self):
        self.service._runtime.reconfiguration_supported = False
        self.service._prepare_turn = AsyncMock(
            side_effect=SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        )
        with self.assertRaises(SessionActivationError):
            await self.service.prepare_turn(self.live)
        self.service._reconfigure_host.assert_not_called()

    async def test_permission_or_storage_failures_do_not_replace_the_original_conflict(self):
        error = SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.service._prepare_turn = AsyncMock(side_effect=error)
        for scheduling_error in (PermissionError("access revoked"), OSError("storage unavailable")):
            with self.subTest(failure_type=type(scheduling_error).__name__):
                self.service._reconfigure_host.side_effect = scheduling_error
                with self.assertRaises(SessionActivationError) as caught:
                    await self.service.prepare_turn(self.live)
                self.assertIs(caught.exception, error)
        self.service._access.get.side_effect = OSError("record unavailable")
        with self.assertRaises(SessionActivationError) as caught:
            await self.service.prepare_turn(self.live)
        self.assertIs(caught.exception, error)

    async def test_capability_lookup_failure_does_not_replace_the_original_conflict(self):
        class BrokenRuntime:
            @property
            def reconfiguration_supported(self):
                raise OSError("capability unavailable")

        error = SessionActivationError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.service._runtime = BrokenRuntime()
        self.service._prepare_turn = AsyncMock(side_effect=error)
        with self.assertRaises(SessionActivationError) as caught:
            await self.service.prepare_turn(self.live)
        self.assertIs(caught.exception, error)
        self.service._reconfigure_host.assert_not_called()


if __name__ == "__main__":
    unittest.main()
