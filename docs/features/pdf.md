<a id="pdf-文字选区与标注几何"></a>
# PDF Text Selection and Annotation Geometry

Read this page when changing PDF viewer text selection, annotation projection, or export. It describes current implementation boundaries, not historical acceptance results. For selection provenance when adding a selection to a conversation and write-back permissions, see [selection knowledge](selections.md).

<a id="当前机制与理由"></a>
## Current Mechanism and Rationale

- When generating notes from annotations, the notes panel receives a streamed preview of the prose through SSE. The preview uses the existing Markdown projection, hides provenance markers at paragraph ends, and omits orchestration messages. Each paragraph can bind multiple sources, and sources can be reused across paragraphs; the model no longer creates a separately numbered source table. Generated text is not persisted while streaming. Completed text is saved as described in the “Text-First Trial” below. If provenance validation fails, the user is told that it needs review; if generation fails, the preview remains explicitly marked unsaved. The preview follows the literature-item identity, so changing panels does not lose current progress.
- Writing prose for annotation-generated notes uses the low-latency policy and disables toggleable thinking when supported by the model. Orchestration calls do not force an override of the reasoning-effort setting. Ordinary chat settings remain independent.
- [Page](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx) uses the installed version of PDF.js `TextLayerBuilder` and cancels rendering, events, and the text layer when a page is replaced or unmounted. The PDF integration stylesheet ([PDF integration styles](../../apps/desktop/src/renderer/src/features/workbench/pdf/pdf.css)) preserves the text layer's `endOfContent` selection boundary. Using a bare TextLayer previously caused cross-line selection to fall through to the text-layer root and include preceding text. Do not remove this selection boundary to adjust appearance.
- `selectionRectangles` in [geometry](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.ts) collects only the selected text-node ranges, because calling `getClientRects()` on a whole `Range` also includes surrounding spans. `PdfDocument` then clips the rectangles to the page and normalizes quadrilaterals. `normalizeQuads` merges only overlapping or adjacent fragments on the same line; it does not fill whitespace between columns.
- [External links](../../apps/desktop/src/renderer/src/features/workbench/pdf/links.ts) turns only valid HTTP(S) URLs in PDF `Link` annotations with finite numeric rectangles into page hit targets. [Page](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx) opens them in the system browser through `openExternal` and does not pass arbitrary PDF URIs to external programs. Internal outlines and in-page destinations are handled separately by [navigation resolution](../../apps/desktop/src/renderer/src/features/workbench/pdf/navigation.ts); do not conflate them with external-link paths.
- The [navigation sidebar](../../apps/desktop/src/renderer/src/features/workbench/PdfDocument.tsx) reuses `ResizablePanel` and currently ranges from 190px to 360px wide. [Outline items](../../apps/desktop/src/renderer/src/features/workbench/pdf/Outline.tsx) truncate to one line and show full text via `EllipsisText` when actually overflowing; non-navigable items remain inspectable on hover. Search uses a soft-wrapping `Textarea`. Enter/Shift+Enter shortcuts navigate matches only while the search box is focused, and the sidebar and result list must not overflow horizontally. The old 160px minimum is not a current constraint.
- [Wheel zoom](../../apps/desktop/src/renderer/src/features/workbench/pdf/zoom.ts) takes over PDF-viewport wheel events only when Ctrl/Command is held; ordinary scrolling remains page scrolling. `PdfDocument` combines bounded deltas into animation frames and remembers the page coordinate under the pointer, restoring the same anchor after zoom. Changes must also check fine-grained trackpad input, zoom bounds, and anchor stability.
- [Annotation projection](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.ts) sorts stably by creation time and ID. A newer annotation of the same style obscures overlapping areas of an older annotation only in the visible projection; saved records are not deleted. Rendering and hit-testing reuse this projection, so the older annotation reappears when the newer one is deleted. The [highlight visual layer](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.tsx) alone uses `mix-blend-darken` to keep glyphs clear; do not apply this blend mode to the hit layer.
- [Reading AI state](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx) identifies a selection by its content. When a new selection appears, it clears the explanation panel's expanded state, supplemental-note draft, and old selection snapshot together, so the previous selection request cannot carry over. General resource-selection suggestions are separately closed by the [Workbench selection Owner](../../apps/desktop/src/renderer/src/features/workbench/Selection.tsx) when they are unpinned and an external pointer action occurs. Do not treat “the input still has focus” as a reason to keep an old floating window open.
- Floating-window capabilities depend on the actual entry point. Translation/explanation results from [general selection suggestions](../../apps/desktop/src/renderer/src/features/resources/Suggestion.tsx) support Pin; pinning preserves only that suggestion's lifecycle and does not restore a cancelled selection. The [PDF Reading result window](../../apps/desktop/src/renderer/src/features/workbench/pdf/Reading.tsx) reuses the draggable `FloatingWindow` but currently does not pass `onPinnedChange`, so the old claim that “all PDF AI windows can be pinned” no longer applies. The [PDF contract](../../apps/desktop/src/renderer/src/features/workbench/pdf.test.ts) explicitly locks this difference. Writing an annotation from a result uses the completed result's page, text, and quads; only if geometry is absent does it fall back to the current request snapshot. It does not reread the DOM selection. Changes must check source identity and save conflicts.
- The geometry normalization for an annotation is also used in [PDF export](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.ts). When changing overlap policy, check display, hit-testing, persistence, and export separately instead of inspecting a screenshot of one color only.
- The [project-record Owner](../../apps/serve/service/workbench/service/records.py) and [literature attachment entry](../../apps/serve/service/literature/api/reading.py) read embedded records on first access, and the [native annotation parser](../../apps/serve/service/platform/annotations.py) adds Highlight, Underline, StrikeOut, Squiggly, Text, and FreeText annotations. Text is extracted from character centers within QuadPoints, and coordinate transforms include CropBox and rotation. Comments are associated only through explicit IRT links. Existing records are backfilled once using revision/CAS and retain the `native_annotations` source description; clearing annotations as a user does not trigger another import. Copying into a project still follows `copy_records`. / Both record owners reconcile embedded records and native PDF reading annotations. Per-quad text, crop/rotation geometry and explicit reply links are preserved. Revision-guarded backfill retains source descriptors through edits and deletions; explicit copy policy still applies.
- Invalid embedded JSON, schemas, or associated records produce warnings and are ignored; independently valid native annotations remain readable. Pure scans, color flattened into page content, or marks without a text layer do not produce invented excerpts. A geometry-only mark without an excerpt or comment cannot be used to generate notes. / Invalid embedded records are logged and ignored independently of valid native annotations. Flattened paint and scanned marks do not create invented excerpts; geometry without text or comments is ineligible for note generation.
- [PDF export restoration](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.ts) removes, in memory only, native annotations and Popups matching source descriptors, plus trailing deep-paint annotation streams whose full drawing instructions and graphics state match embedded records. Unknown annotations, links, body content, and the on-disk source file remain intact. Export applies inverse crop/rotation transforms, and repeated exports do not accumulate old highlights. / Viewer and export restoration remove only matched native annotations/popups and exactly matched ScholarSeed paint in memory. Links, unmatched annotations, source content and original files remain intact; export applies inverse crop/rotation transforms and avoids accumulated paint.

