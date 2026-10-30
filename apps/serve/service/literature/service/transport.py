"""文献域外呼 HTTP 的超时策略: 两类请求, 三个相位, 全部具名常量。

「同步元数据」与「获取全文」都由多次外呼组成, 每次外呼按载荷形状归入两类之一:

- 普通数据 (JSON / BibTeX 等小响应): connect/read/total = 5/5/10 秒;
- 二进制数据流 (PDF 全文): connect/read/total = 5/5/300 秒。

相位语义沿用 httpx: ``connect`` 是单次建连 (含 TLS) 上限, ``read`` 是相邻两个
响应字节之间的空闲上限 (停滞检测, 不是下载总时长); httpx 没有总时钟, 所以
``total`` 由 ``within_budget`` 的异步取消作用域执行，并在数据块和EOF核对截止点。
同步下载入口保留既有活动线程，内部使用异步网络；不以线程计时器伪装请求终止。
重试若将来加入, 预算必须落在 total 之内, 不能放大实际耗时。
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable

import httpx

PLAIN_CONNECT_TIMEOUT_SECONDS = 5.0
PLAIN_READ_TIMEOUT_SECONDS = 5.0
PLAIN_TOTAL_TIMEOUT_SECONDS = 10.0

STREAM_CONNECT_TIMEOUT_SECONDS = 5.0
STREAM_READ_TIMEOUT_SECONDS = 5.0
STREAM_TOTAL_TIMEOUT_SECONDS = 300.0
DEADLINE_EXTENSION = "literature_deadline"
TIMEOUT_EXTENSION = "timeout"


def check_deadline(deadline_at: float) -> None:
    if expired(deadline_at):
        raise httpx.TimeoutException("literature total budget exhausted")


async def within_budget[Result](operation: Awaitable[Result], deadline_at: float) -> Result:
    try:
        async with asyncio.timeout(max(0.0, deadline_at - time.monotonic())):
            result = await operation
            check_deadline(deadline_at)
            return result
    except TimeoutError as error:
        raise httpx.TimeoutException("literature total budget exhausted") from error


async def apply_request_budget(request: httpx.Request) -> None:
    deadline_at = request.extensions.get(DEADLINE_EXTENSION)
    if deadline_at is None:
        return
    remaining = float(deadline_at) - time.monotonic()
    if remaining <= 0:
        raise httpx.TimeoutException("literature total budget exhausted", request=request)
    configured = request.extensions.get(TIMEOUT_EXTENSION, {})
    request.extensions[TIMEOUT_EXTENSION] = {
        phase: min(value, remaining) if value is not None else remaining
        for phase, value in configured.items()
    }


def plain_data_timeout() -> httpx.Timeout:
    """普通数据请求的相位超时 (total 由调用方外层执行)。"""

    return httpx.Timeout(PLAIN_READ_TIMEOUT_SECONDS, connect=PLAIN_CONNECT_TIMEOUT_SECONDS)


def binary_stream_timeout() -> httpx.Timeout:
    """二进制数据流请求的相位超时 (total 由调用方外层执行)。"""

    return httpx.Timeout(STREAM_READ_TIMEOUT_SECONDS, connect=STREAM_CONNECT_TIMEOUT_SECONDS)


def deadline(total_seconds: float) -> float:
    """单次请求的 total 截止点 (monotonic), 供 sync 腿在读取循环里核对。"""

    return time.monotonic() + total_seconds


def expired(deadline_at: float) -> bool:
    return time.monotonic() >= deadline_at


__all__ = [
    "PLAIN_CONNECT_TIMEOUT_SECONDS",
    "PLAIN_READ_TIMEOUT_SECONDS",
    "PLAIN_TOTAL_TIMEOUT_SECONDS",
    "STREAM_CONNECT_TIMEOUT_SECONDS",
    "STREAM_READ_TIMEOUT_SECONDS",
    "STREAM_TOTAL_TIMEOUT_SECONDS",
    "DEADLINE_EXTENSION",
    "apply_request_budget",
    "within_budget",
    "binary_stream_timeout",
    "deadline",
    "check_deadline",
    "expired",
    "plain_data_timeout",
]
