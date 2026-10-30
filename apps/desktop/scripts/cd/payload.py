"""Package a frozen Windows app tree, excluding explicitly detached archives.

Build-only writer: the caller must run archive_inventory.py on the result before
publishing build evidence. It neither extracts downloads nor authorizes updates.
"""

from __future__ import annotations

import argparse
import os
import stat
import zipfile
from pathlib import Path

CHUNK_BYTES = 1024 * 1024
COMPRESSION_LEVEL = 6
REPRODUCIBLE_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


def attributes(path: Path) -> tuple[int, int, int, int, int]:
    info = path.lstat()
    if getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError("payload_reparse_point")
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError("payload_file_type")
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns


def snapshot(root: Path) -> dict[str, tuple[int, int, int, int, int]]:
    root_info = attributes(root)
    if not stat.S_ISDIR(root_info[2]):
        raise ValueError("payload_root_type")
    result = {"": root_info}

    def failed(error: OSError) -> None:
        raise error

    for parent, directories, files in os.walk(root, followlinks=False, onerror=failed):
        for name in sorted(directories + files):
            path = Path(parent) / name
            result[path.relative_to(root).as_posix()] = attributes(path)
    return result


def package(
    root: Path,
    output: Path,
    entry: str,
    excluded: list[str],
    excluded_trees: list[str] | None = None,
    *,
    prefix: str = "",
    reproducible: bool = False,
) -> None:
    # Inputs belong to the isolated build. Reject links and observe changes, but
    # do not claim this is a hostile-directory OS snapshot or a runtime sandbox.
    root = Path(os.path.abspath(root))
    output = Path(os.path.abspath(output))
    if os.name == "nt":
        # Keep extended paths throughout scanning/opening; ZIP names stay relative.
        def extended(value: Path) -> Path:
            raw = str(value)
            if raw.startswith("\\\\?\\"):
                return value
            return Path("\\\\?\\UNC\\" + raw[2:] if raw.startswith("\\\\") else "\\\\?\\" + raw)

        root, output = extended(root), extended(output)
    before = snapshot(root)
    excluded_trees = excluded_trees or []
    if prefix and (prefix not in {"python", "texlive", "powershell"} or excluded or excluded_trees or not reproducible):
        raise ValueError("payload_component_selection")
    if not entry or entry not in before or not stat.S_ISREG(before[entry][2]):
        raise ValueError("payload_entry_missing")
    if len(set(excluded)) != len(excluded) or entry in excluded:
        raise ValueError("payload_exclusion")
    for name in excluded:
        if name not in before or not stat.S_ISREG(before[name][2]):
            raise ValueError("payload_exclusion")
    for name in excluded_trees:
        if name not in before or not stat.S_ISDIR(before[name][2]) or entry.startswith(name + "/"):
            raise ValueError("payload_exclusion")
    if output.resolve().is_relative_to(root.resolve()):
        raise ValueError("payload_output_inside_input")
    with output.open("xb") as stream:
        with zipfile.ZipFile(
            stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=COMPRESSION_LEVEL
        ) as archive:
            for name, expected in sorted(before.items()):
                if (not name and not prefix) or name in excluded or any(
                    name == tree or name.startswith(tree + "/") for tree in excluded_trees
                ):
                    continue
                path = root / name
                if attributes(path) != expected:
                    raise ValueError("payload_tree_changed")
                directory = stat.S_ISDIR(expected[2])
                archive_name = f"{prefix}/{name}" if name else prefix
                member = zipfile.ZipInfo.from_file(path, archive_name, strict_timestamps=False)
                member.compress_type = zipfile.ZIP_DEFLATED
                if reproducible:
                    member.date_time = REPRODUCIBLE_ZIP_TIME
                    member.create_system = 3
                    member.external_attr = ((stat.S_IFDIR | 0o755) if directory else (stat.S_IFREG | 0o644)) << 16
                    member.extra = b""
                    member.comment = b""
                if directory:
                    archive.writestr(member, b"")
                else:
                    with (
                        path.open("rb") as source,
                        archive.open(member, "w", force_zip64=True) as dest,
                    ):
                        opened = source.fileno()
                        actual = os.fstat(opened)
                        # Windows path stat derives executable permission bits
                        # from .exe; fstat has no filename. Compare file type and
                        # identity here, and full path attributes before/after.
                        if (
                            actual.st_dev,
                            actual.st_ino,
                            stat.S_IFMT(actual.st_mode),
                            actual.st_size,
                            actual.st_mtime_ns,
                        ) != (
                            expected[0],
                            expected[1],
                            stat.S_IFMT(expected[2]),
                            expected[3],
                            expected[4],
                        ):
                            raise ValueError("payload_tree_changed")
                        remaining = expected[3]
                        while remaining:
                            block = source.read(min(CHUNK_BYTES, remaining))
                            if not block:
                                raise ValueError("payload_tree_changed")
                            dest.write(block)
                            remaining -= len(block)
                        if source.read(1):
                            raise ValueError("payload_tree_changed")
                if attributes(path) != expected:
                    raise ValueError("payload_tree_changed")
        stream.flush()
        os.fsync(stream.fileno())
    if snapshot(root) != before:
        raise ValueError("payload_tree_changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--exclude", action="append", default=[])
    parser.add_argument("--exclude-tree", action="append", default=[])
    parser.add_argument("--prefix", default="")
    parser.add_argument("--reproducible", action="store_true")
    args = parser.parse_args()
    package(
        args.root, args.output, args.entry, args.exclude, args.exclude_tree,
        prefix=args.prefix, reproducible=args.reproducible,
    )
