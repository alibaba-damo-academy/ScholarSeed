# Conversation UI and isolated plugin resources

## Declarative conversation renderer

The development gallery's **A2UI** category follows **Workbench** and ends the conversation directory. **Canvas** reuses the existing Canvas preview, and **OpenUI basic components** reuses the installed upstream component directory and inspector. Legacy categories below A2UI and the separate UI/primitive/business menus are hidden; their implementations and standalone preview catalog remain intact. The initial preview is Text messages. This navigation does not change Agent admission.

开发组件页的会话目录在“工作台”后的同级“A2UI”类目结束：“画布”复用既有 Canvas 预览，“OpenUI基础组件”复用已安装上游组件的目录及检查器。A2UI 之后的旧类目及独立的基础／原子／业务组件菜单不再显示，组件实现及独立预览目录保留；默认预览为“文字消息”。此导航调整不改变 Agent 准入范围。

The development gallery's **Workbench** category follows **Charts** and reuses the existing **Research results** (`Results`) and **Research review** (`Review`) previews, presets and workspace interactions.

开发组件页在“图表”后提供同级“工作台”类目，复用既有“科研结果”（`Results`）和“科研综述”（`Review`）预览、预设及工作台交互。

The development gallery has a separate **Charts** category next to **Conversation components**. Its **General chart** entry reuses the existing foundation `Plot` preview, including its presets and JSON inspector.

开发组件页在“对话组件”旁新增同级“图表”类目；其中“通用图表”复用既有基础组件 `Plot` 的预览、预设和 JSON 检查器。

The General chart gallery combines the original Plot presets with every preset from the chart category, including variant-specific area/line/horizontal charts, radar, radial and single-stacked charts, and the basic table. A bounded preset selector preserves the original component, schema and data for each example, and switches the renderer and JSON inspector together. This is preview aggregation, not an expansion of the production Plot model's supported chart kinds.

通用图表示例汇集原 Plot 预设与图表类目中的全部组件预设，包括面积图、折线图、水平条形图的各变体、雷达图、径向柱状图、单条堆叠条形图及基础表格。限高下拉选择器保留每个示例的原组件、Schema 和数据，渲染器与 JSON 检查器同步切换；这是预览聚合，不扩展产品 Plot 模型支持的图表类型。

**Conversation components → Processing** reuses the tool execution and plan previews, plus the interrupted-task, recoverable-session and retry alerts from the Alert gallery. These examples remain local demonstrations and do not resume tasks or reconnect services.

“对话组件 → 处理过程”复用工具执行与执行计划预览，以及 Alert 组件页中的任务中断、会话恢复和正在重试提示。示例仍为本地演示，不恢复任务或重新连接服务。

The development gallery also groups artifacts under **Conversation components → Artifacts**, with file, four-image and combined previews, and citations under **Conversation components → Citations**, with citation sources and citation markers reusing the existing foundation previews. **Conversation components → Body content** reuses the existing Formula, Tabulation and Markdown previews in three tabs. Embedded `Preview` callers can pin an existing preset using `sample` and `example`; pinned previews list only that preset, restore it on reset and keep their editable drafts separate from the original gallery.

开发组件页另在“对话组件 → 产物”下提供文件产物、四张图片产物及组合示例，在“对话组件 → 引用”下复用既有基础组件的引用来源与引用标记预览。“对话组件 → 正文”通过三个 Tab 复用既有 Formula、Tabulation 和 Markdown 预览。内嵌 `Preview` 可通过 `sample` 和 `example` 固定既有预设；固定预览仅列出该预设，重置时恢复该预设，可编辑草稿与原组件页分开保存。

The development component gallery (`?dev=components`) exposes **OpenUI basic components** immediately after **Canvas** under **A2UI**. It discovers every installed upstream definition, including helper components, and reuses the JSON/schema inspector. Helpers render in their parent composition. This inspection-only library, drafts and local interactions are separate from the production Agent registry and do not grant tools or business actions.

开发组件页（`?dev=components`）在“A2UI”的“画布”条目下方紧接提供“OpenUI基础组件”，自动发现当前安装版本的全部上游定义（含辅助子组件），复用 JSON／Schema 检查面板；子组件在父组件中组合展示。核验库、草稿与本地交互均独立于生产 Agent 注册表，不授予工具或业务操作权限。

Each built-in has literature-review and experiment-comparison presets, including long content and zero/negative chart data where applicable. Use the Conversation/Canvas switch to compare the same editable JSON in the answer flow and the existing collapsible, bounded Canvas container. Preset selection replaces the current component's draft; switching containers preserves it. These synthetic samples and local interactions do not publish a Canvas, run an Agent, or demonstrate production admission. Presets live in `preview/samples/upstream.mjs` and are validated against the installed upstream schemas.

每个内置组件均提供“文献调研”和“实验对比”预置示例，按组件能力覆盖长内容、图表零值和负值。切换“对话展示／Canvas 展示”，可对比同一份可编辑 JSON 在回答流和现有可折叠、限高 Canvas 容器中的效果。加载示例会替换当前组件的草稿；切换容器保留草稿。合成示例及本地交互不会发布画布、运行 Agent，也不代表生产组件准入。示例位于 `preview/samples/upstream.mjs`，按已安装上游 Schema 校验。

Data-bearing entries also retain the small/medium/large presets from `preview/samples/registered.mjs`. Collections list scenario presets first, then compatible scale presets, without replacing either set.

数据型组件同时保留 `preview/samples/registered.mjs` 中的小／中／大规模示例。集合中先列出场景示例，再追加兼容的分档示例，不覆盖任一类数据。

The upstream OpenUI Renderer admits registered literal display components only: Markdown narrative, tags and charts. Worker preflight enforces source/tree budgets and rejects actions. It never evaluates generated JavaScript or exposes network, files, MCP or native APIs. Desktop supplies its theme. Code fences and section breaks belong in `TextContent`; standalone `CodeBlock`, `Separator`, `Citation` and resource-reference `Artifact` are not registered.

声明式对话仅注册 Markdown 正文、标签和图表。代码围栏和分节由 `TextContent` 承载，不注册独立的 `CodeBlock`、`Separator`、`Citation` 和资源引用 `Artifact`。Worker 保留预算与动作校验，不执行生成的 JavaScript，也不暴露网络、文件、MCP 或原生 API；主题由 Desktop 提供。

