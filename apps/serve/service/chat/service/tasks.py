"""Current-turn product task identity leases."""

from __future__ import annotations

import json
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any

from service.capabilities.service.skills import SKILL_LOGIN_REQUIRED_REASON
from service.platform.bridge import TaskActivate
from service.platform.context import ProductTaskType


@dataclass(frozen=True)
class TaskActivationPolicy:
    """Skill-owned evidence required to activate one product task type."""

    skill_name: str
    binding_file: str
    derived_run_prefix: str
    derived_run_chars: int


TASK_ACTIVATION_POLICIES = {
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


async def activate_task(
    live: Any, command: TaskActivate, *, remember: bool = True
) -> ProductTaskLease:
    task_type = ProductTaskType(command.task_type)
    policy = TASK_ACTIVATION_POLICIES.get(task_type)
    if policy is None or policy.skill_name != command.skill_name:
        raise ValueError("task_skill_mismatch")
    if not live.active_product_turn_id or live.current_task is None or live.current_task.done():
        raise ValueError("task_context_stale")
    relative = Path(command.workspace)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("task_workspace_invalid")
    workspace = (live.runtime_workdir / relative).resolve()
    workspace.relative_to(live.runtime_workdir.resolve())
    identity = await live.skill_state_by_name(command.skill_name, force_reload=False)
    if identity is None:
        raise ValueError("task_skill_unavailable")
    skill_root = Path(str(identity.get("path") or "")).resolve().parent
    if skill_root != Path(command.skill_path).resolve():
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
    if binding.get("skill") != str(skill_root) or binding.get("version") != command.skill_version:
        raise ValueError("task_binding_mismatch")
    binding_workspace = binding.get("workspace")
    if binding_workspace is not None and Path(str(binding_workspace)).resolve() != workspace:
        raise ValueError("task_binding_mismatch")
    run_id = binding.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        run_id = (
            policy.derived_run_prefix
            + sha256(str(relative).encode()).hexdigest()[: policy.derived_run_chars]
        )
    if command.run_id is not None and run_id != command.run_id:
        raise ValueError("task_run_mismatch")
    if remember:
        live.catalog.remember_task_binding(
            live.id,
            {
                "owner_id": live.user_id,
                "command": command.model_copy(update={"run_id": run_id}).model_dump(),
            },
        )
    if not identity.get("active"):
        live.clear_task_lease()
        raise ValueError(str(identity.get("unavailable_reason") or "task_skill_unavailable"))
    lease = ProductTaskLease(
        task_type=task_type,
        turn_id=live.active_product_turn_id,
        generation=live.product_turn_generation,
        source=TASK_LEASE_SOURCE_SKILL_RUN,
        skill_name=command.skill_name,
        skill_version=command.skill_version,
        skill_path=str(skill_root),
        workspace=str(relative),
        run_id=run_id,
    )
    live.set_task_lease(lease)
    return lease


async def restore_task_binding(live: Any) -> str:
    binding = live.catalog.task_binding(live.id)
    if binding is None:
        return ""
    try:
        command = TaskActivate.model_validate(binding["command"])
        if live.active_task_type and live.active_task_type != command.task_type:
            return ""
        if binding["owner_id"] != live.user_id:
            identity = await live.skill_state_by_name(command.skill_name, force_reload=False)
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
        live.clear_task_lease()
        reason = str(error)
        state = f"activation failed: {reason}. {task_failure_action(reason)}"
    return TASK_RECOVERY_CONTEXT.format(state=state)
