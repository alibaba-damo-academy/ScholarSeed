"""Shared admission for session-bound internal product capabilities."""

from __future__ import annotations

import secrets
from collections.abc import AsyncIterator, Callable
from typing import TypeVar, cast

from fastapi import HTTPException, Request

from service.chat.runtime.live import LiveSession
from service.chat.service.sessions import SessionService
from service.platform.activity import (
    Activities,
    ActivityDomain,
    MaintenanceActive,
    MaintenanceStale,
)
from service.platform.bridge import BridgeCaller
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
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


def session_bridge_admission(
    sessions: SessionService, activities: Activities
) -> Callable[[Request], AsyncIterator[None]]:
    """Continue a server-owned turn, never create a new root from a bridge token.

    Routes retain their existing anonymous/capability error payloads. An invalid
    caller receives no execution lease and must be rejected by the route itself.
    """

    async def admit(request: Request) -> AsyncIterator[None]:
        live = bridge_caller(request, sessions)
        if live is None:
            yield
            return
        try:
            activity = activities.continue_from(live.turn_activity, ActivityDomain.BRIDGE)
        except (MaintenanceActive, MaintenanceStale) as error:
            raise HTTPException(503, "update_activity_expired") from error
        with activity:
            yield

    return admit


def scoped_bridge_admission(
    resolver: Callable[[str], BridgeCaller | None], activities: Activities
) -> Callable[[Request], AsyncIterator[None]]:
    """Hold the authenticated execution's live capability across the whole route."""

    async def admit(request: Request) -> AsyncIterator[None]:
        caller = scoped_bridge_caller(request, resolver)
        if caller is None:
            yield
            return
        try:
            activity = activities.continue_from(caller.bridge_activity, ActivityDomain.BRIDGE)
        except (MaintenanceActive, MaintenanceStale) as error:
            raise HTTPException(503, "update_activity_expired") from error
        with activity:
            yield

    return admit
