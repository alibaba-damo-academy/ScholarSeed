"""Default selectable LLM models for damoagent runtime surfaces."""

from __future__ import annotations

import json
import os
import re
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, cast

from service.paths import CONFIG_PATH
from service.settings.capabilities import (
    BASE_EDITION,
    CAPABILITY_PROVENANCE_USER,
    CONTEXT_EDITION_KEY,
    CONTEXT_WINDOW_KEY,
    GATEWAY_CONNECTION,
    IMAGE_INPUT_KEY,
    IMAGE_INPUT_REASON_KEY,
    LONG_CONTEXT_EDITION,
    MAX_OUTPUT_TOKENS_KEY,
    MODEL_STATUS_DEPRECATED,
    PDF_INPUT_KEY,
    REASONING_EFFORT_LEVELS,
    apply_capability,
    bundled_registry,
)
from service.settings.connections import CHAT_COMPLETIONS_PATH

DEEPRD_GATEWAY_BASE_URL = "https://scholarseed.damo.alibaba.com/v1"
DEEPRD_GATEWAY_CHAT_URL = f"{DEEPRD_GATEWAY_BASE_URL}{CHAT_COMPLETIONS_PATH}"
DEEPRD_GATEWAY_RESPONSES_URL = f"{DEEPRD_GATEWAY_BASE_URL}/responses"
# 内置 lane 的**地址路由键**: 加载态一律清除后由产品常量与目录条目重新派生
# (``call_url`` 优先于 ``base_url``, 只钉 base_url 会被旧 call_url 回显绕过)。
# 凭据键 (``api_key*``) 不在此列 —— 凭据不是连接身份, 归用户所有。
GATEWAY_ROUTE_KEYS = ("call_url", "base_url_env", "base_url_env_suffix")
AVAILABLE_MODEL_KEYS = "available_model_keys"
MODEL_PROBE_MAX_TOKENS = 256
MODEL_PROBE_READ_TIMEOUT_SECONDS = 20
MODEL_PROBE_PROMPT = "Say pong and nothing else."
SELECTED_MODEL_KEY = "selected_model_key"
DEFAULT_GATEWAY_MODEL_KEY = "qwen3.8-flash"
DEFAULT_GATEWAY_MODEL_NAME = "qwen3.8-flash"
LOCAL_LONG_CONTEXT_MARKER = "[1m]"
LONG_CONTEXT_LABEL_SUFFIX = " 1M"
LONG_CONTEXT_KEY_SUFFIX = "-1m"
GATEWAY_ROUTE_STRATEGY = "strategy"
GATEWAY_ROUTE_DIRECT = "direct model"
CONFIG_LANE = "config"
# 既有诊断字面量保持原值，避免连带改不动的用户可见提示；新的未确认标记走 capability_reason。
CONFIG_MODEL_UNVERIFIED_REASON = "configured_model_unverified"
CONTEXT_WINDOW_PROVENANCE_KEY = "context_window_provenance"
MAX_OUTPUT_PROVENANCE_KEY = "max_output_provenance"
MODALITY_PROVENANCE_KEY = "modality_provenance"
INPUT_LABEL_IMAGE = "image"
INPUT_LABEL_TEXT = "text"
# Models removed from every active product catalog remain blocked here.
RETIRED_MODEL_KEYS: frozenset[str] = frozenset()


MODEL_CATALOG: List[Dict[str, Any]] = []

# 内置目录条目只声明「连到哪、调哪个模型」; 上下文长度、模态、思考形态一律来自
# capabilities.json 的 (连接, wire model) 声明 —— 名字不再产出能力真值 (proposal 78 I1)。
GATEWAY_STRATEGY_MODELS = (
    ("qwen3.8-max", "Qwen 3.8 Max"),
    ("qwen3.8-flash", "Qwen 3.8 Flash"),
    ("qwen3-next-80b-a3b-thinking", "Qwen 3 Next 80B A3B Thinking"),
)
GATEWAY_DIRECT_MODELS = cast(tuple[tuple[str, str], ...], ())
GATEWAY_APPROVAL_MODEL_KEY = "auto_review_model"
GATEWAY_QWEN_APPROVAL_MODEL = "qwen3-next-80b-a3b-thinking"
GATEWAY_QWEN_MODEL_KEYS = frozenset(
    {
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3-next-80b-a3b-thinking",
    }
)
GATEWAY_APPROVAL_MODELS = {name: GATEWAY_QWEN_APPROVAL_MODEL for name in GATEWAY_QWEN_MODEL_KEYS}
# 内置目录仅保留两种主模型与独立审批模型；选择器只展示前两者。旧内置配置在加载态
# 收敛到可见默认模型，不修改用户文件，也不改变个人连接。
# 单一事实源: 产品可见性只在这里声明, 服务层不再维护第二张常量表。空集合 = 不收敛。
GATEWAY_VISIBLE_MODEL_KEYS: frozenset[str] = frozenset({"qwen3.8-max", "qwen3.8-flash"})
# 连接**身份**字段说明「连到哪、用什么协议、调哪个模型」; 连接**凭据**字段只说明「这条
# 连接怎么鉴权」。判定内置目录时两组必须分开: 把凭据也算进连接声明, 会让用户一填
# api_key 或一个自定义 header 就把内置模型目录整体抹空 —— 症状是模型菜单一个都不剩。
CONNECTION_IDENTITY_KEYS = (
    "provider",
    "base_url",
    "model_name",
    "call_url",
)
CONNECTION_CREDENTIAL_KEYS = (
    "api_key",
    "headers",
)
CONNECTION_DECLARATION_KEYS = CONNECTION_IDENTITY_KEYS + CONNECTION_CREDENTIAL_KEYS
# config.json 顶层**连接字段退役**: 连接身份与凭据的唯一入口是设置页「模型服务配置」
# (profile store, 经 ``apply_profile`` 唯一门生效)。加载态对用户文件里的这些键一律
# 忽略 —— 内置 lane 的地址由产品常量钉死, 凭据走账号令牌 / 环境变量; BYOK 与自托管
# 走个人连接。``model_name`` / ``small_model_name`` 是模型选择不是连接, 保留。
RETIRED_CONNECTION_KEYS: tuple[str, ...] = (
    *(key for key in CONNECTION_DECLARATION_KEYS if key != "model_name"),
    "base_url_env",
    "base_url_env_suffix",
    "api_key_env",
    "api_key_env_fallbacks",
    "backup_api_keys",
    "small_model_provider",
    "small_model_base_url",
    "small_model_call_url",
)
# 内置网关目录策略。显式声明优先于任何推断, 供自建 / 自托管的网关副本声明「用内置目录」。
# **不写进 settings/default.json**: 种子字段被用户文件继承后无法与用户自己的声明区分,
# 会把指向自建端点的 base_url 又拽回内置网关 (proposal 51 §9 列为最高优先级风险)。
MODEL_CATALOG_POLICY_KEY = "model_catalog"
CATALOG_POLICY_GATEWAY = "scholarseed_gateway"
CATALOG_POLICY_EXTERNAL = "external"
CATALOG_POLICIES = (CATALOG_POLICY_GATEWAY, CATALOG_POLICY_EXTERNAL)
# 内置网关是 OpenAI 兼容端点: provider 未声明时按它补齐不算「换了一条连接」。
GATEWAY_CATALOG_PROVIDER = "openai"


