"""ScholarSeed model catalog and Codex App Server connection projection."""

from __future__ import annotations

import asyncio
import os
import re
import secrets
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlparse

from scholarseed_runtime.contract import (
    ModelConnectionMode,
    ModelCredential,
    ModelCredentialPort,
    ModelIntent,
    ModelThinking,
    ModelTransport,
    ModelWireProtocol,
)
from service.chat.active import RUNTIME_ID
from service.chat.provenance import PROVIDER_PRESET_ID_FIELD, ModelRun
from service.chat.service.completions import (
    CHAT_COMPLETIONS_SUFFIX,
    RESPONSES_SUFFIX,
    CompletionBridge,
)
from service.chat.service.probe import list_upstream_models, probe_personal_connection
from service.chat.service.providers import (
    preset_provider_labels,
    preset_providers,
    uses_vendor_capability_registry,
)
from service.chat.service.settings import SettingsService
from service.chat.service.subscriptions import SubscriptionService
from service.identity.service.account_token import CONV_MESSAGE_ID_HEADER, CONV_TURN_ID_HEADER
from service.identity.utils import LOCAL_USER_ID
from service.settings.capabilities import (
    BUDGET_FORM,
    CAPABILITY_DECLARED_KEY,
    CAPABILITY_HINT_KEY,
    CAPABILITY_PROVENANCE_KEY,
    CAPABILITY_PROVENANCE_USER,
    CAPABILITY_REASON_KEY,
    CONTEXT_WINDOW_KEY,
    EFFORT_FORM,
    IMAGE_INPUT_KEY,
    INPUT_MODALITIES_KEY,
    MAX_OUTPUT_TOKENS_KEY,
    PDF_INPUT_KEY,
    REASONING_EFFORTS_KEY,
    REASONING_OPTIONS_KEY,
    TOGGLE_FORM,
    apply_capability,
    bundled_registry,
    modality_flags,
    reasoning_option,
    unverified_reason,
    vendor_capability_hint,
)
from service.settings.catalog import (
    apply_model_to_config,
    available_models,
    current_model_key,
    invalidate_codex_auth_cache,
    resolve_model_choice,
    subscription_groups,
    wire_model_name,
)
from service.settings.config import load_config_values
from service.settings.connections import (
    DECLARED_CAPABILITY_INT_KEYS,
    ENABLED_KEY,
    MODEL_HIDDEN_KEY,
    MODEL_ID_KEY,
    MODEL_LABEL_KEY,
    OAUTH_PROFILE_ID_PREFIX,
    OPENAI_PROVIDER,
    PRESET_ID_KEY,
    SELECTED_MODELS_KEY,
    ModelProfileStore,
    UnknownProfileError,
    apply_profile,
    is_oauth_connection,
    parse_personal_model_key,
    personal_model_key,
    prepare_personal_connection,
)
from service.settings.credentials import CredentialState
from service.settings.oauth import OAuthFailure

SCHOLARSEED_CODEX_PROVIDER_ID = "scholarseed"
SCHOLARSEED_CODEX_PROVIDER_NAME = "ScholarSeed"
SCHOLARSEED_MODEL_API_KEY_ENV = "SCHOLARSEED_MODEL_API_KEY"
SCHOLARSEED_MODEL_HEADER_ENV_PREFIX = "SCHOLARSEED_MODEL_HEADER"
CODEX_AUTO_REVIEW_MODEL_ID = "codex-auto-review"
SUBSCRIPTION_BILLING = "subscription"
# Historical session identity only; never offered or admitted as a model connection.
RETIRED_NATIVE_MODEL_KEY = "codex-subscription-default"
API_BILLING = "api"
PERSONAL_MODEL_SOURCE = "personal"
# BYOK reaches an upstream only where a translation leg exists. Today that is the
# OpenAI-compatible one (``CompletionBridge`` turns Responses into Chat Completions).
# Anthropic Messages is proposal 51 P3; until it lands an anthropic profile must be
# refused loudly, because sending OpenAI-shaped bodies to ``/v1/messages`` surfaces as
# an opaque upstream 404 that a user cannot attribute.
BYOK_SUPPORTED_PROVIDERS = frozenset({OPENAI_PROVIDER})
PERSONAL_CONNECTION_INVALID_ERROR = "连接验证失败，请检查服务地址、凭证和模型："
PERSONAL_PROVIDER_UNSUPPORTED_ERROR = (
    "only OpenAI-compatible personal endpoints are supported in this version"
)
# 内置网关模型的鉴权凭据来自登录用户的 access JWT（或自配 api_key）。未登录且无自配
# key 时网关必然拒调用，故选择器里置灰并给出可读原因，执行面也据此拦一层防 UI 被绕过。
GATEWAY_CREDENTIAL_REQUIRED_REASON = "登录后可使用内置模型"
GATEWAY_CREDENTIAL_REQUIRED_CODE = "gateway_credential_required"
SUBSCRIPTION_CONNECTION_REQUIRED_REASON = "请在模型服务中连接 ChatGPT"
SUBSCRIPTION_CONNECTION_REQUIRED_CODE = "subscription_connection_required"
GATEWAY_LOGIN_REQUIRED_ERROR = "使用内置模型需先登录；或在设置中配置自有模型连接后再试。"
OPENAI_PROVIDER_ALIASES = frozenset(("openai", "openai-compatible", "openai_compatible"))
HEADER_ENV_PATTERN = re.compile(r"[^A-Z0-9]+")
MODEL_UNAVAILABLE_ERROR = "session_model_unavailable"
# Product-owned configuration accessor.  Kept as a named seam so model tests and
# callers can replace the effective persisted catalog without importing DamoAgent SDK.
load_builtin_work_config = load_config_values


class SessionModelUnavailableError(ValueError):
    """The durable UI model key can no longer be projected to a runtime connection."""

    safe_error = MODEL_UNAVAILABLE_ERROR


