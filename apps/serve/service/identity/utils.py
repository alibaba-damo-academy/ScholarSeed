"""Stateless identity transport helpers."""

from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request
from starlette.status import HTTP_401_UNAUTHORIZED

LOCAL_USER_ID = "local"
AUTHENTICATION_REQUIRED_ERROR = "authentication required"

#: 受信宿主（Electron 主进程）标识头与其取值来源的环境变量。密钥由桌面端启动 serve 时
#: 注入、**不**下发给渲染层；未注入时要求该头的端点整条关闭（fail closed）。
#: 形制从 content 域移入本模块：运行期 auth-mode 切换面与废纸篓兑换共用同一道门。
HOST_PROCESS_HEADER = "X-ScholarSeed-Host-Key"
HOST_PROCESS_KEY_ENV = "SCHOLARSEED_HOST_PROCESS_KEY"


def is_host_process(request: Request) -> bool:
    """Check the same host capability used by guarded device-local routes."""
    expected = os.environ.get(HOST_PROCESS_KEY_ENV, "").strip()
    provided = request.headers.get(HOST_PROCESS_HEADER, "").strip()
    return bool(expected) and secrets.compare_digest(expected, provided)


def require_host_process(request: Request) -> None:
    """仅受信宿主可达；缺 key / 不匹配一律 403（compare_digest 恒定时间比较）。"""
    if not is_host_process(request):
        raise HTTPException(status_code=403, detail="host_process_only")


# 会话归属轴: 本机数据归给"这台机器"还是"这个账号"。
#
# machine —— 同一台机器上的本地数据在所有登录账号之间互通 (桌面端产品语义)。
# principal —— 按账号隔离 (对外部署必须走这条, 否则一份 serve 会把所有用户的会话
#   互相暴露)。因此**默认是 principal**: 新部署除非显式声明, 都按隔离对待。
OWNERSHIP_AXIS_MACHINE = "machine"
OWNERSHIP_AXIS_PRINCIPAL = "principal"
OWNERSHIP_AXIS_CHOICES = (OWNERSHIP_AXIS_MACHINE, OWNERSHIP_AXIS_PRINCIPAL)
OWNERSHIP_AXIS_DEFAULT = OWNERSHIP_AXIS_PRINCIPAL
OWNERSHIP_AXIS_ENV = "SCHOLARSEED_OWNERSHIP_AXIS"
OWNERSHIP_AXIS_STATE = "ownership_axis"


def resolve_ownership_axis(explicit: str | None, environment_value: str) -> str:
    """按 CLI > env > 默认 定轴; 无法识别的取值一律退回默认 (隔离) 而不是报错放行。"""

    for candidate in (explicit, environment_value):
        normalized = str(candidate or "").strip().lower()
        if normalized in OWNERSHIP_AXIS_CHOICES:
            return normalized
    return OWNERSHIP_AXIS_DEFAULT


def owner_id_for(user_id: str, axis: str) -> str:
    """把一个真实账号身份投影成本地数据的归属身份 —— 归属轴的唯一投影点。

    HTTP 侧的 ``request_owner_id`` 与执行面（会话已经热在内存里、手上只有计量身份）共用
    这一条规则，因此「哪一腿喂归属谓词」不取决于调用点有没有 request。
    """

    if str(axis or "") == OWNERSHIP_AXIS_MACHINE:
        return LOCAL_USER_ID
    return str(user_id or "")


def bearer_or_cookie(request: Request) -> str:
    """Return a bearer credential from the standard HTTP locations."""

    authorization = request.headers.get("authorization") or ""
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return request.cookies.get("scholarseed_token") or ""


def request_user_id(request: Request) -> str:
    """Project the middleware identity, or the stable local no-auth principal.

    已登录时优先取中间件投影的真实账号 sub —— 免鉴权模式（桌面端恒 auth-off）下也是如此，
    否则网关用量归属会恒记到不存在的 ``local`` 账号，内置模型据此取凭据只能落空。缺投影
    身份时才按 auth_enabled 回落：免鉴权取 ``local`` 保持可用，强制鉴权则要求登录。
    """

    user_id = str(getattr(request.state, "user_id", "") or "").strip()
    if user_id:
        return user_id
    if not bool(getattr(request.app.state, "auth_enabled", False)):
        return LOCAL_USER_ID
    raise HTTPException(HTTP_401_UNAUTHORIZED, AUTHENTICATION_REQUIRED_ERROR)


def request_owner_id(request: Request) -> str:
    """本地数据归属身份 —— 与 request_user_id (真实账号身份) 是两件事。

    machine 轴下收敛到单一机器级 principal; 此时凭据兑换、网关用量归属仍必须走
    request_user_id, 否则计量会记到一个不存在的人头上。
    """

    axis = str(getattr(request.app.state, OWNERSHIP_AXIS_STATE, "") or OWNERSHIP_AXIS_DEFAULT)
    # machine 轴不去解析账号身份: 归属与登录态无关, 且强制鉴权下无凭据时 request_user_id
    # 会直接 401, 那样"本机数据归谁"就又被登录态决定了。
    account = "" if axis == OWNERSHIP_AXIS_MACHINE else request_user_id(request)
    return owner_id_for(account, axis)
