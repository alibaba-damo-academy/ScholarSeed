"""Resolve a complete Hub snapshot once, verify it, then freeze offline build inputs."""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

from packaging.version import Version

from service.capabilities.service.audit import (
    audit_passed,
    automatic_passed,
    valid_policy,
)
from service.capabilities.service.manifest import (
    IDENTITY_FIELDS,
    LOCK_SCHEMA,
    atomic_write,
    cache_path,
    load_lock,
    package_for,
    policy_digest,
    validate_lock,
    validate_target,
)
from service.capabilities.service.package import (
    PACKAGE_MANIFEST,
    PackageError,
    digest,
    json_bytes,
    read_package,
)
from service.capabilities.service.registry import Registry, RegistryError


def identity(row: dict[str, Any]) -> dict[str, Any]:
    return {field: row[field] for field in IDENTITY_FIELDS}


def snapshot(registry: Registry) -> list[dict[str, Any]]:
    rows = registry.pages("/api/web/skills", namespace=registry.namespace, sort="newest")
    if not rows:
        raise RegistryError("official namespace is empty; refusing an empty build")
    if any(row.get("namespace") != registry.namespace for row in rows):
        raise RegistryError("namespace listing returned another namespace")
    if len({row["id"] for row in rows}) != len(rows) or len({row["slug"] for row in rows}) != len(
        rows
    ):
        raise RegistryError("duplicate skill in namespace listing")
    resolved = []
    for row in sorted(rows, key=lambda item: item["slug"]):
        version = registry.resolve(row["slug"])
        if version["skillId"] != row["id"]:
            raise RegistryError("listing and resolve disagree on skill identity")
        resolved.append(version)
    return resolved


def security_audits(registry: Registry, row: dict[str, Any]) -> dict[str, Any]:
    deadline = time.monotonic() + registry.network["scan_timeout_seconds"]
    while True:
        audits = {}
        complete = True
        for scanner in registry.config["scanners"]:
            result = registry.request(
                "GET",
                f"/api/v1/skills/{row['skillId']}/versions/{row['versionId']}/security-audit",
                params={"scannerType": scanner},
            )
            if not isinstance(result, list):
                raise RegistryError("invalid security audit response")
            if any(
                record.get("scannedAt") and not automatic_passed(record, scanner)
                for record in result
            ):
                verdicts = ",".join(str(record.get("verdict")) for record in result)
                raise RegistryError(
                    f"security scan rejected {row['slug']}@{row['version']}: {scanner}={verdicts}"
                )
            if result and all(automatic_passed(record, scanner) for record in result):
                policy = current_policy(registry, row, scanner)
                result = [
                    {
                        **record,
                        "reviewPolicy": policy,
                        "policyCheckedAt": datetime.now(timezone.utc).isoformat(),
                    }
                    for record in result
                ]
                if not all(audit_passed(record, scanner) for record in result):
                    raise RegistryError(f"security review revoked or invalid: {row['slug']}")
            if not result or not all(audit_passed(record, scanner) for record in result):
                complete = False
            audits[scanner] = result
        if complete:
            return audits
        if time.monotonic() >= deadline:
            raise RegistryError(
                f"security scan incomplete/timed out: {row['slug']}@{row['version']}"
            )
        time.sleep(min(registry.network["scan_poll_seconds"], max(0, deadline - time.monotonic())))


def current_policy(registry: Registry, row: dict[str, Any], scanner: str) -> dict[str, Any]:
    policy = registry.request(
        "GET",
        f"/api/v1/skills/{row['skillId']}/versions/{row['versionId']}/security-audit/policy",
        params={"scannerType": scanner},
    )
    if not valid_policy(policy):
        raise RegistryError("current scanner review policy unavailable or invalid")
    return policy


def policy_snapshot(rows: list[dict[str, Any]]) -> dict[str, Any]:
    policies: dict[str, Any] = {}
    for row in rows:
        for scanner, audits in row["audits"].items():
            for audit in audits:
                policy = audit.get("reviewPolicy")
                if policy is None:
                    continue
                if scanner in policies and policies[scanner] != policy:
                    raise RegistryError("scanner review policy changed during snapshot")
                policies[scanner] = policy
    return policies


def download_version(registry: Registry, resolved: dict[str, Any], cache: Path) -> dict[str, Any]:
    """Content-verified inspection download, not an approval for prebundling."""
    data = registry.download(resolved["downloadUrl"])
    package = read_package(data)
    if (
        package.name != resolved["slug"]
        or package.version != resolved["version"]
        or package.fingerprint != resolved["fingerprint"]
    ):
        raise PackageError("Hub ZIP identity/fingerprint differs from frozen resolve")
    namespace, slug, version = (
        quote(resolved[key], safe="") for key in ("namespace", "slug", "version")
    )
    files = registry.request("GET", f"/api/v1/skills/{namespace}/{slug}/versions/{version}/files")
    expected = sorted(
        (path, len(item.data), digest(item.data)) for path, item in package.files.items()
    )
    actual = sorted((item["filePath"], item["fileSize"], item["sha256"]) for item in files)
    if actual != expected:
        raise PackageError("Hub file inventory differs from downloaded ZIP")
    policy = registry.config["dependencies"].get(package.name)
    if policy is None or package.manifest["dependencies"] != policy:
        raise PackageError(
            f"review dependency policy before building {package.name}@{package.version}"
        )
    row = {
        **identity(resolved),
        "zip_sha256": digest(data),
        "zip_size": len(data),
        "manifest_sha256": digest(package.files[PACKAGE_MANIFEST].data),
        "files": [item.record(path) for path, item in sorted(package.files.items())],
        "dependencies": package.manifest["dependencies"],
    }
    atomic_write(cache_path(cache, row), data)
    return row


