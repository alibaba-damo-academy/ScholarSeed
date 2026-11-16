import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  FileLock2,
  NotebookPen,
  SquareChartGantt,
  NotepadText,
  SlidersHorizontal,
  Undo2,
} from 'lucide-react'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

import { openSystemPath } from '../../api'
import { writeClipboardImage } from '../../components/primitive/clipboard'
import { useApp } from '../../store'
import { useTranslationBackend } from '../translation/context'
import { TranslationPreferenceStatus } from '../translation/Preferences'
import { useTranslationText } from '../translation/text'
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
  Divider,
  EllipsisText,
  EmptyState,
  FloatingToolbar,
  IconButton,
  Input,
  ResizablePanel,
  ResizablePanelGroup,
  ResizableHandle,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toggle,
  Tooltip,
  useToast,
  type ToastTone,
} from '../../components/ui'
import { CITATION_VIEW_STATE_KEY, type CitationFocus } from '../../contracts/citations'
import type { DocumentPanelContext, DocumentPanelContribution } from '../../contracts/features'
import {
  ANNOTATION_VIEW_STATE_KEY,
  type AnnotationFocus,
  type PdfTextMarkRecord,
  type PdfTextMarkStyle,
  type SelectionAnchor,
} from '../../contracts/workbench'
import { useAssistantIngress } from '../assistant/ingress'
import { addPdfCommentContext } from './context'
import {
  asLiteratureExcerptSource,
  LITERATURE_EXCERPT_VIEW_STATE_KEY,
  PDF_EXCERPT_LOCATOR_KIND,
  type LiteratureExcerptSelection,
  type PdfExcerptQuad,
} from '../../contracts/resources'
import { Icon } from '../../icons'
import { resolveShortcut } from '../../shortcuts'
import { dismissSelectionActions, useSelectionActionContribution } from './actions'
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
  type PdfRecords,
} from './api'
import { useWorkspaceController, selectionViewport, useDocumentWorkspace } from './workspace'
import { documentSelectionReveal } from './workspace'
import {
  PDF_COMMENT_TOOL,
  PDF_COPY_FEEDBACK_DURATION_MS,
  PdfTools,
  type PdfTool,
} from './pdf/Tools'
import { PdfAnnotations } from './pdf/Annotations'
import { PdfUndoHistory } from './pdf/history'
import { PdfPageSlot, type PdfFocus, type PdfFocusTarget } from './pdf/Page'
import { pdfPlainText } from './pdf/utils'
import { PdfAnnotation, PdfCommentDraft } from './pdf/Annotation'
import { documentSelectionInteractionProps } from './focus'
import { selectionSurfaceBoundary, type SelectionBounds } from './placement'
import { PdfCommentInput, type PdfCommentEdit } from './pdf/Comment'
import {
  exportAnnotatedPdf,
  restoreAnnotatedPdf,
  PDF_EXPORT_ERROR_CODE,
  PdfExportError,
} from './pdf/export'
import {
  citationRegions,
  clipQuads,
  normalizeHighlightQuads,
  normalizeQuads,
  selectionRectangles,
  enclosingRectangle,
  fittedScale,
  matchText,
  MAX_SCALE,
  MIN_SCALE,
  mostVisiblePage,
  PAGE_GUTTER,
  PDF_WIDE_TRANSLATION_GUTTER,
  PDF_WIDE_TRANSLATION_MIN_WIDTH,
  PDF_TRANSLATION_MAX_RATIO,
  PDF_TRANSLATION_MIN_RATIO,
  PDF_TRANSLATION_WIDTH_STATE_KEY,
  pageInSelectionSpan,
  pageNumber,
  SCALE_STEP,
  resizePdfTranslation,
  selectionPageText,
  THUMBNAIL_WIDTH,
  THUMBNAIL_HEIGHT,
  translationSpreadSize,
  translationWidthRatio,
  type PdfTranslationResize,
  type PdfFitMode,
  type Size,
} from './pdf/geometry'
import {
  outlineTree,
  resolveDestination,
  type PdfDestination,
  type PdfDestinationResolver,
  type PdfOutlineItem,
} from './pdf/navigation'
import { PdfOutline } from './pdf/Outline'
import { PdfPanel } from './pdf/Panel'
import {
  DEFAULT_PDF_MARK_COLOR,
  createPointMark,
  PDF_RECORD_SCHEMA_VERSION,
  stagePdfRecords,
  type PdfMarkColor,
} from './pdf/records'
import './pdf/pdf.css'
import { PdfBinaryDataFactory } from './pdf/assets'
import { PdfFonts } from './pdf/fonts'
import { PdfLifecycle } from './pdf/lifecycle'
import { classifyPdfLoadFailure, PDF_LOAD_FAILURE_KIND, type PdfLoadFailure } from './pdf/loading'
import { usePdfAnalysis } from './pdf/Reading'
import { loadPdfVisualRegionImage, pdfCitationSource, type PdfVisualRegion } from './pdf/analysis'
import { PdfScale } from './pdf/Scale'
import { pdfWheelScale } from './pdf/zoom'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl
const SEARCH_BATCH_SIZE = 8
const SEARCH_DELAY_MS = 180
const MIN_FIGURE_SELECTION_PX = 8
const PDF_NAVIGATION_DEFAULT_WIDTH_PX = 260
const PDF_NAVIGATION_MIN_WIDTH_PX = 190
const PDF_NAVIGATION_MAX_WIDTH_PX = 360
const PDF_ACTUAL_SCALE = 1
const PDF_SCROLL_STEP_PX = 64
const PDF_PAGE_SCROLL_RATIO = 0.9
const PDF_DEFAULT_PAGE_SIZE: Size = { width: 612, height: 792 }
const PDF_NEAR_PAGE_RADIUS = 1
const READING_SPLIT_SIZES = [55, 45]
const READING_SPLIT_MINIMUM = 30
const PERCENTAGE_TOTAL = 100

function logPdfExportFailure(error: unknown): void {
  const cause =
    error instanceof PdfExportError && error.original instanceof Error ? error.original : null
  console.error(
    `[pdf-export] ${JSON.stringify({
      stage: error instanceof PdfExportError ? error.stage : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      cause: cause ? { message: cause.message, stack: cause.stack } : undefined,
    })}`
  )
}

const DEFAULT_FIT_MODE: PdfFitMode = 'width'
interface SearchHit {
  page: number
  text: string
  ordinal: number
}
interface PageSelection {
  page: number
  text: string
  quads: number[][]
}
interface SelectionDragSpan {
  anchor: number
  focus: number
}
interface PdfZoomAnchor {
  page: number
  x: number
  y: number
  clientX: number
  clientY: number
}

function searchSnippet(text: string, query: string): React.ReactNode {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return text
  const matchIndex = text.toLocaleLowerCase().indexOf(normalizedQuery.toLocaleLowerCase())
  if (matchIndex < 0) return text
  const matchEnd = matchIndex + normalizedQuery.length
  return (
    <>
      {text.slice(0, matchIndex)}
      <mark className="rounded-[var(--vds-radius-2)] bg-[var(--vds-brand-bg-light)] px-[var(--vds-space-half)] text-inherit">
        {text.slice(matchIndex, matchEnd)}
      </mark>
      {text.slice(matchEnd)}
    </>
  )
}