For fixed-target radial progress, use `RadialChart(labels, values, title, maximum)`,
for example `RadialChart(["Progress"], [60], "Progress", 100)`. The arc and label
both show 60%, and the source table retains 60 and 100. The maximum must be positive
and values must lie within `[0, maximum]`. Omitting it preserves the upstream
relative-category chart; its category shares must not be described as absolute progress.

固定目标进度使用 `RadialChart(labels, values, title, maximum)`，例如
`RadialChart(["进度"], [60], "进度", 100)`。圆弧与标签均表示 60%，原始数据表保留
60 和 100。分母必须为正数，数值必须落在 `[0, maximum]`；省略分母时仍为上游相对分类图，
不能将分类占比解释为固定目标的完成率。

User input, processing records, confirmation/clarification, and exception/fallback components are removed from the official conversation library and live preview. Existing native product flows remain intact. Generic sandbox base controls remain available for independently authorized custom executable plugins, not a second built-in confirmation flow.

Serve owns sequential display revisions. Reuse the same request ID to update one surface. The conversation.ui slot is display-only: component/request rejects it before creating HIL or a binding. Native business decisions retain their original drafts, authorization and real receipts. Unsupported old generated forms show unavailable without deleting history or user data.

New conversation surfaces must declare `root = Conversation(...)` before publication. If the declaration is missing, `component/display` returns `openui_root_required` without publishing or consuming the revision. The renderer still performs full OpenUI validation; historical documents are not rewritten.

新对话卡片发布前必须声明 `root = Conversation(...)`。缺少声明时，`component/display` 返回 `openui_root_required`，不发布卡片，也不占用修订号。渲染端仍执行完整的 OpenUI 校验，历史文档不改写。

The same registration produces conversation.json and drives the live preview. Native citation and artifact flows and independently authorized executable plugins remain unchanged. Removed generated components show unavailable without rewriting historical documents.

同一注册表生成 conversation.json 并驱动实时预览。产品原有引用、产物流程和独立授权的可执行插件保持不变。包含已移除组件的历史生成文档显示不可用，不重写历史数据。

## Isolated executable plugin SDK

Display-only plugins can instead declare a fixed `openui` layout and business
`input_schema`. The installed slot accepts only business data; the Desktop
renderer binds literal values using the same registered conversation library for
preview and live display. No plugin JavaScript, actions, draft or iframe is used.

展示型插件也可声明固定的 `openui` 布局与业务 `input_schema`。安装后的 slot 只接收
业务数据，Desktop 在预览与正式展示中用同一对话组件注册表绑定字面值并渲染；
不加载插件 JavaScript，不提供动作、草稿或 iframe。

The following 2.0 resource contract remains limited to executable sandboxed plugins;
it does not grant host execution to a plugin or a resource with an official name.

Resource release 2.0.0 retains typed interactive charts, data tables and conversation-aware
result presentation, cached-image loading fixes and automatic card text registration.
Copy registration follows every published snapshot, supports in-place retry and reconnect
recovery, and includes the shared research cards alongside discoverable layout, form,
table, feedback, menu and dialog controls for custom plugins. The official input, process,
confirmation and fallback conversation exports and slot implementations are removed.
Compatibility is 2.0; reviewed consumers declare this major explicitly. Earlier 1.0
resources and leases keep their pinned immutable snapshots rather than being rewritten.
This changes composition, not permissions or the update entry points.

The official build replaces Desktop clipboard defaults with an SDK-only denial
adapter: unported primitives reject with `ui_clipboard_not_authorized`, never
using the preload bridge or browser clipboard. Official card wrappers supply
the `window.plugin.copyText` port by default; the host requires a real click in
the current card, its live lease and matching content revision. An explicit
`onCopy` callback still takes precedence. Desktop clipboard behavior and
whole-card copy registration are unchanged.

## Plot SVG export

Plots and all typed chart variants expose **Export SVG** in the header. One click
opens the native save picker. The export uses the chart's SVG format, with no size
or format settings. It captures the visible plot geometry, styles, title, units,
legend and zoom rather than drawing another chart. In the Data tab it uses the last
visible Figure. Surrounding notes, sources, script and version are not exported.
The SVG canvas is transparent; the card's on-screen background is unchanged.
The Figure tab copies that same plot as a transparent PNG to the system
clipboard. The Data tab copies the source table as plain text.
Historical cards keep their pinned renderer; cards using the previous export
request retain their previous layout when saved.

The official runtime supplies the `plugin.exportPlot` port to standalone Plot cards
and typed charts. The host validates static SVG geometry, rejecting executable
content, external references and paths, and requires the current frame, live lease,
revision and a trusted user click.
The save picker is the only destination authority. Cancel and failure are distinct
from success. Custom hosts can provide `Plot.onExport` or `PlotExportContext`; without
an exporter, Plot does not advertise an unavailable save action. Sandbox downloads
remain disabled. No PNG/PDF export is introduced.
The live browser gallery uses its own host-side File System Access save picker
when supported; it does not grant this API to isolated components.

中文：Plot 及全部图表变体在头部提供“导出 SVG”，点击直接打开原生保存窗口。
沿用图表的 SVG 格式，不提供尺寸或格式设置。直接保留图面几何、样式、标题、单位、图例和当前缩放，
不重新绘图。「数据」页导出上次可见的图形。备注、来源、脚本和版本不写入导出文件。
SVG 画布为透明背景，界面内图表底色不变。
「图形」页将同一图面复制为透明 PNG 图片，「数据」页仅复制原始表格文本。
历史卡片保留发布时绑定的渲染器，使用旧导出请求的卡片仍沿用旧版导出排版。
官方运行时为独立 Plot 卡片及具体图表提供受控导出端口；宿主仅接受经校验的静态 SVG，
拒绝可执行内容、外部引用和路径，并检查当前 frame、有效租约、内容版本和真实点击。保存目的地仅
由原生选择器授权，取消和失败不算成功；自定义宿主可传 `onExport` 或提供
`PlotExportContext`，未接入时不显示无效入口。沙箱下载仍禁用，本次不增加 PNG/PDF。
实时浏览器预览在支持 File System Access 时使用浏览器宿主的保存选择器，不向隔离组件授予此 API。

## Conversation presentation

The isolated document is a transparent canvas, using the host design font, body size,
line height and explicit theme. Surfaces belong to cards, not the entire frame.
The host propagates live theme changes without recreating the frame or its draft.
Sandbox, CSP, navigation, frame height limits and authorization remain unchanged.
Leases are scoped to the owning document: cross-document host navigation or renderer
loss discards that owner's leases; same-document navigation preserves them. Reloading
the gallery therefore does not consume the fixed instance limit indefinitely.
The isolated loader waits for document readiness, then loads the pinned runtime
before the plugin entry. Parser speculation must not request resources before the
opaque frame has an established identity; failed runtime loading stops the entry.

