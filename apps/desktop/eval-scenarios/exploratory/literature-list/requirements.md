<a id="全局与项目文献列表"></a>
# Global and Project Literature Lists

Project literature empty state

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-12. The isolated project literature view showed an empty state; the narrow split pane with a synthetic document does not prove non-empty results, import, or column settings.

Target-version global literature empty-list reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Shows only the global empty state in Literature Center; does not prove project literature, import, association, non-empty rows, or details.

Target-version project literature column-settings reference

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12. Full-window view of an empty project literature list and header settings; the workbench split pane on the right is narrow. For page correspondence only. Conflict remains between project default columns and subtitle requirements; the image does not prove correct column preferences, non-empty rows, changes, or import.

Project literature empty-list reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12. Shows only the project literature empty state, not non-empty rows, column preferences, or details.

Verified normal list, selection, and detail behaviors are adopted as v`0.3` requirements. Error branches such as read failures in 005–006 remain pending confirmation and were not approved together with normal behavior. Run progress and results are tracked in each frozen record and report.

View literature in Literature Center or the current project, select entries, and read basic information. Semantic entry points: primary navigation “Literature Center”; project workspace's project files area → “Literature”. Entry reachability and exact visible hierarchy require authorized page observation.

<a id="查看当前范围"></a>
## View the current scope

<a id="全局与项目范围lit-list-001--v03"></a>
### Global and project scope (LIT-LIST-001 · v`0.3`)
Fixed/conditional: distinguish the global Literature Center from the in-project literature list; the project list corresponds to the currently visible project. Dynamic: list entries match the public literature directory for the same scope. Filtering by project in the global sidebar is not equivalent to entering a project workspace; do not infer cross-project data isolation from the displayed list.

<a id="内置分组与数量lit-list-002--v03"></a>
### Built-in groups and counts (LIT-LIST-002 · v`0.3`)
Fixed/conditional: global view provides All, Recently Added, and Unorganized; project view provides All Literature, Ungrouped, and existing groups; Recently Added is not required in a project. Dynamic: global entry counts match public counts for that scope, and entries after switching match the public directory for that group. Recently Added means the server's last seven days. Global Unorganized also excludes entries associated with projects; project Ungrouped means entries not grouped in the current project. Sidebar scope counts are not counts of current keyword search results.

<a id="文献行与显示列lit-list-003--v03"></a>
### Literature rows and display columns (LIT-LIST-003 · v`0.3`)
Dynamic: displayed columns match this list type's local column preferences. Without a saved preference, global defaults are title, author, year, added time, and project association; project defaults are title, subtitle, author, publication information (journal column), year, and tags. Visible cells match public bibliographic records; missing values and long text must not be presented as populated values or another entry. Attachment indicators correspond to public attachment summaries. Observing an attachment indicator does not prove that the attachment opens.

<a id="选择与查看信息"></a>
## Select and view information

<a id="勾选与详情开关lit-list-004--v03"></a>
### Checkboxes and detail toggle (LIT-LIST-004 · v`0.3`)
Dynamic/light interaction: selected count after checking, select-all, and clearing matches the actual checked entries; select-all distinguishes none, partial, and all. Selection does not mean a batch operation has run. Click or Enter opens the corresponding basic information; repeating the same action on that entry closes it. Checkbox state and detail focus are distinct. Opening details creates a recent-open record, so obtain authorization; this is not a zero-persistence observation.

<a id="详情基本信息lit-list-005--v03"></a>
### Basic detail information (LIT-LIST-005 · v`0.3`)
Dynamic/conditional: detail title, basic fields, category/tag/project associations, and selected entry match public detail for the current scope; switching entries leaves no information from the prior entry. Attachment and notes tab counts separately match detail attachment count and notes count. Default to basic information and close back to the list. Empty fields, loading, and read failures have corresponding feedback. Tabs or counts do not prove attachment reading, note contents, or editing.

