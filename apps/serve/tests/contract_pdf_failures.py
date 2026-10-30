"""PDF AI failure descriptor HTTP/persistence contracts; no real-model acceptance."""

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI

from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import CompiledAssistantAction
from service.chat.service.models import SessionModelUnavailableError
from service.literature.api.analysis import register_analysis_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.analysis import (
    ActionKind,
    AnalysisErrorCode,
    AnalysisRequest,
    PreparedAnalysis,
)
from service.platform.activity import Activities
from service.platform.inference import ModelInvocationStatus


class PdfFailureContracts(unittest.IsolatedAsyncioTestCase):
    def prepared(self):
        request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.TRANSLATION,
            client_action_id="action",
            client_attempt_id="attempt",
        )
        return PreparedAnalysis(
            request,
            "revision",
            "paper",
            ("First page", "Second page"),
            CompiledAssistantAction("test", "v1", "test", "test"),
        )

    async def test_preflight_error_descriptors_keep_application_identity_and_raw_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = LiteratureRepository(Path(directory) / "literature.sqlite3")
            tasks = AssistantInvocationStore(Path(directory) / "invocations.sqlite3")
            models = Mock()
            models.inference_connection.return_value = {"pdf_input": True}
            app = FastAPI()
            payload = self.prepared().request.model_dump(mode="json")
            with (
                patch(
                    "service.literature.api.analysis.LiteratureRepository", return_value=repository
                ),
                patch("service.literature.api.analysis.request_user_id", return_value="owner"),
            ):
                register_analysis_routes(
                    app,
                    activities=Activities(),
                    actions=Mock(),
                    tasks=tasks,
                    models=models,
                    pdf=Mock(),
                )
                async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app), base_url="http://test"
                ) as client:
                    response = await client.post("/api/literature/ai/preflight", json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(
                        response.json()["detail"],
                        {"code": AnalysisErrorCode.LITERATURE_MISSING.value, "diagnostic": ""},
                    )
                    models.inference_connection.return_value = {}
                    response = await client.post("/api/literature/ai/preflight", json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(
                        response.json()["detail"]["code"],
                        AnalysisErrorCode.LITERATURE_MISSING.value,
                    )
                    models.inference_connection.side_effect = SessionModelUnavailableError(
                        "selected model is unavailable"
                    )
                    response = await client.post("/api/literature/ai/preflight", json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(
                        response.json()["detail"],
                        {"code": AnalysisErrorCode.MODEL_UNAVAILABLE.value, "diagnostic": ""},
                    )
                    # Identical Chinese text from an untyped external failure must stay a diagnostic.
                    diagnostic = "文献不存在，请重新打开文献。"
                    models.inference_connection.side_effect = ValueError(diagnostic)
                    response = await client.post("/api/literature/ai/preflight", json=payload)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(
                        response.json()["detail"],
                        {
                            "code": AnalysisErrorCode.PREPARATION_FAILED.value,
                            "diagnostic": diagnostic,
                        },
                    )
                    response = await client.get("/api/literature/ai/tasks/missing")
                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(
                        response.json()["detail"],
                        {"code": AnalysisErrorCode.TASK_MISSING.value, "diagnostic": ""},
                    )

    async def test_execution_errors_survive_http_events_and_store_reopen(self):
        # Contract-only invocation stubs; each case uses real temporary SQLite stores.
        cases = (
            (
                ModelInvocationStatus.COMPLETED,
                "",
                "",
                None,
                AnalysisErrorCode.TRANSLATION_LANGUAGE_INVALID.value,
                "",
            ),
            (
                ModelInvocationStatus.COMPLETED,
                "",
                "",
                RuntimeError("provider raw: 请求错误 <42>\nnext"),
                AnalysisErrorCode.EXECUTION_FAILED.value,
                "provider raw: 请求错误 <42>\nnext",
            ),
            (
                ModelInvocationStatus.FAILED,
                "",
                "provider failed verbatim",
                None,
                AnalysisErrorCode.GENERATION_FAILED.value,
                "provider failed verbatim",
            ),
            (
                ModelInvocationStatus.FAILED,
                "provider_capacity",
                "provider capacity verbatim",
                None,
                "provider_capacity",
                "provider capacity verbatim",
            ),
            (
                ModelInvocationStatus.CANCELLED,
                "",
                "",
                None,
                "",
                "",
            ),
            (
                ModelInvocationStatus.CANCELLED,
                "provider_cancelled",
                "provider cancellation verbatim",
                None,
                "provider_cancelled",
                "provider cancellation verbatim",
            ),
        )
        for status, code, detail, failure, expected_code, expected_detail in cases:
            with self.subTest(code=expected_code), tempfile.TemporaryDirectory() as directory:
                repository = LiteratureRepository(Path(directory) / "literature.sqlite3")
                database = Path(directory) / "invocations.sqlite3"
                tasks = AssistantInvocationStore(database)
                prepared = self.prepared()
                record = AssistantInvocationRecord(
                    invocation_id="invocation",
                    owner_id="owner",
                    client_action_id="action",
                    client_attempt_id="attempt",
                    retry_of_attempt_id=None,
                    kind="translation",
                    request_hash="request",
                    project_id="",
                    source_id="paper",
                    source_revision="revision",
                    prompt_version="v1",
                    status=status,
                    target_language="auto",
                    output_text="{}",
                    error_code=code,
                    error_detail=detail,
                )

                async def invoke(**kwargs):
                    saved, _ = tasks.claim(record)
                    if failure:
                        raise failure
                    return saved

                actions = Mock(invoke_compiled=AsyncMock(side_effect=invoke))
                models = Mock()
                models.inference_connection.return_value = {"pdf_input": True}
                app = FastAPI()
                with (
                    patch(
                        "service.literature.api.analysis.LiteratureRepository",
                        return_value=repository,
                    ),
                    patch("service.literature.api.analysis.request_user_id", return_value="owner"),
                    patch("service.literature.api.analysis.prepare", return_value=prepared),
                ):
                    register_analysis_routes(
                        app,
                        activities=Activities(),
                        actions=actions,
                        tasks=tasks,
                        models=models,
                        pdf=Mock(),
                    )
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as client:
                        response = await client.post(
                            "/api/literature/ai/tasks",
                            json=prepared.request.model_dump(mode="json"),
                        )
                        self.assertEqual(response.status_code, 202)

                        async def terminal():
                            while True:
                                response = await client.get("/api/literature/ai/tasks/attempt")
                                if response.json()["status"] not in ("pending", "running"):
                                    return response.json()
                                await asyncio.sleep(0)

                        snapshot = await asyncio.wait_for(terminal(), timeout=2)
                        expected_status = (
                            ModelInvocationStatus.FAILED
                            if status == ModelInvocationStatus.COMPLETED
                            else status
                        )
                        self.assertEqual(snapshot["status"], expected_status.value)
                        self.assertEqual(snapshot["error_code"], expected_code)
                        self.assertEqual(snapshot["error_detail"], expected_detail)
                        self.assertEqual(snapshot["error"], expected_detail or expected_code)
                        events = await client.get("/api/literature/ai/tasks/attempt/events")
                        self.assertEqual(
                            json.loads(events.text.removeprefix("data: ").strip()), snapshot
                        )
                    reopened = AssistantInvocationStore(database)
                    self.assertEqual(
                        reopened.get_attempt("attempt", "owner").error_code, expected_code
                    )
                    restored_app = FastAPI()
                    register_analysis_routes(
                        restored_app,
                        activities=Activities(),
                        actions=actions,
                        tasks=reopened,
                        models=models,
                        pdf=Mock(),
                    )
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=restored_app), base_url="http://test"
                    ) as client:
                        restored = await client.get("/api/literature/ai/tasks/attempt")
                        self.assertEqual(restored.json(), snapshot)


if __name__ == "__main__":
    unittest.main()
