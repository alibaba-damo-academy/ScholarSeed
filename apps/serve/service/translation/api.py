from __future__ import annotations

import asyncio
import sqlite3
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from service.identity.utils import require_host_process
from service.paths import TRANSLATION_DB
from service.translation.policy import RetryReport
from service.translation.providers import (
    MAX_TEXT_CHARS,
    PROBE_SOURCE,
    PROBE_TARGET,
    PROBE_TEXT,
    TranslationFailure,
    Translator,
    validate_fields,
)
from service.translation.store import DEFAULT_PREFERENCES, TranslationStore

TRANSLATION_ROUTE = "/api/settings/translation"
REQUEST_LIMIT = 262144
HTTP_INVALID = 422
HTTP_OVERSIZE = 413
HTTP_UNAVAILABLE = 503
HTTP_RATE_LIMITED = 429
OPERATION_TIMEOUT = 40.0


class TranslationPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    toolbar: bool = DEFAULT_PREFERENCES["toolbar"]
    selectionAutomatic: bool = DEFAULT_PREFERENCES["selectionAutomatic"]


class TranslationAction(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)
    operation: Literal["verify", "translate", "invalidate"]
    provider: str = Field(max_length=32)
    fields: dict[str, str] = Field(default_factory=dict, repr=False, max_length=3)
    text: str = Field(default="", repr=False, max_length=MAX_TEXT_CHARS)
    source: str = Field(default="auto", max_length=16)
    target: str = Field(default="zh-CN", max_length=16)


def mount_translation_routes(
    app: FastAPI, store: TranslationStore | None = None, translator: Translator | None = None
) -> None:
    translator = translator or Translator()

    def storage() -> TranslationStore:
        nonlocal store
        if store is None:
            store = TranslationStore(TRANSLATION_DB)
        return store

    @app.get(TRANSLATION_ROUTE, dependencies=[Depends(require_host_process)])
    async def catalog():
        try:
            return {
                "services": storage().statuses(),
                "configuration": storage().configuration(),
                "preferences": storage().preferences(),
            }
        except (OSError, sqlite3.Error):
            raise HTTPException(HTTP_UNAVAILABLE, "storage") from None

    @app.patch(TRANSLATION_ROUTE, dependencies=[Depends(require_host_process)])
    async def preferences(changes: TranslationPreferences):
        try:
            return {
                "preferences": storage().save_preferences(changes.model_dump(exclude_unset=True))
            }
        except (OSError, sqlite3.Error):
            raise HTTPException(HTTP_UNAVAILABLE, "storage") from None

    @app.post(TRANSLATION_ROUTE, dependencies=[Depends(require_host_process)])
    async def operate(request: Request):
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > REQUEST_LIMIT:
                raise HTTPException(HTTP_OVERSIZE, "request_too_large")
        try:
            action = TranslationAction.model_validate_json(payload)
        except ValidationError:
            raise HTTPException(HTTP_INVALID, "required") from None
        report = RetryReport()
        try:
            if action.operation == "invalidate":
                storage().begin(action.provider)
                return {"services": storage().statuses()}
            if action.operation == "verify":
                fields = validate_fields(action.provider, action.fields)
                generation = storage().begin(action.provider)
                async with asyncio.timeout(OPERATION_TIMEOUT):
                    await translator.translate(
                        action.provider,
                        fields,
                        PROBE_TEXT,
                        PROBE_SOURCE,
                        PROBE_TARGET,
                        report=report,
                    )
                if not storage().finish(action.provider, generation, fields):
                    raise TranslationFailure("superseded")
                return {
                    "services": storage().statuses(),
                    "configuration": storage().configuration(),
                    "retries": report.retries,
                }
            fields = storage().credentials(action.provider)
            async with asyncio.timeout(OPERATION_TIMEOUT):
                result = await translator.translate(
                    action.provider,
                    fields,
                    action.text,
                    action.source,
                    action.target,
                    report=report,
                )
            return {"text": result, "retries": report.retries}
        except TranslationFailure as error:
            status = HTTP_RATE_LIMITED if str(error) == "rate_limited" else HTTP_INVALID
            raise HTTPException(status, str(error)) from None
        except TimeoutError:
            if report.limited:
                raise HTTPException(HTTP_RATE_LIMITED, "rate_limited") from None
            raise HTTPException(HTTP_UNAVAILABLE, "timeout") from None
        except (OSError, sqlite3.Error):
            raise HTTPException(HTTP_UNAVAILABLE, "storage") from None
