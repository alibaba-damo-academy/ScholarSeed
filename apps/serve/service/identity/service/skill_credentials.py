"""会话业务凭据 —— 替登录用户备一把书深 API Key, 注入 Codex 会话进程。

自定义 Codex App Server 和进程内 skill 都需要登录用户的 API Key。让用户自己去账号设置
页建一把再 export 到 shell 是不可用的产品: 桌面端根本没有那个 shell。所以 serve 在开
会话时替他建好, 经 `SurfaceSessionOpenRequest.process_environment` 落到子进程的
SCHOLARSEED_API_KEY；ScholarSeed 再通过通用 launch-argument 协议把它交给自定义 App Server。

**这是对 proposal 36「serve 不代理账号服务 wire」的一次有界让步**: 同包的 account.py
只消费信任面 (JWKS + 吊销增量, 纯读), 本模块则代用户调 `/api/account/api-keys` 这个写
接口。让步收在三条边界上:

- 用户 JWT 从已验证的进程内身份持有者取得，不另存凭据副本、不写项目状态;
- 任何失败 (未配地址 / 未登录 / 上游不可达 / 配额满) 一律降级成「不注入」, 绝不阻塞开
  会话 —— skill 侧自己判 env 缺失并降级;
- 明文 key 只活在本进程内存里。

托管凭据由 account 加密保管并按用户全局槽位复用。serve 只在内存持有明文，
每次开会话用一次 POST 取回权威凭据；设置页 ensure 可复用缓存。用户自建 key
仍不可取回。托管 key 不占用户配额，只能轮换、不能吊销。
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Callable, Dict, Mapping, Optional

import httpx
from starlette.status import HTTP_200_OK

from service.identity.service.account import ACCOUNT_BASE_URL_ENV
from service.identity.service.account_token import looks_like_jwt
from service.platform.activity import Activities, ActivityDomain

logger = logging.getLogger(__name__)

# 注入给会话进程的变量名。一旦发布不可改名 —— 自定义 App Server 与 skill 都按它取值。
SKILL_API_KEY_ENV = "SCHOLARSEED_API_KEY"

# 终端用户 access token（网关计量归属用，proposal 42）。与 SKILL_API_KEY_ENV 并列而非取代：
# `ssk-` 是「机器长期集成」凭据、**不绑登录态**（revoke_all_for_user 只动 user_sessions +
# revocations，api_keys 压根不进吊销表），拿它表达「这次调用属于哪个登录中的人」等于
# 「用户登出后那台机器继续烧钱且继续记在他名下」。
ACCOUNT_TOKEN_ENV = "SCHOLARSEED_ACCOUNT_TOKEN"
PLATFORM_ENVIRONMENT_KEYS = (SKILL_API_KEY_ENV, ACCOUNT_TOKEN_ENV)

# 账号服务的槽位端点（与 account/auth/routes.py 同步）。get-or-issue（proposal 68）:
# 本槽已有活跃行就直接返回既有明文, 所以冷启动不再产生轮换, 也不需要「先列表再逐个
# 吊销」的清扫。
SLOT_KEY_PATH = "/api/account/api-keys/session"

# 槽位标识: 每用户一把（proposal 68）。明文可取回让一把 key 能被所有设备共享, 于是槽位
# 不再需要按存储根细分 —— 那个粒度是「明文取不回」逼出来的（每个 serve 进程冷启动都得
# 自己重签一把）, 不是多设备隔离的需要。它只进 slot 字段, **不进展示名**。
GLOBAL_SLOT = "scholarseed"

# 这把 key 在账号设置页可见, 用户能看到全部活跃凭据（proposal 41 的防后门要求）。
# 所以名字要自解释: 让他一眼看出这是产品替他备的、给技能用的, 而不是一把来源不明的 key。
# 不缀主机名 —— 一把 key 服务所有设备, 缀某台机器的主机名是错的（早期按存储根分槽时它
# 是「哪行是哪台」的答案, 现在没有这个问题了）。名字远短于账号服务的上限
# (account/config.py 的 API_KEY_NAME_MAX), 超长会被回 400 invalid_api_key_name, 而签发
# 失败一律降级成不注入 —— 那会表现成「技能莫名取不到凭据」, 极难归因。
KEY_NAME = "书深技能凭据"

# 开会话时向账号服务取回权威凭据，限制用户等待时间。
HTTP_TIMEOUT_S = 5.0

METHOD_POST = "POST"


class CredentialAdmissionError(RuntimeError):
    """No task may use a runtime whose authorization could not be aligned."""

    code = "runtime_credential_alignment_failed"


class SkillCredentialService:
    """按登录用户备一把 API Key, 投影成会话进程的环境变量。

    HTTP 取数是同步的 (与 account.py 的信任面同形), 但本模块的调用点是 async 路由, 所以
    出网整段经 asyncio.to_thread 挪出事件循环。进程内串行更新缓存，跨进程的
    复用与签发原子性由 account 的存储事务保证。
    """

    def __init__(
        self,
        base_url: str,
        *,
        activities: Activities,
        client: Optional[httpx.Client] = None,
        environ: Optional[Mapping[str, str]] = None,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._activities = activities
        self._client = client if client is not None else httpx.Client(timeout=HTTP_TIMEOUT_S)
        self._environ = os.environ if environ is None else environ
        self._lock = asyncio.Lock()
        self._tokens: Dict[str, str] = {}
        self._identity: Callable[[str], Mapping[str, Any] | None] = lambda _token: None
        self._current: Callable[[str], str] = lambda _owner: ""
        self._revision = 0

    def bind_identity(
        self,
        identity: Callable[[str], Mapping[str, Any] | None],
        current: Callable[[str], str],
    ) -> None:
        """Bind the existing verified identity service, never renderer login flags."""
        self._identity = identity
        self._current = current

    @property
    def revision(self) -> int:
        """Non-secret authorization revision for in-flight issuance invalidation."""
        return self._revision

    def forget(self, user_id: str) -> None:
        self._revision += 1
        self._tokens.pop(user_id, None)

    def forget_if_current(self, user_id: str, expected_credential: str) -> bool:
        if not expected_credential or self._current(user_id) != expected_credential:
            return False
        self.forget(user_id)
        return True

    def _authorized(self, user_id: str, credential: str) -> bool:
        who = self._identity(credential) if credential else None
        return bool(who and who.get("user_id") == user_id and self._current(user_id) == credential)

    def authenticated(self, user_id: str) -> bool:
        return self._authorized(user_id, self._current(user_id))

    def clear_credentials(self) -> None:
        """身份模式切换时清缓存，并使正在签发的旧授权失效。"""

        self._tokens.clear()
        self._revision += 1

    def configured(self) -> bool:
        """未配账号服务地址即整条腿不参与 (与 AccountTrust 同一判据)。"""

        return bool(self._base_url)

    async def admission_environment(self, user_id: str) -> Dict[str, str]:
        """Resolve at execution, including queued and resumed work, not at enqueue."""
        return await self.ensure(user_id, self._current(user_id))

    async def environment(self, user_id: str, credential: str) -> Dict[str, str]:
        """Own issuance through cache reconciliation, even if the caller leaves."""
        with self._activities.enter(ActivityDomain.CREDENTIAL):
            return await self._activities.finish(
                ActivityDomain.CREDENTIAL, lambda: self._environment(user_id, credential)
            )

    async def _environment(self, user_id: str, credential: str) -> Dict[str, str]:
        """返回该用户会话进程要额外带上的环境变量, 拿不到就返回空 dict。

        计量归属那一项（ACCOUNT_TOKEN_ENV）与 `ssk-` 签发**解耦**：它只是把本请求已经持有的
        凭据透下去，不需要出网。耗在一起会让「账号服务拖一下」连带丢掉归属，而两件事没有
        必然联系。
        """

        if not self._authorized(user_id, credential):
            self.forget_if_current(user_id, credential)
            return {}
        revision = self._revision
        env = self._account_environment(user_id, credential)
        # 仅已验证身份可以显式采用外部 key；访客不能借父进程环境绕过身份检查。
        inherited = str(self._environ.get(SKILL_API_KEY_ENV, "") or "").strip()
        if inherited:
            return {**env, SKILL_API_KEY_ENV: inherited}
        if not self._base_url or not user_id or not credential:
            return env
        async with self._lock:
            token = await self._activities.to_thread(
                ActivityDomain.CREDENTIAL, self._issue_slot, credential
            )
            if revision != self._revision or not self._authorized(user_id, credential):
                return {}
            if not token:
                self._tokens.pop(user_id, None)
                return env
            self._tokens[user_id] = token
        return {**env, SKILL_API_KEY_ENV: token}

    def _account_environment(self, user_id: str, credential: str) -> Dict[str, str]:
        """将当前已验证 JWT 投影为环境；不保留第二份身份快照。

        只收 JWT 形状的凭据：本地口令线签发的是 serve 自己的不透明 token，网关拿它
        验不出 `sub`，透下去只会把每次调用记成 unverifiable、反而污染归因。
        """

        owner = str(user_id or "").strip()
        token = str(credential or "").strip()
        return {ACCOUNT_TOKEN_ENV: token} if owner and looks_like_jwt(token) else {}

    def cached_environment(self, user_id: str) -> Dict[str, str]:
        """验证当前身份后投影缓存，不调用技能凭据签发接口。"""

        credential = self._current(user_id)
        if not self._authorized(user_id, credential):
            self.forget_if_current(user_id, credential)
            return {}
        token = str(self._environ.get(SKILL_API_KEY_ENV, "") or "").strip() or self._tokens.get(
            user_id, ""
        )
        account = credential if looks_like_jwt(credential) else ""
        env: Dict[str, str] = {}
        if token:
            env[SKILL_API_KEY_ENV] = token
        # 使用当前有效身份；续期后的环境变化在下次准入边界恢复原绑定。
        if account and ACCOUNT_TOKEN_ENV not in env:
            env[ACCOUNT_TOKEN_ENV] = account
        return env

    async def ensure(self, user_id: str, credential: str) -> Dict[str, str]:
        """已登录时补齐缺失的技能 key，已有 key 不轮换；身份 token 始终取当前值。

        用于设置页和实际任务准入。仅有账号 token 不代表技能 key 已经签发；签发失败
        保留有效账号身份但不注入技能 key，不阻塞用户自配模型。
        """

        if not self._authorized(user_id, credential):
            self.forget_if_current(user_id, credential)
            return {}
        cached = self.cached_environment(user_id)
        if cached.get(SKILL_API_KEY_ENV):
            return cached
        return await self.environment(user_id, credential)

    async def refresh(self, user_id: str, credential: str) -> Dict[str, str]:
        """Do not release the issuance lock before the real operation finishes."""
        with self._activities.enter(ActivityDomain.CREDENTIAL):
            return await self._activities.finish(
                ActivityDomain.CREDENTIAL, lambda: self._refresh(user_id, credential)
            )

    async def _refresh(self, user_id: str, credential: str) -> Dict[str, str]:
        """跳过缓存取回权威凭据 (用户轮换后由客户端通知触发)。

        **跳过缓存校验**: 轮换后缓存里那把已经死了, 再去验一次只是白跑一趟。这一步是
        「点完轮换即时生效」的前提 —— 不刷新的话, 缓存与会话 env 仍然相等 (都是那把死的),
        turn 前的比较就发现不了差异, 当前会话会一直带着死凭据。
        """

        if not self._authorized(user_id, credential):
            self.forget_if_current(user_id, credential)
            return {}
        revision = self._revision
        env = self._account_environment(user_id, credential)
        inherited = str(self._environ.get(SKILL_API_KEY_ENV, "") or "").strip()
        if inherited:
            return {**env, SKILL_API_KEY_ENV: inherited}
        if not self._base_url:
            return env
        async with self._lock:
            token = await self._activities.to_thread(
                ActivityDomain.CREDENTIAL, self._issue_slot, credential
            )
            if revision != self._revision or not self._authorized(user_id, credential):
                return {}
            if not token:
                self._tokens.pop(user_id, None)
                return env
            self._tokens[user_id] = token
        return {**env, SKILL_API_KEY_ENV: token}

    # ── 签发 (在线程池里跑) ──

    def _issue_slot(self, credential: str) -> str:
        """向账号服务要本槽那把 key：已有活跃行就取回既有明文，没有才签发。

        get-or-issue（proposal 68）让这次调用幂等：冷启动不再吊销别的设备正在用的那把，
        而用户在别处点了轮换时，这里返回的就是新的那把 —— 与缓存不等即更新。所以不需要
        再额外打一次机器面去校验缓存里那把是否还活着。
        """

        status, payload = self._send(
            METHOD_POST,
            SLOT_KEY_PATH,
            {"Authorization": f"Bearer {credential}"},
            {"slot": GLOBAL_SLOT, "name": KEY_NAME},
        )
        if status != HTTP_200_OK:
            logger.warning(
                "skill api key not issued: HTTP %s code=%s",
                status,
                payload.get("code") or "",
            )
            return ""
        token = str(payload.get("token") or "").strip()
        if not token:
            logger.warning("skill api key response carried no token")
        return token

    # ── HTTP ──

    def _send(
        self,
        method: str,
        path: str,
        headers: Dict[str, str],
        json_body: Optional[Dict[str, Any]] = None,
    ) -> tuple[int, Dict[str, Any]]:
        """出网一次并归一化成 (status, dict)。不可达回 (0, {}) —— 调用方一律降级。"""

        try:
            response = self._client.request(
                method,
                self._base_url + path,
                headers=headers,
                json=json_body,
            )
        except httpx.HTTPError as exc:
            logger.warning("skill credential %s %s unreachable: %s", method, path, exc)
            return 0, {}
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        return response.status_code, payload if isinstance(payload, dict) else {}


def skill_credentials_from_env(
    env: Optional[Mapping[str, str]] = None,
    *,
    activities: Activities,
) -> SkillCredentialService:
    """按环境变量装配 (未配账号服务地址时 configured() 为 False, 整条腿静默不参与)。"""

    source = os.environ if env is None else env
    return SkillCredentialService(
        source.get(ACCOUNT_BASE_URL_ENV, ""),
        activities=activities,
        environ=source,
    )


__all__ = [
    "ACCOUNT_TOKEN_ENV",
    "GLOBAL_SLOT",
    "KEY_NAME",
    "SKILL_API_KEY_ENV",
    "SLOT_KEY_PATH",
    "SkillCredentialService",
    "skill_credentials_from_env",
]
