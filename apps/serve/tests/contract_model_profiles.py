"""Contract coverage for file-backed personal API model profiles."""

# 测试隔离写法: 先设 SCHOLARSEED_HOME, 再 import 持有路径的首方模块。
# pylint: disable=wrong-import-position

from __future__ import annotations

import asyncio
import json
import os
import stat
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI

TEST_HOME = tempfile.TemporaryDirectory()
# Test isolation must select SCHOLARSEED_HOME before importing path-owning modules.
os.environ["SCHOLARSEED_HOME"] = TEST_HOME.name

from service.chat.api.settings import mount_setting_routes  # noqa: E402
from service.chat.schema import PersonalApiRequest  # noqa: E402
from service.chat.service import models as model_module  # noqa: E402
from service.chat.service.completions import CompletionBridge  # noqa: E402
from service.chat.service.models import (  # noqa: E402
    GATEWAY_LOGIN_REQUIRED_ERROR,
    RETIRED_NATIVE_MODEL_KEY,
    SUBSCRIPTION_CONNECTION_REQUIRED_CODE,
    ModelService,
    SessionModelUnavailableError,
)
from service.identity.service.account_token import (  # noqa: E402
    CONV_MESSAGE_ID_HEADER,
    CONV_TURN_ID_HEADER,
)
from service.identity.utils import LOCAL_USER_ID, OWNERSHIP_AXIS_MACHINE  # noqa: E402
from service.settings.catalog import (  # noqa: E402
    DEFAULT_GATEWAY_MODEL_KEY,
    GATEWAY_VISIBLE_MODEL_KEYS,
    _is_deeprd_gateway,
    converge_gateway_model_config,
)
from service.settings.config import load_config_values  # noqa: E402
from service.settings.connections import (  # noqa: E402
    MODEL_HIDDEN_KEY,
    SUPPORTED_WIRE_APIS,
    ModelProfileStore,
    UnknownProfileError,
    apply_profile,
    parse_personal_model_key,
    personal_model_key,
)

PASS = 0
FAIL = 0
PERSONAL_PROVIDER = "openai"
LOCAL_USER = "local"
GATEWAY_BASE_URL = "https://scholarseed.damo.alibaba.com/v1"
GATEWAY_MODEL_KEY = "qwen3.8-max"
SELF_CONFIGURED_KEY = "self-configured-gateway-key"
# 出厂种子与 `npm run config` 会把整张模板落盘: 这些空值是模板回显, 不是用户的选择。
UNDECLARED_TEMPLATE = {
    "provider": "",
    "base_url": "",
    "model_name": "",
    "small_model_name": "",
    "image_input": False,
    "context_window": 200000,
    "max_output_tokens": 32000,
    "headers": {},
}


def check(name: str, ok: bool, detail: str = "") -> None:
    """Print one deterministic contract assertion."""
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def write_builtin_config() -> None:
    """Install one harmless built-in configuration in the isolated SCHOLARSEED_HOME."""
    path = Path(TEST_HOME.name) / "config.json"
    path.write_text(
        json.dumps(
            {
                "provider": PERSONAL_PROVIDER,
                "base_url": "https://managed.example.test/v1",
                "api_key": "managed-test-key",
                "model_name": "managed-model",
            }
        ),
        encoding="utf-8",
    )


def write_config(values: dict[str, Any]) -> None:
    """Install one user-shaped configuration, exactly as it would sit on disk."""
    (Path(TEST_HOME.name) / "config.json").write_text(
        json.dumps(values, ensure_ascii=False), encoding="utf-8"
    )


def profile_values(*, models: tuple[str, ...] = ("personal-model",), **overrides: Any) -> dict:
    """Return a complete personal API profile without exposing it in output."""
    values = {
        "preview_name": "",
        "provider": PERSONAL_PROVIDER,
        "base_url": "https://personal.example.test/v1",
        "api_key": "personal-test-key",
        "selected_models": [{"id": model_id, "label": ""} for model_id in models],
        "small_model_name": "personal-small",
    }
    return {**values, **overrides}


def test_store_redaction_and_overlay() -> None:
    """The JSON file is owner-only while the API list has no secret."""
    store = ModelProfileStore()
    header_name = "x-endpoint-key"
    header_value = "personal-header-secret"
    profile = store.upsert(
        profile_values(
            headers={header_name: header_value},
            selected_models=[
                {"id": "personal-model", "label": "", "reasoning_efforts": ["low", "high"]}
            ],
        )
    )
    listed = store.list()
    check(
        "personal reasoning capabilities survive reopening",
        ModelProfileStore(store.path).profile(profile["id"])["selected_models"][0][
            "reasoning_efforts"
        ]
        == ["low", "high"],
    )
    raw = store.path.read_text(encoding="utf-8")
    check("profile list redacts api key", "personal-test-key" not in json.dumps(listed))
    check("profile list redacts custom header value", header_value not in json.dumps(listed))
    check(
        "the first selected model is the default preview name",
        profile["name"] == "personal-model" and profile["preview_name"] == "",
    )
    check("profile list exposes only custom header names", profile["header_names"] == [header_name])
    check("profile file retains user credential", "personal-test-key" in raw)
    check("profile file is owner-only", stat.S_IMODE(store.path.stat().st_mode) == 0o600)
    check("a newly saved connection is enabled", profile["enabled"] is True, str(profile))
    check(
        "the redacted projection drops the derived model_name field",
        "model_name" not in profile,
        str(sorted(profile)),
    )
    # 回滚兜底: 退回旧版本后, 旧代码读同一文件仍要能拿到一个可用模型。
    stored = json.loads(raw)["profiles"][profile["id"]]
    check(
        "the file keeps model_name derived from the first selected model",
        stored["model_name"] == stored["selected_models"][0]["id"] == "personal-model",
        str(stored.get("model_name")),
    )
    overlaid = apply_profile(
        {"model_name": "managed-model"}, profile["id"], store, model_id="personal-model"
    )
    check(
        "an explicitly keyed profile overlays next session config",
        overlaid["model_name"] == "personal-model"
        and overlaid["billing_mode"] == "personal"
        and overlaid["headers"] == {header_name: header_value},
    )
    renamed = store.upsert(
        profile_values(
            preview_name="Friendly endpoint",
            api_key="",
            headers={header_name: ""},
        ),
        profile["id"],
    )
    check(
        "empty update preserves existing key",
        "personal-test-key" in store.path.read_text(encoding="utf-8"),
    )
    check(
        "optional preview name overrides the model ID",
        renamed["name"] == "Friendly endpoint" and renamed["preview_name"] == "Friendly endpoint",
    )
    check(
        "redacted header value remains when its name is unchanged",
        header_value in store.path.read_text(encoding="utf-8"),
    )
    store.upsert(profile_values(api_key="", headers={}), profile["id"])
    check(
        "omitting a saved header removes it",
        header_value not in store.path.read_text(encoding="utf-8"),
    )


def test_header_only_openai_profile() -> None:
    """OpenAI-compatible endpoints can own auth entirely through a custom header."""
    store = ModelProfileStore()
    profile = store.upsert(
        profile_values(
            api_key="",
            models=("header-only-model",),
            headers={"x-api-key": "header-only-secret"},
        )
    )
    active_config = apply_profile(
        {"model_name": "managed-model"}, profile["id"], store, model_id="header-only-model"
    )
    check(
        "custom header permits a keyless OpenAI-compatible profile",
        active_config["model_name"] == "header-only-model" and not active_config["api_key"],
    )
    try:
        store.upsert(
            profile_values(api_key="", models=("header-only-model",), headers={}), profile["id"]
        )
    except ValueError:
        rejected_credential_removal = True
    else:
        rejected_credential_removal = False
    check(
        "keyless profile cannot remove its final authentication header", rejected_credential_removal
    )
    try:
        store.upsert(
            profile_values(
                provider="anthropic",
                api_key="",
                models=("header-only-anthropic",),
                headers={"x-api-key": "header-only-secret"},
            )
        )
    except ValueError:
        rejected_anthropic = True
    else:
        rejected_anthropic = False
    check("Anthropic profiles still require an API key", rejected_anthropic)
    try:
        store.upsert(profile_values(headers={"bad\nheader": "invalid"}))
    except ValueError:
        rejected_injection = True
    else:
        rejected_injection = False
    check("header line-break injection is rejected", rejected_injection)
    unselected = store.upsert(profile_values(models=()))
    check("a connected provider can have no selected models", unselected["selected_models"] == [])
    reopened = ModelProfileStore(store.path)
    check(
        "empty selection survives reopening without restoring a legacy model",
        reopened.profile(unselected["id"])["selected_models"] == [],
    )


