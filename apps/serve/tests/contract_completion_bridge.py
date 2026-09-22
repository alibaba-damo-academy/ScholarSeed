"""Contract coverage for Responses-to-Chat-Completions request fitting."""

from __future__ import annotations

import asyncio
import base64
import errno as errno_module
import json
import logging
import os
import random
from io import BytesIO
from typing import Callable
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from scholarseed_runtime.contract.model import ModelThinking, ModelWireProtocol
from service.chat.service.completions import (
    BRIDGE_REGISTRATION_TTL_SECONDS,
    CHAT_COMPLETIONS_REQUEST_TARGET_BYTES,
    INLINE_JPEG_DATA_PREFIX,
    MODEL_BRIDGE_CREDENTIAL_REQUIRED,
    MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED,
    MODEL_BRIDGE_ROUTE_PREFIX,
    CompletionBridge,
    _fit_inline_images,
    _json_size,
    _redacted_endpoint,
    _responses_usage,
    chat_stream_to_responses,
    mount_completion_bridge,
    responses_to_chat_request,
)
from service.chat.service.models import _codex_provider
from service.identity.api.routes import register_auth
from service.identity.service.account_token import (
    CONV_MESSAGE_ID_HEADER,
    CONV_TURN_ID_HEADER,
    AccountTokenHolder,
)
from service.identity.service.auth import AuthService
from service.inference.source import SOURCE_UNAVAILABLE
from service.settings.catalog import (
    DEEPRD_GATEWAY_BASE_URL,
    apply_model_to_config,
    resolve_model_choice,
)

PASS = 0
FAIL = 0
IMAGE_WIDTH = 700
IMAGE_HEIGHT = 700
RANDOM_SEED = 7
PROTECTED_ROUTE = "/api/protected"
CHAT_ENDPOINT = "https://gateway.example/v1/chat/completions"
RESPONSES_ENDPOINT = "https://gateway.example/v1/responses"


def forward_contract(
    payload: dict,
    body: bytes,
    *,
    status: int = 200,
    responses_endpoint: str = RESPONSES_ENDPOINT,
    reasoning_effort: str | None = None,
    reasoning_options: list[dict] | None = None,
    thinking: ModelThinking | None = None,
    wire_protocol: ModelWireProtocol | None = None,
    turn_id_provider: Callable[[str], str] | None = None,
    source_endpoints: tuple[str, ...] = (),
    send_exc: BaseException | None = None,
    source_text: str = "用户原文",
    api_key: str = "contract-key",
    token_provider: Callable[[str], str] | None = None,
    owner_id: str = "",
    upstream_responses: tuple[tuple[int, bytes, dict[str, str]], ...] = (),
):
    """Exercise the public bridge route against a deterministic upstream transport."""
    captured: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if send_exc is not None:
            raise send_exc
        if upstream_responses:
            response_status, response_body, response_headers = upstream_responses[
                min(len(captured) - 1, len(upstream_responses) - 1)
            ]
            return httpx.Response(
                response_status,
                content=response_body,
                headers=response_headers,
            )
        return httpx.Response(status, content=body)

    app = FastAPI()
    bridge = CompletionBridge(
        "http://127.0.0.1:8770",
        source_endpoints=source_endpoints,
        source_text=lambda _session, _turn: source_text,
    )
    registration = bridge.register(
        endpoint=CHAT_ENDPOINT,
        responses_endpoint=responses_endpoint,
        api_key=api_key,
        model_routes={"alias": "selected-model"},
        session_id="search-contract",
        headers={CONV_MESSAGE_ID_HEADER: "search-contract"},
        reasoning_effort=reasoning_effort,
        reasoning_options=reasoning_options,
        thinking=thinking,
        # 夹具模拟的是 OpenAI 兼容端点；思考参数按家族公开字段名出站。
        provider="openai",
        wire_protocol=wire_protocol,
        turn_id_provider=turn_id_provider,
        token_provider=token_provider,
        owner_id=owner_id,
    )
    mount_completion_bridge(app, bridge)
    client_type = httpx.AsyncClient
    transport = httpx.MockTransport(upstream)
    with patch(
        "service.chat.service.completions.httpx.AsyncClient",
        side_effect=lambda **kwargs: client_type(transport=transport, **kwargs),
    ):
        with TestClient(app) as client:
            response = client.post(
                f"{MODEL_BRIDGE_ROUTE_PREFIX}{registration.bridge_id}/v1/responses",
                json=payload,
            )
    return response, captured


