import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

import { OfficeImageError } from '../../../../../images'
import { LOCALES } from '../../../../../localization/catalog'
import type { SelectionLocator } from '../../../contracts/workbench'

import { Alert, Toaster } from '../../../components/ui'
import { useApp } from '../../../store'
import type { SelectionReplacementRequest, SelectionReplacementResult } from '../actions'
import { useImageFailureText } from '../failure'
import { officeFailureText } from './failure'
import { stageOfficeImage, releaseOfficeImage, type OfficeImageLease } from '../api'
import {
  documentTextReveal,
  selectionViewport,
  type DocumentSession,
  useDocumentWorkspace,
  useWorkspaceController
} from '../workspace'
import { OfficeImageLeases } from './media'
import { officeFrameDocument, type OfficeFrameDocument } from './frame'
import {
  OFFICE_VIEWPORT_SELECTORS,
  visibleOfficeBounds,
  type OfficeBounds
} from './bounds'
import { reconcileOfficeHosts, type OfficeHostState, type OfficeRuntimeHost } from './hosts'
import { OfficeRuntimeContext } from './officeRuntimeContext'
import { officeProcessor } from './processors/registry'
import { officePalette } from './theme'
import { OfficeWarmup } from './Warmup'
import {
  INITIAL_OFFICE_WARMUP_STATUS,
  parseOfficeWarmupStatus,
  type OfficeWarmupStatus
} from './progress'

const IDLE_HOST_SIZE = { width: 1024, height: 768 }
const REPLACEMENT_TIMEOUT_MS = 10_000
const OFFICE_SEARCH_TIMEOUT_MS = 10_000
export const OFFICE_RUNTIME_ROOT_ID = 'vds-office-runtime-root'

export type OfficeSearchDirection = 'first' | 'next' | 'previous'
export type OfficePresentationDirection = 'next' | 'previous'

const OFFICE_REVEAL_CHANGED = 'office_reveal_changed'
const OFFICE_REVEAL_MISSING = 'office_reveal_missing'
const OFFICE_REVEAL_TIMEOUT = 'office_reveal_timeout'
const CALC_REFERENCE_MODE = 'reference'
const CALC_REFERENCE_SEPARATOR = ' · '

export interface OfficeSearchResult {
  ok: boolean
  query: string
  location: string
  current: number
  total: number
  error?: 'search_failed' | 'search_timeout' | 'search_unsupported'
}

export interface OfficeSearchListener {
  close: () => void
  open: () => void
  update: (result: OfficeSearchResult) => void
}

export interface OfficePresentationState {
  canNext: boolean
  canPrevious: boolean
  current: number
  total: number
}

interface OfficeSelection {
  content_mode?: 'reference'
  context_text?: string
  kind: 'writer' | 'calc' | 'impress'
  text?: string
  paragraph?: string
  end_paragraph?: string
  start?: number
  end?: number
  format?: 'doc' | 'docx'
  sheet?: string
  range?: { StartColumn: number; StartRow: number; EndColumn: number; EndRow: number }
  slide?: number
  shape?: string
}

function calcSelectionReference(sourcePath: string, sheet: string, range: string): string {
  const filename = sourcePath.split(/[\\/]/).pop() || sourcePath
  return `${filename}${CALC_REFERENCE_SEPARATOR}${sheet}!${range}`
}

interface OfficeSelectionPoint {
  x: number
  y: number
}

export interface OfficeRuntimeContextValue {
  registerAnchor: (viewId: string, element: HTMLDivElement | null) => void
  registerView: (viewId: string, binding: OfficeViewBinding | null) => void
  replaceSelection: (
    tabId: string,
    request: SelectionReplacementRequest
  ) => Promise<SelectionReplacementResult>
  registerOfficeSearch: (tabId: string, listener: OfficeSearchListener | null) => void
  registerPresentationState: (
    tabId: string,
    listener: ((state: OfficePresentationState) => void) | null
  ) => void
  navigatePresentation: (tabId: string, direction: OfficePresentationDirection) => void
  searchOffice: (
    tabId: string,
    query: string,
    direction: OfficeSearchDirection
  ) => Promise<OfficeSearchResult>
  setOfficeSearchVisible: (tabId: string, visible: boolean) => void
  setInteractionBlocked: (blocked: boolean) => void
}

export interface OfficeViewBinding {
  bytes: Uint8Array
  revision: string
  title: string
  viewId: string
  viewer: 'office' | 'spreadsheet'
  processor: DocumentSession['processor']
}

interface PendingReplacement {
  resolve: (result: SelectionReplacementResult) => void
  timeout: ReturnType<typeof setTimeout>
}

