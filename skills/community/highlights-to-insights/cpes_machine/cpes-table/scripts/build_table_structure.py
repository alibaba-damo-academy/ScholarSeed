#!/usr/bin/env scholarseed-skill-python
"""Build deterministic cell coordinates and safe comparison pairs for a Table."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

RULE_RE = re.compile(r"\\(?:toprule|midrule|bottomrule|hline|cline\s*\{[^{}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^{}]*\})")
ROW_END_RE = re.compile(r"(?<!\\)\\\\(?:\s*\[[^\]]*\])?")
MISSING = {"-", "--", "---", "n/a", "na", "oom"}


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def argument(text: str, start: int) -> tuple[str, int] | None:
    while start < len(text) and text[start].isspace(): start += 1
    if start >= len(text) or text[start] != "{": return None
    depth, cursor = 1, start + 1
    while cursor < len(text):
        escaped = cursor > 0 and text[cursor - 1] == "\\"
        if text[cursor] == "{" and not escaped: depth += 1
        elif text[cursor] == "}" and not escaped:
            depth -= 1
            if depth == 0: return text[start + 1:cursor], cursor + 1
        cursor += 1
    return None


def command_args(value: str, command: str, count: int) -> list[str] | None:
    match = re.search(r"\\" + re.escape(command) + r"\s*", value)
    if not match: return None
    cursor, values = match.end(), []
    for _ in range(count):
        found = argument(value, cursor)
        if not found: return None
        values.append(found[0]); cursor = found[1]
    return values


def unwrap_cell(raw: str) -> tuple[str, int, int]:
    column_span = row_span = 1
    value = normalize(raw)
    multi = command_args(value, "multicolumn", 3)
    if multi:
        try: column_span = max(1, int(multi[0]))
        except ValueError: column_span = 1
        value = normalize(multi[2])
    multirow = command_args(value, "multirow", 3)
    if multirow:
        try: row_span = max(1, abs(int(multirow[0])))
        except ValueError: row_span = 1
        value = normalize(multirow[2])
    return value, column_span, row_span


def display_text(value: str) -> str:
    if value.strip() == r"\mbox{}": return ""
    value = re.sub(r"\\(?:textbf|textit|emph|underline|mathrm|rm|mathbf|texttt)\s*\{([^{}]*)\}", r"\1", value)
    value = re.sub(r"\\cite\s*\{[^{}]*\}", "", value)
    value = value.replace("$", "").replace("\\%", "%").replace("\\pm", "±")
    return normalize(value)


def tabular_body(source: str) -> tuple[str, int]:
    begin = re.search(r"\\begin\s*\{(?:tabular\*?|tabularx|longtable)\}(?:\s*\{[^{}]*\}){0,2}", source)
    ends = list(re.finditer(r"\\end\s*\{(?:tabular\*?|tabularx|longtable)\}", source))
    if begin and ends: return source[begin.end():ends[-1].start()], begin.end()
    return source, 0


def source_span(source: str, segments: list[dict] | None, start: int, end: int, default_file: str, default_line: int) -> tuple[str, int, int]:
    if segments:
        matching = [segment for segment in segments if segment["output_start"] <= start < segment["output_end"]]
        if matching:
            segment = matching[-1]
            line_start = segment["source_line_start"] + source.count("\n", segment["output_start"], start)
            safe_end = min(end, segment["output_end"])
            line_end = line_start + source.count("\n", start, safe_end)
            return segment["file"], line_start, line_end
    return default_file, default_line + source.count("\n", 0, start), default_line + source.count("\n", 0, end)


def active_bounds(raw: str) -> tuple[int, int]:
    """Exclude leading/trailing rule commands from a data row's provenance."""
    start = 0
    while start < len(raw):
        whitespace = re.match(r"\s*", raw[start:])
        start += whitespace.end() if whitespace else 0
        rule = RULE_RE.match(raw, start)
        if not rule:
            break
        start = rule.end()
    end = len(raw.rstrip())
    return min(start, end), end


def row_records(source: str, base_line: int, source_file: str, segments: list[dict] | None = None) -> list[dict]:
    body, body_offset = tabular_body(source)
    result, cursor = [], 0
    for match in list(ROW_END_RE.finditer(body)) + [None]:
        end = match.start() if match else len(body)
        raw = body[cursor:end]
        cleaned = RULE_RE.sub("", raw)
        cells = [normalize(cell) for cell in re.split(r"(?<!\\)&", cleaned)]
        if any(cells):
            active_start, active_end = active_bounds(raw)
            absolute = body_offset + cursor + active_start
            absolute_end = body_offset + cursor + active_end
            filename, line_start, line_end = source_span(source, segments, absolute, absolute_end, source_file, base_line)
            result.append({"cells": cells, "source_file": filename, "line_start": line_start, "line_end": line_end})
        cursor = match.end() if match else len(body)
    return result