def test_native_tools_preserve_request_and_response() -> None:
    payload = {
        "model": "alias",
        "stream": True,
        "input": [{"role": "user", "content": "Search public sources."}],
        "tools": [
            {"type": "web_search", "external_web_access": True},
            {
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {"type": "function", "name": "inspect", "parameters": {"type": "object"}}
                ],
            },
        ],
        "include": ["web_search_call.action.sources"],
        "reasoning": {"effort": "low"},
    }
    body = (
        b"event: response.output_item.done\n"
        b'data: {"type":"response.output_item.done","item":'
        b'{"type":"web_search_call","id":"search-call","status":"completed",'
        b'"action":{"type":"search","query":"public sources"}}}\n\n'
    )
    response, captured = forward_contract(payload, body)
    check(
        "native tools use configured Responses endpoint",
        len(captured) == 1 and str(captured[0].url) == RESPONSES_ENDPOINT,
    )
    check(
        "native request retains all fields and model routing",
        json.loads(captured[0].content) == {**payload, "model": "selected-model"},
    )
    check(
        "native search events pass through without conversion",
        response.status_code == 200 and response.content == body,
    )
    check(
        "native requests preserve authentication and metering",
        captured[0].headers["Authorization"] == "Bearer contract-key"
        and captured[0].headers[CONV_MESSAGE_ID_HEADER] == "search-contract",
    )
    check("request routing does not mutate the caller payload", payload["model"] == "alias")


def test_native_errors_and_nonstream_responses_are_preserved() -> None:
    payload = {
        "model": "alias",
        "stream": False,
        "input": "Search",
        "tools": [{"type": "web_search"}],
    }
    success = b'{"id":"response-1","output":[{"type":"web_search_call","status":"completed"}]}'
    response, _ = forward_contract(payload, success)
    check("nonstream native output remains a Responses object", response.content == success)
    error = b'{"error":{"code":"insufficient_quota","message":"quota exhausted"}}'
    response, captured = forward_contract(payload, error, status=429)
    check(
        "native upstream error is preserved without retry or fallback",
        response.status_code == 429 and response.content == error and len(captured) == 1,
    )
    response, captured = forward_contract(payload, success, responses_endpoint="")
    check(
        "unconfigured native transport fails before a lossy model call",
        response.status_code == 400
        and response.json()["error"]["code"] == MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED
        and not captured,
    )


def test_internal_unstructured_rate_limit_retries_before_returning() -> None:
    payload = {
        "model": "alias",
        "stream": False,
        "input": "Search",
        "tools": [{"type": "web_search"}],
    }
    success = b'{"id":"response-1","output":[]}'

    async def no_delay(_seconds: float) -> None:
        return None

    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        response, captured = forward_contract(
            payload,
            success,
            token_provider=lambda _owner: "account.token",
            owner_id="account-owner",
            upstream_responses=(
                (429, b'{"detail":"temporarily limited"}', {"Retry-After": "0"}),
                (429, b'{"detail":"temporarily limited"}', {"Retry-After": "0"}),
                (200, success, {}),
            ),
        )
    check(
        "internal unstructured 429 is retried inside one bridge call",
        response.status_code == 200 and response.content == success and len(captured) == 3,
        f"status={response.status_code} calls={len(captured)}",
    )

    product_error = b'{"detail":{"error":"credit_balance_exhausted"}}'
    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        response, captured = forward_contract(
            payload,
            success,
            token_provider=lambda _owner: "account.token",
            owner_id="account-owner",
            upstream_responses=(
                (429, product_error, {}),
                (200, success, {}),
            ),
        )
    check(
        "registered product 429 remains terminal without bridge retry",
        response.status_code == 429
        and response.json()["error"]["code"] == "credit_balance_exhausted"
        and len(captured) == 1,
        f"status={response.status_code} calls={len(captured)} body={response.text}",
    )


def test_transport_failure_is_attributable() -> None:
    payload = {
        "model": "alias",
        "stream": True,
        "input": [{"role": "user", "content": "Research airline capacity."}],
        "tools": [{"type": "web_search"}],
    }
    code = errno_module.ECONNRESET
    text = os.strerror(code)
    sever = httpx.ReadError("")
    sever.__cause__ = ConnectionResetError(code, text)
    records: list[logging.LogRecord] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    bridge_logger = logging.getLogger("service.chat.service.completions")
    handler = _Capture()
    previous_level = bridge_logger.level
    bridge_logger.setLevel(logging.WARNING)
    bridge_logger.addHandler(handler)
    try:
        response, captured = forward_contract(payload, b"", send_exc=sever)
    finally:
        bridge_logger.removeHandler(handler)
        bridge_logger.setLevel(previous_level)

    failed = [
        record.getMessage()
        for record in records
        if record.getMessage().startswith("model_bridge_upstream_transport_failed")
    ]
    message = failed[0] if failed else ""
    check(
        "transport sever still returns 502 with no bridge retry",
        response.status_code == 502 and len(captured) == 1,
        str(response.status_code),
    )
    check("transport sever is logged exactly once", len(failed) == 1, str(len(failed)))
    check(
        "log names the upstream endpoint",
        f"endpoint={RESPONSES_ENDPOINT}" in message,
        message,
    )
    check(
        "log surfaces the errno that the empty detail hid",
        f"errno={code}" in message and "errno_name=ECONNRESET" in message and text in message,
        message,
    )
    check(
        "log surfaces the exception chain",
        "cause_chain=ReadError>ConnectionResetError" in message,
        message,
    )
    check("log records the first-byte wait", "elapsed_ms=" in message, message)
    check(
        "log records request scale for attribution",
        "request_bytes=" in message and "request_bytes=0" not in message,
        message,
    )
    check("log records the native tool context", "web_search" in message, message)
    check(
        "endpoint redaction drops userinfo and query",
        _redacted_endpoint("https://user:secret@host.example/v1/responses?key=abc")
        == "https://host.example/v1/responses",
    )


