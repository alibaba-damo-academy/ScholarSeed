"""Pluggable login-method providers for the identity host.

Each provider owns one authentication method end to end: its credential
verification, its login routes under ``/api/auth/``, and its projection into
``/api/auth/status``. Providers never issue or verify bearer tokens directly;
token lifecycle stays with the host and reaches providers only through
``IdentityContext``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Protocol

from fastapi import FastAPI

from service.identity.persistence.tokens import TokenRepository
from service.identity.persistence.users import UserRepository


@dataclass(frozen=True)
class IdentityContext:
    """Host-owned dependencies injected into every auth provider."""

    users: UserRepository
    tokens: TokenRepository


class AuthProvider(Protocol):
    """One login method contributed to the identity host."""

    #: Public login-method identifier projected by /api/auth/status.
    name: str

    def enabled(self) -> bool:
        """该方式当前是否处于可用配置 (参与 mode 决议, 不影响路由挂载)。"""

    def register_routes(self, app: FastAPI, ctx: IdentityContext) -> None:
        """挂载本方式的登录端点; 路径必须落在 /api/auth/ 前缀下。"""

    def status_projection(self, ctx: IdentityContext) -> Dict[str, Any]:
        """并入 /api/auth/status 的本方式专属字段 (可为空 dict)。"""


__all__ = ["AuthProvider", "IdentityContext"]
