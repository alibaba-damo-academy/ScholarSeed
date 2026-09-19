"""Safe provider failure extraction at the Codex protocol boundary."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from scholarseed_runtime.contract.incident import RuntimeRetryability

CODEX_PROVIDER_FAILED = "codex_provider_failed"
PROVIDER_FAILURE_MESSAGE = "The model provider rejected the request."
PROVIDER_QUOTA_MESSAGE = "The model provider allocation quota is exhausted."
PROVIDER_RATE_LIMIT_MESSAGE = "The model provider rate limit was reached."
PROVIDER_AUTH_MESSAGE = "The model provider authentication failed."
PROVIDER_REQUEST_MESSAGE = "The model provider rejected the request parameters."
PROVIDER_UNAVAILABLE_MESSAGE = "The model provider is temporarily unavailable."
PROVIDER_CONTENT_POLICY_MESSAGE = "The request did not pass content safety review."
PROVIDER_CREDITS_MESSAGE = "The account credit balance is exhausted."
CODEX_QUOTA_EXCEEDED_MESSAGE = "Quota exceeded. Check your plan and billing details."

_SSE_EVENT_ERROR = "event:error"
_SSE_DATA_PREFIX = "data:"
_HTTP_ERROR_PREFIX = re.compile(r"^unexpected status \d{3}\b[^:]*:\s*", re.IGNORECASE)
_CONTENT_POLICY_CODES = frozenset(
    {"content_safety_blocked", "content_policy_violation", "content_filter"}
)

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
        "permission_denied",
        "runtime_not_authenticated",
        "unauthorized",
    }
)
_REQUEST_CODES = frozenset(
    {
        "bad_request",
        "invalid_request_error",
        "model_not_found",
    }
)
_UNAVAILABLE_CODES = frozenset(
    {
        "overloaded",
        "server_error",
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
_TERMINAL_CODES = (
    _QUOTA_CODES | _AUTH_CODES | _REQUEST_CODES | _CONTENT_POLICY_CODES | _CREDIT_CODES
)
_CODE_BY_MESSAGE = {
    CODEX_QUOTA_EXCEEDED_MESSAGE.casefold(): "insufficient_quota",
}
_SAFE_MESSAGES = {
    **dict.fromkeys(_CONTENT_POLICY_CODES, PROVIDER_CONTENT_POLICY_MESSAGE),
    **dict.fromkeys(_QUOTA_CODES, PROVIDER_QUOTA_MESSAGE),
    **dict.fromkeys(_RATE_LIMIT_CODES, PROVIDER_RATE_LIMIT_MESSAGE),
    **dict.fromkeys(_AUTH_CODES, PROVIDER_AUTH_MESSAGE),
    **dict.fromkeys(_REQUEST_CODES, PROVIDER_REQUEST_MESSAGE),
    **dict.fromkeys(_UNAVAILABLE_CODES, PROVIDER_UNAVAILABLE_MESSAGE),
    **dict.fromkeys(_CREDIT_CODES, PROVIDER_CREDITS_MESSAGE),
}


@dataclass(frozen=True)
class ProviderFailure:
    code: str
    message: str
    retryability: RuntimeRetryability


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
    sse_error = _sse_error(message) or _http_error(message)
    if sse_error is None and isinstance(value, Mapping):
        sse_error = _http_error(str(value.get("additionalDetails") or ""))
    if sse_error is not None:
        nested_code, _nested_message = unpack_error(sse_error)
        code = nested_code or code
        message = _safe_message(code)
    if not code:
        code = _CODE_BY_MESSAGE.get(message.casefold(), "")
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
    )


def _safe_message(code: str) -> str:
    return _SAFE_MESSAGES.get(code.casefold(), PROVIDER_FAILURE_MESSAGE)


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
    "provider_failure",
    "unpack_error",
]
