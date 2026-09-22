"""Persistent literature-owned agentic search tasks."""

from __future__ import annotations

import asyncio
import builtins
import json
import logging
import os
import re
import shutil
import tempfile
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from scholarseed_runtime.contract import RuntimeEventKind
from service.chat.constants import SSE_HEARTBEAT_SECONDS
from service.invocation.service.model import (
    DEFAULT_INVOCATION_EXECUTION,
    InvocationCommand,
    InvocationSkill,
)
from service.invocation.service.runtime import (
    InvocationService,
    PreparedInvocation,
    TrustedInvocationWorkspace,
)
from service.paths import (
    LITERATURE_SEARCH_DIR,
    LITERATURE_SEARCH_QUERY_FILENAME,
    LITERATURE_SEARCH_STATE_FILENAME,
    LITERATURE_SEARCH_TASK_PREFIX,
)

SEARCH_SKILL_ID = "builtin:fast-search"
SEARCH_PROMPT_TEMPLATE = """
### Search Protocol Instructions

This is a **one-time, quick retrieval** via the search bar. Users have **no entry point for multi-turn dialogue**, and the keywords are **finalized by the user**. Even if the scope is broad, **do not ask follow-up questions**.

*   **Do not request clarification.**
*   **Do not provide options.**
*   **Immediately and strictly execute** the `Veryfast` workflow of the `fast-search` skill.

### Output Formatting & Progress Updates

The content wrapped between `<<<` and `>>>` will be **displayed to the user**. You must inform the user of the current step in **every stage** of execution using a **single, concise sentence**.

*   **Real-time Feedback Required:** Since skill execution takes time, you cannot wait until the end to output information. You must report progress at each step.
*   **Examples:**
    *   At the start: State your intended approach.
    *   Before calling a script: Describe what action you are taking.
    *   During branching logic: Explain the decision or next step.

### Critical Constraints

1.  **No Meta-Commentary:** **Do not** output sentences like *"The user wants me to wrap the output in <<< and >>>"*. This leaks internal instructions (specifically the character "and") to the user. **Even during reasoning/thinking processes, do not output such text.**
2.  **Completion Message:** Upon finishing the search, output **only** the completion status and the **number of results**. **Do not** output file paths.
3.  **Error Handling:** If any failure occurs or no result files are generated, output the **error reason**. If the `SCHOLARSEED_API_KEY` is missing, instruct the user that **login is required**.
4.  **Language Matching:** Your output language must match the **user's keyword language**.

**Search Keywords:** `{query}`
"""

SEARCH_RESULT_FILENAME = "metadata.json"
SEARCH_SCHEMA_VERSION = 1
SEARCH_RESULT_MAX_BYTES = 8 * 1024 * 1024
SEARCH_RESULT_MAX_PAPERS = 1_000
SEARCH_DELETE_WAIT_SECONDS = 10
SEARCH_TASK_PATTERN = re.compile(r"^task-(\d+)$")
SEARCH_STATUS_RUNNING = "running"
SEARCH_STATUS_COMPLETED = "completed"
SEARCH_STATUS_FAILED = "failed"
SEARCH_STATUS_INTERRUPTED = "interrupted"
SEARCH_STATUS_UNKNOWN = "unknown"
# 磁盘上还在、却不是成功终态的任务: 本进程既没有它的内存态, 也无法恢复执行。读侧统一投影
# 成这个只读状态, 而不是把内部错误码或"状态未知"抛给用户。
SEARCH_STATUS_UNRECOVERED = "search_interrupted"
SEARCH_COMPLETED_EVENT = "result.completed"
SEARCH_TERMINAL_STATUSES = {
    SEARCH_COMPLETED_EVENT: SEARCH_STATUS_COMPLETED,
    "invocation.failed": SEARCH_STATUS_FAILED,
    "invocation.interrupted": SEARCH_STATUS_INTERRUPTED,
    "invocation.unknown": SEARCH_STATUS_UNKNOWN,
}
SEARCH_TERMINAL_EVENTS = frozenset(SEARCH_TERMINAL_STATUSES)
SEARCH_RUNTIME_LOST = "literature_search_runtime_lost"
# 运行期事件只活在内存里: Windows 上每事件一次 CreateFile/fsync/rename 会被实时扫描、索引器
# 或同步客户端的句柄挡下(共享冲突), 而一次瞬时 IO 失败不该终结整场检索。落盘只剩两次 ——
# 创建时写已确定的信息, 成功终态写结果快照。
SEARCH_REPLAY_EVENT_LIMIT = 512
SEARCH_STATE_WRITE_ATTEMPTS = 4
SEARCH_STATE_WRITE_BACKOFF_SECONDS = 0.05
# content.delta 同时承载推理与用户可见两条通道, 适配器用 data.role 区分
# (packages/adapters/codex/scholarseed_codex/events.py)。推理文本里会出现字面 <<< >>>,
# 混进 output 会污染前端按定界符裁出的用户可见进度, 所以只累加非推理通道。
SEARCH_OUTPUT_EVENT_KIND = RuntimeEventKind.CONTENT_DELTA
SEARCH_REASONING_ROLE = "reasoning"

