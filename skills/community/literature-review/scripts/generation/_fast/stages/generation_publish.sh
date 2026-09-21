#!/usr/bin/env bash
# --- slr home resolution ---
if [ -z "${SLR_HOME:-}" ]; then
  _slr_d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$_slr_d" != "/" ] && [ ! -f "$_slr_d/.slr-home" ]; do
    _slr_d="$(dirname "$_slr_d")"
  done
  if [ ! -f "$_slr_d/.slr-home" ]; then
    echo "[slr] skill root not found above ${BASH_SOURCE[0]}" >&2
    exit 1
  fi
  SLR_HOME="$_slr_d"
fi
export SLR_HOME
export SLR_PROFILE="${SLR_PROFILE:-fast}"
# --- end slr home resolution ---
# Publication consumes accepted manuscript and sealed assets, then runs rule
# checks, deterministic normalization, cached compilation and finalization.
# The default manuscript path never invokes an image or text model here.
# Legacy workspaces retain their explicit asset preparation compatibility path.
# Every current process failure blocks finalization; old status files cannot
# authorize publication. The CLI captures full logs and returns compact status.

set -uo pipefail

export PYTHONUNBUFFERED=1
SESSION_LOG="$PWD/session.log"
# Unified session.log line: 'YYYY-MM-DD HH:MM:SS [module]: message' (local time, no tz).
log() { printf '%s [%s]: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2"; }

STAGE=generation_publish
TD=$SLR_HOME/scripts/generation/tables/_fast
FD=$SLR_HOME/scripts/generation/figures/_fast
MD=$SLR_HOME/scripts/generation/merge/_fast
PUB=$SLR_HOME/scripts/generation/publish/_fast
GEN_DIR="./05_generation"
STATUS_DIR="$GEN_DIR/_status"
INSERT_S="$STATUS_DIR/phase05b_insert_assets.json"
QUAL_S="$STATUS_DIR/phase06_quality_check.json"
COMPILE_S="$STATUS_DIR/phase07_compile_latex.json"
FINAL_REPORT="$GEN_DIR/generation_report.json"

printf '\n%s [%s]: ===== %s stage start =====\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$STAGE" "$STAGE" >> "$SESSION_LOG"
exec > >(tee -a "$SESSION_LOG") 2>&1

# json_* / emit_status — see the file header for why this is not jq.
. "$SLR_HOME/scripts/generation/_fast/_json.sh"

mkdir -p "$GEN_DIR"
printf '%s [STAGE START] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$STAGE" >> "$GEN_DIR/run_log.txt"

# ---- 1. Validate the subagent-authored tables (advisory) ----
# Exits 3 when every table failed; a dropped table costs a \input line, not the
# document, so it degrades rather than blocks.
log $STAGE "===== validate_tables ====="
scholarseed-skill-python "$TD/validate_tables.py"
EC_TABLES=$?

# ---- 2. Figure bookkeeping (advisory) ----
# generate_images.py realises all three figure kinds: forest taxonomies (LaTeX,
# no model), data charts (matplotlib over a computed CSV) and images (the
# single `figures_image` model, concurrent, PNG, top/bottom trimmed).
# With no `figures_image` stage configured it falls back to marking image-mode
# figures not-generated, so write_latex.py drops them and phase05b scrubs the
# dangling \ref{fig:...} — the old behaviour, still supported.
# Whole-manuscript assets were sealed before publication. Publishing consumes
# their bytes and never calls an image model or rewrites a sealed figure.
if [ -f "$GEN_DIR/_internal/manuscript_contract.json" ]; then
  EC_IMAGES=0
  EC_LATEX=0
else
  scholarseed-skill-python "$FD/generate_images.py" --concurrency 4 --resume-only
  EC_IMAGES=$?
  scholarseed-skill-python "$FD/write_latex.py"
  EC_LATEX=$?
fi
if [ "$EC_TABLES" -ne 0 ] || [ "$EC_IMAGES" -ne 0 ] || [ "$EC_LATEX" -ne 0 ]; then
  emit_status "$STAGE" FAILED "asset validation failed in this invocation"
  exit 1
fi

# ---- 3. Summarise each asset step's status JSON ----
for f in validate_tables generate_images write_latex; do
  fp="$STATUS_DIR/$f.json"
  if [ -f "$fp" ]; then
    # json_pick emits a top-level "status" key, i.e. something the driver's
    # backwards scan would accept as a handshake. Safe here only because the
    # real handshake (phase08's, or emit_status on a failure path) comes later.
    log $STAGE "$f $(json_pick "$fp" status notes)"
  fi
done

# ---- 4. Inject figures/tables → full_draft_v3.tex (hard gate) ----
# --no-llm-scrub keeps this stage free of API calls: the dropped-figure \ref
# scrub falls back to its deterministic tiers (regex pre-scrub, then whole
# sentence delete) instead of asking a model to rewrite the paragraph. In the
# agentic path the LLM stage config it used (`refinement_full`) is gone anyway;
# the flag makes that independent of what the config file happens to contain.
log $STAGE "===== phase05b_insert_assets ====="
if ! scholarseed-skill-python "$MD/phase05b_insert_assets.py" --no-llm-scrub; then
  emit_status "$STAGE" FAILED "asset insertion failed in this invocation; prior status cannot authorize publication"
  exit 1
fi
if [ ! -f "$INSERT_S" ]; then
  log $STAGE "status=FAILED reason=insert_assets_status_missing" >&2
  emit_status "$STAGE" FAILED "phase05b_insert_assets wrote no status file at $INSERT_S"
  exit 1
fi

INSERT_STATUS=$(json_get "$INSERT_S" status)
if [ "$INSERT_STATUS" = "FAILED" ]; then
  log $STAGE "status=FAILED reason=insert_assets_failed" >&2
  json_dump "$INSERT_S" >&2
  emit_status "$STAGE" FAILED "insert_assets FAILED (neither full_draft_v2.tex nor full_draft_v1.tex exists)"
  exit 1
fi

# ---- 5. Quality check (hard gate) ----
log $STAGE "===== phase06_quality_check ====="
if ! scholarseed-skill-python "$PUB/phase06_quality_check.py"; then
  emit_status "$STAGE" FAILED "quality rules failed in this invocation"
  exit 1
fi
if [ ! -f "$QUAL_S" ]; then
  log $STAGE "status=FAILED reason=quality_status_missing" >&2
  emit_status "$STAGE" FAILED "phase06_quality_check wrote no status file at $QUAL_S"
  exit 1
fi

QUAL_STATUS=$(json_get "$QUAL_S" status)
if [ "$QUAL_STATUS" = "FAILED" ]; then
  log $STAGE "status=FAILED reason=quality_failed" >&2
  json_dump "$QUAL_S" >&2
  emit_status "$STAGE" FAILED "quality check FAILED (the merged draft is missing or unreadable)"
  exit 1
fi

# ---- 6. Sanitize LaTeX (monotone — never escalates) ----
log $STAGE "===== phase06b_sanitize_latex ====="
if ! scholarseed-skill-python "$PUB/phase06b_sanitize_latex.py"; then
  emit_status "$STAGE" FAILED "LaTeX normalization failed in this invocation"
  exit 1
fi

# ---- 7. Compile (clean→publish PDF; fixable failure→defer MD fallback for the
#         agent's compile fix loop; engine-missing→emit MD now; never blocks) ----
log $STAGE "===== phase07_compile_latex ====="
if ! scholarseed-skill-python "$PUB/phase07_compile_latex.py"; then
  emit_status "$STAGE" FAILED "LATEX_COMPILE_ERROR: current compile failed; previous success is invalid"
  exit 1
fi

# Log the compile verdict so session.log records whether the agent's compile fix
# loop still has work to do (verdict partial_pdf/no_pdf with the engine present)
# or the result is already definitive (clean compile / missing engine).
if [ -f "$COMPILE_S" ]; then
  log $STAGE "compile verdict=$(json_get "$COMPILE_S" diagnosis.verdict) engine=$(json_get "$COMPILE_S" engine)"
else
  log $STAGE "notice: $COMPILE_S missing — compile produced no status JSON"
fi

# ---- 8. Finalize aggregator ----
# phase08_finalize.py prints the terminal handshake this stage is judged on, so
# nothing JSON-shaped may be printed after it — the driver takes the LAST object
# carrying a "status" key. The failure branch below is the one exception, and it
# is only reached when phase08 produced no verdict of its own.
#
# NOTE: generation_report.json written here is not the last word either — the
# agent runs its compile fix loop + `slr finalize` afterwards.
log $STAGE "===== phase08_finalize ====="
scholarseed-skill-python "$PUB/phase08_finalize.py"
rc=$?
if [ $rc -ne 0 ] || [ ! -f "$FINAL_REPORT" ]; then
  log $STAGE "status=FAILED reason=finalize_failed rc=$rc" >&2
  emit_status "$STAGE" FAILED "phase08_finalize failed (rc=$rc); no generation_report.json to report from"
  exit 1
fi

# Plain-text only from here: json_get prints a bare scalar, not an object.
log $STAGE "final_status=$(json_get "$FINAL_REPORT" final_status)"
exit 0
