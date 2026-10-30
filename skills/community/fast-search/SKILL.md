---
name: fast-search
description: Low-latency academic paper discovery for search-bar queries. Infer hidden entities, use one logical batch through the installed web-search skill to resolve likely paper titles, run one bounded PaperHub keyword/title/citation graph, and return up to 20 precision-first papers in metadata.json. Use when a user or product needs the Veryfast paper-search workflow rather than iterative literature research.
description_zh: "面向搜索框式查询的低延迟学术论文发现。推断查询背后的隐含实体，用一次经由已安装 web-search 技能的逻辑批量公网搜索解析出候选论文标题，再跑一次有预算约束的 PaperHub 关键词/标题/引用图，最终在 metadata.json 中返回至多 20 篇精准优先的论文。用于用户或产品需要 Veryfast 极速论文检索场景，而非迭代式文献研究。"
version: "1.2.0"
metadata:
  invocation:
    permission: full-access
---

# Fast Search

Return up to 20 relevant papers in `metadata.json`, aiming for a useful,
well-covered result within the search budget. A short or empty result under a
hard publication window is a last-resort outcome, not the target. This skill exposes exactly one
workflow: Veryfast. It does not perform iterative gap filling or generate a
narrative report.

Never persist a paper abstract. Abstracts may be used transiently inside the
single runner process for relevance scoring, but `metadata.json`, session state,
round traces, plans, caches, and diagnostic artifacts must omit the `abstract`
field and its text. Do not copy an abstract into another field.

## Paths and connectivity

1. `SKILL_DIR` is the absolute directory containing this file. Use absolute
   paths for bundled tools.
2. `WORK_DIR` is the user's current working directory. Write results only under
   `WORK_DIR/fast-search-results/<short-topic>/`; append a timestamp rather
   than overwrite existing results. The one transient structured plan may be a
   hidden sibling under `WORK_DIR`; the runner consumes it after success.
3. PaperHub authentication comes only from `SCHOLARSEED_API_KEY`; configuration is
   loaded by `tools/localconf.py`.
4. Read `SETUP.md` only when configuration is missing or a request fails. If a
   sandbox policy blocks local networking, request narrowly scoped approval.
5. Use PaperHub plus the separately installed `$web-search` skill. Always start
   each logical public-web batch through that skill; do not choose direct
   runtime Web Search in place of an available skill route. The host owns the
   provider route required by that skill: the
   `official` profile (`provider: official-api`) first, the `native` profile
   (`provider: codex-native`) only after a structured unavailable/failed result
   or artifact-publication failure, then the `browser` profile (`provider:
   visible-browser`) only when the runtime permits full access. For official
   and browser, require a delivered `web-search-result.json` artifact, gate on
   `schema: shushen.web_search.v1`, and decide the search outcome from its
   `status`, not the provider process exit code. `completed` and `empty` are
   terminal successes; `unavailable`, `failed`, and `action_required` are not
   successful candidate sets. Treat a nonzero publication command, missing or
   unreadable artifact, schema/query/provider mismatch, or malformed envelope
   as a failed leg. Never infer entities from status logs. A successfully
   completed direct runtime Web Search that occurs despite this priority is an
   acceptable compatibility result and must not be repeated through another
   provider. If a direct runtime call is unavailable or fails, return
   immediately to the `$web-search` official profile within the same turn.
6. Run `tools/doctor.py` once only when readiness is genuinely unknown; add
   `--live` only for a needed network check. Trust its booleans and never print
   environment values.

For Skill-style deployment, explicitly load both `$fast-search` and
`$web-search` into the same turn; do not rely on implicit skill discovery. This
priority, fallback, and result contract applies identically with or without the
App Server Worker.

For a `$web-search` native-profile fallback, require exactly one object between
`<shushen_web_search_results>` and `</shushen_web_search_results>`. Validate the
strict native envelope: `schema` = `shushen.web_search.v1`; `status` =
`completed` or `empty`; `provider` = `codex-native`; `query` exactly matches the
requested query; `candidates` contains at most 20 exact
`{title,url,description}` objects; and `error` is null. If native Web Search
cannot return that envelope, continue to the browser profile. Across all three
providers, consume only the common candidate core. Accept provider extension
keys and do not reject a visible-browser candidate solely because its
`description` is empty; `title` and a direct HTTP(S) `url` are load-bearing.

## User-facing progress

For an interactive Skill invocation, emit only these concise commentary updates
at the existing action boundaries:

1. Before the `$web-search` batch, say that the request is being analyzed
   and key paper entities are being resolved.
2. After web search and before the single runner call, say that candidate
   entities have been resolved and PaperHub retrieval and ranking are starting.
3. After the runner succeeds, use the final response as the completion update;
   include its reported PaperHub runner elapsed time when available, the
   metadata path, and paper count.