def test_native_protocol_rejection_is_independent_of_effort() -> None:
    payload = {"model": "alias", "input": "Hello", "tools": [{"type": "web_search"}]}
    for effort in ("", "low"):
        with patch("service.chat.service.completions.logger.warning") as warning:
            response, requests = forward_contract(
                payload,
                b"{}",
                reasoning_effort=effort,
                wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
            )
        check(
            f"native protocol rejection is local at effort {effort or 'default'}",
            response.status_code == 400
            and response.json()["error"]["code"] == MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED
            and not requests,
        )
        check(
            "protocol diagnostic includes safe session, tool types and effort only",
            warning.call_args.args[1:]
            == (
                "search-contract",
                "chat_completions",
                ["web_search"],
                effort or "default",
                MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED,
            ),
        )


def test_function_only_calls_keep_chat_conversion() -> None:
    payload = {
        "model": "alias",
        "stream": False,
        "input": "Inspect",
        "tools": [{"type": "function", "name": "inspect", "parameters": {"type": "object"}}],
    }
    body = b'{"id":"chat-1","choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}'
    response, captured = forward_contract(payload, body)
    forwarded = json.loads(captured[0].content)
    check(
        "function-only requests keep Chat Completions endpoint",
        str(captured[0].url) == CHAT_ENDPOINT,
    )
    check(
        "function-only tools retain Chat Completions schema",
        forwarded["tools"][0]["function"]["name"] == "inspect",
    )
    check(
        "Chat response is still translated into Responses output",
        response.json()["output"][0]["content"][0]["text"] == "OK",
    )


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def image_data_url() -> str:
    pixels = random.Random(RANDOM_SEED).randbytes(IMAGE_WIDTH * IMAGE_HEIGHT * 3)
    image = Image.frombytes("RGB", (IMAGE_WIDTH, IMAGE_HEIGHT), pixels)
    output = BytesIO()
    image.save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


def image_request(url: str) -> dict:
    return {
        "model": "vision-model",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Inspect the screenshot."},
                    {"type": "image_url", "image_url": {"url": url}},
                ],
            }
        ],
        "stream": True,
    }


def converted_stream_events(content: str) -> list[dict]:
    return converted_stream_chunk_events([content])


def converted_stream_chunk_events(contents: list[str]) -> list[dict]:
    chunks = [
        "data: "
        + json.dumps(
            {
                "id": "chat-response",
                "choices": [
                    {
                        "delta": {"content": content},
                        "finish_reason": "stop" if index == len(contents) - 1 else None,
                    }
                ],
            }
        )
        for index, content in enumerate(contents)
    ]
    upstream = httpx.Response(
        200,
        content=("\n\n".join(chunks) + "\n\ndata: [DONE]\n\n").encode(),
    )

    async def _collect() -> list[dict]:
        rows = []
        async for chunk in chat_stream_to_responses(upstream):
            data = next(
                (
                    line.removeprefix("data:").strip()
                    for line in chunk.decode().splitlines()
                    if line.startswith("data:")
                ),
                "",
            )
            if data:
                rows.append(json.loads(data))
        return rows

    return asyncio.run(_collect())


def test_streamed_provider_error_becomes_failed_response() -> None:
    events = converted_stream_events(
        json.dumps(
            {
                "error": {
                    "message": "You exceeded your current quota.",
                    "type": "insufficient_quota",
                    "code": "insufficient_quota",
                },
                "request_id": "request-1",
            }
        )
    )
    event_types = [row.get("type") for row in events]
    failed = next((row for row in events if row.get("type") == "response.failed"), {})
    check(
        "provider error is not emitted as assistant text",
        "response.output_text.delta" not in event_types
        and "response.output_item.done" not in event_types,
        str(event_types),
    )
    check(
        "provider error terminates the Responses stream as failed",
        failed.get("response", {}).get("error", {}).get("code") == "insufficient_quota"
        and "response.completed" not in event_types,
        str(events),
    )


def test_json_answer_remains_a_successful_answer() -> None:
    content = json.dumps({"result": "ok"})
    events = converted_stream_events(content)
    deltas = [row.get("delta") for row in events if row.get("type") == "response.output_text.delta"]
    check("ordinary JSON is still emitted as assistant text", deltas == [content], str(events))
    check(
        "ordinary JSON still completes",
        any(row.get("type") == "response.completed" for row in events),
        str(events),
    )