<a id="加载空态与列表滚动lit-list-006--v03"></a>
### Loading, empty state, and list scrolling (LIT-LIST-006 · v`0.3`)
Conditional: when the current scope has no entries, show an empty state and applicable entry points; loading, read failure, and successful empty results are distinguishable. With entries, show the real list rather than an empty state. Dynamic: entries appearing after scrolling still match the public directory for the same query. Virtualization renders only some rows; do not treat current DOM row count as total, and do not require a user-facing paginator.

<a id="验证归属与数据"></a>
## Verification ownership and data

The adopted normal branches of these six items belong to the automatic quick review, judged against explicitly selected global/project scenarios and their natural branches for this run. Unconfirmed exception branches are not included by that. An empty library cannot substitute for evidence of non-empty rows, selection, and details. Basic non-empty data: the [three synthetic records](../../../../../examples/projects/evaluation/files/sample.bib) in the shared evaluation project. Preparing the file is not literature import or project association; a human must confirm import. Non-empty checks require authorized records and at least one valid project. Choose cross-project distinguishable data, history, and attachment branches only when their preconditions exist; missing preconditions are not a pass.

Complete search/filter rules, column-setting changes and persistence, import, category/tag writes, field editing/sync, attachment reading, notes, project association, deletion, and performance stress belong to their respective specialized scenarios. This page checks only the display necessary here and does not duplicate their business criteria.

<a id="发布快评层"></a>
## Release quick-review layer

Adopted normal subpoints in v`0.3`: LIT-LIST-001–003 and 006. This represents only the scope below, not every detail in those IDs.

Global/project scope at the literature entry, current group and count, visible columns, and rows should correspond. Use the public directory's minimum fields for that scope and current column preferences as independent references. Observe a natural non-empty state or successful empty state only; scroll when needed.

Required reference: existing authorized synthetic literature and read-only directory. If not imported, record the lack of evidence for non-empty rows; do not perform a new import.

<a id="专项层"></a>
## Specialized layer

<a id="文献笔记空态入口lit-notes-empty-cand-001需求版本待确认"></a>
### Empty state entry points for literature notes (`LIT-NOTES-EMPTY-CAND-001`; requirement version pending confirmation)

Historical user-provided reader notes empty-state screenshot contains “Generate notes from annotations” and “Write directly”. For the same authorized literature item, confirm the absence of notes using independent literature identity and notes directory, then observe the reader sidebar empty state and both entry points. Visible entry points do not prove generation, creation, saving, export, or cross-view synchronization. Target-package applicability, requirement version, and a real full-window screenshot remain to be checked; an empty-state image is not evidence of non-empty notes or a write terminal state.

Requires a real imported literature item and readable attachment; a human must confirm import. If annotation-based generation involves real annotations, model calls, or writes, check each permission separately. Direct writing, editing, read-back, and single-note export are separate candidates below; deletion and failure recovery still require their own requirements and independent before/after directories, and are not automatically approved by old screenshots or current implementation.

<a id="文献笔记直接写与单篇导出lit-notes-write-cand-001需求版本待确认"></a>
### Direct writing and single-note export (`LIT-NOTES-WRITE-CAND-001`; requirement version pending confirmation)

For an authorized isolated literature item and readable attachment, use “Write directly” in reader notes to create a distinguishable synthetic note and edit its title and body. After saving completes, return to the list and reopen the same note; verify title/body against the input and independent notes directory for the same literature item. Export that note as Markdown, natively save it to an authorized target path, independently read the file back, and compare title/body. A success notice or screen does not substitute for reading the file; export does not prove the note was saved.

This candidate is based on historical user-provided design and records retaining the original single-note operation. It does not change the empty-state candidate or adopted list criteria. Target-package entry point, detail-tab conflict, applicability, requirement version, and a real full-window non-empty screenshot remain unverified. Creation, editing, and export each have write side effects; require an authorized isolated library, disposable synthetic content, independent before/after notes directory, and export destination. Import requires human confirmation; note writing and native export require separate authorization checks. Empty-state images, historical development-build screenshots, and component tests cannot replace a real target-package terminal state. Note generation, deletion, failure/conflict recovery, concurrent cross-view edits, and restart recovery are outside this candidate's normal path and need separate requirement/permission review. Canceling export does not count as a file being written.

