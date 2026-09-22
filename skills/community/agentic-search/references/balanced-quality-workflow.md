# Balanced and Quality workflow

Read this reference only after selecting Balanced or Quality mode. Both are
paper-only by default and write `metadata.json`; generate `report.md` only when
the user explicitly asks for a narrative report.

All PaperHub search, reverse-lookup, citation, and inspection instructions below
apply only while PaperHub is available. If a runner returns
`fallback_required`, stop this workflow immediately and follow the
PaperHub-unavailable fallback in `SKILL.md`; do not ask the user for a token.

## Shared quality contract

- Resolve hidden diseases, projects/cohorts, standards/versions, methods,
  datasets, authors, and landmark titles. Preserve relationships across clauses.
- For each suspected entity, track domain anchor, entity type, rare mechanism
  or exposure, data/resource type, population, and time/version. A candidate is
  resolved only when one coherent interpretation explains the distinctive clues.
- Probe every central entity with a bare canonical-title query and with any
  high-information entity × mechanism/relation query needed by the request.
- Retain founding reviews and original method/standard papers. Preserve a
  cutoff-valid exact-title entity sentinel when it is genuinely on-topic.
- PaperHub `keyword` uses Elasticsearch query-string syntax: uppercase Boolean
  operators, quoted phrases, and `title:(...)` where precision is needed. Split
  long queries into focused probes. Do not use unsupported semantic mode.
- Respect publication cutoffs. “Before YEAR” and “before January YEAR” both use
  `year_end: YEAR-1`.
- Prefer 38–40 credible papers: Tier 1 has 3–5 precise core papers, Tier 2 has
  15–18 clear extensions, and Tier 3 is a deliberate recall layer. Return fewer
  only when filling the target would add obvious noise.

## Initialize

```bash
scholarseed-skill-python "SKILL_DIR/tools/state.py" init \
  --dir "RESULT_DIR/session" --query "FULL_USER_QUERY" --mode MODE
```

Use `--mode balanced` or `--mode quality`. When the user supplied a continuous
budget, omit `--mode` and use `--time-budget-minutes B`; the policy resolver
selects the graph. Unbudgeted Quality is the default.

## Balanced: 5–6 minute graph

Use one compact logical round. Before PaperHub, make one logical `$web-search`
batch only when a central named entity or landmark paper family is described
but not named. Run 3–4 complementary explicit skill invocations, using each
invocation's `official-api` → `codex-native` → `visible-browser` route and the
`scholarseed.web_search.v1` consumer rules in `SKILL.md`. Preserve the rare clue bundle,
separately probe compared families, and seek original or pivotal titles. Skip
web when core entities and central paper families are
already explicit. Allow one immediate follow-up web batch only if the first
batch fails to establish a coherent domain plus at least four concrete titles
across an unnamed landmark comparison.

Build an entity × relationship checklist covering assessment/evaluation,
population/prevalence, mechanism/biomarker, dataset/benchmark, model/version,
and project/cohort where applicable. Convert resolved names and titles directly
to PaperHub title queries. For each central method/mechanism/intervention family,
retain 1–2 representative original or pivotal titles.

The first PaperHub search phase permits at most 27 operations: normally five
least-overlapping keyword queries and up to 22 prioritized exact-title queries.
If a sixth keyword angle is indispensable, use at most 21 title queries. Remove
aliases when a full title is known. Distribute landmark slots across distinct
early subfamilies. When expert synthesis is foregrounded, reserve two title
slots for reviews; for a mechanism embedded in a taxonomy/pathway network,
reserve one consensus/taxonomy title and one cross-pathway review.

Write the search plan using [output-schema.md](output-schema.md). Keep search
and citation as two phases of one logical round: search uses
`finish_round: false`; citation uses `finish_round: true` with 2–3 strong,
model-selected PaperHub anchors. Run:

```bash
scholarseed-skill-python "SKILL_DIR/tools/search_round.py" \
  --plan "RESULT_DIR/round1_search.json" \
  --session "RESULT_DIR/session" --workers 1 --inspect
```

After search, read the returned top-level
`budget.retrieval_headroom_seconds`. Start citation planning only at 75 seconds
or more; otherwise finalize from the current pool. If the budget object is not
visible, skip citation instead of spending time rediscovering it. After citation,
do not run another web or PaperHub search. Reuse evidence views; perform at most
one provenance audit, one zero-abstract ranked view of at most 45 candidates,
and one targeted lookup of at most ten genuinely uncertain IDs/titles.

Place central original methods in Tier 1. Keep query-mentioned or descriptively
hidden canonical benchmark/dataset/model/project/cohort/standard papers at
least in Tier 2. Finalize immediately inside the protected reserve.

## Quality: adaptive graph

Plan 6–8 least-overlapping keyword angles plus all required short title probes;
the keyword range is not a cap on title queries. Run the same two-phase search
and citation flow, tracking 3–5 model-selected anchors per logical round. Do not
use automatic anchor selection in Quality: prior bench8 C2 experiments reduced
both recall and speed versus model-selected anchors.

Use the installed `$web-search` skill selectively for unresolved named entities
or concrete coverage gaps, batching related queries in one logical skill batch.
A web-discovered
paper title must be reverse-looked-up through PaperHub. On a miss, add a compact
`web_only` record with title, URL/DOI/arXiv ID, year, and provenance via one
`state.py add-papers` call. PaperHub remains the structured main path.

After every citation phase, reassess the entity checklist from titles, abstracts,
and the citation-scoped evidence view. A newly discovered named project or
canonical phrase receives its own title/keyword query in the next round. Later
rounds must be gap-driven and change query form when a prior attempt failed.
Stop when coverage is adequate, two rounds add no valuable candidates, eight
rounds complete, or the deadline enters the finalization reserve.

## Evidence inspection

Use the search runner's bounded evidence view normally. For different concepts:

```bash
scholarseed-skill-python "SKILL_DIR/tools/pool_inspect.py" \
  --session "RESULT_DIR/session" --concepts "entity,mechanism,method" --limit 20
```

Use structured `--ids` / repeatable `--title-contains` lookups, never `rg` or
ad-hoc scripts over `pool.json`. Use `--abstract-chars 0` for already-assessed
candidates. Before final selection, run exactly one compact provenance audit:

```bash
scholarseed-skill-python "SKILL_DIR/tools/pool_inspect.py" \
  --session "RESULT_DIR/session" --provenance-audit \
  --limit 100 --citation-limit 20
```

The audit returns the best result per title probe plus strong nonduplicate
citation candidates. `match_score` is textual evidence, not relevance by itself.
Reuse its paper IDs and do not also run an exact-title audit or bulk re-lookup.

## Select and finalize

Select papers as a set, rewarding relevance and subtopic diversity. Concentrate
landmarks in Tier 1/2; preserve fairly likely resolved-entity, title-probe,
citation, and secondary-subtopic candidates in Tier 3. Remove duplicates,
dominated near-duplicates, cutoff violations, and obvious noise only.

Write compact model choices to `selection.json` using the final-selection schema
in [output-schema.md](output-schema.md), then hydrate and validate deterministically:

```bash
scholarseed-skill-python "SKILL_DIR/tools/finalize.py" \
  --session "RESULT_DIR/session" \
  --selection "RESULT_DIR/selection.json" \
  --output-dir "RESULT_DIR" --strict-counts --json-only
```

Omit `--json-only` only when a report was explicitly requested. After successful
strict finalization, trust the returned paths and counts; do not reread outputs,
recompute counts, or rerun network/cache diagnostics.
