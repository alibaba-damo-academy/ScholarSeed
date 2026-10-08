"""State-derived worker recovery, without changing the saved retrieval policy."""
from __future__ import annotations

import json
from pathlib import Path

from platform_support import command_display
from filesystem import canonical_path, filesystem_path, path_exists


class ActionError(ValueError):
    def __init__(self, code, message, *, retryable=False, recovery_action="context"):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.recovery_action = recovery_action


def _read(work, name, default):
    path = work / name
    if not canonical_path(path).is_relative_to(canonical_path(work)):
        raise ValueError("worker state artifact must stay inside its work directory")
    if not path_exists(path):
        return default
    with filesystem_path(path).open(encoding="utf-8") as handle:
        return json.load(handle)


def phase_state(work):
    work = Path(work)
    progress = _read(work, "balance-execution.json", {})
    web = _read(work, "web-execution.json", {}).get("batches", [])
    history = _read(work, "query-log.json", {}).get("queries", [])
    logged = [item for item in history if item.get("source") == "agent_web"]
    current = _read(work, "state.json", {})
    request = _read(work.parent, "request.json", {})
    excluded = {str(value) for value in request.get("exclude_previous_ids", [])}
    papers = _read(work, "pool.json", {}).get("papers", [])
    anchors = {str(paper.get("id", "")).strip() for paper in papers}
    anchors = {identity for identity in anchors if identity.isdigit() and identity not in excluded}
    return {
        "plan_saved": path_exists(work / "plan.json"),
        "search_saved": path_exists(work / "results/iteration-001-search-batch.json"),
        "citations_saved": path_exists(work / "results/iteration-001-citations-batch.json"),
        "search_finished": bool(progress.get("search_finished")),
        "citations_finished": bool(progress.get("completed")),
        "citation_anchor_count": len(anchors),
        "selection_finished": path_exists(work / "selection.json"),
        "web_batch_count": len(web),
        "web_query_count": len(logged),
        "web_accounting": "post_hoc",
        "execution_blocked": any(item.get("status") == "execution_blocked"
                                 for item in current.get("source_details", {}).values()),
    }


def resume_argv(argv):
    """Drop --input from a saved batch.

    Rebuilds from argv rather than re-parsing a rendered command: a round trip
    through the display form destroys the platform rendering (on Windows it turns
    the leading PowerShell call operator into a quoted literal).
    """
    resumed = list(argv)
    if "--input" in resumed:
        index = resumed.index("--input")
        del resumed[index:index + 2]
    return resumed


def guidance(work, budget, commands):
    """Use existing command templates; resume commands never replace a batch."""
    state = phase_state(work)
    allowed = ["context", "overview"]
    notes = {}
    finalizing = bool(budget.get("should_finalize"))
    if not state["selection_finished"]:
        if not finalizing and not state["citations_finished"]:
            if not state["search_finished"]:
                allowed.append("retrieve")
            elif (budget.get("retrieval_headroom_seconds", float("inf")) >= 75
                  and (state["citations_saved"] or state["citation_anchor_count"] >= 2)):
                allowed.append("cite")
        allowed.append("record-web")
        notes["record-web"] = (
            "Record actual Web outcomes after the call, including failures. "
            "Duplicate submissions and classification repairs do not count as new searches. "
            "This accounting cannot enforce Web call limits.")
        if (state["plan_saved"] or finalizing) and not state["execution_blocked"]:
            allowed.append("select")
    next_commands = {}
    for action in allowed:
        if action not in commands:
            continue
        item = dict(commands[action])
        saved = state["search_saved"] if action == "retrieve" else state["citations_saved"] if action == "cite" else False
        if saved:
            item["argv"] = resume_argv(item["argv"])
            item["command"] = command_display(item["argv"])
            item["instruction"] = "Resume the saved batch without --input; its decisions are immutable."
        elif action in {"retrieve", "cite", "select", "record-web"}:
            item["instruction"] = "Write the decision file before executing this command."
        if action in notes:
            item["instruction"] = notes[action]
        next_commands[action] = item
    result = {"allowed_actions": allowed, "next_commands": next_commands, "phase_state": state}
    if state["selection_finished"]:
        result["next_action"] = "Selection is saved; return to the caller for stage completion."
    elif state["execution_blocked"]:
        result["next_action"] = "Resolve the execution environment failure before selection; resume the saved batch only after it is resolved."
    elif finalizing:
        result["next_action"] = "Retrieval budget is closed; preserve available Web evidence and select from the current pool. Never invent unobserved outcomes."
    elif "retrieve" in allowed:
        result["next_action"] = "Continue with retrieve. Pending Web classifications do not block retrieval; resolve one only if a later selection needs that record."
    elif "cite" in allowed:
        result["next_action"] = "Inspect the candidate overview and expand citations when needed. Pending Web classifications do not block citation expansion."
    elif "select" in allowed:
        result["next_action"] = "Review promising candidates and select using their evidence. Classify a pending Web record only if the selection depends on it."
    return result


