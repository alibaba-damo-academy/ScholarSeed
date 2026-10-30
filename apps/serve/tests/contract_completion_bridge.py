"""Contract coverage for Responses-to-Chat-Completions request fitting."""

from __future__ import annotations

import asyncio
import base64
import errno as errno_module
import json
import logging
import os
import random
import socket
import ssl
import time
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from threading import Thread
from typing import Awaitable, Callable, Iterator
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from scholarseed_runtime.contract.model import ModelCredential, ModelThinking, ModelWireProtocol
from service.chat.service.completions import (
    BRIDGE_REGISTRATION_TTL_SECONDS,
    CHAT_COMPLETIONS_REQUEST_TARGET_BYTES,
    INLINE_JPEG_DATA_PREFIX,
    MODEL_BRIDGE_CREDENTIAL_REQUIRED,
    MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED,
    MODEL_BRIDGE_ROUTE_PREFIX,
    UPSTREAM_RETRY_MAX_DELAY_SECONDS,
    CompletionBridge,
    CompletionCall,
    _fit_inline_images,
    _json_size,
    _redacted_endpoint,
    _responses_usage,
    _upstream_retry_delay,
    chat_stream_to_responses,
    mount_completion_bridge,
    responses_to_chat_request,
)
from service.chat.service.models import SessionModelSpec, _codex_provider
from service.chat.service.namespaces import NamespaceTools
from service.chat.service.rejections import (
    TRANSIENT_PROVIDER_FAILURE_CODE,
    TRANSIENT_PROVIDER_FAILURE_MESSAGE,
    terminal_provider_failure,
)
from service.chat.service.streams import (
    SSE_BUFFER_LIMIT,
    NativeResponseNormalizer,
    TextDeltaBatcher,
    coalesce_text_delta_stream,
)
from service.chat.service.transport import RETRYABLE_CONNECT_FAILURE_CATEGORIES
from service.identity.api.routes import register_auth
from service.identity.service.account_token import (
    CONV_MESSAGE_ID_HEADER,
    CONV_TURN_ID_HEADER,
    AccountTokenHolder,
)
from service.identity.service.auth import AuthService
from service.inference.source import SOURCE_UNAVAILABLE, ContentSource, SourceReference
from service.platform.activity import Activities  # noqa: E402
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
POOL_REUSE_DELAY_SECONDS = 6.0


def forward_contract(
    payload: dict,
    body: bytes,
    *,
    status: int = 200,
    responses_endpoint: str = RESPONSES_ENDPOINT,
    reasoning_effort: str | None = None,
    reasoning_options: list[dict] | None = None,
    approval_model_ref: str = "",
    thinking: ModelThinking | None = None,
    wire_protocol: ModelWireProtocol | None = None,
    turn_id_provider: Callable[[str], str] | None = None,
    source_endpoints: tuple[str, ...] = (),
    send_exc: BaseException | tuple[BaseException | None, ...] | None = None,
    source_text: str = "用户原文",
    source_references: tuple[SourceReference, ...] = (),
    api_key: str = "contract-key",
    token_provider: Callable[[str], str] | None = None,
    owner_id: str = "",
    upstream_responses: tuple[tuple[int, bytes, dict[str, str]], ...] = (),
    upstream_stream: httpx.AsyncByteStream | None = None,
    raise_server_exceptions: bool = True,
    diagnostics: list[tuple[str, dict]] | None = None,
    sources: list[tuple[str, str, dict]] | None = None,
    credential_resolver: Callable[[str, str], Awaitable[ModelCredential]] | None = None,
    credential_revocation_handler: Callable[[str, str, int, str], str] | None = None,
):
    """Exercise the public bridge route against a deterministic upstream transport."""
    captured: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        if isinstance(send_exc, tuple):
            attempt_error = send_exc[min(len(captured) - 1, len(send_exc) - 1)]
            if attempt_error is not None:
                raise attempt_error
        elif send_exc is not None:
            raise send_exc
        if upstream_stream is not None:
            return httpx.Response(status, stream=upstream_stream)
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

    async def observe_sources(session_id: str, turn_id: str, fields: dict) -> None:
        if sources is not None:
            sources.append((session_id, turn_id, dict(fields)))

    bridge = CompletionBridge(
        "http://127.0.0.1:8770",
        source_endpoints=source_endpoints,
        content_source=lambda _session, _turn: ContentSource(source_text, source_references),
        on_sources=observe_sources if sources is not None else None,
        on_diagnostic=(
            (lambda session, fields: diagnostics.append((session, dict(fields))))
            if diagnostics is not None
            else None
        ),
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
        approval_model_ref=approval_model_ref,
        thinking=thinking,
        # 夹具模拟的是 OpenAI 兼容端点；思考参数按家族公开字段名出站。
        provider="openai",
        wire_protocol=wire_protocol,
        turn_id_provider=turn_id_provider,
        token_provider=token_provider,
        owner_id=owner_id,
        connection_id="contract-connection" if credential_resolver is not None else "",
        credential_resolver=credential_resolver,
        credential_revocation_handler=credential_revocation_handler,
    )
    mount_completion_bridge(app, bridge)
    client_type = httpx.AsyncClient
    transport = httpx.MockTransport(upstream)
    with patch(
        "service.chat.service.completions.httpx.AsyncClient",
        side_effect=lambda **kwargs: client_type(transport=transport, **kwargs),
    ):
        with TestClient(app, raise_server_exceptions=raise_server_exceptions) as client:
            response = client.post(
                f"{MODEL_BRIDGE_ROUTE_PREFIX}{registration.bridge_id}/v1/responses",
                json=payload,
            )
            client.portal.call(bridge.close)
    return response, captured


def test_upstream_client_pool_reuses_connections_without_credentials() -> None:
    captured: list[httpx.Request] = []
    diagnostics: list[tuple[str, dict]] = []
    clients: list[httpx.AsyncClient] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            content=b'{"id":"response-1","output":[]}',
            headers={"Set-Cookie": "upstream-session=private"},
        )

    app = FastAPI()
    bridge = CompletionBridge(
        "http://127.0.0.1:8770",
        on_diagnostic=lambda session, fields: diagnostics.append((session, dict(fields))),
    )
    registrations = [
        bridge.register(
            endpoint=RESPONSES_ENDPOINT,
            responses_endpoint=RESPONSES_ENDPOINT,
            api_key=api_key,
            wire_protocol=ModelWireProtocol.RESPONSES,
            session_id=f"pool-session-{index}",
            trust_env=trust_env,
        )
        for index, (api_key, trust_env) in enumerate(
            (("first-secret", False), ("second-secret", False), ("third-secret", True))
        )
    ]
    mount_completion_bridge(app, bridge)
    client_type = httpx.AsyncClient
    transport = httpx.MockTransport(upstream)

    def client_factory(**kwargs) -> httpx.AsyncClient:
        client = client_type(transport=transport, **kwargs)
        clients.append(client)
        return client

    with patch("service.chat.service.completions.httpx.AsyncClient", side_effect=client_factory):
        with TestClient(app) as client:
            for registration in registrations:
                response = client.post(
                    f"{MODEL_BRIDGE_ROUTE_PREFIX}{registration.bridge_id}/v1/responses",
                    json={"model": "selected-model", "stream": False, "input": "Continue"},
                )
                check("pooled upstream call succeeds", response.status_code == 200)
            check(
                "same proxy policy shares one client; differing policy is isolated",
                len(clients) == 2,
                str(len(clients)),
            )
            check(
                "connection reuse is observable without claiming a socket hit",
                [
                    fields["client_pool_hit"]
                    for _session, fields in diagnostics
                    if fields["phase"] == "finished"
                ]
                == [False, True, False],
                str(diagnostics),
            )
            check(
                "credentials and upstream cookies never cross registrations",
                [request.headers.get("authorization") for request in captured]
                == ["Bearer first-secret", "Bearer second-secret", "Bearer third-secret"]
                and all("cookie" not in request.headers for request in captured),
                str([dict(request.headers) for request in captured]),
            )
            client.portal.call(bridge.close)
    check("bridge shutdown closes both pooled clients", all(client.is_closed for client in clients))


def test_upstream_client_pool_reuses_tcp_connection() -> None:
    connections: list[int] = []
    diagnostics: list[tuple[str, dict]] = []

    class UpstreamHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self) -> None:
            super().setup()
            connections.append(self.connection.fileno())

        def do_POST(self) -> None:
            self.rfile.read(int(self.headers["Content-Length"]))
            body = b'{"id":"response-1","output":[]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, _format: str, *args: object) -> None:
            return None

    upstream_server = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
    upstream_server.daemon_threads = True
    upstream_thread = Thread(target=upstream_server.serve_forever, daemon=True)
    upstream_thread.start()
    try:
        endpoint = f"http://127.0.0.1:{upstream_server.server_port}/v1/responses"
        app = FastAPI()
        bridge = CompletionBridge(
            "http://127.0.0.1:8770",
            on_diagnostic=lambda session, fields: diagnostics.append((session, dict(fields))),
        )
        registration = bridge.register(
            endpoint=endpoint,
            responses_endpoint=endpoint,
            api_key="",
            wire_protocol=ModelWireProtocol.RESPONSES,
            session_id="tcp-reuse",
        )
        mount_completion_bridge(app, bridge)
        with TestClient(app) as client:
            for attempt in range(2):
                if attempt:
                    time.sleep(POOL_REUSE_DELAY_SECONDS)
                response = client.post(
                    f"{MODEL_BRIDGE_ROUTE_PREFIX}{registration.bridge_id}/v1/responses",
                    json={"model": "selected-model", "stream": False, "input": "Continue"},
                )
                check("real upstream HTTP request succeeds", response.status_code == 200)
            client.portal.call(bridge.close)
        finished = [fields for _session, fields in diagnostics if fields["phase"] == "finished"]
        check(
            "two model calls use one upstream TCP connection",
            len(connections) == 1
            and len(finished) == 2
            and [fields["tcp_connects"] for fields in finished] == [1, 0]
            and [fields["client_pool_hit"] for fields in finished] == [False, True],
            f"connections={len(connections)} diagnostics={finished}",
        )
    finally:
        upstream_server.shutdown()
        upstream_server.server_close()
        upstream_thread.join()


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


