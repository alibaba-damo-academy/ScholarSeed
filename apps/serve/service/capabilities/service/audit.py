"""Validate scan evidence against payload bytes and current operator dispositions."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from service.capabilities.service.package import digest

SAFE_VERDICT = "SAFE"
REVIEW_KEY = "operator_review"
CONTEXT_KEY = "scan_context"
IDENTITY_KEY = "source_finding_sha256"
CONTEXT_RULE = "SCAN_CONTEXT"
CONTEXT_ANALYZER = "skillhub_review"
SCHEMA = 1
HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
SEVERITIES = ("SAFE", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL")
BLOCKING_RANK = SEVERITIES.index("HIGH")
RESERVED_KEYS = frozenset({REVIEW_KEY, CONTEXT_KEY, IDENTITY_KEY})
RECORD_FIELDS = frozenset(
    {
        "id",
        "package_sha256",
        "engine_sha256",
        "options_sha256",
        "finding_sha256",
        "original_severity",
        "disposition",
        "reviewer",
        "reviewed_at",
        "reason",
        "evidence_path",
        "evidence_sha256",
    }
)
RECORD_HASHES = (
    "package_sha256",
    "engine_sha256",
    "options_sha256",
    "finding_sha256",
    "evidence_sha256",
)
FINDING_FIELDS = {
    "ruleId": "rule_id",
    "category": "category",
    "severity": "severity",
    "title": "title",
    "message": "description",
    "filePath": "file_path",
    "lineNumber": "line_number",
    "codeSnippet": "snippet",
    "remediation": "remediation",
    "analyzer": "analyzer",
}
ORIGINAL_FIELDS = frozenset({"id", "metadata", *FINDING_FIELDS.values()})


def canonical_digest(value: Any) -> str:
    return digest(
        json.dumps(
            value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")
    )


def payload_digest(files: list[dict[str, Any]]) -> str:
    """Relative POSIX lexical inventory. Manifest bytes bind declared file modes.

    Hub rebuilds ZIP headers without Unix modes; header metadata cannot identify
    scan bytes. The independently validated package manifest preserves modes.
    """
    return canonical_digest(
        [
            [item["path"], item["size"], item["sha256"]]
            for item in sorted(files, key=lambda item: item["path"])
        ]
    )


def normalize(value: Any, root: str) -> Any:
    if isinstance(value, str):
        return value.replace(root + "/", "").replace(root, ".")
    if isinstance(value, list):
        return [normalize(item, root) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item, root) for key, item in value.items()}
    return value


def timestamp(value: str) -> bool:
    return bool(datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo)


def exact_int(value: Any) -> bool:
    """JSON 的 `true` 不能当整数收下: `isinstance(True, int)` 为真, 所以按精确类型判。

    这里校的是 schema 版本号与条目计数, 收下一个布尔值等于放过一份畸形报告。
    """

    return type(value) is int  # noqa: SS003


def scan_context(row: dict[str, Any]) -> dict[str, Any]:
    contexts = [item for item in row["findings"] if item["ruleId"] == CONTEXT_RULE]
    if len(contexts) != 1:
        raise ValueError("exactly one scan provenance record is required")
    finding = contexts[0]
    context = finding["metadata"][CONTEXT_KEY]
    if (
        finding["severity"] != "INFO"
        or finding["analyzer"] != CONTEXT_ANALYZER
        or set(finding["metadata"]) != {CONTEXT_KEY}
        or not exact_int(context["schema"])
        or context["schema"] != SCHEMA
        or any(
            not HASH_PATTERN.fullmatch(context[key])
            for key in ("package_sha256", "engine_sha256", "options_sha256", "policy_revision")
        )
        or not isinstance(context["scan_root"], str)
        or not context["scan_root"].startswith("/")
        or context["scan_root"].endswith("/")
        or not exact_int(context["original_findings_count"])
        or context["original_findings_count"] != len(row["findings"]) - 1
        or not exact_int(context["reviewed_findings_count"])
        or context["reviewed_findings_count"]
        != sum(REVIEW_KEY in item.get("metadata", {}) for item in row["findings"])
        or not isinstance(context["limited_payloads"], list)
        or any(not isinstance(path, str) for path in context["limited_payloads"])
        or not isinstance(context["analyzers_used"], list)
        or not context["analyzers_used"]
        or any(not isinstance(name, str) or not name for name in context["analyzers_used"])
    ):
        raise ValueError("scan provenance is incomplete or contradictory")
    return context


def automatic_passed(row: dict[str, Any], scanner: str) -> bool:
    """A SAFE flag alone is insufficient; the actual findings must agree."""
    try:
        findings = row["findings"]
        ranks = [SEVERITIES.index(item["severity"]) for item in findings]
        maximum = max(ranks, default=0)
        return (
            row.get("scannerType") == scanner
            and row.get("verdict") == SAFE_VERDICT
            and row.get("isSafe") is True
            and timestamp(row["scannedAt"])
            and bool(row.get("id"))
            and bool(row.get("scanId"))
            and isinstance(findings, list)
            and exact_int(row["findingsCount"])
            and row["findingsCount"] == len(findings)
            and row["maxSeverity"] == SEVERITIES[maximum]
            and maximum < BLOCKING_RANK
            and all(rank > 0 for rank in ranks)
            and all(isinstance(item.get("metadata", {}), dict) for item in findings)
            and bool(scan_context(row))
        )
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def valid_policy(policy: dict[str, Any]) -> bool:
    try:
        return (
            exact_int(policy["schema"])
            and policy["schema"] == SCHEMA
            and bool(HASH_PATTERN.fullmatch(policy["revision"]))
            and bool(HASH_PATTERN.fullmatch(policy["engineSha256"]))
            and isinstance(policy["activeRecords"], list)
            and len(policy["activeRecords"]) == len(set(policy["activeRecords"]))
            and all(HASH_PATTERN.fullmatch(value) for value in policy["activeRecords"])
        )
    except (KeyError, TypeError):
        return False


def audit_passed(
    row: dict[str, Any], scanner: str, files: list[dict[str, Any]] | None = None
) -> bool:
    if not automatic_passed(row, scanner):
        return False
    try:
        context = scan_context(row)
        policy = row["reviewPolicy"]
        if (
            not valid_policy(policy)
            or not timestamp(row["policyCheckedAt"])
            or context["engine_sha256"] != policy["engineSha256"]
            or files is not None
            and context["package_sha256"] != payload_digest(files)
        ):
            return False
        seen = set()
        for finding in row["findings"]:
            if finding["ruleId"] == CONTEXT_RULE:
                continue
            metadata = finding["metadata"]
            if CONTEXT_KEY in metadata:
                return False
            original = {source: finding.get(target) for target, source in FINDING_FIELDS.items()}
            original["metadata"] = {
                key: value for key, value in metadata.items() if key not in RESERVED_KEYS
            }
            if REVIEW_KEY in metadata:
                review = metadata[REVIEW_KEY]
                record = {key: review[key] for key in RECORD_FIELDS}
                checksum = canonical_digest(record)
                preserved = review["original_finding"]
                if (
                    set(preserved) != ORIGINAL_FIELDS
                    or not isinstance(preserved["id"], str)
                    or any(
                        not isinstance(value, str) or not value.strip() for value in record.values()
                    )
                    or any(not HASH_PATTERN.fullmatch(record[key]) for key in RECORD_HASHES)
                    or not timestamp(record["reviewed_at"])
                    or record["original_severity"] not in SEVERITIES[1:]
                    or checksum != review["record_sha256"]
                    or checksum not in policy["activeRecords"]
                    or record["disposition"] != "false_positive"
                    or finding["severity"] != "INFO"
                    or review["policy_revision"] != context["policy_revision"]
                    or any(
                        record[key] != context[key]
                        for key in ("package_sha256", "engine_sha256", "options_sha256")
                    )
                ):
                    return False
                original["severity"] = record["original_severity"]
                if original != {key: value for key, value in preserved.items() if key != "id"}:
                    return False
                if record["finding_sha256"] != metadata[IDENTITY_KEY]:
                    return False
            checksum = canonical_digest(normalize(original, context["scan_root"]))
            if checksum in seen or checksum != metadata[IDENTITY_KEY]:
                return False
            seen.add(checksum)
        return True
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
