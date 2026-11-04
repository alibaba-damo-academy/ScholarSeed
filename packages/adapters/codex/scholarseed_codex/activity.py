"""Codex native execution tree ownership, interruption and quiescence."""

import asyncio
import json
import logging
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Mapping, Protocol

from scholarseed_codex.protocol.constants import MCP_TOOL_NAME_PREFIX
from scholarseed_codex.protocol.mcp import JsonValue
from scholarseed_codex.protocol.session import CodexNativeActivityCategory
from scholarseed_codex.protocol.state import AppServerError
from scholarseed_codex.utils import path_identity
from scholarseed_runtime.contract.session import RuntimeExecutionThread, RuntimeExecutionTreeBlocker

NATIVE_ACTIVITY_PAGE_SIZE = 100
LOGGER = logging.getLogger(__name__)
NATIVE_ACTIVITY_MAX_PAGES = 100
NATIVE_THREAD_READ_METHOD = "thread/read"
NATIVE_THREAD_LOADED_LIST_METHOD = "thread/loaded/list"
NATIVE_THREAD_LIST_METHOD = "thread/list"
NATIVE_BACKGROUND_TERMINALS_LIST_METHOD = "thread/backgroundTerminals/list"
NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD = "thread/backgroundTerminals/terminate"
NATIVE_GOAL_GET_METHOD = "thread/goal/get"
NATIVE_QUEUE_LIST_METHOD = "thread/queue/list"
NATIVE_TURNS_LIST_METHOD = "thread/turns/list"
NATIVE_TURN_INTERRUPT_METHOD = "turn/interrupt"
NATIVE_TURN_ID_FIELD = "turnId"
NATIVE_ITEMS_VIEW_FIELD = "itemsView"
NATIVE_ITEMS_NOT_LOADED = "notLoaded"
NATIVE_TURN_ACTIVE_STATUS = "inProgress"
NATIVE_TURN_TERMINAL_STATUSES = frozenset({"completed", "interrupted", "failed"})
NATIVE_INTERRUPT_SECONDS = 10.0
NATIVE_INTERRUPT_POLL_SECONDS = 0.2
NATIVE_INTERRUPT_EMPTY_CONFIRMATIONS = 2
NATIVE_INTERRUPT_ERROR = "codex_execution_tree_interrupt_failed"
NATIVE_THREAD_ID_FIELD = "threadId"
NATIVE_INCLUDE_TURNS_FIELD = "includeTurns"
NATIVE_CURSOR_FIELD = "cursor"
NATIVE_LIMIT_FIELD = "limit"
NATIVE_DATA_FIELD = "data"
NATIVE_NEXT_CURSOR_FIELD = "nextCursor"
NATIVE_THREAD_FIELD = "thread"
NATIVE_ID_FIELD = "id"
NATIVE_PARENT_THREAD_ID_FIELD = "parentThreadId"
NATIVE_EPHEMERAL_FIELD = "ephemeral"
NATIVE_ANCESTOR_THREAD_ID_FIELD = "ancestorThreadId"
NATIVE_SOURCE_KINDS_FIELD = "sourceKinds"
NATIVE_ARCHIVED_FIELD = "archived"
NATIVE_SUBAGENT_SOURCE_KINDS = (
    "subAgent",
    "subAgentReview",
    "subAgentCompact",
    "subAgentThreadSpawn",
    "subAgentOther",
)
NATIVE_STATUS_FIELD = "status"
NATIVE_TYPE_FIELD = "type"
NATIVE_ACTIVE_FLAGS_FIELD = "activeFlags"
NATIVE_GOAL_FIELD = "goal"
NATIVE_PROCESS_ID_FIELD = "processId"
NATIVE_ITEM_ID_FIELD = "itemId"
NATIVE_CLIENT_USER_MESSAGE_ID_FIELD = "clientUserMessageId"
NATIVE_INPUT_FIELD = "input"
NATIVE_IDLE_STATUS = "idle"
NATIVE_ACTIVE_STATUS = "active"
NATIVE_SYSTEM_ERROR_STATUS = "systemError"
NATIVE_QUIESCENT_THREAD_STATUSES = frozenset({NATIVE_IDLE_STATUS, NATIVE_SYSTEM_ERROR_STATUS})
NATIVE_COMPLETE_GOAL_STATUS = "complete"
NATIVE_THREAD_ACTIVE_FLAGS = frozenset({"waitingOnApproval", "waitingOnUserInput"})
NATIVE_GOAL_STATUSES = frozenset(
    {
        "active",
        "paused",
        "blocked",
        "usageLimited",
        "budgetLimited",
        NATIVE_COMPLETE_GOAL_STATUS,
    }
)


