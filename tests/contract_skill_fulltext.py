"""Skill-side full-text boundary contracts: serve acquires, serve verifies.

Deterministic mechanism checks only (proposal 115/116 G1). The skill sandbox never
fetches full-text bytes, never asks for sandbox escalation, and never speaks to the
product bridge itself — the bridge is a serve-side model tool, and its acquisition
record reaches the run directory only as host-relayed input that serve re-verifies
at the delivery checkpoint. Not product acceptance.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL = REPO_ROOT / "skills" / "community" / "precise-literature-search"
GENERATED_SKILLS = REPO_ROOT / "apps" / "serve" / "service" / "capabilities" / "skills"
SCRIPTS = SKILL / "scripts"
OPEN_DOWNLOAD_ADAPTER = SKILL / "modules" / "open-download" / "adapter.py"
PAID_ADAPTER_PATH = SKILL / "modules" / "paid-download" / "adapter.py"
ESCALATION_TOKEN = "require_escalated"
BRIDGE_COMMAND = "scholarseed-bridge"
SCANNED_SUFFIXES = {".py", ".md", ".json", ".yaml", ".yml", ".txt", ".toml"}
FORBIDDEN_IMPORTS = {"urllib", "httpx", "requests", "socket", "ssl", "http"}

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import download_recovery  # noqa: E402
import run_state as RUN_STATE  # noqa: E402
from acquire_result import (  # noqa: E402
    ACQUIRE_RESULT_RELATIVE,
    AcquireResultError,
    load_acquire_result,
    require_within_selection,
)
from io_utils import atomic_write_json, utc_now  # noqa: E402
from open_download_preflight import route_selection  # noqa: E402
from post_open_gate import (  # noqa: E402
    choose_next_action,
    paid_pending,
    verified_manifest_download,
)
from run_state import (  # noqa: E402
    increment_search_round,
    initialize_run,
    read_state,
    update_status,
)
from stage_guard import authorize_download, claim_stage, digest, require_download  # noqa: E402
from task_binding import (  # noqa: E402
    BINDING_FILE,
    activation_request,
    ensure_binding,
    skill_version,
)
from validate_json import ContractError, validate_data  # noqa: E402


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ADAPTER = load_module("open_download_adapter", OPEN_DOWNLOAD_ADAPTER)
STAGE = load_module("pls_stage", SCRIPTS / "stage.py")
REVISION = "sha256:" + "a" * 64
MANIFEST_VERSION = re.compile(r'^version:\s*"?([^"\r\n]+?)"?\s*$', re.MULTILINE)


def manifest_version() -> str:
    """The installed manifest version, read independently of the skill's own parser."""

    text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    match = MANIFEST_VERSION.search(text.split("---", 2)[1])
    assert match is not None
    return match.group(1)


def acquire_result(
    papers: tuple[str, ...] = ("p1",),
    failures: tuple[tuple[str, str, str], ...] = (),
    *,
    ok: bool = True,
    storage: str = "managed",
    revision: str = REVISION,
) -> dict:
    return {
        "ok": ok,
        "storage": storage,
        "refs": [f"paper:{paper_id}" for paper_id in papers],
        "papers": [
            {
                "paper_id": paper_id,
                "ref": f"paper:{paper_id}",
                "revision": revision,
                "source_kind": "arxiv",
            }
            for paper_id in papers
        ],
        "failures": [
            {"paper_id": paper_id, "code": code, "reason": reason}
            for paper_id, code, reason in failures
        ],
        "manifest": {
            "selected": len(papers) + len(failures),
            "downloaded": len(papers),
            "failed": len(failures),
            "skipped": 0,
        },
    }


def paper(paper_id: str, title: str, arxiv_id: str | None = None) -> dict:
    record = {
        "id": paper_id,
        "title": title,
        "authors": ["Author"],
        "year": 2025,
        "abstract": "abstract",
        "doi": f"10.1/{paper_id}",
        "venue": "venue",
        "open_access": "yes" if arxiv_id else "no",
        "source": "paperhub",
        "relevance": {"reasons": ["符合研究问题"]},
        "is_placeholder": False,
        "document_type": "paper",
        "identity_status": "verified",
    }
    if arxiv_id:
        record["arxiv_id"] = arxiv_id
    return record


def metadata(papers: list[dict], run_id: str = "run1") -> dict:
    return {
        "schema_version": "1.0",
        "run_id": run_id,
        "round": 1,
        "query_summary": "研究方法",
        "generated_at": utc_now(),
        "status": "success",
        "is_placeholder": False,
        "papers": papers,
        "warnings": [],
    }


