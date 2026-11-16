# Evidence and current decisions

Put the applicable checks into the generated Skill's actual analysis steps. Use them across domains rather than encoding a test case's answer.

## Read only the authorized sources

Keep a materials record with each source's real identifier or file locator, title, version and read coverage. Distinguish file paths from citation handles. Never invent either or drop an unavailable source silently. Report unreadable or partial coverage; do not guess page numbers or claim unperformed searches or library checks.

- **Project files:** If reading requires a prior decision, use only `resource/list` before confirmation; show “File exists; not yet read” and do not draft findings. After confirmation, read only the final selection. For text comparison, discover `resource/read-text` with `contract/describe` and check `truncated` and failures. Do not pass paths to `pdf/status` or `pdf/read` as `ref_id` or bypass host retry/exclusion decisions in the terminal.
- **Library items:** A readable primary PDF does not authorize supplemental attachments. Respect project scope and preserve the real `attachment_id`. Do not switch bindings to an unselected attachment or drop its ID to substitute the primary PDF. A card answer or textual consent does not create a source binding; the user must attach the paper or supplement through the host. On `citation_source_not_authorized`, check the binding and explain the host action instead of repeating the same request.
- **Whole PDFs and page verification:** Follow the host's `pdf-evidence` workflow for project library materials. Use an existing authorized locator, or retrieve the same version's bytes via `resource/read` in base64 chunks and parse them page by page.

## Verify claims and comparisons

For each decisive claim, keep one fact record: stable ID, source version and location, short excerpt, subject, applicable conditions, time, original value, unit and category (fact, calculation, assumption or unknown). Check the passage actually read, not just the presence of a citation. Search the read material before marking a gap; an abstract cannot establish a full-text finding. State what is missing and its effect instead of borrowing a nearby citation or value.

Check version, experimental setting, comparison direction, denominator and unit before comparing. Preserve qualifications: recommended is not required, slower is not impossible, and unreported is not absent. Show calculations for derived values and state which observation would falsify which claim. Do not attribute a successor's result to the original, infer a threshold from a nearby number, or label different settings as a contradiction. Keep conflicting sources side by side with their citations. When a revision explicitly restates an earlier value, retain it with that source and mark original verification as pending.

## Use the latest decision to produce one result

Do not offer excluded topics or let withdrawn dimensions drive rejection or recommendation. If recommendation is disallowed, report comparisons and gaps without choosing a route. For a revision limited to one item, replace it by stable ID and preserve all other items and their order. A revision submission is not final confirmation; when final confirmation is required, cancellation or its absence must not produce a final artifact.

Derive the conversation, workbench, evidence details and exports from the same checked records and final confirmed values. Resolve mutually exclusive branches once to determine current tasks and deadline status; historical dates may be explained but are not current deadlines. Keep same-named counts separate by stage, source version and denominator. Recheck ambiguous labels, nearby values and section boundaries before publication.
