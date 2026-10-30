from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
ADAPTER_PATH = ROOT / "skills/community/precise-literature-search/modules/paid-download/adapter.py"
ADAPTER_SPEC = importlib.util.spec_from_file_location("paid_downloader_contract", ADAPTER_PATH)
adapter = importlib.util.module_from_spec(ADAPTER_SPEC)
ADAPTER_SPEC.loader.exec_module(adapter)


class DownloaderResolutionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="paper-dl contract ")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.environment = mock.patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_optional_config_requires_a_file(self):
        self.assertIsNone(adapter._optional_file_env("PAPER_DL_CONFIG"))
        config = self.root / "paper-dl.yaml"
        config.write_text("zotero: false\n", encoding="utf-8")
        with mock.patch.dict(os.environ, {"PAPER_DL_CONFIG": str(config)}):
            self.assertEqual(adapter._optional_file_env("PAPER_DL_CONFIG"), config)
        for path in (self.root, self.root / "missing.yaml"):
            with (
                self.subTest(path=path),
                mock.patch.dict(os.environ, {"PAPER_DL_CONFIG": str(path)}),
            ):
                with self.assertRaisesRegex(ValueError, "does not name a file"):
                    adapter._optional_file_env("PAPER_DL_CONFIG")

    def test_product_uses_active_python_and_ignores_local_and_path_launchers(self):
        executable = adapter.venv_executable(self.root / ".venv", "paper-dl")
        executable.parent.mkdir(parents=True)
        executable.write_text("#!/missing/build/python\n", encoding="utf-8")
        with (
            mock.patch.dict(os.environ, {"SCHOLARSEED_PYTHON": sys.executable}),
            mock.patch.object(adapter, "SKILL_DIR", self.root),
            mock.patch.object(adapter.shutil, "which", return_value=str(executable)) as which,
            mock.patch.object(adapter, "find_spec", return_value=object()) as discover,
        ):
            self.assertEqual(
                adapter.resolve_paper_dl(),
                ([sys.executable, "-m", "paper_dl"], None, f"{sys.executable} -m paper_dl"),
            )
        discover.assert_called_once_with("paper_dl")
        which.assert_not_called()

    def test_missing_module_reports_dependency_without_external_fallback(self):
        with (
            mock.patch.dict(os.environ, {"SCHOLARSEED_PYTHON": sys.executable}),
            mock.patch.object(adapter, "find_spec", return_value=None),
            mock.patch.object(adapter.shutil, "which") as which,
            self.assertRaisesRegex(
                ValueError, "paper_dl.*not importable.*bundled runtime"
            ) as failure,
        ):
            adapter.resolve_paper_dl()
        self.assertIn("paper_fulltext_dl-0.1.3-py3-none-any.whl", str(failure.exception))
        which.assert_not_called()

    def test_explicit_executable_precedes_source_root_and_module_probe(self):
        executable = self.root / "external downloader.py"
        executable.touch()
        with (
            mock.patch.dict(
                os.environ,
                {
                    "PAPER_DL_EXECUTABLE": str(executable),
                    "PAPER_DL_ROOT": str(self.root / "invalid-source"),
                },
            ),
            mock.patch.object(adapter, "find_spec") as discover,
        ):
            self.assertEqual(
                adapter.resolve_paper_dl(),
                ([sys.executable, str(executable)], None, str(executable)),
            )
        discover.assert_not_called()

    def test_explicit_source_root_retains_its_own_environment(self):
        (self.root / "pyproject.toml").touch()
        executable = adapter.venv_executable(self.root / ".venv", "paper-dl")
        executable.parent.mkdir(parents=True)
        executable.touch()
        with (
            mock.patch.dict(os.environ, {"PAPER_DL_ROOT": str(self.root)}),
            mock.patch.object(adapter, "find_spec") as discover,
        ):
            self.assertEqual(
                adapter.resolve_paper_dl(),
                ([str(executable)], self.root, str(executable)),
            )
        discover.assert_not_called()

    def test_explicit_source_root_retains_uv_command(self):
        (self.root / "pyproject.toml").touch()
        executable = str(self.root / "uv")
        with (
            mock.patch.dict(os.environ, {"PAPER_DL_ROOT": str(self.root)}),
            mock.patch.object(adapter.shutil, "which", return_value=executable),
            mock.patch.object(adapter, "find_spec") as discover,
        ):
            self.assertEqual(
                adapter.resolve_paper_dl(),
                (
                    [executable, "run", "--project", str(self.root), "paper-dl"],
                    self.root,
                    f"uv project {self.root}",
                ),
            )
        discover.assert_not_called()

    def test_invalid_explicit_executable_does_not_fall_back(self):
        with (
            mock.patch.dict(os.environ, {"PAPER_DL_EXECUTABLE": str(self.root / "missing")}),
            mock.patch.object(adapter, "find_spec") as discover,
            self.assertRaisesRegex(ValueError, "PAPER_DL_EXECUTABLE does not name a file"),
        ):
            adapter.resolve_paper_dl()
        discover.assert_not_called()


if __name__ == "__main__":
    unittest.main()
