"""AI answer annotation lifecycle and context resolution."""

from __future__ import annotations

import hashlib
import json
import time
import uuid

from service.assistant.domain.model import (
    ANSWER_ANNOTATION_COMMENT_MAX_CHARS,
    ANSWER_ANNOTATION_PREVIEW_MAX_CHARS,
    AnswerAnnotation,
)
from service.assistant.persistence.store import AssistantStore
from service.platform.context import (
    SHA256_REVISION_PREFIX,
    AssistantAnswer,
    AssistantAnswerSource,
    AssistantContextIssue,
    AssistantContextResolution,
    AssistantContextResolvedItem,
    AssistantContextResolveRequest,
    AssistantContextSelection,
    ContextAuthority,
    ContextRefKind,
    ContextResolutionState,
)

ANNOTATION_REVISION_INITIAL = 1
PROVIDER_VERSION = "answer-annotation/v1"
USER_FEEDBACK_HEADER = "[SCHOLARSEED_USER_FEEDBACK v1]"
USER_FEEDBACK_MEDIA_TYPE = "application/vnd.scholarseed.user-feedback+json"
QUOTE_MEDIA_TYPE = "text/plain"
ERROR_ANSWER_UNSUPPORTED = "answer_annotation_unsupported"
ERROR_RANGE_INVALID = "answer_range_invalid"
ERROR_QUOTE_MISMATCH = "answer_quote_mismatch"
ERROR_ANNOTATION_MISSING = "answer_annotation_missing"
NOTE_LABEL_PREFIX = "回答注释 · "


