<a id="预览场景的后端契约与适配边界"></a>
# Backend Contracts and Adaptation Boundaries for Preview Scenarios

## Scope / Non-goals

This page describes which parts of real service contracts the current Desktop preview consumes
and where it differs, so product, design, frontend, and backend teams can collaborate on the same
scenarios. Preview reuses the real renderer, HTTP URLs, DTOs, and event projections; it does not
require the backend to add a “scenario service” or duplicate business APIs. `/__preview/*` belongs
only to the local development preview and is not part of the Serve product protocol.

**Support in the simulated service does not constitute acceptance of the real feature.** This page
does not claim that every page is integrated, nor does it broadly label UI requests that only change
layout, copy, or components as “backend adaptation required.” No new backend contract is needed
when there is no new business meaning or data requirement; visual, interaction, and side-effect
evidence must still be checked separately for simulated scenarios and the real service/Electron.

<a id="文献库存切片"></a>
## Literature Inventory Slice

**current**: `page-literature` retains the old empty inventory and adds non-empty, read-wait/failure,
detail-wait/failure, and metadata-save-wait/first-failure scenarios. An instance-level ledger
unifies the list, counts, categories, tags, projects, details, and notes. Reload preserves the current
instance; reset restores the seed; disposal and cancellation do not commit stale writes. Production
pages have no mock branch.

Following the original client, it supports GET for literature list/counts/facets/tag-facets/projects/
collections/tags, GET/PATCH for details, and GET/POST/PATCH/DELETE for notes. Note updates check
version; metadata does not invent CAS. The list supports only the text, category subtree, tag
intersection, project, without/recent, sorting, and pagination declared by real HTTP. Year, type,
attachment, and unread filters that are present in TypeScript but not declared by the real interface
are not presented as usable features. Unread summaries follow the existing contract; missing
attachment records still count toward registered full text, and “no full text” only means there is
no attachment record. Strict validation of simulated writes does not mean every permissive JSON
behavior of the real backend has been fully reproduced.

Available PDFs reuse the real bytes, file identity, and revision from the reviewed example project;
no fake attachment file is created. Literature attachment records and project asset records have
separate ownership. Attachment open/content/records/regions use the original consumers, and
content supports GET/HEAD, a single Range, and ETag. PDFs are read-only, with no claim of annotation
writes; region analysis is explicitly unavailable. AI results GET returns an empty, not-generated
cache. AI state GET checks the revision against the same literature/attachment and VFS bytes, and
returns the attachment identity, empty results, and a null task; an old revision is explicitly
rejected. Read-only state does not create a task or mean AI execution succeeded. Mock negative-error
mapping does not prove that every real Serve preparation failure code has been reproduced.

**gap**: Native attachment location, category/tag entity management, literature import/download,
attachment and record changes, and AI execution are explicitly rejected as not integrated (501).
Missing full text returns 404; user-local paths are not mapped and the authorization root is not
expanded. These mock contracts and UI checks cannot replace acceptance against real Serve, models,
native platforms, or Windows.

<a id="回答注释引用移除"></a>
## Removing References from Answer Annotations

Context removal from answer annotations reuses `DELETE /api/assistant/sessions/{id}/annotations/{annotation}/context`
and `expected_context_revision`. It removes only note references from the current instance and same
session, preserving the annotation. Each actual removal increments the revision; a stale revision
returns 409 and latest. No matching reference is idempotent and returns the current selection;
unknown sessions return 404 and invalid revisions return 422. The mock does not simulate claim
lifecycle or allow permanent annotation deletion or other undeclared annotation changes. The Serve
Owner verifies real storage, security, and concurrency semantics.

<a id="归档项目错误与显式恢复"></a>
## Archived Project Errors and Explicit Recovery

**current (target integration)**: Task archives reuse the target flow `ArchivedConversation → AiPanel → Stream / Composer`,
sharing history, sources, and activity projections with ordinary conversations. The simulated side
continues to provide the same session DTO; it does not create a separate read-only page. The current
archived conversation thread is readOnly, which disables sending, stopping, approval, and live/SSE
recovery. After restoration, it is accessed through the original ordinary conversation entry point.
An empty history is truly `turns:[]`; the target's removed empty-state copy and old standalone history
component are not restored.

An ordinary standalone simulated session has no displayed child sessions. `GET /api/serve/sessions/{id}/display-children`
returns the same `session_id` and `child_count: 0` for the shared delete-confirmation area to perform
its read-only eligibility check. Unknown sessions return 404; non-GET requests are still rejected
with 501. This does not mean that forks or real-service child-session cascading have been simulated.

Project-layout scenarios only switch the original Workspace menu and
`RendererPreferences.projectLayouts`. Normal left/right swaps preserve the same component and
document tabs. Reload promises only to preserve the layout preference, not draft persistence. Data
and styling are still consumed by the original page; preview does not implement a second archive or
layout renderer.

**The current slice is integrated; the overall work is not yet closed**: failures and successful
empty lists from the original `GET /api/content/projects?includeArchived=true` are displayed
separately. Active-project catalog and archived-task reads are unaffected by the independent-project
failure policy. Single-item restoration uses the original archive POST and remains busy until
restoration and archived/active catalog refreshes finish; stale reads cannot overwrite new results.
No real Serve protocol is added, and production pages do not detect preview mode.

The preview-only `POST /__preview/archives/recover` only clears the simulated project-read failure
explicitly declared as `projectRead: failed` for the current instance. Repeated recovery is
idempotent and does not change projects/preferences/tasks/history; other policies return 409. Reset
creates a new Owner and restores the failure; instances are isolated. Recovery does not happen
automatically based on request or retry count: the task page also reads the same project catalog,
so an auxiliary GET cannot consume a counter to fake recovery on the project page.
F8 opens the original preview console from the settings modal. After explicitly triggering recovery,
close the console and retry from the original project page. Do not modify the Store directly or close
and recreate the settings page to pose as the original retry. This control endpoint is excluded
from production artifacts.

Web consumption has verified persistent failure, loading, retry from the original page after
explicit recovery, and disabled actions while delayed recovery is pending. Real macOS Electron has
verified isolated project archiving, recovery, and persistence across reload; read-only re-entry on
the final build passed. Real backend 503 and long-delay cases have not run, and simulated results do
not substitute for them. Current acceptance prioritizes macOS; Windows remains unverified.

<a id="浏览器设置切片"></a>
## Browser Settings Slice

**current**: The standalone preview host directly reuses the original `BrowserSettings`; it does not
copy the form or enable the production browser switch. At the preview boundary,
`BrowserBridge.policy/history/clearData` uses same-origin POST
`/__preview/browser/{policy,history,data}`. Requests and receipts still follow the original contract
in `src/browser.ts`. These paths are not new Serve APIs. Real Electron continues through
main/preload, and the backend does not need another settings page.

The instance Owner supports reading, adding, editing, removing rules, and the Agent switch. Exact
origin and action/decision values follow the original parser. Revision does not increase when
nothing changes; two ask values remove a rule, and no client CAS is added. Simulated permission
does not authorize any webpage or tool execution. The sample's disabled state and example source
are scenario seeds, not Desktop first-run defaults. History uses an independent UUID per Owner,
counts after search, and paginates in descending time and ID order. Deleting an unknown valid ID
returns `deleted:false`. IDs from old instances or before reset cannot delete samples from the new
ledger.

History cleanup supports the inclusive since boundary of `clear-history`, and `clear-selected`
clears history only. Reads, deletes, and cleanup in the same domain are mutually exclusive; at the
commit point, cancellation and lifecycle are checked again. Invalid payloads return the original
`invalid_command` failure receipt; unknown routes do not return fake success. Reload preserves the
same instance; reset/dispose destroys the old Owner and pending waits so stale writes cannot commit
to a new generation. Policy-read failures are independent of history read/write policies.