Match the language explicitly requested by the user; otherwise match the
language of the user's query. Keep each update to one sentence. Do not expose
reasoning, planned query strings, or raw events. Include elapsed time only when
the host or completed runner already exposes it; never estimate it. Do not add a
clock command, model call, search, wait, or any other action solely to generate
progress. The UI may also show provider tool cards; these short semantic
updates complement those cards without changing the retrieval graph.

## Veryfast workflow

The whole path is defined here; do not inspect tool source/help or configuration
before running it.

### 1. Plan once

Infer hidden named methods, datasets, projects, standards, and likely landmark
titles from the full clue bundle. Make one logical public-web batch with three
complementary queries, even when the surface topic is explicit; its purpose is
to resolve concrete paper titles. Start with three explicit `$web-search`
invocations concurrently when the host supports it, and follow the skill's
official → native → browser route for each query. A successful direct runtime
Web Search may satisfy the same logical batch as a compatibility path:

1. the full rare clue bundle plus `paper`;
2. the central comparison/relationship plus `original study paper`;
3. the rarest mechanism, population, dataset, or method clues plus `paper title`.

For a single-paper lookup, use this same batch to resolve the target instead:
the clean article URL, its DOI/identifier when available, and its canonical
title or article identifier. When the input is an explicit full paper title,
preserve that title in `best_target.title` and the exact-title query, with
`required: true`; use the given title verbatim in the existing web batch too.
Do not substitute a more familiar, similarly titled preprint or journal version.
For URL/DOI inputs, the linked identifier determines the requested version.
A publisher article URL (not just arXiv) names
the paper itself unless the user asks for related work. Remove tracking
parameters such as `utm_*` and fragments, but keep article IDs in query parameters.
DOIs embedded in a URL can be reused; Nature `/articles/<id>` maps to
`10.1038/<id>`. For opaque publisher URLs, resolve the title from web evidence
matching that URL; never guess a DOI from an arbitrary article number.
Do not add web batches or agent-driven page fetches. The runner can verify the
input URL/DOI directly from scholarly metadata in parallel with PaperHub. If
the batch cannot resolve its title, keep `best_target.required: true`, omit its
title, and use the known identifier as a bounded keyword query; never invent a
title or stop solely because web search/PaperHub did not resolve the link.
If the user instead asks for related work around a linked paper, explicitly set
`best_target.required: false`; do not treat the seed as a mandatory answer.

Respect hard publication periods in the existing searches. A cutoff does not
mean "newest papers only": core and founding papers inside the period remain
useful. A soft preference for recency is not a hard cutoff.

Do not repeat successful queries through another provider, open result pages,
or make a second logical web batch. Extract clean scholarly titles from the
batch, then produce 3–6 short English relevance concepts and an ordered
PaperHub plan. Order both keyword and title queries from highest to lowest
expected value; the runner's safety guard keeps the first four keywords and
first eight titles if the plan accidentally exceeds the Veryfast budget:

- for a direct paper lookup (a publisher/arXiv article URL, ID, DOI, or full title),
  first identify the single canonical title from a web candidate that matches
  that identifier or title; do not substitute generic identifier/topic queries
  for this exact-title probe;
- 3–4 complementary keyword queries for the central relationship and compared
  method/evidence families. For an explicitly named method/application request,
  use Boolean clauses to keep that relationship together; PaperHub OR-matches
  an unqualified list of words. Write Boolean operators as uppercase AND/OR/NOT;
  quote multiword method/task phrases and use OR for alternative names, not AND;
- 6–8 exact or near-exact title queries for the most likely core entities and
  founding papers within any hard date window; do not invent titles to fill
  the budget;
- prioritize queries that jointly explain multiple rare clues, but retain bare
  canonical-title queries for central entities;
- interpret publication requirements from the full request, including negation,
  exceptions, and whether recency is mandatory or merely preferred. Translate
  hard bounds into inclusive top-level `date_start` / `date_end` (`YYYY-MM-DD`),
  or `year_start` / `year_end` for whole years. Omit bounds for soft preferences
  or unconstrained requests. The runner validates and executes these fields;
  it does not interpret natural-language dates or repair omitted constraints.
  Before submitting the plan, check that its bounds reflect the user's intent.

Topic and method relevance remain part of semantic query planning and the
existing ranking, not a literal-name eligibility gate. Use the bounded queries
to cover complementary formulations of the same request, including genuine
method aliases where useful, without relaxing the user's hard requirements.

Do not open web pages, use a pool-inspection tool, make another logical web
batch, or run a model-based selection pass.

Use a file-editing tool, not a shell command, to write one JSON plan at
`WORK_DIR/.fast-search-plan-<short-topic>.json`. Do not create `RESULT_DIR`
yourself. Put the full user query and concepts in the plan so no user-controlled
text needs shell quoting:

