import { ExternalLink, FileLock2, NotepadText, Undo2 } from 'lucide-react'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

import { openSystemPath } from '../../api'
import { writeClipboardImage } from '../../components/primitive/clipboard'
import { useApp } from '../../store'
import { LiteratureExcerptImport } from '../../components/business/Excerpts'
import {
  Button,
  CopyButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  IconButton,
  Input,
  ResizablePanel,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  useToast,
  type ToastTone,
} from '../../components/ui'
import { CITATION_VIEW_STATE_KEY, type CitationFocus } from '../../contracts/citations'
import type { DocumentPanelContext, DocumentPanelContribution } from '../../contracts/features'
import type { SelectionAnchor } from '../../contracts/workbench'
import {
  asLiteratureExcerptSource,
  LITERATURE_EXCERPT_VIEW_STATE_KEY,
  PDF_EXCERPT_LOCATOR_KIND,
  type LiteratureExcerptSelection,
  type PdfExcerptQuad
} from '../../contracts/resources'
import { Icon } from '../../icons'
import { resolveShortcut } from '../../shortcuts'
import { useSelectionActionContribution } from './actions'
import {
  commitPdfRecords,
  isLocatedDocumentSource,
  loadPdfRecords,
  recordTargetFor,
  resolveDocumentLocation,
  subscribePdfRecords,
  type PdfComment,
  type PdfMark,
  type PdfRecordSnapshot,
  type PdfRecords
} from './api'
import { useWorkspaceController, selectionViewport, useDocumentWorkspace } from './workspace'
import { PDF_COMMENT_TOOL, PdfTools, type PdfTool } from './pdf/Tools'
import { PdfAnnotations } from './pdf/Annotations'
import { PdfPageSlot, type PdfFocus, type PdfFocusTarget } from './pdf/Page'
import { PdfAnnotation } from './pdf/Annotation'
import {
  exportAnnotatedPdf,
  restoreAnnotatedPdf,
  PDF_EXPORT_ERROR_CODE,
  PdfExportError
} from './pdf/export'
import { citationRegions, clipQuads, normalizeQuads, selectionRectangles, enclosingRectangle, fittedScale, matchText, MAX_SCALE, MIN_SCALE, mostVisiblePage, PAGE_GUTTER, pageInSelectionSpan, pageNumber, SCALE_STEP, selectionPageText, THUMBNAIL_WIDTH, type PdfFitMode, type Size } from './pdf/geometry'
import { outlineTree, resolveDestination, type PdfDestination, type PdfDestinationResolver, type PdfOutlineItem } from './pdf/navigation'
import { PdfOutline } from './pdf/Outline'
import { PdfPanel } from './pdf/Panel'
import {
  DEFAULT_PDF_MARK_COLOR,
  PDF_RECORD_SCHEMA_VERSION,
  stagePdfRecords,
  type PdfMarkColor
} from './pdf/records'
import './pdf/pdf.css'
import { PdfBinaryDataFactory } from './pdf/assets'
import { PdfFonts } from './pdf/fonts'
import { PdfLifecycle } from './pdf/lifecycle'
import {
  classifyPdfLoadFailure,
  PDF_LOAD_FAILURE_KIND,
  type PdfLoadFailure
} from './pdf/loading'
import { usePdfAnalysis } from './pdf/Reading'
import { loadPdfVisualRegionImage, loadPdfVisualRegions, type PdfVisualRegion } from './pdf/analysis'
import { PdfScale } from './pdf/Scale'
import { pdfWheelScale } from './pdf/zoom'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const SEARCH_BATCH_SIZE = 8
const SEARCH_DELAY_MS = 180
const MIN_FIGURE_SELECTION_PX = 8
const PDF_NAVIGATION_DEFAULT_WIDTH_PX = 190
const PDF_NAVIGATION_MIN_WIDTH_PX = 190
const PDF_NAVIGATION_MAX_WIDTH_PX = 360
const PDF_ACTUAL_SCALE = 1
const PDF_SCROLL_STEP_PX = 64
const PDF_PAGE_SCROLL_RATIO = 0.9
const PDF_RECORDS_PANEL_ID = 'pdf-records'
const PDF_DEFAULT_PAGE_SIZE: Size = { width: 612, height: 792 }
const PDF_NEAR_PAGE_RADIUS = 1

function logPdfExportFailure(error: unknown): void {
  const cause = error instanceof PdfExportError && error.original instanceof Error ? error.original : null
  console.error(`[pdf-export] ${JSON.stringify({
    stage: error instanceof PdfExportError ? error.stage : 'unknown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: cause ? { message: cause.message, stack: cause.stack } : undefined
  })}`)
}

const DEFAULT_FIT_MODE: PdfFitMode = 'width'
interface SearchHit { page: number; text: string; ordinal: number }
interface PageSelection { page: number; text: string; quads: number[][] }
interface SelectionDragSpan { anchor: number; focus: number }
interface PdfZoomAnchor { page: number; x: number; y: number; clientX: number; clientY: number }

function searchSnippet(text: string, query: string): React.ReactNode {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return text
  const matchIndex = text.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase())
  if (matchIndex < 0) return text
  const matchEnd = matchIndex + normalizedQuery.length
  return <>{text.slice(0, matchIndex)}<mark className="rounded-[var(--vds-radius-2)] bg-[var(--vds-brand-bg-light)] px-0.5 text-inherit">{text.slice(matchIndex, matchEnd)}</mark>{text.slice(matchEnd)}</>
}

