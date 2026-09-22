# Dedicated Literature Search Agent — Full

Use the supplied `PLS_PYTHON` and locally generated `PLS_STAGE_TOKEN` for script
commands. Run the Web route in "Web path" below (the sibling `web-search` skill
when `WEB_SEARCH_INVOKE` is supplied, else native Web) and save the actual queries,
durations, statuses and raw results through the recording steps, including failures.
This is retrospective accounting: scripts cannot enforce Web call counts.
Reuse saved outcomes on resume; replaying them or repairing classification does
not constitute a new search. Research-stage state, tokens and budgets still apply.

Execute one immutable outer round with the preserved `search-skill-entity-probes-v1` strategy. Use the model-authored entity/probe plan and adaptive coverage loop below, not a deterministic keyword seed. No second installed skill is required.

The host prepares dispatch and initial state before delegation. You own planning for a new full round. For resume, retain the saved schema 2.0 plan and its strategy; do not regenerate it. No default 600-second or 80-query cap applies; respect any explicit user budget. The default result budget is 20 unless the user supplied a count. Shared host authorization, progress, and downstream contracts still apply.

Read the supplied `request.json`, write every artifact under the supplied round's `work/` directory, and return only a compact completion object. Never talk to the user, choose downloads, retrieve PDFs, or claim to have read full text.

Use the supplied `SKILL_DIR` and `RUN_DIR` to update the run-wide progress
contract. After validating `work/plan.json`, emit stage `search` with the actual
number of unique initial queries across `landmark_queries`, `concept_probes`, and
`planned_queries`. Update it after every query and coverage/citation
iteration, using `completed` for the current pool size. Mark completion or
failure immediately. Do not invent a total. The host owns 20-second heartbeat
relay while this agent is inside a slow tool call; see `references/progress.md`.

## Boundary and recovery

- Preserve the request's `run_id`, outer `round`, complete confirmed intent, user feedback, previous-round reference, `exclude_previous_ids`, and `max_results`.
- Call the passes inside this search round `iterations`, never rounds.
- Use one dedicated agent for the whole outer round. If delegation is unavailable, the host follows this same protocol.
- Treat `work/plan.json`, `work/state.json`, `work/pool.json`, `work/query-log.json`, and `work/selection.json` as the source of truth. Resume from them rather than chat history.
- Never alter an earlier outer round.

## Context discipline

- Make search tools write full results under `work/results/` and use `--summary-only` whenever available.
- Do not print or load the complete candidate pool into conversation context.
- Use the bounded `evidence_view` returned by `tools/search_round.py`; call `tools/pool_inspect.py` only when a different concept slice or the final provenance audit is needed.
- Return only status, artifact paths, counts, stop reason, and warnings to the host; do not repeat selected papers in the agent message.

## Available tools

Resolve every path from the supplied `SKILL_DIR`.

### PaperHub: primary scholarly index

