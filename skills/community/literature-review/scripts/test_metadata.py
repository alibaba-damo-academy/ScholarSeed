"""Optional issue/page metadata must not become publication requirements."""

import tempfile
import unittest
from pathlib import Path

from citation_formats import CitationResolver, parse_bib_text
from citation_styles import CITATION_STYLES
from generation._fast._utils import render_bibtex_entry
from processing.audit_citation_metadata import audit
from publication_style import metadata_check
from retrieval.adapt_search_output import to_corpus_record

STYLE = "gbt7714_2025"
OPTIONAL_FIELDS = {"number", "pages"}
BASE_FIELDS = {
    "author": "Alice Smith",
    "title": "Metadata evidence",
    "year": "2024",
    "journal": "Research",
    "volume": "12",
    "booktitle": "Proceedings",
    "address": "Beijing",
    "publisher": "Press",
    "doi": "10.5555/example",
    "url": "https://example.org/paper",
    "urldate": "2026-10-21",
}


def bibliography(fields, entry_type="article"):
    values = ",\n".join(f"{name} = {{{value}}}" for name, value in fields.items())
    return f"@{entry_type}{{Example,\n{values}\n}}\n"


class MetadataTest(unittest.TestCase):
    def test_optional_fields_do_not_affect_audit_or_publication(self):
        for entry_type in ("article", "inproceedings", "conference", "misc", "online"):
            with self.subTest(entry_type=entry_type), tempfile.TemporaryDirectory() as folder:
                workspace = Path(folder)
                processing = workspace / "03_process"
                generation = workspace / "05_generation"
                processing.mkdir()
                generation.mkdir()
                source = generation / "review.tex"
                baseline = None
                for optional in (
                    {},
                    {"number": "3"},
                    {"pages": "45--60"},
                    {"number": "3", "pages": "45--60"},
                ):
                    with self.subTest(optional=optional):
                        text = bibliography(BASE_FIELDS | optional, entry_type)
                        (processing / "references.bib").write_text(text, encoding="utf-8")
                        (generation / "citations.bib").write_text(text, encoding="utf-8")
                        styles = audit(workspace)["styles"]
                        for style, report in styles.items():
                            self.assertEqual(report["minimum_ready_percent"], 100, style)
                            self.assertEqual(report["fully_populated_percent"], 100, style)
                            self.assertEqual(report["incomplete_entries"], [], style)
                        if baseline is None:
                            baseline = styles
                        self.assertEqual(styles, baseline)
                        checks = metadata_check(source, {"citation_style": STYLE})
                        self.assertEqual(checks[0]["status"], "SUCCESS")
                        self.assertEqual(checks[0]["incomplete_entries"], [])

    def test_other_required_and_recommended_fields_still_report(self):
        for missing in ("title", "volume"):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as folder:
                workspace = Path(folder)
                processing = workspace / "03_process"
                generation = workspace / "05_generation"
                processing.mkdir()
                generation.mkdir()
                fields = {name: value for name, value in BASE_FIELDS.items() if name != missing}
                text = bibliography(fields)
                (processing / "references.bib").write_text(text, encoding="utf-8")
                (generation / "citations.bib").write_text(text, encoding="utf-8")
                report = audit(workspace)["styles"][STYLE]
                self.assertEqual(report["fully_populated_percent"], 0)
                self.assertEqual(report["minimum_ready_percent"], 0 if missing == "title" else 100)
                incomplete = report["incomplete_entries"][0]
                self.assertEqual(
                    incomplete["missing_required"] + incomplete["missing_recommended"], [missing]
                )
                checks = metadata_check(generation / "review.tex", {"citation_style": STYLE})
                self.assertEqual(checks[0]["status"], "WARNING")
                self.assertEqual(checks[0]["incomplete_entries"][0]["missing"], [missing])

    def test_optional_fields_are_not_style_critical(self):
        for style, spec in CITATION_STYLES.items():
            fields = {
                field for expression in spec["style_critical"] for field in expression.split("|")
            }
            self.assertTrue(OPTIONAL_FIELDS.isdisjoint(fields), style)

    def test_provided_fields_survive_import_bibtex_and_rendering(self):
        paper = {
            "title": BASE_FIELDS["title"],
            "authors": [BASE_FIELDS["author"]],
            "year": 2024,
            "journal_name": BASE_FIELDS["journal"],
            "journal_volume": BASE_FIELDS["volume"],
            "journal_pages": "45--60",
            "number": "3",
        }
        record = to_corpus_record("example", paper)
        self.assertEqual(record["pages"], "45--60")
        self.assertEqual(record["number"], "3")
        text = render_bibtex_entry("Example", record)
        entries = parse_bib_text(text)
        self.assertEqual(entries["Example"].fields["pages"], "45--60")
        self.assertEqual(entries["Example"].fields["number"], "3")
        for style in (STYLE, "ieee", "acm"):
            rendered = CitationResolver(entries, style).render_entry(entries["Example"], 1)
            self.assertIn("45–60", rendered)
            self.assertIn("(3)" if style == STYLE else "no. 3", rendered)
        paper.pop("journal_pages")
        paper.pop("number")
        empty = parse_bib_text(render_bibtex_entry("Example", to_corpus_record("example", paper)))
        self.assertTrue(OPTIONAL_FIELDS.isdisjoint(empty["Example"].fields))


if __name__ == "__main__":
    unittest.main()
