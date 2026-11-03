"""Codex-owned runtime storage and isolated process configuration.

The caller selects an isolated home through environment configuration. This
module never imports product paths or reads native thread databases.
"""

from __future__ import annotations

import hashlib
import os
import stat
import tempfile
import tomllib
from pathlib import Path
from typing import Iterable, Mapping

from scholarseed_runtime.contract.storage import StorageInspection

# 书深技能调用网关时使用的 API key 环境变量名。这是产品与 adapter 共享的
# 进程级契约（产品层写入、Codex 子进程读取），不能反向 import 产品层拿。
SKILL_API_KEY_ENV = "SCHOLARSEED_API_KEY"
# Codex 隔离后的 App Server 状态根，从机制路径单一来源派生。
CODEX_DEFAULT_HOME_DIRNAME = ".codex"
CODEX_RUNTIME_HOME: Path = Path.home() / CODEX_DEFAULT_HOME_DIRNAME

CODEX_HOME_ENV = "CODEX_HOME"
CODEX_SQLITE_HOME_ENV = "CODEX_SQLITE_HOME"
SCHOLARSEED_CODEX_EXECUTABLE_ENV = "SCHOLARSEED_CODEX_EXECUTABLE"
SCHOLARSEED_CODEX_HOME_ENV = "SCHOLARSEED_CODEX_HOME"
CODEX_CONFIG_FILENAME = "config.toml"
CODEX_MODEL_PROVIDERS_KEY = "model_providers"
CODEX_DISCOVERY_HOME_DIRNAME = "host"
CODEX_STORAGE_CONFIG_KEYS = ("sqlite_home", "log_dir")
CODEX_STORAGE_CONFIG_MAX_BYTES = 1024 * 1024
CODEX_CATALOG_IMMUTABLE_ERROR = "runtime_model_catalog_immutable_conflict"
CODEX_REMOTE_CONFIG_OPTION = "-c"
CODEX_REMOTE_AUTH_CONFIG = 'cli_auth_credentials_store="ephemeral"'
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
ISOLATED_SYSTEM_ENVIRONMENT = frozenset({"systemroot", "windir", "comspec", "pathext"})
ISOLATED_HOME_ENVIRONMENT = (
    "HOME",
    "USERPROFILE",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "TMP",
    "TEMP",
    "TMPDIR",
)


def process_environment_snapshot(
    overrides: Mapping[str, str], remove_environment: tuple[str, ...] = ()
) -> dict[str, str]:
    inherited = dict(os.environ)
    if ENVIRONMENT_NAME_CASE_INSENSITIVE:
        inherited = {name.upper(): value for name, value in inherited.items()}
        overrides = {name.upper(): value for name, value in overrides.items()}
        remove_environment = tuple(name.upper() for name in remove_environment)
    for name in remove_environment:
        inherited.pop(name, None)
    inherited.update(overrides)
    return inherited


def isolated_runtime_environment(
    home: Path, environ: Mapping[str, str] | None = None
) -> dict[str, str]:
    """Keep private inspection/probe processes away from ambient state and secrets."""
    inherited = os.environ if environ is None else environ
    environment = {
        key: value for key, value in inherited.items() if key.lower() in ISOLATED_SYSTEM_ENVIRONMENT
    }
    environment.update(dict.fromkeys(ISOLATED_HOME_ENVIRONMENT, str(home)))
    return environment


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

    def existing_matches() -> bool:
        try:
            metadata = destination.lstat()
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(metadata.st_mode) or destination.read_bytes() != payload:
            raise ValueError(CODEX_CATALOG_IMMUTABLE_ERROR)
        return True

    if existing_matches():
        return destination
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(payload)
        try:
            os.link(temporary_path, destination)
        except FileExistsError:
            if not existing_matches():
                raise ValueError(CODEX_CATALOG_IMMUTABLE_ERROR) from None
        return destination
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def prepare_codex_runtime_home() -> Path:
    """Prepare managed thread storage without importing personal credentials.

    Authentication belongs to the host's explicit model connection. Existing
    thread data and directory permissions stay unchanged.
    """
    target = runtime_storage_roots()[0]
    target.mkdir(parents=True, exist_ok=True, mode=PRIVATE_DIRECTORY_MODE)
    return target


