"""User-owned personal model connection profiles.

The packaged ``config.json`` remains the product's built-in-model configuration.
Personal provider credentials are deliberately kept in a separate, owner-only
store so Desktop can manage them without asking a user to edit product config.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Sequence

from scholarseed_runtime.contract.model import ModelWireProtocol
from service.paths import CONFIG_PATH
from service.settings.capabilities import (
    CAPABILITY_HINT_KEY,
    CONTEXT_WINDOW_KEY,
    IMAGE_INPUT_KEY,
    IMAGE_INPUT_REASON_KEY,
    INPUT_MODALITIES_KEY,
    MAX_OUTPUT_TOKENS_KEY,
    MODALITY_KINDS,
    REASONING_EFFORT_LEVELS,
    modality_flags,
    vendor_capability_hint,
)
from service.settings.oauth import OAUTH_PROVIDERS

PROFILE_FILE_NAME = "model_profiles.json"
PROFILE_FILE_MODE = 0o600
ACTIVE_PROFILE_KEY = "active_profile_id"
PROFILES_KEY = "profiles"
PROFILE_ID_PREFIX = "personal-"
OAUTH_PROFILE_ID_PREFIX = f"{PROFILE_ID_PREFIX}oauth-"
PERSONAL_BILLING_MODE = "personal"
SELECTED_MODELS_KEY = "selected_models"
DECLARED_CAPABILITY_INT_KEYS = (CONTEXT_WINDOW_KEY, MAX_OUTPUT_TOKENS_KEY)
ENABLED_KEY = "enabled"
# 模型级「显示状态」。缺省即可见, 只在用户关掉时落盘 —— 既有连接文件不因这次演进产生差异。
MODEL_HIDDEN_KEY = "hidden"
MODEL_DIRECTORY_KEY = "model_directory"
PRESET_ID_KEY = "preset_id"
MODEL_ID_KEY = "id"
MODEL_LABEL_KEY = "label"
AUTHENTICATION_KEY = "authentication"
OAUTH_PROVIDER_KEY = "oauth_provider"
CONNECTION_OWNER_KEY = "owner_id"


class ModelAuthentication(str, Enum):
    API_KEY = "api_key"
    OAUTH = "oauth"


def is_oauth_connection(profile: Mapping[str, Any]) -> bool:
    return profile.get(AUTHENTICATION_KEY) == ModelAuthentication.OAUTH.value


# A personal catalog key is ``<profile_id>:<model_id>``. Splitting on the *first*
# separator is mandatory: a model id may itself contain one (``org/model:version``),
# while a profile id is ``PROFILE_ID_PREFIX`` plus uuid4 hex and never does.
PERSONAL_MODEL_KEY_SEPARATOR = ":"
OPENAI_PROVIDER = "openai"
SUPPORTED_PROVIDERS = frozenset({"anthropic", OPENAI_PROVIDER})
WIRE_API_KEY = "wire_api"
CALL_URL_KEY = "call_url"
CHAT_COMPLETIONS_PATH = "/chat/completions"
DEFAULT_WIRE_API = ModelWireProtocol.RESPONSES.value
SUPPORTED_WIRE_APIS = frozenset(protocol.value for protocol in ModelWireProtocol)
# Keys through which the built-in configuration decides *where a request goes* and
# *which credential it carries*. A personal connection must answer both on its own:
# any one of them left inherited sends the user's own key to the built-in gateway,
# because ``call_url`` outranks ``base_url`` when the session provider is built.
INHERITED_ROUTING_KEYS = (
    CALL_URL_KEY,
    "base_url_env",
    "base_url_env_suffix",
    "api_key_env",
    "api_key_env_fallbacks",
)
HEADER_NAME_PATTERN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
HEADER_LINE_BREAKS = ("\r", "\n")
HEADER_CANONICAL_NAMES = {
    "accept": "Accept",
    "authorization": "Authorization",
    "content-type": "Content-Type",
    "user-agent": "User-Agent",
}
CONNECTION_KEYS = frozenset(
    {
        "provider",
        "base_url",
        "api_key",
        "model_name",
        "small_model_name",
        "image_input",
        "pdf_input",
        "context_window",
        "max_output_tokens",
        "headers",
        "stream_read_timeout_s",
        "llm_max_retries",
        "reasoning_effort",
        WIRE_API_KEY,
    }
)


def profile_store_path(config_path: Path = CONFIG_PATH) -> Path:
    """Return the user-owned profile store adjacent to DamoAgent's global config."""
    return config_path.parent / PROFILE_FILE_NAME


