<a id="全局搜索需求构建依据"></a>
# Global Search Requirements Build Basis

<a id="隔离资料准备边界search14"></a>
## Isolated-Resource Preparation Boundary: search/14

The unimported state in the historical “Data and Side-Effect Boundaries” below belongs to the original baseline-building record; it is not a requirement to import through the UI in every later run. Current resource search may use an authorized copy of `examples` prepared in an isolated project; verify its identity from this run's receipt, project path, and file digest. Preparing data does not mean search was run or passed, and does not automatically authorize new product writes. The literature domain still requires real imported literature and an independent reference from the same scope; a Bib file alone is not a substitute. Import is not evaluated this round at the user's request. Original criteria, historical freeze, and results are unchanged.

<a id="目标版本搜索结果参考图search13"></a>
## Target-Version Search-Results Reference: search/13

`results-20261113-1823.png` is a copy of the real complete-window image from an isolated macOS arm64 installer instance `0.3.2 / 202611121823 / preview` on 2026-11-13. Target ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`; image SHA-256 `fb121f9cd85a2593bea83f9b1e87334a8326b7c686b7946459e3d08d4cda91c7`. The original image is `tmp/test_snapshot/desktop/baseline-1823-recheck-20261113/driver/evidence/f3-search.png`; the ignored original run and independent review are available only locally. It shows a hit for synthetic resources; it does not independently prove the open action or other categories. Requirements version, criteria, and historical results are unchanged.

<a id="需求与运行进度分离search12"></a>
## Separate Requirements from Run Progress: search/12

The blanket historical “not tested at all” status was removed from the requirements body. Run progress and per-run results are recorded in the scenario index and run records; stable IDs, requirements version, adopted scope, special-scope boundaries, and historical freeze are unchanged. The reference-image caption's capture date is completed below from its existing source.

<a id="打开目标参考图补充search11"></a>
## Additional Open-Target Reference Image: search/11

`open-result-20261112.png` is a copy of the real page image showing `sample.md` opened in an isolated macOS arm64 installer instance `0.3.2 / 202611121823 / preview` on 2026-11-12. Target ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`; image SHA-256 `b7fce64d6f133019af5d01ca1eff5335fef7c16de98b3c4f573bb0944b9a52b0`. The original is `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f3-open.png`; ignored run evidence is available only locally. The image shows the target document; it does not independently prove the relationship from search to opening or other categories. Requirements version, criteria, and historical results are unchanged.

<a id="共享输入链接修正search10"></a>
## Shared-Input Link Correction: search/10

Resource and citation links now point to byte-identical shared `examples`; see the [resource build basis](../resources/build.md) and [literature build basis](../literature-list/build.md) for the original copies and source commits, respectively. This corrects references only and does not change requirements, criteria, or historical results.

<a id="f3-普通搜索路径沿用依据search9"></a>
## Basis for Reusing the Normal F3 Search Path: search/9

For macOS arm64 `0.3.2 / 202611121823 / preview`, reuse the unified adoption rule confirmed by the user on 2026-10-30 and the adopted normal subcriteria in `search/4`: within the verified current-project scope, query for a known synthetic file, verify a resource hit, and open that target. Existing adoption and subsequent revisions on this page were checked; no record was found confirming that this sub-scope was retired or changed. No-project fallback, file-only entry, errors, and other search scopes remain unconfirmed in the original text or separate special-scope work. Original IDs, v`0.3`, criteria, and old runs are unchanged. A new run must still verify project registration, sample, and independent references; an independent review judges the evidence. This record does not determine product acceptance. The target-applicability status described in `search/8` below referred to the earlier point before this bounded reuse analysis was complete.

<a id="共享示例输入对齐search8"></a>
## Align Shared Example Inputs: search/8

This revision only specifies the current quick-review input as shared project `evaluation/document`; use this run's preparation receipt to verify project identity, path, and digest. On 2026-11-12, `examples/projects/evaluation/files/sample.md` and the original `research/document` were checked to have the same SHA-256 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`. Identical content does not make the two project identities the same, and an old receipt cannot be reused as registration of the new project. Original stable IDs, requirements version, criteria, and historical results are unchanged. Target-package applicability still needs independent verification; this revision does not claim product acceptance.

<a id="当前参考图修订search7"></a>
## Current Reference-Image Revision: search/7

