"""Declared thinking-form policy: the only maker of outbound thinking parameters.

proposal 78 §9.4。输入是目录条目上已声明的 ``reasoning_options`` 载荷（来自按提供商拆分的
``capabilities.<provider>.json`` 的 ``(连接, wire model)`` 坐标）+ 上游协议 + provider 家族，
输出是这次请求要带的参数。模型名字在这里不再产出任何真值（I1）：没声明控制形态，
就不发参数并留下原因，而不是按名字猜一个厂商扩展参数。

三条出站腿共用本模块：一次性/资源调用的 HTTP encoder（``service/inference/transport.py``）、
会话主路径的 Responses→Chat bridge（``service/chat/service/completions.py``）、
以及桌面/设置页要展示的「这个模型到底能怎么调思考」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from scholarseed_runtime.contract import ModelThinking, ModelWireProtocol
from service.settings.capabilities import (
    BUDGET_FORM,
    EFFORT_FORM,
    REASONING_EFFORT_LEVELS,
    TOGGLE_FORM,
    reasoning_option,
)

# §9.1 的两轴语义：``off`` 表示「关掉」这件事由省略参数表达，``none`` 是厂商真实存在的
# 一个档位值，必须照发。两者都算「有显式关闭能力」。
OFF_EFFORT_VALUES = ("off",)
DISABLE_EFFORT_VALUES = ("none",)
# 声明里没写 ``wire`` 名时按 provider 家族补的**公开协议字段名**。这是协议自己的形状
# （OpenAI 兼容端点的档位字段就叫 reasoning_effort），不是对某个模型能力的猜测。
FAMILY_EFFORT_WIRE: Mapping[str, Mapping[str, str]] = {
    "openai": {
        ModelWireProtocol.CHAT_COMPLETIONS.value: "reasoning_effort",
        ModelWireProtocol.RESPONSES.value: "reasoning.effort",
    }
}
NESTED_NAME_SEPARATOR = "."
# 两条协议上档位字段的公开名字；即使本条坐标没声明档位形态也要一起摘掉残留值。
STANDARD_THINKING_NAMES = ("reasoning_effort", "reasoning.effort")
TOGGLE_OFF_VALUE = False
MINIMUM_UNAVAILABLE = "reasoning_minimum_unavailable"
MINIMUM_CLAMPED = "reasoning_effort_clamped"
MINIMUM_APPLIED = "reasoning_minimum_applied"
NO_REASONING_FORM = "reasoning_form_undeclared"
THINKING_FIXED = "reasoning_fixed_on"
BUDGET_RANGE_UNDECLARED = "reasoning_budget_range_undeclared"


@dataclass(frozen=True)
class ThinkingParameters:
    """一组要发出去的思考参数，外加「有没有被改过」的可观测信息。

    ``adjusted`` 为真表示实发值与来意不一致（吸附、或压根没有控制形态可发），调用方据此
    发事件与提示，而不是让用户自己猜为什么选了 high 却跑了 medium。
    """

    parameters: Mapping[str, Any]
    effort: str = ""
    adjusted: bool = False
    reason: str = ""


@dataclass(frozen=True)
class UserModelOverride:
    """用户对单个 provider/model 坐标的可选覆盖。"""

    effort: str = ""
    thinking: ModelThinking | None = None


def resolve_reasoning_options(
    capability: Sequence[Mapping[str, Any]] | None,
    override: UserModelOverride | None = None,
) -> tuple[Sequence[Mapping[str, Any]] | None, UserModelOverride]:
    """Resolve the policy input without allowing overrides to mutate the capability truth."""

    return capability, override or UserModelOverride()


def wire_parameters(name: str, value: Any) -> dict[str, Any]:
    """把 ``reasoning.effort`` 这类点号参数名展开成嵌套请求字段。"""

    parts = [part for part in str(name).split(NESTED_NAME_SEPARATOR) if part]
    if not parts:
        raise ValueError(f"reasoning wire name {name!r} is empty")
    payload: dict[str, Any] = {parts[-1]: value}
    for part in reversed(parts[:-1]):
        payload = {part: payload}
    return payload


def option_wire(option: Mapping[str, Any] | None, protocol: str, family: str) -> str:
    """该形态在这条协议上的参数名；拿不到就返回空串（= 不发这个形态）。

    条目**声明过** ``wire`` 时只认它：这条协议上没列出即「该形态在这条协议上不可用」，
    绝不再落回家族默认 —— 静默回落正是把 ``enable_thinking`` 发成 ``reasoning_effort``
    的成因。只有完全没声明 ``wire``（个人车道用户自填档位）才用家族的公开字段名。
    """

    if not option:
        return ""
    declared = option.get("wire")
    if isinstance(declared, Mapping) and declared:
        return str(declared.get(protocol) or "").strip()
    return str(FAMILY_EFFORT_WIRE.get(str(family or "").strip().lower(), {}).get(protocol) or "")


def declared_effort_values(options: Sequence[Mapping[str, Any]] | None) -> tuple[str, ...]:
    """档位形态声明了哪些值；没有档位形态时是空元组。"""

    option = reasoning_option(options, EFFORT_FORM)
    if option is None:
        return ()
    return tuple(str(value).strip().lower() for value in option.get("values") or ())


def minimum_effort(options: Sequence[Mapping[str, Any]] | None) -> str:
    """声明里可用的最低档，按 ``REASONING_EFFORT_LEVELS`` 的强度序取。

    顺序只在这份全集里定义一次；这里不排新序，所以新增档位不需要改本模块。
    """

    values = set(declared_effort_values(options))
    for level in REASONING_EFFORT_LEVELS:
        if level in values:
            return level
    return ""


def default_effort(options: Sequence[Mapping[str, Any]] | None) -> str:
    """这条坐标的**确定默认档**：模型定义声明的 ``default``，没声明就取最低档。

    「跟随 provider 默认」这一档已被产品去除：默认思考强度必须是一个可展示、可预期的
    具体档位。声明了 ``default`` 但不在 ``values`` 里属于录入不自洽（加载期已拒绝），
    这里仍防御性地回落到最低档而不是发一个模型没声明的值。
    """

    option = reasoning_option(options, EFFORT_FORM)
    if option is None:
        return ""
    declared = str(option.get("default") or "").strip().lower()
    values = declared_effort_values(options)
    if declared and declared in values:
        return declared
    return minimum_effort(options)


def effort_parameters(
    options: Sequence[Mapping[str, Any]] | None,
    protocol: str,
    family: str,
    requested: str,
) -> ThinkingParameters:
    """把用户选的档位映射成出站参数；没选或越界都落到**确定默认档**（§9.4）。

    确定默认档 = 模型定义声明的 ``default``，没声明取最低可用档（``default_effort``）。
    「跟随 provider 默认」不再是可达状态：吸附目标必须可展示、可预期，不学 Codex 那样
    隐式取列表中间档。连默认档都解析不出（无档位形态/该协议没有 wire 名）时不发参数并
    标 ``adjusted``。
    """

    option = reasoning_option(options, EFFORT_FORM)
    values = declared_effort_values(options)
    wanted = str(requested or "").strip().lower()
    name = option_wire(option, protocol, family)
    if not values or not name:
        if wanted:
            return ThinkingParameters({}, adjusted=True, reason=NO_REASONING_FORM)
        # 「没选」且这条坐标没有档位形态可发：保持不发参数（开关/预算形态另有入口）。
        return ThinkingParameters({})
    if wanted and wanted in values:
        return ThinkingParameters(wire_parameters(name, wanted), effort=wanted)
    fallback = default_effort(options)
    if not fallback:
        return ThinkingParameters({}, adjusted=True, reason=MINIMUM_UNAVAILABLE)
    if wanted:
        return ThinkingParameters(
            wire_parameters(name, fallback), effort=fallback, adjusted=True, reason=MINIMUM_CLAMPED
        )
    return ThinkingParameters(wire_parameters(name, fallback), effort=fallback)


def outbound_names(
    options: Sequence[Mapping[str, Any]] | None, protocol: str, family: str
) -> tuple[str, ...]:
    """这条协议上该模型可能出现的思考参数名。

    残留值必须一起清掉：网关侧 note 记过一次「上一次选择的档位会继续生效」，只覆盖自己
    那一个名字不够。
    """

    names = {
        name
        for kind in (EFFORT_FORM, TOGGLE_FORM, BUDGET_FORM)
        if (name := option_wire(reasoning_option(options, kind), protocol, family))
    }
    names.update(STANDARD_THINKING_NAMES)
    return tuple(sorted(names))


def strip_thinking(request: dict[str, Any], names: Sequence[str]) -> dict[str, Any]:
    """按点号路径删掉这些思考参数；父对象被删空时一并删掉。"""

    out = dict(request)
    for name in names:
        parts = [part for part in name.split(NESTED_NAME_SEPARATOR) if part]
        if not parts:
            continue
        current: Any = out
        parents: list[tuple[Any, str]] = []
        for part in parts[:-1]:
            if not isinstance(current, dict) or part not in current:
                current = None
                break
            parents.append((current, part))
            current = current[part]
        if not isinstance(current, dict):
            continue
        current.pop(parts[-1], None)
        for parent, key in reversed(parents):
            if parent[key]:
                break
            parent.pop(key, None)
    return out


def apply_thinking(
    request: dict[str, Any],
    options: Sequence[Mapping[str, Any]] | None,
    protocol: str,
    family: str,
    resolution: ThinkingParameters,
) -> dict[str, Any]:
    """先清掉这条协议上所有可能的思考参数，再按声明实发。"""

    out = strip_thinking(request, outbound_names(options, protocol, family))
    out.update(
        {key: value for key, value in resolution.parameters.items() if not isinstance(value, dict)}
    )
    for key, value in resolution.parameters.items():
        if isinstance(value, dict):
            merged = dict(out.get(key) or {}) if isinstance(out.get(key), Mapping) else {}
            merged.update(value)
            out[key] = merged
    return out


def sanitize_outbound_reasoning(
    request: dict[str, Any],
    options: Sequence[Mapping[str, Any]] | None,
    protocol: str,
    family: str,
    resolution: ThinkingParameters,
) -> dict[str, Any]:
    """OpenCode-style final boundary: remove stale fields, then apply one resolution."""

    return apply_thinking(request, options, protocol, family, resolution)


def thinking_parameters(
    options: Sequence[Mapping[str, Any]] | None,
    protocol: str,
    family: str,
    *,
    effort: str = "",
    thinking: ModelThinking | None = None,
) -> ThinkingParameters:
    """会话主路径的意图入口：按这条坐标声明的形态把用户意图翻成出站参数。

    档位形态走 ``reasoning_effort``；开关/预算形态走 ``ModelThinking``。两者由声明互斥，
    所以这里不存在「同一事实两份记录」。预算形态在声明没给区间时**只发开关不发数值** ——
    厂商文档两处口径互相矛盾且未决，编一个数就是假权威。
    """

    if thinking is None:
        return effort_parameters(options, protocol, family, effort)
    if thinking.enabled is not None:
        toggle = reasoning_option(options, TOGGLE_FORM)
        name = option_wire(toggle, protocol, family)
        if not name:
            return ThinkingParameters({}, adjusted=True, reason=NO_REASONING_FORM)
        return ThinkingParameters(wire_parameters(name, thinking.enabled))
    if thinking.budget is not None:
        budget = reasoning_option(options, BUDGET_FORM)
        name = option_wire(budget, protocol, family)
        minimum = (budget or {}).get("min")
        maximum = (budget or {}).get("max")
        if not name:
            return ThinkingParameters({}, adjusted=True, reason=NO_REASONING_FORM)
        if minimum is None or maximum is None:
            return ThinkingParameters({}, adjusted=True, reason=BUDGET_RANGE_UNDECLARED)
        requested = int(thinking.budget)
        amount = min(max(requested, int(minimum)), int(maximum))
        return ThinkingParameters(
            wire_parameters(name, amount),
            effort=str(amount),
            adjusted=amount != requested,
            reason=MINIMUM_CLAMPED if amount != requested else "",
        )
    return ThinkingParameters({})


def require_declared_effort(options: Sequence[Mapping[str, Any]] | None, requested: str) -> None:
    """一次性调用要求了该坐标没声明的档位 → 直接失败并列出支持值（§9.4）。

    主对话路径吸附到 ``default`` 是有理由的：界面上看得见当前值。一次性调用没有这个回路，
    静默降档等于让调用方以为拿到了自己要求的档。模型压根没声明档位形态时不拒绝 —— 那时
    「支持哪些」我们没有判据，拒绝等于用猜测当准入。
    """

    values = declared_effort_values(options)
    wanted = str(requested or "").strip().lower()
    if not values or not wanted or wanted in values:
        return
    raise ValueError(
        f"reasoning effort {wanted!r} is not declared for this model; supported: "
        f"{', '.join(values)}"
    )


def fixed_on(options: Sequence[Mapping[str, Any]] | None) -> bool:
    """声明了「思考固定开启、无可调形态」：``supported`` 为真但形态列表是空集合。

    这一态既不能隐藏控件（会被读成不支持），也没有任何可发的关闭参数。
    """

    return options is not None and not options


def minimum_parameters(
    options: Sequence[Mapping[str, Any]] | None,
    protocol: str,
    family: str,
) -> ThinkingParameters:
    """尽量关闭思考：none → off → 关闭开关 → 最低档 → 最低预算 → 不发。

    阶梯只读声明，所以同一份数据同时决定「能不能关」和「怎么关」；未声明形态的模型一律
    不发厂商扩展参数（fail-open 到 provider 默认），与目录层的 fail-closed 方向一致。
    """

    if options is None:
        return ThinkingParameters({}, adjusted=True, reason=NO_REASONING_FORM)
    if fixed_on(options):
        return ThinkingParameters({}, adjusted=True, reason=THINKING_FIXED)
    effort_option = reasoning_option(options, EFFORT_FORM)
    values = declared_effort_values(options)
    effort_name = option_wire(effort_option, protocol, family)
    if effort_name:
        for marker in DISABLE_EFFORT_VALUES:
            if marker in values:
                return ThinkingParameters(
                    wire_parameters(effort_name, marker), effort=marker, reason=MINIMUM_APPLIED
                )
        for marker in OFF_EFFORT_VALUES:
            if marker in values:
                # ``off`` 的语义就是「不发思考参数」，此时 provider 默认即最低延迟。
                return ThinkingParameters({}, effort=marker, reason=MINIMUM_APPLIED)
    toggle_option = reasoning_option(options, TOGGLE_FORM)
    toggle_name = option_wire(toggle_option, protocol, family)
    if toggle_name:
        return ThinkingParameters(
            wire_parameters(toggle_name, TOGGLE_OFF_VALUE), reason=MINIMUM_APPLIED
        )
    if effort_name and values:
        lowest = minimum_effort(options)
        if lowest:
            return ThinkingParameters(
                wire_parameters(effort_name, lowest),
                effort=lowest,
                adjusted=True,
                reason=MINIMUM_CLAMPED,
            )
    budget_option = reasoning_option(options, BUDGET_FORM)
    budget_name = option_wire(budget_option, protocol, family)
    if budget_name:
        minimum = (budget_option or {}).get("min")
        maximum = (budget_option or {}).get("max")
        if minimum is None or maximum is None:
            return ThinkingParameters({}, adjusted=True, reason=BUDGET_RANGE_UNDECLARED)
        return ThinkingParameters(
            wire_parameters(budget_name, int(minimum)),
            effort=str(minimum),
            reason=MINIMUM_APPLIED,
        )
    return ThinkingParameters({}, adjusted=True, reason=MINIMUM_UNAVAILABLE)
