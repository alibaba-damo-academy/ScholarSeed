<a id="markdown与代码阅读编辑"></a>
# Markdown and Code Reading and Editing

## Markdown Reading Page Reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12. Synthetic material shows read-only state; does not represent verified editing, saving, or all formats.

Verified normal reading, modes, find, and editing behavior are adopted as v`0.3` requirements. 006–007 are write-focused scenarios and require authorization for the current run. 005 heading outline, read-only tool consistency, error feedback, and other unsupported/exception branches remain pending confirmation; do not substitute a format menu or find action for an outline.

Read Markdown or code in the project workbench, locate content, and edit when authorized. The semantic entry point is the document Viewer after normal material opening. The Markdown mode selector distinguishes preview (`预览`), visual editing (`可视编辑`), and source (`源码`); code documents have a separate source Viewer and are not Markdown preview. Real entry-point observation remains subject to authorization.

<a id="阅读与定位内容"></a>
## Read and Locate Content

<a id="文档身份与模式editor-obs-001--v03"></a>
### Document Identity and Mode (EDITOR-OBS-001 · v`0.3`)

Conditional: Actual preview/edit capability, read-only reason, and current mode match. Markdown preview is not edited state. Source mode displays raw markup and allows editing only when the document is writable. When a large document is constrained, preserve source-reading access and limitation notice; do not require visual editing. After mode switching, it remains the same document and current content; do not present it as saved.

<a id="markdown结构与公式editor-obs-002--v03"></a>
### Markdown Structure and Math (EDITOR-OBS-002 · v`0.3`)

Fixed input/dynamic display: In supported preview/visual views, the synthetic sample's two-level headings, ordinary list, table, code block, inline formula, and block formula are discernible; source view preserves corresponding original text. Use sample structure and mathematical expressions as references. Source text need not match rendered appearance, and code highlighting does not mean code was executed.

<a id="代码语法与行定位editor-obs-003--v03"></a>
### Code Syntax and Line Location (EDITOR-OBS-003 · v`0.3`)

Dynamic: TypeScript input displays discernible syntax in the corresponding language and complete first/last content. After find or go-to-line, visible content matches the target sample line. Wrapping changes reading layout, not source text. Verify using known lines and first/last markers; a line-number field or language-label change alone does not prove navigation succeeded.

TypeScript document display reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows syntax and first/last markers in synthetic TypeScript; does not by itself prove go-to-line or other operations.

<a id="查找与命中切换editor-obs-004--v03"></a>
### Find and Cycle Through Matches (EDITOR-OBS-004 · v`0.3`)

Dynamic: In Markdown visual content and in source/code, use each applicable real find entry point to locate a known marker. Next/previous and no-result feedback correspond to actual content. Check the two occurrences of the same body marker in each sample and their locations. Markdown visual find does not equal complete matching across blocks, formulas, or source syntax; judge extra Monaco find options only under actual enabled conditions.

Markdown visual find, first match reference

Markdown visual find, second match reference

Reference: find state on synthetic content in an isolated project on the same version; the two images show different match locations. Static images alone do not prove the action or cover every find branch.

<a id="标题目录与层级定位editor-obs-005--v03"></a>
### Heading Outline and Hierarchical Navigation (EDITOR-OBS-005 · v`0.3`)

Candidate, pending confirmation: The outline should follow actual document heading hierarchy; selecting an item should navigate to the corresponding heading/body. The outline entry and implementation chain in this Viewer have not been verified; retain capability/entry-point gap. A heading-format menu, heading displayed in body, or ordinary text find does not substitute for outline criteria. Do not automatically retire the business requirement due to missing source evidence.

<a id="markdown-预览选区添加到对话editor-selection-cand-001需求版本待确认"></a>
### Add a Markdown-Preview Selection to a Conversation (`EDITOR-SELECTION-CAND-001`; requirement version pending confirmation)

Historical user screenshots/confirmation require that a user can select text in preview by dragging and that the selection remains when hovering the toolbar. After adding it to a conversation, the input area shows a quote from the same document selection, matching the synthetic source excerpt recorded beforehand. Clicking the body clears selection; preview remains read-only. Use an isolated clean Markdown copy, independent source excerpt, and document identity as references. If quote content is truncated, obtain an observable complete quote or other authorized evidence; card title alone is insufficient. Verify read-only state through an authorized safe representative action and independent file content/digest. If prerequisites are missing, retain the evidence gap; do not edit/save without authorization. Highlighted selection or a visible button alone does not prove quote content is correct. Adding a quote is not sending a message or model reading it.

