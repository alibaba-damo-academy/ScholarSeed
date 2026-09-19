"""Desktop native-Codex session-list projection contract."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from typing import Any

_HOME = Path(tempfile.mkdtemp(prefix="session-list-home-"))
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
    root = Path(tempfile.mkdtemp(prefix="session-list-contract-")).resolve()
    app = create_app(root, auth=False)
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
    response = TestClient(app).get("/api/serve/sessions")
    payload = response.json()
    rows = payload.get("sessions", [])
    ids = [row["session_id"] for row in rows]
    check("serve session list responds", response.status_code == 200, response.text)
    check("product sessions are newest-to-oldest", ids == ["newest", "middle", "oldest"], str(ids))
    check(
        "creation timestamp is exposed to the desktop client",
        rows[0].get("created_at") == 3.0,
        str(rows[0]),
    )
    check("another principal is never listed", "foreign" not in ids, str(ids))
    check("session list reports the scoped total", payload.get("total") == 3, str(payload))
    search_response = TestClient(app).get(
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
        TestClient(app)
        .get(
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
        TestClient(app)
        .get(
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
        TestClient(app)
        .get(
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
    project_scopes(app, root, principal)
    machine_axis()
    print(f"\ncontract_session_listing: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


def project_scopes(app: Any, root: Path, principal: SessionPrincipal) -> None:
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

    client = TestClient(app)
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


def machine_axis() -> None:
    """bug 86043648 的回归锚点: machine 轴下换账号仍看得到别人建的会话。

    复用上面那个隔离 home 的同一个会话库 —— 里面已经有 foreign-user 建的 "foreign"。
    默认轴把它滤掉 (上面已断言), machine 轴必须让它出现。
    """

    root = Path(tempfile.mkdtemp(prefix="session-list-machine-")).resolve()
    app = create_app(root, auth=False, ownership_axis=OWNERSHIP_AXIS_MACHINE)
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
    ids = [
        row["session_id"]
        for row in TestClient(app).get("/api/serve/sessions").json().get("sessions", [])
    ]
    check("machine 轴下别的账号建的会话可见", "foreign" in ids, str(ids))


if __name__ == "__main__":
    raise SystemExit(main())
