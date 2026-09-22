"""Registered product projections for optional runtime activities."""

from dataclasses import dataclass
from typing import Any, Callable, Mapping

from scholarseed_runtime.contract.event import RuntimeEvent
from service.chat.constants import (
    PRODUCT_EVENT_PAPER_SEARCH_COMPLETED,
    PRODUCT_EVENT_PAPER_SEARCH_STARTED,
    PRODUCT_EVENT_RUNTIME_ERROR,
    PRODUCT_EVENT_SKILL_COMPLETED,
    PRODUCT_EVENT_SKILL_STARTED,
    PRODUCT_EVENT_WEB_SEARCH_COMPLETED,
    PRODUCT_EVENT_WEB_SEARCH_STARTED,
    RUNTIME_LEGACY_ERROR,
)

EXTENSION_KIND_KEY = "extension_kind"
RUNTIME_ERROR_MESSAGE = "Agent runtime error"


def search(event: RuntimeEvent, payload: Mapping[str, Any], completed: bool) -> dict[str, Any]:
    result = {
        "search_id": event.native_item_id,
        "query": str(payload.get("query") or ""),
        "action": payload.get("action") or {},
    }
    if completed:
        rows = payload.get("results")
        results = list(rows) if isinstance(rows, list) else []
        result.update(results=results, result_count=len(results))
    return result


def skill(event: RuntimeEvent, payload: Mapping[str, Any], completed: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        "skill_id": event.native_item_id,
        "skill": str(payload.get("skill") or ""),
        "path": str(payload.get("path") or ""),
        "status": str(payload.get("status") or ("completed" if completed else "running")),
    }
    if completed:
        result["success"] = bool(payload.get("ok"))
    return result


def error(event: RuntimeEvent, payload: Mapping[str, Any], completed: bool) -> dict[str, Any]:
    del event, completed
    return {
        "code": RUNTIME_LEGACY_ERROR,
        "message": str(payload.get("safe_error") or RUNTIME_ERROR_MESSAGE),
        "recoverable": bool(payload.get("will_retry") or payload.get("recoverable")),
    }


@dataclass(frozen=True)
class ExtensionProjection:
    product_kind: str
    build: Callable[[RuntimeEvent, Mapping[str, Any], bool], dict[str, Any]]
    completed: bool = False


EXTENSION_PROJECTIONS = {
    "web_search_started": ExtensionProjection(PRODUCT_EVENT_WEB_SEARCH_STARTED, search),
    "web_search_completed": ExtensionProjection(PRODUCT_EVENT_WEB_SEARCH_COMPLETED, search, True),
    "paper_search_started": ExtensionProjection(PRODUCT_EVENT_PAPER_SEARCH_STARTED, search),
    "paper_search_completed": ExtensionProjection(
        PRODUCT_EVENT_PAPER_SEARCH_COMPLETED, search, True
    ),
    "skill_started": ExtensionProjection(PRODUCT_EVENT_SKILL_STARTED, skill),
    "skill_completed": ExtensionProjection(PRODUCT_EVENT_SKILL_COMPLETED, skill, True),
    "runtime_error": ExtensionProjection(PRODUCT_EVENT_RUNTIME_ERROR, error),
}