class SessionCredentialPort(ModelCredentialPort):
    """Invocation-scoped credential resolver; secret values never enter the intent."""

    def __init__(self, credential_ref: str, credential: ModelCredential) -> None:
        self._credential_ref = credential_ref
        self._credential = credential

    async def resolve(self, credential_ref: str) -> ModelCredential:
        if credential_ref != self._credential_ref:
            raise ValueError("model credential reference is unavailable")
        return self._credential


def _thinking_token(thinking: ModelThinking | None) -> str:
    """把思考意图压成 revision 的一段稳定身份。

    只用于变更检测：开关/预算没有档位名可用，而 revision 必须随选择改变，否则改了开关
    不会形成新的命令身份。这里不引入任何厂商字段名，也不把 ``on``/``off`` 当数据存下来。
    """

    if thinking is None:
        return ""
    enabled = "" if thinking.enabled is None else str(int(thinking.enabled))
    budget = "" if thinking.budget is None else str(thinking.budget)
    return f"{enabled}/{budget}"


@dataclass(frozen=True)
class SessionModelSpec:
    """One selected UI model plus the private connection used to open a session."""

    key: str
    model_name: str
    config: dict[str, Any]
    billing: str
    model_run: ModelRun | None = None
    executable: str = ""
    codex_provider: dict[str, Any] | None = None
    process_environment: dict[str, str] | None = None
    # 该坐标声明的思考形态载荷（``reasoning_options``）。思考参数按声明生成，所以解析一次
    # 就要带到消费方；让下游再按模型名判一次，等于回到 proposal 78 I1 否决的做法。
    reasoning_options: list[dict[str, Any]] | None = None

    def runtime_model(
        self, reasoning_effort: str = "", thinking: ModelThinking | None = None
    ) -> tuple[ModelIntent, ModelCredentialPort | None]:
        """Project product configuration into the vendor-neutral Gateway contract."""

        revision = (
            f"model:{self.key}:effort:{reasoning_effort}" f":thinking:{_thinking_token(thinking)}"
        )
        provider = dict(self.codex_provider or {})
        endpoint = str(provider.get("base_url") or "").strip()
        if not endpoint:
            raise SessionModelUnavailableError("model transport endpoint is unavailable")
        environment = dict(self.process_environment or {})
        api_key = str(environment.get(str(provider.get("env_key") or "")) or "")
        headers = {
            str(name): str(environment.get(str(env_name)) or "")
            for name, env_name in dict(provider.get("env_http_headers") or {}).items()
            if str(environment.get(str(env_name)) or "")
        }
        credential_ref = ""
        credential_port: ModelCredentialPort | None = None
        if api_key or headers:
            credential_ref = secrets.token_urlsafe(24)
            credential_port = SessionCredentialPort(
                credential_ref,
                ModelCredential(api_key=api_key, headers=headers),
            )
        context_window = _optional_int(_model_metadata(self.config).get("model_context_window"))
        intent = ModelIntent(
            model_ref=self.model_name,
            revision=revision,
            transport=ModelTransport(
                mode=ModelConnectionMode.REMOTE,
                endpoint=endpoint,
                wire_protocol=ModelWireProtocol(
                    str(provider.get("wire_api") or ModelWireProtocol.RESPONSES.value)
                ),
                credential_ref=credential_ref,
                supports_websockets=bool(provider.get("supports_websockets")),
            ),
            context_window=context_window,
            reasoning_effort=reasoning_effort,
            thinking=thinking,
        )
        return intent, credential_port


