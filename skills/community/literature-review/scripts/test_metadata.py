"""Optional issue/page metadata must not become publication requirements."""

import json
import re
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote

from generation.citation_formats import CitationResolver, parse_bib_text
from citation_styles import CITATION_STYLES
from generation._fast._utils import render_bibtex_entry
from processing.audit_citation_metadata import audit
from publication_style import metadata_check
from retrieval.adapt_search_output import to_corpus_record
from search_metadata_eligibility import bibliography_preflight

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
    def test_structured_family_and_literal_author_survive_bibliography_rendering(self):
        meta = {'title': 'A metadata example', 'year': 2024, 'journal_name': 'ArXiv',
                'venue': {'name': 'An unrelated container'}, 'urldate': '2026-10-30',
                'authors': [{'name': 'Jane van der Meer', 'given': 'Jane', 'family': 'van der Meer'},
                            {'name': 'Research and Learning Lab', 'literal': True}]}
        text = render_bibtex_entry('Key', meta)
        entry = parse_bib_text(text)['Key']
        self.assertEqual(entry.authors, [('Jane', 'van der Meer'), ('', 'Research and Learning Lab')])
        self.assertEqual(entry.venue, 'ArXiv')
        self.assertEqual(entry.fields['urldate'], '2026-10-30')
        self.assertTrue(text.startswith('@Article{'))
        self.assertTrue(render_bibtex_entry('Key', meta, verified_type='InProceedings').startswith('@InProceedings{'))

    def test_access_dates_work_for_compact_entries_without_changing_existing_facts(self):
        raw = '@misc{Old, title={Literal {urldate = not a field}}, author={Ada Author}, year={2019}}'
        meta = {'citationStyles': {'bibtex': raw}, 'urldate': '2026-10-30'}
        entry = parse_bib_text(render_bibtex_entry('Key', meta))['Key']
        self.assertEqual(entry.fields['urldate'], '2026-10-30')
        self.assertEqual(entry.year, '2019')
        meta['citationStyles']['bibtex'] = raw[:-1] + ', accessed={2020-01-02}}'
        entry = parse_bib_text(render_bibtex_entry('Key', meta))['Key']
        self.assertEqual(entry.fields['urldate'], '2020-01-02')
        self.assertNotIn('accessed', entry.fields)

    def test_markdown_references_retain_structured_metadata_for_every_style(self):
        entries = parse_bib_text(bibliography(BASE_FIELDS))
        for style in ("gbt7714_2025", "numeric", "ieee", "acm", "author_year"):
            resolver = CitationResolver(entries, style)
            resolver.collect(r"\cite{Example}")
            rendered = "\n".join(resolver.reference_lines())
            encoded = re.search(r'data-scholarseed-reference="([^"]+)"', rendered)
            self.assertIsNotNone(encoded, style)
            metadata = json.loads(unquote(encoded[1]))
            self.assertEqual(metadata["version"], 1)
            self.assertEqual(metadata["title"], BASE_FIELDS["title"])
            self.assertEqual(metadata["authors"], "Alice Smith")
            self.assertEqual(metadata["year"], "2024")
            self.assertEqual(metadata["url"], BASE_FIELDS["url"])
            self.assertIn('id="ref-Example"', rendered)

    def test_library_fields_follow_the_same_corpus_and_bibliography_contract(self):
        paper = {"paper_id": "literature:one", "title": "Metadata evidence",
                 "authors": ["Ada Author", "李明"], "year": 2024,
                 "author_metadata": {"raw": ["Ada Author", "李明"], "format": "structured"},
                 "abstract": "Source abstract.", "venue": "Research", "source": "project_library",
                 "library_refs": ["literature:one"], "address": "Beijing", "isbn": "123",
                 "volume": "12", "number": "3", "pages": "45--60", "publisher": "Press",
                 "citation_key": "original-key", "bib_type": "book",
                 "metadata_completion": {"status": "completed", "source": "arxiv"}}
        record = to_corpus_record(paper["paper_id"], paper)
        self.assertEqual(record["authors"], [{"name": "Ada Author"}, {"name": "李明"}])
        self.assertEqual(bibliography_preflight({paper["paper_id"]: record})["status"], "SUCCESS")
        for field in ("address", "isbn", "volume", "number", "pages", "publisher",
                      "library_refs", "citation_key", "bib_type", "metadata_completion"):
            self.assertEqual(record[field], paper[field])
        text = render_bibtex_entry("ExistingKey", record)
        self.assertIn("Ada Author and 李明", text)
        self.assertIn("address = {Beijing}", text)
        self.assertIn("isbn = {123}", text)
        self.assertIn("@Article{ExistingKey", text)  # Existing entry-type policy stays unchanged.

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
