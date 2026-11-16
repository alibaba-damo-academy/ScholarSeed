<a id="多标签与分屏需求构建依据"></a>
# Multi-Tab and Split-View Requirements Build Basis

<a id="页签溢出列表参考tabs13"></a>
## Tab Overflow List Reference: tabs/13

`overflow-20261113.png` is a byte-for-byte copy of `tmp/test_snapshot/desktop/tabs-overflow-observe-20261113/list.png`, SHA-256 `d42ddc6daaf4ee55ab3893610f17b482b9ecf4866f65f77bfe4213038397b05f`. On 2026-11-13, the real tab list was opened in an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance after narrowing an existing split view. No list item was selected; the layout was then approximately restored. Tab dirty state was not independently checked, and no tab was closed or edited. This image shows only the natural list; it does not prove target selection, ordering, persistence, or a passing formal evaluation. Operation details and failures, including the initial connection-parameter failure, are in `observation.md` in the same directory. Candidate adoption status is unchanged.

<a id="页签溢出候选tabs12"></a>
## Tab Overflow Candidate: tabs/12

The project-navigation and adaptive-tabs record documents the user's screenshot and incremental feedback: when even icons no longer fit, provide a list of all tabs. It also contains a historical observation in a macOS development instance. `TABS-OVERFLOW-CAND-001` records this entry point and a bounded candidate for switching by actual identity; the historical image does not prove applicability or a pass in this installer. Use distinguishable tabs, real window state, and an independent selected-identity reference; separately verify authorization for window-layout changes. Original IDs, requirements version, and historical freeze are unchanged.

<a id="分屏状态参考补充tabs11"></a>
## Additional Split-View State References: tabs/11

`divider-before-20261113.png` and `divider-after-20261113.png` are copies of real complete-window images from the isolated instance on 2026-11-13. Their respective sources are `tmp/test_snapshot/desktop/tabs-actions-20261113/driver/divider-before.png` and `divider-after.png`, with SHA-256 values `1190180c2971809fba196c24d77a33c538fbaf473af762975070596aff8acfa1` and `6176f4ca20298f51ae1f49284c00fc6b5a826b110dfdb9b0b02d8a8d22abfda9`. The run freeze identifies target macOS arm64 `0.3.2 / 202611121823 / preview`; on-disk ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. The disk digest does not prove runtime-memory bytes. The supplemental report records that independent file-identity references were captured about two minutes after the screenshots, and the preparation record has a gap. Images show before/after states only; they do not independently prove the drag operation or tab order. This revision does not change criteria, requirements version, or historical freeze.

<a id="目标版本完整窗口参考tabs10"></a>
## Complete-Window Reference for the Target Version: tabs/10

`window-20261112-1823.png` is a copy of the original complete-window image captured in an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance at 2026-11-12 19:47:19 +0800. Its source is `tmp/test_snapshot/desktop/baseline-1823-batch2/driver/evidence/tabs-split.png`, corresponding to the 15th screenshot in that batch's driver/index; SHA-256 `8599d9bf652da30008e7f2f2b021f46cf916549664fa029374c6983c6e3c0dff`. The batch plan records target ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. It shows a synthetic document in a two-pane split. It does not prove switching, dragging, writing, or a passing run. Historical criteria and freeze are unchanged.

<a id="需求与运行进度分离tabs9"></a>
## Separate Requirements from Run Progress: tabs/9

The blanket historical “not tested at all” status was removed from the requirements body. Run progress and per-run results are recorded in the scenario index and run records; stable IDs, requirements version, adopted scope, special-scope boundaries, and historical freeze are unchanged.

<a id="共享输入链接修正tabs8"></a>
## Shared-Input Link Correction: tabs/8

The resource links now point to byte-identical shared `examples`; see [resource build basis](../resources/build.md) for the original copy and source commit. This corrects references only and does not change requirements, criteria, or historical results.

<a id="202611121823-正常快评沿用tabs7"></a>
## Reuse for Normal Quick Review on 202611121823: tabs/7