`reference-20261112.png` is an unmodified copy of `evidence/search-results.png`, the original image from an isolated macOS arm64 installer instance `0.3.2 / 202611121104 / preview` on 2026-11-12; SHA-256 `e9e5f4923f8fdfe928e83c67af94c4a65663fe5174c426e24145faed5b8a8e2d`. It shows only the synthetic-resource query state, not all categories or error states. Original run: `tmp/test_snapshot/desktop/release-20261112-fresh/`. Requirements and historical decisions are unchanged.

<a id="历史修订共享示例项目输入接线search6"></a>
## Historical Revision: Shared Example-Project Input Wiring (search/6)

Asset revision `search/6`. The wiring and state for `research/document` at that time are preserved; current input is specified in `search/8`. This update only maintains input sources, preparation receipts, and execution wiring. Requirements remain v`0.3`; GSEARCH stable IDs, the release quick-review sub-scope, and all old decisions are unchanged. The installer analyses below are each historical sources, not source/build identity for new code. This revision did not start the product or perform Skill-host acceptance.

The first shared-data consumption path is normal project-scoped global search → open a known Markdown file. It does not include Find Next, editing/saving, conversation/model, cross-project, or pagination special-scope work. Original Markdown bytes were moved to the [shared original](../../../../../examples/projects/research/files/sample.md), referenced by the [project definition](../../../../../examples/projects/research/project.json); file identity is `research/document`. Obtain the actual product path from this run's preparation receipt; do not fix a template path or old project ID.

Reuse the public resolver and real project-preparation capability; the procedure owns the flow. Freeze the selected data, `contentDigest`, source commit/dirty input identity, actual target package/instance, project key/id/root, and document `path`/`relativePath`/`sha256`/`size`. First verify the unique owned instance, real API base URL, and isolated workspace ownership. Prepare source resources only; do not pre-run the evaluated search/open or write MRU.

Independent references include the source-file digest, publicly registered current-project identity, and known relative resource location. A public search API hit for the same query and project can supplement comparison, but cannot be the sole identity evidence when also reading the page under evaluation. Do not put hidden criteria or references in the product directory or Driver inputs; give Driver only the task location it needs. If preparation fails, preserve the original error and partial receipt; do not resubmit a create mutation or disguise it as an empty result. Only static wiring is complete so far; real preparation, UI terminal state, host transcript, and independent Judge result still require later verification in an authorized resource window. Do not claim a pass based on historical screenshots.

<a id="历史修订202610301343包内静态复核"></a>
## Historical Revision: In-Package Static Review of 202610301343

Asset revision `search/5`; this update only adds the specified new package source, input/independent references, and quick-review boundary. Preserve original stable IDs, v`0.3`, adoption rules, full text, reference-image source versions/dates, and historical results. The old sources and revision records below are historical and do not establish package binding or a conclusion for this run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. The source is the actual installer and loose renderer payload extracted for this task; source commit is unknown. The current checkout/remote HEAD may help locate code but does not establish source identity. The evidence manifest is in ignored directory `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`; in-package locations are relative to its `package/` root. Do not treat the temporary extraction directory as a permanent cross-worktree asset.

In-package `out/main/index.js`, SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: at 1338, `applicationRenderer` uses the renderer under `applicationResources` when packaged; the no-development-URL branch at 41203 delegates to `serveAssets`. This chain is tied to the actual loose payload analyzed here; it does not prove that runtime has no development override or turn a static entry point into a product observation.

