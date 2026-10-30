"""Account for complete HTTP responses, including disconnect cleanup.

This is a transport barrier, not an endpoint admission policy. Execution owners
still decide whether a request starts new work or continues an existing task.
Passive event subscriptions must close before sealing; headers alone never
release the barrier. Threads abandoned by request cancellation need their own
execution leases.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from contextlib import ExitStack
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from service.platform.activity import Activities, ActivityDomain, MaintenanceActive


def _maintenance_response(
    _request: Request | None = None, _error: Exception | None = None
) -> JSONResponse:
    return JSONResponse(
        {"detail": "update_maintenance"},
        status_code=503,
        headers={"Retry-After": "1", "Cache-Control": "no-store"},
    )


class ServeApplication(FastAPI):
    """Keep the barrier outside Starlette's outer error response handler."""

    def __init__(self, *, activities: Activities, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.state.activities = activities
        self.add_exception_handler(MaintenanceActive, _maintenance_response)

    def build_middleware_stack(self) -> ASGIApp:
        return HttpActivityMiddleware(
            super().build_middleware_stack(), activities=self.state.activities
        )


class HttpActivityMiddleware:
    def __init__(self, app: ASGIApp, *, activities: Activities) -> None:
        self.app = app
        self.activities = activities

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket" and not self.activities.workbench_ready:
            await send({"type": "websocket.close", "code": 1013})
            return
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if (
            scope.get("method") not in {"GET", "HEAD", "OPTIONS"}
            and not self.activities.workbench_ready
        ):
            await _maintenance_response()(scope, receive, send)
            return
        with ExitStack() as stack:
            try:
                stack.enter_context(self.activities.observe_request())
            except MaintenanceActive:
                response = _maintenance_response()
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)


def execution_admission(
    activities: Activities, domain: ActivityDomain
) -> Callable[[], AsyncIterator[None]]:
    """Admit a public root in the event-loop context, independently of HTTP ancestry."""

    async def admit() -> AsyncIterator[None]:
        try:
            lease = activities.enter(domain, root=True)
        except MaintenanceActive as error:
            raise HTTPException(503, "update_maintenance", headers={"Retry-After": "1"}) from error
        with lease:
            yield

    return admit
