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
# Generation stage 2 of 3 (agentic path) — closes gap 1 and opens gap 2. Runs
# after the slr-section-writer subagents have written their section drafts and
# their sections' tables, and before the refiner runs. No LLM call is made here.
#
# Chains: validate_drafts → validate_tables → phase05_merge_full_draft --stage
# v1. Must run from the workspace cwd.
#
# The draft validator is a HARD GATE. This stage cannot retry anything: the
# retry is a subagent, which only the main agent can spawn. So an incomplete
# draft set stops the stage and the handshake names the offending section ids,
# which is exactly what the agent needs to re-delegate just those sections and
# run this stage again.
#
# `validate_tables` runs here too, and that is the point of running it here:
# the tables are now written by the section writers, so a bad table is a bad
# section, and this is the last moment at which naming it costs one
# re-delegation instead of a full recompile. It stays ADVISORY — a shape
# problem in one table must not withhold full_draft_v1.tex — but the handshake
# names the offending table ids so the agent can act on them now rather than
# discovering them in the PDF.
#
# Figures were planned and realised beside the section writers. They share the
# outline plan with the prose and have no draft-content dependency, so this
# stage deliberately does not rebuild or mutate their worklist.
#
# Exit codes:
#   0  SUCCESS / PARTIAL_SUCCESS — full_draft_v1.tex exists; the agent can open
#      gap 2 (slr-refiner, alone)
#   1  FAILED — drafts incomplete, or the v1 merge failed

set -uo pipefail

