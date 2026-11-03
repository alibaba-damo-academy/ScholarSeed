# Reading outcomes and zero-full-text completion

The reader writes `reading-outcome.json` alongside the two non-empty Markdown
reports. Read `state.json` for the run ID and search round. Record one entry
for **every** `status: downloaded` manifest entry, including invalid/missing PDFs
excluded before reading; do not include failed or skipped downloads. Use the
actual parse/read outcome, not the PDF header or download status, to choose
`readable` or `unreadable`. An unreadable entry requires its concrete reason.

`file_path` names the run-contained evidence the entry's verdict came from:
`work-reading/<paper_id>.txt` for a managed full text read through the
`scholarseed_bridge` `pdf read` tool operation, or the manifest `file_path` for
a run-contained PDF. A `readable` entry must point at a real, non-empty
run-contained evidence file, and when the stage completes its paper must still
be a product-acquired managed entry (or a run-verified PDF).

```json
{
  "schema_version": "1.0",
  "run_id": "<current run ID>",
  "search_round": 1,
  "manifest_sha256": "<SHA-256 of the exact download manifest bytes>",
  "papers": [
    {"paper_id": "<manifest paper_id>", "file_path": "work-reading/<manifest paper_id>.txt",
     "storage": "managed", "revision": "<manifest revision>",
     "status": "readable", "reason": null},
    {"paper_id": "<other manifest paper_id>", "file_path": "downloads/papers/example.pdf",
     "status": "unreadable", "reason": "PDF parser could not recover any readable pages"}
  ]
}
```

Validate using `scholarseed-skill-python "$SKILL_DIR/scripts/validate_json.py" --contract reading-outcome --input <path>`. The host records
`paths.reading_outcome` in run state. Report-review refinement archives this
artifact with the manifest before clearing active paths. Never rewrite archived
outcomes or infer missing outcomes from titles, metadata, or an empty
summary. Missing outcomes must be completed before finishing; inspect
their actual PDFs and explicitly restore auditable outcomes if necessary.

When all current and archived reading rounds have manifest-bound outcomes and
none has a readable paper, still write both Markdown artifacts: explain the
exclusions and evidence gap, with no per-paper full-text findings or fabricated
interaction summaries. Offer the same finish/refine review. On finish, the
shared final-report agent writes a limitations report, including the heading
`## 无可读全文证据` or `## No readable full text`. State that no full-text answer
can be established, explain why, and identify appropriate next steps. The
normal abstract-alert rules still apply, but never synthesize them as full-text
evidence or fabricate numbered citations. End with the normal `## 参考资料` or
`## References` heading and an **empty** full-text reference section.

`stage.py complete --stage final-report` checks the complete current/history outcomes, manifest hashes,
paper coverage, explicit limitation heading and absence of numeric citations.
It records `COMPLETED` with `completion_outcome: no_readable_fulltext`. It does
not claim successful full-text synthesis. If any round has readable papers or
unknown outcomes, normal numbered full-text references remain mandatory. The
user's finish decision and authorization requirements are unchanged.
