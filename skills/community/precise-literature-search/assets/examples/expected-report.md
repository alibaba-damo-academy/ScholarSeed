# Full-Text PDF Report

An actual report from the single batch PDF-reading sub agent lists verified and
readable PDF coverage, readable/excluded paper IDs, exclusions with reasons,
evidence provenance and material limitations. It never substitutes
metadata or an abstract for unreadable full text.

The companion `paper_summary.md` is the sole per-paper evidence record. It
identifies each paper, explains its full-text relevance to the query/feedback,
and records the necessary method, findings and limitations with page/section
support. It corrects a metadata selection reason when the PDF does not support
it; generic background and empty field-by-field narratives are omitted. Each paper has an
exactly three-sentence `Interaction summary` covering problem/background,
method/contribution, and result/conclusion plus relevance. The host displays
those summaries verbatim without another full-file summarization pass.
Fixture/demo manifests remain explicitly disclosed and are not treated as
verified bibliographic evidence.

When the user chooses to finish, a separate `final_report.md` answers the
confirmed research question using these reading artifacts plus recorded search
and report feedback, without repeating their per-paper inventory. It uses numbered inline citations grounded in readable
papers and ends with `## 参考资料` or `## References` containing the matching
numbered bibliography. A selected paper without readable full text may appear as
a separate `[A#]` abstract-level alert only when its substantive abstract is
exceptionally relevant. These alerts use attributed wording, explicitly state
that the full text was not read, appear in a dedicated section immediately before
the final references, and never enter the numbered full-text bibliography.
Separate abstract-alert entries with blank lines. Separate numbered bibliography
entries with blank lines or make every entry a Markdown list item, so both
sections remain readable in the document editor.
