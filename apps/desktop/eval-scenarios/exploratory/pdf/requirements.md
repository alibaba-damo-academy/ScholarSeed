<a id="pdf基础阅读"></a>
# Basic PDF Reading

PDF search showing no matches

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; one no-match search in a synthetic PDF. The document body is only partly visible in the full viewport because the side-by-side pane is narrow. This does not establish other searches or passage of a formal evaluation.

PDF reading page reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; the first page of a synthetic PDF. This does not represent annotations, selections, or error states.

Page 1 of a two-page synthetic PDF

Page 2 of a two-page synthetic PDF

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; the two images show page 1 and page 2 states for PDF-OBS-001 and 002, respectively. The screenshots alone do not prove that page navigation occurred, nor do they establish that outlines, zoom, annotations, or error states were verified. See the [build basis](./build.md).

Outline with page 2 selected

Outline with page 1 selected

Search result: third match

Search result: second match

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; the first two images show outline selection states for the two-page synthetic PDF, and the last two show the third and second search-result states. Still images alone do not prove navigation, match positioning, or switching actions, and do not establish passage of the ten-page sample or other PDF requirements. See the [build basis](./build.md) for the source and this round's independent-review boundary.

Thumbnail for page 1 selected

Thumbnail for page 2 selected

Reference: the same target version, 2026-11-13; the images show thumbnail selection and the corresponding document-body state for each page of the two-page synthetic PDF. Still images alone do not prove a click or navigation, or establish passage of long thumbnail lists, the ten-page sample, error cases, or complete PDF functionality.

PDF at ordinary zoom-in

PDF at ordinary zoom-out

PDF in fit mode

Reference: the same target version, 2026-11-13; ordinary zoom-in, zoom-out, and fit states for a two-page synthetic PDF in that session's split-pane layout. Part of the document body is clipped in the zoom-in image. The original fit-page and fit-width images are byte-identical in this layout and are represented by one copy. Still images alone do not prove the mode, zoom action, or geometric relationship, or establish passage at limits, in other layouts, or for complete PDF functionality.

<a id="标注退出与笔记布局补充约束"></a>
## Supplemental Constraints for Exiting Annotation and Notes Layout

Pressing Esc once must still exit continuous annotation while its button remains hovered or keyboard-focused and its tooltip is visible; clicking the document body or moving the pointer first is not required. A subsequent selection creates only a temporary selection and must not add a saved annotation. Color submenus and comment inputs retain their own Escape priority.

One Escape must exit continuous annotation even while its button remains hovered or keyboard-focused with a visible tooltip; moving the pointer or focusing the document first is not required. Subsequent selection stays temporary without creating a saved mark. Color menus and comment inputs retain their Escape priority.

For the fix to Bug 88837628 confirmed by the user on 2026-11-12, Esc dismisses the current PDF text selection or selected-annotation toolbar. After exiting continuous highlighting or underlining, a subsequent selection must not continue to create annotations automatically. Exiting preserves saved annotations. IME composition, input fields, nested overlays, and interactions that have already consumed Esc retain priority; other split-pane documents are not cleared.

For Bug 88838604, also confirmed by the user that day, the PDF notes panel supports resizing by dragging its left edge or using the keyboard, with controls to fill the PDF reading area and restore the prior layout. Expanding and restoring preserve the adjusted width, content being edited, and the same editor instance. Existing AI interpretation split-pane and expansion behavior remains unchanged; the information panel's layout does not change as a result.

These are confirmed supplemental checks. They do not expand the basic-reading quick-check denominator or imply operating-system-level fullscreen. No separate requirement version was specified; retain the existing stable IDs and version markers. Regress PDF-OBS-003, 008, and 009 and the literature-notes supplement. Authorization for real-data writes and product startup must still be checked separately.

For user-confirmed Bugs 88837628 and 88838604 (2026-11-12), Escape dismisses the current PDF selection or selected-annotation toolbar and exits continuous highlighting or underlining without deleting saved annotations. Editable fields, IME composition, nested overlays, consumed events, and other document panes retain their interaction boundaries. The notes panel supports left-edge and keyboard resizing, filling the PDF area, and restoring its width and the same editor with its draft intact. Existing interpretation and information-panel behavior remains unchanged. These are supplemental checks, not OS fullscreen or additions to the basic-reading quick-check scope; existing requirement IDs and version markers remain unchanged.