The host owns spacing between display cards; each component owns only its internal layout.
Do not add outer padding/margins to every component. Content is retired: use independent
Plot, DataTable, Formula and Markdown entries, without a blocks wrapper.
宿主负责卡片间距，组件只负责内部布局。Content 已移除，改用独立卡片，不再传 blocks。
`Plot` exposes `framed=false` for an existing parent card, avoiding nested borders
and padding. Standalone plots keep their own chart surface, reading-width bound,
container-responsive height, original data toggle and keyboard/point selection.
Long chart labels truncate visually while the source table and accessible row
description retain full values. Dense series keep inside/slider zoom; sparse plots
keep inside zoom without an unnecessary slider. Theme changes preserve selections.
Markdown owns internal paragraph spacing but has no leading/trailing block margin.
DataTable owns its composition gaps and normalizes legacy child margins. Tables
reuse the shared frame's hover/focus copy control and retain the original copy port.
Result details use a bounded conversation preview with the existing result surface's
internal scrolling, not the plugin viewport height. Menus constrain themselves to
their actual viewport and scroll to keyboard-focused actions instead of clipping.

The sole development preview entry is the live source-based workbench below.
Desktop's UI materials reuse this workbench in an embedded mode: the same discovered
official exports, nonempty categories, input contracts and bindings follow the existing
conversation examples. This is a source import, not an iframe or dependency on a
running preview server. The host owns selection and theme; embedded drafts use a
separate session-storage key and do not write the standalone preview's hash or drafts.
`example/laboratory.js` and its programmatic builder remain fixtures for the existing
in-app MOCK and isolation regressions, not a second live/offline development page.
Historical immutable cards keep their pinned resources and synthetic materials;
editing the developer preview never silently replaces those historical snapshots.
Native question and authorization slots stay host-owned; plugin source is never executed in the host document.

The official UI is an independently built browser resource package. Desktop ships
its copy as a system dependency on each release; research plugins reference its compatible
exports rather than bundling React or base controls again. The host owns trust,
isolation, dependency resolution, permissions and interaction responses.

## Build

The answer-level source directory collects the final answer and current persisted
card Markdown for the same session and turn. Official `Markdown` registers its
original text automatically. Pass `sourceMarkdown` to `Tabulation` when its
`copyText` is TSV rather than the original Markdown table with citation links.
This registration does not verify a source: receipt resolution, document access,
and opening remain host-authorized and bound to the combined content revision.
Saving a card invalidates its old registration until it registers the new revision.
For document evidence, preserve the host-issued `scholarseed-cite:` links in the
registered Markdown. The host resolves them against this turn's admitted source
snapshot before revealing the document and exact location; a registered link does
not authorize an arbitrary file or permit reusing another turn's receipt.

Cards can call `window.plugin.setCopyContent({ text, markdown? })` to register their
text representation. This does not access the clipboard: Desktop's outer card and
reply copy buttons perform the actual write after a user click. Register again
from the updated `onState` snapshot after saving a draft; stale draft revisions
are rejected. The persisted representation remains available without a mounted frame.

`Conversation.Results`, `Details`
and `Review` register their text automatically when rendered through `mount`.
The same applies to `Markdown`, `Code`, `Formula`, `Tabulation` (with
`copyText` or `invalidSource`) and `Artifact`. Code retains collapsed lines;
formula text retains its LaTeX source, caption and notes. Artifact text keeps the
displayed title, filename, path and status, not the linked file's contents.
Composing several cards combines their texts instead of overwriting each other.
The same registration covers Plot and its ten typed charts and DataTable.
It includes complete original rows, units, provided sources/scripts
and saved selection IDs; it never reads linked files. Layouts, icons and menus do
not synthesize business content. This registration powers the whole-reply action,
independently of the content-level copy controls.
Review text includes collapsed sections, citations, warnings, checks, issues and
artifact paths; it does not read linked files. Saved state changes register the new revision.
A registration failure stays visible in the frame until a subsequent registration succeeds.

For other custom layouts, declare `useCopyContent` in `ui.exports` and call
`window.scholarseedUI.useCopyContent(text)` inside the component passed to `mount`.
Each mounted component contributes its own text. Supply business content, not button
labels or private configuration. Use this hook for composition; do not also call
`setCopyContent` in the same frame, since the latter replaces the entire card's text.

Content-level copy controls use `window.plugin.copyText(text)` unless an explicit
`onCopy` callback is supplied. This is a separate, write-only host request gated
by the current frame, lease, binding, revision and a trusted user gesture. It
does not grant clipboard reading or arbitrary clipboard access, does not replace
the persisted whole-reply representation, and reports a failure unless the host
confirms the write. In the standalone preview, the browser's clipboard permission
checks apply; an unavailable clipboard is not reported as a successful copy.

## Native-only interaction boundary

User input and context, execution history and plans, confirmation and clarification,
next-step suggestions, and error/empty-answer surfaces belong to native Desktop UI.
They are not exported through `Conversation`, the official discovery catalog or the
live preview. Shared images, file menus and content renderers remain available for
answers and artifacts, including their own loading, copy and rendering failures.

### Live conversation preview

Start the browser development server from the repository root:

```sh
pnpm ops dev browser
```