class NativeActivityBlocker(str, Enum):
    TURN = "native_turn_active"
    BACKGROUND_TERMINAL = "native_background_terminal_active"
    GOAL = "native_goal_unfinished"
    QUEUED_SUBMISSION = "native_submission_queued"
    UNAVAILABLE = "native_activity_unavailable"
    INVALID_RESPONSE = "native_activity_invalid_response"
    GENERATION_CHANGED = "native_activity_generation_changed"
    LOADED_THREADS_CHANGED = "native_loaded_threads_changed"
    THREAD_NOT_LOADED = "native_thread_not_loaded"
    THREAD_PRESENT = "native_thread_present"
    UNKNOWN_OWNERSHIP = "native_thread_ownership_unknown"
    PAGINATION_INCOMPLETE = "native_activity_pagination_incomplete"


EXECUTION_TREE_BLOCKERS = {
    NativeActivityBlocker.TURN: RuntimeExecutionTreeBlocker.TURN.value,
    NativeActivityBlocker.BACKGROUND_TERMINAL: RuntimeExecutionTreeBlocker.BACKGROUND_TASK.value,
}


@dataclass(frozen=True)
class NativeActivityState:
    complete: bool
    blockers: tuple[str, ...]
    execution_tree_blockers: tuple[str, ...]
    loaded_thread_ids: tuple[str, ...]
    process_generation: int


class NativeActivityHost(Protocol):
    @property
    def process_generation(self) -> int: ...

    async def request(
        self, method: str, params: Any, *, generation: int | None = None
    ) -> dict[str, Any]: ...


class _NativeActivityError(ValueError):
    def __init__(self, blocker: NativeActivityBlocker) -> None:
        self.blocker = blocker
        super().__init__(blocker.value)


