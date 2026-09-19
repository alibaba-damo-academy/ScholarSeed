"""Runtime adapter 注册与选择 —— 「让书深自由切换底层 Harness」的那个开关。

职责边界：
- 本模块是 adapter 的**组合入口**（开源方案 §4：「Serve 是 adapter 的组合入口」）；
- 它按 ``product.json`` 的多 runtime manifest 决定哪些 runtime 被启用、默认哪一个；
- 它只解析产品 manifest；provider 实现由 DamoAgent RuntimeCatalog 发现；
- 它**不**认识任何 runtime 的私有协议 —— 那些封在各 adapter 包里。

因此新增一个 Harness（Damoclaw / DeepSeek Harness / 任意第三方）是：写一个 adapter
包 + 在 manifest 里加一条 ``runtimes`` 记录，而不是改动产品代码。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

HARNESS_ENV = "SCHOLARSEED_HARNESS"
PRODUCT_MANIFEST_ENV = "SCHOLARSEED_PRODUCT_MANIFEST"
PRODUCT_MANIFEST_FILENAME = "product.json"
MANIFEST_DEFAULT_RUNTIME_KEY = "default_runtime"
MANIFEST_RUNTIMES_KEY = "runtimes"
MANIFEST_MODULE_KEY = "module"
MANIFEST_ENABLED_KEY = "enabled"
MANIFEST_ADAPTER_KEY = "adapter"
MANIFEST_CONFIGURATION_KEY = "configuration"
TEXT_ENCODING = "utf-8"


class RuntimeManifestError(RuntimeError):
    """product.json 缺失、损坏，或选择了一个未启用/未注册的 runtime。"""

    safe_error = "runtime_manifest_invalid"


@dataclass(frozen=True)
class RuntimeRegistration:
    """manifest 里一条 runtime 记录的产品投影。"""

    runtime_id: str
    adapter: str
    module: str
    enabled: bool
    settings: Mapping[str, Any]


def _manifest_path() -> Path:
    """定位构建期冻结的产品 manifest。

    打包后读 App Resources 内的不可变副本（由 ``SCHOLARSEED_PRODUCT_MANIFEST`` 指向，
    主进程在启动时把它指到只读副本），开发树里回落到仓库根 ``product.json``。
    """

    configured = os.environ.get(PRODUCT_MANIFEST_ENV, "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    # service/chat/service/adapters.py -> service/chat/service -> service/chat
    #   -> service -> apps/serve -> apps -> <repo root>
    return Path(__file__).resolve().parents[5] / PRODUCT_MANIFEST_FILENAME


@lru_cache(maxsize=1)
def load_manifest() -> Mapping[str, Any]:
    """读取并缓存产品 manifest。缺失或损坏都显式失败，不静默回落到写死的 codex。"""

    path = _manifest_path()
    try:
        payload = json.loads(path.read_text(encoding=TEXT_ENCODING))
    except (OSError, ValueError) as error:
        raise RuntimeManifestError(f"product manifest is unreadable: {path} ({error})")
    if not isinstance(payload, dict):
        raise RuntimeManifestError(f"product manifest must be a JSON object: {path}")
    runtimes = payload.get(MANIFEST_RUNTIMES_KEY)
    if not isinstance(runtimes, dict) or not runtimes:
        raise RuntimeManifestError(f"product manifest declares no runtimes: {path}")
    return payload


def registrations() -> Mapping[str, RuntimeRegistration]:
    """manifest 中声明的全部 runtime（含未启用的，便于产品层解释原因）。"""

    raw = load_manifest()[MANIFEST_RUNTIMES_KEY]
    result: dict[str, RuntimeRegistration] = {}
    for runtime_id, settings in raw.items():
        if not isinstance(settings, dict):
            raise RuntimeManifestError(f"runtime {runtime_id!r} manifest entry must be an object")
        module = str(settings.get(MANIFEST_MODULE_KEY) or "").strip()
        if not module:
            raise RuntimeManifestError(f"runtime {runtime_id!r} declares no adapter module")
        normalized = str(runtime_id).strip().lower()
        result[normalized] = RuntimeRegistration(
            runtime_id=normalized,
            adapter=str(settings.get(MANIFEST_ADAPTER_KEY) or "").strip(),
            module=module,
            enabled=bool(settings.get(MANIFEST_ENABLED_KEY)),
            settings=settings,
        )
    return result


def enabled_runtimes() -> tuple[str, ...]:
    """按 manifest 启用的 runtime id（产品层的可选 Harness 集合）。"""

    return tuple(
        sorted(
            runtime_id
            for runtime_id, registration in registrations().items()
            if registration.enabled
        )
    )


def default_runtime_id() -> str:
    """manifest 声明的默认 runtime；必须是一个已启用的 runtime。"""

    selected = str(load_manifest().get(MANIFEST_DEFAULT_RUNTIME_KEY) or "").strip().lower()
    if not selected:
        raise RuntimeManifestError("product manifest declares no default_runtime")
    available = enabled_runtimes()
    if selected not in available:
        raise RuntimeManifestError(
            f"default runtime {selected!r} is not enabled; enabled runtimes: {', '.join(available)}"
        )
    return selected


def resolve_runtime_id(environ: Mapping[str, str] | None = None) -> str:
    """决定本进程使用哪个 Harness。

    优先级：``SCHOLARSEED_HARNESS`` 显式指定 > manifest 的 ``default_runtime``。显式
    指定一个未启用的 runtime 是配置错误，直接失败而不是悄悄回落到默认值。
    """

    source = os.environ if environ is None else environ
    selected = str(source.get(HARNESS_ENV) or "").strip().lower()
    if not selected:
        return default_runtime_id()
    available = enabled_runtimes()
    if selected not in available:
        raise RuntimeManifestError(
            f"unknown {HARNESS_ENV} value {selected!r}; enabled runtimes: {', '.join(available)}"
        )
    return selected


__all__ = [
    "HARNESS_ENV",
    "PRODUCT_MANIFEST_ENV",
    "RuntimeManifestError",
    "RuntimeRegistration",
    "default_runtime_id",
    "enabled_runtimes",
    "load_manifest",
    "registrations",
    "resolve_runtime_id",
]
