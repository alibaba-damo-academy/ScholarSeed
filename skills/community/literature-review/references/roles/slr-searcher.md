# Searcher role

Read this brief only when delegated the retrieval stage. Start with an empty
context (`fork_turns: "none"`). Reuse the supplied workspace launcher and
resolved skill path; do not rediscover installation or workspace directories.

## Atomic dependency

Invoke the independently installed **`$agentic-search`** skill. Its `SKILL.md`,
tools, current PaperHub API contract, and configuration are authoritative. Do
not look for or call an SLR-local copy, and do not translate or re-interpret
its operating procedure here.

The delegation prompt contains one precise, natural-language **literature
search intent** already translated by the host from the original survey intent
and current effective requirements in writing_request.json.
Execute that sentence directly. Do not ask clarification questions and do not
translate it again.

## Inputs and outputs

The prompt gives:

- the exact natural-language literature-search intent;
- the initialized workspace launcher and caller directory;
- `search_target` from `papers budget` and already supplied local titles/DOIs,
  plus any must-include probes or exclusions that affect discovery.

The target is the number of additional distinct papers. Pass it explicitly to AS
as target-count; a 10/20-paper supplement must not become its default 40. Avoid
returning supplied local papers again. A zero target skips this role entirely.

Implement every user excluded-topic requirement semantically during search and
selection. Exclude papers whose subject falls within that scope; a related-work
mention alone is not enough to exclude a relevant paper. Pass these requirements
to agentic-search as part of the precise task and use its normal selection process.
Report genuine uncertainty and resulting coverage gaps in status_reason. No later
SLR keyword screen or extra model will adjudicate exclusions again. Do not rewrite
finalized search metadata or trim the user's supplied local PDFs.

Resolve the survey workspace to an absolute path before switching directories.
It is the host-selected destination under the original user's working directory;
never derive a new workspace from the AS or SLR installation path.
Use it as AS's working directory, so AS writes under
`<workspace>/agentic-search-results/<topic>/` according to its own path rules.
Use **Balanced** and explicitly pass `balanced` to AS unless the user chose a
different search mode or search deadline. Do not leave the mode unspecified:
AS's standalone default may differ. Do not infer a short search budget from
SLR's `fast` pipeline profile. Request abstracts for downstream paper cards (including when the user
explicitly chooses Quick). Do not require a narrative search report.
For SLR discovery, every final selected paper must have all three: a real complete
abstract, at least one identifiable author, and a source-provided publication
year. Exclude missing/placeholder/truncated abstracts, absent or placeholder
author names, and absent/invalid years before final selection. Preserve complete
abstracts and true author/year metadata. A publication date supplied by the source
may explicitly provide its year; never infer years from identifiers/file times,
invent authors or generate replacement abstracts.

Express the three eligibility conditions in the task passed to agentic-search.
Use only its existing public interfaces; do not modify AS code, configuration,
finalizers or skill instructions, and do not invent new CLI flags. Request full
abstracts using supported output options. Before model-authored final selection,
choose qualified records from the existing pool. If a mode's fixed output cannot
meet a condition, report that limitation and import its unmodified result; SLR's
adapter applies the three-field screen to every imported search result, including
Quick and Web fallback. Do not rewrite AS metadata after finalization.

Report exclusions actually observed and any shortfall. Do not start recovery
loops or pad the list with incomplete metadata. Local PDFs retain their separate
user-supplied import policy.

The stable required result is `metadata.json`. Current AS's `report.md` is
optional and `search_provenance.json` is not generated; preserve whatever
session/round/fallback traces AS actually supplies. After AS finishes, use the
provided workspace launcher to import its result:

```bash
./<topic>/slr import-search --source <absolute-AS-result-directory>
```

This copies the original run to `02_retrieval/as_run/`, copies metadata unchanged
to `02_retrieval/metadata.json`, and records the import path and hash. Never
fabricate legacy provenance or edit AS's metadata to satisfy an old contract.
The importer refuses to overwrite an existing search/corpus.

Do not write `selected_paper.json`; the deterministic SLR adapter owns it.

Any publication range in the search intent is a soft preference. Concentrate
ordinary discovery in it, while retaining older foundational theories,
original methods, standards, classic reviews, datasets, and benchmarks. If the
host supplied the default recent-five-calendar-year range, treat it identically
and do not ask the user about years.

Explicitly tell AS that SLR's years are ranking preferences, not exclusive
cutoffs. Do not use hard year bounds on foundational probes or final selection.
Express the search intent as a preferred interval with older foundations
allowed, avoiding literal `before YEAR` / `before January YEAR` phrasing: current
AS's finalizer interprets those phrases as hard cutoffs even inside soft prose.
The original survey sentence remains verbatim in `01_input/writing_request.json`.

AS currently targets 38–40 papers in Balanced (strict validation allows 30–40)
and up to 20 in Quick; for other modes follow AS's current count contract.
Pass the SLR target as a coverage need; if it
exceeds the selected mode's capacity or credible evidence, report the shortfall
instead of padding, changing AS internals, or restarting to fill a quota.

Preserve all fields AS actually outputs. Current normalization exposes
`journal_name`, `journal_volume`, and `journal_pages`, but no longer guarantees
upstream `citationStyles` or arbitrary bibliographic fields. SLR's adapter maps
the journal aliases and preserves legacy fields when present; missing fields
stay missing. Never invent BibTeX types, abstracts, or missing identifiers.

If AS switches to Web-only, let its own fallback finish and import that result.
Do not retry PaperHub or ask for a token. Report source degradation, missing
abstracts, coverage gaps, and any partial result even if enough papers exist.
Newly discovered papers without usable complete abstracts, author names or years
must be excluded, not handed off as incomplete citation records.

## Return contract

Your entire final message is one JSON line:

```json
{"stage":"retrieval_search","status":"SUCCESS","status_reason":"","papers_found":42,"tier_counts":{"1":4,"2":14,"3":24},"rounds":4}
```

Use `PARTIAL_SUCCESS` for a usable but thin/uneven corpus and `FAILED` only when
there is no usable pool or import failed. Put the selected mode, soft window
and its explicit/default origin, retained older-foundation count, widening,
target shortfall, and source degradation in `status_reason`. Use AS's completion
status and in-memory decisions; do not reread its raw pool or repeat diagnostics
after finalization. Do not paste a paper list or report into the host context.
