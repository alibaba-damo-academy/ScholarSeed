---
name: fast-search
description: Low-latency academic paper discovery for search-bar queries. Infer hidden entities, use one batched Codex web search to resolve likely paper titles, run one bounded PaperHub keyword/title/citation graph, and return up to 20 precision-first papers in metadata.json. Use when a user or product needs the Veryfast paper-search workflow rather than iterative literature research.
description_zh: "面向搜索框式查询的低延迟学术论文发现。推断查询背后的隐含实体，用一次批量的 Codex 网页搜索解析出候选论文标题，再跑一次有预算约束的 PaperHub 关键词/标题/引用图，最终在 metadata.json 中返回至多 20 篇精准优先的论文。用于用户或产品需要 Veryfast 极速论文检索场景，而非迭代式文献研究。"
version: "1.0.0"
metadata:
  invocation:
    permission: full-access
---

# Veryfast Academic Search

Return 5–20 relevant papers in `metadata.json`. This skill exposes exactly one
workflow: Veryfast. It does not perform iterative gap filling or generate a
narrative report.

## Paths and connectivity

1. `SKILL_DIR` is the absolute directory containing this file. Use absolute
   paths for bundled tools.
2. `WORK_DIR` is the user's current working directory. Write only under
   `WORK_DIR/agentic-search-results/<short-topic>/`; append a timestamp rather
   than overwrite existing results.
3. PaperHub authentication comes only from `SCHOLARSEED_API_KEY`; configuration is
   loaded by `tools/localconf.py`.
4. Read `SETUP.md` only when configuration is missing or a request fails. If a
   sandbox policy blocks local networking, request narrowly scoped approval.
5. Use PaperHub plus Codex web search. Do not call any other search provider.
6. Run `tools/doctor.py` once only when readiness is genuinely unknown; add
   `--live` only for a needed network check. Trust its booleans and never print
   environment values.

## User-facing progress

For an interactive Skill invocation, emit only these concise commentary updates
at the existing action boundaries:

1. Before the native web-search call, say that the request is being analyzed
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
progress. The Codex UI may also show native tool cards; these short semantic
updates complement those cards without changing the retrieval graph.

## Veryfast workflow

The whole path is defined here; do not inspect tool source/help or configuration
before running it.

### 1. Plan once

Infer hidden named methods, datasets, projects, standards, and likely landmark
titles from the full clue bundle. Make exactly one native web-search tool call
whose `search_query` array contains three complementary queries, even when the
surface topic is explicit; its purpose is to resolve concrete paper titles:

1. the full rare clue bundle plus `paper`;
2. the central comparison/relationship plus `original study paper`;
3. the rarest mechanism, population, dataset, or method clues plus `paper title`.

Do not open result pages or make a second web call. Extract clean scholarly
titles from the batch, then produce 3–6 short English relevance concepts and at
most 12 PaperHub queries:

- 3–4 complementary keyword queries for the central relationship and compared
  method/evidence families;
- 6–8 exact or near-exact title queries for the most likely core entities and
  founding papers;
- prioritize queries that jointly explain multiple rare clues, but retain bare
  canonical-title queries for central entities;
- for “before YEAR” or “before January YEAR”, set `--year-end YEAR-1`.

Do not open web pages, use a pool-inspection tool, make another search call, or
run a model-based selection pass. Do not create a result directory or plan file
yourself.

### 2. Run once

Make exactly one shell call. Repeat `--keyword` and `--title` flags for the
planned queries:

```bash
python3 "SKILL_DIR/tools/quick_search.py" \
  --query "FULL_USER_QUERY" \
  --concepts "entity,mechanism,method,dataset" \
  --keyword "central relation query" \
  --keyword "comparison family query" \
  --title "Likely Foundational Paper Title" \
  --title "Canonical Method or Dataset" \
  --year-end 2025 \
  --output-dir "RESULT_DIR"
```

Use normal shell argument quoting; never interpolate credentials. The runner
creates the directory and trace plan, initializes internal state, executes the
single serial PaperHub graph, automatically tracks references from two ranked
anchors, and selects papers using relevance, exact-title match, citation
provenance, and diversity. It writes compact `metadata.json` with an `abstract`
field for every paper and does not generate a report. When PaperHub has no
abstract for an individual record, preserve that field as an empty string. On
success, return the metadata path and paper count without rereading the file or
running another command.

The low-latency target assumes the persistent Worker and its bundled default
model configuration. A direct invocation inside an already-running interactive
Codex session follows the same retrieval graph, but session startup, model, and
reasoning settings can increase latency.

## Follow-ups

Veryfast is a one-shot product response. Do not extend a completed run with
extra search rounds. Start an independent fresh run only when the caller asks
for another search.
