#!/usr/bin/env scholarseed-skill-python
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .common import ConverterError, artifact, resolve_pdf, sha256_file, write_json
from .extract import extract_figures, extract_formulas, extract_tables, extract_text, normalize_pages


DOMAINS = ("text", "figure", "table", "formula")
WORKER = Path(__file__).with_name("worker.py")


def run(input_value: str, output_value: str, domains: Sequence[str], cwd: Path,
        figure_numbers: Sequence[str] | None = None, *, native_context: bool = False, figure_scope: str = 'all', compact_output: bool = False, cpes_direct: bool = False, table_numbers: Sequence[str] | None = None, figure_profile: str = 'deep') -> dict[str, Any]:
    started = time.monotonic()
    if figure_profile not in {'deep','fast'}:
        raise ConverterError('invalid_figure_profile', 'Figure profile must be deep or fast.')
    pdf = resolve_pdf(input_value, cwd)
    source_hash = sha256_file(pdf)
    raw_output = Path(output_value).expanduser()
    output = (raw_output if raw_output.is_absolute() else cwd / raw_output).resolve()
    if output.exists() and not cpes_direct:
        raise ConverterError("output_exists", "Output directory already exists.", output=str(output))
    if not cpes_direct:
        output.parent.mkdir(parents=True, exist_ok=True)
    targets = list(dict.fromkeys(str(n).strip().lower() for n in figure_numbers or []))
    if any(not re.fullmatch(r'[a-z]?\d+[a-z0-9.-]*', n) for n in targets):
        raise ConverterError('invalid_figure_number', 'Use printed Figure labels, for example 1, 7 or S1.')
    selected = list(dict.fromkeys(domains or (("figure",) if targets else DOMAINS)))
    if table_numbers and (selected!=['table'] or targets or not cpes_direct):
        raise ConverterError('invalid_scope','--table requires --domain table --cpes-direct.')
    if cpes_direct and selected==['table']:
        table_targets=list(dict.fromkeys(str(n).lower() for n in table_numbers or []))
        if figure_scope not in {'main','all'} or any(not re.fullmatch(r'(?:[a-z]?\d+[a-z0-9.-]*|[ivxlcdm]+)',n) for n in table_targets):
            raise ConverterError('invalid_scope','Invalid Table scope or number.')
        from .direct_tables import run_direct_tables
        return run_direct_tables(pdf,output,input_value,source_hash,table_targets,figure_scope,native_context,started)
    if figure_scope not in {'main','all'} or (figure_scope=='main' and selected!=['figure']):
        raise ConverterError('invalid_scope','Main-body Figure scope requires --domain figure.')
    if targets and selected != ['figure']:
        raise ConverterError('invalid_scope', '--figure supports figure-only requests; omit other --domain values.')
    if compact_output and selected!=['figure']:
        raise ConverterError('invalid_scope','Compact output requires figure-only extraction.')
    if cpes_direct:
        if selected != ['figure']:
            raise ConverterError('invalid_scope', 'CPES direct output requires --domain figure.')
        from .direct import run_direct
        return run_direct(pdf, output, input_value, source_hash, targets, figure_scope, native_context, started, figure_profile=figure_profile)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-", dir=output.parent))
    try:
        envelope_path = staging / "paddle-result.json"
        command = [sys.executable, str(WORKER), "--input", str(pdf), "--output", str(envelope_path)]
        if figure_scope=='main':command.extend(['--figure-scope',figure_scope])
        for domain in selected:
            command.extend(["--domain", domain])
        for number in targets:
            command.extend(['--figure', number])
        if device := os.environ.get("CPES_DEVICE"):
            command.extend(["--device", device])
        worker = subprocess.run(command, text=True, capture_output=True, timeout=7200, check=False)
        if worker.returncode != 0 or not envelope_path.is_file():
            raise ConverterError("paddle_failed", "Paddle document parsing failed.", exit_code=worker.returncode, stderr_tail=worker.stderr[-4000:])
        if sha256_file(pdf) != source_hash:
            raise ConverterError("source_changed", "PDF changed during conversion.")
        envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
        scope=envelope.get('search',{}).get('figure_scope',{'mode':figure_scope,'status':'unrestricted' if figure_scope=='all' else 'unknown','boundary':None})
        if figure_scope=='main' and scope['status']!='identified':
            raise ConverterError('body_boundary_unknown','No reliable References heading was found; main-body scope is uncertain. Request inclusion of appendices explicitly to process the whole document.',figure_scope=scope)
        raw_pages = sorted(envelope["pages"], key=lambda p: p['page_index'])
        pages = normalize_pages(raw_pages, allow_sparse=bool(targets) or figure_scope=='main')
        raw_dir = staging / "raw"
        if not compact_output:
            raw_dir.mkdir()
            for page, raw in zip(pages, raw_pages):
                write_json(raw_dir / f"page-{page['page_number']:04d}.json", raw)
        layout_path = staging / "layout.json"
        search = envelope.get('search', {})
        index_path = None
        if targets:
            index_path = staging / 'figure-index.json'
            write_json(index_path, {'schema_version': 'cpes-figure-index.v1',
                                   'pdf_sha256': source_hash, **search})
        write_json(layout_path, {
            "schema_version": "cpes-layout.v1", "status": "success",
            "source": {"input_path": input_value, "resolved_path": str(pdf), "sha256": source_hash},
            "engine": envelope["engine"], "parameters": envelope["parameters"],
            "page_count": search.get('document_page_count', len(pages)),
            "processed_page_count": len(pages), "scope": "selected_figures" if targets else "document",
            "region_count": sum(len(page["regions"]) for page in pages),
            "pages": pages,
            "figure_scope": scope,
        })
        rendered: dict[int, Any] = {}
        results = {}
        if "text" in selected:
            results["text"] = extract_text(pages, staging, source_hash=source_hash)
        if "figure" in selected:
            from .scope import filter_pages
            results["figure"] = extract_figures(pdf, filter_pages(pages,scope), staging, rendered, figure_numbers=targets, figure_profile=figure_profile)
        if "table" in selected:
            results["table"] = extract_tables(pdf, pages, staging, rendered)
        if "formula" in selected:
            results["formula"] = extract_formulas(pdf, pages, staging, rendered, envelope["engine"]["formula_model"])
        for page in pages:
            for issue in page['issues']:
                if issue.get('domain') in results:
                    result = results[issue['domain']]
                    result['issues'].append({**issue, 'page_number': page['page_number']})
                    result['status'] = 'partial' if result['count'] and result['status'] in {'success', 'partial'} else 'failed'
        status_values = [result["status"] for result in results.values()]
        if any(value == "failed" for value in status_values):
            overall = "partial" if any(value in {"success", "success_empty"} for value in status_values) else "failed"
        elif any(value == "partial" for value in status_values):
            overall = "partial"
        else:
            overall = "success"
        catalog_path = staging / "catalog.json"
        catalog = {
            "schema_version": "cpes-format-converter.v1", "converter_version": __version__,
            "status": overall,
            "source": {"input_path": input_value, "resolved_path": str(pdf), "sha256": source_hash},
            "engine": envelope["engine"], "requested_domains": selected,
            "requested_figures": targets,
            "figure_scope": scope,
            "layout": artifact(layout_path, staging), "domains": results,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
        if index_path:
            catalog['figure_index'] = artifact(index_path, staging)
        if native_context:
            from .native import export_native_context
            catalog['native_context'] = export_native_context(pdf, staging, source_hash, figure_scope=scope)
            if sha256_file(pdf) != source_hash:
                raise ConverterError('source_changed', 'PDF changed during native text extraction.')
        if compact_output:
            from .compact import compact_output as compact_artifacts
            compact_artifacts(staging,catalog)
        write_json(catalog_path, catalog)
        envelope_path.unlink()
        staging.replace(output)
        return {**catalog, "catalog": str(output / "catalog.json")}
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convert a research PDF into text, Figures, tables, and numbered formulas.")
    parser.add_argument("--input", required=True, help="Local PDF path")
    parser.add_argument("--output", default="cpes-format-output", help="New output directory")
    parser.add_argument("--domain", action="append", choices=DOMAINS, default=[], help="Process only this domain; repeat as needed")
    parser.add_argument("--table",action="append",default=[],help="Printed Table number (direct Table mode)")
    parser.add_argument('--figure-profile', choices=('deep','fast'), default='deep', help='deep: original/clear images + native visual text; fast: lower-resolution region bitmap only')
    parser.add_argument("--figure", action="append", default=[], help="Printed Figure number; repeat for multiple targets (figure-only scope)")
    parser.add_argument('--native-context', action='store_true', help='Export full native text for Figure context without additional layout or OCR')
    parser.add_argument('--figure-scope', choices=('main','all'), default='all', help='main stops at References; standalone converter defaults to all')
    parser.add_argument('--compact-output',action='store_true',help='Retain source text once and omit raw-page diagnostics (figure-only)')
    parser.add_argument('--cpes-direct', action='store_true', help='Write final Figure files into an existing CPES run and return metadata as JSON')
    args = parser.parse_args(argv)
    try:
        result = run(args.input, args.output, args.domain, Path.cwd().resolve(), figure_numbers=args.figure, native_context=args.native_context, figure_scope=args.figure_scope, compact_output=args.compact_output, cpes_direct=args.cpes_direct, table_numbers=args.table, figure_profile=args.figure_profile)
    except ConverterError as exc:
        print(json.dumps({"status": "failed", "reason_code": exc.code, "message": exc.message, "details": exc.details}, ensure_ascii=False))
        return 2
    except Exception as exc:
        print(json.dumps({"status": "failed", "reason_code": "internal_error", "message": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 3
    if args.cpes_direct:
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['catalog']['status'] == 'success' else 1
    print(json.dumps({
        "status": result["status"], "catalog": result["catalog"],
        "elapsed_seconds": result["elapsed_seconds"],
        "domains": {name: value["status"] for name, value in result["domains"].items()},
    }, ensure_ascii=False))
    return 0 if result["status"] == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
