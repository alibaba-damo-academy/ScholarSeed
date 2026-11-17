from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.ci.docs.check import check

ROOT = Path(__file__).resolve().parents[4]
NODE = shutil.which("node")


class PublicEngineeringTests(unittest.TestCase):
    def test_public_documents_resolve_from_the_source_checkout(self):
        self.assertIsNotNone(NODE)
        report = check(ROOT, Path(NODE))
        self.assertEqual(report["errors"], [])
        self.assertIn("AGENTS.md", report["paths"])
        self.assertIn("docs/index.md", report["paths"])

    def test_document_structure_resolves_without_private_host_skills(self):
        self.assertIsNotNone(NODE)
        result = subprocess.run(
            [
                NODE,
                "scripts/ci/docs/structure-check.mjs",
                "AGENTS.md",
                "docs/index.md",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["errors"], [])

    def test_a_private_parent_cannot_supply_a_missing_public_entry(self):
        self.assertIsNotNone(NODE)
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve()
            (parent / "AGENTS.md").write_text("# Private parent\n", encoding="utf-8")
            product = parent / "product"
            product.mkdir()
            (product / "docs").mkdir()
            (product / "docs/index.md").write_text("# Index\n", encoding="utf-8")
            (product / "pyproject.toml").write_text(
                "[tool.uv.workspace]\nmembers = []\n", encoding="utf-8"
            )
            report = check(product, Path(NODE), required=("AGENTS.md",))
            self.assertTrue(any("AGENTS.md" in error for error in report["errors"]))


if __name__ == "__main__":
    unittest.main()