logger = logging.getLogger(__name__)


class LiteratureSearchError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class LiveSearch:
    """One search this process still owns: live state, replay buffer, SSE subscribers."""

    state: dict[str, Any]
    events: builtins.list[dict[str, Any]] = field(default_factory=builtins.list)
    subscribers: set[asyncio.Queue[dict[str, Any] | None]] = field(default_factory=set)
    task: asyncio.Task[None] | None = None

    @property
    def settled(self) -> bool:
        return str(self.state.get("status", "")) != SEARCH_STATUS_RUNNING

    def record(self, event: dict[str, Any]) -> None:
        self.events.append(event)
        overflow = len(self.events) - SEARCH_REPLAY_EVENT_LIMIT
        if overflow > 0:
            del self.events[:overflow]

    def broadcast(self, event: dict[str, Any] | None) -> None:
        # 订阅队列不设上限: 单场检索的事件总量已被 SEARCH_REPLAY_EVENT_LIMIT 约束,
        # 有界队列只会在慢消费者上换来丢事件或挂起。
        for subscriber in tuple(self.subscribers):
            subscriber.put_nowait(event)


class LiteratureSearchService:
    def __init__(
        self,
        invocations: InvocationService,
        *,
        root: Path = LITERATURE_SEARCH_DIR,
    ) -> None:
        self._invocations = invocations
        self._root = root.expanduser().resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._live: dict[str, LiveSearch] = {}

    async def create(self, query: str, *, owner_id: str, user_id: str) -> dict[str, Any]:
        cleaned = query.strip()
        if not cleaned:
            raise LiteratureSearchError("literature_search_query_required")
        task_id, workspace = self._create_workspace()
        self._atomic_text(workspace / LITERATURE_SEARCH_QUERY_FILENAME, cleaned + "\n")
        command = InvocationCommand(
            prompt=SEARCH_PROMPT_TEMPLATE.format(query=cleaned),
            skill=InvocationSkill(id=SEARCH_SKILL_ID),
            developer_prompt=False,
            execution=DEFAULT_INVOCATION_EXECUTION,
        )
        try:
            prepared = await self._invocations.prepare(
                command,
                owner_id=owner_id,
                user_id=user_id,
                trusted_workspace=TrustedInvocationWorkspace(root=self._root, path=workspace),
            )
        except Exception:
            shutil.rmtree(workspace)
            raise
        # 创建即落盘一次已经确定的信息: 进程被杀后 query / owner / invocation_id 仍可恢复,
        # invocation_id 也是回到 trace 账本继续归因的唯一线索。运行期不再逐事件写盘。
        state = self._initial_state(task_id, cleaned, owner_id)
        state["invocation_id"] = prepared.record.invocation_id
        try:
            await self._publish_state(workspace, state)
        except Exception:
            # 连创建记录都写不下去时不要留下无主目录; 上层按运行时不可用回 503。
            shutil.rmtree(workspace, ignore_errors=True)
            raise
        live = LiveSearch(state=state)
        self._live[task_id] = live
        live.task = asyncio.create_task(
            self._consume(task_id, workspace, prepared), name=f"literature-search-{task_id}"
        )
        return self._public(state)

    def list(self, *, owner_id: str) -> builtins.list[dict[str, Any]]:
        """只读投影: 本进程在跑的任务给内存态, 其余给磁盘快照, 绝不回写。"""
        items: builtins.list[dict[str, Any]] = []
        for workspace in self._workspaces():
            live = self._live.get(workspace.name)
            if live is not None and live.state.get("owner_id") == owner_id:
                items.append(self._public(live.state))
                continue
            state = self._read_state(workspace)
            if state is None or state.get("owner_id") != owner_id:
                continue
            items.append(self._public(self._restored(state)))
        return items

    async def events(
        self, task_id: str, *, owner_id: str, after_seq: int
    ) -> AsyncIterator[dict[str, Any] | None]:
        live = self._live.get(task_id)
        if live is None or live.state.get("owner_id") != owner_id:
            # 已落盘的历史任务没有可订阅的实时流; 校验归属后直接结束, 前端按终态快照渲染。
            self._owned(task_id, owner_id)
            return
        subscriber: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        # 先订阅再重放: 重放期间的 yield 会让消费者运行, 否则中间事件会被漏掉。
        live.subscribers.add(subscriber)
        try:
            next_seq = max(0, after_seq)
            for event in builtins.list(live.events):
                sequence = int(event["seq"])
                if sequence <= next_seq:
                    continue
                next_seq = sequence
                yield event
            if live.settled:
                return
            while True:
                try:
                    event = await asyncio.wait_for(subscriber.get(), timeout=SSE_HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield None
                    continue
                if event is None:
                    return
                sequence = int(event["seq"])
                if sequence <= next_seq:
                    continue
                next_seq = sequence
                yield event
                if live.settled:
                    return
        finally:
            live.subscribers.discard(subscriber)

    def get(self, task_id: str, *, owner_id: str) -> dict[str, Any]:
        _workspace, state = self._owned(task_id, owner_id)
        live = self._live.get(task_id)
        if live is not None and live.state.get("owner_id") == owner_id:
            return self._public(live.state)
        return self._public(self._restored(state))

    async def delete(self, task_id: str, *, owner_id: str) -> None:
        _workspace, state = self._owned(task_id, owner_id)
        live = self._live.get(task_id)
        active = live.task if live is not None else None
        if active is not None and not active.done():
            await self._invocations.interrupt(
                str(state.get("invocation_id", "")), owner_id=owner_id
            )
            try:
                await asyncio.wait_for(asyncio.shield(active), timeout=SEARCH_DELETE_WAIT_SECONDS)
            except TimeoutError:
                active.cancel()
                await asyncio.gather(active, return_exceptions=True)
        if live is not None:
            live.broadcast(None)
        self._live.pop(task_id, None)
        checked, _state = self._owned(task_id, owner_id)
        shutil.rmtree(checked)

    async def _consume(self, task_id: str, workspace: Path, prepared: PreparedInvocation) -> None:
        live = self._live.get(task_id)
        if live is None:
            return
        state = live.state
        try:
            async for event in self._invocations.stream(prepared):
                if event is None:
                    continue
                live.record(event)
                live.broadcast(event)
                state["last_seq"] = int(event["seq"])
                event_type = str(event["type"])
                data = event.get("data", {})
                if (
                    event_type == SEARCH_OUTPUT_EVENT_KIND.value
                    and str(data.get("role") or "") != SEARCH_REASONING_ROLE
                ):
                    state["output"] += str(data.get("text") or data.get("delta") or "")
                if event_type in SEARCH_TERMINAL_EVENTS:
                    state["completed_at"] = int(time.time() * 1000)
                    state["status"] = SEARCH_TERMINAL_STATUSES[event_type]
                    state["error"] = str(data.get("error", ""))
                    if event_type == SEARCH_COMPLETED_EVENT:
                        self._resolve_result(workspace, state)
                        # 只有成功终态需要跨重启可见, 因此也只在这里落盘一次。
                        await self._publish_state(workspace, state)
        except asyncio.CancelledError:
            state["status"] = SEARCH_STATUS_INTERRUPTED
            state["completed_at"] = int(time.time() * 1000)
            raise
        except Exception as error:
            # 兜底不再静默: 出错位置、异常类型与 Windows 共享冲突码必须可追。
            logger.error(
                "literature_search_runtime_lost task=%s invocation_id=%s last_seq=%s "
                "failure_type=%s errno=%s winerror=%s",
                task_id,
                state.get("invocation_id", ""),
                state.get("last_seq", 0),
                type(error).__name__,
                getattr(error, "errno", None),
                getattr(error, "winerror", None),
            )
            state["status"] = SEARCH_STATUS_UNKNOWN
            state["error"] = SEARCH_RUNTIME_LOST
            state["completed_at"] = int(time.time() * 1000)
        finally:
            live.broadcast(None)

    def _resolve_result(self, workspace: Path, state: dict[str, Any]) -> None:
        candidates: list[Path] = []
        for candidate in workspace.rglob(SEARCH_RESULT_FILENAME):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            resolved = candidate.resolve()
            try:
                resolved.relative_to(workspace)
            except ValueError:
                continue
            candidates.append(resolved)
        if not candidates:
            state["result_status"] = "empty"
            return
        if len(candidates) != 1:
            state["result_status"] = "ambiguous"
            state["error"] = "literature_search_result_ambiguous"
            return
        candidate = candidates[0]
        try:
            if candidate.stat().st_size > SEARCH_RESULT_MAX_BYTES:
                raise ValueError("too_large")
            payload = json.loads(candidate.read_text(encoding="utf-8"))
            if (
                not isinstance(payload, dict)
                or not isinstance(payload.get("search_summary"), dict)
                or not isinstance(payload.get("papers"), list)
            ):
                raise ValueError("invalid")
            papers = payload["papers"]
            if len(papers) > SEARCH_RESULT_MAX_PAPERS or any(
                not self._valid_paper(paper) for paper in papers
            ):
                raise ValueError("invalid")
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            state["result_status"] = "invalid"
            state["error"] = "literature_search_result_invalid"
            return
        state["result_status"] = "ready"
        state["result"] = payload

    @staticmethod
    def _valid_paper(paper: object) -> bool:
        if not isinstance(paper, dict) or not isinstance(paper.get("title"), str):
            return False
        authors = paper.get("authors", [])
        numeric = ("year", "citation_count", "tier")
        text = ("paper_id", "venue", "abstract", "doi", "arxiv_id", "reason", "access", "source")
        subtopics = paper.get("subtopics_covered", [])
        return (
            bool(paper["title"].strip())
            and isinstance(authors, list)
            and all(isinstance(author, str) for author in authors)
            and all(paper.get(key) is None or type(paper.get(key)) is int for key in numeric)
            and all(
                paper.get(key, "") is None or isinstance(paper.get(key, ""), str) for key in text
            )
            and isinstance(subtopics, list)
            and all(isinstance(subtopic, str) for subtopic in subtopics)
        )

    def _create_workspace(self) -> tuple[str, Path]:
        timestamp = int(time.time() * 1000)
        while True:
            task_id = f"{LITERATURE_SEARCH_TASK_PREFIX}{timestamp}"
            workspace = self._root / task_id
            try:
                workspace.mkdir()
                return task_id, workspace.resolve()
            except FileExistsError:
                timestamp += 1

    def _workspaces(self) -> builtins.list[Path]:
        rows = [
            child
            for child in self._root.iterdir()
            if child.is_dir()
            and not child.is_symlink()
            and SEARCH_TASK_PATTERN.fullmatch(child.name)
        ]

        def task_sequence(row: Path) -> int:
            match = SEARCH_TASK_PATTERN.fullmatch(row.name)
            if match is None:
                raise LiteratureSearchError("literature_search_workspace_invalid")
            return int(match.group(1))

        return sorted(rows, key=task_sequence)

    def _owned(self, task_id: str, owner_id: str) -> tuple[Path, dict[str, Any]]:
        if SEARCH_TASK_PATTERN.fullmatch(task_id) is None:
            raise LiteratureSearchError("literature_search_not_found")
        workspace = (self._root / task_id).resolve()
        if workspace.parent != self._root or workspace.is_symlink():
            raise LiteratureSearchError("literature_search_not_found")
        state = self._read_state(workspace)
        if state is None or state.get("task_id") != task_id or state.get("owner_id") != owner_id:
            raise LiteratureSearchError("literature_search_not_found")
        return workspace, state

    @staticmethod
    def _initial_state(task_id: str, query: str, owner_id: str) -> dict[str, Any]:
        match = SEARCH_TASK_PATTERN.fullmatch(task_id)
        created_at = int(match.group(1)) if match else 0
        return {
            "schema_version": SEARCH_SCHEMA_VERSION,
            "task_id": task_id,
            "query": query,
            "owner_id": owner_id,
            "created_at": created_at,
            "completed_at": None,
            "invocation_id": "",
            "status": SEARCH_STATUS_RUNNING,
            "last_seq": 0,
            "output": "",
            "error": "",
            "result_status": "pending",
            "result": None,
        }

    @staticmethod
    def _public(state: dict[str, Any]) -> dict[str, Any]:
        public = {key: value for key, value in state.items() if key not in {"owner_id", "task_id"}}
        public["id"] = state["task_id"]
        return public

    @staticmethod
    def _restored(state: dict[str, Any]) -> dict[str, Any]:
        """Project a persisted task this process no longer owns in memory.

        只有成功终态会被写盘, 所以磁盘上任何非 completed 的记录都意味着这场检索没能跑完
        (进程被杀、崩溃、或创建后从未写成功)。保留 query / created_at 等已确定的信息,
        状态统一投影为 search_interrupted, 内部错误码不外泄。
        """
        if str(state.get("status", "")) == SEARCH_STATUS_COMPLETED:
            return state
        restored = dict(state)
        restored["status"] = SEARCH_STATUS_UNRECOVERED
        restored["error"] = ""
        restored["output"] = ""
        restored["result"] = None
        return restored

    def _read_state(self, workspace: Path) -> dict[str, Any] | None:
        try:
            payload = json.loads((workspace / LITERATURE_SEARCH_STATE_FILENAME).read_text("utf-8"))
            return (
                payload
                if isinstance(payload, dict) and payload.get("schema_version") == 1
                else None
            )
        except (OSError, ValueError, TypeError):
            return None

    def _write_state(self, workspace: Path, state: dict[str, Any]) -> None:
        self._atomic_text(
            workspace / LITERATURE_SEARCH_STATE_FILENAME,
            json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        )

    async def _publish_state(self, workspace: Path, state: dict[str, Any]) -> None:
        """Write the snapshot, retrying transient sharing errors instead of losing the search.

        Windows 上 ``os.replace`` 需要目标的 DELETE 访问权, 实时扫描 / 索引器 / 同步客户端
        短暂持有句柄就会让单次写入失败。这类错误可重试, 不该升级成终态。
        """
        for attempt in range(1, SEARCH_STATE_WRITE_ATTEMPTS + 1):
            try:
                self._write_state(workspace, state)
                return
            except OSError as error:
                if attempt >= SEARCH_STATE_WRITE_ATTEMPTS:
                    logger.error(
                        "literature_search_state_write_failed task=%s attempt=%s "
                        "failure_type=%s errno=%s winerror=%s",
                        workspace.name,
                        attempt,
                        type(error).__name__,
                        getattr(error, "errno", None),
                        getattr(error, "winerror", None),
                    )
                    raise
                await asyncio.sleep(SEARCH_STATE_WRITE_BACKOFF_SECONDS * attempt)

    @staticmethod
    def _atomic_text(target: Path, text: str) -> None:
        temporary = ""
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", dir=target.parent, delete=False
            ) as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
                temporary = handle.name
            os.replace(temporary, target)
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)


__all__ = ["LiteratureSearchError", "LiteratureSearchService"]