Markdown preview selection and toolbar

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13. Complete product viewport of a read-only isolated synthetic document with selection and toolbar shown; toolbar was not clicked. Does not prove adding quote, sending, read-only behavior, or formal evaluation pass. See the [Build Basis](./build.md) for source and state limitations.

This is a candidate focused scenario; target-version entry, applicability, adoption, and requirement version remain unconfirmed. A real complete-window image of the target package's quoted end state is missing. Requires authorized reading of the isolated copy and writing to conversation draft; stop if document is dirty. Saving requires separate authorization. Markdown selection, conversation mixed-quote display, and PDF selection have distinct entry points/end states and cannot substitute for one another. Complex formatting, cross-block selection, cross-platform behavior, and model invocation require separate review.

<a id="在授权副本上编辑"></a>
## Edit an Authorized Copy

<a id="修改与撤销重做editor-obs-006--v03"></a>
### Modify and Undo/Redo (EDITOR-OBS-006 · v`0.3`)

Write-focused scenario: In visual or source edit mode for a writable document, modify a known target and verify actual content changes. Undo restores the content before that edit; redo restores the content after it. Switching supported modes still reflects the same current content. Judge within the editor's actual history boundary; do not claim all modes share one undo stack or infer edit success from preview success.

<a id="替换与格式化editor-obs-007--v03"></a>
### Replace and Format (EDITOR-OBS-007 · v`0.3`)

Write-focused scenario: In an actually supported source/code replacement entry point, replace selected/all matches and change only the match scope explicitly recorded beforehand; read-only state must not be bypassed through replacement. For visual formatting or format-on-save, verify only the selected branch and pre-agreed structural/semantic outcome. If there is no independent full-document formatting entry point, do not invent a requirement for one. Failure feedback does not by itself mean save failed or succeeded.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

Adopted normal branches 001–004 belong to ordinary display/mode/find scope; 005 remains an unconfirmed entry point and is not ready to execute. 006–007 are authorized editing scenarios; complete Markdown/code behavior remains a focused scenario. This page does not use one preview to cover all interactions. For save end state, reuse applicable adopted portions of [SAVE-OBS-002 and related saving scenarios](../saving/requirements.md); confirmation does not approve unconfirmed failures. For close protection, reuse [multi-tab TABS-OBS-008](../tabs/requirements.md) without duplicating criteria.

Use authorized isolated copies of the shared evaluation project [Markdown sample](../../../../../examples/projects/evaluation/files/sample.md) and [TypeScript syntax input](../../../../../examples/projects/evaluation/files/sample.ts); use current run receipt for preparation state. Preparation is not an import-feature test; import requires user confirmation. These are not saved results or real research material. Explicitly authorize document reads, associated MRU/preferences, and possible auto-save. Editing/replacement/formatting need separate corresponding scope. Read code only; do not execute it or infer compilation, runtime, or external-request capability from syntax highlighting.

<a id="发布快评层"></a>
## Release Quick-Review Layer

Adopted normal v`0.3` subcriteria: EDITOR-OBS-001–004. This covers only the scope below, not every detail under these IDs.

Main Markdown headings, lists, tables, code, and inline/block formulas should match the original sample structure; TypeScript syntax and source text should be discernible in the corresponding language. Representative action: only in Markdown visual find, search `EDITOR-NEEDLE` and press Next once to reach the second actual body occurrence. The two markers are on original lines 5/35; a count of two alone is not proof of location. Preserve the historical 004 location issue.

Required reference: authorized isolated copies of [sample.md](../../../../../examples/projects/evaluation/files/sample.md) and [sample.ts](../../../../../examples/projects/evaluation/files/sample.ts), original line references, and current run project/path mapping. Do not type in body; stop if dirty.

<a id="专项层"></a>
## Focused Scenarios

Not selected in this layer: full mode cycles, go-to-line/wrap preferences, all find options, unconfirmed 005 outline, selection-to-conversation candidate, and 006–007 editing/replacement/format/save writes. Preserve original full criteria, stable IDs, versions, and historical results; layering does not authorize unconfirmed branches.
