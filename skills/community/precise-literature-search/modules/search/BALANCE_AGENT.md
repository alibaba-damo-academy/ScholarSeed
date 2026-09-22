# Literature Search Agent — Balance

One iteration: entity resolution → PaperHub → citations → screened tiers.
No other mode, user conversation, downloads or full-text claims.

## Context and budget

Run the handoff’s `worker_context_command` directly. Returned commands include
absolute paths and the stage token; no shell exports are needed.

Read intent/criteria and [DECISION_INPUTS.md](DECISION_INPUTS.md). Use
`next_commands[action].command` with `WORK`-relative inputs. Worker generates contracts/hashes.
Plain `context` restores initialization; `--evidence-only` omits it.

CLI control fields stay at the root on success and failure: `status,error,
phase_state,budget,allowed_actions,next_commands,next_action`. `metadata` holds
non-control context; `records` holds intact papers in `record` with `view/kind`
provenance. Follow `next_command` until `next_cursor` is null. The first page has
executable `next_commands`; continuation pages use `{}`. Each paper carries its
own `review_ref`: copy that paper's reference when selecting it. `counts.pool`
is pool size; `counts.view` counts evidence; `page/total` include metadata segments.
Oversized metadata uses typed records or ordered text segments.
Read evidence for every selected paper.
Use current `allowed_actions/next_commands` and `error.recovery_command`.
Each action checks the current budget.

Default 60-minute ceiling; resume keeps start time/policy.
At `should_finalize`, stop discovery and select; runner caps timeouts. Expiry before plan:
select empty with budget warning, no invented queries. Obey context's saved
`max_results` ceiling (new rounds: at most 20); respect smaller user limits.
No count target: return only supported eligible papers, including zero; never pad.

## Pre-plan entities and Web

Resolve hidden entities from domain, rare mechanism/resource, population,
time/version and cross-clause clues. Without new evidence, reuse findings and
uncertainty. Unconfirmed entities must not fill all query angles.

For single-paper identification from a set of clues, prioritize rare clues, keep unconfirmed entities from dominating queries, and distinguish the target from cited papers. Focus on promising candidates without filling tiers or repeating unsupported guesses. As an exception to the Web limits below, allow one targeted follow-up batch within budget to resolve a remaining identity or citation clue.

Explicit central entities: skip Web. Otherwise use one Web batch with 3–4
complementary queries for rare clues, compared families and pivotal titles. One immediate follow-up only if no coherent domain plus four concrete
titles across an unnamed landmark comparison. No routine supplementation,
independent title-reconciliation sweep or post-citation Web.

Run the [DECISION_INPUTS.md](DECISION_INPUTS.md) Web route for each query —
official-api → native → visible-browser when `WEB_SEARCH_INVOKE` is present, else
the executor's native Web tool — then use returned `record-web`, input `web-decisions.json`:
`queries:[{query,papers,elapsed_seconds,status,error?}]`. Record actual timing/status
and raw results with evidenced scholarly metadata; never invent abstracts/IDs. An
official-api `unavailable` (no key) or `empty` result is a fall-through signal, never
a recorded status. Worker counts registered actual calls after execution; it cannot
enforce Web call counts. The batch sizes above are research guidance, not a permission gate.
Replaying saved outcomes is idempotent; classification repairs are not new searches.
Accepted papers merge; pending/rejected records retain reasons without blocking
retrieval or selection of other verified papers. Repair only a record needed for
selection; never empty `papers` to bypass an error. Report failures and evidence gaps.
Reuse resolved names/titles in PaperHub; never repeat completed Web on resume.

## Retrieval decisions

Cover the question's entity × relationship, population, mechanism, dataset,
model/version and project where applicable. Use relationship keywords; add
titles/reviews only with reliable title clues. Never invent or relabel titles.

