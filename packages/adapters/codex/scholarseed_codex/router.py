"""Native thread, turn, item and child-agent correlation ownership."""

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from scholarseed_codex.protocol.state import (
    CODEX_COLLAB_TOOL_CALL_ITEM_TYPE,
    CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE,
)
from scholarseed_runtime.contract.history import TurnStatus

SUBAGENT_SUMMARY_LIMIT = 2000


@dataclass(frozen=True)
class AgentRoute:
    owner_thread_id: str
    owner_turn_id: str = ""
    owner_item_id: str = ""
    agent_path: str = ""


class ThreadRouter:
    def __init__(self) -> None:
        self._turns: dict[str, str] = {}
        self._items: dict[str, str] = {}
        self._agents: dict[str, AgentRoute] = {}
        self._agent_statuses: dict[str, str] = {}
        self._agent_activity_at: dict[str, float] = {}
        self._agent_summaries: dict[tuple[str, str], str] = {}

    def bind_turn(self, turn_id: str, thread_id: str) -> None:
        self._turns[turn_id] = thread_id

    def bind_item(self, item_id: str, thread_id: str) -> None:
        self._items[item_id] = thread_id

    def turn_owner(self, turn_id: str) -> str:
        return self._turns.get(turn_id, "")

    def agent(self, thread_id: str) -> AgentRoute | None:
        return self._agents.get(thread_id)

    def forget_turn(self, turn_id: str) -> None:
        self._turns.pop(turn_id, None)

    def forget_item(self, item_id: str) -> None:
        self._items.pop(item_id, None)

    def close(self, thread_id: str) -> None:
        self._turns = {key: owner for key, owner in self._turns.items() if owner != thread_id}
        self._items = {key: owner for key, owner in self._items.items() if owner != thread_id}
        self._agents = {
            key: route for key, route in self._agents.items() if route.owner_thread_id != thread_id
        }
        self._agent_statuses = {
            key: status for key, status in self._agent_statuses.items() if key in self._agents
        }
        self._agent_activity_at = {
            key: observed
            for key, observed in self._agent_activity_at.items()
            if key in self._agents
        }
        self._agent_summaries = {
            key: summary for key, summary in self._agent_summaries.items() if key[0] in self._agents
        }

    def append_agent_summary(self, thread_id: str, item_id: str, delta: str) -> str:
        if not item_id or not delta:
            return self._agent_summaries.get((thread_id, item_id), "")
        key = (thread_id, item_id)
        summary = (self._agent_summaries.get(key, "") + delta)[-SUBAGENT_SUMMARY_LIMIT:]
        self._agent_summaries[key] = summary
        return summary

    def agent_summary(self, thread_id: str, item_id: str) -> str:
        return self._agent_summaries.get((thread_id, item_id), "")

    def forget_agent_summary(self, thread_id: str, item_id: str) -> None:
        self._agent_summaries.pop((thread_id, item_id), None)

    def forget_agent_summaries(self, thread_id: str) -> None:
        self._agent_summaries = {
            key: summary for key, summary in self._agent_summaries.items() if key[0] != thread_id
        }

    def register_agents(
        self,
        owner_thread_id: str,
        owner_turn_id: str,
        item: Mapping[str, Any],
        attached: Collection[str],
    ) -> None:
        item_type = str(item.get("type") or "")
        owner_item_id = str(item.get("id") or "")
        if item_type == CODEX_COLLAB_TOOL_CALL_ITEM_TYPE:
            raw = item.get("receiverThreadIds")
            candidates = [str(entry or "") for entry in raw] if isinstance(raw, list) else []
            agent_path = ""
        elif item_type == CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE:
            candidates = [str(item.get("agentThreadId") or "")]
            agent_path = str(item.get("agentPath") or "")
        else:
            return
        for agent_thread_id in candidates:
            if not agent_thread_id or agent_thread_id in attached:
                continue
            existing = self._agents.get(agent_thread_id)
            if existing is not None and not agent_path:
                continue
            self._agents[agent_thread_id] = AgentRoute(
                owner_thread_id=owner_thread_id,
                owner_turn_id=owner_turn_id,
                owner_item_id=owner_item_id,
                agent_path=agent_path,
            )

    def update_agent_status(self, thread_id: str, status: str) -> bool:
        if not thread_id or not status or self._agent_statuses.get(thread_id) == status:
            return False
        self._agent_statuses[thread_id] = status
        return True

    def observe_agent_activity(
        self, thread_id: str, *, now: float, interval: float, boundary: bool
    ) -> bool:
        if self._agent_statuses.get(thread_id) in {
            TurnStatus.COMPLETED.value,
            TurnStatus.FAILED.value,
            TurnStatus.INTERRUPTED.value,
            "cancelled",
        }:
            return False
        previous = self._agent_activity_at.get(thread_id)
        if not boundary and previous is not None and now - previous < interval:
            return False
        self._agent_activity_at[thread_id] = now
        return True

    def resolve(self, params: Mapping[str, Any]) -> str:
        thread_id = str(params.get("threadId") or "")
        if thread_id:
            return thread_id
        turn_id = str(params.get("turnId") or "")
        if turn_id and turn_id in self._turns:
            return self._turns[turn_id]
        item_id = str(params.get("itemId") or "")
        if item_id and item_id in self._items:
            return self._items[item_id]
        return ""
