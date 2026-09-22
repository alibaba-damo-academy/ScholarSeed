"""Contract: native Codex sessions expose only durable product event envelopes.

Run: .venv/bin/python -m tests.contract_recall_status
"""

from __future__ import annotations

import inspect

from service.chat.constants import PRODUCT_EVENT_PLAN_SNAPSHOT, PRODUCT_EVENT_VERSION
from service.chat.persistence.events import ProductEventRecord
from service.chat.runtime.live import LiveSession

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def test_recall_status() -> None:
    print("== native product-event boundary ==")
    record = ProductEventRecord(
        event_id=1,
        session_id="product-session",
        runtime_id="codex",
        vendor_thread_id="vendor-thread",
        vendor_turn_id="vendor-turn",
        vendor_item_id="vendor-item",
        kind=PRODUCT_EVENT_PLAN_SNAPSHOT,
        payload={"items": [{"text": "verify", "status": "in_progress"}]},
        schema_version=PRODUCT_EVENT_VERSION,
        product_seq=7,
        idempotency_key="contract:plan",
        created_at=1.0,
    )
    envelope = LiveSession.event_envelope(record)
    check(
        "plan snapshot uses the frozen product envelope",
        envelope
        == {
            "v": PRODUCT_EVENT_VERSION,
            "seq": 7,
            "ts": 1.0,
            "type": PRODUCT_EVENT_PLAN_SNAPSHOT,
            "session_id": "product-session",
            "turn_id": "vendor-turn",
            "item_id": "vendor-item",
            "data": {"items": [{"text": "verify", "status": "in_progress"}]},
        },
        str(envelope),
    )
    source = inspect.getsource(LiveSession)
    check(
        "removed Damo memory-channel frames cannot leak into the Codex product stream",
        "memory_recall_status" not in source and '"channel": "memory"' not in source,
        "legacy memory event projection remains",
    )


def main() -> int:
    test_recall_status()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
