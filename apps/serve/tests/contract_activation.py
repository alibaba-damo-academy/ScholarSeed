"""Deterministic admission contracts; fixtures do not constitute product acceptance."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_runtime.contract import (
    CapabilitySet,
    CommandState,
    OpenSessionRequest,
    RuntimeBinding,
)
from scholarseed_runtime.contract.provider import RuntimeOpenNotAppliedError
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_WAIT_TIMEOUT,
    ResourcePolicy,
    ResourcePurpose,
    ResourceReceipt,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.sandbox import SANDBOX_STARTUP_ERRORS
from scholarseed_runtime.contract.session import RuntimeActivitySnapshot
from service.chat.persistence.catalog import OpenState, SessionCatalogStore, SessionPrincipal
from service.chat.runtime.activation import (
    RESOURCE_RESERVATION_INVALID,
    RESOURCE_WAIT_BLOCKED,
    SESSION_ACTIVATION_CLOSED,
    SESSION_OPEN_UNKNOWN,
    ActivationPlan,
    SessionActivation,
    SessionActivationError,
)
from service.chat.runtime.composition import LiveSessionService, RuntimeOpening
from service.chat.runtime.timing import ActivationStage, ActivationTiming, TimingStatus
from service.chat.service.completions import CompletionBridge
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.platform.activity import Activities, ActivityDomain
from service.settings.connections import ModelProfileStore, personal_model_key
from service.settings.credentials import CredentialState

RUNTIME_ID = "codex"
TEST_DEADLINE = 2_000_000_000.0
TEST_TIMEOUT = 2.0


class AdmissionFixture:
    """A controlled SPI fixture for races, with no subprocess or model execution."""

    def __init__(self, *, waiting: bool = False) -> None:
        self.descriptor = SimpleNamespace(runtime_id=RUNTIME_ID)
        self.resource_policy = ResourcePolicy(30.0, 0.0)
        self.waiting = waiting
        self.entered = asyncio.Event()
        self.grant = asyncio.Event()
        self.requests: list[ResourceRequest] = []
        self.cancelled: list[str] = []

    async def reserve(self, request: ResourceRequest) -> ResourceReceipt:
        self.requests.append(request)
        state = ResourceState.WAITING if self.waiting else ResourceState.GRANTED
        return ResourceReceipt(
            request.request_id, str(len(self.requests)), state, deadline=TEST_DEADLINE
        )

    async def wait_resource(self, reservation_id: str) -> ResourceReceipt:
        self.entered.set()
        await self.grant.wait()
        self.waiting = False
        return ResourceReceipt(
            self.requests[-1].request_id,
            reservation_id,
            ResourceState.GRANTED,
            deadline=TEST_DEADLINE,
        )

    async def cancel_resource(self, reservation_id: str) -> ResourceReceipt:
        self.cancelled.append(reservation_id)
        return ResourceReceipt("request", reservation_id, ResourceState.CANCELLED)


class AttachmentFixture:
    def __init__(self, *, idle: bool = True) -> None:
        self.idle = idle

    async def activity(self) -> RuntimeActivitySnapshot:
        return RuntimeActivitySnapshot(
            "generation", 1, 0, self.idle, execution_tree_complete=self.idle
        )


class ProductFixture:
    def __init__(self, session_id: str = "product") -> None:
        self.id = session_id
        self.runtime_id = RUNTIME_ID
        self.project_id = "target-project"
        self.project_path = Path("/target-project")
        self.runtime_workdir = self.project_path
        self.output_root = self.project_path
        self.writable_roots = (Path("/linked-source"),)
        self.attachment_activity = None
        self.lifecycle_lock = asyncio.Lock()
        self.activation_lock = asyncio.Lock()
        self.runtime_session = None
        self.runtime_binding = None
        self.replacement_proof = None
        self.waiting_request_id = ""
        self.runtime_driver = None
        self.running = False
        self.waiting_resources = False
        self.terminated = False
        self.terminating = False
        self.termination_task = None
        self.revision = 0
        self.token_rotations = 0
        self.suspensions = 0
        self._active = False
        self.attachment_generation = 0
        self.measurements = []
        self.suspend_blockers: tuple[str, ...] = ()
        self.subscribers = []

    def activation_timing(self, request_id: str) -> ActivationTiming:
        return ActivationTiming(request_id, self.measurements.append)

    def prepare_runtime_attachment(self) -> None:
        self.token_rotations += 1

    def trace_resource(self, *_args: object) -> None:
        return None

    async def suspend_runtime(self, *, require_unsubscribed: bool = False) -> bool:
        async with self.lifecycle_lock:
            if require_unsubscribed and self.subscribers:
                return False
            if self.suspend_blockers:
                return False
            if self.runtime_session is None or not (await self.runtime_session.activity()).idle:
                return False
            self.suspensions += 1
            self.runtime_session = None
            return True

    def attach_gateway(self, session: object, *, resumed: bool, activities: Activities) -> object:
        self.runtime_session = session
        self.runtime_binding = session.binding
        return SimpleNamespace(start=lambda: None)

    async def hydrate_runtime_history(self) -> None:
        return None

    async def reconcile_resumed_turns(self) -> None:
        return None


class ModelCatalogFixture(ModelService):
    @staticmethod
    def _config() -> dict[str, object]:
        return {}


class ActivationContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.provider = AdmissionFixture()
        self.live = ProductFixture()
        self.attached: list[tuple[object, ...]] = []
        self.discarded: list[str] = []

        async def prepare(_live: ProductFixture, _timing: object) -> None:
            return None

        async def attach(live: ProductFixture, plan: ActivationPlan, _reservation: str) -> None:
            self.attached.append(plan.revision)
            live.runtime_session = AttachmentFixture()

        self.activities = Activities()
        self.activation = SessionActivation(
            activities=self.activities,
            build=lambda live: ActivationPlan(
                self.provider,
                OpenSessionRequest(live.id, Path("/workspace")),
                (live.revision,),
            ),
            revision=lambda live: (live.revision,),
            attach=attach,
            provider=lambda _runtime_id: self.provider,
            prepare=prepare,
            discard=lambda live: self.discarded.append(live.id),
            logger=logging.getLogger(__name__),
        )
        self.activation.bind_sessions({self.live.id: self.live})

    async def asyncTearDown(self) -> None:
        await self.activation.aclose()

    async def test_directory_release_does_not_touch_unrelated_running_session(self) -> None:
        self.assertTrue(callable(getattr(self.activation, "release_directory_attachments", None)))
        self.live.running = True
        blocked = await self.activation.release_directory_attachments(
            "another-project", Path("/another-source")
        )
        self.assertEqual(blocked, ())
        self.assertEqual(self.live.suspensions, 0)

    async def test_directory_release_rejects_target_running_session(self) -> None:
        self.live.running = True
        blocked = await self.activation.release_directory_attachments(
            self.live.project_id, Path("/another-source")
        )
        self.assertEqual(blocked, (self.live.id,))
        self.assertEqual(self.live.suspensions, 0)

    async def test_directory_release_detects_shared_source_in_another_project(self) -> None:
        self.live.running = True
        blocked = await self.activation.release_directory_attachments(
            "another-project", Path("/linked-source/child")
        )
        self.assertEqual(blocked, (self.live.id,))

    async def test_directory_release_suspends_only_idle_matching_attachment(self) -> None:
        self.live.runtime_session = AttachmentFixture()
        blocked = await self.activation.release_directory_attachments(
            self.live.project_id, Path("/linked-source")
        )
        self.assertEqual(blocked, ())
        self.assertIsNone(self.live.runtime_session)
        self.assertEqual(self.live.suspensions, 1)

    async def test_directory_release_retains_unknown_native_execution(self) -> None:
        self.live.runtime_session = AttachmentFixture(idle=False)
        blocked = await self.activation.release_directory_attachments(
            self.live.project_id, Path("/linked-source")
        )
        self.assertEqual(blocked, (self.live.id,))
        self.assertIsNotNone(self.live.runtime_session)

    async def test_directory_release_rechecks_sessions_created_during_suspend(self) -> None:
        self.live.runtime_session = AttachmentFixture()
        newcomer = ProductFixture("newcomer")
        newcomer.running = True
        sessions = {self.live.id: self.live}
        self.activation.bind_sessions(sessions)
        suspend = self.live.suspend_runtime

        async def suspend_and_open() -> bool:
            released = await suspend()
            sessions[newcomer.id] = newcomer
            return released

        self.live.suspend_runtime = suspend_and_open
        blocked = await self.activation.release_directory_attachments(
            self.live.project_id, Path("/linked-source")
        )
        self.assertEqual(blocked, (newcomer.id,))

    async def test_directory_release_rejects_related_oneshot_and_uncertain_opening(self) -> None:
        service = object.__new__(LiveSessionService)
        service.activation = self.activation
        service._uncertain_attachments = {}
        service._one_shot_directories = {"related-invocation": (Path("/linked-source/child"),)}
        self.assertEqual(
            await service.release_directory_attachments(
                "another-project", Path("/linked-source"), Path("/another-project")
            ),
            ("related-invocation",),
        )
        service._one_shot_directories = {"unrelated-invocation": (Path("/elsewhere"),)}
        self.assertEqual(
            await service.release_directory_attachments(
                "another-project", Path("/linked-source"), Path("/another-project")
            ),
            (),
        )
        lease = self.activities.enter(ActivityDomain.RUNTIME)
        service._uncertain_attachments = {
            "opening": RuntimeOpening(
                RUNTIME_ID,
                "unknown-session",
                lease,
                project_id="another-project",
                directories=(Path("/another-project"),),
            )
        }
        try:
            self.assertEqual(
                await service.release_directory_attachments(
                    "another-project", Path("/linked-source"), Path("/another-project")
                ),
                ("unknown-session",),
            )
        finally:
            lease.close()

    async def test_turn_refresh_releases_dormant_attachment_before_admission(self) -> None:
        self.provider.resource_policy = ResourcePolicy(30.0, 0.0, refresh_before_turn=True)
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        await self.activation.ensure_active(self.live, purpose=ResourcePurpose.TURN)
        self.assertEqual(self.live.suspensions, 1)
        self.assertIsNot(self.live.runtime_session, previous)
        self.assertEqual(len(self.provider.requests), 1)
        self.assertIs(self.provider.requests[0].purpose, ResourcePurpose.TURN)

    async def test_host_conflict_is_explicit_and_does_not_reclaim_existing_sessions(self) -> None:
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        self.provider.reserve = AsyncMock(
            return_value=ResourceReceipt(
                "conflict",
                "rejected",
                ResourceState.REJECTED,
                safe_error=RESOURCE_HOST_CONFIGURATION_CONFLICT,
            )
        )
        self.activation._reclaim = AsyncMock()
        with self.assertRaises(SessionActivationError) as caught:
            await self.activation.acquire(
                self.provider,
                ResourceRequest(
                    "conflict",
                    ResourcePurpose.SESSION,
                    TEST_DEADLINE,
                    OpenSessionRequest("other", Path("/other")),
                ),
            )
        self.assertEqual(caught.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertIs(self.live.runtime_session, previous)
        self.activation._reclaim.assert_not_awaited()
        self.assertEqual(self.provider.cancelled, ["rejected"])

    async def test_sandbox_rejection_preserves_safe_code_and_releases_reservation(self) -> None:
        for waiting in (False, True):
            for code in sorted(SANDBOX_STARTUP_ERRORS):
                with self.subTest(waiting=waiting, code=code):
                    provider = AdmissionFixture()
                    rejected = ResourceReceipt(
                        "sandbox-request",
                        "sandbox-reservation",
                        ResourceState.REJECTED,
                        safe_error=code,
                    )
                    provider.reserve = AsyncMock(
                        return_value=(
                            ResourceReceipt(
                                "sandbox-request",
                                "sandbox-reservation",
                                ResourceState.WAITING,
                                deadline=TEST_DEADLINE,
                            )
                            if waiting
                            else rejected
                        )
                    )
                    provider.wait_resource = AsyncMock(return_value=rejected)
                    self.activation._reclaim = AsyncMock()
                    with self.assertRaises(SessionActivationError) as caught:
                        await self.activation.acquire(
                            provider,
                            ResourceRequest(
                                "sandbox-request",
                                ResourcePurpose.TURN,
                                TEST_DEADLINE,
                                OpenSessionRequest("session", Path("/workspace")),
                            ),
                        )
                    self.assertEqual(caught.exception.safe_error, code)
                    self.assertEqual(provider.reserve.await_count, 1)
                    self.assertEqual(provider.wait_resource.await_count, int(waiting))
                    self.assertEqual(provider.cancelled, ["sandbox-reservation"])

    async def test_turn_refresh_policy_does_not_refresh_session_inspection(self) -> None:
        self.provider.resource_policy = ResourcePolicy(30.0, 0.0, refresh_before_turn=True)
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        await self.activation.ensure_active(self.live, purpose=ResourcePurpose.SESSION)
        self.assertIs(self.live.runtime_session, previous)
        self.assertEqual(self.live.suspensions, 0)
        self.assertEqual(self.provider.requests, [])

    async def test_default_turn_policy_preserves_attachment(self) -> None:
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        await self.activation.ensure_active(self.live, purpose=ResourcePurpose.TURN)
        self.assertIs(self.live.runtime_session, previous)
        self.assertEqual(self.live.suspensions, 0)

    async def test_turn_refresh_never_restarts_running_attachment(self) -> None:
        self.provider.resource_policy = ResourcePolicy(30.0, 0.0, refresh_before_turn=True)
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        self.live.running = True
        await self.activation.ensure_active(self.live, purpose=ResourcePurpose.TURN)
        self.assertIs(self.live.runtime_session, previous)
        self.assertEqual(self.live.suspensions, 0)

    async def test_turn_refresh_blocker_does_not_fall_back_to_old_attachment(self) -> None:
        self.provider.resource_policy = ResourcePolicy(30.0, 0.0, refresh_before_turn=True)
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        self.live.suspend_blockers = ("pending_hil",)
        with self.assertRaises(SessionActivationError):
            await self.activation.ensure_active(self.live, purpose=ResourcePurpose.TURN)
        self.assertIs(self.live.runtime_session, previous)
        self.assertEqual(self.provider.requests, [])

    async def test_cancelled_turn_refresh_does_not_admit_new_execution(self) -> None:
        self.provider.resource_policy = ResourcePolicy(30.0, 0.0, refresh_before_turn=True)
        previous = AttachmentFixture()
        self.live.runtime_session = previous
        with patch.object(
            self.activation, "wait_until_suspended", side_effect=asyncio.CancelledError
        ):
            with self.assertRaises(asyncio.CancelledError):
                await self.activation.ensure_active(self.live, purpose=ResourcePurpose.TURN)
        self.assertIs(self.live.runtime_session, previous)
        self.assertEqual(self.provider.requests, [])

    async def test_reclaim_cancellation_waits_for_native_suspend_cleanup(self) -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        self.live.runtime_session = AttachmentFixture()

        async def suspend(*, require_unsubscribed=False):
            entered.set()
            await release.wait()
            self.live.runtime_session = None
            return True

        self.live.suspend_runtime = suspend
        task = asyncio.create_task(self.activation._reclaim(RUNTIME_ID, pressure=True))
        try:
            await asyncio.wait_for(entered.wait(), TEST_TIMEOUT)
            generation = self.activities.begin()
            for _ in range(2):
                task.cancel()
                await asyncio.sleep(0.01)
                self.assertFalse(task.done())
                self.assertFalse(self.activities.seal(generation))
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
        self.assertIsNone(self.live.runtime_session)
        self.assertTrue(self.activities.seal(generation))

    async def test_periodic_reclaim_defers_native_queries_until_maintenance_resumes(self) -> None:
        queried = asyncio.Event()
        self.live.runtime_session = AttachmentFixture(idle=False)

        async def activity():
            queried.set()
            return RuntimeActivitySnapshot("generation", 1, 0, False)

        self.live.runtime_session.activity = AsyncMock(side_effect=activity)
        generation = self.activities.begin()
        with patch("service.chat.runtime.activation.RESOURCE_SWEEP_INTERVAL_SECONDS", 0.01):
            await self.activation.start()
            await asyncio.sleep(0.05)
            self.live.runtime_session.activity.assert_not_awaited()
            self.assertTrue(self.activities.seal(generation))
            self.activities.resume(generation)
            await asyncio.wait_for(queried.wait(), TEST_TIMEOUT)
            await self.activation.aclose()
        self.assertEqual(self.activities.snapshot().counts, {})

    async def test_activation_spans_share_request_and_hot_path_does_not_fake_stages(self) -> None:
        await self.activation.ensure_active(self.live, request_id="cold-request")
        samples = self.live.measurements
        root = next(sample for sample in samples if sample.stage == ActivationStage.TOTAL)
        stages = {sample.stage for sample in samples}
        expected_stages = {
            ActivationStage.TOTAL,
            ActivationStage.LOCK_WAIT,
            ActivationStage.LIFECYCLE_LOCK_WAIT,
            ActivationStage.SKILLS,
            ActivationStage.PLAN,
            ActivationStage.ADMISSION,
            ActivationStage.ATTACH,
        }
        self.assertEqual(stages, expected_stages)
        self.assertTrue(all(sample.request_id == "cold-request" for sample in samples))
        self.assertTrue(all(sample.activation_id == root.activation_id for sample in samples))
        self.assertTrue(all(sample.status is TimingStatus.OK for sample in samples))
        self.assertTrue(
            all(sample.parent_span_id == root.span_id for sample in samples if sample is not root)
        )
        self.assertIsNotNone(self.provider.requests[0].session_request.timing)
        self.live.measurements.clear()
        await self.activation.ensure_active(self.live, request_id="hot-request")
        self.assertEqual(
            {sample.stage for sample in self.live.measurements},
            {ActivationStage.TOTAL, ActivationStage.LOCK_WAIT, ActivationStage.LIFECYCLE_LOCK_WAIT},
        )
        self.assertTrue(
            all(sample.activation_id != root.activation_id for sample in self.live.measurements)
        )

    async def test_cancelled_lock_wait_records_cancellation_without_releasing_owner(self) -> None:
        await self.live.activation_lock.acquire()
        waiter = asyncio.create_task(
            self.activation.ensure_active(self.live, request_id="cancel-lock")
        )
        await asyncio.sleep(0)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertTrue(self.live.activation_lock.locked())
        self.live.activation_lock.release()
        self.assertEqual(
            {sample.stage for sample in self.live.measurements},
            {ActivationStage.TOTAL, ActivationStage.LOCK_WAIT},
        )
        self.assertTrue(
            all(sample.status is TimingStatus.CANCELLED for sample in self.live.measurements)
        )

    async def test_failed_preparation_preserves_exception_and_records_phase(self) -> None:
        failure = ValueError("private-credential-material")
        self.activation._prepare = AsyncMock(side_effect=failure)
        with self.assertRaises(ValueError) as caught:
            await self.activation.ensure_active(self.live, request_id="failed-prepare")
        self.assertIs(caught.exception, failure)
        self.assertFalse(self.live.activation_lock.locked())
        skills = next(
            sample for sample in self.live.measurements if sample.stage == ActivationStage.SKILLS
        )
        self.assertEqual(skills.failure_type, "ValueError")
        self.assertIs(skills.status, TimingStatus.ERROR)
        self.assertNotIn(str(failure), repr(self.live.measurements))

    async def test_wait_is_unlocked_cancellable_and_uses_provider_deadline(self) -> None:
        self.provider.waiting = True
        deadlines: list[float] = []

        async def waiting(_receipt: ResourceReceipt, deadline: float) -> None:
            self.assertFalse(self.live.lifecycle_lock.locked())
            deadlines.append(deadline)

        task = asyncio.create_task(self.activation.ensure_active(self.live, on_wait=waiting))
        await asyncio.wait_for(self.provider.entered.wait(), TEST_TIMEOUT)
        async with self.live.lifecycle_lock:
            self.assertTrue(self.live.waiting_resources)
        self.assertTrue(await self.activation.cancel(self.live.id))
        self.assertTrue(task.cancelled())
        self.assertEqual(self.provider.cancelled, ["1"])
        self.assertEqual(deadlines, [TEST_DEADLINE])
        self.assertEqual(self.discarded, [self.live.id])
        self.assertFalse(self.live.waiting_resources)
        self.assertEqual(self.attached, [])

    async def test_concurrent_admission_attaches_only_once(self) -> None:
        await asyncio.gather(
            self.activation.ensure_active(self.live), self.activation.ensure_active(self.live)
        )
        self.assertEqual(len(self.provider.requests), 1)
        self.assertEqual(self.attached, [(0,)])
        self.assertEqual(self.live.token_rotations, 1)

    async def test_quiescence_wait_retries_until_safe_suspend(self) -> None:
        attachment = AttachmentFixture(idle=False)
        self.live.runtime_session = attachment

        async def release_background_activity(_delay: float) -> None:
            attachment.idle = True

        with patch(
            "service.chat.runtime.activation.asyncio.sleep",
            new=AsyncMock(side_effect=release_background_activity),
        ) as sleep:
            await self.activation.wait_until_suspended(self.live)
        sleep.assert_awaited_once()
        self.assertEqual(self.live.suspensions, 1)
        self.assertIsNone(self.live.runtime_session)

    async def test_quiescence_wait_reports_resource_timeout(self) -> None:
        self.live.runtime_session = AttachmentFixture(idle=False)
        with patch("service.chat.runtime.activation.time.time", return_value=2.0):
            with self.assertRaises(SessionActivationError) as caught:
                await self.activation.wait_until_suspended(self.live, deadline=1.0)
        self.assertEqual(caught.exception.safe_error, RESOURCE_WAIT_TIMEOUT)

    async def test_quiescence_wait_fails_fast_when_runtime_reports_blockers(self) -> None:
        self.live.runtime_session = AttachmentFixture(idle=False)
        self.live.suspend_blockers = ("native_background_terminal_active",)
        with self.assertRaises(SessionActivationError) as caught:
            await self.activation.wait_until_suspended(self.live)
        self.assertEqual(caught.exception.safe_error, RESOURCE_WAIT_BLOCKED)

    async def test_termination_owner_can_restore_binding_without_reopening_other_admission(
        self,
    ) -> None:
        self.live.terminating = True
        self.live.termination_task = asyncio.current_task()
        other = asyncio.create_task(self.activation.ensure_active(self.live))
        with self.assertRaises(SessionActivationError) as rejected:
            await other
        self.assertEqual(rejected.exception.safe_error, SESSION_ACTIVATION_CLOSED)
        self.assertEqual(self.provider.requests, [])
        await self.activation.ensure_active(self.live)
        self.assertEqual(len(self.provider.requests), 1)
        self.assertEqual(self.attached, [(0,)])
        self.live.terminated = True
        with self.assertRaises(SessionActivationError) as closed:
            await self.activation.ensure_active(self.live)
        self.assertEqual(closed.exception.safe_error, SESSION_ACTIVATION_CLOSED)

    async def test_changed_intent_cancels_old_grant_before_attaching(self) -> None:
        self.provider.waiting = True
        task = asyncio.create_task(self.activation.ensure_active(self.live, request_id="durable"))
        await asyncio.wait_for(self.provider.entered.wait(), TEST_TIMEOUT)
        async with self.live.lifecycle_lock:
            self.live.revision += 1
        self.provider.grant.set()
        await asyncio.wait_for(task, TEST_TIMEOUT)
        self.assertEqual(self.attached, [(1,)])
        self.assertEqual(len(self.provider.requests), 2)
        self.assertNotEqual(
            self.provider.requests[0].request_id, self.provider.requests[1].request_id
        )
        self.assertEqual(self.provider.cancelled, ["1", "2"])
        self.assertEqual(self.live.token_rotations, 2)

    async def test_reclamation_requires_idle_evidence_and_operation_lease(self) -> None:
        idle = ProductFixture("idle")
        busy = ProductFixture("busy")
        idle.runtime_session = AttachmentFixture()
        busy.runtime_session = AttachmentFixture(idle=False)
        self.activation.bind_sessions({idle.id: idle, busy.id: busy})
        async with idle.lifecycle_lock:
            await self.activation._reclaim(RUNTIME_ID, pressure=True)
            self.assertEqual(idle.suspensions, 0)
        await self.activation._reclaim(RUNTIME_ID, pressure=True)
        self.assertEqual(idle.suspensions, 1)
        self.assertEqual(busy.suspensions, 0)

    async def test_subscribed_attachment_is_not_automatically_reclaimed(self) -> None:
        self.live.runtime_session = AttachmentFixture()
        self.live.subscribers.append(asyncio.Queue())
        await self.activation._reclaim(RUNTIME_ID, pressure=True)
        self.assertEqual(self.live.suspensions, 0)
        self.live.subscribers.clear()
        await self.activation._reclaim(RUNTIME_ID, pressure=True)
        self.assertEqual(self.live.suspensions, 1)

    async def test_operation_pins_attachment_until_awaited_body_exits(self) -> None:
        service = object.__new__(LiveSessionService)
        service._activities = self.activities
        service.activation = self.activation
        service._catalog = SimpleNamespace(runtime_binding=lambda _session_id: None)
        async with service.operation(self.live) as session:
            self.assertIs(session, self.live.runtime_session)
            self.assertTrue(self.live.lifecycle_lock.locked())
            await self.activation._reclaim(RUNTIME_ID, pressure=True)
            self.assertEqual(self.live.suspensions, 0)
        await self.activation._reclaim(RUNTIME_ID, pressure=True)
        self.assertEqual(self.live.suspensions, 1)

    async def test_observer_failure_releases_reservation_and_preserves_identity(self) -> None:
        self.provider.waiting = True

        async def broken(_receipt: ResourceReceipt, _deadline: float) -> None:
            raise OSError("durable write failed")

        with self.assertRaises(OSError):
            await self.activation.ensure_active(self.live, on_wait=broken)
        self.assertEqual(self.provider.cancelled, ["1"])
        self.assertEqual(self.attached, [])
        self.assertFalse(self.live.waiting_resources)

    async def test_shutdown_cancels_waiters_before_returning(self) -> None:
        self.provider.waiting = True
        task = asyncio.create_task(self.activation.ensure_active(self.live))
        await asyncio.wait_for(self.provider.entered.wait(), TEST_TIMEOUT)
        await self.activation.aclose()
        self.assertTrue(task.cancelled())
        self.assertEqual(self.provider.cancelled, ["1"])

    def test_failure_codes_cannot_expose_arbitrary_provider_text(self) -> None:
        failure = SessionActivationError("secret-token-or-private-provider-response")
        self.assertEqual(failure.safe_error, RESOURCE_RESERVATION_INVALID)

    def test_sandbox_failure_codes_require_an_exact_public_code(self) -> None:
        for code in sorted(SANDBOX_STARTUP_ERRORS):
            with self.subTest(code=code):
                self.assertEqual(SessionActivationError(code).safe_error, code)
                for invalid in (f"private-{code}", f"{code}:private-response"):
                    self.assertEqual(
                        SessionActivationError(invalid).safe_error, RESOURCE_RESERVATION_INVALID
                    )

    def test_logical_model_selection_checks_owner_without_registering_a_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profiles = ModelProfileStore(Path(temporary) / "profiles.json")
            profile = profiles.upsert(
                {
                    "authentication": "oauth",
                    "oauth_provider": "chatgpt",
                    "selected_models": [{"id": "personal-model"}],
                },
                owner_id="owner",
            )
            model_key = personal_model_key(profile["id"], "personal-model")
            before = profiles.path.read_bytes()
            bridge = CompletionBridge("http://127.0.0.1:8770")
            subscription_status = Mock(return_value={"state": CredentialState.CONNECTED.value})
            models = ModelCatalogFixture(
                SimpleNamespace(runtime_model=lambda: model_key),
                bridge,
                profiles=profiles,
                activities=self.activities,
                subscriptions=SimpleNamespace(status=subscription_status),
            )
            self.assertEqual(models.selected_model_key(model_key, user_id="owner"), model_key)
            self.assertEqual(models.selected_model_key(user_id="owner"), model_key)
            subscription_status.assert_called_with("owner", profile["id"])
            for actor in ("", "other"):
                with self.assertRaises(SessionModelUnavailableError):
                    models.selected_model_key(model_key, user_id=actor)
            subscription_status.return_value = {"state": CredentialState.DISCONNECTED.value}
            with self.assertRaises(SessionModelUnavailableError):
                models.selected_model_key(model_key, user_id="owner")
            self.assertEqual(bridge.registration_count(), 0)
            self.assertEqual(profiles.path.read_bytes(), before)

    def opening_fixture(self, temporary: str):
        catalog = SessionCatalogStore(Path(temporary) / "catalog.sqlite3")
        catalog.allocate(
            self.live.id,
            SessionPrincipal("owner"),
            runtime_id=RUNTIME_ID,
            runtime_workdir=temporary,
            project_path=None,
            output_root=temporary,
            model_id="model",
        )
        service = object.__new__(LiveSessionService)
        service._activities = self.activities
        service._uncertain_attachments = {}
        service._logger = logging.getLogger(__name__)
        service._catalog = catalog
        service._models = SimpleNamespace(
            release_session=lambda _session_id: None, bridge_id_of=lambda base_url: None
        )
        return service, catalog

    async def test_proven_not_applied_open_can_retry_without_replacing_product_session(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            service, catalog = self.opening_fixture(temporary)
            queued = catalog.enqueue_message(
                self.live.id, "original-message", {"content": "retry me"}
            )
            binding = RuntimeBinding(
                product_session_id=self.live.id,
                runtime_id=RUNTIME_ID,
                adapter_version="fixture",
                runtime_version="fixture",
                protocol_version="fixture",
                protocol_schema_hash="fixture",
                opaque_session_ref="retried-thread",
                capabilities=CapabilitySet(),
            )
            opened = SimpleNamespace(binding=binding, detach=AsyncMock())
            failed = RuntimeOpenNotAppliedError("1")
            runtime = self.provider
            runtime.open = AsyncMock(side_effect=[failed, opened])
            plan = ActivationPlan(
                runtime, OpenSessionRequest(self.live.id, Path(temporary)), ("model", "ask")
            )
            self.activation._build = lambda _live: plan
            self.activation._revision = lambda _live: plan.revision
            self.activation._attach = service._attach_runtime
            with self.assertRaises(RuntimeOpenNotAppliedError):
                await self.activation.ensure_active(self.live, request_id="original-message")
            reopened = SessionCatalogStore(catalog.database)
            self.assertEqual(reopened.activation(self.live.id).open_state, OpenState.NEVER_STARTED)
            failed_attempt = reopened.activation(self.live.id).open_attempt_id
            self.assertTrue(failed_attempt)
            self.assertEqual(service._uncertain_attachments, {})
            self.assertEqual(
                catalog.enqueue_message(self.live.id, "original-message", {"content": "retry me"}),
                queued,
            )
            await self.activation.ensure_active(self.live, request_id="original-message")
            self.assertEqual(runtime.open.await_count, 2)
            self.assertEqual(
                [call.args[0].reservation_id for call in runtime.open.await_args_list], ["1", "2"]
            )
            self.assertNotEqual(runtime.requests[0].request_id, runtime.requests[1].request_id)
            self.assertEqual(reopened.runtime_binding(self.live.id), binding)
            self.assertNotEqual(reopened.activation(self.live.id).open_attempt_id, failed_attempt)
            self.assertEqual(reopened.activation(self.live.id).open_state, OpenState.UNSUBMITTED)
            self.assertFalse(reopened.reset_open_not_applied(self.live.id, failed_attempt))

    async def test_unrelated_negative_proof_does_not_clear_open_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            service, catalog = self.opening_fixture(temporary)
            runtime = SimpleNamespace(
                open=AsyncMock(side_effect=RuntimeOpenNotAppliedError("other-reservation"))
            )
            plan = ActivationPlan(
                runtime, OpenSessionRequest(self.live.id, Path(temporary)), ("model", "ask")
            )
            with self.assertRaises(RuntimeOpenNotAppliedError):
                await service._attach_runtime(self.live, plan, "reservation")
            self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.OPEN_UNKNOWN)
            self.assertTrue(service._uncertain_attachments)
            self.assertFalse(
                catalog.reset_open_not_applied(
                    self.live.id, catalog.activation(self.live.id).open_attempt_id
                )
            )

    async def test_negative_proof_after_native_binding_never_resets_session(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            service, catalog = self.opening_fixture(temporary)
            binding = RuntimeBinding(
                product_session_id=self.live.id,
                runtime_id=RUNTIME_ID,
                adapter_version="fixture",
                runtime_version="fixture",
                protocol_version="fixture",
                protocol_schema_hash="fixture",
                opaque_session_ref="existing-thread",
                capabilities=CapabilitySet(),
            )
            opened = SimpleNamespace(binding=binding, detach=AsyncMock())
            self.live.hydrate_runtime_history = AsyncMock(
                side_effect=RuntimeOpenNotAppliedError("reservation")
            )
            self.live.release_attachment_activity = Mock()
            runtime = SimpleNamespace(open=AsyncMock(return_value=opened))
            plan = ActivationPlan(
                runtime, OpenSessionRequest(self.live.id, Path(temporary)), ("model", "ask")
            )
            with patch.object(
                catalog, "reset_open_not_applied", wraps=catalog.reset_open_not_applied
            ) as reset:
                with self.assertRaises(RuntimeOpenNotAppliedError):
                    await service._attach_runtime(self.live, plan, "reservation")
                reset.assert_not_called()
            self.assertEqual(catalog.runtime_binding(self.live.id), binding)
            self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.UNSUBMITTED)
            self.assertFalse(
                catalog.reset_open_not_applied(
                    self.live.id, catalog.activation(self.live.id).open_attempt_id
                )
            )
            opened.detach.assert_awaited_once()

    async def test_open_reset_is_attempt_scoped_and_does_not_clear_newer_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            _service, catalog = self.opening_fixture(temporary)
            self.assertIsNotNone(catalog.begin_open(self.live.id, "first"))
            self.assertFalse(catalog.reset_open_not_applied(self.live.id, "other"))
            self.assertTrue(catalog.reset_open_not_applied(self.live.id, "first"))
            self.assertIsNotNone(catalog.begin_open(self.live.id, "second"))
            self.assertFalse(catalog.reset_open_not_applied(self.live.id, "first"))
            self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.OPENING)
            self.assertTrue(catalog.mark_open_unknown(self.live.id, "second"))
            self.assertFalse(catalog.reset_open_not_applied(self.live.id, "second"))

    async def test_failed_negative_proof_commit_retains_opening_fence(self) -> None:
        for failure in (None, OSError("database unavailable")):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                service, catalog = self.opening_fixture(temporary)
                runtime = SimpleNamespace(
                    open=AsyncMock(side_effect=RuntimeOpenNotAppliedError("reservation"))
                )
                plan = ActivationPlan(
                    runtime, OpenSessionRequest(self.live.id, Path(temporary)), ("model", "ask")
                )
                with patch.object(
                    catalog, "reset_open_not_applied", return_value=False, side_effect=failure
                ):
                    with self.assertRaises(SessionActivationError if failure is None else OSError):
                        await service._attach_runtime(self.live, plan, "reservation")
                self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.OPENING)
                self.assertTrue(service._uncertain_attachments)

    async def test_first_open_failure_is_fenced_in_file_backed_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            catalog = SessionCatalogStore(Path(temporary) / "catalog.sqlite3")
            catalog.allocate(
                self.live.id,
                SessionPrincipal("owner"),
                runtime_id=RUNTIME_ID,
                runtime_workdir=temporary,
                project_path=None,
                output_root=temporary,
                model_id="model",
            )
            service = object.__new__(LiveSessionService)
            service._activities = self.activities
            service._uncertain_attachments = {}
            service._logger = logging.getLogger(__name__)
            service._catalog = catalog
            service._models = SimpleNamespace(
                release_session=lambda _session_id: None, bridge_id_of=lambda base_url: None
            )

            async def failed_open(_request: OpenSessionRequest) -> None:
                self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.OPENING)
                raise ConnectionError("acknowledgement lost")

            plan = ActivationPlan(
                SimpleNamespace(open=failed_open),
                OpenSessionRequest(self.live.id, Path(temporary)),
                ("model", "ask"),
            )
            with self.assertRaises(ConnectionError):
                await service._attach_runtime(self.live, plan, "reservation")
            reopened = SessionCatalogStore(catalog.database)
            self.assertEqual(reopened.activation(self.live.id).open_state, OpenState.OPEN_UNKNOWN)
            self.assertIsNone(reopened.runtime_binding(self.live.id))
            with self.assertRaises(SessionActivationError) as failure:
                service._activation_plan(self.live)
            self.assertEqual(failure.exception.safe_error, SESSION_OPEN_UNKNOWN)

            generation = self.activities.begin()
            self.assertFalse(self.activities.seal(generation))
            service.activation = SimpleNamespace(aclose=AsyncMock())
            service.reconfiguration = SimpleNamespace(aclose=AsyncMock())
            service._one_shot_tasks = {}
            service._one_shot_drivers = {}
            service._one_shot_close_failures = {}
            service._readiness_task = None
            service._skill_inventory_refresh = {}
            shutdown = AsyncMock(return_value=SimpleNamespace(state=CommandState.ACCEPTED))
            service._gateway = SimpleNamespace(
                catalog=SimpleNamespace(runtime_ids=lambda: (RUNTIME_ID,)),
                provider=lambda _runtime_id: SimpleNamespace(shutdown=shutdown),
            )
            with self.assertRaisesRegex(RuntimeError, "shutdown was not confirmed"):
                await service.aclose()
            self.assertFalse(self.activities.seal(generation))
            shutdown.side_effect = OSError("native stop failed")
            with self.assertRaises(OSError):
                await service.aclose()
            self.assertFalse(self.activities.seal(generation))
            shutdown.side_effect = None
            shutdown.return_value = SimpleNamespace(state=CommandState.APPLIED)
            await service.aclose()
            self.assertTrue(self.activities.seal(generation))

    async def test_native_open_binding_and_attachment_generation_commit_together(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            catalog = SessionCatalogStore(Path(temporary) / "catalog.sqlite3")
            catalog.allocate(
                self.live.id,
                SessionPrincipal("owner"),
                runtime_id=RUNTIME_ID,
                runtime_workdir=temporary,
                project_path=None,
                output_root=temporary,
                model_id="model",
            )
            binding = RuntimeBinding(
                product_session_id=self.live.id,
                runtime_id=RUNTIME_ID,
                adapter_version="test-version",
                runtime_version="test-runtime",
                protocol_version="test-protocol",
                protocol_schema_hash="test-schema",
                opaque_session_ref="native-thread",
                capabilities=CapabilitySet(),
            )
            service = object.__new__(LiveSessionService)
            service._activities = self.activities
            service._uncertain_attachments = {}
            service._catalog = catalog
            service._models = SimpleNamespace(
                release_session=lambda _session_id: None, bridge_id_of=lambda base_url: None
            )

            async def opened(request: OpenSessionRequest) -> object:
                self.assertEqual(request.reservation_id, "reservation")
                self.assertEqual(catalog.activation(self.live.id).open_state, OpenState.OPENING)
                return SimpleNamespace(binding=binding)

            await service._attach_runtime(
                self.live,
                ActivationPlan(
                    SimpleNamespace(open=opened),
                    OpenSessionRequest(self.live.id, Path(temporary)),
                    ("model", "ask"),
                ),
                "reservation",
            )
            reopened = SessionCatalogStore(catalog.database)
            self.assertEqual(reopened.activation(self.live.id).open_state.value, "unsubmitted")
            self.assertEqual(reopened.activation(self.live.id).generation, 1)
            self.assertEqual(self.live.attachment_generation, 1)
            self.assertEqual(reopened.runtime_binding(self.live.id), binding)


if __name__ == "__main__":
    unittest.main()
