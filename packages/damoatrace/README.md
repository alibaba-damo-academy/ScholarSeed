# DamoATrace

DamoATrace independently owns trace contracts, recording, querying, evidence projections, exports, and local visualization. The repository publishes the `damoatrace` distribution and a Python namespace with the same name.

<a id="代码架构"></a>
## Code Architecture

| Directory | Responsibility |
| --- | --- |
| `damoatrace/contract/` | Trace-owned data contracts, with no Runtime or Adapter dependencies |
| `damoatrace/recording/` | Record construction, writing, and sensitive-information redaction |
| `damoatrace/paths.py` | Independent path configuration; products integrate through explicit configuration |
| `damoatrace/cli/` | Composable session/event/LLM/tool/error/span query commands and output formats |
| `damoatrace/data/` | Trace store, usage aggregation, and explicit action database reads |
| `damoatrace/evidence/` | Turn digest, context lifecycle, and model-visible working-set projections |
| `damoatrace/search/` | Full-text trace search |
| `damoatrace/server/` | Local read-only HTTP server and single-page Web UI |
| `damoatrace/tests/` | Package boundary, distribution, and real CLI query contracts |

DamoATrace uses its own trace contract and local trace data; it does not write agent runtime sessions, tools, or business state. Pass a business action database explicitly through `--actions-db` or `DAMOATRACE_ACTIONS_DB`.

<a id="安装与使用"></a>
## Installation and Usage

Python 3.12+ is required. Declared runtime dependencies are DuckDB and filelock; see [`pyproject.toml`](pyproject.toml) for the specific version constraints. There are no dependencies on `damoagent`, `scholarseed-runtime`, Adapter, or Serve.

```bash
python -m pip install damoatrace

damoatrace list
damoatrace session --session <session-id>
damoatrace events --session <session-id>
damoatrace tools --session <session-id>
damoatrace errors --latest
damoatrace digest --latest
damoatrace context --latest --visible
damoatrace export --session <session-id>
damoatrace serve
```

All query commands can also be invoked with `python -m damoatrace ...`.

<a id="索引启动检查"></a>
## Startup Index Checks

`TraceIndex.inspect_readonly()` uses a caller-authorized read-only transaction to check format markers, FTS5 structure, and columns; it rejects triggers/views, unknown versions, and explicit corruption, then runs SQLite `quick_check(1)` within a time budget. If its own budget interrupts the check, it returns `incomplete_budget`, which means neither corruption nor a successful full check; other SQLite errors still propagate. This path does not copy the entire database or modify the index or raw history. Serve records its scope and result during ordinary startup.

`TraceIndex.inspect_startup()` remains an explicit full audit: it performs actual initialization, reset, and FTS consistency checks on a bounded private snapshot, and fails explicitly if it exceeds the budget. An ordinary SQLite check does not prove that the full FTS inverted index is consistent, so do not claim full FTS consistency. The full audit also reports insufficient budget explicitly and is not a product-upgrade admission condition.

Serve startup and upgrades defer checks of JSONL and legacy context ledger history and do not scan historical bodies; this does not mean the historical formats have been approved. Queries and full-text indexing validate formats when consuming content. Unsupported versions fail explicitly; they are not silently skipped and stale index results are not returned. Query permission, I/O, and encoding errors propagate explicitly rather than being reported as successful empty history; unmarked legacy events continue to follow the existing read contract. Content rewrites still undergo format preflight before actual writes. See the
[Serve README](../../apps/serve/README.md#trace-启动边界)。

When an FTS query's source directory/file is missing, the query reports that it is unavailable. The caller must rescan the source of truth; the query must not keep returning old index hits. Permission, other I/O, encoding, and unknown-format errors still fail explicitly. The query CLI prints diagnostics to stderr and exits with code `1` for these failures; it does not output a success envelope or traceback. The separate digest/context/server entry points are outside the error-presentation scope of this query CLI.

<a id="开发与验证"></a>
## Development and Validation

Run the following npm commands from the monorepo root. Installation/formatting changes the environment or source and must be within the authorization for the current task; this list does not itself authorize running them for read-only investigation or documentation work.

```bash
pnpm ops pre install python
pnpm ops ci format --write
pnpm ops ci format
pnpm ops ci test --scope trace
pnpm ops ci test --scope trace --with-format-check
pnpm ops cd build local --target trace
```

`damoatrace:wheel` first runs workspace installation through the root `scripts/shared/workspace.cjs`, then builds a wheel in this package directory and runs `twine check`; it does not upload the package. To build only, run `python -m build --wheel` in this package directory. That command does not run the distribution metadata checks above or prove that CLI queries work after a clean install. The root pyproject only orchestrates the workspace; a bare wheel command from the root cannot replace building this package.
