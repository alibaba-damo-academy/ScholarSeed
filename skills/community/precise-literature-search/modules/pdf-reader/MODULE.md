# PDF-reader module

## Responsibility

The host delegates one quick reading sub agent for each completed download
batch. The sub agent reads only the text of papers listed as downloaded in
`downloads/manifest.json`: for a managed entry it pages through the text with
the `scholarseed_bridge` product tool
(`{"capability":"pdf","operation":"read","request":{"ref_id":"paper:<id>", …}}`;
serve checks the authorization of every ref on every read) and caches the text
it actually used at `work-reading/<paper_id>.txt`, which `reading-outcome.json`
names in `file_path`; for a run-contained PDF left by the paid route it reads
that file at its own `file_path`. It never downloads or unpacks PDF bytes
inside the sandbox, and it writes both `read_report.md` and `paper_summary.md`.
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

- Read only manifest entries with `status: downloaded`, through the
  `scholarseed_bridge` `pdf read` tool operation cached at
  `work-reading/<paper_id>.txt`, or the run-contained PDF for the paid route;
  never download or unpack PDF bytes inside the sandbox.
- Do not search or download. Do not use abstracts as full-text evidence.
- State exclusions and limitations plainly. Never fabricate unreadable content.
- Use `selection.json` and referenced metadata as the original selection
  hypothesis. Determine final relevance from the PDF and record contradictions
  or lack of support; metadata cannot overrule full-text findings.
- Give every readable paper an exactly three-sentence `Interaction summary`
  covering problem/background, method/contribution, and result/conclusion plus
  query relevance so the host can display it verbatim.
