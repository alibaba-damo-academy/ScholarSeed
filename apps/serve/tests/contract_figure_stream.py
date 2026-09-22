"""Deterministic direct-stream contracts for PDF figure explanation."""

from __future__ import annotations

import hashlib
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
from service.literature.api.analysis import register_analysis_routes
from service.literature.service.analysis import ActionKind, AnalysisRequest, PreparedAnalysis
from service.literature.service.figure import FigureActionService
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationStatus,
)


def decode_events(body: str) -> list[dict]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: ")
    ]


class FigureStreamContracts(unittest.IsolatedAsyncioTestCase):
    def test_detected_region_preparation_accepts_authoritative_rect(self):
        submitted_request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.FIGURE,
            page=1,
            region_id="r_detected",
            visual_kind="formula",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        prepared_request = submitted_request.model_copy(update={"rect": (0.1, 0.1, 0.5, 0.3)})
        prepared = PreparedAnalysis(
            prepared_request,
            "revision",
            "Paper",
            ("First",),
            Mock(),
            "crop",
        )
        indexes = Mock()
        service = FigureActionService(
            actions=Mock(),
            tasks=Mock(),
            repository=Mock(),
            pdf=Mock(),
            indexes=indexes,
        )

        with patch(
            "service.literature.service.figure.prepare", return_value=prepared
        ) as prepare_mock:
            result = service.prepare(submitted_request)

        self.assertEqual(result.request.rect, (0.1, 0.1, 0.5, 0.3))
        self.assertIs(prepare_mock.call_args.kwargs["indexes"], indexes)

    async def test_direct_stream_emits_prepared_delta_and_authoritative_result(self):
        payload = b"unchanged PDF source"
        revision = hashlib.sha256(payload).hexdigest()
        submitted_request = AnalysisRequest(
            literature_id="paper",
            model_key="selected",
            kind=ActionKind.FIGURE,
            page=2,
            region_id="r_detected",
            visual_kind="figure",
            instruction="先解释坐标轴，再说明趋势。",
            client_action_id="action",
            client_attempt_id="attempt",
        )
        request = submitted_request.model_copy(update={"rect": (0.1, 0.1, 0.5, 0.3)})
        compiled = CompiledAssistantAction(
            "literature.figure_explanation",
            "pdf-figure/v1",
            "instructions",
            "input",
            json_output=False,
        )
        prepared = PreparedAnalysis(
            request, revision, "Paper", ("First", "Second"), compiled, "crop"
        )
        record = AssistantInvocationRecord(
            invocation_id="invocation",
            owner_id="owner",
            client_action_id="action",
            client_attempt_id="attempt",
            retry_of_attempt_id=None,
            kind="complete",
            request_hash="hash",
            project_id="",
            source_id="paper",
            source_revision=revision,
            prompt_version="pdf-figure/v1",
            status=ModelInvocationStatus.COMPLETED,
            target_language="",
            model_key="selected",
            output_text="坐标轴表示时间与准确率。曲线整体上升。",
        )

        async def invoke(**kwargs):
            observer = kwargs["observer"]
            await observer(
                ModelInvocationEvent(
                    "invocation", ModelInvocationEventKind.OUTPUT_DELTA, "坐标轴表示时间"
                )
            )
            return record

        repository = Mock()
        repository.get.return_value = Mock(title="Paper")
        pdf = Mock()
        pdf.read.return_value = (payload, "application/pdf")
        tasks = AssistantInvocationStore(Path(tempfile.mkdtemp()) / "invocations.sqlite3")
        actions = Mock(invoke_compiled=AsyncMock(side_effect=invoke))
        service = FigureActionService(
            actions=actions,
            tasks=tasks,
            repository=repository,
            pdf=pdf,
        )
        app = FastAPI()
        models = Mock()
        models.inference_connection.return_value = {"image_input": True}
        with (
            patch("service.literature.api.analysis.request_user_id", return_value="owner"),
            patch.object(service, "prepare", return_value=prepared),
        ):
            register_analysis_routes(
                app,
                actions=actions,
                tasks=tasks,
                models=models,
                pdf=pdf,
                figures=service,
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/literature/ai/figure",
                    headers={"Accept": "text/event-stream"},
                    json=submitted_request.model_dump(mode="json"),
                )

        self.assertEqual(response.status_code, 200, response.text)
        events = decode_events(response.text)
        self.assertEqual(
            [event["type"] for event in events], ["prepared", "output_delta", "result"]
        )
        self.assertEqual(events[0]["crop"], "crop")
        self.assertEqual(events[1]["text"], "坐标轴表示时间")
        self.assertEqual(events[2]["result"]["output"], record.output_text)
        self.assertEqual(events[2]["result"]["source_revision"], revision)
        self.assertEqual(events[2]["result"]["page"], 2)
        self.assertEqual(events[2]["result"]["rect"], [0.1, 0.1, 0.5, 0.3])
        actions.invoke_compiled.assert_awaited_once()
        self.assertIsNotNone(actions.invoke_compiled.await_args.kwargs["observer"])
        pdf.read.assert_called_once_with(repository.get.return_value)

    async def test_figure_task_submission_is_rejected_in_favor_of_direct_stream(self):
        tasks = AssistantInvocationStore(Path(tempfile.mkdtemp()) / "invocations.sqlite3")
        app = FastAPI()
        with patch("service.literature.api.analysis.request_user_id", return_value="owner"):
            register_analysis_routes(
                app,
                actions=Mock(),
                tasks=tasks,
                models=Mock(),
                pdf=Mock(),
                figures=Mock(),
            )
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/literature/ai/tasks",
                    json=AnalysisRequest(
                        literature_id="paper",
                        model_key="selected",
                        kind=ActionKind.FIGURE,
                        rect=(0.1, 0.1, 0.5, 0.3),
                        client_action_id="action",
                        client_attempt_id="attempt",
                    ).model_dump(mode="json"),
                )

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"]["code"], "pdf_ai_figure_stream_required")


if __name__ == "__main__":
    unittest.main()
