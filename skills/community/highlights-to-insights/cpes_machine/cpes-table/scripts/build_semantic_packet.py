#!/usr/bin/env scholarseed-skill-python
"""Project full Table structure into a bounded, evidence-linked semantic packet."""

from __future__ import annotations

import re


def compact_cell(cell: dict) -> dict:
    return {key: cell[key] for key in ("cell_id", "raw_latex", "display_text", "row_dimensions", "column_path", "metric_direction", "unit", "role", "source")}


def cell_priority(cell: dict) -> tuple:
    raw = cell["raw_latex"]
    formatting = int(any(token in raw for token in ("\\textbf", "\\mathbf", "\\underline")))
    missing = int(cell["role"] == "missing")
    return (-formatting, missing, cell["row_index"], cell["column_start"], cell["cell_id"])


def select_cells(structure: dict, required_ids: set[str] | None = None, limit: int = 64) -> list[dict]:
    groups = structure.get("groups", [])
    all_cells = [cell for group in groups for cell in group.get("data_cells", [])]
    required_ids = required_ids or set()
    selected: list[dict] = [cell for cell in all_cells if cell["cell_id"] in required_ids]
    # First retain one representative for every group/column path.
    buckets: dict[tuple, list[dict]] = {}
    for group in groups:
        for cell in group.get("data_cells", []):
            buckets.setdefault((group["group_id"], tuple(cell["column_path"])), []).append(cell)
    for key in sorted(buckets):
        candidate = sorted(buckets[key], key=cell_priority)[0]
        if candidate not in selected: selected.append(candidate)
        if len(selected) == limit: return [compact_cell(cell) for cell in selected]
    remaining = [cell for group in groups for cell in group.get("data_cells", []) if cell not in selected]
    selected.extend(sorted(remaining, key=cell_priority)[: max(0, limit - len(selected))])
    return [compact_cell(cell) for cell in selected]


def select_pairs(structure: dict, limit: int = 24) -> list[dict]:
    values = []
    for group in structure.get("groups", []):
        for pair in group.get("comparison_pairs", []):
            values.append(pair)
    values.sort(key=lambda pair: (pair["matched_conditions"]["group_id"], tuple(pair["matched_conditions"]["column_path"]), pair["pair_id"]))
    selected, used_paths = [], set()
    for pair in values:
        path = (pair["matched_conditions"]["group_id"], tuple(pair["matched_conditions"]["column_path"]))
        if path not in used_paths:
            selected.append(pair); used_paths.add(path)
            if len(selected) == limit: return selected
    for pair in values:
        if pair not in selected: selected.append(pair)
        if len(selected) == limit: break
    return selected


def author_clauses(context: dict, label: str | None) -> list[dict]:
    clauses = []
    seen: set[tuple[str, int, str]] = set()
    for mention_index, block in enumerate(context.get("numbered_mentions", []), 1):
        reference = block.get("reference_line")
        lines = block.get("lines", [])
        chosen = [row for row in lines if row.get("line") == reference]
        # Include up to two immediately following nonempty source lines when prose wraps.
        if chosen:
            position = next(index for index, row in enumerate(lines) if row.get("line") == reference)
            for row in lines[position + 1:position + 3]:
                if str(row.get("text", "")).strip(): chosen.append(row)
                else: break
        joined = " ".join(str(row.get("text", "")).strip() for row in chosen if str(row.get("text", "")).strip())
        for clause_index, raw in enumerate(re.split(r"(?<=[.!?])\s+", joined), 1):
            raw = raw.strip()
            if not raw or (label and not block.get('verified_reference') and "{" + label + "}" not in raw): continue
            evidence = {"file": block["file"], "line_start": chosen[0]["line"], "line_end": chosen[-1]["line"], "kind": "body"}
            key = (block["file"], evidence["line_start"], raw)
            if key in seen: continue
            seen.add(key)
            clauses.append({
                "clause_id": f"mention-{mention_index}-clause-{clause_index}",
                "raw_latex": raw, "display_text": re.sub(r"\s+", " ", raw).strip(),
                "table_label": label, "evidence": evidence,
            })
    return clauses


def structural_facts(structure: dict) -> tuple[list[str], list[str], list[str]]:
    structure_facts, reading, conditions = [], [], []
    for group in structure.get("groups", []):
        paths = sorted({" / ".join(cell["column_path"]) for cell in group.get("data_cells", []) if cell["column_path"]})
        dimensions = group.get("row_dimension_schema", [])
        structure_facts.append(f"{group['group_id']} has {len({cell['row_index'] for cell in group.get('data_cells', [])})} data rows and {len(paths)} data-column paths.")
        if paths: structure_facts.append(f"{group['group_id']} column paths: " + "; ".join(paths[:24]) + ("; …" if len(paths) > 24 else ""))
        if dimensions:
            structure_facts.append(f"{group['group_id']} row dimensions: " + "; ".join(f"{item['name']} ({item['role']})" for item in dimensions) + ".")
            conditions.extend(f"Keep {item['name']} fixed when its role is {item['role']}." for item in dimensions if item["role"] == "condition")
        reading.append(f"Within {group['group_id']}, locate a row by its named row dimensions, then follow the full column path to the cell.")
    reading.append("Use only listed comparison_pair IDs; each pair differs in exactly one declared contrast dimension while condition dimensions and the metric column remain fixed.")
    return structure_facts, reading, list(dict.fromkeys(conditions))


def build(structure: dict, context: dict, label: str | None) -> dict:
    pairs = select_pairs(structure)
    required_ids = {identifier for pair in pairs for identifier in (pair["left_cell_id"], pair["right_cell_id"])}
    cells = select_cells(structure, required_ids)
    structure_facts, reading, conditions = structural_facts(structure)
    return {
        "schema_version": 1, "table_id": structure["table_id"],
        "structure_facts": structure_facts, "reading_facts": reading, "condition_facts": conditions,
        "candidate_cells": cells, "comparison_pairs": pairs,
        "author_clauses": author_clauses(context, label),
        "limits": {"candidate_cells": 64, "comparison_pairs": 24},
    }
