"""Desktop native-Codex session-list projection contract."""

from __future__ import annotations

import argparse
import base64
import dataclasses
import json
import logging
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from threading import Event
from typing import Any
from unittest.mock import patch

from ._directories import directory, make_directory

_PARSER = argparse.ArgumentParser()
_PARSER.add_argument("--phase", choices=("principal", "machine", "pagination"))
_ARGS = _PARSER.parse_args()
_HOME = (
    Path(os.environ["SCHOLARSEED_HOME"]) if _ARGS.phase else make_directory("session-list-home-")
)
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
from fastapi.testclient import TestClient  # noqa: E402

from scholarseed_runtime.contract import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.history import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    HistoryEntry,
    MessagePhase,
)
from service.bootstrap import create_app  # noqa: E402
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.constants import (  # noqa: E402
    PRODUCT_EVENT_MESSAGE_DELTA,
    PRODUCT_EVENT_USER_MESSAGE,
)
from service.chat.persistence import events as event_persistence  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionListScope,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import (  # noqa: E402 -- after SCHOLARSEED_HOME isolation
    SESSION_FORK_EVENT,
    SESSION_FORK_KEY,
)
from service.chat.service.sessions import (  # noqa: E402
    SESSION_LIST_TIMING_LOGGER,
    SessionListPhase,
    SessionListTiming,
    SessionListTimingEvent,
)
from service.identity.utils import (  # noqa: E402
    OWNERSHIP_AXIS_MACHINE,
    OWNERSHIP_AXIS_STATE,
)

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def main() -> int:
    if _ARGS.phase:
        root = Path(os.environ["SCHOLARSEED_DEFAULT_WORKSPACE"])
        if _ARGS.phase == "principal":
            principal_axis(root)
        elif _ARGS.phase == "machine":
            machine_axis(root)
        else:
            pagination_axis(root)
        print(f"contract_session_listing {_ARGS.phase}: PASS {PASS} / FAIL {FAIL}")
        return 1 if FAIL else 0
    try:
        with directory("session-list-contract-") as root:
            environment = {**os.environ, "SCHOLARSEED_DEFAULT_WORKSPACE": str(root)}
            for phase in ("principal", "machine", "pagination"):
                result = subprocess.run(
                    [sys.executable, "-m", __spec__.name, "--phase", phase],
                    env=environment,
                    timeout=60,
                    check=False,
                )
                if result.returncode:
                    return result.returncode
        print("contract_session_listing: all process lifetimes passed")
        return 0
    finally:
        shutil.rmtree(_HOME)