First phase: **up to 27 distinct operations**, normally five least-overlapping keywords
and ≤22 titles; indispensable sixth keyword allows ≤21 titles.
Use unique keyword angles; remove aliases for known titles, spread early subfamilies.
With reliable title clues, expert synthesis: two reviews; taxonomy/pathway
mechanisms: one consensus/taxonomy title + one cross-pathway review.
Keywords: **≤8 whitespace-separated words**. Use uppercase Boolean operators,
double quotes, `title:(...)`; no semantic mode. “Before YEAR”/“before January YEAR” means
`year_end: YEAR-1`; invent no cutoffs.

Write `retrieval-decisions.json` under `WORK`, use returned `retrieve` command:

- `subtopics`: checklist; `entity_analysis`: concise rationale.
- `entities:[{name,type,rationale,confidence}]`. Types: `disease,project,method,
  standard,dataset,cohort,person,organization,venue,other`; confidence:
  `low,medium,high`. Reference every entity in a query; unresolved ones stay hypotheses.
- `queries:[{mode,query,rationale,entity?,year_start?,year_end?,limit?}]`.
  Nonempty; mode: `keyword|title`. Titles are optional; keyword-only is valid with `entities:[]`.
  Entity names a recorded entity; bounds need evidence. Default limit: keyword 20/title 5.
`concept_probes` is internal, not an input field. DECISION_INPUTS.md has both examples.

Worker saves the immutable batch and returns evidence with paper references.
`execution_blocked`: return an
environment blocker to host; never change endpoints/permissions or print credentials.
Resolved resumable failure: retry `retrieve` **without `--input`**, same deadline;
successes are reused. Never regenerate decisions or advance incomplete search.

## Citations

Plan citations only when returned `budget.retrieval_headroom_seconds` is
**≥75 seconds**; missing/lower: select and note omission. Choose 2–3 strong,
evidenced numeric PaperHub anchors, no automatic substitutes.
Input `citation-decisions.json`: `{"citation_ids":["12345","67890"]}`; replace sample IDs.
Use returned `cite`: limit 30, bounded evidence. <2 credible anchors or no actual
reference IDs: note limitation and select, never fabricate. Retry resumable `cite`
without `--input`, same batch/deadline. Both phases belong to one iteration;
no later Web/PaperHub search.

## Screen and select

Retrieval/citation responses give a compact ranked title index of the pool.
`overview` restores it without a guessed limit. Use `next_command` for more titles
when needed; `counts.pool` is not the number of records on the page.
Use `inspection.command` with `--ids` and up to 20 promising IDs for source evidence
and per-paper review_refs. An index alone is not reviewed abstract evidence.
At most one provenance audit (`context --audit`); use targeted evidence for remaining
uncertainties. Scores are not relevance. No bulk pool reads or secondary searches.

Assess full intent and feedback **before tiers**. Select promising candidates by
agent judgment, explaining relevance and unresolved details for later reading.
Among candidates: Tier 1 contains precise core/originals; Tier 2 contains clear
extensions including canonical benchmark/dataset/model/project/cohort/standard
papers; Tier 3 supplies eligible secondary-subtopic/entity/title/citation recall.
Remove duplicates, cutoff violations and ineligible records. Preserve diversity;
tiers follow relevance, have no size/ratio targets and may be empty.

Use `selection-decisions.json` per `DECISION_INPUTS.md`; criteria/quotes are optional.
Selection is not answer verification. With no useful candidates, show up to 3
related alternatives via
`related_recommendations`, ranked by relevance with explicit unmet/uncertain
criteria. These are not Tier 3 matches. Never invent or pad recommendations; if
none are meaningfully related or the pool is empty, explain why in coverage.

Use visible IDs and their `review_ref`. You judge relevance from available sources;
optional observations need not quote metadata. References work across views. On a review
error, follow the targeted `error.recovery_command`, then copy that paper's current
reference and visible evidence. Never construct references or review hashes.

Returned `select` writes validated selection/state and metadata-derived reports;
include budget/citation/evidence warnings. Only `stage.py complete` transitions/
releases: no separate finalize, iteration increment or release. Return status,
paths, counts, stop reason and limitations, not paper records.