Verified normal PDF reading and navigation behavior has been adopted as the v`0.3` requirement. The outline/text extraction failures in 004–005 and the error feedback, encryption, and partial-failure branches in 007 remain pending confirmation; adopting normal reading does not approve them.

Read PDFs in the workbench and locate content using page numbers, zoom, the outline, search, and page thumbnails. The semantic entry point is the PDF reader after a resource opens normally. The onboarding sample can also display the reader, but does not represent real literature or AI capabilities; the specific entry point remains subject to authorized observation.

<a id="阅读与定位页面"></a>
## Reading and Navigation

<a id="加载与文档身份pdf-obs-001--v03"></a>
### Loading and Document Identity (PDF-OBS-001 · v`0.3`)
Dynamic and conditional: A valid PDF with preview capability must transition from loading to a recognizable document body. The toolbar's total page count must match the page count of the same independently verified sample; placeholders for unloaded pages do not count as rendered content. Compare the document identity, public source, and sample summary for this run. A file extension or visible reader shell does not establish successful loading.

<a id="页码与翻页pdf-obs-002--v03"></a>
### Page Numbers and Navigation (PDF-OBS-002 · v`0.3`)
Dynamic: Previous/next controls, page-number input, and applicable navigation/first/last/jump shortcuts must reach the sample's known target page. The current page number must track the actually predominant visible page and stay in range. Judge using the page number, content or imagery unique to the target page, and actual positions before and after the action. An input-field change or button acknowledgment alone does not prove navigation; physical page order is not the same as printed page numbering.

Citation-navigation supplement confirmed by the user's two screenshots on 2026-11-11: When a conversation citation contains multiple evidence regions, the actions “上一处依据 / 共N处或当前位置 / 下一处依据” (previous evidence / total N or current position / next evidence) use a floating toolbar with up/down arrows. It sits at the upper right of the PDF reading area, below the header, without taking space from or obscuring the header's translation settings or export action, and without covering the right toolbar. It remains fixed while the document scrolls; its buttons remain accessible in narrow panes. Evidence order, counts, disabled boundary states, actual navigation, and highlights retain their original semantics. Show no switching toolbar for zero or one evidence region. This supplement does not expand the basic-reading quick-check denominator.

Citation-location supplement confirmed by the user's two screenshots on 2026-11-11: when a conversation citation contains multiple evidence regions, previous/count-or-position/next actions appear in a floating toolbar with up/down arrows at the upper right of the PDF reading area, below the header. It must not overlap translation settings, export, or the side rail. It stays fixed while pages scroll and remains usable in narrow panes. Evidence ordering, counts, boundary disabling, actual navigation, and highlights retain their semantics; zero or one region shows no navigation strip. This supplement does not expand the basic-reading quick-check scope.

An open navigation sidebar must not clip the floating toolbar's buttons or arrows. Labels may be truncated when space is limited, but full tooltips and accessible names must remain available. Document highlights must not cover the floating toolbar.

An open navigation sidebar must not clip the floating toolbar's buttons or arrows. Labels may truncate when space is limited, while full tooltips and accessible names remain available. Document highlights must not paint over the toolbar.

Citation navigation jumps immediately to the target page, then scrolls smoothly within that page to the highlight. When the system's “Reduce Motion” setting is enabled, the within-page move is also immediate. A page-only citation jumps directly to the page. For distant pages, observe the transition to confirm that intermediate pages are skipped, then verify the target page number and source-text highlight.

Citation navigation jumps immediately to the target page, then scrolls smoothly within that page to the highlight. With reduced motion enabled, the within-page move is also instant. A page-only citation just jumps to the page. For distant citations, observe the transition to confirm it skips intervening pages, then verify the page number and source highlight.

