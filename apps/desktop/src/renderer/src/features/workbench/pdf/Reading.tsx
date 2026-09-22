import { MAX_SELECTION_REQUIREMENT_CHARS, selectionInstruction, type SelectionPromptAction } from '../../../../../prompts'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, CopyButton, HoverCard, HoverCardContent, HoverCardTrigger, IconButton, Switch, Textarea, Tooltip, useToast } from '../../../components/ui'
import { FloatingWindow } from '../../../components/primitive/FloatingWindow'
import { Markdown } from '../../../components/primitive/Markdown'
import { writeClipboard } from '../../../components/primitive/clipboard'
import { ModelMenu } from '../../../components/business/ModelMenu'
import { PromptSettingsGuide } from '../../../components/business/PromptSettingsGuide'
import { isAssistantTranslationTarget } from '../../../contracts/assistant'
import { Icon } from '../../../icons'
import { focusComposer } from '../../../reference'
import { useApp } from '../../../store'
import { requestModelKey } from '../../../catalog'
import type { ModelInfo } from '../../../api'
import { useSelectionActionContribution } from '../actions'
import { evidencePages } from './evidence'
import { Summary } from './Summary'
import { Crop } from './Crop'
import { replaceSubmission } from './submissions'
import { Language, Translation } from './Translation'
import { defaultTranslationTarget, readTranslationTarget, writeTranslationTarget } from '../../../components/business/Language'
import { PDF_AI_IMAGE_INPUT_UNSUPPORTED, pdfAiCaughtFailure, pdfAiFailure, pdfAiFailureRecovery, pdfAiFailureText, type PdfAiFailure } from './failure'
import { mergeTranslationResult, nextTranslationPage } from './sequence'
import { PdfPanel } from './Panel'
import type { PdfSelection, TranslationDirection, TranslationSentence } from './analysis'
import { PDF_AI_PREFIX, invokeFigure, pdfAiApi, pdfResponseLanguage, type PdfAction, type PdfAiContent, type PdfAiRequest, type PdfAiResult, type PdfAiTask, type PdfVisualRegion } from './analysis'
import type { Size } from './geometry'

const SELECTION_PROMPTS: Partial<Record<PdfAction, SelectionPromptAction>> = { selection_translation: 'translate', selection_explanation: 'explain', figure_explanation: 'figure' }
const REPLACEABLE_ACTIONS = new Set<PdfAction>(['selection_translation', 'selection_explanation', 'figure_explanation', 'formula_latex'])
const SELECTION_ACTIONS = new Set<PdfAction>(['selection_translation', 'selection_explanation'])
const IMAGE_INPUT_ACTIONS = new Set<PdfAction>(['figure_explanation', 'formula_latex'])
const POLL_MS = 600
const FIGURE_WINDOW_SIZE = { width: 520, height: 600 }
const FIGURE_GUIDE_SOURCE_WIDTH_PX = 700
const FIGURE_GUIDE_SCALE = 4 / 7
const FIGURE_GUIDE_WIDTH_PX = FIGURE_GUIDE_SOURCE_WIDTH_PX * FIGURE_GUIDE_SCALE
const FIGURE_GUIDE_VIEWPORT_GUTTER_PX = 32
const LITERATURE_MODEL_ACTIONS = new Set<PdfAction>(['document_translation', 'selection_translation', 'interpretation', 'figure_explanation'])
const MULTIMODAL_MODEL_FILTER = (model: ModelInfo): boolean => model.image_input === true
interface Job { task?: PdfAiTask; pending?: boolean; error?: PdfAiFailure; failed?: boolean }
interface FigureRegion { page: number; rect: number[] }
const jobBusy = (job?: Job): boolean => Boolean(job?.pending || job?.task?.status === 'pending' || job?.task?.status === 'running')

function FigureGuide({ t }: { t: (key: string) => string }): React.JSX.Element {
  return <div className="grid items-center" style={{ gridTemplateColumns: '220px minmax(0, 1fr)' }}>
    <div className="flex flex-col items-center gap-3 pr-6">
      <svg aria-hidden="true" height="190" viewBox="0 0 240 240" width="190">
        <rect x="20" y="16" width="196" height="190" fill="none" stroke="var(--vds-text-tertiary)" strokeDasharray="7 7" strokeWidth="2" />
        <g fill="var(--vds-text-tertiary)">
          <rect x="14" y="10" width="12" height="12" /><rect x="210" y="10" width="12" height="12" />
          <rect x="14" y="200" width="12" height="12" /><rect x="210" y="200" width="12" height="12" />
        </g>
        <path d="M44 36V132H194" fill="none" stroke="var(--vds-text-tertiary)" strokeWidth="3" />
        <g fill="var(--vds-text-tertiary)" opacity=".42">
          <rect x="58" y="96" width="24" height="36" /><rect x="92" y="78" width="24" height="54" />
          <rect x="126" y="58" width="24" height="74" /><rect x="160" y="36" width="24" height="96" />
        </g>
        <g fill="var(--vds-border-default)">
          <rect x="44" y="150" width="142" height="8" rx="4" /><rect x="44" y="166" width="142" height="8" rx="4" />
          <rect x="44" y="182" width="104" height="8" rx="4" />
        </g>
        <path d="M178 168L190 224L202 207L220 223L230 212L212 196L230 184L178 168Z" fill="var(--vds-bg-white-default)" stroke="var(--vds-text-tertiary)" strokeLinejoin="round" strokeWidth="4" />
      </svg>
      <span className="text-[16px] leading-[24px] text-[var(--vds-text-secondary)]">{t('reading.figureGuide.caption')}</span>
    </div>
    <div className="min-w-0 border-l border-[var(--vds-border-default)] pl-6">
      <h3 className="m-0 text-[24px] font-semibold leading-[32px]">{t('reading.figureGuide.title')}</h3>
      <p className="mb-0 mt-2 text-[14px] leading-[22px] text-[var(--vds-text-secondary)]">{t('reading.figureGuide.description')}</p>
      <h4 className="mb-3 mt-5 text-[16px] font-semibold leading-[24px]">{t('reading.figureGuide.method')}</h4>
      <ol className="m-0 grid list-none gap-2 p-0 text-[14px] leading-[24px] text-[var(--vds-text-secondary)]">
        {[t('reading.figureGuide.step1'), t('reading.figureGuide.step2'), t('reading.figureGuide.step3')].map((step, index) => <li key={step} className="grid items-start gap-2" style={{ gridTemplateColumns: '28px minmax(0, 1fr)' }}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--vds-surface-muted)] font-medium text-[var(--vds-brand-text-primary)]">{index + 1}</span><span>{step}</span></li>)}
      </ol>
      <p className="mb-0 mt-4 text-[14px] leading-[22px] text-[var(--vds-text-tertiary)]">{t('reading.figureGuide.exit')}</p>
    </div>
  </div>
}