def wire_model_name(model_name: str) -> str:
    """Return the provider-facing model id without local catalog markers."""

    return _wire_model_id(model_name)


def _wire_model_id(model_name: str) -> str:
    return str(model_name or "").strip().lower().replace(LOCAL_LONG_CONTEXT_MARKER, "")


def _gateway_window(name: str, edition: str) -> Optional[int]:
    """该 wire id 在网关这条路由版本上声明的窗口；未声明就是 ``None``，不兜大值。"""

    capability = bundled_registry().lookup(name, GATEWAY_CONNECTION)
    if edition == LONG_CONTEXT_EDITION:
        return capability.long_context
    return capability.limits.get("context")


def _gateway_edition(name: str, edition: str) -> tuple[str, Optional[int]]:
    """Identity used to prefer a strategy without collapsing real context editions."""

    capability = _wire_model_id(name).rsplit("/", 1)[-1]
    return capability, _gateway_window(name, edition)


def _gateway_model_item(
    spec: tuple[str, str],
    *,
    route_kind: str,
    edition: str = BASE_EDITION,
    aliases: Iterable[str] = (),
    key: str = "",
    label: str = "",
    model_name: str = "",
) -> Dict[str, Any]:
    name, default_label = spec
    item = {
        "key": key or name,
        "label": label or default_label,
        "provider": "openai",  # wire protocol identity; presentation uses provider_label
        "provider_label": "阿里云百炼",
        "provider_preset_id": "dashscope",
        "base_url": DEEPRD_GATEWAY_BASE_URL,
        "model_name": model_name or name,
        "small_model_name": name,
        "call_url": DEEPRD_GATEWAY_RESPONSES_URL,
        "route_kind": route_kind,
        "aliases": list(aliases),
        "description": f"DeepRD gateway {route_kind}: {name}.",
    }
    if name in GATEWAY_APPROVAL_MODELS:
        item[GATEWAY_APPROVAL_MODEL_KEY] = GATEWAY_APPROVAL_MODELS[name]
    return apply_capability(
        item,
        bundled_registry().lookup(name, GATEWAY_CONNECTION),
        lane=GATEWAY_CONNECTION,
        edition=edition,
    )


def _gateway_long_context_item(
    spec: tuple[str, str], *, route_kind: str, aliases: Iterable[str] = ()
) -> Dict[str, Any]:
    name, label = spec
    return _gateway_model_item(
        spec,
        route_kind=route_kind,
        edition=LONG_CONTEXT_EDITION,
        aliases=aliases,
        key=f"{name}{LONG_CONTEXT_KEY_SUFFIX}",
        label=f"{label}{LONG_CONTEXT_LABEL_SUFFIX}",
        model_name=f"{name}{LOCAL_LONG_CONTEXT_MARKER}",
    )


def _gateway_has_long_edition(name: str) -> bool:
    return _gateway_window(name, LONG_CONTEXT_EDITION) is not None


