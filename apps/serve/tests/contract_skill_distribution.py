"""Frozen-input contracts; fixtures do not constitute Skillhub product acceptance."""

from __future__ import annotations

import copy
import platform
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from service.capabilities.service.audit import (
    FINDING_FIELDS,
    audit_passed,
    canonical_digest,
    normalize,
    payload_digest,
)
from service.capabilities.service.distribution import (
    confirm_changes,
    replay,
    security_audits,
    snapshot,
    sync_latest,
)
from service.capabilities.service.manifest import (
    LOCK_SCHEMA,
    atomic_write,
    cache_path,
    load_lock,
    package_for,
    policy_digest,
    validate_lock,
    verify_runtime_target,
)
from service.capabilities.service.package import (
    PACKAGE_MANIFEST,
    PackageError,
    digest,
    json_bytes,
    read_package,
)
from service.capabilities.service.registry import Registry, RegistryError

from .contract_skill_packages import CONFIG, fixture_zip

POLICY = {
    **CONFIG,
    "registry": "fixture",
    "schema": 1,
    "dependencies": {"example": {}},
    "scanners": ["scanner"],
    "network": {
        **CONFIG["network"],
        "scan_timeout_seconds": 0,
        "scan_poll_seconds": 0,
        "snapshot_attempts": 2,
    },
}
TARGET = {"platform": "darwin", "machine": "arm64", "python": "3.12.13"}
COMMIT = "a" * 40
CHECKED_AT = "2026-08-26T00:00:00Z"
REVIEW_POLICY = {"schema": 1, "revision": "a" * 64, "engineSha256": "b" * 64, "activeRecords": []}


def audit_fixture(files: list[dict]) -> dict:
    context = {
        "schema": 1,
        "scan_root": "/tmp/fixture",
        "policy_revision": REVIEW_POLICY["revision"],
        "package_sha256": payload_digest(files),
        "engine_sha256": REVIEW_POLICY["engineSha256"],
        "options_sha256": "c" * 64,
        "original_findings_count": 0,
        "reviewed_findings_count": 0,
        "analyzers_used": ["static_analyzer", "behavioral_analyzer"],
        "limited_payloads": [],
    }
    return {
        "id": 1,
        "scanId": "fixture-scan",
        "scannerType": "scanner",
        "verdict": "SAFE",
        "isSafe": True,
        "findings": [
            {
                "ruleId": "SCAN_CONTEXT",
                "severity": "INFO",
                "analyzer": "skillhub_review",
                "metadata": {"scan_context": context},
            }
        ],
        "findingsCount": 1,
        "maxSeverity": "INFO",
        "scannedAt": CHECKED_AT,
        "policyCheckedAt": CHECKED_AT,
        "reviewPolicy": copy.deepcopy(REVIEW_POLICY),
    }


def reviewed_fixture(files: list[dict]) -> dict:
    audit = audit_fixture(files)
    context = audit["findings"][0]["metadata"]["scan_context"]
    original: dict[str, Any] = {source: None for source in FINDING_FIELDS.values()}
    original.update(
        {
            "id": "fixture-id",
            "rule_id": "FIXTURE_RULE",
            "category": "fixture",
            "title": "Fixture finding",
            "description": "Fixture only",
            "severity": "HIGH",
            "analyzer": "static_analyzer",
            "metadata": {"matched_text": "fixture"},
        }
    )
    key = canonical_digest(
        normalize(
            {name: value for name, value in original.items() if name != "id"}, context["scan_root"]
        )
    )
    record = {
        "id": "fixture-review",
        "package_sha256": context["package_sha256"],
        "engine_sha256": context["engine_sha256"],
        "options_sha256": context["options_sha256"],
        "finding_sha256": key,
        "original_severity": "HIGH",
        "disposition": "false_positive",
        "reviewer": "Fixture",
        "reviewed_at": CHECKED_AT,
        "reason": "Contract fixture only",
        "evidence_path": "fixture.md",
        "evidence_sha256": "d" * 64,
    }
    checksum = canonical_digest(record)
    finding: dict[str, Any] = {
        target: original[source] for target, source in FINDING_FIELDS.items()
    }
    finding.update(
        {
            "severity": "INFO",
            "metadata": {
                **original["metadata"],
                "source_finding_sha256": key,
                "operator_review": {
                    **record,
                    "record_sha256": checksum,
                    "policy_revision": context["policy_revision"],
                    "original_finding": original,
                },
            },
        }
    )
    audit["findings"].append(finding)
    audit["findingsCount"] = 2
    context.update({"original_findings_count": 1, "reviewed_findings_count": 1})
    audit["reviewPolicy"]["activeRecords"] = [checksum]
    return audit


