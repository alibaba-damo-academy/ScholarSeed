"""Public PDF AI task API; compilation, execution and result ownership stay separate."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from contextlib import aclosing, suppress
from dataclasses import dataclass, field, replace

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from service.assistant.api.stream import SSE_HEADERS, SSE_MEDIA_TYPE, action_stream
from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import AssistantActionService
from service.chat.service.events import sse_encode
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.content.domain.model import ContentError
from service.identity.utils import request_user_id
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.analysis import (
    ActionKind,
    AnalysisError,
    AnalysisErrorCode,
    AnalysisRequest,
    PreparedAnalysis,
    compile_interpretation_reduction,
    interpretation_input_limit,
    partition_interpretation_summaries,
    prepare,
    read_source,
    split_translation_segment,
    validate_result,
    verify_translation_coverage,
)
from service.literature.service.figure import FigureActionService, FigureCommand
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.preview import PREVIEW_ACTIONS, project_preview
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.citations import PdfIndexPort
from service.platform.content import ContentPort
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationStatus,
)
from service.platform.passive_events import passive_events

PREFIX = "/api/literature/ai"
EVENT_POLL_SECONDS = 0.25
ACTIVE = {ModelInvocationStatus.PENDING, ModelInvocationStatus.RUNNING}
QUEUED_ACTIONS = frozenset({ActionKind.TRANSLATION})
LOGGER = logging.getLogger(__name__)
WORKFLOW_ID_MAX_CHARS = 128
MAX_TRANSLATION_LEAF_RETRIES = 2
MISSING_LITERATURE_CONTENT_ERRORS = frozenset(
    {
        "literature_attachment_missing",
        "literature_pdf_missing",
        "file_not_found",
        "prepared_content_unavailable",
    }
)
RETRYABLE_TRANSLATION_ERRORS = frozenset(
    {
        AnalysisErrorCode.TRANSLATION_INCOMPLETE,
        AnalysisErrorCode.TRANSLATION_CONTENT_MISSING,
        AnalysisErrorCode.TRANSLATION_ALIGNMENT_MISSING,
        AnalysisErrorCode.TRANSLATION_SENTENCE_INCOMPLETE,
    }
)


@dataclass
class AnalysisSlot:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    attempts: int = 0


def workflow_id(root: str, phase: str, index: int | str) -> str:
    suffix = f":{phase}:{index}"
    return f"{root[: WORKFLOW_ID_MAX_CHARS - len(suffix)]}{suffix}"


def failure_detail(error: Exception, fallback: AnalysisErrorCode) -> dict[str, str]:
    if isinstance(error, AnalysisError):
        return {"code": error.code.value, "diagnostic": ""}
    if isinstance(error, SessionModelUnavailableError):
        return {"code": AnalysisErrorCode.MODEL_UNAVAILABLE.value, "diagnostic": ""}
    return {"code": fallback.value, "diagnostic": str(error)}


def preparation_failure_detail(error: Exception) -> dict[str, str]:
    if isinstance(error, ContentError):
        code = (
            AnalysisErrorCode.LITERATURE_MISSING
            if error.code in MISSING_LITERATURE_CONTENT_ERRORS
            else AnalysisErrorCode.SOURCE_INVALID
        )
        return {"code": code.value, "diagnostic": ""}
    return failure_detail(error, AnalysisErrorCode.PREPARATION_FAILED)


def register_analysis_routes(
    app: FastAPI,
    *,
    actions: AssistantActionService,
    activities: Activities,
    tasks: AssistantInvocationStore,
    models: ModelService,
    pdf: LiteraturePdf,
    content: ContentPort | None = None,
    indexes: PdfIndexPort | None = None,
    figures: FigureActionService | None = None,
) -> None:
    repository = LiteratureRepository()
    results = AnalysisStore(repository.database)
    figure_actions = figures or FigureActionService(
        actions=actions,
        tasks=tasks,
        repository=repository,
        pdf=pdf,
        content=content,
        indexes=indexes,
    )
    running: dict[tuple[str, str], asyncio.Task] = {}
    states: dict[tuple[str, str], dict] = {}
    slots: dict[tuple[str, str, str], AnalysisSlot] = {}

    async def admit():
        try:
            activity = activities.enter(ActivityDomain.ACTION, root=True)
        except MaintenanceActive as error:
            raise HTTPException(503, "update_maintenance") from error
        with activity:
            yield

    admission = [Depends(admit)]

    def snapshot(owner: str, task_id: str) -> dict:
        key = (owner, task_id)
        if key in states:
            return states[key]
        record = tasks.get_attempt(task_id, owner)
        if record is None or not record.source_id:
            raise HTTPException(
                404, {"code": AnalysisErrorCode.TASK_MISSING.value, "diagnostic": ""}
            )
        status = record.status.value
        if record.status in ACTIVE and key not in running:
            status = ModelInvocationStatus.UNKNOWN.value
        return {
            "task_id": task_id,
            "status": status,
            "error": record.error_detail or record.error_code,
            "error_code": record.error_code,
            "error_detail": record.error_detail,
            "result": (
                json.loads(record.output_text)
                if record.status == ModelInvocationStatus.COMPLETED and record.output_text
                else None
            ),
        }

    async def check(payload: AnalysisRequest, owner: str) -> PreparedAnalysis:
        try:
            connection = models.inference_connection(payload.model_key, user_id=owner)
            if payload.kind in (ActionKind.FIGURE, ActionKind.FORMULA_LATEX) and not connection.get(
                "image_input"
            ):
                raise AnalysisError(AnalysisErrorCode.IMAGE_INPUT_UNSUPPORTED)
            return await activities.to_thread(
                ActivityDomain.ACTION,
                prepare,
                payload,
                repository,
                pdf,
                content,
                indexes=indexes,
                max_interpretation_chars=interpretation_input_limit(
                    connection.get("context_window")
                ),
            )
        except (ContentError, ValueError, OSError, RuntimeError) as error:
            raise HTTPException(422, preparation_failure_detail(error)) from error

    async def execute(prepared: PreparedAnalysis, owner: str, slot: AnalysisSlot) -> None:
        request = prepared.request
        key = (owner, request.client_attempt_id)
        translated_blocks: list[dict] = []
        acquired = False

        async def invoke(
            compiled,
            *,
            client_action_id: str,
            client_attempt_id: str,
        ) -> AssistantInvocationRecord:
            output = ""

            async def observe(event: ModelInvocationEvent) -> None:
                nonlocal output
                if event.kind is ModelInvocationEventKind.OUTPUT_DELTA:
                    output += event.text
                elif event.kind is ModelInvocationEventKind.OUTPUT_COMPLETED:
                    output = event.text
                else:
                    return
                preview = project_preview(output, request, translated_blocks)
                state = states.get(key)
                if preview and state and state["status"] == ModelInvocationStatus.RUNNING:
                    states[key] = {**state, "preview": preview}

            return await actions.invoke_compiled(
                owner_id=owner,
                client_action_id=client_action_id,
                client_attempt_id=client_attempt_id,
                retry_of_attempt_id=None,
                project_id=request.project_id,
                source_id=request.source_id,
                source_revision=prepared.revision,
                evidence_hash=hashlib.sha256(compiled.input_text.encode()).hexdigest(),
                compiled=compiled,
                model_key=request.model_key,
                **({"observer": observe} if request.kind in PREVIEW_ACTIONS else {}),
            )

        def record_failure(record: AssistantInvocationRecord) -> bool:
            if record.status == ModelInvocationStatus.COMPLETED:
                return False
            code = record.error_code
            if not code and record.status != ModelInvocationStatus.CANCELLED:
                code = AnalysisErrorCode.GENERATION_FAILED.value
            if code != record.error_code:
                tasks.save(replace(record, error_code=code))
            states[key] = {
                "task_id": key[1],
                "status": record.status.value,
                "error": record.error_detail or code,
                "error_code": code,
                "error_detail": record.error_detail,
            }
            return True

        try:
            await slot.lock.acquire()
            acquired = True
            states[key] = {"task_id": key[1], "status": "running"}
            if prepared.segments:
                summaries: list[dict] = []
                cached_segments = 0
                for segment in prepared.segments:
                    states[key] = {
                        "task_id": key[1],
                        "status": "running",
                        "progress": {
                            "phase": "segment",
                            "current": segment.index,
                            "total": segment.total,
                            "cached": cached_segments,
                        },
                    }
                    summary = results.read_segment(
                        request.literature_id,
                        prepared.revision,
                        segment.compiled.prompt_version,
                        request.model_key,
                        segment.content_hash,
                    )
                    if summary is not None:
                        cached_segments += 1
                        summaries.append(summary)
                        LOGGER.info(
                            "pdf_interpretation_segment_cache_hit attempt=%s segment=%s total=%s",
                            key[1],
                            segment.index,
                            segment.total,
                        )
                        continue
                    segment_record = await invoke(
                        segment.compiled,
                        client_action_id=workflow_id(
                            request.client_action_id, "segment", segment.index
                        ),
                        client_attempt_id=workflow_id(
                            request.client_attempt_id, "segment", segment.index
                        ),
                    )
                    if record_failure(segment_record):
                        return
                    segment_result = validate_result(segment_record.output_text, prepared)
                    summary = segment_result["modules"]["summary"]
                    results.publish_segment(
                        request.literature_id,
                        prepared.revision,
                        segment.compiled.prompt_version,
                        request.model_key,
                        segment.content_hash,
                        summary,
                        segment_record.invocation_id,
                    )
                    summaries.append(summary)
                    LOGGER.info(
                        "pdf_interpretation_segment_completed attempt=%s segment=%s total=%s",
                        key[1],
                        segment.index,
                        segment.total,
                    )

                reduction_round = 0
                while True:
                    groups = partition_interpretation_summaries(prepared, summaries)
                    if len(groups) == 1:
                        LOGGER.info(
                            "pdf_interpretation_synthesis_started attempt=%s segments=%s cached=%s",
                            key[1],
                            len(prepared.segments),
                            cached_segments,
                        )
                        states[key] = {
                            "task_id": key[1],
                            "status": "running",
                            "progress": {
                                "phase": "synthesis",
                                "current": len(prepared.segments),
                                "total": len(prepared.segments),
                                "cached": cached_segments,
                            },
                        }
                        compiled = compile_interpretation_reduction(prepared, groups[0])
                        record = await invoke(
                            compiled,
                            client_action_id=request.client_action_id,
                            client_attempt_id=request.client_attempt_id,
                        )
                        break
                    previous_summary_chars = len(json.dumps(summaries, ensure_ascii=False))
                    reduced: list[dict] = []
                    reduction_round += 1
                    for group_index, group in enumerate(groups, 1):
                        states[key] = {
                            "task_id": key[1],
                            "status": "running",
                            "progress": {
                                "phase": "synthesis",
                                "current": group_index,
                                "total": len(groups),
                                "cached": cached_segments,
                            },
                        }
                        compiled = compile_interpretation_reduction(prepared, group)
                        reduction_record = await invoke(
                            compiled,
                            client_action_id=workflow_id(
                                request.client_action_id,
                                f"reduce{reduction_round}",
                                group_index,
                            ),
                            client_attempt_id=workflow_id(
                                request.client_attempt_id,
                                f"reduce{reduction_round}",
                                group_index,
                            ),
                        )
                        if record_failure(reduction_record):
                            return
                        reduced.append(
                            validate_result(reduction_record.output_text, prepared)["modules"][
                                "summary"
                            ]
                        )
                    if (
                        len(reduced) >= len(summaries)
                        and len(json.dumps(reduced, ensure_ascii=False)) >= previous_summary_chars
                    ):
                        raise AnalysisError(AnalysisErrorCode.INPUT_TOO_LARGE)
                    summaries = reduced
            elif request.kind == ActionKind.TRANSLATION:
                segments = prepared.translation_segments
                if not segments:
                    if prepared.compiled is None:
                        raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                    segments = (prepared.compiled,)
                source_languages: set[str] = set()
                root_record: AssistantInvocationRecord | None = None

                async def translate_segment(
                    compiled, path: str, index: int, retry: int = 0
                ) -> bool:
                    nonlocal root_record
                    states[key] = {
                        **states[key],
                        "task_id": key[1],
                        "status": "running",
                        "progress": {
                            "phase": "translation",
                            "current": index,
                            "total": len(segments),
                        },
                    }
                    root_segment = path == "1" and retry == 0
                    attempt_path = f"{path}:retry:{retry}" if retry else path
                    segment_record = await invoke(
                        compiled,
                        client_action_id=(
                            request.client_action_id
                            if root_segment
                            else workflow_id(request.client_action_id, "translation", attempt_path)
                        ),
                        client_attempt_id=(
                            request.client_attempt_id
                            if root_segment
                            else workflow_id(request.client_attempt_id, "translation", attempt_path)
                        ),
                    )
                    if root_segment:
                        root_record = segment_record
                    if record_failure(segment_record):
                        if not root_segment and root_record is not None:
                            tasks.save(
                                replace(
                                    root_record,
                                    status=segment_record.status,
                                    output_text="",
                                    error_code=states[key]["error_code"],
                                    error_detail=segment_record.error_detail,
                                )
                            )
                        return False
                    if root_segment and root_record is not None:
                        tasks.save(
                            replace(
                                root_record,
                                status=ModelInvocationStatus.RUNNING,
                                output_text="",
                            )
                        )
                    try:
                        segment_result = validate_result(segment_record.output_text, prepared)
                        verify_translation_coverage(
                            segment_result["pages"][0]["blocks"],
                            json.loads(compiled.input_text)["document_pages"][0]["text"],
                        )
                    except AnalysisError as error:
                        if error.code not in RETRYABLE_TRANSLATION_ERRORS:
                            raise
                        children = split_translation_segment(request, compiled)
                        if children is None:
                            if retry < MAX_TRANSLATION_LEAF_RETRIES:
                                LOGGER.info(
                                    "pdf_translation_leaf_retry attempt=%s path=%s retry=%s reason=%s",
                                    key[1],
                                    path,
                                    retry + 1,
                                    error.code.value,
                                )
                                return await translate_segment(compiled, path, index, retry + 1)
                            raise
                        LOGGER.info(
                            "pdf_translation_segment_retry attempt=%s path=%s reason=%s",
                            key[1],
                            path,
                            error.code.value,
                        )
                        for suffix, child in zip(("L", "R"), children, strict=True):
                            if not await translate_segment(child, f"{path}{suffix}", index):
                                return False
                        return True
                    source_languages.add(segment_result["source_language"])
                    translated_blocks.extend(segment_result["pages"][0]["blocks"])
                    return True

                for index, compiled in enumerate(segments, 1):
                    if not await translate_segment(compiled, str(index), index):
                        return
                if root_record is None:
                    raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                record = replace(
                    root_record,
                    output_text=json.dumps(
                        {
                            "source_language": (
                                next(iter(source_languages))
                                if len(source_languages) == 1
                                else "mixed"
                            ),
                            "target_language": request.target_language.value,
                            "pages": [{"page": request.page, "blocks": translated_blocks}],
                        },
                        ensure_ascii=False,
                    ),
                )
            else:
                if prepared.compiled is None:
                    raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                record = await invoke(
                    prepared.compiled,
                    client_action_id=request.client_action_id,
                    client_attempt_id=request.client_attempt_id,
                )
            if states.get(key, {}).get("status") == "cancelled":
                tasks.save(replace(record, status=ModelInvocationStatus.CANCELLED, output_text=""))
                return
            if record_failure(record):
                return
            result = validate_result(record.output_text, prepared)
            current, _ = await activities.to_thread(
                ActivityDomain.ACTION,
                read_source,
                request,
                repository,
                pdf,
                content,
                missing_code=AnalysisErrorCode.LITERATURE_DELETED,
            )
            if hashlib.sha256(current).hexdigest() != prepared.revision:
                raise AnalysisError(AnalysisErrorCode.SOURCE_CHANGED_DURING_GENERATION)
            if states.get(key, {}).get("status") == "cancelled":
                tasks.save(replace(record, status=ModelInvocationStatus.CANCELLED, output_text=""))
                return
            if request.literature_id:
                results.publish(result, record.invocation_id)
            tasks.save(replace(record, output_text=json.dumps(result, ensure_ascii=False)))
            states[key] = {"task_id": key[1], "status": "completed", "result": result}
        except asyncio.CancelledError:
            states[key] = {"task_id": key[1], "status": "cancelled"}
            attempt = tasks.get_attempt(key[1], owner)
            if attempt:
                tasks.save(replace(attempt, status=ModelInvocationStatus.CANCELLED, output_text=""))
        except Exception as error:
            failure = failure_detail(error, AnalysisErrorCode.EXECUTION_FAILED)
            states[key] = {
                "task_id": key[1],
                "status": "failed",
                "error": failure["diagnostic"] or failure["code"],
                "error_code": failure["code"],
                "error_detail": failure["diagnostic"],
            }
            attempt = tasks.get_attempt(key[1], owner)
            if attempt:
                tasks.save(
                    replace(
                        attempt,
                        status=ModelInvocationStatus.FAILED,
                        output_text="",
                        error_code=failure["code"],
                        error_detail=failure["diagnostic"],
                    )
                )
            LOGGER.warning(
                "pdf_analysis_failed attempt=%s failure_type=%s", key[1], type(error).__name__
            )
        finally:
            if acquired:
                slot.lock.release()
            if tasks.get_attempt(key[1], owner) is not None:
                states.pop(key, None)

    def finish(
        key: tuple[str, str],
        operation: tuple[str, str, str],
        slot: AnalysisSlot,
        worker: asyncio.Task,
    ) -> None:
        if running.get(key) is not worker:
            return
        running.pop(key, None)
        if worker.cancelled():
            states[key] = {"task_id": key[1], "status": "cancelled"}
        slot.attempts -= 1
        if slot.attempts == 0:
            slots.pop(operation, None)

    @app.post(f"{PREFIX}/preflight", dependencies=admission)
    async def preflight(payload: AnalysisRequest, request: Request) -> dict:
        prepared = await check(payload, request_user_id(request))
        return {
            "ready": True,
            "revision": prepared.revision,
            "pages": prepared.page_count,
            "title": prepared.title,
            "crop": prepared.crop,
        }

    @app.post(f"{PREFIX}/tasks", status_code=202, dependencies=admission)
    async def submit(payload: AnalysisRequest, request: Request) -> dict:
        if payload.kind is ActionKind.FIGURE:
            raise HTTPException(
                422,
                {
                    "code": AnalysisErrorCode.FIGURE_STREAM_REQUIRED.value,
                    "diagnostic": "",
                },
            )
        owner = request_user_id(request)
        key = (owner, payload.client_attempt_id)
        if key in states or tasks.get_attempt(key[1], owner):
            return snapshot(owner, key[1])
        states[key] = {"task_id": key[1], "status": "pending"}
        try:
            prepared = await check(payload, owner)
        except BaseException:
            if states.get(key, {}).get("status") != "cancelled":
                states.pop(key, None)
            raise
        if states[key]["status"] == "cancelled":
            return snapshot(owner, key[1])
        operation = (prepared.request.source_id, prepared.revision, prepared.request.kind.value)
        slot = slots.get(operation)
        if slot is not None and payload.kind not in QUEUED_ACTIONS:
            states.pop(key, None)
            raise HTTPException(
                409, {"code": AnalysisErrorCode.OPERATION_BUSY.value, "diagnostic": ""}
            )
        if slot is None:
            slot = AnalysisSlot()
            slots[operation] = slot
        else:
            LOGGER.info(
                "pdf_analysis_queued attempt=%s kind=%s page=%s ahead=%s",
                key[1],
                payload.kind.value,
                payload.page,
                slot.attempts,
            )
        slot.attempts += 1
        states[key] = {"task_id": key[1], "status": "pending"}
        worker = activities.spawn(ActivityDomain.ACTION, lambda: execute(prepared, owner, slot))
        running[key] = worker
        worker.add_done_callback(lambda completed: finish(key, operation, slot, completed))
        return {**states[key], "crop": prepared.crop}

    @app.post(f"{PREFIX}/figure", dependencies=admission)
    async def figure(payload: AnalysisRequest, request: Request) -> StreamingResponse:
        if payload.kind is not ActionKind.FIGURE or SSE_MEDIA_TYPE not in request.headers.get(
            "accept", ""
        ):
            raise HTTPException(
                422,
                {
                    "code": AnalysisErrorCode.FIGURE_STREAM_REQUIRED.value,
                    "diagnostic": "",
                },
            )
        owner = request_user_id(request)
        try:
            connection = models.inference_connection(payload.model_key, user_id=owner)
            if not connection.get("image_input"):
                raise AnalysisError(AnalysisErrorCode.IMAGE_INPUT_UNSUPPORTED)
            prepared = await activities.to_thread(
                ActivityDomain.ACTION, figure_actions.prepare, payload
            )
        except (AnalysisError, ValueError, OSError, RuntimeError) as error:
            raise HTTPException(
                422, failure_detail(error, AnalysisErrorCode.PREPARATION_FAILED)
            ) from error

        async def stream():
            yield sse_encode(
                {
                    "type": "prepared",
                    "source_id": prepared.request.source_id,
                    "source_revision": prepared.revision,
                    "title": prepared.title,
                    "page": prepared.request.page,
                    "rect": prepared.request.rect,
                    "crop": prepared.crop,
                }
            )
            async with aclosing(
                action_stream(figure_actions, FigureCommand(owner_id=owner, prepared=prepared))
            ) as events:
                async for event in events:
                    yield event

        return StreamingResponse(stream(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)

    @app.post(f"{PREFIX}/figure/{{invocation_id}}/cancel")
    async def cancel_figure(invocation_id: str, request: Request) -> dict:
        accepted = await figure_actions.cancel(
            invocation_id=invocation_id,
            owner_id=request_user_id(request),
        )
        if not accepted:
            raise HTTPException(404, {"code": AnalysisErrorCode.TASK_MISSING.value})
        return {"accepted": True}

    @app.get(f"{PREFIX}/tasks/{{task_id}}")
    async def get_task(task_id: str, request: Request) -> dict:
        return snapshot(request_user_id(request), task_id)

    @app.get(f"{PREFIX}/tasks/{{task_id}}/events")
    async def events(task_id: str, request: Request) -> StreamingResponse:
        owner = request_user_id(request)
        snapshot(owner, task_id)

        async def stream():
            while not await request.is_disconnected():
                state = snapshot(owner, task_id)
                yield f"data: {json.dumps(state, ensure_ascii=False)}\n\n"
                if state["status"] not in ("pending", "running"):
                    break
                await asyncio.sleep(EVENT_POLL_SECONDS)

        return StreamingResponse(
            passive_events(stream(), activities),
            media_type=SSE_MEDIA_TYPE,
            headers=SSE_HEADERS,
        )

    @app.post(f"{PREFIX}/tasks/{{task_id}}/cancel")
    async def cancel(task_id: str, request: Request) -> dict:
        owner = request_user_id(request)
        state = snapshot(owner, task_id)
        key = (owner, task_id)
        if state["status"] in ("pending", "running"):
            states[key] = {"task_id": task_id, "status": "cancelled"}
            worker = running.get(key)
            record = tasks.get_attempt(task_id, owner)
            if record:
                await actions.cancel(invocation_id=record.invocation_id, owner_id=owner)
            if worker:
                if not worker.done() and not worker.cancelling():
                    worker.cancel()
                # Cancellation acknowledges release of the publication slot, so a
                # replacement can be submitted immediately without a 409 race.
                with suppress(asyncio.CancelledError):
                    await worker
        return snapshot(owner, task_id)

    @app.get("/api/literature/{literature_id}/ai/results")
    async def read_results(literature_id: str, source_revision: str) -> dict:
        return results.read(literature_id, source_revision)
