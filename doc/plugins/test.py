"""Deterministic checks for the generated offline guide."""

from __future__ import annotations

import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote

from build import OUTPUT, PAGES, ROOT, build, render_page


class Inventory(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.links: list[str] = []
        self.assets: list[str] = []
        self.pages: list[str] = []

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        values = dict(attributes)
        if values.get("id"):
            self.ids.append(values["id"])
        if tag == "a" and values.get("href"):
            self.links.append(values["href"])
        if tag in {"img", "script"} and values.get("src"):
            self.assets.append(values["src"])
        if values.get("data-page"):
            self.pages.append(values["data-page"])


class GuideTest(unittest.TestCase):
    def setUp(self) -> None:
        self.content = build()
        self.inventory = Inventory()
        self.inventory.feed(self.content)

    def test_generated_html_is_current(self) -> None:
        self.assertEqual(OUTPUT.read_text(encoding="utf-8"), self.content)

    def test_topics_and_anchor_destinations(self) -> None:
        self.assertEqual(self.inventory.pages, [row[0] for row in PAGES])
        self.assertEqual(len(self.inventory.ids), len(set(self.inventory.ids)))
        for target in self.inventory.links:
            if target.startswith("#"):
                self.assertIn(unquote(target[1:]), self.inventory.ids, target)

    def test_assets_are_local_and_available(self) -> None:
        for target in self.inventory.assets:
            self.assertNotIn("://", target)
            self.assertTrue((ROOT / target).is_file(), target)
        self.assertNotIn('<script src="', self.content)

    def test_content_and_warning_exist_without_running_javascript(self) -> None:
        self.assertIn("破坏兼容性的变更", self.content)
        self.assertIn("plugin-create", self.content)
        self.assertIn("capabilities_unchecked", self.content)
        self.assertNotIn("<article hidden", self.content)
        self.assertNotIn("{{ARTICLES}}", self.content)

    def test_repository_links_preserve_fragments_and_reject_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / "doc"
            root.mkdir()
            page = root / "guide.md"
            with patch("build.ROOT", root), patch("build.PAGES", ()):
                page.write_text("---\ntitle: test\n---\n[Source](../apps/source.py#L12)\n")
                self.assertIn(
                    'href="../apps/source.py#L12"', render_page("guide", "Test", "guide.md")
                )
                page.write_text("---\ntitle: test\n---\n[Outside](../../outside.txt)\n")
                with self.assertRaises(ValueError):
                    render_page("guide", "Test", "guide.md")


if __name__ == "__main__":
    unittest.main()