Persistent policy-read failure can be cleared by an explicit recovery action in the preview
console, after which the original page button rereads the policy. `POST /__preview/browser/recover`
only clears this instance's failed read policy. Repeated calls are idempotent; rules/history/
preferences/native permissions are unchanged; other policies return 409, and reset restores the
failure. Development-mode remounts repeat reads, so request counts cannot pose as “retry after the
first error.” Archive and browser recovery controls are registered through the same declarative
entry point, not written directly into the Store. If policy-write IO fails, the original page hides
rules it cannot confirm under its existing security policy. Use the original reread to restore the
unchanged inventory and input, then submit again; do not relax production fail-closed behavior.

**gap**: Reopening native webpages, CDP, download selection and configuration, Vault, and
Cookie/cache/site-data cleanup all remain unavailable; no native success is simulated. Current Web
rule/history operations are not acceptance of real disk behavior, security authorization, or native
cleanup. macOS read-only checks covered the original page and natural reads; no real rules were
written, and no history was deleted or cleared. Windows is unverified. Shared-control integration
for the main browser page and viewer is handled separately.

The final Web UI suite for this slice passed 135/135, and the real macOS read-only flow was
evidenced separately. The former only proves that the original page consumes the simulated
contract; the latter does not prove real rule writes, history clearing, security authorization, or
complete browser operation. The standalone Web settings host and production settings modal have
different available widths, so their screenshots do not prove identical host layout.

<a id="浏览器共享引导与模拟快照"></a>
## Shared Browser Guidance and Simulated Snapshots

**current (contract, not product acceptance for this round)**: `page-browser` and `viewer-browser`
use the same original `Browser` component; only the preview host adds an explanation of the
simulation scope. Preview does not change `browserEnabled`, production navigation, components, or
registration policy. It does not add a production entry point for opening the browser or create a
second browser page. The product [browser contract](../browser.md) has removed the inner webpage
tab bar and new webpage button. Both blank and missing targets display the original guide; the
scenario catalog does not restore old controls. Ledger-write wait/failure states with no UI entry
remain domain contracts only, not UI scenarios. Blank snapshots, existing targets, read wait/failure,
and generic unmapped states remain separate.

The same browser Owner can optionally declare a `surface` policy. When none is configured,
snapshot/dispatch still return native-unavailable, without affecting the earlier settings scenarios.
`/__preview/browser/snapshot` and `/command` use same-origin POST and the original
`BrowserSnapshot`, `BrowserReply`, `BrowserCommand`, and parser. The snapshot HTTP request body
accepts only an empty object. Only blank-tab creation, selection, and closing are simulated; IDs are
independent per Owner. Closing the current tab selects the first remaining tab, following real
semantics; after the last tab closes, active is null. Snapshots do not invent an engine, automation,
webpage history, or native target. The preview's protective limit of at most 100 blank tabs is not a
real product quota.

External URLs or search, navigate (including navigation of an existing tab to blank), back/forward,
reload, bounds, devtools, automation, and copy endpoints are all rejected without changing any
ledger. Concurrent writes are mutually exclusive; cancellation or disposal cannot commit after an
await. Inputs are copied before commit, so an in-flight request cannot be mutated to change its final
action. During the original component's read-wait stage, the default start page remains visible; no
nonexistent Spinner is fabricated. A ledger-write protocol does not mean the product has a new-tab
button. The host provides no page/frames, menu, or native-overlay bridge, and blank tabs have no
native viewport.

Only registered browser POST routes may parse valid JSON and pass it to the original typed parser.
Invalid objects such as arrays return `invalid_command`; invalid JSON still returns HTTP 400, and
strict object validation for other APIs is unchanged. The instance generation is checked again after
reading the body and after the Owner receipt. If an old chunked request finishes reading its body
after reset, it returns 409 and cannot write to the new ledger.

Domain cases cover snapshots and identity, rejection, waiting, mutual exclusion, cancellation, and
recovery boundaries. Shared Browser rendering covers current controls, guidance, language/theme,
and in-progress address editing. The two native Mock entry points check only shared UI wiring,
navigation rejection, and reload; the old twelve inner-tab operations are not mechanically copied to
Electron. Original loading/error requirements remain. They are not automatically satisfied by
blank-page guidance or low-level contracts, and the existence of cases does not prove they passed.

**gap**: Production entry is controlled by the browser switch and runtime surface; the existing “New
tab” entry belongs to the browser Owner. The Mock host does not enable that switch, and this page
does not inherit old Web-consumption results or host acceptance from another version. Do not write
saved navigation, insert history, use internal dispatch, or relax production policy to manufacture
start-page acceptance. Read-only evidence from real settings does not replace Browser start-page
evidence. Native content, frames, CDP, real navigation, and Windows still require the applicable
environment and separate acceptance.

<a id="会话产物与模拟发布"></a>
## Session Artifacts and Simulated Publication

**current / the artifact slice is consumed, not acceptance of all states**: `viewer-outputs` retains
the original general requirements and empty state, with two additional scenarios for published
sessions, catalog/history/content waits and persistent failures, and publication after completion.
The original `Outputs` still filters explicit publications from the project session catalog and
per-session history; it does not consume a page-private display array.

`PreviewArtifacts` holds only immutable bytes captured from reviewed files in the current instance,
bound to their identities. Session history holds the public `SessionArtifact` projection. The same
session/turn/file identity is idempotent, and identities are independent across Owners. Renaming or
editing the source file, or editing a resource after publication, does not change the published
snapshot. `publication_id`, role, size, sha256, and media_type come from the reviewed source and an
explicit simulated publication; arbitrary working files cannot be counted as artifacts. Each of the
three stages has a sample, but this does not mean real model generation or authorized publication
execution succeeded.

The same artifact projection is returned through the existing `GET /api/serve/sessions`,
`GET /api/serve/history/{session}`, and session-open snapshot. `artifact_changed` uses the original
`op:upsert` contract and is emitted before the successful terminal state. A simulated long turn can
be stopped from the original Composer. Cancellation/failure does not publish; a missing source that
fails pre-read becomes an explicit failure event, with no partial successful delivery. Old scenarios
without an artifact policy retain the original unavailable capability and empty projection.

`message_delta.data.delta` is an accumulated body snapshot for the same turn/item, not a text
fragment to append. The simulated service publishes accumulated values from the same history body;
live consumption uses the original replacement projection, so replay after a disconnect or re-entry
does not add multiple snapshots together. Consumer regression invokes the real projection segment
by segment and checks that the last snapshot after recovery matches the history body.

The original `GET/HEAD /api/serve/sessions/{session}/artifacts/{artifact}/raw` returns snapshot
bytes, ETag, length, and an explicit read-only header. `GET .../content` follows the binary/truncated
boundary of the original text DTO. Session and current-instance artifact identity are checked
strictly; the raw path parameter cannot switch the source. PUT editing, real import, Save As, native
open, and the publication bridge remain unintegrated and do not return fake success. The backend
does not need a separate page for this slice.

Read failures are governed by separate policies for the project catalog (`scope=project`), history,
and content. The global startup catalog is unaffected by artifact-project policy; global recovery
must not be blocked before reaching the original artifact page. Persistent failure does not disappear
after a request count. `POST /__preview/artifacts/recover` only clears a declared persistent read
failure for the current instance; repeated recovery is idempotent, and other policies return 409.
Reset restores the failure and replaces identity. Instance generation is checked after async
receipts; cancellation/disposal cannot write an old receipt to a new generation. Recovery control
does not modify history, files, or publications. Only macOS acceptance is currently planned;
Windows and real generation/failure/recovery delivery remain unverified.

New sessions still use the original context PATCH to save project_policy with empty refs and the
disabled/academic/web selection metadata, preserving revision and the latest conflict receipt.
Saving a retrieval selection does not run retrieval; the capability flag remains unavailable and no
real service is called. Non-empty context references are explicitly rejected; this subset is not a
complete context simulation.

## Source of truth

- Simulated implementation and consumer assertions: [scenario service](../../preview/service.ts), [service tests](../../preview/service.test.ts),
  [file tree](../../preview/files.ts), and [file tests](../../preview/files.test.ts).