interface PendingOfficeSearch {
  query: string
  resolve: (result: OfficeSearchResult) => void
  timeout: ReturnType<typeof setTimeout>
}

type OfficeReplacement = (
  request: SelectionReplacementRequest
) => Promise<SelectionReplacementResult>

interface OfficeSearch {
  run: (query: string, direction: OfficeSearchDirection) => Promise<OfficeSearchResult>
  setVisible: (visible: boolean) => void
}

type OfficePresentationNavigation = (direction: OfficePresentationDirection) => void

type OfficeControlPost = (
  type: string,
  detail?: Record<string, unknown>,
  transfer?: Transferable[]
) => void

function sameBounds(current: OfficeBounds | null, next: OfficeBounds | null): boolean {
  return current?.left === next?.left
    && current?.top === next?.top
    && current?.width === next?.width
    && current?.height === next?.height
}

function columnName(column: number): string {
  let value = column + 1
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + value % 26) + name
    value = Math.floor(value / 26)
  }
  return name
}

function calcRange(range: NonNullable<OfficeSelection['range']>): string {
  return `${columnName(range.StartColumn)}${range.StartRow + 1}:${columnName(range.EndColumn)}${range.EndRow + 1}`
}

function OfficeHost({
  host,
  anchor,
  binding,
  registerReplacement,
  registerSearch,
  registerPresentationNavigation,
  publishSearchAction,
  publishSearchResult,
  publishPresentationState,
  interactionBlocked
}: {
  host: OfficeRuntimeHost
  anchor: HTMLDivElement | null
  binding: OfficeViewBinding | null
  registerReplacement: (tabId: string, replacement: OfficeReplacement | null) => void
  registerSearch: (tabId: string, search: OfficeSearch | null) => void
  registerPresentationNavigation: (tabId: string, navigation: OfficePresentationNavigation | null) => void
  publishSearchAction: (tabId: string, action: 'open' | 'close') => void
  publishSearchResult: (tabId: string, result: OfficeSearchResult) => void
  publishPresentationState: (tabId: string, state: OfficePresentationState) => void
  interactionBlocked: boolean
}): React.JSX.Element {
  const { state: appState } = useApp()
  const { t, i18n } = useTranslation('workbench')
  const requestedLanguage = i18n.resolvedLanguage === 'en' ? 'en' : 'zh'
  const [frameLanguage, setFrameLanguage] = useState<'zh' | 'en'>(requestedLanguage)
  const workspace = useDocumentWorkspace()
  const controller = useWorkspaceController()
  const viewId = host.viewId ?? ''
  const tab = !binding && viewId ? workspace.tabs[viewId] ?? null : null
  const session = tab ? workspace.sessions[tab.sessionId] : null
  const documentTitle = binding?.title ?? session?.title ?? ''
  const documentFilename = binding?.title ?? session?.source.path ?? documentTitle
  const documentProcessor = binding?.processor ?? session?.processor ?? null
  const isPresentationDocument = /\.pptx?$/i.test(documentFilename)
  const documentBytes = binding?.bytes ?? session?.bytes
  const bindingIdentity = binding
    ? `${binding.viewId}:${binding.revision}:preview`
    : `${tab?.id}:${session?.id}:${session?.documentId}:${session?.revision}:${tab?.viewKind}`
  const reveal = documentTextReveal(tab)
  const [frame, setFrame] = useState<OfficeFrameDocument | null>(null)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const [frameReady, setFrameReady] = useState(false)
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [readyBinding, setReadyBinding] = useState('')
  const documentReady = Boolean(bindingIdentity && readyBinding === bindingIdentity)
  const hasDocument = Boolean(binding || tab)
  const switchingDocument = workspace.pendingExclusiveOpen?.ownerTabId === viewId
    || Boolean(hasDocument && readyBinding && !documentReady)
  const [warmup, setWarmup] = useState<OfficeWarmupStatus>(INITIAL_OFFICE_WARMUP_STATUS)
  const [showWarmupProgress, setShowWarmupProgress] = useState(false)
  const [palette, setPalette] = useState(() => officePalette(document.documentElement))
  const [bounds, setBounds] = useState<OfficeBounds | null>(null)
  const imageFailureText = useImageFailureText()
  const [imageError, setImageError] = useState<{ cause: unknown } | null>(null)
  const [notice, setNotice] = useState<{ id: string; message: string; detail?: string } | null>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const pendingSave = useRef<((bytes: Uint8Array | null) => void) | null>(null)
  const pendingReplacements = useRef(new Map<string, PendingReplacement>())
  const pendingSearches = useRef(new Map<string, PendingOfficeSearch>())
  const loadedBinding = useRef('')
  const handledReveal = useRef('')
  const activeRevealRequest = useRef('')
  const revealTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serializedImages = useRef<string[]>([])
  const imageLeases = useMemo(() => session ? new OfficeImageLeases<OfficeImageLease>(
    lease => releaseOfficeImage(session.source, lease),
    error => setImageError({ cause: error })
  ) : null, [session?.id])
  useEffect(() => () => imageLeases?.dispose(), [imageLeases])

  const post = useCallback((type: string, detail: Record<string, unknown> = {}, transfer: Transferable[] = []): void => {
    if (!frame) return
    frameRef.current?.contentWindow?.postMessage(
      { kind: 'scholarseed-office-control', token: frame.token, type, ...detail },
      '*',
      transfer
    )
  }, [frame])
  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(officePalette(document.documentElement)))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (frameReady) post('theme', { palette })
  }, [frameReady, palette, post])
  const failPendingReplacements = useCallback((): void => {
    for (const pending of pendingReplacements.current.values()) {
      clearTimeout(pending.timeout)
      pending.resolve({ ok: false, error: 'replacement_failed' })
    }
    pendingReplacements.current.clear()
  }, [])
  const failPendingSearches = useCallback((error: OfficeSearchResult['error'] = 'search_failed'): void => {
    for (const pending of pendingSearches.current.values()) {
      clearTimeout(pending.timeout)
      pending.resolve({ ok: false, query: pending.query, location: '', current: 0, total: 0, error })
    }
    pendingSearches.current.clear()
  }, [])
  const clearRevealTimeout = useCallback((): void => {
    if (revealTimeout.current) clearTimeout(revealTimeout.current)
    revealTimeout.current = null
  }, [])
  const finishReveal = useCallback((requestId: string, found: boolean): void => {
    if (!requestId || requestId !== activeRevealRequest.current) return
    activeRevealRequest.current = ''
    clearRevealTimeout()
    if (!found) {
      const changed = Boolean(reveal && session && reveal.source_revision !== session.revision)
      setNotice({
        id: crypto.randomUUID(),
        message: changed ? OFFICE_REVEAL_CHANGED : OFFICE_REVEAL_MISSING
      })
    }
  }, [clearRevealTimeout, reveal, session])

  useEffect(() => {
    if (requestedLanguage === frameLanguage) return
    if (session && session.saveState !== 'clean') return
    setFrameLanguage(requestedLanguage)
  }, [frameLanguage, requestedLanguage, session?.saveState])

  useEffect(() => {
    setFrameReady(false)
    setRuntimeReady(false)
    setReadyBinding('')
    loadedBinding.current = ''
    const nextFrame = officeFrameDocument(i18n.getFixedT(frameLanguage, 'workbench'), LOCALES[frameLanguage].office)
    setFrame(nextFrame)
    return () => {
      frameRef.current?.contentWindow?.postMessage(
        { kind: 'scholarseed-office-control', token: nextFrame.token, type: 'dispose' },
        '*'
      )
      nextFrame.dispose()
      setFrame((current) => current === nextFrame ? null : current)
    }
  }, [appState.shortcutOverrides, frameEpoch, frameLanguage, i18n])

  useLayoutEffect(() => {
    if (!anchor) {
      if (!switchingDocument) setBounds(null)
      return
    }
    let measureFrame = 0
    const measure = (): void => {
      const next = visibleOfficeBounds(anchor)
      setBounds((current) => sameBounds(current, next) ? current : next)
    }
    const scheduleMeasure = (): void => {
      cancelAnimationFrame(measureFrame)
      measureFrame = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(anchor)
    for (const selector of OFFICE_VIEWPORT_SELECTORS) {
      const viewport = anchor.closest<HTMLElement>(selector)
      if (viewport) observer.observe(viewport)
    }
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    document.addEventListener('animationend', scheduleMeasure, true)
    document.addEventListener('transitionend', scheduleMeasure, true)
    measure()
    scheduleMeasure()
    return () => {
      cancelAnimationFrame(measureFrame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
      document.removeEventListener('animationend', scheduleMeasure, true)
      document.removeEventListener('transitionend', scheduleMeasure, true)
    }
  }, [anchor, switchingDocument, workspace.layout])

  useEffect(() => {
    if (!frame || !host.viewId || tab?.viewKind !== 'edit') return
    const tabId = host.viewId
    registerReplacement(tabId, (request) => new Promise((resolve) => {
      const requestId = crypto.randomUUID()
      const timeout = setTimeout(() => {
        pendingReplacements.current.delete(requestId)
        resolve({ ok: false, error: 'replacement_timeout' })
      }, REPLACEMENT_TIMEOUT_MS)
      pendingReplacements.current.set(requestId, { resolve, timeout })
      post('replace-selection', {
        requestId,
        locator: request.selection.locator,
        expectedText: request.selection.text,
        replacement: request.replacement
      })
    }))
    return () => {
      registerReplacement(tabId, null)
      failPendingReplacements()
    }
  }, [failPendingReplacements, frame, host.viewId, post, registerReplacement, tab?.viewKind])

  useEffect(() => failPendingReplacements, [failPendingReplacements])
  useEffect(() => failPendingSearches, [failPendingSearches])
  useEffect(() => clearRevealTimeout, [clearRevealTimeout])

  useEffect(() => {
    if (!frame || !host.viewId || (session?.viewer !== 'office' && session?.viewer !== 'spreadsheet')) return
    const tabId = host.viewId
    registerSearch(tabId, {
      run: (query, direction) => new Promise((resolve) => {
        const requestId = crypto.randomUUID()
        const timeout = setTimeout(() => {
          pendingSearches.current.delete(requestId)
          resolve({ ok: false, query, location: '', current: 0, total: 0, error: 'search_timeout' })
        }, OFFICE_SEARCH_TIMEOUT_MS)
        pendingSearches.current.set(requestId, { query, resolve, timeout })
        post('office-search', { requestId, query, direction })
      }),
      setVisible: (visible) => post('office-search-visible', { visible })
    })
    return () => {
      registerSearch(tabId, null)
      failPendingSearches()
    }
  }, [failPendingSearches, frame, host.viewId, post, registerSearch, session?.viewer])

  useEffect(() => {
    if (!frame || !host.viewId || session?.viewer !== 'office') return
    const tabId = host.viewId
    registerPresentationNavigation(tabId, (direction) => post('presentation-navigate', { direction }))
    return () => registerPresentationNavigation(tabId, null)
  }, [frame, host.viewId, post, registerPresentationNavigation, session?.viewer])

  useEffect(() => {
    if (!session || !frame || tab?.viewKind !== 'edit' || !session.capabilities.can_save) return
    return controller.registerSaveDelegate(session.id, () => new Promise((resolve) => {
      pendingSave.current = resolve
      post('save')
    }))
  }, [controller, frame, post, session?.id, tab?.viewKind])

  useEffect(() => {
    if (session?.saveState === 'clean' && documentReady) {
      post('host-saved')
      void imageLeases?.remove(serializedImages.current)
      serializedImages.current = []
    }
  }, [documentReady, imageLeases, post, session?.saveState])

  useEffect(() => {
    if (!bounds || !runtimeReady) return
    post('viewport-resize', { width: bounds.width, height: bounds.height })
  }, [bounds?.height, bounds?.width, post, runtimeReady])

  useEffect(() => {
    if (!frameReady || !documentBytes) return
    const identity = bindingIdentity
    if (loadedBinding.current === identity) return
    loadedBinding.current = identity
    setReadyBinding('')
    const copy = new Uint8Array(documentBytes)
    const load = documentProcessor
      ? officeProcessor(documentProcessor).bind({ filename: documentFilename })
      : { filename: documentFilename, processor: null, expectedDocumentKind: null }
    post('bind', {
      bindingId: identity,
      bytes: copy,
      ...load,
      editable: !binding && tab?.viewKind === 'edit' && session?.capabilities.can_edit === true
    }, [copy.buffer])
  }, [binding, bindingIdentity, documentBytes, documentFilename, documentProcessor, frameReady, post, session?.capabilities.can_edit, tab?.viewKind])

  useEffect(() => {
    activeRevealRequest.current = ''
    clearRevealTimeout()
  }, [clearRevealTimeout, viewId, session?.revision])

  useEffect(() => {
    if (!documentReady || !tab || session?.viewer !== 'office' || !reveal) return
    const revealKey = `${tab.id}:${reveal.sequence}`
    if (handledReveal.current === revealKey) return
    handledReveal.current = revealKey
    const requestId = crypto.randomUUID()
    activeRevealRequest.current = requestId
    clearRevealTimeout()
    revealTimeout.current = setTimeout(() => {
      if (activeRevealRequest.current !== requestId) return
      activeRevealRequest.current = ''
      setNotice({
        id: crypto.randomUUID(),
        message: OFFICE_REVEAL_TIMEOUT
      })
    }, OFFICE_SEARCH_TIMEOUT_MS)
    post('office-search', { requestId, query: reveal.query, direction: 'first' })
  }, [clearRevealTimeout, documentReady, post, reveal, session?.viewer, tab?.id])

  useEffect(() => {
    if (!frame) return
    const receive = (event: MessageEvent): void => {
      if (event.source !== frameRef.current?.contentWindow) return
      const message = event.data
      if (message?.kind !== 'scholarseed-office-editor' || message?.token !== frame.token) return
      if (message.type === 'frame-ready') {
        setFrameReady(true)
      } else if (message.type === 'font-permission-request') {
        void window.scholarseed.requestOfficeFontAccess().then((granted) => {
          post('font-permission-result', { granted })
        }).catch(() => {
          post('font-permission-result', { granted: false })
        })
      } else if (message.type === 'diagnostic') {
        console.info('[office-runtime]', JSON.stringify({ hostId: host.id, viewId: host.viewId, ...message.detail }))
      } else if (message.type === 'warmup') {
        const status = parseOfficeWarmupStatus(message)
        if (status) {
          setWarmup(status)
          if (status.stage === 'ready') setShowWarmupProgress(false)
        }
      } else if (message.type === 'runtime-ready') {
        setRuntimeReady(true)
      } else if (message.type === 'ready') {
        if (message.bindingId !== loadedBinding.current) return
        setReadyBinding(message.bindingId)
        if (session && message.readonlyReason) controller.restrictEditing(session.id, message.readonlyReason)
      } else if (message.type === 'focus' && tab) {
        controller.focusTab(viewId)
      } else if (message.type === 'save-request' && session) {
        void controller.save(session.id)
      } else if (message.type === 'image-request' && session && imageLeases) {
        const binding = loadedBinding.current
        const requestId = String(message.requestId)
        void (async () => {
          try {
            if (!window.scholarseed.acquireOfficeImage) throw new Error('office_image_permission')
            const result = await window.scholarseed.acquireOfficeImage(message.source)
            if (binding !== loadedBinding.current) return
            if (result.status === 'error') throw new OfficeImageError(result)
            if (result.status !== 'image') {
              if (message.source === 'clipboard' && (result.status === 'text' || result.status === 'empty')) {
                const clipboard = await window.scholarseed.readOfficeClipboard()
                if (binding !== loadedBinding.current) return
                if (clipboard.ok && clipboard.formats.some(format => format.mime !== 'text/plain')) {
                  post('image-result', { requestId, status: 'text', formats: clipboard.formats })
                  return
                }
                if (!clipboard.ok && clipboard.error !== 'clipboard_empty') throw new Error(clipboard.error)
              }
              post('image-result', { requestId, ...result })
              return
            }
            const lease = await stageOfficeImage(session.source, result.bytes)
            if (!await imageLeases.add(requestId, lease)) return
            if (binding !== loadedBinding.current) {
              await imageLeases.remove([requestId])
              return
            }
            post('image-result', { requestId, status: 'image', bytes: result.bytes }, [result.bytes.buffer])
          } catch (error) {
            if (binding !== loadedBinding.current) return
            post('image-result', { requestId, status: 'error' })
            setImageError({ cause: error })
          }
        })()
      } else if (message.type === 'image-failed') {
        void imageLeases?.remove([String(message.requestId)])
      } else if (message.type === 'dirty' && session) {
        controller.setExternalDirty(session.id, Boolean(message.dirty))
      } else if (message.type === 'operation-rejected') {
        setNotice({ id: crypto.randomUUID(), message: String(message.message), detail: typeof message.detail === 'string' ? message.detail : undefined })
      } else if (message.type === 'saved-bytes') {
        serializedImages.current = imageLeases?.snapshot() ?? []
        pendingSave.current?.(new Uint8Array(message.bytes))
        pendingSave.current = null
      } else if (message.type === 'save-failed') {
        if (message.message) setNotice({ id: crypto.randomUUID(), message: String(message.message), detail: typeof message.detail === 'string' ? message.detail : undefined })
        pendingSave.current?.(null)
        pendingSave.current = null
      } else if (message.type === 'paste-request') {
        const requestId = String(message.requestId ?? '')
        if (!requestId) return
        void window.scholarseed.readOfficeClipboard().then((result) => {
          post('paste-result', { requestId, ...result })
        }).catch(() => {
          post('paste-result', { requestId, ok: false, error: 'clipboard_failed' })
        })
      } else if (message.type === 'unavailable') {
        pendingSave.current?.(null)
        pendingSave.current = null
        failPendingReplacements()
        failPendingSearches()
      } else if ((message.type === 'office-search-open' || message.type === 'office-search-close') && tab) {
        publishSearchAction(viewId, message.type === 'office-search-open' ? 'open' : 'close')
      } else if (message.type === 'office-search-result' && tab) {
        const result: OfficeSearchResult = {
          ok: true,
          query: String(message.query ?? ''),
          location: String(message.location ?? ''),
          current: Number(message.current ?? 0),
          total: Number(message.total ?? 0)
        }
        const requestId = String(message.requestId ?? '')
        finishReveal(requestId, result.total > 0)
        const pending = pendingSearches.current.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingSearches.current.delete(requestId)
          pending.resolve(result)
        }
        publishSearchResult(viewId, result)
      } else if (message.type === 'office-search-failed' && tab) {
        const requestId = String(message.requestId ?? '')
        finishReveal(requestId, false)
        const pending = pendingSearches.current.get(requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        pendingSearches.current.delete(requestId)
        const error = message.error === 'search_unsupported' ? 'search_unsupported' : 'search_failed'
        const result: OfficeSearchResult = {
          ok: false, query: pending.query, location: '', current: 0, total: 0, error
        }
        pending.resolve(result)
        publishSearchResult(viewId, result)
      } else if (message.type === 'presentation-state' && tab) {
        const current = Math.max(0, Math.trunc(Number(message.current) || 0))
        const total = Math.max(0, Math.trunc(Number(message.total) || 0))
        publishPresentationState(viewId, {
          canNext: current > 0 && current < total,
          canPrevious: current > 1,
          current,
          total
        })
      } else if (message.type === 'selection-replaced' || message.type === 'selection-replace-failed') {
        const requestId = String(message.requestId ?? '')
        const pending = pendingReplacements.current.get(requestId)
        if (!pending) return
        clearTimeout(pending.timeout)
        pendingReplacements.current.delete(requestId)
        if (message.type === 'selection-replaced') pending.resolve({ ok: true })
        else if (message.error === 'selection_stale') pending.resolve({ ok: false, error: 'selection_changed' })
        else if (message.error === 'selection_unsupported') pending.resolve({ ok: false, error: 'unsupported' })
        else pending.resolve({ ok: false, error: 'replacement_failed' })
      } else if (message.type === 'selection' && session) {
        const selection = message.selection as OfficeSelection
        const calcAddress = selection.kind === 'calc' && selection.sheet && selection.range
          ? calcRange(selection.range)
          : ''
        const text = selection.content_mode === CALC_REFERENCE_MODE && selection.sheet && calcAddress
          ? calcSelectionReference(session.source.path, selection.sheet, calcAddress)
          : selection.text || ''
        if (!tab || !text.trim()) {
          if (tab) controller.setSelection(viewId, null)
          return
        }
        if (selection.kind === 'impress' && (
          typeof selection.slide !== 'number'
          || typeof selection.shape !== 'string'
          || !selection.shape
          || typeof selection.start !== 'number'
          || typeof selection.end !== 'number'
        )) {
          controller.setSelection(viewId, null)
          return
        }
        let locator: SelectionLocator
        if (selection.kind === 'calc' && selection.sheet && calcAddress) {
          locator = {
            kind: 'calc',
            sheet: selection.sheet,
            range: calcAddress,
            ...(selection.content_mode === CALC_REFERENCE_MODE ? { content_mode: CALC_REFERENCE_MODE } : {})
          }
        } else if (selection.kind === 'impress') {
          locator = {
            kind: 'impress',
            slide: Number(selection.slide),
            shape: String(selection.shape),
            start: Number(selection.start),
            end: Number(selection.end)
          }
        } else if (selection.kind === 'writer' && (selection.format === 'doc' || selection.format === 'docx')) {
          locator = {
            kind: 'writer',
            format: selection.format,
            paragraph: selection.paragraph || 'current',
            ...(selection.end_paragraph ? { end_paragraph: selection.end_paragraph } : {}),
            start: selection.start || 0,
            end: selection.end || text.length
          }
        } else {
          controller.setSelection(viewId, null)
          return
        }
        const frameBounds = frameRef.current?.getBoundingClientRect()
        if (!frameBounds) {
          controller.setSelection(viewId, null)
          return
        }
        const localPoint = message.point as OfficeSelectionPoint | undefined
        const x = frameBounds.left + Math.max(0, Math.min(frameBounds.width, localPoint?.x ?? frameBounds.width / 2))
        const y = frameBounds.top + Math.max(0, Math.min(frameBounds.height, localPoint?.y ?? frameBounds.height / 2))
        controller.setSelection(viewId, {
          document_id: session.documentId,
          document_session_id: session.id,
          revision: session.revision,
          status: 'exact',
          text,
          context_text: selection.context_text,
          locator
        }, selectionViewport(
          { left: x, top: y, right: x + 1, bottom: y + 1, width: 1, height: 1 },
          { x, y }
        ))
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [controller, failPendingReplacements, failPendingSearches, finishReveal, frame, host.id, host.viewId, imageLeases, post, publishPresentationState, publishSearchAction, publishSearchResult, session, tab])

  const visible = Boolean((anchor || switchingDocument) && bounds && bounds.width > 0 && bounds.height > 0)
  const style: React.CSSProperties = visible && bounds
    ? {
        left: bounds.left,
        top: bounds.top,
        width: isPresentationDocument ? `calc(${bounds.width}px + var(--vds-space-5))` : bounds.width,
        height: isPresentationDocument ? `calc(${bounds.height}px + var(--vds-space-5))` : bounds.height,
        clipPath: isPresentationDocument ? 'inset(0 var(--vds-space-5) var(--vds-space-5) 0)' : undefined,
        visibility: 'visible',
        opacity: documentReady || switchingDocument ? 1 : 0,
        backgroundColor: palette.background,
        pointerEvents: interactionBlocked ? 'none' : 'auto'
      }
    : {
        left: -IDLE_HOST_SIZE.width * 2,
        top: 0,
        ...IDLE_HOST_SIZE,
        visibility: 'hidden',
        pointerEvents: 'none'
      }

  return frame ? (<>
    <iframe
      ref={frameRef}
      className="vds-office-runtime-frame"
      srcDoc={frame.html}
      title={binding?.title || session?.title || t('officeDocument.spare')}
      allow="local-fonts"
      onLoad={() => setFrameReady(true)}
      style={style}
      data-testid="office-editor"
      data-runtime-slot={host.id}
      data-runtime-language={frameLanguage}
      data-runtime-ready={runtimeReady}
      data-document-ready={documentReady}
      data-office-presentation={isPresentationDocument}
    />
    {visible && bounds && switchingDocument && <div
      className="vds-office-switch-mask"
      style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
      data-testid="office-switch-mask"
      aria-hidden="true"
    />}
    {bounds && requestedLanguage !== frameLanguage && session && session.saveState !== 'clean' && <div className="fixed z-[var(--vds-z-popover)]" style={{ left: bounds.left, top: bounds.top, width: bounds.width }}><Alert tone="info" title={t('officeDocument.languagePending')} /></div>}
    {imageError && <Toaster toasts={[{ id: 'office-image-error', tone: 'warning', title: imageError.cause instanceof Error && imageError.cause.message === 'office_image_permission' ? officeFailureText(imageError.cause.message, t) : imageFailureText(imageError.cause) }]} onDismiss={() => setImageError(null)} closeLabel={t('officeDocument.close')} />}
    {notice && <Toaster toasts={[{ id: notice.id, tone: 'warning', title: officeFailureText(notice.message, t), description: notice.detail }]} onDismiss={() => setNotice(null)} closeLabel={t('officeDocument.close')} />}
    <OfficeWarmup
      status={warmup}
      visible={showWarmupProgress}
      onRetry={() => {
        setShowWarmupProgress(true)
        setWarmup(INITIAL_OFFICE_WARMUP_STATUS)
        setFrameEpoch(epoch => epoch + 1)
      }}
    />
  </>) : <></>
}

export function OfficeRuntimeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const workspace = useDocumentWorkspace()
  const anchors = useRef(new Map<string, HTMLDivElement>())
  const [registeredViews, setRegisteredViews] = useState<Record<string, OfficeViewBinding>>({})
  const replacements = useRef(new Map<string, OfficeReplacement>())
  const searches = useRef(new Map<string, OfficeSearch>())
  const presentationNavigations = useRef(new Map<string, OfficePresentationNavigation>())
  const presentationListeners = useRef(new Map<string, (state: OfficePresentationState) => void>())
  const searchListeners = useRef(new Map<string, OfficeSearchListener>())
  const nextHostId = useRef(0)
  const [, setAnchorVersion] = useState(0)
  const [hostState, setHostState] = useState<OfficeHostState>(() => reconcileOfficeHosts(
    { hosts: [] },
    [],
    () => `office-host-${++nextHostId.current}`
  ))
  const [interactionBlocked, setInteractionBlocked] = useState(false)
  const [runtimeRoot, setRuntimeRoot] = useState<HTMLElement | null>(null)
  const officeViewIds = Object.values(workspace.tabs)
    .filter((tab) => {
      const viewer = workspace.sessions[tab.sessionId]?.viewer
      return viewer === 'office' || viewer === 'spreadsheet'
    })
    .map((tab) => tab.id)
    .concat(Object.keys(registeredViews))
    .sort()
  const demandKey = officeViewIds.join('\u0000')

  useEffect(() => {
    setHostState((current) => reconcileOfficeHosts(
      current,
      officeViewIds,
      () => `office-host-${++nextHostId.current}`
    ))
  }, [demandKey])

  useLayoutEffect(() => {
    setRuntimeRoot(document.getElementById(OFFICE_RUNTIME_ROOT_ID))
  }, [])

  const registerAnchor = useCallback((viewId: string, element: HTMLDivElement | null): void => {
    if (element) anchors.current.set(viewId, element)
    else anchors.current.delete(viewId)
    setAnchorVersion((value) => value + 1)
  }, [])
  const registerView = useCallback((viewId: string, binding: OfficeViewBinding | null): void => {
    setRegisteredViews((current) => {
      if (!binding) {
        if (!current[viewId]) return current
        const next = { ...current }
        delete next[viewId]
        return next
      }
      return current[viewId] === binding ? current : { ...current, [viewId]: binding }
    })
  }, [])
  const registerReplacement = useCallback((tabId: string, replacement: OfficeReplacement | null): void => {
    if (replacement) replacements.current.set(tabId, replacement)
    else replacements.current.delete(tabId)
  }, [])
  const registerSearch = useCallback((tabId: string, search: OfficeSearch | null): void => {
    if (search) searches.current.set(tabId, search)
    else searches.current.delete(tabId)
  }, [])
  const registerPresentationNavigation = useCallback((tabId: string, navigation: OfficePresentationNavigation | null): void => {
    if (navigation) presentationNavigations.current.set(tabId, navigation)
    else presentationNavigations.current.delete(tabId)
  }, [])
  const registerOfficeSearch = useCallback((tabId: string, listener: OfficeSearchListener | null): void => {
    if (listener) searchListeners.current.set(tabId, listener)
    else searchListeners.current.delete(tabId)
  }, [])
  const registerPresentationState = useCallback((tabId: string, listener: ((state: OfficePresentationState) => void) | null): void => {
    if (!listener) {
      presentationListeners.current.delete(tabId)
      return
    }
    presentationListeners.current.set(tabId, listener)
  }, [])
  const publishSearchAction = useCallback((tabId: string, action: 'open' | 'close'): void => {
    searchListeners.current.get(tabId)?.[action]()
  }, [])
  const publishSearchResult = useCallback((tabId: string, result: OfficeSearchResult): void => {
    searchListeners.current.get(tabId)?.update(result)
  }, [])
  const publishPresentationState = useCallback((tabId: string, state: OfficePresentationState): void => {
    presentationListeners.current.get(tabId)?.(state)
  }, [])
  const value = useMemo<OfficeRuntimeContextValue>(() => ({
    registerAnchor,
    registerView,
    registerOfficeSearch,
    registerPresentationState,
    navigatePresentation: (tabId, direction) => presentationNavigations.current.get(tabId)?.(direction),
    replaceSelection: (tabId, request) => replacements.current.get(tabId)?.(request)
      ?? Promise.resolve({ ok: false, error: 'unsupported' }),
    searchOffice: (tabId, query, direction) => searches.current.get(tabId)?.run(query, direction)
      ?? Promise.resolve({
        ok: false, query, location: '', current: 0, total: 0, error: 'search_unsupported'
      }),
    setOfficeSearchVisible: (tabId, visible) => searches.current.get(tabId)?.setVisible(visible),
    setInteractionBlocked
  }), [registerAnchor, registerOfficeSearch, registerPresentationState, registerView])

  return (
    <OfficeRuntimeContext.Provider value={value}>
      {children}
      {runtimeRoot && createPortal(
        <>
        {hostState.hosts.map((host) => (
          <OfficeHost
            key={host.id}
            host={host}
            anchor={host.viewId ? anchors.current.get(host.viewId) ?? null : null}
            binding={host.viewId ? registeredViews[host.viewId] ?? null : null}
            registerReplacement={registerReplacement}
            registerSearch={registerSearch}
            registerPresentationNavigation={registerPresentationNavigation}
            publishPresentationState={publishPresentationState}
            publishSearchAction={publishSearchAction}
            publishSearchResult={publishSearchResult}
            interactionBlocked={interactionBlocked}
          />
        ))}
        </>,
        runtimeRoot
      )}
    </OfficeRuntimeContext.Provider>
  )
}

export function useOfficeRuntime(): OfficeRuntimeContextValue {
  const value = useContext(OfficeRuntimeContext)
  if (!value) throw new Error('Office runtime provider is missing')
  return value
}