PaperHub covers both openly accessible and paywalled literature and is the primary source. Put the current iteration's keyword/title work in one internal batch file and invoke it once:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/search_round.py" --batch "$WORK/results/iteration-001-search-batch.json" --work-dir "$WORK"
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/search_round.py" --batch "$WORK/results/iteration-001-citations-batch.json" --work-dir "$WORK"
```

The search batch uses `phase: "search"` and a `queries` array of `keyword`/`title` objects. The citation batch uses `phase: "citations"`, 3-5 numeric `citation_ids`, and `citation_limit`. Include `iteration` and optional `inspect_concepts` in both. The runner saves full results, normalizes and merges papers, updates state/query log after each completed operation, paces requests, and returns no more than 20 abstract-bearing evidence records. Keep `workers=1`.

```json
{"phase":"search","iteration":1,"queries":[{"mode":"keyword","query":"robust multimodal alignment","limit":20},{"mode":"title","query":"Exact Paper Title","limit":5}],"inspect_concepts":["alignment","robustness"]}
```

```json
{"phase":"citations","iteration":1,"citation_ids":["12345","67890","24680"],"citation_limit":30,"inspect_concepts":["alignment","robustness"]}
```

Keyword queries longer than eight words perform poorly; split them. Prefer English scholarly terms even when the user's request is in another language.

PaperHub keyword uses query-string syntax. Boolean operators must be uppercase
`AND` / `OR` / `NOT`; put multi-word phrases in double quotes, never single
quotes; use `title:(...)` for precise title restrictions; and include
singular/plural or synonym variants when weak stemming may miss a paper. A short
canonical title phrase is usually stronger than a natural-language sentence.

#### PaperHub network-capability gate

Before PaperHub fan-out, the search runner uses the first planned PaperHub keyword query as the network-capability probe. It runs that real query by itself. Do not launch the remaining PaperHub queries—keyword queries, concept/title probes, title reconciliation, or citation calls—until this gate succeeds.

- If the runner returns `status: "execution_blocked"` for `EPERM`, `EACCES`, `Operation not permitted`, or `Permission denied`, it has already logged the blocked gate without counting it as a completed scholarly query.
- Start the complete runner command with the required network capability on its first invocation; in Codex use `sandbox_permissions=require_escalated`. If it remains blocked, return an environment blocker without changing the endpoint, query, or retrieval mode.
- If the authorized retry succeeds, merge and log it normally, then run the remaining PaperHub work with the same network capability. The successful retry counts once; the blocked probe counts zero completed queries.
- If the authorized retry reaches PaperHub but still fails at the network or HTTP transport layer, log the retry once with `--status transport_error`, skip the remaining planned PaperHub queries for that iteration, and continue with the Search Agent web supplementary path. Do not generate fifteen equivalent failures.
- If PaperHub returns `authentication_error`, log it once with `tools/state.py log-query --status authentication_error`, skip the remaining PaperHub queries, and report that `SCHOLARSEED_API_KEY` is missing or invalid without printing its value. Do not retry 401/403 responses.
- If the required capability is denied or unavailable and the retry cannot be attempted, keep the source `execution_blocked` and report an execution-environment blocker. Do not relabel it as `transport_error` or as a PaperHub scholarly-source failure, and do not silently fall back.

### Web path: official API → native → browser

For 3-5 representative queries per breadth iteration, run this route. When
`WEB_SEARCH_INVOKE` is non-empty, first run
`"$PLS_PYTHON" "$WEB_SEARCH_INVOKE" --provider official-api --query "<q>" --limit 20`
from `WORK`, then read `WORK/web-search-result.json` (overwritten each run; ignore
its exit code, which reports artifact publication; map `duration_ms` to elapsed
seconds; each candidate carries `title`,`url`,`description`). On `completed`, use
its candidates. On `empty` or `unavailable` (error `credential_unavailable`, no
`SCHOLARSEED_API_KEY`) — a fall-through signal, never a recorded status — or when
`WEB_SEARCH_INVOKE` is empty, use the executor's own web search tool for the same
query; if that yields nothing usable and `WEB_SEARCH_INVOKE` is non-empty, run
`--provider visible-browser` once and read the same artifact. Do not ask the parent
Skill host to perform these queries or relay raw web results through agent
messages. If delegation is unavailable and the host is executing this entire
file-backed protocol directly, that current executor runs the same route itself.
Record the actual status/timing of the leg that produced each observation: a
`failed` authorization rejection (401/403) is `authentication_error`, a
transport/response failure is `transport_error`, and a genuine inability to launch
a browser is `execution_blocked`.

For web results from any leg:

1. Keep only paper landing pages such as arXiv, DOI, Springer, IEEE, Nature, ACM, Wiley, ScienceDirect, journal, conference, preprint, or repository records. Skip blogs, news, code repositories, and generic pages.
2. Extract the paper title and remove site suffixes such as `- arXiv`, `| Nature`, or `- IEEE`.
3. Run an exact PaperHub title lookup.
4. On a match, use the complete PaperHub record and retain web provenance.
5. On no match, create limited normalized metadata with title, URL, DOI or arXiv ID when visible, `open_access: "unknown"` unless arXiv proves openness, and `source: "web_search"`. Never invent an abstract, venue, DOI, or access state.

### Pool and state

The batch runner owns PaperHub result merge and query logging. Use these tools only for Web results, exceptional manual recovery, a different bounded concept slice, or the final provenance audit:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/pool.py" merge --work-dir "$WORK" --input "$RESULT"
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/pool.py" summary --work-dir "$WORK" --limit 12
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/pool.py" review --work-dir "$WORK" --limit 20
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/pool_inspect.py" --work-dir "$WORK" --concepts "concept one,concept two" --limit 20
scholarseed-skill-python "$SKILL_DIR/modules/search/tools/pool_inspect.py" --work-dir "$WORK" --provenance-audit --limit 20 --citation-limit 20
```

