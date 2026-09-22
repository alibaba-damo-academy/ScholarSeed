"""Authenticated Codex model bridge, preserving native Responses tool semantics."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import random
import secrets
import time
import uuid
from dataclasses import dataclass, field
from email.utils import parsedate_to_datetime
from enum import Enum
from http import HTTPStatus
from io import BytesIO
from typing import Any, AsyncIterator, Awaitable, Callable, Mapping, Sequence

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.types import Message, Receive, Scope, Send

from scholarseed_runtime.contract.model import ModelCredential, ModelThinking, ModelWireProtocol
from service.chat.service.rejections import TRANSIENT_PROVIDER_HTTP_STATUSES
from service.chat.service.streams import (
    RESPONSE_FAILED,
    CompletionDiagnostic,
    NativeResponseNormalizer,
    StreamEnd,
    metadata_token,
)
from service.chat.service.transport import retryable_connect_failure, transport_diagnostics
from service.identity.service.account_token import CONV_TURN_ID_HEADER
from service.inference.reasoning import (
    ThinkingParameters,
    apply_thinking,
    thinking_parameters,
)
from service.inference.source import SOURCE_UNAVAILABLE, accepts_source, attach_source

MODEL_BRIDGE_ROUTE_PREFIX = "/api/internal/model-bridge/"
BRIDGE_ROUTE = f"{MODEL_BRIDGE_ROUTE_PREFIX}{{bridge_id}}/v1/responses"
BRIDGE_MODELS_ROUTE = f"{MODEL_BRIDGE_ROUTE_PREFIX}{{bridge_id}}/v1/models"
MODEL_CATALOG_UNAVAILABLE = "model_catalog_unavailable"
LOOPBACK_HOSTS = frozenset(("127.0.0.1", "::1", "localhost", "testclient"))
UPSTREAM_CONNECT_TIMEOUT_SECONDS = 15.0
UPSTREAM_READ_TIMEOUT_SECONDS = 600.0
CHAT_COMPLETIONS_SUFFIX = "/chat/completions"
SSE_MEDIA_TYPE = "text/event-stream"
JSON_ENCODING = "utf-8"
CHAT_COMPLETIONS_REQUEST_LIMIT_BYTES = 1_000_000
CHAT_COMPLETIONS_REQUEST_TARGET_BYTES = 900_000
INLINE_IMAGE_DATA_PREFIX = "data:image/"
INLINE_IMAGE_BASE64_MARKER = ";base64,"
INLINE_JPEG_DATA_PREFIX = "data:image/jpeg;base64,"
INLINE_IMAGE_DIMENSION_STEPS = (2048, 1600, 1200, 1000, 800, 600, 400, 256)
INLINE_IMAGE_QUALITY_STEPS = (85, 70, 55, 40, 25)
MODEL_BRIDGE_INPUT_TOO_LARGE = "model_bridge_input_too_large"
TOOL_IMAGE_OUTPUT_PLACEHOLDER = "Tool returned image output."
INCOMPLETE_FINISH_REASONS = frozenset(("length", "content_filter"))
COMPLETION_STATUS_INCOMPLETE = "incomplete"
COMPLETION_STATUS_COMPLETED = "completed"
COMPLETION_STATUS_FAILED = "failed"
CHAT_COMPLETIONS_TOOL_TYPE = "function"
RESPONSES_SUFFIX = "/responses"
MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED = "model_bridge_native_tools_unsupported"
MODEL_BRIDGE_CLOSED = "model_bridge_closed"
UPSTREAM_ERROR_MESSAGE_LIMIT = 500
MODEL_FIELD = "model"
RESPONSE_FIELD = "response"
SSE_DATA_PREFIX = b"data:"
SSE_DONE = b"[DONE]"
ADDITIONAL_TOOLS_ITEM_TYPE = "additional_tools"
DEVELOPER_ROLE = "developer"
ITEM_REFERENCE_TYPE = "item_reference"
MODEL_BRIDGE_INVALID_TOOL_INPUT = "model_bridge_invalid_tool_input"
MODEL_BRIDGE_CREDENTIAL_REQUIRED = "model_bridge_credential_required"
MODEL_UPSTREAM_STREAM_ERROR = "model_upstream_stream_error"
UPSTREAM_RATE_LIMIT_STATUS = HTTPStatus.TOO_MANY_REQUESTS
UPSTREAM_RETRY_MAX_ATTEMPTS = 3
UPSTREAM_RETRY_BASE_DELAY_SECONDS = 1.0
UPSTREAM_RETRY_MAX_DELAY_SECONDS = 8.0
UPSTREAM_RETRY_JITTER_RATIO = 0.2
UPSTREAM_RETRY_AFTER_HEADER = "retry-after"


class TransportStage(str, Enum):
    REQUEST = "request"
    RESPONSE_BODY = "response_body"


# 账号腿脱敏分支把上游 >=400 一律折成该码：上游体内可能带厂商内部信息或凭据片段，
# 不能进 Codex 子进程与 renderer。
MODEL_UPSTREAM_REJECTED = "model_upstream_rejected"
# 产品级上游错误码登记：这些码出自自有网关的业务信封（429 的 ``detail.error``），
# 属产品语义而非厂商内部信息，客户端要按它分支渲染文案（如积分耗尽）。脱敏分支只放行
# 命中登记的码；新增产品码在此登记，adapter 与 renderer 各自登记自己的文案与语义。
PRODUCT_UPSTREAM_ERROR_CODES = frozenset({"credit_balance_exhausted"})

# 注册项存活上限（秒）。register() 在每次 session_spec（即每次 open / rebind / _resume）都会
# 生成新 bridge_id，之前永久留在 dict 里且内含 api_key：长跑 serve 会无界增长，且旧
# bridge_id 一直可用（loopback 可达即可调用）。每条记录现在还多了 per-session 计量头，
# 不淘汰会把这个问题放大。
BRIDGE_REGISTRATION_TTL_SECONDS = 12 * 3600

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CompletionRegistration:
    bridge_id: str
    base_url: str


@dataclass(frozen=True)
class StructuredStreamError:
    """Provider error returned incorrectly inside a successful text stream."""

    code: str
    message: str


class CompletionCredentialError(ValueError):
    """Credential policy failure carrying only a safe public error code."""


@dataclass(eq=False)
class CompletionCall:
    """Own one upstream connection across response creation and stream consumption."""

    loop: asyncio.AbstractEventLoop
    task: asyncio.Task | None
    on_closed: Callable[[CompletionCall], None]
    diagnostic: CompletionDiagnostic
    client: httpx.AsyncClient | None = None
    response: httpx.Response | None = None
    streaming: bool = False
    revoked: bool = False
    closing: asyncio.Task | None = None

    def revoke(self) -> None:
        self.revoked = True
        self.loop.call_soon_threadsafe(self._cancel)

    def _cancel(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
        if self.closing is None:
            self.closing = self.loop.create_task(self._close())
            self.closing.add_done_callback(self._observe_close)

    @staticmethod
    def _observe_close(task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()

    async def _close(self) -> None:
        try:
            try:
                if self.response is not None:
                    await self.response.aclose()
            finally:
                if self.client is not None:
                    await self.client.aclose()
        finally:
            self.on_closed(self)

    async def close(self) -> None:
        if self.closing is None:
            self.closing = self.loop.create_task(self._close())
            self.closing.add_done_callback(self._observe_close)
        await asyncio.shield(self.closing)


class CompletionStream(StreamingResponse):
    """Close the upstream even when ASGI fails before entering the body iterator."""

    def __init__(self, content: AsyncIterator[bytes], call: CompletionCall) -> None:
        super().__init__(content, media_type=SSE_MEDIA_TYPE)
        self.call = call

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        reason = StreamEnd.EOF.value

        async def observed_send(message: Message) -> None:
            await send(message)
            if message["type"] == "http.response.body":
                self.call.diagnostic.downstream.feed(message.get("body", b""))

        try:
            await super().__call__(scope, receive, observed_send)
        except asyncio.CancelledError:
            reason = StreamEnd.CANCELLED.value
            raise
        except Exception as error:
            reason = StreamEnd.BRIDGE_ERROR.value
            if not self.call.diagnostic.failure_type:
                self.call.diagnostic.failure_type = type(error).__name__
            raise
        finally:
            if self.call.revoked:
                reason = StreamEnd.REVOKED.value
            elif self.call.diagnostic.upstream_end == StreamEnd.NOT_STARTED.value:
                reason = StreamEnd.CONSUMER_CLOSED.value
            elif self.call.diagnostic.upstream_end in (
                StreamEnd.TRANSPORT_ERROR.value,
                StreamEnd.PROVIDER_ERROR.value,
            ):
                reason = self.call.diagnostic.upstream_end
            elif (
                reason == StreamEnd.EOF.value
                and self.call.diagnostic.upstream_end == StreamEnd.CANCELLED.value
            ):
                reason = StreamEnd.CONSUMER_CLOSED.value
            try:
                await self.call.close()
            finally:
                self.call.diagnostic.finish(reason)


@dataclass
class CompletionUpstream:
    """One registered upstream plus how its outbound call is credentialed.

    ``token_provider`` exists because the gateway's ``Authorization: Bearer`` accepts either a
    ``dgw_`` caller key or a user access JWT, and the JWT is strictly better: it identifies a
    person, is revocable, and makes attribution fall out of authentication. It must be resolved
    per call rather than snapshotted here — ``register`` runs when a session opens while the
    token expires in 7 days, and the gateway's auth leg checks ``exp``.

    ``owner_id`` says *whose* token to resolve, and is a mutable field rather than something the
    provider closes over: a desktop user can switch accounts while this session stays warm in
    memory, and a captured id would keep the outbound call on the signed-out account's slot
    (gateway answers ``401 invalid user token``). ``rebind_owner`` moves it without minting a new
    ``bridge_id``, so the running Codex subprocess never sees its provider base URL change.

    ``api_key`` stays as the fallback for sessions with no logged-in user, but the desktop no
    longer ships one: ``seed_user_config`` strips credentials out of the packaged seed, so this
    field is only ever set by a self-configured install (dev machine or self-hosted gateway).
    With neither a token nor a key the outbound call carries no ``Authorization`` and the gateway
    rejects it — that is the intended shape, since an out-of-the-box shared caller key identifies
    nobody and cannot be revoked per user.

    ``trust_env`` is registration-scoped because fixed subscription endpoints may deliberately
    inherit the user's proxy environment while arbitrary custom endpoints keep the direct default.

    ``turn_id_provider`` is the metering counterpart of ``token_provider``: same shape (handed in at
    registration, invoked per call), different reason. ``headers`` are a registration-time snapshot
    because they carry the *session* dimension, and one registration belongs to exactly one session.
    A turn cannot be snapshotted the same way — one registration spans every turn that session ever
    runs, and the gateway needs the turn dimension to price one conversation turn (proposal 70 §5.9:
    the credit usage detail is one row per ``(turn, model)``). So the turn id is resolved when the
    call leaves, keyed by this upstream's own ``session_id``; the turn header is *added next to* the
    snapshot, never substituted for it, since the gateway reads the two as different columns.
    """

    endpoint: str
    api_key: str = field(repr=False)
    headers: dict[str, str] = field(repr=False)
    model_routes: dict[str, str] = field(default_factory=dict)
    token_provider: Callable[[str], str] | None = None
    turn_id_provider: Callable[[str], str] | None = None
    owner_id: str = ""
    session_id: str = ""
    source_text: str | None = field(default=None, repr=False)
    responses_endpoint: str = ""
    wire_protocol: ModelWireProtocol | None = None
    connection_id: str = ""
    credential_resolver: Callable[[str, str], Awaitable[ModelCredential]] | None = field(
        default=None, repr=False
    )
    request_policy: Callable[[Mapping[str, Any]], dict[str, Any]] | None = None
    catalog_resolver: Callable[[str, str], Awaitable[dict[str, Any]]] | None = field(
        default=None, repr=False
    )
    trust_env: bool = False
    reasoning_effort: str | None = None
    thinking: ModelThinking | None = None
    reasoning_options: tuple[Mapping[str, Any], ...] | None = None
    provider: str = ""
    active: bool = True
    calls: set[CompletionCall] = field(default_factory=set, repr=False)
    created_at: float = field(default_factory=time.monotonic)
    last_used_at: float = field(default_factory=time.monotonic)

    def bearer(self) -> str:
        """本次调用的 Authorization 凭据：有用户 token 先用它，否则回退到调用方 key。"""

        if self.token_provider is not None and self.owner_id:
            try:
                token = str(self.token_provider(self.owner_id) or "").strip()
            except Exception:  # noqa: BLE001 - 取凭据失败不能打断模型调用
                logger.warning("model_bridge_token_provider_failed")
                token = ""
            if token:
                return token
        return self.api_key

    def turn_id(self) -> str:
        """本次调用所属的产品轮 id；没有钩子 / 不在轮内 / 解析失败一律空串。

        空串等于「不发这个头」，与网关对会话头的缺省语义一致（缺省空串 = 不归并）。
        """

        if self.turn_id_provider is None or not self.session_id:
            return ""
        try:
            return str(self.turn_id_provider(self.session_id) or "").strip()
        except Exception:  # noqa: BLE001 - 取轮 id 失败不能打断模型调用
            logger.warning("model_bridge_turn_id_provider_failed")
            return ""

    def call_headers(self) -> dict[str, str]:
        """本次调用要带的附加头：注册期快照的会话粒度头 + 每请求解析的轮粒度头。"""

        headers = dict(self.headers)
        turn_id = self.turn_id()
        if turn_id:
            headers[CONV_TURN_ID_HEADER] = turn_id
        return headers

    def route_model(self, model: object) -> str:
        """Resolve an exact per-session auxiliary model alias for this upstream."""

        requested = str(model or "").strip()
        return self.model_routes.get(requested, requested)


@dataclass
class CompletionModelObservation:
    """Observe response model provenance without changing the upstream wire stream."""

    notify: Callable[[str], None]
    model: str = ""
    pending: bytes = b""
    data: list[bytes] = field(default_factory=list)

    def observe(self, payload: Mapping[str, Any]) -> None:
        nested = payload.get(RESPONSE_FIELD)
        source = nested if isinstance(nested, Mapping) else payload
        model = source.get(MODEL_FIELD)
        if isinstance(model, str) and model.strip() and model.strip() != self.model:
            self.model = model.strip()
            self.notify(self.model)

    def body(self, body: bytes) -> None:
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return
        if isinstance(payload, Mapping):
            self.observe(payload)

    def feed(self, chunk: bytes) -> None:
        self.pending += chunk
        while b"\n" in self.pending:
            line, self.pending = self.pending.split(b"\n", 1)
            line = line.rstrip(b"\r")
            if not line:
                if self.data:
                    self.body(b"\n".join(self.data))
                    self.data.clear()
            elif line.startswith(SSE_DATA_PREFIX):
                value = line[len(SSE_DATA_PREFIX) :].lstrip(b" ")
                if value != SSE_DONE:
                    self.data.append(value)


class CompletionBridge:
    """Hold private upstream credentials and translate one Codex Responses call."""

    def __init__(
        self,
        internal_base_url: str,
        *,
        on_model: Callable[[str, str, str], None] | None = None,
        on_diagnostic: Callable[[str, Mapping[str, Any]], None] | None = None,
        turn_ids: Callable[[str], str] | None = None,
        source_text: Callable[[str, str], str | None] | None = None,
        source_endpoints: Sequence[str] = (),
        shared_ownership: bool = False,
    ) -> None:
        self._on_model = on_model
        self._on_diagnostic = on_diagnostic
        self._turn_ids = turn_ids
        self._source_text = source_text
        self._source_endpoints = tuple(source_endpoints)
        self._internal_base_url = internal_base_url.rstrip("/")
        # machine 轴下订阅桥归这台机器所有, 切账号不该把它拆掉(见 rebind_owner)。
        self._shared_ownership = bool(shared_ownership)
        self._upstreams: dict[str, CompletionUpstream] = {}
        self._calls: set[CompletionCall] = set()
        self._closed = False

    def accepts_source(self, endpoint: str) -> bool:
        return accepts_source(endpoint, self._source_endpoints)

    def register(
        self,
        *,
        endpoint: str,
        api_key: str,
        headers: Mapping[str, Any] | None = None,
        model_routes: Mapping[str, str] | None = None,
        token_provider: Callable[[str], str] | None = None,
        turn_id_provider: Callable[[str], str] | None = None,
        owner_id: str = "",
        session_id: str = "",
        source_text: str | None = None,
        responses_endpoint: str = "",
        wire_protocol: ModelWireProtocol | None = None,
        connection_id: str = "",
        credential_resolver: Callable[[str, str], Awaitable[ModelCredential]] | None = None,
        request_policy: Callable[[Mapping[str, Any]], dict[str, Any]] | None = None,
        catalog_resolver: Callable[[str, str], Awaitable[dict[str, Any]]] | None = None,
        trust_env: bool = False,
        reasoning_effort: str | None = None,
        thinking: ModelThinking | None = None,
        reasoning_options: Sequence[Mapping[str, Any]] | None = None,
        provider: str = "",
    ) -> CompletionRegistration:
        if self._closed:
            raise ValueError(MODEL_BRIDGE_CLOSED)
        if not self._internal_base_url:
            raise ValueError("ScholarSeed completion bridge base URL is unavailable")
        target = endpoint.strip()
        if not target:
            raise ValueError("Chat Completions endpoint is missing")
        if credential_resolver is not None and (not owner_id.strip() or not connection_id.strip()):
            raise ValueError("credentialed model connection requires an owner and connection id")
        if wire_protocol == ModelWireProtocol.RESPONSES and not responses_endpoint.strip():
            raise ValueError("Responses model connection requires a Responses endpoint")
        self._evict_expired()
        bridge_id = secrets.token_urlsafe(24)
        private_headers = {
            str(name).strip(): str(value).strip()
            for name, value in dict(headers or {}).items()
            if str(name).strip() and str(value).strip()
        }
        routes = {
            str(source).strip(): str(target).strip()
            for source, target in dict(model_routes or {}).items()
            if str(source).strip() and str(target).strip()
        }
        self._upstreams[bridge_id] = CompletionUpstream(
            endpoint=target,
            api_key=api_key.strip(),
            headers=private_headers,
            model_routes=routes,
            token_provider=token_provider,
            turn_id_provider=turn_id_provider,
            owner_id=str(owner_id or "").strip(),
            session_id=str(session_id or ""),
            source_text=source_text,
            responses_endpoint=responses_endpoint.strip(),
            wire_protocol=wire_protocol,
            connection_id=connection_id,
            credential_resolver=credential_resolver,
            request_policy=request_policy,
            catalog_resolver=catalog_resolver,
            trust_env=trust_env,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
            reasoning_options=(
                tuple(dict(option) for option in reasoning_options)
                if reasoning_options is not None
                else None
            ),
            provider=provider,
        )
        return CompletionRegistration(
            bridge_id=bridge_id,
            base_url=(f"{self._internal_base_url}/api/internal/model-bridge/{bridge_id}/v1"),
        )

    def rebind_owner(self, session_id: str, owner_id: str) -> int:
        """Point one session's registrations at the account that is driving it now.

        A warm session outlives a desktop account switch, and the outbound token is resolved
        from whichever slot ``owner_id`` names — so without this the call keeps reaching for the
        signed-out account's token and the gateway rejects it. Rewritten in place on purpose:
        minting a new ``bridge_id`` would strand the running Codex subprocess on the old URL.
        """

        owner = str(session_id or "")
        actor = str(owner_id or "").strip()
        if not owner or not actor:
            return 0
        moved = 0
        for key, upstream in tuple(self._upstreams.items()):
            if (
                upstream.session_id == owner
                and upstream.credential_resolver is not None
                and upstream.owner_id != actor
            ):
                # 共享归属下订阅桥归这台机器(注册 owner 是机器级 principal), 与当前驱动的
                # 账号天然不同值, 而它的凭据按 connection_id 解析、与账号无关: 按账号失效
                # 只会把正在跑的 Codex 子进程脚下的桥抽掉(后续每次调用 404)。
                if not self._shared_ownership:
                    self._invalidate(key)
                    moved += 1
                continue
            if (
                upstream.session_id == owner
                and upstream.token_provider is not None
                and upstream.owner_id != actor
            ):
                upstream.owner_id = actor
                moved += 1
        return moved

    def release(self, session_id: str) -> int:
        """Drop every registration owned by one session (called when it closes).

        Lazy TTL eviction alone would keep a closed session's credentials callable for
        hours; releasing on close is what actually bounds the window.
        """

        owner = str(session_id or "")
        if not owner:
            return 0
        stale = [key for key, up in self._upstreams.items() if up.session_id == owner]
        for key in stale:
            self._invalidate(key)
        return len(stale)

    def _invalidate(self, bridge_id: str) -> None:
        upstream = self._upstreams.pop(bridge_id, None)
        if upstream is not None:
            upstream.active = False
            for call in tuple(upstream.calls):
                call.revoke()

    def revoke_connection(self, owner_id: str, connection_id: str) -> int:
        keys = [
            key
            for key, upstream in self._upstreams.items()
            if upstream.owner_id == owner_id and upstream.connection_id == connection_id
        ]
        for key in keys:
            self._invalidate(key)
        return len(keys)

    def revoke_owner(self, owner_id: str) -> int:
        keys = [
            key
            for key, upstream in self._upstreams.items()
            if upstream.owner_id == owner_id and upstream.credential_resolver is not None
        ]
        for key in keys:
            self._invalidate(key)
        return len(keys)

    async def close(self) -> None:
        self._closed = True
        calls = tuple(self._calls)
        for key in tuple(self._upstreams):
            self._invalidate(key)
        await asyncio.gather(*(call.close() for call in calls), return_exceptions=True)

    def registration_count(self) -> int:
        """Live registration count (contract tests assert this stays bounded)."""

        return len(self._upstreams)

    def _evict_expired(self, *, now: float | None = None) -> int:
        """Drop registrations unused for longer than the TTL.

        Done lazily on register rather than from a background task: one more lifecycle to
        own is worse than a scan whose cost is bounded by the live registration count.
        """

        moment = time.monotonic() if now is None else now
        stale = [
            key
            for key, up in self._upstreams.items()
            if moment - up.last_used_at > BRIDGE_REGISTRATION_TTL_SECONDS
        ]
        for key in stale:
            self._invalidate(key)
        if stale:
            logger.info("model_bridge_registrations_evicted count=%d", len(stale))
        return len(stale)

    async def catalog(self, bridge_id: str) -> Response:
        if self._closed:
            return JSONResponse({"error": {"code": MODEL_BRIDGE_CLOSED}}, status_code=503)
        self._evict_expired()
        upstream = self._upstreams.get(bridge_id)
        if upstream is None or not upstream.active or upstream.catalog_resolver is None:
            return JSONResponse({"error": {"code": MODEL_CATALOG_UNAVAILABLE}}, status_code=404)
        upstream.last_used_at = time.monotonic()
        owner_id = upstream.owner_id
        try:
            payload = await upstream.catalog_resolver(owner_id, upstream.connection_id)
        except Exception as error:
            logger.warning(
                "model_catalog_failed session_id=%s error_class=%s",
                upstream.session_id,
                type(error).__name__,
            )
            return JSONResponse({"error": {"code": MODEL_CATALOG_UNAVAILABLE}}, status_code=502)
        if not upstream.active or self._closed or upstream.owner_id != owner_id:
            return JSONResponse({"error": {"code": MODEL_CATALOG_UNAVAILABLE}}, status_code=410)
        return JSONResponse(payload)

    async def forward(self, bridge_id: str, payload: Mapping[str, Any]) -> Response:
        if self._closed:
            return JSONResponse({"error": {"code": MODEL_BRIDGE_CLOSED}}, status_code=503)
        upstream = self._upstreams.get(bridge_id)
        if upstream is None:
            return JSONResponse({"error": {"message": "model bridge not found"}}, status_code=404)

        def deregister(call: CompletionCall) -> None:
            upstream.calls.discard(call)
            self._calls.discard(call)

        diagnostic = CompletionDiagnostic(
            upstream.session_id, str(payload.get(MODEL_FIELD) or ""), self._on_diagnostic
        )
        diagnostic.observe_input(payload)
        diagnostic.turn_id = upstream.turn_id()
        if not diagnostic.turn_id and self._turn_ids is not None and upstream.session_id:
            diagnostic.turn_id = str(self._turn_ids(upstream.session_id) or "").strip()
        diagnostic.emit("started")
        call = CompletionCall(
            asyncio.get_running_loop(), asyncio.current_task(), deregister, diagnostic
        )
        upstream.calls.add(call)
        self._calls.add(call)
        reason = StreamEnd.EOF.value
        try:
            result = await self._forward(upstream, payload, call)
            if result.status_code >= 400:
                reason = StreamEnd.HTTP_ERROR.value
            return result
        except asyncio.CancelledError:
            reason = StreamEnd.REVOKED.value if call.revoked else StreamEnd.CANCELLED.value
            raise
        except Exception as error:
            reason = StreamEnd.BRIDGE_ERROR.value
            diagnostic.failure_type = type(error).__name__
            raise
        finally:
            call.task = None
            if not call.streaming:
                try:
                    await call.close()
                finally:
                    diagnostic.finish(reason)

    async def _forward(
        self, upstream: CompletionUpstream, payload: Mapping[str, Any], call: CompletionCall
    ) -> Response:
        upstream.last_used_at = time.monotonic()
        try:
            payload, converted_items = normalize_response_input(payload)
        except ValueError:
            return JSONResponse(
                {"error": {"code": MODEL_BRIDGE_INVALID_TOOL_INPUT}}, status_code=400
            )
        call.diagnostic.converted_input_items = converted_items
        native_tool_types = sorted(
            {
                str(tool.get("type") or "")
                for tool in payload.get("tools") or []
                if isinstance(tool, Mapping) and tool.get("type") != CHAT_COMPLETIONS_TOOL_TYPE
            }
        )
        if native_tool_types and upstream.wire_protocol == ModelWireProtocol.CHAT_COMPLETIONS:
            logger.info(
                "model_bridge_native_tools_omitted session_id=%s wire=%s native_tools=%s effort=%s",
                upstream.session_id,
                upstream.wire_protocol.value,
                native_tool_types,
                upstream.reasoning_effort or "default",
            )
        native_response = upstream.wire_protocol == ModelWireProtocol.RESPONSES or (
            upstream.wire_protocol is None and bool(native_tool_types)
        )
        if native_response:
            chat_request = dict(payload)
        else:
            chat_request = responses_to_chat_request(payload)
        protocol = (
            ModelWireProtocol.RESPONSES if native_response else ModelWireProtocol.CHAT_COMPLETIONS
        )
        resolution: ThinkingParameters | None = None
        if upstream.reasoning_effort is not None or upstream.thinking is not None:
            resolution = thinking_parameters(
                upstream.reasoning_options,
                protocol.value,
                upstream.provider,
                effort=upstream.reasoning_effort or "",
                thinking=upstream.thinking,
            )
            chat_request = apply_thinking(
                chat_request,
                upstream.reasoning_options,
                protocol.value,
                upstream.provider,
                resolution,
            )
        endpoint = upstream.endpoint
        if native_response:
            if not upstream.responses_endpoint:
                return JSONResponse(
                    {
                        "error": {
                            "code": MODEL_BRIDGE_NATIVE_TOOLS_UNSUPPORTED,
                            "message": "Native tools require a configured Responses endpoint.",
                        }
                    },
                    status_code=400,
                )
            endpoint = upstream.responses_endpoint
            logger.info(
                "model_bridge_native_tools session_id=%s types=%s tool_count=%d",
                upstream.session_id,
                native_tool_types,
                len(chat_request.get("tools") or []),
            )
        if upstream.request_policy is not None:
            try:
                chat_request = upstream.request_policy(chat_request)
            except ValueError:
                return JSONResponse({"error": {"code": "model_request_invalid"}}, status_code=400)
        chat_request["model"] = upstream.route_model(chat_request.get("model"))
        call.diagnostic.routed_model = str(chat_request["model"])
        call.diagnostic.wire_protocol = protocol.value
        logger.info(
            "model_bridge_reasoning session_id=%s model=%s effort=%s wire=%s",
            upstream.session_id,
            chat_request["model"],
            (
                f"{resolution.effort or resolution.reason or 'provider_default'}"
                if resolution is not None
                else "not_overridden"
            ),
            protocol.value,
        )
        request_bytes_before = _json_size(chat_request)
        if not native_response and request_bytes_before > CHAT_COMPLETIONS_REQUEST_LIMIT_BYTES:
            try:
                compacted_images = await asyncio.to_thread(
                    _fit_inline_images,
                    chat_request,
                    CHAT_COMPLETIONS_REQUEST_TARGET_BYTES,
                )
            except ValueError as exc:
                summary = _largest_message_summary(chat_request)
                logger.error(
                    "model_bridge_input_fit_failed reason=%s request_bytes=%d image_count=%d "
                    "max_role=%s content_type=%s content_chars=%d embedded_images=%d "
                    "json_type=%s json_keys=%s",
                    str(exc),
                    request_bytes_before,
                    len(_inline_image_slots(chat_request)),
                    summary["role"],
                    summary["content_type"],
                    summary["content_chars"],
                    summary["embedded_images"],
                    summary["json_type"],
                    summary["json_keys"],
                )
                return JSONResponse(
                    {
                        "error": {
                            "code": MODEL_BRIDGE_INPUT_TOO_LARGE,
                            "message": "Model input is too large and contains no compressible image.",
                        }
                    },
                    status_code=413,
                )
            request_bytes_after = _json_size(chat_request)
            if request_bytes_after > CHAT_COMPLETIONS_REQUEST_LIMIT_BYTES:
                return JSONResponse(
                    {
                        "error": {
                            "code": MODEL_BRIDGE_INPUT_TOO_LARGE,
                            "message": "Model input remains too large after image compression.",
                        }
                    },
                    status_code=413,
                )
            logger.info(
                "model_bridge_inline_images_compacted request_bytes_before=%d "
                "request_bytes_after=%d image_count=%d",
                request_bytes_before,
                request_bytes_after,
                compacted_images,
            )
        headers = {"Accept": SSE_MEDIA_TYPE if chat_request.get("stream") else "application/json"}
        # 网关的 Authorization 位接受用户 JWT 或 `dgw_` 调用方 key；优先用前者，它让鉴权与
        # 归属一步完成，不需要另带一个计量头。
        if upstream.credential_resolver is not None:
            try:
                material = await upstream.credential_resolver(
                    upstream.owner_id, upstream.connection_id
                )
            except CompletionCredentialError as error:
                call.diagnostic.status_code = 401
                call.diagnostic.failure_type = str(error)
                return JSONResponse({"error": {"code": str(error)}}, status_code=401)
            headers.update(material.headers)
            if material.api_key:
                headers["Authorization"] = f"Bearer {material.api_key}"
        else:
            bearer = upstream.bearer()
            if upstream.token_provider is not None and not bearer:
                call.diagnostic.status_code = 401
                call.diagnostic.failure_type = MODEL_BRIDGE_CREDENTIAL_REQUIRED
                return JSONResponse(
                    {"error": {"code": MODEL_BRIDGE_CREDENTIAL_REQUIRED}}, status_code=401
                )
            if bearer:
                headers["Authorization"] = f"Bearer {bearer}"
            headers.update(upstream.call_headers())
        if not upstream.active or call.revoked:
            return JSONResponse({"error": {"code": "model_connection_revoked"}}, status_code=410)
        captured_turn_id = call.diagnostic.turn_id
        call.diagnostic.protect(headers)

        def observed_model(model: str) -> None:
            if self._on_model is not None and upstream.session_id and captured_turn_id:
                self._on_model(upstream.session_id, captured_turn_id, model)

        observation = CompletionModelObservation(observed_model)
        if self.accepts_source(endpoint):
            text = (
                upstream.source_text
                if upstream.source_text is not None
                else (
                    self._source_text(upstream.session_id, captured_turn_id)
                    if self._source_text
                    else None
                )
            )
            if text is None or not text.strip():
                return JSONResponse({"error": {"code": SOURCE_UNAVAILABLE}}, status_code=400)
            chat_request = attach_source(
                chat_request, session_id=upstream.session_id, turn_id=captured_turn_id, text=text
            )
            logger.info(
                "model_content_source session_id=%s turn_id=%s chars=%d",
                upstream.session_id,
                captured_turn_id,
                len(text),
            )
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=UPSTREAM_CONNECT_TIMEOUT_SECONDS,
                read=UPSTREAM_READ_TIMEOUT_SECONDS,
                write=UPSTREAM_CONNECT_TIMEOUT_SECONDS,
                pool=UPSTREAM_CONNECT_TIMEOUT_SECONDS,
            ),
            trust_env=upstream.trust_env,
        )
        call.client = client
        call.diagnostic.max_attempts = UPSTREAM_RETRY_MAX_ATTEMPTS
        send_started_at = time.perf_counter()
        attempt = 1
        try:
            while True:
                request = client.build_request(
                    "POST",
                    endpoint,
                    json=chat_request,
                    headers=headers,
                )
                call.diagnostic.attempt = attempt
                try:
                    response = await client.send(request, stream=True)
                except httpx.TransportError as error:
                    diagnostics = transport_diagnostics(error)
                    if attempt >= UPSTREAM_RETRY_MAX_ATTEMPTS or not retryable_connect_failure(
                        error, diagnostics["category"]
                    ):
                        raise
                    delay = _retry_backoff_delay(attempt)
                    logger.warning(
                        "model_bridge_upstream_connect_retry session_id=%s "
                        "failure_type=%s category=%s attempt=%d max_attempts=%d "
                        "delay_seconds=%.3f",
                        upstream.session_id,
                        diagnostics["failure_type"],
                        diagnostics["category"],
                        attempt,
                        UPSTREAM_RETRY_MAX_ATTEMPTS,
                        delay,
                    )
                    attempt += 1
                    await asyncio.sleep(delay)
                    if call.revoked or not upstream.active:
                        raise asyncio.CancelledError() from error
                    continue
                if call.revoked:
                    await response.aclose()
                    raise asyncio.CancelledError()
                retryable = response.status_code in TRANSIENT_PROVIDER_HTTP_STATUSES
                if response.status_code == UPSTREAM_RATE_LIMIT_STATUS:
                    retryable = _retryable_internal_rate_limit(upstream, await response.aread())
                if attempt < UPSTREAM_RETRY_MAX_ATTEMPTS and retryable:
                    delay = _upstream_retry_delay(response, attempt)
                    logger.warning(
                        "model_bridge_upstream_retry session_id=%s status=%d "
                        "attempt=%d max_attempts=%d delay_seconds=%.3f",
                        upstream.session_id,
                        response.status_code,
                        attempt,
                        UPSTREAM_RETRY_MAX_ATTEMPTS,
                        delay,
                    )
                    await response.aclose()
                    attempt += 1
                    await asyncio.sleep(delay)
                    if call.revoked or not upstream.active:
                        raise asyncio.CancelledError()
                    continue
                break
            call.response = response
            call.diagnostic.status_code = response.status_code
            call.diagnostic.content_type = metadata_token(
                response.headers.get("content-type", "").split(";", 1)[0].strip()
            )
            call.diagnostic.upstream_request_id = metadata_token(
                response.headers.get("x-request-id", "")
            )
            call.diagnostic.emit("headers")
        except Exception as exc:  # noqa: BLE001 - translate transport failure at HTTP boundary
            call.diagnostic.upstream_end = StreamEnd.TRANSPORT_ERROR.value
            diagnostics = _record_transport_failure(
                call.diagnostic,
                exc,
                stage=TransportStage.REQUEST,
                endpoint=endpoint,
            )
            await call.close()
            metrics = _chat_request_metrics(chat_request)
            logger.warning(
                "model_bridge_upstream_transport_failed session_id=%s model=%s wire=%s "
                "endpoint=%s elapsed_ms=%.1f failure_type=%s category=%s "
                "cause_chain=%s root_type=%s errno=%s errno_name=%s errno_text=%s "
                "native_tools=%s request_bytes=%d messages_bytes=%d message_count=%d "
                "tool_count=%d max_message_bytes=%d",
                upstream.session_id,
                chat_request.get("model"),
                "responses" if native_response else "chat_completions",
                _redacted_endpoint(endpoint),
                (time.perf_counter() - send_started_at) * 1000,
                diagnostics["failure_type"],
                diagnostics["category"],
                diagnostics["cause_chain"],
                diagnostics["root_type"],
                diagnostics["errno"],
                diagnostics["errno_name"],
                diagnostics["errno_text"],
                native_tool_types,
                metrics["request_bytes"],
                metrics["messages_bytes"],
                metrics["message_count"],
                metrics["tool_count"],
                metrics["max_message_bytes"],
            )
            return JSONResponse(
                {
                    "error": {
                        "message": f"Chat Completions upstream unavailable: {type(exc).__name__}"
                    }
                },
                status_code=502,
            )
        if response.status_code >= 400:
            try:
                body = await response.aread()
            finally:
                await call.close()
            product_code = _product_error_code(body)
            if upstream.credential_resolver is not None:
                summary = _upstream_error_summary(body)
                logger.warning(
                    "model_connection_upstream_rejected status=%d code=%s type=%s param=%s "
                    "product_code=%s",
                    response.status_code,
                    summary["code"],
                    summary["type"],
                    summary["param"],
                    product_code or "-",
                )
                return JSONResponse(
                    {"error": {"code": product_code or MODEL_UPSTREAM_REJECTED}},
                    status_code=response.status_code,
                )
            if product_code:
                # 内置计费网关（无 credential_resolver）同样可能返回已登记的产品级
                # 错误码（如 credit_balance_exhausted）。此前只有 OAuth 个人凭据分支
                # 会提取并放行 product_code，内置网关分支会原样透传未脱敏 body，
                # 导致下游（Codex adapter/前端）拿不到码，只能落到通用异常文案。
                # 命中已登记码时两条分支必须给出同样的信封，不看 credential_resolver。
                upstream_error = _upstream_error_summary(body)
                logger.warning(
                    "model_bridge_upstream_product_error status=%d code=%s product_code=%s",
                    response.status_code,
                    upstream_error["code"],
                    product_code,
                )
                return JSONResponse(
                    {"error": {"code": product_code}},
                    status_code=response.status_code,
                )
            content_type = response.headers.get("content-type", "application/json")
            upstream_error = _upstream_error_summary(body)
            logger.error(
                "model_bridge_upstream_error status=%d code=%s type=%s param=%s "
                "message=%s native_tools=%s metrics=%s",
                response.status_code,
                upstream_error["code"],
                upstream_error["type"],
                upstream_error["param"],
                upstream_error["message"],
                native_tool_types,
                _chat_request_metrics(chat_request),
            )
            return Response(content=body, status_code=response.status_code, media_type=content_type)
        if not chat_request.get("stream"):
            try:
                body = await response.aread()
            finally:
                await call.close()
            observation.body(body)
            if native_response:
                return Response(content=body, media_type="application/json")
            try:
                converted = chat_response_to_response(json.loads(body))
            except (TypeError, ValueError, json.JSONDecodeError):
                return JSONResponse(
                    {"error": {"message": "invalid Chat Completions response"}},
                    status_code=502,
                )
            return JSONResponse(converted)

        async def stream() -> AsyncIterator[bytes]:
            call.task = asyncio.current_task()

            def settle_upstream_end() -> None:
                # 带 error 的 response.failed 终态是供应商拒绝，不是干净的流结束：升格
                # PROVIDER_ERROR 并用真实 error_code 记 failure_type，使 serve 侧记录不再
                # 是 eof/failure_type=""（proposal 106 R4）。downstream 观测已脱敏/有界。
                downstream = call.diagnostic.downstream
                if downstream.terminal == RESPONSE_FAILED and downstream.error_code:
                    call.diagnostic.upstream_end = StreamEnd.PROVIDER_ERROR.value
                    call.diagnostic.failure_type = downstream.error_code
                else:
                    call.diagnostic.upstream_end = StreamEnd.EOF.value

            try:
                if call.revoked or not upstream.active:
                    raise asyncio.CancelledError()
                if native_response:
                    normalizer = NativeResponseNormalizer()
                    async for chunk in response.aiter_bytes():
                        call.diagnostic.upstream.feed(chunk)
                        observation.feed(chunk)
                        for normalized_chunk in normalizer.feed(chunk):
                            yield normalized_chunk
                        upstream_stream = call.diagnostic.upstream
                        if upstream_stream.error_seen and not upstream_stream.terminal:
                            for normalized_chunk in normalizer.finish():
                                yield normalized_chunk
                            yield _sse(
                                {
                                    "type": "response.failed",
                                    "response": {
                                        "status": COMPLETION_STATUS_FAILED,
                                        "error": {
                                            "code": upstream_stream.error_code
                                            or MODEL_UPSTREAM_STREAM_ERROR,
                                            "message": upstream_stream.error_message
                                            or "Upstream returned a stream error.",
                                            **(
                                                {"type": upstream_stream.error_type}
                                                if upstream_stream.error_type
                                                else {}
                                            ),
                                        },
                                    },
                                }
                            )
                            call.diagnostic.upstream_end = StreamEnd.PROVIDER_ERROR.value
                            return
                    for normalized_chunk in normalizer.finish():
                        yield normalized_chunk
                    settle_upstream_end()
                    return
                async for chunk in chat_stream_to_responses(
                    response,
                    request_metrics=_chat_request_metrics(chat_request),
                    on_model=observation.observe,
                    on_line=lambda line: call.diagnostic.upstream.feed(
                        line.encode(JSON_ENCODING) + b"\n"
                    ),
                ):
                    yield chunk
                settle_upstream_end()
            except asyncio.CancelledError:
                call.diagnostic.upstream_end = (
                    StreamEnd.REVOKED.value if call.revoked else StreamEnd.CANCELLED.value
                )
                raise
            except GeneratorExit:
                call.diagnostic.upstream_end = StreamEnd.CONSUMER_CLOSED.value
                raise
            except Exception as error:
                if isinstance(error, httpx.TransportError):
                    call.diagnostic.upstream_end = StreamEnd.TRANSPORT_ERROR.value
                    _record_transport_failure(
                        call.diagnostic,
                        error,
                        stage=TransportStage.RESPONSE_BODY,
                        endpoint=endpoint,
                    )
                else:
                    call.diagnostic.upstream_end = StreamEnd.BRIDGE_ERROR.value
                    call.diagnostic.failure_type = type(error).__name__
                raise
            finally:
                try:
                    await call.close()
                finally:
                    call.task = None

        call.streaming = True
        return CompletionStream(stream(), call)


def normalize_response_input(payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    """Project Responses Lite's tool prefix into the standard request tool field."""
    result = dict(payload)
    items = payload.get("input")
    if not isinstance(items, list):
        return result, {}
    tool_items = [
        item
        for item in items
        if isinstance(item, Mapping) and item.get("type") == ADDITIONAL_TOOLS_ITEM_TYPE
    ]
    if not tool_items:
        return result, {}
    if len(tool_items) != 1 or items[0] is not tool_items[0]:
        raise ValueError(MODEL_BRIDGE_INVALID_TOOL_INPUT)
    tool_item = tool_items[0]
    tools = tool_item.get("tools")
    if (
        tool_item.get("role") != DEVELOPER_ROLE
        or not isinstance(tools, list)
        or any(not isinstance(tool, Mapping) for tool in tools)
        or (payload.get("tools") is not None and payload["tools"] != tools)
    ):
        raise ValueError(MODEL_BRIDGE_INVALID_TOOL_INPUT)
    references = {
        item.get("id")
        for item in items
        if isinstance(item, Mapping)
        and item.get("type") == ITEM_REFERENCE_TYPE
        and isinstance(item.get("id"), str)
    }
    item_id = tool_item.get("id")
    if isinstance(item_id, str) and item_id in references:
        raise ValueError(MODEL_BRIDGE_INVALID_TOOL_INPUT)
    result["input"] = items[1:]
    result["tools"] = list(tools)
    return result, {ADDITIONAL_TOOLS_ITEM_TYPE: 1}


