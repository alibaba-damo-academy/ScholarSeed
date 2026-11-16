<a id="csv与表格阅读"></a>
# CSV and Table Reading

Workbook grid reference

Reference: macOS arm64, 0.3.2 / 202611121104, 2026-11-12; shows one worksheet in a synthetic workbook only, not CSV editing, export, or a failure state.

Verified normal table display, worksheets/grid, read/write eligibility, and CSV editing behavior has been adopted as v`0.3` requirements. Only adopted normal automatic subpoints enter default quick review. 006 is a write-operation specialty and requires authorization for the current run. Special dialect/truncation in 002, complex formats and unbound sources, export in 007, and errors in 008 remain unconfirmed.

View delimited text or a workbook in the project workbench and identify cells, worksheets, and actual read/write eligibility. Semantic entry: normally open the corresponding file in project resources. Actual reachability and engine availability require authorized observation; a file extension or registered viewer alone does not prove the feature is usable.

<a id="看清表格内容"></a>
## Read Table Content

<a id="身份加载与内容table-obs-001--v03"></a>
### Identity, loading, and content (TABLE-OBS-001 · v`0.3`)
Dynamic and conditional: The active tab, file identity, and grid content correspond to the same project, path, and original file in this run; they do not come from another document. After loading finishes, known rows, columns, and cell values match an independent parse of the original data. Judge CSV/TSV and workbooks separately according to actual capabilities. Do not treat a binary workbook as plain text or use values exported from the grid itself as the sole answer.

<a id="记录字段与方言table-obs-002--v03"></a>
### Records, fields, and dialects (TABLE-OBS-002 · v`0.3`)
Dynamic and conditional: Check field and record boundaries against the source's known encoding, delimiter, quoting, line breaks, and empty-field semantics. For CSV, the first record is row 1 of grid data; it is not automatically promoted to a field-header row. For TSV, the first record appears as the field-header row and the rest as data rows. If the total record count is shown, it must match an independent parse of all records (including the TSV header); do not confuse visible data-row count with the total. Truncation must be identified as partial display, not represented as the source total. Multiline quotes, blank records, other dialects, and large-file truncation remain specialties; implementation limitations are not thereby approved as correct behavior.

<a id="工作表与当前网格table-obs-003--v03"></a>
### Worksheets and active grid (TABLE-OBS-003 · v`0.3`)
Dynamic with lightweight interaction: For a workbook with multiple worksheets, visible worksheet names, order, selected state, and known content after switching match the source file. Hidden sheets do not have to appear as selectable tabs. CSV has a single data grid; its bottom label is derived from the file name and is not evidence that the source contains multiple worksheets. The old TSV preview has no worksheet-switching requirement.

The following reference images come from a synthetic workbook in an isolated macOS `0.3.2 / 202611121823 / preview` instance; they show Main and Secondary respectively. Static images alone do not prove the switching action or other table capabilities.

Reference for the Main worksheet

Reference for the Secondary worksheet

<a id="网格定位与可读性table-obs-004--v03"></a>
### Grid navigation and readability (TABLE-OBS-004 · v`0.3`)
Dynamic and conditional: In a viewer that supports grid navigation, after scrolling or keyboard movement the known content for the corresponding rows/columns is visible and the selection matches the actual cell. Offscreen virtualization in a long table must not be misjudged as dropped rows. Check workbook merges, hidden rows/columns, and formatted content only when independent sample references exist; do not promise every complex format or formula recalculation. Clarify beforehand the distinction between source data and displayed values.

<a id="确认可做哪些操作"></a>
## Confirm Which Operations Are Supported

<a id="只读与可编辑资格table-obs-005--v03"></a>
### Read-only and editable eligibility (TABLE-OBS-005 · v`0.3`)
Dynamic and conditional: Determine eligibility jointly from document source, current public capabilities, actual preview/edit view, and runtime restrictions. A read-only file must not gain real write access merely because it has the same suffix. Project CSV, TSV, XLS, and XLSX files cannot all be assumed to be editable in Excel. Unbound conversation artifacts or other sources cannot inherit a conclusion based on project capabilities.

<a id="csv编辑与保存边界table-obs-006--v03"></a>
### CSV editing and saving boundaries (TABLE-OBS-006 · v`0.3`)
Write-operation specialty: Only on an explicitly authorized, actually editable CSV copy, edit, cancel, undo, and redo must correspond to known cell content; preview/read-only states do not accept the same edits. After saving, reacquire the same file and verify that the current changes and untouched field semantics remain; disappearance of a dirty marker is not success. Save eligibility, outcome, failure, and conflict reuse applicable parts of [saving scenarios SAVE-OBS-001/002/004/005](../saving/requirements.md); close protection reuses [tab scenario TABS-OBS-008](../tabs/requirements.md). Do not duplicate those standards here.

