"""Inventory final NuGet members; sign content, not ZIP container metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path
from xml.etree import ElementTree

MAX_ENTRIES = 1_000_000
MAX_EXPANDED_BYTES = 32 * 1024**3
CHUNK_BYTES = 1024 * 1024
MAX_WINDOWS_PATH = 259
INSTALL_ROOT_BUDGET = 80
APPLICATION_PREFIX = "lib/app/"


def inventory(filename: Path) -> dict:
    seen: dict[str, bool] = {}
    directories = set()
    files = []
    total = 0
    version = None
    package_id = None
    application_files = 0
    with zipfile.ZipFile(filename) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > MAX_ENTRIES:
            raise ValueError("invalid Velopack entry count")
        for entry in entries:
            name = entry.filename.rstrip("/")
            parts = name.split("/")
            if entry.orig_filename != entry.filename or not name:
                raise ValueError("ambiguous Velopack member")
            for part in parts:
                device = part.split(".", 1)[0].upper().translate(str.maketrans("¹²³", "123"))
                if (
                    part in ("", ".", "..")
                    or part.endswith((".", " "))
                    or any(ord(c) < 32 or ord(c) == 127 or c in '\\:<>"|?*' for c in part)
                    or device in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"}
                    or (
                        len(device) == 4
                        and device[:3] in {"COM", "LPT"}
                        and device[3] in "123456789"
                    )
                ):
                    raise ValueError(f"unsafe Velopack member: {name}")
            key = name.casefold()
            mode = stat.S_IFMT(entry.external_attr >> 16) if entry.create_system == 3 else 0
            if (
                key in seen
                or entry.flag_bits & 1
                or mode not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)
            ):
                raise ValueError(f"duplicate, encrypted or non-regular Velopack member: {name}")
            for index in range(1, len(parts)):
                ancestor = "/".join(parts[:index]).casefold()
                if ancestor in seen and not seen[ancestor]:
                    raise ValueError("Velopack member ancestor is a file")
                directories.add(ancestor)
            if not entry.is_dir() and key in directories:
                raise ValueError("Velopack member shadows a directory")
            seen[key] = entry.is_dir()
            if entry.is_dir():
                continue
            if name.startswith("lib/") and not name.startswith(APPLICATION_PREFIX):
                raise ValueError(f"unexpected Velopack application prefix: {name}")
            # vpk puts application members below lib/app. The client rechecks
            # actual installation, cache and application staging roots at apply.
            relative = name.removeprefix(APPLICATION_PREFIX)
            if name.startswith(APPLICATION_PREFIX):
                application_files += 1
            if (
                name.startswith(APPLICATION_PREFIX)
                and INSTALL_ROOT_BUDGET
                + len("\\current\\")
                + len(relative.encode("utf-16-le")) // 2
                > MAX_WINDOWS_PATH
            ):
                raise ValueError(f"Velopack application path exceeds build budget: {name}")
            total += entry.file_size
            if total > MAX_EXPANDED_BYTES:
                raise ValueError("Velopack expansion budget exceeded")
            digest = hashlib.sha256()
            size = 0
            with archive.open(entry) as source:
                while block := source.read(CHUNK_BYTES):
                    digest.update(block)
                    size += len(block)
            if size != entry.file_size:
                raise ValueError("Velopack member size mismatch")
            files.append({"path": entry.filename, "size": size, "sha256": digest.hexdigest()})
            if name.endswith(".nuspec") and "/" not in name:
                if version is not None or entry.file_size > CHUNK_BYTES:
                    raise ValueError("multiple Velopack package manifests")
                root = ElementTree.fromstring(archive.read(entry))
                version = next(
                    (node.text for node in root.iter() if node.tag.split("}")[-1] == "version"),
                    None,
                )
                package_id = next(
                    (node.text for node in root.iter() if node.tag.split("}")[-1] == "id"), None
                )
    if not version or not package_id:
        raise ValueError("Velopack package identity missing")
    if not application_files:
        raise ValueError("Velopack application content missing")
    return {
        "version": version,
        "app_id": package_id,
        "files": sorted(files, key=lambda item: item["path"]),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    print(json.dumps(inventory(args.archive), separators=(",", ":")))