def mount_completion_bridge(app: FastAPI, bridge: CompletionBridge) -> None:
    @app.get(BRIDGE_MODELS_ROUTE)
    async def completion_models(bridge_id: str, request: Request) -> Response:
        remote = request.client.host if request.client is not None else ""
        if remote not in LOOPBACK_HOSTS:
            return JSONResponse({"error": {"message": "loopback access required"}}, status_code=403)
        return await bridge.catalog(bridge_id)

    @app.post(BRIDGE_ROUTE)
    async def completion_bridge(bridge_id: str, request: Request) -> Response:
        remote = request.client.host if request.client is not None else ""
        if remote not in LOOPBACK_HOSTS:
            return JSONResponse({"error": {"message": "loopback access required"}}, status_code=403)
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001 - malformed client JSON
            return JSONResponse(
                {"error": {"message": "invalid Responses request"}}, status_code=400
            )
        if not isinstance(payload, Mapping):
            return JSONResponse(
                {"error": {"message": "invalid Responses request"}}, status_code=400
            )
        return await bridge.forward(bridge_id, payload)


def responses_to_chat_request(payload: Mapping[str, Any]) -> dict[str, Any]:
    messages: list[dict[str, Any]] = []
    instructions = str(payload.get("instructions") or "").strip()
    if instructions:
        messages.append({"role": "system", "content": instructions})
    inputs = payload.get("input")
    if isinstance(inputs, str):
        messages.append({"role": "user", "content": inputs})
    elif isinstance(inputs, list):
        for raw in inputs:
            if not isinstance(raw, Mapping):
                continue
            item_type = str(raw.get("type") or "")
            if item_type == "message":
                message = _response_message_to_chat(raw)
                if message is not None:
                    messages.append(message)
            elif item_type == "function_call":
                tool_call = {
                    "id": str(raw.get("call_id") or raw.get("id") or uuid.uuid4().hex),
                    "type": "function",
                    "function": {
                        "name": str(raw.get("name") or "tool"),
                        "arguments": str(raw.get("arguments") or "{}"),
                    },
                }
                if (
                    messages
                    and messages[-1].get("role") == "assistant"
                    and messages[-1].get("tool_calls")
                ):
                    messages[-1]["tool_calls"].append(tool_call)
                else:
                    messages.append(
                        {"role": "assistant", "content": None, "tool_calls": [tool_call]}
                    )
            elif item_type == "function_call_output":
                messages.extend(
                    _function_call_output_to_chat(
                        str(raw.get("call_id") or raw.get("id") or ""),
                        raw.get("output"),
                    )
                )
    tools = []
    for raw in payload.get("tools") or []:
        if not isinstance(raw, Mapping) or raw.get("type") != CHAT_COMPLETIONS_TOOL_TYPE:
            continue
        function: dict[str, Any] = {
            "name": str(raw.get("name") or "tool"),
            "description": str(raw.get("description") or ""),
            "parameters": raw.get("parameters") or {},
        }
        if "strict" in raw:
            function["strict"] = bool(raw.get("strict"))
        tools.append({"type": "function", "function": function})
    request: dict[str, Any] = {
        "model": str(payload.get("model") or ""),
        "messages": messages,
        "stream": bool(payload.get("stream", True)),
    }
    if request["stream"]:
        request["stream_options"] = {"include_usage": True}
    if tools:
        request["tools"] = tools
        request["tool_choice"] = _chat_tool_choice(payload.get("tool_choice"))
    if payload.get("temperature") is not None:
        request["temperature"] = payload.get("temperature")
    max_tokens = payload.get("max_output_tokens") or payload.get("max_tokens")
    if isinstance(max_tokens, int) and max_tokens > 0:
        request["max_tokens"] = max_tokens
    if payload.get("parallel_tool_calls") is not None:
        request["parallel_tool_calls"] = bool(payload.get("parallel_tool_calls"))
    reasoning = payload.get("reasoning")
    if isinstance(reasoning, Mapping) and reasoning.get("effort"):
        request["reasoning_effort"] = reasoning["effort"]
    return request


