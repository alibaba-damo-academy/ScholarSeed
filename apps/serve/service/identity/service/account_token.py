"""当前登录用户的 access token 持有者（**纯内存**，供出站调用动态取值）。

## 为什么需要它

用户 JWT 只活在单次请求内：鉴权 middleware 验签后就丢，`/api/serve/sessions/open` 的注释
明说了这一点。但网关调用要在**另一个请求上下文**里发出去 —— Codex 子进程打 serve 进程内
的 loopback bridge，bridge 再打网关。那条出站请求手里没有任何用户凭据。

所以要有一个进程内的持有者：鉴权 middleware 验签成功后 `remember`，bridge 出站时 `current`。

## token 现在直接站网关的鉴权位

网关数据面的 `Authorization: Bearer` 接受两种自证凭据：`dgw_` 调用方 key 或三段式用户 JWT。
后者验签即得 `sub`，**鉴权与归属一步完成** —— 早期那个单独的 `X-Deeprd-Account-Token` 头
已删除。它存在的唯一理由是鉴权位被 `dgw_` 占着，而那把 key 出厂内嵌、全体客户端共用同
一把，作为鉴权凭据不识别人、不能按用户吊销 —— 拿它鉴权、再拿真凭据记账，职责是倒置的。

## 为什么不能在开会话时快照

`CompletionBridge.register` 发生在开会话那一刻，而 access token 7 天到期。快照下来的话，
长会话后期会整批 401（网关鉴权腿必须校 exp）。所以 bridge 拿的是本模块的 `current`
回调、每次调用现取。

## 边界

- **只存内存，不落盘。** 与 `skill_credentials` 同一条纪律（那边明写「明文 key 只活在本进程
  内存里」）。落盘的用户 JWT 是一个不该存在的凭据副本。
- 未登录 / 未配账号服务时 `current` 返回空串。出厂配置**不再内嵌** `dgw_` key
  （`seed_user_config` 落盘前剥离凭据），所以此时 bridge 手里没有任何凭据、网关直接拒掉 ——
  出厂共用一把 key 既不识别人也不能按用户吊销，宁可调不通也不给它兜底。只有自配凭据的
  开发机 / 自建网关才会在 config 里有 `api_key` 可回退。
- 只认账号服务签发的 JWT（`typ=user` 的三段式）。本地口令线签发的是 serve 自己的
  不透明 token，网关拿它验不出 `sub`，存了只会让网关直接 401。
"""

from __future__ import annotations

import logging
from enum import Enum
from hashlib import sha256
from typing import Dict

logger = logging.getLogger(__name__)

# 产品会话 id 头名（与网关的 HEADER_CHAT_ID 同步）。网关据它把用量归并到「按 Session 汇总」。
# 这个头仍然需要：它携带的是会话粒度，鉴权凭据里没有这个信息。
# （而归属头已删除 —— user_id 现在来自鉴权本身。）
CONV_MESSAGE_ID_HEADER = "X-Deeprd-Conv-Message-id"

# 产品轮 id 头名（proposal 70 §5.9）。网关据它把用量再按「一轮对话」聚合（`call_logs.turn_id`），
# 积分页的消耗详情一行 = (轮, 模型)。与上面的会话头**并存不替换**：admin「按 Session 汇总」读的
# 是 `chat_id` 维，用轮 id 覆盖它等于把会话粒度打散。缺省空串 = 这一轮不归并（同会话头语义）。
CONV_TURN_ID_HEADER = "X-Deeprd-Conv-Turn-id"

# JWT 的三段式形状。用它挡掉本地 token：那种 token 网关验不出 sub，存了只会把每次调用
# 记成 unverifiable，反而污染「未归属成本」的归因。
_JWT_SEGMENTS = 3


class CredentialCleanup(str, Enum):
    MATCHED = "matched"
    ABSENT = "absent"
    STALE = "stale"


def looks_like_jwt(credential: str) -> bool:
    """粗判是否是 JWS 紧凑序列化（三段、段间非空）。不验签、不解析。"""
    parts = str(credential or "").split(".")
    return len(parts) == _JWT_SEGMENTS and all(parts)


class AccountTokenHolder:
    """按 user_id 记住最近一次见到的 access token（纯内存投影）。"""

    def __init__(self) -> None:
        self._tokens: Dict[str, str] = {}
        self._revoked: set[str] = set()
        self._revision = 0

    @property
    def revision(self) -> int:
        return self._revision

    def remember_if_unchanged(self, user_id: str, credential: str, expected_revision: int) -> bool:
        if expected_revision != self._revision:
            return False
        self.remember(user_id, credential)
        return self.current(user_id) == credential

    def forget_if_current(self, user_id: str, expected_credential: str) -> CredentialCleanup:
        owner = str(user_id or "").strip()
        expected = str(expected_credential or "").strip()
        if owner and looks_like_jwt(expected):
            self._revoked.add(sha256(expected.encode()).hexdigest())
        current = self._tokens.get(owner)
        if current is None:
            return CredentialCleanup.ABSENT
        if not expected or current != expected:
            return CredentialCleanup.STALE
        del self._tokens[owner]
        self._revision += 1
        return CredentialCleanup.MATCHED

    def remember(self, user_id: str, credential: str) -> None:
        """记住这次请求带来的凭据（鉴权 middleware 验签成功后调用）。

        非 JWT 形状一律忽略而不是存下来：本地 token 对网关无意义（见模块 docstring）。
        """

        owner = str(user_id or "").strip()
        token = str(credential or "").strip()
        if not owner or not token:
            return
        if not looks_like_jwt(token):
            return
        if sha256(token.encode()).hexdigest() in self._revoked:
            return
        if self._tokens.get(owner) != token:
            self._tokens[owner] = token
            self._revision += 1

    def current(self, user_id: str) -> str:
        """当前已知的 access token；未登录 / 无记录返回空串。"""

        return self._tokens.get(str(user_id or "").strip(), "")

    def forget(self, user_id: str) -> None:
        """登出时清掉（本地不再持有该用户凭据）。"""

        token = self._tokens.pop(str(user_id or "").strip(), None)
        logger.info("account_token_forgotten token_present=%s", bool(token))
        if token:
            self._revoked.add(sha256(token.encode()).hexdigest())
            self._revision += 1

    def clear_all(self) -> None:
        """运行期切到免鉴权模式时全量失效（proposal 18：切换不迁移凭据）。"""

        logger.info("account_tokens_cleared entry_count=%d", len(self._tokens))
        self._tokens.clear()
        self._revision += 1


__all__ = [
    "CONV_MESSAGE_ID_HEADER",
    "CONV_TURN_ID_HEADER",
    "AccountTokenHolder",
    "looks_like_jwt",
]
