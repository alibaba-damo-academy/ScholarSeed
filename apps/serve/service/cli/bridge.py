"""Agent-facing CLI for scoped ScholarSeed product capabilities."""

from __future__ import annotations

import argparse
import json
import sys

import httpx
from pydantic import ValidationError

from service.platform.bridge import (
    ANNOTATIONS_OPERATION,
    BLOCKING_CHECKPOINTS,
    BLOCKING_OPERATIONS,
    BRIDGE_COMMAND,
    BRIDGE_REQUESTS,
    COMPONENT_CAPABILITY,
    HISTORY_REQUESTS,
    LITERATURE_REQUESTS,
    PDF_REQUESTS,
    PLAN_REQUESTS,
    RESOURCE_REQUESTS,
    DisplayCard,
    TaskActivate,
)
from service.platform.channel import BridgeResponseError, decode, request

EXIT_FAILURE = 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog=BRIDGE_COMMAND,
        description="书深 Agent 内部作用域接口。可查询会话历史和当前项目资料、登记文件产物或展示业务卡片。",
    )
    groups = root.add_subparsers(dest="capability")
    history = groups.add_parser(
        "history", help="列出、检索和补读当前范围的历史会话；无历史返回空数组"
    )
    verbs = history.add_subparsers(dest="operation")
    descriptions = {
        "list": "列出近期历史会话（不含正文）。示例：--json '{\"limit\":5}'；用 cursor 续页。",
        "search": '搜索相关消息。示例：--json \'{"query":"方案","limit":5}\'；用 cursor 续页。',
        "read": '补读消息或最近一页。示例：--json \'{"session_id":"...","limit":5}\'；'
        "也可传 message_id/before/after，或返回的 cursor 继续读取。",
    }
    for name, history_request in HISTORY_REQUESTS.items():
        command = verbs.add_parser(name, help=descriptions[name], description=descriptions[name])
        command.add_argument(
            "--json", required=True, help="请求 JSON；凭证由产品环境提供，不放入参数"
        )
        command.epilog = json.dumps(history_request.model_json_schema(), ensure_ascii=False)
    artifact = groups.add_parser("artifact", help="发布本轮已生成的独立文件产物")
    artifact_verbs = artifact.add_subparsers(dest="operation")
    publish_request = BRIDGE_REQUESTS[("artifact", "publish")].request_type
    publish = artifact_verbs.add_parser(
        "publish",
        help="登记一个已写入当前会话工作目录的文件",
        description="登记一个已写入当前会话工作目录的文件，并在回答中展示产物卡片。",
    )
    publish.add_argument(
        "--json",
        required=True,
        help='请求 JSON。示例：\'{"path":"outputs/report.md","role":"final"}\'',
    )
    publish.epilog = json.dumps(publish_request.model_json_schema(), ensure_ascii=False)
    pdf = groups.add_parser("pdf", help="读取本轮获准的 PDF 原文并取得可点击引用")
    pdf_verbs = pdf.add_subparsers(dest="operation")
    for name, pdf_request in PDF_REQUESTS.items():
        command = pdf_verbs.add_parser(name)
        command.add_argument(
            "--json", required=True, help="list 返回 ref_id；read/search 返回原文及 citation_url"
        )
        command.epilog = json.dumps(pdf_request.model_json_schema(), ensure_ascii=False)
    plan = groups.add_parser("plan", help="读取或更新显式主计划与子计划")
    plan_verbs = plan.add_subparsers(dest="operation")
    for name, plan_request in PLAN_REQUESTS.items():
        command = plan_verbs.add_parser(
            name, help="get 取得当前 turn/version；write 提交完整计划树"
        )
        command.add_argument(
            "--json", required=True, help="父节点用 parent_id 明确关联；普通 update 不改变主阶段"
        )
        command.epilog = json.dumps(plan_request.model_json_schema(), ensure_ascii=False)
    plan.set_defaults(capability_parser=plan)
    literature = groups.add_parser(
        "literature", help="列出和读取当前项目文献，或展示检索与综述结果"
    )
    literature_verbs = literature.add_subparsers(dest="operation")
    literature_descriptions = {
        "import": "按用户明确指令将已发布会话文件导入当前项目文献库；不弹授权窗口、不重新检索下载。传 artifact_id 或会话工作目录相对 path 二选一。",
        "list": (
            "列出当前会话项目的文献及 PDF 总页数。"
            "示例：--json '{\"limit\":20}'；"
            "用 next_offset 续页。"
        ),
        "read": (
            "按 1-based PDF 物理页读取 list 返回的文献，并取得逐页可点击引用。"
            '示例：--json \'{"ref_id":"literature:<id>","start_page":1,"end_page":3}\'。'
        ),
        "authorize": (
            "为当前研究想法任务登记明确的全文候选集合，并返回原生一键授权问题。"
            '示例：--json \'{"authorization_type":"research_idea_fulltext","refs":["literature:<id>"]}\'。'
        ),
        "acquire": (
            "在全文授权通过后由 serve 侧下载指定论文的开放获取全文并托管，"
            "返回可读取的 paper: 引用与逐篇成败证据。"
            '示例：--json \'{"run":"<run 相对会话工作目录>","papers":[{"paper_id":"<id>",'
            '"identifier":"2502.12110","identifier_kind":"arxiv"}]}\'。'
        ),
        "receipt": (
            "查询本回合全文授权的实际生效范围与已托管的论文全文；"
            "run 目录不是真源，阅读前必须以本命令的返回为准。"
            '示例：--json \'{"run":"<run 相对会话工作目录>"}\'。'
        ),
        "delivery": (
            "冻结当前 run 实际获取的全文批次并显示产品保存弹框；不指定目录，不等同于保存成功。"
            '示例：--json \'{"run":"<run 相对会话工作目录>"}\'。'
        ),
        "ingest": (
            "将本轮已获准下载的论文入库并关联当前项目，展示可打开全文的文献卡；"
            "读取 run 清单、校验 PDF 与题录，同一次重试不重复入库；"
            "大结果按 next_cursor 传回 cursor 续页，只读已保存回执。"
            '示例：--json \'{"run":"<run 相对会话工作目录>"}\'。'
        ),
        ANNOTATIONS_OPERATION: (
            "分页读取当前项目或全局文献中的用户标注和阅读笔记；这些内容不是 PDF 引用证据。"
            '示例：--json \'{"ref_id":"literature:<id>","limit":10}\'。'
        ),
        "result": (
            "读取指定精准检索 run 的结果、来源和报告；checkpoint=selection 会等待产品授权决策，不执行检索或下载。"
            "checkpoint=final 会校验已完成的 run，并发布最终报告及其支撑报告。"
            "研究想法任务可对 agentic-search 结果目录使用 checkpoint=candidates，展示候选并等待授权决策。"
        ),
        "review": "读取综述工作区标准产物并发布阶段快照；retrieval 会等待产品授权决策。",
    }
    for name, literature_request in LITERATURE_REQUESTS.items():
        command = literature_verbs.add_parser(
            name,
            help=literature_descriptions.get(name, BRIDGE_REQUESTS[("literature", name)].summary),
            description=literature_descriptions.get(
                name, BRIDGE_REQUESTS[("literature", name)].summary
            ),
        )
        command.add_argument(
            "--json",
            required=True,
            help="请求 JSON；凭证和当前项目由产品会话提供，不放入参数",
        )
        command.epilog = json.dumps(literature_request.model_json_schema(), ensure_ascii=False)
    resource = groups.add_parser("resource", help="访问当前项目资料库文件")
    resource_verbs = resource.add_subparsers(dest="operation")
    for name, resource_request in RESOURCE_REQUESTS.items():
        description = {
            "import": "按用户明确要求将已发布会话文件导入资料库，并保留会话关联。",
            "list": "列出当前会话项目的资料库文件；返回 cursor 可用于续页。",
            "read": "读取当前会话项目资料库或关联根中的一段文件内容。",
        }[name]
        command = resource_verbs.add_parser(
            name,
            help=description,
            description=description,
        )
        command.add_argument(
            "--json",
            required=True,
            help="请求 JSON。示例：'{\"limit\":20}'；凭证和当前项目由产品会话提供",
        )
        command.epilog = json.dumps(resource_request.model_json_schema(), ensure_ascii=False)
    literature.set_defaults(capability_parser=literature)
    resource.set_defaults(capability_parser=resource)
    pdf.set_defaults(capability_parser=pdf)
    root.set_defaults(capability_parser=None)
    search = groups.add_parser("search", help="执行产品网页搜索")
    search_verbs = search.add_subparsers(dest="operation")
    for (capability, operation), entry in BRIDGE_REQUESTS.items():
        if capability != "search":
            continue
        command = search_verbs.add_parser(operation)
        command.add_argument("--json", required=True, help="查询、引擎与结果数量；身份由宿主提供")
        command.epilog = json.dumps(entry.request_type.model_json_schema(), ensure_ascii=False)
    search.set_defaults(capability_parser=search)
    history.set_defaults(capability_parser=history)
    artifact.set_defaults(capability_parser=artifact)
    task = groups.add_parser("task", help="激活当前 turn 的已验证产品任务身份")
    task_verbs = task.add_subparsers(dest="operation")
    activate = task_verbs.add_parser("activate")
    activate.add_argument("--json", required=True, help="由绑定 skill launcher 生成的任务身份")
    activate.epilog = json.dumps(TaskActivate.model_json_schema(), ensure_ascii=False)
    task.set_defaults(capability_parser=task)
    display_card = groups.add_parser(
        "display-card",
        help="在当前对话展示一张经过校验的业务卡片",
        description="在当前对话展示一张经过校验并可恢复的业务卡片。",
    )
    display_card.add_argument(
        "--json",
        required=True,
        help=(
            "请求 JSON。示例："
            '\'{"type":"literature-references",'
            '"content":{"path":"research_ideas/topic/references.json"}}\''
        ),
    )
    display_card.epilog = json.dumps(DisplayCard.model_json_schema(), ensure_ascii=False)
    display_card.set_defaults(capability_parser=display_card, operation="publish")
    component = groups.add_parser(COMPONENT_CAPABILITY, help="查询或使用已启用的对话组件")
    component_verbs = component.add_subparsers(dest="operation")
    for (capability, operation), contract in BRIDGE_REQUESTS.items():
        if capability != COMPONENT_CAPABILITY:
            continue
        command = component_verbs.add_parser(operation, help=contract.summary)
        command.add_argument("--json", required=True, help="组件参数；组件身份及权限由宿主校验")
        command.epilog = json.dumps(contract.request_type.model_json_schema(), ensure_ascii=False)
    component.set_defaults(capability_parser=component)
    return root


def execute(capability: str, operation: str, raw: str) -> dict:
    entry = BRIDGE_REQUESTS[(capability, operation)]
    payload = decode(raw, entry.request_type)
    blocking = (capability, operation) in BLOCKING_OPERATIONS or payload.get(
        "checkpoint"
    ) in BLOCKING_CHECKPOINTS.get((capability, operation), ())
    return request(entry.route, payload, blocking=blocking)


def main(argv: list[str] | None = None) -> int:
    root = parser()
    args = root.parse_args(argv)
    if not args.capability:
        root.print_help()
        return 0
    if not args.operation:
        args.capability_parser.print_help()
        return 0
    try:
        result = execute(args.capability, args.operation, args.json)
    except ValidationError:
        result = {"ok": False, "error": "bridge_invalid_parameters; see command --help"}
    except httpx.HTTPError:
        result = {"ok": False, "error": "bridge_transport_failed"}
    except BridgeResponseError as error:
        result = error.payload
    except (ValueError, TypeError) as error:
        result = {"ok": False, "error": str(error)}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else EXIT_FAILURE


if __name__ == "__main__":
    sys.exit(main())