def principal_axis(root: Path) -> None:
    app = create_app(root, auth=False)
    with TestClient(app) as client:
        catalog = app.state.session_catalog
        principal = SessionPrincipal("local")
        for index, session_id in enumerate(("oldest", "middle", "newest"), start=1):
            catalog.register(
                session_id,
                principal,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=f"vendor-{session_id}",
                vendor_session_id=None,
                runtime_workdir=str(root / session_id),
                project_path=None,
                output_root=str(root / session_id / "output"),
                codex_version="0.147.0",
                model_id="gpt-codex-native",
                policy_id="ask",
                status=SessionStatus.READY,
                title=session_id,
                created_at=float(index),
            )
        catalog.register(
            "foreign",
            SessionPrincipal("foreign-user"),
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-foreign",
            vendor_session_id=None,
            runtime_workdir=str(root / "foreign"),
            project_path=None,
            output_root=str(root / "foreign" / "output"),
            codex_version="0.147.0",
            model_id="gpt-codex-native",
            policy_id="ask",
            status=SessionStatus.READY,
            title="foreign",
            created_at=4.0,
        )
        before_navigation = catalog.get("oldest")
        with (
            patch.object(
                app.state.runtime_service,
                "open",
                side_effect=AssertionError("navigation opened runtime"),
            ) as opened,
            patch.object(
                app.state.runtime_service,
                "readiness",
                side_effect=AssertionError("navigation probed runtime"),
            ) as probed,
            patch.object(
                app.state.session_service,
                "align_metering_identity",
                side_effect=AssertionError("navigation realigned credentials"),
            ) as aligned,
        ):
            navigation = client.get("/api/serve/sessions/oldest/navigation")
            check(
                "navigation restores cold catalog session",
                navigation.status_code == 200,
                navigation.text,
            )
            check(
                "navigation keeps cold session dormant", navigation.json().get("running") is False
            )
            check(
                "navigation returns exact stored identity",
                navigation.json().get("session_id") == "oldest",
            )
            check(
                "navigation does not open/probe runtime or align credentials",
                not opened.called and not probed.called and not aligned.called,
            )
            check(
                "navigation keeps persisted session unchanged",
                catalog.get("oldest") == before_navigation,
            )
            failures = [
                client.get(f"/api/serve/sessions/{session_id}/navigation")
                for session_id in ("foreign", "missing")
            ]
            for response in failures:
                check("navigation hides unavailable sessions", response.status_code == 404)
                check(
                    "navigation exposes the renderer's stable missing-session code",
                    response.json().get("code") == "session_not_found",
                    response.text,
                )
            check(
                "navigation does not distinguish foreign from deleted sessions",
                failures[0].json() == failures[1].json(),
            )
        catalog.transition_model_thread(
            "middle",
            runtime_id=RUNTIME_ID,
            previous_vendor_thread_id="vendor-middle",
            vendor_thread_id="vendor-middle-search",
            model_id="gpt-codex-native",
            portable_history=(
                HistoryEntry(
                    role="user",
                    text="请查找唯一正文关键词和相关资料",
                    turn_id="turn-search",
                    item_id="item-search",
                ),
                HistoryEntry(
                    role="assistant",
                    text="已经完成资料整理。",
                    turn_id="turn-search",
                    item_id="answer-search",
                    phase=MessagePhase.FINAL_ANSWER,
                ),
            ),
            updated_at=2.0,
        )
        app.state.product_events.append(
            session_id="middle",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-middle-search",
            vendor_turn_id="turn-search",
            vendor_item_id="item-search",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": "请查找唯一正文关键词和相关资料"},
            idempotency_key="session-list-search-message",
            created_at=2.0,
        )
        app.state.product_events.append(
            session_id="middle",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-middle-search",
            vendor_turn_id="turn-best-search",
            vendor_item_id="answer-best-search",
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": "唯一正文关键词出现三次：唯一正文关键词，唯一正文关键词。"},
            idempotency_key="session-list-search-best-answer",
            created_at=2.1,
        )
        app.state.product_events.append(
            session_id="middle",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-middle-search",
            vendor_turn_id="turn-latest-reply",
            vendor_item_id="answer-latest-reply",
            kind=PRODUCT_EVENT_MESSAGE_DELTA,
            payload={"delta": "最后一条 Agent 回复", "phase": MessagePhase.FINAL_ANSWER.value},
            idempotency_key="session-list-latest-agent-reply",
            created_at=2.15,
        )
        app.state.product_events.append(
            session_id="middle",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-middle-search",
            vendor_turn_id="turn-followup",
            vendor_item_id="item-followup",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": "这条用户消息不应刷新 Agent 回复时间"},
            idempotency_key="session-list-later-user-message",
            created_at=2.2,
        )
        app.state.product_events.append(
            session_id="newest",
            runtime_id=RUNTIME_ID,
            vendor_thread_id="vendor-newest",
            vendor_turn_id="turn-title-and-message",
            vendor_item_id="item-title-and-message",
            kind=PRODUCT_EVENT_USER_MESSAGE,
            payload={"text": "newest 同时命中标题和正文"},
            idempotency_key="session-list-title-and-message",
            created_at=3.1,
        )

        async def readiness(*, executable: str = "") -> RuntimeReadiness:
            return RuntimeReadiness(
                runtime_id=RUNTIME_ID,
                status=RuntimeStatus.READY,
                ready=True,
                executable=executable or "codex",
                version="0.147.0",
                authenticated=True,
                process_state="ready",
            )

        app.state.runtime_service.readiness = readiness
        with patch.object(
            catalog, "observe", side_effect=AssertionError("list installed mutation triggers")
        ) as observer:
            response = client.get("/api/serve/sessions")
            check("ordinary listing skips notification setup", not observer.called)
        payload = response.json()
        rows = payload.get("sessions", [])
        ids = [row["session_id"] for row in rows]
        check("serve session list responds", response.status_code == 200, response.text)
        check(
            "product sessions are newest-to-oldest", ids == ["newest", "middle", "oldest"], str(ids)
        )
        check(
            "creation timestamp is exposed to the desktop client",
            rows[0].get("created_at") == 3.0,
            str(rows[0]),
        )
        check(
            "ordinary session listing does not scan Agent reply history",
            all("last_agent_reply_at" not in row for row in rows),
            str(rows),
        )
        with (
            patch.object(
                app.state.product_events, "observe", wraps=app.state.product_events.observe
            ) as reply_observer,
            patch(
                "service.chat.persistence.events.reader",
                wraps=event_persistence.reader,
            ) as reply_readers,
        ):
            reply_rows = client.get(
                "/api/serve/sessions", params={"include_last_agent_reply": "true"}
            ).json()["sessions"]
        check(
            "reply-time listing never installs mutation notifications",
            reply_observer.call_count == 0,
            str(reply_observer.call_count),
        )
        check("reply-time listing uses one read snapshot", reply_readers.call_count == 1)
        reply_times = {row["session_id"]: row.get("last_agent_reply_at") for row in reply_rows}
        entered = Event()
        release = Event()
        original_reply = app.state.product_events.last_agent_reply_times

        def delayed_reply(session_ids: list[str]) -> dict[str, float | None]:
            entered.set()
            if not release.wait(10):
                raise TimeoutError("history probe was not released")
            return original_reply(session_ids)

        with (
            patch.object(app.state.product_events, "last_agent_reply_times", delayed_reply),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            listing = executor.submit(
                client.get, "/api/serve/sessions", params={"include_last_agent_reply": "true"}
            )
            try:
                check("history probe entered", entered.wait(5))
                lightweight = executor.submit(client.get, "/api/serve/sessions")
                try:
                    response = lightweight.result(timeout=2)
                    check(
                        "slow history does not block lightweight requests",
                        response.status_code == 200,
                    )
                except FutureTimeoutError:
                    check("slow history does not block lightweight requests", False)
            finally:
                release.set()
            check(
                "history request completes after release",
                listing.result(timeout=5).status_code == 200,
            )
        check(
            "last Agent reply ignores newer user activity and distinguishes unanswered sessions",
            reply_times == {"newest": None, "middle": 2.15, "oldest": None}
            and next(row for row in reply_rows if row["session_id"] == "middle")["mtime"] == 2.2,
            str(reply_rows),
        )
        check("another principal is never listed", "foreign" not in ids, str(ids))
        check("session list reports the scoped total", payload.get("total") == 3, str(payload))
        first_page = client.get("/api/serve/sessions", params={"limit": 2}).json()
        next_cursor = first_page.get("next_cursor")
        last_page = client.get(
            "/api/serve/sessions", params={"limit": 2, "cursor": next_cursor or "missing"}
        ).json()
        check(
            "session pages continue from the last activity without duplication",
            bool(next_cursor)
            and [row["session_id"] for row in first_page["sessions"]] == ["newest", "middle"]
            and [row["session_id"] for row in last_page.get("sessions", [])] == ["oldest"]
            and last_page.get("next_cursor") is None,
            str(last_page),
        )
        check(
            "invalid session cursor is rejected",
            client.get("/api/serve/sessions", params={"cursor": "not-a-cursor"}).status_code == 422,
        )
        search_response = client.get(
            "/api/serve/sessions",
            params={"query": "唯一正文关键词"},
        )
        search_rows = search_response.json().get("sessions", [])
        check(
            "message body search returns excerpt and stable locator",
            search_response.status_code == 200
            and search_response.json().get("total") == 3
            and len(search_rows) == 1
            and search_rows[0]["session_id"] == "middle"
            and search_rows[0].get("match", {}).get("field") == "message"
            and search_rows[0].get("match", {}).get("role") == "assistant"
            and search_rows[0].get("match", {}).get("count") == 4
            and search_rows[0].get("match", {}).get("turn_id") == "turn-best-search"
            and search_rows[0].get("match", {}).get("item_id") == "answer-best-search",
            str(search_rows),
        )
        title_rows = (
            client.get(
                "/api/serve/sessions",
                params={"query": "newest"},
            )
            .json()
            .get("sessions", [])
        )
        check(
            "message details win when both title and body match",
            len(title_rows) == 1
            and title_rows[0].get("match", {}).get("field") == "message"
            and title_rows[0].get("match", {}).get("count") == 1,
            str(title_rows),
        )
        title_only_rows = (
            client.get(
                "/api/serve/sessions",
                params={"query": "oldest"},
            )
            .json()
            .get("sessions", [])
        )
        check(
            "title-only search omits message details",
            len(title_only_rows) == 1
            and title_only_rows[0].get("match") == {"excerpt": "oldest", "field": "title"},
            str(title_only_rows),
        )
        user_rows = (
            client.get(
                "/api/serve/sessions",
                params={"query": "请查找"},
            )
            .json()
            .get("sessions", [])
        )
        check(
            "user-message search preserves its role",
            len(user_rows) == 1
            and user_rows[0].get("match", {}).get("role") == "user"
            and user_rows[0].get("match", {}).get("count") == 1,
            str(user_rows),
        )
        check(
            "every row carries the frozen native runtime projection",
            payload.get("runtime_id") == RUNTIME_ID
            and all(
                row.get("runtime_id") == RUNTIME_ID
                and row.get("runtime", {}).get("version") == "0.147.0"
                and row.get("kind") == "session"
                and "work" not in row
                for row in rows
            ),
            str(rows),
        )
        project_scopes(app, client, root, principal)
        pagination_regression(app, client, principal)
        legacy = catalog.register(
            "legacy-model",
            principal,
            runtime_id=RUNTIME_ID,
            vendor_thread_id="legacy-model-thread",
            vendor_session_id=None,
            runtime_workdir=str(root / "legacy-model"),
            project_path=None,
            output_root=str(root / "legacy-model" / "output"),
            codex_version=None,
            model_id=None,
            policy_id=None,
            status=SessionStatus.READY,
            title="Legacy model",
            created_at=0.0,
        )
        with patch.object(catalog, "observe", wraps=catalog.observe) as observer:
            # The project pagination fixtures must not consume this query's candidate window.
            legacy_response = client.get(
                "/api/serve/sessions", params={"scope": "unassigned", "query": legacy.title}
            )
            check("legacy model backfill uses one observed connection", observer.call_count == 1)
        legacy_rows = legacy_response.json().get("sessions", [])
        persisted = catalog.get(legacy.session_id)
        check(
            "legacy model is persisted and projected by listing",
            legacy_response.status_code == 200
            and len(legacy_rows) == 1
            and persisted is not None
            and bool(persisted.model_id)
            and legacy_rows[0]["runtime"]["model_id"] == persisted.model_id,
            legacy_response.text,
        )


def pagination_regression(app: Any, client: TestClient, principal: SessionPrincipal) -> None:
    project = str(app.state.content.create_project("Pagination").root)
    params = {"scope": "project", "project_path": project, "limit": 30}
    catalog = app.state.session_catalog
    count = 0
    for size in (0, 30, 31, 65, 505):
        for index in range(count, size):
            session_id = f"paged-{index:04d}"
            catalog.register(
                session_id,
                principal,
                runtime_id=RUNTIME_ID,
                vendor_thread_id=f"vendor-{session_id}",
                vendor_session_id=None,
                runtime_workdir=project,
                project_path=project,
                output_root=project,
                codex_version="0.147.0",
                model_id="gpt-codex-native",
                policy_id="ask",
                status=SessionStatus.READY,
                title="needle" if index in (2, 503, 504) else session_id,
                created_at=100.0,
            )
        count = size
        collected = []
        cursor = None
        observed = set()
        for _ in range(size + 1):
            response = client.get(
                "/api/serve/sessions", params={**params, **({"cursor": cursor} if cursor else {})}
            )
            payload = response.json()
            check("paged list responds", response.status_code == 200, response.text)
            collected.extend(row["session_id"] for row in payload.get("sessions", []))
            check(
                "page total follows the bounded cursor projection",
                payload.get("total") == len(payload.get("sessions", [])),
            )
            check("paged response has an explicit end marker", "next_cursor" in payload)
            cursor = payload.get("next_cursor")
            if cursor is None:
                break
            check("cursor advances", cursor not in observed)
            observed.add(cursor)
        check(
            f"{size} sessions are reachable once in stable tie order",
            collected == [f"paged-{index:04d}" for index in range(size)],
            str(collected),
        )
    app.state.product_events.append(
        session_id="paged-0504",
        runtime_id=RUNTIME_ID,
        vendor_thread_id="vendor-paged-0504",
        vendor_turn_id="paged-body-turn",
        vendor_item_id="paged-body-item",
        kind=PRODUCT_EVENT_USER_MESSAGE,
        payload={"text": "body-only-needle"},
        idempotency_key="paged-body-search",
        created_at=100.0,
    )

    def collect(query: str, limit: int = 30):
        result = []
        cursor = None
        observed = set()
        for _ in range(count + 1):
            payload = client.get(
                "/api/serve/sessions",
                params={
                    **params,
                    "query": query,
                    "limit": limit,
                    **({"cursor": cursor} if cursor else {}),
                },
            ).json()
            result.extend(payload["sessions"])
            cursor = payload.get("next_cursor")
            if cursor is None:
                return result
            check("sparse search cursor advances", cursor not in observed)
            observed.add(cursor)
        raise AssertionError("cursor did not exhaust")

    body = collect("body-only")
    check(
        "body search beyond 500 preserves locator",
        len(body) == 1
        and body[0]["match"].get("turn_id") == "paged-body-turn"
        and body[0]["match"].get("item_id") == "paged-body-item",
        str(body),
    )
    first = client.get("/api/serve/sessions", params=params).json()
    check(
        "listing retains only the cursor contract",
        "next_offset" not in first and "next_cursor" in first,
    )
    for invalid in ("-1", "bad", "1.5"):
        response = client.get("/api/serve/sessions", params={**params, "cursor": invalid})
        check("invalid cursors rejected", response.status_code == 422, response.text)
    with patch.object(
        app.state.session_service, "_list_row", wraps=app.state.session_service._list_row
    ) as build:
        head = client.get(
            "/api/serve/sessions", params={**params, "query": "needle", "limit": 1}
        ).json()
        check("only returned hits build full rows", build.call_count == 1)
    check(
        "first sparse hit is retained",
        [row["session_id"] for row in head["sessions"]] == ["paged-0002"],
    )
    hits = collect("needle", 1)
    check(
        "sparse search reaches beyond 500 without skipping candidates",
        [row["session_id"] for row in hits] == ["paged-0002", "paged-0503", "paged-0504"],
        str(hits),
    )
    check("no hits exhausts", collect("absent") == [])
    unassigned = client.get("/api/serve/sessions", params={"scope": "unassigned"}).json()
    check(
        "unassigned excludes projects and foreign principal",
        {row["session_id"] for row in unassigned["sessions"]} == {"oldest", "middle", "newest"},
    )
    with (
        patch.object(SESSION_LIST_TIMING_LOGGER, "isEnabledFor", return_value=True),
        patch.object(SESSION_LIST_TIMING_LOGGER, "log") as diagnostic_log,
        patch.object(
            app.state.product_events, "observe", wraps=app.state.product_events.observe
        ) as notifications,
        patch.object(event_persistence, "reader", wraps=event_persistence.reader) as reply_readers,
    ):
        diagnostic = client.get(
            "/api/serve/sessions",
            params={**params, "limit": 500, "include_last_agent_reply": True},
            headers={"x-scholarseed-diagnostic-id": "a" * 32},
        )
    check("500-task reply listing preserves the page", len(diagnostic.json()["sessions"]) == 500)
    check("500-task reply listing opens one read snapshot", reply_readers.call_count == 1)
    check("500-task reply listing has zero write observers", notifications.call_count == 0)
    timings = [json.loads(call.args[1]) for call in diagnostic_log.call_args_list]
    check(
        "correlated list timing is available at normal INFO level",
        all(call.args[0] == logging.INFO for call in diagnostic_log.call_args_list),
    )
    check(
        "timing distinguishes physical worker completion from response completion",
        [row["event"] for row in timings] == ["worker_finished", "finished"],
    )
    final = timings[-1]
    check(
        "timing correlates with the HTTP request",
        bool(final["request_id"]) and final["client_request_id"] == "a" * 32,
    )
    check(
        "timing records real page counts",
        final["counts"]["selected_rows"] == final["counts"]["reply_sessions"] == 500,
    )
    check(
        "timing separates worker queue and query phases",
        final["queue_ms"] >= 0
        and all(
            phase.value in final["phases_ms"]
            for phase in (
                SessionListPhase.CATALOG,
                SessionListPhase.SEARCH,
                SessionListPhase.STATES,
                SessionListPhase.REPLIES,
                SessionListPhase.PROJECTION,
            )
        ),
    )
    check(
        "timing excludes project paths and titles",
        project not in json.dumps(timings) and "needle" not in json.dumps(timings),
    )
    print("session_list_probe " + json.dumps(final))
    with patch.object(SESSION_LIST_TIMING_LOGGER, "isEnabledFor", return_value=False):
        check(
            "disabled diagnostics allocate no observation",
            SessionListTiming.create(None, None) is None,
        )
    with patch.object(
        SESSION_LIST_TIMING_LOGGER, "isEnabledFor", side_effect=lambda level: level >= logging.INFO
    ):
        check(
            "ordinary uncorrelated reads remain DEBUG-only",
            SessionListTiming.create(None, None) is None,
        )
        check(
            "correlated reads retain phase timing without global DEBUG",
            SessionListTiming.create("server-request", "a" * 32) is not None,
        )
    entered, release = Event(), Event()
    observation = SessionListTiming()

    def held_reader():
        entered.set()
        if not release.wait(5):
            raise TimeoutError("test reader not released")
        raise ValueError("private-query-and-body")

    with (
        patch.object(SESSION_LIST_TIMING_LOGGER, "log") as lifecycle_log,
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        pending = executor.submit(observation.run, held_reader)
        try:
            check("physical timing starts with the actual worker", entered.wait(5))
            observation.report(SessionListTimingEvent.FINISHED, "CancelledError")
            check(
                "cancelled waiter does not claim the worker completed",
                not json.loads(lifecycle_log.call_args.args[1])["worker_completed"],
            )
        finally:
            release.set()
        try:
            pending.result(timeout=5)
        except ValueError:
            pass
        else:
            check("timing preserves worker errors", False)
    final_worker = json.loads(lifecycle_log.call_args.args[1])
    check(
        "late worker completion retains failure class without error text",
        final_worker["worker_completed"]
        and final_worker["error_type"] == "ValueError"
        and "private-query-and-body" not in str(lifecycle_log.call_args_list),
    )


def pagination_axis(root: Path) -> None:
    app = create_app(root, auth=False)

    async def readiness(*, executable: str = "") -> RuntimeReadiness:
        return RuntimeReadiness(
            runtime_id=RUNTIME_ID,
            status=RuntimeStatus.READY,
            ready=True,
            executable=executable or "codex",
            version="0.147.0",
            authenticated=True,
            process_state="ready",
        )

    app.state.runtime_service.readiness = readiness
    with TestClient(app) as client:
        pagination(app, client, root, SessionPrincipal("local"))


def pagination(app: Any, client: TestClient, root: Path, principal: SessionPrincipal) -> None:
    catalog = app.state.session_catalog
    project = app.state.content.create_project("Pagination").root
    expected = [f"page-{index:04}" for index in range(503)]
    for session_id in expected:
        catalog.register(
            session_id,
            principal,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(root),
            project_path=project,
            output_root=str(root),
            codex_version="0.147.0",
            model_id="gpt-codex-native",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=100.0,
        )
    params = {"scope": "project", "project_path": project, "limit": 1000}
    first = client.get("/api/serve/sessions", params=params).json()
    tail = client.get(
        "/api/serve/sessions", params={**params, "cursor": first.get("next_cursor", "missing")}
    ).json()
    check(
        "keyset pages traverse more than 500 equal-timestamp rows without changing the page cap",
        len(first.get("sessions", [])) == 500
        and [row["session_id"] for row in first["sessions"] + tail.get("sessions", [])] == expected
        and tail.get("next_cursor") is None,
        str(len(first.get("sessions", []))),
    )
    search = client.get(
        "/api/serve/sessions", params={**params, "query": "page-", "limit": 2}
    ).json()
    continued = client.get(
        "/api/serve/sessions",
        params={**params, "query": "page-", "limit": 2, "cursor": search.get("next_cursor")},
    ).json()
    check(
        "search cursor follows the last scanned row rather than the raw page tail",
        [row["session_id"] for row in search["sessions"] + continued.get("sessions", [])]
        == expected[:4],
    )
    foreign_cursor = client.get(
        "/api/serve/sessions",
        params={"scope": "unassigned", "limit": 2, "cursor": first.get("next_cursor")},
    ).json()
    check(
        "a cursor cannot bypass the requested scope or principal",
        {row["session_id"] for row in foreign_cursor.get("sessions", [])}
        <= {"oldest", "middle", "newest"},
    )
    catalog.set_pinned(expected[-1], principal, True)
    pinned_page = client.get("/api/serve/sessions", params={**params, "limit": 2}).json()
    pinned_tail = client.get(
        "/api/serve/sessions",
        params={**params, "limit": 2, "cursor": pinned_page.get("next_cursor")},
    ).json()
    check(
        "project pagination follows pinned ordering without repeating the pinned task",
        [row["session_id"] for row in pinned_page["sessions"] + pinned_tail.get("sessions", [])]
        == [expected[-1], *expected[:3]],
    )
    pinned_single = client.get("/api/serve/sessions", params={**params, "limit": 1}).json()
    unpinned_single = client.get(
        "/api/serve/sessions",
        params={**params, "limit": 1, "cursor": pinned_single.get("next_cursor")},
    ).json()
    check(
        "project cursor crosses from the pinned group to the original activity order",
        [row["session_id"] for row in pinned_single["sessions"] + unpinned_single["sessions"]]
        == [expected[-1], expected[0]],
    )
    pinned_search = client.get(
        "/api/serve/sessions", params={**params, "query": "page-", "limit": 2}
    ).json()
    pinned_search_tail = client.get(
        "/api/serve/sessions",
        params={**params, "query": "page-", "limit": 2, "cursor": pinned_search.get("next_cursor")},
    ).json()
    check(
        "project search pagination preserves the pinned ordering components",
        [row["session_id"] for row in pinned_search["sessions"] + pinned_search_tail["sessions"]]
        == [expected[-1], *expected[:3]],
    )
    catalog.set_pinned(expected[-1], principal, False)
    original = catalog.owned(principal)
    moved = client.put(
        f"/api/serve/sessions/{expected[-1]}/display-order",
        json={"target_session_id": expected[0], "placement": "before"},
    )
    check(
        "relative ordering accepts a session beyond the first 500 rows",
        moved.status_code == 200,
        moved.text,
    )
    reopened = type(catalog)(shared_ownership=catalog.shared_ownership)
    check(
        "relative ordering changes only presentation ranks in the complete sibling set",
        all(
            record == dataclasses.replace(original[session_id], display_order=record.display_order)
            for session_id, record in reopened.owned(principal).items()
        ),
    )
    ordered_first = client.get("/api/serve/sessions", params=params).json()
    ordered_tail = client.get(
        "/api/serve/sessions", params={**params, "cursor": ordered_first.get("next_cursor")}
    ).json()
    ordered_expected = [expected[-1], *expected[:-1]]
    check(
        "durable manual order paginates all 503 sessions without omission or duplication",
        [row["session_id"] for row in ordered_first["sessions"] + ordered_tail["sessions"]]
        == ordered_expected
        and ordered_tail.get("next_cursor") is None,
    )
    moved_to_tail = client.put(
        f"/api/serve/sessions/{expected[0]}/display-order",
        json={"target_session_id": expected[-2], "placement": "after"},
    )
    reordered = reopened.listed(
        principal,
        runtime_id=RUNTIME_ID,
        scope=SessionListScope.PROJECT,
        project_path=project,
        limit=None,
        archived=False,
    )
    check(
        "relative ordering resolves a target beyond the first 500 rows from durable metadata",
        moved_to_tail.status_code == 200
        and [record.session_id for record in reordered]
        == [expected[-1], *expected[1:-1], expected[0]],
        moved_to_tail.text,
    )
    for body in (
        {"target_session_id": expected[0], "placement": "invalid"},
        {"target_session_id": expected[0]},
        {"target_session_id": 12, "placement": "before"},
    ):
        rejected = client.put(f"/api/serve/sessions/{expected[-1]}/display-order", json=body)
        check(
            "invalid relative order request is rejected", rejected.status_code == 422, rejected.text
        )
    for values in (
        [True, "id"],
        [-1, "id"],
        [float("nan"), "id"],
        [1, ""],
        [1, 2],
        {},
        [1, "id", "false"],
        [1, "id", 0],
        [1, "id", True, 1],
    ):
        cursor = base64.urlsafe_b64encode(json.dumps(values).encode()).decode()
        check(
            f"invalid cursor shape rejected: {values}",
            client.get("/api/serve/sessions", params={"cursor": cursor}).status_code == 422,
        )
    for operation in ("archive", "delete"):
        cursor_page = client.get("/api/serve/sessions", params={**params, "limit": 1}).json()
        anchor_id = cursor_page["sessions"][0]["session_id"]
        removed = (
            client.put(f"/api/serve/sessions/{anchor_id}/archive", json={"archived": True})
            if operation == "archive"
            else client.delete(f"/api/serve/sessions/{anchor_id}")
        )
        stale_page = client.get(
            "/api/serve/sessions", params={**params, "cursor": cursor_page["next_cursor"]}
        )
        check(
            f"{operation} of a cursor anchor explicitly invalidates the project page",
            removed.status_code == 200
            and stale_page.status_code == 422
            and stale_page.json().get("detail") == "session_list_cursor_invalid",
            stale_page.text,
        )
        if operation == "archive":
            catalog.set_archived(anchor_id, principal, False)


def project_scopes(app: Any, client: TestClient, root: Path, principal: SessionPrincipal) -> None:
    """Project filtering must happen before the catalog limit is applied."""

    catalog = app.state.session_catalog
    # proposal 47: Content is the sole project-identity authority. Registering
    # only in the retired chat projects.json must no longer grant access.
    project_a = Path(app.state.content.create_project("Project A").root)
    project_b = Path(app.state.content.create_project("Project B").root)

    for index in range(3):
        session_id = f"project-a-{index}"
        catalog.register(
            session_id,
            principal,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(project_a),
            project_path=str(project_a),
            output_root=str(project_a),
            codex_version="0.147.0",
            model_id="gpt-codex-native",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=float(10 + index),
        )
    for index in range(4):
        session_id = f"project-b-{index}"
        catalog.register(
            session_id,
            principal,
            runtime_id=RUNTIME_ID,
            vendor_thread_id=f"vendor-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(project_b),
            project_path=str(project_b),
            output_root=str(project_b),
            codex_version="0.147.0",
            model_id="gpt-codex-native",
            policy_id="ask",
            status=SessionStatus.READY,
            title=session_id,
            created_at=float(20 + index),
        )

    scoped = client.get(
        "/api/serve/sessions",
        params={"scope": "project", "project_path": str(project_a), "limit": 2},
    )
    scoped_ids = [row["session_id"] for row in scoped.json().get("sessions", [])]
    check(
        "project scope filters before limit",
        scoped.status_code == 200 and scoped_ids == ["project-a-2", "project-a-1"],
        f"status={scoped.status_code}; ids={scoped_ids}",
    )
    baseline = client.get("/api/serve/sessions", params={"scope": "all", "limit": 100}).json()
    for session_id in ("project-a-0", "project-a-1"):
        response = client.put(f"/api/serve/sessions/{session_id}/pin", json={"pinned": True})
        check("project task pin persists through the public route", response.status_code == 200)
    for query in (None, "project-a"):
        params = {"scope": "project", "project_path": str(project_a), "limit": 1}
        if query:
            params["query"] = query
        pinned_rows = client.get("/api/serve/sessions", params=params).json()["sessions"]
        check(
            "project pins precede limit and preserve existing within-group order",
            len(pinned_rows) == 1
            and pinned_rows[0]["session_id"] == "project-a-1"
            and pinned_rows[0]["pinned"] is True,
            str(pinned_rows),
        )
    after_pin = client.get("/api/serve/sessions", params={"scope": "all", "limit": 100}).json()
    check(
        "pinning does not alter all-scope order or activity",
        [(row["session_id"], row["mtime"]) for row in baseline["sessions"]]
        == [(row["session_id"], row["mtime"]) for row in after_pin["sessions"]],
    )
    for session_id in ("project-a-0", "project-a-1"):
        client.put(f"/api/serve/sessions/{session_id}/pin", json={"pinned": False})
    restored = client.get(
        "/api/serve/sessions",
        params={"scope": "project", "project_path": str(project_a), "limit": 2},
    ).json()["sessions"]
    check(
        "unpin restores original activity ordering",
        [row["session_id"] for row in restored] == scoped_ids,
    )
    unassigned = client.get(
        "/api/serve/sessions",
        params={"scope": "unassigned", "limit": 10},
    )
    unassigned_ids = {row["session_id"] for row in unassigned.json().get("sessions", [])}
    check(
        "unassigned scope excludes every project session",
        unassigned.status_code == 200 and unassigned_ids == {"oldest", "middle", "newest"},
        f"status={unassigned.status_code}; ids={unassigned_ids}",
    )
    child_id = "project-a-2"
    catalog.set_display_parent(child_id, principal, "project-a-0")
    events = app.state.product_events
    events.append(
        session_id=child_id,
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"vendor-{child_id}",
        vendor_turn_id=None,
        vendor_item_id=None,
        kind=SESSION_FORK_EVENT,
        payload={
            "source_session_id": "project-a-1",
            "source_turn_id": "original-turn",
            "source_product_seq": 1,
        },
        idempotency_key=SESSION_FORK_KEY,
    )
    before_detach = catalog.get(child_id)
    assert before_detach is not None
    before_events = events.replay(child_id)
    children = client.get("/api/serve/sessions/project-a-0/display-children")
    check(
        "delete confirmation counts attached children",
        children.status_code == 200 and children.json()["child_count"] == 1,
        children.text,
    )
    for _ in range(2):
        detached = client.delete(f"/api/serve/sessions/{child_id}/display-parent")
        check(
            "detach clears only the display parent and is idempotent",
            detached.status_code == 200
            and detached.json()
            == {
                "ok": True,
                "session_id": child_id,
                "display_parent_session_id": None,
            }
            and catalog.get(child_id)
            == dataclasses.replace(
                before_detach,
                display_parent_session_id=None,
                detached_parent_session_id=before_detach.display_parent_session_id,
                display_order=0,
            ),
            detached.text,
        )
        check(
            "detach preserves the sibling source, fork anchor and complete event history",
            events.replay(child_id) == before_events,
        )
    reopened = type(catalog)(shared_ownership=catalog.shared_ownership)
    denied_parent = client.put(
        f"/api/serve/sessions/{child_id}/display-parent", json={"parent_session_id": "project-a-1"}
    )
    check(
        "returning rejects an unrelated parent",
        denied_parent.status_code == 422,
        denied_parent.text,
    )
    returned = client.put(
        f"/api/serve/sessions/{child_id}/display-parent", json={"parent_session_id": "project-a-0"}
    )
    check(
        "returning restores only the recorded parent",
        returned.status_code == 200
        and returned.json()["display_parent_session_id"] == "project-a-0",
        returned.text,
    )
    client.delete(f"/api/serve/sessions/{child_id}/display-parent")
    check(
        "detached display parent survives reopening the catalog",
        reopened.get(child_id) == catalog.get(child_id),
    )
    check(
        "missing detach targets remain non-enumerating",
        client.delete("/api/serve/sessions/missing/display-parent").status_code == 404,
    )
    archived_id = "project-a-2"
    catalog.update_status(archived_id, SessionStatus.RUNNING)
    denied_stop = client.put(
        f"/api/serve/sessions/{archived_id}/archive",
        json={"archived": True, "stop_running": False},
    )
    check(
        "archive API forwards the absence of stop consent before any runtime activation",
        denied_stop.status_code == 409
        and denied_stop.json()["error"] == "session_archive_stop_required"
        and not catalog.get(archived_id).archived,
        denied_stop.text,
    )
    check(
        "archive stop consent rejects string booleans",
        client.put(
            f"/api/serve/sessions/{archived_id}/archive",
            json={"archived": True, "stop_running": "false"},
        ).status_code
        == 422,
    )
    catalog.update_status(archived_id, SessionStatus.COMPLETED)
    archived = client.put(
        f"/api/serve/sessions/{archived_id}/archive", json={"archived": True, "stop_running": False}
    )
    check("idle task archives through the public owner route", archived.status_code == 200)
    visible = client.get(
        "/api/serve/sessions",
        params={
            "scope": "project",
            "project_path": str(project_a),
            "limit": 1,
        },
    ).json()["sessions"]
    check(
        "archive filtering precedes the public page limit",
        len(visible) == 1 and visible[0]["session_id"] != archived_id,
    )
    archived_rows = client.get("/api/serve/sessions", params={"archived": True}).json()["sessions"]
    check(
        "settings can explicitly list archived tasks",
        [row["session_id"] for row in archived_rows] == [archived_id],
    )
    check(
        "archived history stays readable",
        client.get(f"/api/serve/history/{archived_id}").status_code == 200,
    )
    for method, path, body in (
        ("POST", f"/api/serve/sessions/{archived_id}/turns", {"text": "no new turn"}),
        ("PATCH", f"/api/serve/sessions/{archived_id}", {"title": "no edit"}),
        ("PUT", f"/api/serve/sessions/{archived_id}/pin", {"pinned": True}),
        ("DELETE", f"/api/serve/sessions/{archived_id}/display-parent", None),
        (
            "PUT",
            f"/api/serve/sessions/{archived_id}/display-order",
            {"target_session_id": "project-a-0", "placement": "before"},
        ),
    ):
        response = client.request(method, path, json=body)
        check(
            "archived conversation mutations are rejected: " + method, response.status_code == 409
        )
    archived_target = client.put(
        "/api/serve/sessions/project-a-0/display-order",
        json={"target_session_id": archived_id, "placement": "before"},
    )
    check(
        "archived ordering targets are rejected as a state conflict",
        archived_target.status_code == 409,
        archived_target.text,
    )
    check(
        "archived tasks cannot restore ordinary navigation",
        client.get(f"/api/serve/sessions/{archived_id}/navigation").status_code == 404,
    )
    restored = client.put(f"/api/serve/sessions/{archived_id}/archive", json={"archived": False})
    check(
        "restore retains task identity",
        restored.status_code == 200 and restored.json()["session_id"] == archived_id,
    )
    missing_path = client.get("/api/serve/sessions", params={"scope": "project"})
    check(
        "project scope requires an explicit path",
        missing_path.status_code == 422,
        missing_path.text,
    )
    unregistered = root / "unregistered"
    unregistered.mkdir()
    denied = client.get(
        "/api/serve/sessions",
        params={"scope": "project", "project_path": str(unregistered)},
    )
    check(
        "an unregistered project scope is non-enumerating",
        denied.status_code == 404,
        denied.text,
    )
    catalog.set_display_parent(child_id, principal, "project-a-0")
    for source_id in ("project-a-0", "project-a-1"):
        removed = client.delete(f"/api/serve/sessions/{source_id}")
        check("detachment fixture removes its parent or sibling source", removed.status_code == 200)
    preserved = catalog.get(child_id)
    assert preserved is not None
    detached = client.delete(f"/api/serve/sessions/{child_id}/display-parent")
    check(
        "unavailable parent and actual source do not prevent owned child detachment",
        detached.status_code == 200
        and catalog.get(child_id) == preserved
        and preserved.display_parent_session_id is None
        and events.replay(child_id) == before_events,
        detached.text,
    )


def machine_axis(root: Path) -> None:
    """bug 86043648 的回归锚点: machine 轴下换账号仍看得到别人建的会话。

    复用上面那个隔离 home 的同一个会话库 —— 里面已经有 foreign-user 建的 "foreign"。
    默认轴把它滤掉 (上面已断言), machine 轴必须让它出现。
    """

    app = create_app(root, auth=False, ownership_axis=OWNERSHIP_AXIS_MACHINE)
    with TestClient(app) as client:
        check(
            "machine 轴落到 app.state 并让会话目录进入共享归属",
            getattr(app.state, OWNERSHIP_AXIS_STATE, "") == OWNERSHIP_AXIS_MACHINE
            and app.state.session_catalog.shared_ownership is True,
            str(getattr(app.state, OWNERSHIP_AXIS_STATE, "")),
        )

        async def readiness(*, executable: str = "") -> RuntimeReadiness:
            return RuntimeReadiness(
                runtime_id=RUNTIME_ID,
                status=RuntimeStatus.READY,
                ready=True,
                executable=executable or "codex",
                version="0.147.0",
                authenticated=True,
                process_state="ready",
            )

        app.state.runtime_service.readiness = readiness
        ids = []
        cursor = None
        for _ in range(100):
            payload = client.get(
                "/api/serve/sessions",
                params={"limit": 30, **({"cursor": cursor} if cursor else {})},
            ).json()
            ids.extend(row["session_id"] for row in payload.get("sessions", []))
            cursor = payload.get("next_cursor")
            if cursor is None:
                break
        check("machine 轴下别的账号建的会话可见", "foreign" in ids, str(ids))
        expected = {"oldest", "middle", "newest", "foreign", "project-a-2", "legacy-model"}
        expected.update(f"project-b-{index}" for index in range(4))
        expected.update(f"paged-{index:04d}" for index in range(505))
        check(
            "machine pagination reaches all sessions once",
            set(ids) == expected and len(set(ids)) == len(ids),
            f"count={len(ids)}; unique={len(set(ids))}; "
            f"missing={sorted(expected - set(ids))}; extra={sorted(set(ids) - expected)}",
        )


if __name__ == "__main__":
    raise SystemExit(main())
