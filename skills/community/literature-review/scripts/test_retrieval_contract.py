#!/usr/bin/env scholarseed-skill-python
"""Offline contract test for current agentic-search -> SLR adaptation."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import tempfile
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE = ROOT / "scripts" / "retrieval" / "adapt_search_output.py"
SPEC = importlib.util.spec_from_file_location("adapt_search_output", MODULE)
assert SPEC and SPEC.loader
adapter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adapter)


def command(*args):
    result = subprocess.run([sys.executable, *map(str, args)], text=True,
                            capture_output=True)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout


def current_finalizers(search_root: pathlib.Path) -> None:
    """Exercise real AS finalizers through the public SLR import/stage CLI."""
    with tempfile.TemporaryDirectory(prefix="slr-as-migration-") as tmp:
        base = pathlib.Path(tmp)
        source = base / "agentic-search-results" / "quality"
        session = source / "session"
        workspace = base / "survey"
        command(search_root / "tools/state.py", "init", "--dir", session,
                "--query", "Prefer 2022–2026 softly; earlier foundations allowed", "--mode", "quality")
        pool = {}
        choices = []
        for index in range(40):
            pid = f"p{index}"
            pool[pid] = {
                "paper_id": pid, "title": f"Research paper {index}",
                "authors": ["Ada Lovelace"], "year": 1997 if index == 0 else 2025,
                "arxiv_id": f"2501.{index:05d}", "doi": f"10.1234/{index}",
                "abstract": "Verified abstract in the test fixture.",
                "venue": "", "journal_name": "Test Journal",
                "journal_volume": "12", "journal_pages": "21-30",
                "source": "paperhub", "citation_count": 15,
            }
            choices.append({"paper_id": pid, "tier": 1 if index < 5 else 2 if index < 20 else 3,
                            "reason": "Required topic coverage"})
        (session / "pool.json").write_text(json.dumps(pool))
        selection = source / "selection.json"
        selection.write_text(json.dumps({"papers": choices}))
        command(search_root / "tools/finalize.py", "--session", session,
                "--selection", selection, "--output-dir", source,
                "--strict-counts", "--json-only")
        assert not (source / "search_provenance.json").exists()
        assert not (source / "report.md").exists()
        command(ROOT / "scripts/slr.py", "init", "--workspace", workspace,
                "--intent", "Review research papers with a soft 2022–2026 preference")
        command(ROOT / "scripts/slr.py", "import-search", "--workspace", workspace,
                "--source", source)
        output = workspace / "02_retrieval"
        assert (output / "metadata.json").read_bytes() == (source / "metadata.json").read_bytes()
        assert (output / "as_run/session/search_state.json").is_file()
        stage = json.loads(command(ROOT / "scripts/slr.py", "run", "retrieval_adapt",
                                   "--workspace", workspace))
        assert stage["status"] == "SUCCESS", stage
        corpus = json.loads((output / "selected_paper.json").read_text())
        report = json.loads((output / "retrieval_report.json").read_text())
        assert len(corpus) == 40
        assert corpus["p0"]["year"] == 1997  # soft range must preserve foundations
        assert corpus["p0"]["volume"] == "12"
        assert corpus["p0"]["pages"] == "21-30"
        assert corpus["p0"]["journal"] == "Test Journal"
        assert corpus["p0"]["external_ids"]["DOI"] == "10.1234/0"
        assert corpus["p0"]["relevance_level"] == "L1"
        assert report["citation_metadata"]["volume"] == 40
        refused = subprocess.run([sys.executable, str(ROOT / "scripts/slr.py"),
                                  "import-search", "--workspace", str(workspace),
                                  "--source", str(source)], capture_output=True)
        assert refused.returncode != 0
        assert (output / "metadata.json").read_bytes() == (source / "metadata.json").read_bytes()

        web_source = base / "agentic-search-results" / "web"
        candidates = base / "web-candidates.json"
        candidates.write_text(json.dumps({
            "search_queries": ["fixture query"], "papers": [
                {"title": "Web paper one", "arxiv_id": "2501.00001", "year": 2025,"authors":["Ada Lovelace"],
                 "abstract": "A supplied scholarly abstract."},
                {"title": "Web paper two", "doi": "10.1234/web", "year": 1990},
            ]}))
        command(search_root / "tools/web_fallback.py", "--input", candidates,
                "--query", "Soft recent preference with earlier foundations", "--mode", "quality",
                "--output-dir", web_source, "--paperhub-error-code", "PAPERHUB_AUTH_MISSING")
        web_workspace = base / "web-survey"
        command(ROOT / "scripts/slr.py", "import-search", "--workspace", web_workspace,
                "--source", web_source)
        from task_contract import configure
        configure(web_workspace, {'intent':'Review two papers with at least ten citations.',
            'retrieval':{'corpus_size':{'target':2}},
            'constraints':[{'id':'floor','kind':'min_paper_citations','value':10,'verbatim':'at least ten citations'}]})
        corpus, report, status = adapter.run(web_workspace)
        assert status["status"] == "PARTIAL_SUCCESS"
        assert len(corpus) == 1 and report["dropped"][0]["rule"] == "usable_abstract"
        assert all(p["citation_count"] is None for p in corpus.values())
        assert len(report["flagged_for_review"]) == 1
        assert report["missing_abstracts"] == 0
        assert "source_mode=web_only" in status["status_reason"]
        assert report["search_summary"]["source_status"]["paperhub"]["available"] is False
        assert "as_run/fallback_event.json" in report["search_trace_files"]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="slr-retrieval-contract-") as tmp:
        workspace = pathlib.Path(tmp)
        from task_contract import configure
        configure(workspace,{"intent":"Review the fixture evidence"})
        output = workspace / "02_retrieval"
        output.mkdir(parents=True)
        (output / "metadata.json").write_text(json.dumps({
            "search_summary": {"query": "precise search intent"},
            "papers": [
                {
                    "paper_id": "p1", "title": "Typed Upstream", "authors": ["Ada Lovelace"],
                    "abstract": "An actual complete abstract in the fixture.",
                    "year": 2025, "venue": {"name": "ExampleConf", "type": "conference"},
                    "tier": 1, "citation_count": 12,
                    "citationStyles": {"bibtex": "@Conference{Upstream, title={Typed Upstream}}"},
                    "external_ids": {"DOI": "10.1/example"},
                },
                {
                    "paper_id": "p2", "title": "Venue Only", "authors": ["Grace Hopper"],
                    "abstract": "A complete abstract with sparse citation metadata.",
                    "year": 2024, "venue": "Sparse Journal", "tier": 2,
                },
            ],
        }), encoding="utf-8")
        (output / "search_provenance.json").write_text(json.dumps({
            "rounds": 2, "queries": [], "pool_size": 2,
        }), encoding="utf-8")

        corpus, report, status = adapter.run(workspace)
        assert status["status"] in {"SUCCESS", "PARTIAL_SUCCESS"}
        assert corpus["p1"]["citationStyles"]["bibtex"].startswith("@Conference{")
        assert corpus["p1"]["external_ids"]["DOI"] == "10.1/example"
        assert corpus["p2"]["venue"] == {"name": "Sparse Journal"}
        assert not any(corpus["p2"].get(field) for field in ("volume", "number", "pages"))
        assert report["citation_metadata"]["upstream_bibtex"] == 1
        assert report["citation_metadata"]["venue_only"] == 2

        (output / "search_provenance.json").unlink()
        _, report, degraded = adapter.run(workspace)
        assert degraded["status"] == "PARTIAL_SUCCESS"
        assert "trace unavailable" in degraded["status_reason"]
        assert not report["search_trace_files"]

        # Reject unusable abstracts before deduplication/quota trimming. A higher
        # ranked title duplicate with no abstract cannot displace usable text.
        from task_contract import configure
        configure(workspace,{'retrieval':{'corpus_size':{'target':2}}})
        full="A source-provided complete abstract. "*100
        bad=[None, "", " N/A ", "No abstract available.", "A shortened abstract…", 42]
        candidates=[{'paper_id':f'bad{i}','title':f'Missing {i}','abstract':a,'tier':1,'authors':['Ada Lovelace'],'year':2025}
                    for i,a in enumerate(bad)]
        candidates[0]['title']='Complete'
        candidates += [{'paper_id':'good','title':'Complete','abstract':full,'tier':3,'authors':['Ada Lovelace'],'year':2025},
                       {'paper_id':'short','title':'Short','abstract':'We prove convergence.','tier':2,'authors':['Ada Lovelace'],'year':2025}]
        (output/'metadata.json').write_text(json.dumps({'papers':candidates}))
        corpus,report,status=adapter.run(workspace)
        assert set(corpus)=={'good','short'} and corpus['good']['abstract']==full.strip()
        assert report['abstract_filter']['rejected_count']==6 and report['missing_abstracts']==0
        assert status['status']=='PARTIAL_SUCCESS'
        assert adapter.abstract_problem({'abstract':'Full-looking text.','abstract_truncated':True})

        # A valid-but-fully-filtered import clears the selected projection;
        # stale papers must not silently survive a failed rerun.
        (output/'selected_paper.json').write_text(json.dumps(corpus))
        (output/'metadata.json').write_text(json.dumps({'papers':candidates[:6]}))
        filtered=subprocess.run([sys.executable,str(MODULE),str(workspace)],capture_output=True,text=True)
        assert filtered.returncode==1
        assert json.loads((output/'selected_paper.json').read_text())=={}
        assert len(json.loads((output/'retrieval_report.json').read_text())['dropped'])==6

        (output / "metadata.json").write_text('[]')
        assert adapter.run(workspace)[2]["status"] == "FAILED"
        (output / "metadata.json").write_text('{"papers": []}')
        assert adapter.run(workspace)[2]["status"] == "FAILED"

    # The optional path is test-only; production SLR never locates AS tools.
    if len(sys.argv) > 1:
        current_finalizers(pathlib.Path(sys.argv[1]).resolve())

    print("agentic-search -> SLR retrieval contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
