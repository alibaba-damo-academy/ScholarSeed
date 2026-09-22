#!/usr/bin/env scholarseed-skill-python
"""Compile both real publication preambles against the active TeX toolchain.

`smoke_citation_styles.py` proves the vendored `.bst` files work; this proves the
toolchain can compile what the pipeline actually emits: `PREAMBLE_EN` through
pdflatex and `PREAMBLE_ZH` through xelatex, each with a real bibtex round trip,
a forest tree, a tabularx table and a citation. The preambles are read from the
phase that owns them, so a package added to a preamble becomes a requirement
here automatically instead of failing on a user machine.

Resolved engine paths are reported so a caller that staged its own toolchain can
assert the compile really used it rather than a host TeX installation.

Nothing is imported from the skill: the preambles are read with `ast`, so this
stays runnable in a bare toolchain check where the skill's own module graph is
not the subject under test.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREAMBLE_SOURCE = ROOT / "scripts" / "generation" / "merge" / "_fast" / "phase05_merge_full_draft.py"
NEURIPS_STYLE = ROOT / "assets" / "templates" / "neurips" / "neurips_2026.sty"
NUMERIC_STYLE = ROOT / "assets" / "unsrtnat_scholarseed.bst"
BIBLIOGRAPHY_STYLE_NAME = "unsrtnat_scholarseed"
CITATION_KEY = "Smith2024Agentic"
COMPILE_TIMEOUT_SECONDS = 300
# TeX engines can emit bytes that are not valid UTF-8 (localized font and file
# diagnostics). Replace them instead of aborting the whole toolchain probe.
OUTPUT_ENCODING = "utf-8"
OUTPUT_ERRORS = "replace"
# TeX wraps its log at 79 columns and splits file names across lines, so every
# log search has to fold the wrap first or it silently misses evidence.
DOCUMENTS = {
    "english": {
        "preamble": "PREAMBLE_EN",
        "engine": "pdflatex",
        "body": "\n".join([
            r"\title{Publication smoke}\author{Publication smoke}",
            r"\begin{document}\maketitle",
            r"\section{Section}Citation~\citep{" + CITATION_KEY + r"} and math $\alpha+\beta$.",
            "",
            r"\begin{tabularx}{\linewidth}{XX}",
            r"\toprule Column & Column \\ \midrule one & two \\ \bottomrule",
            r"\end{tabularx}",
            "",
            r"\begin{forest} for tree={draw} [Root [Left] [Right]] \end{forest}",
            r"\bibliography{refs}",
            r"\end{document}",
        ]),
        "required_evidence": ("neurips_2026.sty",),
    },
    "chinese": {
        "preamble": "PREAMBLE_ZH",
        "engine": "xelatex",
        "body": "\n".join([
            r"\title{出版冒烟}\author{出版冒烟}",
            r"\begin{document}\maketitle",
            r"\section{章节}中文正文，引用~\citep{" + CITATION_KEY + r"}与公式 $\alpha+\beta$。",
            "",
            r"\begin{tabularx}{\linewidth}{XX}",
            r"\toprule 甲 & 乙 \\ \midrule 一 & 二 \\ \bottomrule",
            r"\end{tabularx}",
            "",
            r"\begin{forest} for tree={draw} [根 [子一] [子二]] \end{forest}",
            r"\bibliography{refs}",
            r"\end{document}",
        ]),
        "required_evidence": ("ctex-fontset-fandol.def", "FandolSong-Regular"),
    },
}
BIBLIOGRAPHY = (
    "@Article{%(key)s,\n"
    "  author = {Alice Smith and Bo Li},\n"
    "  title = {Agentic Literature Review},\n"
    "  journal = {Journal of Research},\n"
    "  year = {2024},\n"
    "}\n" % {"key": CITATION_KEY}
)


def preambles() -> dict[str, str]:
    """Read the real preambles from their owning phase without importing it."""
    tree = ast.parse(PREAMBLE_SOURCE.read_text(encoding="utf-8"))
    wanted = {spec["preamble"] for spec in DOCUMENTS.values()}
    found = {}
    for node in tree.body:
        if (
            isinstance(node, ast.Assign)
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id in wanted
        ):
            found[node.targets[0].id] = ast.literal_eval(node.value)
    missing = sorted(wanted - set(found))
    if missing:
        raise RuntimeError(f"publication preambles not found: {missing}")
    return found


def _folded(path: Path) -> str:
    return re.sub(r"\s+", "", path.read_text(encoding="utf-8", errors="replace"))


def _passes(engine: str) -> list[list[str]]:
    compile_once = [engine, "-interaction=nonstopmode", "smoke.tex"]
    return [compile_once, ["bibtex", "smoke"], compile_once, compile_once]


def compile_document(name: str, sources: dict[str, str], keep: bool) -> dict:
    spec = DOCUMENTS[name]
    for asset in (NEURIPS_STYLE, NUMERIC_STYLE):
        if not asset.is_file():
            return {"document": name, "ok": False, "missing_asset": str(asset)}
    tmp = Path(tempfile.mkdtemp(prefix=f"slr-publish-{name}-"))
    try:
        (tmp / "refs.bib").write_text(BIBLIOGRAPHY, encoding="utf-8")
        shutil.copyfile(NEURIPS_STYLE, tmp / NEURIPS_STYLE.name)
        shutil.copyfile(NUMERIC_STYLE, tmp / f"{BIBLIOGRAPHY_STYLE_NAME}.bst")
        (tmp / "smoke.tex").write_text(
            sources[spec["preamble"]] + spec["body"] + "\n", encoding="utf-8"
        )
        final_log = ""
        final_output = ""
        for command in _passes(spec["engine"]):
            proc = subprocess.run(
                command, cwd=tmp, capture_output=True, text=True,
                encoding=OUTPUT_ENCODING, errors=OUTPUT_ERRORS,
                timeout=COMPILE_TIMEOUT_SECONDS,
            )
            if proc.returncode:
                return {
                    "document": name,
                    "ok": False,
                    "command": command,
                    "returncode": proc.returncode,
                    "tail": (proc.stdout + proc.stderr)[-3000:],
                    "workdir": str(tmp),
                }
            if command[0] == spec["engine"]:
                final_output = proc.stdout + proc.stderr
                final_log = _folded(tmp / "smoke.log")
        problems = []
        if not (tmp / "smoke.pdf").is_file():
            problems.append("no PDF produced")
        if re.search(r"^!", final_output, re.MULTILINE):
            problems.append("LaTeX error in the final pass")
        if "undefined" in final_log:
            problems.append("undefined citations or references in the final pass")
        absent = [token for token in spec["required_evidence"] if token not in final_log]
        if absent:
            problems.append(f"expected toolchain evidence missing: {absent}")
        return {
            "document": name,
            "ok": not problems,
            "problems": problems,
            "engine": spec["engine"],
            "pdf_bytes": (tmp / "smoke.pdf").stat().st_size if (tmp / "smoke.pdf").is_file() else 0,
            "workdir": str(tmp) if keep else None,
        }
    finally:
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--document", choices=tuple(DOCUMENTS))
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    engines = ("xelatex", "pdflatex", "bibtex", "kpsewhich")
    resolved = {tool: shutil.which(tool) for tool in engines}
    missing = sorted(name for name, found in resolved.items() if not found)
    if missing:
        print(json.dumps({"ok": False, "missing_tools": missing}, ensure_ascii=False))
        return 2
    sources = preambles()
    names = [args.document] if args.document else list(DOCUMENTS)
    rows = [compile_document(name, sources, args.keep) for name in names]
    ok = all(row["ok"] for row in rows)
    print(json.dumps({"ok": ok, "engines": resolved, "documents": rows},
                     ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
