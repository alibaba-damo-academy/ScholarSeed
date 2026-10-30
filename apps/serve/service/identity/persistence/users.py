"""Auth user store — file-backed 用户存储 (PBKDF2 加盐口令; token 见 tokens.py)。

设计 (33 待办项落地, 刻意保持小):
- 用户/凭据单文件 ``~/.scholarseed/auth.json`` (paths.AUTH_FILE): PBKDF2-HMAC-SHA256 加盐
  口令哈希 + 不落明文; token = secrets.token_urlsafe(32), 服务端存哈希。
- **默认关闭** (本地单用户体验不变): `scholarseed serve --auth` 显式开, 或 auth.json 里
  已有用户时自动开 (建了号就保护)。
- 鉴权面: FastAPI middleware 拦 `/api/*`; 放行 /api/healthz 与 /api/auth/*。
  凭证两种携带方式: `Authorization: Bearer <token>` (fetch) / cookie `scholarseed_token`
  (SSE EventSource 无法带 header)。
- bootstrap: 无用户时 /api/auth/register 开放 (建第一个号); 之后注册需已登录。
- 归账: request.state.user_id → research REST Actor(user_id=...) (ledger 多用户口径)。

CLI: `scholarseed login [--url] [--register]` / `scholarseed logout` / `scholarseed whoami`
(token 存 ~/.scholarseed/credentials.json, scripts/CI 用 env SCHOLARSEED_AUTH_TOKEN 覆盖)。

本模块 = 用户/凭据存储层。token 文件读写复用同一个 auth.json; HTTP 装配在
service/api/auth.py。
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any, Dict, Optional

from service.identity.persistence.store import auth_file_lock, load_auth_data, save_auth_data

_PBKDF2_ITERS = 240_000


class UserRepository:
    """CRUD owner for durable identity-user records."""

    def has_users(self) -> bool:
        return has_users()

    def create(self, email: str, password: str) -> Dict[str, Any]:
        return create_user(email, password)

    def verify_password(self, email: str, password: str) -> Optional[Dict[str, Any]]:
        return verify_password(email, password)


def _hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ITERS
    ).hex()


def has_users() -> bool:
    return bool(load_auth_data()["users"])


def create_user(email: str, password: str) -> Dict[str, Any]:
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("invalid email")
    if len(password) < 6:
        raise ValueError("password too short (min 6)")
    salt = secrets.token_hex(16)
    user = {
        "user_id": f"u-{secrets.token_hex(6)}",
        "email": email,
        "salt": salt,
        "password_hash": _hash_password(password, salt),
        "created": time.time(),
    }
    with auth_file_lock():
        data = load_auth_data()
        if any(u["email"] == email for u in data["users"]):
            raise ValueError(f"user {email} already exists")
        data["users"].append(user)
        save_auth_data(data)
    return {"user_id": user["user_id"], "email": email}


def verify_password(email: str, password: str) -> Optional[Dict[str, Any]]:
    email = email.strip().lower()
    for u in load_auth_data()["users"]:
        if u["email"] == email:
            # Identities without a local password cannot authenticate with one.
            if not u.get("salt") or not u.get("password_hash"):
                return None
            if hmac.compare_digest(_hash_password(password, u["salt"]), u["password_hash"]):
                return {"user_id": u["user_id"], "email": email}
            return None
    return None
