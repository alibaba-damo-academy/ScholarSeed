"""Current-turn product task identity leases."""

from __future__ import annotations

from dataclasses import dataclass

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
}
TASK_LEASE_SOURCE_SKILL_RUN = "skill_run"


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