<a id="导出另存与外部打开边界table-obs-007--v03"></a>
### Export, Save As, and external-open boundaries (TABLE-OBS-007 · v`0.3`)
Conditional specialty: Count an action as export/Save As capability only when it is both actually reachable and explicitly supported. Opening in an external application, copying cells, downloading a historical snapshot, and saving the current original file are different operations and cannot substitute for one another. Independent output specifications and a table-format conversion/export entry remain to be confirmed. If selected later, require an authorized target format, output path, worksheets, and independent references for known output content; a button or interface alone does not prove export completed.

<a id="遇到异常"></a>
## Handle Errors

<a id="不可读取或解析失败table-obs-008--v03"></a>
### Unreadable or failed parsing (TABLE-OBS-008 · v`0.3`)
Conditional specialty: An authorized read, parse, or engine failure must not masquerade as an empty table or successful load; feedback must distinguish the unavailable result. If a retry is offered, after the prerequisite is restored it must show the correct document, not stale content from a previous file. Judge a genuinely empty table using known source data; no rows/columns during a failure is not a correct empty-table result.

<a id="验证归属与数据"></a>
## Verification Ownership and Data

Adopted normal display for 001, 003–005 and 002 with an independent format reference belongs in a dedicated table quick review. Special dialect/truncation in 002, export in 007, and errors in 008 remain unconfirmed specialties. Normal CSV writing in adopted 006 still requires specialty authorization; citing save failure criteria does not approve those operations. Normal inputs are shared evaluation-project [sample.csv](../../../../../examples/projects/evaluation/files/sample.csv) and [sample.tsv](../../../../../examples/projects/evaluation/files/sample.tsv), both UTF-8 without BOM, LF line endings, and a trailing newline. CSV is comma-delimited; TSV is TAB-delimited. Independent parses contain four records and four fields each (including the header as a source record). CSV displays four grid data rows; TSV displays one field-header row and three data rows, with total record count four including the header. Data preparation is not an import test; a human confirms import.

| sample_id | label | quantity | note |
| --- | --- | --- | --- |
| S-001 | 样本甲 | 2 | `逗号,与"引号"` |
| S-002 | | 0 | 空标签 |
| S-003 | 样本丙 | -3 | 负数 |

The `label` value for S-002 is the empty string, not 0. The shared evaluation project's [sample.xlsx](../../../../../examples/projects/evaluation/files/sample.xlsx) has two visible worksheets, ordered Main and Secondary. Main A1:D4 matches the table above; C2:C4 are numeric values 2, 0, and -3, and B3 is empty. Secondary A1:B2 contains the headers `sample_id`, `label` followed by `S-004`, `SECOND-SHEET`. Switching sheets should show the respective content; do not automatically treat row 1 as application headers.

The [independent long-table CSV](../../../../../examples/projects/table-long/files/long.csv) is UTF-8 without BOM, LF with a trailing newline, and has 120 records of 12 fields each, all data rows. In column 1, rows 1, 60, and 120 are `R001C01`, `R060C01`, and `R120C01`; in column 12 they are `R001C12`, `R060C12`, and `R120C12`. Each cell has a unique row/column identifier for distant-row/distant-column navigation references under TABLE-OBS-004. Actual viewport and reachability still need to be checked in this run. Use this run's receipt for input-preparation status; the file does not mean it was imported or the product passed. A human confirms import. Specialty data for hidden sheets, complex formats, errors, and writing is still missing. The existing XLS only has verified file identity; its name does not promise 100 rows of content.

This page owns table semantics for CSV/TSV and workbooks. Later “Office and table documents” requirements for XLS/XLSX that cover similar content, worksheets, grids, and eligibility should reference this page. Office-wide engine, font, and format specialties are owned separately; do not duplicate criteria sets. Input files or source code are not product evidence.

<a id="发布快评层"></a>
## Release Quick-Review Layer

The adopted normal subpoints from v`0.3` are TABLE-OBS-001, 003, and 005. This covers only the scope below and does not mean every detail of these IDs passes.

Normally open the two-sheet XLSX and compare the Main grid against the independent 4×4 matrix (quantity values 2/0/-3 and one empty `label`). Switch Main → Secondary once; the tab and active grid must switch together and show `sample_id`, `label`, `S-004`, and `SECOND-SHEET`. Inspect actual eligibility only; do not enter cell data.

Required references: authorized isolated copy of [sample.xlsx](../../../../../examples/projects/evaluation/files/sample.xlsx) and this run's project/path mapping; standard-library ZIP/XML independent matrix, visible worksheets Main/Secondary, and build digest.

<a id="专项层"></a>
## Specialized Layer

Not selected in this layer: all CSV/TSV formats, keyboard grid navigation, special dialects/complex formats, writing under 006, export under 007, and errors under 008. The original full criteria, stable IDs, versions, and historical results remain; unconfirmed branches are not approved merely by this layering.