def test_http_rejections_publish_known_codes_before_finished_diagnostic() -> None:
    cases = (
        (401, "invalid_api_key", False),
        (400, "InvalidParameter", False),
        (400, "bad_request", False),
        (400, "CONTENT_SAFETY_BLOCKED", False),
        (402, "credit_balance_exhausted", True),
        (429, "insufficient_quota", False),
    )

    async def resolve(_owner: str, _connection: str) -> ModelCredential:
        return ModelCredential(api_key="contract-key")

    close_call = CompletionCall._close
    for native, resolver in ((False, None), (True, None), (False, resolve), (True, resolve)):
        for status, code, detail in cases:
            envelope = (
                {"detail": {"error": code, "message": "private upstream detail"}}
                if detail
                else {"error": {"code": code, "message": "private upstream detail"}}
            )
            diagnostics: list[tuple[str, dict]] = []
            closed_codes: list[str] = []

            async def observe_close(
                call: CompletionCall, captured_codes: list[str] = closed_codes
            ) -> None:
                captured_codes.append(call.diagnostic.http_error_code)
                await close_call(call)

            payload = {"model": "alias", "input": "hello", "stream": False}
            with patch.object(CompletionCall, "_close", new=observe_close):
                response, captured = forward_contract(
                    payload,
                    json.dumps(envelope).encode(),
                    status=status,
                    wire_protocol=(
                        ModelWireProtocol.RESPONSES
                        if native
                        else ModelWireProtocol.CHAT_COMPLETIONS
                    ),
                    diagnostics=diagnostics,
                    owner_id="contract-owner" if resolver is not None else "",
                    credential_resolver=resolver,
                )
            label = f"HTTP {status} {code} native={native} resolver={resolver is not None}"
            check(f"{label} is not retried", response.status_code == status and len(captured) == 1)
            check(
                f"{label} records rejection before upstream close",
                closed_codes == [code],
                str(closed_codes),
            )
            finished = [fields for _, fields in diagnostics if fields.get("phase") == "finished"]
            check(f"{label} emits exactly one finished snapshot", len(finished) == 1)
            if not finished:
                continue
            fields = finished[0]
            check(
                f"{label} records rejection before the close diagnostic callback",
                fields.get("http_error_code") == code,
                str(fields.get("http_error_code")),
            )
            recovered = terminal_provider_failure(fields)
            check(
                f"{label} recovers terminal semantics at the diagnostic boundary",
                recovered.get("error_code") == code
                and recovered.get("retryability") == "terminal"
                and recovered.get("provider_http_status") == status,
                str(recovered),
            )
            check(
                f"{label} never releases the raw upstream message",
                "private upstream detail" not in json.dumps(recovered),
            )