class NativeActivity:
    """Resolve one loaded native tree for inspection or explicit interruption.

    The caller owns command admission and an event-driven activity revision.
    This inspector checks every loaded descendant, but does not freeze Codex.
    A suspend ticket must therefore compare the revision again before commit.
    """

    def __init__(
        self,
        host: NativeActivityHost,
        root_thread_id: str = "",
        *,
        known_roots: tuple[str, ...] = (),
    ) -> None:
        self._host = host
        self._root_thread_id = root_thread_id
        self._known_roots = frozenset(value for value in (*known_roots, root_thread_id) if value)

    async def descendants(self) -> tuple[RuntimeExecutionThread, ...]:
        generation = self._host.process_generation
        if not self._root_thread_id:
            raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
        candidates: dict[str, dict[str, Any]] = {}
        for archived in (False, True):
            rows = await self._pages(
                NATIVE_THREAD_LIST_METHOD,
                {
                    NATIVE_ANCESTOR_THREAD_ID_FIELD: self._root_thread_id,
                    NATIVE_SOURCE_KINDS_FIELD: list(NATIVE_SUBAGENT_SOURCE_KINDS),
                    NATIVE_ARCHIVED_FIELD: archived,
                },
                generation,
            )
            for row in rows:
                if not isinstance(row, dict):
                    raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
                thread_id = row.get(NATIVE_ID_FIELD)
                if (
                    not isinstance(thread_id, str)
                    or not thread_id
                    or thread_id == self._root_thread_id
                ):
                    raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
                candidates[thread_id] = await self._thread(thread_id, generation)
        descendants: list[RuntimeExecutionThread] = []
        for thread_id, thread in candidates.items():
            parent_id = thread[NATIVE_PARENT_THREAD_ID_FIELD]
            ancestor = parent_id
            visited = {thread_id}
            while ancestor != self._root_thread_id:
                if not ancestor or ancestor in visited or ancestor not in candidates:
                    raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
                visited.add(ancestor)
                ancestor = candidates[ancestor][NATIVE_PARENT_THREAD_ID_FIELD]
            descendants.append(RuntimeExecutionThread(thread_id, parent_id))
        self._require_generation(generation)
        return tuple(sorted(descendants, key=lambda node: node.thread_id))

    async def inspect(self) -> NativeActivityState:
        return await self._inspect(root_absent=False)

    async def inspect_absence(self) -> NativeActivityState:
        return await self._inspect(root_absent=True)

    async def _inspect(self, *, root_absent: bool) -> NativeActivityState:
        generation = self._host.process_generation
        loaded_ids: tuple[str, ...] = ()
        blockers: set[NativeActivityBlocker] = set()
        try:
            loaded_ids = await self._loaded(generation)
            if root_absent and not self._root_thread_id:
                raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
            if root_absent and self._root_thread_id in loaded_ids:
                raise _NativeActivityError(NativeActivityBlocker.THREAD_PRESENT)
            if not root_absent and self._root_thread_id and self._root_thread_id not in loaded_ids:
                raise _NativeActivityError(NativeActivityBlocker.THREAD_NOT_LOADED)
            threads = {
                thread_id: await self._thread(thread_id, generation) for thread_id in loaded_ids
            }
            owned_ids = self._owned_threads(threads)
            for thread_id in owned_ids:
                blockers.update(self._thread_blockers(threads[thread_id]))
                await self._background(thread_id, generation, blockers)
                if threads[thread_id].get(NATIVE_EPHEMERAL_FIELD) is not True:
                    await self._goal(thread_id, generation, blockers)
                    await self._queue(thread_id, generation, blockers)
            if await self._loaded(generation) != loaded_ids:
                raise _NativeActivityError(NativeActivityBlocker.LOADED_THREADS_CHANGED)
            # A second native status read closes an obvious polling race. Event
            # revisions still protect changes between this read and commit.
            for thread_id in owned_ids:
                blockers.update(self._thread_blockers(await self._thread(thread_id, generation)))
            self._require_generation(generation)
        except _NativeActivityError as error:
            LOGGER.warning(
                "codex_native_activity_refused reason=%s generation=%s loaded_threads=%s",
                error.blocker.value,
                generation,
                len(loaded_ids),
            )
            blockers.add(error.blocker)
            return self._state(False, blockers, loaded_ids, generation)
        except AppServerError as error:
            LOGGER.warning(
                "codex_native_activity_unavailable generation=%s method=%s rpc_code=%s",
                generation,
                error.method,
                error.rpc_code,
            )
            # The transport owns detailed RPC evidence; this surface exports
            # only a stable reason, never command contents or native paths.
            blockers.add(NativeActivityBlocker.UNAVAILABLE)
            return self._state(False, blockers, loaded_ids, generation)
        return self._state(True, blockers, loaded_ids, generation)

    async def interrupt(self, *, cleanup_background_processes: bool = False) -> None:
        """Stop owned execution, including children surviving a completed root turn.

        Native spawns can race the first inventory. Re-enumerate until two empty
        observations; the caller still needs the revision-checked suspend/drain
        protocol. Goals and queued user input are preserved and remain blockers.
        """
        if not self._root_thread_id:
            raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
        generation = self._host.process_generation
        deadline = asyncio.get_running_loop().time() + NATIVE_INTERRUPT_SECONDS
        empty = 0
        while True:
            loaded = await self._loaded(generation)
            if self._root_thread_id not in loaded:
                raise _NativeActivityError(NativeActivityBlocker.THREAD_NOT_LOADED)
            threads = {key: await self._thread(key, generation) for key in loaded}
            owned = self._owned_threads(threads)
            # Resolve and validate the entire ownership snapshot before any write.
            turns: list[tuple[str, str]] = []
            terminals: list[tuple[str, str]] = []
            for thread_id in owned:
                if self._thread_blockers(threads[thread_id]):
                    rows = await self._pages(
                        NATIVE_TURNS_LIST_METHOD,
                        {
                            NATIVE_THREAD_ID_FIELD: thread_id,
                            NATIVE_ITEMS_VIEW_FIELD: NATIVE_ITEMS_NOT_LOADED,
                        },
                        generation,
                    )
                    for row in rows:
                        if (
                            not isinstance(row, dict)
                            or not isinstance(row.get(NATIVE_ID_FIELD), str)
                            or not row[NATIVE_ID_FIELD]
                            or row.get(NATIVE_STATUS_FIELD)
                            not in NATIVE_TURN_TERMINAL_STATUSES | {NATIVE_TURN_ACTIVE_STATUS}
                        ):
                            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
                        if row[NATIVE_STATUS_FIELD] == NATIVE_TURN_ACTIVE_STATUS:
                            turns.append((thread_id, row[NATIVE_ID_FIELD]))
                if cleanup_background_processes:
                    rows = await self._pages(
                        NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
                        {NATIVE_THREAD_ID_FIELD: thread_id},
                        generation,
                    )
                    for row in rows:
                        if not isinstance(row, dict) or any(
                            not isinstance(row.get(key), str) or not row[key]
                            for key in (NATIVE_PROCESS_ID_FIELD, NATIVE_ITEM_ID_FIELD)
                        ):
                            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
                        terminals.append((thread_id, row[NATIVE_PROCESS_ID_FIELD]))
            for thread_id, turn_id in turns:
                await self._request(
                    NATIVE_TURN_INTERRUPT_METHOD,
                    {NATIVE_THREAD_ID_FIELD: thread_id, NATIVE_TURN_ID_FIELD: turn_id},
                    generation,
                )
            for thread_id, process_id in terminals:
                result = await self._request(
                    NATIVE_BACKGROUND_TERMINALS_TERMINATE_METHOD,
                    {NATIVE_THREAD_ID_FIELD: thread_id, NATIVE_PROCESS_ID_FIELD: process_id},
                    generation,
                )
                if not isinstance(result.get("terminated"), bool):
                    raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
            active = any(self._thread_blockers(threads[key]) for key in owned)
            empty = (
                empty + 1
                if not active and not terminals and await self._loaded(generation) == loaded
                else 0
            )
            if empty >= NATIVE_INTERRUPT_EMPTY_CONFIRMATIONS:
                return
            if asyncio.get_running_loop().time() >= deadline:
                raise AppServerError(
                    "Codex execution tree did not stop", safe_error=NATIVE_INTERRUPT_ERROR
                )
            await asyncio.sleep(NATIVE_INTERRUPT_POLL_SECONDS)

    @staticmethod
    def _state(
        complete: bool,
        blockers: set[NativeActivityBlocker],
        loaded_ids: tuple[str, ...],
        generation: int,
    ) -> NativeActivityState:
        return NativeActivityState(
            complete,
            tuple(sorted(blocker.value for blocker in blockers)),
            tuple(
                sorted(
                    EXECUTION_TREE_BLOCKERS[blocker]
                    for blocker in blockers
                    if blocker in EXECUTION_TREE_BLOCKERS
                )
            ),
            loaded_ids,
            generation,
        )

    def _require_generation(self, generation: int) -> None:
        if self._host.process_generation != generation:
            raise _NativeActivityError(NativeActivityBlocker.GENERATION_CHANGED)

    async def _request(
        self, method: str, params: dict[str, Any], generation: int
    ) -> dict[str, Any]:
        self._require_generation(generation)
        result = await self._host.request(method, params, generation=generation)
        self._require_generation(generation)
        if not isinstance(result, dict):
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        return result

    async def _pages(self, method: str, params: dict[str, Any], generation: int) -> list[Any]:
        cursor: str | None = None
        seen: set[str] = set()
        rows: list[Any] = []
        for _ in range(NATIVE_ACTIVITY_MAX_PAGES):
            request = {**params, NATIVE_LIMIT_FIELD: NATIVE_ACTIVITY_PAGE_SIZE}
            if cursor is not None:
                request[NATIVE_CURSOR_FIELD] = cursor
            result = await self._request(method, request, generation)
            page = result.get(NATIVE_DATA_FIELD)
            if not isinstance(page, list):
                raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
            rows.extend(page)
            cursor = result.get(NATIVE_NEXT_CURSOR_FIELD)
            if cursor is None:
                return rows
            if not isinstance(cursor, str) or not cursor or cursor in seen:
                raise _NativeActivityError(NativeActivityBlocker.PAGINATION_INCOMPLETE)
            seen.add(cursor)
        raise _NativeActivityError(NativeActivityBlocker.PAGINATION_INCOMPLETE)

    async def _loaded(self, generation: int) -> tuple[str, ...]:
        rows = await self._pages(NATIVE_THREAD_LOADED_LIST_METHOD, {}, generation)
        if any(not isinstance(row, str) or not row for row in rows) or len(rows) != len(set(rows)):
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        return tuple(sorted(rows))

    async def _thread(self, thread_id: str, generation: int) -> dict[str, Any]:
        result = await self._request(
            NATIVE_THREAD_READ_METHOD,
            {NATIVE_THREAD_ID_FIELD: thread_id, NATIVE_INCLUDE_TURNS_FIELD: False},
            generation,
        )
        thread = result.get(NATIVE_THREAD_FIELD)
        if not isinstance(thread, dict) or thread.get(NATIVE_ID_FIELD) != thread_id:
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        # Missing parent identity is unknown, not evidence of a root thread.
        if NATIVE_PARENT_THREAD_ID_FIELD not in thread:
            LOGGER.warning(
                "codex_native_activity_identity_unknown generation=%s parent_field_present=false",
                generation,
            )
            raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
        parent_id = thread[NATIVE_PARENT_THREAD_ID_FIELD]
        if parent_id is not None and (not isinstance(parent_id, str) or not parent_id):
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        return thread

    def _owned_threads(self, threads: dict[str, dict[str, Any]]) -> tuple[str, ...]:
        owned: set[str] = set()
        for thread_id in threads:
            path: set[str] = set()
            ancestor = thread_id
            while ancestor != self._root_thread_id:
                if ancestor in path or ancestor not in threads:
                    raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
                path.add(ancestor)
                parent = threads[ancestor][NATIVE_PARENT_THREAD_ID_FIELD]
                if parent is None:
                    if ancestor not in self._known_roots:
                        raise _NativeActivityError(NativeActivityBlocker.UNKNOWN_OWNERSHIP)
                    if not self._root_thread_id:
                        owned.add(thread_id)
                    break
                ancestor = parent
            else:
                owned.add(thread_id)
        return tuple(sorted(owned))

    @staticmethod
    def _thread_blockers(thread: dict[str, Any]) -> set[NativeActivityBlocker]:
        status = thread.get(NATIVE_STATUS_FIELD)
        if not isinstance(status, dict):
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        kind = status.get(NATIVE_TYPE_FIELD)
        if kind in NATIVE_QUIESCENT_THREAD_STATUSES:
            return set()
        if kind == NATIVE_ACTIVE_STATUS:
            flags = status.get(NATIVE_ACTIVE_FLAGS_FIELD)
            if not isinstance(flags, list) or any(
                not isinstance(flag, str) or flag not in NATIVE_THREAD_ACTIVE_FLAGS
                for flag in flags
            ):
                raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
            return {NativeActivityBlocker.TURN}
        raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)

    async def _background(
        self, thread_id: str, generation: int, blockers: set[NativeActivityBlocker]
    ) -> None:
        rows = await self._pages(
            NATIVE_BACKGROUND_TERMINALS_LIST_METHOD,
            {NATIVE_THREAD_ID_FIELD: thread_id},
            generation,
        )
        for row in rows:
            if not isinstance(row, dict) or any(
                not isinstance(row.get(key), str) or not row[key]
                for key in (NATIVE_PROCESS_ID_FIELD, NATIVE_ITEM_ID_FIELD)
            ):
                raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        if rows:
            blockers.add(NativeActivityBlocker.BACKGROUND_TERMINAL)

    async def _goal(
        self, thread_id: str, generation: int, blockers: set[NativeActivityBlocker]
    ) -> None:
        result = await self._request(
            NATIVE_GOAL_GET_METHOD, {NATIVE_THREAD_ID_FIELD: thread_id}, generation
        )
        if NATIVE_GOAL_FIELD not in result:
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        goal = result[NATIVE_GOAL_FIELD]
        if goal is None:
            return
        if (
            not isinstance(goal, dict)
            or goal.get(NATIVE_THREAD_ID_FIELD) != thread_id
            or not isinstance(goal.get(NATIVE_STATUS_FIELD), str)
            or goal.get(NATIVE_STATUS_FIELD) not in NATIVE_GOAL_STATUSES
        ):
            raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        if goal[NATIVE_STATUS_FIELD] != NATIVE_COMPLETE_GOAL_STATUS:
            blockers.add(NativeActivityBlocker.GOAL)

    async def _queue(
        self, thread_id: str, generation: int, blockers: set[NativeActivityBlocker]
    ) -> None:
        rows = await self._pages(
            NATIVE_QUEUE_LIST_METHOD, {NATIVE_THREAD_ID_FIELD: thread_id}, generation
        )
        for row in rows:
            if (
                not isinstance(row, dict)
                or not isinstance(row.get(NATIVE_ID_FIELD), str)
                or not row[NATIVE_ID_FIELD]
                or not isinstance(row.get(NATIVE_CLIENT_USER_MESSAGE_ID_FIELD), str)
                or not isinstance(row.get(NATIVE_INPUT_FIELD), list)
            ):
                raise _NativeActivityError(NativeActivityBlocker.INVALID_RESPONSE)
        if rows:
            blockers.add(NativeActivityBlocker.QUEUED_SUBMISSION)