def test_normal_stream_keeps_deltas_and_complete_message() -> None:
    events = converted_stream_chunk_events(["normal ", "answer"])
    deltas = [row.get("delta") for row in events if row.get("type") == "response.output_text.delta"]
    message = next(
        row["item"]
        for row in events
        if row.get("type") == "response.output_item.done"
        and row.get("item", {}).get("type") == "message"
    )
    check("normal prose keeps streamed deltas", deltas == ["normal ", "answer"], str(events))
    check(
        "normal prose keeps its complete message event",
        message["content"][0]["text"] == "normal answer",
        str(events),
    )


def test_large_inline_image_is_fitted() -> None:
    request = image_request(image_data_url())
    before = _json_size(request)
    compacted = _fit_inline_images(request, CHAT_COMPLETIONS_REQUEST_TARGET_BYTES)
    after = _json_size(request)
    url = request["messages"][0]["content"][1]["image_url"]["url"]
    encoded = url.removeprefix(INLINE_JPEG_DATA_PREFIX)
    with Image.open(BytesIO(base64.b64decode(encoded))) as compressed:
        decoded_size = compressed.size
        decoded_format = compressed.format
    check("fixture exceeds upstream request limit", before > 1_000_000, str(before))
    check("one inline image is compacted", compacted == 1, str(compacted))
    check(
        "request fits guarded target",
        after <= CHAT_COMPLETIONS_REQUEST_TARGET_BYTES,
        str(after),
    )
    check("image remains a valid JPEG", decoded_format == "JPEG", str(decoded_format))
    check(
        "image dimensions remain useful",
        decoded_size == (IMAGE_WIDTH, IMAGE_HEIGHT),
        str(decoded_size),
    )


def test_small_inline_image_is_preserved() -> None:
    url = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nsmall-contract").decode(
        "ascii"
    )
    request = image_request(url)
    compacted = _fit_inline_images(request, CHAT_COMPLETIONS_REQUEST_TARGET_BYTES)
    check("small inline image is preserved", compacted == 0, str(compacted))
    check(
        "small inline image bytes are unchanged",
        request["messages"][0]["content"][1]["image_url"]["url"] == url,
    )


def test_text_only_oversize_is_not_silently_truncated() -> None:
    request = {
        "model": "text-model",
        "messages": [{"role": "user", "content": "x" * 1_000_001}],
    }
    try:
        _fit_inline_images(request, CHAT_COMPLETIONS_REQUEST_TARGET_BYTES)
    except ValueError:
        check("text-only oversize raises an explicit fitting failure", True)
    else:
        check("text-only oversize raises an explicit fitting failure", False, "no exception")


def test_tool_image_output_becomes_multimodal_chat_input() -> None:
    url = image_data_url()
    request = responses_to_chat_request(
        {
            "model": "vision-model",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call-image",
                    "name": "view_image",
                    "arguments": "{}",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-image",
                    "output": json.dumps(
                        [
                            {"type": "input_text", "text": "Screenshot from the tool."},
                            {"type": "input_image", "image_url": url},
                        ]
                    ),
                },
            ],
        }
    )
    roles = [message["role"] for message in request["messages"]]
    tool_content = request["messages"][1]["content"]
    image_content = request["messages"][2]["content"]
    check("tool call ordering remains valid", roles == ["assistant", "tool", "user"], str(roles))
    check("tool text remains on the tool message", tool_content == "Screenshot from the tool.")
    check(
        "tool image becomes a real chat image part",
        image_content[1]["image_url"]["url"] == url,
    )
    compacted = _fit_inline_images(request, CHAT_COMPLETIONS_REQUEST_TARGET_BYTES)
    check("converted tool image follows the request budget", compacted == 1)
    check(
        "converted tool image request fits the target",
        _json_size(request) <= CHAT_COMPLETIONS_REQUEST_TARGET_BYTES,
        str(_json_size(request)),
    )


def test_model_bridge_owns_authentication() -> None:
    app = FastAPI()
    bridge = CompletionBridge("http://127.0.0.1:8770")
    mount_completion_bridge(app, bridge)

    @app.get(PROTECTED_ROUTE)
    async def protected() -> dict[str, bool]:
        return {"ok": True}

    register_auth(
        app,
        enabled=True,
        service=AuthService(),
        independently_authenticated_prefixes=(MODEL_BRIDGE_ROUTE_PREFIX,),
    )
    client = TestClient(app)
    bridge_response = client.post(
        f"{MODEL_BRIDGE_ROUTE_PREFIX}unknown/v1/responses",
        json={},
    )
    protected_response = client.get(PROTECTED_ROUTE)
    check(
        "model bridge reaches its capability check with user auth enabled",
        bridge_response.status_code == 404
        and bridge_response.json() == {"error": {"message": "model bridge not found"}},
        f"{bridge_response.status_code}: {bridge_response.text}",
    )
    check(
        "ordinary product API still requires user authentication",
        protected_response.status_code == 401,
        f"{protected_response.status_code}: {protected_response.text}",
    )


