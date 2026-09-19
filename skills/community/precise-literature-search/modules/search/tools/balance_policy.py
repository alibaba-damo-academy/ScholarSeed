"""Adapt the upstream balanced deadline to this skill's saved dispatch."""
from datetime import datetime, timezone
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from io_utils import read_json

DEFAULT_BUDGET_SECONDS = 3600


def new_policy(seconds=None):
    """Local time allowance and cap-only selection; retain retrieval/reserve rules."""
    import upstream_search_policy
    policy = upstream_search_policy.resolve(
        "balanced", time_budget_minutes=(DEFAULT_BUDGET_SECONDS if seconds is None else seconds) / 60)
    policy["default_time_budget_minutes"] = DEFAULT_BUDGET_SECONDS / 60
    policy["target_wall_minutes"] = "up to %g (budget ceiling, not a runtime target)" % policy["time_budget_minutes"]
    policy.pop("selected_count")
    policy["max_selected_count"] = 20
    policy.pop("tier_budget")
    policy["selection_count_policy"] = "eligibility_only_no_count_or_tier_targets"
    return policy


class RetrievalBudgetExhausted(ValueError):
    pass


def budget_status(work_dir: Path, now: float | None = None) -> dict:
    path = work_dir / "dispatch.json"
    if not path.exists():
        return {"enabled": False}
    dispatch = read_json(path)
    if dispatch.get("profile") != "balance":
        return {"enabled": False}
    policy = dispatch["policy"]
    started = datetime.fromisoformat(dispatch["created_at"].replace("Z", "+00:00")).timestamp()
    current = datetime.now(timezone.utc).timestamp() if now is None else now
    total = policy["time_budget_minutes"] * 60
    reserve = policy["selection_reserve_seconds"]
    remaining = max(0.0, started + total - current)
    return {
        "enabled": True, "mode": "balanced", "policy": policy,
        "total_seconds": total, "elapsed_seconds": max(0, current - started),
        "remaining_seconds": remaining, "selection_reserve_seconds": reserve,
        "retrieval_headroom_seconds": max(0, remaining - reserve),
        "should_finalize": remaining <= reserve,
        "deadline_exceeded": current >= started + total,
    }


def request_timeout(work_dir: Path, timeout: float) -> float:
    budget = budget_status(work_dir)
    if not budget["enabled"]:
        return timeout
    if budget["should_finalize"]:
        raise RetrievalBudgetExhausted("balanced retrieval entered the protected selection reserve")
    return min(timeout, budget["retrieval_headroom_seconds"])
