"""Ask an endpoint about a candidate personal model connection, saved or unsaved.

DamoAgent's native prober was removed with the Harness, and the retained
``surface/model/catalog.probe_model_choice`` raises unconditionally. Wire-protocol
translation already belongs to Serve (see ``completions.CompletionBridge``), so these
queries live here and speak the same protocol a session would.

Two questions are answered here, both against a *candidate* connection: "can it be
reached" (probe) and "which models does it offer" (model listing). Neither persists
anything nor changes the active selection.
"""

from __future__ import annotations

import time
from typing import Any, Mapping

import httpx

from scholarseed_runtime.contract import ModelWireProtocol
from service.settings.connections import (
    personal_call_url,
    prepare_personal_connection,
    profile_wire_api,
    resolve_personal_credential,
)

PROBE_PROMPT = "Say pong and nothing else."
PROBE_MAX_TOKENS = 16
PROBE_CONNECT_TIMEOUT_SECONDS = 10.0
PROBE_READ_TIMEOUT_SECONDS = 30.0
RESPONSES_PATH = "/responses"
MODELS_PATH = "/models"
BEARER_PREFIX = "Bearer "
AUTHORIZATION_HEADER = "Authorization"
PROBE_OK_MESSAGE = "连接成功"
PROBE_UNSUPPORTED_PROTOCOL_ERROR = "unsupported_wire_api"
PROBE_HTTP_ERROR = "http_status"
MODELS_OK_MESSAGE = "已拉取 {count} 个模型"
MODELS_EMPTY_MESSAGE = "该端点没有返回模型列表，请手动填写模型名"
MODELS_DATA_KEY = "data"
MODELS_ID_KEY = "id"
# 上游错误体可能很长且可能回显请求内容, 截断后只作诊断展示。
PROBE_ERROR_BODY_LIMIT = 240


def _request(connection: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """Return the URL and minimal body for the protocol this connection declares."""

    wire_api = profile_wire_api(connection)
    model_name = str(connection.get("model_name") or "").strip()
    if wire_api == ModelWireProtocol.CHAT_COMPLETIONS.value:
        return personal_call_url(connection), {
            "model": model_name,
            "messages": [{"role": "user", "content": PROBE_PROMPT}],
            "max_tokens": PROBE_MAX_TOKENS,
            "stream": False,
        }
    if wire_api == ModelWireProtocol.RESPONSES.value:
        base_url = str(connection.get("base_url") or "").strip().rstrip("/")
        return f"{base_url}{RESPONSES_PATH}", {
            "model": model_name,
            "input": PROBE_PROMPT,
            "max_output_tokens": PROBE_MAX_TOKENS,
            "stream": False,
        }
    raise ValueError(f"cannot probe wire_api {wire_api!r}")


def _headers(connection: Mapping[str, Any]) -> dict[str, str]:
    headers = {
        str(name): str(value)
        for name, value in (connection.get("headers") or {}).items()
        if str(value)
    }
    api_key = str(connection.get("api_key") or "").strip()
    if api_key and AUTHORIZATION_HEADER not in headers:
        headers[AUTHORIZATION_HEADER] = f"{BEARER_PREFIX}{api_key}"
    return headers


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(PROBE_READ_TIMEOUT_SECONDS, connect=PROBE_CONNECT_TIMEOUT_SECONDS)


def probe_personal_connection(
    values: Mapping[str, Any], existing: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Issue one minimal request against a candidate connection without saving it.

    ``existing`` lets the editor re-test a saved profile without the UI ever holding
    its credential: an empty ``api_key`` keeps the stored one.
    """

    started = time.time()
    try:
        connection = prepare_personal_connection(values, existing=existing)
        url, body = _request(connection)
    except ValueError as error:
        return {
            "ok": False,
            "message": str(error),
            "latency_ms": int((time.time() - started) * 1000),
            "error_class": PROBE_UNSUPPORTED_PROTOCOL_ERROR,
        }
    try:
        with httpx.Client(timeout=_timeout()) as client:
            response = client.post(url, json=body, headers=_headers(connection))
        ok = response.is_success
        message = PROBE_OK_MESSAGE if ok else response.text[:PROBE_ERROR_BODY_LIMIT]
        result: dict[str, Any] = {"ok": ok, "message": message}
        if not ok:
            result["error_class"] = f"{PROBE_HTTP_ERROR}_{response.status_code}"
    except httpx.HTTPError as error:
        result = {
            "ok": False,
            "message": str(error)[:PROBE_ERROR_BODY_LIMIT],
            "error_class": type(error).__name__,
        }
    result["latency_ms"] = int((time.time() - started) * 1000)
    return result


def list_upstream_models(
    values: Mapping[str, Any], existing: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Read the model ids a candidate endpoint advertises, without saving anything.

    Model names are read live instead of shipped as a preset list because vendor
    catalogues retire entries: a saved-in-product list goes stale silently, whereas an
    endpoint that stops offering a model says so here.

    ``model_name`` is irrelevant to this request, so a connection whose model field is
    still empty can be listed — that is exactly the state the editor is in when the
    user wants candidates.
    """

    started = time.time()
    base_url = str(values.get("base_url") or "").strip().rstrip("/")
    if not base_url:
        return {
            "ok": False,
            "models": [],
            "message": "base_url is required",
            "latency_ms": int((time.time() - started) * 1000),
        }
    api_key, custom_headers = resolve_personal_credential(values, existing)
    headers = _headers({"api_key": api_key, "headers": custom_headers})
    try:
        with httpx.Client(timeout=_timeout()) as client:
            response = client.get(f"{base_url}{MODELS_PATH}", headers=headers)
        if not response.is_success:
            return {
                "ok": False,
                "models": [],
                "message": response.text[:PROBE_ERROR_BODY_LIMIT],
                "error_class": f"{PROBE_HTTP_ERROR}_{response.status_code}",
                "latency_ms": int((time.time() - started) * 1000),
            }
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        return {
            "ok": False,
            "models": [],
            "message": str(error)[:PROBE_ERROR_BODY_LIMIT],
            "error_class": type(error).__name__,
            "latency_ms": int((time.time() - started) * 1000),
        }
    rows = payload.get(MODELS_DATA_KEY) if isinstance(payload, dict) else None
    models = sorted(
        {
            str(row.get(MODELS_ID_KEY) or "").strip()
            for row in (rows if isinstance(rows, list) else ())
            if isinstance(row, Mapping) and str(row.get(MODELS_ID_KEY) or "").strip()
        }
    )
    return {
        "ok": bool(models),
        "models": models,
        "message": (
            MODELS_OK_MESSAGE.format(count=len(models)) if models else MODELS_EMPTY_MESSAGE
        ),
        "latency_ms": int((time.time() - started) * 1000),
    }
