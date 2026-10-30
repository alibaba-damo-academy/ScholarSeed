"""External evidence is additive and verified; PaperHub is not an admission gate."""

import io
import json
import queue
import sys
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "skills/community/fast-search/tools"))
import appserver_quick  # noqa: E402  (bundled skill tools are standalone scripts)
import external_metadata as external  # noqa: E402  (bundled skill tools are standalone scripts)
import quick_search  # noqa: E402  (bundled skill tools are standalone scripts)

DOI = "10.1038/s41586-026-11044-y"
TITLE = "Reimagining research papers as interactive and reliable AI agents"
URL = "https://www.nature.com/articles/s41586-026-11044-y?utm_source=chatgpt.com"


def record():
    return external._record(
        TITLE,
        ["Jiacheng Miao"],
        URL.split("?")[0],
        "crossref",
        doi=DOI,
        date="2026-09-16",
        venue="Nature",
    )


def crossref(**updates):
    item = {
        "DOI": DOI,
        "title": [TITLE],
        "type": "journal-article",
        "author": [{"given": "Jiacheng", "family": "Miao"}],
        "published-online": {"date-parts": [[2026, 9, 16]]},
        "container-title": ["Nature"],
        "abstract": "MUST NOT PERSIST",
    }
    item.update(updates)
    return json.dumps({"message": item}).encode()


