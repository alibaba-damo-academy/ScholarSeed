# PDF-reader module

## Responsibility

One reading agent uses the existing PDF tools to answer the user's question
from the downloaded manifest entries. Follow [the reader prompt](PDF_READER_AGENT.md)
for inputs, tool use and output format, and the shared
[reading outcomes](../../references/reading-outcome.md) contract for scope and
completion. There is no local extraction, page-planning or deterministic fallback.

## Invocation

Start exactly one sub agent with `SKILL_DIR`, the run directory, manifest and
output paths from the reader prompt. The host waits for `read_report.md`,
`paper_summary.md` and `reading-outcome.json`, then records their run-state paths.
Keep both Markdown artifacts non-empty and preserve the outcome with its manifest
during refinement. `module_runner.py` cannot execute this host-owned module.
