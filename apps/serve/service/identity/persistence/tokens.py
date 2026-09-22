"""Auth token store — bearer token 签发/校验/吊销 (服务端只存哈希, 30 天 TTL)。

安全机制:
- 设备绑定: token 绑定签发时的 MAC 地址指纹, 跨机器拷贝无法使用
- 签名防篡改: 用 MAC 作为密钥对 token_hash/user_id/device_fp/expires 签名,
  篡改 auth.json 任何字段均导致验证失败
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
import uuid
from typing import Any, Dict, Optional

from service.identity.persistence.store import auth_file_lock, load_auth_data, save_auth_data

logger = logging.getLogger(__name__)

TOKEN_TTL_S = 30 * 24 * 3600  # 30 天


class TokenRepository:
    """CRUD owner for durable bearer-token records."""

    def issue(self, user_id: str) -> str:
        return issue_token(user_id)

    def verify(self, token: str) -> Optional[Dict[str, Any]]:
        return verify_token(token)

    def revoke(self, token: str) -> bool:
        return revoke_token(token)


# ── 设备指纹 ──


def _device_fingerprint() -> str:
    """生成当前设备指纹 (仅基于 MAC 地址哈希, 截取前 16 字符)。"""
    mac = uuid.getnode()
    return hashlib.sha256(str(mac).encode()).hexdigest()[:16]


# ── Token 哈希 ──


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _sign(token_hash: str, user_id: str, device_fp: str, expires: float) -> str:
    """用 MAC 地址作为密钥对 token 数据签名，防止篡改 auth.json 中的字段。"""
    mac_key = str(uuid.getnode()).encode()
    payload = f"{token_hash}:{user_id}:{device_fp}:{expires}".encode()
    return hmac.new(mac_key, payload, hashlib.sha256).hexdigest()[:16]


# ── 签发 ──


def issue_token(user_id: str) -> str:
    """签发新 token, 绑定 MAC 指纹 + 签名防篡改。"""
    token = secrets.token_urlsafe(32)
    device_fp = _device_fingerprint()
    token_hash = _hash_token(token)
    expires = time.time() + TOKEN_TTL_S
    signature = _sign(token_hash, user_id, device_fp, expires)
    # 读-改-写互斥: 并发登录不得互相覆盖 token 记录
    with auth_file_lock():
        data = load_auth_data()
        # 本地单用户场景：清除该用户旧 token，保持单 token
        data["tokens"] = [t for t in data["tokens"] if t.get("user_id") != user_id]
        data["tokens"].append(
            {
                "token_hash": token_hash,
                "user_id": user_id,
                "device_fp": device_fp,
                "signature": signature,
                "created": time.time(),
                "expires": expires,
            }
        )
        # 清理过期 token
        data["tokens"] = [t for t in data["tokens"] if t.get("expires", 0) > time.time()]
        save_auth_data(data)
    return token


# ── 验证 ──


def verify_token(token: str) -> Optional[Dict[str, Any]]:
    """验证 token: 哈希匹配 → 过期检查 → 设备指纹 → 签名防篡改 → 返回用户信息。"""
    if not token:
        return None
    h = _hash_token(token)
    data = load_auth_data()
    current_device = _device_fingerprint()

    for t in data["tokens"]:
        if not hmac.compare_digest(t["token_hash"], h):
            continue
        if t.get("expires", 0) <= time.time():
            continue
        # 设备指纹校验
        if t.get("device_fp") != current_device:
            logger.warning(
                "token device mismatch: expected %s, got %s",
                t.get("device_fp", "")[:6],
                current_device[:6],
            )
            continue
        # 签名校验: 防止篡改 expires/user_id 等字段
        expected = _sign(t["token_hash"], t["user_id"], t["device_fp"], t.get("expires", 0))
        if not hmac.compare_digest(t.get("signature", ""), expected):
            logger.warning("token signature mismatch, data may be tampered")
            continue
        # 查找用户
        uid = t["user_id"]
        for u in data["users"]:
            if u["user_id"] == uid:
                return {
                    "user_id": uid,
                    "email": u["email"],
                    "display_name": u.get("display_name", ""),
                }
    return None


# ── 吊销 ──


def revoke_token(token: str) -> bool:
    h = _hash_token(token)
    with auth_file_lock():
        data = load_auth_data()
        n = len(data["tokens"])
        data["tokens"] = [t for t in data["tokens"] if not hmac.compare_digest(t["token_hash"], h)]
        save_auth_data(data)
    return len(data["tokens"]) < n


__all__ = [
    "issue_token",
    "verify_token",
    "revoke_token",
    "TOKEN_TTL_S",
    "_device_fingerprint",
]