class VerificationTests(unittest.TestCase):
    def test_crossref_copies_only_bibliographic_fields(self):
        paper = external.crossref_record(crossref(), DOI)
        self.assertEqual(paper["doi"], DOI)
        self.assertEqual(paper["publication_date"], "2026-09-16")
        self.assertEqual(paper["authors"], ["Jiacheng Miao"])
        self.assertTrue(paper["paper_id"].startswith("external:"))
        self.assertNotIn("MUST NOT PERSIST", json.dumps(paper))
        self.assertNotIn("citation_count", paper)

    def test_crossref_rejects_wrong_doi_and_nonpaper(self):
        for changes in ({"DOI": "10.1234/other"}, {"type": "dataset"}):
            with self.assertRaises(ValueError):
                external.crossref_record(crossref(**changes), DOI)

    def test_missing_date_is_not_fabricated(self):
        paper = external.crossref_record(crossref(**{"published-online": {}}), DOI)
        self.assertNotIn("year", paper)
        self.assertNotIn("publication_date", paper)

    def test_scholarly_tags_work_without_doi(self):
        html = b'<meta name="citation_title" content="A &amp; B"><meta name="citation_author" content="One Author"><meta name="citation_date" content="2026/09/16"><meta name="description" content="MUST NOT PERSIST">'
        paper = external.page_record(html, "https://publisher.example/paper/42")
        self.assertEqual(paper["title"], "A & B")
        self.assertEqual(paper["year"], 2026)
        self.assertNotIn("doi", paper)
        self.assertNotIn("MUST NOT PERSIST", json.dumps(paper))

    def test_ordinary_webpage_is_not_a_paper(self):
        for html in (
            b'<title>Paper news</title><meta property="og:title" content="Paper">',
            b'<meta name="citation_title" content="Paper">',
        ):
            with self.assertRaises(ValueError):
                external.page_record(html, "https://example.org/news")

    def test_topic_evidence_must_match_exact_title(self):
        with patch.object(external, "fetch", return_value=(crossref(), "", "application/json")):
            with self.assertRaisesRegex(ValueError, "title does not match"):
                external.resolve({"title": "A different paper", "url": URL}, time.monotonic() + 1)

    def test_direct_doi_can_resolve_title_without_agent_guess(self):
        with patch.object(
            external, "fetch", return_value=(crossref(), "", "application/json")
        ) as fetch:
            paper = external.resolve(
                {"title": "", "url": URL, "required": True}, time.monotonic() + 1
            )
        self.assertEqual(paper["title"], TITLE)
        self.assertEqual(fetch.call_count, 1)

    def test_page_identifier_conflict_rejected(self):
        html = b'<meta name="citation_title" content="A paper"><meta name="citation_author" content="Author"><meta name="citation_doi" content="10.1234/wrong">'
        with patch.object(
            external, "fetch", side_effect=[ValueError("unavailable"), (html, URL, "text/html")]
        ):
            with self.assertRaisesRegex(ValueError, "conflict"):
                external.resolve({"title": "", "url": URL, "required": True}, time.monotonic() + 1)

    def test_public_ip_is_pinned_and_private_or_mixed_dns_rejected(self):
        for ips in (["127.0.0.1"], ["169.254.169.254"], ["1.1.1.1", "10.0.0.1"], ["::1"]):
            addresses = [(None, None, None, None, (ip, 443)) for ip in ips]
            with (
                patch.object(external.socket, "getaddrinfo", return_value=addresses),
                patch.object(external.socket, "create_connection") as connect,
            ):
                with self.assertRaises(ValueError):
                    external._PublicHTTPS("example.org").connect()
                connect.assert_not_called()
        with (
            patch.object(
                external.socket,
                "getaddrinfo",
                return_value=[(None, None, None, None, ("1.1.1.1", 443))],
            ),
            patch.object(external.socket, "create_connection") as connect,
        ):
            connection = external._PublicHTTPS("example.org")
            with patch.object(connection._context, "wrap_socket") as tls:
                connection.connect()
            self.assertEqual(connect.call_args.args[0], ("1.1.1.1", 443))
            self.assertEqual(tls.call_args.kwargs["server_hostname"], "example.org")

    def test_urls_with_credentials_ports_and_non_web_schemes_rejected(self):
        for url in (
            "file:///etc/passwd",
            "https://user:pass@example.org/",
            "https://example.org:8443/x",
        ):
            with self.assertRaises(ValueError):
                external._valid_url(url)

    def test_deadline_keeps_finished_records_and_reports_unfinished(self):
        results = queue.Queue()
        results.put((0, record(), "verified"))
        papers, audit = external.finish(
            ([{"url": URL}, {"url": "https://example.org"}], results, time.monotonic() - 1)
        )
        self.assertEqual(len(papers), 1)
        self.assertEqual([a["status"] for a in audit], ["verified", "timeout"])

    def test_topic_without_web_evidence_starts_no_network(self):
        plan = {"queries": [{"mode": "title", "query": TITLE}]}
        requests = external.requests_for_plan(plan, "AI research agents", "", False)
        with patch.object(external.threading, "Thread") as thread:
            self.assertEqual(external.finish(external.start(requests)), ([], []))
            thread.assert_not_called()

    def test_optional_bad_evidence_cannot_break_paperhub_retrieval(self):
        plan = {
            "queries": [{"mode": "title", "query": TITLE}],
            "web_papers": [
                {"title": "Dropped ninth title", "url": URL},
                {"title": TITLE, "url": "file:///private/data"},
                "malformed",
            ],
        }
        self.assertEqual(external.requests_for_plan(plan, "topic", "", False), [])
        self.assertEqual(plan["web_papers_ignored_count"], 3)

    def test_web_evidence_is_bounded_and_plan_has_no_extra_claims(self):
        plan = {
            "queries": [{"mode": "title", "query": TITLE}],
            "web_papers": [
                {
                    "title": TITLE,
                    "url": URL,
                    "abstract": "MUST NOT PERSIST",
                    "authors": ["Invented"],
                }
            ]
            * 10,
        }
        requests = external.requests_for_plan(plan, URL, TITLE, True)
        self.assertEqual(len(requests), 1)
        self.assertEqual(len(plan["web_papers"]), external.MAX_CANDIDATES)
        self.assertNotIn("MUST NOT PERSIST", json.dumps(plan))
        self.assertNotIn("Invented", json.dumps(plan))

    def test_preprint_doi_is_not_reused_for_journal_record(self):
        preprint = {
            "paper_id": "281202937",
            "title": TITLE,
            "doi": "10.48550/arXiv.2509.06917",
            "year": 2025,
        }
        combined, added = external.merge_missing([preprint], [record()])
        self.assertEqual(added, 1)
        self.assertEqual(combined[0], preprint)
        self.assertEqual(combined[1]["doi"], DOI)
        self.assertNotEqual(combined[1]["paper_id"], preprint["paper_id"])

    def test_arxiv_doi_still_resolves_arxiv_identity(self):
        self.assertTrue(
            external.paper_identity.identifier_match(
                {"doi": "10.48550/arXiv.1706.03762"}, "https://arxiv.org/abs/1706.03762"
            )
        )

    def test_matching_paperhub_id_is_preferred_and_missing_doi_enriched(self):
        prior = {"paper_id": "123", "title": TITLE, "year": 2026}
        combined, added = external.merge_missing([prior], [record()])
        self.assertEqual(added, 0)
        self.assertEqual(combined[0]["paper_id"], "123")
        self.assertEqual(combined[0]["doi"], DOI)
        self.assertNotIn("doi", prior)


