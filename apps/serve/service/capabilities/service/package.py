"""Portable, content-addressed skill packages shared by publishing and builds."""

from __future__ import annotations

import io
import json
import re
import stat
import tarfile
import unicodedata
import zipfile
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

from service.capabilities.domain import PACKAGE_MANIFEST, SKILL_MANIFEST_NAME
from service.capabilities.service.install import (
    MAX_PACKAGE_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    SKILL_NAME_PATTERN,
    parse_skill_frontmatter,
)
from service.capabilities.service.utils import json_object

PRODUCT_METADATA = ".scholarseed.json"
PACKAGE_SCHEMA = 1
FILE_MODE = 0o644
EXECUTABLE_MODE = 0o755
DIRECTORY_MODE = 0o755
MAX_FILES = 500
MAX_ARCHIVE_ENTRIES = 5000
MAX_FILE_BYTES = 10 * 1024 * 1024
VERSION_PATTERN = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?\Z")
SKIP_PARTS = frozenset({"__pycache__", "__MACOSX", ".DS_Store"})
ZIP_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
FRONTMATTER_BOUNDARY = "---"
DESCRIPTION_PREFIX = "description: "
VERSION_PREFIX = "version:"


class PackageError(ValueError):
    """The package cannot be safely or unambiguously distributed."""


@dataclass(frozen=True)
class Payload:
    data: bytes
    mode: int = FILE_MODE

    def record(self, path: str) -> dict[str, Any]:
        return {
            "path": path,
            "size": len(self.data),
            "sha256": digest(self.data),
            "mode": self.mode,
        }


@dataclass(frozen=True)
class SkillPackage:
    name: str
    version: str
    manifest: dict[str, Any]
    files: Mapping[str, Payload]

    @property
    def fingerprint(self) -> str:
        return fingerprint(self.files)


def digest(data: bytes) -> str:
    return sha256(data).hexdigest()


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def fingerprint(files: Mapping[str, Payload]) -> str:
    # Skillhub sorts Java String paths (UTF-16 code units), not Unicode codepoints.
    rows = "".join(
        f"{path}:{digest(files[path].data)}\n"
        for path in sorted(files, key=lambda value: value.encode("utf-16-be"))
    )
    return f"sha256:{digest(rows.encode('utf-8'))}"


def safe_path(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or ".." in path.parts
        or any(character in value for character in ("\\", ":", "\x00"))
        or any(ord(character) < 32 for character in value)
        or path.as_posix() != value
        or any(part.endswith((" ", ".")) for part in path.parts)
    ):
        raise PackageError(f"invalid package path: {value!r}")
    return value


def validate_paths(paths: list[str], directories: list[str] | None = None) -> None:
    seen: dict[str, tuple[str, bool]] = {}
    nodes: dict[str, str] = {}
    for name, is_directory in [(name, False) for name in paths] + [
        (name, True) for name in directories or []
    ]:
        safe_path(name)
        key = unicodedata.normalize("NFC", name).casefold()
        if key in seen:
            raise PackageError(f"duplicate or non-portable path: {name}")
        seen[key] = (name, is_directory)
        parts = PurePosixPath(name).parts
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            normalized = unicodedata.normalize("NFC", prefix).casefold()
            if normalized in nodes and nodes[normalized] != prefix:
                raise PackageError(f"non-portable path spelling: {prefix}")
            nodes[normalized] = prefix
    for key in seen:
        for parent in PurePosixPath(key).parents:
            if str(parent) != "." and parent.as_posix() in seen and not seen[parent.as_posix()][1]:
                raise PackageError(f"file/directory collision: {key}")


