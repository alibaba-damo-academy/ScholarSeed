"""Choose bundled guides per signed-in user turn, and model and effort in Auto."""

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass, field

import httpx

from service.chat.prompts.skills import manual_skill_instructions
from service.identity.service.account_token import CONV_MESSAGE_ID_HEADER, CONV_TURN_ID_HEADER
from service.inference.guides import GUIDES, documents
from service.settings.catalog import DEEPRD_GATEWAY_BASE_URL, GATEWAY_MODEL_CATALOG

logger = logging.getLogger(__name__)
GUIDE_PAIRS = {
    "library": ("resources", "imports"),
    "workspace": ("history", "plans"),
    "navigation": ("browser", "links"),
    "presentation": ("display", "row_selection"),
    "composition": ("canvas", "authoring"),
}


def guide_questions():
    questions = {
        key: {
            "type": "noul",
            "instructions": "Does the current user message require this action? Use prior context only to resolve references.",
            "criteria": {
                "true": guide.trigger,
                "false": "This action is unnecessary for the current request.",
            },
        }
        for key, guide in GUIDES.items()
    }
    for group, (left, right) in GUIDE_PAIRS.items():
        a = questions.pop(left)["criteria"]["true"]
        b = questions.pop(right)["criteria"]["true"]
        questions[group] = {
            "type": "choice",
            "instructions": f"Which actions does the latest user actually request this turn? {left}: {a} {right}: {b}",
            "criteria": {
                "neither": "Neither action is needed.",
                left: a,
                right: b,
                "both": "Both actions are needed.",
            },
        }
    return questions


criteria = {
    "deepseek-v4.1-flash@none": "Explicitly requested deepseek-v4.1-flash at none. 寒暄、简单问答、解释、总结当前对话 缺少会改变操作对象或交付目标的信息且上下文无法补足",
    "deepseek-v4.1-flash@low": "Explicitly requested deepseek-v4.1-flash at low. 对已有材料翻译、摘要、润色、改格式或定向修改 查询外部事实、核对实时信息或单条出处 对项目、文件、画布、历史记录或导入资源执行操作 使用工作区数据按已定义规则分析、交付文件并复跑 其余可理解但尚未归类的对话",
    "deepseek-v4.1-flash@high": "Explicitly requested deepseek-v4.1-flash at high. 单篇论文核验，速度优先",
    "deepseek-v4.1-flash@max": "Explicitly requested deepseek-v4.1-flash at max.",
    "qwen4-max@low": "Explicitly requested qwen4-max at low.",
    "qwen4-max@high": "Explicitly requested qwen4-max at high. 需要综合材料、权衡要求的长文起草或改写 多约束规划、方案比较、复杂数学或代码推理 跨来源对照、系统调研或多材料证据综合 修改或运行代码、排障，或执行需要验证的多步操作 定位单篇论文并实际核验正文或实验数据",
    "qwen4-max@xhigh": "Explicitly requested qwen4-max at xhigh. 单篇论文核验，明确要求质量优先",
}
criteria["deepseek-v4.1-flash@none"] += " Exclude code explanations; choose Flash low for those."
criteria["deepseek-v4.1-flash@low"] += (
    " Explaining an existing code expression. Preferred for predefined workspace data analysis even when running a script and exporting files."
)
criteria["qwen4-max@high"] += (
    " Debugging and constraints, excluding predefined statistical analysis."
)
criteria["deepseek-v4.1-flash@high"] += (
    " For a single paper only when the user explicitly prioritizes speed."
)
criteria["qwen4-max@high"] += (
    " Default for identifying and checking a specified paper in the full text, including just one figure or table."
)
QUESTIONS = guide_questions()
QUESTIONS["execution"]["criteria"]["true"] += (
    " Includes running unit/regression tests, executing a statistical analysis on local data, and rerunning a script to verify results, even if project or artifacts also applies."
)
QUESTIONS["composition"]["instructions"] += (
    " A persistent task plan is not Canvas. Choose neither for updating a plan unless the user explicitly requests Canvas or a custom executable card."
)
INSTRUCTIONS = (
    "Choose one listed model@effort for latest_user. Each criterion lists its intended tasks. "
    "Use recent messages to resolve references. A paper verification without an identifiable "
    "paper needs clarification (Flash none); a supplied paper identifier resolves that request. "
    "Bare continuation keeps the preceding task and route unless the new turn changes them. "
    "Pure rewriting/translation of supplied text uses Flash low. Respect explicit preferences."
)
argument_intent = re.compile(
    r"反例|推翻|论证|推导|证明|条件.{0,20}(?:成立|保证)|成立条件|能否仅凭|"
    r"不变量|故障序列|失败序列|counterexample|disprove|\bprov(?:e|ing)\b|\binvariant\b",
    re.I,
)
argument_criteria = criteria.copy()
argument_criteria["deepseek-v4.1-flash@none"] += (
    " For definitions and direct recall only; deriving conditions or counterexamples requires reasoning."
)
argument_criteria["qwen4-max@high"] += (
    " Choose this for establishing when a claim holds, constructing or checking a counterexample, reasoning through failure orderings, or proving an invariant. This applies even to a one-sentence request."
)


