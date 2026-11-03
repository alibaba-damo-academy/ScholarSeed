"""Durable MCP plans and commit readback, not product acceptance."""

from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from scholarseed_runtime.contract.mcp import McpConfigurationReceipt
from service.platform.activity import Activities
from service.platform.mcp import McpApplyRequest, McpHttpServer, McpPlanRequest, McpUpsert
from service.settings.mcp import (
    McpConfigurationService,
    McpConfigurationStore,
    McpDocument,
    McpState,
)
from service.settings.plans import (
    McpPlanOrigin,
    McpPlanService,
    McpPlanState,
    McpPlanStore,
    create_plan,
)

SERVER_URL = "https://example.invalid/mcp"


class McpPlanTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = Path(self.home.name)
        self.store = McpPlanStore(root / "plans")
        self.configuration = McpConfigurationStore(root / "mcp.json")
        self.origin = McpPlanOrigin(session_id="session", turn_id="turn", request_id="callback")
        self.request = McpPlanRequest(
            expected_revision=0,
            mutation=McpUpsert(server=McpHttpServer(id="new", url=SERVER_URL)),
            intent="Connect the requested server",
        )

    def plan(self, document=None):
        return create_plan(self.request, document or McpDocument(), self.origin)

    def test_upsert_preserves_other_servers_and_freezes_source_inputs(self):
        retained = McpHttpServer(id="retained", url=SERVER_URL)
        plan = self.plan(McpDocument(servers=(retained,)))
        self.assertEqual([server.id for server in plan.target.servers], ["retained", "new"])
        self.request.mutation.server.headers["X-Later"] = "mutated"
        self.assertEqual(plan.request.mutation.server.headers, {})
        self.assertEqual(plan.target.servers[1].headers, {})
        self.assertEqual(plan.target.revision, 1)
        plan.verified()

    def test_digest_change_and_invalid_identifier_are_rejected(self):
        plan = self.plan()
        with self.assertRaises(ValueError):
            self.store.save(
                plan.model_copy(
                    update={"origin": self.origin.model_copy(update={"turn_id": "other"})}
                )
            )
        with self.assertRaises(ValueError):
            self.store.read("../outside")

    def test_stale_update_and_backward_state_are_rejected(self):
        initial = self.store.save(self.plan())
        committing = self.store.save(
            initial.model_copy(update={"state": McpPlanState.COMMITTING}), expected=initial
        )
        with self.assertRaises(ValueError):
            self.store.save(initial, expected=initial)
        saved = self.store.confirm(committing, committing.target)
        with self.assertRaises(ValueError):
            self.store.save(committing, expected=saved)
        self.assertEqual(self.store.read(initial.plan_id), saved)

    def test_restart_recovers_existing_commit_without_repeating_write(self):
        plan = self.store.save(self.plan())
        committing = self.store.save(
            plan.model_copy(update={"state": McpPlanState.COMMITTING}), expected=plan
        )
        document = self.configuration.replace(committing.target.servers, expected_revision=0)
        restarted = McpPlanStore(self.store.path)
        pending = restarted.read(plan.plan_id)
        saved = restarted.confirm(pending, self.configuration.read())
        self.assertEqual(saved.state, McpPlanState.SAVED)
        self.assertEqual(self.configuration.read(), document)
        self.assertEqual(self.configuration.read().revision, 1)

    def test_conflicting_commit_does_not_mark_saved(self):
        plan = self.store.save(self.plan())
        committing = self.store.save(
            plan.model_copy(update={"state": McpPlanState.COMMITTING}), expected=plan
        )
        for document in (McpDocument(), McpDocument(revision=1), McpDocument(revision=2)):
            with self.subTest(revision=document.revision), self.assertRaises(ValueError):
                self.store.confirm(committing, document)
        self.assertEqual(self.store.read(plan.plan_id).state, McpPlanState.COMMITTING)

    def test_apply_contract_does_not_accept_new_command_or_model_approval(self):
        plan = self.plan()
        payload = {"plan_id": plan.plan_id, "plan_digest": plan.plan_digest}
        for extra in ({"approved": True}, {"command": "untrusted"}, {"servers": []}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                McpApplyRequest.model_validate({**payload, **extra})


class PlanRuntime:
    def __init__(self):
        self.requests = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def configure_mcp(self, request):
        self.requests.append(request)
        self.started.set()
        await self.release.wait()
        return McpConfigurationReceipt(request.revision)

    async def mcp_configuration(self):
        return McpConfigurationReceipt(self.requests[-1].revision if self.requests else 0)


class McpPlanServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        root = Path(self.home.name)
        self.store = McpPlanStore(root / "plans")
        self.configuration_store = McpConfigurationStore(root / "mcp.json")
        self.runtime = PlanRuntime()
        activities = Activities()
        self.configuration = McpConfigurationService(
            self.configuration_store, lambda: self.runtime, activities=activities
        )
        self.service = McpPlanService(self.store, self.configuration, activities=activities)
        self.origin = McpPlanOrigin(session_id="session", turn_id="turn", request_id="callback")
        self.request = McpPlanRequest(
            expected_revision=0,
            mutation=McpUpsert(server=McpHttpServer(id="new", url=SERVER_URL)),
            intent="Connect the requested server",
        )

    async def test_repeated_and_concurrent_apply_write_only_once(self):
        plan = await self.service.create(self.request, self.origin)
        request = McpApplyRequest(plan_id=plan.plan_id, plan_digest=plan.plan_digest)
        first, second = await asyncio.gather(
            self.service.apply(request, self.origin), self.service.apply(request, self.origin)
        )
        self.assertEqual(first.plan, second.plan)
        self.assertEqual(first.plan.state, McpPlanState.SAVED)
        self.assertEqual(first.configuration.state, McpState.PENDING_APPLY)
        self.assertEqual(len(self.runtime.requests), 1)
        self.assertEqual(self.configuration_store.read().revision, 1)

    async def test_cancellation_does_not_release_unfinished_apply_or_repeat_commit(self):
        plan = await self.service.create(self.request, self.origin)
        request = McpApplyRequest(plan_id=plan.plan_id, plan_digest=plan.plan_digest)
        self.runtime.release.clear()
        applying = asyncio.create_task(self.service.apply(request, self.origin))
        await self.runtime.started.wait()
        applying.cancel()
        await asyncio.sleep(0)
        self.assertEqual(self.store.read(plan.plan_id).state, McpPlanState.COMMITTING)
        self.assertFalse(applying.done())
        retrying = asyncio.create_task(self.service.apply(request, self.origin))
        await asyncio.sleep(0)
        self.assertFalse(retrying.done())
        self.runtime.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await applying
        result = await retrying
        self.assertEqual(result.plan.state, McpPlanState.SAVED)
        self.assertEqual(len(self.runtime.requests), 1)
        self.assertEqual(self.configuration_store.read().revision, 1)

    async def test_cross_session_or_different_digest_cannot_apply(self):
        plan = await self.service.create(self.request, self.origin)
        request = McpApplyRequest(plan_id=plan.plan_id, plan_digest=plan.plan_digest)
        with self.assertRaises(ValueError):
            await self.service.apply(
                request, self.origin.model_copy(update={"session_id": "other"})
            )
        with self.assertRaises(ValueError):
            await self.service.apply(
                request.model_copy(update={"plan_digest": "0" * 64}), self.origin
            )
        self.assertFalse(self.configuration_store.path.exists())
        self.assertEqual(self.runtime.requests, [])

    async def test_committed_crash_reconciles_without_second_configuration_write(self):
        plan = await self.service.create(self.request, self.origin)
        self.store.save(plan.model_copy(update={"state": McpPlanState.COMMITTING}), expected=plan)
        self.configuration_store.replace(plan.target.servers, expected_revision=0)
        before = self.configuration_store.path.read_bytes()
        result = await self.service.apply(
            McpApplyRequest(plan_id=plan.plan_id, plan_digest=plan.plan_digest), self.origin
        )
        self.assertEqual(result.plan.state, McpPlanState.SAVED)
        self.assertEqual(self.configuration_store.path.read_bytes(), before)
        self.assertEqual(self.runtime.requests[0].revision, 1)

    async def test_unrelated_writer_or_unexecuted_matching_target_is_not_our_commit(self):
        plan = await self.service.create(self.request, self.origin)
        self.configuration_store.replace(plan.target.servers, expected_revision=0)
        with self.assertRaises(ValueError):
            await self.service.apply(
                McpApplyRequest(plan_id=plan.plan_id, plan_digest=plan.plan_digest), self.origin
            )
        self.assertEqual(self.store.read(plan.plan_id).state, McpPlanState.PLANNED)
        self.assertEqual(self.runtime.requests, [])


if __name__ == "__main__":
    unittest.main()