def _chat_request_metrics(request: Mapping[str, Any]) -> dict[str, int]:
    messages = request.get("messages")
    message_rows = messages if isinstance(messages, list) else []
    tools = request.get("tools")
    tool_rows = tools if isinstance(tools, list) else []
    message_sizes = [_json_size(row) for row in message_rows]
    return {
        "request_bytes": _json_size(request),
        "messages_bytes": _json_size(message_rows),
        "tools_bytes": _json_size(tool_rows),
        "message_count": len(message_rows),
        "tool_count": len(tool_rows),
        "max_message_bytes": max(message_sizes, default=0),
    }


def _upstream_error_summary(body: bytes) -> dict[str, str]:
    """Extract bounded provider diagnostics without logging request data or credentials."""

    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"code": "", "type": "", "param": "", "message": "unparseable error body"}
    error = document.get("error") if isinstance(document, Mapping) else None
    if not isinstance(error, Mapping):
        return {"code": "", "type": "", "param": "", "message": "unstructured error body"}
    return {
        "code": str(error.get("code") or "")[:UPSTREAM_ERROR_MESSAGE_LIMIT],
        "type": str(error.get("type") or "")[:UPSTREAM_ERROR_MESSAGE_LIMIT],
        "param": str(error.get("param") or "")[:UPSTREAM_ERROR_MESSAGE_LIMIT],
        "message": str(error.get("message") or "")[:UPSTREAM_ERROR_MESSAGE_LIMIT],
    }


