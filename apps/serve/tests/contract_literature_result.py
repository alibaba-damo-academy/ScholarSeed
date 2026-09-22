"""Deterministic contracts for consuming unchanged skill outputs, not acceptance."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.api.cards import register_card_routes
from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD
from service.chat.persistence.catalog import SessionCatalogStore, SessionPrincipal, SessionStatus
from service.chat.persistence.events import ProductEventStore
from service.chat.service.cards import CardRegistry
from service.cli.bridge import BLOCKING_CHECKPOINTS, parser
from service.literature.api.result import register_result_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.result import (
    SEARCH_CARD,
    prepare_final_delivery,
    prepare_result,
    validate_search_card,
)
from service.literature.service.status import ResultIdentity, ResultStatusService
from service.platform.bridge import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    DISPLAY_CARD_ROUTE,
    LITERATURE_RESULT_ROUTE,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
PRECISE_SKILL = REPO_ROOT / "skills" / "community" / "precise-literature-search" / "SKILL.md"
HOST_PROMPT = (
    REPO_ROOT / "apps" / "serve" / "service" / "chat" / "prompts" / "developerInstructions.md"
)


class LiteratureResultContract(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.run = self.root / "run"
        self.work = self.run / "search" / "round-001" / "work"
        self.work.mkdir(parents=True)
        self.state = {
            "run_id": "run1",
            "search_round": 1,
            "paths": {
                "intent": "intent.json",
                "latest_metadata": "search/round-001/metadata.json",
                "latest_search_report": "search/round-001/report.md",
            },
        }
        self.paper = {
            "id": "p1",
            "title": "研究方法",
            "authors": ["Author"],
            "year": 2025,
            "doi": "10.1/test",
            "url": "https://doi.org/10.1/test",
            "is_placeholder": False,
            "source": "paperhub",
            "open_access": "yes",
            "relevance": {"reasons": ["符合研究问题"]},
        }
        self.metadata = {
            "run_id": "run1",
            "round": 1,
            "status": "success",
            "is_placeholder": False,
            "papers": [self.paper],
        }
        self.write(self.run / "state.json", self.state)
        self.write(
            self.run / "intent.json",
            {"confirmed": True, "precise_intent": "研究方法", "max_results": 5},
        )
        self.write(self.work.parent / "metadata.json", self.metadata)
        self.write(
            self.work / "state.json",
            {
                "pool_size": 2,
                "source_details": {
                    "paperhub": {"status": "success", "queries": 1, "candidates": 3}
                },
            },
        )
        (self.work.parent / "report.md").write_text(
            "# Search report\nActual metadata summary", encoding="utf-8"
        )

    def write_selection(self, selected: list[str]) -> None:
        self.state["paths"]["selection"] = "selection.json"
        self.write(self.run / "state.json", self.state)
        self.write(
            self.run / "selection.json",
            {
                "run_id": "run1",
                "metadata_path": "search/round-001/metadata.json",
                "selected_paper_ids": selected,
                "confirmed_by_user": True,
            },
        )

    def write_final_delivery(self) -> None:
        self.state["status"] = "COMPLETED"
        self.state["paths"].update(
            {
                "final_report": "final_report.md",
                "paper_summary": "paper_summary.md",
                "report": "report.md",
            }
        )
        self.write(self.run / "state.json", self.state)
        for name in ("final_report.md", "paper_summary.md", "report.md"):
            (self.run / name).write_text(f"# {name}\nverified content\n", encoding="utf-8")

    def test_precise_skill_requires_selected_list_before_one_click_authorization(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")
        self.assertIn("use the installed precise-literature-search skill", prompt.lower())
        self.assertIn('"checkpoint":"search"', prompt)
        self.assertNotIn('"checkpoint":"selection"', prompt)
        self.assertNotIn("stage.py authorize-download", prompt)
        self.assertIn("selection.json", skill)
        self.assertIn("metadata.json", skill)
        self.assertIn("Do not start either download route", skill)
        self.assertIn("ends the current turn immediately", skill)
        phase_four = skill.index("## Phase 4: authorize and download")
        skill_stage = skill.index('stage.py" authorize-download', phase_four)
        skill_publication = skill.index("scholarseed-bridge literature result", skill_stage)
        skill_download = skill.index('stage.py" download', skill_publication)
        self.assertLess(skill_stage, skill_publication)
        self.assertLess(skill_publication, skill_download)

    def test_precise_skill_exclusively_owns_confirmation(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")

        self.assertIn("Before starting — mandatory confirmation", skill)
        self.assertIn("Then STOP and wait for an explicit affirmative response", skill)
        self.assertIn("Follow the installed skill's confirmation", prompt)
        self.assertNotIn("skip its additional clarification and confirmation", prompt)

    def test_research_idea_uses_checkpoint_owned_one_click_authorization(self) -> None:
        prompt = HOST_PROMPT.read_text(encoding="utf-8")

        self.assertIn('"checkpoint":"candidates"', prompt)
        self.assertIn("the product owns the `想法原文授权` interaction", prompt)
        self.assertIn("Do not call `literature authorize`, `request_user_input`", prompt)
        self.assertNotIn("authorization_type=research_idea_fulltext", prompt)
        self.assertNotIn("Use the returned question object unchanged", prompt)

    def test_precise_skill_requires_final_checkpoint_before_claiming_delivery(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")

        checkpoint = skill.index('"checkpoint":"final"')
        claim_gate = skill.index("Claim delivery only", checkpoint)
        self.assertLess(checkpoint, claim_gate)
        self.assertIn("final_report.md", skill[checkpoint:])
        self.assertIn("paper_summary.md", skill[checkpoint:])
        self.assertIn("report.md", skill[checkpoint:])
        self.assertNotIn('"checkpoint":"final"', prompt)

    @staticmethod
    def write(path: Path, value: dict) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_projection_reads_papers_and_counts_without_mutating_run(self) -> None:
        before = {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        result = prepare_result(self.root, "run")
        self.assertEqual(
            (result.card.candidates, result.card.deduplicated, result.card.retained), (3, 2, 1)
        )
        self.assertEqual(result.card.papers[0].title, "研究方法")
        self.assertEqual(result.card.papers[0].reasons, ["符合研究问题"])
        self.assertEqual(result.card.papers[0].fulltext, "unknown")
        self.assertEqual(
            before, {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        )

    def test_historical_review_origin_remains_readable_after_skill_rename(self) -> None:
        result = prepare_result(self.root, "run")
        payload = result.card.model_dump(mode="json")
        payload["origin"] = "slr-codex"
        self.assertEqual(validate_search_card(payload)["origin"], "slr-codex")

    def test_selection_checkpoint_projects_only_bound_selected_papers(self) -> None:
        second = {**self.paper, "id": "p2", "title": "第二篇文献"}
        self.metadata["papers"] = [self.paper, second]
        self.write(self.work.parent / "metadata.json", self.metadata)
        self.write_selection(["p2"])
        result = prepare_result(self.root, "run", "selection")
        self.assertEqual(result.card.retained, 1)
        self.assertEqual([paper.id for paper in result.card.papers], ["p2"])
        self.assertEqual(result.card.papers[0].decision, "included")
        self.assertEqual(result.selection_path, "run/selection.json")
        self.assertTrue(result.selection_sha256)
        self.assertEqual(
            [(source.id, source.ref_id, source.title) for source in result.authorization_sources],
            [("p2", "paper:p2", "第二篇文献")],
        )
        self.assertEqual(
            result.authorization_refs,
            ("paper:p2", f"artifact:{result.selection_sha256}"),
        )

    def test_selection_checkpoint_rejects_unbound_or_unknown_papers(self) -> None:
        self.write_selection(["missing"])
        with self.assertRaisesRegex(ValueError, "unknown_paper"):
            prepare_result(self.root, "run", "selection")
        selection = json.loads((self.run / "selection.json").read_text(encoding="utf-8"))
        selection["selected_paper_ids"] = ["p1"]
        selection["metadata_path"] = "search/round-002/metadata.json"
        self.write(self.run / "selection.json", selection)
        with self.assertRaisesRegex(ValueError, "round_mismatch"):
            prepare_result(self.root, "run", "selection")

    def test_final_checkpoint_prepares_completed_deliverables_without_mutating_run(self) -> None:
        self.write_final_delivery()
        before = {str(path): path.read_bytes() for path in self.run.rglob("*") if path.is_file()}

        result = prepare_final_delivery(self.root, "run")

        self.assertEqual(
            [(artifact.path, artifact.role) for artifact in result.artifacts],
            [
                ("run/final_report.md", "final"),
                ("run/paper_summary.md", "supporting"),
                ("run/report.md", "supporting"),
            ],
        )
        self.assertTrue(all(len(artifact.sha256) == 64 for artifact in result.artifacts))
        self.assertEqual(
            before, {str(path): path.read_bytes() for path in self.run.rglob("*") if path.is_file()}
        )

    def test_final_checkpoint_rejects_incomplete_empty_or_unsafe_delivery(self) -> None:
        with self.assertRaisesRegex(ValueError, "run_incomplete"):
            prepare_final_delivery(self.root, "run")

        self.write_final_delivery()
        (self.run / "final_report.md").write_text("", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "artifact_empty"):
            prepare_final_delivery(self.root, "run")

        (self.run / "final_report.md").write_text("# final\n", encoding="utf-8")
        self.state["paths"]["final_report"] = "../escape.md"
        self.write(self.run / "state.json", self.state)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            prepare_final_delivery(self.root, "run")

        self.state["paths"]["final_report"] = "final_report.md"
        self.state["paths"]["paper_summary"] = "final_report.md"
        self.write(self.run / "state.json", self.state)
        with self.assertRaisesRegex(ValueError, "artifact_duplicate"):
            prepare_final_delivery(self.root, "run")

    def test_round_and_paths_must_match(self) -> None:
        for path in ("../escape.json", "/tmp/escape.json"):
            self.state["paths"]["latest_metadata"] = path
            self.write(self.run / "state.json", self.state)
            with self.assertRaises(ValueError):
                prepare_result(self.root, "run")
        self.state["paths"]["latest_metadata"] = "search/round-001/metadata.json"
        self.state["search_round"] = 2
        self.write(self.run / "state.json", self.state)
        with self.assertRaisesRegex(ValueError, "round_mismatch"):
            prepare_result(self.root, "run")

    def test_symlink_is_not_read(self) -> None:
        (self.run / "intent.json").unlink()
        (self.run / "intent.json").symlink_to(self.work.parent / "metadata.json")
        with self.assertRaises((OSError, ValueError)):
            prepare_result(self.root, "run")

    def test_missing_statistics_do_not_become_zero(self) -> None:
        (self.work / "state.json").unlink()
        result = prepare_result(self.root, "run")
        self.assertIsNone(result.card.candidates)
        self.assertIsNone(result.card.deduplicated)
        self.assertTrue(result.card.warnings)

    def test_partial_source_is_not_success(self) -> None:
        self.write(
            self.work / "state.json",
            {
                "pool_size": 1,
                "source_details": {
                    "paperhub": {"status": "transport_error"},
                    "agent_web": {"status": "success", "candidates": 1},
                },
            },
        )
        self.assertEqual(prepare_result(self.root, "run").card.status, "partial")

    def test_all_failed_cannot_publish_papers(self) -> None:
        self.write(
            self.work / "state.json",
            {"source_details": {"paperhub": {"status": "authentication_error"}}},
        )
        with self.assertRaisesRegex(ValueError, "no_successful_source"):
            prepare_result(self.root, "run")
        self.metadata.update(status="source_failed", papers=[])
        self.write(self.work.parent / "metadata.json", self.metadata)
        result = prepare_result(self.root, "run")
        self.assertEqual(result.card.status, "source_failed")
        self.assertEqual(result.card.papers, [])

    def test_placeholder_duplicate_and_unsafe_url_rejected(self) -> None:
        for update in (
            {"is_placeholder": True},
            {"status": {}},
            {"papers": [self.paper, self.paper]},
            {"papers": [{**self.paper, "url": "javascript:alert(1)"}]},
        ):
            self.write(self.work.parent / "metadata.json", {**self.metadata, **update})
            with self.assertRaises(ValueError):
                prepare_result(self.root, "run")

    def test_actual_library_status_and_doi_conflict(self) -> None:
        repository = LiteratureRepository(self.root / "library.sqlite3")
        repository.save(
            LiteratureItem(id="known", title="研究方法", doi="https://doi.org/10.1/test")
        )
        service = ResultStatusService(repository)
        papers = [
            ResultIdentity(id="p1", title="研究方法", doi=" DOI:10.1/TEST "),
            ResultIdentity(id="p2", title="研究方法", doi="10.1/other"),
        ]
        result = service.resolve(papers)
        self.assertEqual(result["p1"]["library"], "matched")
        self.assertEqual(result["p2"]["library"], "absent")
        repository.save(LiteratureItem(id="other", title="研究方法"))
        self.assertEqual(
            service.resolve([ResultIdentity(id="p3", title="研究方法")])["p3"]["library"],
            "ambiguous",
        )

    def test_library_status_is_scoped_to_project_membership(self) -> None:
        repository = LiteratureRepository(self.root / "scoped-library.sqlite3")
        paper = LiteratureItem(id="scoped", title="Shared paper", doi="10.1/scoped")
        repository.save_all((paper,), project_id="project-one")
        service = ResultStatusService(repository)
        identities = [ResultIdentity(id="hit", title=paper.title, doi=paper.doi)]
        self.assertEqual(service.resolve(identities)["hit"]["library"], "matched")
        self.assertEqual(service.resolve(identities, "project-one")["hit"]["library"], "matched")
        self.assertEqual(service.resolve(identities, "project-two")["hit"]["library"], "absent")
        repository.save_all((paper,), project_id="project-two")
        self.assertEqual(service.resolve(identities, "project-two")["hit"]["library"], "matched")

    def test_bridge_requires_live_token_and_uses_actual_files(self) -> None:
        publications = []

        async def publish_artifact(path, role, **kwargs):
            publications.append((path, kwargs))
            return {"artifact_id": "report", "path": path, "name": "report.md"}

        async def display_card(kind, content, **kwargs):
            publications.append(content.data)
            return {"card_id": "card"}

        product_questions = []

        async def request_product_input(question, **kwargs):
            product_questions.append((question, kwargs))
            return {"answers": {question["id"]: "拒绝"}}

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_assistant_snapshot_id="snapshot-1",
            active_task_type="precise_search",
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
            interactions=SimpleNamespace(request_product_input=request_product_input),
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        prepare_authorization = Mock(
            return_value=SimpleNamespace(
                authorization_type="precise_search_fulltext",
                scope_digest="scope-digest",
                question_id="precise-search-fulltext:opaque",
            )
        )
        app = FastAPI()
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            authorizer=SimpleNamespace(
                prepare=prepare_authorization,
                granted=lambda _challenge: False,
                granted_scope=lambda **_scope: False,
            ),
        )
        with TestClient(app) as client:
            self.assertEqual(
                client.post(LITERATURE_RESULT_ROUTE, json={"run": "run"}).status_code, 403
            )
            response = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run"},
            )
            self.assertNotIn("authorization", response.json())
            self.state["paths"]["selection"] = None
            self.write(self.run / "state.json", self.state)
            with self.assertLogs("service.literature.api.result", level="WARNING") as logs:
                unprepared = client.post(
                    LITERATURE_RESULT_ROUTE,
                    headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                    json={"run": "run", "checkpoint": "selection"},
                )
            self.write_selection(["p1"])
            selected = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "selection"},
            )
            live.active_task_type = ""
            continued = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "selection"},
            )
            live.active_task_type = "literature_review"
            wrong_task = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "selection"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(unprepared.status_code, 400, unprepared.text)
        self.assertEqual(
            unprepared.json(),
            {
                "ok": False,
                "error": "literature_result_publication_failed",
                "reason": "literature_result_selection_not_prepared",
                "recoverable": True,
                "action": "prepare and register the confirmed selection before retrying",
            },
        )
        self.assertIn("failure_type=ValueError", logs.output[0])
        self.assertIn("failure=literature_result_selection_not_prepared", logs.output[0])
        self.assertEqual(selected.status_code, 200, selected.text)
        self.assertEqual(continued.status_code, 200, continued.text)
        self.assertEqual(wrong_task.status_code, 400, wrong_task.text)
        self.assertEqual(wrong_task.json()["reason"], "fulltext_authorization_task_required")
        self.assertTrue(publications[0][1]["expected_sha256"])
        self.assertEqual(publications[2]["papers"][0]["title"], "研究方法")
        authorization = selected.json()["authorization"]
        self.assertEqual(authorization["authorization_type"], "precise_search_fulltext")
        self.assertEqual(authorization["sources"], [{"id": "p1", "title": "研究方法"}])
        self.assertEqual(authorization["disposition"], "rejected")
        self.assertNotIn("question", authorization)
        question, options = product_questions[0]
        self.assertEqual(question["header"], "精准检索授权")
        self.assertEqual(options["turn_id"], "t1")
        self.assertEqual(
            [option["label"] for option in question["options"]],
            ["一键授权 (Recommended)", "拒绝"],
        )
        self.assertEqual(prepare_authorization.call_count, 2)
        call = prepare_authorization.call_args.kwargs
        self.assertEqual(call["snapshot_id"], "snapshot-1")
        self.assertEqual(call["refs"][0], "paper:p1")
        self.assertTrue(call["refs"][1].startswith("artifact:"))

    def test_final_checkpoint_publishes_user_visible_artifacts_without_search_card(self) -> None:
        self.write_final_delivery()
        publications = []

        async def publish_artifact(path, role, **kwargs):
            publications.append((path, role, kwargs))
            return {
                "artifact_id": f"artifact-{len(publications)}",
                "path": path,
                "name": Path(path).name,
                "sha256": kwargs["expected_sha256"],
            }

        async def display_card(*_args, **_kwargs):
            raise AssertionError("final delivery must not create another search card")

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_task_type="precise_search",
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        app = FastAPI()
        register_result_routes(app, sessions, SimpleNamespace(), SimpleNamespace())

        with TestClient(app) as client:
            response = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "final"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            [(path, role) for path, role, _kwargs in publications],
            [
                ("run/final_report.md", "final"),
                ("run/paper_summary.md", "supporting"),
                ("run/report.md", "supporting"),
            ],
        )
        self.assertTrue(all(call[2]["expected_sha256"] for call in publications))
        self.assertEqual(
            [artifact["name"] for artifact in response.json()["artifacts"]],
            ["final_report.md", "paper_summary.md", "report.md"],
        )

    def test_final_checkpoint_requires_precise_task_and_propagates_publication_failure(
        self,
    ) -> None:
        self.write_final_delivery()

        async def publish_artifact(*_args, **_kwargs):
            raise ValueError("artifact_snapshot_source_changed")

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_task_type="research_idea",
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        app = FastAPI()
        register_result_routes(app, sessions, SimpleNamespace(), SimpleNamespace())
        headers = {BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"}
        payload = {"run": "run", "checkpoint": "final"}

        with TestClient(app) as client:
            wrong_task = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)
            live.active_task_type = "precise_search"
            failed_publication = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)

        self.assertEqual(wrong_task.status_code, 400, wrong_task.text)
        self.assertEqual(failed_publication.status_code, 400, failed_publication.text)
        self.assertFalse(failed_publication.json()["ok"])

    def test_full_result_is_durable_scoped_and_not_preview_limited(self) -> None:
        database = self.root / "sessions.sqlite3"
        catalog = SessionCatalogStore(database)
        for session, owner in (("s1", "local"), ("private", "other")):
            catalog.register(
                session,
                SessionPrincipal(owner),
                runtime_id="codex",
                vendor_thread_id=session,
                vendor_session_id=None,
                runtime_workdir=str(self.root),
                project_path=None,
                output_root=str(self.root / "outputs"),
                codex_version="contract",
                model_id="contract",
                policy_id="on-request",
                status=SessionStatus.READY,
                title="contract",
                created_at=1.0,
            )
        events = ProductEventStore(database)
        self.metadata["papers"] = [{**self.paper, "id": f"p{index}"} for index in range(25)]
        self.write(self.work.parent / "metadata.json", self.metadata)
        selected_ids = [f"p{index}" for index in range(12)]
        self.write_selection(selected_ids)
        prepared = prepare_result(self.root, "run", "selection")
        self.assertEqual(len(prepared.card.papers), 3)
        metadata_snapshot = (self.work.parent / "metadata.json").read_bytes()
        selection_snapshot = (self.run / "selection.json").read_bytes()
        content = prepared.card.model_dump(mode="json")
        content.update(
            session_id="s1",
            metadata={"artifact_id": "meta", "sha256": prepared.metadata_sha256},
            selection={"artifact_id": "selected", "sha256": prepared.selection_sha256},
        )
        for session in ("s1", "private"):
            events.append(
                session_id=session,
                runtime_id="codex",
                vendor_thread_id=session,
                vendor_turn_id="t1",
                vendor_item_id=None,
                kind=PRODUCT_EVENT_DISPLAY_CARD,
                payload={"type": SEARCH_CARD, "card_id": "card", "content": content},
                idempotency_key="card",
            )

        def export(session, artifact, digest):
            self.assertEqual(session, "s1")
            if artifact == "meta":
                self.assertEqual(digest, prepared.metadata_sha256)
                return metadata_snapshot, "metadata.json"
            self.assertEqual((artifact, digest), ("selected", prepared.selection_sha256))
            return selection_snapshot, "selection.json"

        app = FastAPI()
        register_result_routes(
            app,
            SimpleNamespace(),
            catalog,
            SimpleNamespace(),
            ProductEventStore(database),
            SimpleNamespace(export_bytes=export),
        )
        (self.work.parent / "metadata.json").unlink()
        with TestClient(app) as client:
            response = client.get("/api/sessions/s1/literature/results/card")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(len(response.json()["papers"]), 12)
            self.assertEqual([paper["id"] for paper in response.json()["papers"]], selected_ids)
            self.assertTrue(
                all(paper["decision"] == "included" for paper in response.json()["papers"])
            )
            self.assertEqual(
                client.get("/api/sessions/private/literature/results/card").status_code, 404
            )
            self.assertEqual(
                client.get("/api/sessions/s1/literature/results/missing").status_code, 404
            )

    def test_domain_card_cannot_use_generic_publication(self) -> None:
        registry = CardRegistry()
        registry.register(SEARCH_CARD, validate_search_card, direct=False)
        live = SimpleNamespace(publication_turn_id="t1", bridge_token="private")
        app = FastAPI()
        register_card_routes(app, lambda _: live, registry)
        with TestClient(app) as client:
            response = client.post(
                DISPLAY_CARD_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"type": SEARCH_CARD, "content": {"data": {}}},
            )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"], "display_card_requires_domain_publication")

    def test_idea_candidates_checkpoint_waits_in_turn(self) -> None:
        topic = self.root / "agentic-search-results/topic"
        topic.mkdir(parents=True)
        (topic / "metadata.json").write_text(
            json.dumps(
                {
                    "search_summary": {"query": "新想法", "total_rounds": 1},
                    "papers": [{"paper_id": "a1", "title": "Idea One", "tier": 1}],
                }
            ),
            encoding="utf-8",
        )
        cards = []

        async def publish_artifact(path, role, **kwargs):
            return {"artifact_id": path, "path": path, "sha256": kwargs["expected_sha256"]}

        async def display_card(kind, content, **kwargs):
            cards.append((kind, content.data, kwargs))
            return {"card_id": "card"}

        questions = []

        async def request_product_input(question, **kwargs):
            questions.append((question, kwargs))
            return {"answers": {question["id"]: "一键授权"}}

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_assistant_snapshot_id="snapshot-1",
            active_task_type="research_idea",
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
            interactions=SimpleNamespace(request_product_input=request_product_input),
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        prepare_authorization = Mock(
            return_value=SimpleNamespace(
                authorization_type="research_idea_fulltext",
                scope_digest="scope-digest",
                question_id="research-idea-fulltext:opaque",
            )
        )
        app = FastAPI()
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            authorizer=SimpleNamespace(
                prepare=prepare_authorization,
                granted=lambda _challenge: False,
                granted_scope=lambda **_scope: False,
            ),
        )
        headers = {BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"}
        payload = {"run": "agentic-search-results/topic", "checkpoint": "candidates"}
        with TestClient(app) as client:
            response = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)
            live.active_task_type = "precise_search"
            wrong_task = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(wrong_task.status_code, 400, wrong_task.text)
        authorization = response.json()["authorization"]
        self.assertEqual(authorization["disposition"], "authorized")
        self.assertEqual(authorization["sources"], [{"id": "a1", "title": "Idea One"}])
        self.assertEqual(cards[0][0], SEARCH_CARD)
        self.assertEqual(cards[0][1]["origin"], "agentic-search")
        self.assertTrue(cards[0][1]["metadata"]["artifact_id"])
        self.assertEqual(questions[0][0]["header"], "想法原文授权")
        self.assertEqual(questions[0][1]["turn_id"], "t1")
        prepare_authorization.assert_called_once()
        self.assertEqual(prepare_authorization.call_args.kwargs["refs"], ("paper:a1",))

    def test_cli_has_result_command(self) -> None:
        command = parser().parse_args(["literature", "result", "--json", '{"run":"run"}'])
        self.assertEqual(command.capability, "literature")
        self.assertEqual(command.operation, "result")
        final = parser().parse_args(
            ["literature", "result", "--json", '{"run":"run","checkpoint":"final"}']
        )
        self.assertEqual(json.loads(final.json)["checkpoint"], "final")
        self.assertEqual(
            BLOCKING_CHECKPOINTS[("literature", "result")], frozenset(("selection", "candidates"))
        )


if __name__ == "__main__":
    unittest.main()
