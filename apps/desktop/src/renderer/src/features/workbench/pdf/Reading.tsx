import {
  MAX_SELECTION_REQUIREMENT_CHARS,
  selectionInstruction,
  type SelectionPromptAction,
} from '../../../../../prompts'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, Globe, RefreshCw, X } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  Switch,
  Textarea,
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
import { requestModelKey, selectableActionModelKey } from '../../../catalog'
import type { ModelInfo } from '../../../api'
import { useSelectionActionContribution } from '../actions'
import { evidencePages } from './evidence'
import { Summary } from './Summary'
import { Crop } from './Crop'
import { replaceSubmission } from './submissions'
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
} from './failure'
import { mergeTranslationResult, nextTranslationPage } from './sequence'
import { PdfPanel } from './Panel'
import type { PdfSelection, TranslationDirection, TranslationSentence } from './analysis'
import {
  PDF_AI_PREFIX,
  cancelPdfAiTask,
  invokeFigure,
  pdfAiApi,
  pdfAiTaskFinished,
  pdfResponseLanguage,
  recoverPdfAiTask,
  submitPdfAiTask,
  type PdfAction,
  type PdfAiContent,
  type PdfAiRequest,
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
  selection,
  canAnnotate,
  onAddComment,
  onNavigate,
  onLocate,
  onDocumentTranslationChange,
  onExclusiveSurfaceOpen,
  viewportRef,
}: {
  active: boolean
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
  selection: PdfSelection[]
  canAnnotate: boolean
  onAddComment: (selection: PdfSelection, body: string) => Promise<boolean>
  onNavigate: (page: number) => void
  onLocate: (page: number, text: string) => void
  onDocumentTranslationChange: (open: boolean) => void
  onExclusiveSurfaceOpen: () => void
  viewportRef: React.RefObject<HTMLDivElement | null>
}) {
  const { state, act: actions } = useApp()
  const { toast } = useToast()
  const { t, i18n } = useTranslation('pdf')
  const { t: workbenchText } = useTranslation('workbench')
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
  const [floating, setFloating] = useState<PdfAction | null>(null)
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
  const [translationAnchorPage, setTranslationAnchorPage] = useState(page)
  const [requestedTranslationPage, setRequestedTranslationPage] = useState<number | null>(null)
  const [directions, setDirections] = useState<Partial<Record<PdfAction, TranslationDirection>>>(
    () => ({
      document_translation: readTranslationTarget('literature-document'),
      selection_translation: readTranslationTarget('literature-selection'),
    })
  )
  const [activeSentence, setActiveSentence] = useState('')
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
    literatureId,
    projectId,
    assetId,
    path,
    revision,
    responseLanguage,
  ])
  const selectionIdentity = JSON.stringify(selection)
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
    if (data.interpretation && data.interpretation.response_language !== responseLanguage)
      delete data.interpretation
    if (currentIdentity.current === identity && sequence === loadSequence.current) setResults(data)
  }
  useEffect(() => {
    figureAbort.current?.abort()
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
    setSelectionExplanationOpen(false)
    setSelectionExplanationDraft('')
    setSelectionExplanationSnapshot([])
    setAnnotatedResult('')
    setAutomaticTranslation(false)
    setTranslationAnchorPage(page)
    setRequestedTranslationPage(null)
    setPanel(null)
    setPanelExpanded(false)
    return () => {
      figureAbort.current?.abort()
      for (const kind of Object.keys(requests.current) as PdfAction[]) stopJob(kind)
    }
  }, [identity])
  useEffect(() => {
    setSelectionExplanationOpen(false)
    setSelectionExplanationDraft('')
    setSelectionExplanationSnapshot([])
  }, [selectionIdentity])
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
      controllers.push(controller)
      subscriptionControllers.current[kind] = controller
      const isCurrent = (): boolean =>
        !controller.signal.aborted &&
        currentIdentity.current === identity &&
        jobsRef.current[kind]?.task?.task_id === taskId
      void recoverPdfAiTask(
        taskId,
        controller.signal,
        (next) => {
          if (!isCurrent()) return
          if (jobsRef.current[kind]?.task?.status === 'cancelled' && !pdfAiTaskFinished(next))
            return
          if (pdfAiTaskFinished(next)) receivedTerminals.current[kind] = taskId
          if (next.status === 'completed' && next.result) {
            if (kind === 'document_translation') {
              setResults((previous) => ({
                ...previous,
                document_translation: mergeTranslationResult(
                  previous.document_translation,
                  next.result!
                ),
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
        selection.map((value) => value.text).join('\n')
      ),
    requestedPage?: number,
    selected = selection,
    instruction?: string
  ): Promise<void> => {
    if (jobsRef.current[kind]?.error?.code === PDF_AI_TASK_UNRESOLVED) return
    const replacing = isBusy(kind)
    if (replacing && !REPLACEABLE_ACTIONS.has(kind)) return
    const previous = replacing ? submissions.current[kind] : undefined
    if (kind === 'document_translation')
      setRequestedTranslationPage(retry?.page ?? requestedPage ?? page)
    const modelKey = actionModelKey(kind)
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
      instruction: retry
        ? retry.instruction
        : (instruction ??
          (SELECTION_PROMPTS[kind] ? state.selectionPrompts[SELECTION_PROMPTS[kind]!] : undefined)),
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
      client_attempt_id: crypto.randomUUID(),
      target_language: language,
      response_language: responseLanguage,
    }
    requests.current[kind] = request
    const submissionController = new AbortController()
    submissionControllers.current[kind]?.abort()
    submissionControllers.current[kind] = submissionController
    const isCurrent = (): boolean =>
      currentIdentity.current === identity && requests.current[kind] === request
    if (SELECTION_ACTIONS.has(kind)) {
      setResults((previous) => {
        const { [kind]: _stale, ...remaining } = previous
        return remaining
      })
    }
    if (['selection_translation', 'selection_explanation', 'figure_explanation'].includes(kind)) {
      setAnnotatedResult('')
      setFloating(kind)
    } else setFloating(null)
    if (kind === 'figure_explanation') setCropPreview('')
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
  const translationResult = results.document_translation
  const translatedPageNumbers = translationResult?.pages?.map((item) => item.page) ?? []
  const translationLanguage = (): TranslationDirection => {
    const selected = directions.document_translation
    if (selected) return selected
    return defaultTranslationTarget(
      i18n.resolvedLanguage || i18n.language,
      translationResult?.source_language ?? ''
    )
  }
  useEffect(() => {
    if (!translationResult) return
    const target = translationLanguage()
    if (translationResult.target_language === target) return
    setResults((previous) => {
      const { document_translation: _stale, ...remaining } = previous
      return remaining
    })
    setActiveSentence('')
  }, [
    directions.document_translation,
    translationResult?.target_language,
    i18n.language,
    i18n.resolvedLanguage,
  ])
  const runTranslationPage = (sourcePage: number, language = translationLanguage()): void => {
    void run('document_translation', 'summary', undefined, undefined, language, sourcePage)
  }
  const changeAutomaticTranslation = (checked: boolean, sourcePage: number): void => {
    if (checked && jobsRef.current.document_translation?.error?.code === PDF_AI_TASK_UNRESOLVED)
      return
    setAutomaticTranslation(checked)
    if (!checked) return
    if (checked) {
      exitFigureSelection()
      onExclusiveSurfaceOpen()
      setPanel('document_translation')
      setTranslationAnchorPage(sourcePage)
      if (
        jobsRef.current.document_translation?.failed ||
        jobsRef.current.document_translation?.task?.status === 'cancelled'
      ) {
        updateJob('document_translation', { error: undefined, failed: false, task: undefined })
      }
    }
  }
  useEffect(() => {
    if (
      !automaticTranslation ||
      pageCount < 1 ||
      isBusy('document_translation') ||
      jobsRef.current.document_translation?.failed
    )
      return
    const nextPage = nextTranslationPage(translationAnchorPage, pageCount, translatedPageNumbers)
    if (nextPage !== undefined) runTranslationPage(nextPage)
  }, [automaticTranslation, translationAnchorPage, pageCount, translationResult?.pages])
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
      <Markdown text={content.text ?? ''} />
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
      progress?.phase === 'segment'
        ? t('reading.interpretationSegment', { current: progress.current, total: progress.total })
        : progress?.phase === 'synthesis' && progress.cached === progress.total
          ? t('reading.interpretationCachedSynthesis', {
              cached: progress.cached,
              total: progress.total,
            })
          : progress?.phase === 'synthesis'
            ? t('reading.interpretationSynthesis', { total: progress.total })
            : pending || task?.status === 'pending'
              ? t('reading.waiting')
              : t('reading.generating')
    return (
      <>
        {busy && (
          <div
            role="status"
            className="flex items-center justify-between p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)]"
          >
            <span>{progressText}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={kind !== 'figure_explanation' && !task?.task_id}
              onClick={() => void cancel(kind)}
            >
              {t('reading.cancel')}
            </Button>
          </div>
        )}
        {task?.status === 'completed' && (
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
  const floatingResult = floating && !busy ? results[floating] : undefined
  const floatingPreview = floating && busy ? jobs[floating]?.task?.preview?.text : undefined
  const translationSource =
    lastRequest.current?.kind === 'selection_translation'
      ? lastRequest.current.text
      : (floatingResult?.selected_text ?? '')
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
  const openDocumentChat = async (text: string): Promise<void> => {
    if (literatureId) {
      const context = await actions.addContext({
        kind: 'literature',
        source_id: literatureId,
        label: assistantTitle,
        retention: 'next_turn',
        origin: 'explicit',
      })
      if (!context.accepted_ref_ids.length) return
    }
    actions.askAiFromPanel(text)
    focusComposer()
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
      })
    )
    setFloating(null)
  }
  const openSelectionExplanation = (): void => {
    setSelectionExplanationSnapshot(selection)
    setSelectionExplanationDraft('')
    setSelectionExplanationOpen(true)
  }
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
  useSelectionActionContribution(tabId, {
    id: 'pdf-ai',
    order: 5,
    expanded: selectionExplanationOpen,
    replacesDefaults: Boolean(literatureId),
    dismiss: () => {
      setSelectionExplanationOpen(false)
      setSelectionExplanationDraft('')
      setSelectionExplanationSnapshot([])
    },
    actions: literatureId ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          icon={<Icon name="sparkle" size={14} />}
          onClick={openSelectionExplanation}
        >
          {workbenchText('selection.explain')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Globe size={14} />}
          onClick={() => {
            setSelectionExplanationOpen(false)
            void run('selection_translation')
          }}
        >
          {workbenchText('selection.translate')}
        </Button>
      </>
    ) : null,
    panel: selectionExplanationOpen ? (
      <div className="vds-selection-action-result">
        <Textarea
          autoFocus
          label={t('reading.explanationPrompt')}
          labelClassName="!text-[length:var(--vds-font-body-lv2)]"
          placeholder={t('reading.explanationPlaceholder')}
          maxLength={MAX_SELECTION_REQUIREMENT_CHARS}
          rows={2}
          value={selectionExplanationDraft}
          onChange={(event) => setSelectionExplanationDraft(event.target.value)}
        />
        <PromptSettingsGuide
          className="!text-[length:var(--vds-font-body-lv2)] [&_button]:!text-[length:var(--vds-font-body-lv2)]"
          prefix={t('reading.explanationPromptGuide')}
          linkPrefix={t('reading.promptGuideLinkPrefix')}
          linkLabel={t('reading.promptSettings')}
        />
        <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
          {modelControl('selection_explanation')}
          <Button
            size="sm"
            disabled={!selectionExplanationSnapshot.length}
            onClick={submitSelectionExplanation}
          >
            {t('reading.submitExplanation')}
          </Button>
        </div>
      </div>
    ) : null,
  })
  const translated = translationResult?.pages?.find((item) => item.page === page)
  useEffect(() => {
    const selected = selection.map((item) => item.text).join(' ')
    if (!selected) return
    const sentence = translated?.blocks.find(
      (item) => matchReadingText(item.source_text, selected).length > 0
    )
    if (sentence) setActiveSentence(sentence.source_text)
  }, [selection, translated])
  const summary = results.summary?.modules?.summary
  const summaryPreview = isBusy('interpretation')
    ? jobs.interpretation?.task?.preview?.summary
    : undefined
  const visibleSummary = isBusy('interpretation') ? summaryPreview : summary
  const selectSentence = (sentence: TranslationSentence, sourcePage: number): void => {
    setActiveSentence(sentence.source_text)
    if (sentence.located) onLocate(sourcePage, sentence.source_text)
    else setNotice(true)
  }
  const languageScope = (kind: PdfAction): 'literature-document' | 'literature-selection' =>
    kind === 'document_translation' ? 'literature-document' : 'literature-selection'
  const languageControl = (kind: PdfAction) => (
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
            setResults((values) => {
              const { document_translation: _translation, ...remaining } = values
              return remaining
            })
            setTranslationAnchorPage(page)
            setAutomaticTranslation(true)
            exitFigureSelection()
            onExclusiveSurfaceOpen()
            setPanel('document_translation')
            runTranslationPage(page, next)
          } else if (results[kind] || previous) void run(kind, 'summary', undefined, previous, next)
        }}
      />
    </div>
  )
  const toggleInterpretation = (): void => {
    const next = panel === 'interpretation' ? null : 'interpretation'
    if (next) {
      exitFigureSelection()
      onExclusiveSurfaceOpen()
      setAutomaticTranslation(false)
    }
    setPanel(next)
    setPanelExpanded(false)
  }
  const toggleDocumentTranslation = (): void => {
    if (panel === 'document_translation') {
      changeAutomaticTranslation(!automaticTranslation, page)
      return
    }
    exitFigureSelection()
    onExclusiveSurfaceOpen()
    setPanelExpanded(false)
    changeAutomaticTranslation(true, page)
  }
  const selectPanel = (next: PdfAction | null): void => {
    if (panel && next !== panel) void cancel(panel)
    if (next !== 'document_translation') setAutomaticTranslation(false)
    if (next !== panel) setPanelExpanded(false)
    setPanel(next)
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
  const copyingRegionId = useRef<string>()
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
    const active = requestedTranslationPage === sourcePage
    const pageBusy = active && isBusy('document_translation')
    const job = jobs.document_translation
    const preview = pageBusy
      ? job?.task?.preview?.pages?.find((item) => item.page === sourcePage)
      : undefined
    const content = preview ?? translationResult?.pages?.find((item) => item.page === sourcePage)
    const pageFailed = active && Boolean(job?.error || job?.failed)
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
          <CardHeader className="relative mb-0 border-b border-[var(--vds-border-default)] bg-transparent px-[var(--vds-space-2)] py-[calc(var(--vds-space-1)+var(--vds-space-half))]">
            <div className="grid min-w-0 gap-[var(--vds-space-2)]">
              <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                <CardTitle
                  aria-label={t('reading.pageTranslation', { page: sourcePage, total: pageCount })}
                  className="shrink-0 text-[length:var(--vds-font-body-lv1)]! leading-[var(--vds-lh-body-lv1)]!"
                  title={t('reading.pageTranslation', { page: sourcePage, total: pageCount })}
                >
                  {sourcePage}/{pageCount}
                </CardTitle>
                <div className="flex shrink-0 items-center text-[var(--vds-text-secondary)]">
                  <span className="sr-only">{t('reading.autoFollow')}</span>
                  <Switch
                    data-testid={`pdf-translation-auto-${sourcePage}`}
                    checked={automaticTranslation}
                    label={t('reading.automaticTranslation')}
                    onCheckedChange={(checked) => changeAutomaticTranslation(checked, sourcePage)}
                  />
                </div>
                {page === sourcePage ? (
                  modelControl('document_translation')
                ) : (
                  <div className="min-w-0 flex-1" />
                )}
                <IconButton
                  data-testid={`pdf-translation-close-${sourcePage}`}
                  label={t('reading.close')}
                  icon={<X size={14} />}
                  size="sm"
                  variant="ghostIcon"
                  className="ml-auto"
                  onClick={() => selectPanel(null)}
                />
              </div>
              <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                {page === sourcePage ? (
                  languageControl('document_translation')
                ) : (
                  <div className="min-w-0 flex-1" />
                )}
                {page === sourcePage ? (
                  <Tooltip
                    portalled
                    content={content ? t('reading.retranslate') : t('reading.translatePage')}
                    side="top"
                  >
                    <IconButton
                      data-testid={`pdf-translation-retry-${sourcePage}`}
                      className="ml-auto"
                      label={content ? t('reading.retranslate') : t('reading.translatePage')}
                      title={undefined}
                      icon={<RefreshCw size={14} />}
                      size="sm"
                      variant="ghostIcon"
                      onClick={() => runTranslationPage(sourcePage)}
                    />
                  </Tooltip>
                ) : null}
              </div>
            </div>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-y-auto p-[var(--vds-space-5)]">
            {pageBusy && (
              <div
                role="status"
                className="mb-[var(--vds-space-3)] flex items-center justify-between text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]"
              >
                <span>
                  {job?.pending || job?.task?.status === 'pending'
                    ? t('reading.waiting')
                    : t('reading.generating')}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!job?.task?.task_id}
                  onClick={() => void cancel('document_translation')}
                >
                  {t('reading.cancel')}
                </Button>
              </div>
            )}
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
              />
            ) : !pageBusy && !pageFailed ? (
              <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-tertiary)]">
                {automaticTranslation ? t('reading.queuedTranslation') : t('reading.notTranslated')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }
  const interpretationCanGenerate =
    !summary?.contribution &&
    !isBusy('interpretation') &&
    !jobs.interpretation?.error &&
    !jobs.interpretation?.failed
  const openInterpretationChat = (): void => {
    void openDocumentChat(
      summary?.text
        ? t('reading.summaryDraft', { literatureId: assistantTitle, summary: summary.text })
        : t('reading.interpretationDraft', { literatureId: assistantTitle })
    )
  }
  const canAnalyzeSelection = Boolean(literatureId || (projectId && path))
  function modelControl(kind: LiteratureAiModelAction, multimodal = false): React.JSX.Element {
    return (
      <div
        className={`min-w-0 ${kind === 'document_translation' ? 'w-[var(--vds-layout-pdf-translation-model-width)] shrink-0 text-[length:var(--vds-pdf-reading-toolbar-font-size)]' : 'max-w-[var(--vds-pdf-reading-toolbar-action-max-width)]'}`}
      >
        <ModelMenu
          compact
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
    panel,
    figure,
    exitFigureSelection,
    setFigureGuideOpen,
    setPanel: selectPanel,
    translationOpen: panel === 'document_translation',
    translationPage,
    canAnalyzeSelection,
    selectionAnalyzing: isBusy('selection_explanation') || isBusy('selection_translation'),
    explainSelection: (target?: PdfSelection, requirement = '') => {
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
    translateSelection: (target?: PdfSelection) => {
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
                  data-ob="pdf-figure"
                  aria-pressed={figure}
                  label={t('reading.figure')}
                  icon={<Icon name="image" size={14} />}
                  size="sm"
                  variant={figure ? 'primary' : 'outline'}
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
                <IconButton
                  data-testid="pdf-figure-explanation"
                  data-ob="pdf-figure"
                  disabled
                  label={t('reading.figure')}
                  icon={<Icon name="image" size={14} />}
                  size="sm"
                  variant="outline"
                />
              </span>
            </Tooltip>
          )}
          {Object.entries(jobs)
            .filter(
              ([action, job]) =>
                action !== 'figure_explanation' &&
                action !== 'document_translation' &&
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
    railActions: literatureId ? (
      <>
        <Tooltip portalled content={LABELS.document_translation} side="left">
          <IconButton
            data-testid="pdf-document-translation"
            aria-pressed={automaticTranslation}
            label={LABELS.document_translation}
            title={undefined}
            icon={<Globe size={18} />}
            variant={automaticTranslation ? 'primary' : 'ghost'}
            onClick={toggleDocumentTranslation}
          />
        </Tooltip>
        <Tooltip portalled content={LABELS.interpretation} side="left">
          <IconButton
            data-testid="pdf-interpretation"
            label={LABELS.interpretation}
            title={undefined}
            icon={<Icon name="sparkle" size={18} />}
            variant={panel === 'interpretation' ? 'secondary' : 'ghost'}
            onClick={toggleInterpretation}
          />
        </Tooltip>
      </>
    ) : null,
    sidePanel:
      panel === 'interpretation' ? (
        <PdfPanel
          ariaLabel={LABELS[panel]}
          bodyClassName="relative min-h-0 flex-1 overflow-auto text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-pdf-reading-body-line-height)]"
          closeLabel={t('reading.close')}
          expanded={panelExpanded}
          footer={
            <footer className="border-t border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]">
              <Button
                className="w-full"
                icon={<Icon name="sparkle" size={16} />}
                onClick={openInterpretationChat}
              >
                {t('reading.chat')}
              </Button>
            </footer>
          }
          headerAction={
            <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
              {modelControl('interpretation')}
              {summary?.contribution ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isBusy(panel)}
                  onClick={() => void run(panel)}
                >
                  {t('reading.regenerate')}
                </Button>
              ) : null}
            </div>
          }
          icon={<Icon name="sparkle" size={16} />}
          testId="pdf-reading-panel"
          title={LABELS[panel]}
          onClose={() => selectPanel(null)}
          onToggleExpanded={() => setPanelExpanded((value) => !value)}
        >
          {feedback(panel)}
          {visibleSummary?.contribution ? (
            <Summary
              value={visibleSummary}
              provisional={Boolean(summaryPreview)}
              onSource={onLocate}
            />
          ) : (
            !isBusy('interpretation') && (
              <div className="grid gap-[var(--vds-space-5)] p-[var(--vds-space-5)]">
                <div className="grid gap-[var(--vds-space-2)]">
                  <h3 className="m-0 text-[length:var(--vds-font-title)] font-[var(--vds-fw-semibold)]">
                    {t('reading.introTitle')}
                  </h3>
                  <p className="m-0 text-[var(--vds-text-tertiary)]">
                    {t('reading.introDescription')}
                  </p>
                </div>
                {interpretationCanGenerate && (
                  <Button
                    data-testid="pdf-generate-summary"
                    className="w-full"
                    icon={<Icon name="sparkle" size={16} />}
                    onClick={() => void run('interpretation')}
                  >
                    {t('reading.generateSummary')}
                  </Button>
                )}
              </div>
            )
          )}
        </PdfPanel>
      ) : null,
    floating: floating ? (
      <FloatingWindow
        key={floating}
        initialSize={floating === 'figure_explanation' ? FIGURE_WINDOW_SIZE : undefined}
        initialHorizontalCenterRef={
          floating === 'selection_translation' || floating === 'figure_explanation'
            ? viewportRef
            : undefined
        }
        ghostIconHeader={floating === 'figure_explanation'}
        plainFooter={floating === 'figure_explanation'}
        title={LABELS[floating]}
        onClose={() => {
          setFloating(null)
          if (floating === 'figure_explanation') {
            void cancel('figure_explanation')
            exitFigureSelection()
          }
        }}
        footer={
          <>
            {floating === 'figure_explanation' && (
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
            )}
            {floating !== 'figure_explanation' && canAnnotate ? (
              <Button
                variant="outline"
                size="sm"
                icon={
                  annotationIdentity === annotatedResult ? (
                    <Check size={14} />
                  ) : (
                    <Icon name="annotation" size={14} />
                  )
                }
                loading={annotating}
                disabled={
                  !floatingResult || busy || annotating || annotationIdentity === annotatedResult
                }
                onClick={() => void addResultComment()}
              >
                {t(
                  annotationIdentity === annotatedResult
                    ? 'reading.addedToAnnotation'
                    : 'reading.addToAnnotation'
                )}
              </Button>
            ) : null}
            <CopyButton
              key={floatingResult?.text ?? figureText}
              value={floatingResult?.text ?? figureText}
              writeText={writeClipboard}
              disabled={!floatingResult && !figureText}
              size={floating === 'figure_explanation' ? 'default' : 'sm'}
              variant={floating === 'figure_explanation' ? 'outline' : 'ghost'}
              stableLabelWidth={floating !== 'figure_explanation'}
              icon={floating === 'figure_explanation' ? <Copy /> : <Icon name="copy" size={14} />}
            />
            {floating !== 'figure_explanation' && (
              <Button
                disabled={!floatingResult}
                size="sm"
                variant="primary"
                icon={<Icon name="talk" size={14} />}
                onClick={quote}
              >
                {t('reading.ask')}
              </Button>
            )}
          </>
        }
      >
        {(floating === 'selection_translation' || floating === 'selection_explanation') && (
          <div className="flex flex-wrap items-center justify-between gap-[var(--vds-space-2)] border-b border-[var(--vds-border-default)] p-[var(--vds-space-3)]">
            {modelControl(floating)}
            {floating === 'selection_translation' && languageControl(floating)}
            <Button
              data-testid={`pdf-${floating}-regenerate`}
              variant="outline"
              size="sm"
              disabled={busy || !lastRequest.current}
              onClick={() => {
                const request = requests.current[floating]
                if (request)
                  void run(
                    floating,
                    request.module,
                    undefined,
                    request,
                    directions[floating] ?? request.target_language
                  )
              }}
            >
              {t('reading.regenerate')}
            </Button>
          </div>
        )}
        {floating === 'selection_translation' && (
          <Collapsible
            key={lastRequest.current?.client_attempt_id}
            className="cursor-text select-text border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]"
          >
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                {t('reading.source')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p>{translationSource}</p>
            </CollapsibleContent>
          </Collapsible>
        )}
        <div className={floating === 'figure_explanation' ? 'flex h-full min-h-0 flex-col' : ''}>
          {floating === 'figure_explanation' && (
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
                        <Markdown text={floatingResult?.text ?? figureText} />
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
          )}
          {floating !== 'figure_explanation' && (
            <div className="min-h-0 flex-1 overflow-auto">
              {feedback(floating)}
              <div className="cursor-text select-text p-[var(--vds-space-5)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-pdf-reading-content-line-height)]">
                <h3 className="mb-[var(--vds-space-3)] font-[var(--vds-fw-semibold)]">
                  {floating === 'selection_translation' ? t('reading.translation') : ''}
                </h3>
                {floating === 'selection_translation' && floatingResult?.blocks ? (
                  <Translation
                    sentences={floatingResult.blocks}
                    active={activeSentence}
                    onSelect={(sentence) => selectSentence(sentence, floatingResult.page)}
                  />
                ) : floatingResult ? (
                  output(floatingResult, true)
                ) : floatingPreview ? (
                  <Markdown text={floatingPreview} />
                ) : (
                  <p className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                    {t('reading.selectionScope')}
                  </p>
                )}
                {floating === 'selection_translation' ? (
                  <PromptSettingsGuide
                    className="mt-[var(--vds-space-3)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]"
                    prefix={t('reading.translationPromptGuide')}
                    linkLabel={t('reading.promptSettings')}
                    suffix={t('reading.promptGuideSuffix')}
                  />
                ) : null}
              </div>
            </div>
          )}
        </div>
      </FloatingWindow>
    ) : null,
  }
}
