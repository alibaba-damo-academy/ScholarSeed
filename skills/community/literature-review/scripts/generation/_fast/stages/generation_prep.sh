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
# Prepare section contracts and asset plans without model calls.
# The host then chooses scripted drafting or direct writing, merges the result,
# reviews v1, and publishes reviewed v2. Figure requests can overlap drafting.

set -uo pipefail

export PYTHONUNBUFFERED=1
SESSION_LOG="$PWD/session.log"
# Unified session.log line: 'YYYY-MM-DD HH:MM:SS [module]: message' (local time, no tz).
log() { printf '%s [%s]: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" "$2"; }

STAGE=generation_prep
TD=$SLR_HOME/scripts/generation/tables/_fast
FD=$SLR_HOME/scripts/generation/figures/_fast
GEN_DIR="./05_generation"
WORKLIST="$GEN_DIR/_internal/drafting_worklist.json"
TABLES_WL="$GEN_DIR/_internal/tables_worklist.json"
FIGURES_WL="$GEN_DIR/_internal/figures_worklist.json"

printf '\n%s [%s]: ===== %s stage start =====\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$STAGE" "$STAGE" >> "$SESSION_LOG"
exec > >(tee -a "$SESSION_LOG") 2>&1

# json_len / emit_status — see the file header for why this is not jq.
. "$SLR_HOME/scripts/generation/_fast/_json.sh"

# Record stage start in run_log.txt, matching the [PIPELINE START] line the
# all-script fallback writes, so a workspace that ran both paths reads in order.
mkdir -p "$GEN_DIR"
printf '%s [STAGE START] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$STAGE" >> "$GEN_DIR/run_log.txt"

# ---- 1. Bootstrap ----
# Validates the four required inputs and builds
# _internal/{cite_keys,leaf_index,query_meta}.json. Everything downstream —
# including the subagents in both gaps — reads those.
log $STAGE "===== phase00_bootstrap ====="
scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/phase00_bootstrap.py"
rc=$?
if [ $rc -ne 0 ]; then
  log $STAGE "status=FAILED reason=bootstrap_failed rc=$rc" >&2
  emit_status "$STAGE" FAILED "bootstrap failed (missing or invalid inputs), rc=$rc"
  exit 1
fi

# ---- 2. Drafting worklist ----
# One item per leaf section, each carrying the papers, claims and figure/table
# placeholders that section may use. This is the fan-out list for gap 1.
log $STAGE "===== collect_drafting_worklist ====="
scholarseed-skill-python "$SLR_HOME/scripts/generation/drafting/_fast/collect_drafting_worklist.py"
rc=$?
if [ $rc -ne 0 ]; then
  log $STAGE "status=FAILED reason=collect_drafting_worklist_failed rc=$rc" >&2
  emit_status "$STAGE" FAILED "collect_drafting_worklist failed, rc=$rc"
  exit 1
fi

# Number of sections to draft — logged so run_log shows the drafting scope, and
# carried in the handshake so the agent knows how wide gap 1 is before opening
# the worklist.
N_SECTIONS=$(json_len "$WORKLIST" items)
log $STAGE "sections to draft: $N_SECTIONS"

# An empty worklist is fatal rather than a no-op: there is nothing to delegate,
# and every later stage (merge, publish) would fail on an empty draft set
# anyway. Failing here points at the real cause, which is upstream in
# 04_outline/outline.json.
if [ "$N_SECTIONS" -eq 0 ]; then
  log $STAGE "status=FAILED reason=drafting_worklist_empty" >&2
  emit_status "$STAGE" FAILED \
    "drafting worklist is empty — 04_outline/outline.json has no leaf section to draft"
  exit 1
fi

# ---- 3. Table specs ----
# Moved here from generation_merge. It reads outline.json, cite_keys.json,
# paper_cards.json and selected_paper.json and nothing else — it never had a
# dependency on the drafts, so running it after them was only ever an accident
# of where the stage boundary fell.
#
# It has to exist before gap 1 now, because the section writer builds its own
# section's tables and self-checks them with `validate_tables.py`, which walks
# this worklist. The writer's row material comes from its drafting item's
# `planned_tables[].papers`; this file is what the CHECKER reads.
log $STAGE "===== collect_table_specs ====="
scholarseed-skill-python "$TD/collect_table_specs.py"
EC_TABLES=$?

# ---- 4. Figure worklist ----
# Also moved here, so the figure child can plan and generate alongside section
# writers instead of waiting behind all of them. Both figure and prose use the
# same outline plan as their consistency contract; no draft refresh is needed.
log $STAGE "===== collect_figures ====="
scholarseed-skill-python "$FD/collect_figures.py"
EC_FIGURES=$?

N_TABLES=$(json_len "$TABLES_WL" items)
N_FIGURES=$(json_len "$FIGURES_WL" items)
TABLE_IDS=$(json_ids "$TABLES_WL" items table_id)
log $STAGE "gap-1 fan-out: sections=$N_SECTIONS tables=$N_TABLES figures=$N_FIGURES (collect ec tables=$EC_TABLES figures=$EC_FIGURES)"

# Asset collection is advisory, as it was in generation_merge: a survey with
# fewer tables or figures than planned is still publishable, and the section
# writers are the thing this stage exists to unblock.
STATUS=SUCCESS
REASON="$N_SECTIONS sections ready for drafting; $N_TABLES table spec(s) owned by their sections, $N_FIGURES figure(s) queued"
if [ "$EC_TABLES" -ne 0 ] || [ "$EC_FIGURES" -ne 0 ]; then
  STATUS=PARTIAL_SUCCESS
  REASON="$REASON; collect_ec tables=$EC_TABLES figures=$EC_FIGURES"
fi

emit_status "$STAGE" "$STATUS" "$REASON" \
  "sections=$N_SECTIONS" \
  "tables=$N_TABLES" \
  "figures=$N_FIGURES" \
  "table_ids=$TABLE_IDS" \
  "worklist=05_generation/_internal/drafting_worklist.json" \
  "next=roll isolated slr-section-writers and one figure plan-generator; the figure child runs slr figures plan-generate before returning; then run generation_merge"
exit 0
