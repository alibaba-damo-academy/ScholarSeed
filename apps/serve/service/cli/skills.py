"""Operator-facing Skillhub publishing and build-input commands."""

from __future__ import annotations

import argparse
import getpass
import json
import platform
import subprocess
import sys
import tempfile
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import cast

import httpx

from service.capabilities.service.dependencies import provision_dependencies
from service.capabilities.service.distribution import (
    confirm_changes,
    download_version,
    replay,
    sync_latest,
)
from service.capabilities.service.manifest import atomic_write, load_lock
from service.capabilities.service.package import (
    PackageError,
    digest,
    json_bytes,
    pack_skill,
    read_package,
)
from service.capabilities.service.prebundle import compile_bundled_skills
from service.capabilities.service.registry import (
    Registry,
    RegistryError,
    config_from,
    read_token,
    write_secret,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = REPO_ROOT / "scholarseed_skills" / "registry.json"
TOKEN_LIFETIME_DAYS = 90
TOKEN_PURPOSES = {"read": ["skill:read"], "publish": ["skill:publish"]}
SECRET_FILES = {"read": "read.token", "publish": "publish.token"}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    root.add_argument("--url", help="HTTPS origin or authenticated loopback tunnel")
    root.add_argument("--token-file", type=Path)
    root.add_argument("--namespace", help="explicit operator namespace override")
    verbs = root.add_subparsers(dest="verb", required=True)
    pack = verbs.add_parser("pack", help="normalize a skill directory or one legacy tar.gz")
    pack.add_argument("source", type=Path)
    pack.add_argument(
        "--name", required=True, help="dependency policy key; checked against the package name"
    )
    pack.add_argument("--version", required=True)
    pack.add_argument("--output", type=Path, required=True)
    for verb in ("validate", "publish"):
        command = verbs.add_parser(verb)
        command.add_argument("package", type=Path)
        if verb == "publish":
            command.add_argument(
                "--confirm-sha256",
                help="explicit confirmation of reviewed warnings for this exact ZIP",
            )
    inspect = verbs.add_parser("inspect")
    inspect.add_argument("name")
    inspect.add_argument("--version")
    inspect.add_argument("--audit", action="store_true")
    inspect.add_argument(
        "--download", type=Path, help="content-verified inspection only; does not approve a build"
    )
    rescan = verbs.add_parser(
        "rescan",
        help="platform-admin operation: append a new audit for an immutable stored version",
    )
    rescan.add_argument("name")
    rescan.add_argument("--version", required=True)
    rescan.add_argument("--username", default="admin")
    sync = verbs.add_parser(
        "sync", help="freeze latest, or replay an explicitly supplied immutable lock"
    )
    inputs = sync.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--output", type=Path)
    inputs.add_argument("--lock", type=Path)
    sync.add_argument("--cache", type=Path, required=True)
    sync.add_argument("--git-commit")
    sync.add_argument("--target-platform")
    sync.add_argument("--target-machine")
    sync.add_argument("--target-python")
    sync.add_argument("--previous", type=Path)
    sync.add_argument("--confirm-snapshot")
    sync.add_argument("--offline", action="store_true")
    prepare = verbs.add_parser(
        "prepare", help="freeze, compile and provision a development product skill pack"
    )
    prepare.add_argument("--directory", type=Path, required=True)
    prepare.add_argument("--target", type=Path, required=True)
    prepare.add_argument("--cache", type=Path, required=True)
    prepare.add_argument("--git-commit", required=True)
    prepare.add_argument("--lock", type=Path, help="explicit version replay instead of latest")
    bootstrap = verbs.add_parser(
        "bootstrap", help="admin Session: create a namespace and uniquely named scoped tokens"
    )
    bootstrap.add_argument("--username", default="admin")
    bootstrap.add_argument("--display-name", required=True)
    bootstrap.add_argument("--credential-dir", type=Path, required=True)
    bootstrap.add_argument(
        "--existing-namespace-id",
        type=int,
        help="explicitly approve an inspected existing namespace",
    )
    return root


def bootstrap(args: argparse.Namespace, config: dict) -> dict:
    for filename in SECRET_FILES.values():
        if (args.credential_dir / filename).exists():
            raise RegistryError(
                "credential output already exists; bootstrap will not rotate or overwrite it"
            )
    with Registry(config, url=args.url) as registry:
        registry.login(args.username, getpass.getpass("Skillhub admin password: "))
        spaces = registry.pages("/api/v1/namespaces")
        matches = [space for space in spaces if space["slug"] == registry.namespace]
        if matches:
            space = matches[0]
            if args.existing_namespace_id != space["id"]:
                raise RegistryError(
                    f"namespace already exists (id={space['id']}); inspect ownership before approving its ID"
                )
        else:
            space = registry.request(
                "POST",
                "/api/v1/namespaces",
                json={
                    "slug": registry.namespace,
                    "displayName": args.display_name,
                    "description": "书深桌面应用预制技能与发布版本",
                },
            )
        created = []
        suffix = uuid.uuid4().hex[:12]
        expires = (datetime.now(timezone.utc) + timedelta(days=TOKEN_LIFETIME_DAYS)).isoformat()
        for purpose, scopes in TOKEN_PURPOSES.items():
            token = registry.request(
                "POST",
                "/api/v1/tokens",
                json={
                    "name": f"{registry.namespace}-{purpose}-{suffix}",
                    "scopes": scopes,
                    "expiresAt": expires,
                },
            )
            write_secret(args.credential_dir / SECRET_FILES[purpose], token["token"])
            created.append(
                {
                    "id": token["id"],
                    "name": token["name"],
                    "scopes": scopes,
                    "expiresAt": token["expiresAt"],
                }
            )
        return {
            "namespace": space,
            "tokens": created,
            "existing_namespace_count": len(spaces),
            "credential_directory": str(args.credential_dir),
            "operator": args.username,
        }


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        config = config_from(args.config)
        if args.namespace:
            config = {**config, "namespace": args.namespace}
        if args.verb == "bootstrap":
            result = bootstrap(args, config)
        elif args.verb == "sync":
            if args.offline and not args.lock:
                raise PackageError("offline sync requires an explicit approved --lock")
            if not args.lock and not args.git_commit:
                raise PackageError("latest sync requires --git-commit for build provenance")
            with ExitStack() as stack:
                registry = (
                    None
                    if args.offline
                    else stack.enter_context(
                        Registry(config, token=read_token(args.token_file), url=args.url)
                    )
                )
                lock = (
                    replay(args.lock, args.cache, config, registry)
                    if args.lock
                    else sync_latest(
                        # 走到 latest 分支说明 args.lock 为假, 而上面
                        # `offline and not lock` 的守卫已抛错 —— 故必非 offline/非 None。
                        cast(Registry, registry),
                        args.cache,
                        args.output,
                        git_commit=args.git_commit,
                        target={
                            "platform": args.target_platform,
                            "machine": args.target_machine,
                            "python": args.target_python,
                        },
                        previous=args.previous,
                        confirmation=args.confirm_snapshot,
                    )
                )
                if args.lock and args.previous:
                    previous = load_lock(args.previous)
                    if (previous["registry"], previous["namespace"]) != (
                        lock["registry"],
                        lock["namespace"],
                    ):
                        raise PackageError(
                            "previous delivery and replay lock belong to different collections"
                        )
                    confirm_changes(lock["skills"], previous, args.confirm_snapshot)
                result = {
                    "lock": str(args.lock or args.output),
                    "registry": lock["registry"],
                    "namespace": lock["namespace"],
                    "skills": [f"{row['slug']}@{row['version']}" for row in lock["skills"]],
                }
        elif args.verb == "pack":
            if args.name not in config["dependencies"]:
                raise PackageError(
                    "add and review this skill's dependency policy before publishing"
                )
            package = pack_skill(
                args.source,
                args.output,
                args.version,
                config["dependencies"][args.name],
                expected_name=args.name,
            )
            result = {
                "name": package.name,
                "version": package.version,
                "files": len(package.files),
                "fingerprint": package.fingerprint,
                "zip_sha256": digest(args.output.read_bytes()),
                "source": package.manifest["source"],
                "output": str(args.output),
            }
        elif args.verb == "prepare":
            args.directory.mkdir(parents=True, exist_ok=True)
            directory = Path(tempfile.mkdtemp(prefix="development-", dir=args.directory))
            lock_path = directory / "skills.lock.json"
            with Registry(config, token=read_token(args.token_file), url=args.url) as registry:
                if args.lock:
                    lock = replay(args.lock, args.cache, config, registry)
                    atomic_write(lock_path, json_bytes(lock))
                else:
                    sync_latest(
                        registry,
                        args.cache,
                        lock_path,
                        git_commit=args.git_commit,
                        target={
                            "platform": sys.platform,
                            "machine": platform.machine(),
                            "python": platform.python_version(),
                        },
                    )
            compile_bundled_skills(lock_path, args.cache, args.target)
            report = provision_dependencies(lock_path, args.target)
            atomic_write(directory / "dependencies.json", json_bytes(report))
            result = {
                "lock": str(lock_path),
                "target": str(args.target),
                "skills": len(report["skills"]),
            }
        elif args.verb == "rescan":
            with Registry(config, url=args.url) as registry:
                registry.login(
                    args.username,
                    getpass.getpass("Skillhub admin password: "),
                )
                resolved = registry.resolve(args.name, args.version)
                result = registry.request(
                    "POST",
                    f"/api/v1/admin/skills/versions/{resolved['versionId']}/rescan",
                )
        else:
            with Registry(config, token=read_token(args.token_file), url=args.url) as registry:
                if args.verb == "validate":
                    package = read_package(args.package.read_bytes())
                    result = {
                        "name": package.name,
                        "sha256": digest(args.package.read_bytes()),
                        "validation": registry.validate(args.package),
                    }
                elif args.verb == "publish":
                    result = registry.publish(args.package, args.confirm_sha256)
                else:
                    resolved = registry.resolve(args.name, args.version)
                    result = {key: value for key, value in resolved.items() if key != "downloadUrl"}
                    if args.verb == "inspect" and args.download:
                        downloaded = download_version(registry, resolved, args.download)
                        result["download"] = {
                            key: downloaded[key]
                            for key in ("zip_sha256", "zip_size", "manifest_sha256")
                        }
                        result["download"]["files"] = len(downloaded["files"])
                        result["download"]["approved_for_build"] = False
                    if args.verb == "inspect" and args.audit:
                        result["audits"] = {
                            scanner: registry.request(
                                "GET",
                                f"/api/v1/skills/{resolved['skillId']}/versions/{resolved['versionId']}/security-audit",
                                params={"scannerType": scanner},
                            )
                            for scanner in config["scanners"]
                        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (
        PackageError,
        RegistryError,
        OSError,
        ValueError,
        httpx.HTTPError,
        subprocess.SubprocessError,
    ) as exc:
        # HTTP exceptions may include a signed URL; never print their string.
        message = "Skillhub transport failed" if isinstance(exc, httpx.HTTPError) else str(exc)
        print(f"[skills] ERROR {message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
