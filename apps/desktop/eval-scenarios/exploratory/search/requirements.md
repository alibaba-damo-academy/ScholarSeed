<a id="全局搜索"></a>
# Global Search

Search-results reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; shows results from a synthetic resource query only, not all categories, the empty state, or an error state.

Synthetic-resource search results in the target version

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-13; shows search hits for synthetic files in the current project; the background window is narrow. The image alone does not prove the open action or other categories. See [build evidence](./build.md).

Document opened from synthetic-resource search results

Reference: macOS arm64, 0.3.2 / 202611121823 / preview, 2026-11-12; shows the opened synthetic target for GSEARCH-006. The image alone does not prove the relationship between the search and open actions or a hit in literature or conversation. See [build evidence](./build.md).

Verified normal unified search, result display, and open behavior has been adopted as v`0.3` requirements. The unverified entry/scope-without-a-project in 001, and first-search loading and failure feedback in 007, remain unconfirmed; this does not approve scope fallback or failure shown as an empty group.

Find resources, literature, or conversations from the work area and open the corresponding target. Semantic entries are the workspace search button and search entry in project navigation. Actual reachability must be observed with authorization; opening search through internal state is not a substitute for the real entry.

<a id="输入与查看结果"></a>
## Enter a Query and View Results

<a id="入口模式与范围gsearch-001--v03"></a>
### Entry, mode, and scope (GSEARCH-001 · v`0.3`)
Fixed and conditional: The current normal entry opens unified search for resources, literature, and conversations, with a query field. Escape in the field or clicking the overlay closes it. The normal UI entry for file-only mode is not verified, so entering that mode is not an established requirement. Dynamic: project scope comes from the current project. The literature view uses its literature-project filter. Without a project, search fallback to the default project and cross-project display of recent files remain unresolved; do not interpret the word “global” as automatically searching every project.

<a id="空查询与最近文件gsearch-002--v03"></a>
### Empty query and recent files (GSEARCH-002 · v`0.3`)
Dynamic: An empty query shows recently opened files, up to five according to the current scope and valid project reference. File name, project/path, and opened time match the authorized recent-record reference; time is displayed according to the client's language and time zone. If there are no records, show an empty state; five items are not required. A recent record does not mean the file is still openable.

<a id="分组结果与空组gsearch-003--v03"></a>
### Grouped results and empty groups (GSEARCH-003 · v`0.3`)
Fixed: Unified results are grouped into resources, literature, and conversations; each group shows results or its own empty state. Dynamic: Titles and applicable subtitles match public hits for the same query and project scope. The query is trimmed only at the beginning and end; it must not be described as removing all spaces within the query. Every group need not have a hit for every query.

<a id="数量更多与截断gsearch-004--v03"></a>
### Counts, More, and truncation (GSEARCH-004 · v`0.3`)
Dynamic with lightweight interaction: Each group count matches the public count. If results are marked truncated, show a plus sign; do not present the returned window length as the total number of matches. Initially show at most three items per group; each More action adds at most ten, until the returned window has been displayed. If the window remains truncated, show a corresponding notice. More does not mean all results in the library have been fetched.

<a id="命中高亮与可读性gsearch-005--v03"></a>
### Hit highlighting and readability (GSEARCH-005 · v`0.3`)
Dynamic: Query fragments that actually occur in result titles and subtitles are highlighted in non-overlapping, case-insensitive ranges while preserving original letter case. Do not fabricate highlights when no corresponding fragment exists. Titles and summaries/paths must distinguish the target. Truncated long content must not be presented as the complete original text.

<a id="打开与更新"></a>
## Open and Refresh

<a id="打开目标与关闭搜索gsearch-006--v03"></a>
### Open a target and close search (GSEARCH-006 · v`0.3`)
Dynamic and conditional: Clicking a resource hit opens the corresponding resource and carries over location information when body positioning is available; a literature hit opens the corresponding detail; a conversation hit opens the corresponding panel and, when applicable, message location. Search then closes. Results must match the hit identity and project scope in this run; successful clicking is not proof of the actual target state. Execute only when reading target content and recent-access changes are authorized; navigation does not prove editing, model, or task behavior.

<a id="查询更新与异常边界gsearch-007--v03"></a>
### Query updates and error boundaries (GSEARCH-007 · v`0.3`)
Dynamic and conditional: After changing the query or scope, use results for the new query; an old response must not overwrite them. A new query restores each group's initial display count, and after new results arrive, the result area returns to the top. First-search loading feedback and the distinction between a read failure and a genuine zero-hit result remain unresolved semantic/implementation gaps. Do not approve failure displayed as empty groups, and do not declare product nonconformance directly from current source.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

Adopted normal branches of the seven items belong in automatic quick review. Unclear entry points, scope without a project, and error notices remain unconfirmed; state adoption evidence before freezing. Basic data requires authorized synthetic resources, records, and distinguishable projects. Select recent files, More, truncation, and conversation positioning only when their real-data prerequisites are met. If conditions are missing, record them as uncovered; do not lower requirements to force a pass.

Search may read resource content and conversation snippets; do not assume that it searches only file names because no result was clicked. File viewers, literature editing, conversation execution, model calls, and full cross-project permission checks are separate specialties; this page does not duplicate their business criteria.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are GSEARCH-001, 003, 005, and 006. This covers only the scope below and does not mean every detail of these IDs passes.

Only after independently verifying the current task project scope, search a known synthetic file name through the normal unified-search entry. Check its resource group, visible hit, and the identity of the opened target. This representative action checks only normal opening of one known resource. The known file name/relative path is the reference; an arbitrary hit is not necessarily the correct target.

Required references: current task project registration and the actual path/digest of an isolated copy of the [Markdown source sample in the evaluation project](../../../../../examples/projects/evaluation/files/sample.md). If scope cannot be verified, stop this action with an evidence gap; do not self-approve it.

<a id="专项层"></a>
## Specialized Layer

Not selected in this layer: file-only entry/global fallback/literature scope in 001, recent files, all result-group pagination, the full highlighting matrix, and failure/first-search transient states in 007. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved merely by this layering.
