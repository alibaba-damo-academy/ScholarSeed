"""会话对齐契约 —— key 被轮换后, 旧会话怎么迁到新 env（proposal 42）。

env 在子进程启动时固化，换 key 需要安全释放旧 attachment，并在下次准入恢复同一 thread。
这套件验证选择、生效、延迟准入之间的边界:

1. 缓存与会话 env 一致 → 不动 (每个 turn 前都会问一次, 一致就必须零成本)。
2. 不一致且空闲 → 重开到新 env。
3. 不一致但 turn 正在跑 → 不打断, 留给下一个 turn。
4. 会话不在本进程 (未 attach) → 不动。
5. 越权/他人会话 → 批量对齐时跳过。
6. 凭据重开失败 → 拒绝准入，不允许沿用旧授权。

跑法: uv run python -m tests.contract_session_align
"""

# 隔离必须先于 first-party import 落地 —— 路径常量在 import 期即求值。
# pylint: disable=wrong-import-position

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from service.platform.activity import Activities, ActivityDomain, ActivityPhase, MaintenanceActive

os.environ["SCHOLARSEED_HOME"] = tempfile.mkdtemp(prefix="align-home-")

from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from typing import Any  # noqa: E402

from scholarseed_runtime.contract import (  # noqa: E402
    AppliedState,
    CommandState,
    ModelIntent,
    RuntimePermissionMode,
)
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    ProductEventStore,
)
from service.chat.runtime.composition import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    LiveSessionService,
)
from service.chat.runtime.live import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    LiveSession,
)
from service.chat.service.models import SessionModelUnavailableError  # noqa: E402
from service.chat.service.sessions import (  # noqa: E402
    PRODUCT_PERMISSION_MODES,
    SESSION_WRITABLE_ROOTS_CHANGED_ERROR,
    SessionService,
    workspace_allows,
)
from service.chat.service.settings import SettingsService  # noqa: E402
from service.chat.service.workspaces import SessionWorkspaceService  # noqa: E402
from service.identity.service.skill_credentials import SKILL_API_KEY_ENV  # noqa: E402

PASS = 0
FAIL = 0

OWNER = SessionPrincipal(user_id="owner-a")
STRANGER = SessionPrincipal(user_id="owner-b")
# 故意与 OWNER.user_id 不同: 凭据缓存按**真实账号身份**键控, 归属 principal 可以是机器级的。
# 一旦实现退回用 principal.user_id 去读缓存, 下面的断言就会抓到。
ACTOR_ID = "acct-owner-a"
SESSION_ID = "session-align"
FOREIGN_ID = "session-foreign"
CURRENT = {SKILL_API_KEY_ENV: "ssk-current"}
STALE = {SKILL_API_KEY_ENV: "ssk-stale"}


def _native_policy(mode: str) -> tuple[str, str, str]:
    if mode == RuntimePermissionMode.BYPASS.value:
        return "danger-full-access", "never", ""
    reviewer = "auto_review" if mode == RuntimePermissionMode.SAFE_AUTO.value else "user"
    return "workspace-write", "on-request", reviewer


class _PermissionSession:
    def permission_update_scope(self, intent):
        return (
            "turn"
            if _native_policy(self.mode.value)[:2] == _native_policy(intent.mode.value)[:2]
            else "next_turn"
        )

    def __init__(self) -> None:
        self.mode = RuntimePermissionMode.ASK
        self.model_switches: list[str] = []
        self.writable_roots: tuple[Path, ...] = ()
        self.local_sockets: tuple[Path, ...] = ()
        self.network_domains: tuple[str, ...] = ()

    async def reconfigure(self, request: Any) -> AppliedState:
        if request.model is not None:
            return AppliedState(request.revision, "", CommandState.RESTART_REQUIRED)
        target = request.permission.mode
        if self.mode is target or target is RuntimePermissionMode.SAFE_AUTO:
            self.mode = target
            self.writable_roots = request.permission.writable_roots
            self.local_sockets = request.permission.local_sockets
            self.network_domains = request.permission.network_domains
            return AppliedState(request.revision, request.revision, CommandState.APPLIED)
        return AppliedState(request.revision, "", CommandState.RESTART_REQUIRED)


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


class _Credentials:
    """只回答「当前有效的那份 env 是什么」——真实实现里这是纯内存投影。"""

    def __init__(self, environment: dict[str, str]) -> None:
        self.environment = environment
        self.requested: list[str] = []

    def cached_environment(self, user_id: str) -> dict[str, str]:
        self.requested.append(user_id)
        return dict(self.environment)

    async def admission_environment(self, user_id: str) -> dict[str, str]:
        return self.cached_environment(user_id)


class _Live:
    permission_intent = LiveSession.permission_intent

    def __init__(
        self,
        *,
        environment: dict[str, str],
        running: bool = False,
        user_id: str = ACTOR_ID,
    ) -> None:
        self.id = SESSION_ID
        self.model_id = "gpt-5-codex"
        self.reasoning_effort = ""
        self.thinking = None
        self.vendor_thread_id = f"thread-{SESSION_ID}"
        self.process_environment = dict(environment)
        self.running = running
        self.active_product_turn_id = ""
        self.user_id = user_id
        self.applied_permission_mode = RuntimePermissionMode.ASK.value
        self.permission_switch_warning = ""
        self.skill_configurations = ()
        self.runtime_session = _PermissionSession()
        self.runtime_binding = object()
        self.runtime_driver = None
        self.project_path = None
        self.suspensions = 0
        self.writable_roots: tuple[Path, ...] = ()
        self.local_socket = None
        self.network_domains = ()
        self.lifecycle_lock = asyncio.Lock()

    async def suspend_runtime(self) -> bool:
        if self.running:
            return False
        self.suspensions += 1
        self.runtime_session = None
        return True

    def retarget_environment(self, environment: Any) -> None:
        self.process_environment = dict(environment or {})

    def rebind_vendor_thread(self, vendor_thread_id: str) -> None:
        self.vendor_thread_id = vendor_thread_id


