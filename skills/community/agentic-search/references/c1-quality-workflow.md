# C1 maximum-quality workflow

Use this workflow only for Quality mode. It restores the high-recall C1
execution graph: model-resolved hidden entities, complete short-title coverage,
model-selected citation expansion in every logical round, gap-driven follow-up,
and one compact provenance audit before selection. It is paper-only by default
and writes `metadata.json`; generate `report.md` only when explicitly requested.

All PaperHub search, reverse-lookup, citation, and inspection instructions below
apply only while PaperHub is available. If a runner returns
`fallback_required`, stop this workflow immediately and follow the
PaperHub-unavailable fallback in `SKILL.md`; do not ask the user for a token.

## Quality contract

- Do not shorten an unbudgeted Quality run to improve latency. A large raw pool
  or enough papers to fill 40 output slots does not by itself establish
  coverage.
- Infer hidden diseases, projects, cohorts, standards and versions, methods,
  datasets, authors, landmark titles, and comparison families. Preserve the
  relationships across clauses rather than resolving clues independently.
- Maintain an entity checklist containing the domain anchor, entity type, rare
  mechanism or exposure, data/resource type, population, time/version, and the
  relationship the query asks about. Resolve an entity only when one coherent
  interpretation explains its distinctive clues together.
- For every central entity, issue both a bare canonical-title probe and any
  high-information `entity × mechanism/relation` probe needed to test the clue
  bundle. Do not let a popular generic entity substitute for a rarer named one.
- Give every distinct noun-like method, dataset, project/cohort, standard,
  mechanism, structure, evaluation metric, and landmark family a short title or
  title-restricted probe. Treat this as semantic coverage, not a query-count
  target.
- Preserve founding reviews, original method/standard papers, and one valid
  canonical-title sentinel for each confirmed core entity. A narrower
  application paper does not replace its sentinel.
- Inspect abstracts before judging coverage. Preserve Tier 3 as a deliberate
  recall layer rather than filling it only with the highest-level generic
  papers.

## Initialize and plan

Initialize persistent Quality state unless the caller already did so:

```bash
scholarseed-skill-python "SKILL_DIR/tools/state.py" init \
  --dir "RESULT_DIR/session" --query "FULL_USER_QUERY" --mode quality
```

Respect exclusive publication cutoffs: "before YEAR" and "before January YEAR"
use `year_end: YEAR-1`.

Before the first PaperHub plan, use one logical `$web-search` batch when a central
entity or landmark family is described but not named. Use 3–4 complementary
queries that preserve the rare clue bundle, separately cover the compared
families, and seek original or pivotal paper titles. If the first batch does
not yield one coherent domain plus concrete titles across the central
comparison, make one immediate refined web batch. Later `$web-search` batches are
allowed only for a concrete unresolved entity or coverage gap; do not impose a
two-call cap on an unbudgeted Quality run.

Build 12–15 candidate search angles, then retain 6–8 least-overlapping keyword
queries. Add every required short canonical or exact-title probe separately;
the 6–8 range is not a cap on title probes. Write the first plan using
[output-schema.md](output-schema.md).

## Execute complete logical rounds

Each logical round has a search phase and a citation phase. Run the search
phase with `finish_round: false`:

```bash
scholarseed-skill-python "SKILL_DIR/tools/search_round.py" \
  --plan "RESULT_DIR/roundN_search.json" \
  --session "RESULT_DIR/session" --workers 1 --inspect
```

Use the returned bounded evidence view and abstracts to select 3–5 strong,
semantically distinct PaperHub anchors. Then run citation tracking with
`finish_round: true`:

```bash
scholarseed-skill-python "SKILL_DIR/tools/search_round.py" \
  --plan "RESULT_DIR/roundN_citations.json" \
  --session "RESULT_DIR/session" --workers 1 --inspect
```

Do not replace model-selected anchors with automatic popularity ranking. Read
the bounded `citation_evidence_view`; backend order is not evidence of
relevance. Use one worker for direct or tunneled PaperHub unless repeated live
tests have established safe concurrency.

After every citation phase, explicitly mark each entity–relationship item as:

- resolved by a concrete title and abstract;
- plausible but needing a named-title or relation-specific probe; or
- unresolved.

Carry newly discovered project names, canonical phrases, datasets, mechanisms,
and paper families into the next plan. Later rounds must be gap-driven: change
query form, shorten a failed query, use `title:(...)`, add the resolved entity,
or try singular/plural variants. A project found through citation tracking must
receive its own title or keyword probe before it is considered resolved.

Do not finalize merely because the pool is large. After each logical round,
judge whether the *central* entity and relationship checklist is adequately
covered by concrete titles and abstracts. Run another gap-driven round when a
central item remains unresolved or the latest evidence reveals a high-value
named family that could change the final set. Stop when central coverage is
adequate and the latest round adds no valuable new direction, when two rounds
add no valuable candidates, at eight completed rounds, or when an explicit
deadline enters its finalization reserve. Do not chase every tangential family
or require exhaustive coverage of secondary concepts before stopping.

## Evidence inspection and web-only records

Reuse each search runner's evidence views. For a different concept slice or a
small set of uncertain known candidates, use structured inspection:

```bash
scholarseed-skill-python "SKILL_DIR/tools/pool_inspect.py" \
  --session "RESULT_DIR/session" \
  --concepts "entity,mechanism,method" --limit 20
```

Use repeatable `--title-contains` or `--ids` with `--abstract-chars 0` for
already assessed candidates. Never scan `pool.json` with ad-hoc text tools.

For a paper discovered through `$web-search`, reverse-query its clean title through
PaperHub. On a miss, add one compact `web_only` record with title, URL/DOI/arXiv
ID, year, and provenance through a single `state.py add-papers` call. PaperHub
remains the structured primary source.

## Provenance recovery and final selection

Before selection, run exactly one compact provenance audit:

```bash
scholarseed-skill-python "SKILL_DIR/tools/pool_inspect.py" \
  --session "RESULT_DIR/session" --provenance-audit \
  --limit 100 --citation-limit 20
```

The audit returns the best result for every distinct title probe, tolerant of
articles, punctuation, prepositions, and subtitles, plus strong nonduplicate
citation candidates. `match_score` is textual evidence, not relevance by
itself. Reuse its IDs; do not also run an exact-title audit or bulk re-lookup all
audit papers.

Select 38–40 credible papers when available: Tier 1 has 3–5 precise core papers,
Tier 2 has 15–18 clear extensions, and Tier 3 normally retains 15–20 plausible
resolved-entity, distinctive-title, citation, and secondary-subtopic papers.
Remove duplicates, dominated near-duplicates, cutoff violations, and obvious
noise only. Record canonical sentinels or concrete exclusion reasons in
`search_summary.canonical_title_audit`.

Write compact choices to `selection.json` using the final-selection schema in
[output-schema.md](output-schema.md), then hydrate and validate:

```bash
scholarseed-skill-python "SKILL_DIR/tools/finalize.py" \
  --session "RESULT_DIR/session" \
  --selection "RESULT_DIR/selection.json" \
  --output-dir "RESULT_DIR" --strict-counts --json-only
```

Omit `--json-only` only when a narrative report was explicitly requested. After
successful strict finalization, stop without rereading outputs or rerunning
diagnostics.
