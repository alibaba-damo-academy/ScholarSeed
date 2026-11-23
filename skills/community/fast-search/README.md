# Fast AI Search

**English** · [简体中文](README_zh.md)

Low-latency academic paper discovery for search bars. The independently installed `$web-search` Skill resolves candidate paper entities, then PaperHub runs one bounded keyword/title/reference graph. A single-paper lookup returns only the verified target in `metadata.json` and the reply; topic or related-work searches return up to 20 papers.

For a publisher/arXiv link, DOI or explicit title, the agent resolves a canonical `best_target` within the existing web batch and submits an exact PaperHub title query. Bounded metadata checks run in parallel for the input identifier and a few important papers already found. Independently verified papers may be returned even when PaperHub misses them. A verified single-paper target is the sole Tier 1 result, even when the pool contains related papers. If neither path verifies it, fail explicitly instead of presenting broadly related papers as success.

For topic searches, Tier 1 prioritizes an explicit input identifier, then the agent's best_target, then existing deterministic relevance scores. Related-work searches use `best_target.required: false` and retain the topic-search list and tiering. This adds no model round. Abstracts are used for relevance only inside the runner process and are not persisted in metadata, sessions, round traces or retrieval caches.

This directory provides the `fast-search` Veryfast workflow and deployment entry point, not long reports or registrations for other search Skills.

## Choose an integration

Prerequisites: an installed/authenticated Codex CLI launched from ScholarSeed Desktop or `scholarseed-serve`, the independent `web-search` Skill, and a PaperHub API key.
Commands below run **from this Skill's directory**, where tools/ and config/ are located. Product users normally use bundled Skills; manual installation is optional and requires authorization.

| Integration | Use case | Benefit | Responsibility |
|---|---|---|---|
| Codex Skill | Personal discovery, interactive use, debugging | Invoke with $fast-search | New processes still pay startup, Skill loading and unrelated initialization costs |
| Persistent App Server Worker | Search bars, backends, repeated queries | Reuses process/authentication and emits structured progress | Backend manages isolation, deadlines and process health |

Both use the same SKILL.md, quick_search.py and metadata schema, with a normal target of 20 papers for topic searches and exactly one verified result for a single-paper lookup. Process reuse does not add search rounds or improve paper quality by itself.

## Option 1: manual Codex Skill installation

```bash
scholarseed-skill-python tools/install_codex.py --scope user --with-search-config
```

Installation defaults to a symlink, so retain the source directory; use --mode copy when needed. Existing paths are not overwritten.

Set the key before starting Codex and enable hosted search plus command networking:

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true
```

Equivalent authorized user configuration can supply these options. Restart Codex if a new Skill is not discovered.

```text
$fast-search $web-search Find papers on evaluating citation reliability in retrieval-augmented generation.
```

Explicitly load both Skills into the same turn; do not depend on implicit discovery. Progress at entity resolution, PaperHub retrieval and completion matches the user's requested language or query language. It reuses existing action boundaries without extra timing commands, model calls or rounds. Interactive use runs the same graph but lacks persistent process reuse.

### Session performance configuration

A Skill cannot change an already running session's model, effort or service tier. The following is a recorded low-latency starting configuration, subject to account availability:

```bash
codex --search -s workspace-write \
  -c sandbox_workspace_write.network_access=true \
  --disable apps \
  -m gpt-5.6-luna \
  -c model_reasoning_effort='"low"' \
  -c service_tier='"fast"'