_GATEWAY_STRATEGY_EDITIONS = {
    _gateway_edition(name, edition)
    for name, _label in GATEWAY_STRATEGY_MODELS
    for edition in (BASE_EDITION, LONG_CONTEXT_EDITION)
}
GATEWAY_MODEL_CATALOG: List[Dict[str, Any]] = []
for strategy_name, strategy_label in GATEWAY_STRATEGY_MODELS:
    strategy_spec = (strategy_name, strategy_label)
    strategy_edition = _gateway_edition(strategy_name, BASE_EDITION)
    covered_direct_models = [
        direct_name
        for direct_name, _direct_label in GATEWAY_DIRECT_MODELS
        if _gateway_edition(direct_name, BASE_EDITION) == strategy_edition
    ]
    GATEWAY_MODEL_CATALOG.append(
        _gateway_model_item(
            strategy_spec,
            route_kind=GATEWAY_ROUTE_STRATEGY,
            aliases=covered_direct_models,
        )
    )
    if _gateway_has_long_edition(strategy_name):
        GATEWAY_MODEL_CATALOG.append(
            _gateway_long_context_item(
                strategy_spec,
                route_kind=GATEWAY_ROUTE_STRATEGY,
                aliases=(
                    f"{direct_model}{LOCAL_LONG_CONTEXT_MARKER}"
                    for direct_model in covered_direct_models
                ),
            )
        )
GATEWAY_MODEL_CATALOG.extend(
    _gateway_model_item(direct_spec, route_kind=GATEWAY_ROUTE_DIRECT)
    for direct_spec in GATEWAY_DIRECT_MODELS
    if _gateway_edition(direct_spec[0], BASE_EDITION) not in _GATEWAY_STRATEGY_EDITIONS
)
GATEWAY_MODEL_CATALOG.extend(
    _gateway_long_context_item(direct_spec, route_kind=GATEWAY_ROUTE_DIRECT)
    for direct_spec in GATEWAY_DIRECT_MODELS
    if _gateway_has_long_edition(direct_spec[0])
    and _gateway_edition(direct_spec[0], LONG_CONTEXT_EDITION) not in _GATEWAY_STRATEGY_EDITIONS
)


def declares_external_connection(config: Optional[Mapping[str, Any]]) -> bool:
    """用户是否显式声明了内置网关之外的另一条连接。

    只看连接**身份**字段。凭据 (``api_key`` / ``headers``) 说明这条连接怎么鉴权, 不说明
    连到哪 —— 用户给自己的内置网关配置补一把 key, 不等于换了一条连接。
    """

    if not config:
        return False
    base_url = _norm_base_url(str(config.get("base_url") or ""))
    if base_url:
        return not base_url.startswith(_norm_base_url(DEEPRD_GATEWAY_BASE_URL))
    provider = str(config.get("provider") or "").strip().lower()
    return bool(provider) and provider != GATEWAY_CATALOG_PROVIDER


def pin_builtin_gateway_route(config: Dict[str, Any]) -> Dict[str, Any]:
    """内置 lane 的执行地址恒取产品常量; 配置文件里的地址回显不参与路由。

    出厂种子与 ``npm run config`` 会把网关地址写进用户 config.json, 而 ``call_url`` 优先于
    ``base_url`` —— 产品切换网关地址后, 这些回显会把存量机器永远钉在旧地址上。这里在
    加载态把内置 lane 的地址路由键清掉、``base_url`` 钉成常量, 与
    ``converge_gateway_model_config`` 同一「不写盘」契约: 常量一改, 存量机器立即跟随。

    外部连接 (BYOK / 自托管) 原样返回 —— 那条连接的地址归用户所有。凭据键不动。
    """

    cfg = dict(config or {})
    if declares_external_connection(cfg):
        return cfg
    for key in GATEWAY_ROUTE_KEYS:
        cfg.pop(key, None)
    cfg["base_url"] = DEEPRD_GATEWAY_BASE_URL
    return cfg


def _is_deeprd_gateway(config: Optional[Dict[str, Any]]) -> bool:
    """内置网关目录是否适用于这份配置。"""

    if config is None:
        return False
    policy = str(config.get(MODEL_CATALOG_POLICY_KEY) or "").strip().lower()
    if policy == CATALOG_POLICY_GATEWAY:
        return True
    if policy == CATALOG_POLICY_EXTERNAL:
        return False
    # 一个连接字段都没写过的配置不是「内置网关配置」, 而是什么都没配 —— 保持缺失,
    # 不要把它变成一条产品声明。
    if not any(key in config for key in CONNECTION_DECLARATION_KEYS):
        return False
    return not declares_external_connection(config)


_SECRET_FIELDS = {
    "api_key",
    "backup_api_keys",
    "headers",
    "request_headers",
    "llm_request_headers",
    # 头值可能是凭据; 名单/env 映射本身不是密钥, 但同属一组不对外透的连接细节。
    "llm_request_header_envs",
}
_EXTERNAL_CATALOG_FILES = ("model_catalog.json", "llm_models.json")


def invalidate_codex_auth_cache() -> None:
    """Request a fresh catalog read after Codex authentication changes.

    The external Codex App Server owns authentication.  The surface catalog keeps
    no credential cache, so this stable product hook is intentionally a no-op.
    """

    return None


def _public_model(item: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: deepcopy(v) for k, v in item.items() if k not in _SECRET_FIELDS}
    out.setdefault("label", out.get("key") or out.get("model_name") or "Configured model")
    out.setdefault("source", "builtin")
    out.setdefault("billing", "api")
    # Subscription readiness belongs to the selected external runtime adapter.
    # This catalog stays runtime-neutral and never imports a self-developed work registry.
    return out


def _norm_base_url(url: str) -> str:
    return str(url or "").rstrip("/")


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")
    return s or "configured-model"


