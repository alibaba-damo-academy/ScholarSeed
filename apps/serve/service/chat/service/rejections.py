"""Product-facing policies for upstream provider failures.

A deterministic, user-fixable upstream rejection (parameter / model / request /
credential class) arrives at the serve loopback bridge as a terminal
``response.failed`` carrying a structured ``error.code``. Codex flattens that code
into a retryable prose "stream disconnected" before it reaches the adapter, so the
bridge is the last layer that still sees the structured error. This module is the
single source for *which* upstream codes may be released to the product surface and
how — terminal status, HTTP semantic, and message policy. A new vendor code is new
data here (plus the desktop copy registry and the adapter classification registry),
never a new branch in core code.

Codes outside this whitelist keep folding into the generic ``MODEL_UPSTREAM_REJECTED``
upstream and are never released verbatim. Exhausted transient HTTP failures use a fixed
product message and retry-attempt count. Messages released to the product surface are
the bridge's already-redacted, URL-masked, length-bounded ``error_message`` — never the
full upstream envelope, credentials, or request ids.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from http import HTTPStatus
from typing import Any, Mapping

from scholarseed_runtime.contract.incident import RuntimeRetryability
from service.chat.service.streams import (
    CODEX_INVALID_PROMPT,
    CONTENT_SAFETY_BLOCKED,
    CONTENT_SAFETY_MESSAGE,
    RESPONSE_FAILED,
)


class RejectionMessage(Enum):
    """How a released rejection derives its product-safe message."""

    # 用表内固定文案：上游原文可能含策略/敏感细节，折叠掉（content safety 沿用既有语义）。
    FIXED = "fixed"
    # 放行 bridge 已脱敏/打码/截断的上游 error_message：配置类错误的原文才是可操作信息
    # （如 "Unsupported model: 'X'"）。为空时回落到表内固定文案。
    BOUNDED = "bounded"


@dataclass(frozen=True)
class RejectionPolicy:
    """One whitelisted upstream code's release policy."""

    retryability: RuntimeRetryability
    http_status: int
    message: RejectionMessage
    safe_message: str = ""
    # 非空=把上游码重映射成该产品码再放行（content safety 经 normalizer 改写成
    # invalid_prompt 后靠这里还原成 CONTENT_SAFETY_BLOCKED）；空=放行原始上游码
    # （参数/模型类保留真实厂商码，如 InvalidParameter，供 Trace 归因与桌面端 casefold 匹配）。
    product_code: str = ""


# 模型/参数类配置错误：用户改个模型名即可自修，确定性终态，HTTP 语义 400。
MODEL_CONFIG_SAFE_MESSAGE = "The model is not supported by this endpoint."
# 其余确定性 4xx 请求类。
REQUEST_SAFE_MESSAGE = "The model provider rejected the request."
# 确定性 4xx 认证/凭据类。
AUTH_SAFE_MESSAGE = "The model provider rejected the credentials."
TRANSIENT_PROVIDER_FAILURE_CODE = "service_unavailable"
TRANSIENT_PROVIDER_FAILURE_MESSAGE = "The model provider is temporarily unavailable."
TRANSIENT_PROVIDER_HTTP_STATUSES = frozenset(
    (
        HTTPStatus.INTERNAL_SERVER_ERROR,
        HTTPStatus.BAD_GATEWAY,
        HTTPStatus.SERVICE_UNAVAILABLE,
        HTTPStatus.GATEWAY_TIMEOUT,
    )
)

# 首批范围（proposal 106 评审已定：含更多 4xx，按 LiteLLM「4xx 即确定性、不重试」分档）。
# 5xx/429 不在此确定性错误表；耗尽的瞬时 5xx 由上方 HTTP 状态集合单独恢复。
# 键一律 casefold（匹配时 ``code.casefold()``）。
PRODUCT_PROVIDER_REJECTIONS: Mapping[str, RejectionPolicy] = {
    CONTENT_SAFETY_BLOCKED.casefold(): RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.FIXED,
        safe_message=CONTENT_SAFETY_MESSAGE,
        product_code=CONTENT_SAFETY_BLOCKED,
    ),
    "invalidparameter": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.BOUNDED,
        safe_message=MODEL_CONFIG_SAFE_MESSAGE,
    ),
    "model_not_found": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.BOUNDED,
        safe_message=MODEL_CONFIG_SAFE_MESSAGE,
    ),
    "unsupported_model": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.BOUNDED,
        safe_message=MODEL_CONFIG_SAFE_MESSAGE,
    ),
    "invalid_request_error": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.BOUNDED,
        safe_message=REQUEST_SAFE_MESSAGE,
    ),
    "bad_request": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.BOUNDED,
        safe_message=REQUEST_SAFE_MESSAGE,
    ),
    "invalid_api_key": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=401,
        message=RejectionMessage.BOUNDED,
        safe_message=AUTH_SAFE_MESSAGE,
    ),
    "unauthorized": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=401,
        message=RejectionMessage.BOUNDED,
        safe_message=AUTH_SAFE_MESSAGE,
    ),
    "authentication_error": RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=401,
        message=RejectionMessage.BOUNDED,
        safe_message=AUTH_SAFE_MESSAGE,
    ),
}

