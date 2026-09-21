"""Deterministic admission contracts; fixtures do not constitute product acceptance."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from scholarseed_runtime.contract import CapabilitySet, OpenSessionRequest, RuntimeBinding
from scholarseed_runtime.contract.resource import (
    RESOURCE_WAIT_TIMEOUT,
    ResourcePolicy,
    ResourceReceipt,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.session import RuntimeActivitySnapshot
from service.chat.persistence.catalog import OpenState, SessionCatalogStore, SessionPrincipal
from service.chat.runtime.activation import (
    RESOURCE_RESERVATION_INVALID,
    SESSION_ACTIVATION_CLOSED,
    SESSION_OPEN_UNKNOWN,
    ActivationPlan,
    SessionActivation,
    SessionActivationError,
)
from service.chat.runtime.composition import LiveSessionService
from service.chat.runtime.timing import ActivationStage, ActivationTiming, TimingStatus
from service.chat.service.completions import CompletionBridge
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.settings.connections import ModelProfileStore, personal_model_key

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
        return RuntimeActivitySnapshot("generation", 1, 0, self.idle)


class ProductFixture:
    def __init__(self, session_id: str = "product") -> None:
        self.id = session_id
        self.runtime_id = RUNTIME_ID
        self.lifecycle_lock = asyncio.Lock()
        self.activation_lock = asyncio.Lock()
        self.runtime_session = None
        self.runtime_binding = None
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

    def activation_timing(self, request_id: str) -> ActivationTiming:
        return ActivationTiming(request_id, self.measurements.append)

    def prepare_runtime_attachment(self) -> None:
        self.token_rotations += 1

    def trace_resource(self, *_args: object) -> None:
        return None

    async def suspend_runtime(self) -> bool:
        async with self.lifecycle_lock:
            if self.runtime_session is None or not (await self.runtime_session.activity()).idle:
                return False
            self.suspensions += 1
            self.runtime_session = None
            return True

    def attach_gateway(self, session: object, *, resumed: bool) -> object:
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

        self.activation = SessionActivation(
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

    async def test_activation_spans_share_request_and_hot_path_does_not_fake_stages(self) -> None:
        await self.activation.ensure_active(self.live, request_id="cold-request")
        samples = self.live.measurements
        root = next(sample for sample in samples if sample.stage == ActivationStage.TOTAL)
        stages = {sample.stage for sample in samples}
        self.assertTrue(set(ActivationStage).issubset(stages))
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

    async def test_operation_pins_attachment_until_awaited_body_exits(self) -> None:
        service = object.__new__(LiveSessionService)
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
            models = ModelCatalogFixture(
                SimpleNamespace(runtime_model=lambda: model_key), bridge, profiles=profiles
            )
            self.assertEqual(models.selected_model_key(model_key, user_id="owner"), model_key)
            self.assertEqual(models.selected_model_key(user_id="owner"), model_key)
            for actor in ("", "other"):
                with self.assertRaises(SessionModelUnavailableError):
                    models.selected_model_key(model_key, user_id=actor)
            self.assertEqual(bridge.registration_count(), 0)
            self.assertEqual(profiles.path.read_bytes(), before)

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
            service._catalog = catalog
            service._models = SimpleNamespace(release_session=lambda _session_id: None)

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
            service._catalog = catalog
            service._models = SimpleNamespace(release_session=lambda _session_id: None)

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
            self.assertEqual(reopened.activation(self.live.id).open_state, OpenState.BOUND)
            self.assertEqual(reopened.activation(self.live.id).generation, 1)
            self.assertEqual(self.live.attachment_generation, 1)
            self.assertEqual(reopened.runtime_binding(self.live.id), binding)


if __name__ == "__main__":
    unittest.main()
