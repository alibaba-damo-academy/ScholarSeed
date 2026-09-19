"""Explicit real Hub migration checks, including content round trips and access denials.

Only preflight requests and read APIs are called: this does not publish/delete skills.
Passing migration checks does not approve packages whose security scans are blocked.
"""

from __future__ import annotations

import argparse
import io
import json
import zipfile
from pathlib import Path

from service.capabilities.service.audit import audit_passed
from service.capabilities.service.distribution import download_version, security_audits, snapshot
from service.capabilities.service.manifest import (
    atomic_write,
    cache_path,
    package_for,
)
from service.capabilities.service.package import MAX_FILES, json_bytes, read_package
from service.capabilities.service.registry import Registry, RegistryError, config_from, read_token

HTTP_BAD_REQUEST = 400
HTTP_FORBIDDEN = 403
INVALID_ENTITY_ID = -1


def limit_package() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "SKILL.md",
            "---\nname: boundary-check\ndescription: file limit boundary test\nversion: 1.0.0\n---\n",
        )
        for index in range(MAX_FILES):
            archive.writestr(f"entries/{index:04d}.txt", "boundary\n")
    return output.getvalue()


def expect_error(registry: Registry, method: str, path: str, status: int, **kwargs: object) -> str:
    try:
        registry.request(method, path, **kwargs)
    except RegistryError as exc:
        if exc.status != status:
            raise AssertionError(f"expected HTTP {status}, got {exc.status}") from exc
        return str(exc)
    raise AssertionError(f"expected HTTP {status}, request unexpectedly succeeded")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--read-token-file", type=Path, required=True)
    parser.add_argument("--publish-token-file", type=Path, required=True)
    parser.add_argument("--packages", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    config = config_from(args.config)
    packages = [read_package(path.read_bytes()) for path in sorted(args.packages.glob("*.zip"))]
    if not packages:
        raise AssertionError("expected real migration packages")
    report: dict = {"migration_passed": False, "build_approved": False, "skills": [], "checks": {}}
    with Registry(config, token=read_token(args.read_token_file), url=args.url) as reader:
        current = snapshot(reader)
        if {item["slug"] for item in current} != {item.name for item in packages}:
            raise AssertionError("Hub namespace differs from migration package set")
        report["checks"]["exact_namespace"] = True
        first = sorted(args.packages.glob("*.zip"))[0]
        report["checks"]["read_token_publish_denied"] = expect_error(
            reader,
            "POST",
            f"/api/cli/v1/skills/{config['namespace']}/publish/validate",
            HTTP_FORBIDDEN,
            files={"file": (first.name, first.read_bytes(), "application/zip")},
            data={"visibility": "NAMESPACE_ONLY"},
        )
        report["checks"]["read_token_delete_denied"] = expect_error(
            reader, "DELETE", f"/api/v1/skills/id/{INVALID_ENTITY_ID}", HTTP_FORBIDDEN
        )
        report["checks"]["read_token_management_denied"] = expect_error(
            reader, "POST", "/api/v1/tokens", HTTP_FORBIDDEN, json={}
        )
        for original in packages:
            resolved = reader.resolve(original.name, original.version)
            downloaded = download_version(reader, resolved, args.cache)
            restored = package_for(downloaded, cache_path(args.cache, downloaded).read_bytes())
            if original.files != restored.files or original.fingerprint != resolved["fingerprint"]:
                raise AssertionError(
                    f"normalized upload/download content or modes differ: {original.name}"
                )
            audits = {
                scanner: reader.request(
                    "GET",
                    f"/api/v1/skills/{resolved['skillId']}/versions/{resolved['versionId']}/security-audit",
                    params={"scannerType": scanner},
                )
                for scanner in config["scanners"]
            }
            audit_error = None
            try:
                audits = security_audits(reader, resolved)
                safe = all(
                    records
                    and all(audit_passed(item, scanner, downloaded["files"]) for item in records)
                    for scanner, records in audits.items()
                )
            except RegistryError as error:
                safe = False
                audit_error = str(error)
            report["skills"].append(
                {
                    "name": original.name,
                    "version": original.version,
                    "skillId": resolved["skillId"],
                    "versionId": resolved["versionId"],
                    "fingerprint": original.fingerprint,
                    "files": len(original.files),
                    "bytes_and_modes_identical": True,
                    "scans_passed": bool(safe),
                    "audit_error": audit_error,
                    "audits": audits,
                    "download_zip_sha256": downloaded["zip_sha256"],
                }
            )
    with Registry(config, token=read_token(args.publish_token_file), url=args.url) as publisher:
        boundary = expect_error(
            publisher,
            "POST",
            f"/api/cli/v1/skills/{config['namespace']}/publish/validate",
            HTTP_BAD_REQUEST,
            files={"file": ("boundary.zip", limit_package(), "application/zip")},
            data={"visibility": "NAMESPACE_ONLY"},
        )
        if "more than 500" not in boundary:
            raise AssertionError("server did not reject at the configured file-count boundary")
        report["checks"]["file_501_rejected"] = boundary
    report["migration_passed"] = True
    report["build_approved"] = all(item["scans_passed"] for item in report["skills"])
    atomic_write(args.report, json_bytes(report))
    print(
        json.dumps(
            {
                "report": str(args.report),
                "migration_passed": report["migration_passed"],
                "build_approved": report["build_approved"],
                "skills": [
                    {key: value for key, value in row.items() if key != "audits"}
                    for row in report["skills"]
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["build_approved"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