class RunnerTests(unittest.TestCase):
    def run_plan(self, *, query=URL, title=TITLE, papers=None, status=0, extra=None):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            plan = {
                "query": query,
                "inspect_concepts": ["research agents"],
                "best_target": {"required": True},
                "queries": [{"mode": "keyword", "query": query}],
            }
            if title:
                plan["best_target"]["title"] = title
                plan["queries"].append({"mode": "title", "query": title})
            plan.update(extra or {})
            path = root / "plan.json"
            path.write_text(json.dumps(plan))
            round_result = {"_in_memory_papers": papers or [], "failed_operations": status}
            audit = [{"url": URL, "status": "verified", "source": "crossref"}]
            with (
                patch.object(external, "start"),
                patch.object(external, "finish", return_value=([record()], audit)),
                patch.object(
                    quick_search.search_round, "run_round", return_value=(round_result, status)
                ),
                patch("sys.stdout", new_callable=io.StringIO),
            ):
                quick_search.main(["--plan", str(path), "--output-dir", str(root / "result")])
            for artifact in root.rglob("*.json"):
                self.assertNotIn('"abstract"', artifact.read_text())
            return json.loads((root / "result" / "metadata.json").read_text())

    def test_external_only_result_is_top1_and_valid_on_worker_path(self):
        doc = self.run_plan()
        self.assertEqual(len(doc["papers"]), 1)
        self.assertEqual(doc["papers"][0]["doi"], DOI)
        self.assertEqual(doc["papers"][0]["tier"], 1)
        self.assertEqual(len(appserver_quick._validate_result_papers(doc, URL)), 1)

    def test_unresolved_input_title_can_be_verified_inside_runner(self):
        doc = self.run_plan(title="")
        self.assertEqual(doc["papers"][0]["title"], TITLE)
        appserver_quick._validate_result_papers(doc, URL)

    def test_service_outage_does_not_erase_verified_result(self):
        doc = self.run_plan(status=1)
        self.assertEqual(doc["papers"][0]["doi"], DOI)
        self.assertEqual(
            doc["search_summary"]["external_verification"]["paperhub_failed_operations"], 1
        )

    def test_hard_dates_still_filter_external_target(self):
        with patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit):
            self.run_plan(extra={"year_end": 2025})

    def test_single_verified_topic_candidate_is_valid_without_forced_top1(self):
        doc = self.run_plan(
            query="AI research agents", title="", extra={"best_target": {"required": False}}
        )
        self.assertFalse(doc["search_summary"]["agent_best_target_required"])
        appserver_quick._validate_result_papers(doc, "AI research agents")


if __name__ == "__main__":
    unittest.main()
