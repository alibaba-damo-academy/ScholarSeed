"""HTTP adapter for host-level identity endpoints and provider route mounting.

各登录方式的端点由 provider 自带 (经 ``register_routes`` 挂载, 必须落在
/api/auth/ 公开前缀下); 本模块只保留所有方式共有的宿主面: /api/auth/me、
/api/auth/logout、/api/auth/status、/api/auth/handoff/* (桌面登录交接的本机协调,
proposal 74) 与全 /api 鉴权 middleware。

``/api/auth/`` 在 ``_PUBLIC_PREFIXES`` 里, 所以挂在它下面的端点在**任何**鉴权模式下
都免鉴权 —— 不只是桌面端的 ``--auth-mode off``。协调面写本机一次性 code, 因此它自带
Host-Key 闸 (``require_host_process``), 与 ``/api/auth/mode`` 同一条纪律。
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Sequence

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from service.identity.api.handoff import build_handoff_router
from service.identity.catalog import auth_providers
from service.identity.persistence.handoff import HandoffClaimStore
from service.identity.providers.protocol import IdentityContext
from service.identity.service.account import account_trust_from_env
from service.identity.service.auth import AuthService
from service.identity.service.policy import (
    AUTH_MODE_CHOICES,
    AuthPolicy,
    current_policy,
    install_policy,
    replace_policy,
)
from service.identity.utils import bearer_or_cookie, is_host_process, require_host_process

# ── FastAPI 装配 ──

_PUBLIC_PREFIXES = ("/api/healthz", "/api/auth/")
API_PREFIX = "/api/"
DEVICE_SKILL_ROUTE_PREFIX = "/api/capabilities/skills"
# CORS 预检按规范不带凭据 (浏览器不会给 preflight 附 cookie/Authorization)。拦下它就等于
# 让跨源的 JSON POST/PUT/DELETE 全部失败: 预检收不到 CORS 头 → 浏览器判定不允许 → 真正的
# 请求根本发不出去。dev 期 renderer 在 Vite 源、后端在 127.0.0.1:<port>, 正是跨源。
# 预检本身无副作用 (CORSMiddleware 直接应答, 不进业务路由), 放行不放宽任何鉴权。
PREFLIGHT_METHOD = "OPTIONS"


def register_auth(
    app: FastAPI,
    *,
    enabled: bool,
    service: AuthService | None = None,
    independently_authenticated_prefixes: Sequence[str] = (),
    account_tokens: Any | None = None,
    mode: str | None = None,
    on_logout: Callable[[str], Awaitable[None]] | None = None,
    on_auth_disabled: Callable[[], Awaitable[None]] | None = None,
) -> None:
    """注册 /api/auth/* 路由 + **常挂**的全 /api 鉴权 middleware（proposal 18）。

    鉴权强制不再是注册期决定：middleware 常驻，每请求读不可变 AuthPolicy；
    切换 = `replace_policy` 原子替换对象（Starlette 禁止启动后增删 middleware）。
    `enabled`/`mode` 只用于构造初始 policy（启动参数投影）。

    默认装配同时接上托管账号服务的信任面 (未配地址时自动不参与)。
    """

    auth = service or AuthService(
        providers=auth_providers(),
        account=account_trust_from_env(),
    )
    skill_credentials = getattr(app.state, "skill_credentials", None)
    if skill_credentials is not None and account_tokens is not None:
        skill_credentials.bind_identity(auth.identity, account_tokens.current)

    capability_prefixes = tuple(
        prefix
        for raw_prefix in independently_authenticated_prefixes
        if (prefix := str(raw_prefix).strip()).startswith(API_PREFIX) and prefix != API_PREFIX
    )
    install_policy(
        app,
        AuthPolicy(
            enabled=enabled,
            mode=mode,
            public_prefixes=_PUBLIC_PREFIXES,
            exempt_prefixes=capability_prefixes,
        ),
    )

    ctx = IdentityContext(users=auth.users, tokens=auth.tokens)
    for provider in auth.providers:
        provider.register_routes(app, ctx)

    @app.post("/api/auth/logout")
    async def logout(request: Request) -> Dict[str, Any]:
        credential = bearer_or_cookie(request)
        # 先解析再吊销: 吊销后这条凭据就认不出人了, 拿不到要摘的槽位。
        who = await run_in_threadpool(auth.identity, credential)
        ok = auth.logout(credential)
        if account_tokens is not None and who is not None:
            # 不摘的话这份 JWT 会一直留在进程内存里可被出站调用取用, 直到 serve 重启。
            account_tokens.forget(str(who.get("user_id") or ""))
        if who is not None and on_logout is not None:
            await on_logout(str(who.get("user_id") or ""))
        if skill_credentials is not None and who is not None:
            skill_credentials.forget(str(who.get("user_id") or ""))
        return {"ok": ok}

    @app.get("/api/auth/me")
    def me(request: Request) -> Dict[str, Any]:
        who = auth.identity(bearer_or_cookie(request))
        if who is None:
            # auth 关闭时报告 anonymous (webui 据此跳过登录页); 运行期切换后即时生效。
            if not current_policy(request.app).enabled:
                return {"user_id": "local", "email": "", "auth": False}
            raise HTTPException(401, "not logged in")
        # Project the common display name for local and hosted identities.
        nickname = str(who.get("nickname") or who.get("display_name") or "")
        return {**who, "nickname": nickname, "auth": True}

    # ── Status ──

    @app.get("/api/auth/status")
    def status(request: Request) -> Dict[str, Any]:
        policy = current_policy(request.app)
        return auth.status(
            enabled=policy.enabled,
            explicit_mode=policy.mode,
        )

    # ── 运行期切换（仅受信宿主）──

    @app.put("/api/auth/mode")
    async def switch_auth_mode(request: Request) -> Dict[str, Any]:
        """account ↔ off 运行期切换。Host-Key 门禁：无桌面宿主时整条关闭。

        切换语义（proposal 18 §6）：旧凭据全量失效不迁移 —— holder clear-all、
        技能凭据快照清空；在途请求按旧 policy 完成（安全侧）。重启不是本端点的事
        （桌面端仅在端点失败时回退重启腿）。
        """
        require_host_process(request)
        payload = await request.json()
        mode = str(payload.get("mode") or "").strip()
        if mode not in AUTH_MODE_CHOICES:
            raise HTTPException(400, "invalid_auth_mode")
        policy = replace_policy(app, mode=mode, has_users=auth.has_users())
        if not policy.enabled:
            if on_auth_disabled is not None:
                await on_auth_disabled()
            if account_tokens is not None:
                account_tokens.clear_all()
            skill_credentials = getattr(app.state, "skill_credentials", None)
            if skill_credentials is not None:
                skill_credentials.clear_credentials()
        return {
            "ok": True,
            "mode": policy.mode,
            "enabled": policy.enabled,
            "restarted": False,
        }

    # ── 桌面登录交接的本机协调面（proposal 74）──
    # store 构造不做 I/O（schema 首次使用时惰性建），所以挂在这里不会因为一个坏库
    # 触发 bootstrap 的 fail-open except 把整个鉴权面降级成 no-auth。
    app.include_router(build_handoff_router(HandoffClaimStore()))

    register_auth_middleware(app, auth, account_tokens=account_tokens)


def register_auth_middleware(
    app: FastAPI,
    service: AuthService,
    *,
    account_tokens: Any | None = None,
) -> None:
    """Protect user APIs while leaving capability-authenticated routes to their owner.

    中间件**常挂**：是否强制由每请求读取的 AuthPolicy 决定（public/exempt 前缀也在
    policy 里），运行期切换无需动 middleware 栈。

    ``account_tokens`` (an ``AccountTokenHolder``) is remembered here because this is the
    one place every authenticated ``/api`` request passes through while still holding the
    raw credential. The outbound metering header is emitted from a *different* request
    context (Codex subprocess -> loopback bridge -> gateway), which has no credential of
    its own; without this capture the gateway can never attribute usage to a person.
    """

    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next):
        path = request.url.path
        if request.method == PREFLIGHT_METHOD or not path.startswith(API_PREFIX):
            return await call_next(request)
        # 身份投影与访问拦截解耦：凡带了可验证凭据就投影（set user_id + remember），
        # 无论该路径是否强制鉴权。桌面端 serve 恒 auth-off，若只在 protects 分支里投影，
        # 登录用户的 account JWT 永不进 holder，网关内置模型据此取凭据时只能落空 → 401。
        # 是否因“无身份”而 401，仍单独交给 protects 决定，未登录可用因此不变。
        credential = bearer_or_cookie(request)
        request.state.auth_credential_present = bool(credential)
        # identity 内部是同步 httpx。稳态下它只读内存缓存，但冷启动首拉与 JWKS 的 kid
        # 未命中仍会出网最多 HTTP_TIMEOUT_S：在 async middleware 里直接调会把整个事件
        # 循环冻住（连带所有并发请求），故挪进线程池。sync 路由（/api/auth/me）由
        # FastAPI 自己放线程池，不需要这一层。
        who = await run_in_threadpool(service.identity, credential) if credential else None
        request.state.auth_identity_rejected = bool(credential) and who is None
        if who is not None:
            request.state.user_id = who["user_id"]
            request.state.user_email = who["email"]
            if account_tokens is not None:
                # 纯内存记住，供出站计量头动态取值；非账号服务 JWT 由 holder 自己忽略。
                account_tokens.remember(who["user_id"], credential)
        elif current_policy(request.app).protects(path) and not (
            (path == DEVICE_SKILL_ROUTE_PREFIX or path.startswith(DEVICE_SKILL_ROUTE_PREFIX + "/"))
            and is_host_process(request)
        ):
            return JSONResponse({"detail": "authentication required"}, status_code=401)
        return await call_next(request)


__all__ = ["register_auth", "register_auth_middleware"]
