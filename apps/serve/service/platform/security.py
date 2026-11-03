# Generated from security.json; DO NOT EDIT. schema=2 sha256=315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4
import hashlib
import json
import logging
import os
import re
import sys
import uuid
from collections.abc import Sequence
from dataclasses import dataclass

POLICY_HASH = "315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4"


@dataclass(frozen=True)
class Entry:
    principal: int
    mask: int
    flags: int
    deny: bool
    trusted: bool
    universal: bool
    allow_subject: bool
    deny_subject: bool

    def __post_init__(self) -> None:
        for value in (self.principal, self.mask, self.flags):
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or not 0 <= value <= 4294967295
            ):
                raise ValueError("ACL input must be uint32")


@dataclass(frozen=True)
class Result:
    reason: int
    index: int
    mask: int
    scope: int


ROLE_CONTENT = 0
ROLE_ANCESTOR = 1
ROLE_VOLUME = 2
ROLE_RUNTIME = 3

INSTALLATION_AUTHORITIES = frozenset(
    (
        bytes.fromhex("010100000000000512000000"),
        bytes.fromhex("01020000000000052000000020020000"),
        bytes.fromhex("010600000000000550000000b589fb381984c2cb5c6c236d5700776ec0026487"),
    )
)


def authority(principal: bytes, user: bytes) -> bool:
    return bool(principal) and (principal == user or principal in INSTALLATION_AUTHORITIES)


SID_SYSTEM = "S-1-5-18"
SID_ADMINISTRATORS = "S-1-5-32-544"
SID_TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
SID_OWNER_RIGHTS = "S-1-3-4"
SID_EVERYONE = "S-1-1-0"
SID_AUTHENTICATED_USERS = "S-1-5-11"


def machine_authority(principal: str) -> bool:
    return bool(principal) and (principal == SID_SYSTEM or principal == SID_ADMINISTRATORS)


def tool_owner(principal: str, user: str, executor: str) -> bool:
    return (
        bool(principal)
        and (principal == user or principal == SID_SYSTEM or principal == SID_ADMINISTRATORS)
        and principal != executor
    )


def tool_writer(principal: str, user: str, owner: str) -> bool:
    return bool(principal) and (
        principal == user
        or principal == SID_SYSTEM
        or principal == SID_ADMINISTRATORS
        or (
            principal == SID_OWNER_RIGHTS
            and bool(owner)
            and (owner == user or owner == SID_SYSTEM or owner == SID_ADMINISTRATORS)
        )
    )


def recovery_owner(principal: str, user: str) -> bool:
    return bool(principal) and (
        principal == user or principal == SID_SYSTEM or principal == SID_ADMINISTRATORS
    )


def recovery_writer(principal: str, user: str, owner: str) -> bool:
    return bool(principal) and (
        principal == user
        or principal == SID_SYSTEM
        or principal == SID_ADMINISTRATORS
        or (
            principal == SID_OWNER_RIGHTS
            and bool(owner)
            and (owner == user or owner == SID_SYSTEM or owner == SID_ADMINISTRATORS)
        )
    )


def private_owner(principal: str, user: str, administrator_member: bool) -> bool:
    return bool(principal) and (
        principal == user or (principal == SID_ADMINISTRATORS and administrator_member)
    )


def private_writer(principal: str, user: str) -> bool:
    return bool(principal) and (
        principal == user or principal == SID_SYSTEM or principal == SID_ADMINISTRATORS
    )


def lease_state(principal: str, user: str) -> bool:
    return bool(principal) and (
        principal == user
        or principal == SID_SYSTEM
        or principal == SID_ADMINISTRATORS
        or principal == SID_TRUSTED_INSTALLER
    )


def lease_grant(principal: str, user: str) -> bool:
    return bool(principal) and (
        principal == user or principal == SID_SYSTEM or principal == SID_ADMINISTRATORS
    )


