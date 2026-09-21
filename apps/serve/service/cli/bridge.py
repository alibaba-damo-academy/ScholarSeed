"""Agent-facing CLI for scoped ScholarSeed product capabilities."""

from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError

from service.platform.bridge import (
    ANNOTATIONS_OPERATION,
    BRIDGE_COMMAND,
    BRIDGE_MAX_REQUEST_BYTES,
    BRIDGE_MAX_RESPONSE_BYTES,
    BRIDGE_REQUESTS,
    BRIDGE_SESSION_ENV,
    BRIDGE_SESSION_HEADER,
    BRIDGE_SOCKET_ENV,
    BRIDGE_TIMEOUT_SECONDS,
    BRIDGE_TOKEN_ENV,
    BRIDGE_TOKEN_HEADER,
    HISTORY_REQUESTS,
    INTERNAL_BASE_URL_ENV,
    LITERATURE_REQUESTS,
    PDF_REQUESTS,
    PLAN_REQUESTS,
    RESOURCE_REQUESTS,
    DisplayCard,
    TaskActivate,
)

EXIT_FAILURE = 1
JSON_ENCODING = "utf-8"
LOOPBACK_NAMES = frozenset(("localhost", "127.0.0.1", "::1"))
LOCAL_SOCKET_BASE_URL = "http://localhost"
# Product-owned authorization checkpoints wait for a user decision without a read deadline.
BLOCKING_CHECKPOINTS = {
    ("literature", "review"): frozenset(("retrieval",)),
    ("literature", "result"): frozenset(("selection", "candidates")),
}


class BridgeResponseError(ValueError):
    def __init__(self, payload: dict) -> None:
        super().__init__(str(payload.get("error") or "bridge_query_failed"))
        self.payload = payload


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
    publish_request, _publish_route = BRIDGE_REQUESTS[("artifact", "publish")]
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
            help=literature_descriptions[name],
            description=literature_descriptions[name],
        )
        command.add_argument(
            "--json",
            required=True,
            help="请求 JSON；凭证和当前项目由产品会话提供，不放入参数",
        )
        command.epilog = json.dumps(literature_request.model_json_schema(), ensure_ascii=False)
    resource = groups.add_parser("resource", help="列出当前项目资料库文件")
    resource_verbs = resource.add_subparsers(dest="operation")
    for name, resource_request in RESOURCE_REQUESTS.items():
        command = resource_verbs.add_parser(
            name,
            help="按项目相对路径列出资料库文件",
            description="列出当前会话项目的资料库文件；返回 cursor 可用于续页。",
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
    return root


def execute(capability: str, operation: str, raw: str) -> dict:
    if len(raw.encode(JSON_ENCODING)) > BRIDGE_MAX_REQUEST_BYTES:
        raise ValueError("bridge_request_too_large")
    request_type, route = BRIDGE_REQUESTS[(capability, operation)]
    payload = request_type.model_validate(json.loads(raw)).model_dump()
    base_url = os.environ.get(INTERNAL_BASE_URL_ENV, "").rstrip("/")
    token = os.environ.get(BRIDGE_TOKEN_ENV, "")
    session_id = os.environ.get(BRIDGE_SESSION_ENV, "")
    local_socket = os.environ.get(BRIDGE_SOCKET_ENV, "")
    if (not base_url and not local_socket) or not token or not session_id:
        raise ValueError("bridge_context_unavailable: run inside a ScholarSeed Agent session")
    if local_socket:
        base_url = LOCAL_SOCKET_BASE_URL
    address = urlsplit(base_url)
    if address.username or address.password or address.query or address.fragment:
        raise ValueError("bridge_address_invalid")
    if address.scheme != "https" and not (
        address.scheme == "http" and address.hostname in LOOPBACK_NAMES
    ):
        raise ValueError("bridge_secure_transport_required")
    transport = httpx.HTTPTransport(uds=local_socket) if local_socket else None
    timeout = (
        httpx.Timeout(BRIDGE_TIMEOUT_SECONDS, read=None)
        if payload.get("checkpoint") in BLOCKING_CHECKPOINTS.get((capability, operation), ())
        else httpx.Timeout(BRIDGE_TIMEOUT_SECONDS)
    )
    with httpx.Client(timeout=timeout, trust_env=False, transport=transport) as client:
        with client.stream(
            "POST",
            f"{base_url}{route}",
            headers={BRIDGE_SESSION_HEADER: session_id, BRIDGE_TOKEN_HEADER: token},
            json=payload,
        ) as response:
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > BRIDGE_MAX_RESPONSE_BYTES:
                    raise ValueError("bridge_response_too_large")
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError("bridge_response_invalid")
            if response.is_error:
                raise BridgeResponseError(result)
            return result


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
