"""Safe provider failure extraction at the Codex protocol boundary."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any

from scholarseed_runtime.contract.incident import RuntimeRetryability

CODEX_PROVIDER_FAILED = "codex_provider_failed"
CONTENT_SAFETY_BLOCKED = "CONTENT_SAFETY_BLOCKED"
PROVIDER_FAILURE_MESSAGE = "The model provider rejected the request."
PROVIDER_QUOTA_MESSAGE = "The model provider allocation quota is exhausted."
PROVIDER_RATE_LIMIT_MESSAGE = "The model provider rate limit was reached."
PROVIDER_AUTH_MESSAGE = "The model provider authentication failed."
PROVIDER_REQUEST_MESSAGE = "The model provider rejected the request parameters."
PROVIDER_MODEL_CONFIG_MESSAGE = "The endpoint does not support this model; check the model name."
PROVIDER_UNAVAILABLE_MESSAGE = "The model provider is temporarily unavailable."
PROVIDER_CONTENT_POLICY_MESSAGE = "The request did not pass content safety review."
PROVIDER_CREDITS_MESSAGE = "The account credit balance is exhausted."
PROVIDER_SUBSCRIPTION_CAPABILITY_MESSAGE = (
    "The ChatGPT subscription connection does not support this request capability. "
    "Use a compatible model source or start a task without that capability; "
    "retrying unchanged will fail."
)
CODEX_QUOTA_EXCEEDED_MESSAGE = "Quota exceeded. Check your plan and billing details."

_SSE_EVENT_ERROR = "event:error"
_SSE_DATA_PREFIX = "data:"
_HTTP_ERROR_PREFIX = re.compile(r"^unexpected status (\d{3})\b[^:]*:\s*", re.IGNORECASE)
_RETRY_EXHAUSTED_STATUS = re.compile(
    r"^exceeded retry limit, last status:\s*(\d{3})\b", re.IGNORECASE
)
_CODEX_ERROR_INFO_KEYS = ("codexErrorInfo", "codex_error_info")
_HTTP_STATUS_KEYS = ("httpStatusCode", "http_status_code")
_SSE_HTTP_STATUS = re.compile(r"^:HTTP_STATUS/(\d{3})\s*$", re.MULTILINE)
_PROVIDER_ERROR_PREFIX = re.compile(r"^<(\d{3})>\s+([A-Za-z][A-Za-z0-9_.-]*)(?::|$)", re.IGNORECASE)
# Codex 把流内终态失败压平成散文时套的包装（bug 87190842：``stream disconnected before
# completion: <500> InternalError.Algo: …``）。_PROVIDER_ERROR_PREFIX 是前缀锚定的，不剥掉这层
# 包装就取不到真实状态，瞬时 5xx 会塌成 codex_provider_failed + 「rejected the request」。
_CODEX_STREAM_DISCONNECTED_PREFIX = re.compile(
    r"^stream disconnected before completion:\s*", re.IGNORECASE
)
_CONTENT_POLICY_CODES = frozenset(
    {"content_safety_blocked", "content_policy_violation", "content_filter"}
)
_CODE_BY_PROVIDER_SIGNATURE = {
    (
        "server_error",
        400,
        "internalerror.algo.datainspectionfailed",
    ): CONTENT_SAFETY_BLOCKED,
}
_CODE_BY_NORMALIZED_FAILURE = {
    ("invalid_prompt", PROVIDER_CONTENT_POLICY_MESSAGE.casefold()): CONTENT_SAFETY_BLOCKED,
}

_QUOTA_CODES = frozenset(
    {
        "insufficient_quota",
        "throttling.allocationquota",
    }
)
_RATE_LIMIT_CODES = frozenset(
    {
        "rate_limit_error",
        "rate_limit_exceeded",
        "throttling.ratelimit",
        "throttling.requestsratelimit",
    }
)
_AUTH_CODES = frozenset(
    {
        "authentication_error",
        "invalid_api_key",
        "model_bridge_credential_required",
        "permission_denied",
        "runtime_not_authenticated",
        "unauthorized",
    }
)
_REQUEST_CODES = frozenset(
    {
        "bad_request",
        "invalid_request_error",
    }
)
# 模型/参数类配置错误：用户改个模型名即可自修，是确定性终态（重试无意义）。Codex 当前会
# 把这类 response.failed 的 error.code 拍平成可重试的流中断，故本表是防御性的——当码经
# serve bridge 恢复（proposal 106 R1）或未来上游修复后到达 adapter 即生效。
_MODEL_CONFIG_CODES = frozenset(
    {
        "invalidparameter",
        "model_not_found",
        "unsupported_model",
    }
)
_UNAVAILABLE_CODES = frozenset(
    {
        "overloaded",
        "server_error",
        "server_is_overloaded",
        "service_unavailable",
        "timeout",
    }
)
# 产品级计费码（自有网关 429 的业务信封，经 serve bridge 脱敏分支登记放行）：不是厂商
# 语义，重试无意义（余额只能靠补充恢复），故同时进 _TERMINAL_CODES。
_CREDIT_CODES = frozenset(
    {
        "credit_balance_exhausted",
    }
)
_SUBSCRIPTION_CAPABILITY_CODES = frozenset(
    {
        "subscription_sharing_unsupported_capability",
    }
)
_TERMINAL_CODES = (
    _QUOTA_CODES
    | _AUTH_CODES
    | _REQUEST_CODES
    | _MODEL_CONFIG_CODES
    | _CONTENT_POLICY_CODES
    | _CREDIT_CODES
    | _SUBSCRIPTION_CAPABILITY_CODES
)
_CODE_BY_MESSAGE = {
    CODEX_QUOTA_EXCEEDED_MESSAGE.casefold(): "insufficient_quota",
    PROVIDER_CONTENT_POLICY_MESSAGE.casefold(): CONTENT_SAFETY_BLOCKED,
}
# 瞬时 5xx 家族（与 serve ``rejections.TRANSIENT_PROVIDER_HTTP_STATUSES`` 同集合）统一归
# server_error：只有 Codex 散文、没有结构化码时也能恢复「暂时不可用」语义。
_TRANSIENT_HTTP_STATUSES = frozenset(
    (
        HTTPStatus.INTERNAL_SERVER_ERROR,
        HTTPStatus.BAD_GATEWAY,
        HTTPStatus.SERVICE_UNAVAILABLE,
        HTTPStatus.GATEWAY_TIMEOUT,
    )
)
_CODE_BY_HTTP_STATUS: dict[int, str] = {
    HTTPStatus.TOO_MANY_REQUESTS: "rate_limit_exceeded",
    **dict.fromkeys(_TRANSIENT_HTTP_STATUSES, "server_error"),
}
_SAFE_MESSAGES = {
    **dict.fromkeys(_CONTENT_POLICY_CODES, PROVIDER_CONTENT_POLICY_MESSAGE),
    **dict.fromkeys(_QUOTA_CODES, PROVIDER_QUOTA_MESSAGE),
    **dict.fromkeys(_RATE_LIMIT_CODES, PROVIDER_RATE_LIMIT_MESSAGE),
    **dict.fromkeys(_AUTH_CODES, PROVIDER_AUTH_MESSAGE),
    **dict.fromkeys(_REQUEST_CODES, PROVIDER_REQUEST_MESSAGE),
    **dict.fromkeys(_MODEL_CONFIG_CODES, PROVIDER_MODEL_CONFIG_MESSAGE),
    **dict.fromkeys(_UNAVAILABLE_CODES, PROVIDER_UNAVAILABLE_MESSAGE),
    **dict.fromkeys(_CREDIT_CODES, PROVIDER_CREDITS_MESSAGE),
    **dict.fromkeys(_SUBSCRIPTION_CAPABILITY_CODES, PROVIDER_SUBSCRIPTION_CAPABILITY_MESSAGE),
}


@dataclass(frozen=True)
class ProviderFailure:
    code: str
    message: str
    retryability: RuntimeRetryability
    diagnostic_code: str = CODEX_PROVIDER_FAILED
    http_status: int | None = None


def unpack_error(value: Any) -> tuple[str, str]:
    """Unwrap a native provider error without retaining its transport envelope."""

    if isinstance(value, Mapping):
        raw_nested = value.get("error")
        error = raw_nested if isinstance(raw_nested, Mapping) else value
        code = str(error.get("code") or error.get("type") or "").strip()
        message = str(error.get("message") or "").strip()
        return code, message
    return "", str(value or "").strip()


def provider_failure(value: Any) -> ProviderFailure:
    """Extract stable, redacted provider semantics from one native error value."""

    code, message = unpack_error(value)
    # Codex 的散文包装挡住前缀锚定的状态/签名提取，先剥一层再解析（无包装时 sub 是 no-op）。
    probe_text = _CODEX_STREAM_DISCONNECTED_PREFIX.sub("", message, count=1)
    http_status = _native_http_status(value) or _http_status(probe_text)
    sse_error = _sse_error(probe_text) or _http_error(probe_text)
    if sse_error is None and isinstance(value, Mapping):
        details = str(value.get("additionalDetails") or "")
        sse_error = _http_error(details)
        http_status = http_status or _http_status(details)
    if sse_error is not None:
        nested_code, nested_message = unpack_error(sse_error)
        code = nested_code or code
        message = nested_message or message
    if not code:
        code = _CODE_BY_MESSAGE.get(message.casefold(), "")
    if not code and http_status is not None:
        code = _CODE_BY_HTTP_STATUS.get(http_status, "")
    code = _canonical_provider_code(code, probe_text)
    # Some providers use a generic request code even for rejected credentials.
    # Preserve known auth identities (notably account recovery), but never let
    # a generic body code hide the explicit HTTP authentication failure.
    if http_status == HTTPStatus.UNAUTHORIZED and code.casefold() not in _AUTH_CODES:
        code = "authentication_error"
    normalized = code.casefold()
    message = _safe_message(code)
    return ProviderFailure(
        code=code or CODEX_PROVIDER_FAILED,
        message=message or _safe_message(code),
        retryability=(
            RuntimeRetryability.TERMINAL
            if normalized in _TERMINAL_CODES
            else RuntimeRetryability.USER_RETRYABLE
        ),
        diagnostic_code=normalized if normalized in _SAFE_MESSAGES else CODEX_PROVIDER_FAILED,
        http_status=http_status,
    )


def authentication_failure(failure: ProviderFailure) -> bool:
    return failure.code.casefold() in _AUTH_CODES


def provider_codes() -> frozenset[str]:
    """Provider error codes this adapter classifies into a dedicated safe message."""

    return frozenset(_SAFE_MESSAGES)


def _safe_message(code: str) -> str:
    return _SAFE_MESSAGES.get(code.casefold(), PROVIDER_FAILURE_MESSAGE)


def _canonical_provider_code(code: str, message: str) -> str:
    normalized = _CODE_BY_NORMALIZED_FAILURE.get((code.casefold(), message.casefold()))
    if normalized is not None:
        return normalized
    match = _PROVIDER_ERROR_PREFIX.match(message)
    if match is None:
        return code
    signature = (code.casefold(), int(match.group(1)), match.group(2).casefold())
    return _CODE_BY_PROVIDER_SIGNATURE.get(signature, code)


def _native_http_status(value: Any) -> int | None:
    if not isinstance(value, Mapping):
        return None
    nested = value.get("error")
    envelopes = (nested, value) if isinstance(nested, Mapping) else (value,)
    for envelope in envelopes:
        for info_key in _CODEX_ERROR_INFO_KEYS:
            info = envelope.get(info_key)
            if not isinstance(info, Mapping):
                continue
            for details in info.values():
                if not isinstance(details, Mapping):
                    continue
                for status_key in _HTTP_STATUS_KEYS:
                    status = details.get(status_key)
                    if type(status) is int and 400 <= status <= 599:
                        return status
    return None


def _http_status(message: str) -> int | None:
    match = (
        _HTTP_ERROR_PREFIX.match(message)
        or _SSE_HTTP_STATUS.search(message)
        or _PROVIDER_ERROR_PREFIX.match(message)
        or _RETRY_EXHAUSTED_STATUS.match(message)
    )
    if match is None:
        return None
    status = int(match.group(1))
    return status if 400 <= status <= 599 else None


def _http_error(message: str) -> Mapping[str, Any] | None:
    """Read Codex's HTTP error envelope, never infer policy from prose."""
    prefix = _HTTP_ERROR_PREFIX.match(message)
    try:
        if prefix is None:
            value = json.loads(message)
        else:
            value, _end = json.JSONDecoder().raw_decode(message[prefix.end() :])
    except ValueError:
        return None
    if not isinstance(value, Mapping) or not isinstance(value.get("error"), Mapping):
        return None
    return value


def _sse_error(message: str) -> Mapping[str, Any] | None:
    lines = message.splitlines()
    if not any(line.strip().casefold() == _SSE_EVENT_ERROR for line in lines):
        return None
    data = "\n".join(
        line.strip()[len(_SSE_DATA_PREFIX) :].lstrip()
        for line in lines
        if line.strip().casefold().startswith(_SSE_DATA_PREFIX)
    )
    if not data:
        return {}
    try:
        value = json.loads(data)
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, Mapping) else {}


__all__ = [
    "CODEX_PROVIDER_FAILED",
    "PROVIDER_FAILURE_MESSAGE",
    "ProviderFailure",
    "authentication_failure",
    "provider_codes",
    "provider_failure",
    "unpack_error",
]
