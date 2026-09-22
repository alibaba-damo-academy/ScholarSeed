"""托管账号服务信任面契约 — RS256 离线验签 + typ 隔离 + 吊销增量 + 双凭据 middleware。

不依赖跑着的账号服务：本地现造 RS256 密钥对签发令牌，JWKS / 吊销面用 httpx
MockTransport 顶上，账号服务不可达/返回坏数据这些分支才测得到。
跑法: .venv/bin/python -m tests.contract_account_trust
"""

# pylint: disable=wrong-import-position  # 隔离 HOME/research db 必须先于 first-party import

from __future__ import annotations

import base64
import json
import logging
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicKey
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

_HOME = Path(tempfile.mkdtemp(prefix="rp-account-trust-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

from tests._isolate import isolate_research_db  # noqa: E402

_RESEARCH_DB = isolate_research_db()

from service.bootstrap import create_app  # noqa: E402
from service.chat.api.sessions import ARTIFACT_EDITABLE_HEADER  # noqa: E402
from service.cli.serve import AUTH_MODE_CHOICES, AUTH_MODE_ENFORCED  # noqa: E402
from service.identity.api.routes import register_auth  # noqa: E402
from service.identity.persistence.tokens import TokenRepository  # noqa: E402
from service.identity.persistence.users import UserRepository  # noqa: E402
from service.identity.service.account import (  # noqa: E402
    ACCOUNT_BASE_URL_ENV,
    ACCOUNT_METHODS,
    ACCOUNT_MODE,
    DECODE_LEEWAY_S,
    JWKS_MIN_REFRESH_S,
    JWKS_PATH,
    REVOCATION_REFRESH_S,
    REVOCATIONS_PATH,
    AccountTrust,
)
from service.identity.service.account_token import AccountTokenHolder  # noqa: E402
from service.identity.service.auth import AuthService  # noqa: E402
from service.identity.utils import LOCAL_USER_ID, request_user_id  # noqa: E402

PASS, FAIL = 0, 0

ACCOUNT_BASE = "http://127.0.0.1:18780"
DEV_ORIGIN = "http://localhost:5173"
UI_ROOT = Path(__file__).resolve().parents[3] / "apps" / "desktop"
BACKEND_TS = UI_ROOT / "src" / "main" / "backend.ts"
PRODUCT_TS = UI_ROOT / "src" / "main" / "product.ts"
PRODUCT_CONFIG = UI_ROOT / "resources" / "product.json"
PACKAGE_CONFIG = UI_ROOT / "package.json"
AUTH_MODES_TS_PATTERN = r"export const AUTH_MODES = \[([^\]]*)\] as const"
ACCOUNT_LOGGER = "service.identity.service.account"


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


# ---------------------------------------------------------------------------
# 签发侧：现造密钥对 + JWK 投影（形制与 account/auth/tokens.py 一致）
# ---------------------------------------------------------------------------


def _b64uint(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return base64.urlsafe_b64encode(value.to_bytes(length, "big")).rstrip(b"=").decode("ascii")


class Signer:
    """一把 RS256 私钥 + 它的 JWK（kid 派生自公钥模数，与账号服务同规则）。"""

    def __init__(self) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.private_pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        public = key.public_key()
        assert isinstance(public, RSAPublicKey)
        numbers = public.public_numbers()
        self.kid = _b64uint(numbers.n)[:16]
        self.jwk = {
            "kty": "RSA",
            "use": "sig",
            "alg": "RS256",
            "kid": self.kid,
            "n": _b64uint(numbers.n),
            "e": _b64uint(numbers.e),
        }

    def token(
        self,
        *,
        typ: str = "user",
        sub: str = "u-account-1",
        jti: str = "",
        nickname: str = "阿卡",
        ttl: int = 3600,
        issuer: str = "veda-account",
        drop: str = "",
    ) -> str:
        issued = int(time.time())
        claims: Dict[str, Any] = {
            "sub": sub,
            "typ": typ,
            "iat": issued,
            "exp": issued + ttl,
            "iss": issuer,
            "jti": jti or uuid.uuid4().hex,
            "nickname": nickname,
        }
        if drop:
            claims.pop(drop, None)
        return jwt.encode(claims, self.private_pem, algorithm="RS256", headers={"kid": self.kid})


# ---------------------------------------------------------------------------
# 账号服务信任面 stub（JWKS + 吊销增量），可切故障与统计调用次数
# ---------------------------------------------------------------------------


class AccountStub:
    def __init__(self, signer: Signer) -> None:
        self.keys: List[Dict[str, str]] = [signer.jwk]
        self.revocations: List[Dict[str, Any]] = []
        self.jwks_status = 200
        self.revocations_status = 200
        self.jwks_calls = 0
        self.revocation_calls = 0
        self.since_seen: List[Optional[str]] = []

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == JWKS_PATH:
            self.jwks_calls += 1
            if self.jwks_status != 200:
                return httpx.Response(self.jwks_status, json={"detail": "down"})
            return httpx.Response(200, json={"keys": self.keys})
        if request.url.path == REVOCATIONS_PATH:
            self.revocation_calls += 1
            raw_since = request.url.params.get("since")
            self.since_seen.append(raw_since)
            if self.revocations_status != 200:
                return httpx.Response(self.revocations_status, json={"detail": "down"})
            since = float(raw_since) if raw_since is not None else None
            entries = [
                row for row in self.revocations if since is None or float(row["revoked_at"]) > since
            ]
            return httpx.Response(200, json={"revocations": entries, "count": len(entries)})
        return httpx.Response(404, json={"detail": "unexpected path"})


class Clock:
    """可推进的单调时钟（刷新节律靠推时间验证，不 sleep）。

    start 用来对齐真实时间：淘汰过期 jti 的判据必须与令牌 exp 同轴，否则「淘汰逻辑认为
    已过期」与「验签认为仍在 leeway 内」两个条件凑不到一起，leeway 边界根本测不到。
    """

    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class LogCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: List[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


class FailingClient:
    def get(self, *_args: Any, **_kwargs: Any) -> httpx.Response:
        try:
            raise OSError(9, "Bad file descriptor")
        except OSError as root:
            raise httpx.ConnectError("connect failed") from root


def build_trust(
    stub: AccountStub,
    clock: Optional[Clock] = None,
    *,
    issuer: str = "",
    spawn: Optional[Callable[[Callable[[], None]], None]] = None,
) -> AccountTrust:
    return AccountTrust(
        ACCOUNT_BASE,
        issuer=issuer,
        client=stub.client(),
        clock=clock or Clock(),
        spawn=spawn,
    )


def inline_spawn(target: Callable[[], None]) -> None:
    """在当前线程跑完后台刷新体：断言不必 sleep 等真线程，也就不会 flaky。"""

    target()


# ---------------------------------------------------------------------------
# 测试 1: 验签基本盘 —— 合法用户令牌通过, 身份字段完整
# ---------------------------------------------------------------------------


def test_valid_user_token() -> None:
    print("[1] 合法用户令牌验签通过并投影身份")
    signer = Signer()
    stub = AccountStub(signer)
    trust = build_trust(stub)

    who = trust.identity(signer.token(sub="u-abc", nickname="小书"))
    check("身份非空", who is not None, str(who))
    if who is not None:
        check("user_id 取 sub", who["user_id"] == "u-abc", str(who))
        check("nickname 取 claim", who["nickname"] == "小书", str(who))
        check("auth_source=account", who["auth_source"] == "account", str(who))
    check("JWKS 只拉一次", stub.jwks_calls == 1, f"calls={stub.jwks_calls}")

    # 第二个令牌复用缓存公钥, 不再出网
    check("同 kid 复用缓存", trust.identity(signer.token()) is not None)
    check("JWKS 仍只拉一次", stub.jwks_calls == 1, f"calls={stub.jwks_calls}")
    check("configured()", trust.configured() is True)


# ---------------------------------------------------------------------------
# 测试 2: typ 双向隔离 —— 管理员令牌绝不能进产品面
# ---------------------------------------------------------------------------


def test_admin_token_rejected() -> None:
    print("[2] 管理员令牌 / 缺字段 / 过期 / 换密钥签名一律拒")
    signer = Signer()
    stub = AccountStub(signer)
    trust = build_trust(stub)

    check("typ=admin 拒", trust.identity(signer.token(typ="admin")) is None)
    # 续期令牌只进账号服务自己的 /api/token/refresh，绝不能当会话令牌进产品面
    check("typ=refresh 拒", trust.identity(signer.token(typ="refresh")) is None)
    check("typ 缺失拒", trust.identity(signer.token(drop="typ")) is None)
    check("jti 缺失拒", trust.identity(signer.token(drop="jti")) is None)
    check("exp 缺失拒", trust.identity(signer.token(drop="exp")) is None)
    check("已过期拒", trust.identity(signer.token(ttl=-7200)) is None)
    check("空串拒", trust.identity("") is None)
    check("非 JWT 拒", trust.identity("not-a-token") is None)

    # 另一把私钥签的令牌: kid 不在 JWKS 里 → 拿不到公钥 → 拒
    other = Signer()
    check("陌生密钥签名拒", trust.identity(other.token()) is None)


# ---------------------------------------------------------------------------
# 测试 3: iss 校验（配了才校验；配错的签发者要拒）
# ---------------------------------------------------------------------------


def test_issuer_pin() -> None:
    print("[3] 配了期望 issuer 后, iss 不符即拒")
    signer = Signer()
    stub = AccountStub(signer)
    trust = build_trust(stub, issuer="veda-account")

    check("iss 相符通过", trust.identity(signer.token(issuer="veda-account")) is not None)
    check("iss 不符拒", trust.identity(signer.token(issuer="someone-else")) is None)

    loose = build_trust(AccountStub(signer))
    check("未配 issuer 时不校验", loose.identity(signer.token(issuer="whatever")) is not None)


# ---------------------------------------------------------------------------
# 测试 4: 密钥轮转 —— 未知 kid 触发刷新, 且刷新有最小间隔
# ---------------------------------------------------------------------------


def test_key_rotation() -> None:
    print("[4] 未知 kid 触发 JWKS 刷新, 最小间隔内不重复出网")
    first = Signer()
    stub = AccountStub(first)
    clock = Clock()
    trust = build_trust(stub, clock)
    check("轮转前正常", trust.identity(first.token()) is not None)

    rotated = Signer()
    stub.keys = [rotated.jwk]
    # 刚拉过 → 最小间隔内不再出网, 新 kid 只能先拒 (fail-closed + 防打爆上游)
    check("间隔内新 kid 拒", trust.identity(rotated.token()) is None)
    check("JWKS 未重复拉", stub.jwks_calls == 1, f"calls={stub.jwks_calls}")

    clock.advance(JWKS_MIN_REFRESH_S + 1)
    check("过间隔后刷新即通过", trust.identity(rotated.token()) is not None)
    check("JWKS 拉了第二次", stub.jwks_calls == 2, f"calls={stub.jwks_calls}")


# ---------------------------------------------------------------------------
# 测试 5: 账号服务不可达 —— 公钥拿不到必须拒, 已缓存则离线仍可验
# ---------------------------------------------------------------------------


def test_jwks_unreachable_fail_closed() -> None:
    print("[5] JWKS 不可达 fail-closed; 公钥已缓存则离线仍可验签")
    signer = Signer()
    stub = AccountStub(signer)
    stub.jwks_status = 503
    clock = Clock()
    trust = build_trust(stub, clock)
    check("JWKS 503 时拒", trust.identity(signer.token()) is None)

    # 恢复后（过最小间隔）能拿到公钥
    stub.jwks_status = 200
    clock.advance(JWKS_MIN_REFRESH_S + 1)
    check("恢复后通过", trust.identity(signer.token()) is not None)

    # 公钥进缓存后账号服务再挂: 验签不受影响（proposal 36 的"保住离线验签"）
    stub.jwks_status = 503
    clock.advance(JWKS_MIN_REFRESH_S + 1)
    check("离线仍可验签", trust.identity(signer.token()) is not None)


def test_transport_failure_logs_cause_chain_without_credentials() -> None:
    print("[5b] 传输失败日志保留异常链/errno 且不泄露凭据")
    signer = Signer()
    token = signer.token()
    trust = AccountTrust(ACCOUNT_BASE, client=FailingClient())
    capture = LogCapture()
    account_logger = logging.getLogger(ACCOUNT_LOGGER)
    account_logger.addHandler(capture)
    try:
        check("传输失败仍 fail-closed", trust.identity(token) is None)
    finally:
        account_logger.removeHandler(capture)
    joined = "\n".join(capture.messages)
    check("记录 transport 阶段", "phase=transport" in joined, joined)
    check("记录异常链", "ConnectError>OSError" in joined, joined)
    check("记录 errno", "errno=9" in joined, joined)
    check("记录 errno 名称", "errno_name=EBADF" in joined, joined)
    check("记录 errno 文案", "errno_text=Bad file descriptor" in joined, joined)
    check("不记录 access token", token not in joined)


# ---------------------------------------------------------------------------
# 测试 6: 吊销增量 —— 拉取节律 / since 游标重叠 / 上游故障沿用缓存
# ---------------------------------------------------------------------------


def test_revocations() -> None:
    print("[6] 吊销增量: 命中即拒 + 60s 节律 + since 重叠 + 故障沿用缓存")
    signer = Signer()
    stub = AccountStub(signer)
    clock = Clock()
    trust = build_trust(stub, clock, spawn=inline_spawn)

    revoked_token = signer.token(jti="jti-revoked")
    check("吊销前通过", trust.identity(revoked_token) is not None)
    check("首拉同步完成", stub.revocation_calls == 1, f"calls={stub.revocation_calls}")

    stub.revocations.append({"jti": "jti-revoked", "revoked_at": 1_700_000_000.0})
    # 节律内不出网 → 仍放行（60s 窗口是既定取舍）
    check("窗口内仍放行", trust.identity(revoked_token) is not None)
    check("吊销面未重复拉", stub.revocation_calls == 1, f"calls={stub.revocation_calls}")

    # 过窗口: 触发刷新的**这一个**请求仍按旧集合判定 —— 这是把刷新挪出请求路径的既定
    # 代价（延迟从 60s 变成 60s + 一个请求间隔），下一个请求即拒。
    clock.advance(REVOCATION_REFRESH_S + 1)
    check("触发刷新的请求按旧缓存放行", trust.identity(revoked_token) is not None)
    check("该请求已把刷新跑完", stub.revocation_calls == 2, f"calls={stub.revocation_calls}")
    check("下一个请求即拒", trust.identity(revoked_token) is None)
    check("其他令牌不受影响", trust.identity(signer.token(jti="jti-fresh")) is not None)

    # since 游标必须带重叠窗口: 否则同刻落库的其他行会被 `revoked_at > since` 漏掉
    same_moment = {"jti": "jti-same-moment", "revoked_at": 1_700_000_000.0}
    stub.revocations.append(same_moment)
    clock.advance(REVOCATION_REFRESH_S + 1)
    trust.identity(signer.token(jti="jti-warm"))  # 触发后台刷新, 把 same_moment 拉进集合
    check("同刻吊销不漏", trust.identity(signer.token(jti="jti-same-moment")) is None)
    check("since 已带游标", any(s is not None for s in stub.since_seen), str(stub.since_seen))

    # 吊销面故障 → 沿用已有缓存（不把在线用户全踢下线, 也不放行已吊销的）
    stub.revocations_status = 503
    clock.advance(REVOCATION_REFRESH_S + 1)
    trust.identity(signer.token(jti="jti-warm2"))  # 触发一次失败的后台刷新
    check("故障时已吊销仍拒", trust.identity(revoked_token) is None)
    check("故障时正常令牌仍通", trust.identity(signer.token(jti="jti-ok")) is not None)


def test_revocations_off_request_path() -> None:
    print("[6b] 刷新不在请求路径: 请求不出网 + 后台单飞 + 冷启动首拉仍同步")
    signer = Signer()
    stub = AccountStub(signer)
    clock = Clock()
    # 只记录不执行: 请求路径若仍在等刷新, 出网计数与返回顺序会立刻出卖它。
    deferred: List[Callable[[], None]] = []
    trust = build_trust(stub, clock, spawn=deferred.append)

    # 冷启动必须同步: 若排到后台, 第一个请求会拿空集合判定 → 放行已吊销令牌。
    # 这条是 `_revocations_loaded` 守卫的唯一证伪点, 出网计数证明不了它。
    stub.revocations.append({"jti": "jti-pre", "revoked_at": 1_600_000_000.0})
    check("冷启动即拒已吊销", trust.identity(signer.token(jti="jti-pre")) is None)
    check("首拉已出网", stub.revocation_calls == 1, f"calls={stub.revocation_calls}")
    check("首拉不排后台", deferred == [], f"deferred={len(deferred)}")

    # 过窗口后: 请求只读缓存并立即返回, 刷新被排到后台, 出网计数在返回时不动。
    stub.revocations.append({"jti": "jti-a", "revoked_at": 1_700_000_000.0})
    clock.advance(REVOCATION_REFRESH_S + 1)
    token = signer.token(jti="jti-a")
    check("过窗口的请求立即返回", trust.identity(token) is not None)
    check("请求路径未出网", stub.revocation_calls == 1, f"calls={stub.revocation_calls}")
    check("刷新已排入后台", len(deferred) == 1, f"deferred={len(deferred)}")

    # 单飞: 后台尚未跑完时, 后续过期请求不得再起第二个刷新。
    clock.advance(REVOCATION_REFRESH_S + 1)
    trust.identity(token)
    check("在途期间不重复起刷新", len(deferred) == 1, f"deferred={len(deferred)}")
    check("在途期间仍未出网", stub.revocation_calls == 1, f"calls={stub.revocation_calls}")

    deferred[0]()
    check("后台刷新已出网", stub.revocation_calls == 2, f"calls={stub.revocation_calls}")
    check("后台刷新后已吊销即拒", trust.identity(token) is None)

    # inflight 必须复位, 否则此后再也不刷新（吊销永久失效）。
    clock.advance(REVOCATION_REFRESH_S + 1)
    trust.identity(signer.token(jti="jti-b"))
    check("inflight 已复位可再刷新", len(deferred) == 2, f"deferred={len(deferred)}")


# ---------------------------------------------------------------------------
# 测试 7: 双凭据 middleware —— 本地 token 与账号 JWT 都能过 /api
# ---------------------------------------------------------------------------


def _local_user_id() -> str:
    """建一个真本地用户：verify_token 要求 token 的 user_id 在 auth.json 里有用户记录。"""
    users = UserRepository()
    return str(users.create("dual@example.test", "local-password")["user_id"])


def _protected_app(trust: AccountTrust) -> TestClient:
    app = FastAPI()

    @app.get("/api/probe")
    def probe() -> Dict[str, str]:
        return {"ok": "yes"}

    register_auth(app, enabled=True, service=AuthService(account=trust), mode=ACCOUNT_MODE)
    return TestClient(app)


def test_dual_credential_middleware() -> None:
    print("[7] 双凭据: 本地 token / 账号 JWT 均放行, 无凭据 401")
    signer = Signer()
    stub = AccountStub(signer)
    client = _protected_app(build_trust(stub))

    check("无凭据 401", client.get("/api/probe").status_code == 401)

    account_token = signer.token(sub="u-dual", nickname="双凭据")
    headers = {"authorization": f"Bearer {account_token}"}
    check("账号 JWT 放行", client.get("/api/probe", headers=headers).status_code == 200)
    # cookie 通道 (SSE 只能靠 cookie) 同样认账号 JWT
    client.cookies.set("scholarseed_token", account_token)
    check("cookie 通道放行", client.get("/api/probe").status_code == 200)
    client.cookies.clear()

    local_token = TokenRepository().issue(_local_user_id())
    local_headers = {"authorization": f"Bearer {local_token}"}
    check("本地 token 放行", client.get("/api/probe", headers=local_headers).status_code == 200)

    admin_headers = {"authorization": f"Bearer {signer.token(typ='admin')}"}
    check("管理员令牌 401", client.get("/api/probe", headers=admin_headers).status_code == 401)

    me = client.get("/api/auth/me", headers=headers)
    check("/me 200", me.status_code == 200, me.text)
    body = me.json()
    check("/me user_id", body.get("user_id") == "u-dual", str(body))
    check("/me nickname 投影", body.get("nickname") == "双凭据", str(body))
    check("/me auth=True", body.get("auth") is True, str(body))


# ---------------------------------------------------------------------------
# 测试 7b: 登出后进程内不再持有该账号的 access JWT
# ---------------------------------------------------------------------------


def test_logout_drops_the_in_memory_token() -> None:
    print("[7b] 登出即摘掉内存里的 access JWT")
    signer = Signer()
    holder = AccountTokenHolder()
    app = FastAPI()

    @app.get("/api/probe")
    def probe() -> Dict[str, str]:
        return {"ok": "yes"}

    register_auth(
        app,
        enabled=True,
        service=AuthService(account=build_trust(AccountStub(signer))),
        account_tokens=holder,
        mode=ACCOUNT_MODE,
    )
    client = TestClient(app)

    leaving = signer.token(sub="u-leaving")
    staying = signer.token(sub="u-staying")
    client.get("/api/probe", headers={"authorization": f"Bearer {leaving}"})
    client.get("/api/probe", headers={"authorization": f"Bearer {staying}"})
    check("鉴权后记住了凭据", holder.current("u-leaving") == leaving)

    logout = client.post("/api/auth/logout", headers={"authorization": f"Bearer {leaving}"})
    check("logout 200", logout.status_code == 200, logout.text)
    # 不摘的话这份 JWT 会一直留在进程内存里可被出站模型调用取用（forget 此前无生产调用方），
    # 而账号线的 JWT serve 侧吊销不了, 只能靠这里收口。
    check("登出账号的槽位已空", holder.current("u-leaving") == "", holder.current("u-leaving"))
    check("另一个账号不受影响", holder.current("u-staying") == staying)


# ---------------------------------------------------------------------------
# 测试 7c: 免鉴权模式下仍投影账号身份（桌面端恒 off 的网关计量归属命门）
# ---------------------------------------------------------------------------


def test_off_mode_projects_account_identity() -> None:
    print("[7c] 免鉴权模式下带账号 JWT 仍投影身份并 remember（桌面端恒 off 的网关计量归属）")
    signer = Signer()
    holder = AccountTokenHolder()
    app = FastAPI()

    @app.get("/api/probe")
    def probe(request: Request) -> Dict[str, str]:
        return {"user_id": request_user_id(request)}

    register_auth(
        app,
        enabled=False,
        service=AuthService(account=build_trust(AccountStub(signer))),
        account_tokens=holder,
    )
    client = TestClient(app)

    anon = client.get("/api/probe")
    check("未登录可用（off 不拦截）", anon.status_code == 200, anon.text)
    check("未登录回落 local", anon.json().get("user_id") == LOCAL_USER_ID, anon.text)
    check("未登录不 remember", holder.current("u-off") == "", holder.current("u-off"))

    token = signer.token(sub="u-off", nickname="离线归属")
    logged_in = client.get("/api/probe", headers={"authorization": f"Bearer {token}"})
    check("登录请求 200", logged_in.status_code == 200, logged_in.text)
    check("off 下投影真实 sub", logged_in.json().get("user_id") == "u-off", logged_in.text)
    check("off 下 remember 进 holder", holder.current("u-off") == token, holder.current("u-off"))


# ---------------------------------------------------------------------------
# 测试 8: preflight 不被鉴权拦截
# ---------------------------------------------------------------------------


def test_preflight_not_blocked() -> None:
    print("[8] 鉴权 middleware 放行 CORS 预检, 真实请求照旧拦")
    signer = Signer()
    app = FastAPI()

    @app.post("/api/probe")
    def probe() -> Dict[str, str]:
        return {"ok": "yes"}

    # 顺序与 service/bootstrap.py 的 create_app 一致：先 CORS，再鉴权（后加的在最外层）
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[DEV_ORIGIN],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_auth(app, enabled=True, service=AuthService(account=build_trust(AccountStub(signer))))
    client = TestClient(app)

    preflight = client.options(
        "/api/probe",
        headers={
            "origin": DEV_ORIGIN,
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
        },
    )
    # 预检不带凭据（规范如此）。拦下它 = 跨源 JSON POST 全部发不出去，dev 期登录必崩。
    check("预检 200", preflight.status_code == 200, f"got {preflight.status_code}")
    check(
        "预检回 allow-credentials",
        preflight.headers.get("access-control-allow-credentials") == "true",
        str(dict(preflight.headers)),
    )
    check(
        "预检回 allow-origin",
        preflight.headers.get("access-control-allow-origin") == DEV_ORIGIN,
        str(dict(preflight.headers)),
    )

    # 放行预检不等于放宽鉴权：真实请求无凭据仍 401，带账号 JWT 才过
    check("真实 POST 无凭据 401", client.post("/api/probe").status_code == 401)
    ok = client.post("/api/probe", headers={"authorization": f"Bearer {signer.token()}"})
    check("真实 POST 带凭据 200", ok.status_code == 200, ok.text)


# ---------------------------------------------------------------------------
# 测试 9: 401 必须带 CORS 头（否则跨源前端永远回不到登录页）
# ---------------------------------------------------------------------------


def test_unauthorized_is_readable_cross_origin() -> None:
    print("[9] 真 create_app 的 401 带 CORS 头, 跨源前端读得到状态码")
    cases = _HOME / "cases"
    cases.mkdir(exist_ok=True)
    app = create_app(cases_root=cases, auth=True, auth_mode=ACCOUNT_MODE)
    denied = TestClient(app).get("/api/content/projects", headers={"origin": DEV_ORIGIN})
    check("无凭据 401", denied.status_code == 401, f"got {denied.status_code}")
    # 鉴权 middleware 是直接 return 401 不进内层的: CORS 必须包在它外面 (在 create_app 里
    # 最后注册), 否则浏览器拿到一个没 CORS 头的响应 → fetch 抛"Failed to fetch" →
    # api.ts 看不到 401 → 不发 veda:auth-required → 远程登出/过期后界面卡在原地。
    check(
        "401 带 allow-origin",
        denied.headers.get("access-control-allow-origin") == DEV_ORIGIN,
        str(dict(denied.headers)),
    )
    check(
        "401 带 allow-credentials",
        denied.headers.get("access-control-allow-credentials") == "true",
        str(dict(denied.headers)),
    )


# ---------------------------------------------------------------------------
# 测试 10: 工作台响应头必须对跨源 renderer 可见
# ---------------------------------------------------------------------------


def test_revision_headers_are_readable_cross_origin() -> None:
    print("[10] 真 create_app 暴露工作台响应头, 跨源 renderer 能确认文件状态")
    cases = _HOME / "etag-cases"
    cases.mkdir(exist_ok=True)
    app = create_app(cases_root=cases, auth=False)

    @app.get("/api/probe-etag")
    def probe_etag() -> Response:
        return Response(
            headers={
                "ETag": '"sha256:saved"',
                "X-ScholarSeed-Content-Revision": "sha256:review-current",
                ARTIFACT_EDITABLE_HEADER: "true",
            }
        )

    response = TestClient(app).get("/api/probe-etag", headers={"origin": DEV_ORIGIN})
    exposed = {
        header.strip().lower()
        for header in response.headers.get("access-control-expose-headers", "").split(",")
        if header.strip()
    }
    check("跨源响应暴露 ETag", "etag" in exposed, str(dict(response.headers)))
    check(
        "跨源响应暴露审阅文件 revision",
        "x-scholarseed-content-revision" in exposed,
        str(dict(response.headers)),
    )
    check(
        "跨源响应暴露产物可编辑能力",
        ARTIFACT_EDITABLE_HEADER.lower() in exposed,
        str(dict(response.headers)),
    )


# ---------------------------------------------------------------------------
# 测试 11: status 投影 —— account 模式必须自报 mode/地址/凭据形态
# ---------------------------------------------------------------------------


def test_status_projection() -> None:
    print("[11] /api/auth/status 在 account 模式下的投影")
    signer = Signer()
    client = _protected_app(build_trust(AccountStub(signer)))
    body = client.get("/api/auth/status").json()
    check("mode=account", body.get("mode") == ACCOUNT_MODE, str(body))
    check("带 account_base_url", body.get("account_base_url") == ACCOUNT_BASE, str(body))
    check("methods 为两种凭据", body.get("methods") == list(ACCOUNT_METHODS), str(body))
    # 账号线的注册在账号服务侧, 宿主的 bootstrap 语义不适用
    check("bootstrap=False", body.get("bootstrap") is False, str(body))

    # Hosted mode remains explicit even when its service URL is not configured.
    # 前端据此直接显示「账号服务地址未配置」，而不是给一个点了没反应的登录表单。
    silent = _protected_app(AccountTrust(""))
    fallback = silent.get("/api/auth/status").json()
    check("未配地址仍报 account", fallback.get("mode") == ACCOUNT_MODE, str(fallback))
    check("未配地址时地址为空", fallback.get("account_base_url") == "", str(fallback))

    # account 腿没挂上（None）时按 provider 决议走，不无端冒出 account 模式
    bare = FastAPI()
    register_auth(bare, enabled=True, service=AuthService())
    bare_body = TestClient(bare).get("/api/auth/status").json()
    check("未挂 account 腿时回落 provider", bare_body.get("mode") != ACCOUNT_MODE, str(bare_body))


# ---------------------------------------------------------------------------
# 测试 12: 全量产品 app 走 env 装配（真 create_app，不是裸 register_auth）
# ---------------------------------------------------------------------------


def test_product_app_env_wiring() -> None:
    print("[12] 真 create_app 按环境变量接上账号服务信任面")
    cases = _HOME / "cases"
    cases.mkdir(exist_ok=True)
    os.environ[ACCOUNT_BASE_URL_ENV] = ACCOUNT_BASE
    try:
        app = create_app(cases_root=cases, auth=True, auth_mode=ACCOUNT_MODE)
        body = TestClient(app).get("/api/auth/status").json()
    finally:
        os.environ.pop(ACCOUNT_BASE_URL_ENV, None)
    check("mode=account", body.get("mode") == ACCOUNT_MODE, str(body))
    check("地址来自环境变量", body.get("account_base_url") == ACCOUNT_BASE, str(body))


# ---------------------------------------------------------------------------
# 测试 13: 跨语言 wire 一致性 —— serve 的模式表与 Electron 的必须同集合
# ---------------------------------------------------------------------------


def test_auth_mode_wire_alignment() -> None:
    print("[13] --auth-mode 取值与 Electron AUTH_MODES 同步")
    check("account 在 CLI choices", ACCOUNT_MODE in AUTH_MODE_CHOICES, str(AUTH_MODE_CHOICES))
    check("account 强制开鉴权", ACCOUNT_MODE in AUTH_MODE_ENFORCED, str(AUTH_MODE_ENFORCED))

    source = PRODUCT_TS.read_text(encoding="utf-8")
    match = re.search(AUTH_MODES_TS_PATTERN, source)
    check("product.ts 有 AUTH_MODES", match is not None, str(PRODUCT_TS))
    if match is None:
        return
    ts_modes = {chunk.strip().strip("'\"") for chunk in match.group(1).split(",") if chunk.strip()}
    # 两侧对不上就是「桌面端传了个 serve 不认的模式」→ argparse 直接退出, 后端起不来。
    check(
        "两侧模式集合一致",
        ts_modes == set(AUTH_MODE_CHOICES),
        f"ts={sorted(ts_modes)} py={sorted(AUTH_MODE_CHOICES)}",
    )


# ---------------------------------------------------------------------------
# 测试 14: 安装包默认策略 —— Finder 启动无环境变量也必须进入 account 登录门禁
# ---------------------------------------------------------------------------


def test_packaged_account_policy() -> None:
    print("[14] 安装版内置账号鉴权策略并显式转交子进程")
    product = json.loads(PRODUCT_CONFIG.read_text(encoding="utf-8"))
    package = json.loads(PACKAGE_CONFIG.read_text(encoding="utf-8"))
    backend = BACKEND_TS.read_text(encoding="utf-8")

    check("产品配置默认 account", product.get("auth_mode") == ACCOUNT_MODE, str(product))
    account_base = str(product.get("account_base_url", ""))
    check(
        "产品配置包含 HTTP(S) 账号服务",
        account_base.startswith(("http://", "https://")),
        account_base,
    )
    resources = package.get("build", {}).get("extraResources", [])
    check(
        "electron-builder 复制 product.json",
        any(
            row.get("from") == "resources/product.json" and row.get("to") == "product.json"
            for row in resources
            if isinstance(row, dict)
        ),
        str(resources),
    )
    check(
        "账号服务地址显式注入 backend 子进程",
        f"[SCHOLARSEED_ACCOUNT_BASE_URL_ENV]: accountBase" in backend,
        str(BACKEND_TS),
    )
    check(
        "损坏配置使用 fail-closed 策略",
        "SECURE_PACKAGED_FALLBACK" in backend,
        str(BACKEND_TS),
    )


# ---------------------------------------------------------------------------
# 测试 6c: 过期 jti 淘汰 —— 内存收敛, 且不得越过 leeway 边界
# ---------------------------------------------------------------------------


def test_revocation_pruning() -> None:
    print("[6c] 过期 jti 淘汰: leeway 内保留 / 超出则收敛 / 缺 expires_at 不淘汰")
    signer = Signer()
    stub = AccountStub(signer)
    now = time.time()
    clock = Clock(start=now)
    trust = build_trust(stub, clock, spawn=inline_spawn)

    inside = now - DECODE_LEEWAY_S + 5  # 仍在 leeway 内: 验签依旧通过
    outside = now - DECODE_LEEWAY_S - 10  # 超出 leeway: 验签自己就会拒
    stub.revocations.extend(
        [
            {"jti": "jti-lee", "revoked_at": now - 100, "expires_at": inside},
            {"jti": "jti-gone", "revoked_at": now - 100, "expires_at": outside},
            # account 未升级时不回 expires_at：必须留着。猜一个 exp 去淘汰它，
            # 等于在版本偏斜期放行已吊销令牌。
            {"jti": "jti-skew", "revoked_at": now - 100},
        ]
    )
    trust.identity(signer.token(jti="jti-probe"))  # 首拉即触发一次淘汰
    # 淘汰只能白盒看：被正确淘汰的 jti，其令牌本就过不了验签，行为上无从区分。
    check(
        "leeway 外的 jti 已淘汰",
        "jti-gone" not in trust._revoked_jtis,
        str(sorted(trust._revoked_jtis)),
    )
    check("leeway 内的 jti 保留", "jti-lee" in trust._revoked_jtis)
    check("缺 expires_at 的 jti 保留", "jti-skew" in trust._revoked_jtis)

    # 行为面证据：这把令牌已过 exp 但仍在 leeway 内，PyJWT 验签**通过**，所以拦住它的
    # 只可能是黑名单。淘汰条件若漏掉 leeway 余量，这一条就变成放行已吊销令牌。
    lee_token = signer.token(jti="jti-lee", ttl=int(inside - time.time()))
    check("leeway 内已吊销仍被拒", trust.identity(lee_token) is None)


def main() -> int:
    test_valid_user_token()
    test_admin_token_rejected()
    test_issuer_pin()
    test_key_rotation()
    test_jwks_unreachable_fail_closed()
    test_transport_failure_logs_cause_chain_without_credentials()
    test_revocations()
    test_revocations_off_request_path()
    test_revocation_pruning()
    test_dual_credential_middleware()
    test_logout_drops_the_in_memory_token()
    test_off_mode_projects_account_identity()
    test_preflight_not_blocked()
    test_unauthorized_is_readable_cross_origin()
    test_revision_headers_are_readable_cross_origin()
    test_status_projection()
    test_product_app_env_wiring()
    test_auth_mode_wire_alignment()
    test_packaged_account_policy()
    print(f"\ncontract_account_trust: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