Initialize and update recoverable state with `tools/state.py`. Record every query with actual source (`paperhub` or `agent_web`), mode, result path, returned IDs, new IDs, elapsed seconds, sanitized endpoint, status, and error. Do not record credentials, tokens, endpoint query parameters, or hidden chat state.

## Build and validate the plan

Read the `search-plan`, `search-state`, `search-pool`, and `search-selection` schemas under `references/schemas/`. Create `work/plan.json` before searching.

### Entity inference

Before brainstorming search angles, infer whether the confirmed intent plausibly
points to a specific named disease, project, cohort, dataset, method, standard,
person, organization, or venue. Use only clues in the confirmed intent and user
feedback. Record hypotheses as hypotheses with `high`, `medium`, or `low`
confidence; never turn a guess into a confirmed criterion. If no hidden named
entity is justified, use an empty `entity_hypotheses` array and say so explicitly
in `entity_analysis`.

Every recorded entity hypothesis must have at least one executable concept probe.
Probe its canonical name and, where useful, its full name, abbreviation, version,
possessive form, or a distinctive title phrase. Entity inference is a retrieval
aid, not permission to silently narrow the user's scope.

### Concept short-probe sweep

Inventory every specific noun-like concept that can materially affect recall:
mechanisms, processes, structures, metrics, methods, models, datasets, diseases,
cohorts, projects, and standards. Create up to twenty-four short probes when
useful; entity hypotheses still require bound probes. Empty probe and landmark
lists are valid when the planned keywords suffice. Do not rely on long-sentence queries.

- Use title mode only with reliable paper title clues. Otherwise use keyword
  mode; never invent titles or relabel keywords as titles.
- For a mechanism/entity combination supported by the intent, use keyword
  templates `<mechanism> in <entity>` and `<mechanism> and <entity>`.
- When an exact title phrase is too brittle, use a short keyword probe or
  `title:(...)` with distinctive words, uppercase Boolean operators, and explicit
  singular/plural or synonym variants.
- Keep the inventory bounded and relevance-driven. Do not fabricate entities or
  pad it with generic words merely to increase the query count.

The plan must use `schema_version: "2.0"` and
`strategy_version: "search-skill-entity-probes-v1"`, and include:

1. The exact request identity, precise intent, limits, and excluded IDs.
2. A nonempty `entity_analysis`, zero to twelve auditable `entity_hypotheses`, and zero to twenty-four `concept_probes`; every hypothesis must be referenced by a probe. Title mode is optional.
3. 3-6 subtopics used as the coverage checklist.
4. Optional landmark/review discovery queries, using keywords or reliable titles. Consider recognized surveys, foundational work and classic authors. Do not apply a recency filter to a classic paper unless the confirmed intent requires one.
5. 12-15 candidate search angles spanning methods, applications, authors or groups, venues, time periods, upstream/downstream questions, theory, evaluation, and the user's explicit feedback.
6. The 6-8 least-overlapping angles selected from that brainstorm. If two angles are expected to return more than 50% of the same papers, keep only the stronger one.
7. For every selected angle, one PaperHub keyword query of preferably 3-5 terms.
8. Three to five representative natural-language web queries across the selected angles.

For a new plan use `PLAN_CONTRACT=search-plan-current-full`; on resume use the
dispatch's `plan_contract` unchanged.

Each `entity_hypotheses` item records `name`, `type`, `rationale`, and
`confidence`. Each `concept_probes` item records `concept`, `mode` (`title` or
`keyword`), `query`, `rationale`, and nullable `entity`. Each `planned_queries`
item records `angle`, planned `source` (`paperhub` or `web`), `mode` (`keyword`
or `web`), `query`, and `purpose`. Validate the plan:

