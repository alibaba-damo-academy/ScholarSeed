# Generated from native/security.json; DO NOT EDIT.
import hashlib
import json
import logging
import os
import re
import sys
import uuid

POLICY_HASH = "315aefe0171b79cf95ac1c1a11a9f3d2d27f390d18b73acf1ee0eb6ef28e8dc4"
STARTUP_MUTEX_DESCRIPTOR = "D:P(A;;0x00120001;;;AU)(A;;0x001f0001;;;SY)(A;;0x001f0001;;;BA)"


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