class ModelService:
    """Expose product-managed model connections independently of runtime authentication."""

    def __init__(
        self,
        settings: SettingsService,
        completions: CompletionBridge | None = None,
        account_tokens: Any | None = None,
        profiles: ModelProfileStore | None = None,
        subscriptions: SubscriptionService | None = None,
        turn_ids: Callable[[str], str] | None = None,
    ) -> None:
        self._settings = settings
        self._completions = completions or CompletionBridge("")
        # AccountTokenHolder（可空）。未配账号服务 / 未登录时整条计量腿静默不参与，
        # 网关侧会把这些调用记成 anonymous（预期内，不报错）。
        self._account_tokens = account_tokens
        # 产品会话 id → 当前已准入的产品轮 id（可空）。由组合根注入：轮的真值在会话域的
        # 热会话表里，模型域只负责把它投影成出站计量头。缺省时轮维度留空，与会话头同语义。
        self._turn_ids = turn_ids
        self._profiles = profiles or ModelProfileStore()
        self._subscriptions = subscriptions

    async def catalog(self, *, refresh: bool = False, user_id: str = "") -> dict[str, Any]:
        if refresh:
            invalidate_codex_auth_cache()
        config = self._config()
        document = self._profiles.list(owner_id=user_id)
        models = self._catalog_models(config, document)
        self._mark_gateway_credential_gate(models, config, user_id)
        self._mark_subscription_gate(models, user_id)
        if self._subscriptions is not None:
            profiles = {
                item["profile_id"]
                for item in models
                if item.get("billing") == SUBSCRIPTION_BILLING and not item.get("disabled")
            }
            for profile_id in profiles:
                try:
                    directory = await self._subscriptions.models(user_id, profile_id)
                except OAuthFailure:
                    for item in models:
                        if item.get("profile_id") == profile_id:
                            item["reasoning_efforts"] = None
                            item["reasoning_effort_error"] = (
                                "暂时无法读取订阅模型的思考深度，请刷新模型目录。"
                            )
                    continue
                offered = {row["id"]: row for row in directory["models"]}
                for item in models:
                    if item.get("profile_id") == profile_id:
                        native = offered.get(item["model_id"], {})
                        if native.get("reasoning_efforts") is not None:
                            item["reasoning_efforts"] = native.get("reasoning_efforts")
                        # Keep the declared form alongside the legacy effort list so the
                        # renderer can distinguish effort, toggle and fixed-on models.
                        if native.get("reasoning_options") is not None:
                            item["reasoning_options"] = native.get("reasoning_options")
                        item["reasoning_effort"] = native.get("reasoning_effort", "")
        return {
            "configured": bool(models),
            "runtime_id": RUNTIME_ID,
            "current_model": self._selected_key(config, models, user_id=user_id),
            "available_models": models,
            # 管理页专用的另一半分区: 关掉显示的模型绝不进 available_models, 否则对话框又能
            # 选到它们; 但管理页必须仍能看到它们, 才谈得上恢复。
            "hidden_models": self._personal_items(document, hidden=True),
            "subscription_groups": subscription_groups(models),
            "reason": "" if models else "scholarseed_model_catalog_empty",
        }

    async def validate_effort(self, model_id: str, effort: str, *, user_id: str = "") -> None:
        if not effort:
            return
        catalog = await self.catalog(user_id=user_id)
        model = next((row for row in catalog["available_models"] if row["key"] == model_id), None)
        if model is None or effort not in (model.get("reasoning_efforts") or ()):
            raise SessionModelUnavailableError("所选模型不支持此思考深度，请重新选择。")

    async def validate_thinking(
        self, model_id: str, thinking: ModelThinking, *, user_id: str = ""
    ) -> None:
        """开关/预算的选择同样要落在「这条坐标声明过的形态」上。

        与档位的 ``validate_effort`` 同构，且形态判据只查 ``reasoning_option`` 一个点：未声明
        该形态就拒掉 —— 存下界面上看得见、出站时却被静默丢弃的选择，比报错更糟。
        """

        if thinking.enabled is None and thinking.budget is None:
            return
        catalog = await self.catalog(user_id=user_id)
        model = next((row for row in catalog["available_models"] if row["key"] == model_id), None)
        options = (model or {}).get(REASONING_OPTIONS_KEY)
        if thinking.enabled is not None and reasoning_option(options, TOGGLE_FORM) is None:
            raise SessionModelUnavailableError("所选模型不支持思考开关，请重新选择。")
        if thinking.budget is not None:
            budget = reasoning_option(options, BUDGET_FORM)
            if budget is None:
                raise SessionModelUnavailableError("所选模型不支持思考预算，请重新选择。")
            # 没有确认过区间就不发数值（厂商文档两处口径互相矛盾），因此这种选择同样不能存。
            if budget.get("min") is None or budget.get("max") is None:
                raise SessionModelUnavailableError("该模型的思考预算区间尚未确认，请改用思考开关。")

    def _mark_subscription_gate(self, models: list[dict[str, Any]], user_id: str) -> None:
        for model in models:
            if model.get("billing") != SUBSCRIPTION_BILLING:
                continue
            state = (
                self._subscriptions.status(user_id, model["profile_id"])["state"]
                if self._subscriptions is not None
                else CredentialState.DISCONNECTED.value
            )
            if state != CredentialState.CONNECTED.value:
                model["disabled"] = True
                model["disabled_reason"] = SUBSCRIPTION_CONNECTION_REQUIRED_REASON
                model["disabled_reason_code"] = SUBSCRIPTION_CONNECTION_REQUIRED_CODE

    @classmethod
    def _mark_gateway_credential_gate(
        cls, models: list[dict[str, Any]], config: Mapping[str, Any], user_id: str
    ) -> None:
        """未登录且无自配 key 时，把内置网关模型置灰并给出可读原因。

        只改选择器的可选性投影，不从目录里剔除条目：登录后同一份目录即恢复可选。
        """

        if not cls._gateway_credential_absent(config, user_id):
            return
        for item in models:
            if cls._requires_gateway_credential(item):
                item["disabled"] = True
                item["disabled_reason"] = GATEWAY_CREDENTIAL_REQUIRED_REASON
                item["disabled_reason_code"] = GATEWAY_CREDENTIAL_REQUIRED_CODE

    async def select(self, model_key: str, *, persist: bool, user_id: str = "") -> dict[str, Any]:
        requested = model_key.strip()
        config = self._config()
        document = self._profiles.list(owner_id=user_id)
        models = self._catalog_models(config, document)
        available = {str(row.get("key") or "") for row in models}
        if not requested or requested not in available:
            raise SessionModelUnavailableError(
                "model is not available in the ScholarSeed model catalog"
            )
        if persist:
            self._settings.set_runtime_model(requested)
        return {**await self.catalog(refresh=False, user_id=user_id), "current_model": requested}

    def profiles(self, *, user_id: str = "") -> dict[str, Any]:
        """Return the redacted personal connection inventory."""

        document = self._profiles.list(owner_id=user_id)
        if self._subscriptions is not None:
            for profile in document["profiles"]:
                if is_oauth_connection(profile):
                    profile["oauth"] = self._subscriptions.status(user_id, profile["id"])
        return document

    def inference_connection(
        self, model_key: str, *, user_id: str, invocation_id: str = ""
    ) -> dict[str, Any]:
        """Resolve the exact selection without opening/registering a chat bridge.

        Private return value: only the inference transport may consume it.
        """
        config = self._config()
        document = self._profiles.list(owner_id=user_id)
        rows = self._catalog_models(config, document)
        row = next((item for item in rows if item["key"] == model_key), None)
        if row is None:
            raise SessionModelUnavailableError("请先在设置 → 模型服务配置并选择模型。")
        if row.get("billing") == SUBSCRIPTION_BILLING:
            return {
                "key": model_key,
                "billing": SUBSCRIPTION_BILLING,
                "image_input": row.get("image_input") is True,
                "pdf_input": row.get("pdf_input") is True,
                "context_window": row.get("context_window"),
            }
        personal = row.get("source") == PERSONAL_MODEL_SOURCE
        effective = (
            apply_profile(config, row["profile_id"], self._profiles, model_id=row["model_id"])
            if personal
            else apply_model_to_config(config, resolve_model_choice(model_key, config))
        )
        _require_supported_personal_provider(effective.get("provider", OPENAI_PROVIDER))
        headers = dict(effective.get("headers") or {})
        token = (
            self._account_tokens.current(user_id) if not personal and self._account_tokens else ""
        )
        key = str(effective.get("api_key") or "") if personal else _api_key(effective)
        bearer = token or key
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        if not headers:
            raise SessionModelUnavailableError("请先登录或在设置 → 模型服务配置自有模型。")
        if invocation_id and not personal:
            # 这条路径上「一次 invocation = 一轮对话」，所以两个维度同值；仍然分两个头发，
            # 因为网关把它们读成两列（chat_id 归并会话、turn_id 归并轮），会话头不能被替换。
            headers[CONV_MESSAGE_ID_HEADER] = invocation_id
            headers[CONV_TURN_ID_HEADER] = invocation_id
        base = _base_url(effective).rstrip("/")
        call_url = str(effective.get("call_url") or "")
        wire = str(
            effective.get("wire_api")
            or (
                ModelWireProtocol.CHAT_COMPLETIONS.value
                if call_url.endswith(CHAT_COMPLETIONS_SUFFIX)
                else ModelWireProtocol.RESPONSES.value
            )
        )
        endpoint = (
            call_url
            or f"{base}{RESPONSES_SUFFIX if wire == ModelWireProtocol.RESPONSES.value else CHAT_COMPLETIONS_SUFFIX}"
        )
        return {
            "key": model_key,
            "billing": API_BILLING,
            "endpoint": endpoint,
            "headers": headers,
            "wire_api": wire,
            "model": wire_model_name(str(effective.get("model_name") or "")),
            "image_input": effective.get("image_input") is True,
            "pdf_input": effective.get("pdf_input") is True,
            "context_window": row.get("context_window"),
            # 出站思考参数按这条坐标的声明生成，所以形态与 provider 家族要一起带下去；
            # 让 transport 自己按模型名判，就是回到 proposal 78 I1 否决掉的那套做法。
            "provider": str(row.get("provider") or ""),
            REASONING_OPTIONS_KEY: row.get(REASONING_OPTIONS_KEY),
        }

    async def save_profile(
        self, values: Mapping[str, Any], profile_id: str = "", *, user_id: str = ""
    ) -> dict[str, Any]:
        """Validate the current candidate before committing an owned connection."""
        existing = self._profiles.profile(profile_id, owner_id=user_id) if profile_id else None
        if profile_id and existing is None:
            raise UnknownProfileError("model connection is unavailable")
        candidate = prepare_personal_connection(values, existing=existing)
        if is_oauth_connection(candidate):
            if self._subscriptions is None:
                raise SessionModelUnavailableError("oauth_service_unavailable")
            if candidate[SELECTED_MODELS_KEY]:
                if not profile_id:
                    raise SessionModelUnavailableError("oauth_login_before_model_selection")
                await self._subscriptions.validate_models(
                    user_id, profile_id, candidate[SELECTED_MODELS_KEY]
                )
        else:
            await self._validate_personal_connection(candidate)
        profile = self._profiles.upsert(candidate, profile_id, owner_id=user_id)
        if is_oauth_connection(profile) and existing is not None:
            if existing[SELECTED_MODELS_KEY] != profile[SELECTED_MODELS_KEY]:
                self._completions.revoke_connection(user_id, profile_id)
        return {**self.profiles(user_id=user_id), "profile": profile}

    async def set_profile_enabled(
        self, profile_id: str, enabled: bool, *, user_id: str = ""
    ) -> dict[str, Any]:
        """Toggle whether one connection's selected models reach the model menu."""

        if enabled:
            candidate = self._profiles.profile(profile_id, owner_id=user_id)
            if candidate is None:
                raise UnknownProfileError("model connection is unavailable")
            if not is_oauth_connection(candidate):
                await self._validate_personal_connection(candidate)
        self._profiles.set_enabled(profile_id, enabled, owner_id=user_id)
        if not enabled:
            self._completions.revoke_connection(user_id, profile_id)
        return await self._selection(user_id=user_id)

    async def set_model_hidden(
        self, profile_id: str, model_id: str, hidden: bool, *, user_id: str = ""
    ) -> dict[str, Any]:
        """Toggle whether one selected model of one connection reaches the model menu.

        与 ``set_profile_enabled`` 不同, 这里不重新校验连接: 改的是自己库存里某个模型的显示
        状态, 走一次 probe 会让「关掉显示」取决于那个端点当时是否可达。也不吊销连接的补全
        缓存 —— 同一条连接上其余模型仍然可见可用。
        """

        self._profiles.set_model_hidden(profile_id, model_id, hidden, owner_id=user_id)
        return await self._selection(user_id=user_id)

    @staticmethod
    async def _validate_personal_connection(candidate: Mapping[str, Any]) -> None:
        """Check the frozen candidate without writing state or blocking Serve's loop."""
        _require_supported_personal_provider(candidate.get("provider"))
        validate = (
            probe_personal_connection if candidate[SELECTED_MODELS_KEY] else list_upstream_models
        )
        result = await asyncio.to_thread(validate, candidate)
        if not result["ok"]:
            raise ValueError(f"{PERSONAL_CONNECTION_INVALID_ERROR}{result['message']}")

    async def delete_profile(self, profile_id: str, *, user_id: str = "") -> dict[str, Any]:
        profile = self._profiles.profile(profile_id, owner_id=user_id)
        if profile is not None and is_oauth_connection(profile) and self._subscriptions is not None:
            self._subscriptions.disconnect(user_id, profile_id)
        self._profiles.delete(profile_id, owner_id=user_id)
        return await self._selection(user_id=user_id)

    def probe_profile(
        self, values: Mapping[str, Any], profile_id: str = "", *, user_id: str = ""
    ) -> dict[str, Any]:
        """Test one candidate connection without saving it or changing the active one."""

        _require_supported_personal_provider(values.get("provider"))
        existing = self._profiles.profile(profile_id, owner_id=user_id) if profile_id else None
        if profile_id and existing is None:
            raise UnknownProfileError("model connection is unavailable")
        if is_oauth_connection(values) or (existing and is_oauth_connection(existing)):
            raise SessionModelUnavailableError("use_oauth_model_directory")
        return probe_personal_connection(values, existing)

    @staticmethod
    def providers() -> dict[str, Any]:
        """Expose the endpoint presets the connection editor offers as form hints."""

        return {"providers": preset_providers()}

    def profile_models(
        self, values: Mapping[str, Any], profile_id: str = "", *, user_id: str = ""
    ) -> dict[str, Any]:
        """Read the models a candidate endpoint advertises, without saving anything."""

        _require_supported_personal_provider(values.get("provider"))
        existing = self._profiles.profile(profile_id, owner_id=user_id) if profile_id else None
        if profile_id and existing is None:
            raise UnknownProfileError("model connection is unavailable")
        if is_oauth_connection(values) or (existing and is_oauth_connection(existing)):
            raise SessionModelUnavailableError("use_oauth_model_directory")
        return list_upstream_models(values, existing)

    async def _selection(self, *, user_id: str = "") -> dict[str, Any]:
        """Project catalogue and inventory together, as the selector expects them."""

        return {
            **await self.catalog(refresh=False, user_id=user_id),
            **self.profiles(user_id=user_id),
        }

    def selected_model_key(self, model_key: str = "", *, user_id: str = "") -> str:
        """Resolve account-visible model intent without registering execution credentials."""
        config = self._config()
        document = self._profiles.list(owner_id=user_id)
        return self._available_key(model_key, config, document)

    def _available_key(
        self, model_key: str, config: dict[str, Any], document: Mapping[str, Any]
    ) -> str:
        models = self._catalog_models(config, document)
        selected = model_key.strip() or self._selected_key(config, models)
        available = {str(row.get("key") or "") for row in models}
        if not selected:
            raise SessionModelUnavailableError("selected ScholarSeed model is unavailable: <empty>")
        if selected not in available:
            raise SessionModelUnavailableError(
                f"selected ScholarSeed model is unavailable: {selected}; select a configured model connection"
            )
        return selected

    def session_spec(
        self,
        model_key: str = "",
        *,
        session_id: str = "",
        user_id: str = "",
        reasoning_effort: str | None = None,
        thinking: ModelThinking | None = None,
        turn_id_provider: Callable[[str], str] | None = None,
        source_text: str | None = None,
    ) -> SessionModelSpec:
        """Project the selected model onto one session's private connection.

        ``session_id`` / ``user_id`` only feed the gateway metering headers: the product
        session id is what makes per-session cost aggregation work at all (the gateway's
        materialised view filters on a non-empty chat id), and the user id is what lets the
        outbound token be resolved *at call time* instead of snapshotted here.

        ``turn_id_provider`` feeds the third metering dimension (per-turn aggregation). It is a
        hook rather than a value because one registration outlives many turns; callers whose
        registration *is* one turn pass their own resolver, everyone else gets the session-keyed
        one injected into this service.
        """

        config = self._config()
        document = self._profiles.list(owner_id=user_id)
        selected = self._available_key(model_key, config, document)
        selected_row = next(
            row for row in self._catalog_models(config, document) if row["key"] == selected
        )
        declared_options = selected_row.get(REASONING_OPTIONS_KEY)
        reasoning_options = list(declared_options or ()) or None
        model_run = ModelRun(
            provider_id=str(
                selected_row.get("profile_id") or selected_row.get("provider") or selected
            ),
            provider_label=str(
                selected_row.get("provider_label") or selected_row.get("provider") or selected
            ),
            model_id=wire_model_name(
                str(selected_row.get("model_id") or selected_row.get("model_name") or selected)
            ),
            provider_preset_id=str(selected_row.get(PROVIDER_PRESET_ID_FIELD) or ""),
        )
        resolve_turn_id = turn_id_provider if turn_id_provider is not None else self._turn_ids
        personal_profile_id, personal_model_id = parse_personal_model_key(selected)
        if personal_profile_id in self._profile_ids(document):
            profile = self._profiles.profile(personal_profile_id, owner_id=user_id)
            if profile is not None and is_oauth_connection(profile):
                if self._subscriptions is None:
                    raise SessionModelUnavailableError("oauth_service_unavailable")
                registration = self._subscriptions.register(
                    user_id,
                    personal_profile_id,
                    personal_model_id,
                    session_id,
                    {CODEX_AUTO_REVIEW_MODEL_ID: personal_model_id},
                    reasoning_effort=reasoning_effort,
                )
                return SessionModelSpec(
                    key=selected,
                    model_run=model_run,
                    model_name=personal_model_id,
                    config={},
                    billing=SUBSCRIPTION_BILLING,
                    reasoning_options=reasoning_options,
                    codex_provider={
                        "base_url": registration.base_url,
                        "wire_api": ModelWireProtocol.RESPONSES.value,
                    },
                )
            # ``apply_profile`` 是唯一让个人连接完全决定路由的入口: 它清掉内置配置里
            # 指向产品网关的 call_url 与 *_env 间接键, 再按声明的协议派生调用地址。
            runtime_config = apply_profile(
                config,
                personal_profile_id,
                self._profiles,
                model_id=personal_model_id,
            )
            _require_supported_personal_provider(runtime_config.get("provider"))
            personal_provider, personal_environment = _codex_provider(
                runtime_config,
                self._completions,
                session_id=session_id,
                reasoning_effort=reasoning_effort,
                reasoning_options=reasoning_options,
                thinking=thinking,
                turn_id_provider=resolve_turn_id,
                source_text=source_text,
            )
            return SessionModelSpec(
                key=selected,
                model_run=model_run,
                model_name=wire_model_name(str(runtime_config.get("model_name") or "").strip()),
                config=runtime_config,
                billing=API_BILLING,
                reasoning_options=reasoning_options,
                executable=self._settings.runtime_executable(),
                codex_provider=personal_provider,
                process_environment=personal_environment,
            )
        choice = resolve_model_choice(selected, config)
        runtime_config = apply_model_to_config(config, choice)
        billing = str(choice.get("billing") or API_BILLING).strip()
        if str(user_id or "").strip() == LOCAL_USER_ID and not _api_key(runtime_config):
            raise SessionModelUnavailableError(GATEWAY_LOGIN_REQUIRED_ERROR)
        provider, environment = _codex_provider(
            runtime_config,
            self._completions,
            session_id=session_id,
            user_id=user_id,
            account_tokens=self._account_tokens,
            reasoning_effort=reasoning_effort,
            reasoning_options=reasoning_options,
            thinking=thinking,
            turn_id_provider=resolve_turn_id,
            source_text=source_text,
        )
        return SessionModelSpec(
            key=selected,
            model_run=model_run,
            model_name=wire_model_name(str(runtime_config.get("model_name") or "").strip()),
            config=runtime_config,
            billing=billing,
            reasoning_options=reasoning_options,
            executable=self._settings.runtime_executable(),
            codex_provider=provider,
            process_environment=environment,
        )

    def rebind_owner(self, session_id: str, user_id: str) -> int:
        """Move one session's outbound metering identity to the account driving it now.

        Called when a warm session is handed to a different logged-in account: the bridge
        resolves the token from that account's slot, so leaving the old id in place makes every
        model call reach for a signed-out credential.
        """

        return self._completions.rebind_owner(session_id, user_id)

    def release_session(self, session_id: str) -> int:
        """Drop the bridge registrations a closed session owned.

        Called from ``LiveSession.aclose``. Without it a closed session's ``bridge_id``
        stays callable (loopback reachability is the only check) until the TTL sweep runs,
        and every open/rebind/resume would leak one more entry holding an api key.
        """

        return self._completions.release(session_id)

    @staticmethod
    def usage(session_id: str) -> dict[str, Any]:
        return {
            "session_id": session_id or None,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": None,
        }

    @staticmethod
    def _config() -> dict[str, Any]:
        try:
            return load_builtin_work_config()
        except (FileNotFoundError, ValueError):
            return {}

    @classmethod
    def _catalog_models(
        cls, config: dict[str, Any], document: Mapping[str, Any]
    ) -> list[dict[str, Any]]:
        """Combine the built-in catalogue with the user's own endpoints.

        个人条目**不经** ``available_models``: 那条路径按 ``base_url`` 匹配决定用网关目录
        还是已清空的通用目录, 让个人端点参与进去会把「加了自己的端点, 内置模型列表空了」
        这个漂移带进来。产品层追加则对内置枚举零影响。
        """

        return [*cls._available(config), *cls._personal_items(document)]

    @staticmethod
    def _personal_items(
        document: Mapping[str, Any], *, hidden: bool = False
    ) -> list[dict[str, Any]]:
        """Project enabled connections' selected models, one visibility partition at a time.

        ``hidden`` 取「用户关掉了显示」的那一半。两个分区共用同一套投影, 模型管理页才能列出
        已隐藏的模型供恢复, 而不必在前端重算厂商标签和复合 key —— 那会变成第二份真值。
        """

        preset_labels = preset_provider_labels()
        items: list[dict[str, Any]] = []
        for profile in document.get("profiles") or ():
            if not bool(profile.get(ENABLED_KEY)):
                continue
            profile_id = str(profile.get("id") or "")
            vendor, vendor_preset_id = _vendor_label(profile, preset_labels)
            for model in profile.get(SELECTED_MODELS_KEY) or ():
                model_id = str(model.get(MODEL_ID_KEY) or "")
                if not model_id:
                    continue
                if bool(model.get(MODEL_HIDDEN_KEY)) != hidden:
                    continue
                model_label = str(model.get(MODEL_LABEL_KEY) or "") or model_id
                items.append(
                    {
                        "key": personal_model_key(profile_id, model_id),
                        "label": f"{vendor} · {model_label}" if vendor else model_label,
                        "provider": str(profile.get("provider") or ""),
                        "provider_label": vendor,
                        **(
                            {PROVIDER_PRESET_ID_FIELD: vendor_preset_id} if vendor_preset_id else {}
                        ),
                        "model_label": model_label,
                        "model_name": model_id,
                        "model_id": model_id,
                        **_personal_capability(model, profile, model_id),
                        "source": PERSONAL_MODEL_SOURCE,
                        "profile_id": profile_id,
                        "billing": (
                            SUBSCRIPTION_BILLING if is_oauth_connection(profile) else API_BILLING
                        ),
                        "reasoning_effort": "",
                    }
                )
        return items

    @staticmethod
    def _profile_ids(document: Mapping[str, Any]) -> set[str]:
        return {str(profile.get("id") or "") for profile in document.get("profiles") or ()}

    @staticmethod
    def _available(config: dict[str, Any]) -> list[dict[str, Any]]:
        # Native runtime authentication is not a product model connection. Until a
        # subscription connection supplies its own transport, it cannot be offered.
        return [
            dict(row)
            for row in available_models(config)
            if not bool(row.get("disabled")) and row.get("billing") != SUBSCRIPTION_BILLING
        ]

    @staticmethod
    def _requires_gateway_credential(item: Mapping[str, Any]) -> bool:
        """内置网关模型（非 Codex 订阅、非个人连接）调用时需要网关鉴权凭据。"""

        return (
            str(item.get("billing") or "") != SUBSCRIPTION_BILLING
            and str(item.get("source") or "") != PERSONAL_MODEL_SOURCE
        )

    @staticmethod
    def _gateway_credential_absent(config: Mapping[str, Any], user_id: str) -> bool:
        """网关凭据是否缺失：未登录（回落 local / 无身份）且 config 无自配 api_key。

        登录用户的真实 sub 会在调用时带出 access JWT；未登录回落 ``local``，网关只能拒。
        自建 / 自托管在 config 里显式配了 ``api_key`` 的场景不受影响。
        """

        if str(user_id or "").strip() not in ("", LOCAL_USER_ID):
            return False
        return not _api_key(config)

    def _selected_key(
        self,
        config: dict[str, Any],
        models: list[dict[str, Any]],
        *,
        user_id: str = "",
    ) -> str:
        available = {str(row.get("key") or "") for row in models}
        selected = self._settings.runtime_model() or current_model_key(config)
        if selected in available:
            return selected
        # An explicitly selected retired native connection must not silently switch
        # subscription usage to a paid API connection. The user selects a replacement.
        if selected == RETIRED_NATIVE_MODEL_KEY or selected.startswith(OAUTH_PROFILE_ID_PREFIX):
            return ""
        configured = current_model_key(config)
        if configured in available:
            return configured
        return ""


