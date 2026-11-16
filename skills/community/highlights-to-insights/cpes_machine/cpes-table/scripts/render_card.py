#!/usr/bin/env scholarseed-skill-python
"""Render table-card JSON deterministically to Markdown and rebuild README."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected object")
    return value


def bullets(values: list, formatter=str) -> str:
    return "\n".join(f"- {formatter(item)}" for item in values) if values else "- None established."


def evidence(values: list[dict]) -> str:
    return "; ".join(f"`{v['file']}:{v['line_start']}-{v['line_end']}` ({v['kind']})" for v in values)


def render_image_card(card):
    source=card['source'];label=card['display_name'];caption=card['caption']
    lines=[f"# {label}: {caption}","",f"> PDF page {source['pdf_locator']['page_number']} · Image: `{source['image_path']}`","",
           "## Table overview","",card['table_overview'],"","## How to read","",bullets(card['how_to_read']),"","## Key values",""]
    def location(item):return ' | '.join([*item['row_path'],*item['column_path']])
    for item in card['key_values']:
        lines.append(f"- `{item['value']}` — {item['meaning']} ({location(item)})")
    lines += ["","## Comparisons",""]
    for item in card['comparisons']:
        left,right=item['left'],item['right']
        lines.append(f"- `{left['value']}` ({location(left)}) → `{right['value']}` ({location(right)}): {item['interpretation']}")
    lines += ["","## Author findings",""]
    for item in card['author_findings']:lines.append(f"- {item['claim']} — {evidence(item['evidence'])}")
    for title,key in [('Prerequisites','prerequisites'),('Scope','scope')]:
        lines += ["",f"## {title}","",bullets(card[key])]
    return '\n'.join(lines).rstrip()+'\n'


def render(card: dict) -> str:
    if card.get("schema_version")==9:return render_image_card(card)
    source = card["source"]
    heading = card["display_name"] or f"Unnumbered table `{card['label'] or card['table_id']}`"
    heading_title = card["caption"] or card.get("title", "")
    lines = [
        f"# {heading}: {heading_title}", "",
        f"> Label: `{card['label'] or 'none'}` · Source: `{source['tex_file']}:{source['line_start']}-{source['line_end']}` · Number source: `{card['number_source']}` · Render: `{card['render_status']}`", "",
        "## Table overview", "", str(card["table_overview"]), "",
    ]
    if card["subtables"]:
        lines += ["## Subtables", ""]
        for subtable in card["subtables"]:
            name = subtable["display_name"] or f"({subtable['marker']})"
            hint = f" — {subtable['caption_hint']}" if subtable["caption_hint"] else ""
            lines += [f"### {name}{hint}", "", subtable["overview"], ""]
    if "structure" in card:
        lines += ["## Structure", "", bullets(card["structure"]), ""]
    lines += [
        "## How to read", "", bullets(card["how_to_read"]), "",
        *(["## Experimental conditions", "", bullets(card["experimental_conditions"]), ""] if "experimental_conditions" in card else []),
        "## Key values", "",
    ]
    for item in card["key_values"]:
        lines.append(f"- `{item['value']}` — {item['meaning']} ({item['coordinates']}) — {evidence(item['evidence'])}")
    lines += ["", "## Comparisons", ""]
    for item in card["comparisons"]:
        lines.append(f"- {item['statement']} Conditions: {item['conditions']} — {evidence(item['evidence'])}")
    lines += ["", "## Author findings", ""]
    for item in card["author_findings"]:
        lines.append(f"- {item['claim']} — {evidence(item['evidence'])}")
    if "synthesis" in card:
        lines += ["", "## Synthesis", "", bullets(card["synthesis"])]
    for title, field in [
        ("Prerequisites", "prerequisites"), ("Scope", "scope"),
        ("What cannot be concluded?", "cannot_conclude"), ("Uncertainties", "uncertainties"),
    ]:
        if field in card:
            lines += ["", f"## {title}", "", bullets(card[field])]
    if "evidence_ledger" in card:
        lines += ["", "## Evidence ledger", ""]
        lines += [f"- **{item['kind']}**: {item['statement']}" for item in card["evidence_ledger"]]
    return "\n".join(lines).rstrip() + "\n"


def rebuild_readme(manifest: dict, output: Path) -> None:
    lines = [f"# Table cards: {manifest['paper_id']}", "", "| Card order | Paper table | Label | Overview | Card | Render |", "| ---: | --- | --- | --- | --- | --- |"]
    for item in manifest["tables"]:
        path = output / item["card_json"]
        if not path.is_file():
            continue
        card = load(path)
        link_title = card["caption"] or card.get("title", "")
        lines.append(f"| {card['card_order']} | {card['display_name'] or 'Unnumbered'} | `{item['label'] or 'none'}` | {card['table_overview']} | [{link_title}]({item['card_markdown']}) | `{card['render_status']}` |")
    (output / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--card-json", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest, output = load(args.manifest.resolve(strict=True)), args.output_dir.resolve(strict=True)
    card_path = args.card_json.resolve(strict=True)
    card = load(card_path)
    item = next((row for row in manifest["tables"] if row["table_id"] == card.get("table_id")), None)
    if item is None or card_path != (output / item["card_json"]).resolve():
        raise SystemExit("card path or table_id does not match manifest")
    destination = output / item["card_markdown"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(render(card), encoding="utf-8")
    rebuild_readme(manifest, output)
    print(json.dumps({"markdown": str(destination), "readme": str(output / "README.md")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