```

Stronger models or higher effort may improve difficult entity resolution but increase time/tokens. Re-evaluate each combination. Session settings belong in Codex user configuration/profiles; PaperHub URL, proxies and cache settings use `~/.config/fast-search/search_config.json`.

### Project installation

```bash
scholarseed-skill-python tools/install_codex.py --scope repo --repo /path/to/target-repo
```

This creates `.agents/skills/fast-search` in that project. Install web-search separately alongside it.
A product Worker injects this Skill and an existing web-search installation; it does not copy or download web-search.

## Option 2: persistent App Server Worker

A Worker keeps one local Codex App Server alive but creates a new ephemeral thread per query, sharing neither user history nor candidate pools. Internal quick filenames are compatibility names, not a separate search mode.

```bash
export SCHOLARSEED_API_KEY="<your-paperhub-api-key>"
# Only for a nonstandard web-search installation:
export WEB_SEARCH_SKILL_PATH="/absolute/path/to/web-search"
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl
```

After server.ready, send one request per stdin line:

```json
{"id":"request-1","query":"Find papers on citation reliability in retrieval-augmented generation","output_dir":"/absolute/path/to/result-1","language":"en"}
```

Observed events may emit analyzing, entity_resolution, paper_retrieval, finalizing and completed, with a localized message and cumulative elapsed_seconds. Missing intermediate events do not cause extra model calls, retrieval or waiting.
By default, Chinese queries select Chinese progress; other queries select English. Configuration or a request's language can override this. Output is `output_dir/metadata.json`. One Worker is strictly serial; concurrency requires a bounded backend-managed pool.

Single-query smoke invocation:

```bash
scholarseed-skill-python tools/appserver_quick.py \
  --query "Citation reliability in retrieval-augmented generation" \
  --output-dir /absolute/path/to/result
```

### Worker configuration

Defaults are in config/fast-search-veryfast.json. Copy machine settings outside the shared source tree and select them with --config or FAST_SEARCH_VERYFAST_CONFIG; individual CLI flags have highest precedence.

```bash
scholarseed-skill-python tools/appserver_quick.py --serve-jsonl \
  --config /etc/fast-search/veryfast.json \
  --model <available-model> --effort low --service-tier default

scholarseed-skill-python tools/appserver_quick.py --print-effective-config \
  --config /etc/fast-search/veryfast.json
```

The recorded default is gpt-5.6-luna + low + priority + enable_apps=false. Keep cache_mode=off for live service.
Use direct only when PaperHub is reliably reachable that way; otherwise configure auto/inherit or an authorized tunnel.
See [deployment and networking](SETUP.md), including backend supervision and latency limitations. Veryfast is a soft target, not a hard 30-second SLA; the product caller still owns total deadlines, cancellation and failure handling.

## Sources, verification and privacy

Public batches start through the independent web-search Skill, using its official → native → browser routing. An incidental successful direct native result remains a compatibility result; after failure, return to web-search in the same turn. The Worker explicitly injects both Skills and enables hosted search and command networking.
PaperHub still needs a working direct/proxy/tunnel route and SCHOLARSEED_API_KEY inherited before startup.

Supplemental verification uses at most four already-known DOI/paper links, exact Crossref DOI records or scholarly citation metadata on article pages. It runs beside PaperHub with a shared eight-second wait budget and adds no model/search round.
It does not trust search snippets or invented authors/dates, download PDFs or persist abstracts.
Verification uses anonymous public HTTPS without reading proxy credentials, cookies or login state. If unavailable, keep usable PaperHub results. If PaperHub fails but independently verified candidates exist, they may be returned with explicit provenance and service-failure records.

This is not full-text retrieval and cannot parse every site. Unverifiable metadata, blocking and timeout may still fail. External candidates retain time constraints and ranking; do not mix preprint/published identifiers or add web noise merely to reach a count.

## Diagnostics

```bash
scholarseed-skill-python tools/doctor.py
scholarseed-skill-python tools/doctor.py --live
```

api_key_present: false means no key reached the process. PAPERHUB_AUTH_MISSING is a missing key; PAPERHUB_HTTP_401 is a rejected key. Diagnostics report presence, not key contents.
[SETUP.md](SETUP.md) covers endpoint, proxy, tunnel and cloud settings.

## Files

- agents/openai.yaml: discovery metadata.
- config/fast-search-veryfast.json: Worker defaults.
- SKILL.md: authoritative Veryfast instructions.
- SETUP.md: deployment/network setup.
- tools/appserver_quick.py: persistent Worker.
- tools/quick_search.py: single-invocation retrieval/selection.
- tools/search_round.py and paperhub.py: bounded retrieval/API calls.
- tools/quick_finalize.py and ranking.py: deterministic selection.
- tools/state.py and search_policy.py: run state/constraints.
- tools/localconf.py and cache.py: machine configuration/optional cache.
- tools/doctor.py and install_codex.py: diagnostics/optional manual installation.

The Python tools use the standard library; web-search owns its separate dependencies. Product callers select each output_dir; interactive use creates a new result directory under the workspace. Internal quick names preserve implementation/schema compatibility and expose no mode switch.