CODEX_NATIVE_ACTIVITY_TEXT_LIMIT = 4_000


CODEX_NATIVE_ACTIVITY_FAILURE_STATUSES = frozenset(
    {
        "aborted",
        "cancelled",
        "declined",
        "denied",
        "error",
        "failed",
        "rejected",
        "timedout",
    }
)


CODEX_AUTO_APPROVAL_ACTIVITY_TYPE = "approval_review"
CODEX_STRICT_REVIEW_ACTIVITY_TYPE = "approval_strict_review"
CODEX_STRICT_REVIEW_STATUS = "strict_review_required"
CODEX_STRICT_REVIEW_ITEM_PREFIX = "strict-review-"
CODEX_AUTO_APPROVAL_REVIEW_FIELD = "review"
CODEX_AUTO_APPROVAL_ACTION_FIELD = "action"
CODEX_AUTO_APPROVAL_ACTION_TYPE_FIELD = "type"
CODEX_AUTO_APPROVAL_STARTED_AT_FIELD = "startedAtMs"
CODEX_AUTO_APPROVAL_COMPLETED_AT_FIELD = "completedAtMs"
CODEX_AUTO_APPROVAL_IN_PROGRESS_STATUS = "inProgress"
CODEX_AUTO_APPROVAL_COMPLETED_STATUS = "completed"

