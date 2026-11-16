# Veryfast deployment and networking

**English** · [简体中文](SETUP_zh.md)

Commands run from the fast-search Skill directory. Installation, credential changes and deployment operations require authorization; the examples do not grant it.

## Minimal startup

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
# Only for a nonstandard web-search location:
export WEB_SEARCH_SKILL_PATH="/absolute/path/to/web-search"
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

The Worker launches codex --search app-server and explicitly configures model, effort, service tier, workspace-write, command networking and structured Skill inputs for each request. It does not depend on a Codex profile.
For manual interactive use instead:

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

web-search's hosted native provider does not use Python/shell HTTP_PROXY. Its official provider and PaperHub use local Python HTTP requests and inherit the Worker environment; diagnose these paths separately.
The Worker finds the independent web-search Skill beside fast-search, in project/user Skill roots or through WEB_SEARCH_SKILL_PATH. Missing web-search fails startup instead of bypassing it with direct native search.
Interactive use must explicitly load both $fast-search and $web-search in the same turn.

## PaperHub

Configuration precedence:

1. Environment, such as PAPERHUB_URL and PAPERHUB_PROXY_MODE.
2. JSON selected by FAST_SEARCH_CONFIG.
3. `~/.config/fast-search/search_config.json`.
4. Legacy Skill-local `tools/search_config.json`.
5. Bundled `tools/search_config.default.json`.

The installer copies defaults into user configuration without overwriting it. Example:

```json
{
  "paperhub_url": "https://scholarseed.damo.alibaba.com/paperhub",
  "paperhub_proxy_mode": "auto",
  "extra_no_proxy": ["scholarseed.damo.alibaba.com"],
  "cache_dir": "",
  "cache_mode": "off",
  "cache_replay_timing": "instant"
}
```

Known legacy defaults http://114.55.135.28:8000 and http://120.26.184.97/papersearch/ are normalized at runtime; update old user configuration explicitly as well. Other custom URLs and explicit PAPERHUB_URL overrides are retained.

Credentials are environment-only and must exist before Codex/Worker startup:

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
```

Never put a real key in source, search_config.json, profiles, CLI arguments or shared logs. The ScholarSeed endpoint uses HTTPS; explicit local tunnels can use localhost HTTP.
A running session does not inherit later exports. Restart from the intended environment when necessary, and ensure custom shell_environment_policy retains the key, proxy variables and PATH.

| Proxy mode | Behavior |
|---|---|
| auto | Inherited proxies/NO_PROXY, then clean direct retry on transport/proxy failure |
| inherit | Inherited Python proxies only |
| direct | Ignore proxies for PaperHub |

| Route | paperhub_url | Mode | extra_no_proxy |
|---|---|---|---|
| Default direct route | https://scholarseed.damo.alibaba.com/paperhub | auto or direct | Official host included |
| Required HTTP proxy | Same endpoint | inherit or auto | Remove the official host |
| SSH tunnel | http://localhost:18000 | direct | localhost, 127.0.0.1 |

extra_no_proxy sets both NO_PROXY and no_proxy, so the supplied setting bypasses proxies for the official host. Remove that bypass when the deployment or host network policy requires a proxy.
Do not disable a host's security boundary to make a probe work. Never commit proxy passwords.

### SSH tunnel and cloud configuration

For an authorized tunnel:

```bash
ssh -N -o ServerAliveInterval=30 \
  -L 18000:<PAPERHUB_HOST>:<PORT> <USER>@<JUMP_HOST>
