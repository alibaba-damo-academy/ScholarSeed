# PaperHub and web-search migration observations (2026-09-17)

This is a historical migration record, not a statement that these probes were repeated for the current release. Active routing and authorization follow SKILL.md and the installed web-search contract.

## Recorded findings

- The new base https://scholarseed.damo.alibaba.com/paperhub used /papersearch/ for keyword, title, references and papers operations; all four probes passed.
- On 2026-09-18, direct HTTP and HTTPS POST probes both returned 200. The product contract nevertheless requires HTTPS. Runtime upgrades explicit HTTP settings for the official ScholarSeed host, without rewriting localhost tunnels or custom internal endpoints.
- DNS resolved the new host to 218.244.153.133 and 47.111.16.134, not the old 120.26.184.97 address. Fixed probes returned identical paper-ID order, citation graphs and details. Shared rate-limit behavior suggested a common service/data/rate-limit layer; DNS alone did not establish identical network addresses.
- After cooldown, fair concurrent samples succeeded 8/8 for both endpoints at workers=4 and workers=8. New/old wall times were 0.7233/0.6429 seconds at four workers and 0.5125/0.4001 at eight. About 0.1 seconds was not a meaningful end-to-end regression.
- Do not increase concurrency merely because the endpoint migrated. In consecutive uncooled 16-request tests, 429s followed whichever endpoint ran second, including after reversing order, consistent with a shared short-term limit.
- All 21 web-search unit tests passed in that run. An official-api probe returned HTTP 200 and ten candidates in 1.518 seconds; codex-native actually invoked hosted Web Search.
- Plain local Codex lacked the product service.cli.bridge artifact publisher. Even when official-api search succeeded, publication failed and the Invocation fell back to codex-native. The product environment must supply the actual bridge. The official module indirectly imports Playwright, so its Python dependency belongs in deployment; browser binaries are needed only when the browser profile is used.

## Updated return-contract integration

The updated web-search/CONTRACT.md was exercised with provider probes and a branch-bound Quick run:

- One official probe returned HTTP 200, eight candidates, status completed, provider official-api, error null and 1.961-second search time. Exit 1 came from missing local service.cli.bridge at publication, matching the distinction between search outcome and publication exit status.
- The branch-bound run explicitly read that worktree's SKILL.md and issued three complementary official queries. They returned eight, nine and nine candidates in 1.930–2.620 seconds, then all fell back to one native batch after publication failure. Unpublished local JSON/status logs were not accepted as candidate sources.
- That worktree's tools/quick_search.py completed eight PaperHub operations in 2.400 seconds with zero failures, selecting 20 papers from a pool of 84 (Tier 1/2/3 = 4/9/7). The first paper was Attention Is All You Need.
- Credentials were renamed to SCHOLARSEED_API_KEY without retaining SHUSHEN_API_KEY. A new-host title probe then succeeded in 0.340 seconds; official web-search recognized credentials and returned HTTP 200/eight candidates in 1.857 seconds.

Local JSONL confirmed a native batch ran, but the outer CLI did not expose its internal marker envelope. Envelope validation remained part of web-search's host contract; agentic-search consumed the shared candidate core only.

## Contract boundaries

agentic-search must not bypass web-search with direct runtime Web Search. The migration record considered official-api, codex-native and visible-browser routes; the active Skill's permitted profiles remain authoritative and must not be widened from this historical account.
completed/empty ends routing only after a successful Invocation and delivered artifact. Nonzero provider exit, missing artifact or publication failure continues to the next permitted path. This migration did not change PaperHub retrieval, citation expansion, selection or tiering.

The 2026-09-17 return contract used published artifacts for official/browser, reading status rather than treating process exit as search status.
Native used a strict subset inside the scholarseed_web_search_results marker with provider codex-native.
All routes shared title/url/description, with provider extensions allowed; empty browser descriptions alone did not invalidate candidates. Old WEB_SEARCH_RESULT_BEGIN/END and provider native were retired.

Plain Codex usage also required explicit $agentic-search $web-search loading, command networking in workspace-write and a writable web-search location. Otherwise official-api/PaperHub could leave an empty pool.
A locally written JSON file was not proof of product artifact delivery. The runtime must supply the bridge, or web-search must define a supported portable return contract; agentic-search must not fabricate a publisher.
Concurrent calls sharing a working directory could race on web-search-result.json, so product Invocations require isolated workspaces.
Without a bridge, publication failure still follows the permitted native fallback. This record does not introduce a temporary bridge or fake publisher.

Original evidence paths in the development workspace:

- agentic-search-results/product_paperhub_websearch_20260917/paperhub_endpoint_comparison.json
- agentic-search-results/product_paperhub_websearch_20260917/paperhub_fair_concurrency.json

These local historical paths are not bundled evidence or a requirement for users.
