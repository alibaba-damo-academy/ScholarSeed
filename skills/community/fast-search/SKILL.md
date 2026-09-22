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

Return 5–20 relevant papers in `metadata.json`. This skill exposes exactly one
workflow: Veryfast. It does not perform iterative gap filling or generate a
narrative report.

Never persist a paper abstract. Abstracts may be used transiently inside the
single runner process for relevance scoring, but `metadata.json`, session state,
round traces, plans, caches, and diagnostic artifacts must omit the `abstract`
field and its text. Do not copy an abstract into another field.

## Paths and connectivity

1. `SKILL_DIR` is the absolute directory containing this file. Use absolute
   paths for bundled tools.
2. `WORK_DIR` is the user's current working directory. Write only under
   `WORK_DIR/fast-search-results/<short-topic>/`; append a timestamp rather
   than overwrite existing results.
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

Do not repeat successful queries through another provider, open result pages,
or make a second logical web batch. Extract clean scholarly
titles from the batch, then produce 3–6 short English relevance concepts and at
most 12 PaperHub queries:

- for a direct paper lookup (an arXiv URL/ID, DOI, or clearly named full title),
  first identify the single canonical title from a web candidate that matches
  that identifier or title; do not substitute generic identifier/topic queries
  for this exact-title probe;
- 3–4 complementary keyword queries for the central relationship and compared
  method/evidence families;
- 6–8 exact or near-exact title queries for the most likely core entities and
  founding papers;
- prioritize queries that jointly explain multiple rare clues, but retain bare
  canonical-title queries for central entities;
- for “before YEAR” or “before January YEAR”, set `--year-end YEAR-1`.

Do not open web pages, use a pool-inspection tool, make another logical web batch, or
run a model-based selection pass. Do not create a result directory or plan file
yourself.

### 2. Run once

Make exactly one shell call. Repeat `--keyword` and `--title` flags for the
planned queries:

```bash
scholarseed-skill-python "SKILL_DIR/tools/quick_search.py" \
  --query "FULL_USER_QUERY" \
  --concepts "entity,mechanism,method,dataset" \
  --keyword "central relation query" \
  --keyword "comparison family query" \
  --title "Likely Foundational Paper Title" \
  --title "Canonical Method or Dataset" \
  --year-end 2025 \
  --output-dir "RESULT_DIR"
```

For a direct paper lookup, the same one runner call must additionally include
`--best-title "CANONICAL_TITLE" --require-best-target`, and the canonical title
must also appear as a `--title` query (the runner inserts it first if omitted).
The runner refuses an arXiv/DOI lookup without a resolved best title. It also
fails closed instead of returning a plausible but wrong list when that target
is absent from the PaperHub pool or does not enter Tier 1. Do not run the
PaperHub call until the canonical title is known.

Use normal shell argument quoting; never interpolate credentials. The runner
creates the directory and trace plan, initializes internal state, executes the
single serial PaperHub graph, automatically tracks references from two ranked
anchors, and selects papers using relevance, exact-title match, citation
provenance, and diversity. Within Tier 1 it first promotes a paper whose arXiv
ID, DOI, or full title is explicitly present in the user query, then an
agent-declared `--best-title`, and otherwise the highest relevance score. The
declared target never promotes a Tier 2/3 paper or changes tier membership.
Remaining Tier 1 members retain their existing order. It writes compact
`metadata.json` without abstracts and does not generate a report. On success,
return the metadata path and paper count without rereading the file or running
another command.

The low-latency target assumes the persistent Worker and its bundled default
model configuration. A direct invocation inside an already-running interactive
Codex session follows the same retrieval graph, but session startup, model, and
reasoning settings can increase latency.

## Follow-ups

Veryfast is a one-shot product response. Do not extend a completed run with
extra search rounds. Start an independent fresh run only when the caller asks
for another search.