# Codex 归一变体：内容安全经 native normalizer 改写成 code=invalid_prompt +
# type=CONTENT_SAFETY_BLOCKED（借 Codex 自带 invalid_prompt 终态白名单止重试，见
# streams._normalize_native_response_line），归因靠 (code, error_type) 还原产品码。
# 键为 (error_code, error_type) 双双 casefold；error_type 为空时不命中（不放行）。
CODEX_PROVIDER_REJECTIONS: Mapping[tuple[str, str], RejectionPolicy] = {
    (CODEX_INVALID_PROMPT.casefold(), CONTENT_SAFETY_BLOCKED.casefold()): RejectionPolicy(
        retryability=RuntimeRetryability.TERMINAL,
        http_status=400,
        message=RejectionMessage.FIXED,
        safe_message=CONTENT_SAFETY_MESSAGE,
        product_code=CONTENT_SAFETY_BLOCKED,
    ),
}


def terminal_provider_failure(fields: Mapping[str, Any]) -> dict[str, Any]:
    """Recover product semantics from a finished bridge diagnostic.

    Returns the terminal payload keys the ledger projection consumes (``error`` /
    ``error_code`` / ``safe_error`` / ``retryability``) plus ``provider_http_status``
    for incident backfill, or ``{}`` when the diagnostic is not a whitelisted terminal
    provider failure. Exhausted transient HTTP failures use a fixed product-safe
    message. Deterministic rejection messages use the bridge's already-redacted,
    bounded ``error_message`` for BOUNDED codes, never the raw upstream envelope.
    Lookup is by ``error_code`` first, then by the Codex-normalized
    ``(error_code, error_type)`` pair; a hit may remap to a stable ``product_code``.
    """

    status = fields.get("status_code")
    attempt = fields.get("attempt")
    max_attempts = fields.get("max_attempts")
    if (
        fields.get("phase") == "finished"
        and isinstance(status, int)
        and not isinstance(status, bool)
        and status in TRANSIENT_PROVIDER_HTTP_STATUSES
        and isinstance(attempt, int)
        and not isinstance(attempt, bool)
        and isinstance(max_attempts, int)
        and not isinstance(max_attempts, bool)
        and max_attempts > 1
        and attempt >= max_attempts
    ):
        return {
            "error": TRANSIENT_PROVIDER_FAILURE_MESSAGE,
            "error_code": TRANSIENT_PROVIDER_FAILURE_CODE,
            "safe_error": TRANSIENT_PROVIDER_FAILURE_MESSAGE,
            "retryability": RuntimeRetryability.USER_RETRYABLE.value,
            "provider_http_status": int(status),
            "automatic_retry_attempts": attempt,
        }
    downstream = fields.get("downstream")
    if (
        fields.get("phase") != "finished"
        or not isinstance(downstream, Mapping)
        or downstream.get("terminal_event") != RESPONSE_FAILED
    ):
        return {}
    code = str(downstream.get("error_code") or "")
    error_type = str(downstream.get("error_type") or "")
    policy = PRODUCT_PROVIDER_REJECTIONS.get(code.casefold())
    if policy is None:
        policy = CODEX_PROVIDER_REJECTIONS.get((code.casefold(), error_type.casefold()))
    if policy is None:
        return {}
    if policy.message is RejectionMessage.FIXED:
        message = policy.safe_message
    else:
        message = str(downstream.get("error_message") or "").strip() or policy.safe_message
    return {
        "error": message,
        "error_code": policy.product_code or code,
        "safe_error": message,
        "retryability": policy.retryability.value,
        "provider_http_status": policy.http_status,
    }


__all__ = [
    "CODEX_PROVIDER_REJECTIONS",
    "PRODUCT_PROVIDER_REJECTIONS",
    "RejectionMessage",
    "RejectionPolicy",
    "TRANSIENT_PROVIDER_HTTP_STATUSES",
    "terminal_provider_failure",
]
