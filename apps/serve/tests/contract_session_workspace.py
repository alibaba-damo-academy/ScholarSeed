"""Native Codex session workspace binding and exact-resume contract."""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import threading
import unittest
from collections.abc import AsyncGenerator
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
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
    SESSION_PROJECT_NOT_REGISTERED_ERROR,
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
from service.chat.persistence.notifications import observe_chat  # noqa: E402
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
from service.persistence.notifications import NotificationConnection  # noqa: E402
from service.platform.activity import ActivityDomain, MaintenanceActive  # noqa: E402
from service.platform.notifications import ChangeHub  # noqa: E402

PASS = 0
FAIL = 0
TEST_STOP_TIMEOUT_SECONDS = 0.01
RESUME_WORKER_WAIT_SECONDS = 5.0


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
        self.terminating = False
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

    @property
    def closing(self) -> bool:
        return self.terminating

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
    async def realign_metering_identity(self, live: _Live, user_id: str) -> None:
        live.user_id = user_id

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


def writable_root_access_contract() -> None:
    project = Path("/registered-project")
    external = Path("/authorized-output")
    providers = []
    artifact_providers = []
    app = FastAPI()
    app.state.session_service = SimpleNamespace(
        bind_writable_roots=providers.append,
        bind_artifact_roots=artifact_providers.append,
        bind_session_directory=lambda _provider: None,
    )
    selected = SimpleNamespace(root=str(project), id="project", available=True)
    content = SimpleNamespace(
        project_for_path=lambda _scope: selected,
        writable_roots=lambda _project: (str(external), str(project)),
    )
    _bind_writable_roots(app, content)
    provider = providers[0]
    check(
        "artifact roots use the same project authorization",
        artifact_providers[0](project) == (project, external),
    )
    with patch("service.bootstrap.grant_current_user_directory_access") as access:
        roots = provider(project)
        check(
            "authorized writable roots retain host access exactly once",
            roots == (project, external)
            and [call.args[0] for call in access.call_args_list] == list(roots),
            str(access.call_args_list),
        )
        access.reset_mock()
        check(
            "artifact roots preserve the same scope without requesting host write access",
            artifact_providers[0](project) == roots and not access.called,
        )
    with patch(
        "service.bootstrap.grant_current_user_directory_access",
        side_effect=PermissionError("host access initialization denied"),
    ):
        rejected = False
        try:
            provider(project)
        except PermissionError:
            rejected = True
        check("host access initialization fails closed", rejected)
    for selection in (None, SimpleNamespace(available=False)):
        content.project_for_path = lambda _scope, value=selection: value
        with patch("service.bootstrap.grant_current_user_directory_access") as access:
            roots = provider(project)
            check(
                "unregistered or unavailable scopes receive no host access grants",
                roots == () and not access.called,
            )


