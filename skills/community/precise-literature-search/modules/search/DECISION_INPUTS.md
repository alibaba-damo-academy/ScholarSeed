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

## Web search capability

This shared contract applies to quick, balance and full modes. Web may be a native
tool, MCP/connector, or an installed search skill available to the current executor.
Follow the host's discovery and permission rules; do not invent an invocation API
or assume a delegated executor inherits the parent's tools. A non-empty
`WEB_SEARCH_INVOKE` locates the sibling `web-search/scripts/invoke.py`. Read that
skill's `SKILL.md` and `CONTRACT.md` before use. If it is absent, discover an
available equivalent and read its actual contract rather than guessing its schema.
If no permitted capability can run, preserve the coverage limitation.

### ScholarSeed route and artifacts

Use the current `web-search` contract **`scholarseed.web_search.v1`**, not the
upstream `shushen` schema. Select one provider per script invocation. The caller
owns the route **official-api → native (if available) → visible-browser (if
supported and permitted)**. If the host explicitly invokes the `automatic`
profile, that Invocation owns this same route; consume its outcomes rather than
running a second fallback chain. Never select `native` when native Web is absent.

For direct official/browser execution, use the supplied product `PLS_PYTHON` and
absolute `WEB_SEARCH_INVOKE`. Run from `WORK/results` and choose a fresh relative
JSON **filename** per query, provider and attempt, for example
`web-q001-official-a001.json` and `web-q001-browser-a001.json`:

```text
"$PLS_PYTHON" "$WEB_SEARCH_INVOKE" --provider official-api --query "<actual query>" --limit 20 --artifact-path web-q001-official-a001.json
```

Use PowerShell's call operator on Windows as described in the Windows guide.
`--artifact-path` accepts a filename, not an absolute path or `results/...` path.
Do not overwrite a previous attempt or share a default filename across queries.
For a separate host Invocation, retain its independently published artifacts and
save exact copies under distinct `WORK/results` paths before recording observations.

- Read the written JSON, check its `schema`, `provider` and exact executed `query`,
  and branch on `status`. The process exit code reports **file writing**, not
  search success or publication. A missing/invalid artifact is not an empty result.
- `completed` **and `empty` terminate the route successfully** for that query.
  Do not try a later provider after either, even if no candidate is a scholarly
  paper. Scholarly filtering does not turn successful Web execution into failure.
- Only `unavailable`, `failed`, or an unexecutable/invalid native result can move
  to the next permitted leg. Do not retry 401/403. Browser `action_required`
  preserves the manual-verification requirement; never bypass CAPTCHA or host denial.
- After each official/browser script returns, publish its exact written artifact
  via `scholarseed_bridge` (`capability=artifact`, `operation=publish`,
  `request={"path":"<actual workspace-relative path>","role":"final"}`). Publish
  failure and empty results too. Check `ok: true` separately; publication failure
  does not justify rerunning search or replacing the artifact with model-written JSON.
- The native tool does not run `invoke.py`. Save its actual returned evidence
  separately; the host's native marker envelope has no timing fields and is not
  the script artifact. Preserve the raw response, never fabricate provider fields.

Query budgets count research queries, not tool calls. Split a batch into
single-query invocations without adding angles. Keep all provider attempts within
the saved deadline and reuse their artifacts on resume. Retain raw candidates,
provider/status/error details and measured duration for **every** attempt, including
failed legs before a successful fallback. Do not save credentials or request headers.
Convert `duration_ms` to seconds; use `null` for unknown native timing.
Candidate `description` is a snippet, not a verified abstract or full text. Preserve
it in raw evidence, including empty browser descriptions; extract only evidenced
scholarly metadata into `papers`.

## record-web → web-decisions.json

Use the shared capability above, then register one entry per actual provider
outcome, preserving failures even if a later provider succeeds. Include the saved
`raw_result_path` relative to `WORK` and the original `provider` and
`provider_status` alongside `query,status,elapsed_seconds,papers,error?`.
These extra provenance fields survive in the worker's immutable raw outcome.
For quick/full pool/state recording, retain the same evidence paths in the saved
Web result and log each actual outcome through their existing recording tools.

Map `completed`/`empty` to `success`; credential/authorization failures to
`authentication_error`; unavailable execution or `action_required` to
`execution_blocked`; request/response failures to `transport_error`. Keep the
original status/code in the raw artifact and a sanitized error explanation for
failures. A missing API key is an authentication limitation, not a sandbox denial.

Recording grants no execution permission and cannot enforce provider call counts.
`web_batch_count` counts submissions containing new observations; `web_query_count`
counts distinct recorded outcomes, not verified network calls. Replaying unchanged
outcomes or repairing classification is idempotent and does not run Web.

```json
{"queries":[{"query":"actual executed query","status":"success","elapsed_seconds":1.2,"papers":[{"title":"Actual paper title","url":"https://arxiv.org/abs/1234.56789"}]}]}
```

Copy the executed query exactly; use its measured duration (or `null` if unknown).
`status` is `success`, `transport_error`, `authentication_error` or `execution_blocked`;
include the observed sanitized `error` for a failed call, using the mapping above.
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
