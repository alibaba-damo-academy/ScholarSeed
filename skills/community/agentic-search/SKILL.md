---
name: agentic-search
description: Tiered academic paper discovery for quick search-bar lookup, balanced interactive research, or maximum-quality multi-round retrieval. Infer hidden entities, search PaperHub with keyword/title/citation paths, optionally use public web evidence, and return a precision-first tiered metadata set. Use for natural-language research needs that ask to find relevant papers, including requests with a time budget or speed/quality preference.
version: "1.1.0"
---

# Agentic Literature Search

Return relevant papers in `metadata.json`. Do not generate a narrative report
unless the user explicitly asks for one.

## Select one mode

An explicit user mode wins. Otherwise infer from `time_budget_minutes`; with
neither, use Quality.

| Mode | Product target | Time target | Papers | Execution graph |
|---|---|---:|---:|---|
| Quick | search bar | <1 minute | up to 20 | at most one web batch + one runner call + deterministic ranking |
| Balanced | interactive research | 5–6 minutes | 38–40 | compact entity resolution + one logical round |
| Quality | maximum quality | unbounded | 38–40 | C1 provenance-recovery multi-round search |

Continuous budgets map as follows: `B <= 2` → Quick, `2 < B <= 6` → Balanced,
and `B > 6` → deadline-bounded Quality. Named Quick and Balanced default to one
and six minutes. State and search tools enforce the selected policy.

Quick uses a deliberately different execution graph: truncating the Quality
graph at 60 seconds does not leave enough time to select results. When Quick is
selected, follow only the Quick workflow below and stop. When Balanced is
selected, read [references/balanced-quality-workflow.md](references/balanced-quality-workflow.md)
completely. When Quality is selected, read
[references/c1-quality-workflow.md](references/c1-quality-workflow.md)
completely and follow its C1 coverage and stopping rules instead of the
Balanced graph.

## Paths and connectivity

1. `SKILL_DIR` is the absolute directory containing this file. Use absolute
   paths for bundled tools.
2. `WORK_DIR` is the user's current working directory. Write only under
   `WORK_DIR/agentic-search-results/<short-topic>/`; append a timestamp rather
   than overwrite existing results.
3. Treat PaperHub as an optional enhanced source. Authentication comes only
   from `SCHOLARSEED_API_KEY`; configuration is loaded by `tools/localconf.py`.
4. Read `SETUP.md` only when non-authentication configuration is invalid or a
   permitted network request fails. Never ask the user to provide a PaperHub or
   platform token when the credential is absent or rejected.
5. Route every public-web lookup through the separately installed `$web-search`
   skill; never call the runtime Web Search tool directly from this skill. The
   host owns the provider route required by that skill: the `official` profile
   (`provider: official-api`) first, the `native` profile (`provider:
   codex-native`) only after a structured unavailable/failed result or artifact
   publication failure, then the `browser` profile (`provider:
   visible-browser`) only when the runtime permits full access. For official
   and browser, require a delivered `web-search-result.json` artifact, gate on
   `schema: scholarseed.web_search.v1`, and decide the search outcome from its
   `status`, not the provider process exit code. `completed` and `empty` are
   terminal successes; `unavailable`, `failed`, and `action_required` are not
   successful candidate sets. Treat a nonzero publication command, missing or
   unreadable artifact, schema/query/provider mismatch, or malformed envelope
   as a failed leg. Never infer entities from status logs.
   Use PaperHub plus `$web-search` when
   PaperHub is available; otherwise use the Web-only fallback below. Do not call Brave merely
   because `BRAVE_API_KEY` exists. Use Brave only when the user explicitly opts
   in, or when both primary paths are unavailable and the user accepts a
   fallback search provider.
6. Run `tools/doctor.py` once only when readiness is genuinely unknown; add
   `--live` only for a needed network check. Trust its booleans and never print
   environment values.

For a `$web-search` native-profile fallback, require exactly one object between
`<scholarseed_web_search_results>` and `</scholarseed_web_search_results>`. Validate the
strict native envelope: `schema` = `scholarseed.web_search.v1`; `status` =
`completed` or `empty`; `provider` = `codex-native`; `query` exactly matches the
requested query; `candidates` contains at most 20 exact
`{title,url,description}` objects; and `error` is null. If native Web Search
cannot return that envelope, continue to the browser profile. Across all three
providers, consume only the common candidate core. Accept provider extension
keys and do not reject a visible-browser candidate solely because its
`description` is empty; `title` and a direct HTTP(S) `url` are load-bearing.