async def scenario() -> None:
    root = Path(tempfile.mkdtemp(prefix="session-workspace-contract-")).resolve()
    project = root / "registered-project"
    project.mkdir()
    unregistered = root / "unregistered-project"
    unregistered.mkdir()
    conflict_project = root / "conflict-project"
    user_outputs = conflict_project / "output"
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
        "existing output is left to the agent without programmatic adoption",
        conflict_status == 200
        and conflict.get("runtime_workdir") == str(conflict_project)
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
        "registered project sessions use the project cwd without allocating output",
        project_status == 200
        and project_open["runtime_workdir"] == str(project)
        and project_open["project_path"] == str(project)
        and project_record is not None
        and Path(project_record.output_root) == project
        and not (project / "sessions").exists()
        and not (project / "output").exists(),
        str(project_open),
    )
    rejected, rejected_status = await _open({"project_path": str(unregistered)}, owner)
    check(
        "unregistered project roots fail before runtime assembly",
        rejected_status == 409
        and rejected.get("error") == "project_path_not_registered"
        and len(runtime.opens) == 4,
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
        and relocated.get("runtime_workdir") == str(project)
        and relocated.get("output_root") == str(project)
        and relocated_record is not None
        and relocated_record.project_path == str(project)
        and relocated_record.runtime_workdir == str(project)
        and relocated_record.output_root == str(project)
        and runtime.rebinds[-1]["cwd"] == project
        and sessions[first_id].vendor_thread_id == original_vendor_thread_id
        and sessions[first_id].runtime_workdir == project
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

    old_root, _, old_output = service._project_paths(first_id, project, session_scoped=True)
    old_file = old_root / "old-report.md"
    old_file.write_text("retained old report", encoding="utf-8")
    catalog.relocate(
        first_id,
        owner,
        runtime_workdir=str(old_root),
        project_path=str(project),
        output_root=str(old_output),
    )
    sessions.pop(first_id)
    old_thread = catalog.get(first_id).vendor_thread_id
    old_resumed, old_resume_status = await _open({"resume_session_id": first_id}, owner)
    check(
        "old project sessions cold-resume their saved cwd and native thread without migration",
        old_resume_status == 200
        and old_resumed.get("runtime_workdir") == str(old_root)
        and runtime.opens[-1]["resume_vendor_thread_id"] == old_thread
        and service.file_content(first_id, "old-report.md")["content"] == "retained old report",
        str(old_resumed),
    )
    old_attachment = service.save_attachment(
        first_id, filename="old.txt", content=b"old input", media_type="text/plain"
    )
    check(
        "old session uploads keep their original attachment root",
        Path(old_attachment["path"]).parent == old_root / "attachments",
        str(old_attachment),
    )
    old_moved, old_move_status = await service.assign_project(
        session_id=first_id,
        principal=owner,
        project_path=str(conflict_project),
    )
    check(
        "moving an old project session retains a session-scoped Content workdir",
        old_move_status == 200
        and Path(old_moved["runtime_workdir"]).parent == conflict_project / "sessions"
        and old_moved["output_root"] == old_moved["runtime_workdir"]
        and old_file.read_text(encoding="utf-8") == "retained old report",
        str(old_moved),
    )


class ResumeIOContracts(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="resume-io-contract-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.project = self.root / "project"
        self.project.mkdir()
        self.service, self.catalog, self.runtime, self.sessions = _service(
            self.root, {self.project}
        )
        self.owner = SessionPrincipal("resume-owner")
        self.loop_thread = threading.get_ident()
        payload, status = await self.service.open(
            {"project_path": str(self.project)}, self.owner, actor_id=self.owner.user_id
        )
        self.assertEqual(status, 200)
        self.session_id = payload["session_id"]
        record = self.catalog.get(self.session_id)
        assert record is not None
        self.assertEqual(record.principal_id, self.owner.user_id)
        attempt = "resume-io-binding"
        self.catalog.begin_open(self.session_id, attempt)
        self.catalog.bind_open(
            self.session_id,
            attempt,
            RuntimeBinding(
                product_session_id=self.session_id,
                runtime_id=RUNTIME_ID,
                adapter_version="1",
                runtime_version="0.147.0",
                protocol_version="2",
                protocol_schema_hash="resume-io-schema",
                opaque_session_ref="retained-thread",
                capabilities=CapabilitySet(),
            ),
        )
        self.sessions.pop(self.session_id)
        self.runtime.opens.clear()
        self.hub = ChangeHub("resume-io")
        self.catalog.observe = lambda connection: observe_chat(connection, self.hub, shared=True)
        self.service._events.observe = self.catalog.observe

    async def resume(self, principal: SessionPrincipal | None = None):
        return await self.service.open(
            {"resume_session_id": self.session_id},
            principal or self.owner,
            actor_id="gateway-actor",
        )

    async def test_cold_and_warm_restore_keep_sqlite_and_validation_off_loop(self) -> None:
        observed_threads = []
        observe = NotificationConnection.observe
        is_project = self.service._workspaces.is_project
        writable_roots = self.service._writable_roots
        readiness = self.runtime.readiness
        runtime_open = self.runtime.open

        def observe_in_worker(connection, *args, **kwargs):
            self.assertNotEqual(threading.get_ident(), self.loop_thread)
            observed_threads.append(threading.get_ident())
            return observe(connection, *args, **kwargs)

        def validate_in_worker(*args, **kwargs):
            self.assertNotEqual(threading.get_ident(), self.loop_thread)
            return is_project(*args, **kwargs)

        def roots_in_worker(*args, **kwargs):
            self.assertNotEqual(threading.get_ident(), self.loop_thread)
            return writable_roots(*args, **kwargs)

        async def readiness_on_loop(**kwargs):
            self.assertEqual(threading.get_ident(), self.loop_thread)
            return await readiness(**kwargs)

        async def open_on_loop(**kwargs):
            self.assertEqual(threading.get_ident(), self.loop_thread)
            return await runtime_open(**kwargs)

        with (
            patch.object(NotificationConnection, "observe", observe_in_worker),
            patch.object(self.service._workspaces, "is_project", validate_in_worker),
            patch.object(self.service, "_writable_roots", roots_in_worker),
            patch.object(self.runtime, "readiness", readiness_on_loop),
            patch.object(self.runtime, "open", open_on_loop),
        ):
            cold, cold_status = await self.resume()
            warm, warm_status = await self.resume()
        self.assertEqual((cold_status, warm_status), (200, 200))
        self.assertEqual(cold["session_id"], warm["session_id"])
        self.assertEqual(cold["runtime_workdir"], str(self.project))
        self.assertEqual(self.runtime.opens[0]["resume_vendor_thread_id"], "retained-thread")
        self.assertEqual(self.runtime.opens[0]["user_id"], "gateway-actor")
        self.assertEqual(len(self.runtime.opens), 1)
        self.assertTrue(observed_threads)
        self.assertFalse(self.service._activities.snapshot().counts)

    async def test_slow_restore_does_not_block_catalog_loading(self) -> None:
        entered, release = threading.Event(), threading.Event()
        require = self.catalog.require

        def blocked_require(*args):
            self.assertNotEqual(threading.get_ident(), self.loop_thread)
            entered.set()
            if not release.wait(RESUME_WORKER_WAIT_SECONDS):
                raise TimeoutError("restore worker was not released")
            return require(*args)

        with patch.object(self.catalog, "require", blocked_require):
            task = asyncio.create_task(self.resume())
            try:
                started = await asyncio.to_thread(entered.wait, RESUME_WORKER_WAIT_SECONDS)
                if not started:
                    await task
                self.assertTrue(started)
                listing = await asyncio.wait_for(
                    self.service.list(60, self.owner), RESUME_WORKER_WAIT_SECONDS
                )
                self.assertEqual(listing["total"], 1)
                self.assertFalse(task.done())
            finally:
                release.set()
                if task.done() and not task.cancelled():
                    task.exception()
                restored, status = await task
        self.assertEqual(status, 200)
        self.assertEqual(restored["session_id"], self.session_id)

    async def test_blocked_cold_restore_allows_new_and_independent_cold_sessions(self) -> None:
        other, status = await self.service.open({}, self.owner, actor_id=self.owner.user_id)
        self.assertEqual(status, 200)
        other_id = other["session_id"]
        self.sessions.pop(other_id)
        self.runtime.opens.clear()
        entered, release = threading.Event(), threading.Event()
        require = self.catalog.require

        def blocked_require(session_id, principal):
            if session_id == self.session_id:
                self.assertNotEqual(threading.get_ident(), self.loop_thread)
                entered.set()
                if not release.wait(RESUME_WORKER_WAIT_SECONDS):
                    raise TimeoutError("fixture did not release the cold-session catalog read")
            return require(session_id, principal)

        tasks = []
        with patch.object(self.catalog, "require", blocked_require):
            opening = asyncio.create_task(self.resume())
            tasks.append(opening)
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, RESUME_WORKER_WAIT_SECONDS))
                duplicate = asyncio.create_task(self.resume())
                new = asyncio.create_task(
                    self.service.open({}, self.owner, actor_id=self.owner.user_id)
                )
                independent = asyncio.create_task(
                    self.service.open(
                        {"resume_session_id": other_id}, self.owner, actor_id=self.owner.user_id
                    )
                )
                tasks.extend((duplicate, new, independent))
                _, pending = await asyncio.wait((new, independent), timeout=1)
                self.assertFalse(pending, "an unrelated session open waited on the cold read")
                self.assertEqual(new.result()[1], 200)
                self.assertEqual(independent.result()[0]["session_id"], other_id)
                self.assertFalse(opening.done())
                self.assertFalse(duplicate.done())
            finally:
                release.set()
                await asyncio.gather(*tasks)
        self.assertEqual(duplicate.result()[0]["session_id"], self.session_id)
        self.assertEqual(
            sum(item["session_id"] == self.session_id for item in self.runtime.opens), 1
        )

    async def test_repeated_cancel_waits_for_worker_and_retains_session_guard(self) -> None:
        entered, release = threading.Event(), threading.Event()
        require = self.catalog.require

        def blocked_require(*args):
            self.assertNotEqual(threading.get_ident(), self.loop_thread)
            entered.set()
            if not release.wait(RESUME_WORKER_WAIT_SECONDS):
                raise TimeoutError("restore worker was not released")
            return require(*args)

        gate = self.service._activities
        with patch.object(self.catalog, "require", blocked_require):
            task = asyncio.create_task(self.resume())
            try:
                started = await asyncio.to_thread(entered.wait, RESUME_WORKER_WAIT_SECONDS)
                if not started:
                    await task
                self.assertTrue(started)
                generation = gate.begin()
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.sleep(0)
                self.assertTrue(self.service._operations.session(self.session_id).locked())
                self.assertFalse(task.done())
                self.assertGreater(gate.snapshot().counts.get(ActivityDomain.RUNTIME.value, 0), 0)
                self.assertFalse(gate.seal(generation))
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, RESUME_WORKER_WAIT_SECONDS)
        await asyncio.wait_for(gate.wait_business_drained(generation), RESUME_WORKER_WAIT_SECONDS)
        self.assertFalse(self.service._operations.session(self.session_id).locked())
        self.assertFalse(self.runtime.opens)
        self.assertTrue(gate.seal(generation))

    async def test_new_session_cannot_be_resumed_before_its_activation_finishes(self) -> None:
        entered: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        release = asyncio.Event()
        activate = _Live.activate

        async def delayed_activate(live):
            if not entered.done():
                entered.set_result(live.id)
                await release.wait()
            await activate(live)

        with patch.object(_Live, "activate", delayed_activate):
            new = asyncio.create_task(
                self.service.open({}, self.owner, actor_id=self.owner.user_id)
            )
            duplicate = None
            try:
                session_id = await asyncio.wait_for(entered, RESUME_WORKER_WAIT_SECONDS)
                self.assertIsNotNone(self.catalog.get(session_id))
                duplicate = asyncio.create_task(
                    self.service.open(
                        {"resume_session_id": session_id},
                        self.owner,
                        actor_id=self.owner.user_id,
                    )
                )
                await asyncio.sleep(0)
                self.assertFalse(duplicate.done())
                self.assertEqual(len(self.runtime.opens), 1)
            finally:
                release.set()
                created, status = await new
                if duplicate is not None:
                    reopened, reopen_status = await duplicate
        self.assertEqual((status, reopen_status), (200, 200))
        self.assertEqual(created["session_id"], reopened["session_id"])
        self.assertEqual(len(self.runtime.opens), 1)

    async def test_cancelled_activation_drains_before_reopening_same_session(self) -> None:
        entered, closing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        activate = _Live.activate

        async def delayed_activate(live):
            if not entered.is_set():
                entered.set()
                await asyncio.Event().wait()
            await activate(live)

        async def delayed_close(_live):
            closing.set()
            await release.wait()

        with (
            patch.object(_Live, "activate", delayed_activate),
            patch.object(_Live, "aclose", delayed_close),
        ):
            opening = asyncio.create_task(self.resume())
            duplicate = None
            try:
                await asyncio.wait_for(entered.wait(), RESUME_WORKER_WAIT_SECONDS)
                opening.cancel()
                await asyncio.wait_for(closing.wait(), RESUME_WORKER_WAIT_SECONDS)
                opening.cancel()
                duplicate = asyncio.create_task(self.resume())
                await asyncio.sleep(0)
                self.assertFalse(duplicate.done())
                self.assertNotIn(self.session_id, self.sessions)
                self.assertEqual(len(self.runtime.opens), 1)
            finally:
                release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await opening
                if duplicate is not None:
                    reopened, status = await duplicate
        self.assertEqual(status, 200)
        self.assertEqual(reopened["session_id"], self.session_id)
        self.assertEqual(len(self.runtime.opens), 2)

    async def test_cancelled_open_keeps_cancelled_error_when_cleanup_fails(self) -> None:
        for existing in (False, True):
            with self.subTest(existing=existing):
                entered = asyncio.get_running_loop().create_future()

                async def blocked_activate(live):
                    entered.set_result(live.id)
                    await asyncio.Event().wait()

                with (
                    patch.object(_Live, "activate", blocked_activate),
                    patch.object(_Live, "aclose", side_effect=OSError("close failed")),
                ):
                    opening = asyncio.create_task(
                        self.resume()
                        if existing
                        else self.service.open({}, self.owner, actor_id=self.owner.user_id)
                    )
                    session_id = await asyncio.wait_for(entered, RESUME_WORKER_WAIT_SECONDS)
                    opening.cancel("client disconnected")
                    with self.assertRaisesRegex(asyncio.CancelledError, "client disconnected"):
                        await opening
                    self.assertTrue(self.sessions[session_id].closing)
                    _, status = await self.service.open(
                        {"resume_session_id": session_id}, self.owner, actor_id=self.owner.user_id
                    )
                    self.assertEqual(status, 409)

    async def test_failed_cleanup_retains_owner_and_blocks_duplicate_runtime(self) -> None:
        with (
            patch.object(_Live, "activate", side_effect=RuntimeError("activation failed")),
            patch.object(_Live, "aclose", side_effect=OSError("close failed")),
            self.assertRaisesRegex(OSError, "close failed"),
        ):
            await self.resume()
        self.assertTrue(self.sessions[self.session_id].closing)
        _, status = await self.resume()
        self.assertEqual(status, 409)
        self.assertEqual(len(self.runtime.opens), 1)

    async def test_denied_owner_and_unregistered_project_do_not_open_runtime(self) -> None:
        denied, denied_status = await self.resume(SessionPrincipal("foreign"))
        self.assertEqual((denied_status, denied["error"]), (404, "session_not_found"))
        with patch.object(self.service._workspaces, "is_project", return_value=False):
            denied, denied_status = await self.resume()
        self.assertEqual(denied_status, 409)
        self.assertEqual(denied["error"], SESSION_PROJECT_NOT_REGISTERED_ERROR)
        self.assertFalse(self.runtime.opens)
        self.assertFalse(self.service._activities.snapshot().counts)

    async def test_archived_session_remains_rejected_before_runtime_open(self) -> None:
        self.catalog.set_archived(self.session_id, self.owner, True)
        payload, status = await self.resume()
        self.assertEqual(status, 409)
        self.assertFalse(self.runtime.opens)
        record = self.catalog.get(self.session_id)
        assert record is not None
        self.assertTrue(record.archived)
        self.assertFalse(self.service._activities.snapshot().counts)

    async def test_directory_access_failure_keeps_binding_and_releases_workers(self) -> None:
        binding = self.catalog.activation(self.session_id)
        with patch.object(
            self.service, "_writable_roots", side_effect=PermissionError("directory denied")
        ):
            payload, status = await self.resume()
        self.assertEqual(status, 500)
        self.assertFalse(self.runtime.opens)
        self.assertEqual(self.catalog.activation(self.session_id), binding)
        self.assertFalse(self.service._activities.snapshot().counts)
        self.assertFalse(self.service._operations.session(self.session_id).locked())

    async def test_model_recovery_keeps_resolution_on_loop_and_write_durable(self) -> None:
        self.catalog.set_model(self.session_id, self.owner, "retired-selection")
        actors = []

        def select_model(model_id, *, user_id):
            self.assertEqual(threading.get_ident(), self.loop_thread)
            self.assertEqual(model_id, "retired-selection")
            actors.append(user_id)
            return "available-selection"

        with patch.object(self.runtime, "selected_model_key", select_model):
            payload, status = await self.resume()
        self.assertEqual(status, 200)
        self.assertEqual(actors, ["gateway-actor"])
        self.assertEqual(payload["runtime"]["model_id"], "available-selection")
        self.assertEqual(
            self.catalog.model_state(self.session_id).selected_model_id, "available-selection"
        )

    async def test_recovery_status_commit_still_delivers_notifications(self) -> None:
        self.catalog.update_status(self.session_id, SessionStatus.RUNNING)
        notifications = cast(AsyncGenerator[str, None], self.hub.events(self.owner.user_id))
        await anext(notifications)
        try:
            payload, status = await self.resume()
            frame = await asyncio.wait_for(anext(notifications), RESUME_WORKER_WAIT_SECONDS)
        finally:
            await notifications.aclose()
        self.assertEqual(status, 200)
        self.assertIn('"topic":"sessions"', frame)
        record = self.catalog.get(self.session_id)
        assert record is not None
        self.assertEqual(record.status, SessionStatus.INTERRUPTED)
        self.assertFalse(payload["running"])
        self.assertFalse(self.service._activities.snapshot().counts)


def main() -> int:
    print("native Codex session workspace contract")
    writable_root_access_contract()
    asyncio.run(scenario())
    result = unittest.TextTestRunner().run(
        unittest.defaultTestLoader.loadTestsFromTestCase(ResumeIOContracts)
    )
    print(f"passed={PASS} failed={FAIL}")
    return 1 if FAIL or not result.wasSuccessful() else 0


if __name__ == "__main__":
    raise SystemExit(main())
