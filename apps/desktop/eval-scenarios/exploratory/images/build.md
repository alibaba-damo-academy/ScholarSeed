<a id="图片查看需求构建依据"></a>
# Image-Viewing Requirements Build Basis

<a id="目标版本完整窗口参考images10"></a>
## Target-Version Complete-Window Reference: images/10

`window-20261112-1823.png` is a copy of the original complete-window image from an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance on 2026-11-12 at 19:54:50 +0800. Source: `tmp/test_snapshot/desktop/baseline-1823-batch2/supplement/evidence/image-fit.png`, screenshot 25 in the corresponding supplementary-capture index; SHA-256 `5522c46c85f3bfe17f562f4d5aa2453f67102336ad01f8455a239d8b2ba95ecc`. The batch plan records target ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. Shows a synthetic image fitted to the window; the document pane on the right is narrow. Does not prove zoom actions or a successful run and does not change historical criteria or freeze.

<a id="需求与运行进度分离images9"></a>
## Separate Requirements from Run Progress: images/9

Removed the broad historical status “all untested” from the requirements body. Run progress and per-run results belong in the scenario index and run records. This does not change stable IDs, requirement version, adopted scope, focused-scenario boundaries, or historical freezes.

<a id="202611121823-正常快评沿用images8"></a>
## Reuse of Normal Quick Review at 202611121823: images/8

Based on the user's unified adoption record and the IMAGE-OBS-001–003 normal image-reading behavior already adopted below under images/4, retain the same subcriteria for `0.3.2 / 202611121823 / preview` under the existing [Release Quick-Review Layer](./requirements.md#发布快评层). The subsequent build records on this page were checked; no confirmed decision retiring or changing these normal requirements was found. This is bounded reuse; it does not approve new requirements based on new-package implementation or a single screenshot, and does not prove that the complete change history or source/artifact origin was checked or that the product conforms. Keep extreme zoom, editing, and errors under the original focused/unconfirmed boundaries. Recheck inputs and independent dimensions each run. Original IDs, version, text, and historical runs are unchanged.

<a id="共享示例输入对齐images7"></a>
## Alignment with Shared Example Input: images/7

The current quick review uses `evaluation/image`, whose SHA-256 `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2` is byte-identical to the original `icon` below. Use the current preparation receipt to verify project and path. Preparation is not an import-feature test; import requires user confirmation. Preserve other inputs and historical records. Target-build applicability remains unverified; this does not indicate real testing passed.

<a id="当前参考图修订images6"></a>
## Current Reference-Image Revision: images/6

`reference-20261112.png` is an unchanged copy of original image `attempt-examples/evidence/image.png` from an isolated macOS arm64 installed build `0.3.2 / 202611121104 / preview` instance on 2026-11-12; SHA-256 `f9fe9e4aab2cbf56ee939bd8afa7b24ddf0e4cced4a53ce74783e86bd337a325`. Shows one zoom state only; it does not prove other actions or errors. Original run is under `tmp/test_snapshot/desktop/release-20261112-fresh/`. This revision does not change criteria or historical results.

<a id="历史修订202610301343包内静态复核"></a>
## Historical Revision: Static Review of the 202610301343 Package

Asset revision `images/5`; this change only adds the specified new-package source, input/independent reference, and quick-review boundary. Preserve original stable IDs, v`0.3`, adoption rules, full text, reference-image version/date, and historical results. The following old sources/revisions are historical, not package binding or conclusions from this run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. Source is the actual installed package and unpacked renderer payload extracted for this task. Source commit is unknown; current checkout/remote HEAD may help locate source but does not establish common origin. Evidence manifest is in ignored directory `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`; package locations below are relative to that root's `package/`. Do not treat the temporary extraction directory as a cross-worktree asset.

Packaged `out/main/index.js`, SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: `applicationRenderer` at 1338 uses renderer under applicationResources in packaged builds; at 41203, the branch without a development URL delegates to `serveAssets`. This binds to the actual unpacked payload analyzed here. It does not prove no development override was set at runtime, and static entry points are not product observation.

