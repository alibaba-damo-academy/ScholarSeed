"""Product subscription connections, authorization and private model routing."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
import time
from typing import Any, Awaitable, Callable, Mapping

import httpx

from scholarseed_runtime.contract.model import ModelCredential, ModelWireProtocol
from service.chat.service.completions import (
    CompletionBridge,
    CompletionCredentialError,
    CompletionRegistration,
    CompletionRequestError,
)
from service.chat.service.rejections import SUBSCRIPTION_CAPABILITY_UNSUPPORTED_CODE
from service.chat.service.transport import retryable_connect_failure, transport_diagnostics
from service.platform.activity import Activities, ActivityDomain, ActivityLease
from service.settings.authorization import BrowserAuthorization
from service.settings.capabilities import INPUT_MODALITIES_KEY, MODALITY_KINDS
from service.settings.connections import (
    ENABLED_KEY,
    MODEL_ID_KEY,
    OAUTH_PROVIDER_KEY,
    OPENAI_PROVIDER,
    SELECTED_MODELS_KEY,
    ModelProfileStore,
    UnknownProfileError,
    is_oauth_connection,
)
from service.settings.credentials import (
    CredentialConflictError,
    CredentialRecord,
    CredentialState,
    ModelCredentialStore,
)
from service.settings.oauth import (
    OAUTH_HTTP_TIMEOUT_SECONDS,
    OAUTH_PROVIDERS,
    PLAN_SCOPE,
    REAUTH_REQUIRED_CODE,
    REFRESH_AHEAD_SECONDS,
    OAuthCredentials,
    OAuthFailure,
    OAuthProtocol,
    upstream_revocation_code,
)

SUBSCRIPTION_BILLING = "subscription"
SUBSCRIPTION_UNAVAILABLE_STATE = "unavailable"
SUBSCRIPTION_STORAGE_ERROR = "oauth_storage_unavailable"
MODEL_VISIBILITY_LIST = "list"
SUBSCRIPTION_TRUST_ENV = True
#: 传输层失败日志里错误详情的截断长度。
TRANSPORT_ERROR_DETAIL_LIMIT = 200
#: 订阅模型目录本地缓存 TTL。renderer 高频重拉 catalog，每次都打上游既慢又易触发限流 500。
SUBSCRIPTION_DIRECTORY_CACHE_SECONDS = 60.0
#: 完整目录用于 Codex 的指令/工具等运行配置，独立于界面模型列表缓存。
SUBSCRIPTION_RUNTIME_CATALOG_CACHE_SECONDS = 10800.0
#: 上游目录拉取失败后的冷却：避免后台自愈反复锤一个正在 500 的端点（浪费且加剧限流）。
SUBSCRIPTION_SYNC_FAILURE_COOLDOWN_SECONDS = 300.0
#: 上游目录拉取的退避重试次数与初始退避秒数(指数翻倍)；覆盖 5xx(上游瞬时故障,
#: 如 "fail to touch upstream")与瞬时传输失败(TLS/DNS/连接超时, 与 model bridge 同分类)。
SUBSCRIPTION_MODELS_RETRY_ATTEMPTS = 3
SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS = 1.0
#: 非 2xx 响应体的有界截断长度（仅用于诊断日志，先脱敏）。
SUBSCRIPTION_ERROR_BODY_LIMIT = 400
_SUBSCRIPTION_SECRET_PATTERN = re.compile(
    r"(?i)bearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\bsk-[\w-]+"
)
LOGGER = logging.getLogger(__name__)
RESPONSE_ITEM_REFERENCE = "item_reference"
RESPONSE_ITEM_ID = "id"
UNSUPPORTED_SUBSCRIPTION_INPUT_TYPES = frozenset(
    {"agent_message", "multi_agent_call", "multi_agent_call_output"}
)
UNSUPPORTED_RESPONSE_FIELDS = frozenset(
    {
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
    }
)
SUPPORTED_RESPONSE_TOOLS = frozenset(
    {"function", "custom", "namespace", "web_search", "web_search_preview"}
)


def _upstream_error_code(response: httpx.Response) -> str:
    """Read the upstream ``{"error": {"code": ...}}`` code; the body itself never gets logged."""

    try:
        payload = response.json()
    except ValueError:
        return ""
    error = payload.get("error") if isinstance(payload, Mapping) else None
    code = error.get("code") if isinstance(error, Mapping) else None
    return code if isinstance(code, str) else ""


class SubscriptionService:
    """Compose the existing profile store, OAuth lifecycle and completion bridge."""

    def __init__(
        self,
        profiles: ModelProfileStore,
        credentials: ModelCredentialStore,
        bridge: CompletionBridge,
        *,
        activities: Activities,
        turn_activities: Callable[[str], ActivityLease | None] | None = None,
        client: httpx.AsyncClient | None = None,
        shared_ownership: bool = False,
    ) -> None:
        self._activities = activities
        self._turn_activities = turn_activities
        self.profiles = profiles
        self.credentials = credentials
        self.bridge = bridge
        # machine 轴下连接归这台机器: 授权事务、目录任务、热桥一律按机器级归属身份键控,
        # 因此账号登出不该撕它们(见 logout)。
        self._shared_ownership = bool(shared_ownership)
        self.client = client or httpx.AsyncClient(
            timeout=OAUTH_HTTP_TIMEOUT_SECONDS,
            follow_redirects=False,
            trust_env=SUBSCRIPTION_TRUST_ENV,
        )
        protocols = {
            key: OAuthProtocol(policy, self.client) for key, policy in OAUTH_PROVIDERS.items()
        }
        self.resolvers = {
            key: OAuthCredentials(credentials, protocol, activities=activities)
            for key, protocol in protocols.items()
        }
        self.authorizations = {
            key: BrowserAuthorization(credentials, protocol, activities=activities)
            for key, protocol in protocols.items()
        }
        self._closed = False
        self._owner_epochs: dict[str, int] = {}
        self._connection_epochs: dict[tuple[str, str], int] = {}
        self._directories: dict[asyncio.Task, tuple[str, str]] = {}
        self._directory_cache: dict[tuple[str, str, bool], tuple[float, int, int, dict]] = {}
        self._inflight: dict[tuple[str, str, bool], asyncio.Task] = {}
        self._sync_failed_at: dict[tuple[str, str], float] = {}

    def profile(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        if self._closed:
            raise OAuthFailure("oauth_service_closed")
        profile = self.profiles.profile(connection_id, owner_id=owner_id)
        if profile is None or not is_oauth_connection(profile):
            raise UnknownProfileError("OAuth connection is unavailable")
        if profile.get(OAUTH_PROVIDER_KEY) not in OAUTH_PROVIDERS:
            raise OAuthFailure("oauth_provider_unavailable")
        self._owner_epochs.setdefault(owner_id, 0)
        return profile

    def _status_record(self, owner_id: str, connection_id: str) -> CredentialRecord | None:
        """Project storage failures without changing credentials or granting execution."""
        try:
            return self.credentials.read(owner_id, connection_id)
        except (OSError, sqlite3.DatabaseError) as error:
            # Never log exception text: storage errors can include private paths/data.
            LOGGER.warning(
                "subscription_storage_unavailable connection=%s type=%s errno=%s winerror=%s sqlite=%s",
                connection_id,
                type(error).__name__,
                getattr(error, "errno", None),
                getattr(error, "winerror", None),
                getattr(error, "sqlite_errorcode", None),
            )
            return None

    def status(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.profile(owner_id, connection_id)
        record = self._status_record(owner_id, connection_id)
        if record is None:
            return {
                "state": SUBSCRIPTION_UNAVAILABLE_STATE,
                "account_label": "",
                "billing": SUBSCRIPTION_BILLING,
                "error": SUBSCRIPTION_STORAGE_ERROR,
            }
        return {
            "state": (
                "permission_required"
                if record.tokens and PLAN_SCOPE not in record.tokens.scopes
                else record.state.value
            ),
            "account_label": record.tokens.account_label if record.tokens else "",
            "billing": SUBSCRIPTION_BILLING,
            **(
                {"error": "oauth_plan_permission_required"}
                if record.tokens and PLAN_SCOPE not in record.tokens.scopes
                else {}
            ),
        }

    async def refresh_expiring(
        self, owner_id: str, connection_id: str, *, wait: bool = False
    ) -> None:
        """Refresh only credentials that can no longer substantiate a selectable model."""

        try:
            profile = self.profile(owner_id, connection_id)
        except UnknownProfileError:
            return
        record = self._status_record(owner_id, connection_id)
        if (
            record is None
            or record.state != CredentialState.CONNECTED
            or record.tokens is None
            or record.tokens.expires_at > time.time() + REFRESH_AHEAD_SECONDS
        ):
            return
        resolver = self.resolvers[profile[OAUTH_PROVIDER_KEY]]
        if not wait:
            resolver.prefetch(owner_id, connection_id)
            return
        try:
            await resolver.resolve(owner_id, connection_id)
        except OAuthFailure as error:
            LOGGER.warning(
                "subscription_credential_refresh_failed connection=%s code=%s",
                connection_id,
                error.code,
            )

    async def login(
        self, owner_id: str, connection_id: str, *, user_id: str = ""
    ) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        record = self.credentials.read(owner_id, connection_id)
        if record.tokens and PLAN_SCOPE in record.tokens.scopes:
            raise OAuthFailure("oauth_disconnect_before_login")
        epoch = self._owner_epochs[owner_id]
        generation = self.credentials.read(owner_id, connection_id).generation
        authorization = self.authorizations[profile[OAUTH_PROVIDER_KEY]]
        # user_id 是真实账号, 只作凭据行的 owner 戳; 事务键控仍按归属身份 owner_id。
        result = await authorization.start(owner_id, connection_id, account_id=user_id)
        if (
            self._owner_epochs[owner_id] != epoch
            or self.credentials.read(owner_id, connection_id).generation != generation
            or self.profiles.profile(connection_id, owner_id=owner_id) is None
        ):
            authorization.cancel(owner_id, connection_id, result["transaction_id"])
            raise OAuthFailure("oauth_connection_changed")
        return result

    def login_status(
        self, owner_id: str, connection_id: str, transaction_id: str
    ) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        return self.authorizations[profile[OAUTH_PROVIDER_KEY]].status(
            owner_id, connection_id, transaction_id
        )

    def cancel_login(self, owner_id: str, connection_id: str, transaction_id: str) -> None:
        profile = self.profile(owner_id, connection_id)
        self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel(
            owner_id, connection_id, transaction_id
        )

    async def disconnect(self, owner_id: str, connection_id: str) -> None:
        profile = self.profile(owner_id, connection_id)
        scope = (owner_id, connection_id)
        self._connection_epochs[scope] = self._connection_epochs.get(scope, 0) + 1
        self._cancel_directories(owner_id, connection_id)
        self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel_connection(owner_id, connection_id)
        self.bridge.revoke_connection(owner_id, connection_id)
        record = self.credentials.read(owner_id, connection_id)
        self.credentials.revoke(owner_id, connection_id)
        if record.tokens is not None:
            try:
                await self.resolvers[profile[OAUTH_PROVIDER_KEY]].protocol.revoke(record.tokens)
            except OAuthFailure:
                raise OAuthFailure("oauth_revocation_unconfirmed") from None

    async def logout(self, owner_id: str) -> None:
        if self._shared_ownership:
            # 连接归这台机器: 授权事务、目录任务与热桥都按机器级归属身份键控, 账号登出既不
            # 该吊销它们, 拿真实账号也匹配不上它们的键。显式返回, 不靠键失配"碰巧"什么也不做。
            LOGGER.info("subscription_logout_skipped_shared_ownership owner=%s", owner_id)
            return
        self._owner_epochs[owner_id] = self._owner_epochs.get(owner_id, 0) + 1
        for profile in self.profiles.list(owner_id=owner_id)["profiles"]:
            if is_oauth_connection(profile):
                self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel_connection(
                    owner_id, profile["id"]
                )
        self._cancel_directories(owner_id)
        self.bridge.revoke_owner(owner_id)

    async def logout_all(self) -> None:
        for owner_id in tuple(self._owner_epochs):
            await self.logout(owner_id)

    async def resolve(
        self, owner_id: str, connection_id: str, *, require_enabled: bool = True
    ) -> ModelCredential:
        try:
            profile = self.profile(owner_id, connection_id)
            if require_enabled and not profile.get(ENABLED_KEY):
                raise OAuthFailure("oauth_connection_disabled")
            tokens = await self.resolvers[profile[OAUTH_PROVIDER_KEY]].resolve(
                owner_id, connection_id
            )
            # The profile may have been removed or disabled while token rotation ran.
            current = self.profile(owner_id, connection_id)
            if require_enabled and not current.get(ENABLED_KEY):
                raise OAuthFailure("oauth_connection_disabled")
            return ModelCredential(
                api_key=tokens.access_token,
                headers={},
            )
        except OAuthFailure as error:
            raise CompletionCredentialError(error.code) from None
        except UnknownProfileError:
            raise CompletionCredentialError("oauth_connection_unavailable") from None

    def _mark_reauth_required(self, owner_id: str, connection_id: str) -> bool:
        """上游确认令牌吊销后，generation-fenced 地把凭证回写为 REAUTH_REQUIRED。

        幂等且防竞态：并发 refresh/login 已推进 generation 时让位（CredentialConflictError →
        no-op），一个迟到的 401 不能把刚轮转好的凭证打掉。返回是否真由本次调用完成状态翻转。
        """

        record = self.credentials.read(owner_id, connection_id)
        if record.state != CredentialState.CONNECTED:
            return False
        try:
            self.credentials.revoke(
                owner_id,
                connection_id,
                state=CredentialState.REAUTH_REQUIRED,
                expected_generation=record.generation,
            )
        except CredentialConflictError:
            return False
        LOGGER.info("subscription_credential_marked_reauth connection=%s", connection_id)
        return True

    def _handle_upstream_revocation(
        self, owner_id: str, connection_id: str, status_code: int, error_code: str
    ) -> str:
        """推理端上游拒绝的凭证回写钩子：吊销则回写并返回 reauth 码，否则返回空串。

        与目录路径共用同一判定（``upstream_revocation_code``）与回写，使「首个看到 401 的
        端点」无论是 models 还是 responses 都一致地把订阅标成需重新登录；5xx、传输抖动与普通
        4xx 返回空串，调用方维持既有通用语义，绝不误判为登录失效。
        """

        if not upstream_revocation_code(status_code, error_code):
            return ""
        self._mark_reauth_required(owner_id, connection_id)
        return REAUTH_REQUIRED_CODE

    def _cancel_directories(self, owner_id: str, connection_id: str = "") -> None:
        for task, scope in tuple(self._directories.items()):
            if scope[0] == owner_id and (not connection_id or scope[1] == connection_id):
                if task is not asyncio.current_task():
                    task.cancel()

    async def models(self, owner_id: str, connection_id: str, *, fresh: bool = False) -> dict:
        return await self._directory(owner_id, connection_id, complete=False, fresh=fresh)

    async def catalog(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        try:
            return await self._directory(owner_id, connection_id, complete=True)
        except OAuthFailure as error:
            # 令牌被上游吊销是凭据终态：包成 CompletionCredentialError，让模型桥透出可操作的
            # reauth 码（401）而不是把它塌进通用 502，前端才拿得到「请重新登录」。
            if error.code == REAUTH_REQUIRED_CODE:
                raise CompletionCredentialError(error.code) from None
            raise

    async def sync_directory(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        """配置时拉取上游目录并落快照；读路径（catalog）不再打上游。

        登录成功、加载模型、保存选择、显式 refresh 这些「配置时刻」调用本方法；模型目录/
        厂商列表的读路径只读 ``profile[model_directory]`` 快照，避免每次打开界面都等上游。
        """

        with self._activities.enter(ActivityDomain.MODEL):
            directory = await self._fetch_models(owner_id, connection_id, complete=False)
            snapshot = {"models": directory.get("models") or [], "fetched_at": time.time()}
            self.profiles.set_directory(connection_id, snapshot, owner_id=owner_id)
            self._directory_cache.pop((owner_id, connection_id, True), None)
            self._directory_cache[(owner_id, connection_id, False)] = (
                time.monotonic(),
                self._owner_epochs.get(owner_id, 0),
                self._connection_epochs.get((owner_id, connection_id), 0),
                directory,
            )
            return directory

    def sync_on_cooldown(self, owner_id: str, connection_id: str) -> bool:
        """上游目录最近失败过 → 后台自愈暂时跳过，避免反复锤一个正在 500 的端点。"""

        failed_at = self._sync_failed_at.get((owner_id, connection_id))
        return failed_at is not None and (
            time.monotonic() - failed_at < SUBSCRIPTION_SYNC_FAILURE_COOLDOWN_SECONDS
        )

    async def _directory(
        self, owner_id: str, connection_id: str, *, complete: bool, fresh: bool = False
    ) -> dict[str, Any]:
        self.profile(owner_id, connection_id)
        owner_epoch = self._owner_epochs[owner_id]
        scope = (owner_id, connection_id)
        connection_epoch = self._connection_epochs.get(scope, 0)
        task = asyncio.current_task()
        if task is None:
            raise RuntimeError("subscription directory lookup requires an asyncio task")
        self._directories[task] = scope
        try:
            result = await self._models(owner_id, connection_id, complete=complete, fresh=fresh)
            if (
                self._owner_epochs[owner_id] != owner_epoch
                or self._connection_epochs.get(scope, 0) != connection_epoch
                or self.credentials.read(owner_id, connection_id).state != CredentialState.CONNECTED
            ):
                raise OAuthFailure("oauth_connection_changed")
            return result
        finally:
            self._directories.pop(task, None)

    async def _models(
        self, owner_id: str, connection_id: str, *, complete: bool = False, fresh: bool = False
    ) -> dict[str, Any]:
        """带 TTL 缓存的目录读取；瞬态上游失败回落到最近一次成功结果。

        renderer 会高频重拉 catalog，每次都打 ``/codex/models`` 既慢又易触发限流 500；
        而一次 500 若把上一次成功的目录丢掉，思考强度滑块会凭空消失（用户可见回归）。
        缓存按 (owner, connection, complete) 键控并校验 epoch，连接变更/重登录自然失效。
        ``fresh`` 用于「校验用户提交的选择」这类必须看最新上游的调用，绕过缓存读。
        """

        scope = (owner_id, connection_id)
        cache_key = (owner_id, connection_id, complete)
        cache_seconds = (
            SUBSCRIPTION_RUNTIME_CATALOG_CACHE_SECONDS
            if complete
            else SUBSCRIPTION_DIRECTORY_CACHE_SECONDS
        )
        cached = None if fresh else self._directory_cache.get(cache_key)
        owner_epoch = self._owner_epochs.get(owner_id, 0)
        connection_epoch = self._connection_epochs.get(scope, 0)
        if cached is not None:
            stamp, cached_owner, cached_connection, payload = cached
            if (
                cached_owner == owner_epoch
                and cached_connection == connection_epoch
                and time.monotonic() - stamp < cache_seconds
            ):
                return payload
        if fresh:
            payload = await self._fetch_models(owner_id, connection_id, complete=complete)
            self._directory_cache[cache_key] = (
                time.monotonic(),
                owner_epoch,
                connection_epoch,
                payload,
            )
            return payload
        # single-flight：并发的同 scope 读合并为一次上游拉取，避免 renderer 重复请求时
        # 两个调用各自 miss 缓存、各打一次 /codex/models。
        inflight = self._inflight.get(cache_key)
        if inflight is None:
            inflight = self._activities.spawn(
                ActivityDomain.MODEL,
                lambda: self._fetch_models(owner_id, connection_id, complete=complete),
            )
            self._inflight[cache_key] = inflight
            # 共享拉取任务也登记进 _directories，登出/断开才能一并取消它。
            self._directories[inflight] = scope

            def _settle(task: asyncio.Task, key: tuple = cache_key) -> None:
                self._inflight.pop(key, None)
                self._directories.pop(task, None)

            inflight.add_done_callback(_settle)
        try:
            payload = await inflight
        except OAuthFailure as error:
            # 令牌被上游吊销是终态，不能用旧目录缓存掩盖：必须让 reauth 信号上抛，否则会拿陈旧
            # 目录继续，把「需重新登录」推迟成推理期的通用失败。瞬态失败仍回落最近一次成功结果。
            if (
                error.code != REAUTH_REQUIRED_CODE
                and cached is not None
                and cached[1] == owner_epoch
                and cached[2] == connection_epoch
            ):
                LOGGER.warning(
                    "oauth_directory_serving_cached connection=%s complete=%s",
                    connection_id,
                    complete,
                )
                return cached[3]
            raise
        self._directory_cache[cache_key] = (
            time.monotonic(),
            owner_epoch,
            connection_epoch,
            payload,
        )
        return payload

    async def _fetch_models(
        self, owner_id: str, connection_id: str, *, complete: bool = False
    ) -> dict[str, Any]:
        with self._activities.enter(ActivityDomain.MODEL):
            profile = self.profile(owner_id, connection_id)
            policy = OAUTH_PROVIDERS[profile[OAUTH_PROVIDER_KEY]]
            material = await self.resolve(owner_id, connection_id, require_enabled=False)
            response: httpx.Response | None = None
            for attempt in range(SUBSCRIPTION_MODELS_RETRY_ATTEMPTS):
                try:
                    response = await self.client.get(
                        policy.models_endpoint,
                        headers={**material.headers, "Authorization": f"Bearer {material.api_key}"},
                        follow_redirects=False,
                    )
                except httpx.HTTPError as error:
                    # TLS 信任失败、DNS 失败与超时都归到这一支，只报「不可用」无法区分，
                    # 而错误详情正是唯一能分辨它们的字段。上游响应体与请求头不入日志。
                    diagnostics = transport_diagnostics(error)
                    category = diagnostics["category"]
                    if (
                        attempt + 1 < SUBSCRIPTION_MODELS_RETRY_ATTEMPTS
                        and retryable_connect_failure(error, category)
                    ):
                        delay = SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS * (2**attempt)
                        LOGGER.warning(
                            "oauth_models_transport_retry endpoint=%s error_class=%s category=%s "
                            "attempt=%d max_attempts=%d delay_seconds=%.3f",
                            policy.models_endpoint,
                            type(error).__name__,
                            category,
                            attempt + 1,
                            SUBSCRIPTION_MODELS_RETRY_ATTEMPTS,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    LOGGER.warning(
                        "oauth_models_transport_failed endpoint=%s error_class=%s category=%s detail=%s",
                        policy.models_endpoint,
                        type(error).__name__,
                        category,
                        str(error)[:TRANSPORT_ERROR_DETAIL_LIMIT],
                    )
                    self._sync_failed_at[(owner_id, connection_id)] = time.monotonic()
                    raise OAuthFailure("oauth_models_unavailable") from None
                if response.is_success:
                    break
                # 有界+脱敏的响应体是定位上游错误的唯一线索（状态码本身信息量不足）。
                detail = ""
                try:
                    detail = " ".join(
                        _SUBSCRIPTION_SECRET_PATTERN.sub(
                            "[redacted]", response.text[:SUBSCRIPTION_ERROR_BODY_LIMIT]
                        ).split()
                    )
                except Exception:  # 读体失败不应掩盖原始告警
                    detail = ""
                # 5xx = 上游瞬时故障（如 "fail to touch upstream"），秒级可能自愈，退避重试；
                # 4xx 是请求/凭据问题，重试无意义。
                if response.status_code >= 500 and attempt + 1 < SUBSCRIPTION_MODELS_RETRY_ATTEMPTS:
                    await asyncio.sleep(SUBSCRIPTION_MODELS_RETRY_BACKOFF_SECONDS * (2**attempt))
                    continue
                revoked = upstream_revocation_code(
                    response.status_code, _upstream_error_code(response)
                )
                if revoked:
                    # 上游明确吊销了这份令牌（用户在官网登出/改密码/换登录方式）：回写凭证为
                    # REAUTH_REQUIRED，使 Settings 与后续对话一致地要求重新登录，并抛可区分的
                    # reauth 失败而非通用 oauth_models_rejected。这不是瞬态，重试无意义。
                    self._mark_reauth_required(owner_id, connection_id)
                    LOGGER.warning(
                        "oauth_models_token_revoked endpoint=%s http_status=%s code=%s",
                        policy.models_endpoint,
                        response.status_code,
                        revoked,
                    )
                    self._sync_failed_at[(owner_id, connection_id)] = time.monotonic()
                    raise OAuthFailure(REAUTH_REQUIRED_CODE)
                LOGGER.warning(
                    "oauth_models_rejected endpoint=%s http_status=%s detail=%s",
                    policy.models_endpoint,
                    response.status_code,
                    detail,
                )
                self._sync_failed_at[(owner_id, connection_id)] = time.monotonic()
                raise OAuthFailure("oauth_models_rejected")
            if response is None:
                raise OAuthFailure("oauth_models_unavailable")
            self._sync_failed_at.pop((owner_id, connection_id), None)
            try:
                payload = response.json()
                rows = payload["models"]
                if not isinstance(rows, list):
                    raise ValueError()
                models = []
                for row in rows:
                    if not isinstance(row, dict) or row.get("visibility") != MODEL_VISIBILITY_LIST:
                        continue
                    model_id = row.get("slug")
                    if not isinstance(model_id, str) or not model_id:
                        continue
                    levels = row.get("supported_reasoning_levels")
                    modalities = row.get(INPUT_MODALITIES_KEY)
                    declared_modalities = (
                        list(
                            dict.fromkeys(
                                str(modality).strip().lower()
                                for modality in modalities
                                if str(modality).strip().lower() in MODALITY_KINDS
                            )
                        )
                        if isinstance(modalities, list)
                        else None
                    )
                    models.append(
                        {
                            "id": model_id,
                            "label": str(row.get("display_name") or model_id),
                            "reasoning_efforts": (
                                [
                                    level["effort"]
                                    for level in levels
                                    if isinstance(level, dict)
                                    and isinstance(level.get("effort"), str)
                                ]
                                if isinstance(levels, list)
                                else None
                            ),
                            "reasoning_effort": str(row.get("default_reasoning_level") or ""),
                            **(
                                {INPUT_MODALITIES_KEY: declared_modalities}
                                if declared_modalities
                                else {}
                            ),
                        }
                    )
            except (ValueError, KeyError, TypeError):
                raise OAuthFailure("oauth_models_invalid") from None
            self.profile(owner_id, connection_id)
            if complete:
                return payload
            return {"ok": True, "models": models, "message": ""}

    async def validate_models(
        self, owner_id: str, connection_id: str, selected: list[dict]
    ) -> None:
        if not selected:
            return
        offered = {
            row[MODEL_ID_KEY]
            for row in (await self.models(owner_id, connection_id, fresh=True))["models"]
        }
        if any(row[MODEL_ID_KEY] not in offered for row in selected):
            raise OAuthFailure("oauth_model_unavailable")

    def register(
        self,
        owner_id: str,
        connection_id: str,
        model_id: str,
        session_id: str,
        model_routes: Mapping[str, str],
        *,
        reasoning_effort: str | None = None,
        turn_id_provider: Callable[[str], str] | None = None,
        catalog_activity: ActivityLease | None = None,
        catalog_resolver: Callable[[str, str], Awaitable[dict[str, Any]]] | None = None,
        catalog_identity: str = "",
    ) -> CompletionRegistration:
        profile = self.profile(owner_id, connection_id)
        if not profile.get(ENABLED_KEY) or model_id not in {
            row[MODEL_ID_KEY] for row in profile[SELECTED_MODELS_KEY]
        }:
            raise OAuthFailure("oauth_model_unavailable")
        if self.credentials.read(owner_id, connection_id).state != CredentialState.CONNECTED:
            raise OAuthFailure(REAUTH_REQUIRED_CODE)
        policy = OAUTH_PROVIDERS[profile[OAUTH_PROVIDER_KEY]]

        def request_policy(payload: Mapping[str, Any]) -> dict[str, Any]:
            requested = str(payload.get("model") or "")
            routed = model_routes.get(requested, requested)
            current = self.profile(owner_id, connection_id)
            if routed != model_id or model_id not in {
                row[MODEL_ID_KEY] for row in current[SELECTED_MODELS_KEY]
            }:
                LOGGER.warning(
                    "subscription_model_rejected session_id=%s expected=%s requested=%s",
                    session_id,
                    model_id,
                    requested,
                )
                raise OAuthFailure("oauth_model_unavailable")
            return self.request_policy(payload)

        async def catalog(owner: str, connection: str) -> dict[str, Any]:
            if owner != owner_id or connection != connection_id:
                raise OAuthFailure("oauth_model_unavailable")
            resolver = catalog_resolver or self.catalog
            if catalog_activity is None:
                return await resolver(owner, connection)
            with self._activities.continue_from(catalog_activity, ActivityDomain.MODEL):
                return await resolver(owner, connection)

        async def credentials(owner: str, connection: str) -> ModelCredential:
            parent = self._turn_activities(session_id) if self._turn_activities else None
            if parent is None:
                return await self.resolve(owner, connection)
            with self._activities.continue_from(parent, ActivityDomain.CREDENTIAL):
                return await self.resolve(owner, connection)

        def renewal_source() -> object:
            record = self.credentials.read(owner_id, connection_id)
            return (
                self._closed,
                owner_id,
                connection_id,
                model_id,
                self.profile(owner_id, connection_id),
                record.generation,
                record.state.value,
                self._owner_epochs.get(owner_id, 0),
                self._connection_epochs.get((owner_id, connection_id), 0),
            )

        return self.bridge.register(
            endpoint=policy.responses_endpoint,
            responses_endpoint=policy.responses_endpoint,
            api_key="",
            wire_protocol=ModelWireProtocol.RESPONSES,
            owner_id=owner_id,
            connection_id=connection_id,
            session_id=session_id,
            credential_resolver=credentials,
            catalog_resolver=catalog,
            credential_revocation_handler=self._handle_upstream_revocation,
            request_policy=request_policy,
            model_routes=model_routes,
            trust_env=SUBSCRIPTION_TRUST_ENV,
            reasoning_effort=reasoning_effort,
            turn_id_provider=turn_id_provider,
            provider=OPENAI_PROVIDER,
            renewal_source=renewal_source,
            resume_scope=(
                json.dumps({"model": model_id, "catalog": catalog_identity}, sort_keys=True)
                if session_id
                else ""
            ),
        )

    @staticmethod
    def request_policy(payload: Mapping[str, Any]) -> dict[str, Any]:
        # Preserve tool/reasoning items exactly; subscription calls must not persist
        # responses upstream. Streaming is supplied by the runtime's Responses call.
        result = {**payload, "store": False, "stream": True}
        if UNSUPPORTED_RESPONSE_FIELDS.intersection(payload):
            raise OAuthFailure("oauth_capability_unsupported")

        def validate_tools(tools: Any) -> None:
            if not isinstance(tools, list):
                raise OAuthFailure("oauth_capability_unsupported")
            for tool in tools:
                if (
                    not isinstance(tool, Mapping)
                    or tool.get("type") not in SUPPORTED_RESPONSE_TOOLS
                ):
                    raise OAuthFailure("oauth_capability_unsupported")
                if tool.get("type") == "namespace":
                    validate_tools(tool.get("tools", []))

        validate_tools(payload.get("tools", []))
        items = payload.get("input")
        if not isinstance(items, list):
            raise OAuthFailure("oauth_capability_unsupported")
        for item in items:
            if (
                isinstance(item, Mapping)
                and isinstance(item.get("type"), str)
                and item.get("type") in UNSUPPORTED_SUBSCRIPTION_INPUT_TYPES
            ):
                raise CompletionRequestError(SUBSCRIPTION_CAPABILITY_UNSUPPORTED_CODE)
            if (
                not isinstance(item, Mapping)
                or item.get("type") == RESPONSE_ITEM_REFERENCE
                or item.get("role") == "system"
            ):
                raise OAuthFailure("oauth_capability_unsupported")
            if item.get("type") == "additional_tools":
                validate_tools(item.get("tools", []))
        if isinstance(items, list):
            # Inline history is self-contained. Provider-generated item IDs are not
            # portable across providers; tool call_id links remain untouched.
            result["input"] = [
                (
                    {key: value for key, value in item.items() if key != RESPONSE_ITEM_ID}
                    if isinstance(item, Mapping) and item.get("type") != RESPONSE_ITEM_REFERENCE
                    else item
                )
                for item in items
            ]
        return result

    async def close(self) -> None:
        self._closed = True
        directories = tuple(self._directories)
        for task in directories:
            task.cancel()
        await asyncio.gather(*directories, return_exceptions=True)
        for authorization in self.authorizations.values():
            await authorization.close()
        await self.bridge.close()
        for resolver in self.resolvers.values():
            await resolver.close()
        await self.client.aclose()
