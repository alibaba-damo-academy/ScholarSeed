<a id="文献分类与项目作用域"></a>
# Literature Categories and Project Scope

Read this page when changing the literature category tree, project navigation, categorization, or category/tag deletion. It records current Owners, necessary decision rationale, and verification constraints; do not treat an old proposal's implemented/active status as today's acceptance result.

<a id="owner-与身份"></a>
## Owners and Identity

- [Literature storage](../../apps/serve/service/literature/persistence/store.py) owns categories and literature associations. The [Catalogue API](../../apps/serve/service/literature/api/catalogue.py) validates project scope and projects navigation data.
- Content owns project identity and the live project directory. Literature stores stable project IDs; it does not copy project names or paths, maintain a second project registry, or delete projects in the literature domain.
- Literature metadata can be reused across projects, while category relationships are isolated by scope. An empty project scope means a global category. Parent and child categories must share a scope, and reparenting must reject cycles. Category IDs and names are not project identities.
- Desktop callers such as [Collection](../../apps/desktop/src/renderer/src/features/literature/Collection.tsx) consume this protocol. Write targets must explicitly include the project/category parent; permissions must not be inferred from the current list filter.

<a id="导入条目身份与操作重放"></a>
## Imported Item Identity and Operation Replay

`new_item_id` in the [identity definition](../../apps/serve/service/literature/schema.py) is a UUID, and [bibliographic conversion](../../apps/serve/service/literature/service/metadata.py) generates a new identity. [Appending to the catalogue](../../apps/serve/service/literature/service/catalog.py) does not merge existing items by DOI, title, or byte digest. Item identity locates a row; it does not determine duplicates. Reimporting must not overwrite user-edited bibliographic metadata, categories, tags, or notes. The [store](../../apps/serve/service/literature/persistence/store.py) still updates an existing row by primary key for explicit edits/view write-back; the presence of upsert does not mean imports deduplicate.

