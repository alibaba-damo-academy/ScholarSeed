"""Contracts for non-session model invocation and translation."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from contextlib import closing
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.assistant.api.routes import register_assistant_routes
from service.assistant.domain.language import TRANSLATION_TARGET_CODES
from service.assistant.persistence.invocations import (
    ASSISTANT_INVOCATION_TABLE,
    AssistantInvocationConflictError,
    AssistantInvocationStore,
)
from service.assistant.service.actions import (
    ACTION_RUNTIME_UNAVAILABLE,
    ONE_SHOT_PROMPT_VERSION,
    TRANSLATE_PROMPT_VERSION,
    AssistantActionService,
    AssistantInvocationRequest,
    AssistantTranslationRequest,
    TranslationCompiler,
)
from service.chat.persistence.catalog import SESSION_CATALOG_TABLE, SessionCatalogStore
from service.platform.activity import Activities, MaintenanceActive
from service.platform.inference import (
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
    ModelInvocationUsage,
)

SOURCE_TEXT = "The stable source nonce is action-47."


class OneShotProvider:
    def __init__(self) -> None:
        self.requests: list[ModelInvocationRequest] = []

    def available(self) -> bool:
        return True

    async def invoke(self, request: ModelInvocationRequest) -> ModelInvocationResult:
        self.requests.append(request)
        return ModelInvocationResult(
            invocation_id=request.invocation_id,
            status=ModelInvocationStatus.COMPLETED,
            model_key="contract-model",
            output_text="稳定来源随机值是 action-47。",
            usage=ModelInvocationUsage(input_tokens=9, output_tokens=7, receipt_id="receipt-1"),
        )

    async def cancel(self, *, invocation_id: str, owner_id: str) -> ModelInvocationResult:
        del owner_id
        return ModelInvocationResult(
            invocation_id=invocation_id,
            status=ModelInvocationStatus.CANCELLED,
        )


def translation_request(
    *,
    attempt: str = "attempt-1",
    text: str = SOURCE_TEXT,
    target: str = "zh-CN",
) -> AssistantTranslationRequest:
    return AssistantTranslationRequest(
        owner_id="local",
        client_action_id="action-1",
        client_attempt_id=attempt,
        retry_of_attempt_id=None,
        project_id="project-1",
        text=text,
        target_language=target,
        source_id="notes/evidence.md",
        source_revision="sha256:" + "1" * 64,
    )


class AssistantActionContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-action-")
        self.database = Path(self.temporary.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.store = AssistantInvocationStore(self.database)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_drain_waits_for_translation_result_and_rejects_new_attempt(self) -> None:
        async def scenario() -> None:
            gate = Activities()
            entered, release = asyncio.Event(), asyncio.Event()
            model = OneShotProvider()
            invoke = model.invoke

            async def waiting(request):
                entered.set()
                await release.wait()
                return await invoke(request)

            model.invoke = waiting
            cancel = model.cancel
            cancel_counts = []

            async def cancelling(**kwargs):
                cancel_counts.append(gate.snapshot().counts)
                return await cancel(**kwargs)

            model.cancel = cancelling
            service = AssistantActionService(self.store, activities=gate, model=model)
            task = asyncio.create_task(service.translate(translation_request()))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                generation = gate.begin()
                self.assertEqual(gate.snapshot().counts, {"action": 1})
                self.assertFalse(gate.seal(generation))
                with self.assertRaises(MaintenanceActive):
                    await service.translate(translation_request(attempt="during-drain"))
                self.assertIsNone(self.store.get_attempt("during-drain", "local"))
                running = self.store.get_attempt("attempt-1", "local")
                self.assertFalse(
                    await service.cancel(invocation_id=running.invocation_id, owner_id="other")
                )
                self.assertTrue(
                    await service.cancel(invocation_id=running.invocation_id, owner_id="local")
                )
                self.assertEqual(cancel_counts, [{"action": 2}])
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            result = await task
            self.assertEqual(service.get(result.invocation_id, "local"), result)
            self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
            self.assertEqual(len(model.requests), 1)
            self.assertTrue(gate.seal(generation))

        asyncio.run(scenario())

    def test_translation_is_idempotent_and_does_not_create_a_session(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, activities=Activities(), model=model)

        first = asyncio.run(service.translate(translation_request()))
        replay = asyncio.run(service.translate(translation_request()))

        self.assertEqual(first.status, ModelInvocationStatus.COMPLETED)
        self.assertEqual(first, replay)
        self.assertEqual(first.prompt_version, TRANSLATE_PROMPT_VERSION)
        self.assertEqual(len(model.requests), 1)
        self.assertEqual(model.requests[0].input_text, SOURCE_TEXT)
        self.assertIn("detect the source language", model.requests[0].instructions.lower())
        self.assertIn("Simplified Chinese", model.requests[0].instructions)
        self.assertEqual(model.requests[0].project_id, "project-1")
        self.assertEqual(first.receipt_id, "receipt-1")
        with closing(sqlite3.connect(self.database)) as connection:
            session_count = connection.execute(
                f"SELECT COUNT(*) FROM {SESSION_CATALOG_TABLE}"
            ).fetchone()[0]
            persisted = connection.execute(f"SELECT * FROM {ASSISTANT_INVOCATION_TABLE}").fetchone()
        self.assertEqual(session_count, 0)
        self.assertIsNotNone(persisted)
        self.assertNotIn(SOURCE_TEXT, self.database.read_bytes().decode("utf-8", errors="ignore"))

    def test_translation_catalog_compiles_every_supported_target(self) -> None:
        compiler = TranslationCompiler()

        compiled = {
            code: compiler.compile(source_text=SOURCE_TEXT, target_language=code)
            for code in TRANSLATION_TARGET_CODES
        }

        self.assertGreaterEqual(len(compiled), 18)
        self.assertIn("ja", compiled)
        self.assertIn("Arabic", compiled["ar"].instructions)
        self.assertTrue(all(item.source_language == "auto" for item in compiled.values()))

    def test_generic_invocation_uses_the_same_durable_non_session_path(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, activities=Activities(), model=model)
        record = asyncio.run(
            service.complete(
                AssistantInvocationRequest(
                    owner_id="local",
                    client_action_id="complete-1",
                    client_attempt_id="complete-attempt-1",
                    retry_of_attempt_id=None,
                    project_id="project-1",
                    input_text="Return the material name only.",
                    instructions="Answer with one short phrase.",
                )
            )
        )

        self.assertEqual(record.status, ModelInvocationStatus.COMPLETED)
        self.assertEqual(record.prompt_version, ONE_SHOT_PROMPT_VERSION)
        self.assertEqual(model.requests[0].purpose, "assistant.one_shot")
        self.assertEqual(model.requests[0].instructions, "Answer with one short phrase.")

    def test_attempt_reuse_with_different_payload_conflicts(self) -> None:
        service = AssistantActionService(
            self.store, activities=Activities(), model=OneShotProvider()
        )
        asyncio.run(service.translate(translation_request()))

        with self.assertRaises(AssistantInvocationConflictError):
            asyncio.run(service.translate(translation_request(text="changed source")))

    def test_explicit_retry_links_a_new_billed_attempt(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, activities=Activities(), model=model)
        first = asyncio.run(service.translate(translation_request()))
        retry = replace(
            translation_request(attempt="attempt-2"),
            retry_of_attempt_id=first.client_attempt_id,
        )

        second = asyncio.run(service.translate(retry))

        self.assertNotEqual(first.invocation_id, second.invocation_id)
        self.assertEqual(second.retry_of_attempt_id, first.client_attempt_id)
        self.assertEqual(len(model.requests), 2)

    def test_invocation_status_is_scoped_to_authenticated_owner(self) -> None:
        service = AssistantActionService(
            self.store, activities=Activities(), model=OneShotProvider()
        )
        record = asyncio.run(service.translate(translation_request()))

        self.assertEqual(service.get(record.invocation_id, "local"), record)
        self.assertIsNone(service.get(record.invocation_id, "another-owner"))

    def test_uncertain_or_running_attempt_cannot_be_retried_even_after_store_reopen(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, activities=Activities(), model=model)
        first = asyncio.run(service.translate(translation_request()))
        for status in (
            ModelInvocationStatus.UNKNOWN,
            ModelInvocationStatus.RUNNING,
            ModelInvocationStatus.PENDING,
        ):
            with self.subTest(status=status):
                self.store.save(replace(first, status=status))
                reopened = AssistantActionService(
                    AssistantInvocationStore(self.database), activities=Activities(), model=model
                )
                replay = asyncio.run(reopened.translate(translation_request()))
                self.assertEqual(replay.status, status)
                with self.assertRaisesRegex(ValueError, "retry_attempt_unresolved"):
                    asyncio.run(
                        reopened.translate(
                            replace(
                                translation_request(attempt="attempt-retry"),
                                retry_of_attempt_id="attempt-1",
                            )
                        )
                    )
        self.assertEqual(len(model.requests), 1)

    def test_missing_runtime_is_an_explicit_capability_and_durable_failure(self) -> None:
        service = AssistantActionService(self.store, activities=Activities())
        capabilities = {row["kind"]: row for row in service.capabilities()}
        self.assertFalse(capabilities["complete"]["available"])
        self.assertFalse(capabilities["translate"]["available"])
        self.assertEqual(capabilities["translate"]["reason"], ACTION_RUNTIME_UNAVAILABLE)
        failed = asyncio.run(service.translate(translation_request()))
        self.assertEqual(failed.status, ModelInvocationStatus.FAILED)
        self.assertEqual(failed.error_code, ACTION_RUNTIME_UNAVAILABLE)

    def test_http_exposes_distinct_completion_and_translation_endpoints(self) -> None:
        app = FastAPI()
        app.state.auth_enabled = False
        app.state.assistant_actions = AssistantActionService(self.store, activities=Activities())
        register_assistant_routes(app)
        client = TestClient(app)
        translation = {
            "client_action_id": "http-translation",
            "client_attempt_id": "http-translation-attempt",
            "project_id": "project-1",
            "text": SOURCE_TEXT,
            "target_language": "ja",
            "source_id": "notes/evidence.md",
            "source_revision": "sha256:" + "1" * 64,
        }

        response = client.post("/api/assistant/translations", json=translation)

        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["kind"], "translate")
        self.assertEqual(payload["error"]["code"], ACTION_RUNTIME_UNAVAILABLE)
        self.assertNotIn(SOURCE_TEXT, response.text)
        status = client.get(f"/api/assistant/invocations/{payload['invocation_id']}")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json(), payload)

        legacy = client.post(
            "/api/assistant/translations",
            json={
                **translation,
                "client_action_id": "legacy-translation",
                "client_attempt_id": "legacy-translation-attempt",
                "source_language": "en",
            },
        )
        self.assertEqual(legacy.status_code, 503)

        invalid = client.post(
            "/api/assistant/translations",
            json={
                **translation,
                "client_action_id": "invalid-translation",
                "client_attempt_id": "invalid-translation-attempt",
                "target_language": "unsupported",
            },
        )
        self.assertEqual(invalid.status_code, 422)

        completion = client.post(
            "/api/assistant/invocations",
            json={
                "client_action_id": "http-complete",
                "client_attempt_id": "http-complete-attempt",
                "project_id": "project-1",
                "input_text": "one-shot text",
                "instructions": "return one word",
            },
        )
        self.assertEqual(completion.status_code, 503)
        self.assertEqual(completion.json()["kind"], "complete")


if __name__ == "__main__":
    unittest.main()