def test_http_credential_revocation_precedes_provider_authentication_diagnostic() -> None:
    async def resolve(_owner: str, _connection: str) -> ModelCredential:
        return ModelCredential(api_key="contract-key")

    close_call = CompletionCall._close
    for native in (False, True):
        for revoked_code in ("oauth_reauth_required", "unregistered_revocation_code"):
            diagnostics: list[tuple[str, dict]] = []
            closed_codes: list[str] = []
            closed_revocation_counts: list[int] = []
            revocations: list[tuple[str, str, int, str]] = []

            def revoke(
                owner: str,
                connection: str,
                status: int,
                code: str,
                captured_revocations: list[tuple[str, str, int, str]] = revocations,
                captured_code: str = revoked_code,
            ) -> str:
                captured_revocations.append((owner, connection, status, code))
                return captured_code

            async def observe_close(
                call: CompletionCall,
                captured_codes: list[str] = closed_codes,
                captured_counts: list[int] = closed_revocation_counts,
                captured_revocations: list[tuple[str, str, int, str]] = revocations,
            ) -> None:
                captured_codes.append(call.diagnostic.http_error_code)
                captured_counts.append(len(captured_revocations))
                await close_call(call)

            with patch.object(CompletionCall, "_close", new=observe_close):
                response, _ = forward_contract(
                    {"model": "alias", "input": "hello", "stream": False},
                    b'{"error":{"code":"authentication_error","message":"private upstream detail"}}',
                    status=401,
                    wire_protocol=(
                        ModelWireProtocol.RESPONSES
                        if native
                        else ModelWireProtocol.CHAT_COMPLETIONS
                    ),
                    diagnostics=diagnostics,
                    owner_id="contract-owner",
                    credential_resolver=resolve,
                    credential_revocation_handler=revoke,
                )
            label = f"revocation {revoked_code} native={native}"
            check(
                f"{label} invokes the credential owner exactly once",
                revocations
                == [("contract-owner", "contract-connection", 401, "authentication_error")],
            )
            check(
                f"{label} invokes the credential owner before close callback",
                closed_revocation_counts == [1],
                str(closed_revocation_counts),
            )
            check(
                f"{label} never stores an unregistered diagnostic code before close",
                closed_codes == [""],
                str(closed_codes),
            )
            fields = diagnostics[-1][1]
            check(
                f"{label} does not fall back to the ordinary authentication diagnostic",
                fields.get("http_error_code") == "",
                str(fields.get("http_error_code")),
            )
            check(
                f"{label} preserves the existing reauthentication envelope",
                response.json()["error"]["code"] == revoked_code,
            )
            check(
                f"{label} does not release unregistered provider semantics",
                terminal_provider_failure(fields) == {},
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

    for token_provider in (None, lambda _owner: "account.token"):
        with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
            response, captured = forward_contract(
                payload,
                success,
                token_provider=token_provider,
                owner_id="account-owner",
                upstream_responses=(
                    (429, b'{"error":{"code":429}}', {"Retry-After": "0"}),
                    (200, success, {}),
                ),
            )
        check(
            "structured rate limits recover for internal and third-party models",
            response.status_code == 200 and len(captured) == 2,
        )

    diagnostics = []
    response, captured = forward_contract(
        payload,
        success,
        upstream_responses=((429, b'{"error":{"code":429}}', {"Retry-After": "3600"}),),
        diagnostics=diagnostics,
    )
    check(
        "long Retry-After is not shortened into a premature retry",
        response.status_code == 429 and len(captured) == 1,
    )
    recovered = terminal_provider_failure(diagnostics[-1][1])
    check(
        "unretried 429 still retains rate limit attribution",
        recovered.get("error_code") == "rate_limit_exceeded"
        and "automatic_retry_attempts" not in recovered,
    )
    for header, expected in (("2", 2.0), ("0", 0.0), ("inf", None)):
        check(
            "Retry-After delta respects the bounded wait policy",
            _upstream_retry_delay(httpx.Response(429, headers={"Retry-After": header}), 1)
            == expected,
        )
    with patch("service.chat.service.completions.time.time", return_value=0):
        check(
            "Retry-After HTTP dates are honored",
            _upstream_retry_delay(
                httpx.Response(429, headers={"Retry-After": "Thu, 01 Jan 1970 00:00:02 GMT"}), 1
            )
            == 2.0,
        )
    for header in ("invalid", "NaN", "-1"):
        delay = _upstream_retry_delay(httpx.Response(429, headers={"Retry-After": header}), 1)
        check(
            "invalid delay falls back to bounded backoff",
            0 <= delay <= UPSTREAM_RETRY_MAX_DELAY_SECONDS,
        )


def test_transient_server_failures_retry_for_all_bridge_upstreams() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    native_success = b'{"id":"response-1","output":[]}'
    chat_success = (
        b'{"id":"chat-1","choices":[{"message":{"role":"assistant","content":"OK"},'
        b'"finish_reason":"stop"}]}'
    )

    async def no_delay(_seconds: float) -> None:
        return None

    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        for wire_protocol, success in (
            (ModelWireProtocol.RESPONSES, native_success),
            (ModelWireProtocol.CHAT_COMPLETIONS, chat_success),
        ):
            for status in (500, 502, 503, 504):
                response, captured = forward_contract(
                    payload,
                    success,
                    wire_protocol=wire_protocol,
                    upstream_responses=((status, b"temporary", {}), (200, success, {})),
                )
                check(
                    f"transient {status} retries for {wire_protocol.value}",
                    response.status_code == 200
                    and len(captured) == 2
                    and (
                        response.content == success
                        if wire_protocol is ModelWireProtocol.RESPONSES
                        else response.json()["output"][0]["content"][0]["text"] == "OK"
                    ),
                    f"status={response.status_code} calls={len(captured)}",
                )

            response, captured = forward_contract(
                payload,
                success,
                wire_protocol=wire_protocol,
                upstream_responses=((500, b"temporary", {}),),
            )
            check(
                f"transient failures stop at the shared retry budget for {wire_protocol.value}",
                response.status_code == 500 and len(captured) == 3,
                f"status={response.status_code} calls={len(captured)}",
            )


def test_native_stream_coalesces_complete_events() -> None:
    normalizer = NativeResponseNormalizer()
    parts = (
        b"event: response.output_text.delta\n",
        b'data: {"type":"response.output_text.delta","delta":"hi"}\n',
        b"\n",
    )
    output = [piece for part in parts for piece in normalizer.feed(part)]
    check(
        "fragmented SSE lines produce one complete downstream event",
        output == [b"".join(parts)] and normalizer.finish() == (),
        str(output),
    )
    trailing = NativeResponseNormalizer()
    check(
        "unfinished SSE bytes are preserved at EOF",
        trailing.feed(b"event: response.created\n") == ()
        and trailing.finish() == (b"event: response.created\n",),
    )
    crlf = NativeResponseNormalizer()
    check(
        "CRLF events remain intact across chunks",
        crlf.feed(b"event: response.created\r\n\r") == ()
        and crlf.feed(b"\n") == (b"event: response.created\r\n\r\n",)
        and crlf.finish() == (),
    )
    oversized = NativeResponseNormalizer()
    oversized_line = b"data: " + b"x" * SSE_BUFFER_LIMIT
    check(
        "oversized SSE lines stream without losing bytes",
        b"".join(oversized.feed(oversized_line) + oversized.feed(b"\n\n") + oversized.finish())
        == oversized_line + b"\n\n",
    )


def test_native_stream_coalesces_logical_text_deltas() -> None:
    diagnostics: list[tuple[str, dict]] = []
    events = [
        {"type": "response.created", "sequence_number": 0},
        {
            "type": "response.output_text.delta",
            "sequence_number": 1,
            "item_id": "msg_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "Hello ",
        },
        {
            "type": "response.output_text.delta",
            "sequence_number": 2,
            "item_id": "msg_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "world",
        },
        {
            "type": "response.output_text.done",
            "sequence_number": 3,
            "item_id": "msg_1",
            "output_index": 0,
            "content_index": 0,
            "text": "Hello world",
        },
        {"type": "response.completed", "sequence_number": 4},
    ]
    body = b"".join(b"data: " + json.dumps(event).encode() + b"\n\n" for event in events)
    response, _requests = forward_contract(
        {"model": "alias", "stream": True, "input": "Continue"},
        body,
        wire_protocol=ModelWireProtocol.RESPONSES,
        diagnostics=diagnostics,
    )
    downstream = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    check(
        "adjacent logical text deltas combine without changing text or boundaries",
        [event["type"] for event in downstream]
        == [
            "response.created",
            "response.output_text.delta",
            "response.output_text.done",
            "response.completed",
        ]
        and downstream[1]["delta"] == "Hello world"
        and downstream[2]["text"] == "Hello world"
        and [event["sequence_number"] for event in downstream] == list(range(len(downstream))),
        str(downstream),
    )
    finished = [fields for _session, fields in diagnostics if fields["phase"] == "finished"][-1]
    check(
        "bridge diagnostics distinguish coalesced logical events from transport sends",
        finished["upstream"]["event_count"] == 5
        and finished["downstream"]["event_count"] == 4
        and finished["coalesced_text_delta_events"] == 1
        and finished["text_delta_batchable_events"] == 2
        and finished["text_delta_unsafe_events"] == 0,
        str(finished),
    )


def test_native_stream_coalesces_reasoning_deltas() -> None:
    diagnostics: list[tuple[str, dict]] = []
    events = [
        {"type": "response.created", "sequence_number": 0},
        {
            "type": "response.reasoning_text.delta",
            "sequence_number": 1,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "思",
        },
        {
            "type": "response.reasoning_text.delta",
            "sequence_number": 2,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "考",
        },
        {
            "type": "response.reasoning_text.done",
            "sequence_number": 3,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 0,
            "text": "思考",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 4,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 0,
            "delta": "公开",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 5,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 0,
            "delta": "摘要",
        },
        {
            "type": "response.reasoning_summary_text.done",
            "sequence_number": 6,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 0,
            "text": "公开摘要",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 7,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 1,
            "delta": "下一",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 8,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 1,
            "delta": "段",
        },
        {
            "type": "response.reasoning_summary_text.done",
            "sequence_number": 9,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 1,
            "text": "下一段",
        },
        {"type": "response.completed", "sequence_number": 10},
    ]
    body = b"".join(
        b"data: " + json.dumps(event, ensure_ascii=False).encode() + b"\n\n" for event in events
    )
    response, _requests = forward_contract(
        {"model": "alias", "stream": True, "input": "Continue"},
        body,
        wire_protocol=ModelWireProtocol.RESPONSES,
        diagnostics=diagnostics,
    )
    downstream = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    deltas = [event for event in downstream if event["type"].endswith(".delta")]
    finished = [fields for _session, fields in diagnostics if fields["phase"] == "finished"][-1]
    check(
        "raw reasoning and public summary deltas coalesce independently",
        [(event["type"], event["delta"]) for event in deltas]
        == [
            ("response.reasoning_text.delta", "思考"),
            ("response.reasoning_summary_text.delta", "公开摘要"),
            ("response.reasoning_summary_text.delta", "下一段"),
        ]
        and [event["sequence_number"] for event in downstream] == list(range(len(downstream)))
        and finished["upstream"]["event_count"] == 11
        and finished["downstream"]["event_count"] == 8
        and finished["coalesced_reasoning_text_delta_events"] == 1
        and finished["coalesced_reasoning_summary_text_delta_events"] == 2,
        str(downstream),
    )


def test_reasoning_delta_batcher_preserves_targets_and_unsafe_events() -> None:
    batcher = TextDeltaBatcher()

    def event(kind: str, sequence: int, target: str, delta: str, **extra: object) -> bytes:
        payload = {
            "type": kind,
            "sequence_number": sequence,
            "item_id": "rs_1",
            "output_index": 0,
            target: 0,
            "delta": delta,
            **extra,
        }
        return b"event: " + kind.encode() + b"\ndata: " + json.dumps(payload).encode() + b"\n\n"

    raw = "response.reasoning_text.delta"
    summary = "response.reasoning_summary_text.delta"
    incoming = (
        event(raw, 0, "content_index", "A"),
        event(raw, 1, "content_index", "B"),
        event(summary, 2, "summary_index", "C"),
        event(summary, 3, "summary_index", "D"),
        event(summary, 4, "summary_index", "E", unexpected=True),
        b'data: {"type":"response.reasoning_summary_text.done","sequence_number":5}\n\n',
        b'data: {"type":"response.failed","sequence_number":6}\n\n',
    )
    output = [frame for frame in incoming for frame in batcher.feed(frame)]
    output.extend(batcher.flush())
    parsed = [
        json.loads(next(line for line in frame.splitlines() if line.startswith(b"data: "))[6:])
        for frame in output
    ]
    check(
        "reasoning kinds and unsafe fields flush before boundaries",
        [(payload["type"], payload["delta"]) for payload in parsed if "delta" in payload]
        == [(raw, "AB"), (summary, "CD"), (summary, "E")]
        and [payload["sequence_number"] for payload in parsed] == list(range(len(parsed)))
        and parsed[-2]["type"] == "response.reasoning_summary_text.done"
        and parsed[-1]["type"] == "response.failed"
        and batcher.merged_events == 2,
        str(parsed),
    )


def test_reasoning_delta_batcher_flushes_on_target_change_and_malformed_type() -> None:
    batcher = TextDeltaBatcher()
    events = [
        {
            "type": "response.reasoning_text.delta",
            "sequence_number": 0,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "A",
        },
        {
            "type": "response.reasoning_text.delta",
            "sequence_number": 1,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 0,
            "delta": "B",
        },
        {
            "type": "response.reasoning_text.delta",
            "sequence_number": 2,
            "item_id": "rs_1",
            "output_index": 0,
            "content_index": 1,
            "delta": "C",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 3,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 0,
            "delta": "D",
        },
        {
            "type": "response.reasoning_summary_text.delta",
            "sequence_number": 4,
            "item_id": "rs_1",
            "output_index": 0,
            "summary_index": 1,
            "delta": "E",
        },
        {"type": [], "sequence_number": 5},
    ]
    output = [
        frame
        for payload in events
        for frame in batcher.feed(b"data: " + json.dumps(payload).encode() + b"\n\n")
    ]
    output.extend(batcher.flush())
    parsed = [
        json.loads(next(line for line in frame.splitlines() if line.startswith(b"data: "))[6:])
        for frame in output
    ]
    check(
        "reasoning content and summary indices do not mix, malformed types pass through",
        [payload.get("delta") for payload in parsed] == ["AB", "C", "D", "E", None]
        and [payload["sequence_number"] for payload in parsed] == list(range(len(parsed)))
        and parsed[-1]["type"] == [],
        str(parsed),
    )


def test_reasoning_delta_batcher_preserves_long_streams() -> None:
    source_text = "可重复科研" * 240
    for kind, index in (
        ("response.reasoning_text.delta", "content_index"),
        ("response.reasoning_summary_text.delta", "summary_index"),
    ):
        batcher = TextDeltaBatcher()
        output: list[bytes] = []
        for sequence, delta in enumerate(source_text):
            payload = {
                "type": kind,
                "sequence_number": sequence,
                "item_id": "rs_long",
                "output_index": 0,
                index: 0,
                "delta": delta,
            }
            frame = b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"
            output.extend(batcher.feed(frame))
        output.extend(
            batcher.feed(b'data: {"type":"response.completed","sequence_number":1200}\n\n')
        )
        output.extend(batcher.flush())
        parsed = [
            json.loads(next(line for line in frame.splitlines() if line.startswith(b"data: "))[6:])
            for frame in output
        ]
        check(
            f"long {kind} stream retains exact text and ordered sequence",
            "".join(event["delta"] for event in parsed if event["type"] == kind) == source_text
            and [event["sequence_number"] for event in parsed] == list(range(len(parsed)))
            and parsed[-1]["type"] == "response.completed"
            and len(parsed) < len(source_text) // 10,
            f"events={len(parsed)} merged={batcher.merged_events}",
        )


def test_text_delta_batcher_preserves_boundaries_and_unsafe_events() -> None:
    batcher = TextDeltaBatcher()

    def event(
        kind: str,
        sequence: int,
        *,
        item: str = "msg_1",
        delta: str = "x",
        extra: dict | None = None,
    ) -> bytes:
        payload = {
            "type": kind,
            "sequence_number": sequence,
            "item_id": item,
            "output_index": 0,
            "content_index": 0,
            "delta": delta,
            **(extra or {}),
        }
        return (
            b"event: " + kind.encode() + b"\r\ndata: " + json.dumps(payload).encode() + b"\r\n\r\n"
        )

    outputs = []
    for incoming in (
        event("response.output_text.delta", 0, delta="A"),
        event("response.output_text.delta", 1, delta="B"),
        event("response.output_text.delta", 2, item="msg_2", delta="C"),
        event(
            "response.output_text.delta",
            3,
            item="msg_2",
            delta="D",
            extra={"logprobs": [{"token": "D"}]},
        ),
        event("response.output_text.done", 4, item="msg_2"),
        event("response.completed", 5),
    ):
        outputs.extend(batcher.feed(incoming))
    outputs.extend(batcher.flush())
    parsed = [
        json.loads(next(line for line in output.splitlines() if line.startswith(b"data: "))[6:])
        for output in outputs
    ]
    check(
        "different output targets and logprobs flush before the following event",
        [payload["delta"] for payload in parsed if payload["type"] == "response.output_text.delta"]
        == ["AB", "C", "D"]
        and [payload["sequence_number"] for payload in parsed] == list(range(len(parsed)))
        and parsed[-1]["type"] == "response.completed"
        and batcher.merged_events == 1,
        str(parsed),
    )


def test_text_delta_batcher_preserves_sse_ids_and_comments() -> None:
    batcher = TextDeltaBatcher()
    first = (
        b"event: response.output_text.delta\nid: upstream-1\n: padding-one\n"
        b'data: {"type":"response.output_text.delta","sequence_number":0,'
        b'"item_id":"msg_1","output_index":0,"content_index":0,"delta":"A"}\n\n'
    )
    second = (
        b"event: response.output_text.delta\nid: upstream-2\n: padding-two\n"
        b'data: {"type":"response.output_text.delta","sequence_number":1,'
        b'"item_id":"msg_1","output_index":0,"content_index":0,"delta":"B"}\n\n'
    )
    output = batcher.feed(first) + batcher.feed(second) + batcher.flush()
    check(
        "SSE ids and comments do not disable text coalescing and remain in the merged frame",
        len(output) == 1
        and b'"delta": "AB"' in output[0]
        and output[0].count(b"event:") == 1
        and b"id: upstream-1" in output[0]
        and b"id: upstream-2" in output[0]
        and b": padding-one" in output[0]
        and b": padding-two" in output[0]
        and batcher.merged_events == 1,
        repr(output),
    )


def test_text_delta_batcher_exception_boundary() -> None:
    async def scenario(error: BaseException) -> tuple[list[bytes], BaseException]:
        async def source():
            yield b'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"tail"}\n\n'
            raise error

        output = []
        try:
            async for frame in coalesce_text_delta_stream(source(), TextDeltaBatcher()):
                output.append(frame)
        except BaseException as caught:
            return output, caught
        raise AssertionError("source exception was swallowed")

    for error in (
        httpx.ReadError("upstream interrupted"),
        asyncio.CancelledError(),
        GeneratorExit(),
    ):
        output, caught = asyncio.run(scenario(error))
        expected = isinstance(error, Exception)
        check(
            f"{type(error).__name__} preserves exception and flushes only ordinary failures",
            caught is error
            and (len(output) == 1 and b'"delta": "tail"' in output[0] if expected else not output),
            repr(output),
        )


def test_text_delta_stream_closes_prefetched_source() -> None:
    async def scenario() -> bool:
        prefetched = asyncio.Event()
        closed = asyncio.Event()

        async def source():
            try:
                yield b'data: {"type":"response.created"}\n\n'
                prefetched.set()
                yield b'data: {"type":"response.in_progress"}\n\n'
            finally:
                closed.set()

        output = coalesce_text_delta_stream(source(), TextDeltaBatcher())
        await anext(output)
        await prefetched.wait()
        await output.aclose()
        return closed.is_set()

    check(
        "closing after completed prefetch immediately closes the suspended source",
        asyncio.run(scenario()),
        "source finally must run before returning from aclose",
    )


def test_text_delta_batcher_preserves_long_stream_text() -> None:
    batcher = TextDeltaBatcher()
    source_text = "可重复科研" * 240
    outputs: list[bytes] = []
    for sequence, delta in enumerate(source_text):
        payload = {
            "type": "response.output_text.delta",
            "sequence_number": sequence,
            "item_id": "msg_long",
            "output_index": 0,
            "content_index": 0,
            "delta": delta,
        }
        incoming = (
            b"event: response.output_text.delta\n"
            + f"id: {sequence}\n: padding\n".encode()
            + b"data: "
            + json.dumps(payload, ensure_ascii=False).encode()
            + b"\n\n"
        )
        outputs.extend(batcher.feed(incoming))
    outputs.extend(
        batcher.feed(
            b'event: response.completed\ndata: {"type":"response.completed","sequence_number":'
            + str(len(source_text)).encode()
            + b"}\n\n"
        )
    )
    outputs.extend(batcher.flush())
    parsed = [
        json.loads(next(line for line in output.splitlines() if line.startswith(b"data: "))[6:])
        for output in outputs
    ]
    check(
        "1200-character SSE stream retains exact text, ordered sequence and terminal",
        "".join(
            payload["delta"]
            for payload in parsed
            if payload["type"] == "response.output_text.delta"
        )
        == source_text
        and [payload["sequence_number"] for payload in parsed] == list(range(len(parsed)))
        and parsed[-1]["type"] == "response.completed"
        and len(parsed) < len(source_text) // 10,
        f"events={len(parsed)} merged={batcher.merged_events}",
    )


def test_text_delta_batcher_flushes_without_another_upstream_event() -> None:
    async def scenario() -> tuple[bytes, bytes]:
        release = asyncio.Event()

        async def source():
            yield b'data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"first"}\n\n'
            await release.wait()
            yield b'data: {"type":"response.completed"}\n\n'

        output = coalesce_text_delta_stream(source(), TextDeltaBatcher())
        first = await asyncio.wait_for(anext(output), timeout=1)
        release.set()
        second = await asyncio.wait_for(anext(output), timeout=1)
        await output.aclose()
        return first, second

    first, second = asyncio.run(scenario())
    check(
        "a lone text delta leaves within the time window while upstream remains open",
        b'"delta": "first"' in first and b"response.completed" in second,
        repr((first, second)),
    )


def test_reasoning_delta_batcher_flushes_without_another_upstream_event() -> None:
    async def scenario(kind: str, index: str) -> tuple[bytes, bytes]:
        release = asyncio.Event()

        async def source():
            payload = {
                "type": kind,
                "item_id": "rs_1",
                "output_index": 0,
                index: 0,
                "delta": "first",
            }
            yield b"data: " + json.dumps(payload).encode() + b"\n\n"
            await release.wait()
            yield b'data: {"type":"response.completed"}\n\n'

        output = coalesce_text_delta_stream(source(), TextDeltaBatcher())
        first = await asyncio.wait_for(anext(output), timeout=1)
        release.set()
        second = await asyncio.wait_for(anext(output), timeout=1)
        await output.aclose()
        return first, second

    for kind, index in (
        ("response.reasoning_text.delta", "content_index"),
        ("response.reasoning_summary_text.delta", "summary_index"),
    ):
        first, second = asyncio.run(scenario(kind, index))
        check(
            f"a lone {kind} delta leaves within the time window",
            b'"delta": "first"' in first and b"response.completed" in second,
            repr((first, second)),
        )


def test_native_stream_reports_upstream_and_send_timing() -> None:
    diagnostics: list[tuple[str, dict]] = []
    response, _requests = forward_contract(
        {"model": "alias", "stream": True, "input": "Continue"},
        b'data: {"type":"response.created"}\n\n' b'data: {"type":"response.completed"}\n\n',
        wire_protocol=ModelWireProtocol.RESPONSES,
        diagnostics=diagnostics,
    )
    finished = [fields for _session, fields in diagnostics if fields["phase"] == "finished"][-1]
    check(
        "native stream preserves upstream and downstream events",
        response.status_code == 200
        and finished["upstream"]["event_count"] == 2
        and finished["downstream"]["event_count"] == 2,
        str(finished),
    )
    check(
        "diagnostics separate receipt from downstream send",
        0
        <= finished["first_upstream_chunk_ms"]
        <= finished["last_upstream_chunk_ms"]
        <= finished["elapsed_ms"]
        and finished["downstream_send_count"] == 2
        and finished["downstream_send_ms"] >= finished["downstream_send_max_ms"] >= 0,
        str(finished),
    )


def test_native_stream_overload_retries_only_before_semantic_output() -> None:
    payload = {"model": "alias", "stream": True, "input": "Continue"}
    overloaded = (
        b'data: {"type":"response.created"}\r\n\r\n'
        b'data: {"type":"error","code":"server_is_overloaded",'
        b'"type_detail":"service_unavailable_error","message":"busy"}\r\n\r\n'
    )
    success = (
        b'data: {"type":"response.created"}\n\n'
        b'data: {"type":"response.output_text.delta","delta":"ready"}\n\n'
        b'data: {"type":"response.completed"}\n\n'
    )
    diagnostics: list[tuple[str, dict]] = []

    async def no_delay(_seconds: float) -> None:
        return None

    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        recovered, captured = forward_contract(
            payload,
            success,
            wire_protocol=ModelWireProtocol.RESPONSES,
            upstream_responses=((200, overloaded, {}), (200, success, {})),
            diagnostics=diagnostics,
        )
        exhausted, exhausted_calls = forward_contract(
            payload,
            overloaded,
            wire_protocol=ModelWireProtocol.RESPONSES,
        )
        after_output, output_calls = forward_contract(
            payload,
            overloaded,
            wire_protocol=ModelWireProtocol.RESPONSES,
            upstream_responses=(
                (200, success.split(b'data: {"type":"response.completed"}')[0] + overloaded, {}),
                (200, success, {}),
            ),
        )
        content_safety = (
            b'data: {"type":"response.failed","response":{"status":"failed","error":'
            b'{"code":"server_error","message":"<400> '
            b'InternalError.Algo.DataInspectionFailed: blocked"}}}\n\n'
        )
        blocked, blocked_calls = forward_contract(
            payload,
            content_safety,
            wire_protocol=ModelWireProtocol.RESPONSES,
            upstream_responses=((200, content_safety, {}), (200, success, {})),
        )
        unknown_event = b'data: {"type":"provider.unknown"}\n\n' + overloaded
        unknown, unknown_calls = forward_contract(
            payload,
            unknown_event,
            wire_protocol=ModelWireProtocol.RESPONSES,
            upstream_responses=((200, unknown_event, {}), (200, success, {})),
        )

    check(
        "pre-output overload retries without leaking failed attempt events",
        len(captured) == 2
        and b"server_is_overloaded" not in recovered.content
        and recovered.content.count(b"response.created") == 1
        and b"response.completed" in recovered.content,
    )
    finished = [fields for _session, fields in diagnostics if fields["phase"] == "finished"][-1]
    check(
        "stream retry uses shared budget and is diagnosed",
        finished["attempt"] == 2 and finished["stream_retries"] == 1,
        str(finished),
    )
    check(
        "persistent overload exhausts the budget with one terminal failure",
        len(exhausted_calls) == 3
        and exhausted.content.count(b"event: response.failed") == 1
        and b"server_is_overloaded" in exhausted.content,
    )
    check(
        "semantic output closes the retry window",
        len(output_calls) == 1
        and b"response.output_text.delta" in after_output.content
        and b"response.failed" in after_output.content,
    )
    check(
        "content safety cannot be retried as transient server_error",
        len(blocked_calls) == 1 and b"CONTENT_SAFETY_BLOCKED" in blocked.content,
    )
    check(
        "unknown events close the retry window",
        len(unknown_calls) == 1 and b"provider.unknown" in unknown.content,
    )


class _WarningCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


@contextmanager
def _captured_bridge_warnings() -> Iterator[list[str]]:
    handler = _WarningCapture()
    bridge_logger = logging.getLogger("service.chat.service.completions")
    previous_level = bridge_logger.level
    bridge_logger.setLevel(logging.WARNING)
    bridge_logger.addHandler(handler)
    try:
        yield handler.messages
    finally:
        bridge_logger.removeHandler(handler)
        bridge_logger.setLevel(previous_level)


def _tls_sever() -> httpx.ConnectError:
    error = httpx.ConnectError("secret-upstream-url-and-token")
    error.__cause__ = ssl.SSLEOFError()
    return error


def _tls_handshake_timeout() -> httpx.ConnectTimeout:
    error = httpx.ConnectTimeout("secret-upstream-url-and-token")
    error.__cause__ = ssl.SSLWantReadError()
    return error


def _transient_dns_failure() -> httpx.ConnectError:
    error = httpx.ConnectError("secret-upstream-url-and-token")
    error.__cause__ = socket.gaierror(socket.EAI_AGAIN, "secret-dns-host")
    return error


def _request_reset(error_number: int) -> httpx.ReadError:
    error = httpx.ReadError("secret-upstream-url-and-token")
    cause_type = BrokenPipeError if error_number == errno_module.EPIPE else ConnectionResetError
    error.__cause__ = cause_type(error_number, "secret-reset-detail")
    return error


def _permanent_tls_failure(cause: ssl.SSLError) -> httpx.ConnectError:
    error = httpx.ConnectError("secret-upstream-url-and-token")
    error.__cause__ = cause
    return error


def test_connect_phase_failures_retry_before_request_is_sent() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    success = b'{"id":"response-1","output":[]}'

    async def no_delay(_seconds: float) -> None:
        return None

    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        # 这条腿走非原生转换: 桥把上游体规整成 Responses 对象, 原样回传字节不是不变量。
        # 用一次无故障调用固定成功体, 再断言重试恢复后回传同一份规整体。
        control, _ = forward_contract(payload, success)
        expected_success = control.content
        for maker, category in (
            (_tls_sever, "tls"),
            (_transient_dns_failure, "dns"),
            (lambda: httpx.ConnectError("secret-connect-detail"), "connect_error"),
        ):
            with _captured_bridge_warnings() as messages:
                response, captured = forward_contract(
                    payload,
                    success,
                    send_exc=(maker(), maker(), None),
                )
            retried = [
                message
                for message in messages
                if message.startswith("model_bridge_upstream_connect_retry")
            ]
            check(
                f"{category} connect failure recovers within the retry budget",
                response.status_code == 200
                and response.content == expected_success
                and len(captured) == 3
                and len(retried) == 2,
                f"status={response.status_code} calls={len(captured)} retries={len(retried)}",
            )
            check(
                f"{category} retry log carries the category and no secrets",
                all(
                    f"category={category}" in message and "secret-" not in message
                    for message in retried
                ),
                str(retried),
            )

        diagnostics: list[tuple[str, dict]] = []
        with _captured_bridge_warnings() as messages:
            response, captured = forward_contract(
                payload,
                success,
                send_exc=(_tls_sever(),),
                diagnostics=diagnostics,
            )
    failed = [
        message
        for message in messages
        if message.startswith("model_bridge_upstream_transport_failed")
    ]
    check(
        "transient TLS failures stop after six retries with one 502",
        response.status_code == 502 and len(captured) == 7 and len(failed) == 1,
        f"status={response.status_code} calls={len(captured)} failures={len(failed)}",
    )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "trace records the exhausted attempt with the tls category",
        emitted.get("transport_category") == "tls"
        and emitted.get("attempt") == 7
        and emitted.get("max_attempts") == 7
        and emitted.get("connect_retries") == 6
        and emitted.get("tls_retries") == 6
        and emitted.get("http_retries") == 0,
        str(emitted),
    )
    check(
        "connect retry allow-list stays pinned to pre-request categories",
        RETRYABLE_CONNECT_FAILURE_CATEGORIES == frozenset(("connect_error", "connect_timeout")),
        str(sorted(RETRYABLE_CONNECT_FAILURE_CATEGORIES)),
    )