def _retryable_internal_rate_limit(upstream: CompletionUpstream, body: bytes) -> bool:
    if upstream.credential_resolver is not None or upstream.token_provider is None:
        return False
    if _product_error_code(body):
        return False
    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return True
    return not (isinstance(document, Mapping) and isinstance(document.get("error"), Mapping))


def _retry_backoff_delay(attempt: int) -> float:
    base = min(
        UPSTREAM_RETRY_BASE_DELAY_SECONDS * (2 ** max(0, attempt - 1)),
        UPSTREAM_RETRY_MAX_DELAY_SECONDS,
    )
    jitter = base * UPSTREAM_RETRY_JITTER_RATIO
    return min(
        random.uniform(max(0.0, base - jitter), base + jitter),
        UPSTREAM_RETRY_MAX_DELAY_SECONDS,
    )


def _upstream_retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = str(response.headers.get(UPSTREAM_RETRY_AFTER_HEADER) or "").strip()
    if retry_after:
        try:
            delay = float(retry_after)
        except ValueError:
            try:
                delay = parsedate_to_datetime(retry_after).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = -1.0
        if delay >= 0:
            return min(delay, UPSTREAM_RETRY_MAX_DELAY_SECONDS)
    return _retry_backoff_delay(attempt)


def _product_error_code(body: bytes) -> str:
    """Read the gateway business envelope (FastAPI ``detail`` shape); only registered codes pass."""

    try:
        document = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ""
    detail = document.get("detail") if isinstance(document, Mapping) else None
    if not isinstance(detail, Mapping):
        return ""
    code = str(detail.get("error") or "").strip()
    return code if code in PRODUCT_UPSTREAM_ERROR_CODES else ""


