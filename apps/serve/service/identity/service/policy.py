"""运行期认证策略：不可变 AuthPolicy + 原子替换（proposal 18）。

## 解决的问题类

「启动期固化的信任策略需要运行期突变」。auth-mode（强制账号鉴权 / 免鉴权）过去是
serve 的启动参数：鉴权中间件只在 enabled 时注册一次，`enabled` 被多处闭包捕获，切换
只能重启进程。Starlette 禁止启动后增删中间件（框架硬约束），因此唯一正确形制是
**鉴权中间件常挂 + 每请求读一个不可变 policy 对象**：切换 = 单引用原子替换，in-flight
请求按旧 policy 完成（安全侧）。

## 单一真源

`app.state.auth_policy` 是唯一真源；`app.state.auth_enabled` / `app.state.auth_mode`
是它的投影（既有读取点逐步收敛到 `current_policy`），由 `install_policy` 同步写，
不允许别处单独赋值。桌面宿主持有模式的产品真源（偏好文件），serve 启动参数只是
初始投影；运行期切换经 Host-Key 保护的控制端点（见 identity/api/routes.py）。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Optional, Tuple

from fastapi import FastAPI

from service.identity.service.account import ACCOUNT_MODE

POLICY_STATE = "auth_policy"
API_PREFIX = "/api/"

AUTH_MODE_OFF = "off"
AUTH_MODE_AUTO = "auto"
AUTH_MODE_ENFORCED: Tuple[str, ...] = ("local", ACCOUNT_MODE)
AUTH_MODE_CHOICES: Tuple[str, ...] = (AUTH_MODE_OFF, *AUTH_MODE_ENFORCED, AUTH_MODE_AUTO)


@dataclass(frozen=True)
class AuthPolicy:
    """不可变认证策略。替换只允许整体换对象，不允许原地改字段。"""

    enabled: bool
    mode: Optional[str]
    public_prefixes: Tuple[str, ...]
    exempt_prefixes: Tuple[str, ...]

    def protects(self, path: str) -> bool:
        """该路径是否要求已鉴权身份（免鉴权模式恒 False）。"""
        if not self.enabled or not path.startswith(API_PREFIX):
            return False
        if any(path.startswith(prefix) for prefix in self.public_prefixes):
            return False
        return not any(path.startswith(prefix) for prefix in self.exempt_prefixes)


def enabled_for_mode(mode: str, has_users: bool) -> bool:
    """mode → enabled 的单一决议（启动期与运行期切换共用，不允许两处各写一遍）。"""
    if mode not in AUTH_MODE_CHOICES:
        raise ValueError(f"unsupported auth mode: {mode}")
    if mode == AUTH_MODE_OFF:
        return False
    if mode in AUTH_MODE_ENFORCED:
        return True
    return bool(has_users)


def current_policy(app: FastAPI) -> AuthPolicy:
    policy = getattr(app.state, POLICY_STATE, None)
    if not isinstance(policy, AuthPolicy):
        # 装配必经 install_policy；走到这里说明 create_app 链路被绕过，属编程错误，
        # 吵出来而不是猜一个默认策略（猜 enabled 是鉴权漏洞，猜 disabled 是功能黑洞）。
        raise RuntimeError("auth policy not installed")
    return policy


def install_policy(app: FastAPI, policy: AuthPolicy) -> AuthPolicy:
    """落 policy 并同步投影字段（既有读取点的过渡面）。"""
    setattr(app.state, POLICY_STATE, policy)
    app.state.auth_enabled = policy.enabled
    app.state.auth_mode = policy.mode
    return policy


def replace_policy(app: FastAPI, *, mode: str, has_users: bool) -> AuthPolicy:
    """运行期切换：构造新不可变对象整体替换，保留 prefixes 不变。"""
    current = current_policy(app)
    return install_policy(
        app,
        replace(current, enabled=enabled_for_mode(mode, has_users), mode=mode),
    )


__all__ = [
    "API_PREFIX",
    "AUTH_MODE_AUTO",
    "AUTH_MODE_CHOICES",
    "AUTH_MODE_ENFORCED",
    "AUTH_MODE_OFF",
    "AuthPolicy",
    "current_policy",
    "enabled_for_mode",
    "install_policy",
    "replace_policy",
]