def _declared_int(raw: Mapping[str, Any], key: str) -> Optional[int]:
    """用户在这条配置里显式声明的整数值；没声明就是 ``None``，不去查表也不兜底。"""

    value = raw.get(key)
    if value is None or value == "":
        return None
    return int(value)


def _apply_declared_overrides(item: Dict[str, Any], raw: Mapping[str, Any]) -> None:
    """用户声明压在注册表之上；未声明的字段保持注册表给的未确认态而不是被编出来。"""

    declared = {
        CONTEXT_WINDOW_KEY: _declared_int(raw, CONTEXT_WINDOW_KEY),
        MAX_OUTPUT_TOKENS_KEY: _declared_int(raw, MAX_OUTPUT_TOKENS_KEY),
    }
    for key, value in declared.items():
        if value is not None:
            item[key] = value
            item[
                (
                    CONTEXT_WINDOW_PROVENANCE_KEY
                    if key == CONTEXT_WINDOW_KEY
                    else MAX_OUTPUT_PROVENANCE_KEY
                )
            ] = CAPABILITY_PROVENANCE_USER
    for flag in (IMAGE_INPUT_KEY, PDF_INPUT_KEY):
        if flag in raw:
            item[flag] = bool(raw.get(flag))
            item[MODALITY_PROVENANCE_KEY] = CAPABILITY_PROVENANCE_USER


def _coerce_config_choice(raw: Dict[str, Any], *, key_hint: str = "") -> Optional[Dict[str, Any]]:
    model_name = str(raw.get("model_name") or raw.get("model") or "").strip()
    provider = str(raw.get("provider") or "").strip().lower()
    base_url = str(raw.get("base_url") or "").strip()
    if not model_name or not provider:
        return None
    context_window = _declared_int(raw, CONTEXT_WINDOW_KEY)
    key = str(raw.get("key") or key_hint or f"configured-{_slug(model_name)}").strip()
    lane = GATEWAY_CONNECTION if _is_deeprd_gateway(raw) else ""
    item: Dict[str, Any] = {
        "key": key,
        "label": str(raw.get("label") or raw.get("display") or model_name),
        "provider": provider,
        "base_url": base_url,
        "model_name": model_name,
        "small_model_name": raw.get("small_model_name") or raw.get("small_model") or model_name,
        "description": str(raw.get("description") or "Model from local .damoagent config."),
        "source": str(raw.get("source") or "config"),
    }
    item = apply_capability(
        item,
        bundled_registry().lookup(_wire_model_id(model_name), lane),
        lane=lane or CONFIG_LANE,
        edition=(
            LONG_CONTEXT_EDITION
            if LOCAL_LONG_CONTEXT_MARKER in model_name.lower()
            else BASE_EDITION
        ),
    )
    item[IMAGE_INPUT_REASON_KEY] = str(
        raw.get(IMAGE_INPUT_REASON_KEY)
        or ("" if IMAGE_INPUT_KEY in raw else CONFIG_MODEL_UNVERIFIED_REASON)
    )
    _apply_declared_overrides(item, raw)
    if context_window is not None:
        item[CONTEXT_WINDOW_PROVENANCE_KEY] = CAPABILITY_PROVENANCE_USER
    if raw.get("call_url"):
        item["call_url"] = raw["call_url"]
    if raw.get("base_url_env"):
        item["base_url_env"] = str(raw["base_url_env"])
    if raw.get("base_url_env_suffix"):
        item["base_url_env_suffix"] = str(raw["base_url_env_suffix"])
    if raw.get("max_output_tokens") is not None:
        item["max_output_tokens"] = raw.get("max_output_tokens")
    for name in ("small_model_provider", "small_model_base_url", "small_model_call_url"):
        if raw.get(name):
            item[name] = str(raw[name])
    if raw.get("reasoning_effort"):
        item["reasoning_effort"] = str(raw["reasoning_effort"]).strip().lower()
    if "reasoning_efforts" in raw:
        item["reasoning_efforts"] = list(raw.get("reasoning_efforts") or [])
    if raw.get("headers") is not None:
        item["headers"] = deepcopy(raw.get("headers") or {})
    if raw.get("api_key_env"):
        item["api_key_env"] = str(raw["api_key_env"])
    if raw.get("api_key_env_fallbacks"):
        item["api_key_env_fallbacks"] = [
            str(name) for name in raw.get("api_key_env_fallbacks") or [] if str(name).strip()
        ]
    if raw.get("api_key"):
        item["api_key"] = str(raw["api_key"])
    return item


def _catalog_connections(item: Dict[str, Any]) -> set[tuple[str, str, str, int]]:
    """Connection identities, preserving independently selectable context editions."""
    model_names = [str(item.get("model_name") or "")]
    model_names.extend(str(alias) for alias in item.get("aliases") or [])
    context_window = int(item.get("context_window") or 0)
    provider = str(item.get("provider") or "")
    base_url = _norm_base_url(str(item.get("base_url") or ""))
    return {
        (
            provider,
            base_url,
            _wire_model_id(model_name),
            context_window,
        )
        for model_name in model_names
        if model_name
    }


def _catalog_connection(item: Dict[str, Any]) -> tuple[str, str, str, int]:
    """Primary connection identity for a config-defined model."""
    return (
        str(item.get("provider") or ""),
        _norm_base_url(str(item.get("base_url") or "")),
        _wire_model_id(str(item.get("model_name") or "")),
        int(item.get("context_window") or 0),
    )


