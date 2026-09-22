# PDF-reader module

## Responsibility

The host delegates one quick PDF-reading sub agent for each completed download
batch. The sub agent reads only verified, run-contained PDFs listed in
`downloads/manifest.json` and writes both `report.md` and `paper_summary.md`.
There is no local text-extraction, page-planning, or deterministic fallback.

Also require `reading-outcome.json` following
`references/reading-outcome.md`, record `paths.reading_outcome`, and preserve
it with the corresponding manifest during refinement. An all-unreadable batch
uses the same review flow with honest limitations instead of paper findings.

## Invocation

Read `PDF_READER_AGENT.md` and start exactly one sub agent with the run
directory, manifest path, report path, and paper-summary path. The host waits
for the agent to write both non-empty Markdown artifacts, then records them in
run state. `module_runner.py` cannot execute this host-owned module.

## Boundaries

- Read only manifest entries with `status: downloaded`, a run-relative path,
  an existing file, and a `%PDF-` signature.
- Do not search or download. Do not use abstracts as PDF evidence.
- State exclusions and limitations plainly. Never fabricate unreadable content.
- Use `selection.json` and referenced metadata as the original selection
  hypothesis. Determine final relevance from the PDF and record contradictions
  or lack of support; metadata cannot overrule full-text findings.
- Give every readable paper an exactly three-sentence `Interaction summary`
  covering problem/background, method/contribution, and result/conclusion plus
  query relevance so the host can display it verbatim.
