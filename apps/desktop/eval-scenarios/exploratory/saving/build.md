<a id="文档保存需求构建依据"></a>
# Document Saving Requirements: Build Evidence

<a id="空内容输入saving10"></a>
## Empty-content input: saving/10

`examples/projects/empty-document/project.json` registers a zero-byte synthetic Markdown file. File SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`; shared `resolveExample({ projectId: 'empty-document' })` and `readExampleFile` return 0 bytes. The manifest content digest is `b81e053914ee778f32c743f2b5ac0fd812a869b244bb135ba72788d69e380501`. This only supplies raw input for SAVE-OBS-006; it does not create a product resource or prearrange a save result. Actual path, isolated copy, editing, and save outcome still need to be prepared and verified separately; a human confirms import. Requirements version, adoption scope, and historical freeze are unchanged.

<a id="需求与运行进度分离saving9"></a>
## Separate requirements from run progress: saving/9

The generic historical “not yet tested at all” status has been removed from the requirements text. Track run progress and results for each run in the scenario index and run records; stable IDs, requirements version, adoption scope, specialty boundary, and historical freeze are unchanged.

<a id="共享输入链接修正saving8"></a>
## Fix shared-input links: saving/8

Resource links now point to byte-identical shared `examples`; see the [resource build evidence](../resources/build.md) for the original copy and source commit. This only fixes references and does not change requirements, criteria, or historical results.

<a id="202611121823-有界复核saving7"></a>
## 202611121823 bounded review: saving/7

Under the user's unified adoption rule of 2026-10-30 and the confirmed scope in saving/3 below, normal eligibility and saving for project Markdown/Monaco in SAVE-OBS-001–003, overwrite/discard/managed-copy for a bound project in 005, and normal editing/saving of a path-backed empty-content file in 006 remain bounded specialty criteria for this target. Failure recovery in 004, abnormal outcomes and non-project sources in 005, and the no-path unnamed entry in 006 remain unconfirmed. Normal branches do not approve abnormal cases or narrow original criteria. Records reviewed do not show that these normal sub-scopes were explicitly retired or changed; this is not an exhaustive requirements-history review and does not claim source-to-target identity or product acceptance.

Read-only artifact source: macOS arm64 `0.3.2 / 202611121823 / preview`, ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. In-package `applicationRenderer` points to Resources/renderer in the packaged branch. The actual `index-CerFLdm1.js` (SHA-256 `f31b1e723f5783fd0690bb323e2af2b144e2eee87241114767ca2855f17b2b27`) exposes save capabilities and focus-save wiring around lines 24805 and 25208. `workbench-2GTFONdR.js` (SHA-256 `6a196e487c19c2f51803fce7223ef37768d7e46ab85a361e90c6dce3e98aa1c6`) exposes revision conditions and save-session handling around 4848 and 7978–7989. These are in-package implementation clues; they do not prove reachability, a successful write, or acceptance of abnormal requirements.

This page remains a write-operation specialty overall. Separately obtain an authorized disposable isolated copy, actual project/path and digest, and permissions for editing/saving and related preference/overwrite/discard actions. Verify the result by rereading the same actual path. A human confirms import tests. Do not manufacture failure/conflict with prearranged results or internal dispatch. Other viewers/sources, external modifications, and pathless documents remain gaps. Original IDs, v`0.3`, criteria, and historical freeze remain unchanged.

<a id="共享示例输入对齐saving6"></a>
## Align shared example input: saving/6

This revision only points the two raw inputs for the current saving specialty to `overview` and `detail` under `examples/projects/evaluation`. On 2026-11-12, the shared originals and original resource samples were verified to have matching SHA-256 digests, respectively: `252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814` and `5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`. Old copies and the record below remain for historical tracing. Execution requires authorization to use disposable isolated copies and a preparation receipt verifying project identity, actual path, and original digest. Preparation does not prove import or saving. A human confirms import tests; editing/saving and writes involving preferences, overwrite, or discard each require separate authorization. Original stable IDs, requirements version, criteria, and historical results remain unchanged. Target-package applicability and specialty prerequisites still need independent verification.

<a id="当前参考图修订saving5"></a>
## Current reference-image revision: saving/5

`reference-20261112.png` is an unmodified copy of `attempt-supplement/evidence/resources-notes.png`, an original capture from an isolated macOS arm64 installed `0.3.2 / 202611121104 / preview` instance on 2026-11-12. SHA-256 `1a90e0bc5d239fae1881f3882314684453b0572ba8a1774cfe43f5a588c438f2`. It provides editor context only and does not show a saved, failed, or conflicted outcome. Original run directory: `tmp/test_snapshot/desktop/release-20261112-fresh/`; save criteria and authorization remain unchanged.

<a id="历史修订202610301343包内静态复核"></a>
## Historical revision: static review inside the 202610301343 package

Asset revision: `saving/4`. This revision only adds the specified new-package source, input/independent reference, and quick-review boundary. Original stable IDs, v`0.3`, adoption rule, full text, original reference-image version/date, and historical results remain. Older sources and revision records below are historical and do not establish this package binding or the outcome of the current run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Source: the actual installed package extracted for this task and its loose renderer payload. The source commit is unknown; the current checkout/remote HEAD can assist location only and is not asserted to be the same source. The evidence inventory is `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json` in an ignored directory. Package paths are relative to its `package/` root; the temporary extraction directory is not treated as a durable cross-worktree asset.

In the package, `out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: at 1338, `applicationRenderer` selects the renderer under `applicationResources` when packaged; at 41203, the branch without a development URL delegates to `serveAssets`. This chain is tied to the actual loose payload analyzed here. It does not prove runtime development overrides are unset, and a static entry point is not a product observation.

