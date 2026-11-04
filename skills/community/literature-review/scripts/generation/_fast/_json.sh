#!/usr/bin/env bash
# Preserve generation argv/output while using reviewed product Python scripts.

json_len() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" len "$@"
}

json_get() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" get "$@"
}

json_ids() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" ids "$@"
}

json_pick() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" pick "$@"
}

json_dump() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" dump "$@"
}

emit_status() {
  scholarseed-skill-python "$SLR_HOME/scripts/generation/_fast/status.py" status "$@"
}
