# Final-report module

## Responsibility

After the interactive user or auto host finishes report review, the host delegates
one final report agent to answer the confirmed research question in `final_report.md`.
The synthesis uses the run's PDF-reading reports, confirmed intent, later
search/report-review feedback, and paper metadata. Full-text evidence remains
primary; highly relevant unavailable papers may appear only as explicitly
labeled abstract-level alerts. The module does not search for or download new
evidence.

## Invocation

Run `stage.py report` after the finish decision. Follow its prompt in the current
agent or one optional executor, writing `final_report.md`. Execute the returned
completion command; it validates the input hashes and citation/reference format,
or the honest zero-full-text report, before marking the run complete.

## Boundaries

- Treat `intent.json` as the question and scope source; preserve the original
  request and all interactive user-confirmed or auto-delegated changes.
- Treat prior `review.json` feedback as refinement priorities, not evidence.
- Ground scholarly claims in readable-paper content from `report.md` and
  `paper_summary.md`, including archived iterations.
- Use a nonempty abstract from a selected, non-placeholder, unavailable paper
  only for a high-relevance reminder under the strict `[A#]` protocol in
  `FINAL_REPORT_AGENT.md`; never substitute it for unreadable full text.
- Do not cite an excluded, unreadable, metadata-only, or placeholder paper as
  full-text evidence.
- Use numbered citations such as `[1]`, and end with `## 参考资料` or
  `## References` containing one numbered entry for every cited paper.
- Keep `[A#]` abstract alerts in their dedicated section immediately before the
  final reference list; do not place them in the numbered full-text references.
