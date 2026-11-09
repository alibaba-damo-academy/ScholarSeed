"""文件变化监听与事件广播 (content 域, 开发 1 拥有)。

PRD「本地文件同步」的反向一半: 用户在访达里改了文件, 回到产品要能看到最新的。
proposal 47 §7 阶段三把这条链定成四段: 监听 → 去抖归并 → 自写抑制 → 持久游标。

四个设计点都是踩过的坑, 不是可选项:

1. **持久游标**: `seq` 落 `event_cursor` 表。进程内自增会在桌面端每次重启 serve
   时归零, 客户端拿旧 `from_seq` 续传会**静默错位** —— 比丢事件更糟。
2. **epoch**: 每次进程启动换一个世代。客户端带旧 epoch 来续时, 第一条一定是
   RESCAN, 而不是从一个不可比的 seq 往后读。
3. **自写抑制**: 产品自己的原子写 (tmp + replace) 会产生临时文件的 CREATED 与
   MOVED。不抑制就会「写 → 事件 → 前端刷新 → 可能再写」自己转起来。
4. **归并上限**: 一次编辑器保存、一次批量导入都可能触发几十条底层事件。超过
   上限就退化成一条 RESCAN, 而不是把风暴原样转发给前端。

监听后端是 `watchfiles` (Rust notify + 原生 async)。它装不上时降级为定时轮询 +
RESCAN: 刷新变慢, 但产品不会因为一个可选依赖而失去这条能力。
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import AsyncIterator, Callable, Iterable

from service.content.domain.model import OWNED_ROOT_KINDS, ContentError, resolve_root, visible
from service.content.persistence.catalog import ContentCatalog
from service.content.service.enumeration import GITIGNORE_FILENAME
from service.content.service.space import ProjectSpace, normalize
from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceActive
from service.platform.content import (
    EventSource,
    FileEvent,
    FileEventKind,
    ProjectRef,
    RootKind,
)
from service.platform.notifications import Change as ProductChange
from service.platform.notifications import ChangeHub, ChangeTopic

#: 监听后端是否可用。缺 watchfiles 时降级为定时轮询 + RESCAN, 不让产品少一条能力。
_watchfiles: ModuleType | None
try:
    import watchfiles as _watchfiles

    WATCHFILES_AVAILABLE = True
except ImportError:  # pragma: no cover - 依赖缺失时的降级路径
    _watchfiles = None
    WATCHFILES_AVAILABLE = False

Change = _watchfiles.Change if _watchfiles is not None else None
awatch = _watchfiles.awatch if _watchfiles is not None else None

#: 去抖窗口 (秒)。一次保存的多次底层写在这个窗口内归并成一条。
DEBOUNCE_SECONDS = 0.35

#: 单个去抖批次的事件上限, 超过即退化为一条 RESCAN。
MAX_BATCH_EVENTS = 40

#: 自写抑制窗口 (秒)。产品写完到 watcher 报上来之间的时间差。
SUPPRESSION_SECONDS = 2.0

#: 轮询降级模式的扫描间隔 (秒)。
POLL_INTERVAL_SECONDS = 2.0

#: 原生监听定期重查授权与延迟创建的目录, 不依赖已有目录产生文件事件。
ROOT_REFRESH_MILLISECONDS = 500

#: 订阅队列上限。慢客户端不该把服务端内存拖走: 满了就丢队列并要求 RESCAN。
SUBSCRIBER_QUEUE_SIZE = 256

#: SSE 心跳间隔 (秒)。长时间无变更时让连接保持活着。
HEARTBEAT_SECONDS = 15.0

#: 每个项目保留的可重放事件条数。断线重连要能补上断连期间的变更, 但缓冲不能
#: 无界 —— 超出缓冲的续传请求一律回 RESCAN, 而不是假装补齐。
BACKLOG_LIMIT = 512


@dataclass(frozen=True)
class _Fingerprint:
    """A bounded filesystem fact used only to classify delayed watcher echoes."""

    device: int
    inode: int
    size: int
    modified_ns: int


@dataclass(frozen=True)
class _Suppression:
    """一条自写登记。"""

    path: str
    expires_at: float
    fingerprint: _Fingerprint | None


class FileEventHub:
    """一个项目的事件源。订阅、广播、游标都在这里。

    按项目分实例而不是全局一个: 监听的根随项目的关联授权变化, 混在一起时
    「哪个项目该监听哪些根」会在两处各答一次。
    """

    def __init__(
        self,
        catalog: ContentCatalog,
        space_of: Callable[[str], ProjectSpace],
        *,
        activities: Activities,
        epoch: str = "",
    ) -> None:
        self._catalog = catalog
        self.changes: ChangeHub | None = None
        self._activities = activities
        self._space_of = space_of
        # 世代随进程: 重启即换, 于是旧游标一定拿到 RESCAN 而不是错位续传。
        self._epoch = epoch or f"{int(time.time())}-{secrets.token_hex(4)}"
        self._subscribers: dict[str, list[asyncio.Queue[FileEvent]]] = {}
        self._backlog: dict[str, list[FileEvent]] = {}
        self._watchers: dict[str, asyncio.Task[None]] = {}
        self._suppressed: dict[str, list[_Suppression]] = {}
        self._stopping = asyncio.Event()

    @property
    def epoch(self) -> str:
        return self._epoch

    # ---- 游标 ----

    def cursor(self, project_id: str) -> tuple[str, int]:
        """(epoch, last_seq)。库里的 epoch 与本进程不同时回本进程的世代与 0。"""

        stored = self._catalog.cursor(project_id)
        if stored is None or stored[0] != self._epoch:
            return (self._epoch, 0)
        return stored

    # ---- 自写抑制 ----

    def _fingerprint(self, project_id: str, path: str) -> _Fingerprint | None:
        try:
            observed = self._space_of(project_id).absolute(path).stat()
        except (ContentError, OSError):
            return None
        return _Fingerprint(
            device=observed.st_dev,
            inode=observed.st_ino,
            size=observed.st_size,
            modified_ns=observed.st_mtime_ns,
        )

    def suppress(self, project_id: str, path: str) -> None:
        """登记一次产品自身的写入。

        路径与写完时的文件系统指纹必须同时一致才能抑制。否则同一
        debounce batch 内紧随产品写入的外部覆盖会被静默当成自写回声。
        临时文件通常在登记时已经不存在，因此用 None 精确表示这个终态。
        """

        deadline = time.time() + SUPPRESSION_SECONDS
        entries = [
            item for item in self._suppressed.get(project_id, []) if item.expires_at > time.time()
        ]
        cleaned = normalize(path)
        entries.append(
            _Suppression(
                path=cleaned,
                expires_at=deadline,
                fingerprint=self._fingerprint(project_id, cleaned),
            )
        )
        # 原子写的临时文件也一并抑制: 它是产品实现细节, 不该出现在用户界面上。
        temporary = f"{cleaned}.tmp"
        entries.append(
            _Suppression(
                path=temporary,
                expires_at=deadline,
                fingerprint=self._fingerprint(project_id, temporary),
            )
        )
        self._suppressed[project_id] = entries

    def _is_suppressed(self, project_id: str, path: str) -> bool:
        now = time.time()
        entries = [item for item in self._suppressed.get(project_id, []) if item.expires_at > now]
        self._suppressed[project_id] = entries
        cleaned = normalize(path)
        current = self._fingerprint(project_id, cleaned)
        return any(item.path == cleaned and item.fingerprint == current for item in entries)

    # ---- 订阅 ----

    async def subscribe(
        self,
        project_id: str,
        epoch: str,
        from_seq: int,
    ) -> AsyncIterator[FileEvent]:
        """订阅事件流。epoch 不匹配或落后太多时先发一条 RESCAN。"""

        project = self._space_of(project_id).project
        queue: asyncio.Queue[FileEvent] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE_SIZE)
        self._subscribers.setdefault(project.id, []).append(queue)
        try:
            await self.ensure_watching(project.id)
            current_epoch, last_seq = self.cursor(project.id)
            for event in self._resume(project, epoch, from_seq, current_epoch, last_seq):
                yield event
            while not self._stopping.is_set():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    continue
                yield event
        finally:
            listeners = self._subscribers.get(project.id, [])
            if queue in listeners:
                listeners.remove(queue)

    def _resume(
        self,
        project: ProjectRef,
        epoch: str,
        from_seq: int,
        current_epoch: str,
        last_seq: int,
    ) -> list[FileEvent]:
        """续传的开场: 要么补齐断连期间的事件, 要么明确要求 RESCAN。

        三种情况必须分开处理, 混成一种就会静默丢事件:
        - 世代不同 / seq 超前 (服务端重置过): 手上的 seq 不可比 → RESCAN;
        - 落后且缓冲里补得齐: 重放缺的那几条, 客户端不必整棵树重取;
        - 落后但缺口已经出了缓冲: 补不齐就说补不齐 → RESCAN。
        """

        if epoch != current_epoch or from_seq > last_seq:
            return [self._rescan(project)]
        if from_seq == last_seq:
            return []
        backlog = [item for item in self._backlog.get(project.id, ()) if item.seq > from_seq]
        expected = last_seq - from_seq
        if len(backlog) < expected:
            return [self._rescan(project)]
        return backlog

    def _rescan(self, project: ProjectRef, root: RootKind = RootKind.RESOURCES) -> FileEvent:
        epoch, seq = self.cursor(project.id)
        return FileEvent(
            epoch=epoch,
            seq=seq,
            project_id=project.id,
            root=root,
            kind=FileEventKind.RESCAN,
            path="",
            source=EventSource.EXTERNAL,
        )

    # ---- 监听 ----

    async def ensure_watching(self, project_id: str) -> None:
        """确保该项目的监听任务在跑 (幂等)。"""

        existing = self._watchers.get(project_id)
        if existing is not None and not existing.done():
            return
        self._watchers[project_id] = asyncio.create_task(self._watch(project_id))

    def forget(self, project_id: str) -> None:
        """Retire a project's native watcher before its identity becomes unusable."""

        watcher = self._watchers.get(project_id)
        if watcher is not None:
            watcher.cancel()
        self._subscribers.pop(project_id, None)
        self._backlog.pop(project_id, None)
        self._suppressed.pop(project_id, None)

    async def aclose(self) -> None:
        self._stopping.set()
        for task in list(self._watchers.values()):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._watchers.clear()
        self._subscribers.clear()

    def watched_roots(self, project_id: str) -> tuple[Path, ...]:
        """被监听的根: 项目内两个库根 + 当前有效的关联根。

        未授权的外部来源**不监听** —— 监听等于持续读取它, 而授权才是
        用户给出的边界。
        """

        space = self._space_of(project_id)
        roots = [
            resolve_root(space.project, kind).absolute
            for kind in RootKind
            if kind not in OWNED_ROOT_KINDS or kind in space.owned_roots
        ]
        roots.extend(mount.source for mount in space.mounts)
        unique: list[Path] = []
        for root in roots:
            if (root.is_dir() or root.is_file()) and root not in unique:
                unique.append(root)
        return tuple(unique)

    async def _watch(self, project_id: str) -> None:
        if WATCHFILES_AVAILABLE:
            await self._watch_native(project_id)
            return
        await self._poll(project_id)

    @contextlib.asynccontextmanager
    async def _batch(self):
        resumed = False
        while True:
            try:
                lease = self._activities.enter(ActivityDomain.RESOURCE, root=True)
                break
            except MaintenanceActive:
                resumed = True
                await self._activities.wait_open()
        with lease:
            yield resumed

    async def _watch_native(self, project_id: str) -> None:
        assert awatch is not None
        rescan_after_attach = False
        while not self._stopping.is_set():
            retry = False
            async with self._batch() as resumed:
                roots = self.watched_roots(project_id)
                rescan_after_attach |= resumed
                if roots:
                    watcher = awatch(
                        *roots,
                        debounce=int(DEBOUNCE_SECONDS * 1000),
                        stop_event=self._stopping,
                        rust_timeout=ROOT_REFRESH_MILLISECONDS,
                        yield_on_timeout=True,
                    )

                    async def next_changes():
                        return await anext(watcher)

                    try:
                        # One lease spans the native generator's entire lifetime.
                        # Drain closes it after the current bounded wait, before
                        # parking for admission; handles cannot outlive the lease.
                        while not self._stopping.is_set():
                            try:
                                changes = await self._activities.finish(
                                    ActivityDomain.RESOURCE, next_changes
                                )
                            except StopAsyncIteration:
                                break
                            if rescan_after_attach:
                                await self._rescan_roots(project_id)
                                rescan_after_attach = False
                            await self._publish_batch(project_id, changes)
                            if roots != self.watched_roots(project_id):
                                rescan_after_attach = True
                                break
                            if self._activities.snapshot().phase is not ActivityPhase.OPEN:
                                rescan_after_attach = True
                                break
                    except OSError:
                        await self._rescan_roots(project_id)
                        rescan_after_attach = True
                        retry = True
                    finally:
                        closing = self._activities.enter(ActivityDomain.RESOURCE)

                        async def close_watcher():
                            await watcher.aclose()
                            # A failed close retains its receipt and blocks seal.
                            closing.close()

                        await self._activities.finish(ActivityDomain.RESOURCE, close_watcher)
            if not roots or retry:
                await asyncio.sleep(POLL_INTERVAL_SECONDS)

    async def _rescan_roots(self, project_id: str) -> None:
        project = self._space_of(project_id).project
        for kind in RootKind:
            await self._emit(project_id, self._rescan(project, kind))

    async def _poll(self, project_id: str) -> None:
        """Keep the real snapshot thread and event commit in one admitted batch."""
        async with self._batch():
            previous = await self._activities.to_thread(
                ActivityDomain.RESOURCE, self._snapshot, project_id
            )
        while not self._stopping.is_set():
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            async with self._batch() as resumed:
                current = await self._activities.to_thread(
                    ActivityDomain.RESOURCE, self._snapshot, project_id
                )
                if current != previous or resumed:
                    previous = current
                    await self._emit(project_id, self._rescan(self._space_of(project_id).project))

    def _snapshot(self, project_id: str) -> dict[str, tuple[int, int]]:
        snapshot: dict[str, tuple[int, int]] = {}
        for root in self.watched_roots(project_id):
            if root.is_file():
                try:
                    stat = root.stat()
                except OSError:
                    continue
                snapshot[str(root)] = (stat.st_mtime_ns, stat.st_size)
                continue
            for current, directories, filenames in os.walk(root):
                directories[:] = [name for name in directories if visible(name)]
                for name in filenames:
                    if name != GITIGNORE_FILENAME and not visible(name):
                        continue
                    target = Path(current) / name
                    try:
                        stat = target.stat()
                    except OSError:
                        continue
                    snapshot[str(target)] = (stat.st_mtime_ns, stat.st_size)
        return snapshot

    async def _publish_batch(self, project_id: str, changes: Iterable[tuple]) -> None:
        """把一批底层变更归并成产品事件。"""

        space = self._space_of(project_id)
        merged: dict[str, FileEventKind] = {}
        for change, raw in changes:
            try:
                relative = space.relative(Path(raw))
            except ContentError:
                # 已撤销授权的根、或已被移出项目的路径: 丢弃而不是猜一个位置。
                continue
            parts = relative.split("/")
            if (
                not relative
                or any(not visible(part) for part in parts[:-1])
                or (parts[-1] != GITIGNORE_FILENAME and not visible(parts[-1]))
            ):
                continue
            merged[relative] = _KIND_BY_CHANGE.get(change, FileEventKind.MODIFIED)
        if not merged:
            return
        if len(merged) > MAX_BATCH_EVENTS:
            # 事件风暴: 给一条 RESCAN 而不是几百条增量。
            await self._emit(project_id, self._rescan(space.project))
            return
        for relative, kind in merged.items():
            if self._is_suppressed(project_id, relative):
                continue
            seq = self._catalog.bump_cursor(space.project.id, self._epoch)
            await self._emit(
                project_id,
                FileEvent(
                    epoch=self._epoch,
                    seq=seq,
                    project_id=space.project.id,
                    root=_root_of(space, relative),
                    kind=kind,
                    path=relative,
                    source=EventSource.EXTERNAL,
                ),
            )

    async def _emit(self, project_id: str, event: FileEvent) -> None:
        if self.changes is not None:
            self.changes.publish((ProductChange(ChangeTopic.RESOURCES, subject=project_id),))
        if event.kind is not FileEventKind.RESCAN:
            backlog = self._backlog.setdefault(project_id, [])
            backlog.append(event)
            if len(backlog) > BACKLOG_LIMIT:
                del backlog[: len(backlog) - BACKLOG_LIMIT]
        for queue in list(self._subscribers.get(project_id, [])):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # 慢客户端: 清空它的队列并塞一条 RESCAN, 而不是无界堆积。
                with contextlib.suppress(asyncio.QueueEmpty):
                    while True:
                        queue.get_nowait()
                queue.put_nowait(self._rescan(self._space_of(project_id).project))


