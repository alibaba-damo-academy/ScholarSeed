"""Resolve outline language defaults without asking downstream models to infer them."""
from __future__ import annotations

LANGUAGES = {"default", "chinese", "english"}


def default_language(value: str) -> str:
    return "chinese" if str(value).strip().lower() == "chinese" else "english"


def section_language(section: dict, document_default: str) -> str:
    value = str(section.get("language") or "default").strip().lower()
    return default_language(document_default) if value == "default" else value


def resolved_language_map(outline: dict, document_default: str) -> dict[str, str]:
    fallback = default_language(document_default)
    tree = outline.get("outline_tree") or []
    if not tree:
        return {"component": fallback}
    return {section["section_id"]: section_language(section, fallback) for section in tree}


def publication_language(resolved: dict[str, str]) -> str:
    """ctexart/xelatex safely handles an English document containing Chinese."""
    return "chinese" if "chinese" in resolved.values() else "english"
