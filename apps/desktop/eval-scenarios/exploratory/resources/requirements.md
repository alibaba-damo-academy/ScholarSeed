<a id="资料树与列表"></a>
# Resource Tree and List

Project Explorer open-mode menu

Reference: macOS arm64 `0.3.2 / 202611121823 / preview`, 2026-11-13; open-mode menu in a synthetic-file preview in an isolated project. The breadcrumb is partly truncated in the narrow panel. No item was selected; this does not prove an opened terminal state.

Expanded deep-directory state in the Project Files resource list

Collapsed deep-directory state in the Project Files resource list

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; shows two levels of directories in the Project Files resource list of an isolated project. Screenshots alone do not prove the action or sidebar-tree behavior.

Project resource-list reference for target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; shows the resource list for an isolated synthetic project with `notes` expanded. It does not prove file adoption, writes, or other specialty actions.

Project resource-tree reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; shows only the synthetic resource tree and expanded state, not file operations or abnormal branches.

Verified normal resource browsing, expansion, refresh, and filtering have been adopted as v`0.3` requirements. Failure, invalidated/conflicting associations, and subpage failure feedback in 007 remain unconfirmed; this does not approve silent failure or a failed empty state.

Browse resource directories in the current project, expand levels, and view the resource list. Semantic entry: the project workbench resource tree and Project Files area → “资料”. Visible levels and reachability must be verified by authorized page observation.

<a id="浏览项目资料"></a>
## Browse Project Resources

<a id="项目与资料入口res-list-001--v03"></a>
### Project and resource entry (RES-LIST-001 · v`0.3`)
Fixed and conditional: The resource tree and list correspond to the currently visible project; the resource list is distinguishable from literature and task-artifact areas. Local file search in the tree is not currently open. The list-name query entry remains visible. Check global discovery only as an entry display, not as local search or task submission.

<a id="树节点与层级res-list-002--v03"></a>
### Tree nodes and hierarchy (RES-LIST-002 · v`0.3`)
Dynamic: Visible file/directory names, hierarchy, and applicable icons match the same project's public resource tree. Associated resources and Git directories are distinguished by metadata. If a directory count appears, it is the total direct children, not all descendant files. If a version-policy marker appears, it matches that node's public policy state. Do not infer viewing, editing, or version capability from an icon or extension.

<a id="展开与全部折叠res-list-003--v03"></a>
### Expand and collapse all (RES-LIST-003 · v`0.3`)
Dynamic with lightweight interaction: Expanding a directory shows its children; collapsing hides descendants of that level. The tree and list share the current directory expansion state. Collapse All closes expanded directories; when none are expanded, that entry is disabled. Closing a directory is not deleting a resource.

<a id="加载更多与刷新res-list-004--v03"></a>
### Load more and refresh (RES-LIST-004 · v`0.3`)
Conditional: When more children remain unloaded at the root or in an expanded directory, the Load More entry and remaining count match the public total and items loaded at that level. After loading, the correct next entries continue without duplicates or omissions. Refreshing the same project uses current directory data. Expanded directories that still exist and can be located remain expanded; the root and those directories restore their previously loaded ranges. When data shrinks, stop at the current total; do not retain deleted items or promise to restore all cached contents of collapsed directories. Empty data does not pass pagination.

<a id="查看资料列表"></a>
## View the Resource List

<a id="文件与目录展示res-list-005--v03"></a>
### File and directory display (RES-LIST-005 · v`0.3`)
Dynamic: List name, type, source, and update time match the same project's complete public list. Directory type, unknown source, and missing update time have appropriate fallbacks. Relative time/date display uses the public timestamp at second precision and the client's current time, language, and time zone. Long names remain readable; the currently collapsed row count is not the total resource count.

<a id="列表查询筛选与排序res-list-006--v03"></a>
### List query, filters, and sort (RES-LIST-006 · v`0.3`)
Dynamic with lightweight interaction: Search the list by file/directory name, ignoring case and leading/trailing spaces. Type/source filters match the current public list. Sort update time within sibling nodes at each level, placing missing times last; do not flatten-sort the entire tree. Combined filters preserve the paths of matching items. Clearing restores the corresponding list. A no-match notice does not prove document-content search, global search, or task execution.

<a id="加载空态与不可用res-list-007--v03"></a>
### Loading, empty state, and unavailable data (RES-LIST-007 · v`0.3`)
Conditional: Distinguish initial loading, a successfully empty directory, and a read failure for the whole list. When resources exist, do not present an empty state; show applicable entries when the list is empty. User notices for invalidated/conflicting associated roots or subpage read failure remain an unconfirmed semantic gap. Do not approve silent failure or an empty-directory presentation as correct; these unconfirmed branches do not make this item a complete pass.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

