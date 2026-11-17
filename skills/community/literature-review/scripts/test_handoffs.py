import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from generation.citation_formats import CitationResolver, parse_bib_file
from figure_dependencies import wait_contexts
from task_contract import configure
from taxonomy import render_trees
from generation_errors import GenerationError
from tracker import transition as build_transition
from word import export as export_word

ROOT = Path(__file__).resolve().parents[1]


def transition(*args, **kwargs):
    return build_transition(*args, protocol='legacy', **kwargs)


class HandoffTest(unittest.TestCase):
    def test_flat_create_then_start_uses_separate_current_revisions(self):
        snapshot = {'ok': True, 'turn_id': 'turn', 'plan': None, 'items': [], 'actions': {}}
        created = build_transition(snapshot, 'materials', 'in_progress', protocol='flat')
        self.assertEqual(created['operation'], 'create')
        self.assertNotIn('request', created)
        self.assertTrue(all('status' not in item for item in created['items']))
        snapshot.update(plan={'plan_id': created['plan_id'], 'revision': 1},
                        items=[{**item, 'status': 'pending'} for item in created['items']],
                        actions={'materials': ['start']})
        started = build_transition(snapshot, 'materials', 'in_progress', protocol='flat')
        self.assertEqual(started['operation'], 'start')
        self.assertEqual(started['step_ids'], ['materials'])
        self.assertEqual(started['expected_revision'], 1)
        self.assertNotIn('items', started)
        snapshot['plan']['revision'] = 4
        snapshot['turn_id'] = 'fresh-turn'
        retried = build_transition(snapshot, 'materials', 'in_progress', protocol='flat')
        self.assertEqual(retried['expected_revision'], 4)
        self.assertEqual(retried['turn_id'], 'fresh-turn')
        self.assertNotEqual(retried['request_id'], started['request_id'])
        legacy = build_transition(snapshot, 'materials', 'in_progress', protocol='legacy')
        self.assertEqual(legacy['operation'], 'write')
        self.assertIn('request', legacy)
        snapshot['items'][0]['status'] = 'in_progress'
        with self.assertRaisesRegex(ValueError, 'already'):
            build_transition(snapshot, 'materials', 'in_progress', protocol='flat')

    def test_flat_boundary_finishes_only_then_requires_fresh_read(self):
        snapshot = {'ok': True, 'turn_id': 'turn', 'plan': {'plan_id': 'plan', 'revision': 9},
                    'items': [{'id': 'materials', 'status': 'in_progress', 'kind': 'step'},
                              {'id': 'evidence', 'status': 'pending', 'kind': 'step'}],
                    'actions': {'materials': ['finish', 'pause'], 'evidence': ['start']}}
        result = build_transition(snapshot, 'evidence', 'in_progress', complete='materials', protocol='flat')
        self.assertEqual(result['operation'], 'finish')
        self.assertEqual(result['step_ids'], ['materials'])
        self.assertEqual(result['expected_revision'], 9)
        with self.assertRaisesRegex(ValueError, 'allowed'):
            build_transition(snapshot, 'evidence', 'completed', protocol='flat')
        paused = build_transition(snapshot, 'materials', 'needs_confirmation', protocol='flat')
        self.assertEqual(paused['operation'], 'pause')
        with self.assertRaisesRegex(ValueError, 'protocol'):
            build_transition(snapshot, 'materials', 'completed', protocol='unknown')

    def test_flat_group_finishes_after_all_children_complete(self):
        snapshot = {'ok': True, 'turn_id': 'turn', 'plan': {'plan_id': 'plan', 'revision': 3},
                    'items': [{'id': 'parent', 'status': 'in_progress', 'kind': 'group'},
                              {'id': 'child', 'parent_id': 'parent', 'status': 'completed', 'kind': 'step'}],
                    'actions': {'parent': ['finish']}}
        result = build_transition(snapshot, 'parent', 'completed')
        self.assertEqual(result['operation'], 'finish')
        self.assertEqual(result['step_ids'], ['parent'])
        snapshot['items'][1]['status'] = 'pending'
        with self.assertRaisesRegex(ValueError, 'children'):
            build_transition(snapshot, 'parent', 'completed')
        snapshot['items'].pop()
        with self.assertRaisesRegex(ValueError, 'children'):
            build_transition(snapshot, 'parent', 'completed')

    def test_progress_cli_emits_the_actual_host_arguments(self):
        snapshot = {"ok": True, "turn_id": "actual-turn", "plan": None, "items": []}
        with tempfile.TemporaryDirectory() as folder:
            configure(Path(folder), {"intent": "Review supplied evidence."})
            request = Path(folder) / "get.json"
            request.write_text(json.dumps(snapshot))
            result = subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/slr.py"),
                    "progress",
                    "--protocol",
                    "legacy",
                    "--workspace",
                    folder,
                    "--request",
                    str(request),
                    "--item-id",
                    "materials",
                    "--state",
                    "in_progress",
                ],
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(set(payload), {"operation", "request"})
        self.assertEqual(payload["request"]["turn_id"], "actual-turn")

    def test_plan_payload_preserves_tree_and_rejects_retroactive_completion(self):
        snapshot = {"ok": True, "turn_id": "actual-turn", "plan": None, "items": []}
        created = transition(snapshot, "materials", "in_progress")
        request = created["request"]
        self.assertEqual(request["operation"], "create")
        self.assertEqual(len(request["items"]), 4)
        self.assertTrue(
            all(item["kind"] == "step" and item["parent_id"] is None for item in request["items"])
        )
        snapshot.update(
            plan={"plan_id": request["plan_id"], "revision": 1, "started_ids": ["materials"]},
            items=request["items"],
        )
        before = copy.deepcopy(snapshot)
        completed = transition(
            [{"type": "inputText", "text": json.dumps(snapshot)}], "materials", "completed"
        )
        self.assertEqual(completed["request"]["expected_revision"], 1)
        self.assertEqual(completed["request"]["turn_id"], "actual-turn")
        self.assertEqual(completed["request"]["items"][1:], request["items"][1:])
        self.assertEqual(snapshot, before)
        boundary = transition(snapshot, "evidence", "in_progress", complete="materials")["request"]
        self.assertEqual(boundary["items"][0]["status"], "completed")
        self.assertEqual(boundary["items"][1]["status"], "in_progress")
        self.assertEqual(boundary["expected_revision"], 1)
        with self.assertRaisesRegex(ValueError, "start"):
            transition(snapshot, "evidence", "completed")

    def test_existing_parent_links_and_unknown_metadata_are_preserved_at_the_boundary(self):
        snapshot = {
            "ok": True,
            "turn_id": "new-turn",
            "plan": {"plan_id": "existing", "revision": 7, "started_ids": ["child"]},
            "items": [
                {
                    "id": "parent",
                    "content": "Existing task",
                    "kind": "group",
                    "parent_id": None,
                    "status": "in_progress",
                },
                {
                    "id": "child",
                    "content": "Existing work",
                    "kind": "step",
                    "parent_id": "parent",
                    "status": "in_progress",
                },
            ],
        }
        request = transition(snapshot, "child", "completed")["request"]
        self.assertEqual(request["items"][0], snapshot["items"][0])
        self.assertEqual(request["items"][1]["parent_id"], "parent")
        self.assertEqual(request["plan_id"], "existing")
        self.assertEqual(request["turn_id"], "new-turn")
        with self.assertRaisesRegex(ValueError, "children"):
            transition(snapshot, "parent", "completed")

    def test_wait_is_bounded_and_technical_errors_propagate(self):
        waiting = {"figure_id": "F1", "status": "WAITING", "missing_sections": ["2"]}
        ready = {"figure_id": "F1", "status": "READY", "sections": [{"body_md": "Actual text"}]}
        with (
            patch("figure_dependencies.context", side_effect=[waiting, ready]),
            patch("figure_dependencies.time.monotonic", side_effect=[0, 0]),
            patch("figure_dependencies.time.sleep") as sleep,
        ):
            result = wait_contexts(Path("."), ["F1"], 1)
        self.assertEqual(result["status"], "READY")
        sleep.assert_called_once()
        with (
            patch("figure_dependencies.context", return_value=waiting),
            patch("figure_dependencies.time.monotonic", side_effect=[0, 1]),
        ):
            self.assertEqual(wait_contexts(Path("."), ["F1"], 1)["status"], "WAITING")
        with patch("figure_dependencies.context", side_effect=ValueError("invalid binding")):
            with self.assertRaisesRegex(ValueError, "invalid binding"):
                wait_contexts(Path("."), ["F1"], 1)

    @unittest.skipUnless(shutil.which("xelatex"), "XeLaTeX unavailable")
    def test_native_tree_has_real_pixels_and_resolved_citations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "figures").mkdir()
            (root / "figures/F1.tex").write_text(
                r"\begin{forest} for tree={draw} [Root [Left \citep{Key}] [Right]]\end{forest}"
            )
            (root / "citations.bib").write_text(
                "@article{Key,author={Ada Author},title={Evidence},year={2024},journal={Journal}}"
            )
            resolver = CitationResolver(
                parse_bib_file(root / "citations.bib"), "numeric", "english"
            )
            resolver.collect(r"\cite{Key}")
            rendered, records = render_trees("![Figure 1](figures/F1.tex)", root, resolver,
                                             image_box=(432, 637))
            self.assertIn("figures/F1.png", rendered)
            self.assertTrue((root / "figures/F1.png").is_file())
            self.assertEqual(records[0]["pages"], 1)
            self.assertGreater(records[0]["width"], 10)
            self.assertGreater(records[0]["height"], 10)
            self.assertGreaterEqual(records[0]['projected_label_points'], 7)
            self.assertNotIn(r"\cite", (root / "figures/_native/F1/figure.tex").read_text())
            export_word(rendered, root, root / "tree.docx", "english")
            with zipfile.ZipFile(root / "tree.docx") as archive:
                self.assertTrue(any(name.startswith("word/media/") for name in archive.namelist()))
                self.assertIn(b"<w:drawing>", archive.read("word/document.xml"))

    @unittest.skipUnless(shutil.which('xelatex'), 'XeLaTeX unavailable')
    def test_native_tree_rejects_labels_that_become_tiny_at_document_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'figures').mkdir()
            (root / 'figures/wide.tex').write_text(
                r'\begin{forest} for tree={draw,minimum width=1200pt} [Complete evidence]\end{forest}')
            resolver = CitationResolver({}, 'numeric', 'english')
            with self.assertRaises(GenerationError) as caught:
                render_trees('![Figure 1](figures/wide.tex)', root, resolver, image_box=(432, 637))
            self.assertEqual(caught.exception.code, 'FIGURE_LABELS_TOO_SMALL')
            self.assertFalse((root / 'figures/wide.png').exists())


if __name__ == "__main__":
    unittest.main()
