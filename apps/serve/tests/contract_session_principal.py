"""Codex product-session principal ownership and route isolation contract.

Run: .venv/bin/python -m tests.contract_session_principal
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

_HOME = Path(tempfile.mkdtemp(prefix="session-principal-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from scholarseed_runtime.contract import CapabilitySet  # noqa: E402
from scholarseed_runtime.contract import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    RuntimeReadiness,
    RuntimeStatus,
)
from scholarseed_runtime.contract.history import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    HistoryEntry,
)
from scholarseed_runtime.contract.resource import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    RESOURCE_HOST_CONFIGURATION_CONFLICT,
)
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.api.sessions import mount_session_routes  # noqa: E402
from service.chat.constants import (  # noqa: E402
    PRODUCT_EVENT_SESSION_TITLE_UPDATED,
    SESSION_RENAME_MAX_LENGTH,
)
from service.chat.persistence.artifacts import SessionArtifactStore  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionAccessError,
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.runtime.composition import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    LiveSessionService,
)
from service.chat.service.artifacts import ArtifactService  # noqa: E402
from service.chat.service.sessions import SessionService, workspace_allows  # noqa: E402
from service.chat.service.workspaces import SessionWorkspaceService  # noqa: E402
from service.identity.api.routes import register_auth  # noqa: E402
from service.identity.persistence.tokens import issue_token  # noqa: E402
from service.identity.persistence.users import create_user  # noqa: E402
from service.identity.service.auth import AuthService  # noqa: E402
from service.identity.service.skill_credentials import (  # noqa: E402
    skill_credentials_from_env,
)
from service.identity.utils import (  # noqa: E402
    LOCAL_USER_ID,
    OWNERSHIP_AXIS_MACHINE,
    OWNERSHIP_AXIS_PRINCIPAL,
    OWNERSHIP_AXIS_STATE,
)
from service.platform.activity import Activities  # noqa: E402
from service.workbench.domain.model import WorkbenchFormatPolicy  # noqa: E402

PASS = 0
FAIL = 0
USER_A_EMAIL = "session-a@test.dev"
USER_B_EMAIL = "session-b@test.dev"
USER_PASSWORD = "secret1"
FOREIGN_ROUTE_CASES: tuple[tuple[str, str, dict[str, Any] | None], ...] = (
    ("put", "/api/serve/sessions/{session_id}/pin", {"pinned": True}),
    ("get", "/api/serve/history/{session_id}", None),
    ("get", "/api/serve/sessions/{session_id}/events", None),
    ("post", "/api/serve/sessions/{session_id}/turns", {"input": []}),
    ("post", "/api/serve/sessions/{session_id}/queue/queued-1/send", None),
    ("post", "/api/serve/sessions/{session_id}/hil/request-1", {"option_id": "yes"}),
    (
        "post",
        "/api/serve/sessions/{session_id}/turns/turn-1/confirm-unknown",
        {"decision": "continue_without_replay"},
    ),
    ("post", "/api/serve/sessions/{session_id}/interrupt", None),
    ("post", "/api/serve/sessions/{session_id}/attachments", None),
    ("post", "/api/serve/sessions/{session_id}/file-references", {"paths": []}),
    ("get", "/api/serve/sessions/{session_id}/mcp", None),
    ("get", "/api/serve/sessions/{session_id}/mcp/tools", None),
    ("get", "/api/serve/sessions/{session_id}/mcp/resources", None),
    ("post", "/api/serve/sessions/{session_id}/mcp/resources/read", {}),
    ("post", "/api/serve/sessions/{session_id}/mcp/reload", {}),
    ("post", "/api/serve/sessions/{session_id}/mcp/tools/call", {}),
    ("post", "/api/serve/sessions/{session_id}/mcp/login", {}),
    ("get", "/api/serve/sessions/{session_id}/mcp/prompts", None),
    ("post", "/api/serve/sessions/{session_id}/mcp/logout", {}),
    ("post", "/api/serve/sessions/{session_id}/mcp/trust", {}),
    ("delete", "/api/serve/sessions/{session_id}", None),
    ("patch", "/api/serve/sessions/{session_id}", {"title": "foreign rename"}),
    ("get", "/api/serve/sessions/{session_id}/model", None),
    ("post", "/api/serve/sessions/{session_id}/model", {"model_id": "deepseek-v4-pro"}),
    ("get", "/api/serve/sessions/{session_id}/mode", None),
    ("get", "/api/serve/sessions/{session_id}/workflow", None),
)


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


class _Models:
    def __init__(self) -> None:
        self.rebound: list[tuple[str, str]] = []

    def rebind_owner(self, session_id: str, user_id: str) -> int:
        self.rebound.append((session_id, user_id))
        return 1


class _Runtime:
    runtime_id = RUNTIME_ID
    gateway_capabilities = CapabilitySet()

    realign_metering_identity = LiveSessionService.realign_metering_identity

    def __init__(self) -> None:
        self._models = _Models()
        self._logger = SimpleNamespace(info=lambda *_args, **_kwargs: None)
        self.host_owner = ""

    @asynccontextmanager
    async def host_control(self, *, cwd: Path, user_id: str, model_id: str):
        if self.host_owner and user_id != self.host_owner:
            raise RuntimeError(RESOURCE_HOST_CONFIGURATION_CONFLICT)
        yield

    async def readiness(self, *, runtime_id: str = "", executable: str = "") -> RuntimeReadiness:
        return RuntimeReadiness(
            runtime_id=RUNTIME_ID,
            status=RuntimeStatus.READY,
            ready=True,
            executable=executable or "codex",
            version="0.147.0",
            authenticated=True,
            process_state="ready",
        )


class _Turns:
    async def post(
        self, _session_id: str, _body: dict[str, object], *, side: bool
    ) -> tuple[dict[str, object], int]:
        return {"ok": True, "side": side}, 200


class _Events:
    @staticmethod
    def portable_history(_session_id: str) -> tuple[HistoryEntry, ...]:
        return ()

    @staticmethod
    def activity_snapshot(_session_id: str) -> list[dict[str, object]]:
        return []

    @staticmethod
    def turn_activity_snapshot(_session_id: str) -> dict[str, object]:
        return {}

    @staticmethod
    def decorate_history(
        _session_id: str,
        turns: list[dict[str, object]],
    ) -> list[dict[str, object]]:
        return turns

    async def open(self, _session_id: str, _from_seq: int):
        # 空循环让本函数成为 async generator, 又不必用恒假条件。
        for _ in ():
            yield b""


def _record(
    access: SessionCatalogStore,
    workspace: Path,
    *,
    session_id: str,
    principal_id: str,
    created_at: float,
    status: SessionStatus = SessionStatus.READY,
) -> None:
    access.register(
        session_id,
        SessionPrincipal(principal_id),
        runtime_id=RUNTIME_ID,
        vendor_thread_id=f"vendor-{session_id}",
        vendor_session_id=None,
        runtime_workdir=str(workspace / session_id),
        project_path=None,
        output_root=str(workspace / session_id / "output"),
        codex_version="0.147.0",
        model_id="gpt-codex-native",
        policy_id="ask",
        status=status,
        title=session_id,
        created_at=created_at,
    )


def _app(
    workspace: Path,
    *,
    auth_enabled: bool,
    access_database: Path,
    ownership_axis: str = OWNERSHIP_AXIS_PRINCIPAL,
    live_sessions: dict[str, Any] | None = None,
    runtime: _Runtime | None = None,
) -> tuple[FastAPI, SessionCatalogStore]:
    app = FastAPI()
    app.state.auth_enabled = auth_enabled
    # 轴要同时落到 app.state (供 request_owner_id 读) 与 store 的 shared_ownership。两处
    # 必须一致: 只设其中一个会让 machine 轴静默失效 —— 归属身份变成机器级常量, 而 store
    # 仍按 principal_id 过滤, 于是一条都看不到。生产侧由 create_chat_app 一并设置。
    setattr(app.state, OWNERSHIP_AXIS_STATE, ownership_axis)
    access = SessionCatalogStore(
        access_database,
        shared_ownership=ownership_axis == OWNERSHIP_AXIS_MACHINE,
    )
    events = ProductEventStore(access_database)
    artifacts = SessionArtifactStore(access_database)
    sessions = SessionService(
        workspace,
        live_sessions if live_sessions is not None else {},
        activities=Activities(),
        access=access,
        events=events,
        runtime=runtime or _Runtime(),  # type: ignore[arg-type]
        workspaces=SessionWorkspaceService(workspace_allows),
        artifacts=artifacts,
        settings=SimpleNamespace(  # type: ignore[arg-type]
            runtime_executable=lambda: "codex",
            runtime_model=lambda: "",
            permission_mode=lambda: "ask",
        ),
        credentials=skill_credentials_from_env({}, activities=Activities()),
        logger=SimpleNamespace(error=lambda *_args, **_kwargs: None),
    )
    app.state.session_service = sessions
    sessions.bind_deletion(lambda _record: None)
    mount_session_routes(
        app,
        sessions=sessions,
        turns=_Turns(),  # type: ignore[arg-type]
        events=_Events(),  # type: ignore[arg-type]
        artifacts=ArtifactService(access, artifacts, events, WorkbenchFormatPolicy()),
        credentials=skill_credentials_from_env({}, activities=Activities()),
    )
    register_auth(app, enabled=auth_enabled, service=AuthService(), activities=Activities())
    return app, access


def _authorization(token: str) -> dict[str, str]:
    return {"authorization": f"Bearer {token}"}


def test_authenticated_isolation(workspace: Path) -> None:
    user_a = create_user(USER_A_EMAIL, USER_PASSWORD)
    user_b = create_user(USER_B_EMAIL, USER_PASSWORD)
    user_a_id = str(user_a["user_id"])
    user_b_id = str(user_b["user_id"])
    headers_a = _authorization(issue_token(user_a_id))
    headers_b = _authorization(issue_token(user_b_id))
    app, access = _app(
        workspace,
        auth_enabled=True,
        access_database=_HOME / "authenticated-sessions.sqlite3",
    )
    _record(access, workspace, session_id="session-a", principal_id=user_a_id, created_at=1.0)
    _record(
        access,
        workspace,
        session_id="session-b",
        principal_id=user_b_id,
        created_at=2.0,
        status=SessionStatus.WAITING_HIL,
    )
    client = TestClient(app)

    unguarded_routes = []
    for route in app.routes:
        path = str(getattr(route, "path", ""))
        if "{session_id}" not in path:
            continue
        dependency_names = {
            str(getattr(dependency.call, "__name__", ""))
            for dependency in getattr(getattr(route, "dependant", None), "dependencies", ())
        }
        if "require_session_access" not in dependency_names:
            unguarded_routes.append(path)
    check(
        "every product session-id HTTP route declares the shared guard",
        not unguarded_routes,
        str(unguarded_routes),
    )

    listed_a = client.get("/api/serve/sessions", headers=headers_a)
    listed_b = client.get("/api/serve/sessions", headers=headers_b)
    ids_a = {row["session_id"] for row in listed_a.json().get("sessions", [])}
    ids_b = {row["session_id"] for row in listed_b.json().get("sessions", [])}
    check(
        "session list cannot enumerate another principal",
        ids_a == {"session-a"} and ids_b == {"session-b"},
        f"a={ids_a}; b={ids_b}",
    )
    row_b = listed_b.json()["sessions"][0]
    check(
        "durable waiting state is visible only to its owner",
        row_b.get("waiting") is True and row_b.get("runtime_id") == RUNTIME_ID,
        str(row_b),
    )

    resume_foreign = client.post(
        "/api/serve/sessions/open",
        headers=headers_b,
        json={"resume_session_id": "session-a"},
    )
    check(
        "foreign resume is indistinguishable from a missing session",
        resume_foreign.status_code == 404
        and resume_foreign.json().get("error") == "session_not_found",
        resume_foreign.text,
    )

    denied: list[str] = []
    for method, path_template, body in FOREIGN_ROUTE_CASES:
        path = path_template.format(session_id="session-a")
        response = client.request(method, path, headers=headers_b, json=body)
        if response.status_code != 404 or response.json() != {
            "detail": "session not found",
            "code": "session_not_found",
        }:
            denied.append(f"{method} {path}: {response.status_code} {response.text}")
    check("all session routes share one non-enumerating guard", not denied, "; ".join(denied))

    renamed = client.patch(
        "/api/serve/sessions/session-a",
        headers=headers_a,
        json={"title": "Native Codex investigation"},
    )
    check(
        "owned rename persists in the product catalog",
        renamed.status_code == 200
        and (renamed_record := access.get("session-a")) is not None
        and renamed_record.title == "Native Codex investigation",
        renamed.text,
    )
    before_pin = access.get("session-a")
    for pinned in (True, True, False):
        response = client.put(
            "/api/serve/sessions/session-a/pin", headers=headers_a, json={"pinned": pinned}
        )
        record = access.get("session-a")
        check(
            "owned pin mutation is explicit, durable and activity-neutral",
            response.status_code == 200
            and response.json() == {"ok": True, "session_id": "session-a", "pinned": pinned}
            and record is not None
            and record.pinned is pinned
            and before_pin is not None
            and record.updated_at == before_pin.updated_at,
            response.text,
        )
    for body in ({}, {"pinned": "false"}, {"pinned": 0}, {"pinned": None}):
        response = client.put("/api/serve/sessions/session-a/pin", headers=headers_a, json=body)
        check("pin accepts strict booleans only", response.status_code == 422, response.text)
    missing_pin = client.put(
        "/api/serve/sessions/missing/pin", headers=headers_a, json={"pinned": True}
    )
    check("missing pin target is non-enumerating", missing_pin.status_code == 404, missing_pin.text)
    too_long = client.patch(
        "/api/serve/sessions/session-a",
        headers=headers_a,
        json={"title": "研" * (SESSION_RENAME_MAX_LENGTH + 1)},
    )
    check(
        "overlong titles fail without truncating durable state",
        too_long.status_code == 400
        and (kept_record := access.get("session-a")) is not None
        and kept_record.title == "Native Codex investigation",
        too_long.text,
    )

    deleted = client.delete("/api/serve/sessions/session-a", headers=headers_a)
    try:
        access.require("session-a", SessionPrincipal(user_a_id))
    except SessionAccessError:
        released = True
    else:
        released = False
    check("owned delete releases the durable binding", deleted.status_code == 200 and released)


def test_no_auth_local_principal(workspace: Path) -> None:
    app, access = _app(
        workspace,
        auth_enabled=False,
        access_database=_HOME / "local-sessions.sqlite3",
    )
    _record(access, workspace, session_id="local-session", principal_id="local", created_at=1.0)
    response = TestClient(app).get("/api/serve/sessions")
    rows: list[dict[str, Any]] = response.json().get("sessions", [])
    check(
        "no-auth traffic uses one stable local principal",
        response.status_code == 200
        and [row.get("session_id") for row in rows] == ["local-session"],
        response.text,
    )


def test_machine_axis_shares_local_data(workspace: Path) -> None:
    """machine 轴: 同机换账号后仍看得到、也动得了别人建的会话 (bug 86043648)。

    这里是唯一同时握有两个**不同真实账号**的地方, 所以也在这里钉住可逆性: 行上的
    principal_id 必须仍是建会话那个账号, 而不是被抹成机器级常量。
    """

    user_a_id = str(create_user("machine-a@test.dev", USER_PASSWORD)["user_id"])
    user_b_id = str(create_user("machine-b@test.dev", USER_PASSWORD)["user_id"])
    headers_b = _authorization(issue_token(user_b_id))
    app, access = _app(
        workspace,
        auth_enabled=True,
        access_database=_HOME / "machine-axis-sessions.sqlite3",
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
    )
    _record(access, workspace, session_id="session-a", principal_id=user_a_id, created_at=1.0)
    client = TestClient(app)

    listed = client.get("/api/serve/sessions", headers=headers_b)
    ids = [row.get("session_id") for row in listed.json().get("sessions", [])]
    check(
        "machine axis lets another account enumerate the machine's sessions",
        listed.status_code == 200 and ids == ["session-a"],
        listed.text,
    )

    renamed = client.patch(
        "/api/serve/sessions/session-a",
        headers=headers_b,
        json={"title": "换账号后改的标题"},
    )
    record = access.get("session-a")
    check(
        "machine axis lets another account address a session it did not create",
        renamed.status_code == 200 and record is not None and record.title == "换账号后改的标题",
        renamed.text,
    )
    check(
        "machine axis still records the creating account, keeping the axis reversible",
        record is not None and record.principal_id == user_a_id,
        str(record),
    )

    # 上方已断言"每条带 session_id 的路由都声明同一个 session_guard", 所以证明**守卫本身**
    # 对另一个账号放行即覆盖全部路由。这里不去逐条执行 23 个路由体: 那要求把 stub 全部补
    # 齐 (resolve_model 等), 会把归属契约耦合到无关的路由内部实现。HTTP 级放行由上面的
    # list/patch 与下面的 delete 三种方法各自证明。
    admitted = True
    try:
        app.state.require_owned_session_access("session-a", user_b_id)
    except SessionAccessError:
        admitted = False
    check(
        "machine axis makes the shared session guard admit another account",
        admitted,
        "guard still denied the machine's own session",
    )
    removed = client.delete("/api/serve/sessions/session-a", headers=headers_b)
    check(
        "machine axis lets another account delete a session it did not create",
        removed.status_code == 200 and access.get("session-a") is None,
        removed.text,
    )


def test_account_switch_moves_warm_session_metering(workspace: Path) -> None:
    """切号后, 热会话的出站计量身份必须跟到当前驱动它的账号 (401 invalid user token)。

    这是产品面的那一环: 会话在内存里活过一次切号, 出站 token 是按 live.user_id 去取的,
    身份不跟过去就会一直取已登出账号的槽位, 网关对每次模型调用回 401, 直到 serve 重启。
    """

    user_a_id = str(create_user("switch-a@test.dev", USER_PASSWORD)["user_id"])
    user_b_id = str(create_user("switch-b@test.dev", USER_PASSWORD)["user_id"])
    headers_b = _authorization(issue_token(user_b_id))
    warm = SimpleNamespace(
        id="session-warm",
        model_id="",
        runtime_workdir=workspace,
        closing=False,
        user_id=user_a_id,
        lifecycle_lock=asyncio.Lock(),
        terminating=False,
        terminated=False,
        publish=AsyncMock(),
    )
    untouched = SimpleNamespace(
        id="session-idle", user_id=user_a_id, model_id="", runtime_workdir=workspace
    )
    runtime = _Runtime()
    app, access = _app(
        workspace,
        auth_enabled=True,
        access_database=_HOME / "account-switch-sessions.sqlite3",
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
        live_sessions={"session-warm": warm, "session-idle": untouched},
        runtime=runtime,
    )
    _record(access, workspace, session_id="session-warm", principal_id=user_a_id, created_at=1.0)
    _record(access, workspace, session_id="session-idle", principal_id=user_a_id, created_at=2.0)
    client = TestClient(app)

    renamed = client.patch(
        "/api/serve/sessions/session-warm",
        headers=headers_b,
        json={"title": "切号后继续这个会话"},
    )
    check(
        "addressing a warm session moves its metering identity to the current account",
        renamed.status_code == 200 and warm.user_id == user_b_id,
        f"{renamed.status_code} {renamed.text}; user_id={warm.user_id}",
    )
    check(
        "the model bridge is re-pointed for that session only",
        runtime._models.rebound == [("session-warm", user_b_id)],
        str(runtime._models.rebound),
    )
    check(
        "a session the request did not address keeps its own identity",
        untouched.user_id == user_a_id,
        untouched.user_id,
    )

    # 幂等: 同一个账号再来一次不能重复重绑 —— 这条依赖挂在每个按会话寻址的路由上, 每个
    # turn 都会过, 重复重绑会把注册表搅成噪声。
    again = client.patch(
        "/api/serve/sessions/session-warm",
        headers=headers_b,
        json={"title": "同一账号再来一次"},
    )
    check(
        "re-addressing by the same account is a no-op",
        again.status_code == 200 and runtime._models.rebound == [("session-warm", user_b_id)],
        str(runtime._models.rebound),
    )
    check(
        "warm session renames still publish title updates after identity alignment",
        warm.publish.await_count == 2
        and warm.publish.await_args.args
        == (
            PRODUCT_EVENT_SESSION_TITLE_UPDATED,
            {"title": "同一账号再来一次", "title_fallback": None},
        ),
        str(warm.publish.await_args_list),
    )


def test_passive_requests_preserve_metering(workspace: Path) -> None:
    user_id = str(create_user("passive-account@test.dev", USER_PASSWORD)["user_id"])
    reader_id = str(create_user("passive-reader@test.dev", USER_PASSWORD)["user_id"])
    warm = SimpleNamespace(
        id="session-passive",
        closing=False,
        user_id=user_id,
        runtime_session=None,
        recover_publications=lambda: None,
        lifecycle_lock=asyncio.Lock(),
        terminating=False,
        terminated=False,
        publish=AsyncMock(),
    )
    runtime = _Runtime()
    app, access = _app(
        workspace,
        auth_enabled=False,
        access_database=_HOME / "passive-sessions.sqlite3",
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
        live_sessions={warm.id: warm},
        runtime=runtime,
    )
    _record(access, workspace, session_id=warm.id, principal_id=user_id, created_at=1.0)
    client = TestClient(app)
    for headers in ({}, _authorization(issue_token(reader_id))):
        response = client.get(f"/api/serve/history/{warm.id}", headers=headers)
        check(
            "history reads preserve the active model identity",
            response.status_code == 200
            and warm.user_id == user_id
            and runtime._models.rebound == [],
            f"status={response.status_code} actor={warm.user_id} rebound={runtime._models.rebound}",
        )
    response = client.patch(f"/api/serve/sessions/{warm.id}", json={"title": "local rename"})
    check(
        "anonymous local mutations do not replace the model account",
        response.status_code == 200 and warm.user_id == user_id and runtime._models.rebound == [],
        f"status={response.status_code} actor={warm.user_id} rebound={runtime._models.rebound}",
    )
    check(
        "local rename publishes the title without replacing model identity",
        warm.publish.await_count == 1
        and warm.publish.await_args.args
        == (
            PRODUCT_EVENT_SESSION_TITLE_UPDATED,
            {"title": "local rename", "title_fallback": None},
        ),
        str(warm.publish.await_args_list),
    )


def test_warm_resume_preserves_authenticated_identity(workspace: Path) -> None:
    user_id = str(create_user("resume-account@test.dev", USER_PASSWORD)["user_id"])
    next_user_id = str(create_user("resume-next@test.dev", USER_PASSWORD)["user_id"])
    warm = SimpleNamespace(
        id="session-resume",
        user_id=user_id,
        runtime_id=RUNTIME_ID,
        closing=False,
        model_id="",
        runtime_workdir=workspace,
    )
    runtime = _Runtime()
    app, access = _app(
        workspace,
        auth_enabled=False,
        access_database=_HOME / "resume-sessions.sqlite3",
        ownership_axis=OWNERSHIP_AXIS_MACHINE,
        live_sessions={warm.id: warm},
        runtime=runtime,
    )
    _record(access, workspace, session_id=warm.id, principal_id=user_id, created_at=1.0)
    client = TestClient(app)
    with patch.object(SessionService, "_snapshot", return_value={"session_id": warm.id}):
        for headers in ({}, _authorization("invalid-credential")):
            response = client.post(
                "/api/serve/sessions/open",
                headers=headers,
                json={"resume_session_id": warm.id},
            )
            check(
                "unverified warm resume preserves the model account",
                response.status_code == 200
                and warm.user_id == user_id
                and runtime._models.rebound == [],
                f"status={response.status_code} actor={warm.user_id}",
            )
        response = client.post(
            "/api/serve/sessions/open",
            headers=_authorization(issue_token(next_user_id)),
            json={"resume_session_id": warm.id},
        )
        check(
            "authenticated warm resume still switches accounts",
            response.status_code == 200
            and warm.user_id == next_user_id
            and runtime._models.rebound[-1:] == [(warm.id, next_user_id)],
        )


def test_anonymous_identity_cannot_rebind() -> None:
    runtime = _Runtime()
    warm = SimpleNamespace(
        id="identity-boundary",
        user_id="bound-account",
        running=True,
        model_id="",
        runtime_workdir=_HOME,
    )
    check(
        "anonymous alignment cannot downgrade a running session",
        not asyncio.run(runtime.realign_metering_identity(warm, LOCAL_USER_ID))
        and warm.user_id == "bound-account"
        and runtime._models.rebound == [],
    )
    warm.user_id = LOCAL_USER_ID
    check(
        "anonymous session can acquire an authenticated account",
        asyncio.run(runtime.realign_metering_identity(warm, "authenticated-account"))
        and warm.user_id == "authenticated-account",
    )


async def test_directory_preparation_yields_and_keeps_lock(workspace: Path) -> None:
    app, _access = _app(
        workspace, auth_enabled=False, access_database=_HOME / "directory-preparation.sqlite3"
    )
    service = app.state.session_service
    started = threading.Event()
    release = threading.Event()

    def prepare(*_args):
        started.set()
        if not release.wait(5):
            raise ValueError("directory preparation blocked event loop")
        raise ValueError("directory preparation finished")

    with patch.object(service, "_new_paths", side_effect=prepare):
        opened = asyncio.create_task(
            service.open({}, SessionPrincipal(LOCAL_USER_ID), actor_id=LOCAL_USER_ID)
        )
        try:
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            check(
                "directory preparation yields to the event loop",
                started.is_set() and not opened.done(),
            )
            opened.cancel()
            await asyncio.sleep(0.02)
            check(
                "cancelled create retains serialization until disk work ends",
                not opened.done() and service._open_lock.locked(),
            )
        finally:
            release.set()
            try:
                await opened
            except asyncio.CancelledError:
                pass
        check("directory completion releases serialization", not service._open_lock.locked())


def main() -> int:
    workspace = Path(tempfile.mkdtemp(prefix="session-principal-workspace-")).resolve()
    test_authenticated_isolation(workspace)
    test_no_auth_local_principal(workspace)
    test_machine_axis_shares_local_data(workspace)
    test_account_switch_moves_warm_session_metering(workspace)
    test_passive_requests_preserve_metering(workspace)
    test_warm_resume_preserves_authenticated_identity(workspace)
    test_anonymous_identity_cannot_rebind()
    asyncio.run(test_directory_preparation_yields_and_keeps_lock(workspace))
    print(f"\ncontract_session_principal: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


def test_incompatible_host_preserves_identity() -> None:
    runtime = _Runtime()
    runtime.host_owner = "bound-account"
    warm = SimpleNamespace(
        id="identity-pinned", user_id="bound-account", model_id="", runtime_workdir=_HOME
    )
    try:
        asyncio.run(runtime.realign_metering_identity(warm, "other-account"))
    except RuntimeError as error:
        check(
            "incompatible account returns explicit conflict",
            str(error) == RESOURCE_HOST_CONFIGURATION_CONFLICT,
        )
    else:
        check("incompatible account returns explicit conflict", False)
    check(
        "rejected identity does not mutate live session or model registration",
        warm.user_id == "bound-account" and runtime._models.rebound == [],
    )


if __name__ == "__main__":
    raise SystemExit(main())
