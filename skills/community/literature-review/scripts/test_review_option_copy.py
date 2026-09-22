"""User-facing publication choices stay concise in both languages."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from publication import publication_options

ROOT = Path(__file__).resolve().parents[1]


class ReviewOptionCopyTest(unittest.TestCase):
    def test_options_in_both_languages(self):
        templates = [
            {"id": "ctexart", "language": "CHINESE", "status": "installed"},
            {"id": "neurips", "language": "ENGLISH", "status": "installed"},
        ]
        styles = {
            sid: {"minimum_ready": 2, "entries": 2, "metadata_risk": "PaperHub internal detail"}
            for sid in ("numeric", "author_year", "ieee", "acm")
        }
        for language in ("CHINESE", "ENGLISH"):
            with self.subTest(language=language), tempfile.TemporaryDirectory() as folder:
                ws = Path(folder)
                (ws / "03_process").mkdir()
                (ws / "03_process/references.bib").write_text("")
                with (
                    patch("publication.read_request", return_value={"language": language}),
                    patch("publication.publication_view", return_value={"format": "latex_pdf"}),
                    patch("publication.list_templates", return_value=templates),
                    patch("publication.resolve_citation_style", return_value={"available": True}),
                    patch("publication.audit", return_value={"styles": styles}),
                    patch("publication.shutil.which", return_value="/bin/tool"),
                    patch("subprocess.run") as run,
                ):
                    run.return_value.returncode = 0
                    run.return_value.stdout = "ctexart.cls"
                    options = publication_options(ws)
                self.assertEqual(len(options["templates"]), 1)
                self.assertEqual(
                    options["templates"][0]["title"], options["format_labels"]["latex_pdf"]
                )
                self.assertEqual(len(options["citation_styles"]), 4)
                visible = [options["format_labels"][key] for key in options["formats"]]
                visible += [row["label"] for row in options["citation_styles"]]
                self.assertFalse(
                    any(
                        "PaperHub" in label or "ctexart" in label or "LaTeX" in label
                        for label in visible
                    )
                )
                self.assertEqual(
                    options["citation_styles"][2]["label"],
                    (
                        "IEEE 编号条目（含卷期页），条目信息可能存在不完整。"
                        if language == "CHINESE"
                        else "IEEE numbered references (including volume, issue, and pages); some entry details may be incomplete."
                    ),
                )
                self.assertNotIn("metadata_risk", options["citation_styles"][2]["metadata"])


if __name__ == "__main__":
    unittest.main()