def test_transient_tls_succeeds_on_seventh_attempt() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    success = b'{"id":"response-1","output":[]}'

    async def no_delay(_seconds: float) -> None:
        return None

    diagnostics: list[tuple[str, dict]] = []
    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        with _captured_bridge_warnings() as messages:
            response, captured = forward_contract(
                payload,
                success,
                send_exc=tuple(_tls_sever() for _ in range(6)) + (None,),
                diagnostics=diagnostics,
            )
    retries = [
        message for message in messages if message.startswith("model_bridge_upstream_connect_retry")
    ]
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "transient TLS recovers on the seventh attempt",
        response.status_code == 200
        and len(captured) == 7
        and len(retries) == 6
        and emitted.get("attempt") == 7
        and emitted.get("max_attempts") == 7
        and emitted.get("connect_retries") == 6
        and emitted.get("tls_retries") == 6
        and emitted.get("http_retries") == 0,
        f"status={response.status_code} calls={len(captured)} retries={len(retries)}",
    )
    check(
        "TLS retry logs report the seven-attempt budget",
        all("category=tls" in message and "max_attempts=7" in message for message in retries),
        str(retries),
    )


def test_tls_handshake_timeout_succeeds_on_seventh_attempt() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    success = b'{"id":"response-1","output":[]}'

    async def no_delay(_seconds: float) -> None:
        return None

    diagnostics: list[tuple[str, dict]] = []
    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        response, captured = forward_contract(
            payload,
            success,
            send_exc=tuple(_tls_handshake_timeout() for _ in range(6)) + (None,),
            diagnostics=diagnostics,
        )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "TLS handshake timeout recovers on the seventh attempt",
        response.status_code == 200
        and len(captured) == 7
        and emitted.get("attempt") == 7
        and emitted.get("max_attempts") == 7
        and emitted.get("tls_retries") == 6
        and emitted.get("transport_category") is None,
        f"status={response.status_code} calls={len(captured)} diagnostic={emitted}",
    )


