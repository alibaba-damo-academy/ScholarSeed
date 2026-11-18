#!/usr/bin/env scholarseed-skill-python
"""Explicit document constraints survive current native authoring."""

import json
import tempfile
import unittest
from pathlib import Path

import test_native_pipeline as native
from manuscript import prepare
from manuscript_publication import publish
from task_contract import atomic_json, configure
from task_fixtures import task
from writing_contract import explicit_length_budget


class ExplicitLengthTest(unittest.TestCase):
    def test_explicit_unit_aliases_and_unknown_unit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "01_input").mkdir()
            req = root / "01_input/writing_request.json"
            for unit in ("words", "cjk_chars", "characters", "pages"):
                req.write_text(json.dumps(task({"length_min": 6, "length_unit": unit})))
                self.assertEqual(explicit_length_budget(root)["unit"], unit)
            req.write_text(json.dumps({**task(), "length_unit": "mystery"}))
            with self.assertRaisesRegex(ValueError, "invalid length_unit"):
                explicit_length_budget(root)

    def test_short_valid_deliverable_has_no_inferred_size_floor(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            atomic_json(root / "01_input/writing_request.json", task())
            (root / "05_generation").mkdir()
            doc = root / "05_generation/full_draft_v2.md"
            doc.write_text("# Methods\n\nConditional assumptions matter.\n")
            report = publish(root)
            self.assertEqual(report["status"], "SUCCESS")
            self.assertEqual(Path(report["deliverable"]).read_text(), doc.read_text())

    def test_current_packets_preserve_explicit_document_bounds_without_local_quotas(self):
        for bounds in ({}, {"length_target": 12000, "length_min": 10800, "length_unit": "words"}):
            with self.subTest(bounds=bounds):
                fixture = native.NativeTest()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                configure(fixture.ws, bounds)
                prepare(fixture.ws)
                for path in (fixture.ws / "05_generation/_internal/chapter_packets").glob("*.json"):
                    packet = json.loads(path.read_text())
                    self.assertFalse(
                        {"length_target", "length_min", "length_max", "bridge_target"} & set(packet)
                    )
                    for key, value in bounds.items():
                        self.assertEqual(packet["task"]["explicit_length_bounds"][key], value)


if __name__ == "__main__":
    unittest.main()
