"""Bridge continuations require a live turn and retain actual worker threads."""

from __future__ import annotations

import asyncio
import json
import tempfile
import threading
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx

from service.assistant.api.citations import register_citation_bridge
from service.chat.service.tasks import ProductTaskLease
from service.literature.api.acquire import register_acquire_routes
from service.literature.api.evidence import register_card_bridge
from service.literature.api.receipt import register_receipt_routes
from service.literature.api.result import register_result_routes
from service.literature.api.review import register_literature_review_routes
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import LITERATURE_ACQUIRE_ROUTE
from service.platform.context import ProductTaskType
from service.platform.http_activity import ServeApplication
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)
from service.resources.api.bridge import register_resource_bridge


async def eventually(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.005)


class BridgeDrainContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gate = Activities()
        self.turn = self.gate.enter(ActivityDomain.TURN)
        self.addCleanup(self.turn.close)
        self.live = SimpleNamespace(
            id="session",
            bridge_token="private",
            turn_activity=self.turn,
            project_id="project",
            ledger=SimpleNamespace(active_turn_id="turn"),
            publication_turn_id="turn",
            active_assistant_snapshot_id="snapshot",
            active_task_type="precise_search",
            active_product_turn_id="turn",
            product_turn_generation=1,
            runtime_workdir=Path(tempfile.gettempdir()),
            current_task=SimpleNamespace(done=lambda: False),
            active_task_lease=ProductTaskLease(
                task_type=ProductTaskType.PRECISE_SEARCH,
                turn_id="turn",
                generation=1,
                source="skill_run",
                workspace="run",
                run_id="run",
            ),
            publish=AsyncMock(),
        )
        self.sessions = SimpleNamespace(
            bridge_caller=lambda key: self.live if key == "session" else None
        )
        self.app = ServeApplication(activities=self.gate)
        self.headers = {BRIDGE_SESSION_HEADER: "session", BRIDGE_TOKEN_HEADER: "private"}
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)

    async def test_live_resource_bridge_continues_during_drain_but_expired_turn_cannot(self):
        content = Mock()
        content.external_roots.return_value = ()
        content.enumerate_resources.return_value = SimpleNamespace(entries=(), next_cursor=None)
        register_resource_bridge(self.app, self.sessions, content, activities=self.gate)
        generation = self.gate.begin()
        response = await self.client.post(
            "/api/internal/bridge/resource/list", json={}, headers=self.headers
        )
        self.assertEqual(response.status_code, 200)
        self.live.publish.assert_awaited_once()
        self.assertEqual(self.gate.snapshot().counts, {"turn": 1})
        self.turn.close()
        # The session resolver deliberately remains stale; a valid secret token
        # cannot resurrect the closed server-owned turn capability.
        response = await self.client.post(
            "/api/internal/bridge/resource/list", json={}, headers=self.headers
        )
        self.assertEqual(response.status_code, 503)
        content.enumerate_resources.assert_called_once()
        self.assertTrue(self.gate.seal(generation))

    async def test_invalid_bridge_token_never_admits_a_worker(self):
        content = Mock()
        register_resource_bridge(self.app, self.sessions, content, activities=self.gate)
        generation = self.gate.begin()
        response = await self.client.post(
            "/api/internal/bridge/resource/read",
            json={"path": "file"},
            headers={**self.headers, BRIDGE_TOKEN_HEADER: "wrong"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "bridge_access_denied")
        content.snapshot.assert_not_called()
        self.turn.close()
        self.assertTrue(self.gate.seal(generation))

    async def test_public_result_status_rejects_new_reads_and_retains_cancelled_worker(self):
        started, release = threading.Event(), threading.Event()

        def resolve(*args):
            started.set()
            release.wait(5)
            return {}

        register_result_routes(
            self.app, self.sessions, Mock(), Mock(resolve=resolve), activities=self.gate
        )
        with patch("service.literature.api.result.request_owner_id", return_value="owner"):
            pending = asyncio.create_task(
                self.client.post(
                    "/api/sessions/session/literature/result-status", json={"papers": []}
                )
            )
            await eventually(started.is_set)
            generation = self.gate.begin()
            self.turn.close()
            try:
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertFalse(self.gate.seal(generation))
                denied = await self.client.post(
                    "/api/sessions/session/literature/result-status", json={"papers": []}
                )
                self.assertEqual(denied.status_code, 503)
            finally:
                release.set()
                await eventually(lambda: not self.gate.snapshot().counts)
            self.assertTrue(self.gate.seal(generation))

    async def test_literature_preparation_threads_survive_cancelled_bridge_waiters(self):
        cases = (
            (
                "result",
                "/api/internal/bridge/literature/result",
                {"run": "run"},
                "service.literature.api.result.prepare_result",
            ),
            (
                "review",
                "/api/internal/bridge/literature/review",
                {"workspace": "review", "checkpoint": "outline"},
                "service.literature.api.review.prepare_review",
            ),
            (
                "card",
                "/api/internal/bridge/pdf/register-card",
                {"ref_id": "literature:paper", "path": "paper.json"},
                "service.literature.api.evidence.prepare_bundle",
            ),
            ("citation", "/api/internal/bridge/pdf/read", {"ref_id": "literature:paper"}, None),
        )
        for kind, route, payload, target in cases:
            with self.subTest(kind=kind):
                gate = Activities()
                turn = gate.enter(ActivityDomain.TURN)
                live = SimpleNamespace(
                    **{
                        **vars(self.live),
                        "turn_activity": turn,
                        "runtime_workdir": Path(tempfile.gettempdir()),
                        "active_task_type": "",
                    }
                )
                sessions = SimpleNamespace(
                    bridge_caller=lambda key, live=live: live if key == live.id else None
                )
                app = ServeApplication(activities=gate)
                started, release = threading.Event(), threading.Event()

                def prepare(*args, started=started, release=release, **kwargs):
                    started.set()
                    release.wait(5)
                    return {}

                if kind == "result":
                    register_result_routes(app, sessions, Mock(), Mock(), activities=gate)
                elif kind == "review":
                    register_literature_review_routes(app, sessions, activities=gate)
                elif kind == "card":
                    register_card_bridge(app, sessions, activities=gate)
                else:
                    register_citation_bridge(app, sessions, Mock(query=prepare), activities=gate)
                with (
                    patch(target, side_effect=prepare) if target else nullcontext(),
                    patch(
                        "service.literature.api.evidence.LiteratureRepository.get",
                        return_value=SimpleNamespace(title="Paper"),
                    ),
                ):
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        generation = gate.begin()
                        pending = asyncio.create_task(
                            client.post(route, json=payload, headers=self.headers)
                        )
                        try:
                            await eventually(started.is_set)
                            turn.close()
                            pending.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await pending
                            self.assertFalse(gate.seal(generation))
                        finally:
                            release.set()
                            turn.close()
                            await asyncio.gather(pending, return_exceptions=True)
                            await eventually(lambda gate=gate: not gate.snapshot().counts)
                        self.assertTrue(gate.seal(generation))

    async def test_receipt_body_cannot_switch_to_a_later_turn(self):
        register_receipt_routes(self.app, self.sessions, Mock(), activities=self.gate)

        async def body():
            self.live.publication_turn_id = "later-turn"
            self.live.active_assistant_snapshot_id = "later-snapshot"
            yield b'{"run":"run"}'

        with patch("service.literature.api.receipt.issue_receipt") as issue:
            response = await self.client.post(
                "/api/internal/bridge/literature/receipt", headers=self.headers, content=body()
            )
            self.assertEqual(response.status_code, 403)
            issue.assert_not_called()

    async def test_acquisition_body_cannot_switch_authority_to_a_later_turn(self):
        receiving, release = asyncio.Event(), asyncio.Event()
        authorizer = Mock()
        register_acquire_routes(self.app, self.sessions, authorizer, activities=self.gate)

        async def body():
            receiving.set()
            await release.wait()
            yield json.dumps(
                {
                    "run": "run",
                    "papers": [
                        {
                            "paper_id": "paper",
                            "identifier": "2401.00001",
                            "identifier_kind": "arxiv",
                        }
                    ],
                }
            ).encode()

        with patch("service.literature.api.acquire.acquire_fulltexts") as acquire:
            pending = asyncio.create_task(
                self.client.post(LITERATURE_ACQUIRE_ROUTE, headers=self.headers, content=body())
            )
            await receiving.wait()
            self.live.publication_turn_id = "later-turn"
            self.live.active_assistant_snapshot_id = "later-snapshot"
            release.set()
            response = await pending
            self.assertEqual(response.status_code, 403)
            authorizer.require.assert_not_called()
            acquire.assert_not_called()

    async def test_cancelled_acquisition_waiter_holds_thread_after_turn_end(self):
        self.live.active_task_type = ProductTaskType.RESEARCH_IDEA.value
        started, release = threading.Event(), threading.Event()
        authorizer = Mock()
        authorizer.effective_scope.return_value = SimpleNamespace(
            allowed=("paper:paper",), grants={"paper:paper": "grant"}
        )
        register_acquire_routes(self.app, self.sessions, authorizer, activities=self.gate)
        with tempfile.TemporaryDirectory(prefix="bridge-acquire-") as directory:
            receipt = Path(directory) / "receipt"

            def acquire(papers, *, scope):
                # Research-idea uses its verified workspace binding, rather than
                # a source-grant version. Authorization is still checked first.
                authorizer.require.assert_called_once()
                self.assertEqual(scope.authorizations, {"paper": ""})
                started.set()
                release.wait(5)
                receipt.write_text(papers[0].paper_id, encoding="utf-8")
                return SimpleNamespace(payload=lambda: {"ok": True})

            with patch("service.literature.api.acquire.acquire_fulltexts", side_effect=acquire):
                generation = self.gate.begin()
                pending = asyncio.create_task(
                    self.client.post(
                        LITERATURE_ACQUIRE_ROUTE,
                        headers=self.headers,
                        json={
                            "run": "run",
                            "papers": [
                                {
                                    "paper_id": "paper",
                                    "identifier": "2401.00001",
                                    "identifier_kind": "arxiv",
                                }
                            ],
                        },
                    )
                )
                await eventually(started.is_set)
                try:
                    self.turn.close()
                    pending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await pending
                    self.assertFalse(self.gate.seal(generation))
                    authorizer.require.assert_called_once()
                    self.assertFalse(receipt.exists())
                finally:
                    release.set()
                    await eventually(lambda: not self.gate.snapshot().counts)
                self.assertEqual(receipt.read_text(), "paper")
                self.assertTrue(self.gate.seal(generation))


if __name__ == "__main__":
    unittest.main()
