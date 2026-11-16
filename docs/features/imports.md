<a id="资源导入与任务中心"></a>
# Resource Import and Task Center

<a id="适用范围与职责"></a>
## Scope and Responsibilities

Read this page when changing resource copy/link imports, background task progress, cancellation/retry, or the task center.
It carries forward valid responsibilities and decision rationale from the old resource-import design. It distinguishes current source mechanisms from target constraints and does not treat historical test results as current product acceptance.

| Owner | Responsibility and Actual Entry Point |
| --- | --- |
| Serve Resources | Import job orchestration, ledger, and HTTP/SSE; [API](../../apps/serve/service/resources/api/jobs.py), [service](../../apps/serve/service/resources/service/jobs.py), [persistence](../../apps/serve/service/resources/persistence/jobs.py) |
| Serve Content | Source, target, and link-authorization boundaries; [Content](../../apps/serve/service/content/), [shared content contract](../../apps/serve/service/platform/content.py). Resources must not construct project roots itself or access sources across this boundary. |
| Serve paths/composition | [Product paths](../../apps/serve/service/paths.py) owns the user-level import-ledger location; [bootstrap](../../apps/serve/service/bootstrap.py) composes dependencies and lifecycle. |
| Desktop Resources | [Task-source registration](../../apps/desktop/src/renderer/src/features/resources/feature.tsx), [API projection and per-task event subscription](../../apps/desktop/src/renderer/src/features/resources/imports.ts) |
| Desktop task display | [Contribution contract](../../apps/desktop/src/renderer/src/contracts/features.ts), [Provider/list](../../apps/desktop/src/renderer/src/components/business/Tasks.tsx), [TaskFeed](../../apps/desktop/src/renderer/src/components/business/taskfeed.ts). The [sidebar entry](../../apps/desktop/src/renderer/src/shell/ActivityRail.tsx) and [notification action](../../apps/desktop/src/renderer/src/App.tsx) share TaskCenter Context; Shell does not own import execution. |

Runtime, Adapter, and Trace do not own product import jobs. Register new task types through Feature `taskSources` rather than adding business-type branches to Shell; the display protocol does not replace each domain's actual execution model.

<a id="为什么是后台-job而不是弹窗-loading"></a>
## Why a Background Job Instead of Dialog Loading

Resource import is a long-running operation with filesystem side effects. Waiting for the original request in a dialog confuses the interaction lifecycle with the task lifecycle; an in-memory task cannot independently retain cancellation, event cursors, or interruption facts. A persistent job lets the frontend observe again after switching pages or projects without requiring the Renderer to remain mounted.

The import ledger is user-level rather than project-level because it aggregates across projects and contains machine-local source and execution facts; it must not be copied to another machine along with a project. A project should retain final resource identity, content, and versions, not migrate machine-local task sources.
See [persistence boundaries](../architecture/persistence.md) for the specific path and database ownership; do not maintain a separate path-derivation rule.
This feature is not a persistent daemon. Continuing work after the App exits completely is not a promised capability.

<a id="当前机制"></a>
## Current Mechanism

- The creation entry returns 202 and a task projection. LINK still performs a synchronous link preflight during admission, so do not summarize this as “no filesystem access before returning” or infer from 202 alone that the event loop is unblocked.
- The authoritative states are `queued/running/completed/partial/failed/cancelled`. Scanning, copying, linking, and versioning are separate phases. The [domain contract](../../apps/serve/service/resources/domain/jobs.py) is the source of truth for fields; do not treat the old design's mixed state arrows as the actual Enum.
- The API looks up tasks by request owner. It derives `source_names` for external use through `public_import_job`, rather than copying the full source execution model or absolute source paths into the shared task-display protocol.
- Desktop observes active tasks through per-task SSE with `after_seq`. TaskFeed discards `eventSeq` values that do not increase and increments the generation on stop so old snapshots and subscription results cannot overwrite task display in a new session.
- The Provider refreshes snapshots at startup, when opened, and when the window gains focus. Its fallback timer uses `needsRefresh()` to detect uninitialized sources or active watchers that are not connected. Reconnection convergence does not depend on a popover being open, so a background task does not stop updating when the user closes its display. The old “only while open” condition was superseded by a later decision to decouple terminal state.
- Interruption convergence for an expired runtime lease distinguishes `partial/failed` according to completed items or successful sources and records a stable interruption error; partial success must not be rewritten as completion. Later implementation added a LINK/source-result-receipt recovery entry point, so do not generalize the old statement that “all recovery always fails and has no receipt” to every current recovery scenario.

