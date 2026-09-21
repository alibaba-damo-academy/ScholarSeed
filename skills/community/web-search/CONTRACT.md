# Web Search Return Contract (`scholarseed.web_search.v1`)

This file is the **machine-readable return contract** for the `web-search` skill. Another
skill (or any host) that invokes `web-search` and reads its result must rely on this
contract, not on the prose in `SKILL.md`. `SKILL.md` owns *how to run* each provider;
this file owns *what comes back*.

Source of truth: `scripts/official.py`, `scripts/browser.py`, `scripts/providers.py`,
`scripts/invoke.py`. If this document and those files disagree, the files win — fix this
document.

---

## 1. Scope

`web-search` runs **exactly one** provider per invocation and publishes **one** result.
There are three logical legs, but only two of them are produced by this skill's scripts:

| Leg | `provider` value | Produced by | Result form |
|-----|------------------|-------------|-------------|
| Official API | `official-api` | `scripts/official.py` via `invoke.py` | `web-search-result.json` artifact (this contract) |
| Visible browser | `visible-browser` | `scripts/browser.py` via `invoke.py` | `web-search-result.json` artifact (this contract) |
| Codex native | `codex-native` | the runtime Web Search tool, **not** this skill | marker-delimited JSON normalized by the host (see §8) |

A consumer that calls this skill reads the **artifact** for the `official-api` and
`visible-browser` legs. The `codex-native` leg never writes this artifact; the host
fallback order (`official → native → browser`) is owned by the caller, never by this skill.

---

## 2. How to invoke

```text
scholarseed-skill-python <SKILL_DIR>/scripts/invoke.py --provider official-api    --query <query> --limit 20
scholarseed-skill-python <SKILL_DIR>/scripts/invoke.py --provider visible-browser --query <query> --limit 20 [--headless]
```

- `--limit` is bounded to **1–20** (`official.MINIMUM_LIMIT` / `MAXIMUM_LIMIT`); default 20.
- `--provider` is required and restricted to `official-api` | `visible-browser`.
- The official leg only makes a network request when a trimmed `SCHOLARSEED_API_KEY` exists;
  otherwise it returns the stable `credential_unavailable` artifact with **no** request.
- The browser leg launches a visible, isolated local browser (Chrome → Edge → installed
  Chromium). `--headless` is diagnostic only.

---

## 3. Where the result lands, and what the exit code means

`invoke.py` is the **only** writer and publisher of the result file.

1. It runs the selected provider, getting back `(payload, search_exit_code)`.
2. It writes `payload` to **`web-search-result.json`** (relative to the process working
   directory; inside a ScholarSeed Invocation this is the one-shot workspace) as sorted-key,
   `ensure_ascii=False`, UTF-8 JSON with a trailing newline.
3. It publishes that file as a **`role: final` Invocation artifact** through the product
   bridge (`scholarseed-bridge artifact publish`). The packaged Desktop injects its
   relocatable bridge through `SCHOLARSEED_BRIDGE_DIR` and `PATH`; publication never imports
   `service` from the Python interpreter used to run this Skill.
4. **`invoke.py`'s process exit code is the *publish* status, not the search status.**

> **Read the search outcome from the artifact's `status` field, never from the process
> exit code.** A `failed` search still writes a well-formed artifact and still exits `0`
> if publication succeeded. Conversely, a non-zero exit means the artifact could not be
> published (bridge missing / unavailable), so there may be **no** artifact to read.

The artifact is registered for **every** search outcome — `completed`, `empty`,
`unavailable`, `action_required`, and `failed` all produce a readable artifact.

---

## 4. Envelope

Both producers emit `schema: "scholarseed.web_search.v1"`. The **common core** is identical;
each provider then adds its own extension keys.

### 4.1 Common core (always present, both providers)

| Field | Type | Meaning |
|-------|------|---------|
| `schema` | `"scholarseed.web_search.v1"` (const) | Contract identifier. Reject anything else. |
| `status` | string enum | Outcome. See §5. The vocabulary differs slightly per provider. |
| `provider` | `"official-api"` \| `"visible-browser"` | Which leg produced this. |
| `query` | string | The trimmed query that was executed (`""` when the query was empty/invalid). |
| `started_at` | string (ISO-8601 UTC, ms, `Z`) | e.g. `2026-09-16T06:58:25.959Z`. |
| `completed_at` | string (ISO-8601 UTC, ms, `Z`) | e.g. `2026-09-16T06:58:28.144Z`. |
| `duration_ms` | integer ≥ 0 | Wall-clock duration of the search leg. |
| `candidates` | array of Candidate (§6) | `[]` for every non-`completed` status. Bounded to ≤ 20. |
| `error` | object \| `null` | `{ "code", "message" }` on a problem; `null` on `completed`/`empty`. See §7. |