export PYTHONUNBUFFERED=1
SESSION_LOG="$PWD/session.log"
# Unified session.log line: 'YYYY-MM-DD HH:MM:SS [module]: message' (local time, no tz).
log() { printf '%s [%s]: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2"; }

STAGE=generation_merge
SD=$SLR_HOME/scripts/generation/drafting/_fast
MD=$SLR_HOME/scripts/generation/merge/_fast
TD=$SLR_HOME/scripts/generation/tables/_fast
GEN_DIR="./05_generation"
VS="$GEN_DIR/_status/validate_drafts.json"
MS="$GEN_DIR/_status/phase05_merge_full_draft.json"
TABLES_WL="$GEN_DIR/_internal/tables_worklist.json"
FIGURES_WL="$GEN_DIR/_internal/figures_worklist.json"
TS="$GEN_DIR/_status/validate_tables.json"

printf '\n%s [%s]: ===== %s stage start =====\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$STAGE" "$STAGE" >> "$SESSION_LOG"
exec > >(tee -a "$SESSION_LOG") 2>&1

# json_* / emit_status — see the file header for why this is not jq.
. "$SLR_HOME/scripts/generation/_fast/_json.sh"

mkdir -p "$GEN_DIR"
printf '%s [STAGE START] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$STAGE" >> "$GEN_DIR/run_log.txt"

# ---- 1. Hard gate: every worklist section must have a usable draft ----
# validate_drafts also normalises and repairs each draft in place (schema drift,
# `\ citet{}` malformations, bogus cite keys), so it has to run even when the
# subagents reported clean.
log $STAGE "===== validate_drafts ====="
scholarseed-skill-python "$SD/validate_drafts.py"

# The gate reads the status FILE, not the exit code: validate_drafts exits 3
# only when nothing at all was drafted, and exits 0 while individual sections
# are still missing (that is PARTIAL_SUCCESS to it).
if [ ! -f "$VS" ]; then
  log $STAGE "status=FAILED reason=validate_drafts_status_missing" >&2
  emit_status "$STAGE" FAILED "validate_drafts wrote no status file at $VS"
  exit 1
fi

MISS=$(json_len "$VS" missing)
INV=$(json_len "$VS" invalid)
DEGRADED=$(json_len "$VS" degraded)
log $STAGE "validator: missing=$MISS invalid=$INV degraded=$DEGRADED"

if [ "$MISS" -gt 0 ] || [ "$INV" -gt 0 ]; then
  # Name the sections so the agent can re-delegate exactly these and re-run the
  # stage, instead of redrafting the whole survey. invalid[] holds
  # {section_id, error} objects, hence the field argument.
  MISSING_IDS=$(json_ids "$VS" missing)
  INVALID_IDS=$(json_ids "$VS" invalid section_id)
  log $STAGE "status=FAILED reason=drafts_incomplete missing=$MISSING_IDS invalid=$INVALID_IDS" >&2
  json_dump "$VS" >&2
  emit_status "$STAGE" FAILED \
    "section drafts incomplete — missing: $MISSING_IDS, invalid: $INVALID_IDS; repair or regenerate only those ids, then re-run this stage" \
    "missing_sections=$MISSING_IDS" \
    "invalid_sections=$INVALID_IDS"
  exit 1
fi

# ---- 1b. Tables, written by the section writers in gap 1 (advisory) ----
# Not a gate. A table with a shape problem still compiles into something, and
# withholding the merged draft over one would cost far more than it saves. But
# the ids go into the handshake, because "re-delegate section 3's writer" is
# only cheap while we are still standing between the two gaps.
log $STAGE "===== validate_tables ====="
scholarseed-skill-python "$TD/validate_tables.py"
EC_VALIDATE_TABLES=$?
BAD_TABLES=""
if [ -f "$TS" ]; then
  N_MISSING_TABLES=$(json_len "$TS" missing)
  N_INVALID_TABLES=$(json_len "$TS" invalid)
  BAD_TABLES=$(json_ids "$TS" invalid table_id)
  log $STAGE "tables: missing=$N_MISSING_TABLES invalid=$N_INVALID_TABLES ids=$BAD_TABLES"
else
  N_MISSING_TABLES=0
  N_INVALID_TABLES=0
fi

# ---- 2. Merge sections → full_draft_v1.tex ----
log $STAGE "===== phase05_merge_full_draft (v1) ====="
scholarseed-skill-python "$MD/phase05_merge_full_draft.py" --stage v1
if [ ! -f "$MS" ]; then
  log $STAGE "status=FAILED reason=merge_status_missing" >&2
  emit_status "$STAGE" FAILED "phase05_merge_full_draft wrote no status file at $MS"
  exit 1
fi

MERGE_STATUS=$(json_get "$MS" status)
if [ "$MERGE_STATUS" = "FAILED" ]; then
  log $STAGE "status=FAILED reason=merge_v1_failed" >&2
  json_dump "$MS" >&2
  emit_status "$STAGE" FAILED "merge into full_draft_v1.tex FAILED"
  exit 1
fi
# json_pick's output carries a top-level "status" key, so it is a valid
# handshake to the driver's backwards scan — safe only because emit_status runs
# after it and wins.
log $STAGE "$(json_pick "$MS" status scope language full_draft_v1)"

N_TABLES=$(json_len "$TABLES_WL" items)
N_FIGURES=$(json_len "$FIGURES_WL" items)
TABLE_IDS=$(json_ids "$TABLES_WL" items table_id)
log $STAGE "merge complete; publish next (tables=$N_TABLES figures=$N_FIGURES, both settled in gap 1)"

# Degraded sections do not block: the refiner in gap 2 is the step meant to
# smooth them, and phase08 records them in the final report either way. They do
# downgrade the verdict, because a clean run has none.
STATUS=SUCCESS
REASON="full_draft_v1 merged; $N_TABLES table(s) and $N_FIGURES figure(s) in hand"
if [ "$MERGE_STATUS" = "PARTIAL_SUCCESS" ] || [ "$DEGRADED" -gt 0 ] \
   || [ "$N_MISSING_TABLES" -gt 0 ] || [ "$N_INVALID_TABLES" -gt 0 ]; then
  STATUS=PARTIAL_SUCCESS
  REASON="$REASON; merge=$MERGE_STATUS degraded_sections=$DEGRADED tables_missing=$N_MISSING_TABLES tables_invalid=$N_INVALID_TABLES"
fi

emit_status "$STAGE" "$STATUS" "$REASON" \
  "tables=$N_TABLES" \
  "figures=$N_FIGURES" \
  "table_ids=$TABLE_IDS" \
  "tables_missing=$N_MISSING_TABLES" \
  "tables_invalid=$N_INVALID_TABLES" \
  "bad_table_ids=$BAD_TABLES" \
  "degraded_sections=$DEGRADED" \
  "next=run generation_publish; no automatic refine stage. Repair concrete failed assets at their source."
exit 0
