import { UI_REGISTRY } from '../../apps/desktop/src/renderer/src/components/ui/registry'
import manifest from './manifest.json'
import { schemaCatalog } from './schemas'
import type * as Conversation from './conversation'

const conversation = {
  Plot: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport', 'framed'], use: 'Interactive ECharts SVG chart with data/table switching, legend, zoom and keyboard selection. Export SVG directly opens the host save picker on a current-revision trusted click and saves the chart without surrounding notes, sources, script or version; no direct downloads, filesystem, raw option, network or links. Selection and export never advance an Agent.' },
  BarChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Single-series column chart; model kind fixed to bar. Preserve negatives, zero, gaps and source row IDs.' },
  GroupedBarChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Grouped columns with category x and explicitly named y fields.' },
  StackedBarChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Stacked columns; producer must establish comparable units and denominators.' },
  LineChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Line series preserving gaps and source ordering.' },
  ScatterChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Numeric x/y scatter with source-ID selection; no inferred correlation or causation.' },
  PieChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Non-negative pie slices; reject missing or negative values.' },
  DonutChart: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Non-negative donut slices with original source-ID selection.' },
  Histogram: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Equal-width bins over numeric source values; explicit bin count, final upper endpoint included, original IDs returned for selected bins.' },
  BoxPlot: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Explicit minimum/Q1/median/Q3/maximum fields; require ordered values, never infer a statistical convention.' },
  Heatmap: { inputs: ['model', 'title', 'notes', 'sources', 'script', 'version', 'selected', 'onSelectionChange', 'onCopy', 'onExport'], use: 'Category x/y and numeric value field, color mapping and source-ID selection.' },
  DataTable: { inputs: ['dataset', 'selected', 'onSelectionChange', 'onCopy', 'rowSelectionMode', 'filterable', 'pageSize', 'hideSinglePage'], use: 'TanStack Table with official controls, sorting, optional filtering and configurable pagination, and source-ID selection. Defaults retain filtering, 20 rows and pagination controls; Plot uses no filter, ten rows and no single-page controls. Missing is not zero; TSV escapes string formulas.' },
  CitationLink: { inputs: ['resolve', 'reveal', 'previewUrl', 'isUnverifiable', 'children', 'displayNumber', 'onResolved', 'identity', 'source', 'named', 'openWebSource', 'references'], use: 'Unified file and web citation. references supplies ordered document identities, excerpts and individually revalidated resolvers for grouped citations. identity supplies initial title/path/bibliography presentation only; resolve still verifies every source operation against the current answer revision. Rendering is not authorization.' },
  CitationSources: { inputs: ['sourceKey', 'loadSources', 'resolveSource', 'reveal', 'previewUrl', 'isUnverifiable', 'openWebSource', 'answerSources', 'coverage', 'sourceIconUrl'], use: 'Shared mixed-source directory with coverage, stale-list feedback and per-source evidence. sourceKey identifies the bound answer scope; callbacks remain host-owned.' },
  ArtifactGroup: { inputs: ['children', 'fileLayout', 'images', 'renderImageActions'], use: 'Arrange one file-and-folder or preview block without batch actions. The host groups PDF first-page previews and images together, preserving JSON order; PDFs open in the document workbench and only images join the image viewer. Cards use at most two columns, and an unpaired card fills its row. fileLayout is accepted for compatibility. The host owns URLs, previews, ordering and access authorization.' },
  ArtifactDestination: { inputs: ['open', 'onOpenChange', 'title', 'description', 'summary', 'projectName', 'projectOptions', 'selectedProjectId', 'onProjectChange', 'tree', 'location', 'onLocationChange', 'fixedSuffix', 'error', 'saving', 'onSubmit', 'submitLabel', 'submitDisabled', 'destination', 'onDestinationChange', 'literatureContent', 'rootLabel'], use: 'Shared resource/literature destination dialog with folder selection and draft folders. Selection is not saving; only the host performs and validates the submitted operation.' },
  Artifact: { inputs: ['primary', 'versions', 'primaryMeta', 'canImport', 'menuProps', 'preview', 'previewVersion', 'openImport', 'children'], use: 'Shared artifact card with exact version selection, open/import ports and full context/overflow menus. Menu expansion belongs to the view; host retains integrity, file operations and result state.' },
  ArtifactMenuItems: { inputs: ['kind', 'apps', 'appsLoading', 'canSaveAs', 'canUsePath', 'downloading', 'loadApps', 'onCopyPath', 'onOpenWith', 'onReveal', 'onSaveAs', 'revealLabel', 'overview', 'onImport', 'canImport'], use: 'Same nested artifact menu in dropdown or context-menu providers. File and application operations are host callbacks, never implicit permissions.' },
  FileMenuItems: { inputs: ['kind', 'apps', 'appsLoading', 'canSaveAs', 'canUsePath', 'downloading', 'loadApps', 'onCopyPath', 'onOpenWith', 'onReveal', 'onSaveAs', 'revealLabel', 'overview', 'onImport', 'canImport', 'directory', 'onOpen', 'showSaveAs', 'emptyApps'], use: 'Shared full file actions in dropdown/context providers, including keyboard-accessible application submenus. Directory mode supports an explicit host open action and host-authorized reveal/copy; it never grants file import/save. ArtifactMenuItems is the same implementation, not a permission grant.' },
  Tabulation: { inputs: ['children', 'copyText', 'sourceMarkdown', 'invalidSource', 'caption', 'notes', 'onCopy'], use: 'Shared table frame with sticky context, horizontal reading and host-controlled TSV copy; sourceMarkdown registers the original table citation links for the answer-level source directory. It does not verify or authorize a source. Invalid syntax preserves and copies the original source.' },
  Formula: { inputs: ['source', 'caption', 'notes', 'onCopy'], use: 'Formula and LaTeX views, original source on parse failure, host-controlled text/MathML copy. Rendering is not mathematical verification.' },
  Canvas: { inputs: ['document', 'title', 'draft', 'status', 'full', 'onOpen', 'onDraft', 'onAction'], use: 'Task Canvas: OpenUI-first interactive content, or isolated HTML/JavaScript. Optional host rollback/cancel/submit actions; local edits never resume the Agent. The host preserves one instance across conversation and workbench.' },
  FileFormatIcon: { inputs: ['name', 'size', 'strokeWidth'], use: 'Existing file-format visual mapping, not a file access or preview permission.' },
  Results: { inputs: ['content', 'ports'], use: 'Search summary with bound-paper source navigation, current-result details and inline failure/retry. Host validates every destination and operation.' },
  Details: { inputs: ['content', 'ports'], use: 'Complete search results with filtering and admission actions.' },
  Downloads: { inputs: ['content', 'ports'], use: 'Download outcomes and full-text/library navigation.' },
  Delivery: { inputs: ['content', 'ports'], use: 'Delivery state, destination selection, save and cancel.' },
  Review: { inputs: ['content', 'ports'], use: 'Review checks, issues and output artifacts.' },
  Markdown: { inputs: ['text', 'onOpenExternal', 'onCopy', 'citationGroupKeys', 'renderCitationGroup'], use: 'Answer body with optional math, citation mapping, annotations, code copying and session-file callbacks. citationGroupKeys groups registered references of the same host-defined type within each paragraph; renderCitationGroup retains every original source range.' },
} satisfies Record<keyof typeof Conversation, { inputs: string[]; use: string }>