### 4.2 Provider extensions (differ — do **not** assume they exist on both)

| Field | `official-api` | `visible-browser` |
|-------|----------------|-------------------|
| `diagnostics` | **present**: `null` on success, or `{ "phase", ... }` on a problem | **absent** |
| `engine` | **absent** | **present**: registered provider name, e.g. `"bing"` |
| `browser` | **absent** | **present**: `"chrome"` \| `"msedge"` \| `"chromium"` \| `null` (null when no browser launched) |

`official-api` `diagnostics.phase` ∈ `validation` \| `credential` \| `request` \|
`response` \| `decoding`, and may carry `error_type`, `upstream_http_status`,
`response_bytes`, `response_oversized`. Diagnostics are **safe** metadata (no query body,
no credentials) and are advisory only — never required to interpret the result.

> A robust consumer keys on `schema` + `provider`, reads the common core uniformly, and
> treats `diagnostics` / `engine` / `browser` as **optional** provider-specific extras.

---

## 5. `status` vocabulary and exit codes

| `status` | Meaning | Terminal? | Which providers | Underlying search exit |
|----------|---------|-----------|-------------------|------------------------|
| `completed` | ≥ 1 verified candidate. | **final success** | both | `0` |
| `empty` | Query ran cleanly, 0 candidates. **This is success, not failure.** | **final success** | both | `0` |
| `unavailable` | The leg cannot run (official: no `SCHOLARSEED_API_KEY`). | not final — host may continue route | `official-api` | `0` |
| `action_required` | Browser needs manual verification (CAPTCHA). Never bypassed. | not final — host may continue route | `visible-browser` | `2` |
| `failed` | A request/launch/navigation/parse error occurred; `error` is set. | not final — host may continue route | both | `1` |

Only `completed` and `empty` are **final** sources of truth. `unavailable`,
`action_required`, and `failed` are structured signals that let the **host** decide
whether to fall through to the next leg or stop. The skill never switches providers
itself.

(Reminder: these are the *search* exit codes from `official.search` / `browser.search`.
`invoke.py` returns the *publish* exit code instead — see §3.)

---

## 6. Candidate object

Every element of `candidates` is exactly:

```json
{ "title": "...", "url": "...", "description": "..." }
```

- **`title`** — non-empty, whitespace-collapsed result title.
- **`url`** — a **direct**, normalized `http(s)` destination. Redirect wrappers are
  resolved (e.g. Bing `/ck/a`), tracking parameters (`utm_*`, `msclkid`) are stripped,
  default ports and trailing-slash noise are normalized, opaque/search URLs are rejected.
  The skill **never** invents a URL and **never** opens the destination page.
- **`description`** — a concise snippet.
  - `official-api`: always **non-empty** (candidates with an empty description are
    rejected at the source).
  - `visible-browser`: **may be `""`** when Bing exposed no snippet for that card.
- Candidates are deduplicated by normalized `url`; at most `limit` (≤ 20) are returned.

> Consumers that require a non-empty `description` (the desktop renderer does) will drop
> browser candidates whose snippet is empty. Treat an empty `description` as optional
> metadata, not as a hard error.

---

## 7. `error` object and codes

`error` is `null` on `completed`/`empty`, otherwise `{ "code": string, "message": string }`.
`message` is human-readable and **not** stable — branch on `code`.

**`official-api` codes**

| `code` | `status` | Cause |
|--------|----------|-------|
| `invalid_query` | `failed` | Query was empty after trimming. |
| `credential_unavailable` | `unavailable` | No `SCHOLARSEED_API_KEY`; **no request made**. |
| `official_api_authorization_failed` | `failed` | API returned HTTP 401/403. |
| `official_api_request_failed` | `failed` | Network/timeout/connection error (e.g. DNS `gaierror`). |
| `official_api_response_invalid` | `failed` | Non-200, oversized, undecodable, or `success != true` / non-list `data`. |

**`visible-browser` codes**

| `code` | `status` | Cause |
|--------|----------|-------|
| `invalid_query` | `failed` | Query was empty after trimming. |
| `verification_required` | `action_required` | Bing presented a CAPTCHA / human check. |
| `execution_denied` | `failed` | The execution environment denied launching a browser (sandbox/permission). |
| `browser_missing` | `failed` | No supported Chrome/Edge/Chromium executable found. |
| `browser_launch_failed` | `failed` | A browser was found but could not be launched. |
| `navigation_timeout` | `failed` | Page/results did not load or stabilize in time. |
| `browser_error` | `failed` | Any other Playwright/session failure (incl. leaving the results page). |