# `item/autoApprovalReview/*` 的字段来自上游契约 (codex 0.155.1 app-server-protocol v2:
# ItemGuardianApprovalReview{Started,Completed}Notification + GuardianApprovalReview)。
# 机器审批没有用户可见卡片, 事后审计只剩这些属性, 所以按契约逐字段登记而不是挑几个:
# 早先只投 action/riskLevel/rationale/decisionSource, 把 userAuthorization (复核者对
# 「用户到底授权到什么程度」的判断) 和 targetItemId (审批针对哪个 item) 静默丢掉了。
# 上游新增字段时在这里加一行数据即可, 不需要改投影逻辑。
CODEX_AUTO_APPROVAL_PARAM_FIELDS = (
    ("targetItemId", "target_item_id"),
    ("decisionSource", "decision_source"),
)
CODEX_AUTO_APPROVAL_REVIEW_FIELDS = (
    ("riskLevel", "risk_level"),
    ("userAuthorization", "user_authorization"),
    ("rationale", "rationale"),
)
CODEX_AUTO_APPROVAL_DURATION_FIELD = "review_duration_ms"
CODEX_AUTO_APPROVAL_ACTION_TYPE_DETAIL = "action_type"
CODEX_STRICT_REVIEW_STARTED_AT_DETAIL = "started_at_ms"


