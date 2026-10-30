"""Authenticated, bounded transport shared by scoped product clients."""

from __future__ import annotations

import json
import os
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel

from service.platform.vocabulary import (
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
    BRIDGE_SESSION_ENV,
    BRIDGE_SESSION_HEADER,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TIMEOUT_SECONDS,
    BRIDGE_TOKEN_ENV,
    BRIDGE_TOKEN_HEADER,
    INTERNAL_BASE_URL_ENV,
    JSON_ENCODING,
    LOCAL_SOCKET_BASE_URL,
    LOOPBACK_NAMES,
)


class BridgeResponseError(ValueError):
    def __init__(self, payload: dict) -> None:
        super().__init__(str(payload.get("error") or "bridge_query_failed"))
        self.payload = payload


def decode(raw: str, request_type: type[BaseModel]) -> dict:
    if len(raw.encode(JSON_ENCODING)) > BRIDGE_MAX_REQUEST_BYTES:
        raise ValueError("bridge_request_too_large")
    return request_type.model_validate(json.loads(raw)).model_dump(exclude_unset=True)


def request(route: str, payload: dict, *, blocking: bool = False) -> dict:
    base_url = os.environ.get(INTERNAL_BASE_URL_ENV, "").rstrip("/")
    token = os.environ.get(BRIDGE_TOKEN_ENV, "")
    session_id = os.environ.get(BRIDGE_SESSION_ENV, "")
    local_socket = os.environ.get(BRIDGE_SOCKET_ENV, "")
    if (not base_url and not local_socket) or not token or not session_id:
        raise ValueError("bridge_context_unavailable: run inside a ScholarSeed Agent session")
    if local_socket:
        base_url = LOCAL_SOCKET_BASE_URL
    address = urlsplit(base_url)
    if address.username or address.password or address.query or address.fragment:
        raise ValueError("bridge_address_invalid")
    if address.scheme != "https" and not (
        address.scheme == "http" and address.hostname in LOOPBACK_NAMES
    ):
        raise ValueError("bridge_secure_transport_required")
    transport = httpx.HTTPTransport(uds=local_socket) if local_socket else None
    timeout = (
        httpx.Timeout(BRIDGE_TIMEOUT_SECONDS, read=None)
        if blocking
        else httpx.Timeout(BRIDGE_TIMEOUT_SECONDS)
    )
    with httpx.Client(timeout=timeout, trust_env=False, transport=transport) as client:
        with client.stream(
            "POST",
            f"{base_url}{route}",
            headers={BRIDGE_SESSION_HEADER: session_id, BRIDGE_TOKEN_HEADER: token},
            json=payload,
        ) as response:
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > BRIDGE_MAX_RESPONSE_BYTES:
                    raise ValueError("bridge_response_too_large")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError("bridge_response_invalid")
            if response.is_error:
                raise BridgeResponseError(result)
            return result