def _vendor_label(profile: Mapping[str, Any], preset_labels: Mapping[str, str]) -> tuple[str, str]:
    """Return the vendor label and its preset identity only when that branch supplied it.

    The stored ``provider`` is only the wire family (``openai``), so it is useless as a
    vendor name. A connection's own label wins, then the preset it declared, then the
    endpoint host — anything rather than letting a raw key reach the model menu.
    """

    own_label = str(profile.get("preview_name") or "").strip()
    if own_label:
        return own_label, ""
    preset_id = str(profile.get(PRESET_ID_KEY) or "").strip()
    preset_label = preset_labels.get(preset_id, "")
    if preset_label:
        return preset_label, preset_id
    return str(urlparse(str(profile.get("base_url") or "")).hostname or ""), ""


def _personal_capability(
    model: Mapping[str, Any], profile: Mapping[str, Any], model_id: str
) -> dict[str, Any]:
    """Project capabilities from user declarations or an exact official endpoint.

    自定义/代理端点仍严格遵守 proposal 78 I3：同一 id 可能是量化版或被代理
    截断，因此只信用户声明。但当 base_url 精确命中一条声明为厂商直连的预置时，
    该端点与 wire model 共同构成已验证坐标，可使用内置能力声明。用户显式声明始终覆盖
    厂商默认；未命中受信端点的字段仍按未确认收敛（fail-closed）。
    """

    trusted_endpoint = uses_vendor_capability_registry(str(profile.get("base_url") or ""))
    registry_capability = bundled_registry().lookup(model_id) if trusted_endpoint else None
    vendor = (
        registry_capability
        if registry_capability is not None and registry_capability.declared
        else None
    )
    out = apply_capability({}, vendor, lane=PERSONAL_MODEL_SOURCE) if vendor else {}
    unresolved: list[str] = []
    provenance = dict(out.get(CAPABILITY_PROVENANCE_KEY) or {})

    modalities = _declared_list(model, INPUT_MODALITIES_KEY)
    if modalities is None:
        if vendor is None or vendor.input_modalities is None:
            # 连接级两个布尔是既有声明面（设置页尚无模态入口），沿用其保守默认。
            out[IMAGE_INPUT_KEY] = bool(profile.get(IMAGE_INPUT_KEY, False))
            out[PDF_INPUT_KEY] = bool(profile.get(PDF_INPUT_KEY, False))
            unresolved.append("modalities")
    else:
        out[INPUT_MODALITIES_KEY] = modalities
        out.update(modality_flags(modalities))
        provenance["modalities"] = CAPABILITY_PROVENANCE_USER

    for key in DECLARED_CAPABILITY_INT_KEYS:
        declared = _optional_int(model.get(key)) or _optional_int(profile.get(key))
        if declared is None:
            if key not in out:
                unresolved.append(key)
            continue
        out[key] = declared
        provenance["limits"] = CAPABILITY_PROVENANCE_USER

    efforts = _declared_list(model, REASONING_EFFORTS_KEY)
    if efforts:
        out[REASONING_EFFORTS_KEY] = efforts
        out[REASONING_OPTIONS_KEY] = [{"kind": EFFORT_FORM, "values": efforts}]
        provenance["reasoning"] = CAPABILITY_PROVENANCE_USER
    elif vendor is None or vendor.reasoning_options is None:
        out[REASONING_EFFORTS_KEY] = None
        out[REASONING_OPTIONS_KEY] = None
        unresolved.append("reasoning")

    out[CAPABILITY_DECLARED_KEY] = bool(provenance) or bool(vendor and vendor.declared)
    out[CAPABILITY_PROVENANCE_KEY] = provenance
    if unresolved:
        out[CAPABILITY_REASON_KEY] = ";".join(
            unverified_reason(field_name, PERSONAL_MODEL_SOURCE) for field_name in unresolved
        )
    hint = vendor_capability_hint(model_id)
    if hint:
        out[CAPABILITY_HINT_KEY] = hint
    return out


