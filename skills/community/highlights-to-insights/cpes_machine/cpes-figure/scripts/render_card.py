#!/usr/bin/env scholarseed-skill-python
"""Render a figure-card JSON object to Markdown and rebuild the paper index."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def bullets(values: list[str]) -> str:
    return "\n".join(f"- {value}" for value in values) if values else "- None reported."


def render(card: dict) -> str:
    source = card["source"]
    lines = [
        f"# {card['caption']['display']}",
        "",
        f"> Source: `{source['tex_file']}:{source['line_start']}-{source['line_end']}` · "
        f"Images: {', '.join(f'`{value}`' for value in source['image_paths'])} · "
        f"Visual status: `{card['visual_status']}` · "
        f"Number source: `{card['caption']['number_source']}`"
        + (" (uncertain)" if card["caption"]["number_uncertain"] else ""),
        "",
        "## Overview",
        "",
        str(card["overview"]),
        "",
        "## What is shown?",
        "",
    ]
    for panel in card["panels"]:
        title = f" — {panel.get('title', '')}" if panel.get("title") else ""
        lines += [f"### {panel['panel_id']}{title}", "", bullets(panel["visual_observations"]), ""]
    sections = [
        ("How to read it", card["how_to_read"]),
        *([("Prerequisites", card["prerequisites"])] if "prerequisites" in card else []),
        ("Scope", card["scope"]),
    ]
    lines += ["## Author findings", ""]
    for finding in card["author_findings"]:
        spans = "; ".join(
            f"`{span['file']}:{span['line_start']}-{span['line_end']}` ({span['kind']})"
            for span in finding["evidence"]
        )
        lines.append(f"- {finding['claim']} — {spans}")
    lines.append("")
    for title, values in sections:
        lines += [f"## {title}", "", bullets(values), ""]
    return "\n".join(lines).rstrip() + "\n"


def rebuild_readme(manifest: dict, output_dir: Path) -> None:
    lines = [f"# Figure cards: {manifest['paper_id']}", "", "| Order | Label | Purpose | Card | Status |", "| ---: | --- | --- | --- | --- |"]
    for figure in manifest["figures"]:
        json_path = output_dir / figure["card_json"]
        if not json_path.is_file():
            continue
        card = load(json_path)
        lines.append(
            f"| {figure['order']} | `{figure['label'] or figure['figure_id']}` | "
            f"{card['overview']} | [{card['caption']['display']}]({figure['card_markdown']}) | `{card['visual_status']}` |"
        )
    (output_dir / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--card-json", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest = load(args.manifest.resolve(strict=True))
    card_path = args.card_json.resolve(strict=True)
    output_dir = args.output_dir.resolve(strict=True)
    card = load(card_path)
    figure = next((item for item in manifest["figures"] if item["figure_id"] == card.get("figure_id")), None)
    if figure is None:
        raise SystemExit("card figure_id is not present in manifest")
    expected_json = (output_dir / figure["card_json"]).resolve()
    if card_path != expected_json:
        raise SystemExit(f"card JSON must be written to {expected_json}")
    markdown_path = output_dir / figure["card_markdown"]
    markdown_path.parent.mkdir(parents=True, exist_ok=True)
    markdown_path.write_text(render(card), encoding="utf-8")
    rebuild_readme(manifest, output_dir)
    print(json.dumps({"markdown": str(markdown_path), "readme": str(output_dir / 'README.md')}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
