# Reading scope and outcomes

## Scope and completion

Distinguish **full text acquired**, **some full-text evidence read**, and
**the user's required reading scope completed**. Determine the scope from the
request, confirmed intent and feedback, without another setting or confirmation.
A targeted check may read relevant passages only; full reading requires all
requested parts, not just the passages retrieved.

Judge coverage from actual PDF tool responses or the directly read run-contained
PDF, preserving authorization and source/revision binding. `next_offset=null`
only exhausts the returned collection, which may be a subset or filtered windows;
it does not prove whole-PDF reading. Account for `unavailable_pages`,
`omitted_regions`, truncation and unknown coverage. Text or captions do not cover
omitted figures, tables or formulas; different versions cannot fill each other's
gaps. Metadata is not full-text evidence.

Continue reading when required content is missing. If tool, parsing or budget
limits prevent completion, deliver the available evidence as partial, naming the
unread sections/pages, omitted content or unknown coverage and the reason. Do not
claim completion or infer that unread content is absent from the paper.

In `read_report.md`, record each paper's requested scope, actual pages/sections
read, source version when available, and remaining gaps. Preserve material gaps
in `paper_summary.md` and its interaction summary. The final report and chat must
not upgrade any paper's completion, including archived rounds and mixed-completion
batches. A completed targeted check is not a whole-paper read.

`readable`/`unreadable` describe readability, not reading completion.
`completion_outcome: full_text` describes a report using full-text evidence,
not full-document coverage. Neither `state: ready`, `content_level: fulltext` nor
passing the artifact validators establishes complete reading.

## Manifest-bound outcomes

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

## No readable full text

When all current and archived reading rounds have manifest-bound outcomes and
none has a readable paper, still write both Markdown artifacts: explain the
exclusions and evidence gap, with no per-paper full-text findings or fabricated
interaction summaries. Offer the same finish/refine review. On finish, the
shared final-report agent writes a limitations report in the user's language.
Use `## No readable full text` in English or the exact Chinese heading accepted
by the final-report validator in `scripts/run_state.py`. State that no full-text answer
can be established, explain why, and identify appropriate next steps. The
normal abstract-alert rules still apply, but never synthesize them as full-text
evidence or fabricate numbered citations. End with a references heading in the
user's language (`## References` in English or the exact Chinese heading
accepted by the same validator) and an **empty** full-text reference section.

`stage.py complete --stage final-report` checks the complete current/history outcomes, manifest hashes,
paper coverage, explicit limitation heading and absence of numeric citations.
It records `COMPLETED` with `completion_outcome: no_readable_fulltext`. It does
not claim successful full-text synthesis. If any round has readable papers or
unknown outcomes, normal numbered full-text references remain mandatory. The
user's finish decision and authorization requirements are unchanged.