def selection(selected: list[str], run_id: str = "run1") -> dict:
    return {
        "schema_version": "1.1",
        "run_id": run_id,
        "metadata_path": "search/round-001/metadata.json",
        "selected_paper_ids": selected,
        "download_open": True,
        "download_paid": False,
        "read_after_download": True,
        "confirmed_by_user": True,
        "decision_source": "user_explicit",
    }


class SkillBoundaryContract(unittest.TestCase):
    """What the sandbox may never do: escalate, fetch, or impersonate the bridge."""

    def test_no_escalation_token_in_sources_or_generated_pack(self) -> None:
        offenders = []
        for root in (SKILL, GENERATED_SKILLS):
            if not root.is_dir():
                continue
            for path in sorted(root.rglob("*")):
                if not path.is_file() or path.suffix not in SCANNED_SUFFIXES:
                    continue
                if ESCALATION_TOKEN in path.read_text(encoding="utf-8", errors="ignore"):
                    offenders.append(str(path.relative_to(REPO_ROOT)))
        self.assertEqual(offenders, [])

    def test_no_skill_script_invokes_the_bridge_command(self) -> None:
        # serve keeps the session bridge identity out of the sandbox environment, so a
        # script-side CLI call can only fail; the model tool is the single channel.
        offenders = [
            str(path.relative_to(SKILL))
            for path in sorted(SKILL.rglob("*.py"))
            if path.is_file()
            and BRIDGE_COMMAND in path.read_text(encoding="utf-8", errors="ignore")
        ]
        self.assertEqual(offenders, [])

    def test_open_download_adapter_never_fetches_bytes(self) -> None:
        source = OPEN_DOWNLOAD_ADAPTER.read_text(encoding="utf-8")
        imported = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module.split(".")[0])
        self.assertEqual(imported & FORBIDDEN_IMPORTS, set())
        endpoints = [
            node
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and "://" in node.value
        ]
        self.assertEqual(endpoints, [])
        self.assertIn("load_acquire_result", source)