def runtime_home(environ: Mapping[str, str] | None = None) -> Path:
    """Resolve App Server storage before any directory or credential mutation."""

    source = os.environ if environ is None else environ
    configured = source.get(SCHOLARSEED_CODEX_HOME_ENV, "").strip()
    return Path(configured).expanduser().resolve() if configured else CODEX_RUNTIME_HOME.resolve()


def runtime_sqlite_home(environ: Mapping[str, str] | None = None) -> Path | None:
    """Resolve the native SQLite environment override without opening storage.

    Absence is distinct from the default Home: native configuration can select
    SQLite storage independently, so this declaration is not a complete native
    configuration or a cross-version compatibility receipt.
    """

    source = os.environ if environ is None else environ
    if ENVIRONMENT_NAME_CASE_INSENSITIVE:
        values = {
            value.strip()
            for name, value in source.items()
            if name.casefold() == CODEX_SQLITE_HOME_ENV.casefold()
        }
        if len(values) > 1:
            raise ValueError("conflicting CODEX_SQLITE_HOME environment spellings")
        configured = next(iter(values), "")
    else:
        configured = source.get(CODEX_SQLITE_HOME_ENV, "").strip()
    if not configured:
        return None
    selected = Path(configured)
    if not selected.is_absolute():
        raise ValueError("CODEX_SQLITE_HOME must be an absolute path for managed Codex")
    return selected.resolve()


def runtime_storage_roots(
    environ: Mapping[str, str] | None = None, *, inspection: StorageInspection | None = None
) -> tuple[Path, ...]:
    """Declare environment and runtime-Home config roots without preparing them.

    This includes all selected local roots conservatively, even when another
    native layer may override a value. It does not resolve system, enterprise,
    profile or project layers and cannot certify the native effective config.
    """

    home = runtime_home(environ)
    sqlite_home = runtime_sqlite_home(environ)
    roots = [home]
    if sqlite_home is not None:
        roots.append(sqlite_home)
    if inspection is None or not inspection.selected(str(home)):
        return tuple(dict.fromkeys(roots))
    data = inspection.read(str(home), CODEX_CONFIG_FILENAME, CODEX_STORAGE_CONFIG_MAX_BYTES)
    configuration = {} if data is None else tomllib.loads(data.decode(TEXT_ENCODING))
    for key in CODEX_STORAGE_CONFIG_KEYS:
        if key not in configuration:
            continue
        configured = configuration[key]
        if not isinstance(configured, str) or "\0" in configured:
            raise ValueError(f"invalid managed Codex storage setting: {key}")
        selected = Path(configured)
        # Native '~' refers to the managed child Home, not the parent user's
        # Home. Other '~name' spellings remain ordinary relative paths.
        if configured == "~":
            selected = home / CODEX_DISCOVERY_HOME_DIRNAME
        elif configured.startswith("~/") or (os.name == "nt" and configured.startswith("~\\")):
            selected = (
                home
                / CODEX_DISCOVERY_HOME_DIRNAME
                / configured[2:].lstrip("/\\" if os.name == "nt" else "/")
            )
        if selected.drive and not selected.is_absolute():
            raise ValueError(f"drive-relative managed Codex storage setting: {key}")
        roots.append((home / selected).resolve())
    return tuple(dict.fromkeys(roots))


__all__ = [
    "CODEX_HOME_ENV",
    "CODEX_RUNTIME_HOME",
    "SCHOLARSEED_CODEX_EXECUTABLE_ENV",
    "SKILL_API_KEY_ENV",
    "configured_codex_executable",
    "prepare_codex_runtime_home",
    "proxy_bypass_environment",
    "runtime_home",
]
