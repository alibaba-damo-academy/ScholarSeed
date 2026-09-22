"""Product subscription connections, authorization and private model routing."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Mapping

import httpx

from scholarseed_runtime.contract.model import ModelCredential, ModelWireProtocol
from service.chat.service.completions import (
    CompletionBridge,
    CompletionCredentialError,
    CompletionRegistration,
)
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
from service.settings.credentials import CredentialState, ModelCredentialStore
from service.settings.oauth import (
    OAUTH_HTTP_TIMEOUT_SECONDS,
    OAUTH_PROVIDERS,
    OAuthCredentials,
    OAuthFailure,
    OAuthProtocol,
)

SUBSCRIPTION_BILLING = "subscription"
# 与 scripts/vendor/codex/manifest.json 的 codex 版本保持一致：/codex/models 会按
# client_version 做兼容分支，过旧的版本曾观测到上游 500。改 vendored codex 时同步改这里。
SUBSCRIPTION_MODELS_COMPATIBILITY_VERSION = "0.153.4"
ACCOUNT_HEADER = "ChatGPT-Account-Id"
ORIGINATOR_HEADER = "originator"
PRODUCT_ORIGINATOR = "scholarseed_desktop"
MODEL_VISIBILITY_LIST = "list"
SUBSCRIPTION_TRUST_ENV = True
#: 传输层失败日志里错误详情的截断长度。
TRANSPORT_ERROR_DETAIL_LIMIT = 200
#: 订阅模型目录本地缓存 TTL。renderer 高频重拉 catalog，每次都打上游既慢又易触发限流 500。
SUBSCRIPTION_DIRECTORY_CACHE_SECONDS = 60.0
#: 上游目录拉取失败后的冷却：避免后台自愈反复锤一个正在 500 的端点（浪费且加剧限流）。
SUBSCRIPTION_SYNC_FAILURE_COOLDOWN_SECONDS = 300.0
#: 5xx(上游瞬时故障, 如 "fail to touch upstream")的退避重试次数与初始退避秒数(指数翻倍)。
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


class SubscriptionService:
    """Compose the existing profile store, OAuth lifecycle and completion bridge."""

    def __init__(
        self,
        profiles: ModelProfileStore,
        credentials: ModelCredentialStore,
        bridge: CompletionBridge,
        *,
        client: httpx.AsyncClient | None = None,
        shared_ownership: bool = False,
    ) -> None:
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
            key: OAuthCredentials(credentials, protocol) for key, protocol in protocols.items()
        }
        self.authorizations = {
            key: BrowserAuthorization(credentials, protocol) for key, protocol in protocols.items()
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

    def status(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.profile(owner_id, connection_id)
        record = self.credentials.read(owner_id, connection_id)
        return {
            "state": record.state.value,
            "account_label": record.tokens.account_label if record.tokens else "",
            "billing": SUBSCRIPTION_BILLING,
        }

    async def login(
        self, owner_id: str, connection_id: str, *, user_id: str = ""
    ) -> dict[str, Any]:
        profile = self.profile(owner_id, connection_id)
        if self.credentials.read(owner_id, connection_id).state == CredentialState.CONNECTED:
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

    def disconnect(self, owner_id: str, connection_id: str) -> None:
        profile = self.profile(owner_id, connection_id)
        scope = (owner_id, connection_id)
        self._connection_epochs[scope] = self._connection_epochs.get(scope, 0) + 1
        self._cancel_directories(owner_id, connection_id)
        self.authorizations[profile[OAUTH_PROVIDER_KEY]].cancel_connection(owner_id, connection_id)
        self.credentials.revoke(owner_id, connection_id)
        self.bridge.revoke_connection(owner_id, connection_id)

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
                headers={
                    ACCOUNT_HEADER: tokens.account_id,
                    ORIGINATOR_HEADER: PRODUCT_ORIGINATOR,
                },
            )
        except OAuthFailure as error:
            raise CompletionCredentialError(error.code) from None
        except UnknownProfileError:
            raise CompletionCredentialError("oauth_connection_unavailable") from None

    def _cancel_directories(self, owner_id: str, connection_id: str = "") -> None:
        for task, scope in tuple(self._directories.items()):
            if scope[0] == owner_id and (not connection_id or scope[1] == connection_id):
                if task is not asyncio.current_task():
                    task.cancel()

    async def models(self, owner_id: str, connection_id: str, *, fresh: bool = False) -> dict:
        return await self._directory(owner_id, connection_id, complete=False, fresh=fresh)

    async def catalog(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        return await self._directory(owner_id, connection_id, complete=True)

    async def sync_directory(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        """配置时拉取上游目录并落快照；读路径（catalog）不再打上游。

        登录成功、加载模型、保存选择、显式 refresh 这些「配置时刻」调用本方法；模型目录/
        厂商列表的读路径只读 ``profile[model_directory]`` 快照，避免每次打开界面都等上游。
        """

        directory = await self._fetch_models(owner_id, connection_id, complete=False)
        snapshot = {"models": directory.get("models") or [], "fetched_at": time.time()}
        self.profiles.set_directory(connection_id, snapshot, owner_id=owner_id)
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
        cached = None if fresh else self._directory_cache.get(cache_key)
        owner_epoch = self._owner_epochs.get(owner_id, 0)
        connection_epoch = self._connection_epochs.get(scope, 0)
        if cached is not None:
            stamp, cached_owner, cached_connection, payload = cached
            if (
                cached_owner == owner_epoch
                and cached_connection == connection_epoch
                and time.monotonic() - stamp < SUBSCRIPTION_DIRECTORY_CACHE_SECONDS
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
            inflight = asyncio.create_task(
                self._fetch_models(owner_id, connection_id, complete=complete)
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
        except OAuthFailure:
            if cached is not None and cached[1] == owner_epoch and cached[2] == connection_epoch:
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
        profile = self.profile(owner_id, connection_id)
        policy = OAUTH_PROVIDERS[profile[OAUTH_PROVIDER_KEY]]
        material = await self.resolve(owner_id, connection_id, require_enabled=False)
        response: httpx.Response | None = None
        for attempt in range(SUBSCRIPTION_MODELS_RETRY_ATTEMPTS):
            try:
                response = await self.client.get(
                    policy.models_endpoint,
                    params={"client_version": SUBSCRIPTION_MODELS_COMPATIBILITY_VERSION},
                    headers={**material.headers, "Authorization": f"Bearer {material.api_key}"},
                )
            except httpx.HTTPError as error:
                # TLS 信任失败、DNS 失败与超时都归到这一支，只报「不可用」无法区分，
                # 而错误详情正是唯一能分辨它们的字段。上游响应体与请求头不入日志。
                LOGGER.warning(
                    "oauth_models_transport_failed endpoint=%s error_class=%s detail=%s",
                    policy.models_endpoint,
                    type(error).__name__,
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
                                if isinstance(level, dict) and isinstance(level.get("effort"), str)
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
    ) -> CompletionRegistration:
        profile = self.profile(owner_id, connection_id)
        if not profile.get(ENABLED_KEY) or model_id not in {
            row[MODEL_ID_KEY] for row in profile[SELECTED_MODELS_KEY]
        }:
            raise OAuthFailure("oauth_model_unavailable")
        if self.credentials.read(owner_id, connection_id).state != CredentialState.CONNECTED:
            raise OAuthFailure("oauth_reauth_required")
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

        return self.bridge.register(
            endpoint=policy.responses_endpoint,
            responses_endpoint=policy.responses_endpoint,
            api_key="",
            wire_protocol=ModelWireProtocol.RESPONSES,
            owner_id=owner_id,
            connection_id=connection_id,
            session_id=session_id,
            credential_resolver=self.resolve,
            catalog_resolver=self.catalog,
            request_policy=request_policy,
            model_routes=model_routes,
            trust_env=SUBSCRIPTION_TRUST_ENV,
            reasoning_effort=reasoning_effort,
            provider=OPENAI_PROVIDER,
        )

    @staticmethod
    def request_policy(payload: Mapping[str, Any]) -> dict[str, Any]:
        # Preserve tool/reasoning items exactly; subscription calls must not persist
        # responses upstream. Streaming is supplied by the runtime's Responses call.
        result = {**payload, "store": False}
        items = payload.get("input")
        if isinstance(items, list):
            # Inline history is self-contained. Provider-generated item IDs are not
            # portable across providers; tool call_id links remain untouched.
            # References are different: their ID is required to resolve the item.
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