- Literature inventory and note ledger: [literature mock](../../preview/literature.ts), [literature regression](../../preview/literature.test.ts), and [native shared-page consumption](../../preview/native.spec.mjs).
- Single in-memory Owner for project operations: [project mock](../../preview/project.ts).
- Browser-settings simulation: [rules and history ledger](../../preview/browser.ts), [domain regression](../../preview/browser.test.ts), and [native page consumption](../../preview/native.spec.mjs).
- Shared browser guidance: [component regression](../../src/renderer/src/features/browser/browser.render.test.ts), [native Mock wiring](../../preview/native.spec.mjs), and [standalone preview host](../../preview/host.tsx). Ledger-write protocols belong to the domain regression above; they are not UI operations.
- Session artifacts: [pure scenario contract](../../preview/publications.ts), [immutable snapshots](../../preview/artifacts.ts), [domain regression](../../preview/artifacts.test.ts), and [original artifacts page and post-completion publication consumption](../../preview/native.spec.mjs). See the [Serve session API](../../../serve/service/chat/api/sessions.py) for the real read contract.
  Diagnostic-record boundary: [diagnostics module](../../preview/diagnostics.ts).
- Document-read timing: [content policy](../../preview/content.ts). PDF unavailable-region manifest: [region response](../../preview/regions.ts). Real-operation consumer: [document scenario tests](../../preview/native.spec.mjs).
- Page and scenario state: [machine catalog](../../preview/catalog.ts). Catalog registration, `pending`, and `unverified` do not mean a scenario is operable or has passed acceptance; this page does not duplicate the page-coverage list.
- Renderer consumers: [session and event DTOs](../../src/renderer/src/api.ts), [content client](../../src/renderer/src/app/api/content.ts), [workbench document client](../../src/renderer/src/features/workbench/api.ts), and [resource client](../../src/renderer/src/features/resources/api.ts).
- Real backend: [session routes](../../../serve/service/chat/api/sessions.py), [session interaction service](../../../serve/service/chat/service/sessions.py), [project and file events](../../../serve/service/content/api/routes.py), [workbench reads and writes](../../../serve/service/workbench/api/routes.py), and [resource routes](../../../serve/service/resources/api/routes.py).
- Skill catalog and changes: [real capability routes](../../../serve/service/capabilities/api/routes.py); the renderer consumes these through the same [public client](../../src/renderer/src/api.ts).
- Environment and admission: [preview architecture](../architecture/preview.md) and [testing standards](../quality/testing.md).

## Current / Required / Gap / Advisory

Here, **current** means simulated responses implemented in the current source; it is not an
acceptance conclusion for the real product or cross-platform behavior.

- **required**: The simulated and real sides follow the same consumer contract; changes update the scenario, field descriptions, and consumer tests together.
- **gap**: Full-page coverage, real side effects, and final cross-environment evidence are not yet complete; domain-specific differences are recorded below.
- **advisory**: Prioritize completing actual UI consumer paths; avoid adding backend-specific protocols or page branches for demonstrations.

After reading a generic JSON/workspace-byte request body, the preview service checks instance
identity again. If the instance was reset, removed, or disposed while the body was being read, the
stale request returns `409 {detail: "preview_instance_reset"}`; it does not resubmit a turn or
register a timer against the old session. This fences the preview instance lifecycle and does not
add a real Serve protocol.

| Domain | Reused interfaces, DTOs, and state transitions | current: simulated-side scope | gap / limits and adaptation owner |
| --- | --- | --- | --- |
| Startup and session catalog | `GET /api/healthz`, `GET /api/serve/sessions`, `POST /api/serve/sessions/open`; `HealthResp`, `ServeSession`, `OpenResp` | In-memory project/session identities, catalog filtering, reopening the same session, and runtime snapshots | Readiness/capabilities are simulated declarations; they do not prove real Runtime, authentication, or recovery capabilities. The backend already has these interfaces; preview needs no additional interface |
| Conversation and tools | `POST .../turns`, `GET .../events?from_seq=`, `GET /api/serve/history/{id}`; `TurnResponse`, `HistoryResult`, `ProductEvent` | Text submission, thinking, message deltas, simulated tool start/output/completion and failure; `running → completed/failed`; interrupt/terminate become `interrupted` | No model or tool is executed. Attachments, multimodal content, real command output, and complete queue scheduling are not covered. New business events must be defined by the original contract Owner, not invented as preview UI events |
| Approval and submission receipts | `POST .../hil/{request_id}`, `GET .../queue`, `POST .../queue/{id}/reconcile`; `ProductHilData`, `ProductInteraction`, `QueuedMessageReconcileResponse` | `hil_requested → waiting → hil_resolved → running/interrupted`; allow, reject, cancel; direct-submission receipt includes `accepted:true/disposition:direct/turn_id`; terminal state emits `message_removed` for the same submission identity as in the real protocol; reconcile returns applied/not_applied from the ledger | Focused assertions cover receipts and outbox lifecycle, but final UI evidence across all scenarios remains to be completed. Queue currently returns no messages; that does not mean real queuing, editing, deletion, or sending has been simulated. The real backend already has interaction/queue routes; these are not pending backend features |
| Project and catalog operations | `/api/content/projects`, `/api/content/operations/{id}`; project identity and semantics available after preparation | Simulated creation returns `202 {operation,state:"queued"}`; a bounded timer advances queued/running/terminal states, and the renderer reuses the real polling client. A project and separate empty VFS are registered only on success; the example seed project retains its samples. Virtual catalog preview and name/description PATCH are supported; declarative fail-once scenarios support retry after failure | No host directory creation, authorization, or migration is performed; archive/delete and other actions are not fully simulated. reset/dispose cleans up pending tasks. The real backend already has this lifecycle; preview need not degrade to a synchronous response |
| Files and viewer | `/api/resource/tree/list/count/read/raw/write/node/reveal`, `GET /api/workbench/open`, `GET/PUT /api/workbench/content`; `OpenDocumentResult`, `DocumentCapabilities`, ETag/revision | Nine reviewed byte samples, with format mappings below; original-byte reads, text edits, file renames; project tree and PDF record reads bind to the same file source of truth, and document projections use the real viewer as declared by capabilities | PDFs are currently read-only; no annotation writes are claimed. XLS font supply, full versioning/review, import/export, directory creation, and file deletion routes are not fully integrated. Having VFS methods does not mean the full HTTP/UI path is supported |
| File changes | `GET /api/content/cursor`, `GET /api/content/events`; `epoch/seq/project_id/root/kind/path/previous_path` | In-memory modifications emit created/modified/moved events; same-instance subscription and replay | Does not prove real file watching, external disk changes, complete pagination, or persistence across process restarts. Cursor/reset consistency needs separate tests |
| Settings and context | `/api/serve/settings/{key}`, `/api/serve/models`, `/api/assistant/sessions/{id}/context`; preferences and revision | In-memory permission-mode/workflow/auto-review settings, fixed simulated models, limited context selection with empty refs; preview bridge saves isolated UX preferences | Does not simulate real connection creation, key validation, subscription login, or MCP/skill execution. Only new fields require contract extension by the corresponding Owner; ordinary style changes do not require backend adaptation |
| Skill settings | `GET /api/capabilities/skills`, `GET .../{name}/document`, `POST/DELETE .../{name}/activate`, `DELETE .../{name}`; catalog, document, activation, and deletion receipts | Three isolated skill records show a user skill, a built-in skill that cannot be disabled, and a skill with missing dependencies; normal changes and unknown-name/immutable-item errors update the same in-memory catalog | Skills are not executed. Upload, creation, and GitHub import explicitly return `501`; installation success is not faked. Contract regression alone does not prove the real skill lifecycle or all settings UI acceptance |
| Literature and account | List/count/facets for `/api/v1/literatures`, collections/tags, `/api/auth/status/me` | Empty literature collection; default scenario has no account credentials. See the read-only profile contract below for explicit account scenarios | Non-empty literature, attachments, sync, credits, and real login are not covered; a standalone search-results scenario does not prove real search. An empty response proves only the initial state; native login and account security still use the real product path |

<a id="会话执行与传输政策"></a>
### Session Execution and Transport Policies