def test_non_tls_connect_failures_keep_three_attempt_budget() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}

    async def no_delay(_seconds: float) -> None:
        return None

    diagnostics: list[tuple[str, dict]] = []
    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        response, captured = forward_contract(
            payload,
            b"",
            send_exc=_transient_dns_failure(),
            diagnostics=diagnostics,
        )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "transient DNS still stops after three attempts",
        response.status_code == 502
        and len(captured) == 3
        and emitted.get("attempt") == 3
        and emitted.get("max_attempts") == 3,
        f"status={response.status_code} calls={len(captured)} diagnostic={emitted}",
    )
    diagnostics.clear()
    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        response, captured = forward_contract(
            payload,
            b"",
            send_exc=(_tls_sever(), None, None),
            upstream_responses=((500, b"temporary", {}),),
            diagnostics=diagnostics,
        )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "HTTP failures retain the three-attempt budget after TLS",
        response.status_code == 500
        and len(captured) == 3
        and emitted.get("attempt") == 3
        and emitted.get("max_attempts") == 3,
        f"status={response.status_code} calls={len(captured)} diagnostic={emitted}",
    )


def test_request_reset_retries_before_response_headers() -> None:
    payload = {
        "model": "alias",
        "stream": True,
        "input": "Continue",
        "tools": [{"type": "web_search"}],
    }
    success = (
        b'data: {"type":"response.created","response":{"id":"response-1"}}\n\n'
        b'data: {"type":"response.completed","response":{"id":"response-1",'
        b'"status":"completed"}}\n\n'
    )

    async def no_delay(_seconds: float) -> None:
        return None

    with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
        for error_number in (errno_module.EPIPE, errno_module.ECONNRESET):
            diagnostics: list[tuple[str, dict]] = []
            with _captured_bridge_warnings() as messages:
                response, captured = forward_contract(
                    payload,
                    success,
                    send_exc=(_request_reset(error_number), None),
                    diagnostics=diagnostics,
                )
            retries = [
                message
                for message in messages
                if message.startswith("model_bridge_upstream_request_retry")
            ]
            emitted = diagnostics[-1][1] if diagnostics else {}
            check(
                f"request-stage reset {error_number} recovers without failing the turn",
                response.status_code == 200
                and b"response.completed" in response.content
                and len(captured) == 2
                and len(retries) == 1
                and emitted.get("attempt") == 2
                and emitted.get("request_retries") == 1
                and emitted.get("connect_retries") == 0,
                f"status={response.status_code} calls={len(captured)} diagnostic={emitted}",
            )

        diagnostics = []
        with _captured_bridge_warnings() as messages:
            exhausted, captured = forward_contract(
                payload,
                b"",
                send_exc=_request_reset(errno_module.EPIPE),
                diagnostics=diagnostics,
            )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "request-stage reset exhausts the bridge budget with a safe transient code",
        exhausted.status_code == 502
        and exhausted.json()["error"]
        == {
            "code": TRANSIENT_PROVIDER_FAILURE_CODE,
            "message": TRANSIENT_PROVIDER_FAILURE_MESSAGE,
        }
        and len(captured) == 3
        and emitted.get("attempt") == 3
        and emitted.get("request_retries") == 2
        and emitted.get("connect_retries") == 0
        and len(messages) == 3,
        f"status={exhausted.status_code} calls={len(captured)} diagnostic={emitted}",
    )

    diagnostics = []
    unrelated, captured = forward_contract(
        payload,
        b"",
        send_exc=httpx.ReadError("secret-unclassified-read-error"),
        diagnostics=diagnostics,
    )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "unclassified request read error is not replayed as a reset",
        unrelated.status_code == 502
        and len(captured) == 1
        and emitted.get("request_retries") == 0
        and "code" not in unrelated.json()["error"],
        f"status={unrelated.status_code} calls={len(captured)} diagnostic={emitted}",
    )


