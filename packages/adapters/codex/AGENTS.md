# Codex Adapter

Read [README.md](README.md) and the repository root [AGENTS.md](../../../AGENTS.md) first.

- This package depends only on Runtime's public contracts and introduces no Serve or Desktop dependencies.
- Keep the official Codex executable; updated functionality must not depend on a customized app-server interface.
- Preparation of persistent run directories, authentication access, and actual process startup must follow the resource lease injected by the host. Version probing in an isolated temporary directory does not demonstrate persistent-data compatibility or successful session recovery.
- Contract tests use the root `tests/contract_codex_adapter.py`; actual Desktop acceptance is performed separately.