Open [the component gallery](http://localhost:5173/?dev=components) on the renderer's
loopback address. The standalone browser server is test-only; use the Desktop
gallery for manual preview. Vite imports the actual component and theme sources,
not generated `ui.js`.

The embedded conversation preview catalog is discovered from PascalCase renderable values in the actual
`Conversation` namespace. It is not populated from the sample registry. New exports
appear immediately, including an explicit missing-contract entry when needed;
removed exports disappear. The browser regression compares real exports with the
directory and requires a usable data contract for every current card.

The directory uses six ordered categories: body/rich content, charts,
research results, citations/evidence, artifacts/workbench, and foundations
(`基础组件`). Foundations collect shared building blocks rather than presenting
them as independent answer requirements:

- Data foundations: `DataTable` and generic `Plot`.
- Citation presentation: unified file/web `CitationLink` and `CitationSources`.
- Files: the individual `Artifact` card and `FileMenuItems`.

`FileFormatIcon` and `ArtifactDestination` remain shared, compatible SDK utilities,
but have no independent preview entry: icons appear within file/citation cards and
destination selection belongs to the existing host save/import flow. Their explicit
internal descriptors do not suppress automatic discovery of new official exports.
`Details` likewise belongs to the host results workspace rather than a standalone
conversation preview. Its existing SDK export and workspace slot remain compatible;
conversation navigation is represented by the single `Results` receipt entry.

The ten concrete chart types remain in charts; body `Tabulation`, evidence
selection, and composed `ArtifactGroup` remain in their original business groups.
Registered OpenUI display components remain in their own group. This classification changes preview navigation only, not public exports, shared
implementations, host permissions, or business behavior. Identical renderer
references still share one entry; `ArtifactMenuItems` aliases `FileMenuItems`.
Aliases remain searchable and old hash links resolve to the canonical entry.
Existing canonical JSON drafts take precedence; an alias-only draft is reused
without deleting historical records. Narrow-width selection uses the same groups.

Mixed artifact input is consolidated into at most one image group and one
file/folder group, using the same partition helper as native artifact delivery.
Group order follows the first occurrence of each kind in JSON, and each kind
retains its original internal order and version sets. A directory counts with
files in the same grid. Failed and deleted images keep their file and error states.

Citation presets distinguish webpage, bibliography-backed literature, and local
file sources, plus long names/excerpts and mixed directories. The secure receipt
resolver and web-source opener remain separate official components; preview data
selects the matching export rather than inventing new source permissions. Named
markers share compact pills, actual file-format icons and source-kind metadata;
the answer-level directory shows up to three source icons and a unique-source count.
No external favicon request is made. File markers open a compact preview on
click; clicking its title revalidates the source before the host opens its
workbench tab. Version checks and error/retry handling remain host-owned.
The optional `CitationLink.identity` supplies initial title/path/bibliography for
presentation only; it never bypasses `resolve` or authorizes original opening.

`CitationLink.references` accepts ordered document sources with individual
resolvers, excerpts and occurrence counts. The marker shows the first filename
and the remaining document count; the preview supports previous/next controls,
Left/Right keys, source totals and the original citation count. `Markdown` accepts
host-provided `citationGroupKeys` and `renderCitationGroup` to merge same-type
registered citations within each paragraph, even across intervening prose.
Different source types and separate paragraphs never merge. Single registered
document citations use the same filename capsule without a remaining-source
count, including literature citations. Document identity includes its revision;
each selected title is revalidated before navigation.
Source labels and grouping use the declared `source_kind`, never the file
extension or the presence of bibliography metadata. Literature, resources,
attachments, files, file selections and managed full texts remain distinct;
unknown origins display an unknown-source label and are not automatically grouped.

文件标记点击后展示简洁预览，点击标题时重新校验来源，再由宿主打开工作台页签。
`CitationLink.references` 接收有序文件来源、逐项解析器、片段和引用次数；标记展示
首个文件名与剩余文件数量，预览支持左右按钮、方向键、来源总数及原始引用次数。
`Markdown` 通过宿主提供的 `citationGroupKeys` 和 `renderCitationGroup`，合并同一
段落内同类型的已登记引用，中间可以有正文；不同来源类型、不同段落不合并。
单条已登记的文档引用（包括文献引用）同样展示文件名胶囊，但不显示剩余来源数量。
文件身份保留版本，标题打开前仍须重新校验，展示元数据不授予文件访问权限。
标签与合并共用真实 `source_kind` 分类：文献、资料库、附件、文件、文件选区和
受管全文分别处理，不按扩展名或书目信息猜测；未知类型显示“未知来源”，不自动合并。

Document-based presets now include twelve file formats and four action/status
variants, mixed file groups, eight ordinary Markdown examples, actual study
links/bibliographic metadata, and three Review examples. Review bibliographies
use publicly verifiable arXiv records such as [ReAct](https://arxiv.org/abs/2210.03629)
and [AutoGen](https://arxiv.org/abs/2308.08155); the surrounding outline and status
are manually prepared preview data, not a model-generated or full-text-verified
task. File sizes, paths, row counts and local excerpts are illustrative, not
resources created on disk. The sources-and-missing-values table links to the
individual papers rather than publisher homepages; its 15% customer-support
figure refers to the [2025 QJE article](https://doi.org/10.1093/qje/qjae044), not
the earlier NBER working-paper estimate.

Markdown remains ordinary answer content. Its preview entry demonstrates the
shared renderer; it does not make native Markdown depend on a display-card tool
call or plugin bridge. Optional preview-only `answerSources`, `resolutions` and
`images` bind existing citation/image renderer props locally. Linked SVGs are
explicit synthetic image fixtures, not new Plot component types. Precise file
line/cell navigation, website favicon fetching and the outstanding Diagram
styling feedback are not implemented by adding these presets.

`Results` and `Review` use a shared white bordered receipt with independent
open and disclosure buttons. Results shows its paper count and, when explicitly
expanded, criteria and a bounded scrollable title/year list. Review expands a
bounded, initially expanded document preview with scope/delivery, metrics, outline,
per-paper evidence, bibliography and verification/issues. It does not embed Canvas
or truncate the document to scope fields. Its header stays outside the internal
scroll area; the independent open operation still opens the full host workspace.
Results continues to start collapsed; the Review sidebar detail is unchanged. Opening delegates to the bound,
authorized operation, retaining busy state, duplicate protection and failure/retry.
Preview operations are simulated and do not establish Desktop acceptance.
No new post-authorization flow is implemented by this preview feedback change.
Only `Results` and `Review` have a conversation/sidebar surface switch. The
preview's switch changes the local rendering surface: `Results` uses official
`Details`, and `Review` uses official `Review` with `detail=true`. Clicking their
conversation receipt opens this same preview surface. JSON drafts and the last
valid payload remain shared across both modes; navigating to another component
returns to its conversation view. The close action restores focus to the switch.

This is not a running Desktop workbench or a new iframe host. The preview uses
local JSON and simulated literature ports; it does not resolve a real session,
read files, authorize a source, download, import, or persist business changes.
Desktop instead binds the actual session/card/project, authorizes host requests,
loads the persisted result through its result-tab flow, and uses real domain
ports. Shared detail renderers do not make the two hosts or their permissions
equivalent. Passing this preview does not prove Desktop end-to-end acceptance.

Other cards keep their own presentations. `Artifact` is a file card, not a result
receipt: it displays the format icon, title, file/version metadata, independent
open and import controls, and the existing version and context menus. File and
folder cards retain their metadata and actions in every row.
In a project conversation, the host opens the bound results tab in that project's
right workbench, retaining the conversation and project context; global entry
continues to use the literature center. Global and other-project result tabs are
not exposed in a project's workbench.

`preview/catalog.mjs` owns serializable preview contracts, labels, grouping and
structural adapter selection. `schema.mjs` implements the declared JSON Schema
subset (types, objects, required/additional fields, arrays, enum/const/default,
oneOf and limits). `rules.mjs` supplies seeded generation and dataset/chart
relationships; unsupported generation rules fail, never silently return a fixture.
These are preview input/composition contracts, not exhaustive React prop schemas
or permission grants. Editing protocol constants or exceeding a declared preview
constraint is rejected explicitly, rather than passed unchecked to a component.
Contracts reuse public content schemas where applicable, rather than inferring
types from hardcoded example records. Temporary initial data is generated from the
contract until curated examples are supplied. Changing JSON does not change official
component code. New components need their data contract
and, only for a new interaction/composition shape, a safe binding; the page does
not need another case or hand-maintained component list.

Valid JSON edits apply immediately. Invalid drafts show field paths and stay in
the editor while the last valid preview remains visible. Drafts,
the selected card and theme survive navigation, HMR and page reload through tab-local
session storage; no JSON is posted to a backend. A contract-breaking source edit
retains the draft and explicitly marks regenerated fallback data as unapplied.
Restore default data is an explicit user action. The Schema disclosure shows the actual
contract used for generation and validation.

Screenshot-based examples for Formula, Tabulation, Markdown code/Mermaid fences and three
synthetic scales for each of the ten named charts are registered in
`preview/samples/`. Table source links point to the named sites' home pages for
interaction only; they do not claim to be the referenced papers. Add examples to
the relevant module under `preview/samples/` and register them through
`preview/examples.mjs`, keyed by the canonical component export name as an array
of `{ id, label, data }` objects;
IDs must be unique within that component and `data` must satisfy its preview schema
and relationship rules. Clicking a visible example immediately replaces the current
JSON draft and updates the preview. Preview ownership follows the actual registered schema, not an overlapping
export name: Plot-shaped presets are listed under the unique retained result entry
that accepts them instead of being cast to an OpenUI chart. Their JSON, including
negative and missing values, stays unchanged. Routed presets retain their source
name in their ID and label; ambiguous or unmatched data keeps normal validation
errors, while the last valid preview remains visible. The registry is imported by
the live preview and changes participate in Vite hot updates.

Callback functions and React subtrees are injected through fixed local bindings,
never parsed as executable JSON. File, literature and workflow actions only report
simulated feedback; there is no Desktop bridge or API proxy. Development CSP permits
the exact loopback HMR socket and nonce-bearing Vite scripts, not remote services.
The product/plugin CSP and pinned resource lifecycle remain unchanged.

The existing persistent in-app MOCK and its historical resources remain separate;
they are not silently rebound by editing this live preview. This developer tool is
not Agent/Skill or host authorization acceptance. Run the rule and real-browser
regressions with:

```sh
node --experimental-transform-types --test packages/ui/preview/schema.test.mjs packages/ui/preview/browser.test.cjs
```

Use the existing `PLAYWRIGHT_CHANNEL=chrome` setting when testing with installed
Chrome rather than a Playwright-managed browser. Browser HMR tests use a private
source copy; they never rewrite the developer's official source files.

### Resource package

Use the repository-reviewed Node and installed Desktop dependencies:

```sh
node packages/ui/build.cjs tmp/official-ui
node packages/ui/build.cjs --archive tmp/official-ui.zip
node packages/ui/build.cjs --example tmp/method-comparison.zip
node --test packages/ui/build.test.cjs
```

The official output contains `.scholarseed-ui.json`, the exact resource inventory,
`ui.js`, `ui.css`, `research.js`, `catalog.json` and font resources. The build borrows the existing
design-system source as input; neither the shared card nor its runtime is compiled
into the research plugin. Runtime resources are loaded from the host-controlled
lease, not the network. Host application controls remain owned by Desktop.

The example is a separate local research plugin with its own `SKILL.md`, component,
declaration and sample-only preview. Its component consumes `window.scholarseedUI`.
Checkbox changes save a draft; confirmation submits the declared action. The host
decides whether that action is permitted and how it resumes the waiting workflow.

## Discover and compose

Read `catalog.json` from the built resource package before generating a custom
component. It describes only exported families, their intended use and pitfalls,
public slots, and the bridge completion contract. The same catalog is available
as `window.scholarseedUI.catalog` inside a bound frame. Family metadata comes from
the existing design-system registry; it is not a separately maintained list.
The catalog is not a complete props schema or an authorization grant. Agent-side
host discovery is available through `component/catalog` with `include_ui: true`.
The reply identifies the active resource fingerprint and is not an authorization.
Older resource packages without a catalog report it as unavailable.

`Conversation` exposes `Results`, `Details`, `Review` and `Markdown`. These reuse the original components, not simplified copies.
Business cards consume `content` and `ports`; the typed operations are owned by
`apps/desktop/src/renderer/src/features/literature/ports.ts`. Plugins must bind
each operation to a declared `plugin.request` action, not call host APIs directly.
`createLiteraturePorts(request, scope)` supplies that typed adapter from this
resource package; consumers do not import ScholarSeed source or copy its operation map.
Pass `(action, values) => plugin.request(action, values)` and the card's display scope.
Creating the adapter does not call the host or grant permissions. Declaring the
component's required actions and capabilities remains mandatory; the host independently
checks the pinned card, session, project and item identity before executing them.
`Results` title buttons send only the bound paper ID, never a guest-provided URL.
Missing/unsafe source addresses disable source navigation. Both source and current-result
navigation retain the card on failure and retry from the original control.

`Markdown` consumes the original answer renderer's props, including `text`, `math`,
citation mapping and evidence annotations. Its required `onOpenExternal` callback
and optional `onOpenSessionFile` callback must use declared host operations.
Without a navigation callback, ordinary external links render as text. The shared implementation never opens windows or calls the Desktop bridge itself;
the host's existing `Markdown` adapter retains its original navigation behavior.
Math, GFM tables, code and annotation rendering share the same source, but this is
not yet the demo's complete formula/code toolbar or image and chart experience.

Declare every consumed export in the research plugin's `ui.exports`, with
`compatibility: "2.0"`. Import values from `window.scholarseedUI`, not a new React
bundle, the parent document, or Desktop internals. `Card`, form controls, tables,
menus and dialogs can be composed in arbitrary layouts; they are not public slot
registrations and do not claim a new business capability.

`DropdownMenuSubTrigger` opens on click or ArrowRight; set `openOnHover` explicitly
when hover expansion is required. Dialogs and menus remain within the isolated
frame, including their portals. Closing a local dialog is not an AI response.
Use `save` for drafts, `submit` for the declared answer, and `request` for a declared
host operation. Submission completion comes through `onState`, not the return
value of `submit`. Only the host can authorize or execute a business operation.

`catalog.test.cjs` checks the packaged directory and its integrity inventory.
`sdk.test.cjs` exercises composition in an opaque-origin iframe with scripts only:
nested menu, dialog, draft persistence and answer submission. This is deterministic
component regression with fixture responses, not real Desktop or model acceptance.

## Compatibility and security

`Images`, `ImageThumbnail` and `ImageView` are no longer official Conversation
exports or standalone preview entries. Their native shared implementations remain
available to Desktop answers, artifacts and the workbench. Markdown image-link
detection and single/group presentation are planned separately; withdrawing these
SDK entries does not claim that Markdown image grouping has been implemented.
Remote image authorization and CSP remain host-owned and are not relaxed by this
scope change.

`Conversation.CitationLink` and `CitationSources` share the
host's complete evidence preview, mixed-source directory, verification dialog and
retry UI. Receipt resolution, answer hashing/range binding, authenticated preview
URLs and workspace navigation remain in the host adapter. Inject those operations
through the documented callbacks; never treat a source marked `exact` by frontend
data as permission to read it. Web opening receives the original URL, while its
display may decode readable text. `sourceKey` binds a directory to its answer;
refresh failures preserve known sources with explicit stale-state feedback.
`CitationSources.sourceIconUrl` optionally maps a web source URL to a host-controlled
favicon URL. The host owns network policy; unavailable icons use a globe, never
domain initials. The summary stacks 16px icons with 6px overlap and reserves the
third slot for overflow when there are more than three sources.
Raster icons are included in the resource bundle, not resolved in the consuming
plugin's directory. No host API/store implementation is bundled by these exports.

`Conversation.Artifact` and `Conversation.ArtifactMenuItems` share Desktop's
artifact card, exact version selection and full nested menus. Menu expansion and
closing belong to the view; opening, saving, importing, application discovery and
integrity checks stay in caller-supplied host callbacks. The host supplies operation
feedback through `children`. Displaying a card grants no file or application access.

`Conversation.ArtifactDestination` is the same resource/literature destination
dialog used by Desktop. `location` and `onLocationChange` keep filename/folder
selection controlled; draft-folder creation is only a selection until the host
validates and executes `onSubmit`. `saving`, `error` and `onOpenChange` preserve
pending, failure/retry and cancel behavior. Preview callbacks must return sample
responses, never call real import/save operations. This shared view does not add
new plugin permissions or imply that every artifact viewer is migrated.

`Conversation.FileMenuItems` is the same menu implementation as
`ArtifactMenuItems`, usable under `DropdownMenu`, `ContextMenu` or `Menubar`.
It provides complete open-with submenus and optional `onOpen`, `onImport` and
`onSaveAs` ports; `showSaveAs={false}` omits an operation the host does not offer.
`directory` restricts the menu to reveal/copy only. `canUsePath`, `canImport`,
`canSaveAs` and `downloading` are host-projected availability, never authorization.
`emptyApps` preserves the host's full empty-state content. File/application
discovery and business feedback remain host-owned. The native workspace menu
uses this view without changing its file operations. Sent attachments still
require their own source-authorized operations; they do not gain path authority
by using this view.

The public controls include these context/menubar families as well as dropdowns.
Selecting a terminal submenu item closes its menu chain; Escape dismisses only
the focused submenu and leaves its parent available. Independent nested roots
are not implicitly members of that chain. Preview ports must record sample
responses instead of calling native file operations.

`Conversation.ArtifactGroup` arranges separate artifact-card children side by
side and wraps them within the available width. It adds no batch title, import
or open action. Supply one direct child per artifact; retain each child's own
identity and operation state. Images and auxiliary path links keep their own
presentations rather than becoming duplicate file cards. Empty groups render
nothing. Cards use at most two columns. A single card or the unpaired card in the
last row fills the available width. Narrow containers use one column.
`fileLayout` is accepted for compatibility. Opening uses the split control, and
permitted imports appear as a separate text button. A folder card sets
`menuProps.directory` so its icon and menu
retain directory semantics. The host must supply the permitted file operations.
For a separate image block, pass `images` and optional `renderImageActions`;
one image is large, two or three are side by side, and four or more use the
scrollable shared gallery. The host resolves image URLs and permitted actions.
The preview JSON accepts `kind: image` and an optional `image_url`; consecutive
image and file/folder blocks stay in their supplied order.

`Conversation.Message` preserves literal user text instead of interpreting Markdown.
Long messages expand/collapse without changing the copied source; HTTP(S) links
keep their original destination and use an explicit `onOpenExternal` callback.
No callback means plain text, not a dead or privileged link. `onCopy` is similarly
host-controlled. Optional `header`/`children` compose context and attachments;
the host retains their object identity, permissions and existing rewind flow.
Only supplied durable `timestamp` values are shown; the component invents no time.

`Conversation.Tabulation` supplies the shared table frame, horizontal scrolling,
sticky first-column context, caption/notes and controlled copying. Markdown tables
use the same frame: TSV retains displayed values, quotes embedded separators and
newlines, and keeps citation text; numeric columns align right without inventing
missing values or stripping source interactions. Detectable unparsed table syntax
retains its original source with a warning. `invalidSource` uses raw-source copying,
not a fabricated TSV. The caller supplies `onCopy`; no clipboard privilege is added.

The standalone `Tabulation` preview accepts `dataset` plus optional `caption`,
`notes`, `sources` and `citations`. A citation is `{rowId, columnKey, sourceNumber}`
and refers to a numbered entry in `sources`; unknown rows, columns and sources
are rejected. The adapter composes official `CitationLink` web-source cells and a
`CitationSources` summary rather than inventing a second citation renderer.
The public `Tabulation` remains a frame for caller-supplied table children;
its existing `notes` prop is forwarded by the preview. Notes render as literal text
below the table within its frame, preserving newlines;
omitted or empty notes add no footer. Notes are not parsed as HTML or added as data cells.
Column units and missing values remain visible and are preserved in the table's TSV copy text.
Typography and surface styling belong to the shared Desktop `Tabulation` frame;
the preview does not impose a separate header weight or first-column background.
Wide tables scroll horizontally with a sticky first column; long tables use a
bounded two-axis `ScrollArea` with sticky column headings. The preview's grid
item can shrink, so wide tables and long formulas no longer widen the answer.

`Conversation.Formula` renders untrusted LaTeX with KaTeX trust disabled. Optional
`caption` and `notes` may be omitted or empty, including in live-preview JSON.
Without a caption, no title row is reserved; the view/source/copy toolbar appears
on hover or keyboard focus. Notes support Markdown math with `$...$`, `$$...$$`,
`\(...\)` and `\[...\]`, retaining symbol, unit and assumption explanations.
No automatic validation footer is appended: rendering does not validate mathematics,
and the producer supplies any verification caveat in `notes` or the surrounding answer.
Block math in `Conversation.Markdown`
uses this same component. Parse errors retain the original source and copy action;
an outlined warning precedes the source, the frame marks the error, and the source
toolbar remains visible. Invalid JSON is a separate editor error: escape every
LaTeX backslash as `\\` in JSON strings (or construct the JSON with `JSON.stringify`).
Inline math, currency and code stay on their existing parsing path. The `onCopy`
port receives `(source, html?)`: both views provide editable MathML/HTML for valid
formulas. Plain text contains display delimiters in the formula view and bare
LaTeX in the source view. Parse failures provide only the original source, without
MathML/HTML. Desktop supplies
its existing rich clipboard writer; isolated consumers still need an authorized
host port. No native clipboard permission is added by importing the component.

有效公式的两种视图都会通过 `onCopy(source, html?)` 提供可编辑的 MathML/HTML；
纯文本在公式视图带显示分隔符，在源码视图保留裸 LaTeX。解析失败仅提供原始源码，
不附带 MathML/HTML。Desktop 使用既有富文本剪贴板；隔离消费者仍须提供授权宿主端口，
导入组件不会增加原生剪贴板权限。

Markdown fenced code displays source, language and a collapsible full-line view.
Fences accept arbitrary language names, not only Python and plain text;
the existing highlight.js renderer handles known languages and retains unknown
languages as literal text. JSON escaping must not insert stray backslashes into
the code itself; an unclosed string can legitimately color subsequent lines as
string content.

All ten named charts use the shared `Plot` frame: muted header, persistent
figure/data tabs, enlargement dialog and optional `notes` footer. The same dataset
and controlled row IDs survive switching views. The common frame does not claim
every chart's axes, palette or tooltip are pixel-identical to a demo bar chart.
Code fences never execute commands or claim an execution result. `onCopy` receives
the complete original source, including trailing newlines, without line numbers.
`Conversation.Markdown` uses the same component for fenced blocks and accepts the
same `onCopy` port. Desktop's Markdown wrapper supplies its existing clipboard
writer; the isolated SDK does not acquire Desktop clipboard access or add a new
host capability. Without a copy port, no nonfunctional copy button is shown.

`Conversation.FileFormatIcon` retains the existing format mapping for answer and artifact files.
`IconButton` remains available for compact file/menu actions; neither export grants
file access.

Compatibility `2.0` describes the exported API and interaction semantics. Resource
`version` identifies a release; the host also fixes its byte fingerprint for each
interaction. Updating the active system dependency must not replace the runtime of
an existing frame or reinterpret its action. This package does not grant direct
HTTP, filesystem, Electron or parent-DOM access.

Search summary/details, references, downloads and delivery retain their research entries. Question, authorization and selection remain native host flows, not SDK entries. Contract tests and preview simulation do not replace real product verification.

## Content composition

Markdown `mermaid` fences use the existing native diagram renderer. It keeps
strict rendering and locks site configuration against source directives.
The resulting SVG is an image resource, not executable markup inserted into the
answer DOM. Source switching, complete copying and the shared image zoom remain
available; render errors preserve the source in that diagram only.
The isolated package build replaces the renderer library's direct `window.open`
primitive with an explicit denied operation. Strict configuration and inert SVG
are still required; actual navigation only uses declared host ports.

Markdown code fences highlight recognized languages, preserve literal text and
multiline syntax, and falls back to plain text for unknown languages. Highlighting
never changes the source sent to the caller's copy port.

Code and Diagram are no longer independent official exports or preview entries.
Use `Conversation.Markdown` with fenced code/Mermaid instead. Native renderers and historical frozen resources remain;
`Conversation.Formula` remains available with its caption and explanatory notes.

Code 和 Diagram 不再作为官方独立导出或预览入口；改用 Markdown 及其代码、mermaid
围栏。Content 已移除。保留原生渲染和历史冻结资源；Formula 保留公式、
标题与说明能力。

### Script-generated request data / 脚本生成请求数据

The model-facing `scholarseed_bridge` accepts exactly one of `request` (an object)
or `request_file` (a JSON file inside the session working directory). Existing
inline requests remain supported. A file contains the complete operation request,
not the outer capability/operation envelope and not a bare Dataset. Relative paths
start at the session working directory; absolute paths must remain inside it.
Links and non-regular files are not accepted. The same operation validation and
authorization apply after reading. No Bridge credentials enter the script.

For Plot, have Python/Bash calculate the values and serialize the complete request
using the current component contract. Print only the output path and a small
summary, then call, for example:

```json
{
  "capability": "component",
  "operation": "display",
  "request_file": "output/plot-request.json"
}
```

The file contains `{request_id,title,slot:"plot.view",data:{model:{kind,dataset,x,y}}}`.
Use `table.view` for `{dataset}`, `formula.view` for `{source,caption?,notes?}` and
`markdown.view` for `{text}`. Selection results use `{selected:[row IDs]}`.
文件使用独立 plot.view/table.view/formula.view/markdown.view 契约，不再经过 Content。
Bridge reads the values directly without model transcription. The published card
retains its data snapshot after the source file changes. Component display returns
card identity and component metadata, not the complete dataset. Request, Dataset
capacity and card-publication byte ceilings are removed; structural and mathematical
validation, authorization and response-size policies remain. This does not promise
unlimited browser memory or rendering performance.

`scholarseed_bridge` 支持内联 `request` 或文件 `request_file`，两者二选一。文件需位于
当前会话工作目录，包含完整业务请求，不是外层 capability/operation，也不只是 Dataset。
相对路径以会话工作目录为基准；绝对路径也必须位于该目录。拒绝链接和非普通文件，读取后
沿用相同操作校验和授权。Python/Bash 计算并序列化数值，只输出路径和简短摘要；Agent
传递文件引用，不逐点转写数据，也不向脚本传入 Bridge 凭据。发布卡片保留当时的数据快照，
修改源文件不改变旧卡片；显示调用仅返回卡片身份和组件信息。移除请求、Dataset 容量和卡片
发布字节上限，保留结构、数学语义、授权及响应大小约束；不承诺浏览器内存或渲染性能无限。

`Conversation.Canvas` now takes a task `document`, not children. Discover
`component/catalog` with `{slot:"canvas.ui",include_ui:true,ui_mode:"canvas"}`.
The separate Canvas library reuses OpenUI Renderer, named fields, local bindings
and the existing theme. Ordinary `conversation.ui` remains display-only.

Canvas data is `{format:"openui-lang"|"html",version:1,source,initial_state?,interaction?}`.
Use display without interaction, or request with `{actions,output_schema}` to wait
for a decision. Host-owned rollback/cancel/submit buttons are optional; rollback
never resumes the Agent. Submission unwraps OpenUI field values and resumes only
after backend validation and acknowledgement. Cancellation returns cancelled,
without unsaved values. HTML uses an opaque sandbox and
`canvas.register({onRestore,onRollback,onCancel,onSubmit})`; `canvas.save(json)`
persists drafts. It has no network, filesystem, native or parent-DOM privileges.
The native host moves one retained runtime between conversation and workbench;
reopening restores saved JSON, not arbitrary JavaScript closures. Executable
plugin frames do not gain nested-frame or Worker permissions from this export.

Canvas 改为任务 document，不再接收 children。OpenUI 优先，特殊行为使用 HTML 沙箱。
展示型不等待；声明 interaction 的请求才挂起 Agent，并按声明显示宿主按钮。撤销只改变
本地状态；提交经输出校验及后端确认后继续，取消不提交未保存值。对话与工作台复用同一
运行实例，重开恢复 JSON 草稿，不承诺恢复任意 JS 闭包。普通 conversation.ui 的只读边界不变。

The standalone official `Lean` export is retired. Publish Lean files and open them
through `Artifact`; Desktop opens `.lean` sources in its standard Monaco code editor,
with no dedicated Lean workspace or diagnostics surface. No standalone proof-checking
or service installation is implied.

The redundant `EvidenceSelection` and `ArtifactPreview` exports, composition slots,
schemas and generated plugin entries are removed. Source excerpts use Markdown and
unified citations; file previews use `Artifact` / `ArtifactGroup`. Native shared
capabilities and historical frozen SDK revisions are not overwritten.

The whole resource library is catalogued by bounded families, including Runtime
exports. The host checks exact export coverage, family/export uniqueness and
per-family limits under the existing 64KiB descriptor/catalog byte limits.
Individual plugin declarations keep their original limit; increasing the library
does not increase a plugin's capabilities or action allowance.

Official resources are distributed only with Desktop. The ordinary plugin upload
and confirmation routes reject UI archives; there is no user-facing update entry.
Startup validates the bundled archive and reconciles it with the active dependency.
Existing interaction snapshots retain their resource bytes and choices. This does
not compile the resource package back into the host renderer or allow arbitrary
local packages to claim official status.

The host retains its original selector solely for existing `host-v1` bindings,
whose historical records have no resource snapshot. This compatibility copy is
registered as `legacyOnly`; it cannot service new bindings or resource-less
previews. New selection cards use the independent official package. Retaining an
old bound interaction does not authorize falling back to host code when a new
resource dependency is missing.

## Product operations and typed data

`node packages/ui/plugins.cjs HOST_VERSION` builds the conversation components in
`scholarseed-product-operations` from the official schemas and tiny runtime consumers.
The three composition slots share this single Skill; detailed instructions, request
schemas and examples are progressively loaded from its references. Complete official
card discovery comes from `component/catalog` with `include_ui:true`, not a duplicated
Skill inventory. Custom card authoring uses the existing `plugin-create` workflow.
Compiled entries include neither React nor component implementations. Descriptors,
sample-only previews and request schemas derive from `schemas.ts`; normal pack/source
inventory tooling still freezes the unified distributable. The category exports are named
top-level dependencies, so older UI resources fail closed instead of accepting a
generic Conversation export that lacks the required members.
Discover HOST_VERSION from the actual plugin author contract, not Desktop's version.
The generated descriptor is restricted to that exact verified host version.

`component/catalog` with `include_ui:true` discovers the schemas under local `$defs`
and the individual chart composition entries. Dataset rows have stable IDs and an
array of literal values matching the declared columns. Chart mappings use zero-based
column indices. ECharts imports only registered two-dimensional chart modules and
the SVG renderer; raw ECharts options, executable formatters, remote resources and
automatic downloads are not accepted. The resource includes the newly bundled
libraries' license texts in its integrity inventory.

`Plot` and ten named chart components share one dataset with `DataTable`. Sorting,
pagination and row selection use TanStack Table and official controls. Plot data
views omit filtering and show all rows without pagination controls at ten rows or
fewer; larger datasets use ten rows per page. The shared DataTable retains its
standalone defaults (filtering, twenty rows per page and pagination controls), with
optional `filterable`, `pageSize` and `hideSinglePage` presentation props.
In a plot's data view, select a row by clicking it or focusing it and pressing
Enter or Space; the standalone DataTable retains its checkbox controls.
Generic `Plot` renders one model at a time, selecting the renderer from
`model.kind`; each named chart is a kind-constrained wrapper of the same frame.
It can switch among the supported types through data, not display all ten charts
simultaneously inside one plot.
Histogram bins retain their original member IDs; box plots require explicit ordered
five-number summaries. No frontend calculation establishes statistical significance.
Local interactions save JSON drafts; only a declared explicit continuation submits
the selection. Display publication is not evidence that a user submitted a choice.

Evidence selection preserves literal supplied excerpts with an unverified-source
notice. Public research cards still use authoritative literature tools. Artifact
previews preserve their domain views, but real file publication and workbench
navigation retain their original host contracts. These previews do not by themselves
complete the pending source-authorized file actions, exact locator recovery, general
configurable chart export or Lean-service integration.