class AcquireResultContract(unittest.TestCase):
    """The relayed record is input: shaped, bounded by the selection, never trusted."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.run = Path(temporary.name) / "run"
        (self.run / "downloads").mkdir(parents=True)

    def write(self, result: dict) -> None:
        atomic_write_json(self.run / ACQUIRE_RESULT_RELATIVE, result)

    def test_missing_record_names_the_product_tool_call(self) -> None:
        with self.assertRaises(AcquireResultError) as caught:
            load_acquire_result(self.run)
        message = str(caught.exception)
        self.assertIn(ACQUIRE_RESULT_RELATIVE, message)
        self.assertIn("scholarseed_bridge", message)
        self.assertIn("acquire", message)

    def test_unsuccessful_or_non_managed_records_are_refused(self) -> None:
        for label, result in (
            ("not ok", acquire_result(ok=False)),
            ("run storage", acquire_result(storage="run")),
            (
                "papers not a list",
                {"ok": True, "storage": "managed", "papers": "p1", "failures": []},
            ),
        ):
            with self.subTest(case=label):
                self.write(result)
                with self.assertRaises(AcquireResultError):
                    load_acquire_result(self.run)

    def test_inconsistent_entries_are_refused(self) -> None:
        mismatched = acquire_result()
        mismatched["papers"][0]["ref"] = "paper:other"
        self.write(mismatched)
        with self.assertRaises(AcquireResultError):
            load_acquire_result(self.run)

        no_revision = acquire_result()
        no_revision["papers"][0]["revision"] = ""
        self.write(no_revision)
        with self.assertRaises(AcquireResultError):
            load_acquire_result(self.run)

        duplicated = acquire_result()
        duplicated["papers"].append(dict(duplicated["papers"][0]))
        self.write(duplicated)
        with self.assertRaises(AcquireResultError):
            load_acquire_result(self.run)

        contradictory = acquire_result(failures=(("p1", "acquire_download_failed", "x"),))
        self.write(contradictory)
        with self.assertRaises(AcquireResultError):
            load_acquire_result(self.run)

    def test_record_cannot_widen_the_confirmed_selection(self) -> None:
        self.write(acquire_result(papers=("p1", "p9")))
        with self.assertRaises(AcquireResultError) as caught:
            require_within_selection(load_acquire_result(self.run), ["p1", "p2"])
        self.assertIn("p9", str(caught.exception))
        self.assertIsNone(
            require_within_selection(load_acquire_result(self.run), ["p1", "p2", "p9"])
        )


class ManagedManifestContract(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.run = Path(temporary.name) / "run"
        self.run.mkdir()

    def test_managed_entry_is_complete_without_a_run_copy(self) -> None:
        item = {
            "paper_id": "p1",
            "status": "downloaded",
            "verified_exists": True,
            "storage": "managed",
            "ref": "paper:p1",
            "revision": REVISION,
            "file_path": None,
        }
        self.assertTrue(verified_manifest_download(item, self.run))
        for label, broken in (
            ("no revision", {**item, "revision": ""}),
            ("foreign ref", {**item, "ref": "literature:p1"}),
            ("run copy", {**item, "file_path": "downloads/papers/p1.pdf"}),
            ("unverified", {**item, "verified_exists": False}),
        ):
            with self.subTest(case=label):
                self.assertFalse(verified_manifest_download(broken, self.run))

    def test_run_contained_pdf_still_verifies_by_signature(self) -> None:
        pdf = self.run / "downloads/papers/p2.pdf"
        pdf.parent.mkdir(parents=True)
        pdf.write_bytes(b"%PDF-1.7\n")
        item = {
            "paper_id": "p2",
            "status": "downloaded",
            "verified_exists": True,
            "storage": "run",
            "file_path": "downloads/papers/p2.pdf",
        }
        self.assertTrue(verified_manifest_download(item, self.run))
        pdf.write_bytes(b"not a pdf")
        self.assertFalse(verified_manifest_download(item, self.run))

    def test_manifest_reports_exactly_what_serve_acquired(self) -> None:
        manifest = ADAPTER.build_manifest(
            selection(["p1", "p2", "p3", "p4", "p5"]),
            metadata(
                [
                    paper("p1", "acquired arXiv", "2501.00001"),
                    paper("p2", "acquired by DOI"),
                    paper("p3", "never sent to serve", "2501.00003"),
                    paper("p4", "serve reported a failure", "2501.00004"),
                    paper("p5", "ungranted non-arXiv"),
                ]
            ),
            self.run,
            acquire_result(
                papers=("p1", "p2"), failures=(("p4", "acquire_download_failed", "upstream 500"),)
            ),
        )
        by_id = {item["paper_id"]: item for item in manifest["papers"]}
        self.assertEqual(by_id["p1"]["status"], "downloaded")
        self.assertEqual(by_id["p1"]["storage"], "managed")
        self.assertEqual(by_id["p1"]["ref"], "paper:p1")
        self.assertEqual(by_id["p1"]["revision"], REVISION)
        self.assertIsNone(by_id["p1"]["file_path"])
        self.assertIn("arXiv:2501.00001", by_id["p1"]["message"])
        # serve has a DOI leg, so a granted DOI-only paper is managed too, not paid-route bait.
        self.assertEqual(by_id["p2"]["status"], "downloaded")
        self.assertEqual(by_id["p2"]["storage"], "managed")
        self.assertIn("doi:10.1/p2", by_id["p2"]["message"])
        # An ungranted (or unidentifiable) paper must not block reading: the subset grant is
        # the normal path, so it is reported as skipped rather than as an unresolved attempt.
        for paper_id in ("p3", "p5"):
            self.assertEqual(by_id[paper_id]["status"], "skipped")
            self.assertIn("did not acquire", by_id[paper_id]["message"])
            self.assertIn("terminal", by_id[paper_id]["message"])
        self.assertEqual(by_id["p4"]["status"], "failed")
        self.assertIn("upstream 500", by_id["p4"]["message"])
        self.assertEqual(
            manifest["summary"],
            {"selected": 5, "downloaded": 2, "action_required": 0, "failed": 1, "skipped": 2},
        )
        self.assertTrue(
            any("not acquired by the product" in warning for warning in manifest["warnings"])
        )
        validate_data("download-manifest", manifest)
        self.assertEqual(list(self.run.rglob("*.pdf")), [])

    def test_manifest_contract_rejects_a_managed_run_copy(self) -> None:
        manifest = {
            "schema_version": "1.0",
            "run_id": "run1",
            "generated_at": utc_now(),
            "is_placeholder": False,
            "papers": [
                {
                    "paper_id": "p1",
                    "title": "t",
                    "access_type": "open",
                    "status": "downloaded",
                    "storage": "managed",
                    "ref": "paper:p1",
                    "revision": REVISION,
                    "file_path": "downloads/papers/p1.pdf",
                    "verified_exists": True,
                    "message": "m",
                }
            ],
            "summary": {
                "selected": 1,
                "downloaded": 1,
                "action_required": 0,
                "failed": 0,
                "skipped": 0,
            },
            "warnings": [],
        }
        with self.assertRaises(ContractError):
            validate_data("download-manifest", manifest)


class RunFixture(unittest.TestCase):
    """A real run directory built with the skill's own state helpers."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        work = Path(temporary.name) / "workdir"
        work.mkdir()
        self.run = initialize_run(work, "研究方法")
        atomic_write_json(
            self.run / "workflow.json",
            {
                "schema_version": "2.0",
                "run_id": self.run.name,
                "auto_delegated": False,
                "created_at": utc_now(),
            },
        )
        atomic_write_json(
            self.run / "intent.json",
            {
                "schema_version": "1.1",
                "original_request": "研究方法",
                "precise_intent": "研究方法",
                "research_questions": [],
                "include_criteria": [],
                "exclude_criteria": [],
                "time_range": {"from_year": None, "to_year": None},
                "paper_types": [],
                "language": None,
                "max_results": 5,
                "confirmed": True,
                "confirmation_source": "user_explicit",
            },
        )
        update_status(self.run, "INTENT_CONFIRMED", "fixture", {"intent": "intent.json"})
        increment_search_round(self.run)
        round_dir = self.run / "search" / "round-001"
        round_dir.mkdir(parents=True, exist_ok=True)
        self.metadata_path = round_dir / "metadata.json"
        atomic_write_json(
            self.metadata_path,
            metadata([paper("p1", "acquired arXiv", "2501.00001")], self.run.name),
        )
        atomic_write_json(self.run / "selection.json", selection(["p1"], self.run.name))
        update_status(
            self.run,
            "DOWNLOADING_OPEN",
            "fixture",
            {"selection": "selection.json", "latest_metadata": "search/round-001/metadata.json"},
        )
        atomic_write_json(
            self.run / "download-authorization.json",
            {
                "schema_version": "1.0",
                "round": 1,
                "selection_sha256": digest(self.run / "selection.json"),
                "metadata_sha256": digest(self.metadata_path),
                "decision_source": "user_explicit",
                "created_at": utc_now(),
            },
        )