- `renderer/assets/index-CddcCmKt.js`: SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`.

In-package `index:86826`, `searchEverything` reads `/api/search` hits/groups. `GlobalSearch` at `86901` uses `query.project_id` for literature and `homeSelectedProjectId` for other scopes; queries are delayed by 240 ms and generation/abort prevent stale results from overwriting current ones. The three fixed domains, dynamic highlighting, and opening flow remain. Select only normal global search in a known project and one resource result; do not promote `files` or no-project fallback to requirements. Before execution, record the project ID, source-sample digest, actual imported relative path, and query. An API hit and the evaluated UI are not the only answers to input identity. Errors may still be collapsed into empty hits; retain the unconfirmed semantics of 007 and do not approve an error as a normal empty state.

Samples in the requirements body refer to authorized isolated copies of repository originals. Before execution, record the mapping from original digest to task project ID and actual path after import; historical `eval-*-20261030` names are old run aliases and must not be assumed to exist in a new installation. Project/resources, column preferences, and minimal API projections still require independent evidence authorized for this run. Static compatibility does not prove that the normal UI is reachable or passed in a real run. This run did not start, connect to, or operate the product, read user state/credentials, or call external APIs; it did not change runtime state or reduce any not-ready special-scope work.

<a id="历史构建与分层记录"></a>
## Historical Build and Layering Record

Revision: search/4. Based on the user's unified adoption rule from 2026-10-30, verified normal behavior in the bound v0.3.0 / 202610281438 / preview installer is used as the basis for requirements v`0.3`; reuse existing source, exact artifact binding, and the independent Review from revision 2. Adopted: GSEARCH-001's normal global-search entry/project scope; normal recent files, results, count, highlighting, and opening in 002–006; and normal query updates in 007. Still unconfirmed: 001 file-only entry, no-project scope, and reachability of literature filtering; 007's initial load and distinction between failure and zero hits. Do not approve default-project fallback or failed empty groups. Nothing has been tested; 006 navigation still requires real data and read/MRU authorization. No product, model, or write authorization is expanded.

This revision changes adoption status only. Seven IDs, criteria, and requirements version are unchanged. It does not change the sole business criteria for navigation, resources, literature, or conversations.

<a id="精确产物与设计依据"></a>
## Exact Artifact and Design Basis

Target: the macOS installer specified for this task, `0.3.0 / 202610281438 / preview`. Rechecked `/Applications/ScholarSeed.app/Contents/Resources/app.asar` read-only, SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. The packaged branch at ASAR `out/main/index.js:41022` loads static assets from `applicationResources(app)/renderer`; actual `Contents/Resources/renderer/assets/index-C4-PYlXk.js` SHA256=`22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`. Package line references below refer to this renderer. No repository-wide source identity is assumed.

Local [MasterGo search record](../../../docs/design/mastergo/search.md) is design evidence, not acceptance or new approval. It supports observations about the recent-file layout, three result domains, and highlighting, and explicitly leaves search scope, navigation, loading/errors, and other semantics unknown. Do not infer complete rules from five historical items or three per group in the image. Fixed row count has the bound implementation evidence below and is adopted as a normal display requirement under the unified rule; design unknowns are not approved by that adoption.

<a id="逐项绑定及独立参照"></a>
## Per-Item Binding and Independent References

| Item | Fixed, dynamic, conditional behavior and current source/package location |
| --- | --- |
| 001 | [TopBar](../../../src/renderer/src/shell/TopBar.tsx):54/102 and [project Navigation](../../../src/renderer/src/features/project/Navigation.tsx):332 are two real entry points and both set `all`; top-bar search is hidden when global literature has no selected project. In-package `TopBarLeft:86485`, `ProjectNavigation:56588`, `GlobalSearch:85184`; scope expression at `:85195` uses `catalogue.query.project_id` for literature and `homeSelectedProjectId` otherwise. The `files` branch at `:85196` is only a state branch; no normal entry setting `files` was found in current source or the full renderer. Do not activate it through internal `set` or assert it as a normal entry point. |
| 002 | [GlobalSearch](../../../src/renderer/src/features/search/GlobalSearch.tsx):213 and package `:85274` filter `recentFiles` by `searchProjectId`, exclude entries without a valid project reference, and call `slice(0,5)`; they do not validate actual file availability. Title is the last path segment; displayed path removes the `resources/` prefix; `openedAt` is formatted for client locale/time zone. Independent reference: minimal projection of authorized isolated preferences `recentFiles` and public project id/name. Do not self-verify current MRU from the screen or a startup snapshot. |
| 003 | `GlobalSearch.tsx:207` and package `:85269` group in fixed `resource`/`literature`/`session` order; empty groups have their own EmptyState. `api.ts:49` corresponds to package `searchEverything:85109`; only leading/trailing whitespace is trimmed from `query`. Public API hits are an independent reference for title/subtitle/identity in this run. A hit reason may come from path, body, or another field depending on domain; do not require every hit title to contain the query. |
| 004 | From `GlobalSearch.tsx:306`, package `:85369` reads `total`/`truncated` from groups; `:85371` initially shows up to three, `:85422` appends ten more, and `:85427` returns to the window and shows a notice when all are displayed but `truncated` is true. “More” changes only local `expanded`; it does not fetch another page. Backend `platform/search.py:70` limits `_window` to 80 per domain; count and truncation come from domain results. Do not use the current three or 80 items to self-verify total matching count. |
| 005 | [highlight](../../../src/renderer/src/features/search/highlight.ts):12 corresponds to package `:85124`; it trims/lowercases the query, finds non-overlapping ranges in original text, and renders with original casing. Independently compute ranges for public `hit.title`/`subtitle`, then check actual marks; do not derive expected results from page marks. A normal synthetic Latin word may be checked first; do not generalize this to normalization across every Unicode language. |
| 006 | `GlobalSearch.tsx:168`, package `openHit:85237`, call `openResourceFile`/`revealResourceFile`, `catalogue.focus`, or `openPanelSession(turnId,itemId)`, then close. Package `openResourceTarget:4967` handles recent files, first selecting the project for that entry and then opening it. The literature view's filtered project and `homeSelectedProjectId` may differ; resource/session branches do not explicitly select `searchProjectId` uniformly. Verify the actual target terminal state in particular; the presence of a comment or call does not prove navigation is correct. |
| 007 | The effect from `GlobalSearch.tsx:124` and package `:85203` clears `expanded`, cancels timer/AbortController, and checks generation/aborted when `query`/`filesOnly`/`searchProjectId` changes; after results succeed it scrolls to top=0. Gaps around API failure becoming `null` and loading precedence are listed below; do not treat current error collapsing as a product requirement. |

<a id="后端owner与公开协议"></a>
## Backend Owner and Public Protocol

The installed backend root is `Contents/Resources/backend/python/lib/python3.12/site-packages/`. The following target files match repository SHA-256 and their route, scope, and provider chains were checked; no real data was queried:

| Owner source | Shared installer/repository SHA-256 |
| --- | --- |
| [platform/search.py](../../../../serve/service/platform/search.py) | `78e454322a3be574957f2ddd4e9f592e831f78aa2eb1df6143096c65966e2a47` |
| [content/service/search.py](../../../../serve/service/content/service/search.py) | `fc5cbfc5214664d6f2310a6d075234958e9ff9b965c813fb526d33ac0a01e54c` |
| [content/service/port.py](../../../../serve/service/content/service/port.py) | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| [chat/service/sessions.py](../../../../serve/service/chat/service/sessions.py) | `d7bba25c600f0b104e36a361f939d95380f153738ca4da323c058a06dda3a71b` |

GET `/api/search?q=…&project=…` uses the page's existing authenticated session with `credentials=include`; Serve's base URL comes from `window.scholarseed.getApiBase`. Omit an empty project parameter; do not guess a preload method or extract a token. Successful top-level response is `{query,hits,groups}`; `hits` is an array, while `groups` contains resource/literature/session with `{total,truncated}`. Each hit has `domain/id/title/subtitle` and nullable `reveal/locator`; it is not a paginated `items` container. Read-only use of the public API does not prove that no content-read permission is required.

Independent references record this run's `q` (preserving spaces within the term), whether `project` was sent, and the actual authorized project identity. Project only the synthetic resource hit's `domain/id/title/subtitle`, `groups.total/truncated`, and necessary `reveal.kind/query/source_revision`, `locator.turn_id/item_id`. Preserve body snippets and conversation summaries only for explicitly authorized synthetic data; do not output real history, paths from other projects, full conversations, credentials, or an entire unreviewed response. When results are truncated, do not reconstruct the exact full-catalog hit count from the returned window; use the synthetic manifest and public counts together to verify total-count semantics.

`platform/search.py:80` obtains resource hits from Content search. Resources are prioritized by exact filename, filename, path, then body; if body extraction is available, it reads a stable snapshot and returns a snippet and `find` locator. `:100` reuses `load_library`/`apply_query` for literature and authors/year as subtitle; `:121` calls visible project conversations and `portable_history` through `SessionService.search_project`, returning snippets and message locators. Search is not web search and does not call a model, but it reads resource contents and visible conversation snippets. `files` mode still sends the same three-domain query and filters only in the frontend; it must never be treated as privacy isolation.

<a id="尚未批准的语义缺口"></a>
## Unapproved Semantic Gaps

- **No project scope:** when frontend `searchProjectId=null`, it omits `project`; `platform/search.py:163` still calls `content.project(None)`, and `port.py:427` `registry.resolve(None)` selects the default project rather than all projects. Recent files under the same null scope span projects. This difference is only an implementation fact; the intended product scope needs confirmation. Do not approve fallback as correct or infer an all-domain requirement from the name. Top-bar search for global literature is hidden, and the normal entry point to its `query.project_id` branch also awaits observation; do not force it through internal activation.
- **Errors and empty results:** package `searchEverything:85109` returns null for non-2xx or exceptions; `GlobalSearch:85218` turns it into `hits=[]`/`counts={}`, and catch does the same, ultimately showing zero hits in all three domains. A source comment saying failure can be distinguished does not prove the UI distinguishes it. Do not approve a failure disguised as no hits as correct requirements, or declare the actual product failed from source alone.
- **Initial search loading:** package `:85303` checks `hits===null` before `:85362` loading; while the first keyword query is pending it may still show recent files, unlike the path when results already exist. A unified, approved initial-search feedback standard has not been recovered; leave it unconfirmed. Do not fabricate a loading screenshot or claim a fault test passed.
- **Files entry:** the mode branch is bound, but there is no evidence of a normal visible entry. Normal `all` path is adopted; do not retire it because of the `files` gap or substitute internal store, test fixtures, or a hidden mode for a user flow.

<a id="数据与副作用边界"></a>
## Data and Side-Effect Boundaries

Reuse [overview.md](../../../../../examples/projects/evaluation/files/overview.md), [detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt), [summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md), [appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md), and the shared terms `SYNTHETIC-CORPUS` plus distinguishing markers ALPHA/BETA/GAMMA/DELTA. Do not create a separate search corpus. The [literature-list sample.bib](../../../../../examples/projects/evaluation/files/sample.bib) may also be reused as synthetic citation input; this BibTeX has only been checked for plain parsing. When the baseline was created, the resources and citation had not been imported; that historical UI-import prerequisite does not apply to every later round. The current distinction is in [search/14](#隔离资料准备边界search14). A sample itself is not evidence of an existing hit or product acceptance. Basic cases still require an authorized isolated project. A conversation hit requires an existing authorized synthetic conversation and message location; if absent, do not call a model or privately write a conversation database to manufacture data. Cross-project scope requires at least two distinguishable projects. Generate recent-file entries through authorized normal file opening; do not write MRU or internal state directly.

“More” requires at least four hits in the same domain; truncation requires more than 80 items or natural truncation. If the larger sample is unavailable, leave the branch uncovered; do not reduce the total to three or claim that “More” exhausted every match. An empty query does not call the search API and cannot prove nonempty-query scope through its recent list. Zero hits cannot substitute for an error case either.

Opening a result may load Viewer, conversation messages, or literature details and change workspace/recent-access/persistent navigation state. `openResourceFile` in `store.tsx:3140` updates `recentFiles`; `catalogue.focus` for literature also records recent access. Recent-file fields are `projectId/path/openedAt`. The latest independent reference must be obtained by asking the Owner to parse the isolated profile's `renderer-preferences.json` and project only `recentFiles`, then verify valid identity against the public project directory; a `preload.preferences` startup snapshot is not a post-operation value. Actual execution must explicitly authorize reading synthetic content and conversation snippets, opening the target, and its native accompanying state changes. Old authorization does not carry forward.

This page does not expand file editing, literature synchronization, full historical text, conversation tasks, model, or web permissions; it does not pre-generate the target state from source data. There is currently no authorized product run, screenshot, or complete imported search dataset. Reference images await later permission to capture; do not fabricate images or a machine fixture. Public budget, freeze, Driver, and Judge procedures remain owned by the Skill and are not copied here.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision is `search/4`. In line with the user's pre-release quick-review objective and unified adoption rule, the quick-review and special-scope layers were added to the same requirements document, reusing this page's bound source, exact artifact, and existing Review. The old business version v`0.3` and full criteria are unchanged. Selected sources are explicit subcriteria of GSEARCH-001, 003, 005, and 006; required references are the current task-project identity and the existing path in `eval-editor-20261030.md`. If scope cannot be verified, stop and record missing evidence for F3 and this action; do not self-approve. Not selected or still unconfirmed: 001 file-only entry/no-project fallback/literature scope; recent files; pagination across all groups; full highlighting matrix; and 007 errors/initial transient state. Parts without evidence remain unconfirmed.

This only establishes the pre-execution layers. It does not conclude product acceptance or replace the complete historical run. Later runs consume the subcriteria frozen through an independent Review and must not claim that a quick-review result covers the full original IDs. This build adds no product operation or data-write permission.
