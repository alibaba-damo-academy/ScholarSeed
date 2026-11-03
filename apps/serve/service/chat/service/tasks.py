"""Current-turn product task identity leases."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.capabilities.service.skills import SKILL_LOGIN_REQUIRED_REASON
from service.platform.bridge import TaskActivate
from service.platform.context import FulltextTaskContext, ProductTaskType
from service.platform.storage import filesystem_path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TaskActivationPolicy:
    """Skill-owned evidence required to activate one product task type."""

    skill_name: str
    binding_file: str
    derived_run_prefix: str
    derived_run_chars: int
    restore_untyped: bool = True
    authorization_lease: bool = True


TASK_ACTIVATION_POLICIES = {
    ProductTaskType.RESEARCH_IDEA: TaskActivationPolicy(
        skill_name="research-idea-partner",
        binding_file=".rip-binding.json",
        derived_run_prefix="rip-",
        derived_run_chars=16,
        restore_untyped=False,
        authorization_lease=False,
    ),
    ProductTaskType.LITERATURE_REVIEW: TaskActivationPolicy(
        skill_name="literature-review",
        binding_file=".slr-binding.json",
        derived_run_prefix="slr-",
        derived_run_chars=16,
    ),
    ProductTaskType.PRECISE_SEARCH: TaskActivationPolicy(
        skill_name="precise-literature-search",
        binding_file=".pls-binding.json",
        derived_run_prefix="pls-",
        derived_run_chars=16,
    ),
}
TASK_LEASE_SOURCE_SKILL_RUN = "skill_run"
TASK_OWNER_MISMATCH_REASON = "task_owner_mismatch"
TASK_BINDING_MAX_BYTES = 16_384
FULLTEXT_TASK_REQUIRED = "fulltext_authorization_task_required"
TASK_LOGIN_REQUIRED_ACTION = (
    "Sign in to ScholarSeed, then continue this task in its original workspace. "
    "Pause the task until login is restored; do not retry authorization while signed out."
)
TASK_RECOVERY_CONTEXT = (
    "ScholarSeed product task recovery for this turn: {state}. "
    "This is product context, not user text. If the user is continuing this task, "
    "use its original workspace and preserved results. Historical failures are not "
    "new attempts: report only actual tool results from this turn. If this request "
    "is unrelated, do not continue the previous task."
)
TASK_ACTIVATION_REQUIRED_ACTION = (
    "Use the scholarseed_bridge model tool for task activate "
    "(capability=task, operation=activate). Read the actual skill and workspace binding "
    "for task_type, skill_name, skill_version, skill_path and the session-workdir-relative "
    "workspace; follow the operation's request schema. Do not guess fields or values. "
    "If no valid binding exists, initialize or restore it through the skill's documented entry. "
    "A workspace launcher does not itself renew this lease. Do not invoke a bridge subprocess. "
    "Retry the checkpoint only after activation succeeds in this turn. "
    "Do not repeat the same failed request while inputs and state are unchanged."
)


@dataclass(frozen=True)
class ProductTaskLease:
    """Verified task identity valid only for one admitted product turn."""

    task_type: ProductTaskType
    turn_id: str
    generation: int
    source: str
    skill_name: str = ""
    skill_version: str = ""
    skill_path: str = ""
    workspace: str = ""
    run_id: str = ""
    persistent_run: bool = False

    def matches_run(self, *, task_type: ProductTaskType, workspace: str, run_id: str) -> bool:
        return (
            self.task_type is task_type
            and self.workspace == workspace
            and self.run_id == run_id
            and bool(run_id)
        )


def task_failure_action(reason: str) -> str:
    return (
        TASK_LOGIN_REQUIRED_ACTION
        if reason == SKILL_LOGIN_REQUIRED_REASON
        else TASK_ACTIVATION_REQUIRED_ACTION
    )


def verified_authorization_context(
    live: Any,
    task_type: ProductTaskType,
    *,
    workspace: str | None = None,
    run_id: str | None = None,
) -> FulltextTaskContext | None:
    policy = TASK_ACTIVATION_POLICIES.get(task_type)
    if policy is None or not policy.authorization_lease:
        return None
    lease = getattr(live, "active_task_lease", None)
    current_task = getattr(live, "current_task", None)
    if (
        lease is None
        or current_task is None
        or current_task.done()
        or lease.task_type is not task_type
        or getattr(live, "active_task_type", "") != task_type.value
        or lease.turn_id != getattr(live, "active_product_turn_id", "")
        or lease.generation != getattr(live, "product_turn_generation", None)
        or not lease.run_id
    ):
        logger.warning(
            "task_authorization_rejected session_id=%s task_type=%s "
            "lease_present=%s task_present=%s task_done=%s lease_type_matches=%s "
            "active_type_matches=%s turn_matches=%s generation_matches=%s run_present=%s "
            "validation=lease turn_id=%s generation=%s lease_turn_id=%s "
            "lease_generation=%s lease_revision=%s",
            live.id,
            task_type.value,
            lease is not None,
            current_task is not None,
            current_task.done() if current_task is not None else None,
            lease.task_type is task_type if lease is not None else None,
            getattr(live, "active_task_type", "") == task_type.value,
            (
                lease.turn_id == getattr(live, "active_product_turn_id", "")
                if lease is not None
                else None
            ),
            (
                lease.generation == getattr(live, "product_turn_generation", None)
                if lease is not None
                else None
            ),
            bool(lease.run_id) if lease is not None else None,
            getattr(live, "active_product_turn_id", ""),
            getattr(live, "product_turn_generation", None),
            lease.turn_id if lease is not None else None,
            lease.generation if lease is not None else None,
            getattr(live, "task_lease_revision", None),
        )
        raise ValueError(FULLTEXT_TASK_REQUIRED)
    if workspace is not None and Path(workspace) != Path(lease.workspace):
        logger.warning(
            "task_authorization_rejected session_id=%s task_type=%s validation=workspace "
            "turn_id=%s generation=%s lease_revision=%s workspace_matches=False",
            live.id,
            task_type.value,
            lease.turn_id,
            lease.generation,
            getattr(live, "task_lease_revision", None),
        )
        raise ValueError("task_workspace_mismatch")
    if run_id is not None and lease.run_id != run_id:
        logger.warning(
            "task_authorization_rejected session_id=%s task_type=%s validation=run "
            "turn_id=%s generation=%s lease_revision=%s run_matches=False",
            live.id,
            task_type.value,
            lease.turn_id,
            lease.generation,
            getattr(live, "task_lease_revision", None),
        )
        raise ValueError("task_run_mismatch")
    if not lease.persistent_run:
        logger.info(
            "task_authorization_verified session_id=%s task_type=%s turn_id=%s "
            "generation=%s lease_revision=%s persistent_run=False",
            live.id,
            task_type.value,
            lease.turn_id,
            lease.generation,
            getattr(live, "task_lease_revision", None),
        )
        return None
    owner_id = str(live.user_id or "")
    project_id = str(live.project_id or "")
    if not owner_id:
        logger.warning(
            "task_authorization_rejected session_id=%s task_type=%s "
            "persistent_run=%s owner_present=%s project_present=%s "
            "validation=ownership turn_id=%s generation=%s lease_revision=%s",
            live.id,
            task_type.value,
            lease.persistent_run,
            bool(owner_id),
            bool(project_id),
            lease.turn_id,
            lease.generation,
            getattr(live, "task_lease_revision", None),
        )
        raise ValueError(FULLTEXT_TASK_REQUIRED)
    logger.info(
        "task_authorization_verified session_id=%s task_type=%s turn_id=%s "
        "generation=%s lease_revision=%s persistent_run=True",
        live.id,
        task_type.value,
        lease.turn_id,
        lease.generation,
        getattr(live, "task_lease_revision", None),
    )
    return FulltextTaskContext(
        owner_id=owner_id,
        project_id=project_id,
        session_id=live.id,
        workdir=os.path.normcase(str(live.runtime_workdir.resolve())),
        task_type=task_type,
        workspace=Path(lease.workspace).as_posix(),
        run_id=lease.run_id,
    )


def fulltext_binding_workspace(live: Any, task_type: ProductTaskType) -> str:
    if task_type not in TASK_ACTIVATION_POLICIES:
        return ""
    verified_authorization_context(live, task_type)
    return Path(live.active_task_lease.workspace).as_posix()


def authorization_context_current(live: Any, task_context: FulltextTaskContext | None) -> bool:
    return task_context is None or (
        task_context.owner_id == str(live.user_id or "")
        and task_context.project_id == str(live.project_id or "")
        and task_context.session_id == live.id
        and task_context.workdir == os.path.normcase(str(live.runtime_workdir.resolve()))
    )


@dataclass(frozen=True)
class _TaskContext:
    turn_id: str
    generation: int
    activity: object
    user_id: str
    task: Any
    lease_revision: int

    @classmethod
    def capture(cls, live: Any) -> _TaskContext:
        return cls(
            live.active_product_turn_id,
            live.product_turn_generation,
            live.turn_activity,
            live.user_id,
            live.current_task,
            live.task_lease_revision,
        )

    def current(self, live: Any) -> bool:
        return (
            bool(self.turn_id)
            and live.active_product_turn_id == self.turn_id
            and live.product_turn_generation == self.generation
            and live.turn_activity is self.activity
            and self.activity is not None
            and live.user_id == self.user_id
            and live.current_task is self.task
            and self.task is not None
            and not self.task.done()
            and not live.interrupting
            and not live.terminating
            and not live.terminated
            and live.task_lease_revision == self.lease_revision
        )


async def activate_task(
    live: Any,
    command: TaskActivate,
    *,
    remember: bool = True,
    caller: Callable[[str], Any] | None = None,
) -> ProductTaskLease:
    task_type = ProductTaskType(command.task_type)
    policy = TASK_ACTIVATION_POLICIES.get(task_type)
    if policy is None or policy.skill_name != command.skill_name:
        raise ValueError("task_skill_mismatch")
    scope = _TaskContext.capture(live)
    if not scope.current(live):
        raise ValueError("task_context_stale")
    relative = Path(command.workspace)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("task_workspace_invalid")
    relative_workspace = relative.as_posix()
    workspace = (live.runtime_workdir / relative).resolve()
    workspace.relative_to(live.runtime_workdir.resolve())
    identity = await live.skill_state_by_name(command.skill_name, force_reload=False)
    if (caller is not None and caller(live.id) is not live) or not scope.current(live):
        raise ValueError("task_context_stale")
    if identity is None:
        raise ValueError("task_skill_unavailable")
    skill_root = Path(str(identity.get("path") or "")).resolve().parent
    if filesystem_path(skill_root).resolve() != filesystem_path(command.skill_path).resolve():
        raise ValueError("task_skill_mismatch")
    if str(identity.get("version") or "") != command.skill_version:
        raise ValueError("task_skill_version_mismatch")
    binding_path = workspace / policy.binding_file
    try:
        if binding_path.is_symlink() or binding_path.resolve().parent != workspace:
            raise ValueError("task_binding_invalid")
        if binding_path.stat().st_size > TASK_BINDING_MAX_BYTES:
            raise ValueError("task_binding_invalid")
        binding = json.loads(binding_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("task_binding_invalid") from error
    if not isinstance(binding, dict):
        raise ValueError("task_binding_invalid")
    bound_skill = binding.get("skill")
    if (
        not isinstance(bound_skill, str)
        or not bound_skill.strip()
        or not Path(bound_skill).is_absolute()
        or filesystem_path(bound_skill).resolve() != filesystem_path(skill_root).resolve()
        or binding.get("version") != command.skill_version
    ):
        raise ValueError("task_binding_mismatch")
    binding_workspace = binding.get("workspace")
    if (
        binding_workspace is not None
        and filesystem_path(str(binding_workspace)).resolve()
        != filesystem_path(workspace).resolve()
    ):
        raise ValueError("task_binding_mismatch")
    run_id = binding.get("run_id")
    persistent_run = isinstance(run_id, str) and bool(run_id)
    if not isinstance(run_id, str) or not run_id:
        run_id = (
            policy.derived_run_prefix
            + sha256(relative_workspace.encode()).hexdigest()[: policy.derived_run_chars]
        )
    if command.run_id is not None and run_id != command.run_id:
        raise ValueError("task_run_mismatch")
    if remember:
        live.catalog.remember_task_binding(
            live.id,
            {
                "owner_id": scope.user_id,
                "command": command.model_copy(
                    update={"run_id": run_id, "workspace": relative_workspace}
                ).model_dump(),
            },
        )
    if not identity.get("active"):
        if remember:
            live.clear_task_lease()
        raise ValueError(str(identity.get("unavailable_reason") or "task_skill_unavailable"))
    lease = ProductTaskLease(
        task_type=task_type,
        turn_id=scope.turn_id,
        generation=scope.generation,
        source=TASK_LEASE_SOURCE_SKILL_RUN,
        skill_name=command.skill_name,
        skill_version=command.skill_version,
        skill_path=str(skill_root),
        workspace=relative_workspace,
        run_id=run_id,
        persistent_run=persistent_run,
    )
    live.set_task_lease(lease)
    logger.info(
        "task_activation_succeeded session_id=%s task_type=%s generation=%s "
        "persistent_run=%s owner_present=%s project_present=%s "
        "turn_id=%s lease_revision=%s skill_version=%s restored=%s",
        live.id,
        task_type.value,
        lease.generation,
        lease.persistent_run,
        bool(live.user_id),
        bool(getattr(live, "project_id", "")),
        lease.turn_id,
        live.task_lease_revision,
        lease.skill_version,
        not remember,
    )
    return lease


async def restore_task_binding(live: Any) -> str:
    binding = live.catalog.task_binding(live.id)
    if binding is None:
        return ""
    scope = _TaskContext.capture(live)
    try:
        command = TaskActivate.model_validate(binding["command"])
        policy = TASK_ACTIVATION_POLICIES.get(ProductTaskType(command.task_type))
        if not live.active_task_type and policy is not None and not policy.restore_untyped:
            return ""
        if live.active_task_type and live.active_task_type != command.task_type:
            return ""
        if binding["owner_id"] != live.user_id:
            identity = await live.skill_state_by_name(command.skill_name, force_reload=False)
            if not scope.current(live):
                return ""
            if (
                identity is not None
                and identity.get("unavailable_reason") == SKILL_LOGIN_REQUIRED_REASON
            ):
                raise ValueError(SKILL_LOGIN_REQUIRED_REASON)
            raise ValueError(TASK_OWNER_MISMATCH_REASON)
        lease = await activate_task(live, command, remember=False)
        state = (
            f"activation succeeded; workspace={lease.workspace!r}, run_id={lease.run_id!r}. "
            "The lease is valid for this turn; execute the next checkpoint before "
            "claiming any new authorization result"
        )
    except (KeyError, OSError, ValueError) as error:
        if not scope.current(live):
            return ""
        live.clear_task_lease()
        reason = str(error)
        state = f"activation failed: {reason}. {task_failure_action(reason)}"
    return TASK_RECOVERY_CONTEXT.format(state=state)