def _record_transport_failure(
    diagnostic: CompletionDiagnostic,
    exc: BaseException,
    *,
    stage: TransportStage,
    endpoint: str,
) -> dict[str, Any]:
    details = transport_diagnostics(exc)
    diagnostic.failure_type = details["failure_type"]
    diagnostic.transport.stage = stage.value
    diagnostic.transport.category = details["category"]
    diagnostic.transport.cause_chain = details["cause_chain"]
    diagnostic.transport.root_type = details["root_type"]
    diagnostic.transport.errno = details["errno"]
    diagnostic.transport.errno_name = details["errno_name"]
    diagnostic.transport.errno_text = details["errno_text"]
    diagnostic.transport.endpoint = _redacted_endpoint(endpoint)
    return details


def _redacted_endpoint(endpoint: str) -> str:
    """Upstream URL as scheme://host/path, dropping any userinfo/query so it is safe to log."""

    url = httpx.URL(endpoint)
    return f"{url.scheme}://{url.host}{url.path}"


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(JSON_ENCODING))


def _largest_message_summary(request: Mapping[str, Any]) -> dict[str, Any]:
    messages = request.get("messages")
    rows = (
        [row for row in messages if isinstance(row, Mapping)] if isinstance(messages, list) else []
    )
    if not rows:
        return {
            "role": "",
            "content_type": "",
            "content_chars": 0,
            "embedded_images": 0,
            "json_type": "",
            "json_keys": "",
        }
    message = max(rows, key=_json_size)
    content = message.get("content")
    text = content if isinstance(content, str) else ""
    parsed: Any = None
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None
    keys = sorted(str(key) for key in parsed) if isinstance(parsed, Mapping) else []
    return {
        "role": str(message.get("role") or ""),
        "content_type": type(content).__name__,
        "content_chars": len(text),
        "embedded_images": text.count(INLINE_IMAGE_DATA_PREFIX),
        "json_type": type(parsed).__name__ if parsed is not None else "",
        "json_keys": ",".join(keys),
    }