def _bridge_with_headers(holder: AccountTokenHolder, *, user_id: str, session_id: str):
    """按产品主链路的形状注册一个 upstream（会话头快照 + token 调用时现取）。"""

    bridge = CompletionBridge("http://127.0.0.1:8123")
    registration = bridge.register(
        endpoint="https://gateway.example/v1/chat/completions",
        api_key="dgw_test",
        headers={CONV_MESSAGE_ID_HEADER: session_id},
        token_provider=holder.current,
        owner_id=user_id,
        session_id=session_id,
    )
    return bridge, bridge._upstreams[registration.bridge_id]


def test_user_token_takes_the_authorization_slot() -> None:
    print("用户 JWT 直接站 Authorization 位")
    holder = AccountTokenHolder()
    holder.remember("u-1", "header.payload.signature")
    native_bridge = CompletionBridge("http://127.0.0.1:8123")
    gateway = {"base_url": DEEPRD_GATEWAY_BASE_URL, "provider": "openai"}
    config = apply_model_to_config(gateway, resolve_model_choice("qwen3.8-max", gateway))
    _codex_provider(config, native_bridge, account_tokens=holder, user_id="u-1")
    native_upstream = next(iter(native_bridge._upstreams.values()))
    check(
        "内置模型明确使用 Responses", native_upstream.wire_protocol == ModelWireProtocol.RESPONSES
    )
    holder.remember("u-1", "header.refreshed.signature")
    check(
        "Responses 凭据在调用时取当前账号", native_upstream.bearer() == "header.refreshed.signature"
    )
    holder.remember("u-1", "header.payload.signature")
    _bridge, upstream = _bridge_with_headers(holder, user_id="u-1", session_id="sess-42")
    # 鉴权与归属一步完成 —— 不再需要另一个计量头。
    check(
        "Authorization 用的是用户 token 而非 dgw_ key",
        upstream.bearer() == "header.payload.signature",
        upstream.bearer(),
    )
    check(
        "chat_id 头等于 product session_id",
        upstream.call_headers().get(CONV_MESSAGE_ID_HEADER) == "sess-42",
        str(upstream.call_headers()),
    )
    check(
        "不再带任何归属头（已删除）",
        not any("account-token" in k.lower() for k in upstream.call_headers()),
        str(upstream.call_headers()),
    )


def test_model_routes_are_exact_and_session_scoped() -> None:
    print("辅助模型只按当前会话的显式路由改写")
    bridge = CompletionBridge("http://127.0.0.1:8123")
    registration = bridge.register(
        endpoint="https://gateway.example/v1/chat/completions",
        api_key="dgw_test",
        model_routes={"review-model": "selected-model"},
    )
    upstream = bridge._upstreams[registration.bridge_id]
    check("命中的辅助模型使用会话模型", upstream.route_model("review-model") == "selected-model")
    check("普通模型保持原值", upstream.route_model("ordinary-model") == "ordinary-model")


def test_token_is_resolved_per_call_not_snapshotted() -> None:
    print("token 调用时动态取（非注册时快照）")
    holder = AccountTokenHolder()
    holder.remember("u-1", "old.token.value")
    _bridge, upstream = _bridge_with_headers(holder, user_id="u-1", session_id="sess-1")
    check("初始取到旧值", upstream.bearer() == "old.token.value")
    # 静默续期：register 已经过去了，只有动态取能拿到新值。网关鉴权腿必须校 exp，
    # 快照实现会让长会话后期整批 401。
    holder.remember("u-1", "fresh.token.value")
    check("续期后取到新值", upstream.bearer() == "fresh.token.value", upstream.bearer())