class _Runtime:
    """记账用的假 LiveSessionService。"""

    def __init__(self, *, fail: bool = False) -> None:
        self.runtime_id = "codex-appserver"
        self.realigned: list[dict[str, str]] = []
        self.policies: list[tuple[str, str, str]] = []
        self.model_switches: list[str] = []
        self.selection_actors: list[str] = []
        self.quiescence_deadlines: list[float | None] = []
        self.catalog: SessionCatalogStore | None = None
        self._fail = fail

    def held_binding_state(self, session_id: str) -> dict[str, object]:
        return {"bridge_backed": False, "bridge_id": "", "alive": False}

    async def skill_configurations(
        self, *, cwd: Path, user_id: str, model_id: str = "", process_environment=None
    ) -> tuple:
        return ()

    async def wait_until_suspended(
        self,
        live: _Live,
        *,
        deadline: float | None = None,
    ) -> None:
        self.quiescence_deadlines.append(deadline)
        while not await live.suspend_runtime():
            await asyncio.sleep(0)

    @staticmethod
    def resolve_model(
        model_id: str,
        *,
        user_id: str = "",
        session_id: str = "",
        reasoning_effort: str = "",
        thinking: Any = None,
    ) -> SimpleNamespace:
        if not model_id.strip():
            raise ValueError("model is required")
        key = model_id.strip()
        return SimpleNamespace(
            key=key,
            runtime_model=lambda *_args: (
                ModelIntent(
                    model_ref=key, revision=f"model:{key}", reasoning_effort=reasoning_effort
                ),
                None,
            ),
        )

    def selected_model_key(self, model_id: str, *, user_id: str = "") -> str:
        self.selection_actors.append(user_id)
        if not model_id.strip():
            raise ValueError("model is required")
        return model_id.strip()

    async def validate_effort(self, model_id: str, effort: str, *, user_id: str) -> None:
        pass

    async def realign_environment(
        self,
        live: _Live,
        *,
        model_id: str,
        process_environment: dict[str, str],
        **_options: Any,
    ) -> bool:
        # Exercise the production lazy retarget path, preserving the same native binding.
        changed = await LiveSessionService.realign_environment(
            self, live, model_id=model_id, process_environment=process_environment
        )
        self.realigned.append(dict(process_environment))
        return changed

    async def ensure_active(self, live: _Live, **_options: Any) -> None:
        if live.runtime_session is not None:
            return
        if self._fail:
            raise RuntimeError("app server refused to resume")
        assert self.catalog is not None
        record = self.catalog.get(live.id)
        assert record is not None
        state = self.catalog.model_state(live.id)
        selected = state.selected_model_id
        self.policies.append(_native_policy(record.policy_id or "ask"))
        live.runtime_session = _PermissionSession()
        live.runtime_session.mode = RuntimePermissionMode(record.policy_id)
        permission = live.permission_intent(RuntimePermissionMode(record.policy_id))
        live.runtime_session.writable_roots = permission.writable_roots
        live.runtime_session.local_sockets = permission.local_sockets
        live.runtime_session.network_domains = permission.network_domains
        live.applied_permission_mode = record.policy_id
        if self.catalog.model_state(live.id).active_model_id != selected:
            self.model_switches.append(selected)
        live.runtime_session.model_switches = self.model_switches
        live.model_id = selected
        live.reasoning_effort = state.selected_reasoning_effort
        self.catalog.apply_model(
            live.id, selected, reasoning_effort=live.reasoning_effort, preserve_selection=True
        )


def _service(
    live: _Live | None,
    credentials: _Credentials,
    *,
    runtime: _Runtime | None = None,
) -> tuple[SessionService, _Runtime, SessionCatalogStore]:
    root = Path(tempfile.mkdtemp(prefix="align-ws-"))
    catalog = SessionCatalogStore(root / "catalog.sqlite3")
    for session_id, principal in ((SESSION_ID, OWNER), (FOREIGN_ID, STRANGER)):
        catalog.register(
            session_id,
            principal,
            runtime_id="codex-appserver",
            vendor_thread_id=f"thread-{session_id}",
            vendor_session_id=None,
            runtime_workdir=str(root),
            project_path=None,
            output_root=str(root),
            codex_version=None,
            model_id="gpt-5-codex",
            policy_id="ask",
            status=SessionStatus.READY,
            title="t",
            created_at=0.0,
        )
    sessions: dict[str, Any] = {} if live is None else {SESSION_ID: live}
    engine = runtime or _Runtime()
    engine.catalog = catalog
    if live is not None:
        live.runtime_workdir = root
        live.project_path = None
    if live is not None and live.runtime_session is not None:
        live.runtime_session.model_switches = engine.model_switches
    service = SessionService(
        root,
        sessions,
        activities=Activities(),
        access=catalog,
        events=ProductEventStore(catalog.database),
        runtime=engine,  # type: ignore[arg-type]
        workspaces=SessionWorkspaceService(workspace_allows),
        artifacts=SimpleNamespace(),  # type: ignore[arg-type]
        settings=SettingsService(),
        credentials=credentials,  # type: ignore[arg-type]
        logger=SimpleNamespace(error=lambda *_a, **_k: None),
    )
    return service, engine, catalog


def test_matching_environment_is_untouched() -> None:
    print("[1] 缓存与会话 env 一致 → 不重开（turn 前判定必须零成本）")
    live = _Live(environment=CURRENT)
    service, runtime, _catalog = _service(live, _Credentials(CURRENT))
    migrated = asyncio.run(service.align_skill_environment(SESSION_ID))
    check("不报告迁移", migrated is False)
    check("没有重开 vendor thread", runtime.realigned == [], str(runtime.realigned))


def test_stale_environment_migrates() -> None:
    print("[2] 会话带着被轮换掉的旧 env → 迁到新 env")
    live = _Live(environment=STALE)
    credentials = _Credentials(CURRENT)
    service, runtime, _catalog = _service(live, credentials)
    migrated = asyncio.run(service.align_skill_environment(SESSION_ID))
    check("报告迁移", migrated is True)
    check("按当前有效 env 保存准入目标", runtime.realigned == [CURRENT], str(runtime.realigned))
    check(
        "释放旧 attachment 后保持原 native thread",
        live.runtime_session is None and live.vendor_thread_id == f"thread-{SESSION_ID}",
    )
    check("会话 env 已换新", live.process_environment == CURRENT, str(live.process_environment))
    check(
        "凭据按真实账号身份查询, 不是归属 principal",
        credentials.requested == [ACTOR_ID, ACTOR_ID],
        str(credentials.requested),
    )


def test_running_turn_is_not_interrupted() -> None:
    print("[3] turn 正在跑 → 不打断，留给下一个 turn")
    live = _Live(environment=STALE, running=True)
    service, runtime, _catalog = _service(live, _Credentials(CURRENT))
    migrated = asyncio.run(service.align_skill_environment(SESSION_ID))
    check("不迁移", migrated is False)
    check("没有重开", runtime.realigned == [], str(runtime.realigned))
    check("会话 env 保持原样", live.process_environment == STALE, str(live.process_environment))


def test_absent_session_is_noop() -> None:
    print("[4] 会话不在本进程 → 不动（resume 时自然会拿当前 env）")
    service, runtime, _catalog = _service(None, _Credentials(CURRENT))
    migrated = asyncio.run(service.align_skill_environment(SESSION_ID))
    check("不迁移且不重开", migrated is False and runtime.realigned == [])


def test_batch_alignment_scopes_to_owner() -> None:
    print("[5] 批量对齐只碰本人会话")
    live = _Live(environment=STALE)
    service, runtime, _catalog = _service(live, _Credentials(CURRENT))
    aligned = asyncio.run(service.align_owned_skill_environments(OWNER))
    check("本人的会话被对齐", aligned == 1 and runtime.realigned == [CURRENT], str(aligned))
    other_live = _Live(environment=STALE)
    service2, runtime2, _c2 = _service(other_live, _Credentials(CURRENT))
    aligned2 = asyncio.run(service2.align_owned_skill_environments(STRANGER))
    check(
        "他人调用时一个都不碰",
        aligned2 == 0 and runtime2.realigned == [],
        f"{aligned2} {runtime2.realigned}",
    )


def test_realign_failure_blocks_turn() -> None:
    print("[6] 凭据重开失败拒绝准入")
    live = _Live(environment=STALE)
    service, _runtime, _catalog = _service(
        live,
        _Credentials(CURRENT),
        runtime=_Runtime(fail=True),
    )
    check("凭据撤销先释放旧 attachment", asyncio.run(service.align_skill_environment(SESSION_ID)))
    for _ in range(2):
        with unittest.TestCase().assertRaisesRegex(RuntimeError, "refused to resume"):
            asyncio.run(service.prepare_turn(live))
    check(
        "重复准入均失败且不恢复旧授权",
        live.runtime_session is None and live.process_environment == CURRENT,
    )


