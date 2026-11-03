"""托管账号服务的信任面消费者 —— JWKS 离线验签 + 吊销增量缓存。

serve 不代理账号服务的 wire（发码/登录/注册由客户端直连账号服务，见 proposal 36
「手机号线不复用 provider 接缝」）。本模块只回答一个问题：拿到一个账号服务签发的
JWT，它此刻是否仍然有效。

- 验签公钥来自账号服务的 JWKS 面，按 kid 缓存；kid 未命中即刷新一次（支持密钥轮转），
  带最小刷新间隔，避免伪造 kid 打爆上游。
- 吊销（远程登出/停用/改号/重置）走吊销增量面，按 REVOCATION_REFRESH_S 拉取。

两条腿的失败语义刻意不同：
- **拿不到公钥 = 拒**。验签失败时放行等于把鉴权判给网络故障。
- **拉不到吊销增量 = 沿用缓存**。账号服务抖一下不该把所有在线用户踢下线；代价是吊销
  最多晚 REVOCATION_REFRESH_S 生效，这是 proposal 36 明确接受的取舍（不做每请求
  introspect）。已缓存公钥后账号服务离线，验签仍然可用。
"""

from __future__ import annotations

import errno as errno_module
import itertools
import logging
import os
import threading
import time
from typing import Any, Callable, Dict, Optional

import httpx
import jwt
from starlette.status import HTTP_200_OK

from service.platform.activity import Activities, ActivityDomain, MaintenanceActive

logger = logging.getLogger(__name__)

# ── 环境变量键（账号服务地址是 serve 侧唯一需要配的一项）──
ACCOUNT_BASE_URL_ENV = "SCHOLARSEED_ACCOUNT_BASE_URL"
# 期望的签发者。留空则不校验 iss —— 公钥本来就是从 $SCHOLARSEED_ACCOUNT_BASE_URL 的 JWKS
# 面取的，签名已经把令牌绑定到那个服务；配上它是多一道纵深防御（同名于账号服务侧的
# 同一个变量，一套部署配一次）。
ACCOUNT_ISSUER_ENV = "SCHOLARSEED_ACCOUNT_ISS"

# ── 账号服务信任面（与 account/config.py 的 JWKS_PATH / REVOCATIONS_PATH 同步）──
JWKS_PATH = "/.well-known/jwks.json"
REVOCATIONS_PATH = "/api/revocations"

# ── 令牌校验（与 account/config.py 的 JWT_ALGORITHM / TOKEN_TYPE_USER 同步）──
# 跨 distribution 不 import 账号服务的常量：账号服务可以部署在根本没装 veda 的主机上，
# contract_package_boundary 也禁止这条依赖边。改动时两处必须同步。
JWT_ALGORITHM = "RS256"
TOKEN_TYPE_USER = "user"
REQUIRED_CLAIMS = ("exp", "sub", "jti", "typ")
DECODE_LEEWAY_S = 30
AUTH_SOURCE = "account"

# ── /api/auth/status 的 wire 值 ──
# mode 一旦发布不可改名：Electron 主进程与 renderer 都按 mode 分流登录形态
# Hosted login is owned by the account service and Desktop handoff.
ACCOUNT_MODE = "account"
METHOD_CODE = "code"
METHOD_PASSWORD = "password"
ACCOUNT_METHODS = (METHOD_CODE, METHOD_PASSWORD)

# ── 缓存节律 ──
REVOCATION_REFRESH_S = 60.0
# 吊销面是 `revoked_at > since` 严格大于：直接拿 max(revoked_at) 当下次游标会漏掉
# 同一时刻落库的其他行，故回退一个重叠窗口，靠 jti 集合去重。
REVOCATION_OVERLAP_S = 1.0
JWKS_MIN_REFRESH_S = 10.0
HTTP_TIMEOUT_S = 2.0
EXCEPTION_CHAIN_LIMIT = 8
# 后台刷新线程名。daemon：serve 是每用户一个本地进程，退出时不该被这条腿拖住。
REVOCATION_REFRESH_THREAD = "account-revocations"


def _exception_diagnostics(exc: BaseException) -> Dict[str, Any]:
    """Return bounded, credential-free transport diagnostics for one failure."""

    chain: list[str] = []
    current: Optional[BaseException] = exc
    root: BaseException = exc
    while current is not None and len(chain) < EXCEPTION_CHAIN_LIMIT:
        root = current
        chain.append(type(current).__name__)
        current = current.__cause__ or current.__context__
    error_number = root.errno if isinstance(root, OSError) else None
    return {
        "failure_type": type(exc).__name__,
        "cause_chain": ">".join(chain),
        "root_type": type(root).__name__,
        "errno": error_number,
        "errno_name": (
            errno_module.errorcode.get(error_number, "") if error_number is not None else ""
        ),
        "errno_text": os.strerror(error_number) if error_number is not None else "",
    }


