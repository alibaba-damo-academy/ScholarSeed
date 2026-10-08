"""Transport-failure classification shared by the model bridge and subscription sync."""

from __future__ import annotations

import errno as errno_module
import os
import socket
import ssl
from enum import Enum
from typing import Any, Sequence

import httpx

EXCEPTION_CHAIN_LIMIT = 8
CONNECTION_RESET_ERRNOS = frozenset((errno_module.ECONNRESET, errno_module.EPIPE))
NETWORK_UNREACHABLE_ERRNOS = frozenset((errno_module.ENETUNREACH, errno_module.EHOSTUNREACH))
SOCKET_GAI_ERROR_NAMES = {
    value: name
    for name in dir(socket)
    if name.startswith("EAI_")
    for value in (getattr(socket, name),)
    if isinstance(value, int)
}


class TransportFailureCategory(str, Enum):
    DNS = "dns"
    PROXY = "proxy"
    TLS = "tls"
    CONNECT_TIMEOUT = "connect_timeout"
    READ_TIMEOUT = "read_timeout"
    WRITE_TIMEOUT = "write_timeout"
    POOL_TIMEOUT = "pool_timeout"
    CONNECTION_REFUSED = "connection_refused"
    CONNECTION_RESET = "connection_reset"
    CONNECTION_ABORTED = "connection_aborted"
    NETWORK_UNREACHABLE = "network_unreachable"
    PROTOCOL_ERROR = "protocol_error"
    CONNECT_ERROR = "connect_error"
    READ_ERROR = "read_error"
    WRITE_ERROR = "write_error"
    TRANSPORT_ERROR = "transport_error"
    UNKNOWN = "unknown"


# 连接尚未建立、请求字节从未到达上游的失败类别；重试天然幂等。响应已开始
# （read/write error、reset）的类别不在此列，交由上游 HTTP 状态重试策略处理。
RETRYABLE_CONNECT_FAILURE_CATEGORIES = frozenset(
    (
        TransportFailureCategory.CONNECT_ERROR.value,
        TransportFailureCategory.CONNECT_TIMEOUT.value,
    )
)
RETRYABLE_DNS_ERROR_NUMBERS = frozenset((socket.EAI_AGAIN,))
RETRYABLE_TLS_FAILURE_TYPES = (ssl.SSLEOFError,)


def transport_diagnostics(exc: BaseException) -> dict[str, Any]:
    """Classify a bounded exception chain without retaining exception messages."""

    chain = exception_chain(exc)
    root = chain[-1]
    os_error = next(
        (
            error
            for error in reversed(chain)
            if isinstance(error, OSError) and isinstance(error.errno, int)
        ),
        None,
    )
    error_number = os_error.errno if os_error is not None else None
    errno_name = ""
    errno_text = ""
    if error_number is not None:
        if isinstance(os_error, socket.gaierror):
            errno_name = SOCKET_GAI_ERROR_NAMES.get(error_number, "")
        elif not isinstance(os_error, ssl.SSLError):
            errno_name = errno_module.errorcode.get(error_number, "")
            errno_text = os.strerror(error_number)
    return {
        "failure_type": type(exc).__name__,
        "category": transport_category(chain, error_number).value,
        "cause_chain": ">".join(type(error).__name__ for error in chain),
        "root_type": type(root).__name__,
        "errno": error_number,
        "errno_name": errno_name,
        "errno_text": errno_text,
    }


def retryable_connect_failure(exc: BaseException, category: str) -> bool:
    if isinstance(exc, httpx.ConnectTimeout):
        return True
    if category in RETRYABLE_CONNECT_FAILURE_CATEGORIES:
        return True
    chain = exception_chain(exc)
    if category == TransportFailureCategory.DNS.value:
        return any(
            isinstance(error, socket.gaierror) and error.errno in RETRYABLE_DNS_ERROR_NUMBERS
            for error in chain
        )
    return any(isinstance(error, RETRYABLE_TLS_FAILURE_TYPES) for error in chain)


def retryable_pre_response_failure(exc: BaseException, category: str) -> bool:
    return category == TransportFailureCategory.CONNECTION_RESET.value or retryable_connect_failure(
        exc, category
    )


def exception_chain(exc: BaseException) -> tuple[BaseException, ...]:
    chain: list[BaseException] = []
    current: BaseException | None = exc
    while current is not None and len(chain) < EXCEPTION_CHAIN_LIMIT:
        chain.append(current)
        current = current.__cause__ or current.__context__
    return tuple(chain)


def transport_category(
    chain: Sequence[BaseException], error_number: int | None
) -> TransportFailureCategory:
    if any(isinstance(error, httpx.ProxyError) for error in chain):
        return TransportFailureCategory.PROXY
    if any(isinstance(error, socket.gaierror) for error in chain):
        return TransportFailureCategory.DNS
    if any(isinstance(error, ssl.SSLError) for error in chain):
        return TransportFailureCategory.TLS
    if any(isinstance(error, httpx.ConnectTimeout) for error in chain):
        return TransportFailureCategory.CONNECT_TIMEOUT
    if any(isinstance(error, httpx.ReadTimeout) for error in chain):
        return TransportFailureCategory.READ_TIMEOUT
    if any(isinstance(error, httpx.WriteTimeout) for error in chain):
        return TransportFailureCategory.WRITE_TIMEOUT
    if any(isinstance(error, httpx.PoolTimeout) for error in chain):
        return TransportFailureCategory.POOL_TIMEOUT
    if error_number == errno_module.ECONNREFUSED:
        return TransportFailureCategory.CONNECTION_REFUSED
    if error_number in CONNECTION_RESET_ERRNOS:
        return TransportFailureCategory.CONNECTION_RESET
    if error_number == errno_module.ECONNABORTED:
        return TransportFailureCategory.CONNECTION_ABORTED
    if error_number in NETWORK_UNREACHABLE_ERRNOS:
        return TransportFailureCategory.NETWORK_UNREACHABLE
    if any(isinstance(error, httpx.ProtocolError) for error in chain):
        return TransportFailureCategory.PROTOCOL_ERROR
    if any(isinstance(error, httpx.ConnectError) for error in chain):
        return TransportFailureCategory.CONNECT_ERROR
    if any(isinstance(error, httpx.ReadError) for error in chain):
        return TransportFailureCategory.READ_ERROR
    if any(isinstance(error, httpx.WriteError) for error in chain):
        return TransportFailureCategory.WRITE_ERROR
    if any(isinstance(error, httpx.TransportError) for error in chain):
        return TransportFailureCategory.TRANSPORT_ERROR
    return TransportFailureCategory.UNKNOWN