- `renderer/assets/index-CddcCmKt.js`: SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`.
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`: SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`.
- `renderer/assets/ImageDocument-6egkRQv3.js`: SHA256 `05ed5a6ee7e233ec89ba6bb8e91057f5c94bad65dab26a542348d973e11d3bb2`.

In packaged `ImageDocument:25`, `fitImage` centers using the minimum ratio of natural image and viewport dimensions. Starting at 52, the component creates a Blob from `session.bytes`, and `onLoad` obtains `naturalWidth/Height`; `ResizeObserver` measures the current viewport, while `ready` gates viewing actions. Fixed toolbar semantics, dynamic natural dimensions/geometry, and conditional readiness remain compatible with 001–003. Use original `icon.png` and independent 1024×1024 dimensions/known pattern; do not fix the current pane's fit percentage. A zoom-state change is not a file write. Extreme fit/manual-clamp interactions in 004, edge/gesture behavior in 005, and 006 failure eligibility remain gaps; actual reachability has not been verified.

Samples in the requirements refer to authorized isolated copies of repository originals. Before execution, record the mapping from original digest → task project ID/imported actual path. Historical `eval-*-20261030` names are old-run aliases; do not assume they exist in a new installation. Project/resource, column preferences, and minimum API projections still require authorized independent evidence in this run. Static compatibility does not prove the normal UI is reachable or has passed real testing. This run did not start/connect to or operate the product, read user state/credentials, or call an external API. It does not change runtime state or narrow scenarios that are not ready.

<a id="历史构建与分层记录"></a>
## Historical Construction and Layering Records

Revision images/4. Under the user's 2026-10-30 unified adoption rule, verified normal behavior in the bound installed build v0.3.0 / 202610281438 / preview is the v`0.3` requirements basis; reuse existing source, exact-artifact binding, and independent requirements/data reviews. Normal loading, natural dimensions, fit/actual size, manual zoom limits, and drag/reset under IMAGE-OBS-001–005 were adopted. Extreme fit/manual-clamp jumps in 004, edge/off-screen/gesture semantics in 005, operation eligibility after 006 failure, and unknown formats/rotate/crop/edit capabilities remain pending confirmation; unusual output is not approved. Full scenarios were not tested. Adopted normal automatic subcriteria participate in default selection; unconfirmed and focused scenarios remain separate. Adoption grants no additional product-operation permission.

Preserve revision 2 clarification about data navigation and image-editing boundaries. This revision changes adoption status only; six IDs, criteria, and requirement version are unchanged.

<a id="精确制品与有界来源"></a>
## Exact Artifact and Bounded Source

This batch performed a new read-only check of installed macOS `0.3.0 / 202610281438 / preview`; short version in Info.plist, ASAR `package.json` version, and build number/channel in Resources `product.json` match. `/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. Directly read ASAR `out/main/index.js:41018–41023`: in the branch without a development renderer URL, packaged `serveAssets` uses `applicationResources(app)/renderer` as root. This binds the adjacent renderer, not the entire repository to the package, and the runtime process environment was not inspected.

Rechecked `Contents/Resources/renderer/assets/`:

| File | SHA256 |
| --- | --- |
| index-C4-PYlXk.js | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| ImageDocument-AsNT2KAx.js | `17a5a711e9b14887bb0e650c5e676ac2bc4c33b465d773132ad34649a4e16aab` |

`index:64407–64408` lazily loads this ImageDocument chunk; `:64467` projects `documentSessionId/tabId`. Image chunk `:9` onward contains geometry utilities, and `:51` onward is ImageDocument; `:3` obtains context from the workspace chunk. This is consistent with implementations read below; it does not claim the whole renderer and worktree are identical file by file.

Renderer source SHA-256 (all paths relative to `apps/desktop/src/renderer/src/`):

| Relative path | SHA256 |
| --- | --- |
| features/workbench/ImageDocument.tsx | `2e3b3b8fa81b5320bde0b9e37873cd807e7dbf2c3a64782eb4159a9e4c36b340` |
| features/workbench/image.ts | `2be3c3aede20e20511c676cf9d0b373151cdf922b83d36942bc516a831708cf0` |
| features/workbench/feature.tsx | `5c1284781a0b6ff73ec37ef0d45211122ce2ac9cb4265737eb50e4c274bdcaec` |
| features/workbench/api.ts | `80b4302d95cfa262453d7ef7b74a50a82827c00fd8f3cc9c4bbb9953d472f8bd` |
| features/workbench/workspace.ts | `f79b28ba9713d9bc988b55be8772fdbc5ef66dd8bf00555e73c4a2ee549a89fe` |
| store.tsx | `bc1f750a17bb72280ffac98ee616908eb8d5666b950f93753e4094c8b3102a9c` |

For necessary backend Owners, repository `apps/serve/` and installed package `Contents/Resources/backend/python/lib/python3.12/site-packages/` were compared file by file; bytes and SHA256 match:

