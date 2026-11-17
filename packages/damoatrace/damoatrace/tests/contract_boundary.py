"""DamoATrace dependency and namespace boundary contract."""

from __future__ import annotations

import ast
import pathlib
import unittest

FORBIDDEN_ROOTS = (
    "damoagent",
    "scholarseed_runtime",
    "scholarseed_codex",
    "scholarseed_dsh",
    "service",
    "ui",
    "launcher",
    "veda",
    "tracekit",
)


def _forbidden(module: str) -> bool:
    return any(module == root or module.startswith(root + ".") for root in FORBIDDEN_ROOTS)


class BoundaryContracts(unittest.TestCase):
    def test_package_is_independent(self) -> None:
        package = pathlib.Path(__file__).resolve().parents[1]
        violations: list[str] = []
        for path in sorted(package.rglob("*.py")):
            tree = ast.parse(path.read_text("utf-8"))
            for node in ast.walk(tree):
                modules: list[str] = []
                if isinstance(node, ast.Import):
                    modules.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom) and node.level == 0:
                    modules.append(node.module or "")
                for module in modules:
                    if _forbidden(module):
                        violations.append(f"{path.relative_to(package)}:{node.lineno} {module}")

        self.assertFalse(violations, "\n".join(violations))


if __name__ == "__main__":
    unittest.main()