def _is_retired_model(item: Dict[str, Any]) -> bool:
    """Whether a catalog/config item identifies a model removed from DamoAgent."""
    key = str(item.get("key") or "").strip().lower()
    model_name = (
        str(item.get("model_name") or "").strip().lower().replace(LOCAL_LONG_CONTEXT_MARKER, "")
    )
    return (
        key in RETIRED_MODEL_KEYS
        or model_name in RETIRED_MODEL_KEYS
        or str(item.get("capability_status") or "") == MODEL_STATUS_DEPRECATED
    )


def _config_model_choices(config: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    cfg = config or {}
    out: List[Dict[str, Any]] = []

    # The synthetic "current config" choice exists so a config-only model stays selectable.
    # Skip it when the active model IS already a curated catalog entry (same connection):
    # otherwise the picker shows the same model twice — raw "glm-5.2" (config, label=model_name)
    # AND "GLM 5.2" (catalog, curated label) — both marked current. The catalog entry already
    # represents it with the nicer label, and current_model_key() resolves the ✓ onto it.
    source_catalog = GATEWAY_MODEL_CATALOG if _is_deeprd_gateway(config) else MODEL_CATALOG
    catalog_conns = {
        connection for model in source_catalog for connection in _catalog_connections(model)
    }
    current = _coerce_config_choice({**cfg, "source": "current_config"}, key_hint="current-config")
    if (
        current is not None
        and not _is_retired_model(current)
        and _catalog_connection(current) not in catalog_conns
    ):
        current["label"] = str(current.get("label") or current["model_name"])
        current["description"] = "Current model configured in .damoagent/config.json."
        out.append(current)

    for section in ("model_catalog", "llm_models"):
        raw_section = cfg.get(section)
        items: Iterable[Any]
        if isinstance(raw_section, dict):
            items = (
                {**v, "key": v.get("key") or k}
                for k, v in raw_section.items()
                if isinstance(v, dict)
            )
        elif isinstance(raw_section, list):
            items = (v for v in raw_section if isinstance(v, dict))
        else:
            items = ()
        for raw in items:
            item = _coerce_config_choice(raw)
            if item is not None and not _is_retired_model(item):
                out.append(item)

    # ``models`` is primarily metadata override config. Treat an entry as a
    # switchable connection only when it explicitly carries connection fields.
    models_cfg = cfg.get("models") or {}
    if isinstance(models_cfg, dict):
        for key, raw in models_cfg.items():
            if not isinstance(raw, dict):
                continue
            if "provider" not in raw and "base_url" not in raw and "model_name" not in raw:
                continue
            item = _coerce_config_choice({**raw, "key": raw.get("key") or key})
            if item is not None and not _is_retired_model(item):
                out.append(item)

    seen = set()
    deduped: List[Dict[str, Any]] = []
    for item in [*out, *_external_catalog_choices()]:
        if _is_retired_model(item):
            continue
        ident = (
            str(item.get("key")),
            str(item.get("provider")),
            _norm_base_url(str(item.get("base_url") or "")),
            str(item.get("model_name") or ""),
        )
        if ident in seen:
            continue
        seen.add(ident)
        deduped.append(item)
    return deduped


def _external_catalog_choices() -> List[Dict[str, Any]]:
    """Read optional user-maintained model catalogs under ``~/.damoagent``.

    Supported shapes:
      - a list of model objects;
      - a mapping of key -> model object;
      - an object containing ``model_catalog`` or ``llm_models`` with either of
        the above shapes.
    """
    out: List[Dict[str, Any]] = []
    for name in _EXTERNAL_CATALOG_FILES:
        path = CONFIG_PATH.parent / name
        if not path.exists():
            continue
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.extend(_catalog_items_from_raw(raw, source=f"file:{name}"))
    return out


def _catalog_items_from_raw(raw: Any, *, source: str) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, dict) and any(k in raw for k in ("model_catalog", "llm_models", "models")):
        items = []
        for section in ("model_catalog", "llm_models", "models"):
            items.extend(_catalog_items_from_raw(raw.get(section), source=source))
        return items
    elif isinstance(raw, dict):
        items = [{**v, "key": v.get("key") or k} for k, v in raw.items() if isinstance(v, dict)]
    else:
        items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        choice = _coerce_config_choice({**item, "source": item.get("source") or source})
        if choice is not None:
            out.append(choice)
    return out


def _selectable_api_models(
    models: List[Dict[str, Any]], allowed_keys: Iterable[str]
) -> List[Dict[str, Any]]:
    """Narrow the API models to ``allowed_keys``; subscription models never gate.

    订阅模型走自己的端点、与内置 API 名单无关, 任何收窄都必须放行它们 —— 否则
    选择器会整体空掉。
    """
    allowed = {str(key) for key in allowed_keys if str(key)}
    return [
        item
        for item in models
        if item.get("billing") == "subscription" or str(item.get("key") or "") in allowed
    ]


