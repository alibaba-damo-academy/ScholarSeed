"""Native Codex session-scoped model persistence contract."""

from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from typing import Any

TEST_HOME = tempfile.TemporaryDirectory()
os.environ["SCHOLARSEED_HOME"] = TEST_HOME.name

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# 这段必须放在**第一个**延迟导入之前: 行级 disable 只对其后生效, 夹在中间会漏掉前面那个。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
from scholarseed_runtime.contract import ModelThinking  # noqa: E402
from scholarseed_runtime.contract.history import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    HistoryEntry,
    MessagePhase,
)
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionBindingConflictError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
    decode_thinking,
    encode_thinking,
)
from service.chat.schema import thinking_from_payload  # noqa: E402
from service.chat.service.models import RETIRED_NATIVE_MODEL_KEY  # noqa: E402
from service.chat.service.settings import SettingsService  # noqa: E402

OFF = ModelThinking(enabled=False)
ON = ModelThinking(enabled=True)
BUDGET_1024 = ModelThinking(budget=1024)


def raises(action: Any) -> str:
    """返回 ``action`` 抛出的 ValueError 消息；没抛则返回空串。"""

    try:
        action()
    except ValueError as error:
        return str(error)
    return ""


PASS = 0
FAIL = 0
SESSION_ID = "session-model-contract"
SECOND_SESSION_ID = "session-model-contract-second"
LEGACY_SESSION_ID = "session-model-contract-legacy"
VENDOR_THREAD_ID = "vendor-thread-contract"
FIRST_MODEL = "gpt-codex-first"
NEXT_MODEL = "gpt-codex-next"
NEXT_VENDOR_THREAD_ID = "vendor-thread-contract-next"
PORTABLE_USER_TEXT = "provider-neutral user history"
PORTABLE_ASSISTANT_TEXT = "provider-neutral assistant history"


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def test_default_and_session_model_are_separate() -> None:
    root = Path(TEST_HOME.name).resolve()
    settings = SettingsService()
    selected = settings.set_runtime_model(FIRST_MODEL)
    check("native Codex default model persists", selected == FIRST_MODEL)
    check("native Codex default model restores", settings.runtime_model() == FIRST_MODEL)

    catalog = SessionCatalogStore(root / "catalog.sqlite3")
    principal = SessionPrincipal("local")
    record = catalog.register(
        SESSION_ID,
        principal,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=VENDOR_THREAD_ID,
        vendor_session_id=None,
        runtime_workdir=str(root / "workdir"),
        project_path=None,
        output_root=str(root / "workdir" / "output"),
        codex_version="0.147.0",
        model_id=FIRST_MODEL,
        policy_id="ask",
        status=SessionStatus.READY,
        title="model contract",
        created_at=1.0,
    )
    check(
        "session starts with its own selected model",
        record.runtime_id == RUNTIME_ID and record.model_id == FIRST_MODEL,
        str(record),
    )
    second = catalog.register(
        SECOND_SESSION_ID,
        principal,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"{VENDOR_THREAD_ID}-second",
        vendor_session_id=None,
        runtime_workdir=str(root / "second-workdir"),
        project_path=None,
        output_root=str(root / "second-workdir" / "output"),
        codex_version="0.147.0",
        model_id=FIRST_MODEL,
        policy_id="ask",
        status=SessionStatus.READY,
        title="second model contract",
        created_at=1.0,
    )
    check("a second session owns a separate model binding", second.model_id == FIRST_MODEL)
    catalog.register(
        LEGACY_SESSION_ID,
        principal,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"{VENDOR_THREAD_ID}-legacy",
        vendor_session_id=None,
        runtime_workdir=str(root / "legacy-workdir"),
        project_path=None,
        output_root=str(root / "legacy-workdir" / "output"),
        codex_version="0.147.0",
        model_id="",
        policy_id="ask",
        status=SessionStatus.READY,
        title="legacy model contract",
        created_at=1.0,
    )
    legacy_state = catalog.model_state(
        LEGACY_SESSION_ID,
        default_model_id=RETIRED_NATIVE_MODEL_KEY,
    )
    legacy_record = catalog.get(LEGACY_SESSION_ID)
    check(
        "pre-model sessions migrate to the product default without breaking session listing",
        legacy_state.selected_model_id == RETIRED_NATIVE_MODEL_KEY
        and legacy_state.active_model_id == RETIRED_NATIVE_MODEL_KEY
        and legacy_record is not None
        and legacy_record.model_id == RETIRED_NATIVE_MODEL_KEY,
        str((legacy_state, legacy_record)),
    )

    settings.set_runtime_model(NEXT_MODEL)
    reopened = catalog.register(
        SESSION_ID,
        principal,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=VENDOR_THREAD_ID,
        vendor_session_id=None,
        runtime_workdir=str(root / "workdir"),
        project_path=None,
        output_root=str(root / "workdir" / "output"),
        codex_version="0.147.0",
        model_id=NEXT_MODEL,
        policy_id="ask",
        status=SessionStatus.READY,
        title="model contract",
        created_at=2.0,
    )
    check("future-session default changes independently", settings.runtime_model() == NEXT_MODEL)
    check(
        "resume retains the originally bound session model",
        reopened.model_id == FIRST_MODEL and reopened.vendor_thread_id == VENDOR_THREAD_ID,
        str(reopened),
    )
    switched = catalog.set_model(SESSION_ID, principal, NEXT_MODEL, updated_at=3.0)
    deferred = catalog.model_state(SESSION_ID)
    untouched = catalog.get(SECOND_SESSION_ID)
    check(
        "switching one session preserves its vendor thread",
        switched.model_id == NEXT_MODEL and switched.vendor_thread_id == VENDOR_THREAD_ID,
        str(switched),
    )
    check(
        "switching one session does not change another session",
        untouched is not None and untouched.model_id == FIRST_MODEL,
        str(untouched),
    )
    check(
        "selection is durable while the current vendor thread keeps its active model",
        deferred.selected_model_id == NEXT_MODEL and deferred.active_model_id == FIRST_MODEL,
        str(deferred),
    )
    confirmed = catalog.apply_model(SESSION_ID, FIRST_MODEL, preserve_selection=True)
    check(
        "runtime confirmation preserves a newer pending selection across restart",
        confirmed.active_model_id == FIRST_MODEL
        and confirmed.selected_model_id == NEXT_MODEL
        and SessionCatalogStore(root / "catalog.sqlite3").model_state(SESSION_ID) == confirmed
        and catalog.get(SESSION_ID).model_id == NEXT_MODEL,
    )
    activated = catalog.transition_model_thread(
        SESSION_ID,
        runtime_id=RUNTIME_ID,
        previous_vendor_thread_id=VENDOR_THREAD_ID,
        vendor_thread_id=NEXT_VENDOR_THREAD_ID,
        model_id=NEXT_MODEL,
        portable_history=(
            HistoryEntry(role="user", text=PORTABLE_USER_TEXT, turn_id="turn-one"),
            HistoryEntry(
                role="assistant",
                text=PORTABLE_ASSISTANT_TEXT,
                turn_id="turn-one",
                phase=MessagePhase.FINAL_ANSWER,
            ),
        ),
        updated_at=4.0,
    )
    rebound = catalog.get(SESSION_ID)
    check(
        "fork activation atomically advances the vendor binding and active model",
        activated.selected_model_id == activated.active_model_id == NEXT_MODEL
        and rebound is not None
        and rebound.vendor_thread_id == NEXT_VENDOR_THREAD_ID,
        str((activated, rebound)),
    )
    restored = SessionCatalogStore(root / "catalog.sqlite3").model_state(SESSION_ID)
    check(
        "selected and active model survive service restart",
        restored == activated,
        str(restored),
    )
    portable_history = SessionCatalogStore(root / "catalog.sqlite3").portable_history(SESSION_ID)
    check(
        "provider-neutral history survives service restart",
        tuple(entry.text for entry in portable_history)
        == (PORTABLE_USER_TEXT, PORTABLE_ASSISTANT_TEXT)
        and portable_history[-1].phase == MessagePhase.FINAL_ANSWER,
        str(portable_history),
    )
    rolled_back = catalog.transition_model_thread(
        SESSION_ID,
        runtime_id=RUNTIME_ID,
        previous_vendor_thread_id=NEXT_VENDOR_THREAD_ID,
        vendor_thread_id=VENDOR_THREAD_ID,
        model_id=FIRST_MODEL,
        selected_model_id=NEXT_MODEL,
        updated_at=4.5,
    )
    check(
        "failed activation can restore the old thread without losing model intent",
        rolled_back.selected_model_id == NEXT_MODEL and rolled_back.active_model_id == FIRST_MODEL,
        str(rolled_back),
    )
    check(
        "rollback preserves the last committed provider-neutral history",
        catalog.portable_history(SESSION_ID) == portable_history,
    )
    activated = catalog.transition_model_thread(
        SESSION_ID,
        runtime_id=RUNTIME_ID,
        previous_vendor_thread_id=VENDOR_THREAD_ID,
        vendor_thread_id=NEXT_VENDOR_THREAD_ID,
        model_id=NEXT_MODEL,
        updated_at=4.75,
    )
    rebound = catalog.get(SESSION_ID)
    conflict_rejected = False
    try:
        catalog.transition_model_thread(
            SESSION_ID,
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id=VENDOR_THREAD_ID,
            vendor_thread_id=f"{NEXT_VENDOR_THREAD_ID}-stale",
            model_id=FIRST_MODEL,
            updated_at=5.0,
        )
    except SessionBindingConflictError:
        conflict_rejected = True
    check(
        "stale fork activation is rejected without changing the active binding",
        conflict_rejected
        and catalog.get(SESSION_ID) == rebound
        and catalog.model_state(SESSION_ID) == activated,
    )
    check(
        "session switch does not replace the future-session default",
        settings.runtime_model() == NEXT_MODEL,
    )