Not selected in this layer: details/selection, all group combinations, virtualization extremes, and loading/failure scenarios. Full original criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved by layering.

<a id="文献标签筛选lit-tag-filter-cand-001需求版本待确认"></a>
### Literature tag filtering (`LIT-TAG-FILTER-CAND-001`; requirement version pending confirmation)

Historical user confirmation says the tag header filter supports search, multiple selection, and clearing; multiple tags use intersection, combine with current keyword/category filters, and retain existing literature selections. For the same authorized isolated library and project/global scope, use independent literature directory, tag associations, category, and selected-entry identities to verify single tag, multi-tag intersection, combined filters, clearing, and preserved selections. A visible filter popover does not prove correct results. Target-package applicability, adoption, product requirement version, and a real full-window screenshot with non-empty data remain unverified; pagination extremes, tag edits, and cross-platform behavior are separate scenarios.

Requires at least three distinguishable real imported synthetic records and two tags with an overlap plus non-overlapping members for each; independently record record/tag associations, query scope, and pre-filter selection set. Category combinations also require at least two distinguishable categories, independent record of actual literature associations, and result checks for category/tag/keyword combinations. Without category or real-association references, category combinations remain uncovered. The [three synthetic Bib records](../../../../../examples/projects/evaluation/files/sample.bib) can plan tag intersections; see [construction basis](./build.md). Planning and source files are not current product state. Import requires human confirmation. Creating tags/categories and their associations are writes; check isolation and authorization separately. Filtering and recording likewise require separate permission checks. Do not prepopulate a database or treat a bibliography file as imported state.

<a id="分类与标签管理及文献保留lit-taxonomy-cand-001需求版本待确认"></a>
### Category/tag management and literature retention (`LIT-TAXONOMY-CAND-001`; requirement version pending confirmation)

For synthetic records in an authorized isolated library, create a category and subcategory in a defined project scope, create a tag, and add specified records to each. Use an independent directory in the same scope to verify hierarchy, tags, record identities, and associations. On switching to another isolated project, verify that project's category associations are not mixed. Category scope and global tags are different concepts; creation/addition notices do not substitute for reading back associations.

Before deleting categories or tags, clearly show the impact. After each deletion, use independent before/after directories to verify the corresponding category subtree or tag association changes, while confirming that original literature entries and project associations remain. Tree, counts, and invalidated filters must match actual state. Deleting a category must not change other projects' category associations. Deleting a global tag must remove associations using it from both projects; do not require another project to retain a deleted tag. Cancellation, failure, duplicate names, moving, and restart recovery require separate confirmed criteria and cannot be inferred from a success notice. This candidate derives from the current Owner's asset-retention constraints; target-package entry points, applicability, requirement version, and adoption remain pending and are not automatically added to quick review. It is separate from the tag-filtering candidate above.

Requires at least two isolated projects and distinguishable imported synthetic records. Each project needs distinguishable category associations; the same global tag to be deleted must be used by distinguishable records in both projects. Independently record and read back associations before/after. If prerequisites are missing, cross-project category isolation or global tag-impact subpoints remain uncovered. Synthetic records may be used for planning, but files are not imported product data. Import requires human confirmation. Category/tag creation, record association, category deletion, and global tag deletion each require explicit authorization and impact scope; do not touch real user data. Target-version screenshots of creation, associations, delete confirmations, and complete terminal states are missing; empty-list references do not prove these actions.

<a id="文献批量元数据同步lit-metadata-batch-cand-001需求版本待确认"></a>
### Batch metadata sync (`LIT-METADATA-BATCH-CAND-001`; requirement version pending confirmation)

