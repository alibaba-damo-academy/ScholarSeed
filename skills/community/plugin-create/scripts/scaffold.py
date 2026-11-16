"""Create editable local plugin sources; never install or execute the result."""

from __future__ import annotations

import argparse
import json
import shutil
from importlib.metadata import version
from pathlib import Path

from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR, PluginDescriptor
from service.capabilities.service.ui import UI_COMPATIBILITY

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
KINDS = {
    "selection": ("scope",),
    "comparison": ("scope", "decision"),
    "stages": ("scope", "review"),
}
ANSWER = {
    "type": "object",
    "required": ["selected"],
    "properties": {
        "selected": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": 1,
            "uniqueItems": True,
        },
        "fields": {"type": "object", "additionalProperties": {"type": "string"}},
    },
    "additionalProperties": False,
}
INPUT = {
    "type": "object",
    "required": ["title", "choices", "actions"],
    "properties": {
        "title": {"type": "string"},
        "lead": {"type": "string"},
        "description": {"type": "string"},
        "choices": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "label"],
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "description": {"type": "string"},
                    "values": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["label", "value"],
                            "properties": {
                                "label": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "additionalProperties": False,
                        },
                    },
                    "evidence": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "selected": {"type": "array", "items": {"type": "string"}},
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "label"],
                "properties": {
                    "id": {"type": "string"},
                    "label": {"type": "string"},
                    "placeholder": {"type": "string"},
                    "value": {"type": "string"},
                },
                "additionalProperties": False,
            },
        },
        "actions": {"type": "array", "items": {"enum": ["confirm", "revise", "finish"]}},
        "action_labels": {
            "type": "object",
            "properties": {
                action: {"type": "string", "minLength": 1}
                for action in ("confirm", "revise", "finish")
            },
            "additionalProperties": False,
        },
    },
    "additionalProperties": False,
}
REQUESTS_DIRECTORY = "requests"
PREVIEW_TITLES = {
    "scope": "本轮复核哪些结果？",
    "decision": "确认要保留的比较项",
    "review": "确认要交付的复核结果",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=KINDS)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--host", default=f"=={version('scholarseed')}")
    parser.add_argument("--workbench", action="store_true")
    args = parser.parse_args()
    components = []
    for component in KINDS[args.kind]:
        actions = ["confirm"] if component == "scope" else ["revise", "finish"]
        components.append(
            {
                "id": component,
                "slot": f"{args.name}.{component}",
                "entry": "card.js",
                **({"workbench": True} if args.workbench else {}),
                "preview": f"{component}.json",
                "input_schema": INPUT,
                "output_schema": ANSWER,
                "actions": [
                    {"id": action, "capability": "interaction.answer", "input_schema": ANSWER}
                    for action in actions
                ],
            }
        )
    descriptor = {
        "schema": 2,
        "id": args.name,
        "version": args.version,
        "host": args.host,
        "skill": "SKILL.md",
        "capabilities": ["interaction.answer"],
        "ui": {
            "compatibility": UI_COMPATIBILITY,
            "exports": ["React", "Button", "Checkbox", "Input", "mount"],
        },
        "components": components,
    }
    PluginDescriptor.model_validate(descriptor)
    args.destination.mkdir(parents=True, exist_ok=False)
    (args.destination / PLUGIN_DESCRIPTOR).write_text(
        json.dumps(descriptor, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    shutil.copyfile(TEMPLATES / "card.js", args.destination / "card.js")
    workflow = (TEMPLATES / f"{args.kind}.md").read_text(encoding="utf-8")
    request_links = "\n".join(
        f"- {component['id']}: [{component['slot']}]({REQUESTS_DIRECTORY}/{component['id']}.json)"
        for component in components
    )
    workflow += (
        "\n## 验收与证据\n\n"
        "发布结果前检查本轮关键值与实际来源对应。对适用的缺材料或状态切换，"
        "用任务样例核对关键事实及边界。确认后从宿主实际回传消费最新值，"
        "再核对可见结果、导出与来源一致。交付材料先给结论或下一步，"
        "把证据定位放在对应条目，长原文与推导放进详情或附录。"
        "草稿、样例及取消结果不用于交付。\n"
    )
    workflow += (
        "\n## 本包组件调用载荷\n\n"
        "以下文件是本包实际描述符对应的 request 载荷，不是工具外层信封。"
        "生成时将样例选项替换成任务数据，并同步维护描述符、预览和这些文件。"
        "运行时读取所需载荷，保留必填 title、actions 和动作字符串类型；"
        "仅生成本次 JSON 数据，复用已安装的 UI 代码和输入契约；"
        "以真实材料映射更新 data，用新 request_id 表示新步骤。"
        "通过 scholarseed_bridge 的 component/request 发起交互，"
        "不要重新猜字段或把按钮对象放入 actions。\n\n"
        f"{request_links}\n"
    )
    (args.destination / "SKILL.md").write_text(
        f'---\nname: {args.name}\nversion: "{args.version}"\ndescription: Editable research workflow template; customize before use.\n---\n\n{workflow}',
        encoding="utf-8",
    )
    (args.destination / REQUESTS_DIRECTORY).mkdir()
    for component in components:
        responses = {
            action["id"]: {"state": "resolved", "data": {"selected": {"$input": "selected"}}}
            for action in component["actions"]
        }
        scenario = {
            "data": {
                "title": PREVIEW_TITLES[component["id"]],
                "lead": "总体与分组结果均增加",
                "choices": [
                    {
                        "id": "sample",
                        "label": "总体通过率",
                        "values": [
                            {"label": "此前", "value": "62%"},
                            {"label": "本轮", "value": "66%"},
                        ],
                        "evidence": "研究报告第 3 节，表 1。两轮采用同一通过标准。",
                    },
                    {
                        "id": "subgroup",
                        "label": "完成随访的分组",
                        "values": [
                            {"label": "此前", "value": "58%"},
                            {"label": "本轮", "value": "60%"},
                        ],
                        "description": "样本较少",
                        "evidence": "研究报告第 3 节，表 2，完成随访组。",
                    },
                ],
                "action_labels": {
                    action: {
                        "confirm": "确认复核范围",
                        "revise": "调整复核范围",
                        "finish": "提交复核结果",
                    }[action]
                    for action in responses
                },
                "selected": [],
                "actions": list(responses),
            },
            "responses": responses,
            "submissions": {action: [{"selected": ["sample"]}] for action in responses},
            "cases": [
                {
                    "label": "窄工作台长标签和缺少基线",
                    "data": {
                        "lead": "本轮总体通过率为 66%",
                        "choices": [
                            {
                                "id": "sample",
                                "label": "总体通过率",
                                "values": [
                                    {"label": "此前", "value": "62%（496 / 800）"},
                                    {"label": "本轮", "value": "66%（528 / 800）"},
                                ],
                            },
                            {
                                "id": "subgroup",
                                "label": "仅纳入已完成六个月随访的受试者的结果",
                                "values": [
                                    {"label": "此前", "value": "待补材料"},
                                    {"label": "本轮", "value": "60%（27 / 45）"},
                                ],
                                "description": "两轮差值待核对",
                                "evidence": "本轮见研究报告第 3 节，表 2。",
                            }
                        ],
                    },
                },
                {
                    "label": "失败后重试",
                    "responses": {
                        action: {
                            **response,
                            "steps": [{"state": "failed", "data": {"error": "sample_failure"}}],
                        }
                        for action, response in responses.items()
                    },
                },
                {
                    "label": "取消",
                    "responses": {
                        action: {"state": "cancelled", "data": {}} for action in responses
                    },
                },
                {
                    "label": "结果未知",
                    "responses": {
                        action: {"state": "failed", "data": {"outcome": "unknown"}}
                        for action in responses
                    },
                },
            ],
        }
        (args.destination / component["preview"]).write_text(
            json.dumps(scenario, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        request = {
            "request_id": f"{component['id']}-r1",
            "slot": component["slot"],
            "title": scenario["data"]["title"],
            "prompt": scenario["data"]["title"],
            "data": scenario["data"],
        }
        (args.destination / REQUESTS_DIRECTORY / f"{component['id']}.json").write_text(
            json.dumps(request, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(
        json.dumps(
            {
                "source": str(args.destination),
                "slots": [component["slot"] for component in components],
                "ready_for_delivery": False,
            }
        )
    )


if __name__ == "__main__":
    main()
