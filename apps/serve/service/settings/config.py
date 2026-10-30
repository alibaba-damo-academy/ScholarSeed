"""Product-neutral configuration ownership and first-run readiness."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol

from service.paths import CONFIG_PATH
from service.platform.privacy import protect_path
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


CONFIG_SEED_ENV = "SCHOLARSEED_CONFIG_SEED_PATH"
SEEDED_CREDENTIAL_FIELDS = ("api_key",)


@dataclass(frozen=True)
class ConfigSeed:
    target: Path
    payload: bytes = field(repr=False)
    dropped: tuple[str, ...]


def config_seed_source(
    *, target_present: bool, source: Path | None = None, target: Path = CONFIG_PATH
) -> Path | None:
    """Select a seed path without reading its bytes or creating storage."""
    if target_present:
        return None
    if source is None:
        source_value = os.environ.get(CONFIG_SEED_ENV, "").strip()
        if not source_value:
            return None
        raw_source = Path(source_value).expanduser()
    else:
        raw_source = source
    if raw_source.resolve() == target.resolve():
        return None
    return raw_source.absolute()


def decode_config_seed(payload: bytes, *, source: Path, target: Path = CONFIG_PATH) -> ConfigSeed:
    """Sanitize bytes read by the owning startup or standalone configuration path."""
    raw_source = source
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"default config is not valid JSON: {raw_source}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"default config must be a JSON object: {raw_source}")
    dropped = tuple(name for name in SEEDED_CREDENTIAL_FIELDS if parsed.pop(name, None) is not None)
    payload = (json.dumps(parsed, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return ConfigSeed(target, payload, dropped)


def prepare_config_seed(
    *, target_present: bool, source: Path | None = None, target: Path = CONFIG_PATH
) -> ConfigSeed | None:
    """Read and sanitize a standalone seed without creating target storage."""
    selected = config_seed_source(target_present=target_present, source=source, target=target)
    if selected is None:
        return None
    if not selected.is_file():
        raise RuntimeError(f"default config does not exist: {selected}")
    return decode_config_seed(selected.read_bytes(), source=selected, target=target)


def publish_config_seed(seed: ConfigSeed) -> bool:
    """Publish the inspected bytes without replacing a concurrently created config."""
    target = seed.target
    if target.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    staged: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=target.parent, prefix=f"{target.name}.", delete=False
        ) as config_file:
            staged = Path(config_file.name)
            protect_path(staged, CONFIG_FILE_MODE, config_file.fileno())
            config_file.write(seed.payload)
            config_file.flush()
            os.fsync(config_file.fileno())
        try:
            # Publishing a complete same-volume inode must never replace a
            # config which another startup or the user created meanwhile.
            os.link(staged, target)
        except FileExistsError:
            return False
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)
    print(f"[scholarseed serve] initialized packaged config: {target}", file=sys.stderr)
    if seed.dropped:
        print(
            "[scholarseed serve] dropped packaged credential fields: " + ", ".join(seed.dropped),
            file=sys.stderr,
        )
    return True


def seed_user_config(*, source: Path | None = None, target: Path = CONFIG_PATH) -> bool:
    """Create a missing user config from the sanitized packaged seed exactly once."""
    seed = prepare_config_seed(target_present=target.exists(), source=source, target=target)
    return publish_config_seed(seed) if seed is not None else False


def config_path_for_profile(profile: RuntimeConfigProfile | None = None) -> Path:
    """Resolve the configuration owner selected by one runtime profile."""

    configured = str(profile.config_path or "").strip() if profile is not None else ""
    return Path(configured).expanduser() if configured else CONFIG_PATH


def connection_store_for_path(config_path: Path) -> ModelProfileStore:
    """Keep personal connections adjacent to their owning configuration."""

    return ModelProfileStore(profile_store_path(config_path))


def _read_object(path: Path, *, required: bool) -> dict[str, Any]:
    try:
        payload = path.read_bytes()
    except FileNotFoundError:
        if required:
            raise FileNotFoundError(f"Config not found: {path}")
        return {}
    except OSError as exc:
        raise ValueError(f"Config cannot be read: {path}: {exc}") from exc
    return decode_config_object(payload, path=path)


def decode_config_object(payload: bytes | None, *, path: Path = CONFIG_PATH) -> dict[str, Any]:
    """Decode an owner file or an already qualified read without writing defaults."""
    if payload is None:
        return {}
    try:
        value = json.loads(payload.decode("utf-8"))
    except UnicodeError as exc:
        raise ValueError(f"Config is not valid UTF-8: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Config is not valid JSON: {path}: {exc.msg}") from exc
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
    "ConfigSeed",
    "DEFAULT_CONFIG_PATH",
    "SETUP_FIELDS",
    "config_path_for_profile",
    "config_seed_source",
    "decode_config_seed",
    "config_status",
    "connection_store_for_path",
    "load_config_values",
    "decode_config_object",
    "missing_setup_fields",
    "prepare_config_seed",
    "publish_config_seed",
    "save_setup_connection",
    "seed_user_config",
    "strip_retired_connection_fields",
]
