"""Path syntax checks run everywhere; native Windows checks require Windows."""

from __future__ import annotations

import errno
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stdout
from pathlib import Path, PureWindowsPath
from types import MappingProxyType
from unittest import mock

import browser_pool
import execution_policy
import filesystem
import io_utils
import post_open_gate
import run_state
import stage_guard
import state
import worker

ROOT = Path(__file__).resolve().parents[3]
_PAID_DOWNLOAD_PATH = (
    ROOT
    / "skills"
    / "community"
    / "precise-literature-search"
    / "modules"
    / "paid-download"
    / "adapter.py"
)
_PAID_DOWNLOAD_SPEC = importlib.util.spec_from_file_location(
    "paid_download_longpath_adapter", _PAID_DOWNLOAD_PATH
)
paid_download_adapter = importlib.util.module_from_spec(_PAID_DOWNLOAD_SPEC)
_PAID_DOWNLOAD_SPEC.loader.exec_module(paid_download_adapter)

_OPEN_DOWNLOAD_PATH = (
    ROOT
    / "skills"
    / "community"
    / "precise-literature-search"
    / "modules"
    / "open-download"
    / "adapter.py"
)
_OPEN_DOWNLOAD_SPEC = importlib.util.spec_from_file_location(
    "open_download_gate_adapter", _OPEN_DOWNLOAD_PATH
)
open_download_adapter = importlib.util.module_from_spec(_OPEN_DOWNLOAD_SPEC)
_OPEN_DOWNLOAD_SPEC.loader.exec_module(open_download_adapter)


