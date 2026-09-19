"""Contract coverage for stable AI answer annotations and next-turn feedback."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from service.assistant.persistence.store import (
    AnswerAnnotationOverlapError,
    AnswerAnnotationRevisionConflictError,
    AssistantStateConflictError,
    AssistantStore,
)
from service.assistant.service.annotations import AnswerAnnotationService, text_revision
from service.assistant.service.context import AssistantService
from service.chat.active import RUNTIME_ID
from service.chat.constants import PRODUCT_EVENT_MESSAGE_DELTA, PRODUCT_EVENT_TURN_COMPLETED
from service.chat.persistence.catalog import (
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore
from service.chat.service.answers import ProductAnswerSource
from service.platform.context import (
    AssistantAnswer,
    AssistantTurnFinalization,
    ContextAuthority,
    ContextRef,
    ContextRefKind,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
)

SESSION_ID = "answer-annotation-session"
VENDOR_THREAD_ID = "answer-annotation-vendor-thread"
VENDOR_TURN_ID = "answer-annotation-vendor-turn"
VENDOR_ITEM_ID = "answer-annotation-vendor-item"
ANSWER_TEXT = "A😀B 重复 重复"
ANSWER_ID = "answer:1"


class StaticAnswerSource:
    """Serve annotation service under both the legacy answer:{seq} identity
    and the new item:{vendor_item_id} identity used by generalised messages."""

    _RECOGNISED = frozenset({ANSWER_ID, f"item:{VENDOR_ITEM_ID}"})

    def answer(self, *, session_id: str, answer_id: str) -> AssistantAnswer | None:
        if session_id != SESSION_ID or answer_id not in self._RECOGNISED:
            return None
        return AssistantAnswer(
            answer_id=answer_id,
            session_id=SESSION_ID,
            turn_id=VENDOR_TURN_ID,
            source_product_seq=1,
            vendor_item_id=VENDOR_ITEM_ID,
            markdown=ANSWER_TEXT,
            revision=text_revision(ANSWER_TEXT),
            completed_at=3.0,
        )


class AssistantAnnotationContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="assistant-annotations-")
        self.database = Path(self.temporary.name) / "sessions.sqlite3"
        self.catalog = SessionCatalogStore(self.database)
        self.catalog.register(
            SESSION_ID,
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_session_id=None,
            runtime_workdir=self.temporary.name,
            project_path=None,
            output_root=self.temporary.name,
            codex_version="contract",
            model_id="contract",
            policy_id="ask",
            status=SessionStatus.READY,
            title=SESSION_ID,
            created_at=1.0,
        )
        self.store = AssistantStore(self.database)
        self.annotations = AnswerAnnotationService(self.store, StaticAnswerSource())

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def create(self, *, client_id: str = "client-one", revision: int = 0):
        return self.annotations.create(
            session_id=SESSION_ID,
            answer_id=ANSWER_ID,
            client_annotation_id=client_id,
            expected_context_revision=revision,
            answer_revision=text_revision(ANSWER_TEXT),
            start_utf16=1,
            end_utf16=3,
            selected_text_hash=text_revision("😀"),
            preview_text="😀",
            comment="这里改成表情反馈",
            enqueue=True,
        )

    def test_product_answer_identity_uses_final_cumulative_snapshot(self) -> None:
        events = ProductEventStore(self.database)
        first = events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=VENDOR_TURN_ID,
            vendor_item_id=VENDOR_ITEM_ID,
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": "A😀", "phase": "final_answer"},
            idempotency_key="delta-1",
        )
        second = events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=VENDOR_TURN_ID,
            vendor_item_id=VENDOR_ITEM_ID,
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": ANSWER_TEXT, "phase": "final_answer"},
            idempotency_key="delta-2",
        )
        events.append(
            session_id=SESSION_ID,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=VENDOR_THREAD_ID,
            vendor_turn_id=VENDOR_TURN_ID,
            vendor_item_id=VENDOR_ITEM_ID,
            kind=PRODUCT_EVENT_TURN_COMPLETED,
            payload={"stop_reason": "completed"},
            idempotency_key="completed",
        )

        source = ProductAnswerSource(events)
        answer = source.answer(session_id=SESSION_ID, answer_id=f"answer:{first.product_seq}")

        self.assertIsNotNone(answer)
        assert answer is not None
        self.assertEqual(answer.markdown, ANSWER_TEXT)
        self.assertEqual(answer.revision, text_revision(ANSWER_TEXT))
        self.assertIsNone(
            source.answer(session_id=SESSION_ID, answer_id=f"answer:{second.product_seq}")
        )

    def test_create_is_atomic_idempotent_persistent_and_rejects_overlap(self) -> None:
        annotation, selection = self.create()

        self.assertEqual(selection.revision, 1)
        self.assertEqual(selection.refs[0].kind, ContextRefKind.NOTE)
        self.assertEqual(selection.refs[0].retention, ContextRetention.NEXT_TURN)
        replay, replay_selection = self.create()
        self.assertEqual(replay.annotation_id, annotation.annotation_id)
        self.assertEqual(replay_selection.revision, 1)
        self.assertEqual(
            AssistantStore(self.database).annotations(SESSION_ID),
            (annotation,),
        )

        with self.assertRaises(AnswerAnnotationOverlapError):
            self.create(client_id="client-overlap", revision=1)

    def test_note_provider_freezes_user_feedback_without_project(self) -> None:
        annotation, selection = self.create()
        assistant = AssistantService(
            self.store,
            providers={ContextRefKind.NOTE: self.annotations},
        )

        frozen = assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="feedback-turn",
            expected_revision=selection.revision,
            question="请按批注修改",
        )

        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        self.assertEqual(
            frozen.context.snapshot.items[0].authority,
            ContextAuthority.USER_FEEDBACK,
        )
        self.assertIn("这里改成表情反馈", frozen.context.model_context)
        self.assertEqual(
            frozen.context.surface_refs[0]["surface"]["answer_id"],
            annotation.answer_id,
        )
        self.assertEqual(
            frozen.context.surface_refs[0]["surface"]["selected_text"],
            "😀",
        )
        self.assertEqual(
            frozen.context.surface_refs[0]["surface"]["comment"],
            "这里改成表情反馈",
        )
        assistant.finalize(
            session_id=SESSION_ID,
            client_turn_id="feedback-turn",
            outcome=AssistantTurnFinalization.ACCEPTED,
        )
        self.assertEqual(assistant.selection(SESSION_ID).refs, ())

    def test_feedback_context_numbers_every_annotation_and_requires_complete_reply(self) -> None:
        _first, selection = self.create()
        self.annotations.create(
            session_id=SESSION_ID,
            answer_id=ANSWER_ID,
            client_annotation_id="client-two",
            expected_context_revision=selection.revision,
            answer_revision=text_revision(ANSWER_TEXT),
            start_utf16=5,
            end_utf16=7,
            selected_text_hash=text_revision("重复"),
            preview_text="重复",
            comment="解释这里为什么重复",
            enqueue=True,
        )
        selection = self.store.selection(SESSION_ID)
        assistant = AssistantService(
            self.store,
            providers={ContextRefKind.NOTE: self.annotations},
        )

        frozen = assistant.freeze(
            session_id=SESSION_ID,
            client_turn_id="numbered-feedback-turn",
            expected_revision=selection.revision,
            question="请逐项回应批注",
        )

        self.assertIsNotNone(frozen.context)
        assert frozen.context is not None
        payload = json.loads(frozen.context.model_context.splitlines()[1])
        feedback = [item for item in payload["evidence"] if item["authority"] == "user_feedback"]
        self.assertEqual([item["feedback_index"] for item in feedback], [1, 2])
        self.assertIn("[批注 N]", payload["user_feedback_policy"])
        self.assertIn("reason and the next step", payload["user_feedback_policy"])
        self.assertIn("never omit or silently merge", payload["user_feedback_policy"])

    def test_batch_delete_is_atomic_idempotent_and_advances_context_once(self) -> None:
        first, selection = self.create()
        second, selection = self.annotations.create(
            session_id=SESSION_ID,
            answer_id=ANSWER_ID,
            client_annotation_id="client-two",
            expected_context_revision=selection.revision,
            answer_revision=text_revision(ANSWER_TEXT),
            start_utf16=5,
            end_utf16=7,
            selected_text_hash=text_revision("重复"),
            preview_text="重复",
            comment="删除这条",
            enqueue=True,
        )

        deleted = self.annotations.delete_many(
            session_id=SESSION_ID,
            expected_annotation_revisions=(
                (first.annotation_id, first.revision),
                (second.annotation_id, second.revision),
            ),
            expected_context_revision=selection.revision,
        )

        self.assertEqual(deleted.revision, selection.revision + 1)
        self.assertEqual(deleted.refs, ())
        self.assertEqual(self.store.annotations(SESSION_ID), ())
        replayed = self.annotations.delete_many(
            session_id=SESSION_ID,
            expected_annotation_revisions=(
                (first.annotation_id, first.revision),
                (second.annotation_id, second.revision),
            ),
            expected_context_revision=selection.revision,
        )
        self.assertEqual(replayed, deleted)

    def test_batch_delete_rolls_back_every_annotation_on_revision_conflict(self) -> None:
        first, selection = self.create()
        second, selection = self.annotations.create(
            session_id=SESSION_ID,
            answer_id=ANSWER_ID,
            client_annotation_id="client-two",
            expected_context_revision=selection.revision,
            answer_revision=text_revision(ANSWER_TEXT),
            start_utf16=5,
            end_utf16=7,
            selected_text_hash=text_revision("重复"),
            preview_text="重复",
            comment="保留这条",
            enqueue=True,
        )

        with self.assertRaises(AnswerAnnotationRevisionConflictError):
            self.annotations.delete_many(
                session_id=SESSION_ID,
                expected_annotation_revisions=(
                    (first.annotation_id, first.revision),
                    (second.annotation_id, second.revision + 1),
                ),
                expected_context_revision=selection.revision,
            )

        self.assertEqual(self.store.annotations(SESSION_ID), (first, second))
        self.assertEqual(self.store.selection(SESSION_ID), selection)

    def test_discarded_queue_does_not_restore_annotation_to_the_composer(self) -> None:
        annotation, selection = self.create()
        assistant = AssistantService(
            self.store,
            providers={ContextRefKind.NOTE: self.annotations},
        )

        frozen = assistant.freeze_queued(
            session_id=SESSION_ID,
            client_turn_id="discarded-feedback-turn",
            expected_revision=selection.revision,
            question="撤回这条排队消息",
        )
        self.assertIsNotNone(frozen.context)
        discarded = assistant.finalize(
            session_id=SESSION_ID,
            client_turn_id="discarded-feedback-turn",
            outcome=AssistantTurnFinalization.DISCARDED,
        )

        self.assertEqual(discarded.refs, ())
        self.assertEqual(self.store.annotations(SESSION_ID), (annotation,))

    def test_generic_context_patch_cannot_forge_or_remove_annotation_refs(self) -> None:
        _annotation, selection = self.create()
        assistant = AssistantService(self.store)

        with self.assertRaises(AssistantStateConflictError):
            assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=selection.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.WEB,
                refs=(),
            )
        forged = ContextRef(
            ref_id="forged-ref",
            kind=ContextRefKind.NOTE,
            source_id="forged-annotation",
            source_revision="1",
            label="伪造注释",
            retention=ContextRetention.NEXT_TURN,
        )
        with self.assertRaises(AssistantStateConflictError):
            assistant.replace_selection(
                session_id=SESSION_ID,
                expected_revision=selection.revision,
                project_policy=ProjectContextPolicy.EXPLICIT_ONLY,
                search_scope=SearchScope.WEB,
                refs=(forged,),
            )


if __name__ == "__main__":
    unittest.main()