```json
{
  "query": "FULL_USER_QUERY",
  "inspect_concepts": ["entity", "mechanism", "method", "dataset"],
  "year_end": 2025,
  "queries": [
    {"mode": "keyword", "query": "highest-priority relation"},
    {"mode": "title", "query": "Highest-Priority Paper Title"}
  ]
}
```

Preserve up to four important paper-page/DOI URLs from this same web batch in
`web_papers: [{"title":"CANONICAL_TITLE","url":"EVIDENCE_URL"}]`, prioritizing
the requested paper. Include each title as a planned title query. Use direct
scholarly sources, not news, snippets or guessed URLs; provide no abstract or
claimed bibliographic fields. The runner verifies these records independently
and adds only papers missing from PaperHub to the existing ranking. This is a
bounded metadata lookup, not another model/web-search round. Do not gather extra
URLs or pad this list when the batch lacks useful evidence.

For a direct paper lookup with a resolved title, also set
`"best_target":{"title":"CANONICAL_TITLE","required":true}` and include that
canonical title as a title query. The runner copies the bounded plan into the
result and consumes the external plan only after successful publication; an
invalid or failed run leaves the source plan available for diagnosis without
creating partial paper results.

### 2. Run once

After writing the structured plan, make exactly one shell call containing only
stable file paths:

```bash
scholarseed-skill-python "SKILL_DIR/tools/quick_search.py" \
  --plan "PLAN_FILE" \
  --consume-plan \
  --output-dir "RESULT_DIR"
```

For a direct paper lookup, supply the resolved `best_target`. The runner reserves
the verified target as Tier 1 top-1, even if the topic ranker would place it lower.
The eligible pool includes independently verified external metadata when
PaperHub did not retrieve the paper. A single verified paper is a valid direct
lookup result; do not pad it with unrelated papers. It fails closed only when
neither path verifies an eligible target. Conflicting identifiers are rejected;
if identifiers are missing, an exact match of the web-verified title is allowed.
For an unresolved URL/DOI, the runner may obtain the canonical metadata itself.
External records use explicit non-PaperHub IDs and retain real DOI/URL and
source evidence. Never mix a preprint's PaperHub ID/date with a journal version's
DOI or promise that retrieving metadata also downloads the full text.

Never interpolate credentials. The runner validates and bounds the complete
plan before creating state, runs in a private staging directory, and publishes
paper results only after success. It executes the single serial PaperHub graph,
automatically tracks references from two ranked anchors, and selects papers
using relevance, exact-title match, citation provenance, and diversity. Within
Tier 1 it first promotes a paper whose arXiv ID, DOI, or full title is explicitly
present in the user query, then the agent-declared best target, and otherwise
the highest relevance score. For topic searches, the optional declared best
target never changes tier membership. Only a required single-paper target has
the reservation described above. Remaining candidates retain their
existing order. It writes compact `metadata.json` without abstracts and does
not generate a report. The runner adds server-side date bounds and checks all
keyword/title/citation dates before pooling and anchor selection, without extra
requests. Do not append date clauses yourself. Insufficient date evidence is
excluded; counts are reported in `search_summary.retrieval_date_filter` and
`date_exclusions`. Do not relax dates or pad a shortfall with older papers.
A valid empty result still produces `metadata.json`. If no verified matches were
found, state that this search found none under the stated dates, not that no such
papers exist, and suggest a user-approved reformulation. Do not relax the dates
or silently start more rounds. Report a shortfall as such, not as full coverage.
Report completion only after an actual successful runner tool result supplies
`result.output` and `result.selected_count`; a plan, intended command, or
simulated transcript is not execution evidence. If execution is unavailable or
fails, report that failure instead of inventing a file path or count. On success,
return the runner's path and count without rereading the file or running another
command.

### Failure contract

Do not equate missing `metadata.json` with a successful zero-result search.
If neither a usable locator nor a verified title can be obtained, use the file-editing
tool to write `RESULT_DIR/search_failure.json` containing
`{"schema":"fast_search.failure.v1","error":"fast_search_target_unresolved"}`
and report the problem without inventing a title or running PaperHub.
When the runner cannot find a verified target, it exits nonzero and writes the
same failure file with `error: fast_search_target_not_found`; leave it intact.
Explain that this search could not retrieve/verify the requested paper, not
that the paper does not exist or is definitely not indexed. Suggest a full
title/DOI or trying later. Other execution failures must also be reported as
failures. Never fabricate metadata or repeat the bounded graph to hide failure.

The low-latency target assumes the persistent Worker and its bundled default
model configuration. A direct invocation inside an already-running interactive
Codex session follows the same retrieval graph, but session startup, model, and
reasoning settings can increase latency.

## Follow-ups

Veryfast is a one-shot product response. Do not extend a completed run with
extra search rounds. Start an independent fresh run only when the caller asks
for another search.