def build_service(store: ModelProfileStore) -> tuple[Any, dict[str, str]]:
    """Return a ModelService bound to the isolated store plus its selection state."""
    selected = {"model": ""}
    settings = SimpleNamespace(
        runtime_executable=lambda: "codex",
        runtime_model=lambda: selected["model"],
        set_runtime_model=lambda value: selected.__setitem__("model", value),
    )
    service = ModelService(
        settings,  # type: ignore[arg-type]
        CompletionBridge("http://127.0.0.1:9999"),
        profiles=store,
    )
    return service, selected


def test_unsaved_model_api_probe() -> None:
    """Probing validates a candidate connection without persisting or activating it."""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    before = store.list()["profiles"]
    # 指向本机一个未监听端口: 断言探测真的发了请求并把失败归类, 且不出网。
    result = service.probe_profile(
        profile_values(base_url="http://127.0.0.1:9/v1", model_name="probe-model")
    )
    after = store.list()["profiles"]
    check("unreachable endpoint probe fails closed", result["ok"] is False, str(result))
    check("probe reports a latency measurement", "latency_ms" in result, str(result))
    check("probe classifies the transport failure", bool(result.get("error_class")), str(result))
    check(
        "probe never leaks the candidate credential", "personal-test-key" not in json.dumps(result)
    )
    check("probe does not write a model profile", before == after)
    try:
        service.probe_profile(profile_values(provider="anthropic"))
    except ValueError:
        refused_anthropic = True
    else:
        refused_anthropic = False
    check("probe refuses a provider without a translation leg", refused_anthropic)


def test_personal_profile_is_a_catalog_source() -> None:
    """One connection contributes one entry per selected model, gated by its switch."""
    store = ModelProfileStore()
    service, selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    first = store.upsert(
        profile_values(
            preview_name="Bailian",
            preset_id="dashscope",
            models=("catalog-model", "catalog-model-plus"),
        )
    )
    second = store.upsert(
        profile_values(
            preview_name="Kimi",
            preset_id="moonshot",
            base_url="https://second.example.test/v1",
            models=("second-model",),
        )
    )
    first_keys = [
        personal_model_key(first["id"], name) for name in ("catalog-model", "catalog-model-plus")
    ]
    second_key = personal_model_key(second["id"], "second-model")
    with patch(
        "service.chat.service.models.available_models",
        return_value=[{"key": "qwen3.8-max", "label": "Qwen", "billing": "api"}],
    ):
        view = asyncio.run(service.catalog())
        keys = [row["key"] for row in view["available_models"]]
        entries = {row["key"]: row for row in view["available_models"]}
        check(
            "each selected model of one connection becomes its own entry",
            all(key in keys for key in first_keys),
            str(keys),
        )
        check(
            "two enabled connections appear side by side",
            second_key in keys,
            str(keys),
        )
        check(
            "personal entries keep source and profile_id under a composite key",
            all(
                entries[key]["source"] == "personal" and entries[key]["profile_id"] == first["id"]
                for key in first_keys
            ),
            str([entries[key] for key in first_keys]),
        )
        check(
            "personal entry label names the vendor and the model, never a raw id",
            entries[first_keys[0]]["label"] == "Bailian · catalog-model",
            entries[first_keys[0]]["label"],
        )
        check(
            "personal entry does not claim unverified vision capability",
            all(entries[key]["image_input"] is False for key in first_keys),
        )
        check(
            "built-in models survive alongside the personal entries",
            "qwen3.8-max" in keys,
            str(keys),
        )
        check(
            "the catalogue no longer projects a single connection mode",
            "connection_mode" not in view and "active_profile_id" not in view,
            str(sorted(view)),
        )

        chosen = asyncio.run(service.select(first_keys[1], persist=True))
        check(
            "selecting a personal entry persists the composite key as the current model",
            chosen["current_model"] == first_keys[1] and selected["model"] == first_keys[1],
            str(chosen["current_model"]),
        )

        back_to_builtin = asyncio.run(service.select("qwen3.8-max", persist=True))
        enabled_after = {row["id"]: row["enabled"] for row in store.list()["profiles"]}
        check(
            "selecting a built-in model leaves every connection enabled as it was",
            back_to_builtin["current_model"] == "qwen3.8-max"
            and enabled_after == {first["id"]: True, second["id"]: True},
            str(enabled_after),
        )
        check("built-in selection is persisted", selected["model"] == "qwen3.8-max")

        store.set_enabled(first["id"], False)
        disabled_view = asyncio.run(service.catalog())
        remaining = [row["key"] for row in disabled_view["available_models"]]
        check(
            "disabling one connection removes only its models",
            not any(key in remaining for key in first_keys) and second_key in remaining,
            str(remaining),
        )


def test_official_personal_endpoint_uses_verified_vendor_capabilities() -> None:
    """An exact first-party endpoint is a verified coordinate; proxies remain unverified."""

    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    official = store.upsert(
        profile_values(
            preview_name="Bailian",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1/",
            models=("qwen3.8-max",),
        )
    )
    proxied = store.upsert(
        profile_values(
            preview_name="Proxy",
            base_url="https://proxy.example.test/v1",
            models=("qwen3.8-max",),
        )
    )
    service, _selected = build_service(store)
    rows = {row["key"]: row for row in asyncio.run(service.catalog())["available_models"]}
    official_row = rows[personal_model_key(official["id"], "qwen3.8-max")]
    proxy_row = rows[personal_model_key(proxied["id"], "qwen3.8-max")]
    check(
        "official endpoint exposes the verified Qwen thinking toggle",
        any(
            option.get("kind") == "toggle"
            and option.get("wire", {}).get("responses") == "enable_thinking"
            for option in official_row.get("reasoning_options") or ()
        ),
        str(official_row.get("reasoning_options")),
    )
    check(
        "official endpoint exposes verified model limits and modalities",
        official_row.get("max_output_tokens") == 131072 and official_row.get("image_input") is True,
        str(official_row),
    )
    official_connection = service.inference_connection(
        personal_model_key(official["id"], "qwen3.8-max"), user_id="local"
    )
    check(
        "official endpoint inference uses the same verified image capability as its catalog row",
        official_connection.get("image_input") is True,
        str(official_connection.get("image_input")),
    )
    check(
        "a proxy with the same model id does not inherit vendor capabilities",
        proxy_row.get("reasoning_options") is None and proxy_row.get("max_output_tokens") is None,
        str(proxy_row),
    )


def test_official_personal_endpoint_keeps_catalog_and_inference_modalities_aligned() -> None:
    """One trusted model coordinate must expose the same modalities at every gate."""

    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(
        profile_values(
            preview_name="Bailian",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            models=(GATEWAY_MODEL_KEY,),
        )
    )
    service, _selected = build_service(store)
    key = personal_model_key(profile["id"], GATEWAY_MODEL_KEY)
    row = next(
        item for item in asyncio.run(service.catalog())["available_models"] if item["key"] == key
    )
    connection = service.inference_connection(key, user_id=LOCAL_USER)
    check(
        "Bailian qwen3.8-max catalog declares image input",
        row.get("image_input") is True,
        str(row),
    )
    check(
        "one-shot inference uses the catalog image capability",
        connection.get("image_input") is row.get("image_input") is True,
        str({"catalog": row.get("image_input"), "inference": connection.get("image_input")}),
    )


