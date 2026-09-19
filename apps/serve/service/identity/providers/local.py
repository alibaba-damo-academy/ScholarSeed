"""本地邮箱口令登录 provider (注册/登录)。"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import FastAPI, HTTPException, Request

from service.identity.providers.protocol import IdentityContext
from service.identity.schema import CredentialsRequest
from service.identity.utils import bearer_or_cookie


class LocalAuthProvider:
    """Email + password 注册与登录。认证开启时恒可用 (含 bootstrap 注册)。"""

    name = "local"

    def enabled(self) -> bool:
        return True

    def status_projection(self, ctx: IdentityContext) -> Dict[str, Any]:
        return {}

    def register(self, ctx: IdentityContext, email: str, password: str, credential: str) -> Dict:
        if ctx.users.has_users() and ctx.tokens.verify(credential) is None:
            raise PermissionError("registration requires an authenticated user")
        return ctx.users.create(email, password)

    def login(self, ctx: IdentityContext, email: str, password: str) -> Dict[str, Any] | None:
        user = ctx.users.verify_password(email, password)
        if user is None:
            return None
        return {**user, "token": ctx.tokens.issue(str(user["user_id"]))}

    def register_routes(self, app: FastAPI, ctx: IdentityContext) -> None:
        @app.post("/api/auth/register")
        def register(body: CredentialsRequest, request: Request) -> Dict[str, Any]:
            try:
                return self.register(ctx, body.email, body.password, bearer_or_cookie(request))
            except PermissionError as exc:
                raise HTTPException(401, str(exc)) from exc
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc

        @app.post("/api/auth/login")
        def login(body: CredentialsRequest) -> Dict[str, Any]:
            payload = self.login(ctx, body.email, body.password)
            if payload is None:
                raise HTTPException(401, "bad email or password")
            return payload


__all__ = ["LocalAuthProvider"]
