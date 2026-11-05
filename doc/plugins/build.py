"""Render the plugin Markdown sources into an offline HTML guide."""

from __future__ import annotations

import argparse
import html
import json
import os
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "plugins.html"
TEMPLATE = Path(__file__).with_name("layout.html")
DEFAULT_LANGUAGE = "en"
PAGES = (
    ("guide", "Plugin Overview", "plugins.md"),
    ("create", "Create a Plugin", "plugins/create.md"),
    ("cards", "Public Conversation Cards", "plugins/cards.md"),
    ("runtime", "How Plugins Run", "plugins/runtime.md"),
    ("api", "Available APIs", "plugins/api.md"),
    ("testing", "Test a Plugin", "plugins/testing.md"),
)
LANGUAGES = {
    "en": {
        "tag": "en",
        "suffix": "",
        "alternate": "plugins.zh.html",
        "language_label": "简体中文",
        "language_tag": "zh-CN",
        "description": "ScholarSeed plugin guide: creation, UI, components, interactions, APIs, and testing.",
        "title": "Plugin Guide · ScholarSeed",
        "brand": "ScholarSeed / Plugin Guide",
        "tagline": "From workflows to real conversations",
        "skip": "Skip to content",
        "navigation_label": "Topic navigation",
        "topics": "Plugin topics",
        "guides": "Developer guide",
        "search_label": "Search all topics",
        "search_placeholder": "Search slots, drafts, or installation…",
        "offline": "Read offline without signing in or starting a backend.",
        "footer": "Generated from repository Markdown. After editing the sources, run",
        "footer_end": "to update both languages.",
        "outline": "On this page",
        "source": "View Markdown source",
        "titles": {},
        "messages": {
            "title": "ScholarSeed Plugin Guide",
            "found": "{count} matching sections",
            "limited": " (showing the first {count})",
            "empty": "No matching sections. Try another keyword.",
            "copy": "Copy code",
            "copied": "Copied",
            "manual": "Press Ctrl/Cmd+C to copy",
        },
    },
    "zh": {
        "tag": "zh-CN",
        "suffix": ".zh",
        "alternate": "plugins.html",
        "language_label": "English",
        "language_tag": "en",
        "description": "书深插件开发专题指南：对话创建、界面绘制、组件、交互、API 与测试。",
        "title": "插件开发指南 · 书深",
        "brand": "书深 / 插件开发指南",
        "tagline": "从业务流程到真实对话",
        "skip": "跳转到正文",
        "navigation_label": "专题导航",
        "topics": "插件专题",
        "guides": "开发指南",
        "search_label": "搜索全部专题",
        "search_placeholder": "搜索 slot、草稿或安装…",
        "offline": "离线可读，无需登录或启动后端。",
        "footer": "正文由仓库 Markdown 生成。修改源文档后运行",
        "footer_end": "更新中英文页面。",
        "outline": "本页目录",
        "source": "查看 Markdown 源文档",
        "titles": {
            "guide": "Plugin 概览",
            "create": "创建 Plugin",
            "cards": "Plugin 公共对话卡片",
            "runtime": "Plugin 运行原理",
            "api": "Plugin 可用 API",
            "testing": "Plugin 测试",
        },
        "messages": {
            "title": "书深插件开发指南",
            "found": "找到 {count} 个相关章节",
            "limited": "，显示前 {count} 项",
            "empty": "没有匹配章节，请换个关键词。",
            "copy": "复制代码",
            "copied": "已复制",
            "manual": "请按 Ctrl/Cmd+C 复制",
        },
    },
}


def pages(language: str) -> tuple[tuple[str, str, str], ...]:
    locale = LANGUAGES[language]
    return tuple(
        (page, locale["titles"].get(page, title), filename.replace(".md", locale["suffix"] + ".md"))
        for page, title, filename in PAGES
    )


def slug(value: str) -> str:
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", value.lower()))


def render_page(page: str, title: str, filename: str, language: str = DEFAULT_LANGUAGE) -> str:
    source = ROOT / filename
    content = source.read_text(encoding="utf-8")
    if not content.startswith("---\n"):
        raise ValueError(f"Missing metadata: {filename}")
    content = content.split("---", 2)[2].strip()
    parser = MarkdownIt("commonmark", {"html": False}).enable("table")
    tokens = parser.parse(content)
    headings: dict[str, int] = {}
    destinations = {
        (ROOT / filename).resolve(): (target_language, page)
        for target_language in LANGUAGES
        for page, _, filename in pages(target_language)
    }
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
                target_language, destination = destinations[resolved]
                prefix = (
                    ""
                    if target_language == language
                    else "plugins" + LANGUAGES[target_language]["suffix"] + ".html"
                )
                fragment = f"--{unquote(parsed.fragment)}" if parsed.fragment else ""
                child.attrSet(attribute, f"{prefix}#{destination}{fragment}")
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
        f'<a class="source" href="{filename}">{LANGUAGES[language]["source"]}</a>{body}</article>'
    )


def build(language: str = DEFAULT_LANGUAGE) -> str:
    locale = LANGUAGES[language]
    navigation = "\n".join(
        f'<a href="#{page}" data-topic="{page}">{html.escape(title)}</a>'
        for page, title, _ in pages(language)
    )
    articles = "\n".join(render_page(*row, language=language) for row in pages(language))
    replacements = {
        key.upper(): html.escape(value, quote=True)
        for key, value in locale.items()
        if isinstance(value, str)
    }
    replacements.update(
        {
            "NAVIGATION": navigation,
            "ARTICLES": articles,
            "SCRIPT_MESSAGES": json.dumps(locale["messages"], ensure_ascii=True).replace(
                "<", "\\u003c"
            ),
        }
    )
    template = TEMPLATE.read_text(encoding="utf-8")
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda match: replacements[match[1]], template)


def main() -> int:
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--check", action="store_true", help="Check that HTML matches Markdown")
    options = arguments.parse_args()
    for language, locale in LANGUAGES.items():
        output = OUTPUT.with_name("plugins" + locale["suffix"] + ".html")
        content = build(language)
        if options.check:
            if not output.exists() or output.read_text(encoding="utf-8") != content:
                print(f"{output.name} is stale; run python doc/plugins/build.py")
                return 1
        else:
            output.write_text(content, encoding="utf-8")
            print(output)
    if options.check:
        print("Both plugin guides match their Markdown sources and the template")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
