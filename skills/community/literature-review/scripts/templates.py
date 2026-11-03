#!/usr/bin/env scholarseed-skill-python
"""Registry and integrity checks for the one rendered template and citation styles."""
from __future__ import annotations

import sys as _slr_sys
import pathlib as _slr_pathlib

for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import shutil  # noqa: E402
import sys  # noqa: E402

import slr_paths as _slr_paths  # noqa: E402
from citation_styles import CITATION_STYLES  # noqa: E402

HOME = _slr_paths.HOME
ASSETS = HOME / "assets"
RENDERED_TEMPLATE = "neurips"
FALLBACK_TEMPLATE = RENDERED_TEMPLATE

LATEX_AUTHORING_GUIDANCE = r'''TEMPLATE CAPABILITIES
The assembled document uses the NeurIPS preprint template for English and
ctexart with XeLaTeX and Fandol fonts for Chinese. Its mathematical facilities
come from amsmath, amssymb and bm. Use standard LaTeX mathematics, aligned
equations, cases, operators and equation references. Blackboard-bold notation
uses \mathbb with uppercase Latin letters; indicator functions use an explicitly
defined uppercase blackboard-bold symbol. Bold mathematical symbols use \bm,
and upright bold Latin symbols use \mathbf. Define notation consistently and
preserve the meaning of every mathematical statement.

The template provides booktabs, array, tabularx and longtable for tables,
graphicx for images, caption for captions,
hyperref for links and natbib for citations. Chapter content supplies prose,
mathematics and its assigned native tables. The document assembler supplies
the preamble, package loading, bibliography and figure wrappers. Use the
supplied citation keys and asset labels within this shared document structure.'''

# English generation has one real code path: the NeurIPS preprint preamble in
# phase05_merge_full_draft.py. Chinese generation uses ctexart and therefore
# does not present a template choice.
TEMPLATES: dict[str, dict] = {
    "ctexart": {"title":"Chinese ctexart", "language":"CHINESE", "documentclass":r"\documentclass{ctexart}",
                "package":"ctexart", "package_options":"", "files":[], "notes":"Chinese renderer; requires XeLaTeX and ctexart.cls."},
    "neurips": {
        "title": "NeurIPS 2026 preprint",
        "documentclass": "\\documentclass{article}",
        "package": "neurips_2026",
        "package_options": "preprint",
        "loaded_packages": {"natbib": {"disabled_options": ["nonatbib"]}},
        "files": [
            "assets/templates/neurips/neurips_2026.sty",
        ],
        "notes": (
            "The generation pipeline's English preamble uses this vendored "
            "style. Chinese runs use ctexart."
        ),
    },
}


def bst_location(style_id: str) -> tuple[str | None, str]:
    """Return the vendored bibliography-style path and its provenance."""
    candidate = HOME / CITATION_STYLES[style_id]["asset"]
    return (str(candidate), "shipped") if candidate.is_file() else (None, "missing")


def list_templates() -> list[dict]:
    rows: list[dict] = []
    for template_id, spec in TEMPLATES.items():
        missing = [path for path in spec["files"] if not (HOME / path).is_file()]
        row = {
            "id": template_id,
            "title": spec["title"], "language":spec.get("language","ENGLISH"),
            "notes": spec["notes"],
            "files": spec["files"],
            "documentclass": spec["documentclass"],
            "package": spec["package"],
            "package_options": spec["package_options"],
            "renders": True,
            "missing_files": missing,
            "status": "broken" if missing else "installed",
        }
        if missing:
            row["action"] = (
                f"{template_id} is registered but {', '.join(missing)} is missing; "
                "restore the complete skill package"
            )
        rows.append(row)
    return rows


def resolve_template(template_id: str) -> dict:
    if template_id not in TEMPLATES:
        return {
            "id": template_id,
            "status": "unknown",
            "usable": False,
            "fallback": FALLBACK_TEMPLATE,
            "action": (
                f"{template_id!r} is not supported. Use {FALLBACK_TEMPLATE}; "
                f"known templates: {', '.join(sorted(TEMPLATES))}."
            ),
        }
    row = next(item for item in list_templates() if item["id"] == template_id)
    row["usable"] = row["status"] == "installed"
    return row


def resolve_citation_style(style_id: str) -> dict:
    if style_id not in CITATION_STYLES:
        return {
            "citation_style": style_id,
            "available": False,
            "action": (
                f"{style_id!r} is unknown. Known citation styles: "
                f"{', '.join(sorted(CITATION_STYLES))}."
            ),
        }
    style = CITATION_STYLES[style_id]
    path, source = bst_location(style_id)
    row = {
        "citation_style": style_id,
        "bibliography_style": style["bst"],
        "natbib_options": style["natbib_options"],
        "requested": style["wanted"],
        "fidelity": style["fidelity"],
        "note": style["note"],
        "label": style["label"],
        "inline_example": style["inline_example"],
        "reference_example": style["reference_example"],
        "metadata_risk": style["metadata_risk"],
        "required_fields": style["required"],
        "recommended_fields": style["recommended"],
        "markdown_fidelity": "deterministic_simplified",
        "available": path is not None,
        "bst_path": path,
        "bst_source": source,
    }
    row["action"] = (
        f"copy {style['asset']} next to the .tex before bibtex runs"
        if path else
        f"{style['bst']}.bst is missing; reinstall the complete skill package"
    )
    return row