def _declared_list(entry: Mapping[str, Any], key: str) -> list[str] | None:
    """Read one user-declared enum set; ``None`` means「没声明」而不是「声明为空集」."""

    value = entry.get(key)
    if not isinstance(value, list):
        return None
    items = list(dict.fromkeys(str(item).strip().lower() for item in value if str(item).strip()))
    return items or None


def _require_supported_personal_provider(provider: Any) -> None:
    """Refuse a personal provider whose upstream protocol has no translation leg."""

    if str(provider or "").strip().lower() not in BYOK_SUPPORTED_PROVIDERS:
        raise SessionModelUnavailableError(PERSONAL_PROVIDER_UNSUPPORTED_ERROR)


def _codex_provider(
    config: Mapping[str, Any],
    completions: CompletionBridge,
    *,
    session_id: str = "",
    user_id: str = "",
    account_tokens: Any | None = None,
    reasoning_effort: str | None = None,
    reasoning_options: list[dict[str, Any]] | None = None,
    thinking: ModelThinking | None = None,
    turn_id_provider: Callable[[str], str] | None = None,
    source_text: str | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    base_url = _base_url(config)
    if not base_url:
        raise SessionModelUnavailableError("ScholarSeed model API base_url is missing")
    api_key = _api_key(config)
    headers = config.get("headers")
    private_headers = dict(headers) if isinstance(headers, Mapping) else {}
    call_url = str(config.get("call_url") or "").strip()
    chat_completions = call_url.endswith(CHAT_COMPLETIONS_SUFFIX)
    if (
        chat_completions
        or reasoning_effort is not None
        or account_tokens is not None
        or completions.accepts_source(call_url or f"{base_url.rstrip('/')}{RESPONSES_SUFFIX}")
    ):
        # 会话 id 按会话固定，可以随注册快照；用户 token 7 天到期且现在直接站网关的鉴权位
        # （验签腿必须校 exp），所以必须**调用时动态取** —— 注册时快照会让长会话后期整批 401。
        # 身份本身也不能随闭包钉死：桌面端可以在会话热着的时候切号，之后由 rebind_owner
        # 把 owner_id 挪到当前账号（见 CompletionUpstream）。
        # 轮 id 同理但更甚：一次注册要跨这个会话之后所有的轮，快照只会把整会话记成一轮，
        # 所以它也是**调用时动态取**的钩子（形状对齐 token_provider）。
        metering_headers = dict(private_headers)
        if session_id:
            metering_headers[CONV_MESSAGE_ID_HEADER] = session_id
        selected_model = wire_model_name(str(config.get("model_name") or "").strip())
        registration = completions.register(
            endpoint=call_url or f"{base_url.rstrip('/')}{RESPONSES_SUFFIX}",
            responses_endpoint=f"{base_url.rstrip('/')}{RESPONSES_SUFFIX}",
            wire_protocol=(
                ModelWireProtocol.CHAT_COMPLETIONS
                if chat_completions
                else ModelWireProtocol.RESPONSES
            ),
            api_key=api_key,
            headers=metering_headers,
            model_routes=({CODEX_AUTO_REVIEW_MODEL_ID: selected_model} if selected_model else {}),
            token_provider=(account_tokens.current if account_tokens is not None else None),
            turn_id_provider=turn_id_provider,
            source_text=source_text,
            owner_id=user_id,
            session_id=session_id,
            reasoning_effort=reasoning_effort,
            reasoning_options=reasoning_options,
            thinking=thinking,
            provider=str(config.get("provider") or ""),
        )
        return {
            "name": SCHOLARSEED_CODEX_PROVIDER_NAME,
            "base_url": registration.base_url,
            "wire_api": "responses",
            "requires_openai_auth": False,
            "supports_websockets": False,
        }, {}
    provider: dict[str, Any] = {
        "name": SCHOLARSEED_CODEX_PROVIDER_NAME,
        "base_url": base_url.rstrip("/"),
        "wire_api": "responses",
        "supports_websockets": False,
    }
    environment: dict[str, str] = {}
    if api_key:
        provider["env_key"] = SCHOLARSEED_MODEL_API_KEY_ENV
        environment[SCHOLARSEED_MODEL_API_KEY_ENV] = api_key
    if isinstance(headers, Mapping):
        env_headers: dict[str, str] = {}
        for index, (raw_name, raw_value) in enumerate(headers.items()):
            name = str(raw_name).strip()
            value = str(raw_value).strip()
            if not name or not value:
                continue
            slug = HEADER_ENV_PATTERN.sub("_", name.upper()).strip("_") or str(index)
            env_name = f"{SCHOLARSEED_MODEL_HEADER_ENV_PREFIX}_{slug}_{index}"
            env_headers[name] = env_name
            environment[env_name] = value
        if env_headers:
            provider["env_http_headers"] = env_headers
    if not api_key and "env_http_headers" not in provider:
        raise SessionModelUnavailableError("ScholarSeed model API credential is missing")
    return provider, environment


def _base_url(config: Mapping[str, Any]) -> str:
    env_name = str(config.get("base_url_env") or "").strip()
    base = str(os.environ.get(env_name) or "").strip() if env_name else ""
    if not base:
        base = str(config.get("base_url") or "").strip()
    suffix = str(config.get("base_url_env_suffix") or "").strip().strip("/")
    return f"{base.rstrip('/')}/{suffix}" if base and suffix else base


def _api_key(config: Mapping[str, Any]) -> str:
    explicit = str(config.get("api_key") or "").strip()
    if explicit:
        return explicit
    names = [str(config.get("api_key_env") or "").strip()]
    names.extend(str(name).strip() for name in config.get("api_key_env_fallbacks") or ())
    provider = str(config.get("provider") or "openai").strip().lower()
    if provider in OPENAI_PROVIDER_ALIASES:
        names.append("OPENAI_API_KEY")
    elif provider:
        names.append(f"{provider.upper().replace('-', '_')}_API_KEY")
    for name in names:
        value = str(os.environ.get(name) or "").strip() if name else ""
        if value:
            return value
    return ""


def _model_metadata(config: Mapping[str, Any]) -> dict[str, Any]:
    context_window = config.get("context_window")
    if isinstance(context_window, int) and context_window > 0:
        return {"model_context_window": context_window}
    return {}


def _optional_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


__all__ = [
    "MODEL_UNAVAILABLE_ERROR",
    "ModelService",
    "SessionModelSpec",
    "SessionModelUnavailableError",
]
