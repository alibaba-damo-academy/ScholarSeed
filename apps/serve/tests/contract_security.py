"""Shared ACL oracle; platform object access is verified separately on Windows."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from unittest.mock import Mock

from service.platform import security


class SecurityContracts(unittest.TestCase):
    def test_shared_oracle(self) -> None:
        source = Path(__file__).resolve().parents[2] / "desktop/native/security.test.json"
        for vector in json.loads(source.read_text(encoding="utf-8")):
            with self.subTest(vector["name"]):
                if "owner" in vector:
                    owner = vector["owner"]
                    self.assertEqual(
                        security.owner(vector["role"], owner["trusted"]),
                        owner["allowed"],
                    )
                entries = [
                    security.Entry(
                        **{
                            "principal": 0,
                            "mask": 0,
                            "flags": 0,
                            "deny": False,
                            "trusted": False,
                            "universal": False,
                            "allow_subject": False,
                            "deny_subject": False,
                            **entry,
                        }
                    )
                    for entry in vector["entries"]
                ]
                verdict = security.evaluate(entries, vector["role"], vector["execution"])
                self.assertEqual(verdict, security.Result(**vector["expected"]))

    def test_shared_principal_oracle(self) -> None:
        source = Path(__file__).resolve().parents[2] / "desktop/native/principals.test.json"
        for vector in json.loads(source.read_text(encoding="utf-8")):
            with self.subTest(vector["name"]):
                self.assertEqual(
                    security.authority(
                        bytes.fromhex(vector["principal_hex"]), bytes.fromhex(vector["user_hex"])
                    ),
                    vector["trusted"],
                )

    def test_named_profile_matrix(self) -> None:
        source = Path(__file__).resolve().parents[2] / "desktop/native/profiles.test.json"
        for row in json.loads(source.read_text(encoding="utf-8")):
            with self.subTest(row):
                args = [row["principal"]]
                if row["profile"] != "machine_authority":
                    args.append(row["user"])
                if row["profile"] in {"tool_writer", "recovery_writer"}:
                    args.append(row["owner"])
                if row["profile"] == "tool_owner":
                    args.append(row["executor"])
                if row["profile"] == "private_owner":
                    args.append(row["administrator_member"])
                self.assertEqual(getattr(security, row["profile"])(*args), row["trusted"])

    def test_denial_is_correlated_sanitized_and_preserves_first_error(self) -> None:
        error = PermissionError(13, "password-secret S-1-5-21-private")
        log = Mock()
        security.record_denial(
            error, "private_writer", "acl", "policy_denied", logger=log, resource="/secret/profile"
        )
        security.record_denial(error, "installation", "inspect", "os_error", logger=log)
        self.assertEqual(log.warning.call_count, 1)
        event = json.loads(log.warning.call_args.args[1])
        self.assertEqual(event["reason"], "os_access_denied")
        self.assertEqual(event["correlation_id"], getattr(error, "permission_incident_id"))
        self.assertNotIn("password-secret", json.dumps(event))
        self.assertNotIn("S-1-5-21-private", json.dumps(event))
        self.assertNotIn("/secret/profile", json.dumps(event))
        self.assertEqual(error.args, (13, "password-secret S-1-5-21-private"))

    def test_denial_observer_failure_is_recoverable_without_changing_exception(self) -> None:
        error = PermissionError("original")
        log = Mock()
        log.warning.side_effect = RuntimeError("logging unavailable")
        security.record_denial(error, "private_writer", "acl", "policy_denied", logger=log)
        incident = getattr(error, "permission_incident_id")
        log.warning.side_effect = None
        security.record_denial(error, "private_writer", "acl", "policy_denied", logger=log)
        self.assertEqual(json.loads(log.warning.call_args.args[1])["correlation_id"], incident)
        self.assertEqual(str(error), "original")

    def test_native_rejection_reason_table(self) -> None:
        for code, expected in [
            (5, "os_access_denied"),
            (1223, "authorization_cancelled"),
            (1300, "privilege_not_held"),
            (1314, "privilege_not_held"),
        ]:
            error = OSError("hidden native message")
            setattr(error, "winerror", code)
            log = Mock()
            security.record_denial(error, "windows_api", "grant", "os_error", logger=log)
            self.assertEqual(json.loads(log.warning.call_args.args[1])["reason"], expected)

    def test_uint32_boundary(self) -> None:
        for mask in (-1, 0x100000000, True):
            with self.subTest(mask=mask), self.assertRaises(ValueError):
                security.Entry(0, mask, 0, False, False, False, False, False)
