"""Product-neutral configuration ownership and first-run readiness."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Protocol

from service.paths import CONFIG_PATH
from service.settings.catalog import (
    RETIRED_CONNECTION_KEYS,
    converge_gateway_model_config,
    pin_builtin_gateway_route,
)
from service.settings.connections import ModelProfileStore, profile_store_path


class RuntimeConfigProfile(Protocol):
    """Minimal external-runtime configuration owner contract."""

    config_path: str


DEFAULT_CONFIG_PATH = Path(__file__).with_name("default.json")
CONFIG_MODEL = "model_name"
SETUP_FIELDS = (CONFIG_MODEL,)
CONFIG_DIRECTORY_MODE = 0o700
CONFIG_FILE_MODE = 0o600


def config_path_for_profile(profile: RuntimeConfigProfile | None = None) -> Path:
    """Resolve the configuration owner selected by one runtime profile."""

    configured = str(profile.config_path or "").strip() if profile is not None else ""
    return Path(configured).expanduser() if configured else CONFIG_PATH


def connection_store_for_path(config_path: Path) -> ModelProfileStore:
    """Keep personal connections adjacent to their owning configuration."""

    return ModelProfileStore(profile_store_path(config_path))


def _read_object(path: Path, *, required: bool) -> dict[str, Any]:
    if not path.exists():
        if required:
            raise FileNotFoundError(f"Config not found: {path}")
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"Config is not valid JSON: {path}: {exc.msg}") from exc
    except OSError as exc:
        raise ValueError(f"Config cannot be read: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"Config must be a JSON object: {path}")
    return value


def _merge(base: Mapping[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        prior = merged.get(key)
        if isinstance(prior, Mapping) and isinstance(value, Mapping):
            merged[key] = _merge(prior, value)
        else:
            merged[key] = value
    return merged


def strip_retired_connection_fields(config: Mapping[str, Any]) -> dict[str, Any]:
    """忽略用户文件里的顶层连接字段 —— 连接的唯一入口是「模型服务配置」。

    内置 lane 的执行地址由产品常量在加载态钉死 (``pin_builtin_gateway_route``), 凭据走
    账号令牌 / 环境变量; BYOK 与自托管连接一律经 profile store 的 ``apply_profile``
    唯一门生效。config.json 顶层的连接身份 / 凭据字段 (含 ``*_env`` 间接键) 因此整体
    退役: 无论存量文件里写了什么, 加载态直接忽略, 不迁移也不写盘。
    ``model_name`` / ``small_model_name`` 是模型选择不是连接, 保留。
    """

    return {key: value for key, value in config.items() if key not in RETIRED_CONNECTION_KEYS}


def load_config_values(
    path: Path | None = None,
    *,
    profile: RuntimeConfigProfile | None = None,
) -> dict[str, Any]:
    """Resolve one effective config without persisting defaults or environment secrets.

    This is the built-in product configuration only. A personal connection reaches a
    config through exactly one door — ``apply_profile`` — because overlaying one here
    also rewrites ``base_url``, and the built-in catalogue source is selected from that
    field: an implicit overlay silently changed which built-in models existed.

    加载链: 产品默认 + 用户文件 (连接字段已退役, 只取模型选择等非连接值) → 钉内置
    地址 → 把执行面收敛到当前对外提供的模型。选择器收窄拦不住 ``model_name`` 被直接
    送去调用的非会话路径, 所以效力必须落在**生效配置**上。
    """

    owner_path = path or config_path_for_profile(profile)
    declared_profile_path = bool(str(profile.config_path or "").strip()) if profile else False
    external_owner = path is not None or declared_profile_path
    if external_owner:
        config = strip_retired_connection_fields(_read_object(owner_path, required=True))
    else:
        defaults = _read_object(DEFAULT_CONFIG_PATH, required=True)
        config = _merge(
            defaults, strip_retired_connection_fields(_read_object(owner_path, required=False))
        )
    # 先钉内置 lane 的执行地址 (产品常量), 再收敛执行面模型 —— 顺序不能反:
    # converge 的目录条目按网关常量派生 call_url。
    return converge_gateway_model_config(pin_builtin_gateway_route(config))


def missing_setup_fields(config: Mapping[str, Any]) -> list[str]:
    """Return public readiness gaps without exposing any credential value.

    连接退役后, 就绪面只剩模型选择: 内置 lane 恒有地址 (产品常量) 与凭据通道
    (账号令牌 / 环境变量), 收敛步会保证 ``model_name`` 落到当前对外提供的模型。
    """

    return [key for key in SETUP_FIELDS if not str(config.get(key) or "").strip()]


def config_status(profile: RuntimeConfigProfile | None = None) -> dict[str, Any]:
    """Return a redacted status document for CLI/front-end bootstrap."""

    owner_path = config_path_for_profile(profile)
    try:
        config = load_config_values(profile=profile)
        missing = missing_setup_fields(config)
        error = ""
    except (FileNotFoundError, ValueError) as exc:
        config = {}
        missing = list(SETUP_FIELDS)
        error = str(exc)
    return {
        "configured": not missing and not error,
        "reason": "" if not missing and not error else "model_selection_missing",
        "config_path": str(owner_path),
        "connection_path": str(profile_store_path(owner_path)),
        "model": str(config.get(CONFIG_MODEL) or ""),
        "missing_fields": missing,
        "error": error,
    }


def save_setup_connection(values: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and save one personal model connection into the profile store.

    ``upsert`` enables a newly created connection on its own, so there is no separate
    activation step.
    """

    owner_path = config_path_for_profile()
    store = connection_store_for_path(owner_path)
    store.upsert(values)
    status = config_status()
    if not status["configured"]:
        raise ValueError(f"saved connection is incomplete: {status['missing_fields']}")
    return status


__all__ = [
    "DEFAULT_CONFIG_PATH",
    "SETUP_FIELDS",
    "config_path_for_profile",
    "config_status",
    "connection_store_for_path",
    "load_config_values",
    "missing_setup_fields",
    "save_setup_connection",
    "strip_retired_connection_fields",
]