## PaperHub-unavailable fallback

Do not add a credential-preflight tool call. Follow the selected mode normally
unless the host explicitly states that PaperHub is unavailable. If
`quick_search.py` or `search_round.py` returns `fallback_required` with
`PAPERHUB_AUTH_MISSING`, `PAPERHUB_HTTP_401`, `PAPERHUB_HTTP_403`, or an
exhausted source-level transport error, switch to public-web retrieval:

1. Do not retry PaperHub, perform PaperHub citation tracking, open setup
   instructions, or ask the user for a token.
2. Reuse any `$web-search` results already obtained. Quick permits its existing
   batch plus one additional batch of at most three queries only when fewer than
   five verifiable papers remain. Balanced permits at most two total web
   batches. Unbudgeted Quality may perform gap-driven web batches until central
   coverage is adequate, two batches add no valuable candidates, or four total
   batches complete. Respect an explicit deadline.
3. Keep only actual papers with a direct paper URL, DOI, or arXiv ID. Never
   convert a project page, repository, blog, or search-results page into a paper.
   Supply `abstract` only when a public result actually exposes it; do not
   relabel a generic search snippet as an abstract.
4. Order credible candidates by relevance and call the deterministic fallback
   finalizer exactly once, using the selected mode. Never write or edit
   `metadata.json` or `fallback_event.json` directly:

```bash
scholarseed-skill-python "SKILL_DIR/tools/web_fallback.py" \
  --query "FULL_USER_QUERY" --mode "quick|balanced|quality" \
  --paperhub-error-code "ERROR_CODE_FROM_RUNNER" \
  --output-dir "RESULT_DIR" <<'JSON'
{"search_queries":["..."],"papers":[{"title":"...","url":"...","year":2024,"doi":"","arxiv_id":"","authors":[],"venue":"","abstract":"","reason":"...","subtopics_covered":[]}]}
JSON
```

The finalizer marks any result below the requested count as
`result_status: partial` and writes a credential-free `fallback_event.json`
with the source error and fallback counts; never pad with noise. If `$web-search` is also
unavailable or yields no verifiable paper, stop with a clear capability error
instead of creating a successful empty artifact. On success, disclose that the
result used public-web fallback and lacks PaperHub metadata and citation
expansion. Do not treat an empty but otherwise successful PaperHub query as a
source outage.

## Quick workflow

The whole Quick path is defined here; do not inspect the output schema, other
references, tool source/help, or configuration before running it.

### 1. Plan once

Infer hidden named methods, datasets, projects, standards, and likely landmark
titles from the full clue bundle. Make one logical `$web-search` batch with
three complementary queries, even when the surface topic is explicit; its
purpose is to resolve concrete paper titles. Run the three explicit skill
invocations concurrently when the host supports it, and follow the skill's
`official-api` → `codex-native` → `visible-browser` route for each query:

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

Do not call the runtime Web Search tool directly, call Brave, open web pages,
use a pool-inspection tool, or run a
model-based selection pass. Do not create a result directory or plan file
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

Use normal shell argument quoting; never interpolate credentials. The runner
creates the directory and trace plan, initializes Quick state, executes the
single serial PaperHub graph, automatically tracks references from two ranked
anchors, and selects papers using relevance, exact-title match, citation
provenance, and diversity. It writes compact `metadata.json` without abstracts
or a report. Add `--include-abstract` only when the caller explicitly needs
abstracts. On success, return the metadata path and paper count without rereading
the file or running another command.

If the runner returns `fallback_required`, it has not succeeded and has not
written `metadata.json`; execute only the conditional fallback above. This is
the sole exception to the one-shell-call Quick path.

The <1 minute target assumes Codex was started with the
`agentic-search-quick` profile. A skill cannot change an already-running
session's model; a slower or high-reasoning session may exceed the SLO even
though the Quick graph is followed.

## Follow-ups

For follow-up requests, preserve the existing pool and query history. Quick is
a one-shot product response; use Balanced or Quality when the user wants gap
filling or iterative refinement. Never restart a completed search unless the
user requests an independent fresh run.
