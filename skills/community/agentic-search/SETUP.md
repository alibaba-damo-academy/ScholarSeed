# Codex and network setup

**English** · [简体中文](SETUP_zh.md)

Commands below run from this Skill's directory. The product provides bundled Skills; manual installation and user/cloud configuration changes require the user's authorization.

## Manual installation and provided profiles

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-network-profile
# Optional PaperHub enhancement; set before starting Codex.
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
codex --profile agentic-search-quality
```

| Profile | Purpose | Recorded model / effort | Service tier / Apps |
|---|---|---|---|
| agentic-search-quick | Search-bar latency target around one minute | Luna / low | Defaults / inherited |
| agentic-search-balanced | Interactive target of 5–6 minutes | Sol / high | Defaults / inherited |
| agentic-search-quality | Quality-first C1, no deadline | Sol / xhigh | fast (request priority) / off |
| agentic-search | Alias for Quality | Sol / xhigh | fast (request priority) / off |

Profiles enable live web search and command networking while retaining the `workspace-write` filesystem sandbox. Mode profiles also select model and effort. Without a lower-latency mode/budget, the Skill defaults to Quality/C1. To configure the session temporarily without installing a profile:

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

The independent `web-search` Skill must also be installed; a project installation uses `.agents/skills/web-search/`. Its hosted `codex-native` provider does not use Python/shell `HTTP_PROXY`. Its `official-api` provider, PaperHub and Brave make local HTTP requests and inherit the process environment. Diagnose these network paths separately.

### Model and session overrides

The recorded Quality/C1 blind-test configuration was `gpt-5.6-sol + xhigh + service_tier=priority + Apps off`. The supplied profile uses CLI `service_tier = "fast"` and `features.apps = false`. These affect the launched session, not the C1 algorithm in SKILL.md.

The documented precedence is CLI flags, project `.codex/config.toml`, selected profile, user `~/.codex/config.toml`, system configuration and built-in defaults. Account capabilities may require overrides:

```bash
codex --profile agentic-search-quality \
  -m <available-model> \
  -c model_reasoning_effort='"high"' \
  -c service_tier='"default"'
```

For authorized persistent machine settings, the installed profile file is `$CODEX_HOME/agentic-search-quality.config.toml`. The installer does not overwrite existing profiles: preserve a backup before adopting an updated one. Revalidate entity resolution, stopping, latency and quality for each actual model/effort combination. A profile configures the session; it does not force the mode selected by the request.

## PaperHub

The host must authorize the fixed `scholarseed.damo.alibaba.com` host in session and subagent sandboxes and verify enforcement at its network boundary. This Skill does not widen permissions. Host authorization covers all paths on that host, not only /paperhub. A custom PAPERHUB_URL does not automatically extend an allowlist.

Configuration precedence:

1. Environment, such as PAPERHUB_URL and PAPERHUB_PROXY_MODE.
2. The JSON file selected by AGENTIC_SEARCH_CONFIG.
3. `~/.config/agentic-search/search_config.json`.
4. Legacy Skill-local `tools/search_config.json`.
5. Bundled `tools/search_config.default.json`.

The installer copies defaults to the user location without overwriting existing files. Example:

```json
{
  "paperhub_url": "https://scholarseed.damo.alibaba.com/paperhub",
  "paperhub_proxy_mode": "auto",
  "extra_no_proxy": [],
  "cache_dir": "",
  "cache_mode": "off",
  "cache_replay_timing": "instant"
}
```

Known legacy defaults `http://114.55.135.28:8000` and `http://120.26.184.97/papersearch/` are normalized at runtime; update old user configuration explicitly as well. Remove the official domain from legacy extra_no_proxy where it would bypass a host-restricted proxy. Official-domain HTTP settings, including an explicit PAPERHUB_URL, are upgraded to HTTPS; localhost tunnels and custom/internal URLs are not rewritten by that rule.

