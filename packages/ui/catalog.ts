import { UI_REGISTRY } from '../../apps/desktop/src/renderer/src/components/ui/registry'
import manifest from './manifest.json'
import type * as Conversation from './conversation'

const conversation = {
  ExecutionBatch: { inputs: ['label', 'state', 'title', 'accessibleLabel', 'turnId', 'expanded', 'onExpandedChange', 'failed', 'running', 'locked', 'animated', 'children'], use: 'Complete controlled execution-history disclosure. Compose nested batches/steps or narration; expansion never executes tools, alters records or implies a terminal outcome. Host provides live/terminal state and actual time.' },
  ExecutionProcess: { inputs: ['outcome', 'turnId', 'reveal', 'children'], use: 'Whole process presentation with authoritative turn outcome. Running stays open; settled history can be expanded, and explicit source navigation reveals it without executing anything. No duration on the outer surface; unknown never implies completion.' },
  ToolExecution: { inputs: ['data', 'groupOpen', 'actions'], use: 'Complete tool step with host-projected name, label, status, failure, summary, preview, duration, input/output and exitCode. Preserves technical disclosure and authorized action content; does not execute or retry tools itself.' },
  ExecutionStatus: { inputs: ['status'], use: 'Shared running/done/error/cancelled visual indicator. Host execution state is authoritative.' },
  ExecutionIO: { inputs: ['label', 'text', 'err'], use: 'Complete literal input/output with bounded scrolling; no parsing, truncation or execution.' },
  WebSearchRecord: { inputs: ['title', 'queries', 'page', 'pattern', 'results', 'status', 'groupOpen', 'defaultExpanded', 'initialVisibleResults', 'onOpenResult'], use: 'Complete web tool record with actual queries, ordered results, local more/collapse and controlled original-page opening. Host validates external destinations; opening failures retain results for retry. This is execution history, not answer sources.' },
  Images: { inputs: ['items', 'renderActions', 'selection', 'thumbnails'], use: 'Ordered image group and shared viewer. Each item has an immutable id, title and authorized URL or loading/failure state. Optional selection {id,onChange} connects separate cards to one viewer; thumbnails=false suppresses only duplicate thumbnail rendering. Actions receive the selected original item; the view never grants file access.' },
  ImageThumbnail: { inputs: ['item', 'onOpen'], use: 'Shared thumbnail with loading/failure feedback. Compose with a controlled Images viewer; opening does not grant file authority.' },
  ConversationReference: { inputs: ['id', 'label', 'title', 'canPreview', 'loaded', 'loading', 'changed', 'messages', 'error', 'onOpen', 'onMore'], use: 'Complete conversation-reference popover with literal messages, changed-source notice, pagination and load errors. The host supplies an authorized source snapshot and callbacks; UI cannot authorize or fetch another session.' },
  ComposerRefChip: { inputs: ['icon', 'label', 'suffix', 'closeLabel', 'onClose'], use: 'Existing composer context chip. Removal is separate from opening or sending; preserve the underlying source category and identity.' },
  ImageView: { inputs: ['url', 'title', 'failed', 'viewState', 'onViewChange'], use: 'Shared read-only image viewer with dimensions, fit, zoom and dragging. The host supplies an authorized resource and persists view state; display does not prove AI recognition or grant file actions.' },
  CitationLink: { inputs: ['resolve', 'reveal', 'previewUrl', 'isUnverifiable', 'children', 'displayNumber', 'onResolved'], use: 'Receipt-bound citation preview, verification, original opening and retry. The host resolves the current answer revision and authorizes every source operation; rendering is not authorization.' },
  CitationSources: { inputs: ['sourceKey', 'loadSources', 'resolveSource', 'reveal', 'previewUrl', 'isUnverifiable', 'openWebSource', 'answerSources', 'coverage'], use: 'Shared mixed-source directory with coverage, stale-list feedback and per-source evidence. sourceKey identifies the bound answer scope; callbacks remain host-owned.' },
  WebCitationLink: { inputs: ['source', 'named', 'openWebSource'], use: 'Web-source popover preserves search/evidence provenance and the original URL. Opening is an explicit host callback, not an implicit external-navigation permission.' },
  ArtifactGroup: { inputs: ['children', 'stacked'], use: 'Separate complete artifact cards in a wrapping grid, or a bounded single column when stacked. Each direct child retains its own identity, permissions and operation results; images and auxiliary links remain their respective components.' },
  ArtifactDestination: { inputs: ['open', 'onOpenChange', 'title', 'description', 'summary', 'projectName', 'projectOptions', 'selectedProjectId', 'onProjectChange', 'tree', 'location', 'onLocationChange', 'fixedSuffix', 'error', 'saving', 'onSubmit', 'submitLabel', 'submitDisabled', 'destination', 'onDestinationChange', 'literatureContent', 'rootLabel'], use: 'Shared resource/literature destination dialog with folder selection and draft folders. Selection is not saving; only the host performs and validates the submitted operation.' },
  Artifact: { inputs: ['primary', 'versions', 'primaryMeta', 'canImport', 'menuProps', 'preview', 'previewVersion', 'openImport', 'children'], use: 'Shared artifact card with exact version selection, open/import ports and full context/overflow menus. Menu expansion belongs to the view; host retains integrity, file operations and result state.' },
  ArtifactMenuItems: { inputs: ['kind', 'apps', 'appsLoading', 'canSaveAs', 'canUsePath', 'downloading', 'loadApps', 'onCopyPath', 'onOpenWith', 'onReveal', 'onSaveAs', 'revealLabel', 'overview', 'onImport', 'canImport'], use: 'Same nested artifact menu in dropdown or context-menu providers. File and application operations are host callbacks, never implicit permissions.' },
  Tabulation: { inputs: ['children', 'copyText', 'invalidSource', 'caption', 'notes', 'onCopy'], use: 'Shared table frame with sticky context, horizontal reading and host-controlled TSV copy; retain cell provenance in children. Invalid syntax preserves and copies the original source.' },
  Message: { inputs: ['text', 'timestamp', 'header', 'children', 'steering', 'onCopy', 'onOpenExternal'], use: 'Literal user message with complete copying, expandable long text and controlled HTTP links. Host retains context identity, rewind and attachment permissions.' },
  Formula: { inputs: ['source', 'caption', 'notes', 'onCopy'], use: 'Formula and LaTeX views, original source on parse failure, host-controlled text/MathML copy. Rendering is not mathematical verification.' },
  Code: { inputs: ['code', 'language', 'mode', 'onCopy'], use: 'Complete source with folding and host-controlled copying; command/output display is not execution.' },
  Failure: { inputs: ['item', 'failureText', 'recoveryAvailable', 'onContinue', 'actionError', 'onRepair'], use: 'Controlled failure and interruption states; the host authorizes continuation and authentication repair.' },
  Plan: { inputs: ['id', 'items', 'summary', 'elapsedMilliseconds', 'estimateLabel', 'activeLabel', 'canContinue', 'onContinue'], use: 'Controlled execution plan with nested steps and host continuation; no session store or execution engine.' },
  Attachments: { inputs: ['refs', 'openPaths', 'onOpen', 'onRemove', 'renderActions'], use: 'File and directory chips; host-controlled open state and authorized operation callbacks.' },
  FileFormatIcon: { inputs: ['name', 'size', 'strokeWidth'], use: 'Existing file-format visual mapping, not a file access or preview permission.' },
  Suggestions: { inputs: ['payload', 'available', 'busy', 'failed', 'draft', 'onDraft', 'onSend'], use: 'Controlled next-step suggestions; the host validates session identity and accepts submission.' },
  Choices: { inputs: ['data', 'status', 'slot', 'submit'], use: 'Question choices and authorization scope; submit is not host approval.' },
  Results: { inputs: ['content', 'ports'], use: 'Search summary; opens details for the current result set.' },
  Details: { inputs: ['content', 'ports'], use: 'Complete search results with filtering and admission actions.' },
  References: { inputs: ['content', 'ports'], use: 'Searchable references and nested collection actions.' },
  Downloads: { inputs: ['content', 'ports'], use: 'Download outcomes and full-text/library navigation.' },
  Delivery: { inputs: ['content', 'ports'], use: 'Delivery state, destination selection, save and cancel.' },
  Review: { inputs: ['content', 'ports'], use: 'Review checks, issues and output artifacts.' },
  Markdown: { inputs: ['text', 'onOpenExternal', 'onCopy'], use: 'Answer body with optional math, citation mapping, annotations, code copying and session-file callbacks.' },
} satisfies Record<keyof typeof Conversation, { inputs: string[]; use: string }>

const declared = new Set(manifest.exports)

export const catalog = {
  schema: 1,
  id: manifest.id,
  version: manifest.version,
  compatibility: manifest.compatibility,
  grantsPermissions: false,
  exports: manifest.exports,
  families: Object.entries(UI_REGISTRY).flatMap(([name, family]) => {
    const exports = family.exports.filter(entry => declared.has(entry))
    return exports.length ? [{ name, ...family, exports }] : []
  }),
  components: manifest.components,
  composition: { Conversation: conversation },
  bridge: {
    onState: { subscription: 'latest snapshot, then updates', cleanup: 'unsubscribe on unmount' },
    save: { result: '{state, revision}', advancesWorkflow: false },
    setCopyContent: { input: '{text, markdown?}', result: 'Promise of persisted card text registration', clipboardAccess: false, revision: 'current saved draft revision' },
    submit: { result: 'void', completion: 'onState', authorization: 'host' },
    request: { result: 'Promise of declared host operation result', authorization: 'host' },
  },
} as const
