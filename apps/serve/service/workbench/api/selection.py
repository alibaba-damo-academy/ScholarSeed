"""HTTP boundary for direct AI actions over verified Workbench selections."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import PurePosixPath

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, JsonValue, model_validator

from service.assistant.api.stream import SSE_HEADERS, SSE_MEDIA_TYPE, action_stream
from service.assistant.persistence.invocations import AssistantInvocationConflictError
from service.identity.utils import request_user_id
from service.platform.inference import ModelInvocationStatus
from service.workbench.domain.selection import (
    SelectionActionInput,
    SelectionActionKind,
    SelectionDraftEvidence,
    SelectionEvidenceError,
    SelectionEvidenceMode,
    SelectionEvidenceReference,
)
from service.workbench.service.selection import (
    MAXIMUM_CONTEXT_TEXT_CHARS,
    MAXIMUM_SELECTED_TEXT_CHARS,
    SelectionActionService,
    SelectionModelError,
)

SELECTION_ACTION_ROUTE = "/api/workbench/selection/actions"
SELECTION_ACTIONS_STATE = "selection_actions"
MAXIMUM_PROJECT_ID_CHARS = 256
MAXIMUM_SOURCE_ID_CHARS = 2_048
MAXIMUM_REVISION_CHARS = 256
MAXIMUM_LOCATOR_KIND_CHARS = 64
MAXIMUM_QUESTION_CHARS = 4_000
MAXIMUM_TARGET_LANGUAGE_CHARS = 128
MAXIMUM_CLIENT_ID_CHARS = 128
SHA256_HEX_PATTERN = r"^sha256:[0-9a-f]{64}$"
SERVICE_UNAVAILABLE_STATUS = 503
MODEL_GATEWAY_ERROR_STATUS = 502
CONFLICT_STATUS = 409
PAYLOAD_TOO_LARGE_STATUS = 413
EVIDENCE_ERROR_STATUS = {
    "selection_stale": CONFLICT_STATUS,
    "selection_missing": 404,
    "selection_forbidden": 403,
    "selection_unsupported": 422,
    "selection_unavailable": SERVICE_UNAVAILABLE_STATUS,
    "selection_too_large": PAYLOAD_TOO_LARGE_STATUS,
}


class SelectionEvidenceRequest(BaseModel):
    """Transport model containing a locator, never client-authored evidence text."""

    project_id: str = Field(min_length=1, max_length=MAXIMUM_PROJECT_ID_CHARS)
    source_id: str = Field(min_length=1, max_length=MAXIMUM_SOURCE_ID_CHARS)
    source_revision: str = Field(min_length=1, max_length=MAXIMUM_REVISION_CHARS)
    locator_kind: str = Field(min_length=1, max_length=MAXIMUM_LOCATOR_KIND_CHARS)
    selected_text_hash: str = Field(pattern=SHA256_HEX_PATTERN)
    locator: dict[str, JsonValue]

    @model_validator(mode="after")
    def validate_range(self) -> "SelectionEvidenceRequest":
        source = PurePosixPath(self.source_id)
        if source.is_absolute() or ".." in source.parts:
            raise ValueError("selection source must be project-relative")
        if self.locator.get("kind") != self.locator_kind:
            raise ValueError("selection locator kind must match")
        return self

    def as_reference(self) -> SelectionEvidenceReference:
        return SelectionEvidenceReference(
            project_id=self.project_id,
            source_id=self.source_id,
            source_revision=self.source_revision,
            locator_kind=self.locator_kind,
            selected_text_hash=self.selected_text_hash,
            locator=self.locator,
        )


class SelectionDraftRequest(BaseModel):
    """Transient editor bytes used only for one action, never persisted as source evidence."""

    change_version: int = Field(ge=1)
    selected_text: str = Field(min_length=1, max_length=MAXIMUM_SELECTED_TEXT_CHARS)
    context_text: str = Field(min_length=1, max_length=MAXIMUM_CONTEXT_TEXT_CHARS)
    selected_text_hash: str = Field(pattern=SHA256_HEX_PATTERN)

    def as_evidence(self) -> SelectionDraftEvidence:
        return SelectionDraftEvidence(
            change_version=self.change_version,
            selected_text=self.selected_text,
            context_text=self.context_text,
            selected_text_hash=self.selected_text_hash,
        )


class SelectionActionRequest(BaseModel):
    action: SelectionActionKind
    client_action_id: str = Field(min_length=1, max_length=MAXIMUM_CLIENT_ID_CHARS)
    client_attempt_id: str = Field(min_length=1, max_length=MAXIMUM_CLIENT_ID_CHARS)
    retry_of_attempt_id: str | None = Field(
        default=None, min_length=1, max_length=MAXIMUM_CLIENT_ID_CHARS
    )
    selection: SelectionEvidenceRequest
    question: str = Field(default="", max_length=MAXIMUM_QUESTION_CHARS)
    target_language: str = Field(default="", max_length=MAXIMUM_TARGET_LANGUAGE_CHARS)
    draft: SelectionDraftRequest | None = None

    def as_command(self, *, owner_id: str) -> SelectionActionInput:
        return SelectionActionInput(
            action=self.action,
            selection=self.selection.as_reference(),
            question=self.question,
            target_language=self.target_language,
            owner_id=owner_id,
            client_action_id=self.client_action_id,
            client_attempt_id=self.client_attempt_id,
            retry_of_attempt_id=self.retry_of_attempt_id,
            draft=self.draft.as_evidence() if self.draft is not None else None,
        )


class SelectionActionEvidenceResponse(BaseModel):
    project_id: str
    source_id: str
    source_revision: str
    evidence_revision: str
    locator_kind: str
    selected_text_hash: str
    locator: dict[str, JsonValue]
    mode: SelectionEvidenceMode
    change_version: int | None


class SelectionActionResponse(BaseModel):
    action: SelectionActionKind
    prompt_version: str
    output: str
    evidence: SelectionActionEvidenceResponse
    invocation_id: str
    client_action_id: str
    client_attempt_id: str
    retry_of_attempt_id: str | None
    status: ModelInvocationStatus
    error_code: str


def _selection_actions(request: Request) -> SelectionActionService:
    service = getattr(request.app.state, SELECTION_ACTIONS_STATE, None)
    if service is None:
        raise HTTPException(
            status_code=SERVICE_UNAVAILABLE_STATUS,
            detail="selection_actions_unavailable",
        )
    return service


def register_selection_action_routes(app: FastAPI) -> None:
    """Mount selection actions without constructing runtime or evidence adapters."""

    @app.post(SELECTION_ACTION_ROUTE, response_model=SelectionActionResponse)
    async def execute_selection_action(  # type: ignore[unused-ignore]
        request: Request,
        body: SelectionActionRequest,
    ):
        if SSE_MEDIA_TYPE in request.headers.get("accept", ""):
            return StreamingResponse(
                action_stream(
                    _selection_actions(request), body.as_command(owner_id=request_user_id(request))
                ),
                media_type=SSE_MEDIA_TYPE,
                headers=SSE_HEADERS,
            )
        try:
            result = await _selection_actions(request).execute(
                body.as_command(
                    owner_id=request_user_id(request),
                )
            )
        except SelectionEvidenceError as exc:
            raise HTTPException(
                status_code=EVIDENCE_ERROR_STATUS.get(exc.code, 422),
                detail=exc.code,
            ) from exc
        except SelectionModelError as exc:
            raise HTTPException(
                status_code=MODEL_GATEWAY_ERROR_STATUS,
                detail=exc.code,
            ) from exc
        except AssistantInvocationConflictError as exc:
            raise HTTPException(status_code=CONFLICT_STATUS, detail="attempt_conflict") from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="action_request_invalid") from exc
        return asdict(result)

    @app.post(SELECTION_ACTION_ROUTE + "/{invocation_id}/interrupt")
    async def interrupt_selection_action(invocation_id: str, request: Request) -> dict:
        accepted = await _selection_actions(request).cancel(
            invocation_id=invocation_id, owner_id=request_user_id(request)
        )
        if not accepted:
            raise HTTPException(status_code=404, detail="selection_not_running")
        return {"accepted": True}


__all__ = [
    "SELECTION_ACTION_ROUTE",
    "SelectionActionRequest",
    "SelectionActionResponse",
    "SelectionDraftRequest",
    "SelectionEvidenceRequest",
    "register_selection_action_routes",
]
