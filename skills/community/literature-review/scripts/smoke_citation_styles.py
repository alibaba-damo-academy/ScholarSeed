#!/usr/bin/env scholarseed-skill-python
"""Compile one natbib document with every vendored citation style."""
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
import shutil
import subprocess
import tempfile
from pathlib import Path

from citation_styles import CITATION_STYLES, style_asset


BIB = r"""@Article{Smith2024Agentic,
  author = {Alice Smith and Bo Li},
  title = {Agentic Literature Review},
  journal = {Journal of Research},
  year = {2024},
  volume = {12},
  number = {3},
  pages = {45--60},
  publisher = {Example Publisher},
  doi = {10.5555/example}
}
"""


def compile_style(style_id: str, keep: bool = False) -> dict:
    spec = CITATION_STYLES[style_id]
    tmp = Path(tempfile.mkdtemp(prefix=f"slr-cite-{style_id}-"))
    try:
        (tmp / "refs.bib").write_text(BIB, encoding="utf-8")
        shutil.copyfile(style_asset(style_id), tmp / f"{spec['bst']}.bst")
        tex = "\n".join([
            r"\documentclass{article}",
            r"\usepackage{url}",
            r"\usepackage[hidelinks]{hyperref}",
            rf"\usepackage[{spec['natbib_options']}]{{natbib}}",
            r"\begin{document}",
            r"Textual \citet{Smith2024Agentic}; parenthetical \citep{Smith2024Agentic}.",
            rf"\bibliographystyle{{{spec['bst']}}}",
            r"\bibliography{refs}",
            r"\end{document}",
        ])
        (tmp / "smoke.tex").write_text(tex + "\n", encoding="utf-8")
        commands = [
            ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "smoke.tex"],
            ["bibtex", "smoke"],
            ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "smoke.tex"],
            ["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "smoke.tex"],
        ]
        for command in commands:
            proc = subprocess.run(command, cwd=tmp, capture_output=True, text=True, timeout=120)
            if proc.returncode:
                return {
                    "style": style_id,
                    "ok": False,
                    "command": command,
                    "returncode": proc.returncode,
                    "tail": (proc.stdout + proc.stderr)[-3000:],
                    "workdir": str(tmp),
                }
        bbl = (tmp / "smoke.bbl").read_text(encoding="utf-8", errors="replace")
        return {
            "style": style_id,
            "ok": (tmp / "smoke.pdf").is_file() and "Smith" in bbl,
            "pdf_bytes": (tmp / "smoke.pdf").stat().st_size,
            "bbl_bytes": len(bbl.encode("utf-8")),
            "workdir": str(tmp) if keep else None,
        }
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--style", choices=tuple(CITATION_STYLES))
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    missing = [tool for tool in ("pdflatex", "bibtex") if not shutil.which(tool)]
    if missing:
        print(json.dumps({"ok": False, "missing_tools": missing}, ensure_ascii=False))
        return 2
    ids = [args.style] if args.style else list(CITATION_STYLES)
    rows = [compile_style(sid, args.keep) for sid in ids]
    print(json.dumps({"ok": all(row["ok"] for row in rows), "styles": rows},
                     ensure_ascii=False, indent=2))
    return 0 if all(row["ok"] for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