`operation_id` in [import orchestration](../../apps/serve/service/literature/service/importer.py) identifies one recoverable operation: retrying with the same explicit operation ID can read back the old receipt; when omitted, a new operation identity is generated. A content fingerprint binds the source and must not automatically become the operation ID, or reimporting the same file could be mistaken for replaying an old operation. Search-result deduplication, item append, operation idempotency, and attachment file identity are separate concerns. See [attachment asset boundaries](selections.md#托管附件删除与翻译输入故障) for exclusive attachment copies and historical shared-path restrictions. An old proposal's promise to clear the database does not authorize clearing or migrating it now.

<a id="导入落点与列表更新"></a>
## Import Destination and List Updates

The [Catalogue state Owner](../../apps/desktop/src/renderer/src/features/literature/catalog.ts) derives the destination from an explicit project/category filter. “Uncategorized” is not a category and must not carry a category ID; tags do not affect the destination. The backend still validates actual scope, and a UI selection does not substitute for authorization. The persistent panel imports through a state request consumed by the remounted list; it does not rely on DOM event listeners from an unmounted page.

After a successful import, `imported` invalidates the list/panel/tag caches once and updates reload. [LiteratureList](../../apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx) also clears the query input and tag filter so an old debounced search cannot write back. This refresh method does not reset all sorting or pagination, so do not carry forward the old proposal's guarantee that “all new literature immediately appears on the first page.” Verify the destination, filters, pagination, counts, list visibility, and actual persistence separately; a successful refresh does not prove the data was stored.

<a id="文献-pdf-文件拖放"></a>
### Dragging and Dropping Literature PDF Files

The literature list's [file drop entry point](../../apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx) intercepts a drag only when `hasDraggedFiles` is true, so dragging a table column is not mistaken for an import. Nested enter counts maintain the highlight. On drop, the implementation reuses the project/category destination derived from the current query and the per-file results from `importPdfFiles`.
Each file succeeds or fails independently. Old search and tag filters are cleared and the catalogue refreshed only if at least one file was imported. Closing the import results must not navigate away from the literature page. When changing this behavior, check the [list contract](../../apps/desktop/src/renderer/src/features/literature/list.test.ts) and [real Electron drop case](../../apps/desktop/e2e/literature-drop-workbench.spec.ts), observing the empty state, mixed files, project scope, and native file drop separately. Old screenshots do not prove the current build.

<a id="题录元数据批量同步"></a>
## Batch Synchronization of Bibliographic Metadata

The [batch work set](../../apps/desktop/src/renderer/src/features/literature/batch.ts) belongs to the Desktop Renderer process. [Synchronization wiring](../../apps/desktop/src/renderer/src/features/literature/synchronization.ts) reuses the single-item `papermeta` query, literature update API, and per-item exclusion in `literatureTasks`. The backend has no separate batch task or restart recovery. Closing the progress dialog or unmounting the literature list does not terminate the in-process work set; it is not retained when the application exits.
Selected items are processed one at a time using the captured project scope. Batch mode automatically writes back only unique identifier lookups by DOI/arXiv. A fuzzy title match requires individual confirmation; entering batch mode must not bypass confirmation or overwrite user edits.
Requests are serialized with an interval. A quota error defers items that have not started. Cancellation prevents only not-yet-started items; already-issued queries and saves must finish. Failed, quota-limited, deferred, and cancelled items can be explicitly retried; successes and misses are excluded from the retry set.

When changing this behavior, first check the [batch contract](../../apps/desktop/src/renderer/src/features/literature/batch.test.ts) and [papermeta contract](../../apps/serve/tests/contract_literature_papermeta.py), then use a real Desktop to observe mixed DOI/arXiv/title cases, persistence, 429 responses, in-flight saves after cancellation, closing and reopening the panel, and scrolling in a narrow window. Old screenshots and the former four samples do not prove that the current build or Windows has passed.

<a id="为什么复用分类表"></a>
## Why the Category Table Is Reused

Global and project categories share the tree, CRUD, and literature-association mechanisms, with scope added rather than a second project-category service. Project navigation first reads Content's live project dimension table and then aggregates Literature relationships, so empty projects and renamed projects are projected correctly. The project list is not inferred from the current literature page or paginated results. Invalid project relationships are excluded from this navigation, but hiding them on read does not authorize deleting historical relationships or restoring projects.

The current unique index prevents sibling categories from sharing a name within the same scope and parent, using `COALESCE` for empty scope/root nodes. Do not restore the old description that “two partial indexes restrict duplicate names across the entire scope”; SQLite `NULL` semantics also cannot be inferred from a plain `UNIQUE(project_id,name)`. Check the store declaration and actual schema when changing the index.

<a id="删除与资产保留"></a>
## Deletion and Asset Retention

The current `delete_collection` selects roots by scope, recursively lists the subtree in that scope, and deletes categories from the deepest node upward within a transaction. Category associations are removed according to their foreign-key semantics; literature items are not deleted. `delete_tag` removes tag associations, not the literature itself. The deletion impact must be clearly shown before the destructive action; after success, filters, the tree, and counts must be invalidated consistently. A deletion function in code does not prove that the real UI confirms correctly or retains assets on every failure path.

The old development-time statements “users delete the old database” and “do not run ALTER” are not current authorization for operations. The current store has named checks for the schema, known old indexes, and the incremental notes field. Migrations must protect user assets according to the actual Owner and [persistence constraints](../architecture/persistence.md); do not rebuild the database or clear categories because of a documentation migration.

<a id="验证选择"></a>
## Verification Selection

First locate the [store contract](../../apps/serve/tests/contract_literature_store.py) and the actual API contract entry point. With an isolated database, verify global/A/B category isolation, duplicate siblings, rejection of cross-scope parent/child relationships and cycles, subtree counts and filtering, retention of literature and other project relationships after category/tag deletion, rejection of unknown projects, and asset retention after restart. Table existence or a health endpoint alone does not establish that the business behavior passed.

A real Desktop run must also create nested categories, switch projects, filter, confirm parent-category and tag deletion, and check that literature remains. Capture mouse/keyboard behavior, themes, errors, and invalidated filters separately. This knowledge-governance task does not run this product flow; leave acceptance status explicit if it has not been performed.