def test_response_body_reset_does_not_replay_request() -> None:
    class BrokenResponseBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            raise _request_reset(errno_module.EPIPE)

    diagnostics: list[tuple[str, dict]] = []
    response, captured = forward_contract(
        {"model": "alias", "stream": True, "input": "Continue", "tools": [{"type": "web_search"}]},
        b"",
        upstream_stream=BrokenResponseBody(),
        raise_server_exceptions=False,
        diagnostics=diagnostics,
    )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "response-body reset does not replay a partially observed stream",
        len(captured) == 1
        and emitted.get("transport_stage") == "response_body"
        and emitted.get("request_retries") == 0,
        f"status={response.status_code} calls={len(captured)} diagnostic={emitted}",
    )


def test_permanent_tls_failures_do_not_retry() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    permanent_failures = (
        ssl.SSLCertVerificationError(1, "secret-certificate-detail"),
        ssl.SSLError(ssl.SSL_ERROR_SSL, "secret-protocol-detail"),
    )

    for failure in permanent_failures:
        diagnostics: list[tuple[str, dict]] = []
        with _captured_bridge_warnings() as messages:
            response, captured = forward_contract(
                payload,
                b"",
                send_exc=_permanent_tls_failure(failure),
                diagnostics=diagnostics,
            )
        retries = [
            message
            for message in messages
            if message.startswith("model_bridge_upstream_connect_retry")
        ]
        emitted = diagnostics[-1][1] if diagnostics else {}
        check(
            f"{type(failure).__name__} fails without retry",
            response.status_code == 502
            and len(captured) == 1
            and not retries
            and emitted.get("attempt") == 1
            and emitted.get("transport_category") == "tls",
            f"status={response.status_code} calls={len(captured)} retries={len(retries)}",
        )


def test_permanent_dns_failure_does_not_retry() -> None:
    payload = {"model": "alias", "stream": False, "input": "Continue"}
    error = httpx.ConnectError("secret-upstream-url-and-token")
    error.__cause__ = socket.gaierror(socket.EAI_NONAME, "secret-dns-host")
    diagnostics: list[tuple[str, dict]] = []

    with _captured_bridge_warnings() as messages:
        response, captured = forward_contract(
            payload,
            b"",
            send_exc=error,
            diagnostics=diagnostics,
        )
    retries = [
        message for message in messages if message.startswith("model_bridge_upstream_connect_retry")
    ]
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "permanent DNS failure fails without retry",
        response.status_code == 502
        and len(captured) == 1
        and not retries
        and emitted.get("attempt") == 1
        and emitted.get("transport_category") == "dns",
        f"status={response.status_code} calls={len(captured)} retries={len(retries)}",
    )