Adopted normal branches of the seven items belong in automatic quick review, for explicitly selected projects and natural branches. The 007 notices remain unconfirmed until there is an adoption basis; do not narrow requirements after execution. Non-empty, deep-tree, and pagination cases require authorized data with distinguishable resources, multiple directory levels, and more than one page at a level respectively. If prerequisites are missing, keep the scope uncovered; do not substitute an empty state.

Basic synthetic resources are in the [shared example project](../../../../../examples/projects/evaluation/project.json); its four Markdown/text files and nested directories can be used here. Use this run's receipt for preparation status. They do not provide a complete data set for pagination, associations, or abnormal states.

The `pages` directory in the [synthetic pagination input](../../../../../examples/projects/resource-pagination/project.json) contains 101 distinguishable same-level files, `item-001.md` through `item-101.md`, for preparing the RES-LIST-004 resource-tree continuation specialty. Static target-package evidence for a single page of 100 is in the build record. Independently freeze the actual project, directory, paths, and total; compare real before/after continuation states. Do not mix extra nodes or associated roots into the reference. File existence does not mean the data is prepared, imported, or pagination passed. The preparation tool has not actually run this project. Verify the isolated target and authorization separately for human-confirmed import and product UI actions. If prerequisites are missing, keep the case uncovered.

File opening/viewers, create/import/rename/move/delete, associated-root management, content search, global tasks, and version operations are separate specialties. Tree expansion, filtering, and refresh on this page do not pass those business actions.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are RES-LIST-001–003, 005, and 007. This covers only the scope below and does not mean every detail of these IDs passes.

The resource entry belongs to the current project. Names, hierarchy, and types of known synthetic directories/files are identifiable; a normal non-empty state is not misreported as empty. Expand the prepared `notes` directory once to show its direct children; do not substitute deeper descendants for direct children.

Required reference: authorized isolated copy of the shared example project, input digest, and project identity/relative-path inventory frozen after preparation. Check only the selected directory, not unknown roots. Data preparation is not an import test; a human confirms import tests.

<a id="专项层"></a>
## Specialized Layer

Not selected here: pagination, refresh, all filters/sorts, loading transients, failure/empty-root/association invalidation, and writes; do not run the old collector. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved merely by this layering.

<a id="项目文件分类切换与布局保持res-library-category-cand-001需求版本待确认"></a>
### Project-file category switching and layout preservation (`RES-LIBRARY-CATEGORY-CAND-001`; requirements version to be confirmed)

Historical user requirements say that switching among Resources, Literature, and Task Artifacts in Project Files changes only content and preserves the current workbench layout. For one authorized isolated project, independently record existing split view, workbench tabs, and selected category; then switch among the three categories and check layout preservation and the project scope of displayed content. An empty category verifies only its corresponding empty state, not correct non-empty data. For non-empty categories, use independent records of real same-project resources, literature, and task-artifact identities; a category title or expected list is not proof of actual content.

This is a bounded exploratory candidate. It does not change `RES-LIST-001` or automatic smoke inclusion. Target-package applicability, requirements version, and real complete-window images for each category remain to be verified. Category switching may update isolated workbench tab state and clear selected items; it is not a zero-side-effect operation. Confirm data preparation and human-performed import separately. Real task artifacts, model calls, and writes require separate permissions. Failure, cross-platform behavior, and other layout changes are separate specialties.

<a id="项目资源管理器文件名搜索res-explorer-search-cand-001需求版本待确认"></a>
### Project Explorer filename search (`RES-EXPLORER-SEARCH-CAND-001`; requirements version to be confirmed)

Natural Project Explorer state in the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; full window showing a newly opened Project Explorer, file tree, and collapsed directory, with a narrow split view of a synthetic document on the right. This is an entry/natural-display reference only; it does not prove search, file opening, or adoption of the candidate.

Project Explorer search-results reference

Project Explorer with a searched file open

Reference: same target version, 2026-11-13; sequential views of filename search results for an isolated project's synthetic file and the same file's body after opening. These are natural observations, not formal adoption or evaluation decisions. They do not prove clear/reset, other match semantics, failure, or pagination. The synthetic-document split view on the right is narrow.

Project Explorer after clearing search

Reference: same target version, 2026-11-13; after clearing search, shows the project root and a collapsed `resources` directory, whose files were not expanded and checked. Natural observation only; see [build evidence](./build.md).

Historical user screenshots involve a “Find File” entry in the Project Explorer file tree. Historical source notes describe the candidate behavior: search filenames in the current project, display result names and relative paths, allow opening, and restore the directory tree when cleared. Use a synthetic filename and relative path recorded beforehand in an authorized isolated project, plus the identity of the opened file, as independent references. An entry or result display alone does not prove the target file opened. The target-package full-window images cover only the displayed states. Full directory contents after clearing, other matches, failures, and pagination remain missing. Confirmation status for detailed matching/failure semantics and target-package applicability remain to be checked; source code does not automatically approve them.