Based on the user's unified adoption record and the adopted normal behavior in tabs/3 below—TABS-OBS-001–007 for normal tabs, layout, and returning to a project within the same process—this page retains the same subcriteria for `0.3.2 / 202611121823 / preview` under the existing [release quick-review layer](./requirements.md#发布快评层). Later build records on this page were read; no confirmed decision to retire or modify those normal requirements was found. This is bounded reuse: the new package's implementation or a single screenshot does not approve new requirements, and it does not prove a complete change-history review, source/artifact identity, or product acceptance. Handle 003 edit propagation, 008, and errors under their original special-scope and unconfirmed boundaries. Verify the project and independent inputs on each run. Original IDs, version, body, and historical runs remain unchanged.

<a id="共享示例输入对齐tabs6"></a>
## Align Shared Example Inputs: tabs/6

Current quick review uses shared `evaluation/overview` and `evaluation/detail`, verifying project, path, and digest against this run's preparation receipt. Their SHA-256 values are `252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814` and `5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`, respectively, and match the historical samples byte for byte. Preparation is not an import-feature test; a person confirms import. Other data and historical records are retained. Target-package applicability remains to be verified; this does not claim a real test passed.

<a id="当前参考图修订tabs5"></a>
## Current Reference-Image Revision: tabs/5

`reference-20261112.png` is an unmodified copy of `attempt-supplement/evidence/tabs-split.png`, the original image from an isolated macOS arm64 installer instance `0.3.2 / 202611121104 / preview` on 2026-11-12. SHA-256 `0aef632cc59345225a09eb1d934f4792e1cf48795df9d23c194318abcee1b9d7`. It shows a synthetic document in split view only; it does not prove ordering or close protection. Original run directory: `tmp/test_snapshot/desktop/release-20261112-fresh/`. Requirements and historical decisions are unchanged.

<a id="历史修订202610301343包内静态复核"></a>
## Historical Revision: In-Package Static Review of 202610301343

Asset revision `tabs/4`; this update only adds the specified new package source, input/independent references, and quick-review boundary. Preserve original stable IDs, v`0.3`, adoption rules, full text, reference-image source versions/dates, and historical results. The old sources and revision records below are historical and do not establish package binding or a conclusion for this run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. The source is the actual installer and loose renderer payload extracted for this task; source commit is unknown. The current checkout/remote HEAD may help locate code but does not establish source identity. The evidence manifest is in ignored directory `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`; in-package locations are relative to its `package/` root. Do not treat the temporary extraction directory as a permanent cross-worktree asset.

In-package `out/main/index.js`, SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: at 1338, `applicationRenderer` uses the renderer under `applicationResources` when packaged; the no-development-URL branch at 41203 delegates to `serveAssets`. This chain is tied to the actual loose payload analyzed here; it does not prove that runtime has no development override or turn a static entry point into a product observation.

- `renderer/assets/index-CddcCmKt.js`: SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`.
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`: SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`.

In-package `index:60408` tab menu checks `canSplitTab`; `workspace:2460–2482` viewer policy prohibits moving/splitting Office and spreadsheet views; `3918–3940` checks layout placement and the original tab location before splitting. A non-moving projection shares the session and creates a new tab. Initial document content, clean switching/closing must still be compared with the source and action-time visible record. `3806 moveTab` checks capability and refreshes before moving; `4041–4045` adjusts layout; `4644 forProject` holds each project's workspace; and starting at `index:10825`, project selection restores its workbench. The explicit quick-review layer reuses adopted normal display/clean actions for 001–007, including normal move, divider adjustment, and same-process project return; do not trim these for historical evidence gaps. Separate only the full matrix/extreme combinations and 003 shared editing/008 write protection; automatic eligibility and not-ready status are unchanged.

Samples in the requirements body refer to authorized isolated copies of repository originals. Before execution, record the mapping from original digest to task project ID and actual path after import; historical `eval-*-20261030` names are old run aliases and must not be assumed to exist in a new installation. Project/resources, column preferences, and minimal API projections still require independent evidence authorized for this run. Static compatibility does not prove that the normal UI is reachable or passed in a real run. This run did not start, connect to, or operate the product, read user state/credentials, or call external APIs; it did not change runtime state or reduce any not-ready special-scope work.

<a id="历史构建与分层记录"></a>
## Historical Build and Layering Record


Revision: tabs/3. Based on the user's unified adoption rule from 2026-10-30, verified normal behavior in the bound v0.3.0 / 202610281438 / preview installer is used as the basis for requirements v`0.3`; reuse existing source, exact artifact binding, and the independent Review from revision 2. Normal tabs, layout, scope, and project return in TABS-OBS-001–007, the shared-editing behavior already bound to 003, and the normal cancel/save/explicit-discard flows of 008 were adopted. Editing propagation in 003 and 008 remain write-related special-scope work; no execution authorization was obtained. Invalid/over-limit outcome for 005, save-failure/conflict and other error terminal states for 008, and recovery semantics beyond the verified same-process return remain unconfirmed and are not approved by adopting normal behavior.

Nothing has been tested; this revision changes adoption status only. Eight IDs, criteria, and requirements version are unchanged. It does not expand product, editing, saving, or discard permissions.

<a id="精确产物与设计边界"></a>
## Exact Artifact and Design Boundaries

Target: the macOS installer specified for this task, `0.3.0 / 202610281438 / preview`. Read-only recheck of `/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. ASAR `out/main/index.js:41022` loads adjacent renderer assets from `applicationResources(app)/renderer` on the packaged branch:

| File (under Contents/Resources/renderer/assets) | SHA256 |
| --- | --- |
| index-C4-PYlXk.js (hereafter index) | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js (hereafter workspace chunk) | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |

Read [DESIGN](../../../DESIGN.md) and [vibe](../../../docs/design/vibe-coding.md): Required, scrolling, overlays, Enforced by, and Stop condition. Keep internal workbench scrolling and operations reachable; use native support for window boundaries. Design and gates do not replace evidence of real readability. Do not turn a constant or one screenshot into a pixel standard, and do not independently require a viewport below the product's minimum window size.

<a id="逐项固定动态与条件"></a>
## Fixed, Dynamic, and Conditional Details

| Item | Current source and exact-package location; independent criterion |
| --- | --- |
| 001 | [TabBar](../../../src/renderer/src/shell/TabBar.tsx):63 corresponds to index:86237 and combines workbench tabs with non-embedded document tabs. Document title is projected from actual `source` and `displayTitle`. [workspace](../../../src/renderer/src/features/workbench/workspace.ts):724/778 corresponds to workspace chunk `open:2834`/`openDocument:2880`, reusing existing tabs by `documentId`, target leaf, and `viewKind`. A normal blank tab comes from `openNewTab` in [shell Workspace](../../../src/renderer/src/shell/Workspace.tsx):431; do not create one through internal `set`. |
| 002 | `TabBar.tsx:243` routes document closing through `requestClose` and ordinary tabs through `closeWorkbenchTab`. `current`/`others`/`left`/`right`/`all` in [Menu](../../../src/renderer/src/features/workbench/Menu.tsx):22 are computed from the actual group; in-package `DocumentTabMenu` is at index:58564. Although the overview model cannot close, TabBar filters it out; the literature fixed tab cannot close. The full-screen task tab exists only in its corresponding state and cannot close. Ordinary project blank/resource/file-explorer tabs follow their `closable` state. Do not state that the first tab of every view is a visible overview. |
| 003 | `splitTab:3908` in the workspace chunk, corresponding to `workspace.ts:1987`, creates a new tab on the non-move branch while preserving `sessionId`; session content is shared and `tab.viewState` is independent. `openDocument` creates or reuses a projection on an existing session. [api](../../../src/renderer/src/features/workbench/api.ts):321 corresponds to chunk `documentIdFor:1692`; project identity includes project/asset or path, and same-named files across projects are not merged. Two windows with the same initial image prove display/identity only. Edit propagation requires an authorized real edit and result in the other window; equal internal `sessionId` values are not proof. |
| 004 | [layout](../../../src/renderer/src/features/workbench/layout.ts):39 corresponds to chunk:2145–2147 `MAX_DOCK_ROWS=2` / `MAX_DOCK_COLUMNS=2` / `MAX_DOCK_PANES=4`; `validGrid` limits nonempty document panes. `Menu.tsx:118` calls `splitTab(direction,false)`, after `canSplitTab` controls whether the action is visible; chunk:3897/3908. Viewer policy is in [policy](../../../src/renderer/src/features/workbench/policy.ts):23 and chunk:2455. Office/spreadsheet currently have `canMove/canSplit=false`; do not assume splitting is possible based on file extension. |
| 005 | [Dragging](../../../src/renderer/src/features/workbench/Dragging.tsx):89 corresponds to index `DocumentNavigationTabs:58373`; the tab's left/right half selects before/after, and drops between tabs call `moveTabToTab`. [Dock](../../../src/renderer/src/features/workbench/Dock.tsx):91/534 corresponds to index `dropEdge:63679`/`LeafView:64030`; left/right/top/bottom/center edges call `moveTab`. Chunk `moveTab:3794` moves the original tab; only `splitTab(false)` copies the projection. Layout converges when the source becomes empty. Do not infer that the final drop succeeded from the drag preview. |
| 006 | `Dock.tsx:604` corresponds to index `SplitView:64106` and `DocumentDock:64217`; pointer dragging the divider adjusts `ratio`. Chunk `resizeSplit:2408` uses `clampRatio` and `alignGrid` to constrain/align. Chunk:2259 ratio constants 0.2/0.8/0.5 are implementation references only; do not turn them into screenshot pixel requirements. Verify the active pane through actual focus and tab/content; internal `focusedLeaf` cannot prove itself. |
| 007 | [root](../../../src/renderer/src/app/root.tsx):27 uses [scope](../../../src/renderer/src/features/workbench/scope.ts) to select a workspace from `selectedProjectId`, then `assistantProjectId`, then `null`; index `ProjectWorkspaceProvider:71158`/`resolveDocumentWorkspaceProject:8157`. Chunk `DocumentWorkspaceRegistry:4545`/`forProject:4618` stores each workspace by projectId/null in a Map; [store](../../../src/renderer/src/store.tsx):2782 and chunk `restoreProjectWorkbenchTab:4817` restore the active tab. Verify return against real visible identities/layouts before and after leaving in this run; do not rely on comparing a snapshot to itself or an old instance image. |
| 008 | `continueCloseQueue:4449` in the workspace chunk corresponds to `workspace.ts:2633`. Close queue uses reference counts for shared sessions; only the last reference and a dirty document enter `pendingClose`. If Markdown has `autoSave` enabled, it first attempts to save; do not require a confirmation unnecessarily after success. Index `DocumentDock:64350` displays `document-close-dialog`; cancel/discard/save and conflict overwrite have separate real paths. If `resolveClose` save fails, the pending close remains. The unsaved indicator depends on `autoSave`; a missing dirty dot does not establish that the document is saved. Reuse this item's close-protection criterion as the source for later save baselines; referencing it does not approve unconfirmed errors. Add save result, version, conflict, and other behavior specific to saving without duplicating the close standard. |