def data_like(cells: list[str]) -> bool:
    if len(cells) < 2: return False
    values = [display_text(unwrap_cell(value)[0]).lower() for value in cells[1:]]
    return any(re.search(r"[-+]?\d", value) or value.strip() in MISSING for value in values)


def leading_stub_count(headers: list[dict]) -> int:
    if not headers: return 1
    last_row = max(item["row"] for item in headers)
    last = {column: item["text"] for item in headers if item["row"] == last_row for column in range(item["column_start"], item["column_start"] + item["column_span"])}
    count = 0
    while not last.get(count): count += 1
    if count: return count
    stub_names = {"method", "model", "problem", "algorithm", "task", "dataset", "dyad", "truth", "source", "setting", "mode"}
    while display_text(last.get(count, "")).lower().strip() in stub_names: count += 1
    return max(1, count)


def header_at(column: int, headers: list[dict]) -> str:
    values = [item for item in headers if item["column_start"] <= column < item["column_start"] + item["column_span"]]
    return values[-1]["text"] if values else f"row_dimension_{column + 1}"


def dimension_role(name: str) -> str:
    lowered = name.lower().replace("\\", "")
    if any(token in lowered for token in ("problem", "dataset", "benchmark", "task", "split", "model", "source", "truth", "kv", "setting", "seed")):
        return "condition"
    if any(token in lowered for token in ("method", "algorithm", "variant", "mode")):
        return "contrast"
    return "contrast"


def direction_and_unit(path: list[str]) -> tuple[str | None, str | None]:
    text = " / ".join(path)
    direction = "higher" if "↑" in text or "\\uparrow" in text else "lower" if "↓" in text or "\\downarrow" in text else None
    unit = "%" if "%" in text or "\\%" in text else None
    if unit is None:
        match = re.search(r"\[(.*?)\]|\(([^()]*(?:ms|sec|seconds|GeV|MHz|GHz|km/s|mmag)[^()]*)\)", text, re.I)
        if match: unit = normalize(match.group(1) or match.group(2))
    return direction, unit


