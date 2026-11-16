"""Exercise the actual lint tools and repository gates on isolated source files."""

from __future__ import annotations

import ast
import subprocess
import sys
import tempfile
import tomllib
import unittest
import zipfile
from pathlib import Path

from scripts.ci import lint

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
                [sys.executable, str(ROOT / "scripts/ci/lint.py"), "."],
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
            "__lint_contract__/node_modules/package/broken.py",
            "packages/damoatrace/damoatrace/trace.py",
        ):
            self.assertTrue(lint._is_excluded(Path.cwd() / name, patterns))
        self.assertFalse(lint._is_excluded(Path.cwd() / "scripts/ci/lint.py", patterns))

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


class L1TypingContracts(unittest.TestCase):
    def test_dataclass_types_match_the_reviewed_wheel(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        wheel = ROOT / project["tool"]["uv"]["sources"]["deep-rnd-l1"]["path"]
        stub = ast.parse(
            (ROOT / "apps/serve/typings/knowledge_layer/comprehend/__init__.pyi").read_text()
        )
        with zipfile.ZipFile(wheel) as archive:
            source = ast.parse(archive.read("knowledge_layer/comprehend/options.py"))
        for name in ("ExtractionOptions", "SourceImage"):
            declarations = []
            for module in (source, stub):
                model = next(
                    node
                    for node in module.body
                    if isinstance(node, ast.ClassDef) and node.name == name
                )
                fields = [
                    (node.target.id, ast.dump(node.annotation), node.value is not None)
                    for node in model.body
                    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                ]
                frozen = any(
                    isinstance(decorator, ast.Call)
                    and any(
                        keyword.arg == "frozen"
                        and isinstance(keyword.value, ast.Constant)
                        and keyword.value.value is True
                        for keyword in decorator.keywords
                    )
                    for decorator in model.decorator_list
                )
                declarations.append((fields, frozen))
            self.assertEqual(declarations[0], declarations[1], name)

    def test_extraction_call_shape_matches_the_reviewed_wheel(self) -> None:
        project = tomllib.loads((ROOT / "pyproject.toml").read_text())
        wheel = ROOT / project["tool"]["uv"]["sources"]["deep-rnd-l1"]["path"]
        with zipfile.ZipFile(wheel) as archive:
            source = ast.parse(archive.read("knowledge_layer/comprehend/api.py"))
        stub = ast.parse(
            (ROOT / "apps/serve/typings/knowledge_layer/comprehend/__init__.pyi").read_text()
        )
        signatures = []
        for module in (source, stub):
            function = next(
                node
                for node in module.body
                if isinstance(node, ast.AsyncFunctionDef) and node.name == "process_single_doc"
            )
            arguments = function.args
            signatures.append(
                (
                    [argument.arg for argument in arguments.posonlyargs],
                    [argument.arg for argument in arguments.args],
                    [argument.arg for argument in arguments.kwonlyargs],
                    len(arguments.defaults),
                    [default is not None for default in arguments.kw_defaults],
                )
            )
        self.assertEqual(signatures[0], signatures[1])


if __name__ == "__main__":
    unittest.main()
