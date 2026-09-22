"""Declared model capability facts and their exact-match resolution.

模型能力（上下文长度、思考参数形态、输入模态）的事实源是随包的、按提供商拆分的
``capabilities.<provider>.json`` 多文件（加载期聚合为一个注册表）。本模块只做三件事：读它、
按 ``(连接, wire model)`` 精确解析、把声明合并进目录条目。取不到的值就是 ``None`` —— 不由
模型名推断，也不给大的默认值（proposal 78 的 I1/I2）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from types import MappingProxyType
from typing import Any, Mapping, Sequence

from scholarseed_runtime.contract import ModelWireProtocol

EMPTY_LIMITS: Mapping[str, int | None] = MappingProxyType({})
EMPTY_PROVENANCE: Mapping[str, str] = MappingProxyType({})

CAPABILITY_DIR = Path(__file__).parent
# 能力声明按提供商拆成 ``capabilities.<provider>.json`` 多文件，加载期聚合为一个注册表
# （单文件曾达 2400+ 行）。glob 不含 ``capabilities.json``，故旧的单文件名不会被误读。
CAPABILITY_GLOB = "capabilities.*.json"
CAPABILITY_SCHEMA_VERSION = 1
GATEWAY_CONNECTION = "scholarseed-gateway"

MODALITY_KINDS = ("text", "image", "pdf", "video", "audio")
EFFORT_FORM = "effort"
BUDGET_FORM = "budget"
TOGGLE_FORM = "toggle"
REASONING_FORMS = (EFFORT_FORM, BUDGET_FORM, TOGGLE_FORM)
# 档位全集取厂商官方页与 Codex/OpenAI 枚举的并集：全集一旦小于实际存在的档位，声明了
# 高档位的模型就会在过滤时被静默丢掉（proposal 70 时代 xhigh 的真实故障）。
REASONING_EFFORT_LEVELS = ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")
CAPABILITY_PROVENANCE_USER = "user-declared"
CAPABILITY_PROVENANCES = (
    "vendor-doc",
    "gateway-probed",
    "gateway-config",
    "product-declared",
    # 第三方注册表口径（models.dev / opencode）：可溯源但非厂商一手页，单独标记，
    # 不与 vendor-doc 混淆（proposal 78 §5 把注册表定位为录入期交叉核对来源）。
    "registry",
    CAPABILITY_PROVENANCE_USER,
    "unverified",
)
MODEL_STATUS_ACTIVE = "active"
MODEL_STATUS_DEPRECATED = "deprecated"
MODEL_STATUSES = (MODEL_STATUS_ACTIVE, MODEL_STATUS_DEPRECATED, "beta")
CONTEXT_LIMIT_KEY = "context"
MAX_OUTPUT_LIMIT_KEY = "max_output"
LIMIT_KEYS = (
    CONTEXT_LIMIT_KEY,
    "max_input",
    MAX_OUTPUT_LIMIT_KEY,
    "max_reasoning",
    "max_input_thinking",
)
PROVENANCE_KEYS = ("limits", "modalities", "reasoning")
RELEASE_DATE_KEY = "release_date"
LAST_UPDATED_KEY = "last_updated"
# ``release_date`` / ``last_updated`` 只接受 ISO 日期；空串=未声明（注册表也没收录该模型时
# 不编日期，与 I1「取不到写 null」一致）。
DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")

# ``wire`` 段的协议键词表：声明、出站取名与传输协议必须同源，否则查名会静默 miss。
WIRE_PROTOCOL_KEYS = tuple(protocol.value for protocol in ModelWireProtocol)

CONTEXT_WINDOW_KEY = "context_window"
MAX_OUTPUT_TOKENS_KEY = "max_output_tokens"
IMAGE_INPUT_KEY = "image_input"
PDF_INPUT_KEY = "pdf_input"
IMAGE_INPUT_REASON_KEY = "image_input_reason"
INPUT_MODALITIES_KEY = "input_modalities"
OUTPUT_MODALITIES_KEY = "output_modalities"
REASONING_OPTIONS_KEY = "reasoning_options"
REASONING_EFFORTS_KEY = "reasoning_efforts"
CONTEXT_EDITION_KEY = "context_edition"
BASE_EDITION = "base"
LONG_CONTEXT_EDITION = "long_context"
CAPABILITY_DECLARED_KEY = "capability_declared"
CAPABILITY_STATUS_KEY = "capability_status"
CAPABILITY_PROVENANCE_KEY = "capability_provenance"
CAPABILITY_REASON_KEY = "capability_reason"
CAPABILITY_HINT_KEY = "capability_hint"
UNVERIFIED_SUFFIX = "unverified"
IMAGE_MODALITY = "image"
PDF_MODALITY = "pdf"


class CapabilitySchemaError(ValueError):
    """随包能力声明不自洽；宁可加载期失败，也不带着猜测跑产品链路。"""


@dataclass(frozen=True)
class ReasoningOption:
    """一种思考参数的出站形态：档位、token 预算，或纯开关。"""

    kind: str
    values: tuple[str, ...] = ()
    default: str | None = None
    minimum: int | None = None
    maximum: int | None = None
    wire: Mapping[str, str] | None = None


@dataclass(frozen=True)
class ModelCapability:
    """``(connection, wire model)`` 坐标上已声明的能力；``None`` 字段表示未声明。"""

    wire_model: str
    limits: Mapping[str, int | None] = EMPTY_LIMITS
    input_modalities: tuple[str, ...] | None = None
    output_modalities: tuple[str, ...] | None = None
    reasoning_supported: bool | None = None
    reasoning_options: tuple[ReasoningOption, ...] | None = None
    long_context: int | None = None
    status: str = MODEL_STATUS_ACTIVE
    provenance: Mapping[str, str] = EMPTY_PROVENANCE
    source_url: str = ""
    retrieved: str = ""
    release_date: str = ""
    last_updated: str = ""
    notes: tuple[str, ...] = ()
    declared: bool = True

    @property
    def effort_values(self) -> tuple[str, ...] | None:
        """档位形态下可选的思考档位；``reasoning`` 整体未声明时为 ``None``，声明了但
        没有档位形态（仅开关/预算/固定开启）时为空元组。"""

        if self.reasoning_options is None:
            return None
        for option in self.reasoning_options:
            if option.kind == EFFORT_FORM:
                return option.values
        return ()

    @property
    def wire_map(self) -> Mapping[str, Mapping[str, str]]:
        """每种思考形态的出站参数名，供 policy 层查表而不是硬编码。"""

        if self.reasoning_options is None:
            return MappingProxyType({})
        return MappingProxyType(
            {
                option.kind: dict(option.wire or {})
                for option in self.reasoning_options
                if option.wire
            }
        )


def unverified_reason(target: str, lane: str = "") -> str:
    """字段级「未确认」标记，与既有 ``*_model_unverified`` 同族语义。"""

    if lane:
        return f"{target}_{UNVERIFIED_SUFFIX}:{lane}"
    return f"{target}_{UNVERIFIED_SUFFIX}"


def modality_flags(modalities: Sequence[str]) -> dict[str, bool]:
    """输入模态数组 → 附件门控布尔。

    只有这一个派生点：``image_input``/``pdf_input`` 是消费侧（附件门控、标题、Codex
    投影）的形状，不是独立事实，任何第二处推导都会让门控和声明各走一边。
    """

    values = {str(modality).strip().lower() for modality in modalities}
    return {IMAGE_INPUT_KEY: IMAGE_MODALITY in values, PDF_INPUT_KEY: PDF_MODALITY in values}


def vendor_capability_hint(wire_model: str) -> dict[str, Any]:
    """厂商口径的预填提示；命不中即空字典，有名字不代表有真值。

    只给设置页「按厂商口径填充」和冲突提示用。它**不参与任何门控字段**（proposal 78 的
    I3）：同一个 id 在用户自配的端点上可能是量化版、代理转发或被截断过的窗口。
    """

    registry = bundled_registry()
    vendor = registry.lookup(wire_model)
    # Gateway-specific overrides carry the actually exposed effort ladder for
    # preset BYOK routes; use it as the vendor hint when the base model only
    # documents toggle/budget forms.
    gateway_vendor = registry.lookup(wire_model, GATEWAY_CONNECTION)
    if not vendor.effort_values and gateway_vendor.effort_values:
        vendor = gateway_vendor
    if not vendor.declared:
        return {}
    hint: dict[str, Any] = {"wire_model": vendor.wire_model}
    for field_name, limit_key in (
        (CONTEXT_WINDOW_KEY, CONTEXT_LIMIT_KEY),
        (MAX_OUTPUT_TOKENS_KEY, MAX_OUTPUT_LIMIT_KEY),
    ):
        value = vendor.limits.get(limit_key)
        if value is not None:
            hint[field_name] = int(value)
    if vendor.input_modalities:
        hint[INPUT_MODALITIES_KEY] = list(vendor.input_modalities)
    if vendor.effort_values:
        hint[REASONING_EFFORTS_KEY] = list(vendor.effort_values)
    elif vendor.reasoning_options:
        levels = next((o.values for o in vendor.reasoning_options if o.kind == "effort"), ())
        if levels:
            hint[REASONING_EFFORTS_KEY] = list(levels)
    if vendor.reasoning_options and vendor.provenance.get("reasoning") != "unverified":
        hint["reasoning_options"] = [option_payload(option) for option in vendor.reasoning_options]
    if vendor.provenance:
        hint[CAPABILITY_PROVENANCE_KEY] = dict(vendor.provenance)
    if vendor.source_url:
        hint["source_url"] = vendor.source_url
    if vendor.retrieved:
        hint["retrieved"] = vendor.retrieved
    return hint


def _positive_int(value: Any, *, where: str, name: str) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise CapabilitySchemaError(f"{where}: {name} must be a positive integer or null")
    return int(value)


def _string_list(value: Any, *, where: str, name: str, allowed: Sequence[str]) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise CapabilitySchemaError(f"{where}: {name} must be a list")
    items = tuple(str(entry).strip().lower() for entry in value)
    for entry in items:
        if entry not in allowed:
            raise CapabilitySchemaError(f"{where}: {name} has unknown value {entry!r}")
    return items


def _text(value: Any) -> str | None:
    cleaned = str(value or "").strip()
    return cleaned or None


def _date_text(value: Any, *, where: str, name: str) -> str:
    """ISO 日期文本；空=未声明，非空但格式不对即录入错误（不静默丢弃）。"""

    if value is None or value == "":
        return ""
    text = str(value).strip()
    if not DATE_PATTERN.fullmatch(text):
        raise CapabilitySchemaError(f"{where}: {name} must be YYYY-MM-DD or null, got {text!r}")
    return text


def _wire_names(value: Any, *, where: str, name: str) -> Mapping[str, str] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise CapabilitySchemaError(f"{where}: {name} must be an object")
    names = {str(key): str(entry) for key, entry in value.items()}
    for key in names:
        if key not in WIRE_PROTOCOL_KEYS:
            raise CapabilitySchemaError(
                f"{where}: {name} has unknown protocol {key!r}; expected one of "
                f"{', '.join(WIRE_PROTOCOL_KEYS)}"
            )
    return names


def _parse_option(value: Any, *, where: str) -> ReasoningOption:
    if not isinstance(value, dict):
        raise CapabilitySchemaError(f"{where}: reasoning options must be objects")
    kind = str(value.get("kind") or "").strip().lower()
    if kind not in REASONING_FORMS:
        raise CapabilitySchemaError(f"{where}: unknown reasoning kind {kind!r}")
    option = ReasoningOption(
        kind=kind,
        values=_string_list(
            value.get("values", []),
            where=where,
            name=f"reasoning.{kind}.values",
            allowed=REASONING_EFFORT_LEVELS,
        ),
        default=_text(value.get("default")),
        minimum=_positive_int(value.get("min"), where=where, name=f"reasoning.{kind}.min"),
        maximum=_positive_int(value.get("max"), where=where, name=f"reasoning.{kind}.max"),
        wire=_wire_names(value.get("wire"), where=where, name=f"reasoning.{kind}.wire"),
    )
    _validate_option(option, where=where)
    return option


def _validate_option(option: ReasoningOption, *, where: str) -> None:
    if option.kind == EFFORT_FORM:
        if len(set(option.values)) != len(option.values):
            raise CapabilitySchemaError(f"{where}: reasoning effort values repeat")
        if option.default is not None and option.default not in option.values:
            raise CapabilitySchemaError(
                f"{where}: reasoning effort default {option.default!r} is not offered"
            )
    if option.kind == BUDGET_FORM and option.minimum is not None and option.maximum is not None:
        if option.minimum > option.maximum:
            raise CapabilitySchemaError(f"{where}: reasoning budget range is inverted")


def _parse_reasoning(
    value: Any, *, where: str
) -> tuple[bool | None, tuple[ReasoningOption, ...] | None]:
    if value is None:
        return None, None
    if not isinstance(value, dict):
        raise CapabilitySchemaError(f"{where}: reasoning must be an object or null")
    supported = value.get("supported")
    if not isinstance(supported, bool):
        raise CapabilitySchemaError(f"{where}: reasoning.supported must be a boolean")
    raw_options = value.get("options")
    if raw_options is None:
        return supported, None
    if not isinstance(raw_options, list):
        raise CapabilitySchemaError(f"{where}: reasoning.options must be a list")
    options = tuple(_parse_option(entry, where=where) for entry in raw_options)
    if not supported and options:
        raise CapabilitySchemaError(f"{where}: reasoning.options requires reasoning.supported")
    return supported, options


def _parse_provenance(value: Any, *, where: str) -> Mapping[str, str]:
    if value is None:
        return EMPTY_PROVENANCE
    if not isinstance(value, dict):
        raise CapabilitySchemaError(f"{where}: provenance must be an object")
    out: dict[str, str] = {}
    for key, entry in value.items():
        if str(entry) not in CAPABILITY_PROVENANCES:
            raise CapabilitySchemaError(f"{where}: provenance.{key} has unknown value {entry!r}")
        out[str(key)] = str(entry)
    return out


def _parse_modalities(value: Any, *, where: str, name: str) -> tuple[str, ...] | None:
    """模态数组：键缺失是「未声明」（``None``），显式空数组是录入错误。

    两者不能合并成一回事：前者要让 ``apply_capability`` 打未确认标记并在就近覆盖时保留
    基线值，后者会把「没说」伪装成「说了：什么都不支持」。
    """

    if value is None:
        return None
    items = _string_list(value, where=where, name=name, allowed=MODALITY_KINDS)
    if not items:
        raise CapabilitySchemaError(f"{where}: {name} must not be empty")
    return items


def _parse_entry(wire_model: str, value: Any, *, where: str) -> ModelCapability:
    if not isinstance(value, dict):
        raise CapabilitySchemaError(f"{where}: entry must be an object")
    limits_value = value.get("limits") or {}
    if not isinstance(limits_value, dict):
        raise CapabilitySchemaError(f"{where}: limits must be an object")
    limits = {
        key: _positive_int(limits_value.get(key), where=where, name=f"limits.{key}")
        for key in LIMIT_KEYS
    }
    modalities_value = value.get("modalities") or {}
    if not isinstance(modalities_value, dict):
        raise CapabilitySchemaError(f"{where}: modalities must be an object")
    supported, options = _parse_reasoning(value.get("reasoning"), where=where)
    status = _text(value.get("status")) or MODEL_STATUS_ACTIVE
    if status not in MODEL_STATUSES:
        raise CapabilitySchemaError(f"{where}: unknown status {status!r}")
    long_context_value = value.get("long_context")
    long_context = None
    if long_context_value is not None:
        if not isinstance(long_context_value, dict):
            raise CapabilitySchemaError(f"{where}: long_context must be an object or null")
        long_context = _positive_int(
            long_context_value.get("context"), where=where, name="long_context.context"
        )
    raw_source = value.get("source")
    source: Mapping[str, Any] = raw_source if isinstance(raw_source, Mapping) else {}
    return ModelCapability(
        wire_model=wire_model,
        limits=limits,
        input_modalities=_parse_modalities(
            modalities_value.get("input"), where=where, name="modalities.input"
        ),
        output_modalities=_parse_modalities(
            modalities_value.get("output"), where=where, name="modalities.output"
        ),
        reasoning_supported=supported,
        reasoning_options=options,
        long_context=long_context,
        status=status,
        provenance=_parse_provenance(value.get("provenance"), where=where),
        source_url=str(source.get("url") or ""),
        retrieved=str(source.get("retrieved") or ""),
        release_date=_date_text(value.get(RELEASE_DATE_KEY), where=where, name=RELEASE_DATE_KEY),
        last_updated=_date_text(value.get(LAST_UPDATED_KEY), where=where, name=LAST_UPDATED_KEY),
        notes=tuple(str(entry) for entry in (value.get("notes") or ())),
    )


def _validate_document(document: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    """校验顶层结构，返回已收窄的 ``(models, connections)``。"""

    if document.get("schema_version") != CAPABILITY_SCHEMA_VERSION:
        raise CapabilitySchemaError(
            f"unsupported schema_version {document.get('schema_version')!r}"
        )
    models = document.get("models")
    connections = document.get("connections")
    if not isinstance(models, dict) or not models:
        raise CapabilitySchemaError("models must be a non-empty object")
    if not isinstance(connections, dict):
        raise CapabilitySchemaError("connections must be an object")
    for key in connections:
        lane, _, model = str(key).partition(":")
        if not lane or not model:
            raise CapabilitySchemaError(
                f"connections key {key!r} must be '<connection>:<wire model>'"
            )
        if model.strip().lower() not in models:
            raise CapabilitySchemaError(f"connections key {key!r} has no baseline model entry")
    return models, connections


@dataclass(frozen=True)
class CapabilityRegistry:
    """已校验的能力声明；解析只做精确匹配，不做名字猜测。"""

    models: Mapping[str, ModelCapability]
    connections: Mapping[str, ModelCapability]

    def lookup(self, wire_model: str, connection: str = "") -> ModelCapability:
        model = str(wire_model or "").strip().lower()
        lane = str(connection or "").strip().lower()
        baseline = self.models.get(model)
        override = self.connections.get(f"{lane}:{model}") if lane else None
        if baseline is None and override is None:
            return ModelCapability(wire_model=model, declared=False)
        if baseline is None:
            return (
                override
                if override is not None
                else ModelCapability(wire_model=model, declared=False)
            )
        if override is None:
            return baseline
        return _merge(baseline, override)


def _merge_options(
    baseline: tuple[ReasoningOption, ...] | None,
    override: tuple[ReasoningOption, ...] | None,
) -> tuple[ReasoningOption, ...] | None:
    """思考形态按 ``kind`` 逐项就近覆盖，而不是整段替换。

    整段替换会凭空丢掉一个真能生效的旋钮：网关数据面是裸字节透传（只改 ``model`` 字段），
    所以厂商的 ``enable_thinking`` / ``thinking_budget`` 在我方网关坐标上照样有效，就近覆盖
    新声明一个 effort 形态时二者应当并存。``None`` 才是「没覆盖」；显式空集合是「就近声明
    无可调形态」（如仅思考、不可关的模型），必须能表达。
    """

    if override is None:
        return baseline
    if not override:
        return ()
    replaced = {option.kind for option in override}
    kept = tuple(option for option in (baseline or ()) if option.kind not in replaced)
    return tuple(override) + kept


def _merge(baseline: ModelCapability, override: ModelCapability) -> ModelCapability:
    limits = dict(baseline.limits)
    for key, value in override.limits.items():
        if value is not None:
            limits[key] = value
    provenance = dict(baseline.provenance)
    provenance.update(override.provenance)
    return ModelCapability(
        wire_model=baseline.wire_model,
        limits=limits,
        input_modalities=override.input_modalities or baseline.input_modalities,
        output_modalities=override.output_modalities or baseline.output_modalities,
        reasoning_supported=(
            baseline.reasoning_supported
            if override.reasoning_supported is None
            else override.reasoning_supported
        ),
        reasoning_options=_merge_options(baseline.reasoning_options, override.reasoning_options),
        long_context=(
            baseline.long_context if override.long_context is None else override.long_context
        ),
        status=override.status if override.status != MODEL_STATUS_ACTIVE else baseline.status,
        provenance=provenance,
        source_url=override.source_url or baseline.source_url,
        retrieved=override.retrieved or baseline.retrieved,
        release_date=override.release_date or baseline.release_date,
        last_updated=override.last_updated or baseline.last_updated,
        notes=baseline.notes + override.notes,
    )


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """拒绝重复键：``json.loads`` 默认静默后写覆盖，会让一条声明悄悄消失。"""

    keys = [key for key, _ in pairs]
    if len(set(keys)) != len(keys):
        duplicated = sorted({key for key in keys if keys.count(key) > 1})
        raise CapabilitySchemaError(
            f"duplicate keys in capabilities document: {', '.join(duplicated)}"
        )
    return dict(pairs)


def _parse_document(document: Any, origin: str) -> CapabilityRegistry:
    """校验并解析一份完整文档（``{schema_version, models, connections}``）成注册表。

    ``origin`` 只用于报错定位（单文件名，或聚合时的目录/glob 标识）。
    """

    if not isinstance(document, dict):
        raise CapabilitySchemaError(f"{origin}: top level must be an object")
    models, connections = _validate_document(document)
    parsed_models = {
        str(key)
        .strip()
        .lower(): _parse_entry(str(key).strip().lower(), entry, where=f"{origin}: models.{key}")
        for key, entry in models.items()
    }
    parsed_connections = {
        str(key)
        .strip()
        .lower(): _parse_entry(
            str(key).partition(":")[2].strip().lower(),
            entry,
            where=f"{origin}: connections.{key}",
        )
        for key, entry in connections.items()
    }
    for key, entry in parsed_models.items():
        _check_long_context(
            entry.long_context,
            entry.limits.get(CONTEXT_LIMIT_KEY),
            where=f"{origin}: models.{key}",
        )
    for key, entry in parsed_connections.items():
        baseline = parsed_models[key.partition(":")[2]]
        _check_long_context(
            entry.long_context,
            entry.limits.get(CONTEXT_LIMIT_KEY) or baseline.limits.get(CONTEXT_LIMIT_KEY),
            where=f"{origin}: connections.{key}",
        )
    return CapabilityRegistry(models=parsed_models, connections=parsed_connections)


def _read_document(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_no_duplicate_keys)


def load_registry(path: Path) -> CapabilityRegistry:
    """读取并校验单份声明文件；任何不自洽都在此处抛出，不静默修正。"""

    return _parse_document(_read_document(path), path.name)


def load_registry_dir(directory: Path = CAPABILITY_DIR) -> CapabilityRegistry:
    """聚合 ``capabilities.<provider>.json`` 多文件为一个注册表。

    跨文件出现同一 wire id 即报错（一个模型只能归属一个提供商文件，重复声明会让某条
    静默覆盖另一条）；每个文件各自带 ``schema_version``，``connections`` 段可省略。
    """

    files = sorted(directory.glob(CAPABILITY_GLOB))
    if not files:
        raise CapabilitySchemaError(f"no {CAPABILITY_GLOB} files under {directory}")
    merged_models: dict[str, Any] = {}
    merged_connections: dict[str, Any] = {}
    for path in files:
        document = _read_document(path)
        if not isinstance(document, dict):
            raise CapabilitySchemaError(f"{path.name}: top level must be an object")
        if document.get("schema_version") != CAPABILITY_SCHEMA_VERSION:
            raise CapabilitySchemaError(
                f"{path.name}: unsupported schema_version {document.get('schema_version')!r}"
            )
        models = document.get("models")
        connections = document.get("connections") or {}
        if not isinstance(models, dict) or not models:
            raise CapabilitySchemaError(f"{path.name}: models must be a non-empty object")
        if not isinstance(connections, dict):
            raise CapabilitySchemaError(f"{path.name}: connections must be an object")
        for key, entry in models.items():
            normalized = str(key).strip().lower()
            if normalized in merged_models:
                raise CapabilitySchemaError(
                    f"{path.name}: model {key!r} is declared in more than one provider file"
                )
            merged_models[normalized] = entry
        for key, entry in connections.items():
            if key in merged_connections:
                raise CapabilitySchemaError(
                    f"{path.name}: connection {key!r} is declared in more than one provider file"
                )
            merged_connections[key] = entry
    merged = {
        "schema_version": CAPABILITY_SCHEMA_VERSION,
        "models": merged_models,
        "connections": merged_connections,
    }
    return _parse_document(merged, f"{directory.name}/{CAPABILITY_GLOB}")


def _check_long_context(long_context: int | None, base_window: int | None, *, where: str) -> None:
    """长上下文版本必须真的比基础窗口大，否则它是一个多余的别名。"""

    if long_context is not None and base_window is not None and long_context <= base_window:
        raise CapabilitySchemaError(
            f"{where}: long_context edition is not larger than the base window"
        )


@lru_cache(maxsize=1)
def bundled_registry() -> CapabilityRegistry:
    return load_registry_dir(CAPABILITY_DIR)


def reasoning_option(
    options: Sequence[Mapping[str, Any]] | None, kind: str
) -> Mapping[str, Any] | None:
    """按形态取已声明的 option 载荷；``None`` 表示这条坐标上没声明过该形态。

    出站参数、目录投影和界面控件都靠它查「这个模型到底有没有这种形态」，所以判定点只有
    这一个 —— 否则每处各自遍历一次，就会各猜各的。
    """

    if not options:
        return None
    return next(
        (option for option in options if str(option.get("kind") or "").strip().lower() == kind),
        None,
    )


def option_payload(option: ReasoningOption) -> dict[str, Any]:
    payload: dict[str, Any] = {"kind": option.kind}
    if option.values:
        payload["values"] = list(option.values)
    if option.default is not None:
        payload["default"] = option.default
    if option.minimum is not None:
        payload["min"] = option.minimum
    if option.maximum is not None:
        payload["max"] = option.maximum
    if option.wire:
        payload["wire"] = dict(option.wire)
    return payload


def apply_capability(
    item: dict[str, Any],
    capability: ModelCapability,
    *,
    lane: str = "",
    edition: str = BASE_EDITION,
) -> dict[str, Any]:
    """把声明合并进目录条目：声明了才写值，没声明就删掉该字段并给未确认标记。

    ``edition`` 由调用方按条目实际走的路由传入 —— 同一模型是否另有长上下文路由是模型
    属性，而「这一条目是不是那个版本」是条目属性，混起来会让基础路由也被标成长版本。

    「按名字猜」在这里没有立足点：``image_input``/``pdf_input`` 只由已声明的模态数组
    推导，模态未声明即按不支持处理（fail-closed），与既有个人连接的保守默认一致。
    """

    out = dict(item)
    unresolved: list[str] = []

    out["wire_model"] = capability.wire_model or str(out.get("model_name") or "")
    out[CAPABILITY_DECLARED_KEY] = capability.declared
    if edition not in (BASE_EDITION, LONG_CONTEXT_EDITION):
        raise CapabilitySchemaError(f"unknown context edition {edition!r}")

    if edition == LONG_CONTEXT_EDITION:
        context = capability.long_context
    else:
        context = capability.limits.get(CONTEXT_LIMIT_KEY)
    if context is None:
        out.pop(CONTEXT_WINDOW_KEY, None)
        unresolved.append(CONTEXT_WINDOW_KEY)
    else:
        out[CONTEXT_WINDOW_KEY] = int(context)
    max_output = capability.limits.get(MAX_OUTPUT_LIMIT_KEY)
    if max_output is None:
        out.pop(MAX_OUTPUT_TOKENS_KEY, None)
        unresolved.append(MAX_OUTPUT_TOKENS_KEY)
    else:
        out[MAX_OUTPUT_TOKENS_KEY] = int(max_output)

    if capability.input_modalities is None:
        out.pop(INPUT_MODALITIES_KEY, None)
        out[IMAGE_INPUT_KEY] = False
        out[PDF_INPUT_KEY] = False
        unresolved.append("modalities")
    else:
        modalities = list(capability.input_modalities)
        out[INPUT_MODALITIES_KEY] = modalities
        out.update(modality_flags(modalities))
    if capability.output_modalities is not None:
        out[OUTPUT_MODALITIES_KEY] = list(capability.output_modalities)

    if capability.reasoning_options is None:
        out.pop(REASONING_EFFORTS_KEY, None)
        out[REASONING_OPTIONS_KEY] = None
        unresolved.append("reasoning")
    else:
        out[REASONING_OPTIONS_KEY] = [
            option_payload(option) for option in capability.reasoning_options
        ]
        out[REASONING_EFFORTS_KEY] = list(capability.effort_values or ())

    out[CONTEXT_EDITION_KEY] = edition
    out[CAPABILITY_STATUS_KEY] = capability.status
    out[CAPABILITY_PROVENANCE_KEY] = dict(capability.provenance)
    if unresolved:
        out[CAPABILITY_REASON_KEY] = ";".join(
            unverified_reason(field_name, lane) for field_name in unresolved
        )
    else:
        out.pop(CAPABILITY_REASON_KEY, None)
    return out
