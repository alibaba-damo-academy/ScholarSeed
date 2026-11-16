#!/usr/bin/env scholarseed-skill-python
"""Prepare compact Figure jobs and deterministically finalize their cards."""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
INDEXER = SCRIPT_DIR / "index_latex_figures.py"
RENDERER = SCRIPT_DIR / "render_card.py"
VALIDATOR = SCRIPT_DIR / "validate_cards.py"
PDF_RENDERER = SCRIPT_DIR / "render_pdf_preview.py"
RASTER_NORMALIZER = SCRIPT_DIR / "normalize_raster_preview.py"


def index_module():
    spec = importlib.util.spec_from_file_location("figure_indexer", INDEXER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def prepare_numbering_aux(paper: Path, output: Path, explicit_mains: list[str]) -> tuple[Path | None, dict]:
    """Compile a temporary paper copy and retain only AUX evidence outside the source tree."""
    aux_output = output / "numbering-aux"
    existing = list(aux_output.rglob("*.aux")) if aux_output.is_dir() else []
    if existing:
        return aux_output, {"status": "reused", "aux_files": len(existing)}
    pdflatex = shutil.which("pdflatex")
    if not pdflatex:
        return None, {"status": "unavailable", "reason": "pdflatex not found"}
    try:
        if explicit_mains:
            mains = explicit_mains
        else:
            mains = [path.relative_to(paper).as_posix() for path in index_module().discover_main_files(paper)]
    except Exception as exc:
        return None, {"status": "unavailable", "reason": f"main discovery failed: {type(exc).__name__}: {exc}"}
    logs = []
    with tempfile.TemporaryDirectory(prefix="cpes-figure-numbering-") as temporary:
        copied = Path(temporary) / "paper"
        shutil.copytree(paper, copied, symlinks=True)
        successful = False
        for main in mains:
            for pass_number in (1, 2):
                try:
                    completed = subprocess.run(
                        [pdflatex, "-interaction=nonstopmode", "-halt-on-error", main],
                        cwd=copied, capture_output=True, text=True, timeout=180,
                    )
                    logs.append({"main": main, "pass": pass_number, "returncode": completed.returncode, "tail": (completed.stdout + completed.stderr)[-2000:]})
                    if completed.returncode != 0:
                        break
                    successful = True
                except subprocess.TimeoutExpired:
                    logs.append({"main": main, "pass": pass_number, "returncode": 124, "tail": "pdflatex timeout"})
                    break
        aux_files = list(copied.rglob("*.aux")) if successful else []
        if aux_files:
            aux_output.mkdir(parents=True, exist_ok=True)
            for source in aux_files:
                relative = source.relative_to(copied)
                destination = aux_output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
    metadata = {"status": "compiled" if aux_files else "failed", "aux_files": len(aux_files), "attempts": logs}
    (output / "numbering-compile.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return (aux_output if aux_files else None), metadata


def load(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return value


def numbered_span(paper: Path, relative: str, start: int, end: int) -> list[dict]:
    path = (paper / relative).resolve(strict=True)
    path.relative_to(paper)
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    start = max(1, start)
    end = min(len(lines), end)
    return [{"line": number, "text": lines[number - 1]} for number in range(start, end + 1)]


def numbered_mentions(paper: Path, mentions: list[dict], radius: int = 0) -> list[dict]:
    """Attach the physical reference line; expansion requires an explicit radius."""
    result: list[dict] = []
    seen: set[tuple[str, int]] = set()
    for mention in mentions:
        relative = mention["file"]
        line = int(mention["line_start"])
        key = (relative, line)
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "file": relative,
                "reference_line": line,
                "lines": numbered_span(paper, relative, line - radius, line + radius),
            }
        )
    return result


def schema_template(manifest: dict, figure: dict, visual_status: str = "inspected") -> dict:
    image_paths = [item["resolved_path"] for item in figure["images"] if item.get("resolved_path")]
    return {
        "schema_version": 7,
        "paper_id": manifest["paper_id"],
        "figure_id": figure["figure_id"],
        "label": figure["label"],
        "caption": figure["caption"],
        "source": {
            "tex_file": figure["source_tex"],
            "line_start": figure["line_start"],
            "line_end": figure["line_end"],
            "image_paths": image_paths,
        },
        "visual_status": visual_status,
        "overview": "",
        "panels": [],
        "how_to_read": [],
        "author_findings": [],
        "prerequisites": [],
        "scope": [],
    }


def pdf_python() -> Path:
    if importlib.util.find_spec("pypdfium2") and importlib.util.find_spec("PIL"):
        return Path(sys.executable)
    raise RuntimeError("PDF rendering requires pypdfium2 and Pillow")


def job_image_files(paper: Path, output: Path, figure: dict) -> tuple[list[str], list[dict], list[dict]]:
    files: list[str] = []
    renders: list[dict] = []
    unavailable: list[dict] = []
    for asset_index, item in enumerate(figure["images"], 1):
        relative = item.get("resolved_path")
        if not relative:
            unavailable.append(
                {"latex_path": item.get("latex_path"), "reason": "referenced asset could not be resolved"}
            )
            continue
        source = (paper / relative).resolve(strict=True)
        suffix = source.suffix.lower()
        target = output / "renders" / f"{figure['order']:03d}-{figure['figure_id']}-{asset_index:02d}-p{item.get('page', 1)}.png"
        if suffix == ".pdf":
            command = [
                str(pdf_python()), str(PDF_RENDERER), "--input", str(source),
                "--output", str(target), "--page", str(item.get("page", 1)),
            ]
        elif suffix in {".png", ".jpg", ".jpeg"}:
            command = [
                str(pdf_python()), str(RASTER_NORMALIZER), "--input", str(source),
                "--output", str(target),
            ]
        else:
            unavailable.append(
                {"source_relative": relative, "reason": f"unsupported visual format: {suffix or 'unknown'}"}
            )
            continue
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        metadata = json.loads(result.stdout)
        metadata["source_relative"] = relative
        metadata["source_format"] = suffix.lstrip(".")
        renders.append(metadata)
        files.append(str(target))
    return files, renders, unavailable


def normalize_card(card: dict, figure: dict) -> tuple[dict, list[str]]:
    """Repair narrow provider key aliases without inventing semantic content."""
    repairs: list[str] = []
    panels = []
    for index, panel in enumerate(card.get("panels", [])):
        if isinstance(panel, str):
            panels.append(
                {"panel_id": f"panel-{index + 1}", "title": "", "visual_observations": [panel]}
            )
            repairs.append(f"panels[{index}].string")
            continue
        if "panel_id" in panel and "visual_observations" in panel:
            panels.append(panel)
            continue
        panel_id = panel.get("id") or panel.get("name") or f"panel-{index + 1}"
        title = panel.get("title") or panel.get("name") or ""
        observations = panel.get("visual_observations")
        if not isinstance(observations, list):
            observations = []
            description = panel.get("description") or panel.get("visual") or panel.get("visual_pattern")
            if description:
                observations.append(str(description))
            for key in ("chart_type", "x_axis", "y_axis"):
                if panel.get(key):
                    observations.append(f"{key}: {panel[key]}")
            for key in ("curves", "annotations"):
                if isinstance(panel.get(key), list):
                    observations.extend(str(value) for value in panel[key])
        panels.append(
            {"panel_id": str(panel_id), "title": str(title), "visual_observations": observations}
        )
        repairs.append(f"panels[{index}]")
    card["panels"] = panels

    findings = []
    for index, finding in enumerate(card.get("author_findings", [])):
        if not isinstance(finding, dict):
            findings.append(finding)
            continue
        if "claim" not in finding and finding.get("finding"):
            finding = dict(finding)
            finding["claim"] = finding.pop("finding")
            repairs.append(f"author_findings[{index}].finding")
        evidence = finding.get("evidence")
        alias = next(
            (key for key in ("sources", "source", "source_spans") if isinstance(finding.get(key), list)),
            None,
        )
        if evidence is None and isinstance(finding.get("source"), dict):
            alias = "source"
            source = dict(finding["source"])
            if "file" not in source and source.get("span"):
                source = {
                    "file": figure["source_tex"],
                    "line_start": figure["line_start"],
                    "line_end": figure["line_end"],
                    "kind": "caption" if source.get("type") == "caption" else "other",
                }
            evidence = [source]
            finding = {key: value for key, value in finding.items() if key != alias}
            finding["evidence"] = evidence
            repairs.append(f"author_findings[{index}].source")
        if evidence is None and isinstance(finding.get("source"), str):
            match = re.fullmatch(r"(.+?):(\d+)(?:-(\d+))?", finding["source"].strip())
            if match:
                source_file, start, end = match.groups()
                finding = {key: value for key, value in finding.items() if key != "source"}
                finding["evidence"] = [
                    {
                        "file": source_file,
                        "line_start": int(start),
                        "line_end": int(end or start),
                        "kind": "appendix" if "appendix" in source_file.lower() else "body",
                    }
                ]
                evidence = finding["evidence"]
                repairs.append(f"author_findings[{index}].source-string")
        if evidence is None and isinstance(finding.get("source_span"), dict):
            span = dict(finding["source_span"])
            finding = {key: value for key, value in finding.items() if key not in {"source_span", "finding", "evidence_type"}}
            finding["claim"] = finding.get("claim") or card["author_findings"][index].get("finding", "")
            finding["evidence"] = [span]
            evidence = finding["evidence"]
            repairs.append(f"author_findings[{index}].source_span")
        if evidence is None and alias:
            evidence = finding[alias]
            finding = {key: value for key, value in finding.items() if key != alias}
            finding["evidence"] = evidence
            repairs.append(f"author_findings[{index}].{alias}")
        if evidence is not None and not isinstance(evidence, list):
            evidence = [evidence]
            finding["evidence"] = evidence
            repairs.append(f"author_findings[{index}].evidence-list")
        if isinstance(evidence, list):
            coerced = []
            for span_index, span in enumerate(evidence):
                values = []
                if isinstance(span, int):
                    values = [{"file": figure["source_tex"], "line_start": span, "line_end": span}]
                elif isinstance(span, str):
                    match = re.search(r"(.+?\.tex):(\d+)(?:-(\d+))?", span)
                    if match:
                        values = [{"file": match.group(1), "line_start": int(match.group(2)), "line_end": int(match.group(3) or match.group(2))}]
                    else:
                        match = re.search(r"\bline\s+(\d+)\b", span, re.IGNORECASE)
                        if match:
                            line = int(match.group(1))
                            values = [{"file": figure["source_tex"], "line_start": line, "line_end": line}]
                elif isinstance(span, dict):
                    if isinstance(span.get("citation"), dict):
                        values = [dict(span["citation"])]
                    elif isinstance(span.get("line"), int):
                        values = [{"file": span.get("file") or figure["source_tex"], "line_start": span["line"], "line_end": span["line"], "kind": span.get("kind")}]
                    elif isinstance(span.get("lines"), list):
                        values = [{"file": span.get("file") or figure["source_tex"], "line_start": int(line), "line_end": int(line), "kind": span.get("kind")} for line in span["lines"] if isinstance(line, int)]
                    elif isinstance(span.get("cited_lines"), list):
                        values = [{"file": span.get("file") or figure["source_tex"], "line_start": int(line), "line_end": int(line), "kind": span.get("kind")} for line in span["cited_lines"] if isinstance(line, int)]
                    elif isinstance(span.get("source"), str):
                        match = re.search(r"(?:line\s*)?(\d+)", span["source"], re.IGNORECASE)
                        if match:
                            line = int(match.group(1))
                            values = [{"file": figure["source_tex"], "line_start": line, "line_end": line}]
                    if not values:
                        values = [span]
                else:
                    values = [span]
                if values != [span]:
                    repairs.append(f"author_findings[{index}].evidence[{span_index}].coerce")
                coerced.extend(values)
            evidence[:] = coerced
            for span_index, span in enumerate(evidence):
                if not isinstance(span, dict):
                    continue
                if "file" not in span and span.get("span"):
                    evidence[span_index] = {
                        "file": figure["source_tex"],
                        "line_start": figure["line_start"],
                        "line_end": figure["line_end"],
                        "kind": "caption" if span.get("type") == "caption" else "other",
                    }
                    span = evidence[span_index]
                    repairs.append(f"author_findings[{index}].evidence[{span_index}].span")
                if "file" not in span and span.get("tex_file"):
                    span["file"] = span.pop("tex_file")
                    repairs.append(f"author_findings[{index}].evidence[{span_index}].tex_file")
                if span.get("kind") not in {"caption", "body", "appendix", "other"} and span.get("file"):
                    same_figure = (
                        span["file"] == figure["source_tex"]
                        and figure["line_start"] <= span.get("line_start", 0) <= figure["line_end"]
                    )
                    span["kind"] = "caption" if same_figure else (
                        "appendix" if "appendix" in span["file"].lower() else "body"
                    )
                    repairs.append(f"author_findings[{index}].evidence[{span_index}].kind")
        findings.append(finding)
    card["author_findings"] = findings

    return card, repairs


def prepare(args: argparse.Namespace) -> int:
    paper = args.paper.resolve(strict=True)
    output = args.output.resolve()
    if output == paper or paper in output.parents:
        raise SystemExit("output must be outside the source paper")
    output.mkdir(parents=True, exist_ok=True)
    (output / "jobs").mkdir(exist_ok=True)
    (output / "cards").mkdir(exist_ok=True)
    command = [sys.executable, str(INDEXER), str(paper), "--output", str(output / "manifest.json")]
    aux_root, numbering = prepare_numbering_aux(paper, output, args.main)
    if aux_root:
        command += ["--aux-root", str(aux_root)]
    for value in args.main:
        command += ["--main", value]
    for value in args.label:
        command += ["--label", value]
    for value in args.figure_id:
        command += ["--figure-id", value]
    subprocess.run(command, check=True)
    manifest = load(output / "manifest.json")
    manifest["numbering_resolution"] = {key: value for key, value in numbering.items() if key != "attempts"}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for figure in manifest["figures"]:
        image_files, renders, unavailable = job_image_files(paper, output, figure)
        visual_status = "unavailable" if not image_files else ("partial" if unavailable else "inspected")
        context = {
            "figure_source": numbered_span(
                paper,
                figure["source_tex"],
                figure["line_start"],
                figure["line_end"],
            ),
            "mentions": figure["mentions"],
            "numbered_mentions": numbered_mentions(paper, figure["mentions"]),
        }
        card_path = output / figure["card_json"]
        job = {
            "schema_version": 3,
            "instruction": "Inspect every image, copy card_template keys and fixed values exactly, and fill only empty content fields. Write overview as one or two short sentences. Never change caption or its number. Cite only exact lines in figure_source or numbered_mentions. Use context first and follow at most two additional source spans if strictly necessary.",
            "paper_root": str(paper),
            "image_files": image_files,
            "rendered_previews": renders,
            "unavailable_assets": unavailable,
            "card_json": str(card_path),
            "context": context,
            "card_template": schema_template(manifest, figure, visual_status),
        }
        job_name = Path(figure["card_json"]).stem + ".job.json"
        (output / "jobs" / job_name).write_text(
            json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    print(json.dumps({"jobs": manifest["figure_count"], "output": str(output)}, ensure_ascii=False))
    return 0


def finalize(args: argparse.Namespace) -> int:
    output = args.output.resolve(strict=True)
    manifest_path = output / "manifest.json"
    manifest = load(manifest_path)
    normalization = []
    for figure in manifest["figures"]:
        card_path = output / figure["card_json"]
        if not card_path.is_file():
            raise SystemExit(f"missing card JSON: {card_path}")
        card, repairs = normalize_card(load(card_path), figure)
        if repairs:
            card_path.write_text(json.dumps(card, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        normalization.append({"figure_id": figure["figure_id"], "repairs": repairs})
        subprocess.run(
            [
                sys.executable,
                str(RENDERER),
                "--manifest",
                str(manifest_path),
                "--card-json",
                str(card_path),
                "--output-dir",
                str(output),
            ],
            check=True,
        )
    (output / "normalization.json").write_text(
        json.dumps({"cards": normalization}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    subprocess.run(
        [sys.executable, str(VALIDATOR), "--manifest", str(manifest_path), "--cards-dir", str(output)],
        check=True,
    )
    with tempfile.TemporaryDirectory() as temp:
        fresh_path = Path(temp) / "manifest.json"
        command = [
            sys.executable,
            str(INDEXER),
            manifest["paper_root"],
            "--output",
            str(fresh_path),
        ]
        for value in manifest["main_files"]:
            command += ["--main", value]
        for figure in manifest["figures"]:
            if figure.get("label"):
                command += ["--label", figure["label"]]
            else:
                command += ["--figure-id", figure["figure_id"]]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        fresh = load(fresh_path)
        if fresh["source_sha256"] != manifest["source_sha256"]:
            raise SystemExit("source paper changed after preparation")
    print(json.dumps({"valid": True, "figures": manifest["figure_count"], "output": str(output)}))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare_parser = subparsers.add_parser("prepare")
    prepare_parser.add_argument("--paper", type=Path, required=True)
    prepare_parser.add_argument("--output", type=Path, required=True)
    prepare_parser.add_argument("--main", action="append", default=[])
    prepare_parser.add_argument("--label", action="append", default=[])
    prepare_parser.add_argument("--figure-id", action="append", default=[])
    prepare_parser.set_defaults(func=prepare)
    finalize_parser = subparsers.add_parser("finalize")
    finalize_parser.add_argument("--output", type=Path, required=True)
    finalize_parser.set_defaults(func=finalize)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
