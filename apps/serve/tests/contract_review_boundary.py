"""Native DOCX redline and the Documents review owner must not return."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from service.bootstrap import create_app

ROOT = Path(__file__).resolve().parents[3]
REMOVED_PATHS = (
    "apps/serve/service/documents",
    "apps/serve/service/workbench/redline",
    "apps/serve/service/workbench/api/redline.py",
    "apps/serve/service/cli/redline.py",
    "apps/desktop/src/renderer/src/features/workbench/redline.ts",
    "apps/desktop/src/renderer/src/contracts/documents.ts",
    "apps/desktop/src/renderer/src/features/changes",
    "apps/desktop/e2e/workbench-redline.spec.ts",
)
REMOVED_REFERENCES = (
    "service.documents",
    "service.platform.mutations",
    "contracts/documents",
    "features/changes/",
    "../changes/",
    "changesFeature",
    "service.workbench.redline",
    "service.workbench.api.redline",
    "service.cli.redline",
    "register_review_routes",
    "/api/workbench/docx/redline",
    "/api/review",
)
REMOVED_ROUTE_PREFIXES = ("/api/workbench/docx/redline", "/api/review")
RENDERER_EXTENSIONS = frozenset((".ts", ".tsx"))


class ReviewBoundaryTests(unittest.TestCase):
    def test_removed_owners_and_entrypoints_are_absent(self) -> None:
        for relative in REMOVED_PATHS:
            with self.subTest(path=relative):
                path = ROOT / relative
                if path.is_dir():
                    # Python's orphaned __pycache__ is not an importable source owner.
                    self.assertFalse(
                        [
                            item
                            for item in path.rglob("*")
                            if item.is_file()
                            and not ("__pycache__" in item.parts and item.suffix == ".pyc")
                        ]
                    )
                else:
                    self.assertFalse(path.exists())

    def test_product_sources_have_no_legacy_import_or_route_references(self) -> None:
        sources = tuple((ROOT / "apps/serve/service").rglob("*.py")) + tuple(
            path
            for path in (ROOT / "apps/desktop/src/renderer/src").rglob("*")
            if path.suffix in RENDERER_EXTENSIONS
        )
        for path in sources:
            source = path.read_text(encoding="utf-8")
            for reference in REMOVED_REFERENCES:
                with self.subTest(path=str(path.relative_to(ROOT)), reference=reference):
                    self.assertNotIn(reference, source)

    def test_native_ui_and_test_registrations_remain_removed(self) -> None:
        sources = (
            ROOT / "apps/desktop/package.json",
            ROOT / "apps/desktop/playwright.config.ts",
            ROOT / "apps/serve/tests/run_all.py",
            *(ROOT / "apps/desktop/src/renderer/src/features/workbench").rglob("*.ts"),
            *(ROOT / "apps/desktop/src/renderer/src/features/workbench").rglob("*.tsx"),
        )
        for path in sources:
            with self.subTest(path=str(path.relative_to(ROOT))):
                self.assertNotIn("redline", path.read_text(encoding="utf-8").lower())

    def test_composed_http_app_exposes_no_removed_review_routes(self) -> None:
        with tempfile.TemporaryDirectory() as home:
            app = create_app(Path(home))
            paths = {getattr(route, "path", "") for route in app.routes}
            self.assertTrue(any(path.startswith("/api/resource") for path in paths))
            self.assertFalse(any(path.startswith(REMOVED_ROUTE_PREFIXES) for path in paths), paths)


if __name__ == "__main__":
    unittest.main()
