# Balance decision inputs

These are minimal shape examples, not research evidence. Replace sample content
with the current intent, actual tool results and visible evidence. Save under
`WORK` and execute the matching `next_commands[action].command` from the current response.
No schema/source inspection is needed. Do not submit examples unchanged.

CLI root fields `status,error,phase_state,budget,allowed_actions,next_commands,
next_action` are stable across success and failure. `metadata` contains other
context; `records` contains paged evidence. Use `next_command` when more records are needed.
The first page retains executable action commands; continuation pages have
`next_commands:{}`. Preserve each paper's own `review_ref` with its evidence.

`retrieve` and `cite` return a compact title index; `overview` lists the full eligible
pool without a limit argument. The index has no review_ref. Use its `inspection.command`
and append `--ids ID1 ID2` (up to 20) to obtain source evidence and per-paper references.
Do not write a pagination program or scan pool.json: use returned continuation commands.

## record-web → web-decisions.json

Run the Web route below, then register the actual observations. No separate call
permission is needed. Recording is retrospective and cannot enforce Web call
counts. `web_batch_count` counts submissions containing new observations;
`web_query_count` counts distinct recorded query outcomes. These are registration
counts, not verified network-call counts. Identical observations are indistinguishable
from resubmissions, even if another real call produced them. Replaying an
unchanged submission is idempotent; registration and classification repair do not
run Web. Preserve saved results across resume instead of repeating the search.

### Web route (official API → native → browser)

When the dispatch supplies a non-empty `WEB_SEARCH_INVOKE`, prefer the sibling
`web-search` skill for each planned query; otherwise use the executor's native Web
Search tool. Run every `web-search` leg from `WORK` so its artifact lands there:

1. **official-api** (only when `WEB_SEARCH_INVOKE` is non-empty): run
   `"$PLS_PYTHON" "$WEB_SEARCH_INVOKE" --provider official-api --query "<q>" --limit 20`,
   then read `WORK/web-search-result.json` before the next call (it is overwritten
   each run). Ignore the exit code — it reports artifact publication, not the
   search outcome; judge only by the artifact's `status` and `candidates`. Map its
   `duration_ms` to `elapsed_seconds`. Each candidate carries `title`, `url`,
   `description`; copy `title` and `url` into `papers` (the `description` is a
   search snippet, not a verified abstract — do not record it as `abstract`).
   - `completed`: accept its candidates as the observation; record `success`.
   - `empty`, or `unavailable` (error `credential_unavailable`, no
     `SCHOLARSEED_API_KEY`): a fall-through signal — try step 2 for the same
     query. Never record `unavailable` as a status; it is not in the allowed enum.
   - `failed`: an authorization rejection (error
     `official_api_authorization_failed`, 401/403) records `authentication_error`
     and skips official-api for the rest of the batch without retrying; a
     transport/response failure (`official_api_request_failed`,
     `official_api_response_invalid`) records `transport_error`. Then fall through
     to step 2 for discovery.
2. **native Web Search**: run the same query with the executor's own web tool and
   keep only paper landing pages. This is the fallback when official-api is
   absent, `unavailable`, or `empty`, and the only path when `WEB_SEARCH_INVOKE`
   is empty.
3. **visible-browser** (only when `WEB_SEARCH_INVOKE` is non-empty and steps 1–2
   produced nothing usable): run
   `"$PLS_PYTHON" "$WEB_SEARCH_INVOKE" --provider visible-browser --query "<q>" --limit 20`
   and read `WORK/web-search-result.json` exactly as in step 1.

Record one entry per executed query carrying the status of the leg that produced
the observation, or the terminal failure when every leg failed. A query whose
official leg was `unavailable`/`empty` but whose native leg succeeded records
`success` from the native observation, not the official signal.

```json
{"queries":[{"query":"actual executed query","status":"success","elapsed_seconds":1.2,"papers":[{"title":"Actual paper title","url":"https://arxiv.org/abs/1234.56789"}]}]}
```

Copy the executed query exactly; use its measured duration (or `null` if unknown).
`status` is `success`, `transport_error`, `authentication_error` or `execution_blocked`;
include the observed `error` for a failed call. Reserve `execution_blocked` for a
genuine host/sandbox permission block (for example the visible-browser leg cannot
launch a browser); a missing API key is an `unavailable` fall-through, not a block.
`papers:[]` is valid when no scholarly record is supported. Supply only evidenced
fields: title and a recognized scholarly URL (including NeurIPS proceedings) are
sufficient. For an author-hosted or unrecognized URL, supply `document_type:"paper"`
and a short `classification_reason` describing the observed publication evidence.
Abstract, year, DOI/arXiv ID and authors are optional; never invent missing metadata.
Worker preserves raw outcomes and reports accepted/pending/rejected records by
index with reasons. Unknown type stays pending outside the pool and does not block retrieval or selection
of other verified papers. Repair only when selecting that record requires it. To repair, resubmit the same outcomes with
only classification fields corrected. Never clear/reorder papers to pass validation.
Repairs retain prior attempts and do not count as new searches. `papers:[]` means
no supported discoveries, not a workaround for registration failures. Failed calls
retain their actual status/error. Worker generates IDs and normalized fields.

## retrieve → retrieval-decisions.json

Keyword-only, with no known titles or inferred entities:

```json
{"subtopics":["multimodal alignment"],"entity_analysis":"The topic is explicit; no hidden entity or reliable paper title is known.","entities":[],"queries":[{"mode":"keyword","query":"multimodal remote sensing alignment","rationale":"Find studies of the confirmed relationship."},{"mode":"keyword","query":"cross modal sensor fusion","rationale":"Find complementary sensor fusion methods."}]}
```

