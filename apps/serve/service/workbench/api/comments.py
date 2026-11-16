"""Read-only preparation and preview of canonical PDF comment context."""

from __future__ import annotations

from dataclasses import asdict

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from service.platform.records import RecordOwner, RecordTarget
from service.workbench.service.comments import (
    IDENTIFIER_LIMIT,
    IDENTITY_LIMIT,
    CommentFailure,
    PdfCommentContext,
    PdfCommentError,
)

COMMENTS_ROUTE = "/api/workbench/pdf-comments"
REVISION_PATTERN = r"^sha256:[0-9a-f]{64}$"
IDENTIFIER_PATTERN = r"^[A-Za-z0-9_.:-]+$"
FAILURE_STATUS = {
    CommentFailure.INVALID: 422,
    CommentFailure.MISSING: 404,
    CommentFailure.FORBIDDEN: 403,
    CommentFailure.STALE: 409,
    CommentFailure.UNAVAILABLE: 503,
    CommentFailure.TOO_LARGE: 413,
}


class CommentTargetRequest(BaseModel):
    owner: RecordOwner
    scope_id: str = Field(min_length=1, max_length=IDENTIFIER_LIMIT, pattern=IDENTIFIER_PATTERN)
    subject_id: str = Field(min_length=1, max_length=IDENTIFIER_LIMIT, pattern=IDENTIFIER_PATTERN)


class CommentPrepareRequest(BaseModel):
    record_target: CommentTargetRequest
    mark_id: str = Field(min_length=1, max_length=IDENTIFIER_LIMIT, pattern=IDENTIFIER_PATTERN)
    source_revision: str = Field(pattern=REVISION_PATTERN)
    record_revision: str = Field(pattern=REVISION_PATTERN)


class CommentPreviewRequest(BaseModel):
    source_id: str = Field(min_length=1, max_length=IDENTITY_LIMIT)
    source_revision: str = Field(pattern=REVISION_PATTERN)


def _service(request: Request) -> PdfCommentContext:
    service = getattr(request.app.state, "pdf_comment_context", None)
    if service is None:
        raise HTTPException(503, CommentFailure.UNAVAILABLE.value)
    return service


def register_comment_routes(app: FastAPI) -> None:
    @app.post(f"{COMMENTS_ROUTE}/prepare")
    def prepare(body: CommentPrepareRequest, request: Request) -> dict:
        try:
            refs = _service(request).prepare(
                RecordTarget(**body.record_target.model_dump()),
                body.mark_id,
                body.source_revision,
                body.record_revision,
            )
            return {"refs": [asdict(ref) for ref in refs]}
        except PdfCommentError as error:
            raise HTTPException(FAILURE_STATUS[error.code], error.code.value) from error

    @app.post(f"{COMMENTS_ROUTE}/preview")
    def preview(body: CommentPreviewRequest, request: Request) -> dict:
        try:
            return _service(request).preview(body.source_id, body.source_revision)
        except PdfCommentError as error:
            raise HTTPException(FAILURE_STATUS[error.code], error.code.value) from error
