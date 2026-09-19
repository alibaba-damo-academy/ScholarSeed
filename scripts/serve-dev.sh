#!/usr/bin/env bash
set -eu

# Keep the server at the PID owned by watchfiles. On reload/exit it sends
# SIGINT, waits for graceful shutdown, then kills that same PID if necessary.
# A background child here would survive when watchfiles kills this wrapper,
# leaving the port bound and preventing the replacement server from starting.
exec "$@"