The catalog declares execution mode, streaming samples, and a one-time transport disconnect
separately through `simulation.conversation`; the service core does not add special branches based
on prompt text, filename, or catalog ID. Ordinary streaming still uses the original three 25ms
samples; cancellation explicitly uses a twelve-part interactive sample with one part per second,
without changing production model or client speed. **current (simulated session policy)**: The same
Session owns history, snapshots, events, in-flight submission reservations, and timers.
`conversation-submit-pending` waits two seconds before acceptance, without allocating a turn or
appending user history; concurrent duplicate requests return 409. reset, disposal, deletion,
interrupt/terminate, or HTTP disconnect cancels the reservation. A still-connected stale request
returns `410 {code:"preview_submission_cancelled"}`. After the delay, instance, session, and
connection are checked again; the write cannot land in another instance or the next turn. This 410 is
preview transport-lifecycle feedback and does not require a new real-backend protocol.

Tool policies reuse `tool_started / tool_output_delta / tool_completed`. In delayed and failure
scenarios, the same pending tool remains during two output chunks, with terminal states done/error;
`success:false` is not disguised as turn_failed. Interruption preserves the existing prefix and
cancels later callbacks. After approval, pending is cleared, a running state is emitted for the same
request/turn, and the response continues after a two-second delay; rejection produces no side effect,
and cancellation becomes interrupted. All turn timer callbacks are bound to the original active-turn
identity, so stale callbacks cannot land on the next turn. There are no tool queued events, real tool
execution, or queue scheduling.

In a failure scenario, the first attempt emits `turn_failed`, and the original continue action submits
a new valid turn. The retry answer is emitted incrementally by paragraph; the combined bytes match
the original default answer. The first message delta is sent to current subscribers before those real
HTTP streams are closed once.

Session continues appending later deltas, terminal state, and `message_removed` for the same client
submission identity to the original history/event ledger; disconnecting does not pause domain
timers. Reconnect handshake waits up to two seconds. The real client retries using its original
backoff and last projected `from_seq`; the service replays only strictly larger seq values before
switching to the live stream. This proves cursor-based stream resumption, not deduplication of
overlapping frames, real model/network failures, or product acceptance of every disconnect state.
Transport timers are independent of domain timers: normal completion/interruption cannot leave a
waiting handshake hanging. reset/dispose cancels the old handshake (410), closes old streams, and
clears heartbeat/domain timers. A new instance does not inherit the first-attempt failure or a
consumed one-time disconnect.

<a id="开发者设置模拟凭据合同"></a>
### Developer Settings: Simulated Credential Contract

Reuse `account.ts` `ApiKeySummary` / `ApiKeyCreated`; ordinary and managed records share the
current instance ledger. Account APIs are integrated only in explicit developer scenarios and
require this instance's bootstrap capability as Bearer. Unknown, cross-instance, or pre-reset
capabilities do not authorize access. Serve preparation routes select a ledger using the same preview
instance identity; this is not mixed with account credentials and does not call
`/api/account/api-keys/session` or a real identity service.

| Endpoint | Simulated response and state | Boundary |
| --- | --- | --- |
| `GET /api/account/api-keys` | `{keys:ApiKeySummary[]}`; sample/empty/delayed/failed | No token; read failure remains 503, and retry does not fake recovery |
| `POST /api/account/api-keys` | `{name:string}` → `ApiKeyCreated` | The non-authenticating `preview-only:` display value appears only in this receipt; it is masked accordingly, and the full value is not stored in the ledger |
| `DELETE .../{key_id}` | `{revoked:true}` | Ordinary records only; unknown and other-instance IDs return 404, managed records return 403 |
| `POST .../{key_id}/rotate` | `{rotated:true}`, no plaintext | Managed records only; deletes the old summary. Later preparation/refresh supplies a new identity. Real credential invalidation and session migration are not simulated |
| `POST /api/serve/skill-credential` | `{ok:true,ready:false}` | Idempotently prepares a simulated managed summary; empty scenarios do not add a record, and there is no real credential environment |
| `POST /api/serve/skill-credential/refresh` | `{ok:true,issued:false,aligned:0}` | Simulates summary lifecycle only; there is no issuance or session alignment |

Ordinary mutation policies are normal/delayed/fail-once, with a two-second delay; invalid writes do
not consume the first failure, and concurrent mutations return 409. dispose, disconnect, and reset
cancel unfinished reads/writes and return 410 without contaminating the new ledger. Generated names
may be empty and are capped at 64, matching the original UI input limit. The in-memory capacity of
100 is a preview safeguard, not a claimed real quota. The account service is outside this repository;
its error codes, name validation, quotas, and security behavior must still be checked by the real
Owner. Simulated results cannot stand in for authentication acceptance. Nothing is copied or sent to
the real clipboard, and no model, external command, or personal configuration is used; an in-memory
browser receipt does not imply persistence.

<a id="文档内容读取与-pdf-区域清单"></a>
### Document Content Reads and PDF Region Manifest

**current (source)**: Explicit `simulation.contentRead.mode` supports `delayed / failed / fail-once`
for Markdown/PDF/Code/Image/DOCX. Initialization resolves the current project and VFS file identity
from the actual document target of the selected catalog entry; the result is not secretly determined
by special filename, extension, or body text. The policy continues to apply after renaming the same
identity; a different identity created at the original path does not inherit it. The policy affects
only `GET /api/workbench/content`; it does not change `GET /api/workbench/open`, raw, save, version,
or review interfaces, and it does not write a second sample snapshot.

`delayed` waits for a bounded period, then reads the current bytes/revision from the same VFS;
`failed` persistently returns `503 {detail:"preview_content_unavailable"}` and the original retry
still fails. `fail-once` returns the same error for the first valid target-content GET, after which the
original retry can succeed. The latter is consumed by request semantics and does not claim to
distinguish framework requests from human actions. Consumer tests require the error to be visible and
no success response before an actual retry click; increasing the failure count cannot be used to hide
automatic requests. Invalid paths and unrelated files do not consume the policy. reset/dispose
cancels in-flight delays, and stale reads do not return normal content; closing the connection clears
the wait, and instances do not affect one another.

The real client reads the open projection first and then content; the original client classifies 503
as retryable, and the real Dock error surface calls `workspace.retryLoad` to reread, with no
preview-mode check added to the page. Deep-link restoration on first launch sets
`navigationRestored` only after the document opens. During that time the App displays restoration
Progress; this must not be called Dock loading. For a delayed scenario, the consumer criterion is
that the real `progress-screen` is visible and the original viewer is absent after the target content
GET has started but before it responds; after recovery, the restoration surface exits and the
original document appears. Reopening from the literature list after closing has not proven Dock
loading: the real resource action activates the document only after its open Promise completes.
Neither service delay nor a successful response counts as acceptance of an internal format-loading
surface. Persistent failure is confirmed through the original retry; then use F8 in Console to
explicitly clear the current instance's persistent failure for the target file, close the console, and
recover through the original retry. `POST /__preview/content/recover` does not recreate the instance
or change files, versions, preferences, or real disk. Only a failed policy can be recovered
idempotently; other modes or no policy return 409, and a disposed Owner returns 410. Even if a domain
timer has resolved but its continuation has not run, disposal/disconnect is checked again. After
await, the service rechecks the instance and project registration; a project whose registration was
removed cannot return stale success just because its file bytes remain. Recovery does not constitute
acceptance of real backend failures.

The real project content GET reads the current project/path and has no identity CAS. In preview,
both editing the same identity and replacing it at the same path return current bytes and ETag; a
missing path returns 404. No additional fake identity conflict is attached to the failure. The
original client's `POST /api/resource/reveal` resolves a location read-only; it does not write a file
or perform a native reveal. Consumer tests must observe its exact project/path and receipt
separately; it must not be counted as a business write or used to allow all POST requests. Project
HEAD/Range and the internal content paths for PNG decoding, Monaco handshake, DOCX parsing, and the
XLS/WASM lifecycle still need separate integration/acceptance. Ordinary transport success and the
original retry do not replace those checks.