function EncryptedPdfState({
  canOpenExternally,
  opening,
  onOpen
}: {
  canOpenExternally: boolean
  opening: boolean
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return <div className="grid flex-1 place-items-center" data-testid="encrypted-pdf-state">
    <EmptyState
      description={t('encrypted.description')}
      icon={<FileLock2 />}
      title={t('encrypted.title')}
      action={canOpenExternally ? <Button
        data-testid="encrypted-pdf-open-external"
        disabled={opening}
        icon={<ExternalLink />}
        loading={opening}
        onClick={onOpen}
      >{opening ? t('encrypted.opening') : t('encrypted.openExternal')}</Button> : undefined}
    />
  </div>
}

function persistedSelectionViewport(
  host: HTMLElement,
  selections: readonly PageSelection[]
): ReturnType<typeof selectionViewport> | null {
  const selection = selections.at(-1)
  if (!selection) return null
  const page = Array.from(host.querySelectorAll<HTMLElement>('.vds-pdf-page'))
    .find(element => Number(element.dataset.page) === selection.page)
  if (!page) return null
  const pageBounds = page.getBoundingClientRect()
  const rects = selection.quads.map(quad => ({
    left: pageBounds.left + quad[0] * pageBounds.width,
    top: pageBounds.top + quad[1] * pageBounds.height,
    right: pageBounds.left + quad[2] * pageBounds.width,
    bottom: pageBounds.top + quad[3] * pageBounds.height
  }))
  const bounds = enclosingRectangle(rects)
  const last = rects.at(-1)
  if (!bounds || !last) return null
  const point = { x: last.right, y: last.bottom }
  const hostBounds = host.getBoundingClientRect()
  const visible = point.x > Math.max(0, hostBounds.left)
    && point.x < Math.min(window.innerWidth, hostBounds.right)
    && point.y > Math.max(0, hostBounds.top)
    && point.y < Math.min(window.innerHeight, hostBounds.bottom)
  return selectionViewport(
    { ...bounds, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
    point,
    visible
  )
}

function toExcerptSelections(selections: readonly PageSelection[]): LiteratureExcerptSelection[] {
  return selections.map((selection) => ({
    text: selection.text,
    locator: {
      kind: PDF_EXCERPT_LOCATOR_KIND,
      page: selection.page,
      quads: selection.quads.map((quad): PdfExcerptQuad => [quad[0], quad[1], quad[2], quad[3]])
    }
  }))
}

export function PdfDocument({
  active,
  documentPanels,
  sessionId,
  tabId,
  onResourceImported
}: {
  active: boolean
  documentPanels?: {
    activePanelId: string | null
    context: DocumentPanelContext
    panels: DocumentPanelContribution[]
    toggle: (panelId: string) => void
  }
  sessionId: string
  tabId: string
  onResourceImported?: () => void | Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation('pdf')
  const { set } = useApp()
  const controller = useWorkspaceController()
  const workspace = useDocumentWorkspace()
  const session = workspace.sessions[sessionId]
  const tab = workspace.tabs[tabId]
  const reading = tab?.viewState
  const isLiterature = session?.source.kind === 'literature'
  const literatureId = session?.source.kind === 'literature' ? session.source.literatureId : ''
  const attachmentId = session?.source.kind === 'literature' ? session.source.attachmentId : ''
  const citation = reading?.[CITATION_VIEW_STATE_KEY] as CitationFocus | undefined
  const citationPages = citation?.revision === session?.revision ? citation.pages : undefined
  const citationTargets = citationPages?.flatMap(target => citationRegions(target.quads).map((_, region) => ({ page: target.page, region }))) ?? []
  const excerptSource = asLiteratureExcerptSource(reading?.[LITERATURE_EXCERPT_VIEW_STATE_KEY])
  const currentPage = typeof reading?.page === 'number' ? reading.page : 1
  const storedScale = typeof reading?.scale === 'number' ? reading.scale : 1
  const mode: PdfFitMode = reading?.mode === 'page' || reading?.mode === 'width' || reading?.mode === 'custom'
    ? reading.mode
    : DEFAULT_FIT_MODE
  const sidebar = reading?.sidebar === true
  const navigationWidth = typeof reading?.navigationWidth === 'number' && Number.isFinite(reading.navigationWidth)
    ? Math.min(Math.max(reading.navigationWidth, PDF_NAVIGATION_MIN_WIDTH_PX), PDF_NAVIGATION_MAX_WIDTH_PX)
    : PDF_NAVIGATION_DEFAULT_WIDTH_PX
  const recordsOpen = isLiterature && reading?.records === true
  const [expandedPanel, setExpandedPanel] = useState<string | null>(null)
  const query = typeof reading?.query === 'string' ? reading.query : ''
  const sidebarTab = reading?.sidebarTab === 'pages' || reading?.sidebarTab === 'search'
    ? reading.sidebarTab
    : 'outline'
  const [pageCount, setPageCount] = useState(0)
  const [loadedPages, setLoadedPages] = useState<Map<number, PDFPageProxy>>(() => new Map())
  const [visualRegions, setVisualRegions] = useState<PdfVisualRegion[]>([])
  const [estimatedPageSize, setEstimatedPageSize] = useState<Size>(PDF_DEFAULT_PAGE_SIZE)
  const [translationLayoutOpen, setTranslationLayoutOpen] = useState(false)
  const [selectionDragSpan, setSelectionDragSpan] = useState<SelectionDragSpan | null>(null)
  const cropStart = useRef<{ x: number; y: number; bounds: DOMRect; page: number }>()
  const [cropBox, setCropBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [fonts, setFonts] = useState(() => new PdfFonts())
  const [lifecycle] = useState(() => new PdfLifecycle<Uint8Array, PDFDocumentProxy, PDFPageProxy>({
    createTask: bytes => getDocument({
      data: new Uint8Array(bytes),
      BinaryDataFactory: PdfBinaryDataFactory,
      useWorkerFetch: false,
      fontExtraProperties: true
    }),
    restore: restoreAnnotatedPdf
  }))
  const [outline, setOutline] = useState<PdfOutlineItem[]>([])
  const [sidecar, setSidecar] = useState<PdfRecordSnapshot | null>(null)
  const paletteLabels = {
    yellow: t('palette.yellow'),
    orange: t('palette.orange'),
    green: t('palette.green'),
    teal: t('palette.teal'),
    blue: t('palette.blue'),
    purple: t('palette.purple'),
    red: t('palette.red'),
    gray: t('palette.gray'),
  }
  const { toast } = useToast()
  const statusText = {
    readFailed: t('status.readFailed'),
    conflict: t('status.conflict'),
    saveFailed: t('status.saveFailed'),
    copied: t('status.copied'),
    copyFailed: t('status.copyFailed'),
    excerptSaved: t('status.excerptSaved'),
    exportFailed: t('status.exportFailed'),
    deleted: t('status.deleted'),
    exported: t('status.exported'),
  }
  const statusTone: Record<keyof typeof statusText, ToastTone> = {
    readFailed: 'error',
    conflict: 'error',
    saveFailed: 'error',
    copied: 'success',
    copyFailed: 'error',
    excerptSaved: 'success',
    exportFailed: 'error',
    deleted: 'success',
    exported: 'success',
  }
  type PdfResultCode = keyof typeof statusText
  const notifyResult = (code: PdfResultCode): void => {
    toast({ title: statusText[code], tone: statusTone[code] })
  }
  const [loadError, setLoadError] = useState<PdfLoadFailure | null>(null)
  const [externalOpening, setExternalOpening] = useState(false)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [pageInput, setPageInput] = useState(String(currentPage))
  const [goToPageOpen, setGoToPageOpen] = useState(false)
  const [goToPageValue, setGoToPageValue] = useState(String(currentPage))
  const [selections, setSelections] = useState<PageSelection[]>([])
  const excerptSelections = useMemo(() => toExcerptSelections(selections), [selections])
  const [highlightOpen, setHighlightOpen] = useState(false)
  const [activeTool, setActiveTool] = useState<PdfTool | null>(null)
  const [activeMark, setActiveMark] = useState<string | null>(null)
  const [markColors, setMarkColors] = useState<Record<PdfMark['style'], PdfMarkColor>>({ highlight: DEFAULT_PDF_MARK_COLOR, underline: DEFAULT_PDF_MARK_COLOR, strikethrough: DEFAULT_PDF_MARK_COLOR })
  const [commentFormOpen, setCommentFormOpen] = useState(false)
  const [commentDraft, setCommentDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const [focus, setFocus] = useState<PdfFocus>()
  const destinationResolver = useRef<PdfDestinationResolver>()
  const [returnPosition, setReturnPosition] = useState<{ page: number; top: number; left: number } | null>(null)
  const citationTargetIndex = focus?.kind === 'citation' && focus.region !== undefined
    ? citationTargets.findIndex(target => target.page === focus.page && target.region === focus.region) : -1
  const focusSequence = useRef(0)
  const requestFocus = useCallback((target: PdfFocusTarget): void => {
    setFocus({ ...target, sequence: ++focusSequence.current })
  }, [])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [hitIndex, setHitIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [hasText, setHasText] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const zoomAnchorRef = useRef<PdfZoomAnchor>()
  const wheelZoomFrameRef = useRef<number>()
  const wheelZoomScaleRef = useRef<number>()
  const wheelZoomEventRef = useRef<WheelEvent>()
  const textCache = useRef(new Map<number, string>())
  const readingRef = useRef(reading)
  readingRef.current = reading
  const mounted = useRef(true)
  const activeDocumentPanel = documentPanels?.panels.find(
    (panel) => panel.id === documentPanels.activePanelId
  ) ?? null
  const closeDocumentPanel = (): void => {
    setExpandedPanel(null)
    if (documentPanels?.activePanelId) {
      documentPanels.toggle(documentPanels.activePanelId)
    }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const update = useCallback((patch: Record<string, unknown>): void => {
    controller.setTabViewState(tabId, { ...readingRef.current, ...patch })
  }, [tabId])

  useEffect(() => {
    setPageCount(0)
    setLoadedPages(new Map())
    setOutline([])
    destinationResolver.current = undefined
    textCache.current.clear()
    if (!active || !session?.bytes.length) {
      void lifecycle.suspend()
      return
    }
    let running = true
    setLoadError(null)
    const fontOwner = new PdfFonts()
    setFonts(fontOwner)
    void lifecycle.open(session.bytes, currentPage).then(opened => {
      if (!opened || !running) return
      const pdf = opened.document
      const initialViewport = opened.page.getViewport({ scale: 1 })
      setEstimatedPageSize({ width: initialViewport.width, height: initialViewport.height })
      setPageCount(opened.pageCount)
      setLoadedPages(new Map([[opened.page.pageNumber, opened.page]]))
      for (
        let pageNumber = Math.max(1, opened.page.pageNumber - PDF_NEAR_PAGE_RADIUS);
        pageNumber <= Math.min(opened.pageCount, opened.page.pageNumber + PDF_NEAR_PAGE_RADIUS);
        pageNumber += 1
      ) {
        if (pageNumber === opened.page.pageNumber) continue
        void lifecycle.getPage(pageNumber).then(page => {
          if (!running || !page) return
          setLoadedPages(current => new Map(current).set(pageNumber, page))
        })
      }
      destinationResolver.current = {
        namedDestination: name => pdf.getDestination(name),
        pageIndex: reference => pdf.getPageIndex(reference as Parameters<typeof pdf.getPageIndex>[0]),
        pageViewport: async targetPage => (await pdf.getPage(targetPage)).getViewport({ scale: 1 })
      }
      void pdf.getOutline().then(rawOutline => outlineTree(rawOutline, {
        namedDestination: name => pdf.getDestination(name),
        pageIndex: reference => pdf.getPageIndex(reference as Parameters<typeof pdf.getPageIndex>[0])
      })).then(resolvedOutline => {
        if (running) setOutline(resolvedOutline)
      }).catch(() => {
        if (running) setOutline([])
      })
    }).catch((error: unknown) => {
      if (running) setLoadError(classifyPdfLoadFailure(error))
    })
    return () => {
      running = false
      destinationResolver.current = undefined
      fontOwner.dispose()
      void lifecycle.suspend()
    }
  }, [active, lifecycle, session?.revision, sessionId])

  const loadPage = useCallback(async (pageNumber: number): Promise<PDFPageProxy | null> => {
    const page = await lifecycle.getPage(pageNumber)
    if (page) {
      setLoadedPages(current => current.get(pageNumber) === page
        ? current
        : new Map(current).set(pageNumber, page))
    }
    return page
  }, [lifecycle])

  useEffect(() => {
    if (!active || !session) return
    setSidecar(null)
    if (!recordTargetFor(session.source)) return
    let running = true
    let receivedUpdate = false
    const unsubscribe = subscribePdfRecords(session.source, snapshot => {
      receivedUpdate = true
      if (running) {
        setSidecar(snapshot)
      }
    })
    void loadPdfRecords(session.source).then(snapshot => {
      if (!running || receivedUpdate) return
      setSidecar(snapshot)
      if (!snapshot) notifyResult('readFailed')
    })
    return () => { running = false; unsubscribe() }
  }, [active, session?.documentId, session?.revision])

  useLayoutEffect(() => {
    const host = viewportRef.current
    if (!host) return
    const observer = new ResizeObserver(() => setSize({ width: host.clientWidth, height: host.clientHeight }))
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const activePage = loadedPages.get(pageNumber(currentPage, pageCount))
  const natural = activePage?.getViewport({ scale: 1 })
  const fitViewportWidth = size.width + (sidebar ? navigationWidth : 0)
  const fittedPageSize = natural && translationLayoutOpen
    ? { width: natural.width * 2, height: natural.height }
    : natural
  const scale = mode === 'custom' ? storedScale : fittedPageSize && size.width && size.height
    ? fittedScale(mode, fittedPageSize, { width: Math.max(1, fitViewportWidth - PAGE_GUTTER), height: Math.max(1, size.height - PAGE_GUTTER) }) : 1
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const navigate = useCallback((target: number): void => {
    setFocus(undefined)
    setReturnPosition(null)
    const page = pageNumber(target, pageCount)
    update({ page })
    viewportRef.current?.querySelector<HTMLElement>(`[data-testid="pdf-page-${page}"]`)?.scrollIntoView({ block: 'start', inline: 'center' })
  }, [pageCount, update])

  const navigateInternalLink = useCallback(async (destination: PdfDestination): Promise<void> => {
    const resolver = destinationResolver.current
    const viewport = viewportRef.current
    if (!resolver || !viewport) return
    const target = await resolveDestination(destination, resolver)
    if (!target) return
    setReturnPosition({ page: currentPage, top: viewport.scrollTop, left: viewport.scrollLeft })
    update({ page: target.page })
    requestFocus({ kind: 'link', ...target })
  }, [currentPage, requestFocus, update])

  const returnToLinkSource = useCallback((): void => {
    const position = returnPosition
    const viewport = viewportRef.current
    if (!position || !viewport) return
    setReturnPosition(null)
    setFocus(undefined)
    update({ page: position.page })
    window.requestAnimationFrame(() => viewport.scrollTo({ top: position.top, left: position.left }))
  }, [returnPosition, update])

  // Restore page after tab remount or geometry changes. Scrolling itself does not trigger this effect.
  useLayoutEffect(() => {
    const zoomAnchor = zoomAnchorRef.current
    if (zoomAnchor) {
      zoomAnchorRef.current = undefined
      const page = viewportRef.current?.querySelector<HTMLElement>(`[data-testid="pdf-page-${zoomAnchor.page}"]`)
      if (page) {
        const bounds = page.getBoundingClientRect()
        viewportRef.current?.scrollBy({
          left: bounds.left + bounds.width * zoomAnchor.x - zoomAnchor.clientX,
          top: bounds.top + bounds.height * zoomAnchor.y - zoomAnchor.clientY
        })
        return
      }
    }
    // Citation geometry owns its scroll; do not jump to the page before it animates.
    if (citationPages?.length) {
      requestFocus(focus?.kind === 'citation' ? focus : { kind: 'citation', page: citationPages[0].page })
      return
    }
    viewportRef.current?.querySelector<HTMLElement>(`[data-testid="pdf-page-${currentPage}"]`)?.scrollIntoView({ block: 'start', inline: 'center' })
    if (focus?.kind === 'citation' && focus.page === currentPage) {
      requestFocus({ kind: 'citation', page: currentPage, region: focus.region })
    }
  }, [pageCount, scale, sidebar, translationLayoutOpen])
  useEffect(() => setPageInput(String(currentPage)), [currentPage])

  useEffect(() => {
    const page = citationPages?.[0]?.page
    if (!page || !pageCount) return
    requestFocus({ kind: 'citation', page })
  }, [citation, pageCount, requestFocus])

  useEffect(() => {
    if (query.trim()) setFocus(undefined)
    if (!query.trim() || !pageCount) { setHits([]); setSearching(false); return }
    let active = true
    setSearching(true)
    setSearchError(null)
    setHits([])
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: SearchHit[] = []
        let anyText = false
        for (let first = 1; first <= pageCount && active; first += SEARCH_BATCH_SIZE) {
          const batch = await Promise.all(Array.from(
            { length: Math.min(SEARCH_BATCH_SIZE, pageCount - first + 1) },
            async (_, offset) => {
            const page = await loadPage(first + offset)
            if (!page) return null
            let text = textCache.current.get(page.pageNumber)
            if (text === undefined) {
              const content = await page.getTextContent()
              text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
              if (active) textCache.current.set(page.pageNumber, text)
            }
            return { page: page.pageNumber, text }
          }))
          for (const item of batch) {
            if (!item) continue
            anyText ||= Boolean(item.text.trim())
            for (const [ordinal, match] of matchText(item.text, query).entries()) found.push({ page: item.page, text: item.text.slice(match.start, match.end), ordinal })
          }
        }
        if (!active) return
        setHits(found)
        setHitIndex(0)
        setHasText(anyText)
        setSearching(false)
        if (found.length) {
          navigate(found[0].page)
          requestFocus({ kind: 'search', page: found[0].page, ordinal: found[0].ordinal })
        }
      })().catch((error: unknown) => {
        if (active) { setSearching(false); setSearchError(error instanceof Error ? error.message : String(error)) }
      })
    }, SEARCH_DELAY_MS)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query, pageCount, loadPage, navigate, requestFocus])

  const captureSelection = (applyTool = false): void => {
    setActiveMark(null)
    const selection = window.getSelection()
    const host = viewportRef.current
    if (!host || !selection || selection.isCollapsed || !selection.rangeCount) {
      setSelections([])
      controller.setSelection(tabId, null)
      return
    }
    const sourceRange = selection.getRangeAt(0)
    const next: PageSelection[] = []
    host.querySelectorAll<HTMLElement>('.vds-pdf-page').forEach(page => {
      const layer = page.querySelector<HTMLElement>('.textLayer')
      if (!layer || !sourceRange.intersectsNode(layer)) return
      const pageRange = document.createRange()
      pageRange.selectNodeContents(layer)
      const clipped = sourceRange.cloneRange()
      if (sourceRange.compareBoundaryPoints(Range.START_TO_START, pageRange) < 0) clipped.setStart(pageRange.startContainer, pageRange.startOffset)
      if (sourceRange.compareBoundaryPoints(Range.END_TO_END, pageRange) > 0) clipped.setEnd(pageRange.endContainer, pageRange.endOffset)
      const withinPage = layer.contains(sourceRange.startContainer) && layer.contains(sourceRange.endContainer)
      const text = selectionPageText(selection.toString(), clipped.toString(), withinPage)
      const quads = normalizeQuads(clipQuads(selectionRectangles(clipped, layer), page.getBoundingClientRect()))
      if (text && quads.length) next.push({ page: Number(page.dataset.page), text, quads })
    })
    if (!next.length) {
      setSelections([])
      controller.setSelection(tabId, null)
      return
    }
    setSelections(next)
    if (applyTool && activeTool && activeTool !== PDF_COMMENT_TOOL) {
      void addMark(activeTool, markColors[activeTool], next)
      return
    }
    if (applyTool && activeTool === PDF_COMMENT_TOOL) setCommentFormOpen(true)
    const first = next[0]
    const viewport = persistedSelectionViewport(host, next)
    if (!session || !viewport) {
      controller.setSelection(tabId, null)
      return
    }
    controller.setSelection(tabId, {
      document_id: session.documentId, document_session_id: sessionId, revision: session.revision,
      status: 'exact', text: first.text, locator: { kind: 'pdf', page: first.page, quads: first.quads, text_length: Array.from(first.text).length }
    }, viewport)
  }

  const selectedText = selections.map(selection => selection.text).join('\n')
  const clearSelection = (): void => {
    setActiveMark(null)
    setSelections([])
    setHighlightOpen(false)
    setCommentFormOpen(false)
    setCommentDraft('')
    controller.setSelection(tabId, null)
    window.getSelection()?.removeAllRanges()
  }

  const selectionMarks = (style: PdfMark['style'], color: PdfMarkColor, selected = selections): PdfMark[] => (
    selected.map(selection => {
      const timestamp = Date.now() / 1000
      return {
        ...selection,
        id: crypto.randomUUID(),
        style,
        color,
        anchor_state: 'anchored',
        created_at: timestamp,
        updated_at: timestamp
      }
    })
  )

  const persistRecords = async (
    next: PdfRecords,
    options: { clear?: boolean; focus?: PdfMark; statusCode?: PdfResultCode }
  ): Promise<boolean> => {
    if (!session || !sidecar || saving) return false
    const previous = sidecar
    const pendingFocus = options.focus
    const rollback = (): void => {
      setSidecar(previous)
      if (pendingFocus && !previous.records.marks.some(mark => mark.id === pendingFocus.id)) setActiveMark(null)
    }
    setSaving(true)
    setSidecar(stagePdfRecords(previous, next))
    if (options.clear) clearSelection()
    if (pendingFocus) {
      setActiveMark(pendingFocus.id)
      setSelections([{ page: pendingFocus.page, text: pendingFocus.text, quads: pendingFocus.quads }])
    }
    const saved = await commitPdfRecords(
      session.source,
      next,
      previous.record_revision,
      previous.source_revision
    )
    if (!mounted.current) return false
    setSaving(false)
    if (saved === 'conflict') {
      rollback()
      notifyResult('conflict')
      const fresh = await loadPdfRecords(session.source)
      if (mounted.current) setSidecar(fresh)
    } else if (saved) {
      setSidecar(saved)
      if (options.statusCode) notifyResult(options.statusCode)
    } else {
      rollback()
      notifyResult('saveFailed')
    }
    return Boolean(saved && saved !== 'conflict')
  }

  const addMark = async (style: PdfMark['style'], color: PdfMarkColor, selected = selections): Promise<void> => {
    if (!sidecar || !selected.length || !session?.capabilities.can_annotate) return
    const added = selectionMarks(style, color, selected)
    await persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: [...sidecar.records.marks, ...added],
      comments: sidecar.records.comments,
      notes: sidecar.records.notes
    }, { clear: true, focus: added[0] })
  }

  const addAiComment = async (selection: PageSelection, body: string): Promise<boolean> => {
    if (!sidecar || !session?.capabilities.can_annotate || saving || !body.trim()) return false
    const mark = selectionMarks('highlight', DEFAULT_PDF_MARK_COLOR, [{
      page: selection.page,
      text: selection.text,
      quads: selection.quads
    }])[0]
    if (!mark) return false
    const comment: PdfComment = {
      id: crypto.randomUUID(),
      mark_id: mark.id,
      body: body.trim(),
      created_at: Date.now() / 1000
    }
    return persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: [...sidecar.records.marks, mark],
      comments: [...sidecar.records.comments, comment],
      notes: sidecar.records.notes
    }, { focus: mark })
  }

  const addComment = async (): Promise<void> => {
    if (!sidecar || !selections.length || !commentDraft.trim()) return
    const added = selectionMarks('highlight', DEFAULT_PDF_MARK_COLOR)
    const comments: PdfComment[] = added.map(mark => ({
      id: crypto.randomUUID(), mark_id: mark.id, body: commentDraft.trim(), created_at: Date.now() / 1000
    }))
    await persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: [...sidecar.records.marks, ...added],
      comments: [...sidecar.records.comments, ...comments],
      notes: sidecar.records.notes
    }, { clear: true, focus: added[0] })
  }

  const updateMark = async (markId: string, patch: Partial<Pick<PdfMark, 'color' | 'style'>>): Promise<void> => {
    if (!sidecar) return
    const current = sidecar.records.marks.find(mark => mark.id === markId)
    if (!current || (
      (patch.color === undefined || patch.color === current.color)
      && (patch.style === undefined || patch.style === current.style)
    )) return
    const updatedAt = Date.now() / 1000
    await persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: sidecar.records.marks.map(mark => mark.id === markId ? { ...mark, ...patch, updated_at: updatedAt } : mark),
      comments: sidecar.records.comments,
      notes: sidecar.records.notes
    }, { focus: { ...current, ...patch, updated_at: updatedAt } })
  }

  const applyMark = (style: PdfMark['style'], color: PdfMarkColor): void => {
    if (activeMark) void updateMark(activeMark, { style, color })
    else void addMark(style, color)
  }

  const addMarkComment = async (markId: string, body: string): Promise<boolean> => {
    if (!sidecar) return false
    const mark = sidecar.records.marks.find(candidate => candidate.id === markId)
    if (!mark) return false
    return persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: sidecar.records.marks,
      comments: [...sidecar.records.comments, { id: crypto.randomUUID(), mark_id: markId, body, created_at: Date.now() / 1000 }],
      notes: sidecar.records.notes
    }, { focus: mark })
  }

  const deleteMark = async (markId: string): Promise<void> => {
    if (!sidecar) return
    const notes = sidecar.records.notes
      .map(note => ({ ...note, excerpts: note.excerpts.filter(excerpt => excerpt.mark_id !== markId) }))
      .filter(note => note.excerpts.length > 0 || note.body.trim().length > 0)
    await persistRecords({
      schema_version: PDF_RECORD_SCHEMA_VERSION,
      marks: sidecar.records.marks.filter(mark => mark.id !== markId),
      comments: sidecar.records.comments.filter(comment => comment.mark_id !== markId),
      notes
    }, { statusCode: 'deleted' })
  }

  const selectionContribution = useMemo(() => ({
    actions: (
      <PdfTools colors={markColors} disabled={!sidecar || saving || !session?.capabilities.can_annotate} hasSelection={selections.length > 0} onApply={applyMark} onColor={(style, color) => setMarkColors(previous => ({ ...previous, [style]: color }))} onComment={() => setCommentFormOpen(value => !value)} commentOpen={commentFormOpen} onOpenChange={setHighlightOpen} />
    ),
    dismiss: () => { setHighlightOpen(false); setCommentFormOpen(false) },
    expanded: commentFormOpen,
    id: 'pdf-records',
    order: 1,
    ...(sidecar && session?.capabilities.can_annotate ? { annotateResult: async ({ selection, body }: { selection: SelectionAnchor; body: string }) => {
      if (
        selection.status !== 'exact'
        || selection.document_session_id !== sessionId
        || selection.revision !== session?.revision
      ) return { ok: false }
      if (selection.locator.kind !== 'pdf') return { ok: false }
      const saved = await addAiComment({
        page: selection.locator.page,
        text: selection.text,
        quads: selection.locator.quads
      }, body)
      return { ok: saved }
    } } : {}),
    panel: commentFormOpen ? (
      <div className="vds-selection-action-result">
        <Textarea
          autoFocus
          aria-label={t('annotationContent')}
          label={t('writeComment')}
          rows={3}
          value={commentDraft}
          onChange={event => setCommentDraft(event.target.value)}
        />
        <Button
          className="justify-self-end"
          size="sm"
          disabled={!commentDraft.trim() || saving}
          onClick={() => void addComment()}
        >
          {t('saveAnnotation')}
        </Button>
      </div>
    ) : null
  }), [activeMark, addAiComment, commentDraft, commentFormOpen, highlightOpen, markColors, saving, selections, session?.capabilities.can_annotate, session?.revision, sessionId, sidecar, t])
  const copyContribution = useMemo(() => ({
    actions: (
      <CopyButton
        value={selectedText}
        size="sm"
        variant="ghost"
        disabled={!selectedText}
        idleLabel={t('copySelection')}
        onClick={(event) => {
          const writer = window.scholarseed?.writeClipboard
          if (!writer) return
          event.preventDefault()
          void writer(selectedText).then(result => {
            notifyResult(result.ok ? 'copied' : 'copyFailed')
          })
        }}
      >
        <Icon name="copy" size={16} />{t('copy')}
      </CopyButton>
    ),
    expanded: false,
    id: 'pdf-copy',
    order: 100
  }), [selectedText, t])
  useSelectionActionContribution(tabId, selectionContribution)
  useSelectionActionContribution(tabId, copyContribution)

  const imported = (): void => {
    notifyResult('excerptSaved')
    setSelections([])
    controller.setSelection(tabId, null)
    window.getSelection()?.removeAllRanges()
    void onResourceImported?.()
  }

  const searchStep = (delta: number): void => {
    if (!hits.length) return
    const next = (hitIndex + delta + hits.length) % hits.length
    setHitIndex(next)
    navigate(hits[next].page)
    requestFocus({ kind: 'search', page: hits[next].page, ordinal: hits[next].ordinal })
  }
  const zoom = useCallback((value: number): void => update({ mode: 'custom', scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, value)) }), [update])
  useEffect(() => {
    const host = viewportRef.current
    if (!host) return
    const flushWheelZoom = (): void => {
      wheelZoomFrameRef.current = undefined
      const nextScale = wheelZoomScaleRef.current
      const event = wheelZoomEventRef.current
      wheelZoomScaleRef.current = undefined
      wheelZoomEventRef.current = undefined
      if (nextScale === undefined || !event) return
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.vds-pdf-page') : null
      const page = target ?? host.querySelector<HTMLElement>(`[data-testid="pdf-page-${currentPage}"]`)
      if (page) {
        const bounds = page.getBoundingClientRect()
        if (bounds.width > 0 && bounds.height > 0) {
          const clientX = Math.max(bounds.left, Math.min(bounds.right, event.clientX))
          const clientY = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY))
          zoomAnchorRef.current = {
            page: Number(page.dataset.page),
            x: (clientX - bounds.left) / bounds.width,
            y: (clientY - bounds.top) / bounds.height,
            clientX,
            clientY
          }
        }
      }
      scaleRef.current = nextScale
      zoom(nextScale)
    }
    const onWheel = (event: WheelEvent): void => {
      const nextScale = pdfWheelScale({
        scale: wheelZoomScaleRef.current ?? scaleRef.current,
        minScale: MIN_SCALE,
        maxScale: MAX_SCALE,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        viewportHeight: host.clientHeight,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey
      })
      if (nextScale === null) return
      event.preventDefault()
      if (nextScale === (wheelZoomScaleRef.current ?? scaleRef.current)) return
      wheelZoomScaleRef.current = nextScale
      wheelZoomEventRef.current = event
      if (wheelZoomFrameRef.current === undefined) wheelZoomFrameRef.current = window.requestAnimationFrame(flushWheelZoom)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      host.removeEventListener('wheel', onWheel)
      if (wheelZoomFrameRef.current !== undefined) window.cancelAnimationFrame(wheelZoomFrameRef.current)
      wheelZoomFrameRef.current = undefined
      wheelZoomScaleRef.current = undefined
      wheelZoomEventRef.current = undefined
    }
  }, [currentPage, zoom])
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (controller.getSnapshot().focusedTabId !== tabId) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const searchFocused = target === searchInputRef.current
      const editable = Boolean(target?.closest('input, textarea, [contenteditable="true"]'))
      const shortcut = resolveShortcut(event, ['pdf'])
      if (!shortcut || (editable && !searchFocused)) return
      if ((shortcut.id === 'pdf.findNext' || shortcut.id === 'pdf.findPrevious') && !searchFocused) return
      event.preventDefault()
      if (shortcut.id === 'pdf.find') {
        update({ sidebar: true, sidebarTab: 'search' })
        window.requestAnimationFrame(() => {
          searchInputRef.current?.focus()
          searchInputRef.current?.select()
        })
      } else if (shortcut.id === 'pdf.findNext') searchStep(1)
      else if (shortcut.id === 'pdf.findPrevious') searchStep(-1)
      else if (shortcut.id === 'pdf.previousPage') navigate(currentPage - 1)
      else if (shortcut.id === 'pdf.nextPage') navigate(currentPage + 1)
      else if (shortcut.id === 'pdf.firstPage') navigate(1)
      else if (shortcut.id === 'pdf.lastPage') navigate(pageCount)
      else if (shortcut.id === 'pdf.goToPage') {
        setGoToPageValue(String(currentPage))
        setGoToPageOpen(true)
      } else if (shortcut.id === 'pdf.zoomIn') zoom(scale + SCALE_STEP)
      else if (shortcut.id === 'pdf.zoomOut') zoom(scale - SCALE_STEP)
      else if (shortcut.id === 'pdf.actualSize') zoom(PDF_ACTUAL_SCALE)
      else if (shortcut.id === 'pdf.scrollUp') viewportRef.current?.scrollBy({ top: -PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollDown') viewportRef.current?.scrollBy({ top: PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollLeft') viewportRef.current?.scrollBy({ left: -PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollRight') viewportRef.current?.scrollBy({ left: PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollPageDown') viewportRef.current?.scrollBy({ top: (viewportRef.current?.clientHeight ?? 0) * PDF_PAGE_SCROLL_RATIO })
      else if (shortcut.id === 'pdf.scrollPageUp') viewportRef.current?.scrollBy({ top: -(viewportRef.current?.clientHeight ?? 0) * PDF_PAGE_SCROLL_RATIO })
      else if (shortcut.id === 'pdf.highlight') applyMark('highlight', markColors.highlight)
      else if (shortcut.id === 'pdf.comment' && (selections.length || activeMark)) setCommentFormOpen(true)
      else if (shortcut.id === 'pdf.copyText' && selectedText) {
        void window.scholarseed?.writeClipboard(selectedText).then(result => notifyResult(result.ok ? 'copied' : 'copyFailed'))
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [activeMark, controller, currentPage, hitIndex, hits, markColors.highlight, navigate, pageCount, scale, selectedText, selections.length, sidebar, sidebarTab, tabId, update, zoom])
  const onScroll = (): void => {
    const host = viewportRef.current
    if (!host) return
    if (selections.length && selectionDragSpan === null) window.getSelection()?.removeAllRanges()
    const elements = Array.from(host.querySelectorAll<HTMLElement>('.vds-pdf-page'))
    const page = mostVisiblePage(elements.map(element => {
      const { top, bottom } = element.getBoundingClientRect()
      return { page: Number(element.dataset.page), top, bottom }
    }), host.getBoundingClientRect())
    if (page && selectionDragSpan) setSelectionDragSpan(current => current && current.focus !== page ? { ...current, focus: page } : current)
    if (page && page !== readingRef.current?.page) update({ page })
    const workspace = controller.getSnapshot()
    const selectedSession = workspace.sessions[sessionId]
    if (
      !workspace.selectionPresentations[tabId]
      || selectedSession?.selection?.status !== 'exact'
      || selectedSession.selection.locator.kind !== 'pdf'
      || !selections.length
    ) return
    const viewport = persistedSelectionViewport(host, selections)
    if (viewport) controller.setSelection(tabId, selectedSession.selection, viewport)
  }
  const exportPdf = async (): Promise<void> => {
    if (!session || !sidecar || exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      const result = await exportAnnotatedPdf(
        session.bytes,
        sidecar,
        session.title.replace(/\.pdf$/i, '') + t('export.annotatedFilenameSuffix'),
        t('export.attachmentDescription')
      )
      if (result.ok) notifyResult('exported')
    } catch (error) {
      logPdfExportFailure(error)
      notifyResult(PDF_EXPORT_ERROR_CODE)
    } finally {
      exportingRef.current = false
      if (mounted.current) setExporting(false)
    }
  }
  const clearFigureSelection = useCallback((): void => {
    cropStart.current = undefined
    setCropBox(null)
  }, [])
  const anchoredMarks = sidecar?.records.marks.filter((mark) => mark.anchor_state === 'anchored') ?? []
  const analysis = usePdfAnalysis({ active, literatureId, attachmentId, title: session?.title ?? '', assetId: session?.source.kind === 'project' ? session.source.assetId ?? '' : '', path: session?.source.kind === 'project' ? session.source.path : '',
    projectId: session?.source.kind === 'project' ? session.source.project ?? '' : '', revision: session?.revision ?? '', tabId,
    page: currentPage, pageCount, selection: selections, canAnnotate: Boolean(sidecar && session?.capabilities.can_annotate), onAddComment: addAiComment, onNavigate: navigate,
    onLocate: (sourcePage, text) => { navigate(sourcePage); requestFocus({ kind: 'reading', page: sourcePage, text }) },
    onDocumentTranslationChange: setTranslationLayoutOpen,
    onExclusiveSurfaceOpen: () => {
      clearFigureSelection()
      closeDocumentPanel()
      update({ records: false })
    }
  })
  useEffect(() => {
    setVisualRegions([])
  }, [sessionId, session?.revision])
  useEffect(() => {
    if (!active || !session?.revision || pageCount < 1) return undefined
    const startPage = Math.max(1, currentPage - PDF_NEAR_PAGE_RADIUS)
    const endPage = Math.min(pageCount, currentPage + PDF_NEAR_PAGE_RADIUS)
    let cancelled = false
    void loadPdfVisualRegions({
      literatureId,
      attachmentId,
      path: session.source.kind === 'project' ? session.source.path : '',
      projectId: session.source.kind === 'project' ? session.source.project ?? '' : '',
      revision: session.revision,
    }, startPage, endPage).then(manifest => {
      if (cancelled || manifest.source_revision !== session.revision) return
      const incoming = manifest.pages.flatMap(item => item.regions)
      setVisualRegions(previous => [
        ...previous.filter(region => region.page < startPage || region.page > endPage),
        ...incoming,
      ])
    }).catch((error: unknown) => console.error(`[pdf-visual-regions] ${error instanceof Error ? error.message : String(error)}`))
    return () => { cancelled = true }
  }, [active, attachmentId, currentPage, literatureId, pageCount, session?.revision, session?.source])
  const copyVisualRegion = useCallback(async (region: PdfVisualRegion): Promise<void> => {
    if (!session) return
    if (region.kind === 'formula') {
      analysis.copyFormula(region)
      return
    }
    try {
      const image = await loadPdfVisualRegionImage({
        literatureId,
        attachmentId,
        path: session.source.kind === 'project' ? session.source.path : '',
        projectId: session.source.kind === 'project' ? session.source.project ?? '' : '',
        revision: session.revision,
      }, region)
      await writeClipboardImage(image)
      toast({ title: t('visualRegions.imageCopied'), tone: 'success' })
    } catch {
      toast({ title: t('visualRegions.copyFailed'), tone: 'error' })
    }
  }, [analysis.copyFormula, attachmentId, literatureId, session, t, toast])
  const exitFigureSelection = useCallback((): void => {
    clearFigureSelection()
    analysis.exitFigureSelection()
  }, [analysis.exitFigureSelection, clearFigureSelection])
  const activeDocumentPanelId = activeDocumentPanel?.id
  const rightPanelOpen = Boolean(analysis.sidePanel || recordsOpen || activeDocumentPanelId)
  useEffect(() => {
    if (!active) return
    set({
      pdfSidePanelOpen: rightPanelOpen,
      ...(rightPanelOpen ? { modulePanelOpen: false } : {})
    })
  }, [active, rightPanelOpen, set])
  useEffect(() => () => { if (active) set({ pdfSidePanelOpen: false }) }, [active, set])
  const encrypted = loadError?.kind === PDF_LOAD_FAILURE_KIND.encrypted
  const canOpenEncryptedExternally = Boolean(session && isLocatedDocumentSource(session.source))
  const openEncryptedExternally = async (): Promise<void> => {
    if (!session || !isLocatedDocumentSource(session.source)) return
    setExternalOpening(true)
    const resolved = await resolveDocumentLocation(session.source)
    const opened = resolved.ok && resolved.absolute
      ? await openSystemPath(resolved.absolute)
      : { ok: false }
    setExternalOpening(false)
    if (!opened.ok) toast({ title: t('encrypted.openFailed'), tone: 'error' })
  }

  useEffect(() => { if (analysis.figure) setActiveTool(null) }, [analysis.figure])
  useEffect(() => {
    if (!analysis.figure) return undefined
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      exitFigureSelection()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [analysis.figure, exitFigureSelection])

  const requestedPage = Number(goToPageValue)
  const canGoToPage = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= pageCount
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, index) => index + 1), [pageCount])
  const goToPage = (): void => {
    if (!canGoToPage) return
    navigate(requestedPage)
    setGoToPageOpen(false)
  }

  return <div ref={documentRef} className="vds-pdf-document" data-pdf-active={active} data-shortcut-scope="pdf" data-testid="pdf-document" data-ob="pdf-reader" data-ob-document={session?.documentId}>
    {encrypted ? <EncryptedPdfState
      canOpenExternally={canOpenEncryptedExternally}
      opening={externalOpening}
      onOpen={() => void openEncryptedExternally()}
    /> : <>
    {analysis.floating}
    {cropBox && <div aria-label={t('figureRegion')} style={cropBox} className="pointer-events-none fixed z-[var(--vds-z-popover)] border-2 border-[var(--vds-brand-default)]" />}
    <div className="vds-pdf-tools grid min-h-12 grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)] items-center gap-3 overflow-x-auto border-b border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-4)] py-1.5 text-[length:var(--vds-font-body-lv2)]" role="toolbar" aria-label={t('pdfToolbar.toolbar')}>
      <div className="flex items-center justify-self-start gap-[var(--vds-space-2)]">
        <IconButton label={t('pdfToolbar.directory')} icon={<Icon name="list" size={15} />} size="sm" variant="outline" data-testid="pdf-sidebar-toggle" aria-pressed={sidebar} onClick={() => update({ sidebar: !sidebar })} />
        {returnPosition ? <IconButton label={t('pdfToolbar.returnToSource')} icon={<Undo2 />} size="sm" variant="outline" data-testid="pdf-return-to-source" onClick={returnToLinkSource} /> : null}
        <IconButton label={t('pdfToolbar.zoomOut')} icon={<Icon name="minus" size={15} />} size="sm" variant="outline" data-testid="pdf-zoom-out" disabled={scale <= MIN_SCALE} onClick={() => zoom(scale - SCALE_STEP)} />
        <PdfScale editLabel={t('pdfToolbar.editScale')} fitPageLabel={t('pdfToolbar.fitPage')} fitWidthLabel={t('pdfToolbar.fitWidth')} mode={mode} scale={scale} onModeChange={(nextMode) => update({ mode: nextMode })} onScaleChange={(nextScale) => zoom(nextScale)} />
        <IconButton label={t('pdfToolbar.zoomIn')} icon={<Icon name="plus" size={15} />} size="sm" variant="outline" data-testid="pdf-zoom-in" disabled={scale >= MAX_SCALE} onClick={() => zoom(scale + SCALE_STEP)} />
        <IconButton label={t('pdfToolbar.previousPage')} icon={<span className="inline-flex rotate-180"><Icon name="chevron-right" size={15} /></span>} size="sm" variant="outline" data-testid="pdf-previous" disabled={currentPage <= 1 || !pageCount} onClick={() => navigate(currentPage - 1)} />
        <Input className="!w-12 text-center tabular-nums" size="sm" aria-label={t('pdfToolbar.pageNumber')} data-testid="pdf-page-input" type="text" inputMode="numeric" min={1} max={pageCount || 1} value={pageInput}
          onChange={event => setPageInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') navigate(pageNumber(pageInput, pageCount)) }} onBlur={() => navigate(pageNumber(pageInput, pageCount))} />
        <span className="whitespace-nowrap tabular-nums">/ {pageCount || '…'}</span>
        <IconButton label={t('pdfToolbar.nextPage')} icon={<Icon name="chevron-right" size={15} />} size="sm" variant="outline" data-testid="pdf-next" disabled={currentPage >= pageCount} onClick={() => navigate(currentPage + 1)} />
        <span className="ml-2 inline-flex border-l border-[var(--vds-border-default)] pl-2">
          <PdfTools colors={markColors} disabled={!sidecar || saving || !session?.capabilities.can_annotate} hasSelection={selections.length > 0} onApply={applyMark} onColor={(style, color) => setMarkColors(previous => ({ ...previous, [style]: color }))} onComment={() => setCommentFormOpen(value => !value)} commentOpen={commentFormOpen} activeTool={activeTool} onToggle={tool => { exitFigureSelection(); setActiveTool(previous => previous === tool ? null : tool) }} />
        </span>
      </div>
      <div className="flex items-center justify-self-end gap-[var(--vds-space-2)]">
        {analysis.toolbar}
        {excerptSource && session?.source.kind === 'project' && session.source.project ? (
          <LiteratureExcerptImport
            documentRevision={session.revision}
            onImported={imported}
            projectId={session.source.project}
            selections={excerptSelections}
            source={excerptSource}
          />
        ) : null}
        <IconButton label={exporting ? t('pdfToolbar.exporting') : t('pdfToolbar.export')} icon={<Icon name="upload" size={15} />} size="sm" variant="outline" data-testid="pdf-export" disabled={!sidecar || exporting} onClick={() => void exportPdf()} />
      </div>
      {citationPages && citationPages.length > 1 && <span aria-label={t('citationPages')} className="col-span-2 inline-flex items-center gap-1">
        <span>{t('citationLabel')}</span>{citationPages.map(target => <Button key={target.page} size="sm" variant="ghost" aria-label={t('viewCitation', { page: target.page })} aria-pressed={currentPage === target.page} onClick={() => { requestFocus({ kind: 'citation', page: target.page }) }}>{t('page', { page: target.page })}</Button>)}
      </span>}
      {citationTargets.length > 1 && <span aria-label={t('citationNavigation')} className="col-span-2 inline-flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={citationTargetIndex <= 0} onClick={() => { const target = citationTargets[citationTargetIndex - 1]; requestFocus({ kind: 'citation', ...target }) }}>{t('previousEvidence')}</Button>
        <span>{citationTargetIndex < 0 ? t('evidenceCount', { total: citationTargets.length }) : `${citationTargetIndex + 1} / ${citationTargets.length}`}</span>
        <Button size="sm" variant="ghost" disabled={citationTargetIndex === citationTargets.length - 1} onClick={() => { const target = citationTargets[citationTargetIndex + 1]; requestFocus({ kind: 'citation', ...target }) }}>{t('nextEvidence')}</Button>
      </span>}
    </div>
    {(loadError !== null || (sidecar && sidecar.source_state !== 'available')) && <div className="vds-pdf-status" role="status">{loadError?.kind === PDF_LOAD_FAILURE_KIND.unknown
      ? t('loadFailed', { detail: loadError.detail })
      : sidecar?.source_state === 'authorization_required'
        ? t('authorizationRequired')
        : sidecar && sidecar.source_state !== 'available'
          ? t('sourceUnavailable')
          : ''}</div>}
    <div className={`vds-pdf-reader relative${isLiterature || sidebar ? ' !flex' : ''}${sidebar ? ' has-sidebar' : ''}`}>
      {sidebar && <ResizablePanel
        className="pointer-events-none! absolute inset-y-0 left-0 z-[var(--vds-z-surface-panel)] [&>button]:pointer-events-auto! [&>div:first-child]:pointer-events-auto! [&>div:first-child]:overflow-hidden! [&>div:last-child]:pointer-events-none!"
        data-testid="pdf-navigation-resizable"
        leftPanel={<aside className="vds-pdf-sidebar box-border h-full w-full min-w-0 overflow-x-hidden! overflow-y-auto! bg-[var(--vds-bg-white-default)]! shadow-[var(--vds-shadow-2-right)]" aria-label={t('navigation')}>
        <Tabs className="h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden" value={sidebarTab} onValueChange={value => update({ sidebarTab: value })}>
          <TabsList className="[&_.vds-tabs__trigger]:whitespace-nowrap">
            <TabsTrigger value="outline">{t('outlineTab')}</TabsTrigger>
            <TabsTrigger value="pages">{t('pagesTab')}</TabsTrigger>
            <TabsTrigger value="search">{t('searchTab')}</TabsTrigger>
          </TabsList>
          <TabsContent value="outline" className="min-h-0 overflow-x-hidden overflow-y-auto">
            {!outline.length && <p className="vds-pdf-records-empty">{t('noOutline')}</p>}
            <PdfOutline items={outline} onNavigate={navigate} />
          </TabsContent>
          <TabsContent value="pages" className="min-h-0 overflow-x-hidden overflow-y-auto">
            <nav aria-label={t('thumbnails')}>{pageNumbers.map(number => <Button key={number} variant="ghost" size="content" data-testid={`pdf-thumbnail-${number}`} aria-label={t('goToPage', { page: number })} aria-current={currentPage === number ? 'page' : undefined} onClick={() => navigate(number)}>
              <span className="vds-pdf-thumbnail"><PdfPageSlot estimatedSize={estimatedPageSize} fonts={fonts} initialPage={loadedPages.get(number)} loadPage={loadPage} pageNumber={number} scale={THUMBNAIL_WIDTH / estimatedPageSize.width} thumbnail /><span>{number}</span></span>
            </Button>)}</nav>
          </TabsContent>
          <TabsContent value="search" className="min-h-0 overflow-hidden">
            <div role="search" className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] gap-2 pt-2">
              <Textarea className="w-full min-w-0 resize-none overflow-x-hidden" ref={searchInputRef} size="sm" aria-label={t('searchText')} placeholder={t('searchText')} data-testid="pdf-search" wrap="soft" value={query} onChange={event => update({ query: event.target.value })} onKeyDown={event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                searchStep(event.shiftKey ? -1 : 1)
              }} />
              <span role="status" className="text-xs text-[var(--text-3)]">{query.trim() ? searching ? t('searching') : searchError !== null ? t('searchFailed', { detail: searchError }) : (hits.length ? t('matchCount', { current: hitIndex + 1, total: hits.length }) : hasText ? t('noMatches') : t('noText')) : ''}</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" disabled={!hits.length} onClick={() => searchStep(-1)}>{t('previousMatch')}</Button>
                <Button size="sm" variant="ghost" data-testid="pdf-search-next" disabled={!hits.length} onClick={() => searchStep(1)}>{t('nextMatch')}</Button>
              </div>
              <nav aria-label={t('searchResults')} className="min-h-0 min-w-0 items-stretch! overflow-x-hidden overflow-y-auto">
                {hits.map((hit, index) => <Button key={`${hit.page}-${hit.ordinal}`} size="content" variant="ghost" className="w-full min-w-0 justify-start text-left whitespace-normal! [overflow-wrap:anywhere]" onClick={() => {
                  setHitIndex(index)
                  navigate(hit.page)
                  requestFocus({ kind: 'search', page: hit.page, ordinal: hit.ordinal })
                }}>{t('page', { page: hit.page })} · <span className="min-w-0 [overflow-wrap:anywhere]">{searchSnippet(hit.text, query)}</span></Button>)}
              </nav>
            </div>
          </TabsContent>
        </Tabs>
      </aside>}
        leftWidth={`${navigationWidth}px`}
        maxLeftWidth={PDF_NAVIGATION_MAX_WIDTH_PX}
        minLeftWidth={PDF_NAVIGATION_MIN_WIDTH_PX}
        rightPanel={<span aria-hidden />}
        onWidthChange={width => update({ navigationWidth: Number.parseFloat(width) })}
      />}
      <div ref={viewportRef} data-ob="pdf-viewport" className={`vds-pdf-pages flex-1${analysis.figure ? ' cursor-crosshair' : ''}`} style={{ marginLeft: sidebar ? `${navigationWidth}px` : undefined }} onScroll={onScroll} onMouseUp={() => { if (!analysis.figure) { captureSelection(true); setSelectionDragSpan(null) } }} onKeyUp={() => captureSelection()}
        onPointerDownCapture={event => {
          const element = (event.target as HTMLElement).closest<HTMLElement>('.vds-pdf-page')
          if (!analysis.figure) {
            const page = element ? Number(element.dataset.page) : null
            setSelectionDragSpan(page ? { anchor: page, focus: page } : null)
            return
          }
          if (!element) return
          event.preventDefault(); event.stopPropagation()
          analysis.setFigureGuideOpen(false)
          cropStart.current = { x: event.clientX, y: event.clientY, bounds: element.getBoundingClientRect(), page: Number(element.dataset.page) }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          if (!analysis.figure) {
            const element = (event.target as HTMLElement).closest<HTMLElement>('.vds-pdf-page')
            const page = element ? Number(element.dataset.page) : null
            if (page) setSelectionDragSpan(current => current && current.focus !== page ? { ...current, focus: page } : current)
            return
          }
          const start = cropStart.current
          if (!start) return
          const x = Math.max(start.bounds.left, Math.min(start.bounds.right, event.clientX)), y = Math.max(start.bounds.top, Math.min(start.bounds.bottom, event.clientY))
          setCropBox({ left: Math.min(x, start.x), top: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) })
        }}
        onPointerUp={event => {
          const start = cropStart.current
          if (!start) return
          event.preventDefault(); cropStart.current = undefined
          if (cropBox && cropBox.width >= MIN_FIGURE_SELECTION_PX && cropBox.height >= MIN_FIGURE_SELECTION_PX) analysis.selectFigure(start.page, [(cropBox.left - start.bounds.left) / start.bounds.width, (cropBox.top - start.bounds.top) / start.bounds.height, cropBox.width / start.bounds.width, cropBox.height / start.bounds.height])
          setCropBox(null)
        }} onPointerCancel={() => setSelectionDragSpan(null)}>
        <div data-testid="pdf-pages-track" className={`box-border min-h-full${rightPanelOpen ? ' min-w-[calc(100%+var(--vds-layout-pdf-panel-width))] pr-[var(--vds-layout-pdf-panel-width)]' : ' min-w-full'}`}>
          {!pageCount && loadError === null && <div className="vds-pdf-loading">{t('loading')}</div>}
          {pageNumbers.map(number => {
            const sourcePage = <PdfPageSlot
              estimatedSize={estimatedPageSize}
              fonts={fonts}
              initialPage={loadedPages.get(number)}
              key={number}
              loadPage={loadPage}
              pageNumber={number}
              scale={scale}
              keepRendered={selectionDragSpan !== null && pageInSelectionSpan(number, selectionDragSpan.anchor, selectionDragSpan.focus)}
              search={query}
              focus={focus?.page === number ? focus : undefined}
              annotations={anchoredMarks.filter(mark => mark.page === number)}
              selectionQuads={workspace.selectionPresentations[tabId] && session?.selection?.locator.kind === 'pdf'
                ? selections.find(selection => selection.page === number)?.quads
                : undefined}
              citationQuads={citationPages?.find(item => item.page === number)?.quads}
              visualRegions={visualRegions.filter(region => region.page === number)}
              visualRegionImageInputAvailable={analysis.visualRegionImageInputAvailable}
              copyingVisualRegionId={analysis.copyingFormulaRegionId}
              commentMarkIds={sidecar?.records.comments.map(comment => comment.mark_id)}
              onAnnotationOpen={(mark) => {
                setSelections([{ page: mark.page, text: mark.text, quads: mark.quads }])
                setActiveMark(mark.id)
                setMarkColors(previous => ({ ...previous, [mark.style]: mark.color }))
              }}
              onInternalLink={navigateInternalLink}
              onVisualRegionExplain={analysis.explainRegion}
              onVisualRegionCopy={region => { void copyVisualRegion(region) }}
              renderAnnotation={(mark, close) => <PdfAnnotation
                analyzing={analysis.selectionAnalyzing}
                canAnalyze={analysis.canAnalyzeSelection}
                comments={sidecar?.records.comments.filter(comment => comment.mark_id === mark.id) ?? []}
                mark={mark}
                saving={saving}
                onColorChange={(color) => { void updateMark(mark.id, { color }) }}
                onComment={(body) => addMarkComment(mark.id, body)}
                onDelete={() => { void deleteMark(mark.id) }}
                onExplain={(instruction) => { analysis.explainSelection({ page: mark.page, text: mark.text, quads: mark.quads }, instruction); close(); setActiveMark(null) }}
                onStyleChange={(style) => { void updateMark(mark.id, { style }) }}
                onTranslate={() => { analysis.translateSelection({ page: mark.page, text: mark.text, quads: mark.quads }); close(); setActiveMark(null) }}
              />}
            />
            return analysis.translationOpen ? <div
              className="mx-auto mb-4 grid w-max items-start gap-[var(--vds-space-4)] [&>.vds-pdf-page]:m-0"
              data-page-pair={number}
              data-testid={`pdf-page-pair-${number}`}
              key={number}
              style={{ gridTemplateColumns: `${estimatedPageSize.width * scale}px ${estimatedPageSize.width * scale}px` }}
            >
              {sourcePage}
              {analysis.translationPage(number, estimatedPageSize, scale)}
            </div> : sourcePage
          })}
        </div>
      </div>
      {analysis.sidePanel}
      {recordsOpen && !analysis.panel && <PdfAnnotations comments={sidecar?.records.comments ?? []} marks={anchoredMarks} saving={saving} expanded={expandedPanel === PDF_RECORDS_PANEL_ID} onToggleExpanded={() => setExpandedPanel(value => value === PDF_RECORDS_PANEL_ID ? null : PDF_RECORDS_PANEL_ID)} onClose={() => { setExpandedPanel(null); update({ records: false }) }} onDelete={(markId) => { void deleteMark(markId) }} onFocus={(mark) => { navigate(mark.page); requestFocus({ kind: 'annotation', page: mark.page, id: mark.id }) }} />}
      {activeDocumentPanel && !analysis.panel && !recordsOpen && documentPanels ? <PdfPanel
        ariaLabel={activeDocumentPanel.label(i18n)}
        closeLabel={t('reading.close')}
        expanded={expandedPanel === activeDocumentPanel.id}
        icon={<NotepadText size={16} />}
        testId={`document-panel-${activeDocumentPanel.id}`}
        title={activeDocumentPanel.title}
        onClose={() => { setExpandedPanel(null); documentPanels.toggle(activeDocumentPanel.id) }}
        onToggleExpanded={() => setExpandedPanel(value => value === activeDocumentPanel.id ? null : activeDocumentPanel.id)}
      >
        {activeDocumentPanel.render(documentPanels.context)}
      </PdfPanel> : null}
      {isLiterature && <nav aria-label={t('pdfToolbar.toolbar')} data-ob="pdf-tools" className="flex w-[var(--vds-layout-pdf-rail-width)] flex-none flex-col items-center gap-2 border-l border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-1)] py-3">
        {analysis.railActions}
        {documentPanels?.panels.map((panel) => {
          const label = panel.label(i18n)
          return <Tooltip key={panel.id} portalled content={label} side="left">
            <IconButton
              aria-pressed={documentPanels.activePanelId === panel.id}
              data-testid={`document-panel-toggle-${panel.id}`}
              label={label}
              title={undefined}
              icon={<NotepadText size={18} />}
              variant={documentPanels.activePanelId === panel.id ? 'secondary' : 'ghost'}
              onClick={() => {
                exitFigureSelection()
                analysis.setPanel(null)
                update({ records: false })
                setExpandedPanel(null)
                documentPanels.toggle(panel.id)
              }}
            />
          </Tooltip>
        })}
        <Tooltip portalled content={t('pdfAnnotation.records')} side="left"><IconButton data-testid="pdf-annotation-toggle" variant={recordsOpen ? 'secondary' : 'ghost'} aria-pressed={recordsOpen} label={t('pdfAnnotation.records')} title={undefined} icon={<Icon name="pen" size={18} />} onClick={() => { exitFigureSelection(); closeDocumentPanel(); analysis.setPanel(null); update({ records: !recordsOpen }) }} /></Tooltip>
      </nav>}
    </div>
    </>}
    <Dialog open={goToPageOpen} onOpenChange={setGoToPageOpen}>
      <DialogContent data-testid="pdf-go-to-page-dialog">
        <DialogHeader>
          <DialogTitle>{t('goToPageDialog.title')}</DialogTitle>
          <DialogDescription>{t('goToPageDialog.description', { count: pageCount })}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          data-testid="pdf-go-to-page-input"
          inputMode="numeric"
          min={1}
          max={pageCount}
          type="number"
          value={goToPageValue}
          onChange={(event) => setGoToPageValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && canGoToPage) goToPage() }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setGoToPageOpen(false)}>{t('goToPageDialog.cancel')}</Button>
          <Button disabled={!canGoToPage} onClick={goToPage}>{t('goToPageDialog.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}
