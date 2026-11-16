from __future__ import annotations

import argparse
import fnmatch
import json
import ntpath
import os
import stat
import subprocess
import time
import tomllib
from pathlib import Path, PurePosixPath

import yaml

from scripts.ci.docs.frontmatter import split, validate_meta
from scripts.ci.docs.vocabulary import load

SCHEMA_VERSION = 1
PHASE_TIMEOUT = 100
STRUCTURE_TIMEOUT = 60
REPO = Path(__file__).resolve().parents[3]
ADAPTER = Path(__file__).with_name("structure.mjs")
VOCABULARY = Path(__file__).with_name("keywords.yaml")
EXCLUDED = frozenset(
    (
        "node_modules",
        ".venv",
        "vendor",
        "fixture",
        "fixtures",
        "__fixtures__",
        "dist",
        "build",
        "out",
        ".git",
        ".ai",
        ".superpowers",
        ".codex",
        "work-records",
        "skills",
        "prompts",
        "notices",
        "licenses",
        "__pycache__",
    )
)
EXCLUDED_SUBTREES = (PurePosixPath("apps/desktop/release"),)
REQUIRED = (
    "AGENTS.md",
    "README.md",
    "README_zh.md",
    "docs/index.md",
    "apps/desktop/AGENTS.md",
    "apps/desktop/DESIGN.md",
    "apps/desktop/docs/README.md",
    "apps/serve/AGENTS.md",
    "apps/serve/README.md",
    "packages/runtime/README.md",
    "packages/damoatrace/AGENTS.md",
    "packages/damoatrace/README.md",
    "packages/adapters/codex/AGENTS.md",
    "packages/adapters/codex/README.md",
    "docs/runbooks/build.md",
)
NAMED = (
    "apps/desktop/DESIGN.md",
    "apps/desktop/native/README.md",
    "apps/desktop/updater/README.md",
    "docs/runbooks/build.md",
)


def inside(root, target):
    return target.is_relative_to(root)


def relative_path(value):
    if (
        not isinstance(value, str)
        or not value.strip()
        or not PurePosixPath(value).parts
        or "\\" in value
        or ntpath.splitdrive(value)[0]
        or PurePosixPath(value).is_absolute()
        or ".." in PurePosixPath(value).parts
    ):
        raise ValueError(f"invalid repository relative path: {value}")
    return value


def excluded(relative):
    parts = relative.parts
    return (
        any(part in EXCLUDED for part in parts)
        or parts[:2] == ("docs", "superpowers")
        or any(relative.is_relative_to(subtree) for subtree in EXCLUDED_SUBTREES)
    )