class AnswerAnnotationValidationError(ValueError):
    """Stable public validation failure for an answer annotation mutation."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def utf16_slice(text: str, start: int, end: int) -> str:
    """Slice a Python string by browser-compatible UTF-16 code units."""

    encoded = text.encode("utf-16-le")
    if start < 0 or end <= start or end * 2 > len(encoded):
        raise AnswerAnnotationValidationError(ERROR_RANGE_INVALID)
    try:
        return encoded[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise AnswerAnnotationValidationError(ERROR_RANGE_INVALID) from exc


def text_revision(text: str) -> str:
    return f"{SHA256_REVISION_PREFIX}{hashlib.sha256(text.encode('utf-8')).hexdigest()}"


class AnswerAnnotationService:
    """Validate authoritative answer ranges and persist Session annotations."""

    def __init__(self, store: AssistantStore, answers: AssistantAnswerSource) -> None:
        self._store = store
        self._answers = answers

    def annotations(
        self,
        session_id: str,
        *,
        answer_id: str | None = None,
    ) -> tuple[AnswerAnnotation, ...]:
        # `answer_id` here is any message identifier the transport accepts:
        # legacy "answer:{seq}" or new "item:{vendor_item_id}". Resolve via the
        # message source so filtering falls back to the durable seq column.
        source_product_seq: int | None = None
        if answer_id:
            resolved = self._answers.answer(session_id=session_id, answer_id=answer_id)
            if resolved is None:
                raise AnswerAnnotationValidationError(ERROR_ANSWER_UNSUPPORTED)
            source_product_seq = resolved.source_product_seq
        return self._store.annotations(
            session_id,
            source_product_seq=source_product_seq,
        )

    def create(
        self,
        *,
        session_id: str,
        answer_id: str,
        client_annotation_id: str,
        expected_context_revision: int,
        answer_revision: str,
        start_utf16: int,
        end_utf16: int,
        selected_text_hash: str,
        preview_text: str,
        comment: str,
        enqueue: bool,
    ) -> tuple[AnswerAnnotation, AssistantContextSelection]:
        self._validate_comment(comment)
        answer, selected_text = self._validated_answer_range(
            session_id=session_id,
            answer_id=answer_id,
            start_utf16=start_utf16,
            end_utf16=end_utf16,
            selected_text_hash=selected_text_hash,
        )
        timestamp = time.time()
        # Prefer the item-based identifier so the freshly-created annotation
        # matches the identifier that will be surfaced when the row is read
        # back from persistence (see AssistantStore._annotation).
        canonical_answer_id = (
            f"item:{answer.vendor_item_id}" if answer.vendor_item_id else answer.answer_id
        )
        annotation = AnswerAnnotation(
            annotation_id=uuid.uuid4().hex,
            client_annotation_id=client_annotation_id,
            session_id=session_id,
            answer_id=canonical_answer_id,
            source_product_seq=answer.source_product_seq,
            source_turn_id=answer.turn_id,
            source_item_id=answer.vendor_item_id,
            answer_revision=answer.revision,
            start_utf16=start_utf16,
            end_utf16=end_utf16,
            selected_text_hash=selected_text_hash,
            preview_text=(preview_text.strip() or selected_text.strip())[
                :ANSWER_ANNOTATION_PREVIEW_MAX_CHARS
            ],
            comment=comment.strip(),
            revision=ANNOTATION_REVISION_INITIAL,
            created_at=timestamp,
            updated_at=timestamp,
        )
        return self._store.create_answer_annotation(
            annotation,
            expected_context_revision=expected_context_revision,
            enqueue=enqueue,
            ref_id=uuid.uuid4().hex,
            label=self._label(annotation),
        )

    def update(
        self,
        *,
        session_id: str,
        annotation_id: str,
        comment: str,
        expected_annotation_revision: int,
        expected_context_revision: int,
    ) -> tuple[AnswerAnnotation, AssistantContextSelection]:
        self._validate_comment(comment)
        return self._store.update_answer_annotation(
            session_id=session_id,
            annotation_id=annotation_id,
            comment=comment.strip(),
            expected_annotation_revision=expected_annotation_revision,
            expected_context_revision=expected_context_revision,
        )

    def enqueue(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_context_revision: int,
    ) -> AssistantContextSelection:
        annotation = self._store.answer_annotation(session_id, annotation_id)
        if annotation is None:
            raise AnswerAnnotationValidationError(ERROR_ANNOTATION_MISSING)
        return self._store.enqueue_answer_annotation(
            session_id=session_id,
            annotation_id=annotation_id,
            expected_context_revision=expected_context_revision,
            ref_id=uuid.uuid4().hex,
            label=self._label(annotation),
        )

    def remove_context(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_context_revision: int,
    ) -> AssistantContextSelection:
        return self._store.remove_answer_annotation_context(
            session_id=session_id,
            annotation_id=annotation_id,
            expected_context_revision=expected_context_revision,
        )

    def delete(
        self,
        *,
        session_id: str,
        annotation_id: str,
        expected_annotation_revision: int,
        expected_context_revision: int,
    ) -> AssistantContextSelection:
        return self._store.delete_answer_annotation(
            session_id=session_id,
            annotation_id=annotation_id,
            expected_annotation_revision=expected_annotation_revision,
            expected_context_revision=expected_context_revision,
        )

    def delete_many(
        self,
        *,
        session_id: str,
        expected_annotation_revisions: tuple[tuple[str, int], ...],
        expected_context_revision: int,
    ) -> AssistantContextSelection:
        return self._store.delete_answer_annotations(
            session_id=session_id,
            expected_annotation_revisions=expected_annotation_revisions,
            expected_context_revision=expected_context_revision,
        )

    def resolve(self, request: AssistantContextResolveRequest) -> AssistantContextResolution:
        ref = request.ref
        if ref.kind is not ContextRefKind.NOTE:
            return self._failure(ContextResolutionState.UNSUPPORTED, "source_type_unsupported")
        annotation = self._store.answer_annotation(request.requester_session_id, ref.source_id)
        if annotation is None:
            return self._failure(ContextResolutionState.MISSING, ERROR_ANNOTATION_MISSING)
        if ref.source_revision != str(annotation.revision):
            return self._failure(ContextResolutionState.STALE, "source_revision_changed")
        try:
            answer, selected_text = self._validated_answer_range(
                session_id=annotation.session_id,
                answer_id=annotation.answer_id,
                start_utf16=annotation.start_utf16,
                end_utf16=annotation.end_utf16,
                selected_text_hash=annotation.selected_text_hash,
            )
        except AnswerAnnotationValidationError as exc:
            return self._failure(ContextResolutionState.STALE, exc.code)
        if annotation.comment:
            payload = {
                "annotation_id": annotation.annotation_id,
                "prior_assistant_quote": selected_text,
                "user_comment": annotation.comment,
                "source": {
                    "answer_id": answer.answer_id,
                    "range_utf16": [annotation.start_utf16, annotation.end_utf16],
                },
            }
            text = "\n".join(
                (
                    USER_FEEDBACK_HEADER,
                    json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
                )
            )
            authority = ContextAuthority.USER_FEEDBACK
            media_type = USER_FEEDBACK_MEDIA_TYPE
        else:
            text = selected_text
            authority = ContextAuthority.SOURCE_MATERIAL
            media_type = QUOTE_MEDIA_TYPE
        excerpt = text[: request.budget.max_chars]
        truncated = len(excerpt) < len(text)
        return AssistantContextResolution(
            state=(ContextResolutionState.TRUNCATED if truncated else ContextResolutionState.READY),
            provider_version=PROVIDER_VERSION,
            source_revision=str(annotation.revision),
            items=(
                AssistantContextResolvedItem(
                    item_id=annotation.annotation_id,
                    source_id=annotation.annotation_id,
                    label=self._label(annotation),
                    source_revision=str(annotation.revision),
                    text=excerpt,
                    authority=authority,
                    surface={
                        "answer_id": annotation.answer_id,
                        # The queue detail must show the exact range sent to the Agent.
                        # This value has already passed authoritative range/hash validation.
                        "selected_text": selected_text,
                        "preview_text": selected_text[:ANSWER_ANNOTATION_PREVIEW_MAX_CHARS],
                        "comment": annotation.comment,
                        "start_utf16": annotation.start_utf16,
                        "end_utf16": annotation.end_utf16,
                    },
                    content_hash=text_revision(excerpt),
                    media_type=media_type,
                    content_level="selection",
                    truncated=truncated,
                ),
            ),
        )

    def _validated_answer_range(
        self,
        *,
        session_id: str,
        answer_id: str,
        start_utf16: int,
        end_utf16: int,
        selected_text_hash: str,
    ) -> tuple[AssistantAnswer, str]:
        answer = self._answers.answer(session_id=session_id, answer_id=answer_id)
        if answer is None:
            raise AnswerAnnotationValidationError(ERROR_ANSWER_UNSUPPORTED)
        selected_text = utf16_slice(answer.markdown, start_utf16, end_utf16)
        if text_revision(selected_text) != selected_text_hash:
            raise AnswerAnnotationValidationError(ERROR_QUOTE_MISMATCH)
        return answer, selected_text

    @staticmethod
    def _label(annotation: AnswerAnnotation) -> str:
        return f"{NOTE_LABEL_PREFIX}{annotation.preview_text}"

    @staticmethod
    def _validate_comment(comment: str) -> None:
        if len(comment) > ANSWER_ANNOTATION_COMMENT_MAX_CHARS:
            raise AnswerAnnotationValidationError("answer_annotation_comment_too_long")

    @staticmethod
    def _failure(state: ContextResolutionState, code: str) -> AssistantContextResolution:
        return AssistantContextResolution(
            state=state,
            provider_version=PROVIDER_VERSION,
            issues=(AssistantContextIssue(code=code),),
        )


__all__ = [
    "AnswerAnnotationService",
    "AnswerAnnotationValidationError",
    "text_revision",
    "utf16_slice",
]
