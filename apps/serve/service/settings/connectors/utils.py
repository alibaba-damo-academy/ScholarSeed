"""Safe failure categories and owned cleanup shared by connector transports."""

from __future__ import annotations

import asyncio
import ssl

import httpx

NETWORK_DIAGNOSTIC_BYTES = 8192
POLICY_BLOCK_MARKERS = ("安全策略默认允许的范围", "云壳-防护记录-域名拦截")
HTTP_ERROR_CODES = {
    401: "connector_credentials_invalid",
    403: "connector_permission_denied",
    407: "connector_proxy_failed",
    429: "connector_rate_limited",
}


def network_error(error: httpx.HTTPError) -> str:
    if isinstance(error, httpx.DecodingError):
        return "connector_response_invalid"
    if isinstance(error, httpx.TimeoutException):
        return "connector_timeout"
    if isinstance(error, httpx.ProxyError):
        return "connector_proxy_failed"
    causes = []
    seen = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        causes.append(current)
        current = current.__cause__ or current.__context__
    if any(isinstance(cause, ssl.SSLCertVerificationError) for cause in causes):
        return "connector_certificate_untrusted"
    if any(isinstance(cause, ssl.SSLError) for cause in causes):
        return "connector_tls_failed"
    return "connector_network_unavailable"


def response_error(response: httpx.Response) -> str:
    if response.status_code == 403:
        try:
            content = response.content[:NETWORK_DIAGNOSTIC_BYTES].decode("utf-8", errors="replace")
        except httpx.ResponseNotRead:
            content = ""
        if all(marker in content for marker in POLICY_BLOCK_MARKERS):
            return "connector_network_blocked"
    return HTTP_ERROR_CODES.get(response.status_code, "connector_service_unavailable")


async def finish_cleanup(task: asyncio.Task[None]) -> None:
    """Caller cancellation cannot detach owned resource cleanup."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError
