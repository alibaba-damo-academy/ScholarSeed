"""PDF preparation and background publication retain actual execution ownership."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx

from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import CompiledAssistantAction
from service.literature.api.analysis import register_analysis_routes
from service.literature.persistence.store import LiteratureRepository, connect
from service.literature.service.analysis import ActionKind, AnalysisRequest, PreparedAnalysis
from service.platform.activity import Activities, ActivityDomain
from service.platform.http_activity import ServeApplication
from service.platform.inference import ModelInvocationStatus


async def eventually(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.005)


class AnalysisDrainContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="analysis-drain-")
        self.addCleanup(self.home.cleanup)
        self.gate = Activities()
        self.app = ServeApplication(activities=self.gate)
        self.app.state.auth_enabled = False
        self.app.state.ownership_axis = "machine"
        self.repository = LiteratureRepository(Path(self.home.name) / "literature.sqlite3")
        self.tasks = AssistantInvocationStore(Path(self.home.name) / "invocations.sqlite3")
        self.actions = Mock()
        self.models = Mock()
        self.models.inference_connection.return_value = {"image_input": True}
        self.request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.EXPLANATION,
            text="source",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        self.source = b"source"
        self.prepared = PreparedAnalysis(
            self.request,
            hashlib.sha256(self.source).hexdigest(),
            "Paper",
            ("source",),
            CompiledAssistantAction("test", "v1", "instructions", "input"),
        )
        for patcher in (
            patch(
                "service.literature.api.analysis.LiteratureRepository", return_value=self.repository
            ),
            patch("service.literature.api.analysis.request_user_id", return_value="owner"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        register_analysis_routes(
            self.app,
            activities=self.gate,
            actions=self.actions,
            tasks=self.tasks,
            models=self.models,
            pdf=Mock(),
        )
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app), base_url="http://test"
        )
        self.addAsyncCleanup(self.client.aclose)

    def test_preparation_lookup_closes_database_connection(self):
        connection = connect(self.repository.database)
        with patch("service.literature.persistence.store.connect", return_value=connection):
            self.assertIsNone(self.repository.get("missing"))
        with self.assertRaises(sqlite3.ProgrammingError):
            connection.execute("SELECT 1")

    async def test_cancelled_preflight_retains_preparation_and_rejects_new_work(self):
        started, release = threading.Event(), threading.Event()

        def prepare(*args, **kwargs):
            started.set()
            release.wait(5)
            return self.prepared

        with patch("service.literature.api.analysis.prepare", side_effect=prepare):
            pending = asyncio.create_task(
                self.client.post(
                    "/api/literature/ai/preflight", json=self.request.model_dump(mode="json")
                )
            )
            await eventually(started.is_set)
            generation = self.gate.begin()
            try:
                pending.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await pending
                self.assertFalse(self.gate.seal(generation))
                for endpoint in ("preflight", "tasks", "figure"):
                    response = await self.client.post(
                        f"/api/literature/ai/{endpoint}", json=self.request.model_dump(mode="json")
                    )
                    self.assertEqual(response.status_code, 503)
                self.models.inference_connection.assert_called_once()
            finally:
                release.set()
                await eventually(lambda: not self.gate.snapshot().counts)
            self.assertTrue(self.gate.seal(generation))

    async def test_admitted_preparation_can_start_worker_during_drain_and_cancel_read_thread(self):
        started, release = threading.Event(), threading.Event()
        reading, finish_read = threading.Event(), threading.Event()

        def prepare(*args, **kwargs):
            started.set()
            release.wait(5)
            return self.prepared

        def read_source(*args, **kwargs):
            reading.set()
            finish_read.wait(5)
            return self.source, "Paper"

        async def invoke(**kwargs):
            # Simulates a nested execution owner, which must inherit the live
            # workflow capability even after preparation's HTTP response ends.
            with self.gate.enter(ActivityDomain.ACTION):
                record = AssistantInvocationRecord(
                    invocation_id="invocation",
                    owner_id="owner",
                    client_action_id="action",
                    client_attempt_id="attempt",
                    retry_of_attempt_id=None,
                    kind="test",
                    request_hash="hash",
                    project_id="",
                    source_id="paper",
                    source_revision=self.prepared.revision,
                    prompt_version="v1",
                    status=ModelInvocationStatus.COMPLETED,
                    target_language="",
                    model_key="selected",
                    output_text='{"text":"explanation","evidence":[{"page":1,"quote":"source"}]}',
                )
                self.tasks.claim(record)
                return record

        self.actions.invoke_compiled = AsyncMock(side_effect=invoke)
        self.actions.cancel = AsyncMock(return_value=True)
        with (
            patch("service.literature.api.analysis.prepare", side_effect=prepare),
            patch("service.literature.api.analysis.read_source", side_effect=read_source),
        ):
            pending = asyncio.create_task(
                self.client.post(
                    "/api/literature/ai/tasks", json=self.request.model_dump(mode="json")
                )
            )
            await eventually(started.is_set)
            generation = self.gate.begin()
            try:
                release.set()
                response = await pending
                self.assertEqual(response.status_code, 202)
                await eventually(reading.is_set)
                self.assertFalse(self.gate.seal(generation))
                cancelled = await self.client.post("/api/literature/ai/tasks/attempt/cancel")
                self.assertEqual(cancelled.status_code, 200)
                self.assertEqual(cancelled.json()["status"], "cancelled")
                self.assertFalse(self.gate.seal(generation))
            finally:
                release.set()
                finish_read.set()
                await eventually(lambda: not self.gate.snapshot().counts)
            self.assertTrue(self.gate.seal(generation))
            self.assertEqual(
                self.tasks.get_attempt("attempt", "owner").status, ModelInvocationStatus.CANCELLED
            )


if __name__ == "__main__":
    unittest.main()