def test_catalog_display_provenance_preserves_user_labels_and_model_identity() -> None:
    """The source branch supplies display evidence without changing the connection."""
    preset_id = "dashscope"
    preset_label = model_module.preset_provider_labels()[preset_id]
    cases = (
        ("preset", "", preset_id, preset_label, preset_id),
        ("trimmed", "  ", f" {preset_id} ", preset_label, preset_id),
        ("custom", "My endpoint", preset_id, "My endpoint", ""),
        ("same-name", preset_label, preset_id, preset_label, ""),
        ("unknown", "", "future-preset", "personal.example.test", ""),
        ("hostname", "", "", "personal.example.test", ""),
    )
    with tempfile.TemporaryDirectory() as folder:
        store = ModelProfileStore(Path(folder) / "profiles.json")
        for name, preview, preset, vendor, evidence in cases:
            store.upsert(
                profile_values(
                    preview_name=preview,
                    preset_id=preset,
                    selected_models=[{"id": name, "label": "User · model 中文"}],
                )
            )
        original = store.path.read_bytes()
        service, _selected = build_service(ModelProfileStore(store.path))
        rows = {
            row["model_id"]: row
            for row in asyncio.run(service.catalog())["available_models"]
            if row.get("source") == "personal"
        }
        for name, _preview, _preset, vendor, evidence in cases:
            row = rows[name]
            check(
                f"{name}: composed label stays canonical",
                row["label"] == f"{vendor} · User · model 中文",
            )
            check(
                f"{name}: raw model label retains delimiters",
                row["model_label"] == "User · model 中文",
            )
            check(f"{name}: vendor label stays canonical", row["provider_label"] == vendor)
            check(
                f"{name}: only an actual preset branch carries evidence",
                row.get("provider_preset_id", "") == evidence
                and (bool(evidence) or "provider_preset_id" not in row),
            )
            check(
                f"{name}: selection identity is unchanged",
                row["key"] == personal_model_key(row["profile_id"], name),
            )
            spec = service.session_spec(row["key"])
            check(
                f"{name}: answer freezes the catalog source and identity",
                spec.model_run is not None
                and spec.model_run.provider_preset_id == evidence
                and spec.model_run.provider_label == vendor
                and spec.model_run.provider_id == row["profile_id"]
                and spec.model_run.model_id == name,
            )
            check(
                f"{name}: display metadata never enters inference config",
                "provider_preset_id" not in spec.config
                and "model_label" not in spec.config
                and spec.config["model_name"] == name
                and spec.config["api_key"] == "personal-test-key",
            )
        check(
            "catalog and inference leave reopened profile bytes untouched",
            store.path.read_bytes() == original,
        )


def test_active_profile_never_routes_to_the_builtin_gateway() -> None:
    """Regression guard: the overlay must decide the whole route on its own.

    ``call_url`` outranks ``base_url`` when the session provider is built, and the
    product config carries the gateway's one. Inheriting it sent the user's own key to
    the built-in gateway while silently ignoring their endpoint. Providers are now
    Responses-only (``profile_wire_api``), so a personal connection derives no
    ``call_url`` at all — the route is ``base_url`` + wire protocol, and any inherited
    ``call_url`` must be dropped by the overlay.
    """
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("routed-model",)))
    gateway_config = {
        "provider": PERSONAL_PROVIDER,
        "base_url": "https://gateway.example.test/v1",
        "api_key": "gateway-key",
        "call_url": "https://gateway.example.test/v1/chat/completions",
        "base_url_env": "UNRELATED_BASE_URL_ENV",
        "api_key_env": "UNRELATED_API_KEY_ENV",
        "model_name": "gateway-model",
    }
    with patch.object(model_module, "load_builtin_work_config", return_value=gateway_config):
        spec = service.session_spec(personal_model_key(profile["id"], "routed-model"))
    endpoint = json.dumps(spec.codex_provider or {}) + json.dumps(spec.config)
    check(
        "session uses the personal endpoint",
        str(spec.config.get("base_url") or "").rstrip("/") == "https://personal.example.test/v1",
        str(spec.config.get("base_url")),
    )
    check(
        "inherited call_url is dropped so it can never outrank the personal base_url",
        "call_url" not in spec.config,
        str(spec.config.get("call_url")),
    )
    check(
        "gateway host never appears in the session connection",
        "gateway.example.test" not in endpoint,
    )
    check(
        "inherited env indirection is dropped",
        "base_url_env" not in spec.config and "api_key_env" not in spec.config,
        str(sorted(spec.config)),
    )
    check(
        "personal model name reaches the runtime",
        spec.config["model_name"] == "routed-model" and spec.billing == "api",
        f"{spec.config.get('model_name')} / {spec.billing}",
    )


def test_personal_profile_keeps_its_own_credential() -> None:
    """A signed-in ScholarSeed account must not replace a personal endpoint's API key."""

    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values())
    settings = SimpleNamespace(
        runtime_executable=lambda: "codex",
        runtime_model=lambda: "",
        set_runtime_model=lambda _value: None,
    )
    bridge = CompletionBridge("http://127.0.0.1:9999")
    service = ModelService(
        settings,  # type: ignore[arg-type]
        bridge,
        account_tokens=SimpleNamespace(current=lambda _user_id: "account-token"),
        profiles=store,
    )
    # 个人端点是 Responses-only、又不在生产 bridge 的 source_endpoints 里, 只有声明了思考
    # 深度的调用才真的上桥 —— 要断言桥上那条腿的凭据, 先得让它上桥。
    with patch.object(model_module, "load_builtin_work_config", return_value={}):
        service.session_spec(
            personal_model_key(profile["id"], "personal-model"),
            session_id="personal-session",
            user_id="signed-in-user",
            reasoning_effort="",
        )
    upstream = next(iter(bridge._upstreams.values()))
    check(
        "personal endpoint uses its configured API key while the user is signed in",
        upstream.bearer() == "personal-test-key",
    )
    check(
        "personal endpoint is not rebound to the ScholarSeed account token slot",
        upstream.owner_id == "" and service.rebind_owner("personal-session", "other-user") == 0,
    )
    store.upsert(profile_values(wire_api="responses"), profile["id"])
    with patch.object(model_module, "load_builtin_work_config", return_value={}):
        service.session_spec(
            personal_model_key(profile["id"], "personal-model"),
            session_id="personal-responses-session",
            user_id="signed-in-user",
            reasoning_effort="",
        )
    native = list(bridge._upstreams.values())[-1]
    check(
        "native Responses uses the same explicit default policy without changing credentials",
        native.wire_protocol.value == "responses"
        and native.reasoning_effort == ""
        and native.bearer() == "personal-test-key",
    )


def test_preset_providers_are_declared_and_registered() -> None:
    """每条预置端点都要字段齐全，并且已登记进外部网络依赖地图。"""
    rows = ModelService.providers()["providers"]
    check("preset table is not empty", bool(rows), str(rows))
    check(
        "every preset declares id/label/base_url/wire_api",
        all(
            row.get("id") and row.get("label") and row.get("base_url") and row.get("wire_api")
            for row in rows
        ),
        str(rows),
    )
    ids = [row["id"] for row in rows]
    check("preset ids are unique", len(ids) == len(set(ids)), str(ids))
    check(
        "preset wire_api values stay inside the protocol enum",
        {row["wire_api"] for row in rows} <= SUPPORTED_WIRE_APIS,
        str({row["wire_api"] for row in rows}),
    )
    check(
        "preset projection carries no credential field",
        all("api_key" not in row for row in rows),
        str(rows),
    )
    # Anthropic 没有 OpenAI 兼容面, 放一条选了就报错的预置项比不放更糟。
    check(
        "anthropic is not offered as a preset before its translation leg exists",
        not any("anthropic" in row["base_url"] for row in rows),
        str(ids),
    )
    network_map = Path(__file__).resolve().parents[3] / "wiki" / "architecture" / "network.md"
    registered = network_map.read_text(encoding="utf-8") if network_map.exists() else ""
    unregistered = [
        row["base_url"]
        for row in rows
        if urlparse(row["base_url"]).hostname
        and str(urlparse(row["base_url"]).hostname) not in registered
    ]
    check(
        "every preset host is registered in arch-network",
        bool(registered) and not unregistered,
        f"map={network_map} missing={unregistered}",
    )


def test_model_listing_does_not_persist() -> None:
    """拉取模型列表用的是候选连接，既不落盘也不要求已选定模型名。"""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    before = store.path.read_text(encoding="utf-8") if store.path.exists() else ""
    result = service.profile_models(
        {
            "provider": PERSONAL_PROVIDER,
            "wire_api": "chat_completions",
            # 拉列表发生在用户选模型**之前**, 所以这里必须允许空模型名。
            "model_name": "",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "listing-test-key",
        }
    )
    after = store.path.read_text(encoding="utf-8") if store.path.exists() else ""
    check("unreachable endpoint listing fails closed", result["ok"] is False, str(result))
    check("listing returns an empty candidate set on failure", result["models"] == [], str(result))
    check("listing does not write the profile store", before == after)
    check(
        "listing never echoes the candidate credential",
        "listing-test-key" not in json.dumps(result),
        str(result),
    )
    try:
        service.profile_models({"provider": "anthropic", "base_url": "https://x/v1"})
    except ValueError:
        refused = True
    else:
        refused = False
    check("listing refuses a provider without a translation leg", refused)


