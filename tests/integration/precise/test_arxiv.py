from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

from arxiv import normalize_arxiv_id
from normalize import normalize_paper
from open_download_preflight import paper_arxiv_id, route_selection

ROOT = Path(__file__).resolve().parents[3]
ADAPTER_PATH = ROOT / "skills/community/precise-literature-search/modules/open-download/adapter.py"
ADAPTER_SPEC = importlib.util.spec_from_file_location("open_downloader_arxiv", ADAPTER_PATH)
adapter = importlib.util.module_from_spec(ADAPTER_SPEC)
ADAPTER_SPEC.loader.exec_module(adapter)
PAID_SPEC = importlib.util.spec_from_file_location(
    "paid_downloader_arxiv", ADAPTER_PATH.parents[1] / "paid-download/adapter.py"
)
paid_adapter = importlib.util.module_from_spec(PAID_SPEC)
PAID_SPEC.loader.exec_module(paid_adapter)

VALID_IDENTIFIERS = (
    ("2509.23927v1", "2509.23927v1"),
    (" arXiv:2509.23927v1 ", "2509.23927v1"),
    ("https://arxiv.org/html/2509.23927v1?source=web#S1", "2509.23927v1"),
    ("arXiv:https://arxiv.org/html/2509.23927v1", "2509.23927v1"),
    ("https://arxiv.org/pdf/2509.23927v1.pdf?download=1", "2509.23927v1"),
    ("https://arxiv.org/abs/hep-th/9901001v2", "hep-th/9901001v2"),
    ("math.GT/0309136", "math.GT/0309136"),
    ("https://ARXIV.ORG:443/abs/1706.03762", "1706.03762"),
)
INVALID_IDENTIFIERS = (
    None,
    12345,
    "",
    "not-an-id",
    "2301.123456",
    "10.1000/example",
    "https://export.arxiv.org/abs/2301.12345",
    "2509.23927/extra",
    "2509.23927v0",
    "2509. 23927",
    "https://example.org/html/2509.23927v1",
    "https://example.org/arxiv.org/html/2509.23927v1",
    "https://arxiv.org.evil.org/abs/2509.23927v1",
    "https://arxiv.org/other/2509.23927v1",
    "https://arxiv.org/html/not-an-id",
    "https://arxiv.org:bad/html/2509.23927v1",
    "https://arxiv.org:8080/abs/2509.23927v1",
    "https://user:password@arxiv.org/abs/2509.23927v1",
    "https://[broken/html/2509.23927v1",
    "file:///abs/2509.23927v1",
    "//arxiv.org/abs/2509.23927v1",
)


class ArxivIdentityTests(unittest.TestCase):
    def test_paid_adapter_uses_shared_identity_without_changing_authorization(self):
        for value, expected in VALID_IDENTIFIERS:
            with self.subTest(value=value):
                paper = {"arxiv_id": value}
                self.assertEqual(paid_adapter.paper_arxiv_id(paper), expected)
                self.assertEqual(
                    paid_adapter.paper_action_url(paper), f"https://arxiv.org/abs/{expected}"
                )
        for value in (*INVALID_IDENTIFIERS, "arxiv.org/abs/2401.12345"):
            with self.subTest(value=value):
                paper = {"arxiv_id": value}
                self.assertIsNone(paid_adapter.paper_arxiv_id(paper))
                self.assertIsNone(paid_adapter.paper_action_url(paper))
        self.assertFalse(paid_adapter.paid_pending({"status": "skipped"}))
        self.assertTrue(paid_adapter.paid_pending({"status": "failed"}))

    def test_preflight_uses_the_shared_identifier_contract(self):
        for value, expected in VALID_IDENTIFIERS:
            for paper in ({"arxiv_id": value}, {"external_ids": {"ArXiv": value}}):
                with self.subTest(paper=paper):
                    self.assertEqual(paper_arxiv_id(paper), expected)
                    self.assertEqual(paper_arxiv_id(paper), adapter.paper_arxiv_id(paper))
        selection = {"run_id": "run", "selected_paper_ids": ["paper"], "download_open": True}
        for value in INVALID_IDENTIFIERS:
            with self.subTest(value=value):
                paper = {"id": "paper", "title": "Candidate", "arxiv_id": value}
                self.assertIsNone(paper_arxiv_id(paper))
                route, manifest = route_selection(selection, {"papers": [paper]})
                self.assertEqual(route["next_action"], "post_open_gate")
                self.assertEqual(manifest["papers"][0]["status"], "skipped")
                paper["doi"] = "10.1000/example"
                route, manifest = route_selection(selection, {"papers": [paper]})
                self.assertEqual(route["next_action"], "run_open_download")
                self.assertIsNone(manifest)

    def test_search_and_download_share_versioned_identity(self):
        for value, expected in VALID_IDENTIFIERS:
            fields = ({"arxiv_id": value}, {"external_ids": {"ArXiv": value}})
            if value.startswith("https://"):
                fields += ({"url": value}, {"pdf_url": value})
            for metadata in fields:
                with self.subTest(value=value, metadata=metadata):
                    paper = normalize_paper({"title": "Candidate", **metadata}, source="web")
                    self.assertEqual(paper["arxiv_id"], expected)
                    self.assertEqual(paper["id"], f"arxiv:{expected.casefold()}")
                    self.assertEqual(adapter.managed_source_label(paper), f"arXiv:{expected}")

    def test_invalid_identifiers_cannot_form_download_requests(self):
        for value in INVALID_IDENTIFIERS:
            with self.subTest(value=value):
                self.assertIsNone(normalize_arxiv_id(value))
                self.assertIsNone(adapter.paper_arxiv_id({"arxiv_id": value}))
                paper = normalize_paper({"title": "Candidate", "arxiv_id": value}, source="web")
                self.assertIsNone(paper.get("arxiv_id"))
                self.assertFalse(paper["id"].startswith("arxiv:"))

    def test_invalid_urls_do_not_create_arxiv_identities(self):
        for value in INVALID_IDENTIFIERS:
            if not isinstance(value, str) or not value.startswith("https://"):
                continue
            with self.subTest(url=value):
                paper = normalize_paper({"title": "Candidate", "url": value}, source="web")
                self.assertIsNone(paper.get("arxiv_id"))
                self.assertFalse(paper["id"].startswith("arxiv:"))