@dataclass(frozen=True)
class _NativeActivitySpec:
    activity_type: str
    category: CodexNativeActivityCategory
    detail_fields: tuple[tuple[str, str], ...] = ()


CODEX_NATIVE_ACTIVITY_SPECS = {
    "hookPrompt": _NativeActivitySpec(
        "hook_prompt",
        CodexNativeActivityCategory.MODE,
    ),
    "plan": _NativeActivitySpec(
        "plan",
        CodexNativeActivityCategory.MODE,
        (("text", "text"),),
    ),
    "collabAgentToolCall": _NativeActivitySpec(
        "agent_collaboration",
        CodexNativeActivityCategory.COLLABORATION,
        (
            ("tool", "operation"),
            ("prompt", "prompt"),
            ("receiverThreadIds", "receiver_thread_ids"),
            ("model", "model"),
            ("reasoningEffort", "reasoning_effort"),
        ),
    ),
    "subAgentActivity": _NativeActivitySpec(
        "subagent_activity",
        CodexNativeActivityCategory.COLLABORATION,
        (
            ("kind", "activity"),
            ("agentThreadId", "agent_thread_id"),
            ("agentPath", "agent_path"),
        ),
    ),
    "imageView": _NativeActivitySpec(
        "image_view",
        CodexNativeActivityCategory.MEDIA,
        (("path", "path"),),
    ),
    "sleep": _NativeActivitySpec(
        "wait",
        CodexNativeActivityCategory.WAIT,
        (("durationMs", "duration_ms"),),
    ),
    "imageGeneration": _NativeActivitySpec(
        "image_generation",
        CodexNativeActivityCategory.MEDIA,
        (
            ("revisedPrompt", "revised_prompt"),
            ("savedPath", "saved_path"),
            ("transparentBackground", "transparent_background"),
            ("failure", "failure"),
        ),
    ),
    "enteredReviewMode": _NativeActivitySpec(
        "review_entered",
        CodexNativeActivityCategory.MODE,
        (("review", "review"),),
    ),
    "exitedReviewMode": _NativeActivitySpec(
        "review_exited",
        CodexNativeActivityCategory.MODE,
        (("review", "review"),),
    ),
}


def search_payload(source: Mapping[str, Any]) -> Mapping[str, JsonValue]:
    action = source.get("action")
    results = source.get("results")
    return {
        "query": str(source.get("query") or ""),
        "action": dict(action) if isinstance(action, Mapping) else {},
        **({"results": list(results)} if isinstance(results, list) else {}),
    }


def skill_for_command(
    active_skill_inputs: Mapping[str, str],
    item: Mapping[str, Any],
) -> tuple[str, str] | None:
    if not active_skill_inputs:
        return None
    for action in list(item.get("commandActions") or []):
        if str(action.get("type") or "") != "read":
            continue
        raw_path = str(action.get("path") or "")
        if not raw_path:
            continue
        skill_path = str(Path(raw_path).expanduser().resolve())
        skill_name = active_skill_inputs.get(path_identity(Path(raw_path)))
        if skill_name:
            return skill_name, skill_path
    return None


def skill_activity_payload(
    skill: tuple[str, str],
    *,
    completed: bool,
    item: Mapping[str, Any],
) -> Mapping[str, JsonValue]:
    name, path = skill
    status = str(item.get("status") or ("completed" if completed else "running"))
    failure = item.get("failure") or item.get("exitCode") not in (None, 0)
    return {
        "skill": name,
        "path": path,
        "status": status,
        "ok": completed
        and not failure
        and status.lower() not in CODEX_NATIVE_ACTIVITY_FAILURE_STATUSES,
    }


def native_activity_payload(
    item: Mapping[str, Any],
    *,
    completed: bool,
) -> Mapping[str, JsonValue]:
    item_type = str(item.get("type") or "runtimeActivity")
    spec = CODEX_NATIVE_ACTIVITY_SPECS.get(
        item_type,
        _NativeActivitySpec("runtime_activity", CodexNativeActivityCategory.OTHER),
    )
    details: dict[str, JsonValue] = {}
    truncated = False
    for source, target in spec.detail_fields:
        value = item.get(source)
        if value is None or value == "" or value == [] or value == {}:
            continue
        details[target] = _bounded_activity_value(value)
        truncated = truncated or details[target] != value
    if spec.activity_type == "runtime_activity":
        details["native_type"] = item_type
    status = str(item.get("status") or ("completed" if completed else "running"))
    failure = item.get("failure")
    return {
        "activity_type": spec.activity_type,
        "category": spec.category.value,
        "details": details,
        "content_truncated": truncated,
        "status": status,
        "ok": completed
        and not failure
        and status.lower() not in CODEX_NATIVE_ACTIVITY_FAILURE_STATUSES,
    }