`GET /api/workbench/pdf/regions` reuses the `path/project/revision/start_page/end_page` parameters
and original `PdfVisualRegionManifest`. The response uses existing `pdf-lib` to read the actual page
count from the same existing VFS PDF bytes, read-only; it preserves `source_revision` and uses
`schema_version:1`, `coordinate_space:"pdfjs_normalized"`. Preview has no region detector:
`detector_version:"preview-unavailable"`; every requested page explicitly has
`unavailable:true`, `regions:[]`, and is listed in `unavailable_pages`. This does not claim that
detection succeeded and found no results. Unknown files return 404, non-PDF files 415, stale
revisions 409, missing parameters or invalid/out-of-range page ranges 422, and malformed PDF parse
failures 422. Instance and file identity/revision are checked again after parsing, preventing a
manifest from stale content or an old instance. Unimplemented requests such as image cropping still
explicitly return 501; no formula, image, table, or detection result is fabricated.

**gap / difference**: This slice covers HTTP read delay, failure, and retry, not PDF decoding failure,
encryption, region recognition, real filesystem failure, or cross-process recovery. Passing contract
tests is not final UI acceptance of the scenario. Browser consumption and screenshots must be checked
separately on the final version; they also do not replace real Serve/Electron and cross-platform
acceptance.

<a id="账号只读场景合同"></a>
### Read-Only Account Scenario Contract

**current**: The declared policies for `settings-account-states / ready / pending / failed / anonymous`
are respectively `no-base / ready / delayed / failed / anonymous`. Control-plane
`GET /__preview/state` returns the current instance's `account: {instance, mode, capability}`.
Ordinary scenarios follow the global login selection; an explicit account scenario's declared policy
takes precedence but does not clear the global selection. The capability is a random, in-memory
opaque value per instance; it is not a JWT, user token, or persistent login. The bridge strictly
checks instance, mode, and format, then uses the public `setAccountBase` to set same-origin loopback.
`getAuthToken` returns only that capability, and `setAuthToken` accepts clearing only; supplied
credentials are not used.

`GET /api/auth/status` remains `enabled:false`. Explicit scenarios other than `no-base` return
`account_base_url` for the current local request; ordinary scenarios also set a same-origin address
according to the current global policy, while `no-base` keeps the address empty. The real client reads
`GET /api/account/me`: only a Bearer capability from the same instance is accepted, and the original
`AccountProfile` `user_id/nickname` is returned with the nickname clearly identifying a simulated
user. Delayed scenarios wait for a bounded period and then return the same profile; failed scenarios
persistently return `503`, including on retry. Anonymous scenarios have no capability and follow the
client's signed-out branch without faking success. reset/dispose invalidates old capabilities and
ends in-flight waits.

**current**: `GET /api/account/credits` is guarded by the same-instance capability, delay, failure,
and disposal fences. An authorized ordinary scenario explicitly returns
`503 {code: "preview_credits_unavailable"}`, meaning no simulated credit data exists; it does not
fake a balance or relax metering. The original client retains simulated login and displays a balance
placeholder; diagnostics record the explicit 503 instead of treating it as an unknown-request 501.
Missing or cross-instance capabilities still return 401. Disposal and reset make in-flight stale
reads return 410, including the microtask race before recovery of an authorized read. The real credit
service is not called. Project-center consumer regression also prohibits unknown 501 requests from
appearing on the actual page.

**gap / difference**: Read-only profile and unavailable-credit handling do not mean real login or
billing has been implemented. Mutations such as phone, password, or nickname changes and real login
remain unimplemented; no real account action is performed. The original client's default cookie
semantics are unchanged. Simulated authentication does not use cookies or proxy the account service,
and diagnostics do not record the capability. Backend and Electron continue to use the original
account contract and credential boundary; no preview branch is needed in the page.

<a id="反馈消费边界"></a>
### Feedback Consumption Boundary

**current**: `POST /api/serve/feedback` uses the real `submitFeedback` multipart fields. Normal
scenarios return `{id}`; empty descriptions and attachment-validation failures return `422 detail`.
The catalog scenario's `simulation.feedback` explicitly selects `502` or `429`; results are not
secretly switched based on user text. Image count, per-image/total image size, JSON report, and
description length follow validation by the real Owner.
**gap / difference**: Preview additionally limits the entire request to 45 MiB; exceeding it returns
`413`. Parsing is in memory only; system logs or traces are not collected and attachments are not
uploaded. Success receipts additionally declare `simulated: true`, `bundle_bytes: 0`. Diagnostics
retain only bounded counts and markers indicating whether user-requested collection actually
occurred; they do not retain body text, email, filenames, or attachment bytes. reset clears receipts
and changes epoch. This consumer flow is not acceptance of real feedback reporting or native
screenshot functionality.

<a id="诊断与隐藏设置消费边界"></a>
### Diagnostics and Hidden Settings Consumption Boundary

Diagnostics from `/__preview/state` are development-preview data; they do not require a corresponding
real backend interface. Request summaries are stored with a per-instance bound and include
method/path/status/duration/outcome, but not query parameters, headers, or body. Event summaries are
derived from the same session and file-event ledgers; they cannot become a second mutable event
source of truth. After reset, old requests and events do not enter the new instance.

The account is shown as signed in, with identity actions, only after the real client confirms profile
success; loading and failure each display their own state, error, and retry. The current isolated
workbench account remains in the `no_base_url` error state; it is not changed to anonymous or made
to appear signed in. Additional bilingual ready/loading/error/anonymous consumer regression uses a
local HTTP sample boundary and proves only the shared content rendering state machine. It does not
prove that the workbench offers every selectable account scenario or that real account login works.
The permissions page uses status copy from the account namespace; the browser still accurately
shows native capability as unavailable. Workbench permission scenarios now use a typed bridge for
normal-unavailable, bounded two-second delay, and persistent-failure policies. The console can
select these directly; refresh after failure uses the real component callback and queries again.
Three real UI-consumption cases passed. System permissions are not changed, authorization is not
simulated, and the bridge contract is not misrepresented as a new HTTP interface for backend
adaptation.

<a id="版本读取与封存"></a>
### Version Reads and Sealing

**current**: `GET /api/resource/capability`, `GET /api/resource/files/{file_id}/versions`,
`GET /api/resource/versions/{id}`, and GET/HEAD/single-Range content reuse the same VFS identity
and immutable snapshots. Version scenarios advance the current file bytes using a reviewed modified
fixture, so historical and current versions are not independent static responses; ordinary scenarios
retain the initial snapshot. Version comparison follows the real client in reading both versions'
content separately and does not depend on a server unified diff. `POST .../files/{file_id}/versions`
seal checks disk/head/pending fences and the idempotency key, returning the real error structure on
conflict. Unknown versions and stale versions from other instances cannot be read. If an annotation
snapshot is missing, the response is explicitly 404; empty success is not fabricated.

**difference / gap**: Preview limits are 1 MiB per file, 64 MiB total version bytes, at most 50
versions, and 128 seal receipts. Capacity is checked before modifying the VFS. These are development
preview budgets, not real service limits or disk persistence. restore, alias, delete, and server
unified diff are not integrated; comparison support is not described as full version-lifecycle
coverage.

<a id="批次审阅与文件冲突"></a>
### Batch Reviews and File Conflicts

**current (HTTP client contract)**: Each project within an instance uses `PreviewReviews` with the
single Versions/VFS. Scenarios create a pending candidate, and the tree node's version status
exposes the real review entry point. Supported operations include `GET /api/resource/review-batches`,
batch details, member `base/candidate/current`, and `POST .../commit`. Decisions follow the real
client's accept/reject/revise, pending revision, disk revision, and idempotency key. Candidates are
not sealed; after completion, file identity, version head, and resource content events remain
consistent, with no separate writable copy. File `pending`, review base, `review/conflict`, and
`review/reconcile` reuse the same review source of truth. Real API consumer tests cover first-commit
failure, duplicate receipts, old batches, cross-instance use, revision fencing, and conflict
recovery; they do not replace browser batch-review viewer acceptance.

**difference / gap**: Currently, only existing files at the same path are covered. Unsupported
creation, deletion, and restoration across paths explicitly return a conflict; success is not faked.
The old single-file review POST and global pending list are still unwired. Conflict scenarios create
drift through external VFS writes. If the user has read the latest revision and explicitly accepts,
the contract allows the candidate to be restored; an expired commit must not be fabricated merely to
show an error. The real backend interface already exists; preview adds no product protocol.