def _ignored(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return any(part in SKIP_PARTS or part.startswith("._") for part in parts)


def _check_sizes(files: Mapping[str, Payload]) -> None:
    if not files or len(files) > MAX_FILES:
        raise PackageError(f"package file count must be between 1 and {MAX_FILES}")
    if any(len(item.data) > MAX_FILE_BYTES for item in files.values()):
        raise PackageError("package contains an oversized file")
    if sum(len(item.data) for item in files.values()) > MAX_UNCOMPRESSED_BYTES:
        raise PackageError("package exceeds unpacked size limit")


def normalize_document(text: str, version: str) -> bytes:
    """Preserve the instruction body; repair only the known unquoted description."""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != FRONTMATTER_BOUNDARY:
        raise PackageError("SKILL.md requires frontmatter")
    try:
        end = next(
            index for index, line in enumerate(lines[1:], 1) if line.strip() == FRONTMATTER_BOUNDARY
        )
    except StopIteration as exc:
        raise PackageError("SKILL.md frontmatter is not closed") from exc
    try:
        parse_skill_frontmatter(text)
    except ValueError:
        for index in range(1, end):
            if lines[index].startswith(DESCRIPTION_PREFIX):
                description = lines[index][len(DESCRIPTION_PREFIX) :].rstrip("\r\n")
                lines[index] = (
                    DESCRIPTION_PREFIX + json.dumps(description, ensure_ascii=False) + "\n"
                )
                break
        parse_skill_frontmatter("".join(lines))
    version_lines = [index for index in range(1, end) if lines[index].startswith(VERSION_PREFIX)]
    if len(version_lines) > 1:
        raise PackageError("duplicate frontmatter version")
    if version_lines:
        lines[version_lines[0]] = f'version: "{version}"\n'
    else:
        lines.insert(end, f'version: "{version}"\n')
    return "".join(lines).encode("utf-8")


def _directory_files(source: Path) -> dict[str, Payload]:
    files: dict[str, Payload] = {}
    total = 0
    for path in sorted(source.rglob("*")):
        name = path.relative_to(source).as_posix()
        if _ignored(name):
            continue
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise PackageError(f"unsupported source entry: {name}")
        if path.is_file():
            total += path.stat().st_size
            if (
                path.stat().st_size > MAX_FILE_BYTES
                or total > MAX_UNCOMPRESSED_BYTES
                or len(files) >= MAX_FILES
            ):
                raise PackageError(f"source file too large: {name}")
            mode = EXECUTABLE_MODE if path.stat().st_mode & stat.S_IXUSR else FILE_MODE
            files[name] = Payload(path.read_bytes(), mode)
    return files


def _archive_files(source: Path) -> tuple[dict[str, Payload], dict[str, Any]]:
    if source.stat().st_size > MAX_PACKAGE_BYTES:
        raise PackageError("source archive exceeds compressed size limit")
    files: dict[str, Payload] = {}
    modes: dict[str, int] = {}
    total = 0
    with tarfile.open(source, "r|gz") as archive:
        for index, member in enumerate(archive):
            if index >= MAX_ARCHIVE_ENTRIES:
                raise PackageError("migration archive contains too many entries")
            name = member.name.removeprefix("./").rstrip("/")
            if name in ("", ".") and member.isdir():
                continue
            safe_path(name)
            if not (member.isfile() or member.isdir()):
                raise PackageError(f"unsupported archive entry: {name}")
            total += member.size
            if member.size > MAX_FILE_BYTES or total > MAX_UNCOMPRESSED_BYTES:
                raise PackageError("source archive exceeds file/total size limit")
            if member.isdir() or _ignored(name):
                continue
            if name in files:
                raise PackageError(f"duplicate archive entry: {name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise PackageError(f"unreadable archive entry: {name}")
            files[name] = Payload(
                stream.read(), EXECUTABLE_MODE if member.mode & stat.S_IXUSR else FILE_MODE
            )
            modes[name] = stat.S_IMODE(member.mode)
    validate_paths(list(files))
    roots = [
        PurePosixPath(name).parent
        for name in files
        if PurePosixPath(name).name == SKILL_MANIFEST_NAME
    ]
    if len(roots) != 1:
        raise PackageError("migration archive must contain exactly one skill root")
    root = roots[0]
    selected = {
        PurePosixPath(name).relative_to(root).as_posix(): item
        for name, item in files.items()
        if PurePosixPath(name).is_relative_to(root)
    }
    changed_modes = {
        PurePosixPath(name)
        .relative_to(root)
        .as_posix(): {"source": modes[name], "package": item.mode}
        for name, item in files.items()
        if PurePosixPath(name).is_relative_to(root) and modes[name] != item.mode
    }
    return selected, {
        "archive": source.name,
        "sha256": digest(source.read_bytes()),
        "root": str(root),
        "outside_skill_files": len(files) - len(selected),
        "normalized_modes": changed_modes,
    }


def pack_skill(
    source: Path, output: Path, version: str, dependencies: Mapping[str, Any], *, expected_name: str
) -> SkillPackage:
    if not VERSION_PATTERN.fullmatch(version):
        raise PackageError("an explicit semantic version is required")
    if source.is_symlink():
        raise PackageError("source cannot be a symlink")
    if source.is_dir():
        files, provenance = _directory_files(source), {"kind": "directory"}
    else:
        files, provenance = _archive_files(source)
    for generated in (PACKAGE_MANIFEST, PRODUCT_METADATA):
        files.pop(generated, None)
    if SKILL_MANIFEST_NAME not in files:
        raise PackageError("source skill root has no SKILL.md")
    original_document = files[SKILL_MANIFEST_NAME].data
    document = normalize_document(original_document.decode("utf-8"), version)
    metadata, _body = parse_skill_frontmatter(document.decode("utf-8"))
    name = str(metadata.get("name", ""))
    if not SKILL_NAME_PATTERN.fullmatch(name) or not metadata.get("description"):
        raise PackageError("skill name or description is invalid")
    if name != expected_name:
        raise PackageError("source skill name differs from selected dependency policy")
    files[SKILL_MANIFEST_NAME] = Payload(document)
    validate_paths(list(files))
    manifest = {
        "schema": PACKAGE_SCHEMA,
        "name": name,
        "version": version,
        "source": provenance,
        "source_document_sha256": digest(original_document),
        "dependencies": dict(dependencies),
        "files": [item.record(path) for path, item in sorted(files.items())],
    }
    files[PACKAGE_MANIFEST] = Payload(json_bytes(manifest))
    _check_sizes(files)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite an operator's previous release package.
    with (
        output.open("xb") as stream,
        zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive,
    ):
        for path, item in sorted(files.items()):
            info = zipfile.ZipInfo(path, date_time=ZIP_TIMESTAMP)
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | item.mode) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, item.data)
    return read_package(output.read_bytes())


