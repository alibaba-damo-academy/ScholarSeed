"""Selection-to-note entry point; the existing Invocation owns Skill execution."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from contextlib import aclosing
from dataclasses import asdict
from pathlib import PurePath

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse

from service.assistant.api.stream import SSE_HEADERS, SSE_MEDIA_TYPE
from service.chat.constants import PRODUCT_EVENT_GENERATION_PREVIEW
from service.chat.runtime.utils import runtime_failure
from service.chat.service.events import SSE_HEARTBEAT_FRAME, sse_encode
from service.chat.service.models import ModelService
from service.content.domain.model import ContentError
from service.identity.utils import request_owner_id, request_user_id
from service.invocation.service.runtime import InvocationService
from service.invocation.service.utils import INVOCATION_EXECUTION_PHASE
from service.literature.domain.model import NOTE_NOT_FOUND, NOTE_VERSION_CONFLICT, LiteratureError
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import PDF_MEDIA_TYPE
from service.literature.service.attachment import LiteratureAttachmentContent
from service.literature.service.indexing import (
    INDEX_BODY_LIMIT,
    INDEX_INVALID,
    index_note,
    selected_mark_ids,
)
from service.literature.service.insights import (
    INSIGHT_DELIVERY_PHASE,
    INSIGHT_FAILED,
    INSIGHT_INPUT,
    INSIGHT_INTERACTION_REQUIRED,
    INSIGHT_MAP,
    INSIGHT_NOTE,
    INSIGHT_OUTPUT_LIMIT,
    INSIGHT_RAW,
    INSIGHT_READING,
    INSIGHT_RESULT_INVALID,
    INSIGHT_RUNNING,
    INSIGHT_SAVE_PHASE,
    INSIGHT_SELECTION_CHANGED,
    INSIGHT_SOURCES_MISSING,
    InsightRequest,
    command,
    deliver,
    failure_detail,
    material,
)
from service.literature.service.records import AttachmentRecords
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import GENERATION_MAX_TIMEOUT_SECONDS
from service.platform.records import RecordOwner, RecordTarget

INSIGHT_ROUTE = "/api/v1/literatures/{literature_id}/notes/generate"
INDEX_ROUTE = "/api/v1/literatures/{literature_id}/notes/{note_id}/index"
INDEX_MODEL_KEY = "local-index"
LOGGER = logging.getLogger(__name__)


def register_insight_routes(
    app: FastAPI,
    *,
    repository: LiteratureRepository,
    attachments: LiteratureAttachmentContent,
    invocations: InvocationService,
    models: ModelService,
    activities: Activities,
) -> None:
    records = AttachmentRecords(attachments, repository)
    running: set[tuple[str, str]] = set()

    async def admit():
        with activities.enter(ActivityDomain.ACTION, root=True):
            yield

    def freeze(literature_id: str, selection: InsightRequest):
        target = RecordTarget(
            RecordOwner.LITERATURE_ATTACHMENT, literature_id, selection.attachment_id
        )
        snapshot = records.peek_target(target)
        payload, _media, revision = attachments.read_attachment(
            literature_id, selection.attachment_id, read_only=True
        )
        if revision != snapshot.source_revision:
            raise ValueError(INSIGHT_SELECTION_CHANGED)
        attachment = attachments.attachment(literature_id, selection.attachment_id, read_only=True)
        return material(snapshot, selection, payload, attachment.name)

    def import_index(literature_id: str, note_id: str, reading: dict, version: int):
        note = next(
            (note for note in repository.notes(literature_id) or () if note.id == note_id), None
        )
        if note is None:
            raise LiteratureError(NOTE_NOT_FOUND)
        if note.version != version:
            raise LiteratureError(NOTE_VERSION_CONFLICT)
        identifiers = selected_mark_ids(reading)
        matches = []
        for attachment in repository.attachments(literature_id, read_only=True):
            if attachment["media_type"] != PDF_MEDIA_TYPE:
                continue
            target = RecordTarget(
                RecordOwner.LITERATURE_ATTACHMENT, literature_id, attachment["id"]
            )
            try:
                snapshot = records.peek_target(target)
                if not set(identifiers).issubset(
                    {mark["id"] for mark in snapshot.records["marks"]}
                ):
                    continue
                frozen = freeze(
                    literature_id,
                    InsightRequest(
                        attachment_id=attachment["id"],
                        source_revision=snapshot.source_revision,
                        record_revision=snapshot.record_revision,
                        mark_ids=identifiers,
                        model_key=INDEX_MODEL_KEY,
                        language="en",
                    ),
                )
                if hashlib.sha256(frozen.pdf).hexdigest() == reading.get("document", {}).get(
                    "sha256"
                ):
                    matches.append(frozen)
            except (ContentError, ValueError):
                continue
        if len(matches) != 1:
            raise ValueError(INDEX_INVALID)
        frozen = matches[0]
        provenance = index_note(note.text, reading, frozen.pdf, frozen.sources)
        return asdict(
            repository.index_note(literature_id, note_id, provenance, expected_version=version)
        )

    @app.post(INDEX_ROUTE, dependencies=[Depends(admit)])
    async def import_note_index(literature_id: str, note_id: str, request: Request):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > INDEX_BODY_LIMIT:
                raise HTTPException(413, INDEX_INVALID)
        try:
            payload = json.loads(body)
            if (
                not isinstance(payload, dict)
                or set(payload) != {"reading", "version"}
                or not isinstance(payload["reading"], dict)
                or not isinstance(payload["reading"].get("document"), dict)
                or not isinstance(payload["version"], int)
                or isinstance(payload["version"], bool)
                or payload["version"] < 1
            ):
                raise ValueError(INDEX_INVALID)
            return await activities.to_thread(
                ActivityDomain.ACTION,
                import_index,
                literature_id,
                note_id,
                payload["reading"],
                payload["version"],
            )
        except LiteratureError as error:
            raise HTTPException(
                409 if error.code == NOTE_VERSION_CONFLICT else 404, error.code
            ) from error
        except (ValueError, TypeError) as error:
            raise HTTPException(422, INDEX_INVALID) from error

    @app.post(INSIGHT_ROUTE, dependencies=[Depends(admit)])
    async def generate(literature_id: str, selection: InsightRequest, request: Request):
        owner_id = request_owner_id(request)
        key = (owner_id, literature_id)
        if key in running:
            raise HTTPException(409, INSIGHT_RUNNING)
        running.add(key)
        try:
            model_id = models.selected_model_key(
                selection.model_key, user_id=request_user_id(request)
            )
            frozen = await activities.to_thread(
                ActivityDomain.ACTION, freeze, literature_id, selection
            )
            prepared = await invocations.prepare(
                command(selection, model_id),
                owner_id=owner_id,
                user_id=request_user_id(request),
                input_files={INSIGHT_INPUT: frozen.pdf},
            )
        except asyncio.CancelledError:
            running.discard(key)
            raise
        except Exception as error:
            running.discard(key)
            LOGGER.exception("insight_preparation_failed literature_id=%s", literature_id)
            code = (
                INSIGHT_SELECTION_CHANGED
                if str(error) == INSIGHT_SELECTION_CHANGED
                else getattr(error, "code", INSIGHT_FAILED)
            )
            raise HTTPException(422, code) from error

        async def artifact_bytes(artifact: dict) -> bytes:
            metadata, handle = await invocations.artifact(
                prepared.record.invocation_id, artifact["artifact_id"], owner_id=owner_id
            )
            with handle:
                if metadata.size_bytes > INSIGHT_OUTPUT_LIMIT:
                    raise ValueError(INSIGHT_RESULT_INVALID)
                return handle.read(INSIGHT_OUTPUT_LIMIT + 1)

        async def body():
            artifacts: dict[str, dict] = {}
            duplicate_reading = False
            completed = False
            detail = ""
            phase = INVOCATION_EXECUTION_PHASE
            try:
                async with (
                    asyncio.timeout(GENERATION_MAX_TIMEOUT_SECONDS),
                    aclosing(invocations.stream(prepared)) as stream,
                ):
                    async for event in stream:
                        if event is None:
                            yield SSE_HEARTBEAT_FRAME
                            continue
                        kind = event["type"]
                        if kind == PRODUCT_EVENT_GENERATION_PREVIEW:
                            yield sse_encode({"type": kind, "data": event["data"]})
                        elif kind == "artifact.published":
                            artifact = event["data"]
                            name = PurePath(artifact["relative_path"]).name
                            if name in (INSIGHT_NOTE, INSIGHT_MAP, INSIGHT_RAW, INSIGHT_READING):
                                if name in artifacts:
                                    if name == INSIGHT_READING:
                                        duplicate_reading = True
                                        continue
                                    raise ValueError(INSIGHT_RESULT_INVALID)
                                artifacts[name] = artifact
                        elif kind == "result.completed":
                            completed = True
                        elif kind in {
                            "invocation.failed",
                            "invocation.interrupted",
                            "invocation.unknown",
                        }:
                            completed = False
                            data = event.get("data") or {}
                            detail = failure_detail(
                                {**data, "error": data.get("error") or kind},
                                phase=phase,
                                language=selection.language,
                            )
                        elif kind == "interaction.required":
                            raise ValueError(INSIGHT_INTERACTION_REQUIRED)
                        else:
                            yield SSE_HEARTBEAT_FRAME
                if not completed:
                    raise ValueError(INSIGHT_FAILED)
                phase = INSIGHT_DELIVERY_PHASE
                reading = None
                if INSIGHT_READING in artifacts and not duplicate_reading:
                    try:
                        reading = await artifact_bytes(artifacts[INSIGHT_READING])
                    except Exception:
                        LOGGER.warning(
                            "insight_optional_index_unavailable invocation_id=%s",
                            prepared.record.invocation_id,
                        )
                title, text, provenance = deliver(
                    (
                        await artifact_bytes(artifacts[INSIGHT_NOTE])
                        if INSIGHT_NOTE in artifacts
                        else None
                    ),
                    (
                        await artifact_bytes(artifacts[INSIGHT_MAP])
                        if INSIGHT_MAP in artifacts
                        else None
                    ),
                    (
                        await artifact_bytes(artifacts[INSIGHT_RAW])
                        if INSIGHT_RAW in artifacts
                        else None
                    ),
                    frozen,
                    selection.language,
                    reading,
                )
                phase = INSIGHT_SAVE_PHASE
                note = await activities.finish(
                    ActivityDomain.ACTION,
                    lambda: activities.to_thread(
                        ActivityDomain.ACTION,
                        repository.create_note,
                        literature_id,
                        text,
                        title,
                        provenance=provenance,
                    ),
                )
                yield sse_encode({"type": "result", "note": asdict(note)})
            except Exception as error:
                LOGGER.exception(
                    "insight_generation_failed invocation_id=%s", prepared.record.invocation_id
                )
                code = (
                    str(error)
                    if str(error)
                    in {
                        INSIGHT_RESULT_INVALID,
                        INSIGHT_SOURCES_MISSING,
                        INSIGHT_INTERACTION_REQUIRED,
                    }
                    else INSIGHT_FAILED
                )
                if not detail:
                    detail = failure_detail(
                        {"error": code, "diagnostic": runtime_failure(error, phase=phase)},
                        phase=phase,
                        language=selection.language,
                    )
                yield sse_encode(
                    {
                        "type": "error",
                        "code": code,
                        "invocation_id": prepared.record.invocation_id,
                        "detail": detail,
                    }
                )
            finally:
                running.discard(key)

        return StreamingResponse(body(), media_type=SSE_MEDIA_TYPE, headers=SSE_HEADERS)