export function usePdfAnalysis({ active, literatureId, attachmentId, title, path, assetId, projectId, revision, tabId, page, pageCount, selection, canAnnotate, onAddComment, onNavigate, onLocate, onDocumentTranslationChange, onExclusiveSurfaceOpen }: {
  active: boolean
  literatureId: string; attachmentId: string; title: string; path: string; assetId: string; projectId: string; revision: string; tabId: string; page: number; pageCount: number
  selection: PdfSelection[]
  canAnnotate: boolean
  onAddComment: (selection: PdfSelection, body: string) => Promise<boolean>
  onNavigate: (page: number) => void
  onLocate: (page: number, text: string) => void
  onDocumentTranslationChange: (open: boolean) => void
  onExclusiveSurfaceOpen: () => void
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
  const [selectionExplanationSnapshot, setSelectionExplanationSnapshot] = useState<PdfSelection[]>([])
  const [annotating, setAnnotating] = useState(false)
  const [annotatedResult, setAnnotatedResult] = useState('')
  const [figure, setFigure] = useState(false)
  const [figureGuideOpen, setFigureGuideOpen] = useState(false)
  const exitFigureSelection = useCallback((): void => { setFigure(false); setFigureGuideOpen(false) }, [])
  const figureAbort = useRef<AbortController | null>(null)
  const lastFigureRegion = useRef<FigureRegion | null>(null)
  const [figureText, setFigureText] = useState('')
  const [automaticTranslation, setAutomaticTranslation] = useState(false)
  const [translationAnchorPage, setTranslationAnchorPage] = useState(page)
  const [directions, setDirections] = useState<Partial<Record<PdfAction, TranslationDirection>>>(() => ({
    document_translation: readTranslationTarget('literature-document'),
    selection_translation: readTranslationTarget('literature-selection')
  }))
  const [activeSentence, setActiveSentence] = useState('')
  const [results, setResults] = useState<Record<string, PdfAiResult>>({})
  const [jobs, setJobs] = useState<Partial<Record<PdfAction, Job>>>({})
  useEffect(() => onDocumentTranslationChange(panel === 'document_translation'), [onDocumentTranslationChange, panel])
  const jobsRef = useRef(jobs)
  const updateJob = (kind: PdfAction, change: Partial<Job>): void => {
    jobsRef.current = { ...jobsRef.current, [kind]: { ...jobsRef.current[kind], ...change } }
    setJobs(jobsRef.current)
  }
  const [notice, setNotice] = useState(false)
  const [cropPreview, setCropPreview] = useState('')
  const requests = useRef<Partial<Record<PdfAction, PdfAiRequest>>>({})
  const submissions = useRef<Partial<Record<PdfAction, Promise<PdfAiTask | undefined>>>>({})
  const lastRequest = { current: floating ? requests.current[floating] : undefined }
  const isBusy = (kind: PdfAction): boolean => jobBusy(jobsRef.current[kind])
  const busy = floating ? isBusy(floating) : false
  const assistantModelKey = requestModelKey(state.catalog.models, state.model, state.activeSession, state.threads)
  const actionModelKey = (kind: PdfAction): string => {
    const preferenceAction = kind === 'formula_latex' ? 'figure_explanation' : kind
    return LITERATURE_MODEL_ACTIONS.has(preferenceAction)
      ? state.literatureAiModels[preferenceAction as keyof typeof state.literatureAiModels] || assistantModelKey
      : assistantModelKey
  }
  const figureModel = state.catalog.models.find(model => model.key === actionModelKey('figure_explanation'))
  const figureModelSupportsImageInput = Boolean(figureModel && !figureModel.disabled && figureModel.image_input === true)
  const responseLanguage = pdfResponseLanguage(i18n.resolvedLanguage || i18n.language)
  const identity = JSON.stringify([literatureId, projectId, assetId, path, revision, responseLanguage])
  const selectionIdentity = JSON.stringify(selection)
  const currentIdentity = useRef(identity)
  const loadSequence = useRef(0)
  currentIdentity.current = identity
  const load = async (): Promise<void> => {
    if (!literatureId) return
    const sequence = ++loadSequence.current
    const data = await pdfAiApi<Record<string, PdfAiResult>>(`/api/literature/${encodeURIComponent(literatureId)}/ai/results?source_revision=${encodeURIComponent(revision)}`)
    if (data.interpretation && data.interpretation.response_language !== responseLanguage) delete data.interpretation
    if (currentIdentity.current === identity && sequence === loadSequence.current) setResults(data)
  }
  useEffect(() => {
    figureAbort.current?.abort()
    figureAbort.current = null
    setResults({}); jobsRef.current = {}; setJobs({}); requests.current = {}; submissions.current = {}; lastFigureRegion.current = null; setCropPreview(''); setFigureText(''); setFigure(false); setFigureGuideOpen(false); setFloating(null); setSelectionExplanationOpen(false); setSelectionExplanationDraft(''); setSelectionExplanationSnapshot([]); setAnnotatedResult(''); setAutomaticTranslation(false); setTranslationAnchorPage(page); setPanel(null); setPanelExpanded(false)
    return () => figureAbort.current?.abort()
  }, [identity])
  useEffect(() => {
    setSelectionExplanationOpen(false)
    setSelectionExplanationDraft('')
    setSelectionExplanationSnapshot([])
  }, [selectionIdentity])
  useEffect(() => { if (active) void load().catch(() => {}) }, [active, identity])
  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    let polling = false
    const poll = async (): Promise<void> => {
      if (polling) return
      polling = true
      try {
        await Promise.all(Object.entries(jobsRef.current).map(async ([action, job]) => {
          if (!job.task?.task_id || !jobBusy(job)) return
          const kind = action as PdfAction
          try {
            const next = await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${job.task.task_id}`)
            if (stopped || currentIdentity.current !== identity || jobsRef.current[kind]?.task?.task_id !== job.task.task_id) return
            if (next.status === 'completed' && next.result) {
              if (kind === 'document_translation') {
                setResults(previous => ({
                  ...previous,
                  document_translation: mergeTranslationResult(previous.document_translation, next.result!),
                }))
              }
              else if (literatureId && kind !== 'figure_explanation' && kind !== 'formula_latex') await load()
              else {
                if (kind === 'figure_explanation') setCropPreview('')
                setResults(previous => ({ ...previous, [kind]: next.result! }))
              }
            }
            updateJob(kind, { task: next, error: pdfAiFailure(next), failed: next.status === 'failed' })
          } catch (cause) { if (!stopped && jobsRef.current[kind]?.task?.task_id === job.task.task_id) updateJob(kind, { error: pdfAiCaughtFailure(cause), failed: true }) }
        }))
      } finally { polling = false }
    }
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [active, identity])

  const run = async (kind: PdfAction, module = 'summary', region?: { page: number; rect?: number[]; region_id?: string; kind?: PdfVisualRegion['kind'] }, retry?: PdfAiRequest, language = directions[kind] ?? defaultTranslationTarget(i18n.resolvedLanguage || i18n.language, selection.map(value => value.text).join('\n')), requestedPage?: number, selected = selection, instruction?: string): Promise<void> => {
    const replacing = isBusy(kind)
    if (replacing && !REPLACEABLE_ACTIONS.has(kind)) return
    const previous = replacing ? submissions.current[kind] : undefined
    if (IMAGE_INPUT_ACTIONS.has(kind) && !figureModelSupportsImageInput) {
      updateJob(kind, {
        error: { code: PDF_AI_IMAGE_INPUT_UNSUPPORTED, diagnostic: '' },
        failed: true,
        pending: false,
        task: { task_id: '', status: 'failed' },
      })
      return
    }
    updateJob(kind, { error: undefined, failed: false, task: undefined, pending: true }); setNotice(false)
    const request: PdfAiRequest = {
      instruction: retry ? retry.instruction : instruction ?? (SELECTION_PROMPTS[kind] ? state.selectionPrompts[SELECTION_PROMPTS[kind]!] : undefined),
      literature_id: literatureId, attachment_id: attachmentId, path, asset_id: assetId, project_id: projectId, revision,
      model_key: actionModelKey(kind), kind, module,
      page: requestedPage ?? region?.page ?? selected[0]?.page ?? page, text: selected.map(value => value.text).join('\n'),
      rect: region?.rect, region_id: region?.region_id, visual_kind: region?.kind,
      quads: selected.filter(value => value.page === (selected[0]?.page ?? page)).flatMap(value => value.quads),
      ...(retry ? { page: retry.page, text: retry.text, rect: retry.rect, region_id: retry.region_id, visual_kind: retry.visual_kind, quads: retry.quads } : {}),
      client_action_id: crypto.randomUUID(), client_attempt_id: crypto.randomUUID(), target_language: language,
      response_language: responseLanguage
    }
    requests.current[kind] = request
    const isCurrent = (): boolean => currentIdentity.current === identity && requests.current[kind] === request
    if (SELECTION_ACTIONS.has(kind)) {
      setResults(previous => {
        const { [kind]: _stale, ...remaining } = previous
        return remaining
      })
    }
    if (['selection_translation', 'selection_explanation', 'figure_explanation'].includes(kind)) {
      setAnnotatedResult('')
      setFloating(kind)
    }
    else setFloating(null)
    if (kind === 'figure_explanation') setCropPreview('')
    let figureController: AbortController | undefined
    try {
      if (kind === 'figure_explanation') {
        figureAbort.current?.abort()
        figureController = new AbortController()
        figureAbort.current = figureController
        setFigureText('')
        const result = await invokeFigure(request, figureController.signal, preview => {
          if (!isCurrent()) return
          setCropPreview(preview.crop)
          setFigureText(preview.text)
          updateJob(kind, { task: { task_id: '', status: preview.text ? 'running' : 'pending' } })
        })
        if (isCurrent()) {
          setCropPreview(result.crop ?? '')
          setFigureText(result.text)
          setResults(previousResults => ({ ...previousResults, [kind]: result }))
          updateJob(kind, { task: { task_id: '', status: 'completed', result } })
        }
        return
      }
      const submission = replaceSubmission(previous, isCurrent,
        () => pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks`, request),
        taskId => pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${taskId}/cancel`, {}))
      submissions.current[kind] = submission
      const next = await submission
      if (isCurrent() && next) {
        updateJob(kind, { task: next, error: pdfAiFailure(next), failed: next.status === 'failed' })
      }
    } catch (cause) {
      if (isCurrent()) {
        const cancelled = kind === 'figure_explanation' && figureController?.signal.aborted
        if (kind === 'figure_explanation' && !cancelled) setFigureText('')
        updateJob(kind, cancelled
          ? { error: undefined, failed: false, task: { task_id: '', status: 'cancelled' } }
          : { error: pdfAiCaughtFailure(cause), failed: true, task: { task_id: '', status: 'failed' } })
      }
    }
    finally {
      if (isCurrent()) updateJob(kind, { pending: false })
      if (kind === 'figure_explanation' && figureAbort.current === figureController) figureAbort.current = null
    }
  }
  const translationResult = results.document_translation
  const requestedTranslationPage = requests.current.document_translation?.page
  const translatedPageNumbers = translationResult?.pages?.map(item => item.page) ?? []
  const translationLanguage = (): TranslationDirection => {
    const selected = directions.document_translation
    if (selected) return selected
    return isAssistantTranslationTarget(translationResult?.target_language)
      ? translationResult.target_language
      : defaultTranslationTarget(i18n.resolvedLanguage || i18n.language, translationResult?.source_language ?? '')
  }
  const runTranslationPage = (sourcePage: number, language = translationLanguage()): void => {
    void run('document_translation', 'summary', undefined, undefined, language, sourcePage)
  }
  const changeAutomaticTranslation = (checked: boolean, sourcePage: number): void => {
    if (checked) {
      exitFigureSelection()
      onExclusiveSurfaceOpen()
      setPanel('document_translation')
      setTranslationAnchorPage(sourcePage)
      if (jobsRef.current.document_translation?.failed || jobsRef.current.document_translation?.task?.status === 'cancelled') {
        updateJob('document_translation', { error: undefined, failed: false, task: undefined })
      }
    }
    setAutomaticTranslation(checked)
  }
  useEffect(() => {
    if (!automaticTranslation || pageCount < 1 || isBusy('document_translation') || jobsRef.current.document_translation?.failed) return
    const nextPage = nextTranslationPage(translationAnchorPage, pageCount, translatedPageNumbers)
    if (nextPage !== undefined) runTranslationPage(nextPage)
  }, [automaticTranslation, translationAnchorPage, pageCount, translationResult?.pages])
  useEffect(() => {
    if (automaticTranslation && jobs.document_translation?.failed) setAutomaticTranslation(false)
  }, [automaticTranslation, jobs.document_translation?.failed])
  const cancel = async (kind: PdfAction): Promise<void> => {
    if (kind === 'figure_explanation') {
      if (!figureAbort.current) return
      figureAbort.current.abort()
      figureAbort.current = null
      updateJob(kind, { pending: false, task: { task_id: '', status: 'cancelled' } })
      return
    }
    const task = jobsRef.current[kind]?.task
    if (!task?.task_id) return
    const next = await pdfAiApi<PdfAiTask>(`${PDF_AI_PREFIX}/tasks/${task.task_id}/cancel`, {})
    if (currentIdentity.current === identity && jobsRef.current[kind]?.task?.task_id === task.task_id) updateJob(kind, { task: next })
  }
  const output = (content: PdfAiContent, showEvidence = true): React.JSX.Element => <>
    <Markdown text={content.text ?? ''} />
    {content.uncertain && <p className="mt-3 text-sm text-[var(--vds-text-tertiary)]">{t('reading.uncertain')}</p>}
    {showEvidence && evidencePages(content.evidence).map(anchor => <Button key={anchor.page} variant="ghost" size="sm" title={anchor.quote} onClick={() => onNavigate(anchor.page)}>{t('reading.evidencePage', { page: anchor.page })}</Button>)}
  </>
  const feedback = (kind: PdfAction): React.JSX.Element => {
    const { task, error, pending, failed } = jobs[kind] ?? {}
    const busy = isBusy(kind)
    const recovery = pdfAiFailureRecovery(error)
    const progress = task?.progress
    const progressText = progress?.phase === 'segment'
      ? t('reading.interpretationSegment', { current: progress.current, total: progress.total })
      : progress?.phase === 'synthesis' && progress.cached === progress.total
        ? t('reading.interpretationCachedSynthesis', { cached: progress.cached, total: progress.total })
        : progress?.phase === 'synthesis'
          ? t('reading.interpretationSynthesis', { total: progress.total })
          : pending || task?.status === 'pending' ? t('reading.waiting') : t('reading.generating')
    return <>
    {busy && <div role="status" className="flex items-center justify-between p-3 text-sm"><span>{progressText}</span><Button variant="ghost" size="sm" disabled={kind !== 'figure_explanation' && !task?.task_id} onClick={() => void cancel(kind)}>{t('reading.cancel')}</Button></div>}
    {task?.status === 'completed' && <p role="status" className="px-4 py-2 text-sm text-[var(--vds-text-tertiary)]">{t('reading.completed')}</p>}
    {task?.status === 'cancelled' && <p role="status" className="p-3">{t('reading.cancelled')}</p>}
    {(error || failed) && <div role="alert" className="p-4 text-sm text-[var(--vds-text-secondary)]"><p className="whitespace-pre-wrap">{error ? pdfAiFailureText(error, t) : t('reading.failed')}</p><div className="mt-2 flex gap-2">{recovery.configure && <Button size="sm" variant="outline" onClick={() => actions.openSettings('models')}>{t('reading.configure')}</Button>}{recovery.reselect && <Button size="sm" variant="outline" onClick={() => setFloating(null)}>{t('reading.reselect')}</Button>}{recovery.retry && <Button size="sm" variant="outline" disabled={busy} onClick={() => { const request = requests.current[kind]; if (request) void run(request.kind, request.module, undefined, request); else if (kind === 'figure_explanation' && lastFigureRegion.current) startFigure(lastFigureRegion.current) }}>{t('reading.retry')}</Button>}</div></div>}
    {notice && <p role="status" className="p-3 text-sm">{t('reading.unlocated')}</p>}
  </> }
  const floatingResult = floating && !busy ? results[floating] : undefined
  const translationSource = lastRequest.current?.kind === 'selection_translation'
    ? lastRequest.current.text : floatingResult?.selected_text ?? ''
  const annotationIdentity = floatingResult ? JSON.stringify([
    floatingResult.kind,
    floatingResult.revision,
    floatingResult.page,
    floatingResult.selected_text,
    floatingResult.text
  ]) : ''
  const addResultComment = async (): Promise<void> => {
    if (!floatingResult || annotating || annotationIdentity === annotatedResult) return
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
  const quote = (): void => {
    if (!floatingResult) return
    actions.askAiFromPanel(t('reading.selectionDraft', {
      literatureId: title,
      page: floatingResult.page,
      revision: floatingResult.revision,
      source: floatingResult.selected_text,
      result: floatingResult.text,
    }))
    setFloating(null)
    focusComposer()
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
    id: 'pdf-ai', order: 5, expanded: selectionExplanationOpen, replacesDefaults: Boolean(literatureId),
    dismiss: () => { setSelectionExplanationOpen(false); setSelectionExplanationDraft(''); setSelectionExplanationSnapshot([]) },
    actions: literatureId ? <><Button variant="ghost" size="sm" icon={<Icon name="sparkle" size={14} />} onClick={openSelectionExplanation}>{workbenchText('selection.explain')}</Button><Button variant="ghost" size="sm" icon={<Icon name="globe" size={14} />} onClick={() => { setSelectionExplanationOpen(false); void run('selection_translation') }}>{workbenchText('selection.translate')}</Button></> : null,
    panel: selectionExplanationOpen ? <div className="vds-selection-action-result"><Textarea autoFocus label={t('reading.explanationPrompt')} placeholder={t('reading.explanationPlaceholder')} maxLength={MAX_SELECTION_REQUIREMENT_CHARS} rows={2} value={selectionExplanationDraft} onChange={(event) => setSelectionExplanationDraft(event.target.value)} /><PromptSettingsGuide prefix={t('reading.explanationPromptGuide')} linkPrefix={t('reading.promptGuideLinkPrefix')} linkLabel={t('reading.promptSettings')} /><Button className="justify-self-start" size="sm" disabled={!selectionExplanationSnapshot.length} onClick={submitSelectionExplanation}>{t('reading.submitExplanation')}</Button></div> : null
  })
  const translated = translationResult?.pages?.find(item => item.page === page)
  useEffect(() => {
    const selected = selection.map(item => item.text).join(' ').replace(/\s+/g, '').toLowerCase()
    if (!selected) return
    const sentence = translated?.blocks.find(item => item.source_text.replace(/\s+/g, '').toLowerCase().includes(selected))
    if (sentence) setActiveSentence(sentence.source_text)
  }, [selection, translated])
  const summary = results.summary?.modules?.summary
  const selectSentence = (sentence: TranslationSentence, sourcePage: number): void => {
    setActiveSentence(sentence.source_text)
    if (sentence.located) onLocate(sourcePage, sentence.source_text)
    else setNotice(true)
  }
  const languageScope = (kind: PdfAction): 'literature-document' | 'literature-selection' => kind === 'document_translation' ? 'literature-document' : 'literature-selection'
  const languageControl = (kind: PdfAction) => <Language value={directions[kind] ?? defaultTranslationTarget(i18n.resolvedLanguage || i18n.language, kind === 'document_translation' ? (translationResult?.source_language ?? '') : selection.map(value => value.text).join('\n'))} disabled={isBusy(kind)} onChange={next => {
    writeTranslationTarget(languageScope(kind), next)
    setDirections(values => ({ ...values, [kind]: next })); setActiveSentence('')
    const previous = requests.current[kind]
    if (kind === 'document_translation') {
      const hasTranslation = Boolean(results.document_translation || previous)
      setResults(values => {
        const { document_translation: _translation, ...remaining } = values
        return remaining
      })
      setTranslationAnchorPage(page)
      if (hasTranslation) runTranslationPage(page, next)
    }
    else if (results[kind] || previous) void run(kind, 'summary', undefined, previous, next)
  }} />
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
      setAutomaticTranslation(false)
      setPanel(null)
      return
    }
    exitFigureSelection()
    onExclusiveSurfaceOpen()
    setPanelExpanded(false)
    changeAutomaticTranslation(true, page)
  }
  const selectPanel = (next: PdfAction | null): void => {
    if (next !== 'document_translation') setAutomaticTranslation(false)
    if (next !== panel) setPanelExpanded(false)
    setPanel(next)
  }
  const clearFigureResult = (): void => {
    setFigureText('')
    setCropPreview('')
    setResults(previous => {
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
        task: { task_id: '', status: 'failed' }
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
    void run('figure_explanation', 'all', region)
  }
  const copiedLatex = useRef('')
  const copyFormula = (region: PdfVisualRegion): void => {
    copiedLatex.current = ''
    setResults(previous => {
      const { formula_latex: _stale, ...remaining } = previous
      return remaining
    })
    void run('formula_latex', 'all', region)
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
  const translationPage = (sourcePage: number, pageSize: Size, pageScale: number): React.JSX.Element => {
    const content = translationResult?.pages?.find(item => item.page === sourcePage)
    const active = requestedTranslationPage === sourcePage
    const pageBusy = active && isBusy('document_translation')
    const job = jobs.document_translation
    const pageFailed = active && Boolean(job?.error || job?.failed)
    const recovery = pdfAiFailureRecovery(job?.error)
    return <div className="min-w-0" data-testid={`pdf-translation-page-${sourcePage}`} data-translation-page={sourcePage} style={{ width: pageSize.width * pageScale, height: pageSize.height * pageScale }}>
      <Card
        padding="none"
        className={`box-border flex flex-col overflow-hidden rounded-none! bg-[var(--vds-bg-white-default)] shadow-[var(--vds-shadow-1)]${page === sourcePage ? ' ring-1 ring-[var(--vds-border-strong)]' : ''}`}
        style={{ width: pageSize.width, height: pageSize.height, zoom: pageScale }}
      >
        <CardHeader className="border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-2">
              <CardTitle>{t('reading.pageTranslation', { page: sourcePage, total: pageCount })}</CardTitle>
              <div className="flex items-center gap-2 text-xs text-[var(--vds-text-secondary)]">
                <span>{t('reading.autoFollow')}</span>
                <Switch
                  data-testid={`pdf-translation-auto-${sourcePage}`}
                  checked={automaticTranslation}
                  label={t('reading.automaticTranslation')}
                  variant="text"
                  onCheckedChange={checked => changeAutomaticTranslation(checked, sourcePage)}
                />
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                data-testid={`pdf-translation-retry-${sourcePage}`}
                size="sm"
                variant="ghost"
                disabled={isBusy('document_translation')}
                onClick={() => runTranslationPage(sourcePage)}
              >{content ? t('reading.retranslate') : t('reading.translatePage')}</Button>
              <IconButton label={t('reading.close')} icon={<Icon name="close" size={14} />} size="sm" variant="ghostIcon" onClick={() => selectPanel(null)} />
            </div>
          </div>
          {page === sourcePage ? <div className="flex min-w-0 flex-wrap items-center gap-2 pt-2">{modelControl('document_translation')}{languageControl('document_translation')}</div> : null}
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-5">
          {pageBusy && <div role="status" className="mb-3 flex items-center justify-between text-sm text-[var(--vds-text-secondary)]"><span>{job?.pending || job?.task?.status === 'pending' ? t('reading.waiting') : t('reading.generating')}</span><Button variant="ghost" size="sm" disabled={!job?.task?.task_id} onClick={() => void cancel('document_translation')}>{t('reading.cancel')}</Button></div>}
          {pageFailed && <div role="alert" className="mb-3 text-sm text-[var(--vds-text-secondary)]"><p className="whitespace-pre-wrap">{job?.error ? pdfAiFailureText(job.error, t) : t('reading.failed')}</p><div className="mt-2 flex gap-2">{recovery.configure && <Button size="sm" variant="outline" onClick={() => actions.openSettings('models')}>{t('reading.configure')}</Button>}{recovery.retry && <Button size="sm" variant="outline" disabled={pageBusy} onClick={() => runTranslationPage(sourcePage)}>{t('reading.retry')}</Button>}</div></div>}
          {pageBusy && content && <p className="mb-3 text-xs text-[var(--vds-text-tertiary)]">{t('reading.previousResult')}</p>}
          {content ? <Translation sentences={content.blocks} active={activeSentence} onSelect={sentence => selectSentence(sentence, sourcePage)} /> : !pageBusy && !pageFailed ? <p className="text-sm text-[var(--vds-text-tertiary)]">{automaticTranslation ? t('reading.queuedTranslation') : t('reading.notTranslated')}</p> : null}
        </CardContent>
      </Card>
    </div>
  }
  const interpretationCanGenerate = !summary?.contribution
    && !isBusy('interpretation')
    && !jobs.interpretation?.error
    && !jobs.interpretation?.failed
  const openInterpretationChat = (): void => {
    actions.askAiFromPanel(summary?.text
      ? t('reading.summaryDraft', { literatureId, summary: summary.text })
      : t('reading.interpretationDraft', { literatureId: title }))
    focusComposer()
  }
  const canAnalyzeSelection = Boolean(literatureId || (projectId && path))
  const modelControl = (kind: 'document_translation' | 'selection_translation' | 'interpretation' | 'figure_explanation', multimodal = false): React.JSX.Element => (
    <div className="min-w-0 max-w-[220px]">
      <ModelMenu
        compact
        independent
        modelFilter={multimodal ? MULTIMODAL_MODEL_FILTER : undefined}
        modelKey={actionModelKey(kind)}
        onModelSelect={model => actions.setLiteratureAiModel(kind, model.key)}
        showEffort={false}
        testIdPrefix={`pdf-${kind}-model`}
      />
    </div>
  )
  return {
    panel, figure, exitFigureSelection, setFigureGuideOpen, setPanel: selectPanel,
    translationOpen: panel === 'document_translation',
    translationPage,
    canAnalyzeSelection,
    selectionAnalyzing: isBusy('selection_explanation') || isBusy('selection_translation'),
    explainSelection: (target?: PdfSelection, requirement = '') => { void run('selection_explanation', 'summary', undefined, undefined, undefined, undefined, target ? [target] : selection, selectionInstruction(state.selectionPrompts, 'explain', requirement)) },
    translateSelection: (target?: PdfSelection) => { void run('selection_translation', 'summary', undefined, undefined, undefined, undefined, target ? [target] : selection) },
    selectFigure,
    explainRegion,
    copyFormula,
    visualRegionImageInputAvailable: figureModelSupportsImageInput,
    copyingFormulaRegionId: isBusy('formula_latex') ? requests.current.formula_latex?.region_id : undefined,
    toolbar: literatureId || (projectId && path) ? <>{figureModelSupportsImageInput ? <HoverCard open={figureGuideOpen} onOpenChange={setFigureGuideOpen}><HoverCardTrigger asChild onClick={() => { if (figure) exitFigureSelection(); else { onExclusiveSurfaceOpen(); setFigure(true); setFigureGuideOpen(false) } selectPanel(null) }}><IconButton data-testid="pdf-figure-explanation" data-ob="pdf-figure" aria-pressed={figure} label={t('reading.figure')} icon={<Icon name="image" size={14} />} variant={figure ? 'primary' : 'outline'} /></HoverCardTrigger><HoverCardContent side="bottom" className="overflow-hidden rounded-[var(--vds-radius-5)] p-0" style={{ boxSizing: 'border-box', maxWidth: 'none', width: `min(${FIGURE_GUIDE_WIDTH_PX}px, calc(100vw - ${FIGURE_GUIDE_VIEWPORT_GUTTER_PX}px))` }}><div className="p-6" style={{ boxSizing: 'border-box', width: `${FIGURE_GUIDE_SOURCE_WIDTH_PX}px`, zoom: FIGURE_GUIDE_SCALE }}><FigureGuide t={t} /></div></HoverCardContent></HoverCard> : <Tooltip portalled content={t('reading.figureUnavailable')} side="bottom"><span><IconButton data-testid="pdf-figure-explanation" data-ob="pdf-figure" disabled label={t('reading.figure')} icon={<Icon name="image" size={14} />} variant="outline" /></span></Tooltip>}{Object.entries(jobs).filter(([action, job]) => action !== 'figure_explanation' && action !== 'document_translation' && action !== 'formula_latex' && jobBusy(job)).map(([action]) => <Button key={action} size="sm" variant="ghost" onClick={() => { const kind = action as PdfAction; if (kind === 'interpretation') { exitFigureSelection(); onExclusiveSurfaceOpen(); setPanel(kind) } else setFloating(kind) }}>{t('reading.inProgress', { action: LABELS[action as PdfAction] })}</Button>)}</> : null,
    railActions: literatureId ? <><Tooltip portalled content={LABELS.document_translation} side="left"><IconButton data-testid="pdf-document-translation" aria-pressed={panel === 'document_translation'} label={LABELS.document_translation} title={undefined} icon={<Icon name="globe" size={18} />} variant={panel === 'document_translation' ? 'primary' : 'ghost'} onClick={toggleDocumentTranslation} /></Tooltip><Tooltip portalled content={LABELS.interpretation} side="left"><IconButton data-testid="pdf-interpretation" label={LABELS.interpretation} title={undefined} icon={<Icon name="sparkle" size={18} />} variant={panel === 'interpretation' ? 'secondary' : 'ghost'} onClick={toggleInterpretation} /></Tooltip></> : null,
    sidePanel: panel === 'interpretation' ? <PdfPanel
      ariaLabel={LABELS[panel]}
      bodyClassName="relative min-h-0 flex-1 overflow-auto text-sm leading-7"
      closeLabel={t('reading.close')}
      expanded={panelExpanded}
      footer={<footer className="border-t border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-3"><Button className="w-full" icon={<Icon name="sparkle" size={16} />} onClick={openInterpretationChat}>{t('reading.chat')}</Button></footer>}
      headerAction={<div className="flex min-w-0 items-center gap-2">{modelControl('interpretation')}{summary?.contribution ? <Button variant="outline" size="sm" disabled={isBusy(panel)} onClick={() => void run(panel)}>{t('reading.regenerate')}</Button> : null}</div>}
      icon={<Icon name="sparkle" size={16} />}
      testId="pdf-reading-panel"
      title={LABELS[panel]}
      onClose={() => selectPanel(null)}
      onToggleExpanded={() => setPanelExpanded(value => !value)}
    >
      {feedback(panel)}{summary?.contribution ? <Summary value={summary} onSource={onLocate} /> : !isBusy('interpretation') && <div className="grid gap-5 p-5"><div className="grid gap-2"><h3 className="m-0 text-lg font-semibold">{t('reading.introTitle')}</h3><p className="m-0 text-[var(--vds-text-tertiary)]">{t('reading.introDescription')}</p></div>{interpretationCanGenerate && <Button data-testid="pdf-generate-summary" className="w-full" icon={<Icon name="sparkle" size={16} />} onClick={() => void run('interpretation')}>{t('reading.generateSummary')}</Button>}</div>}
    </PdfPanel> : null,
    floating: floating ? <FloatingWindow key={floating} initialSize={floating === 'figure_explanation' ? FIGURE_WINDOW_SIZE : undefined} title={LABELS[floating]} onClose={() => { setFloating(null); if (floating === 'figure_explanation') { void cancel('figure_explanation'); exitFigureSelection() } }} footer={<>{floating === 'figure_explanation' && <div className="mr-auto flex min-w-0 items-center gap-2"><Button variant="outline" icon={<Icon name="image" size={14} />} onClick={() => { void cancel('figure_explanation'); setFloating(null); onExclusiveSurfaceOpen(); setFigure(true) }}>{t('reading.continueSelecting')}</Button><span className="shrink-0 text-xs text-[var(--vds-text-tertiary)]">{t('reading.currentModel')}</span>{modelControl('figure_explanation', true)}</div>}{floating !== 'figure_explanation' && canAnnotate ? <Button variant="outline" size="sm" icon={annotationIdentity === annotatedResult ? <Check size={14} /> : <Icon name="annotation" size={14} />} loading={annotating} disabled={!floatingResult || busy || annotating || annotationIdentity === annotatedResult} onClick={() => void addResultComment()}>{t(annotationIdentity === annotatedResult ? 'reading.addedToAnnotation' : 'reading.addToAnnotation')}</Button> : null}<CopyButton key={floatingResult?.text ?? figureText} value={floatingResult?.text ?? figureText} writeText={writeClipboard} disabled={!floatingResult && !figureText} size="sm" variant="ghost" icon={<Icon name="copy" size={14} />} />{floating !== 'figure_explanation' && <Button disabled={!floatingResult} size="sm" variant="primary" icon={<Icon name="talk" size={14} />} onClick={quote}>{t('reading.ask')}</Button>}</>}>
          {floating === 'selection_translation' && <section className="cursor-text select-text border-b border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-5"><div className="mb-2 flex items-center justify-between"><p className="text-sm text-[var(--vds-text-tertiary)]">{t('reading.source')}</p><div className="flex min-w-0 items-center gap-2">{modelControl('selection_translation')}{languageControl('selection_translation')}</div></div><p>{translationSource}</p></section>}
      <div className={floating === 'figure_explanation' ? 'flex h-full min-h-0 flex-col' : ''}>
        {floating === 'figure_explanation' && <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">{floatingResult || busy || cropPreview || jobs.figure_explanation?.error || jobs.figure_explanation?.failed ? <Card padding="sm"><CardHeader><CardTitle>{floatingResult ? t('reading.figureResult', { page: floatingResult.page }) : t('reading.figureResultPending')}</CardTitle></CardHeader><CardContent>{(floatingResult?.crop || cropPreview) && <Crop image={floatingResult?.crop ?? cropPreview} page={floatingResult?.page ?? lastRequest.current?.page ?? page} />}{(floatingResult?.text || figureText) && <div className="mt-3 cursor-text select-text text-sm leading-8"><Markdown text={floatingResult?.text ?? figureText} /></div>}{feedback('figure_explanation')}<PromptSettingsGuide className="mt-3 border-t border-[var(--vds-divider-default)] pt-3" prefix={t('reading.figurePromptGuide')} linkLabel={t('reading.promptSettings')} suffix={t('reading.promptGuideSuffix')} /></CardContent></Card> : <p className="text-xs text-[var(--vds-text-tertiary)]">{t('reading.selectionScope')}</p>}</div>}
        {floating !== 'figure_explanation' && <div className="min-h-0 flex-1 overflow-auto">{feedback(floating)}<div className="cursor-text select-text p-5 text-sm leading-8">
          <h3 className="mb-3 font-semibold">{floating === 'selection_translation' ? t('reading.translation') : ''}</h3>
          {floating === 'selection_translation' && floatingResult?.blocks ? <Translation sentences={floatingResult.blocks} active={activeSentence} onSelect={sentence => selectSentence(sentence, floatingResult.page)} /> : floatingResult ? output(floatingResult, true) : <p className="text-xs text-[var(--vds-text-tertiary)]">{t('reading.selectionScope')}</p>}
          {floating === 'selection_translation' ? <PromptSettingsGuide className="mt-3 border-t border-[var(--vds-divider-default)] pt-3" prefix={t('reading.translationPromptGuide')} linkLabel={t('reading.promptSettings')} suffix={t('reading.promptGuideSuffix')} /> : null}
        </div></div>}
      </div>
    </FloatingWindow> : null
  }
}