Mixed queries, when a reliable title clue is available:

```json
{"subtopics":["multimodal alignment"],"entity_analysis":"The topic is explicit; no hidden entity is inferred.","entities":[],"queries":[{"mode":"keyword","query":"multimodal remote sensing alignment","rationale":"Find studies of the confirmed relationship."},{"mode":"title","query":"Multimodal Alignment","rationale":"Probe an evidenced canonical title."}]}
```

Use the mode's full query-planning strategy; two entries only demonstrate shape.
Every query needs `mode,query,rationale`. Keyword queries have **at most 8
whitespace-separated words**, including Boolean operators; title queries do not
share that word cap. **`queries` must be nonempty; keyword-only input is valid,
including with `entities: []`.** Title queries are optional: use them only with
reliable paper title clues. Never invent titles or change a keyword query's mode
to `title` to satisfy validation.
Prefer 3–5 keyword terms. Overall phase/query limits remain
unchanged. `entities:[]` is valid; if present, each entity needs
`name,type,rationale,confidence` and a query referencing that exact name via `entity`.
Worker derives internal angle lists from query purposes and Web provenance from
its execution ledger. Do not send `candidate_angles`, `search_angles` or
`web_queries`. Top-level `concept_probes` is an internally derived field, not a
valid field in this input file; it is not read. Worker derives probe objects from
entity-bound queries and title queries. With neither entities nor titles, the
internal `concept_probes` and `landmark_queries` lists are empty; keyword queries
still execute through `planned_queries`.
Worker creates plan, batch, identity, timestamps and state. On resumable execution
failure repeat `retrieve` without `--input` to reuse saved decisions.

## select → selection-decisions.json

```json
{"selected":[{"id":"COPY_VISIBLE_PAPER_ID","review_ref":"COPY_THIS_PAPERS_REVIEW_REF","tier":1,"relevance_score":null,"selection_reason":"Promising fit to the requested method and dataset; the ablation numbers still need full-text verification.","subtopics_covered":["multimodal alignment"]}],"coverage_assessment":"State covered relationships and remaining gaps.","warnings":[],"stop_reason":"State the actual reason this search iteration is complete."}
```

`selection_reason` is the agent's assessment of why the paper should proceed to
review/reading, including important uncertainties. `criteria` is optional and may
cover only the clues worth handing to the reader. If supplied, each entry has a
current `criterion_key`, `verdict` (`supports|clear|unknown|contradicts`) and `reason`.
`unknown` does not block a candidate; a known contradiction still excludes it.
Optional `evidence` entries use `field` and `quote`, with optional `source` and
`locator`. Field names are free text (for example `web`, `full_text`, `citation`);
there is no metadata-substring or displayed-quote check. Use `reason` for inference
or paraphrase and `quote` for source text; include a source/locator when useful.
Every selected item still needs that paper's current `review_ref`. Worker supplies
intent/scope/evidence hashes and `verification_status: candidate`, and generates
selection, metadata and report. These bindings identify the paper and request;
they do not certify the agent's claims. Do not write those lower-level artifacts.
`selected:[]` is valid for an honest no-match outcome with a concrete stop reason.

When no useful in-scope candidate exists, rank the closest meaningful alternatives from
the visible current pool and add **up to 3** `related_recommendations` (also obey
any smaller user limit). Keep `selected:[]`; do not assign tiers or claim matches.
Use `confirmed_connections` for source-supported statements, each with its own
exact quote. Use `unmet_criteria` with `status:"unmet"` for an evidenced mismatch
or `status:"unverified"` for missing evidence. Never assert an unverified citation
or mechanism as a confirmed connection. Quote checks verify provenance; the
agent still judges whether each quote supports its statement:

```json
{"id":"COPY_VISIBLE_PAPER_ID","review_ref":"COPY_THIS_PAPERS_REVIEW_REF","confirmed_connections":[{"statement":"The source supports this specific connection to the question.","evidence":[{"field":"abstract","quote":"Exact visible source text supporting this connection."}]}],"unmet_criteria":[{"criterion_key":"precise_intent","status":"unverified","reason":"The required citation relationship is unconfirmed."}]}
```

Put these entries in `related_recommendations` alongside coverage, warnings and
stop reason. Each entry carries its own paper's `review_ref`, as for strict
matches; worker supplies scope/evidence hashes. Gaps use current `required_criteria`
keys. Recommendations cannot coexist with strict selections, include excluded
IDs or count as coverage. No recommendation is required when nothing meaningful
is available: explain that in coverage, including source failures when relevant.
These alternatives remain outside `metadata.papers`; request scope clarification before
reviewing them for ordinary selection/download authorization.
Papers worth reading to resolve missing details belong in `selected`, with an
honest reason, rather than being forced into this alternatives-only path.

Use current `next_commands` and `allowed_actions`, including after an error;
completed phases cannot accept new plans. Record actual Web outcomes, including
failures; a planned but unexecuted query does not block selection. Disclose any
missing evidence without inventing an outcome. `retryable` describes whether the same
failed command can be repeated unchanged; `recovery_command` supplies a corrected
legal action when available. For input errors, `details.field` points to the offending JSON field; keyword
length errors also return `query`, `word_count` and `max_words`. Correct the input
without weakening the requirement or exploring implementation code.
Review errors include the failed paper ID and a focused `recovery_command`; use
that command to inspect its current evidence and copy its `review_ref`. Do not
re-read the whole pool or construct a replacement reference yourself.