<a id="隐藏资料模块与检索结果"></a>
### Hidden Literature Module and Search Results

**current**: The literature module reuses the real registry contribution. File rows always reserve
space for menu controls, preventing the pending-review button from overlapping the absolutely
positioned menu between rest and hover states. Consumer assertions cover real clicks, non-intersecting
rectangles, and the intended hit target; they do not bypass behavior with force click.
`GET /api/serve/settings/file-versions` derives read-only configuration and scan summaries from the
Versions Owner and same VFS, allowing the module to mount. Policy changes, cleanup, and other POSTs
remain explicitly unsupported.

`GET /api/literature/searches` seeds completed historical tasks only in literature-search scenarios.
After startup, the real client restores the tab, and the user clicks to see the real table, selection,
and details. The result-state interface returns the same reviewed paper identity. `POST /api/resource/web-search`
uses the original request/official output schema. After real form submission,
it displays two candidates explicitly labeled as mock and allows selection. Candidate URLs use
`example.invalid`; no network search or body scraping occurs. The webpage-icon route returns an
empty response only for reviewed sources and does not proxy arbitrary URLs.

**gap**: This slice does not unlock hidden literature search initiation/login and does not simulate
successful ingestion, scraping, import, or external links. Search has no selectable
loading/empty/error/retry policies yet; a successful result state cannot count as full-flow coverage.
Five batch-review and two search real-UI consumer cases passed, but multi-file/Office review, old
single-file snapshots, and the real Agent disk lifecycle still need separate acceptance. Samples are
not published papers; real DOI or arXiv identities are not invented.

<a id="最小文件读写契约"></a>
### Minimal File Read/Write Contract

The single sample inventory is the [reviewed registry](../../preview/documents.ts). It includes
Markdown, Python, and PDF from minimal-project, an existing PNG, DOCX/XLS from the Office corpus,
and preview CSV/TSV and unsupported-format samples. The [loader](../../preview/samples.ts) validates
SHA256 and the source manifest before applying instance-isolated in-memory overlays. XLS uses the
Office viewer, CSV uses spreadsheet, and TSV uses table. Unimplemented conversion requests fail
explicitly; bytes in another format are not passed off as successful conversion. Reviewed
prebundled fonts are supplied for XLS, but actual visibility remains to be verified. This does not
grant system-font permissions or prove consistent Electron layout; the existence of a sample is not
acceptance that it works.
`POST /api/resource/reveal` resolves the same VFS using only project/path from the body and returns
`{absolute}`. Missing paths return `404 node_not_found`; traversal is rejected, and query parameters
cannot replace project identity. This is a virtual path, not authorization to access the user's disk;
actual native open still explicitly returns `desktop_bridge_unavailable` from the bridge. Personal
directories are not read, the real disk is not written, and user files are not included in samples.
File `identity` is preserved on save/rename, `mtime` is in seconds, and `revision` is calculated from
actual bytes as `sha256:<hex>`. Byte copies are returned to prevent callers from mutating the
inventory.

```text
GET /api/workbench/open?project=<id>&path=readme.md
  → OpenDocumentResult {revision, content_url, asset_id, capabilities, ...}
GET /api/workbench/content?project=<id>&path=readme.md
  → 原始字节；ETag: "sha256:<current>"
PUT /api/workbench/content?project=<id>&path=readme.md
  Content-Type: application/octet-stream
  If-Match: "sha256:<current>"
  → 成功后读取新 ETag，再次 GET 必须得到同源新字节
```

The comments above indicate that GET returns raw bytes with an ETag, and that a successful PUT must be followed by reading the new ETag and verifying that a subsequent GET returns the new bytes from the same source.

**required (real contract)**: Real submissions require octet-stream and a valid `If-Match`; success
returns `204` with a new ETag. Missing/invalid revision, weak ETag, conflict, and unsupported media
type follow the original error semantics. The current simulated side now covers missing revision
with `428`, conflict/weak ETag with `412`, wrong media type with `415`, and success with `204` and a
new ETag. It also accepts an unquoted revision, matching the real side. Focused assertions do not
prove idempotent submission, automatic versions, or real disk writes. “Saving works” must not be
described as full contract alignment; do not relax the production client or backend to hide simulated
differences.

**required (session contract)**: Events retain `v:2`, monotonically increasing `seq`, `session_id`,
and associated `turn_id/item_id`. Approval links to the original `request_id`; approve/reject/cancel
must have distinct observable results. `accepted` proves receipt only, not turn completion. `reconcile`
must report applied/not_applied/still_unknown based on the actual submission identity; it cannot
always return success to clear a frontend pending state. Completion of this batch of fixes is judged
from final source and consumer tests.

Session pinning and archiving now use the real `PUT .../pin` and `PUT .../archive`; receipts include
`session_id` and `pinned/archived` state. These are no longer replaced by mock-only POST methods.
Real persistence and reopening still need separate acceptance.

<a id="ownership--dependency"></a>
## Ownership / Dependency

Real DTOs, events, and business state belong to their original Serve/Runtime Owners. The preview team
maintains a limited simulation of existing contracts; it does not ask the business backend to
implement `/__preview/catalog`, `/__preview/state`, or `/__preview/reset`. These development
interfaces only manage scenarios, isolated preferences, and cleanup; production exclusion is
verified by the [build check](../../preview/verify.ts).

For new UI, first determine whether the required data can be expressed by the existing contract. If
so, add a sample/state to the same consumer path. Only when it cannot be expressed should new fields,
validation, events, errors, and compatibility semantics be proposed, with both real and simulated
implementations updated together. Native pickers, WebContentsView, system permissions, and
installation/update cannot be replaced by a browser mock.

<a id="mcp-设置配置"></a>
### MCP Settings Configuration

**History (retired on 2026-10-29)**: The standalone MCP settings page and its preview catalog,
scenarios, and page tests have been removed. The user entry point is now the connector in Extensions.
The following records only the preview contract of the old page; it does not mean that the page can
currently be opened. The underlying configuration interface, preview configuration model, and unit
tests are retained. Real user data is not migrated or deleted.

The original `McpSettingsPage` consumes `GET/PUT /api/settings/mcp` through the existing typed
bridge. Preview stores only `configuration` with `schema_version:1 / revision / servers` in
instance memory. Revision increments only on a successful write; an old expected_revision returns
409. Delayed writes compare revision again immediately before commit. Reload reads the same instance;
reset/dispose or disconnect cancels old waits. No real MCP configuration file is migrated or written.

Scenario policies in `simulation.mcp` separately declare normal/delayed/failed for reads and
normal/delayed/fail-once for writes. Invalid requests and conflicts do not consume the first failure;
the first valid write failure leaves configuration unchanged, and the user resubmits through the
original form. The original page's waiting, error, enable/disable, removal, and refresh behavior
remains controlled by the real state machine. After read failure, the summary reuses the original
loadError message instead of showing “loading” after the error has settled. Mock error policies and
real UI regression first exposed this issue, then verified the correct summary through the original
refresh entry point. Enabled configuration explicitly returns `failed`, `tool_count:null`, and
`safe_error:"preview runtime not executed"`; disabled configuration returns disabled. supported
means preview supports consuming the configuration, not that a real MCP connection or tool is usable.

**difference / security**: The real interface's `require_host_process` and host proxy remain
unchanged; preview neither holds nor fabricates a Host-Key. HTTP URLs and stdio command/args are
in-memory configuration text only; no requests are sent, commands run, or servers probed. Real
fields are retained, but headers/header_secrets/environment/environment_secrets accept only empty
objects. Non-empty mappings and URL queries return 403 without echoing the input. Other format errors
return 422, over-budget requests 413, and disposal/cancelled waits 410. URLs reject userinfo,
fragment, and invalid protocols. Prohibiting all queries is an explicit preview restriction stricter
than the real contract. Free text is not a general sensitive-information detector; collaboration
samples use reviewed virtual configuration only, and real keys should not be entered. These checks
must not be described as DLP for arbitrary text or a complete security audit.

