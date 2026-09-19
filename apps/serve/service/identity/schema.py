"""Identity HTTP request schemas."""

from __future__ import annotations

from pydantic import BaseModel


class CredentialsRequest(BaseModel):
    """Local account credentials supplied by an HTTP client."""

    email: str
    password: str


class HandoffOwnerRequest(BaseModel):
    """本机交接协调里「发起方身份」三件套端点 (claim / renew / release) 的共同入参。

    `owner_id` 是发起方的**进程实例 id** (启动时随机生成), 不是 pid —— pid 会被复用,
    重启后的新进程可能拿到同一个 pid 从而意外接管前身的 claim, 那恰好违反「重启后
    重新登录」的裁决。

    长度与字符集校验刻意不在这里设 `max_length`: 那会让 FastAPI 回默认 422 的
    `{detail:[...]}`, 在本面的恒定失败形状之外多出一套 wire 形状。校验由持久层统一
    做, 经 ValueError → 400 + snake_case 码。
    """

    state: str
    owner_id: str


class HandoffDeliveryRequest(BaseModel):
    """接管方转交一次性 code (deliver)。

    `delivered_by` 与 `owner_id` 同一个取值空间: 都是进程实例 id。自投 (等于 claim 的
    owner) 一律按无主处理。
    """

    state: str
    code: str
    delivered_by: str
