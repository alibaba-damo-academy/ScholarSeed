"""Contract for declared model capabilities (proposal 78 P1).

四组判据，每组各对一个不变量或一条 §10 P1 出口判据：

- 随包声明的加载期硬校验 —— 不自洽就在导入期炸，不带着猜测跑产品链路；
- 解析只做精确匹配（I1）+ 未声明即收敛且留痕（I2）；
- 个人车道只认用户自己的声明（I3），厂商口径仅作预填提示；
- 声明与 runtime 生效值的闭环（比对、去重、事件投影）。

# 测试隔离写法: 先设 SCHOLARSEED_HOME, 再 import 持有路径的首方模块。
# pylint: disable=wrong-import-position
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

TEST_HOME = tempfile.TemporaryDirectory()
os.environ["SCHOLARSEED_HOME"] = TEST_HOME.name

from scholarseed_codex.session import (  # noqa: E402
    _same_model_connection,
    _same_thread_preferences,
    capability_resolution,
)
from scholarseed_runtime.contract import (  # noqa: E402
    DeliveryClass,
    ModelIntent,
    ModelThinking,
    ModelTransport,
    ModelWireProtocol,
    RuntimeEvent,
    RuntimeEventKind,
)
from service.capabilities.service.skills import SkillCatalog  # noqa: E402
from service.chat.constants import PRODUCT_EVENT_MODEL_CAPABILITY_RESOLUTION  # noqa: E402
from service.chat.persistence.artifacts import SessionArtifactStore  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.runtime.evidence import SessionTrace  # noqa: E402
from service.chat.runtime.live import LiveSession  # noqa: E402
from service.chat.service.models import ModelService, _runtime_capabilities  # noqa: E402
from service.inference.reasoning import (  # noqa: E402
    MINIMUM_APPLIED,
    MINIMUM_CLAMPED,
    NO_REASONING_FORM,
    THINKING_FIXED,
    default_effort,
    effort_parameters,
    fixed_on,
    minimum_effort,
    minimum_parameters,
    option_wire,
    require_declared_effort,
)
from service.inference.transport import ENCODERS, thinking_for  # noqa: E402
from service.settings import catalog as catalog_module  # noqa: E402
from service.settings.capabilities import (  # noqa: E402
    CAPABILITY_HINT_KEY,
    CONTEXT_WINDOW_KEY,
    GATEWAY_CONNECTION,
    REASONING_OPTIONS_KEY,
    CapabilitySchemaError,
    apply_capability,
    bundled_registry,
    load_registry,
    modality_flags,
    reasoning_option,
)
from service.settings.connections import (  # noqa: E402
    ModelProfileStore,
    apply_profile,
    prepare_personal_connection,
)

CHAT_COMPLETIONS_PROTOCOL = ModelWireProtocol.CHAT_COMPLETIONS.value
RESPONSES_PROTOCOL = ModelWireProtocol.RESPONSES.value
PASS = 0
FAIL = 0
CAPABILITY_MODEL = "contract-model"
# 厂商基线与用户声明刻意取不同值：一旦提示参与门控，下面两条数值就会互相顶替。
VENDOR_WINDOW_TOKENS = 1_000_000
USER_WINDOW_TOKENS = 200_000
RUNTIME_CLAMPED_WINDOW_TOKENS = 272_000
SESSION_ID = "capability-session"
RUNTIME_ID = "codex"
OWNER = SessionPrincipal("capability-owner")


def check(name: str, ok: bool, detail: str = "") -> None:
    """Print one deterministic contract assertion."""
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def raises(action: Any) -> str:
    """Return the message of the ValueError ``action`` raises, or ``''`` when it passes."""
    try:
        action()
    except (ValueError, CapabilitySchemaError) as error:
        return str(error)
    return ""


def connection_for(
    model: str,
    lane: str = "",
    protocol: str = CHAT_COMPLETIONS_PROTOCOL,
) -> dict[str, Any]:
    """按随包声明造一条 ``inference_connection`` 形状的最小字典。

    出站思考参数的断言因此读的是真注册表，而不是手抄的字段值 —— 数据一改，断言就跟着真改。
    """

    row = apply_capability(
        {"model_name": model, "provider": "openai"},
        bundled_registry().lookup(model, lane),
        lane=lane,
    )
    return {
        "model": model,
        "wire_api": protocol,
        "provider": str(row.get("provider") or ""),
        REASONING_OPTIONS_KEY: row.get(REASONING_OPTIONS_KEY),
    }


def _options(connection: dict[str, Any]) -> Any:
    """取这条坐标声明的思考形态载荷。"""

    return connection.get(REASONING_OPTIONS_KEY)


def outbound_body(request: Any, model: str, protocol: str, lane: str = "") -> dict[str, Any]:
    """按真实声明跑完「算思考参数 → 编请求体」，供出站参数断言复用。

    复刻生产的那一条调用顺序，而不是各套件各写一遍 —— 顺序一变，只有一处会跟着变。
    """

    connection = connection_for(model, lane, protocol)
    thinking = thinking_for(request, connection)
    return dict(ENCODERS[protocol](request, connection, thinking.parameters))


def capability_document(**entry_overrides: Any) -> dict[str, Any]:
    """One coherent registry document with a single baseline entry."""
    entry: dict[str, Any] = {
        "limits": {"context": 128_000, "max_output": 4096},
        "modalities": {"input": ["text", "image"], "output": ["text"]},
        "reasoning": {
            "supported": True,
            "options": [{"kind": "effort", "values": ["low", "high"], "default": "low"}],
        },
    }
    entry.update(entry_overrides)
    return {"schema_version": 1, "models": {CAPABILITY_MODEL: entry}, "connections": {}}


def registry_from(document: dict[str, Any]) -> Any:
    path = Path(tempfile.mkdtemp(prefix="capabilities-")) / "capabilities.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return load_registry(path)


def registry_error(document: dict[str, Any]) -> str:
    return raises(lambda: registry_from(document))


def personal_document(models: list[dict[str, Any]], **profile_overrides: Any) -> dict[str, Any]:
    """One enabled personal connection carrying the given model declarations."""
    profile: dict[str, Any] = {
        "id": "personal-capability",
        "enabled": True,
        "provider": "openai",
        "base_url": "https://personal.example.test/v1",
        "api_key": "personal-test-key",
        "selected_models": models,
    }
    return {"profiles": [{**profile, **profile_overrides}]}


def personal_row(models: list[dict[str, Any]], **profile_overrides: Any) -> dict[str, Any]:
    rows = ModelService._personal_items(personal_document(models, **profile_overrides))
    return rows[0]


# ── 随包声明：解析与加载期硬校验 ──────────────────────────────────────────


def test_gateway_lane_resolves_the_declared_truth() -> None:
    """§10 判据 ②③：qwen3.8-max 的窗口与 xhigh 档位来自声明而不是被削掉。"""
    capability = bundled_registry().lookup("qwen3.8-max", GATEWAY_CONNECTION)
    check("the gateway lane is declared", capability.declared)
    check(
        "qwen3.8-max declares the vendor window",
        capability.limits.get("context") == VENDOR_WINDOW_TOKENS,
        str(capability.limits),
    )
    check(
        "xhigh survives the gateway declaration",
        list(capability.effort_values or ()) == ["low", "medium", "xhigh"],
        str(capability.effort_values),
    )
    check("image input is declared", "image" in (capability.input_modalities or ()))
    item = apply_capability({"model_name": "qwen3.8-max"}, capability, lane=GATEWAY_CONNECTION)
    check(
        "the catalog item carries the declared window",
        item.get("context_window") == VENDOR_WINDOW_TOKENS,
        str(item.get("context_window")),
    )
    check("a fully declared item carries no unverified marker", "capability_reason" not in item)


def test_resolution_matches_only_the_exact_wire_id() -> None:
    """I1：名字规则只能用于查键，不能产出能力真值。"""
    registry = bundled_registry()
    for name in (
        "qwen3.8-max-turbo",
        "qwen3.8-max-2026-01-01",
        "qwen3.8",
        "qwen3-8-max",
        "gpt-5.5-codex",
    ):
        check(f"{name} is not resolved by prefix", not registry.lookup(name).declared)
    check(
        "case and padding are normalised, not guessed",
        registry.lookup(f"  {CAPABILITY_MODEL.upper()}  ").declared
        or registry.lookup("QWEN3.8-MAX").declared,
    )


def test_undeclared_model_produces_no_window() -> None:
    """§10 判据 ① + I2：未声明模型不产出大默认值，且逐项留痕。"""
    item = apply_capability(
        {"model_name": "unknown-slug"}, bundled_registry().lookup("unknown-slug"), lane="config"
    )
    check("the undeclared window is absent, not defaulted", "context_window" not in item)
    check("the undeclared output limit is absent", "max_output_tokens" not in item)
    check("undeclared modalities fail closed", item.get("image_input") is False)
    check("undeclared pdf fails closed", item.get("pdf_input") is False)
    check("undeclared reasoning offers no efforts", item.get("reasoning_efforts") is None)
    reasons = str(item.get("capability_reason") or "")
    check(
        "every unverified field is named with its lane",
        all(
            f"{field}_unverified:config" in reasons
            for field in ("modalities", "context_window", "max_output_tokens", "reasoning")
        ),
        reasons,
    )
    check("the item says it has no declaration", item.get("capability_declared") is False)


def test_no_big_default_survives_in_the_sources() -> None:
    """§10 判据 ① 的 grep 层面：窗口默认常数不得再出现在读取侧源码里。"""
    for module in (catalog_module,):
        source = Path(str(module.__file__)).with_suffix(".py").read_text(encoding="utf-8")
        check(
            f"{Path(str(module.__file__)).name} declares no window constant",
            "LONG_CONTEXT_WINDOW_TOKENS" not in source and "1_000_000" not in source,
        )


def test_loading_rejects_incoherent_declarations() -> None:
    """§9.1：任一不自洽都在加载期失败，不静默修正。"""
    cases: dict[str, dict[str, Any]] = {
        "unknown reasoning kind": {
            "reasoning": {"supported": True, "options": [{"kind": "vibes"}]}
        },
        "default outside offered levels": {
            "reasoning": {
                "supported": True,
                "options": [{"kind": "effort", "values": ["low"], "default": "ultra"}],
            }
        },
        "level outside the union": {
            "reasoning": {"supported": True, "options": [{"kind": "effort", "values": ["hyper"]}]}
        },
        "inverted budget range": {
            "reasoning": {"supported": True, "options": [{"kind": "budget", "min": 9, "max": 3}]}
        },
        "options without support": {
            "reasoning": {"supported": False, "options": [{"kind": "toggle"}]}
        },
        "non-positive limit": {"limits": {"context": 0}},
        "unknown provenance": {"provenance": {"limits": "guessed"}},
        "unknown status": {"status": "sunset"},
        "empty modality list": {"modalities": {"input": [], "output": ["text"]}},
    }
    for name, override in cases.items():
        check(f"load rejects {name}", bool(registry_error(capability_document(**override))))
    unsupported_version = capability_document()
    unsupported_version["schema_version"] = 2
    check("load rejects an unsupported schema version", bool(registry_error(unsupported_version)))
    document = capability_document()
    document["models"][CAPABILITY_MODEL]["long_context"] = {"context": 100}
    check("load rejects a long edition below the base", bool(registry_error(document)))
    overridden = capability_document()
    overridden["connections"] = {f"lane:{CAPABILITY_MODEL}": {"long_context": {"context": 100}}}
    check(
        "load rejects a long edition below the base through an override",
        bool(registry_error(overridden)),
    )
    broken = json.dumps(capability_document())
    duplicated = broken.replace('"schema_version"', '"schema_version": 1, "schema_version"', 1)
    check(
        "load rejects duplicate json keys",
        bool(raises(lambda: load_registry(_write(duplicated, "duplicated-capabilities.json")))),
    )


def test_loading_rejects_incoherent_connection_overrides() -> None:
    """就近覆盖必须挂在已存在的基线模型上，且键形如 ``<连接>:<模型>``。"""
    malformed = capability_document()
    malformed["connections"] = {"scholarseed-gateway": {"limits": {}}}
    check("override key needs a connection and a model", bool(registry_error(malformed)))
    orphan = capability_document()
    orphan["connections"] = {"scholarseed-gateway:no-baseline": {"limits": {}}}
    check("override needs a baseline entry", bool(registry_error(orphan)))
    merged = capability_document()
    merged["connections"] = {f"other-lane:{CAPABILITY_MODEL}": {"limits": {"context": 4096}}}
    registry = registry_from(merged)
    capability = registry.lookup(CAPABILITY_MODEL, "other-lane")
    check(
        "the nearest override wins",
        capability.limits.get("context") == 4096,
        str(capability.limits),
    )
    check(
        "the base entry keeps the un-overridden field",
        capability.limits.get("max_output") == 4096,
        str(capability.limits),
    )
    check(
        "an override may omit modalities without erasing the baseline",
        capability.input_modalities == ("text", "image"),
        str(capability.input_modalities),
    )


def _write(text: str, name: str) -> Path:
    path = Path(tempfile.mkdtemp(prefix="capabilities-")) / name
    path.write_text(text, encoding="utf-8")
    return path


def test_missing_and_empty_modalities_are_different_facts() -> None:
    """键缺失是「没声明」；显式空数组是录入错误 —— 两者不能都长成 ``()``。"""
    document = capability_document()
    del document["models"][CAPABILITY_MODEL]["modalities"]
    capability = registry_from(document).lookup(CAPABILITY_MODEL)
    check("an omitted modalities key stays undeclared", capability.input_modalities is None)
    check(
        "an omitted modalities key is not an empty declaration",
        bool(registry_error(capability_document(modalities={"input": []}))),
    )


# ── 个人车道：只认用户声明 ────────────────────────────────────────────────


def test_personal_lane_never_inherits_the_vendor_declaration() -> None:
    """I3：同名厂商条目只作预填提示，门控字段一律取用户声明。"""
    row = personal_row(
        [
            {
                "id": "qwen3.8-max",
                "label": "",
                "context_window": USER_WINDOW_TOKENS,
                "input_modalities": ["text"],
                "reasoning_efforts": ["low"],
            }
        ]
    )
    check("the user's window decides", row.get("context_window") == USER_WINDOW_TOKENS)
    check("the user's modality decides", row.get("image_input") is False)
    check("the user's effort list decides", row.get("reasoning_efforts") == ["low"])
    check(
        "the declared effort becomes an effort-shaped option",
        row.get("reasoning_options") == [{"kind": "effort", "values": ["low"]}],
        str(row.get("reasoning_options")),
    )
    check(
        "a fully declared personal model is marked declared", row.get("capability_declared") is True
    )
    hint = row.get("capability_hint") or {}
    check(
        "the vendor figure stays visible as a hint only",
        hint.get("context_window") == VENDOR_WINDOW_TOKENS
        and "image" in (hint.get("input_modalities") or ()),
        str(hint),
    )
    check(
        "the hint never lands on a gating field", row.get("context_window") != VENDOR_WINDOW_TOKENS
    )


def test_undeclared_personal_model_fails_closed() -> None:
    """没声明的个人模型：不报错、不编值，只把可用面收敛并留痕。"""
    row = personal_row([{"id": "qwen3.8-max", "label": ""}])
    check("no window is invented for a personal model", "context_window" not in row)
    check("no output limit is invented", "max_output_tokens" not in row)
    check("pdf stays closed", row.get("pdf_input") is False)
    check("reasoning stays closed", row.get("reasoning_options") is None)
    check("the row admits it has no declaration", row.get("capability_declared") is False)
    reasons = str(row.get("capability_reason") or "")
    check(
        "every missing field is marked in the personal lane",
        reasons.count("_unverified:personal") == 4,
        reasons,
    )
    unknown = personal_row([{"id": "totally-unknown-slug", "label": ""}])
    check("an unknown id gets no vendor hint", "capability_hint" not in unknown)


def test_connection_level_declaration_still_counts() -> None:
    """连接级声明也是用户声明（历史形态），但不算模型级已确认。"""
    row = personal_row(
        [{"id": "legacy-model", "label": ""}], image_input=True, context_window=64_000
    )
    check("the connection's vision flag is honoured", row.get("image_input") is True)
    check(
        "the runtime catalog receives the same connection image declaration",
        _runtime_capabilities(row).input_modalities == ("text", "image"),
    )
    check("the connection's window is honoured", row.get("context_window") == 64_000)
    check(
        "a model without its own modalities is still marked unverified",
        "modalities_unverified:personal" in str(row.get("capability_reason")),
        str(row.get("capability_reason")),
    )


def test_empty_declaration_reads_as_undeclared() -> None:
    """``[]`` 与缺失同义：落盘成空集合会让下游多出一种要区分的「没有」。"""
    row = personal_row(
        [{"id": "sparse-model", "label": "", "reasoning_efforts": [], "input_modalities": []}]
    )
    check("an empty effort list is no declaration", row.get("reasoning_efforts") is None)
    check("an empty modality list is no declaration", "input_modalities" not in row)
    check("the vision default stays closed", row.get("image_input") is False)


def test_invalid_declarations_are_refused_not_dropped() -> None:
    """用户的声明不能悄悄丢掉：非法值在保存期就报错（路由映射成 422）。"""

    def saved(models: list[dict[str, Any]]) -> str:
        return raises(lambda: prepare_personal_connection(_connection_values(models)))

    for name, entry in (
        ("zero window", {"context_window": 0}),
        ("negative window", {"context_window": -1}),
        ("text window", {"context_window": "128k"}),
        ("boolean window", {"context_window": True}),
        ("unknown modality", {"input_modalities": ["hologram"]}),
        ("modality not a list", {"input_modalities": "text"}),
        ("unknown effort", {"reasoning_efforts": ["ultra-high"]}),
        ("zero output limit", {"max_output_tokens": 0}),
    ):
        check(f"save rejects {name}", bool(saved([{"id": "m", "label": "", **entry}])))
    stored = prepare_personal_connection(
        _connection_values([{"id": "m", "label": "", "context_window": USER_WINDOW_TOKENS}])
    )
    check(
        "a valid declaration survives normalisation",
        stored["selected_models"][0].get("context_window") == USER_WINDOW_TOKENS,
        str(stored["selected_models"]),
    )
    normalised = prepare_personal_connection(
        _connection_values(
            [{"id": "m", "label": "", "input_modalities": ["Text", " image ", "image"]}]
        )
    )
    check(
        "modalities are normalised and de-duplicated",
        normalised["selected_models"][0].get("input_modalities") == ["text", "image"],
        str(normalised["selected_models"]),
    )
    collapsed = prepare_personal_connection(
        _connection_values(
            [{"id": "m", "label": "", "reasoning_efforts": [], "input_modalities": []}]
        )
    )
    stored_entry = collapsed["selected_models"][0]
    check(
        "an empty declaration is not written out as a declaration",
        "reasoning_efforts" not in stored_entry and "input_modalities" not in stored_entry,
        str(stored_entry),
    )


def _connection_values(models: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "preview_name": "capability",
        "provider": "openai",
        "base_url": "https://personal.example.test/v1",
        "api_key": "personal-test-key",
        "selected_models": models,
    }


def test_execution_config_reads_the_same_declaration() -> None:
    """执行面与目录面必须读同一份声明，否则界面显示的和真跑起来的会是两件事。"""
    store = ModelProfileStore(Path(TEST_HOME.name) / "profiles-execution.json")
    profile = store.upsert(
        {
            **_connection_values(
                [
                    {"id": "narrow", "label": "", "context_window": USER_WINDOW_TOKENS},
                    {"id": "vision", "label": "", "input_modalities": ["text", "image"]},
                    {"id": "quiet", "label": ""},
                ]
            ),
            "context_window": 64_000,
        }
    )
    narrowed = apply_profile({"context_window": 8_000}, profile["id"], store, model_id="narrow")
    check(
        "the model's window beats the connection's and the built-in config",
        narrowed.get("context_window") == USER_WINDOW_TOKENS,
        str(narrowed.get("context_window")),
    )
    seeing = apply_profile({}, profile["id"], store, model_id="vision")
    check("declared modalities open the attachment gate", seeing.get("image_input") is True)
    check(
        "a declared modality clears the conservative reason",
        "image_input_reason" not in seeing,
        str(seeing.get("image_input_reason")),
    )
    silent = apply_profile({}, profile["id"], store, model_id="quiet")
    check(
        "an undeclared personal model stays attachment-closed", silent.get("image_input") is False
    )
    check(
        "an explicit ``false`` declaration needs no reason code",
        "image_input_reason" not in silent,
        str(silent.get("image_input_reason")),
    )
    legacy_path = Path(TEST_HOME.name) / "profiles-legacy.json"
    legacy_store = ModelProfileStore(legacy_path)
    legacy_profile = legacy_store.upsert(_connection_values([{"id": "quiet", "label": ""}]))
    stored = json.loads(legacy_path.read_text(encoding="utf-8"))
    for legacy_key in ("image_input", "pdf_input"):
        stored["profiles"][legacy_profile["id"]].pop(legacy_key, None)
    legacy_path.write_text(json.dumps(stored), encoding="utf-8")
    legacy = apply_profile({}, legacy_profile["id"], legacy_store, model_id="quiet")
    check(
        "a connection that never spoke about vision stays closed and says why",
        legacy.get("image_input") is False
        and legacy.get("image_input_reason") == "personal_model_unverified",
        str(legacy.get("image_input_reason")),
    )


def test_profiles_projection_offers_the_vendor_hint() -> None:
    """设置页的「按厂商口径填充」只能靠投影里的提示，而提示不得变成第二份落盘真值。"""
    store = ModelProfileStore(Path(TEST_HOME.name) / "profiles-hint.json")
    profile = store.upsert(
        _connection_values(
            [
                {"id": "qwen3.8-max", "label": ""},
                {"id": "totally-unknown-slug", "label": ""},
            ]
        )
    )
    hinted, orphan = profile["selected_models"]
    check(
        "the projection carries the vendor figure",
        (hinted.get(CAPABILITY_HINT_KEY) or {}).get(CONTEXT_WINDOW_KEY) == VENDOR_WINDOW_TOKENS,
        str(hinted),
    )
    check("an id with no vendor entry gets no hint", CAPABILITY_HINT_KEY not in orphan, str(orphan))
    stored = json.loads(store.path.read_text(encoding="utf-8"))["profiles"][profile["id"]][
        "selected_models"
    ]
    check(
        "the hint never reaches the stored profile",
        all(CAPABILITY_HINT_KEY not in entry for entry in stored),
        str(stored),
    )
    echoed = store.upsert(_connection_values([dict(hinted)]), profile["id"])
    check(
        "an echoed hint on save is ignored, not adopted silently",
        (echoed["selected_models"][0].get(CAPABILITY_HINT_KEY) or {}).get(CONTEXT_WINDOW_KEY)
        == VENDOR_WINDOW_TOKENS
        and CONTEXT_WINDOW_KEY not in echoed["selected_models"][0],
        str(echoed["selected_models"]),
    )


def test_minimum_ladder_follows_the_declared_form() -> None:
    """「关掉思考」怎么发，只由这条坐标声明的形态决定。"""
    gateway = connection_for("qwen3.8-max", GATEWAY_CONNECTION)
    vendor = connection_for("qwen3.8-max")
    for protocol in (CHAT_COMPLETIONS_PROTOCOL, RESPONSES_PROTOCOL):
        check(
            f"qwen3.8-max declares the vendor toggle on {protocol}",
            minimum_parameters(_options(gateway), protocol, "openai").parameters
            == {"enable_thinking": False},
        )
        check(
            f"the vendor baseline reaches the same verdict on {protocol}",
            minimum_parameters(_options(vendor), protocol, "openai").reason == MINIMUM_APPLIED,
        )
    explicit_off = _options(connection_for("gpt-5.5"))
    check(
        "an explicit none level is sent as a level",
        minimum_parameters(explicit_off, CHAT_COMPLETIONS_PROTOCOL, "openai").parameters
        == {"reasoning_effort": "none"},
    )
    check(
        "the nested responses name is expanded",
        minimum_parameters(explicit_off, RESPONSES_PROTOCOL, "openai").parameters
        == {"reasoning": {"effort": "none"}},
    )
    claude = _options(connection_for("claude-opus-4-7"))
    lowered = minimum_parameters(claude, CHAT_COMPLETIONS_PROTOCOL, "openai")
    check(
        "no off level declared → the lowest declared level, flagged as adjusted",
        lowered.parameters == {"reasoning_effort": "low"}
        and lowered.adjusted is True
        and lowered.reason == MINIMUM_CLAMPED,
        str(lowered),
    )
    fixed = _options(connection_for("kimi-k2.7-code"))
    check(
        "thinking fixed on sends nothing",
        minimum_parameters(fixed, CHAT_COMPLETIONS_PROTOCOL, "openai").reason == THINKING_FIXED
        and minimum_parameters(fixed, RESPONSES_PROTOCOL, "openai").parameters == {},
    )
    undeclared = minimum_parameters(None, CHAT_COMPLETIONS_PROTOCOL, "openai")
    check(
        "an undeclared form never emits a vendor extension",
        undeclared.parameters == {} and undeclared.reason == NO_REASONING_FORM,
        str(undeclared),
    )
    check(
        "the lowest level comes from the single level ordering",
        minimum_effort([{"kind": "effort", "values": ["high", "low", "xhigh"]}]) == "low",
    )


def test_effort_mapping_and_clamping() -> None:
    """档位解析：在集内直发；没选或越界都落到确定默认档（default，未声明取最低档）。"""
    options = [
        {
            "kind": "effort",
            "values": ["low", "high"],
            "default": "low",
            "wire": {"chat_completions": "reasoning_effort"},
        }
    ]
    check(
        "a declared level is sent verbatim",
        effort_parameters(options, CHAT_COMPLETIONS_PROTOCOL, "openai", "high").parameters
        == {"reasoning_effort": "high"}
        and effort_parameters(options, CHAT_COMPLETIONS_PROTOCOL, "openai", "high").adjusted
        is False,
    )
    clamped = effort_parameters(options, CHAT_COMPLETIONS_PROTOCOL, "openai", "xhigh")
    check(
        "an undeclared level falls back to the declared default",
        clamped.parameters == {"reasoning_effort": "low"}
        and clamped.adjusted is True
        and clamped.reason == MINIMUM_CLAMPED,
        str(clamped),
    )
    no_default = effort_parameters(
        [{"kind": "effort", "values": ["low", "high"]}],
        CHAT_COMPLETIONS_PROTOCOL,
        "openai",
        "xhigh",
    )
    check(
        "without a declared default an undeclared level clamps to the lowest level",
        no_default.parameters == {"reasoning_effort": "low"}
        and no_default.adjusted is True
        and no_default.reason == MINIMUM_CLAMPED,
        str(no_default),
    )
    unselected = effort_parameters(options, CHAT_COMPLETIONS_PROTOCOL, "openai", "")
    check(
        "an unselected effort sends the definite declared default",
        unselected.parameters == {"reasoning_effort": "low"}
        and unselected.effort == "low"
        and unselected.adjusted is False,
        str(unselected),
    )
    unselected_no_default = effort_parameters(
        [{"kind": "effort", "values": ["medium", "high"]}],
        CHAT_COMPLETIONS_PROTOCOL,
        "openai",
        "",
    )
    check(
        "an unselected effort without a declared default falls to the lowest level",
        unselected_no_default.parameters == {"reasoning_effort": "medium"}
        and unselected_no_default.adjusted is False,
        str(unselected_no_default),
    )
    unselected_formless = effort_parameters(
        [{"kind": "toggle", "wire": {"chat_completions": "enable_thinking"}}],
        CHAT_COMPLETIONS_PROTOCOL,
        "openai",
        "",
    )
    check(
        "an unselected effort on a coordinate without an effort form sends nothing",
        unselected_formless.parameters == {} and unselected_formless.adjusted is False,
        str(unselected_formless),
    )
    check(
        "the definite default prefers the declared default over the lowest level",
        default_effort([{"kind": "effort", "values": ["low", "high"], "default": "high"}]) == "high"
        and default_effort([{"kind": "effort", "values": ["high", "low"]}]) == "low"
        and default_effort([{"kind": "toggle"}]) == "",
    )
    check(
        "a personal declaration with no wire name uses the protocol's public field",
        effort_parameters(
            [{"kind": "effort", "values": ["low"]}], CHAT_COMPLETIONS_PROTOCOL, "openai", "low"
        ).parameters
        == {"reasoning_effort": "low"}
        and effort_parameters(
            [{"kind": "effort", "values": ["low"]}], RESPONSES_PROTOCOL, "openai", "low"
        ).parameters
        == {"reasoning": {"effort": "low"}},
    )
    declared_other_protocol = [{"kind": "effort", "values": ["low"], "wire": {"responses": "x"}}]
    check(
        "a declared wire map is never backfilled for a protocol it omits",
        option_wire(
            reasoning_option(declared_other_protocol, "effort"),
            CHAT_COMPLETIONS_PROTOCOL,
            "openai",
        )
        == "",
    )
    check(
        "an unknown provider family has no public field name to invent",
        option_wire(
            reasoning_option([{"kind": "effort", "values": ["low"]}], "effort"),
            CHAT_COMPLETIONS_PROTOCOL,
            "unknown",
        )
        == "",
    )


def test_reasoning_forms_merge_by_kind() -> None:
    """就近覆盖按 kind 逐项合并；显式空集合才是「无可调形态」。"""
    # 内置目录已扁平化（connections 段清空），合并语义改由合成文档验证 —— 机制仍在
    # capabilities.py 里，BYOK/未来自定义连接仍会用到，不能因为内置数据扁平了就失覆盖。
    merged_doc = capability_document(
        reasoning={
            "supported": True,
            "options": [
                {
                    "kind": "toggle",
                    "wire": {"chat_completions": "enable_thinking", "responses": "enable_thinking"},
                },
                {
                    "kind": "budget",
                    "wire": {"chat_completions": "thinking_budget", "responses": "thinking_budget"},
                },
            ],
        }
    )
    merged_doc["connections"] = {
        f"lane:{CAPABILITY_MODEL}": {
            "reasoning": {
                "supported": True,
                "options": [{"kind": "effort", "values": ["low", "xhigh"]}],
            }
        }
    }
    merged = registry_from(merged_doc).lookup(CAPABILITY_MODEL, "lane")
    merged_kinds = [option.kind for option in (merged.reasoning_options or ())]
    check(
        "a nearest override merges by kind instead of replacing wholesale",
        {"effort", "toggle", "budget"} <= set(merged_kinds),
        str(merged_kinds),
    )
    emptied = capability_document()
    emptied["connections"] = {
        f"lane:{CAPABILITY_MODEL}": {"reasoning": {"supported": True, "options": []}}
    }
    fixed_override = registry_from(emptied).lookup(CAPABILITY_MODEL, "lane")
    check(
        "an explicit empty override really removes every form",
        fixed_override.reasoning_options == (),
        str(fixed_override.reasoning_options),
    )
    check(
        "so a fixed-on model declares no off control",
        fixed_on(fixed_override.reasoning_options) is True,
    )
    # 扁平化后的内置 qwen3.8-max：网关实测档位与厂商开关在同一条基线里并存。
    flat = bundled_registry().lookup("qwen3.8-max", GATEWAY_CONNECTION)
    flat_kinds = [option.kind for option in (flat.reasoning_options or ())]
    check(
        "the flattened qwen3.8-max declares the gateway-probed ladder",
        "effort" in flat_kinds and list(flat.effort_values or ()) == ["low", "medium", "xhigh"],
        str(flat.effort_values),
    )
    check(
        "the flattened qwen3.8-max keeps the vendor toggle alongside it",
        "toggle" in flat_kinds,
        str(flat_kinds),
    )
    check(
        "load rejects a wire name keyed by an unknown protocol",
        bool(
            registry_error(
                capability_document(
                    reasoning={
                        "supported": True,
                        "options": [
                            {
                                "kind": "effort",
                                "values": ["low"],
                                "wire": {"chat": "reasoning_effort"},
                            }
                        ],
                    }
                )
            )
        ),
    )
    raised = ""
    try:
        require_declared_effort([{"kind": "effort", "values": ["low", "high"]}], "xhigh")
    except ValueError as error:
        raised = str(error)
    check(
        "a one-shot call asking an undeclared level fails listing the supported ones",
        "xhigh" in raised and "low" in raised and "high" in raised,
        raised,
    )
    require_declared_effort(None, "xhigh")
    require_declared_effort([{"kind": "effort", "values": ["low"]}], "low")
    check("an undeclared model never refuses a level for lack of evidence", True)


def test_modality_flags_have_one_derivation() -> None:
    """门控布尔只有 ``modality_flags`` 一个派生点。"""
    check(
        "text alone opens nothing",
        modality_flags(["text"]) == {"image_input": False, "pdf_input": False},
    )
    check(
        "declared image and pdf open both gates",
        modality_flags(["text", "IMAGE", " pdf "]) == {"image_input": True, "pdf_input": True},
    )
    check("an unrelated modality opens neither", modality_flags(["video"])["image_input"] is False)


# ── 声明 ↔ 生效闭环 ───────────────────────────────────────────────────────


def test_resolution_compares_declaration_with_runtime_reality() -> None:
    """§6 步骤 5：声明被削平必须可判真值。"""
    declared = ModelIntent(
        model_ref="qwen3.8-max",
        transport=ModelTransport(endpoint="https://x.test/v1"),
        context_window=VENDOR_WINDOW_TOKENS,
    )
    resolution = capability_resolution(declared, RUNTIME_CLAMPED_WINDOW_TOKENS) or {}
    check(
        "a clamped window is reported with both values",
        resolution.get("declared_context_window") == VENDOR_WINDOW_TOKENS
        and resolution.get("effective_context_window") == RUNTIME_CLAMPED_WINDOW_TOKENS
        and resolution.get("clamped") is True
        and resolution.get("wire_model") == "qwen3.8-max",
        str(resolution),
    )
    matching = capability_resolution(declared, VENDOR_WINDOW_TOKENS) or {}
    check("an honoured declaration is not clamped", matching.get("clamped") is False)
    undeclared = (
        capability_resolution(ModelIntent(model_ref="x"), RUNTIME_CLAMPED_WINDOW_TOKENS) or {}
    )
    check(
        "no declaration reports a null declared window",
        undeclared.get("declared_context_window") is None and undeclared.get("clamped") is False,
        str(undeclared),
    )
    check(
        "a runtime that has not reported a window yields no event",
        capability_resolution(declared, 0) is None,
    )


def test_changed_window_requires_a_restart() -> None:
    """``model_context_window`` 是启动级配置，改声明必须走重开而不是就地生效。"""
    left = ModelIntent(
        model_ref="m", transport=ModelTransport(endpoint="https://x.test/v1"), context_window=1000
    )
    same_window = ModelIntent(
        model_ref="m", transport=ModelTransport(endpoint="https://x.test/v1"), context_window=1000
    )
    wider = ModelIntent(
        model_ref="m", transport=ModelTransport(endpoint="https://x.test/v1"), context_window=2000
    )
    unwindowed = ModelIntent(model_ref="m", transport=ModelTransport(endpoint="https://x.test/v1"))
    check(
        "an unchanged window still reuses the thread", _same_thread_preferences(left, same_window)
    )
    check("a changed window does not", not _same_thread_preferences(left, wider))
    check(
        "declaring a window on a previously undeclared thread restarts",
        not _same_thread_preferences(unwindowed, left),
    )
    check(
        "the connection identity itself is untouched by the window",
        _same_model_connection(left, wider),
    )
    toggled = ModelIntent(
        model_ref="m",
        transport=ModelTransport(endpoint="https://x.test/v1"),
        context_window=1000,
        thinking=ModelThinking(enabled=False),
    )
    check(
        "a changed thinking intent does not look applied in place",
        not _same_thread_preferences(left, toggled),
    )
    check(
        "an unchanged thinking intent still reuses the thread",
        _same_thread_preferences(
            toggled,
            ModelIntent(
                model_ref="m",
                transport=ModelTransport(endpoint="https://x.test/v1"),
                context_window=1000,
                thinking=ModelThinking(enabled=False),
            ),
        ),
    )


# ── 事件投影：runtime 事件到产品事件 ──────────────────────────────────────


def test_product_event_projects_the_resolution() -> None:
    """闭环事件必须落到产品事件流，否则只有读代码的人知道声明被削平过。"""
    root = Path(tempfile.mkdtemp(prefix="capability-session-"))
    workdir = root / "workspace"
    workdir.mkdir()
    database = root / "sessions.sqlite3"
    catalog = SessionCatalogStore(database)
    catalog.register(
        SESSION_ID,
        OWNER,
        runtime_id=RUNTIME_ID,
        vendor_thread_id="thread-capability",
        vendor_session_id=None,
        runtime_workdir=str(workdir),
        project_path=None,
        output_root=str(workdir / "outputs"),
        codex_version="codex-cli contract",
        model_id="qwen3.8-max",
        policy_id="workspace-write",
        status=SessionStatus.READY,
        title="capability resolution",
        created_at=1.0,
    )
    events = ProductEventStore(database)
    live = LiveSession(
        session_id=SESSION_ID,
        runtime_id=RUNTIME_ID,
        runtime_workdir=workdir,
        project_path=None,
        output_root=workdir / "outputs",
        model_id="qwen3.8-max",
        catalog=catalog,
        events=events,
        artifacts=SessionArtifactStore(database),
        skills=SkillCatalog(bundled_root=root / "bundled", user_root=root / "user"),
        logger=SimpleNamespace(
            debug=lambda *_args, **_kwargs: None,
            info=lambda *_args, **_kwargs: None,
            warning=lambda *_args, **_kwargs: None,
            error=lambda *_args, **_kwargs: None,
        ),
        trace=SessionTrace(SESSION_ID, workdir, runtime_id=RUNTIME_ID, trace_dir=root / "trace"),
    )
    # 本套件只验事件投影，不验 gateway 生命周期；带 turn 归属的事件要求会话已绑定
    # vendor thread，落这一条公开属性即可，起整只 RuntimeSession 替身是无关的噪音。
    live.vendor_thread_id = "thread-capability"

    def observation(event_id: str, payload: dict[str, Any]) -> RuntimeEvent:
        return RuntimeEvent(
            schema_version=1,
            event_id=event_id,
            runtime_id=RUNTIME_ID,
            product_session_id=SESSION_ID,
            native_session_id="thread-capability",
            process_generation=1,
            sequence=1,
            kind=RuntimeEventKind.MODEL_CAPABILITY_RESOLUTION,
            delivery=DeliveryClass.MUST_PERSIST,
            observed_at="2026-09-13T00:00:00Z",
            native_turn_id="turn-capability",
            native_item_id="item-capability",
            payload=payload,
        )

    async def drive() -> None:
        await live.on_runtime_observation(
            observation(
                "capability-clamped",
                {
                    "wire_model": "qwen3.8-max",
                    "declared_context_window": VENDOR_WINDOW_TOKENS,
                    "effective_context_window": RUNTIME_CLAMPED_WINDOW_TOKENS,
                    "clamped": True,
                },
            )
        )
        await live.on_runtime_observation(
            observation(
                "capability-undeclared",
                {
                    "wire_model": "unknown-slug",
                    "declared_context_window": None,
                    "effective_context_window": RUNTIME_CLAMPED_WINDOW_TOKENS,
                    "clamped": False,
                },
            )
        )
        await live.aclose()

    asyncio.run(drive())
    records = events.replay(SESSION_ID)
    projected = [
        record for record in records if record.kind == PRODUCT_EVENT_MODEL_CAPABILITY_RESOLUTION
    ]
    check(
        "the resolution reaches the product event stream", len(projected) == 2, str(len(projected))
    )
    clamped = projected[0].payload if projected else {}
    check(
        "the product event keeps both windows and the verdict",
        clamped.get("declared_context_window") == VENDOR_WINDOW_TOKENS
        and clamped.get("effective_context_window") == RUNTIME_CLAMPED_WINDOW_TOKENS
        and clamped.get("clamped") is True,
        str(clamped),
    )
    undeclared = projected[1].payload if len(projected) > 1 else {}
    check(
        "an undeclared window projects as null, not as zero",
        undeclared.get("declared_context_window") is None and undeclared.get("clamped") is False,
        str(undeclared),
    )


TESTS = (
    test_gateway_lane_resolves_the_declared_truth,
    test_resolution_matches_only_the_exact_wire_id,
    test_undeclared_model_produces_no_window,
    test_no_big_default_survives_in_the_sources,
    test_loading_rejects_incoherent_declarations,
    test_loading_rejects_incoherent_connection_overrides,
    test_missing_and_empty_modalities_are_different_facts,
    test_personal_lane_never_inherits_the_vendor_declaration,
    test_undeclared_personal_model_fails_closed,
    test_connection_level_declaration_still_counts,
    test_empty_declaration_reads_as_undeclared,
    test_invalid_declarations_are_refused_not_dropped,
    test_execution_config_reads_the_same_declaration,
    test_profiles_projection_offers_the_vendor_hint,
    test_minimum_ladder_follows_the_declared_form,
    test_effort_mapping_and_clamping,
    test_reasoning_forms_merge_by_kind,
    test_modality_flags_have_one_derivation,
    test_resolution_compares_declaration_with_runtime_reality,
    test_changed_window_requires_a_restart,
    test_product_event_projects_the_resolution,
)


def main() -> int:
    for test in TESTS:
        print(f"== {test.__name__}")
        test()
    print(f"passed={PASS} failed={FAIL}")
    TEST_HOME.cleanup()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