def read_archive(data: bytes) -> SkillPackage:
    if len(data) > MAX_PACKAGE_BYTES:
        raise PackageError("ZIP exceeds compressed size limit")
    files: dict[str, Payload] = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                raise PackageError("ZIP contains too many entries")
            validate_paths(
                [entry.filename for entry in entries if not entry.is_dir()],
                [entry.filename.rstrip("/") for entry in entries if entry.is_dir()],
            )
            for entry in entries:
                mode = entry.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise PackageError(f"special ZIP entry: {entry.filename}")
                if entry.is_dir():
                    continue
                total += entry.file_size
                if (
                    entry.flag_bits & 1
                    or entry.file_size > MAX_FILE_BYTES
                    or total > MAX_UNCOMPRESSED_BYTES
                ):
                    raise PackageError("ZIP encryption or size violates package limits")
                files[entry.filename] = Payload(archive.read(entry))
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise PackageError("invalid ZIP payload") from exc
    _check_sizes(files)
    if PACKAGE_MANIFEST not in files:
        raise PackageError("ZIP requires root .scholarseed-package.json")
    try:
        manifest = json_object(files[PACKAGE_MANIFEST].data, limit=MAX_FILE_BYTES)
        if manifest["schema"] != PACKAGE_SCHEMA:
            raise PackageError("unsupported package schema")
        rows = manifest["files"]
        validate_paths([row["path"] for row in rows])
        if {row["path"] for row in rows} != set(files) - {PACKAGE_MANIFEST}:
            raise PackageError("package manifest file set differs from ZIP")
        for row in rows:
            path = row["path"]
            item = files[path]
            if row["mode"] not in (FILE_MODE, EXECUTABLE_MODE):
                raise PackageError(f"unsafe declared permissions: {path}")
            if len(item.data) != row["size"] or digest(item.data) != row["sha256"]:
                raise PackageError(f"file integrity mismatch: {path}")
            files[path] = Payload(item.data, row["mode"])
        if not SKILL_NAME_PATTERN.fullmatch(manifest["name"]) or not VERSION_PATTERN.fullmatch(
            manifest["version"]
        ):
            raise PackageError("invalid package name/version")
        if not isinstance(manifest["dependencies"], dict):
            raise PackageError("dependency declaration is required")
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, PackageError):
            raise
        raise PackageError("invalid package manifest") from exc
    return SkillPackage(manifest["name"], manifest["version"], manifest, files)


def read_package(data: bytes) -> SkillPackage:
    package = read_archive(data)
    if SKILL_MANIFEST_NAME not in package.files:
        raise PackageError("ZIP requires root SKILL.md and .scholarseed-package.json")
    try:
        metadata, _body = parse_skill_frontmatter(
            package.files[SKILL_MANIFEST_NAME].data.decode("utf-8")
        )
    except (ValueError, UnicodeError) as exc:
        raise PackageError("invalid package manifest") from exc
    if metadata.get("name") != package.name or metadata.get("version") != package.version:
        raise PackageError("frontmatter identity differs from package manifest")
    if not metadata.get("description"):
        raise PackageError("description and dependency declaration are required")
    return package


def extract_package(package: SkillPackage, target: Path) -> None:
    """Materialize only into a new directory; caller owns atomic activation."""
    target.mkdir(parents=True, exist_ok=False, mode=DIRECTORY_MODE)
    for name, item in package.files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=DIRECTORY_MODE)
        path.write_bytes(item.data)
        path.chmod(item.mode)
