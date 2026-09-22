# Search module

Transform one immutable round request into contract-compatible `metadata.json`
and its candidate-assessment `report.md`. All download, reading, report,
permission and outer-round review contracts remain shared.

## Mode dispatch

`tools/prepare_search.py` reads the request and existing artifacts, initializes
state, and returns exactly one prompt and plan contract. Read that prompt only.
New tasks support exactly `fast_mock`, `full`, and default `balance`:

- `SEARCH_AGENT.md`: deterministic single-paper quick path.
- `FULL_AGENT.md`: entity/probe planning and adaptive coverage iterations.
- `BALANCE_AGENT.md`: one Balanced retrieval and citation iteration.

All plans use schema 2.0. Read only the selected prompt. Current runs resume their
saved mode, inputs and deadline; other run formats and modes are not supported.

## Common tools and boundaries

`tools/search_round.py` performs PaperHub batches, network capability gating,
normalization and persistence. `tools/balance_search.py` adapts the upstream
Balanced phase/policy/budget to that runner. `tools/pool_inspect.py` provides
bounded evidence and provenance views. `paper_select.py` and `finalize.py`
apply the common intent/identity checks and produce the shared outputs.

For balance with no useful in-scope candidates, `related_recommendations` may hold up to
three closest source-bound alternatives, each with explicit unmet/uncertain
criteria. They remain outside `papers` and tiers, do not count as coverage, and
cannot enter download authorization without a revised-scope eligibility review.

Candidate relevance is assessed by the agent before ranking or tiering. Unknown
details do not block a paper worth reading; criterion proofs and metadata quotes
are optional. Selected papers remain candidates until reading verifies the claims.
Result counts and tier targets never justify ignoring the confirmed intent. Keep full results
on disk, inspect bounded evidence views, and reuse saved evidence-bound
decisions instead of repeating whole-pool reviews. See
`SELECTION_CONTRACT.md` for the shared eligibility and decision-cache contract.

The mode prompt defines query planning and result budgets. No mode may fabricate
records, return excluded IDs, turn metadata into full-text evidence, bypass
intent confirmation or expand access authorization. Missing runtime dependencies
are environment blockers; the runtime does not install packages.