class DownloadAuthorizationPathContract(RunFixture):
    def prepare_paths(self, selection_metadata: str, latest_metadata: str | None) -> None:
        update_status(
            self.run,
            "REVIEW_PENDING",
            "fixture",
            {"latest_metadata": latest_metadata},
        )
        selected = selection(["p1"], self.run.name)
        selected["metadata_path"] = selection_metadata
        atomic_write_json(self.run / "selection.json", selected)

    def authorize_with_paths(self, selection_metadata: str, latest_metadata: str | None) -> dict:
        self.prepare_paths(selection_metadata, latest_metadata)
        return authorize_download(self.run, self.run / "selection.json", "user_explicit")

    def test_missing_latest_metadata_is_rejected_with_domain_error(self) -> None:
        with self.assertRaisesRegex(ValueError, "current real metadata"):
            self.authorize_with_paths("search/round-001/metadata.json", None)

    def test_equivalent_relative_paths_are_accepted(self) -> None:
        permit = self.authorize_with_paths(
            "./search/round-001/metadata.json",
            "search/round-001/metadata.json",
        )
        self.assertEqual(permit["round"], 1)

    def test_stage_cli_accepts_equivalent_relative_paths(self) -> None:
        self.prepare_paths(
            "./search/round-001/metadata.json",
            "search/round-001/metadata.json",
        )
        # The official contract runner enables safe-path mode. Declare this
        # script's module owner explicitly instead of relying on Python adding
        # the entrypoint directory or inheriting the runner's tests package root.
        # A run directory must not supply modules for the skill command.
        (self.run / "acquire_result.py").write_text(
            "raise RuntimeError('run directory module was imported')\n", encoding="utf-8"
        )
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "stage.py"),
                "authorize-download",
                "--run-dir",
                str(self.run),
                "--selection",
                str(self.run / "selection.json"),
                "--decision-source",
                "user_explicit",
            ],
            cwd=self.run,
            env={**os.environ, "PYTHONSAFEPATH": "1", "PYTHONPATH": str(SCRIPTS)},
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(json.loads(result.stdout)["round"], 1)

    @unittest.skipUnless(os.name == "nt", "requires native Windows path resolution")
    def test_mixed_windows_separators_are_accepted(self) -> None:
        for selection_metadata, latest_metadata in (
            ("search/round-001/metadata.json", r"search\round-001\metadata.json"),
            (r"search\round-001\metadata.json", "search/round-001/metadata.json"),
        ):
            with self.subTest(selection_metadata=selection_metadata):
                permit = self.authorize_with_paths(selection_metadata, latest_metadata)
                self.assertEqual(permit["round"], 1)

    def test_previous_round_metadata_is_rejected(self) -> None:
        update_status(self.run, "REFINEMENT_REQUESTED", "fixture")
        increment_search_round(self.run)
        current = self.run / "search" / "round-002" / "metadata.json"
        current_metadata = metadata([paper("p1", "current paper")], self.run.name)
        current_metadata["round"] = 2
        atomic_write_json(current, current_metadata)
        with self.assertRaisesRegex(ValueError, "current real metadata"):
            self.authorize_with_paths(
                "search/round-001/metadata.json",
                "search/round-002/metadata.json",
            )

    def test_outside_run_metadata_is_rejected(self) -> None:
        for selection_metadata, latest_metadata in (
            ("../outside/metadata.json", "search/round-001/metadata.json"),
            ("search/round-001/metadata.json", "../outside/metadata.json"),
        ):
            with self.subTest(selection_metadata=selection_metadata):
                with self.assertRaisesRegex(ValueError, "artifact escapes run directory"):
                    self.authorize_with_paths(selection_metadata, latest_metadata)


