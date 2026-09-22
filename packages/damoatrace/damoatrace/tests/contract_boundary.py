"""DamoATrace dependency and namespace boundary contract."""

from __future__ import annotations

import ast
import pathlib
import sys

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


def main() -> int:
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

    if violations:
        print("FAIL")
        print("\n".join(violations))
        return 1
    print("PASS: DamoATrace is independent of Runtime, adapters, product and legacy namespaces")
    return 0


if __name__ == "__main__":
    sys.exit(main())