def auto_approval_duration_ms(params: Mapping[str, Any]) -> int | None:
    started = params.get(CODEX_AUTO_APPROVAL_STARTED_AT_FIELD)
    completed = params.get(CODEX_AUTO_APPROVAL_COMPLETED_AT_FIELD)
    if isinstance(started, bool) or isinstance(completed, bool):
        return None
    if not isinstance(started, int) or not isinstance(completed, int):
        return None
    duration = completed - started
    return duration if duration >= 0 else None


def auto_approval_payload(
    params: Mapping[str, Any],
    *,
    completed: bool,
) -> Mapping[str, JsonValue]:
    review = params.get(CODEX_AUTO_APPROVAL_REVIEW_FIELD)
    review_values = dict(review) if isinstance(review, Mapping) else {}
    action = params.get(CODEX_AUTO_APPROVAL_ACTION_FIELD)
    action_values = dict(action) if isinstance(action, Mapping) else {}
    status = str(
        review_values.get(NATIVE_STATUS_FIELD)
        or (
            CODEX_AUTO_APPROVAL_COMPLETED_STATUS
            if completed
            else CODEX_AUTO_APPROVAL_IN_PROGRESS_STATUS
        )
    )
    details: dict[str, JsonValue] = {
        CODEX_AUTO_APPROVAL_ACTION_FIELD: _bounded_activity_value(action),
        CODEX_AUTO_APPROVAL_ACTION_TYPE_DETAIL: _bounded_activity_value(
            action_values.get(CODEX_AUTO_APPROVAL_ACTION_TYPE_FIELD)
        ),
    }
    for source, target in CODEX_AUTO_APPROVAL_PARAM_FIELDS:
        details[target] = _bounded_activity_value(params.get(source))
    for source, target in CODEX_AUTO_APPROVAL_REVIEW_FIELDS:
        details[target] = _bounded_activity_value(review_values.get(source))
    details[CODEX_AUTO_APPROVAL_DURATION_FIELD] = auto_approval_duration_ms(params)
    return {
        "activity_type": CODEX_AUTO_APPROVAL_ACTIVITY_TYPE,
        "category": CodexNativeActivityCategory.MODE.value,
        "details": {key: value for key, value in details.items() if value is not None},
        "status": status,
        "ok": completed and status.lower() not in CODEX_NATIVE_ACTIVITY_FAILURE_STATUSES,
    }


def strict_review_item_id(params: Mapping[str, Any], turn_id: str) -> str:
    """Give the one-shot strict-review notice a stable identity of its own.

    Upstream sends no reviewId here, and Serve deduplicates activities by item id, so a
    shared placeholder would collapse every strict review of a turn into one row.
    """
    started = params.get(CODEX_AUTO_APPROVAL_STARTED_AT_FIELD)
    suffix = str(started) if isinstance(started, int) and not isinstance(started, bool) else turn_id
    return f"{CODEX_STRICT_REVIEW_ITEM_PREFIX}{suffix}"


def strict_review_payload(params: Mapping[str, Any]) -> Mapping[str, JsonValue]:
    details = {
        CODEX_STRICT_REVIEW_STARTED_AT_DETAIL: _bounded_activity_value(
            params.get(CODEX_AUTO_APPROVAL_STARTED_AT_FIELD)
        )
    }
    return {
        "activity_type": CODEX_STRICT_REVIEW_ACTIVITY_TYPE,
        "category": CodexNativeActivityCategory.MODE.value,
        "details": {key: value for key, value in details.items() if value is not None},
        "status": CODEX_STRICT_REVIEW_STATUS,
        "ok": True,
    }


def collaboration_receivers(item: Mapping[str, Any]) -> tuple[str, ...]:
    values = item.get("receiverThreadIds")
    if not isinstance(values, list):
        return ()
    return tuple(str(value) for value in values if str(value or ""))


def collaboration_activity_payload(
    item: Mapping[str, Any],
    *,
    agent_thread_id: str,
    completed: bool,
) -> Mapping[str, JsonValue]:
    payload = dict(native_activity_payload(item, completed=completed))
    raw_details = payload.get("details")
    details = dict(raw_details) if isinstance(raw_details, Mapping) else {}
    details["receiver_thread_ids"] = [agent_thread_id]
    details["agent_thread_id"] = agent_thread_id
    states = item.get("agentsStates")
    state = states.get(agent_thread_id) if isinstance(states, Mapping) else None
    if isinstance(state, Mapping) and state.get("status"):
        details["agent_status"] = _bounded_activity_value(state["status"])
    payload["details"] = details
    return payload


def subagent_lifecycle_payload(
    *,
    agent_thread_id: str,
    agent_path: str,
    status: str,
    completed: bool,
) -> Mapping[str, JsonValue]:
    return native_activity_payload(
        {
            "type": "subAgentActivity",
            "kind": status,
            "status": status,
            "agentThreadId": agent_thread_id,
            "agentPath": agent_path,
        },
        completed=completed,
    )


