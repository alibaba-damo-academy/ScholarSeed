"""Presentation-only projections; disk artifacts and model inputs stay complete."""

import copy

USAGE_SUMMARY_FIELDS = (
    "scope",
    "source",
    "excluded",
    "requests",
    "totals",
    "usage_complete",
    "timing_note",
)
CUMULATIVE_SUMMARY_FIELDS = ("elapsed_sec", "timing_complete", "timing_scope")


def compact(value):
    result = copy.deepcopy(value)
    # Project only the CLI view: receipts and persisted reports retain every
    # stage/model bucket and invocation, including failures and missing usage.
    usage = result.get("model_usage")
    if isinstance(usage, dict):
        result["model_usage"] = {key: usage[key] for key in USAGE_SUMMARY_FIELDS if key in usage}
        result["model_usage"]["issue_count"] = (
            len(usage["issues"]) if "issues" in usage else usage.get("issue_count", 0)
        )
    cumulative = result.get("cumulative")
    if isinstance(cumulative, dict):
        result["cumulative"] = {
            key: cumulative[key] for key in CUMULATIVE_SUMMARY_FIELDS if key in cumulative
        }
        result["cumulative"]["invocation_count"] = (
            len(cumulative["invocations"])
            if "invocations" in cumulative
            else cumulative.get("invocation_count", 0)
        )
    if result.get('command') == 'init':
        for key in ('created', 'already_present', 'inputs_written', 'non_empty_before_init'):
            result.pop(key, None)
        runtime = result.get('runtime')
        if isinstance(runtime, dict):
            result['runtime'] = {key: runtime[key] for key in ('cli', 'python', 'python_version') if key in runtime}
    # Dependency receipts are local recovery state, not model-facing evidence.
    result.pop("checkpoints", None)

    if result.get('stage') == 'execution_plan':
        for key in ('snapshot','approved_snapshot','target_snapshot','receipt','resolution',
                    'outline_amendment','outline_amendments','local_metadata_updates'):
            result.pop(key,None)
    # Only known redundant payloads are removed. In particular, diagnostics,
    # constraints, evidence-depth counts and publication inspection paths survive.
    if "outline_markdown" in result:
        result.pop("outline", None)
    if "steps" in result:
        steps = []
        for step in result["steps"]:
            summary = {k: v for k, v in step.items() if k != "detail"}
            if step.get("status") not in ("SUCCESS", "SKIPPED"):
                detail = step.get("detail", {})
                summary.update(
                    {
                        k: detail[k]
                        for k in (
                            "code",
                            "message",
                            "status_reason",
                            "issues",
                            "next_action",
                            "log",
                            "report",
                        )
                        if k in detail
                    }
                )
            steps.append(summary)
        result["steps"] = steps
    if isinstance(result.get("result"), dict):
        result["result"] = compact(result["result"])
    if isinstance(result.get("retrieval"), dict):
        result["retrieval"] = compact(result["retrieval"])
    if isinstance(result.get("outside_time_range_retained"), dict):
        result["outside_time_range_retained"] = {
            "count": result["outside_time_range_retained"].get("count", 0)
        }
    if "requests" in result:
        result["requests"] = [
            {
                k: v
                for k, v in row.items()
                if k
                in (
                    "request_id",
                    "stage",
                    "state",
                    "status",
                    "elapsed_sec",
                    "attempt",
                    "error",
                    "message",
                    "output_tokens",
                    "input_tokens",
                    "characters_received",
                    "log_dir",
                )
            }
            for row in result["requests"]
        ]
    return result


def emit(value, full=False):
    import json

    print(json.dumps(value if full else compact(value), ensure_ascii=False, indent=2))