class AccountTrust:
    """校验托管账号服务签发的终端用户令牌。

    HTTP 取数是同步的：调用点在 auth middleware（async）与 /api/auth/me（sync）两侧，
    改异步要把 AuthService.identity 整条链染色。因此吊销面的稳态刷新走后台单飞线程
    （见 `_revoked`），请求路径只读内存集合、永不出网；仍然同步阻塞的只剩两处 ——
    冷启动首拉（无旧缓存可用，等这一次才不至于拿空集合放行已吊销令牌）与 JWKS 的
    kid 未命中（密钥轮转，罕见）。这两处由调用方挪出事件循环（`run_in_threadpool`），
    超时压到 HTTP_TIMEOUT_S 以框住最坏阻塞。缓存由线程池并发触达，故一把锁护住读写，
    而 HTTP 一律在锁外做：持锁出网会让读缓存的请求排在 2s 超时后面，等于没挪。
    """

    def __init__(
        self,
        base_url: str,
        *,
        activities: Activities,
        issuer: str = "",
        client: Optional[httpx.Client] = None,
        clock: Callable[[], float] = time.monotonic,
        spawn: Optional[Callable[[Callable[[], None]], None]] = None,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._activities = activities
        self._issuer = issuer.strip()
        self._client = client if client is not None else httpx.Client(timeout=HTTP_TIMEOUT_S)
        # 单调时钟可注入（契约测按刷新节律推时间，不靠 sleep）；默认 monotonic：系统
        # 改时间不应让吊销缓存冻住或狂刷。
        self._clock = clock
        # 后台执行器同理可注入：契约测据此确定性地跑完一次刷新，而不是 sleep 等线程。
        self._spawn = spawn if spawn is not None else self._spawn_thread
        self._lock = threading.Lock()
        self._keys: Dict[str, Any] = {}
        self._keys_fetched_at: Optional[float] = None
        # jti → 原 token 的 exp（None = account 未回 expires_at，版本偏斜时永不淘汰：
        # 宁可多留，也不能猜一个 exp 把仍可能验签通过的令牌提前踢掉）。
        self._revoked_jtis: Dict[str, Optional[float]] = {}
        self._revoked_since: Optional[float] = None
        self._revocations_fetched_at: Optional[float] = None
        # 是否成功拉到过吊销面。False 时不得用空集合判定（等于放行已吊销令牌），
        # 只能同步等首拉 —— 这条与下面的 stale 节流共同决定 `_revoked` 的分支。
        self._revocations_loaded = False
        # 后台刷新单飞：并发请求只允许一个在途，否则每个请求起一条线程。
        self._revocations_inflight = False
        # 出网计数现在会被后台线程与请求线程并发递增，用 count 保证取号原子。
        self._request_sequence = itertools.count(1)

    @staticmethod
    def _spawn_thread(target: Callable[[], None]) -> None:
        threading.Thread(target=target, name=REVOCATION_REFRESH_THREAD, daemon=True).start()

    @property
    def base_url(self) -> str:
        return self._base_url

    def configured(self) -> bool:
        """未配地址即整条腿不参与决议（不是"默认信任本机 8780"）。"""

        return bool(self._base_url)

    def status_projection(self) -> Dict[str, Any]:
        """并入 /api/auth/status 的账号线字段：客户端据此知道往哪发登录请求。"""

        return {"account_base_url": self._base_url, "methods": list(ACCOUNT_METHODS)}

    def identity(self, credential: str) -> Optional[Dict[str, Any]]:
        """验签 + typ + 吊销三关全过才返回身份，否则 None（调用方给 401）。

        每个拒绝分支都记一条只含原因码的诊断日志：这条链是「已登录但内置模型被置灰」
        的唯一现场，历史上失败原因完全不可观测，只能靠猜。日志不得带凭据、jti 或身份。
        """

        if not credential or not self._base_url:
            logger.info("account_identity_rejected reason=no_credential")
            return None
        try:
            header = jwt.get_unverified_header(credential)
        except jwt.PyJWTError:
            logger.info("account_identity_rejected reason=malformed_header")
            return None
        key = self._signing_key(str(header.get("kid") or ""))
        if key is None:
            logger.info("account_identity_rejected reason=unknown_kid")
            return None
        try:
            claims = jwt.decode(
                credential,
                key,
                algorithms=[JWT_ALGORITHM],
                leeway=DECODE_LEEWAY_S,
                options={"require": list(REQUIRED_CLAIMS)},
                # issuer=None 时 PyJWT 不校验 iss；配了才作为纵深防御多校验一道。
                issuer=self._issuer or None,
            )
        except jwt.PyJWTError as error:
            logger.info("account_identity_rejected reason=decode detail=%s", type(error).__name__)
            return None
        # 管理员令牌与终端用户令牌同密钥签发，只靠 typ 隔离：漏检这一行就等于管理后台
        # 令牌能直接进产品，反之亦然（账号服务侧同样双向校验）。
        if claims.get("typ") != TOKEN_TYPE_USER:
            logger.info("account_identity_rejected reason=token_type")
            return None
        if self._revoked(str(claims.get("jti") or "")):
            logger.info("account_identity_rejected reason=revoked")
            return None
        return {
            "user_id": str(claims.get("sub") or ""),
            "email": "",
            "nickname": str(claims.get("nickname") or ""),
            "auth_source": AUTH_SOURCE,
        }

    # ── 验签公钥 ──

    def _signing_key(self, kid: str) -> Optional[Any]:
        if not kid:
            return None
        with self._lock:
            key = self._keys.get(kid)
            if key is not None:
                return key
            self._refresh_keys_locked()
            return self._keys.get(kid)

    def _refresh_keys_locked(self) -> None:
        now = self._clock()
        fetched_at = self._keys_fetched_at
        if fetched_at is not None and now - fetched_at < JWKS_MIN_REFRESH_S:
            return
        payload = self._get(JWKS_PATH)
        # 刷新尝试即计时（含失败）：否则上游不可用时每个请求都要等一次超时。
        self._keys_fetched_at = now
        if payload is None:
            return
        keys: Dict[str, Any] = {}
        for entry in payload.get("keys") or []:
            if not isinstance(entry, dict):
                continue
            kid = str(entry.get("kid") or "")
            if not kid:
                continue
            try:
                keys[kid] = jwt.PyJWK(entry).key
            except (jwt.PyJWTError, KeyError, ValueError, TypeError) as exc:
                logger.warning("account jwks entry unusable kid=%s: %s", kid, exc)
        if keys:
            self._keys = keys

    # ── 吊销增量 ──

    def _revoked(self, jti: str) -> bool:
        """判定 jti 是否已吊销。稳态下只读内存集合，刷新交后台单飞。

        取舍要记账：后台刷新意味着「触发刷新的那一个请求」仍按旧集合判定，吊销生效
        延迟由 REVOCATION_REFRESH_S 变成 REVOCATION_REFRESH_S + 一个请求间隔。换来的是
        请求路径不再被最多 HTTP_TIMEOUT_S 的同步出网卡住 —— 那不只慢这一个请求，
        middleware 是 async 的，它会连带冻住整个事件循环上的并发请求。
        """
        # 无 jti 无法判断吊销状态。required claims 已经拦掉这种令牌，这里是兜底。
        if not jti:
            return True
        stale_refresh = False
        with self._lock:
            if not self._revocations_stale_locked():
                return jti in self._revoked_jtis
            if not self._revocations_loaded:
                # 从未成功拉到过：拿空集合判定等于放行已吊销令牌，只能同步等这一次。
                # 仍受上面的 stale 节流约束（失败也计时），上游持续不可用时不会退化成
                # 每请求都等一次超时。
                self._fetch_revocations_locked()
                return jti in self._revoked_jtis
            if not self._revocations_inflight:
                self._revocations_inflight = True
                stale_refresh = True
            revoked = jti in self._revoked_jtis
        if stale_refresh:
            self._start_refresh()
        return revoked

    def _start_refresh(self) -> None:
        try:
            lease = self._activities.enter(ActivityDomain.CREDENTIAL, root=True)
        except MaintenanceActive:
            with self._lock:
                self._revocations_inflight = False
            return

        def refresh() -> None:
            with lease:
                self._refresh_revocations()

        try:
            self._spawn(refresh)
        except BaseException:
            lease.close()
            with self._lock:
                self._revocations_inflight = False
            raise

    def _revocations_stale_locked(self) -> bool:
        fetched_at = self._revocations_fetched_at
        if fetched_at is None:
            return True
        return self._clock() - fetched_at >= REVOCATION_REFRESH_S

    def _revocation_params_locked(self) -> Dict[str, Any]:
        return {} if self._revoked_since is None else {"since": self._revoked_since}

    def _fetch_revocations_locked(self) -> None:
        """持锁同步拉一次。只有冷启动首拉走这里 —— 锁内出网是因为此刻没有旧缓存可读。"""

        payload = self._get(REVOCATIONS_PATH, self._revocation_params_locked())
        # 刷新尝试即计时（含失败）：否则上游不可用时每个请求都要等一次超时。
        self._revocations_fetched_at = self._clock()
        if payload is None:
            return
        self._merge_revocations_locked(payload)

    def _refresh_revocations(self) -> None:
        """后台刷新体。HTTP 必须在锁外：持锁出网会让读缓存的请求排在超时后面。"""

        try:
            with self._lock:
                params = self._revocation_params_locked()
            payload = self._get(REVOCATIONS_PATH, params)
            now = self._clock()
            with self._lock:
                # 拉不到就沿用缓存（account 抖一下不该让全员归属状态翻转）；代价是吊销
                # 最多晚 REVOCATION_REFRESH_S 生效。
                self._revocations_fetched_at = now
                if payload is not None:
                    self._merge_revocations_locked(payload)
        finally:
            with self._lock:
                self._revocations_inflight = False

    def _merge_revocations_locked(self, payload: Dict[str, Any]) -> None:
        latest: Optional[float] = None
        for entry in payload.get("revocations") or []:
            if not isinstance(entry, dict):
                continue
            jti = str(entry.get("jti") or "")
            if jti:
                expires_at = entry.get("expires_at")
                self._revoked_jtis[jti] = (
                    float(expires_at) if isinstance(expires_at, (int, float)) else None
                )
            revoked_at = entry.get("revoked_at")
            if isinstance(revoked_at, (int, float)):
                latest = float(revoked_at) if latest is None else max(latest, float(revoked_at))
        if latest is not None:
            self._revoked_since = latest - REVOCATION_OVERLAP_S
        self._prune_expired_locked()
        # 空列表也是成功的一拉（当前无人被吊销），故无条件置位。
        self._revocations_loaded = True

    def _prune_expired_locked(self) -> None:
        """淘汰原 token 已过 exp 的 jti：它们再也不可能通过验签，留着只是常驻内存。

        必须留出 DECODE_LEEWAY_S 余量 —— PyJWT 的 leeway 让 exp 过了 30s 以内的令牌
        **仍然验签通过**（见 identity 里的 jwt.decode）。若按 `now > expires_at` 就淘汰，
        那 30s 窗口里已吊销的令牌会被放行，淘汰本身就变成了漏洞。
        """

        cutoff = self._clock() - DECODE_LEEWAY_S
        expired = [
            jti
            for jti, expires_at in self._revoked_jtis.items()
            if expires_at is not None and expires_at <= cutoff
        ]
        for jti in expired:
            del self._revoked_jtis[jti]

    # ── HTTP ──

    def _get(self, path: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        # 取号走 itertools.count：请求线程与后台刷新线程都会进这里，`+= 1` 不是原子的。
        request_id = next(self._request_sequence)
        started = time.perf_counter()
        try:
            response = self._client.get(self._base_url + path, params=params)
        except httpx.HTTPError as exc:
            diagnostics = _exception_diagnostics(exc)
            logger.warning(
                "account_trust_request_failed path=%s request_id=%s phase=transport "
                "elapsed_ms=%.1f failure_type=%s cause_chain=%s root_type=%s "
                "errno=%s errno_name=%s errno_text=%s",
                path,
                request_id,
                (time.perf_counter() - started) * 1000,
                diagnostics["failure_type"],
                diagnostics["cause_chain"],
                diagnostics["root_type"],
                diagnostics["errno"],
                diagnostics["errno_name"],
                diagnostics["errno_text"],
                exc_info=logger.isEnabledFor(logging.DEBUG),
            )
            return None
        if response.status_code != HTTP_200_OK:
            logger.warning(
                "account_trust_request_failed path=%s request_id=%s phase=status "
                "elapsed_ms=%.1f status=%s",
                path,
                request_id,
                (time.perf_counter() - started) * 1000,
                response.status_code,
            )
            return None
        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(
                "account_trust_request_failed path=%s request_id=%s phase=decode "
                "elapsed_ms=%.1f failure_type=%s",
                path,
                request_id,
                (time.perf_counter() - started) * 1000,
                type(exc).__name__,
            )
            return None
        logger.info(
            "account_trust_request_ok path=%s request_id=%s elapsed_ms=%.1f",
            path,
            request_id,
            (time.perf_counter() - started) * 1000,
        )
        return payload if isinstance(payload, dict) else None


def account_trust_from_env(
    env: Optional[Dict[str, str]] = None, *, activities: Activities
) -> AccountTrust:
    """按环境变量装配（未配地址时 configured() 为 False，整条腿静默不参与）。"""

    source = os.environ if env is None else env
    return AccountTrust(
        source.get(ACCOUNT_BASE_URL_ENV, ""),
        activities=activities,
        issuer=source.get(ACCOUNT_ISSUER_ENV, ""),
    )


__all__ = [
    "ACCOUNT_BASE_URL_ENV",
    "ACCOUNT_ISSUER_ENV",
    "ACCOUNT_METHODS",
    "ACCOUNT_MODE",
    "AUTH_SOURCE",
    "AccountTrust",
    "account_trust_from_env",
]
