"""Describe, check and package local plugins without installing or executing them."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from service.capabilities.service.authoring import (
    describe_contract,
    inspect_package,
    validate_request,
)
from service.capabilities.service.dependencies import declaration
from service.capabilities.service.descriptor import MAX_DESCRIPTOR_BYTES
from service.capabilities.service.install import MAX_PACKAGE_BYTES
from service.capabilities.service.package import (
    MAX_FILE_BYTES,
    PACKAGE_MANIFEST,
    PackageError,
    pack_skill,
)
from service.capabilities.service.utils import json_object
from service.platform.vocabulary import BRIDGE_MAX_REQUEST_BYTES

PRODUCT_DISTRIBUTION = "scholarseed"
TEMPORARY_PREFIX = "scholarseed-plugin-author-"
TEMPORARY_ARCHIVE = "plugin.zip"
SUCCESS_EXIT = 0
FAILURE_EXIT = 1


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument(
        "--host-version", help="explicit target version; defaults to the installed host"
    )
    commands = root.add_subparsers(dest="command", required=True)
    describe = commands.add_parser(
        "describe", help="print the plugin descriptor schema; does not grant capabilities"
    )
    describe.add_argument(
        "--identity", action="store_true", help="print only the contract version and digest"
    )
    prepare = commands.add_parser("prepare", help="verify a bundled contract snapshot once")
    prepare.add_argument("snapshot", type=Path)
    validate = commands.add_parser(
        "validate", help="validate request JSON against a local descriptor; no runtime admission"
    )
    validate.add_argument("descriptor", type=Path)
    validate.add_argument("request", type=Path)
    check = commands.add_parser(
        "check", help="check an immutable local package; no install or execution"
    )
    check.add_argument("package", type=Path)
    pack = commands.add_parser(
        "pack", help="build and check a package using the existing Skill packer"
    )
    pack.add_argument("source", type=Path)
    pack.add_argument("--name", required=True)
    pack.add_argument("--version", required=True)
    pack.add_argument("--output", type=Path, required=True)
    pack.add_argument(
        "--dependencies",
        type=Path,
        help="explicit dependency declaration JSON; otherwise preserve source package declaration",
    )
    return root


def _read_package(path: Path) -> bytes:
    with path.open("rb") as stream:
        payload = stream.read(MAX_PACKAGE_BYTES + 1)
    if len(payload) > MAX_PACKAGE_BYTES:
        raise PackageError("package exceeds compressed size limit")
    return payload


def _pack(args: argparse.Namespace, host_version: str) -> dict[str, Any]:
    if not args.source.is_dir():
        raise PackageError("plugin source must be a directory")
    if args.output.exists():
        raise PackageError("output already exists; previous packages are never overwritten")
    if args.output.resolve().is_relative_to(args.source.resolve()):
        raise PackageError("package output must be outside the source directory")
    dependency_path = args.dependencies or args.source / PACKAGE_MANIFEST
    dependencies: dict[str, list[str]] = {}
    if args.dependencies or dependency_path.exists():
        with dependency_path.open("rb") as stream:
            decoded = json_object(stream.read(MAX_FILE_BYTES + 1), limit=MAX_FILE_BYTES)
        if args.dependencies:
            dependencies = declaration(decoded)
        else:
            if "dependencies" not in decoded:
                raise PackageError("source package manifest must declare dependencies")
            dependencies = declaration(decoded["dependencies"])
    with tempfile.TemporaryDirectory(prefix=TEMPORARY_PREFIX) as directory:
        archive = Path(directory) / TEMPORARY_ARCHIVE
        pack_skill(args.source, archive, args.version, dependencies, expected_name=args.name)
        payload = _read_package(archive)
        result = inspect_package(payload, host_version=host_version)
        if result["valid"]:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("xb") as stream:
                stream.write(payload)
            result["output"] = str(args.output)
        return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "describe":
            result = describe_contract()
            if args.identity:
                result = result["identity"]
        elif args.command == "prepare":
            with args.snapshot.open("rb") as stream:
                snapshot = json_object(stream.read(MAX_FILE_BYTES + 1), limit=MAX_FILE_BYTES)
            contract = describe_contract()
            matched = snapshot == contract
            result = {
                "valid": True,
                "matched": matched,
                "identity": contract["identity"],
                "host_version": args.host_version or version(PRODUCT_DISTRIBUTION),
                "authorized": False,
                "runtime_verified": False,
                **({} if matched else {"contract": contract}),
            }
        elif args.command == "validate":
            with args.descriptor.open("rb") as stream:
                descriptor = json_object(
                    stream.read(MAX_DESCRIPTOR_BYTES + 1), limit=MAX_DESCRIPTOR_BYTES
                )
            with args.request.open("rb") as stream:
                request = json_object(
                    stream.read(BRIDGE_MAX_REQUEST_BYTES + 1), limit=BRIDGE_MAX_REQUEST_BYTES
                )
            result = validate_request(descriptor, request)
        else:
            host_version = args.host_version or version(PRODUCT_DISTRIBUTION)
            result = (
                _pack(args, host_version)
                if args.command == "pack"
                else inspect_package(_read_package(args.package), host_version=host_version)
            )
    except (OSError, ValueError, PackageNotFoundError) as exc:
        result = {
            "valid": False,
            "authorized": False,
            "runtime_verified": False,
            "issues": [{"code": "package_invalid", "severity": "error", "message": str(exc)}],
        }
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return SUCCESS_EXIT if result.get("valid", args.command == "describe") else FAILURE_EXIT


if __name__ == "__main__":
    sys.exit(main())