def test_idle_session_permission_mode_switches_runtime_policy() -> None:
    print("[7] 空闲会话切权限 → 重开 runtime 并持久化 policy")
    live = _Live(environment=CURRENT)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "bypassPermissions"))
    record = catalog.get(SESSION_ID)
    check(
        "HTTP 200 成功", status == 200 and payload.get("mode") == "bypassPermissions", str(payload)
    )
    check("持久化新 policy", record is not None and record.policy_id == "bypassPermissions")
    check(
        "runtime 用完全访问策略重开",
        runtime.policies == [("danger-full-access", "never", "")],
        str(runtime.policies),
    )


def test_running_session_safe_auto_switch_defers_to_turn_boundary() -> None:
    print("[8] 运行中切替我审批 → 记下选择, 下一 turn 边界恢复原 thread")
    live = _Live(environment=CURRENT, running=True)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "safe_auto"))
    record = catalog.get(SESSION_ID)
    check(
        "HTTP 200 返回当前轮次已应用状态",
        status == 200
        and payload.get("mode") == "safe_auto"
        and payload.get("active_mode") == "safe_auto"
        and payload.get("deferred") is False,
        str(payload),
    )
    check("不打断当前 turn", runtime.policies == [], str(runtime.policies))
    check("选择已保存", record is not None and record.policy_id == "safe_auto")
    live.running = False
    asyncio.run(service.prepare_turn(live))  # type: ignore[arg-type]
    check(
        "下一 turn 前启用 Codex 自动复核",
        runtime.policies == [] and live.runtime_session.mode is RuntimePermissionMode.SAFE_AUTO,
        str(runtime.policies),
    )


def test_running_session_bypass_switch_defers_to_turn_boundary() -> None:
    print("[8b] 运行中切到完全访问 → 记下选择, 下一 turn 边界重开")
    live = _Live(environment=CURRENT, running=True)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    payload, status = asyncio.run(
        service.set_mode(SESSION_ID, OWNER, "bypassPermissions", application="next_turn")
    )
    record = catalog.get(SESSION_ID)
    check(
        "HTTP 200 返回延迟生效状态",
        status == 200
        and payload.get("mode") == "bypassPermissions"
        and payload.get("active_mode") == "ask"
        and payload.get("deferred") is True,
        str(payload),
    )
    check("不打断当前 turn", runtime.policies == [], str(runtime.policies))
    check("选择已保存", record is not None and record.policy_id == "bypassPermissions")
    live.running = False
    asyncio.run(service.prepare_turn(live))  # type: ignore[arg-type]
    check(
        "下一 turn 前用完全访问策略重开一次",
        runtime.policies == [("danger-full-access", "never", "")],
        str(runtime.policies),
    )
    check("重开后不再漂移", live.applied_permission_mode == "bypassPermissions")
    asyncio.run(service.prepare_turn(live))  # type: ignore[arg-type]
    check("已生效则不再重开", len(runtime.policies) == 1, str(runtime.policies))


def test_waiting_approval_defers_permission_switch() -> None:
    print("[8c] 等待审批时切权限 → 保存选择但不改变当前审批")
    live = _Live(environment=CURRENT, running=True)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    catalog.record_hil(
        product_request_id="approval-request",
        session_id=SESSION_ID,
        vendor_request_id="approval-request",
        vendor_turn_id="turn-running",
        vendor_item_id="item-running",
        method="permission",
        payload={"kind": "permission"},
    )
    payload, status = asyncio.run(
        service.set_mode(SESSION_ID, OWNER, "bypassPermissions", application="next_turn")
    )
    record = catalog.get(SESSION_ID)
    check(
        "HTTP 200 返回下一轮生效",
        status == 200
        and payload.get("mode") == "bypassPermissions"
        and payload.get("active_mode") == "ask"
        and payload.get("deferred") is True,
        str(payload),
    )
    check("不打断当前审批", runtime.policies == [], str(runtime.policies))
    check("权限选择已保存", record is not None and record.policy_id == "bypassPermissions")
    check("审批仍待处理", len(catalog.pending_hil(SESSION_ID)) == 1)


def test_pending_question_defers_permission_switch() -> None:
    print("[8d] 等待提问时切权限 → 保存选择但不改变当前提问")
    live = _Live(environment=CURRENT, running=True)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    catalog.record_hil(
        product_request_id="question-request",
        session_id=SESSION_ID,
        vendor_request_id="question-request",
        vendor_turn_id="turn-running",
        vendor_item_id="item-running",
        method="user_input",
        payload={"kind": "question"},
    )
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "safe_auto"))
    record = catalog.get(SESSION_ID)
    check(
        "HTTP 200 返回后续步骤生效",
        status == 200
        and payload.get("mode") == "safe_auto"
        and payload.get("active_mode") == "safe_auto"
        and payload.get("deferred") is False,
        str(payload),
    )
    check("不打断当前提问", runtime.policies == [], str(runtime.policies))
    check("权限选择已保存", record is not None and record.policy_id == "safe_auto")
    check("提问仍待处理", len(catalog.pending_hil(SESSION_ID)) == 1)


def test_pending_interaction_without_running_defers_permission_switch() -> None:
    print("[8e] 前端状态尚未同步时切权限 → 不即时重配运行时")
    live = _Live(environment=CURRENT)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    catalog.record_hil(
        product_request_id="pending-request",
        session_id=SESSION_ID,
        vendor_request_id="pending-request",
        vendor_turn_id="turn-running",
        vendor_item_id="item-running",
        method="permission",
        payload={"kind": "permission"},
    )
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "safe_auto"))
    check(
        "HTTP 200 返回延迟生效",
        status == 200
        and payload.get("mode") == "safe_auto"
        and payload.get("active_mode") == "ask"
        and payload.get("deferred") is True,
        str(payload),
    )
    check("待处理交互期间不重配", runtime.policies == [], str(runtime.policies))


def test_permission_switch_failure_is_not_reported_as_running() -> None:
    live = _Live(environment=STALE)
    service, runtime, catalog = _service(live, _Credentials(CURRENT), runtime=_Runtime(fail=True))
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "bypassPermissions"))
    check(
        "恢复失败返回真实错误类别",
        status == 500 and payload.get("error") == "session_permission_switch_failed",
        str(payload),
    )
    stored = catalog.get(SESSION_ID)
    assert stored is not None
    check("失败保留待生效权限选择", stored.policy_id == "bypassPermissions")
    check(
        "失败响应区分选择与实际生效状态",
        payload.get("mode") == "bypassPermissions"
        and payload.get("active_mode") == ""
        and payload.get("deferred") is False,
        str(payload),
    )
    with unittest.TestCase().assertRaisesRegex(RuntimeError, "refused to resume"):
        asyncio.run(service.prepare_turn(live))
    check(
        "下一 turn 无法绕过未成功的权限准入",
        live.runtime_session is None and live.process_environment == CURRENT,
    )
    check("错误详情不泄露引擎异常", "app server refused" not in str(payload))