---

## 8. The `codex-native` leg (host-internal, for completeness)

The native leg does **not** use this skill's scripts and does **not** write
`web-search-result.json`. The runtime Web Search tool returns marker-delimited JSON
between `<scholarseed_web_search_results>` and `</scholarseed_web_search_results>`, which the host
validates against a **stricter** schema (`WEB_SEARCH_CANDIDATES_OUTPUT_SCHEMA`):

- envelope `{ schema, status, provider, query, candidates, error }`, `additionalProperties: false`;
- `status` is only `completed` | `empty`; `error` is always `null`; **no** timestamps or
  `duration_ms`;
- candidate items are `{ title (minLength 1), url (uri), description (minLength 1) }`,
  `additionalProperties: false`.

So the **Candidate core `{title, url, description}` is consistent across all three legs**,
but the native **envelope is a strict subset** of this contract (no timestamps, no
`failed`/`unavailable`/`action_required`, no extensions). A consumer that only ever reads
this skill's artifact never sees the native envelope; a consumer that merges all three
legs should normalize on the candidate core and tolerate the envelope differences.

---

## 9. Real samples

### 9.1 `official-api`, `completed` (trimmed to 2 of 9 candidates)

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "completed",
  "provider": "official-api",
  "query": "新疆秋天旅游",
  "started_at": "2026-09-16T06:58:25.959Z",
  "completed_at": "2026-09-16T06:58:28.144Z",
  "duration_ms": 2185,
  "candidates": [
    {
      "title": "新疆秋天怎麼玩？南北疆賞秋全攻略",
      "url": "https://apple-trip.com/.../",
      "description": "新疆秋季（9月–10月）是全年旅遊旺季……"
    },
    {
      "title": "最美的季节，新疆“醉”人的旅游攻略",
      "url": "https://wlt.xinjiang.gov.cn/.../c0e4...shtml",
      "description": "5月去天池，6月可以前往伊犁看薰衣草花海……"
    }
  ],
  "error": null,
  "diagnostics": null
}
```

### 9.2 `official-api`, `failed` (network/DNS — real artifact)

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "failed",
  "provider": "official-api",
  "query": "最新的ai公司财报",
  "started_at": "2026-09-16T04:44:21.132Z",
  "completed_at": "2026-09-16T04:44:21.140Z",
  "duration_ms": 8,
  "candidates": [],
  "error": {
    "code": "official_api_request_failed",
    "message": "The official search request failed."
  },
  "diagnostics": { "phase": "request", "error_type": "gaierror" }
}
```

### 9.3 `official-api`, `unavailable` (no credential — no request made)

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "unavailable",
  "provider": "official-api",
  "query": "最新的ai公司财报",
  "started_at": "2026-09-16T04:40:00.000Z",
  "completed_at": "2026-09-16T04:40:00.001Z",
  "duration_ms": 1,
  "candidates": [],
  "error": {
    "code": "credential_unavailable",
    "message": "SCHOLARSEED_API_KEY is not available for official search."
  },
  "diagnostics": { "phase": "credential" }
}
```

### 9.4 `visible-browser`, `completed` (trimmed to 2 of 10 — real artifact)

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "completed",
  "provider": "visible-browser",
  "query": "帮我搜索最新的ai公司财报",
  "engine": "bing",
  "browser": "chrome",
  "started_at": "2026-09-16T04:04:53.326Z",
  "completed_at": "2026-09-16T04:05:05.499Z",
  "duration_ms": 12173,
  "candidates": [
    {
      "title": "科技公司最新财报：AI出现频次变高，赚钱能力几何？",
      "url": "https://t.cj.sina.com.cn/articles/view/5993531560/1653e08a802001iae2",
      "description": "经检索，科大讯飞2025半年报全文中AI共计出现239次……"
    },
    {
      "title": "科技公司最新财报：AI出现频次变高，赚钱能力几何？",
      "url": "https://finance.sina.com.cn/roll/2025-09-04/doc-infpifik3486109.shtml",
      "description": "中新经纬9月4日电……多家互联网科技上市公司公布2025年半年度报告……"
    }
  ],
  "error": null
}
```

> Note 9.4 has `engine` + `browser` and **no** `diagnostics`; 9.1–9.3 have `diagnostics`
> and **no** `engine`/`browser`. Two browser candidates can share a `title` while having
> distinct `url`s — dedup is by URL, not title.

