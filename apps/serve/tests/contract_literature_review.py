"""Survey projection, scope and publication contract (not product acceptance)."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.active import DEVELOPER_PROMPT_FILE
from service.chat.service.cards import CardRegistry
from service.chat.service.tasks import ProductTaskLease
from service.cli.bridge import parser
from service.literature.api.gate import FulltextGate
from service.literature.api.review import register_literature_review_routes
from service.literature.service.confirmation import REVIEW_PACKET, prepare_confirmation
from service.literature.service.result import SEARCH_CARD
from service.literature.service.review import (
    CHECK_LABELS,
    CORPUS,
    FULLTEXT,
    GENERATION,
    METADATA,
    OUTLINE,
    POSTCHECK,
    QUALITY,
    QUERY,
    REQUIREMENTS,
    RETRIEVAL,
    REVIEW_CARD,
    SUMMARY,
    WRITING_REQUEST,
    _fulltext_limitation_reason,
    prepare_review,
    prepare_review_search,
    review_retrieval_run,
    validate_review_card,
    validate_review_checkpoint,
)
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
    LITERATURE_REVIEW_ROUTE,
)
from service.platform.context import ProductTaskType

LITERATURE_PUBLICATION_SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "skills/community/literature-review/scripts/manuscript_publication.py"
)
LITERATURE_SKILL_FILE = (
    Path(__file__).resolve().parents[3] / "skills/community/literature-review/SKILL.md"
)


class LiteratureReviewContract(unittest.TestCase):
    def test_review_preserves_supported_citation_styles(self) -> None:
        for checkpoint in ("outline", "result"):
            for style in ("numeric", "author_year", "ieee", "acm", "gbt7714_2025"):
                with self.subTest(checkpoint=checkpoint, style=style):
                    self.write(
                        WRITING_REQUEST,
                        {
                            "intent": "中文综述",
                            "publication": {"format": "latex_pdf", "citation_style": style},
                        },
                    )
                    card = prepare_review(self.root, "survey", checkpoint).card
                    projected = validate_review_card(card.model_dump(mode="json"))
                    self.assertEqual(projected["output"]["citation_style"], style)

    def test_review_rejects_unknown_citation_style(self) -> None:
        self.write(
            WRITING_REQUEST,
            {
                "intent": "中文综述",
                "publication": {"format": "latex_pdf", "citation_style": "unsupported"},
            },
        )
        with self.assertRaises(ValueError):
            prepare_review(self.root, "survey", "outline")

    def test_outline_confirmation_policies_and_settings(self) -> None:
        packet = {
            "packet_id": "packet",
            "snapshot": {},
            "outline_review": "timeout_auto",
            "confirmation": {"state": "awaiting_display"},
            "publication_display": {"format": "Markdown", "citation_style": "IEEE"},
        }
        self.write(REVIEW_PACKET, packet)
        timed = prepare_confirmation(self.root, "survey", "session", "turn")
        self.assertEqual(timed.timeout_seconds, 300)
        self.assertIn("Markdown", timed.question["question"])
        self.assertIn("IEEE", timed.question["question"])
        self.assertIn("修改意见", timed.question["question"])
        self.assertEqual(timed, prepare_confirmation(self.root, "survey", "session", "turn"))
        packet["outline_review"] = "required"
        packet["confirmation"]["state"] = "required"
        self.write(REVIEW_PACKET, packet)
        required = prepare_confirmation(self.root, "survey", "session", "turn")
        self.assertIsNone(required.timeout_seconds)
        self.assertNotIn("5 分钟", required.question["question"])
        for state in ("auto", "approved", "timeout_applied"):
            packet["confirmation"]["state"] = state
            self.write(REVIEW_PACKET, packet)
            self.assertIsNone(prepare_confirmation(self.root, "survey", "session", "turn").question)

    def test_fulltext_limitation_reason_hides_internal_diagnostics(self) -> None:
        self.assertEqual(
            _fulltext_limitation_reason(
                {"outcome": "not_in_paperhub", "detail": "PaperHub download HTTP 404"}
            ),
            "全文来源暂未返回可下载文件，仅使用摘要证据",
        )
        self.assertEqual(
            _fulltext_limitation_reason(
                {"outcome": "extract_failed", "detail": "float without caption: figure"}
            ),
            "全文解析失败",
        )

    def test_literature_review_skill_owns_intake_and_output_decision_order(self) -> None:
        prompt = DEVELOPER_PROMPT_FILE.read_text(encoding="utf-8")
        skill = LITERATURE_SKILL_FILE.read_text(encoding="utf-8")
        intake = "writing configure --request"
        after_outline = "outline review-packet"
        output_question = "Follow `confirmation.state`"

        self.assertIn(intake, skill)
        self.assertLess(skill.index(after_outline), skill.index(output_question))
        self.assertIn("`required` needs a real confirmation", skill)
        self.assertIn("Configured publication settings alone do not establish user approval", skill)
        self.assertNotIn(intake, prompt)
        self.assertNotIn(output_question, prompt)

    def test_review_checkpoint_does_not_replace_explicit_artifact_publication(self) -> None:
        prompt = DEVELOPER_PROMPT_FILE.read_text(encoding="utf-8")
        skill = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split())
        self.assertIn("it does not publish user-facing file cards", skill)
        self.assertIn("After the final write of each independent user-facing deliverable", skill)
        self.assertIn('"checkpoint":"outline"', skill)
        self.assertIn('"checkpoint":"result"', skill)
        self.assertIn('"capability":"artifact"', skill)
        self.assertNotIn('"checkpoint":"outline"', prompt)
        self.assertNotIn('"checkpoint":"result"', prompt)
        self.assertNotIn("## Agent File Artifacts", prompt)
        self.assertIn("`scholarseed-product-operations`", prompt)
        artifact_rules = (
            LITERATURE_SKILL_FILE.parent.parent
            / "scholarseed-product-operations"
            / "references"
            / "artifacts.md"
        ).read_text(encoding="utf-8")
        self.assertIn("## Agent File Artifacts", artifact_rules)
        self.assertIn("`capability=artifact`, `operation=publish`", artifact_rules)

    def test_review_skill_owns_recovery_and_evidence_limits(self) -> None:
        prompt = DEVELOPER_PROMPT_FILE.read_text(encoding="utf-8")
        skill = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split())
        self.assertNotIn("综述检索授权", prompt)
        self.assertNotIn("checkpoint=retrieval", prompt)
        self.assertIn("without searching, selecting or asking for authorization again", skill)
        self.assertIn("未读取原文", skill)
        self.assertIn("WARN, FAIL, NOT_CHECKED", skill)
        self.assertIn("not online existence or claim-to-original-text support", skill)
        self.assertIn("do not create a second native flat plan", skill)

    def test_authoritative_writing_request_drives_review_scope(self) -> None:
        self.write(
            WRITING_REQUEST,
            {
                "intent": "原始综述意图",
                "effective_requirements": "聚焦方法比较",
                "retrieval": {
                    "time_range": {"start_year": 2022, "end_year": 2026},
                    "temporal_policy": "soft_preference",
                    "dimensions": {"analysis": ["方法演进"]},
                },
                "publication": {"format": "markdown", "citation_style": "author_year"},
                "constraints": [
                    {
                        "id": "paper",
                        "kind": "must_include_paper",
                        "value": {"title": "指定论文"},
                        "verbatim": "指定论文",
                    }
                ],
            },
        )
        card = prepare_review(self.root, "survey", "outline").card
        self.assertEqual(card.intent, "原始综述意图")
        self.assertEqual(card.scope.topic, "聚焦方法比较")
        self.assertEqual(card.scope.time_range, "2022–2026；允许早期基础文献")
        self.assertEqual(card.scope.requested_materials, ["指定论文"])
        self.assertEqual(card.output.format, "markdown")
        self.assertEqual(card.output.citation_style, "author_year")

    def test_retrieval_waits_on_the_blocking_checkpoint_in_the_same_turn(self) -> None:
        prompt = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split())
        separate = "Run `run retrieval_adapt` as its own command"
        wait = "wait for the product authorization in this same turn"
        checkpoint = '"checkpoint":"retrieval"'
        plan_transition = "first write the existing structured plan"
        resume = (
            "only after that plan write succeeds may you run `workflow evidence --from fulltext`"
        )

        self.assertLess(prompt.index(separate), prompt.index(wait))
        self.assertLess(prompt.index(wait), prompt.index(checkpoint))
        self.assertLess(prompt.index(checkpoint), prompt.index(plan_transition))
        self.assertLess(prompt.index(plan_transition), prompt.index(resume))
        self.assertIn("never start `workflow evidence` without `--from`", prompt.lower())
        self.assertIn("Keep the existing plan tree unchanged while waiting", prompt)
        self.assertIn(
            "Do not call `request_user_input`, construct or relay an authorization question",
            " ".join(prompt.split()),
        )
        self.assertIn("make no full-text or later-stage writes", prompt)
        self.assertNotIn("checkpoint retrieval", prompt)

    def test_skill_cannot_cross_the_retrieval_authorization_boundary(self) -> None:
        instructions = LITERATURE_SKILL_FILE.read_text(encoding="utf-8")
        evidence = instructions[instructions.index("## 3. Evidence") :]
        retrieval = "Run `run retrieval_adapt` as its own command"
        checkpoint = "`scholarseed_bridge` model tool"
        authorization = "`authorization.disposition=authorized`"
        resume = "`workflow evidence --from fulltext`"

        self.assertLess(evidence.index(retrieval), evidence.index(checkpoint))
        self.assertLess(evidence.index(checkpoint), evidence.index(authorization))
        self.assertLess(evidence.index(authorization), evidence.index(resume))
        self.assertIn("Never start `workflow evidence` without `--from`", instructions)
        self.assertIn("it never enters full text", instructions)
        self.assertIn("Do not call `request_user_input`", instructions)

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.workspace = self.root / "survey"
        self.write(QUERY, {"query": "对比研究方法及限制"})
        self.write(
            REQUIREMENTS,
            {
                "req_normal": {
                    "topic": "对比研究方法及限制（2021—2026）",
                    "time_range": {"start_year": 2021, "end_year": 2026},
                    "dimensions": {"analysis": ["方法演进", "结论冲突"]},
                },
                "req_special": [],
            },
        )
        self.write(CORPUS, {"p1": {"title": "One"}, "p2": {"title": "Two"}})
        self.outline = {
            "survey_title": "方法与边界",
            "outline_tree": [
                {
                    "section_id": "1",
                    "title": "方法",
                    "description": "跨文献比较",
                    "subsections": [
                        {"title": "条件", "paper_ids": ["p1", "p2"]},
                        {"title": "误差", "paper_ids": ["p1"]},
                    ],
                }
            ],
        }
        self.write(OUTLINE, self.outline)
        self.write(
            REVIEW_PACKET,
            {
                "packet_id": "packet",
                "outline_review": "auto",
                "snapshot": {},
                "confirmation": {"state": "auto"},
            },
        )
        self.write(SUMMARY, {"total_papers": 2, "with_fulltext": 1})
        self.report = {
            "schema": "slr/postcheck/1",
            "facts": {"distinct_cited": 1},
            "checks": [{"id": "cite_sync", "verdict": "PASS", "reason": "key matches"}],
        }

    def write(self, name: str, value: dict | str) -> None:
        path = self.workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding="utf-8")

    def test_real_skill_publication_artifacts_feed_the_result_card_contract(self) -> None:
        generation = self.workspace / "05_generation"
        generation.mkdir(parents=True, exist_ok=True)
        (generation / "full_draft_v2.md").write_text(
            "# 方法与边界\n\n综合比较。\\citep{Keyp1}\n", encoding="utf-8"
        )
        (generation / "citations.bib").write_text(
            "@article{Keyp1,title={One},author={Example},year={2024}}\n",
            encoding="utf-8",
        )
        for action in ("publish", "postcheck"):
            completed = subprocess.run(
                [
                    sys.executable,
                    str(LITERATURE_PUBLICATION_SCRIPT),
                    action,
                    "--workspace",
                    str(self.workspace),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        raw_generation = json.loads((self.workspace / GENERATION).read_text(encoding="utf-8"))
        raw_postcheck = json.loads((self.workspace / POSTCHECK).read_text(encoding="utf-8"))
        self.assertNotIn("final_status", raw_generation)
        self.assertNotIn("schema", raw_postcheck)
        self.assertIn("unknown_citations", [check["id"] for check in raw_postcheck["checks"]])
        prepared = prepare_review(self.root, "survey", "result")
        self.assertEqual(prepared.card.status, "generated")
        self.assertEqual(
            [check.title for check in prepared.card.checks],
            [CHECK_LABELS[name] for name in ("cite_sync", "page_render", "deliverable")],
        )

    def test_new_publication_checks_preserve_failure_and_partial_page_scope(self) -> None:
        self.write(GENERATION, {"status": "FAILED"})
        self.write(
            POSTCHECK,
            {
                "status": "FAILED",
                "checks": [
                    {"id": "unknown_citations", "status": "SUCCESS"},
                    {"id": "bibliography_ownership", "status": "FAILED"},
                    {"id": "bibliography_definitions", "status": "FAILED"},
                    {"id": "visual_inspection_scope", "status": "WARNING"},
                ],
                "visual_review_required": True,
                "pages_to_read": ["partial-page.png"],
            },
        )
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "failed")
        self.assertEqual([check.verdict for check in card.checks], ["FAIL", "WARN", "FAIL"])

    def retrieval_payload(self) -> dict[str, str]:
        run_id = "review-run"
        self.write(".slr-binding.json", {"schema_version": 1, "run_id": run_id})
        self.write(
            "_status/retrieval_adapt.json",
            {"stage": "retrieval_adapt", "status": "SUCCESS"},
        )
        artifacts = []
        for role, name in (
            ("metadata", METADATA),
            ("selection", CORPUS),
            ("report", RETRIEVAL),
        ):
            artifacts.append(
                {
                    "role": role,
                    "path": name,
                    "sha256": hashlib.sha256((self.workspace / name).read_bytes()).hexdigest(),
                }
            )
        manifest = {
            "schema_version": 1,
            "kind": "literature_review.retrieval_ready",
            "run_id": run_id,
            "workspace": "survey",
            "checkpoint": "retrieval",
            "attempt": 1,
            "stage_status_path": "_status/retrieval_adapt.json",
            "artifacts": artifacts,
        }
        self.write("_status/checkpoints/retrieval.json", manifest)
        manifest_path = self.workspace / "_status/checkpoints/retrieval.json"
        return {
            "workspace": "survey",
            "checkpoint": "retrieval",
            "run_id": run_id,
            "manifest": "_status/checkpoints/retrieval.json",
            "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        }

    def test_real_files_deduplicate_and_remain_unchanged(self) -> None:
        before = {str(p): p.read_bytes() for p in self.workspace.rglob("*") if p.is_file()}
        prepared = prepare_review(self.root, "survey", "outline")
        self.assertEqual(prepared.card.sections[0].papers, 2)
        self.assertEqual(prepared.card.fulltext, 1)
        self.assertIsNone(prepared.card.cited)
        self.assertEqual(prepared.card.warnings, [])
        self.assertEqual(
            before, {str(p): p.read_bytes() for p in self.workspace.rglob("*") if p.is_file()}
        )
        for source in prepared.files:
            self.assertEqual(prepared.card.source_hashes[source.path], source.digest)

    def test_missing_counts_not_zero_and_wrong_coverage_rejected(self) -> None:
        (self.workspace / SUMMARY).unlink()
        self.assertIsNone(prepare_review(self.root, "survey", "outline").card.fulltext)
        self.write(SUMMARY, {"total_papers": 2, "with_fulltext": 3})
        with self.assertRaisesRegex(ValueError, "coverage_invalid"):
            prepare_review(self.root, "survey", "outline")

    def test_retrieval_projects_all_candidates_and_only_previews_three(self) -> None:
        papers = [
            {
                "paper_id": f"p{index}",
                "title": f"Paper {index}",
                "authors": ["Author"],
                "year": 2020 + index,
                "venue": "Journal",
                "source": "paperhub",
                "tier": 1 if index < 2 else 2,
                "citation_count": index,
                "reason": f"Reason {index}",
            }
            for index in range(1, 6)
        ]
        self.write(METADATA, {"papers": papers})
        self.write(
            CORPUS,
            {
                "p1": {**papers[0], "selection_reason": "Core evidence"},
                "p2": {**papers[1], "selection_reason": "Contrasting result"},
            },
        )
        self.write(
            RETRIEVAL,
            {
                "input_count": 5,
                "output_count": 2,
                "dropped": [{"paper_id": "p5", "reason": "Outside scope"}],
                "flagged_for_review": [],
                "degradations": [],
            },
        )
        self.write(
            FULLTEXT,
            {
                "with_full_text": 1,
                "papers": [
                    {"paper_id": "p1", "chars": 100},
                    {"paper_id": "p2", "chars": 0},
                ],
            },
        )
        prepared = prepare_review_search(self.root, "survey", "review-run")
        self.assertEqual(prepared.card.run_id, "review-run")
        self.assertEqual(prepared.card.candidates, 5)
        self.assertEqual(prepared.card.retained, 2)
        self.assertEqual(len(prepared.card.papers), 3)
        self.assertEqual(
            [paper.decision for paper in prepared.card.papers[:2]], ["included", "included"]
        )
        self.assertEqual(prepared.card.papers[0].fulltext, "fulltext")
        self.assertEqual(prepared.card.papers[1].fulltext, "abstract")
        self.assertEqual(prepared.card.sources[0].name, "paperhub")
        self.assertEqual(len(prepared.files), 6)
        self.assertEqual(
            [(source.id, source.ref_id) for source in prepared.authorization_sources],
            [("p1", "paper:p1"), ("p2", "paper:p2")],
        )
        self.assertEqual(prepared.authorization_refs[-1], f"artifact:{prepared.corpus_sha256}")

    def test_retrieval_checkpoint_binds_run_workspace_and_artifact_bytes(self) -> None:
        self.write(METADATA, {"papers": [{"paper_id": "p1", "title": "One"}]})
        self.write(RETRIEVAL, {"input_count": 1, "output_count": 1, "dropped": []})
        payload = self.retrieval_payload()
        hashes = validate_review_checkpoint(
            self.root,
            payload["workspace"],
            payload["run_id"],
            payload["manifest"],
            payload["manifest_sha256"],
        )
        self.assertEqual(len(hashes), 3)
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            validate_review_checkpoint(
                self.root,
                payload["workspace"],
                "another-run",
                payload["manifest"],
                payload["manifest_sha256"],
            )
        self.write(CORPUS, {"p2": {"title": "Different selection"}})
        with self.assertRaisesRegex(ValueError, "artifact_changed"):
            validate_review_checkpoint(
                self.root,
                payload["workspace"],
                payload["run_id"],
                payload["manifest"],
                payload["manifest_sha256"],
            )

    def test_retrieval_run_uses_launcher_id_or_workspace_identity(self) -> None:
        self.write(
            "_status/retrieval_adapt.json", {"stage": "retrieval_adapt", "status": "SUCCESS"}
        )
        self.write(".slr-binding.json", {"schema_version": 1, "run_id": "launcher-run"})
        self.assertEqual(review_retrieval_run(self.root, "survey"), "launcher-run")
        self.write(".slr-binding.json", {"skill": "/skills/literature-review", "version": "1.1.0"})
        derived = review_retrieval_run(self.root, "survey")
        self.assertTrue(derived.startswith("slr-"))
        self.assertEqual(review_retrieval_run(self.root, "./survey"), derived)
        self.write(
            "_status/retrieval_adapt.json", {"stage": "retrieval_adapt", "status": "RUNNING"}
        )
        with self.assertRaisesRegex(ValueError, "status_invalid"):
            review_retrieval_run(self.root, "survey")

    def test_session_root_workspace_preserves_retrieval_identity_and_paths(self) -> None:
        self.workspace = self.root
        self.write(
            "_status/retrieval_adapt.json", {"stage": "retrieval_adapt", "status": "SUCCESS"}
        )
        self.write(".slr-binding.json", {"schema_version": 1, "run_id": "root-run"})
        self.write(METADATA, {"papers": [{"paper_id": "p1", "title": "One"}]})
        self.write(CORPUS, {"p1": {"paper_id": "p1", "title": "One"}})
        self.write(RETRIEVAL, {"input_count": 1, "output_count": 1})
        self.assertEqual(review_retrieval_run(self.root, "."), "root-run")
        prepared = prepare_review_search(self.root, ".", "root-run")
        self.assertEqual({source.path for source in prepared.files}, {METADATA, CORPUS, RETRIEVAL})
        self.assertEqual(prepared.card.candidates, 1)

        manifest = {
            "schema_version": 1,
            "kind": "literature_review.retrieval_ready",
            "run_id": "root-run",
            "workspace": ".",
            "checkpoint": "retrieval",
            "stage_status_path": "_status/retrieval_adapt.json",
            "artifacts": [
                {
                    "role": role,
                    "path": name,
                    "sha256": hashlib.sha256((self.root / name).read_bytes()).hexdigest(),
                }
                for role, name in (
                    ("metadata", METADATA),
                    ("selection", CORPUS),
                    ("report", RETRIEVAL),
                )
            ],
        }
        self.write("_status/checkpoints/retrieval.json", manifest)
        manifest_path = self.root / "_status/checkpoints/retrieval.json"
        hashes = validate_review_checkpoint(
            self.root,
            ".",
            "root-run",
            "_status/checkpoints/retrieval.json",
            hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        )
        self.assertEqual(set(hashes), {METADATA, CORPUS, RETRIEVAL})
        for workspace in ("../survey", str(self.root)):
            with self.assertRaisesRegex(ValueError, "relative_path_invalid"):
                review_retrieval_run(self.root, workspace)

    def test_session_root_retrieval_reaches_authorization_without_moving_files(self) -> None:
        self.workspace = self.root
        self.write(
            "_status/retrieval_adapt.json", {"stage": "retrieval_adapt", "status": "SUCCESS"}
        )
        self.write(".slr-binding.json", {"schema_version": 1, "run_id": "root-run"})
        self.write(METADATA, {"papers": [{"paper_id": "p1", "title": "One", "source": "paperhub"}]})
        self.write(CORPUS, {"p1": {"paper_id": "p1", "title": "One", "source": "paperhub"}})
        self.write(RETRIEVAL, {"input_count": 1, "output_count": 1})
        published = []
        cards = []

        async def publish(path, role, **kwargs):
            published.append(path)
            return {"artifact_id": path, "path": path, "sha256": kwargs["expected_sha256"]}

        async def display(kind, content, **kwargs):
            cards.append((kind, content.data))
            return {"card_id": "root-card"}

        async def authorize_sources(*args, **kwargs):
            challenge = SimpleNamespace(
                authorization_type="literature_review_fulltext", scope_digest="root-scope"
            )
            return challenge, SimpleNamespace(value="authorized"), None

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            active_assistant_snapshot_id="snapshot-1",
            runtime_workdir=self.root,
            active_task_lease=ProductTaskLease(
                task_type=ProductTaskType.LITERATURE_REVIEW,
                turn_id="turn",
                generation=1,
                source="skill_run",
                workspace=".",
                run_id="root-run",
            ),
            publish_artifact=publish,
            display_card=display,
        )
        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == live.id else None)
        app = FastAPI()
        register_literature_review_routes(
            app, sessions, SimpleNamespace(authorize_sources=authorize_sources)
        )
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: live.bridge_token}
        with TestClient(app) as client:
            mismatch = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "02_retrieval", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(mismatch.status_code, 400, mismatch.text)
            self.assertEqual(mismatch.json()["reason"], "review_workspace_mismatch")
            self.assertIn("task activation", mismatch.json()["action"])

            response = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": ".", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["authorization"]["disposition"], "authorized")
            self.assertEqual(cards[0][0], SEARCH_CARD)
            self.assertEqual(set(published), {METADATA, CORPUS, RETRIEVAL})

            (self.root / "_status/retrieval_adapt.json").unlink()
            missing = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": ".", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(missing.status_code, 400, missing.text)
            self.assertEqual(missing.json()["reason"], "review_artifact_missing")

    def test_retrieval_checkpoint_rejects_noncanonical_stage_status(self) -> None:
        self.write(METADATA, {"papers": [{"paper_id": "p1", "title": "One"}]})
        self.write(RETRIEVAL, {"input_count": 1, "output_count": 1, "dropped": []})
        payload = self.retrieval_payload()
        manifest_path = self.workspace / payload["manifest"]
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["stage_status_path"] = "_status/copied-status.json"
        self.write("_status/copied-status.json", {"stage": "retrieval_adapt", "status": "SUCCESS"})
        self.write(payload["manifest"], manifest)
        payload["manifest_sha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "status_invalid"):
            validate_review_checkpoint(
                self.root,
                payload["workspace"],
                payload["run_id"],
                payload["manifest"],
                payload["manifest_sha256"],
            )

    def test_outside_paths_symlinks_and_missing_paper_rejected(self) -> None:
        for workspace in ("../survey", str(self.workspace)):
            with self.assertRaises(ValueError):
                prepare_review(self.root, workspace, "outline")
        self.outline["outline_tree"][0]["subsections"][0]["paper_ids"] = ["unknown"]
        self.write(OUTLINE, self.outline)
        with self.assertRaisesRegex(ValueError, "corpus_mismatch"):
            prepare_review(self.root, "survey", "outline")
        (self.workspace / QUERY).unlink()
        (self.workspace / QUERY).symlink_to(self.workspace / CORPUS)
        with self.assertRaises((OSError, ValueError)):
            prepare_review(self.root, "survey", "outline")

    def test_files_and_report_status_are_not_combined_into_completion(self) -> None:
        self.write("06_output/survey.md", "# A real file, but no completed stage")
        self.assertEqual(prepare_review(self.root, "survey", "result").card.status, "incomplete")
        self.write(GENERATION, {"final_status": "SUCCESS"})
        self.assertEqual(prepare_review(self.root, "survey", "result").card.status, "generated")
        self.write(
            GENERATION,
            {
                "final_status": "SUCCESS",
                "compile": {
                    "status": "SUCCESS",
                    "output": str(self.workspace / "06_output/survey.md"),
                },
            },
        )
        self.report["deliverable"] = str(self.workspace / "06_output/survey.md")
        self.write(POSTCHECK, self.report)
        self.report["checks"][0]["verdict"] = "NOT_CHECKED"
        self.write(POSTCHECK, self.report)
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "generated")
        self.assertEqual(card.checks[0].verdict, "NOT_CHECKED")
        self.assertEqual(card.cited, 1)
        self.write(GENERATION, {"final_status": "FAILED"})
        self.assertEqual(prepare_review(self.root, "survey", "result").card.status, "failed")

    def test_missing_checks_are_not_invented_and_report_verdicts_not_rewritten(self) -> None:
        self.write("06_output/survey.md", "# Document")
        self.write(SUMMARY, {"total_papers": 2, "with_fulltext": 2})
        self.write(
            GENERATION,
            {
                "final_status": "SUCCESS",
                "compile": {
                    "status": "SUCCESS",
                    "output": str(self.workspace / "06_output/survey.md"),
                },
            },
        )
        self.report.update(verdict="PASS", deliverable=str(self.workspace / "06_output/survey.md"))
        self.write(POSTCHECK, self.report)
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(len(card.checks), 1)
        self.assertEqual(sum(check.verdict == "NOT_CHECKED" for check in card.checks), 0)
        self.assertEqual(card.status, "generated")
        self.report["checks"] *= 2
        self.write(POSTCHECK, self.report)
        with self.assertRaisesRegex(ValueError, "identity_invalid"):
            prepare_review(self.root, "survey", "result")
        self.report["checks"] = [{"id": identity, "verdict": "PASS"} for identity in CHECK_LABELS]
        self.write(QUALITY, {"schema_version": "1.0", "overall": {"verdict": "PASS"}})
        self.write(POSTCHECK, self.report)
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "generated")
        self.assertEqual(card.warnings, [])
        self.report["hallucinated_keys"] = ["missing-source"]
        self.write(POSTCHECK, self.report)
        self.assertEqual(prepare_review(self.root, "survey", "result").card.status, "generated")

    def test_report_records_are_not_reinterpreted_as_current_delivery(self) -> None:
        self.write("06_output/survey.pdf", "%PDF old")
        self.write(
            GENERATION,
            {
                "final_status": "SUCCESS",
                "compile": {
                    "status": "FAILED",
                    "output": str(self.workspace / "06_output/survey.pdf"),
                },
            },
        )
        self.write(POSTCHECK, self.report)
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "generated")
        self.assertEqual(card.checks[0].verdict, "PASS")
        self.assertEqual(card.cited, 1)

    def test_original_check_text_and_generation_reason_are_preserved(self) -> None:
        self.report["checks"][0].update(
            title="Producer title", reason="Producer reason", verdict="WARN"
        )
        self.write(POSTCHECK, self.report)
        self.write(
            GENERATION,
            {"final_status": "PARTIAL_SUCCESS", "status_reason": "A section remains incomplete"},
        )
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "partial")
        self.assertEqual(card.checks[0].title, "Producer title")
        self.assertEqual(card.checks[0].reason, "Producer reason")
        self.assertEqual(card.checks[0].verdict, "WARN")
        self.assertEqual(len(card.checks), 1)
        self.assertEqual(card.warnings, ["生成报告：A section remains incomplete"])

    def test_invalid_optional_file_is_not_ignored(self) -> None:
        self.write(POSTCHECK, "{writing")
        with self.assertRaises(ValueError):
            prepare_review(self.root, "survey", "result")

    def test_bridge_binds_hashes_and_rejects_late_turn(self) -> None:
        published = []
        cards = []
        switch_turn = False

        async def publish(path, role, **kwargs):
            published.append((path, kwargs))
            if switch_turn:
                live.publication_turn_id = "new-turn"
            return {
                "artifact_id": path,
                "path": path,
                "name": Path(path).name,
                "sha256": kwargs["expected_sha256"],
            }

        async def display(kind, content, **kwargs):
            cards.append((kind, content.data))
            return {"card_id": "review-card"}

        product_questions = []

        async def request_product_input(question, **kwargs):
            product_questions.append((question, kwargs))
            return {"answers": {question["id"]: "一键授权"}}

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            active_assistant_snapshot_id="snapshot-1",
            active_task_type="literature_review",
            last_submission_id="client-turn",
            interrupt_generation=0,
            active_assistant_revision=None,
            current_task=None,
            ledger=SimpleNamespace(active_turn_id="turn"),
            runtime_workdir=self.root,
            publish_artifact=publish,
            display_card=display,
            interactions=SimpleNamespace(request_product_input=request_product_input),
        )

        def lease(task_type: ProductTaskType, run_id: str) -> None:
            live.active_task_type = task_type.value
            live.active_task_lease = ProductTaskLease(
                task_type=task_type,
                turn_id="turn",
                generation=1,
                source="skill_run",
                workspace="survey",
                run_id=run_id,
            )

        sessions = SimpleNamespace(bridge_caller=lambda sid: live if sid == live.id else None)
        prepare_authorization = Mock(
            return_value=SimpleNamespace(
                authorization_type="literature_review_fulltext",
                scope_digest="scope-digest",
                question_id="literature-review-fulltext:opaque",
            )
        )
        app = FastAPI()
        register_literature_review_routes(
            app,
            sessions,
            FulltextGate(
                SimpleNamespace(
                    prepare=prepare_authorization,
                    turn_granted_refs=lambda **_scope: (),
                ),
                SimpleNamespace(),
            ),
        )
        headers = {BRIDGE_SESSION_HEADER: live.id, BRIDGE_TOKEN_HEADER: "private"}
        payload = {"workspace": "survey", "checkpoint": "outline"}
        with TestClient(app) as client:
            self.assertEqual(client.post(LITERATURE_REVIEW_ROUTE, json=payload).status_code, 403)
            response = client.post(LITERATURE_REVIEW_ROUTE, json=payload, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(published, [])
            self.assertEqual(cards[0][0], REVIEW_CARD)
            self.assertEqual(cards[0][1]["session_id"], "session")
            self.assertEqual(cards[0][1]["artifacts"], [])
            live.catalog = SimpleNamespace(hil=lambda request_id: SimpleNamespace(created_at=1000))
            self.write(
                REVIEW_PACKET,
                {
                    "packet_id": "packet",
                    "snapshot": {},
                    "outline_review": "timeout_auto",
                    "confirmation": {"state": "awaiting_display"},
                    "publication_display": {"format": "Markdown", "citation_style": "IEEE"},
                },
            )
            confirmed = client.post(LITERATURE_REVIEW_ROUTE, json=payload, headers=headers)
            self.assertEqual(confirmed.status_code, 200, confirmed.text)
            receipt = confirmed.json()["confirmation"]
            self.assertEqual(receipt["packet_id"], "packet")
            self.assertEqual(receipt["deadline_at"], 1300)
            self.assertEqual(receipt["decision"]["answers"][receipt["request_id"]], "一键授权")
            self.assertEqual(product_questions[-1][1]["timeout_seconds"], 300)
            product_questions.clear()
            cards.pop()
            self.write("06_output/survey.md", "# Finished review")
            self.write(GENERATION, {"final_status": "SUCCESS"})
            response = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "survey", "checkpoint": "result"},
                headers=headers,
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(cards[-1][1]["artifacts"], [])
            self.assertEqual(published, [])
            cards.pop()
            self.write(
                METADATA,
                {
                    "papers": [
                        {
                            "paper_id": "p1",
                            "title": "One",
                            "source": "paperhub",
                            "tier": 1,
                        },
                        {
                            "paper_id": "p2",
                            "title": "Two",
                            "source": "paperhub",
                            "tier": 1,
                        },
                    ]
                },
            )
            self.write(
                RETRIEVAL,
                {"input_count": 2, "output_count": 2, "dropped": [], "degradations": []},
            )
            retrieval_payload = self.retrieval_payload()
            missing_lease = client.post(
                LITERATURE_REVIEW_ROUTE,
                json=retrieval_payload,
                headers=headers,
            )
            self.assertEqual(missing_lease.status_code, 400, missing_lease.text)
            self.assertEqual(missing_lease.json()["error"], "review_publication_failed")
            self.assertEqual(missing_lease.json()["reason"], "task_context_missing")
            self.assertTrue(missing_lease.json()["recoverable"])
            recovery = missing_lease.json()["next_action"]
            self.assertEqual(recovery, missing_lease.json()["action"])
            self.assertIn("scholarseed_bridge model tool", recovery)
            self.assertIn("only after activation succeeds", recovery)
            self.assertIn("does not itself renew", recovery)
            self.assertNotIn("every stage command returns", recovery)
            self.assertIsNone(getattr(live, "active_task_lease", None))
            self.assertEqual(len(cards), 1)
            lease(ProductTaskType.LITERATURE_REVIEW, str(retrieval_payload["run_id"]))
            mismatch = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "02_retrieval", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(mismatch.status_code, 400, mismatch.text)
            self.assertEqual(mismatch.json()["reason"], "review_workspace_mismatch")
            self.assertIn(
                "exact session-workdir-relative workspace", mismatch.json()["next_action"]
            )
            self.assertIn("inputs and state are unchanged", mismatch.json()["next_action"])
            response = client.post(
                LITERATURE_REVIEW_ROUTE,
                json=retrieval_payload,
                headers=headers,
            )
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(cards[1][0], SEARCH_CARD)
            self.assertEqual(cards[1][1]["origin"], "literature-review")
            self.assertTrue(cards[1][1]["selection"]["artifact_id"])
            self.assertEqual(
                {path for path, _ in published},
                {f"survey/{name}" for name in (METADATA, CORPUS, RETRIEVAL)},
            )
            self.assertTrue(all(item[1]["expected_sha256"] for item in published))
            authorization = response.json()["authorization"]
            self.assertLess(response.text.index('"disposition"'), response.text.index('"sources"'))
            self.assertEqual(authorization["authorization_type"], "literature_review_fulltext")
            self.assertEqual(
                authorization["sources"],
                [{"id": "p1", "title": "One"}, {"id": "p2", "title": "Two"}],
            )
            self.assertEqual(authorization["disposition"], "authorized")
            self.assertNotIn("question", authorization)
            self.assertEqual(product_questions[0][0]["header"], "综述检索授权")
            self.assertEqual(product_questions[0][1]["turn_id"], "turn")
            prepare_authorization.assert_called_once()
            call = prepare_authorization.call_args.kwargs
            self.assertEqual(call["snapshot_id"], "snapshot-1")
            self.assertEqual(call["refs"][:2], ("paper:p1", "paper:p2"))
            self.assertTrue(call["refs"][2].startswith("artifact:"))
            # Skill releases without a launcher manifest reuse the same exact-scope grant.
            (self.workspace / ".slr-binding.json").write_text(
                json.dumps({"skill": "/skills/literature-review", "version": "1.1.0"}),
                encoding="utf-8",
            )
            derived_run = review_retrieval_run(self.root, "survey")
            lease(ProductTaskType.LITERATURE_REVIEW, derived_run)
            unbound = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "survey", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(unbound.status_code, 200, unbound.text)
            self.assertEqual(unbound.json()["authorization"]["disposition"], "authorized")
            self.assertTrue(cards[2][1]["run_id"].startswith("slr-"))
            redundant_run = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={
                    "workspace": "survey",
                    "checkpoint": "retrieval",
                    "run_id": f"{derived_run}4",
                },
                headers=headers,
            )
            self.assertEqual(redundant_run.status_code, 200, redundant_run.text)
            self.assertEqual(redundant_run.json()["authorization"]["disposition"], "authorized")
            self.assertEqual(cards[3][1]["run_id"], derived_run)
            cards.pop()
            cards.pop()
            lease(ProductTaskType.LITERATURE_REVIEW, f"{derived_run}4")
            wrong_lease = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={
                    "workspace": "survey",
                    "checkpoint": "retrieval",
                    "run_id": f"{derived_run}4",
                },
                headers=headers,
            )
            self.assertEqual(wrong_lease.status_code, 400, wrong_lease.text)
            self.assertEqual(wrong_lease.json()["reason"], "task_context_mismatch")
            lease(ProductTaskType.PRECISE_SEARCH, str(retrieval_payload["run_id"]))
            wrong_task = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "survey", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(wrong_task.status_code, 400, wrong_task.text)
            self.assertEqual(wrong_task.json()["reason"], "task_context_mismatch")
            self.assertEqual(prepare_authorization.call_count, 3)
            lease(ProductTaskType.LITERATURE_REVIEW, derived_run)
            switch_turn = True
            response = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": "survey", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(response.status_code, 403)
            self.assertEqual(len(cards), 2)

    def test_cli_registry_and_card_gate(self) -> None:
        args = parser().parse_args(
            ["literature", "review", "--json", '{"workspace":"survey","checkpoint":"outline"}']
        )
        self.assertEqual(args.operation, "review")
        self.assertEqual(BRIDGE_REQUESTS[("literature", "review")][1], LITERATURE_REVIEW_ROUTE)
        registry = CardRegistry()
        registry.register(REVIEW_CARD, validate_review_card, direct=False)
        self.assertFalse(registry.allows_direct(REVIEW_CARD))


if __name__ == "__main__":
    unittest.main()