| Relative path | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/workbench/service/images.py | `9e836204fad561f8bd0e1f10199f7473f40c047a1555682ccd22aa6eb3f28f2a` |

<a id="逐项恢复与状态参照"></a>
## Per-Criterion Recovery and State References

| Item | Category, source chain, and independent judgment |
| --- | --- |
| 001 | Dynamic/conditional. [feature.tsx](../../../src/renderer/src/features/workbench/feature.tsx):111 registers image; missing session/tab goes to UnavailableViewer. [api.ts](../../../src/renderer/src/features/workbench/api.ts):385 opens the project path, then content, projecting identity and bytes. [ImageDocument.tsx](../../../src/renderer/src/features/workbench/ImageDocument.tsx):48–62 creates a Blob URL from bytes when the session is ready and cleans old URLs; :164–175 gets naturalWidth/Height from browser onLoad and hides the image until ready. Chunk :74 onward follows the same chain. Tab name and alt text come from session title and are not sole references for correct content. Normal materials entry was not observed in a run; format registration does not prove UI reachability. |
| 002 | Dynamic. ImageDocument.tsx:127–131 shows native dimensions only when ready; image.ts:54 prefers existing image MIME, otherwise falls back by png/jpg/jpeg/webp/gif/svg suffix. Compare dimensions with an independent decode of the source; do not validate natural fields against their own text. The two current static raster samples do not cover EXIF orientation, SVG, animation, or other formats. |
| 003 | Dynamic/light interaction. ImageDocument.tsx:43 selects by mode; :65–74 measures `clientWidth/Height` with ResizeObserver; :110–125 implement fit/actual size. image.ts:30 fit uses the minimum viewport ratio and clears pan, which can enlarge a small image; actual size sets manual/1/0/0. Chunk :23 and :146 onward correspond. Independently measure fit geometry and CSS-pixel visibility; do not use `data-scale`, `data-pan`, or internal store as the answer. |
| 004 | Fixed limits + dynamic. image.ts:1–4/38 uses manual zoom factor 1.25 and range 0.01–32, updating pan proportionally to keep the corresponding image point centered. ImageDocument.tsx:85–108 disables toolbar buttons when not ready or at a limit, and rounds displayed percent. Image chunk :9–31/:116 onward. Normal manual 1%–3200% limits were adopted under the unified rule; the text does not add a precise step-size requirement. Fit does not use these limits; at extreme image/viewport sizes it can exceed manual boundaries and buttons may then jump. This remains pending confirmation, not approved behavior. |
| 005 | Dynamic/conditional. ImageDocument.tsx:146–160 captures the pointer only when ready, primary pointer, and no current drag; :155–157 accumulates pan from the initial delta; :77–84/:159–164 clear on release or lost capture. image.ts:45 adds dx/dy only, without edge clamping; viewport uses `overflow-hidden` and `touch-action:none`, with no image wheel listener. Chunk :169 onward corresponds. Lack of clamping is an implementation fact, not approval of unlimited dragging. Verify with visible pattern and before/after geometry; Fit/Actual Size can reset. |
| 006 | Conditional. ImageDocument.tsx:174–175 sets failed on decode error or non-positive dimensions; :184–190 shows image error if failed, session missing, or loadState error; otherwise if not ready it shows Spinner. Chunk :202–219 follows the same chain. Outer [viewer.tsx](../../../src/renderer/src/app/viewer.tsx):19/39/70 also has ViewerFailure and lazy-loading wait. If a previously ready session becomes error, natural dimensions may remain; ready checks only natural/failed, not loadState. This is an operation-eligibility gap to verify, not approval to keep old dimensions/tools as if successfully loaded. |

Backend [model.py](../../../../serve/service/workbench/domain/model.py):125/268 defaults image to previewable but not editable/savable/selectable/annotatable. [routes.py](../../../../serve/service/workbench/api/routes.py):156 decides viewer/capabilities from ContentService.snapshot, size limit, registered format, and bytes; :207 also constrains edit/save by writable and may project version capability through a version service. Do not hardcode that every image can never be versioned. Open returns project, path, revision, media_type, size, and capabilities; image does not use PDF identify, and asset_id may be empty, so do not invent one. Content route :235 provides ETag and original bytes; [port.py](../../../../serve/service/content/service/port.py):895/1141 provide controlled byte-read and snapshot respectively. A future authorized public read could verify digest/identity, but this batch made no requests and does not infer successful decode from a successful GET.

