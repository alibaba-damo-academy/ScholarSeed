import { createContext, useContext, useSyncExternalStore } from 'react'

import {
  FIND_TEXT_REVEAL_KIND,
  type ContentKind,
  type FindTextReveal,
  type SelectionAnchor,
  type SessionFileSource,
  type ViewerKind,
} from '../../contracts/workbench.ts'
import {
  CITATION_VIEW_STATE_KEY,
  type CitationMatch,
  type CitationResolution,
} from '../../contracts/citations.ts'
import {
  commitDocument,
  createManagedCopy,
  documentIdFor,
  isDocumentLoadFailure,
  loadDocument,
  loadVersionCapability,
  type DocumentSource,
  type ProjectDocumentSource,
  type DocumentLoadFailure,
  type DocumentLoadResult,
  type LoadedDocument,
} from './api.ts'
import {
  adjacentLeaf,
  activateTab,
  findLeaf,
  firstLeaf,
  initialLayout,
  moveTargets,
  placeTab,
  reorderTabInLeaf,
  removeTabFromLayout,
  canPlaceTab,
  nodeTabCount,
  resizeSplit,
  type AdjacentDirection,
  type AdjacentLeaf,
  type DockArea,
  type DockLayout,
  type DockNode,
  type DropEdge,
  type TabInsertion,
} from './layout.ts'
import { usesLightweightTextState } from './limits.ts'
import { viewerExclusiveGroup, viewerPolicy } from './policy.ts'
import { reclaimDocumentResources, type DocumentResourceReclaimer } from './reclaim.ts'
import {
  DEFAULT_EDITOR_LIMIT,
  MAX_TEXT_HISTORY_BYTES,
  MAX_TEXT_HISTORY_ENTRIES,
  selectLruTabClosures,
  trimTextHistory,
  type TextHistoryState,
} from './residency.ts'
import { viewerForPath } from './tabs.ts'
import { previewFormat } from './preview/routing.ts'

const SPLIT_PROJECTION_SUFFIX = ':split'

export type DocumentViewKind = 'preview' | 'edit' | 'source'
export type DocumentNavigationView = 'resource' | 'literature'
export type DocumentLoadState = 'loading' | 'ready' | 'error'
export type DocumentSaveState = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error'
export type CloseChoice = 'save' | 'overwrite' | 'discard' | 'cancel'
export type TabCloseScope = 'current' | 'others' | 'left' | 'right' | 'all'
export type TabSplitDirection = 'right' | 'bottom'

export interface DocumentSession {
  id: string
  documentId: string
  source: DocumentSource
  title: string
  viewer: ViewerKind
  processor: LoadedDocument['processor']
  capabilities: LoadedDocument['capabilities']
  runtimeReadonlyReason?: string
  versioning: NonNullable<LoadedDocument['versioning']> | null
  revision: string
  mediaType: string
  contentKind: ContentKind | 'unknown'
  bytes: Uint8Array
  savedBytes: Uint8Array
  text: string | null
  savedText: string | null
  lightweightText: boolean
  loadState: DocumentLoadState
  loadFailure?: DocumentLoadFailure | null
  saveState: DocumentSaveState
  dirty: boolean
  changeVersion: number
  selection: SelectionAnchor | null
  externalChange: boolean
  deleted: boolean
  /** Verified attachment identities sharing this project's exact PDF revision. */
  attachmentIds?: string[]
}

export interface DocumentTab {
  titleFallback?: 'untitledArtifact' | { kind: 'reviewBaseline'; filename: string }
  id: string
  sessionId: string
  viewKind: DocumentViewKind
  navigationView?: DocumentNavigationView
  title: string
  /** Viewer-owned, immutable reading state; independent of the shared document bytes. */
  viewState?: Readonly<Record<string, unknown>>
  embedded?: boolean
  hostTabId?: string
  activeInHost?: boolean
}

export function documentNavigationView(
  tab: DocumentTab,
  session: DocumentSession
): DocumentNavigationView {
  if (session.source.kind === 'literature') return tab.navigationView ?? 'literature'
  if (session.source.kind === 'project') return 'resource'
  return tab.navigationView ?? 'resource'
}

export const DOCUMENT_TEXT_REVEAL_VIEW_STATE_KEY = 'documentTextReveal' as const

export interface DocumentTextRevealState extends FindTextReveal {
  sequence: number
}

export function documentTextReveal(
  tab: DocumentTab | null | undefined
): DocumentTextRevealState | null {
  const candidate = tab?.viewState?.[DOCUMENT_TEXT_REVEAL_VIEW_STATE_KEY]
  if (!candidate || typeof candidate !== 'object') return null
  const reveal = candidate as Partial<DocumentTextRevealState>
  if (
    reveal.kind !== FIND_TEXT_REVEAL_KIND ||
    typeof reveal.query !== 'string' ||
    !reveal.query.trim() ||
    typeof reveal.source_revision !== 'string' ||
    typeof reveal.sequence !== 'number' ||
    !Number.isSafeInteger(reveal.sequence) ||
    reveal.sequence < 1
  )
    return null
  return reveal as DocumentTextRevealState
}

export interface PendingClose {
  tabId: string
  sessionId: string
}

export interface FocusedLeaf {
  area: DockArea
  leafId: string
}

export interface ViewportPoint {
  x: number
  y: number
}

export interface ViewportRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface SelectionViewport {
  rect: ViewportRect
  point: ViewportPoint
  visible?: boolean
}

/**
 * A viewport projection is deliberately tab-scoped and short-lived. The
 * semantic anchor remains on DocumentSession because split views share one
 * document revision, while screen coordinates only make sense in one tab.
 */
export interface SelectionPresentation extends SelectionViewport {
  tabId: string
  fingerprint: string
}

export interface DocumentWorkspaceState {
  sessions: Record<string, DocumentSession>
  tabs: Record<string, DocumentTab>
  layout: DockLayout
  pendingClose: PendingClose | null
  pendingExclusiveOpen: { requestId: number; ownerTabId: string } | null
  focusedTabId: string | null
  focusedLeaf: FocusedLeaf | null
  selectionPresentations: Record<string, SelectionPresentation>
}

export interface FocusedSelectionPresentation {
  tab: DocumentTab
  session: DocumentSession
  selection: SelectionAnchor
  presentation: SelectionPresentation
}

export interface DocumentLoader {
  load(source: DocumentSource): Promise<DocumentLoadResult>
  versioning?(source: DocumentSource): Promise<NonNullable<LoadedDocument['versioning']> | null>
  commit(
    source: DocumentSource,
    bytes: Uint8Array,
    revision: string
  ): ReturnType<typeof commitDocument>
  createManagedCopy?(
    source: DocumentSource,
    bytes: Uint8Array,
    name: string
  ): ReturnType<typeof createManagedCopy>
}

export interface DocumentSaveDelegate {
  prepare?: () => void
  beforeSave?: () => Promise<void>
  serialize: () => Promise<Uint8Array | null>
}

export interface RestoredProjectFile {
  fileId: string
  versionId?: string
  previousPath: string
  path: string
  state: 'present' | 'tombstone'
}

export interface RestoreReconciliationResult {
  synchronized: string[]
  conflicted: string[]
  failed: string[]
}

type DocumentSaveDelegateInput = DocumentSaveDelegate | DocumentSaveDelegate['serialize']
type ExclusiveViewerClaim = (
  workspace: DocumentWorkspace,
  candidateTabId: string,
  group: string
) => boolean

const UTF8 = new TextDecoder()
const UTF8_ENCODER = new TextEncoder()
const TEXT_VIEWERS = new Set<ViewerKind>(['markdown', 'code'])
const SELECTION_FINGERPRINT_PREFIX = 'selection:'
const FNV_OFFSET_BASIS = 2166136261
const FNV_PRIME = 16777619
const HEX_RADIX = 16

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function selectionFingerprint(selection: SelectionAnchor): string {
  const source = canonicalValue(selection)
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }
  return `${SELECTION_FINGERPRINT_PREFIX}${(hash >>> 0).toString(HEX_RADIX)}`
}

export function selectionViewport(
  rect: Pick<ViewportRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  point: ViewportPoint = { x: rect.right, y: rect.bottom },
  visible = true
): SelectionViewport {
  return {
    rect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
    point,
    visible,
  }
}

export function focusedSelectionPresentation(
  state: DocumentWorkspaceState
): FocusedSelectionPresentation | null {
  const tab = state.focusedTabId ? state.tabs[state.focusedTabId] : null
  const session = tab ? state.sessions[tab.sessionId] : null
  const selection = session?.selection ?? null
  const presentation = tab ? state.selectionPresentations[tab.id] : null
  if (!tab || !session || !selection || !presentation) return null
  if (presentation.fingerprint !== selectionFingerprint(selection)) return null
  return { tab, session, selection, presentation }
}

interface DocumentWorkspaceEditorDelegate {
  selected(workspace: DocumentWorkspace, tabId: string): void
  changed(): void
}

interface PendingSave {
  changeVersion: number
  overwrite: boolean
  promise: Promise<boolean>
}

function emptyCapabilities(): LoadedDocument['capabilities'] {
  return {
    can_preview: false,
    can_edit: false,
    can_select: false,
    can_annotate: false,
    can_save: false,
    can_version: false,
    can_diff: false,
    pending: [],
  }
}

