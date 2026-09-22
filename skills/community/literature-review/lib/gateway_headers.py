"""网关头注入：X-Deeprd-Conv-Message-id（Token 计量）+ X-Deeprd-Conversation-Code（Langfuse 归集）。

平台后端在发起任务时，可向 Codex 进程注入两个环境变量：
- ``DEEP_RD_SESSION_ID``（值 = conversation_code，如 FP9yTL00byNE）→ ``X-Deeprd-Conv-Message-id``：
  网关按该键聚合 token 计量。2026-06-19 实测：当前网关只读 ``X-Deeprd-Conv-Message-id``，
  旧 ``X-Deeprd-Chat-id`` 已废弃、不再被读取。
- ``DEEP_RD_CONVERSATION_CODE``（会话 code，如 FP9yTL00byNE）→ ``X-Deeprd-Conversation-Code``：
  网关据此把脚本直连的 LLM I/O 按 conv_code 上报 Langfuse，与 Codex
  任务归集到同一条 trace。

本 helper 把这两个头合进各 LLM SDK client 的 default_headers。env 缺失（网关未就绪 / 直连等
场景）时不加对应 header —— 前向兼容、零副作用，绝不改变既有调用行为。
"""
from __future__ import annotations

import os

GATEWAY_SESSION_ENV = "DEEP_RD_SESSION_ID"
GATEWAY_SESSION_HEADER = "X-Deeprd-Conv-Message-id"
GATEWAY_CONV_CODE_ENV = "DEEP_RD_CONVERSATION_CODE"
GATEWAY_CONV_CODE_HEADER = "X-Deeprd-Conversation-Code"


def build_gateway_headers(base: dict | None = None) -> dict:
    """Return a copy of *base* with the gateway metering / conv-code headers merged in.

    Reads ``DEEP_RD_SESSION_ID`` (→ ``X-Deeprd-Conv-Message-id``, token metering) and
    ``DEEP_RD_CONVERSATION_CODE`` (→ ``X-Deeprd-Conversation-Code``, Langfuse trace) from the
    environment; each present env adds its header on a copy of *base* (existing headers
    preserved). Absent env → header omitted (forward-compatible, zero side effect).

    Args:
        base: Existing default_headers to merge into (optional).

    Returns:
        A new dict with the gateway headers added when available.
    """
    headers = dict(base) if base else {}
    session_id = os.environ.get(GATEWAY_SESSION_ENV)
    if session_id:
        headers[GATEWAY_SESSION_HEADER] = session_id
    conv_code = os.environ.get(GATEWAY_CONV_CODE_ENV)
    if conv_code:
        headers[GATEWAY_CONV_CODE_HEADER] = conv_code
    return headers
