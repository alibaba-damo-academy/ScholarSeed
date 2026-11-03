"""Native Codex interrupt admission barrier and terminal-state contract."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from scholarseed_runtime.contract import CommandReceipt, CommandState
from service.chat.runtime.live import LiveSession
from service.chat.service.turns import TurnService
from service.platform.activity import Activities

PASS = 0
FAIL = 0

#: 等一次 vendor 交互的上限。这些场景全在内存里跑, 秒级已是数量级余量 —— 关键是
#: **不能不设**: 被测代码回归成「永不返回」时, 无超时的 await 会把套件挂死,
#: 于是整条门禁跟着无限期静默挂住, 而不是给出一条可读的失败。
VENDOR_ACK_TIMEOUT_SECONDS = 1.0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


class _Catalog:
    def __init__(self) -> None:
        self.expired: list[str] = []

    def expire_pending_hil(self, session_id: str) -> tuple[()]:
        self.expired.append(session_id)
        return ()

    def get(self, _session_id: str) -> SimpleNamespace:
        return SimpleNamespace(last_turn_id="turn-1")


class _Adapter:
    def __init__(self, entered: asyncio.Event, release: asyncio.Event) -> None:
        self.entered = entered
        self.release = release
        self.calls = 0

    async def interrupt(self, request) -> CommandReceipt:
        self.calls += 1
        self.entered.set()
        await self.release.wait()
        return CommandReceipt(request.command_id, CommandState.ACCEPTED, "turn-1")


def live_session(adapter: object, catalog: _Catalog) -> LiveSession:
    live = object.__new__(LiveSession)
    live._browser_scope = None
    live._browser_scope_lock = asyncio.Lock()
    live._browser_delivery_lock = asyncio.Lock()
    live._browser_scope_end_pending = False
    live.id = "interrupt-contract"
    live.vendor_thread_id = "interrupt-contract-thread"
    live.runtime_session = adapter
    live._catalog = catalog  # type: ignore[assignment]
    live.interrupting = False
    live.termination_task = None
    live.terminating = False
    live.terminated = False
    live.interrupt_generation = 0
    live.last_interrupt_succeeded = None
    live.current_task = None
    live._citation_review_task = None
    live.resource_task = None
    live._citation_review_task = None
    live.waiting_request_id = ""
    live.waiting_resources = False
    live.turn_lock = asyncio.Lock()
    live.lifecycle_lock = asyncio.Lock()
    live.ledger = SimpleNamespace(active_turn_id="turn-1", has_unknown_outcome=False)
    live._local_history = []

    return live


async def scenario_interrupt_closes_admission_before_cancel() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    catalog = _Catalog()
    adapter = _Adapter(entered, release)
    live = live_session(adapter, catalog)
    interrupt_task = asyncio.create_task(live.interrupt())
    await asyncio.wait_for(entered.wait(), timeout=VENDOR_ACK_TIMEOUT_SECONDS)

    result, status = await TurnService(
        {live.id: live},
        SimpleNamespace(error=lambda *_args, **_kwargs: None),
        activities=Activities(),
    ).post(
        live.id,
        {"input": [{"type": "text", "text": "must not enter"}]},
        side=False,
    )
    check(
        "new turn is rejected while vendor interrupt is in flight",
        status == 409 and result.get("error") == "session_interrupting"
        # 用 == [] 而非 not x: 契约要同时钉住「空」与「仍是 list」, not x 会放过 None。
        and live._local_history == [],  # pylint: disable=use-implicit-booleaness-not-comparison
        str(result),
    )
    check("interrupting remains visible until vendor acknowledgement", live.interrupting is True)
    release.set()
    try:
        await asyncio.wait_for(interrupt_task, timeout=VENDOR_ACK_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        interrupt_task.cancel()
        check(
            "vendor 确认后 interrupt 必须返回",
            False,
            f"{VENDOR_ACK_TIMEOUT_SECONDS}s 内没返回 (admission 闸会一直关着)",
        )
        return
    check(
        "successful interrupt expires HIL and clears the barrier",
        adapter.calls == 1
        and catalog.expired == [live.id]
        and live.interrupt_generation == 1
        and live.last_interrupt_succeeded is True
        and live.interrupting is False,
        str(catalog.expired),
    )


async def scenario_failed_interrupt_clears_barrier() -> None:
    class FailingAdapter:
        async def interrupt(self, request) -> CommandReceipt:
            raise RuntimeError("vendor unavailable")

    live = live_session(FailingAdapter(), _Catalog())
    timed_out = False
    try:
        await asyncio.wait_for(live.interrupt(), timeout=VENDOR_ACK_TIMEOUT_SECONDS)
    except RuntimeError:
        failed = True
    except asyncio.TimeoutError:
        failed = False
        timed_out = True
    else:
        failed = False
    check(
        "failed vendor interrupt is explicit and never wedges admission",
        failed and live.last_interrupt_succeeded is False and live.interrupting is False,
        f"{VENDOR_ACK_TIMEOUT_SECONDS}s 内没返回" if timed_out else "",
    )


def main() -> int:
    asyncio.run(scenario_interrupt_closes_admission_before_cancel())
    asyncio.run(scenario_failed_interrupt_clears_barrier())
    print(f"\ncontract_interrupt_barrier: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