def test_transport_failure_is_attributable() -> None:
    payload = {
        "model": "alias",
        "stream": True,
        "input": [{"role": "user", "content": "Research airline capacity."}],
        "tools": [{"type": "web_search"}],
    }
    code = errno_module.ECONNRESET
    name = errno_module.errorcode[code]
    text = os.strerror(code)
    sever = httpx.ReadError("secret-upstream-url-and-token")
    sever.__cause__ = ConnectionResetError(code, "secret-reset-detail")
    records: list[logging.LogRecord] = []
    diagnostics: list[tuple[str, dict]] = []

    class _Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    bridge_logger = logging.getLogger("service.chat.service.completions")
    handler = _Capture()
    previous_level = bridge_logger.level
    bridge_logger.setLevel(logging.WARNING)
    bridge_logger.addHandler(handler)

    async def no_delay(_seconds: float) -> None:
        return None

    try:
        with patch("service.chat.service.completions.asyncio.sleep", new=no_delay):
            response, captured = forward_contract(
                payload,
                b"",
                send_exc=sever,
                diagnostics=diagnostics,
            )
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
        "transport sever returns 502 after the bridge retry budget",
        response.status_code == 502 and len(captured) == 3,
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
        f"errno={code}" in message and f"errno_name={name}" in message and text in message,
        message,
    )
    check(
        "log surfaces the exception chain",
        "cause_chain=ReadError>ConnectionResetError" in message,
        message,
    )
    emitted = diagnostics[-1][1] if diagnostics else {}
    check(
        "trace records the request-stage connection reset",
        emitted.get("transport_stage") == "request"
        and emitted.get("transport_category") == "connection_reset"
        and emitted.get("transport_cause_chain") == "ReadError>ConnectionResetError"
        and emitted.get("transport_root_type") == "ConnectionResetError"
        and emitted.get("transport_errno") == code
        and emitted.get("transport_errno_name") == name,
        str(emitted),
    )
    serialized = json.dumps(diagnostics)
    check(
        "trace keeps transport exception messages out",
        "secret-upstream-url-and-token" not in serialized
        and "secret-reset-detail" not in serialized,
        serialized,
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


def test_chat_protocol_rejects_native_tools_before_upstream() -> None:
    payload = {
        "model": "alias",
        "stream": False,
        "input": "Hello",
        "tools": [
            {"type": "web_search"},
            {"type": "function", "name": "inspect", "parameters": {"type": "object"}},
        ],
    }
    body = b'{"id":"chat-1","choices":[{"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}]}'
    for effort in ("", "low"):
        response, requests = forward_contract(
            payload,
            body,
            reasoning_effort=effort,
            wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
        )
        check(
            f"Chat protocol rejects native tools at effort {effort or 'default'}",
            response.status_code == 400
            and response.json()["error"]["code"] == MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED
            and not requests,
            f"status={response.status_code} calls={len(requests)}",
        )


def test_bridge_projects_upstream_search_capability() -> None:
    for wire, endpoint, expected in (
        (ModelWireProtocol.CHAT_COMPLETIONS, CHAT_ENDPOINT, False),
        (ModelWireProtocol.RESPONSES, RESPONSES_ENDPOINT, None),
    ):
        config = {
            "base_url": "https://gateway.example/v1",
            "call_url": endpoint,
            "wire_api": wire.value,
        }
        bridge = CompletionBridge("http://127.0.0.1:8770")
        provider, environment = _codex_provider(config, bridge, reasoning_effort="")
        spec = SessionModelSpec(
            key="selected-model",
            model_name="selected-model",
            config=config,
            billing="personal",
            codex_provider=provider,
            process_environment=environment,
        )
        intent, _ = spec.runtime_model()
        assert intent.transport.wire_protocol is ModelWireProtocol.RESPONSES
        assert intent.capabilities.native_web_search is expected
        assert next(iter(bridge._upstreams.values())).wire_protocol is wire


def test_namespaced_chat_tools_roundtrip() -> None:
    declarations = [
        {
            "type": "namespace",
            "name": namespace,
            "description": f"{namespace} tools",
            "tools": [
                {
                    "type": "function",
                    "name": "inspect",
                    "description": "Inspect a file",
                    "parameters": {"type": "object", "properties": {}},
                    "strict": True,
                }
            ],
        }
        for namespace in ("files", "projects")
    ]
    payload = {
        "model": "alias",
        "stream": False,
        "input": "Inspect",
        "tools": declarations,
        "tool_choice": {"type": "function", "namespace": "files", "name": "inspect"},
    }
    body = json.dumps(
        {
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call-inspect",
                                "type": "function",
                                "function": {"name": "files__inspect", "arguments": "{}"},
                            }
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        }
    ).encode()
    response, requests = forward_contract(
        payload, body, wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS
    )
    assert response.status_code == 200, response.content
    forwarded = json.loads(requests[0].content)
    assert [tool["function"]["name"] for tool in forwarded["tools"]] == [
        "files__inspect",
        "projects__inspect",
    ]
    assert (
        forwarded["tools"][0]["function"]["parameters"] == declarations[0]["tools"][0]["parameters"]
    )
    assert forwarded["tools"][0]["function"]["strict"] is True
    assert forwarded["tool_choice"] == {"type": "function", "function": {"name": "files__inspect"}}
    call = response.json()["output"][0]
    assert (call["namespace"], call["name"], call["call_id"]) == (
        "files",
        "inspect",
        "call-inspect",
    )
    continuation = {
        **payload,
        "input": [
            call,
            {"type": "function_call_output", "call_id": call["call_id"], "output": "file contents"},
        ],
    }
    _, continued = forward_contract(
        continuation,
        b'{"choices":[{"message":{"content":"done"}}]}',
        wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
    )
    history = json.loads(continued[0].content)["messages"]
    assert history[0]["tool_calls"][0]["function"]["name"] == "files__inspect"
    assert history[1] == {
        "role": "tool",
        "tool_call_id": "call-inspect",
        "content": "file contents",
    }
    assert payload["tools"] == declarations
    assert "namespace" in payload["tool_choice"]


def test_namespaced_chat_stream_restores_tool_identity() -> None:
    payload = {
        "model": "alias",
        "stream": True,
        "input": "Read a file",
        "tools": [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [
                    {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
                ],
            }
        ],
    }
    chunks = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-read",
                                "function": {"name": "functions__exec_", "arguments": "{"},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"name": "command", "arguments": "}"}}
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
    ]
    body = b"".join(b"data: " + json.dumps(chunk).encode() + b"\n\n" for chunk in chunks)
    response, requests = forward_contract(
        payload, body, wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS
    )
    assert response.status_code == 200, response.content
    assert (
        json.loads(requests[0].content)["tools"][0]["function"]["name"] == "functions__exec_command"
    )
    events = [
        json.loads(line[6:])
        for line in response.content.decode().splitlines()
        if line.startswith("data: {")
    ]
    call = next(event["item"] for event in events if event["type"] == "response.output_item.done")
    assert (call["namespace"], call["name"], call["call_id"], call["arguments"]) == (
        "functions",
        "exec_command",
        "call-read",
        "{}",
    )


def test_invalid_chat_namespaces_fail_before_upstream() -> None:
    declaration = {"type": "function", "name": "inspect", "parameters": {"type": "object"}}
    cases = [
        [{"type": "namespace", "name": "files", "tools": "invalid"}],
        [{"type": "namespace", "name": "", "tools": [declaration]}],
        [{"type": "namespace", "name": "files", "tools": [{"type": "custom", "name": "inspect"}]}],
        [{"type": "namespace", "name": "files", "tools": [declaration, declaration]}],
        [
            {"type": "namespace", "name": "files", "tools": [declaration]},
            {**declaration, "name": "files__inspect"},
        ],
    ]
    for declarations in cases:
        response, requests = forward_contract(
            {"model": "alias", "stream": False, "input": "Hello", "tools": declarations},
            b'{"choices":[]}',
            wire_protocol=ModelWireProtocol.CHAT_COMPLETIONS,
        )
        assert response.status_code == 400
        assert not requests


def test_namespace_aliases_are_bounded_and_stable() -> None:
    namespace = "long-namespace-" * 8
    declaration = {
        "type": "namespace",
        "name": namespace,
        "tools": [{"type": "function", "name": "inspect", "parameters": {"type": "object"}}],
    }
    payload = {
        "tools": [declaration],
        "input": [
            {
                "type": "function_call",
                "namespace": namespace,
                "name": "inspect",
                "call_id": "old-call",
                "arguments": "{}",
            }
        ],
    }
    projected, identities = NamespaceTools.project(payload)
    alias = projected["tools"][0]["name"]
    assert len(alias) <= 64
    assert all(character.isalnum() or character in "_-" for character in alias)
    assert projected["input"][0]["name"] == alias
    assert NamespaceTools.project(payload)[0] == projected
    restored = identities.restore({"name": alias, "call_id": "new-call", "arguments": "{}"})
    assert restored == {
        "name": "inspect",
        "namespace": namespace,
        "call_id": "new-call",
        "arguments": "{}",
    }
    assert "namespace" in payload["input"][0]


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