<a id="缩放与适应模式pdf-obs-003--v03"></a>
### Zoom and Fit Modes (PDF-OBS-003 · v`0.3`)
Dynamic: Zoom in/out, percentage editing, fit-page/fit-width switching, and applicable shortcuts must change the actual document-body scale. The displayed percentage must correspond to the active mode, and zooming must not switch documents accidentally or lose the current reading page. The custom zoom range is 10%–500%. Judge using known page aspect ratios, the currently available reading area, and before/after relationships; do not rely on fixed screenshot pixels or treat a displayed percentage change alone as proof of successful zooming.

<a id="从内容找到页面"></a>
## Find Pages from Content

<a id="目录结构与目标页pdf-obs-004--v03"></a>
### Outline Structure and Target Pages (PDF-OBS-004 · v`0.3`)
Conditional: A sample with a native outline must show the corresponding titles and hierarchy. Expanding/collapsing it and navigating from parseable entries must reach the outline targets known in advance; entries without parseable destinations must not navigate incorrectly. A PDF with no native outline may show an empty-outline state; generating an outline automatically from document headings is not required. A known outline that fails to load must not pass as a correct no-outline state.

Per the user's screenshots and explicit sizing request on 2026-11-11, outline expand/collapse buttons measure 28×28px with 14×14px arrows. Title rows and selected, pressed, and hover backgrounds are uniformly 28px high at every depth, without changing indentation, expansion, or page-navigation behavior.

Per the user screenshots and explicit sizing request on 2026-11-11, outline expand/collapse buttons measure 28×28px with 14×14px arrows. Title rows and selected, pressed, and hover backgrounds remain 28px high at every depth, preserving indentation, expansion, and page navigation.

<a id="文本查找与命中定位pdf-obs-005--v03"></a>
### Text Search and Match Navigation (PDF-OBS-005 · v`0.3`)
Dynamic and conditional: Enter known sample text in the search area. Result entries, match counts, and previous/next match switching must correspond to the text and pages verified in advance. Selecting a result must position the document at the actual match. Distinguish searching, no matches, no text layer, and search failure. Searchability or automatic OCR is not promised for image-only scanned PDFs; absence of a text layer must not be treated as failure to find known searchable text.

<a id="页缩略与正文对应pdf-obs-006--v03"></a>
### Page Thumbnails and Document Correspondence (PDF-OBS-006 · v`0.3`)
Dynamic: The thumbnail area shows the corresponding physical page order and recognizable thumbnail content, and scrolling reveals later thumbnails. Selecting a target thumbnail must navigate the document to that page, with the current-page indicator matching the body. Verify using known target-page features and actual positions before and after; all distant thumbnails need not finish rendering immediately on first open.

<a id="理解不可阅读状态"></a>
## Understand Unreadable States

<a id="错误受保护文件与加载边界pdf-obs-007--v03"></a>
### Errors, Protected Files, and Loading Boundaries (PDF-OBS-007 · v`0.3`)
Conditional supplement: A damaged or unrenderable PDF must provide understandable feedback appropriate to the failure layer, without pretending that the document is ready. Known encrypted files must be distinguished from ordinary corruption; do not require an undeclared decryption flow in the built-in reader. Judge loading and errors against known sample properties or an independently established failure precondition; a transient loading screen alone does not establish failure. Opening the file externally is a separately authorized action.

<a id="验证归属与数据"></a>
## Verification Scope and Data

The adopted normal branches of 001–006 belong to the ordinary-reading quick check, provided that an authorized readable sample and independent page-count, target-page, outline, and text-layer references are available. A single-page or no-outline sample cannot establish coverage of multipage, outline, or match-switching branches. 007 and special failure branches remain conditional supplements pending confirmation; missing data stays marked for coverage and must not be moved retroactively to make the result green.