<a id="独立公开参照与恢复边界"></a>
## Independent Public References and Recovery Boundaries

Project-document loading uses GET `/api/workbench/open?project=…&path=…`; the successful top-level value is a document object. The necessary minimal projection is `project_id/path/asset_id/revision/viewer/processor/content_kind/capabilities`; it does not include tabs or `DockLayout`. Distinguish document types using capabilities returned publicly; do not infer editing permission from extensions. GET `/api/workbench/content` reads the same authorized synthetic document bytes. Use known samples and only necessary hashes to verify content; do not read full real-user documents, credentials, or state from unauthorized projects. Client `api.ts:385` corresponds to chunk `loadDocument:1739`; use the page's existing authenticated session. Do not extract a token or invent another host protocol.

The backend Owner [workbench/api/routes.py](../../../../serve/service/workbench/api/routes.py):156 has been checked for `open` and `content`. The installer copy at `Contents/Resources/backend/python/lib/python3.12/site-packages/service/workbench/api/routes.py` and repository file share SHA256 `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727`. `open` reads the actual snapshot, capabilities, applicable version, and asset identity. The public API provides document references only; it cannot replace the internal workspace snapshot or prove that the current panes, focus, layout, or shared editing are correct.

No public document Dock-state snapshot API suitable for product use has been recovered. Do not read internal store/documentWorkspaces or call the controller directly instead of using the real entry point. Prove pane count, visible tabs, and active content from this run's UI structure, complete images, and before/after action relationships; verify document identity independently against authorized samples/public metadata. Two windows with initial text alone cannot determine 003 shared editing. Its special-scope verification needs a real before/after edit and any necessary save terminal state; reuse of a source `session` is not self-verification.

