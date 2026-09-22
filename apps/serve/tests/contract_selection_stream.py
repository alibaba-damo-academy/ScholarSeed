"""Deterministic stream ordering, cancellation and projection contracts."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi.responses import StreamingResponse

from scholarseed_runtime.contract import DeliveryClass, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome
from service.assistant.api.stream import action_stream as selection_stream
from service.assistant.persistence.invocations import AssistantInvocationStore
from service.assistant.service.actions import AssistantActionService, CompiledAssistantAction
from service.chat.service.inference import AgentOneShotProvider
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationLimits,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
)


class SelectionStreamContract(unittest.IsolatedAsyncioTestCase):
    async def test_asgi_disconnect_cleans_execution_even_if_interrupt_raises(self):
        started = asyncio.Event()
        finished = asyncio.Event()

        class Selection:
            async def execute(self, command, *, observer):
                try:
                    await observer(ModelInvocationEvent("id", ModelInvocationEventKind.ACCEPTED))
                    await asyncio.Event().wait()
                finally:
                    finished.set()

            async def cancel(self, **kwargs):
                raise RuntimeError("transport gone")

        async def send(message):
            if message["type"] == "http.response.body":
                started.set()

        async def receive():
            await started.wait()
            return {"type": "http.disconnect"}

        response = StreamingResponse(
            selection_stream(Selection(), SimpleNamespace(owner_id="owner"))
        )
        await asyncio.wait_for(
            response({"type": "http", "asgi": {"spec_version": "2.0"}}, receive, send), timeout=2
        )
        self.assertTrue(finished.is_set())

    async def test_stream_delivers_delta_before_final_result(self):
        finish = asyncio.Event()

        class Selection:
            async def execute(self, command, *, observer):
                await observer(
                    ModelInvocationEvent("id", ModelInvocationEventKind.OUTPUT_DELTA, "partial")
                )
                await finish.wait()
                return ModelInvocationResult(
                    "id", ModelInvocationStatus.COMPLETED, output_text="final"
                )

        stream = selection_stream(Selection(), SimpleNamespace(owner_id="owner"))
        first = await asyncio.wait_for(anext(stream), timeout=2)
        self.assertEqual(json.loads(first.removeprefix("data: ").strip())["text"], "partial")
        finish.set()
        final = await anext(stream)
        self.assertEqual(
            json.loads(final.removeprefix("data: ").strip())["result"]["output_text"], "final"
        )
        await stream.aclose()

    async def test_disconnect_requests_owned_stop_and_drains_until_terminal(self):
        stopped = asyncio.Event()
        cancel = AsyncMock(side_effect=lambda **kwargs: stopped.set())

        class Selection:
            async def execute(self, command, *, observer):
                await observer(ModelInvocationEvent("id", ModelInvocationEventKind.ACCEPTED))
                await stopped.wait()
                return ModelInvocationResult("id", ModelInvocationStatus.CANCELLED)

        selection = Selection()
        selection.cancel = cancel
        stream = selection_stream(selection, SimpleNamespace(owner_id="owner"))
        await anext(stream)
        await asyncio.wait_for(stream.aclose(), timeout=2)
        cancel.assert_awaited_once_with(invocation_id="id", owner_id="owner")

    async def test_provider_only_streams_final_assistant_and_keeps_large_text(self):
        observed = []
        text = "中文" * 2000

        async def invoke_once(**kwargs):
            observer = kwargs["observer"]
            for index, (role, phase, value) in enumerate(
                (
                    ("reasoning", "", "secret"),
                    ("assistant", "commentary", "planning"),
                    ("assistant", "final_answer", text),
                )
            ):
                await observer(
                    RuntimeEvent(
                        schema_version=1,
                        event_id=str(index),
                        runtime_id="test",
                        product_session_id="id",
                        native_session_id="native",
                        process_generation=1,
                        sequence=index,
                        kind=RuntimeEventKind.CONTENT_DELTA,
                        delivery=DeliveryClass.COALESCIBLE,
                        observed_at="now",
                        payload={"role": role, "phase": phase, "text": value},
                    )
                )
            return SimpleNamespace(
                model_key="model",
                turn=SimpleNamespace(
                    outcome=RuntimeTurnOutcome.COMPLETED,
                    final_text=text,
                    input_tokens=1,
                    output_tokens=1,
                    native_turn_id="turn",
                ),
            )

        async def observe(event):
            observed.append(event)

        provider = AgentOneShotProvider(
            SimpleNamespace(invoke_once=invoke_once),
            SimpleNamespace(runtime_executable=lambda: "codex"),
            AsyncMock(return_value={}),
        )
        result = await provider.invoke(
            ModelInvocationRequest(
                invocation_id="id",
                owner_id="owner",
                project_id="project",
                purpose="translate",
                model_key="",
                instructions="translate",
                input_text="input",
                limits=ModelInvocationLimits(100, 100),
            ),
            observer=observe,
        )
        self.assertEqual([event.text for event in observed], [text])
        self.assertEqual(result.output_text, text)

    async def test_early_stop_is_owned_latched_and_replay_does_not_invoke(self):
        reached_start = asyncio.Event()
        finish = asyncio.Event()
        events = []

        class Provider:
            calls = 0
            cancels = 0

            def available(self):
                return True

            async def invoke(self, request, *, observer=None):
                self.calls += 1
                await observer(
                    ModelInvocationEvent(request.invocation_id, ModelInvocationEventKind.STARTED)
                )
                reached_start.set()
                await finish.wait()
                return ModelInvocationResult(request.invocation_id, ModelInvocationStatus.CANCELLED)

            async def cancel(self, **kwargs):
                self.cancels += 1
                return ModelInvocationResult(kwargs["invocation_id"], ModelInvocationStatus.RUNNING)

        with tempfile.TemporaryDirectory() as directory:
            provider = Provider()
            service = AssistantActionService(
                AssistantInvocationStore(Path(directory) / "actions.db"), model=provider
            )

            async def observe(event):
                events.append(event)
                if event.kind is ModelInvocationEventKind.ACCEPTED:
                    self.assertFalse(
                        await service.cancel(invocation_id=event.invocation_id, owner_id="other")
                    )
                    self.assertTrue(
                        await service.cancel(invocation_id=event.invocation_id, owner_id="owner")
                    )

            arguments = dict(
                owner_id="owner",
                client_action_id="action",
                client_attempt_id="attempt",
                retry_of_attempt_id=None,
                project_id="project",
                source_id="source",
                source_revision="rev",
                evidence_hash="hash",
                compiled=CompiledAssistantAction("test", "v1", "instructions", "text"),
            )
            task = asyncio.create_task(service.invoke_compiled(**arguments, observer=observe))
            await asyncio.wait_for(reached_start.wait(), timeout=2)
            self.assertGreaterEqual(provider.cancels, 2)
            self.assertEqual(
                service.get(events[0].invocation_id, "owner").status, ModelInvocationStatus.RUNNING
            )
            finish.set()
            result = await task
            self.assertEqual(result.status, ModelInvocationStatus.CANCELLED)
            replay = await service.invoke_compiled(**arguments, observer=observe)
            self.assertEqual(replay.invocation_id, result.invocation_id)
            self.assertEqual(provider.calls, 1)


if __name__ == "__main__":
    unittest.main()