The [shared example project's two-page synthetic PDF](../../../../../examples/projects/evaluation/files/sample.pdf) has a text layer and a two-level native outline. “Needle” appears only on page 1, “padding” only on page 2, and “PDF” appears three times across both pages; use them to compare page navigation, search, and thumbnails. Use this round's receipt as the authority for preparation status. Damaged, encrypted, and partial-failure samples remain to be prepared; long thumbnail lists and large-document behavior are not covered by this sample.

The [single-page image-only synthetic PDF](../../../../../examples/projects/pdf-image-only/files/image-only.pdf) has visible text embedded in an image and no text layer, and can be used to prepare the no-text-layer conditional supplement. It promises neither OCR nor a particular search result, and does not represent all characteristics of real scanned files. See the [build basis](./build.md) for input identity and independent verification. The file is raw input; it does not mean that it has been imported or that the product has passed. A person must confirm any import and verify the isolation target and permissions.

The [independent ten-page synthetic PDF](../../../../../examples/projects/pdf-multipage/files/multipage.pdf) has a unique page-number marker on every page; `CROSS-BATCH-NEEDLE` appears only on pages 8 and 9. It is available for multipage search and subsequent thumbnail-navigation supplements. See the [build basis](./build.md) for input identity and independent parsing. It does not replace the default two-page quick check or prove successful loading, searching, or importing. A person must confirm any import and verify the isolation target and permissions before performing it.

Reading may initialize recent-file records, navigation preferences, and index/auxiliary records; zero writes are not promised. Explicitly authorize these side effects before entering a real flow. Selection, annotation, export/generation/saving, and AI reading remain separate business scopes. They are outside this page's pass denominator and are not verified by passing its basic-reading checks.

<a id="发布快评层"></a>
## Release Quick-Check Layer

Adopted normal subpoints from v`0.3`: PDF-OBS-001 and 002. This covers only the scope below and does not mean every detail under these IDs has passed.

After normally opening the known two-page PDF, document identity and page count must match the independent original. Navigate one page in a valid direction; both the page number and content unique to the target page must change. A page-number change does not substitute for a content change.

Required reference: an authorized isolated copy of the [shared sample.pdf](../../../../../examples/projects/evaluation/files/sample.pdf), together with the original's two-page text/page count and build summary. Preparing data is not an import-function test; a person must confirm any import test.

<a id="专项层"></a>
## Supplemental Layer

Not selected for this layer: zoom/limits (retain the historical nonconformance for 003), outline, search, thumbnails, and errors. Preserve the original full criteria, stable IDs, versions, and historical results. An unconfirmed branch is not approved merely by being assigned to a layer.

<a id="2026-11-05-已确认界面专项"></a>
## 2026-11-05 Confirmed Interface Supplements

The following incremental requirements were explicitly confirmed by the user during this development. They do not retroactively change the versions or historical conclusions of 001–007, or any existing frozen run.

<a id="导航与标注记录pdf-obs-008--v02"></a>
### Navigation and Annotation Records (PDF-OBS-008 · v`0.2`)
As confirmed by the user's screenshot on 2026-11-11, clicking the comment text in a comment-only card on the left must navigate to that page's comment bubble and show its focused state; keyboard activation is supported. Copying, expanding/collapsing, or editing must not navigate, and comment text remains selectable. Automatic zoom or layout changes must not override explicit comment navigation by restoring the original citation that opened the document.

Per the user screenshot confirmed on 2026-11-11, clicking the body of a comment-only sidebar card reveals its page's comment bubble and focused state, including keyboard activation. Copy, expand/collapse, and editing must not navigate; comment text remains selectable. Automatic fitting or layout changes must not replace explicit comment focus with the citation that originally opened the document.

When a citation toolbar is present, the reading area reserves space at the top of the page based on the toolbar's actual height. A wrapped toolbar must not obscure comment bubbles at the top of the page.

When a citation toolbar is present, the reader reserves initial space using its measured height so even a wrapped toolbar cannot cover comment bubbles at the top of the first page.

As confirmed by the user on 2026-11-10, the literature navigation sidebar defaults to 260px wide and preserves the width adjusted by the user. The comment-copy button uses icon-outline-default by default.

As confirmed by the user on 2026-11-10, in-document comment pins and draft entry points use the same neutral background and outline icon color as the right-side comment marker. Comment input reuses the toolbar input style and placeholder “添加评论” (“Add a comment”), with Save and Cancel actions retained.

As confirmed by the user's latest screenshot on 2026-11-10, creating a pinned comment or opening an existing in-document comment expands the comment area in the selection/annotation toolbar directly, without a separate compact input pop-up. The toolbar's comment button is active and the input receives focus; sidebar inline editing retains its existing flow. When a pinned comment has no selected text, formatting, explanation, translation, and source-text copying are unavailable; do not fabricate a text source. If saving a new draft fails, preserve the input. Cancel or Escape creates no record.

As confirmed by the user on 2026-11-10, PDF selection and annotation overlay toolbars default to one row, and the comment icon does not wrap. If available width is insufficient, scroll horizontally within the toolbar without compressing or hiding actions.

As confirmed by the user on 2026-11-10, annotation filters use the same Lucide Highlighter icon as the top bar. Each category tab has a tooltip with its corresponding name, while existing keyboard navigation and selection logic are retained.

As confirmed by the user on 2026-11-10, when the whole document has no annotations, show “暂无标注” (“No annotations”); keep the existing message when a category filter has no results.

Per the incremental requirement confirmed by the user on 2026-11-10, empty states for the PDF sidebar outline, annotation records (including category filters), and search results are centered horizontally and vertically within their respective content areas, using 12px regular weight. The no-outline message is “暂无大纲” (“No outline”). Page previews retain real thumbnails; do not fabricate an empty state.

Per the incremental requirement confirmed by the user on 2026-11-10, the submenu for “更多操作 → 修改标注方式” (“More actions → Change mark type”) opens to the right of its parent menu. The annotation-color button's interaction background has 4px of horizontal padding on each side, and the expand arrow uses the semantic icon-outline-default color.

Per the incremental requirement confirmed by the user on 2026-11-10, selecting an annotation category filter bolds only its text; the icon keeps the same stroke width as when unselected.

In-document text comments, pinned comments, and draft bubbles all use the same line-marked comment icon as the top toolbar. Comment navigation and editing behavior remain unchanged.

The page-number input measures 28×28 logical pixels. Toolbar icons use the semantic outline color. Literature navigation remains on the left, with a 12px left margin shared with the first button in the navigation below. Navigation-button tooltips, in order, are “文献导航” (Literature navigation), “目录” (Outline), “页面预览” (Page preview), and “标注记录” (Annotation records). The three buttons below measure 28×28, with 8px corner radii and 4px spacing.

Annotation cards do not show a mark-type icon before the page number. Source text and comment text use regular 12px/18px typography. The left-side “编辑” (Edit) popover only offers mark-type and color changes; the comment editor shows three lines by default. Copy actions for comments and AI explanations reuse the toolbar's copy icon. The annotation list in the note-generation dialog does not show top or bottom scroll shadows.

<a id="划词面板与翻译滚动pdf-obs-009--v01"></a>
### Selection Panel and Translation Scrolling (PDF-OBS-009 · v`0.1`)
Per the user's confirmation of Bug 88916076 on 2026-11-13, after a selection translation completes, provide an “添加到会话框” (“Add to conversation”) action at the bottom of the result, adding the complete corresponding source text and translation to the draft without sending. Explanation results retain the same entry point. The top-toolbar action continues to add the source-text context; it is not replaced with the translation. Do not offer the result action while generation is in progress or when results are missing or empty. Retain Copy and Add as comment. Keep the button visible and keyboard-operable at both normal and minimum supported window sizes. This is a supplemental check; preserve the existing stable ID, version, and basic-reading quick-check denominator.

Per user-confirmed Bug 88916076 on 2026-11-13, completed selection translations expose a footer action that adds the complete original text and its translation to the conversation draft without sending. Explanations retain the same action. The top toolbar still adds original-text context, not the translation. Generating, missing and empty results do not expose the result action. Preserve copying and adding comments. The action remains visible and keyboard-accessible at normal and minimum supported window sizes. This focused supplement preserves the existing ID, version and basic-reading quick-check scope.

Under the user-approved reopened repair plan for Bug 88834262 on 2026-11-12, bind selection-translation results to the current selection, document revision, target language, and request identity. For the first translation of a changed selection, retain the explicitly chosen target language. If configuration changes without a refresh, preserve the old translation and identify its actual language. Do not present, copy, or cache as a completed translation any result that clearly contradicts the Chinese/English target language or omits source prose. If language validation fails, allow at most one correction using the same source text and target language; if it still fails, show an error and do not retry indefinitely. This constraint does not promise general language identification or translation quality. Preserve authors, terminology, years, and identifiers. Keep this requirement's existing version; race and rejection branches are focused regressions outside the basic-reading quick-check denominator.

Under the user-approved reopened Bug 88834262 plan on 2026-11-12, selection translations bind to the current selection, document revision, target language, and attempt. A new selection retains the explicitly selected target. Changing configuration without refreshing preserves the old translation and identifies its actual language. Clear Chinese/English target contradictions or omitted prose must not become completed, copyable, cached translations. Language validation permits at most one correction using the same source and target; a second failure remains an error, not an unlimited retry. This is not general language identification or translation-quality certification. Preserve names, terms, years, and identifiers. Keep the existing requirement version; race and rejection branches remain focused checks outside the basic-reading quick-check denominator.

As confirmed by the user on 2026-11-12, conversation-artifact PDFs also support the selection toolbar. With the toggle on, selecting real text must show Explain, Translate, Add to conversation, and Copy. Turning the toggle off hides the ordinary toolbar; turning it back on makes the toolbar usable again. Copy must match the selected text. Adding to the conversation preserves the complete selection and does not send it automatically. Explanation and translation use the original artifact identity and revision. Import into a project or literature library is not required, and this does not grant edit, annotation, or version-management permissions. No version was specified for this incremental requirement; preserve existing markers and do not expand the basic-reading quick-check denominator.

Per the user's supplementary screenshot on 2026-11-12, keep the PDF selection toolbar and expanded explanation, translation, and comment bubbles inside the current literature-reading viewport, at least 20px from its top, bottom, left, and right edges. Preserve this constraint when scrolling moves the selection offscreen, when dragging or resizing a bubble, when toggling the sidebar, and when changing the reading-area size. If space is insufficient, constrain bubble size and scroll its content internally; do not cover the literature header, navigation, or other panels.

Per the user's supplementary screenshot on 2026-11-12, PDF selection toolbars and expanded explanation, translation, and comment bubbles remain within the current document-reading viewport, at least 20px from each edge. Preserve this boundary when the selection scrolls out of view, the bubble moves or resizes, the sidebar toggles, or the reader changes size. Constrain oversized bubbles and scroll their content internally instead of covering the document header, navigation, or other panels.

Per the user's screenshot and explicit wording request on 2026-11-11, the shrink button tooltip on the expanded result panel reads “缩小” (“Shrink”), not “还原 PDF 面板” (“Restore PDF panel”). The action still restores the result to a compact overlay and preserves its content and existing actions.

Per the user screenshot and explicit wording request on 2026-11-11, the expanded result panel's shrink tooltip reads “缩小” / “Shrink”, not “Restore PDF panel”. The action still restores the compact overlay and preserves content and existing controls.

Per the user's screenshot and explicit wording request on 2026-11-11, the explanation entry in the selection and annotation toolbars reads “AI解释” (“AI explanation”). The submit button below remains “解释一下” (“Explain this”); its active state and action remain unchanged.

Per the user screenshot and explicit wording request on 2026-11-11, selection and annotation toolbars label the explanation action “AI解释” in Chinese and “AI explanation” in English. The submit button remains “解释一下” / “Explain this”; active states and actions are unchanged.

Per the user's screenshot confirmed on 2026-11-11, the “解释一下” (“Explain this”) submit button displays text only, without a leading decorative icon. The same rule applies to selection and annotation explanations; the prompt-settings icon, disabled state, and submission behavior remain unchanged.

Per the user screenshot confirmed on 2026-11-11, the “Explain this” submit button is text-only in both selection and annotation explanations. The prompt-settings icon, disabled state, and submission behavior remain unchanged.

Per the user's screenshot confirmed on 2026-11-11, the “配置已变更” (“Configuration changed”) notice uses regular 400 font weight and text-placeholder color, without inheriting toolbar bolding. Preserve the previous translation and explicit refresh behavior. This supplemental visual constraint does not change existing requirement versions or the basic-reading quick-check denominator.

Per the user screenshot confirmed on 2026-11-11, the configuration-change notice uses regular 400 weight and text-placeholder color, without inheriting toolbar emphasis. Existing translations and explicit refresh behavior remain unchanged. This supplemental visual constraint preserves existing requirement versions and the basic-reading quick-check scope.

As confirmed by the user on 2026-11-10, the top Copy and Comment buttons form a right-aligned action group. They remain right-aligned when the overlay widens rather than staying on the left after the preceding text buttons.

As confirmed by the user on 2026-11-10, PDF selections are not cleared by window blur, resizing, or clicking another task; clicking blank space in the current document still clears the selection and closes the overlay. Under the Bug 88838778 repair requirement from 2026-11-12, hide the ordinary selection toolbar when its reading source is hidden or inactive so it no longer obscures the conversation. This does not mean discarding the selection, unfinished comment, or a result explicitly pinned by the user. If the reading area remains visible and only the selection anchor scrolls offscreen, retain the overlay within the reading-area bounds. Once reading is restored, selection is available again and existing comment drafts remain. Do not reuse stale results after the literature document closes or its revision identity becomes invalid.

PDF selections survive window blur, layout resizing, and task switching. Clicking blank space in the current document still clears the selection. Bug 88838778 requires ordinary selection tools to hide when the reader is hidden or inactive, without discarding selections, unfinished comments, or explicitly pinned results. When only the selection anchor scrolls offscreen, retain the surface within the visible reader's bounds. Restoring the reader permits selection again and retains comment drafts. Closed documents and invalid source revisions must not reuse stale results.

As confirmed by the user on 2026-11-10, the selection-translation enlarge button is at the far right of the action group and aligns with the right edge of the Comment button above it. Its hover tooltip reads “放大” (“Enlarge”). The scroll-area shell has no rounded corners, preventing the scrollbar from being clipped; the overall overlay retains its rounded corners.

The corresponding button remains active while Explanation, Translation, or Comment is expanded; one-shot annotation, Copy, and Add to conversation actions do not remain active. The light-theme active background is rgba(103,73,15,0.08). Per the incremental requirement confirmed by the user on 2026-11-10, text buttons in selection and annotation overlay toolbars use text-primary for text and icon-outline-default for icons. Icon-only buttons use icon-outline-default by default and switch to text-primary while active. Translation controls must fit on one complete line.

Selection-translation body text is 14px, and the default content area expands to at most ten lines. The overlay's default space must fit ten lines; after the user adjusts overlay height, content uses the actually available height. When content exceeds that height, support wheel scrolling and make the top/bottom gradients respond to the scroll position; do not merely clip the body text. Translation and selection explanation show no top-level in-progress entry or in-content generating, waiting, or cancel controls; retain genuine error messages.

This supplement involves actual annotations and model calls, so the corresponding data and operational authorization are required separately. It is not automatically added to the original basic-reading quick-check denominator.

<a id="ai-解读转对话补充约束"></a>
### Supplemental Constraints for AI Reading-to-Conversation Handoff

Per the user's screenshots and confirmation on 2026-11-12, replace the original top icon entry point with a bottom-right primary button labelled “继续与书深讨论” (“Continue discussing with ScholarSeed”) and a chat-bubble icon; keep it reachable while the body scrolls. Keep the entry visible but disabled before generation, during loading or generation, and when only a partial preview or fallback result exists. Enable it when a complete reading is available. Disable it again during regeneration; if cancellation restores the last complete reading, discussion can continue. Preserve existing handoff-pending, duplicate-prevention, and failure-recovery semantics; do not send messages automatically.

Per the user's screenshots and confirmation on 2026-11-12, replace the top icon action with a bottom-right primary “Continue discussing with ScholarSeed” button and a chat-bubble icon. It remains accessible outside the scrolling reading content, visible but disabled before generation, during loading/generation, and for partial previews or fallback results. Enable it only for an available complete reading; disable it again during regeneration and re-enable it when cancellation restores a complete saved reading. Preserve pending, duplicate-prevention, failure recovery, and no-auto-send behavior.

As confirmed by the user on 2026-11-10, “与书深对话” (“Discuss with ScholarSeed”) in PDF and literature details shows a handoff-pending state and prevents duplicate triggers. After literature context is accepted and the target conversation, project, and draft identities still match, show an available conversation input, preserve the existing draft, and append the reading summary. Restore hidden or minimized project conversations as a visible split pane; do not send a message automatically. Only after success, close the PDF reading panel and show a pending-send notice. On failure, preserve the reading, clear the pending state, and show a retryable error. When an empty input is first opened with literature context already present, do not reinitialize the draft identity.

This is an interaction supplement for this round; no separate requirement version is specified. Do not change existing stable IDs, version markers, or the basic-reading quick-check denominator. Regress handoff of an existing reading, existing drafts, first opening with an empty draft, task switching, context rejection, and request errors. Re-generating a reading with a model is not required.

<a id="ai-解读诊断入口补充约束"></a>
### Supplemental Constraints for AI Reading Diagnostics Entry Points

Per the restoration confirmed by the user on 2026-11-11 (Bug 88834603), PDF and literature-detail readings hide the entire “生成详情” (“Generation details”) entry and its internal “技术明细” (“Technical details”). Merely collapsing the content by default while keeping the entry is insufficient. Apply the same rule to saved results with or without diagnostic metadata. Reading content, citations, and existing actions such as regeneration and discussion with ScholarSeed remain unaffected. Preserve backend usage records, first-token timing reports, and saved metadata.

No separate requirement version is specified. This is a confirmed regression supplement and does not change existing stable IDs, requirement-version markers, or the basic-reading quick-check denominator. Existing readings are sufficient for verification; no new model call is required.

Per the user-confirmed restoration on 2026-11-11 (Bug 88834603), PDF and literature readings hide the entire generation-details entry and its technical diagnostics, both with and without saved metadata. Merely collapsing the content is insufficient. Reading content, citations, regeneration, chat handoff, usage recording, first-token reporting, and saved metadata remain unchanged. No separate requirement version is assigned; existing IDs, version markers, and the basic-reading quick-check scope remain unchanged. Verification can use saved readings without a new model request.

2026-11-12 reopening confirmation: The requirements above also apply to newly completed results, regardless of whether generation details and technical details are changed into sibling sections. Neither entry may appear in the keyboard focus order; both remain hidden when reopening a saved result. The new-generation lifecycle is a targeted regression, not an expansion of the basic-reading quick-check denominator or implicit authorization for model calls.

Reopening confirmation on 2026-11-12: The same requirement applies to newly completed readings and is independent of nested or sibling diagnostic sections. Neither entry may enter keyboard navigation, and reopening saved results must keep both hidden. The generation lifecycle is a focused regression check, not an expansion of the basic-reading quick-check scope or implicit authorization for model calls.

<a id="ai-解读失败呈现补充约束"></a>
### Supplemental Constraints for AI Reading Failure Presentation

As confirmed by the user on 2026-11-13, PDF and literature details share these behaviors: streaming previews retain the paper type and use the corresponding section heading. On failure, preserve any existing complete reading; if none exists, collapse partially generated prose by default and provide an entry to view it. Internal L1-composed assets are not shown as a formal reading; do not display “基础解读 · L1” (“Basic reading · L1”) or per-item L1 source labels. Show actionable failure reasons and a retry entry; keep backend assets, diagnostics, and first-token reporting unchanged. This is a targeted regression supplement. No separate requirement version is specified; existing stable IDs, versions, and the basic-reading quick-check denominator remain unchanged.

As confirmed by the user on 2026-11-13, PDF and library readings retain the paper type in streaming previews. Failed generation preserves an existing complete reading; otherwise partial prose is collapsed behind a view action. Internal L1 projections are not presented as completed readings or labelled as basic L1 readings. Keep actionable failure messages, retry, stored assets, diagnostics and first-text reporting. This is targeted regression coverage, with no new requirement version or change to existing IDs and quick-check scope.