const declared = new Set(manifest.exports)

export const catalog = {
  schema: 1,
  id: manifest.id,
  version: manifest.version,
  compatibility: manifest.compatibility,
  grantsPermissions: false,
  exports: manifest.exports,
  families: [{
    name: 'Runtime',
    exports: ['React', 'mount', 'useTranslation', 'useCopyContent', 'catalog', 'Conversation', 'Plot', 'DataTable', 'createLiteraturePorts'],
    intents: ['composition', 'runtime', 'discovery', 'translation', 'bridge'],
    use: 'Isolated rendering, shared conversation components and declared bridge adapters. Discovery grants no permissions.',
    replaces: [],
    avoid: 'No host API, filesystem, network or parent DOM access.',
  }, ...Object.entries(UI_REGISTRY).flatMap(([name, family]) => {
    const exports = family.exports.filter(entry => declared.has(entry))
    return exports.length ? [{ name, ...family, exports }] : []
  })],
  components: manifest.components,
  composition: { Conversation: conversation },
  schemas: schemaCatalog,
  adapters: {
    useCopyContent: { inputs: ['text'], use: 'Inside mount, merge additional custom business text with the automatic body, research, chart, data table, content and artifact registrations. Declare this export; do not mix with frame-replacing setCopyContent. The host copies the whole reply, not individual cards. No clipboard permission.' },
    createLiteraturePorts: { inputs: ['request', 'scope'], use: 'Typed literature operation adapter. Pass the declared plugin.request bridge and display scope; this helper grants no permission and performs no operation when constructed.' },
  },
  bridge: {
    exportPlot: { input: '{svg}', result: '{ok, canceled?, error?}', authorization: 'current frame, live binding, revision and trusted click; host accepts only static SVG geometry and local fragment references, then opens the native save picker; no executable markup, external references, paths or download permission' },
    copyText: { input: 'text', result: '{copied:true}', authorization: 'current frame, binding, revision and trusted user gesture; write-only plain text, no clipboard read permission' },
    copyPlot: { input: '{svg}', result: '{ok, error?}', authorization: 'current frame, live binding, revision and trusted click; validated static SVG is rasterized into a transparent PNG for the system clipboard; no clipboard read permission' },
    onState: { subscription: 'latest snapshot, then updates', cleanup: 'unsubscribe on unmount' },
    save: { result: '{state, revision}', advancesWorkflow: false },
    setCopyContent: { input: '{text, markdown?}', result: 'Promise of persisted card text registration', clipboardAccess: false, revision: 'current saved draft revision' },
    submit: { result: 'void', completion: 'onState', authorization: 'host' },
    request: { result: 'Promise of declared host operation result', authorization: 'host' },
  },
} as const
