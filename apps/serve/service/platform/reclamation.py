"""Bounded, opportunistic reclamation of idle coordination siblings."""

from __future__ import annotations

import errno
import logging
import os
import re
from typing import Protocol, TypedDict

from service.platform.storage import LeaseError

_LOG = logging.getLogger(__name__)
_CANDIDATE_LIMIT = 1024
_SLOT = re.compile(
    r"((?:posix-[a-f0-9]{16}-[a-f0-9]{16}|windows-[a-f0-9]{16}-[a-f0-9]{32}))"
    r"-(?:admission-b|occupancy-[ab])"
)
_RELEASE_ERRORS = frozenset({"ERR_LEASE_RELEASE", "ERR_DOMAIN_RELEASE"})


class ReclamationNative(Protocol):
    def pin(self, path: str, create: bool) -> object: ...
    def lineage(self, pin: object) -> tuple[str, ...]: ...
    def release(self, pin: object) -> None: ...
    def reclaim_at(self, pin: object, encoded_identity: str) -> dict[str, int]: ...


class ReclamationReport(TypedDict):
    removed: int
    busy: int
    retained: int
    examined: int
    complete: bool
    absent: bool
    errors: list[dict[str, str | int | None]]


def reclaim_coordination(native: ReclamationNative, path: str) -> ReclamationReport:
    """Scan only recognized sibling leaves; never create or recurse.

    Inventory supplies candidates, not deletion authority. Each native operation
    independently validates the pinned objects and locks its complete group.
    Explicit `complete=False` reports work deferred to a later startup/update pass.
    """
    result: ReclamationReport = {
        "examined": 0,
        "removed": 0,
        "busy": 0,
        "retained": 0,
        "complete": True,
        "absent": False,
        "errors": [],
    }
    try:
        pin = native.pin(path, False)
    except OSError as error:
        if getattr(error, "code", None) in _RELEASE_ERRORS:
            raise
        if getattr(error, "code", None) == "ERR_LEASE_MISSING" or error.errno == errno.ENOENT:
            result["absent"] = True
            return result
        raise
    try:
        identity = native.lineage(pin)
        candidates: set[str] = set()
        with os.scandir(path) as listing:
            for entry in listing:
                match = _SLOT.fullmatch(entry.name)
                if match is None or match[1] in candidates:
                    continue
                if len(candidates) >= _CANDIDATE_LIMIT:
                    result["complete"] = False
                    break
                candidates.add(match[1])
        # Bind the path-based enumeration to the same retained native root.
        check = native.pin(path, False)
        try:
            if native.lineage(check) != identity:
                raise LeaseError("ERR_LEASE_CHANGED")
        finally:
            native.release(check)
        for candidate in sorted(candidates):
            result["examined"] += 1
            try:
                receipt = native.reclaim_at(pin, candidate)
            except OSError as error:
                if getattr(error, "code", None) in _RELEASE_ERRORS:
                    raise
                result["errors"].append(
                    {
                        "code": getattr(error, "code", "ERR_RECLAMATION"),
                        "systemCode": error.errno,
                    }
                )
                _LOG.warning("coordination group reclamation deferred: %s: %s", candidate, error)
                continue
            result["removed"] += receipt["removed"]
            result["busy"] += receipt["busy"]
            result["retained"] += receipt["retained"]
    except BaseException as error:
        if getattr(error, "code", None) in _RELEASE_ERRORS:
            raise
        native.release(pin)
        raise
    native.release(pin)
    _LOG.info("coordination reclamation: %s", result)
    return result