This candidate concerns a new-tab Project Explorer in the workbench. It is distinct from the resource-library sidebar tree in this page's `RES-LIST-001` and global search F3. It does not change the existing criterion that local search in the sidebar tree is unavailable, and filename search is not content search. Use a synthetic directory, known file, and path in the same project; verify search/open against isolation scope and permission. Pagination limits, external directories, and cross-platform behavior are separate specialties.

<a id="项目资源管理器打开方式res-explorer-open-cand-001需求版本待确认"></a>
### Project Explorer open mode (`RES-EXPLORER-OPEN-CAND-001`; requirements version to be confirmed)

Historical user-confirmed screenshots require the current open mode to consist of a primary button and dropdown menu. The menu distinguishes system reveal from opening in a new tab and marks the current selection. With an authorized isolated project and identifiable synthetic file, first observe the menu only. In current source, selecting a menu item changes the mode and immediately performs system reveal or opens a tab. Before selection, independently confirm permission and terminal reference for each action; do not treat menu selection as a preference-only change. Historical source notes that an in-project tab remount retains the in-memory selection state; that state semantics and target-package applicability remain to be verified. A menu checkmark does not prove the file opened. Use same-file identity and actual workbench tab or system-reveal outcome. If opening is not authorized, observe only and select no menu item.

This candidate is distinct from filename search. It requires an isolated project and identifiable original file; system reveal and target opening require separate host-capability checks and authorization. Target-version applicability, requirements version, opening-outcome screenshots, and cross-platform results remain to be verified. Persistence after process restart is not promised; component regression tests do not replace real product interaction.

<a id="资料接入与管理候选专项"></a>
## Candidate Specialties: Resource Import and Management

The following items are organized from [historical frozen sources](./build.md#资料接入与管理候选resources11). They are exploratory candidates; product requirements version, target-package applicability, and adoption status remain unconfirmed. They are outside the adopted quick review and smoke denominator above. The `@` suffix is a historical business-point asset revision, not a product requirements version. Verify authorization for each entry and action separately; preparing data is not a real import.

<a id="目录接入与原件保护"></a>
### Import directories and protect originals

- **Copy-import a directory (historical `RES-COPY-DIR-01@3`):** Manually select an authorized synthetic directory through the actual import entry. The target project contains a copy with relative hierarchy and file bytes matching the independent original; the original directory is unchanged. A success notice, picker echo, or pre-positioned files cannot replace the real result.
- **Associate an external directory (historical `RES-LINK-DIR-01@3`):** If the target version provides association mode, the authorized isolated external directory is readable from the resource library and its scope matches the original, without copying or deleting the original. Historical entry/current target mapping, permissions, and original-protection semantics remain to be confirmed.

<a id="同名冲突与资料保留"></a>
### Name conflicts and resource preservation

- **Import with rename (historical `RES-CONFLICT-RENAME-01@4`):** For a synthetic file whose name already exists in the target with different contents, if Import with Rename is selected, the original content stays unchanged and the new file can be read back under a distinct name. Independently record both inputs and result identity/digests.
- **Versioned replacement (historical `RES-CONFLICT-REPLACE-01@4`):** Only when the target package and conflicting item support versioned replacement and write authorization is granted, the new content becomes current and the old content remains readable in version history. This candidate does not assume all files/environments support replacement, and a dialog choice is not a persisted terminal outcome.

<a id="创建与整理"></a>
### Create and organize

- **Create directory and Markdown (historical `RES-CREATE-FOLDER-01@3`, `RES-CREATE-MD-01@4`):** Create the corresponding object in an authorized isolated project and target directory. The new directory expands and remains after refresh; a document opens/edits and remains readable after refresh. Importing an existing Markdown file is not a create test.
- **Rename and move (historical `RES-RENAME-01@4`, `RES-MOVE-01@4`):** Perform the action through the real product entry on an authorized disposable file. New path and content match independent records, and the old path no longer appears after moving. Move entry, cross-directory conflicts, and target-package capability remain to be checked; do not substitute direct filesystem operations for the real UI.

**Data and screenshot gaps:** Select directory samples from the [shared example project](../../../../../examples/projects/evaluation/project.json). Before execution, record the original and isolated-copy relative paths, digests, and project identity. The [synthetic same-name inputs](../../../../../examples/projects/resource-conflict/project.json) separately provide isolated target pre-state and later human-confirmed import; do not pre-create a conflict or handling result. Prepare and authorize external association roots and version history separately; do not treat old fixture paths as current inputs. A human confirms import tests; creation, move, replacement, and data recovery each require their own authorization. No target-package complete-window images for these operations have a verified source. Existing resource-tree images show browsing only; they cannot count as specialty passes or replace screenshots.
