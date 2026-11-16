# Fallback when PaperHub is unavailable

## Goal

Keep the existing Quick, Balanced and Quality graphs for users with PaperHub access. When credentials are absent or the entire service is unavailable, use the installed `$web-search` Skill for verifiable papers without asking for a token.
Fallback does not change queries, citation expansion, ranking or selection on the credentialed path.

## Previous and current policy

| Condition | Previous behavior | Current behavior |
|---|---|---|
| Missing key | PaperHub operations failed; metadata was unreliable | Skip PaperHub and use Web-only |
| 401/403 | Retrieval failed | Stop PaperHub after the first authentication rejection and fall back |
| All requests fail with transport errors or 500/502/503/504 | Bounded retries, failed round, then failure | Bounded retries, failure event, then Web-only |
| Some PaperHub requests succeed | Keep successful results | Unchanged; no overall fallback |
| Final artifacts | Often no metadata after failure | metadata.json plus fallback_event.json |

429, an individual timeout, malformed responses and business-parameter errors do not currently trigger automatic fallback. Otherwise rate limits or code/configuration faults could be disguised as normal search.
If all permitted web-search providers fail or no papers can be verified, report failure explicitly.

## Count contract

| Mode | Web-only target | Batch limit |
|---|---|---|
| Quick | 20 | Existing batch, plus at most one extra batch when fewer than five papers remain |
| Balanced | 40 | At most two web batches |
| Quality | 40 | At most four gap-driven web batches |

Targets are not guarantees. Candidates need a direct paper URL, DOI or arXiv ID and must pass year filtering/deduplication.
Do not fill shortages with ordinary webpages or low-relevance papers. result_status is complete only when the requested target is reached; otherwise it is partial.

Recorded smoke evidence: four credential-free Quick runs over two repeated queries returned 5–8 papers; two successful 401-fallback runs returned four and six. Credential-free Quality runs over those queries returned 40/40 and 38/40.
These repeated-query samples check the path, candidate funnel and variability, not a stable count distribution or benchmark quality.
Product integration must decide whether to accept variable counts, spend more latency on extra batches, or use a small first page with asynchronous expansion.
Balanced fallback counts and mode-specific quality still need formal benchmarking. These are historical observations, not revalidation by the English translation.

## Failure records

- RESULT_DIR/session/fallback_event.json: written when the runner detects the fault, with error code, planned/executed operations, retries, PaperHub wall time and per-operation failure summaries.
- RESULT_DIR/fallback_event.json: merged before Web-only completion, adding public-query count, received/validated/selected candidate counts, requested target and final status.
- RESULT_DIR/metadata.json: exposes degraded, source_mode, source_status, limitations and fallback_event_file to consumers.

Common key shapes in error text are replaced by [REDACTED]. Events do not record request headers, bearer tokens or environment values.

## Product credential lifecycle

A Codex session inherits SCHOLARSEED_API_KEY at startup. The product should inject credentials at login and replace the relevant session/Worker with a key-free process after logout, so old processes do not retain credentials.