def _fit_inline_images(request: dict[str, Any], target_bytes: int) -> int:
    slots = _inline_image_slots(request)
    if not slots:
        raise ValueError("oversized model input contains no inline image")
    request_bytes = _json_size(request)
    inline_bytes = sum(len(url.encode(JSON_ENCODING)) for _image, url in slots)
    available_bytes = target_bytes - (request_bytes - inline_bytes)
    if available_bytes <= 0:
        raise ValueError("non-image model input exceeds request budget")

    pending = list(slots)
    allocations: dict[int, int] = {}
    remaining_bytes = available_bytes
    while pending:
        fair_share = remaining_bytes // len(pending)
        preserved = [slot for slot in pending if len(slot[1].encode(JSON_ENCODING)) <= fair_share]
        if not preserved:
            for image, _url in pending:
                allocations[id(image)] = fair_share
            break
        for image, url in preserved:
            size = len(url.encode(JSON_ENCODING))
            allocations[id(image)] = size
            remaining_bytes -= size
            pending.remove((image, url))

    compacted = 0
    for image, url in slots:
        budget = allocations[id(image)]
        if len(url.encode(JSON_ENCODING)) <= budget:
            continue
        image["url"] = _compress_inline_image(url, budget)
        compacted += 1
    return compacted


def _inline_image_slots(request: Mapping[str, Any]) -> list[tuple[dict[str, Any], str]]:
    slots: list[tuple[dict[str, Any], str]] = []
    messages = request.get("messages")
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, Mapping):
            continue
        content = message.get("content")
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, Mapping) or str(part.get("type") or "") != "image_url":
                continue
            image = part.get("image_url")
            if not isinstance(image, dict):
                continue
            url = str(image.get("url") or "")
            if url.startswith(INLINE_IMAGE_DATA_PREFIX) and INLINE_IMAGE_BASE64_MARKER in url:
                slots.append((image, url))
    return slots


