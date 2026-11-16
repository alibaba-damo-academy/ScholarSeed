<a id="pdfe-弹窗应用接入范围"></a>

# PDFE Dialog Integration Scope

## Scope

Bring together in PDFE the modal dialogs and confirmation dialogs that are reachable from current menus and have actionable, isolated preview seeds, grouped by business area.
Keep all existing pages and dialog entry points. Do not restore hidden features, expand real permissions, or duplicate business UI just to include an item in this catalog.
Runtime and isolation boundaries are defined by the [preview architecture](../architecture/preview.md).

## Source of truth

- [Scenario registry](../../preview/dialogs.ts): dialogs, business groups, component sources, and original page/scenario identities.
- [Catalog](../../preview/catalog.ts): combines the original product catalog with the dialog projection; the original catalog is not migrated or rewritten.
- [Navigation](../../preview/Navigation.tsx): reuses Collapsible / Button / Badge to display business groups.
- [Deterministic regression](../../preview/dialogs.test.ts) and [native consumption](../../preview/native.spec.mjs): verify catalog invariants and opening/closing from public menus, respectively. The catalog does not replace runtime verification.

## Required

Each included item must identify its real component source, available original scenario, business group, and entry-point descriptions in both Chinese and English.
Reuse the original navigation target and seed. Do not persist dialog state in navigation or force a dialog open through a temporary Store or event.
When an initial form is visible but submission is not wired up, explain the difference; do not include an entry point that only reports an unimplemented error.
For verification, enter through a PDFE scenario button and then use the product's original control to trigger the dialog. Check the actual dialog title, dismiss it with Cancel, and retain a screenshot.
Native file selection, real models, login, system recording, uploads, and installation each require their own authorization and acceptance; they are outside this task.

## Current / Gap

Business groups cover projects, tasks, sessions, project files, documents, versions, literature, literature organization, Skills, connectors, settings and archiving, and feedback.
The registry is the source of truth for the exact inventory; do not maintain a separate scenario count by hand in this document.

Project literature grouping and removal confirmation reuse the original project-file entry point and the reviewed literature sample policy.
To close an unsaved document or switch its language, first disable autosave in the original resource-library file settings, then make an actual unsaved edit.
Describe these prerequisites at the entry point. Do not set dirty state directly or temporarily mount a dialog.

The table distinguishes entry points hidden or conditional in the original product from cases where PDFE lacks a seed. The latter does not prove that the original product is unavailable.
Before restoring an item, recheck the source menus, actionable seed, and real consumer; adding a catalog name alone is insufficient.

| Category | Excluded from this integration | Rationale and conditions for reconsideration |
| --- | --- | --- |
| Current capability unavailable | Message rewind confirmation | The Stream entry point depends on `rewindAnchor`; Serve's current rewind route explicitly returns capability unavailable. Do not fabricate an anchor in the preview to restore a disabled capability. |
| Preview import not integrated | Save literature attachments to the resource library | Opening the original Import dialog immediately requests an import-to-project preflight. The current mock service does not implement that interface and displays a failure. Exclude it until both preflight and isolated copying are actionable. |
| Hidden or no trigger entry | Change account phone/reset password, preferences, shortcuts, welcome guide, legacy project rename, legacy tag-management Dialog branch on literature details | Settings `NAV_ITEMS` is not public; `ProjectActions` has no menu write for `projectRename`; details expose only project and collection `setRelation` entries. Do not misrepresent inline rename or tag editing as modal dialogs. |
| Non-modal and system controls | Menus, Tooltip, Popover, Sheet, Toast, PDF selection translation surface, native file/directory selection | Classify by component modality and actual host. A standalone Dialog inside a Sheet may be included separately. |
| Hidden module path | Legacy resource-tree import/conflict/move/link, batch confirmation for module review | The current original page cannot reach this module through a public menu; a hidden-module preview host is not a public product entry. Public dialogs in the project-file Explorer are cataloged separately. |
| Requires additional data preparation | PDF/Bib import after file selection, Zotero library selection, metadata matching/sync, full-text retrieval, messages that save citations/resources | The current mock source lacks complete upload, upstream parsing, matching, or corresponding message data. Do not present a non-implemented error or hand-written state as an actionable scenario. The identifier-entry form is cataloged separately and does not run a search. |
| Preview service not integrated | Built-in connector details/use/authorization/revocation and editing existing connectors; model connection probe and subscription authentication/deletion | The current connector records and model writes/authentication lack actionable mock seeds; the original model sample is read-only. The custom connector creation form can be opened from the original menu and is cataloged separately, but does not save or start a service. |
| Native or first-run state | Login handoff, first-run storage setup, update notice/preview channel/restart installation, recording review/screenshot annotation and receipt | These require native identity, first launch, a real update candidate, or reviewed capture capability. Do not claim the product menu is reachable using a renderer demo host. Do not capture the user's desktop or trigger a release. The ordinary feedback form remains integrated through its original entry point. |

## Verification boundary

Deterministic tests cover preservation of the original catalog, business grouping, source-target consistency, bilingual steps, search, and JSON round trips.
Native consumption uses the actual PDFE main process, Bridge, same renderer, and isolated scenario service. Each dialog is opened through its original menu.
This verifies PDFE entry points and dialog consumption; it does not prove real backend writes, model behavior, disk behavior, or Windows product compatibility.
Native screenshots are retained in the ignored `apps/desktop/test-results/` directory and are not committed.
