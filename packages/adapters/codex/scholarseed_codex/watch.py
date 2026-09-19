"""Native workspace subscriptions and filesystem-notification routing."""

import asyncio
import logging
import uuid
from typing import Any, Callable, Mapping, Protocol

from scholarseed_codex.files import (
    FILE_CHANGE_ADD,
    FILE_CHANGE_UPDATE,
    FileStamp,
    is_artifact_candidate,
    workspace_relative_path,
    workspace_snapshot,
)
from scholarseed_codex.protocol.session import CodexSessionOpenRequest
from scholarseed_codex.protocol.state import (
    CODEX_FS_UNWATCH_METHOD,
    CODEX_FS_WATCH_METHOD,
)


class WatchTarget(Protocol):
    @property
    def thread_id(self) -> str: ...

    @property
    def request(self) -> CodexSessionOpenRequest: ...

    @property
    def attached_generation(self) -> int: ...

    fs_watch_id: str
    turn_done: asyncio.Future[dict[str, Any]] | None
    watched_paths: dict[str, str]


logger = logging.getLogger(__name__)


class WatchRequest(Protocol):
    async def __call__(self, method: str, params: Any, *, generation: int) -> dict[str, Any]: ...


class WorkspaceWatch:
    def __init__(self, request: WatchRequest, report: Callable[[str], None]) -> None:
        self._request = request
        self._report = report
        self._routes: dict[str, WatchTarget] = {}
        self._baselines: dict[str, dict[str, FileStamp]] = {}
        self._scans: dict[str, object] = {}

    def _scan_error(self, error: OSError) -> None:
        self._report(f"fs_snapshot_incomplete:{type(error).__name__}")
        logger.warning(
            "codex_workspace_snapshot_incomplete", extra={"error_type": type(error).__name__}
        )

    async def begin_turn(self, state: WatchTarget) -> None:
        token = object()
        self._scans[state.thread_id] = token
        snapshot = await asyncio.to_thread(workspace_snapshot, state.request.cwd, self._scan_error)
        if self._scans.get(state.thread_id) is token:
            self._baselines[state.thread_id] = snapshot

    async def finish_turn(self, state: WatchTarget) -> None:
        token = self._scans.get(state.thread_id)
        previous = self._baselines.pop(state.thread_id, None)
        if previous is None:
            return
        current = await asyncio.to_thread(workspace_snapshot, state.request.cwd, self._scan_error)
        if self._scans.get(state.thread_id) is not token:
            return
        self._scans.pop(state.thread_id, None)
        for path, stamp in current.items():
            if previous.get(path) != stamp:
                change = FILE_CHANGE_UPDATE if path in previous else FILE_CHANGE_ADD
                if path not in state.watched_paths or change == FILE_CHANGE_ADD:
                    state.watched_paths[path] = change

    def abandon_turn(self, thread_id: str) -> None:
        self._scans.pop(thread_id, None)
        self._baselines.pop(thread_id, None)

    def reset(self) -> None:
        self._routes.clear()
        self._scans.clear()
        self._baselines.clear()

    async def open(self, state: WatchTarget, generation: int) -> None:
        """Subscribe to Codex-owned filesystem notifications for this workspace."""

        previous_watch_id = state.fs_watch_id
        if previous_watch_id:
            self._routes.pop(previous_watch_id, None)
        watch_id = uuid.uuid4().hex
        try:
            await self._request(
                CODEX_FS_WATCH_METHOD,
                {
                    "watchId": watch_id,
                    "path": str(state.request.cwd.expanduser().resolve()),
                },
                generation=generation,
            )
        except Exception as exc:
            state.fs_watch_id = ""
            self._report(f"fs_watch_failed:{type(exc).__name__}")
            logger.warning("failed to watch Codex workspace", exc_info=True)
            return
        state.fs_watch_id = watch_id
        self._routes[watch_id] = state
        logger.info(
            "codex_workspace_watch_registered",
            extra={"watch_id": watch_id, "thread_id": state.thread_id, "generation": generation},
        )

    async def close(self, state: WatchTarget, generation: int, ready: bool) -> None:
        self.abandon_turn(state.thread_id)
        watch_id = state.fs_watch_id
        state.fs_watch_id = ""
        if not watch_id:
            return
        self._routes.pop(watch_id, None)
        if state.attached_generation != generation or not ready:
            return
        try:
            await self._request(
                CODEX_FS_UNWATCH_METHOD,
                {"watchId": watch_id},
                generation=generation,
            )
        except Exception:
            logger.exception("failed to unwatch Codex workspace during close")

    def changed(self, params: Mapping[str, Any]) -> None:
        watch_id = str(params.get("watchId") or "")
        state = self._routes.get(watch_id)
        if state is None:
            self._report("unroutable:fs/changed")
            logger.info("codex_workspace_watch_unroutable", extra={"watch_id": watch_id})
            return
        turn_active = state.turn_done is not None and not state.turn_done.done()
        paths = list(params.get("changedPaths") or [])
        logger.info(
            "codex_workspace_watch_changed",
            extra={
                "watch_id": watch_id,
                "thread_id": state.thread_id,
                "turn_active": turn_active,
                "changed_path_count": len(paths),
            },
        )
        if not turn_active:
            return
        accepted = 0
        for changed_path in paths:
            relative = workspace_relative_path(state.request.cwd, changed_path)
            if not relative:
                continue
            if not is_artifact_candidate(relative):
                continue
            baseline = self._baselines.get(state.thread_id)
            change = (
                FILE_CHANGE_ADD
                if baseline is not None and relative not in baseline
                else FILE_CHANGE_UPDATE
            )
            state.watched_paths.setdefault(relative, change)
            accepted += 1
        logger.info(
            "codex_workspace_watch_collected",
            extra={"watch_id": watch_id, "accepted_path_count": accepted},
        )