**gap**: Server ready, OAuth/secret refs, tool discovery/calls, stdio processes, and network
lifecycle are not simulated. Nor does this prove real backend file persistence, host permissions, or
MCP availability in an installed build. The real backend already has this contract; preview policies
do not require new DTOs from the backend, and adaptation still consumes the original shared page.
Browser configuration interactions in this batch use HTTP samples. The stdio form fields and visual
branches such as auth_required have no corresponding consumer scenarios yet, so the current five
scenarios cannot be said to cover every key MCP state.

<a id="模型服务只读合同"></a>
## Model Service Read-Only Contract

**current**: The normal settings entry reuses the model-service tab in `AccountPanel` and reads
`GET /api/serve/model-profiles`, `GET /api/serve/model-providers`, and the existing
`GET /api/serve/models` through the real client. Connection DTOs retain the real public structure.
Reviewed samples use `example.invalid`, are disabled, have no key, and are non-OAuth. The two
selected models are capability declarations only and do not imply inference is possible. Provider
presets return an empty array; the real interface still shows its built-in entry for adding a
provider, rather than copying a separate empty state.

Each instance and reset uses a new connection identity; reload in the same instance preserves
profile consistency, and returned values are independent copies. Four policies are provided: sample,
empty configuration, delayed read, and persistent 503. Retry does not fake recovery based on request
count; reset/disconnect cancels old waits. Save, enable/disable, visibility, deletion, probing, and
model discovery are unsupported. Old or cross-instance connection IDs return 404; unsupported
operations for valid IDs return explicit 501. Input is not persisted, no upstream is contacted, and
OAuth or inference is not executed.

**gap**: This slice verifies only list/filter/detail and selected-model reads; it does not cover
editing/saving, connection availability, OAuth, refreshing the real model catalog, or inference. Real
Electron can verify page reads under natural configuration only; browser-injected errors, samples,
and delays are not treated as equivalent validation of the real service.

<a id="文件设置配置合同"></a>
## File Settings Configuration Contract

**current (integrated in this round)**: File settings reuse the original `FileVersionPage` and read
the policy through `GET /api/serve/settings/file-versions`. Count and size fields automatically call
POST on the same path without `preview_token` through the original blur/Enter behavior. The current
production page hides advanced rule settings; hidden controls must not be restored or a speculative
confirmation dialog invented for the demo. Auto-save and formatting switches continue to use the
existing isolated preference storage.

The real Owner's `resources/service/retention.py:configure` only validates and saves configuration;
it does not read or clean project history. Therefore, zero for the impact count and an empty token in
the configuration receipt have explicit production semantics. The simulated integration likewise
only updates the current instance's policy. The GET scan overview is still derived from the same
VFS/Versions source; it does not claim that changing the configuration trims simulated history
capacity. Normal, submit-wait, and first-valid-submit-failure scenarios are consumed through the
original controls. On error, input is retained and retry follows the original toast action; invalid
input does not consume the first failure, and reset cancels old waits. Modes, integer ranges, and error
receipts follow the real protocol. Preview intentionally rejects non-string/array patterns types
strictly, while the real service ignores or stringifies some inputs; the current real page sends
strings, so it is unaffected by this difference.
The original Enter auto-save path once accidentally activated notification navigation through a
default action after blur. The shared page now prevents the default action before blurring both
fields; simulated consumer tests retain keyboard timing as well as input/save/retry assertions. The
focus constraint itself is unchanged; see the [interaction standards](../design/interaction.md) for
general requirements.

**gap**: Token-bearing apply, `/preview` impact plans/expiration fences/history trimming are not
integrated and must not return fake success. Read failures have no consumer scenario in this round,
and the existing surface has no separate read loading/error state. Any improvement still needs to be
delivered across shared UI, mock, and real Electron; an error message must not be created only for
preview.

<a id="数据存储与虚拟目录"></a>
## Data Storage and Virtual Directories

**current (integrated in this round)**: The original data-storage page reads the host `StorageConfig`
and `GET /api/serve/workspace-root` `{root, configured}` separately. The former's configured is
a boolean for the Home source; the latter is an explicit container path string. They are not
interchangeable. Home is read-only at runtime, and both preview eligibility fields for changing
Home are false. Home/runtimeStore and candidates in the preview bootstrap are explicitly virtual
`/preview/` identifiers; no personal directories are resolved.

The original “Change” button uses `bridge.pickDir()` to open a reviewed candidate Dialog in the
preview host. Confirm is disabled when nothing is selected; cancel, Escape, and close return null
without sending PUT. After selection, the original page sends
`PUT /api/serve/workspace-root {root:string}`. The receipt follows the real
`{root, configured, restartRequired}` shape and changes only the instance's configured; effective
root and existing projects/VFS remain unchanged. The simulated restart notice does not restart,
migrate, probe the new root, or perform native permission operations. Invalid, stale, and
cross-instance candidates are rejected. Delayed and first-valid-submit-failure scenarios must be
consumed through the original busy state, failure notice, and retry after selecting again. Picker
receipts have a single consumer; if a request is already active, repeated calls return null so
multiple callers cannot each submit PUT with the same path. Cancel/Escape/unmount settle as null and
do not access the browser file-picker API.

**current (dual-source reads)**: The shared page manages loading/ready/error separately for Home
and the container root; failure on one side does not clear the other. Host rejection and a null
workspace-root both use the original error and retry surface. Changes are disabled until the
container root is ready, and the picker stays mutually exclusive from opening through save.
Unmounting and read-generation fences prevent old receipts from overwriting new configuration;
path resolution and real write protocol are unchanged.

The preview bootstrap provides only reviewed DTOs and virtual candidates; a page read policy must
not block the entire startup. Each `storageConfig()` call uses `cache: no-store` to read the current
configuration from the same Owner through
`GET /__preview/storage/config?previewInstance=…`. On HTTP failure, the response body is fully
consumed before rejecting the call; it does not fall back to bootstrap or leave an unconsumed
response that is cancelled on reload. This path belongs only to the preview service; it is not a new
API for the backend to implement. The container root continues to use the original GET.
`homeRead` / `workspaceRead` independently choose normal/delayed/failed. failed persistently returns
the declared 503, and the original retry does not auto-recover based on request count. Console
`POST /__preview/storage/recover` only clears the current instance's read failure, after which the
original page must retry. It does not change configuration, VFS, registered projects, effective root,
or write-failure policy. Reset and disconnect cancel in-flight waits.

**current (same-host consumer)**: First-run eligibility checks also consume `storageConfig()`. A
rejected read displays a persistent error Toast and the original retry; the settings page cannot
catch the error itself and then claim there is no unhandled error. A failed read does not generate
default eligibility or automatically mark first run complete; once first run is complete, eligibility
is not read again. If no path is known yet, the settings page does not render an empty-path decoration
block. If a value is known, failure from the other source must not clear it. An external Toast is not
forced through an open settings Modal; real consumption closes settings before using first-run retry.
Browser request timing showed that default cache behavior queues four reads of the same URL, so the
preview host must explicitly disable caching. It must not lengthen the original page's wait criterion
or change domain delay to mask this; normal/failure DTO contracts stay the same.

**gap**: Real host read failure and recovery have not been accepted in a controlled environment;
mock does not replace a real IPC failure. In this batch, real Electron only mounts Storage
read-only; it does not select or submit a directory. In a historical version before integration,
Archive tabs mounted both tasks and projects. Target `208730236f` removed the task tab from Settings,
keeping only projects; tasks are read through the sidebar of their owning project. Native
authorization-root synchronization in the catalog GET client and HTTP business changes must still
be observed separately. The absence of HTTP writes or an unchanged configuration hash alone cannot
prove there were no host side effects.

<a id="归档与模拟授权根合同"></a>
## Archive and Simulated Authorization-Root Contract

