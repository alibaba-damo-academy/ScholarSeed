"""一次性删除令牌 (content 域, 开发 1 拥有)。

proposal 47 §6.6: 删除要走系统废纸篓 (可恢复), 执行者只能是 Electron 主进程,
但绝对路径不该经过渲染层。因此 content 只发一个短时效、单路径、用后即焚的
令牌; 渲染层拿着令牌请主进程去兑换。

令牌只在进程内存里: 它的生命周期是「用户点删除 → 主进程执行废纸篓」之间的
几秒钟。落盘反而会让重启后仍有可兑换的旧令牌 —— 那是把一次性凭据变成长期
凭据。serve 重启后前端重新发起删除即可。
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass

from service.content.domain.model import ContentError

#: 令牌有效期 (秒)。够一次用户确认与一次 IPC 往返, 不够拿去做别的。
TOKEN_TTL_SECONDS = 120.0

#: 令牌熵。128 bit, 本机 loopback 场景下足够。
TOKEN_BYTES = 16


@dataclass(frozen=True)
class TrashGrant:
    project_id: str
    absolute: str
    expires_at: float


class TrashTokenVault:
    """签发与兑换一次性删除令牌。"""

    def __init__(self, ttl: float = TOKEN_TTL_SECONDS) -> None:
        self._ttl = ttl
        self._grants: dict[str, TrashGrant] = {}
        self._redeemed: dict[str, TrashGrant] = {}
        self._completed: dict[str, TrashGrant] = {}

    def issue(self, project_id: str, absolute: str) -> str:
        self._prune()
        token = secrets.token_urlsafe(TOKEN_BYTES)
        self._grants[token] = TrashGrant(
            project_id=project_id,
            absolute=absolute,
            expires_at=time.time() + self._ttl,
        )
        return token

    def redeem(self, token: str) -> TrashGrant:
        """Redeem exactly once while retaining a completion capability."""

        self._prune()
        grant = self._grants.pop(token, None)
        if grant is None:
            raise ContentError("invalid_trash_token")
        self._redeemed[token] = grant
        return grant

    def complete(self, token: str) -> tuple[TrashGrant, bool]:
        """Complete after OS trash succeeds; retries return the same grant."""

        self._prune()
        completed = self._completed.get(token)
        if completed is not None:
            return completed, False
        grant = self._redeemed.pop(token, None)
        if grant is None:
            raise ContentError("invalid_trash_token")
        self._completed[token] = grant
        return grant, True

    def completion_grant(self, token: str) -> TrashGrant:
        """Return the redeemed or completed grant without changing its state."""

        self._prune()
        grant = self._redeemed.get(token) or self._completed.get(token)
        if grant is None:
            raise ContentError("invalid_trash_token")
        return grant

    def _prune(self) -> None:
        now = time.time()
        for collection in (self._grants, self._redeemed, self._completed):
            for token, grant in list(collection.items()):
                if grant.expires_at <= now:
                    del collection[token]


__all__ = ["TOKEN_TTL_SECONDS", "TrashGrant", "TrashTokenVault"]
