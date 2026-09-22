#!/usr/bin/env scholarseed-skill-python
"""verifier_prepare_inputs — derive `07_verifier/input/*.json` sub-inputs
from upstream survey artifacts.

Thin CLI wrapper around `_internal/prepare_inputs.auto_prepare`. Implementation
lives in the internal module so `runtime/cli.py:cmd_run` can call the exact
same builders in-process.

Usage:
    scholarseed-skill-python scripts/verify/fast_audit/verifier_prepare_inputs.py \\
        [--workspace <path>] [--force] [--include-experiment-data]

    # Or from inside a workspace:
    cd workspace_xxx
    scholarseed-skill-python scripts/verify/fast_audit/verifier_prepare_inputs.py

Default behaviour matches what `cli.py run` triggers internally: skip
`experiment_data.json` because it has no faithful source-of-truth in a
literature-review workspace. Pass `--include-experiment-data` to materialise
it anyway (legacy / non-survey use cases).
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
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_INTERNAL = _HERE / "_internal"  # [slr] cli.py now sits beside _internal/
if str(_INTERNAL) not in sys.path:
    sys.path.insert(0, str(_INTERNAL))

from prepare_inputs import auto_prepare, is_survey_workspace  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="verifier_prepare_inputs",
        description="Derive verifier sub-input files from upstream artifacts.",
    )
    parser.add_argument("--workspace", type=Path, default=None,
                        help="Workspace directory. Defaults to CWD.")
    parser.add_argument("--force", action="store_true",
                        help="Re-derive even when the file already exists.")
    parser.add_argument("--include-experiment-data", action="store_true",
                        help="Also derive experiment_data.json (skipped by "
                             "default in survey workspaces).")
    args = parser.parse_args(argv)

    workspace = args.workspace or Path.cwd()
    if not workspace.is_dir():
        print(f"ERROR: workspace {workspace} does not exist.", file=sys.stderr)
        return 1

    skip: tuple[str, ...] = ()
    if not args.include_experiment_data and is_survey_workspace(workspace):
        skip = ("experiment_data.json",)

    results = auto_prepare(workspace, skip_files=skip, force=args.force)

    ok = sum(1 for v in results.values() if v == "OK")
    skipped = sum(1 for v in results.values() if v.startswith("SKIPPED"))
    errored = len(results) - ok - skipped

    for fname, status in results.items():
        if status == "OK":
            sym = "✅"
        elif status.startswith("SKIPPED"):
            sym = "⚠️ "
        else:
            sym = "❌"
        print(f"  {sym} {fname} — {status}")
    print(f"\nSummary: ok={ok}  skipped={skipped}  error={errored}  "
          f"out_dir={workspace}/07_verifier/input/")

    json.dump(results, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0 if errored == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
