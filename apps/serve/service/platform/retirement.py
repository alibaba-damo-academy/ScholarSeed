"""Offline retirement of the legacy account-level coordination directory."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
from pathlib import Path

from service.paths import legacy_coordination_root

_IDENTITY = r"(?:posix-[0-9a-f]{16}-[0-9a-f]{16}|windows-[0-9a-f]{16}-[0-9a-f]{32})"
_SLOT = re.compile(_IDENTITY + r"-(?:(?:admission|occupancy)-[ab]|families|mutations)")
_INDEXES = {"domains-v1", "mutations-v1"}
_SCOPES = {"self", "descendants"}
_QUARANTINE_SUFFIX = ".retired"


def _metadata(path: Path) -> os.stat_result:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f"Linked or redirected entry: {path}")
    return info


def _identity(info: os.stat_result) -> str:
    return f"{info.st_dev}:{info.st_ino}"


def _exists(path: Path) -> bool:
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    return True


def _inventory(path: Path) -> tuple[str, list[Path]]:
    root = _metadata(path)
    if not stat.S_ISDIR(root.st_mode):
        raise ValueError(f"Expected a directory: {path}")
    entries = []
    for entry in path.iterdir():
        info = _metadata(entry)
        if _SLOT.fullmatch(entry.name) and stat.S_ISREG(info.st_mode) and info.st_size == 0 and info.st_nlink == 1:
            entries.append(entry)
        elif entry.name in _INDEXES and stat.S_ISDIR(info.st_mode):
            entries.extend(_empty_index(entry))
        else:
            raise ValueError(f"Unrecognized or nonempty coordination entry: {entry}")
    return _identity(root), entries


def _empty_index(index: Path) -> list[Path]:
    entries = []
    for owner in index.iterdir():
        if not re.fullmatch(_IDENTITY, owner.name) or not stat.S_ISDIR(_metadata(owner).st_mode):
            raise ValueError(f"Unrecognized index entry: {owner}")
        for scope in owner.iterdir():
            if scope.name not in _SCOPES or not stat.S_ISDIR(_metadata(scope).st_mode):
                raise ValueError(f"Unrecognized index scope: {scope}")
            if next(scope.iterdir(), None) is not None:
                raise ValueError(f"Outstanding family or mutation records: {scope}")
            entries.append(scope)
        entries.append(owner)
    entries.append(index)
    return entries


def retire(
    source: Path,
    action: str,
    *,
    expected_identity: str | None = None,
    offline: bool = False,
    verified: bool = False,
) -> dict[str, str | int]:
    """Inspect or retire after external cutover checks establish exclusive access."""
    quarantine = source.with_name(source.name + _QUARANTINE_SUFFIX)
    has_source = _exists(source)
    has_quarantine = _exists(quarantine)
    if has_source and has_quarantine:
        raise ValueError("Legacy directory and quarantine both exist. Inspect the cutover before proceeding.")
    if action not in {"inspect", "quarantine", "purge"}:
        raise ValueError(f"Unknown retirement action: {action}")
    if action != "inspect" and (not offline or not expected_identity):
        raise ValueError("Confirm old processes are stopped and disabled, and supply the inspected identity.")
    if action == "purge" and (not verified or has_source):
        raise ValueError("Purge requires Desktop and Serve verification and an absent legacy path.")
    if not has_source and not has_quarantine:
        return {"state": "absent"}
    target = quarantine if has_quarantine else source
    identity, entries = _inventory(target)
    if action != "inspect" and identity != expected_identity:
        raise ValueError(f"Directory identity changed: {target}")
    if action == "quarantine" and has_source:
        source.rename(quarantine)
        target = quarantine
    if action == "purge":
        for entry in entries:
            if stat.S_ISDIR(_metadata(entry).st_mode):
                entry.rmdir()
            else:
                entry.unlink()
        quarantine.rmdir()
        return {"state": "absent"}
    return {
        "state": "quarantined" if target == quarantine else "legacy",
        "identity": identity,
        "path": str(target),
        "entries": len(entries),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "quarantine", "purge"))
    parser.add_argument("--identity")
    parser.add_argument("--confirm-offline", action="store_true")
    parser.add_argument("--confirm-desktop-and-serve-verified", action="store_true")
    args = parser.parse_args()
    try:
        result = retire(
            legacy_coordination_root(),
            args.action,
            expected_identity=args.identity,
            offline=args.confirm_offline,
            verified=args.confirm_desktop_and_serve_verified,
        )
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
