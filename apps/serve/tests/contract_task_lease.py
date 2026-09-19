"""Contract for authenticated current-turn task identity leases."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.api.tasks import register_task_routes
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    TASK_ACTIVATE_ROUTE,
)


class TaskLeaseContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.skill = self.root / "skills/literature-review"
        self.skill.mkdir(parents=True)
        self.skill = self.skill.resolve()
        self.manifest = self.skill / "SKILL.md"
        self.manifest.write_text("---\nname: literature-review\nversion: 1.1.0\n---\n")
        self.workspace = self.root / "survey"
        self.workspace.mkdir()
        (self.workspace / ".slr-binding.json").write_text(
            json.dumps(
                {
                    "skill": str(self.skill),
                    "version": "1.1.0",
                    "workspace": str(self.workspace.resolve()),
                    "run_id": "review-run",
                }
            ),
            encoding="utf-8",
        )

        class RunningTask:
            @staticmethod
            def done() -> bool:
                return False

        async def identity(name: str, *, force_reload: bool = True):
            self.assertFalse(force_reload)
            if name != "literature-review":
                return None
            return {
                "name": name,
                "version": "1.1.0",
                "path": str(self.manifest),
                "active": True,
            }

        def install(lease) -> None:
            if lease.turn_id != live.active_product_turn_id:
                raise ValueError("task_context_stale")
            live.active_task_lease = lease
            live.active_task_type = lease.task_type.value

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            runtime_workdir=self.root,
            active_product_turn_id="turn-1",
            product_turn_generation=1,
            current_task=RunningTask(),
            active_task_lease=None,
            active_task_type="",
            skill_identity_by_name=identity,
            set_task_lease=install,
        )
        self.live = live
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        app = FastAPI()
        register_task_routes(app, sessions)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }

    def payload(self, **updates: str) -> dict[str, str]:
        payload = {
            "task_type": "literature_review",
            "skill_name": "literature-review",
            "skill_version": "1.1.0",
            "skill_path": str(self.skill),
            "workspace": "survey",
            "run_id": "review-run",
        }
        payload.update(updates)
        return payload

    def test_verified_binding_activates_only_the_current_turn(self) -> None:
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        lease = self.live.active_task_lease
        self.assertEqual(lease.turn_id, "turn-1")
        self.assertEqual(lease.workspace, "survey")
        self.assertEqual(lease.run_id, "review-run")
        self.assertEqual(self.live.active_task_type, "literature_review")

    def test_invalid_identity_fails_without_replacing_the_lease(self) -> None:
        accepted = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        original = self.live.active_task_lease

        wrong_run = self.client.post(
            TASK_ACTIVATE_ROUTE,
            json=self.payload(run_id="foreign-run"),
            headers=self.headers,
        )
        self.assertEqual(wrong_run.status_code, 400, wrong_run.text)
        self.assertEqual(wrong_run.json()["reason"], "task_run_mismatch")
        self.assertIs(self.live.active_task_lease, original)

        copied = self.root / "copied"
        copied.mkdir()
        (copied / ".slr-binding.json").write_text(
            (self.workspace / ".slr-binding.json").read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        copied_response = self.client.post(
            TASK_ACTIVATE_ROUTE,
            json=self.payload(workspace="copied"),
            headers=self.headers,
        )
        self.assertEqual(copied_response.status_code, 400, copied_response.text)
        self.assertEqual(copied_response.json()["reason"], "task_binding_mismatch")
        self.assertIs(self.live.active_task_lease, original)

        wrong_token = self.client.post(
            TASK_ACTIVATE_ROUTE,
            json=self.payload(),
            headers={**self.headers, BRIDGE_TOKEN_HEADER: "wrong"},
        )
        self.assertEqual(wrong_token.status_code, 403, wrong_token.text)
        self.assertEqual(wrong_token.json()["reason"], "bridge_access_denied")
        self.assertIs(self.live.active_task_lease, original)

    def test_ended_turn_is_stale(self) -> None:
        self.live.current_task = SimpleNamespace(done=lambda: True)
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["reason"], "task_context_stale")
        self.assertIsNone(self.live.active_task_lease)


if __name__ == "__main__":
    unittest.main()