class SearchPathPersistenceContract(RunFixture):
    def test_completed_search_persists_posix_relative_paths(self) -> None:
        update_status(self.run, "SEARCHING", "fixture")
        lease = claim_stage(self.run, "search", 1)
        with mock.patch.object(STAGE, "execute", return_value=None):
            STAGE.complete(self.run, "search", lease["token"])
        paths = read_state(self.run)["paths"]
        self.assertEqual(paths["latest_metadata"], "search/round-001/metadata.json")
        self.assertEqual(paths["latest_search_report"], "search/round-001/search_report.md")


class DownloadGateContract(RunFixture):
    def test_authorized_route_runs_with_a_bound_permit(self) -> None:
        self.assertIsNone(require_download(self.run, self.run / "selection.json", "open-download"))

    def test_stale_permit_is_refused(self) -> None:
        permit = json.loads((self.run / "download-authorization.json").read_text(encoding="utf-8"))
        permit["selection_sha256"] = "0" * 64
        atomic_write_json(self.run / "download-authorization.json", permit)
        with self.assertRaises(ValueError) as caught:
            require_download(self.run, self.run / "selection.json", "open-download")
        self.assertIn("stale", str(caught.exception))

    def test_download_stage_requires_the_relayed_acquisition_record(self) -> None:
        selected = selection(["p1"], self.run.name)
        with self.assertRaises(AcquireResultError):
            STAGE.require_acquired_by_product(self.run, selected)
        atomic_write_json(self.run / ACQUIRE_RESULT_RELATIVE, acquire_result(papers=("p1", "p9")))
        with self.assertRaises(AcquireResultError) as caught:
            STAGE.require_acquired_by_product(self.run, selected)
        self.assertIn("outside the confirmed selection", str(caught.exception))
        atomic_write_json(self.run / ACQUIRE_RESULT_RELATIVE, acquire_result(papers=("p1",)))
        self.assertIsNone(STAGE.require_acquired_by_product(self.run, selected))


class ReadingFixture(RunFixture):
    def write_reading(self, *, evidence: str | None, storage: str = "managed") -> None:
        atomic_write_json(
            self.run / "downloads" / "manifest.json",
            ADAPTER.build_manifest(
                selection(["p1"], self.run.name),
                json.loads(self.metadata_path.read_text(encoding="utf-8")),
                self.run,
                acquire_result(papers=("p1",)),
            ),
        )
        if storage == "run":
            # The paid/paper-dl route still lands real bytes inside the run directory.
            manifest = json.loads(
                (self.run / "downloads" / "manifest.json").read_text(encoding="utf-8")
            )
            pdf = self.run / "downloads" / "papers" / "p1.pdf"
            pdf.parent.mkdir(parents=True, exist_ok=True)
            pdf.write_bytes(b"%PDF-1.7\n")
            manifest["papers"][0].update(
                storage="run", ref=None, revision=None, file_path="downloads/papers/p1.pdf"
            )
            atomic_write_json(self.run / "downloads" / "manifest.json", manifest)
        if evidence is not None:
            text = self.run / evidence
            text.parent.mkdir(parents=True, exist_ok=True)
            text.write_text("page 1 text evidence\n", encoding="utf-8")
        (self.run / "read_report.md").write_text("# reading status\ncovered p1\n", encoding="utf-8")
        (self.run / "paper_summary.md").write_text(
            "# p1\nInteraction summary: a. b. c.\nQuery-specific evidence: direct\n",
            encoding="utf-8",
        )
        atomic_write_json(
            self.run / "reading-outcome.json",
            {
                "schema_version": "1.0",
                "run_id": self.run.name,
                "search_round": 1,
                "manifest_sha256": digest(self.run / "downloads" / "manifest.json"),
                "papers": [
                    {
                        "paper_id": "p1",
                        "file_path": evidence,
                        "storage": storage,
                        "revision": REVISION if storage == "managed" else None,
                        "status": "readable" if evidence else "unreadable",
                        "reason": None if evidence else "no verified full text",
                    }
                ],
            },
        )

    def settle_reading(self) -> None:
        update_status(
            self.run,
            "REPORT_REVIEW_PENDING",
            "fixture",
            {
                "download_manifest": "downloads/manifest.json",
                "reading_outcome": "reading-outcome.json",
                "report": "read_report.md",
                "paper_summary": "paper_summary.md",
            },
        )


