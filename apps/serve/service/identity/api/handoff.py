"""桌面登录交接的本机协调端点 (proposal 74 §8.3)。

四个端点都在 `/api/auth/handoff/` 下。**这个前缀在 `_PUBLIC_PREFIXES` 里, 所以它在
任何鉴权模式下都免鉴权** —— 不只是桌面端的 `--auth-mode off`。协调层写的是本机
一次性 code, 因此每个端点都过 `require_host_process`: 只有持 Host-Key 的桌面主进程
可达, 与 `/api/auth/mode` 同一条闸。缺了它, 非桌面部署上的匿名远端就能 claim /
deliver / release。

失败形状纪律: `deliver` 对「无 claim」「租约已过期」「自投」回同一个 `orphaned`,
不细分 —— 否则本机任何进程都能拿它当 state 存在性 oracle。`renew` 同理。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Request

from service.identity.persistence.handoff import DeliveryStatus, HandoffClaimStore
from service.identity.schema import HandoffDeliveryRequest, HandoffOwnerRequest
from service.identity.utils import require_host_process

HANDOFF_ROUTE_PREFIX = "/api/auth/handoff"
HTTP_BAD_REQUEST = 400


class HandoffRouteStatus(str, Enum):
    """协调端点的线上状态词。持久层结论到 HTTP 词汇的映射收在这里。"""

    CLAIMED = "claimed"
    CONFLICT = "conflict"
    RENEWED = "renewed"
    DELIVERED = "delivered"
    ORPHANED = "orphaned"
    RELEASED = "released"


def _lease_body(
    status: HandoffRouteStatus, lease_expires_at: float, code: str | None
) -> Dict[str, Any]:
    body: Dict[str, Any] = {"status": status.value, "lease_expires_at": lease_expires_at}
    if code:
        body["code"] = code
    return body


def build_handoff_router(store: HandoffClaimStore) -> APIRouter:
    """本机交接协调面。store 构造不做 I/O, schema 首次使用时惰性建好。"""

    router = APIRouter()

    @router.post(HANDOFF_ROUTE_PREFIX + "/claim")
    def claim(payload: HandoffOwnerRequest, request: Request) -> Dict[str, Any]:
        """发起方登记 claim。同 state 已被别的实例持有时回 conflict。"""

        require_host_process(request)
        try:
            lease = store.claim(payload.state, payload.owner_id)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, str(error)) from error
        if lease is None:
            # 客户端据此降级成「只靠内存 state」的既有行为, 不让协调层挡住登录。
            return {"status": HandoffRouteStatus.CONFLICT.value}
        return _lease_body(HandoffRouteStatus.CLAIMED, lease.lease_expires_at, None)

    @router.post(HANDOFF_ROUTE_PREFIX + "/renew")
    def renew(payload: HandoffOwnerRequest, request: Request) -> Dict[str, Any]:
        """三合一: 续租 + 查转交 + 原子取走。

        `lease_expires_at` 是租约的唯一真源, 客户端据此自适应续租节奏而**不**硬编码
        租约时长 —— 两个值分散在两种语言里时, 耦合约束只能靠这种单向真源守住。
        """

        require_host_process(request)
        try:
            lease = store.renew(payload.state, payload.owner_id)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, str(error)) from error
        if lease is None:
            return {"status": HandoffRouteStatus.ORPHANED.value}
        return _lease_body(HandoffRouteStatus.RENEWED, lease.lease_expires_at, lease.code)

    @router.post(HANDOFF_ROUTE_PREFIX + "/deliver")
    def deliver(payload: HandoffDeliveryRequest, request: Request) -> Dict[str, Any]:
        """接管方把深链里的一次性 code 转交给发起方。本机唯一的写入面。"""

        require_host_process(request)
        try:
            status = store.deliver(payload.state, payload.code, payload.delivered_by)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, str(error)) from error
        outcome = (
            HandoffRouteStatus.DELIVERED
            if status is DeliveryStatus.DELIVERED
            else HandoffRouteStatus.ORPHANED
        )
        return {"status": outcome.value}

    @router.post(HANDOFF_ROUTE_PREFIX + "/release")
    def release(payload: HandoffOwnerRequest, request: Request) -> Dict[str, Any]:
        """发起方终态清理。"""

        require_host_process(request)
        try:
            store.release(payload.state, payload.owner_id)
        except ValueError as error:
            raise HTTPException(HTTP_BAD_REQUEST, str(error)) from error
        return {"status": HandoffRouteStatus.RELEASED.value}

    return router


__all__ = [
    "HANDOFF_ROUTE_PREFIX",
    "HandoffRouteStatus",
    "build_handoff_router",
]