<a id="必须保留的目标约束与验证缺口"></a>
## Target Constraints and Verification Gaps to Preserve

Progress must come from actual phases: scanning shows the discovered count, copy percentage comes from bytes, linking reflects authorized commit state, and version discovery and initialization have separate counts. Do not calculate a fabricated weighted percentage across phases. Copy completion, backend task terminal state, and the user seeing an updated resource tree are distinct facts and cannot substitute for one another.

Verify cancellation intent, execution stop, and final side effects separately; retries must not republish sources that already succeeded.
Partial success should show per-source results, and errors must not appear as success. Verify cleanup of incomplete files and retention of published files against a real filesystem, not only task-state fields.

An old requirement said that final completion should be published only after the resource tree reads back successfully. A later design explicitly decoupled backend task terminal state from the frontend projection. TaskFeed retains the authoritative terminal state, while Resources `onTerminal` only invalidates the corresponding project revision; entering or refreshing the panel performs the read-back independently. Thus, background completion in project A does not force project A to load while the user is in project B or on the home page, and a resource-tree refresh failure does not turn a successful job into `failed` or `refreshing`. The resource page handles refresh errors; do not swallow them or use task completion as proof that the tree was read back. When extending this behavior, preserve a single ledger, project isolation, monotonic events, and fencing of stale responses; accept backend terminal state and real resource visibility after returning to the project separately.

The current task center is presented using a DOM Popover by [ActivityRail](../../apps/desktop/src/renderer/src/shell/ActivityRail.tsx). [View Task Center in notifications](../../apps/desktop/src/renderer/src/App.tsx) opens the same center through the same Context; it is not a second task Owner. The built-in browser [viewport](../../apps/desktop/src/renderer/src/features/browser/viewport.ts) may project `visible: false` because of an intersecting overlay. Do not claim that a native interactive task center has been delivered, or use increased CSS stacking order, hidden web content, or old import screenshots to prove that interaction over a live webpage works.

<a id="重名确认与版本化覆盖"></a>
## Duplicate-Name Confirmation and Versioned Replacement

The [recovered COPY requirements draft](imports/requirements.md) for requirements-owner review and repeatable verification separately records candidate requirements, applicable entry points, and pending decisions. It is not approved and does not replace the current boundaries or release baseline on this page.

Duplicate-name handling also has a [synchronous import entry](../../apps/serve/service/resources/api/routes.py) and an [import-policy Owner](../../apps/serve/service/resources/service/importer.py). Do not automatically generalize this entry point's two-phase conflict contract to every background job capability; when adding or changing callers, inspect each real path separately.

The first COPY plan returns `needs_resolution` and `plan_token` if it finds a conflict; it does not first execute the whole import. Confirmation requires an explicit decision and idempotency key. The server recomputes the plan and checks the conflict set and replacement eligibility.
Rename creates the exact frozen target; if the target changes, the system must not silently choose another name. An expired plan requires confirmation again.
A directory conflict does not authorize merging, recursive deletion, or replacement. Content owns paths, stable reads, and exact creation; Resources owns conflict decisions and version policy; Desktop must not decide path or revision safety itself.