def available_models(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Public catalog shape safe to send to UIs.

    The static catalog is augmented with the current local config and optional
    config-defined connection presets, so a valid custom ``.damoagent/config.json``
    model is not invisible in WebUI/OpenTUI selectors.
    """
    source_catalog = GATEWAY_MODEL_CATALOG if _is_deeprd_gateway(config) else MODEL_CATALOG
    catalog = [dict(m) for m in source_catalog]
    custom = _config_model_choices(config)
    out: List[Dict[str, Any]] = []
    seen_keys = set()
    for item in [*custom, *catalog]:
        key = str(item.get("key") or "")
        if key in seen_keys:
            continue
        seen_keys.add(key)
        out.append(_public_model(item))
    if GATEWAY_VISIBLE_MODEL_KEYS and _is_deeprd_gateway(config):
        out = _selectable_api_models(out, GATEWAY_VISIBLE_MODEL_KEYS)
    verified = (config or {}).get(AVAILABLE_MODEL_KEYS)
    if isinstance(verified, list):
        out = _selectable_api_models(out, verified)
    return out


def public_model_choice(choice: Dict[str, Any]) -> Dict[str, Any]:
    """Return a UI-safe model choice without connection secrets."""
    return _public_model(choice)


def subscription_groups(models: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """订阅模型的二级分组元数据, 供 UI 直接渲染。

    分组名与顺序的**单一来源是 catalog 条目自己**(`provider` + `provider_label`),
    不在后端或前端再维护一张 provider → 标题的常量表 —— 否则每新增一家订阅
    通路都要回来改两处。顺序取 catalog 里首次出现的顺序 (MODEL_CATALOG 是有序列表),
    比字典序稳定, 也不需要单独维护一张顺序表。

    `provider_label` 按 provider 重复写在每条模型上 (反范式化), 好处是外部贡献的
    catalog 条目自带分组信息、不依赖主干登记; 一致性由契约测试卡。label 缺失时
    回退到 provider 名，不隐藏分组。
    """
    groups: List[Dict[str, str]] = []
    seen: set[str] = set()
    for item in models:
        if item.get("billing") != "subscription":
            continue
        provider = str(item.get("provider") or "").strip()
        if not provider or provider in seen:
            continue
        seen.add(provider)
        groups.append(
            {
                "provider": provider,
                "label": str(item.get("provider_label") or "").strip() or provider,
            }
        )
    return groups


def _model_aliases(item: Dict[str, Any]) -> Iterable[str]:
    yield str(item.get("key") or "")
    yield str(item.get("model_name") or "")
    yield str(item.get("model_name") or "").replace(LOCAL_LONG_CONTEXT_MARKER, "")
    yield str(item.get("label") or "").lower().replace(" ", "-")
    yield from (str(alias) for alias in item.get("aliases") or [])


def _matches_model_alias(item: Dict[str, Any], model_name: str) -> bool:
    requested_long_context = LOCAL_LONG_CONTEXT_MARKER in str(model_name or "").lower()
    item_is_long_context = (
        str(item.get(CONTEXT_EDITION_KEY) or BASE_EDITION) == LONG_CONTEXT_EDITION
    )
    if requested_long_context != item_is_long_context:
        return False
    wanted = _wire_model_id(model_name)
    return wanted in {_wire_model_id(alias) for alias in _model_aliases(item) if alias}


def _all_model_choices(config: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    source_catalog = GATEWAY_MODEL_CATALOG if _is_deeprd_gateway(config) else MODEL_CATALOG
    choices = [
        *_config_model_choices(config),
        *[dict(m) for m in source_catalog],
    ]
    return choices


def resolve_model_choice(name: str, config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    q = (name or "").strip()
    if not q:
        raise ValueError("missing model. Usage: /model <model-key>")
    q_norm = q.lower()
    choices = _all_model_choices(config)
    for item in choices:
        if q_norm == str(item.get("key") or "").lower():
            return deepcopy(item)
    for item in choices:
        if q_norm in {a.lower() for a in _model_aliases(item) if a}:
            return deepcopy(item)
    valid = ", ".join(m["key"] for m in available_models(config))
    raise ValueError(f"unknown model {q!r}; available: {valid}")


def current_model_key(config: Dict[str, Any]) -> str:
    model = str((config or {}).get("model_name") or "")
    provider = str((config or {}).get("provider") or "")
    base = _norm_base_url(str((config or {}).get("base_url") or ""))
    if _is_retired_model(
        {
            "key": str((config or {}).get(SELECTED_MODEL_KEY) or ""),
            "model_name": model,
        }
    ):
        return ""
    choices = [
        *[
            dict(m)
            for m in (GATEWAY_MODEL_CATALOG if _is_deeprd_gateway(config) else MODEL_CATALOG)
        ],
        *_config_model_choices(config),
    ]
    selected_key = str((config or {}).get(SELECTED_MODEL_KEY) or "").strip()
    if selected_key:
        for item in choices:
            if (
                selected_key == item["key"]
                and model == item["model_name"]
                and provider == item["provider"]
                and base == _norm_base_url(str(item.get("base_url") or ""))
            ):
                return selected_key
        # selected_model_key is set but didn't match any catalog entry exactly.
        # If the key itself doesn't exist in ANY available choice, the selection is
        # stale (e.g. subscription provider uninstalled) — return empty so the UI
        # shows "—" and waits for manual re-selection.
        if not any(selected_key == str(item.get("key") or "") for item in choices):
            return ""
    # Preserve an explicitly selected context edition before considering
    # marker-stripped or provider-prefixed compatibility aliases.
    for item in choices:
        if (
            model == item["model_name"]
            and provider == item["provider"]
            and base == _norm_base_url(str(item.get("base_url") or ""))
        ):
            return item["key"]
    for item in choices:
        if model == item["model_name"] and provider == item["provider"]:
            return item["key"]
    for item in choices:
        if (
            _matches_model_alias(item, model)
            and provider == item["provider"]
            and base == _norm_base_url(str(item.get("base_url") or ""))
        ):
            return item["key"]
    for item in choices:
        if _matches_model_alias(item, model) and provider == item["provider"]:
            return item["key"]
    return model


def image_input_for_config(config: Dict[str, Any]) -> bool:
    """Resolve image-input support from an explicit declaration; never from the name."""

    cfg = config or {}
    if IMAGE_INPUT_KEY in cfg:
        return bool(cfg.get(IMAGE_INPUT_KEY))
    model = str(cfg.get("model_name") or "")
    key = current_model_key(cfg)
    for item in _all_model_choices(cfg):
        if item.get("key") == key:
            return bool(item.get(IMAGE_INPUT_KEY, False))
    if model:
        try:
            return bool(resolve_model_choice(model, cfg).get(IMAGE_INPUT_KEY, False))
        except Exception:
            return False
    return False


def apply_model_to_config(config: Dict[str, Any], choice: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(config or {})
    selected_key = str(choice.get("key") or "").strip()
    if selected_key:
        out[SELECTED_MODEL_KEY] = selected_key
    else:
        out.pop(SELECTED_MODEL_KEY, None)
    old_provider = str(out.get("provider") or "").strip().lower()
    old_base = _norm_base_url(str(out.get("base_url") or ""))
    new_provider = str(choice.get("provider") or old_provider).strip().lower()
    new_base = _norm_base_url(str(choice.get("base_url") or old_base))
    # 只有**已声明**的旧值真的变了才算换连接。把未声明的 provider / base_url 按目录补齐
    # 是同一条连接内的收敛, 不是换连接 —— 曾据此 pop 掉用户自配的 api_key, 于是自建 /
    # 自托管网关的用户明明配了 key, 内置模型仍被判成「无凭据」而不可用。凭据只在真的
    # 换了端点或协议时才必须丢弃, 否则会把上一家的 key 发给下一家。
    connection_changed = bool(new_provider or new_base) and (
        bool(old_provider and old_provider != new_provider)
        or bool(old_base and old_base != new_base)
    )
    for field in (
        "provider",
        "base_url",
        "model_name",
        "small_model_name",
        "image_input",
        "context_window",
        "max_output_tokens",
        "call_url",
        "pricing",
        "small_model_provider",
        "small_model_base_url",
        "small_model_call_url",
    ):
        if field in choice:
            out[field] = choice[field]
    model_name = str(choice.get("model_name") or "").strip()
    if model_name and choice.get("context_window") is not None:
        model_overrides = dict(out.get("models") or {})
        model_override = dict(model_overrides.get(model_name) or {})
        model_override["context_window"] = int(choice["context_window"])
        if choice.get("max_output_tokens") is not None:
            model_override["max_output_tokens"] = int(choice["max_output_tokens"])
        model_overrides[model_name] = model_override
        out["models"] = model_overrides
    if "base_url_env" in choice:
        out["base_url_env"] = choice["base_url_env"]
    else:
        out.pop("base_url_env", None)
    if "base_url_env_suffix" in choice:
        out["base_url_env_suffix"] = choice["base_url_env_suffix"]
    else:
        out.pop("base_url_env_suffix", None)
    if "api_key" in choice:
        out["api_key"] = choice["api_key"]
        if "api_key_env" in choice:
            out["api_key_env"] = choice["api_key_env"]
        elif connection_changed:
            out.pop("api_key_env", None)
    elif "api_key_env" in choice:
        out["api_key_env"] = choice["api_key_env"]
        if connection_changed:
            out.pop("api_key", None)
    elif connection_changed:
        out.pop("api_key", None)
        out.pop("api_key_env", None)
        out.pop("backup_api_keys", None)
    if "api_key_env_fallbacks" in choice:
        out["api_key_env_fallbacks"] = list(choice["api_key_env_fallbacks"])
    else:
        out.pop("api_key_env_fallbacks", None)
    if choice.get("reasoning_effort"):
        out["reasoning_effort"] = str(choice["reasoning_effort"]).strip().lower()
    else:
        out.pop("reasoning_effort", None)
    if "headers" in choice:
        out["headers"] = deepcopy(choice.get("headers") or {})
    out.setdefault("headers", {})
    return out


def _pricing_summary(pricing: Any) -> str:
    if not isinstance(pricing, dict) or not pricing:
        return "price=unknown"

    def fmt(value: Any) -> str:
        try:
            return f"{float(value):g}"
        except (TypeError, ValueError):
            return str(value)

    tiers = pricing.get("tiers")
    unit = str(pricing.get("unit") or "1M tokens")
    if isinstance(tiers, list) and tiers:
        parts = []
        for tier in tiers:
            if not isinstance(tier, dict):
                continue
            currency = str(tier.get("currency") or pricing.get("currency") or "").strip()
            input_price = tier.get("input")
            output_price = tier.get("output")
            condition = str(tier.get("condition") or "").strip()
            if currency and input_price is not None and output_price is not None:
                suffix = f" {condition}" if condition else ""
                parts.append(f"{currency} {fmt(input_price)}/{fmt(output_price)}{suffix}")
        if parts:
            return f"price={'; '.join(parts)}/{unit}"
    currency = str(pricing.get("currency") or "").strip()
    input_price = pricing.get("input")
    output_price = pricing.get("output")
    if currency and input_price is not None and output_price is not None:
        extra = []
        if pricing.get("condition") is not None:
            extra.append(str(pricing["condition"]))
        if pricing.get("cache_read") is not None:
            extra.append(f"cache_read={fmt(pricing['cache_read'])}")
        if pricing.get("cache_write") is not None:
            extra.append(f"cache_write={fmt(pricing['cache_write'])}")
        if pricing.get("thought") is not None:
            extra.append(f"thought={fmt(pricing['thought'])}")
        tail = f" ({', '.join(extra)})" if extra else ""
        return f"price={currency} {fmt(input_price)}/{fmt(output_price)}/{unit}{tail}"
    return "price=unknown"


def model_choice_title(item: Dict[str, Any], *, current_key: str = "") -> str:
    """Compact label for terminal/UI selectors."""
    key = str(item.get("key") or item.get("model_name") or "model")
    label = str(item.get("label") or key)
    provider = str(item.get("provider") or "?")
    ctx = item.get("context_window")
    ctx_s = f"{int(ctx) // 1000}k" if isinstance(ctx, int) else "?"
    mm = INPUT_LABEL_IMAGE if item.get(IMAGE_INPUT_KEY, False) else INPUT_LABEL_TEXT
    mark = "* " if key == current_key else "  "
    return f"{mark}{key} · {label} · {provider} · {ctx_s} · {mm} · {_pricing_summary(item.get('pricing'))}"


def model_info_lines(config: Dict[str, Any]) -> List[str]:
    cur = current_model_key(config)
    lines: List[str] = []
    for item in available_models(config):
        effort = f" effort={item.get('reasoning_effort')}" if item.get("reasoning_effort") else ""
        lines.append(f"{model_choice_title(item, current_key=cur)} · {item['model_name']}{effort}")
    return lines


def reasoning_efforts_for_config(config: Dict[str, Any]) -> List[str]:
    if _is_retired_model(
        {
            "key": str((config or {}).get(SELECTED_MODEL_KEY) or ""),
            "model_name": str((config or {}).get("model_name") or ""),
        }
    ):
        return []
    key = current_model_key(config)
    for item in _all_model_choices(config):
        if item.get("key") == key:
            efforts = item.get("reasoning_efforts") or []
            return [str(e).lower() for e in efforts if str(e).lower() in REASONING_EFFORT_LEVELS]
    return []


def current_reasoning_effort(config: Dict[str, Any]) -> str:
    effort = str((config or {}).get("reasoning_effort") or "").strip().lower()
    available = reasoning_efforts_for_config(config)
    return effort if effort in available else ""


def persist_config(config: Dict[str, Any], path: Path = CONFIG_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def _default_visible_gateway_key() -> str:
    """收敛目标必须落在可见集合里, 否则会把配置指到一个选择器里选不出来的模型。"""
    if DEFAULT_GATEWAY_MODEL_KEY in GATEWAY_VISIBLE_MODEL_KEYS:
        return DEFAULT_GATEWAY_MODEL_KEY
    return next(
        (
            str(item.get("key") or "")
            for item in GATEWAY_MODEL_CATALOG
            if str(item.get("key") or "") in GATEWAY_VISIBLE_MODEL_KEYS
        ),
        "",
    )


def converge_gateway_model_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """把内置网关配置的**执行面**收敛到当前对外提供的模型。

    `GATEWAY_VISIBLE_MODEL_KEYS` 只收窄选择器; 而 config 里残留的 `model_name` /
    `small_model_name` 是 `build_provider` 直接拿去调用的值 —— 技能/研究等非会话路径
    不经选择器, 旧配置会一直调一个产品已经不提供的模型。所以加载态也要收敛。

    **不写盘**: 与 `load_config_values` "不持久化默认值" 的契约一致 —— 可见集合放开后
    行为立刻跟随, 也不去改用户文件。空集合 = 不收敛。
    """

    cfg = dict(config or {})
    if not GATEWAY_VISIBLE_MODEL_KEYS or not _is_deeprd_gateway(cfg):
        return cfg
    if current_model_key(cfg) in GATEWAY_VISIBLE_MODEL_KEYS:
        return cfg
    target = _default_visible_gateway_key()
    if not target:
        return cfg
    return apply_model_to_config(cfg, resolve_model_choice(target, cfg))


def normalize_imported_model_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Make one imported model identity internally consistent before probing it."""

    normalized = dict(config or {})
    normalized.pop(AVAILABLE_MODEL_KEYS, None)
    selected = str(normalized.get(SELECTED_MODEL_KEY) or "").strip()
    current = current_model_key(normalized)
    if selected and current == selected:
        choice = resolve_model_choice(selected, normalized)
        normalized = apply_model_to_config(normalized, choice)
    elif selected and not current:
        normalized.pop(SELECTED_MODEL_KEY, None)
    normalized["image_input"] = image_input_for_config(normalized)
    return normalized


__all__ = [
    "AVAILABLE_MODEL_KEYS",
    "MODEL_CATALOG",
    "available_models",
    "apply_model_to_config",
    "converge_gateway_model_config",
    "current_model_key",
    "current_reasoning_effort",
    "declares_external_connection",
    "image_input_for_config",
    "model_choice_title",
    "model_info_lines",
    "public_model_choice",
    "reasoning_efforts_for_config",
    "resolve_model_choice",
    "normalize_imported_model_config",
    "pin_builtin_gateway_route",
    "RETIRED_CONNECTION_KEYS",
]