def _compress_inline_image(url: str, budget: int) -> str:
    header, marker, encoded = url.partition(",")
    if not marker or INLINE_IMAGE_BASE64_MARKER.rstrip(",") not in header:
        raise ValueError("inline image is not base64 encoded")
    try:
        body = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("inline image base64 is invalid") from exc
    encoded_budget = budget - len(INLINE_JPEG_DATA_PREFIX.encode(JSON_ENCODING))
    raw_budget = max(0, encoded_budget * 3 // 4)
    if raw_budget <= 0:
        raise ValueError("inline image has no remaining request budget")
    output = _compress_image_bytes(body, raw_budget)
    compressed = INLINE_JPEG_DATA_PREFIX + base64.b64encode(output).decode("ascii")
    if len(compressed.encode(JSON_ENCODING)) > budget:
        raise ValueError("inline image could not fit request budget")
    return compressed


def _compress_image_bytes(body: bytes, raw_budget: int) -> bytes:
    try:
        with Image.open(BytesIO(body)) as opened:
            opened.load()
            image = ImageOps.exif_transpose(opened).convert("RGBA")
    except (OSError, UnidentifiedImageError) as exc:
        raise ValueError("inline image could not be decoded") from exc
    background = Image.new("RGB", image.size, "white")
    background.paste(image, mask=image.getchannel("A"))
    for max_dimension in INLINE_IMAGE_DIMENSION_STEPS:
        candidate = background.copy()
        candidate.thumbnail((max_dimension, max_dimension), Image.Resampling.LANCZOS)
        for quality in INLINE_IMAGE_QUALITY_STEPS:
            output = BytesIO()
            candidate.save(output, format="JPEG", quality=quality, optimize=True)
            encoded = output.getvalue()
            if len(encoded) <= raw_budget:
                return encoded
    raise ValueError("inline image could not fit request budget")


def _response_message_to_chat(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    role = str(raw.get("role") or "user")
    if role == "developer":
        role = "system"
    content = raw.get("content")
    if isinstance(content, str):
        return {"role": role, "content": content}
    if not isinstance(content, list):
        return None
    parts: list[dict[str, Any]] = []
    for block in content:
        if not isinstance(block, Mapping):
            continue
        block_type = str(block.get("type") or "")
        if block_type in {"input_text", "output_text", "text"}:
            parts.append({"type": "text", "text": str(block.get("text") or "")})
        elif block_type == "input_image":
            image_url = str(block.get("image_url") or "")
            if image_url:
                image: dict[str, Any] = {"url": image_url}
                if block.get("detail"):
                    image["detail"] = str(block.get("detail"))
                parts.append({"type": "image_url", "image_url": image})
    if not parts:
        return {"role": role, "content": ""}
    if all(part["type"] == "text" for part in parts):
        return {"role": role, "content": "".join(str(part["text"]) for part in parts)}
    return {"role": role, "content": parts}


def _function_call_output_to_chat(call_id: str, output: Any) -> list[dict[str, Any]]:
    parsed = _json_value(output)
    blocks = parsed if isinstance(parsed, list) else []
    parts = _response_content_parts_to_chat(blocks)
    text = "".join(str(part.get("text") or "") for part in parts if part.get("type") == "text")
    images = [part for part in parts if part.get("type") == "image_url"]
    if not images:
        return [
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": (
                    output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
                ),
            }
        ]
    return [
        {
            "role": "tool",
            "tool_call_id": call_id,
            "content": text or TOOL_IMAGE_OUTPUT_PLACEHOLDER,
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": TOOL_IMAGE_OUTPUT_PLACEHOLDER},
                *images,
            ],
        },
    ]