def record_denial(
    error: Exception, profile: str, stage: str, reason: str, *, logger=None, resource=None
) -> None:
    """Observation never replaces the original exception or publishes its text."""
    try:
        if getattr(error, "permission_recorded", False):
            return
        incident = getattr(error, "permission_incident_id", None) or uuid.uuid4().hex
        setattr(error, "permission_incident_id", incident)
        system = getattr(error, "winerror", None) or getattr(error, "errno", None)
        code = getattr(error, "code", "permission_denied")
        event = {
            "schema": 1,
            "event": "permission_rejected",
            "policy_hash": POLICY_HASH,
            "profile": (
                profile
                if profile
                in [
                    "installation",
                    "machine_authority",
                    "tool_owner",
                    "tool_writer",
                    "recovery_owner",
                    "recovery_writer",
                    "private_owner",
                    "private_writer",
                    "lease_state",
                    "lease_grant",
                    "native_directory",
                    "startup_mutex",
                    "tool_access",
                    "windows_api",
                ]
                else "unknown"
            ),
            "stage": (
                stage
                if stage
                in [
                    "owner",
                    "acl",
                    "inspect",
                    "binding",
                    "grant",
                    "lock",
                    "setup",
                    "recovery",
                    "private",
                ]
                else "unknown"
            ),
            "reason": {
                "5": "os_access_denied",
                "1223": "authorization_cancelled",
                "1300": "privilege_not_held",
                "1314": "privilege_not_held",
            }.get(
                str(getattr(error, "winerror", None) or (system if sys.platform == "win32" else 0))
            )
            or (
                "os_access_denied"
                if isinstance(error, PermissionError)
                else (
                    "os_error"
                    if isinstance(error, OSError) and system
                    else (
                        reason
                        if reason
                        in [
                            "policy_denied",
                            "untrusted_owner",
                            "foreign_writer",
                            "execution_denied",
                            "invalid_descriptor",
                            "unsupported_ace",
                            "os_access_denied",
                            "os_error",
                            "coordination_failed",
                            "authorization_cancelled",
                            "privilege_not_held",
                        ]
                        else "unknown"
                    )
                )
            ),
            "code": (
                code
                if isinstance(code, str)
                and re.fullmatch(r"(?:ERR_[A-Z0-9_]{1,64}|EACCES|EPERM|permission_denied)", code)
                else "permission_denied"
            ),
            "system_code": (
                system if isinstance(system, int) and not isinstance(system, bool) else 0
            ),
            "error_type": type(error).__name__,
            "correlation_id": incident,
            "pid": os.getpid(),
            "subject_kind": {
                "untrusted_owner": "owner",
                "foreign_writer": "writer",
                "execution_denied": "execution_token",
            }.get(reason, "unknown"),
        }
        trace = error.__traceback__
        for _ in range(8):
            if trace is None or trace.tb_next is None:
                break
            trace = trace.tb_next
        if trace is not None:
            event["site"] = {
                "file": os.path.basename(trace.tb_frame.f_code.co_filename),
                "function": trace.tb_frame.f_code.co_name,
                "line": trace.tb_lineno,
            }
        if resource is not None:
            event["target_id"] = hashlib.sha256(
                str(resource).encode("utf-8", errors="surrogatepass")
            ).hexdigest()[:16]
        (logger or logging.getLogger("scholarseed.permission")).warning(
            "permission_rejected %s", json.dumps(event, separators=(",", ":"))
        )
        setattr(error, "permission_recorded", True)
    except Exception:
        pass


def owner(role: int, trusted: bool) -> bool:
    return trusted or (role == 2)


def mask(mask: int) -> int:
    if (mask & 2147483648) != 0:
        mask = (mask & ((~2147483648) & 4294967295)) | 1179785
    if (mask & 1073741824) != 0:
        mask = (mask & ((~1073741824) & 4294967295)) | 1179926
    if (mask & 536870912) != 0:
        mask = (mask & ((~536870912) & 4294967295)) | 1179808
    if (mask & 268435456) != 0:
        mask = (mask & ((~268435456) & 4294967295)) | 2032127
    return mask


def allowed(role: int) -> int:
    value = 1179817
    if (role == 1) or (role == 2):
        value = value | 6
    if role == 2:
        value = value | 852240
    return value


def applies(flags: int, role: int, scope: int) -> bool:
    if scope == 0:
        return (flags & 8) == 0
    if role != 3:
        return False
    if (scope >= 3) and ((flags & 4) != 0):
        return False
    if (scope == 1) or (scope == 3):
        return (flags & 1) != 0
    return (flags & 2) != 0


def danger(entries: Sequence[Entry], role: int, index: int, scope: int) -> int:
    if (entries[index].deny or entries[index].trusted) or (
        not applies(entries[index].flags, role, scope)
    ):
        return 0
    denied = 0
    for j in range(0, index):
        if (
            entries[j].deny
            and ((entries[j].principal == entries[index].principal) or entries[j].universal)
        ) and applies(entries[j].flags, role, scope):
            denied = denied | mask(entries[j].mask)
    return (mask(entries[index].mask) & ((~allowed(role)) & 4294967295)) & ((~denied) & 4294967295)


def blocked(entries: Sequence[Entry], index: int, scope: int) -> int:
    if not (entries[index].deny and entries[index].deny_subject):
        return 0
    granted = 0
    for j in range(0, index):
        if ((not entries[j].deny) and entries[j].allow_subject) and applies(
            entries[j].flags, 3, scope
        ):
            granted = granted | mask(entries[j].mask)
    return (mask(entries[index].mask) & 1179817) & ((~granted) & 4294967295)


def evaluate(entries: Sequence[Entry], role: int, execution: bool) -> Result:
    for i in range(0, len(entries)):
        for scope in range(0, 5):
            dangerous = danger(entries, role, i, scope)
            if dangerous != 0:
                return Result(1, i, dangerous, scope)
            if execution and applies(entries[i].flags, role, scope):
                denied = blocked(entries, i, scope)
                if denied != 0:
                    return Result(2, i, denied, scope)
    return Result(0, -1, 0, 0)