def bounded_task(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    separator = "\n…\n"
    head = limit // 2
    return text[:head] + separator + text[-(limit - head - len(separator)) :]


@dataclass(frozen=True)
class GuideDecision:
    turn: str
    context: dict = field(default_factory=dict, kw_only=True)
    guidance: str | None  # None restores skill discovery; an empty string means no guide.


@dataclass(frozen=True)
class AutoRoute(GuideDecision):
    model: str
    effort: str

    @property
    def catalog_row(self):
        return next(row for row in GATEWAY_MODEL_CATALOG if row["key"] == self.model)


@dataclass(frozen=True)
class GuideQuery:
    session: str
    turn: str
    user: str
    token: str = field(repr=False)
    state: dict
    questions: dict

    async def fetch(self):
        if not self.token:
            return {}, "missing_account"
        headers = {
            "Authorization": "Bearer " + self.token,
            CONV_MESSAGE_ID_HEADER: self.session,
            CONV_TURN_ID_HEADER: self.turn,
        }
        start = time.time()
        async with httpx.AsyncClient() as client:
            answers, _, status = await request(
                client, headers, json.dumps(self.state, ensure_ascii=False), self.questions
            )
        logger.info(
            "guide_request session=%s turn=%s started_at=%.6f finished_at=%.6f status=%s",
            self.session,
            self.turn,
            start,
            time.time(),
            status,
        )
        return answers, status


@dataclass(frozen=True)
class PendingGuideQuery:
    query: GuideQuery
    result: asyncio.Task


def guide_query(live, turn, text, attachments, token, *, auto):
    recent = live.auto_history
    # Only expand an elliptical follow-up. A self-contained new task gets fresh routing.
    effective = bounded_task(text, 6000)
    recent_context = [
        {k: v for k, v in entry.items() if k != "turn"} for entry in recent if "route" in entry
    ]
    bare_continue = re.fullmatch(
        r"\s*(继续|接着做|继续处理|按上一步继续|continue|go on)[。！!.\s]*", text, re.I
    )
    identifier = re.fullmatch(
        r"\s*(?:是|论文是|链接是|题名是)?\s*(?:arxiv\s*:\s*\d{4}\.\d{4,5}|10\.\d{4,9}/\S+|https?://\S+|《[^》]+》)[。\s]*",
        text,
        re.I,
    )
    if recent:
        previous_task = recent[-1].get("effective_task", recent[-1]["user"])
        if bare_continue:
            effective = previous_task
        elif identifier and re.search(r"论文|文章|表\s*\d|全文|paper", previous_task, re.I):
            effective = f"针对用户刚补充的文献标识 {text}，执行上轮已提出的核验任务。上轮原文：{bounded_task(previous_task, 2000)}"
        if bare_continue or effective != bounded_task(text, 6000):
            recent_context = [
                {k: recent[-1][k] for k in ("route", "attachments") if k in recent[-1]}
            ]
    state = dict(
        scope="turn",
        latest_user=bounded_task(effective, 6000),
        attachments=attachments,
        recent=recent_context,
        guide_policy="Direct text or unresolved paper reference: no guides. On a bare continuation "
        "preserve previous guides. Single-paper verification: evidence and retrieval, "
        "dispatch only for an explicit research handoff. Explicit guides off: no guides.",
    )
    if bare_continue and recent:
        state["follow_up"] = "continue"
    questions = dict(QUESTIONS)
    if auto:
        state["allowed_choices"] = list(criteria)
        options = argument_criteria if argument_intent.search(effective) else criteria
        questions["selection"] = {
            "type": "choice",
            "instructions": INSTRUCTIONS,
            "criteria": options,
        }
    return GuideQuery(live.id, turn, live.user_id, token, state, questions)


def message_text(body):
    return "\n".join(str(i.get("text") or "") for i in body["input"] if i.get("type") == "text")


async def decide(live, turn_input, accounts, *, auto=True, body=None, pending=None):
    token = accounts.current(live.user_id)
    if not auto and not token:
        return None
    turn = turn_input.client_user_message_id
    if body is None:
        body = live.catalog.queued_message(live.id, turn).body
    text = message_text(body)
    attachments = [item.path.name for item in turn_input.items if item.path]
    query = guide_query(live, turn, text, attachments, token, auto=auto)
    start = time.monotonic()
    if pending is None:
        answers, status = await query.fetch()
    elif pending.query == query:
        answers, status = await pending.result
    else:
        # The queued input or its owner changed during activation. Use the existing
        # fallback for this turn without applying stale answers or issuing another POST.
        answers, status = {}, "routing_input_changed"
    if query.user != live.user_id or token != accounts.current(live.user_id):
        answers, status = {}, "account_changed"
    if auto:
        choice = answers.get("selection")
        choice = choice.get("choice") if isinstance(choice, dict) else None
        if not isinstance(choice, str) or choice not in criteria:
            choice = "deepseek-v4.1-flash@high"
            if status == "accepted":
                status = "invalid_choice"
        model, effort = choice.split("@")
    labels = {}
    for key in QUESTIONS:
        answer = answers.get(key)
        if key in GUIDE_PAIRS:
            answer = answer if isinstance(answer, dict) else {}
            choice = answer.get("choice")
            confidence = answer.get("confidence")
            valid = (
                isinstance(choice, str)
                and choice in QUESTIONS[key]["criteria"]
                and type(confidence) in (float, int)
                and 0.8 <= confidence <= 1
            )
            for guide in GUIDE_PAIRS[key]:
                labels[guide] = choice in (guide, "both") if valid else None
            continue
        probability = answer.get("noul") if isinstance(answer, dict) else None
        labels[key] = None
        if type(probability) in (float, int) and 0 <= probability <= 1:
            if probability >= 0.8:
                labels[key] = True
            elif probability <= 0.2:
                labels[key] = False
    docs = await documents(labels, live.skill_identity_by_name)
    use_discovery = not docs and not all(value is False for value in labels.values())
    if use_discovery:
        logger.info(
            "guide_discovery_fallback session=%s turn=%s reason=%s",
            live.id,
            turn,
            "guides_unavailable" if any(labels.values()) else "inconclusive",
        )
    context = {
        "turn": turn,
        "user": bounded_task(text, 1000),
        "effective_task": bounded_task(query.state["latest_user"], 2400),
        "attachments": attachments,
        "route": {
            **({"model": model, "effort": effort} if auto else {}),
            "selected_guides": [key for key in GUIDES if key in docs],
        },
    }
    logger.info(
        "%s session=%s turn=%s model=%s effort=%s guides=%s status=%s elapsed_ms=%.0f",
        "auto_route" if auto else "manual_guides",
        live.id,
        turn,
        model if auto else "manual",
        effort if auto else "user_selected",
        list(docs),
        status,
        (time.monotonic() - start) * 1000,
    )
    guidance = None if use_discovery else "\n\n".join(doc.block for doc in docs.values())
    if auto:
        return AutoRoute(turn=turn, model=model, effort=effort, guidance=guidance, context=context)
    return GuideDecision(turn, guidance, context=context)


async def request(client, headers, state, questions):
    try:
        async with asyncio.timeout(5):
            async with client.stream(
                "POST",
                DEEPRD_GATEWAY_BASE_URL + "/decisions",
                headers=headers,
                json={"model": "decision-openrouter-jev", "state": state, "questions": questions},
                follow_redirects=False,
            ) as response:
                if response.is_error and response.status_code not in (401, 403):
                    return {}, "", f"gateway_http_{response.status_code}"
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > 262144:
                        return {}, "", "invalid_response"
                    body.extend(chunk)
        result = json.loads(body)
        if isinstance(result, dict) and isinstance(result.get("answers"), dict):
            return result["answers"], str(result.get("id", ""))[:128], "accepted"
        return {}, "", "invalid_response"
    except httpx.HTTPStatusError as error:
        if error.response.status_code in (401, 403):
            return {}, "", "unauthorized"
        return {}, "", "unavailable"
    except (TimeoutError, httpx.TimeoutException):
        return {}, "", "timeout"
    except (ValueError, httpx.HTTPError):
        return {}, "", "unavailable"


def guide_inventory(text):
    if not text.lstrip().startswith("<skills_instructions>") or not text.rstrip().endswith(
        "</skills_instructions>"
    ):
        return text
    lines = text.splitlines(keepends=True)
    in_catalog = False
    kept = []
    for line in lines:
        if line.startswith("#"):
            in_catalog = line.strip() == "### Available skills"
        if in_catalog and re.match(
            r"^- (academic-research-guidance|scholarseed-product-operations): ", line
        ):
            continue
        kept.append(line)
    return "".join(kept)


def project_guidance(payload, route: GuideDecision | None):
    # A resumed native thread can replay developer messages from an earlier mode.
    # Apply this turn's policy to privileged text only, leaving user history intact.
    manual = manual_skill_instructions()
    guidance = route.guidance if route else None
    discover = guidance is None
    has_manual = False

    def project_text(text):
        nonlocal has_manual
        if discover:
            has_manual |= manual in text
            return text
        return guide_inventory(text.replace(manual, ""))

    payload = dict(payload)
    if isinstance(payload.get("instructions"), str):
        payload["instructions"] = project_text(payload["instructions"])
    source = payload.get("input")
    if isinstance(source, str):
        source = [{"role": "user", "content": source}]
    if not isinstance(source, list):
        return payload
    items = []
    for item in source:
        projected = item
        if isinstance(item, dict) and item.get("role") in ("system", "developer"):
            content = item.get("content")
            if isinstance(content, str):
                projected = dict(item, content=project_text(content))
            elif isinstance(content, list):
                parts = [
                    dict(part, text=project_text(part["text"]))
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                    else part
                    for part in content
                ]
                projected = dict(item, content=parts)
        items.append(projected)
    if discover and not has_manual:
        guidance = manual
    if guidance:
        items.insert(
            0, {"role": "developer", "content": [{"type": "input_text", "text": guidance}]}
        )
    return dict(payload, input=items)