Historical user confirmation says multi-select actions support batch sync. For distinguishable imported literature in an authorized isolated library, trigger sync through the actual batch entry point and use independent source metadata plus before/after detail read-back for the same record identity to verify saved fields. Progress, notice, or task receipt alone does not prove fields were updated. Freeze field coverage and no-result, skipped, failed, canceled, and retry behavior separately according to their confirmed basis and data; do not infer approval from one historical observation or current source.

Real sync requires independently verifiable literature identifiers and sources, and authorization for network/external lookup and literature writes. A human must confirm bibliography import. Existing synthetic Bib/RIS files have no real DOI or arXiv identifiers and cannot stand in for data that can successfully match online. If authorized references are unavailable, retain the gap. Target-package applicability, product requirement version, and a real full-window screenshot are pending; Windows and other exception branches are separate.

<a id="文献导入附件阅读与项目关联候选专项"></a>
### Literature import, attachment reading, and project association (specialized candidates)

The following historical stable business points are candidate leads only. Their product requirement versions, applicability to the current target package, and inclusion in this run remain unconfirmed; they do not change adopted list-display criteria or automatically enter smoke tests. Historical revision numbers after `@` are not product requirement versions; see [construction basis](./build.md) for sources and adoption boundaries.

- **Local PDF import (LIT-IMPORT-PDF-01@3):** Import a verifiable synthetic PDF through Literature Center, then read the new entry and attachment from the real literature directory and match identity, verifiable fields, and attachment content to the input. Record the isolated library's pre-state and import target first. PDF metadata extraction may be incomplete; file presence or successful selection is not proof of import completion.
- **BibTeX/RIS import (LIT-IMPORT-BIB-01@4):** Use the bibliography import entry point and map each selected-file record to the imported independent directory fields. BibTeX and RIS are different formats; prepare and judge each separately and do not infer one format's result from the other. Freeze failure and format scenarios separately.
- **Open literature attachment (LIT-PDF-OPEN-01@1):** Open an available PDF attachment from an existing literature item; verify target literature, attachment, and original identity, and that target-page body text and text layer are visible/selectable in the reader. Opening a PDF from the project files tree is not a substitute for this literature attachment flow.
- **Associate with a project (LIT-JOIN-PROJECT-01@5):** Start with existing literature and a target project. After authorized association, read the same literature item from the independent project directory; verify scope and that other project associations were not incorrectly rewritten. Adding to a category is not project association, and list display does not prove the association action completed.

Import requires human confirmation. Separately confirm authorization for the isolated library, synthetic input, project, independent before/after directory, and writes. Reusable inputs: [synthetic Bib records](../../../../../examples/projects/evaluation/files/sample.bib), [synthetic RIS records](../../../../../examples/projects/literature-ris/files/sample.ris), and [synthetic PDF](../../../../../examples/projects/evaluation/files/sample.pdf) in the shared evaluation project. Use actual input digests and verifiable content as references; file preparation is not successful import. Check selectable PDF text and metadata preconditions on each run. Existing page references show only global or project empty states. No real full-window target-version screenshots have been verified for import results, attachment reading, or project association; empty states, component fixtures, and synthetic images are not substitutes. If real authorization, data, or confirmation evidence is insufficient, retain the gap and do not claim the complete flow passed.

<a id="文献交付到项目资料库待确认"></a>
### Deliver literature to project files (pending confirmation)

The historical folder-delivery card has been retired and must not be reproduced. No equivalent entry point or requirement for saving a literature attachment into project files has been confirmed for the target version, so retain this gap and do not include it in adopted criteria. Adding research results to the literature library, adding metadata only, or attaching an existing full text to a literature item is not the same terminal state as creating a file in project files; these cannot substitute for one another.

If this flow is later confirmed, first define the target project/directory, same-name behavior, and permitted write scope. Then use an authorized isolated project and synthetic attachment, independently read the target file from the files directory, and compare source identity/content; check original and conflict pre-state when relevant. A success notice or literature-library item is not proof that the file was saved. Entry point, exact outcome, authorization, and a real full-window target-version screenshot all remain unconfirmed; historical partial images and screenshots of other pages are not substitutes.