function EncryptedPdfState({
  canOpenExternally,
  opening,
  onOpen,
}: {
  canOpenExternally: boolean
  opening: boolean
  onOpen: () => void
}): React.JSX.Element {
  const { t } = useTranslation('pdf')
  return (
    <div className="grid flex-1 place-items-center" data-testid="encrypted-pdf-state">
      <EmptyState
        description={t('encrypted.description')}
        icon={<FileLock2 />}
        title={t('encrypted.title')}
        action={
          canOpenExternally ? (
            <Button
              data-testid="encrypted-pdf-open-external"
              disabled={opening}
              icon={<ExternalLink />}
              loading={opening}
              onClick={onOpen}
            >
              {opening ? t('encrypted.opening') : t('encrypted.openExternal')}
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}

function pdfSelectionBoundary(host: HTMLElement): SelectionBounds {
  const bounds = host.getBoundingClientRect()
  const margin = parseFloat(getComputedStyle(host).getPropertyValue('--vds-pdf-selection-margin'))
  return selectionSurfaceBoundary(
    {
      left: Math.max(0, bounds.left),
      right: Math.min(window.innerWidth, bounds.right),
      top: Math.max(0, bounds.top),
      bottom: Math.min(window.innerHeight, bounds.bottom),
    },
    margin
  )
}

function persistedSelectionViewport(
  host: HTMLElement,
  selections: readonly PageSelection[]
): ReturnType<typeof selectionViewport> | null {
  const selection = selections.at(-1)
  if (!selection) return null
  const page = Array.from(host.querySelectorAll<HTMLElement>('.vds-pdf-page')).find(
    (element) => Number(element.dataset.page) === selection.page
  )
  if (!page) return null
  const pageBounds = page.getBoundingClientRect()
  const rects = selection.quads.map((quad) => ({
    left: pageBounds.left + quad[0] * pageBounds.width,
    top: pageBounds.top + quad[1] * pageBounds.height,
    right: pageBounds.left + quad[2] * pageBounds.width,
    bottom: pageBounds.top + quad[3] * pageBounds.height,
  }))
  const bounds = enclosingRectangle(rects)
  const last = rects.at(-1)
  if (!bounds || !last) return null
  const point = { x: last.right, y: last.bottom }
  const boundary = pdfSelectionBoundary(host)
  const visible = boundary.right > boundary.left && boundary.bottom > boundary.top
  return {
    ...selectionViewport(
      { ...bounds, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top },
      point,
      visible
    ),
    boundary,
  }
}

function toExcerptSelections(selections: readonly PageSelection[]): LiteratureExcerptSelection[] {
  return selections.map((selection) => ({
    text: selection.text,
    locator: {
      kind: PDF_EXCERPT_LOCATOR_KIND,
      page: selection.page,
      quads: selection.quads.map((quad): PdfExcerptQuad => [quad[0], quad[1], quad[2], quad[3]]),
    },
  }))
}

export function PdfDocument({
  active,
  documentPanels,
  sessionId,
  tabId,
  onResourceImported,
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
  const { set, state: appState, act: appActions } = useApp()
  const [readingSplit, setReadingSplit] = useState(READING_SPLIT_SIZES)
  const [readingPanelMinimum, setReadingPanelMinimum] = useState(READING_SPLIT_MINIMUM)
  const readingGroupRef = useRef<HTMLDivElement>(null)
  const readingResized = useRef(false)
  const { backend: translationBackend, settings: translationSettings } = useTranslationBackend()
  const selectionToolbarEnabled = translationBackend
    ? translationSettings?.toolbar !== false
    : appState.pdfSelectionToolbarEnabled
  const selectionToolbarDisabled = Boolean(
    translationBackend &&
    (translationSettings?.preferencesReady === false || translationSettings?.preferencesSaving)
  )
  const setSelectionToolbarEnabled = useCallback(
    (toolbar: boolean): void => {
      if (translationBackend) {
        if (!selectionToolbarDisabled) void translationBackend.update({ toolbar })
      } else appActions.setPdfSelectionToolbarEnabled(toolbar)
    },
    [translationBackend, selectionToolbarDisabled, appActions]
  )
  const translationText = useTranslationText()
  const controller = useWorkspaceController()
  const workspace = useDocumentWorkspace()
  const session = workspace.sessions[sessionId]
  const tab = workspace.tabs[tabId]
  const reading = tab?.viewState
  const translationRatio = translationWidthRatio(reading?.[PDF_TRANSLATION_WIDTH_STATE_KEY])
  const translationResize = useRef<PdfTranslationResize | null>(null)
  const isLiterature = session?.source.kind === 'literature'
  const literatureId = session?.source.kind === 'literature' ? session.source.literatureId : ''
  const attachmentId = session?.source.kind === 'literature' ? session.source.attachmentId : ''
  const citation = reading?.[CITATION_VIEW_STATE_KEY] as CitationFocus | undefined
  const annotationFocus = reading?.[ANNOTATION_VIEW_STATE_KEY] as AnnotationFocus | undefined
  const selectionReveal = documentSelectionReveal(tab)
  const selectionTarget =
    selectionReveal?.locator.kind === 'pdf' ? selectionReveal.locator : undefined
  const citationPages = selectionTarget
    ? [{ page: selectionTarget.page, quads: selectionTarget.quads }]
    : citation?.revision === session?.revision
      ? citation.pages
      : undefined
  const citationTargets =
    citationPages?.flatMap((target) =>
      citationRegions(target.quads).map((_, region) => ({ page: target.page, region }))
    ) ?? []
  const excerptSource = asLiteratureExcerptSource(reading?.[LITERATURE_EXCERPT_VIEW_STATE_KEY])
  const currentPage = typeof reading?.page === 'number' ? reading.page : 1
  const storedScale = typeof reading?.scale === 'number' ? reading.scale : 1
  const mode: PdfFitMode =
    reading?.mode === 'page' || reading?.mode === 'width' || reading?.mode === 'custom'
      ? reading.mode
      : DEFAULT_FIT_MODE
  const sidebar = reading?.sidebar === true
  const navigationWidth =
    typeof reading?.navigationWidth === 'number' && Number.isFinite(reading.navigationWidth)
      ? Math.min(
          Math.max(reading.navigationWidth, PDF_NAVIGATION_MIN_WIDTH_PX),
          PDF_NAVIGATION_MAX_WIDTH_PX
        )
      : PDF_NAVIGATION_DEFAULT_WIDTH_PX
  const [expandedPanel, setExpandedPanel] = useState<string | null>(null)
  const [documentPanelHeaderHost, setDocumentPanelHeaderHost] = useState<HTMLDivElement | null>(
    null
  )
  const query = typeof reading?.query === 'string' ? reading.query : ''
  const sidebarTab =
    reading?.sidebarTab === 'pages' ||
    reading?.sidebarTab === 'search' ||
    reading?.sidebarTab === 'annotations'
      ? reading.sidebarTab
      : 'outline'
  const [pageCount, setPageCount] = useState(0)
  const [documentText, setDocumentText] = useState('')
  const [loadedPages, setLoadedPages] = useState<Map<number, PDFPageProxy>>(() => new Map())
  const [commentRails, setCommentRails] = useState<Map<PDFPageProxy, number>>(() => new Map())
  const handleCommentRail = useCallback((page: PDFPageProxy, width: number): void => {
    setCommentRails((current) => {
      if ((current.get(page) ?? 0) === width) return current
      const next = new Map(current)
      if (width) next.set(page, width)
      else next.delete(page)
      return next
    })
  }, [])
  const [estimatedPageSize, setEstimatedPageSize] = useState<Size>(PDF_DEFAULT_PAGE_SIZE)
  const [translationLayoutOpen, setTranslationLayoutOpen] = useState(false)
  const [selectionDragSpan, setSelectionDragSpan] = useState<SelectionDragSpan | null>(null)
  const cropStart = useRef<{ x: number; y: number; bounds: DOMRect; page: number } | undefined>(
    undefined
  )
  const [cropBox, setCropBox] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [fonts, setFonts] = useState(() => new PdfFonts())
  const [lifecycle] = useState(
    () =>
      new PdfLifecycle<Uint8Array, PDFDocumentProxy, PDFPageProxy>({
        createTask: (bytes) =>
          getDocument({
            data: new Uint8Array(bytes),
            BinaryDataFactory: PdfBinaryDataFactory,
            useWorkerFetch: false,
            fontExtraProperties: true,
          }),
        restore: restoreAnnotatedPdf,
      })
  )
  const [outline, setOutline] = useState<PdfOutlineItem[]>([])
  const [sidecar, setSidecar] = useState<PdfRecordSnapshot | null>(null)
  const nativeSourcesKey = JSON.stringify(
    sidecar?.source_revision === session?.revision ? sidecar?.records.native_annotations : undefined
  )
  const undoHistory = useMemo(() => new PdfUndoHistory(), [session?.documentId, session?.revision])
  const currentUndoHistory = useRef(undoHistory)
  currentUndoHistory.current = undoHistory
  const recordSaving = useMemo(() => ({ current: false }), [undoHistory])
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
  const [size, setSize] = useState<Size & { outerWidth: number }>({
    width: 0,
    height: 0,
    outerWidth: 0,
  })
  const [pageInput, setPageInput] = useState(String(currentPage))
  const [goToPageOpen, setGoToPageOpen] = useState(false)
  const [goToPageValue, setGoToPageValue] = useState(String(currentPage))
  const [selections, setSelections] = useState<PageSelection[]>([])
  const excerptSelections = useMemo(() => toExcerptSelections(selections), [selections])
  const [highlightOpen, setHighlightOpen] = useState(false)
  const [activeTool, setActiveTool] = useState<PdfTool | null>(null)
  const [activeMark, setActiveMark] = useState<string | null>(null)
  const ingress = useAssistantIngress()
  const [markColors, setMarkColors] = useState<Record<PdfTextMarkStyle, PdfMarkColor>>({
    highlight: DEFAULT_PDF_MARK_COLOR,
    underline: DEFAULT_PDF_MARK_COLOR,
    strikethrough: DEFAULT_PDF_MARK_COLOR,
  })
  const [selectionColor, setSelectionColor] = useState<PdfMarkColor>(DEFAULT_PDF_MARK_COLOR)
  const [commentFormOpen, setCommentFormOpen] = useState(false)
  const toggleSelectionComment = useCallback(() => {
    const open = !commentFormOpen
    dismissSelectionActions(tabId)
    setCommentFormOpen(open)
  }, [commentFormOpen, tabId])
  const [commentDraft, setCommentDraft] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => setSaving(false), [undoHistory])
  const [exporting, setExporting] = useState(false)
  const exportingRef = useRef(false)
  const [focus, setFocus] = useState<PdfFocus>()
  const destinationResolver = useRef<PdfDestinationResolver | undefined>(undefined)
  const [returnPosition, setReturnPosition] = useState<{
    page: number
    top: number
    left: number
  } | null>(null)
  const citationTargetIndex =
    focus?.kind === 'citation' && focus.region !== undefined
      ? citationTargets.findIndex(
          (target) => target.page === focus.page && target.region === focus.region
        )
      : -1
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
  const restoredViewportRef = useRef<HTMLDivElement | null>(null)
  const constrainedNavigationRef = useRef<{
    viewport: HTMLDivElement
    top: number
    anchor: Pick<PdfZoomAnchor, 'page' | 'y' | 'clientY'>
  } | null>(null)
  const citationNavigationRef = useRef<HTMLDivElement>(null)
  const [citationNavigationHeight, setCitationNavigationHeight] = useState(0)
  const documentRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLTextAreaElement>(null)
  const zoomAnchorRef = useRef<PdfZoomAnchor | undefined>(undefined)
  const navigationAnchorRef = useRef<Pick<PdfZoomAnchor, 'page' | 'y' | 'clientY'> | undefined>(
    undefined
  )
  const wheelZoomFrameRef = useRef<number | undefined>(undefined)
  const wheelZoomScaleRef = useRef<number | undefined>(undefined)
  const wheelZoomEventRef = useRef<WheelEvent | undefined>(undefined)
  const textCache = useRef(new Map<number, string>())
  const readingRef = useRef(reading)
  readingRef.current = reading
  const mounted = useRef(true)
  const activeDocumentPanel =
    documentPanels?.panels.find((panel) => panel.id === documentPanels.activePanelId) ?? null
  const closeDocumentPanel = (): void => {
    setExpandedPanel(null)
    if (documentPanels?.activePanelId) {
      documentPanels.toggle(documentPanels.activePanelId)
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const update = useCallback(
    (patch: Record<string, unknown>): void => {
      controller.setTabViewState(tabId, { ...readingRef.current, ...patch })
    },
    [tabId]
  )
  useEffect(() => {
    if (isLiterature && reading?.records === true)
      update({ records: false, sidebar: true, sidebarTab: 'annotations' })
  }, [isLiterature, reading?.records, update])
  const handleDocumentTranslationChange = useCallback(
    (open: boolean): void => {
      setTranslationLayoutOpen(open)
      if (open) set({ modulePanelOpen: false })
    },
    [set]
  )

  useEffect(() => {
    setPageCount(0)
    setDocumentText('')
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
    void lifecycle
      .open(session.bytes, currentPage, nativeSourcesKey ? JSON.parse(nativeSourcesKey) : undefined)
      .then(async (opened) => {
        if (!opened || !running) return
        const pdf = opened.document
        const firstPage = await lifecycle.getPage(1)
        if (!firstPage || !running) return
        const text = pdfPlainText(await firstPage.getTextContent())
        if (!running) return
        textCache.current.set(1, text)
        setDocumentText(text)
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
          void lifecycle.getPage(pageNumber).then((page) => {
            if (!running || !page) return
            setLoadedPages((current) => new Map(current).set(pageNumber, page))
          })
        }
        destinationResolver.current = {
          namedDestination: (name) => pdf.getDestination(name),
          pageIndex: (reference) =>
            pdf.getPageIndex(reference as Parameters<typeof pdf.getPageIndex>[0]),
          pageViewport: async (targetPage) =>
            (await pdf.getPage(targetPage)).getViewport({ scale: 1 }),
        }
        void pdf
          .getOutline()
          .then((rawOutline) =>
            outlineTree(rawOutline, {
              namedDestination: (name) => pdf.getDestination(name),
              pageIndex: (reference) =>
                pdf.getPageIndex(reference as Parameters<typeof pdf.getPageIndex>[0]),
            })
          )
          .then((resolvedOutline) => {
            if (running) setOutline(resolvedOutline)
          })
          .catch(() => {
            if (running) setOutline([])
          })
      })
      .catch((error: unknown) => {
        if (running) setLoadError(classifyPdfLoadFailure(error))
      })
    return () => {
      running = false
      destinationResolver.current = undefined
      fontOwner.dispose()
      void lifecycle.suspend()
    }
  }, [active, lifecycle, session?.revision, sessionId, nativeSourcesKey])

  const loadPage = useCallback(
    async (pageNumber: number): Promise<PDFPageProxy | null> => {
      const page = await lifecycle.getPage(pageNumber)
      if (page) {
        setLoadedPages((current) =>
          current.get(pageNumber) === page ? current : new Map(current).set(pageNumber, page)
        )
      }
      return page
    },
    [lifecycle]
  )

  useEffect(() => {
    if (!active || !session) return
    setSidecar(null)
    if (!recordTargetFor(session.source)) return
    let running = true
    let failed = false
    const unsubscribe = subscribePdfRecords(
      session.source,
      (snapshot) => {
        if (running) {
          failed = false
          setSidecar(snapshot)
        }
      },
      () => {
        if (!running || failed) return
        failed = true
        notifyResult('readFailed')
      }
    )
    return () => {
      running = false
      unsubscribe()
    }
  }, [active, session?.documentId, session?.revision])

  useLayoutEffect(() => {
    const host = viewportRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return
      setSize({
        width: host.clientWidth,
        height: host.clientHeight,
        outerWidth: host.offsetWidth,
      })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const navigation = citationNavigationRef.current
    if (!navigation) {
      setCitationNavigationHeight(0)
      return
    }
    const measure = (): void =>
      setCitationNavigationHeight(navigation.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(navigation)
    measure()
    return () => observer.disconnect()
  }, [citationTargets.length])

  const activePage = loadedPages.get(pageNumber(currentPage, pageCount))
  const natural = activePage?.getViewport({ scale: 1 })
  const translationSourceWidth = useMemo(() => {
    let width = estimatedPageSize.width
    for (const page of loadedPages.values())
      width = Math.max(width, page.getViewport({ scale: 1 }).width)
    return width
  }, [estimatedPageSize.width, loadedPages])
  const activeCommentRail =
    activePage && !translationLayoutOpen ? (commentRails.get(activePage) ?? 0) : 0
  const wideTranslation = translationLayoutOpen && size.outerWidth > PDF_WIDE_TRANSLATION_MIN_WIDTH
  useLayoutEffect(() => {
    if (wideTranslation) update({ mode: 'width' })
  }, [update, wideTranslation])
  const fitViewport = {
    width: Math.max(
      1,
      wideTranslation
        ? size.outerWidth - PDF_WIDE_TRANSLATION_GUTTER
        : size.width - activeCommentRail - PAGE_GUTTER
    ),
    height: Math.max(1, size.height - PAGE_GUTTER),
  }
  const translationSourceSize = {
    width: translationSourceWidth,
    height: natural?.height ?? estimatedPageSize.height,
  }
  const fittedPageSize = translationLayoutOpen
    ? translationSpreadSize(translationSourceSize, translationRatio)
    : (natural ?? estimatedPageSize)
  const scale =
    mode === 'custom'
      ? storedScale
      : size.width && size.height
        ? fittedScale(mode, fittedPageSize, fitViewport)
        : 1
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  const navigate = useCallback(
    (target: number): void => {
      setFocus(undefined)
      setReturnPosition(null)
      const page = pageNumber(target, pageCount)
      update({ page })
      viewportRef.current
        ?.querySelector<HTMLElement>(`[data-testid="pdf-page-${page}"]`)
        ?.scrollIntoView({ block: 'start', inline: 'center' })
    },
    [pageCount, update]
  )

  const navigateInternalLink = useCallback(
    async (destination: PdfDestination): Promise<void> => {
      const resolver = destinationResolver.current
      const viewport = viewportRef.current
      if (!resolver || !viewport) return
      const target = await resolveDestination(destination, resolver)
      if (!target) return
      setReturnPosition({ page: currentPage, top: viewport.scrollTop, left: viewport.scrollLeft })
      update({ page: target.page })
      requestFocus({ kind: 'link', ...target })
    },
    [currentPage, requestFocus, update]
  )

  const returnToLinkSource = useCallback((): void => {
    const position = returnPosition
    const viewport = viewportRef.current
    if (!position || !viewport) return
    setReturnPosition(null)
    setFocus(undefined)
    update({ page: position.page })
    window.requestAnimationFrame(() =>
      viewport.scrollTo({ top: position.top, left: position.left })
    )
  }, [returnPosition, update])

  // Restore page after tab remount or geometry changes. Scrolling itself does not trigger this effect.
  useLayoutEffect(() => {
    if (translationResize.current || navigationAnchorRef.current) return
    const zoomAnchor = zoomAnchorRef.current
    if (zoomAnchor) {
      zoomAnchorRef.current = undefined
      const page = viewportRef.current?.querySelector<HTMLElement>(
        `[data-testid="pdf-page-${zoomAnchor.page}"]`
      )
      if (page) {
        const bounds = page.getBoundingClientRect()
        viewportRef.current?.scrollBy({
          left: bounds.left + bounds.width * zoomAnchor.x - zoomAnchor.clientX,
          top: bounds.top + bounds.height * zoomAnchor.y - zoomAnchor.clientY,
        })
        return
      }
    }
    if (focus && focus.kind !== 'citation') {
      requestFocus(focus)
      return
    }
    if (citationPages?.length) {
      requestFocus(
        focus?.kind === 'citation' && citationPages.some((target) => target.page === focus.page)
          ? focus
          : { kind: 'citation', page: citationPages[0].page }
      )
      return
    }
    const viewport = viewportRef.current
    if (viewport && viewport !== restoredViewportRef.current && pageCount > 0) {
      const page = viewport.querySelector<HTMLElement>(`[data-testid="pdf-page-${currentPage}"]`)
      if (page) {
        restoredViewportRef.current = viewport
        page.scrollIntoView({ block: 'start', inline: 'center' })
      }
    }
    if (focus?.kind === 'citation' && focus.page === currentPage) {
      requestFocus({ kind: 'citation', page: currentPage, region: focus.region })
    }
  }, [pageCount, scale, sidebar, translationLayoutOpen])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const anchor = navigationAnchorRef.current
    if (!anchor || !viewport) return
    const nextSize = {
      width: viewport.clientWidth,
      height: viewport.clientHeight,
      outerWidth: viewport.offsetWidth,
    }
    if (
      size.width !== nextSize.width ||
      size.height !== nextSize.height ||
      size.outerWidth !== nextSize.outerWidth
    ) {
      setSize(nextSize)
      return
    }
    navigationAnchorRef.current = undefined
    const page = viewport.querySelector<HTMLElement>(`[data-testid="pdf-page-${anchor.page}"]`)
    if (!page) return
    const bounds = page.getBoundingClientRect()
    const target = viewport.scrollTop + bounds.top + bounds.height * anchor.y - anchor.clientY
    viewport.scrollTo({ top: target })
    constrainedNavigationRef.current =
      target < 0 || target > viewport.scrollHeight - viewport.clientHeight
        ? { viewport, top: viewport.scrollTop, anchor }
        : null
  }, [sidebar, size])
  useEffect(() => setPageInput(String(currentPage)), [currentPage])

  useEffect(() => {
    const page = citationPages?.[0]?.page
    if (!page || !pageCount) return
    requestFocus({ kind: 'citation', page })
  }, [citation, pageCount, requestFocus])

  const consumedAnnotationFocus = useRef<AnnotationFocus | undefined>(undefined)
  useEffect(() => {
    if (selectionTarget && pageCount) requestFocus({ kind: 'citation', page: selectionTarget.page })
  }, [selectionReveal?.sequence, pageCount, requestFocus])
  useEffect(() => {
    if (
      !annotationFocus ||
      consumedAnnotationFocus.current === annotationFocus ||
      annotationFocus.revision !== session?.revision ||
      sidecar?.source_revision !== session.revision
    )
      return
    const mark = sidecar.records.marks.find(
      (candidate) =>
        candidate.id === annotationFocus.markId &&
        candidate.page === annotationFocus.page &&
        candidate.anchor_state === 'anchored'
    )
    if (!mark) return
    consumedAnnotationFocus.current = annotationFocus
    setActiveMark(mark.id)
    requestFocus({ kind: 'annotation', page: mark.page, id: mark.id })
  }, [annotationFocus, session?.revision, sidecar, requestFocus])

  useEffect(() => {
    if (query.trim()) setFocus(undefined)
    if (!query.trim() || !pageCount) {
      setHits([])
      setSearching(false)
      return
    }
    let active = true
    setSearching(true)
    setSearchError(null)
    setHits([])
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: SearchHit[] = []
        let anyText = false
        for (let first = 1; first <= pageCount && active; first += SEARCH_BATCH_SIZE) {
          const batch = await Promise.all(
            Array.from(
              { length: Math.min(SEARCH_BATCH_SIZE, pageCount - first + 1) },
              async (_, offset) => {
                const page = await loadPage(first + offset)
                if (!page) return null
                let text = textCache.current.get(page.pageNumber)
                if (text === undefined) {
                  const content = await page.getTextContent()
                  text = pdfPlainText(content)
                  if (active) textCache.current.set(page.pageNumber, text)
                }
                return { page: page.pageNumber, text }
              }
            )
          )
          for (const item of batch) {
            if (!item) continue
            anyText ||= Boolean(item.text.trim())
            for (const [ordinal, match] of matchText(item.text, query).entries())
              found.push({
                page: item.page,
                text: item.text.slice(match.start, match.end),
                ordinal,
              })
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
        if (active) {
          setSearching(false)
          setSearchError(error instanceof Error ? error.message : String(error))
        }
      })
    }, SEARCH_DELAY_MS)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
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
    host.querySelectorAll<HTMLElement>('.vds-pdf-page').forEach((page) => {
      const layer = page.querySelector<HTMLElement>('.textLayer')
      if (!layer || !sourceRange.intersectsNode(layer)) return
      const pageRange = document.createRange()
      pageRange.selectNodeContents(layer)
      const clipped = sourceRange.cloneRange()
      if (sourceRange.compareBoundaryPoints(Range.START_TO_START, pageRange) < 0)
        clipped.setStart(pageRange.startContainer, pageRange.startOffset)
      if (sourceRange.compareBoundaryPoints(Range.END_TO_END, pageRange) > 0)
        clipped.setEnd(pageRange.endContainer, pageRange.endOffset)
      const withinPage =
        layer.contains(sourceRange.startContainer) && layer.contains(sourceRange.endContainer)
      const text = selectionPageText(selection.toString(), clipped.toString(), withinPage)
      const quads = normalizeQuads(
        clipQuads(selectionRectangles(clipped, layer), page.getBoundingClientRect())
      )
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
    controller.setSelection(
      tabId,
      {
        document_id: session.documentId,
        document_session_id: sessionId,
        revision: session.revision,
        status: 'exact',
        text: first.text,
        locator: {
          kind: 'pdf',
          page: first.page,
          quads: first.quads,
          text_length: Array.from(first.text).length,
        },
      },
      viewport
    )
  }

  const selectedText = selections.map((selection) => selection.text).join('\n')
  const clearSelection = useCallback((): void => {
    setActiveMark(null)
    setSelections([])
    setHighlightOpen(false)
    setCommentFormOpen(false)
    setCommentDraft('')
    controller.setSelection(tabId, null)
    window.getSelection()?.removeAllRanges()
  }, [controller, tabId])

  const selectionMarks = (
    style: PdfTextMarkStyle,
    color: PdfMarkColor,
    selected = selections
  ): PdfTextMarkRecord[] =>
    selected.map((selection) => {
      const timestamp = Date.now() / 1000
      return {
        ...selection,
        quads: style === 'highlight' ? normalizeHighlightQuads(selection.quads) : selection.quads,
        id: crypto.randomUUID(),
        style,
        color,
        anchor_state: 'anchored',
        created_at: timestamp,
        updated_at: timestamp,
      }
    })

  const persistRecords = async (
    next: PdfRecords,
    options: { clear?: boolean; focus?: PdfMark; statusCode?: PdfResultCode; undo?: boolean }
  ): Promise<boolean> => {
    if (!session || !sidecar || recordSaving.current) return false
    const previous = sidecar
    const pendingFocus = options.focus
    const rollback = (): void => {
      setSidecar(previous)
      if (pendingFocus && !previous.records.marks.some((mark) => mark.id === pendingFocus.id))
        setActiveMark(null)
    }
    recordSaving.current = true
    setSaving(true)
    setSidecar(stagePdfRecords(previous, next))
    if (options.clear) clearSelection()
    if (pendingFocus) {
      setActiveMark(pendingFocus.id)
      if (pendingFocus.style === 'comment') controller.setSelection(tabId, null)
      setSelections(
        pendingFocus.style === 'comment'
          ? []
          : [{ page: pendingFocus.page, text: pendingFocus.text, quads: pendingFocus.quads }]
      )
    }
    const saved = await commitPdfRecords(
      session.source,
      next,
      previous.record_revision,
      previous.source_revision
    )
    if (!mounted.current || currentUndoHistory.current !== undoHistory) return false
    if (saved === 'conflict') {
      rollback()
      notifyResult('conflict')
      const fresh = await loadPdfRecords(session.source)
      if (mounted.current && currentUndoHistory.current === undoHistory) setSidecar(fresh)
    } else if (saved) {
      if (options.undo) undoHistory.consume(saved)
      else undoHistory.record(previous, saved)
      setSidecar(saved)
      if (options.statusCode) notifyResult(options.statusCode)
    } else {
      rollback()
      notifyResult('saveFailed')
    }
    if (!mounted.current || currentUndoHistory.current !== undoHistory) return false
    recordSaving.current = false
    setSaving(false)
    return Boolean(saved && saved !== 'conflict')
  }

  const undoRecords = async (): Promise<void> => {
    if (!sidecar || recordSaving.current || !session?.capabilities.can_annotate) return
    const previous = undoHistory.peek(sidecar)
    if (previous && (await persistRecords(previous, { undo: true }))) clearSelection()
  }

  const addMark = async (
    style: PdfTextMarkStyle,
    color: PdfMarkColor,
    selected = selections
  ): Promise<void> => {
    if (!sidecar || !selected.length || !session?.capabilities.can_annotate) return
    const added = selectionMarks(style, color, selected)
    await persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: [...sidecar.records.marks, ...added],
        comments: sidecar.records.comments,
        notes: sidecar.records.notes,
      },
      { clear: true, focus: added[0] }
    )
  }

  const addAiComment = async (selection: PageSelection, body: string): Promise<boolean> => {
    if (!sidecar || !session?.capabilities.can_annotate || saving || !body.trim()) return false
    const mark = selectionMarks('highlight', DEFAULT_PDF_MARK_COLOR, [
      {
        page: selection.page,
        text: selection.text,
        quads: selection.quads,
      },
    ])[0]
    if (!mark) return false
    const comment: PdfComment = {
      id: crypto.randomUUID(),
      mark_id: mark.id,
      body: body.trim(),
      created_at: Date.now() / 1000,
    }
    return persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: [...sidecar.records.marks, mark],
        comments: [...sidecar.records.comments, comment],
        notes: sidecar.records.notes,
      },
      {}
    )
  }

  const addComment = async (): Promise<void> => {
    if (!sidecar || !selections.length || !commentDraft.trim()) return
    const added = selectionMarks('highlight', DEFAULT_PDF_MARK_COLOR)
    const comments: PdfComment[] = added.map((mark) => ({
      id: crypto.randomUUID(),
      mark_id: mark.id,
      body: commentDraft.trim(),
      created_at: Date.now() / 1000,
    }))
    const saved = await persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: [...sidecar.records.marks, ...added],
        comments: [...sidecar.records.comments, ...comments],
        notes: sidecar.records.notes,
      },
      {}
    )
    if (saved) clearSelection()
  }

  const updateMark = async (
    markId: string,
    patch: { color?: PdfMarkColor; style?: PdfTextMarkStyle }
  ): Promise<void> => {
    if (!sidecar) return
    const current = sidecar.records.marks.find((mark) => mark.id === markId)
    if (
      !current ||
      (current.style === 'comment' && patch.style !== undefined) ||
      ((patch.color === undefined || patch.color === current.color) &&
        (patch.style === undefined || patch.style === current.style))
    )
      return
    const updatedAt = Date.now() / 1000
    const updated: PdfMark =
      current.style === 'comment'
        ? { ...current, color: patch.color ?? current.color, updated_at: updatedAt }
        : { ...current, ...patch, updated_at: updatedAt }
    await persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: sidecar.records.marks.map((mark) => (mark.id === markId ? updated : mark)),
        comments: sidecar.records.comments,
        notes: sidecar.records.notes,
      },
      { focus: updated }
    )
  }

  const applyMark = (style: PdfTextMarkStyle, color: PdfMarkColor): void => {
    if (activeMark) void updateMark(activeMark, { style, color })
    else void addMark(style, color)
  }

  const addMarkComment = async (markId: string, body: string): Promise<boolean> => {
    if (!sidecar) return false
    const mark = sidecar.records.marks.find((candidate) => candidate.id === markId)
    if (!mark) return false
    return persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: sidecar.records.marks,
        comments: [
          ...sidecar.records.comments,
          { id: crypto.randomUUID(), mark_id: markId, body, created_at: Date.now() / 1000 },
        ],
        notes: sidecar.records.notes,
      },
      { focus: mark }
    )
  }

  const updateMarkComments = async (markId: string, drafts: PdfCommentEdit[]): Promise<boolean> => {
    if (!sidecar || !drafts.length || drafts.some((draft) => !draft.body.trim())) return false
    const mark = sidecar.records.marks.find((candidate) => candidate.id === markId)
    if (
      !mark ||
      drafts.some(
        (draft) =>
          !sidecar.records.comments.some(
            (comment) => comment.id === draft.id && comment.mark_id === markId
          )
      )
    )
      return false
    const bodies = new Map(drafts.map((draft) => [draft.id, draft.body.trim()]))
    return persistRecords(
      {
        ...sidecar.records,
        comments: sidecar.records.comments.map((comment) =>
          bodies.has(comment.id) ? { ...comment, body: bodies.get(comment.id)! } : comment
        ),
      },
      { focus: mark }
    )
  }

  const addPointComment = async (
    page: number,
    point: [number, number],
    body: string
  ): Promise<boolean> => {
    if (!sidecar || !session?.capabilities.can_annotate || !body.trim()) return false
    const mark = createPointMark(page, point)
    const timestamp = mark.created_at
    return persistRecords(
      {
        ...sidecar.records,
        marks: [...sidecar.records.marks, mark],
        comments: [
          ...sidecar.records.comments,
          { id: crypto.randomUUID(), mark_id: mark.id, body: body.trim(), created_at: timestamp },
        ],
      },
      { focus: mark }
    )
  }

  const deleteMark = async (markId: string): Promise<void> => {
    if (!sidecar) return
    const notes = sidecar.records.notes
      .map((note) => ({
        ...note,
        excerpts: note.excerpts.filter((excerpt) => excerpt.mark_id !== markId),
      }))
      .filter((note) => note.excerpts.length > 0 || note.body.trim().length > 0)
    await persistRecords(
      {
        schema_version: PDF_RECORD_SCHEMA_VERSION,
        marks: sidecar.records.marks.filter((mark) => mark.id !== markId),
        comments: sidecar.records.comments.filter((comment) => comment.mark_id !== markId),
        notes,
      },
      { statusCode: 'deleted' }
    )
  }

  const selectionContribution = useMemo(
    () => ({
      toolbarEnabled: selectionToolbarEnabled,
      forceVisible: commentFormOpen,
      actions: (
        <>
          <PdfTools
            section="marks"
            colors={markColors}
            selectionColor={selectionColor}
            onSelectionColor={setSelectionColor}
            disabled={!sidecar || saving || !session?.capabilities.can_annotate}
            hasSelection={selections.length > 0}
            onApply={applyMark}
            onColor={(style, color) =>
              setMarkColors((previous) => ({ ...previous, [style]: color }))
            }
            onComment={toggleSelectionComment}
            commentOpen={commentFormOpen}
            onOpenChange={setHighlightOpen}
          />
          <Divider
            orientation="vertical"
            className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-1)]"
          />
        </>
      ),
      dismiss: () => {
        setHighlightOpen(false)
        setCommentFormOpen(false)
      },
      expanded: commentFormOpen,
      id: 'pdf-records',
      order: 1,
      ...(sidecar && session?.capabilities.can_annotate
        ? {
            annotateResult: async ({
              selection,
              body,
            }: {
              selection: SelectionAnchor
              body: string
            }) => {
              if (
                selection.status !== 'exact' ||
                selection.document_session_id !== sessionId ||
                selection.revision !== session?.revision
              )
                return { ok: false }
              if (selection.locator.kind !== 'pdf') return { ok: false }
              const saved = await addAiComment(
                {
                  page: selection.locator.page,
                  text: selection.text,
                  quads: selection.locator.quads,
                },
                body
              )
              return { ok: saved }
            },
          }
        : {}),
      panel: commentFormOpen ? (
        <div className="vds-selection-action-result !border-t-0 !gap-[var(--vds-space-3)] !p-[var(--vds-space-3)]">
          <PdfCommentInput
            autoFocus
            aria-label={t('annotationContent')}
            rows={3}
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
          />
          <Button
            className="justify-self-end"
            size="sm"
            disabled={!commentDraft.trim() || saving}
            onClick={() => void addComment()}
          >
            {t('pdfAnnotation.kind.comment')}
          </Button>
        </div>
      ) : null,
    }),
    [
      selectionToolbarEnabled,
      activeMark,
      addAiComment,
      commentDraft,
      commentFormOpen,
      toggleSelectionComment,
      highlightOpen,
      markColors,
      selectionColor,
      saving,
      selections,
      session?.capabilities.can_annotate,
      session?.revision,
      sessionId,
      sidecar,
      t,
    ]
  )
  const copyContribution = useMemo(
    () => ({
      actions: (
        <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)]">
          <CopyButton
            value={selectedText}
            iconOnly
            icon={<Copy size={16} />}
            copiedIcon={<Check size={16} />}
            feedbackDuration={PDF_COPY_FEEDBACK_DURATION_MS}
            tooltip
            size="sm"
            variant="ghost"
            disabled={!selectedText}
            idleLabel={t('copySelection')}
            writeText={async (text) => {
              const writer = window.scholarseed?.writeClipboard
              if (!writer) throw new Error('clipboard unavailable')
              const result = await writer(text)
              notifyResult(result.ok ? 'copied' : 'copyFailed')
              if (!result.ok) throw new Error('clipboard write failed')
            }}
          />
          <PdfTools
            section="comment"
            colors={markColors}
            disabled={!sidecar || saving || !session?.capabilities.can_annotate}
            hasSelection={selections.length > 0}
            onApply={applyMark}
            onColor={(style, color) =>
              setMarkColors((previous) => ({ ...previous, [style]: color }))
            }
            onComment={toggleSelectionComment}
            commentOpen={commentFormOpen}
          />
        </div>
      ),
      expanded: false,
      id: 'pdf-copy',
      order: 100,
    }),
    [
      selectedText,
      t,
      markColors,
      sidecar,
      saving,
      session?.capabilities.can_annotate,
      selections,
      commentFormOpen,
      toggleSelectionComment,
    ]
  )
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
  const zoom = useCallback(
    (value: number): void =>
      update({ mode: 'custom', scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, value)) }),
    [update]
  )
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
      const target =
        event.target instanceof Element ? event.target.closest<HTMLElement>('.vds-pdf-page') : null
      const page =
        target ?? host.querySelector<HTMLElement>(`[data-testid="pdf-page-${currentPage}"]`)
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
            clientY,
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
        metaKey: event.metaKey,
      })
      if (nextScale === null) return
      event.preventDefault()
      if (nextScale === (wheelZoomScaleRef.current ?? scaleRef.current)) return
      wheelZoomScaleRef.current = nextScale
      wheelZoomEventRef.current = event
      if (wheelZoomFrameRef.current === undefined)
        wheelZoomFrameRef.current = window.requestAnimationFrame(flushWheelZoom)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      host.removeEventListener('wheel', onWheel)
      if (wheelZoomFrameRef.current !== undefined)
        window.cancelAnimationFrame(wheelZoomFrameRef.current)
      wheelZoomFrameRef.current = undefined
      wheelZoomScaleRef.current = undefined
      wheelZoomEventRef.current = undefined
    }
  }, [currentPage, zoom])
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if (!active) return
      if (controller.getSnapshot().focusedTabId !== tabId) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const searchFocused = target === searchInputRef.current
      const editable = Boolean(target?.closest('input, textarea') || target?.isContentEditable)
      const shortcut = resolveShortcut(event, ['pdf'])
      if (!shortcut || (editable && !searchFocused)) return
      if (shortcut.id === 'pdf.undo' && (editable || event.isComposing || event.defaultPrevented))
        return
      if ((shortcut.id === 'pdf.findNext' || shortcut.id === 'pdf.findPrevious') && !searchFocused)
        return
      event.preventDefault()
      if (shortcut.id === 'pdf.undo') {
        void undoRecords()
      } else if (shortcut.id === 'pdf.find') {
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
      else if (shortcut.id === 'pdf.scrollUp')
        viewportRef.current?.scrollBy({ top: -PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollDown')
        viewportRef.current?.scrollBy({ top: PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollLeft')
        viewportRef.current?.scrollBy({ left: -PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollRight')
        viewportRef.current?.scrollBy({ left: PDF_SCROLL_STEP_PX })
      else if (shortcut.id === 'pdf.scrollPageDown')
        viewportRef.current?.scrollBy({
          top: (viewportRef.current?.clientHeight ?? 0) * PDF_PAGE_SCROLL_RATIO,
        })
      else if (shortcut.id === 'pdf.scrollPageUp')
        viewportRef.current?.scrollBy({
          top: -(viewportRef.current?.clientHeight ?? 0) * PDF_PAGE_SCROLL_RATIO,
        })
      else if (shortcut.id === 'pdf.highlight') applyMark('highlight', markColors.highlight)
      else if (shortcut.id === 'pdf.comment' && (selections.length || activeMark))
        setCommentFormOpen(true)
      else if (shortcut.id === 'pdf.copyText' && selectedText) {
        void window.scholarseed
          ?.writeClipboard(selectedText)
          .then((result) => notifyResult(result.ok ? 'copied' : 'copyFailed'))
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [
    active,
    activeMark,
    controller,
    currentPage,
    hitIndex,
    hits,
    markColors.highlight,
    navigate,
    pageCount,
    scale,
    selectedText,
    selections.length,
    sidecar,
    sidebar,
    sidebarTab,
    tabId,
    undoHistory,
    update,
    zoom,
  ])
  const syncSelectionViewport = useCallback((): void => {
    const host = viewportRef.current
    if (!host) return
    const workspace = controller.getSnapshot()
    const selectedSession = workspace.sessions[sessionId]
    const presentation = workspace.selectionPresentations[tabId]
    if (
      !presentation ||
      selectedSession?.selection?.status !== 'exact' ||
      selectedSession.selection.locator.kind !== 'pdf' ||
      !selections.length
    )
      return
    const viewport = persistedSelectionViewport(host, selections) ?? {
      ...presentation,
      boundary: pdfSelectionBoundary(host),
    }
    const boundary = viewport.boundary
    controller.setSelection(tabId, selectedSession.selection, {
      ...viewport,
      visible: Boolean(
        active && boundary && boundary.right > boundary.left && boundary.bottom > boundary.top
      ),
    })
  }, [active, controller, selections, sessionId, tabId])
  useLayoutEffect(() => {
    const host = viewportRef.current
    if (!host) return
    syncSelectionViewport()
    const observer = new ResizeObserver(syncSelectionViewport)
    observer.observe(host)
    window.addEventListener('resize', syncSelectionViewport)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncSelectionViewport)
    }
  }, [syncSelectionViewport, scale, sidebar, navigationWidth])
  const onScroll = (): void => {
    const host = viewportRef.current
    if (!host) return
    if (selections.length && selectionDragSpan === null) window.getSelection()?.removeAllRanges()
    const elements = Array.from(host.querySelectorAll<HTMLElement>('.vds-pdf-page'))
    const page = mostVisiblePage(
      elements.map((element) => {
        const { top, bottom } = element.getBoundingClientRect()
        return { page: Number(element.dataset.page), top, bottom }
      }),
      host.getBoundingClientRect()
    )
    if (page && selectionDragSpan)
      setSelectionDragSpan((current) =>
        current && current.focus !== page ? { ...current, focus: page } : current
      )
    if (page && page !== readingRef.current?.page) update({ page })
    syncSelectionViewport()
  }
  const canExport = Boolean(session?.bytes.length && (!recordTargetFor(session.source) || sidecar))
  const exportLabel = exporting
    ? t('pdfToolbar.exporting')
    : !session?.bytes.length
      ? t('loading')
      : !canExport
        ? t('status.readFailed')
        : t('pdfToolbar.export')
  const exportPdf = async (): Promise<void> => {
    if (!session || !canExport || exportingRef.current) return
    exportingRef.current = true
    setExporting(true)
    try {
      const result = await exportAnnotatedPdf(
        session.bytes,
        sidecar,
        sidecar
          ? session.title.replace(/\.pdf$/i, '') + t('export.annotatedFilenameSuffix')
          : session.title,
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
  const preserveReadingPosition = (): void => {
    const viewport = viewportRef.current
    const page = viewport?.querySelector<HTMLElement>(`[data-testid="pdf-page-${currentPage}"]`)
    if (!viewport || !page) return
    const frame = viewport.getBoundingClientRect()
    const bounds = page.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    const clientX = Math.max(bounds.left, Math.min(bounds.right, frame.left + frame.width / 2))
    const clientY = Math.max(bounds.top, Math.min(bounds.bottom, frame.top + frame.height / 3))
    zoomAnchorRef.current = {
      page: currentPage,
      x: (clientX - bounds.left) / bounds.width,
      y: (clientY - bounds.top) / bounds.height,
      clientX,
      clientY,
    }
  }
  const toggleNavigation = (): void => {
    const viewport = viewportRef.current
    const constrained = constrainedNavigationRef.current
    constrainedNavigationRef.current = null
    if (viewport && !citationPages?.length && focus?.kind !== 'citation') {
      if (constrained?.viewport === viewport && constrained.top === viewport.scrollTop) {
        navigationAnchorRef.current = constrained.anchor
        update({ sidebar: !sidebar })
        return
      }
      const frame = viewport.getBoundingClientRect()
      const clientY = frame.top + frame.height / 3
      let nearestDistance = Infinity
      for (const page of viewport.querySelectorAll<HTMLElement>('.vds-pdf-page')) {
        const bounds = page.getBoundingClientRect()
        if (bounds.height <= 0) continue
        const distance = Math.max(bounds.top - clientY, clientY - bounds.bottom, 0)
        if (distance >= nearestDistance) continue
        nearestDistance = distance
        navigationAnchorRef.current = {
          page: Number(page.dataset.page),
          y: (clientY - bounds.top) / bounds.height,
          clientY,
        }
        if (distance === 0) break
      }
    }
    update({ sidebar: !sidebar })
  }
  const anchoredMarks =
    sidecar?.records.marks.filter((mark) => mark.anchor_state === 'anchored') ?? []
  const analysis = usePdfAnalysis({
    active,
    artifact:
      session?.source.kind === 'session-artifact'
        ? {
            session_id: session.source.sessionId,
            artifact_id: session.source.artifactId,
            member: session.source.memberPath,
          }
        : undefined,
    citation:
      session?.source.kind === 'session-file' ? pdfCitationSource(session.source) : undefined,
    literatureId,
    literatureTitle: excerptSource?.literatureId === literatureId ? excerptSource.title : '',
    attachmentId,
    title: session?.title ?? '',
    assetId: session?.source.kind === 'project' ? (session.source.assetId ?? '') : '',
    path: session?.source.kind === 'project' ? session.source.path : '',
    projectId: session?.source.kind === 'project' ? (session.source.project ?? '') : '',
    revision: session?.revision ?? '',
    tabId,
    page: currentPage,
    pageCount,
    documentText,
    selection: selections,
    canAnnotate: Boolean(sidecar && session?.capabilities.can_annotate),
    onAddComment: addAiComment,
    onNavigate: navigate,
    onLocate: (sourcePage, text, quads) => {
      if (sourcePage !== currentPage) navigate(sourcePage)
      requestFocus({ kind: 'reading', page: sourcePage, text, quads })
    },
    onReadingLayoutChange: preserveReadingPosition,
    onReadingOpen: () => {
      readingResized.current = false
      update({ mode: 'width', sidebar: false })
      set({ aiPanel: { ...appState.aiPanel, open: false, cover: false } })
    },
    onDocumentTranslationChange: handleDocumentTranslationChange,
    viewportRef,
    onExclusiveSurfaceOpen: () => {
      clearFigureSelection()
      closeDocumentPanel()
      update({ records: false })
    },
  })
  const resizableDocumentPanel = Boolean(
    activeDocumentPanel?.resizable && !analysis.panel && !analysis.expandedSelectionResult
  )
  const readingPanelOpen = analysis.panel === 'interpretation' || resizableDocumentPanel
  const readingPanelExpanded =
    analysis.panel === 'interpretation'
      ? analysis.panelExpanded
      : resizableDocumentPanel && expandedPanel === activeDocumentPanel?.id
  useLayoutEffect(() => {
    const group = readingGroupRef.current
    if (!group || !readingPanelOpen || readingPanelExpanded) return
    const resize = (): void => {
      if (readingResized.current) return
      const handle = group.children[1] as HTMLElement | undefined
      const available = group.clientWidth - (handle?.offsetWidth ?? 0)
      const panelWidth = parseFloat(
        getComputedStyle(group).getPropertyValue('--vds-layout-pdf-panel-width')
      )
      if (available <= 0 || !Number.isFinite(panelWidth)) return
      const percent = Math.min(100 - READING_SPLIT_MINIMUM, (panelWidth / available) * 100)
      setReadingSplit([100 - percent, percent])
      setReadingPanelMinimum(Math.min(READING_SPLIT_MINIMUM, percent))
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(group)
    return () => observer.disconnect()
  }, [readingPanelOpen, readingPanelExpanded])
  useEffect(() => {
    if (
      active &&
      appState.aiPanel.open &&
      analysis.panel === 'interpretation' &&
      !analysis.preparingChat
    )
      analysis.setPanel(null)
  }, [active, appState.aiPanel.open])
  const copyVisualRegion = useCallback(
    async (region: PdfVisualRegion): Promise<void> => {
      if (!session) return
      if (region.kind === 'formula') {
        analysis.copyFormula(region)
        return
      }
      try {
        const image = await loadPdfVisualRegionImage(
          {
            literatureId,
            attachmentId,
            path: session.source.kind === 'project' ? session.source.path : '',
            projectId: session.source.kind === 'project' ? (session.source.project ?? '') : '',
            revision: session.revision,
          },
          region
        )
        await writeClipboardImage(image)
        toast({ title: t('visualRegions.imageCopied'), tone: 'success' })
      } catch {
        toast({ title: t('visualRegions.copyFailed'), tone: 'error' })
      }
    },
    [analysis.copyFormula, attachmentId, literatureId, session, t, toast]
  )
  const exitFigureSelection = useCallback((): void => {
    clearFigureSelection()
    analysis.exitFigureSelection()
  }, [analysis.exitFigureSelection, clearFigureSelection])
  const activeDocumentPanelId = activeDocumentPanel?.id
  const rightPanelOpen = Boolean(analysis.sidePanel || (activeDocumentPanelId && !analysis.panel))
  useEffect(() => {
    if (!active) return
    set({
      pdfSidePanelOpen: rightPanelOpen,
      ...(rightPanelOpen ? { modulePanelOpen: false } : {}),
    })
  }, [active, rightPanelOpen, set])
  useEffect(
    () => () => {
      if (active) set({ pdfSidePanelOpen: false })
    },
    [active, set]
  )
  const encrypted = loadError?.kind === PDF_LOAD_FAILURE_KIND.encrypted
  const canOpenEncryptedExternally = Boolean(session && isLocatedDocumentSource(session.source))
  const openEncryptedExternally = async (): Promise<void> => {
    if (!session || !isLocatedDocumentSource(session.source)) return
    setExternalOpening(true)
    const resolved = await resolveDocumentLocation(session.source)
    const opened =
      resolved.ok && resolved.absolute ? await openSystemPath(resolved.absolute) : { ok: false }
    setExternalOpening(false)
    if (!opened.ok) toast({ title: t('encrypted.openFailed'), tone: 'error' })
  }

  const renderAnnotation = (
    mark: PdfMark,
    close: () => void,
    initialMode: 'edit' | 'comment' = 'edit',
    inlineComment = false,
    appearanceOnly = false
  ): React.ReactNode => (
    <PdfAnnotation
      result={analysis.annotationResult?.markId === mark.id ? analysis.annotationResult : null}
      onOpenSettings={() => appActions.openSettings('prompts')}
      key={`${mark.id}-${initialMode}`}
      initialMode={appearanceOnly && mark.style === 'comment' ? 'comment' : initialMode}
      inlineComment={inlineComment}
      appearanceOnly={appearanceOnly && initialMode === 'edit' && mark.style !== 'comment'}
      analyzing={analysis.selectionAnalyzing}
      canAnalyze={mark.style !== 'comment' && analysis.canAnalyzeSelection}
      comments={sidecar?.records.comments.filter((comment) => comment.mark_id === mark.id) ?? []}
      mark={mark}
      saving={saving}
      onColorChange={(color) => {
        void updateMark(mark.id, { color })
      }}
      onComment={(body) => addMarkComment(mark.id, body)}
      onUpdateComments={(drafts) => updateMarkComments(mark.id, drafts)}
      onClose={close}
      onDelete={() => {
        void deleteMark(mark.id)
      }}
      onStyleChange={(style) => {
        void updateMark(mark.id, { style })
      }}
      onExplain={(instruction) => {
        if (mark.style === 'comment') return
        analysis.explainSelection(
          { page: mark.page, text: mark.text, quads: mark.quads },
          instruction,
          mark.id
        )
      }}
      onTranslate={() => {
        if (mark.style === 'comment') return
        analysis.translateSelection(
          { page: mark.page, text: mark.text, quads: mark.quads },
          mark.id
        )
      }}
      onAddToTask={async () => {
        if (
          !session ||
          mark.anchor_state !== 'anchored' ||
          !sidecar ||
          sidecar.source_revision !== session.revision
        )
          return false
        const added = await addPdfCommentContext(
          session,
          sidecar,
          mark.id,
          mark.style === 'comment'
            ? null
            : {
                document_id: session.documentId,
                document_session_id: sessionId,
                revision: session.revision,
                status: 'exact',
                text: mark.text,
                locator: {
                  kind: 'pdf',
                  page: mark.page,
                  quads: mark.quads,
                  text_length: Array.from(mark.text).length,
                },
              },
          controller,
          ingress
        )
        if (!added) return false
        return true
      }}
    />
  )

  useEffect(() => {
    if (analysis.figure) setActiveTool(null)
  }, [analysis.figure])
  useEffect(() => {
    if (!active || (!analysis.figure && !activeTool && !selections.length && !activeMark))
      return undefined
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (controller.getSnapshot().focusedTabId !== tabId) return
      if (
        (event.target as Element | null)?.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"], [role="region"]'
        )
      )
        return
      event.preventDefault()
      if (analysis.figure) exitFigureSelection()
      setActiveTool(null)
      setSelectionDragSpan(null)
      clearSelection()
    }
    window.addEventListener('keydown', onEscape)
    return () => window.removeEventListener('keydown', onEscape)
  }, [
    active,
    activeMark,
    activeTool,
    analysis.figure,
    clearSelection,
    controller,
    exitFigureSelection,
    selections.length,
    tabId,
  ])

  const documentPanelContent =
    activeDocumentPanel &&
    !analysis.panel &&
    !analysis.expandedSelectionResult &&
    documentPanels ? (
      <PdfPanel
        key={`${documentPanels.context.documentSessionId}:${activeDocumentPanel.id}`}
        ariaLabel={activeDocumentPanel.label(i18n)}
        bodyClassName={
          activeDocumentPanel.headerActions ? 'min-h-0 flex-1 overflow-hidden' : undefined
        }
        closeLabel={t('reading.close')}
        expanded={expandedPanel === activeDocumentPanel.id}
        inline={resizableDocumentPanel}
        icon={activeDocumentPanel.icon ?? <NotepadText size={16} />}
        testId={`document-panel-${activeDocumentPanel.id}`}
        headerSeparator={activeDocumentPanel.headerSeparator}
        title={activeDocumentPanel.title}
        headerActionsRef={
          activeDocumentPanel.headerActions ? setDocumentPanelHeaderHost : undefined
        }
        onClose={() => {
          setExpandedPanel(null)
          documentPanels.toggle(activeDocumentPanel.id)
        }}
        onToggleExpanded={
          activeDocumentPanel.headerActions && !activeDocumentPanel.resizable
            ? undefined
            : () => {
                preserveReadingPosition()
                setExpandedPanel((value) =>
                  value === activeDocumentPanel.id ? null : activeDocumentPanel.id
                )
              }
        }
      >
        {activeDocumentPanel.render(documentPanels.context, {
          headerActionsHost: documentPanelHeaderHost,
          annotationAction: (onDirectWrite) =>
            activeDocumentPanel.renderAnnotationAction?.({
              context: documentPanels.context,
              snapshot: sidecar ?? null,
              disabled: saving,
              dismissSelection: clearSelection,
              openPanel: () => {
                if (documentPanels.activePanelId !== activeDocumentPanel.id) {
                  documentPanels.toggle(activeDocumentPanel.id)
                }
              },
              placement: 'panel',
              onDirectWrite,
            }),
        })}
      </PdfPanel>
    ) : null

  const requestedPage = Number(goToPageValue)
  const canGoToPage =
    Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= pageCount
  const pageNumbers = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount]
  )
  const goToPage = (): void => {
    if (!canGoToPage) return
    navigate(requestedPage)
    setGoToPageOpen(false)
  }

  const documentPanelActions = (placement: 'start' | 'end'): React.ReactNode =>
    documentPanels?.panels
      .filter((panel) => (panel.railPlacement ?? 'end') === placement)
      .map((panel) => {
        const label = panel.label(i18n)
        return (
          <Tooltip key={panel.id} portalled content={label} side="left">
            <IconButton
              aria-pressed={documentPanels.activePanelId === panel.id}
              data-testid={`document-panel-toggle-${panel.id}`}
              label={label}
              title={undefined}
              icon={panel.icon ?? <NotepadText size={18} />}
              variant={
                documentPanels.activePanelId === panel.id && panel.activeTone === 'brand'
                  ? 'secondary'
                  : 'ghostIcon'
              }
              onClick={() => {
                exitFigureSelection()
                analysis.setPanel(null)
                update({ records: false })
                setExpandedPanel(null)
                documentPanels.toggle(panel.id)
              }}
            />
          </Tooltip>
        )
      })
  return (
    <div
      ref={documentRef}
      className="vds-pdf-document flex h-full min-h-0 flex-col bg-[var(--bg-2)] text-[var(--text-1)]"
      data-pdf-active={active}
      data-shortcut-scope="pdf"
      data-testid="pdf-document"
      data-ob="pdf-reader"
      data-ob-document={session?.documentId}
    >
      {encrypted ? (
        <EncryptedPdfState
          canOpenExternally={canOpenEncryptedExternally}
          opening={externalOpening}
          onOpen={() => void openEncryptedExternally()}
        />
      ) : (
        <>
          {analysis.floating}
          {cropBox && (
            <div
              aria-label={t('figureRegion')}
              style={cropBox}
              className="pointer-events-none fixed z-[var(--vds-z-popover)] border-2 border-[var(--vds-brand-default)]"
            />
          )}
          <div
            className="vds-pdf-tools [&_.vds-icon-button]:!size-[var(--vds-control-height-md)] [&_.vds-icon-button]:!min-w-[var(--vds-control-height-md)] [&_.vds-icon-button>span]:!text-[var(--vds-icon-outline-default)] [&_svg]:!text-[var(--vds-icon-outline-default)] [&_.iconfont]:!text-[var(--vds-icon-outline-default)] relative flex min-h-[var(--vds-library-toolbar-height)] flex-wrap items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-light-default)] px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-pdf-selection-font-size)]"
            role="toolbar"
            aria-label={t('pdfToolbar.toolbar')}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-[var(--vds-toolbar-icon-gap)] px-[calc(var(--vds-control-height-md)*2+var(--vds-space-2))]">
              <Tooltip
                portalled
                content={t('pdfToolbar.directory')}
                className="!absolute left-[var(--vds-space-3)] top-[var(--vds-space-2)]"
              >
                <IconButton
                  label={t('pdfToolbar.directory')}
                  title={undefined}
                  icon={<BookOpen size={15} />}
                  size="sm"
                  variant="ghostIcon"
                  data-testid="pdf-sidebar-toggle"
                  className="hover:!text-[var(--vds-text-secondary)] aria-pressed:!text-[var(--vds-text-primary)] hover:[&_svg]:!text-[var(--vds-text-secondary)] aria-pressed:[&_svg]:!text-[var(--vds-text-primary)] aria-pressed:hover:!text-[var(--vds-text-primary)] aria-pressed:hover:[&_svg]:!text-[var(--vds-text-primary)]"
                  aria-pressed={sidebar}
                  onClick={toggleNavigation}
                />
              </Tooltip>
              {returnPosition ? (
                <IconButton
                  label={t('pdfToolbar.returnToSource')}
                  icon={<Undo2 />}
                  size="sm"
                  variant="ghost"
                  data-testid="pdf-return-to-source"
                  onClick={returnToLinkSource}
                />
              ) : null}
              <IconButton
                label={t('pdfToolbar.zoomOut')}
                icon={<Icon name="minus" size={15} />}
                size="sm"
                variant="ghost"
                data-testid="pdf-zoom-out"
                disabled={scale <= MIN_SCALE}
                onClick={() => zoom(scale - SCALE_STEP)}
              />
              <PdfScale
                editLabel={t('pdfToolbar.editScale')}
                fitPageLabel={t('pdfToolbar.fitPage')}
                fitWidthLabel={t('pdfToolbar.fitWidth')}
                mode={mode}
                scale={scale}
                onModeChange={(nextMode) => update({ mode: nextMode })}
                onScaleChange={(nextScale) => zoom(nextScale)}
              />
              <IconButton
                label={t('pdfToolbar.zoomIn')}
                icon={<Icon name="plus" size={15} />}
                size="sm"
                variant="ghost"
                data-testid="pdf-zoom-in"
                disabled={scale >= MAX_SCALE}
                onClick={() => zoom(scale + SCALE_STEP)}
              />
              <Divider
                orientation="vertical"
                className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-2)]"
              />
              <IconButton
                label={t('pdfToolbar.previousPage')}
                icon={
                  <span className="inline-flex rotate-180">
                    <Icon name="chevron-right" size={15} />
                  </span>
                }
                size="sm"
                variant="ghost"
                data-testid="pdf-previous"
                disabled={currentPage <= 1 || !pageCount}
                onClick={() => navigate(currentPage - 1)}
              />
              <Input
                className="!h-[var(--vds-control-height-sm)] !w-[var(--vds-pdf-page-number-width)] !px-0 text-center tabular-nums"
                size="sm"
                aria-label={t('pdfToolbar.pageNumber')}
                data-testid="pdf-page-input"
                type="text"
                inputMode="numeric"
                min={1}
                max={pageCount || 1}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') navigate(pageNumber(pageInput, pageCount))
                }}
                onBlur={() => {
                  const target = pageNumber(pageInput, pageCount)
                  if (target !== currentPage) navigate(target)
                  setPageInput(String(target))
                }}
              />
              <span className="whitespace-nowrap text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] [font-weight:var(--vds-fw-regular)] text-[var(--vds-text-tertiary)] tabular-nums">
                / {pageCount || '…'}
              </span>
              <IconButton
                label={t('pdfToolbar.nextPage')}
                icon={<Icon name="chevron-right" size={15} />}
                size="sm"
                variant="ghost"
                data-testid="pdf-next"
                disabled={currentPage >= pageCount}
                onClick={() => navigate(currentPage + 1)}
              />
              <Divider
                orientation="vertical"
                className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-2)]"
              />
              <span
                {...documentSelectionInteractionProps}
                className="inline-flex items-center gap-[var(--vds-toolbar-icon-gap)] [&>[data-pdf-annotation-tools]]:order-first"
              >
                {analysis.toolbar}
                {analysis.toolbar && (
                  <Divider
                    orientation="vertical"
                    data-testid="pdf-selection-toolbar-divider"
                    className="!self-center !min-h-0 !h-[var(--vds-lh-body-lv1)] [--vds-divider-margin-vertical:0_var(--vds-space-2)]"
                  />
                )}
                {translationBackend ? (
                  <span className="inline-flex items-center gap-[var(--vds-space-2)] whitespace-nowrap">
                    <Switch
                      data-testid="pdf-selection-toolbar"
                      label={translationText('toolbar')}
                      checked={selectionToolbarEnabled}
                      disabled={selectionToolbarDisabled}
                      onCheckedChange={setSelectionToolbarEnabled}
                    />
                    <span className="font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]">
                      {translationText('toolbar')}
                    </span>
                  </span>
                ) : (
                  <Tooltip portalled content={t('selectionToolbarHint')} side="bottom">
                    <Toggle
                      pressed={selectionToolbarEnabled}
                      onPressedChange={setSelectionToolbarEnabled}
                      aria-label={t('selectionToolbar')}
                      data-testid="pdf-selection-toolbar-toggle"
                      className="!text-[length:var(--vds-pdf-selection-font-size)]"
                      size="sm"
                    >
                      {t('selectionToolbar')}
                    </Toggle>
                  </Tooltip>
                )}
                <PdfTools
                  colors={markColors}
                  disabled={!sidecar || saving || !session?.capabilities.can_annotate}
                  hasSelection={selections.length > 0}
                  onApply={applyMark}
                  onColor={(style, color) =>
                    setMarkColors((previous) => ({ ...previous, [style]: color }))
                  }
                  onComment={toggleSelectionComment}
                  commentOpen={commentFormOpen}
                  activeTool={activeTool}
                  onToggle={(tool) => {
                    exitFigureSelection()
                    dismissSelectionActions(tabId)
                    const nextTool = activeTool === tool ? null : tool
                    setActiveTool(nextTool)
                    setCommentFormOpen(nextTool === PDF_COMMENT_TOOL && selections.length > 0)
                  }}
                />
              </span>
              <TranslationPreferenceStatus showProgress={false} />
            </div>
            <div className="absolute right-[var(--vds-space-4)] top-[var(--vds-space-2)] flex items-center gap-[var(--vds-space-2)]">
              <Tooltip portalled content={translationText('settingsButton')} side="bottom">
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={translationText('settingsButton')}
                  icon={<SlidersHorizontal size={16} />}
                  data-testid="pdf-translation-settings"
                  onClick={() => appActions.openSettings('translation')}
                />
              </Tooltip>
              {excerptSource && session?.source.kind === 'project' && session.source.project ? (
                <LiteratureExcerptImport
                  documentRevision={session.revision}
                  onImported={imported}
                  projectId={session.source.project}
                  selections={excerptSelections}
                  source={excerptSource}
                />
              ) : null}
              <Tooltip portalled content={exportLabel} side="bottom">
                <IconButton
                  label={exportLabel}
                  title={undefined}
                  icon={<Icon name="upload" size={15} />}
                  size="sm"
                  variant="ghost"
                  data-testid="pdf-export"
                  disabled={!canExport || exporting}
                  onClick={() => void exportPdf()}
                />
              </Tooltip>
            </div>
            {citationPages && citationPages.length > 1 && (
              <span
                aria-label={t('citationPages')}
                className="inline-flex w-full items-center gap-1"
              >
                <span>{t('citationLabel')}</span>
                {citationPages.map((target) => (
                  <Button
                    key={target.page}
                    size="sm"
                    variant="ghost"
                    aria-label={t('viewCitation', { page: target.page })}
                    aria-pressed={currentPage === target.page}
                    onClick={() => {
                      requestFocus({ kind: 'citation', page: target.page })
                    }}
                  >
                    {t('page', { page: target.page })}
                  </Button>
                ))}
              </span>
            )}
          </div>
          {(loadError !== null || (sidecar && sidecar.source_state !== 'available')) && (
            <div
              className="px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] [overflow-wrap:anywhere]"
              role="status"
            >
              {loadError?.kind === PDF_LOAD_FAILURE_KIND.unknown
                ? t('loadFailed', { detail: loadError.detail })
                : sidecar?.source_state === 'authorization_required'
                  ? t('authorizationRequired')
                  : sidecar && sidecar.source_state !== 'available'
                    ? t('sourceUnavailable')
                    : ''}
            </div>
          )}
          <div
            className={`vds-pdf-reader relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden${isLiterature || translationBackend ? ' !flex' : ''}${sidebar ? ' !flex has-sidebar' : ''}`}
          >
            <ResizablePanelGroup
              ref={readingGroupRef}
              className={`min-h-0 min-w-0 flex-1 !rounded-none !border-0 ${analysis.expandedSelectionResult ? 'invisible' : ''}`}
              data-testid="pdf-reading-split"
              sizes={readingPanelOpen ? (readingPanelExpanded ? [0, 100] : readingSplit) : [100, 0]}
              onSizesChange={(sizes) => {
                if (readingPanelOpen && !readingPanelExpanded) {
                  readingResized.current = true
                  preserveReadingPosition()
                  setReadingSplit(sizes)
                }
              }}
            >
              <ResizablePanel
                minSize={readingPanelOpen && !readingPanelExpanded ? READING_SPLIT_MINIMUM : 0}
                maxSize={100}
                className="relative flex min-h-0 min-w-0 overflow-hidden !p-0 bg-[var(--vds-bg-gray-light-default)]"
              >
                {sidebar && (
                  <ResizablePanel
                    className="pointer-events-none! absolute inset-y-0 left-0 z-[var(--vds-z-surface-panel)] !rounded-none !border-0 [&>button]:pointer-events-auto! [&>div:first-child]:pointer-events-auto! [&>div:first-child]:overflow-hidden! [&>div:last-child]:pointer-events-none!"
                    data-testid="pdf-navigation-resizable"
                    leftPanel={
                      <aside
                        className="vds-pdf-sidebar box-border h-full w-full min-w-0 overflow-x-hidden! overflow-y-auto! p-0! bg-[var(--vds-bg-gray-light-default)]! [&_nav]:flex [&_nav]:flex-col [&_nav]:items-center [&_nav]:gap-[var(--vds-space-2)] [&_nav]:pt-[var(--vds-space-3)]"
                        aria-label={t('navigation')}
                      >
                        <Tabs
                          className="h-full min-h-0 !gap-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden [&>[role=tablist]]:!pt-[var(--vds-space-4)]"
                          value={sidebarTab}
                          onValueChange={(value) => update({ sidebarTab: value })}
                        >
                          <TabsList className="h-auto! w-full min-w-0 justify-start! gap-[var(--vds-space-1)]! rounded-none! border-b! border-solid! border-[var(--vds-divider-default)]! bg-transparent! px-[var(--vds-space-3)]! py-[var(--vds-space-2)]! [&>span[aria-hidden=true]]:hidden! [&_button[role=tab]]:!size-[var(--vds-control-height-md)] [&_button[role=tab]]:!rounded-[var(--vds-radius-4)] [&_button[role=tab]]:!p-0 [&_button[role=tab]_svg]:!size-[var(--vds-icon-7)] [&_button[role=tab]]:data-[state=active]:bg-[var(--vds-other-overlay-2)] [&_button[role=tab]]:data-[state=active]:text-[var(--vds-text-primary)]">
                            <TabsTrigger
                              value="outline"
                              aria-label={t('outlineTab')}
                              className="min-w-0 flex-none px-[var(--vds-space-2)]! whitespace-nowrap"
                            >
                              <Tooltip
                                portalled
                                content={t('outlineTab')}
                                className="flex size-full items-center justify-center"
                              >
                                <span className="inline-flex size-full items-center justify-center">
                                  <BookOpen size={14} />
                                  <span className="sr-only">{t('outlineTab')}</span>
                                </span>
                              </Tooltip>
                            </TabsTrigger>
                            <TabsTrigger
                              value="pages"
                              aria-label={t('pagesTab')}
                              className="min-w-0 flex-none px-[var(--vds-space-2)]! whitespace-nowrap"
                            >
                              <Tooltip
                                portalled
                                content={t('pagesTab')}
                                className="flex size-full items-center justify-center"
                              >
                                <span className="inline-flex size-full items-center justify-center">
                                  <SquareChartGantt size={14} />
                                  <span className="sr-only">{t('pagesTab')}</span>
                                </span>
                              </Tooltip>
                            </TabsTrigger>
                            <TabsTrigger
                              value="annotations"
                              data-testid="pdf-annotations-tab"
                              aria-label={t('pdfAnnotation.records')}
                              className="min-w-0 flex-none px-[var(--vds-space-2)]! whitespace-nowrap"
                            >
                              <Tooltip
                                portalled
                                content={t('pdfAnnotation.records')}
                                className="flex size-full items-center justify-center"
                              >
                                <span className="inline-flex size-full items-center justify-center">
                                  <NotebookPen size={14} />
                                  <span className="sr-only">{t('pdfAnnotation.records')}</span>
                                </span>
                              </Tooltip>
                            </TabsTrigger>
                            <TabsTrigger
                              value="search"
                              aria-label={t('searchTab')}
                              title={t('searchTab')}
                              className="ml-auto min-w-0 flex-none px-[var(--vds-space-2)]! whitespace-nowrap"
                            >
                              <Icon name="search" size={15} />
                              <span className="sr-only">{t('searchTab')}</span>
                            </TabsTrigger>
                          </TabsList>
                          <TabsContent
                            value="outline"
                            className="min-h-0 overflow-x-hidden overflow-y-auto !p-[var(--vds-space-3)] [&_nav]:!pt-0"
                          >
                            {!outline.length && (
                              <EmptyState
                                variant="compact"
                                title={t('noOutline')}
                                className="h-full [&>div>div]:text-[length:var(--vds-font-body-lv1)] [&>div>div]:leading-[var(--vds-lh-body-lv1)]"
                              />
                            )}
                            <PdfOutline items={outline} onNavigate={navigate} />
                          </TabsContent>
                          <TabsContent
                            value="pages"
                            className="min-h-0 overflow-x-hidden overflow-y-auto"
                          >
                            <nav aria-label={t('thumbnails')} className="!gap-[var(--vds-space-3)]">
                              {pageNumbers.map((number) => (
                                <Button
                                  key={number}
                                  variant="ghost"
                                  size="content"
                                  data-testid={`pdf-thumbnail-${number}`}
                                  aria-label={t('goToPage', { page: number })}
                                  aria-current={currentPage === number ? 'page' : undefined}
                                  onClick={() => navigate(number)}
                                >
                                  <span className="vds-pdf-thumbnail grid !gap-[var(--vds-space-2)] text-center">
                                    <span className="flex h-[var(--vds-pdf-thumbnail-height)] w-[var(--vds-pdf-thumbnail-width)] items-center justify-center overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]">
                                      <PdfPageSlot
                                        estimatedSize={estimatedPageSize}
                                        fonts={fonts}
                                        initialPage={loadedPages.get(number)}
                                        loadPage={loadPage}
                                        pageNumber={number}
                                        scale={Math.min(
                                          THUMBNAIL_WIDTH / estimatedPageSize.width,
                                          THUMBNAIL_HEIGHT / estimatedPageSize.height
                                        )}
                                        annotations={anchoredMarks.filter(
                                          (mark) => mark.page === number
                                        )}
                                        comments={sidecar?.records.comments}
                                        thumbnail
                                      />
                                    </span>
                                    <span>{number}</span>
                                  </span>
                                </Button>
                              ))}
                            </nav>
                          </TabsContent>
                          <TabsContent value="annotations" className="min-h-0 overflow-hidden">
                            <PdfAnnotations
                              onActionMenuOpen={() => setActiveMark(null)}
                              footer={documentPanels?.panels.map((panel) => (
                                <React.Fragment key={panel.id}>
                                  {panel.renderAnnotationAction?.({
                                    context: documentPanels.context,
                                    snapshot: sidecar ?? null,
                                    disabled: saving,
                                    dismissSelection: clearSelection,
                                    openPanel: () => {
                                      if (documentPanels.activePanelId !== panel.id)
                                        documentPanels.toggle(panel.id)
                                    },
                                  })}
                                </React.Fragment>
                              ))}
                              renderEditor={(mark, close, mode, inline) =>
                                renderAnnotation(mark, close, mode, inline, true)
                              }
                              comments={sidecar?.records.comments ?? []}
                              marks={anchoredMarks}
                              saving={saving}
                              onDelete={(markId) => {
                                void deleteMark(markId)
                              }}
                              onFocus={(mark) => {
                                navigate(mark.page)
                                requestFocus({ kind: 'annotation', page: mark.page, id: mark.id })
                              }}
                            />
                          </TabsContent>
                          <TabsContent
                            value="search"
                            className="min-h-0 overflow-hidden !p-[var(--vds-space-3)]"
                          >
                            <div
                              role="search"
                              className="grid h-full min-h-0 grid-rows-[auto_auto_auto_minmax(0,1fr)]"
                            >
                              <Textarea
                                className="w-full min-w-0 resize-none overflow-x-hidden"
                                ref={searchInputRef}
                                size="sm"
                                aria-label={t('searchText')}
                                placeholder={t('searchText')}
                                data-testid="pdf-search"
                                wrap="soft"
                                value={query}
                                onChange={(event) => update({ query: event.target.value })}
                              />
                              <span
                                role="status"
                                className="py-[var(--vds-space-3)] text-center text-xs text-[var(--text-3)]"
                              >
                                {query.trim()
                                  ? searching
                                    ? t('searching')
                                    : searchError !== null
                                      ? t('searchFailed', { detail: searchError })
                                      : hits.length
                                        ? t('matchCount', {
                                            current: hitIndex + 1,
                                            total: hits.length,
                                          })
                                        : ''
                                  : ''}
                              </span>
                              <div className="flex gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={!hits.length}
                                  onClick={() => searchStep(-1)}
                                >
                                  {t('previousMatch')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  data-testid="pdf-search-next"
                                  disabled={!hits.length}
                                  onClick={() => searchStep(1)}
                                >
                                  {t('nextMatch')}
                                </Button>
                              </div>
                              <nav
                                aria-label={t('searchResults')}
                                className="min-h-0 min-w-0 items-stretch! overflow-x-hidden overflow-y-auto"
                              >
                                {query.trim() &&
                                !searching &&
                                searchError === null &&
                                !hits.length ? (
                                  <EmptyState
                                    variant="compact"
                                    title={hasText ? t('noMatches') : t('noText')}
                                    className="h-full [&>div>div]:text-[length:var(--vds-font-body-lv1)] [&>div>div]:leading-[var(--vds-lh-body-lv1)]"
                                  />
                                ) : null}
                                {hits.map((hit, index) => (
                                  <Button
                                    key={`${hit.page}-${hit.ordinal}`}
                                    size="content"
                                    variant="ghost"
                                    className="w-full min-w-0 justify-start text-left whitespace-normal! [overflow-wrap:anywhere]"
                                    onClick={() => {
                                      setHitIndex(index)
                                      navigate(hit.page)
                                      requestFocus({
                                        kind: 'search',
                                        page: hit.page,
                                        ordinal: hit.ordinal,
                                      })
                                    }}
                                  >
                                    {t('page', { page: hit.page })} ·{' '}
                                    <span className="min-w-0 [overflow-wrap:anywhere]">
                                      {searchSnippet(hit.text, query)}
                                    </span>
                                  </Button>
                                ))}
                              </nav>
                            </div>
                          </TabsContent>
                        </Tabs>
                      </aside>
                    }
                    leftWidth={`${navigationWidth}px`}
                    maxLeftWidth={PDF_NAVIGATION_MAX_WIDTH_PX}
                    minLeftWidth={PDF_NAVIGATION_MIN_WIDTH_PX}
                    rightPanel={<span aria-hidden />}
                    onWidthChange={(width) => update({ navigationWidth: Number.parseFloat(width) })}
                  />
                )}
                {citationTargets.length > 1 && (
                  <div
                    data-testid="pdf-citation-navigation"
                    ref={citationNavigationRef}
                    className="pointer-events-none absolute inset-x-[var(--vds-space-4)] top-[var(--vds-space-4)] z-[var(--vds-z-local-top)] flex justify-end"
                    style={{
                      left: sidebar ? `calc(${navigationWidth}px + var(--vds-space-4))` : undefined,
                    }}
                  >
                    <FloatingToolbar
                      label={t('citationNavigation')}
                      className="pointer-events-auto max-w-full [&>[role=toolbar]]:flex-wrap [&>[role=toolbar]]:justify-center [&>[role=toolbar]]:gap-[var(--vds-space-2)]"
                      actions={
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-w-0 max-w-full"
                            aria-label={t('previousEvidence')}
                            icon={
                              <ArrowUp className="size-[var(--vds-icon-7)] text-[var(--vds-icon-outline-default)]" />
                            }
                            disabled={citationTargetIndex <= 0}
                            onClick={() => {
                              const target = citationTargets[citationTargetIndex - 1]
                              requestFocus({ kind: 'citation', ...target })
                            }}
                          >
                            <EllipsisText tooltipPortalled>{t('previousEvidence')}</EllipsisText>
                          </Button>
                          <EllipsisText
                            tooltipPortalled
                            wrapperClassName="max-w-full"
                            className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)] tabular-nums"
                          >
                            {citationTargetIndex < 0
                              ? t('evidenceCount', { total: citationTargets.length })
                              : `${citationTargetIndex + 1} / ${citationTargets.length}`}
                          </EllipsisText>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-w-0 max-w-full"
                            aria-label={t('nextEvidence')}
                            icon={
                              <ArrowDown className="size-[var(--vds-icon-7)] text-[var(--vds-icon-outline-default)]" />
                            }
                            disabled={citationTargetIndex === citationTargets.length - 1}
                            onClick={() => {
                              const target = citationTargets[citationTargetIndex + 1]
                              requestFocus({ kind: 'citation', ...target })
                            }}
                          >
                            <EllipsisText tooltipPortalled>{t('nextEvidence')}</EllipsisText>
                          </Button>
                        </>
                      }
                    />
                  </div>
                )}
                <div
                  ref={viewportRef}
                  data-ob="pdf-viewport"
                  className={`vds-pdf-pages min-h-0 min-w-0 flex-1 overflow-auto bg-transparent px-[var(--vds-space-4)] pt-[var(--vds-space-4)] pb-[var(--vds-pdf-reading-bottom-inset)] [overflow-anchor:none] [scrollbar-gutter:stable_both-edges]${analysis.figure ? ' cursor-crosshair' : ''}`}
                  style={{
                    marginLeft: sidebar ? `${navigationWidth}px` : undefined,
                    paddingTop: citationNavigationHeight
                      ? `calc(${citationNavigationHeight}px + var(--vds-space-4) * 2)`
                      : undefined,
                  }}
                  onScroll={onScroll}
                  onMouseUp={() => {
                    if (!analysis.figure) {
                      captureSelection(true)
                      setSelectionDragSpan(null)
                    }
                  }}
                  onKeyUp={() => captureSelection()}
                  onPointerDownCapture={(event) => {
                    const element = (event.target as HTMLElement).closest<HTMLElement>(
                      '.vds-pdf-page'
                    )
                    if (!analysis.figure) {
                      const page = element ? Number(element.dataset.page) : null
                      setSelectionDragSpan(page ? { anchor: page, focus: page } : null)
                      return
                    }
                    if (!element) return
                    event.preventDefault()
                    event.stopPropagation()
                    analysis.setFigureGuideOpen(false)
                    cropStart.current = {
                      x: event.clientX,
                      y: event.clientY,
                      bounds: element.getBoundingClientRect(),
                      page: Number(element.dataset.page),
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerMove={(event) => {
                    if (!analysis.figure) {
                      const element = (event.target as HTMLElement).closest<HTMLElement>(
                        '.vds-pdf-page'
                      )
                      const page = element ? Number(element.dataset.page) : null
                      if (page)
                        setSelectionDragSpan((current) =>
                          current && current.focus !== page ? { ...current, focus: page } : current
                        )
                      return
                    }
                    const start = cropStart.current
                    if (!start) return
                    const x = Math.max(
                        start.bounds.left,
                        Math.min(start.bounds.right, event.clientX)
                      ),
                      y = Math.max(start.bounds.top, Math.min(start.bounds.bottom, event.clientY))
                    setCropBox({
                      left: Math.min(x, start.x),
                      top: Math.min(y, start.y),
                      width: Math.abs(x - start.x),
                      height: Math.abs(y - start.y),
                    })
                  }}
                  onPointerUp={(event) => {
                    const start = cropStart.current
                    if (!start) return
                    event.preventDefault()
                    cropStart.current = undefined
                    if (
                      cropBox &&
                      cropBox.width >= MIN_FIGURE_SELECTION_PX &&
                      cropBox.height >= MIN_FIGURE_SELECTION_PX
                    )
                      analysis.selectFigure(start.page, [
                        (cropBox.left - start.bounds.left) / start.bounds.width,
                        (cropBox.top - start.bounds.top) / start.bounds.height,
                        cropBox.width / start.bounds.width,
                        cropBox.height / start.bounds.height,
                      ])
                    setCropBox(null)
                  }}
                  onPointerCancel={() => setSelectionDragSpan(null)}
                >
                  <div
                    data-testid="pdf-pages-track"
                    className={`box-border min-h-full${rightPanelOpen && !readingPanelOpen ? ' min-w-[calc(100%+var(--vds-layout-pdf-panel-width))] pr-[var(--vds-layout-pdf-panel-width)]' : ' min-w-full'}`}
                  >
                    {!pageCount && loadError === null && (
                      <div className="px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] [overflow-wrap:anywhere]">
                        {t('loading')}
                      </div>
                    )}
                    {pageNumbers.map((number) => {
                      const loadedPage = loadedPages.get(number)
                      const sourcePage = (
                        <PdfPageSlot
                          estimatedSize={estimatedPageSize}
                          fonts={fonts}
                          initialPage={loadedPage}
                          onCommentRail={handleCommentRail}
                          key={number}
                          loadPage={loadPage}
                          pageNumber={number}
                          scale={scale}
                          keepRendered={
                            selectionDragSpan !== null &&
                            pageInSelectionSpan(
                              number,
                              selectionDragSpan.anchor,
                              selectionDragSpan.focus
                            )
                          }
                          search={query}
                          focus={
                            focus?.page === number &&
                            (focus.kind !== 'citation' ||
                              citationPages?.some((target) => target.page === number))
                              ? focus
                              : undefined
                          }
                          annotations={anchoredMarks.filter((mark) => mark.page === number)}
                          selectionQuads={
                            workspace.selectionPresentations[tabId] &&
                            session?.selection?.locator.kind === 'pdf'
                              ? selections.find((selection) => selection.page === number)?.quads
                              : undefined
                          }
                          citationQuads={citationPages?.find((item) => item.page === number)?.quads}
                          flashCitation={Boolean(selectionTarget)}
                          visualRegionImageInputAvailable={analysis.visualRegionImageInputAvailable}
                          copyingVisualRegionId={analysis.copyingFormulaRegionId}
                          comments={sidecar?.records.comments}
                          hideCommentPins={analysis.translationOpen}
                          onAnnotationOpen={(mark) => {
                            dismissSelectionActions(tabId)
                            controller.setSelection(tabId, null)
                            setCommentFormOpen(false)
                            setSelections(
                              mark.style === 'comment'
                                ? []
                                : [{ page: mark.page, text: mark.text, quads: mark.quads }]
                            )
                            setActiveMark(mark.id)
                            if (mark.style !== 'comment')
                              setMarkColors((previous) => ({
                                ...previous,
                                [mark.style]: mark.color,
                              }))
                          }}
                          onInternalLink={navigateInternalLink}
                          onVisualRegionExplain={analysis.explainRegion}
                          onVisualRegionCopy={(region) => {
                            void copyVisualRegion(region)
                          }}
                          renderAnnotation={renderAnnotation}
                          expandedAnnotationResultId={analysis.expandedAnnotationResultId}
                          pointCommentEnabled={
                            !analysis.translationOpen &&
                            activeTool === PDF_COMMENT_TOOL &&
                            Boolean(session?.capabilities.can_annotate)
                          }
                          renderPointComment={(point, close) => (
                            <PdfCommentDraft
                              page={number}
                              point={point}
                              saving={saving}
                              onCancel={close}
                              onSave={(body) => addPointComment(number, point, body)}
                            />
                          )}
                        />
                      )
                      return analysis.translationOpen ? (
                        <div
                          className="relative mx-auto mb-[var(--vds-space-4)] grid w-max items-start shadow-[var(--vds-shadow-2-center)] before:pointer-events-none before:absolute before:inset-y-0 before:left-[var(--pdf-source-page-width)] before:z-[var(--vds-z-content)] before:w-[var(--vds-border-width-1)] before:bg-[var(--vds-border-default)] before:content-[''] [&>.vds-pdf-page-frame]:m-0 [&_.vds-pdf-page]:![box-shadow:none]"
                          data-page-pair={number}
                          data-testid={`pdf-page-pair-${number}`}
                          key={number}
                          style={
                            {
                              '--pdf-source-page-width': `${translationSourceWidth * scale}px`,
                              gridTemplateColumns: `var(--pdf-source-page-width) ${translationSourceWidth * scale * translationRatio}px`,
                            } as React.CSSProperties
                          }
                        >
                          {sourcePage}
                          <ResizableHandle
                            aria-label={t('reading.resizeTranslation')}
                            aria-valuemin={PDF_TRANSLATION_MIN_RATIO * PERCENTAGE_TOTAL}
                            aria-valuemax={PDF_TRANSLATION_MAX_RATIO * PERCENTAGE_TOTAL}
                            aria-valuenow={Math.round(translationRatio * PERCENTAGE_TOTAL)}
                            className="!absolute inset-y-0 left-[var(--pdf-source-page-width)] z-[var(--vds-z-local-control)] !h-auto !w-[var(--vds-space-2)] -translate-x-1/2 bg-transparent! before:invisible hover:before:visible focus-visible:before:visible data-[resizing=true]:before:visible"
                            data-testid={`pdf-translation-resize-${number}`}
                            onResizeStart={() => {
                              translationResize.current = {
                                page: translationSourceSize,
                                viewport: fitViewport,
                                mode,
                                ratio: translationRatio,
                                scale,
                              }
                            }}
                            onOffsetChange={(offset) => {
                              const initial = translationResize.current
                              if (!initial) return
                              const next = resizePdfTranslation(initial, offset)
                              update({
                                [PDF_TRANSLATION_WIDTH_STATE_KEY]: next.ratio,
                                ...(initial.mode === 'custom' ? { scale: next.scale } : {}),
                              })
                            }}
                            onResizeEnd={() => {
                              translationResize.current = null
                            }}
                          />
                          {analysis.translationPage(
                            number,
                            {
                              width: translationSourceWidth * scale * translationRatio,
                              height:
                                loadedPage?.getViewport({ scale }).height ??
                                estimatedPageSize.height * scale,
                            },
                            1
                          )}
                        </div>
                      ) : (
                        sourcePage
                      )
                    })}
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle
                aria-label={t('reading.resize')}
                className={
                  readingPanelOpen && !readingPanelExpanded
                    ? '[&:not(:hover):not(:focus-visible):not([data-resizing=true])]:!bg-transparent [&:not(:hover):not(:focus-visible):not([data-resizing=true])]:[background:linear-gradient(var(--vds-border-default),var(--vds-border-default))_center/var(--vds-border-width-1)_100%_no-repeat]'
                    : 'hidden'
                }
              />
              <ResizablePanel
                minSize={readingPanelOpen && !readingPanelExpanded ? readingPanelMinimum : 0}
                maxSize={100}
                className="min-h-0 min-w-0 overflow-hidden !p-0"
              >
                {resizableDocumentPanel ? documentPanelContent : analysis.sidePanel}
              </ResizablePanel>
            </ResizablePanelGroup>
            {!resizableDocumentPanel ? documentPanelContent : null}
            {(isLiterature || translationBackend) && (
              <nav
                aria-label={t('pdfToolbar.toolbar')}
                data-ob="pdf-tools"
                className={`flex w-[var(--vds-layout-pdf-rail-width)] flex-none flex-col items-center gap-[var(--vds-space-2)] border-l border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-light-default)] px-[var(--vds-space-4)] py-[var(--vds-space-4)] [&_button]:!size-[var(--vds-control-height-md)] [&_button]:!shrink-0 [&_button]:!p-0 ${analysis.expandedSelectionResult ? 'invisible' : ''}`}
              >
                {documentPanelActions('start')}
                {analysis.railActions}
                {documentPanelActions('end')}
              </nav>
            )}
            {analysis.expandedSelectionResult && (
              <div
                data-testid="pdf-selection-result-expanded"
                className="absolute inset-0 z-[var(--vds-z-surface-panel)] flex min-h-0 flex-col bg-[var(--vds-bg-white-default)]"
              >
                {analysis.expandedSelectionResult}
              </div>
            )}
          </div>
        </>
      )}
      <Dialog open={goToPageOpen} onOpenChange={setGoToPageOpen}>
        <DialogContent data-testid="pdf-go-to-page-dialog">
          <DialogHeader>
            <DialogTitle>{t('goToPageDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('goToPageDialog.description', { count: pageCount })}
            </DialogDescription>
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
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canGoToPage) goToPage()
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setGoToPageOpen(false)}>
              {t('goToPageDialog.cancel')}
            </Button>
            <Button disabled={!canGoToPage} onClick={goToPage}>
              {t('goToPageDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