def converted_reasoning_stream_events() -> list[dict]:
    chunks = [
        {
            "id": "chat-response",
            "choices": [{"delta": {"reasoning_content": "think"}, "finish_reason": None}],
        },
        {
            "id": "chat-response",
            "choices": [{"delta": {"content": "answer"}, "finish_reason": "stop"}],
        },
    ]
    upstream = httpx.Response(
        200,
        content=(
            "\n\n".join(f"data: {json.dumps(chunk)}" for chunk in chunks) + "\n\ndata: [DONE]\n\n"
        ).encode(),
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
    message_started = next(
        row
        for row in events
        if row.get("type") == "response.output_item.added"
        and row.get("item", {}).get("type") == "message"
    )
    content_started = next(
        row for row in events if row.get("type") == "response.content_part.added"
    )
    message_completed = next(
        row
        for row in events
        if row.get("type") == "response.output_item.done"
        and row.get("item", {}).get("type") == "message"
    )
    event_types = [row.get("type") for row in events]
    check("normal prose keeps streamed deltas", deltas == ["normal ", "answer"], str(events))
    check(
        "normal prose keeps its complete message event",
        message_completed["item"]["content"][0]["text"] == "normal answer",
        str(events),
    )
    check(
        "message lifecycle starts before text deltas",
        event_types.index("response.output_item.added")
        < event_types.index("response.content_part.added")
        < event_types.index("response.output_text.delta"),
        str(event_types),
    )
    check(
        "message lifecycle keeps one stable item identity",
        message_started["item"]["id"]
        == content_started["item_id"]
        == message_completed["item"]["id"],
        str(events),
    )
    check(
        "text deltas carry their message identity and indexes",
        all(
            row.get("item_id") == message_started["item"]["id"]
            and row.get("output_index") == 0
            and row.get("content_index") == 0
            for row in events
            if row.get("type") == "response.output_text.delta"
        ),
        str(events),
    )
    check(
        "converted response events have monotonic sequence numbers",
        [row.get("sequence_number") for row in events] == list(range(len(events))),
        str(events),
    )
    check(
        "text completion closes content before the message item",
        event_types.index("response.output_text.done")
        < event_types.index("response.content_part.done")
        < event_types.index("response.output_item.done"),
        str(events),
    )


def test_reasoning_completes_before_answer_stream_starts() -> None:
    events = converted_reasoning_stream_events()
    event_types = [row.get("type") for row in events]
    reasoning_started = next(
        row
        for row in events
        if row.get("type") == "response.output_item.added"
        and row.get("item", {}).get("type") == "reasoning"
    )
    reasoning_done = next(
        row
        for row in events
        if row.get("type") == "response.output_item.done"
        and row.get("item", {}).get("type") == "reasoning"
    )
    message_started_index = next(
        index
        for index, row in enumerate(events)
        if row.get("type") == "response.output_item.added"
        and row.get("item", {}).get("type") == "message"
    )
    check(
        "reasoning completes before the answer message starts",
        next(
            index
            for index, row in enumerate(events)
            if row.get("type") == "response.output_item.done"
            and row.get("item", {}).get("type") == "reasoning"
        )
        < message_started_index
        < event_types.index("response.output_text.delta"),
        str(event_types),
    )
    check(
        "raw reasoning remains private content with stable item identity",
        reasoning_done["item"]["id"] == reasoning_started["item"]["id"]
        and reasoning_done["item"]["summary"] == []
        and reasoning_done["item"]["content"] == [{"type": "reasoning_text", "text": "think"}]
        and not any("reasoning_summary" in str(kind) for kind in event_types),
        str(events),
    )


def test_raw_reasoning_roundtrip() -> None:
    reasoning_item = {
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "public summary"}],
        "content": [{"type": "reasoning_text", "text": "private reasoning"}],
    }
    call = {"type": "function_call", "call_id": "call-one", "name": "search", "arguments": "{}"}
    output = {"type": "function_call_output", "call_id": "call-one", "output": "found"}
    answer = {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": "answer"}],
    }
    messages = responses_to_chat_request(
        {"input": [reasoning_item, call, {**call, "call_id": "call-two"}, output, answer]}
    )["messages"]
    check(
        "raw reasoning survives tool continuation without leaking into answer",
        messages[0].get("reasoning_content") == "private reasoning"
        and len(messages[0]["tool_calls"]) == 2
        and all("reasoning_content" not in message for message in messages[1:])
        and "public summary" not in str(messages),
    )
    messages = responses_to_chat_request({"input": [reasoning_item, answer]})["messages"]
    check(
        "raw reasoning belongs to its assistant message",
        messages[0].get("reasoning_content") == "private reasoning"
        and messages[0]["content"] == "answer",
    )
    messages = responses_to_chat_request({"input": [reasoning_item, answer, call, output]})[
        "messages"
    ]
    check(
        "assistant text and tool call share their reasoning owner",
        len(messages) == 2
        and messages[0].get("reasoning_content") == "private reasoning"
        and messages[0]["content"] == "answer"
        and len(messages[0]["tool_calls"]) == 1,
    )
    for boundary in (output, {"type": "message", "role": "user", "content": "next question"}):
        messages = responses_to_chat_request({"input": [reasoning_item, boundary, answer]})[
            "messages"
        ]
        check(
            "reasoning cannot cross user or tool boundary",
            all("reasoning_content" not in message for message in messages),
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


def test_approval_model_does_not_inherit_main_reasoning_effort() -> None:
    options = [
        {"kind": "effort", "values": ["low", "high"], "wire": {"responses": "reasoning.effort"}}
    ]
    body = b'{"id":"response-1","output":[]}'
    approval_model = "review-model"
    review, review_calls = forward_contract(
        {
            "model": approval_model,
            "stream": False,
            "input": "Review",
            "reasoning": {"effort": "high"},
        },
        body,
        wire_protocol=ModelWireProtocol.RESPONSES,
        reasoning_effort="high",
        reasoning_options=options,
        approval_model_ref=approval_model,
    )
    main, main_calls = forward_contract(
        {"model": "main-model", "stream": False, "input": "Continue"},
        body,
        wire_protocol=ModelWireProtocol.RESPONSES,
        reasoning_effort="high",
        reasoning_options=options,
        approval_model_ref=approval_model,
    )
    review_body = json.loads(review_calls[0].content)
    main_body = json.loads(main_calls[0].content)
    check(
        "review model keeps its own reasoning policy",
        review.status_code == 200
        and review_body["model"] == approval_model
        and "reasoning" not in review_body,
    )
    check(
        "main model keeps its selected reasoning effort",
        main.status_code == 200 and main_body["reasoning"]["effort"] == "high",
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
        activities=Activities(),
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


def test_credential_diagnostics_exclude_secrets() -> None:
    credential = "diagnostic.secret.credential"
    with patch("service.chat.service.completions.logger.info") as diagnostic:
        response, requests = forward_contract(
            {"model": "alias", "input": "diagnostic contract", "stream": False},
            b"{}",
            api_key="",
            token_provider=lambda _owner: "",
            owner_id="diagnostic-owner",
        )
        check("diagnostic preserves missing-credential rejection", response.status_code == 401)
        check("diagnostic does not send unauthenticated request", not requests)
        check(
            "request credential diagnostic is emitted",
            any(
                call.args[0].startswith("model_bridge_request_credentials")
                for call in diagnostic.call_args_list
            ),
        )
    with patch("service.identity.service.account_token.logger.info") as diagnostic:
        holder = AccountTokenHolder()
        holder.remember("diagnostic-owner", credential)
        holder.forget("diagnostic-owner")
        holder.clear_all()
        check(
            "credential invalidation diagnostics exclude credential text",
            all(credential not in str(call) for call in diagnostic.call_args_list),
        )


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
    test_credential_diagnostics_exclude_secrets()
    test_http_rejections_publish_known_codes_before_finished_diagnostic()
    test_http_credential_revocation_precedes_provider_authentication_diagnostic()
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
    attachment_response, attachment_requests = forward_contract(
        source_payload,
        b'{"choices":[{"message":{"content":"ok"}}]}',
        source_endpoints=("https://gateway.example/v1",),
        source_text="",
        source_references=(SourceReference(kind="file", identity="attachment-digest"),),
        turn_id_provider=lambda _session: "turn-source",
    )
    attachment_sent = json.loads(attachment_requests[0].content)
    check("attachment source admitted", attachment_response.status_code == 200)
    check(
        "attachment keeps empty original text",
        attachment_sent["scholarseed_content_source"]["text"] == "",
    )
    check(
        "attachment source has references",
        len(attachment_sent["scholarseed_content_source"]["references"]) == 1,
    )
    check(
        "attachment leaves prompt unchanged",
        attachment_sent["messages"][0]["content"] == source_payload["input"],
    )
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
    test_upstream_client_pool_reuses_connections_without_credentials()
    test_upstream_client_pool_reuses_tcp_connection()
    test_native_errors_and_nonstream_responses_are_preserved()
    test_internal_unstructured_rate_limit_retries_before_returning()
    test_transient_server_failures_retry_for_all_bridge_upstreams()
    test_native_stream_coalesces_complete_events()
    test_native_stream_coalesces_logical_text_deltas()
    test_native_stream_coalesces_reasoning_deltas()
    test_reasoning_delta_batcher_preserves_targets_and_unsafe_events()
    test_reasoning_delta_batcher_flushes_on_target_change_and_malformed_type()
    test_reasoning_delta_batcher_preserves_long_streams()
    test_text_delta_batcher_preserves_boundaries_and_unsafe_events()
    test_text_delta_batcher_preserves_sse_ids_and_comments()
    test_text_delta_batcher_exception_boundary()
    test_text_delta_stream_closes_prefetched_source()
    test_text_delta_batcher_preserves_long_stream_text()
    test_text_delta_batcher_flushes_without_another_upstream_event()
    test_reasoning_delta_batcher_flushes_without_another_upstream_event()
    test_native_stream_reports_upstream_and_send_timing()
    test_native_stream_overload_retries_only_before_semantic_output()
    test_connect_phase_failures_retry_before_request_is_sent()
    test_transient_tls_succeeds_on_seventh_attempt()
    test_tls_handshake_timeout_succeeds_on_seventh_attempt()
    test_non_tls_connect_failures_keep_three_attempt_budget()
    test_request_reset_retries_before_response_headers()
    test_response_body_reset_does_not_replay_request()
    test_permanent_tls_failures_do_not_retry()
    test_permanent_dns_failure_does_not_retry()
    test_transport_failure_is_attributable()
    test_function_only_calls_keep_chat_conversion()
    test_chat_protocol_rejects_native_tools_before_upstream()
    test_namespaced_chat_tools_roundtrip()
    test_bridge_projects_upstream_search_capability()
    test_namespaced_chat_stream_restores_tool_identity()
    test_invalid_chat_namespaces_fail_before_upstream()
    test_namespace_aliases_are_bounded_and_stable()
    test_streamed_provider_error_becomes_failed_response()
    test_json_answer_remains_a_successful_answer()
    test_normal_stream_keeps_deltas_and_complete_message()
    test_reasoning_completes_before_answer_stream_starts()
    test_raw_reasoning_roundtrip()
    test_large_inline_image_is_fitted()
    test_small_inline_image_is_preserved()
    test_text_only_oversize_is_not_silently_truncated()
    test_tool_image_output_becomes_multimodal_chat_input()
    test_approval_model_does_not_inherit_main_reasoning_effort()
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
