import { selectionInstruction, type SelectionPromptAction } from '../../../../../prompts'
import React, { useCallback, useEffect, useRef, useState } from 'react'

import { useTranslation } from 'react-i18next'
import sproutIcon from '../../../assets/sprout.png'
import {
  Check,
  Copy,
  Globe,
  Languages,
  Maximize2,
  MessageCircleMore,
  MessageCirclePlus,
  MessageSquareText,
  Minimize2,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react'
import {
  BadgeDot,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CopyButton,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Skeleton,
  Spinner,
  Switch,
  Tooltip,
  useToast,
} from '../../../components/ui'
import { FloatingWindow } from '../../../components/primitive/FloatingWindow'
import { Markdown } from '../../../components/primitive/Markdown'
import { writeClipboard } from '../../../components/primitive/clipboard'
import { ModelMenu } from '../../../components/business/ModelMenu'
import { PromptSettingsGuide } from '../../../components/business/PromptSettingsGuide'
import { Icon } from '../../../icons'
import { focusComposer } from '../../../reference'
import { useApp } from '../../../store'
import { PdfExplanation } from './Explanation'
import { catalogue } from '../../literature/catalog'
import { useTranslationBackend } from '../../translation/context'
import { translationError } from '../../translation/live'
import { TranslationControls } from '../../translation/Controls'
import { useTranslationText } from '../../translation/text'
import { useTranslationNotice } from '../../translation/Notice'
import {
  AI_ENGINE_PREFIX,
  automaticSelection,
  translationAllowed,
  translationChoice,
  translationDirty,
  translationModelKey,
  type TranslationChoice,
} from '../../translation/model'
import { requestModelKey, selectableActionModelKey } from '../../../catalog'
import type { ModelInfo } from '../../../api'
import { dismissSelectionActions, useSelectionActionContribution } from '../actions'
import { documentSelectionInteractionProps } from '../focus'
import { evidencePages } from './evidence'
import { Reading as PaperReading } from '../../../components/business/Reading'
import type { ReadingEvidence } from '../../../contracts/literature'
import { Crop } from './Crop'
import { replaceSubmission } from './submissions'
import {
  selectionResultForSnapshot,
  selectionSnapshotCurrent,
  translationSnapshot,
  type SelectionTranslationSnapshot,
} from './selection'
import { Language, Translation } from './Translation'
import {
  defaultTranslationTarget,
  readTranslationTarget,
  writeTranslationTarget,
} from '../../../components/business/Language'
import {
  PDF_AI_IMAGE_INPUT_UNSUPPORTED,
  PDF_AI_MODEL_UNAVAILABLE,
  PDF_AI_TASK_UNRESOLVED,
  pdfAiCaughtFailure,
  pdfAiFailure,
  pdfAiFailureRecovery,
  pdfAiFailureText,
  type PdfAiFailure,
} from '../../../components/business/diagnostic'
import { mergeTranslationResult, nextTranslationPage, translationResultForTarget } from './sequence'
import { PdfPanel } from './Panel'
import type { PdfSelection, TranslationDirection, TranslationSentence } from './analysis'
import {
  PDF_AI_PREFIX,
  PDF_AI_INVALID_RESPONSE,
  cancelPdfAiTask,
  invokeFigure,
  pdfAiApi,
  pdfAiTaskFinished,
  pdfResponseLanguage,
  pdfSelectionRefreshPending,
  recoverPdfAiTask,
  submitPdfAiTask,
  type PdfAction,
  type PdfAiContent,
  type PdfAiRequest,
  type PdfCitationSource,
  type PdfAiResult,
  type PdfAiTask,
  type PdfVisualRegion,
} from './analysis'
import { matchReadingText, type Size } from './geometry'
import { visualRegionRect } from './regions'
import {
  LITERATURE_AI_MODEL_ACTIONS,
  type LiteratureAiModelAction,
} from '../../../../../preferences'

const SELECTION_PROMPTS: Partial<Record<PdfAction, SelectionPromptAction>> = {
  selection_translation: 'translate',
  selection_explanation: 'explain',
  figure_explanation: 'figure',
}
const REPLACEABLE_ACTIONS = new Set<PdfAction>([
  'document_translation',
  'selection_translation',
  'selection_explanation',
  'figure_explanation',
  'formula_latex',
])
const SELECTION_ACTIONS = new Set<PdfAction>(['selection_translation', 'selection_explanation'])
const IMAGE_INPUT_ACTIONS = new Set<PdfAction>(['figure_explanation', 'formula_latex'])
const FIGURE_WINDOW_SIZE = { width: 520, height: 600 }
const AUTOMATIC_SELECTION_DELAY_MS = 350
const SELECTION_COPY_FEEDBACK_DURATION_MS = 3_000
const FIGURE_GUIDE_SOURCE_WIDTH_PX = 700
const FIGURE_GUIDE_SCALE = 4 / 7
const FIGURE_GUIDE_WIDTH_PX = FIGURE_GUIDE_SOURCE_WIDTH_PX * FIGURE_GUIDE_SCALE
const FIGURE_GUIDE_VIEWPORT_GUTTER_PX = 32
const LITERATURE_MODEL_ACTIONS = new Set<PdfAction>(LITERATURE_AI_MODEL_ACTIONS)
const MULTIMODAL_MODEL_FILTER = (model: ModelInfo): boolean => model.image_input === true
interface Job {
  task?: PdfAiTask
  pending?: boolean
  error?: PdfAiFailure
  failed?: boolean
}
interface FigureRegion {
  page: number
  rect: number[]
}
const jobBusy = (job?: Job): boolean =>
  Boolean(
    job?.pending ||
    job?.task?.status === 'pending' ||
    job?.task?.status === 'running' ||
    job?.task?.status === 'unknown'
  )
const PDF_AUTOMATIC_TRANSLATION_PREFERENCE = 'scholarseed.pdf.automaticTranslation'

function FigureGuide({ t }: { t: (key: string) => string }): React.JSX.Element {
  return (
    <div className="grid items-center" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
      <div className="flex flex-col items-center gap-[var(--vds-space-3)] pr-[var(--vds-space-6)]">
        <svg aria-hidden="true" height="190" viewBox="0 0 240 240" width="190">
          <rect
            x="20"
            y="16"
            width="196"
            height="190"
            fill="none"
            stroke="var(--vds-text-tertiary)"
            strokeDasharray="7 7"
            strokeWidth="2"
          />
          <g fill="var(--vds-text-tertiary)">
            <rect x="14" y="10" width="12" height="12" />
            <rect x="210" y="10" width="12" height="12" />
            <rect x="14" y="200" width="12" height="12" />
            <rect x="210" y="200" width="12" height="12" />
          </g>
          <path d="M44 36V132H194" fill="none" stroke="var(--vds-text-tertiary)" strokeWidth="3" />
          <g fill="var(--vds-text-tertiary)" opacity=".42">
            <rect x="58" y="96" width="24" height="36" />
            <rect x="92" y="78" width="24" height="54" />
            <rect x="126" y="58" width="24" height="74" />
            <rect x="160" y="36" width="24" height="96" />
          </g>
          <g fill="var(--vds-border-default)">
            <rect x="44" y="150" width="142" height="8" rx="4" />
            <rect x="44" y="166" width="142" height="8" rx="4" />
            <rect x="44" y="182" width="104" height="8" rx="4" />
          </g>
          <path
            d="M178 168L190 224L202 207L220 223L230 212L212 196L230 184L178 168Z"
            fill="var(--vds-bg-white-default)"
            stroke="var(--vds-text-tertiary)"
            strokeLinejoin="round"
            strokeWidth="4"
          />
        </svg>
        <span className="text-[length:var(--vds-font-subhead)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-secondary)]">
          {t('reading.figureGuide.caption')}
        </span>
      </div>
      <div className="min-w-0 border-l border-[var(--vds-border-default)] pl-[var(--vds-space-6)]">
        <h3 className="m-0 text-[length:var(--vds-font-display-lv2)] font-[var(--vds-fw-semibold)] leading-[var(--vds-pdf-reading-header-line-height)]">
          {t('reading.figureGuide.title')}
        </h3>
        <p className="mb-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
          {t('reading.figureGuide.description')}
        </p>
        <h4 className="mb-[var(--vds-space-3)] mt-[var(--vds-space-5)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-subhead)]">
          {t('reading.figureGuide.method')}
        </h4>
        <ol className="m-0 grid list-none gap-[var(--vds-space-2)] p-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-secondary)]">
          {[
            t('reading.figureGuide.step1'),
            t('reading.figureGuide.step2'),
            t('reading.figureGuide.step3'),
          ].map((step, index) => (
            <li
              key={step}
              className="grid items-start gap-[var(--vds-space-2)]"
              style={{ gridTemplateColumns: '28px minmax(0, 1fr)' }}
            >
              <span className="flex h-[var(--vds-space-7)] w-[var(--vds-space-7)] items-center justify-center rounded-full bg-[var(--vds-surface-muted)] font-[var(--vds-fw-medium)] text-[var(--vds-brand-text-primary)]">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="mb-0 mt-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]">
          {t('reading.figureGuide.exit')}
        </p>
      </div>
    </div>
  )
}

export function usePdfAnalysis({
  active,
  artifact,
  citation,
  literatureId,
  literatureTitle,
  attachmentId,
  title,
  path,
  assetId,
  projectId,
  revision,
  tabId,
  page,
  pageCount,
  documentText,
  selection,
  canAnnotate,
  onAddComment,
  onNavigate,
  onLocate,
  onDocumentTranslationChange,
  onExclusiveSurfaceOpen,
  onReadingOpen,
  onReadingLayoutChange,
  viewportRef,
}: {
  active: boolean
  artifact?: PdfAiRequest['artifact']
  citation?: PdfCitationSource
  literatureId: string
  literatureTitle: string
  attachmentId: string
  title: string
  path: string
  assetId: string
  projectId: string
  revision: string
  tabId: string
  page: number
  pageCount: number
  documentText: string
  selection: PdfSelection[]
  canAnnotate: boolean
  onAddComment: (selection: PdfSelection, body: string) => Promise<boolean>
  onNavigate: (page: number) => void
  onLocate: (page: number, text: string, quads?: number[][]) => void
  onReadingOpen: () => void
  onReadingLayoutChange: () => void
  onDocumentTranslationChange: (open: boolean) => void
  onExclusiveSurfaceOpen: () => void
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  const { state, act: actions } = useApp()
  const { backend: translationBackend, settings: translationSettings } = useTranslationBackend()
  const translationText = useTranslationText()
  const translationNotice = useTranslationNotice()
  const translationDocument = JSON.stringify([
    ...(artifact ? [artifact] : []),
    ...(citation ? [citation] : []),
    literatureId,
    attachmentId,
    projectId,
    assetId || path,
  ])
  const [appliedTranslations, setAppliedTranslations] = useState<
    Partial<Record<PdfAction, TranslationChoice>>
  >({})
  const requestedChoices = useRef<Partial<Record<PdfAction, TranslationChoice>>>({})
  const serviceControllers = useRef<Partial<Record<PdfAction, AbortController>>>({})
  const serviceSelections = useRef<PdfSelection[]>([])
  const selectionTranslation = useRef<SelectionTranslationSnapshot | undefined>(undefined)
  const currentSelectionIdentity = useRef('')
  const choiceFor = (kind: PdfAction): TranslationChoice =>
    translationChoice(
      translationSettings!,
      translationDocument,
      kind === 'document_translation' ? 'document' : 'selection',
      defaultTranslationTarget(
        state.lang,
        kind === 'document_translation'
          ? documentText
          : selection.map((item) => item.text).join('\n')
      )
    )
  const { toast } = useToast()
  const { t, i18n } = useTranslation(['pdf', 'ui'])
  const LABELS: Record<PdfAction, string> = {
    document_translation: t('reading.actions.document_translation'),
    interpretation: t('reading.actions.interpretation'),
    selection_translation: t('reading.actions.selection_translation'),
    selection_explanation: t('reading.actions.selection_explanation'),
    figure_explanation: t('reading.actions.figure_explanation'),
    formula_latex: t('visualRegions.copyFormula'),
  }
  const [panel, setPanel] = useState<PdfAction | null>(null)
  const [panelExpanded, setPanelExpanded] = useState(false)
  const preparingChat = useRef(false)
  const [floating, setFloating] = useState<PdfAction | null>(null)
  const [selectionResultExpanded, setSelectionResultExpanded] = useState(false)
  const [selectionResultMark, setSelectionResultMark] = useState<string | null>(null)
  const restoreResultFocus = useRef(false)
  const focusResultSizeButton = useCallback((button: HTMLButtonElement | null) => {
    if (!button || !restoreResultFocus.current) return
    restoreResultFocus.current = false
    button.focus()
  }, [])
  const selectionResultOpen = Boolean(floating && SELECTION_ACTIONS.has(floating))
  const selectionResultFillsReader = active && selectionResultOpen && selectionResultExpanded
  useEffect(() => {
    if (!selectionResultOpen) setSelectionResultExpanded(false)
  }, [selectionResultOpen])
  const [selectionExplanationOpen, setSelectionExplanationOpen] = useState(false)
  const [selectionExplanationDraft, setSelectionExplanationDraft] = useState('')
  const [selectionExplanationSnapshot, setSelectionExplanationSnapshot] = useState<PdfSelection[]>(
    []
  )
  const [annotating, setAnnotating] = useState(false)
  const [annotatedResult, setAnnotatedResult] = useState('')
  const [figure, setFigure] = useState(false)
  const [figureGuideOpen, setFigureGuideOpen] = useState(false)
  const exitFigureSelection = useCallback((): void => {
    setFigure(false)
    setFigureGuideOpen(false)
  }, [])
  const figureAbort = useRef<AbortController | null>(null)
  const lastFigureRegion = useRef<FigureRegion | null>(null)
  const [figureText, setFigureText] = useState('')
  const [automaticTranslation, setAutomaticTranslation] = useState(false)
  const automaticTranslationRequest = useRef(false)
  const [translationMenuOpen, setTranslationMenuOpen] = useState(false)
  const [hiddenTranslationPages, setHiddenTranslationPages] = useState<ReadonlySet<number>>(
    () => new Set()
  )
  const [translationAnchorPage, setTranslationAnchorPage] = useState(page)
  const [requestedTranslationPage, setRequestedTranslationPage] = useState<number | null>(null)
  const [directions, setDirections] = useState<Partial<Record<PdfAction, TranslationDirection>>>(
    () => ({
      document_translation: readTranslationTarget('literature-document'),
      selection_translation: readTranslationTarget('literature-selection'),
    })
  )
  const [activeSentence, setActiveSentence] = useState('')
  const [collapsedSections, setCollapsedSections] = useState<
    Record<number, Record<string, boolean>>
  >({})
  const [results, setResults] = useState<Record<string, PdfAiResult>>({})
  const [jobs, setJobs] = useState<Partial<Record<PdfAction, Job>>>({})
  useEffect(
    () => onDocumentTranslationChange(panel === 'document_translation'),
    [onDocumentTranslationChange, panel]
  )
  const jobsRef = useRef(jobs)
  const updateJob = (kind: PdfAction, change: Partial<Job>): void => {
    jobsRef.current = { ...jobsRef.current, [kind]: { ...jobsRef.current[kind], ...change } }
    setJobs(jobsRef.current)
  }
  const [notice, setNotice] = useState(false)
  const [cropPreview, setCropPreview] = useState('')
  const requests = useRef<Partial<Record<PdfAction, PdfAiRequest>>>({})
  const submissions = useRef<Partial<Record<PdfAction, Promise<PdfAiTask | undefined>>>>({})
  const submissionControllers = useRef<Partial<Record<PdfAction, AbortController>>>({})
  const subscriptionControllers = useRef<Partial<Record<PdfAction, AbortController>>>({})
  const recoveryBudgets = useRef(new Map<string, { attempts: number; reconnecting: boolean }>())
  const stopJob = (kind: PdfAction, cancelRemote = true): void => {
    serviceControllers.current[kind]?.abort()
    delete serviceControllers.current[kind]
    submissionControllers.current[kind]?.abort()
    subscriptionControllers.current[kind]?.abort()
    const task = jobsRef.current[kind]?.task
    const taskId = task?.task_id || requests.current[kind]?.client_attempt_id
    if (
      cancelRemote &&
      kind !== 'figure_explanation' &&
      taskId &&
      task?.status !== 'completed' &&
      task?.status !== 'cancelled'
    ) {
      void cancelPdfAiTask(taskId).catch((cause) =>
        console.warn('PDF task cancellation unresolved', cause)
      )
    }
    delete requests.current[kind]
  }
  const lastRequest = { current: floating ? requests.current[floating] : undefined }
  const isBusy = (kind: PdfAction): boolean => jobBusy(jobsRef.current[kind])
  const busy = floating ? isBusy(floating) : false
  useEffect(() => {
    if (state.pdfSelectionToolbarEnabled === false && floating && SELECTION_ACTIONS.has(floating)) {
      setFloating(null)
      setSelectionExplanationOpen(false)
    }
  }, [state.pdfSelectionToolbarEnabled, floating])
  const assistantModelKey = requestModelKey(
    state.catalog.models,
    state.model,
    state.activeSession,
    state.threads
  )
  const actionModelKey = (kind: PdfAction): string => {
    const preferenceAction = kind === 'formula_latex' ? 'figure_explanation' : kind
    const preferred = LITERATURE_MODEL_ACTIONS.has(preferenceAction)
      ? state.literatureAiModels[preferenceAction as keyof typeof state.literatureAiModels] || ''
      : ''
    const models =
      preferenceAction === 'figure_explanation'
        ? state.catalog.models.filter(MULTIMODAL_MODEL_FILTER)
        : state.catalog.models
    return selectableActionModelKey(preferred, models, assistantModelKey)
  }
  const figureModel = state.catalog.models.find(
    (model) => model.key === actionModelKey('figure_explanation')
  )
  const figureModelSupportsImageInput = Boolean(
    figureModel && !figureModel.disabled && figureModel.image_input === true
  )
  const responseLanguage = pdfResponseLanguage(i18n.resolvedLanguage || i18n.language)
  const identity = JSON.stringify([
    ...(artifact ? [artifact] : []),
    ...(citation ? [citation] : []),
    literatureId,
    attachmentId,
    projectId,
    assetId,
    path,
    revision,
  ])
  const selectionIdentity = JSON.stringify(selection)
  if (selection.length) currentSelectionIdentity.current = selectionIdentity
  const currentIdentity = useRef(identity)
  const loadSequence = useRef(0)
  const receivedTerminals = useRef<Partial<Record<PdfAction, string>>>({})
  currentIdentity.current = identity
  const load = async (): Promise<void> => {
    if (!literatureId) return
    const sequence = ++loadSequence.current
    const data = await pdfAiApi<Record<string, PdfAiResult>>(
      `/api/literature/${encodeURIComponent(literatureId)}/ai/results?source_revision=${encodeURIComponent(revision)}`
    )
    if (currentIdentity.current === identity && sequence === loadSequence.current) {
      const { selection_translation: historical, ...documentResults } = data
      setResults((previous) => {
        const snapshot = selectionTranslation.current
        const selected = selectionSnapshotCurrent(
          snapshot,
          identity,
          currentSelectionIdentity.current
        )
          ? (selectionResultForSnapshot(historical, snapshot) ??
            selectionResultForSnapshot(previous.selection_translation, snapshot))
          : undefined
        return { ...documentResults, ...(selected ? { selection_translation: selected } : {}) }
      })
    }
  }
  useEffect(() => {
    figureAbort.current?.abort()
    Object.values(serviceControllers.current).forEach((controller) => controller?.abort())
    setAppliedTranslations({})
    setCollapsedSections({})
    requestedChoices.current = {}
    serviceSelections.current = []
    selectionTranslation.current = undefined
    for (const kind of Object.keys(requests.current) as PdfAction[]) stopJob(kind)
    figureAbort.current = null
    receivedTerminals.current = {}
    recoveryBudgets.current.clear()
    setResults({})
    jobsRef.current = {}
    setJobs({})
    requests.current = {}
    submissions.current = {}
    lastFigureRegion.current = null
    setCropPreview('')
    setFigureText('')
    setFigure(false)
    setFigureGuideOpen(false)
    setFloating(null)
    setSelectionResultMark(null)
    setSelectionExplanationOpen(false)
    setSelectionExplanationDraft('')
    setSelectionExplanationSnapshot([])
    setAnnotatedResult('')
    setAutomaticTranslation(false)
    setTranslationMenuOpen(false)
    setHiddenTranslationPages(new Set())
    setTranslationAnchorPage(page)
    setRequestedTranslationPage(null)
    setPanel(null)
    setPanelExpanded(false)
    return () => {
      figureAbort.current?.abort()
      Object.values(serviceControllers.current).forEach((controller) => controller?.abort())
      for (const kind of Object.keys(requests.current) as PdfAction[]) stopJob(kind)
    }
  }, [identity])
  useEffect(() => {
    if (selection.length) {
      if (
        selectionTranslation.current &&
        !selectionSnapshotCurrent(selectionTranslation.current, identity, selectionIdentity)
      ) {
        stopJob('selection_translation')
        selectionTranslation.current = undefined
        updateJob('selection_translation', {
          task: undefined,
          pending: false,
          failed: false,
          error: undefined,
        })
        setAppliedTranslations((previous) => {
          const { selection_translation: _stale, ...remaining } = previous
          return remaining
        })
      }
      setSelectionResultMark(null)
      setFloating((current) => (current && SELECTION_ACTIONS.has(current) ? null : current))
      setResults((previous) => {
        const {
          selection_translation: _translation,
          selection_explanation: _explanation,
          ...remaining
        } = previous
        return remaining
      })
    }
    setSelectionExplanationOpen(false)
    setSelectionExplanationDraft('')
    setSelectionExplanationSnapshot([])
  }, [identity, selectionIdentity, selection.length])
  useEffect(() => {
    if (active) void load().catch(() => {})
  }, [active, identity])
  const taskSubscriptionKey = JSON.stringify(
    Object.entries(jobs).map(([kind, job]) => [kind, job.task?.task_id])
  )
  useEffect(() => {
    if (!active) return undefined
    const controllers: AbortController[] = []
    for (const [action, job] of Object.entries(jobsRef.current)) {
      const taskId = job.task?.task_id
      if (!taskId) continue
      const kind = action as PdfAction
      if (receivedTerminals.current[kind] === taskId) continue
      if (job.failed || job.task?.status === 'cancelled') continue
      const recovery = recoveryBudgets.current.get(taskId) ?? { attempts: 0, reconnecting: false }
      recoveryBudgets.current.set(taskId, recovery)
      const controller = new AbortController()
      const selectionSnapshot =
        kind === 'selection_translation' ? selectionTranslation.current : undefined
      const requestedChoice =
        kind === 'selection_translation'
          ? selectionSnapshot?.choice
          : requestedChoices.current[kind]
      controllers.push(controller)
      subscriptionControllers.current[kind] = controller
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        currentIdentity.current === identity &&
        jobsRef.current[kind]?.task?.task_id === taskId &&
        (kind !== 'selection_translation' ||
          (selectionTranslation.current === selectionSnapshot &&
            selectionSnapshotCurrent(
              selectionSnapshot,
              identity,
              currentSelectionIdentity.current
            )))
      void recoverPdfAiTask(
        taskId,
        controller.signal,
        (next) => {
          if (!isCurrent()) return
          if (jobsRef.current[kind]?.task?.status === 'cancelled' && !pdfAiTaskFinished(next))
            return
          if (pdfAiTaskFinished(next)) receivedTerminals.current[kind] = taskId
          if (next.status === 'completed' && next.result) {
            if (
              kind === 'selection_translation' &&
              !selectionResultForSnapshot(next.result, selectionSnapshot)
            ) {
              updateJob(kind, {
                task: { ...next, status: 'failed', result: undefined },
                error: {
                  code: PDF_AI_INVALID_RESPONSE,
                  diagnostic: 'selection_translation_result_identity_mismatch',
                },
                failed: true,
              })
              return
            }
            if (kind === 'document_translation') {
              setResults((previous) => ({
                ...previous,
                document_translation:
                  requestedChoice && translationDirty(requestedChoice, appliedTranslations[kind])
                    ? next.result!
                    : mergeTranslationResult(previous.document_translation, next.result!),
              }))
            } else if (kind === 'interpretation' && next.result.modules) {
              const modules = Object.fromEntries(
                Object.entries(next.result.modules).map(([module, content]) => [
                  module,
                  { ...next.result!, content },
                ])
              )
              setResults((previous) => ({ ...previous, ...modules }))
            } else {
              if (kind === 'figure_explanation') setCropPreview('')
              setResults((previous) => ({ ...previous, [kind]: next.result! }))
            }
            if (requestedChoice)
              setAppliedTranslations((previous) => ({ ...previous, [kind]: requestedChoice }))
          }
          updateJob(kind, {
            task: next,
            error: pdfAiFailure(next),
            failed: next.status === 'failed',
          })
        },
        undefined,
        recovery
      ).catch((cause) => {
        if (isCurrent())
          updateJob(kind, {
            task: { task_id: taskId, status: 'failed' },
            error: pdfAiCaughtFailure(cause),
            failed: true,
          })
      })
    }
    return () => controllers.forEach((controller) => controller.abort())
  }, [active, identity, taskSubscriptionKey])

  const run = async (
    kind: PdfAction,
    module = 'summary',
    region?: { page: number; rect?: number[]; region_id?: string; kind?: PdfVisualRegion['kind'] },
    retry?: PdfAiRequest,
    language = directions[kind] ??
      defaultTranslationTarget(
        i18n.resolvedLanguage || i18n.language,
        kind === 'document_translation'
          ? documentText
          : selection.map((value) => value.text).join('\n')
      ),
    requestedPage?: number,
    selected = selection,
    instruction?: string
  ): Promise<void> => {
    if (kind === 'selection_translation' && retry) selected = serviceSelections.current
    selected = selected.map((item) => ({ ...item, quads: item.quads.map((quad) => [...quad]) }))
    const translationAction = kind === 'document_translation' || kind === 'selection_translation'
    const newTranslationSelection =
      kind === 'selection_translation' &&
      selected.length > 0 &&
      JSON.stringify(selected) !== selectionTranslation.current?.selection &&
      !retry
    const choice = translationSettings && translationAction ? { ...choiceFor(kind) } : null
    if (choice && !translationAllowed(translationSettings!, choice)) {
      toast({ title: translationText('invalidDirection'), tone: 'error' })
      return
    }
    if (newTranslationSelection) {
      serviceSelections.current = selected
      setResults((previous) => {
        const { selection_translation: _stale, ...remaining } = previous
        return remaining
      })
    }
    if (choice) language = choice.target as TranslationDirection
    const modelKey =
      choice && choice.engine !== AI_ENGINE_PREFIX
        ? translationModelKey(
            choice,
            state.catalog.models.filter((model) => !model.disabled).map((model) => model.key)
          )
        : actionModelKey(kind)
    const selectionSnapshot =
      kind === 'selection_translation'
        ? translationSnapshot({
            document: identity,
            selection: selected,
            choice: choice ?? {
              engine: AI_ENGINE_PREFIX + modelKey,
              source: 'auto',
              target: language,
            },
            modelKey: modelKey ?? '',
            revision,
            attemptId: crypto.randomUUID(),
          })
        : undefined
    if (selectionSnapshot) selectionTranslation.current = selectionSnapshot
    if (choice && translationBackend && !choice.engine.startsWith(AI_ENGINE_PREFIX)) {
      if (isBusy(kind) && !serviceControllers.current[kind]) return
      const controller = new AbortController()
      serviceControllers.current[kind]?.abort()
      serviceControllers.current[kind] = controller
      const sourcePage =
        requestedPage ?? (kind === 'document_translation' ? page : (selected[0]?.page ?? page))
      const captured = currentIdentity.current
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        currentIdentity.current === captured &&
        (!selectionSnapshot ||
          (selectionTranslation.current === selectionSnapshot &&
            selectionSnapshotCurrent(
              selectionSnapshot,
              captured,
              currentSelectionIdentity.current
            )))
      if (kind === 'selection_translation') {
        setFloating(kind)
        setAnnotatedResult('')
      } else {
        setRequestedTranslationPage(sourcePage)
        setPanel(kind)
      }
      updateJob(kind, { pending: true, failed: false, error: undefined, task: undefined })
      try {
        const sourceSelections = selected.length ? selected : serviceSelections.current
        const source: { blocks: TranslationSentence[] } =
          kind === 'document_translation'
            ? await pdfAiApi<{ blocks: TranslationSentence[] }>(
                `${PDF_AI_PREFIX}/structure`,
                {
                  citation,
                  literature_id: literatureId,
                  attachment_id: attachmentId,
                  path,
                  asset_id: assetId,
                  project_id: projectId,
                  revision,
                  model_key: '',
                  kind,
                  module,
                  page: sourcePage,
                  text: '',
                  target_language: choice.target,
                  response_language: pdfResponseLanguage(i18n.language),
                  client_action_id: crypto.randomUUID(),
                  client_attempt_id: crypto.randomUUID(),
                },
                controller.signal
              )
            : {
                blocks: [
                  {
                    source_text: sourceSelections.map((item) => item.text).join('\n'),
                    translated_text: '',
                    located: false,
                  },
                ],
              }
        if (!source.blocks.some((block) => block.source_text.trim())) throw new Error('empty_text')
        const blocks: TranslationSentence[] = []
        for (const block of source.blocks) {
          if (!isCurrent()) return
          const translated = await translationBackend.translate(
            choice,
            block.source_text,
            controller.signal,
            () => translationNotice('recovered')
          )
          if (!isCurrent()) return
          blocks.push({
            ...block,
            translated_text: translated,
            paragraph_start: true,
            source_id: block.block_id,
            located: Boolean(block.source_quads?.length),
            emphasis_complete: !block.emphasis?.length,
          })
          if (kind === 'document_translation')
            updateJob(kind, {
              pending: true,
              task: {
                task_id: '',
                status: 'running',
                preview: { pages: [{ page: sourcePage, blocks: [...blocks] }] },
              },
            })
        }
        const selectedText = blocks.map((block) => block.source_text).join('\n\n')
        const translatedText = blocks.map((block) => block.translated_text).join('\n\n')
        const result: PdfAiResult = {
          kind,
          client_attempt_id: selectionSnapshot?.attemptId,
          revision,
          literature_id: literatureId,
          selected_text: selectedText,
          quads:
            kind === 'selection_translation'
              ? sourceSelections
                  .filter((item) => item.page === sourcePage)
                  .flatMap((item) => item.quads)
              : undefined,
          page: sourcePage,
          model_key: '',
          text: translatedText,
          target_language: choice.target,
          blocks,
          pages: [{ page: sourcePage, blocks }],
        }
        setResults((previous) => ({
          ...previous,
          [kind]:
            kind === 'document_translation' && !translationDirty(choice, appliedTranslations[kind])
              ? mergeTranslationResult(previous[kind], result)
              : result,
        }))
        setAppliedTranslations((previous) => ({ ...previous, [kind]: { ...choice } }))
        updateJob(kind, { pending: false, task: { task_id: '', status: 'completed' } })
      } catch (cause) {
        if (isCurrent()) {
          updateJob(kind, { pending: false, failed: true })
          if (translationError(cause) === 'rate_limited') translationNotice('rate_limited')
          else toast({ title: translationText(`errors.${translationError(cause)}`), tone: 'error' })
        }
      } finally {
        if (serviceControllers.current[kind] === controller) delete serviceControllers.current[kind]
      }
      return
    }
    if (jobsRef.current[kind]?.error?.code === PDF_AI_TASK_UNRESOLVED) return
    const replacing = isBusy(kind)
    if (replacing && !REPLACEABLE_ACTIONS.has(kind)) return
    const previous = replacing ? submissions.current[kind] : undefined
    if (kind === 'document_translation')
      setRequestedTranslationPage(retry?.page ?? requestedPage ?? page)
    if (SELECTION_ACTIONS.has(kind)) {
      setFloating(kind)
      setAnnotatedResult('')
      if (!(translationBackend && kind === 'selection_translation')) {
        setResults((previous) => {
          const { [kind]: _stale, ...remaining } = previous
          return remaining
        })
      }
    }
    if (!modelKey) {
      updateJob(kind, {
        error: { code: PDF_AI_MODEL_UNAVAILABLE, diagnostic: '' },
        failed: true,
        pending: false,
        task: { task_id: '', status: 'failed' },
      })
      return
    }
    if (IMAGE_INPUT_ACTIONS.has(kind) && !figureModelSupportsImageInput) {
      updateJob(kind, {
        error: { code: PDF_AI_IMAGE_INPUT_UNSUPPORTED, diagnostic: '' },
        failed: true,
        pending: false,
        task: { task_id: '', status: 'failed' },
      })
      return
    }
    updateJob(kind, { error: undefined, failed: false, task: undefined, pending: true })
    setNotice(false)
    const request: PdfAiRequest = {
      artifact,
      instruction: retry
        ? retry.instruction
        : (instruction ??
          (SELECTION_PROMPTS[kind] ? state.selectionPrompts[SELECTION_PROMPTS[kind]!] : undefined)),
      citation,
      literature_id: literatureId,
      attachment_id: attachmentId,
      path,
      asset_id: assetId,
      project_id: projectId,
      revision,
      model_key: modelKey,
      kind,
      module,
      page: requestedPage ?? region?.page ?? selected[0]?.page ?? page,
      text: selected.map((value) => value.text).join('\n'),
      rect: region?.rect,
      region_id: region?.region_id,
      visual_kind: region?.kind,
      quads: selected
        .filter((value) => value.page === (selected[0]?.page ?? page))
        .flatMap((value) => value.quads),
      ...(retry
        ? {
            page: retry.page,
            text: retry.text,
            rect: retry.rect,
            region_id: retry.region_id,
            visual_kind: retry.visual_kind,
            quads: retry.quads,
          }
        : {}),
      client_action_id: crypto.randomUUID(),
      client_attempt_id: selectionSnapshot?.attemptId ?? crypto.randomUUID(),
      target_language: language,
      response_language: responseLanguage,
    }
    requests.current[kind] = request
    if (choice) requestedChoices.current[kind] = { ...choice }
    const submissionController = new AbortController()
    submissionControllers.current[kind]?.abort()
    submissionControllers.current[kind] = submissionController
    const isCurrent = (): boolean =>
      currentIdentity.current === identity &&
      requests.current[kind] === request &&
      (!selectionSnapshot ||
        (selectionTranslation.current === selectionSnapshot &&
          selectionSnapshotCurrent(selectionSnapshot, identity, currentSelectionIdentity.current)))
    if (kind === 'figure_explanation') {
      setFloating(kind)
      setCropPreview('')
    } else if (!SELECTION_ACTIONS.has(kind)) setFloating(null)
    let figureController: AbortController | undefined
    try {
      if (kind === 'figure_explanation') {
        figureAbort.current?.abort()
        figureController = new AbortController()
        figureAbort.current = figureController
        setFigureText('')
        const result = await invokeFigure(request, figureController.signal, (preview) => {
          if (!isCurrent()) return
          setCropPreview(preview.crop)
          setFigureText(preview.text)
          updateJob(kind, { task: { task_id: '', status: preview.text ? 'running' : 'pending' } })
        })
        if (isCurrent()) {
          setCropPreview(result.crop ?? '')
          setFigureText(result.text)
          setResults((previousResults) => ({ ...previousResults, [kind]: result }))
          updateJob(kind, { task: { task_id: '', status: 'completed', result } })
        }
        return
      }
      const submission = replaceSubmission(
        previous,
        isCurrent,
        () => submitPdfAiTask(request, submissionController.signal),
        (taskId) => pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${taskId}/cancel`, {})
      )
      submissions.current[kind] = submission
      const next = await submission
      if (next && !isCurrent() && !pdfAiTaskFinished(next)) {
        await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${next.task_id}/cancel`, {})
      }
      if (isCurrent() && next) {
        updateJob(kind, { task: next, error: pdfAiFailure(next), failed: next.status === 'failed' })
      }
    } catch (cause) {
      if (isCurrent()) {
        const cancelled = kind === 'figure_explanation' && figureController?.signal.aborted
        if (kind === 'figure_explanation' && !cancelled) setFigureText('')
        updateJob(
          kind,
          cancelled
            ? { error: undefined, failed: false, task: { task_id: '', status: 'cancelled' } }
            : {
                error: pdfAiCaughtFailure(cause),
                failed: true,
                task: { task_id: '', status: 'failed' },
              }
        )
      }
    } finally {
      if (isCurrent()) updateJob(kind, { pending: false })
      if (kind === 'figure_explanation' && figureAbort.current === figureController)
        figureAbort.current = null
    }
  }
  const translationLanguage = (): TranslationDirection => {
    const selected = directions.document_translation
    if (selected) return selected
    return defaultTranslationTarget(i18n.resolvedLanguage || i18n.language, documentText)
  }
  const translationTarget = translationSettings
    ? choiceFor('document_translation').target
    : translationLanguage()
  const translationResult = translationResultForTarget(
    results.document_translation,
    translationTarget
  )
  const translatedPageNumbers = translationResult?.pages?.map((item) => item.page) ?? []
  useEffect(() => {
    setActiveSentence('')
  }, [translationTarget])
  const runTranslationPage = (sourcePage: number, automatic = false): void => {
    automaticTranslationRequest.current = automatic
    void run(
      'document_translation',
      'summary',
      undefined,
      undefined,
      translationLanguage(),
      sourcePage
    )
  }
  const changeAutomaticTranslation = (checked: boolean, sourcePage: number): void => {
    if (!checked) {
      setAutomaticTranslation(false)
      if (automaticTranslationRequest.current && isBusy('document_translation'))
        void cancel('document_translation')
      toast({ title: t('reading.automaticTranslationPaused') })
      return
    }
    const job = jobsRef.current.document_translation
    if (job?.error?.code === PDF_AI_TASK_UNRESOLVED) return
    const choice = translationSettings ? choiceFor('document_translation') : null
    if (translationSettings && choice && !translationAllowed(translationSettings, choice)) {
      toast({ title: translationText('invalidDirection'), tone: 'error' })
      return
    }
    setTranslationAnchorPage(sourcePage)
    setAutomaticTranslation(true)
    if (job?.failed || job?.task?.status === 'cancelled') {
      updateJob('document_translation', { error: undefined, failed: false, task: undefined })
    }
    if (
      choice &&
      translationDirty(choice, appliedTranslations.document_translation) &&
      !isBusy('document_translation')
    ) {
      const firstPage = nextTranslationPage(sourcePage, pageCount, [...hiddenTranslationPages])
      if (firstPage !== undefined) runTranslationPage(firstPage, true)
    }
  }
  useEffect(() => {
    if (
      !automaticTranslation ||
      pageCount < 1 ||
      isBusy('document_translation') ||
      jobsRef.current.document_translation?.failed ||
      (translationSettings &&
        translationDirty(
          choiceFor('document_translation'),
          appliedTranslations.document_translation
        ))
    )
      return
    const nextPage = nextTranslationPage(translationAnchorPage, pageCount, [
      ...translatedPageNumbers,
      ...hiddenTranslationPages,
    ])
    if (nextPage !== undefined) runTranslationPage(nextPage, true)
  }, [
    automaticTranslation,
    translationAnchorPage,
    pageCount,
    translationResult?.pages,
    hiddenTranslationPages,
  ])
  const autoSelectionIdentity = useRef('')
  useEffect(() => {
    if (!selection.length) {
      autoSelectionIdentity.current = ''
      return
    }
    if (
      !active ||
      state.accountSettingsPage ||
      !translationSettings ||
      !automaticSelection(translationSettings)
    )
      return
    const key = JSON.stringify([translationDocument, selectionIdentity])
    if (autoSelectionIdentity.current === key) return
    const timer = setTimeout(() => {
      autoSelectionIdentity.current = key
      void run('selection_translation')
    }, AUTOMATIC_SELECTION_DELAY_MS)
    return () => clearTimeout(timer)
  }, [
    active,
    translationDocument,
    selectionIdentity,
    translationSettings?.toolbar,
    translationSettings?.selectionAutomatic,
    translationSettings?.preferencesReady,
    state.accountSettingsPage,
  ])
  useEffect(() => {
    if (automaticTranslation && jobs.document_translation?.failed) setAutomaticTranslation(false)
  }, [automaticTranslation, jobs.document_translation?.failed])
  const cancel = async (kind: PdfAction): Promise<void> => {
    if (kind === 'document_translation') setAutomaticTranslation(false)
    if (kind === 'figure_explanation') {
      if (!figureAbort.current) return
      figureAbort.current.abort()
      figureAbort.current = null
      updateJob(kind, { pending: false, task: { task_id: '', status: 'cancelled' } })
      return
    }
    const task = jobsRef.current[kind]?.task
    stopJob(kind, !task?.task_id)
    updateJob(kind, {
      pending: false,
      failed: false,
      error: undefined,
      task: { task_id: task?.task_id ?? '', status: 'cancelled' },
    })
    if (!task?.task_id) return
    const next = await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${task.task_id}/cancel`, {})
    if (
      currentIdentity.current === identity &&
      jobsRef.current[kind]?.task?.task_id === task.task_id
    )
      updateJob(kind, { task: next })
  }
  const output = (content: PdfAiContent, showEvidence = true): React.JSX.Element => (
    <>
      <Markdown text={content.text ?? ''} math />
      {content.uncertain && (
        <p className="mt-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
          {t('reading.uncertain')}
        </p>
      )}
      {showEvidence &&
        evidencePages(content.evidence).map((anchor) => (
          <Button
            key={anchor.page}
            variant="ghost"
            size="sm"
            title={anchor.quote}
            onClick={() => onNavigate(anchor.page)}
          >
            {t('reading.evidencePage', { page: anchor.page })}
          </Button>
        ))}
    </>
  )
  const feedback = (kind: PdfAction): React.JSX.Element => {
    const { task, error, pending, failed } = jobs[kind] ?? {}
    const busy = isBusy(kind)
    const recovery = pdfAiFailureRecovery(error)
    const progress = task?.progress
    const progressText =
      progress?.phase === 'classify'
        ? t('reading.classifying')
        : progress?.phase === 'extract'
          ? t('reading.extracting')
          : progress?.phase === 'repair'
            ? t('reading.repairing')
            : pending || task?.status === 'pending'
              ? t('reading.waiting')
              : t('reading.generating')
    return (
      <>
        {busy && !SELECTION_ACTIONS.has(kind) && (
          <div
            role="status"
            className="flex shrink-0 items-center justify-between p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)]"
          >
            <span>{progressText}</span>
            <div className="flex items-center gap-[var(--vds-space-2)]">
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  kind !== 'figure_explanation' &&
                  !task?.task_id &&
                  !serviceControllers.current[kind]
                }
                onClick={() => void cancel(kind)}
              >
                {t('reading.cancel')}
              </Button>
            </div>
          </div>
        )}
        {task?.status === 'completed' &&
          kind !== 'selection_translation' &&
          kind !== 'selection_explanation' && (
            <p
              role="status"
              className="px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]"
            >
              {t('reading.completed')}
            </p>
          )}
        {task?.status === 'cancelled' && (
          <p role="status" className="p-[var(--vds-space-3)]">
            {t('reading.cancelled')}
          </p>
        )}
        {(error || failed) && (
          <div
            role="alert"
            className="p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]"
          >
            <p className="whitespace-pre-wrap">
              {error ? pdfAiFailureText(error, t) : t('reading.failed')}
            </p>
            <div className="mt-[var(--vds-space-2)] flex gap-[var(--vds-space-2)]">
              {recovery.configure && (
                <Button size="sm" variant="outline" onClick={() => actions.openSettings('models')}>
                  {t('reading.configure')}
                </Button>
              )}
              {recovery.reselect && (
                <Button size="sm" variant="outline" onClick={() => setFloating(null)}>
                  {t('reading.reselect')}
                </Button>
              )}
              {recovery.retry && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    const request = requests.current[kind]
                    if (request) void run(request.kind, request.module, undefined, request)
                    else if (kind === 'figure_explanation' && lastFigureRegion.current)
                      startFigure(lastFigureRegion.current)
                  }}
                >
                  {t('reading.retry')}
                </Button>
              )}
            </div>
          </div>
        )}
        {notice && (
          <p
            role="status"
            className="p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)]"
          >
            {t('reading.unlocated')}
          </p>
        )}
      </>
    )
  }
  const currentSelectionTranslation = selectionSnapshotCurrent(
    selectionTranslation.current,
    identity,
    currentSelectionIdentity.current
  )
  const floatingResult =
    floating && !busy
      ? floating === 'selection_translation'
        ? currentSelectionTranslation
          ? selectionResultForSnapshot(results[floating], selectionTranslation.current)
          : undefined
        : results[floating]
      : undefined
  const floatingPreview =
    floating && busy && (floating !== 'selection_translation' || currentSelectionTranslation)
      ? jobs[floating]?.task?.preview?.text
      : undefined
  const selectionRefreshPending = Boolean(
    floating === 'selection_explanation' &&
    pdfSelectionRefreshPending(lastRequest.current, actionModelKey(floating))
  )
  const annotationIdentity = floatingResult
    ? JSON.stringify([
        floatingResult.kind,
        floatingResult.revision,
        floatingResult.page,
        floatingResult.selected_text,
        floatingResult.text,
      ])
    : undefined
  const addResultComment = async (): Promise<void> => {
    if (
      !floatingResult ||
      !annotationIdentity ||
      annotating ||
      annotationIdentity === annotatedResult
    )
      return
    const request = requests.current[floatingResult.kind]
    const text = floatingResult.selected_text || request?.text || ''
    const quads = floatingResult.quads ?? request?.quads ?? []
    if (!text || !quads.length) return
    setAnnotating(true)
    try {
      if (await onAddComment({ page: floatingResult.page, text, quads }, floatingResult.text)) {
        setAnnotatedResult(annotationIdentity)
      }
    } finally {
      setAnnotating(false)
    }
  }
  const assistantTitle = literatureTitle || title
  const openDocumentChat = async (text: string, focus = true): Promise<boolean> => {
    if (literatureId) {
      const ready = await actions.prepareContextConversation(
        {
          kind: 'literature',
          source_id: literatureId,
          label: assistantTitle,
          retention: 'next_turn',
          origin: 'explicit',
        },
        text
      )
      if (!ready) return false
    } else actions.askAiFromPanel(text)
    if (focus) requestAnimationFrame(() => focusComposer())
    return true
  }
  const quote = (): void => {
    if (!floatingResult) return
    void openDocumentChat(
      t('reading.selectionDraft', {
        literatureId: assistantTitle,
        page: floatingResult.page,
        revision: floatingResult.revision,
        source: floatingResult.selected_text,
        result: floatingResult.text,
      }),
      false
    )
  }
  const openSelectionExplanation = (): void => {
    dismissSelectionActions(tabId)
    setFloating(null)
    setSelectionResultMark(null)
    setSelectionExplanationSnapshot(selection)
    setSelectionExplanationDraft('')
    setSelectionExplanationOpen(true)
  }
  const toggleSelectionResultSize = (): void => {
    restoreResultFocus.current = true
    setSelectionResultExpanded((value) => !value)
  }
  const resultSizeLabel = t(selectionResultFillsReader ? 'reading.shrinkPanel' : 'reading.enlarge')
  const resultAnnotated = Boolean(annotationIdentity && annotationIdentity === annotatedResult)
  const resultText = floatingResult?.text ?? floatingPreview ?? ''
  const resultReady = Boolean(floatingResult?.text && !busy)
  const selectionResultActions = (
    <div
      data-testid="pdf-selection-result-actions"
      className="ml-auto inline-flex shrink-0 items-center gap-[var(--vds-space-half)] [&_svg]:!text-[var(--vds-icon-outline-default)]"
    >
      {!busy &&
        (selectionRefreshPending ||
          (floating === 'selection_translation' && !translationBackend)) && (
          <span className="relative inline-flex shrink-0">
            <IconButton
              data-testid={`pdf-${floating}-regenerate`}
              label={
                selectionRefreshPending ? t('selectionRefreshPending') : t('reading.retranslate')
              }
              icon={<RefreshCw size={14} />}
              size="sm"
              variant="ghost"
              disabled={!lastRequest.current}
              onClick={() => {
                const request = lastRequest.current
                if (floating && request)
                  void run(
                    floating,
                    request.module,
                    undefined,
                    request,
                    directions[floating] ?? request.target_language
                  )
              }}
            />
            {selectionRefreshPending && (
              <BadgeDot
                data-testid="pdf-selection-explanation-refresh-pending"
                aria-hidden="true"
                tone="neutral"
                className="pointer-events-none absolute right-0 top-0 text-[var(--vds-brand-bg-default)]"
              />
            )}
          </span>
        )}
      {resultReady && (
        <CopyButton
          iconOnly
          tooltip
          idleLabel={
            floating === 'selection_translation' ? t('reading.copyTranslation') : undefined
          }
          icon={<Copy size={14} />}
          copiedIcon={<Check size={14} />}
          size="sm"
          variant="ghost"
          statusStyle={false}
          feedbackDuration={SELECTION_COPY_FEEDBACK_DURATION_MS}
          value={resultText}
          writeText={writeClipboard}
          disabled={!resultText}
        />
      )}
      {!busy && floating === 'selection_translation' && (
        <Tooltip portalled content={translationText('settingsButton')}>
          <IconButton
            data-testid="pdf-selection-translation-settings"
            label={translationText('settingsButton')}
            icon={<SlidersHorizontal size={14} />}
            size="sm"
            variant="ghost"
            onClick={() => actions.openSettings('translation')}
          />
        </Tooltip>
      )}
      <Tooltip portalled content={resultSizeLabel}>
        <IconButton
          ref={focusResultSizeButton}
          data-testid="pdf-selection-result-toggle-size"
          label={resultSizeLabel}
          aria-expanded={selectionResultFillsReader}
          icon={selectionResultFillsReader ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          size="sm"
          variant="ghost"
          onClick={toggleSelectionResultSize}
        />
      </Tooltip>
    </div>
  )
  const submitSelectionExplanation = (): void => {
    if (!selectionExplanationSnapshot.length) return
    setSelectionExplanationOpen(false)
    void run(
      'selection_explanation',
      'summary',
      undefined,
      undefined,
      undefined,
      undefined,
      selectionExplanationSnapshot,
      selectionInstruction(state.selectionPrompts, 'explain', selectionExplanationDraft)
    )
  }
  const canAnalyzeSelection = Boolean(artifact || literatureId || (projectId && path))
  const selectionResultKind =
    floating === 'selection_translation' || floating === 'selection_explanation' ? floating : null
  const selectionResultName =
    selectionResultKind === 'selection_translation' ? 'translation' : 'explanation'
  const selectionResultPanel = selectionResultKind ? (
    <section
      {...documentSelectionInteractionProps}
      aria-label={LABELS[selectionResultKind]}
      aria-busy={busy}
      className={`flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--vds-space-3)] overflow-hidden py-[var(--vds-space-3)] ${selectionResultFillsReader ? '' : 'border-t border-[var(--vds-divider-default)]'}`}
      data-testid={`pdf-selection-${selectionResultName}-inline`}
      onKeyDown={(event) => {
        if (selectionResultFillsReader && event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          toggleSelectionResultSize()
        }
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)] px-[var(--vds-space-3)]">
        {modelControl(selectionResultKind)}
        {floating === 'selection_translation' && languageControl(floating)}
        {(floating !== 'selection_translation' || !translationBackend || !translationSettings) &&
          selectionResultActions}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {feedback(selectionResultKind)}
        {floatingResult?.translation_validation?.corrections ? (
          <p
            role="status"
            data-testid="pdf-selection-translation-corrected"
            className="px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-placeholder)]"
          >
            {t('reading.translationCorrected')}
          </p>
        ) : null}
        <ScrollArea
          overlay
          shadow="auto"
          className={`flex min-h-0 flex-col overflow-hidden !rounded-none ${selectionResultFillsReader ? 'flex-1' : 'max-h-[var(--vds-pdf-selection-result-max-height)] group-data-[resized=true]/pdf-selection:max-h-none group-data-[resized=true]/pdf-selection:flex-1'}`}
          viewportClassName="!min-h-0 flex-1 cursor-text select-text text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] [&_.md]:!text-[length:var(--vds-font-body-lv2)] [&_.md]:!leading-[var(--vds-lh-body-lv2)]"
          viewportProps={{ 'data-testid': `pdf-selection-${selectionResultName}-content` }}
        >
          <div className="box-border min-h-[calc(var(--vds-lh-body-lv2)*3)] min-w-0 max-w-full px-[var(--vds-space-3)] [overflow-wrap:anywhere]">
            {busy && !resultText ? (
              <div
                role="status"
                aria-label={t('reading.generating')}
                data-testid="pdf-selection-result-skeleton"
                className="flex min-h-[calc(var(--vds-lh-body-lv2)*3)] flex-col justify-around motion-reduce:[&_*]:after:animate-none"
              >
                <Skeleton height="var(--vds-font-body-lv2)" />
                <Skeleton height="var(--vds-font-body-lv2)" />
                <Skeleton height="var(--vds-font-body-lv2)" width="66%" />
              </div>
            ) : floatingResult ? (
              output(floatingResult, true)
            ) : floatingPreview ? (
              <Markdown text={floatingPreview} pending={busy} math />
            ) : null}
          </div>
        </ScrollArea>
      </div>
      {resultReady && (
        <div className="flex shrink-0 flex-wrap justify-end gap-[var(--vds-space-3)] px-[var(--vds-space-3)]">
          <Button
            data-testid={`pdf-selection-${selectionResultName}-conversation`}
            size="sm"
            variant="outline"
            icon={<MessageCirclePlus size={14} />}
            disabled={!floatingResult}
            onClick={quote}
          >
            {t('selectionAddConversation')}
          </Button>
          <Button
            data-testid={`pdf-selection-${selectionResultName}-annotate`}
            size="sm"
            variant="primary"
            icon={resultAnnotated ? <Check size={14} /> : <MessageSquareText size={14} />}
            loading={annotating}
            disabled={!canAnnotate || !floatingResult || busy || annotating || resultAnnotated}
            onClick={() => void addResultComment()}
          >
            {t(resultAnnotated ? 'reading.addedToAnnotation' : 'reading.addToAnnotation')}
          </Button>
        </div>
      )}
    </section>
  ) : null
  useSelectionActionContribution(tabId, {
    id: 'pdf-ai',
    order: 5,
    expanded:
      selectionExplanationOpen ||
      (selectionResultOpen && !selectionResultFillsReader && !selectionResultMark),
    ownsScroll: selectionResultOpen && !selectionExplanationOpen,
    toolbarEnabled: !selectionResultFillsReader,
    replacesDefaults: canAnalyzeSelection,
    dismiss: () => {
      if (selectionResultOpen) setFloating(null)
      setSelectionResultExpanded(false)
      setSelectionResultMark(null)
      setSelectionExplanationOpen(false)
      setSelectionExplanationDraft('')
      setSelectionExplanationSnapshot([])
    },
    actions: canAnalyzeSelection ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          icon={<MessageCircleMore className="size-[var(--vds-icon-7)]" />}
          aria-pressed={selectionExplanationOpen || floating === 'selection_explanation'}
          onClick={openSelectionExplanation}
          className="!text-[var(--vds-text-secondary)] [&_svg]:!text-[var(--vds-text-secondary)]"
        >
          {t('selectionExplain')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Languages size={14} />}
          aria-pressed={floating === 'selection_translation'}
          className="!text-[var(--vds-text-secondary)] [&_svg]:!text-[var(--vds-text-secondary)]"
          onClick={() => {
            dismissSelectionActions(tabId)
            setSelectionExplanationOpen(false)
            void run('selection_translation')
          }}
        >
          {t('selectionTranslate')}
        </Button>
      </>
    ) : null,
    panel: selectionExplanationOpen ? (
      <PdfExplanation
        value={selectionExplanationDraft}
        onChange={setSelectionExplanationDraft}
        onOpenSettings={() => actions.openSettings('prompts')}
        disabled={!selectionExplanationSnapshot.length}
        onSubmit={submitSelectionExplanation}
      />
    ) : selectionResultFillsReader || selectionResultMark ? null : (
      selectionResultPanel
    ),
  })
  const translated = translationResult?.pages?.find((item) => item.page === page)
  const documentTranslationBusy = isBusy('document_translation')
  useEffect(() => {
    const selected = selection.map((item) => item.text).join(' ')
    if (!selected) return
    const sentence = translated?.blocks.find(
      (item) => matchReadingText(item.source_text, selected).length > 0
    )
    if (sentence) setActiveSentence(sentence.source_id ?? sentence.source_text)
  }, [selection, translated])
  const selectSentence = (sentence: TranslationSentence, sourcePage: number): void => {
    setActiveSentence(sentence.source_id ?? sentence.source_text)
    if (sentence.source_quads?.length || sentence.source_text.trim())
      onLocate(sourcePage, sentence.source_text, sentence.source_quads)
    else setNotice(true)
  }
  const languageScope = (kind: PdfAction): 'literature-document' | 'literature-selection' =>
    kind === 'document_translation' ? 'literature-document' : 'literature-selection'
  function languageControl(kind: PdfAction): React.JSX.Element | null {
    return translationBackend &&
      (kind === 'document_translation' || kind === 'selection_translation') ? null : (
      <div
        className={
          kind === 'document_translation'
            ? 'shrink-0 [&_button]:!w-auto [&_button]:!min-w-0 [&_button]:!px-[var(--vds-space-2)] [&_button]:text-[length:var(--vds-pdf-reading-toolbar-font-size)]'
            : undefined
        }
      >
        <Language
          value={
            directions[kind] ??
            defaultTranslationTarget(
              i18n.resolvedLanguage || i18n.language,
              kind === 'document_translation'
                ? (translationResult?.source_language ?? '')
                : selection.map((value) => value.text).join('\n')
            )
          }
          onChange={(next) => {
            writeTranslationTarget(languageScope(kind), next)
            setDirections((values) => ({ ...values, [kind]: next }))
            setActiveSentence('')
            const previous = requests.current[kind]
            if (kind === 'document_translation') {
              if (automaticTranslation) changeAutomaticTranslation(false, page)
            } else if (results[kind] || previous)
              void run(kind, 'summary', undefined, previous, next)
          }}
        />
      </div>
    )
  }
  const toggleInterpretation = (): void => {
    onReadingLayoutChange()
    const next = panel === 'interpretation' ? null : 'interpretation'
    if (next) {
      onReadingOpen()
      exitFigureSelection()
      onExclusiveSurfaceOpen()
      setAutomaticTranslation(false)
      setTranslationMenuOpen(false)
    }
    setPanel(next)
    setPanelExpanded(false)
  }
  const changeTranslationMenu = (open: boolean): void => {
    setTranslationMenuOpen(open)
    if (open && panel !== 'document_translation') changeDocumentTranslation(true)
  }
  function changeDocumentTranslation(enabled: boolean): void {
    if (enabled) {
      exitFigureSelection()
      onExclusiveSurfaceOpen()
      setPanelExpanded(false)
      setPanel('document_translation')
      setHiddenTranslationPages(new Set())
      if (localStorage.getItem(PDF_AUTOMATIC_TRANSLATION_PREFERENCE) !== 'off')
        changeAutomaticTranslation(true, page)
    } else {
      selectPanel(null)
      setTranslationMenuOpen(true)
    }
  }
  const selectPanel = (next: PdfAction | null): void => {
    if (panel && panel !== 'interpretation' && next !== panel) void cancel(panel)
    if (panel === 'interpretation' || next === 'interpretation') onReadingLayoutChange()
    if (next !== 'document_translation') {
      setAutomaticTranslation(false)
      setTranslationMenuOpen(false)
    }
    if (next !== panel) setPanelExpanded(false)
    setPanel(next)
  }
  const setTranslationPageClosed = (sourcePage: number, closed: boolean): void => {
    setHiddenTranslationPages((previous) => {
      const next = new Set(previous)
      if (closed) next.add(sourcePage)
      else next.delete(sourcePage)
      return next
    })
  }
  const clearFigureResult = (): void => {
    setFigureText('')
    setCropPreview('')
    setResults((previous) => {
      const { figure_explanation: _archived, ...remaining } = previous
      return remaining
    })
  }
  const startFigure = (region: FigureRegion): void => {
    clearFigureResult()
    setFigureGuideOpen(false)
    lastFigureRegion.current = region
    if (!figureModelSupportsImageInput) {
      updateJob('figure_explanation', {
        error: { code: 'pdf_ai_image_input_unsupported', diagnostic: '' },
        failed: true,
        pending: false,
        task: { task_id: '', status: 'failed' },
      })
      return
    }
    void run('figure_explanation', 'all', region)
  }
  const selectFigure = (selectedPage: number, rect: number[]): void => {
    const region = { page: selectedPage, rect }
    setFloating('figure_explanation')
    setFigureGuideOpen(false)
    startFigure(region)
  }
  const explainRegion = (region: PdfVisualRegion): void => {
    clearFigureResult()
    setFloating('figure_explanation')
    void run('figure_explanation', 'all', {
      page: region.page,
      kind: region.kind,
      rect: visualRegionRect(region),
    })
  }
  const copiedLatex = useRef('')
  const copyingRegionId = useRef<string | undefined>(undefined)
  const copyFormula = (region: PdfVisualRegion): void => {
    copyingRegionId.current = region.region_id
    copiedLatex.current = ''
    setResults((previous) => {
      const { formula_latex: _stale, ...remaining } = previous
      return remaining
    })
    void run('formula_latex', 'all', {
      page: region.page,
      kind: region.kind,
      rect: visualRegionRect(region),
    })
  }
  useEffect(() => {
    const latex = results.formula_latex?.latex?.trim()
    if (!latex || copiedLatex.current === latex) return
    copiedLatex.current = latex
    void writeClipboard(latex)
      .then(() => toast({ title: t('visualRegions.formulaCopied'), tone: 'success' }))
      .catch(() => toast({ title: t('visualRegions.copyFailed'), tone: 'error' }))
  }, [results.formula_latex?.latex, t, toast])
  const formulaFailure = jobs.formula_latex?.failed ? jobs.formula_latex.error : undefined
  useEffect(() => {
    if (!formulaFailure) return
    toast({ title: pdfAiFailureText(formulaFailure, t), tone: 'error' })
  }, [formulaFailure, t, toast])
  const translationPage = (
    sourcePage: number,
    pageSize: Size,
    pageScale: number
  ): React.JSX.Element => {
    const closed = hiddenTranslationPages.has(sourcePage)
    const active = !closed && requestedTranslationPage === sourcePage
    const pageBusy = active && documentTranslationBusy
    const job = jobs.document_translation
    const completed = closed
      ? undefined
      : translationResult?.pages?.find((item) => item.page === sourcePage)
    const preview = pageBusy
      ? job?.task?.preview?.pages?.find(
          (item) =>
            item.page === sourcePage && item.blocks.some((block) => block.translated_text.trim())
        )
      : undefined
    const content = preview ?? completed
    const copyText =
      completed?.blocks
        .map((block) => block.translated_text)
        .filter(Boolean)
        .join('\n\n') ?? ''
    const pageFailed = active && Boolean(job?.error || job?.failed)
    const waiting = !closed && automaticTranslation && !content && !pageFailed
    const recovery = pdfAiFailureRecovery(job?.error)
    return (
      <div
        className="min-w-0"
        data-testid={`pdf-translation-page-${sourcePage}`}
        data-translation-page={sourcePage}
        style={{ width: pageSize.width * pageScale, height: pageSize.height * pageScale }}
      >
        <Card
          padding="none"
          className="box-border flex flex-col overflow-hidden rounded-none! ![border:0] bg-[var(--vds-bg-white-default)] ![box-shadow:none]"
          style={{ width: pageSize.width, height: pageSize.height, zoom: pageScale }}
        >
          <CardHeader className="relative mb-0 flex! flex-wrap items-center justify-between border-b border-[var(--vds-border-default)] bg-transparent px-[var(--vds-space-4)] py-[var(--vds-space-2)]">
            <CardTitle
              aria-label={t('reading.pageTranslation', { page: sourcePage, total: pageCount })}
              className="text-[length:var(--vds-font-body-lv1)]! leading-[var(--vds-lh-body-lv1)]!"
            >
              {sourcePage}/{pageCount}
            </CardTitle>
            <div className="flex shrink-0 items-center gap-[var(--vds-space-half)]">
              <IconButton
                label={t('reading.retranslatePage')}
                icon={<RefreshCw size={14} />}
                size="sm"
                variant="ghostIcon"
                disabled={!completed || documentTranslationBusy}
                onClick={() => runTranslationPage(sourcePage)}
              />
              <CopyButton
                iconOnly
                tooltip
                idleLabel={t('reading.copyTranslationPage')}
                icon={<Copy size={14} />}
                size="sm"
                variant="ghostIcon"
                disabled={!copyText}
                value={copyText}
                writeText={writeClipboard}
              />
              <IconButton
                label={t('reading.hideTranslationPage')}
                icon={<X size={14} />}
                size="sm"
                variant="ghostIcon"
                disabled={closed}
                onClick={() => setTranslationPageClosed(sourcePage, true)}
              />
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--vds-space-6)] pt-[var(--vds-space-4)] pb-[var(--vds-space-6)] [scrollbar-gutter:stable]">
            {pageFailed && (
              <div
                role="alert"
                className="mb-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]"
              >
                <p className="whitespace-pre-wrap">
                  {job?.error ? pdfAiFailureText(job.error, t) : t('reading.failed')}
                </p>
                <div className="mt-[var(--vds-space-2)] flex gap-[var(--vds-space-2)]">
                  {recovery.configure && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => actions.openSettings('models')}
                    >
                      {t('reading.configure')}
                    </Button>
                  )}
                  {recovery.retry && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pageBusy}
                      onClick={() => runTranslationPage(sourcePage)}
                    >
                      {t('reading.retry')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            {pageBusy && content && !preview && (
              <p className="mb-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                {t('reading.previousResult')}
              </p>
            )}
            {content ? (
              <Translation
                sentences={content.blocks}
                active={activeSentence}
                onSelect={(sentence) => selectSentence(sentence, sourcePage)}
                compact
                sections
                collapsed={collapsedSections[sourcePage] ?? {}}
                onCollapse={(id, value) =>
                  setCollapsedSections((previous) => ({
                    ...previous,
                    [sourcePage]: { ...previous[sourcePage], [id]: value },
                  }))
                }
              />
            ) : !pageFailed ? (
              <div className="grid h-full place-content-center justify-items-center gap-[var(--vds-space-2)] text-center text-[length:var(--vds-font-body-lv2)]">
                {closed ? (
                  <Button size="sm" onClick={() => setTranslationPageClosed(sourcePage, false)}>
                    {t('reading.openTranslationPage')}
                  </Button>
                ) : waiting || pageBusy ? (
                  <div role="status" className="grid justify-items-center gap-[var(--vds-space-2)]">
                    <Spinner size="sm" aria-hidden="true" />
                    {pageBusy && (!automaticTranslation || job?.task?.status === 'running')
                      ? t('reading.generating')
                      : t('reading.queuedTranslation')}
                  </div>
                ) : (
                  <Button
                    size="sm"
                    disabled={documentTranslationBusy && !completed}
                    onClick={() => runTranslationPage(sourcePage)}
                  >
                    {t('reading.translatePage')}
                  </Button>
                )}
                {pageBusy &&
                  (job?.task?.task_id || serviceControllers.current.document_translation) && (
                    <Button
                      variant="tertiary"
                      size="sm"
                      onClick={() => void cancel('document_translation')}
                    >
                      {t('reading.cancelTranslation')}
                    </Button>
                  )}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }
  function modelControl(
    kind: LiteratureAiModelAction,
    multimodal = false,
    group: 'all' | 'engine' | 'languages' = 'all'
  ): React.JSX.Element {
    if (
      translationBackend &&
      translationSettings &&
      (kind === 'document_translation' || kind === 'selection_translation')
    ) {
      const value = choiceFor(kind)
      return (
        <TranslationControls
          compact={kind === 'selection_translation'}
          group={group}
          value={value}
          trailingActions={kind === 'selection_translation' ? selectionResultActions : undefined}
          disabled={isBusy(kind)}
          changed={
            kind === 'selection_translation' && translationDirty(value, appliedTranslations[kind])
          }
          appliedTarget={
            kind === 'selection_translation' ? appliedTranslations[kind]?.target : undefined
          }
          onChange={(next) => {
            translationBackend.choose(
              translationDocument,
              kind === 'document_translation' ? 'document' : 'selection',
              next
            )
            if (next.engine.startsWith(AI_ENGINE_PREFIX))
              actions.setLiteratureAiModel(kind, next.engine.slice(AI_ENGINE_PREFIX.length))
            if (kind === 'document_translation' && automaticTranslation)
              changeAutomaticTranslation(false, page)
          }}
          onRefresh={
            kind === 'selection_translation'
              ? () => {
                  void run(
                    kind,
                    'summary',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    serviceSelections.current
                  )
                }
              : undefined
          }
        />
      )
    }
    return (
      <div
        className={`min-w-0 ${kind === 'document_translation' ? 'w-[var(--vds-layout-pdf-translation-model-width)] shrink-0 text-[length:var(--vds-pdf-reading-toolbar-font-size)]' : 'max-w-[var(--vds-pdf-reading-toolbar-action-max-width)]'}`}
      >
        <ModelMenu
          compact
          variant={kind === 'selection_explanation' ? 'outline' : 'ghost'}
          independent
          modelFilter={multimodal ? MULTIMODAL_MODEL_FILTER : undefined}
          modelKey={actionModelKey(kind)}
          onModelSelect={(model) => actions.setLiteratureAiModel(kind, model.key)}
          showEffort={false}
          testIdPrefix={`pdf-${kind}-model`}
        />
      </div>
    )
  }
  return {
    preparingChat: preparingChat.current,
    panel,
    panelExpanded,
    figure,
    exitFigureSelection,
    setFigureGuideOpen,
    setPanel: selectPanel,
    translationOpen: panel === 'document_translation',
    translationPage,
    canAnalyzeSelection,
    annotationResult:
      selectionResultMark && selectionResultKind
        ? {
            markId: selectionResultMark,
            kind: selectionResultKind,
            panel: selectionResultFillsReader ? null : selectionResultPanel,
          }
        : null,
    expandedAnnotationResultId: selectionResultFillsReader ? selectionResultMark : null,
    selectionAnalyzing: isBusy('selection_explanation') || isBusy('selection_translation'),
    explainSelection: (target?: PdfSelection, requirement = '', markId?: string) => {
      setSelectionResultMark(markId ?? null)
      void run(
        'selection_explanation',
        'summary',
        undefined,
        undefined,
        undefined,
        undefined,
        target ? [target] : selection,
        selectionInstruction(state.selectionPrompts, 'explain', requirement)
      )
    },
    translateSelection: (target?: PdfSelection, markId?: string) => {
      setSelectionResultMark(markId ?? null)
      void run(
        'selection_translation',
        'summary',
        undefined,
        undefined,
        undefined,
        undefined,
        target ? [target] : selection
      )
    },
    selectFigure,
    explainRegion,
    copyFormula,
    visualRegionImageInputAvailable: figureModelSupportsImageInput,
    copyingFormulaRegionId: isBusy('formula_latex') ? copyingRegionId.current : undefined,
    toolbar:
      literatureId || (projectId && path) ? (
        <>
          {figureModelSupportsImageInput ? (
            <HoverCard open={figureGuideOpen} onOpenChange={setFigureGuideOpen}>
              <HoverCardTrigger
                asChild
                onClick={() => {
                  if (figure) exitFigureSelection()
                  else {
                    onExclusiveSurfaceOpen()
                    setFigure(true)
                    setFigureGuideOpen(false)
                  }
                  selectPanel(null)
                }}
              >
                <IconButton
                  data-testid="pdf-figure-explanation"
                  className="enabled:hover:![background:var(--vds-other-overlay-1)] aria-pressed:enabled:hover:![background:var(--vds-other-overlay-2)]"
                  data-ob="pdf-figure"
                  aria-pressed={figure}
                  label={t('reading.figure')}
                  title={undefined}
                  icon={<Icon name="image" size={16} />}
                  size="sm"
                  variant="ghostIcon"
                />
              </HoverCardTrigger>
              <HoverCardContent
                side="bottom"
                className="overflow-hidden rounded-[var(--vds-radius-5)] p-0"
                style={{
                  boxSizing: 'border-box',
                  maxWidth: 'none',
                  width: `min(${FIGURE_GUIDE_WIDTH_PX}px, calc(100vw - ${FIGURE_GUIDE_VIEWPORT_GUTTER_PX}px))`,
                }}
              >
                <div
                  className="p-[var(--vds-space-6)]"
                  style={{
                    boxSizing: 'border-box',
                    width: `${FIGURE_GUIDE_SOURCE_WIDTH_PX}px`,
                    zoom: FIGURE_GUIDE_SCALE,
                  }}
                >
                  <FigureGuide t={t} />
                </div>
              </HoverCardContent>
            </HoverCard>
          ) : (
            <Tooltip portalled content={t('reading.figureUnavailable')} side="bottom">
              <span>
                <Button
                  data-testid="pdf-figure-explanation"
                  data-ob="pdf-figure"
                  disabled
                  aria-label={t('reading.figure')}
                  icon={<Icon name="image" size={14} />}
                  size="sm"
                  variant="ghost"
                >
                  {t('reading.figure')}
                </Button>
              </span>
            </Tooltip>
          )}
          {Object.entries(jobs)
            .filter(
              ([action, job]) =>
                action !== 'figure_explanation' &&
                action !== 'document_translation' &&
                action !== 'selection_translation' &&
                action !== 'selection_explanation' &&
                action !== 'formula_latex' &&
                jobBusy(job)
            )
            .map(([action]) => (
              <Button
                key={action}
                size="sm"
                variant="ghost"
                onClick={() => {
                  const kind = action as PdfAction
                  if (kind === 'interpretation') {
                    exitFigureSelection()
                    onExclusiveSurfaceOpen()
                    setPanel(kind)
                  } else setFloating(kind)
                }}
              >
                {t('reading.inProgress', { action: LABELS[action as PdfAction] })}
              </Button>
            ))}
        </>
      ) : null,
    railActions:
      literatureId || translationBackend ? (
        <>
          <Popover open={translationMenuOpen} onOpenChange={changeTranslationMenu}>
            <Tooltip portalled content={LABELS.document_translation} side="left">
              <PopoverTrigger asChild>
                <IconButton
                  data-testid="pdf-document-translation"
                  disabled={pageCount < 1}
                  aria-pressed={panel === 'document_translation'}
                  label={LABELS.document_translation}
                  title={undefined}
                  icon={<Globe size={18} />}
                  variant={panel === 'document_translation' ? 'primary' : 'ghostIcon'}
                />
              </PopoverTrigger>
            </Tooltip>
            <PopoverContent
              side="left"
              aria-label={t('reading.documentTranslationSettings')}
              className="p-[var(--vds-space-3)]"
            >
              <div className="flex items-center justify-between gap-[var(--vds-space-2)] border-b border-[var(--vds-border-default)] pb-[var(--vds-space-2)] text-sm font-[var(--vds-fw-semibold)]">
                {t('reading.documentTranslationSettings')}
                <IconButton
                  label={t('ui:close')}
                  icon={<X />}
                  size="xs"
                  variant="ghostIcon"
                  onClick={() => changeTranslationMenu(false)}
                />
              </div>
              <div className="grid auto-rows-[minmax(var(--vds-control-height-sm),auto)] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-[var(--vds-space-5)] gap-y-[var(--vds-space-3)] text-sm font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]">
                <span>{LABELS.document_translation}</span>
                <Switch
                  data-testid="pdf-translation-enabled"
                  checked={panel === 'document_translation'}
                  label={LABELS.document_translation}
                  onCheckedChange={changeDocumentTranslation}
                />
                <span>{t('reading.automaticTranslation')}</span>
                <Switch
                  data-testid="pdf-translation-auto"
                  checked={automaticTranslation}
                  disabled={panel !== 'document_translation'}
                  label={t('reading.automaticTranslation')}
                  onCheckedChange={(checked) => {
                    localStorage.setItem(
                      PDF_AUTOMATIC_TRANSLATION_PREFERENCE,
                      checked ? 'on' : 'off'
                    )
                    changeAutomaticTranslation(checked, page)
                  }}
                />
                <span>{t('reading.translationEngineSettings')}</span>
                {modelControl('document_translation', false, 'engine')}
                <span>{t('reading.translationLanguageSettings')}</span>
                {translationBackend && translationSettings
                  ? modelControl('document_translation', false, 'languages')
                  : languageControl('document_translation')}
              </div>
            </PopoverContent>
          </Popover>
          {literatureId && (
            <Tooltip portalled content={LABELS.interpretation} side="left">
              <IconButton
                data-testid="pdf-interpretation"
                label={LABELS.interpretation}
                title={undefined}
                icon={<Sparkles className="size-[var(--vds-icon-10)]" />}
                variant="ghostIcon"
                aria-pressed={panel === 'interpretation'}
                onClick={toggleInterpretation}
              />
            </Tooltip>
          )}
        </>
      ) : null,
    sidePanel:
      panel === 'interpretation' ? (
        <PdfPanel
          ariaLabel={LABELS[panel]}
          bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--vds-surface-muted)]"
          closeLabel={t('reading.close')}
          expanded={panelExpanded}
          inline
          icon={<img src={sproutIcon} alt="" className="size-[var(--vds-icon-7)] object-contain" />}
          testId="pdf-reading-panel"
          headerDivider={false}
          title={LABELS[panel]}
          onClose={() => selectPanel(null)}
          onToggleExpanded={() => {
            onReadingLayoutChange()
            setPanelExpanded((value) => !value)
          }}
        >
          <PaperReading
            onSaved={() => catalogue.reload()}
            active={active}
            literatureId={literatureId}
            attachmentId={attachmentId}
            revision={revision}
            onSource={(source: ReadingEvidence) => {
              setPanelExpanded(false)
              onLocate(source.page, source.quote, source.quads)
            }}
            onChat={async (text) => {
              preparingChat.current = true
              try {
                const ready = await openDocumentChat(
                  t('reading.summaryDraft', { literatureId: assistantTitle, summary: text })
                )
                if (ready) selectPanel(null)
                return ready
              } finally {
                preparingChat.current = false
              }
            }}
          />
        </PdfPanel>
      ) : null,
    expandedSelectionResult: selectionResultFillsReader ? selectionResultPanel : null,
    floating:
      floating === 'figure_explanation' ? (
        <FloatingWindow
          key={floating}
          initialSize={FIGURE_WINDOW_SIZE}
          initialHorizontalCenterRef={viewportRef}
          ghostIconHeader
          plainFooter
          title={LABELS[floating]}
          onClose={() => {
            setFloating(null)
            void cancel('figure_explanation')
            exitFigureSelection()
          }}
          footer={
            <>
              <div className="mr-auto flex min-w-0 items-center gap-2">
                <Button
                  variant="outline"
                  icon={<Icon name="image" size={14} />}
                  onClick={() => {
                    void cancel('figure_explanation')
                    setFloating(null)
                    onExclusiveSurfaceOpen()
                    setFigure(true)
                  }}
                >
                  {t('reading.continueSelecting')}
                </Button>
                <span className="shrink-0 text-xs text-[var(--vds-text-tertiary)]">
                  {t('reading.currentModel')}
                </span>
                {modelControl('figure_explanation', true)}
              </div>
              <CopyButton
                key={floatingResult?.text ?? figureText}
                value={floatingResult?.text ?? figureText}
                writeText={writeClipboard}
                disabled={!floatingResult && !figureText}
                variant="outline"
                stableLabelWidth={false}
                icon={<Copy />}
              />
            </>
          }
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-[var(--vds-space-3)] overflow-auto p-[var(--vds-space-4)]">
              {floatingResult ||
              busy ||
              cropPreview ||
              jobs.figure_explanation?.error ||
              jobs.figure_explanation?.failed ? (
                <Card padding="sm">
                  <CardHeader>
                    <CardTitle className="!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)]">
                      {floatingResult
                        ? t('reading.figureResult', { page: floatingResult.page })
                        : t('reading.figureResultPending')}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(floatingResult?.crop || cropPreview) && (
                      <Crop
                        image={floatingResult?.crop ?? cropPreview}
                        page={floatingResult?.page ?? lastRequest.current?.page ?? page}
                      />
                    )}
                    {(floatingResult?.text || figureText) && (
                      <div className="mt-[var(--vds-space-3)] cursor-text select-text text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-pdf-reading-content-line-height)]">
                        <Markdown text={floatingResult?.text ?? figureText} math />
                      </div>
                    )}
                    {feedback('figure_explanation')}
                    <PromptSettingsGuide
                      className="mt-[var(--vds-space-3)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]"
                      prefix={t('reading.figurePromptGuide')}
                      linkLabel={t('reading.promptSettings')}
                      suffix={t('reading.promptGuideSuffix')}
                    />
                  </CardContent>
                </Card>
              ) : (
                <p className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {t('reading.selectionScope')}
                </p>
              )}
            </div>
          </div>
        </FloatingWindow>
      ) : null,
  }
}
