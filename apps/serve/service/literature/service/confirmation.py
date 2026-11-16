"""Project a skill review packet into a product-owned decision request."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.chat.persistence.catalog import HilStatus
from service.literature.persistence.files import read_scoped_file, scoped_workspace_path
from service.literature.service.review import REVIEW_FILE_BYTES, REVIEW_TEXT
from service.platform.activity import Activities, ActivityDomain
from service.platform.context import ProductTaskType

REVIEW_PACKET = "04_outline/review_packet.json"
OUTLINE_CHECKPOINT = "outline"
PLAN_CHECKPOINT = "plan"
PLAN_PACKET = "01_input/plan_packet.json"
PLAN_TASK = "01_input/writing_request.json"
PLAN_DECISION = "_status/plan_decision.json"
PLAN_REQUIRED_ACTION = "Confirm the current execution plan through literature.review checkpoint=plan before external search."
PLAN_HEADER = "综述执行方案"
PLAN_CONFIRM_LABEL = "按此方案执行"
PLAN_FIELDS_PRESENTATION = "question-fields"
PROCESSING_SECONDS_PER_MINUTE = 60
PLAN_LABELS = {
    "CHINESE": {
        "CHINESE": "中文",
        "quick": "快速",
        "standard": "标准",
        "provided_only": "仅指定文献",
        "supplement": "指定文献并补充检索",
        "discover": "外部检索",
        "latex_pdf": "PDF",
        "markdown": "Markdown",
        "docx": "Word DOCX",
        "survey": "文献综述",
        "related_work": "相关工作",
        "chapter": "章节",
        "fragment": "片段",
        "components": "独立内容组件",
        "document": "完整文档",
        "paragraph": "段落",
        "gbt7714_2025": "GB/T 7714（2025 版）",
    },
    "ENGLISH": {
        "ENGLISH": "English",
        "quick": "Quick",
        "standard": "Standard",
        "provided_only": "Supplied papers only",
        "supplement": "Supplied papers with supplemental discovery",
        "discover": "External discovery",
        "latex_pdf": "PDF",
        "markdown": "Markdown",
        "docx": "Word DOCX",
        "survey": "Literature review",
        "related_work": "Related work",
        "chapter": "Chapter",
        "fragment": "Excerpt",
        "components": "Standalone components",
        "document": "Full document",
        "paragraph": "Paragraph",
        "gbt7714_2025": "GB/T 7714 (2025)",
    },
}
PLAN_NEXT_ACTION = (
    "Run writing plan-resolve --receipt with the returned receipt_ref. The product has saved "
    "the original response; do not copy or serialize it. "
    "For an actual answer add --action proceed, pause or cancel according to its meaning; "
    "requested changes use --patch FILE with the actual answer appended to user_requests "
    "and effective_requirements. For a product timeout or cancellation omit action and patch. "
    "Continue only when can_continue is true. Paper authorization remains separate."
)
REVIEW_TIMEOUT_MODE = "timeout_auto"
REVIEW_REQUIRED_MODE = "required"
REVIEW_TIMEOUT_SECONDS = 300
REVIEW_PRESENTATION_KIND = "literature-outline-confirmation"
REVIEW_SKIP_STATES = frozenset(("auto", "approved", "timeout_applied"))
REVIEW_WAIT_STATES = frozenset(("required", "awaiting_display", "waiting", "expired"))
REVIEW_CONFIRM_LABEL = "按当前方案开始撰写"
REVIEW_HEADER = "大纲与输出设置确认"
REVIEW_QUESTION = "是否按上述大纲和以下输出设置开始撰写？也可直接填写大纲或输出设置的修改意见。"
REVIEW_TIMEOUT_NOTICE = "请在 5 分钟内确认或提出修改；若未回复，将按以上设置继续。"
REVIEW_NEXT_ACTION = (
    "The product card has already received the user's decision. Execute continuation.steps "
    "in order using this workspace's slr CLI: append each arguments array. The --receipt "
    "reference reads the product's saved response directly; do not serialize input or IDs. "
    "Use the actual session workdir, not a reconstructed path. "
    "Stop on a failed step; repair that failure without asking for the same confirmation again. "
    "If continuation.state is confirmed, the click is the actual user approval: after both "
    "steps succeed, continue the Skill's manuscript preparation and writing in this turn. "
    "Do not finish with an outline summary or ask for a text confirmation. "
    "Otherwise consume review-complete and follow its result; never approve revisions, "
    "cancellation or timeout as a user confirmation. Do not start another question or timer."
)
REVIEW_CONFIRMED_STATE = "confirmed"
REVIEW_DECISION_STATE = "decision_received"
REVIEW_COMPLETE_ARGUMENTS = ("writing", "review-complete", "--request", "-")
REVIEW_APPROVE_ARGUMENTS = ("writing", "approve", "--request", "-")


def confirmation_continuation(
    confirmation: dict[str, Any], receipt_ref: str | None = None
) -> dict[str, Any]:
    decision = confirmation["decision"]
    request_id = confirmation["request_id"]
    answer = decision.get("answers", {}).get(request_id)
    confirmed = (
        answer == REVIEW_CONFIRM_LABEL
        and not decision.get("cancelled")
        and not decision.get("timed_out")
    )
    steps: list[dict[str, Any]] = [
        {"arguments": list(REVIEW_COMPLETE_ARGUMENTS), "input": confirmation}
    ]
    if confirmed:
        steps.append(
            {
                "arguments": list(REVIEW_APPROVE_ARGUMENTS),
                "input": {
                    "packet_id": confirmation["packet_id"],
                    "message_id": request_id,
                    "user_response": answer,
                },
            }
        )
    if receipt_ref is not None:
        steps = [
            {"arguments": [*step["arguments"][:-2], "--receipt", receipt_ref]} for step in steps
        ]
    return {
        "state": REVIEW_CONFIRMED_STATE if confirmed else REVIEW_DECISION_STATE,
        "steps": steps,
    }


@dataclass(frozen=True)
class OutlineConfirmation:
    packet_id: str
    digest: str
    snapshot_id: str
    question: dict[str, Any] | None
    timeout_seconds: int | None


def require_search_plan(live: Any) -> None:
    if getattr(live, "active_task_type", "") != ProductTaskType.LITERATURE_REVIEW.value:
        return
    lease = getattr(live, "active_task_lease", None)
    if lease is None:
        raise ValueError(PLAN_REQUIRED_ACTION)
    try:
        task = json.loads(
            read_scoped_file(
                live.runtime_workdir,
                scoped_workspace_path(lease.workspace, PLAN_TASK),
                REVIEW_FILE_BYTES,
            )
        )
        if not isinstance(task, dict):
            raise ValueError(PLAN_REQUIRED_ACTION)
        if task.get("sources", {}).get("policy") == "provided_only":
            raise ValueError(
                "The current task permits supplied papers only; external search is disabled."
            )
        if "execution" not in task:
            return
        decision = json.loads(
            read_scoped_file(
                live.runtime_workdir,
                scoped_workspace_path(lease.workspace, PLAN_DECISION),
                REVIEW_FILE_BYTES,
            )
        )
        if (
            decision.get("state") != "approved"
            or decision.get("approved_snapshot", {}).get("request") != task
        ):
            raise ValueError(PLAN_REQUIRED_ACTION)
        receipt = decision.get("receipt", {})
        record = live.catalog.hil(receipt.get("request_id", ""))
        if (
            record.session_id != live.id
            or record.status not in (HilStatus.RESOLVED, HilStatus.EXPIRED)
            or record.decision != receipt.get("decision")
            or record.decision is None
        ):
            raise ValueError(PLAN_REQUIRED_ACTION)
    except (OSError, KeyError, TypeError, AttributeError) as error:
        raise ValueError(PLAN_REQUIRED_ACTION) from error


def prepare_confirmation(
    workdir: Path,
    workspace: str,
    session_id: str,
    turn_id: str,
    checkpoint: str = OUTLINE_CHECKPOINT,
) -> OutlineConfirmation:
    if checkpoint == PLAN_CHECKPOINT:
        return prepare_plan(workdir, workspace, session_id, turn_id)
    raw = read_scoped_file(
        workdir, scoped_workspace_path(workspace, REVIEW_PACKET), REVIEW_FILE_BYTES
    )
    packet = json.loads(raw)
    packet_id = packet.get("packet_id")
    confirmation = packet.get("confirmation", {})
    state = confirmation.get("state")
    mode = packet.get("outline_review")
    if not isinstance(packet_id, str) or not packet_id.strip():
        raise ValueError("review_packet_identity_missing")
    digest = sha256(raw).hexdigest()
    snapshot_id = sha256(
        json.dumps(
            packet.get("snapshot"), ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    if state in REVIEW_SKIP_STATES:
        return OutlineConfirmation(packet_id, digest, snapshot_id, None, None)
    if state not in REVIEW_WAIT_STATES or mode not in {REVIEW_TIMEOUT_MODE, REVIEW_REQUIRED_MODE}:
        raise ValueError("review_packet_not_awaiting_confirmation")
    settings = packet.get("publication_display", {})
    if not all(
        isinstance(settings.get(key), str) and settings[key] for key in ("format", "citation_style")
    ):
        raise ValueError("review_publication_display_missing")
    timeout = REVIEW_TIMEOUT_SECONDS if mode == REVIEW_TIMEOUT_MODE else None
    identity = sha256(
        json.dumps([session_id, turn_id, workspace, packet_id, digest]).encode()
    ).hexdigest()
    question: dict[str, Any] = {
        "id": f"outline-review:{identity}",
        "header": REVIEW_HEADER,
        "question": "\n\n".join(
            filter(
                None,
                (
                    REVIEW_QUESTION,
                    f"输出格式：{settings['format']}；引用样式：{settings['citation_style']}。",
                    (
                        REVIEW_TIMEOUT_NOTICE
                        if timeout
                        else "请确认或提出修改，收到确认后才会开始撰写。"
                    ),
                ),
            )
        ),
        "options": [{"label": REVIEW_CONFIRM_LABEL, "description": "使用当前大纲和输出设置。"}],
    }
    if all(len(settings[key]) <= REVIEW_TEXT for key in ("format", "citation_style")):
        question["presentation"] = {
            "kind": REVIEW_PRESENTATION_KIND,
            "format": settings["format"],
            "citation_style": settings["citation_style"],
            "timeout_seconds": timeout,
        }
    return OutlineConfirmation(packet_id, digest, snapshot_id, question, timeout)


def prepare_plan(
    workdir: Path, workspace: str, session_id: str, turn_id: str
) -> OutlineConfirmation:
    raw = read_scoped_file(
        workdir, scoped_workspace_path(workspace, PLAN_PACKET), REVIEW_FILE_BYTES
    )
    packet = json.loads(raw)
    task = json.loads(
        read_scoped_file(workdir, scoped_workspace_path(workspace, PLAN_TASK), REVIEW_FILE_BYTES)
    )
    snapshot = packet.get("snapshot", {})
    packet_id = packet.get("packet_id")
    if not isinstance(packet_id, str) or not packet_id or snapshot.get("request") != task:
        raise ValueError("plan_packet_missing_or_stale")
    digest = sha256(raw).hexdigest()
    snapshot_id = sha256(
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    if packet.get("confirmation", {}).get("state") == "approved":
        return OutlineConfirmation(packet_id, digest, snapshot_id, None, None)
    identity = sha256(
        json.dumps([session_id, turn_id, workspace, packet_id, digest]).encode()
    ).hexdigest()
    publication = snapshot.get("publication", {})
    execution = task.get("execution", {})
    chinese = task.get("language") == "CHINESE"
    labels = PLAN_LABELS["CHINESE" if chinese else "ENGLISH"]
    timeout = (
        REVIEW_TIMEOUT_SECONDS
        if execution.get("confirmation", REVIEW_TIMEOUT_MODE) == REVIEW_TIMEOUT_MODE
        else None
    )
    summary = task.get("effective_requirements") or task.get("intent", "")
    sources = task.get("sources", {}).get("policy", "discover")
    retrieval = task.get("retrieval", {})
    temporal_policy = retrieval.get("temporal_policy")
    default_window = (
        temporal_policy.get("default_if_unspecified", {})
        if isinstance(temporal_policy, dict)
        else {}
    )
    window = retrieval.get("time_range") or ({} if sources == "provided_only" else default_window)
    if not isinstance(window, dict):
        raise ValueError("plan_time_window_invalid")
    years = (
        f"{window.get('start_year', '…')}–{window.get('end_year', '…')}"
        if window
        else "未限定" if chinese else "Not specified"
    )
    if sources == "provided_only" and not retrieval.get("time_range"):
        years = (
            "按所选论文，不按默认年份筛选"
            if chinese
            else "Keep supplied papers; no default year filter"
        )
    mode = labels.get(execution.get("mode"), execution.get("mode"))
    source_label = labels.get(sources, sources)
    format_label = labels.get(publication.get("format"), publication.get("format"))
    template_label = (
        ("不适用（Markdown）" if chinese else "Not applicable (Markdown)")
        if publication.get("format") == "markdown"
        else (packet.get("publication_display") or {}).get("template", publication.get("template"))
    )
    count = retrieval.get("corpus_size", {}).get("target") or (
        "按所选材料" if chinese else "Selected materials"
    )
    source_summary = packet.get("source_summary") or {}
    if sources == "provided_only":
        ready = source_summary.get("local_count")
        pending = source_summary.get("pending_count", 0)
        count = (
            (
                f"{ready} 篇已就绪，{pending} 篇待补；不补检"
                if chinese
                else f"{ready} ready, {pending} pending; no additional search"
            )
            if (isinstance(ready, int) and not isinstance(ready, bool))
            else (
                "按所选材料，不补检" if chinese else "Supplied materials only; no additional search"
            )
        )
    elif isinstance(
        combinedTarget := source_summary.get("combined_target"), int
    ) and not isinstance(combinedTarget, bool):
        count = combinedTarget
    scope = task.get("deliverable") or task.get("output_scope") or summary
    if isinstance(scope, dict):
        scope = " / ".join(
            labels.get(value, value)
            for key in ("kind", "unit")
            if (value := str(scope.get(key) or ""))
        )
    else:
        scope = labels.get(str(scope), scope)
    citation_style = (packet.get("publication_display") or {}).get(
        "citation_style", publication.get("citation_style")
    )
    language = task.get("language", "As requested")
    expected_seconds = execution.get("budget_seconds")
    processing_time = None
    if expected_seconds is not None:
        minutes = expected_seconds / PROCESSING_SECONDS_PER_MINUTE
        processing_time = (
            f"{minutes:g} 分钟（预估，不含等待；超出仍继续）"
            if chinese
            else f"{minutes:g} minutes (estimate, excluding user waits; work continues if exceeded)"
        )
    fields = [
        {
            "label": zh if chinese else en,
            "value": (
                str(value)
                if value is not None and value != ""
                else ("未指定" if chinese else "Not specified")
            ),
        }
        for zh, en, value in (
            ("生成内容", "Deliverable", scope),
            ("语言", "Language", labels.get(language, language)),
            ("模式", "Mode", mode),
            ("交付格式", "Format", format_label),
            ("论文数量目标", "Target papers", count),
            ("发表区间", "Publication years", years),
            ("材料来源", "Sources", source_label),
            ("模板", "Template", template_label),
            ("引用格式", "Citation style", labels.get(citation_style, citation_style)),
            ("预计处理时间", "Estimated processing time", processing_time),
        )
    ]
    asset_requirements = {
        item.get("kind"): item.get("value")
        for item in task.get("constraints", [])
        if item.get("kind") in ("figure_count", "table_count")
    }
    for key, zh, en in (("figure_count", "图片", "Figures"), ("table_count", "表格", "Tables")):
        bounds = asset_requirements.get(key)
        if key == "figure_count" and execution.get("mode") == "quick":
            description = (
                "不支持；如需图片请改用Standard"
                if chinese
                else "Not supported; use Standard when needed"
            )
        elif bounds is None:
            description = (
                "材料分析后按需安排，可为0"
                if chinese
                else "Decide from evidence after preparation; zero is allowed"
            )
        elif bounds.get("min") == bounds.get("max") and "min" in bounds:
            description = str(bounds["min"])
        else:
            description = (
                f"至少{bounds.get('min', 0)}，至多{bounds.get('max', '不限')}"
                if chinese
                else f"Minimum {bounds.get('min', 0)}, maximum {bounds.get('max', 'unspecified')}"
            )
        fields.append({"label": zh if chinese else en, "value": description})
    separator = "：" if chinese else ": "
    settings = "\n".join(f"{field['label']}{separator}{field['value']}" for field in fields)
    authorization = (
        "论文导入授权仍按原流程执行。" if chinese else "Paper authorization remains separate."
    )
    notice = (
        (
            "可直接提出修改，或按此方案执行。五分钟未回复将按已展示方案执行。"
            if chinese
            else "Request changes or proceed. Without a reply within five minutes, the displayed plan will run."
        )
        if timeout
        else (
            "请确认或提出修改；收到确认后才执行。"
            if chinese
            else "Confirm or request changes. Execution waits for your response."
        )
    )
    header = PLAN_HEADER if chinese else "Review execution plan"
    question = {
        "id": f"plan-review:{identity}",
        "header": header,
        "question": "\n\n".join((summary, settings, authorization, notice)),
        "presentation": {
            "kind": PLAN_FIELDS_PRESENTATION,
            "title": header,
            "summary": summary,
            "fields": fields,
            "notice": f"{authorization} {notice}" if not chinese else f"{authorization}{notice}",
        },
        "options": [
            {
                "label": PLAN_CONFIRM_LABEL if chinese else "Proceed with this plan",
                "description": (
                    "按当前范围、模式和输出设置执行。"
                    if chinese
                    else "Use the displayed scope, mode and output settings."
                ),
            }
        ],
    }
    return OutlineConfirmation(packet_id, digest, snapshot_id, question, timeout)


async def await_confirmation(
    live: Any,
    activities: Activities,
    prepared: OutlineConfirmation,
    workspace: str,
    turn_id: str,
    checkpoint: str,
) -> dict[str, Any] | None:
    if prepared.question is None:
        return None
    with activities.enter(ActivityDomain.BRIDGE) as activity:
        decision = await live.interactions.request_product_input(
            prepared.question,
            turn_id=turn_id,
            timeout_seconds=prepared.timeout_seconds,
            cancel_timeout_on_edit=prepared.timeout_seconds is not None,
            activity=activity,
        )
    if live.publication_turn_id != turn_id:
        raise PermissionError("bridge_access_denied")
    current = await activities.to_thread(
        ActivityDomain.BRIDGE,
        prepare_confirmation,
        live.runtime_workdir,
        workspace,
        live.id,
        turn_id,
        checkpoint,
    )
    if current.digest != prepared.digest:
        raise ValueError("review_packet_changed")
    request_id = str(prepared.question["id"])
    record = live.catalog.hil(request_id)
    return {
        "packet_id": prepared.packet_id,
        "snapshot_id": prepared.snapshot_id,
        "request_id": request_id,
        "started_at": record.created_at,
        "deadline_at": (
            record.created_at + prepared.timeout_seconds if prepared.timeout_seconds else None
        ),
        "decision": decision,
    }
