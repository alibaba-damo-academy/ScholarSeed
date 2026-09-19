# Plan and output schemas

Read this reference when writing a batched search plan or the final selection.

## Mode-specific delivery contracts

When PaperHub is unavailable, all modes use `tools/web_fallback.py` instead of
the normal contracts below. The fallback preserves `metadata.json` and paper
field names, adds `search_summary.degraded: true`, `source_mode: "web_only"`,
per-source status and explicit limitations, and may return fewer papers with
`result_status: "partial"`. Web-only papers use an empty `paper_id`, zero for
unavailable citation counts, and an empty `abstract` unless a public scholarly
result actually supplied one. The same output directory contains
`fallback_event.json`, which records PaperHub failure/retry summaries and Web
candidate counts without credentials.

- **Quick:** use `tools/quick_search.py`; one combined plan contains at most
  4 keyword and 8 title queries. The tool automatically tracks citations and
  writes 5–20 papers (20 by default) to `metadata.json`. It omits abstracts and
  never writes a report; pass `--include-abstract` only when abstracts are
  needed. One three-query `$web-search` batch may precede it for hidden entities;
  do not open pages or make a second web call. Do not create `selection.json`.
- **Balanced / Quality:** use the search-plan and model-authored selection
  schemas below, return 38–40 papers when credible candidates exist, and call
  `finalize.py --strict-counts --json-only`. Omit `--json-only` only when the
  user explicitly asks for a narrative report.

## Search plan

Pass a JSON object to `tools/search_round.py --plan`:

```json
{
  "phase": "search",
  "finish_round": false,
  "queries": [
    {
      "mode": "keyword",
      "query": "diffusion AND optimization",
      "limit": 20,
      "year_end": 2025
    },
    {
      "mode": "title",
      "query": "Score Distillation Sampling",
      "limit": 5,
      "year_end": 2025
    }
  ],
  "subtopics": ["guidance", "timestep schedules"],
  "coverage": {}
}
```

Use `mode: keyword` or `mode: title`. Keyword defaults to 20 results and title
to 5. Omit `year_start`/`year_end` when the user gives no cutoff. Set
`ensure_abstract: false` only when metadata without abstracts is still useful.
Include one bare `title` query for every inferred core entity in round 1, in
addition to joint entity/mechanism probes. The 6–8 broad keyword-angle guideline
does not cap title probes: every distinct concept on the clue checklist needs a
focused title or title-restricted probe.

After inspecting the search batch, finish the same logical round with citation
tracking:

```json
{
  "phase": "citations",
  "finish_round": true,
  "queries": [],
  "citation_ids": ["123", "456", "789"],
  "citation_limit": 30,
  "coverage": {
    "guidance": true,
    "timestep schedules": false
  }
}
```

The runner fetches reference IDs and their paper details automatically. Full
responses go under `SESSION/rounds/`; stdout contains only compact summaries.
Pass `--inspect` to append the standard post-merge 20-paper evidence view in the
same tool call; this replaces a separate general pool-inspection call without
changing the pool or ranking. Put optional `inspect_concepts` in the plan when
the round's `subtopics` are too broad for relevance ranking.
For a citation phase, the runner additionally returns
`citation_evidence_view`, a bounded view of papers added by that citation
operation. Inspect it before planning the next round so newly discovered named
projects and landmarks are not hidden by the global pool ranking.

## Final selection

Read `pool.json` through `tools/pool_inspect.py`, then write a compact
`selection.json`. Prefer `paper_id`; use a title for web-only papers:

For known PaperHub IDs or title fragments, use `pool_inspect.py --ids ...` and
repeatable `--title-contains ...` lookups. Do not use `rg`/`sed` over the raw
pool or create a temporary lookup/rendering script. Use `--abstract-chars 0`
when assembling the final selection; inspect only a few uncertain abstracts in
a separate bounded call.

Run one `--provenance-audit --limit 100 --citation-limit 20` inspection before
finalizing. It compactly lists the textually best result for each distinct title
probe plus strong non-duplicate citation candidates, supplying the
canonical-title audit without new retrieval or per-entity tool calls. Do not
also run `--exact-title-probe-hits` or bulk re-lookup the audit papers.

```json
{
  "search_summary": {
    "subtopics": ["guidance", "timestep schedules"],
    "coverage_assessment": "Guidance is well covered; direct ablations remain sparse.",
    "canonical_title_audit": [
      {
        "entity": "diffusion guidance",
        "paper_id": "123",
        "decision": "selected",
        "tier": 2
      }
    ]
  },
  "papers": [
    {
      "paper_id": "123",
      "tier": 1,
      "reason": "Directly isolates the score-guidance objective.",
      "subtopics_covered": ["guidance"]
    },
    {
      "title": "A web-only paper title",
      "year": 2025,
      "url": "https://example.org/paper",
      "source": "web_only",
      "tier": 3,
      "reason": "Recent supporting evidence.",
      "subtopics_covered": ["timestep schedules"]
    }
  ]
}
```

`tools/finalize.py` hydrates PaperHub metadata from the pool, checks duplicate
titles, tiers, and safe year cutoffs, and writes `metadata.json`. Use
`--strict-counts` for the standard 30–40-paper delivery contract and
`--json-only` for the paper-only default. Without `--json-only`, it additionally
writes `report.md`.

When at least 38 credible candidates exist, prefer 38–40 selections with 3–5 in
Tier 1, 15–18 in Tier 2, and the remaining 15–20 in Tier 3. Tier 3 is the recall
layer for fairly likely entity/title/citation/subtopic matches, not a second
precision head; it may be smaller only when the alternatives are obvious noise.

Normalized PaperHub fields in `metadata.json` are `paper_id`, `title`, `authors`,
`year`, `venue`, `journal_name`, `journal_pages`, `journal_volume`, `abstract`,
`citation_count`, `doi`, `arxiv_id`, `is_open_access`, `url`, `publication_date`,
`reference_count`, `influential_citation_count`, `publication_types`, and
`source`. Selection adds `tier`, `reason`, `subtopics_covered`, and `access`;
retrieval may add `found_by`. Missing journal fields are empty strings. Unknown
PaperHub response fields are not passed through automatically.
