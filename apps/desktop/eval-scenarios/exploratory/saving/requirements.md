<a id="文档保存与未保存保护"></a>
# Document Saving and Unsaved-Change Protection

Editor context for document saving

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; shows the code editor and save controls only, not a saved, failed, or conflicted terminal state.

The verified normal save eligibility, manual/automatic saving, and project-copy operations have been adopted as v`0.3` requirements. They are write-operation scenarios and require authorization for the current run. Failure recovery in 004, abnormal terminal states/unbound sources in 005, and the no-path unnamed-document entry in 006 remain unconfirmed; adopting normal behavior does not approve expectations for abnormal cases.

Edit an authorized document in the project workbench, save the changes reliably, and preserve the user's options when saving fails or a conflict occurs. The semantic entry is the document-editing view after normally opening a resource and its save action; automatic saving follows the current file settings, and conflict handling exposes resolution actions. Whether the real page is reachable remains to be observed under authorization.

The evidence recovered so far covers the project-resource Markdown/Monaco editing path. Other sources and viewers still need supporting evidence; do not claim coverage based on a generic capability field.

<a id="将编辑写入文档"></a>
## Write Edits to a Document

<a id="编辑与保存资格save-obs-001--v03"></a>
### Editing and save eligibility (SAVE-OBS-001 · v`0.3`)
Conditional: Editing and save entry points are available only when the document's actual public capabilities and current view support editing and saving. A read-only, preview, or runtime-restricted document does not gain write access merely because it has the same file extension. Check the public capabilities and real view of documents authorized for this run; do not misclassify non-editability as a save failure.

<a id="手动保存与内容终态save-obs-002--v03"></a>
### Manual save and content outcome (SAVE-OBS-002 · v`0.3`)
Dynamic: After saving through the document save entry or an applicable editor shortcut, reread the public document content at the same project and path; it must include the known changes made in this run. Edits made during saving must not be represented as though an older save result included them. If format-on-save is enabled, check content against the formatting expectation specified beforehand. Ordinary tab switching, absence of a dirty marker, or a disabled button is not proof that data was written to disk.

<a id="自动保存条件与结果save-obs-003--v03"></a>
### Automatic-save conditions and outcome (SAVE-OBS-003 · v`0.3`)
Dynamic and conditional: The automatic-save switch matches its actual value in this run's isolated preferences. When enabled, applicable triggers, such as the editor losing focus outside the document work area, can save the currently authorized writable document; when disabled, these triggers alone must not commit it. The switch is in File Settings or an actually reachable preferences entry. Verify the result against the public content reread from the same document; ordinary document-tab switching alone does not promise automatic saving.

<a id="保留失败与冲突中的改动"></a>
## Preserve Edits on Failure or Conflict

<a id="保存失败反馈与恢复save-obs-004--v03"></a>
### Save-failure feedback and recovery (SAVE-OBS-004 · v`0.3`)
Conditional specialized scenario: Under an authorized real failure precondition, a failure must not appear as saved or silently discard current edits. Once the recovery prerequisite is restored, saving can be retried and the content independently verified. A request may fail after the write occurred, so reread the target to determine its actual state; an error message alone cannot establish that the disk was unchanged.

<a id="冲突选择与另存副本save-obs-005--v03"></a>
### Conflict choices and saving a copy (SAVE-OBS-005 · v`0.3`)
Conditional specialized scenario: When known disk content conflicts by version with unsaved edits, preserve an opportunity to handle both versions; do not silently overwrite. After authorized overwrite, the target contains the current edits; after authorized discard, restore the disk content. For project documents that support the entry, Save a Copy retains the current edits as a new managed resource while keeping the original target separate. Verify against the two contents recorded beforehand and the actual new path; this is not a generic system Save As dialog for arbitrary documents.

<a id="空白文档与新标签边界save-obs-006--v03"></a>
### Empty documents and the new-tab boundary (SAVE-OBS-006 · v`0.3`)
Conditional: A real empty-content document that was created or imported with authorization must, after normal opening and editing, satisfy the saving and reread criteria. A workbench “new tab” does not itself create a saveable file. The save entry for an unnamed document with no path has not been verified and remains unconfirmed; a successful-looking blank new tab does not replace the empty-document saving scenario.

<a id="关闭保护与验证归属"></a>
## Close Protection and Verification Ownership

Unsaved-close protection reuses [Tabs and Split View TABS-OBS-008](../tabs/requirements.md); this page does not create or duplicate a close criterion.

This page is a write-authorization specialty reserved in advance and is not part of the default read-only quick package. The read-only capability observation in 001 cannot replace the behaviors in 002–006. Before execution, specify the synthetic copy, read/write and preference-change scope, failure/external-modification conditions, overwrite/discard, and creation permissions. If prerequisites are missing, leave the scenario incomplete; do not retire branches. If multi-document saving is selected, list every authorized target and its individual terminal state first; this does not authorize saving other existing edits as a side effect.

Reuse authorized disposable isolated copies of the shared example project's [resource sample](../../../../../examples/projects/evaluation/files/overview.md), [plain-text sample](../../../../../examples/projects/evaluation/files/notes/detail.txt), and [zero-byte document](../../../../../examples/projects/empty-document/project.json). Use this run's preparation receipt to verify project identity, actual path, and input digest; the originals do not represent product state or prove import completion. A human must confirm import tests. Editing, saving, and related writes such as preference changes, overwrite, or discard each require authorization for this specialty. It also requires a real isolated empty document with a path, known before/after edit content, a real failure precondition, and an independent source for external modification. Do not prearrange a save result when prerequisites are not ready. Screenshots/text feedback and the public content outcome complement each other; neither replaces the other.
