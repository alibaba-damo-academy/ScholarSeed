#!/usr/bin/env scholarseed-skill-python
"""Index logical tables reachable from an arXiv LaTeX entrypoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path
from typing import Iterable
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'src'))
from cpes.latex_references import reference_mentions

INPUT_RE = re.compile(r"\\(?:input|include|subfile)\s*\{([^{}]+)\}")
TOKEN_RE = re.compile(r"\\(begin|end)\s*\{([^{}]+)\}")
LABEL_RE = re.compile(r"\\label\s*\{([^{}]+)\}")
REF_COMMANDS = "ref|autoref|cref|Cref|vref|Vref|prettyref"
ROOT_ENVS = {"table", "table*", "longtable"}
TABULAR_ENVS = {"tabular", "tabular*", "tabularx"}
MATH_ENVS = {
    "math", "displaymath", "equation", "equation*", "align", "align*",
    "gather", "gather*", "multline", "multline*", "array", "matrix",
    "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases",
}


def balanced_group(text: str, start: int) -> tuple[str, int] | None:
    """Read one balanced braced group beginning at or after start."""
    while start < len(text) and text[start].isspace():
        start += 1
    if start >= len(text) or text[start] != "{":
        return None
    depth, cursor = 1, start + 1
    while cursor < len(text):
        char = text[cursor]
        escaped = cursor > 0 and text[cursor - 1] == "\\"
        if char == "{" and not escaped:
            depth += 1
        elif char == "}" and not escaped:
            depth -= 1
            if depth == 0:
                return text[start + 1:cursor], cursor + 1
        cursor += 1
    return None


def parse_aux_labels(text: str) -> dict[str, str]:
    """Extract label -> rendered reference text from LaTeX AUX newlabel rows."""
    result: dict[str, str] = {}
    cursor = 0
    marker = "\\newlabel"
    while True:
        position = text.find(marker, cursor)
        if position < 0:
            break
        label_group = balanced_group(text, position + len(marker))
        if not label_group:
            cursor = position + len(marker)
            continue
        payload_group = balanced_group(text, label_group[1])
        if not payload_group:
            cursor = label_group[1]
            continue
        first = balanced_group(payload_group[0], 0)
        if first and label_group[0] and not label_group[0].startswith("sub@"):
            value = normalize_tex(first[0])
            if value:
                result[label_group[0]] = value
        cursor = payload_group[1]
    return result


def existing_aux_numbers(root: Path) -> tuple[dict[str, str], list[str]]:
    numbers: dict[str, str] = {}
    files: list[str] = []
    for path in sorted(root.rglob("*.aux")):
        try:
            relative = path.resolve().relative_to(root).as_posix()
            parsed = parse_aux_labels(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        if parsed:
            files.append(relative)
            numbers.update(parsed)
    return numbers, files


def compile_aux_numbers(root: Path, mains: list[Path]) -> tuple[dict[str, str], dict]:
    """Compile in an isolated output directory and parse generated AUX files."""
    pdflatex = shutil.which("pdflatex")
    if not pdflatex:
        return {}, {"status": "unavailable", "reason": "pdflatex is not installed"}
    combined: dict[str, str] = {}
    attempts: list[dict] = []
    with tempfile.TemporaryDirectory(prefix="cpes-table-numbering-") as temporary:
        sandbox = Path(temporary) / "source"
        output = Path(temporary) / "output"
        shutil.copytree(root, sandbox, symlinks=True)
        output.mkdir()
        environment = os.environ.copy()
        environment["TEXINPUTS"] = str(sandbox) + "//:" + environment.get("TEXINPUTS", "")
        for main in mains:
            relative = main.relative_to(root).as_posix()
            command = [pdflatex, "-interaction=nonstopmode", "-halt-on-error", "-output-directory", str(output), relative]
            returncode = None
            error = None
            for run in (1, 2):
                try:
                    process = subprocess.run(command, cwd=sandbox, env=environment, capture_output=True, text=True, errors="replace", timeout=45)
                    returncode = process.returncode
                    if process.returncode != 0:
                        error = (process.stdout + process.stderr)[-2000:]
                        break
                except (OSError, subprocess.TimeoutExpired) as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    break
            attempts.append({"main": relative, "returncode": returncode, "error": error})
        for path in sorted(output.rglob("*.aux")):
            combined.update(parse_aux_labels(path.read_text(encoding="utf-8", errors="replace")))
    status = "completed" if combined else "unavailable"
    return combined, {"status": status, "attempts": attempts}


def display_name(number: str | None) -> str | None:
    return f"Table {number}" if number else None


def strip_comments(text: str) -> str:
    """Remove comments while preserving offsets and newlines."""
    out: list[str] = []
    for line in text.splitlines(keepends=True):
        cut = None
        for index, char in enumerate(line):
            if char != "%":
                continue
            slashes = 0
            cursor = index - 1
            while cursor >= 0 and line[cursor] == "\\":
                slashes += 1
                cursor -= 1
            if slashes % 2 == 0:
                cut = index
                break
        if cut is None:
            out.append(line)
        else:
            suffix = "\n" if line.endswith("\n") else ""
            out.append(line[:cut] + " " * (len(line.rstrip("\n")) - cut) + suffix)
    return "".join(out)


def discover_main_files(root: Path) -> list[Path]:
    readme = root / "00README.json"
    if readme.is_file():
        try:
            value = json.loads(readme.read_text(encoding="utf-8"))
            found = [
                root / item["filename"] for item in value.get("sources", [])
                if item.get("usage") == "toplevel" and isinstance(item.get("filename"), str)
            ]
            found = [path.resolve() for path in found if path.is_file()]
            if found:
                return found
        except (OSError, TypeError, json.JSONDecodeError):
            pass
    found = []
    for path in sorted(root.glob("*.tex")):
        if "\\documentclass" in strip_comments(path.read_text(encoding="utf-8", errors="replace")):
            found.append(path.resolve())
    if len(found) == 1:
        return found
    if not found:
        raise ValueError("no top-level LaTeX source found")
    raise ValueError("multiple top-level LaTeX sources found; pass --main")


def resolve_tex(parent: Path, token: str, root: Path) -> Path | None:
    if any(char in token for char in "\\#$"):
        return None
    relative = Path(token.strip())
    candidates = [parent / relative, root / relative]
    if not relative.suffix:
        candidates += [candidate.with_suffix(".tex") for candidate in candidates]
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return resolved
    return None


def reachable_tex(root: Path, mains: Iterable[Path]) -> tuple[list[Path], list[dict]]:
    files: list[Path] = []
    edges: list[dict] = []
    seen: set[Path] = set()

    def visit(path: Path) -> None:
        path = path.resolve()
        if path in seen:
            return
        seen.add(path)
        files.append(path)
        text = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
        for match in INPUT_RE.finditer(text):
            child = resolve_tex(path.parent, match.group(1), root)
            edges.append({
                "from": path.relative_to(root).as_posix(),
                "token": match.group(1).strip(),
                "to": child.relative_to(root).as_posix() if child else None,
                "line": line_number(text, match.start()),
            })
            if child:
                visit(child)

    for main in mains:
        visit(main)
    return files, edges


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def braced_argument(text: str, command: str) -> str | None:
    match = re.search(r"\\" + re.escape(command) + r"(?:\s*\[[^\]]*\])?\s*\{", text)
    if not match:
        return None
    depth, index, start = 1, match.end(), match.end()
    while index < len(text):
        char = text[index]
        escaped = index > 0 and text[index - 1] == "\\"
        if char == "{" and not escaped:
            depth += 1
        elif char == "}" and not escaped:
            depth -= 1
            if depth == 0:
                return text[start:index]
        index += 1
    return None


def normalize_tex(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def slug(label: str | None, tex_file: Path, line: int) -> str:
    value = label or f"{tex_file.stem}-{line}"
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or f"table-{line}"


def find_environments(text: str) -> list[dict]:
    """Return outer table roots and standalone tabulars using a token stack."""
    stack: list[tuple[str, int, int, tuple[str, ...]]] = []
    roots: list[dict] = []
    for token in TOKEN_RE.finditer(text):
        action, env = token.group(1), token.group(2).strip()
        if action == "begin":
            ancestors = tuple(item[0] for item in stack)
            stack.append((env, token.start(), token.end(), ancestors))
            continue
        match_index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i][0] == env), None)
        if match_index is None:
            continue
        begin_env, start, body_start, ancestors = stack[match_index]
        stack = stack[:match_index]
        if begin_env in ROOT_ENVS and not any(item in ROOT_ENVS for item in ancestors):
            roots.append({"environment": begin_env, "start": start, "end": token.end(), "body_start": body_start})
        elif begin_env in TABULAR_ENVS and not any(item in ROOT_ENVS | TABULAR_ENVS | MATH_ENVS for item in ancestors):
            before = text[max(0, start - 300):start]
            if not re.search(r"\\newcommand|\\renewcommand|\\def\s*\\", before):
                roots.append({"environment": "standalone-" + begin_env, "start": start, "end": token.end(), "body_start": body_start})
    return sorted(roots, key=lambda item: item["start"])


def nested_environments(text: str, names: set[str]) -> list[dict]:
    """Return balanced occurrences of selected environments, including nesting metadata."""
    stack: list[tuple[str, int, int]] = []
    result: list[dict] = []
    for token in TOKEN_RE.finditer(text):
        action, env = token.group(1), token.group(2).strip()
        if action == "begin":
            stack.append((env, token.start(), token.end()))
            continue
        match_index = next((i for i in range(len(stack) - 1, -1, -1) if stack[i][0] == env), None)
        if match_index is None:
            continue
        begin_env, start, body_start = stack[match_index]
        stack = stack[:match_index]
        if begin_env in names:
            result.append({"environment": begin_env, "start": start, "body_start": body_start, "end": token.end()})
    return sorted(result, key=lambda item: item["start"])


def command_arguments(text: str, command: str) -> list[tuple[int, int, str]]:
    """Return balanced command arguments with source offsets."""
    result: list[tuple[int, int, str]] = []
    pattern = re.compile(r"\\" + re.escape(command) + r"(?:\s*\[[^\]]*\])?\s*")
    for match in pattern.finditer(text):
        group = balanced_group(text, match.end())
        if group:
            result.append((match.start(), group[1], group[0]))
    return result


def inside(position: int, ranges: list[dict]) -> bool:
    return any(item["start"] <= position < item["end"] for item in ranges)


def caption_hints(caption: str) -> dict[str, str]:
    """Extract explicit '(a) ... (b) ...' descriptions from an outer caption."""
    result: dict[str, str] = {}
    pattern = re.compile(r"\(([A-Za-z])\)\s*(.*?)(?=\s*\([A-Za-z]\)\s*|$)")
    for match in pattern.finditer(caption):
        value = normalize_tex(match.group(2)).rstrip(".;")
        if value:
            result[match.group(1).lower()] = value
    return result


def expand_inputs(text: str, tex_file: Path, root: Path, seen: set[Path] | None = None, base_line: int = 1) -> tuple[str, list[dict], list[dict]]:
    seen = set(seen or ())
    spans: list[dict] = []
    segments: list[dict] = []
    parts: list[str] = []
    output_length = 0

    def append_literal(value: str, source_file: Path, source_line: int) -> None:
        nonlocal output_length
        if not value:
            return
        start = output_length
        parts.append(value)
        output_length += len(value)
        segments.append({"output_start": start, "output_end": output_length, "file": source_file.relative_to(root).as_posix(), "source_line_start": source_line})

    cursor = 0
    for match in INPUT_RE.finditer(text):
        append_literal(text[cursor:match.start()], tex_file, base_line + text.count("\n", 0, cursor))
        child = resolve_tex(tex_file.parent, match.group(1), root)
        if child is None or child in seen:
            append_literal(match.group(0), tex_file, base_line + text.count("\n", 0, match.start()))
        else:
            child_text = strip_comments(child.read_text(encoding="utf-8", errors="replace"))
            spans.append({"file": child.relative_to(root).as_posix(), "line_start": 1, "line_end": len(child_text.splitlines()), "include_token": match.group(1).strip()})
            expanded, nested, child_segments = expand_inputs(child_text, child, root, seen | {child}, 1)
            offset = output_length
            parts.append(expanded)
            output_length += len(expanded)
            segments.extend({**segment, "output_start": segment["output_start"] + offset, "output_end": segment["output_end"] + offset} for segment in child_segments)
            spans.extend(nested)
        cursor = match.end()
    append_literal(text[cursor:], tex_file, base_line + text.count("\n", 0, cursor))
    return "".join(parts), spans, segments


def split_rows_and_cells(source: str) -> list[list[str]]:
    """Provide conservative source-preserving cell hints, not semantic parsing."""
    begin = re.search(r"\\begin\s*\{(?:tabular\*?|tabularx|longtable)\}(?:\s*\{[^{}]*\}){0,2}", source)
    end = list(re.finditer(r"\\end\s*\{(?:tabular\*?|tabularx|longtable)\}", source))
    body = source[begin.end():end[-1].start()] if begin and end else source
    body = re.sub(r"\\(?:toprule|midrule|bottomrule|hline|cline\s*\{[^{}]*\}|cmidrule(?:\([^)]*\))?\s*\{[^{}]*\})", "", body)
    rows: list[list[str]] = []
    for row in re.split(r"(?<!\\)\\\\(?:\s*\[[^\]]*\])?", body):
        cells = [normalize_tex(cell) for cell in re.split(r"(?<!\\)&", row)]
        if any(cells):
            rows.append(cells)
    return rows


def excerpt(text: str, offset: int, radius: int = 8) -> tuple[int, int, str]:
    lines = text.splitlines()
    line = line_number(text, offset)
    start, end = max(1, line - radius), min(len(lines), line + radius)
    return start, end, "\n".join(lines[start - 1:end])


def source_checksum(paths: Iterable[Path], root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def build_manifest(root: Path, mains: list[Path]) -> dict:
    tex_files, edges = reachable_tex(root, mains)
    texts = {path: strip_comments(path.read_text(encoding="utf-8", errors="replace")) for path in tex_files}
    included_inside: set[Path] = set()
    included_outside: set[Path] = set()
    for parent, text in texts.items():
        table_ranges = [(item["start"], item["end"]) for item in find_environments(text) if item["environment"] in ROOT_ENVS]
        for match in INPUT_RE.finditer(text):
            child = resolve_tex(parent.parent, match.group(1), root)
            if child is None:
                continue
            target = included_inside if any(start <= match.start() < end for start, end in table_ranges) else included_outside
            target.add(child)
    owned_fragments = included_inside - included_outside
    records: list[dict] = []
    used: set[str] = set()
    for tex_file in tex_files:
        if tex_file in owned_fragments:
            continue
        text = texts[tex_file]
        for block in find_environments(text):
            source = text[block["start"]:block["end"]]
            subtable_ranges = nested_environments(source, {"subtable"})
            labels_with_offsets = [(match.start(), match.group(1).strip()) for match in LABEL_RE.finditer(source)]
            outer_labels = [label for position, label in labels_with_offsets if not inside(position, subtable_ranges)]
            label = outer_labels[0] if outer_labels else (labels_with_offsets[0][1] if labels_with_offsets and not subtable_ranges else None)
            caption_candidates = command_arguments(source, "caption")
            outer_captions = [value for position, _, value in caption_candidates if not inside(position, subtable_ranges)]
            outer_caption = normalize_tex(outer_captions[0]) if outer_captions else ""
            hints = caption_hints(outer_caption)
            start_line = line_number(text, block["start"])
            table_id = slug(label, tex_file, start_line)
            base, suffix = table_id, 2
            while table_id in used:
                table_id, suffix = f"{base}-{suffix}", suffix + 1
            used.add(table_id)
            expanded, included, expanded_segments = expand_inputs(source, tex_file, root, {tex_file}, start_line)
            subtables = []
            for sub_order, subtable in enumerate(subtable_ranges, 1):
                subsource = source[subtable["start"]:subtable["end"]]
                sublabel_match = LABEL_RE.search(subsource)
                sublabel = sublabel_match.group(1).strip() if sublabel_match else None
                subcaptions = command_arguments(subsource, "caption")
                subcaption = normalize_tex(subcaptions[0][2]) if subcaptions else ""
                marker = chr(ord("a") + sub_order - 1)
                sub_start_line = start_line + line_number(source, subtable["start"]) - 1
                subexpanded, _, subsegments = expand_inputs(subsource, tex_file, root, {tex_file}, sub_start_line)
                subtables.append({
                    "order": sub_order,
                    "marker": marker,
                    "label": sublabel,
                    "caption": subcaption,
                    "caption_hint": hints.get(marker, ""),
                    "source_tex": tex_file.relative_to(root).as_posix(),
                    "line_start": sub_start_line,
                    "line_end": start_line + line_number(source, subtable["end"]) - 1,
                    "source_sha256": hashlib.sha256(subsource.encode()).hexdigest(),
                    "source_latex": subexpanded,
                    "source_segments": subsegments,
                    "normalized_rows": split_rows_and_cells(subexpanded),
                })
            order = len(records) + 1
            stem = f"{order:03d}-{table_id}"
            records.append({
                "order": order,
                "table_id": table_id,
                "environment": block["environment"],
                "label": label,
                "caption": outer_caption,
                "source_tex": tex_file.relative_to(root).as_posix(),
                "line_start": start_line,
                "line_end": line_number(text, block["end"]),
                "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "source_latex": source,
                "expanded_latex": expanded,
                "expanded_segments": expanded_segments,
                "included_sources": included,
                "normalized_rows": [] if subtables else split_rows_and_cells(expanded),
                "subtables": subtables,
                "mentions": [],
                "card_json": f"cards/{stem}.json",
                "card_markdown": f"cards/{stem}.md",
                "render_png": f"renders/{stem}.png",
            })
    existing_numbers, aux_files = existing_aux_numbers(root)
    required_labels = {str(record["label"]) for record in records if record["label"]}
    missing_labels = required_labels - set(existing_numbers)
    compiled_numbers: dict[str, str] = {}
    compile_report = {"status": "not_needed", "attempts": []}
    if missing_labels:
        compiled_numbers, compile_report = compile_aux_numbers(root, mains)
    for record in records:
        label = record["label"]
        if label and label in existing_numbers:
            number, number_source = existing_numbers[label], "aux"
        elif label and label in compiled_numbers:
            number, number_source = compiled_numbers[label], "isolated_compile"
        else:
            number, number_source = None, "unavailable"
        record["table_number"] = number
        record["display_name"] = display_name(number)
        record["number_source"] = number_source
        record["card_order"] = record["order"]
        record['mentions']=[]
        for path,text in texts.items():
            for mention in reference_mentions(text,'table',number,label=label):
                line=mention['reference_line']
                record['mentions'].append({'file':path.relative_to(root).as_posix(),
                    'reference_line':line,'line_start':line,'line_end':line,
                    'text':mention['lines'][0]['text'],'verified_reference':True})
        for subtable in record["subtables"]:
            sublabel = subtable["label"]
            if sublabel and sublabel in existing_numbers:
                subnumber, subsource = existing_numbers[sublabel], "aux"
            elif sublabel and sublabel in compiled_numbers:
                subnumber, subsource = compiled_numbers[sublabel], "isolated_compile"
            else:
                subnumber, subsource = None, "unavailable"
            subtable["table_number"] = subnumber
            subtable["display_name"] = display_name(subnumber)
            subtable["number_source"] = subsource
    return {
        "schema_version": 6,
        "paper_id": root.name,
        "paper_root": str(root),
        "main_files": [path.relative_to(root).as_posix() for path in mains],
        "reachable_tex_files": [path.relative_to(root).as_posix() for path in tex_files],
        "include_graph": edges,
        "source_sha256": source_checksum(tex_files, root),
        "number_resolution": {
            "existing_aux_files": aux_files,
            "existing_aux_label_count": len(existing_numbers),
            "isolated_compile": compile_report,
            "isolated_compile_label_count": len(compiled_numbers),
        },
        "table_count": len(records),
        "tables": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper_root", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--main", action="append", default=[])
    parser.add_argument("--label", action="append", default=[])
    parser.add_argument("--table-id", action="append", default=[])
    args = parser.parse_args()
    root = args.paper_root.resolve(strict=True)
    if not root.is_dir():
        raise SystemExit("paper_root must be a directory")
    if args.main:
        mains = []
        for value in args.main:
            path = (root / value).resolve(strict=True)
            path.relative_to(root)
            mains.append(path)
    else:
        mains = discover_main_files(root)
    manifest = build_manifest(root, mains)
    records = manifest["tables"]
    if args.label:
        requested = set(args.label)
        available = {item["label"] for item in records if item["label"]}
        missing = requested - available
        if missing:
            raise SystemExit("requested table label(s) not found: " + ", ".join(sorted(missing)))
        records = [item for item in records if item["label"] in requested]
    if args.table_id:
        requested = set(args.table_id)
        available = {item["table_id"] for item in records}
        missing = requested - available
        if missing:
            raise SystemExit("requested table ID(s) not found: " + ", ".join(sorted(missing)))
        records = [item for item in records if item["table_id"] in requested]
    for order, item in enumerate(records, 1):
        item["order"] = order
        item["card_order"] = order
        stem = f"{order:03d}-{item['table_id']}"
        item["card_json"] = f"cards/{stem}.json"
        item["card_markdown"] = f"cards/{stem}.md"
        item["render_png"] = f"renders/{stem}.png"
    manifest["tables"] = records
    manifest["table_count"] = len(records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"table_count": len(records), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