def test_connection_probe_uses_model_directory() -> None:
    """The editor tests connectivity without requiring or invoking a selected model."""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    saved = store.upsert(profile_values())
    before = store.path.read_bytes()
    requests: list[httpx.Request] = []
    status = 200

    def upstream(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method != "GET" or request.url.path != "/v1/models":
            return httpx.Response(400, json={"error": "unexpected inference request"})
        if status != 200:
            return httpx.Response(status, json={"error": "directory unavailable"})
        return httpx.Response(200, json={"data": [{"id": "available-model"}]})

    app = FastAPI()
    mount_setting_routes(app, models=service, settings=SimpleNamespace(), runtime=SimpleNamespace())

    async def probe(values: dict, profile_id: str = "") -> dict:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/serve/model-profiles/probe", json={**values, "profile_id": profile_id}
            )
        assert response.status_code == 200, response.text
        return response.json()

    real_client = httpx.Client
    with patch(
        "service.chat.service.probe.httpx.Client",
        side_effect=lambda **kwargs: real_client(transport=httpx.MockTransport(upstream), **kwargs),
    ):
        for wire_api in ("chat_completions", "responses"):
            for selected in ((), ("personal-model",)):
                result = asyncio.run(probe(profile_values(models=selected, wire_api=wire_api)))
                check(
                    f"{wire_api} probe with {selected} reads directory", result["ok"], str(result)
                )
        result = asyncio.run(probe(profile_values(models=(), api_key=""), saved["id"]))
        check("saved connection probe reuses credential", result["ok"], str(result))
        for status in (401, 404):
            result = asyncio.run(probe(profile_values(models=())))
            check(
                f"probe preserves directory HTTP {status} failure",
                not result["ok"] and result.get("error_class") == f"http_status_{status}",
                str(result),
            )
        check(
            "every probe is one authenticated GET with no inference body",
            len(requests) == 7
            and all(
                request.method == "GET"
                and str(request.url) == "https://personal.example.test/v1/models"
                and not request.content
                and request.headers.get("Authorization") == "Bearer personal-test-key"
                for request in requests
            ),
        )
    check("connection probes leave saved profiles unchanged", store.path.read_bytes() == before)
    store.delete(saved["id"])


def test_product_catalog_hides_concrete_subscription_models() -> None:
    """Native subscription models are not explicit product model connections."""
    qwen = {
        "key": "qwen3.8-max",
        "label": "Qwen 3.8 Max",
        "billing": "api",
        "source": "builtin",
    }
    concrete_subscription = {
        "key": "codex-concrete-model",
        "label": "Concrete Codex Model",
        "billing": "subscription",
        "source": "builtin",
    }
    with patch(
        "service.chat.service.models.available_models",
        return_value=[qwen, concrete_subscription],
    ):
        visible = ModelService._available({})
    check(
        "product model catalog contains only configured API models",
        [row["key"] for row in visible] == ["qwen3.8-max"],
        str(visible),
    )
    check(
        "neither automatic nor concrete native subscription models are offered",
        not any(row["billing"] == "subscription" for row in visible),
        str(visible),
    )


def test_builtin_models_greyed_out_when_signed_out() -> None:
    """未登录时内置网关模型置灰，不回落到 Codex 原生认证。"""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    gateway_catalog = [{"key": "qwen3.8-max", "label": "Qwen", "billing": "api"}]
    with (
        patch("service.chat.service.models.available_models", return_value=gateway_catalog),
        patch("service.chat.service.models._api_key", return_value=""),
    ):
        signed_out = asyncio.run(service.catalog(user_id="local"))
        qwen = next(row for row in signed_out["available_models"] if row["key"] == "qwen3.8-max")
        check("未登录时内置模型置灰", qwen.get("disabled") is True, str(qwen))
        check("置灰给出可读原因", bool(qwen.get("disabled_reason")), str(qwen))
        check(
            "置灰原因保留稳定本地化身份",
            qwen.get("disabled_reason_code") == "gateway_credential_required",
            str(qwen),
        )
        check(
            "置灰原始说明保持不变", qwen.get("disabled_reason") == "登录后可使用内置模型", str(qwen)
        )
        check(
            "未登录不生成 Codex 默认连接",
            signed_out["current_model"] != RETIRED_NATIVE_MODEL_KEY,
            str(signed_out["current_model"]),
        )

        signed_in = asyncio.run(service.catalog(user_id="u-real"))
        qwen_in = next(row for row in signed_in["available_models"] if row["key"] == "qwen3.8-max")
        check("登录后内置模型恢复可选", not qwen_in.get("disabled"), str(qwen_in))
        check("恢复可选时不携带置灰原因", not qwen_in.get("disabled_reason_code"), str(qwen_in))


def test_signed_out_default_auto_switches_to_first_available_model() -> None:
    """未登录且落盘默认指向置灰内置模型时，目录与执行面都自动切到第一个可用模型。

    用户已配置个人连接的场景：选择器（catalog.current_model）、会话执行
    （session_spec / selected_model_key）与一次性推理（inference_connection）
    必须解析到同一个可用键，且切换落盘为新的默认模型。
    """

    store = ModelProfileStore()
    service, selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("personal-model",)))
    personal_key = personal_model_key(profile["id"], "personal-model")
    selected["model"] = GATEWAY_MODEL_KEY
    gateway_catalog = [{"key": GATEWAY_MODEL_KEY, "label": "Qwen", "billing": "api"}]
    # 未登录形态必须来自磁盘配置与环境（与真实登出一致），不能 patch 掉 _api_key：
    # 执行面回落后的个人连接分支同样要经过它取回真实凭据。
    write_config({**UNDECLARED_TEMPLATE})
    with (
        patch("service.chat.service.models.available_models", return_value=gateway_catalog),
        patch.dict(os.environ, {"OPENAI_API_KEY": ""}),
    ):
        signed_out = asyncio.run(service.catalog(user_id=LOCAL_USER))
        check(
            "未登录目录把 current_model 切到第一个可用模型",
            signed_out["current_model"] == personal_key,
            str(signed_out["current_model"]),
        )
        check(
            "自动切换落盘为新的默认模型", selected["model"] == personal_key, str(selected["model"])
        )
        spec = service.session_spec(GATEWAY_MODEL_KEY, user_id=LOCAL_USER)
        check("会话执行从置灰内置键回落到可用模型", spec.key == personal_key, spec.key)
        check(
            "selected_model_key 同样回落",
            service.selected_model_key(GATEWAY_MODEL_KEY, user_id=LOCAL_USER) == personal_key,
        )
        connection = service.inference_connection(GATEWAY_MODEL_KEY, user_id=LOCAL_USER)
        check(
            "一次性推理回落到个人连接端点",
            connection["key"] == personal_key and "personal.example.test" in connection["endpoint"],
            str({key: connection.get(key) for key in ("key", "endpoint")}),
        )
        # 登录后（门禁不生效）默认选择不被自动切换触碰。
        selected["model"] = GATEWAY_MODEL_KEY
        signed_in = asyncio.run(service.catalog(user_id="u-real"))
        check(
            "登录态不触发自动切换",
            signed_in["current_model"] == GATEWAY_MODEL_KEY
            and selected["model"] == GATEWAY_MODEL_KEY,
            str(signed_in["current_model"]),
        )
    store.delete(profile["id"])
    write_builtin_config()


