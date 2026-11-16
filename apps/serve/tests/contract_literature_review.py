"""Survey projection, scope and publication contract (not product acceptance)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.chat.active import DEVELOPER_PROMPT_FILE
from service.chat.persistence.catalog import HilStatus
from service.chat.service.cards import CardRegistry
from service.chat.service.handoffs import (
    ACTIVATION_RECEIPT,
    OUTLINE_RECEIPT,
    PLAN_RECEIPT,
    publish_receipt,
)
from service.chat.service.tasks import ProductTaskLease
from service.cli.bridge import parser
from service.literature.api.gate import FulltextGate
from service.literature.api.review import register_literature_review_routes
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.confirmation import (
    PLAN_CHECKPOINT,
    PLAN_NEXT_ACTION,
    REVIEW_CONFIRM_LABEL,
    REVIEW_HEADER,
    REVIEW_PACKET,
    await_confirmation,
    confirmation_continuation,
    prepare_confirmation,
    require_search_plan,
)
from service.literature.service.result import SEARCH_CARD, validate_search_card
from service.literature.service.review import (
    CHECK_LABELS,
    CORPUS,
    FULLTEXT,
    GENERATION,
    METADATA,
    OUTLINE,
    OUTPUT_SPEC,
    POSTCHECK,
    QUALITY,
    QUERY,
    REQUIREMENTS,
    RETRIEVAL,
    REVIEW_CARD,
    REVIEW_ISSUES,
    SUMMARY,
    WRITING_REQUEST,
    ReviewMetadataError,
    _fulltext_limitation_reason,
    prepare_review,
    prepare_review_search,
    project_review_search_artifacts,
    review_retrieval_run,
    review_workspace_run,
    validate_review_card,
    validate_review_checkpoint,
)
from service.literature.service.selected import SelectedSources
from service.platform.activity import Activities, ActivityDomain
from service.platform.bridge import (
    BRIDGE_REQUESTS,
    LITERATURE_REVIEW_ROUTE,
)
from service.platform.context import ProductTaskType
from service.platform.vocabulary import (
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

LITERATURE_PUBLICATION_SCRIPT = (
    Path(__file__).resolve().parents[3]
    / "skills/community/literature-review/scripts/manuscript_publication.py"
)
LITERATURE_SKILL_FILE = (
    Path(__file__).resolve().parents[3] / "skills/community/literature-review/SKILL.md"
)


def review_checks(card):
    return list({row.check.id: row.check for row in card.verification.rows if row.check}.values())


def review_issues(card):
    return [row.issue for row in card.verification.rows if row.issue]


class LiteratureReviewContract(unittest.TestCase):
    def test_review_v12_reads_pdf_citations_without_using_the_entire_bibliography(self) -> None:
        self.write(OUTPUT_SPEC, {"format": "latex_pdf", "citation_style": "numeric"})
        self.write("03_process/cite_keys.json", {"p1": "Cited", "p2": "Unused"})
        self.write(
            "05_generation/citations.bib",
            ("@article{Unused,title={Not cited}}\n@article{Cited,title={Actually cited}}"),
        )
        self.write(
            "05_generation/full_draft_v2.aux", "\\relax\n\\citation{Cited}\n\\citation{Cited}\n"
        )
        references = prepare_review(self.root, "survey", "result").card.references
        self.assertEqual(references.cited_count, 1)
        self.assertEqual([row.citation_key for row in references.rows], ["Cited"])

    def test_review_v12_keeps_unmatched_references_and_does_not_guess_unsafe_sources(self) -> None:
        self.write("03_process/cite_keys.json", {"p1": "Duplicate", "p2": "Duplicate"})
        self.write(
            "05_generation/citations.bib", "@misc{Duplicate,title={One},url={javascript:alert(1)}}"
        )
        self.write(
            "06_output/survey.md",
            ('Claim [Author, 2024](#ref-Duplicate).\n\n<a id="ref-Duplicate"></a> One'),
        )
        references = prepare_review(self.root, "survey", "result").card.references
        self.assertEqual(references.cited_count, 1)
        self.assertIsNone(references.abstract_cited_count)
        self.assertEqual(references.rows[0].citation.title, "One")
        self.assertIsNone(references.rows[0].paper_id)
        self.assertIsNone(references.rows[0].target)
        self.assertIsNone(references.rows[0].evidence)

    def test_review_v12_preserves_linked_and_independent_issue_priorities(self) -> None:
        self.report["checks"][0].update(verdict="WARN", reason="Review missing reference fields")
        self.write(POSTCHECK, self.report)
        self.write(RETRIEVAL, {"flagged_for_review": [{"paper_id": "p1"}]})
        self.write(
            "07_verifier/fast_audit/output/aggregated_issues.json",
            {
                "issues": [{"title": "Source mismatch", "severity": "critical"}],
            },
        )
        verification = prepare_review(self.root, "survey", "result").card.verification
        self.assertEqual(verification.issue_count, 3)
        linked, flagged, audit = verification.rows
        self.assertEqual(linked.check.id, "cite_sync")
        self.assertEqual(linked.issue.priority, "attention")
        self.assertIsNone(flagged.check)
        self.assertIsNone(flagged.issue.priority)
        self.assertIsNone(audit.check)
        self.assertEqual(audit.issue.priority, "urgent")

    def test_review_v12_joins_confirmed_citations_by_key_and_projects_navigation(self) -> None:
        self.write(
            "02_retrieval/selected_paper.json",
            {
                "p1": {
                    "title": "Same title",
                    "abstract": "Abstract",
                    "landing_page_url": "https://example.org/paper",
                },
                "p2": {
                    "title": "Same title",
                    "abstract": "Abstract",
                    "library_refs": ["literature:stored"],
                },
                "unused": {"title": "Not cited", "abstract": "Abstract"},
            },
        )
        self.write("03_process/cite_keys.json", {"p1": "Web", "p2": "Local", "unused": "Unused"})
        self.write(FULLTEXT, {"with_full_text": 0, "papers": []})
        self.write(
            "05_generation/citations.bib",
            (
                "@article{Web,title={Same title}}\n@article{Local,title={Same title}}\n"
                "@article{Unused,title={Not cited}}\n"
            ),
        )
        self.write(
            "06_output/survey.md",
            (
                "Claim [[1]](#ref-Local) and [[2]](#ref-Web).\n"
                '<a id="ref-Local"></a> [1] Same title\n'
                '<a id="ref-Web"></a> [2] Same title'
            ),
        )
        snapshot = prepare_review(self.root, "survey", "result").card.model_dump()
        self.assertEqual(snapshot["schema_version"], "1.2")
        references = snapshot["references"]
        self.assertEqual(references["cited_count"], 2)
        self.assertEqual(references["abstract_cited_count"], 2)
        self.assertEqual([row["paper_id"] for row in references["rows"]], ["p2", "p1"])
        self.assertEqual(
            [row["target"] for row in references["rows"]],
            [
                {"kind": "library", "item_id": "stored"},
                {"kind": "web", "url": "https://example.org/paper"},
            ],
        )

    def test_result_citations_follow_published_reference_order(self) -> None:
        self.write(
            "05_generation/citations.bib",
            "@article{second,title={Second}}\n@article{first,title={First}}\n",
        )
        self.write(
            "06_output/survey.md",
            "Claim [[1]](#ref-first) and [[2]](#ref-second).\n\n"
            '<a id="ref-first"></a>\n[1] First\n\n'
            '<a id="ref-second"></a>\n[2] Second\n',
        )
        prepared = prepare_review(self.root, "survey", "result")
        self.assertEqual(
            [row.citation.title for row in prepared.card.references.rows], ["First", "Second"]
        )

    def test_task_receipt_reuses_original_bytes_and_rejects_overwrite(self) -> None:
        response = {"ok": True, "confirmation": {"decision": {"answers": {"request": "修改语言"}}}}
        reference = publish_receipt(self.root, "survey", "run", OUTLINE_RECEIPT, response)
        path = self.root / reference
        original = path.read_bytes()
        self.assertEqual(path.stem, hashlib.sha256(original).hexdigest())
        self.assertEqual(json.loads(original)["response"], response)
        self.assertEqual(
            publish_receipt(self.root, "survey", "run", OUTLINE_RECEIPT, response), reference
        )
        self.assertEqual(path.read_bytes(), original)
        path.write_bytes(b"corrupted receipt")
        with self.assertRaises(ValueError):
            publish_receipt(self.root, "survey", "run", OUTLINE_RECEIPT, response)
        self.assertEqual(path.read_bytes(), b"corrupted receipt")

    def test_review_component_declares_native_detail_navigation(self) -> None:
        source = Path(__file__).resolve().parents[3] / "skills/community/literature-review"
        descriptor = json.loads((source / ".scholarseed-plugin.json").read_text())
        review = next(
            item for item in descriptor["components"] if item["slot"] == "display.literature-review"
        )
        self.assertEqual(
            {item["id"]: item["capability"] for item in review["actions"]},
            {
                "open-artifact": "navigation.open",
                "open-results": "navigation.open",
                "open-source": "navigation.open",
            },
        )

    def test_outline_continuation_runs_real_skill_cli_and_rejects_stale_packet(self) -> None:
        script = """
