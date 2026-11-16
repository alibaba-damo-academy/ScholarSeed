<a id="pdf基础阅读需求构建依据"></a>
# Build Basis for Basic PDF Reading Requirements

<a id="前向整合与图片型合成输入pdf48"></a>
## Forward Integration and Image-Only Synthetic Input: pdf/48

This forward integration retains the target branch's basis for adding translation results to drafts and reopening diagnostics, together with this work's synthetic input from `pdf/47`. Original requirement IDs, versions, and historical decisions remain unchanged; earlier revision numbers remain as source identifiers in each record.

The [independent example manifest](../../../../../examples/projects/pdf-image-only/project.json) registers the single-page image-only PDF `image-only.pdf` (21,496 bytes; SHA-256 `a1e04eddbf1780744e154da50fb5d65066b796f1547c365a55a3705a9a263680`). Pillow 13.0.0 drew `SYNTHETIC IMAGE-ONLY PAGE`, `VISIBLE-IMAGE-NEEDLE`, and `No selectable text layer` in its default font on a white 1200×1600 RGB image. ReportLab 4.4.9 in invariant mode then placed the full image on a single 600×800 pt PDF page; no PDF text was drawn. This synthetic raw input does not prepopulate product state or results and promises neither OCR nor particular search behavior or coverage of all real scanned-file characteristics. A person must confirm imports and verify the isolation target and permissions. It is only for preparing the no-text-layer conditional supplement; it does not replace the two-page normal quick check. Requirement version, adoption status, error semantics, and historical freeze remain unchanged.

Independent parsing with pypdf and PDFium found one page and extracted no text. pypdf confirmed that the file is unencrypted and contains one image; after PDFium rendering, page-by-page inspection showed all three lines of text. The shared parser and `readExampleFile` verified the manifest and read back 21,496 bytes. These checks establish only raw-file properties, not product behavior.

<a id="查找无匹配状态参考pdf46"></a>
## No-Match Search State Reference: pdf/46

`no-match-20261113.png` is a byte-for-byte copy of `tmp/test_snapshot/desktop/pdf-no-match-observe-20261113/no-match.png`, SHA-256 `0880b8228a78a1089f27019812e0c88ceef77edf6f8e4d28e468612dd675a99a`. On 2026-11-13, an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance searched `evaluation/pdf` for `NO-MATCH-SYNTHETIC`; the UI showed no matches and disabled navigation. Search was then cleared and closed. The screenshot captures the fully rendered viewport; only part of the PDF body is visible because the side-by-side pane is narrow. The isolated file and the original in examples both have SHA-256 `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`. The independent text reference for the no-match term is in this page's historical records; it was not independently parsed in this round. The action changed the active tab and cleared the original query, and may have updated reading auxiliary state. It does not establish that all PDFs, search navigation, or a formal evaluation passed, and does not change the old criteria or freeze.

<a id="缩放与适应状态参考pdf45"></a>
## Zoom and Fit-State Reference: pdf/45

The following are original-image copies from the fully captured 1280×840 window of an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance. The original run directory is `tmp/test_snapshot/desktop/baseline-1823-pdf-scale-20261113/`. The freeze and preparation records bind the target `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` and the two-page synthetic `evaluation/pdf` input. All capture times are 2026-11-13 +0800:

| Reference copy | Original evidence and screenshot command | Time | SHA-256 |
| --- | --- | --- | --- |
| `zoom-in-20261113.png` | `driver/evidence/zoom-in.png`, `driver/index.md` item 8 | 12:36:51 | `3b37671cd0654ddc5045c9187a89c786887b99b42c1c7f61c9a32be977c6b19a` |
| `zoom-out-20261113.png` | `driver/evidence/zoom-out.png`, `driver/index.md` item 12 | 12:37:00 | `38d991ebe52a554ec3157631e108c7512d819f5a0465fc2b2ef8e180452a765c` |
| `fit-page-20261113.png` | `driver/evidence/fit-page.png`, `driver/index.md` item 18 | 12:37:17 | `709122422bc0cbc00b85d0b0ed97c1e135df3f11d863cac1eed08a4fec8fcc32` |

`driver/evidence/fit-width.png` is screenshot item 22, captured at 12:37:27, and is byte-for-byte identical to the original `fit-page.png`; therefore only one reference copy is retained. The two modes were constrained by the same available width in this layout, so this still image cannot distinguish them. Each image was opened and inspected: ordinary zoom-in clips part of the document body, while fit mode shows the entire page. The right side contains a narrow split-pane synthetic document, with no visible credentials. Still images alone do not prove the zoom action, mode, or geometric relationship. The independent Judge's conclusion applies only to the frozen normal subpoints for the two-page sample; it does not extend to limits, other layouts, errors, or repairs of historical defects in older builds. Requirement version, criteria, and historical freeze remain unchanged.

<a id="两页缩略图状态参考pdf44"></a>
## Two-Page Thumbnail-State Reference: pdf/44

The two reference images are original-image copies from the fully captured 1280×840 window of an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance. The original run directory is `tmp/test_snapshot/desktop/baseline-1823-pdf-thumbnails-20261113/`. The freeze and preparation records bind the target `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` and the two-page synthetic `evaluation/pdf` input. All capture times are 2026-11-13 +0800:

| Reference copy | Original evidence and screenshot command | Time | SHA-256 |
| --- | --- | --- | --- |
| `thumbnail-page1-20261113.png` | `driver/evidence/page1.png`, `driver/index.md` item 9 | 12:30:31 | `2fba176c22be686d32841fad76d63d506fe7e1f36e6db1cba0094b2ec13da710` |
| `thumbnail-page2-20261113.png` | `driver/evidence/page2.png`, `driver/index.md` item 12 | 12:30:34 | `37f264bfa47d43677c1f015ce38380b6cf39d5bda765b1a38b337dee93010a34` |

Each image was opened and inspected: both show the two thumbnails and corresponding document-body state; the right side is a narrow split-pane synthetic document, with no visible credentials. Still images alone do not prove a click or navigation. The independent Judge's decision on the selected normal subpoints of `PDF-OBS-006` for that round is in the run report; it does not extend to long thumbnail lists, the ten-page sample, errors, or the complete PDF feature set. Requirement version, adoption status, criteria, and historical freeze remain unchanged.

<a id="目录与查找状态参考图pdf43"></a>
## Outline and Search-State Reference Images: pdf/43

The following are original-image copies of the fully captured 1280×840 window from an isolated macOS arm64 `0.3.2 / 202611121823 / preview` instance. The original run directory is `tmp/test_snapshot/desktop/baseline-1823-pdf-outline-20261113/`. The freeze and preparation records bind the target `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` and the two-page synthetic `evaluation/pdf` input. All times are 2026-11-13 +0800:

| Reference copy | Original evidence and screenshot command | Time | SHA-256 |
| --- | --- | --- | --- |
| `outline-detail-20261113.png` | `supplement/evidence/outline-detail.png`, `supplement/index.md` item 21 | 12:13:21 | `9bb780ab3d50b21b6eda96e46cac42ca09b685679bf785fcf352761be0a6ac41` |
| `outline-overview-20261113.png` | `supplement/evidence/outline-overview.png`, `supplement/index.md` item 24 | 12:13:24 | `deb89631be63a02fd2d350b04f742d66fa902b3a20d261290fe1afb80b5cc379` |
| `find-third-20261113.png` | `geometry/evidence/third.png`, `geometry/index.md` item 6 | 12:19:31 | `3c76f515262ba99ea025ecfebea3a5a23a6145d90e603e47bcb2542addfd739b` |
| `find-second-20261113.png` | `geometry/evidence/second.png`, `geometry/index.md` item 10 | 12:19:43 | `a7c7b280aa1e335f5985f3cdf2b11f40d24a11d93510aad53c19ec348f148da8` |

Each image was opened and inspected. The first two show outline selection and the corresponding page; the last two show different search-result states. The right side contains a synthetic document in a narrow split pane, with no visible credentials. Still images alone do not prove navigation or match switching. The run report contains that round's geometry and independent Judge conclusions for the selected two-page subpoints; these do not extend to the ten-page sample, the complete PDF feature set, or error cases. The first-round and first-supplement evidence-gap decisions, requirement version, criteria, and historical freeze are retained; this change adds only reference images.

<a id="多页合成输入pdf42"></a>
## Multipage Synthetic Input: pdf/42

The [independent example manifest](../../../../../examples/projects/pdf-multipage/project.json) registers a repository-generated ten-page PDF, `multipage.pdf` (6,838 bytes; SHA-256 `255322ad540ce1297af7252a4a807eb8f56c7a847e29347cc76229d4066a672d`). It was generated with ReportLab 5.0.1 in invariant mode using the built-in Helvetica font. Each page displays a synthetic page marker from `SYNTHETIC-PAGE-01` through `SYNTHETIC-PAGE-10`; only pages 8 and 9 contain `CROSS-BATCH-NEEDLE`. Independent parsing should verify all ten pages, each page marker, and the match distribution. Actual runs must also record the corresponding isolated project and file identity. The current `PdfDocument.tsx` source uses a search batch size of 8; this is only an implementation clue for sample-coverage boundaries, not a product requirement, proof that the installed package matches the source, or acceptance evidence. This file is raw input and does not prepopulate product state or results. A person must confirm imports and verify isolation and permissions. The default two-page quick check, requirement version, adoption status, and historical freeze remain unchanged.

