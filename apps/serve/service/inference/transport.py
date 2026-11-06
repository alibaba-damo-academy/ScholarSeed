"""Single tool-free HTTP generation, without an Agent runtime fallback."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Mapping

import httpx

from scholarseed_runtime.contract import ModelWireProtocol
from service.chat.service.completions import CompletionCleanupUnknown
from service.chat.service.models import ModelService, SessionModelUnavailableError
from service.inference.reasoning import ThinkingParameters, minimum_parameters
from service.inference.source import accepts_source, attach_source
from service.platform.inference import (
    TOOL_FREE_UNSUPPORTED,
    ModelInvocationEvent,
    ModelInvocationEventKind,
    ModelInvocationObserver,
    ModelInvocationRequest,
    ModelInvocationResult,
    ModelInvocationStatus,
    ModelInvocationUsage,
    ReasoningPolicy,
)
from service.settings.capabilities import OUTPUT_TOKEN_LIMIT_SUPPORTED_KEY, REASONING_OPTIONS_KEY
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL

RESPONSES_PROTOCOL = ModelWireProtocol.RESPONSES.value
CHAT_PROTOCOL = ModelWireProtocol.CHAT_COMPLETIONS.value
PDF_MEDIA_TYPE = "application/pdf"
REQUEST_TIMEOUT_SECONDS = 240
ERROR_BODY_LIMIT = 8192
ERROR_SUMMARY_LIMIT = 400
ERROR_SECRET_PATTERN = re.compile(r"(?i)bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bsk-[\w-]+")
GENERATION_ERROR = "generation_failed"
TOOL_OUTPUT_UNSUPPORTED = "tool_free_generation_violation"
INVOCATION_ACTIVE = "model_invocation_active"
RESPONSE_OUTPUT_KINDS = frozenset({"message", "reasoning"})
RESPONSE_ITEM_EVENTS = frozenset({"response.output_item.added", "response.output_item.done"})
LOGGER = logging.getLogger(__name__)
LITERATURE_PURPOSE_PREFIX = "literature."
JSON_OUTPUT_DIRECTIVE = "Return the result as a JSON object."


async def log_http_failure(response: httpx.Response, request: ModelInvocationRequest) -> None:
    """Log bounded structured diagnostics, never headers or echoed request data."""
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk[: ERROR_BODY_LIMIT - len(body)])
        if len(body) >= ERROR_BODY_LIMIT:
            break
    summary = "unstructured error body"
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        document = None
    if isinstance(document, dict):
        error = document.get("error", document.get("detail", document))
        if isinstance(error, dict):
            summary = " ".join(
                str(error[key])
                for key in ("code", "type", "message", "detail")
                if isinstance(error.get(key), (str, int))
            )
        elif isinstance(error, str):
            summary = error
    for value in (*response.request.headers.values(), request.input_text, request.instructions):
        if value:
            summary = summary.replace(value, "[redacted]")
    summary = ERROR_SECRET_PATTERN.sub("[redacted]", summary)
    summary = " ".join(summary.split())[:ERROR_SUMMARY_LIMIT]
    LOGGER.warning(
        "inference_http_failed invocation_id=%s status=%s host=%s detail=%s",
        request.invocation_id,
        response.status_code,
        response.request.url.host,
        summary,
    )


def thinking_for(
    request: ModelInvocationRequest, connection: Mapping[str, Any]
) -> ThinkingParameters:
    """这次请求要发的思考参数：「要不要关」是产品规则，「怎么关」是厂商声明。

    旧实现把两件事混在一张按模型名匹配的正则表里，于是新接一个模型就要改正则，还会给无关
    模型发出未验证的厂商扩展参数。没发出任何参数时保持 provider 默认（延迟是偏好，不是准入
    条件），但把原因带回去记日志，否则「为什么没关掉」只能靠猜。
    """

    wants_minimum = (
        request.reasoning_policy is ReasoningPolicy.LOW_LATENCY
        or request.purpose.startswith(LITERATURE_PURPOSE_PREFIX)
    )
    if not wants_minimum:
        return ThinkingParameters({})
    return minimum_parameters(
        connection.get(REASONING_OPTIONS_KEY),
        str(connection.get("wire_api") or ""),
        str(connection.get("provider") or ""),
    )


def responses_body(
    request: ModelInvocationRequest, connection: Mapping[str, Any], thinking: Mapping[str, Any]
) -> dict:
    content = [{"type": "input_text", "text": request.input_text}]
    for part in request.attachments:
        data = f"data:{part.media_type};base64,{part.data}"
        content.append(
            {"type": "input_file", "filename": part.name, "file_data": data}
            if part.media_type == PDF_MEDIA_TYPE
            else {"type": "input_image", "image_url": data}
        )
    if request.json_output:
        content.append({"type": "input_text", "text": JSON_OUTPUT_DIRECTIVE})
    return {
        "model": str(connection["model"]),
        "instructions": request.instructions,
        "input": [{"role": "user", "content": content}],
        **(
            {"max_output_tokens": request.limits.max_output_tokens}
            if connection.get(OUTPUT_TOKEN_LIMIT_SUPPORTED_KEY, True)
            else {}
        ),
        "tools": [],
        "tool_choice": "none",
        "stream": True,
        **thinking,
        **({"text": {"format": {"type": "json_object"}}} if request.json_output else {}),
    }


def chat_body(
    request: ModelInvocationRequest, connection: Mapping[str, Any], thinking: Mapping[str, Any]
) -> dict:
    content: list[dict[str, Any]] = [{"type": "text", "text": request.input_text}]
    for part in request.attachments:
        data = f"data:{part.media_type};base64,{part.data}"
        content.append(
            {"type": "file", "file": {"filename": part.name, "file_data": data}}
            if part.media_type == PDF_MEDIA_TYPE
            else {"type": "image_url", "image_url": {"url": data}}
        )
    return {
        "model": str(connection["model"]),
        "messages": [
            {"role": "system", "content": request.instructions},
            {"role": "user", "content": content},
        ],
        "max_tokens": request.limits.max_output_tokens,
        "tools": [],
        "tool_choice": "none",
        "stream": True,
        "stream_options": {"include_usage": True},
        **thinking,
        **({"response_format": {"type": "json_object"}} if request.json_output else {}),
    }


ENCODERS = {RESPONSES_PROTOCOL: responses_body, CHAT_PROTOCOL: chat_body}


def encoded_body(
    request: ModelInvocationRequest,
    connection: Mapping[str, Any],
    thinking: Mapping[str, Any],
) -> dict:
    """Encode one request and preserve its compiled input as gateway provenance."""
    body = ENCODERS[connection["wire_api"]](request, connection, thinking)
    if accepts_source(connection["endpoint"], (DEEPRD_GATEWAY_BASE_URL,)):
        body = attach_source(
            body,
            session_id=request.invocation_id,
            turn_id=request.invocation_id,
            text=request.input_text,
        )
    return body


async def receive(
    response: httpx.Response,
    protocol: str,
    *,
    request: ModelInvocationRequest | None = None,
    observer: ModelInvocationObserver | None = None,
) -> dict:
    """Consume one generation stream; only an explicit terminal event is success."""
    parts: list[str] = []
    usage: dict = {}
    receipt = ""
    finish = ""
    response_items: dict[int, dict] = {}
    async for line in response.aiter_lines():
        if not line.startswith("data:"):
            continue
        data = line.removeprefix("data:").strip()
        if not data or data == "[DONE]":
            continue
        chunk = json.loads(data)
        if chunk.get("error"):
            raise ValueError("upstream_stream_error")
        if protocol == RESPONSES_PROTOCOL:
            if chunk.get("type") in RESPONSE_ITEM_EVENTS:
                if chunk.get("item", {}).get("type") not in RESPONSE_OUTPUT_KINDS:
                    raise ValueError(TOOL_OUTPUT_UNSUPPORTED)
                if chunk["type"] == "response.output_item.done":
                    response_items[chunk["output_index"]] = chunk["item"]
            if chunk.get("type") == "response.output_text.delta" and observer and request:
                await observer(
                    ModelInvocationEvent(
                        request.invocation_id,
                        ModelInvocationEventKind.OUTPUT_DELTA,
                        chunk.get("delta", ""),
                    )
                )
            if chunk.get("type") == "response.completed":
                if any(
                    item.get("type") not in RESPONSE_OUTPUT_KINDS
                    for item in chunk["response"].get("output", [])
                ):
                    raise ValueError(TOOL_OUTPUT_UNSUPPORTED)
                payload = chunk["response"]
                # Non-persisted responses may leave terminal output empty. Only
                # completed items are eligible, never partial text deltas.
                if not payload.get("output") and response_items:
                    payload = {
                        **payload,
                        "output": [response_items[index] for index in sorted(response_items)],
                    }
                return payload
            if chunk.get("type") in ("response.failed", "response.incomplete", "error"):
                raise ValueError("output_incomplete")
        else:
            receipt = chunk.get("id") or receipt
            usage = chunk.get("usage") or usage
            for choice in chunk.get("choices") or []:
                if choice.get("index", 0) != 0:
                    continue
                delta = choice.get("delta") or {}
                if delta.get("tool_calls") or delta.get("function_call"):
                    raise ValueError(TOOL_OUTPUT_UNSUPPORTED)
                text = delta.get("content")
                if text:
                    parts.append(text)
                    if observer and request:
                        await observer(
                            ModelInvocationEvent(
                                request.invocation_id, ModelInvocationEventKind.OUTPUT_DELTA, text
                            )
                        )
                finish = choice.get("finish_reason") or finish
    if protocol == RESPONSES_PROTOCOL or not finish:
        raise ValueError("output_incomplete")
    return {
        "id": receipt,
        "usage": usage,
        "choices": [{"finish_reason": finish, "message": {"content": "".join(parts)}}],
    }


class InferenceProvider:
    def __init__(self, models: ModelService) -> None:
        self._models = models
        self._active: dict[str, tuple[str, asyncio.Task]] = {}
        self._cancel_requested: set[str] = set()

    def available(self) -> bool:
        return True

    async def invoke(
        self, request: ModelInvocationRequest, *, observer: ModelInvocationObserver | None = None
    ) -> ModelInvocationResult:
        if request.invocation_id in self._active:
            return ModelInvocationResult(
                request.invocation_id,
                ModelInvocationStatus.FAILED,
                request.model_key,
                error_code=INVOCATION_ACTIVE,
            )
        task = asyncio.current_task()
        if task is not None:
            self._active[request.invocation_id] = (request.owner_id, task)
        model_key = request.model_key
        try:
            async with self._models.inference(
                request.model_key, user_id=request.owner_id, invocation_id=request.invocation_id
            ) as connection:
                model_key = connection["key"]
                return await self._generate(request, connection, observer=observer)
        except asyncio.CancelledError:
            return ModelInvocationResult(
                request.invocation_id, ModelInvocationStatus.CANCELLED, model_key
            )
        except Exception as error:
            LOGGER.warning(
                "pdf_inference_failed invocation_id=%s failure_type=%s",
                request.invocation_id,
                type(error).__name__,
            )
            return ModelInvocationResult(
                request.invocation_id,
                (
                    ModelInvocationStatus.UNKNOWN
                    if isinstance(error, CompletionCleanupUnknown)
                    else ModelInvocationStatus.FAILED
                ),
                model_key,
                error_code=(
                    TOOL_FREE_UNSUPPORTED
                    if isinstance(error, SessionModelUnavailableError)
                    and str(error) == TOOL_FREE_UNSUPPORTED
                    else GENERATION_ERROR
                ),
                error_detail=("模型调用失败；请检查所选模型的连接及图片/PDF能力，然后重试。"),
            )
        finally:
            if self._active.get(request.invocation_id) == (request.owner_id, task):
                self._active.pop(request.invocation_id)
                self._cancel_requested.discard(request.invocation_id)

    async def _generate(
        self,
        request: ModelInvocationRequest,
        connection: Mapping[str, Any],
        *,
        observer: ModelInvocationObserver | None = None,
    ) -> ModelInvocationResult:
        task = asyncio.current_task()
        model_key = connection["key"]
        for part in request.attachments:
            capability = "pdf_input" if part.media_type == PDF_MEDIA_TYPE else "image_input"
            if not connection[capability]:
                raise ValueError(f"model_{capability}_unsupported")
        if observer:
            await observer(
                ModelInvocationEvent(request.invocation_id, ModelInvocationEventKind.STARTED)
            )
        if request.invocation_id in self._cancel_requested or (
            task is not None and task.cancelling()
        ):
            raise asyncio.CancelledError
        thinking = thinking_for(request, connection)
        body = encoded_body(request, connection, thinking.parameters)
        started = time.monotonic()
        LOGGER.info(
            "pdf_inference_request invocation_id=%s model=%s requests=1 attachments=%s thinking=%s controls=%s protocol=%s purpose=%s",
            request.invocation_id,
            request.model_key,
            len(request.attachments),
            thinking.effort or thinking.reason or "provider_default",
            json.dumps(thinking.parameters, ensure_ascii=True, sort_keys=True),
            connection["wire_api"],
            request.purpose,
        )
        async with httpx.AsyncClient(
            timeout=REQUEST_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=connection.get("trust_env", True),
        ) as client:
            async with client.stream(
                "POST",
                connection["endpoint"],
                headers=connection["headers"],
                json=body,
            ) as response:
                if response.is_error:
                    await log_http_failure(response, request)
                response.raise_for_status()
                payload = await receive(
                    response, connection["wire_api"], request=request, observer=observer
                )
        usage = payload.get("usage") or {}
        LOGGER.info(
            "pdf_inference_completed invocation_id=%s elapsed_seconds=%.2f reasoning_tokens=%s",
            request.invocation_id,
            time.monotonic() - started,
            (
                usage.get("completion_tokens_details") or usage.get("output_tokens_details") or {}
            ).get("reasoning_tokens", "unavailable"),
        )
        if connection["wire_api"] == RESPONSES_PROTOCOL:
            if payload.get("status") != "completed":
                raise ValueError("output_incomplete")
            text = "".join(
                part.get("text", "")
                for item in payload.get("output", [])
                for part in item.get("content", [])
                if part.get("type") == "output_text"
            )
        else:
            choice = payload["choices"][0]
            if choice.get("finish_reason") != "stop":
                raise ValueError("output_incomplete")
            text = choice["message"].get("content") or ""
        if not text.strip():
            raise ValueError("output_incomplete")
        if observer:
            await observer(
                ModelInvocationEvent(
                    request.invocation_id,
                    ModelInvocationEventKind.OUTPUT_COMPLETED,
                    text,
                    str(payload.get("id") or ""),
                )
            )
        return ModelInvocationResult(
            request.invocation_id,
            ModelInvocationStatus.COMPLETED,
            model_key,
            text,
            ModelInvocationUsage(
                usage.get("input_tokens", usage.get("prompt_tokens", 0)),
                usage.get("output_tokens", usage.get("completion_tokens", 0)),
                str(payload.get("id") or ""),
            ),
        )

    async def cancel(self, *, invocation_id: str, owner_id: str) -> ModelInvocationResult:
        active = self._active.get(invocation_id)
        if active is None or active[0] != owner_id:
            return ModelInvocationResult(invocation_id, ModelInvocationStatus.UNKNOWN)
        task = active[1]
        self._cancel_requested.add(invocation_id)
        caller = asyncio.current_task()
        if task is caller:
            return ModelInvocationResult(invocation_id, ModelInvocationStatus.RUNNING)
        task.cancel()
        interrupted = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                interrupted = interrupted or (caller is not None and caller.cancelling() > 0)
            except Exception:
                break
        if interrupted:
            raise asyncio.CancelledError
        if not task.cancelled() and task.exception() is not None:
            return ModelInvocationResult(invocation_id, ModelInvocationStatus.UNKNOWN)
        return ModelInvocationResult(invocation_id, ModelInvocationStatus.CANCELLED)