import json
import subprocess
import sys
from pathlib import Path
from test_native_pipeline import NativeTest
from operator_cli import review_packet
from task_contract import configure
from writing_contract import digest, require_approval
from service.literature.service.confirmation import REVIEW_CONFIRM_LABEL, confirmation_continuation
from service.chat.service.handoffs import publish_receipt, OUTLINE_RECEIPT

fixture = NativeTest()
fixture.setUp()
try:
    workspace = fixture.ws.resolve()
    script_path = Path('slr.py').resolve()
    (workspace / '.slr-binding.json').write_text(json.dumps({'run_id': 'receipt-run'}))
    configure(workspace, {'outline_review': 'required', 'publication': {'format': 'markdown', 'citation_style': 'numeric'}})
    packet = review_packet(workspace)
    receipt = {'packet_id': packet['packet_id'], 'snapshot_id': digest(packet['snapshot']),
               'request_id': 'actual-card-request', 'started_at': 1000, 'deadline_at': None,
               'decision': {'answers': {'actual-card-request': REVIEW_CONFIRM_LABEL}}}
    reference = publish_receipt(workspace.parent, workspace.name, 'receipt-run', OUTLINE_RECEIPT,
                                {'ok': True, 'confirmation': receipt})
    steps = confirmation_continuation(receipt, reference)['steps']
    for step in steps + steps:
        assert 'input' not in step
        result = subprocess.run([sys.executable, str(script_path), *step['arguments'], '--workspace', str(workspace)],
                                cwd=workspace.parent, capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stdout + result.stderr
    require_approval(workspace)
    approval = json.loads((workspace / '04_outline/approval.json').read_text())
    assert approval['message_id'] == receipt['request_id']
    assert approval['user_response'] == REVIEW_CONFIRM_LABEL
    outline_path = workspace / '04_outline/outline.json'
    outline = json.loads(outline_path.read_text())
    outline['survey_title'] = 'Revised outline requires confirmation'
    outline_path.write_text(json.dumps(outline))
    for step in steps:
        stale = subprocess.run([sys.executable, str(script_path), *step['arguments'], '--workspace', str(workspace)],
                               cwd=workspace.parent, capture_output=True, text=True, timeout=30)
        assert stale.returncode != 0, 'stale receipt must not authorize changed writing scope'
finally:
    fixture.doCleanups()
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=LITERATURE_SKILL_FILE.parent / "scripts",
            env={
                **os.environ,
                "PYTHONPATH": os.pathsep.join(
                    filter(
                        None,
                        (
                            str(LITERATURE_SKILL_FILE.parent / "scripts"),
                            os.environ.get("PYTHONPATH", ""),
                        ),
                    )
                ),
            },
            text=True,
            capture_output=True,
            timeout=90,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_outline_confirmation_provides_executable_continuation(self) -> None:
        receipt = {
            "packet_id": "current-packet",
            "snapshot_id": "current-snapshot",
            "request_id": "outline-request",
            "started_at": 1000,
            "deadline_at": None,
            "decision": {"answers": {"outline-request": REVIEW_CONFIRM_LABEL}},
        }
        result = confirmation_continuation(receipt)
        self.assertEqual(result["state"], "confirmed")
        self.assertEqual(result["steps"][0]["input"], receipt)
        self.assertEqual(
            result["steps"][0]["arguments"], ["writing", "review-complete", "--request", "-"]
        )
        self.assertEqual(result["steps"][1]["arguments"], ["writing", "approve", "--request", "-"])
        self.assertEqual(
            result["steps"][1]["input"],
            {
                "packet_id": "current-packet",
                "message_id": "outline-request",
                "user_response": REVIEW_CONFIRM_LABEL,
            },
        )
        for decision in (
            {"answers": {"outline-request": "Start writing with the current plan"}},
            {"answers": {"outline-request": "修改第二章"}},
            {"answers": {"outline-request": ""}},
            {"cancelled": True, "answers": {"outline-request": REVIEW_CONFIRM_LABEL}},
            {"timed_out": True},
        ):
            with self.subTest(decision=decision):
                pending = confirmation_continuation({**receipt, "decision": decision})
                self.assertNotEqual(pending["state"], "confirmed")
                self.assertEqual(len(pending["steps"]), 1)

    def test_retrieval_id_contract_and_field_diagnostics(self) -> None:
        self.write(METADATA, {"papers": [{"paper_id": 123, "title": "Numeric source ID"}]})
        self.write(CORPUS, {"123": {"paperId": "123", "title": "Numeric source ID"}})
        self.write(RETRIEVAL, {"dropped": []})
        before = (self.root / "survey" / METADATA).read_bytes()
        card = prepare_review_search(self.root, "survey", "run").card
        self.assertEqual(card.papers[0].id, "123")
        self.assertEqual((self.root / "survey" / METADATA).read_bytes(), before)
        for value in [True, 1.5, [], {}, "", "x" * 257]:
            self.write(METADATA, {"papers": [{"paper_id": value, "title": "Paper"}]})
            with self.subTest(value=value), self.assertRaises(ValueError) as caught:
                prepare_review_search(self.root, "survey", "run")
            self.assertEqual(str(caught.exception), "review_metadata_invalid")
            issue = caught.exception.issues[0]
            self.assertEqual(issue["artifact"], METADATA)
            self.assertEqual(issue["field"], "papers[0].paper_id")
            self.assertIn("expected", issue)
            self.assertIn("actual_type", issue)
        self.write(
            METADATA,
            {"papers": [{"paper_id": "p", "title": "One"}, {"paper_id": "p", "title": "Two"}]},
        )
        with self.assertRaises(ValueError) as caught:
            prepare_review_search(self.root, "survey", "run")
        self.assertEqual(caught.exception.issues[0]["code"], "DUPLICATE_PAPER_ID")

    def test_plan_response_guidance_consumes_the_complete_response_once(self) -> None:
        self.assertIn("receipt_ref", PLAN_NEXT_ACTION)
        self.assertIn("writing plan-resolve --receipt", PLAN_NEXT_ACTION)
        self.assertIn("--action", PLAN_NEXT_ACTION)
        self.assertIn("timeout or cancellation", PLAN_NEXT_ACTION)
        self.assertNotIn("plan-complete", PLAN_NEXT_ACTION)

    def test_plan_processing_time_is_an_estimate_in_minutes(self) -> None:
        for language, label, expected in (
            ("CHINESE", "预计处理时间", "1.5 分钟（预估，不含等待；超出仍继续）"),
            (
                "ENGLISH",
                "Estimated processing time",
                "1.5 minutes (estimate, excluding user waits; work continues if exceeded)",
            ),
        ):
            with self.subTest(language=language):
                task = {
                    "intent": "Write related work",
                    "language": language,
                    "execution": {"mode": "quick", "budget_seconds": 90},
                }
                self.write(WRITING_REQUEST, task)
                self.write(
                    "01_input/plan_packet.json",
                    {
                        "packet_id": "processing-time",
                        "snapshot": {
                            "request": task,
                            "publication": {"format": "markdown", "citation_style": "numeric"},
                        },
                    },
                )
                projected = prepare_confirmation(self.root, "survey", "session", "turn", "plan")
                fields = {
                    field["label"]: field["value"]
                    for field in projected.question["presentation"]["fields"]
                }
                self.assertEqual(fields[label], expected)
                self.assertNotIn("自动处理预算", fields)
                self.assertNotIn("Processing budget", fields)
                self.assertEqual(task["execution"]["budget_seconds"], 90)

    def test_markdown_front_plan_has_no_latex_template(self) -> None:
        task = {
            "intent": "Write a paragraph",
            "language": "CHINESE",
            "deliverable": {"kind": "survey", "unit": "document"},
            "execution": {"mode": "quick", "budget_seconds": 600},
            "retrieval": {"time_range": {"start_year": 2023, "end_year": 2026}},
        }
        self.write(WRITING_REQUEST, task)
        self.write(
            "01_input/plan_packet.json",
            {
                "packet_id": "markdown-plan",
                "snapshot": {
                    "request": task,
                    "publication": {
                        "format": "markdown",
                        "template": None,
                        "citation_style": "numeric",
                    },
                },
            },
        )
        projected = prepare_confirmation(self.root, "survey", "session", "turn", "plan")
        self.assertIn("模板：不适用（Markdown）", projected.question["question"])
        self.assertNotIn("None", projected.question["question"])
        presentation = projected.question["presentation"]
        self.assertEqual(presentation["kind"], "question-fields")
        self.assertEqual(presentation["summary"], task["intent"])
        fields = {field["label"]: field["value"] for field in presentation["fields"]}
        self.assertEqual(fields["生成内容"], "文献综述 / 完整文档")
        self.assertEqual(fields["语言"], "中文")
        self.assertEqual(fields["交付格式"], "Markdown")
        self.assertEqual(fields["发表区间"], "2023–2026")
        self.assertIn("五分钟", presentation["notice"])

    def test_supplied_only_plan_uses_prepared_count_without_default_year_filter(self) -> None:
        task = {
            "intent": "仅比较所选三篇论文",
            "language": "CHINESE",
            "execution": {"mode": "quick", "budget_seconds": 600},
            "sources": {
                "policy": "provided_only",
                "refs": ["literature:a", "literature:b", "literature:c"],
            },
            "retrieval": {
                "corpus_size": {"target": 20},
                "temporal_policy": {
                    "default_if_unspecified": {"start_year": 2022, "end_year": 2026}
                },
            },
        }
        self.write(WRITING_REQUEST, task)
        self.write(
            "01_input/plan_packet.json",
            {
                "packet_id": "supplied-plan",
                "snapshot": {
                    "request": task,
                    "publication": {"format": "markdown", "citation_style": "numeric"},
                },
                "source_summary": {"local_count": 3, "pending_count": 0, "combined_target": 3},
            },
        )
        projected = prepare_confirmation(self.root, "survey", "session", "turn", "plan")
        question = projected.question["question"]
        self.assertIn("3 篇已就绪，0 篇待补；不补检", question)
        self.assertIn("不按默认年份筛选", question)
        self.assertNotIn("2022–2026", question)
        self.assertNotIn("论文数量目标：20", question)

    def test_plan_asset_counts_are_explicit_or_deferred(self) -> None:
        task = {
            "intent": "Write a report with two figures and one table.",
            "language": "CHINESE",
            "execution": {"mode": "standard", "budget_seconds": 2400},
            "constraints": [
                {"kind": "figure_count", "value": {"min": 2, "max": 2}},
                {"kind": "table_count", "value": {"min": 1, "max": 1}},
            ],
        }

        def question():
            self.write(WRITING_REQUEST, task)
            self.write(
                "01_input/plan_packet.json",
                {
                    "packet_id": "asset-plan",
                    "snapshot": {
                        "request": task,
                        "publication": {
                            "format": "latex_pdf",
                            "template": "standard_chinese",
                            "citation_style": "numeric",
                        },
                    },
                    "publication_display": {"template": "标准中文模板"},
                },
            )
            projected = prepare_confirmation(
                self.root, "survey", "session", "turn", "plan"
            ).question
            for field in projected["presentation"]["fields"]:
                self.assertIn(f"{field['label']}：{field['value']}", projected["question"])
            field_labels = {field["label"] for field in projected["presentation"]["fields"]}
            self.assertTrue({"图片", "表格"}.issubset(field_labels))
            return projected["question"]

        explicit = question()
        self.assertIn("图片：2", explicit)
        self.assertIn("表格：1", explicit)
        self.assertIn("模板：标准中文模板", explicit)
        task["constraints"] = []
        automatic = question()
        self.assertIn("图片：材料分析后按需安排，可为0", automatic)
        self.assertIn("表格：材料分析后按需安排，可为0", automatic)

    def test_front_plan_resolves_launcher_without_persisted_run_id(self) -> None:
        self.write(
            ".slr-binding.json", {"schema_version": 2, "workspace": str(self.root / "survey")}
        )
        expected = "slr-" + hashlib.sha256(b"survey").hexdigest()[:16]
        self.assertEqual(review_workspace_run(self.root, "survey"), expected)
        self.write(".slr-binding.json", {"schema_version": 2, "run_id": "explicit-bound-run"})
        self.assertEqual(review_workspace_run(self.root, "survey"), "explicit-bound-run")

    def test_search_requires_current_plan_and_actual_product_decision(self) -> None:
        task = {
            "intent": "Review evidence",
            "execution": {"mode": "quick"},
            "sources": {"policy": "discover"},
        }
        self.write(WRITING_REQUEST, task)
        actual = {"answers": {"question": "Proceed"}}
        record = SimpleNamespace(session_id="session", status=HilStatus.RESOLVED, decision=actual)
        live = SimpleNamespace(
            id="session",
            active_task_type="literature_review",
            active_task_lease=SimpleNamespace(workspace="survey"),
            runtime_workdir=self.root,
            catalog=SimpleNamespace(hil=lambda request_id: record),
        )
        with self.assertRaises(ValueError):
            require_search_plan(live)
        self.write(
            "_status/plan_decision.json",
            {
                "state": "approved",
                "approved_snapshot": {"request": task},
                "receipt": {"request_id": "question", "decision": actual},
            },
        )
        require_search_plan(live)
        record.session_id = "another-session"
        with self.assertRaises(ValueError):
            require_search_plan(live)
        record.session_id = "session"
        task["sources"]["policy"] = "provided_only"
        self.write(WRITING_REQUEST, task)
        with self.assertRaisesRegex(ValueError, "supplied papers only"):
            require_search_plan(live)

    def test_plan_accepts_legacy_string_temporal_policy(self) -> None:
        task = {
            "intent": "Write a short review",
            "language": "ENGLISH",
            "execution": {"mode": "quick", "budget_seconds": 600},
            "retrieval": {"temporal_policy": "soft_preference"},
        }
        self.write(WRITING_REQUEST, task)
        self.write(
            "01_input/plan_packet.json",
            {
                "packet_id": "legacy-time-policy",
                "snapshot": {
                    "request": task,
                    "publication": {
                        "format": "docx",
                        "template": "word",
                        "citation_style": "numeric",
                    },
                },
            },
        )
        projected = prepare_confirmation(self.root, "survey", "session", "turn", "plan")
        self.assertEqual(projected.timeout_seconds, 300)
        self.assertIn("Not specified", projected.question["question"])

    def test_plan_confirmation_precedes_outline_and_detects_task_drift(self) -> None:
        task = {
            "intent": "Write one related-work section",
            "language": "ENGLISH",
            "execution": {"mode": "quick", "budget_seconds": 600, "confirmation": "timeout_auto"},
        }
        self.write(WRITING_REQUEST, task)
        packet = {
            "packet_id": "plan",
            "snapshot": {
                "request": task,
                "publication": {
                    "format": "docx",
                    "template": "neurips",
                    "citation_style": "numeric",
                },
            },
        }
        self.write("01_input/plan_packet.json", packet)
        projected = prepare_confirmation(self.root, "survey", "session", "turn", "plan")
        self.assertEqual(projected.timeout_seconds, 300)
        self.assertIn("Paper authorization remains separate", projected.question["question"])
        self.assertIn("Word DOCX", projected.question["question"])
        task["execution"]["confirmation"] = "required"
        self.write(WRITING_REQUEST, task)
        with self.assertRaises(ValueError):
            prepare_confirmation(self.root, "survey", "session", "turn", "plan")
        self.write("01_input/plan_packet.json", packet)
        self.assertIsNone(
            prepare_confirmation(self.root, "survey", "session", "turn", "plan").timeout_seconds
        )

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
        self.assertEqual(
            timed.question["presentation"],
            {
                "kind": "literature-outline-confirmation",
                "format": "Markdown",
                "citation_style": "IEEE",
                "timeout_seconds": 300,
            },
        )
        self.assertEqual(timed, prepare_confirmation(self.root, "survey", "session", "turn"))
        packet["outline_review"] = "required"
        packet["confirmation"]["state"] = "required"
        self.write(REVIEW_PACKET, packet)
        required = prepare_confirmation(self.root, "survey", "session", "turn")
        self.assertIsNone(required.timeout_seconds)
        self.assertIsNone(required.question["presentation"]["timeout_seconds"])
        self.assertNotIn("5 分钟", required.question["question"])
        for state in ("auto", "approved", "timeout_applied"):
            packet["confirmation"]["state"] = state
            self.write(REVIEW_PACKET, packet)
            self.assertIsNone(prepare_confirmation(self.root, "survey", "session", "turn").question)

    def test_outline_presentation_does_not_duplicate_unbounded_publication_text(self) -> None:
        packet = {
            "packet_id": "bounded-presentation",
            "snapshot": {},
            "outline_review": "required",
            "confirmation": {"state": "required"},
            "publication_display": {"format": "PDF" * 1000, "citation_style": "IEEE"},
        }
        self.write(REVIEW_PACKET, packet)
        confirmation = prepare_confirmation(self.root, "survey", "session", "turn")
        self.assertNotIn("presentation", confirmation.question)
        self.assertIn(packet["publication_display"]["format"], confirmation.question["question"])
        self.assertEqual(confirmation.question["options"][0]["label"], REVIEW_CONFIRM_LABEL)

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

    def test_abstract_evidence_preserves_outcome_for_localized_presentation(self) -> None:
        self.write_cited_fixture({"p1": "One"})
        for outcome in ("not_in_paperhub", "auth_failed", "extract_failed", "unknown"):
            with self.subTest(outcome=outcome):
                self.write(
                    FULLTEXT,
                    {
                        "with_full_text": 1,
                        "papers": [
                            {
                                "paper_id": "p1",
                                "outcome": outcome,
                                "detail": "private download diagnostic",
                            }
                        ],
                    },
                )
                card = prepare_review(self.root, "survey", "result").card
                projected = validate_review_card(card.model_dump(mode="json"))
                row = projected["references"]["rows"][0]
                self.assertEqual(row["paper_id"], "p1")
                self.assertEqual(row["evidence"]["reason_code"], outcome)
                self.assertNotIn("private", row["evidence"]["reason"])

    def test_literature_review_skill_owns_intake_and_output_decision_order(self) -> None:
        text = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split()).casefold()
        self.assertIn("writing configure --request", text)
        self.assertIn("writing plan-packet", text)
        self.assertIn("writing plan-resolve", text)
        self.assertIn("continue only when", text)
        self.assertIn("can_continue", text)

    def test_review_checkpoint_does_not_replace_explicit_artifact_publication(self) -> None:
        text = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split()).casefold()
        self.assertIn("publish each independent final deliverable", text)
        self.assertIn("capability=artifact", text)
        self.assertIn("operation=publish", text)
        self.assertIn("checkpoint:result", text)

    def test_draft_plan_discloses_processing_time_before_workflow(self) -> None:
        introduction = LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split("## 1.", 1)[0]
        self.assertRegex(introduction, r"(?s)processing.time.*(?:estimate|range).*draft")
        self.assertIn("excluding user waits", introduction)

    def test_review_skill_owns_recovery_and_evidence_limits(self) -> None:
        text = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split()).casefold()
        self.assertIn("standard prioritizes existing framework cards", text)
        self.assertIn("workflow evidence --from fulltext", text)
        self.assertIn("scripts determine whether", text)
        self.assertIn("material limitations", text)
        self.assertNotIn("two bounded evidence rounds", text)

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
        self.assertEqual(card.scope.topic, "对比研究方法及限制（2021—2026）")
        self.assertEqual(card.scope.time_range, "2022–2026；允许早期基础文献")
        self.assertEqual(card.scope.requested_materials, ["指定论文"])
        self.assertEqual(card.output.format, "markdown")
        self.assertEqual(card.output.citation_style, "author_year")

    def test_review_scope_only_displays_a_structured_topic(self) -> None:
        self.write(REQUIREMENTS, {})
        self.write(
            WRITING_REQUEST,
            {
                "intent": "请写一篇综述",
                "effective_requirements": "使用快速模式并只使用两篇摘要，保留记录标识",
            },
        )
        self.assertIsNone(prepare_review(self.root, "survey", "result").card.scope.topic)
        self.write(OUTLINE, {**self.outline, "topic": "长上下文评测"})
        self.assertEqual(
            prepare_review(self.root, "survey", "result").card.scope.topic, "长上下文评测"
        )

    def test_scope_counts_selected_library_identity_in_both_request_formats(self) -> None:
        self.write(
            CORPUS,
            {
                "p1": {
                    "title": "Selected abstract",
                    "source": "selected_abstract",
                    "library_refs": ["literature:chosen"],
                },
                "p2": {"title": "Discovered abstract", "library_refs": ["artifact:search"]},
            },
        )
        for modern in (False, True):
            with self.subTest(modern=modern):
                if modern:
                    self.write(WRITING_REQUEST, {"intent": "Compare the sources"})
                card = prepare_review(self.root, "survey", "outline").card
                self.assertEqual(card.scope.project_materials, 1)
                self.assertEqual(card.scope.external_materials, 1)

    def test_retrieval_waits_on_the_blocking_checkpoint_in_the_same_turn(self) -> None:
        text = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split()).casefold()
        self.assertIn("run `run retrieval_adapt` separately", text)
        self.assertIn("checkpoint:retrieval", text)
        self.assertIn("authorization.disposition=authorized", text)
        self.assertIn("denied, cancelled, missing or failed", text)
        self.assertIn("keep the turn active", text)

    def test_skill_cannot_cross_the_retrieval_authorization_boundary(self) -> None:
        text = " ".join(LITERATURE_SKILL_FILE.read_text(encoding="utf-8").split()).casefold()
        self.assertIn("plan approval", text)
        self.assertIn("is not full-text authorization", text)
        self.assertIn("granted_refs", text)
        self.assertIn("authorization.disposition=authorized", text)
        self.assertIn("standard: `workflow evidence --from fulltext`", text)

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

    def write_cited_fixture(self, papers: dict[str, str]) -> None:
        self.write("03_process/cite_keys.json", {paper_id: paper_id for paper_id in papers})
        links = ", ".join(
            f"[[{number}]](#ref-{paper_id})" for number, paper_id in enumerate(papers, 1)
        )
        refs = "\n".join(
            f'<a id="ref-{paper_id}"></a> [{number}] {title}'
            for number, (paper_id, title) in enumerate(papers.items(), 1)
        )
        self.write("06_output/survey.md", f"{links}\n\n{refs}")

    def write(self, name: str, value: dict | str) -> None:
        path = self.workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) if isinstance(value, dict) else value, encoding="utf-8")

    def test_compiled_local_only_cli_artifacts_feed_retrieval_projection(self) -> None:
        compiled = (
            Path(__file__).resolve().parents[1] / "service/capabilities/skills/literature-review"
        )
        launcher = compiled / "scripts/slr.py"
        self.assertTrue(
            launcher.is_file(),
            "Build the current frozen product skill before this integration check",
        )
        workdir = self.root.resolve()
        workspace = workdir / "local-survey"
        environment = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [str(compiled / "lib"), str(compiled / "scripts"), os.environ.get("PYTHONPATH", "")]
            ),
        }

        def invoke(arguments, value=None):
            completed = subprocess.run(
                [sys.executable, "-m", "service.cli.skill_python", str(launcher), *arguments],
                input=json.dumps(value) if value is not None else None,
                capture_output=True,
                text=True,
                check=False,
                env=environment,
                cwd=workdir,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

        invoke(["init", "--workspace", str(workspace)])
        invoke(
            ["writing", "configure", "--workspace", str(workspace), "--request", "-"],
            {
                "intent": "Review the supplied source",
                "output_scope": "section",
                "execution": {"mode": "quick"},
                "sources": {"policy": "provided_only", "refs": ["literature:one"]},
                "publication": {"format": "markdown"},
            },
        )
        run_id = review_workspace_run(workdir, workspace.name)
        repository = LiteratureRepository(workdir / "library.sqlite3")
        repository.save(
            LiteratureItem(
                id="one",
                title="Actual selected paper",
                authors="Actual Author",
                year=2024,
                venue="Actual venue",
                abstract="The method supports a bounded result under its stated assumptions.",
            ),
            project_id="actual",
        )
        activities = Activities()
        selected = SelectedSources(repository, activities)
        with (
            activities.enter(ActivityDomain.TURN),
            patch(
                "service.literature.service.enrichment.search_by_title",
                side_effect=AssertionError("external lookup"),
            ),
            patch(
                "service.literature.service.enrichment.fetch_bibliography",
                side_effect=AssertionError("external lookup"),
            ),
        ):
            sources = asyncio.run(
                selected.prepare("actual", workdir, workspace.name, run_id, 1, lambda: None)
            )
        self.assertEqual(sources["selected_sources"]["ready_count"], 1)
        activation = publish_receipt(
            workdir,
            workspace.name,
            run_id,
            ACTIVATION_RECEIPT,
            {"ok": True, "workspace": workspace.name, "run_id": run_id, **sources},
        )
        invoke(["writing", "plan-packet", "--workspace", str(workspace), "--receipt", activation])
        session_id, turn_id = "session", "turn"
        prepared_plan = prepare_confirmation(
            workdir, workspace.name, session_id, turn_id, PLAN_CHECKPOINT
        )
        assert prepared_plan.question is not None
        decision = {
            "answers": {prepared_plan.question["id"]: prepared_plan.question["options"][0]["label"]}
        }
        live = SimpleNamespace(
            id=session_id,
            publication_turn_id=turn_id,
            runtime_workdir=workdir,
            catalog=SimpleNamespace(hil=lambda _request_id: SimpleNamespace(created_at=1000)),
            interactions=SimpleNamespace(request_product_input=AsyncMock(return_value=decision)),
        )
        with activities.enter(ActivityDomain.TURN):
            confirmation = asyncio.run(
                await_confirmation(
                    live, activities, prepared_plan, workspace.name, turn_id, PLAN_CHECKPOINT
                )
            )
        plan = publish_receipt(
            workdir,
            workspace.name,
            run_id,
            PLAN_RECEIPT,
            {"ok": True, "confirmation": confirmation, "next_action": PLAN_NEXT_ACTION},
        )
        invoke(
            [
                "writing",
                "plan-resolve",
                "--workspace",
                str(workspace),
                "--receipt",
                plan,
                "--action",
                "proceed",
            ],
        )
        invoke(["run", "retrieval_adapt", "--workspace", str(workspace)])
        metadata = workspace / "02_retrieval/metadata.json"
        self.assertEqual(
            json.loads(metadata.read_text()),
            {"papers": [], "search_summary": {"source_mode": "local_only"}},
        )
        prepared = prepare_review_search(workdir, workspace.name, run_id)
        self.assertEqual(prepared.card.retained, 1)
        self.assertEqual(len(prepared.authorization_sources), 1)
        original = {"papers": [], "search_summary": {"source_mode": "actual_existing_search"}}
        metadata.write_text(json.dumps(original), encoding="utf-8")
        before = metadata.read_bytes()
        invoke(["run", "retrieval_adapt", "--workspace", str(workspace)])
        self.assertEqual(metadata.read_bytes(), before)

    def test_mixed_corpus_authorizes_supplied_and_discovered_papers(self) -> None:
        discovered = {"paper_id": "remote", "title": "Discovered paper"}
        supplied = {
            "paperId": "local",
            "title": "Supplied paper",
            "user_supplied": True,
            "authors": [{"name": "Actual Author"}],
            "year": 2024,
            "abstract": "Actual stored abstract.",
            "source": "selected_abstract",
            "library_refs": ["literature:actual-library-record"],
        }
        self.write(QUERY, {"query": "Review both supplied and discovered sources"})
        self.write(METADATA, {"papers": [discovered]})
        self.write(CORPUS, {"remote": discovered, "local": supplied})
        self.write(RETRIEVAL, {})
        prepared = prepare_review_search(self.root, "survey", "mixed-run")
        self.assertIn("literature:actual-library-record", prepared.authorization_refs)
        self.assertIn("paper:local", prepared.authorization_refs)
        self.assertIn("paper:remote", prepared.authorization_refs)
        self.assertTrue(any(ref.startswith("artifact:") for ref in prepared.authorization_refs))
        self.assertEqual(
            {source.id for source in prepared.authorization_sources}, {"remote", "local"}
        )
        self.assertEqual(prepared.card.retained, 2)
        artifacts = {
            name: (self.workspace / name).read_bytes() for name in (METADATA, CORPUS, RETRIEVAL)
        }
        self.assertEqual(
            {paper.id for paper in project_review_search_artifacts(artifacts)}, {"remote", "local"}
        )
        for invalid in ({**supplied, "user_supplied": False}, {**supplied, "paperId": "other"}):
            self.write(CORPUS, {"remote": discovered, "local": invalid})
            with self.assertRaisesRegex(ValueError, "review_corpus_invalid"):
                prepare_review_search(self.root, "survey", "mixed-run")

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
            [check.title for check in review_checks(prepared.card)],
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
        self.assertEqual([check.verdict for check in review_checks(card)], ["FAIL", "WARN", "FAIL"])

    def test_gbt_skill_publication_preserves_metadata_and_style_checks(self) -> None:
        self.write(
            WRITING_REQUEST,
            {"intent": "中文综述", "publication": {"citation_style": "gbt7714_2025"}},
        )
        self.write("05_generation/full_draft_v2.md", "# 方法\n\n比较。\\citep{Keyp1}\n")
        self.write(
            "05_generation/citations.bib",
            "@article{Keyp1,title={One},author={Example},year={2024},doi={10.1/one}}\n",
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
        original = (self.workspace / POSTCHECK).read_bytes()
        card = prepare_review(self.root, "survey", "result").card
        checks = {check.title: check for check in review_checks(card)}
        self.assertEqual(card.generation_status, "SUCCESS")
        self.assertEqual(card.status, "generated")
        self.assertEqual(checks[CHECK_LABELS["citation_format"]].verdict, "WARN")
        self.assertEqual(checks[CHECK_LABELS["citation_fidelity"]].verdict, "WARN")
        entry = next(issue for issue in review_issues(card) if issue.paper_ids == ["Keyp1"])
        self.assertEqual(entry.detail, "缺少字段：journal、volume")
        self.assertEqual((self.workspace / POSTCHECK).read_bytes(), original)

    def test_optional_issue_and_pages_do_not_create_review_issues(self) -> None:
        self.write(
            WRITING_REQUEST,
            {"intent": "中文综述", "publication": {"citation_style": "gbt7714_2025"}},
        )
        self.write("05_generation/full_draft_v2.md", "# 方法\n\n比较。\\citep{Keyp1}\n")
        self.write(
            "05_generation/citations.bib",
            "@article{Keyp1,title={One},author={Example},year={2024},"
            "journal={Research},volume={12},doi={10.1/one}}\n",
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
        card = prepare_review(self.root, "survey", "result").card
        checks = {check.title: check for check in review_checks(card)}
        self.assertEqual(card.status, "generated")
        self.assertEqual(checks[CHECK_LABELS["citation_format"]].verdict, "PASS")
        self.assertFalse(any(issue.paper_ids == ["Keyp1"] for issue in review_issues(card)))
        self.assertEqual(checks[CHECK_LABELS["citation_fidelity"]].verdict, "WARN")

    def test_publication_pdf_style_pass_and_metadata_failure_are_not_lost(self) -> None:
        self.write(GENERATION, {"status": "SUCCESS", "deliverable": "survey.pdf"})
        self.write(
            POSTCHECK,
            {
                "status": "WARNING",
                "checks": [
                    {
                        "id": "citation_metadata",
                        "status": "FAILED",
                        "message": "Missing author",
                        "incomplete_entries": [{"key": "Book", "missing": ["author", "publisher"]}],
                    },
                    {"id": "citation_fidelity", "status": "SUCCESS", "message": "Fixed PDF style"},
                ],
            },
        )
        card = prepare_review(self.root, "survey", "result").card
        checks = {check.title: check for check in review_checks(card)}
        self.assertEqual(checks[CHECK_LABELS["citation_format"]].verdict, "FAIL")
        self.assertEqual(checks[CHECK_LABELS["citation_fidelity"]].verdict, "PASS")
        self.assertEqual(review_issues(card)[1].detail, "缺少字段：author、publisher")
        for invalid_checks in (
            [{"id": "unknown_check", "status": "SUCCESS"}],
            [{"id": "citation_metadata", "status": "SUCCESS"}] * 2,
        ):
            self.write(POSTCHECK, {"status": "SUCCESS", "checks": invalid_checks})
            with self.assertRaisesRegex(ValueError, "review_check_identity_invalid"):
                prepare_review(self.root, "survey", "result")

    def test_issue_total_precedes_card_limit_and_missing_field_aliases_are_preserved(self) -> None:
        entries = [
            {"key": f"Paper{index}", "missing": ["pages"]} for index in range(REVIEW_ISSUES + 8)
        ]
        entries[0].update(missing_required=["author"], missing_recommended=["pages", "publisher"])
        self.report["checks"] = [
            {
                "id": "citation_format",
                "verdict": "WARN",
                "reason": "Metadata gaps",
                "incomplete_entries": entries,
            }
        ]
        self.write(POSTCHECK, self.report)
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(len(review_issues(card)), REVIEW_ISSUES)
        self.assertEqual(card.verification.issue_count, len(entries) + 1)
        self.assertEqual(review_issues(card)[1].detail, "缺少字段：author、pages、publisher")
        self.assertEqual(review_issues(card)[2].detail, "缺少字段：pages")
        projected = validate_review_card(card.model_dump(mode="json"))
        self.assertEqual(projected["verification"]["issue_count"], len(entries) + 1)
        projected["verification"].pop("issue_count")
        self.assertIsNone(validate_review_card(projected)["verification"]["issue_count"])

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
        self.assertIsNone(prepared.card.references.cited_count)
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

    def test_review_projects_per_paper_basis_without_certifying_fulltext_reading(self) -> None:
        self.write(
            CORPUS,
            {
                "p1": {"title": "Full text"},
                "p2": {"title": "Abstract", "abstract": "An available abstract"},
                "p3": {"title": "No extraction evidence"},
            },
        )
        self.write(
            FULLTEXT,
            {
                "with_full_text": 1,
                "papers": [
                    {"paper_id": "p1", "chars": 128, "detail": "Partial local PDF extraction"},
                    {"paper_id": "p2", "chars": 0, "outcome": "fetch_failed"},
                ],
            },
        )
        self.write_cited_fixture(
            {"p1": "Full text", "p2": "Abstract", "p3": "No extraction evidence"}
        )
        card = prepare_review(self.root, "survey", "result").card
        evidence = [row.evidence for row in card.references.rows]
        self.assertEqual([item.basis for item in evidence], ["fulltext", "abstract", "unknown"])
        self.assertEqual(evidence[0].extracted_chars, 128)
        self.assertEqual(evidence[0].reason, "Partial local PDF extraction")
        self.assertIsNone(evidence[2].extracted_chars)
        self.assertIsNone(card.references.abstract_cited_count)

    def test_incomplete_review_explains_missing_pipeline_evidence(self) -> None:
        for artifact in (CORPUS, SUMMARY, RETRIEVAL, GENERATION, POSTCHECK, OUTLINE):
            (self.workspace / artifact).unlink(missing_ok=True)
        self.write("06_output/survey.md", "# Manually written draft")
        card = prepare_review(self.root, "survey", "result").card
        self.assertEqual(card.status, "incomplete")
        for count in (
            card.included,
            card.fulltext,
            card.abstract_only,
            card.verification.issue_count,
        ):
            self.assertIsNone(count)
        self.assertEqual(len(card.warnings), 4)
        for stage in ("检索", "全文", "生成", "核验"):
            self.assertTrue(any(stage in warning for warning in card.warnings))

    def test_retrieval_card_includes_all_candidates(self) -> None:
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
        self.assertEqual(len(prepared.card.papers), prepared.card.candidates)
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
        self.assertEqual(
            prepared.authorization_refs[-2:],
            tuple(f"artifact:{digest}" for digest in prepared.source_digests),
        )

        # Removing/reordering papers never introduces a new source scope. Exact
        # file hashes still change for publication and material export checks.
        old_refs = set(prepared.authorization_refs)
        self.write(
            CORPUS,
            {
                "p2": {
                    **papers[1],
                    "selection_reason": "Updated explanation",
                    "authors": ["Verified Author"],
                }
            },
        )
        subset = prepare_review_search(self.root, "survey", "review-run")
        self.assertLess(set(subset.authorization_refs), old_refs)
        self.assertNotEqual(subset.corpus_sha256, prepared.corpus_sha256)

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

    def test_retrieval_diagnostics_are_logged_without_changing_forty_paper_snapshot(self) -> None:
        papers = [
            {"paper_id": f"p{index}", "title": f"Paper {index}", "year": 2025}
            for index in range(40)
        ]
        authors = [f"Research Author {index}" for index in range(54)]
        abstract = "Full abstract evidence. " * 180 + "ABSTRACT END"
        reason = "Complete selection rationale. " * 100 + "RATIONALE END"
        papers[0].update(authors=authors, abstract=abstract, reason=reason)
        warning = "agentic-search used degraded retrieval (source_mode=web_only)"
        self.write(METADATA, {"papers": papers})
        self.write(CORPUS, {paper["paper_id"]: paper for paper in papers})
        self.write(RETRIEVAL, {"input_count": 40, "output_count": 40, "degradations": [warning]})
        with self.assertLogs("service.literature.service.review", level="WARNING") as captured:
            prepared = prepare_review_search(self.root, "survey", "review-run")
        self.assertEqual(prepared.card.retained, 40)
        self.assertEqual(prepared.card.candidates, 40)
        self.assertEqual(len(prepared.card.papers), prepared.card.candidates)
        self.assertEqual(prepared.card.papers[0].authors, authors[:20])
        self.assertEqual(len(prepared.authorization_sources), 40)
        snapshot = project_review_search_artifacts(
            {path: (self.workspace / path).read_bytes() for path in (METADATA, CORPUS, RETRIEVAL)}
        )
        self.assertEqual(len(snapshot), prepared.card.retained)
        self.assertEqual([paper.id for paper in snapshot], [paper["paper_id"] for paper in papers])
        self.assertEqual(snapshot[0].authors, authors)
        self.assertEqual(snapshot[0].abstract, abstract)
        self.assertEqual(snapshot[0].reasons, [reason])
        self.assertIn(warning, captured.output[0])
        self.assertIn("review-run", captured.output[0])

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

        disposition = "authorized"
        authorization_calls = []

        async def authorize_sources(*args, **kwargs):
            authorization_calls.append(kwargs)
            challenge = SimpleNamespace(
                authorization_type="literature_review_fulltext", scope_digest="root-scope"
            )
            return challenge, SimpleNamespace(value=disposition), None

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            active_assistant_snapshot_id="snapshot-1",
            active_product_turn_id="turn",
            active_task_type="literature_review",
            product_turn_generation=1,
            current_task=SimpleNamespace(done=lambda: False),
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
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        reuse = Mock()
        reuse.prepare.return_value = {"assets": {}}
        reuse.publish.return_value = {"path": "02_retrieval/reading_assets.json", "exported": 0}
        register_literature_review_routes(
            app,
            sessions,
            SimpleNamespace(
                authorize_sources=authorize_sources,
                granted_refs=lambda _live, **scope: (
                    scope["refs"] if disposition == "authorized" else ()
                ),
            ),
            activities=activities,
            reading_reuse=reuse,
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
            self.assertIsNone(cards[0][1].get("fulltext_authorization"))
            self.assertEqual(set(published), {METADATA, CORPUS, RETRIEVAL})
            reuse.prepare.assert_called_once_with(
                self.root,
                ".",
                hashlib.sha256((self.root / CORPUS).read_bytes()).hexdigest(),
                "root-run",
            )
            reuse.publish.assert_called_once_with(self.root, ".", reuse.prepare.return_value)
            self.assertEqual(response.json()["reading_assets"]["exported"], 0)

            reuse.reset_mock()
            disposition = "rejected"
            denied = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": ".", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(denied.status_code, 200, denied.text)
            self.assertNotIn("reading_assets", denied.json())
            reuse.prepare.assert_not_called()
            reuse.publish.assert_not_called()
            disposition = "authorized"

            self.write(WRITING_REQUEST, {"execution": {"mode": "quick"}})
            calls_before = len(authorization_calls)
            quick = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": ".", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(quick.status_code, 200, quick.text)
            self.assertEqual(quick.json()["authorization"]["disposition"], "not_required")
            self.assertEqual(quick.json()["authorization"]["granted_refs"], [])
            self.assertEqual(
                validate_search_card(cards[-1][1]).get("fulltext_authorization"),
                {"disposition": "not_required", "evidence_kind": "abstract"},
            )
            with self.assertRaises(ValueError):
                validate_search_card(
                    {
                        **cards[-1][1],
                        "fulltext_authorization": {
                            "disposition": "authorized",
                            "evidence_kind": "abstract",
                        },
                    }
                )
            self.assertEqual(len(authorization_calls), calls_before)
            reuse.prepare.assert_not_called()
            reuse.publish.assert_not_called()
            (self.root / WRITING_REQUEST).unlink()

            def supersede(*args):
                live.active_product_turn_id = "next-turn"
                return {"assets": {}}

            reuse.prepare.side_effect = supersede
            stale = client.post(
                LITERATURE_REVIEW_ROUTE,
                json={"workspace": ".", "checkpoint": "retrieval"},
                headers=headers,
            )
            self.assertEqual(stale.status_code, 400, stale.text)
            self.assertEqual(stale.json()["reason"], "fulltext_authorization_task_required")
            reuse.publish.assert_not_called()
            live.active_product_turn_id = "turn"
            reuse.prepare.side_effect = None

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
        self.assertEqual(review_checks(card)[0].verdict, "NOT_CHECKED")
        self.assertEqual(card.references.cited_count, 1)
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
        self.assertEqual(len(review_checks(card)), 1)
        self.assertEqual(sum(check.verdict == "NOT_CHECKED" for check in review_checks(card)), 0)
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
        self.assertEqual(review_checks(card)[0].verdict, "PASS")
        self.assertEqual(card.references.cited_count, 1)

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
        self.assertEqual(review_checks(card)[0].title, "Producer title")
        self.assertEqual(review_checks(card)[0].reason, "Producer reason")
        self.assertEqual(review_checks(card)[0].verdict, "WARN")
        self.assertEqual(len(review_checks(card)), 1)
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
        reference = {
            "plugin": "literature-review",
            "component": "outline",
            "fingerprint": "review-version",
        }

        async def request_product_input(question, **kwargs):
            product_questions.append((question, kwargs))
            answer = REVIEW_CONFIRM_LABEL if question.get("header") == REVIEW_HEADER else "一键授权"
            return {"answers": {question["id"]: answer}}

        live = SimpleNamespace(
            id="session",
            bridge_token="private",
            publication_turn_id="turn",
            active_assistant_snapshot_id="snapshot-1",
            active_task_type="literature_review",
            last_submission_id="client-turn",
            interrupt_generation=0,
            active_assistant_revision=None,
            current_task=SimpleNamespace(done=lambda: False),
            active_product_turn_id="turn",
            product_turn_generation=1,
            ledger=SimpleNamespace(active_turn_id="turn"),
            runtime_workdir=self.root,
            publish_artifact=publish,
            display_card=display,
            interactions=SimpleNamespace(request_product_input=request_product_input),
            component_for=AsyncMock(return_value=reference),
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
                turn_id="turn",
                refs=("paper:p1", "paper:p2"),
            )
        )
        app = FastAPI()
        activities = Activities()
        live.turn_activity = activities.enter(ActivityDomain.TURN)
        self.addCleanup(live.turn_activity.close)
        register_literature_review_routes(
            app,
            sessions,
            FulltextGate(
                SimpleNamespace(
                    prepare=prepare_authorization,
                    task_key=lambda *_scope: "",
                    effective_scope=lambda **scope: SimpleNamespace(
                        allowed=scope.get("refs", ()) if product_questions else (),
                        denied=(),
                        unknown=scope.get("refs", ()) if not product_questions else (),
                        authorizations=(
                            (
                                SimpleNamespace(
                                    refs=scope.get("refs", ()),
                                    question_id="literature-review-fulltext:opaque",
                                    authorization_type="literature_review_fulltext",
                                    scope_digest="scope-digest",
                                ),
                            )
                            if product_questions
                            else ()
                        ),
                    ),
                ),
                SimpleNamespace(),
                activities=activities,
            ),
            activities=activities,
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
            self.write(".slr-binding.json", {"run_id": "review-run"})
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
            reference = confirmed.json()["receipt_ref"]
            self.assertEqual(
                confirmed.json()["continuation"], confirmation_continuation(receipt, reference)
            )
            saved = json.loads((self.root / reference).read_text())
            self.assertEqual(saved["response"]["confirmation"], receipt)
            self.assertEqual(saved["operation"], "literature.review.outline")
            self.assertEqual(receipt["packet_id"], "packet")
            self.assertEqual(receipt["deadline_at"], 1300)
            self.assertEqual(
                receipt["decision"]["answers"][receipt["request_id"]], REVIEW_CONFIRM_LABEL
            )
            self.assertEqual(confirmed.json()["continuation"]["state"], "confirmed")
            self.assertEqual(product_questions[-1][1]["timeout_seconds"], 300)
            self.assertNotIn("component", product_questions[-1][0])
            self.assertNotIn("component_data", product_questions[-1][0])
            live.component_for.assert_not_awaited()
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
            failure = ReviewMetadataError("papers[0].paper_id", True, "string or integer ID")
            with patch("service.literature.api.review.prepare_review_search", side_effect=failure):
                invalid = client.post(
                    LITERATURE_REVIEW_ROUTE, json=retrieval_payload, headers=headers
                )
            self.assertEqual(invalid.status_code, 400, invalid.text)
            self.assertEqual(invalid.json()["reason"], "review_metadata_invalid")
            self.assertEqual(invalid.json()["issues"], failure.issues)
            self.assertIn("do not repeat discovery", invalid.json()["next_action"])
            self.assertEqual(len(cards), 1)
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
            self.assertEqual(product_questions[0][0]["result_card_id"], "review-card")
            self.assertEqual(
                product_questions[0][0]["papers"],
                [
                    {"id": "paper:p1", "label": "One", "description": ""},
                    {"id": "paper:p2", "label": "Two", "description": ""},
                ],
            )
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
            prepare_authorization.assert_called_once()
            self.assertEqual(len(product_questions), 1)
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
        self.assertEqual(BRIDGE_REQUESTS[("literature", "review")].route, LITERATURE_REVIEW_ROUTE)
        registry = CardRegistry()
        registry.register(REVIEW_CARD, validate_review_card, direct=False)
        self.assertFalse(registry.allows_direct(REVIEW_CARD))


if __name__ == "__main__":
    unittest.main()
