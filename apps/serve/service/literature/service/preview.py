"""Ephemeral projections of incomplete structured model output, never final results."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import TypeAdapter, ValidationError

from service.literature.service.analysis import ActionKind, AnalysisRequest

PARTIAL_JSON_MODE: Literal["trailing-strings"] = "trailing-strings"
PREVIEW_ACTIONS = frozenset(
    {
        ActionKind.TRANSLATION,
        ActionKind.WORD_TRANSLATION,
        ActionKind.EXPLANATION,
        ActionKind.INTERPRETATION,
    }
)
SUMMARY_CONTENT_FIELDS = ("contribution", "method", "limitations")
DOCUMENT = TypeAdapter(dict[str, Any])


def summary_preview(partial: dict) -> dict:
    modules = partial.get("modules")
    summary = modules.get("summary") if isinstance(modules, dict) else None
    if not isinstance(summary, dict):
        return {}
    result: dict[str, Any] = {"text": ""}
    for field in SUMMARY_CONTENT_FIELDS:
        content = summary.get(field)
        text = content.get("text") if isinstance(content, dict) else None
        result[field] = {"text": text if isinstance(text, str) else ""}
    claims = summary.get("claims")
    result["claims"] = (
        [
            {"text": claim["text"]}
            for claim in claims
            if isinstance(claim, dict) and isinstance(claim.get("text"), str)
        ]
        if isinstance(claims, list)
        else []
    )
    if not any(result[field]["text"] for field in SUMMARY_CONTENT_FIELDS) and not any(
        claim["text"] for claim in result["claims"]
    ):
        return {}
    paper_type = summary.get("paper_type")
    result["paper_type"] = paper_type if isinstance(paper_type, str) else ""
    return {"summary": result}


def project_preview(
    output: str, request: AnalysisRequest, completed_blocks: list[dict] | None = None
) -> dict:
    if request.kind not in PREVIEW_ACTIONS:
        return {}
    try:
        partial = DOCUMENT.validate_json(output, experimental_allow_partial=PARTIAL_JSON_MODE)
    except ValidationError:
        return {}
    if request.kind == ActionKind.INTERPRETATION:
        return summary_preview(partial)
    if request.kind != ActionKind.TRANSLATION:
        text = partial.get("text")
        return {"text": text} if isinstance(text, str) and text else {}
    blocks = list(completed_blocks or ())
    pages = partial.get("pages")
    for page in pages if isinstance(pages, list) else ():
        if not isinstance(page, dict) or page.get("page") != request.page:
            continue
        candidates = page.get("blocks")
        for block in candidates if isinstance(candidates, list) else ():
            if not isinstance(block, dict):
                continue
            source, translated = block.get("source_text"), block.get("translated_text")
            if not isinstance(source, str) or not isinstance(translated, str) or not translated:
                continue
            blocks.append(
                {
                    "source_text": source,
                    "translated_text": translated,
                    "located": False,
                    "paragraph_start": block.get("paragraph_start") is True,
                    "heading": block.get("heading") is True,
                }
            )
    return {"pages": [{"page": request.page, "blocks": blocks}]} if blocks else {}