def test_turn_header_is_resolved_per_call_not_snapshotted() -> None:
    print("轮头每次调用现取，且与会话头并存（proposal 70 §5.9）")
    turns = {"sess-turn": ""}

    def resolve_turn(session_id: str) -> str:
        return turns[str(session_id)]

    bridge = CompletionBridge("http://127.0.0.1:8123")
    registration = bridge.register(
        endpoint="https://gateway.example/v1/chat/completions",
        api_key="dgw_test",
        headers={CONV_MESSAGE_ID_HEADER: "sess-turn"},
        session_id="sess-turn",
        turn_id_provider=resolve_turn,
    )
    upstream = bridge._upstreams[registration.bridge_id]
    check(
        "还没准入轮时不发轮头（缺省空串 = 不归并，同会话头语义）",
        CONV_TURN_ID_HEADER not in upstream.call_headers(),
        str(upstream.call_headers()),
    )
    turns["sess-turn"] = "turn-a"
    first = upstream.call_headers()
    turns["sess-turn"] = "turn-b"
    second = upstream.call_headers()
    check(
        "同一条注册项跨轮换值：轮 id 不是注册期快照",
        first.get(CONV_TURN_ID_HEADER) == "turn-a" and second.get(CONV_TURN_ID_HEADER) == "turn-b",
        f"{first} -> {second}",
    )
    check(
        "会话头仍是 session 粒度，没有被轮头替换",
        second.get(CONV_MESSAGE_ID_HEADER) == "sess-turn"
        and CONV_TURN_ID_HEADER != CONV_MESSAGE_ID_HEADER,
        str(second),
    )

    def _boom(_session_id: str) -> str:
        raise RuntimeError("turn resolver exploded")

    upstream.turn_id_provider = _boom
    check(
        "轮 id 解析失败也不能打断模型调用",
        CONV_TURN_ID_HEADER not in upstream.call_headers()
        and upstream.call_headers().get(CONV_MESSAGE_ID_HEADER) == "sess-turn",
        str(upstream.call_headers()),
    )


def test_turn_header_reaches_the_outbound_request() -> None:
    print("轮头真的落到出站请求上")

    def resolve_turn(session_id: str) -> str:
        return f"turn-of-{session_id}"

    payload = {"model": "alias", "input": "hello", "stream": False}
    response, captured = forward_contract(
        payload,
        b'{"choices": [{"message": {"content": "ok"}}]}',
        turn_id_provider=resolve_turn,
    )
    check(
        "出站请求同时带会话头与轮头",
        response.status_code == 200
        and len(captured) == 1
        and captured[0].headers[CONV_MESSAGE_ID_HEADER] == "search-contract"
        and captured[0].headers[CONV_TURN_ID_HEADER] == "turn-of-search-contract",
        str(dict(captured[0].headers)) if captured else "no upstream request",
    )


def test_codex_provider_registers_the_turn_hook() -> None:
    print("codex 主链路注册处注入轮 id 钩子")
    holder = AccountTokenHolder()
    holder.remember("u-1", "header.payload.signature")
    bridge = CompletionBridge("http://127.0.0.1:8123")
    gateway = {"base_url": DEEPRD_GATEWAY_BASE_URL, "provider": "openai"}
    config = apply_model_to_config(gateway, resolve_model_choice("qwen3.8-max", gateway))

    def resolve_turn(session_id: str) -> str:
        return f"turn-of-{session_id}"

    _codex_provider(
        config,
        bridge,
        session_id="sess-77",
        user_id="u-1",
        account_tokens=holder,
        turn_id_provider=resolve_turn,
    )
    headers = next(iter(bridge._upstreams.values())).call_headers()
    check(
        "会话头 = product session_id，轮头 = 当次请求所属轮",
        headers.get(CONV_MESSAGE_ID_HEADER) == "sess-77"
        and headers.get(CONV_TURN_ID_HEADER) == "turn-of-sess-77",
        str(headers),
    )


def test_switching_accounts_moves_a_warm_session_to_the_new_token() -> None:
    print("切号后热会话的出站凭据跟到新账号")
    holder = AccountTokenHolder()
    holder.remember("u-old", "old.account.token")
    holder.remember("u-new", "new.account.token")
    bridge, upstream = _bridge_with_headers(holder, user_id="u-old", session_id="sess-warm")
    other = bridge.register(
        endpoint="https://gateway.example/v1/chat/completions",
        api_key="dgw_test",
        token_provider=holder.current,
        owner_id="u-old",
        session_id="sess-other",
    )
    check("切号前用旧账号的 token", upstream.bearer() == "old.account.token", upstream.bearer())
    # 会话在内存里活过一次切号：身份钉死的实现会一直取已登出账号的槽位，网关回
    # 401 invalid user token，且重开 bridge_id 会把跑着的 Codex 子进程留在旧 URL 上。
    check("改一条注册项", bridge.rebind_owner("sess-warm", "u-new") == 1)
    check("切号后用新账号的 token", upstream.bearer() == "new.account.token", upstream.bearer())
    check(
        "原地改写：不新增也不摘注册项（否则跑着的子进程会留在旧 URL 上）",
        bridge.registration_count() == 2,
        str(bridge.registration_count()),
    )
    check(
        "没指名的会话不受影响",
        bridge._upstreams[other.bridge_id].bearer() == "old.account.token",
    )
    holder.forget("u-old")
    check("旧账号槽位摘掉后新账号照常", upstream.bearer() == "new.account.token")


