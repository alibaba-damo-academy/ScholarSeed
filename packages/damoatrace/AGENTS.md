# DamoATrace repository guide

`AGENTS.md` is the maintained repository guide. Edit this physical source directly.

## Repository scope

DamoATrace is the independent inspection surface for Agent trace data. This package owns
one distribution and one top-level Python package: `damoatrace`.

## Architecture

- `damoatrace/cli/` implements composable trace queries and output formats.
- `damoatrace/data/` owns trace storage access, usage aggregation, and explicit action-database
  reads.
- `damoatrace/evidence/` projects raw events into turn digests, context lifecycle evidence, and
  model-visible working sets.
- `damoatrace/search/` owns trace full-text search.
- `damoatrace/server/` exposes the local read-only HTTP API and Web UI.
- `damoatrace/tests/` contains package boundary, distribution, and real CLI query contracts.

DamoATrace must not import Runtime, adapters, removed DamoAgent modules, or a
product's service, UI, or launcher. Product data stores are provided through explicit paths
or ports. Inspection code must not mutate agent sessions, tool runtime state, or product records.

## Dependencies and entry points

- Python 3.12+
- Declared runtime dependencies: DuckDB and filelock; version constraints belong to `pyproject.toml`.
- CLI: `damoatrace` or `python -m damoatrace`
- Offline evidence: `--trace-file <file>` or `--trace-dir <directory>` before a
  read-only query command. Offline queries must not read the local product home.
- Main query groups: `list`, `session`, `events`, `errors`, `llms`, `tools`, `span`, `export`,
  `stats`, `digest`, `context`, and `serve`
- Optional product action database: `--actions-db` or `DAMOATRACE_ACTIONS_DB`

## Engineering rules

- Put imports at file head. Do not use lazy, conditional, or dynamic imports to hide dependency
  edges.
- Keep query and evidence output deterministic and machine-readable.
- Put contracts and constants in their owning module; avoid duplicated wire values.
- Do not add forwarding namespaces, compatibility shells, product imports, or product path
  defaults.
- Preserve user changes in dirty worktrees. Do not reset or overwrite unrelated work.
- Package-index publication requires explicit user authorization.

## Validation

Select the applicable checks from the monorepo root. Installation and formatting require the
task's write/environment authorization; this list does not authorize them for read-only work.

```bash
pnpm ops ci format --write
pnpm ops ci format
pnpm ops ci test --scope trace
pnpm ops cd build local --target trace
```

For query changes, run the installed CLI against real trace files. For distribution changes,
install the wheel in a clean environment outside the source checkout and repeat a real query.
The wheel command builds from this package and runs `twine check`; a source build alone does
not establish clean-install query behavior or authorize publication.
