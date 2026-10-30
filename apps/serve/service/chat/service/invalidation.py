"""Coarse product-data invalidation announced on the conversation stream.

AI 经 bridge 改完产品数据后, 界面自己不会知道: 文献库列表、左侧 facet、首页计数都是
各自挂载时取一次数, 之后只按新鲜度窗口重取。于是「让 AI 加了个标签, 面板还是旧的」。
本模块只做一件事 —— 把「哪些数据域过期了」作为一条产品事件发布到当前会话的事件流上,
渲染层收到后按域整片重取 (消费方是 renderer 的 live.ts)。

两个刻意的取舍:

1. **粗粒度**: 事件只带数据域名, 不带被改的条目 id。细粒度失效要求每个 bridge 操作
   声明它写了哪些实体、每个界面组件声明它读了哪些实体; 两侧标签一旦漂移, 表现是静默
   的陈旧数据, 没有报错也没有日志。粗粒度的代价只是多拉一次已经打开的列表。
2. **广播失败不影响业务**: 变更已经落库, 不能因为一条通知发不出去就把工具调用报成
   失败 —— 模型会据此重试, 而重试会二次改库。

发布走会话既有的产品事件流 (`LiveSession.publish`), 因此不新增端点、不新增订阅:
断线重连按 seq 续传, 事件本身也是持久化的。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from service.chat.constants import PRODUCT_EVENT_PRODUCT_DATA_CHANGED

LOGGER = logging.getLogger(__name__)

#: 文献库数据域: 文献条目、附件、笔记、标签、分类, 以及由它们算出的计数与 facet。
SCOPE_LITERATURE = "literature"
#: 资料库数据域: 项目资源树与已授权关联根。
SCOPE_RESOURCES = "resources"


class ProductEventPublisher(Protocol):
    """An active session scope able to durably publish one product event."""

    async def publish(
        self,
        kind: str,
        data: Mapping[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
        idempotency_key: str = "",
    ) -> Any: ...


async def announce(publisher: ProductEventPublisher, turn_id: str, scopes: Sequence[str]) -> None:
    """Mark whole data scopes stale for every subscriber of this session."""

    try:
        await publisher.publish(
            PRODUCT_EVENT_PRODUCT_DATA_CHANGED,
            {"scopes": list(scopes)},
            turn_id=turn_id,
        )
    except Exception:  # noqa: BLE001 - 通知失败不能把已落库的变更报成工具失败
        LOGGER.warning("product_invalidation_publish_failed scopes=%s", list(scopes), exc_info=True)


__all__ = ["SCOPE_LITERATURE", "SCOPE_RESOURCES", "announce"]
