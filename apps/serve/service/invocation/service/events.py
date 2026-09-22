"""Safe public event projection for isolated single-turn invocations."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from scholarseed_runtime.contract import RuntimeCallbackRequest, RuntimeEvent, RuntimeEventKind
from scholarseed_runtime.gateway.driver import RuntimeObservation

INVOCATION_EVENT_SCHEMA_VERSION = 1
TERMINAL_RUNTIME_KINDS = frozenset(
    (
        RuntimeEventKind.TURN_COMPLETED,
        RuntimeEventKind.TURN_FAILED,
        RuntimeEventKind.TURN_INTERRUPTED,
        RuntimeEventKind.TURN_UNKNOWN,
    )
)
DIRECT_EVENT_KINDS = frozenset(
    (
        RuntimeEventKind.TURN_STARTED,
        RuntimeEventKind.CONTENT_DELTA,
        RuntimeEventKind.CONTENT_COMPLETED,
        RuntimeEventKind.TOOL_STARTED,
        RuntimeEventKind.TOOL_PROGRESS,
        RuntimeEventKind.TOOL_COMPLETED,
        RuntimeEventKind.PLAN_UPDATED,
        RuntimeEventKind.USAGE_UPDATED,
        RuntimeEventKind.INTERACTION_RESOLVED,
    )
)
TEXT_PAYLOAD_KEYS = frozenset(("text", "delta", "role", "phase"))
TOOL_PAYLOAD_KEYS = frozenset(("name", "status", "ok", "success", "title"))
TOOL_PROGRESS_PAYLOAD_KEYS = frozenset(("output", "source", "status"))
PLAN_PAYLOAD_KEYS = frozenset(("explanation",))
INTERACTION_RESOLVED_PAYLOAD_KEYS = frozenset(("request_id", "option_id", "cancelled"))
USAGE_PAYLOAD_KEYS = frozenset(
    ("input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens")
)
SKILL_PAYLOAD_KEYS = frozenset(("status", "success", "ok"))
WEB_SEARCH_PAYLOAD_KEYS = frozenset(("query", "action"))
WEB_SEARCH_ACTION_KEYS = frozenset(("type", "query", "queries", "url", "pattern"))
MAXIMUM_ACTIVITY_TEXT_CHARS = 2_000
MAXIMUM_PLAN_ITEMS = 100


@dataclass(frozen=True)
class ExtensionProjection:
    """Allow-listed projection for one vendor-neutral runtime extension."""

    event_type: str
    payload_keys: frozenset[str]
    include_skill: bool = False
    count_results: bool = False


EXTENSION_PROJECTIONS = {
    "skill_started": ExtensionProjection("skill.started", SKILL_PAYLOAD_KEYS, include_skill=True),
    "skill_completed": ExtensionProjection(
        "skill.completed", SKILL_PAYLOAD_KEYS, include_skill=True
    ),
    "web_search_started": ExtensionProjection("web_search.started", WEB_SEARCH_PAYLOAD_KEYS),
    "web_search_completed": ExtensionProjection(
        "web_search.completed", WEB_SEARCH_PAYLOAD_KEYS, count_results=True
    ),
}


def artifact_payload(record: Any) -> dict[str, Any]:
    return {
        "artifact_id": record.artifact_id,
        "relative_path": record.relative_path,
        "role": record.role,
        "mime_type": record.mime_type,
        "size_bytes": record.size_bytes,
        "sha256": record.content_sha256,
    }


class InvocationEventProjector:
    def __init__(
        self,
        invocation_id: str,
        workspace: Path,
        *,
        skill: Mapping[str, str] | None = None,
    ) -> None:
        self._invocation_id = invocation_id
        self._workspace = workspace.expanduser().resolve()
        self._skill = dict(skill or {})
        self._sequence = 0

    def envelope(
        self,
        event_type: str,
        data: Mapping[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
    ) -> dict[str, Any]:
        self._sequence += 1
        return {
            "schema_version": INVOCATION_EVENT_SCHEMA_VERSION,
            "invocation_id": self._invocation_id,
            "seq": self._sequence,
            "type": event_type,
            "turn_id": turn_id,
            "item_id": item_id,
            "data": dict(data),
            "created_at": time.time(),
        }

    def project(self, observation: RuntimeObservation) -> dict[str, Any] | None:
        if isinstance(observation, RuntimeCallbackRequest):
            return self.envelope(
                "interaction.required",
                {
                    "request_id": observation.request_id,
                    "kind": observation.kind.value,
                    "prompt": observation.prompt,
                    "allowed_decisions": list(observation.allowed_decisions),
                    "response_contract": observation.response_contract,
                },
                turn_id=observation.native_turn_id,
                item_id=observation.native_item_id,
            )
        if observation.kind in TERMINAL_RUNTIME_KINDS:
            return None
        payload = observation.payload if isinstance(observation.payload, Mapping) else {}
        if observation.kind is RuntimeEventKind.ARTIFACT_OBSERVED:
            changes: list[dict[str, str]] = []
            raw_changes = payload.get("changes")
            for value in raw_changes if isinstance(raw_changes, list) else ():
                if not isinstance(value, Mapping):
                    continue
                relative = self._relative(value.get("path"))
                if relative:
                    change_kind = value.get("kind")
                    if isinstance(change_kind, Mapping):
                        change_kind = change_kind.get("type")
                    changes.append(
                        {"relative_path": relative, "change_kind": str(change_kind or "")}
                    )
            if not changes:
                return None
            return self.envelope(
                observation.kind.value,
                {"changes": changes},
                turn_id=observation.native_turn_id,
                item_id=observation.native_item_id,
            )
        if observation.kind is RuntimeEventKind.RUNTIME_EXTENSION:
            extension = str(payload.get("extension_kind") or "")
            spec = EXTENSION_PROJECTIONS.get(extension)
            if spec is None:
                return None
            data = self._selected(payload, spec.payload_keys)
            if "action" in data:
                data["action"] = self._web_search_action(data["action"])
            if spec.count_results:
                results = payload.get("results")
                data["result_count"] = len(results) if isinstance(results, (list, tuple)) else 0
            if spec.include_skill:
                data.update(self._skill)
            return self.envelope(
                spec.event_type,
                data,
                turn_id=observation.native_turn_id,
                item_id=observation.native_item_id,
            )
        if observation.kind not in DIRECT_EVENT_KINDS:
            return None
        keys = TOOL_PAYLOAD_KEYS
        if observation.kind in {RuntimeEventKind.CONTENT_DELTA, RuntimeEventKind.CONTENT_COMPLETED}:
            keys = TEXT_PAYLOAD_KEYS
        elif observation.kind is RuntimeEventKind.TOOL_PROGRESS:
            keys = TOOL_PROGRESS_PAYLOAD_KEYS
        elif observation.kind is RuntimeEventKind.PLAN_UPDATED:
            data = self._selected(payload, PLAN_PAYLOAD_KEYS)
            data["todos"] = self._todos(payload.get("todos"))
            return self.envelope(
                observation.kind.value,
                data,
                turn_id=observation.native_turn_id,
                item_id=observation.native_item_id,
            )
        elif observation.kind is RuntimeEventKind.INTERACTION_RESOLVED:
            keys = INTERACTION_RESOLVED_PAYLOAD_KEYS
        elif observation.kind is RuntimeEventKind.USAGE_UPDATED:
            keys = USAGE_PAYLOAD_KEYS
        elif observation.kind is RuntimeEventKind.TURN_STARTED:
            keys = frozenset()
        data = self._selected(payload, keys)
        if observation.call_id:
            data["call_id"] = observation.call_id
        return self.envelope(
            observation.kind.value,
            data,
            turn_id=observation.native_turn_id,
            item_id=observation.native_item_id,
        )

    @staticmethod
    def _todos(value: object) -> list[dict[str, str]]:
        if not isinstance(value, (list, tuple)):
            return []
        todos: list[dict[str, str]] = []
        for row in value[:MAXIMUM_PLAN_ITEMS]:
            if not isinstance(row, Mapping):
                continue
            todos.append(
                {
                    "content": str(row.get("content") or "")[:MAXIMUM_ACTIVITY_TEXT_CHARS],
                    "status": str(row.get("status") or "")[:MAXIMUM_ACTIVITY_TEXT_CHARS],
                }
            )
        return todos

    @staticmethod
    def _web_search_action(value: object) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            return {}
        action: dict[str, Any] = {}
        for key in WEB_SEARCH_ACTION_KEYS:
            if key not in value:
                continue
            item = value[key]
            if isinstance(item, str):
                action[key] = item[:MAXIMUM_ACTIVITY_TEXT_CHARS]
            elif isinstance(item, (list, tuple)):
                action[key] = [
                    text[:MAXIMUM_ACTIVITY_TEXT_CHARS]
                    for text in item[:MAXIMUM_PLAN_ITEMS]
                    if isinstance(text, str)
                ]
        return action

    def _relative(self, value: object) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        candidate = Path(raw).expanduser()
        if not candidate.is_absolute():
            candidate = self._workspace / candidate
        try:
            return str(candidate.resolve().relative_to(self._workspace))
        except (OSError, ValueError):
            return ""

    @staticmethod
    def _selected(payload: Mapping[str, Any], keys: frozenset[str]) -> dict[str, Any]:
        selected: dict[str, Any] = {}
        for key in keys:
            if key not in payload:
                continue
            value = payload[key]
            if isinstance(value, str):
                value = value[:MAXIMUM_ACTIVITY_TEXT_CHARS]
            selected[key] = value
        return selected


__all__ = [
    "INVOCATION_EVENT_SCHEMA_VERSION",
    "InvocationEventProjector",
    "artifact_payload",
]
