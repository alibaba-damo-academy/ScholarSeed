"""Deterministic title policy and lifecycle contracts, not model acceptance."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock, patch

from service.chat.constants import (
    PRODUCT_EVENT_SESSION_TITLE_UPDATED,
    PRODUCT_EVENT_USER_MESSAGE,
    PRODUCT_REFERENCE_FILE,
    PRODUCT_REFERENCE_SKILL,
    SESSION_TITLE_DEFAULT,
    SessionTitleFallback,
)
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal
from service.chat.persistence.events import ProductEventStore
from service.chat.runtime.live import LiveSession
from service.chat.service.titles import SessionTitles
from service.platform.activity import Activities
from service.platform.context import MessageReferencePayload
from service.platform.inference import ModelInvocationResult, ModelInvocationStatus


class TitleModel:
    def __init__(self) -> None:
        self.requests = []
        self.ready = asyncio.Event()
        self.started = asyncio.Event()
        self.status = ModelInvocationStatus.COMPLETED
        self.output = '{"title":"设计科研文献检索方案"}'
        self.cancelled = False

    def available(self) -> bool:
        return True

    async def invoke(self, request, *, observer=None):
        self.requests.append(request)
        self.started.set()
        try:
            await self.ready.wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return ModelInvocationResult(request.invocation_id, self.status, output_text=self.output)


class SessionTitleContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        database = Path(self.directory.name).resolve() / "sessions.db"
        self.catalog = SessionCatalogStore(database)
        self.events = ProductEventStore(database)
        self.owner = SessionPrincipal("title-owner")
        self.catalog.allocate(
            "session",
            self.owner,
            runtime_id="codex",
            runtime_workdir=self.directory.name,
            project_path=None,
            output_root=self.directory.name,
            title=SESSION_TITLE_DEFAULT,
            title_fallback=SessionTitleFallback.NEW_SESSION,
        )
        self.model = TitleModel()
        self.activities = Activities()
        self.select_model = Mock(return_value="qwen3.8-flash")
        self.service = SessionTitles(
            self.catalog, self.events, self.model, self.activities, select_model=self.select_model
        )
        self.published = []

        async def adopt(title, *, turn_id):
            record = self.catalog.adopt_generated_title(
                "session", title, replaceable_titles=(SESSION_TITLE_DEFAULT,)
            )
            self.published.append((PRODUCT_EVENT_SESSION_TITLE_UPDATED, record.title, turn_id))

        self.live = SimpleNamespace(
            id="session",
            user_id="title-owner",
            project_id="project",
            model_id="chosen-model",
            history_entries=(),
            lifecycle_lock=asyncio.Lock(),
            terminating=False,
            terminated=False,
            adopt_generated_title=adopt,
        )

    async def asyncTearDown(self) -> None:
        await self.service.aclose()
        self.directory.cleanup()

    def admitted(self, text="请分析现有科研文献检索方式的不足，并设计改进方案"):
        request = self.service.prepare(self.live, text, turn_id="first-turn")
        self.events.append(
            session_id="session",
            runtime_id="codex",
            vendor_thread_id="",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": text, "binding": "admitted"},
            idempotency_key="first-message",
        )
        return request

    async def test_first_message_runs_concurrently_and_freezes_model_and_input(self) -> None:
        request = self.admitted()
        self.assertIsNotNone(request)
        self.assertIn("same language as the first user message", request.instructions)
        task = self.service.start(self.live, request)
        await self.model.started.wait()
        self.assertFalse(task.done())
        self.live.model_id = "later-model"
        self.assertIsNone(self.service.prepare(self.live, "后来改为写一首诗", turn_id="second"))
        self.model.ready.set()
        await task
        self.assertEqual(len(self.model.requests), 1)
        self.assertEqual(self.model.requests[0].model_key, "qwen3.8-flash")
        self.select_model.assert_called_once_with("chosen-model", "title-owner")
        self.assertEqual(self.model.requests[0].input_text, request.input_text)
        self.assertEqual(self.catalog.get("session").title, "设计科研文献检索方案")
        self.assertEqual(
            self.events.latest_kind("session", PRODUCT_EVENT_USER_MESSAGE).payload["text"],
            request.input_text,
        )
        self.assertEqual(self.published[0][2], "first-turn")

    async def test_failure_never_retries_on_later_messages_or_reopen(self) -> None:
        self.model.status = ModelInvocationStatus.FAILED
        request = self.admitted()
        self.model.ready.set()
        await self.service.start(self.live, request)
        self.assertEqual(self.catalog.get("session").title, SESSION_TITLE_DEFAULT)
        reopened = SessionTitles(
            self.catalog, self.events, self.model, self.activities, select_model=self.select_model
        )
        try:
            self.assertIsNone(reopened.prepare(self.live, "another task", turn_id="later"))
        finally:
            await reopened.aclose()
        self.assertEqual(len(self.model.requests), 1)
        self.assertEqual(self.published, [])

    async def test_personal_selection_is_used_without_changing_the_conversation_model(self) -> None:
        self.select_model.return_value = "chosen-model"
        request = self.admitted()
        self.model.ready.set()
        await self.service.start(self.live, request)
        self.assertEqual(self.model.requests[0].model_key, "chosen-model")
        self.assertEqual(self.live.model_id, "chosen-model")

    async def test_unavailable_title_model_keeps_default_without_invoking_another_model(
        self,
    ) -> None:
        self.select_model.side_effect = ValueError("model unavailable")
        await self.service.start(self.live, self.admitted())
        self.assertEqual(self.catalog.get("session").title, SESSION_TITLE_DEFAULT)
        self.assertEqual(self.model.requests, [])

    async def test_manual_same_default_name_wins_while_generation_is_pending(self) -> None:
        request = self.admitted()
        task = self.service.start(self.live, request)
        await self.model.started.wait()
        self.catalog.rename("session", self.owner, SESSION_TITLE_DEFAULT)
        self.model.ready.set()
        await task
        self.assertEqual(self.catalog.get("session").title, SESSION_TITLE_DEFAULT)
        self.assertEqual(self.published, [])

    async def test_closed_session_discards_late_result(self) -> None:
        request = self.admitted()
        task = self.service.start(self.live, request)
        await self.model.started.wait()
        self.live.terminated = True
        self.model.ready.set()
        await task
        self.assertEqual(self.published, [])

    async def test_shutdown_cancels_and_joins_actual_model_work(self) -> None:
        task = self.service.start(self.live, self.admitted())
        await self.model.started.wait()
        await self.service.aclose()
        self.assertTrue(task.done())
        self.assertTrue(self.model.cancelled)
        self.assertEqual(self.published, [])

    async def test_timeout_and_invalid_output_preserve_default(self) -> None:
        with patch("service.chat.service.titles.TITLE_TIMEOUT_SECONDS", 0.01):
            await self.service.start(self.live, self.admitted())
        self.assertTrue(self.model.cancelled)
        self.assertEqual(self.catalog.get("session").title, SESSION_TITLE_DEFAULT)
        self.assertEqual(self.published, [])

    async def test_invalid_model_output_is_not_adopted(self) -> None:
        self.model.output = '{"title":["not a title"]}'
        self.model.ready.set()
        await self.service.start(self.live, self.admitted())
        self.assertEqual(self.published, [])

    async def test_empty_and_preexisting_history_do_not_generate(self) -> None:
        self.assertIsNone(self.service.prepare(self.live, "  ", turn_id="empty"))
        self.live.history_entries = (SimpleNamespace(role="user"),)
        self.assertIsNone(self.service.prepare(self.live, "a followup", turn_id="forked"))

    async def test_reference_only_first_message_generates_without_private_metadata(self) -> None:
        live = cast(LiveSession, self.live)
        for kind, name in (
            (PRODUCT_REFERENCE_FILE, "科研综述.md"),
            (PRODUCT_REFERENCE_SKILL, "论文分析"),
        ):
            with self.subTest(kind=kind):
                request = self.service.prepare(
                    live,
                    "  ",
                    turn_id="reference-only",
                    references=({"type": kind, "title": name, "path": "/private/source"},),
                )
                assert request is not None
                self.assertEqual(json.loads(request.input_text), [{"type": kind, "name": name}])
                self.assertNotIn("/private/source", request.input_text)

    async def test_reference_fallback_preserves_text_and_manual_title_policy(self) -> None:
        live = cast(LiveSession, self.live)
        references: tuple[MessageReferencePayload, ...] = (
            {"type": PRODUCT_REFERENCE_SKILL, "title": "论文分析"},
        )
        request = self.service.prepare(live, "分析附件", turn_id="mixed", references=references)
        assert request is not None
        self.assertEqual(request.input_text, "分析附件")
        self.assertIsNone(
            self.service.prepare(live, "", turn_id="empty", references=({"title": " "},))
        )
        self.catalog.rename("session", self.owner, "手动名称")
        self.assertIsNone(self.service.prepare(live, "", turn_id="manual", references=references))

    async def test_reference_only_generation_keeps_first_turn_and_manual_race_protection(
        self,
    ) -> None:
        live = cast(LiveSession, self.live)
        references: tuple[MessageReferencePayload, ...] = (
            {"type": PRODUCT_REFERENCE_FILE, "title": "科研综述.md"},
        )
        request = self.service.prepare(live, "", turn_id="reference-only", references=references)
        assert request is not None
        self.events.append(
            session_id="session",
            runtime_id="codex",
            vendor_thread_id="",
            vendor_turn_id=None,
            vendor_item_id=None,
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": "", "references": references},
            idempotency_key="first-reference",
        )
        self.assertIsNone(self.service.prepare(live, "", turn_id="later", references=references))
        task = self.service.start(live, request)
        await self.model.started.wait()
        self.catalog.rename("session", self.owner, "手动名称")
        self.model.ready.set()
        await task
        record = self.catalog.get("session")
        assert record is not None
        self.assertEqual(record.title, "手动名称")
        self.assertEqual(self.published, [])

    async def test_manual_name_before_first_message_disables_generation(self) -> None:
        self.catalog.rename("session", self.owner, SESSION_TITLE_DEFAULT)
        self.assertIsNone(self.service.prepare(self.live, "a new request", turn_id="first"))
        self.assertEqual(self.model.requests, [])

    async def test_generated_default_name_still_consumes_the_single_attempt(self) -> None:
        self.model.output = json.dumps({"title": SESSION_TITLE_DEFAULT})
        self.model.ready.set()
        await self.service.start(self.live, self.admitted())
        self.assertIsNone(self.catalog.get("session").title_fallback)
        self.assertIsNone(self.service.prepare(self.live, "another topic", turn_id="later"))


if __name__ == "__main__":
    unittest.main()