function titleFor(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

function fallbackTabForView(
  tabs: Record<string, DocumentTab>,
  sessions: Record<string, DocumentSession>,
  preferredTabId: string | null,
  navigationView: DocumentNavigationView
): string | null {
  const candidates = [preferredTabId, ...Object.keys(tabs)]
  return (
    candidates.find((tabId): tabId is string => {
      if (!tabId) return false
      const candidate = tabs[tabId]
      const session = candidate ? sessions[candidate.sessionId] : null
      return Boolean(
        candidate && session && documentNavigationView(candidate, session) === navigationView
      )
    }) ?? null
  )
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function cleanByteState(bytes: Uint8Array): Pick<DocumentSession, 'bytes' | 'savedBytes'> {
  const snapshot = copyBytes(bytes)
  return { bytes: snapshot, savedBytes: snapshot }
}

function canonicalViewKind(
  viewer: ViewerKind,
  requested: DocumentViewKind,
  canEdit: boolean,
  path: string
): DocumentViewKind {
  if (viewer === 'markdown' && requested === 'source') return 'source'
  if (!canEdit) return 'preview'
  return viewer === 'code' || (viewer === 'spreadsheet' && previewFormat(path) !== 'xlsx')
    ? 'edit'
    : requested === 'source'
      ? 'preview'
      : requested
}

export function tabIdsForClose(
  tabIds: readonly string[],
  tabId: string,
  scope: TabCloseScope
): string[] {
  const index = tabIds.indexOf(tabId)
  if (index < 0) return []
  if (scope === 'current') return [tabId]
  if (scope === 'others') return tabIds.filter((candidate) => candidate !== tabId)
  if (scope === 'left') return tabIds.slice(0, index)
  if (scope === 'right') return tabIds.slice(index + 1)
  return [...tabIds]
}

export function hasDirtyProjectPath(
  sessions: readonly DocumentSession[],
  project: string | null,
  path: string
): boolean {
  const prefix = `${path}/`
  return sessions.some(
    (session) =>
      session.source.kind === 'project' &&
      (session.source.project ?? null) === project &&
      (session.source.path === path || session.source.path.startsWith(prefix)) &&
      session.dirty
  )
}

export class DocumentWorkspace {
  private state: DocumentWorkspaceState = {
    sessions: {},
    tabs: {},
    layout: initialLayout(),
    pendingClose: null,
    pendingExclusiveOpen: null,
    focusedTabId: null,
    focusedLeaf: null,
    selectionPresentations: {},
  }

  private readonly listeners = new Set<() => void>()
  private pageTabIds = new Set<string>()
  private nextId = 1
  private readonly saveDelegates = new Map<string, Map<symbol, DocumentSaveDelegate>>()
  private readonly saves = new Map<string, PendingSave>()
  private readonly textHistories = new Map<string, TextHistoryState>()
  private readonly openings = new Map<string, Promise<string>>()
  private nextHistorySequence = 0
  private readonly versioningRefreshes = new Map<string, number>()
  private nextVersioningRefresh = 0
  private nextExclusiveOpen = 0
  private closeQueue: string[] = []
  private closing = false
  private autoSave = false
  private exclusiveReplacement: { ownerTabId: string; candidateTabId: string } | null = null
  private documentNavigation: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly loader: DocumentLoader,
    private readonly claimExclusiveViewer?: ExclusiveViewerClaim,
    private readonly editorDelegate?: DocumentWorkspaceEditorDelegate,
    private readonly idNamespace = ''
  ) {}

  getSnapshot = (): DocumentWorkspaceState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  tabLocation(tabId: string): FocusedLeaf | null {
    return this.locationForTab(tabId)
  }

  pageTabsInLeaf(tabId: string): readonly string[] {
    const location = this.locationForTab(tabId)
    return location
      ? (findLeaf(this.state.layout.areas[location.area], location.leafId)?.tabIds ?? []).filter(
          (id) => !this.state.tabs[id]?.embedded
        )
      : []
  }

  openPageTab(tabId: string, leafId?: string): boolean {
    if (this.state.tabs[tabId]) return false
    const target = leafId
      ? (['primary', 'secondary'] as const).flatMap((area) =>
          findLeaf(this.state.layout.areas[area], leafId) ? [{ area, leafId }] : []
        )[0]
      : (this.locationForTab(tabId) ?? this.openTarget())
    if (!target) return false
    this.pageTabIds.add(tabId)
    const location = this.locationForTab(tabId)
    const layout =
      location?.leafId === target.leafId
        ? activateTab(this.state.layout, target.leafId, tabId)
        : placeTab(this.state.layout, tabId, target.area, target.leafId, 'center', () =>
            this.id('pane')
          )
    this.publish({ ...this.state, layout, focusedTabId: tabId, focusedLeaf: target })
    return true
  }

  synchronizePageTabs(tabIds: readonly string[]): void {
    const next = new Set(tabIds)
    let layout = this.state.layout
    let tabs = this.state.tabs
    const removedPages = new Set<string>()
    for (const tabId of this.pageTabIds) {
      if (!next.has(tabId)) {
        removedPages.add(tabId)
        layout = removeTabFromLayout(layout, tabId)
      }
    }
    for (const tab of Object.values(tabs)) {
      if (tab.hostTabId && removedPages.has(tab.hostTabId)) {
        tabs = {
          ...tabs,
          [tab.id]: { ...tab, embedded: false, hostTabId: undefined, activeInHost: undefined },
        }
      }
    }
    this.pageTabIds = next
    const target = this.openTarget()
    for (const tabId of tabIds) {
      if (this.locationForTabInLayout(layout, tabId)) continue
      const leaf =
        findLeaf(layout.areas[target.area], target.leafId) ?? firstLeaf(layout.areas[target.area])
      const activeTabId = leaf.activeTabId
      layout = placeTab(layout, tabId, target.area, leaf.id, 'center', () => this.id('pane'))
      if (activeTabId) layout = activateTab(layout, leaf.id, activeTabId)
    }
    if (layout === this.state.layout) return
    const previous = this.state.focusedLeaf
    const leaf = previous ? findLeaf(layout.areas[previous.area], previous.leafId) : null
    const fallback =
      leaf ??
      firstLeaf(nodeTabCount(layout.areas.primary) ? layout.areas.primary : layout.areas.secondary)
    const focusedTabId =
      this.state.focusedTabId && this.locationForTabInLayout(layout, this.state.focusedTabId)
        ? this.state.focusedTabId
        : fallback.activeTabId
    this.publish({
      ...this.state,
      tabs,
      layout,
      focusedTabId,
      focusedLeaf: focusedTabId ? this.locationForTabInLayout(layout, focusedTabId) : null,
    })
  }

  splitPageTab(tabId: string, newTabId: string, direction: TabSplitDirection): boolean {
    if (this.state.tabs[newTabId] || this.pageTabIds.has(newTabId)) return false
    if (!this.pageTabIds.has(tabId) || !this.canSplitTab(tabId, direction, false)) return false
    const target = this.locationForTab(tabId)!
    const layout = placeTab(
      this.state.layout,
      newTabId,
      target.area,
      target.leafId,
      direction,
      () => this.id('pane')
    )
    if (layout === this.state.layout) return false
    this.pageTabIds.add(newTabId)
    this.publish({
      ...this.state,
      layout,
      focusedTabId: newTabId,
      focusedLeaf: this.locationForTabInLayout(layout, newTabId),
    })
    return true
  }

  setTabEmbedded(tabId: string, embedded: boolean): void {
    const tab = this.state.tabs[tabId]
    if (!tab || Boolean(tab.embedded) === embedded) return
    this.publish({
      ...this.state,
      tabs: {
        ...this.state.tabs,
        [tabId]: {
          ...tab,
          embedded,
          hostTabId: embedded ? tab.hostTabId : undefined,
          activeInHost: embedded ? tab.activeInHost : undefined,
        },
      },
    })
  }

  private publish(next: DocumentWorkspaceState): void {
    const focusedTab = next.focusedTabId ? next.tabs[next.focusedTabId] : null
    const pageId = focusedTab?.hostTabId
    if (pageId && this.pageTabIds.has(pageId) && focusedTab?.embedded) {
      const location = this.locationForTabInLayout(next.layout, pageId)
      if (location) {
        next = {
          ...next,
          tabs: Object.fromEntries(
            Object.entries(next.tabs).map(([id, tab]) => [
              id,
              tab.hostTabId === pageId && tab.embedded
                ? { ...tab, activeInHost: id === focusedTab.id }
                : tab,
            ])
          ),
          layout: activateTab(next.layout, location.leafId, pageId),
          focusedTabId: pageId,
          focusedLeaf: location,
        }
      }
    }
    const previousFocusedTabId = this.state.focusedTabId
    this.state = next
    for (const listener of this.listeners) listener()
    if (next.focusedTabId && next.focusedTabId !== previousFocusedTabId) {
      this.recordSelection(next.focusedTabId)
    }
    this.editorDelegate?.changed()
  }

  private id(prefix: string): string {
    const id = `${this.idNamespace}${prefix}-${this.nextId}`
    this.nextId += 1
    return id
  }

  private recordSelection(tabId: string): void {
    if (this.state.tabs[tabId]) this.editorDelegate?.selected(this, tabId)
  }

  private sessionFor(source: DocumentSource): DocumentSession | undefined {
    const documentId = documentIdFor(source)
    return Object.values(this.state.sessions).find(
      (session) =>
        session.documentId === documentId ||
        (source.kind === 'project' &&
          session.source.kind === 'project' &&
          session.source.path === source.path &&
          (session.source.project ?? null) === (source.project ?? null))
    )
  }

  async revealText(
    source: DocumentSource,
    reveal: FindTextReveal,
    title = titleFor(source.path)
  ): Promise<string> {
    const navigation = this.documentNavigation.then(() => this.navigateText(source, reveal, title))
    this.documentNavigation = navigation.catch(() => undefined)
    return navigation
  }

  private async navigateText(
    source: DocumentSource,
    reveal: FindTextReveal,
    title: string
  ): Promise<string> {
    const existingSession = this.sessionFor(source)
    const focused = this.state.focusedTabId ? this.state.tabs[this.state.focusedTabId] : undefined
    const existingTab =
      focused?.sessionId === existingSession?.id
        ? focused
        : Object.values(this.state.tabs).find((tab) => tab.sessionId === existingSession?.id)
    const tabId = existingTab?.id ?? (await this.open(source, 'preview', title))
    let tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : undefined
    if (!tab || !session || session.loadState === 'error') throw new Error('source_unavailable')
    if (session.viewer === 'markdown' && tab.viewKind !== 'source') {
      this.setTabView(tabId, 'source')
      tab = this.state.tabs[tabId]
    }
    this.focusTab(tabId)
    const previous = documentTextReveal(tab)
    this.setTabViewState(tabId, {
      ...tab.viewState,
      [DOCUMENT_TEXT_REVEAL_VIEW_STATE_KEY]: {
        ...reveal,
        sequence: (previous?.sequence ?? 0) + 1,
      },
    })
    return tabId
  }

  async revealCitation(source: CitationResolution, match?: CitationMatch): Promise<string> {
    const navigation = this.documentNavigation.then(() => this.navigateCitation(source, match))
    this.documentNavigation = navigation.catch(() => undefined)
    return navigation
  }

  private async navigateCitation(
    source: CitationResolution,
    match?: CitationMatch
  ): Promise<string> {
    let document: DocumentSource =
      (source.artifact_citation ||
        source.source_kind === 'attachment' ||
        source.source_kind === 'literature') &&
      (source.source_session_id || source.artifact_citation) &&
      (source.artifact_citation ||
        source.saved_citation ||
        (source.answer_id && source.answer_revision))
        ? {
            kind: 'session-file',
            sessionId: source.source_session_id || source.artifact_citation!.session_id,
            path: source.source_id,
            projectScope: source.scope_project_id,
            mediaType: 'application/pdf',
            ...(source.artifact_citation
              ? { artifactCitation: source.artifact_citation }
              : source.saved_citation
                ? { savedCitation: source.saved_citation }
                : {
                    citation: {
                      answerId: source.answer_id!,
                      answerRevision: source.answer_revision!,
                      handle: source.handle,
                    },
                  }),
            ...(source.record_target ? { recordTarget: source.record_target } : {}),
          }
        : { kind: 'project', project: source.project_id, path: source.path }
    const scope = source.scope_project_id || source.project_id
    const candidates = Object.values(this.state.sessions).filter(
      (session) =>
        session.viewer === 'pdf' &&
        session.loadState === 'ready' &&
        !session.dirty &&
        !session.deleted &&
        !session.externalChange &&
        session.revision === source.revision
    )
    if (document.kind === 'session-file') {
      const projects = candidates.filter((session) =>
        session.source.kind === 'project'
          ? Boolean(scope) && session.source.project === scope
          : session.source.kind === 'session-file' && (session.source.projectScope || '') === scope
      )
      const linked = projects.filter((session) =>
        session.attachmentIds?.includes(documentIdFor(document))
      )
      const target =
        linked.length === 1 ? linked[0] : projects.length === 1 ? projects[0] : undefined
      if (target) {
        const loaded = await this.loader.load(target.source)
        const current = this.state.sessions[target.id]
        if (
          current &&
          current.documentId === target.documentId &&
          !current.dirty &&
          !current.deleted &&
          !current.externalChange &&
          !isDocumentLoadFailure(loaded) &&
          current.revision === source.revision &&
          loaded.revision === source.revision &&
          loaded.viewer === 'pdf' &&
          !loaded.externalChange
        ) {
          this.publish({
            ...this.state,
            sessions: {
              ...this.state.sessions,
              [target.id]: {
                ...current,
                attachmentIds: [
                  ...new Set([...(current.attachmentIds ?? []), documentIdFor(document)]),
                ],
              },
            },
          })
          document = target.source
        }
      }
    }
    const attachments = candidates.filter(
      (session) => session.source.kind === 'session-file' && session.source.projectScope === scope
    )
    const attachment =
      scope && document.kind === 'project' && attachments.length === 1
        ? (attachments[0].source as SessionFileSource)
        : undefined
    const existing = Object.values(this.state.sessions).find(
      (session) => session.documentId === documentIdFor(document)
    )
    const existingTab =
      existing && Object.values(this.state.tabs).find((tab) => tab.sessionId === existing.id)
    const tabId =
      existingTab?.id ??
      (document.kind === 'project' && attachment
        ? await this.openImported(document, attachment, source.title)
        : await this.open(document, 'edit', source.title))
    this.focusTab(tabId)
    const tab = this.state.tabs[tabId]
    const session = this.state.sessions[tab.sessionId]
    if (session.loadState === 'error') throw new Error('source_unavailable')
    if (session.revision !== source.revision) throw new Error('source_revision_changed')
    const previous = tab.viewState?.[CITATION_VIEW_STATE_KEY] as { sequence?: number } | undefined
    this.setTabViewState(tabId, {
      ...tab.viewState,
      page: match?.pages[0]?.page ?? 1,
      mode: 'page',
      [CITATION_VIEW_STATE_KEY]: {
        revision: source.revision,
        pages: match?.pages ?? [],
        sequence: (previous?.sequence ?? 0) + 1,
      },
    })
    return tabId
  }

  /** An import changes the writable owner, never combines two project annotation stores. */
  async openImported(
    source: ProjectDocumentSource,
    attachment: SessionFileSource,
    title = titleFor(source.path)
  ): Promise<string> {
    const previous = Object.values(this.state.sessions).find(
      (session) => session.documentId === documentIdFor(attachment)
    )
    const project = Object.values(this.state.sessions).find(
      (session) => session.documentId === documentIdFor(source)
    )
    if (
      previous?.viewer === 'pdf' &&
      previous.loadState === 'ready' &&
      !previous.dirty &&
      !project
    ) {
      const loaded = await this.loader.load(source)
      const current = this.state.sessions[previous.id]
      if (
        current &&
        current.documentId === previous.documentId &&
        !current.dirty &&
        !current.deleted &&
        !current.externalChange &&
        !Object.values(this.state.sessions).some(
          (session) => session.documentId === documentIdFor(source)
        ) &&
        !isDocumentLoadFailure(loaded) &&
        loaded.viewer === 'pdf' &&
        !loaded.externalChange &&
        loaded.revision === current.revision
      ) {
        const tab = Object.values(this.state.tabs).find((tab) => tab.sessionId === current.id)
        if (tab) {
          this.publish({
            ...this.state,
            sessions: {
              ...this.state.sessions,
              [current.id]: {
                ...current,
                documentId: loaded.documentId,
                source: loaded.source,
                capabilities: loaded.capabilities,
                versioning: loaded.versioning ?? null,
                externalChange: Boolean(loaded.externalChange),
                deleted: false,
                title,
                attachmentIds: [
                  ...new Set([...(current.attachmentIds ?? []), documentIdFor(attachment)]),
                ],
              },
            },
            tabs: { ...this.state.tabs, [tab.id]: { ...tab, title, viewKind: 'edit' } },
          })
          this.focusTab(tab.id)
          return tab.id
        }
      }
    }
    return this.open(source, previewFormat(source.path) ? 'preview' : 'edit', title)
  }

  async open(
    source: DocumentSource,
    viewKind: DocumentViewKind = viewerPolicy(viewerForPath(source.path)).defaultViewKind,
    title = titleFor(source.path),
    area?: DockArea,
    titleFallback?: DocumentTab['titleFallback'],
    options: Pick<DocumentTab, 'embedded' | 'hostTabId'> = {}
  ): Promise<string> {
    const openingKey = JSON.stringify([documentIdFor(source), options.hostTabId ?? null])
    const pending = this.openings.get(openingKey)
    if (pending) {
      let tabId = await pending
      const tab = this.state.tabs[tabId]
      const session = tab ? this.state.sessions[tab.sessionId] : undefined
      if (tab && session) {
        const requestedViewKind = canonicalViewKind(
          session.viewer,
          viewKind,
          session.capabilities.can_edit,
          session.source.path
        )
        if (tab.viewKind !== requestedViewKind && previewFormat(session.source.path)) {
          tabId = await this.openDocument(
            source,
            requestedViewKind,
            title,
            area,
            titleFallback,
            options
          )
        } else {
          if (tab.viewKind !== requestedViewKind) this.setTabView(tabId, requestedViewKind)
          this.focusTab(tabId)
        }
      }
      if (!options.embedded) this.setTabEmbedded(tabId, false)
      return tabId
    }
    if (this.sessionFor(source)) {
      const tabId = await this.openDocument(source, viewKind, title, area, titleFallback, options)
      if (!options.embedded) this.setTabEmbedded(tabId, false)
      return tabId
    }
    const opening = this.openDocument(source, viewKind, title, area, titleFallback, options)
    this.openings.set(openingKey, opening)
    try {
      const tabId = await opening
      if (!options.embedded) this.setTabEmbedded(tabId, false)
      return tabId
    } finally {
      if (this.openings.get(openingKey) === opening) this.openings.delete(openingKey)
    }
  }

  private async openDocument(
    source: DocumentSource,
    viewKind: DocumentViewKind,
    title: string,
    area?: DockArea,
    titleFallback?: DocumentTab['titleFallback'],
    options: Pick<DocumentTab, 'embedded' | 'hostTabId'> = {}
  ): Promise<string> {
    const documentId = documentIdFor(source)
    const existingSession = this.sessionFor(source)
    const requestedViewKind = existingSession
      ? canonicalViewKind(
          existingSession.viewer,
          viewKind,
          existingSession.capabilities.can_edit,
          existingSession.source.path
        )
      : viewKind
    const sessionId = existingSession?.id ?? this.id('document')
    let target = this.openTarget(area)
    if (!canPlaceTab(this.state.layout, sessionId, target.area, target.leafId, 'center')) {
      const occupiedArea = nodeTabCount(this.state.layout.areas.primary) ? 'primary' : 'secondary'
      target = { area: occupiedArea, leafId: firstLeaf(this.state.layout.areas[occupiedArea]).id }
    }
    const targetLeaf = findLeaf(this.state.layout.areas[target.area], target.leafId)
    const existingTab = Object.values(this.state.tabs).find(
      (tab) =>
        tab.sessionId === sessionId &&
        (!options.hostTabId || (tab.embedded && tab.hostTabId === options.hostTabId)) &&
        (tab.viewKind === requestedViewKind || existingSession?.viewer === 'markdown') &&
        targetLeaf?.tabIds.includes(tab.id)
    )
    if (existingTab) {
      const leaf = this.leafForTab(existingTab.id)
      if (leaf) {
        const tabs =
          existingSession?.viewer === 'markdown' && existingTab.viewKind !== requestedViewKind
            ? {
                ...this.state.tabs,
                [existingTab.id]: { ...existingTab, viewKind: requestedViewKind },
              }
            : this.state.tabs
        this.publish({
          ...this.state,
          tabs,
          layout: activateTab(this.state.layout, leaf.leafId, existingTab.id),
          focusedTabId: existingTab.id,
          focusedLeaf: leaf,
        })
      }
      return existingTab.id
    }

    let tabs = this.state.tabs
    if (existingSession?.viewer === 'office' && requestedViewKind === 'edit') {
      const editOwner = Object.values(this.state.tabs).find(
        (tab) => tab.sessionId === sessionId && tab.viewKind === 'edit'
      )
      if (editOwner) {
        if (!(await this.refreshBeforeRelocation(editOwner))) return editOwner.id
        const refreshedTarget = findLeaf(this.state.layout.areas[target.area], target.leafId)
        const targetPreview = Object.values(this.state.tabs).find(
          (tab) =>
            tab.sessionId === sessionId &&
            tab.viewKind === 'preview' &&
            refreshedTarget?.tabIds.includes(tab.id)
        )
        tabs = {
          ...this.state.tabs,
          [editOwner.id]: { ...this.state.tabs[editOwner.id], viewKind: 'preview' },
        }
        if (targetPreview) {
          tabs[targetPreview.id] = { ...targetPreview, viewKind: 'edit' }
          this.publish({
            ...this.state,
            tabs,
            layout: activateTab(this.state.layout, target.leafId, targetPreview.id),
            focusedTabId: targetPreview.id,
            focusedLeaf: target,
          })
          return targetPreview.id
        }
      }
    }

    const expectedExclusiveGroup = viewerExclusiveGroup(
      viewerForPath(source.path),
      source.path,
      requestedViewKind
    )
    const expectedOwner = expectedExclusiveGroup
      ? Object.values(this.state.tabs).find((candidate) => {
          const candidateSession = this.state.sessions[candidate.sessionId]
          return (
            candidateSession &&
            viewerExclusiveGroup(
              candidateSession.viewer,
              candidateSession.source.path,
              candidate.viewKind
            ) === expectedExclusiveGroup
          )
        })
      : undefined
    const exclusiveOpen = expectedExclusiveGroup ? ++this.nextExclusiveOpen : 0
    if (
      !existingSession &&
      expectedExclusiveGroup &&
      !this.state.sessions[expectedOwner?.sessionId ?? '']?.dirty
    ) {
      const tabId = this.id(requestedViewKind)
      if (expectedOwner) {
        this.publish({
          ...this.state,
          pendingExclusiveOpen: { requestId: exclusiveOpen, ownerTabId: expectedOwner.id },
        })
      }
      let loaded: DocumentLoadResult
      try {
        loaded = await this.loader.load(source)
      } catch (error) {
        this.clearPendingExclusiveOpen(exclusiveOpen)
        throw error
      }
      if (exclusiveOpen !== this.nextExclusiveOpen) return this.state.focusedTabId ?? tabId
      const openedTabId = this.openPreparedExclusive(
        tabId,
        sessionId,
        source,
        requestedViewKind,
        title,
        titleFallback,
        target,
        loaded,
        options
      )
      this.clearPendingExclusiveOpen(exclusiveOpen)
      return openedTabId
    }

    const tabId = this.id(requestedViewKind)
    const tab: DocumentTab = {
      id: tabId,
      sessionId,
      viewKind: requestedViewKind,
      title,
      ...options,
      ...(titleFallback ? { titleFallback } : {}),
    }
    const sessions = existingSession
      ? this.state.sessions
      : {
          ...this.state.sessions,
          [sessionId]: {
            id: sessionId,
            documentId,
            source,
            title,
            viewer: 'unsupported' as ViewerKind,
            processor: null,
            capabilities: emptyCapabilities(),
            versioning: null,
            revision: '',
            mediaType: 'application/octet-stream',
            contentKind: 'unknown' as const,
            bytes: new Uint8Array(),
            savedBytes: new Uint8Array(),
            text: null,
            savedText: null,
            lightweightText: false,
            loadState: 'loading' as const,
            loadFailure: null,
            saveState: 'clean' as const,
            dirty: false,
            changeVersion: 0,
            selection: null,
            externalChange: false,
            deleted: false,
          },
        }
    this.publish({
      ...this.state,
      sessions,
      tabs: { ...tabs, [tabId]: tab },
      layout: placeTab(this.state.layout, tabId, target.area, target.leafId, 'center', () =>
        this.id('pane')
      ),
      focusedTabId: tabId,
      focusedLeaf: target,
    })

    if (!existingSession) {
      const loaded = await this.loader.load(source)
      const current = this.state.sessions[sessionId]
      if (!current) return tabId
      if (isDocumentLoadFailure(loaded)) {
        this.publish({
          ...this.state,
          sessions: {
            ...this.state.sessions,
            [sessionId]: { ...current, loadState: 'error', loadFailure: loaded },
          },
        })
        return tabId
      }
      const text = TEXT_VIEWERS.has(loaded.viewer) ? UTF8.decode(loaded.bytes) : null
      const loadedTab = this.state.tabs[tabId]
      const loadedTabs = loadedTab
        ? {
            ...this.state.tabs,
            [tabId]: {
              ...loadedTab,
              viewKind: canonicalViewKind(
                loaded.viewer,
                loadedTab.viewKind,
                loaded.capabilities.can_edit,
                loaded.source.path
              ),
            },
          }
        : this.state.tabs
      this.publish({
        ...this.state,
        tabs: loadedTabs,
        sessions: {
          ...this.state.sessions,
          [sessionId]: {
            ...current,
            documentId: loaded.documentId,
            source: loaded.source,
            viewer: loaded.viewer,
            processor: loaded.processor,
            capabilities: loaded.capabilities,
            versioning: loaded.versioning ?? null,
            revision: loaded.revision,
            mediaType: loaded.mediaType,
            contentKind: loaded.contentKind ?? 'unknown',
            ...cleanByteState(loaded.bytes),
            text,
            savedText: text,
            lightweightText: usesLightweightTextState(loaded.viewer, loaded.bytes.byteLength),
            loadState: 'ready',
            loadFailure: null,
            externalChange: Boolean(loaded.externalChange),
          },
        },
      })
    }
    this.enforceExclusiveViewer(tabId)
    return tabId
  }

  private openPreparedExclusive(
    tabId: string,
    sessionId: string,
    source: DocumentSource,
    requestedViewKind: DocumentViewKind,
    title: string,
    titleFallback: DocumentTab['titleFallback'] | undefined,
    target: { area: DockArea; leafId: string },
    loaded: DocumentLoadResult,
    options: Pick<DocumentTab, 'embedded' | 'hostTabId'>
  ): string {
    if (isDocumentLoadFailure(loaded)) {
      const tab: DocumentTab = {
        id: tabId,
        sessionId,
        viewKind: requestedViewKind,
        title,
        ...options,
        ...(titleFallback ? { titleFallback } : {}),
      }
      const session: DocumentSession = {
        id: sessionId,
        documentId: documentIdFor(source),
        source,
        title,
        viewer: 'unsupported',
        processor: null,
        capabilities: emptyCapabilities(),
        versioning: null,
        revision: '',
        mediaType: 'application/octet-stream',
        contentKind: 'unknown',
        bytes: new Uint8Array(),
        savedBytes: new Uint8Array(),
        text: null,
        savedText: null,
        lightweightText: false,
        loadState: 'error',
        loadFailure: loaded,
        saveState: 'clean',
        dirty: false,
        changeVersion: 0,
        selection: null,
        externalChange: false,
        deleted: false,
      }
      this.publishPreparedTab(tab, session, target)
      return tabId
    }

    const text = TEXT_VIEWERS.has(loaded.viewer) ? UTF8.decode(loaded.bytes) : null
    const tab: DocumentTab = {
      id: tabId,
      sessionId,
      viewKind: canonicalViewKind(
        loaded.viewer,
        requestedViewKind,
        loaded.capabilities.can_edit,
        loaded.source.path
      ),
      title,
      ...options,
      ...(titleFallback ? { titleFallback } : {}),
    }
    const session: DocumentSession = {
      id: sessionId,
      documentId: loaded.documentId,
      source: loaded.source,
      title,
      viewer: loaded.viewer,
      processor: loaded.processor,
      capabilities: loaded.capabilities,
      versioning: loaded.versioning ?? null,
      revision: loaded.revision,
      mediaType: loaded.mediaType,
      contentKind: loaded.contentKind ?? 'unknown',
      ...cleanByteState(loaded.bytes),
      text,
      savedText: text,
      lightweightText: usesLightweightTextState(loaded.viewer, loaded.bytes.byteLength),
      loadState: 'ready',
      loadFailure: null,
      saveState: 'clean',
      dirty: false,
      changeVersion: 0,
      selection: null,
      externalChange: Boolean(loaded.externalChange),
      deleted: false,
    }
    const group = viewerExclusiveGroup(loaded.viewer, loaded.source.path, tab.viewKind)
    if (!group) {
      this.publishPreparedTab(tab, session, target)
      return tabId
    }
    if (this.claimExclusiveViewer && !this.claimExclusiveViewer(this, tabId, group)) return tabId

    const ownerTab = Object.values(this.state.tabs).find((candidate) => {
      const candidateSession = this.state.sessions[candidate.sessionId]
      return (
        candidateSession &&
        viewerExclusiveGroup(
          candidateSession.viewer,
          candidateSession.source.path,
          candidate.viewKind
        ) === group
      )
    })
    const owner = ownerTab ? this.state.sessions[ownerTab.sessionId] : null
    if (!ownerTab || owner?.dirty) {
      this.publishPreparedTab(tab, session, target)
      this.enforceExclusiveViewer(tabId)
      return tabId
    }
    this.replacePreparedExclusiveTab(ownerTab.id, tab, session)
    return tabId
  }

  private publishPreparedTab(
    tab: DocumentTab,
    session: DocumentSession,
    target: { area: DockArea; leafId: string }
  ): void {
    this.publish({
      ...this.state,
      sessions: { ...this.state.sessions, [session.id]: session },
      tabs: { ...this.state.tabs, [tab.id]: tab },
      layout: placeTab(this.state.layout, tab.id, target.area, target.leafId, 'center', () =>
        this.id('pane')
      ),
      focusedTabId: tab.id,
      focusedLeaf: target,
    })
  }

  private clearPendingExclusiveOpen(requestId: number): void {
    if (this.state.pendingExclusiveOpen?.requestId !== requestId) return
    this.publish({ ...this.state, pendingExclusiveOpen: null })
  }

  private replacePreparedExclusiveTab(
    ownerTabId: string,
    tab: DocumentTab,
    session: DocumentSession
  ): void {
    const ownerTab = this.state.tabs[ownerTabId]
    const location = this.locationForTab(ownerTabId)
    if (!ownerTab || !location) return
    const tabs = { ...this.state.tabs }
    delete tabs[ownerTabId]
    tabs[tab.id] = tab
    const sessions = { ...this.state.sessions, [session.id]: session }
    if (!Object.values(tabs).some((candidate) => candidate.sessionId === ownerTab.sessionId)) {
      delete sessions[ownerTab.sessionId]
      this.saveDelegates.delete(ownerTab.sessionId)
      this.saves.delete(ownerTab.sessionId)
      this.textHistories.delete(ownerTab.sessionId)
      this.versioningRefreshes.delete(ownerTab.sessionId)
    }
    const selectionPresentations = { ...this.state.selectionPresentations }
    delete selectionPresentations[ownerTabId]
    const withoutOwner = removeTabFromLayout(this.state.layout, ownerTabId)
    const layout = placeTab(withoutOwner, tab.id, location.area, location.leafId, 'center', () =>
      this.id('pane')
    )
    this.publish({
      ...this.state,
      tabs,
      sessions,
      selectionPresentations,
      layout,
      pendingClose: null,
      focusedTabId: tab.id,
      focusedLeaf: location,
    })
  }

  private enforceExclusiveViewer(candidateTabId: string): void {
    const candidateTab = this.state.tabs[candidateTabId]
    const candidate = candidateTab ? this.state.sessions[candidateTab.sessionId] : null
    const group =
      candidate && candidateTab
        ? viewerExclusiveGroup(candidate.viewer, candidate.source.path, candidateTab.viewKind)
        : null
    if (!candidateTab || !candidate || !group) return
    if (this.claimExclusiveViewer && !this.claimExclusiveViewer(this, candidateTabId, group)) {
      this.closeNow(candidateTabId)
      return
    }
    const ownerTab = Object.values(this.state.tabs).find((tab) => {
      if (tab.id === candidateTabId) return false
      const session = this.state.sessions[tab.sessionId]
      return (
        session && viewerExclusiveGroup(session.viewer, session.source.path, tab.viewKind) === group
      )
    })
    if (!ownerTab) return
    const owner = this.state.sessions[ownerTab.sessionId]
    if (owner?.dirty) {
      this.exclusiveReplacement = { ownerTabId: ownerTab.id, candidateTabId }
      const location = this.locationForTab(ownerTab.id)
      this.publish({
        ...this.state,
        layout: location
          ? activateTab(this.state.layout, location.leafId, ownerTab.id)
          : this.state.layout,
        pendingClose: { tabId: ownerTab.id, sessionId: ownerTab.sessionId },
        focusedTabId: ownerTab.id,
        focusedLeaf: location ?? this.state.focusedLeaf,
      })
      return
    }
    this.closeNow(ownerTab.id)
  }

  updateText(sessionId: string, text: string): void {
    const session = this.state.sessions[sessionId]
    if (!session || session.loadState !== 'ready' || !session.capabilities.can_edit) return
    if (session.text === text) return
    const history = this.textHistories.get(sessionId) ?? { past: [], future: [] }
    if (session.text !== null) {
      history.past.push({ text: session.text, sequence: ++this.nextHistorySequence })
    }
    history.future = []
    trimTextHistory(history, MAX_TEXT_HISTORY_BYTES, MAX_TEXT_HISTORY_ENTRIES)
    this.textHistories.set(sessionId, history)
    this.replaceText(session, text)
  }

  undo(sessionId: string): boolean {
    const session = this.state.sessions[sessionId]
    const history = this.textHistories.get(sessionId)
    const entry = history?.past.pop()
    if (!session || session.text === null || entry === undefined || !history) return false
    history.future.push({ text: session.text, sequence: ++this.nextHistorySequence })
    trimTextHistory(history, MAX_TEXT_HISTORY_BYTES, MAX_TEXT_HISTORY_ENTRIES)
    this.replaceText(session, entry.text)
    return true
  }

  redo(sessionId: string): boolean {
    const session = this.state.sessions[sessionId]
    const history = this.textHistories.get(sessionId)
    const entry = history?.future.pop()
    if (!session || session.text === null || entry === undefined || !history) return false
    history.past.push({ text: session.text, sequence: ++this.nextHistorySequence })
    trimTextHistory(history, MAX_TEXT_HISTORY_BYTES, MAX_TEXT_HISTORY_ENTRIES)
    this.replaceText(session, entry.text)
    return true
  }

  private replaceText(session: DocumentSession, text: string): void {
    const contentChanged = text !== session.text
    const dirty = text !== session.savedText
    const bytes = UTF8_ENCODER.encode(text)
    this.publish({
      ...this.state,
      selectionPresentations: contentChanged
        ? this.withoutSessionPresentations(session.id)
        : this.state.selectionPresentations,
      sessions: {
        ...this.state.sessions,
        [session.id]: {
          ...session,
          text,
          bytes,
          lightweightText:
            session.lightweightText || usesLightweightTextState(session.viewer, bytes.byteLength),
          dirty,
          changeVersion: contentChanged ? session.changeVersion + 1 : session.changeVersion,
          selection: contentChanged
            ? this.invalidateSelection(session.selection)
            : session.selection,
          saveState: dirty ? 'dirty' : 'clean',
        },
      },
    })
  }

  restrictEditing(sessionId: string, reason: string): void {
    const session = this.state.sessions[sessionId]
    if (!session || session.runtimeReadonlyReason === reason) return
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          runtimeReadonlyReason: reason,
          capabilities: { ...session.capabilities, can_edit: false, can_save: false },
        },
      },
    })
  }

  setExternalDirty(sessionId: string, dirty: boolean): void {
    const session = this.state.sessions[sessionId]
    if (!session) return
    this.publish({
      ...this.state,
      selectionPresentations: dirty
        ? this.withoutSessionPresentations(sessionId)
        : this.state.selectionPresentations,
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          dirty,
          changeVersion: dirty ? session.changeVersion + 1 : session.changeVersion,
          selection: dirty ? this.invalidateSelection(session.selection) : session.selection,
          saveState: dirty ? 'dirty' : 'clean',
        },
      },
    })
  }

  markConflict(sessionId: string): void {
    const session = this.state.sessions[sessionId]
    if (!session) return
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: { ...session, saveState: 'conflict' },
      },
    })
  }

  async observeExternal(project: string, path: string): Promise<void> {
    const sessions = Object.values(this.state.sessions).filter(
      (session) =>
        session.source.kind === 'project' &&
        (session.source.project ?? 'current') === project &&
        session.source.path === path
    )
    for (const session of sessions) {
      if (session.dirty) {
        this.markConflict(session.id)
      } else if (await this.reload(session.id)) {
        const current = this.state.sessions[session.id]
        if (current) {
          this.publish({
            ...this.state,
            sessions: {
              ...this.state.sessions,
              [session.id]: { ...current, externalChange: true },
            },
          })
        }
      }
    }
  }

  /**
   * Reconcile every open document after a Content `rescan` event.
   *
   * A rescan deliberately carries no path: it is emitted when a linked root is
   * attached again, the native watcher is rebuilt, or the polling fallback only
   * knows that something changed.  Reloading only clean sessions is insufficient,
   * because a dirty editor must enter conflict handling only when its own disk
   * revision changed.  Read each candidate first, then apply the same revision and
   * edit guards used by a normal reload so an in-flight scan cannot overwrite a
   * newer user edit or save.
   */
  async reconcileProject(project: string): Promise<void> {
    const sessions = Object.values(this.state.sessions).filter(
      (session) =>
        session.source.kind === 'project' && (session.source.project ?? 'current') === project
    )
    await Promise.all(
      sessions.map(async (session) => {
        const documentId = session.documentId
        const sourceId = documentIdFor(session.source)
        const revision = session.revision
        const changeVersion = session.changeVersion
        const loaded = await this.loader.load(session.source)
        if (isDocumentLoadFailure(loaded)) return
        const current = this.state.sessions[session.id]
        if (
          !current ||
          current.documentId !== documentId ||
          documentIdFor(current.source) !== sourceId ||
          current.revision !== revision ||
          current.changeVersion !== changeVersion ||
          loaded.revision === revision
        )
          return
        if (current.dirty) {
          this.markConflict(current.id)
          return
        }
        if (this.acceptLoaded(current.id, loaded)) {
          const accepted = this.state.sessions[current.id]
          if (accepted) {
            this.publish({
              ...this.state,
              sessions: {
                ...this.state.sessions,
                [current.id]: { ...accepted, externalChange: true },
              },
            })
          }
        }
      })
    )
  }

  async reconcileProjectPaths(project: string, paths: string[]): Promise<void> {
    const selected = new Set(paths)
    const sessions = Object.values(this.state.sessions).filter(
      (session) =>
        session.source.kind === 'project' &&
        (session.source.project ?? 'current') === project &&
        selected.has(session.source.path)
    )
    for (const session of sessions) {
      if (session.dirty) this.markConflict(session.id)
      else await this.reload(session.id)
    }
  }

  hasResourceChanges(project: string, fileId: string, paths: readonly string[]): boolean {
    return Object.values(this.state.sessions).some(
      (session) =>
        session.source.kind === 'project' &&
        (!session.source.project ||
          session.source.project === 'current' ||
          project === 'current' ||
          session.source.project === project) &&
        (session.versioning?.file_id === fileId || paths.includes(session.source.path)) &&
        (session.dirty || session.saveState === 'saving')
    )
  }

  async reconcileRestoredFiles(
    project: string,
    files: readonly RestoredProjectFile[]
  ): Promise<RestoreReconciliationResult> {
    const result: RestoreReconciliationResult = { synchronized: [], conflicted: [], failed: [] }
    for (const file of files) {
      const sessions = Object.values(this.state.sessions).filter((session) => {
        if (session.source.kind !== 'project' || (session.source.project ?? 'current') !== project)
          return false
        return (
          session.versioning?.file_id === file.fileId ||
          session.source.path === file.previousPath ||
          session.source.path === file.path
        )
      })
      if (sessions.length === 0) continue
      let status: keyof RestoreReconciliationResult = 'synchronized'
      for (const candidate of sessions) {
        const current = this.state.sessions[candidate.id]
        if (!current) continue
        if (current.dirty) {
          this.markRestoredConflict(current.id, project, file)
          status = 'conflicted'
          continue
        }
        if (file.state === 'tombstone') {
          this.acceptRestoredTombstone(current.id, project, file)
          continue
        }
        const changeVersion = current.changeVersion
        const restoredSource: DocumentSource = { kind: 'project', project, path: file.path }
        const loaded = await this.loader.load(restoredSource)
        const latest = this.state.sessions[current.id]
        if (!latest) continue
        if (latest.dirty || latest.changeVersion !== changeVersion) {
          this.markRestoredConflict(latest.id, project, file)
          status = 'conflicted'
        } else if (isDocumentLoadFailure(loaded)) {
          status = status === 'conflicted' ? status : 'failed'
        } else {
          if (loaded.versioning === undefined && latest.versioning) {
            loaded.versioning = {
              ...latest.versioning,
              file_id: file.fileId,
              version_id: file.versionId ?? latest.versioning.version_id,
              working_revision: loaded.revision,
              disk_revision: loaded.revision,
              drifted: false,
            }
          }
          this.acceptLoaded(latest.id, loaded)
        }
      }
      result[status].push(file.fileId)
    }
    return result
  }

  clearExternalChange(sessionId: string, expectedDocumentId?: string): void {
    const session = this.state.sessions[sessionId]
    if (!session || (expectedDocumentId && session.documentId !== expectedDocumentId)) return
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: { ...session, externalChange: false },
      },
    })
  }

  async refreshVersioning(sessionId: string, expectedDocumentId: string): Promise<boolean> {
    const session = this.state.sessions[sessionId]
    if (
      !session ||
      session.documentId !== expectedDocumentId ||
      session.source.kind !== 'project' ||
      !this.loader.versioning
    )
      return false
    const source = session.source
    const sourceId = documentIdFor(source)
    const request = ++this.nextVersioningRefresh
    this.versioningRefreshes.set(sessionId, request)
    let versioning: NonNullable<LoadedDocument['versioning']> | null
    try {
      versioning = await this.loader.versioning(source)
    } catch (error) {
      if (this.versioningRefreshes.get(sessionId) === request) {
        this.versioningRefreshes.delete(sessionId)
      }
      throw error
    }
    const current = this.state.sessions[sessionId]
    if (
      !versioning ||
      !current ||
      this.versioningRefreshes.get(sessionId) !== request ||
      current.documentId !== expectedDocumentId ||
      documentIdFor(current.source) !== sourceId
    ) {
      if (this.versioningRefreshes.get(sessionId) === request) {
        this.versioningRefreshes.delete(sessionId)
      }
      return false
    }
    this.versioningRefreshes.delete(sessionId)
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: { ...current, versioning },
      },
    })
    return true
  }

  async reload(sessionId: string): Promise<boolean> {
    const session = this.state.sessions[sessionId]
    if (!session || session.dirty) return false
    const changeVersion = session.changeVersion
    const documentId = session.documentId
    const loaded = await this.loader.load(session.source)
    if (isDocumentLoadFailure(loaded)) return false
    const current = this.state.sessions[sessionId]
    if (!current || current.documentId !== documentId) return false
    if (current.dirty) {
      this.markConflict(sessionId)
      return false
    }
    if (current.changeVersion !== changeVersion) return false
    return this.acceptLoaded(sessionId, loaded)
  }

  async retryLoad(sessionId: string): Promise<boolean> {
    const session = this.state.sessions[sessionId]
    if (!session || session.loadState !== 'error') return false
    const documentId = session.documentId
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: { ...session, loadState: 'loading', loadFailure: null },
      },
    })
    const loaded = await this.loader.load(session.source)
    const current = this.state.sessions[sessionId]
    if (!current || current.documentId !== documentId) return false
    if (isDocumentLoadFailure(loaded)) {
      this.publish({
        ...this.state,
        sessions: {
          ...this.state.sessions,
          [sessionId]: { ...current, loadState: 'error', loadFailure: loaded },
        },
      })
      return false
    }
    return this.acceptLoaded(sessionId, loaded)
  }

  private acceptLoaded(sessionId: string, loaded: LoadedDocument): boolean {
    const session = this.state.sessions[sessionId]
    if (!session) return false
    const text = TEXT_VIEWERS.has(loaded.viewer) ? UTF8.decode(loaded.bytes) : null
    this.textHistories.delete(sessionId)
    this.versioningRefreshes.delete(sessionId)
    this.publish({
      ...this.state,
      tabs:
        loaded.source.path === session.source.path
          ? this.state.tabs
          : this.retitleSessionTabs(sessionId, loaded.source.path),
      selectionPresentations: this.withoutSessionPresentations(sessionId),
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          documentId: loaded.documentId,
          source: loaded.source,
          viewer: loaded.viewer,
          processor: loaded.processor,
          capabilities: loaded.capabilities,
          versioning: loaded.versioning === undefined ? session.versioning : loaded.versioning,
          revision: loaded.revision,
          mediaType: loaded.mediaType,
          contentKind: loaded.contentKind ?? 'unknown',
          ...cleanByteState(loaded.bytes),
          text,
          savedText: text,
          lightweightText: usesLightweightTextState(loaded.viewer, loaded.bytes.byteLength),
          loadState: 'ready',
          loadFailure: null,
          saveState: 'clean',
          dirty: false,
          changeVersion: session.changeVersion + 1,
          selection: this.invalidateSelection(session.selection),
          externalChange: Boolean(loaded.externalChange),
          deleted: false,
        },
      },
    })
    return true
  }

  private markRestoredConflict(
    sessionId: string,
    project: string,
    file: RestoredProjectFile
  ): void {
    const session = this.state.sessions[sessionId]
    if (!session) return
    const source: DocumentSource = { kind: 'project', project, path: file.path }
    this.publish({
      ...this.state,
      tabs:
        file.path === session.source.path
          ? this.state.tabs
          : this.retitleSessionTabs(sessionId, file.path),
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          documentId: documentIdFor(source),
          source,
          saveState: 'conflict',
          externalChange: true,
        },
      },
    })
  }

  private acceptRestoredTombstone(
    sessionId: string,
    project: string,
    file: RestoredProjectFile
  ): void {
    const session = this.state.sessions[sessionId]
    if (!session) return
    const source: DocumentSource = { kind: 'project', project, path: file.path }
    this.textHistories.delete(sessionId)
    this.publish({
      ...this.state,
      tabs:
        file.path === session.source.path
          ? this.state.tabs
          : this.retitleSessionTabs(sessionId, file.path),
      selectionPresentations: this.withoutSessionPresentations(sessionId),
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          documentId: documentIdFor(source),
          source,
          revision: '',
          bytes: new Uint8Array(),
          savedBytes: new Uint8Array(),
          text: session.text === null ? null : '',
          savedText: session.savedText === null ? null : '',
          loadState: 'ready',
          saveState: 'clean',
          dirty: false,
          changeVersion: session.changeVersion + 1,
          selection: this.invalidateSelection(session.selection),
          externalChange: false,
          versioning: session.versioning
            ? {
                ...session.versioning,
                can_version: false,
                version_id: file.versionId ?? session.versioning.version_id,
                working_revision: null,
                disk_revision: null,
                drifted: false,
              }
            : null,
          deleted: true,
        },
      },
    })
  }

  async overwriteDisk(sessionId: string): Promise<boolean> {
    const session = this.state.sessions[sessionId]
    if (!session || !session.dirty) return false
    const disk = await this.loader.load(session.source)
    if (isDocumentLoadFailure(disk)) return false
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: { ...session, revision: disk.revision, saveState: 'dirty' },
      },
    })
    return this.save(sessionId)
  }

  async discardMemory(sessionId: string): Promise<boolean> {
    const session = this.state.sessions[sessionId]
    if (!session) return false
    const loaded = await this.loader.load(session.source)
    return isDocumentLoadFailure(loaded) ? false : this.acceptLoaded(sessionId, loaded)
  }

  async saveManagedCopy(sessionId: string): Promise<boolean> {
    let session = this.state.sessions[sessionId]
    if (!session || session.source.kind !== 'project' || !this.loader.createManagedCopy)
      return false
    const delegate = Array.from(this.saveDelegates.get(sessionId)?.values() ?? []).at(-1)
    delegate?.prepare?.()
    session = this.state.sessions[sessionId]
    if (!session) return false
    if (session.dirty && delegate?.beforeSave) {
      try {
        await delegate.beforeSave()
      } catch (error) {
        console.warn('Document before-save preparation failed', error)
      }
      delegate.prepare?.()
      session = this.state.sessions[sessionId]
      if (!session) return false
    }
    if (delegate) {
      const delegated = await delegate.serialize()
      if (!delegated) return false
      session = { ...session, bytes: copyBytes(delegated) }
    }
    const result = await this.loader.createManagedCopy(
      session.source,
      copyBytes(session.bytes),
      session.title
    )
    if (!result.ok) return false
    await this.discardMemory(sessionId)
    await this.open(
      { kind: 'project', project: result.project, path: result.path },
      'edit',
      result.path.split('/').at(-1) ?? session.title
    )
    return true
  }

  registerSaveDelegate(sessionId: string, input: DocumentSaveDelegateInput): () => void {
    const token = Symbol(sessionId)
    const delegates = this.saveDelegates.get(sessionId) ?? new Map()
    const delegate = typeof input === 'function' ? { serialize: input } : input
    delegates.set(token, delegate)
    this.saveDelegates.set(sessionId, delegates)
    return () => {
      const registered = this.saveDelegates.get(sessionId)
      registered?.delete(token)
      if (registered?.size === 0) this.saveDelegates.delete(sessionId)
    }
  }

  setSelection(
    tabId: string,
    selection: SelectionAnchor | null,
    viewport?: SelectionViewport
  ): void {
    const tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : null
    if (!tab || !session) return
    if (
      selection &&
      (selection.document_session_id !== session.id ||
        selection.document_id !== session.documentId ||
        !viewport)
    )
      return
    const selectionPresentations = selection
      ? { ...this.state.selectionPresentations }
      : this.withoutSessionPresentations(session.id)
    if (selection && viewport) {
      selectionPresentations[tabId] = {
        tabId,
        fingerprint: selectionFingerprint(selection),
        rect: viewport.rect,
        point: viewport.point,
        visible: viewport.visible,
      }
    }
    this.publish({
      ...this.state,
      selectionPresentations,
      sessions: { ...this.state.sessions, [session.id]: { ...session, selection } },
    })
  }

  async moveTab(tabId: string, area: DockArea, leafId: string, edge: DropEdge): Promise<boolean> {
    if (this.pageTabIds.has(tabId)) {
      const layout = placeTab(this.state.layout, tabId, area, leafId, edge, () => this.id('pane'))
      return layout !== this.state.layout && this.publishRelocatedTab(tabId, layout)
    }
    const tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : null
    if (
      !tab ||
      !session ||
      !viewerPolicy(session.viewer).canMove ||
      !(await this.refreshBeforeRelocation(tab))
    )
      return false
    const layout = placeTab(this.state.layout, tabId, area, leafId, edge, () => this.id('pane'))
    if (layout === this.state.layout) return false
    return this.publishRelocatedTab(tabId, layout)
  }

  canMoveTab(tabId: string, direction: AdjacentDirection): boolean {
    const location = this.locationForTab(tabId)
    return Boolean(
      this.canRelocateTab(tabId) &&
      location &&
      adjacentLeaf(this.state.layout, location.area, location.leafId, direction)
    )
  }

  canRelocateTab(tabId: string): boolean {
    if (this.pageTabIds.has(tabId)) return true
    const tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : null
    return Boolean(session && viewerPolicy(session.viewer).canMove)
  }

  async moveTabToAdjacent(tabId: string, direction: AdjacentDirection): Promise<boolean> {
    const location = this.locationForTab(tabId)
    const target = location
      ? adjacentLeaf(this.state.layout, location.area, location.leafId, direction)
      : null
    return target ? this.moveTab(tabId, target.area, target.leaf.id, 'center') : false
  }

  moveTargetsForTab(tabId: string): AdjacentLeaf[] {
    const location = this.locationForTab(tabId)
    return location && this.canRelocateTab(tabId)
      ? moveTargets(this.state.layout, location.area, location.leafId)
      : []
  }

  async moveTabToTab(
    tabId: string,
    targetTabId: string,
    insertion: TabInsertion
  ): Promise<boolean> {
    if (tabId === targetTabId) return false
    const source = this.locationForTab(tabId)
    const initialTarget = this.locationForTab(targetTabId)
    if (!source || !initialTarget) return false
    if (source.area === initialTarget.area && source.leafId === initialTarget.leafId) {
      return this.reorderTab(tabId, targetTabId, insertion)
    }
    const tab = this.state.tabs[tabId]
    if (!this.canRelocateTab(tabId) || (tab && !(await this.refreshBeforeRelocation(tab))))
      return false
    const target = this.locationForTab(targetTabId)
    if (!target) return false
    const placed = placeTab(this.state.layout, tabId, target.area, target.leafId, 'center', () =>
      this.id('pane')
    )
    if (placed === this.state.layout) return false
    const layout = reorderTabInLeaf(
      placed,
      target.area,
      target.leafId,
      tabId,
      targetTabId,
      insertion
    )
    return this.publishRelocatedTab(tabId, layout)
  }

  private publishRelocatedTab(tabId: string, layout: DockLayout): boolean {
    const tab = this.state.tabs[tabId]
    const focusedLeaf = this.locationForTabInLayout(layout, tabId)
    if ((!tab && !this.pageTabIds.has(tabId)) || !focusedLeaf) return false
    if (this.pageTabIds.has(tabId)) {
      for (const preview of Object.values(this.state.tabs)) {
        if (preview.embedded && preview.hostTabId === tabId) {
          layout = placeTab(
            layout,
            preview.id,
            focusedLeaf.area,
            focusedLeaf.leafId,
            'center',
            () => this.id('pane')
          )
        }
      }
      layout = activateTab(layout, focusedLeaf.leafId, tabId)
    }
    const leaf = findLeaf(layout.areas[focusedLeaf.area], focusedLeaf.leafId)
    const tabs = { ...this.state.tabs }
    const selectionPresentations = { ...this.state.selectionPresentations }
    for (const candidateId of leaf?.tabIds ?? []) {
      const candidate = tabs[candidateId]
      if (
        candidateId !== tabId &&
        tab &&
        candidate &&
        candidate.sessionId === tab.sessionId &&
        candidate.hostTabId === tab.hostTabId &&
        Boolean(candidate.embedded) === Boolean(tab.embedded) &&
        candidate.viewKind === tab.viewKind
      ) {
        delete tabs[candidateId]
        delete selectionPresentations[candidateId]
        layout = removeTabFromLayout(layout, candidateId)
      }
    }
    this.publish({
      ...this.state,
      tabs,
      selectionPresentations,
      layout,
      focusedTabId: tabId,
      focusedLeaf,
    })
    return true
  }

  reorderTab(tabId: string, targetTabId: string, insertion: TabInsertion): boolean {
    if (tabId === targetTabId) return false
    const source = this.locationForTab(tabId)
    const target = this.locationForTab(targetTabId)
    if (!this.canRelocateTab(tabId)) return false
    if (!source || !target || source.area !== target.area || source.leafId !== target.leafId)
      return false
    const layout = reorderTabInLeaf(
      this.state.layout,
      source.area,
      source.leafId,
      tabId,
      targetTabId,
      insertion
    )
    if (layout === this.state.layout) return false
    this.publish({ ...this.state, layout })
    return true
  }

  canSplitTab(tabId: string, direction: TabSplitDirection, move: boolean): boolean {
    const location = this.locationForTab(tabId)
    if (!location) return false
    const tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : null
    if (!this.pageTabIds.has(tabId) && (!session || !viewerPolicy(session.viewer).canSplit))
      return false
    const leaf = findLeaf(this.state.layout.areas[location.area], location.leafId)
    if (!leaf || (move && leaf.tabIds.length < 2)) return false
    // A duplicated projection has an identity outside the current tab catalog.
    const candidateId = move ? tabId : `${tabId}${SPLIT_PROJECTION_SUFFIX}`
    return canPlaceTab(this.state.layout, candidateId, location.area, location.leafId, direction)
  }

  async splitTab(
    tabId: string,
    direction: TabSplitDirection,
    move: boolean
  ): Promise<string | null> {
    const tab = this.state.tabs[tabId]
    if (!tab || !this.canSplitTab(tabId, direction, move)) return null
    const session = this.state.sessions[tab.sessionId]
    const location = this.locationForTab(tabId)
    if (!location) return null
    const leaf = findLeaf(this.state.layout.areas[location.area], location.leafId)
    if (!leaf || (move && leaf.tabIds.length < 2)) return null
    if (!(await this.refreshBeforeRelocation(tab))) return null
    const placedViewKind =
      !move && session?.viewer === 'office' && tab.viewKind === 'edit' ? 'preview' : tab.viewKind
    const placedTabId = move ? tabId : this.id(placedViewKind)
    const tabs = move
      ? this.state.tabs
      : { ...this.state.tabs, [placedTabId]: { ...tab, id: placedTabId, viewKind: placedViewKind } }
    const layout = placeTab(
      this.state.layout,
      placedTabId,
      location.area,
      location.leafId,
      direction,
      () => this.id('pane')
    )
    if (layout === this.state.layout) return null
    const focusedLeaf = this.locationForTabInLayout(layout, placedTabId)
    if (!focusedLeaf) return null
    this.publish({
      ...this.state,
      tabs,
      layout,
      focusedTabId: placedTabId,
      focusedLeaf,
    })
    return placedTabId
  }

  visibleTabIds(): Set<string> {
    const visible = new Set<string>()
    const visit = (node: DockNode): void => {
      if (node.kind === 'split') {
        visit(node.first)
        visit(node.second)
        return
      }
      if (node.activeTabId && this.state.tabs[node.activeTabId]) visible.add(node.activeTabId)
      if (node.activeTabId && this.pageTabIds.has(node.activeTabId)) {
        for (const tabId of node.tabIds) {
          const tab = this.state.tabs[tabId]
          if (tab?.embedded && tab.hostTabId === node.activeTabId && tab.activeInHost)
            visible.add(tabId)
        }
      }
    }
    visit(this.state.layout.areas.primary)
    visit(this.state.layout.areas.secondary)
    return visible
  }

  activate(leafId: string, tabId: string): void {
    const focusedLeaf = this.locationForTab(tabId)
    if (!focusedLeaf || focusedLeaf.leafId !== leafId) return
    const alreadyFocused = this.state.focusedTabId === tabId
    this.publish({
      ...this.state,
      layout: activateTab(this.state.layout, leafId, tabId),
      focusedTabId: tabId,
      focusedLeaf,
    })
    if (alreadyFocused) this.recordSelection(tabId)
  }

  focusLeaf(area: DockArea, leafId: string): void {
    const leaf = findLeaf(this.state.layout.areas[area], leafId)
    if (!leaf) return
    if (this.state.focusedLeaf?.area === area && this.state.focusedLeaf.leafId === leafId) return
    this.publish({
      ...this.state,
      focusedTabId: leaf.activeTabId ?? this.state.focusedTabId,
      focusedLeaf: { area, leafId },
    })
  }

  focusTab(tabId: string): void {
    const location = this.locationForTab(tabId)
    if (location) this.activate(location.leafId, tabId)
  }

  setTabNavigationView(tabId: string, navigationView: DocumentNavigationView): void {
    const tab = this.state.tabs[tabId]
    if (!tab || tab.navigationView === navigationView) return
    this.publish({
      ...this.state,
      tabs: { ...this.state.tabs, [tabId]: { ...tab, navigationView } },
    })
  }

  setTabViewState(tabId: string, viewState: Readonly<Record<string, unknown>>): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    this.publish({
      ...this.state,
      tabs: { ...this.state.tabs, [tabId]: { ...tab, viewState: { ...viewState } } },
    })
  }

  setTabView(tabId: string, viewKind: DocumentViewKind): boolean {
    const tab = this.state.tabs[tabId]
    if (!tab) return false
    const session = this.state.sessions[tab.sessionId]
    if (session?.viewer !== 'markdown') return false
    if (viewKind === 'edit' && (!session.capabilities.can_edit || session.lightweightText))
      return false
    if (viewKind === 'preview' && session.lightweightText) return false
    if (tab.viewKind === viewKind) return true
    if (tab.viewKind === 'edit' && viewKind !== 'edit') {
      const delegate = Array.from(this.saveDelegates.get(tab.sessionId)?.values() ?? []).at(-1)
      delegate?.prepare?.()
    }
    this.publish({
      ...this.state,
      tabs: { ...this.state.tabs, [tabId]: { ...tab, viewKind } },
      selectionPresentations: this.withoutSessionPresentations(session.id),
      sessions: {
        ...this.state.sessions,
        [session.id]: { ...this.state.sessions[session.id], selection: null },
      },
    })
    return true
  }

  resizeArea(ratio: number): void {
    this.publish({ ...this.state, layout: { ...this.state.layout, areaRatio: ratio } })
  }

  resizePane(area: DockArea, splitId: string, ratio: number): void {
    this.publish({ ...this.state, layout: resizeSplit(this.state.layout, area, splitId, ratio) })
  }

  requestClose(tabId: string): void {
    this.requestCloseTabs([tabId])
  }

  setAutoSave(enabled: boolean): void {
    this.autoSave = enabled
  }

  closeCleanTab(tabId: string): boolean {
    if (this.state.pendingClose) return false
    const tab = this.state.tabs[tabId]
    const session = tab ? this.state.sessions[tab.sessionId] : null
    if (!tab || !session || session.dirty || session.saveState !== 'clean') return false
    this.closeNow(tabId)
    return true
  }

  requestCloseTabs(tabIds: readonly string[]): void {
    if (this.state.pendingClose || this.closing) return
    this.closeQueue = [...new Set(tabIds)].filter((tabId) => Boolean(this.state.tabs[tabId]))
    void this.continueCloseQueue()
  }

  discardTaskDocuments(taskId: string): void {
    const owned = Object.values(this.state.tabs).filter((tab) => {
      const source = this.state.sessions[tab.sessionId]?.source
      return (
        (source?.kind === 'session-artifact' || source?.kind === 'session-file') &&
        source.sessionId === taskId
      )
    })
    for (const tab of owned) this.closeNow(tab.id)
  }

  requestCloseProjectPath(project: string | null, path: string): boolean {
    if (this.state.pendingClose) return false
    const prefix = `${path}/`
    const tabs = Object.values(this.state.tabs).filter((candidate) => {
      const source = this.state.sessions[candidate.sessionId]?.source
      return (
        source?.kind === 'project' &&
        (source.project ?? null) === project &&
        (source.path === path || source.path.startsWith(prefix))
      )
    })
    this.requestCloseTabs(tabs.map((tab) => tab.id))
    return true
  }

  /**
   * 附件被删除后收掉它已打开的文档标签。
   *
   * 与 `requestCloseProjectPath` 同一套语义: 走正常的关闭队列, 所以有未保存
   * 批注时仍然会先弹确认, 不会把用户的标注悄悄丢掉。文献附件不属于任何项目
   * 路径, 只能按 (文献, 附件) 身份匹配。
   */
  requestCloseLiteratureAttachment(literatureId: string, attachmentId: string): boolean {
    if (this.state.pendingClose) return false
    const tabs = Object.values(this.state.tabs).filter((candidate) => {
      const source = this.state.sessions[candidate.sessionId]?.source
      return (
        source?.kind === 'literature' &&
        source.literatureId === literatureId &&
        source.attachmentId === attachmentId
      )
    })
    if (tabs.length === 0) return false
    this.requestCloseTabs(tabs.map((tab) => tab.id))
    return true
  }

  discardProjectPath(project: string | null, path: string): boolean {
    const prefix = `${path}/`
    const discardedTabIds = new Set(
      Object.values(this.state.tabs).flatMap((tab) => {
        const source = this.state.sessions[tab.sessionId]?.source
        return source?.kind === 'project' &&
          (source.project ?? null) === project &&
          (source.path === path || source.path.startsWith(prefix))
          ? [tab.id]
          : []
      })
    )
    if (discardedTabIds.size === 0) return true

    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).filter(([tabId]) => !discardedTabIds.has(tabId))
    )
    const liveSessionIds = new Set(Object.values(tabs).map((tab) => tab.sessionId))
    const discardedSessionIds = new Set(
      Array.from(discardedTabIds).map((tabId) => this.state.tabs[tabId].sessionId)
    )
    const sessions = Object.fromEntries(
      Object.entries(this.state.sessions).filter(
        ([sessionId]) => !discardedSessionIds.has(sessionId) || liveSessionIds.has(sessionId)
      )
    )
    for (const sessionId of discardedSessionIds) {
      if (liveSessionIds.has(sessionId)) continue
      this.saveDelegates.delete(sessionId)
      this.saves.delete(sessionId)
      this.textHistories.delete(sessionId)
      this.versioningRefreshes.delete(sessionId)
    }
    const selectionPresentations = Object.fromEntries(
      Object.entries(this.state.selectionPresentations).filter(
        ([tabId]) => !discardedTabIds.has(tabId)
      )
    )
    let layout = Array.from(discardedTabIds).reduce(
      (current, tabId) => removeTabFromLayout(current, tabId),
      this.state.layout
    )
    const previousFocusedArea = this.state.focusedLeaf?.area
    const fallbackLeaf = previousFocusedArea
      ? (findLeaf(layout.areas[previousFocusedArea], this.state.focusedLeaf!.leafId) ??
        firstLeaf(layout.areas[previousFocusedArea]))
      : firstLeaf(layout.areas.primary)
    const focusedTab =
      this.state.focusedTabId && discardedTabIds.has(this.state.focusedTabId)
        ? this.state.tabs[this.state.focusedTabId]
        : null
    const focusedTabId = focusedTab
      ? fallbackTabForView(
          tabs,
          sessions,
          fallbackLeaf.activeTabId,
          documentNavigationView(focusedTab, this.state.sessions[focusedTab.sessionId])
        )
      : this.state.focusedTabId
    const fallbackLocation = focusedTabId ? this.locationForTabInLayout(layout, focusedTabId) : null
    if (fallbackLocation && focusedTabId) {
      layout = activateTab(layout, fallbackLocation.leafId, focusedTabId)
    }
    const focusedLeaf =
      this.state.focusedLeaf &&
      findLeaf(layout.areas[this.state.focusedLeaf.area], this.state.focusedLeaf.leafId)
        ? this.state.focusedLeaf
        : focusedTabId
          ? this.locationForTabInLayout(layout, focusedTabId)
          : null
    this.closeQueue = this.closeQueue.filter((tabId) => !discardedTabIds.has(tabId))
    this.publish({
      ...this.state,
      tabs,
      sessions,
      selectionPresentations,
      layout,
      pendingClose:
        this.state.pendingClose && !discardedTabIds.has(this.state.pendingClose.tabId)
          ? this.state.pendingClose
          : null,
      focusedTabId,
      focusedLeaf,
    })
    return true
  }

  hasDirtyProjectPath(project: string | null, path: string): boolean {
    return hasDirtyProjectPath(Object.values(this.state.sessions), project, path)
  }

  async relocateProjectPath(
    project: string | null,
    previousPath: string,
    path: string,
    title?: string
  ): Promise<void> {
    if (previousPath === path) return
    const prefix = `${previousPath}/`
    const relocated: Array<{ sessionId: string; documentId: string }> = []
    const sessions = Object.fromEntries(
      Object.entries(this.state.sessions).map(([id, session]) => {
        if (
          session.source.kind !== 'project' ||
          (session.source.project ?? null) !== project ||
          (session.source.path !== previousPath && !session.source.path.startsWith(prefix))
        ) {
          return [id, session]
        }
        const suffix = session.source.path.slice(previousPath.length)
        const nextPath = `${path}${suffix}`
        const nextSource = { ...session.source, path: nextPath }
        const nextDocumentId =
          session.documentId === documentIdFor(session.source)
            ? documentIdFor(nextSource)
            : session.documentId
        relocated.push({ sessionId: id, documentId: nextDocumentId })
        return [
          id,
          {
            ...session,
            documentId: nextDocumentId,
            source: nextSource,
            title: session.source.path === previousPath && title ? title : session.title,
            // Version capability is path-bound even when the document keeps a stable
            // asset identity. Keeping the old projection makes a renamed pending file
            // appear saved and disables the action that can seal its new path.
            versioning: null,
          },
        ]
      })
    )
    if (relocated.length === 0) return
    const tabs = Object.fromEntries(
      Object.entries(this.state.tabs).map(([id, tab]) => {
        const session = sessions[tab.sessionId]
        const previous = this.state.sessions[tab.sessionId]
        return [
          id,
          previous && session !== previous && previous.source.path === previousPath && title
            ? { ...tab, title, titleFallback: undefined }
            : tab,
        ]
      })
    )
    this.publish({ ...this.state, sessions, tabs })
    const refreshed = await Promise.allSettled(
      relocated.map(({ sessionId, documentId }) => this.refreshVersioning(sessionId, documentId))
    )
    for (const result of refreshed) {
      if (result.status === 'rejected') {
        // The filesystem relocation already succeeded. Leave metadata absent so
        // the UI never presents the previous path's saved state as current.
        console.warn('Version state refresh failed after project path relocation', result.reason)
      }
    }
  }

  async resolveClose(choice: CloseChoice): Promise<void> {
    const pending = this.state.pendingClose
    if (!pending) return
    if (choice === 'cancel') {
      const replacement = this.exclusiveReplacement
      this.exclusiveReplacement = null
      this.closeQueue = []
      if (replacement?.ownerTabId === pending.tabId) {
        this.closeNow(replacement.candidateTabId)
        this.focusTab(replacement.ownerTabId)
      } else {
        this.publish({ ...this.state, pendingClose: null })
      }
      return
    }
    if (choice === 'save' || choice === 'overwrite') {
      const saved = await this.save(pending.sessionId, choice === 'overwrite')
      if (!saved) return
    } else {
      const session = this.state.sessions[pending.sessionId]
      if (session) {
        this.publish({
          ...this.state,
          sessions: {
            ...this.state.sessions,
            [pending.sessionId]: {
              ...session,
              bytes: session.savedBytes,
              text: session.savedText,
              dirty: false,
              changeVersion: session.changeVersion + 1,
              saveState: 'clean',
            },
          },
        })
      }
    }
    this.closeQueue = this.closeQueue.filter((tabId) => tabId !== pending.tabId)
    this.closeNow(pending.tabId)
    if (this.exclusiveReplacement?.ownerTabId === pending.tabId) this.exclusiveReplacement = null
    void this.continueCloseQueue()
  }

  async save(sessionId: string, overwrite = false): Promise<boolean> {
    const requestedChangeVersion = this.state.sessions[sessionId]?.changeVersion ?? -1
    const active = this.saves.get(sessionId)
    if (
      active &&
      requestedChangeVersion <= active.changeVersion &&
      (!overwrite || active.overwrite)
    )
      return active.promise
    const saving = active
      ? active.promise.then((saved) => {
          if (!saved && !overwrite) return false
          return this.commitSession(sessionId, overwrite)
        })
      : this.commitSession(sessionId, overwrite)
    const pending = { changeVersion: requestedChangeVersion, overwrite, promise: saving }
    this.saves.set(sessionId, pending)
    try {
      return await saving
    } finally {
      if (this.saves.get(sessionId) === pending) this.saves.delete(sessionId)
    }
  }

  async reviewDraftBytes(sessionId: string): Promise<Uint8Array | null> {
    let session = this.state.sessions[sessionId]
    if (!session || !session.dirty) return null
    const delegate = Array.from(this.saveDelegates.get(sessionId)?.values() ?? []).at(-1)
    delegate?.prepare?.()
    if (delegate?.beforeSave) {
      await delegate.beforeSave()
      delegate.prepare?.()
    }
    session = this.state.sessions[sessionId]
    if (!session || !session.dirty) return null
    const serialized = delegate ? await delegate.serialize() : session.bytes
    return serialized ? copyBytes(serialized) : null
  }

  async saveFocused(): Promise<boolean> {
    const tab = this.state.focusedTabId ? this.state.tabs[this.state.focusedTabId] : undefined
    const session = tab ? this.state.sessions[tab.sessionId] : undefined
    // Ordinary save prepares any editor-local changes before checking dirtiness.
    if (!session || !session.capabilities.can_save) return true
    return this.save(session.id)
  }

  async saveAll(): Promise<boolean> {
    const sessionIds = Object.values(this.state.sessions)
      .filter((session) => session.dirty && session.capabilities.can_save)
      .map((session) => session.id)
    for (const sessionId of sessionIds) {
      if (!(await this.save(sessionId))) return false
    }
    return true
  }

  private async commitSession(sessionId: string, overwrite: boolean): Promise<boolean> {
    let session = this.state.sessions[sessionId]
    if (!session) return true
    const delegate = Array.from(this.saveDelegates.get(sessionId)?.values() ?? []).at(-1)
    delegate?.prepare?.()
    session = this.state.sessions[sessionId]
    if (!session || !session.dirty) return true
    if (delegate?.beforeSave) {
      try {
        await delegate.beforeSave()
      } catch (error) {
        console.warn('Document before-save preparation failed', error)
      }
      delegate.prepare?.()
      session = this.state.sessions[sessionId]
      if (!session || !session.dirty) return true
    }
    const committedChangeVersion = session.changeVersion
    const committedText = session.text
    this.publish({
      ...this.state,
      selectionPresentations: this.withoutSessionPresentations(sessionId),
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...session,
          selection: this.invalidateSelection(session.selection),
          saveState: 'saving',
        },
      },
    })
    if (delegate) {
      const bytes = await delegate.serialize()
      session = this.state.sessions[sessionId]
      if (!bytes || !session) {
        if (session) {
          this.publish({
            ...this.state,
            sessions: { ...this.state.sessions, [sessionId]: { ...session, saveState: 'error' } },
          })
        }
        return false
      }
      session = { ...session, bytes: copyBytes(bytes) }
      this.publish({
        ...this.state,
        sessions: { ...this.state.sessions, [sessionId]: session },
      })
    }
    const committedBytes = copyBytes(session.bytes)
    let expectedRevision = session.revision
    if (overwrite) {
      const latest = await this.loader.load(session.source)
      if (isDocumentLoadFailure(latest)) {
        const current = this.state.sessions[sessionId]
        if (current) {
          this.publish({
            ...this.state,
            sessions: { ...this.state.sessions, [sessionId]: { ...current, saveState: 'error' } },
          })
        }
        return false
      }
      expectedRevision = latest.revision
    }
    const result = await this.loader.commit(session.source, committedBytes, expectedRevision)
    const current = this.state.sessions[sessionId]
    if (!current) return false
    if (!result.ok) {
      this.publish({
        ...this.state,
        pendingClose: this.state.pendingClose,
        sessions: {
          ...this.state.sessions,
          [sessionId]: {
            ...current,
            saveState: result.error === 'conflict' ? 'conflict' : 'error',
          },
        },
      })
      return false
    }
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [sessionId]: {
          ...current,
          revision: result.revision,
          versioning: null,
          ...(current.changeVersion === committedChangeVersion
            ? { bytes: committedBytes, savedBytes: committedBytes }
            : { savedBytes: committedBytes }),
          savedText: committedText,
          dirty: current.changeVersion !== committedChangeVersion,
          saveState: current.changeVersion === committedChangeVersion ? 'clean' : 'dirty',
        },
      },
    })
    try {
      await this.refreshVersioning(sessionId, current.documentId)
    } catch (error) {
      // The bytes are already committed. A failed metadata read must not report
      // a failed disk save or retain the previous "saved version" capability.
      console.warn('Version state refresh failed after disk save', error)
    }
    return true
  }

  private leafForTab(tabId: string): FocusedLeaf | null {
    return this.locationForTabInLayout(this.state.layout, tabId)
  }

  private invalidateSelection(selection: SelectionAnchor | null): SelectionAnchor | null {
    return selection && selection.status === 'exact' ? { ...selection, status: 'stale' } : selection
  }

  private withoutSessionPresentations(sessionId: string): Record<string, SelectionPresentation> {
    return Object.fromEntries(
      Object.entries(this.state.selectionPresentations).filter(
        ([tabId]) => this.state.tabs[tabId]?.sessionId !== sessionId
      )
    )
  }

  private retitleSessionTabs(sessionId: string, path: string): Record<string, DocumentTab> {
    const title = titleFor(path)
    return Object.fromEntries(
      Object.entries(this.state.tabs).map(([tabId, tab]) => [
        tabId,
        tab.sessionId === sessionId ? { ...tab, title, titleFallback: undefined } : tab,
      ])
    )
  }

  private locationForTab(tabId: string): { area: DockArea; leafId: string } | null {
    return this.locationForTabInLayout(this.state.layout, tabId)
  }

  private locationForTabInLayout(layout: DockLayout, tabId: string): FocusedLeaf | null {
    const primary = this.leafForTabInNode(layout.areas.primary, tabId)
    if (primary) return { area: 'primary', leafId: primary }
    const secondary = this.leafForTabInNode(layout.areas.secondary, tabId)
    return secondary ? { area: 'secondary', leafId: secondary } : null
  }

  private openTarget(area?: DockArea): FocusedLeaf {
    if (area) return { area, leafId: firstLeaf(this.state.layout.areas[area]).id }
    const focused = this.state.focusedLeaf
    if (focused && findLeaf(this.state.layout.areas[focused.area], focused.leafId)) return focused
    if (this.state.focusedTabId) {
      const tabLocation = this.locationForTab(this.state.focusedTabId)
      if (tabLocation) return tabLocation
    }
    return { area: 'primary', leafId: firstLeaf(this.state.layout.areas.primary).id }
  }

  private async refreshBeforeRelocation(tab: DocumentTab): Promise<boolean> {
    const session = this.state.sessions[tab.sessionId]
    if (!session || session.viewer !== 'office' || !session.dirty) return true
    const delegate = Array.from(this.saveDelegates.get(session.id)?.values() ?? []).at(-1)
    if (!delegate) return false
    delegate.prepare?.()
    let bytes: Uint8Array | null
    try {
      bytes = await delegate.serialize()
    } catch {
      return false
    }
    const current = this.state.sessions[session.id]
    if (!bytes || !current) return false
    this.publish({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [session.id]: { ...current, bytes: copyBytes(bytes), dirty: true, saveState: 'dirty' },
      },
    })
    return true
  }

  private leafForTabInNode(
    node: DocumentWorkspaceState['layout']['areas']['primary'],
    tabId: string
  ): string | null {
    if (node.kind === 'leaf') return node.tabIds.includes(tabId) ? node.id : null
    return this.leafForTabInNode(node.first, tabId) ?? this.leafForTabInNode(node.second, tabId)
  }

  private async continueCloseQueue(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      while (this.closeQueue.length > 0) {
        const tabId = this.closeQueue[0]
        const tab = this.state.tabs[tabId]
        if (!tab) {
          this.closeQueue.shift()
          continue
        }
        let session = this.state.sessions[tab.sessionId]
        const references = Object.values(this.state.tabs).filter(
          (candidate) => candidate.sessionId === tab.sessionId
        ).length
        if (session?.viewer === 'markdown' && this.autoSave && references === 1) {
          try {
            const delegate = Array.from(this.saveDelegates.get(session.id)?.values() ?? []).at(-1)
            delegate?.prepare?.()
            session = this.state.sessions[tab.sessionId]
            if (session?.dirty) {
              const saved = await this.save(session.id)
              session = this.state.sessions[tab.sessionId]
              if (saved && session?.dirty) continue
            }
          } catch (error) {
            console.warn('Document close auto-save failed', error)
            session = this.state.sessions[tab.sessionId]
            if (session) {
              session = { ...session, saveState: 'error' }
              this.publish({
                ...this.state,
                sessions: { ...this.state.sessions, [session.id]: session },
              })
            }
          }
        }
        if (session?.dirty && references === 1) {
          this.publish({ ...this.state, pendingClose: { tabId, sessionId: tab.sessionId } })
          return
        }
        this.closeQueue.shift()
        this.closeNow(tabId)
      }
    } finally {
      this.closing = false
    }
  }

  private closeNow(tabId: string): void {
    const tab = this.state.tabs[tabId]
    if (!tab) return
    const tabs = { ...this.state.tabs }
    delete tabs[tabId]
    const selectionPresentations = { ...this.state.selectionPresentations }
    delete selectionPresentations[tabId]
    const sessions = { ...this.state.sessions }
    if (!Object.values(tabs).some((candidate) => candidate.sessionId === tab.sessionId)) {
      delete sessions[tab.sessionId]
      this.saveDelegates.delete(tab.sessionId)
      this.saves.delete(tab.sessionId)
      this.textHistories.delete(tab.sessionId)
      this.versioningRefreshes.delete(tab.sessionId)
    }
    let layout = removeTabFromLayout(this.state.layout, tabId)
    const previousFocusedArea = this.state.focusedLeaf?.area
    const fallbackLeaf = previousFocusedArea
      ? (findLeaf(layout.areas[previousFocusedArea], this.state.focusedLeaf!.leafId) ??
        firstLeaf(layout.areas[previousFocusedArea]))
      : firstLeaf(layout.areas.primary)
    const focusedTabId =
      this.state.focusedTabId === tabId
        ? fallbackLeaf.activeTabId && this.pageTabIds.has(fallbackLeaf.activeTabId)
          ? fallbackLeaf.activeTabId
          : fallbackTabForView(
              tabs,
              sessions,
              fallbackLeaf.activeTabId,
              documentNavigationView(tab, this.state.sessions[tab.sessionId])
            )
        : this.state.focusedTabId
    const fallbackLocation = focusedTabId ? this.locationForTabInLayout(layout, focusedTabId) : null
    if (fallbackLocation && focusedTabId) {
      layout = activateTab(layout, fallbackLocation.leafId, focusedTabId)
    }
    const focusedLeaf =
      this.state.focusedLeaf &&
      findLeaf(layout.areas[this.state.focusedLeaf.area], this.state.focusedLeaf.leafId)
        ? this.state.focusedLeaf
        : focusedTabId
          ? this.locationForTabInLayout(layout, focusedTabId)
          : null
    this.publish({
      ...this.state,
      tabs,
      sessions,
      selectionPresentations,
      layout,
      pendingClose: null,
      focusedTabId,
      focusedLeaf,
    })
  }
}