<a id="需求与运行进度分离pdf41"></a>
## Separate Requirement Status from Run Progress: pdf/41

Remove the blanket historical “nothing tested” status from the requirement text. Use the scenario index and run records as the authority for progress and results in each round. Stable IDs, requirement versions, adopted scope, supplement boundaries, and historical freeze remain unchanged. Capture dates in reference-image captions are filled in from the existing sources below.

<a id="两页参考图补充pdf40"></a>
## Two-Page Reference Image Supplement: pdf/40

On 2026-11-12, two page states were captured from an isolated installed macOS arm64 `0.3.2 / 202611121823 / preview` instance using the synthetic `sample.pdf`; target ASAR SHA-256: `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. `page-one-20261112.png` and `page-two-20261112.png` are unchanged copies of the original images `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f1-pdf-1.png` and `f1-pdf-2.png`, with SHA-256 values `fc6c05d74bb122d04d38cb3956ece32df3dab0bdf21321e0c3e31cb8471b453c` and `96d43f2f562e37dcbe80f8dfc9d1cea6d067463a1b6f6d5897d4ee84cfa1110b`, respectively. The original run directory is ignored evidence and can be checked only on this machine. The reference images alone do not prove page navigation or any other supplement. This revision does not change requirement versions, criteria, or historical results.

<a id="共享输入去重pdf39"></a>
## Deduplicate Shared Input: pdf/39

The synthetic input formerly in this page's directory was moved to the byte-identical shared `examples/projects/evaluation/files/`. Its old path and contents can be checked at historical commit `854dfa6c81`. This only reorganizes the input reference; requirement versions, criteria, and freeze records are unchanged.

<a id="f1-普通阅读路径沿用依据pdf38"></a>
## Basis for Retaining the F1 Normal-Reading Path: pdf/38

For macOS arm64 `0.3.2 / 202611121823 / preview`, retain the adopted subpoints of PDF-OBS-001 and 002 from the 2026-10-30 user-wide adoption rule and this page's existing normal-reading quick check: open a known two-page PDF and compare its body and page count; after ordinary page navigation, both page number and body content change. The confirmed citation-navigation change in this page's `pdf/32` explicitly preserves ordinary page-navigation semantics and the basic quick-check denominator. Review of this page's existing adoption and subsequent revisions found no record confirming that this sub-scope was retired or changed. This is a bounded record review; it does not claim a complete history of requirement changes or source-to-artifact identity. It does not verify other requirements such as citation navigation, zoom, selection, or errors. Original IDs, v`0.3`, criteria, and old runs remain unchanged. A new run must still verify the target identity and independent PDF original; an independent reviewer judges the evidence, and this record does not deem the product to have passed. The target-applicability check mentioned below under `pdf/37` referred to the state before this bounded retention analysis had been completed.

<a id="共享示例输入对齐pdf37"></a>
## Align with the Shared Example Input: pdf/37

This revision only points the current basic-reading quick check's two-page PDF input to `examples/projects/evaluation/files/sample.pdf`, preserving existing stable IDs, requirement versions, criteria, and historical results. On 2026-11-12, the file and this scenario's old copy were verified to have the same SHA-256: `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`. The old path `exploratory/pdf/sample.pdf` can be checked at source commit `854dfa6c81`; the build records below preserve historical traceability. For each round, verify input identity and product path against the shared project manifest `evaluation/pdf` and the preparation receipt. Preparation does not prove import functionality; target-package applicability still requires independent verification. This revision does not mean the product has passed.
<a id="2026-11-13-翻译结果加入草稿恢复"></a>
## 2026-11-13 Restore Adding Translation Results to Drafts

The final integration baseline is Preview `87eab33f0`; Reading's original blob matches the initial baseline. Changes synchronized in the interim concern runtime coordination and visibility of new-task references. Retain this section's supplemental scope; do not attribute those target-branch changes to this Bug fix. / Final integration uses Preview `87eab33f0`; its original Reading blob matches the starting baseline. Intervening target changes concern runtime coordination and new-task reference visibility, not this repair's diff or scope.

Asset revision: `pdf/38`. Following the user's explicit Bug 88916076 requirement, compare Preview `817b2710c` with this task's diff. PDF-OBS-009 distinguishes the semantics of the result footer from the top entry for source text, while preserving stable IDs, versions, and the basic-reading quick-check denominator. The change directly affects shared Reading translation and explanation result actions and is related to AssistantIngress draft preparation and literature context. Translation backends, language detection, full-document translation, and auto-send rules remain unchanged. Regress ready, generating, and empty states, bilingual draft bytes, and the top toolbar's source-text snapshot. Record real-model/Electron acceptance separately; do not infer it from deterministic checks.

Asset revision: `pdf/38`. The user's explicit Bug 88916076 requirement covers Preview `817b2710c` plus this task's diff. PDF-OBS-009 distinguishes the result footer from the original-text toolbar action while preserving its ID, version and basic-reading quick-check scope. Translation and explanation result actions share Reading; draft preparation and literature context use AssistantIngress. Translation providers, language detection, full-document translation and sending rules stay unchanged. Focused regression covers ready, generating and empty states, bilingual draft bytes and the toolbar's original snapshot. Real-model/Electron acceptance is recorded separately, not inferred from deterministic checks.

<a id="2026-11-12-ai-解读诊断重开修复依据"></a>
## 2026-11-12 Basis for Reopening the AI Reading Diagnostics Fix

Asset revision: `pdf/37`. Based on the reopening feedback for Bug 88834603 and the user's current screenshot, analyze Preview `02f275b55` plus this round's fix diff. `b4dd06466` removed the hidden boundary when diagnostics were changed into sibling sections; this round makes visibility of the entire group the responsibility of shared Summary without changing backend metrics, persistence, or citations. PDF and literature-detail AI readings are directly affected. Preserve the original hidden-entry requirement, stable IDs, requirement versions, and quick-check denominator; add focused coverage for newly completed results, reopening, and keyboard inaccessibility. A standalone Generation data-display test does not mean diagnostics should be public in the user-facing page. Record execution results separately; old screenshots are not evidence of passage in this round.

Asset revision: `pdf/37`. Based on Bug 88834603 reopening and the user's current screenshot, analyze Preview `02f275b55` plus this repair diff. `b4dd06466` removed the hidden boundary while splitting diagnostics into sibling sections. Shared Summary now owns visibility of the entire group without changing metrics, persistence or citations. PDF and literature-detail readings are directly affected. Preserve the hidden-entry requirement, stable IDs, requirement versions and quick-check scope; add focused coverage for newly completed results, reopening and keyboard exclusion. Standalone Generation data tests do not authorize diagnostic visibility in user-facing readings. Execution evidence is recorded separately; old screenshots do not prove this revision.

<a id="2026-11-12-划词翻译重开修复依据"></a>
## 2026-11-12 Basis for Reopening the Selection-Translation Fix

Asset revision: `pdf/36`, incremented after Preview integration of `pdf/35`. Under the user-approved Bug 88834262 plan and implementation authorization, analyze `7f5d81fd5` plus repair commit `4f9ae9064`, integrated into Preview `365653927`. PDF-OBS-009 retains its ID, requirement version, and quick-check denominator, and adds binding to source selection/revision/target/request, identification of the actual language of retained translations, source-text coverage, rejection of clear Chinese/English contradictions, and one bounded correction. Literature PDFs are directly affected; project and conversation-artifact PDFs share Reading and reuse their corresponding source-authorization and revision contracts. The new TranslationControls parameter is optional and enabled only for this host; prompt settings and defaults for other translation entry points are unchanged. Concurrent selection changes, rejection branches, correction counts, and source authorization revocation are focused checks. Deterministic regressions do not replace real-model or Electron evidence; record run results separately.

Asset revision: `pdf/36`, following Preview's `pdf/35`. The user-approved Bug 88834262 plan and implementation authority cover `7f5d81fd5` plus repair commit `4f9ae9064`, integrated with Preview `365653927`. Keep PDF-OBS-009's ID, requirement version, and quick-check denominator. Add selection/revision/target/attempt binding, actual-language identification for retained results, source coverage, clear Chinese/English contradiction rejection, and one bounded correction. Literature PDFs are directly affected; project and conversation-artifact PDFs share Reading and their existing source authorization/revision contracts. The optional TranslationControls parameter is enabled only by this host; prompt settings and other translation defaults remain unchanged. Selection replacement, rejection, correction limits, and access revocation are focused checks. Deterministic regressions do not replace real-model and Electron evidence; execution results are recorded separately.

<a id="2026-11-12-持续标注按钮-esc-复验补充"></a>
## 2026-11-12 Continuous-Annotation Button Escape Recheck Supplement

Asset revision: `pdf/35`. The Bug 88837628 Reopen recheck and real macOS Desktop both exposed a problem: the continuous-annotation button's tooltip consumed Esc during capture, so the PDF exit listener was skipped. Shared Tooltip adds a `consumeEscape` policy that preserves its existing behavior by default; only the continuous-annotation buttons opt out. Preserve protections for PDF inputs, overlays, and events that have already consumed Esc. Add regressions for hover, keyboard focus, no automatic save after subsequent selection, and retention of existing annotations, without changing the requirement version or basic-reading quick-check denominator. Windows and release artifacts were not rechecked; this record is not proof of acceptance.

Asset revision: `pdf/35`. Bug 88837628's Reopen report and real macOS Desktop reproduction identify a tooltip consuming Escape during capture before PDF cancellation. Tooltip gains an opt-out `consumeEscape` policy with unchanged defaults; only continuous annotation buttons opt out. Preserve PDF editable, overlay and consumed-event boundaries. Add hover, keyboard-focus, subsequent-selection and saved-mark regressions without changing requirement versions or basic-reading scope. Windows and release artifacts remain unverified; this record is not acceptance evidence.

<a id="2026-11-12-preview-合并语义对齐"></a>
## 2026-11-12 Align Semantics for Preview Integration

Asset revision: `pdf/34`. When integrating `c3ffd541a` into the repair branch for three defects, preserve both sides' historical records. The repair branch's original `pdf/21` and `pdf/22` and same-numbered Preview records are parallel histories; do not reassess old runs. The current integration semantics distinguish a hidden reading viewport from an offscreen selection anchor: hide the ordinary toolbar when the reading source is hidden or inactive; while the reading area remains visible, an offscreen selection remains actionable, with the overlay constrained by the reading-area bounds in `pdf/30`. Preserve Escape behavior, comment drafts, pinned results, notes width/expansion, window resizing, and source-revision protection. Add combined regressions without expanding the quick-check denominator; record evidence from the actual integrated build separately.

Asset revision: `pdf/34`. Integration of `c3ffd541a` preserves both branches' historical records; the repair branch's original `pdf/21` and `pdf/22` overlap Preview numbering and do not reinterpret earlier runs. Distinguish a hidden or inactive reader from an offscreen selection anchor: ordinary tools hide with their reader, while offscreen selections remain usable within the visible reader's `pdf/30` bounds. Preserve Escape, drafts, pinned results, notes resizing/expansion, window resizing, and revision checks. Add combined regressions without expanding the quick-check scope; runtime evidence is recorded separately.

<a id="2026-11-12-阅读来源隐藏回归依据"></a>
## Basis for Regression When the Reading Source Is Hidden: 2026-11-12

Asset revision: `pdf/22`. At the user's request, fix Bug 88838778 on the same branch by supplementing the `pdf/21` diff with the selection host and PDF viewport lifecycle. PDF-OBS-009 distinguishes “retain selection/draft/pinned result” from “show ordinary toolbar”: hide the ordinary toolbar when its source is hidden or its anchor is invisible, and restore its actions when visible again; retaining state must not mean continuing to obscure other pages. This supplement supersedes the `pdf/16` requirement that ordinary toolbars bypass visibility checks. Preserve historical records and requirement versions; do not expand the basic-reading quick-check denominator. Regress collapse/expand, scrolling, task and literature switching, unfinished comments, pinned results, Escape, and notes layout; non-PDF lifecycles remain unchanged. The original Windows screenshot and recording report do not capture the complete collapse sequence; report actual execution and platform gaps separately.

Asset revision: `pdf/22`, for Bug 88838778 on the existing branch. PDF-OBS-009 separates retained selections, comment drafts, and pinned results from ordinary toolbar visibility. Hide ordinary tools while their source or anchor is invisible and restore usable actions when visible again. This supersedes the ordinary-toolbar visibility exemption recorded in `pdf/16`, without changing historical records, requirement versions, or the basic-reading quick-check scope. Regress collapse/restore, scrolling, task/document switching, drafts, pinned results, Escape, and notes layout; non-PDF lifecycle rules remain unchanged. Original Windows evidence lacks the complete collapse sequence; execution evidence and platform gaps are recorded separately.

<a id="2026-11-12-标注退出与笔记布局回归依据"></a>
## Regression Basis for Annotation Exit and Notes Layout: 2026-11-12

Real acceptance investigation found an additional navigation issue: after notes fill the area, the PDF container's content width is zero, but padding leaves `clientWidth` at 32. Recalculating from that width triggers minimum zoom and changes pages on restore. Geometry observation now uses the ResizeObserver content box to determine readability and retains the last size while collapsed. Add regressions for a hidden content box and restored page number and zoom; do not rely on a fixed padding value. This is a source-level causal record; runtime evidence is stored separately.

Runtime investigation found that a collapsed PDF retained padding in `clientWidth` despite a zero-width content box, triggering minimum zoom and a page jump on restore. Geometry observation now retains the last readable size when the ResizeObserver content box is empty. Regression coverage includes collapsed geometry and restored page/zoom without binding the fix to a padding value. Runtime evidence remains separate.

Asset revision: `pdf/21`. The user explicitly requested fixes for Bugs 88837628 and 88838604 on the latest 0.3.2 branch; the source scope is `c5e91057d2a9` plus the current uncommitted changes. The PDF Owner completes Escape cleanup for temporary selections and reuses the existing Resizable split pane for the notes contribution that is explicitly declared resizable; storage and bridge protocols are unchanged. PDF-OBS-003, 008, and 009 retain their original requirements and gain supplemental checks for exit behavior and notes sizing. Related regressions cover input/overlay priority, preservation of saved annotations, notes drafts and editor mounting, AI reading, and the information panel. The literature-notes supplement has no independent baseline yet, so it is recorded at its actual PDF host rather than creating a parallel placeholder asset. Real runtime evidence and environment gaps are recorded separately; this section does not prove the product passed.

Asset revision: `pdf/21`, based on the user's request to fix Bugs 88837628 and 88838604 against `c5e91057d2a9` plus the current changes. Existing IDs and requirement versions remain intact. Regress PDF selection dismissal, input and overlay precedence, saved annotations, notes resizing and draft continuity, interpretation, and fixed information panels. Notes checks are recorded at the actual PDF host because a separate notes baseline does not yet exist. This source-impact record is not product acceptance evidence.

<a id="2026-11-12-会话产物划词增量依据"></a>
## Basis for Conversation-Artifact Selection Supplement: 2026-11-12

Asset revision: `pdf/33`. Following the user's explicit repair request for defect 88838444, add conversation-artifact sources to PDF-OBS-009 while retaining existing toolbar and permission boundaries. Do not change historical run results or infer a new product requirement version. The analysis baseline is `3a52b0f8f` plus this uncommitted diff. Affected areas include Artifact projection, source resolution for PDF explanation/translation, the Workbench selection host, and Assistant frozen snapshots. Direct regressions cover cross-line selection in artifact PDFs, the toggle, copying, adding context, and actual explanation/translation. Related regressions cover literature and project sources and reject unauthorized access, invalid directory members, and stale revisions. Basic reading and annotation expectations remain unchanged; this record is not a product acceptance conclusion.

<a id="2026-11-12-pdf-引用先跳页再定位"></a>
## PDF Citation Navigation Jumps to Page Before Positioning: 2026-11-12

Asset revision: `pdf/32`. For Bug 88839255, the user confirmed “jump to the page first, then scroll within it.” The source basis is `7f361d7aa6b75c0032171d0e8616e1c677a47094` plus this change to `pdf/Page.tsx`. Retain existing citation geometry, highlights, and evidence switching; do not change PDF-OBS-002's stable ID, ordinary page-navigation semantics, or basic quick-check denominator. The focused supplement covers distant pages, repeated switching, citations without coordinates, and reduced motion.

Asset revision: `pdf/32`. For Bug 88839255, the user confirmed jumping to the target page before scrolling within it. The source basis is `7f361d7aa6b75c0032171d0e8616e1c677a47094` plus the change to `pdf/Page.tsx`. Citation geometry, highlights, and evidence switching remain in place; PDF-OBS-002 keeps its stable ID, ordinary page navigation, and basic-reading scope. The targeted regression covers distant pages, repeated switching, page-only citations, and reduced motion.

<a id="2026-11-12-ai-解读讨论入口迁移依据"></a>
## Basis for Moving the AI Reading Discussion Entry: 2026-11-12

Asset revision: `pdf/31`. Based on the user's two screenshots and requirement that the action activate only after generation completes, the source scope is `c32ff9893` plus this change to shared `components/business/Reading` and bilingual resources; other uncommitted changes are retained. The PDF sidebar and literature detail reuse the same component. Move the entry from a top IconButton to a bottom Button outside the body scroll area. Determine completion using existing task, preview, and saved-summary state; do not change generation, background extraction, persistence, context acceptance, or draft handoff. No separate requirement version was specified; update the existing conversation-handoff supplement without changing stable IDs, versions, or the basic-reading quick-check denominator. Regress empty, submitting, streaming-preview, published, reading-complete-but-background-extraction-incomplete, fallback, cancellation restoration, duplicate handoff, failure recovery, keyboard, long-content, and bilingual light/dark narrow-pane states. Independently accept the real product entry and states; this record is not evidence of a passing run.

Asset revision: `pdf/31`. The user's two screenshots require moving the discussion entry and enabling it only after generation finishes. Source scope is `c32ff9893` plus this shared Reading component and bilingual-resource change; unrelated local changes remain intact. The PDF sidebar and literature detail share the component. A bottom Button outside the reading scroll area replaces the top IconButton; availability follows existing task, preview, and saved-summary state. Generation, background extraction, persistence, context acceptance, and draft handoff remain unchanged. No separate requirement version is assigned; update the existing supplemental handoff constraint without changing stable IDs, versions, or the basic-reading scope. Regress empty/submitting/streaming/published states, completed readings with background extraction still active, fallback results, cancellation restoration, duplicate/failing handoffs, keyboard access, long content, and bilingual light/dark narrow panes. Real product flows need separate acceptance evidence.

<a id="2026-11-12-划词浮泡阅读区限位依据"></a>
## Basis for Constraining Selection Bubbles to the Reading Area: 2026-11-12

Asset revision: `pdf/30`. The user's screenshot explicitly requires bubbles to remain within the literature-reading area, at least 20px from all four edges. Source scope is `c32ff9893` plus the retained current changes. `PdfDocument` measures the reading viewport, insets it using a design spacing token, and passes it through the existing tab-scoped SelectionPresentation to `SelectionActionHost`. Positioning, movement, resizing, and re-clamping a dragged bubble share placement geometry; document selections, generation requests, content, and persistence are unchanged. PDF-OBS-009 gains this user-confirmed boundary constraint, preserving stable IDs and requirement versions without expanding the basic quick-check denominator. Regress selections scrolling past the top/bottom boundaries, movement and resizing in all four directions, narrow panes, sidebar toggling, internal scrolling, and existing non-PDF positioning. Verify normal PDF interactions in a real instance; fixtures do not prove product acceptance.

Asset revision: `pdf/30`. The user requires floating selection surfaces to remain at least 20px inside every edge of the document-reading viewport. Source scope is `c32ff9893` plus the retained local changes. PdfDocument measures and insets its viewport using a design spacing token, then passes that boundary through the existing tab-scoped SelectionPresentation. Placement, movement, resizing, and re-clamping share geometry helpers without changing selections, requests, content, or persistence. PDF-OBS-009 gains this confirmed constraint; stable IDs, requirement versions, and the basic-reading denominator remain unchanged. Regress offscreen selections, all movement and resize directions, narrow panes, sidebar toggling, internal scrolling, and unchanged non-PDF placement. Real PDF interaction requires separate runtime evidence.

<a id="2026-11-11-颜色按钮悬停内距纠偏"></a>
## Correct Color-Button Hover Padding: 2026-11-11

Asset revision: `pdf/29`. The user's supplementary screenshot reiterates the adopted 4px padding on both sides in PDF-OBS-008; requirement version and expectations do not change. Source scope is `c32ff9893` plus the current uncommitted changes. Tailwind parsed the content-width selector for the `PdfTools` color button as an incorrect descendant relationship, letting inner icons overflow the container. Fix the existing content-width selector and ensure the top-bar square-button rule does not override the compound button's natural width. Regress by measuring the actual left edge of the swatch and right edge of the arrow, not only the inner wrapper. Cover light/dark themes, selection, top bar, and annotation menu while preserving color selection, focus, and disabled behavior. This record is not real product acceptance evidence.

Asset revision: `pdf/29`. The user screenshot reiterates the adopted 4px horizontal padding in PDF-OBS-008, without changing requirement versions or expectations. Source scope is `c32ff9893` plus the current uncommitted changes. Tailwind interprets PdfTools' content-width selector as an incorrect descendant relationship, allowing the icons to overflow their wrapper. Correct the selector and preserve the compound trigger's natural width against square toolbar-button rules. Regress the actual swatch and arrow edges in both themes and in selection, top-toolbar, and annotation contexts, retaining color selection, focus, and disabled behavior. This record is not product acceptance evidence.

<a id="2026-11-11-纯评论正文定位依据"></a>
## Basis for Locating Comment-Only Text: 2026-11-11

Supplement to the same revision: Real navigation exposed that the citation toolbar can cover bubbles at the top of a narrow reading area. Reuse the toolbar's measured height to set top padding in the reading area, preserving floating placement and document scrolling. Regress top clearance after wrapping in both Chinese and English.

Within the same revision, real navigation also exposes first-page bubbles covered by the citation toolbar in narrow readers. The reader derives initial top padding from the toolbar's measured height, retaining floating placement and page scrolling. Regress first-page clearance after wrapping in both languages.

Asset revision: `pdf/28`. The user's screenshot explicitly requires comment-only sidebar cards to locate their document bubbles. Source scope is `c32ff9893` plus this change and the retained outline-sizing changes. The comment body in `Annotations` was a passive paragraph; it now reuses `Button` to connect to the existing `onFocus` path. `PdfDocument` layout restoration now prioritizes explicit focus so auto-fit triggered by a change in comment-rail width does not steal focus back to the opening citation. Retain PDF-OBS-008 and existing versions without expanding basic quick-check scope. Regress mouse and Enter/Space activation, comments without source text, non-navigating copy/expand/edit controls, and focus priority during zoom, sidebar changes, and split-pane layouts. Verify cross-page navigation and bubble targeting separately in a real instance; this record is not proof of acceptance.

Asset revision: `pdf/28`. The user screenshot requires comment-only sidebar cards to locate their document bubbles. Source scope is `c32ff9893` plus this change and the retained outline-sizing edits. Annotations replaces passive comment paragraphs with shared Buttons calling the existing onFocus path. PdfDocument preserves explicit focus during geometry restoration so auto-fit changes caused by comment rails do not return to the opening citation. PDF-OBS-008 and existing versions remain unchanged. Regress mouse and Enter/Space activation, source-free comments, non-navigating copy/expand/edit controls, and focus precedence during resizing, sidebar changes, and split layouts. Real cross-page navigation and bubble targeting require separate evidence; this record is not execution evidence.

<a id="2026-11-11-目录行与展开按钮尺寸依据"></a>
## Basis for Outline-Row and Expand-Button Sizing: 2026-11-11

Asset revision: `pdf/27`. The user's two screenshots explicitly require 28px buttons and title backgrounds and 14px arrows at every outline depth. Source scope is `c32ff9893` plus this change. `Outline` recursively reuses the existing `Button`, `IconButton`, and `Collapsible`; the expand button switches to the sm size, and the outline-row height token reuses that size while excess vertical padding is removed to prevent 22px text lines from being clipped. PDF-OBS-004 gains this visual constraint without changing the existing requirement version or basic quick-check scope. Regress normal, hover, and pressed dimensions across three outline levels in light and dark themes, text integrity, keyboard expansion, and real page navigation. This record is not proof of execution passing.

Asset revision: `pdf/27`. The user's two screenshots require 28px controls and title backgrounds with 14px arrows at every depth. Source scope is `c32ff9893` plus this change. Outline keeps its recursive Button, IconButton, and Collapsible composition, uses the sm toggle size, aliases row height to the same control token, and removes excess vertical padding so 22px text lines remain intact. PDF-OBS-004 gains a visual constraint without changing requirement versions or the basic-reading scope. Regress three levels in both themes, hover and pressed geometry, text bounds, keyboard expansion, and real page navigation. This record is not execution evidence.

<a id="2026-11-11-引用浮动条窄分栏补充"></a>
## Citation Toolbar Supplement for Narrow Panes: 2026-11-11

Asset revision: `pdf/26`. Retain the user-confirmed floating-toolbar requirement and add constraints for the very narrow reading area beside an open navigation sidebar: buttons reuse `EllipsisText` to constrain width while preserving full tooltips and accessible names. The toolbar sits above local highlights so document highlights do not paint through it. Focused regressions cover Chinese and English text overflow, arrow hit targets, keyboard navigation, and stacking order. Verify open and closed navigation sidebars separately in a real instance. Requirement version and basic quick-check denominator remain unchanged; this record is not evidence of a passing run.

Asset revision: `pdf/26`. The confirmed floating-toolbar requirement also covers narrow reading space beside an open navigation sidebar. Buttons reuse EllipsisText to constrain labels while preserving full tooltips and accessible names. The toolbar sits above local highlights so document highlights do not paint over its controls. Regress both languages, overflow, arrow bounds, keyboard navigation, and stacking; verify open and closed sidebars separately in the real app. Requirement versions and the basic-reading scope remain unchanged; this record is not execution evidence.

<a id="2026-11-11-引用依据浮动条依据"></a>
## Basis for Floating Toolbar for Citation Evidence: 2026-11-11

Asset revision: `pdf/25`. The user supplied conflicting screenshots and a floating-toolbar reference, explicitly moving previous/next evidence navigation for conversation literature citations from the PDF header into the reading area. Source scope is `f880f7b00` plus this uncommitted diff. `PdfDocument` retains citation revision checks, region expansion, ordering, and `requestFocus`; only the existing buttons move into a `FloatingToolbar` outside the scrolling viewport. It reuses the theme, border, radius, and shadow and follows navigation-sidebar width. Affected consumers include project resources, literature PDFs, and split-pane reading. Add a PDF-OBS-002 supplement without changing existing versions or the basic quick-check denominator. Regress first/last boundaries, multiple regions on one page, cross-page regions, body scrolling, narrow panes, both languages, and themes. Capture separate evidence for opening, navigation, and unobstructed controls with real conversation citations; this record is not proof of a passing run.

Asset revision: `pdf/25`. The user supplies the conflicting header and desired floating-strip screenshots. Source scope is `f880f7b00` plus this uncommitted change. PdfDocument retains revision checks, region ordering, and requestFocus while moving the existing actions into a FloatingToolbar outside the scrolling viewport, respecting navigation-sidebar width. Project and literature PDFs and split reading share the change. PDF-OBS-002 receives a supplemental citation check without changing existing requirement versions or the basic-reading denominator. Regress boundaries, same-page and cross-page regions, scrolling, narrow panes, both languages, and themes. Real conversation navigation and unobstructed controls require separate evidence; this record is not execution evidence.

<a id="2026-11-11-缩小按钮提示文案依据"></a>
## Basis for Shrink-Button Tooltip Wording: 2026-11-11

Asset revision: `pdf/24`. Based on the user's screenshot and explicit tooltip request, this incremental change on `f880f7b00` updates `pdf:reading.shrinkPanel` to “缩小” / “Shrink” and regenerates types, while retaining earlier uncommitted changes. The resource is used by the selection-result resize button and the expanded-state button in shared PdfPanel; only the resource changes, not state or layout. Retain PDF-OBS-009 and existing requirement versions without expanding the basic quick-check denominator. Regress language switching, the hover tooltip on an actually expanded result, and restoration of the compact overlay. This record does not indicate execution passed.

Asset revision: `pdf/24`. The user requests the tooltip “缩小”. This incremental change on `f880f7b00` updates `pdf:reading.shrinkPanel` to “缩小” / “Shrink” and regenerates types, retaining earlier uncommitted changes. Selection-result size controls and expanded PdfPanel controls share this resource; state and layout remain unchanged. Existing IDs, requirement versions, and the basic-reading quick-check scope remain unchanged. Regress language switching, the real expanded-result tooltip, and restoring the compact overlay; this record is not execution evidence.

<a id="2026-11-11-ai解释入口文案依据"></a>
## Basis for AI-Explanation Entry Wording: 2026-11-11

Asset revision: `pdf/23`. Based on the user's screenshot and request to change the wording to “AI解释”, this incremental change on `f880f7b00` updates the Chinese and English resources for `selectionExplain` and `pdfAnnotation.explain` in the PDF namespace and regenerates types, retaining earlier uncommitted changes. Consumers are the selection toolbar, reading explanation entry, and annotation toolbar; the submit button is unchanged. Retain PDF-OBS-009 and existing requirement versions without expanding the basic quick-check denominator. Regress language round trips, annotation rendering, and the real selection entry. This record is not evidence of execution passing.

Asset revision: `pdf/23`. The user requests “AI解释” for the toolbar action. This incremental change on `f880f7b00` updates the Chinese and English `pdf:selectionExplain` and `pdf:pdfAnnotation.explain` resources and generated types, retaining earlier uncommitted changes. Selection, reading, and annotation toolbars consume these labels; the submit button is unchanged. Existing IDs, versions, and the basic-reading quick-check scope remain unchanged. Regress language round trips, annotation rendering, and the real selection entry; this record is not execution evidence.

<a id="2026-11-11-解释提交按钮去图标依据"></a>
## Basis for Removing the Icon from the Explanation Submit Button: 2026-11-11

Asset revision: `pdf/22`. The user's screenshot explicitly removes the leading icon from the “解释一下” (“Explain this”) button. This incremental change on `f880f7b00` updates only shared `pdf/Explanation.tsx` and its adjacent rendering regression, retaining the earlier translation-notice style change. It affects PDF selection and annotation explanations. Retain PDF-OBS-009 and existing requirement versions without expanding the basic quick-check denominator. Regress the button text, absence of a decorative icon, editor, and existing interactions. This record does not establish real product acceptance.

Asset revision: `pdf/22`. The user screenshot explicitly removes the leading icon from “Explain this”. This incremental change on `f880f7b00` updates shared `pdf/Explanation.tsx` and its render regression, retaining the earlier translation-notice changes. It affects selection and annotation explanations while preserving PDF-OBS-009, existing requirement versions, and the basic-reading quick-check scope. Regress the text-only button, editor, and existing interactions; this record is not product acceptance evidence.

<a id="2026-11-11-翻译配置变更提示样式依据"></a>
## Basis for Translation-Configuration Notice Styling: 2026-11-11

Asset revision: `pdf/21`. The user's screenshot and explicit “regular weight, text-placeholder” requirement add a notice-style constraint to PDF-OBS-009. Source scope is this uncommitted change on `f880f7b00`, owned by `features/translation/Controls.tsx`; affected consumers are PDF selection translation and resource selection translation. Regress light/dark themes, 400 font weight under a bold parent, semantic color, retention of the old translation, and explicit refresh. No separate requirement version was specified; preserve existing IDs, versions, and historical results without expanding the basic quick-check denominator. This record does not establish real product acceptance.

Asset revision: `pdf/21`. The user screenshot and explicit regular-weight/text-placeholder request supplement PDF-OBS-009. Source scope is `f880f7b00` plus this uncommitted change in `features/translation/Controls.tsx`, shared by PDF and resource selection translation. Regress both themes, regular 400 weight under emphasized ancestors, semantic color, retained results, and explicit refresh. No separate requirement version is assigned; existing IDs, versions, historical results, and the basic-reading quick-check scope remain unchanged. This record is not product acceptance evidence.

<a id="2026-11-11-ai-解读诊断入口回归依据"></a>
## Regression Basis for AI Reading Diagnostics Entry Points: 2026-11-11

Asset revision: `pdf/20`. The source is the user's confirmation of the fix for Bug 88834603; the analysis baseline is `d8982caef` plus this diff. Because shared Summary's group-wide hiding behavior affects both PDF and literature details, add a diagnostics-entry constraint to the existing requirements. Do not change basic-reading stable IDs, requirement versions, or the quick-check denominator. Regress saved readings with and without diagnostic metadata, content, citations, and existing actions; backend usage, first-token timing reports, and persistence remain unchanged. This record is not evidence of a passing run; report actual acceptance and environment gaps separately.

Asset revision: `pdf/20`. The user confirmed restoring hidden reading diagnostics for
Bug 88834603. Source scope is `d8982caef` plus this change. The shared Summary affects
both PDF and literature details. The supplemental constraint preserves existing IDs,
requirement versions, and the basic-reading quick-check scope. Regress saved readings
with and without metadata, content, citations, and existing actions; usage recording,
first-token reporting, and persistence remain unchanged. This is not execution evidence.

<a id="2026-11-10-正文评论工具条增量依据"></a>
## Basis for In-Document Comment Toolbar Increment: 2026-11-10

Asset revision: `pdf/19`. Per the user's screenshot, in-document comments and pinned-comment drafts in PDF-OBS-008 reuse the annotation toolbar's expanded comment area; sidebar inline editing remains unchanged. Pinned-comment drafts and persisted records reuse the same position constructor. Preserve the type boundary and disabled actions for comments without source text; do not persist a draft before saving. Deterministic regressions check positioning, toolbar, input focus, save failure, and cancellation. Verify newly created pinned comments and existing in-document comments in real Desktop. Do not expand the basic-reading denominator or change historical version conclusions.

<a id="2026-11-10-ai-解读转对话增量依据"></a>
## Basis for AI Reading-to-Conversation Increment: 2026-11-10

Asset revision: `pdf/18`. Following the user's analysis and confirmation of changes for the unresponsive “与书深对话” action, add supplemental constraints for handoff feedback, draft protection, and conversation visibility. Current source changes involve async callbacks in the Reading business component, shared-context handoff through the store, layout split-pane restoration, and draft initialization when AiPanel first opens. Existing literature context must not be treated as a new blank draft. Retain the existing requirement version; do not add this item or model-output quality to the default quick-check denominator. Record deterministic and real-product evidence separately.

<a id="2026-11-10-划词顶部操作组对齐增量依据"></a>
## Basis for Aligning the Selection Toolbar's Top Action Group: 2026-11-10

Asset revision: `pdf/17`. Per the user's screenshot, the top Copy/Comment action group in PDF-OBS-009 remains right-aligned as the overlay widens; one-row display, button behavior, and historical versions remain unchanged. Focused layout regressions cover default and expanded widths. In real Desktop, drag the overlay and verify its right-side spacing; store run evidence separately.

<a id="2026-11-10-划词浮层保留增量依据"></a>
## Basis for Retaining the Selection Overlay: 2026-11-10

Asset revision: `pdf/16`. Per the user's screenshot, PDF-OBS-009 does not clear a PDF selection on client blur, resize, or task switching. PDF consumers do not hide the toolbar when its anchor is temporarily invisible and retain the expanded state during temporary switches. Existing close policies and source-revision invalidation protection for non-PDF documents remain unchanged. Deterministic regressions cover PDF/non-PDF handling at the global close entry, invisible anchors, and existing non-PDF overlay lifecycles. Record real-window and task-switch acceptance separately; do not treat an environment block as a pass.

<a id="2026-11-10-选区翻译对齐与滚动增量依据"></a>
## Basis for Selection-Translation Alignment and Scrolling Increment: 2026-11-10

Asset revision: `pdf/15`. Per the user's screenshot, move the PDF-OBS-009 enlarge button to the far right of the control group and use the “放大” tooltip. Right-align the compact translation controls, remove rounded corners from the scroll-area shell, and retain the overall overlay radius and scroll ownership. Regress right alignment of compact controls and the actual scroll-area corner geometry without changing stable IDs or historical conclusions.

<a id="2026-11-10-导航宽度与复制图标增量依据"></a>
## Basis for Navigation Width and Copy-Icon Increment: 2026-11-10

Asset revision: `pdf/14`. Per the user's screenshot, change the PDF-OBS-008 navigation default width from 190px to 260px while preserving the existing drag range and user-saved width. The comment-copy button uses icon-outline-default. Deterministic regressions check the default and the icon's actual color; real Desktop verifies the 260px default and comment-copy icon color. Stable IDs, existing versions, and historical conclusions are unchanged.

<a id="2026-11-10-评论样式增量依据"></a>
## Basis for Comment Styling Increment: 2026-11-10

Asset revision: `pdf/13`. Per the user's screenshot, in-document comment pins and draft entry points in PDF-OBS-008/009 use the same colors as the right-side comment marker. PdfCommentInput consistently reuses the toolbar's Textarea composition and style, with new Chinese and English placeholders. New comments do not repeat the title; editing existing comments and Save/Cancel semantics remain. Persistence and historical conclusions are unchanged.

<a id="2026-11-10-浮层工具栏单排增量依据"></a>
## Basis for Single-Row Overlay Toolbar Increment: 2026-11-10

Asset revision: `pdf/12`. Per the user's screenshot, selection and annotation overlay action areas remain on one row and scroll horizontally within the local area when width is insufficient. Only PDF consumers change; shared FloatingToolbar defaults, comment editing, and persistence remain unchanged. Retain PDF-OBS-008/009 stable IDs and historical versions. Regress the one-row action buttons and real expanded-comment state.

<a id="2026-11-10-筛选图标与提示增量依据"></a>
## Basis for Filter Icon and Tooltip Increment: 2026-11-10

Asset revision: `pdf/11`. Per the user's screenshot, the PDF-OBS-008 highlight-filter icon reuses the Lucide Highlighter used in the top bar, and category tabs reuse Tooltip to show their names. Filter behavior, stable IDs, and historical conclusions remain unchanged. Regress icon identity, hover tooltips, and existing keyboard navigation.

<a id="2026-11-10-侧栏空态增量依据"></a>
## Basis for Sidebar Empty-State Increment: 2026-11-10

Asset revision: `pdf/10`. Based on the user's screenshot and request, center the PDF-OBS-008 sidebar empty state and use regular 12px weight. Change the outline text to “暂无大纲” (“No outline”). Reuse compact EmptyState and adjust font size only in PDF consumers; global empty states and data behavior remain unchanged. Preserve stable IDs, requirement versions, and historical conclusions.

<a id="2026-11-10-菜单文案增量依据"></a>
## Basis for Menu-Wording Increment: 2026-11-10

Asset revision: `pdf/9`. Per the user's explicit request, change only the PDF-OBS-008 “编辑” menu item to “修改标注方式” (“Change mark type”), reusing the existing `pdfAnnotation.edit` resource key and action. Interaction, stable IDs, requirement versions, and historical conclusions remain unchanged.

<a id="2026-11-10-编辑子菜单增量依据"></a>
## Basis for Edit-Submenu Increment: 2026-11-10

Asset revision: `pdf/8`. Based on the user's screenshot and three explicit requirements, PDF-OBS-008 adds a right-opening edit submenu, 4px of horizontal padding on each side of the annotation-color button, and the semantic icon-outline-default color for the expand arrow. Retain the right/start positioning of `PopoverContent`; do not change the shared overlay. In `pdf/Tools.tsx`, adjust only the compound color button's content width and padding, without changing color values or save behavior. `pdf/annotation.render.test.ts` covers parent/child menu position, actual left/right spacing, and arrow color. Preserve original stable IDs, requirement versions, and historical results; do not expand the basic-reading quick-check denominator.

<a id="2026-11-10-筛选选中态增量依据"></a>
## Basis for Filter-Selected-State Increment: 2026-11-10

Asset revision: `pdf/7`. Based on the user's screenshot and explicit requirement, only the text is bold when a PDF-OBS-008 annotation-category filter is selected; the icon retains its original stroke width. No new requirement version was specified; preserve the original stable IDs, versions, and historical conclusions. Implementation entry point: `pdf/Annotations.tsx`. Regress text weight and the icon's actual stroke width before and after switching. Do not change global Tabs or the basic-reading quick-check denominator.

<a id="2026-11-10-工具栏颜色增量依据"></a>
## Basis for Toolbar-Color Increment: 2026-11-10

Asset revision: `pdf/6`. Based on the user's screenshot and explicit color requirements for this round, revise only the PDF-OBS-009 selection/annotation toolbar colors. Preserve stable IDs, existing requirement versions, and historical results; no separate product requirement version was specified for this increment. The basic-reading quick-check denominator is unchanged.

The source baseline is this uncommitted diff on `8b7d2b9666c77af55d004dbd1e68d6f6bcb2e342`: `Selection.tsx`, `pdf/Annotation.tsx`, and shared `pdf/Tools.tsx`. Text buttons use separate colors for icons and text; icon-only buttons change color according to their existing aria-pressed state. The explanation icon reuses the existing monochrome sparkle asset. Regress explanation, translation, Add to conversation, Copy, and Comment buttons in both overlays, in light/dark themes and default/active states. Do not change model requests, annotation persistence, or global Button/IconButton.

`pdf/annotation.render.test.ts` adds assertions for actual CSS colors. Deterministic render regressions do not replace real Desktop screenshot acceptance and do not prove model-output quality or Windows product acceptance.

<a id="2026-11-05-界面增量依据"></a>
## Basis for Interface Increment: 2026-11-05

On the same day, the user further confirmed that in-document comment bubbles reuse the top toolbar's MessageSquareText icon, and PDF-OBS-008 was upgraded to v`0.2`. `pdf/Page.tsx` owns the icons for text comments, pinned comments, and drafts; positions and interactions remain unchanged. `pdf/pins.render.test.ts` covers real click coordinates, navigation, and icon consistency.

PDF-OBS-008/009 were adopted based on the user's itemized screenshots and explicit dimensions, colors, interactions, and final requirements for ten default lines and scrolling after resizing. They apply to development changes in this checkout; do not attribute them to known capabilities of the 202610301343 installed package. The source text in design file 203335358980331 at 593:81210 specifies PingFang SC 12px/18px, weight 400, and page numbers at 10px/16px. Source node 442:089081 specifies navigation buttons at 28×28, 8px radius, and 4px spacing. If a linked instance path returns an empty node, read its explicitly provided source_layer_id; do not infer measurements from screenshot scale.

Source entry points are `PdfDocument.tsx`, `Selection.tsx`, `pdf/Annotations.tsx`, `Annotation.tsx`, `Comment.tsx`, `Reading.tsx`, and `Tools.tsx`; the shared compact translation control is in `translation/Controls.tsx`, and the generated-notes list is in `literature/Generate.tsx`. Resolve all paths relative to `src/renderer/src/features/workbench` or its parent `features` directory. Regress navigation keyboard behavior, annotation and comment editing, active states, ten default lines, and scrolling/gradients after resizing. One interface acceptance does not establish model-output quality, Windows acceptance, or passage of the full release quick check. The previously adopted basic-reading scope and freeze records remain unchanged.

<a id="历史修订202610301343包内静态复核"></a>
## Historical Revision: Static Review of Package 202610301343

Asset revision: `pdf/5`. This change only adds the specified new-package source, input/independent references, and quick-check boundaries. Preserve original stable IDs, v`0.3`, adoption rules, full requirement text, original versions/dates of reference images, and historical results. The older sources and revision records below are historical and do not establish package binding or execution conclusions for this round.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. The source is the actual installed package and loose renderer payload extracted for this task. The source commit is unknown; the current checkout/remote HEAD can only help locate it and does not establish source identity. The evidence manifest is the ignored directory's `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`; all in-package locations are relative to its `package/` root. Do not treat the temporary extraction directory as a formal cross-worktree asset.

In-package `out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: `applicationRenderer` at 1338 selects the renderer under applicationResources when packaged; the no-development-URL branch at 41203 passes it to serveAssets. This chain is bound to the actual loose payload analyzed in this task. It does not prove that no development override was set at runtime, nor does a static entry point count as product observation.

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/PdfDocument-CDP-g4K8.js`：SHA256 `e9bc5c697c23ec41d93696c9c8998e56c1885dcf52b03f511c5f37e99f2af335`。

In-package PdfDocument:65463 reads the session/tab; 65634–65652 reloads the page count and gets `pageCount` from PDF parsing; `navigate` at 65739 validates its target against `pageCount`, updates page state, and scrolls to the actual page node; buttons at 66647/66682 are disabled at boundaries. The original two-page `sample.pdf` is compatible with the normal-reading/navigation path, and its independently verified page count and two page features are unchanged. Select only one valid navigation action for 001/002; do not treat registration or count changes as rendered body content. Preserve the historical nonconformance for zoom requirement 003 and the outline/search/error supplements; a new chunk and its source cannot rewrite those historical conclusions. MRU, PDF auxiliary records, and index initialization still require execution authorization; do not describe the run as a zero-write operation.

“Sample” in the requirements means an authorized isolated copy of a repository original. Before execution, record the mapping from the original's digest to the task project ID and actual post-import path; historical `eval-*-20261030` names are old run aliases and must not be assumed to exist in a new installation. Independent evidence still needs to be authorized in this round for the minimal project/resource/column-preference/API projections. Static compatibility does not prove that the normal UI is reachable or has passed testing. This round did not start, connect to, or operate the product; read no user state or credentials; and called no external APIs. It does not change runtime state or reduce unready supplements.

<a id="历史构建与分层记录"></a>
## Historical Build and Layering Records


Revision: pdf/4. Under the user-wide adoption rule from 2026-10-30, verified normal behavior in the bound installed `v0.3.0 / 202610281438 / preview` is the basis for requirement v`0.3`; reuse existing source, exact artifact binding, and independent requirement/data review. Normal loading, page navigation, zoom (custom range 10%–500%), native outline, search, and thumbnails for PDF-OBS-001–006 were adopted. Feedback and recovery for outline-read failure in 004, text/search failure in 005, and damaged, encrypted, or partially loaded/rendered files in 007 remain unconfirmed supplements; do not treat failures as no-outline or zero-match states. None of this was tested; adoption grants no product-operation or additional-read permissions.

Retain the synthetic multipage/outline input and independent properties from revision 2. This revision changes only adoption status; all seven IDs, criteria, and requirement versions remain unchanged. Selection/annotation, AI reading, and generation/saving remain separate coverage and gain no permissions or presumed pass from basic-reading adoption.

<a id="精确制品绑定"></a>
## Exact Artifact Binding

The target is the installed macOS `0.3.0 / 202610281438 / preview`, with matching Info.plist and product.json. The ASAR was reread; SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. The packaged serveAssets chain at `out/main/index.js:41022` points to `applicationResources(app)/renderer`. The following are rechecked hashes under `Contents/Resources/renderer/assets/`:

| File | SHA256 |
| --- | --- |
| index-C4-PYlXk.js（index） | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js（workspace chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| PdfDocument-y2KblsYr.js（PDF chunk） | `ce55e6d5a9cee62662b9c655a73365587b9ed0d6fbe4b06a1755c6cabc18ab99` |

index:64402 explicitly imports this PDF chunk, which in turn imports geometry utilities and Workbench contracts from the index/workspace chunks. This document checks only the functions it read and does not claim that the entire repository matches the package. PDF.js loading, text-layer, and canvas implementations come from this actual packaged reader. The backend's old PDF byte-route comment, “Chromium built in, no bundled pdf.js,” does not match the current renderer and must not be used to infer a different rendering path or annotation capability.

For the following Owners, each file was compared between repository `apps/serve/` and the installed package's `Contents/Resources/backend/python/lib/python3.12/site-packages/`; SHA256 matches on both sides:

| Relative path | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/workbench/service/records.py | `c3071a67b5e65262c0cad4c73b0f72bcadae8beda52ccf1a7ae556c073ecd708` |
| service/workbench/service/regions.py | `7621aad37e095c3df6714bc302c98cef70c3174456d957b01b1b184f019679be` |
| service/workbench/service/indexing.py | `9e25b9983f3e1b522e03ff1d85b8f1158428c653363bcf5868eaca4f4dbe8361` |
| service/platform/citations.py | `53830408d916c00ae0ddcd4467e2c4363a6118e34635ff869b0e4b82b0e4b1ea` |

<a id="固定动态与条件链路"></a>
## Fixed, Dynamic, and Conditional Paths

| Item | Source/package location and expected reference |
| --- | --- |
| 001 Dynamic/conditional | [PdfDocument.tsx](../../../src/renderer/src/features/workbench/PdfDocument.tsx):343/482 creates getDocument and PdfLifecycle; loading occurs only when active and bytes are present. PDF chunk starts at :64905 and reads the native outline around :65109. [lifecycle.ts](../../../src/renderer/src/features/workbench/pdf/lifecycle.ts):64 `open` rejects stale results by generation, reads numPages, and loads the target page; if an embedded ScholarSeed annotation attachment exists, it is restored first. [api.ts](../../../src/renderer/src/features/workbench/api.ts):385 gets identity, capabilities, revision, and bytes through project open/content. [routes.py](../../../../serve/service/workbench/api/routes.py):156 projects from snapshot, size, and format capability; :235 content returns ETag/content. [model.py](../../../../serve/service/workbench/domain/model.py):227 defaults PDF `can_edit=false`, which does not mean it cannot be read. Do not substitute the file extension for public viewer/capabilities. Check the document shell, page count, and render state separately. |
| 002 Dynamic | PdfDocument.tsx:615 `navigate` updates the page number and calls `scrollIntoView`; :1323 `onScroll` updates the number from the most visible page; PDF chunk:65182/65829. [geometry.ts](../../../src/renderer/src/features/workbench/pdf/geometry.ts):142/355 and index:59751/59939 clamp physical page order and compare visible height, respectively. Toolbar input at :1636 commits on Enter/blur; the jump-page dialog at :1531/2226 accepts only valid integers, PDF chunk:66143/66729. Invalid toolbar page input is clamped, while the jump-page dialog validates it; identical error wording is not required. Arrival is proven only by known page features and the actual viewport. |
| 003 Dynamic/fixed range | PdfDocument.tsx:596/1177 computes fit or custom scale from page dimensions and available viewport; minus, PdfScale, and plus controls begin at :1594. [Scale.tsx](../../../src/renderer/src/features/workbench/pdf/Scale.tsx):49–116 switches page/width on single click, edits the percentage on double-click, commits on Enter/blur, and cancels on Escape; PDF chunk:64695. [zoom.ts](../../../src/renderer/src/features/workbench/pdf/zoom.ts):33 and PDF chunk:64797 handle Ctrl/Meta wheel and limits; PdfDocument.tsx:1182 preserves the zoom anchor. [geometry](../../../src/renderer/src/features/workbench/pdf/geometry.ts):20/149/159 and index:59673/59758 fix 0.1–5 with 0.25 steps; percentScale handles percentages. The normal custom range of 10%–500% has been adopted. Other values are implementation references, not fixed screenshot pixels. |
| 004 Conditional | PdfDocument.tsx:524 gets the native outline from PDF `getOutline`, then [navigation.ts](../../../src/renderer/src/features/workbench/pdf/navigation.ts):193 `outlineTree` parses named/explicit destinations and physical pages by level; PDF chunk:45890. [Outline.tsx](../../../src/renderer/src/features/workbench/pdf/Outline.tsx):18/36/70 provides hierarchical collapse and navigation to parseable destinations, PDF chunk:62095/62159. Entries without destinations are `aria-disabled` and do not navigate. A failed `getOutline` is also caught by clearing the outline, mixing failure with the genuine no-outline state; this is an unverified gap and must not be approved as correct error semantics. |
| 005 Dynamic/conditional | PdfDocument.tsx:695 delays the query, calls getTextContent in batches of 8 pages, concatenates `hasEOL`, and calls matchText; PDF chunk:65257 onward. [geometry.ts](../../../src/renderer/src/features/workbench/pdf/geometry.ts):164 and index:59773 use case-insensitive, whitespace-tokenized matching, not OCR or semantic search. :1170/1858 provide the match list and wraparound previous/next navigation; PDF chunk:66396. Page.tsx:348 maps text-layer matches to visible highlights. Compare match counts and pages with the sample verified in advance; the search result list alone is not the reference answer. |
| 006 Dynamic | PdfDocument.tsx:1812 creates thumbnail entries from `pageCount`, PDF chunk:66335. [Page.tsx](../../../src/renderer/src/features/workbench/pdf/Page.tsx):857 `PdfPageSlot` and PDF chunk:46580 use IntersectionObserver to load nearby pages. Both the main document and thumbnails may temporarily show placeholders; thumbnails do not create text layers. Clicking still calls `navigate` rather than merely changing selection state. Check recognizable thumbnail content, physical page order, and document position together. |
| 007 Conditional | [loading.ts](../../../src/renderer/src/features/workbench/pdf/loading.ts):15 classifies PasswordException/EncryptedPdfError as encrypted and other failures as unknown, PDF chunk:61859. PdfDocument.tsx:1506/1555 shows the dedicated encrypted state; :1761 shows ordinary `loadFailed` or unavailable-source state; :2005 is loading. Page.tsx:293/529 shows `pageRenderFailed` for canvas-render failures. Handling remains to be checked for rejected `getPage` calls on later pages and for existing canvases after text-layer failure. Do not treat “the current catch has a branch” as complete error-recovery capability. Without credentials, do not attempt decryption or external opening. |

The actual keyboard entry points are [shortcuts.ts](../../../src/renderer/src/shortcuts.ts):187–204 and PdfDocument.tsx:1242, PDF chunk:65752. They apply only to `focusedTab`; PDF commands do not intercept ordinary editable inputs, and previous/next match commands respond only while the search box is focused. Resolve platform and shortcut overrides from configuration rather than hardcoding every key in this document. For adopted normal requirements, verify actual content changes for basic navigation, search, and zoom; this does not authorize annotation/copy commands.

<a id="独立参照及阅读状态边界"></a>
## Independent References and Reading-State Boundaries

The top-level `project_id/path/asset_id/revision/viewer/content_kind/capabilities` fields from public project GET `/api/workbench/open` verify document identity and preview capability. Bytes/ETag from GET `/api/workbench/content` can be associated with an authorized sample digest. The `open` projection does not provide the native outline, full-text matches, or the reader's actual page position; API success does not establish correct page navigation or zoom.

Public GET `/api/workbench/pdf/regions?project=…&path=…&revision=…&start_page=…&end_page=…` validates revision and PDF media type in routes.py:293/306. [regions.py](../../../../serve/service/workbench/service/regions.py):17 returns `source_revision`, `page_count`, `unavailable_pages`, and region metadata; within authorized scope it can independently help verify page count, but it is not an answer for native outlines or full-text search and cannot replace a known sample or UI position. This read enters [indexing.py](../../../../serve/service/workbench/service/indexing.py):267/299; page counts and page results may be written to the index cache, so this reference query is not absolutely write-free.

Before execution, each selected dataset must have an independent reference for total physical page count at the same revision, at least two distinguishable target-page features, native-outline presence/hierarchy/destinations, text-layer presence, and known query match pages/counts. The scenario samples below provide some independent input properties; each run must still verify the bytes used and their source. Without a reference, mark the branch uncovered; do not infer the answer from the reader under evaluation and then use it to validate itself.

PdfDocument.tsx:297/470 reads and writes page/scale/mode/sidebar/query/navigationWidth from `tab.viewState`. [workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):2080 only publishes tab `viewState`; the corresponding workspace chunk contains `setTabViewState`. :655 locates the current page after remount or geometry changes. This is current-process/tab state, not proof that reading progress persists across restarts. If reading-state or split-pane independence becomes a focused check, compare against records visible before the action; do not use the internal store as self-verification.

The existing [DESIGN](../../../DESIGN.md) and [vibe](../../../docs/design/vibe-coding.md) constraints are reused: scrolling stays inside the reading area, and toolbars/navigation remain reachable within supported window bounds. Source structure and static gates do not replace real evidence for themes, narrow windows, or keyboard behavior.

<a id="副作用数据与缺口"></a>
## Side Effects, Data, and Gaps

Opening a normal project updates `recentFiles` through [store.tsx](../../../src/renderer/src/store.tsx):3140/3196; the literature-open recorder updates `recentLiterature` at :1813. These enter the preference-commit chain at :1881, so opening is not guaranteed to be write-free. When PDF is active, :563 subscribes to/reads records. `snapshot_asset` in [records.py](../../../../serve/service/workbench/service/records.py):107/148 may call `catalog.create` when auxiliary records are missing; this initializes auxiliary persistent state even though the original PDF is unchanged. :1420 also automatically reads adjacent-page visual regions, triggering the index cache described above. For real literature, Reading.tsx:364/410 reads existing AI results; this does not prove a model was called and does not authorize AI generation. File, built-in, and literature sources differ; do not infer that all associated-record Owners have complete coverage.

The [sample.pdf](../../../../../examples/projects/evaluation/files/sample.pdf) takes one page each from the repository's [minimal project sample](../../../e2e/fixtures/data/minimal-project/sample.pdf) and [preview sample](../../../e2e/fixtures/preview_pdf_1MB.pdf), then adds a native outline to create a new synthetic input. It preserves the original page text and does not inherit the preview file's fixed 1 MB size. The actual file is 2,182 bytes, SHA256 `ebcb3b918e0367e4d5715efe7628ff5a9e6701fc89a163776270d49700d74a36`; it is unencrypted, has no forms or JavaScript, and has not been imported into the product. It is test input, not a product screenshot, completed state, or real literature.

The two pages contain “Minimal sample PDF” and “PDF Preview Test,” respectively. The native-outline parent “Synthetic reading sample” points to physical page 1; its children “Synthetic overview” and “Synthetic detail” point to pages 1 and 2, respectively, enabling checks of hierarchy expansion and cross-page navigation. Independent text references: “Needle” occurs once on page 1 only; “padding” occurs once on page 2 only; case-insensitive “PDF” occurs once on page 1 and twice on page 2, three matches total; “NO-MATCH-SYNTHETIC” has no matches. The original source's existing reference to padding is not a size expectation for this file.

The generation recipe only merges the source pages in the order described above with pypdf and adds a three-entry outline and synthetic-data metadata. Generation, independent parsing, and two-page render verification are recorded in ignored run records and are not product acceptance. The original [onboarding sample](../../../src/renderer/src/features/onboarding/assets/sample.pdf) and the two source PDFs above are each single-page files without native outlines. They can cover their respective branches but cannot replace this sample's multipage/outline checks. Long thumbnail lists, batched search beyond 8 pages, scanned, damaged, encrypted, and partial-failure files are not ready. Do not use the small sample to reduce the original scope or claim complete coverage.

[onboarding/sample.ts](../../../src/renderer/src/features/onboarding/sample.ts):4/8 and index:71586–71607 bind `builtin:onboarding-v1`. It reads bundled bytes, is read-only, cannot be annotated or saved, and explicitly does not invoke literature import. This single-page sample without an outline can be used as basic rendering input; it cannot substitute for real `literatureId`/`attachmentId`, multipage scenarios, or proof of AI functionality. Successful source registration does not mean the product has passed.

Unknowns and items to observe include the real PDF entry point; complete error and loading coverage; the mixed handling of native-outline read failures and genuine no-outline files; rejected page retrieval on later pages; text-layer failure feedback; applicability to real samples; correspondence between the active page and viewport after zooming; shortcut configuration/focus behavior; and restoration boundaries across restarts. Without a product run or genuine reference images for this page, do not fabricate images or create a three-part machine-generated package. If prerequisites are insufficient, retain adopted requirements and unconfirmed errors; do not declare a pass or modify the product to manufacture acceptance.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Check Layering (2026-10-30)

This asset revision is pdf/4. Per the user's pre-release quick-check goal and uniform adoption rule, add quick-check and supplemental layers in the same requirements document, reusing the source binding, exact artifact, and existing review recorded here. The old v`0.3` business version and full criteria remain unchanged. Selected sources are explicit body subpoints in PDF-OBS-001 and 002. The required reference is the existing eval-pdf-20261030.pdf, plus the original's two-page text/page count and build summary. Unselected scope includes zoom/limits (retain the historical nonconformance for 003), outline, search, thumbnails, and errors; items lacking evidence remain pending confirmation.

This change only layers the checks before execution; it does not conclude that the product passed or cover the historical full run. Later runs consume subpoints frozen by independent review; a quick-check result must not be claimed to cover the entirety of the original IDs. This build adds no product-operation or data-write permissions.

<a id="当前参考图修订pdf37"></a>
## Current Reference-Image Revision: pdf/37

`reference-20261112.png` is an unchanged copy of the original `attempt-examples/evidence/pdf-page1-ready.png` from an isolated installed macOS arm64 0.3.2 / 202611121104 / preview instance on 2026-11-12. SHA-256 `fa7bd5c9c760ccb0f83460773f0938fab78c57d3f058fa1989bf6d57111725f9`. It shows only the first page of a synthetic PDF and does not prove other interactions or error states. The original run is in `tmp/test_snapshot/desktop/release-20261112-fresh/`. Requirement and historical decisions remain unchanged.
