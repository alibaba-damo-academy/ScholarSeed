# Agentic Search: tiered academic paper discovery

**English** · [简体中文](README_zh.md)

A Codex Skill for natural-language academic paper discovery, including implicit queries that do not name a paper, method or dataset. It resolves hidden entities, retrieves candidates, follows references and returns relevance-tiered `metadata.json`.

Use it to find papers for a research idea or debate, identify methods/projects/datasets/standards from incomplete clues, or build a candidate pool for related work and reviews. Its default deliverable is paper metadata, not a long research report.

## Search modes

| Mode | Use case | Time target | Default paper count | Provided Codex profile |
|---|---|---|---|---|
| Quick | Search bars and previews | Under one minute | Up to 20 | Luna / low |
| Balanced | Interactive discovery | 5–6 minutes | 38–40 | Sol / high |
| Quality | High recall and implicit questions | No hard limit; recorded benchmark about 8–9 minutes | 38–40 | Sol / xhigh / fast |

**Quality is the default.** Without an explicit mode or time budget, the Skill uses the C1 quality-first workflow. Quick and Balanced require an explicit mode or corresponding budget. Recorded timings are observations, not service guarantees.

These are different execution graphs, not time-truncated copies:

- **Quick:** one entity-resolution batch, one bounded PaperHub graph and deterministic selection.
- **Balanced:** one focused retrieval round, model-selected citation anchors and set-level selection.
- **Quality:** repeated entity/relation gap recovery, citation-anchor selection per round and a final provenance audit.

## Getting started

Use an installed, authenticated Codex CLI launched from ScholarSeed Desktop or `scholarseed-serve`. A PaperHub API key is an optional enhancement, not a prerequisite. Install the independent `web-search` Skill as well.

### Optional manual Codex installation

The product supplies its bundled Skills. For a separately authorized manual Codex installation, run these commands **from this Skill's directory**, where `tools/` and `config/` are located:

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-network-profile
```

This does not install Codex. It installs:

- `~/.agents/skills/agentic-search`;
- a default Quality alias plus Quick, Balanced and Quality profiles;
- `~/.config/agentic-search/search_config.json`.

The default is a symlink, so retain the source directory. Use `--mode copy` for an independent copy. Restart Codex if a newly installed Skill is not discovered. The installer does not overwrite existing installations or machine configuration.

### Optional PaperHub enhancement

Set the key before starting Codex:

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
```

Credentials are read from the environment only. Never put real keys in source, configuration or shared logs. Without a key, the Skill uses the separately installed `$web-search` Skill and explicitly labels degraded results; it does not ask the user for a token.

### Choose a mode

Quality, the default:

```bash
codex --profile agentic-search-quality
```

```text
$agentic-search Find papers on evaluating citation reliability in retrieval-augmented generation.
```

`codex --profile agentic-search` is an alias for the same Quality configuration. You can explicitly request Quality in the task.

Balanced:

```bash
codex --profile agentic-search-balanced
```

```text
$agentic-search Use Balanced mode to find papers on evaluating citation reliability in retrieval-augmented generation.
```

Quick:

```bash
codex --profile agentic-search-quick
```

```text
$agentic-search Use Quick mode to find papers on evaluating citation reliability in retrieval-augmented generation.
```

Profiles select the session's model, reasoning effort and networking. The request selects the search algorithm. Keep them aligned when comparing the recorded quality and latency.

You can specify only a budget:

```text
$agentic-search Find papers on evaluating citation reliability in retrieval-augmented generation in about six minutes.
```

Budget mapping:

- `time_budget_minutes <= 2`: Quick.
- `2 < time_budget_minutes <= 6`: Balanced.
- `time_budget_minutes > 6`: Quality with a deadline.
- No budget: unrestricted Quality/C1.

A deadline prevents new retrieval batches but cannot interrupt an in-progress model response. These are soft targets, not hard SLAs.

## Search sources and networking

The default policy is **PaperHub when credentials are available + `$web-search`, with Brave off**.

1. PaperHub optionally supplies structured keyword, title, detail and reference queries.
2. All public-web retrieval goes through `$web-search`, trying `official-api` then `codex-native`. Both provide the `scholarseed.web_search.v1` candidate core. Do not bypass that Skill with direct native Web Search or use automatic/browser profiles.
3. Brave stays off even when `BRAVE_API_KEY` exists.

Missing/rejected credentials or an overall PaperHub outage after bounded retries stops PaperHub requests. The Skill reuses or supplements verifiable web paper candidates and records `source_mode: "web_only"`, `degraded: true` and coverage limitations. It does not disguise ordinary webpages as papers or add noise to reach a quota. If `$web-search` is also unavailable, it fails explicitly.

See [PaperHub fallback policy](docs/PAPERHUB_FALLBACK.md) for counts, failure records and unsupported fallback conditions.

PaperHub defaults to `auto`, inherits proxy settings and may retry a clean direct connection after transport failure. A legacy PaperHub `NO_PROXY` bypass can conflict with host-controlled network restrictions; remove it where required. Direct and SSH-tunnel configurations are described in [SETUP.md](SETUP.md). A successful connection does not prove host network policy enforcement.

Use Brave only with explicit permission, or when primary sources are unavailable and the user accepts the fallback:

```text
$agentic-search Use Quality mode for this topic. If the primary sources have insufficient coverage, you may supplement with Brave.
```

The `codex-native` provider is a hosted Codex tool. `official-api`, PaperHub and Brave make HTTP requests from local Python processes and need both command-network permission and a working machine network route. The independent `web-search` Skill must be installed and discoverable.

## Output

Standalone searches write to the current session's selected output directory. Searches supporting another task write under its `work/` directory. Resumed runs keep their existing path.

```text
SESSION_DIR/agentic-search-results/metadata.json
```

- **Tier 1:** papers most directly answering the question.
- **Tier 2:** clearly relevant methods, evidence and important extensions.
- **Tier 3:** related entities, citation chains and secondary subtopics for recall.

Records may include title, authors, year, venue/journal, pages, volume, abstract, DOI, arXiv ID, citation count, URL, source, tier and selection rationale. See the [output schema](references/output-schema.md).

## Models and configuration

The provided profiles are recorded configurations, not hard dependencies. If your account lacks a configured model or fast service tier, override them:

```bash
codex --profile agentic-search-quality \
  -m <available-model> \
  -c model_reasoning_effort='"high"' \
  -c service_tier='"default"'
```

CLI options take precedence over project/profile settings. A different model or effort keeps the search graph but may change latency, tokens and quality; validate the actual combination separately. [SETUP.md](SETUP.md) covers configuration precedence, proxies, tunnels, cloud environments and caches.

## Diagnostics

```bash
# Inspect local configuration/environment without network requests.
scholarseed-skill-python tools/doctor.py

# Send a minimal PaperHub request.
scholarseed-skill-python tools/doctor.py --live
```

- `api_key_present: false`: Web-only fallback, not an installation error.
- `PAPERHUB_AUTH_MISSING`: no key.
- `PAPERHUB_HTTP_401`: rejected key.
- `PAPERHUB_TRANSPORT_ERROR`: network, proxy or tunnel failure.

## Other manual installation options

If live web search, command networking in `workspace-write` and `web-search` are already configured, install only this Skill:

```bash
scholarseed-skill-python tools/install_codex.py --scope user
```

For a project:

```bash
scholarseed-skill-python tools/install_codex.py --scope repo --repo /path/to/target-repo
```

Project installation does not modify user profiles or PaperHub configuration. See [tiered search design](docs/TIERED_SEARCH.md) for the recorded benchmark scope and limitations.
