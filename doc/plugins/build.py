"""Render the plugin Markdown sources into an offline HTML guide."""

from __future__ import annotations

import argparse
import html
import os
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "plugins.html"
TEMPLATE = Path(__file__).with_name("layout.html")
PAGES = (
    ("guide", "Plugin 概览", "plugins.md"),
    ("create", "创建 Plugin", "plugins/create.md"),
    ("cards", "Plugin 公共对话卡片", "plugins/cards.md"),
    ("runtime", "Plugin 运行原理", "plugins/runtime.md"),
    ("api", "Plugin 可用 API", "plugins/api.md"),
    ("testing", "Plugin 测试", "plugins/testing.md"),
)


def slug(value: str) -> str:
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", value.lower()))


def render_page(page: str, title: str, filename: str) -> str:
    source = ROOT / filename
    content = source.read_text(encoding="utf-8")
    if not content.startswith("---\n"):
        raise ValueError(f"Missing metadata: {filename}")
    content = content.split("---", 2)[2].strip()
    parser = MarkdownIt("commonmark", {"html": False}).enable("table")
    tokens = parser.parse(content)
    headings: dict[str, int] = {}
    destinations = {(ROOT / row[2]).resolve(): row[0] for row in PAGES}
    for index, token in enumerate(tokens):
        if token.type == "heading_open":
            anchor = slug(tokens[index + 1].content)
            count = headings.get(anchor, 0)
            headings[anchor] = count + 1
            unique = f"{anchor}-{count}" if count else anchor
            token.attrSet("id", f"{page}--{unique}")
        for child in token.children or []:
            attribute = "href" if child.type == "link_open" else "src"
            target = child.attrGet(attribute)
            if not target:
                continue
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc:
                continue
            resolved = (source.parent / unquote(parsed.path)).resolve() if parsed.path else source
            if child.type == "link_open" and resolved in destinations:
                destination = destinations[resolved]
                fragment = f"--{unquote(parsed.fragment)}" if parsed.fragment else ""
                child.attrSet(attribute, f"#{destination}{fragment}")
            elif parsed.path:
                resolved.relative_to(ROOT.parent if child.type == "link_open" else ROOT)
                relative = Path(os.path.relpath(resolved, ROOT)).as_posix()
                fragment = f"#{parsed.fragment}" if parsed.fragment else ""
                child.attrSet(attribute, relative + fragment)
    body = parser.renderer.render(tokens, parser.options, {})
    body = body.replace(
        "<blockquote>\n<p>[!WARNING]\n",
        '<blockquote class="warning" role="note">\n<p>',
    )
    return (
        f'<article id="{page}" data-page="{page}" aria-label="{html.escape(title)}">'
        f'<a class="source" href="{filename}">查看 Markdown 源文档</a>{body}</article>'
    )


def build() -> str:
    navigation = "\n".join(
        f'<a href="#{page}" data-topic="{page}">{html.escape(title)}</a>'
        for page, title, _ in PAGES
    )
    articles = "\n".join(render_page(*row) for row in PAGES)
    return (
        TEMPLATE.read_text(encoding="utf-8")
        .replace("{{NAVIGATION}}", navigation)
        .replace("{{ARTICLES}}", articles)
    )


def main() -> int:
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--check", action="store_true", help="Check that HTML matches Markdown")
    options = arguments.parse_args()
    content = build()
    if options.check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding="utf-8") != content:
            print("Plugin HTML is stale; run .venv/bin/python doc/plugins/build.py")
            return 1
        print("Plugin HTML matches all six Markdown sources and the template")
        return 0
    OUTPUT.write_text(content, encoding="utf-8")
    print(OUTPUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