def _empty_document() -> dict[str, Any]:
    return {ACTIVE_PROFILE_KEY: "", PROFILES_KEY: {}}


def _safe_headers(value: Any) -> dict[str, str]:
    """Retain only headers that are safe to pass to an HTTP client."""
    if not isinstance(value, Mapping):
        return {}
    headers: dict[str, str] = {}
    seen_names: set[str] = set()
    for raw_name, raw_value in value.items():
        name = str(raw_name).strip()
        header_value = str(raw_value)
        normalized_name = name.lower()
        if (
            not HEADER_NAME_PATTERN.fullmatch(name)
            or any(line_break in header_value for line_break in HEADER_LINE_BREAKS)
            or normalized_name in seen_names
        ):
            continue
        seen_names.add(normalized_name)
        headers[HEADER_CANONICAL_NAMES.get(normalized_name, name)] = header_value
    return headers


def _profile_preview_name(profile: Mapping[str, Any]) -> str:
    """Read the optional user label, migrating the legacy ``name`` field in memory."""
    model_name = str(profile.get("model_name") or "").strip()
    if "preview_name" in profile:
        return str(profile.get("preview_name") or "").strip()
    legacy_name = str(profile.get("name") or "").strip()
    return legacy_name if legacy_name and legacy_name != model_name else ""


def profile_wire_api(profile: Mapping[str, Any]) -> str:
    """Return the connection's declared provider protocol."""
    wire_api = str(profile.get(WIRE_API_KEY) or "").strip().lower() or DEFAULT_WIRE_API
    return wire_api if wire_api in SUPPORTED_WIRE_APIS else DEFAULT_WIRE_API


def personal_call_url(profile: Mapping[str, Any]) -> str:
    """Derive the request URL a personal connection declares, empty when it is direct.

    Shared by the session overlay and the unsaved-connection probe so both reach the
    exact same endpoint; a probe that resolved its own URL could pass against one host
    while sessions talk to another.
    """
    if profile_wire_api(profile) != ModelWireProtocol.CHAT_COMPLETIONS.value:
        return ""
    base_url = str(profile.get("base_url") or "").strip().rstrip("/")
    return f"{base_url}{CHAT_COMPLETIONS_PATH}" if base_url else ""


def personal_model_key(profile_id: str, model_id: str) -> str:
    """Compose the catalog key identifying one model of one personal connection."""
    return f"{profile_id}{PERSONAL_MODEL_KEY_SEPARATOR}{model_id}"


def parse_personal_model_key(key: str) -> tuple[str, str]:
    """Split a personal catalog key, returning empty parts when it is not one.

    Requiring ``PROFILE_ID_PREFIX`` makes "is this a personal key" answerable without
    reading the store, and splitting once keeps a model id that contains the separator
    intact — truncating it surfaces only as an opaque upstream 404.
    """
    candidate = str(key or "").strip()
    if not candidate.startswith(PROFILE_ID_PREFIX):
        return "", ""
    profile_id, separator, model_id = candidate.partition(PERSONAL_MODEL_KEY_SEPARATOR)
    if not separator or not model_id:
        return "", ""
    return profile_id, model_id


def _declared_positive_int(entry: Mapping[str, Any], key: str, model_id: str) -> int | None:
    """用户声明的整数能力值；非法就报错，不能悄悄丢掉用户的声明。"""

    value = entry.get(key)
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"model {model_id!r}: {key} must be a positive integer")
    return int(value)


