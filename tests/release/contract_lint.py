"""Exercise the actual lint tools and repository gates on isolated source files."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts import lint

ROOT = Path(__file__).resolve().parents[2]
TIMEOUT_SECONDS = 120
VALID_SOURCE = '''"""Valid inference across an unannotated factory."""


def factory():
    return 7


def render() -> int:
    return factory().bit_length()
'''
INVALID_SOURCE = '''"""Semantic and syntax regressions."""

from collections.abc import Mapping
import unavailable_lint_probe_dependency


def factory():
    return 7


def broken() -> int:
    return factory().missing_attribute


def invalid_call() -> int:
    return factory().bit_length(1)


def missing_call() -> int:
    return need_argument()


def need_argument(value: int) -> int:
    return value


def nonexistent() -> int:
    return missing_variable


def mutable(values: Mapping[str, int] = {}) -> int:
    return len(values)


def pointless() -> int:
    """Actual docstring."""
    "a string that does nothing"
    return 1


def type_comparison(value: object) -> bool:
    return type(value) is int


def local_import() -> str:
    import sys

    return sys.version


def invalid_raise() -> None:
    raise 7


def invalid_context() -> None:
    with 7:
        pass


def invalid_iteration() -> None:
    for value in 7:
        print(value)
'''


class LintContracts(unittest.TestCase):
    def run_lint(self, source: str, prefix: bool = False) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory(prefix="scholarseed lint ") as directory:
            root = Path(directory)
            (root / "sample.py").write_text(source, encoding="utf-8")
            generated = root / "apps/serve/service/capabilities/skills/pack"
            generated.mkdir(parents=True)
            (generated / "generated.py").write_text(
                "this is not valid python !!!", encoding="utf-8"
            )
            subprocess.run(["git", "init", "--quiet", str(root)], check=True)
            if prefix:
                (root / "settings.txt").write_text("VEDA_" + "UNSUPPORTED=1\n", encoding="utf-8")
                subprocess.run(["git", "add", "settings.txt"], cwd=root, check=True)
            return subprocess.run(
                [sys.executable, str(ROOT / "scripts/lint.py"), "."],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )

    def test_valid_inferred_return_and_docstrings_pass(self) -> None:
        result = self.run_lint(VALID_SOURCE)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_all_checks_run_even_after_syntax_failure(self) -> None:
        result = self.run_lint(INVALID_SOURCE, prefix=True)
        self.assertNotEqual(result.returncode, 0)
        output = result.stdout + result.stderr
        for diagnostic in (
            "missing_attribute",
            "reportAttributeAccessIssue",
            "reportCallIssue",
            "missing_variable",
            "import-outside-top-level",
            "reportMissingImports",
            "reportGeneralTypeIssues",
            lint.MUTABLE_DEFAULT,
            lint.POINTLESS_STRING,
            lint.TYPE_COMPARISON,
            "env-prefix:",
        ):
            with self.subTest(diagnostic=diagnostic):
                self.assertIn(diagnostic, output)

    def test_configuration_excludes_generated_sources_and_dependencies(self) -> None:
        patterns = [
            "apps/serve/service/capabilities/skills",
            "**/node_modules",
            "packages/damoatrace",
        ]
        for name in (
            "apps/serve/service/capabilities/skills/pack/broken.py",
            "apps/desktop/node_modules/package/broken.py",
            "packages/damoatrace/damoatrace/trace.py",
        ):
            self.assertTrue(lint._is_excluded(Path.cwd() / name, patterns))
        self.assertFalse(lint._is_excluded(Path.cwd() / "scripts/lint.py", patterns))

    def test_argument_batches_preserve_paths_and_windows_budget(self) -> None:
        paths = [Path("folder with spaces") / f"source_{number}.py" for number in range(1500)]
        batches = list(lint._batches(paths))
        self.assertGreater(len(batches), 1)
        self.assertEqual([name for batch in batches for name in batch], list(map(str, paths)))
        for batch in batches:
            size = len(subprocess.list2cmdline(batch).encode("utf-16-le")) // 2
            self.assertLessEqual(size, lint.ARGUMENT_BUDGET)

    def test_syntax_gate_preserves_attribute_docs_and_explicit_exceptions(self) -> None:
        source = '''"""Module documentation."""
VALUE = 1
"""Attribute documentation."""

def check(value):
    """Function documentation."""
    return type(value) is int  # noqa: SS003
'''
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            path.write_text(source, encoding="utf-8")
            self.assertEqual(lint._syntax_issues(path), [])

    def test_syntax_gate_accepts_encoding_cookie_and_shadowed_type(self) -> None:
        source = '# coding: latin-1\n"""caf\xe9"""\ndef compare(type, value):\n    return type(value) == 3\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.py"
            path.write_bytes(source.encode("latin-1"))
            self.assertEqual(lint._syntax_issues(path), [])


if __name__ == "__main__":
    unittest.main()
