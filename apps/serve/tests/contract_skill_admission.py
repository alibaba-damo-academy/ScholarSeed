"""Deterministic contracts for fresh skill admission over a private execution scope."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.capabilities.api.admission import register_skill_admission
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    SKILL_ADMISSION_ROUTE,
)


class SkillAdmissionContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.script = self.root / "run.py"
        self.script.write_text("print('skill')", encoding="utf-8")
        self.caller = SimpleNamespace(
            id="session", bridge_token="private", user_id="account", runtime_workdir=self.root
        )
        self.runtime = SimpleNamespace(
            skill_admission=AsyncMock(return_value={"name": "search", "active": True})
        )
        app = FastAPI()
        register_skill_admission(
            app, lambda scope: self.caller if scope == self.caller.id else None, self.runtime
        )
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {BRIDGE_SESSION_HEADER: "session", BRIDGE_TOKEN_HEADER: "private"}

    def test_valid_scope_uses_trusted_actor_and_script(self) -> None:
        response = self.client.post(
            SKILL_ADMISSION_ROUTE, headers=self.headers, json={"path": str(self.script)}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.runtime.skill_admission.assert_awaited_once_with(
            path=self.script, cwd=self.root, user_id="account"
        )

    def test_old_context_cannot_bypass_current_login_or_pause(self) -> None:
        for reason in ("login_required", "已暂停"):
            self.runtime.skill_admission.return_value = {
                "name": "search",
                "active": False,
                "unavailable_reason": reason,
            }
            response = self.client.post(
                SKILL_ADMISSION_ROUTE, headers=self.headers, json={"path": str(self.script)}
            )
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["error"], reason)

    def test_invalid_scope_never_queries_inventory(self) -> None:
        response = self.client.post(SKILL_ADMISSION_ROUTE, json={"path": str(self.script)})
        self.assertEqual(response.status_code, 403)
        self.runtime.skill_admission.assert_not_awaited()

    def test_unknown_skill_or_inventory_failure_fails_closed(self) -> None:
        self.runtime.skill_admission.return_value = None
        response = self.client.post(
            SKILL_ADMISSION_ROUTE, headers=self.headers, json={"path": str(self.script)}
        )
        self.assertEqual(response.status_code, 403)
        self.runtime.skill_admission.side_effect = RuntimeError("inventory unavailable")
        response = self.client.post(
            SKILL_ADMISSION_ROUTE, headers=self.headers, json={"path": str(self.script)}
        )
        self.assertEqual(response.status_code, 503)

    def test_caller_identity_cannot_be_supplied_in_body(self) -> None:
        response = self.client.post(
            SKILL_ADMISSION_ROUTE,
            headers=self.headers,
            json={"path": str(self.script), "user_id": "other"},
        )
        self.assertEqual(response.status_code, 400)
        self.runtime.skill_admission.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
