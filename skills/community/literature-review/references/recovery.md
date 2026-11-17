# Input and recovery operations

Read only the entry matching an actual diagnostic or task change. These operations serve the same bound
workspace and preserve its request, grants and completed results; they are not an alternative normal workflow.
Use diagnostics to select the supported operation. Explain the completed work, practical limitation,
delivery impact and next decision to the user; retain exact diagnostics for requested technical detail.
Elapsed estimates do not block recovery. Continue safe supported operations; ask only for an actual task,
permission or user-dependent blocker decision. Describe remaining work and additional expected time rather
than asking the user to set a cumulative time value. Additional time is an estimate, not a new cutoff.

| Situation | Operation and boundary |
| --- | --- |
| The installed launcher fails before initialization | `doctor --scope runtime --no-network --json` returns the exact supported runtime/CLI. Restore its reported prerequisite; do not invent shell variables or use another interpreter. |
| The request needs a less common structured field | `init --mode quick|standard --describe-input --field <path>`; paths include constraints.values.required_section, retrieval.corpus_size and publication.citation_style. Preserve explicit scope and original wording. |
| An existing task needs a missing launcher restored | `init --workspace <actual-task-directory>` without a new intent/request; a binding conflict requires its documented recovery, not overwriting existing files. |
| The user changes task requirements | `writing configure --request FILE`; intent stays immutable, actual follow-ups enter user_requests and effective_requirements. constraints replaces its full list. Honor any returned decision requirement. |
| The user supplies additional/corrected local PDFs | `papers import-local --request FILE`; consumes files through the existing importer. Do not modify parse receipts or library data to imitate preparation. |
| Selected-source consumption failed after a successful activation | Repeat `writing plan-packet --receipt REF` with the product's original receipt_ref. A changed selection needs actual activation and decision. |
| Plan or outline consumption was interrupted | Reuse the original receipt_ref and the same action/amendments. Never regenerate confirmation JSON, timestamps or answers. Report digest/binding failures and preserve the original file. |
| An old task has per-paper import receipts | Keep its existing material_papers.json and frozen corpus. New selected-source imports use activation preparation by reference; the public CLI rejects new items arrays. |
| A Standard outline needs explicit approval or approved asset edits | Use the outline checkpoint/approval operations in the main Skill, then `manuscript prepare`. Its returned inventory/figure brief is authoritative. |
| Workflow execution failed/interrupted | Use `workflow evidence --resume` when allowed by its returned diagnostic. An explicit --from starts that stage and later work; choose it from the reported reason, not guessed freshness. |

A preparation or writing failure preserves the request and completed work. Keep precise diagnostics and use
the named public operation. Do not replace an ambiguous citation identity by paper order or edit installed code.
