#!/usr/bin/env scholarseed-skill-python
"""Behavior tests for hybrid drafting, selected publication, and review safety."""
import asyncio
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from task_fixtures import task, set_publication, planned_outline
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import writing
from writing_contract import approval_snapshot, digest, load_outline, require_approval


def section(sid, title):
    return {"section_id": sid, "title": title, "description": "Compare the methods and their limitations.",
            "paper_ids": ["p1", "p2"], "subsections": [], "figures": [], "tables": []}


class FakeModel:
    def __init__(self, invalid=0):
        self.calls = 0
        self.invalid = invalid
        self.active = 0
        self.peak = 0
        self.contexts = []

    async def chat_stream(self, messages, **kwargs):
        self.calls += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        await asyncio.sleep(.01)
        self.active -= 1
        if self.calls <= self.invalid:
            return '{"body_md":"bad"}'
        context = json.loads(messages[1]["content"])
        self.contexts.append(context)
        item = context["item"]
        key = item["allowed_cite_keys"][0] if item["allowed_cite_keys"] else None
        body = ("A comparative result depends on assumptions and evaluation conditions. " * 45
                + ("\\citep{" + key + "}" if key else ""))
        if item.get("subsections"):
            sections = []
            for sub in item["subsections"]:
                heading = ("### " + sub["title"] + "\n\n" if context["output_format"] == "markdown"
                           else "\\subsection{" + sub["title"] + "}\\label{" + sub["label"] + "}\n")
                sections.append(heading + body)
            body = "\n\n".join(sections)
        return json.dumps({"section_id": item["section_id"], "title": item["title"],
                           "body_md": body, "claims": [], "insights": [{"text": "The shared assumptions determine comparability."}], "tables": []})


class WritingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.ws = Path(self.temp.name)
        self.put("01_input/query.json", {"query": "Compare methods", "language": "english"})
        self.put("01_input/writing_request.json", {"output_scope": "section", "user_instructions": "Only discuss limitations."})
        cards = {p: {"title": title, "year": 2024, "paper_type": "method", "abstract": "Evidence.",
                     "common_fields": {"tldr": "A result", "claims": ["A claim"]},
                     "card": {"method": {"description": "A method", "key_formulas": ["x=1"]}}}
                 for p, title in [("p1", "First method"), ("p2", "Second method")]}
        self.put("03_process/paper_cards.json", cards)
        self.put("03_process/cite_keys.json", {"p1": "First2024", "p2": "Second2024"})
        self.put("02_retrieval/selected_paper.json", cards)
        self.put("04_outline/outline.json", {"survey_title": "Methods", "topic": "Methods",
                                              "outline_tree": [section("3", "Methods"), section("4", "Evaluation")]})
        self.set_publication( {"format": "markdown", "citation_style": "numeric"})
        self.prep()

    def put(self, rel, data):
        if rel=="04_outline/outline.json":data=planned_outline(data)
        if rel=="01_input/writing_request.json":
            data=task(data)
            if (self.ws/rel).exists(): data["publication"]=writing.read(self.ws/rel).get("publication",{})
        writing.save(self.ws / rel, data)

    def set_publication(self,value):set_publication(self.ws,value)

    def cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "scripts/slr.py"), *args,
                               "--workspace", str(self.ws)], capture_output=True, text=True)

    def prep(self):
        result = self.cli("run", "generation_prep")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def generate(self, model, **kw):
        return asyncio.run(writing.generate(self.ws, kw.get("ids"), 2, kw.get("repairs", 1),
                                            kw.get("overwrite", False), False, client=model))

    def test_bounded_repairs_and_non_destructive_failure(self):
        model = FakeModel(invalid=10)
        report = self.generate(model, ids=["3"])
        self.assertEqual(model.calls, 2)
        self.assertEqual(report["status"], "FAILED")
        self.assertFalse((self.ws / "05_generation/section_drafts/3.json").exists())

    def test_parallel_drafting_resume_and_changed_input(self):
        model = FakeModel()
        result = self.generate(model)
        self.assertEqual(result["status"], "SUCCESS", result)
        self.assertEqual(model.peak, 2)
        result = self.generate(model)
        self.assertTrue(all(r["status"] == "SKIPPED" for r in result["sections"]))
        self.assertEqual(model.calls, 2)
        item = self.ws / "05_generation/_internal/drafting_items/3.json"
        data = writing.read(item)
        data["item"]["description"] += " Explain new evidence."
        writing.save(item, data)
        result = self.generate(model, ids=["3"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(model.calls, 2)

    def test_selected_chapter_publishes_without_other_drafts(self):
        self.put("01_input/writing_request.json", {"output_scope": "section", "selected_section_ids": ["3"]})
        check = self.cli("outline", "check", "--json", "--min-papers-per-section", "2")
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        self.prep()
        self.assertEqual([s["section_id"] for s in load_outline(self.ws)["outline_tree"]], ["3"])
        report = self.generate(FakeModel())
        self.assertEqual(report["status"], "SUCCESS", report)
        merge = self.cli("run", "generation_merge")
        self.assertEqual(merge.returncode, 0, merge.stdout + merge.stderr)
        text = writing.draft_path(self.ws, 1).read_text()
        self.assertIn("Methods", text)
        self.assertNotIn("Evaluation", text)
        receipt = writing.apply_review(self.ws, {"base_sha256": digest(text), "edits": []})
        self.assertEqual(receipt["edits"], 0)
        publication = self.cli("run", "generation_publish")
        self.assertEqual(publication.returncode, 0, publication.stdout + publication.stderr)
        published = (self.ws / "06_output/survey.md").read_text()
        self.assertNotIn("Evaluation", published)
        self.assertFalse(json.loads(publication.stdout)["artifacts_missing"])

    def test_scope_change_requires_preparation(self):
        self.put("01_input/writing_request.json", {"output_scope": "section", "selected_section_ids": ["3"]})
        with self.assertRaisesRegex(ValueError, "generation_prep"):
            self.generate(FakeModel())

    def test_review_approval_is_tied_to_current_outline(self):
        self.put("01_input/writing_request.json", {"outline_review": "required"})
        with self.assertRaisesRegex(ValueError, "review required"):
            require_approval(self.ws)
        self.put("04_outline/approval.json", {"snapshot": approval_snapshot(self.ws), "user_response":"Approved."})
        require_approval(self.ws)
        outline = writing.read(self.ws / "04_outline/outline.json")
        outline["topic"] = "Changed intent"
        self.put("04_outline/outline.json", outline)
        with self.assertRaises(ValueError):
            require_approval(self.ws)

    def test_review_atomic_and_rejects_stale_citations_headings(self):
        text = "# Methods\n\nEvidence supports the comparison \\citep{First2024}.\n\n## Limits\n\nA limitation remains.\n"
        writing.atomic_text(writing.draft_path(self.ws, 1), text)
        packet = writing.review_packet(self.ws)
        block = packet["blocks"][1]
        patch = {"base_sha256": packet["base_sha256"], "edits": [
            {"id": block["id"], "before_sha256": block["sha256"], "text": "Revised comparison \\citep{First2024}."}]}
        writing.apply_review(self.ws, patch)
        good = writing.draft_path(self.ws, 2).read_text()
        patch["edits"][0]["text"] = "Invented \\citep{Missing2026}."
        with self.assertRaisesRegex(ValueError, "citation"):
            writing.apply_review(self.ws, patch)
        self.assertEqual(writing.draft_path(self.ws, 2).read_text(), good)
        patch["base_sha256"] = "stale"
        with self.assertRaisesRegex(ValueError, "stale"):
            writing.apply_review(self.ws, patch)

    def test_unknown_scope_id_and_empty_evidence_fail_before_generation(self):
        self.put("01_input/writing_request.json", {"output_scope": "section", "selected_section_ids": ["99"]})
        with self.assertRaises(ValueError):
            load_outline(self.ws)

    def test_abstract_and_conclusion_use_completed_body(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        abstract = section("0", "Abstract")
        abstract["paper_ids"] = []
        conclusion = section("5", "Conclusion")
        conclusion["paper_ids"] = []
        outline["outline_tree"] = [abstract, *outline["outline_tree"], conclusion]
        self.put("04_outline/outline.json", outline)
        self.prep()
        model = FakeModel()
        result = self.generate(model)
        self.assertEqual(result["status"], "SUCCESS", result)
        self.assertEqual([c["item"]["section_id"] for c in model.contexts][-2:], ["5", "0"])
        self.assertEqual(set(model.contexts[-2]["completed_body"]), {"3", "4"})
        self.assertEqual(set(model.contexts[-1]["completed_body"]), {"3", "4", "5"})
        self.assertEqual(set(model.contexts[-2]["item"]["allowed_cite_keys"]), {"First2024", "Second2024"})

    def test_table_evidence_is_deduplicated_and_renders_in_both_dialects(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        outline["outline_tree"][0]["tables"] = [{"table_id": "T1", "caption": "Comparison", "paper_ids": ["p1", "p2"]}]
        self.put("04_outline/outline.json", outline)
        self.prep()
        context = writing.packet(self.ws, "3")
        self.assertEqual(len(context["evidence"]), 2)
        table = context["item"]["planned_tables"][0]
        self.assertNotIn("papers", table)
        self.assertEqual(context["evidence"]["First2024"]["card"]["method"]["key_formulas"], ["x=1"])
        from table_checks import collect_problems
        from latex_to_markdown import scan_tables
        rows = {"table_id": "T1", "columns": ["Method", "Result"],
                "rows": [[r"First \citep{First2024}", "A bounded result"],
                         [r"Second \citep{Second2024}", "Different assumptions"]]}
        for markdown in (False, True):
            rendered = writing.render_table(rows, table, markdown)
            self.assertFalse(collect_problems(rendered, table["label"], table["allowed_cite_keys"]))
            writing.atomic_text(self.ws / "05_generation/tables/T1.tex", rendered)
            self.assertIn("T1", scan_tables(self.ws / "05_generation/tables"))

    def test_citation_error_is_reported_without_erasing_prose(self):
        body = "A supported comparison needs evidence. " * 80 + r"\citep{NotAssigned}"
        self.put("05_generation/section_drafts/3.json", {"section_id": "3", "title": "Methods",
                  "body_md": body, "claims": [], "insights": [{"text": "A comparison"}]})
        subprocess.run([sys.executable, str(ROOT / "scripts/generation/drafting/_fast/validate_drafts.py"),
                        str(self.ws), "--only", "3"], capture_output=True, text=True)
        self.assertEqual(writing.read(self.ws / "05_generation/section_drafts/3.json")["body_md"], body)
        report = writing.read(self.ws / "05_generation/_status/validate_drafts.json")
        self.assertTrue(report["invalid"])

    def test_card_changes_invalidate_preparation(self):
        cards = writing.read(self.ws / "03_process/paper_cards.json")
        cards["p1"]["abstract"] = "New evidence."
        self.put("03_process/paper_cards.json", cards)
        with self.assertRaisesRegex(ValueError, "generation_prep"):
            self.generate(FakeModel())

    def test_unassigned_table_is_reported_and_raw_response_preserved(self):
        class ExtraTableModel(FakeModel):
            async def chat_stream(self, messages, **kwargs):
                value = json.loads(await super().chat_stream(messages, **kwargs))
                value["tables"] = [{"table_id": "InventedTable", "columns": ["Method", "Finding"],
                                    "rows": [[r"First \citep{First2024}", "A bounded result"]]}]
                return json.dumps(value)

        report = self.generate(ExtraTableModel(), ids=["3"], repairs=0)
        self.assertEqual(report["status"], "FAILED")
        self.assertIn("tables must contain each assigned table exactly once", report["sections"][0]["reason"])
        self.assertFalse((self.ws / "05_generation/section_drafts/3.json").exists())
        self.assertFalse((self.ws / "05_generation/tables/InventedTable.tex").exists())
        raw = writing.read(self.ws / "_logs/writing/3.attempt-1.json")["response"]
        self.assertEqual(json.loads(raw)["tables"][0]["table_id"], "InventedTable")

    @unittest.skipUnless(shutil.which("pdflatex") and shutil.which("bibtex"), "TeX tools unavailable")
    def test_english_pdf_publication_with_abstract_anchors(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        abstract = section("0", "Abstract")
        abstract["paper_ids"] = []
        outline["outline_tree"].insert(0, abstract)
        self.put("04_outline/outline.json", outline)
        self.set_publication( {"format": "latex_pdf", "citation_style": "numeric"})
        self.prep()
        self.assertEqual(self.generate(FakeModel())["status"], "SUCCESS")
        merge = self.cli("run", "generation_merge")
        self.assertEqual(merge.returncode, 0, merge.stdout + merge.stderr)
        (self.ws / "05_generation/citations.bib").write_text(
            "@article{First2024, author={A. Researcher}, title={First method}, year={2024}, journal={Methods}}\n"
        )
        text = writing.draft_path(self.ws, 1).read_text()
        writing.apply_review(self.ws, {"base_sha256": digest(text), "edits": []})
        result = self.cli("run", "generation_publish")
        pdf = self.ws / "06_output/Methods.pdf"
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(pdf.exists(), result.stdout + result.stderr)
        self.assertGreater(pdf.stat().st_size, 1000)
        status = writing.read(self.ws / "05_generation/_status/phase07_compile_latex.json")
        self.assertEqual(status["diagnosis"]["verdict"], "clean", status)

    def test_description_summary_does_not_create_terminal_dependency(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        discussion = section("5", "Evidence gaps")
        discussion["description"] = "A summary of limitations and further comparisons."
        discussion["paper_ids"] = []
        discussion["subsections"] = [section("5.1", "Evidence limits")]
        conclusion = section("6", "Conclusions")
        conclusion["paper_ids"] = []
        outline["outline_tree"] += [discussion, conclusion]
        self.put("04_outline/outline.json", outline)
        self.prep()
        model = FakeModel()
        result = self.generate(model)
        self.assertEqual(result["status"], "SUCCESS", result)
        discussion_packet = next(c for c in model.contexts if c["item"]["section_id"] == "5")
        self.assertNotEqual(discussion_packet["item"]["section_kind"], "conclusion")
        self.assertEqual(set(model.contexts[-1]["completed_body"]), {"3", "4", "5"})

    def test_multiple_terminal_sections_follow_outline_order(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        for sid, title in [("5", "Summary"), ("6", "Conclusions")]:
            node = section(sid, title)
            node["paper_ids"] = []
            outline["outline_tree"].append(node)
        self.put("04_outline/outline.json", outline)
        self.prep()
        model = FakeModel()
        result = self.generate(model)
        self.assertEqual(result["status"], "SUCCESS", result)
        self.assertEqual([c["item"]["section_id"] for c in model.contexts][-2:], ["5", "6"])
        self.assertEqual(set(model.contexts[-2]["completed_body"]), {"3", "4"})
        self.assertEqual(set(model.contexts[-1]["completed_body"]), {"3", "4", "5"})

    def test_produce_requires_approval_before_starting_either_branch(self):
        self.put("01_input/writing_request.json", {"outline_review": "required"})
        result = self.cli("writing", "produce", "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("review required", result.stdout)
        self.assertFalse((self.ws / "_logs/produce").exists())

    def test_produce_dry_run_prepares_packets_without_drafts(self):
        result = self.cli("writing", "produce", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "SUCCESS", report)
        self.assertEqual(len(report["components"]), 1)
        prepared = report["components"][0]["report"]
        self.assertIsNone(prepared["usage"])
        self.assertTrue(all(s["status"] == "PREPARED" for s in prepared["sections"]))
        self.assertFalse(list((self.ws / "05_generation/section_drafts").glob("*.json")))

    @unittest.skipUnless(shutil.which("pdflatex") and shutil.which("bibtex"), "TeX tools unavailable")
    def test_failed_pdf_publication_exposes_error_and_is_not_success(self):
        class UndefinedMacroModel(FakeModel):
            async def chat_stream(self, messages, **kwargs):
                value = json.loads(await super().chat_stream(messages, **kwargs))
                value["body_md"] += r"\notDefinedHere"
                return json.dumps(value)
        self.set_publication( {"format": "latex_pdf", "citation_style": "numeric"})
        self.prep()
        self.assertEqual(self.generate(UndefinedMacroModel())["status"], "SUCCESS")
        self.assertEqual(self.cli("run", "generation_merge").returncode, 0)
        text = writing.draft_path(self.ws, 1).read_text()
        writing.apply_review(self.ws, {"base_sha256": digest(text), "edits": []})
        result = self.cli("run", "generation_publish")
        report = json.loads(result.stdout)
        self.assertEqual(report["status"], "FAILED", report)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(r"\notDefinedHere", "\n".join(report["compile"]["error_contexts"]))
        self.assertFalse((self.ws / "06_output/survey.pdf").exists())

    def test_table_only_evidence_can_support_owner_prose_and_claims(self):
        cards = writing.read(self.ws / "03_process/paper_cards.json")
        cards["p3"] = {**cards["p1"], "title": "Unassigned third paper"}
        self.put("03_process/paper_cards.json", cards)
        self.put("02_retrieval/selected_paper.json", cards)
        self.put("03_process/cite_keys.json", {"p1": "First2024", "p2": "Second2024", "p3": "Third2024"})
        outline = writing.read(self.ws / "04_outline/outline.json")
        outline["outline_tree"][0]["paper_ids"] = ["p1"]
        outline["outline_tree"][0]["tables"] = [{"table_id": "T1", "caption": "Comparison", "paper_ids": ["p2"]}]
        self.put("04_outline/outline.json", outline)
        self.prep()

        class TableEvidenceModel(FakeModel):
            async def chat_stream(self, messages, **kwargs):
                value = json.loads(await super().chat_stream(messages, **kwargs))
                value["body_md"] += r" Table~\ref{tab:T1} compares the evidence \citep{Second2024}."
                value["claims"] = [{"text": "A table comparison.", "cite_keys": ["Second2024"]}]
                value["tables"] = [{"table_id": "T1", "columns": ["Method", "Finding"],
                                    "rows": [[r"Second \citep{Second2024}", "A bounded result"]]}]
                return json.dumps(value)

        result = self.generate(TableEvidenceModel(), ids=["3"], repairs=0)
        self.assertEqual(result["status"], "SUCCESS", result)
        draft = writing.read(self.ws / "05_generation/section_drafts/3.json")
        subprocess.run([sys.executable, str(ROOT / "scripts/generation/drafting/_fast/validate_drafts.py"),
                        str(self.ws), "--only", "3"], capture_output=True, text=True)
        self.assertFalse(writing.read(self.ws / "05_generation/_status/validate_drafts.json")["invalid"])
        context = writing.packet(self.ws, "3")
        self.assertEqual(set(context["evidence"]), {"First2024", "Second2024"})
        self.assertEqual(context["item"]["planned_tables"][0]["allowed_cite_keys"], ["Second2024"])
        draft["body_md"] += r" \citep{Third2024}"
        self.assertTrue(any("unsupported citation" in e for e in writing.validate_draft(draft, context)))
        draft["body_md"] = draft["body_md"].replace(r" \citep{Third2024}", "")
        draft["tables"][0]["rows"][0][0] = r"First \citep{First2024}"
        self.assertTrue(any("row must cite evidence assigned" in e for e in writing.validate_draft(draft, context)))

    def test_planned_wrapper_normalization_keeps_raw_history_across_reruns(self):
        outline = writing.read(self.ws / "04_outline/outline.json")
        outline["outline_tree"][0]["figures"] = [{"figure_id": "F1", "caption": "A planned mechanism", "paper_ids": ["p1", "p2"]}]
        self.put("04_outline/outline.json", outline)
        self.set_publication( {"format": "latex_pdf", "citation_style": "numeric"})
        self.prep()
        class WrapperModel(FakeModel):
            async def chat_stream(self, messages, **kwargs):
                value = json.loads(await super().chat_stream(messages, **kwargs))
                value["body_md"] += r"\begin{figure}\centering\includegraphics{F1_detail.png}\caption{Expanded explanation with evidence \citep{First2024}.}\label{fig:F1}\end{figure}"
                return json.dumps(value)
        first = self.generate(WrapperModel(), ids=["3"])
        self.assertEqual(first["status"], "SUCCESS", first)
        self.assertEqual(first["sections"][0]["attempts"], 1)
        draft = writing.read(self.ws / "05_generation/section_drafts/3.json")
        self.assertNotIn("Expanded explanation", draft["body_md"])
        self.assertNotIn(r"\begin{figure}", draft["body_md"])
        self.generate(WrapperModel(), ids=["3"], overwrite=True)
        logs = list((self.ws / "_logs/writing/history").glob("*/3.attempt-1.json"))
        self.assertEqual(len(logs), 2)
        records = [writing.read(p) for p in logs]
        self.assertEqual(len({r["request_id"] for r in records}), 2)
        self.assertTrue(all(r"\begin{figure}" in r["response"] for r in records))
        self.assertTrue(all(r["normalizations"][0]["label"] == "fig:F1" for r in records))

    def test_provider_failure_is_preserved_without_retry_or_secret(self):
        class FailedProvider(FakeModel):
            async def chat_stream(self, messages, **kwargs):
                self.calls += 1
                raise RuntimeError("denied fixture-secret-not-real")
        model = FailedProvider()
        with patch.dict("os.environ", {"SCHOLARSEED_ACCOUNT_TOKEN": "fixture-secret-not-real"}):
            result = self.generate(model, ids=["3"])
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(model.calls, 1)
        logs = list((self.ws / "_logs/writing/history").glob("*/3.attempt-*.json"))
        self.assertEqual(len(logs), 1)
        record = writing.read(logs[0])
        self.assertEqual(record["state"], "request_failed")
        self.assertIsNone(record["response"])
        self.assertIsNone(record["usage"])
        self.assertNotIn("fixture-secret-not-real", logs[0].read_text())


if __name__ == "__main__":
    unittest.main()
