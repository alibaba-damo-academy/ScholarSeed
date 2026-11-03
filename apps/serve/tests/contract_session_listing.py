"""Desktop native-Codex session-list projection contract."""

from __future__ import annotations

import argparse
import base64
import json
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
from service.chat.persistence.catalog import (  # noqa: E402
    SessionPrincipal,
    SessionStatus,
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
        response = client.get("/api/serve/sessions")
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
        reply_rows = client.get(
            "/api/serve/sessions", params={"include_last_agent_reply": "true"}
        ).json()["sessions"]
        reply_times = {row["session_id"]: row.get("last_agent_reply_at") for row in reply_rows}
        entered = Event()
        release = Event()
        original_reply = app.state.product_events.last_agent_reply_at

        def delayed_reply(session_id: str) -> float | None:
            entered.set()
            if not release.wait(10):
                raise TimeoutError("history probe was not released")
            return original_reply(session_id)

        with (
            patch.object(app.state.product_events, "last_agent_reply_at", delayed_reply),
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
    archived_id = "project-a-2"
    archived = client.put(f"/api/serve/sessions/{archived_id}/archive", json={"archived": True})
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
    ):
        response = client.request(method, path, json=body)
        check(
            "archived conversation mutations are rejected: " + method, response.status_code == 409
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
        check(
            "machine pagination reaches all sessions once",
            len(ids) == 516 and len(set(ids)) == len(ids),
        )


if __name__ == "__main__":
    raise SystemExit(main())