**current (integrated in the target)**: Archive settings directly consume the same instance project
ledger; the removed task tab is not restored. Tasks expand the archive area from the original project
navigation and open a read-only session; no second list is maintained solely for screenshots. Task
details use the original history interface to return `kind:text, role:user/assistant` and tool
records. The user role shares the history projection criteria with the main conversation. Background
catalog refresh should coalesce with in-flight archive reads rather than cancel and permanently
starve requests with the same delay. Three dynamic session/project catalog clients use the explicit
`LIVE_CATALOG_REQUEST` `cache:no-store` request policy, avoiding serial waits under Chromium's cache
lock for same-URL requests from StrictMode and parallel catalogs. This changes only the catalog
request policy; it does not change default caching for all APIs, credentials, 401 propagation, or
original timeouts, and does not tune simulated delays to make checks pass.

| Consumer path | Shared contract and simulation semantics | Real backend / limits |
| --- | --- | --- |
| `GET /api/serve/sessions?scope=project&project_path=...&archived=true`, original history GET | Current-project sample or genuinely empty inventory. List/history independently support delay and persistent 503; retry from the original task error entry may still fail. Details are read-only. The two global simulated tasks belong to different projects, so the current sidebar is not expected to show both at once | Real interface already exists; no preview-specific history protocol is added. Model execution is not simulated. A global read-only catalog can be tested independently, but does not pose as current-project consumption |
| `PUT /api/serve/sessions/{id}/archive` | Synchronous 200 with `ok,session_id,archived`; restore updates the same catalog identity | Real archive while running may terminate/drain; mock explicitly rejects running sessions with 409, and that termination path is not simulated |
| `DELETE /api/serve/sessions/{id}` | Synchronous 200 with `ok,session_id`; deletes history, snapshots, event stream, and pending tasks; old ID is inaccessible | A synchronous task receipt must not be used to deregister a project |
| `POST /api/content/projects/{id}/archive` | Returns the full ProjectRef and `archived_at`, updating the same ledger; rejects invalid projects and the current runtime root | Real interface already exists; runtime root is not the project ID currently selected by the renderer |
| `DELETE /api/content/projects/{id}` | 202 with a 32-character hexadecimal `operation` and `state:queued`, polled through the original client's operations endpoint; terminal `result:{id,removed:true,files_kept:true}` | Deregistration does not delete files. Client disconnect after acceptance does not cancel an accepted operation |

**current (wait and failure)**: Writes support normal, delayed, and first-valid-submit 503 policies
per instance; invalid requests do not consume the first failure. Project batch operations are
serialized and count partial successes, and failed items remain selectable for retry. While a
dangerous confirmation is in flight, confirm/cancel and Escape close are disabled; close explicitly
after the business operation reaches a terminal state. Receiving 202 is not treated as completion.
reset/dispose isolates stale reads and unaccepted writes; terminal states for accepted operations and
observer lifecycle are tested separately. Project deregistration preserves VFS bytes, but every
resource/history entry point still checks project registration, so the old ID cannot be read again.

**current (preview control only)**: `POST /__preview/roots` accepts
`{scope:workspace|session|external,mode:replace|add,roots:string[]}` for an explicitly identified
instance, and accepts only exact virtual roots from the current ledger. It rejects local-machine,
parent/child, and cross-instance paths. external sync follows the real `writableRoots` contract,
including the registered project's own root; having no external links does not mean the set is
empty, and deregistration invalidates a root immediately. The bridge returns true only when both
HTTP succeeds and `ok:true`; failure retains rejection diagnostics. The set grants no OS permission
and does not replace resource-access checks. `DELETE /__preview/state?previewInstance=...` destroys
only the exact explicitly named instance; it does not create a missing instance or clear other tabs.
Consumer tests use their own new service, save evidence to disk first, stop page polling, and then
destroy their own instance. Playwright closes the browser context and trace normally; the 100-instance
limit is not raised to hide leaks.

**current (scenario migration)**: `settings-archives` retains nine project scenarios; the task's
nine policies are consumed through `page-resource / project-archives-*`. Requirements from the old
`settings-archives-history-*` moved to their corresponding `project-archives-history-*`; history is
not fabricated in Settings and the old compatibility entry is not retained. Normal/wait/failure/
write policies still come from the same Archive Owner, with no new service interface or fields for
the page migration. The original mixed empty/dark-mode consumption was split into separate entries.
Consumer annotations are registered against the actual page and scenario; cross-page associations
are not used to fake a pass.

**gap**: There is no corresponding runtime evidence yet for real-backend read errors or delayed
recovery. Tasks have no multi-select, and archive settings and task navigation have no search
controls; those interactions are not fabricated. Web-simulated root synchronization does not prove
native realpath/permissions; applicable real Electron and Windows acceptance is recorded separately.

<a id="目录浏览增量合同"></a>
## Catalog Browsing Incremental Contract

`GET /api/content/projects/{id}/tree` follows the real DTO and returns `root,path,total,offset,nodes`,
with 100 entries per page, directories first, then name order; the final-page offset is capped at
total. Invalid offset returns 422. `GET /api/resource/list?project=...` recursively returns
directories and files from the same VFS. Directories use `file_type:dir`, and count is the number of
direct children; it does not return only manifest files or root-directory children. Directory
`updated_at:null`; file type is the real uppercase extension (for example, `MD`), or an empty string
when there is no extension. Type filtering and date display do not depend on page-side mock-specific
normalization. `GET /api/resource/tree` uses the same paginated projection, but as an auxiliary root
read it does not consume first-read or subsequent-page policies. Open, raw bytes, file count, and
version identity still come from the original VFS; browsing does not create another data ledger.

Preview declares `simulation.browsing`: seed is sample/empty/paged; listingRead and
explorerRead independently support normal/delayed/failed; explorerMore independently supports
normal/delayed/fail-once. Policies bind only to the current instance's initial target project; other
valid projects operate normally and invalid projects are still rejected. The first valid non-empty
request for a subsequent page can fail once; auxiliary reads, invalid pages, and the last page do not
consume that failure. `POST /__preview/browsing/recover` only clears a persistent first-read failure
for the instance's target project. It does not change VFS, page ledger, preferences, or native disk;
without a recoverable policy, it returns 409. reset/dispose/disconnect cancels stale reads and
rechecks instance and project validity before returning.

The original Explorer preserves existing nodes and an explicit error when append fails, then retries
the same offset. Refresh, path/project changes, unmount, and remount prevent an old page from
writing back or an old finally block from unlocking a new request. The literature list has no
frontend pagination, so “load more” is not fabricated. The real backend already has both read
protocols. Simulated failure/recovery does not prove acceptance of real disk failures or OS
permissions. Persistence of an independent empty directory, symlinks, and mounts are outside the
current VFS capability.

<a id="正反例"></a>
## Examples and anti-patterns

- Positive: Adjust the real Composer/tool-card styling, reuse existing events, add a simulated branch, and collect separate Web and Electron evidence; no backend interface is needed.
- Positive: If mock project creation skips an operation, fix the simulated lifecycle and add consumer assertions; do not record the difference as an incomplete backend feature.
- Negative: Do not claim that queueing and security authorization passed because the queue is always empty or the approval button disappeared.
- Negative: Do not replace production state projection with `__preview` return values, internal Store dispatch, or a separate dedicated DTO.

## Enforced by

Use [Desktop scripts](../../package.json) as the source of truth for actual checks. Focused assertions
are in `preview/service.test.ts`, `preview/files.test.ts`, `preview/catalog.test.ts`, and
`preview/verify.test.ts`. They check simulated HTTP/event consumption, file invariants, catalog
contracts, and production exclusion, respectively; they do not replace real service/Electron
acceptance. Check document structure, links, and registration with
`pnpm ops ci check docs workspace`; the main task maintains navigation registration.

## Update triggers

Update the affected domain when new UI introduces fields/errors/events, the simulated service adds
or tightens routes, samples or capability declarations change, or the real backend contract changes.
For each update, state only the current differences and uncovered states; do not carry historical test
passes forward as final acceptance.

## Stop condition

This batch is ready to hand off once interfaces, DTOs, samples, simulation differences, and Owners are
traceable; it does not wait for every domain to rewrite the backend. Report scenario operability,
protocol consistency, evidence from both environments, and native-platform acceptance separately.
Final UI evidence for unrun project/approval branches, complete queueing, and unrun real paths must
remain marked as gaps. Passing documentation checks or unit tests does not justify claiming that all
pages or all features are complete.
