"""Codex-owned home, authentication synchronization and provider configuration.

The caller selects an isolated home through environment configuration. This
module never imports product paths or reads native thread databases.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
import tomllib
from pathlib import Path
from typing import Any, Iterable, Mapping

# 书深技能调用网关时使用的 API key 环境变量名。这是产品与 adapter 共享的
# 进程级契约（产品层写入、Codex 子进程读取），不能反向 import 产品层拿。
SKILL_API_KEY_ENV = "SCHOLARSEED_API_KEY"
# Codex 隔离后的 App Server 状态根，从机制路径单一来源派生。
CODEX_DEFAULT_HOME_DIRNAME = ".codex"
CODEX_RUNTIME_HOME: Path = Path.home() / CODEX_DEFAULT_HOME_DIRNAME

CODEX_HOME_ENV = "CODEX_HOME"
SCHOLARSEED_CODEX_EXECUTABLE_ENV = "SCHOLARSEED_CODEX_EXECUTABLE"
SCHOLARSEED_CODEX_HOME_ENV = "SCHOLARSEED_CODEX_HOME"
SCHOLARSEED_CODEX_SOURCE_HOME_ENV = "SCHOLARSEED_CODEX_SOURCE_HOME"
CODEX_AUTH_FILENAME = "auth.json"
CODEX_CONFIG_FILENAME = "config.toml"
CODEX_REMOTE_CONFIG_OPTION = "-c"
CODEX_REMOTE_AUTH_CONFIG = 'cli_auth_credentials_store="ephemeral"'
CODEX_MODEL_PROVIDER_KEY = "model_provider"
CODEX_MODEL_PROVIDERS_KEY = "model_providers"
TEXT_ENCODING = "utf-8"
CODEX_CATALOG_DIRECTORY = "model-catalogs"
CODEX_CATALOG_SUFFIX = ".json"
PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
# Codex 子进程继承宿主环境，其模型客户端在默认配置下会走系统代理且**不豁免 loopback**
# （respect_system_proxy 默认关闭 → reqwest auto_sys_proxy → hyper-util from_system），
# 所以产品自有的本机内部通道必须显式豁免，否则请求被代理截走、永远到不了产品进程。
NO_PROXY_ENV = "NO_PROXY"
NO_PROXY_ENV_ALIAS = "no_proxy"
NO_PROXY_SEPARATOR = ","
# Windows 的环境变量名不区分大小写：NO_PROXY / no_proxy / No_Proxy 是同一个变量，而
# ``os.environ.copy()`` 会原样保留宿主实际使用的那个拼写。只追加两个规范拼写会把宿主的
# 旧值一起带进子进程环境块，大小写不敏感的查找可能命中那份旧值，豁免就静默失效——所以
# 必须覆盖**每一个**实际存在的拼写。POSIX 区分大小写，读取方只认这两个固定拼写。
ENVIRONMENT_NAME_CASE_INSENSITIVE = os.name == "nt"


def configured_codex_executable(environ: Mapping[str, str] | None = None) -> str:
    """Return an explicitly selected upstream Codex executable, when configured."""

    source = os.environ if environ is None else environ
    return str(source.get(SCHOLARSEED_CODEX_EXECUTABLE_ENV, "") or "").strip()


def _inherited_no_proxy_spellings(inherited: Mapping[str, str]) -> tuple[str, ...]:
    """Return every key spelling the child would actually resolve as the bypass list."""

    if ENVIRONMENT_NAME_CASE_INSENSITIVE:
        folded = NO_PROXY_ENV.lower()
        return tuple(key for key in inherited if str(key).lower() == folded)
    return tuple(key for key in (NO_PROXY_ENV, NO_PROXY_ENV_ALIAS) if key in inherited)


def proxy_bypass_environment(
    inherited: Mapping[str, str], bypass_hosts: Iterable[str]
) -> dict[str, str]:
    """Project declared internal-channel hosts into the child's proxy bypass list.

    Every spelling the child could resolve is written with the same merged value: the
    native readers take the first key they find instead of merging them, one of them
    reads only the uppercase key, and a case-insensitive platform keeps whichever
    spelling the host already used. Entries the user declared are preserved. Returns
    ``{}`` when nothing is declared, leaving the host's own proxy semantics untouched.
    """

    hosts = tuple(dict.fromkeys(str(host).strip() for host in bypass_hosts if str(host).strip()))
    if not hosts:
        return {}
    spellings = _inherited_no_proxy_spellings(inherited)
    entries: list[str] = []
    seen: set[str] = set()
    for key in spellings:
        for entry in str(inherited.get(key, "") or "").split(NO_PROXY_SEPARATOR):
            name = entry.strip()
            if name and name.lower() not in seen:
                seen.add(name.lower())
                entries.append(name)
    for host in hosts:
        if host.lower() not in seen:
            seen.add(host.lower())
            entries.append(host)
    merged = NO_PROXY_SEPARATOR.join(entries)
    projection = {key: merged for key in spellings}
    projection.setdefault(NO_PROXY_ENV, merged)
    projection.setdefault(NO_PROXY_ENV_ALIAS, merged)
    return projection


def store_model_catalog(runtime_home: Path, payload: bytes) -> Path:
    directory = runtime_home / CODEX_CATALOG_DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (hashlib.sha256(payload).hexdigest() + CODEX_CATALOG_SUFFIX)
    if destination.is_file() and destination.read_bytes() == payload:
        return destination
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(payload)
        os.replace(temporary_path, destination)
        return destination
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def prepare_codex_runtime_home(*, native_authentication: bool = False) -> Path:
    """Prepare App Server state for the selected authentication boundary.

    Remote callers retain their existing thread storage and never resolve a
    personal auth/config source. Their process launch disables persisted auth.
    Only explicit native callers synchronize authentication when that source
    is newer, so an old copied refresh token cannot outlive a later ``codex login``.
    A newer ScholarSeed-side credential is preserved. Thread state stays in this
    home and is restored only through the official App Server API.

    产品 developer instructions 只通过公开的 ``thread/start|resume`` 参数注入，
    不写入进程级 ``config.toml``，避免跨会话污染和重复注入。
    """

    target = _runtime_home()
    target.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    try:
        target.chmod(PRIVATE_DIRECTORY_MODE)
    except OSError:
        pass
    if native_authentication:
        source = _source_home(target)
        _sync_auth_from_source(source, target)
    return target


def _runtime_home() -> Path:
    configured = os.environ.get(SCHOLARSEED_CODEX_HOME_ENV, "").strip()
    return Path(configured).expanduser().resolve() if configured else CODEX_RUNTIME_HOME.resolve()


def _source_home(target: Path) -> Path:
    configured = os.environ.get(SCHOLARSEED_CODEX_SOURCE_HOME_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    inherited = os.environ.get(CODEX_HOME_ENV, "").strip()
    source = Path(inherited).expanduser().resolve() if inherited else (Path.home() / ".codex")
    return source if source != target else target


def source_model_provider() -> tuple[str, dict[str, Any]]:
    """Read the selected custom model provider from the personal Codex home.

    Subscription models run on the App Server, which authenticates from the synced
    ``auth.json``. An api-key login (``codex login --with-api-key``) only reaches its
    endpoint when the provider table that key belongs to travels with it, so the one
    selected definition is read here and projected per session through
    ``thread_config``. The global config file itself stays un-inherited: only this
    table crosses the boundary, never prompts, plugins, or MCP servers.

    Returns ``("", {})`` when the source home selects no provider, which leaves the
    App Server on its built-in subscription connection.
    """

    source = _source_home(_runtime_home())
    config_path = source / CODEX_CONFIG_FILENAME
    try:
        with open(config_path, "rb") as handle:
            config = tomllib.load(handle)
    except (OSError, ValueError):
        # Unreadable or malformed personal config: fall back to the built-in connection.
        return "", {}
    provider_id = str(config.get(CODEX_MODEL_PROVIDER_KEY) or "").strip()
    if not provider_id:
        return "", {}
    providers = config.get(CODEX_MODEL_PROVIDERS_KEY)
    definition = providers.get(provider_id) if isinstance(providers, Mapping) else None
    # A built-in provider id (e.g. "openai") carries no table; the id alone is enough.
    return provider_id, dict(definition) if isinstance(definition, Mapping) else {}


def _sync_auth_from_source(source: Path, target: Path) -> None:
    destination = target / CODEX_AUTH_FILENAME
    origin = source / CODEX_AUTH_FILENAME
    if not origin.is_file() or origin.resolve() == destination.resolve():
        return
    if destination.is_file() and destination.stat().st_mtime_ns >= origin.stat().st_mtime_ns:
        return
    _copy_private_file(origin, destination)


def _copy_private_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    with tempfile.NamedTemporaryFile(
        dir=destination.parent,
        prefix=f"{destination.name}.",
        delete=False,
    ) as handle:
        staged = Path(handle.name)
    try:
        shutil.copyfile(source, staged)
        staged.chmod(PRIVATE_FILE_MODE)
        staged.replace(destination)
    finally:
        if staged.exists():
            staged.unlink()


__all__ = [
    "CODEX_HOME_ENV",
    "CODEX_RUNTIME_HOME",
    "SCHOLARSEED_CODEX_EXECUTABLE_ENV",
    "SKILL_API_KEY_ENV",
    "configured_codex_executable",
    "prepare_codex_runtime_home",
    "proxy_bypass_environment",
    "source_model_provider",
]
