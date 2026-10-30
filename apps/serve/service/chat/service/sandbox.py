"""Bounded native Windows sandbox failure evidence for consented feedback export."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from service.platform.storage import open_directory

SUMMARY_NAME = "feedback/sandbox-summary.json"
SUMMARY_BUDGET = 64 * 1024
SOURCE_BYTES = 128 * 1024
SOURCE_DAYS = 3
EVENT_LIMIT = 64
SANDBOX_DIRECTORY = ".sandbox"
WINDOWS_PLATFORM = "win32"
SYSTEM_CODE = re.compile(
    r"\b(?:os error|win32 error|system error|error code)[: =]*(\d{1,10})\b", re.I
)
API_SYSTEM_CODE = re.compile(
    r"\b(?:SetNamedSecurityInfoW|SetSecurityInfo|SetEntriesInAclW|CreateProcessWithLogonW|LogonUserW|NetUserAdd|NetUserSetInfo|NetLocalGroupAddMembers)\b[^\r\n]{0,96}?\bfailed[^\d\r\n]{0,32}(\d{1,10})\b",
    re.I,
)
SYSTEM_CODE_LIMIT = 0xFFFFFFFF
REPORTED_TIME = re.compile(
    r"^\[(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)"
)
FAILURE_WORDS = ("error", "fail", "denied", "timeout", "timed out", "cancel")
STAGES = (
    ("firewall", "firewall"),
    ("createprocesswithlogonw", "process_launch"),
    ("logon", "logon"),
    ("acl", "acl"),
    ("dpapi", "credentials"),
    ("user provision", "accounts"),
    ("create user", "accounts"),
    ("account", "accounts"),
    ("setup", "setup"),
    ("runner", "runner"),
)


def _failure(line: str) -> dict[str, object] | None:
    sample = line.casefold()
    if not any(word in sample for word in FAILURE_WORDS):
        return None
    match = SYSTEM_CODE.search(sample) or API_SYSTEM_CODE.search(sample)
    code = int(match[1]) if match and int(match[1]) <= SYSTEM_CODE_LIMIT else None
    timestamp = REPORTED_TIME.match(line)
    return {
        "reported_time": timestamp[1] if timestamp else None,
        "stage": next((stage for marker, stage in STAGES if marker in sample), "unknown"),
        "system_code": code,
        "sha256": hashlib.sha256(line.encode("utf-8", errors="replace")).hexdigest(),
    }


def collect_sandbox_diagnostics(
    home: Path, budget: int = SUMMARY_BUDGET, *, platform: str = sys.platform
) -> list[tuple[str, bytes]]:
    """Read fixed recent daily logs only; never enumerate or export native free text.

    Every directory and leaf is opened no-follow via the filesystem owner. Raw
    logs can contain commands, paths and credentials, so only classified numeric
    causes and fingerprints leave this boundary. Missing evidence is explicit.
    """
    if platform != WINDOWS_PLATFORM or budget <= 0:
        return []
    sources: list[dict[str, object]] = []
    try:
        with closing(open_directory(home, (SANDBOX_DIRECTORY,))) as directory:
            today = datetime.now(timezone.utc).date()
            for age in range(SOURCE_DAYS):
                name = f"sandbox.{today - timedelta(days=age):%Y-%m-%d}.log"
                record: dict[str, object] = {"source": name}
                try:
                    with os.fdopen(directory.open_regular(name), "rb") as stream:
                        identity = os.fstat(stream.fileno())
                        if identity.st_nlink != 1:
                            record["status"] = "rejected"
                        else:
                            offset = max(0, identity.st_size - SOURCE_BYTES)
                            stream.seek(offset)
                            data = stream.read(min(identity.st_size, SOURCE_BYTES))
                            # A partial first line is not a complete native diagnostic.
                            if offset:
                                data = data.partition(b"\n")[2]
                            events = [
                                event
                                for line in data.decode("utf-8", errors="replace").splitlines()
                                if (event := _failure(line)) is not None
                            ]
                            record.update(
                                status="included",
                                source_bytes=identity.st_size,
                                truncated=bool(offset) or len(events) > EVENT_LIMIT,
                                snapshot_sha256=hashlib.sha256(data).hexdigest(),
                                events=events[-EVENT_LIMIT:],
                            )
                except OSError as error:
                    record.update(
                        status="missing" if isinstance(error, FileNotFoundError) else "unreadable",
                        system_code=getattr(error, "winerror", None) or error.errno,
                    )
                sources.append(record)
    except (OSError, ValueError, ExceptionGroup) as error:
        sources.append(
            {
                "source": "sandbox",
                "status": "unavailable",
                "system_code": getattr(error, "winerror", None) or getattr(error, "errno", None),
            }
        )
    contents = json.dumps({"schema_version": 1, "sources": sources}, separators=(",", ":")).encode()
    return [(SUMMARY_NAME, contents)] if len(contents) <= min(budget, SUMMARY_BUDGET) else []
