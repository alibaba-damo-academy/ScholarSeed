"""Persistent literature-owned agentic search tasks."""

from __future__ import annotations

import asyncio
import builtins
import json
import os
import re
import shutil
import tempfile
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from scholarseed_runtime.contract import RuntimeEventKind
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
    LITERATURE_SEARCH_EVENTS_FILENAME,
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
SEARCH_EVENT_POLL_SECONDS = 0.1
SEARCH_DELETE_WAIT_SECONDS = 10
SEARCH_TASK_PATTERN = re.compile(r"^task-(\d+)$")
SEARCH_TERMINAL_EVENTS = frozenset(
    {"result.completed", "invocation.failed", "invocation.interrupted", "invocation.unknown"}
)
# content.delta 同时承载推理与用户可见两条通道, 适配器用 data.role 区分
# (packages/adapters/codex/scholarseed_codex/events.py)。推理文本里会出现字面 <<< >>>,
# 混进 output 会污染前端按定界符裁出的用户可见进度, 所以只累加非推理通道。
SEARCH_OUTPUT_EVENT_KIND = RuntimeEventKind.CONTENT_DELTA
SEARCH_REASONING_ROLE = "reasoning"


class LiteratureSearchError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


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
        self._tasks: dict[str, asyncio.Task[None]] = {}

    async def create(self, query: str, *, owner_id: str, user_id: str) -> dict[str, Any]:
        cleaned = query.strip()
        if not cleaned:
            raise LiteratureSearchError("literature_search_query_required")
        task_id, workspace = self._create_workspace()
        self._atomic_text(workspace / LITERATURE_SEARCH_QUERY_FILENAME, cleaned + "\n")
        state = self._initial_state(task_id, cleaned, owner_id)
        self._write_state(workspace, state)
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
        state["invocation_id"] = prepared.record.invocation_id
        self._write_state(workspace, state)
        self._tasks[task_id] = asyncio.create_task(
            self._consume(task_id, workspace, prepared), name=f"literature-search-{task_id}"
        )
        return self._public(state)

    def list(self, *, owner_id: str) -> builtins.list[dict[str, Any]]:
        items: builtins.list[dict[str, Any]] = []
        for workspace in self._workspaces():
            state = self._read_state(workspace)
            if state is None or state.get("owner_id") != owner_id:
                continue
            if state.get("status") == "running" and state["task_id"] not in self._tasks:
                state["status"] = "unknown"
                state["error"] = "literature_search_runtime_lost"
                state["completed_at"] = int(time.time() * 1000)
                self._write_state(workspace, state)
            items.append(self._public(state))
        return items

    async def events(
        self, task_id: str, *, owner_id: str, after_seq: int
    ) -> AsyncIterator[dict[str, Any] | None]:
        workspace, state = self._owned(task_id, owner_id)
        next_seq = max(0, after_seq)
        while True:
            events = self._read_events(workspace, next_seq)
            for event in events:
                next_seq = max(next_seq, int(event["seq"]))
                yield event
            refreshed_state = self._read_state(workspace)
            if refreshed_state is None:
                return
            state = refreshed_state
            if state.get("status") != "running" and next_seq >= int(state.get("last_seq", 0)):
                return
            await asyncio.sleep(SEARCH_EVENT_POLL_SECONDS)

    def get(self, task_id: str, *, owner_id: str) -> dict[str, Any]:
        _workspace, state = self._owned(task_id, owner_id)
        return self._public(state)

    async def delete(self, task_id: str, *, owner_id: str) -> None:
        workspace, state = self._owned(task_id, owner_id)
        active = self._tasks.get(task_id)
        if active is not None and not active.done():
            await self._invocations.interrupt(
                str(state.get("invocation_id", "")), owner_id=owner_id
            )
            try:
                await asyncio.wait_for(asyncio.shield(active), timeout=SEARCH_DELETE_WAIT_SECONDS)
            except TimeoutError:
                active.cancel()
                await asyncio.gather(active, return_exceptions=True)
        checked, _state = self._owned(task_id, owner_id)
        shutil.rmtree(checked)
        self._tasks.pop(task_id, None)

    async def _consume(self, task_id: str, workspace: Path, prepared: PreparedInvocation) -> None:
        state = self._read_state(workspace)
        if state is None:
            return
        try:
            async for event in self._invocations.stream(prepared):
                if event is None:
                    continue
                self._append_event(workspace, event)
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
                    state["status"] = {
                        "result.completed": "completed",
                        "invocation.failed": "failed",
                        "invocation.interrupted": "interrupted",
                        "invocation.unknown": "unknown",
                    }[event_type]
                    state["error"] = str(data.get("error", ""))
                    if event_type == "result.completed":
                        self._resolve_result(workspace, state)
                self._write_state(workspace, state)
        except Exception:
            state["status"] = "unknown"
            state["error"] = "literature_search_runtime_lost"
            state["completed_at"] = int(time.time() * 1000)
            self._write_state(workspace, state)
        finally:
            self._tasks.pop(task_id, None)

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
            "status": "running",
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

    @staticmethod
    def _append_event(workspace: Path, event: dict[str, Any]) -> None:
        with (workspace / LITERATURE_SEARCH_EVENTS_FILENAME).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _read_events(workspace: Path, after_seq: int) -> builtins.list[dict[str, Any]]:
        try:
            lines = (workspace / LITERATURE_SEARCH_EVENTS_FILENAME).read_text("utf-8").splitlines()
        except OSError:
            return []
        events: builtins.list[dict[str, Any]] = []
        for line in lines:
            try:
                event = json.loads(line)
                if isinstance(event, dict) and int(event.get("seq", 0)) > after_seq:
                    events.append(event)
            except (ValueError, TypeError, json.JSONDecodeError):
                continue
        return events


__all__ = ["LiteratureSearchError", "LiteratureSearchService"]