```

```json
{
  "paperhub_url": "http://localhost:18000",
  "paperhub_proxy_mode": "direct",
  "extra_no_proxy": ["localhost", "127.0.0.1"]
}
```

Cloud localhost means the cloud container, not your computer. Use an endpoint reachable from that environment and allow HTTP POST to /papersearch/.
Cloud internet access/host allowlists require separate authorized configuration. Repository code cannot change organization/environment permissions.

### API operations

All operations use POST /papersearch/:

- keyword: query, with Elasticsearch query_string syntax.
- title: exact known-title matching.
- references: cited_by returns the supplied papers' references, not later citing papers.
- papers: ids batch-retrieves details.

Semantic search returns PAPERHUB_UNSUPPORTED_MODE; the workflow uses keyword/title/citation tracking.
Keyword/title normally request abstracts for in-process relevance. Persistence boundaries remove abstracts. Use --allow-missing-abstract when in-memory abstracts are unnecessary; --year-start/--year-end filter years.

### Experiment cache

Normal live use keeps cache_mode off. New records remove abstract fields. Runtime does not bulk-rewrite old caches/results: operators must handle authorized retention cleanup separately.

| Mode | Behavior |
|---|---|
| readwrite | Replay hits, fetch and record misses |
| refresh | Fetch live and replace records |
| replay | Strict replay; SEARCH_CACHE_MISS without live fallback |
| readonly | Read existing records; the caller controls live access on a miss |
| off | No cache |

Records include the response after persistence filtering and actual request wall time.
cache_replay_timing is instant (immediate), account (immediate plus elapsed accounting) or sleep (wait the recorded duration).
Use replay + sleep for attributable replay comparisons and an additional live, cache-off blind run for real-world validation. Cache keys exclude the host, so direct/tunnel routes can share records. web-search is outside this cache.

### Upgrading manual installations

- Symlinks follow source updates; update environment/configuration and restart as needed.
- Existing copy installations are not overwritten; preserve a backup before reinstalling with --mode copy.
- Existing user search_config.json is retained; legacy warnings/normalization do not rewrite it.
- Worker settings belong in config/fast-search-veryfast.json, external deployment config and CLI flags.

## web-search

The Worker launches App Server with --search and explicitly injects fast-search plus installed web-search.
Every public batch starts with web-search; --search enables its native provider. Incidental successful direct native calls remain compatible, but failures return to the official web-search path in the same turn.
Official-provider/PaperHub requests still require command-network permission and working proxies. Interactive use also requires explicit loading of web-search and live search enabled through --search or equivalent configuration.

## Persistent Veryfast / App Server

The backend supervises a persistent Worker instead of starting an interactive Codex for each query. Codex must already be authenticated under the Worker account; keys/proxies must exist before startup.
Communication is local stdio JSONL, not an exposed App Server. Any separately deployed remote transport needs its own supported protocol, authentication and transport-security review.

### Worker configuration

Default config/fast-search-veryfast.json:

```json
{
  "model": "gpt-5.6-luna",
  "effort": "low",
  "service_tier": "priority",
  "timeout_seconds": 900,
  "enable_apps": false,
  "cache_mode": "off",
  "cache_dir": "",
  "cache_replay_timing": "instant",
  "paperhub_proxy_mode": "direct",
  "progress_language": "auto"
}
```

Keep machine settings outside the shared repository:

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json

export FAST_SEARCH_VERYFAST_CONFIG=/etc/fast-search/veryfast.json
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

Precedence, low to high: built-in fallback values, bundled defaults, external config, existing PAPERHUB_*/SEARCH_CACHE_* environment overrides, individual CLI flags.
Environment overrides cover the corresponding PaperHub/cache fields, not model/effort/service tier.
Inspect configuration without starting Codex or requiring a PaperHub key:

```bash
scholarseed-skill-python tools/appserver_quick.py --print-effective-config \
  --config /etc/fast-search/veryfast.json
```

Account-specific overrides:

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json \
  --model <available-model> --effort low --service-tier default
```

The model must be available to the account and support the effort setting; otherwise thread/turn creation fails. Evaluate changed configurations separately.