```bash
scholarseed-skill-python "$SKILL_DIR/scripts/validate_json.py" --contract "$PLAN_CONTRACT" --input "$WORK/plan.json"
```

Do not begin retrieval with a contract-invalid plan.

## Iteration 1: breadth-first, three-path search

Initialize state, pool, query log, and subtopic coverage. Write one `phase: "search"` batch containing the de-duplicated PaperHub queries from Paths A and B, then call `search_round.py` once. The runner owns the PaperHub gate and serial request pacing. Path C remains a separate supplementary path and is executed exactly as described below.

### Path A — PaperHub keyword

- Run every selected angle's keyword query.
- Run the planned landmark/review keyword or title queries.
- Keep queries short and terminology-specific.
- Put these queries in the search batch; ensure at least one real keyword query is available for the runner's network-capability gate.

### Path B — PaperHub concept and title probes

- Run every validated `concept_probes` item with its recorded `title` or
  `keyword` mode; skip this path when both probe and landmark lists are empty.
- Run the landmark/review queries not already covered by an identical mode/query
  pair.
- Put these probes in the same search batch. The runner persists each operation before moving on, so recovered entities and landmarks are available to the first coverage review without separate Agent/tool turns.

### Path C — public web discovery

- Run 3-5 representative natural-language queries through the "Web path" route above (official-api → native → visible-browser).
- The current executor runs that route itself; it does not delegate this path back to the parent Skill host.
- Reconcile scholarly web hits through PaperHub and retain limited scholarly-only records when PaperHub has no match.

Public web search is biased toward freely accessible and highly indexed material. Never use it as the only discovery source. To counter open-access and computer-science bias, add relevant journal or conference names to appropriate queries, especially in medicine, operations research, humanities, and social science, and keep PaperHub as the dominant source.

For PaperHub, `search_round.py` performs the following after every operation. For Web results, the Search Agent continues to perform the same steps directly:

1. Save the full result under `work/results/`.
2. Merge its normalized papers through `tools/pool.py merge`.
3. Log the query and its actual outcome through `tools/state.py log-query`.
4. De-duplicate identical mode/query pairs across landmark, concept-probe, and
   per-angle inventories, and avoid rerunning any normalized query already
   present in `state.json`.

After both PaperHub phases and the unchanged Web path finish, complete the iteration with its raw added-paper count, pool count, and `--valuable-added` count determined from the coverage review.

## Every iteration: abstract coverage review and citation expansion

### 1. Review coverage from abstracts

Inspect the search runner's bounded `evidence_view` (the strongest 15-20 titles and abstracts, or all candidates if fewer exist). Call `pool_inspect.py` only when a materially different concept slice is needed. Coverage decisions must use abstracts rather than titles alone.

- Mark which subtopics are well covered, partially covered, or missing.
- Detect concentration in one subdirection and treat neglected directions as gaps.
- Add newly discovered important subtopics to state when supported by the retrieved metadata.
- For an intentionally broad request, use the first iteration to discover concrete subdirections; do not silently narrow the user's confirmed intent.
- Preserve material uncertainty and missing abstracts as warnings.

### 2. Trace citations every iteration

Choose 3-5 seed papers that are both highly relevant and have pure numeric PaperHub IDs. Put them in one `phase: "citations"` batch. One `search_round.py` call queries references, fetches details for the first 20-30 reference IDs, merges them, and returns a `citation_evidence_view` scoped to newly added citation candidates. Review that bounded view against the original intent.

Citation tracing is specifically intended to recover landmark and field-known papers missed by keyword matching. If PaperHub exposes no actual reference IDs, log the tool warning and continue; never fabricate references or infer IDs from titles.

### 3. Decide whether to stop

After the citation phase, maintain a bounded checklist of the central named entities and user-requested relationships. Mark each as supported by a specific title/abstract, plausible but needing a relation/title-specific probe, or unresolved.