def test_anonymous_session_falls_back_to_caller_key() -> None:
    print("未登录时回退到 dgw_ 调用方 key")
    holder = AccountTokenHolder()
    _bridge, upstream = _bridge_with_headers(holder, user_id="nobody", session_id="sess-9")
    # 本地/dev 运行（identity 关闭）仍需能调模型，网关侧记 anonymous。
    check("回退到 dgw_ key", upstream.bearer() == "dgw_test", upstream.bearer())
    check(
        "会话头仍在",
        upstream.call_headers().get(CONV_MESSAGE_ID_HEADER) == "sess-9",
        str(upstream.call_headers()),
    )

    def _boom(_owner: str) -> str:
        raise RuntimeError("holder exploded")

    upstream.token_provider = _boom
    check("token_provider 抛异常也不能打断模型调用", upstream.bearer() == "dgw_test")


def test_local_credentials_are_not_stored_as_account_tokens() -> None:
    print("本地不透明 token 不当作账号 JWT 存")
    holder = AccountTokenHolder()
    holder.remember("u-1", "opaque-local-token")
    # 存了只会让网关把每次调用记成 unverifiable，反而污染「未归属成本」的归因。
    check("不存非 JWT 凭据", holder.current("u-1") == "", holder.current("u-1"))
    holder.remember("u-1", "a.b.c")
    check("JWT 形状仍然存", holder.current("u-1") == "a.b.c")
    holder.forget("u-1")
    check("登出后不再持有", holder.current("u-1") == "")


def test_registrations_are_bounded() -> None:
    print("注册表不无界增长，过期/已关闭的 bridge_id 不再可用")
    bridge = CompletionBridge("http://127.0.0.1:8123")
    ids = [
        bridge.register(
            endpoint="https://gateway.example/v1/chat/completions",
            api_key="dgw_test",
            session_id=f"sess-{index}",
        ).bridge_id
        for index in range(5)
    ]
    check("五次注册均在表内", bridge.registration_count() == 5)
    # 会话关闭即摘：仅靠 TTL 惰性淘汰会让已关闭会话的凭据再可用几小时。
    check("关闭一个会话摘掉它的注册", bridge.release("sess-0") == 1)
    check("摘后只剩四条", bridge.registration_count() == 4)
    for upstream in bridge._upstreams.values():
        upstream.last_used_at -= BRIDGE_REGISTRATION_TTL_SECONDS + 1
    bridge.register(
        endpoint="https://gateway.example/v1/chat/completions",
        api_key="dgw_test",
        session_id="sess-fresh",
    )
    check("过期条目被清（只剩新注册的）", bridge.registration_count() == 1)

    async def _gone() -> int:
        response = await bridge.forward(ids[0], {"input": []})
        return response.status_code

    check("已摘除的 bridge_id 不再可调用", asyncio.run(_gone()) == 404)


def test_reasoning_tokens_are_not_erased() -> None:
    print("reasoning token 不再被抹成 None")
    # 实测：向 qwen3.7-max 发一句「Reply with the single word OK」，prompt 只有 17，
    # completion 却是 308、其中 reasoning 占 303。抹掉它 = Codex 上下文估算与 UI 都失真。
    usage = _responses_usage(
        {
            "prompt_tokens": 17,
            "completion_tokens": 308,
            "completion_tokens_details": {"reasoning_tokens": 303},
        }
    )
    check(
        "chat 命名下取到 reasoning",
        usage["output_tokens_details"] == {"reasoning_tokens": 303},
        str(usage),
    )
    responses_shape = _responses_usage(
        {
            "input_tokens": 99,
            "output_tokens": 30,
            "output_tokens_details": {"reasoning_tokens": 24},
        }
    )
    check(
        "Responses 命名下也取到",
        responses_shape["output_tokens_details"] == {"reasoning_tokens": 24},
        str(responses_shape),
    )
    check(
        "无 reasoning 时为 0 而不是 None",
        _responses_usage({"prompt_tokens": 5, "completion_tokens": 5})["output_tokens_details"]
        == {"reasoning_tokens": 0},
    )