def preflight(work, action, has_input, budget):
    """Call inside the worker transaction, BEFORE opening/validating new input."""
    if action in {"context", "overview", "read-output"}:
        return
    state = phase_state(work)
    if state["selection_finished"]:
        raise ActionError("selection_complete", "selection is already saved; return to the caller for stage completion")
    if action in {"retrieve", "cite"}:
        finished = state["search_finished"] if action == "retrieve" else state["citations_finished"]
        if finished or state["citations_finished"]:
            raise ActionError("phase_complete", f"{action} phase is complete; inspect the current pool and select")
        if budget.get("should_finalize") or (action == "cite" and budget.get("retrieval_headroom_seconds", float("inf")) < 75):
            raise ActionError("retrieval_budget_closed", "retrieval headroom is exhausted; select from the current pool", recovery_action="select")
        if action == "cite" and not state["search_finished"]:
            raise ActionError("search_required", "complete the saved search phase before citation expansion", recovery_action="retrieve")
        saved = state["search_saved"] if action == "retrieve" else state["citations_saved"]
        if saved and has_input:
            raise ActionError("immutable_batch", "cannot replace saved decisions or phase; resume without --input", recovery_action=action)
        if action == "cite" and not saved and state["citation_anchor_count"] < 2:
            raise ActionError("insufficient_citation_anchors", "citation expansion requires at least two non-excluded numeric PaperHub IDs in the current pool; inspect context before selection")
    if action == "select" and state["execution_blocked"]:
        raise ActionError("execution_blocked", "resolve the execution environment failure before selection")


def error_guidance(work, error, budget, commands):
    """Retryability describes the unchanged failed command, not a corrected one."""
    result = guidance(work, budget, commands)
    default_code = "local_io_error" if isinstance(error, OSError) else "invalid_input"
    code = getattr(error, "code", default_code)
    retryable = getattr(error, "retryable", False)
    recovery = getattr(error, "recovery_action", "context")
    details = getattr(error, "details", None)
    if isinstance(details, dict):
        result["details"] = dict(details)
    recovery_ids = getattr(error, "recovery_ids", None)
    if recovery_ids is None and isinstance(details, dict):
        recovery_ids = details.get("recovery_ids")
    if isinstance(recovery_ids, (list, tuple)) and recovery_ids:
        identities = list(dict.fromkeys(str(identity) for identity in recovery_ids))
        recovery = "context"
        if recovery in result["next_commands"]:
            item = dict(result["next_commands"][recovery])
            item["argv"] = [*item["argv"], "--ids", *identities,
                            "--limit", "1", "--abstract-chars", "4000"]
            item["command"] = command_display(item["argv"])
            item["instruction"] = "Inspect the failed paper and copy its current review_ref and exact displayed evidence."
            result["next_commands"][recovery] = item
    result.update(error_code=code, retryable=retryable, recovery_action=recovery)
    if recovery in result["next_commands"]:
        result["recovery_command"] = result["next_commands"][recovery]["command"]
    return result