class ReadingEvidenceContract(ReadingFixture):
    def test_readable_claim_needs_run_contained_evidence(self) -> None:
        self.write_reading(evidence="work-reading/p1.txt")
        self.assertEqual(STAGE.validate_reading(self.run)["papers"][0]["status"], "readable")
        (self.run / "work-reading" / "p1.txt").write_text("", encoding="utf-8")
        with self.assertRaises(ValueError) as caught:
            STAGE.validate_reading(self.run)
        self.assertIn("nonempty run-contained evidence", str(caught.exception))

    def test_readable_claim_without_evidence_path_is_refused(self) -> None:
        self.write_reading(evidence="work-reading/p1.txt")
        outcome = json.loads((self.run / "reading-outcome.json").read_text(encoding="utf-8"))
        outcome["papers"][0]["file_path"] = None
        atomic_write_json(self.run / "reading-outcome.json", outcome)
        with self.assertRaises(ContractError):
            STAGE.validate_reading(self.run)

    def test_outcome_must_cover_exactly_the_downloaded_papers(self) -> None:
        self.write_reading(evidence="work-reading/p1.txt")
        outcome = json.loads((self.run / "reading-outcome.json").read_text(encoding="utf-8"))
        outcome["papers"].append(
            {
                "paper_id": "p9",
                "file_path": "work-reading/p9.txt",
                "status": "readable",
                "reason": None,
            }
        )
        atomic_write_json(self.run / "reading-outcome.json", outcome)
        with self.assertRaises(ValueError) as caught:
            STAGE.validate_reading(self.run)
        self.assertIn("does not cover exactly the downloaded papers", str(caught.exception))


class FinalDeliveryEvidenceContract(ReadingFixture):
    """The terminal report gate must accept managed full text and still bind evidence."""

    def no_readable(self) -> bool:
        self.settle_reading()
        return RUN_STATE._no_readable_fulltext(self.run, read_state(self.run))

    def test_managed_paper_may_name_its_run_contained_text_cache(self) -> None:
        self.write_reading(evidence="work-reading/p1.txt")
        self.assertFalse(self.no_readable())

    def test_managed_paper_without_evidence_path_is_refused(self) -> None:
        self.write_reading(evidence=None)
        outcome = json.loads((self.run / "reading-outcome.json").read_text(encoding="utf-8"))
        outcome["papers"][0]["file_path"] = None
        atomic_write_json(self.run / "reading-outcome.json", outcome)
        with self.assertRaises(ValueError) as caught:
            self.no_readable()
        self.assertIn("run-contained text", str(caught.exception))

    def test_run_storage_paper_must_name_the_downloaded_file(self) -> None:
        self.write_reading(evidence="downloads/papers/p1.pdf", storage="run")
        self.assertFalse(self.no_readable())
        outcome = json.loads((self.run / "reading-outcome.json").read_text(encoding="utf-8"))
        outcome["papers"][0]["file_path"] = "work-reading/p1.txt"
        outcome["manifest_sha256"] = digest(self.run / "downloads" / "manifest.json")
        atomic_write_json(self.run / "reading-outcome.json", outcome)
        with self.assertRaises(ValueError) as caught:
            self.no_readable()
        self.assertIn("must name the downloaded file", str(caught.exception))

    def test_outcome_may_not_invent_or_drop_a_downloaded_paper(self) -> None:
        self.write_reading(evidence="work-reading/p1.txt")
        outcome = json.loads((self.run / "reading-outcome.json").read_text(encoding="utf-8"))
        outcome["papers"] = []
        atomic_write_json(self.run / "reading-outcome.json", outcome)
        with self.assertRaises(ValueError) as caught:
            self.no_readable()
        self.assertIn("omits downloaded papers", str(caught.exception))


