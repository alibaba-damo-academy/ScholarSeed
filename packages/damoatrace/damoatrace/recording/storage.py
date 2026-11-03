"""Private, process-coordinated evidence file operations."""

from __future__ import annotations

import getpass
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Callable

from filelock import FileLock

from damoatrace.recording.content import (
    CONTENT_FIELDS,
    CONTENT_MARKER,
    inspect_content_versions,
    visible_content,
)

PRIVATE_DIRECTORY_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
LOCK_TIMEOUT_SECONDS = 2
ACL_TIMEOUT_SECONDS = 10
LOCK_SUFFIX = ".lock"
WINDOWS_PLATFORM = "nt"
BUDGET_LOCK_NAME = ".content-budget"


def make_private(path: Path, *, directory: bool = False) -> None:
    if os.name == WINDOWS_PLATFORM:
        rights = "(OI)(CI)F" if directory else "F"
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{getpass.getuser()}:{rights}"],
            check=True,
            capture_output=True,
            timeout=ACL_TIMEOUT_SECONDS,
        )
    else:
        path.chmod(PRIVATE_DIRECTORY_MODE if directory else PRIVATE_FILE_MODE)


def evidence_lock(path: Path) -> FileLock:
    return FileLock(str(path) + LOCK_SUFFIX, timeout=LOCK_TIMEOUT_SECONDS, mode=PRIVATE_FILE_MODE)


def budget_lock(directory: Path) -> FileLock:
    return evidence_lock(directory / BUDGET_LOCK_NAME)


def rewrite_content(path: Path, transform: Callable[[dict], dict]) -> int:
    """Atomic rewrite; callers hold the directory budget lock before this file lock."""
    if not path.exists():
        return 0
    changed = 0
    with evidence_lock(path):
        # Classify the complete file before any transform or replacement. Keep
        # the same file lock through the rewrite so cooperating writers cannot
        # replace validated records with a different content version.
        with path.open(encoding="utf-8") as source:
            inspect_content_versions(source)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        target = Path(temporary)
        try:
            with (
                os.fdopen(descriptor, "w", encoding="utf-8") as output,
                path.open(encoding="utf-8") as source,
            ):
                for line in source:
                    try:
                        record = json.loads(line)
                    except (ValueError, UnicodeError):
                        output.write(line)
                        continue
                    if isinstance(record, dict) and CONTENT_MARKER in record:
                        projected = transform(record)
                        if projected != record:
                            changed += 1
                        record = projected
                    output.write(json.dumps(record, ensure_ascii=False) + "\n")
                output.flush()
                os.fsync(output.fileno())
            if changed:
                make_private(target)
                os.replace(target, path)
        finally:
            target.unlink(missing_ok=True)
    return changed


def purge_content(path: Path, *, all_content: bool = False) -> int:
    """Use the same directory→file lock order as budgeted writers and eviction."""
    if not path.exists():
        return 0

    def project(record: dict) -> dict:
        result = visible_content(
            record, include_content=True, now=float("inf") if all_content else None
        )
        if all_content:
            for field in CONTENT_FIELDS:
                for original, block in zip(
                    (record.get(field) or {}).get("blocks", []),
                    (result.get(field) or {}).get("blocks", []),
                ):
                    if "data" in original or "text" in original:
                        block["missing_reason"] = "cleared"
        return result

    with budget_lock(path.parent):
        return rewrite_content(path, project)
