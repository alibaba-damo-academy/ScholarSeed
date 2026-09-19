"""validate_tables.py — final reporter over the agent's tables/{id}.tex files.

All shape rules live in `table_checks.collect_problems`; this script just walks
the worklist, applies that single check per table, and writes a status summary.

It passes the worklist item's cite keys through as `allowed_cite_keys`, which
turns on the second half of the row-anchoring check: every data row must cite at
least one paper, and every paper it cites must be one the table was assigned.
The worklist is the only place that mapping exists, so this is the only caller
that can supply it.
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
pass
pass
from table_checks import collect_problems  # noqa: E402
from _utils import (  # noqa: E402
    Workspace,
    load_json,
    log_script_start,
    require_workspace,
    write_status,
)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument(
        "workspace", nargs="?", default=None, metavar="WORKSPACE",
        help=("The run workspace. Optional only because the merge stage runs "
              "this script with cwd already set to it; a table builder "
              "self-checking from its own Bash tool inherits the launch "
              "directory instead and must pass it."),
    )
    args = p.parse_args()

    started = time.time()
    ws = Workspace(args.workspace)
    require_workspace(ws, "validate_tables.py")
    log_script_start(ws, "validate_tables")

    worklist = load_json(ws.tables_worklist_path())
    items = worklist["items"]

    written = 0
    missing: list[str] = []
    invalid: list[dict] = []

    for it in items:
        tid = it["table_id"]
        path = ws.tables_dir / f"{tid}.tex"
        if not path.exists():
            missing.append(tid)
            continue
        allowed = [
            (p or {}).get("cite_key", "")
            for p in (it.get("papers") or [])
            if isinstance(p, dict)
        ]
        problems = collect_problems(path.read_text(encoding="utf-8"), it["label"],
                                    allowed_cite_keys=allowed)
        if problems:
            invalid.append({"table_id": tid, "problems": problems})
        else:
            written += 1

    final_status = "SUCCESS" if not (missing or invalid) else (
        "PARTIAL_SUCCESS" if written else "FAILED"
    )
    write_status(
        ws, "validate_tables", final_status,
        duration_sec=round(time.time() - started, 2),
        written=written, missing=missing, invalid=invalid,
        total=len(items),
    )
    return 0 if final_status != "FAILED" else 3


if __name__ == "__main__":
    sys.exit(main())