def budget(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError("docs phase timeout")
    return remaining


def directory_link(path):
    info = path.lstat()
    reparse = getattr(info, "st_file_attributes", 0) & getattr(
        stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
    )
    return path.is_symlink() or bool(reparse)


def walk(root, directory, deadline, errors):
    if not directory.exists() and not directory.is_symlink():
        return
    budget(deadline)
    if directory_link(directory):
        errors.append(f"{directory.relative_to(root).as_posix()}: directory link/reparse rejected")
        return
    if not directory.is_dir():
        errors.append(f"{directory.relative_to(root).as_posix()}: expected directory")
        return
    for child in sorted(directory.iterdir()):
        budget(deadline)
        if excluded(child.relative_to(root)):
            continue
        if child.is_dir():
            yield from walk(root, child, deadline, errors)
        else:
            yield child


def owners(root, deadline, errors, manifests):
    manifest = root / "pyproject.toml"
    manifests.append("pyproject.toml")
    control(root, manifest)
    data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    workspace = nested(data, ("tool", "uv", "workspace"))
    if (
        not isinstance(workspace, dict)
        or not isinstance(workspace.get("members"), list)
        or not isinstance(workspace.get("exclude", []), list)
    ):
        raise ValueError("invalid uv workspace members/exclude")
    members = [relative_path(value) for value in workspace["members"]]
    exclusions = [relative_path(value) for value in workspace.get("exclude", [])]
    candidates = set()
    for pattern in members:
        budget(deadline)
        matches = list(expand(root, root, PurePosixPath(pattern).parts, deadline))
        if not matches:
            errors.append(f"workspace member has no match: {pattern}")
        for member in matches:
            relative = member.relative_to(root)
            if any(fnmatch.fnmatchcase(relative.as_posix(), pattern) for pattern in exclusions):
                continue
            if excluded(relative):
                continue
            if (
                not relative.parts
                or relative.parts[0] not in ("apps", "packages")
                or not member.is_dir()
            ):
                errors.append(f"invalid workspace owner: {relative}")
                continue
            candidates.add(member)
    result = set()
    for candidate in sorted(candidates):
        relative = candidate.relative_to(root).as_posix()
        if any(
            directory_link(parent)
            for parent in [candidate, *candidate.parents]
            if parent != root and inside(root, parent)
        ) or not inside(root, candidate.resolve()):
            errors.append(f"{relative}: owner directory link rejected")
            continue
        manifests.append(f"{relative}/pyproject.toml")
        try:
            control(root, candidate / "pyproject.toml")
            package = tomllib.loads((candidate / "pyproject.toml").read_text(encoding="utf-8"))
            name = nested(package, ("project", "name"))
            if not isinstance(name, str) or not name.strip():
                raise ValueError("project.name must be nonempty")
            result.add(candidate)
        except (OSError, ValueError) as error:
            errors.append(f"{relative}: {error}")
    applications = root / "apps"
    if applications.exists():
        if directory_link(applications):
            raise ValueError("apps directory link rejected")
        for candidate in sorted(applications.iterdir()):
            budget(deadline)
            if excluded(candidate.relative_to(root)) or not candidate.is_dir():
                continue
            if directory_link(candidate):
                errors.append(f"{candidate.relative_to(root)}: application directory link rejected")
                continue
            package = candidate / "package.json"
            if not package.exists():
                continue
            manifests.append(package.relative_to(root).as_posix())
            try:
                control(root, package)
                data = json.loads(package.read_text(encoding="utf-8"))
                if (
                    not isinstance(data, dict)
                    or not isinstance(data.get("name"), str)
                    or not data["name"].strip()
                ):
                    raise ValueError("package name must be nonempty")
                result.add(candidate)
            except (OSError, ValueError) as error:
                errors.append(f"{package.relative_to(root)}: {error}")
    return sorted(result)


def nested(data, keys):
    value = data
    for key in keys:
        if not isinstance(value, dict):
            raise ValueError(f"invalid manifest mapping at {key}")
        value = value.get(key)
    return value


def expand(root, directory, parts, deadline):
    budget(deadline)
    if not parts:
        yield directory
        return
    if not directory.is_dir() or directory_link(directory):
        return
    pattern, *rest = parts
    if pattern == "**":
        yield from expand(root, directory, rest, deadline)
    for child in sorted(directory.iterdir()):
        budget(deadline)
        if excluded(child.relative_to(root)):
            continue
        if pattern == "**" and child.is_dir() and not directory_link(child):
            yield from expand(root, child, parts, deadline)
        elif fnmatch.fnmatchcase(child.name, pattern):
            yield from expand(root, child, rest, deadline)


def control(root, path):
    if not path.is_file() or not inside(root, path.resolve()):
        raise ValueError(f"{path.relative_to(root)}: invalid or outside root manifest")
    for parent in path.parents:
        if parent == root:
            break
        if directory_link(parent):
            raise ValueError(f"{path.relative_to(root)}: manifest directory link rejected")


def discover(root, required, deadline, errors, manifests):
    paths = set(required)
    for filename in ("AGENTS.md", "README.md", "README_zh.md", *NAMED):
        if (root / filename).exists() or (root / filename).is_symlink():
            paths.add(filename)
    docs = root / "docs"
    if not docs.exists() or not docs.is_dir():
        errors.append("docs: required directory missing or invalid")
    for document in walk(root, docs, deadline, errors):
        if document.suffix == ".md":
            paths.add(document.relative_to(root).as_posix())
    for owner in owners(root, deadline, errors, manifests):
        readme = owner / "README.md"
        if readme.exists() or readme.is_symlink():
            paths.add(readme.relative_to(root).as_posix())
        for parent in [owner, *owner.parents]:
            if not inside(root, parent):
                break
            rules = parent / "AGENTS.md"
            if rules.exists() or rules.is_symlink():
                paths.add(rules.relative_to(root).as_posix())
        for document in walk(root, owner, deadline, errors):
            relative = document.relative_to(owner)
            if document.name == "AGENTS.md" or (
                relative.parts[0] == "docs" and document.suffix == ".md"
            ):
                paths.add(document.relative_to(root).as_posix())
    if not paths:
        errors.append("empty document scope")
    return sorted(paths)


def structure(root, paths, node, deadline, adapter=ADAPTER):
    request = {"schemaVersion": SCHEMA_VERSION, "root": str(root), "paths": paths}
    timeout = min(STRUCTURE_TIMEOUT, budget(deadline))
    try:
        result = subprocess.run(
            [str(node), str(adapter)],
            input=json.dumps(request),
            encoding="utf-8",
            capture_output=True,
            cwd=root,
            timeout=timeout,
            shell=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError("docs structure timeout (child killed and waited)") from error
    except OSError as error:
        raise ValueError(f"docs structure startup failure: {error}") from error
    if result.returncode < 0:
        raise ValueError(f"docs structure signal: {-result.returncode}")
    try:
        receipt = json.loads(result.stdout)
    except ValueError as error:
        raise ValueError(
            f"docs structure invalid JSON (exit {result.returncode}): {result.stderr.strip()}"
        ) from error
    schema_version = receipt.get("schemaVersion") if isinstance(receipt, dict) else None
    if (
        not isinstance(receipt, dict)
        or not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != SCHEMA_VERSION
        or receipt.get("paths") != paths
        or not isinstance(receipt.get("errors"), list)
        or any(not isinstance(error, str) for error in receipt["errors"])
    ):
        raise ValueError("docs structure invalid or incomplete receipt")
    if result.returncode not in (0, 1) or bool(result.returncode) != bool(receipt["errors"]):
        raise ValueError(f"docs structure inconsistent exit: {result.returncode}")
    return receipt["errors"]


def record_paths(root, records):
    accepted = []
    errors = []
    for filename in records:
        try:
            relative_path(filename)
            relative = PurePosixPath(filename)
            if (
                relative.as_posix() != filename
                or relative.parts[0] != "work-records"
                or relative.suffix != ".md"
                or filename in accepted
            ):
                raise ValueError("invalid or duplicate explicit record path")
            target = root
            for part in relative.parts:
                target = target / part
                info = target.lstat()
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(
                    stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
                ):
                    raise ValueError("explicit record symlink/reparse rejected")
            if not stat.S_ISREG(target.lstat().st_mode):
                raise ValueError("explicit record requires an ordinary file")
            accepted.append(filename)
        except (OSError, ValueError) as error:
            errors.append(f"{filename}: {error}")
    return accepted, errors


def check(root, node, required=REQUIRED, records=()):
    root = root.resolve()
    deadline = time.monotonic() + PHASE_TIMEOUT
    errors = []
    manifests = []
    aliases = {}
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "root": str(root),
        "paths": [],
        "aliases": aliases,
        "excludedPurposes": sorted(
            EXCLUDED
            | {"docs/superpowers", "wiki"}
            | {path.as_posix() for path in EXCLUDED_SUBTREES}
        ),
        "exclusionScope": "default discovery only; explicit records are checked",
        "records": [],
        "metadataCount": 0,
        "manifests": manifests,
        "errors": errors,
    }
    try:
        if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
            raise ValueError("node-executable requires an absolute executable ordinary file")
        paths = discover(root, required, deadline, errors, manifests)
        explicit, record_errors = record_paths(root, records)
        errors.extend(record_errors)
        report["records"] = explicit
        paths = sorted(set(paths) | set(explicit))
        report["paths"] = paths
        ids = {}
        metadata_pages = []
        sources = set()
        vocabulary = load(VOCABULARY)
        for filename in paths:
            budget(deadline)
            document = root / filename
            try:
                canonical = document.resolve(strict=True)
                if (
                    not inside(root, canonical)
                    or not canonical.is_file()
                    or canonical.relative_to(root).as_posix() not in paths
                ):
                    raise ValueError("outside scope or nonordinary document target")
                info = document.lstat()
                reparse = getattr(info, "st_file_attributes", 0) & getattr(
                    stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0
                )
                if reparse and not document.is_symlink():
                    raise ValueError("unknown file reparse type")
                if document.is_symlink():
                    aliases[filename] = canonical.relative_to(root).as_posix()
                text = document.read_text(encoding="utf-8")
                if canonical in sources:
                    continue
                sources.add(canonical)
                metadata, _ = split(text)
                if metadata is None:
                    if filename in explicit:
                        errors.append(f"{filename}: explicit record requires nonempty frontmatter")
                    continue
                report["metadataCount"] += 1
                validation = validate_meta(metadata)
                errors.extend(f"{filename}: {error}" for error in validation)
                if validation:
                    continue
                identity = metadata["id"]
                if identity in ids:
                    errors.append(f"{filename}: duplicate id {identity} with {ids[identity]}")
                ids[identity] = filename
                metadata_pages.append((filename, metadata))
                _, unknown = vocabulary.validate(metadata["keywords"])
                errors.extend(f"{filename}: unknown keyword {term}" for term in unknown)
                for reference in metadata.get("code_refs", []):
                    relative_path(reference)
                    target = root / reference
                    if not target.exists() or not inside(root, target.resolve()):
                        errors.append(f"{filename}: missing or outside root code_ref {reference}")
            except (OSError, ValueError, yaml.YAMLError) as error:
                errors.append(f"{filename}: {error}")
        for filename, metadata in metadata_pages:
            errors.extend(
                f"{filename}: missing related id {identity}"
                for identity in metadata.get("related", [])
                if identity not in ids
            )
        if paths:
            errors.extend(structure(root, paths, node, deadline))
    except (OSError, ValueError, yaml.YAMLError) as error:
        errors.append(f"docs check: {error}")
    return report


class SingleSource(argparse.Action):
    def __call__(self, parser, namespace, value, option_string=None):
        if getattr(namespace, self.dest, None) is not None:
            parser.error(f"{option_string} may only be supplied once")
        setattr(namespace, self.dest, value)


def main():
    parser = argparse.ArgumentParser(
        description="Read-only complete Docs gate; prefer pnpm ops ci check docs workspace"
    )
    parser.add_argument("--node-executable", required=True, type=Path, action=SingleSource)
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--record", action="append", default=[])
    args = parser.parse_args()
    result = check(REPO, args.node_executable, records=args.record)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
