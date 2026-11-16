<a id="csv与表格需求构建依据"></a>
# CSV and Spreadsheet Requirements Build Basis

<a id="需求与运行进度分离tables13"></a>
## Separate Requirements from Run Progress: tables/13

The blanket historical “not tested at all” status was removed from the requirements body. Run progress and per-run results are recorded in the scenario index and run records; stable IDs, requirements version, adopted scope, special-scope boundaries, and historical freeze are unchanged.

<a id="202611121823-工作表参考图tables12"></a>
## Worksheet References for 202611121823: tables/12

`main-20261112.png` and `secondary-20261112.png` are copies of original images from an isolated macOS arm64 installer instance `0.3.2 / 202611121823 / preview` on 2026-11-12, showing Main and Secondary in a synthetic workbook, respectively. They correspond to original run files `baseline-1823-batch2/supplement/evidence/table-secondary.png` (which actually shows Main) and `table-secondary-selected.png`. Screenshot SHA-256 values are `ce31bbc3b865be8cfef004e2191d4fc40d9e939645b5740d3ba64ad63aa291fc` and `4333291b5c7cab872bc937038c07fc08ee6a8c1517b67282e900066c540e86f9`; target `app.asar` SHA-256 is `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. Images correspond only to the two visible states of TABLE-OBS-003; static images do not prove the action or other branches. Requirements version, criteria, and historical freeze are unchanged.

<a id="共享输入去重tables11"></a>
## Deduplicate Shared Inputs: tables/11

Synthetic inputs from the original page directory were moved to byte-identical shared `examples/projects/evaluation/files/`. Their original paths and contents can be checked at historical commits `137af4c0bd` (CSV/TSV) and `473e3962bb` (XLSX). This only organizes input references; requirements version, criteria, and freeze records are unchanged.

<a id="202611121823-正常快评沿用tables10"></a>
## Reuse for Normal Quick Review on 202611121823: tables/10

Based on the user's unified adoption record and the normal workbook reading already adopted in tables/6 for TABLE-OBS-001, 003, and 005, this page retains the same subcriteria for `0.3.2 / 202611121823 / preview` under the existing [release quick-review layer](./requirements.md#发布快评层). Later build records on this page were read; no confirmed decision to retire or modify those normal requirements was found. This is bounded reuse: the new package's implementation or a single screenshot does not approve new requirements, and it does not prove a complete change-history review, source/artifact identity, or product acceptance. Editing, export, and errors remain within their original special-scope or unconfirmed boundaries. Verify workbook inputs and the independent matrix on each run. Original IDs, version, body, and historical runs are unchanged.

<a id="共享示例输入对齐tables9"></a>
## Align Shared Example Inputs: tables/9

Current data inputs are `evaluation/csv`, `evaluation/tsv`, and `evaluation/workbook` used for quick review. Their SHA-256 values are `72131555255008d035f8846e237f5dc001bc65a682530084e04c9f3139b63cbe`, `3ac4f4fd61f3bd6b9c6da3a7efb762bd91d53e09f23a6b20f44ad3210f18162c`, and `4cb12501e1a90ccf80851937f4ab8222407608e6f49aeb459954bec4dad0230e`, respectively, matching the historical samples byte for byte. Use this run's preparation receipt to verify project and path. Preparation is not an import-feature test; a person confirms import. Target-package applicability remains to be verified; this does not claim a real test passed.

<a id="长表原始输入tables14"></a>
## Long-Table Source Input: tables/14

Added separate `table-long/long-csv`; it does not modify the above frozen inputs or quick-review layer. The file is 11520 bytes, SHA-256 `038ecd75be1ac04a2ee861b58084075386b84865f85187cd5f0d82e1e61bb837`; UTF-8 without BOM, LF line endings and a final newline, comma-delimited, 120 records with 12 fields each. Fields are generated as `R` plus a three-digit row number and `C` plus a two-digit column number, without headers. Independent references for the first, middle, last, and distant columns are in the requirements body. Whether the actual viewport needs scrolling and the product's location result must be observed separately. This input is for authorized isolated preparation only; confirm manual import and product operation separately. It does not prove import, grid navigation, or evaluation passed.

<a id="当前参考图修订tables8"></a>
## Current Reference-Image Revision: tables/8

`reference-20261112.png` is an unmodified copy of `attempt-examples/evidence/table-main.png`, the original image from an isolated macOS arm64 installer instance `0.3.2 / 202611121104 / preview` on 2026-11-12; SHA-256 `b36d1f36ab4841acc22b51ebd86c1b7d7974e0e737a6d86e96aba82fbc2be38d`. It shows a synthetic workbook grid only; it does not prove CSV editing or error behavior. Original run: `tmp/test_snapshot/desktop/release-20261112-fresh/`. Requirements and historical decisions are unchanged.

<a id="历史修订202610301343包内静态复核"></a>
## Historical Revision: In-Package Static Review of 202610301343

Asset revision `tables/7`; this update only adds the specified new package source, input/independent references, and quick-review boundary. Preserve original stable IDs, v`0.3`, adoption rules, full text, reference-image source versions/dates, and historical results. The old sources and revision records below are historical and do not establish package binding or a conclusion for this run.

Target: macOS arm64 `0.3.0 / 202610301343 / preview`; ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`. The source is the actual installer and loose renderer payload extracted for this task; source commit is unknown. The current checkout/remote HEAD may help locate code but does not establish source identity. The evidence manifest is in ignored directory `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`; in-package locations are relative to its `package/` root. Do not treat the temporary extraction directory as a permanent cross-worktree asset.

