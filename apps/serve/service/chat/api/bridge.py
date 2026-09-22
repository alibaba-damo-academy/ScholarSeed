"""Shared admission for session-bound internal product capabilities."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from typing import TypeVar, cast

from fastapi import Request

from service.chat.runtime.live import LiveSession
from service.chat.service.sessions import SessionService
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    BridgeCaller,
)

BridgeCallerT = TypeVar("BridgeCallerT", bound=BridgeCaller)


def scoped_bridge_caller(
    request: Request,
    resolver: Callable[[str], BridgeCallerT | None],
) -> BridgeCallerT | None:
    """Authenticate one active product execution scope with its private token."""

    scope_id = request.headers.get(BRIDGE_SESSION_HEADER, "")
    token = request.headers.get(BRIDGE_TOKEN_HEADER, "")
    caller = resolver(scope_id)
    if (
        caller is None
        or not token
        or not caller.bridge_token
        or not secrets.compare_digest(token.encode(), caller.bridge_token.encode())
    ):
        return None
    return caller


def bridge_caller(request: Request, sessions: SessionService) -> LiveSession | None:
    """Return the active session only when the private capability token matches."""

    caller = scoped_bridge_caller(request, sessions.bridge_caller)
    return cast(LiveSession | None, caller)