### 9.5 `visible-browser`, `empty`

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "empty",
  "provider": "visible-browser",
  "query": "..." ,
  "engine": "bing",
  "browser": "chrome",
  "started_at": "2026-09-16T04:10:00.000Z",
  "completed_at": "2026-09-16T04:10:09.000Z",
  "duration_ms": 9000,
  "candidates": [],
  "error": null
}
```

### 9.6 `visible-browser`, `action_required` (CAPTCHA)

```json
{
  "schema": "scholarseed.web_search.v1",
  "status": "action_required",
  "provider": "visible-browser",
  "query": "...",
  "engine": "bing",
  "browser": "chrome",
  "started_at": "2026-09-16T04:12:00.000Z",
  "completed_at": "2026-09-16T04:12:30.000Z",
  "duration_ms": 30000,
  "candidates": [],
  "error": {
    "code": "verification_required",
    "message": "Bing requires manual verification in the visible browser."
  }
}
```

(9.3, 9.5, 9.6 are faithful shapes for code paths not present in the local ledger at the
time of writing; 9.1, 9.2, 9.4 are real captured artifacts with candidate lists trimmed
and long URLs elided for readability.)

---

## 10. JSON Schema (draft 2020-12) for the artifact

The envelope schema is intentionally **open** (`additionalProperties` not `false`) because
the two providers legitimately carry different extension keys. Validate the common core
strictly; accept provider extras.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://scholarseed.local/schemas/web_search_result.v1.json",
  "title": "scholarseed.web_search.v1 result artifact",
  "type": "object",
  "required": [
    "schema", "status", "provider", "query",
    "started_at", "completed_at", "duration_ms", "candidates", "error"
  ],
  "properties": {
    "schema": { "const": "scholarseed.web_search.v1" },
    "status": {
      "enum": ["completed", "empty", "unavailable", "action_required", "failed"]
    },
    "provider": { "enum": ["official-api", "visible-browser"] },
    "query": { "type": "string" },
    "started_at": { "type": "string", "format": "date-time" },
    "completed_at": { "type": "string", "format": "date-time" },
    "duration_ms": { "type": "integer", "minimum": 0 },
    "candidates": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "url", "description"],
        "properties": {
          "title": { "type": "string" },
          "url": { "type": "string", "format": "uri" },
          "description": { "type": "string" }
        }
      }
    },
    "error": {
      "oneOf": [
        { "type": "null" },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["code", "message"],
          "properties": {
            "code": { "type": "string" },
            "message": { "type": "string" }
          }
        }
      ]
    },
    "diagnostics": { "type": ["object", "null"] },
    "engine": { "type": "string" },
    "browser": { "type": ["string", "null"] }
  },
  "allOf": [
    {
      "if": { "properties": { "status": { "const": "completed" } } },
      "then": {
        "properties": { "error": { "type": "null" }, "candidates": { "minItems": 1 } }
      }
    },
    {
      "if": { "properties": { "status": { "const": "empty" } } },
      "then": {
        "properties": { "error": { "type": "null" }, "candidates": { "maxItems": 0 } }
      }
    },
    {
      "if": {
        "properties": { "status": { "enum": ["unavailable", "action_required", "failed"] } }
      },
      "then": {
        "properties": {
          "error": { "type": "object" },
          "candidates": { "maxItems": 0 }
        }
      }
    },
    {
      "if": { "properties": { "status": { "const": "unavailable" } } },
      "then": { "properties": { "provider": { "const": "official-api" } } }
    },
    {
      "if": { "properties": { "status": { "const": "action_required" } } },
      "then": { "properties": { "provider": { "const": "visible-browser" } } }
    }
  ]
}
```

---

## 11. Consumer rules

1. **Trust the artifact, not the exit code.** Decide the search outcome from `status`;
   use the `invoke.py` exit code only to detect a publication failure (no artifact).
2. **Gate on `schema`.** If `schema != "scholarseed.web_search.v1"`, reject the payload as a
   contract mismatch — do not try to coerce it.
3. **`empty` is success.** Treat `status == "empty"` as a valid, final "no results"
   answer. Do not retry it as if it were a failure.
4. **Only `completed`/`empty` are final.** On `unavailable`, `action_required`, or
   `failed`, the *host* decides whether to fall through to the next leg or stop; a
   consumer must not silently treat these as "no results".
5. **Read `error.code`, never `error.message`.** Messages are unstable prose; codes are
   the contract (§7).
6. **Tolerate provider extensions.** `diagnostics`, `engine`, `browser` may be absent
   depending on `provider`. Never require an extension key on both legs, and never fail
   on unknown extra keys.
7. **Candidate `description` may be empty on the browser leg.** Do not reject a
   candidate solely because `description == ""`; `title` and a direct `url` are the
   load-bearing fields. Never fabricate a URL or a snippet that is not in the artifact.
