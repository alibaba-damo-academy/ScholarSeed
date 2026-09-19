"""Session-owned AI answer annotations."""

from __future__ import annotations

from dataclasses import dataclass

ANSWER_ANNOTATION_COMMENT_MAX_CHARS = 600
ANSWER_ANNOTATION_PREVIEW_MAX_CHARS = 240


@dataclass(frozen=True)
class AnswerAnnotation:
    annotation_id: str
    client_annotation_id: str
    session_id: str
    answer_id: str
    source_product_seq: int
    source_turn_id: str
    source_item_id: str | None
    answer_revision: str
    start_utf16: int
    end_utf16: int
    selected_text_hash: str
    preview_text: str
    comment: str
    revision: int
    created_at: float
    updated_at: float


__all__ = [
    "ANSWER_ANNOTATION_COMMENT_MAX_CHARS",
    "ANSWER_ANNOTATION_PREVIEW_MAX_CHARS",
    "AnswerAnnotation",
]
