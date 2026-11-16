<a id="serve-工作约定"></a>
# Serve Working Conventions

This directory owns the `scholarseed` distribution and the `service` namespace. Read
[README.md](README.md) and the repository root [AGENTS.md](../../AGENTS.md) first.

- `bootstrap.py` is the product composition root; cross-domain protocols and process-level services belong in `service/platform/` and are injected by the composition root. Do not use mutable global singletons shared across application instances.
- Runtime, Adapter, and Trace retain independent distribution boundaries; product paths, authentication, persistence, and HTTP/SSE belong to Serve.
- Background task lifetimes must cover actual execution and cleanup; a request returning, client disconnecting, or coroutine being cancelled does not prove that a thread, external process, or vendor task has ended.
- Contract tests belong in `tests/`; register new suites in `tests/run_all.py`. Deterministic contracts do not replace real Desktop product acceptance.
- After changing product behavior, run the affected contracts and actual product path. Maintenance/drain capabilities without complete domain coverage must not be treated as permission for a safe restart.