In-package `out/main/index.js`, SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`: at line 1338, `applicationRenderer` uses the renderer under `applicationResources` when packaged; the no-development-URL branch at 41203 delegates to `serveAssets`. This chain is tied to the actual loose payload analyzed here; it does not prove that runtime has no development override or turn a static entry point into a product observation.

- `renderer/assets/index-CddcCmKt.js`: SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`.
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`: SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`.
- `renderer/assets/OfficeDocument-DVgtjClL.js`: SHA256 `4615f886cfdae604f473432f3ea78ced58f84ee3b280ecc55b46dd0aeac6d651`.
- `renderer/assets/TableViewer-B429rW67.js`: SHA256 `99b79a5ca6d04ddfdefedd159b47d6e5b2becf30e82fa531035eba41c458f07f`.

In-package `workspace:787/790` distinguishes XLSX preview from CSV. `OfficeDocument:145068` loads Workbook by bytes, filters visible sheets, and tracks the selected sheet; `145139/145221` Preview uses the XLSX Workbook; `145373` `CsvDocument` can write only when `can_edit` and in edit mode. Old `TableViewer:12/48` limits the older path to 500 records and marks XLSX/XLS as Pending; do not substitute this old binary branch for the newer normal XLSX Preview. The original `sample.xlsx` Main/Secondary and independent matrix are compatible with the ordinary preview path; quick review only observes eligibility and switches sheets once, not Office editing. CSV/TSV and XLS have different parsers/engines/writes; do not generalize. Gaps for original XLS internal contents, complex formatting/export, and errors remain.

Samples in the requirements body refer to authorized isolated copies of repository originals. Before execution, record the mapping from original digest to task project ID and actual path after import; historical `eval-*-20261030` names are old run aliases and must not be assumed to exist in a new installation. Project/resources, column preferences, and minimal API projections still require independent evidence authorized for this run. Static compatibility does not prove that the normal UI is reachable or passed in a real run. This run did not start, connect to, or operate the product, read user state/credentials, or call external APIs; it did not change runtime state or reduce any not-ready special-scope work.

<a id="历史构建与分层记录"></a>
## Historical Build and Layering Record

Revision: tables/6. Based on the user's unified adoption rule from 2026-10-30, verified normal behavior in the bound v0.3.0 / 202610281438 / preview installer is used as the basis for requirements v`0.3`; reuse existing source, exact artifact binding, and completed Review. Adopted: normal CSV/TSV content, workbook/sheet/grid, and actual eligibility in TABLE-OBS-001–005, plus the 006 CSV editing/serialization/save flow already bound. 006 remains an unauthorized write special-scope item. Still unconfirmed: 002 special dialects, blank records/multiline/truncation and misleading counts; unclear complex formatting or formula recalculation in 003–004; 005 source not bound/Office writes; 007 export entry/artifact; 008 error feedback. Do not self-approve based on bad output or API registration. Restored hidden sheets not appearing as selectable tabs is a normal 003 requirement; missing samples mean not yet tested. Nothing has been tested. Adopted normal automatic criteria are included in the default selection; unconfirmed and special-scope items are listed separately. Adoption adds no product-operation permission.

