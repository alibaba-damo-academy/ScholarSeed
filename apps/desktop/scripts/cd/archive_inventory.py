"""Measure frozen build-owned component ZIPs without extracting them.

Run with the packaged target interpreter. This is build evidence for the signed
payload manifest, not a runtime extractor or proof of safe activation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path, PurePosixPath

CHUNK_BYTES = 1024 * 1024
MAX_ENTRIES = 1_000_000
MAX_EXPANDED_BYTES = 32 * 1024**3


def member_path(name: str) -> str:
    """Windows components use portable relative names, without aliases or links."""
    normalized = name[:-1] if name.endswith("/") else name
    parts = normalized.split("/")
    if not normalized or PurePosixPath(normalized).is_absolute():
        raise ValueError("component_archive_path")
    for part in parts:
        if part in ("", ".", "..") or part.endswith((".", " ")):
            raise ValueError("component_archive_path")
        if any(ord(char) < 32 or ord(char) == 127 or char in '\\:<>"|?*' for char in part):
            raise ValueError("component_archive_path")
        base = part.split(".", 1)[0].upper().translate(str.maketrans("¹²³", "123"))
        if base in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} or (
            len(base) == 4 and base[:3] in {"COM", "LPT"} and base[3] in "123456789"
        ):
            raise ValueError("component_archive_path")
    return normalized.casefold()


def inventory(
    archive: Path, root: str | None = None, include_files: bool = False
) -> dict[str, object]:
    with archive.open("rb") as source:
        before = source.seek(0, 2)
        if before <= 0:
            raise ValueError("component_archive_empty")
        source.seek(0)
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        source.seek(0)
        expanded = 0
        seen: dict[str, bool] = {}
        tree = []
        with zipfile.ZipFile(source) as zipped:
            entries = zipped.infolist()
            if not entries or len(entries) > MAX_ENTRIES:
                raise ValueError("component_archive_entry_budget")
            for entry in entries:
                if root is not None and entry.filename.rstrip("/").split("/")[0] != root:
                    raise ValueError("component_archive_root")
                if entry.orig_filename != entry.filename:
                    raise ValueError("component_archive_path")
                key = member_path(entry.filename)
                if key in seen or entry.flag_bits & 1:
                    raise ValueError("component_archive_duplicate_or_encrypted")
                mode = stat.S_IFMT(entry.external_attr >> 16) if entry.create_system == 3 else 0
                directory = entry.is_dir()
                if mode not in (0, stat.S_IFDIR if directory else stat.S_IFREG):
                    raise ValueError("component_archive_member_type")
                seen[key] = directory
                if entry.file_size > MAX_EXPANDED_BYTES - expanded:
                    raise ValueError("component_archive_expansion_budget")
                size = 0
                member_digest = hashlib.sha256()
                with zipped.open(entry) as content:
                    while block := content.read(CHUNK_BYTES):
                        member_digest.update(block)
                        size += len(block)
                        if size > entry.file_size or size > MAX_EXPANDED_BYTES - expanded:
                            raise ValueError("component_archive_expansion_budget")
                if size != entry.file_size or directory and size:
                    raise ValueError("component_archive_member_size")
                expanded += size
                tree.append(
                    [
                        entry.filename,
                        "directory" if directory else "file",
                        size,
                        member_digest.hexdigest(),
                    ]
                )
            # A regular file must never double as an implicit parent directory.
            for key in seen:
                parent = PurePosixPath(key).parent
                while str(parent) != ".":
                    if str(parent) in seen and not seen[str(parent)]:
                        raise ValueError("component_archive_parent_type")
                    parent = parent.parent
        source.seek(0)
        if hashlib.file_digest(source, "sha256").hexdigest() != digest or source.tell() != before:
            raise ValueError("component_archive_changed")
    if not expanded:
        raise ValueError("component_archive_empty")
    result = {
        "format": "zip",
        "treeSha256": hashlib.sha256(
            json.dumps(sorted(tree), separators=(",", ":"), ensure_ascii=True).encode("ascii")
        ).hexdigest(),
        "archiveSha256": digest,
        "archiveBytes": before,
        "expandedBytes": expanded,
        "fileCount": len(entries),
    }

    if include_files:
        result["files"] = [
            {"path": name, "size": size, "sha256": digest}
            for name, kind, size, digest in sorted(tree)
            if kind == "file"
        ]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    # Keep roots aligned with COMPONENT_KINDS and *_TREE_DIRNAME in
    # ../runtime/components.cjs; the component cache passes its kind as --root.
    parser.add_argument("--root", choices=("python", "texlive", "powershell"))
    parser.add_argument("--files", action="store_true")
    parser.add_argument("archives", nargs="+")
    args = parser.parse_args()
    print(json.dumps([inventory(Path(name), args.root, args.files) for name in args.archives]))