Continue only when a central entity/relationship remains unresolved, or when the latest evidence exposes a high-value named family that could materially change the final set. Do not exhaust tangential concept families merely to make the search look complete.

Stop when any of these conditions is met:

- central coverage is adequate and the latest iteration adds no valuable new direction;
- two consecutive iterations add no valuable papers;
- eight iterations are complete;
- the explicit query or time budget is exhausted.

Record a concrete `stop_reason`. Pool growth alone is not adequate coverage, and raw additions are not equivalent to valuable additions.

### 4. Run targeted follow-up when gaps remain

- Generate queries for uncovered or weak subtopics.
- Change retrieval route when a prior query failed: revise PaperHub keywords, add a materially different short title/concept probe, use public web discovery, or try a venue-specific PaperHub query.
- Recombine terminology from the strongest relevant papers.
- Add a specific disease, domain, population, method, benchmark, or venue when the first iteration was too generic.
- Continue logging, merging, abstract review, citation expansion, and state updates exactly as in iteration 1.

## Select a relevant and diverse set

Assess the complete confirmed intent before ranking or tiering. Select promising
candidates by agent judgment, noting details still needing full-text verification.
Per-criterion proof and exact metadata quotes are optional. Do not add unrelated
papers for diversity or a count target; zero candidates is a valid result.

Before selection, run `pool_inspect.py --provenance-audit` once. Use its bounded best hit for each title probe and bounded citation candidate list to catch a missed named entity or landmark; do not open a new search solely to exhaust secondary families.

1. Assess candidate relevance to the complete intent and user feedback using available sources. A missing detail does not exclude a promising candidate; record it for reading. Known contradictions still exclude a paper.
2. Use `paper_select.py` as the deterministic relevance/diversity baseline, passing `--intent "$RUN_DIR/intent.json"`, `--max-results`, and every ID in `exclude_previous_ids`. The input must be the complete validated intent, not just its text.
3. Review the baseline as a set: start with the most relevant paper, then prefer papers that remain highly relevant while adding a distinct method, subtopic, population, venue, or viewpoint. If two papers are highly redundant, keep the more relevant or influential one.
4. Write `work/selection.json`. Among eligible papers, Tier 1 is the core set (up to about 3-5), Tier 2 is the next broad-but-relevant set (up to about 10-20), and Tier 3 contains remaining comprehensive or indirect additions within the confirmed scope, always bounded by `max_results`. These are tiering targets, never quotas.
5. Every selected record must include the stable ID, Tier 1/2/3, relevance score or null, evidence-based selection reason, and covered subtopics. Write an explicit coverage assessment and warnings.
6. Validate `state.json`, `pool.json`, and `selection.json`. Never return excluded IDs.

Read `SELECTION_CONTRACT.md` for the current request's evidence-bound
eligibility review and persisted decision cache. Use the following baseline command; replace 20 with the request's result budget and append
`--exclude-id "ID"` for each excluded ID:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/paper_select.py" \
  --request "$REQUEST_JSON" --intent "$RUN_DIR/intent.json" --pool "$WORK/pool.json" \
  --output "$WORK/selection.json" --max-results 20
```

This is a candidate baseline, not final approval. Unreviewed candidates cannot
enter finalized metadata, and citations are not a relevance score. Retain the
mode's set-level ranking and tiering among papers that pass the shared gate.

## Finalize

Run:

```bash
scholarseed-skill-python "$SKILL_DIR/modules/search/finalize.py" \
  --input "$REQUEST_JSON" \
  --work-dir "$WORK" \
  --output "$ROUND_DIR/metadata.json" \
  --report-output "$ROUND_DIR/report.md" \
  --run-dir "$RUN_DIR"
```

Validate `metadata.json`. Ensure `report.md` identifies itself as a candidate assessment and reports PaperHub and Search Agent web status; query and candidate counts; the sanitized PaperHub endpoint when available; errors; fallback use; tiers; and coverage gaps. Selection is not full-text verification.

## Required completion response

Return a compact object with `status`, `metadata_path`, `report_path`, `internal_iterations`, `pool_size`, `selected_count`, `stop_reason`, and `warnings`. Do not repeat paper records in the agent response.