<a id="工具栏写入与状态owner"></a>
## Toolbar, Writes, and State Owners

This image Viewer registration does not declare `toolbar: 'viewer'`; observe actual workbench shell composition and image toolbar display rather than inferring menu reachability from registration. ImageDocument itself has zoom, fit, and actual-size tools only. A bounded search of current Desktop renderer TS/TSX, workbench API, and Serve workbench/resources Owners found no independent image rotate/crop/transform call chain or current file named toolbars. Old names or Office image commands do not prove an independent image-editing entry point. If the Coordinator has a specific historical location, retain it as a source gap; do not claim complete image-editing requirements were recovered.

[api.ts](../../../src/renderer/src/features/workbench/api.ts):795 POST `/api/workbench/images` is Markdown image insertion, not transformation of the current image. `routes.py:435` calls [images.py](../../../../serve/service/workbench/service/images.py):101 `persist_image`, which accepts only Markdown documents and uses ContentService.commit_optional_bytes to create `.assert/<文档名>/img/<uuid>`. Office temporary-image leases in the same file also write/clean files and are not read-only viewing. PDF-region cropping generates an in-memory evidence image; it is not cropping a separate image file. If future rotate/crop invokes a real byte commit, treat it as a write-focused scenario requiring authorization, before/after content, and failure protection; do not present it as read-only. This batch neither approves nor retires that business requirement.

Viewing does not change the original image, but it does not imply zero state writes. `setTabViewState` in [workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):2080 publishes current tab mode/scale/x/y; workspace chunk :3988 corresponds, without promising persistence across restart. Opening a material in [store.tsx](../../../src/renderer/src/store.tsx):3140/3196 may `touchRecentFile`, which enters the preference submission chain from :1881 onward; literature also has `recentLiterature` at :1813. Project original, in-process viewState, and user-level MRU/preferences have different Owners. During execution, authorize applicable state impact; do not interpret “read-only” as absolutely zero writes.

Read [DESIGN](../../../DESIGN.md) and [vibe](../../../docs/design/vibe-coding.md) for scrolling, Required, Enforced by, and Stop condition. Image is a workbench canvas/toolbar; viewer owns viewport clipping. No screenshot/interaction evidence yet covers reachability of key actions within the real supported window, theme, keyboard, or split panes. Static checks do not replace them.

<a id="输入与覆盖缺口"></a>
## Inputs and Coverage Gaps

Reuse the following existing repository assets and independently measured input properties; these are not UI screenshots or empty-state placeholders and have not been imported.

| Original image | Independent properties and known content | SHA256 |
| --- | --- | --- |
| [icon.png](./../../../resources/icon.png) | PNG/RGBA, 1024×1024, 1 frame, 92265 bytes; white rounded background, green book-page/sprout pattern | `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2` |
| [banner1.webp](./../../../src/renderer/src/assets/banner1.webp) | WEBP/RGBA, 640×520, 1 frame, 25854 bytes; green house-shaped paper, geometric shapes, and sketched arm | `5f7603294a62dbed3f5feb937b0908a40679cac7ab5d0ac3236fd9e03551c3d3` |

The images support identity, static content, independent dimensions, non-square aspect ratio, and some zoom/pan checks. Do not assume a fixed background for transparent regions. A 640×520 image is not guaranteed to fit below/above 100% in any viewport; measure geometry using the real viewport. Missing samples: large image, extreme aspect ratio, independently corrupted image, read-failure condition, GIF/SVG/JPEG orientation. Do not remove unready criteria or replace real input with fabricated failure responses, internal store, or preselected coordinates. More complete image editing, transform API, natural entry point, error recovery, and fit/clamp conflict remain unverified.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision was images/4. In line with the user's pre-release quick-review goal and unified adoption rule, quick-review and focused-scenario layers were added to the same requirements document, reusing source binding, exact artifact, and existing Review. Historical business version v`0.3` and full criteria remain unchanged. Selected sources are explicit subcriteria under IMAGE-OBS-001–003; required references are existing `eval-image-20261030.png` and independent original dimensions/content. Do not assume a fixed background for transparent regions. Not selected: actual-size round-trip, manual 1%–3200% limits, drag/edges, extreme fit, transients, 006 errors, or image editing. Any portion lacking evidence remains pending confirmation.

This only completes pre-execution layering. It produces no product pass result and does not supersede historical full runs. Later runs consume subcriteria frozen by a separate Review; a quick-review result must not be described as covering the full original IDs. This build added no product operations or data-write permissions.