The ordinary CSV/TSV and two-visible-sheet XLSX inputs from revision 4 and their independent content references are retained. This revision changes adoption status only; eight IDs, criteria, and requirements version are unchanged. It does not copy Office or saving/closing standards.

<a id="目标制品与绑定"></a>
## Target Artifact and Binding

Read-only recheck of installer `/Applications/ScholarSeed.app`: Info.plist and ASAR package.json both report 0.3.0; Resources/product.json reports build_number `202610281438` and update_channel `preview`. ASAR SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`. Direct read of ASAR `out/main/index.js:41018–41023`: when no development renderer URL is set, packaged `serveAssets` root is `applicationResources(app)/renderer`. Therefore the following adjacent renderer files are bound to this artifact's source; runtime environment was not checked, and repository-wide identity is not claimed.

SHA-256 values for this batch under `Contents/Resources/renderer/assets/`:

| File | SHA256 |
| --- | --- |
| index-C4-PYlXk.js | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| OfficeDocument-gRFtPced.js | `4d1e840887deed6555c50d2296bdfdca93da2ec1063ff602d84bca7fe52e6216` |
| TableViewer-CGsRFPfn.js | `077dcc040d23b936fcc13e760514c8f89156489355f0f14508b810f25a2256fa` |
| worker-DQMsDBs3.js | `23d0155e8c03c29d281aafc8921b0033f231e2ac52b482cb72ef3f440f24572f` |

`index:64404–64411` explicitly imports the two document chunks. OfficeDocument chunk `:145923` onward routes first through `usesCsvDocument` to CsvDocument, then through `usesOfficePreview` to Preview, otherwise to OfficeRuntime. The Worker created at `:145283` actually points to `worker-DQMsDBs3.js`. Workspace chunk `:776/779` owns preview/CSV routing. The checked functions and repository correspondence chain agree; lazy-load declarations are not a substitute for a real normal entry point.

Repository frontend source digests, all relative to `apps/desktop/src/renderer/src/`:

| Path | SHA256 |
| --- | --- |
| features/workbench/viewers/TableViewer.tsx | `ed1f70319b596eb528346e17bacf7b5764c29fb8de11a06027e64af0139438b2` |
| features/workbench/OfficeDocument.tsx | `f5a86e10f19d3101f3b57fa23a67e773983ac3d434b2115e6fc3060407b33127` |
| features/workbench/csv/Document.tsx | `40c6e6df0362a126826f2b82a13852606e233608ce301a8cd624ecf907d82024` |
| features/workbench/csv/model.ts | `0de0a4e0ade509a281a8897569bcaf42db9d5e4232f7d4b1903f41955d16637a` |
| features/workbench/preview/routing.ts | `30d9984c0b2a1607ab4b2454d6beb0972c73c7f6e088214483849f071f82011f` |
| features/workbench/preview/Workbook.tsx | `887dc1a1943ced7f40a168df5436af6099113632cf4c2313cd6089929dd305d3` |
| features/workbench/preview/Grid.tsx | `ac9e70a7d9effaf74df87813f4be96544d25ee98063ee9270148485520b89f7b` |
| features/workbench/office/policy.js | `985a8076b2141105fb78d79e83844d392995d1e28a7113ba1639213ab49cde15` |
| features/workbench/office/runtime.tsx | `dea50bb98c57fa18c35dc58f793d0a1d0ae20a1407e33903c7e9128332953836` |

Required backend Owners were compared file by file between repository `apps/serve/` and installer `Contents/Resources/backend/python/lib/python3.12/site-packages/`; these bytes and SHA-256 values match:

| Relative path | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/content/service/spreadsheet.py | `d84b512f6bad0d5de70afaeca554d24a44c411819da6e7a1a0083e6bf74c78e3` |
| service/content/service/xlsx.py | `d3372d242aad8bfa934685bee2c060e28944841d5a9e31936f0360abab80f0c7` |
| service/content/service/xls.py | `b4bb57cb661aeaafebe3c02ff03f930ae5c96fed818accb8f406967a95345d33` |

<a id="真实格式分流及重叠边界"></a>
## Actual Format Routing and Overlap Boundaries

The registration source of truth is [model.py](../../../../serve/service/workbench/domain/model.py):76/77/107/108, not a nonexistent `registry.py`. Normal project open in [routes.py](../../../../serve/service/workbench/api/routes.py):156 first snapshots, reads bytes, and checks size, then projects `viewer`, `processor`, `capabilities`, `revision`, and source identity. [api.ts](../../../src/renderer/src/features/workbench/api.ts):385 obtains `open` and `content` and uses projected `viewer` directly. Actual paths:

| Source/format | Current implementation; not the same as tested |
| --- | --- |
| Project `.csv` | SPREADSHEET → [feature.tsx](../../../src/renderer/src/features/workbench/feature.tsx):135 → OfficeDocument:95 → CsvDocument. Backend `spreadsheet.py` UTF-8-sig/quote-safety checks determine `can_edit`; routes intersects this with `writable`. [workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):369 normalizes editable non-XLSX spreadsheets to edit, otherwise preview. Therefore normal CSV is not the old read-only TableViewer CSV path. |
| Project `.tsv` | TABLE → `feature.tsx:95` → TableViewerHost, which reads resource text through [TableViewer.tsx](../../../src/renderer/src/features/workbench/viewers/TableViewer.tsx):65. Host supplements project from current store; [resources/api.ts](../../../src/renderer/src/features/resources/api.ts):1104 uses GET `/api/resource/read`. This old chain is not rendering `session.bytes`; cross-project/asynchronous identity must be tested. Do not assume it exactly matches CSV. |
| Project `.xlsx` | SPREADSHEET → OfficeDocument → preview/Preview → Workbook. `model.py` registers `readonly=True`; even when `processor.inspect` says XLSX can safely roundtrip, project capability does not permit editing/saving. `api.ts` does not request a compatible preview conversion for XLSX; it sends original bytes to the renderer. `backend artifact_editable` is a separate source-eligibility signal and does not imply that project documents are editable. |
| Project `.xls` | OFFICE and readonly → OfficeDocument → OfficeRuntime/Calc. It does not use the old TableViewer binary placeholder or XLSX ExcelJS reader. Specific fonts/engine/format rendering require Office special-scope testing; file-type identity does not prove that the engine can open it. |

“CSV/spreadsheets” and the adjacent README topic “Office and spreadsheet documents” share OfficeDocument and some workbook Owners. This page owns the spreadsheet-content, sheet/grid, and eligibility semantics. Later Office scenarios should refer to applicable parts of TABLE-OBS-001/003/004/005/008; citing them does not approve unconfirmed errors. Keep generic Office engine, font, and format features in a separate baseline; do not duplicate XLS/XLSX standards. Conversation artifacts, version snapshots, external files, and literature each have their own source projection; this only defines boundaries and does not claim all are bound.

<a id="逐项固定动态及条件来源"></a>
## Per-Item Fixed, Dynamic, and Conditional Sources

| Item | Evidence basis and independent reference |
| --- | --- |
| 001 dynamic/conditional | `OfficeDocument.tsx:87–112` routes formats. `CsvDocument:128` onward creates/cleans up worker/source owner; corresponding Office chunk at `145373/145923`. XLSX [Workbook.tsx](../../../src/renderer/src/features/workbench/preview/Workbook.tsx):124 onward reloads book/style by bytes and prevents stale Promises from entering a new document; from `:160`, loading/failure/empty sheets are separate. Independent reference requires original-file digest and pre-parsed cells; do not derive expected answers from the UI. |
| 002 dynamic/format conditions | CSV [model.ts](../../../src/renderer/src/features/workbench/csv/model.ts):73/87/139/209 uses fatal UTF-8 decoding, optional BOM, quote-aware byte indexing, and candidate detection for comma/semicolon/TAB/pipe; formulas are not evaluated and cells are strings. Corresponding worker starts at `:3/105`. Backend [spreadsheet.py](../../../../serve/service/content/service/spreadsheet.py):34/113/204 maintains similar delimiter scoring and strict quote checks. Old TSV TableViewer at `:97` splits on physical LF/CRLF and filters empty lines before `parseRow` processes single-line quotes; maximum 500 entries, first row uses `thead`, rest `body`. Limit notice receives `rows.length`, not source total; do not approve it as a total-row count. Keep multiline quotes/empty-record semantics unconfirmed; do not impose old parser limitations on new CSV. |
| 003 dynamic/interaction | `Workbook.tsx:155` allows switching only visible sheets; `:189/199` clears selection on switch. [Sheets.tsx](../../../src/renderer/src/features/workbench/preview/Sheets.tsx):13 creates tabs from source names with left/right arrow navigation. Corresponding Office chunk starts at `145068`. `CsvDocument:415` uses the filename without `.csv` as the unique `model.name`; its final Sheets area has one display tab, not workbook metadata. XLS switching is owned by Calc; currently only `policy.js:69` permits JumpToTable/PrevTable/NextTable. Do not infer normal UI reachability from a command allowlist. |
| 004 dynamic/conditional | [Grid.tsx](../../../src/renderer/src/features/workbench/preview/Grid.tsx):103 renders a virtualizer window by row/column, `:329` owns the scroll host, `:393–415` clamps keyboard ranges and scrolls. CSV near `Document:452` reads actual rows/columns from the worker according to the window. Workbook from `:45` reads merges, hidden rows/columns, widths/heights, styles, and drawings. [cells.ts](../../../src/renderer/src/features/workbench/preview/cells.ts):26 `cellText` displays cached `formula.result`, not a calculation engine; floating point/date values may differ from source references. Do not promise full agreement with Excel display formatting/formula recalculation. Complex unknown formats require independent source values/display expectations; do not self-approve current output. |
| 005 dynamic/conditional | `model.py:244` `processor.inspect`, registration `readonly`, and `routes.py:209` `writable` jointly constrain project eligibility. [csv/Document.tsx](../../../src/renderer/src/features/workbench/csv/Document.tsx):99 also requires `viewKind` edit. Office `runtime.tsx:616` passes `editable` to frame and `:797` can `restrictEditing`; [office/policy.js](../../../src/renderer/src/features/workbench/office/policy.js):87 filters commands and toolbar by `editable`. Backend capability alone does not ensure editing UI reachability; readonly project XLS/XLSX does not mean every source is permanently non-editable. |
| 006 write special-scope | `CsvDocument:222–287` `commitEditor` and save delegate first commit the active editor, then serialize; from `:604`, Escape cancels, Enter/Tab commit, Grid `:383` allows undo/redo, and paste makes real changes. `model.ts:477` rebuilds only modified records from original bytes, retaining unmodified tokens/BOM/original delimiter/newline; `:181` requotes separators/quotes/newlines in strings. This implementation does not prove lossless handling of every dialect; independently re-read/parse the result. `api.ts:519` `commitDocument` writes the real source via PUT+If-Match. Existing saving baseline primarily covers Markdown/Monaco; this batch adds CSV adaptation evidence but does not thereby approve the Office serialization chain. |
| 007 conditional/unknown | Current CsvDocument/Workbook read-only grids have no generic CSV/XLSX conversion-export entry point. Office `policy.js:26` LIFECYCLE explicitly excludes native commands such as SaveAs/Export; host save delegate differs from native export. Existing SnapshotReview downloading a historical baseline does not substitute for spreadsheet format conversion. Actual export capability and output-format requirements are not bound; retain this as an unconfirmed special-scope item, not retired because it was not found. |
| 008 conditional | `CsvDocument:121` `reportError` shows a warning; only when no model exists and failure is at the end does it offer retry; if a model operation already failed, grid may be retained. `Workbook:165` retries failure; Preview `:53` clears old state on a new version; old TableViewer `:106` shows unavailable. ViewerBoundary also has generic errors. Do not force the same wording for failures at different stages; do not treat no model or an error-cleared state as a real empty table. Worker/engine errors and source-read failures each require authorized preconditions. |

<a id="副作用与独立状态边界"></a>
## Side Effects and Independent-State Boundaries

Normal public `open`/`content` reads can verify `project/path/revision/media_type/capabilities` and byte digests; they do not reveal actual grid coordinates, displayed worksheets, or parse correctness. No requests were made in this batch. TSV also uses the `resource/read` text path; the new workbench original-byte digest does not prove it consumed text from the same generation. Read-only source review does not prove that two reads under concurrent external changes share a revision.

CSV read/navigation builds a worker index and Grid maintains selection, scroll, row/column widths, and other runtime memory; it does not write the original file. Editing content sets `ExternalDirty`; when configured auto-save is active it can trigger real writes, so typing/pasting in edit mode is not a side-effect-free observation. Grid copy writes to the system clipboard; although it does not modify the file, it must be explicitly scoped. Workbook's `views` Map tracks per-sheet viewport state and does not promise recovery across restart. Normal `store.tsx:3140/3196` open calls `touchRecentFile`; preference submission at `:1881` can persist MRU. Do not describe read-only viewing as absolutely state-write-free.

XLS OfficeRuntime may affect engine initialization, in-memory filesystem, and host state; this batch did not run it. Static health or file headers do not prove real usability. Reading fixed data does not need a model. The old TableViewer “Ask AI” is another business entry point and is unauthorized here; do not include it in spreadsheet-content quick review or trigger it automatically. Saving/auto-saving/conflict/close only reuse applicable parts of existing scenarios. Office write lifecycle is not fully bound, so do not generalize acceptance.

<a id="既有数据与缺口"></a>
## Existing Data and Gaps

Only file identity was checked for [selection-100-rows.xls](../../../e2e/fixtures/office-corpus/xls/selection-100-rows.xls): 13824 bytes; `file` identifies Composite Document File V2 / Little Endian; SHA256=`9fa9ee7ef2d8382b566fdb05d6de479935b1a8d13bd5eec02f9b21fdda75ce5a`, matching the selection-v1 record in the parent [manifest.json](../../../e2e/fixtures/office-corpus/manifest.json). This proves byte identity with a registered compound document only; it does not prove internal workbook validity, absence of macros, actual row count/sheet names, or safe open. No cells were parsed, copied, or imported into the product. `e2e/office.spec.ts:1460` uses it for real XLS selection/auto-scroll input, but historical test intent is not the independent content answer for this run.

Ordinary synthetic inputs [sample.csv](../../../../../examples/projects/evaluation/files/sample.csv) and [sample.tsv](../../../../../examples/projects/evaluation/files/sample.tsv) are 116 bytes each, UTF-8 without BOM, LF and final LF, delimited by comma and TAB, respectively. Independent standard-library parsing finds four records × four fields for both; content references are in the requirements body. They include Chinese, empty fields, zero/negative numbers, and escaped double quotes; no multiline fields, formulas, external links, or credentials. CSV SHA256=`72131555255008d035f8846e237f5dc001bc65a682530084e04c9f3139b63cbe`; TSV SHA256=`3ac4f4fd61f3bd6b9c6da3a7efb762bd91d53e09f23a6b20f44ad3210f18162c`. They are raw inputs only; no product import or parsing/saving result was prepopulated. They do not substitute for runtime screenshots.

Ordinary workbook [sample.xlsx](../../../../../examples/projects/evaluation/files/sample.xlsx) is 4271 bytes, SHA256=`4cb12501e1a90ccf80851937f4ab8222407608e6f49aeb459954bec4dad0230e`. Independent ZIP/XML parsing confirms visible worksheet order Main, Secondary; content references are in the requirements body. Main C2:C4 are numeric; other used cells are strings, including empty string in B3. There are no formulas, external relationships, macro parts, hyperlinks, merges, hidden sheets, or hidden rows/columns; do not claim coverage of those features from this input.

The three inputs provide independent references for ordinary table identity/content, basic dialect/count, and switching between two sheets; they have not been imported into the product and do not prove the actual Viewer works. At the time of the historical note, long-table input was not ready; a separate CSV was added later in `tables/14`. Hidden sheets, formula caches/merges and other complex data, corrupted/empty files/other dialects/read-only refusal/edit before-and-after/export expectations remain unready. XLS has no independent internal-content manifest. The source filename “100-rows” is not a row-count reference; do not use it to mark 004 or any special scope ready.

<a id="发布快评分层2026-10-30"></a>
## Release Quick-Review Layer (2026-10-30)

This asset revision is `tables/6`. In line with the user's pre-release quick-review objective and unified adoption rule, the quick-review and special-scope layers were added to the same requirements document, reusing this page's bound source, exact artifact, and existing Review. The old business version v`0.3` and full criteria are unchanged. Selected sources are explicit subcriteria of TABLE-OBS-001, 003, and 005; required references are the existing `eval-table-20261030.xlsx`, independent standard-library ZIP/XML matrix, visible sheets Main/Secondary, and build summary. Out of scope: all CSV/TSV formats, keyboard grid positioning, special dialects/complex formatting, 006 writes, 007 export, and 008 errors; parts without evidence remain unconfirmed.

This only establishes the pre-execution layers. It does not conclude product acceptance or replace the complete historical run. Later runs consume the subcriteria frozen through an independent Review and must not claim that a quick-review result covers the full original IDs. This build adds no product operation or data-write permission.