export const defaultLoader: DocumentLoader = {
  load: loadDocument,
  versioning: loadVersionCapability,
  commit: commitDocument,
  createManagedCopy,
}

const MONACO_VIEWERS: ReadonlySet<ViewerKind> = new Set(['code', 'markdown'])

interface DocumentWorkspaceRegistryOptions {
  limit?: number
  reclaim?: DocumentResourceReclaimer
}

export class DocumentWorkspaceRegistry {
  private readonly workspaces = new Map<string | null, DocumentWorkspace>()
  private readonly selectionSequences = new Map<string, number>()
  private readonly limit: number
  private readonly reclaim: DocumentResourceReclaimer
  private activeScope: string | null | undefined
  private nextSelectionSequence = 0
  private nextWorkspaceId = 0
  private rebalancing = false

  discardTaskDocuments(taskId: string): void {
    for (const workspace of this.workspaces.values()) workspace.discardTaskDocuments(taskId)
  }

  constructor(
    private readonly loader: DocumentLoader,
    options: DocumentWorkspaceRegistryOptions = {}
  ) {
    this.limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_EDITOR_LIMIT))
    this.reclaim = options.reclaim ?? reclaimDocumentResources
  }

  forProject(project: string | null | undefined): DocumentWorkspace {
    const scope = project ?? null
    if (this.activeScope === undefined) this.activeScope = scope
    let workspace = this.workspaces.get(scope)
    if (!workspace) {
      this.nextWorkspaceId += 1
      workspace = new DocumentWorkspace(
        this.loader,
        this.claimExclusiveViewer,
        { selected: this.recordSelection, changed: this.rebalance },
        `workspace-${this.nextWorkspaceId}:`
      )
      this.workspaces.set(scope, workspace)
    }
    return workspace
  }

  dirtyEditorCount(): number {
    return [...this.workspaces.values()].reduce(
      (count, workspace) =>
        count +
        Object.values(workspace.getSnapshot().sessions).filter(
          (session) => session.dirty && MONACO_VIEWERS.has(session.viewer)
        ).length,
      0
    )
  }

  async saveEditors(): Promise<boolean> {
    for (const workspace of this.workspaces.values()) {
      const sessionIds = Object.values(workspace.getSnapshot().sessions)
        .filter((session) => session.dirty && MONACO_VIEWERS.has(session.viewer))
        .map((session) => session.id)
      for (const sessionId of sessionIds) {
        if (!(await workspace.save(sessionId))) return false
      }
    }
    return this.dirtyEditorCount() === 0
  }

  activateProject(project: string | null | undefined): void {
    const scope = project ?? null
    this.activeScope = scope
    this.forProject(scope)
    this.rebalance()
  }

  reclaimResources(): void {
    const liveSessionIds = new Set<string>()
    const liveTabIds = new Set<string>()
    for (const workspace of this.workspaces.values()) {
      const state = workspace.getSnapshot()
      for (const sessionId of Object.keys(state.sessions)) liveSessionIds.add(sessionId)
      for (const tabId of Object.keys(state.tabs)) liveTabIds.add(tabId)
    }
    this.reclaim(liveSessionIds, liveTabIds)
  }

  private readonly recordSelection = (_workspace: DocumentWorkspace, tabId: string): void => {
    this.selectionSequences.set(tabId, ++this.nextSelectionSequence)
  }

  private readonly rebalance = (): void => {
    if (this.rebalancing) return
    this.rebalancing = true
    try {
      while (true) {
        const owners = new Map<string, DocumentWorkspace>()
        const candidates = [...this.workspaces.entries()].flatMap(([scope, workspace]) => {
          const state = workspace.getSnapshot()
          const visible = scope === this.activeScope ? workspace.visibleTabIds() : new Set<string>()
          return Object.values(state.tabs).flatMap((tab) => {
            const session = state.sessions[tab.sessionId]
            if (!session) return []
            owners.set(tab.id, workspace)
            return [
              {
                id: tab.id,
                lastSelectedSequence: this.selectionSequences.get(tab.id) ?? 0,
                protected: session.dirty || session.saveState !== 'clean' || visible.has(tab.id),
              },
            ]
          })
        })
        if (candidates.length <= this.limit) break
        const tabId = selectLruTabClosures(candidates, candidates.length - 1)[0]
        if (!tabId || !owners.get(tabId)?.closeCleanTab(tabId)) break
      }
      const liveTabIds = new Set(
        [...this.workspaces.values()].flatMap((workspace) =>
          Object.keys(workspace.getSnapshot().tabs)
        )
      )
      for (const tabId of this.selectionSequences.keys()) {
        if (!liveTabIds.has(tabId)) this.selectionSequences.delete(tabId)
      }
      this.reclaimResources()
    } finally {
      this.rebalancing = false
    }
  }

  private readonly claimExclusiveViewer: ExclusiveViewerClaim = (owner, _candidateTabId, group) => {
    const conflicting = [...this.workspaces.values()]
      .filter((workspace) => workspace !== owner)
      .map((workspace) => ({
        workspace,
        tabs: Object.values(workspace.getSnapshot().tabs).filter((tab) => {
          const session = workspace.getSnapshot().sessions[tab.sessionId]
          return (
            session &&
            viewerExclusiveGroup(session.viewer, session.source.path, tab.viewKind) === group
          )
        }),
      }))
      .filter(({ tabs }) => tabs.length > 0)
    if (
      conflicting.some(({ workspace, tabs }) =>
        tabs.some((tab) => workspace.getSnapshot().sessions[tab.sessionId]?.dirty)
      )
    )
      return false
    for (const conflict of conflicting) {
      conflict.workspace.requestCloseTabs(conflict.tabs.map((tab) => tab.id))
    }
    return true
  }

  /**
   * 文献是全库维度的, 同一份附件可能在多个项目工作区里都开着标签,
   * 所以删除附件时按注册表全量收口, 而不是只收当前项目。
   */
  closeLiteratureAttachment(literatureId: string, attachmentId: string): boolean {
    let closed = false
    for (const workspace of this.workspaces.values()) {
      closed = workspace.requestCloseLiteratureAttachment(literatureId, attachmentId) || closed
    }
    return closed
  }
}

export const documentWorkspaces = new DocumentWorkspaceRegistry(defaultLoader)

/** Resource actions may not bypass unsaved or in-flight editor state. */
export function resourceEditorHasChanges(
  project: string,
  fileId: string,
  paths: readonly string[]
): boolean {
  return documentWorkspaces.forProject(project).hasResourceChanges(project, fileId, paths)
}

export function reconcileResourceEditors(
  project: string,
  files: readonly RestoredProjectFile[]
): Promise<RestoreReconciliationResult> {
  return documentWorkspaces.forProject(project).reconcileRestoredFiles(project, files)
}

export const DocumentWorkspaceContext = createContext<DocumentWorkspace | null>(null)

export const useWorkspaceController = (): DocumentWorkspace => {
  const controller = useContext(DocumentWorkspaceContext)
  if (!controller) throw new Error('document_workspace_provider_missing')
  return controller
}

export function useDocumentWorkspace(): DocumentWorkspaceState {
  const controller = useWorkspaceController()
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
