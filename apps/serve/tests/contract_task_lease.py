"""Contract for authenticated current-turn task identity leases."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

from fastapi import FastAPI
from fastapi.testclient import TestClient

from scholarseed_runtime.contract.input import InputItem, InputKind, TurnInput
from service.chat.api.tasks import register_task_routes
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.runtime.live import LiveSession
from service.chat.service.tasks import (
    TASK_ACTIVATION_POLICIES,
    ProductTaskLease,
    restore_task_binding,
)
from service.literature.api.acquire import register_acquire_routes
from service.literature.api.receipt import register_receipt_routes
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    LITERATURE_ACQUIRE_ROUTE,
    LITERATURE_RECEIPT_ROUTE,
    TASK_ACTIVATE_ROUTE,
)
from service.platform.context import ProductTaskType

REPO_ROOT = Path(__file__).resolve().parents[3]
PRECISE_SKILL = REPO_ROOT / "skills" / "community" / "precise-literature-search"
PRECISE_STAGE = PRECISE_SKILL / "scripts" / "stage.py"
MANIFEST_VERSION = re.compile(r'^version:\s*"?([^"\r\n]+?)"?\s*$', re.MULTILINE)


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

        live: Any = SimpleNamespace(
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
        self.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        self.catalog.register(
            live.id,
            SessionPrincipal("account-one"),
            runtime_id="codex",
            vendor_thread_id="native-session",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "output"),
            codex_version=None,
            model_id=None,
            policy_id=None,
            status=SessionStatus.READY,
            title="Recovery contract",
            created_at=1,
        )
        live.catalog = self.catalog
        live.user_id = "account-one"
        live.skill_state_by_name = identity
        live.clear_task_lease = lambda: setattr(live, "active_task_lease", None)
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
        self.assertEqual(response.json()["workspace"], "survey")

    def test_login_required_preserves_binding_for_fresh_turn_recovery(self) -> None:
        async def unavailable(name: str, *, force_reload: bool = False):
            return {
                "name": name,
                "version": "1.1.0",
                "path": str(self.manifest),
                "active": False,
                "unavailable_reason": "login_required",
            }

        self.live.skill_state_by_name = unavailable
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(response.json()["reason"], "login_required")
        self.assertIn("sign in", response.json()["action"].lower())
        self.assertIsNone(self.live.active_task_lease)
        binding = self.catalog.task_binding(self.live.id)
        assert binding is not None
        self.assertEqual(binding["command"]["workspace"], "survey")

        from_service = SessionCatalogStore(self.catalog.database)
        self.live.catalog = from_service
        self.live.active_product_turn_id = "turn-2"
        self.live.product_turn_generation = 2

        async def available(name: str, *, force_reload: bool = False):
            return {"name": name, "version": "1.1.0", "path": str(self.manifest), "active": True}

        self.live.skill_state_by_name = available
        context = asyncio.run(restore_task_binding(self.live))
        self.assertIn("activation succeeded", context)
        lease = cast(ProductTaskLease, self.live.active_task_lease)
        self.assertEqual(lease.turn_id, "turn-2")
        self.assertEqual(self.live.active_task_lease.workspace, "survey")

    def test_invalid_logged_out_binding_does_not_replace_recovery_target(self) -> None:
        accepted = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        rejected = self.client.post(
            TASK_ACTIVATE_ROUTE, json=self.payload(workspace="."), headers=self.headers
        )
        self.assertEqual(rejected.json()["reason"], "task_binding_invalid")
        binding = self.catalog.task_binding(self.live.id)
        assert binding is not None
        self.assertEqual(binding["command"]["workspace"], "survey")

    def test_account_switch_does_not_reuse_previous_task_authorization(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.active_task_lease = None
        self.live.user_id = "account-two"
        context = asyncio.run(restore_task_binding(self.live))
        self.assertIn("task_owner_mismatch", context)
        self.assertIsNone(self.live.active_task_lease)

    def test_recovery_revalidates_binding_and_does_not_fall_back_to_root(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.active_task_lease = None
        (self.workspace / ".slr-binding.json").unlink()
        context = asyncio.run(restore_task_binding(self.live))
        self.assertIn("task_binding_invalid", context)
        self.assertIsNone(self.live.active_task_lease)

    def test_signed_out_recovery_clears_old_lease_and_requests_login(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)

        async def signed_out(name: str, *, force_reload: bool = False):
            return {
                "name": name,
                "path": str(self.manifest),
                "version": "1.1.0",
                "active": False,
                "unavailable_reason": "login_required",
            }

        self.live.skill_state_by_name = signed_out
        self.live.user_id = "anonymous"
        context = asyncio.run(restore_task_binding(self.live))
        self.assertIn("Sign in", context)
        self.assertIsNone(self.live.active_task_lease)

    def test_new_runtime_turn_receives_fresh_activation_not_historical_failure(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.active_task_lease = None
        self.live.active_task_type = ""
        self.live.product_turn_generation = 2
        submitted = []

        async def submit(request):
            submitted.append(request)

        async def refresh(*, force_reload: bool):
            self.assertTrue(force_reload)

        self.live.runtime_driver = SimpleNamespace(submit=submit)
        self.live.refresh_skills = refresh
        self.live.model_run = None
        self.live.model_id = "contract-model"
        self.live.plans = SimpleNamespace(current=lambda: {})
        turn = TurnInput((InputItem(InputKind.TEXT, text="继续"),), client_user_message_id="turn-2")
        asyncio.run(LiveSession.run_runtime(self.live, turn))
        lease = cast(ProductTaskLease, self.live.active_task_lease)
        self.assertEqual(lease.turn_id, "turn-2")
        self.assertIn("activation succeeded", submitted[0].items[0]["text"])
        self.assertIn("Historical failures are not new attempts", submitted[0].items[0]["text"])
        self.assertEqual(submitted[0].items[-1]["text"], "继续")

    def test_new_explicit_task_does_not_resume_previous_task_type(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.active_task_lease = None
        self.live.active_task_type = "precise_search"
        self.assertEqual(asyncio.run(restore_task_binding(self.live)), "")
        self.assertIsNone(self.live.active_task_lease)

    def test_session_root_workspace_uses_the_same_identity_as_review(self) -> None:
        (self.root / ".slr-binding.json").write_text(
            json.dumps(
                {
                    "skill": str(self.skill),
                    "version": "1.1.0",
                    "workspace": str(self.root.resolve()),
                }
            ),
            encoding="utf-8",
        )
        payload = self.payload(workspace=".")
        payload.pop("run_id")
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        expected = "slr-" + hashlib.sha256(b".").hexdigest()[:16]
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["workspace"], ".")
        self.assertEqual(response.json()["run_id"], expected)
        self.assertEqual(self.live.active_task_lease.workspace, ".")

    def test_product_resolves_run_identity_without_caller_hash(self) -> None:
        payload = self.payload()
        payload.pop("run_id")
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["run_id"], "review-run")
        self.assertEqual(self.live.active_task_lease.run_id, "review-run")

        (self.workspace / ".slr-binding.json").write_text(
            json.dumps(
                {
                    "skill": str(self.skill),
                    "version": "1.1.0",
                    "workspace": str(self.workspace.resolve()),
                }
            ),
            encoding="utf-8",
        )
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        policy = TASK_ACTIVATION_POLICIES[ProductTaskType.LITERATURE_REVIEW]
        expected = (
            policy.derived_run_prefix
            + hashlib.sha256(b"survey").hexdigest()[: policy.derived_run_chars]
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["run_id"], expected)
        self.assertEqual(self.live.active_task_lease.run_id, expected)

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


class PreciseSearchTaskLeaseContract(unittest.TestCase):
    """The search skill proves its own identity, so any turn can hold the lease.

    The activation request comes from a real `stage.py start` run: serve must accept
    exactly what the bundled skill hands the model, without a product task starter.
    """

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        request = self.root / "request.txt"
        request.write_text("find the papers that answer the question\n", encoding="utf-8")
        # The gate isolates suites with safe-path mode, which would hide the skill's own
        # sibling modules; the product launcher never runs the stage that way.
        environment = {key: value for key, value in os.environ.items() if key != "PYTHONSAFEPATH"}
        started = subprocess.run(
            [
                sys.executable,
                str(PRECISE_STAGE),
                "start",
                "--work-dir",
                str(self.root),
                "--request-file",
                str(request),
            ],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
        if started.returncode:
            self.fail(f"stage.py start exited {started.returncode}: {started.stderr}")
        result = json.loads(started.stdout)
        self.activation = result["task_activation"]
        self.run = Path(result["run_dir"])

        manifest = (PRECISE_SKILL / "SKILL.md").read_text(encoding="utf-8")
        version = MANIFEST_VERSION.search(manifest.split("---", 2)[1])
        assert version is not None

        async def identity(name: str, *, force_reload: bool = True):
            self.assertFalse(force_reload)
            if name != "precise-literature-search":
                return None
            return {
                "name": name,
                "version": version.group(1),
                "path": str(PRECISE_SKILL / "SKILL.md"),
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
            publication_turn_id="turn-1",
            active_product_turn_id="turn-1",
            product_turn_generation=1,
            current_task=SimpleNamespace(done=lambda: False),
            active_task_lease=None,
            active_task_type="",
            skill_identity_by_name=identity,
            skill_state_by_name=identity,
            set_task_lease=install,
        )
        self.live = live
        live.user_id = "precise-account"
        live.clear_task_lease = lambda: setattr(live, "active_task_lease", None)
        live.catalog = SessionCatalogStore(self.root / "sessions.sqlite3")
        live.catalog.register(
            live.id,
            SessionPrincipal(live.user_id),
            runtime_id="codex",
            vendor_thread_id="native-precise",
            vendor_session_id=None,
            runtime_workdir=str(self.root),
            project_path=None,
            output_root=str(self.root / "output"),
            codex_version=None,
            model_id=None,
            policy_id=None,
            status=SessionStatus.READY,
            title="Precise contract",
            created_at=1,
        )
        sessions = SimpleNamespace(
            bridge_caller=lambda session_id: live if session_id == live.id else None
        )
        app = FastAPI()
        register_task_routes(app, sessions)
        register_acquire_routes(app, sessions, None)
        register_receipt_routes(app, sessions, None)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.headers = {
            BRIDGE_SESSION_HEADER: live.id,
            BRIDGE_TOKEN_HEADER: live.bridge_token,
        }

    def test_stage_output_activates_the_lease_without_a_task_starter(self) -> None:
        response = self.client.post(
            TASK_ACTIVATE_ROUTE, json=self.activation["request"], headers=self.headers
        )
        self.assertEqual(response.status_code, 200, response.text)
        expected = self.run.relative_to(self.root).as_posix()
        lease = self.live.active_task_lease
        self.assertIs(lease.task_type, ProductTaskType.PRECISE_SEARCH)
        self.assertEqual(lease.turn_id, "turn-1")
        self.assertEqual(lease.workspace, expected)
        self.assertEqual(lease.run_id, self.run.name)
        self.assertEqual(self.live.active_task_type, "precise_search")
        self.assertEqual(response.json()["workspace"], expected)

    def test_another_run_or_skill_cannot_claim_the_lease(self) -> None:
        accepted = self.client.post(
            TASK_ACTIVATE_ROUTE, json=self.activation["request"], headers=self.headers
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        original = self.live.active_task_lease

        review = self.client.post(
            TASK_ACTIVATE_ROUTE,
            json={**self.activation["request"], "skill_name": "literature-review"},
            headers=self.headers,
        )
        self.assertEqual(review.status_code, 400, review.text)
        self.assertEqual(review.json()["reason"], "task_skill_mismatch")
        self.assertIs(self.live.active_task_lease, original)

        copied = self.root / ".precise-literature-search" / "runs" / "copied-run"
        copied.mkdir(parents=True)
        (copied / ".pls-binding.json").write_text(
            (self.run / ".pls-binding.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
        stolen = self.client.post(
            TASK_ACTIVATE_ROUTE,
            json={
                **self.activation["request"],
                "workspace": copied.relative_to(self.root).as_posix(),
                "run_id": copied.name,
            },
            headers=self.headers,
        )
        self.assertEqual(stolen.status_code, 400, stolen.text)
        self.assertEqual(stolen.json()["reason"], "task_binding_mismatch")
        self.assertIs(self.live.active_task_lease, original)

    def test_a_turn_without_a_lease_is_told_how_to_recover(self) -> None:
        routes = (
            (LITERATURE_ACQUIRE_ROUTE, {"run": "run", "papers": []}),
            (LITERATURE_RECEIPT_ROUTE, {"run": "run"}),
        )
        for route, body in routes:
            with self.subTest(route=route):
                response = self.client.post(route, json=body, headers=self.headers)
                self.assertEqual(response.status_code, 400, response.text)
                payload = response.json()
                self.assertEqual(payload["error"], "fulltext_authorization_task_required")
                self.assertTrue(payload["recoverable"])
                self.assertIn("task activate", payload["action"])
                self.assertIsNone(self.live.active_task_lease)


if __name__ == "__main__":
    unittest.main()
