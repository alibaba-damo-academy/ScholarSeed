"""Native Codex session workspace binding and exact-resume contract."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI

from service.platform.activity import Activities

_HOME = Path(tempfile.mkdtemp(prefix="session-workspace-home-"))
os.environ["SCHOLARSEED_HOME"] = str(_HOME)

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
from scholarseed_runtime.contract import CapabilitySet  # noqa: E402
from scholarseed_runtime.contract import (  # noqa: E402 -- after SCHOLARSEED_HOME test isolation
    CapabilityState,
    RuntimeBinding,
    RuntimeCapability,
    RuntimeCapabilityName,
    RuntimeReadiness,
    RuntimeStatus,
)
from service.bootstrap import _bind_writable_roots  # noqa: E402 -- after home isolation
from service.chat.active import RUNTIME_ID  # noqa: E402
from service.chat.constants import (  # noqa: E402
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    SESSION_RELOCATE_REQUIRES_TURN_ERROR,
    SESSION_RELOCATE_STOP_FAILED_ERROR,
    SESSION_RELOCATE_STOP_PENDING_ERROR,
    SESSION_RUNNING_ERROR,
)
from service.chat.persistence.artifacts import SessionArtifactStore  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.service.sessions import SessionService, workspace_allows  # noqa: E402
from service.chat.service.workspaces import SessionWorkspaceService  # noqa: E402
from service.content.persistence.catalog import ContentCatalog  # noqa: E402 -- after home isolation
from service.content.service.port import (  # noqa: E402 -- after home isolation
    ContentService,
    ProjectRegistry,
)
from service.identity.service.skill_credentials import (  # noqa: E402
    skill_credentials_from_env,
)

PASS = 0
FAIL = 0
TEST_STOP_TIMEOUT_SECONDS = 0.01


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


class _Projects:
    def __init__(self, roots: set[Path]) -> None:
        self.roots = {root.resolve() for root in roots}

    def allows(
        self, *, principal_id: str, active_workspace: Path, requested_workspace: Path
    ) -> bool:
        _ = active_workspace
        return bool(principal_id) and requested_workspace.resolve() in self.roots

    def project_for(self, requested_workspace: Path) -> Path | None:
        resolved = requested_workspace.resolve()
        return resolved if resolved in self.roots else None


class _Live:
    def __init__(
        self,
        *,
        session_id: str,
        cwd: Path,
        project_path: Path | None,
        output_root: Path,
        model_id: str,
        vendor_thread_id: str,
        resumed: bool,
        runtime_id: str = RUNTIME_ID,
        user_id: str = "",
    ) -> None:
        self.id = session_id
        self.runtime_id = runtime_id
        self.runtime_workdir = cwd.resolve()
        self.project_path = project_path.resolve() if project_path else None
        self.output_root = output_root.resolve()
        self.model_id = model_id
        self.reasoning_effort = ""
        self.vendor_thread_id = vendor_thread_id
        self.runtime_session = None
        self.runtime_binding = None
        self.resumed = resumed
        self.user_id = user_id
        self.gateway_capabilities = CapabilitySet()
        self.lifecycle_lock = asyncio.Lock()
        self.activation_lock = asyncio.Lock()
        self.resource_task = None
        self.waiting_resources = False
        self.waiting_request_id = ""
        self.last_seq = 0
        self.running = False
        self.ledger = SimpleNamespace(
            has_unknown_outcome=False, active_turn_id="", uncertainty_snapshot=lambda: []
        )
        self.interrupting = False
        self.last_interrupt_succeeded = None
        self.activated = False
        self.published: list[dict[str, Any]] = []
        self.interrupt_calls = 0
        self.interrupt_requested = asyncio.Event()
        self.finish_on_interrupt = True
        self.fail_interrupt = False

    @property
    def turn_active(self) -> bool:
        return bool(self.ledger.active_turn_id)

    async def activate(self) -> None:
        self.activated = True

    async def reconcile_resumed_turns(self) -> None:
        return None

    async def aclose(self) -> None:
        return None

    async def interrupt(self) -> None:
        self.interrupt_calls += 1
        self.interrupt_requested.set()
        if self.fail_interrupt:
            raise RuntimeError("interrupt rejected")
        if self.finish_on_interrupt:
            self.running = False

    async def publish(
        self,
        kind: str,
        data: dict[str, Any],
        *,
        turn_id: str = "",
        item_id: str = "",
        idempotency_key: str = "",
    ) -> SimpleNamespace:
        self.last_seq += 1
        self.published.append(
            {
                "kind": kind,
                "data": dict(data),
                "turn_id": turn_id,
                "item_id": item_id,
                "idempotency_key": idempotency_key,
            }
        )
        return SimpleNamespace(product_seq=self.last_seq)

    async def skill_identity_by_name(self, name: str) -> dict[str, Any] | None:
        if name != "literature-search":
            return None
        return {"name": name, "version": "1.2.3", "active": True}

    def pending_hil_snapshot(self, *, blocking_only: bool = True) -> list[dict[str, Any]]:
        return []

    def artifact_snapshot(self) -> list[dict[str, Any]]:
        return []


class _Runtime:
    def recover_publications(self, session_id: str) -> None:
        pass

    def __init__(self) -> None:
        self.runtime_id = RUNTIME_ID
        self.gateway_capabilities = CapabilitySet(
            (
                RuntimeCapability(
                    RuntimeCapabilityName.WEB_SEARCH.value,
                    CapabilityState.SUPPORTED,
                ),
            )
        )
        self.opens: list[dict[str, Any]] = []
        self.rebinds: list[dict[str, Any]] = []

    async def readiness(self, *, runtime_id: str = "", executable: str = "") -> RuntimeReadiness:
        selected = runtime_id or self.runtime_id
        return RuntimeReadiness(
            runtime_id=selected,
            status=RuntimeStatus.READY,
            ready=True,
            executable=executable or "codex",
            version="0.147.0",
            authenticated=True,
            process_state="ready",
        )

    def selected_model_key(self, model_id: str, *, user_id: str = "") -> str:
        # 会话 resume 会把存量选择经目录解析对齐（未登录门禁回落）；本桩没有目录，
        # 恒等解析即可 —— 与其他 runtime 桩（contract_codex_service）同一形状。
        return model_id

    async def open(self, **values: Any) -> _Live:
        self.opens.append(dict(values))
        resume = str(values.get("resume_vendor_thread_id") or "")
        live = _Live(
            session_id=str(values["session_id"]),
            cwd=Path(values["cwd"]),
            project_path=values.get("project_path"),
            output_root=Path(values["output_root"]),
            model_id=str(values.get("model_id") or ""),
            vendor_thread_id=resume,
            resumed=bool(resume),
            runtime_id=str(values.get("runtime_id") or self.runtime_id),
            user_id=str(values.get("user_id") or ""),
        )
        required = tuple(values.get("required_capabilities") or ())
        live.gateway_capabilities = CapabilitySet(
            tuple(
                RuntimeCapability(capability.value, CapabilityState.SUPPORTED)
                for capability in required
            )
        )
        return live

    async def rebind(self, live: _Live, **values: Any) -> None:
        self.rebinds.append(dict(values))
        live.runtime_workdir = Path(values["cwd"]).resolve()
        project_path = values.get("project_path")
        live.project_path = Path(project_path).resolve() if project_path else None
        live.output_root = Path(values["output_root"]).resolve()
        live.resumed = True


def _service(root: Path, projects: set[Path]):
    database = _HOME / f"catalog-{root.name}.sqlite3"
    catalog = SessionCatalogStore(database)
    events = ProductEventStore(database)
    artifacts = SessionArtifactStore(database)
    runtime = _Runtime()
    sessions: dict[str, _Live] = {}
    workspaces = SessionWorkspaceService(workspace_allows)
    policy = _Projects(projects)
    workspaces.register(policy=policy.allows, project_resolver=policy.project_for)
    service = SessionService(
        root,
        sessions,  # type: ignore[arg-type]
        activities=Activities(),
        access=catalog,
        events=events,
        runtime=runtime,  # type: ignore[arg-type]
        workspaces=workspaces,
        artifacts=artifacts,
        settings=SimpleNamespace(  # type: ignore[arg-type]
            runtime_executable=lambda: "codex",
            runtime_model=lambda: "gpt-codex-native",
            permission_mode=lambda: "ask",
        ),
        credentials=skill_credentials_from_env({}, activities=Activities()),
        logger=logging.getLogger(__name__),
    )
    content_catalog = ContentCatalog(_HOME / f"content-{root.name}.sqlite3")
    registry = ProjectRegistry(str(root), content_catalog)
    for project in projects:
        registry.adopt(project)
    app = FastAPI()
    app.state.session_service = service
    _bind_writable_roots(app, ContentService(registry, content_catalog, activities=Activities()))
    return service, catalog, runtime, sessions


async def scenario() -> None:
    root = Path(tempfile.mkdtemp(prefix="session-workspace-contract-")).resolve()
    project = root / "registered-project"
    project.mkdir()
    unregistered = root / "unregistered-project"
    unregistered.mkdir()
    conflict_project = root / "conflict-project"
    user_outputs = conflict_project / "sessions"
    user_outputs.mkdir(parents=True)
    user_file = user_outputs / "keep.txt"
    user_file.write_text("existing user data", encoding="utf-8")
    service, catalog, runtime, sessions = _service(root, {project, conflict_project})
    owner = SessionPrincipal("local")
    foreign = SessionPrincipal("foreign")

    # 本套件测工作区授权, 归属身份与真实账号身份天然同源; open 要求显式区分两者, 这里
    # 在一处表达"同源"而不是每个调用点重复。
    async def _open(
        body: dict[str, Any],
        principal: SessionPrincipal,
    ) -> tuple[dict[str, Any], int]:
        return await service.open(body, principal, actor_id=principal.user_id)

    conflict, conflict_status = await _open({"project_path": str(conflict_project)}, owner)
    check(
        "project output collision is explicit and never adopts user files",
        conflict_status == 409
        and conflict.get("error") == "owned_root_conflict"
        and user_file.read_text(encoding="utf-8") == "existing user data",
        str(conflict),
    )

    first, first_status = await _open({}, owner)
    second, second_status = await _open({}, owner)
    first_workdir = Path(first["runtime_workdir"])
    second_workdir = Path(second["runtime_workdir"])
    first_record = catalog.get(first["session_id"])
    second_record = catalog.get(second["session_id"])
    check(
        "unassigned sessions receive distinct runtime workdirs",
        first_status == second_status == 200
        and first_workdir != second_workdir
        and first_workdir.is_dir()
        and second_workdir.is_dir(),
        str({"first": first, "second": second}),
    )
    check(
        "unassigned output roots stay inside their own session workdir",
        first_record is not None
        and second_record is not None
        and Path(first_record.output_root).parent == first_workdir
        and Path(second_record.output_root).parent == second_workdir,
        str((first_record, second_record)),
    )

    project_open, project_status = await _open({"project_path": str(project)}, owner)
    project_record = catalog.get(project_open["session_id"])
    check(
        "registered project sessions isolate cwd and output together",
        project_status == 200
        and project_open["runtime_workdir"]
        == str(project / "sessions" / project_open["session_id"])
        and project_open["project_path"] == str(project)
        and project_record is not None
        and Path(project_record.output_root) == project / "sessions" / project_open["session_id"],
        str(project_open),
    )
    rejected, rejected_status = await _open({"project_path": str(unregistered)}, owner)
    check(
        "unregistered project roots fail before runtime assembly",
        rejected_status == 409
        and rejected.get("error") == "project_path_not_registered"
        and len(runtime.opens) == 3,
        str(rejected),
    )

    legacy_body, legacy_status = await _open({"work": "scholar"}, owner)
    check(
        "removed work selector fails closed",
        legacy_status == 400 and legacy_body.get("error") == "invalid_session_open_fields",
        str(legacy_body),
    )
    runtime_selector, runtime_selector_status = await _open(
        {"runtime_id": "codex"},
        owner,
    )
    check(
        "runtime is product-owned rather than a client-selectable field",
        runtime_selector_status == 400
        and runtime_selector.get("error") == "invalid_session_open_fields",
        str(runtime_selector),
    )
    invalid_capabilities, invalid_capabilities_status = await _open(
        {"required_capabilities": "web_search"},
        owner,
    )
    check(
        "required runtime capabilities use a strict array contract",
        invalid_capabilities_status == 400
        and invalid_capabilities.get("error") == "invalid_required_capabilities",
        str(invalid_capabilities),
    )
    search_open, search_open_status = await _open(
        {"required_capabilities": [RuntimeCapabilityName.WEB_SEARCH.value]},
        owner,
    )
    check(
        "dedicated sessions pass a verified capability requirement to runtime open",
        search_open_status == 200
        and search_open.get("capabilities", {}).get("web_search") is True
        and runtime.opens[-1].get("required_capabilities") == (RuntimeCapabilityName.WEB_SEARCH,),
        str(search_open),
    )

    first_id = str(first["session_id"])
    immutable_resume, immutable_resume_status = await _open(
        {"resume_session_id": first_id, "model_id": "different-model"},
        owner,
    )
    check(
        "resume rejects attempts to mutate frozen runtime fields",
        immutable_resume_status == 409
        and immutable_resume.get("error") == "resume_session_fields_immutable",
        str(immutable_resume),
    )
    capability_resume, capability_resume_status = await _open(
        {
            "resume_session_id": first_id,
            "required_capabilities": [RuntimeCapabilityName.WEB_SEARCH.value],
        },
        owner,
    )
    check(
        "resume cannot change session-scoped runtime capabilities",
        capability_resume_status == 409
        and capability_resume.get("error") == "resume_session_fields_immutable",
        str(capability_resume),
    )
    # This scenario resumes a session that previously executed, so record its
    # native binding explicitly rather than having logical creation fabricate it.
    attempt_id = "workspace-contract-open"
    catalog.begin_open(first_id, attempt_id)
    binding = RuntimeBinding(
        product_session_id=first_id,
        runtime_id=RUNTIME_ID,
        adapter_version="1",
        runtime_version="0.147.0",
        protocol_version="2",
        protocol_schema_hash="fixture-schema",
        opaque_session_ref="executed-native-thread",
        capabilities=CapabilitySet(),
    )
    catalog.bind_open(first_id, attempt_id, binding)
    first_record = catalog.get(first_id)
    sessions.pop(first_id)
    runtime.runtime_id = "dsh"
    catalog.set_model(first_id, owner, "selected-resume-model")
    prior_state = catalog.model_state(first_id)
    with patch.object(runtime, "open", AsyncMock(side_effect=RuntimeError("resume failed"))):
        failed, failed_status = await _open({"resume_session_id": first_id}, owner)
    check(
        "failed cold resume preserves selected and active model state",
        failed_status == 500
        and catalog.model_state(first_id) == prior_state
        and first_id not in sessions,
        str(failed),
    )
    open_runtime = runtime.open

    async def resume_with_new_selection(**values: Any) -> _Live:
        catalog.set_model(first_id, owner, "next-selection-during-resume")
        return await open_runtime(**values)

    with patch.object(runtime, "open", resume_with_new_selection):
        resumed, resumed_status = await _open({"resume_session_id": first_id}, owner)
    resumed_record = catalog.get(first_id)
    check(
        "cold resume uses the exact persisted vendor thread and frozen cwd",
        resumed_status == 200
        and first_record is not None
        and resumed.get("resumed") is True
        and runtime.opens[-1]["resume_vendor_thread_id"] == first_record.vendor_thread_id
        and runtime.opens[-1]["runtime_id"] == RUNTIME_ID
        and resumed.get("runtime_id") == RUNTIME_ID
        and Path(runtime.opens[-1]["cwd"]) == Path(first_record.runtime_workdir)
        and resumed_record.vendor_thread_id == first_record.vendor_thread_id,
        str(resumed),
    )
    check(
        "logical resume preserves selected intent until native activation",
        runtime.opens[-1]["model_id"] == "selected-resume-model"
        and catalog.model_state(first_id).active_model_id == prior_state.active_model_id
        and catalog.model_state(first_id).selected_model_id == "next-selection-during-resume",
    )
    runtime.runtime_id = RUNTIME_ID

    catalog.update_status(
        first_id,
        SessionStatus.RUNNING,
        turn_id="turn-before-restart",
        turn_status="running",
    )
    catalog.record_hil(
        product_request_id="hil-before-restart",
        session_id=first_id,
        vendor_request_id="hil-before-restart",
        vendor_turn_id="turn-before-restart",
        vendor_item_id="item-before-restart",
        method="codex.hil",
        payload={"request_id": "hil-before-restart", "kind": "permission"},
    )
    sessions.pop(first_id)
    recovered, recovered_status = await _open({"resume_session_id": first_id}, owner)
    recovered_record = catalog.get(first_id)
    recovered_live = sessions[first_id]
    # 取成局部再比: == () 同时钉住「空」与「仍是 tuple」(not x 会放过 None), 而内联在
    # 长布尔链里会被 black 拆行, 行内 pylint 豁免就跟丢了被报的那一行。
    pending_after_restart = catalog.pending_hil(first_id)
    check(
        "restart recovery exposes stale HIL and an interrupted terminal state",
        recovered_status == 200
        and recovered.get("resumed") is True
        and recovered_record is not None
        and recovered_record.status == SessionStatus.INTERRUPTED
        and recovered_record.last_turn_id == "turn-before-restart"
        and recovered_record.last_turn_status == "interrupted"
        and recovered.get("last_turn_id") == "turn-before-restart"
        and recovered.get("last_turn_status") == "interrupted"
        and pending_after_restart == ()  # pylint: disable=use-implicit-booleaness-not-comparison
        and [row["kind"] for row in recovered_live.published]
        == [PRODUCT_EVENT_HIL_RESOLVED, PRODUCT_EVENT_TURN_INTERRUPTED]
        and recovered_live.published[0]["data"]["state"] == "stale"
        and recovered_live.published[1]["data"]["reason"] == "app_restart",
        str({"snapshot": recovered, "events": recovered_live.published}),
    )

    opens_before_foreign_resume = len(runtime.opens)
    foreign_resume, foreign_status = await _open({"resume_session_id": first_id}, foreign)
    check(
        "foreign resume is non-enumerating and never opens a runtime",
        foreign_status == 404
        and foreign_resume.get("error") == "session_not_found"
        and len(runtime.opens) == opens_before_foreign_resume,
        str(foreign_resume),
    )
    original_vendor_thread_id = sessions[first_id].vendor_thread_id
    moving_live = sessions[first_id]
    moving_live.running = True
    moving_live.ledger.active_turn_id = "running-turn"
    original_workdir = moving_live.runtime_workdir
    original_rebind_count = len(runtime.rebinds)
    blocked, blocked_status = await service.assign_project(
        session_id=first_id,
        principal=owner,
        project_path=str(project),
    )
    check(
        "running relocation requires consent and never interrupts implicitly",
        blocked_status == 409
        and blocked.get("error") == SESSION_RUNNING_ERROR
        and moving_live.interrupt_calls == 0
        and len(runtime.rebinds) == original_rebind_count,
        str(blocked),
    )
    invalid, invalid_status = await service.assign_project(
        session_id=first_id, principal=owner, project_path=str(unregistered), stop_running=True
    )
    check(
        "target validation happens before a consented interruption",
        invalid_status == 409 and moving_live.interrupt_calls == 0,
        str(invalid),
    )
    moving_live.fail_interrupt = True
    failed, failed_status = await service.assign_project(
        session_id=first_id, principal=owner, project_path=str(project), stop_running=True
    )
    check(
        "interrupt failure preserves the catalog and runtime roots",
        failed_status == 409
        and failed.get("error") == SESSION_RELOCATE_STOP_FAILED_ERROR
        and moving_live.runtime_workdir == original_workdir
        and catalog.get(first_id).project_path is None
        and len(runtime.rebinds) == original_rebind_count,
        str(failed),
    )
    moving_live.fail_interrupt = False
    moving_live.finish_on_interrupt = False
    with patch(
        "service.chat.service.sessions.SESSION_RELOCATE_STOP_TIMEOUT_SECONDS",
        TEST_STOP_TIMEOUT_SECONDS,
    ):
        pending, pending_status = await service.assign_project(
            session_id=first_id, principal=owner, project_path=str(project), stop_running=True
        )
    check(
        "interrupt acknowledgement without termination cannot move a session",
        pending_status == 409
        and pending.get("error") == SESSION_RELOCATE_STOP_PENDING_ERROR
        and moving_live.runtime_workdir == original_workdir
        and catalog.get(first_id).project_path is None
        and len(runtime.rebinds) == original_rebind_count,
        str(pending),
    )
    moving_live.interrupt_requested.clear()
    relocation = asyncio.create_task(
        service.assign_project(
            session_id=first_id, principal=owner, project_path=str(project), stop_running=True
        )
    )
    await moving_live.interrupt_requested.wait()
    check(
        "confirmed relocation holds the activation barrier before rebinding",
        not relocation.done()
        and moving_live.activation_lock.locked()
        and len(runtime.rebinds) == original_rebind_count,
    )
    moving_live.running = False
    relocated, relocate_status = await relocation
    relocated_record = catalog.get(first_id)
    check(
        "project relocation preserves the Codex thread and rebinds all runtime roots",
        relocate_status == 200
        and relocated.get("project_path") == str(project)
        and relocated.get("runtime_workdir") == str(project / "sessions" / first_id)
        and relocated.get("output_root") == str(project / "sessions" / first_id)
        and relocated_record is not None
        and relocated_record.project_path == str(project)
        and relocated_record.runtime_workdir == str(project / "sessions" / first_id)
        and relocated_record.output_root == str(project / "sessions" / first_id)
        and runtime.rebinds[-1]["cwd"] == project / "sessions" / first_id
        and sessions[first_id].vendor_thread_id == original_vendor_thread_id
        and sessions[first_id].runtime_workdir == project / "sessions" / first_id
        and sessions[first_id].project_path == project,
        str(relocated),
    )
    unregistered_move, unregistered_move_status = await service.assign_project(
        session_id=second["session_id"],
        principal=owner,
        project_path=str(unregistered),
    )
    check(
        "project assignment rejects an unregistered root",
        unregistered_move_status == 409
        and unregistered_move.get("error") == "project_path_not_registered"
        and catalog.get(second["session_id"]).project_path is None,
        str(unregistered_move),
    )
    empty_move, empty_move_status = await service.assign_project(
        session_id=second["session_id"],
        principal=owner,
        project_path=str(project),
    )
    check(
        "empty Codex threads fail explicitly before an impossible resume",
        empty_move_status == 409
        and empty_move.get("error") == SESSION_RELOCATE_REQUIRES_TURN_ERROR
        and catalog.get(second["session_id"]).project_path is None,
        str(empty_move),
    )
    starting_live = sessions[second["session_id"]]
    starting_live.running = True
    starting, starting_status = await service.assign_project(
        session_id=starting_live.id, principal=owner, project_path=str(project)
    )
    check(
        "an admitted first turn requests stop consent instead of being treated as empty",
        starting_status == 409
        and starting.get("error") == SESSION_RUNNING_ERROR
        and starting_live.interrupt_calls == 0,
        str(starting),
    )
    starting_move = asyncio.create_task(
        service.assign_project(
            session_id=starting_live.id,
            principal=owner,
            project_path=str(project),
            stop_running=True,
        )
    )
    await asyncio.sleep(0)
    check(
        "stopping an admitted turn waits for its vendor ID before sending an interrupt",
        not starting_move.done()
        and starting_live.activation_lock.locked()
        and starting_live.interrupt_calls == 0,
    )
    starting_live.ledger.active_turn_id = "first-vendor-turn"
    catalog.update_status(
        starting_live.id,
        SessionStatus.RUNNING,
        turn_id=starting_live.ledger.active_turn_id,
        turn_status="running",
    )
    started_move, started_status = await starting_move
    check(
        "first-turn relocation refreshes the durable record after stopping",
        started_status == 200
        and starting_live.interrupt_calls == 1
        and started_move.get("project_path") == str(project),
        str(started_move),
    )
    idle_interrupts = moving_live.interrupt_calls
    idle_move, idle_status = await service.assign_project(
        session_id=moving_live.id, principal=owner, project_path=str(project)
    )
    check(
        "repeated assignment to the same project is idempotent without interruption",
        idle_status == 200
        and idle_move.get("project_path") == str(project)
        and moving_live.interrupt_calls == idle_interrupts,
        str(idle_move),
    )


def main() -> int:
    print("native Codex session workspace contract")
    asyncio.run(scenario())
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
