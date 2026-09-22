"""Native approval prompts and response payload mapping."""

from __future__ import annotations

import json
from typing import Any, Mapping

from scholarseed_codex.protocol.mcp import JsonValue


def hil_response(
    method: str,
    params: Mapping[str, Any],
    cancelled: bool,
    option_id: str,
    response: Mapping[str, JsonValue],
) -> dict[str, Any]:
    if method == "item/tool/requestUserInput":
        if cancelled or option_id == "cancel":
            return {"answers": {}}
        raw_values = response.get("values")
        values = dict(raw_values) if isinstance(raw_values, Mapping) else {}
        raw_answers = response.get("answers")
        supplied_answers = dict(raw_answers) if isinstance(raw_answers, Mapping) else {}
        raw_questions = params.get("questions")
        questions = (
            [question for question in raw_questions if isinstance(question, Mapping)]
            if isinstance(raw_questions, list)
            else []
        )
        free_text = str(response.get("free_text") or "")
        answers: dict[str, Any] = {}
        for question in questions:
            question_id = str(question.get("id") or "")
            header = str(question.get("header") or "")
            prompt = str(question.get("question") or "")
            value: Any = None
            for key in (question_id, header, prompt):
                if key and key in supplied_answers:
                    value = supplied_answers[key]
                    break
            if value is None:
                value = values.get(question_id)
            if value is None and len(questions) == 1:
                value = free_text
            if isinstance(value, Mapping):
                value = value.get("answers")
            rows = value if isinstance(value, list) else ([] if value is None else [value])
            answers[question_id] = {"answers": [str(row) for row in rows if str(row)]}
        return {"answers": answers}
    if method == "mcpServer/elicitation/request":
        action = "cancel" if cancelled else option_id or "decline"
        return {"action": action, "content": response.get("values")}
    if method == "item/permissions/requestApproval":
        if cancelled or option_id in {"decline", "cancel"}:
            return {"permissions": {}, "scope": "turn"}
        scope = "session" if option_id == "acceptForSession" else "turn"
        requested = params.get("permissions") or {}
        return {"permissions": requested, "scope": scope}
    decision = "cancel" if cancelled else option_id or "decline"
    return {"decision": decision}


def hil_payload(
    request_id: str,
    method: str,
    params: Mapping[str, Any],
    item: Mapping[str, Any],
) -> Mapping[str, JsonValue]:
    if method == "item/tool/requestUserInput":
        questions = list(params.get("questions") or [])
        return {
            "request_id": request_id,
            "trigger": "structured.review",
            "title": "Codex needs your input",
            "body": "\n\n".join(
                str(question.get("question") or question.get("header") or "Input required")
                for question in questions
            ),
            "options": [
                {"id": "submit", "label": "Submit"},
                {"id": "cancel", "label": "Cancel"},
            ],
            "allow_free_text": True,
            "questions": questions,
            "method": method,
        }
    if method == "mcpServer/elicitation/request":
        return {
            "request_id": request_id,
            "trigger": "structured.review",
            "title": "MCP server needs your input",
            "body": str(params.get("message") or method),
            "options": [
                {"id": "accept", "label": "Submit"},
                {"id": "decline", "label": "Decline"},
                {"id": "cancel", "label": "Cancel turn"},
            ],
            "allow_free_text": str(params.get("mode") or "") != "url",
            "mode": params.get("mode"),
            "schema": params.get("requestedSchema"),
            "url": params.get("url"),
            "method": method,
        }
    available = [
        item for item in list(params.get("availableDecisions") or []) if isinstance(item, str)
    ]
    decisions = available or ["accept", "acceptForSession", "decline", "cancel"]
    labels = {
        "accept": "Allow once",
        "acceptForSession": "Allow for session",
        "decline": "Decline",
        "cancel": "Decline and stop",
    }
    body_parts = [
        part for part in (str(params.get("reason") or ""), str(params.get("command") or "")) if part
    ]
    permissions = params.get("permissions")
    if permissions:
        body_parts.append(json.dumps(permissions, ensure_ascii=False))
    payload: dict[str, JsonValue] = {
        "request_id": request_id,
        "trigger": "policy.ask",
        "title": "Codex permission request",
        "body": "\n".join(body_parts) or method,
        "options": [
            {"id": decision, "label": labels.get(decision, decision)} for decision in decisions
        ],
        "allow_free_text": False,
        "method": method,
        "requested_permissions": permissions,
    }
    typed_fields = {
        "command": params.get("command"),
        "cwd": params.get("cwd"),
        "path": params.get("path") or item.get("path"),
        "diff": params.get("diff") or item.get("diff"),
        "changes": params.get("changes") or item.get("changes"),
        "network_target": params.get("networkApprovalContext"),
        "permissions": permissions or params.get("additionalPermissions"),
        "safety_tags": params.get("safetyTags") or item.get("safetyTags"),
    }
    for key, value in typed_fields.items():
        if value is not None:
            payload[key] = value
    if not payload.get("path"):
        raw_changes = payload.get("changes")
        changes = raw_changes if isinstance(raw_changes, list) else []
        first = changes[0] if changes and isinstance(changes[0], Mapping) else {}
        if first.get("path"):
            payload["path"] = first["path"]
    return payload