class WindowsPathTests(unittest.TestCase):
    def test_reserved_names_without_deprecated_pathlib_api(self):
        with mock.patch.object(
            PureWindowsPath,
            "is_reserved",
            side_effect=AssertionError("deprecated API"),
            create=True,
        ):
            for name in (
                "CON",
                "con.txt",
                "NUL .pdf",
                "PRN",
                "AUX",
                "CONIN$",
                "CONOUT$.log",
                "COM1",
                "LPT9.txt",
                "COM¹",
                "LPT².pdf",
                "COM³",
            ):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    filesystem.extended_windows_path("C:\\papers\\" + name)
            for name in ("paper.pdf", "COM0", "COM10", "LPT0", "CONSOLE"):
                with self.subTest(name=name):
                    self.assertEqual(
                        filesystem.extended_windows_path("C:\\papers\\" + name),
                        "\\\\?\\C:\\papers\\" + name,
                    )

    def test_drive_unc_and_existing_prefixes(self):
        cases = {
            r"C:\papers\结果.json": r"\\?\C:\papers\结果.json",
            "C:/papers/sub/../result.json": r"\\?\C:\papers\result.json",
            r"\\server\share\papers\result.json": r"\\?\UNC\server\share\papers\result.json",
            r"\\?\C:\papers\result.json": r"\\?\C:\papers\result.json",
            r"\\?\UNC\server\share\result.json": r"\\?\UNC\server\share\result.json",
        }
        for original, expected in cases.items():
            with self.subTest(path=original):
                self.assertEqual(filesystem.extended_windows_path(original), expected)
                self.assertEqual(filesystem.extended_windows_path(expected), expected)
                self.assertFalse(filesystem.ordinary_windows_path(expected).startswith("\\\\?\\"))

    def test_rejects_ambiguous_paths_and_device_names(self):
        for invalid in (
            "relative.json",
            r"C:relative.json",
            r"\relative.json",
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\file",
            r"C:\papers\NUL.json",
            r"C:\papers\file:stream",
            "C:\\papers\\file ",
            "C:\\papers\\file.",
        ):
            with self.subTest(path=invalid), self.assertRaises(ValueError):
                filesystem.extended_windows_path(invalid)

    @unittest.skipIf(os.name == "nt", "POSIX path behavior")
    def test_posix_paths_are_unchanged(self):
        path = Path("relative /结果.json")
        self.assertEqual(filesystem.filesystem_path(path), path)

    @unittest.skipUnless(os.name == "nt", "requires native Windows path resolution")
    def test_native_windows_paths_and_canonical_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertTrue(str(filesystem.filesystem_path(root)).startswith("\\\\?\\"))
            self.assertEqual(
                filesystem.canonical_path(root),
                filesystem.canonical_path(filesystem.filesystem_path(root)),
            )


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.addCleanup(shutil.rmtree, filesystem.filesystem_path(self.root))
        self.work = self.root / ("nested-" * 9) / ("papers-" * 9) / ("session-" * 9) / "work"
        filesystem.filesystem_path(self.work).mkdir(parents=True)

    def test_long_snapshot_roundtrip_keeps_digest_and_identifier(self):
        result = {"status": "ok", "metadata": {"text": "真实文件 I/O"}}
        path = self.work / worker.snapshot_name(result)
        self.assertGreater(len(str(path)), 260)
        with mock.patch.dict(os.environ, {"PLS_STAGE_TOKEN": "test-stage-token"}):
            page = worker.record_page(self.work, result)
            with mock.patch.object(worker, "transaction", return_value=nullcontext()):
                restored = worker.read_output(self.work, page["snapshot"])
        self.assertEqual(restored["snapshot"], page["snapshot"])
        self.assertEqual(io_utils.read_json(path), result)
        self.assertNotIn("\\", page["snapshot"])
        with self.assertRaisesRegex(ValueError, "cannot replace"):
            worker.save_once(path, {"different": True})

    def test_atomic_replace_and_short_temporary_name(self):
        target = self.work / ("result-" + "a" * 64 + ".json")
        io_utils.atomic_write_json(target, {"revision": 1})
        original_mkstemp = tempfile.mkstemp
        with mock.patch.object(io_utils.tempfile, "mkstemp", wraps=original_mkstemp) as create:
            io_utils.atomic_write_json(target, {"revision": 2})
        self.assertEqual(io_utils.read_json(target), {"revision": 2})
        self.assertEqual(create.call_args.kwargs["prefix"], io_utils.TEMPORARY_PREFIX)
        self.assertEqual(
            Path(create.call_args.kwargs["dir"]), filesystem.filesystem_path(target.parent)
        )
        self.assertEqual(list(filesystem.filesystem_path(self.work).glob(".tmp-*")), [])

    def test_temporary_name_does_not_overflow_a_valid_leaf(self):
        target = self.work / ("a" * 245 + ".json")
        io_utils.atomic_write_json(target, {"saved": True})
        self.assertEqual(io_utils.read_json(target), {"saved": True})

    def test_failed_replace_keeps_old_content_and_removes_temporary(self):
        target = self.work / "result.json"
        io_utils.atomic_write_json(target, {"revision": 1})
        failure = PermissionError(errno.EACCES, "synthetic permission error", str(target))
        with mock.patch.object(io_utils.os, "replace", side_effect=failure):
            with self.assertRaises(PermissionError):
                io_utils.atomic_write_json(target, {"revision": 2})
        self.assertEqual(io_utils.read_json(target), {"revision": 1})
        self.assertEqual(list(filesystem.filesystem_path(self.work).glob(".tmp-*")), [])

    def test_serialization_failure_removes_temporary(self):
        target = self.work / "result.json"
        with self.assertRaises(TypeError):
            io_utils.atomic_write_json(target, {"invalid": object()})
        self.assertFalse(filesystem.path_exists(target))
        self.assertEqual(list(filesystem.filesystem_path(self.work).glob(".tmp-*")), [])

    def test_text_and_missing_input(self):
        target = self.work / "report.md"
        io_utils.atomic_write_text(target, "结果\n")
        self.assertEqual(filesystem.filesystem_path(target).read_text(encoding="utf-8"), "结果\n")
        with self.assertRaises(ValueError) as caught:
            io_utils.read_json(self.work / "missing.json")
        self.assertEqual(filesystem.error_details(caught.exception)["errno"], errno.ENOENT)

    def test_existing_search_state_is_not_reinitialized(self):
        initial = state.initialize(self.work)
        initial["searched_queries"] = ["saved-query"]
        io_utils.atomic_write_json(self.work / "state.json", initial)
        pool = {"papers": [{"id": "123", "title": "Saved paper"}]}
        io_utils.atomic_write_json(self.work / "pool.json", pool)
        self.assertEqual(state.initialize(self.work)["searched_queries"], ["saved-query"])
        self.assertEqual(io_utils.read_json(self.work / "pool.json"), pool)

    def test_retrieval_policy_reads_existing_long_path_state(self):
        dispatch = {"profile": "balance"}
        request = {"run_id": "test-run"}
        query = {"query": "saved-query", "status": "success"}
        io_utils.atomic_write_json(self.work / "dispatch.json", dispatch)
        io_utils.atomic_write_json(self.work.parent / "request.json", request)
        io_utils.atomic_write_json(self.work / "query-log.json", {"queries": [query]})
        self.assertEqual(execution_policy.context(self.work), (request, {}, dispatch, "balance"))
        self.assertEqual(execution_policy.query_history(self.work), [query])

    def test_real_stage_and_worker_cli_in_long_directory(self):
        skill = Path(worker.__file__).resolve().parents[2]
        request = self.root / "request.txt"
        request.write_text("Find papers on learning to optimize.", encoding="utf-8")
        stage_script = skill / "scripts" / "stage.py"

        def invoke(script, *arguments):
            completed = subprocess.run(
                [sys.executable, str(script), *map(str, arguments)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=30,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
            return json.loads(completed.stdout)

        started = invoke(stage_script, "start", "--work-dir", self.work, "--request-file", request)
        intent_file = Path(started["intent_file"])
        intent = io_utils.read_json(intent_file)
        intent.update(confirmed=True, confirmation_source="user_explicit")
        io_utils.atomic_write_json(intent_file, intent)
        dispatched = invoke(
            stage_script,
            "search",
            "--run-dir",
            started["run_dir"],
            "--intent",
            intent_file,
            "--profile",
            "balance",
        )
        work = Path(dispatched["inputs"]["work_dir"])
        scope = ["--work-dir", str(work), "--token", dispatched["token"]]
        first = invoke(Path(worker.__file__), "context", *scope)
        restored = invoke(
            Path(worker.__file__), "read-output", *scope, "--input", first["snapshot"]
        )
        self.assertEqual(restored["snapshot"], first["snapshot"])
        self.assertTrue(filesystem.path_exists(work / first["snapshot"]))
        self.assertGreater(len(str(work / first["snapshot"])), 260)
        self.assertNotIn("\\\\?\\", first["snapshot"])

    def test_containment_rejects_parent_escape(self):
        for locate in (worker.artifact, stage_guard.contained):
            with self.subTest(function=locate), self.assertRaises(ValueError):
                locate(self.work, "../outside.json")

    @unittest.skipIf(os.name == "nt", "symlink creation needs separate Windows privileges")
    def test_containment_rejects_symlink_escape(self):
        (self.work / "escape").symlink_to(self.root, target_is_directory=True)
        for locate in (worker.artifact, stage_guard.contained):
            with self.subTest(function=locate), self.assertRaises(ValueError):
                locate(self.work, "escape/outside.json")


class LongPathDownloadTests(unittest.TestCase):
    """Download-move and verification boundaries survive MAX_PATH run directories."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.addCleanup(shutil.rmtree, filesystem.filesystem_path(self.root))
        self.run_dir = (
            self.root / ("nested-" * 9) / ("papers-" * 9) / ("session-" * 9) / "work" / "run"
        )
        filesystem.filesystem_path(self.run_dir).mkdir(parents=True)
        self.long_title = "long title fixture " * 10

    def _write_source_pdf(self, payload: bytes) -> Path:
        source = self.run_dir / "downloads" / "paper-dl-work" / "attempt" / "acquired.pdf"
        filesystem.filesystem_path(source).parent.mkdir(parents=True, exist_ok=True)
        filesystem.filesystem_path(source).write_bytes(payload)
        return source

    def _download(self, payload: bytes = b"%PDF-1.4 long path fixture\n") -> dict:
        paper = {"id": "p1", "title": self.long_title, "doi": "10.0000/fixture"}
        external = {
            "status": "success",
            "content_type": "pdf",
            "original_path": str(self._write_source_pdf(payload)),
        }
        return paid_download_adapter.result_item(paper, external, self.run_dir)

    def test_invalid_external_path_uses_existing_ledger(self):
        downloaded = self._download()
        paper = {"id": "p1", "title": self.long_title, "doi": "10.0000/fixture"}
        invalid_path = self.run_dir / "downloads" / "NUL.pdf"
        original_filesystem_path = paid_download_adapter.filesystem_path

        def convert(path):
            if Path(path).name == invalid_path.name:
                raise ValueError("invalid Windows path")
            return original_filesystem_path(path)

        with mock.patch.object(paid_download_adapter, "filesystem_path", side_effect=convert):
            recovered = paid_download_adapter.result_item(
                paper,
                {"status": "success", "content_type": "pdf", "original_path": str(invalid_path)},
                self.run_dir,
            )
        self.assertEqual(recovered["status"], "downloaded")
        self.assertEqual(recovered["file_path"], downloaded["file_path"])

    def test_external_path_outside_run_is_ignored(self):
        outside_path = self.root / "outside.pdf"
        outside_path.write_bytes(b"%PDF-outside")
        paper = {"id": "p1", "title": self.long_title, "doi": "10.0000/fixture"}
        result = paid_download_adapter.result_item(
            paper,
            {"status": "success", "content_type": "pdf", "original_path": str(outside_path)},
            self.run_dir,
        )
        self.assertEqual(result["status"], "failed")
        self.assertTrue(outside_path.is_file())

    @unittest.skipUnless(os.name == "nt", "requires native Windows filename validation")
    def test_native_invalid_external_path_uses_existing_ledger(self):
        downloaded = self._download()
        paper = {"id": "p1", "title": self.long_title, "doi": "10.0000/fixture"}
        recovered = paid_download_adapter.result_item(
            paper,
            {
                "status": "success",
                "content_type": "pdf",
                "original_path": str(self.run_dir / "downloads" / "NUL.pdf"),
            },
            self.run_dir,
        )
        self.assertEqual(recovered["status"], "downloaded")
        self.assertEqual(recovered["file_path"], downloaded["file_path"])

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_placeholder_pdf_and_manifest_verification_on_long_path(self):
        relative = io_utils.title_pdf_relative_path(self.long_title, "p1", set())
        target = self.run_dir / relative
        self.assertGreater(len(str(target)), 260)
        io_utils.write_placeholder_pdf(target, "p1", self.long_title)
        self.assertTrue(filesystem.path_exists(target))
        with filesystem.filesystem_path(target).open("rb") as handle:
            self.assertEqual(handle.read(5), b"%PDF-")
        self.assertTrue(
            post_open_gate.verified_manifest_download(
                {"status": "downloaded", "verified_exists": True, "file_path": relative.as_posix()},
                self.run_dir,
            )
        )
        self.assertFalse(
            post_open_gate.verified_manifest_download(
                {
                    "status": "downloaded",
                    "verified_exists": True,
                    "file_path": "downloads/papers/missing.pdf",
                },
                self.run_dir,
            )
        )
        plain = self.run_dir / "downloads" / "papers" / ("plain-" + "b" * 80 + ".txt")
        filesystem.filesystem_path(plain).parent.mkdir(parents=True, exist_ok=True)
        filesystem.filesystem_path(plain).write_bytes(b"not a pdf")
        self.assertFalse(
            post_open_gate.verified_manifest_download(
                {
                    "status": "downloaded",
                    "verified_exists": True,
                    "file_path": plain.relative_to(self.run_dir).as_posix(),
                },
                self.run_dir,
            )
        )

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_paid_adapter_moves_and_ledger_binds_long_path_pdf(self):
        payload = b"%PDF-1.4 long path fixture\n"
        item = self._download(payload)
        self.assertEqual(item["status"], "downloaded")
        self.assertTrue(item["verified_exists"])
        destination = self.run_dir / item["file_path"]
        self.assertGreater(len(str(destination)), 260)
        self.assertTrue(filesystem.path_exists(destination))
        self.assertFalse(
            filesystem.path_exists(
                self.run_dir / "downloads" / "paper-dl-work" / "attempt" / "acquired.pdf"
            )
        )
        self.assertTrue(post_open_gate.verified_manifest_download(item, self.run_dir))
        ledger = io_utils.read_json(self.run_dir / "downloads" / "paper-dl-files.json")
        (record,) = ledger["files"].values()
        self.assertEqual(record["paper_id"], "p1")
        self.assertEqual(record["file_path"], item["file_path"])
        self.assertEqual(record["sha256"], hashlib.sha256(payload).hexdigest())

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_paid_adapter_recovers_bound_pdf_after_source_report_lost(self):
        first = self._download()
        self.assertEqual(first["status"], "downloaded")
        paper = {"id": "p1", "title": self.long_title, "doi": "10.0000/fixture"}
        external = {"status": "success", "content_type": "pdf"}
        recovered = paid_download_adapter.result_item(paper, external, self.run_dir)
        self.assertEqual(recovered["status"], "downloaded")
        self.assertTrue(recovered["verified_exists"])
        self.assertEqual(recovered["file_path"], first["file_path"])

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_paid_adapter_keeps_existing_long_path_pdf_when_titles_collide(self):
        existing_relative = io_utils.title_pdf_relative_path(self.long_title, "other", set())
        existing = self.run_dir / existing_relative
        filesystem.filesystem_path(existing).parent.mkdir(parents=True, exist_ok=True)
        filesystem.filesystem_path(existing).write_bytes(b"%PDF-old")
        item = self._download(b"%PDF-1.4 second paper\n")
        self.assertEqual(item["status"], "downloaded")
        self.assertNotEqual(item["file_path"], existing_relative.as_posix())
        with filesystem.filesystem_path(existing).open("rb") as handle:
            self.assertEqual(handle.read(8), b"%PDF-old")

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_run_lock_acquires_in_long_run_directory(self):
        with browser_pool.run_lock(self.run_dir):
            pass
        self.assertTrue(filesystem.path_exists(self.run_dir / "downloads" / ".paid-download.lock"))

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_open_download_placeholder_cli_in_long_run_directory(self):
        skill = ROOT / "skills" / "community" / "precise-literature-search"
        metadata_relative = Path("downloads") / "metadata.json"
        io_utils.atomic_write_json(
            self.run_dir / metadata_relative,
            {
                "run_id": "long-run",
                "papers": [{"id": "p1", "title": self.long_title, "open_access": "yes"}],
            },
        )
        selection_path = self.run_dir / "downloads" / "selection.json"
        io_utils.atomic_write_json(
            selection_path,
            {
                "run_id": "long-run",
                "confirmed_by_user": True,
                "download_open": True,
                "metadata_path": metadata_relative.as_posix(),
                "selected_paper_ids": ["p1"],
            },
        )
        output_path = self.run_dir / "downloads" / "open-download-manifest.json"
        completed = subprocess.run(
            [
                sys.executable,
                str(skill / "modules" / "open-download" / "placeholder.py"),
                "--input",
                str(selection_path),
                "--output",
                str(output_path),
                "--run-dir",
                str(self.run_dir),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        manifest = io_utils.read_json(output_path)
        (item,) = manifest["papers"]
        self.assertEqual(item["status"], "downloaded")
        self.assertTrue(item["verified_exists"])
        self.assertGreater(len(str(self.run_dir / item["file_path"])), 260)
        self.assertTrue(post_open_gate.verified_manifest_download(item, self.run_dir))

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_paid_download_placeholder_resume_cli_in_long_run_directory(self):
        skill = ROOT / "skills" / "community" / "precise-literature-search"
        metadata_relative = Path("downloads") / "metadata.json"
        io_utils.atomic_write_json(
            self.run_dir / metadata_relative,
            {
                "run_id": "long-run",
                "papers": [
                    {
                        "id": "p1",
                        "title": self.long_title,
                        "open_access": "unknown",
                        "doi": "10.0000/fixture",
                    }
                ],
            },
        )
        selection_path = self.run_dir / "downloads" / "selection.json"
        io_utils.atomic_write_json(
            selection_path,
            {
                "run_id": "long-run",
                "confirmed_by_user": True,
                "download_paid": True,
                "metadata_path": metadata_relative.as_posix(),
                "selected_paper_ids": ["p1"],
            },
        )
        output_path = self.run_dir / "downloads" / "paid-download-manifest.json"
        command = [
            sys.executable,
            str(skill / "modules" / "paid-download" / "placeholder.py"),
            "--input",
            str(selection_path),
            "--output",
            str(output_path),
            "--run-dir",
            str(self.run_dir),
        ]
        first = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        first_manifest = io_utils.read_json(output_path)
        self.assertEqual(first_manifest["status"], "action_required")
        resumed = subprocess.run(
            command + ["--resume"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        self.assertEqual(resumed.returncode, 0, resumed.stderr + resumed.stdout)
        manifest = io_utils.read_json(output_path)
        (item,) = manifest["papers"]
        self.assertEqual(item["status"], "downloaded")
        self.assertTrue(item["verified_exists"])
        self.assertGreater(len(str(self.run_dir / item["file_path"])), 260)


class PaperDlLibraryPathTests(unittest.TestCase):
    """The downloader's native-path cache root and pre-flight budget guard."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.run_dir = self.root / "run"
        self.run_dir.mkdir()

    def test_library_root_is_short_by_construction(self):
        root = paid_download_adapter.paper_dl_library_root()
        self.assertTrue(root.is_absolute())
        self.assertEqual(root, Path.home().joinpath(*paid_download_adapter.LIBRARY_HOME_PARTS))
        self.assertLess(len(str(root)), filesystem.WINDOWS_PATH_BUDGET)

    @unittest.skipUnless(os.name == "nt", "requires native Windows path budget")
    def test_guard_passes_incident_shaped_run_directory(self):
        storage = paid_download_adapter.paper_dl_library_root()
        base = Path(tempfile.gettempdir()).resolve()
        filler = "d" * (153 - len(str(base)) - 1)
        run_dir = base / filler
        self.assertEqual(len(str(run_dir)), 153)
        attempt = run_dir / "downloads" / "paper-dl-logs" / "paper-dl-attempts" / "abc123456789"
        paid_download_adapter.ensure_paper_dl_paths_fit_budget(storage, attempt)

    @unittest.skipUnless(os.name == "nt", "requires native Windows path budget")
    def test_guard_fails_deep_attempt_paths_with_named_state(self):
        storage = paid_download_adapter.paper_dl_library_root()
        base = Path(tempfile.gettempdir()).resolve()
        deep = base / ("n" * 220)
        attempt = deep / "downloads" / "paper-dl-logs" / "paper-dl-attempts" / "abc123456789"
        with self.assertRaises(ValueError) as ctx:
            paid_download_adapter.ensure_paper_dl_paths_fit_budget(storage, attempt)
        self.assertIn(paid_download_adapter.LONG_PATH_STATE, str(ctx.exception))

    def test_result_item_moves_reported_library_pdf_into_papers(self):
        library = self.root / "library"
        source = library / "10.0000_fixture--0123456789abcdef" / "original.pdf"
        source.parent.mkdir(parents=True)
        payload = b"%PDF-1.4 relocated library fixture\n"
        source.write_bytes(payload)
        with mock.patch.object(
            paid_download_adapter, "paper_dl_library_root", return_value=library
        ):
            item = paid_download_adapter.result_item(
                {"id": "p1", "title": "Library sourced paper", "doi": "10.0000/fixture"},
                {"status": "success", "content_type": "pdf", "original_path": str(source)},
                self.run_dir,
            )
        self.assertEqual(item["status"], "downloaded")
        self.assertTrue(item["verified_exists"])
        destination = self.run_dir / item["file_path"]
        self.assertTrue(filesystem.path_exists(destination))
        self.assertFalse(filesystem.path_exists(source))

    def test_result_item_still_ignores_untrusted_outside_paths(self):
        outside = self.root / "outside" / "original.pdf"
        outside.parent.mkdir(parents=True)
        outside.write_bytes(b"%PDF-1.4 outside\n")
        with mock.patch.object(
            paid_download_adapter,
            "paper_dl_library_root",
            return_value=self.root / "library",
        ):
            item = paid_download_adapter.result_item(
                {"id": "p1", "title": "Outside paper", "doi": "10.0000/fixture"},
                {"status": "success", "content_type": "pdf", "original_path": str(outside)},
                self.run_dir,
            )
        self.assertEqual(item["status"], "failed")
        self.assertTrue(filesystem.path_exists(outside))


class PostOpenGateRoutingTests(unittest.TestCase):
    """Paid routing must not mix extended and ordinary run-directory path forms."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.addCleanup(shutil.rmtree, filesystem.filesystem_path(self.root))
        self.gate = (
            ROOT
            / "skills"
            / "community"
            / "precise-literature-search"
            / "scripts"
            / "post_open_gate.py"
        )

    @staticmethod
    def _paper(paper_id: str, arxiv_id: str | None) -> dict:
        record = {
            "id": paper_id,
            "title": f"Title {paper_id}",
            "authors": ["Author"],
            "year": 2025,
            "abstract": "abstract",
            "doi": f"10.1/{paper_id}",
            "venue": "venue",
            "open_access": "yes" if arxiv_id else "no",
            "source": "paperhub",
            "relevance": {"reasons": ["fixture"]},
            "is_placeholder": False,
            "document_type": "paper",
            "identity_status": "verified",
        }
        if arxiv_id:
            record["arxiv_id"] = arxiv_id
        return record

    def _build_run(self, decision_source: str, long_run: bool) -> Path:
        work = (
            self.root / ("nested-" * 11) / ("papers-" * 9) / ("session-" * 9) / "work"
            if long_run
            else self.root / "work"
        )
        filesystem.filesystem_path(work).mkdir(parents=True, exist_ok=True)
        run_dir = run_state.initialize_run(work, "post-open gate routing")
        run_id = run_dir.name
        selection = {
            "schema_version": "1.1",
            "run_id": run_id,
            "metadata_path": "search/round-001/metadata.json",
            "selected_paper_ids": ["p1", "p3"],
            "download_open": True,
            "download_paid": True,
            "read_after_download": True,
            "confirmed_by_user": True,
            "decision_source": decision_source,
        }
        metadata = {
            "schema_version": "1.0",
            "run_id": run_id,
            "round": 1,
            "query_summary": "post-open gate routing",
            "generated_at": io_utils.utc_now(),
            "status": "success",
            "is_placeholder": False,
            "papers": [self._paper("p1", "2401.00001"), self._paper("p3", None)],
            "warnings": [],
        }
        manifest = open_download_adapter.build_manifest(
            selection,
            metadata,
            run_dir,
            {
                "ok": True,
                "storage": "managed",
                "refs": ["paper:p1"],
                "papers": [
                    {
                        "paper_id": "p1",
                        "ref": "paper:p1",
                        "revision": "sha256:" + "a" * 64,
                        "source_kind": "arxiv",
                    }
                ],
                "failures": [
                    {"paper_id": "p3", "code": "acquire_download_failed", "reason": "upstream 500"}
                ],
                "manifest": {"selected": 2, "downloaded": 1, "failed": 1, "skipped": 0},
            },
        )
        io_utils.atomic_write_json(run_dir / "downloads" / "selection.json", selection)
        io_utils.atomic_write_json(run_dir / "search" / "round-001" / "metadata.json", metadata)
        io_utils.atomic_write_json(run_dir / "downloads" / "manifest.json", manifest)
        record = run_state.read_state(run_dir)
        record["status"] = "DOWNLOADING_OPEN"
        record["events"].append(
            {
                "timestamp": io_utils.utc_now(),
                "from": "INITIALIZED",
                "to": "DOWNLOADING_OPEN",
                "message": "gate routing fixture",
            }
        )
        run_state.write_state(run_dir, record)
        return run_dir

    def _run_gate(self, run_dir: Path) -> dict:
        completed = subprocess.run(
            [
                sys.executable,
                str(self.gate),
                "--run-dir",
                str(run_dir),
                "--selection",
                str(run_dir / "downloads" / "selection.json"),
                "--manifest",
                str(run_dir / "downloads" / "manifest.json"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        return json.loads(completed.stdout)

    def _assert_routed(self, run_dir: Path, decision: dict, action: str, status: str) -> None:
        self.assertEqual(decision["next_action"], action)
        self.assertEqual(decision["pending_paper_ids"], ["p3"])
        record = run_state.read_state(run_dir)
        self.assertEqual(record["status"], status)
        self.assertEqual(record["paths"]["selection"], "downloads/selection.json")
        self.assertEqual(record["paths"]["download_manifest"], "downloads/manifest.json")

    def test_start_paid_download_routes_with_run_relative_paths(self):
        run_dir = self._build_run("auto_delegated", long_run=False)
        self._assert_routed(
            run_dir,
            self._run_gate(run_dir),
            "start_paid_download",
            "DOWNLOADING_PAID",
        )

    def test_confirm_paid_download_routes_with_run_relative_paths(self):
        run_dir = self._build_run("user_explicit", long_run=False)
        self._assert_routed(
            run_dir,
            self._run_gate(run_dir),
            "confirm_paid_download",
            "PAID_DOWNLOAD_PENDING",
        )

    @unittest.skipUnless(os.name == "nt", "requires native Windows MAX_PATH boundaries")
    def test_paid_routing_survives_long_run_directory(self):
        for decision_source, action, status in (
            ("auto_delegated", "start_paid_download", "DOWNLOADING_PAID"),
            ("user_explicit", "confirm_paid_download", "PAID_DOWNLOAD_PENDING"),
        ):
            with self.subTest(decision_source=decision_source):
                run_dir = self._build_run(decision_source, long_run=True)
                self.assertGreater(len(str(run_dir)), 260)
                self._assert_routed(run_dir, self._run_gate(run_dir), action, status)


class StageBindingTests(unittest.TestCase):
    def test_claim_reuses_contained_paths_and_preserves_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            inputs = [Path("request.txt"), root / "intent.json"]
            for input_path in inputs:
                (root / input_path).write_text(str(input_path), encoding="utf-8")
            expected = {
                str((root / input_path).relative_to(root)): stage_guard.digest(root / input_path)
                for input_path in inputs
            }
            with (
                mock.patch.object(stage_guard, "require_run"),
                mock.patch.object(stage_guard, "contained", wraps=stage_guard.contained) as locate,
                mock.patch.object(
                    stage_guard, "canonical_path", wraps=stage_guard.canonical_path
                ) as resolve,
            ):
                lease = stage_guard.claim_stage(root, "search", 1, inputs)
            self.assertEqual(lease["input_sha256"], expected)
            self.assertEqual(io_utils.read_json(root / "stage-lease.json"), lease)
            for input_path in inputs:
                self.assertEqual(locate.call_args_list.count(mock.call(root, input_path)), 1)
            self.assertEqual(resolve.call_count, 2 * len(inputs) + 3)

    def test_claim_rejects_escaping_input_without_publishing_lease(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with (
                mock.patch.object(stage_guard, "require_run"),
                self.assertRaisesRegex(ValueError, "escapes run directory"),
            ):
                stage_guard.claim_stage(root, "search", 1, [Path("../outside.txt")])
            self.assertFalse((root / "stage-lease.json").exists())

    def test_claim_without_inputs_preserves_empty_bindings(self):
        for inputs in (None, []):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                with mock.patch.object(stage_guard, "require_run"):
                    lease = stage_guard.claim_stage(root, "search", 1, inputs)
                self.assertEqual(lease["input_sha256"], {})


class WorkerErrorTests(unittest.TestCase):
    def test_non_mapping_details_do_not_hide_original_failure(self):
        for details in (
            None,
            "unexpected",
            [],
            {"field": "title"},
            MappingProxyType({"field": "title"}),
        ):
            with self.subTest(details=details):
                primary = ValueError("original failure")
                primary.details = details
                output = io.StringIO()
                argv = ["worker.py", "context", "--work-dir", "work", "--token", "test-token"]
                with (
                    mock.patch("sys.argv", argv),
                    mock.patch.object(worker, "run", side_effect=primary),
                    mock.patch.object(worker, "transaction", return_value=nullcontext()),
                    mock.patch.object(worker, "budget_status", return_value={}),
                    mock.patch.object(worker, "record_page", side_effect=lambda work, value: value),
                    mock.patch.dict(os.environ),
                    redirect_stdout(output),
                ):
                    self.assertEqual(worker.main(), 2)
                error = json.loads(output.getvalue())["error"]
                self.assertEqual(error["message"], "original failure")
                self.assertEqual(
                    error["details"],
                    {"field": "title"} if details and not isinstance(details, str) else {},
                )

    def test_snapshot_failure_keeps_original_os_error(self):
        primary = FileNotFoundError(errno.ENOENT, "original write failed", "x" * 284)
        secondary = PermissionError(errno.EACCES, "error snapshot failed", "another-file")
        argv = ["worker.py", "context", "--work-dir", "work", "--token", "test-token"]
        output = io.StringIO()
        with (
            mock.patch("sys.argv", argv),
            mock.patch.object(worker, "run", side_effect=primary),
            mock.patch.object(worker, "transaction", side_effect=secondary),
            mock.patch.dict(os.environ),
            redirect_stdout(output),
        ):
            self.assertEqual(worker.main(), 2)
        error = json.loads(output.getvalue())["error"]
        self.assertEqual(error["details"]["errno"], errno.ENOENT)
        self.assertEqual(error["details"]["path_characters"], 284)
        self.assertEqual(error["details"]["snapshot_error"]["errno"], errno.EACCES)
        self.assertNotIn("test-token", output.getvalue())


if __name__ == "__main__":
    unittest.main()