def main() -> int:
    source_payload = {"model": "alias", "input": "系统上下文和用户原文", "stream": False}
    for destinations in ((), ("https://gateway.example/v1",)):
        response, requests = forward_contract(
            source_payload,
            b'{"choices":[{"message":{"content":"ok"}}]}',
            source_endpoints=destinations,
            turn_id_provider=lambda _session: "turn-source",
        )
        sent = json.loads(requests[0].content)
        check(
            "source metadata follows destination",
            ("scholarseed_content_source" in sent) == bool(destinations),
        )
        if destinations:
            check(
                "source contains only original user text",
                sent["scholarseed_content_source"]["text"] == "用户原文",
            )
        check(
            "source leaves prompt unchanged",
            sent["messages"][0]["content"] == source_payload["input"],
        )
    empty_source_response, empty_source_requests = forward_contract(
        source_payload,
        b"{}",
        source_endpoints=("https://gateway.example/v1",),
        source_text="",
        turn_id_provider=lambda _session: "turn-source",
    )
    check("empty source rejected locally", empty_source_response.status_code == 400)
    check(
        "empty source reports unavailable",
        empty_source_response.json()["error"]["code"] == SOURCE_UNAVAILABLE,
    )
    check("empty source never reaches gateway", not empty_source_requests)
    missing_credential_response, missing_credential_requests = forward_contract(
        source_payload,
        b"{}",
        api_key="",
        token_provider=lambda _owner: "",
        owner_id="account-user",
    )
    check(
        "missing dynamic credential is rejected locally",
        missing_credential_response.status_code == 401,
    )
    check(
        "missing dynamic credential has a stable safe code",
        missing_credential_response.json()["error"]["code"] == MODEL_BRIDGE_CREDENTIAL_REQUIRED,
    )
    check("missing dynamic credential never reaches upstream", not missing_credential_requests)
    print("completion bridge request fitting contract")
    reasoning_input = {
        "model": "alias",
        "input": "hello",
        "stream": False,
        "reasoning": {"effort": "medium"},
    }
    check(
        "Responses effort survives Chat conversion",
        responses_to_chat_request(reasoning_input)["reasoning_effort"] == "medium",
    )
    declared_options = [
        {"kind": "effort", "values": ["low", "medium", "high"], "default": "medium"}
    ]
    for selected, expected in (("high", "high"), ("", "medium"), ("ultra", "medium")):
        _, requests = forward_contract(
            reasoning_input,
            b'{"choices": [{"message": {"content": "ok"}}]}',
            reasoning_effort=selected,
            reasoning_options=declared_options,
        )
        sent = json.loads(requests[0].content)
        check(
            f"effort policy reaches upstream as declared: {selected or 'default'}",
            (
                sent.get("reasoning_effort") == expected
                if expected
                else "reasoning_effort" not in sent
            ),
            str(sent),
        )
    check(
        "reasoning policy leaves caller payload unchanged",
        reasoning_input["reasoning"]["effort"] == "medium",
    )
    toggle_options = [
        {"kind": "toggle", "wire": {"chat_completions": "enable_thinking"}},
        {"kind": "budget", "wire": {"chat_completions": "thinking_budget"}},
    ]
    _, requests = forward_contract(
        reasoning_input,
        b'{"choices": [{"message": {"content": "ok"}}]}',
        reasoning_effort=None,
        reasoning_options=toggle_options,
        thinking=ModelThinking(enabled=False),
    )
    sent = json.loads(requests[0].content)
    check(
        "a declared toggle form is sent under its declared name",
        sent.get("enable_thinking") is False and "reasoning_effort" not in sent,
        str(sent),
    )
    _, requests = forward_contract(
        reasoning_input,
        b'{"choices": [{"message": {"content": "ok"}}]}',
        reasoning_effort=None,
        reasoning_options=toggle_options,
        thinking=ModelThinking(budget=4000),
    )
    sent = json.loads(requests[0].content)
    check(
        "an unresolved budget range sends no invented number",
        "thinking_budget" not in sent and "reasoning_effort" not in sent,
        str(sent),
    )
    bounded = [{"kind": "budget", "min": 100, "max": 200, "wire": {"chat_completions": "x_budget"}}]
    _, requests = forward_contract(
        reasoning_input,
        b'{"choices": [{"message": {"content": "ok"}}]}',
        reasoning_effort=None,
        reasoning_options=bounded,
        thinking=ModelThinking(budget=900),
    )
    sent = json.loads(requests[0].content)
    check(
        "a declared budget range clamps the value",
        sent.get("x_budget") == 200,
        str(sent),
    )
    test_native_tools_preserve_request_and_response()
    test_native_errors_and_nonstream_responses_are_preserved()
    test_internal_unstructured_rate_limit_retries_before_returning()
    test_transport_failure_is_attributable()
    test_function_only_calls_keep_chat_conversion()
    test_native_protocol_rejection_is_independent_of_effort()
    test_streamed_provider_error_becomes_failed_response()
    test_json_answer_remains_a_successful_answer()
    test_normal_stream_keeps_deltas_and_complete_message()
    test_large_inline_image_is_fitted()
    test_small_inline_image_is_preserved()
    test_text_only_oversize_is_not_silently_truncated()
    test_tool_image_output_becomes_multimodal_chat_input()
    test_model_bridge_owns_authentication()
    print("gateway metering leg (proposal 42)")
    test_user_token_takes_the_authorization_slot()
    test_model_routes_are_exact_and_session_scoped()
    test_token_is_resolved_per_call_not_snapshotted()
    test_turn_header_is_resolved_per_call_not_snapshotted()
    test_turn_header_reaches_the_outbound_request()
    test_codex_provider_registers_the_turn_hook()
    test_switching_accounts_moves_a_warm_session_to_the_new_token()
    test_anonymous_session_falls_back_to_caller_key()
    test_local_credentials_are_not_stored_as_account_tokens()
    test_registrations_are_bounded()
    test_reasoning_tokens_are_not_erased()
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
