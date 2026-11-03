"""Translate runtime turn inputs to Codex native input items."""

import json
from pathlib import Path
from typing import Any

from scholarseed_codex.permission import sandbox_policy
from scholarseed_codex.protocol.session import (
    CODEX_REASONING_SUMMARY_CONFIG,
    CodexSessionOpenRequest,
)
from scholarseed_codex.protocol.state import CODEX_DEFAULT_APPROVAL_POLICY, AppServerError
from scholarseed_codex.utils import path_identity
from scholarseed_runtime.contract.input import CollaborationMode, InputKind, TurnInput

CODEX_LOCAL_FILE_CONTEXT = (
    "User-selected local file (use this exact path when the request refers to the "
    "attached file): {identity}"
)
CODEX_LOCAL_DIRECTORY_CONTEXT = (
    "User-selected local directory (use this exact directory path when the request refers to "
    "the attached folder; its contents have not been read): {identity}"
)


def serialize_input(turn_input: TurnInput, cwd: Path) -> list[dict[str, Any]]:
    serialized: list[dict[str, Any]] = []
    for item in turn_input.items:
        if item.kind == InputKind.TEXT:
            serialized.append({"type": "text", "text": item.text})
        elif item.kind == InputKind.LOCAL_IMAGE:
            if item.path is None:
                raise ValueError("local image input requires a path")
            serialized.append({"type": "localImage", "path": str(item.path.expanduser().resolve())})
        elif item.kind == InputKind.FILE:
            if item.path is None:
                raise ValueError("file input requires a path")
            path = item.path.expanduser().resolve()
            serialized.append(
                {
                    "type": "text",
                    "text": CODEX_LOCAL_FILE_CONTEXT.format(
                        identity=json.dumps(
                            {"name": item.name or path.name, "path": str(path)},
                            ensure_ascii=False,
                        )
                    ),
                }
            )
        elif item.kind == InputKind.DIRECTORY:
            if item.path is None:
                raise ValueError("local directory input requires a path")
            path = item.path.expanduser()
            serialized.append(
                {
                    "type": "text",
                    "text": CODEX_LOCAL_DIRECTORY_CONTEXT.format(
                        identity=json.dumps(
                            {"name": item.name or path.name, "path": str(path)},
                            ensure_ascii=False,
                        )
                    ),
                }
            )
        elif item.kind == InputKind.SKILL:
            if item.path is None or not item.name:
                raise ValueError("skill input requires name and path")
            serialized.append(
                {
                    "type": "skill",
                    "name": item.name,
                    "path": str(item.path.expanduser().resolve()),
                }
            )
    if not serialized:
        raise ValueError(f"turn input for {cwd} must contain at least one item")
    return serialized


def start_parameters(
    thread_id: str,
    turn_input: TurnInput,
    request: CodexSessionOpenRequest,
    writable_roots: tuple[str, ...],
    model: str,
) -> dict[str, Any]:
    """Validate and translate a turn before changing active execution state."""
    params: dict[str, Any] = {
        "threadId": thread_id,
        "input": serialize_input(turn_input, request.cwd),
        "cwd": str(request.cwd.expanduser().resolve()),
        "approvalPolicy": request.approval_policy or CODEX_DEFAULT_APPROVAL_POLICY,
        "sandboxPolicy": sandbox_policy(request, writable_roots),
    }
    if request.permissions_profile:
        params.pop("sandboxPolicy")
        params["permissions"] = request.permissions_profile
        params["runtimeWorkspaceRoots"] = list(
            dict.fromkeys([str(request.cwd.expanduser().resolve()), *writable_roots])
        )
    if request.approval_reviewer is not None:
        params["approvalsReviewer"] = request.approval_reviewer.value
    if turn_input.model:
        params["model"] = turn_input.model
    if summary := request.thread_config.get(CODEX_REASONING_SUMMARY_CONFIG):
        params["summary"] = summary
    if turn_input.collaboration_mode == CollaborationMode.PLAN:
        model = model or request.model
        if not model:
            raise AppServerError("Codex App Server returned no model for plan collaboration")
        params["collaborationMode"] = {
            "mode": CollaborationMode.PLAN.value,
            "settings": {
                "model": model,
                "reasoning_effort": None,
                "developer_instructions": None,
            },
        }
    return params


def skill_inputs(turn_input: TurnInput) -> dict[str, str]:
    return {
        path_identity(item.path): item.name
        for item in turn_input.items
        if item.kind == InputKind.SKILL and item.path is not None and item.name
    }