def _json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _response_content_parts_to_chat(blocks: list[Any]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        block_type = str(block.get("type") or "")
        if block_type in {"input_text", "output_text", "text"}:
            text = str(block.get("text") or "")
            if text:
                parts.append({"type": "text", "text": text})
            continue
        if block_type not in {"input_image", "image_url", "image"}:
            continue
        raw_url = block.get("image_url")
        url = str(raw_url.get("url") or "") if isinstance(raw_url, Mapping) else str(raw_url or "")
        if not url:
            source = block.get("source")
            source = source if isinstance(source, Mapping) else {}
            data = str(block.get("data") or source.get("data") or "")
            media_type = str(
                block.get("mimeType")
                or block.get("mime_type")
                or source.get("media_type")
                or "image/png"
            )
            if data:
                url = f"data:{media_type};base64,{data}"
        if url:
            image: dict[str, Any] = {"url": url}
            if block.get("detail"):
                image["detail"] = str(block.get("detail"))
            parts.append({"type": "image_url", "image_url": image})
    return parts


def _chat_tool_choice(value: Any) -> Any:
    if isinstance(value, str) and value in {"auto", "none", "required"}:
        return value
    if isinstance(value, Mapping) and str(value.get("type") or "") == "function":
        name = str(value.get("name") or "")
        return {"type": "function", "function": {"name": name}} if name else "auto"
    return "auto"


async def chat_stream_to_responses(
    response: httpx.Response,
    *,
    request_metrics: Mapping[str, int] | None = None,
    on_model: Callable[[Mapping[str, Any]], None] | None = None,
    on_line: Callable[[str], None] | None = None,
) -> AsyncIterator[bytes]:
    response_id = f"resp_{uuid.uuid4().hex}"
    message_id = f"msg_{uuid.uuid4().hex}"
    reasoning_id = f"rs_{uuid.uuid4().hex}"
    text_parts: list[str] = []
    pending_text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tool_calls: dict[int, dict[str, str]] = {}
    usage: dict[str, Any] = {}
    finish_reason = ""
    possible_stream_error = True
    sequence_number = 0
    reasoning_started = False
    reasoning_completed = False
    message_started = False

    def response_event(payload: dict[str, Any]) -> bytes:
        nonlocal sequence_number
        event = {**payload, "sequence_number": sequence_number}
        sequence_number += 1
        return _sse(event)

    def message_output_index() -> int:
        return int(reasoning_started)

    def output_text_part(text: str) -> dict[str, Any]:
        return {
            "type": "output_text",
            "text": text,
            "annotations": [],
            "logprobs": [],
        }

    def start_message() -> list[bytes]:
        nonlocal message_started
        if message_started:
            return []
        message_started = True
        output_index = message_output_index()
        return [
            response_event(
                {
                    "type": "response.output_item.added",
                    "output_index": output_index,
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": message_id,
                        "status": "in_progress",
                        "content": [],
                    },
                }
            ),
            response_event(
                {
                    "type": "response.content_part.added",
                    "item_id": message_id,
                    "output_index": output_index,
                    "content_index": 0,
                    "part": output_text_part(""),
                }
            ),
        ]

    def complete_reasoning() -> list[bytes]:
        nonlocal reasoning_completed
        if not reasoning_started or reasoning_completed:
            return []
        reasoning_completed = True
        reasoning_text = "".join(reasoning_parts)
        summary = {"type": "summary_text", "text": reasoning_text}
        return [
            response_event(
                {
                    "type": "response.reasoning_summary_text.done",
                    "item_id": reasoning_id,
                    "output_index": 0,
                    "summary_index": 0,
                    "text": reasoning_text,
                }
            ),
            response_event(
                {
                    "type": "response.reasoning_summary_part.done",
                    "item_id": reasoning_id,
                    "output_index": 0,
                    "summary_index": 0,
                    "part": summary,
                }
            ),
            response_event(
                {
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "type": "reasoning",
                        "id": reasoning_id,
                        "status": "completed",
                        "summary": [summary],
                    },
                }
            ),
        ]

    yield response_event({"type": "response.created", "response": {"id": response_id}})
    async for line in response.aiter_lines():
        if on_line is not None:
            on_line(line)
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        if on_model is not None and isinstance(chunk, Mapping):
            on_model(chunk)
        response_id = str(chunk.get("id") or response_id)
        if isinstance(chunk.get("usage"), Mapping):
            usage = dict(chunk["usage"])
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices or not isinstance(choices[0], Mapping):
            continue
        choice = choices[0]
        finish_reason = str(choice.get("finish_reason") or finish_reason)
        delta = choice.get("delta")
        if not isinstance(delta, Mapping):
            continue
        content = delta.get("content")
        if isinstance(content, str) and content:
            for event in complete_reasoning():
                yield event
            text_parts.append(content)
            if possible_stream_error:
                pending_text_parts.append(content)
                pending_text = "".join(pending_text_parts)
                stripped = pending_text.lstrip()
                possible_stream_error = not stripped or stripped.startswith("{")
                if not possible_stream_error:
                    for event in start_message():
                        yield event
                    yield response_event(
                        {
                            "type": "response.output_text.delta",
                            "item_id": message_id,
                            "output_index": message_output_index(),
                            "content_index": 0,
                            "delta": pending_text,
                            "logprobs": [],
                        }
                    )
                    pending_text_parts.clear()
            else:
                for event in start_message():
                    yield event
                yield response_event(
                    {
                        "type": "response.output_text.delta",
                        "item_id": message_id,
                        "output_index": message_output_index(),
                        "content_index": 0,
                        "delta": content,
                        "logprobs": [],
                    }
                )
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        if isinstance(reasoning, str) and reasoning:
            if not reasoning_started:
                reasoning_started = True
                yield response_event(
                    {
                        "type": "response.output_item.added",
                        "output_index": 0,
                        "item": {
                            "type": "reasoning",
                            "id": reasoning_id,
                            "status": "in_progress",
                            "summary": [],
                        },
                    }
                )
                yield response_event(
                    {
                        "type": "response.reasoning_summary_part.added",
                        "item_id": reasoning_id,
                        "output_index": 0,
                        "summary_index": 0,
                        "part": {"type": "summary_text", "text": ""},
                    }
                )
            reasoning_parts.append(reasoning)
            yield response_event(
                {
                    "type": "response.reasoning_summary_text.delta",
                    "item_id": reasoning_id,
                    "output_index": 0,
                    "delta": reasoning,
                    "summary_index": 0,
                }
            )
        for raw_call in delta.get("tool_calls") or []:
            if not isinstance(raw_call, Mapping):
                continue
            index = int(raw_call.get("index") or 0)
            current = tool_calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
            if raw_call.get("id"):
                current["id"] = str(raw_call.get("id"))
            function = raw_call.get("function")
            if isinstance(function, Mapping):
                if function.get("name"):
                    current["name"] += str(function.get("name"))
                if function.get("arguments"):
                    current["arguments"] += str(function.get("arguments"))
    for event in complete_reasoning():
        yield event
    if text_parts:
        text = "".join(text_parts)
        stream_error = _structured_stream_error(text)
        if stream_error is not None:
            logger.error(
                "model_bridge_stream_error code=%s request_bytes=%d messages_bytes=%d "
                "tools_bytes=%d message_count=%d tool_count=%d max_message_bytes=%d",
                stream_error.code,
                *(
                    int(dict(request_metrics or {}).get(name) or 0)
                    for name in (
                        "request_bytes",
                        "messages_bytes",
                        "tools_bytes",
                        "message_count",
                        "tool_count",
                        "max_message_bytes",
                    )
                ),
            )
            yield response_event(
                {
                    "type": "response.failed",
                    "response": {
                        "id": response_id,
                        "status": COMPLETION_STATUS_FAILED,
                        "error": {
                            "code": stream_error.code,
                            "message": stream_error.message,
                        },
                    },
                }
            )
            return
        if pending_text_parts:
            for event in start_message():
                yield event
            yield response_event(
                {
                    "type": "response.output_text.delta",
                    "item_id": message_id,
                    "output_index": message_output_index(),
                    "content_index": 0,
                    "delta": text,
                    "logprobs": [],
                }
            )
        output_index = message_output_index()
        yield response_event(
            {
                "type": "response.output_text.done",
                "item_id": message_id,
                "output_index": output_index,
                "content_index": 0,
                "text": text,
                "logprobs": [],
            }
        )
        yield response_event(
            {
                "type": "response.content_part.done",
                "item_id": message_id,
                "output_index": output_index,
                "content_index": 0,
                "part": output_text_part(text),
            }
        )
        yield response_event(
            {
                "type": "response.output_item.done",
                "output_index": output_index,
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": message_id,
                    "status": "completed",
                    "content": [output_text_part(text)],
                },
            }
        )
    next_output_index = int(reasoning_started) + int(message_started)
    for index in sorted(tool_calls):
        call = tool_calls[index]
        call_id = call["id"] or f"call_{uuid.uuid4().hex}"
        yield response_event(
            {
                "type": "response.output_item.done",
                "output_index": next_output_index,
                "item": {
                    "type": "function_call",
                    "id": f"fc_{uuid.uuid4().hex}",
                    "call_id": call_id,
                    "name": call["name"] or "tool",
                    "arguments": call["arguments"] or "{}",
                },
            }
        )
        next_output_index += 1
    yield response_event(
        {
            "type": "response.completed",
            "response": {
                "id": response_id,
                "status": "completed",
                "end_turn": finish_reason != "tool_calls",
                "usage": _responses_usage(usage),
            },
        }
    )


def _structured_stream_error(text: str) -> StructuredStreamError | None:
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, Mapping):
        return None
    raw_error = payload.get("error")
    error = raw_error if isinstance(raw_error, Mapping) else payload
    code = str(error.get("code") or error.get("type") or "").strip()
    message = str(error.get("message") or "").strip()
    return StructuredStreamError(code=code, message=message) if code and message else None


def chat_response_to_response(payload: Mapping[str, Any]) -> dict[str, Any]:
    response_id = str(payload.get("id") or f"resp_{uuid.uuid4().hex}")
    choices = payload.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    message = choice.get("message") if isinstance(choice, Mapping) else {}
    message = message if isinstance(message, Mapping) else {}
    output: list[dict[str, Any]] = []
    content = message.get("content")
    if isinstance(content, str) and content:
        output.append(
            {
                "type": "message",
                "role": "assistant",
                "id": f"msg_{uuid.uuid4().hex}",
                "content": [{"type": "output_text", "text": content}],
            }
        )
    for raw_call in message.get("tool_calls") or []:
        if not isinstance(raw_call, Mapping):
            continue
        function = raw_call.get("function")
        function = function if isinstance(function, Mapping) else {}
        output.append(
            {
                "type": "function_call",
                "id": f"fc_{uuid.uuid4().hex}",
                "call_id": str(raw_call.get("id") or f"call_{uuid.uuid4().hex}"),
                "name": str(function.get("name") or "tool"),
                "arguments": str(function.get("arguments") or "{}"),
            }
        )
    usage = payload.get("usage")
    return {
        "id": response_id,
        "object": "response",
        "status": (
            COMPLETION_STATUS_INCOMPLETE
            if choice.get("finish_reason") in INCOMPLETE_FINISH_REASONS
            else COMPLETION_STATUS_COMPLETED
        ),
        "output": output,
        "usage": _responses_usage(dict(usage) if isinstance(usage, Mapping) else {}),
    }


def _responses_usage(usage: Mapping[str, Any]) -> dict[str, Any]:
    """Project Chat Completions usage onto the Responses shape Codex expects.

    ``output_tokens_details.reasoning_tokens`` must be carried through rather than nulled:
    reasoning dominates output on the thinking-heavy models this bridge routes to (a
    one-word reply measured 308 completion tokens of which 303 were reasoning), so nulling
    it makes both Codex's context estimate and the client UI understate the turn.
    """

    input_tokens = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or usage.get("output_tokens") or 0)
    prompt_details = usage.get("prompt_tokens_details")
    cached_tokens = (
        int(prompt_details.get("cached_tokens") or 0) if isinstance(prompt_details, Mapping) else 0
    )
    # chat 线叫 completion_tokens_details，Responses 线叫 output_tokens_details —— 上游回
    # 哪一个取决于它自己的协议，这里两个都认。
    completion_details = usage.get("completion_tokens_details")
    if not isinstance(completion_details, Mapping):
        completion_details = usage.get("output_tokens_details")
    reasoning_tokens = (
        int(completion_details.get("reasoning_tokens") or 0)
        if isinstance(completion_details, Mapping)
        else 0
    )
    return {
        "input_tokens": input_tokens,
        "input_tokens_details": {"cached_tokens": cached_tokens},
        "output_tokens": output_tokens,
        "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
        "total_tokens": input_tokens + output_tokens,
    }


def _sse(event: Mapping[str, Any]) -> bytes:
    kind = str(event.get("type") or "message")
    data = json.dumps(dict(event), ensure_ascii=False, separators=(",", ":"))
    return f"event: {kind}\ndata: {data}\n\n".encode("utf-8")


__all__ = [
    "CHAT_COMPLETIONS_SUFFIX",
    "CompletionBridge",
    "MODEL_BRIDGE_ROUTE_PREFIX",
    "chat_response_to_response",
    "mount_completion_bridge",
    "responses_to_chat_request",
]