def test_permission_downgrade_uses_current_authorization() -> None:
    live = _Live(environment=STALE)
    live.applied_permission_mode = "bypassPermissions"
    live.runtime_session.mode = RuntimePermissionMode.BYPASS
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    catalog.set_policy(SESSION_ID, OWNER, "bypassPermissions")
    payload, status = asyncio.run(service.set_mode(SESSION_ID, OWNER, "safe_auto"))
    check("完全访问降级成功", status == 200 and payload.get("mode") == "safe_auto")
    check("权限降级同时采用当前有效凭据", live.process_environment == CURRENT)
    check("权限降级不回退到宽松旧选择", catalog.get(SESSION_ID).policy_id == "safe_auto")
    check(
        "运行时切为自动复核策略",
        runtime.policies == [("workspace-write", "on-request", "auto_review")],
    )


class PermissionActivationTests(unittest.IsolatedAsyncioTestCase):
    async def test_selecting_active_mode_cancels_next_turn_without_runtime_update(self) -> None:
        for active in (RuntimePermissionMode.ASK, RuntimePermissionMode.SAFE_AUTO):
            for pending in (False, True):
                with self.subTest(active=active, pending=pending):
                    live = _Live(environment=CURRENT, running=True)
                    live.applied_permission_mode = active.value
                    live.runtime_session.mode = active
                    service, runtime, catalog = _service(live, _Credentials(CURRENT))
                    catalog.set_policy(SESSION_ID, OWNER, active.value)
                    if pending:
                        catalog.record_hil(
                            product_request_id="approval-request",
                            session_id=SESSION_ID,
                            vendor_request_id="approval-request",
                            vendor_turn_id="turn-running",
                            vendor_item_id="item-running",
                            method="permission",
                            payload={"kind": "permission"},
                        )
                    hil_before = catalog.pending_hil(SESSION_ID)
                    thread_before = live.vendor_thread_id
                    live.runtime_session.reconfigure = AsyncMock(
                        side_effect=RuntimeError("unchanged permissions must not reach runtime")
                    )
                    deferred, status = await service.set_mode(
                        SESSION_ID, OWNER, "bypassPermissions", application="next_turn"
                    )
                    self.assertEqual(status, 200)
                    self.assertTrue(deferred["next_turn_selected"])
                    for repeat in range(2):
                        result, status = await service.set_mode(SESSION_ID, OWNER, active.value)
                        self.assertEqual(status, 200)
                        self.assertTrue(result["ok"])
                        self.assertEqual(result["mode"], active.value)
                        self.assertEqual(result["active_mode"], active.value)
                        self.assertFalse(result["next_turn_selected"])
                        self.assertFalse(result["deferred"])
                        self.assertEqual(result["switch_warning"], "")
                        self.assertNotIn("continuation", result)
                    live.runtime_session.reconfigure.assert_not_awaited()
                    self.assertTrue(live.running)
                    self.assertEqual(live.vendor_thread_id, thread_before)
                    self.assertEqual(catalog.pending_hil(SESSION_ID), hil_before)
                    self.assertIsNone(
                        SessionCatalogStore(catalog.database).get(SESSION_ID).next_turn_mode
                    )
                    self.assertEqual(runtime.policies, [])

    async def test_permission_switch_rejected_during_drain_before_side_effects(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        service._activities.begin()
        with self.assertRaises(MaintenanceActive):
            await service.set_mode(SESSION_ID, OWNER, "safe_auto")
        self.assertEqual(catalog.get(SESSION_ID).policy_id, "ask")
        self.assertEqual(live.applied_permission_mode, "ask")
        self.assertEqual(runtime.policies, [])

    async def test_permission_switch_cancellation_keeps_execution_until_confirmed(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, _runtime, catalog = _service(live, _Credentials(CURRENT))
        entered, release = asyncio.Event(), asyncio.Event()
        original = service._apply_permission_intent

        async def delayed(*args):
            entered.set()
            await release.wait()
            return await original(*args)

        with patch.object(service, "_apply_permission_intent", delayed):
            operation = asyncio.create_task(service.set_mode(SESSION_ID, OWNER, "safe_auto"))
            await entered.wait()
            service._activities.begin()
            drained = asyncio.create_task(service._activities.wait_execution_drained())
            operation.cancel()
            await asyncio.sleep(0)
            operation.cancel()
            await asyncio.sleep(0)
            self.assertFalse(operation.done())
            self.assertFalse(drained.done())
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await operation
            await asyncio.wait_for(drained, 1)
        self.assertEqual(catalog.get(SESSION_ID).policy_id, "safe_auto")
        self.assertEqual(live.applied_permission_mode, "safe_auto")

    async def test_non_live_auto_requires_confirmation_without_persisting(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, _runtime, catalog = _service(live, _Credentials(CURRENT))
        result, status = await service.set_mode(SESSION_ID, OWNER, "bypassPermissions")
        self.assertEqual(status, 409)
        self.assertEqual(result["error"], "session_permission_confirmation_required")
        self.assertEqual(catalog.get(SESSION_ID).policy_id, "ask")
        self.assertEqual(live.applied_permission_mode, "ask")

    async def test_only_explicit_next_turn_selection_is_projected_and_persisted(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, _runtime, catalog = _service(live, _Credentials(CURRENT))
        self.assertIn("safe_auto", service.mode(SESSION_ID)["current_turn_modes"])
        self.assertNotIn("bypassPermissions", service.mode(SESSION_ID)["current_turn_modes"])
        result, status = await service.set_mode(
            SESSION_ID, OWNER, "bypassPermissions", application="next_turn"
        )
        self.assertEqual(status, 200)
        self.assertTrue(result["next_turn_selected"])
        reopened = SessionCatalogStore(catalog.database)
        self.assertEqual(reopened.get(SESSION_ID).next_turn_mode, "bypassPermissions")
        catalog.set_policy(SESSION_ID, OWNER, "safe_auto")
        self.assertTrue(service.mode(SESSION_ID)["deferred"])
        self.assertFalse(service.mode(SESSION_ID)["next_turn_selected"])

    async def test_unbound_permission_is_not_deferred(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, _runtime, catalog = _service(live, _Credentials(CURRENT))
        live.applied_permission_mode = ""
        for selected in PRODUCT_PERMISSION_MODES:
            catalog.set_policy(SESSION_ID, OWNER, selected)
            projection = service.mode(SESSION_ID)
            self.assertEqual(projection["active_mode"], "")
            self.assertFalse(projection["deferred"])
        live.applied_permission_mode = RuntimePermissionMode.ASK.value
        catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.SAFE_AUTO.value)
        self.assertTrue(service.mode(SESSION_ID)["deferred"])
        catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.ASK.value)
        self.assertFalse(service.mode(SESSION_ID)["deferred"])

    async def test_mode_change_preserves_product_permissions(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        live.local_socket = Path("/permission-capability.sock")
        live.network_domains = ("scholarseed.damo.alibaba.com",)
        service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
        live.writable_roots = (live.runtime_workdir / "granted",)
        captured = []
        original = live.runtime_session.reconfigure

        async def record(request):
            captured.append(request.permission)
            return await original(request)

        live.runtime_session.reconfigure = record
        result, status = await service.set_mode(SESSION_ID, OWNER, "safe_auto")
        self.assertEqual(status, 200)
        self.assertFalse(result["deferred"])
        self.assertEqual(len(captured), 1)
        self.assertIs(captured[0].mode, RuntimePermissionMode.SAFE_AUTO)
        self.assertEqual(captured[0].writable_roots, live.writable_roots)
        self.assertEqual(captured[0].local_sockets, (live.local_socket,))
        self.assertEqual(captured[0].network_domains, live.network_domains)
        # Hard denial is reserved for READ_ONLY; SAFE_AUTO retains native escalation.
        self.assertEqual(captured[0].deny_read_roots, ())

    async def test_interrupt_continuation_requires_interrupted_outcome(self) -> None:
        for outcome, continued in (("interrupted", True), ("completed", False), ("failed", False)):
            with self.subTest(outcome=outcome):
                live = _Live(environment=CURRENT, running=True)
                service, _runtime, catalog = _service(live, _Credentials(CURRENT))
                live.activation_lock = asyncio.Lock()
                live.catalog = catalog
                live.last_submission_id = "submission-permission"
                live.interrupt_generation = 0
                live.ledger = SimpleNamespace(
                    active_turn_id="vendor-turn-permission",
                    has_unknown_outcome=False,
                    wait_terminal=AsyncMock(return_value=outcome),
                )

                async def interrupt(live=live):
                    live.interrupt_generation += 1
                    live.running = False

                live.interrupt = interrupt
                thread_id = live.vendor_thread_id
                result, status = await service.set_mode(
                    SESSION_ID, OWNER, "safe_auto", application="interrupt_continue"
                )
                self.assertEqual("continuation" in result, continued)
                self.assertEqual(live.vendor_thread_id, thread_id)
                self.assertEqual(status, 409 if outcome == "failed" else 200)

    async def test_interrupt_timeout_never_continues(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, _runtime, catalog = _service(live, _Credentials(CURRENT))
        live.activation_lock = asyncio.Lock()
        live.catalog = catalog
        live.last_submission_id = "submission-permission"
        live.ledger = SimpleNamespace(active_turn_id="", has_unknown_outcome=False)
        with patch("service.chat.service.sessions.SESSION_PERMISSION_STOP_TIMEOUT_SECONDS", 0.001):
            result, status = await service.set_mode(
                SESSION_ID, OWNER, "safe_auto", application="interrupt_continue"
            )
        self.assertEqual(status, 409)
        self.assertNotIn("continuation", result)
        self.assertEqual(live.applied_permission_mode, "ask")

    async def test_detached_admission_reads_current_writable_roots(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        live.writable_roots = (live.runtime_workdir, live.runtime_workdir / "revoked")
        service.bind_writable_roots(lambda scope: (scope,))
        seen = []
        activate = runtime.ensure_active

        async def capture(candidate, **options):
            seen.append(candidate.writable_roots)
            await activate(candidate, **options)

        with patch.object(runtime, "ensure_active", side_effect=capture):
            await service.prepare_turn(live)
        self.assertEqual(seen, [(live.runtime_workdir,)])

    async def test_attached_admission_releases_stale_writable_roots(self) -> None:
        live = _Live(environment=CURRENT)
        service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
        old = live.runtime_session
        live.writable_roots = (live.runtime_workdir / "revoked",)
        service.bind_writable_roots(lambda scope: (scope,))
        await service.prepare_turn(live)
        self.assertEqual(live.suspensions, 1)
        self.assertIsNot(live.runtime_session, old)
        self.assertEqual(live.writable_roots, (live.runtime_workdir,))
        await service.prepare_turn(live)
        self.assertEqual(live.suspensions, 1)

    async def test_roots_changed_during_admission_refuse_execution(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        roots = (live.runtime_workdir, live.runtime_workdir / "external")
        service.bind_writable_roots(lambda _scope: roots)
        activate = runtime.ensure_active

        async def revoke_while_waiting(candidate, **options):
            nonlocal roots
            await activate(candidate, **options)
            roots = (live.runtime_workdir,)

        with patch.object(runtime, "ensure_active", side_effect=revoke_while_waiting):
            with self.assertRaisesRegex(RuntimeError, "session_writable_roots_changed"):
                await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)
        await service.prepare_turn(live)
        self.assertEqual(live.writable_roots, roots)

    async def test_authorization_lookup_failure_after_wait_releases_attachment(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        activate = runtime.ensure_active

        def unavailable(_scope):
            raise ValueError("authorization unavailable")

        async def remove_project_while_waiting(candidate, **options):
            await activate(candidate, **options)
            service.bind_writable_roots(unavailable)

        with patch.object(runtime, "ensure_active", side_effect=remove_project_while_waiting):
            with self.assertRaisesRegex(ValueError, "authorization unavailable"):
                await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)

    async def test_roots_change_cannot_bypass_failed_suspension(self) -> None:
        live = _Live(environment=CURRENT)
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        service.bind_writable_roots(lambda scope: (scope,))
        old = live.runtime_session
        with patch.object(live, "suspend_runtime", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "quiescent session"):
                await service.prepare_turn(live)
        self.assertIs(live.runtime_session, old)
        self.assertEqual(live.writable_roots, ())
        self.assertEqual(runtime.policies, [])

    async def test_concurrent_root_publication_cannot_escape_final_validation(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        service.bind_writable_roots(lambda scope: (scope,))
        activate = runtime.ensure_active

        async def publish_stale_roots(candidate, **options):
            await activate(candidate, **options)
            candidate.writable_roots = (candidate.runtime_workdir / "revoked",)

        with patch.object(runtime, "ensure_active", side_effect=publish_stale_roots):
            with self.assertRaisesRegex(RuntimeError, "session_writable_roots_changed"):
                await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)

    async def test_forgotten_project_cannot_resume_warm_or_cold_session(self) -> None:
        for warm in (True, False):
            with self.subTest(warm=warm):
                live = _Live(environment=CURRENT)
                service, runtime, catalog = _service(live, _Credentials(CURRENT))
                live.project_path = live.runtime_workdir
                catalog.relocate(
                    SESSION_ID,
                    OWNER,
                    runtime_workdir=str(live.runtime_workdir),
                    project_path=str(live.project_path),
                    output_root=str(live.runtime_workdir),
                )
                if not warm:
                    service._sessions.clear()
                response, status = await service._resume(SESSION_ID, OWNER, ACTOR_ID)
                self.assertEqual(status, 409)
                self.assertEqual(response["error"], "project_path_not_registered")
                self.assertIsNotNone(catalog.get(SESSION_ID))
                self.assertEqual(runtime.policies, [])

    async def test_forgotten_project_cannot_enter_runtime(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        live.project_path = live.runtime_workdir
        with self.assertRaisesRegex(ValueError, "project_path_not_registered"):
            await service.prepare_turn(live)
        self.assertEqual(runtime.policies, [])

    async def test_project_forgotten_during_admission_releases_attachment(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        live.project_path = live.runtime_workdir
        registered = True
        service._workspaces.register(
            policy=lambda **_options: True,
            project_resolver=lambda path: path if registered else None,
        )
        activate = runtime.ensure_active

        async def forget_while_waiting(candidate, **options):
            nonlocal registered
            await activate(candidate, **options)
            registered = False

        with patch.object(runtime, "ensure_active", side_effect=forget_while_waiting):
            with self.assertRaisesRegex(ValueError, "project_path_not_registered"):
                await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)

    async def test_detached_settings_only_save_intent(self) -> None:
        live = _Live(environment=CURRENT)
        live.runtime_session = None
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        mode, mode_status = await service.set_mode(
            SESSION_ID, OWNER, RuntimePermissionMode.SAFE_AUTO.value
        )
        model, model_status = await service.set_model(
            SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID
        )
        self.assertEqual((mode_status, model_status), (200, 200))
        self.assertEqual((mode["active_mode"], model["active_model_id"]), ("", ""))
        self.assertFalse(mode["deferred"])
        self.assertTrue(model["deferred"])
        self.assertIsNone(live.runtime_session)
        self.assertEqual(runtime.policies, [])
        self.assertEqual(runtime.model_switches, [])
        self.assertEqual(catalog.get(SESSION_ID).policy_id, RuntimePermissionMode.SAFE_AUTO.value)
        self.assertEqual(catalog.model_state(SESSION_ID).selected_model_id, "deepseek-v4-pro")
        await service.prepare_turn(live)
        self.assertEqual(live.applied_permission_mode, RuntimePermissionMode.SAFE_AUTO.value)
        self.assertEqual(live.model_id, "deepseek-v4-pro")

    async def test_invalid_model_choice_has_no_state_change(self) -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        previous = catalog.model_state(SESSION_ID)
        with patch.object(
            runtime, "selected_model_key", side_effect=SessionModelUnavailableError("unavailable")
        ):
            payload, status = await service.set_model(
                SESSION_ID, OWNER, "unavailable", actor_id=ACTOR_ID
            )
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(catalog.model_state(SESSION_ID), previous)
        self.assertEqual(live.suspensions, 0)
        self.assertEqual(runtime.model_switches, [])

    async def test_default_model_is_persisted_before_runtime_drain_can_start(self) -> None:
        live = _Live(environment=CURRENT)
        service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
        service._settings = SettingsService()
        service._settings.set_runtime_model("previous-default")

        async def start_drain(*_args, **_kwargs):
            self.assertEqual(service._settings.runtime_model(), "deepseek-v4-pro")
            service._activities.begin()
            raise RuntimeError("runtime_host_configuration_conflict")

        with patch.object(service, "prepare_turn", side_effect=start_drain):
            payload, status = await service.set_model(
                SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID, remember_default=True
            )
        self.assertEqual(status, 500)
        self.assertEqual(payload["model_id"], "deepseek-v4-pro")
        self.assertEqual(payload["default_model_id"], "deepseek-v4-pro")
        self.assertEqual(service.model(SESSION_ID)["default_model_id"], "deepseek-v4-pro")
        self.assertIs(service._activities.snapshot().phase, ActivityPhase.DRAINING)
        with self.assertRaises(MaintenanceActive):
            service._activities.enter(ActivityDomain.RUNTIME, root=True)

    async def test_detached_and_busy_selections_can_remember_without_activation(self) -> None:
        for running in (False, True):
            live = _Live(environment=CURRENT, running=running)
            if not running:
                live.runtime_session = None
            service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
            service._settings.set_runtime_model("previous-default")
            with patch.object(service, "prepare_turn", new=AsyncMock()) as prepare:
                payload, status = await service.set_model(
                    SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID, remember_default=True
                )
            self.assertEqual(status, 200)
            self.assertEqual(payload["default_model_id"], "deepseek-v4-pro")
            prepare.assert_not_awaited()

    async def test_default_remembering_is_opt_in_and_invalid_intent_cannot_change_it(self) -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        service._settings.set_runtime_model("previous-default")
        with patch.object(service, "prepare_turn", new=AsyncMock()):
            payload, status = await service.set_model(
                SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID
            )
        self.assertEqual(status, 200)
        self.assertEqual(payload["default_model_id"], "")
        previous = catalog.model_state(SESSION_ID)
        with patch.object(
            runtime, "selected_model_key", side_effect=SessionModelUnavailableError("unavailable")
        ):
            _payload, status = await service.set_model(
                SESSION_ID, OWNER, "unavailable", actor_id=ACTOR_ID, remember_default=True
            )
        self.assertEqual(status, 400)
        self.assertEqual(catalog.model_state(SESSION_ID), previous)
        self.assertEqual(service._settings.runtime_model(), "previous-default")

    async def test_default_storage_failure_prevents_activation_and_remains_observable(self) -> None:
        live = _Live(environment=CURRENT)
        service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
        service._settings.set_runtime_model("previous-default")
        with (
            patch.object(
                service._settings, "set_runtime_model", side_effect=PermissionError("denied")
            ),
            patch.object(service, "prepare_turn", new=AsyncMock()) as prepare,
        ):
            with self.assertRaises(PermissionError):
                await service.set_model(
                    SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID, remember_default=True
                )
        prepare.assert_not_awaited()
        snapshot = service.model(SESSION_ID)
        self.assertEqual(snapshot["model_id"], "deepseek-v4-pro")
        self.assertEqual(snapshot["default_model_id"], "")

    async def test_invalid_effort_rejection_preserves_selection_before_persistence(self) -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        previous = catalog.model_state(SESSION_ID)
        with patch.object(
            runtime,
            "validate_effort",
            AsyncMock(side_effect=SessionModelUnavailableError("unsupported effort")),
        ) as validate:
            payload, status = await service.set_model(
                SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID, reasoning_effort="high"
            )
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(catalog.model_state(SESSION_ID), previous)
        self.assertEqual(live.suspensions, 0)
        validate.assert_awaited_once_with("deepseek-v4-pro", "high", user_id=ACTOR_ID)

    async def test_running_effort_change_applies_on_next_admission_and_can_clear(self) -> None:
        live = _Live(environment=CURRENT, running=True)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        payload, status = await service.set_model(
            SESSION_ID, OWNER, live.model_id, actor_id=ACTOR_ID, reasoning_effort="high"
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["deferred"])
        self.assertEqual(payload["active_reasoning_effort"], "")
        self.assertEqual(live.suspensions, 0)
        live.running = False
        await service.prepare_turn(live)
        self.assertEqual(live.reasoning_effort, "high")
        self.assertEqual(catalog.model_state(SESSION_ID).active_reasoning_effort, "high")
        payload, status = await service.set_model(
            SESSION_ID, OWNER, live.model_id, actor_id=ACTOR_ID, reasoning_effort=""
        )
        self.assertEqual(status, 200)
        self.assertFalse(payload["deferred"])
        self.assertEqual(live.reasoning_effort, "")
        self.assertEqual(catalog.model_state(SESSION_ID).active_reasoning_effort, "")

    async def test_native_model_rejection_keeps_pending_target_and_prior_active_effort(
        self,
    ) -> None:
        live = _Live(environment=CURRENT)
        live.reasoning_effort = "low"
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        catalog.apply_model(SESSION_ID, live.model_id, reasoning_effort="low")
        live.runtime_session.reconfigure = AsyncMock(
            return_value=AppliedState(
                "target", "", CommandState.REJECTED, safe_error="model rejected"
            )
        )
        payload, status = await service.set_model(
            SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID, reasoning_effort="high"
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload["model_id"], "deepseek-v4-pro")
        self.assertEqual(payload["reasoning_effort"], "high")
        self.assertEqual(payload["active_model_id"], "gpt-5-codex")
        self.assertEqual(payload["active_reasoning_effort"], "low")
        self.assertTrue(payload["deferred"])
        self.assertEqual(live.suspensions, 0)
        with self.assertRaisesRegex(RuntimeError, "model rejected"):
            await service.prepare_turn(live)

    async def test_busy_permission_downgrade_remains_pending_and_blocks_admission(self) -> None:
        live = _Live(environment=CURRENT)
        live.applied_permission_mode = RuntimePermissionMode.BYPASS.value
        live.runtime_session.mode = RuntimePermissionMode.BYPASS
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.BYPASS.value)
        with patch.object(live, "suspend_runtime", AsyncMock(return_value=False)):
            payload, status = await service.set_mode(
                SESSION_ID, OWNER, RuntimePermissionMode.ASK.value
            )
            self.assertEqual(status, 500)
            self.assertEqual(payload["mode"], RuntimePermissionMode.ASK.value)
            self.assertEqual(payload["active_mode"], RuntimePermissionMode.BYPASS.value)
            self.assertTrue(payload["deferred"])
            with self.assertRaisesRegex(RuntimeError, "quiescent"):
                await service.prepare_turn(live)
        self.assertEqual(catalog.get(SESSION_ID).policy_id, RuntimePermissionMode.ASK.value)
        self.assertEqual(runtime.policies, [])

    async def test_queued_turn_waits_for_runtime_quiescence(self) -> None:
        live = _Live(environment=CURRENT)
        live.applied_permission_mode = RuntimePermissionMode.BYPASS.value
        live.runtime_session.mode = RuntimePermissionMode.BYPASS
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        attempts = 0

        async def suspend_when_idle() -> bool:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                return False
            live.suspensions += 1
            live.runtime_session = None
            return True

        with (
            patch.object(live, "suspend_runtime", side_effect=suspend_when_idle),
            patch("service.chat.service.sessions.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            await service.prepare_turn(live, request_id="queued-request")
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep.await_count, 2)
        self.assertEqual(runtime.quiescence_deadlines, [None])
        self.assertEqual(runtime.policies, [_native_policy(RuntimePermissionMode.ASK.value)])
        self.assertEqual(catalog.get(SESSION_ID).policy_id, RuntimePermissionMode.ASK.value)

    async def test_failed_downgrade_keeps_target_and_blocks_old_permissions(self) -> None:
        live = _Live(environment=STALE)
        live.applied_permission_mode = RuntimePermissionMode.BYPASS.value
        live.runtime_session.mode = RuntimePermissionMode.BYPASS
        service, runtime, catalog = _service(
            live, _Credentials(CURRENT), runtime=_Runtime(fail=True)
        )
        catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.BYPASS.value)
        binding = live.runtime_binding
        payload, status = await service.set_mode(SESSION_ID, OWNER, RuntimePermissionMode.ASK.value)
        self.assertEqual(status, 500)
        self.assertEqual(catalog.get(SESSION_ID).policy_id, RuntimePermissionMode.ASK.value)
        self.assertEqual(payload.get("mode"), RuntimePermissionMode.ASK.value)
        self.assertEqual(payload.get("active_mode"), "")
        self.assertIs(payload.get("deferred"), False)
        for _ in range(2):
            with self.assertRaisesRegex(RuntimeError, "refused to resume"):
                await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)
        self.assertEqual(live.process_environment, CURRENT)
        self.assertIs(live.runtime_binding, binding)
        runtime._fail = False
        await service.prepare_turn(live)
        self.assertEqual(live.applied_permission_mode, RuntimePermissionMode.ASK.value)
        self.assertEqual(live.vendor_thread_id, f"thread-{SESSION_ID}")
        self.assertIs(live.runtime_binding, binding)

    async def test_failed_model_activation_keeps_target_and_blocks_next_turn(self) -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(
            live, _Credentials(CURRENT), runtime=_Runtime(fail=True)
        )
        binding = live.runtime_binding
        payload, status = await service.set_model(
            SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID
        )
        self.assertEqual(status, 500)
        self.assertEqual(catalog.model_state(SESSION_ID).selected_model_id, "deepseek-v4-pro")
        self.assertEqual(catalog.model_state(SESSION_ID).active_model_id, "gpt-5-codex")
        self.assertEqual(payload.get("model_id"), "deepseek-v4-pro")
        self.assertEqual(payload.get("active_model_id"), "")
        self.assertIs(payload.get("deferred"), True)
        with self.assertRaisesRegex(RuntimeError, "refused to resume"):
            await service.prepare_turn(live)
        self.assertIsNone(live.runtime_session)
        runtime._fail = False
        await service.prepare_turn(live)
        self.assertEqual(live.model_id, "deepseek-v4-pro")
        self.assertIs(live.runtime_binding, binding)


def test_idle_session_switches_only_its_model_binding() -> None:
    print("[9] 空闲会话切模型 → resume 同一会话并持久化新绑定")
    live = _Live(environment=CURRENT)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    payload, status = asyncio.run(
        service.set_model(SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID)
    )
    record = catalog.get(SESSION_ID)
    foreign = catalog.get(FOREIGN_ID)
    check(
        "HTTP 200 返回会话模型",
        status == 200 and payload.get("model_id") == "deepseek-v4-pro",
        str(payload),
    )
    check("runtime 仅重绑目标会话", runtime.model_switches == ["deepseek-v4-pro"])
    check(
        "模型选择使用真实账号身份",
        bool(runtime.selection_actors) and set(runtime.selection_actors) == {ACTOR_ID},
        str(runtime.selection_actors),
    )
    check("模型更改恢复原生 thread 身份", live.vendor_thread_id == f"thread-{SESSION_ID}")
    check("目标会话持久化新模型", record is not None and record.model_id == "deepseek-v4-pro")
    check("其他会话模型不变", foreign is not None and foreign.model_id == "gpt-5-codex")


def test_running_session_model_switch_waits_for_idle() -> None:
    print("[10] 运行中切模型 → 保存选择，下一 turn 前应用")
    live = _Live(environment=CURRENT, running=True)
    service, runtime, catalog = _service(live, _Credentials(CURRENT))
    payload, status = asyncio.run(
        service.set_model(SESSION_ID, OWNER, "deepseek-v4-pro", actor_id=ACTOR_ID)
    )
    state = catalog.model_state(SESSION_ID)
    check(
        "HTTP 200 返回延迟生效状态",
        status == 200
        and payload.get("model_id") == "deepseek-v4-pro"
        and payload.get("active_model_id") == "gpt-5-codex"
        and payload.get("deferred") is True,
        str(payload),
    )
    check("没有重绑 runtime", runtime.model_switches == [])
    check(
        "选择已保存但活动模型保持原值",
        state.selected_model_id == "deepseek-v4-pro" and state.active_model_id == "gpt-5-codex",
        str(state),
    )
    live.running = False
    asyncio.run(service.prepare_turn(live))  # type: ignore[arg-type]
    applied = catalog.model_state(SESSION_ID)
    check("下一 turn 前只重绑一次", runtime.model_switches == ["deepseek-v4-pro"])
    check(
        "下一 turn 使用已选模型",
        applied.selected_model_id == applied.active_model_id == "deepseek-v4-pro",
        str(applied),
    )


def test_gateway_writable_roots_reconfigure_permission_intent() -> None:
    print("[11] Gateway 会话更新可写根 → 只走 RuntimeConfigurationIntent")
    live = _Live(environment=CURRENT)
    service, _runtime, catalog = _service(live, _Credentials(CURRENT))
    target = (Path(tempfile.mkdtemp(prefix="linked-root-")),)
    live.local_socket = target[0] / "capability.sock"
    live.network_domains = ("scholarseed.damo.alibaba.com",)
    service.bind_writable_roots(lambda _scope: target)
    asyncio.run(service.prepare_turn(live))
    check("本地 applied state 与 Runtime intent 一致", live.writable_roots == target)
    check("Runtime session 收到完整可写根", live.runtime_session.writable_roots == target)
    check("更新可写根保留本地能力声明", live.runtime_session.local_sockets == (live.local_socket,))
    check("更新可写根保留域名授权", live.runtime_session.network_domains == live.network_domains)
    live.applied_permission_mode = RuntimePermissionMode.READ_ONLY.value
    live.runtime_session.mode = RuntimePermissionMode.READ_ONLY
    catalog.set_policy(live.id, OWNER, RuntimePermissionMode.READ_ONLY.value)
    live.writable_roots = ()
    asyncio.run(service.prepare_turn(live))
    check("只读模式不延续外网域名授权", not live.runtime_session.network_domains)


def test_turn_admission_refreshes_roots_after_activation() -> None:
    async def scenario() -> None:
        live = _Live(environment=CURRENT)
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        roots = (live.runtime_workdir, live.runtime_workdir / "linked.md")
        service.bind_writable_roots(lambda _scope: roots)
        await service.prepare_turn(live)
        assert live.writable_roots == roots
        assert live.runtime_session.writable_roots == roots
        original_activate = runtime.ensure_active

        async def revoke_during_activation(target, **options):
            nonlocal roots
            await original_activate(target, **options)
            roots = (live.runtime_workdir,)

        runtime.ensure_active = revoke_during_activation
        try:
            await service.prepare_turn(live)
        except RuntimeError as error:
            assert str(error) == SESSION_WRITABLE_ROOTS_CHANGED_ERROR
        else:
            raise AssertionError("changed roots must invalidate activation")
        assert live.runtime_session is None
        runtime.ensure_active = original_activate
        await service.prepare_turn(live)
        assert live.writable_roots == roots
        assert live.runtime_session.writable_roots == roots

    asyncio.run(scenario())


def test_project_session_enumeration_does_not_reconfigure() -> None:
    live = _Live(environment=CURRENT)
    service, _runtime, _catalog = _service(live, _Credentials(CURRENT))
    live.project_path = live.runtime_workdir
    live.runtime_session.reconfigure = AsyncMock(
        side_effect=AssertionError("enumeration must not reconfigure")
    )
    peer = _Live(environment=CURRENT, running=True)
    peer.project_path = live.project_path
    peer.runtime_workdir = live.runtime_workdir
    service._sessions[FOREIGN_ID] = peer
    assert service.project_session_ids(live.project_path) == (SESSION_ID, FOREIGN_ID)
    assert service.project_session_ids(live.project_path / "other") == ()
    peer.project_path = live.project_path / "nested-project"
    assert service.project_session_ids(live.project_path) == (SESSION_ID,)
    live.runtime_session.reconfigure.assert_not_awaited()


def test_roots_refresh_preserves_accepted_permission_mode() -> None:
    async def scenario() -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        roots = (live.runtime_workdir, live.runtime_workdir / "linked.md")
        service.bind_writable_roots(lambda _scope: roots)
        await service.prepare_turn(live)
        intents = []

        async def accept(request):
            intents.append(request.permission)
            return AppliedState(request.revision, "", CommandState.ACCEPTED, scope="next_turn")

        async def change_mode(target, **options):
            catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.SAFE_AUTO.value)

        live.runtime_session.reconfigure = accept
        runtime.ensure_active = change_mode
        await service.prepare_turn(live)
        assert len(intents) == 1
        assert intents[0].mode is RuntimePermissionMode.SAFE_AUTO
        assert intents[0].writable_roots == roots
        assert live.applied_permission_mode == RuntimePermissionMode.ASK.value

    asyncio.run(scenario())


def test_reconstructed_runtime_receives_current_roots() -> None:
    async def scenario() -> None:
        live = _Live(environment=CURRENT)
        service, runtime, _catalog = _service(live, _Credentials(CURRENT))
        live.runtime_session = None
        live.writable_roots = (live.runtime_workdir / "revoked.md",)
        roots = (live.runtime_workdir,)
        service.bind_writable_roots(lambda _scope: roots)
        activate = runtime.ensure_active
        received = []

        async def capture(target, **options):
            received.append(target.writable_roots)
            await activate(target, **options)

        runtime.ensure_active = capture
        await service.prepare_turn(live)
        assert received == [roots]
        assert live.writable_roots == roots

    asyncio.run(scenario())


def test_post_activation_alignment_reports_only_confirmed_mode() -> None:
    async def scenario() -> None:
        live = _Live(environment=CURRENT)
        service, runtime, catalog = _service(live, _Credentials(CURRENT))
        roots = (live.runtime_workdir, live.runtime_workdir / "linked.md")
        service.bind_writable_roots(lambda _scope: roots)

        await service.prepare_turn(live)

        async def change_during_activation(target, **options):
            catalog.set_policy(SESSION_ID, OWNER, RuntimePermissionMode.SAFE_AUTO.value)

        runtime.ensure_active = change_during_activation
        await service.prepare_turn(live)
        assert live.runtime_session.mode is RuntimePermissionMode.SAFE_AUTO
        assert live.applied_permission_mode == RuntimePermissionMode.SAFE_AUTO.value

    asyncio.run(scenario())


def main() -> int:
    test_matching_environment_is_untouched()
    test_stale_environment_migrates()
    test_running_turn_is_not_interrupted()
    test_absent_session_is_noop()
    test_batch_alignment_scopes_to_owner()
    test_realign_failure_blocks_turn()
    test_idle_session_permission_mode_switches_runtime_policy()
    test_running_session_safe_auto_switch_defers_to_turn_boundary()
    test_running_session_bypass_switch_defers_to_turn_boundary()
    test_waiting_approval_defers_permission_switch()
    test_pending_question_defers_permission_switch()
    test_pending_interaction_without_running_defers_permission_switch()
    test_permission_switch_failure_is_not_reported_as_running()
    test_permission_downgrade_uses_current_authorization()
    test_idle_session_switches_only_its_model_binding()
    test_running_session_model_switch_waits_for_idle()
    test_gateway_writable_roots_reconfigure_permission_intent()
    test_turn_admission_refreshes_roots_after_activation()
    test_project_session_enumeration_does_not_reconfigure()
    test_roots_refresh_preserves_accepted_permission_mode()
    test_reconstructed_runtime_receives_current_roots()
    test_post_activation_alignment_reports_only_confirmed_mode()
    print(f"\n{PASS} passed, {FAIL} failed")
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(PermissionActivationTests)
    )
    return 1 if FAIL or not result.wasSuccessful() else 0


if __name__ == "__main__":
    raise SystemExit(main())