<a id="selection-translation--划词翻译"></a>
## Selection Translation

- **current**: A selection translation freezes the document revision, selected text and geometry, effective model, language choice and attempt identity. Preview, completed text, copy and annotation use that snapshot. A new selection invalidates the previous selection's display eligibility; historical results cannot become a new attempt's result. Changing configuration keeps the old translation explicitly labelled with its applied language until refresh.
- **current**: The selection result must cover the selected source. The service checks the declared target and rejects clear Chinese/English body contradictions while preserving identifiers, names, necessary terms and same-language content. This is a bounded contradiction check, not general language identification or a guarantee of translation quality; it does not classify a bibliography by its overall character ratio.
- **current**: A target-language failure permits at most one correction with the original source, target and model. The existing invocation store keeps rejected provider attempts separately from the logical task's validated result. A second failure remains an explicit failure and cannot be copied or published as a completed translation. Correction success is disclosed in the result window; the service never silently switches model or translation provider.

<a id="自动图表与公式框"></a>
## Automatic Diagrams and Formula Boxes

- Reader interaction regions are owned by [regions](../../apps/desktop/src/renderer/src/features/workbench/pdf/regions.ts). After canvas rendering completes successfully, they use PDF.js `getOperatorList` drawing-path bounds, affine transforms, and distinct image instances from `imageCoordinates`, grouped with text geometry on the page. Interaction regions are no longer loaded from a backend manifest. Operation-level `recordedBBoxes` accumulates dependency and subsequent-operation bounds on the operation, and may not cover the full operator list; it is not an independent object boundary.
- Grouping first builds connected drawing components, then limits nearby-label association using body text, captions, and header separator lines. Vector-glyph labels also participate in nearby association. Repeated aligned shaded rows are recognized as tables; complete cells and adjacent shaded headers are included by row bands. Equations are candidates based on display lines and mathematical relations; superscripts/subscripts and numbering are included without swallowing body text on the same line. No fixed magnification box or example-page-number rule is used.
- **current**: A table is independently recognized when it has a caption, at least three aligned horizontal rules of the same width, and repeated rows with multiple aligned columns; shading is not required. A complete horizontal-rule boundary is closed and no longer expands to a caption or following section based on nearby labels. A caption, rules, or multi-column text alone is insufficient to create a region. A shaded-row table also requires neighboring-row support; a flowchart with arrows is not classified as a shaded table.
- **current**: When font ascent/descent is non-finite, finite fallback metrics are used; geometry is checked for finiteness both during grouping and in output. Equations exclude lists, code, and obvious body text. An unnumbered display line must also be locally centered in its column; a short equation additionally requires a mathematical relation and whitespace above/below. Text across a header separator is not considered part of the same body block. Global width or grouping distance is not reduced; candidates that fail completeness or attribution requirements are omitted.
- Display, hit-testing, and operations reuse the same `PdfVisualRegion`. Copying passes quadrilaterals to the existing literature/resource image-crop entry point, which still validates project/attachment access and source revision before validating finite, legal page coordinates. Explanation and equation recognition pass the `rect` derived from the same region, not a backend `region_id`, so the server does not select an old region again.
- Backend layout/extraction continues to own body extraction, citations, and body-exclusion policy. `text_policy: retain` on an interaction region is not a body-exclusion rule; expanding chart hit regions must not change body indexing. The existing manifest API remains a backend index projection, not a second source of truth for reader selections.
- **gap**: Geometry alone cannot guarantee arbitrary PDF semantics. Vector paths in optional-content marks are conservatively excluded as independent seeds, and curved clipping uses only the bounding box. Complex transparency groups, non-rectangular clipping, and borderless tables with misaligned text still require regression against real samples. Grouping accuracy, real copying, and model explanations require separate acceptance; geometry probes do not establish real Desktop acceptance or a corpus-wide accuracy improvement.
- **gap**: Recognition is not guaranteed for tables without captions, with missing closed rules, spanning pages, or insufficient column-structure evidence, nor for unnumbered multi-line equations mixed with explanatory text. Sample inspection reports only on pages inspected; it cannot prove zero false positives for arbitrary papers.

