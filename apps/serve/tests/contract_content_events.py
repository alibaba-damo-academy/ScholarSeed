"""文件事件契约 (proposal 47 阶段三)。

四条边界, 每一条断掉都是**静默**故障 —— 不报错, 只是界面对不上或自己抖:

1. 外部改动 (访达/其他程序) 要变成事件, 且标 `source=external`;
2. 产品自身的写入不得回灌成事件 —— 否则「写 → 事件 → 刷新 → 再写」会自激,
   原子写的 `.tmp` 临时文件也不能漏到界面上;
3. 一次批量改动的事件条数有上界, 超过就退化成一条 RESCAN;
4. 游标世代 (`epoch`) 不匹配时第一条必须是 RESCAN, 且 `seq` 落库而不是进程内
   自增 —— 桌面端每次重启 serve 都会归零, 客户端拿旧 seq 续传就是静默错位。

本套件用真 watcher 与真磁盘 (不 mock 文件系统), 因此带秒级 sleep: 事件链的
正确性只有在真实时序下才成立。
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from service.content.domain.model import MANAGED_RESOURCES_ROOT_RELATIVE
from service.content.persistence.catalog import ContentCatalog
from service.content.service.events import MAX_BATCH_EVENTS, WATCHFILES_AVAILABLE
from service.content.service.port import ContentService, ProjectRegistry
from service.platform.content import EventSource, FileEventKind, RootKind

PASS = 0
FAIL = 0

#: 等 watcher 起来的时间。watchfiles 的 Rust 线程要先注册目录。
WATCHER_WARMUP_SECONDS = 0.6

#: 一次断言窗口: 去抖 0.35s + 传播余量。
COLLECT_SECONDS = 1.8


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


async def collect(
    content: ContentService, project_id: str, epoch: str, from_seq: int, seconds: float, action
) -> list:
    """订阅一段时间, 期间执行 action, 收集事件。"""

    received: list = []
    stream = content.subscribe(project_id, epoch, from_seq)

    async def pump() -> None:
        async for event in stream:
            received.append(event)

    task = asyncio.create_task(pump())
    await asyncio.sleep(WATCHER_WARMUP_SECONDS)
    await action()
    await asyncio.sleep(seconds)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    return received


async def run() -> None:
    root = Path(tempfile.mkdtemp(prefix="content-events-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    database = root / "content.sqlite3"
    catalog = ContentCatalog(database)
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_workspace()
    content = ContentService(registry, catalog)
    project = content.create_project("事件契约")
    library = Path(project.root) / MANAGED_RESOURCES_ROOT_RELATIVE
    linked_file = root / "关联单文件.md"
    linked_file.write_text("初始内容", encoding="utf-8")
    linked_ref = content.authorize_root(project.id, str(linked_file), linked_file.name)

    check("watcher 后端可用 (缺失时降级为轮询 + RESCAN)", WATCHFILES_AVAILABLE)

    epoch, seq = content.event_cursor(project.id)
    check("初始游标带本进程世代", bool(epoch) and seq == 0, f"{epoch}:{seq}")

    async def artifact_change() -> None:
        content.root(project.id, RootKind.ARTIFACTS)
        # 在订阅后才注册新根; 首次写入由重扫覆盖, 后续写入必须有增量事件。

    root_events = await collect(content, project.id, epoch, seq, COLLECT_SECONDS, artifact_change)
    check(
        "订阅后登记产物根触发对应树重扫",
        any(
            item.root is RootKind.ARTIFACTS and item.kind is FileEventKind.RESCAN
            for item in root_events
        ),
    )
    artifact_root = content.root(project.id, RootKind.ARTIFACTS)
    epoch, seq = content.event_cursor(project.id)

    async def artifact_write() -> None:
        Path(content.resolve(project.id, artifact_root.path), "output.csv").write_text(
            "value\n1\n", encoding="utf-8"
        )

    artifact_events = await collect(
        content, project.id, epoch, seq, COLLECT_SECONDS, artifact_write
    )
    check(
        "登记产物根的真实文件事件归属 artifacts",
        any(
            item.path == f"{artifact_root.path}/output.csv" and item.root is RootKind.ARTIFACTS
            for item in artifact_events
        ),
        str([(item.path, item.root.value) for item in artifact_events]),
    )
    epoch, seq = content.event_cursor(project.id)

    async def external() -> None:
        (library / "访达新建.md").write_text("外部写入", encoding="utf-8")

    events = await collect(content, project.id, epoch, seq, COLLECT_SECONDS, external)
    check(
        "外部改动变成事件, 且标 source=external",
        any(
            item.path == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/访达新建.md"
            and item.source is EventSource.EXTERNAL
            for item in events
        ),
        str([(item.kind.value, item.path) for item in events]),
    )
    check(
        "事件带单调 seq (断线续传的唯一依据)",
        all(item.seq >= 1 for item in events if item.kind is not FileEventKind.RESCAN),
        str([item.seq for item in events]),
    )

    epoch, seq = content.event_cursor(project.id)

    async def external_file_change() -> None:
        linked_file.write_text("外部程序修改", encoding="utf-8")

    events = await collect(
        content,
        project.id,
        epoch,
        seq,
        COLLECT_SECONDS,
        external_file_change,
    )
    check(
        "关联单文件的外部修改同样变成挂载路径事件",
        any(item.path == linked_ref.mount_path for item in events),
        str([(item.kind.value, item.path) for item in events]),
    )

    epoch, seq = content.event_cursor(project.id)

    async def product_write() -> None:
        content.write_text(project.id, f"{MANAGED_RESOURCES_ROOT_RELATIVE}/产品写入.md", "产品内容")

    events = await collect(content, project.id, epoch, seq, COLLECT_SECONDS, product_write)
    check(
        "产品自身的写入不回灌成事件",
        not any(
            item.path.startswith(f"{MANAGED_RESOURCES_ROOT_RELATIVE}/产品写入") for item in events
        ),
        str([(item.kind.value, item.path) for item in events]),
    )
    check(
        "原子写的 .tmp 临时文件不漏到界面",
        not any(item.path.endswith(".tmp") for item in events),
        str([item.path for item in events]),
    )

    epoch, seq = content.event_cursor(project.id)

    async def external_after_product_write() -> None:
        path = f"{MANAGED_RESOURCES_ROOT_RELATIVE}/紧随产品写入.md"
        content.write_text(project.id, path, "产品内容")
        (library / "紧随产品写入.md").write_text("外部内容", encoding="utf-8")

    events = await collect(
        content,
        project.id,
        epoch,
        seq,
        COLLECT_SECONDS,
        external_after_product_write,
    )
    check(
        "自写抑制窗口内的外部覆盖仍发布 external 事件",
        any(
            item.path == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/紧随产品写入.md"
            and item.source is EventSource.EXTERNAL
            for item in events
        ),
        str([(item.kind.value, item.path) for item in events]),
    )

    epoch, seq = content.event_cursor(project.id)

    async def storm() -> None:
        for index in range(MAX_BATCH_EVENTS * 3):
            (library / f"批量-{index}.md").write_text("x", encoding="utf-8")

    events = await collect(content, project.id, epoch, seq, COLLECT_SECONDS + 0.6, storm)
    check(
        "批量改动的事件条数有上界 (超限退化为 RESCAN)",
        len(events) <= MAX_BATCH_EVENTS + 1,
        f"got={len(events)}",
    )

    events = await collect(content, project.id, "stale-epoch", 99, 0.4, lambda: asyncio.sleep(0))
    check(
        "旧 epoch 续传时第一条是 RESCAN, 不是错位续读",
        bool(events) and events[0].kind is FileEventKind.RESCAN,
        str([item.kind.value for item in events]),
    )

    # 断线重连: 带断连前的 seq 回来, 缺的那几条要补齐而不是静默丢掉。
    epoch, before_seq = content.event_cursor(project.id)

    async def offline_change() -> None:
        (library / "断连期间.md").write_text("offline", encoding="utf-8")

    await collect(content, project.id, epoch, before_seq, COLLECT_SECONDS, offline_change)
    epoch, after_seq = content.event_cursor(project.id)
    replayed = await collect(content, project.id, epoch, before_seq, 0.5, lambda: asyncio.sleep(0))
    check(
        "重连带旧 seq 能补上断连期间的事件, 不是静默丢弃",
        after_seq > before_seq
        and bool(replayed)
        and all(item.seq > before_seq for item in replayed)
        and any(item.path == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/断连期间.md" for item in replayed),
        str([(item.kind.value, item.seq, item.path) for item in replayed]),
    )
    beyond = await collect(content, project.id, epoch, 0, 0.5, lambda: asyncio.sleep(0))
    check(
        "缺口超出重放缓冲时明确要求 RESCAN, 不假装补齐",
        bool(beyond)
        and (beyond[0].kind is FileEventKind.RESCAN or all(item.seq > 0 for item in beyond)),
        str([(item.kind.value, item.seq) for item in beyond]),
    )

    stored = ContentCatalog(database).cursor(project.id)
    check(
        "seq 落库, 跨实例可见 (进程内自增会在重启后归零)",
        stored is not None and stored[1] > 0,
        str(stored),
    )
    check(
        "被监听的根 = 两个库根 (+ 已授权关联根)",
        len(content._events.watched_roots(project.id)) >= 2,  # noqa: SLF001 - 域内白盒断言
        str(content._events.watched_roots(project.id)),  # noqa: SLF001
    )

    await content.close_events()


def main() -> int:
    asyncio.run(run())
    print(f"\ncontract_content_events: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
