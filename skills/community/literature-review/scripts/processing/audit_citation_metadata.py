#!/usr/bin/env scholarseed-skill-python
"""Audit corpus BibTeX completeness for every supported citation style.

PaperHub values are treated as authoritative.  This script checks only whether
the fields needed to render a complete entry exist; it never second-guesses a
title, author, year, DOI, or venue.
"""
from __future__ import annotations

import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths
slr_paths.bootstrap(__file__)

import argparse
import json
from pathlib import Path

from citation_formats import BibEntry, parse_bib_file
from citation_styles import CITATION_STYLES, PAPERHUB_FIELD_AVAILABILITY


def _has(entry: BibEntry, expression: str) -> bool:
    for field in expression.split("|"):
        field = field.strip().lower()
        if field == "author" and entry.authors:
            return True
        if field == "entry_type" and entry.entry_type:
            return True
        if (entry.fields.get(field) or "").strip():
            return True
    return False


def _availability(expression: str) -> str:
    fields = set(expression.split("|"))
    direct = PAPERHUB_FIELD_AVAILABILITY["direct"]
    upstream = PAPERHUB_FIELD_AVAILABILITY["optional_or_upstream_bibtex"]
    if fields & direct:
        return "paperhub_direct"
    if fields & upstream:
        return "paperhub_optional_or_upstream_bibtex"
    return "not_provided_by_paperhub"


def audit(workspace: Path) -> dict:
    bib_path = workspace / "03_process" / "references.bib"
    entries = parse_bib_file(bib_path)
    if not entries:
        raise ValueError(f"no parseable entries in {bib_path}")

    selected_path = workspace / "02_retrieval" / "selected_paper.json"
    selected = {}
    if selected_path.is_file():
        try:
            selected = json.loads(selected_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            selected = {}
    upstream_count = sum(
        1 for item in selected.values() if isinstance(item, dict)
        and isinstance(item.get("citationStyles"), dict)
        and (item["citationStyles"].get("bibtex") or "").strip()
    )

    styles: dict[str, dict] = {}
    for sid, spec in CITATION_STYLES.items():
        rows = []
        required_ok = 0
        complete = 0
        for key, entry in sorted(entries.items()):
            missing_required = [f for f in spec["required"] if not _has(entry, f)]
            recommended = spec["recommended"] + spec.get("recommended_by_type", {}).get(entry.entry_type, [])
            missing_recommended = [f for f in recommended if not _has(entry, f)]
            required_ok += not missing_required
            complete += not missing_required and not missing_recommended
            if missing_required or missing_recommended:
                rows.append({
                    "key": key,
                    "entry_type": entry.entry_type,
                    "missing_required": missing_required,
                    "missing_recommended": missing_recommended,
                })
        required_contract = [
            {"field": field, "availability": _availability(field)}
            for field in spec["required"]
        ]
        recommended_contract = [
            {"field": field, "availability": _availability(field)}
            for field in spec["recommended"]
        ]
        at_risk = [
            row for row in required_contract + recommended_contract
            if row["availability"] != "paperhub_direct"
        ]
        styles[sid] = {
            "label": spec["label"],
            "metadata_risk": spec["metadata_risk"],
            "entries": len(entries),
            "minimum_ready": required_ok,
            "minimum_ready_percent": round(100 * required_ok / len(entries), 1),
            "fully_populated": complete,
            "fully_populated_percent": round(100 * complete / len(entries), 1),
            "required_contract": required_contract,
            "recommended_contract": recommended_contract,
            "fields_not_guaranteed_by_paperhub": at_risk,
            "incomplete_entries": rows,
        }

    return {
        "policy": (
            "PaperHub metadata is trusted as returned; this report measures completeness only."
        ),
        "paperhub_contract": {
            key: sorted(value) for key, value in PAPERHUB_FIELD_AVAILABILITY.items()
        },
        "entries": len(entries),
        "entries_with_upstream_bibtex": upstream_count,
        "entries_synthesised_from_normalized_fields": len(entries) - upstream_count,
        "styles": styles,
    }


def _write_markdown(path: Path, report: dict) -> None:
    lines = [
        "# Citation metadata audit",
        "",
        "> PaperHub metadata is trusted as returned. This report checks completeness, not truth.",
        "",
        f"Corpus: {report['entries']} entries; {report['entries_with_upstream_bibtex']} carry "
        "upstream BibTeX and "
        f"{report['entries_synthesised_from_normalized_fields']} are synthesized.",
        "",
        "| Style | Minimum-ready | Fully populated | Important warning |",
        "|---|---:|---:|---|",
    ]
    for sid, row in report["styles"].items():
        lines.append(
            f"| `{sid}` — {row['label']} | {row['minimum_ready']}/{row['entries']} "
            f"({row['minimum_ready_percent']}%) | {row['fully_populated']}/{row['entries']} "
            f"({row['fully_populated_percent']}%) | **{row['metadata_risk']}** |"
        )
    lines += ["", "## Fields PaperHub does not guarantee", ""]
    for sid, row in report["styles"].items():
        risks = ", ".join(
            f"`{item['field']}` ({item['availability']})"
            for item in row["fields_not_guaranteed_by_paperhub"]
        ) or "none"
        lines += [f"- **{sid}**: {risks}"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("workspace", nargs="?", default=".")
    ap.add_argument("--style", choices=tuple(CITATION_STYLES))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    workspace = Path(args.workspace).resolve()
    try:
        report = audit(workspace)
    except ValueError as exc:
        print(json.dumps({"status": "FAILED", "status_reason": str(exc)}, ensure_ascii=False))
        return 1
    out_dir = workspace / "03_process"
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "citation_metadata_audit.json"
    md_path = out_dir / "citation_metadata_audit.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _write_markdown(md_path, report)
    if args.json:
        payload = report["styles"].get(args.style) if args.style else report
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        summary = {
            sid: {
                "minimum_ready_percent": row["minimum_ready_percent"],
                "fully_populated_percent": row["fully_populated_percent"],
                "fields_not_guaranteed": [
                    item["field"] for item in row["fields_not_guaranteed_by_paperhub"]
                ],
            }
            for sid, row in report["styles"].items()
            if not args.style or sid == args.style
        }
        print(json.dumps({
            "status": "SUCCESS",
            "status_reason": "PaperHub values trusted; citation completeness audited",
            "styles": summary,
            "report": str(md_path),
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