def test_signed_out_without_available_models_keeps_the_readable_error() -> None:
    """目录整体置灰（未登录且无个人连接）时不切换，执行面保留可读登录引导。"""

    store = ModelProfileStore()
    service, selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    selected["model"] = GATEWAY_MODEL_KEY
    gateway_catalog = [{"key": GATEWAY_MODEL_KEY, "label": "Qwen", "billing": "api"}]
    write_config({**UNDECLARED_TEMPLATE})
    with (
        patch("service.chat.service.models.available_models", return_value=gateway_catalog),
        patch.dict(os.environ, {"OPENAI_API_KEY": ""}),
    ):
        signed_out = asyncio.run(service.catalog(user_id=LOCAL_USER))
        check(
            "无可用模型时保留原默认键",
            signed_out["current_model"] == GATEWAY_MODEL_KEY
            and selected["model"] == GATEWAY_MODEL_KEY,
            str(signed_out["current_model"]),
        )
        try:
            service.session_spec(GATEWAY_MODEL_KEY, user_id=LOCAL_USER)
        except SessionModelUnavailableError as error:
            blocked = str(error)
        else:
            blocked = ""
        check("执行面仍给出可读登录引导", blocked == GATEWAY_LOGIN_REQUIRED_ERROR, blocked)
        try:
            service.inference_connection(GATEWAY_MODEL_KEY, user_id=LOCAL_USER)
        except SessionModelUnavailableError as error:
            refused = str(error)
        else:
            refused = ""
        check("一次性推理不放行无凭据的网关调用", bool(refused), refused)
    write_builtin_config()


