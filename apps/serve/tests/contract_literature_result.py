"""Deterministic contracts for consuming unchanged skill outputs, not acceptance."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from typing import get_args
from unittest.mock import AsyncMock, Mock

_HOME = tempfile.mkdtemp(prefix="ss-result-")
os.environ["SCHOLARSEED_HOME"] = _HOME

from fastapi import FastAPI  # noqa: E402  # imports after SCHOLARSEED_HOME isolation on purpose
from fastapi.testclient import TestClient  # noqa: E402

from service.chat.api.cards import register_card_routes  # noqa: E402
from service.chat.constants import PRODUCT_EVENT_DISPLAY_CARD  # noqa: E402
from service.chat.persistence.catalog import (  # noqa: E402
    SessionCatalogStore,
    SessionPrincipal,
    SessionStatus,
)
from service.chat.persistence.events import ProductEventStore  # noqa: E402
from service.chat.service.cards import (  # noqa: E402
    DISPLAY_CARD_CONTINUE_ACTION,
    DISPLAY_CARD_LIMIT_ERRORS,
    CardRegistry,
    DisplayCardError,
)
from service.chat.service.tasks import ProductTaskLease  # noqa: E402
from service.cli.bridge import BLOCKING_CHECKPOINTS, parser  # noqa: E402
from service.literature.api.gate import FulltextGate  # noqa: E402
from service.literature.api.result import register_result_routes  # noqa: E402
from service.literature.domain.model import LIBRARY_UNAVAILABLE, LiteratureError  # noqa: E402
from service.literature.persistence import fulltexts  # noqa: E402
from service.literature.persistence.delivery import DeliveryStore  # noqa: E402
from service.literature.persistence.files import LiteratureFileBatch, payload_revision  # noqa: E402
from service.literature.persistence.store import LiteratureRepository, connect  # noqa: E402
from service.literature.schema import LiteratureItem  # noqa: E402
from service.literature.service.result import (  # noqa: E402
    AGENTIC_SEARCH_ORIGIN,
    SEARCH_CARD,
    SEARCH_TEXT,
    AuthorizedFulltext,
    prepare_final_delivery,
    prepare_result,
    validate_search_card,
)
from service.literature.service.status import (  # noqa: E402
    LibraryState,
    ResultIdentity,
    ResultStatusService,
)
from service.paths import SERVICE_LITERATURE_FILES_DIR  # noqa: E402
from service.platform.activity import Activities, ActivityDomain  # noqa: E402
from service.platform.bridge import (  # noqa: E402
    DISPLAY_CARD_ROUTE,
    LITERATURE_RESULT_ROUTE,
)
from service.platform.context import ProductTaskType  # noqa: E402
from service.platform.vocabulary import (  # noqa: E402 - requires SCHOLARSEED_HOME isolation
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

REPO_ROOT = Path(__file__).resolve().parents[3]


def fake_authorizer(*, granted: tuple[str, ...] = ()) -> SimpleNamespace:
    """A ledger double: one live challenge when a grant is stated, none otherwise."""

    challenge = SimpleNamespace(
        authorization_id="a1",
        session_id="s1",
        snapshot_id="snapshot",
        turn_id="t1",
        authorization_type="precise_search_fulltext",
        refs=granted,
        scope_digest="d1",
        question_id="precise-search-fulltext:q1",
        state=None,
        created_at=0.0,
    )
    return SimpleNamespace(
        effective_scope=lambda **scope: SimpleNamespace(
            allowed=granted,
            denied=(),
            unknown=scope.get("refs", ()),
            authorizations=(challenge,) if granted else (),
        ),
        task_key=lambda *_scope: "",
        turn_scope=lambda **_scope: (challenge,) if granted else (),
        granted_refs=lambda _challenge: granted,
        turn_granted_refs=lambda **_scope: granted,
        decided=lambda _challenge: bool(granted),
    )


#: Delivery runs in this suite never downloaded, so serve vouches for nothing.
AUTHORIZED = AuthorizedFulltext()
MANAGED_BYTES = b"%PDF-1.7 managed fixture\n"
MANAGED_REVISION = payload_revision(MANAGED_BYTES)
PRECISE_SKILL = REPO_ROOT / "skills" / "community" / "precise-literature-search" / "SKILL.md"
RESEARCH_GUIDANCE_SKILL = (
    REPO_ROOT / "skills" / "community" / "academic-research-guidance" / "SKILL.md"
)
RESEARCH_IDEA_SKILL = REPO_ROOT / "skills" / "community" / "research-idea-partner" / "SKILL.md"
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
                "latest_search_report": "search/round-001/search_report.md",
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
        (self.work.parent / "search_report.md").write_text(
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
                "report": "read_report.md",
            }
        )
        self.write(self.run / "state.json", self.state)
        for name in ("final_report.md", "paper_summary.md", "read_report.md"):
            (self.run / name).write_text(f"# {name}\nverified content\n", encoding="utf-8")

    def test_precise_skill_requires_selected_list_before_one_click_authorization(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")
        self.assertIn("`academic-research-guidance`", prompt)
        self.assertIn(
            "The selected task skill owns its stages, modes, checkpoints, authorizations,",
            RESEARCH_GUIDANCE_SKILL.read_text(encoding="utf-8"),
        )
        self.assertIn('"checkpoint":"search"', skill)
        self.assertNotIn('"checkpoint":"search"', prompt)
        self.assertNotIn('"checkpoint":"selection"', prompt)
        self.assertNotIn("stage.py authorize-download", prompt)
        self.assertIn("selection.json", skill)
        self.assertIn("metadata.json", skill)
        self.assertIn("Do not start either download route", skill)
        self.assertIn("ends the current turn immediately", skill)
        phase_four = skill.index("## Phase 4: authorize and download")
        skill_stage = skill.index('stage.py" authorize-download', phase_four)
        skill_publication = skill.index("`scholarseed_bridge` model tool", skill_stage)
        skill_download = skill.index('stage.py" download', skill_publication)
        self.assertLess(skill_stage, skill_publication)
        self.assertLess(skill_publication, skill_download)

    def test_precise_search_delivery_precedes_download_choices(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        review = skill.split("## Phase 3: review or refine", 1)[1]
        review = review.split("## Phase 4: authorize and download", 1)[0]

        self.assertNotIn("`report.md`", review)
        checkpoint = review.index('"checkpoint":"search"')
        self.assertLess(checkpoint, review.index("Present numbered candidates"))
        for requirement in (
            "Before asking the user to select papers or a download scope",
            "activate this turn's task lease",
            ".precise-literature-search/runs",
            "session working directory",
            "search_report.md",
            "ok: true",
            "card_id",
            "do not proceed to download selection",
            "Outside ScholarSeed",
        ):
            self.assertIn(requirement, review)

    def test_precise_skill_owns_the_product_authorization_contract(self) -> None:
        prompt = HOST_PROMPT.read_text(encoding="utf-8")
        skill = " ".join(PRECISE_SKILL.read_text(encoding="utf-8").split())

        self.assertNotIn("精准检索授权", prompt)
        self.assertNotIn("checkpoint=selection", prompt)
        self.assertIn("the product owns the `精准检索授权` interaction", skill.lower())
        self.assertIn("including the download subset chosen on that card", skill)
        self.assertIn("do not call `literature authorize` for this task", skill.lower())
        # The skill must not keep its own download-scope or reading-confirmation question.
        self.assertNotIn("Offer all papers, arXiv-only papers, or numbered papers", skill)
        self.assertIn("do not ask a separate scope question", skill)
        self.assertIn("no separate reading-confirmation question is asked", skill)
        self.assertIn("stage.py authorize-download", skill)
        self.assertNotIn("require_escalated", skill)

    def test_precise_skill_exclusively_owns_confirmation(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")

        self.assertIn("Before starting — mandatory confirmation", skill)
        self.assertIn("Then STOP and wait for an explicit affirmative response", skill)
        self.assertIn(
            "Intent clarification is not authorization to start, download,",
            RESEARCH_GUIDANCE_SKILL.read_text(encoding="utf-8"),
        )
        self.assertIn(
            "Host context never bypasses the mandatory start confirmation", " ".join(skill.split())
        )
        self.assertNotIn("skip its additional clarification and confirmation", prompt)

    def test_precise_start_confirmation_uses_the_product_question_card(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        confirmation = skill.split("## Before starting — mandatory confirmation", 1)[1]
        confirmation = " ".join(confirmation.split("## Complete workflow", 1)[0].split())

        for requirement in (
            "request_user_input",
            "开始检索",
            "暂不开始",
            "host-confirmed card answer",
            "Do not ask the user to type",
            "Skipped, cancelled, timed-out or unanswered cards are not approval",
            "do not initialize a run",
        ):
            self.assertIn(requirement, confirmation)

    def test_precise_skill_owns_search_publication_and_authorization_recovery(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        search = skill.index('"checkpoint":"search"')
        selection = skill.index('"checkpoint":"selection"')
        self.assertLess(search, selection)
        self.assertIn("another skill's output", skill)
        self.assertIn("keep the existing", skill)
        self.assertIn("plan unchanged while waiting", skill)
        self.assertIn("without searching, selecting or asking for authorization", skill)
        self.assertIn("未读取原文", skill)
        clarification = (PRECISE_SKILL.parent / "modules/intent/clarification.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Explicit auto mode does not waive that confirmation", clarification)
        self.assertIn("one 1–3 question card", clarification)
        self.assertIn("at most one conflict-resolution follow-up", clarification)
        self.assertNotIn("Ask one question per turn", clarification)

    def test_research_idea_uses_checkpoint_owned_one_click_authorization(self) -> None:
        prompt = HOST_PROMPT.read_text(encoding="utf-8")
        skill = " ".join(RESEARCH_IDEA_SKILL.read_text(encoding="utf-8").split())

        self.assertNotIn('"checkpoint":"candidates"', prompt)
        self.assertNotIn("checkpoint=candidates", prompt)
        self.assertNotIn("想法原文授权", prompt)
        self.assertIn('"checkpoint":"candidates"', skill)
        self.assertIn("the product owns the `想法原文授权` interaction", skill)
        self.assertIn("Do not call `literature authorize`, `request_user_input`", skill)
        self.assertNotIn("authorization_type=research_idea_fulltext", skill)
        self.assertNotIn("Use the returned question object unchanged", skill)

    def test_research_idea_skill_retains_recovery_and_abstract_only_boundaries(self) -> None:
        skill = " ".join(RESEARCH_IDEA_SKILL.read_text(encoding="utf-8").split())
        self.assertIn("only titles and abstracts need no full-text authorization", skill)
        self.assertIn("keep the existing plan unchanged", skill)
        self.assertIn("do not search, select or ask for authorization again", skill)
        self.assertIn("do not read full text through another route", skill)
        self.assertIn("never the pre-authorization candidate scope", skill)
        self.assertIn("Do not create page citations", skill)
        self.assertIn("未读取原文", skill)
        chinese = RESEARCH_IDEA_SKILL.with_name("SKILL.zh.md").read_text(encoding="utf-8")
        self.assertIn('"checkpoint":"candidates"', chinese)
        self.assertIn("authorization.disposition", chinese)
        self.assertIn("未读取原文", chinese)

    def test_precise_skill_requires_final_checkpoint_before_claiming_delivery(self) -> None:
        skill = PRECISE_SKILL.read_text(encoding="utf-8")
        prompt = HOST_PROMPT.read_text(encoding="utf-8")

        checkpoint = skill.index('"checkpoint":"final"')
        claim_gate = skill.index("Claim delivery only", checkpoint)
        self.assertLess(checkpoint, claim_gate)
        self.assertIn("final_report.md", skill[checkpoint:])
        self.assertIn("paper_summary.md", skill[checkpoint:])
        self.assertIn("read_report.md", skill[checkpoint:])
        self.assertNotIn('"checkpoint":"final"', prompt)

    @staticmethod
    def write(path: Path, value: dict) -> None:
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_projection_reads_papers_and_counts_without_mutating_run(self) -> None:
        before = {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        result = prepare_result(self.root, "run")
        self.assertTrue(result.card.criteria_details)
        self.assertEqual(result.card.criteria_details[0].kind, "intent")
        self.assertEqual(result.card.criteria_details[0].values, [result.card.criteria[0]])
        self.assertEqual(
            [criterion.text for criterion in result.card.criteria_details], result.card.criteria
        )
        self.assertEqual(
            (result.card.candidates, result.card.deduplicated, result.card.retained), (3, 2, 1)
        )
        self.assertEqual(result.card.papers[0].title, "研究方法")
        self.assertEqual(result.card.papers[0].reasons, ["符合研究问题"])
        self.assertEqual(result.card.papers[0].fulltext, "unknown")
        self.assertEqual(
            before, {str(p): p.read_bytes() for p in self.run.rglob("*") if p.is_file()}
        )

    def test_condition_provenance_preserves_original_values_and_legacy_cards(self) -> None:
        intent = {
            "confirmed": True,
            "precise_intent": "Find papers with 中文条件",
            "language": "English",
            "time_range": {"from_year": 2023},
            "max_results": 10,
            "paper_types": ["journal", "中文期刊"],
            "include_criteria": ["open source"],
            "exclude_criteria": ["surveys"],
        }
        self.write(self.run / "intent.json", intent)
        original = (self.run / "intent.json").read_bytes()
        card = prepare_result(self.root, "run").card
        self.assertEqual(
            card.criteria,
            [
                "Find papers with 中文条件",
                "年份：2023–不限",
                "本轮结果上限：10 篇",
                "文献类型：journal；中文期刊",
                "关键条件：open source",
                "排除条件：surveys",
            ],
        )
        self.assertEqual([row.text for row in card.criteria_details], card.criteria)
        self.assertEqual(
            [row.kind for row in card.criteria_details],
            [
                "intent",
                "years",
                "limit",
                "paper_types",
                "include_criteria",
                "exclude_criteria",
            ],
        )
        self.assertEqual(card.criteria_details[1].values, ["2023", ""])
        self.assertEqual(card.criteria_details[3].values, ["journal", "中文期刊"])
        serialized = card.model_dump(mode="json")
        self.assertEqual(validate_search_card(serialized), serialized)
        del serialized["criteria_details"]
        legacy = validate_search_card(serialized)
        self.assertEqual(legacy["criteria"], card.criteria)
        self.assertEqual(legacy["criteria_details"], [])
        self.assertEqual((self.run / "intent.json").read_bytes(), original)

    def test_condition_provenance_handles_open_ranges_and_omitted_fields(self) -> None:
        for constraint, expected in (
            ({"time_range": {"to_year": 2026}}, [("years", ["", "2026"], "年份：不限–2026")]),
            (
                {"time_range": {"from_year": 2021, "to_year": 2026}},
                [("years", ["2021", "2026"], "年份：2021–2026")],
            ),
            ({"max_results": 1}, [("limit", ["1"], "本轮结果上限：1 篇")]),
            ({"max_results": 0}, []),
            ({"max_results": True}, []),
            (
                {"paper_types": [None, "", "  journal  "]},
                [("paper_types", ["journal"], "文献类型：journal")],
            ),
            ({}, []),
        ):
            with self.subTest(constraint=constraint):
                self.write(self.run / "intent.json", {"confirmed": True, **constraint})
                card = prepare_result(self.root, "run").card
                self.assertEqual(
                    [(row.kind, row.values, row.text) for row in card.criteria_details], expected
                )
                self.assertEqual(card.criteria, [row.text for row in card.criteria_details])

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
        self.assertEqual(result.authorization_refs, ("paper:p2",))

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

        result = prepare_final_delivery(self.root, "run", authorized=AUTHORIZED)

        self.assertEqual(
            [(artifact.path, artifact.role) for artifact in result.artifacts],
            [
                ("run/final_report.md", "final"),
                ("run/paper_summary.md", "supporting"),
                ("run/read_report.md", "supporting"),
            ],
        )
        self.assertTrue(all(len(artifact.sha256) == 64 for artifact in result.artifacts))
        self.assertEqual(
            before, {str(path): path.read_bytes() for path in self.run.rglob("*") if path.is_file()}
        )

    def test_final_checkpoint_rejects_incomplete_empty_or_unsafe_delivery(self) -> None:
        with self.assertRaisesRegex(ValueError, "run_incomplete"):
            prepare_final_delivery(self.root, "run", authorized=AUTHORIZED)

        self.write_final_delivery()
        (self.run / "final_report.md").write_text("", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "artifact_empty"):
            prepare_final_delivery(self.root, "run", authorized=AUTHORIZED)

        (self.run / "final_report.md").write_text("# final\n", encoding="utf-8")
        self.state["paths"]["final_report"] = "../escape.md"
        self.write(self.run / "state.json", self.state)
        with self.assertRaisesRegex(ValueError, "path_invalid"):
            prepare_final_delivery(self.root, "run", authorized=AUTHORIZED)

        self.state["paths"]["final_report"] = "final_report.md"
        self.state["paths"]["paper_summary"] = "final_report.md"
        self.write(self.run / "state.json", self.state)
        with self.assertRaisesRegex(ValueError, "artifact_duplicate"):
            prepare_final_delivery(self.root, "run", authorized=AUTHORIZED)

    def deliver_final(self, authorizer) -> int:
        """Post `checkpoint=final` for this run; assert the refusal reason when blocked."""

        async def publish_artifact(path, role, **kwargs):
            return {
                "artifact_id": f"artifact-{path}",
                "path": path,
                "name": Path(path).name,
                "sha256": kwargs["expected_sha256"],
            }

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_task_type="precise_search",
            product_turn_generation=1,
            current_task=SimpleNamespace(done=lambda: False),
            active_task_lease=ProductTaskLease(
                task_type=ProductTaskType.PRECISE_SEARCH,
                turn_id="t1",
                generation=1,
                source="skill_run",
                workspace="run",
                run_id="run",
            ),
            active_assistant_snapshot_id="snapshot",
            active_product_turn_id="t1",
            ledger=SimpleNamespace(active_turn_id="t1"),
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            activities=activities,
            authorizer=authorizer,
        )
        with TestClient(app) as client:
            response = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "final"},
            )
        if response.status_code != 200:
            self.assertEqual(response.json()["reason"], "literature_result_fulltext_unverified")
        return response.status_code

    def test_final_checkpoint_route_verifies_managed_claims_against_serve(self) -> None:
        self.write_final_delivery()
        (self.run / "downloads").mkdir(parents=True, exist_ok=True)
        self.write(
            self.run / "downloads" / "manifest.json",
            {
                "schema_version": "1.0",
                "run_id": "run1",
                "generated_at": "2026-09-27T00:00:00Z",
                "is_placeholder": False,
                "papers": [
                    {
                        "paper_id": "p1",
                        "title": "t",
                        "access_type": "open",
                        "status": "downloaded",
                        "storage": "managed",
                        "ref": "paper:p1",
                        "revision": MANAGED_REVISION,
                        "file_path": None,
                        "verified_exists": True,
                        "message": "acquired by serve",
                    }
                ],
                "summary": {
                    "selected": 1,
                    "downloaded": 1,
                    "action_required": 0,
                    "failed": 0,
                    "skipped": 0,
                },
                "warnings": [],
            },
        )

        # A manifest claiming managed bytes serve never acquired cannot be delivered.
        self.assertEqual(self.deliver_final(fake_authorizer()), 400)
        # A grant without the bytes behind it cannot be delivered either.
        self.assertEqual(self.deliver_final(fake_authorizer(granted=("paper:p1",))), 400)

        with closing(connect()) as connection, connection:
            fulltexts.ensure_fulltext_schema(connection)
            fulltexts.record_fulltext_object(
                connection,
                fulltexts.FulltextObject(
                    paper_id="p1",
                    object_name="p1-managed.pdf",
                    revision=MANAGED_REVISION,
                    source_kind="arxiv",
                    acquired_at=1.0,
                ),
            )
        self.assertEqual(self.deliver_final(fake_authorizer(granted=("paper:p1",))), 400)
        with LiteratureFileBatch(SERVICE_LITERATURE_FILES_DIR) as batch:
            batch.stage("p1-managed.pdf", MANAGED_BYTES)

            def publish():
                with closing(connect()) as connection, connection:
                    DeliveryStore().record(
                        connection,
                        "s1",
                        "",
                        "run",
                        [
                            {
                                "paper_id": "p1",
                                "object_name": "p1-managed.pdf",
                                "revision": MANAGED_REVISION,
                                "identifier_kind": "arxiv",
                                "identifier": "2501.00001",
                                "title": "Managed fixture",
                            }
                        ],
                        [],
                    )

            batch.commit_operation(publish)
        self.assertEqual(self.deliver_final(fake_authorizer(granted=("paper:p1",))), 200)
        # No task lease means no authorization context: managed claims stay refused.
        self.assertEqual(self.deliver_final(None), 400)

    def test_final_checkpoint_holds_the_grant_line_for_run_storage_entries(self) -> None:
        """paid-route PDFs are untrusted input too: delivery keeps the authorization line."""
        self.write_final_delivery()
        papers = self.run / "downloads" / "papers"
        papers.mkdir(parents=True)
        (papers / "p1.pdf").write_bytes(b"%PDF-1.7 bytes the sandbox fetched itself\n")
        self.write(
            self.run / "downloads" / "manifest.json",
            {
                "schema_version": "1.0",
                "run_id": "run1",
                "generated_at": "2026-09-27T00:00:00Z",
                "is_placeholder": False,
                "papers": [
                    {
                        "paper_id": "p1",
                        "title": "t",
                        "access_type": "paid",
                        "status": "downloaded",
                        "file_path": "downloads/papers/p1.pdf",
                        "content_type": "application/pdf",
                        "verified_exists": True,
                        "message": "downloaded by paper-dl",
                    }
                ],
                "summary": {
                    "selected": 1,
                    "downloaded": 1,
                    "action_required": 0,
                    "failed": 0,
                    "skipped": 0,
                },
                "warnings": [],
            },
        )

        # A forged relay record put this paper into the paid route; the grant never covered it.
        self.assertEqual(self.deliver_final(fake_authorizer(granted=("paper:p2",))), 400)
        # The same bytes under a granted ref deliver without any serve object row.
        self.assertEqual(self.deliver_final(fake_authorizer(granted=("paper:p1",))), 200)

    def test_final_checkpoint_without_a_lease_still_delivers_an_unmanaged_run(self) -> None:
        """A run that never acquired managed full text must not lose its delivery path."""
        self.write_final_delivery()
        (self.run / "downloads").mkdir(parents=True, exist_ok=True)
        self.write(
            self.run / "downloads" / "manifest.json",
            {
                "schema_version": "1.0",
                "run_id": "run1",
                "generated_at": "2026-09-27T00:00:00Z",
                "is_placeholder": False,
                "papers": [
                    {
                        "paper_id": "p1",
                        "title": "t",
                        "access_type": "open",
                        "status": "skipped",
                        "storage": None,
                        "ref": None,
                        "revision": None,
                        "file_path": None,
                        "verified_exists": False,
                        "message": "the product did not acquire this paper",
                    }
                ],
                "summary": {
                    "selected": 1,
                    "downloaded": 0,
                    "action_required": 0,
                    "failed": 0,
                    "skipped": 1,
                },
                "warnings": [],
            },
        )

        async def publish_artifact(path, role, **kwargs):
            return {
                "artifact_id": f"artifact-{path}",
                "path": path,
                "name": Path(path).name,
                "sha256": kwargs["expected_sha256"],
            }

        live = SimpleNamespace(
            id="s1",
            bridge_token="private",
            publication_turn_id="t1",
            active_task_type="",
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app, sessions, SimpleNamespace(), SimpleNamespace(), activities=activities
        )
        with TestClient(app) as client:
            response = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "final"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])

    def test_final_checkpoint_refuses_managed_claims_serve_cannot_vouch_for(self) -> None:
        self.write_final_delivery()
        (self.run / "downloads").mkdir(parents=True, exist_ok=True)
        self.write(
            self.run / "downloads" / "manifest.json",
            {
                "schema_version": "1.0",
                "run_id": "run1",
                "generated_at": "2026-09-27T00:00:00Z",
                "is_placeholder": False,
                "papers": [
                    {
                        "paper_id": "p1",
                        "title": "t",
                        "access_type": "open",
                        "status": "downloaded",
                        "storage": "managed",
                        "ref": "paper:p1",
                        "revision": MANAGED_REVISION,
                        "file_path": None,
                        "verified_exists": True,
                        "message": "acquired by serve",
                    }
                ],
                "summary": {
                    "selected": 1,
                    "downloaded": 1,
                    "action_required": 0,
                    "failed": 0,
                    "skipped": 0,
                },
                "warnings": [],
            },
        )
        granted = AuthorizedFulltext(refs=("paper:p1",), revisions={"p1": MANAGED_REVISION})
        self.assertEqual(
            len(prepare_final_delivery(self.root, "run", authorized=granted).artifacts), 3
        )
        for label, authorized in (
            ("no grant at all", AUTHORIZED),
            (
                "another ref",
                AuthorizedFulltext(refs=("paper:p2",), revisions={"p1": MANAGED_REVISION}),
            ),
            (
                "another revision",
                AuthorizedFulltext(refs=("paper:p1",), revisions={"p1": "sha256:" + "b" * 64}),
            ),
        ):
            with self.subTest(case=label):
                with self.assertRaisesRegex(ValueError, "fulltext_unverified"):
                    prepare_final_delivery(self.root, "run", authorized=authorized)

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
            "matched",
        )

    def test_duplicate_library_rows_are_matched_not_a_third_state(self) -> None:
        """库不去重（proposal 91）：同一篇论文两行，仍然回答「已在库中」。"""

        repository = LiteratureRepository(self.root / "duplicates.sqlite3")
        repository.save(LiteratureItem(id="row-1", title="PagedAttention", doi="10.1/paged"))
        repository.save(
            LiteratureItem(id="row-2", title="PagedAttention", doi="https://doi.org/10.1/paged")
        )
        service = ResultStatusService(repository)
        statuses = service.resolve(
            [
                ResultIdentity(id="by-doi", title="PagedAttention", doi="10.1/paged"),
                ResultIdentity(id="by-title", title="PagedAttention"),
                ResultIdentity(id="unknown", title="Not in the library"),
            ]
        )
        self.assertEqual(statuses["by-doi"]["library"], "matched")
        self.assertEqual(statuses["by-title"]["library"], "matched")
        self.assertEqual(statuses["unknown"]["library"], "absent")
        self.assertLessEqual(
            {status["library"] for status in statuses.values()}, set(get_args(LibraryState))
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

    def test_library_status_failure_is_logged_and_never_reported_as_absent(self) -> None:
        repository = Mock(spec=LiteratureRepository)
        repository.view.side_effect = LiteratureError(LIBRARY_UNAVAILABLE)
        service = ResultStatusService(repository)
        papers = [ResultIdentity(id="paper", title="Research paper")]
        with self.assertLogs("service.literature.service.status", level="WARNING") as captured:
            result = service.resolve(papers, "project-one")
        self.assertEqual(result, {"paper": {"library": "unavailable"}})
        self.assertIn("project-one", captured.output[0])
        self.assertIn("LiteratureError", captured.output[0])

    def test_bridge_requires_live_token_and_uses_actual_files(self) -> None:
        publications = []

        async def publish_artifact(path, role, **kwargs):
            publications.append((path, kwargs))
            return {"artifact_id": "report", "path": path, "name": Path(path).name}

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
            last_submission_id="client-t1",
            active_product_turn_id="client-t1",
            product_turn_generation=1,
            active_task_lease=ProductTaskLease(
                task_type=ProductTaskType.PRECISE_SEARCH,
                turn_id="client-t1",
                generation=1,
                source="skill_run",
                workspace="run",
                run_id="run",
            ),
            interrupt_generation=0,
            active_assistant_revision=None,
            current_task=SimpleNamespace(done=lambda: False),
            ledger=SimpleNamespace(active_turn_id="t1"),
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
            interactions=SimpleNamespace(request_product_input=request_product_input),
            component_for=AsyncMock(return_value=None),
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        prepare_authorization = Mock(
            return_value=SimpleNamespace(
                authorization_type="precise_search_fulltext",
                scope_digest="scope-digest",
                question_id="precise-search-fulltext:opaque",
                turn_id="t1",
                refs=("paper:p1",),
            )
        )
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            activities=activities,
            fulltext_gate=FulltextGate(
                SimpleNamespace(
                    prepare=prepare_authorization,
                    turn_granted_refs=lambda **_scope: (),
                    task_key=lambda *_scope: "",
                    effective_scope=lambda **scope: SimpleNamespace(
                        allowed=(), denied=(), unknown=scope.get("refs", ()), authorizations=()
                    ),
                ),
                SimpleNamespace(),
                activities=activities,
            ),
            authorizer=fake_authorizer(),
        )
        with TestClient(app) as client:
            self.assertEqual(
                client.post(LITERATURE_RESULT_ROUTE, json={"run": "run"}).status_code, 403
            )
            response = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "search"},
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["ok"])
            self.assertEqual(response.json()["card_id"], "card")
            self.assertEqual(
                [publication[0] for publication in publications[:2]],
                ["run/search/round-001/search_report.md", "run/search/round-001/metadata.json"],
            )
            self.assertEqual(publications[2]["report"]["name"], "search_report.md")
            self.assertFalse((self.run / "selection.json").exists())
            self.assertFalse((self.run / "downloads").exists())
            self.assertEqual(product_questions, [])
            prepare_authorization.assert_not_called()
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
            denied = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "selection"},
            )
            self.assertEqual(denied.status_code, 400, denied.text)
            live.active_task_type = "precise_search"
            continued = client.post(
                LITERATURE_RESULT_ROUTE,
                headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                json={"run": "run", "checkpoint": "selection"},
            )
            live.active_task_type = "literature_review"
            with self.assertLogs("service.literature.api.result", level="WARNING") as task_logs:
                wrong_task = client.post(
                    LITERATURE_RESULT_ROUTE,
                    headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                    json={"run": "run", "checkpoint": "selection"},
                )
            live.active_task_type = "precise_search"
            for code in DISPLAY_CARD_LIMIT_ERRORS:

                async def exhausted_card(*_args, _code=code, **_kwargs):
                    raise DisplayCardError(_code)

                live.display_card = exhausted_card
                with self.assertLogs("service.literature.api.result", level="WARNING"):
                    exhausted = client.post(
                        LITERATURE_RESULT_ROUTE,
                        headers={BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"},
                        json={"run": "run", "checkpoint": "selection"},
                    )
                self.assertEqual(exhausted.status_code, 400, exhausted.text)
                self.assertEqual(exhausted.json()["reason"], code)
                self.assertEqual(exhausted.json()["action"], DISPLAY_CARD_CONTINUE_ACTION)
                self.assertEqual(prepare_authorization.call_count, 2)
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
        self.assertIn("validation=active_task_type", task_logs.output[0])
        self.assertIn("active_type_matches=False", task_logs.output[0])
        self.assertIn("turn_id=client-t1", task_logs.output[0])
        self.assertIn("publication_turn_id=t1", task_logs.output[1])
        self.assertNotIn("private", " ".join(task_logs.output))
        self.assertTrue(publications[0][1]["expected_sha256"])
        self.assertEqual(publications[2]["papers"][0]["title"], "研究方法")
        authorization = selected.json()["authorization"]
        self.assertEqual(authorization["authorization_type"], "precise_search_fulltext")
        self.assertEqual(authorization["sources"], [{"id": "p1", "title": "研究方法"}])
        self.assertEqual(authorization["disposition"], "rejected")
        self.assertEqual(authorization["granted_refs"], [])
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
        self.assertEqual(call["refs"], ("paper:p1",))
        self.assertEqual(question["papers"][0]["id"], "paper:p1")

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
            active_assistant_snapshot_id="snapshot",
            active_product_turn_id="t1",
            ledger=SimpleNamespace(active_turn_id="t1"),
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            activities=activities,
            authorizer=fake_authorizer(),
        )

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
                ("run/read_report.md", "supporting"),
            ],
        )
        self.assertTrue(all(call[2]["expected_sha256"] for call in publications))
        self.assertEqual(
            [artifact["name"] for artifact in response.json()["artifacts"]],
            ["final_report.md", "paper_summary.md", "read_report.md"],
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
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app, sessions, SimpleNamespace(), SimpleNamespace(), activities=activities
        )
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
        authors = [f"Research Author {index}" for index in range(54)]
        abstract = "Full abstract evidence. " * 180 + "ABSTRACT END"
        reasons = ["Complete selection rationale. " * 100 + "RATIONALE END"] + [
            f"Additional reason {index}" for index in range(10)
        ]
        self.metadata["papers"] = [
            {
                **self.paper,
                "id": f"p{index}",
                **(
                    {
                        "authors": authors,
                        "abstract": abstract,
                        "relevance": {"reasons": reasons},
                        "reason": reasons[0],
                        "url": "https://example.org/public/paper-long-fields",
                    }
                    if index == 0
                    else {}
                ),
            }
            for index in range(25)
        ]
        self.write(self.work.parent / "metadata.json", self.metadata)
        selected_ids = [f"p{index}" for index in range(12)]
        self.write_selection(selected_ids)
        prepared = prepare_result(self.root, "run", "selection")
        self.assertEqual(len(prepared.card.papers), 3)
        self.assertEqual(prepared.card.papers[0].authors, authors[:20])
        self.assertEqual(prepared.card.papers[0].abstract, abstract[:SEARCH_TEXT])
        self.assertEqual(len(prepared.card.papers[0].reasons), 10)
        oversized_preview = prepared.card.model_dump(mode="json")
        oversized_preview["papers"][0]["authors"] = authors
        with self.assertRaises(ValueError):
            validate_search_card(oversized_preview)
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

        events.append(
            session_id="s1",
            runtime_id="codex",
            vendor_thread_id="s1",
            vendor_turn_id="t1",
            vendor_item_id=None,
            kind=PRODUCT_EVENT_DISPLAY_CARD,
            payload={
                "type": SEARCH_CARD,
                "card_id": "agentic",
                "content": {**content, "origin": AGENTIC_SEARCH_ORIGIN, "selection": {}},
            },
            idempotency_key="agentic",
        )

        app = FastAPI()
        activities = Activities()
        register_result_routes(
            app,
            SimpleNamespace(),
            catalog,
            SimpleNamespace(),
            ProductEventStore(database),
            SimpleNamespace(export_bytes=export),
            activities=activities,
        )
        (self.work.parent / "metadata.json").unlink()
        with TestClient(app) as client:
            response = client.get("/api/sessions/s1/literature/results/card")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["criteria"], content["criteria"])
            self.assertEqual(response.json()["criteria_details"], content["criteria_details"])
            self.assertEqual(len(response.json()["papers"]), 12)
            self.assertEqual([paper["id"] for paper in response.json()["papers"]], selected_ids)
            self.assertEqual(response.json()["papers"][0]["authors"], authors)
            self.assertEqual(response.json()["papers"][0]["abstract"], abstract)
            self.assertEqual(response.json()["papers"][0]["reasons"], reasons)
            self.assertTrue(
                all(paper["decision"] == "included" for paper in response.json()["papers"])
            )
            self.assertEqual(
                client.get("/api/sessions/private/literature/results/card").status_code, 404
            )
            self.assertEqual(
                client.get("/api/sessions/s1/literature/results/missing").status_code, 404
            )
            agentic = client.get("/api/sessions/s1/literature/results/agentic")
            self.assertEqual(agentic.status_code, 200, agentic.text)
            self.assertEqual(len(agentic.json()["papers"]), 25)
            self.assertEqual(agentic.json()["papers"][0]["authors"], authors)
            self.assertEqual(agentic.json()["papers"][0]["abstract"], abstract)
            self.assertEqual(agentic.json()["papers"][0]["reasons"], [reasons[0]])
            self.assertEqual(
                agentic.json()["papers"][0]["url"], "https://example.org/public/paper-long-fields"
            )

    def test_domain_card_cannot_use_generic_publication(self) -> None:
        registry = CardRegistry()
        registry.register(SEARCH_CARD, validate_search_card, direct=False)
        live = SimpleNamespace(publication_turn_id="t1", bridge_token="private")
        app = FastAPI()
        activities = Activities()
        self.activities = activities
        live.bridge_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.bridge_activity.close)
        register_card_routes(app, lambda _: live, registry, activities=activities)
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
            last_submission_id="client-t1",
            interrupt_generation=0,
            active_assistant_revision=None,
            current_task=None,
            ledger=SimpleNamespace(active_turn_id="t1"),
            runtime_workdir=self.root,
            publish_artifact=publish_artifact,
            display_card=display_card,
            interactions=SimpleNamespace(request_product_input=request_product_input),
            component_for=AsyncMock(return_value=None),
        )
        sessions = SimpleNamespace(bridge_caller=lambda key: live if key == "s1" else None)
        prepare_authorization = Mock(
            return_value=SimpleNamespace(
                authorization_type="research_idea_fulltext",
                scope_digest="scope-digest",
                question_id="research-idea-fulltext:opaque",
                turn_id="t1",
                refs=("literature:r1",),
            )
        )
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_result_routes(
            app,
            sessions,
            SimpleNamespace(),
            SimpleNamespace(),
            activities=activities,
            fulltext_gate=FulltextGate(
                SimpleNamespace(
                    prepare=prepare_authorization,
                    turn_granted_refs=lambda **_scope: (),
                    task_key=lambda *_scope: "",
                    effective_scope=lambda **scope: SimpleNamespace(
                        allowed=("literature:r1",) if questions else (),
                        denied=(),
                        unknown=() if questions else scope.get("refs", ()),
                        authorizations=(),
                    ),
                ),
                SimpleNamespace(),
                activities=activities,
            ),
            authorizer=fake_authorizer(),
        )
        headers = {BRIDGE_SESSION_HEADER: "s1", BRIDGE_TOKEN_HEADER: "private"}
        payload = {"run": "agentic-search-results/topic", "checkpoint": "candidates"}
        with TestClient(app) as client:
            response = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)
            live.active_task_type = "precise_search"
            wrong_task = client.post(LITERATURE_RESULT_ROUTE, headers=headers, json=payload)
            live.active_task_type = ""
            metadata = client.post(
                LITERATURE_RESULT_ROUTE,
                headers=headers,
                json={**payload, "checkpoint": "metadata", "skill": "agentic-search"},
            )
            missing_skill = client.post(
                LITERATURE_RESULT_ROUTE, headers=headers, json={**payload, "checkpoint": "metadata"}
            )
        self.assertEqual(metadata.status_code, 200, metadata.text)
        self.assertEqual(metadata.json()["retained"], 1)
        self.assertNotIn("authorization", metadata.json())
        self.assertEqual(missing_skill.status_code, 400)
        self.assertEqual(len(questions), 1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(wrong_task.status_code, 400, wrong_task.text)
        authorization = response.json()["authorization"]
        self.assertEqual(authorization["disposition"], "authorized")
        self.assertEqual(
            authorization["sources"],
            [{"id": "a1", "ref_id": "paper:a1", "title": "Idea One"}],
        )
        self.assertIn("literature/acquire", authorization["guidance"])
        self.assertIn("pdf/read", authorization["guidance"])
        self.assertIn("not", authorization["guidance"])
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