def test_thinking_column_persistence() -> None:
    """P4：开关/预算形态没有档位名可用，值只能按结构化列往返。"""

    with tempfile.TemporaryDirectory() as raw:
        legacy = Path(raw) / "legacy.sqlite3"
        seeded = SessionCatalogStore(legacy)
        seeded.allocate(
            "legacy-thinking",
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            runtime_workdir=raw,
            project_path=None,
            output_root=raw,
            model_id="m",
            reasoning_effort="low",
        )
        with closing(sqlite3.connect(legacy)) as connection:
            # 伪造「本功能之前」的库：两列压根不存在，行里也没有思考值。
            for column in ("selected_thinking_json", "active_thinking_json"):
                connection.execute(f"ALTER TABLE session_model_state DROP COLUMN {column}")
        migrated = SessionCatalogStore(legacy)
        allocating = SessionCatalogStore(Path(raw) / "allocate.sqlite3")
        allocating.allocate(
            "alloc-thinking",
            SessionPrincipal("local"),
            runtime_id=RUNTIME_ID,
            runtime_workdir=raw,
            project_path=None,
            output_root=raw,
            model_id="m",
            thinking=ON,
        )
        allocated = allocating.model_state("alloc-thinking")
        check(
            "allocating a session persists its thinking selection",
            allocated.selected_thinking == ON and allocated.active_thinking is None,
            repr(allocated),
        )
        historical = migrated.model_state("legacy-thinking")
        check(
            "legacy rows open with the additive columns and read as unset",
            historical.selected_thinking is None and historical.active_thinking is None,
            repr(historical),
        )
        check(
            "additive migration keeps the pre-feature effort",
            historical.selected_reasoning_effort == "low",
        )
        migrated.set_model(
            "legacy-thinking",
            SessionPrincipal("local"),
            "m",
            reasoning_effort="low",
            thinking=OFF,
        )
        selected = migrated.model_state("legacy-thinking")
        check(
            "explicit off is not the same value as unset",
            selected.selected_thinking == OFF and selected.selected_thinking is not None,
            repr(selected.selected_thinking),
        )
        migrated.apply_model("legacy-thinking", "m", reasoning_effort="low", thinking=OFF)
        applied = migrated.model_state("legacy-thinking")
        check(
            "runtime confirmation persists the active thinking",
            applied.active_thinking == OFF and not applied.deferred,
            repr(applied),
        )
        with closing(sqlite3.connect(legacy)) as connection:
            stored = connection.execute(
                "SELECT selected_thinking_json, active_thinking_json FROM session_model_state "
                "WHERE session_id = 'legacy-thinking'"
            ).fetchone()
        check(
            "both thinking columns hold the same encoded value once applied",
            stored[0] == stored[1] and json.loads(str(stored[0])) == {"enabled": False},
            repr(stored),
        )
        reopened = SessionCatalogStore(legacy)
        check(
            "thinking survives reopening the real database",
            reopened.model_state("legacy-thinking").selected_thinking == OFF,
        )
        reopened.set_model(
            "legacy-thinking", SessionPrincipal("local"), "m", reasoning_effort="low"
        )
        cleared = reopened.model_state("legacy-thinking")
        check(
            "omitting thinking clears the selection only",
            cleared.selected_thinking is None and cleared.active_thinking == OFF,
            repr(cleared),
        )
        reopened.apply_model("legacy-thinking", "m", reasoning_effort="low")
        baseline = reopened.model_state("legacy-thinking")
        check(
            "aligned selection and active state are not pending",
            baseline.selected_thinking is None
            and baseline.active_thinking is None
            and not baseline.deferred,
            repr(baseline),
        )
        reopened.set_model(
            "legacy-thinking",
            SessionPrincipal("local"),
            "m",
            reasoning_effort="low",
            thinking=ON,
        )
        check(
            "thinking-only change is a pending change",
            reopened.model_state("legacy-thinking").deferred,
        )
        reopened.apply_model("legacy-thinking", "m", reasoning_effort="low", thinking=ON)
        check(
            "confirming that thinking change clears the pending state",
            not reopened.model_state("legacy-thinking").deferred,
        )
        check("empty thinking encodes to NULL", encode_thinking(ModelThinking()) is None)
        check("unusable column values read as unset", decode_thinking('{"enabled": "yes"}') is None)
        check("garbage history reads as unset", decode_thinking("not-json") is None)
        check("budget round-trips", decode_thinking(encode_thinking(BUDGET_1024)) == BUDGET_1024)

    check("non-object thinking payload is rejected", raises(lambda: thinking_from_payload("true")))
    check(
        "string enabled is rejected, not silently dropped",
        raises(lambda: thinking_from_payload({"enabled": "true"})),
    )
    check(
        "string budget is rejected, not silently dropped",
        raises(lambda: thinking_from_payload({"budget": "1024"})),
    )
    check("budget payload converts", thinking_from_payload({"budget": 1024}) == BUDGET_1024)
    check("empty object normalises to unset", thinking_from_payload({}) is None)
    check("absent payload normalises to unset", thinking_from_payload(None) is None)