PaperHub credentials are optional and environment-only:

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
```

Set this before launching Codex. Never put real keys in the repository, search_config.json, profiles, command arguments or shared logs. The default endpoint uses HTTPS. Without a key, use explicitly degraded web-search results instead of asking for a token.

A product process should receive a key at login and be replaced with a key-free process after logout. Do not pass credentials through prompts, CLI arguments or logs. Exporting a key after a session starts does not update that session: restart from the intended environment. A custom shell_environment_policy must retain the needed key, proxy variables and PATH.

Proxy modes:

- auto: inherited proxies/NO_PROXY, then a clean direct attempt after transport/proxy failure.
- inherit: inherited Python proxy environment only.
- direct: ignore proxies for PaperHub.

| Route | paperhub_url | Mode | extra_no_proxy |
|---|---|---|---|
| Inherited proxy, default | https://scholarseed.damo.alibaba.com/paperhub | auto | Do not include the official host |
| Explicit direct connection | Same endpoint | direct | May include the official host |
| SSH tunnel | http://localhost:18000 | direct | localhost, 127.0.0.1 |

extra_no_proxy sets both NO_PROXY and no_proxy. Its default is empty so host-restricted egress can enforce domain policy; legacy config and external variables must not create a PaperHub bypass on such hosts. Direct success alone does not prove allowlist enforcement. Never commit proxy passwords.

### SSH tunnel and cloud environments

If authorized and direct access is unavailable:

```bash
ssh -N -o ServerAliveInterval=30 \
  -L 18000:<PAPERHUB_HOST>:<PORT> <USER>@<JUMP_HOST>
```

User configuration:

```json
{
  "paperhub_url": "http://localhost:18000",
  "paperhub_proxy_mode": "direct",
  "extra_no_proxy": ["localhost", "127.0.0.1"]
}
```

In a cloud task, localhost means the cloud container, not your computer. Use an endpoint reachable from that environment and permit HTTP POST to /papersearch/.
These profiles target local Codex CLI. Cloud agent internet access and host allowlists require separate authorized environment configuration. Include api.search.brave.com only when Brave is enabled. Repository code cannot change organization permissions for the user.

### API operations

All PaperHub operations use POST /papersearch/:

- keyword: query with Elasticsearch query_string syntax.
- title: known-title matching.
- references: cited_by returns papers referenced by each supplied paper, not later papers citing it.
- papers: ids retrieves paper details in a batch.

Semantic search is unsupported and returns PAPERHUB_UNSUPPORTED_MODE. The workflow uses keyword/title/citation tracking.
Keyword/title requests require abstracts by default. Use --allow-missing-abstract only when necessary; --year-start and --year-end apply year bounds.

### Reproducible experiment cache

Keep cache_mode off for normal use. For authorized A/B experiments:

| Mode | Behavior |
|---|---|
| readwrite | Replay hits; fetch and record misses |
| refresh | Fetch live and replace records |
| replay | Replay only; misses return SEARCH_CACHE_MISS without live requests |
| readonly | Read existing records; the caller decides whether misses may fetch live |
| off | Disable caching |

Records include the full response and observed request wall time. cache_replay_timing supports instant (return immediately), account (return immediately but account for recorded wall in PaperHub elapsed), and sleep (actually wait the recorded wall).
Use replay + sleep for attributable replay experiments and an additional live, cache-off blind run for real-world results. Cache keys exclude the host, allowing direct/tunnel reuse. This cache does not cover web-search.

### Upgrading a manual installation

- Symlinks follow source updates. If enabling PaperHub, update environment/configuration and restart Codex.
- Copy installations are not overwritten. Back up the old directory before reinstalling with --mode copy.
- Existing user search_config.json is retained. Legacy-URL warnings and runtime normalization do not rewrite it.

## web-search

Use the installed mode profiles or enable --search for its codex-native provider. Discoverability does not prove PaperHub availability; official-api and PaperHub still require command networking and a usable proxy route.
Every public-web lookup must go through the independent web-search Skill, never direct native Web Search.

## Brave: explicitly enabled only

Brave is not enabled merely because BRAVE_API_KEY exists. Use it only on explicit request or when primary paths are unavailable and the user accepts an alternative.

```bash
export BRAVE_API_KEY="<your-brave-key>"
```

The host is api.search.brave.com. Missing keys, rejected authentication or exhausted quota do not justify repeated retries; retain the permitted PaperHub/web-search paths.

## Diagnostics

```bash
# Local installation, config sources, key presence and proxies; no key values.
scholarseed-skill-python tools/doctor.py

# Minimal live PaperHub probe.
scholarseed-skill-python tools/doctor.py --live

# Individual probes, only when authorized.
scholarseed-skill-python tools/paperhub.py title "Attention Is All You Need" --limit 1
scholarseed-skill-python tools/brave.py "Attention Is All You Need paper" --count 1
```

PAPERHUB_AUTH_MISSING means the key did not reach the process and triggers Web-only fallback, not a request for user configuration. PAPERHUB_HTTP_401 is authentication rejection; PAPERHUB_TRANSPORT_ERROR indicates networking/proxy/tunnel failure.
If command networking is restricted, use an authorized mode profile or equivalent session configuration. If an escalated process inherits a dead loopback proxy, auto may try a clean direct connection. If it still fails, check actual reachability. These diagnostics are not permission to change user/network configuration.