<a id="验证边界"></a>
## Verification Boundaries

[Record contract](../../apps/serve/tests/contract_pdf_records.py) and [attachment-import contract](../../apps/serve/tests/contract_attachment_import.py) cover first initialization, existing records, and copy boundaries. Select the execution entry according to the [Serve test-path rules](../runbooks/development.md#按改动选择命令与证据); do not confuse the root `tests` package with the same-named package under `apps/serve`. The [geometry tests](../../apps/desktop/src/renderer/src/features/workbench/pdf/geometry.test.ts), [text-layer rendering tests](../../apps/desktop/src/renderer/src/features/workbench/pdf/Page.render.test.ts), and [export tests](../../apps/desktop/src/renderer/src/features/workbench/pdf/export.test.ts) cover their respective contracts. Selection jitter, cross-line text/superscripts, reopening annotations in both libraries, export content, and the toolbar still require acceptance in the current real Desktop build with representative PDFs. Screenshots and pass counts in old work records do not prove the current revision or Windows has passed.


<a id="paragraph-sources-in-generated-notes--生成笔记的段落来源"></a>
## Paragraph Sources in Generated Notes

Generated note text stays plain Markdown. The literature note stores a separate
JSON provenance field derived from the accepted source map and frozen selection.
Preview attaches existing source controls after each uniquely matching paragraph;
source identities can be reused across paragraphs. Changed or ambiguous paragraphs
show a warning and do not receive stale controls. Existing manually attached source
links remain readable. Markdown export contains only the note text; this change
does not add a sidecar download to the export dialog. The annotation note writer
requests disabled thinking through declared provider controls; unsupported controls
still follow the existing model capability policy.

Generated note text remains plain Markdown. Provenance is stored in a separate JSON field on the literature note, resolved from the accepted source map and frozen selection. Preview shows existing source controls after uniquely matching paragraphs; a source may be used by multiple paragraphs. Modified or non-uniquely matched paragraphs show a notice and do not retain stale associations. Existing manually inserted source links remain readable. Markdown export contains only the text; this change does not add a download entry for the accompanying JSON. Annotation-note writing disables thinking through a vendor-declared control request; unsupported controls continue to follow the existing model-capability policy.

- Generation input prioritizes full annotations and comments, while related source text retains its context index. Local code determines provenance acceptance: if reading signals were supplied but none has an explicit association, provenance acceptance fails, though the text-first trial below still retains the body. Partial omissions may be saved, with “captured but unused” provenance controls shown directly at the end of the preview. Unassociated sources are not appended to Markdown or presented as paragraph provenance. / Generation input presents full marks and comments first, with indexed paper context. Local provenance acceptance rejects outputs with no explicit reading-signal references when signals were supplied; the text-first trial below still retains their text; partial coverage may be saved, with directly visible “captured but unused” source buttons at the end of the preview. Unreferenced sources are never appended to Markdown or presented as paragraph provenance.

- Marks without excerpt text are retained as distinct location sources, separate from their comment identities. Input snapshots and source lookup share the same source enumeration so valid location markers do not cause save failures. / Marks without extracted text retain distinct location sources, separate from their comments. Input snapshots and source resolution share source enumeration so valid location references remain saveable.

<a id="text-first-trial--正文优先试验"></a>
## Text-First Trial

The annotation-note host enables `writing.py accept --preserve-text`. Completed
nonempty Markdown is retained verbatim as `note.raw.md`. When source validation
fails or a valid source map is unavailable, the app saves that original text with
an unverified-provenance notice; raw source markers remain visible. Validated
results keep the existing clean text and paragraph source controls. Partial model
responses, changed input bindings, and persistence failures are not accepted.
The strict writer mode remains available without this flag. This stage does not
infer corrected IDs or turn uncertain citations into verified source buttons.

The annotation-note entry enables `--preserve-text`: the complete, non-empty body is retained unchanged as `note.raw.md`.
If source validation fails or the valid source map is unavailable, the application still saves the raw body, shows a provenance-review notice, and retains the original source markers. On successful validation, it uses the clean body and post-paragraph controls. Incomplete responses, changed input bindings, and save failures still return errors. Without this parameter, strict mode remains in effect; this stage does not guess or correct source IDs.

<a id="local-reference-index--本地来源索引"></a>
### Local Reference Index

The second stage indexes explicit paragraph source IDs against `reading.json`,
independently of semantic acceptance and without another model call. Generation
publishes the reading index as an optional supporting artifact. A missing, invalid,
oversized or unreadable index never prevents completed raw text from being saved.
The note panel provides source-index export without a manual import entry.
The Markdown remains unchanged; the index is stored separately with the note
and can be exported as `note-index.json`.

Only the preview hides recognized transport markers and places annotation,
and comment controls after their exact unique paragraph. Unknown IDs
remain visible. Captured but unused marks and comments appear at the bottom;
using a location mark does not imply using its comment. Indexed means an ID can
be looked up, not that the source supports the paragraph's claim. Modified or
ambiguous paragraphs lose their old controls. Nested or unsupported Markdown
paragraphs remain unchanged with an explicit notice.

The second stage uses `reading.json` to build a local index of explicit source IDs; it makes no further model call and does not depend on semantic acceptance.
The generation entry publishes the reading index as an optional artifact. A missing, corrupt, oversized, or unreadable index does not prevent saving the complete original text.
The notes panel provides source-index export and no longer shows a manual-import entry. Markdown remains unchanged; the index is saved separately with the note and can be exported as `note-index.json`.

Only the preview hides recognized transport markers and places annotation/comment controls after a uniquely matching paragraph.
Unknown IDs remain visible. Captured but unused annotations and comments are listed at the end; a citation-location marker is not the same as its associated comment.
“Indexed” means only that the ID can be looked up; it does not mean that the content-support relationship was verified. Modified or duplicate paragraphs do not reuse old controls. Nested or currently unsupported Markdown paragraphs remain unchanged and display a notice.

Reference groups use a compact `[source kind] ‹ position / total ›` control. The
source kind is a non-interactive badge with regular text; arrows and count are enlarged
and bold. Only the arrows are interactive. Each
arrow selects the previous or next source and navigates to its PDF location;
boundary arrow is disabled for multi-source groups. For a single source, either
arrow locates that source. Page and excerpt remain available in the tooltip.
The same control is used for captured-but-unused sources at the bottom.
Paper-text sources retain their saved index but show no reference or navigation
controls in preview. Annotation and comment controls remain available.
The opening bibliographic paragraph also has no navigation controls.

Reference groups use the compact UI control `[来源类型] ‹ 当前序号 / 总数 ›` (“[source type] ‹ current index / total ›”). The source type is a non-clickable badge at regular font size and weight; arrows and counts are larger and bold, and only the left/right arrows are interactive. Arrows switch to the previous or next source and navigate to its PDF location. For multiple citations, the arrow at each end is disabled; with a single citation, both arrows navigate to that source. Page numbers and excerpts remain in the hover tooltip. Unused sources at the end use the same one-at-a-time browsing control.
Paper-text sources retain their saved index, but the preview shows no citation or navigation controls for them; annotation and comment controls remain available.
The opening bibliographic-information paragraph also has no navigation controls.

Successful indexing adds no persistent explanatory banner. Actual unresolved IDs
or skipped paragraphs still have their specific notice.

Successful indexing does not leave a persistent explanatory banner. A specific notice remains when there are unknown IDs or skipped paragraphs.
