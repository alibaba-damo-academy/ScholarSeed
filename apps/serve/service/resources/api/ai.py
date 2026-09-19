"""Independent resource explain/polish endpoints and owner-scoped task access."""

import hashlib
from dataclasses import asdict
from pathlib import PurePosixPath

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from service.assistant.api.stream import SSE_HEADERS, SSE_MEDIA_TYPE, action_stream
from service.assistant.persistence.invocations import AssistantInvocationConflictError
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.identity.utils import request_user_id
from service.resources.domain.ai import (
    ResourceAction,
    ResourceCommand,
    ResourceScope,
    TranslationTarget,
)
from service.resources.service.ai import ResourceAIService
from service.workbench.domain.selection import (
    SelectionDraftEvidence,
    SelectionEvidenceError,
    SelectionEvidenceReference,
)

RESOURCE_AI_PREFIX = "/api/resource/ai"
MAX_ID = 256
MAX_PATH = 2048
MAX_INSTRUCTION = 4000
MAX_CONTEXT = 40000
HASH_PATTERN = r"^sha256:[0-9a-f]{64}$"


class ResourceSource(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: str = Field(min_length=1, max_length=MAX_ID)
    source_id: str = Field(min_length=1, max_length=MAX_PATH)
    source_revision: str = Field(pattern=HASH_PATTERN)

    @model_validator(mode="after")
    def contained(self):
        path = PurePosixPath(self.source_id)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("source must be project-relative")
        return self


class ResourceSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    locator: dict[str, JsonValue]
    selected_text: str = Field(min_length=1, max_length=MAX_CONTEXT)
    selected_text_hash: str = Field(pattern=HASH_PATTERN)

    @model_validator(mode="after")
    def validate_snapshot(self):
        digest = "sha256:" + hashlib.sha256(self.selected_text.encode("utf-8")).hexdigest()
        if digest != self.selected_text_hash:
            raise ValueError("selection snapshot hash mismatch")
        return self


class ResourceDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    change_version: int = Field(ge=1)
    selected_text: str = Field(min_length=1, max_length=MAX_CONTEXT)
    context_text: str = Field(min_length=1, max_length=MAX_CONTEXT)
    selected_text_hash: str = Field(pattern=HASH_PATTERN)


class ResourceAIRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: ResourceSource
    scope: ResourceScope
    model_key: str = Field(min_length=1, max_length=MAX_ID)
    instruction: str = Field(min_length=1, max_length=MAX_INSTRUCTION)
    client_action_id: str = Field(min_length=1, max_length=MAX_ID)
    client_attempt_id: str = Field(min_length=1, max_length=MAX_ID)
    retry_of_attempt_id: str | None = Field(default=None, max_length=MAX_ID)
    selection: ResourceSelection
    draft: ResourceDraft | None = None
    target_language: TranslationTarget | None = None

    @model_validator(mode="after")
    def validate_scope(self):
        if not self.instruction.strip() or not self.model_key.strip():
            raise ValueError("instruction and model required")
        if (self.scope is ResourceScope.SELECTION) != (self.selection is not None):
            raise ValueError("selection does not match scope")
        if self.draft is not None and self.selection is None:
            raise ValueError("draft requires selection")
        return self

    def command(self, action: ResourceAction, owner_id: str) -> ResourceCommand:
        return ResourceCommand(
            action=action,
            owner_id=owner_id,
            scope=self.scope,
            **self.source.model_dump(),
            model_key=self.model_key,
            instruction=self.instruction.strip(),
            client_action_id=self.client_action_id,
            client_attempt_id=self.client_attempt_id,
            retry_of_attempt_id=self.retry_of_attempt_id,
            selection=(
                SelectionEvidenceReference(
                    **self.source.model_dump(),
                    locator_kind=str(self.selection.locator.get("kind", "")),
                    locator=self.selection.locator,
                    selected_text_hash=self.selection.selected_text_hash,
                )
                if self.selection
                else None
            ),
            selected_text_snapshot=self.selection.selected_text,
            draft=SelectionDraftEvidence(**self.draft.model_dump()) if self.draft else None,
            target_language=self.target_language,
        )


def register_resource_ai_routes(
    app: FastAPI, *, service: ResourceAIService, models: ModelService
) -> None:
    async def submit(body: ResourceAIRequest, request: Request, action: ResourceAction):
        owner = request_user_id(request)
        try:
            models.inference_connection(body.model_key, user_id=owner)
        except SessionModelUnavailableError as error:
            raise HTTPException(422, "resource_model_unavailable") from error
        command = body.command(action, owner)
        if SSE_MEDIA_TYPE in request.headers.get("accept", ""):
            return StreamingResponse(
                action_stream(service, command), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS
            )
        try:
            return asdict(await service.execute(command))
        except SelectionEvidenceError as error:
            raise HTTPException(422, error.code) from error
        except AssistantInvocationConflictError as error:
            raise HTTPException(409, "attempt_conflict") from error

    @app.post(RESOURCE_AI_PREFIX + "/explain")
    async def explain(body: ResourceAIRequest, request: Request):
        return await submit(body, request, ResourceAction.EXPLAIN)

    @app.post(RESOURCE_AI_PREFIX + "/polish")
    async def polish(body: ResourceAIRequest, request: Request):
        return await submit(body, request, ResourceAction.POLISH)

    @app.post(RESOURCE_AI_PREFIX + "/translate")
    async def translate(body: ResourceAIRequest, request: Request):
        if body.target_language is None:
            raise HTTPException(422, "resource_translation_target_required")
        return await submit(body, request, ResourceAction.TRANSLATE)

    @app.get(RESOURCE_AI_PREFIX + "/tasks/{task_id}")
    async def get_task(task_id: str, request: Request):
        result = service.get(task_id, request_user_id(request))
        if result is None:
            raise HTTPException(404, "resource_task_unavailable")
        return asdict(result)

    @app.post(RESOURCE_AI_PREFIX + "/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str, request: Request):
        accepted = await service.cancel(invocation_id=task_id, owner_id=request_user_id(request))
        if not accepted:
            raise HTTPException(404, "resource_task_not_running")
        return {"accepted": True}