def check() -> tuple[list[str], list[str]]:
    """Return compile-blocking problems and non-blocking environment notes."""
    problems: list[str] = []
    notes: list[str] = []
    for row in list_templates():
        if row["status"] == "broken":
            problems.append(row["action"])
    for style_id in CITATION_STYLES:
        row = resolve_citation_style(style_id)
        if not row["available"]:
            problems.append(f"citation_style {style_id}: {row['action']}")
        elif row["fidelity"] != "exact":
            notes.append(
                f"{style_id}: approximate — resolves to "
                f"{row['bibliography_style']}, not {row['requested']}"
            )

    manifest_path = ASSETS / "citation-styles" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest.get("files", []):
            path = manifest_path.parent / item["path"]
            digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
            if digest != item.get("sha256"):
                problems.append(
                    f"citation asset checksum mismatch: {path.relative_to(HOME)} "
                    f"({digest}, expected {item.get('sha256')})"
                )
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        problems.append(f"citation style manifest unreadable: {exc}")

    if not shutil.which("pdflatex"):
        notes.append(
            "pdflatex is not on PATH; use Markdown output or install a TeX distribution"
        )
    return problems, notes


def _print_templates() -> None:
    print("TEMPLATES")
    for row in list_templates():
        mark = "[ok]" if row["status"] == "installed" else "[BROKEN]"
        options = f"[{row['package_options']}]" if row["package_options"] else ""
        print(f"  {mark:<8} {row['id']:<12} {row['title']}")
        print(
            f"           {row['documentclass']}  "
            f"\\usepackage{options}{{{row['package']}}}"
        )
        if row["status"] != "installed":
            print(f"           {row['action']}")
    print("\n  English runs emit NeurIPS; Chinese runs emit ctexart.")


def _print_styles() -> None:
    print("CITATION STYLES")
    for style_id in CITATION_STYLES:
        row = resolve_citation_style(style_id)
        mark = "[ok]" if row["available"] else "[MISSING]"
        fidelity = "exact" if row["fidelity"] == "exact" else "APPROXIMATE"
        print(
            f"  {mark} {style_id:<12} -> "
            f"\\bibliographystyle{{{row['bibliography_style']}}}  "
            f"natbib[{row['natbib_options']}]  {fidelity}"
        )
        print(f"        inline: {row['inline_example']}")
        print(f"        ref:    {row['reference_example']}")
        print(f"        metadata: {row['metadata_risk']}")
        print(
            "        markdown: deterministic simplified renderer; choose LaTeX/PDF "
            "for publisher-exact IEEE/ACM output"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command", nargs="?", default="list",
        choices=("list", "resolve", "cite", "check"),
    )
    parser.add_argument("name", nargs="?")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.command == "list":
        rows = list_templates()
        if args.json:
            print(json.dumps({"templates": rows, "fallback": FALLBACK_TEMPLATE},
                             indent=2, ensure_ascii=False))
        else:
            _print_templates()
        return 0

    if args.command == "resolve":
        if not args.name:
            print("resolve needs a template id", file=sys.stderr)
            return 2
        row = resolve_template(args.name)
        if args.json:
            print(json.dumps(row, indent=2, ensure_ascii=False))
        else:
            print(f"{row['status']}: {row.get('action') or row['id'] + ' is ready to use'}")
        return 2 if row["status"] == "unknown" else (0 if row["usable"] else 1)

    if args.command == "cite":
        if not args.name:
            rows = {style_id: resolve_citation_style(style_id) for style_id in CITATION_STYLES}
            if args.json:
                print(json.dumps(rows, indent=2, ensure_ascii=False))
            else:
                _print_styles()
            return 0
        row = resolve_citation_style(args.name)
        if "bibliography_style" not in row:
            print(json.dumps(row, indent=2, ensure_ascii=False) if args.json else row["action"],
                  file=None if args.json else sys.stderr)
            return 2
        if args.json:
            print(json.dumps(row, indent=2, ensure_ascii=False))
        else:
            print(f"bibliography_style = {row['bibliography_style']}")
            print(f"natbib_options     = {row['natbib_options']}")
            print(f"fidelity           = {row['fidelity']}")
            print(f"note               = {row['note']}")
        return 0 if row["available"] else 1

    problems, notes = check()
    if args.json:
        print(json.dumps({"ok": not problems, "problems": problems, "notes": notes},
                         indent=2, ensure_ascii=False))
    else:
        for note in notes:
            print(f"  · {note}")
        if problems:
            print(f"[FAIL] {len(problems)} problem(s):", file=sys.stderr)
            for problem in problems:
                print(f"   {problem}", file=sys.stderr)
        else:
            print("[OK] template and citation-style assets are intact.")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