def locked_fixture() -> tuple[dict, bytes]:
    data = fixture_zip()
    package = read_package(data)
    record = {
        "skillId": 1,
        "namespace": "fixture",
        "slug": "example",
        "version": "1.0.0",
        "versionId": 2,
        "fingerprint": package.fingerprint,
        "zip_sha256": digest(data),
        "zip_size": len(data),
        "manifest_sha256": digest(package.files[PACKAGE_MANIFEST].data),
        "files": [item.record(path) for path, item in sorted(package.files.items())],
        "dependencies": {},
        "audits": {
            "scanner": [
                audit_fixture([item.record(path) for path, item in sorted(package.files.items())])
            ]
        },
    }
    return {
        "schema": LOCK_SCHEMA,
        "registry": "fixture",
        "namespace": "fixture",
        "git_commit": COMMIT,
        "target": dict(TARGET),
        "skills": [record],
        "scanners": ["scanner"],
        "dependency_policy_sha256": policy_digest(POLICY),
    }, data


class DistributionContracts(unittest.TestCase):
    def test_review_requires_original_evidence_payload_and_current_membership(self) -> None:
        lock, _ = locked_fixture()
        files = lock["skills"][0]["files"]
        audit = reviewed_fixture(files)
        self.assertTrue(audit_passed(audit, "scanner", files))
        mutations = {
            "revoked": lambda row: row["reviewPolicy"].update(activeRecords=[]),
            "engine_changed": lambda row: row["reviewPolicy"].update(engineSha256="e" * 64),
            "missing_context": lambda row: row["findings"].pop(0),
            "missing_review": lambda row: row["findings"][1]["metadata"].pop("operator_review"),
            "missing_source_hash": lambda row: row["findings"][1]["metadata"].pop(
                "source_finding_sha256"
            ),
            "missing_revision": lambda row: row["findings"][1]["metadata"]["operator_review"].pop(
                "policy_revision"
            ),
            "different_payload": lambda row: row["findings"][0]["metadata"]["scan_context"].update(
                package_sha256="f" * 64
            ),
            "different_options": lambda row: row["findings"][0]["metadata"]["scan_context"].update(
                options_sha256="f" * 64
            ),
            "changed_description": lambda row: (
                row["findings"][1].update(message="changed"),
                row["findings"][1]["metadata"]["operator_review"]["original_finding"].update(
                    description="changed"
                ),
            ),
            "lost_metadata": lambda row: row["findings"][1]["metadata"].pop("matched_text"),
            "wrong_count": lambda row: row.update(findingsCount=0),
            "unreviewed_high": lambda row: row["findings"][1].update(severity="HIGH"),
        }
        for name, mutate in mutations.items():
            candidate = copy.deepcopy(audit)
            mutate(candidate)
            with self.subTest(name=name):
                self.assertFalse(audit_passed(candidate, "scanner", files))
        changed_files = copy.deepcopy(files)
        changed_files[0]["sha256"] = "0" * 64
        self.assertFalse(audit_passed(audit, "scanner", changed_files))
        # Adding an unrelated approved record does not invalidate existing evidence.
        audit["reviewPolicy"]["activeRecords"].append("e" * 64)
        audit["reviewPolicy"]["revision"] = "f" * 64
        self.assertTrue(audit_passed(audit, "scanner", files))

    def test_payload_digest_matches_byte_inventory_not_zip_unix_header(self) -> None:
        files = [
            {"path": "a/x.py", "mode": 0o755, "size": 1, "sha256": "a" * 64},
            {"path": "a-b.py", "mode": 0o644, "size": 2, "sha256": "b" * 64},
        ]
        self.assertEqual(
            payload_digest(files),
            canonical_digest([["a-b.py", 2, "b" * 64], ["a/x.py", 1, "a" * 64]]),
        )
        files[0]["mode"] = 0o644
        self.assertEqual(payload_digest(files), payload_digest(list(reversed(files))))

    def test_lock_requires_exact_commit_and_explicit_product_target(self) -> None:
        lock, _ = locked_fixture()
        self.assertEqual(validate_lock(lock), lock)
        for updates in (
            {"git_commit": "dev"},
            {"target": None},
            {"target": {"platform": "darwin", "machine": "arm64", "python": "3.12"}},
        ):
            with self.subTest(updates=updates), self.assertRaises(PackageError):
                validate_lock({**lock, **updates})

    def test_packaged_python_must_match_build_target(self) -> None:
        lock, _ = locked_fixture()
        lock["target"] = {
            "platform": sys.platform,
            "machine": platform.machine(),
            "python": platform.python_version(),
        }
        verify_runtime_target(lock)
        lock["target"]["python"] = "0.0.0"
        with self.assertRaises(PackageError):
            verify_runtime_target(lock)

    def test_empty_lock_rejected(self) -> None:
        lock, _ = locked_fixture()
        lock["skills"] = []
        with self.assertRaises(PackageError):
            validate_lock(lock)

    def test_safe_requires_completed_matching_audit(self) -> None:
        lock, _ = locked_fixture()
        record = lock["skills"][0]["audits"]["scanner"][0]
        self.assertTrue(audit_passed(record, "scanner"))
        for updates in (
            {"scannedAt": None},
            {"isSafe": False},
            {"scanId": None},
            {"verdict": "BLOCKED"},
        ):
            with self.subTest(updates=updates):
                self.assertFalse(audit_passed({**record, **updates}, "scanner"))
        self.assertFalse(audit_passed(record, "other"))

    def test_blocked_scan_cannot_enter_lock(self) -> None:
        lock, _ = locked_fixture()
        lock["skills"][0]["audits"]["scanner"][0]["verdict"] = "BLOCKED"
        with self.assertRaises(PackageError):
            validate_lock(lock)

    def test_zip_hash_identity_inventory_and_mode(self) -> None:
        lock, data = locked_fixture()
        row = lock["skills"][0]
        self.assertEqual(package_for(row, data).name, "example")
        for field, value in (
            ("zip_sha256", "0" * 64),
            ("version", "2.0.0"),
            ("manifest_sha256", "0" * 64),
        ):
            with self.subTest(field=field), self.assertRaises(PackageError):
                package_for({**row, field: value}, data)
        altered = copy.deepcopy(row)
        altered["files"][0]["mode"] = 0o755
        with self.assertRaises(PackageError):
            package_for(altered, data)

    def test_cache_path_cannot_escape(self) -> None:
        with self.assertRaises(PackageError):
            cache_path(Path("cache"), {"zip_sha256": "../../secret"})

    def test_explicit_offline_replay_checks_all_cached_bytes(self) -> None:
        lock, data = locked_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "skills.lock.json"
            atomic_write(source, json_bytes(lock))
            path = cache_path(root / "cache", lock["skills"][0])
            with self.assertRaises(PackageError):
                replay(source, path.parent, POLICY, None)
            atomic_write(path, data)
            self.assertEqual(replay(source, path.parent, POLICY, None), load_lock(source))
            atomic_write(path, data + b"changed")
            with self.assertRaises(PackageError):
                replay(source, path.parent, POLICY, None)

    def test_dependency_policy_change_rejected_on_replay(self) -> None:
        lock, _ = locked_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "skills.lock.json"
            atomic_write(path, json_bytes(lock))
            with self.assertRaises(PackageError):
                replay(path, path.parent, {**POLICY, "dependencies": {}}, None)

    def test_online_replay_requires_real_unchanged_audit_and_stable_final_policy(self) -> None:
        lock, data = locked_fixture()
        row = lock["skills"][0]
        audit = row["audits"]["scanner"][0]
        with (
            tempfile.TemporaryDirectory() as temporary,
            Registry(POLICY, token="fixture", url="https://hub.example.test") as registry,
        ):
            root = Path(temporary)
            path = root / "skills.lock.json"
            atomic_write(path, json_bytes(lock))
            atomic_write(cache_path(root, row), data)
            with patch.object(registry, "resolve", return_value=row):
                with patch.object(
                    registry, "request", side_effect=[[audit], REVIEW_POLICY, REVIEW_POLICY]
                ):
                    self.assertEqual(replay(path, root, POLICY, registry), lock)
                with (
                    patch.object(
                        registry,
                        "request",
                        side_effect=[
                            [audit],
                            REVIEW_POLICY,
                            {**REVIEW_POLICY, "revision": "f" * 64},
                        ],
                    ),
                    self.assertRaisesRegex(RegistryError, "changed during replay"),
                ):
                    replay(path, root, POLICY, registry)
                with (
                    patch.object(
                        registry,
                        "request",
                        side_effect=[[{**audit, "scanId": "new-scan"}], REVIEW_POLICY],
                    ),
                    self.assertRaisesRegex(RegistryError, "locked scan changed"),
                ):
                    replay(path, root, POLICY, registry)

    def test_dependencies_must_match_manifest_and_reviewed_policy(self) -> None:
        lock, data = locked_fixture()
        lock["skills"][0]["dependencies"] = {"python": ["unreviewed==1.0.0"]}
        with self.assertRaisesRegex(PackageError, "package manifest"):
            package_for(lock["skills"][0], data)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "skills.lock.json"
            atomic_write(path, json_bytes(lock))
            atomic_write(cache_path(root, lock["skills"][0]), data)
            with self.assertRaisesRegex(PackageError, "reviewed policy"):
                replay(path, root, POLICY, None)

    def test_removal_and_rollback_require_snapshot_confirmation(self) -> None:
        lock, _ = locked_fixture()
        row = {**lock["skills"][0], "version": "0.9.0"}
        with self.assertRaises(PackageError):
            confirm_changes([row], lock, None)
        with self.assertRaises(PackageError):
            confirm_changes([], lock, None)
        confirm_changes(lock["skills"], lock, None)

    def test_incomplete_scan_times_out_and_blocked_is_not_retried(self) -> None:
        lock, _ = locked_fixture()
        row = lock["skills"][0]
        with Registry(POLICY, token="fixture", url="https://hub.example.test") as registry:
            for response in (
                [],
                [{"scannedAt": None}],
                [{"scannedAt": "now", "verdict": "BLOCKED"}],
            ):
                with (
                    self.subTest(response=response),
                    patch.object(registry, "request", return_value=response) as request,
                ):
                    with self.assertRaises(RegistryError):
                        security_audits(registry, row)
                    self.assertEqual(request.call_count, 1)

    def test_pagination_inconsistency_rejected(self) -> None:
        with Registry(POLICY, token="fixture", url="https://hub.example.test") as registry:
            with patch.object(
                registry,
                "request",
                side_effect=[
                    {"items": [{"id": 1}], "total": 2, "page": 0},
                    {"items": [{"id": 2}], "total": 3, "page": 1},
                ],
            ):
                with self.assertRaises(RegistryError):
                    registry.pages("/skills")

    def test_snapshot_cannot_mix_namespaces(self) -> None:
        with Registry(POLICY, token="fixture", url="https://hub.example.test") as registry:
            with patch.object(
                registry, "pages", return_value=[{"id": 1, "slug": "example", "namespace": "other"}]
            ):
                with self.assertRaises(RegistryError):
                    snapshot(registry)

    def test_failed_sync_does_not_create_or_overwrite_lock(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            Registry(POLICY, token="fixture", url="https://hub.example.test") as registry,
        ):
            output = Path(temporary) / "skills.lock.json"
            with patch.object(registry, "pages", side_effect=RegistryError("unavailable")):
                with self.assertRaises(RegistryError):
                    sync_latest(registry, output.parent, output, git_commit=COMMIT, target=TARGET)
                self.assertFalse(output.exists())
            atomic_write(output, b"frozen")
            with self.assertRaises(PackageError):
                sync_latest(registry, output.parent, output, git_commit=COMMIT, target=TARGET)
            self.assertEqual(output.read_bytes(), b"frozen")


if __name__ == "__main__":
    unittest.main()