def _root_of(space: ProjectSpace, relative: str) -> RootKind:
    """相对路径归属哪个根。挂载点挂在资料库根下, 因此关联资产算资料库。"""

    candidates = {
        kind: resolve_root(space.project, kind).relative
        for kind in RootKind
        if kind not in OWNED_ROOT_KINDS or kind in space.owned_roots
    }
    for kind, path in sorted(candidates.items(), key=lambda entry: len(entry[1]), reverse=True):
        if path and (relative == path or relative.startswith(f"{path}/")):
            return kind
    return RootKind.RESOURCES


def _kind_map() -> dict[object, FileEventKind]:
    """watchfiles 的 Change → 产品事件类型。缺依赖时为空表 (走轮询降级)。"""

    if not WATCHFILES_AVAILABLE or Change is None:
        return {}
    return {
        Change.added: FileEventKind.CREATED,
        Change.modified: FileEventKind.MODIFIED,
        Change.deleted: FileEventKind.DELETED,
    }


_KIND_BY_CHANGE: dict[object, FileEventKind] = _kind_map()


__all__ = [
    "BACKLOG_LIMIT",
    "DEBOUNCE_SECONDS",
    "MAX_BATCH_EVENTS",
    "SUPPRESSION_SECONDS",
    "WATCHFILES_AVAILABLE",
    "FileEventHub",
]