def public_summary_parts(item: Mapping[str, Any]) -> tuple[str, ...]:
    summary = item.get("summary")
    if not isinstance(summary, list):
        return ()
    return tuple(part for part in summary if isinstance(part, str))


def subagent_item_summary(item: Mapping[str, Any]) -> str:
    if item.get("type") == "reasoning":
        return "\n\n".join(public_summary_parts(item))[:CODEX_NATIVE_ACTIVITY_TEXT_LIMIT]
    if item.get("type") != "commandExecution":
        return ""
    parts = []
    command = item.get("command")
    if isinstance(command, str) and command:
        parts.append(command[:CODEX_NATIVE_ACTIVITY_TEXT_LIMIT])
    output = item.get("aggregatedOutput")
    if isinstance(output, str) and output:
        parts.append(output[:CODEX_NATIVE_ACTIVITY_TEXT_LIMIT])
    exit_code = item.get("exitCode")
    if isinstance(exit_code, int):
        parts.append(f"exit_code={exit_code}")
    return "\n\n".join(parts)


def subagent_status_payload(
    *,
    agent_thread_id: str,
    agent_path: str,
    activity: str,
    phase: str,
    activity_item_id: str = "",
    public_summary: str = "",
    item: Mapping[str, Any] | None = None,
) -> Mapping[str, JsonValue]:
    payload = dict(
        subagent_lifecycle_payload(
            agent_thread_id=agent_thread_id,
            agent_path=agent_path,
            status="running",
            completed=False,
        )
    )
    raw_details = payload.get("details")
    details = dict(raw_details) if isinstance(raw_details, Mapping) else {}
    details["recent_activity"] = activity
    details["activity_phase"] = phase
    details["activity_item_id"] = activity_item_id
    if public_summary:
        details["public_summary"] = public_summary
    if item:
        tool = tool_item_payload(item)
        if tool is not None:
            details["tool"] = _bounded_activity_value(
                {
                    **tool,
                    **(tool_item_result(item) if phase == "completed" else {}),
                }
            )
    payload["details"] = details
    return payload


def tool_item_payload(item: Mapping[str, Any]) -> Mapping[str, JsonValue] | None:
    item_type = item.get("type")
    if item_type == "commandExecution":
        return {
            "name": command_name(item),
            "input": {
                "command": item.get("command"),
                "cwd": item.get("cwd"),
                "actions": item.get("commandActions") or [],
            },
        }
    if item_type == "fileChange":
        return {"name": "file_change", "input": {"changes": item.get("changes") or []}}
    if item_type == "mcpToolCall":
        name = f"{MCP_TOOL_NAME_PREFIX}{item.get('server') or 'mcp'}__{item.get('tool') or 'tool'}"
        return {"name": name, "input": item.get("arguments") or {}}
    if item_type == "dynamicToolCall":
        return {
            "name": str(item.get("tool") or "dynamic_tool"),
            "input": item.get("arguments") or {},
        }
    return None


def tool_item_result(item: Mapping[str, Any], fallback_output: str = "") -> Mapping[str, JsonValue]:
    item_type = item.get("type")
    status = str(item.get("status") or "")
    if (
        item_type == "commandExecution"
        and isinstance(item.get("exitCode"), int)
        and item["exitCode"] != 0
    ):
        status = "failed"
    elif item_type in {"mcpToolCall", "dynamicToolCall"} and item.get("error"):
        status = "failed"
    output = str(item.get("aggregatedOutput") or fallback_output)
    output_fields = {
        "fileChange": ("changes",),
        "mcpToolCall": ("result", "error"),
        "dynamicToolCall": ("contentItems", "error"),
    }
    if item_type in output_fields:
        value: object = next(
            (item[field] for field in output_fields[item_type] if item.get(field)),
            {} if item_type == "mcpToolCall" else [],
        )
        output = json.dumps(value, ensure_ascii=False, default=str)
    return {
        "output": output,
        "ok": status == "completed",
        "status": status,
        **({"exit_code": item.get("exitCode")} if item_type == "commandExecution" else {}),
    }


def _bounded_activity_value(value: Any) -> JsonValue:
    if isinstance(value, str):
        return value[:CODEX_NATIVE_ACTIVITY_TEXT_LIMIT]
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    if isinstance(value, list):
        return [_bounded_activity_value(entry) for entry in value]
    if isinstance(value, Mapping):
        return {str(key): _bounded_activity_value(entry) for key, entry in value.items()}
    return str(value)[:CODEX_NATIVE_ACTIVITY_TEXT_LIMIT]


def command_name(item: Mapping[str, Any]) -> str:
    actions = list(item.get("commandActions") or [])
    kinds = {str(action.get("type") or "") for action in actions}
    if kinds and kinds <= {"read", "listFiles", "search"}:
        return "read"
    return "bash"
