"""Provider ownership and secret retention contracts, without a real model call."""

from __future__ import annotations

import asyncio
import gc
import os
import tempfile
import unittest
import weakref
from dataclasses import replace
from pathlib import Path
from time import time
from unittest.mock import AsyncMock, Mock, patch

from scholarseed_codex.environment import (
    CODEX_HOME_ENV,
    SCHOLARSEED_CODEX_HOME_ENV,
)
from scholarseed_codex.launch import (
    CODEX_MODEL_CONNECTION_REQUIRED,
    model_connection,
    validate_thread_model,
)
from scholarseed_codex.mcp import MCP_LOGIN_COMPLETED_NOTIFICATION, CodexMcpControl
from scholarseed_codex.process import CodexProcessHost
from scholarseed_codex.protocol.session import (
    CodexRuntimeReadiness,
    CodexRuntimeStatus,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import AppServerError, CodexActivationStage
from scholarseed_codex.provider import CodexRuntimeProvider
from scholarseed_runtime.contract import CommandState, OpenSessionRequest, ResumeSessionRequest
from scholarseed_runtime.contract.binding import RuntimeBinding
from scholarseed_runtime.contract.capability import CapabilitySet
from scholarseed_runtime.contract.command import (
    HostWarmupRequest,
    InventoryKind,
    InventoryRequest,
    RuntimeInspectionRequest,
    SkillConfigurationRequest,
)
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING
from scholarseed_runtime.contract.model import (
    ModelCapabilities,
    ModelConnectionMode,
    ModelIntent,
    ModelToolProtocol,
    ModelTransport,
)
from scholarseed_runtime.contract.resource import (
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
    RESOURCE_HOST_CONFIGURATION_UNCERTAIN,
    RESOURCE_HOST_CONTEXT_REQUIRED,
    RESOURCE_RESERVATION_INVALID,
    ResourcePurpose,
    ResourceRequest,
    ResourceState,
)
from scholarseed_runtime.contract.runtime import ProviderConfiguration
from tests.contract_codex_capacity import ControlledHost, TimingRecorder

WAIT_SECONDS = 0.05
SETTLEMENT_SECONDS = 0.2


class CodexAdmissionContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="provider-admission-")
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(
            os.environ,
            {
                SCHOLARSEED_CODEX_HOME_ENV: str(self.root / "runtime"),
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.temporary.cleanup)
        readiness = CodexRuntimeReadiness(
            runtime_id="codex",
            status=CodexRuntimeStatus.READY,
            ready=True,
            executable="/contract/codex",
            version="0.154.0",
        )
        self.probe = patch(
            "scholarseed_codex.pool._probe_codex_cli_readiness", AsyncMock(return_value=readiness)
        )
        self.host = patch("scholarseed_codex.pool.CodexProcessHost", ControlledHost)
        self.catalog = patch(
            "scholarseed_codex.catalog.native_catalog",
            AsyncMock(return_value={"models": [{"slug": "admission-fixture"}]}),
        )
        self.executable = patch(
            "scholarseed_codex.provider.configured_codex_executable", return_value="/contract/codex"
        )
        self.probe.start()
        self.host.start()
        self.catalog.start()
        self.executable.start()
        self.addCleanup(self.probe.stop)
        self.addCleanup(self.host.stop)
        self.addCleanup(self.catalog.stop)
        self.addCleanup(self.executable.stop)

        # These admission tests isolate host/secret ownership from MCP storage.
        # Keep real model projection; configuration publication has its own suite.
        async def connection(*args, **kwargs):
            projected = await model_connection(*args, **kwargs)
            return replace(projected, provider_configuration={})

        for module in ("provider", "session"):
            projection = patch(
                f"scholarseed_codex.{module}.model_connection", side_effect=connection
            )
            projection.start()
            self.addCleanup(projection.stop)
        self.provider = CodexRuntimeProvider()
        self.configuration = ProviderConfiguration(
            "codex", {"capacity": {"wait_seconds": WAIT_SECONDS}}
        )
        self.assertIs(self.provider.configure(self.configuration).state, CommandState.APPLIED)
        self.addAsyncCleanup(self.provider.shutdown)

    def request(self, request_id: str = "admission") -> ResourceRequest:
        return ResourceRequest(
            request_id,
            ResourcePurpose.SESSION,
            time() + 10,
            OpenSessionRequest(
                "product-session",
                self.root,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            ),
        )

    async def test_host_warmup_keeps_one_host_without_materializing_a_session(self) -> None:
        first = await self.provider.prewarm(
            HostWarmupRequest(
                "warm-first",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        self.assertIs(first.state, CommandState.APPLIED)
        self.assertEqual(self.provider._prepared, {})
        hosts = tuple(self.provider._pool._hosts.values())
        self.assertEqual(len(hosts), 1)
        self.assertEqual(hosts[0].owners, set())
        self.assertFalse(hosts[0].host.closed)
        second = await self.provider.prewarm(
            HostWarmupRequest(
                "warm-second",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        self.assertEqual(first.correlation_id, second.correlation_id)
        self.assertEqual(tuple(self.provider._pool._hosts.values()), hosts)
        self.assertTrue(await self.provider._pool.release_idle())

    async def test_host_warmup_requires_explicit_sharing_authority(self) -> None:
        with self.assertRaises(ValueError):
            await self.provider.prewarm(
                HostWarmupRequest(
                    "warm-denied",
                    self.root,
                    process_sharing_scope="",
                    model=ModelIntent(
                        transport=ModelTransport(
                            endpoint="https://model.example.test/v1", supports_websockets=True
                        ),
                        capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                        model_ref="admission-fixture",
                    ),
                )
            )
        self.assertEqual(self.provider._pool.snapshot()[0].used, 0)

    async def test_remote_thread_endpoints_do_not_become_host_configuration(self) -> None:
        requests = []
        for endpoint in (
            "https://bridge.example.test/session-a",
            "https://bridge.example.test/session-b",
        ):
            intent = ModelIntent(
                model_ref="model",
                transport=ModelTransport(mode=ModelConnectionMode.REMOTE, endpoint=endpoint),
                capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
            )
            request = await model_connection(
                intent,
                CodexSessionOpenRequest(request_id="remote", runtime_id="codex", cwd=self.root),
                None,
                timing=NOOP_RUNTIME_TIMING,
            )
            validate_thread_model(request)
            self.assertEqual(
                request.thread_config["model_providers"][request.model_provider]["base_url"],
                endpoint,
            )
            self.assertNotIn(endpoint, str(request.launch_arguments))
            requests.append(request)
        self.assertEqual(requests[0].provider_configuration, requests[1].provider_configuration)
        self.assertNotIn("base_url", requests[0].provider_configuration[requests[0].model_provider])
        with self.assertRaises(AppServerError) as rejected:
            validate_thread_model(replace(requests[0], thread_config={}))
        self.assertEqual(rejected.exception.safe_error, CODEX_MODEL_CONNECTION_REQUIRED)

    async def test_native_authentication_is_rejected_before_home_preparation(self) -> None:
        for intent in (
            ModelIntent(),
            ModelIntent(
                transport=ModelTransport(
                    mode=ModelConnectionMode.NATIVE,
                    endpoint="https://ignored.example.test",
                )
            ),
        ):
            with (
                self.subTest(intent=intent),
                patch.object(
                    self.provider._pool, "prepare_home", side_effect=AssertionError("Home prepared")
                ) as prepare,
                patch(
                    "asyncio.create_subprocess_exec", side_effect=AssertionError("process started")
                ),
            ):
                with self.assertRaises(AppServerError) as error:
                    await model_connection(
                        intent,
                        CodexSessionOpenRequest("invalid", "codex", self.root),
                        None,
                        timing=NOOP_RUNTIME_TIMING,
                    )
                self.assertEqual(error.exception.safe_error, CODEX_MODEL_CONNECTION_REQUIRED)
                request = HostWarmupRequest(
                    "invalid", self.root, process_sharing_scope="owner", model=intent
                )
                with self.assertRaises(AppServerError) as warmed:
                    await self.provider.prewarm(request)
                self.assertEqual(warmed.exception.safe_error, CODEX_MODEL_CONNECTION_REQUIRED)
                prepare.assert_not_called()

    async def test_active_host_prepares_only_thread_storage(self) -> None:
        await self.provider.prewarm(
            HostWarmupRequest(
                "auth-pin",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        with patch(
            "scholarseed_codex.pool.prepare_codex_runtime_home", return_value=self.root / "runtime"
        ) as prepare:
            await self.provider.prewarm(
                HostWarmupRequest(
                    "auth-again",
                    self.root,
                    process_sharing_scope="owner",
                    model=ModelIntent(
                        transport=ModelTransport(
                            endpoint="https://model.example.test/v1", supports_websockets=True
                        ),
                        capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                        model_ref="admission-fixture",
                    ),
                )
            )
        prepare.assert_called_once_with()

    async def test_dead_idle_host_cannot_report_successful_warmup(self) -> None:
        await self.provider.prewarm(
            HostWarmupRequest(
                "dead-first",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        host = next(iter(self.provider._pool._hosts.values())).host
        host.readiness.ready = False
        with self.assertRaises(AppServerError):
            await self.provider.prewarm(
                HostWarmupRequest(
                    "dead-second",
                    self.root,
                    process_sharing_scope="owner",
                    model=ModelIntent(
                        transport=ModelTransport(
                            endpoint="https://model.example.test/v1", supports_websockets=True
                        ),
                        capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                        model_ref="admission-fixture",
                    ),
                )
            )
        self.assertEqual(host.start_calls, 2)

    async def test_oauth_notification_does_not_reenter_stdout_rpc(self) -> None:
        request = AsyncMock(side_effect=AssertionError("notification cannot await an RPC reply"))
        control = CodexMcpControl(request=request, session_id=lambda: "thread")
        self.assertTrue(
            await control.handle_notification(
                MCP_LOGIN_COMPLETED_NOTIFICATION, {"name": "server", "success": True}
            )
        )
        request.assert_not_awaited()

    async def test_failed_admission_blocks_physical_start_and_recovery(self) -> None:
        host = CodexProcessHost(executable="not-an-executable")
        host.admission.fail(RESOURCE_HOST_CONFIGURATION_UNCERTAIN)
        with patch(
            "scholarseed_codex.process.asyncio.create_subprocess_exec", AsyncMock()
        ) as spawn:
            for operation in (host.start, host._start_process, host._launch_process):
                with self.assertRaises(AppServerError) as rejected:
                    await operation()
                self.assertEqual(
                    rejected.exception.safe_error, RESOURCE_HOST_CONFIGURATION_UNCERTAIN
                )
            spawn.assert_not_awaited()
        host._threads["thread"] = object()
        host._schedule_recovery(None)
        self.assertIsNone(host._recovery_task)

    async def test_control_requires_full_authority_before_preparing_home(self) -> None:
        with patch("scholarseed_codex.pool.prepare_codex_runtime_home") as prepare:
            with self.assertRaises(AppServerError) as inspection:
                await self.provider.inspect(
                    RuntimeInspectionRequest(self.root, InventoryRequest(()))
                )
            self.assertEqual(inspection.exception.safe_error, RESOURCE_HOST_CONTEXT_REQUIRED)
            with self.assertRaises(AppServerError) as configuration:
                await self.provider.configure_skills(SkillConfigurationRequest(self.root, ()))
            self.assertEqual(configuration.exception.safe_error, RESOURCE_HOST_CONTEXT_REQUIRED)
            prepare.assert_not_called()
        self.assertEqual(self.provider._pool.snapshot()[0].used, 0)

    async def test_all_control_inventories_borrow_the_warmed_execution_host(self) -> None:
        host = HostWarmupRequest(
            "shared-control",
            self.root,
            process_sharing_scope="owner",
            model=ModelIntent(
                transport=ModelTransport(
                    endpoint="https://model.example.test/v1", supports_websockets=True
                ),
                capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                model_ref="admission-fixture",
            ),
        )
        ready = await self.provider.prewarm(host)
        slot = next(iter(self.provider._pool._hosts.values()))
        slot.host.request.return_value = {"data": []}
        for kind in (InventoryKind.MODELS, InventoryKind.SKILLS, InventoryKind.MCP):
            snapshot = await self.provider.inspect(
                RuntimeInspectionRequest(
                    self.root,
                    InventoryRequest((kind,)),
                    host=host,
                )
            )
            self.assertEqual(snapshot.host_identity, ready.correlation_id)
            self.assertIn(kind.value, snapshot.values)
            self.assertEqual(tuple(self.provider._pool._hosts.values()), (slot,))
            self.assertEqual(slot.owners, set())
            self.assertFalse(slot.host.closed)
            self.assertEqual(self.provider._pool.snapshot()[1].used, 0)
        self.assertEqual(slot.host.start_calls, 1)

    async def test_other_control_principal_is_rejected_before_home_synchronization(self) -> None:
        await self.provider.prewarm(
            HostWarmupRequest(
                "owner",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        with patch("scholarseed_codex.pool.prepare_codex_runtime_home") as prepare:
            with self.assertRaises(AppServerError) as rejected:
                await self.provider.inspect(
                    RuntimeInspectionRequest(
                        self.root,
                        InventoryRequest(()),
                        host=HostWarmupRequest(
                            "other",
                            self.root,
                            process_sharing_scope="other",
                            model=ModelIntent(
                                transport=ModelTransport(
                                    endpoint="https://model.example.test/v1",
                                    supports_websockets=True,
                                ),
                                capabilities=ModelCapabilities(
                                    tool_protocol=ModelToolProtocol.JSON_SCHEMA
                                ),
                                model_ref="admission-fixture",
                            ),
                        ),
                    )
                )
            self.assertEqual(rejected.exception.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
            prepare.assert_not_called()
        self.assertEqual(len(self.provider._pool._hosts), 1)

    async def test_host_warmup_conflict_requires_application_restart_even_after_drain(self) -> None:
        first = await self.provider.prewarm(
            HostWarmupRequest(
                "pin-owner",
                self.root,
                process_sharing_scope="owner",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        self.assertIs(first.state, CommandState.APPLIED)
        self.assertTrue(await self.provider._pool.release_idle())
        rejected = await self.provider.prewarm(
            HostWarmupRequest(
                "other-owner",
                self.root,
                process_sharing_scope="other",
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            )
        )
        self.assertIs(rejected.state, CommandState.RESTART_REQUIRED)
        self.assertEqual(rejected.safe_error, RESOURCE_HOST_CONFIGURATION_CONFLICT)
        self.assertEqual(self.provider._pool.snapshot()[0].used, 0)

    def test_timing_is_excluded_from_request_equality_and_repr(self) -> None:
        binding = RuntimeBinding(
            product_session_id="timed-session",
            runtime_id="codex",
            adapter_version="",
            runtime_version="",
            protocol_version="",
            protocol_schema_hash="",
            opaque_session_ref="timed-thread",
            capabilities=CapabilitySet(),
        )
        requests = (
            OpenSessionRequest(
                binding.product_session_id,
                self.root,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            ),
            ResumeSessionRequest(
                binding,
                self.root,
                model=ModelIntent(
                    transport=ModelTransport(
                        endpoint="https://model.example.test/v1", supports_websockets=True
                    ),
                    capabilities=ModelCapabilities(tool_protocol=ModelToolProtocol.JSON_SCHEMA),
                    model_ref="admission-fixture",
                ),
            ),
            RuntimeInspectionRequest(self.root, InventoryRequest(())),
            SkillConfigurationRequest(self.root, ()),
        )
        for request in requests:
            with self.subTest(request=type(request).__name__):
                timed = replace(request, timing=TimingRecorder())
                repeated = replace(request, timing=TimingRecorder())
                self.assertEqual(timed, request)
                self.assertEqual(timed, repeated)
                self.assertEqual(repr(timed), repr(request))
                self.assertEqual(repr(timed), repr(repeated))
                if isinstance(timed, (OpenSessionRequest, ResumeSessionRequest)):
                    self.assertIs(self.provider._open_request(timed).timing, timed.timing)

    async def test_provider_retry_with_new_timing_preserves_reservation(self) -> None:
        request = self.request("timed-idempotence")
        timed = replace(
            request, session_request=replace(request.session_request, timing=TimingRecorder())
        )
        receipt = await self.provider.reserve(timed)
        repeated = await self.provider.reserve(
            replace(timed, session_request=replace(timed.session_request, timing=TimingRecorder()))
        )
        self.assertEqual(receipt.reservation_id, repeated.reservation_id)
        await self.provider.cancel_resource(receipt.reservation_id)
        terminal = await self.provider.reserve(request)
        self.assertEqual(terminal.reservation_id, receipt.reservation_id)
        self.assertIs(terminal.state, ResourceState.CANCELLED)

    async def test_cancelled_prepare_wait_does_not_release_another_owners_lock(self) -> None:
        timing = TimingRecorder()
        request = self.request("timed-lock-cancel")
        request = replace(request, session_request=replace(request.session_request, timing=timing))
        await self.provider._prepare_lock.acquire()
        waiter = asyncio.create_task(self.provider.reserve(request))
        try:
            await asyncio.wait_for(
                timing.signal(CodexActivationStage.PREPARE_LOCK_WAIT).wait(), SETTLEMENT_SECONDS
            )
            self.assertFalse(waiter.done())
            waiter.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiter
            self.assertTrue(self.provider._prepare_lock.locked())
            self.assertEqual(
                timing.finished,
                [(CodexActivationStage.PREPARE_LOCK_WAIT, asyncio.CancelledError)],
            )
            self.assertNotIn(CodexActivationStage.LAUNCH_CREDENTIALS, timing.entered)
        finally:
            self.provider._prepare_lock.release()
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
        receipt = await self.provider.reserve(self.request("after-timed-cancel"))
        self.assertIs(receipt.state, ResourceState.GRANTED)
        await self.provider.cancel_resource(receipt.reservation_id)

    async def test_unclaimed_expiry_releases_prepared_session_and_preserves_receipt(self) -> None:
        request = self.request()
        receipt = await self.provider.reserve(request)
        session = weakref.ref(self.provider._prepared[receipt.reservation_id][1])
        await asyncio.sleep(SETTLEMENT_SECONDS)
        self.assertEqual(self.provider._prepared, {})
        gc.collect()
        self.assertIsNone(session())
        self.assertIs(
            (await self.provider.wait_resource(receipt.reservation_id)).state, ResourceState.EXPIRED
        )
        self.assertIs(
            (await self.provider.cancel_resource(receipt.reservation_id)).state,
            ResourceState.EXPIRED,
        )
        repeated = await self.provider.reserve(request)
        self.assertEqual(repeated.reservation_id, receipt.reservation_id)
        self.assertIs(repeated.state, ResourceState.EXPIRED)

    async def test_terminal_request_identity_cannot_be_reassigned(self) -> None:
        request = self.request()
        receipt = await self.provider.reserve(request)
        await self.provider.cancel_resource(receipt.reservation_id)
        changed = replace(
            request, session_request=replace(request.session_request, product_session_id="other")
        )
        with self.assertRaises(AppServerError):
            await self.provider.reserve(changed)

    async def test_duplicate_materialization_cannot_close_the_winning_session(self) -> None:
        resource = self.request("duplicate-materialization")
        receipt = await self.provider.reserve(resource)
        session = self.provider._prepared[receipt.reservation_id][1]
        request = replace(resource.session_request, reservation_id=receipt.reservation_id)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def open_session() -> None:
            entered.set()
            await release.wait()

        with patch.object(session, "open", open_session):
            winner = asyncio.create_task(self.provider.open(request))
            try:
                await asyncio.wait_for(entered.wait(), SETTLEMENT_SECONDS)
                lease = session._native.lease
                self.assertIsNotNone(lease)
                with self.assertRaises(AppServerError) as duplicate:
                    await self.provider.open(request)
                self.assertEqual(duplicate.exception.safe_error, RESOURCE_RESERVATION_INVALID)
                self.assertIs(session._native.lease, lease)
                self.assertFalse(lease.host.closed)
                self.assertEqual(self.provider._pool.snapshot()[0].used, 1)
                release.set()
                self.assertIs(await asyncio.wait_for(winner, SETTLEMENT_SECONDS), session)
                with self.assertRaises(AppServerError) as repeated:
                    await self.provider.open(request)
                self.assertEqual(repeated.exception.safe_error, RESOURCE_RESERVATION_INVALID)
                self.assertIs(session._native.lease, lease)
                self.assertFalse(lease.host.closed)
            finally:
                release.set()
                await asyncio.gather(winner, return_exceptions=True)
                await session.detach()
        self.assertEqual(self.provider._pool.snapshot()[0].used, 1)
        self.assertTrue(await self.provider._pool.release_idle())

    async def test_mismatched_request_cannot_claim_another_prepared_session(self) -> None:
        resource = self.request("invalid-materialization")
        receipt = await self.provider.reserve(resource)
        prepared = self.provider._prepared[receipt.reservation_id]
        invalid = replace(
            resource.session_request,
            product_session_id="different-session",
            reservation_id=receipt.reservation_id,
        )
        with self.assertRaises(AppServerError) as caught:
            await self.provider.open(invalid)
        self.assertEqual(caught.exception.safe_error, RESOURCE_RESERVATION_INVALID)
        self.assertIs(self.provider._prepared[receipt.reservation_id], prepared)
        self.assertIsNone(prepared[1]._native.lease)
        await self.provider.cancel_resource(receipt.reservation_id)

    async def test_configuration_is_idempotent_but_cannot_change_live_budgets(self) -> None:
        self.assertIs(self.provider.configure(self.configuration).state, CommandState.APPLIED)
        changed = ProviderConfiguration("codex", {"capacity": {"execution_hosts": 6}})
        self.assertIs(self.provider.configure(changed).state, CommandState.REJECTED)
        changed_owner = replace(self.configuration, resource_lease=Mock)
        self.assertIs(self.provider.configure(changed_owner).state, CommandState.REJECTED)

    async def test_idle_resource_release_requires_provider_confirmation(self) -> None:
        with patch.object(self.provider._pool, "release_idle", new=AsyncMock(return_value=False)):
            receipt = await self.provider.release_idle_resources()
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertEqual(receipt.safe_error, "runtime_resource_release_busy")
        with patch.object(
            self.provider._pool, "release_idle", new=AsyncMock(side_effect=OSError("private"))
        ):
            receipt = await self.provider.release_idle_resources()
            self.assertIs(receipt.state, CommandState.REJECTED)
            self.assertEqual(receipt.safe_error, "runtime_resource_release_failed")
        self.assertIs((await self.provider.release_idle_resources()).state, CommandState.APPLIED)

    async def test_denied_preparation_never_touches_runtime_home_or_credentials(self) -> None:
        denied = Mock(side_effect=RuntimeError("workbench warming"))
        provider = CodexRuntimeProvider()
        configuration = replace(self.configuration, resource_lease=denied)
        self.assertIs(provider.configure(configuration).state, CommandState.APPLIED)
        self.addAsyncCleanup(provider.shutdown)
        with (
            patch("scholarseed_codex.provider._resolve_launch_secrets", new=AsyncMock()) as secrets,
            patch("scholarseed_codex.provider.CodexRuntimeSession") as session,
            patch("scholarseed_codex.pool.prepare_codex_runtime_home") as prepare,
            patch("scholarseed_codex.provider.CodexRuntimeControl") as control,
        ):
            with self.assertRaisesRegex(RuntimeError, "workbench warming"):
                await provider.reserve(self.request("denied-storage"))
            with self.assertRaisesRegex(RuntimeError, "workbench warming"):
                async with provider._control(
                    cwd=self.root,
                    roots=(),
                    host=HostWarmupRequest(
                        "denied-control",
                        self.root,
                        process_sharing_scope="owner",
                        model=ModelIntent(
                            transport=ModelTransport(
                                endpoint="https://model.example.test/v1", supports_websockets=True
                            ),
                            capabilities=ModelCapabilities(
                                tool_protocol=ModelToolProtocol.JSON_SCHEMA
                            ),
                            model_ref="admission-fixture",
                        ),
                    ),
                ):
                    self.fail("denied preparation cannot open a control scope")
            secrets.assert_not_awaited()
            session.assert_not_called()
            prepare.assert_not_called()
            control.assert_not_called()
        self.assertFalse((self.root / "runtime").exists())
        self.assertEqual(denied.call_count, 2)

    async def test_preparation_owner_covers_directory_write_and_control_open_wait(self) -> None:
        for outcome in ("success", "failure", "cancel"):
            with self.subTest(outcome=outcome):
                ownership = Mock()
                owners = iter((ownership, Mock(), Mock(), Mock()))
                provider = CodexRuntimeProvider()
                self.assertIs(
                    provider.configure(
                        replace(
                            self.configuration, resource_lease=lambda owners=owners: next(owners)
                        )
                    ).state,
                    CommandState.APPLIED,
                )
                self.addAsyncCleanup(provider.shutdown)
                entered, release = asyncio.Event(), asyncio.Event()
                marker = self.root / ("prepared-" + outcome)

                def prepare(**_kwargs):
                    ownership.close.assert_not_called()
                    marker.write_text("owned preparation")
                    return self.root

                async def open_control():
                    ownership.close.assert_not_called()
                    entered.set()
                    await release.wait()
                    ownership.close.assert_not_called()
                    if outcome == "failure":
                        raise OSError("open failed")

                control = Mock(open=AsyncMock(side_effect=open_control), aclose=AsyncMock())
                with (
                    patch("scholarseed_codex.pool.prepare_codex_runtime_home", side_effect=prepare),
                    patch(
                        "scholarseed_codex.provider.managed_codex_launch",
                        return_value=({CODEX_HOME_ENV: str(self.root)}, ()),
                    ),
                    patch("scholarseed_codex.provider.CodexRuntimeControl", return_value=control),
                ):

                    async def run_control():
                        async with provider._control(
                            cwd=self.root,
                            roots=(),
                            host=HostWarmupRequest(
                                "owned-control",
                                self.root,
                                process_sharing_scope="owner",
                                model=ModelIntent(
                                    transport=ModelTransport(
                                        endpoint="https://model.example.test/v1",
                                        supports_websockets=True,
                                    ),
                                    capabilities=ModelCapabilities(
                                        tool_protocol=ModelToolProtocol.JSON_SCHEMA
                                    ),
                                    model_ref="admission-fixture",
                                ),
                            ),
                        ) as active:
                            return active

                    task = asyncio.create_task(run_control())
                    try:
                        await asyncio.wait_for(entered.wait(), 2)
                        ownership.close.assert_not_called()
                        self.assertEqual(marker.read_text(), "owned preparation")
                        if outcome == "cancel":
                            task.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await task
                        else:
                            release.set()
                            if outcome == "failure":
                                with self.assertRaises(OSError):
                                    await task
                            else:
                                self.assertIs(await task, control)
                    finally:
                        release.set()
                        if not task.done():
                            task.cancel()
                            await asyncio.gather(task, return_exceptions=True)
                ownership.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
