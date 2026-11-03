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
    activate_task,
    restore_task_binding,
    verified_authorization_context,
)
from service.literature.api.acquire import register_acquire_routes
from service.literature.api.receipt import register_receipt_routes
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    LITERATURE_ACQUIRE_ROUTE,
    LITERATURE_RECEIPT_ROUTE,
    TASK_ACTIVATE_ROUTE,
    TaskActivate,
)
from service.platform.context import ProductTaskType
from service.platform.storage import filesystem_path
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

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
            LiveSession.set_task_lease(live, lease)

        live: Any = SimpleNamespace(
            id="session",
            bridge_token="private",
            runtime_workdir=self.root,
            active_product_turn_id="turn-1",
            product_turn_generation=1,
            current_task=RunningTask(),
            interrupting=False,
            terminating=False,
            terminated=False,
            active_task_lease=None,
            task_lease_revision=0,
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
        live.project_id = "project-one"
        live.skill_state_by_name = identity
        live.clear_task_lease = lambda: LiveSession.clear_task_lease(live)
        self.callers = {live.id: live}
        sessions = SimpleNamespace(bridge_caller=self.callers.get)
        self.sessions = sessions
        app = FastAPI()
        activities = Activities()
        self.activities = activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_task_routes(app, sessions, activities=activities)
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

    def test_activation_accepts_equivalent_skill_and_binding_paths(self) -> None:
        plain = Path(str(self.skill).removeprefix("\\\\?\\"))
        extended = filesystem_path(self.skill)
        for selected, bound in ((extended, plain), (plain, extended)):
            with self.subTest(selected=selected, bound=bound):
                binding = self.workspace / ".slr-binding.json"
                value = json.loads(binding.read_text(encoding="utf-8"))
                value.update(skill=str(bound), workspace=str(filesystem_path(self.workspace)))
                binding.write_text(json.dumps(value), encoding="utf-8")
                response = self.client.post(
                    TASK_ACTIVATE_ROUTE,
                    json=self.payload(skill_path=str(selected)),
                    headers=self.headers,
                )
                self.assertEqual(response.status_code, 200, response.text)

        for invalid in (
            "",
            os.path.relpath(self.skill),
            str(self.skill.parent / "literature-review-other"),
        ):
            with self.subTest(invalid=invalid):
                value["skill"] = invalid
                binding.write_text(json.dumps(value), encoding="utf-8")
                response = self.client.post(
                    TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers
                )
                self.assertEqual(response.json()["reason"], "task_binding_mismatch")

    def research_payload(self) -> dict[str, str]:
        skill = self.root / "skills/research-idea-partner"
        skill.mkdir(parents=True)
        manifest = skill / "SKILL.md"
        manifest.write_text("---\nname: research-idea-partner\nversion: 1.2.14\n---\n")
        workspace = self.root / "agentic-search-results/topic"
        workspace.mkdir(parents=True)
        (workspace / ".rip-binding.json").write_text(
            json.dumps({"skill": str(skill.resolve()), "version": "1.2.14"}),
            encoding="utf-8",
        )

        async def identity(name: str, *, force_reload: bool = True):
            self.assertFalse(force_reload)
            if name != "research-idea-partner":
                return None
            return {
                "name": name,
                "version": "1.2.14",
                "path": str(manifest),
                "active": True,
            }

        self.live.skill_state_by_name = identity
        return {
            "task_type": "research_idea",
            "skill_name": "research-idea-partner",
            "skill_version": "1.2.14",
            "skill_path": str(skill.resolve()),
            "workspace": "agentic-search-results/topic",
        }

    def test_text_only_deep_followup_can_activate_its_current_turn(self) -> None:
        payload = self.research_payload()
        self.assertEqual(self.live.active_task_type, "")
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.live.active_task_type, "research_idea")
        self.assertIsNone(
            verified_authorization_context(
                self.live, ProductTaskType.RESEARCH_IDEA, workspace=payload["workspace"]
            )
        )
        self.live.product_turn_generation += 1
        with self.assertRaisesRegex(ValueError, "task_context_stale"):
            LiveSession.set_task_lease(self.live, self.live.active_task_lease)

    def test_research_fulltext_keeps_turn_scoped_consent(self) -> None:
        self.live.active_task_type = ProductTaskType.RESEARCH_IDEA.value
        self.assertIsNone(self.live.active_task_lease)
        self.assertIsNone(verified_authorization_context(self.live, ProductTaskType.RESEARCH_IDEA))

    def test_research_binding_does_not_label_a_later_untyped_turn(self) -> None:
        payload = self.research_payload()
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.live.active_product_turn_id = "next-turn"
        self.live.product_turn_generation += 1
        self.live.clear_task_lease()
        self.assertEqual(asyncio.run(restore_task_binding(self.live)), "")
        self.assertIsNone(self.live.active_task_lease)
        self.assertEqual(self.live.active_task_type, "")
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.live.active_task_lease.turn_id, "next-turn")

    def test_research_activation_rejects_a_binding_version_mismatch(self) -> None:
        payload = self.research_payload()
        payload["skill_version"] = "old-version"
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(response.json()["reason"], "task_skill_version_mismatch")
        self.assertIsNone(self.live.active_task_lease)

    def test_consent_identity_is_stable_but_execution_lease_is_not(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        original = verified_authorization_context(
            self.live, ProductTaskType.LITERATURE_REVIEW, workspace="survey", run_id="review-run"
        )
        self.live.active_product_turn_id = "turn-2"
        self.live.product_turn_generation = 2
        with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_required"):
            verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        asyncio.run(restore_task_binding(self.live))
        resumed = verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        self.assertEqual(original, resumed)
        for arguments in ({"workspace": "other"}, {"run_id": "other"}):
            with self.assertRaises(ValueError):
                verified_authorization_context(
                    self.live, ProductTaskType.LITERATURE_REVIEW, **arguments
                )

    def test_rejection_logs_missing_lease_without_credentials(self) -> None:
        with self.assertLogs("service.chat.service.tasks", level="WARNING") as captured:
            with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_required"):
                verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        message = " ".join(captured.output)
        self.assertIn("lease_present=False", message)
        self.assertNotIn(self.live.bridge_token, message)

    def test_global_task_keeps_owner_and_session_scope(self) -> None:
        self.live.project_id = ""
        with self.assertLogs("service.chat.service.tasks", level="INFO") as captured:
            response = self.client.post(
                TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers
            )
            self.assertEqual(response.status_code, 200, response.text)
            context = verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        self.assertIsNotNone(context)
        self.assertEqual(context.project_id, "")
        self.assertEqual(context.owner_id, self.live.user_id)
        self.assertEqual(context.session_id, self.live.id)
        self.assertEqual(context.run_id, "review-run")
        message = " ".join(captured.output)
        self.assertIn("task_activation_succeeded", message)
        self.assertIn("task_authorization_verified", message)
        self.assertIn("owner_present=True project_present=False", message)
        self.assertNotIn(self.live.user_id, message)

    def test_global_task_still_rejects_missing_owner(self) -> None:
        self.live.project_id = ""
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.user_id = ""
        with self.assertLogs("service.chat.service.tasks", level="WARNING") as captured:
            with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_required"):
                verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        message = " ".join(captured.output)
        self.assertIn("task_authorization_rejected", message)
        self.assertIn("owner_present=False project_present=False", message)

    def test_missing_owner_still_rejects_task_context(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.user_id = ""
        with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_required"):
            verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)

    def test_rejection_logs_stale_generation(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.live.product_turn_generation += 1
        with self.assertLogs("service.chat.service.tasks", level="WARNING") as captured:
            with self.assertRaisesRegex(ValueError, "fulltext_authorization_task_required"):
                verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        message = " ".join(captured.output)
        self.assertIn("turn_matches=True", message)
        self.assertIn("generation_matches=False", message)
        self.assertIn("validation=lease", message)
        self.assertIn("turn_id=turn-1", message)
        self.assertIn("generation=2", message)
        self.assertIn("lease_generation=1", message)
        self.assertIn("lease_revision=1", message)

    def test_authorization_logs_binding_mismatches_without_paths_or_run_ids(self) -> None:
        self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        for arguments, validation, reason in (
            ({"workspace": "private-workspace"}, "workspace", "task_workspace_mismatch"),
            ({"run_id": "private-run"}, "run", "task_run_mismatch"),
        ):
            with self.subTest(validation=validation):
                with self.assertLogs("service.chat.service.tasks", level="WARNING") as captured:
                    with self.assertRaisesRegex(ValueError, reason):
                        verified_authorization_context(
                            self.live, ProductTaskType.LITERATURE_REVIEW, **arguments
                        )
                message = " ".join(captured.output)
                self.assertIn(f"validation={validation}", message)
                self.assertIn("turn_id=turn-1", message)
                self.assertIn("lease_revision=1", message)
                for sensitive in (
                    *arguments.values(),
                    str(self.root),
                    self.live.active_task_lease.run_id,
                    self.live.user_id,
                    self.live.project_id,
                    self.live.bridge_token,
                ):
                    self.assertNotIn(sensitive, message)

    def test_activation_and_authorization_logs_correlate_the_current_lease(self) -> None:
        with self.assertLogs("service.chat.service.tasks", level="INFO") as captured:
            self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
            context = verified_authorization_context(
                self.live,
                ProductTaskType.LITERATURE_REVIEW,
                workspace="survey",
                run_id="review-run",
            )
        self.assertIsNotNone(context)
        self.assertEqual(len(captured.output), 2)
        self.assertIn("task_activation_succeeded", captured.output[0])
        self.assertIn("skill_version=1.1.0", captured.output[0])
        self.assertIn("task_authorization_verified", captured.output[1])
        for message in captured.output:
            for value in ("turn_id=turn-1", "generation=1", "lease_revision=1"):
                self.assertIn(value, message)
            for sensitive in (
                str(self.root),
                "review-run",
                self.live.user_id,
                self.live.project_id,
            ):
                self.assertNotIn(sensitive, message)

    def test_derived_run_cannot_become_cross_turn_consent_identity(self) -> None:
        binding = self.workspace / ".slr-binding.json"
        content = json.loads(binding.read_text())
        content.pop("run_id")
        binding.write_text(json.dumps(content))
        payload = self.payload()
        payload.pop("run_id")
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(
            verified_authorization_context(self.live, ProductTaskType.LITERATURE_REVIEW)
        )

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

        async def refresh(*, force_reload: bool = False):
            self.assertFalse(force_reload)

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

    def test_inventory_wait_cannot_rebind_changed_execution_or_account(self) -> None:
        initial = (
            self.live.active_product_turn_id,
            self.live.product_turn_generation,
            self.live.turn_activity,
            self.live.user_id,
            self.live.current_task,
        )
        mutations = {
            "generation": lambda: setattr(self.live, "product_turn_generation", 2),
            "account": lambda: setattr(self.live, "user_id", "other-account"),
            "task": lambda: setattr(self.live, "current_task", SimpleNamespace(done=lambda: False)),
            "interrupt": lambda: setattr(self.live, "interrupting", True),
            "detached": self.callers.clear,
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                (
                    self.live.active_product_turn_id,
                    self.live.product_turn_generation,
                    self.live.turn_activity,
                    self.live.user_id,
                    self.live.current_task,
                ) = initial
                self.live.interrupting = False
                self.callers[self.live.id] = self.live

                async def identity(*_args, _mutate=mutate, **_kwargs):
                    _mutate()
                    return {"path": str(self.manifest), "version": "1.1.0", "active": True}

                self.live.skill_state_by_name = identity
                response = self.client.post(
                    TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers
                )
                self.assertEqual(response.status_code, 400, response.text)
                self.assertEqual(response.json()["reason"], "task_context_stale")
                self.assertIsNone(self.catalog.task_binding(self.live.id))
                self.assertIsNone(self.live.active_task_lease)

    def test_stale_recovery_cannot_clear_a_new_turn_lease(self) -> None:
        response = self.client.post(TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        next_lease = ProductTaskLease(
            task_type=ProductTaskType.LITERATURE_REVIEW,
            turn_id="next-turn",
            generation=2,
            source="skill_run",
            workspace="other",
            run_id="new-run",
        )

        async def identity(*_args, **_kwargs):
            self.live.active_product_turn_id = "next-turn"
            self.live.product_turn_generation = 2
            self.live.active_task_lease = next_lease
            raise ValueError("task_skill_unavailable")

        self.live.skill_state_by_name = identity
        self.assertEqual(asyncio.run(restore_task_binding(self.live)), "")
        self.assertIs(self.live.active_task_lease, next_lease)

    def test_same_turn_activation_supersedes_an_inflight_recovery(self) -> None:
        workspace = self.root / "next"
        workspace.mkdir()
        (workspace / ".slr-binding.json").write_text(
            json.dumps({"skill": str(self.skill), "version": "1.1.0", "run_id": "next-run"}),
            encoding="utf-8",
        )

        async def available(*_args, **_kwargs):
            return {"path": str(self.manifest), "version": "1.1.0", "active": True}

        for outcome in ("active", "inactive", "error"):
            with self.subTest(outcome=outcome):
                self.live.skill_state_by_name = available
                response = self.client.post(
                    TASK_ACTIVATE_ROUTE, json=self.payload(), headers=self.headers
                )
                self.assertEqual(response.status_code, 200, response.text)

                async def race(outcome=outcome):
                    entered, release = asyncio.Event(), asyncio.Event()
                    calls = 0

                    async def identity(*_args, **_kwargs):
                        nonlocal calls
                        calls += 1
                        first = calls == 1
                        if first:
                            entered.set()
                            await release.wait()
                            if outcome == "error":
                                raise ValueError("task_binding_invalid")
                        return {
                            "path": str(self.manifest),
                            "version": "1.1.0",
                            "active": not (first and outcome == "inactive"),
                            "unavailable_reason": "login_required",
                        }

                    self.live.skill_state_by_name = identity
                    previous = asyncio.create_task(restore_task_binding(self.live))
                    try:
                        await asyncio.wait_for(entered.wait(), 3)
                        lease = await activate_task(
                            self.live,
                            TaskActivate.model_validate(
                                self.payload(workspace="next", run_id="next-run")
                            ),
                        )
                    finally:
                        release.set()
                        context = await previous
                    self.assertEqual(context, "")
                    self.assertIs(self.live.active_task_lease, lease)
                    self.assertEqual(
                        self.catalog.task_binding(self.live.id)["command"]["run_id"], "next-run"
                    )

                asyncio.run(race())


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
            LiveSession.set_task_lease(live, lease)

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            runtime_workdir=self.root,
            publication_turn_id="turn-1",
            active_product_turn_id="turn-1",
            product_turn_generation=1,
            current_task=SimpleNamespace(done=lambda: False),
            interrupting=False,
            terminating=False,
            terminated=False,
            active_task_lease=None,
            task_lease_revision=0,
            active_task_type="",
            skill_identity_by_name=identity,
            skill_state_by_name=identity,
            set_task_lease=install,
        )
        self.live = live
        live.user_id = "precise-account"
        live.clear_task_lease = lambda: LiveSession.clear_task_lease(live)
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
        activities = Activities()
        self.activities = activities
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_task_routes(app, sessions, activities=activities)
        register_acquire_routes(app, sessions, None, activities=activities)
        register_receipt_routes(app, sessions, None, activities=activities)
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

    def test_stage_run_without_project_has_verified_authorization_context(self) -> None:
        self.live.project_id = ""
        response = self.client.post(
            TASK_ACTIVATE_ROUTE, json=self.activation["request"], headers=self.headers
        )
        self.assertEqual(response.status_code, 200, response.text)
        context = verified_authorization_context(self.live, ProductTaskType.PRECISE_SEARCH)
        self.assertIsNotNone(context)
        self.assertEqual(context.project_id, "")
        self.assertEqual(context.owner_id, self.live.user_id)
        self.assertEqual(context.session_id, self.live.id)
        self.assertEqual(context.run_id, self.run.name)

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
