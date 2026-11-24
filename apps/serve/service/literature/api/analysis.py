"""Public PDF AI task API; compilation, execution and result ownership stay separate."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from contextlib import aclosing, suppress
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from service.assistant.api.stream import SSE_HEADERS, SSE_MEDIA_TYPE, action_stream
from service.assistant.persistence.invocations import (
    AssistantInvocationRecord,
    AssistantInvocationStore,
)
from service.assistant.service.actions import AssistantActionKind, AssistantActionService
from service.chat.service.events import sse_encode
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.content.domain.model import ContentError
from service.identity.utils import request_owner_id, request_user_id
from service.literature.persistence.analysis import AnalysisStore
from service.literature.persistence.assets import MaterialAssets
from service.literature.persistence.store import LiteratureRepository
from service.literature.service.analysis import (
    ActionKind,
    AnalysisError,
    AnalysisErrorCode,
    AnalysisRequest,
    AnalysisSubmission,
    PreparedAnalysis,
    ReadingTiming,
    interpretation_input_limit,
    prepare,
    read_source,
    selection_correction,
    split_translation_segment,
    validate_result,
    verify_translation_coverage,
)
from service.literature.service.citations import compile_citation_repair
from service.literature.service.comprehension import (
    EXTRACTION_PURPOSE,
    ComprehensionError,
    ReadingClient,
    comprehend,
    project_saved,
)
from service.literature.service.figure import FigureActionService, FigureCommand
from service.literature.service.interpretation import (
    MAX_READING_REPAIRS,
)
from service.literature.service.interpretation import VERSION as READING_VERSION
from service.literature.service.interpretation import (
    ReadingStream,
    ReadingValidationError,
    abstract_summary,
    compile_reading,
    compile_reading_repair,
    fallback_asset,
    validate_reading,
)
from service.literature.service.joint import (
    JointReadingClient,
    JointStream,
    compile_joint,
    finish_extraction,
    joint_metadata,
)
from service.literature.service.pdf import LiteraturePdf
from service.literature.service.preview import PREVIEW_ACTIONS, project_preview
from service.literature.service.structure import STRUCTURE_VERSION
from service.platform.activity import Activities, ActivityDomain, MaintenanceActive
from service.platform.citations import PdfCitationReader, PdfIndexPort
from service.platform.content import ContentPort
from service.platform.inference import (
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationStatus,
)
from service.platform.passive_events import passive_events
from service.platform.workbench import ArtifactDocumentReader

PREFIX = "/api/literature/ai"
EVENT_POLL_SECONDS = 0.25
ACTIVE = {ModelInvocationStatus.PENDING, ModelInvocationStatus.RUNNING}
QUEUED_ACTIONS = frozenset({ActionKind.TRANSLATION})
LOGGER = logging.getLogger(__name__)
WORKFLOW_ID_MAX_CHARS = 128
MAX_TRANSLATION_LEAF_RETRIES = 2
MAX_SELECTION_LANGUAGE_CORRECTIONS = 1
SELECTION_CORRECTION_PHASE = "selection-language"
SELECTION_VALIDATION_VERSION = "selection-language/v1"
SELECTION_LANGUAGE_ERRORS = frozenset(
    {
        AnalysisErrorCode.TRANSLATION_DIRECTION_MISMATCH,
        AnalysisErrorCode.TRANSLATION_CONTENT_LANGUAGE_MISMATCH,
    }
)
READING_REUSE_PATH = "reused_l1"
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
    task_id: str = ""
    model_key: str = ""


def workflow_id(root: str, phase: str, index: int | str) -> str:
    suffix = f":{phase}:{index}"
    return f"{root[: WORKFLOW_ID_MAX_CHARS - len(suffix)]}{suffix}"


def failure_detail(error: Exception, fallback: AnalysisErrorCode) -> dict[str, str]:
    if isinstance(error, ComprehensionError):
        return {"code": error.code, "diagnostic": error.detail}
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
    results: AnalysisStore | None = None,
    read_citation: PdfCitationReader | None = None,
    read_artifact: ArtifactDocumentReader | None = None,
) -> None:
    repository = LiteratureRepository()
    results = results or AnalysisStore(repository.database)
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
    slots: dict[tuple[str, str, str, str], AnalysisSlot] = {}
    active_invocations: dict[tuple[str, str], set[str]] = {}

    async def admit():
        try:
            activity = activities.enter(ActivityDomain.ACTION, root=True)
        except MaintenanceActive as error:
            raise HTTPException(503, "update_maintenance") from error
        with activity:
            yield

    admission = [Depends(admit)]

    def check_service_instance(expected: str | None) -> None:
        if expected is not None and expected != activities.instance_id:
            raise HTTPException(
                409, {"code": AnalysisErrorCode.SERVICE_INSTANCE_CHANGED.value, "diagnostic": ""}
            )

    def joined_attempt(owner: str, attempt_id: str) -> tuple[str, str] | None:
        if (owner, attempt_id) in states:
            return None
        return results.joined_attempt(owner, attempt_id)

    def snapshot(owner: str, task_id: str, *, accepted_join: bool = False) -> dict:
        key = (owner, task_id)
        if key in states:
            return states[key]
        record = tasks.get_attempt(task_id, owner)
        if record is None or not record.source_id:
            if accepted_join:
                # The shared execution might have stopped before persisting its own receipt.
                return {"task_id": task_id, "status": ModelInvocationStatus.UNKNOWN.value}
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

    def attempt_snapshot(owner: str, attempt_id: str) -> dict:
        alias = joined_attempt(owner, attempt_id)
        if alias:
            return {**joined_snapshot(owner, alias), "task_id": attempt_id}
        return snapshot(owner, attempt_id)

    def joined_snapshot(owner: str, alias: tuple[str, str]) -> dict:
        task_id, model_key = alias
        return {**snapshot(owner, task_id, accepted_join=True), "model_key": model_key}

    def source_reader(principal: str):
        reader = read_citation
        return (lambda source: reader(source, principal)) if reader is not None else None

    def artifact_reader(principal: str):
        reader = read_artifact
        return (lambda source: reader(source, principal)) if reader is not None else None

    async def check(payload: AnalysisRequest, owner: str, principal: str) -> PreparedAnalysis:
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
                load_l1=results.reading_l1,
                citation_reader=source_reader(principal),
                artifact_reader=artifact_reader(principal),
                image_input=connection.get("image_input") is True,
                max_interpretation_chars=interpretation_input_limit(
                    connection.get("context_window")
                ),
            )
        except (ContentError, ValueError, OSError, RuntimeError) as error:
            raise HTTPException(422, preparation_failure_detail(error)) from error

    async def execute(
        prepared: PreparedAnalysis,
        owner: str,
        slot: AnalysisSlot,
        submitted_at: float,
        preparation_seconds: float,
        principal: str,
    ) -> None:
        request = prepared.request
        key = (owner, request.client_attempt_id)
        translated_blocks: list[dict] = []
        reading_stream: ReadingStream | None = None
        joint_stream: JointStream | None = None
        joint_result: dict | None = None
        joint_client: JointReadingClient | None = None
        joint_repair_attempts: list[str] = []
        citation_repair_attempts: list[str] = []
        citation_repair_diagnostic = ""
        citation_repair_task: asyncio.Task | None = None
        started = time.monotonic()
        first_item_seconds: float | None = None
        acquired = False
        invocation_details: dict[str, dict] = {}
        reading_attempts: list[dict] = []

        def reading_diagnostics() -> dict:
            return {
                "reading_path": READING_REUSE_PATH,
                "reading_retries": max(0, len(reading_attempts) - 1),
                "reading_attempts": reading_attempts,
            }

        async def verify_current_source() -> None:
            current, _ = await activities.to_thread(
                ActivityDomain.ACTION,
                read_source,
                request,
                repository,
                pdf,
                content,
                missing_code=AnalysisErrorCode.LITERATURE_DELETED,
                citation_reader=source_reader(principal),
                artifact_reader=artifact_reader(principal),
            )
            if hashlib.sha256(current).hexdigest() != prepared.revision:
                raise AnalysisError(AnalysisErrorCode.SOURCE_CHANGED_DURING_GENERATION)

        def diagnostics(records: list, *, complete: bool = True) -> dict:
            now = time.monotonic()
            return {
                "task_id": key[1],
                "ui_timing": states.get(key, {}).get("ui_timing", {}),
                "preparation_seconds": round(preparation_seconds, 3),
                "preparation_stages": prepared.preparation_stages or {},
                "preparation_diagnostic": (
                    prepared.reading.snapshot.get("preparation_diagnostic", {})
                    if prepared.reading
                    else {}
                ),
                "request_seconds": round(now - submitted_at, 3) if complete else None,
                "index_cache_hit": prepared.index_cache_hit,
                "invocations": [
                    {
                        "id": item.invocation_id,
                        "model_key": item.model_key,
                        "prompt_version": item.prompt_version,
                        "status": item.status.value,
                        "input_tokens": item.input_tokens or None,
                        "output_tokens": item.output_tokens or None,
                        "receipt_id": item.receipt_id,
                        **invocation_details.get(item.invocation_id, {}),
                    }
                    for item in records
                    if item is not None
                ],
            }

        def finish_joint(
            record: AssistantInvocationRecord, status: str, diagnostic: str = ""
        ) -> None:
            nonlocal joint_result
            assert joint_result is not None
            records = [record] + [
                tasks.get_attempt(attempt, owner)
                for attempt in [*citation_repair_attempts, *joint_repair_attempts]
            ]
            joint_result = {
                **joint_result,
                "generation_output": joint_stream.output if joint_stream else record.output_text,
                "metadata": {
                    **joint_result["metadata"],
                    "l1_status": status,
                    "l1_diagnostic": diagnostic,
                    "provider_status": record.status.value,
                    "l1_attempts": 1 + len(joint_repair_attempts),
                    "l1_retries": len(joint_repair_attempts),
                    "citation_retries": len(citation_repair_attempts),
                    "citation_diagnostic": citation_repair_diagnostic,
                    "l1_initial_diagnostic": (
                        joint_client.initial_diagnostic if joint_client else ""
                    ),
                    **(joint_client.retry_metadata() if joint_client else {}),
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "usage": {
                        "input_tokens": (
                            sum(item.input_tokens for item in records if item is not None)
                            if all(item is not None and item.input_tokens > 0 for item in records)
                            else None
                        ),
                        "output_tokens": (
                            sum(item.output_tokens for item in records if item is not None)
                            if all(item is not None and item.output_tokens > 0 for item in records)
                            else None
                        ),
                        "calls": len(records),
                    },
                    **diagnostics(records),
                },
            }
            if request.literature_id:
                results.publish(joint_result, record.invocation_id)
            tasks.save(
                replace(
                    record,
                    status=ModelInvocationStatus.COMPLETED,
                    output_text=json.dumps(joint_result, ensure_ascii=False),
                    error_code="",
                    error_detail="",
                )
            )
            states[key] = {
                "task_id": key[1],
                "status": "completed",
                "reading_complete": True,
                "result": joint_result,
            }
            LOGGER.info(
                "pdf_reading_joint_finished attempt=%s l1_status=%s elapsed=%s first_item=%s diagnostic=%s",
                key[1],
                status,
                joint_result["metadata"]["elapsed_seconds"],
                first_item_seconds,
                diagnostic,
            )

        async def publish_joint(invocation_id: str) -> None:
            nonlocal joint_result
            await verify_current_source()
            if states.get(key, {}).get("status") != "running":
                raise asyncio.CancelledError
            if joint_result is not None:
                return
            if joint_stream is None or prepared.reading is None:
                raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
            joint_result = validate_result(
                json.dumps(
                    {
                        "modules": {"summary": joint_stream.summary},
                        "content": joint_stream.summary,
                        "source_snapshot": prepared.reading.snapshot,
                        "reading_output": joint_stream.reading_output,
                        "metadata": {
                            **joint_metadata(prepared.reading),
                            **diagnostics([], complete=False),
                            "generated_at": datetime.now(timezone.utc).isoformat(),
                            "model_key": request.model_key,
                            "task_id": key[1],
                            "first_item_seconds": first_item_seconds,
                            "reading_seconds": round(time.monotonic() - started, 3),
                            "elapsed_seconds": round(time.monotonic() - started, 3),
                            "usage": {
                                "input_tokens": None,
                                "output_tokens": None,
                                "calls": 1,
                            },
                        },
                    },
                    ensure_ascii=False,
                ),
                prepared,
            )
            if request.literature_id:
                results.publish(joint_result, invocation_id)
            states[key] = {
                **states[key],
                "reading_complete": True,
                "result": joint_result,
            }

        def start_citation_repair(invocation_id: str) -> None:
            nonlocal citation_repair_task
            if citation_repair_task is not None or joint_stream is None:
                return
            activeStream = joint_stream
            repair = compile_citation_repair(activeStream)
            if repair is None or states.get(key, {}).get("status") != "running":
                return

            async def recover() -> None:
                nonlocal citation_repair_diagnostic
                await verify_current_source()
                if states.get(key, {}).get("status") != "running":
                    raise asyncio.CancelledError
                attempt = workflow_id(request.client_attempt_id, "citations", 1)
                citation_repair_attempts.append(attempt)
                try:
                    repaired = await invoke(
                        repair.compiled,
                        client_action_id=workflow_id(request.client_action_id, "citations", 1),
                        client_attempt_id=attempt,
                        reading_preview=False,
                    )
                    if states.get(key, {}).get("status") != "running":
                        raise asyncio.CancelledError
                    if repaired.status is not ModelInvocationStatus.COMPLETED:
                        raise ComprehensionError(repaired.error_code or repaired.status.value)
                    repair.apply(activeStream, repaired.output_text)
                except (ValueError, RuntimeError) as error:
                    citation_repair_diagnostic = str(error)
                    LOGGER.warning(
                        "pdf_reading_citation_repair_failed attempt=%s diagnostic=%s",
                        attempt,
                        error,
                    )
                    return
                await publish_joint(invocation_id)

            # The task belongs to this execution and is always joined before its slot is released.
            citation_repair_task = activities.spawn(ActivityDomain.ACTION, recover)

        async def invoke(
            compiled,
            *,
            client_action_id: str,
            client_attempt_id: str,
            reading_preview: bool = True,
            retry_of_attempt_id: str | None = None,
        ) -> AssistantInvocationRecord:
            output = ""
            accepted_id: str | None = None
            invocation_started = time.monotonic()

            async def observe(event: ModelInvocationEvent) -> None:
                nonlocal output, first_item_seconds, joint_result, accepted_id
                if event.kind is ModelInvocationEventKind.ACCEPTED:
                    accepted_id = event.invocation_id
                    active_invocations.setdefault(key, set()).add(event.invocation_id)
                    if states.get(key, {}).get("status") == "cancelled":
                        await actions.cancel(invocation_id=event.invocation_id, owner_id=owner)
                        raise asyncio.CancelledError
                if request.kind is ActionKind.INTERPRETATION:
                    if not reading_preview:
                        return
                    if (
                        joint_stream is not None
                        and event.kind is ModelInvocationEventKind.OUTPUT_DELTA
                    ):
                        preview = joint_stream.feed(event.text)
                        start_citation_repair(event.invocation_id)
                        state = states.get(key)
                        if preview and state and state["status"] == "running":
                            if first_item_seconds is None:
                                first_item_seconds = round(time.monotonic() - started, 3)
                            states[key] = {**state, "preview": preview}
                        if (
                            joint_stream.summary is not None
                            and joint_result is None
                            and states.get(key, {}).get("status") == "running"
                        ):
                            await publish_joint(event.invocation_id)
                        return
                    if (
                        reading_stream is not None
                        and event.kind is ModelInvocationEventKind.OUTPUT_DELTA
                    ):
                        preview = reading_stream.feed(event.text)
                        state = states.get(key)
                        if preview and state and state["status"] == "running":
                            if first_item_seconds is None:
                                first_item_seconds = round(time.monotonic() - started, 3)
                            states[key] = {**state, "preview": preview}
                    return
                if event.kind is ModelInvocationEventKind.OUTPUT_DELTA:
                    output += event.text
                elif event.kind is ModelInvocationEventKind.OUTPUT_COMPLETED:
                    output = event.text
                else:
                    return
                preview = project_preview(
                    output, request, translated_blocks, prepared.translation_structure
                )
                state = states.get(key)
                if preview and state and state["status"] == ModelInvocationStatus.RUNNING:
                    states[key] = {**state, "preview": preview}

            try:
                return await actions.invoke_compiled(
                    owner_id=owner,
                    client_action_id=client_action_id,
                    client_attempt_id=client_attempt_id,
                    retry_of_attempt_id=retry_of_attempt_id,
                    project_id=request.project_id,
                    source_id=request.source_id,
                    source_revision=prepared.revision,
                    evidence_hash=hashlib.sha256(compiled.input_text.encode()).hexdigest(),
                    compiled=compiled,
                    model_key=request.model_key,
                    **(
                        {"observer": observe}
                        if request.kind in PREVIEW_ACTIONS
                        or request.kind is ActionKind.INTERPRETATION
                        else {}
                    ),
                )
            finally:
                if accepted_id:
                    active_invocations.get(key, set()).discard(accepted_id)
                    invocation_details[accepted_id] = {
                        "elapsed_seconds": round(time.monotonic() - invocation_started, 3),
                        "start_seconds": round(invocation_started - started, 3),
                    }

        def record_failure(record: AssistantInvocationRecord) -> bool:
            if record.status == ModelInvocationStatus.COMPLETED:
                return False
            if joint_stream is not None and joint_stream.output and not record.output_text:
                record = replace(record, output_text=joint_stream.output)
                tasks.save(record)
            code = record.error_code
            if not code and record.status != ModelInvocationStatus.CANCELLED:
                code = AnalysisErrorCode.GENERATION_FAILED.value
            if code != record.error_code:
                tasks.save(replace(record, error_code=code))
            states[key] = {
                **states.get(key, {}),
                "task_id": key[1],
                "status": record.status.value,
                "error": record.error_detail or code,
                "error_code": code,
                "error_detail": record.error_detail,
            }
            return True

        selection_workflow: AssistantInvocationRecord | None = None
        try:
            await slot.lock.acquire()
            acquired = True
            states[key] = {"task_id": key[1], "status": "running"}
            if request.kind is ActionKind.WORD_TRANSLATION:
                selection_workflow, _ = tasks.claim(
                    AssistantInvocationRecord(
                        invocation_id=uuid.uuid4().hex,
                        owner_id=owner,
                        client_action_id=request.client_action_id,
                        client_attempt_id=request.client_attempt_id,
                        retry_of_attempt_id=None,
                        kind=AssistantActionKind.COMPILED.value,
                        request_hash=hashlib.sha256(request.model_dump_json().encode()).hexdigest(),
                        project_id=request.project_id,
                        source_id=request.source_id,
                        source_revision=prepared.revision,
                        prompt_version=(
                            prepared.compiled.prompt_version if prepared.compiled else ""
                        ),
                        status=ModelInvocationStatus.RUNNING,
                        target_language=request.target_language.value,
                        model_key=request.model_key,
                    )
                )
            if request.kind is ActionKind.INTERPRETATION and prepared.saved_reading is None:
                if prepared.reading is None:
                    raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                plan = compile_joint(prepared.reading)
                joint_stream = JointStream(plan)
                states[key] = {**states[key], "progress": {"phase": "organize"}}
                record = await invoke(
                    plan.compiled,
                    client_action_id=request.client_action_id,
                    client_attempt_id=request.client_attempt_id,
                )
                if states.get(key, {}).get("status") == "cancelled":
                    raise asyncio.CancelledError
                # A provider may deliver its response as one completion event.
                if joint_result is None and record.status is ModelInvocationStatus.COMPLETED:
                    joint_stream.feed(record.output_text if not joint_stream.output else "")
                    start_citation_repair(record.invocation_id)
                if citation_repair_task is not None:
                    await citation_repair_task
                if joint_result is None and joint_stream.summary is not None:
                    await publish_joint(record.invocation_id)
                if joint_result is None:
                    if record_failure(record):
                        return
                    if not joint_stream.paper_type:
                        raise ComprehensionError(
                            joint_stream.error or "pdf_ai_interpretation_incomplete"
                        )
                if joint_result is not None and not states.get(key, {}).get("reading_complete"):
                    if request.literature_id:
                        results.publish(joint_result, record.invocation_id)
                    states[key] = {**states[key], "reading_complete": True, "result": joint_result}
                if record.status is not ModelInvocationStatus.COMPLETED:
                    finish_joint(record, "failed", record.error_code or record.status.value)
                    return
                await verify_current_source()

                async def repair_l1(compiled, number: int) -> AssistantInvocationRecord:
                    if states.get(key, {}).get("status") == "cancelled":
                        raise asyncio.CancelledError
                    await verify_current_source()
                    attempt = workflow_id(request.client_attempt_id, "l1", number)
                    joint_repair_attempts.append(attempt)
                    LOGGER.info("pdf_reading_l1_repair attempt=%s child=%s", key[1], attempt)
                    return await invoke(
                        compiled,
                        client_action_id=workflow_id(request.client_action_id, "l1", number),
                        client_attempt_id=attempt,
                        reading_preview=False,
                    )

                joint_client = JointReadingClient(prepared.reading, repair_l1, record)
                try:
                    extracted = await finish_extraction(
                        prepared.reading, joint_client, joint_stream.paper_type
                    )
                except Exception as error:
                    if isinstance(error, ComprehensionError) and error.diagnostics:
                        await asyncio.to_thread(
                            MaterialAssets(results.database).save_failure,
                            prepared.reading.snapshot["source_revision"],
                            prepared.reading.language,
                            error.diagnostics,
                        )
                    await verify_current_source()
                    if joint_result is None:
                        raise ComprehensionError(
                            joint_stream.error or "pdf_ai_interpretation_incomplete"
                        ) from error
                    finish_joint(record, "failed", str(error))
                    return
                await verify_current_source()
                if states.get(key, {}).get("status") == "cancelled":
                    raise asyncio.CancelledError
                if joint_result is None:
                    if request.literature_id:
                        results.save_l1(
                            request.literature_id,
                            prepared.revision,
                            request.attachment_id,
                            {
                                **extracted,
                                "source_snapshot": prepared.reading.snapshot,
                                "revision": prepared.revision,
                                "literature_id": request.literature_id,
                                "attachment_id": request.attachment_id,
                                "response_language": request.response_language.value,
                                "metadata": {
                                    **joint_metadata(prepared.reading),
                                    "l1_status": "ready",
                                    "model_key": request.model_key,
                                    "task_id": key[1],
                                    "l1_attempts": len(joint_client.records),
                                    "l1_retries": len(joint_repair_attempts),
                                    **joint_client.retry_metadata(),
                                },
                            },
                            record.invocation_id,
                        )
                    raise ComprehensionError(
                        joint_stream.error or "pdf_ai_interpretation_incomplete"
                    )
                joint_result = {
                    **joint_result,
                    **extracted,
                    "metadata": {**joint_result["metadata"], "l1_status": "ready"},
                }
                if request.literature_id:
                    results.save_l1(
                        request.literature_id,
                        prepared.revision,
                        request.attachment_id,
                        joint_result,
                        record.invocation_id,
                    )
                finish_joint(record, "ready")
                return
            elif request.kind is ActionKind.INTERPRETATION:
                if prepared.reading is None:
                    raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                root_record: AssistantInvocationRecord | None = None

                async def invoke_reading(compiled, number: int) -> AssistantInvocationRecord:
                    nonlocal root_record
                    if states.get(key, {}).get("status") == "cancelled":
                        raise asyncio.CancelledError
                    states[key] = {
                        **states[key],
                        "task_id": key[1],
                        "status": "running",
                        "progress": {
                            "phase": (
                                "classify"
                                if number == 1
                                else "extract" if number == 2 else "repair"
                            ),
                            "current": number,
                            "total": 3,
                            "cached": 0,
                        },
                    }
                    child = await invoke(
                        compiled,
                        client_action_id=(
                            request.client_action_id
                            if number == 1
                            else workflow_id(request.client_action_id, "l1", number)
                        ),
                        client_attempt_id=(
                            request.client_attempt_id
                            if number == 1
                            else workflow_id(request.client_attempt_id, "l1", number)
                        ),
                    )
                    active_invocations.pop(key, None)
                    if states.get(key, {}).get("status") == "cancelled":
                        raise asyncio.CancelledError
                    if number == 1:
                        root_record = child
                        if child.status is ModelInvocationStatus.COMPLETED:
                            tasks.save(
                                replace(child, status=ModelInvocationStatus.RUNNING, output_text="")
                            )
                    return child

                client = ReadingClient(prepared.reading, invoke_reading)
                try:
                    result = prepared.saved_reading
                    reused = result is not None
                    if result is None:
                        result = await comprehend(prepared.reading, client)
                        result = {
                            **result,
                            "literature_id": request.literature_id,
                            "attachment_id": request.attachment_id,
                            "revision": prepared.revision,
                            "response_language": request.response_language.value,
                        }
                        results.save_l1(
                            request.literature_id,
                            prepared.revision,
                            request.attachment_id,
                            result,
                            client.records[-1].invocation_id,
                        )
                    plan = compile_reading(result, prepared.reading)
                    reading_stream = ReadingStream(plan)
                    compiled = plan.compiled
                    retry = 0
                    while True:
                        if states.get(key, {}).get("status") == "cancelled":
                            raise asyncio.CancelledError
                        if retry:
                            await verify_current_source()
                            if states.get(key, {}).get("status") == "cancelled":
                                raise asyncio.CancelledError
                        states[key] = {
                            **states[key],
                            "progress": {"phase": "repair" if retry else "organize"},
                        }
                        organized = await invoke(
                            compiled,
                            client_action_id=(
                                workflow_id(request.client_action_id, "reading-repair", retry)
                                if retry
                                else (
                                    workflow_id(request.client_action_id, "reading", 1)
                                    if root_record
                                    else request.client_action_id
                                )
                            ),
                            client_attempt_id=(
                                workflow_id(request.client_attempt_id, "reading-repair", retry)
                                if retry
                                else (
                                    workflow_id(request.client_attempt_id, "reading", 1)
                                    if root_record
                                    else request.client_attempt_id
                                )
                            ),
                            reading_preview=not retry,
                        )
                        client.records.append(organized)
                        root_record = root_record or organized
                        attempt_detail: dict[str, object] = {
                            "attempt_id": organized.client_attempt_id,
                            "provider_status": organized.status.value,
                            "provider_error_code": organized.error_code,
                            "validation_errors": [],
                        }
                        reading_attempts.append(attempt_detail)
                        if (
                            organized.status is ModelInvocationStatus.CANCELLED
                            or states.get(key, {}).get("status") == "cancelled"
                        ):
                            raise asyncio.CancelledError
                        if organized.status is not ModelInvocationStatus.COMPLETED:
                            raise ComprehensionError(
                                organized.error_code or AnalysisErrorCode.GENERATION_FAILED.value
                            )
                        try:
                            summary, rejected = validate_reading(organized.output_text, plan)
                            break
                        except ReadingValidationError as error:
                            attempt_detail["validation_errors"] = error.issues
                            LOGGER.warning(
                                "pdf_reading_validation_failed attempt=%s path=%s retry=%s "
                                "provider_status=%s issues=%s",
                                organized.client_attempt_id,
                                READING_REUSE_PATH,
                                retry,
                                organized.status.value,
                                json.dumps(error.issues, ensure_ascii=False),
                            )
                            if retry == MAX_READING_REPAIRS:
                                raise
                            compiled = compile_reading_repair(plan, error)
                            # The root task remains active until final admission;
                            # neither invalid output nor a repair replaces old assets.
                            tasks.save(replace(root_record, status=ModelInvocationStatus.RUNNING))
                            retry += 1
                    records = client.records
                    result = {
                        **result,
                        "modules": {"summary": summary},
                        "content": summary,
                        "reading_output": organized.output_text,
                        "metadata": {
                            **result.get("metadata", {}),
                            "reading_version": READING_VERSION,
                            "generated_at": datetime.now(timezone.utc).isoformat(),
                            "l1_reused": reused,
                            **reading_diagnostics(),
                            **(
                                {
                                    "l1_status": "ready",
                                    "l1_attempts": 0,
                                    "l1_retries": 0,
                                    "citation_retries": 0,
                                    "l1_diagnostic": "",
                                    "citation_diagnostic": "",
                                    "l1_initial_diagnostic": "",
                                    "l1_retry_mode": None,
                                    "l1_retry_includes_original": None,
                                }
                                if reused
                                else {}
                            ),
                            "l1_usage": result.get("metadata", {}).get(
                                "l1_usage", result.get("metadata", {}).get("usage")
                            ),
                            "elapsed_seconds": round(time.monotonic() - started, 3),
                            "first_item_seconds": first_item_seconds,
                            "omitted_fields": plan.omitted,
                            "skipped_items": rejected,
                            "usage": {
                                "input_tokens": (
                                    sum(r.input_tokens for r in records)
                                    if all(r.input_tokens > 0 for r in records)
                                    else None
                                ),
                                "output_tokens": (
                                    sum(r.output_tokens for r in records)
                                    if all(r.output_tokens > 0 for r in records)
                                    else None
                                ),
                                "calls": len(records),
                            },
                            "reading_seconds": round(time.monotonic() - started, 3),
                            **diagnostics(records),
                        },
                    }
                except Exception:
                    last = client.records[-1] if client.records else None
                    if last is None or last.status is ModelInvocationStatus.COMPLETED:
                        raise
                    failed = replace(
                        root_record or last,
                        status=last.status,
                        output_text=(root_record or last).output_text,
                        error_code=last.error_code,
                        error_detail=(
                            json.dumps(
                                {**reading_diagnostics(), "provider_diagnostic": last.error_detail},
                                ensure_ascii=False,
                            )
                            if reading_attempts
                            else last.error_detail
                        ),
                    )
                    tasks.save(failed)
                    record_failure(failed)
                    return
                if root_record is None:
                    raise AnalysisError(AnalysisErrorCode.GENERATION_FAILED)
                result["metadata"].update(
                    {
                        "literature_id": request.literature_id,
                        "attachment_id": request.attachment_id,
                        "source_revision": prepared.revision,
                        "model_key": request.model_key,
                        "task_id": key[1],
                    }
                )
                record = replace(
                    root_record,
                    status=ModelInvocationStatus.COMPLETED,
                    output_text=json.dumps(result, ensure_ascii=False),
                )
            elif request.kind == ActionKind.TRANSLATION:
                segments = prepared.translation_segments
                if not segments:
                    if prepared.compiled is None:
                        raise AnalysisError(AnalysisErrorCode.PREPARATION_FAILED)
                    segments = (prepared.compiled,)
                source_languages: set[str] = set()
                root_record = None

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
                        source_ids = {
                            block["block_id"]
                            for block in json.loads(compiled.input_text).get("source_blocks", ())
                        }
                        segment_prepared = (
                            replace(
                                prepared,
                                translation_structure=tuple(
                                    block
                                    for block in prepared.translation_structure
                                    if block["block_id"] in source_ids
                                ),
                            )
                            if source_ids
                            else prepared
                        )
                        segment_result = validate_result(
                            segment_record.output_text, segment_prepared
                        )
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
                    client_attempt_id=(
                        workflow_id(request.client_attempt_id, SELECTION_CORRECTION_PHASE, 0)
                        if selection_workflow is not None
                        else request.client_attempt_id
                    ),
                )
            if states.get(key, {}).get("status") == "cancelled":
                tasks.save(
                    replace(
                        selection_workflow or record,
                        status=ModelInvocationStatus.CANCELLED,
                        output_text="",
                    )
                )
                return
            if record_failure(record):
                if selection_workflow is not None:
                    tasks.save(
                        replace(
                            selection_workflow,
                            status=record.status,
                            error_code=states[key].get("error_code", ""),
                            error_detail=record.error_detail,
                        )
                    )
                return
            root_record = selection_workflow or record
            language_attempts: list[dict] = []
            selection_result: dict | None = None
            for correction in range(MAX_SELECTION_LANGUAGE_CORRECTIONS + 1):
                try:
                    selection_result = validate_result(record.output_text, prepared)
                    break
                except AnalysisError as error:
                    if (
                        request.kind is not ActionKind.WORD_TRANSLATION
                        or error.code not in SELECTION_LANGUAGE_ERRORS
                    ):
                        raise
                    language_attempts.append(
                        {
                            "invocation_id": record.invocation_id,
                            "status": "rejected",
                            "error_code": error.code.value,
                            "response_sha256": hashlib.sha256(
                                record.output_text.encode()
                            ).hexdigest(),
                        }
                    )
                    tasks.save(
                        replace(
                            record, status=ModelInvocationStatus.FAILED, error_code=error.code.value
                        )
                    )
                    LOGGER.warning(
                        "pdf_selection_language_rejected attempt=%s invocation=%s target=%s reason=%s correction=%s",
                        key[1],
                        record.invocation_id,
                        request.target_language.value,
                        error.code.value,
                        correction,
                    )
                    if correction == MAX_SELECTION_LANGUAGE_CORRECTIONS:
                        raise
                    if states.get(key, {}).get("status") == "cancelled":
                        raise asyncio.CancelledError
                    await verify_current_source()
                    states[key] = {**states[key], "preview": {}}
                    record = await invoke(
                        selection_correction(prepared),
                        client_action_id=request.client_action_id,
                        client_attempt_id=workflow_id(
                            request.client_attempt_id, SELECTION_CORRECTION_PHASE, correction + 1
                        ),
                        retry_of_attempt_id=record.client_attempt_id,
                    )
                    if states.get(key, {}).get("status") == "cancelled":
                        raise asyncio.CancelledError
                    if record_failure(record):
                        tasks.save(
                            replace(
                                root_record,
                                status=record.status,
                                output_text="",
                                error_code=record.error_code,
                                error_detail=record.error_detail,
                            )
                        )
                        return
            if selection_result is None:
                raise AnalysisError(AnalysisErrorCode.RESULT_REJECTED)
            if request.kind is ActionKind.WORD_TRANSLATION:
                language_attempts.append(
                    {"invocation_id": record.invocation_id, "status": "accepted"}
                )
                selection_result["client_attempt_id"] = request.client_attempt_id
                selection_result["translation_validation"] = {
                    "version": SELECTION_VALIDATION_VERSION,
                    "corrections": len(language_attempts) - 1,
                    "attempts": language_attempts,
                }
                record = replace(
                    root_record,
                    status=ModelInvocationStatus.COMPLETED,
                    target_language=request.target_language.value,
                    detected_source_language=selection_result["source_language"],
                    error_code="",
                    error_detail="",
                )
            await verify_current_source()
            if states.get(key, {}).get("status") == "cancelled":
                tasks.save(replace(record, status=ModelInvocationStatus.CANCELLED, output_text=""))
                return
            if request.literature_id:
                results.publish(selection_result, record.invocation_id)
            tasks.save(
                replace(record, output_text=json.dumps(selection_result, ensure_ascii=False))
            )
            states[key] = {"task_id": key[1], "status": "completed", "result": selection_result}
        except asyncio.CancelledError:
            if joint_result is not None:
                attempt = tasks.get_attempt(key[1], owner)
                if attempt:
                    finish_joint(attempt, "cancelled", "cancelled_after_reading")
                    return
            states[key] = {**states.get(key, {}), "task_id": key[1], "status": "cancelled"}
            attempt = tasks.get_attempt(key[1], owner)
            if attempt:
                tasks.save(replace(attempt, status=ModelInvocationStatus.CANCELLED, output_text=""))
        except Exception as error:
            failure = failure_detail(error, AnalysisErrorCode.EXECUTION_FAILED)
            if reading_attempts:
                failure["diagnostic"] = json.dumps(
                    {**reading_diagnostics(), "diagnostic": failure["diagnostic"]},
                    ensure_ascii=False,
                )
            if joint_result is not None and failure["code"] not in (
                AnalysisErrorCode.SOURCE_CHANGED_DURING_GENERATION.value,
                AnalysisErrorCode.LITERATURE_DELETED.value,
            ):
                attempt = tasks.get_attempt(key[1], owner)
                if attempt:
                    finish_joint(attempt, "failed", failure["diagnostic"] or failure["code"])
                    return
            states[key] = {
                **states.get(key, {}),
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
                        # Retain the provider response for diagnosis, never publish
                        # it as a reading asset or return it as a completed result.
                        output_text=(
                            json.dumps(
                                {
                                    "stream_output": joint_stream.output,
                                    "provider_output": attempt.output_text,
                                    "citation_repair_attempts": citation_repair_attempts,
                                    "citation_repair_diagnostic": citation_repair_diagnostic,
                                },
                                ensure_ascii=False,
                            )
                            if joint_stream is not None
                            else attempt.output_text if reading_stream is not None else ""
                        ),
                        error_code=failure["code"],
                        error_detail=failure["diagnostic"],
                    )
                )
            LOGGER.warning(
                "pdf_analysis_failed attempt=%s failure_type=%s", key[1], type(error).__name__
            )
        finally:
            if citation_repair_task is not None:
                if not citation_repair_task.done():
                    citation_repair_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await citation_repair_task
            active_invocations.pop(key, None)
            if acquired:
                slot.lock.release()
            if tasks.get_attempt(key[1], owner) is not None and not states.get(key, {}).get(
                "preview"
            ):
                states.pop(key, None)

    def finish(
        key: tuple[str, str],
        operation: tuple[str, str, str, str],
        slot: AnalysisSlot,
        worker: asyncio.Task,
    ) -> None:
        if running.get(key) is not worker:
            return
        running.pop(key, None)
        if worker.cancelled():
            states[key] = {**states.get(key, {}), "task_id": key[1], "status": "cancelled"}
        slot.attempts -= 1
        if slot.attempts == 0:
            slots.pop(operation, None)

    @app.post(f"{PREFIX}/structure", dependencies=admission)
    async def translation_structure(payload: AnalysisRequest, request: Request) -> dict:
        request_user_id(request)
        if payload.kind is not ActionKind.TRANSLATION:
            raise HTTPException(422, AnalysisErrorCode.SOURCE_INVALID.value)
        try:
            prepared = await activities.to_thread(
                ActivityDomain.ACTION,
                prepare,
                payload,
                repository,
                pdf,
                content,
                citation_reader=source_reader(request_owner_id(request)),
                artifact_reader=artifact_reader(request_owner_id(request)),
            )
        except (ContentError, ValueError, OSError, RuntimeError) as error:
            raise HTTPException(422, preparation_failure_detail(error)) from error
        return {
            "revision": prepared.revision,
            "page": payload.page,
            "structure_version": STRUCTURE_VERSION,
            "blocks": prepared.translation_structure,
        }

    @app.post(f"{PREFIX}/preflight", dependencies=admission)
    async def preflight(payload: AnalysisRequest, request: Request) -> dict:
        prepared = await check(payload, request_user_id(request), request_owner_id(request))
        return {
            "ready": True,
            "revision": prepared.revision,
            "pages": prepared.page_count,
            "title": prepared.title,
            "crop": prepared.crop,
        }

    @app.post(f"{PREFIX}/tasks", status_code=202, dependencies=admission)
    async def submit(payload: AnalysisSubmission, request: Request) -> dict:
        check_service_instance(payload.service_instance_id)
        if payload.kind is ActionKind.FIGURE:
            raise HTTPException(
                422,
                {
                    "code": AnalysisErrorCode.FIGURE_STREAM_REQUIRED.value,
                    "diagnostic": "",
                },
            )
        owner = request_user_id(request)
        principal = request_owner_id(request)
        key = (owner, payload.client_attempt_id)
        if alias := joined_attempt(owner, key[1]):
            return joined_snapshot(owner, alias)
        if key in states or tasks.get_attempt(key[1], owner):
            return snapshot(owner, key[1])
        submitted_at = time.monotonic()
        states[key] = {"task_id": key[1], "status": "pending"}
        try:
            prepared = await check(payload, owner, principal)
        except BaseException:
            if states.get(key, {}).get("status") != "cancelled":
                states.pop(key, None)
            raise
        preparation_seconds = time.monotonic() - submitted_at
        if states[key]["status"] == "cancelled":
            return snapshot(owner, key[1])
        operation = (
            owner,
            prepared.request.source_id,
            prepared.revision,
            prepared.request.kind.value,
        )
        slot = slots.get(operation)
        if slot is not None and payload.kind is ActionKind.INTERPRETATION:
            states.pop(key, None)
            alias = results.remember_joined_attempt(owner, key[1], slot.task_id, slot.model_key)
            return joined_snapshot(owner, alias)
        if slot is not None and payload.kind not in QUEUED_ACTIONS:
            states.pop(key, None)
            raise HTTPException(
                409, {"code": AnalysisErrorCode.OPERATION_BUSY.value, "diagnostic": ""}
            )
        if slot is None:
            slot = AnalysisSlot(task_id=key[1], model_key=payload.model_key)
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
        worker = activities.spawn(
            ActivityDomain.ACTION,
            lambda: execute(prepared, owner, slot, submitted_at, preparation_seconds, principal),
        )
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
    async def get_task(
        task_id: str, request: Request, service_instance_id: str | None = None
    ) -> dict:
        check_service_instance(service_instance_id)
        return attempt_snapshot(request_user_id(request), task_id)

    @app.get(f"{PREFIX}/tasks/{{task_id}}/events")
    async def events(task_id: str, request: Request) -> StreamingResponse:
        owner = request_user_id(request)
        attempt_snapshot(owner, task_id)

        async def stream():
            while not await request.is_disconnected():
                state = attempt_snapshot(owner, task_id)
                yield f"data: {json.dumps(state, ensure_ascii=False)}\n\n"
                if state["status"] not in ("pending", "running"):
                    break
                await asyncio.sleep(EVENT_POLL_SECONDS)

        return StreamingResponse(
            passive_events(stream(), activities),
            media_type=SSE_MEDIA_TYPE,
            headers=SSE_HEADERS,
        )

    @app.post(f"{PREFIX}/tasks/{{task_id}}/timing", dependencies=admission)
    async def observe_timing(task_id: str, payload: ReadingTiming, request: Request) -> dict:
        owner = request_user_id(request)
        alias = joined_attempt(owner, task_id)
        task_id = alias[0] if alias else task_id
        key = (owner, task_id)
        state = snapshot(owner, task_id, accepted_join=alias is not None)
        result = state.get("result")
        previous = state.get("ui_timing") or (result or {}).get("metadata", {}).get("ui_timing", {})
        measured = dict(previous)
        for name, value in payload.model_dump(exclude_none=True).items():
            measured[name] = min(value, measured.get(name, value))
        ordered = [
            measured[name]
            for name in ("first_seconds", "reading_seconds", "total_seconds")
            if name in measured
        ]
        if ordered != sorted(ordered):
            raise HTTPException(422, {"code": "pdf_ai_timing_invalid"})
        state = {**state, "ui_timing": measured}
        if result is not None:
            result = {**result, "metadata": {**result.get("metadata", {}), "ui_timing": measured}}
            state["result"] = result
            record = tasks.get_attempt(task_id, owner)
            if record:
                # A late observation must never replace a newer reading or change execution status.
                saved = (
                    results.summary(result["literature_id"], result["revision"])
                    if result.get("literature_id")
                    else None
                )
                if saved and saved.get("metadata", {}).get("task_id") == task_id:
                    results.publish(result, record.invocation_id)
                if state["status"] == "completed":
                    tasks.save(replace(record, output_text=json.dumps(result, ensure_ascii=False)))
        if state["status"] != ModelInvocationStatus.UNKNOWN.value:
            states[key] = state
        return {"ui_timing": measured}

    @app.post(f"{PREFIX}/tasks/{{task_id}}/cancel")
    async def cancel(task_id: str, request: Request) -> dict:
        owner = request_user_id(request)
        alias = joined_attempt(owner, task_id)
        canonical = alias[0] if alias else task_id
        state = snapshot(owner, canonical, accepted_join=alias is not None)
        key = (owner, canonical)
        if state["status"] in ("pending", "running"):
            states[key] = {"task_id": canonical, "status": "cancelled"}
            worker = running.get(key)
            record = tasks.get_attempt(canonical, owner)
            active_ids = set(active_invocations.get(key, ()))
            if not active_ids and record:
                active_ids.add(record.invocation_id)
            for active_id in active_ids:
                await actions.cancel(invocation_id=active_id, owner_id=owner)
            if worker:
                if not worker.done() and not worker.cancelling():
                    worker.cancel()
                # Cancellation acknowledges release of the publication slot, so a
                # replacement can be submitted immediately without a 409 race.
                with suppress(asyncio.CancelledError):
                    await worker
        return attempt_snapshot(owner, task_id)

    @app.get("/api/literature/{literature_id}/ai/state")
    async def reading_state(
        literature_id: str,
        request: Request,
        attachment_id: str = "",
        source_revision: str = "",
    ) -> dict:
        owner = request_user_id(request)
        try:
            attachment_id = attachment_id or pdf.primary(literature_id).id
            source = AnalysisRequest(
                literature_id=literature_id,
                attachment_id=attachment_id,
                model_key="",
                kind=ActionKind.INTERPRETATION,
                client_action_id="read",
                client_attempt_id="read",
            )
            data, _ = await activities.to_thread(
                ActivityDomain.ACTION, read_source, source, repository, pdf, content
            )
            revision = hashlib.sha256(data).hexdigest()
            if source_revision and source_revision.removeprefix("sha256:") != revision:
                raise AnalysisError(AnalysisErrorCode.SOURCE_CHANGED)
        except (ContentError, ValueError, OSError, RuntimeError) as error:
            raise HTTPException(422, preparation_failure_detail(error)) from error
        slot = slots.get((owner, source.source_id, revision, ActionKind.INTERPRETATION.value))
        task = None
        if slot:
            task = {**snapshot(owner, slot.task_id), "model_key": slot.model_key}
        else:
            record = tasks.latest_source_attempt(
                owner_id=owner,
                source_id=source.source_id,
                source_revision=revision,
                kind=EXTRACTION_PURPOSE,
                child_marker=":l1:",
            )
            if record and record.status is not ModelInvocationStatus.COMPLETED:
                task = {**snapshot(owner, record.client_attempt_id), "model_key": record.model_key}
        assets = {
            key: project_saved(value)
            for key, value in results.read(literature_id, revision).items()
        }
        # A failed writer must not hide a successfully saved extraction checkpoint.
        if "summary" not in assets:
            checkpoint = results.reading_l1(literature_id, revision, attachment_id)
            if checkpoint:
                assets["summary"] = fallback_asset(checkpoint)
            elif task and task["status"] not in {"pending", "running", "completed"}:
                paper = repository.get(literature_id)
                preview = (
                    abstract_summary(paper.abstract or "", "zh") if paper is not None else None
                )
                if preview:
                    task = {**task, "preview": preview}
        return {
            "revision": revision,
            "attachment_id": attachment_id,
            "results": assets,
            "task": task,
        }

    @app.get("/api/literature/{literature_id}/ai/results")
    async def read_results(literature_id: str, source_revision: str) -> dict:
        return results.read(literature_id, source_revision)
