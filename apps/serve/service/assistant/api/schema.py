"""Validated HTTP input models for Session Assistant context."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

from service.assistant.domain.model import ANSWER_ANNOTATION_COMMENT_MAX_CHARS
from service.assistant.service.actions import (
    ONE_SHOT_MAXIMUM_INPUT_CHARS,
    ONE_SHOT_MAXIMUM_INSTRUCTION_CHARS,
)
from service.platform.context import (
    ContextLabelFallback,
    ContextOrigin,
    ContextRefKind,
    ContextRetention,
    ProjectContextPolicy,
    SearchScope,
)
from service.platform.pdf import MAXIMUM_SELECTION_CHARS

SHA256_PATTERN = r"^sha256:[0-9a-f]{64}$"
MARKDOWN_SEGMENT_LIMIT = 64


class CitationResolveRequest(BaseModel):
    answer_revision: str = Field(pattern=SHA256_PATTERN)
    start_utf16: int = Field(default=0, ge=0)
    end_utf16: int = Field(default=0, ge=0)
    handle: str = Field(default="", max_length=128)


class TextLocatorRequest(BaseModel):
    kind: Literal["text"]
    start_line: int = Field(ge=0)
    start_column: int = Field(ge=0)
    end_line: int = Field(ge=0)
    end_column: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "TextLocatorRequest":
        if (self.end_line, self.end_column) < (self.start_line, self.start_column):
            raise ValueError("text locator end must not precede start")
        return self


class MarkdownSegmentRequest(BaseModel):
    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "MarkdownSegmentRequest":
        if self.end <= self.start:
            raise ValueError("markdown segment must not be empty or reversed")
        return self


class MarkdownLocatorRequest(BaseModel):
    kind: Literal["markdown"]
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    segments: list[MarkdownSegmentRequest] | None = Field(
        default=None,
        min_length=1,
        max_length=MARKDOWN_SEGMENT_LIMIT,
    )
    source_map_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def ordered(self) -> "MarkdownLocatorRequest":
        if self.end < self.start:
            raise ValueError("markdown locator end must not precede start")
        previous_end = self.start
        for segment in self.segments or ():
            if segment.start < previous_end or segment.end > self.end:
                raise ValueError("markdown segments must be ordered within the locator range")
            previous_end = segment.end
        return self


class PdfLocatorRequest(BaseModel):
    kind: Literal["pdf"]
    page: int = Field(ge=1)
    quads: list[tuple[float, float, float, float]] = Field(min_length=1)
    text_length: int | None = Field(default=None, ge=1, le=MAXIMUM_SELECTION_CHARS)
    text_shape_hash: str | None = Field(default=None, pattern=SHA256_PATTERN)

    @model_validator(mode="after")
    def normalized(self) -> "PdfLocatorRequest":
        for left, top, right, bottom in self.quads:
            if not all(0 <= value <= 1 for value in (left, top, right, bottom)):
                raise ValueError("pdf locator coordinates must be normalized")
            if right < left or bottom < top:
                raise ValueError("pdf locator quad must be ordered")
        return self


class WriterLocatorRequest(BaseModel):
    kind: Literal["writer"]
    paragraph: str = Field(min_length=1)
    start: int = Field(ge=0)
    end: int = Field(ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "WriterLocatorRequest":
        if self.end < self.start:
            raise ValueError("writer locator end must not precede start")
        return self


class CalcLocatorRequest(BaseModel):
    kind: Literal["calc"]
    sheet: str = Field(min_length=1)
    range: str = Field(min_length=1)
    content_mode: Literal["reference"] | None = None


class ImpressLocatorRequest(BaseModel):
    kind: Literal["impress"]
    slide: int = Field(ge=1)
    shape: str = Field(min_length=1)
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def ordered(self) -> "ImpressLocatorRequest":
        if (self.start is None) != (self.end is None):
            raise ValueError("impress locator range must provide both start and end")
        if self.start is not None and self.end is not None and self.end < self.start:
            raise ValueError("impress locator end must not precede start")
        return self


SelectionLocatorRequest = Annotated[
    TextLocatorRequest
    | MarkdownLocatorRequest
    | PdfLocatorRequest
    | WriterLocatorRequest
    | CalcLocatorRequest
    | ImpressLocatorRequest,
    Field(discriminator="kind"),
]


class SelectionAnchorRequest(BaseModel):
    document_id: str | None = None
    locator: SelectionLocatorRequest
    selected_text_hash: str = Field(pattern=SHA256_PATTERN)
    preview_text: str = ""


class ContextRefRequest(BaseModel):
    ref_id: str = ""
    kind: ContextRefKind
    source_id: str = Field(min_length=1)
    source_revision: str | None = None
    label: str = Field(min_length=1)
    anchor: SelectionAnchorRequest | None = None
    retention: ContextRetention = ContextRetention.SESSION
    origin: ContextOrigin = ContextOrigin.EXPLICIT
    label_fallback: ContextLabelFallback | None = None
    selection_source_label: str | None = None

    @model_validator(mode="after")
    def validate_label_fallback(self) -> ContextRefRequest:
        if self.label_fallback is not None and self.kind is not ContextRefKind.SESSION:
            raise ValueError("assistant label fallback requires a session reference")
        if self.selection_source_label is not None and (
            self.kind not in (ContextRefKind.SELECTION, ContextRefKind.LITERATURE)
            or self.anchor is None
        ):
            raise ValueError(
                "assistant selection source label requires an anchored selection or literature reference"
            )
        return self


class AssistantContextPatchRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    project_policy: ProjectContextPolicy
    search_scope: SearchScope
    refs: list[ContextRefRequest] = Field(default_factory=list)


class AssistantAnswerResourceSourceRequest(BaseModel):
    """Exact completed answer selection being saved as a resource."""

    answer_id: str = Field(min_length=1)
    answer_revision: str = Field(pattern=SHA256_PATTERN)
    start_utf16: int = Field(ge=0)
    end_utf16: int = Field(gt=0)
    selected_text_hash: str = Field(pattern=SHA256_PATTERN)


class ResourceLocationRequest(BaseModel):
    parent: str = Field(default="", max_length=1024)
    name: str = Field(min_length=1, max_length=180)


class AssistantResourceCreateRequest(BaseModel):
    """把 AI 回答内容新建为资料。"""

    project_id: str = ""
    name: str = Field(min_length=1)
    content: str = Field(min_length=1)
    source: AssistantAnswerResourceSourceRequest | None = None
    location: ResourceLocationRequest | None = None


class AnswerAnnotationCreateRequest(BaseModel):
    client_annotation_id: str = Field(min_length=1)
    expected_context_revision: int = Field(ge=0)
    answer_revision: str = Field(pattern=SHA256_PATTERN)
    start_utf16: int = Field(ge=0)
    end_utf16: int = Field(gt=0)
    selected_text_hash: str = Field(pattern=SHA256_PATTERN)
    preview_text: str = ""
    comment: str = Field(default="", max_length=ANSWER_ANNOTATION_COMMENT_MAX_CHARS)
    enqueue: bool = True


class AnswerAnnotationUpdateRequest(BaseModel):
    expected_annotation_revision: int = Field(ge=1)
    expected_context_revision: int = Field(ge=0)
    comment: str = Field(default="", max_length=ANSWER_ANNOTATION_COMMENT_MAX_CHARS)


class AnswerAnnotationContextRequest(BaseModel):
    expected_context_revision: int = Field(ge=0)


class AnswerAnnotationDeleteRequest(AnswerAnnotationContextRequest):
    expected_annotation_revision: int = Field(ge=1)


class AnswerAnnotationBatchDeleteItem(BaseModel):
    annotation_id: str = Field(min_length=1)
    expected_annotation_revision: int = Field(ge=1)


class AnswerAnnotationBatchDeleteRequest(AnswerAnnotationContextRequest):
    annotations: list[AnswerAnnotationBatchDeleteItem] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_annotations(self) -> "AnswerAnnotationBatchDeleteRequest":
        annotation_ids = [item.annotation_id for item in self.annotations]
        if len(annotation_ids) != len(set(annotation_ids)):
            raise ValueError("annotation ids must be unique")
        return self


class AssistantResourceImportRequest(BaseModel):
    """把一份已归属当前 Session 的产物导入资料库。"""

    project_id: str = ""
    artifact_id: str = Field(min_length=1)
    expected_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    location: ResourceLocationRequest | None = None
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=180)


class AssistantLiteratureImportRequest(BaseModel):
    artifact_id: str = Field(min_length=1)
    expected_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=180)
    collection: str = ""


class AssistantAttachmentImportRequest(BaseModel):
    project_id: str = ""
    reference_id: str = Field(min_length=1)
    location: ResourceLocationRequest


class AssistantInvocationStartRequest(BaseModel):
    client_action_id: str = Field(min_length=1)
    client_attempt_id: str = Field(min_length=1)
    retry_of_attempt_id: str | None = None
    project_id: str = Field(min_length=1)
    input_text: str = Field(min_length=1, max_length=ONE_SHOT_MAXIMUM_INPUT_CHARS)
    instructions: str = Field(default="", max_length=ONE_SHOT_MAXIMUM_INSTRUCTION_CHARS)
    model_key: str = ""


class AssistantTranslationStartRequest(BaseModel):
    client_action_id: str = Field(min_length=1)
    client_attempt_id: str = Field(min_length=1)
    retry_of_attempt_id: str | None = None
    project_id: str = Field(min_length=1)
    text: str = Field(min_length=1, max_length=ONE_SHOT_MAXIMUM_INPUT_CHARS)
    source_language: Literal["auto", "en", "zh-CN"] = "auto"
    target_language: Literal["en", "zh-CN"]
    source_id: str = ""
    source_revision: str | None = None
    model_key: str = ""

    @model_validator(mode="after")
    def language_pair(self) -> "AssistantTranslationStartRequest":
        if self.source_language == self.target_language:
            raise ValueError("source and target language must differ")
        return self


__all__ = [
    "AssistantAnswerResourceSourceRequest",
    "AnswerAnnotationBatchDeleteItem",
    "AnswerAnnotationBatchDeleteRequest",
    "AnswerAnnotationContextRequest",
    "AnswerAnnotationCreateRequest",
    "AnswerAnnotationDeleteRequest",
    "AnswerAnnotationUpdateRequest",
    "AssistantContextPatchRequest",
    "AssistantInvocationStartRequest",
    "AssistantResourceCreateRequest",
    "AssistantResourceImportRequest",
    "AssistantTranslationStartRequest",
    "ResourceLocationRequest",
    "ContextRefRequest",
    "SelectionAnchorRequest",
    "SelectionLocatorRequest",
]