Document split-view recovery is limited to the project workspace Map in the same renderer process. No persistence serialization was found for that `DockLayout` or all document tabs/sessions, so do not promise recovery after restart. Persistent [ProjectLayout](../../../src/layout.ts):1/133 holds workbench/conversation shell fields such as `open/full/swapped/taskTab/floating/conversationFull/conversationWidth`; the chunk's `DEFAULT_PROJECT_LAYOUT:20`/`projectLayoutTransition:109` restores by project, and `store.tsx:1862` submits `projectLayouts`. These are different layout types; persistent shell fields do not prove that the document four-pane layout is on disk. If its independent reference is needed, use the Owner to project only the authorized isolated profile's `renderer-preferences.json` fields `projectLayouts` and the necessary `autoSave` boolean; do not read all preferences or treat a startup snapshot as post-operation state.

Same-process return requires two known projects and records of each one's document, active tab, and layout before leaving in this run. Scope may be affected by the assistant project; explain the actual work scope rather than assuming that no selected project means no project context. Verify prerequisites for resource-reclamation limits, source-file changes, project deletion, or process restart separately; do not generalize a few clean-document cases to the entire recovery matrix.

<a id="默认快评专项与副作用"></a>
## Default Quick Review, Special Scope, and Side Effects

Quick review covers adopted normal display, clean opening/closing, layout, and project return in 001–007. Do not include unconfirmed errors on that basis. 003 edit propagation and 008 are authorized special-scope work; specify the selected criteria and count before execution. Unperformed special-scope work remains incomplete; it is not retired after a read-only first pass or moved to another category later to make results pass. For later save baselines, reuse the close-protection criterion applicable to 008; reference does not approve unconfirmed errors. Add saving outcomes, versions, conflicts, and other saving-specific behavior without copying a second close standard.

Opening a file normally reads its contents and updates MRU/navigation; project/shell state submits preferences. Dock sets `autoSave` and listens to focus/pointer/window blur; an already-dirty document may be saved automatically. Closing the last Markdown view may also save first. Move/split has a `refreshBeforeRelocation` path, so real state cannot be treated as universally write-free. Execution must explicitly authorize document reading and accompanying MRU/navigation/preference changes. Editing, saving, overwriting, or discarding requires separate precise authorization; old task authorization does not carry over.

Default quick review uses only known clean disposable samples. Do not substitute add-to-conversation, copy-path, system display, file manager, or Viewer editing for layout actions. Preserve conditions if an unexpected dirty state, conflict, or save prompt appears; do not confirm it without authorization. For 008, verify `autoSave` and shared-reference conditions. Cancel must preserve the document; a save failure must not close it; discard needs explicit permission. Do not change `autoSave` or fabricate dirty state to obtain an image. Viewer edit propagation, undo, PDF annotations, and Office exclusivity require special-scope acceptance for their actual capabilities; two ordinary windows showing the same text do not prove shared editing across all editors.

<a id="数据与尚未就绪"></a>
## Data and Remaining Readiness Gaps

Reuse [overview.md](../../../../../examples/projects/evaluation/files/overview.md), [detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt), [summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md), and [appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md) from the resource scenario; do not create another document framework. These are synthetic files not yet imported; they become product inputs only after authorized real import/open. Basic multi-tab coverage requires at least two files. Four panes may use multiple projections of the same document if that document supports splitting; do not create four copies and claim sharing.

Cross-project work requires two valid isolated projects and distinguishable files. 003 edit propagation and 008 additionally require disposable edit copies, known original content/version, save or discard permission, and the corresponding failure preconditions. If data or authorization is unavailable, leave the scope uncovered; do not prepopulate layout, dirty state, or results through internal writes.

There is currently no authorized product run, real reference image, or special-scope data terminal state for this page. Do not fabricate images/placeholders or create the machine triad. Reference images await later authorization for capture. Keep build sources, requirement adoption, unconfirmed branches, execution permissions, and actual results distinct; the public Driver/Judge and evidence procedure remain owned by the Skill.