def _declared_str_list(
    entry: Mapping[str, Any], key: str, model_id: str, allowed: Sequence[str], label: str
) -> list[str] | None:
    """用户声明的枚举集合（模态 / 思考档位）；越界一律报错而不是过滤掉。

    空集合按「没有声明」返回 ``None``：落盘成 ``[]`` 会让下游多出一种要区分的「没有」。
    """

    value = entry.get(key)
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValueError(f"model {model_id!r}: {key} must be a list")
    items = list(dict.fromkeys(str(item).strip().lower() for item in value if str(item).strip()))
    for item in items:
        if item not in allowed:
            raise ValueError(f"model {model_id!r}: {label} {item!r} is not a supported value")
    return items or None


def _selected_models(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Read the user's checked models, folding a pre-multi-model profile in memory.

    A profile saved before this field existed carries exactly one model in
    ``model_name``; that is the only faithful reading of it as a selection.
    """
    raw = profile.get(SELECTED_MODELS_KEY)
    if not isinstance(raw, (list, tuple)):
        legacy_model_name = str(profile.get("model_name") or "").strip()
        return [{MODEL_ID_KEY: legacy_model_name, MODEL_LABEL_KEY: ""}] if legacy_model_name else []
    models: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for entry in raw:
        if isinstance(entry, Mapping):
            model_id = str(entry.get(MODEL_ID_KEY) or "").strip()
            label = str(entry.get(MODEL_LABEL_KEY) or "").strip()
        else:
            model_id, label = str(entry or "").strip(), ""
        if not model_id or model_id in seen_ids:
            continue
        seen_ids.add(model_id)
        model: dict[str, Any] = {MODEL_ID_KEY: model_id, MODEL_LABEL_KEY: label}
        if isinstance(entry, Mapping):
            _apply_declared_capability(model, entry, model_id)
            # 读取即重建条目, 所以隐藏标记必须在这里显式承接: 漏掉它的话每次 _read 都会把
            # 用户关掉的模型悄悄放回模型菜单。
            if bool(entry.get(MODEL_HIDDEN_KEY)):
                model[MODEL_HIDDEN_KEY] = True
        models.append(model)
    return models


def _apply_declared_capability(
    model: dict[str, Any], entry: Mapping[str, Any], model_id: str
) -> None:
    """把用户对该模型的能力声明写进落盘条目；没声明的字段不落盘（区别于声明为 0）。"""

    efforts = _declared_str_list(
        entry, "reasoning_efforts", model_id, REASONING_EFFORT_LEVELS, "reasoning effort"
    )
    if efforts is not None:
        model["reasoning_efforts"] = efforts
    modalities = _declared_str_list(
        entry, INPUT_MODALITIES_KEY, model_id, MODALITY_KINDS, "input modality"
    )
    if modalities is not None:
        model[INPUT_MODALITIES_KEY] = modalities
    for key in DECLARED_CAPABILITY_INT_KEYS:
        declared = _declared_positive_int(entry, key, model_id)
        if declared is not None:
            model[key] = declared


def _public_models(profile: Mapping[str, Any]) -> list[dict[str, Any]]:
    """对外投影：归一化声明之外附上厂商口径提示。

    提示只存在于 API 响应里，供设置页「按厂商口径填充」和冲突提示用；落盘条目与执行配置
    仍走 ``_selected_models``，不带提示 —— 否则它就变成第二份真值，正是 I3 要防的。
    """

    out: list[dict[str, Any]] = []
    for entry in _selected_models(profile):
        hint = vendor_capability_hint(str(entry.get(MODEL_ID_KEY) or ""))
        out.append({**entry, CAPABILITY_HINT_KEY: hint} if hint else entry)
    return out


def selected_model_ids(profile: Mapping[str, Any]) -> list[str]:
    """Return the model ids one connection offers, in the order the user sees them."""
    return [model[MODEL_ID_KEY] for model in _selected_models(profile)]


def _normalize_document(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return _empty_document()
    profiles = value.get(PROFILES_KEY)
    legacy_active_id = str(value.get(ACTIVE_PROFILE_KEY) or "").strip()
    normalized_profiles: dict[str, dict[str, Any]] = {}
    for profile_id, profile in (profiles.items() if isinstance(profiles, dict) else ()):
        if not isinstance(profile, dict):
            continue
        normalized = {**profile, "id": str(profile_id)}
        normalized["preview_name"] = _profile_preview_name(normalized)
        normalized[WIRE_API_KEY] = profile_wire_api(normalized)
        normalized["headers"] = _safe_headers(normalized.get("headers"))
        normalized[SELECTED_MODELS_KEY] = _selected_models(normalized)
        normalized[PRESET_ID_KEY] = str(normalized.get(PRESET_ID_KEY) or "").strip()
        if ENABLED_KEY in profile:
            normalized[ENABLED_KEY] = bool(profile.get(ENABLED_KEY))
        else:
            # Migrating a single-activation document: only the one connection that was
            # actually in use stays on. Enabling the rest would make the model menu grow
            # entries the user never chose, some backed by credentials long since revoked.
            normalized[ENABLED_KEY] = str(profile_id) == legacy_active_id
        normalized_profiles[str(profile_id)] = normalized
    active_id = legacy_active_id if legacy_active_id in normalized_profiles else ""
    return {ACTIVE_PROFILE_KEY: active_id, PROFILES_KEY: normalized_profiles}


class UnknownProfileError(ValueError):
    """The requested personal connection, or one of its selected models, is not in the store.

    Distinct from a validation error so HTTP callers can answer 404 instead of 422
    without matching on message text.
    """


class ModelProfileStore:
    """Atomic, redaction-aware persistence for personal model connections."""

    def __init__(self, path: Path | None = None, *, shared_ownership: bool = False) -> None:
        self.path = path or profile_store_path()
        # 归属轴 machine 时为真: 连接的**可见性**不再按账号过滤 (本机数据归这台机器)。
        # 只退化谓词, ``owner_id`` 列继续如实记录真实建者, 所以轴改回隔离时原主还在,
        # 全程零不可逆迁移 —— 与会话目录 SessionCatalogStore 同一条范式。
        self._shared_ownership = bool(shared_ownership)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return _empty_document()
        try:
            return _normalize_document(json.loads(self.path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            return _empty_document()

    def _write(self, document: Mapping[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=self.path.parent,
            prefix=f"{self.path.name}.",
            delete=False,
        ) as profile_file:
            profile_file.write(payload)
            staged = Path(profile_file.name)
        try:
            staged.chmod(PROFILE_FILE_MODE)
            os.replace(staged, self.path)
        finally:
            if staged.exists():
                staged.unlink()

    @staticmethod
    def _public(profile: Mapping[str, Any]) -> dict[str, Any]:
        preview_name = _profile_preview_name(profile)
        models = _public_models(profile)
        header_names = sorted(_safe_headers(profile.get("headers")))
        return {
            "id": str(profile.get("id") or ""),
            "name": preview_name or (models[0][MODEL_ID_KEY] if models else ""),
            "preview_name": preview_name,
            PRESET_ID_KEY: str(profile.get(PRESET_ID_KEY) or ""),
            "provider": str(profile.get("provider") or ""),
            "wire_api": profile_wire_api(profile),
            "base_url": str(profile.get("base_url") or ""),
            SELECTED_MODELS_KEY: models,
            ENABLED_KEY: bool(profile.get(ENABLED_KEY)),
            "small_model_name": str(profile.get("small_model_name") or ""),
            "has_api_key": bool(str(profile.get("api_key") or "").strip()),
            "has_headers": bool(header_names),
            "image_input": profile.get("image_input") is True,
            "pdf_input": profile.get("pdf_input") is True,
            "header_names": header_names,
            AUTHENTICATION_KEY: profile.get(AUTHENTICATION_KEY, ModelAuthentication.API_KEY.value),
            OAUTH_PROVIDER_KEY: str(profile.get(OAUTH_PROVIDER_KEY) or ""),
        }

    @staticmethod
    def _validate_headers(
        value: Any, *, existing: Mapping[str, Any] | None = None
    ) -> dict[str, str]:
        """Validate input headers while allowing redacted existing values to remain."""
        existing_headers = _safe_headers(existing)
        if value is None:
            return existing_headers
        if not isinstance(value, Mapping):
            raise ValueError("headers must be a JSON object of header names and values")
        existing_by_lower_name = {
            header_name.lower(): header_value
            for header_name, header_value in existing_headers.items()
        }
        headers: dict[str, str] = {}
        seen_names: set[str] = set()
        for raw_name, raw_value in value.items():
            name = str(raw_name).strip()
            header_value = "" if raw_value is None else str(raw_value)
            normalized_name = name.lower()
            if not HEADER_NAME_PATTERN.fullmatch(name):
                raise ValueError(f"invalid HTTP header name: {name!r}")
            if any(line_break in header_value for line_break in HEADER_LINE_BREAKS):
                raise ValueError(f"header {name!r} must not contain a line break")
            if normalized_name in seen_names:
                raise ValueError(f"duplicate HTTP header name: {name!r}")
            seen_names.add(normalized_name)
            canonical_name = HEADER_CANONICAL_NAMES.get(normalized_name, name)
            if not header_value:
                prior_value = existing_by_lower_name.get(normalized_name)
                if prior_value is None:
                    raise ValueError(f"header {name!r} requires a value")
                headers[canonical_name] = prior_value
            else:
                headers[canonical_name] = header_value
        return headers

    @classmethod
    def _validate(
        cls,
        values: Mapping[str, Any],
        *,
        existing_api_key: Any = None,
        existing_headers: Mapping[str, Any] | None = None,
        headers: Any = None,
    ) -> dict[str, Any]:
        authentication = ModelAuthentication(
            values.get(AUTHENTICATION_KEY, ModelAuthentication.API_KEY.value)
        )
        if authentication == ModelAuthentication.OAUTH:
            provider_id = str(values.get(OAUTH_PROVIDER_KEY) or "")
            policy = OAUTH_PROVIDERS.get(provider_id)
            if policy is None:
                raise ValueError("OAuth provider is unavailable")
            if values.get("api_key") or headers:
                raise ValueError("OAuth connections do not accept API keys or custom headers")
            models = _selected_models(values)
            return {
                AUTHENTICATION_KEY: authentication.value,
                OAUTH_PROVIDER_KEY: provider_id,
                "preview_name": str(values.get("preview_name") or policy.label).strip(),
                PRESET_ID_KEY: provider_id,
                "provider": OPENAI_PROVIDER,
                WIRE_API_KEY: ModelWireProtocol.RESPONSES.value,
                "base_url": policy.responses_endpoint.removesuffix("/responses"),
                SELECTED_MODELS_KEY: models,
                "model_name": models[0][MODEL_ID_KEY] if models else "",
                "small_model_name": "",
                "api_key": "",
                "headers": {},
            }
        provider = str(values.get("provider") or "").strip().lower()
        if provider not in SUPPORTED_PROVIDERS:
            names = ", ".join(sorted(SUPPORTED_PROVIDERS))
            raise ValueError(f"provider must be one of: {names}")
        base_url = str(values.get("base_url") or "").strip()
        if not base_url:
            raise ValueError("base_url is required")
        wire_api = str(values.get(WIRE_API_KEY) or "").strip().lower() or DEFAULT_WIRE_API
        if wire_api not in SUPPORTED_WIRE_APIS:
            names = ", ".join(sorted(SUPPORTED_WIRE_APIS))
            raise ValueError(f"wire_api must be one of: {names}")
        models = _selected_models(values)
        api_key = str(values.get("api_key") or "").strip()
        effective_api_key = api_key or str(existing_api_key or "").strip()
        custom_headers = cls._validate_headers(headers, existing=existing_headers)
        if not effective_api_key and (provider != OPENAI_PROVIDER or not custom_headers):
            raise ValueError(
                "an API key is required unless an OpenAI-compatible endpoint has a custom header"
            )
        preview_name = (
            str(values.get("preview_name") or "").strip()
            if "preview_name" in values
            else str(values.get("name") or "").strip()
        )
        return {
            "preview_name": preview_name,
            PRESET_ID_KEY: str(values.get(PRESET_ID_KEY) or "").strip(),
            "provider": provider,
            WIRE_API_KEY: wire_api,
            "base_url": base_url,
            SELECTED_MODELS_KEY: models,
            # Derived, and kept on disk only so a rollback stays readable: older code
            # reads ``model_name`` and would reject a profile that no longer has one.
            "model_name": models[0][MODEL_ID_KEY] if models else "",
            "small_model_name": str(values.get("small_model_name") or "").strip(),
            "api_key": api_key,
            "headers": custom_headers,
            "image_input": values.get("image_input") is True,
            "pdf_input": values.get("pdf_input") is True,
        }

    def _visible(self, profile: Mapping[str, Any], owner_id: str) -> bool:
        # API key 连接的密钥就在 profile 里、本来就不按账号归属; OAuth 连接才带 owner 戳。
        # 共享归属（machine 轴）下 OAuth 连接同样属于这台机器, 登录/登出/切号都持续可见。
        if self._shared_ownership or not is_oauth_connection(profile):
            return True
        return bool(owner_id and profile.get(CONNECTION_OWNER_KEY) == owner_id)

    def list(self, *, owner_id: str = "") -> dict[str, Any]:
        document = self._read()
        profiles = [
            self._public(profile)
            for profile in document[PROFILES_KEY].values()
            if self._visible(profile, owner_id)
        ]
        profiles.sort(key=lambda profile: (profile["name"].lower(), profile["id"]))
        return {
            "path": str(self.path),
            "profiles": profiles,
            "enabled_profile_ids": [profile["id"] for profile in profiles if profile[ENABLED_KEY]],
        }

    def profile(self, profile_id: str, *, owner_id: str = "") -> dict[str, Any] | None:
        """Return one private profile for runtime construction, never for an API response."""
        profile = self._read()[PROFILES_KEY].get(str(profile_id or "").strip())
        return (
            dict(profile)
            if isinstance(profile, dict) and self._visible(profile, owner_id)
            else None
        )

    def _owner_stamp(self, existing: Any, owner_id: str, user_id: str) -> str:
        """决定落盘的 owner 戳：真实建者优先，共享归属下不改写既有戳。

        戳记的是**真实账号**而不是归属身份：machine 轴下归属身份恒为机器级常量，把它落盘
        会让轴改回隔离后这些连接再也认不回原主（与会话目录 ``principal_id`` 同一条不变量）。
        共享归属下既有戳一律保留，否则同机另一个账号编辑一次就把连接所有权转走了。
        """

        if isinstance(existing, dict):
            recorded = str(existing.get(CONNECTION_OWNER_KEY) or "").strip()
            if recorded and (self._shared_ownership or recorded == owner_id):
                return recorded
        return str(user_id or "").strip() or str(owner_id or "").strip()

    def upsert(
        self,
        values: Mapping[str, Any],
        profile_id: str = "",
        *,
        owner_id: str = "",
        user_id: str = "",
    ) -> dict[str, Any]:
        document = self._read()
        profiles = document[PROFILES_KEY]
        requested_id = str(profile_id or "").strip()
        existing = profiles.get(requested_id)
        if requested_id and (
            not isinstance(existing, dict) or not self._visible(existing, owner_id)
        ):
            raise UnknownProfileError(f"personal API profile {requested_id!r} does not exist")
        normalized = prepare_personal_connection(values, existing=existing)
        if existing is not None and is_oauth_connection(existing) != is_oauth_connection(
            normalized
        ):
            raise ValueError("connection authentication method cannot be changed")
        if is_oauth_connection(normalized):
            stamp = self._owner_stamp(existing, owner_id, user_id)
            if not stamp:
                raise ValueError("OAuth connection requires a product owner")
            if existing is not None and existing.get(OAUTH_PROVIDER_KEY) != normalized.get(
                OAUTH_PROVIDER_KEY
            ):
                raise ValueError("OAuth provider cannot be changed on an existing connection")
            normalized[CONNECTION_OWNER_KEY] = stamp
        prefix = OAUTH_PROFILE_ID_PREFIX if is_oauth_connection(normalized) else PROFILE_ID_PREFIX
        final_id = requested_id or f"{prefix}{uuid.uuid4().hex}"
        # A connection the user just finished configuring is meant to be used; an update
        # must not silently switch a deliberately stopped connection back on.
        enabled = bool(existing.get(ENABLED_KEY)) if isinstance(existing, dict) else True
        profile = {"id": final_id, **normalized, ENABLED_KEY: enabled}
        profiles[final_id] = profile
        self._write(document)
        return self._public(profile)

    def set_enabled(self, profile_id: str, enabled: bool, *, owner_id: str = "") -> dict[str, Any]:
        """Toggle whether one connection's selected models reach the model menu."""
        document = self._read()
        profile = document[PROFILES_KEY].get(profile_id)
        if not isinstance(profile, dict) or not self._visible(profile, owner_id):
            raise UnknownProfileError(f"personal API profile {profile_id!r} does not exist")
        profile[ENABLED_KEY] = bool(enabled)
        self._write(document)
        return self.list(owner_id=owner_id)

    def set_model_hidden(
        self, profile_id: str, model_id: str, hidden: bool, *, owner_id: str = ""
    ) -> dict[str, Any]:
        """Toggle whether one selected model of one connection reaches the model menu."""
        wanted = str(model_id or "").strip()
        document = self._read()
        profile = document[PROFILES_KEY].get(profile_id)
        if not isinstance(profile, dict) or not self._visible(profile, owner_id):
            raise UnknownProfileError(f"personal API profile {profile_id!r} does not exist")
        entry = next(
            (
                model
                for model in profile.get(SELECTED_MODELS_KEY) or ()
                if isinstance(model, dict) and str(model.get(MODEL_ID_KEY) or "") == wanted
            ),
            None,
        )
        if entry is None:
            raise UnknownProfileError(
                f"model {wanted!r} is not selected on personal API profile {profile_id!r}"
            )
        # 只在关闭显示时落盘, 与 _selected_models 的承接方向一致, 保持文件最小差异。
        if bool(hidden):
            entry[MODEL_HIDDEN_KEY] = True
        else:
            entry.pop(MODEL_HIDDEN_KEY, None)
        self._write(document)
        return self.list(owner_id=owner_id)

    def set_directory(
        self, profile_id: str, directory: Mapping[str, Any], *, owner_id: str = ""
    ) -> None:
        """Persist an upstream model-directory snapshot fetched at configuration time.

        读路径（模型目录/厂商列表）不应打上游；上游目录在配置时（登录成功、加载模型、
        保存、显式 refresh）拉取并落到这里，读路径只读快照。
        """

        document = self._read()
        profile = document[PROFILES_KEY].get(profile_id)
        if not isinstance(profile, dict) or not self._visible(profile, owner_id):
            raise UnknownProfileError(f"personal API profile {profile_id!r} does not exist")
        profile[MODEL_DIRECTORY_KEY] = dict(directory)
        self._write(document)

    def delete(self, profile_id: str, *, owner_id: str = "") -> dict[str, Any]:
        document = self._read()
        if profile_id not in document[PROFILES_KEY] or not self._visible(
            document[PROFILES_KEY][profile_id], owner_id
        ):
            raise UnknownProfileError(f"personal API profile {profile_id!r} does not exist")
        del document[PROFILES_KEY][profile_id]
        self._write(document)
        return self.list(owner_id=owner_id)


def resolve_personal_credential(
    values: Mapping[str, Any], existing: Mapping[str, Any] | None = None
) -> tuple[str, dict[str, str]]:
    """Resolve the credential a candidate connection would send.

    Split out from ``prepare_personal_connection`` because asking an endpoint *which
    models it offers* needs the credential but not a chosen ``model_name`` — that field
    is still empty at exactly the moment the user wants candidates. Keeping one
    implementation of "an empty api_key keeps the stored one" stops the two paths from
    drifting apart.
    """
    existing_profile = dict(existing or {})
    api_key = (
        str(values.get("api_key") or "").strip()
        or str(existing_profile.get("api_key") or "").strip()
    )
    incoming_headers = values.get("headers")
    headers = _safe_headers(
        incoming_headers if incoming_headers else existing_profile.get("headers")
    )
    return api_key, headers


def prepare_personal_connection(
    values: Mapping[str, Any], *, existing: Mapping[str, Any] | None = None
) -> dict[str, Any]:
    """Validate a personal connection for saving or a non-persistent API probe."""
    incoming = dict(values)
    if "preview_name" not in incoming and "name" in incoming:
        incoming["preview_name"] = incoming["name"]
    existing_profile = dict(existing or {})
    normalized = ModelProfileStore._validate(
        {**existing_profile, **incoming},
        existing_api_key=existing_profile.get("api_key"),
        existing_headers=existing_profile.get("headers"),
        headers=incoming.get("headers") if "headers" in incoming else None,
    )
    if existing_profile and not normalized["api_key"]:
        normalized["api_key"] = str(existing_profile.get("api_key") or "")
    return normalized


def _apply_model_capability_overlay(resolved: dict[str, Any], entry: Mapping[str, Any]) -> None:
    """Fold one model's own declarations onto the effective config.

    一条连接上的不同模型能力本就不同，所以模型级必须盖过连接级；执行面与目录面读同一份
    声明，界面显示的窗口和真跑起来用的窗口才不会是两件事。
    """

    for key in DECLARED_CAPABILITY_INT_KEYS:
        declared = entry.get(key)
        if declared is not None:
            resolved[key] = declared
    modalities = entry.get(INPUT_MODALITIES_KEY)
    if modalities:
        resolved.update(modality_flags(modalities))
        resolved.pop(IMAGE_INPUT_REASON_KEY, None)


def apply_profile(
    config: Mapping[str, Any],
    profile_id: str,
    store: ModelProfileStore | None = None,
    *,
    model_id: str = "",
) -> dict[str, Any]:
    """Overlay one model of one named personal API onto a built-in config."""
    base = dict(config)
    active = (store or ModelProfileStore()).profile(profile_id)
    if active is None:
        raise UnknownProfileError(f"personal API profile {profile_id!r} does not exist")
    if is_oauth_connection(active):
        # 这道门只叠 API key 连接: 订阅连接的凭据不在 profile 里, 由订阅服务经补全桥兑换。
        # 共享归属下 OAuth profile 对本机所有账号都可见了, 不在这里挡住就会叠出一条指向
        # 订阅端点、却没有任何凭据的路由 —— 表现为"配好了但每次调用都 401"。
        raise UnknownProfileError(f"personal API profile {profile_id!r} is not an API connection")
    offered = selected_model_ids(active)
    requested_model_id = str(model_id or "").strip()
    if requested_model_id not in offered:
        # Falling back to the first selected model would present as "I picked A and it
        # answered as B", which the user has no way to notice.
        raise UnknownProfileError(
            f"model {requested_model_id!r} is not selected on personal API profile {profile_id!r}"
        )
    resolved = {
        **base,
        **{
            key: value
            for key, value in active.items()
            if key in CONNECTION_KEYS and key != "model_name"
        },
        "model_name": requested_model_id,
        "billing_mode": PERSONAL_BILLING_MODE,
        "personal_profile_id": str(active.get("id") or ""),
    }
    # The overlay has to decide the whole route on its own. The built-in config's
    # ``call_url`` points at the product gateway and outranks ``base_url``, so an
    # inherited one would send this user's own credential there; the ``*_env`` keys
    # would likewise redirect resolution to an unrelated environment variable.
    for key in INHERITED_ROUTING_KEYS:
        resolved.pop(key, None)
    resolved[WIRE_API_KEY] = profile_wire_api(active)
    call_url = personal_call_url(resolved)
    if call_url:
        resolved[CALL_URL_KEY] = call_url
    # A personal OpenAI-compatible endpoint does not expose a reliable modality
    # capability through the saved connection schema. Never inherit the previous
    # built-in model's vision flag and accidentally send an attachment.
    if IMAGE_INPUT_KEY not in active:
        resolved[IMAGE_INPUT_KEY] = False
        resolved[IMAGE_INPUT_REASON_KEY] = "personal_model_unverified"
    for entry in _selected_models(active):
        if entry.get(MODEL_ID_KEY) == requested_model_id:
            _apply_model_capability_overlay(resolved, entry)
    return resolved
