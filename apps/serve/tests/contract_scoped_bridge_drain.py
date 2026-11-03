"""Scoped bridge lifetime and cross-turn authorization contracts, not acceptance."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx

from service.capabilities.api.admission import register_skill_admission
from service.chat.api.artifacts import register_artifact_routes
from service.chat.api.cards import register_card_routes
from service.chat.api.history import register_history_routes
from service.chat.api.plan import register_plan_routes
from service.chat.api.tasks import register_task_routes
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.runtime.live import LiveSession
from service.platform.activity import Activities, ActivityDomain
from service.platform.http_activity import ServeApplication
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

PREFIX = "/api/internal/bridge/"


class ScopedBridgeDrainContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.script = self.root / "run.py"
        self.script.write_text("pass", encoding="utf-8")
        self.activities = Activities()
        self.owner = self.activities.enter(ActivityDomain.TURN)
        self.addCleanup(self.owner.close)
        self.live = SimpleNamespace(
            id="session",
            bridge_token="private",
            turn_activity=self.owner,
            bridge_activity=self.owner,
            publication_turn_id="turn",
            user_id="owner",
            ledger=SimpleNamespace(active_turn_id="turn"),
            active_assistant_snapshot_id="snapshot",
            active_product_turn_id="turn",
            product_turn_generation=1,
            task_lease_revision=0,
            active_task_lease=None,
            active_task_type="",
            runtime_workdir=self.root,
            current_task=SimpleNamespace(done=lambda: False),
            interrupting=False,
            terminating=False,
            terminated=False,
            publish=AsyncMock(),
            publish_artifact=AsyncMock(return_value={"id": "artifact"}),
            display_card=AsyncMock(return_value={"id": "card"}),
            plans=SimpleNamespace(current=lambda: {"items": []}),
            skill_state_by_name=AsyncMock(return_value=None),
            set_task_lease=Mock(
                side_effect=lambda lease: LiveSession.set_task_lease(self.live, lease)
            ),
            clear_task_lease=Mock(side_effect=lambda: LiveSession.clear_task_lease(self.live)),
        )
        self.live.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.live.catalog.register(
            self.live.id,
            SessionPrincipal(self.live.user_id),
            runtime_id="codex",
            vendor_thread_id="native-session",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "output"),
            codex_version=None,
            model_id=None,
            policy_id=None,
            status=SessionStatus.READY,
            title="Scoped bridge contract",
            created_at=1,
        )
        self.sessions = SimpleNamespace(
            bridge_caller=lambda key: self.live if key == "session" else None
        )
        self.history = SimpleNamespace(query=Mock(return_value={"items": []}))
        self.scope = SimpleNamespace(history_scope=Mock(return_value=object()))
        self.runtime = SimpleNamespace(
            skill_admission=AsyncMock(return_value={"name": "skill", "active": True})
        )
        self.app = ServeApplication(activities=self.activities)
        register_history_routes(
            self.app, self.sessions, self.history, self.scope, activities=self.activities
        )
        register_plan_routes(self.app, self.sessions, activities=self.activities)
        register_task_routes(self.app, self.sessions, activities=self.activities)
        register_artifact_routes(self.app, self.sessions.bridge_caller, activities=self.activities)
        register_card_routes(self.app, self.sessions.bridge_caller, activities=self.activities)
        register_skill_admission(
            self.app, self.sessions.bridge_caller, self.runtime, activities=self.activities
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)
        self.headers = {BRIDGE_SESSION_HEADER: "session", BRIDGE_TOKEN_HEADER: "private"}

    def switch_turn(self):
        self.owner.close()
        self.owner = self.activities.enter(ActivityDomain.TURN, root=True)
        self.addCleanup(self.owner.close)
        self.live.turn_activity = self.live.bridge_activity = self.owner
        self.live.active_product_turn_id = self.live.publication_turn_id = "next-turn"
        self.live.product_turn_generation += 1
        self.live.ledger.active_turn_id = "next-turn"

    def task_payload(self):
        return {
            "task_type": "literature_review",
            "skill_name": "literature-review",
            "skill_version": "1",
            "skill_path": str(self.root),
            "workspace": "survey",
        }

    async def test_admitted_scopes_continue_during_drain_and_expired_scopes_cannot(self):
        generation = self.activities.begin()
        requests = [
            ("history/search", {"query": "method"}),
            ("plan/get", {}),
            ("artifact/publish", {"path": "report.md", "role": "final"}),
            ("display-card", {"type": "example", "content": {"data": {}}}),
            ("skill/admit", {"path": str(self.script)}),
        ]
        for route, body in requests:
            with self.subTest(route=route):
                response = await self.client.post(PREFIX + route, json=body, headers=self.headers)
                self.assertEqual(response.status_code, 200, response.text)
        self.owner.close()
        for route, body in requests + [("task/activate", self.task_payload())]:
            with self.subTest(expired=route):
                response = await self.client.post(PREFIX + route, json=body, headers=self.headers)
                self.assertEqual(response.status_code, 503, response.text)
        self.assertTrue(self.activities.seal(generation))

    async def test_body_cannot_switch_history_plan_publication_skill_or_task_authority(self):
        for route, body in [
            ("history/search", {"query": "method"}),
            ("plan/get", {}),
            ("artifact/publish", {"path": "report.md", "role": "final"}),
            ("display-card", {"type": "example", "content": {"data": {}}}),
            ("skill/admit", {"path": str(self.script)}),
            ("task/activate", self.task_payload()),
        ]:

            async def chunks(body=body):
                self.switch_turn()
                yield json.dumps(body).encode()

            with self.subTest(route=route):
                response = await self.client.post(
                    PREFIX + route, content=chunks(), headers=self.headers
                )
                self.assertIn(response.status_code, (400, 403), response.text)
        self.history.query.assert_not_called()
        self.live.publish_artifact.assert_not_awaited()
        self.live.display_card.assert_not_awaited()
        self.runtime.skill_admission.assert_not_awaited()
        self.live.skill_state_by_name.assert_not_awaited()
        self.live.set_task_lease.assert_not_called()

    async def test_task_inventory_wait_cannot_install_a_lease_for_the_next_turn(self):
        async def identity(*args, **kwargs):
            self.switch_turn()
            return {"name": "literature-review", "path": str(self.script), "version": "1"}

        self.live.skill_state_by_name.side_effect = identity
        response = await self.client.post(
            PREFIX + "task/activate", json=self.task_payload(), headers=self.headers
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["reason"], "task_context_stale")
        self.live.set_task_lease.assert_not_called()

    async def test_skill_inventory_wait_cannot_grant_access_to_the_next_turn(self):
        async def admission(**kwargs):
            self.switch_turn()
            return {"name": "skill", "active": True}

        self.runtime.skill_admission.side_effect = admission
        response = await self.client.post(
            PREFIX + "skill/admit", json={"path": str(self.script)}, headers=self.headers
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "skill_access_denied")

    def prepare_task_binding(self):
        workspace = self.root / "survey"
        workspace.mkdir()
        (workspace / ".slr-binding.json").write_text(
            json.dumps(
                {
                    "skill": str(self.root.resolve()),
                    "version": "1",
                    "run_id": "run",
                }
            ),
            encoding="utf-8",
        )
        self.live.skill_state_by_name.return_value = {
            "path": str(self.script),
            "version": "1",
            "active": True,
        }

    async def test_task_activation_can_finish_during_drain_under_its_original_turn(self):
        self.prepare_task_binding()
        generation = self.activities.begin()
        response = await self.client.post(
            PREFIX + "task/activate", json=self.task_payload(), headers=self.headers
        )
        self.assertEqual(response.status_code, 200, response.text)
        lease = self.live.set_task_lease.call_args.args[0]
        self.assertEqual(lease.turn_id, "turn")
        self.assertEqual(lease.generation, 1)
        self.owner.close()
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_task_activation_keeps_its_binding_write_admitted(self):
        self.prepare_task_binding()
        entered, release = asyncio.Event(), asyncio.Event()

        async def identity(*_args, **_kwargs):
            entered.set()
            await release.wait()
            return {"path": str(self.script), "version": "1", "active": True}

        self.live.skill_state_by_name.side_effect = identity
        request = asyncio.create_task(
            self.client.post(
                PREFIX + "task/activate", json=self.task_payload(), headers=self.headers
            )
        )
        try:
            await asyncio.wait_for(entered.wait(), 3)
            generation = self.activities.begin()
            self.owner.close()
            request.cancel()
            await asyncio.sleep(0.02)
            request.cancel()
            self.assertFalse(request.done())
            self.assertFalse(self.activities.seal(generation))
            self.assertIsNone(self.live.catalog.task_binding(self.live.id))
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
        self.assertEqual(self.live.catalog.task_binding(self.live.id)["command"]["run_id"], "run")
        self.live.set_task_lease.assert_called_once()
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_skill_inspection_keeps_its_actual_operation_admitted(self):
        entered, release = asyncio.Event(), asyncio.Event()

        async def admission(**kwargs):
            entered.set()
            await release.wait()
            return {"name": "skill", "active": True}

        self.runtime.skill_admission.side_effect = admission
        request = asyncio.create_task(
            self.client.post(
                PREFIX + "skill/admit", json={"path": str(self.script)}, headers=self.headers
            )
        )
        try:
            await asyncio.wait_for(entered.wait(), 3)
            generation = self.activities.begin()
            self.owner.close()
            request.cancel()
            await asyncio.sleep(0.02)
            self.assertFalse(request.done())
            self.assertFalse(self.activities.seal(generation))
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
        self.assertTrue(self.activities.seal(generation))

    async def test_cancelled_publication_retains_actual_thread_until_it_finishes(self):
        entered, release = threading.Event(), threading.Event()

        def worker():
            entered.set()
            if not release.wait(5):
                raise AssertionError("publication release timed out")
            return {"id": "artifact"}

        async def publish(*args, **kwargs):
            return await asyncio.to_thread(worker)

        self.live.publish_artifact.side_effect = publish
        request = asyncio.create_task(
            self.client.post(
                PREFIX + "artifact/publish",
                json={"path": "report.md", "role": "final"},
                headers=self.headers,
            )
        )
        try:
            async with asyncio.timeout(3):
                while not entered.is_set():
                    await asyncio.sleep(0.005)
            generation = self.activities.begin()
            self.owner.close()
            request.cancel()
            await asyncio.sleep(0.02)
            request.cancel()
            self.assertFalse(request.done())
            self.assertFalse(self.activities.seal(generation))
        finally:
            release.set()
            await asyncio.gather(request, return_exceptions=True)
        self.assertTrue(self.activities.seal(generation))


if __name__ == "__main__":
    unittest.main()
