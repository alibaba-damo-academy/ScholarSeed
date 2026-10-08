# Dedicated Literature Search Agent — Quick Search

For user-facing summaries, follow [User-facing language](../../SKILL.md#user-facing-language).
Numeric tiers remain internal selection fields, not display labels.

Use the supplied `PLS_PYTHON` and locally generated `PLS_STAGE_TOKEN` for script
commands. Use [Web search capability](DECISION_INPUTS.md#web-search-capability)
and save the actual queries, durations, statuses and raw results through the
recording steps below, including failures.
This is retrospective accounting: scripts cannot enforce Web call counts.
Reuse saved outcomes on resume; replaying them or repairing classification does
not constitute a new search. Research-stage state, tokens and budgets still apply.

Execute exactly one immutable outer search round using
`search-skill-fast-mock-v1`, the identifier for quick search.
Query every usable discovery path once within the fixed budget, preserve all
file contracts, and report the relevance and coverage of the retrieved papers.
Do not add follow-up iterations beyond the selected profile.

Read `request.json` and the plan already prepared and validated by the host,
write all later artifacts under the supplied round's `work/` directory, and
return only a compact completion object. Never talk to the user, choose
downloads, retrieve PDFs, or claim to have read full text.

## Fixed query budget

- Run exactly one internal iteration.
- Run one PaperHub keyword query with `limit: 1`.
- Run at most one prepared PaperHub title/concept probe with `limit: 1`, only
  when the saved plan has a reliable title clue. No title probe is required.
- Run one Search Agent web query and inspect only its strongest scholarly hit.
- Reconcile that hit with at most one exact PaperHub title lookup.
- Trace citations from at most one numeric PaperHub seed with
  `citation_limit: 1`; if no numeric seed exists, record a warning instead of
  substituting another query.
- Select at most one paper.
- Never start a second iteration or a coverage-driven follow-up query.
- Keep `workers=1`.

This budget covers keyword and title retrieval, public-web discovery,
cross-source reconciliation, citation expansion, normalization, selection,
and finalization. The resulting focused candidate set has limited recall.

## Verify the prepared plan

`work/plan.json`, `work/state.json`, `work/pool.json`, and
`work/query-log.json` must already exist. The host creates them with
`tools/prepare_fast_mock.py` before delegation. You must not regenerate or
rewrite the plan, expand its queries, or repeat its entity analysis. Validate it
once before retrieval:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/validate_json.py" --contract search-plan-current --input "$WORK/plan.json"
```

If a prepared file is missing or validation fails, return a compact error
immediately instead of deliberating about a replacement. Use the keyword and web
queries stored in the plan and keep complete results in `work/results/`.
New plans have empty `concept_probes` and `landmark_queries`: the host does not
treat derived keywords as paper titles. Never invent titles or relabel keywords.

## Execute PaperHub keyword and title paths

Write a `phase: "search"` batch containing only the planned keyword query with
limit 1, then invoke:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/search_round.py" \
  --batch "$WORK/results/iteration-001-search-batch.json" \
  --work-dir "$WORK"
```

The runner uses this keyword query as the network-capability gate.
Public-network capability is provided by the product runtime; never request
sandbox escalation or any elevated permission for retrieval or download
commands. If it still returns `execution_blocked`, return that
environment blocker immediately; it counts as zero queries and does not
authorize a changed endpoint or query.

If the request reaches PaperHub but fails at the transport layer, log
one `transport_error` and skip the remaining PaperHub-dependent paths. On
401/403, log one `authentication_error`, report that `SCHOLARSEED_API_KEY` is
missing or invalid, and never print it. Continue to the single web query when
the web tool remains usable, preserving honest per-source status.

## Execute title and web paths once

After the keyword gate succeeds, run a second `search_round.py` batch only if
the saved plan contains an evidenced title probe, with limit 1. Otherwise skip
that batch and proceed directly to Web. When the host supports
an asynchronous command session, let that request run while performing the one
Web Search below. Do not persist the web result until the title runner has
finished, so `state.json`, `pool.json`, and `query-log.json` always have a single
writer. When asynchronous execution is unavailable, run title then web
sequentially.

For exactly one representative natural-language query, use the shared
[Web search capability](DECISION_INPUTS.md#web-search-capability), including its
terminal empty semantics and distinct raw artifact per attempt. Keep only the strongest paper landing
page from a scholarly publisher, DOI, arXiv, journal, conference, preprint, or
repository; ignore blogs, news, and code repositories.

Extract the title and remove site suffixes. Perform at most one exact PaperHub
title lookup with limit 1 to reconcile it. On a match, retain the PaperHub record plus web
provenance. Otherwise merge one limited `source: "web_search"` record containing
only evidenced title, URL, DOI/arXiv ID, and access status. Never invent an
abstract, venue, identifier, or access state. Persist and log the web query and
optional reconciliation result through the existing pool/state tools.

## Trace citations once

After reviewing the bounded evidence view, choose the single most relevant
paper with a pure numeric PaperHub ID. If one exists, call
`search_round.py` once with a one-element `citation_ids` array and
`citation_limit: 1`. Save the following batch at
`$WORK/results/iteration-001-citations-batch.json`, replacing `12345` with the
chosen evidenced numeric ID:

```json
{"phase":"citations","iteration":1,"citation_ids":["12345"],"citation_limit":1}
```

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/search_round.py" \
  --batch "$WORK/results/iteration-001-citations-batch.json" --work-dir "$WORK"
```

Review only the bounded citation evidence; the runner already merged its results.
If no numeric seed or reference IDs exist, record the precise
warning and continue; never fabricate IDs or run a replacement search.

Mark the sole subtopic covered or uncovered from titles and abstracts, complete
iteration 1, and stop with
`stop_reason: "fast feature-complete query budget exhausted"`, regardless of
remaining gaps.

## Select and finalize

Run `paper_select.py` with `--request "$REQUEST_JSON"`, the complete validated
intent, effective result budget, and excluded IDs. Review only the bounded candidates needed to add
`intent_review`; use agent judgment against the complete intent and explain the
selection and remaining uncertainty. Per-criterion proof and exact metadata quotes
are optional. Missing details may be resolved during reading; known conflicts
still exclude a paper. The one-paper limit is a maximum, not a requirement: return
zero when no useful candidate exists. Read `SELECTION_CONTRACT.md`, then write and
validate `work/selection.json`.

Run `finalize.py` to create the round's `metadata.json` and `search_report.md`, then
validate the metadata. The report must identify itself as
a candidate assessment, report actual query and candidate counts separately
for PaperHub and Search Agent web, state whether citation expansion was executed
or unavailable, and warn that the one-pass profile has limited recall.

Return only `status`, `metadata_path`, `report_path`, `internal_iterations`,
`pool_size`, `selected_count`, `stop_reason`, and `warnings`.