class PaidRouteBoundaryContract(unittest.TestCase):
    """Only a granted paper serve could not fetch may reach the paper-dl route."""

    PAPERS = (
        ("p1", "acquired arXiv", "2501.00001"),
        ("p2", "ungranted, no arXiv", None),
        ("p3", "granted but serve failed", "2501.00003"),
    )
    SELECTED = ("p1", "p2", "p3")

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.run = Path(temporary.name) / "run1"
        self.run.mkdir()
        self.selection = selection(list(self.SELECTED), "run1") | {"download_paid": True}
        self.metadata = metadata([paper(*item) for item in self.PAPERS], "run1")
        self.manifest = ADAPTER.build_manifest(
            self.selection,
            self.metadata,
            self.run,
            acquire_result(
                papers=("p1",), failures=(("p3", "acquire_download_failed", "upstream 500"),)
            ),
        )

    def test_pending_comes_from_the_manifest_not_from_metadata(self) -> None:
        chosen = choose_next_action(self.selection, self.metadata, self.manifest, self.run)
        # p2 is exactly the paper the old metadata-driven rule routed to paper-dl.
        self.assertEqual(chosen["pending_paper_ids"], ["p3"])
        self.assertEqual(chosen["next_action"], "confirm_paid_download")

    def test_an_already_confirmed_paid_route_starts_without_a_new_question(self) -> None:
        confirmed = self.selection | {"paid_download_confirmation": "included_in_selection"}
        chosen = choose_next_action(confirmed, self.metadata, self.manifest, self.run)
        self.assertEqual(chosen["next_action"], "start_paid_download")
        self.assertEqual(chosen["pending_paper_ids"], ["p3"])

    def test_paid_pending_states(self) -> None:
        cases = (
            ("failed", True),
            ("action_required", True),
            ("skipped", False),
            ("downloaded", False),
            ("not_attempted", False),
        )
        for status, expected in cases:
            with self.subTest(status=status):
                self.assertIs(paid_pending({"paper_id": "p1", "status": status}), expected)
        self.assertFalse(paid_pending(None))

    def test_a_terminal_skip_is_never_a_recovery_target(self) -> None:
        self.assertEqual(
            download_recovery.UNSUCCESSFUL, {"action_required", "failed", "not_attempted"}
        )

    def test_invalid_manual_target_remains_unsuccessful(self) -> None:
        recovery = {
            "options": {
                "manual_download": {
                    "papers": [
                        {"paper_id": "p3", "target_file": "downloads/papers/NUL.pdf"},
                    ]
                }
            },
        }
        with mock.patch.object(
            download_recovery, "filesystem_path", side_effect=ValueError("invalid Windows path")
        ):
            result = download_recovery.verify_manual(self.run, recovery, self.manifest)
        self.assertEqual(result["invalid_or_missing_paper_ids"], ["p3"])
        self.assertEqual(self.manifest["papers"][2]["status"], "failed")

    @unittest.skipUnless(os.name == "nt", "requires native Windows filename validation")
    def test_native_reserved_manual_target_remains_unsuccessful(self) -> None:
        recovery = {
            "options": {
                "manual_download": {
                    "papers": [
                        {"paper_id": "p3", "target_file": "downloads/papers/NUL.pdf"},
                    ]
                }
            },
        }
        result = download_recovery.verify_manual(self.run, recovery, self.manifest)
        self.assertEqual(result["invalid_or_missing_paper_ids"], ["p3"])
        self.assertEqual(self.manifest["papers"][2]["status"], "failed")

    def test_manual_target_outside_run_is_rejected(self) -> None:
        recovery = {
            "options": {
                "manual_download": {
                    "papers": [
                        {"paper_id": "p3", "target_file": "../outside.pdf"},
                    ]
                }
            },
        }
        with self.assertRaisesRegex(ValueError, "must stay inside the run directory"):
            download_recovery.verify_manual(self.run, recovery, self.manifest)

    def test_paid_adapter_selects_targets_through_the_shared_predicate(self) -> None:
        source = PAID_ADAPTER_PATH.read_text(encoding="utf-8")
        self.assertIn("from post_open_gate import paid_pending", source)
        self.assertIn("elif paid_pending(existing.get(str(paper_id))):", source)
        self.assertNotIn("elif paper_needs_paid_download(paper):", source)


class ManagedRoutePreflightContract(unittest.TestCase):
    """serve has a DOI leg, so a DOI-only selection must still reach the managed route."""

    def test_doi_only_selection_runs_the_managed_route(self) -> None:
        doi_only = paper("p2", "DOI only paper")
        doi_only.pop("arxiv_id", None)
        route, manifest = route_selection(selection(["p2"]), metadata([doi_only]))
        self.assertEqual(route["next_action"], "run_open_download")
        self.assertEqual(route["managed_candidate_ids"], ["p2"])
        self.assertIsNone(manifest)

    def test_arxiv_selection_still_runs_the_managed_route(self) -> None:
        route, _manifest = route_selection(
            selection(["p1"]), metadata([paper("p1", "arXiv paper", "2501.00001")])
        )
        self.assertEqual(route["next_action"], "run_open_download")
        self.assertEqual(route["managed_candidate_count"], 1)

    def test_unidentifiable_selection_is_skipped_without_a_dead_end(self) -> None:
        no_identifier = paper("p3", "no arXiv, no DOI")
        no_identifier.pop("arxiv_id", None)
        no_identifier["doi"] = ""
        route, manifest = route_selection(selection(["p3"]), metadata([no_identifier]))
        self.assertEqual(route["next_action"], "post_open_gate")
        self.assertIsNotNone(manifest)
        (entry,) = manifest["papers"]
        self.assertEqual(entry["status"], "skipped")
        self.assertIn("No arXiv or DOI identifier", entry["message"])
        validate_data("download-manifest", manifest)
        # A terminal skip is never a paper-dl or recovery target.
        self.assertFalse(paid_pending(entry))

    def test_an_unselected_route_skips_everything(self) -> None:
        unselected = selection(["p1"]) | {"download_open": False}
        route, manifest = route_selection(
            unselected, metadata([paper("p1", "arXiv paper", "2501.00001")])
        )
        self.assertEqual(route["next_action"], "post_open_gate")
        self.assertIn("not selected by the user", manifest["papers"][0]["message"])