def main() -> int:
    print("native Codex session model persistence contract")
    test_default_and_session_model_are_separate()
    catalog = SessionCatalogStore(Path(TEST_HOME.name) / "catalog.sqlite3")
    owner = SessionPrincipal("local")
    catalog.set_model(SESSION_ID, owner, NEXT_MODEL, reasoning_effort="high")
    selected = catalog.model_state(SESSION_ID)
    check(
        "effort selection is pending independently of model id",
        selected.selected_reasoning_effort == "high"
        and selected.active_reasoning_effort == ""
        and selected.deferred,
    )
    check(
        "effort selection never leaks to another session",
        catalog.model_state(SECOND_SESSION_ID).selected_reasoning_effort == "",
    )
    catalog.apply_model(SESSION_ID, NEXT_MODEL, reasoning_effort="high")
    check(
        "runtime confirmation persists the active effort",
        not catalog.model_state(SESSION_ID).deferred,
    )
    restored = SessionCatalogStore(Path(TEST_HOME.name) / "catalog.sqlite3")
    check(
        "effort survives reopening the real database",
        restored.model_state(SESSION_ID).active_reasoning_effort == "high",
    )
    restored.set_model(SESSION_ID, owner, NEXT_MODEL, reasoning_effort="")
    restored.apply_model(SESSION_ID, NEXT_MODEL, reasoning_effort="high", preserve_selection=True)
    check(
        "resume does not overwrite a newer default selection",
        restored.model_state(SESSION_ID).selected_reasoning_effort == ""
        and restored.model_state(SESSION_ID).deferred,
    )
    restored.apply_model(SESSION_ID, NEXT_MODEL)
    check(
        "model default clears selected and active effort",
        restored.model_state(SESSION_ID).active_reasoning_effort == ""
        and not restored.model_state(SESSION_ID).deferred,
    )
    test_thinking_column_persistence()
    print(f"passed={PASS} failed={FAIL}")
    TEST_HOME.cleanup()
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
