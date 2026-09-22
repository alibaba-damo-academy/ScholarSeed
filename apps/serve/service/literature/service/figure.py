"""Prepare and execute figure explanations through the shared action lifecycle."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import AssistantActionService
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.analysis import (
    FIGURE_PROMPT_VERSION,
    ActionKind,
    AnalysisError,
    AnalysisErrorCode,
    AnalysisRequest,
    PreparedAnalysis,
    prepare,
    read_source,
)
from service.literature.service.pdf import LiteraturePdf
from service.platform.citations import PdfIndexPort
from service.platform.content import ContentPort
from service.platform.inference import ModelInvocationObserver, ModelInvocationStatus


@dataclass(frozen=True)
class FigureCommand:
    owner_id: str
    prepared: PreparedAnalysis


@dataclass(frozen=True)
class FigureResult:
    task_id: str
    invocation_id: str
    status: ModelInvocationStatus
    output: str
    model_key: str
    error_code: str
    error_detail: str
    source_id: str
    source_revision: str
    title: str
    page: int
    rect: tuple[float, float, float, float]
    crop: str


class FigureActionService:
    def __init__(
        self,
        *,
        actions: AssistantActionService,
        tasks: AssistantInvocationStore,
        repository: LiteratureRepository,
        pdf: LiteraturePdf,
        content: ContentPort | None = None,
        indexes: PdfIndexPort | None = None,
    ) -> None:
        self._actions = actions
        self._tasks = tasks
        self._repository = repository
        self._pdf = pdf
        self._content = content
        self._indexes = indexes

    def prepare(self, request: AnalysisRequest) -> PreparedAnalysis:
        if request.kind is not ActionKind.FIGURE:
            raise AnalysisError(AnalysisErrorCode.FIGURE_STREAM_REQUIRED)
        prepared = prepare(
            request,
            self._repository,
            self._pdf,
            self._content,
            indexes=self._indexes,
        )
        if prepared.compiled is None or prepared.request.rect is None:
            raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
        return prepared

    def get(self, invocation_id: str, owner_id: str) -> AssistantInvocationRecord | None:
        record = self._tasks.get(invocation_id, owner_id)
        if record is None or record.prompt_version != FIGURE_PROMPT_VERSION:
            return None
        return record

    async def cancel(self, *, invocation_id: str, owner_id: str) -> bool:
        if self.get(invocation_id, owner_id) is None:
            return False
        return await self._actions.cancel(invocation_id=invocation_id, owner_id=owner_id)

    async def execute(
        self,
        command: FigureCommand,
        *,
        observer: ModelInvocationObserver | None = None,
    ) -> FigureResult:
        prepared = command.prepared
        request = prepared.request
        compiled = prepared.compiled
        if compiled is None or request.rect is None:
            raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
        record = await self._actions.invoke_compiled(
            owner_id=command.owner_id,
            client_action_id=request.client_action_id,
            client_attempt_id=request.client_attempt_id,
            retry_of_attempt_id=None,
            project_id=request.project_id,
            source_id=request.source_id,
            source_revision=prepared.revision,
            evidence_hash=hashlib.sha256(compiled.input_text.encode()).hexdigest(),
            compiled=compiled,
            model_key=request.model_key,
            observer=observer,
        )
        if record.status is ModelInvocationStatus.COMPLETED:
            current, _ = read_source(
                request,
                self._repository,
                self._pdf,
                self._content,
                missing_code=AnalysisErrorCode.LITERATURE_DELETED,
            )
            if hashlib.sha256(current).hexdigest() != prepared.revision:
                raise AnalysisError(AnalysisErrorCode.SOURCE_CHANGED_DURING_GENERATION)
        return FigureResult(
            task_id=record.invocation_id,
            invocation_id=record.invocation_id,
            status=record.status,
            output=record.output_text,
            model_key=record.model_key,
            error_code=record.error_code,
            error_detail=record.error_detail,
            source_id=request.source_id,
            source_revision=prepared.revision,
            title=prepared.title,
            page=request.page,
            rect=request.rect,
            crop=prepared.crop,
        )