class TaskIdentityContract(unittest.TestCase):
    """The run leaves identity evidence; serve verifies it against its own inventory."""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name).resolve()
        self.run = initialize_run(self.work, "find the papers")

    def test_run_creation_writes_the_binding_serve_revalidates(self) -> None:
        binding = json.loads((self.run / BINDING_FILE).read_text(encoding="utf-8"))
        self.assertEqual(binding["schema_version"], "1.0")
        self.assertEqual(binding["skill"], str(SKILL.resolve()))
        self.assertEqual(binding["version"], manifest_version())
        self.assertEqual(binding["version"], skill_version())
        self.assertEqual(binding["workspace"], str(self.run.resolve()))
        self.assertEqual(binding["run_id"], self.run.name)
        self.assertEqual(binding["work_dir"], str(self.work))

    def test_stage_results_hand_the_model_one_activation_request(self) -> None:
        result = STAGE.with_task_activation(STAGE.stats(self.run), self.run)
        activation = result["task_activation"]
        request = activation["request"]
        self.assertEqual((activation["capability"], activation["operation"]), ("task", "activate"))
        self.assertEqual(request["task_type"], "precise_search")
        self.assertEqual(request["skill_name"], "precise-literature-search")
        self.assertEqual(request["skill_version"], manifest_version())
        self.assertEqual(request["skill_path"], str(SKILL.resolve()))
        # serve resolves the workspace against the session workdir, so it must be
        # relative and must name this run.
        self.assertEqual(request["workspace"], self.run.relative_to(self.work).as_posix())
        self.assertEqual(request["run_id"], self.run.name)
        self.assertIn("once per turn", result["task_activation_hint"])

    def test_a_resumed_run_regenerates_a_missing_binding(self) -> None:
        expected = activation_request(self.run)["request"]
        (self.run / BINDING_FILE).unlink()
        self.assertEqual(activation_request(self.run)["request"], expected)
        self.assertTrue((self.run / BINDING_FILE).is_file())

    def test_a_resumed_run_refreshes_its_previous_skill_version(self) -> None:
        binding_path = self.run / BINDING_FILE
        binding = json.loads(binding_path.read_text(encoding="utf-8"))
        binding["version"] = "1.0.12"
        atomic_write_json(binding_path, binding)
        request = activation_request(self.run)["request"]
        self.assertEqual(request["skill_version"], manifest_version())
        self.assertEqual(
            json.loads(binding_path.read_text(encoding="utf-8"))["version"], manifest_version()
        )

    def test_foreign_binding_is_not_upgraded(self) -> None:
        binding_path = self.run / BINDING_FILE
        binding = json.loads(binding_path.read_text(encoding="utf-8"))
        binding.update(version="1.0.12", skill=str(self.work / "foreign"))
        atomic_write_json(binding_path, binding)
        self.assertEqual(activation_request(self.run)["request"]["skill_version"], "1.0.12")
        self.assertEqual(json.loads(binding_path.read_text(encoding="utf-8")), binding)

    def test_only_a_run_of_this_skill_can_ask_for_a_binding(self) -> None:
        elsewhere = self.work / "notes"
        elsewhere.mkdir()
        with self.assertRaises(ValueError):
            ensure_binding(elsewhere)

    def test_identity_comes_from_the_installed_manifest_not_from_input(self) -> None:
        self.assertEqual(list(inspect.signature(activation_request).parameters), ["run_dir"])
        source = (SCRIPTS / "task_binding.py").read_text(encoding="utf-8")
        self.assertNotIn("argv", source)
        self.assertNotIn("environ", source)

    def test_skill_requires_activation_before_its_bridge_calls(self) -> None:
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        identity = skill.index("### Product task identity")
        phase_four = skill.index("## Phase 4: authorize and download")
        phase_five = skill.index("## Phase 5: read verified full texts")
        selection = skill.index('"checkpoint":"selection"', phase_four)
        self.assertLess(identity, phase_four)
        self.assertIn("once per turn", skill[identity:phase_four])
        self.assertIn("fulltext_authorization_task_required", skill[identity:phase_four])
        self.assertIn("activate this turn's task lease", skill[phase_four:selection])
        self.assertIn("Product task identity", skill[phase_five:])


if __name__ == "__main__":
    unittest.main()
