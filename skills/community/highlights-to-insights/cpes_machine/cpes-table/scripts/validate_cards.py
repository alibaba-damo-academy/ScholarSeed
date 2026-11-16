#!/usr/bin/env scholarseed-skill-python
"""Validate table-card coverage, fixed fields, values, and evidence spans."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

FIELDS = {
    "schema_version", "paper_id", "table_id", "label", "table_number", "display_name",
    "card_order", "number_source", "table_structure_sha256", "semantic_packet_sha256", "subtables", "caption", "title", "source", "render_status",
    "table_overview", "structure", "how_to_read", "experimental_conditions", "key_values",
    "comparisons", "author_findings", "prerequisites", "scope", "cannot_conclude",
    "uncertainties", "synthesis", "evidence_ledger",
}
PDF_FIELDS = FIELDS - {"title", "cannot_conclude", "uncertainties", "evidence_ledger", "structure", "experimental_conditions", "synthesis"}
LIST_FIELDS = FIELDS - {"schema_version", "paper_id", "table_id", "label", "table_number", "display_name", "card_order", "number_source", "table_structure_sha256", "semantic_packet_sha256", "caption", "title", "source", "render_status", "table_overview"}


def canonical_value_text(value: str) -> str:
    """Remove presentational LaTeX while preserving value semantics."""
    value = value.replace("\\pm", "±").replace("\\%", "%").replace("$", "")
    value = re.sub(r"\\(?:textbf|mathbf|underline|num)\s*\{([^{}]*)\}", r"\1", value)
    value = value.replace("{-}", "-").replace("{+}", "+")
    return re.sub(r"\s+", " ", value).strip()


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("expected JSON object")
    return value


def checksum(paths: list[str], root: Path) -> str:
    digest = hashlib.sha256()
    for relative in sorted(paths):
        path = root / relative
        digest.update(relative.encode()); digest.update(b"\0"); digest.update(path.read_bytes()); digest.update(b"\0")
    return digest.hexdigest()


def valid_evidence(span: object, allowed: list[tuple[str, int, int]], root: Path, kinds: set[str]) -> bool:
    if not isinstance(span, dict) or span.get("kind") not in kinds:
        return False
    try:
        relative, start, end = str(span["file"]), int(span["line_start"]), int(span["line_end"])
        path = (root / relative).resolve(strict=True); path.relative_to(root)
        line_count = len(path.read_text(encoding="utf-8", errors="replace").splitlines())
        if start < 1 or end < start or end > line_count:
            return False
        return any(relative == file and start >= low and end <= high for file, low, high in allowed)
    except (KeyError, TypeError, ValueError, OSError):
        return False


def validate_pdf_card(card,job):
    """Check provenance/container contract; visual values are model readings."""
    if set(card)!=set(job['template']) or card['schema_version']!=9:
        raise ValueError('Invalid PDF Table card fields')
    generated={'table_overview','how_to_read','key_values','comparisons','author_findings','prerequisites','scope'}
    for key in set(job['template'])-generated:
        if card[key]!=job['template'][key]:raise ValueError('Changed fixed Table field: '+key)
    for item in card['key_values']:
        expected={'kind':'table_image','file':job['item']['image'],'pdf_locator':job['item']['pdf_locator'],
                  'row_path':item['row_path'],'column_path':item['column_path']}
        if item['evidence']!=[expected]:raise ValueError('Changed Table image provenance')
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--cards-dir", type=Path, required=True)
    args = parser.parse_args()
    manifest, cards = load(args.manifest.resolve(strict=True)), args.cards_dir.resolve(strict=True)
    root = Path(manifest["paper_root"]).resolve(strict=True)
    errors: list[str] = []
    if manifest.get("table_count") != len(manifest.get("tables", [])):
        errors.append("manifest table_count mismatch")
    if checksum(manifest["reachable_tex_files"], root) != manifest["source_sha256"]:
        errors.append("paper source checksum changed")
    if not (cards / "README.md").is_file():
        errors.append("missing README.md")
    for table in manifest["tables"]:
        identity = table["table_id"]
        json_path, md_path = cards / table["card_json"], cards / table["card_markdown"]
        if not json_path.is_file():
            errors.append(f"{identity}: missing JSON"); continue
        if not md_path.is_file():
            errors.append(f"{identity}: missing Markdown")
        try:
            card = load(json_path)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"{identity}: invalid JSON: {exc}"); continue
        missing = sorted(FIELDS - set(card))
        if missing:
            errors.append(f"{identity}: missing fields {', '.join(missing)}")
        for key, expected in (
            ("schema_version", 6), ("paper_id", manifest["paper_id"]), ("table_id", identity),
            ("label", table["label"]), ("table_number", table["table_number"]),
            ("display_name", table["display_name"]), ("card_order", table["card_order"]),
            ("number_source", table["number_source"]), ("table_structure_sha256", table["table_structure_sha256"]),
            ("semantic_packet_sha256", table["semantic_packet_sha256"]),
            ("caption", table["caption"]),
        ):
            if card.get(key) != expected:
                errors.append(f"{identity}: fixed field {key} mismatch")
        if card.get("number_source") not in {"aux", "isolated_compile", "unavailable"}:
            errors.append(f"{identity}: invalid number_source")
        if card.get("table_number") is not None and not isinstance(card.get("table_number"), str):
            errors.append(f"{identity}: table_number must be string or null")
        if card.get("display_name") != (f"Table {card['table_number']}" if card.get("table_number") else None):
            errors.append(f"{identity}: display_name does not match table_number")
        expected_subtables = table.get("subtables", [])
        actual_subtables = card.get("subtables")
        if not isinstance(actual_subtables, list) or len(actual_subtables) != len(expected_subtables):
            errors.append(f"{identity}: subtable coverage mismatch")
        else:
            for sub_index, (actual, expected) in enumerate(zip(actual_subtables, expected_subtables, strict=True)):
                fixed = {
                    "marker": expected["marker"], "label": expected["label"],
                    "table_number": expected["table_number"], "display_name": expected["display_name"],
                    "caption_hint": expected["caption_hint"],
                    "source": {"tex_file": expected["source_tex"], "line_start": expected["line_start"], "line_end": expected["line_end"], "sha256": expected["source_sha256"]},
                }
                if not isinstance(actual, dict) or any(actual.get(key) != value for key, value in fixed.items()):
                    errors.append(f"{identity}: subtable[{sub_index}] fixed fields mismatch")
                if not isinstance(actual, dict) or not isinstance(actual.get("overview"), str) or not actual["overview"].strip():
                    errors.append(f"{identity}: subtable[{sub_index}] overview is empty")
        source = card.get("source")
        expected_source = {"tex_file": table["source_tex"], "line_start": table["line_start"], "line_end": table["line_end"], "sha256": table["source_sha256"]}
        if source != expected_source:
            errors.append(f"{identity}: source mismatch")
        if card.get("render_status") not in {"rendered", "partial", "unavailable"}:
            errors.append(f"{identity}: invalid render_status")
        structure_path = cards / table["table_structure_path"]
        try:
            structure_bytes = structure_path.read_bytes()
            if hashlib.sha256(structure_bytes).hexdigest() != table["table_structure_sha256"]:
                errors.append(f"{identity}: table_structure checksum mismatch")
            table_structure = json.loads(structure_bytes)
        except (OSError, json.JSONDecodeError):
            table_structure = {"groups": []}
            errors.append(f"{identity}: missing or invalid table_structure")
        cells = {cell["cell_id"]: cell for group in table_structure.get("groups", []) for cell in group.get("data_cells", [])}
        pairs = {pair["pair_id"]: pair for group in table_structure.get("groups", []) for pair in group.get("comparison_pairs", [])}
        semantic_path = cards / table["semantic_packet_path"]
        try:
            semantic_bytes = semantic_path.read_bytes()
            if hashlib.sha256(semantic_bytes).hexdigest() != table["semantic_packet_sha256"]:
                errors.append(f"{identity}: semantic_packet checksum mismatch")
            semantic_packet = json.loads(semantic_bytes)
        except (OSError, json.JSONDecodeError):
            semantic_packet = {}
            errors.append(f"{identity}: missing or invalid semantic_packet")
        candidate_ids = {item["cell_id"] for item in semantic_packet.get("candidate_cells", [])}
        candidate_pairs = {item["pair_id"] for item in semantic_packet.get("comparison_pairs", [])}
        clauses = {item["clause_id"]: item for item in semantic_packet.get("author_clauses", [])}
        if card.get("structure") != semantic_packet.get("structure_facts") or card.get("how_to_read") != semantic_packet.get("reading_facts") or card.get("experimental_conditions") != semantic_packet.get("condition_facts"):
            errors.append(f"{identity}: deterministic semantic facts mismatch")
        for field in LIST_FIELDS:
            if not isinstance(card.get(field), list):
                errors.append(f"{identity}: {field} must be a list")
        allowed = [(table["source_tex"], table["line_start"], table["line_end"])]
        allowed += [(item["file"], item["line_start"], item["line_end"]) for item in table["included_sources"]]
        allowed += [(item["file"], item["line_start"], item["line_end"]) for item in table["mentions"]]
        for field in ("key_values", "comparisons", "author_findings"):
            for index, item in enumerate(card.get(field, []) if isinstance(card.get(field), list) else []):
                spans = item.get("evidence") if isinstance(item, dict) else None
                if not isinstance(spans, list) or not spans:
                    errors.append(f"{identity}: {field}[{index}] lacks evidence"); continue
                kinds = {"table", "caption", "body"}
                grounded = False
                for span in spans:
                    if not valid_evidence(span, allowed, root, kinds):
                        errors.append(f"{identity}: invalid or cross-table evidence in {field}[{index}]")
                    if isinstance(span, dict) and span.get("kind") in {"caption", "body"}:
                        grounded = True
                if field == "author_findings" and not grounded:
                    errors.append(f"{identity}: author_findings[{index}] lacks caption or body grounding")
        canonical_source = canonical_value_text(table["expanded_latex"])
        for index, item in enumerate(card.get("key_values", []) if isinstance(card.get("key_values"), list) else []):
            value = item.get("value") if isinstance(item, dict) else None
            if not isinstance(value, str) or canonical_value_text(value) not in canonical_source:
                errors.append(f"{identity}: key_values[{index}] is not an exact source value")
            cell = cells.get(item.get("cell_id")) if isinstance(item, dict) else None
            if not cell or item.get("cell_id") not in candidate_ids:
                errors.append(f"{identity}: key_values[{index}] has invalid cell_id")
            elif value != cell["raw_latex"] or item.get("coordinates") != " | ".join([*cell["row_path"], *cell["column_path"]]) or item.get("evidence") != [cell["source"]]:
                errors.append(f"{identity}: key_values[{index}] derived fields mismatch")
        for index, item in enumerate(card.get("comparisons", []) if isinstance(card.get("comparisons"), list) else []):
            pair = pairs.get(item.get("pair_id")) if isinstance(item, dict) else None
            if not pair or not pair.get("compatible") or item.get("pair_id") not in candidate_pairs:
                errors.append(f"{identity}: comparisons[{index}] has invalid or incompatible pair_id")
                continue
            left, right = cells[pair["left_cell_id"]], cells[pair["right_cell_id"]]
            expected_evidence = []
            for span in (left["source"], right["source"]):
                if span not in expected_evidence: expected_evidence.append(span)
            matched = pair["matched_conditions"]
            expected_conditions = " | ".join([matched["group_id"], *matched["column_path"]])
            if item.get("conditions") != expected_conditions or item.get("evidence") != expected_evidence:
                errors.append(f"{identity}: comparisons[{index}] derived fields mismatch")
            relation = pair.get("deterministic_relation")
            if relation and (pair["left_value"] not in str(item.get("statement", "")) or pair["right_value"] not in str(item.get("statement", "")) or relation["right_minus_left"] not in str(item.get("statement", ""))):
                errors.append(f"{identity}: comparisons[{index}] omits deterministic relation")
        for index, item in enumerate(card.get("author_findings", []) if isinstance(card.get("author_findings"), list) else []):
            clause = clauses.get(item.get("clause_id")) if isinstance(item, dict) else None
            if not clause:
                errors.append(f"{identity}: author_findings[{index}] has invalid clause_id")
            elif item.get("claim") != clause["display_text"] or item.get("raw_latex") != clause["raw_latex"] or item.get("quote") != clause["display_text"] or item.get("evidence") != [clause["evidence"]]:
                errors.append(f"{identity}: author_findings[{index}] deterministic replacement mismatch")
        for index, item in enumerate(card.get("evidence_ledger", []) if isinstance(card.get("evidence_ledger"), list) else []):
            if not isinstance(item, dict) or item.get("kind") not in {"source", "author", "synthesis", "unknown"} or not str(item.get("statement", "")).strip():
                errors.append(f"{identity}: invalid evidence_ledger[{index}]")
    result = {"valid": not errors, "table_count": len(manifest.get("tables", [])), "errors": errors}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
