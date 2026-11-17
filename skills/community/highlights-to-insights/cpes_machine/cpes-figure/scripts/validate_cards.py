#!/usr/bin/env scholarseed-skill-python
"""Validate figure-card coverage, schema, and source evidence spans."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

REQUIRED_FIELDS = {
    "schema_version",
    "paper_id",
    "figure_id",
    "label",
    "caption",
    "source",
    "visual_status",
    "overview",
    "panels",
    "how_to_read",
    "author_findings",
    "prerequisites",
    "scope",
}
LIST_FIELDS = {
    "panels",
    "how_to_read",
    "author_findings",
    "prerequisites",
    "scope",
}


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cards-dir", type=Path, required=True)
    args = parser.parse_args()

    manifest = load(args.manifest.resolve(strict=True))
    cards_dir = args.cards_dir.resolve(strict=True)
    paper_root = Path(manifest["paper_root"]).resolve(strict=True)
    errors: list[str] = []
    figures = manifest.get("figures", [])

    if manifest.get("figure_count") != len(figures):
        errors.append("manifest figure_count does not match figures length")
    if not (cards_dir / "README.md").is_file():
        errors.append("missing README.md")

    for figure in figures:
        figure_id = figure["figure_id"]
        json_path = cards_dir / figure["card_json"]
        md_path = cards_dir / figure["card_markdown"]
        if not json_path.is_file():
            errors.append(f"{figure_id}: missing JSON card")
            continue
        if not md_path.is_file():
            errors.append(f"{figure_id}: missing Markdown card")
        try:
            card = load(json_path)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{figure_id}: invalid JSON: {exc}")
            continue
        if set(card) - REQUIRED_FIELDS:
            errors.append(f"{figure_id}: unexpected card fields")
        missing = sorted(REQUIRED_FIELDS - set(card))
        if missing:
            errors.append(f"{figure_id}: missing fields {', '.join(missing)}")
        if card.get("schema_version") != 7:
            errors.append(f"{figure_id}: unsupported schema_version")
        if card.get("figure_id") != figure_id:
            errors.append(f"{figure_id}: figure_id mismatch")
        if card.get("label") != figure.get("label"):
            errors.append(f"{figure_id}: label mismatch")
        if card.get("caption") != figure.get("caption"):
            errors.append(f"{figure_id}: caption mismatch")
        caption = card.get("caption")
        if not isinstance(caption, dict) or set(caption) != {"number", "text", "display", "number_source", "number_uncertain"}:
            errors.append(f"{figure_id}: invalid caption structure")
        elif not isinstance(caption.get("number"), str) or not isinstance(caption.get("text"), str) or not isinstance(caption.get("display"), str) or caption.get("number_source") not in {"aux", "latex-counter", "logical-order"} or not isinstance(caption.get("number_uncertain"), bool):
            errors.append(f"{figure_id}: invalid caption values")
        if not isinstance(card.get("overview"), str) or not card.get("overview", "").strip():
            errors.append(f"{figure_id}: overview must be a non-empty string")
        if card.get("visual_status") not in {"inspected", "partial", "unavailable"}:
            errors.append(f"{figure_id}: invalid visual_status")
        for field in LIST_FIELDS:
            if field in card and not isinstance(card[field], list):
                errors.append(f"{figure_id}: {field} must be a list")
        panels = card.get("panels", [])
        if isinstance(panels, list):
            if card.get("visual_status") != "unavailable" and not panels:
                errors.append(f"{figure_id}: inspected or partial card must contain panels")
            for panel_index, panel in enumerate(panels):
                if not isinstance(panel, dict) or not isinstance(panel.get("panel_id"), str) or not isinstance(panel.get("visual_observations"), list):
                    errors.append(f"{figure_id}: invalid panels[{panel_index}]")
        source = card.get("source")
        if not isinstance(source, dict):
            errors.append(f"{figure_id}: source must be an object")
        else:
            expected_images = [item.get("resolved_path") for item in figure["images"] if item.get("resolved_path")]
            if source.get("tex_file") != figure.get("source_tex"):
                errors.append(f"{figure_id}: source tex_file mismatch")
            if source.get("image_paths") != expected_images:
                errors.append(f"{figure_id}: image_paths mismatch")
        for index, finding in enumerate(card.get("author_findings", [])):
            if not isinstance(finding, dict) or not str(finding.get("claim", "")).strip():
                errors.append(f"{figure_id}: author_findings[{index}] has no claim")
                continue
            evidence = finding.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                errors.append(f"{figure_id}: author_findings[{index}] has no evidence")
                continue
            for ev_index, span in enumerate(evidence):
                if not isinstance(span, dict):
                    errors.append(f"{figure_id}: evidence {index}.{ev_index} is not an object")
                    continue
                relative = span.get("file")
                try:
                    path = (paper_root / relative).resolve(strict=True)
                    path.relative_to(paper_root)
                    line_count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
                    start = int(span.get("line_start"))
                    end = int(span.get("line_end"))
                    if start < 1 or end < start or end > line_count:
                        raise ValueError
                except (TypeError, ValueError, OSError):
                    errors.append(f"{figure_id}: invalid evidence span {index}.{ev_index}")
                if span.get("kind") not in {"caption", "body", "appendix", "other"}:
                    errors.append(f"{figure_id}: invalid evidence kind {index}.{ev_index}")

    result = {"valid": not errors, "figure_count": len(figures), "errors": errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