File replacement must go through `commit_versioned_replace` in the [version writer](../../apps/serve/service/resources/service/history.py): check the current snapshot revision, archive the exact old content first, then commit the versioned WRITE.
Replacing by direct copy and waiting for a scan to reconstruct history could lose old bytes or create a race, so it cannot substitute for this boundary.
Idempotent replay must not append duplicate versions. Recoverable single-file mutation does not make a multi-file batch atomic; partial execution must not be reported as complete success. Rollback descriptions in old proposals do not authorize reverting current code or deleting the runtime ledger.

Within the same dialog, [ImportDialog](../../apps/desktop/src/renderer/src/features/resources/ImportDialog.tsx) switches between selection and conflict phases. The server projects replacement eligibility, and the UI prevents duplicate submissions while busy. Implementation does not equal current acceptance. When changing this flow, also verify zero writes on the initial conflict, rejection after target/source changes, replay, disabled replacement for directories, real read-back of old versions, and errors/disabled states within the modal. Gather evidence from the [import contract](../../apps/serve/tests/contract_resource_import.py) and real Desktop filesystem operations; fields or old screenshots are not a substitute.

<a id="文献附件进入项目资源"></a>
## Importing Literature Attachments into Project Resources

Attachment import is not a generic directory job and does not add a literature relationship to a project.
The [Literature API](../../apps/serve/service/literature/api/importer.py) resolves the exact item and attachment, reads source bytes and revision, validates the target under the resource root through Content, and then calls the Resources payload preflight/commit port. Desktop does not provide the source path.
The [attachment import form](../../apps/desktop/src/renderer/src/features/literature/Import.tsx) currently provides only independent copying and replacement of a specified file. The old attachment LINK/annotation-sharing mode is no longer part of this contract; LINK support in generic Resources does not imply that attachments can also be linked. An exclusive literature file may disappear when deleted, so a project copy cannot depend on its physical path. A file copy and its literature/project relationship do not share the same lifecycle.

Preflight binds the source, target, and record options; submission requires a token and idempotency key. A replacement name must match the source suffix. Annotation capability is determined by PDF media type, and non-PDF files do not accept record-copy/replacement options. Replacing annotations explicitly requires confirmation, and source/target `record_revision` values participate in conflict checking; checking only the filename is insufficient to replace a file.
Bytes are committed first, then PDF records are processed, and finally `finish_payload` runs. A later failure returns the paths already written; this does not provide cross-domain atomic rollback and must not trigger a blind second write. Replay, target changes, record conflicts, partial success, and restart recovery still need separate verification. The old copy-to-project route remains, so do not generalize the new form's two-phase contract to every old caller. When changing an entry point, check the real call chain and [API types](../../apps/desktop/src/renderer/src/features/literature/api.ts).
Source and structural checks do not prove that directory selection on the actual machine, replacement-history read-back, or deletion isolation of a copy has passed.

<a id="修改后的验证选择"></a>
## Verification After Changes

- For backend changes, check the [import job contract](../../apps/serve/tests/contract_resource_import_jobs.py) and affected Content/version recovery contracts; first confirm the current test class and entry point.
- For frontend changes, check [import mapping and subscription tests](../../apps/desktop/src/renderer/src/features/resources/imports.test.ts), the [task contract](../../apps/desktop/src/renderer/src/contracts/tasks.test.ts), and actual TaskFeed tests.
- In an isolated runtime, use a real Desktop to copy/link real directories and observe phases, page/project switching, cancellation, retries, errors, and restart recovery. Check actual files, the resource tree, and network events; inspect every final composite screenshot.
- When an embedded webpage is present, also test task-center opening/closing, webpage bounds, scrolling/forms/runtime state, and input ownership. Structure/type checks or renderer-only screenshots do not replace this acceptance.

The verification entry points on this page do not authorize product operations. When implementing a feature, follow the authorization and applicable rules for that task. macOS acceptance does not prove Windows product behavior.
