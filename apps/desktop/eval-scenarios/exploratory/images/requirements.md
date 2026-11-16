<a id="图片查看"></a>
# Image Viewing

## Target-Version Complete-Window Reference for Image Viewing

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows a synthetic image fitted to the window and its toolbar; does not prove zoom actions, clamping, or error branches.

Image-viewer page reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12. Shows one zoom state for a synthetic image; does not represent clamping, dragging, or failure states.

Verified normal image loading, dimensions, and viewing actions are adopted as v`0.3` requirements. Only adopted normal automatic subcriteria enter the default quick review; unconfirmed branches and focused scenarios remain separate.

The extreme fit-versus-clamping relationship in 004, edge dragging/gesture semantics in 005, operation eligibility after failure in 006, and unverified format/editing capabilities remain pending confirmation.

Identify an opened image in the project workbench and adjust its viewing scale and position as needed. The semantic entry point is the normal open action for an image in project materials. Reachability of the viewer and toolbar requires an authorized observation; a menu or format registration alone does not prove reachability.

<a id="看清正确的图片"></a>
## Identify the Correct Image

<a id="加载与文档身份image-obs-001--v03"></a>
### Loading and Document Identity (IMAGE-OBS-001 · v`0.3`)

Dynamic/conditional: After opening, the active-tab identity and known visual pattern correspond to the same authorized image; do not show another document. Show a loading state while loading; after success, show a discernible image and available viewing actions. Compare the original-file digest, known content, and this run's project/path. A matching tab title or successful load API alone does not prove the image is displayed.

<a id="原始尺寸与内容image-obs-002--v03"></a>
### Original Dimensions and Content (IMAGE-OBS-002 · v`0.3`)

Dynamic: The “width × height” in the image toolbar matches pixel dimensions independently decoded from the original file and does not change with zoom. Preserve the original aspect ratio and discernible content. For transparent images, transparency is displayed against the current viewer background; do not require a fixed background absent from the original. Semantics for animated images, intrinsic vector dimensions, and orientation metadata await samples and evidence.

<a id="调整观看方式"></a>
## Adjust the Viewing Mode

<a id="适应窗口与实际大小image-obs-003--v03"></a>
### Fit to Window and Actual Size (IMAGE-OBS-003 · v`0.3`)

Dynamic/light interaction: “适应窗口” (“Fit to Window”) scales the complete image proportionally and centers it within the current image viewport; it remains fully visible after window or pane resizing. “实际大小” (“Actual Size”) returns to 100%; displayed image width/height correspond to the original pixel dimensions in CSS pixels, not physical pixels in a high-DPI screenshot. Compare original dimensions, actual visible viewport, and image geometry; percentage alone is insufficient.

<a id="放大缩小与限幅image-obs-004--v03"></a>
### Zoom In/Out and Clamping (IMAGE-OBS-004 · v`0.3`)

Dynamic/light interaction: Use toolbar zoom in/out; percentage and visible image geometry change together without distortion. Manual zoom is limited to 1%–3200%; once a boundary is reached, the corresponding direction cannot move beyond it. Use pre/post-action visible patterns and image geometry plus original dimensions as references. The relationship between “Fit to Window” and manual limits at extreme sizes remains unconfirmed; do not approve an anomalous jump as expected behavior.

<a id="拖动与找回图片image-obs-005--v03"></a>
### Dragging and Recovering the Image (IMAGE-OBS-005 · v`0.3`)

Dynamic/light interaction: Once the image is ready, dragging with the primary pointer changes viewing position; after ending or canceling the drag, the image no longer follows the pointer. Cropping by the viewport does not mean the source file was cropped. “Fit to Window” or “Actual Size” can recenter it. Edge clamping, how far the image may be moved off-screen, and wheel/gesture support remain unconfirmed; current implementation does not establish a requirement for unlimited dragging or unverified gestures.

<a id="遇到不能显示的文件"></a>
## When a File Cannot Be Displayed

<a id="失败反馈与操作资格image-obs-006--v03"></a>
### Failure Feedback and Operation Eligibility (IMAGE-OBS-006 · v`0.3`)

Conditional focused scenario: An authorized real read failure or undecodable image cannot be presented as successfully loaded. Show understandable failure feedback and do not continue to offer viewing operations that depend on an image being ready. After opening another normal image successfully, its correct content remains discernible. The error shell may differ depending on when failure occurs; not every failure must use identical wording.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

Adopted normal branches of 001–005 belong to the independent image quick review; unconfirmed boundaries are not included on that basis. 006 remains a pending-confirmation error scenario and requires an authorized, traceable corrupt/read-failure condition for execution. If a loading transient cannot be observed, retain the evidence gap. Small samples cannot prove extreme zoom, aspect ratios, or large-image behavior.

See the [Build Basis](./build.md#输入与覆盖缺口) for original images and independent dimensions; use the current run's receipt for preparation state. Data preparation is not an import-feature test; import requires user confirmation. File-content saving eligibility is referenced from [saving scenario SAVE-OBS-001](../saving/requirements.md); clean close reuses [tab scenario TABS-OBS-002](../tabs/requirements.md); unsaved-change protection reuses TABS-OBS-008 only when an actual writable editing scenario applies. Do not treat a change in viewing scale as file editing. Independent rotate/crop/transform entry points have not been verified and cannot be inferred from viewer registration; if there is a separately confirmed editing requirement, still verify its write scenario.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: IMAGE-OBS-001–003. This covers only the scope below, not every detail under these IDs.

Opening the normal PNG should show a discernible green book-page/sprout pattern on a white rounded background; natural size is 1024×1024. Perform one ordinary Fit to Window; verify complete image content against the available viewport using the original and before/after geometry, without relying on internal `scale`/store.

Required reference: an authorized isolated copy of [icon.png](../../../../../examples/projects/evaluation/files/icon.png) in the shared evaluation project, project/path mapping, and independently measured original dimensions/content. Do not assume a fixed background for transparent regions.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: Actual Size round-trip, manual 1%–3200% limits, dragging/edges, extreme Fit to Window, transients, 006 errors, or image editing. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.
