"""Identity host service for local credentials and hosted account trust.

Providers contribute local login methods and status projections. AccountTrust
verifies hosted credentials independently; hosted login endpoints remain owned
by the account service.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from service.identity.catalog import auth_providers
from service.identity.persistence.tokens import TokenRepository
from service.identity.persistence.users import UserRepository
from service.identity.providers.protocol import AuthProvider, IdentityContext
from service.identity.service.account import ACCOUNT_MODE, AccountTrust


class AuthService:
    """Own host-shared identity state and resolve the active login method."""

    def __init__(
        self,
        *,
        users: UserRepository | None = None,
        tokens: TokenRepository | None = None,
        providers: Tuple[AuthProvider, ...] | None = None,
        account: AccountTrust | None = None,
    ) -> None:
        self._users = users or UserRepository()
        self._tokens = tokens or TokenRepository()
        self._providers = tuple(providers) if providers is not None else auth_providers()
        self._account = account

    @property
    def users(self) -> UserRepository:
        return self._users

    @property
    def tokens(self) -> TokenRepository:
        return self._tokens

    @property
    def providers(self) -> Tuple[AuthProvider, ...]:
        return self._providers

    @property
    def account(self) -> Optional[AccountTrust]:
        return self._account

    def has_users(self) -> bool:
        return self._users.has_users()

    def logout(self, credential: str) -> bool:
        # 账号服务令牌在本地没有记录可撤: 它的失效面在账号服务的吊销表 (远程登出/停用),
        # 本地登出只清客户端 cookie。这里返回 False 而不是假装成功。
        return self._tokens.revoke(credential)

    def identity(self, credential: str) -> Dict[str, Any] | None:
        """Verify a local token, then a hosted account credential."""

        who = self._tokens.verify(credential)
        if who is not None:
            return who
        if self._account is not None and self._account.configured():
            return self._account.identity(credential)
        return None

    def provider_named(self, name: Optional[str]) -> Optional[AuthProvider]:
        for provider in self._providers:
            if provider.name == name:
                return provider
        return None

    def status(self, *, enabled: bool, explicit_mode: Optional[str]) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "enabled": enabled,
            "bootstrap": enabled and not self._users.has_users(),
        }
        if not enabled:
            payload["mode"] = "off"
            # 免鉴权模式也暴露账号服务地址：桌面端主动登录（浏览器回跳首页）据此拼
            # 登录 URL；缺了它登录层会落「当前无需登录」死通知（2026-09-09 实测）。
            if self._account is not None and self._account.configured():
                payload.update(self._account.status_projection())
            return payload
        # Hosted account mode has its own projection, outside local providers.
        if explicit_mode == ACCOUNT_MODE and self._account is not None:
            payload["mode"] = ACCOUNT_MODE
            payload["bootstrap"] = False
            payload.update(self._account.status_projection())
            return payload
        provider = self.provider_named(explicit_mode)
        if provider is None:
            provider = next((p for p in self._providers if p.enabled()), None)
        payload["mode"] = provider.name if provider is not None else "local"
        if provider is not None:
            payload.update(provider.status_projection(self._context()))
        return payload

    def _context(self) -> IdentityContext:
        return IdentityContext(users=self._users, tokens=self._tokens)


__all__ = ["AuthService"]