| Field | Default | Meaning |
|---|---|---|
| model | gpt-5.6-luna | Speed, capabilities, quota and supported effort |
| model_provider | Empty | Registered App Server provider ID for non-OpenAI models; empty for default OpenAI |
| effort | low | Higher values may improve difficult planning but add time/tokens |
| service_tier | priority | Requested service tier, not a latency SLA; use an available tier |
| timeout_seconds | 900 | Supervised per-query turn limit, not product end-to-end SLA |
| enable_apps | false | Apps are not needed; enabling expands the tool surface/initialization |
| cache_mode | off | Live by default; caches PaperHub only |
| cache_dir | Empty | Required for record/readwrite/readonly/refresh/replay modes |
| cache_replay_timing | instant | Immediate, accounted or real-delay replay |
| paperhub_proxy_mode | direct | Use auto/inherit or a tunnel when reliable direct access is unavailable |
| progress_language | auto | Infer Chinese/English from query, or explicitly select zh/en |

Never put SCHOLARSEED_API_KEY in this JSON. PaperHub URL, NO_PROXY and tunnels use the PaperHub configuration above, not duplicated configuration.

### Low-latency deployment

- Keep the Worker and App Server alive across requests.
- Keep enable_apps=false unless the workflow genuinely uses Apps.
- Use a dedicated service account and minimal Codex configuration, avoiding unrelated personal MCP/plugin/hook inheritance.
- Use an account-supported low-latency model/effort and revalidate quality after changes.
- Configure the actual PaperHub route without clearing proxies needed by Codex/model connectivity.
- Keep cache_mode=off for live results. A business cache with explicit freshness semantics is different from benchmark replay.

App Server does not eliminate model reasoning, web-search or PaperHub requests. Latency depends on process reuse, a small tool surface, one retrieval graph and suitable model settings together.

### Backend integration

```text
Search bar -> product backend -> persistent appserver_quick.py -> Codex App Server
                                           |-> web-search Skill
                                           `-> PaperHub
```

Wait for server.ready, then send newline-delimited requests:

```json
{"id":"request-1","query":"Find papers on citation reliability in retrieval-augmented generation","output_dir":"/absolute/path/result-1","language":"en"}
```

Observable progress uses request ID, localized message and cumulative elapsed_seconds:

| stage | Meaning |
|---|---|
| analyzing | Interpret the request and plan retrieval |
| entity_resolution | Resolve candidate paper entities through public search |
| paper_retrieval | PaperHub retrieval, reference expansion and deterministic ranking |
| finalizing | Metadata exists; finish the turn |
| completed / failed | Request settled |

Intermediate events use type: progress. They do not expose private reasoning/raw App Server events or add searches/calls/waits to fill missing stages.
output_dir must be absolute and must not already exist; use a unique directory per request.
auto selects Chinese for queries containing Chinese and English otherwise. Deployment progress_language can select zh/en; request language takes precedence.
stage always remains an English machine enum. One Worker is strictly serial; use a bounded, independently isolated pool and test account capacity for concurrency.

Never expose stdin/stdout, Codex login state or keys directly to the browser. The backend relays necessary progress through SSE/WebSocket and owns total deadlines, cancellation, retry, health and fallback.
At timeout_seconds, the Worker requests turn/interrupt and exits. Supervision starts a new Worker, avoiding overlap with a previous turn.
Pin and record the actual Codex CLI version: App Server schemas and fields can vary by version.

## Diagnostics

```bash
# Local configuration/proxy/key-presence checks; no secret output.
scholarseed-skill-python tools/doctor.py

# Minimal live request, only when authorized.
scholarseed-skill-python tools/doctor.py --live
scholarseed-skill-python tools/paperhub.py title "Attention Is All You Need" --limit 1

# Inspect configuration without starting Codex.
scholarseed-skill-python tools/appserver_quick.py --print-effective-config
```

PAPERHUB_AUTH_MISSING means no key reached the process; PAPERHUB_HTTP_401 is authentication failure; PAPERHUB_TRANSPORT_ERROR indicates network/proxy/tunnel failure.
For an authorized interactive session with restricted networking, use the session configuration described above.
auto may retry clean direct access after a dead inherited proxy, but continued failure requires checking real reachability rather than silently relaxing host policy.