def numeric(value: str) -> Decimal | None:
    text = display_text(value).replace(",", "").strip()
    if not re.fullmatch(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", text): return None
    try: return Decimal(text)
    except InvalidOperation: return None


def pair_priority(left: dict, right: dict) -> int | None:
    """Rank condition-compatible row contrasts; reject broad Cartesian pairs."""
    a = {item["name"]: item for item in left.get("row_dimensions", [])}
    b = {item["name"]: item for item in right.get("row_dimensions", [])}
    if not a or set(a) != set(b): return None
    condition_differences = [name for name in a if a[name]["role"] != "contrast" and a[name]["value"] != b[name]["value"]]
    contrast_differences = [name for name in a if a[name]["role"] == "contrast" and a[name]["value"] != b[name]["value"]]
    if condition_differences or len(contrast_differences) != 1: return None
    return 0


def build_group(group_id: str, label: str | None, source: str, base_line: int, source_file: str, source_segments: list[dict] | None = None) -> dict:
    rows = row_records(source, base_line, source_file, source_segments)
    first_data = next((index for index, row in enumerate(rows) if data_like(row["cells"])), len(rows))
    header_rows = rows[:first_data]
    headers: list[dict] = []
    for header_index, row in enumerate(header_rows):
        column = 0
        for raw in row["cells"]:
            content, span, _ = unwrap_cell(raw)
            if display_text(content): headers.append({"row": header_index, "column_start": column, "column_span": span, "text": display_text(content), "raw_latex": content})
            column += span

    cells, row_group, inherited = [], None, {}
    data_rows = rows[first_data:]
    stub_count = leading_stub_count(headers)
    stub_names = [header_at(position, headers) for position in range(stub_count)]
    data_index = 0
    last_stub_path: list[str] = []
    parent_stub: dict[int, str] = {}
    for row_index, row in enumerate(data_rows, first_data):
        parsed = [unwrap_cell(value) for value in row["cells"]]
        total_span = sum(value[1] for value in parsed)
        if len(parsed) == 1 and total_span > 1:
            row_group = display_text(parsed[0][0]); continue
        if len(parsed) == 1 and not data_like(row["cells"]):
            row_group = display_text(parsed[0][0]); continue
        column = 0; placed = []
        for raw, (content, column_span, row_span) in zip(row["cells"], parsed, strict=True):
            if not display_text(content) and inherited.get(column, (0, None))[0] > row_index:
                placed.append((column, column_span, row_span, content, ""))
                column += column_span
                continue
            while inherited.get(column, (0, None))[0] > row_index: column += 1
            text = display_text(content)
            placed.append((column, column_span, row_span, content, text))
            if row_span > 1 and text: inherited[column] = (row_index + row_span, text)
            column += column_span
        stub_path = []
        row_dimensions = []
        for position in range(stub_count):
            current = next((item[4] for item in placed if item[0] == position and item[4]), None)
            inherited_value = inherited.get(position, (0, None))[1] if inherited.get(position, (0, None))[0] > row_index else None
            value = current or inherited_value or (last_stub_path[position] if position < len(last_stub_path) else None)
            if value:
                if value.lstrip().startswith("+") and position in parent_stub:
                    value = f"{parent_stub[position]} / {value}"
                else:
                    parent_stub[position] = value
                stub_path.append(value)
                row_dimensions.append({"name": stub_names[position], "value": value, "role": dimension_role(stub_names[position])})
        if stub_path: last_stub_path = stub_path
        if placed and any(item[0] >= stub_count for item in placed):
            data_index += 1
        for position, column_span, row_span, raw_latex, text in [item for item in placed if item[0] >= stub_count]:
            path = [header["text"] for header in headers if header["column_start"] <= position < header["column_start"] + header["column_span"]]
            path = list(dict.fromkeys(value for value in path if value and value not in stub_path))
            cell_id = f"{group_id}:r{data_index}:c{position}"
            direction, unit = direction_and_unit(path)
            role = "missing" if text.lower() in MISSING else "data"
            cells.append({
                "cell_id": cell_id, "raw_latex": raw_latex, "display_text": text,
                "row_index": data_index, "column_start": position, "column_span": column_span, "row_span": row_span,
                "row_path": [value for value in (row_group, *stub_path) if value], "column_path": path,
                "row_dimensions": row_dimensions,
                "column_dimensions": [{"name": f"level_{level + 1}", "value": value, "role": "metric" if level == len(path) - 1 else "condition"} for level, value in enumerate(path)],
                "metric_direction": direction, "unit": unit, "role": role,
                "source": {"file": row["source_file"], "line_start": row["line_start"], "line_end": row["line_end"], "kind": "table"},
            })
    pairs = []
    by_signature: dict[tuple, list[dict]] = {}
    for cell in cells:
        signature = (tuple(cell["column_path"]), cell["unit"], cell["metric_direction"])
        by_signature.setdefault(signature, []).append(cell)
    for values in by_signature.values():
        candidates = []
        for left, right in itertools.combinations(values, 2):
            if left["row_path"] == right["row_path"] or left["role"] == "missing" or right["role"] == "missing": continue
            priority = pair_priority(left, right)
            if priority is None: continue
            candidates.append((priority, abs(left["row_index"] - right["row_index"]), left["cell_id"], right["cell_id"], left, right))
        for _, _, _, _, left, right in sorted(candidates)[:8]:
            if len(pairs) >= 256: break
            pair_id = f"{group_id}:cmp-{len(pairs)+1}"
            left_number, right_number = numeric(left["raw_latex"]), numeric(right["raw_latex"])
            relation = None
            if left_number is not None and right_number is not None:
                relation = {
                    "ordering": "equal" if right_number == left_number else "right_greater" if right_number > left_number else "right_lower",
                    "right_minus_left": str(right_number - left_number),
                }
            pairs.append({
                "pair_id": pair_id, "left_cell_id": left["cell_id"], "right_cell_id": right["cell_id"],
                "compatible": True, "matched_conditions": {"group_id": group_id, "column_path": left["column_path"], "unit": left["unit"], "metric_direction": left["metric_direction"]},
                "intended_contrast": {"left_row_path": left["row_path"], "right_row_path": right["row_path"]},
                "left_value": left["raw_latex"], "right_value": right["raw_latex"], "deterministic_relation": relation,
            })
    return {"group_id": group_id, "label": label, "row_dimension_schema": [{"name": name, "role": dimension_role(name)} for name in stub_names], "header_cells": headers, "data_cells": cells, "comparison_pairs": pairs}


def build(table: dict) -> dict:
    groups = []
    if table.get("subtables"):
        for subtable in table["subtables"]:
            groups.append(build_group(f"subtable-{subtable['marker']}", subtable.get("label"), subtable["source_latex"], subtable["line_start"], subtable["source_tex"], subtable.get("source_segments")))
    else:
        groups.append(build_group("main", table.get("label"), table["expanded_latex"], table["line_start"], table["source_tex"], table.get("expanded_segments")))
    result = {"schema_version": 1, "table_id": table["table_id"], "groups": groups}
    result["cell_count"] = sum(len(group["data_cells"]) for group in groups)
    result["comparison_pair_count"] = sum(len(group["comparison_pairs"]) for group in groups)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--manifest", type=Path, required=True); parser.add_argument("--table-id", required=True); parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); manifest = json.loads(args.manifest.read_text(encoding="utf-8")); table = next(item for item in manifest["tables"] if item["table_id"] == args.table_id)
    result = build(table); args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"table_id": args.table_id, "cells": result["cell_count"], "comparison_pairs": result["comparison_pair_count"]}))
    return 0


if __name__ == "__main__": raise SystemExit(main())
