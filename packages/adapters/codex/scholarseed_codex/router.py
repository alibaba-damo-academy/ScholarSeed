"""Native thread, turn, item and child-agent correlation ownership."""

from collections.abc import Collection, Mapping
from dataclasses import dataclass
from typing import Any

from scholarseed_codex.protocol.state import (
    CODEX_COLLAB_TOOL_CALL_ITEM_TYPE,
    CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE,
)


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
