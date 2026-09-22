#!/usr/bin/env bash
# _json.sh — the JSON seam of the generation shell scripts: reading the status
# files the Python phases write, and writing the terminal handshake object the
# `slr` driver parses.
#
# Sourced, never executed:
#     . "$SLR_HOME/scripts/generation/_fast/_json.sh"
# It assumes SLR_HOME is already exported, which every caller does in its own
# slr-home resolution header before sourcing this file.
#
# WHY IT EXISTS: these scripts used to shell out to `jq`, which is not installed
# in this deployment. A real run logged
#     jq: command not found
#     [: : integer expression expected
# — the empty capture made every `[ "$miss" -eq 0 ]` convergence test a syntax
# error rather than a comparison, so the drafting retry loop ran all three waves
# unconditionally instead of stopping at the first clean one. Reading JSON with
# scholarseed-skill-python removes the install-time variable: scholarseed-skill-python is a hard dependency of
# every phase these helpers are used from, jq was never a declared one.
#
# Every reader below is total. A missing file, unparseable JSON, or an absent
# key yields the documented fallback (0 / "" / [] / {}) on stdout and still
# exits 0, so callers can keep the plain `x=$(...)` + `[ "$x" -eq 0 ]` shape
# that jq's failure mode broke.

json_len() {
  # $1 = file, $2 = top-level key holding an array. Prints its length, or 0.
  # Replaces: jq -r '((.KEY // []) | length)'
  scholarseed-skill-python -c '
import json, sys
try:
    value = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2])
except Exception:
    value = None
print(len(value) if isinstance(value, (list, dict, str)) else 0)
' "$1" "$2"
}

json_get() {
  # $1 = file, $2 = dot-separated key path. Prints the scalar there as a bare
  # string, or "" when anything along the path is missing. Non-scalars come out
  # as compact JSON.
  # Replaces: jq -r '.KEY' / jq -r '.A.B // ""'
  scholarseed-skill-python -c '
import json, sys
try:
    current = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    current = None
for part in sys.argv[2].split("."):
    current = current.get(part) if isinstance(current, dict) else None
if current is None:
    print("")
elif isinstance(current, str):
    print(current)
else:
    print(json.dumps(current, ensure_ascii=False))
' "$1" "$2"
}

json_ids() {
  # $1 = file, $2 = top-level key holding an array, $3 = optional field to pull
  # out of each element when the elements are objects (e.g. validate_drafts'
  # invalid[] entries, which are {section_id, error} pairs). Prints a compact
  # JSON array — the form a failing stage puts in its handshake so the main
  # agent can re-delegate exactly the items that failed.
  scholarseed-skill-python -c '
import json, sys
field = sys.argv[3] if len(sys.argv) > 3 else ""
try:
    items = json.load(open(sys.argv[1], encoding="utf-8")).get(sys.argv[2]) or []
except Exception:
    items = []
out = []
for item in items if isinstance(items, list) else []:
    if isinstance(item, dict):
        value = item.get(field) if field else None
    else:
        value = item
    if value is not None:
        out.append(value)
print(json.dumps(out, ensure_ascii=False))
' "$@"
}

json_pick() {
  # $1 = file, $2.. = top-level keys. Prints a compact one-line object of just
  # those keys, absent ones as null — a log line, not a verdict.
  # Replaces: jq -c '{a, b: (.b // null)}'
  #
  # CAUTION: if one of the picked keys is "status", the line is itself a valid
  # handshake as far as the driver's backwards scan is concerned. Only ever log
  # such a line BEFORE the stage's own emit_status call.
  scholarseed-skill-python -c '
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}
print(json.dumps({key: data.get(key) for key in sys.argv[2:]}, ensure_ascii=False))
' "$@"
}

json_dump() {
  # $1 = file. Pretty-prints it for a stderr dump on a failure path.
  # Replaces: jq . FILE
  scholarseed-skill-python -c '
import json, sys
try:
    print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8")),
                     indent=2, ensure_ascii=False))
except Exception as exc:
    print("<unreadable %s: %s>" % (sys.argv[1], exc))
' "$1"
}

emit_status() {
  # $1 = stage id, $2 = SUCCESS|PARTIAL_SUCCESS|FAILED, $3 = status_reason,
  # $4.. = extra "key=value" pairs. A value that parses as JSON is emitted as
  # JSON (counts stay numbers, id lists stay arrays); anything else becomes a
  # string.
  #
  # This object IS the stage's verdict. `slr`'s trailing_json resolver scans a
  # stage's stdout BACKWARDS for the last object carrying a "status" key, and
  # every write_status() line the Python phases print carries one too — so this
  # has to be the last JSON the stage prints. Keep every exit path routed
  # through here and print nothing JSON-shaped afterwards.
  #
  # Kept flat on purpose: the driver's extractor matches at most one level of
  # brace nesting.
  scholarseed-skill-python -c '
import json, sys
out = {"stage": sys.argv[1], "status": sys.argv[2], "status_reason": sys.argv[3]}
for pair in sys.argv[4:]:
    key, _, raw = pair.partition("=")
    try:
        out[key] = json.loads(raw)
    except ValueError:
        out[key] = raw
print(json.dumps(out, ensure_ascii=False))
' "$@"
}