class _DisconnectedSubscriptions:
    """订阅腿报告未连接：订阅模型的置灰原因不是网关门禁，不参与自动切换。"""

    def status(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        return {"state": "disconnected", "account_label": "", "billing": "subscription"}

    def sync_on_cooldown(self, owner_id: str, connection_id: str) -> bool:
        return True


def test_subscription_disabled_default_is_not_auto_switched() -> None:
    """订阅连接断开置灰的默认模型不被自动切换：那是用户要显式处理的连接状态。"""

    store = ModelProfileStore(shared_ownership=True)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    selected = {"model": ""}
    service = ModelService(
        SimpleNamespace(  # type: ignore[arg-type]
            runtime_executable=lambda: "codex",
            runtime_model=lambda: selected["model"],
            set_runtime_model=lambda value: selected.__setitem__("model", value),
        ),
        CompletionBridge("http://127.0.0.1:9999", shared_ownership=True),
        profiles=store,
        subscriptions=_DisconnectedSubscriptions(),  # type: ignore[arg-type]
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
    )
    oauth = store.upsert(
        {
            "authentication": "oauth",
            "oauth_provider": "chatgpt",
            "selected_models": [{"id": "gpt-5", "label": ""}],
        },
        owner_id=LOCAL_USER_ID,
        user_id="u-real",
    )
    personal = store.upsert(profile_values(models=("personal-model",)))
    subscription_key = personal_model_key(oauth["id"], "gpt-5")
    selected["model"] = subscription_key
    gateway_catalog = [{"key": GATEWAY_MODEL_KEY, "label": "Qwen", "billing": "api"}]
    personal_key = personal_model_key(personal["id"], "personal-model")
    with patch("service.chat.service.models.available_models", return_value=gateway_catalog):
        payload = asyncio.run(service.catalog(user_id="u-real"))
        rows = {row["key"]: row for row in payload["available_models"]}
        check(
            "目录里确实存在可用的个人连接回落",
            personal_key in rows and not rows[personal_key].get("disabled"),
            str(sorted(rows)),
        )
        check(
            "订阅置灰的默认键保持不变",
            payload["current_model"] == subscription_key and selected["model"] == subscription_key,
            str(payload["current_model"]),
        )
        row = rows[subscription_key]
        check(
            "置灰原因仍是订阅连接门禁",
            row.get("disabled_reason_code") == SUBSCRIPTION_CONNECTION_REQUIRED_CODE,
            str(row),
        )
    store.delete(personal["id"])
    store.delete(oauth["id"])


class _RecordingSubscriptions:
    """记下订阅腿被问到的归属身份 —— 用来证明它与内置门禁腿喂的不是同一个值。"""

    def __init__(self) -> None:
        self.owners: list[str] = []

    def status(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.owners.append(owner_id)
        return {"state": "connected", "account_label": "", "billing": "subscription"}

    async def models(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.owners.append(owner_id)
        return {"models": []}

    def sync_on_cooldown(self, owner_id: str, connection_id: str) -> bool:
        return False

    async def sync_directory(self, owner_id: str, connection_id: str) -> dict[str, Any]:
        self.owners.append(owner_id)
        return {"models": []}


def test_machine_axis_splits_gateway_gate_and_personal_connection_identities() -> None:
    """machine 轴下两个身份各喂各的: 真实账号给内置门禁, 归属身份给个人连接。

    把整条路由换成归属身份会让内置模型即使登录也永久置灰; 完全不拆则登出后自配的订阅
    连接从菜单消失。这条同时钉住两个方向。
    """

    store = ModelProfileStore(shared_ownership=True)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    subscriptions = _RecordingSubscriptions()
    service = ModelService(
        SimpleNamespace(  # type: ignore[arg-type]
            runtime_executable=lambda: "codex",
            runtime_model=lambda: "",
            set_runtime_model=lambda _value: None,
        ),
        CompletionBridge("http://127.0.0.1:9999", shared_ownership=True),
        account_tokens=SimpleNamespace(current=lambda _user_id: "account-token"),
        profiles=store,
        subscriptions=subscriptions,  # type: ignore[arg-type]
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
    )
    # 登录态下建立的连接: owner 戳是真实账号, 而归属身份是机器级常量。
    profile = store.upsert(
        {
            "authentication": "oauth",
            "oauth_provider": "chatgpt",
            "selected_models": [{"id": "gpt-5", "label": ""}],
        },
        owner_id=LOCAL_USER_ID,
        user_id="u-real",
    )
    subscription_key = personal_model_key(profile["id"], "gpt-5")
    gateway_catalog = [{"key": GATEWAY_MODEL_KEY, "label": "Qwen", "billing": "api"}]
    with (
        patch("service.chat.service.models.available_models", return_value=gateway_catalog),
        patch("service.chat.service.models._api_key", return_value=""),
    ):
        signed_out = asyncio.run(service.catalog(user_id=LOCAL_USER_ID))
        signed_in = asyncio.run(service.catalog(user_id="u-real"))

    def rows(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {row["key"]: row for row in payload["available_models"]}

    out, back = rows(signed_out), rows(signed_in)
    check(
        "登出后自配订阅连接仍在目录里且未置灰",
        subscription_key in out and not out[subscription_key].get("disabled"),
        str(sorted(out)),
    )
    check(
        "登出后内置网关模型仍按真实账号置灰",
        out[GATEWAY_MODEL_KEY].get("disabled") is True,
        str(out.get(GATEWAY_MODEL_KEY)),
    )
    check(
        "登录后自配订阅连接不受影响",
        subscription_key in back and not back[subscription_key].get("disabled"),
        str(sorted(back)),
    )
    check(
        "登录后内置网关模型恢复可选（没被归属身份污染）",
        not back[GATEWAY_MODEL_KEY].get("disabled"),
        str(back.get(GATEWAY_MODEL_KEY)),
    )
    check(
        "订阅腿只被喂归属身份, 从不被喂真实账号",
        bool(subscriptions.owners) and set(subscriptions.owners) == {LOCAL_USER_ID},
        str(subscriptions.owners),
    )


def test_declared_empty_legacy_connection_uses_product_gateway() -> None:
    """Only a persisted all-empty connection restores the product model."""

    empty_legacy = {
        "provider": "",
        "base_url": "",
        "api_key": "",
        "model_name": "",
        "headers": {},
    }
    effective = converge_gateway_model_config(empty_legacy)
    check(
        "empty legacy connection restores the visible product model",
        effective["base_url"] == GATEWAY_BASE_URL,
        str(effective),
    )
    check(
        "missing connection remains missing instead of becoming a product declaration",
        converge_gateway_model_config({}) == {},
    )


def test_credential_fields_never_erase_the_builtin_catalog() -> None:
    """凭据不是连接身份: 填 api_key 或自定义 header 不得把内置目录抹空。

    出厂种子与 ``npm run config`` 都会把整张模板以空值落盘。判定内置目录时若把凭据也算作
    连接声明, 用户一填 api_key 或一个自定义 header, 内置目录就整体塌空 —— 症状是模型
    菜单一个都不剩, 开会话直接报 "selected ScholarSeed model is unavailable"。
    """

    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    shapes = (
        ("api_key", {"api_key": SELF_CONFIGURED_KEY}),
        ("headers", {"headers": {"x-tenant": "self-hosted"}}),
    )
    for label, extra in shapes:
        write_config({**UNDECLARED_TEMPLATE, **extra})
        service, _selected = build_service(store)
        catalog = asyncio.run(service.catalog(user_id=LOCAL_USER))
        keys = [str(row.get("key")) for row in catalog["available_models"]]
        # 意图是「凭据不得抹空内置目录」: 与产品可见集合比对, 不钉死单个模型。
        check(
            f"填了 {label} 后内置目录仍在",
            set(keys) == set(GATEWAY_VISIBLE_MODEL_KEYS),
            str(catalog["reason"]) or str(keys),
        )
        check(
            f"填了 {label} 后当前模型仍可解析",
            catalog["current_model"] == DEFAULT_GATEWAY_MODEL_KEY,
            str(catalog["current_model"]),
        )
    write_builtin_config()


def test_builtin_lane_credential_comes_from_env_not_config() -> None:
    """顶层 api_key 退役后, 内置 lane 的自配凭据形态是环境变量。

    旧场景: 用户在 config 顶层配 key, 收敛不得丢弃它 (曾据此把自建网关用户判成
    无凭据而置灰)。退役裁决后连接凭据不再走 config.json: 顶层残留 key 一律忽略,
    ``_api_key`` 按网关派生的 openai provider 回退 ``OPENAI_API_KEY``, 置灰门随之。
    """

    write_config(
        {**UNDECLARED_TEMPLATE, "base_url": GATEWAY_BASE_URL, "api_key": SELF_CONFIGURED_KEY}
    )
    effective = load_config_values()
    check(
        "顶层残留 api_key 被忽略",
        "api_key" not in effective,
        str(effective.get("api_key")),
    )
    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    service, _selected = build_service(store)
    with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
        catalog = asyncio.run(service.catalog(user_id=LOCAL_USER))
        row = next(r for r in catalog["available_models"] if r["key"] == GATEWAY_MODEL_KEY)
        check("无账号且无 env 凭据时内置模型置灰", row.get("disabled") is True, str(row))
    with patch.dict(os.environ, {"OPENAI_API_KEY": SELF_CONFIGURED_KEY}):
        catalog = asyncio.run(service.catalog(user_id=LOCAL_USER))
        row = next(r for r in catalog["available_models"] if r["key"] == GATEWAY_MODEL_KEY)
        check("env 凭据下内置模型不置灰", not row.get("disabled"), str(row))
        spec = service.session_spec(session_id="self-configured", user_id=LOCAL_USER)
        check(
            "会话按 env 拿到自配 key",
            model_module._api_key(spec.config) == SELF_CONFIGURED_KEY,
        )
    check(
        "会话模型是内置可见模型",
        spec.model_name == DEFAULT_GATEWAY_MODEL_KEY,
        str(spec.model_name),
    )
    check("会话端点仍是内置网关", spec.config.get("base_url") == GATEWAY_BASE_URL)
    write_builtin_config()


def test_product_default_survives_an_undeclared_template_field() -> None:
    """模板回显的空值不得盖掉产品默认。

    盘上的 ``base_url: ""`` 不是用户的选择, 只是整张模板被落盘的回显。让它覆盖
    ``default.json`` 的真实默认值, 产品默认就永远到不了已有 config.json 的机器 ——
    首启动之后再修种子也无效, 而 ``npm run all`` 还会一遍遍把空值写回去。
    """

    write_config(dict(UNDECLARED_TEMPLATE))
    effective = load_config_values()
    check(
        "空 base_url 采纳产品默认",
        effective.get("base_url") == GATEWAY_BASE_URL,
        str(effective.get("base_url")),
    )
    check(
        "空 model_name 收敛到当前可见模型",
        effective.get("model_name") == DEFAULT_GATEWAY_MODEL_KEY,
        str(effective.get("model_name")),
    )
    write_builtin_config()


def test_a_retired_top_level_connection_declaration_is_ignored() -> None:
    """顶层外部连接声明已退役: config.json 不再是连接的门。

    历史契约 (proposal 51 §9) 是「用户声明的自有端点不得被产品默认掺进去」; 退役
    裁决后方向反转 —— 顶层连接字段 (provider/base_url/api_key/call_url/*_env/headers)
    一律忽略, 内置 lane 恒生效; 自有端点只走设置页「模型服务配置」的个人连接
    (``apply_profile`` 唯一门, 由本套件个人连接场景覆盖)。
    """

    own = {
        # provider 特意不用 "openai": 网关派生值就是 openai, 撞值证明不了「被忽略」。
        "provider": "anthropic",
        "base_url": "https://self-hosted.example.test/v1",
        "api_key": "own-endpoint-key",
        "model_name": "own-model",
    }
    write_config(dict(own))
    effective = load_config_values()
    check(
        "顶层 provider/base_url/api_key 被忽略",
        effective.get("provider") != "anthropic"
        and effective.get("base_url") == GATEWAY_BASE_URL
        and "api_key" not in effective,
        f"{effective.get('provider')} / {effective.get('base_url')} / {effective.get('api_key')}",
    )
    check("生效配置判为内置网关", _is_deeprd_gateway(effective))
    check(
        "执行面收敛到内置目录提供的模型",
        effective.get("model_name") == DEFAULT_GATEWAY_MODEL_KEY,
        str(effective.get("model_name")),
    )
    check(
        "自建端点不出现在生效配置里",
        "self-hosted.example.test" not in json.dumps(effective),
    )
    write_builtin_config()


def test_composite_key_round_trips_a_colon_bearing_model_id() -> None:
    """A model id may contain the separator; the split must keep it whole."""
    profile_id = "personal-0123456789abcdef0123456789abcdef"
    for model_id in ("gpt-4o", "org/exact-model:version", "a:b:c"):
        key = personal_model_key(profile_id, model_id)
        check(
            f"composite key round-trips {model_id!r}",
            parse_personal_model_key(key) == (profile_id, model_id),
            str(parse_personal_model_key(key)),
        )
    check(
        "a built-in key is never read as a personal one",
        parse_personal_model_key("qwen3.8-max") == ("", ""),
    )
    check(
        "a profile id without a model segment is not a personal model key",
        parse_personal_model_key(profile_id) == ("", ""),
    )


def test_legacy_single_activation_document_migrates_conservatively() -> None:
    """Reading a pre-multi-model file folds its model and keeps unused connections off."""
    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    was_active = "personal-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    was_idle = "personal-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    store.path.write_text(
        json.dumps(
            {
                "active_profile_id": was_active,
                "profiles": {
                    was_active: {
                        "provider": PERSONAL_PROVIDER,
                        "base_url": "https://legacy-active.example.test/v1",
                        "api_key": "legacy-active-key",
                        "model_name": "legacy-active-model",
                    },
                    was_idle: {
                        "provider": PERSONAL_PROVIDER,
                        "base_url": "https://legacy-idle.example.test/v1",
                        "api_key": "legacy-idle-key",
                        "model_name": "legacy-idle-model",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    profiles = {row["id"]: row for row in store.list()["profiles"]}
    check(
        "the connection that was in use stays enabled",
        profiles[was_active]["enabled"] is True,
        str(profiles[was_active]),
    )
    check(
        "a connection that was never active stays off until the user opts in",
        profiles[was_idle]["enabled"] is False,
        str(profiles[was_idle]),
    )
    check(
        "the legacy single model folds into a one-entry selection",
        profiles[was_active]["selected_models"] == [{"id": "legacy-active-model", "label": ""}],
        str(profiles[was_active]["selected_models"]),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_selection_range_never_reaches_the_runtime_config() -> None:
    """``selected_models`` is a product-level range, not a connection parameter."""
    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("isolated-model", "isolated-model-2")))
    # ``models`` in a config is the per-model override table; a same-named profile field
    # would have overwritten it wholesale through the overlay.
    overrides = {"managed-model": {"context_window": 12345}}
    resolved = apply_profile(
        {"model_name": "managed-model", "models": overrides},
        profile["id"],
        store,
        model_id="isolated-model-2",
    )
    check(
        "the per-model override table survives the overlay",
        resolved["models"] == overrides,
        str(resolved.get("models")),
    )
    check(
        "the selection range does not leak into the runtime config",
        not {"selected_models", "enabled", "preset_id"} & set(resolved),
        str(sorted(resolved)),
    )
    check(
        "the explicitly requested model decides model_name",
        resolved["model_name"] == "isolated-model-2",
        str(resolved.get("model_name")),
    )
    check(
        "a connection-level small model still overlays",
        resolved["small_model_name"] == "personal-small",
        str(resolved.get("small_model_name")),
    )
    try:
        apply_profile({}, profile["id"], store, model_id="never-selected")
    except ValueError:
        refused_unselected = True
    else:
        refused_unselected = False
    check("an unselected model is refused rather than silently replaced", refused_unselected)
    try:
        apply_profile({}, profile["id"], store)
    except ValueError:
        refused_empty = True
    else:
        refused_empty = False
    check("an overlay without an explicit model is refused", refused_empty)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_personal_connection_does_not_reshape_the_builtin_catalogue() -> None:
    """内置模型枚举必须与个人连接无关。

    目录来源按 ``base_url`` 判定是否内置网关, 所以任何把个人连接隐式叠进生效配置的
    做法都会让「配了自己的端点, 内置模型列表变了」。
    """
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    store.upsert(profile_values(models=("shadowing-model",)))
    seen_base_urls: list[str] = []

    def record(config: Any = None) -> list[dict[str, Any]]:
        seen_base_urls.append(str((config or {}).get("base_url") or ""))
        return [{"key": "qwen3.8-max", "label": "Qwen", "billing": "api"}]

    with patch("service.chat.service.models.available_models", side_effect=record):
        view = asyncio.run(service.catalog())
    check(
        "the built-in catalogue is resolved from the pinned built-in endpoint",
        seen_base_urls == [GATEWAY_BASE_URL],
        str(seen_base_urls),
    )
    check(
        "the built-in entry is untouched by the personal connection",
        "qwen3.8-max" in {row["key"] for row in view["available_models"]},
        str([row["key"] for row in view["available_models"]]),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_inference_uses_selected_personal_model() -> None:
    store = ModelProfileStore()
    profile = store.upsert(
        profile_values(
            models=("inference-first", "inference-second"), image_input=True, pdf_input=True
        )
    )
    service, _selected = build_service(store)
    key = personal_model_key(profile["id"], "inference-second")
    connection = service.inference_connection(key, user_id="local")
    check(
        "PDF inference resolves a composite personal selection",
        connection["model"] == "inference-second",
    )
    check(
        "PDF inference preserves declared input capabilities",
        connection["image_input"] and connection["pdf_input"],
    )
    check(
        "PDF inference uses the personal credential",
        connection["headers"].get("Authorization") == "Bearer personal-test-key",
    )


def test_inference_sends_turn_and_session_metering_headers() -> None:
    """直连模型路径的计量头：轮头与会话头并存（proposal 70 §5.9）。

    顶层连接字段退役后, 内置 lane 的凭据走环境变量回退 (``_api_key`` 按网关派生的
    openai provider 取 ``OPENAI_API_KEY``), 选择键用网关目录条目 —— "current-config"
    合成项只属于外部连接配置, 内置 lane 不再生成。
    """
    store = ModelProfileStore()
    service, _selected = build_service(store)
    with patch.dict(os.environ, {"OPENAI_API_KEY": "managed-test-key"}):
        connection = service.inference_connection(
            GATEWAY_MODEL_KEY, user_id="local", invocation_id="invocation-1"
        )
    headers = connection["headers"]
    check(
        "一次 invocation 就是一轮：轮头与会话头同值，但仍是两个头",
        headers.get(CONV_TURN_ID_HEADER) == "invocation-1"
        and headers.get(CONV_MESSAGE_ID_HEADER) == "invocation-1",
        str(sorted(headers)),
    )
    check(
        "计量头不动凭据位",
        headers.get("Authorization") == "Bearer managed-test-key",
        str(sorted(headers)),
    )


def test_connection_validation_precedes_persistence() -> None:
    """Failed admission never mutates saved credentials, selection or enablement."""
    store = ModelProfileStore(Path(TEST_HOME.name) / "validation.json")
    service, _selected = build_service(store)
    accepted = {"ok": True, "message": "connected"}
    rejected = {"ok": False, "message": "invalid credential"}
    with patch.object(model_module, "probe_personal_connection", return_value=rejected):
        try:
            asyncio.run(service.save_profile(profile_values()))
        except ValueError:
            pass
        else:
            check("invalid new connection is rejected", False)
        check("invalid creation never writes a profile file", not store.path.exists())

    with patch.object(model_module, "probe_personal_connection", return_value=accepted):
        saved = asyncio.run(service.save_profile(profile_values()))["profile"]
    check("validated creation is enabled", saved["enabled"])
    original = store.path.read_bytes()
    with patch.object(model_module, "probe_personal_connection", return_value=rejected):
        try:
            asyncio.run(service.save_profile(profile_values(api_key="invalid"), saved["id"]))
        except ValueError:
            pass
        else:
            check("invalid update is rejected", False)
        check("failed update leaves saved bytes unchanged", store.path.read_bytes() == original)
        asyncio.run(service.set_profile_enabled(saved["id"], False))
        stopped = store.path.read_bytes()
        try:
            asyncio.run(service.set_profile_enabled(saved["id"], True))
        except ValueError:
            pass
        else:
            check("invalid re-enable is rejected", False)
        check(
            "failed re-enable keeps stopped configuration intact",
            store.path.read_bytes() == stopped,
        )

    with patch.object(model_module, "probe_personal_connection", return_value=accepted) as probe:
        updated = asyncio.run(service.save_profile(profile_values(api_key=""), saved["id"]))
        check(
            "saving a stopped connection preserves disabled state",
            not updated["profile"]["enabled"],
        )
        check(
            "blank key probes the saved credential",
            probe.call_args.args[0]["api_key"] == "personal-test-key",
        )
        asyncio.run(service.set_profile_enabled(saved["id"], True))
        check("successful re-enable validates again", probe.call_count == 2)
    with patch.object(model_module, "list_upstream_models", return_value=accepted) as directory:
        unselected = asyncio.run(service.save_profile(profile_values(models=())))
        check(
            "empty selection validates the directory without selecting models",
            directory.call_count == 1 and unselected["profile"]["selected_models"] == [],
        )


def _stored_hidden_flags(store: ModelProfileStore, profile_id: str) -> dict[str, bool]:
    """Read the selection back from disk so persistence is asserted from the file, not memory."""
    document = json.loads(Path(store.path).read_text(encoding="utf-8"))
    return {
        str(row["id"]): bool(row.get(MODEL_HIDDEN_KEY))
        for row in document["profiles"][profile_id]["selected_models"]
    }


def _offered_keys(view: dict[str, Any], field: str) -> set[str]:
    return {str(row["key"]) for row in view[field]}


def test_hidden_model_leaves_the_catalog_and_stays_recoverable() -> None:
    """「关闭显示」必须是服务端持久化状态: 对话框选不到, 管理页仍能恢复。

    此前这个开关只写 renderer 内存 —— 任何一次目录重取都整体覆盖 catalog.models 把模型放回
    对话框, 而当前选中的模型还被一个常驻 effect 无条件豁免, 结果根本关不掉。
    """
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("kept-model", "hidden-model")))
    profile_id = str(profile["id"])
    hidden_key = personal_model_key(profile_id, "hidden-model")
    kept_key = personal_model_key(profile_id, "kept-model")

    before = asyncio.run(service.catalog())
    check(
        "both selected models start out selectable",
        {hidden_key, kept_key} <= _offered_keys(before, "available_models"),
        str(sorted(_offered_keys(before, "available_models"))),
    )
    check("nothing is hidden before the user asks", before["hidden_models"] == [])

    hidden = asyncio.run(service.set_model_hidden(profile_id, "hidden-model", True))
    check(
        "the hidden model leaves the selector catalogue",
        hidden_key not in _offered_keys(hidden, "available_models"),
        str(sorted(_offered_keys(hidden, "available_models"))),
    )
    check(
        "a sibling model on the same connection stays selectable",
        kept_key in _offered_keys(hidden, "available_models"),
    )
    check(
        "model management still lists it for restore",
        _offered_keys(hidden, "hidden_models") == {hidden_key},
        str(sorted(_offered_keys(hidden, "hidden_models"))),
    )
    check(
        "both partitions come from one projection, so labels cannot drift",
        [row for row in hidden["hidden_models"] if row["key"] == hidden_key][0]["label"]
        == [row for row in before["available_models"] if row["key"] == hidden_key][0]["label"],
    )

    # 换一个库存实例重读: 状态必须活过一次完整加载, 否则重启就把模型放回对话框。
    reloaded = asyncio.run(build_service(ModelProfileStore())[0].catalog())
    check(
        "hiding survives a full store reload",
        hidden_key not in _offered_keys(reloaded, "available_models")
        and _offered_keys(reloaded, "hidden_models") == {hidden_key},
        str(sorted(_offered_keys(reloaded, "available_models"))),
    )
    check(
        "only the hidden model carries the persisted flag",
        _stored_hidden_flags(store, profile_id) == {"kept-model": False, "hidden-model": True},
        str(_stored_hidden_flags(store, profile_id)),
    )

    restored = asyncio.run(service.set_model_hidden(profile_id, "hidden-model", False))
    check(
        "restoring puts the model back into the selector",
        hidden_key in _offered_keys(restored, "available_models")
        and restored["hidden_models"] == [],
        str(sorted(_offered_keys(restored, "available_models"))),
    )
    check(
        "restoring clears the flag on disk instead of writing a false",
        _stored_hidden_flags(store, profile_id) == {"kept-model": False, "hidden-model": False},
        str(_stored_hidden_flags(store, profile_id)),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_connection_save_round_trips_the_hidden_flag() -> None:
    """保存连接会重交全部已勾选模型, 隐藏标记必须随之往返。

    判据分两层, 少一层都会漏: HTTP 请求模型默认丢弃未声明字段, 库存读取又按白名单重建条目。
    任一层漏掉 ``hidden``, 用户随便编辑一次连接就会把自己关掉的模型放回对话框。
    """
    declared = PersonalApiRequest(
        selected_models=[
            {"id": "kept-model", "label": ""},
            {"id": "hidden-model", "label": "", MODEL_HIDDEN_KEY: True},
        ]
    )
    check(
        "the request schema keeps a declared hidden flag",
        [row.hidden for row in declared.selected_models] == [False, True],
        str([row.hidden for row in declared.selected_models]),
    )
    submitted = declared.model_dump()["selected_models"]
    check(
        "the request payload forwards the flag to the store",
        [bool(row.get(MODEL_HIDDEN_KEY)) for row in submitted] == [False, True],
        str(submitted),
    )

    store = ModelProfileStore()
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    store.upsert(profile_values(selected_models=submitted))
    service, _selected = build_service(store)
    profile_id = str(store.list()["profiles"][0]["id"])
    offered = _offered_keys(asyncio.run(service.catalog()), "available_models")
    check(
        "a flag submitted through the save path still hides the model",
        personal_model_key(profile_id, "hidden-model") not in offered
        and personal_model_key(profile_id, "kept-model") in offered,
        str(sorted(offered)),
    )
    check(
        "the connection editor reads the flag back, so its next save cannot drop it",
        _stored_hidden_flags(store, profile_id) == {"kept-model": False, "hidden-model": True},
        str(_stored_hidden_flags(store, profile_id)),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_model_visibility_rejects_unknown_targets() -> None:
    """未知连接与未勾选的模型都必须显式拒绝, 不能静默写成一条永远读不回来的标记。"""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("kept-model",)))
    profile_id = str(profile["id"])
    for target, model_id in ((profile_id, "never-selected"), ("personal-missing", "kept-model")):
        try:
            asyncio.run(service.set_model_hidden(target, model_id, True))
        except UnknownProfileError:
            refused = True
        else:
            refused = False
        check(f"hiding {model_id!r} on {target!r} is refused as not found", refused)
    view = asyncio.run(service.catalog())
    check(
        "a refused toggle leaves the model selectable and nothing hidden",
        personal_model_key(profile_id, "kept-model") in _offered_keys(view, "available_models")
        and view["hidden_models"] == [],
        str(sorted(_offered_keys(view, "available_models"))),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def test_model_visibility_route_hides_and_restores() -> None:
    """路由层判据: 端点真的挂上、没被同前缀路由遮蔽, 且未知目标映射成 404 而不是 422。"""
    store = ModelProfileStore()
    service, _selected = build_service(store)
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])
    profile = store.upsert(profile_values(models=("kept-model", "hidden-model")))
    profile_id = str(profile["id"])

    app = FastAPI()
    app.state.auth_enabled = False

    @app.middleware("http")
    async def identity(request: Any, call_next: Any) -> Any:
        request.state.user_id = LOCAL_USER
        return await call_next(request)

    mount_setting_routes(app, models=service, settings=SimpleNamespace(), runtime=SimpleNamespace())
    url = f"/api/serve/model-profiles/{profile_id}/models/visibility"

    async def call() -> tuple[int, dict[str, Any], int]:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            hidden = await client.post(url, json={"model_id": "hidden-model", "hidden": True})
            missing = await client.post(url, json={"model_id": "never-selected", "hidden": True})
            restored = await client.post(url, json={"model_id": "hidden-model", "hidden": False})
        assert hidden.status_code == 200, hidden.text
        assert restored.status_code == 200, restored.text
        return (
            hidden.status_code,
            hidden.json(),
            missing.status_code,
        )

    _status, body, missing_status = asyncio.run(call())
    hidden_key = personal_model_key(profile_id, "hidden-model")
    check(
        "the route answers with a catalogue the selector can use",
        "available_models" in body and "hidden_models" in body,
        str(sorted(body)),
    )
    check(
        "the hidden model is gone from the selector payload",
        hidden_key not in _offered_keys(body, "available_models"),
        str(sorted(_offered_keys(body, "available_models"))),
    )
    check(
        "the same payload still lists it for management",
        _offered_keys(body, "hidden_models") == {hidden_key},
        str(sorted(_offered_keys(body, "hidden_models"))),
    )
    check("an unknown model is a 404, not a 422", missing_status == 404, str(missing_status))
    after = asyncio.run(service.catalog())
    check(
        "the route's last call really restored the model",
        hidden_key in _offered_keys(after, "available_models") and after["hidden_models"] == [],
        str(sorted(_offered_keys(after, "available_models"))),
    )
    for existing in store.list()["profiles"]:
        store.delete(existing["id"])


def main() -> int:
    print("file-backed personal API profiles contract")
    write_builtin_config()
    test_connection_validation_precedes_persistence()
    test_store_redaction_and_overlay()
    test_header_only_openai_profile()
    test_inference_uses_selected_personal_model()
    test_inference_sends_turn_and_session_metering_headers()
    test_unsaved_model_api_probe()
    test_connection_probe_uses_model_directory()
    test_personal_profile_is_a_catalog_source()
    test_official_personal_endpoint_uses_verified_vendor_capabilities()
    test_official_personal_endpoint_keeps_catalog_and_inference_modalities_aligned()
    test_catalog_display_provenance_preserves_user_labels_and_model_identity()
    test_hidden_model_leaves_the_catalog_and_stays_recoverable()
    test_connection_save_round_trips_the_hidden_flag()
    test_model_visibility_rejects_unknown_targets()
    test_model_visibility_route_hides_and_restores()
    test_active_profile_never_routes_to_the_builtin_gateway()
    test_personal_profile_keeps_its_own_credential()
    test_preset_providers_are_declared_and_registered()
    test_model_listing_does_not_persist()
    test_product_catalog_hides_concrete_subscription_models()
    test_builtin_models_greyed_out_when_signed_out()
    test_signed_out_default_auto_switches_to_first_available_model()
    test_signed_out_without_available_models_keeps_the_readable_error()
    test_subscription_disabled_default_is_not_auto_switched()
    test_machine_axis_splits_gateway_gate_and_personal_connection_identities()
    test_declared_empty_legacy_connection_uses_product_gateway()
    test_credential_fields_never_erase_the_builtin_catalog()
    test_builtin_lane_credential_comes_from_env_not_config()
    test_product_default_survives_an_undeclared_template_field()
    test_a_retired_top_level_connection_declaration_is_ignored()
    test_composite_key_round_trips_a_colon_bearing_model_id()
    test_legacy_single_activation_document_migrates_conservatively()
    test_selection_range_never_reaches_the_runtime_config()
    test_personal_connection_does_not_reshape_the_builtin_catalogue()
    print(f"passed={PASS} failed={FAIL}")
    TEST_HOME.cleanup()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
