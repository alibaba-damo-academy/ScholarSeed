"""Contracts for non-Session Agent invocation and translation."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract import RuntimePermissionMode
from scholarseed_runtime.contract.history import TurnStatus
from scholarseed_runtime.contract.incident import RuntimeRetryability
from scholarseed_runtime.gateway.driver import RuntimeTurnOutcome, RuntimeTurnResult
from service.assistant.api.routes import register_assistant_routes
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
)
from service.chat.persistence.catalog import SESSION_CATALOG_TABLE, SessionCatalogStore
from service.chat.runtime.composition import OneShotRuntimeResult
from service.chat.service.inference import (
    ONE_SHOT_BASE_INSTRUCTIONS,
    ONE_SHOT_WORKSPACE_PREFIX,
    AgentOneShotProvider,
)
from service.platform.inference import (
    ModelInvocationLimits,
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
        source_language="en",
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

    def test_translation_is_idempotent_and_does_not_create_a_session(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, model=model)

        first = asyncio.run(service.translate(translation_request()))
        replay = asyncio.run(service.translate(translation_request()))

        self.assertEqual(first.status, ModelInvocationStatus.COMPLETED)
        self.assertEqual(first, replay)
        self.assertEqual(first.prompt_version, TRANSLATE_PROMPT_VERSION)
        self.assertEqual(len(model.requests), 1)
        self.assertEqual(model.requests[0].input_text, SOURCE_TEXT)
        self.assertIn("en", model.requests[0].instructions)
        self.assertEqual(model.requests[0].project_id, "project-1")
        self.assertEqual(first.receipt_id, "receipt-1")
        with sqlite3.connect(self.database) as connection:
            session_count = connection.execute(
                f"SELECT COUNT(*) FROM {SESSION_CATALOG_TABLE}"
            ).fetchone()[0]
            persisted = connection.execute(f"SELECT * FROM {ASSISTANT_INVOCATION_TABLE}").fetchone()
        self.assertEqual(session_count, 0)
        self.assertIsNotNone(persisted)
        self.assertNotIn(SOURCE_TEXT, self.database.read_bytes().decode("utf-8", errors="ignore"))

    def test_generic_invocation_uses_the_same_durable_non_session_path(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, model=model)
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
        service = AssistantActionService(self.store, model=OneShotProvider())
        asyncio.run(service.translate(translation_request()))

        with self.assertRaises(AssistantInvocationConflictError):
            asyncio.run(service.translate(translation_request(text="changed source")))

    def test_explicit_retry_links_a_new_billed_attempt(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, model=model)
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
        service = AssistantActionService(self.store, model=OneShotProvider())
        record = asyncio.run(service.translate(translation_request()))

        self.assertEqual(service.get(record.invocation_id, "local"), record)
        self.assertIsNone(service.get(record.invocation_id, "another-owner"))

    def test_uncertain_or_running_attempt_cannot_be_retried_even_after_store_reopen(self) -> None:
        model = OneShotProvider()
        service = AssistantActionService(self.store, model=model)
        first = asyncio.run(service.translate(translation_request()))
        for status in (
            ModelInvocationStatus.UNKNOWN,
            ModelInvocationStatus.RUNNING,
            ModelInvocationStatus.PENDING,
        ):
            with self.subTest(status=status):
                self.store.save(replace(first, status=status))
                reopened = AssistantActionService(
                    AssistantInvocationStore(self.database), model=model
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
        service = AssistantActionService(self.store)
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
        app.state.assistant_actions = AssistantActionService(self.store)
        register_assistant_routes(app)
        client = TestClient(app)
        translation = {
            "client_action_id": "http-translation",
            "client_attempt_id": "http-translation-attempt",
            "project_id": "project-1",
            "text": SOURCE_TEXT,
            "source_language": "en",
            "target_language": "zh-CN",
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


class RuntimeOneShotProviderContract(unittest.TestCase):
    def test_environment_failure_is_retryable_without_submitting_a_turn(self) -> None:
        invoke = AsyncMock()
        provider = AgentOneShotProvider(
            SimpleNamespace(invoke_once=invoke),
            SimpleNamespace(runtime_executable=lambda: "codex"),
            AsyncMock(side_effect=RuntimeError("credential unavailable")),
        )
        result = asyncio.run(
            provider.invoke(
                ModelInvocationRequest(
                    invocation_id="preflight",
                    owner_id="owner",
                    project_id="project",
                    purpose="translate",
                    model_key="",
                    instructions="translate",
                    input_text="source",
                    limits=ModelInvocationLimits(100, 50),
                )
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.FAILED)
        invoke.assert_not_awaited()

    def test_unknown_runtime_outcome_is_not_a_retryable_failure(self) -> None:
        error = RuntimeError("private vendor detail")
        error.retryability = RuntimeRetryability.UNKNOWN_OUTCOME
        provider = AgentOneShotProvider(
            SimpleNamespace(invoke_once=AsyncMock(side_effect=error)),
            SimpleNamespace(runtime_executable=lambda: "codex"),
            AsyncMock(return_value={}),
        )
        result = asyncio.run(
            provider.invoke(
                ModelInvocationRequest(
                    invocation_id="unknown-invocation",
                    owner_id="owner",
                    project_id="project",
                    purpose="interpret",
                    model_key="",
                    instructions="interpret",
                    input_text="text",
                    limits=ModelInvocationLimits(100, 50),
                )
            )
        )
        self.assertEqual(result.status, ModelInvocationStatus.UNKNOWN)
        self.assertNotIn("private vendor detail", result.error_detail)

    def test_interrupt_receipt_is_not_a_confirmed_cancelled_turn(self) -> None:
        cancel = AsyncMock(return_value=True)
        provider = AgentOneShotProvider(
            SimpleNamespace(cancel_once=cancel), SimpleNamespace(), AsyncMock(return_value={})
        )
        result = asyncio.run(provider.cancel(invocation_id="invocation", owner_id="owner"))
        self.assertEqual(result.status, ModelInvocationStatus.RUNNING)
        cancel.assert_awaited_once_with("invocation", owner_id="owner")

    def test_provider_delegates_to_agent_surface_runtime(self) -> None:
        observed: dict[str, object] = {}

        class Runtime:
            async def invoke_once(self, **kwargs):
                observed.update(kwargs)
                return OneShotRuntimeResult(
                    model_key="resolved-model",
                    turn=RuntimeTurnResult(
                        command_id="invocation-1",
                        native_turn_id="vendor-turn-1",
                        outcome=RuntimeTurnOutcome.COMPLETED,
                        final_text="translated",
                        input_tokens=11,
                        output_tokens=3,
                    ),
                )

            async def cancel_once(self, invocation_id: str) -> bool:
                return invocation_id == "invocation-1"

        class Settings:
            @staticmethod
            def runtime_executable() -> str:
                return "/runtime/adapter"

        async def environment(owner_id: str) -> dict[str, str]:
            self.assertEqual(owner_id, "owner-1")
            return {"SCHOLARSEED_API_KEY": "contract-runtime-key"}

        provider = AgentOneShotProvider(  # type: ignore[arg-type]
            Runtime(),
            Settings(),
            environment,
        )
        result = asyncio.run(
            provider.invoke(
                ModelInvocationRequest(
                    invocation_id="invocation-1",
                    owner_id="owner-1",
                    project_id="project-1",
                    purpose="assistant.translate",
                    model_key="",
                    instructions="translate only",
                    input_text=SOURCE_TEXT,
                    limits=ModelInvocationLimits(max_input_chars=100, max_output_tokens=50),
                )
            )
        )

        self.assertEqual(result.status, ModelInvocationStatus.COMPLETED)
        self.assertEqual(result.output_text, "translated")
        self.assertEqual(result.model_key, "resolved-model")
        self.assertEqual(result.usage.receipt_id, "vendor-turn-1")
        self.assertEqual(observed["owner_id"], "owner-1")
        self.assertEqual(observed["user_id"], "owner-1")
        self.assertEqual(observed["model_id"], "")
        self.assertEqual(
            observed["process_environment"],
            {"SCHOLARSEED_API_KEY": "contract-runtime-key"},
        )
        workspace = observed["cwd"]
        self.assertIsInstance(workspace, Path)
        self.assertTrue(workspace.name.startswith(ONE_SHOT_WORKSPACE_PREFIX))
        self.assertFalse(workspace.exists())
        self.assertEqual(observed["base_instructions"], ONE_SHOT_BASE_INSTRUCTIONS)
        self.assertEqual(observed["developer_instructions"], "translate only")
        self.assertIs(observed["permission_mode"], RuntimePermissionMode.READ_ONLY)
        self.assertEqual(observed["purpose"], "assistant.translate")


if __name__ == "__main__":
    unittest.main()