- `renderer/assets/index-CddcCmKt.js`: SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`.
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`: SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`.
- `renderer/assets/MarkdownDocument-vxerKaIo.js`: SHA-256 `f372fc42e0501afd5d2b071225341db7833cb64a64e32ea7bbe422232b822952`.
- `renderer/assets/MonacoDocument-D4UmyngX.js`: SHA-256 `5036a2bf2f27aea00dbdbb88046a85a85db31c33ca910955e5c7b336bddafbf2`.

In packaged `workspace:1755/1766`, public `open`/`content` are loaded. Editing/saving controls from 3302 onward are constrained by capabilities; 4293 checks `dirty`/`can_save` before saving. Markdown:2179/2235 restricts editing according to `lightweightText`, `can_edit`, and `preview`. The presence of save UI does not prove an actual disk write. SAVE-OBS-002 still requires rereading the known change at the same project/path; a cleared dirty indicator does not prove resolution of concurrent revisions, failures, or conflicts. This only adds the new package's frontend source; do not carry the old backend's file-by-file comparison forward as binding the new package. Server-side writes/failure outcomes need separate specialty verification. This page remains a write-operation specialty overall with no default successful-save path; read-only eligibility on other pages does not bring 002–006 into default quick review.

Samples in the requirements refer to authorized isolated copies of repository originals. Before execution, record the mapping from each original's digest to the task project ID and actual post-import path; historical `eval-*-20261030` names are aliases for old runs and are not assumed to exist in a new installation. Independent evidence for projects/resources, column preferences, and the minimal API projection still requires authorization for this run. Static compatibility does not prove that normal UI is reachable or that behavior passed testing. This revision did not start, connect to, or operate the product; read no user state or credentials; and called no external API. It does not change runtime state or reduce any unready specialty.

<a id="历史构建与分层记录"></a>
## Historical build and layering record

Revision `saving/3`. Under the user's unified adoption rule of 2026-10-30, verified normal behavior in the bound installed v0.3.0 / 202610281438 / preview package was adopted as v`0.3` requirements, reusing existing source, exact artifact binding, and independent review. Adopted: normal eligibility/saving for project Markdown/Monaco in SAVE-OBS-001–003; overwrite/discard/managed-copy project flow in 005; normal editing/saving of a path-backed empty-content file in 006. All remain write-operation specialties that were not authorized or tested. Failure feedback/recovery in 004; abnormal outcomes and non-project applicability in 005; saving an unnamed no-path document in 006; and boundaries such as concurrent editing/uncertain failure remain unconfirmed and are not approved by adopting normal behavior.

The source and viewer boundary from revision 2 remain; this revision only changes adoption status. The six IDs, criteria, and requirements version are unchanged. The sole close-protection criterion reuses the applicable part of [Tabs 008](../tabs/requirements.md); unconfirmed abnormal behavior is not approved by this reference. It is not included in default read-only quick review and does not expand product, preference, editing, overwrite, or discard permissions.

<a id="精确产物身份"></a>
## Exact artifact identity

This run's target is the installed macOS 0.3.0 / 202610281438 / preview package. Read-only recheck of `/Applications/ScholarSeed.app/Contents/Resources/app.asar` yielded SHA-256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. The packaged `out/main/index.js:41021–41028` `serveAssets` chain uses `applicationResources(app)/renderer` in the packaged branch; do not assume a neighboring file was loaded merely because it exists.

| File under Contents/Resources/renderer/assets | Rechecked SHA-256 |
| --- | --- |
| index-C4-PYlXk.js (called index below) | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js (called workspace chunk below) | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| MarkdownDocument-DOJpEUB5.js | `6a720de9eb90695518e9dc986420d92a8ea0dd7b0242108fd55d529e74f39ebd` |
| MonacoDocument-DuLjuy1W.js | `3f34b35eb42d3fa38ec4ad3e8015995922f1072605d4d5acab71a83c5c6e9dfe` |

index:64396/64399 explicitly dynamically imports the Markdown/Monaco chunks above. This review binds only the functions and files read, not the whole repository. The following backend Owner files were compared individually between the repository and installed package at `Contents/Resources/backend/python/lib/python3.12/site-packages/`; their SHA-256 digests matched:

| Path relative to apps/serve and site-packages | SHA-256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/resources/service/history.py | `2c87b921440a4b037a0f7fc25be181f1747db6b280f57e1e9afc35a7952616c5` |
| service/resources/service/observe.py | `fb16a3f62c14956eabe86a92483ba78982886bf9fe430aa1c843611898673dc9` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |

<a id="逐项源码恢复"></a>
## Source recovery by criterion

| Item and type | Current source, packaged location, and interpretation boundary |
| --- | --- |
| 001 conditional | [api.ts](../../../src/renderer/src/features/workbench/api.ts):385 loads the public project `open` projection; workspace chunk:1739. Capability is not decided by extension alone. [routes.py](../../../../serve/service/workbench/api/routes.py):156–212 decides `can_edit`/`can_save` based on content/size/registered viewer and `snapshot.writable`. [workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):1306 `restrictEditing` can also disable capability at runtime. MarkdownDocument.tsx:1862 is read-only for `preview` or absent `can_edit`; MonacoDocument.tsx around editor creation line 319 also checks view and capability. [Dock](../../../src/renderer/src/features/workbench/Dock.tsx):277 and index around 63837 control save visibility/disabled state; Monaco chunk:47988 is the source-view save entry. Public capability does not prove the real UI is reachable. |
| 002 dynamic/conditional | workspace.ts:2388 serializes save requests for the same session; :2444 `commitSession` runs `prepare`/`beforeSave`/`serialize`, and marks clean only after commit succeeds and `changeVersion` has not changed; workspace chunk:4232/4277. api.ts:519 `commitDocument` sends project `PUT` content with `If-Match`; 412 means conflict, and success still requires an ETag; chunk:1854. MarkdownDocument.tsx:864/1225 correspond to Markdown chunk:1392/1710 and collect visual edits before saving, formatting/encoding according to preference. MonacoDocument.tsx:474/491 correspond to Monaco chunk:47683; the lightweight model's serialization delegate differs from the normal `updateText` path. Formatting failure warns but is not disk-write failure; verify formatting and disk writing separately. |
| 003 dynamic/conditional | [preferences.ts](../../../src/preferences.ts):185 defaults `autoSave=true`; :573 sanitizes invalid values and falls back to default; workspace chunk:351/548. [store](../../../src/renderer/src/store.tsx):830/1875/2422 initializes, submits, and updates that preference; index:8671/9236/9717. [Preferences](../../../src/renderer/src/components/business/Preferences.tsx):274 and index:74452 expose the switch. [AccountPanel](../../../src/renderer/src/components/business/AccountPanel.tsx):1352/5169 and index:78497 provide combined file settings. Dock.tsx:736/767 and index:64228/64255 pass preference to the workspace and call `saveFocused` on focusin/pointerdown outside the document area or window blur; a target retaining selection does not trigger it. No basis was recovered for “ordinary tab switching always saves” or a fixed-delay save. Do not interpret the switch as persisting every keystroke immediately. The special pre-save path for closing a Markdown document's last reference remains under tabs 008. |
| 004 conditional | workspace.ts:2477–2524 retains current edits and marks `error`/`conflict` on serialization failure, failed pre-overwrite read, or failed commit. The index DocumentToolbar corresponding to Dock.tsx:244 shows `saving`/`externalChange`/`saveFailed`. Monaco's own toolbar does not guarantee the same text; observe actual feedback. api.ts treats success without ETag as failure, and a network error can arrive after the disk write. An error message alone is not independent evidence that disk stayed unchanged. Paths such as a serialization throw that are not fully caught remain to be verified; do not turn current exceptional implementation into a correctness standard. |
| 005 conditional | Dock.tsx:429 and index near 63978 offer `overwrite`/`discard`/`copy`; workspace.ts:1741/1756/1763 and chunk:3704/3717/3723 respectively read the latest version and save with CAS, reload disk, or serialize current memory into a managed copy. api.ts:573 `createManagedCopy` is project-only. A non-project conflict may show a button but return `unavailable`, an entry-point/feedback gap; do not require all documents to support saving another copy. After copy succeeds, the original target is reloaded and the new path opened; this is not arbitrary renaming of the original. |
| 006 fixed structure/conditional | [shell Workspace](../../../src/renderer/src/shell/Workspace.tsx):431 calls `newProjectTab`; [tabs](../../../src/renderer/src/features/workbench/tabs.ts):276 and workspace chunk:4829 create a workbench tab with `kind=new_tab`, without a `DocumentSession` or file path. [ResourcePanel](../../../src/renderer/src/features/resources/ResourcePanel.tsx):626 says creating one only focuses the tree node; [resources api](../../../src/renderer/src/features/resources/api.ts):1162 creates an actual resource through node mutation, not an unnamed in-memory document. An authorized empty-content synthetic file can later be imported/opened normally to verify saving; do not infer that “blank new tab → save file” is implemented. |

These line references support source recovery; they are not an execution script. Verify actual entry points and visible feedback by observing the product under later authorization. Design reading is constrained by [DESIGN](../../../DESIGN.md) and [vibe](../../../docs/design/vibe-coding.md); internal-editor scrolling and save/conflict actions must be reachable. Source layout or gates are not visual acceptance.

<a id="后端写入与独立终态参照"></a>
## Backend Writes and Independent Terminal References

[routes.py](../../../../serve/service/workbench/api/routes.py):340 `workbench_commit` requires binary `Content-Type` and `If-Match`, and passes the payload to [history.py](../../../../serve/service/resources/service/history.py):576 `commit_working` with `automatic_version=true`. Over-limit or Git-managed targets use `content.commit_bytes`; others use the product version-write flow. A successful save does not mean all sources create the same history version; this page does not expand into the full version-management workflow.

Around history.py:820, `Content.apply_bytes` compares `expected_revision`/`target_revision`, completes a working mutation, then reads the final snapshot. [port.py](../../../../serve/service/content/service/port.py):1342/1390 `commit_bytes`/`_replace_stream` hold filesystem writes: safely resolve parent directory, lock the same file, compare content revision, stage in a restricted location, flush/fsync, compare again before publish, replace by identity, and clean up on failure. Permission, conflict, write, and size errors are mapped to HTTP by routes.py; the frontend displays 412 as `conflict`. This chain cannot replace real OS-failure and content validation.

Saving a copy follows routes.py:374 `managed-copy`, which requires `Idempotency-Key` and delegates to [observe.py](../../../../serve/service/resources/service/observe.py):847 `create_managed_copy`. It determines the new path from the resource root and destination, checks size and version eligibility, and creates an independent managed resource. Verify the actual returned project/path/revision and reread the reopened content; clicking a button or entering a Save As title is not success.

An independent reference can be a GET to `/api/workbench/open?project=…&path=…`, with top-level `project_id`/`path`/`asset_id`/`revision`/`viewer`/`content_kind`/`capabilities` for the same authorized synthetic target, and a GET to `/api/workbench/content` to reacquire bytes and ETag. Compare with known original content, actual edit records, and authorized formatting expectations. For a conflict, independently record disk B and memory A first, then verify original and new paths separately after resolution. Do not generate tested results through internal store/controller or a preemptive PUT. When an authenticated page session is already available, use the public read interface; do not extract a token.

For an independent preference reference, follow [main/preferences.ts](../../../src/main/preferences.ts):18/37/67 to the actual `renderer-preferences.json` under `storage.userData`, loaded/submitted by its Owner. For an authorized isolated profile, project only `autoSave` and, if needed, `formatOnSave`; do not read full real-user preferences or treat startup snapshot as the post-operation persisted value. Disabling automatic save does not guarantee other operations write nothing; confirm each save against the actual trigger and target.

<a id="数据副作用与缺口"></a>
## Data, Side Effects, and Gaps

Reusable, not-yet-imported inputs: [overview.md](../../../../../examples/projects/evaluation/files/overview.md), [detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt), [summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md), and [appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md). Start only from authorized isolated copies. Do not modify repository originals or treat them as existing product resources. This run adds no “save completed” fixture.

Still needed: an authorized project/resource copy, a path-backed isolated empty document, two independently known versions and edit markers, a real failure/recovery precondition, and an external-modification source. Record and separately authorize preference-switch and format-on-save changes in advance; define target scope for overwrite, discard, save-copy, and save-all. Do not manufacture a real failure/conflict with a fake provider, internal dispatch, or production-code change. If there is no safe failure precondition, leave the specialty incomplete.

Normal opening may update MRU/navigation. Editing, auto-save, and manual save change files and applicable version metadata. Save-copy creates a resource/version and opens the document; preference changes persist. With auto-save enabled, clicking outside the document area may already have written data. A later Driver must first check existing dirty state and authorized targets; do not classify navigation as absolutely write-free.

Unresolved conditions include real file-settings navigation level, error feedback across viewers, UI applicability of save-copy for non-project conflicts, saving an unnamed pathless document, and actual terminal state for concurrent editing/uncertain failure during save. Although the frontend commit route union includes literature attachments/conversation artifacts, their backend Owner was not bound in this run; do not extrapolate this specialty to cover them. Product behavior has not been tested and there are no reference images; do not fabricate images or a machine-generated artifact set. Do not remove items when prerequisites are missing; tabs 008 still owns the close-protection matrix.
