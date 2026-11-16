"""Read existing request receipts; never equate missing usage with zero cost."""

import json
from copy import deepcopy
from pathlib import Path

REQUEST_ROOT = "_logs/llm"
WRITING_STAGES = ("chapter_", "refinement_delta")
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cached_input_tokens")
EXCLUDED = ("main_agent", "search_agent", "precomputed_l1", "paper_processing_outside_request_logs")


def _number(value):
    return value if type(value) is int and value >= 0 else None


def _tokens(usage):
    usage = usage if isinstance(usage, dict) else {}
    details = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
    details = details if isinstance(details, dict) else {}
    return {
        "input_tokens": _number(usage.get("prompt_tokens", usage.get("input_tokens"))),
        "output_tokens": _number(usage.get("completion_tokens", usage.get("output_tokens"))),
        "cached_input_tokens": _number(
            details.get(
                "cached_tokens",
                usage.get("cached_input_tokens", usage.get("cacheReadInputTokensCompatible")),
            )
        ),
    }


def _empty():
    return {
        "attempts": 0,
        "failed_attempts": 0,
        "known_tokens": dict.fromkeys(TOKEN_FIELDS, 0),
        "missing_usage_attempts": dict.fromkeys(TOKEN_FIELDS, 0),
        "attempt_elapsed_sec_sum": 0.0,
        "missing_elapsed_attempts": 0,
    }


def _add(bucket, attempt):
    bucket["attempts"] += 1
    bucket["failed_attempts"] += bool(attempt.get("error") or attempt.get("ok") is False)
    for field, value in _tokens(attempt.get("usage")).items():
        if value is None:
            bucket["missing_usage_attempts"][field] += 1
        else:
            bucket["known_tokens"][field] += value
    elapsed = attempt.get("elapsed_sec")
    if type(elapsed) in (int, float) and elapsed >= 0:
        bucket["attempt_elapsed_sec_sum"] = round(bucket["attempt_elapsed_sec_sum"] + elapsed, 3)
    else:
        bucket["missing_elapsed_attempts"] += 1


def summarize(workspace, stages=None):
    """Counts each request/attempt once, including retries; never returns prompts or response bodies."""
    root = Path(workspace) / REQUEST_ROOT
    totals = _empty()
    groups, issues = {}, []
    requests = 0
    for folder in sorted(root.iterdir()) if root.is_dir() else ():
        if not folder.is_dir():
            continue
        try:
            request = json.loads((folder / "request.json").read_text())
            stage = request.get("stage") or (
                "figures_image" if request.get("figure_id") else "unknown"
            )
            if stages and not any(stage.startswith(prefix) for prefix in stages):
                continue
            model = request.get("model") or request.get("config", {}).get("model", "unknown")
            requests += 1
            # Scripted text calls write both representations. Never add both.
            paths = sorted(
                p
                for p in folder.glob("attempt-*.json")
                if p.stem.removeprefix("attempt-").isdigit()
            )
            attempts = (
                [json.loads(p.read_text()) for p in paths]
                if paths
                else json.loads((folder / "attempts.json").read_text())
            )
            if not isinstance(attempts, list) or not attempts:
                raise ValueError("missing attempts")
            seen = set()
            for attempt in attempts:
                number = attempt.get("attempt")
                if type(number) is not int or number < 1 or number in seen:
                    raise ValueError("invalid or duplicate attempt identity")
                seen.add(number)
                key = (stage, str(attempt.get("model") or model))
                group = groups.setdefault(key, {"stage": key[0], "model": key[1], **_empty()})
                _add(group, attempt)
                _add(totals, attempt)
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            issues.append(
                {
                    "request_id": folder.name,
                    "code": "USAGE_RECEIPT_INCOMPLETE",
                    "reason": type(exc).__name__,
                }
            )
    return {
        "scope": "persisted_workspace_model_requests",
        "source": REQUEST_ROOT,
        "excluded": list(EXCLUDED),
        "requests": requests,
        "totals": totals,
        "by_stage_model": list(groups.values()),
        "issues": issues,
        "usage_complete": not issues and not any(totals["missing_usage_attempts"].values()),
        "timing_note": "attempt_elapsed_sec_sum is summed call time, not wall time; calls may overlap. Deleted receipts cannot be reconstructed.",
    }


def accumulate(previous, current, elapsed):
    """Extend the existing stage status, retaining failures across resumes."""
    previous = previous or {}
    prior = previous.get("cumulative") or {}
    history = deepcopy(prior.get("invocations", []))
    known_elapsed = prior.get(
        "elapsed_sec", previous.get("elapsed_sec", previous.get("duration_sec", 0))
    )
    invocation = {
        "status": current.get("status"),
        "elapsed_sec": round(elapsed, 3),
        "model_calls": current.get("model_calls"),
        "code": current.get("code")
        or (current.get("error") or {}).get("code")
        or (current.get("result") or {}).get("code"),
    }
    attempt_id = current.get("attempt_id")
    if attempt_id:
        invocation["attempt_id"] = attempt_id
        if history and history[-1].get("attempt_id") == attempt_id:
            prior_attempt = history.pop()
            known_elapsed -= prior_attempt.get("elapsed_sec", 0)
    if current.get("phase"):
        invocation["phase"] = current["phase"]
    history.append(invocation)
    return {
        "invocation": invocation,
        "cumulative": {
            "elapsed_sec": round(known_elapsed + elapsed, 3),
            "invocations": history,
            "timing_complete": prior.get("timing_complete", not bool(previous))
            and previous.get("status") != "RUNNING",
            "timing_scope": "recorded_invocations_only; excludes gaps, user waits and other stages",
        },
    }
