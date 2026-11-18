import asyncio
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import slr
import test_native_pipeline as native
from local_papers import import_pdfs
from paper_materials import evidence_records, readiness
from planning import complete, decide, packet
from quick import prepare_abstracts
from task_contract import atomic_json, configure, digest, publication_view, read_request
from workflow import advance
from task_fixtures import authoring_context


class DraftModel:
    def __init__(self):
        self.calls = []

    async def chat_stream(self, messages, **options):
        value = authoring_context(messages)
        self.calls.append(value)
        options["_capture"]["finish_reason"] = "stop"
        key = value["allowed_cite_keys"][0]
        body = "A supported comparison from the original abstract " + r"\cite{" + key + "}."
        return body



class ModeBoundaryTest(unittest.TestCase):
    def test_processing_stages_import_without_inherited_module_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ):
                os.environ.pop("PYTHONPATH", None)
                environment = slr.stage_env("fast", Path(directory))
            for script in ("quick.py", "processing/paper_card_tools.py"):
                with self.subTest(script=script):
                    result = subprocess.run(
                        [sys.executable, str(native.ROOT / "scripts" / script), "--help"],
                        cwd=directory,
                        env=environment,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn("usage:", result.stdout)

    def test_quick_drafts_document_or_paragraph_once_from_abstracts(self):
        for scope in ("survey", "section"):
            with self.subTest(scope=scope):
                fixture = native.NativeTest()
                fixture.setUp()
                try:
                    configure(
                        fixture.ws,
                        {
                            "execution": {"mode": "quick"},
                            "outline_review": "plan",
                            "output_scope": scope,
                            "publication": {"format": "markdown"},
                        },
                    )
                    (fixture.ws / "04_outline/outline.json").unlink()
                    configure(fixture.ws, {"effective_requirements": "Compare only inference cost; answer as a focused report."})
                    (fixture.ws / "03_process/paper_cards.json").unlink()
                    prepare_abstracts(fixture.ws)
                    agreement = packet(fixture.ws)
                    complete(
                        fixture.ws,
                        {
                            "packet_id": agreement["packet_id"],
                            "snapshot_id": digest(agreement["snapshot"]),
                            "request_id": "request",
                            "started_at": 0,
                            "deadline_at": 300,
                            "decision": {"answers": {"request": "Proceed."}},
                        },
                    )
                    decide(fixture.ws, {"packet_id": agreement["packet_id"], "action": "proceed"})
                    model = DraftModel()
                    result = fixture.run_pipeline(model)
                    self.assertEqual(result["model_calls"], 1)
                    self.assertEqual(len(model.calls), 1)
                    self.assertIn("A bounded supported result.", model.calls[0]["evidence"])
                    self.assertNotIn("card", json.dumps(model.calls))
                    self.assertNotIn("confirmed_outline", model.calls[0])
                    self.assertIn("inference cost", model.calls[0]["task"]["effective_requirements"])
                    self.assertFalse((fixture.ws / "03_process/paper_cards.json").exists())
                    self.assertFalse((fixture.ws / "05_generation/refine.packet.json").exists())
                    publication = native.publish(fixture.ws)
                    self.assertEqual(publication["status"], "SUCCESS")
                    self.assertEqual(Path(publication["deliverable"]).suffix, ".md")
                    self.assertEqual(fixture.run_pipeline(model)["model_calls"], 0)
                    self.assertEqual(len(model.calls), 1)
                    source = fixture.ws / "05_generation/full_draft_v2.md"
                    source.write_text(r"A reported change of 20% \cite{Keyp1}.")
                    with patch(
                        "manuscript_publication.render_trees",
                        side_effect=AssertionError("must not compile"),
                    ):
                        self.assertEqual(native.publish(fixture.ws)["status"], "SUCCESS")
                    self.assertFalse((fixture.ws / "06_output/citations.bib").exists())
                    for media in (
                        "![figure](figures/F1.tex)",
                        '<img src="figure.png">',
                        "<svg></svg>",
                    ):
                        source.write_text(media)
                        with patch(
                            "manuscript_publication.render_trees",
                            side_effect=AssertionError("must not compile"),
                        ):
                            with self.assertRaisesRegex(ValueError, "Quick"):
                                native.publish(fixture.ws)
                finally:
                    fixture.doCleanups()

    def test_quick_defaults_to_markdown_and_rejects_other_capabilities(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(workspace, {"intent": "Write a review.", "execution": {"mode": "quick"}})
            self.assertEqual(publication_view(read_request(workspace))["format"], "markdown")
            with self.assertRaisesRegex(ValueError, "Standard"):
                import_pdfs(workspace, {"files": ["/unreadable/never-read.pdf"]})
            with self.assertRaisesRegex(ValueError, "Standard"):
                configure(workspace, {"local_pdfs": ["/unreadable/never-read.pdf"]})
            for publication in ({"format": "docx"}, {"format": "latex_pdf"}):
                with self.assertRaisesRegex(ValueError, "Standard"):
                    configure(workspace, {"publication": publication})
            with self.assertRaisesRegex(ValueError, "Standard"):
                configure(
                    workspace,
                    {
                        "user_requests": ["Include one figure."],
                        "effective_requirements": "Write a review and include one figure.",
                        "constraints": [
                            {
                                "id": "figure",
                                "kind": "figure_count",
                                "value": {"min": 1},
                                "verbatim": "Include one figure.",
                            }
                        ],
                    },
                )

    def test_abstract_view_ignores_pdf_and_old_cards(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            configure(
                workspace,
                {
                    "intent": "Use the abstracts.",
                    "execution": {"mode": "quick"},
                    "publication": {"format": "markdown"},
                },
            )
            (workspace / "02_retrieval").mkdir(exist_ok=True)
            (workspace / "03_process").mkdir(exist_ok=True)
            paper = {
                "title": "Actual paper",
                "authors": [{"name": "Ada Author"}],
                "year": 2024,
                "abstract": "An actual abstract with a stated condition.",
                "local_source": {"path": "/unreadable/never-read.pdf"},
            }
            (workspace / "02_retrieval/selected_paper.json").write_text(
                json.dumps({"long-id": paper})
            )
            (workspace / "03_process/paper_cards.json").write_text("MUST NOT BE READ")
            result = prepare_abstracts(workspace)
            self.assertEqual(result["model_calls"], 0)
            self.assertEqual(result["status"], "SUCCESS")
            self.assertEqual(result["abstract_count"], 1)
            record = evidence_records(workspace)["long-id"]
            self.assertEqual(record["abstract"], paper["abstract"])
            self.assertNotIn("card", record)
            self.assertNotIn("local_source", record)
            self.assertFalse((workspace / "02_retrieval/paper_info.json").exists())
            self.assertEqual(
                (workspace / "03_process/paper_cards.json").read_text(), "MUST NOT BE READ"
            )
            self.assertTrue(readiness(workspace)["ready_for_outline"])
            self.assertEqual(readiness(workspace)["next_action"], "manuscript prepare")
            from scripted_generation import generate
            from generation_errors import GenerationError
            with self.assertRaises(GenerationError):
                asyncio.run(generate(workspace, 'outline', client=DraftModel()))
            calls = []

            def runner(_workspace, command):
                calls.append(command)
                return 0, {"status": "SUCCESS"}

            outcome = advance(workspace, "evidence", start="processing", runner=runner)
            self.assertEqual(outcome["boundary"], "writing_ready")
            self.assertEqual(
                calls,
                [["run", "processing"], ["manuscript", "prepare"]],
            )
            calls.clear()
            self.assertEqual(
                advance(workspace, "evidence", start="fulltext", runner=runner)["status"], "FAILED"
            )
            self.assertEqual(calls, [])
            paper["abstract"] = ""
            (workspace / "02_retrieval/selected_paper.json").write_text(
                json.dumps({"long-id": paper})
            )
            with self.assertRaisesRegex(ValueError, "abstract"):
                prepare_abstracts(workspace)


if __name__ == "__main__":
    unittest.main()