def fetch_package(registry: Registry, resolved: dict[str, Any], cache: Path) -> dict[str, Any]:
    audits = security_audits(registry, resolved)
    return {**download_version(registry, resolved, cache), "audits": audits}


def confirm_changes(
    rows: list[dict[str, Any]], previous: dict[str, Any] | None, confirmation: str | None
) -> None:
    if previous is None:
        return
    old = {row["slug"]: row for row in previous["skills"]}
    new = {row["slug"]: row for row in rows}
    removed = sorted(old.keys() - new.keys())
    rollback = [
        name
        for name in old.keys() & new.keys()
        if Version(new[name]["version"]) < Version(old[name]["version"])
        or new[name]["versionId"] < old[name]["versionId"]
    ]
    replaced = [
        name
        for name in old.keys() & new.keys()
        if new[name]["version"] == old[name]["version"]
        and new[name]["fingerprint"] != old[name]["fingerprint"]
    ]
    token = digest(json_bytes([identity(row) for row in rows]))
    if (removed or rollback or replaced) and confirmation != token:
        raise PackageError(
            f"review removals={removed}, rollbacks={sorted(rollback)}, replacements={sorted(replaced)}; "
            f"explicit --confirm-snapshot {token} is required"
        )


def sync_latest(
    registry: Registry,
    cache: Path,
    output: Path,
    *,
    git_commit: str,
    target: dict[str, str],
    previous: Path | None = None,
    confirmation: str | None = None,
) -> dict[str, Any]:
    validate_target(target)
    if output.exists():
        raise PackageError(
            "lock output already exists; create a new build directory instead of overwriting a frozen lock"
        )
    baseline: dict[str, Any] | None = None
    if previous:
        baseline = load_lock(previous)
    if baseline is not None and (baseline["registry"], baseline["namespace"]) != (
        registry.config["registry"],
        registry.namespace,
    ):
        raise PackageError("previous release lock belongs to a different registry/namespace")
    for _attempt in range(registry.network["snapshot_attempts"]):
        resolved = snapshot(registry)
        confirm_changes(resolved, baseline, confirmation)
        rows = [fetch_package(registry, row, cache) for row in resolved]
        initial_policies = policy_snapshot(rows)
        latest = snapshot(registry)
        if [identity(row) for row in resolved] != [identity(row) for row in latest]:
            continue
        names = {row["slug"] for row in rows}
        for row in rows:
            missing = set(row["dependencies"].get("skills", [])) - names
            if missing:
                raise PackageError(f"{row['slug']} requires absent skills: {sorted(missing)}")
            # Recheck scans after downloads; a rescan cannot disappear behind an old SAFE result.
            row["audits"] = security_audits(registry, row)
        if policy_snapshot(rows) != initial_policies:
            continue
        lock = validate_lock(
            {
                "schema": LOCK_SCHEMA,
                "registry": registry.config["registry"],
                "namespace": registry.namespace,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "git_commit": git_commit,
                "target": target,
                "scanners": registry.config["scanners"],
                "dependency_policy_sha256": policy_digest(registry.config),
                "skills": rows,
            }
        )
        atomic_write(output, json_bytes(lock))
        return lock
    raise RegistryError("namespace kept changing during resolution; no lock was written")


def replay(
    lock_path: Path, cache: Path, config: dict[str, Any], registry: Registry | None
) -> dict[str, Any]:
    lock = load_lock(lock_path)
    if (lock["registry"], lock["namespace"]) != (config["registry"], config["namespace"]):
        raise PackageError("lock belongs to a different registry or namespace")
    if (
        lock["dependency_policy_sha256"] != policy_digest(config)
        or lock["scanners"] != config["scanners"]
    ):
        raise PackageError(
            "lock dependency/scanner policy differs from reviewed build configuration"
        )
    checked_rows = []
    for row in lock["skills"]:
        if row["dependencies"] != config["dependencies"].get(row["slug"]):
            raise PackageError(f"locked dependencies differ from reviewed policy: {row['slug']}")
        path = cache_path(cache, row)
        if registry is not None:
            remote = registry.resolve(row["slug"], row["version"])
            if identity(remote) != identity(row):
                raise PackageError(f"remote locked version drifted: {row['slug']}")
            current_audits = security_audits(registry, row)
            checked_rows.append({**row, "audits": current_audits})
            for scanner, audits in row["audits"].items():
                historical = [
                    {
                        key: value
                        for key, value in audit.items()
                        if key not in {"reviewPolicy", "policyCheckedAt"}
                    }
                    for audit in audits
                ]
                current = [
                    {
                        key: value
                        for key, value in audit.items()
                        if key not in {"reviewPolicy", "policyCheckedAt"}
                    }
                    for audit in current_audits[scanner]
                ]
                if historical != current or not all(
                    audit_passed(audit, scanner, row["files"]) for audit in current_audits[scanner]
                ):
                    raise RegistryError(f"locked scan changed, revoked or invalid: {row['slug']}")
            if not path.exists():
                data = registry.download(remote["downloadUrl"])
                package_for(row, data)
                atomic_write(path, data)
        if not path.is_file() or path.is_symlink():
            raise PackageError(f"verified cached ZIP is missing: {row['slug']}")
        package_for(row, path.read_bytes())
    if registry is not None:
        policies = policy_snapshot(checked_rows)
        for scanner, policy in policies.items():
            if current_policy(registry, checked_rows[-1], scanner) != policy:
                raise RegistryError(
                    "scanner review policy changed during replay; retry verification"
                )
    return lock
