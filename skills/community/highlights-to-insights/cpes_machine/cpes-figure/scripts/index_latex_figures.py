#!/usr/bin/env scholarseed-skill-python
"""Index image inclusions reachable from an arXiv LaTeX entrypoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Iterable
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'src'))
from cpes.latex_references import reference_mentions

IMAGE_EXTENSIONS = (".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg")
INPUT_RE = re.compile(r"\\(?:input|include|subfile)\s*\{([^{}]+)\}")
FIGURE_RE = re.compile(
    r"\\begin\s*\{(figure\*?)\}(.*?)\\end\s*\{\1\}", re.DOTALL
)
GRAPHICS_RE = re.compile(r"\\includegraphics(?:\s*\[([^\]]*)\])?\s*\{([^{}]+)\}")
LABEL_RE = re.compile(r"\\label\s*\{([^{}]+)\}")
REF_RE_TEMPLATE = r"\\(?:ref|autoref|cref|Cref|vref|Vref)\s*\{{{label}\}}"
AUX_LABEL_RE = re.compile(r"\\newlabel\{([^{}]+)\}\{\{([^{}]*)\}")


def strip_comments(text: str) -> str:
    lines: list[str] = []
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
            lines.append(line)
        elif line.endswith("\n"):
            lines.append(line[:cut] + "\n")
        else:
            lines.append(line[:cut])
    return "".join(lines)


def braced_argument(text: str, command: str) -> str | None:
    match = re.search(r"\\" + re.escape(command) + r"\s*(?:\[[^\]]*\]\s*)?\{", text)
    if not match:
        return None
    start = match.end()
    depth = 1
    index = start
    while index < len(text):
        if text[index] == "{" and (index == 0 or text[index - 1] != "\\"):
            depth += 1
        elif text[index] == "}" and (index == 0 or text[index - 1] != "\\"):
            depth -= 1
            if depth == 0:
                return text[start:index]
        index += 1
    return None


def normalize_tex(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def caption_text(body: str) -> str:
    """Return the long caption text without embedded label commands."""
    value = braced_argument(body, "caption")
    if not value:
        return ""
    return normalize_tex(LABEL_RE.sub("", value))


def aux_figure_numbers(root: Path) -> dict[str, str]:
    """Read resolved LaTeX numbers when compilation artifacts are available."""
    numbers: dict[str, str] = {}
    for path in sorted(root.rglob("*.aux")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for label, number in AUX_LABEL_RE.findall(text):
            if label and number and label not in numbers:
                numbers[label] = normalize_tex(number)
    return numbers


def caption_record(text: str, order: int, label: str | None, aux_numbers: dict[str, str]) -> dict:
    number = aux_numbers.get(label or "")
    source = "aux" if number else "logical-order"
    number = number or str(order)
    display = f"Figure {number}."
    if text:
        display += f" {text}"
    return {
        "number": number,
        "text": text,
        "display": display,
        "number_source": source,
        "number_uncertain": source != "aux",
    }


def discover_main_files(root: Path) -> list[Path]:
    readme = root / "00README.json"
    if readme.is_file():
        try:
            data = json.loads(readme.read_text(encoding="utf-8"))
            values = [
                root / item["filename"]
                for item in data.get("sources", [])
                if item.get("usage") == "toplevel" and isinstance(item.get("filename"), str)
            ]
            values = [path for path in values if path.is_file()]
            if values:
                return values
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    candidates = []
    for path in sorted(root.glob("*.tex")):
        try:
            if "\\documentclass" in strip_comments(path.read_text(encoding="utf-8", errors="replace")):
                candidates.append(path)
        except OSError:
            continue
    if len(candidates) == 1:
        return candidates
    if not candidates:
        raise ValueError("no top-level LaTeX source found")
    raise ValueError("multiple top-level LaTeX sources found; pass --main")


def resolve_tex(parent: Path, token: str, root: Path) -> Path | None:
    if any(char in token for char in "\\#$"):
        return None
    candidate = Path(token)
    options = [parent / candidate, root / candidate]
    if not candidate.suffix:
        options += [path.with_suffix(".tex") for path in options]
    for option in options:
        try:
            resolved = option.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return resolved
    return None


def reachable_tex(root: Path, mains: Iterable[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[Path] = set()

    def visit(path: Path) -> None:
        path = path.resolve()
        if path in seen:
            return
        seen.add(path)
        result.append(path)
        text = strip_comments(path.read_text(encoding="utf-8", errors="replace"))
        for token in INPUT_RE.findall(text):
            child = resolve_tex(path.parent, token.strip(), root)
            if child:
                visit(child)

    for main in mains:
        visit(main)
    return result


def resolve_image(root: Path, tex_file: Path, token: str) -> tuple[str | None, bool]:
    if any(char in token for char in "\\#$"):
        return None, False
    raw = Path(token.strip())
    bases = [tex_file.parent / raw, root / raw]
    candidates: list[Path] = []
    for base in bases:
        candidates.append(base)
        if not base.suffix:
            candidates.extend(base.with_suffix(ext) for ext in IMAGE_EXTENSIONS)
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
            relative = resolved.relative_to(root)
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return relative.as_posix(), True
    return None, False


def line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def slug(label: str | None, tex_file: Path, line: int) -> str:
    value = label or f"{tex_file.stem}-{line}"
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or f"figure-{line}"


def context_excerpt(text: str, offset: int, radius: int = 3) -> str:
    reference_index = line_number(text, offset) - 1
    lines = text.splitlines()
    return normalize_tex("\n".join(lines[max(0, reference_index - radius):reference_index + radius + 1]))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paper_root", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--aux-root", type=Path, help="optional compiled AUX tree used only for resolved display numbers")
    parser.add_argument("--main", action="append", default=[])
    parser.add_argument(
        "--label",
        action="append",
        default=[],
        help="retain only the named Figure label; repeat for multiple labels",
    )
    parser.add_argument(
        "--figure-id",
        action="append",
        default=[],
        help="retain only the generated manifest Figure ID; repeat for multiple IDs",
    )
    args = parser.parse_args()

    root = args.paper_root.resolve(strict=True)
    if not root.is_dir():
        raise SystemExit("paper_root must be a directory")
    mains = []
    if args.main:
        for value in args.main:
            path = (root / value).resolve(strict=True)
            path.relative_to(root)
            mains.append(path)
    else:
        mains = discover_main_files(root)
    tex_files = reachable_tex(root, mains)
    texts = {
        path: strip_comments(path.read_text(encoding="utf-8", errors="replace"))
        for path in tex_files
    }
    aux_root = args.aux_root.resolve(strict=True) if args.aux_root else root
    aux_numbers = aux_figure_numbers(aux_root)

    records: list[dict[str, object]] = []
    used_ids: set[str] = set()
    for tex_file in tex_files:
        text = texts[tex_file]
        covered: list[tuple[int, int]] = []
        blocks: list[tuple[int, int, str, str]] = []
        for match in FIGURE_RE.finditer(text):
            blocks.append((match.start(), match.end(), match.group(1), match.group(2)))
            covered.append((match.start(), match.end()))
        for match in GRAPHICS_RE.finditer(text):
            if not any(start <= match.start() < end for start, end in covered):
                blocks.append((match.start(), match.end(), "standalone", match.group(0)))
        blocks.sort(key=lambda item: item[0])

        for start, end, environment, body in blocks:
            graphics = GRAPHICS_RE.findall(body)
            if not graphics:
                continue
            label_match = LABEL_RE.search(body)
            label = label_match.group(1).strip() if label_match else None
            start_line = line_number(text, start)
            figure_id = slug(label, tex_file, start_line)
            suffix = 2
            base_id = figure_id
            while figure_id in used_ids:
                figure_id = f"{base_id}-{suffix}"
                suffix += 1
            used_ids.add(figure_id)

            images = []
            for options, token in graphics:
                resolved, exists = resolve_image(root, tex_file, token)
                page_match = re.search(r"(?:^|,)\s*page\s*=\s*(\d+)", options or "")
                images.append(
                    {
                        "latex_path": token.strip(),
                        "latex_options": (options or "").strip(),
                        "page": int(page_match.group(1)) if page_match else 1,
                        "resolved_path": resolved,
                        "exists": exists,
                    }
                )
            order = len(records) + 1
            card_stem = f"{order:03d}-{figure_id}"
            caption = caption_record(caption_text(body), order, label, aux_numbers)
            records.append(
                {
                    "order": order,
                    "figure_id": figure_id,
                    "environment": environment,
                    "label": label,
                    "source_tex": tex_file.relative_to(root).as_posix(),
                    "line_start": start_line,
                    "line_end": line_number(text, end),
                    "caption": caption,
                    "images": images,
                    "mentions": [],
                    "card_json": f"cards/{card_stem}.json",
                    "card_markdown": f"cards/{card_stem}.md",
                }
            )

    if args.label:
        requested = set(args.label)
        available = {str(record["label"]) for record in records if record["label"]}
        missing_labels = sorted(requested - available)
        if missing_labels:
            raise ValueError("requested Figure label(s) not found: " + ", ".join(missing_labels))
        records = [record for record in records if record["label"] in requested]
    if args.figure_id:
        requested_ids = set(args.figure_id)
        available_ids = {str(record["figure_id"]) for record in records}
        missing_ids = sorted(requested_ids - available_ids)
        if missing_ids:
            raise ValueError("requested Figure ID(s) not found: " + ", ".join(missing_ids))
        records = [record for record in records if record["figure_id"] in requested_ids]

    for order, record in enumerate(records, 1):
        record["order"] = order
        card_stem = f"{order:03d}-{record['figure_id']}"
        record["card_json"] = f"cards/{card_stem}.json"
        record["card_markdown"] = f"cards/{card_stem}.md"

    for record in records:
        label = record["label"]
        number = record['caption']['number'] if not record['caption']['number_uncertain'] else None
        for tex_file, text in texts.items():
            for mention in reference_mentions(text,'figure',number,label=label):
                line = mention['reference_line']
                record["mentions"].append(
                    {
                        "file": tex_file.relative_to(root).as_posix(),
                        "line_start": line,
                        "line_end": line,
                        "excerpt": mention['lines'][0]['text'],
                    }
                )

    digest = hashlib.sha256()
    for path in sorted(tex_files):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    manifest = {
        "schema_version": 1,
        "paper_id": root.name,
        "paper_root": str(root),
        "main_files": [path.relative_to(root).as_posix() for path in mains],
        "reachable_tex_files": [path.relative_to(root).as_posix() for path in tex_files],
        "source_sha256": digest.hexdigest(),
        "figure_count": len(records),
        "figures": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"figure_count": len(records), "output": str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
