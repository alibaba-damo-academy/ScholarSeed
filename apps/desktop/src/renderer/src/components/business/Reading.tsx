import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import sproutIcon from '../../assets/sprout.png'
import { useApp } from '../../store'
import { Icon } from '../../icons'
import { requestModelKey, selectableActionModelKey } from '../../catalog'
import type {
  ReadingAsset,
  ReadingEvidence,
  ReadingState,
  ReadingTask,
  ReadingTiming,
} from '../../contracts/literature'
import {
  Alert,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  EmptyState,
  IconButton,
  Spinner,
  Tooltip,
  useToast,
} from '../ui'
import { ModelMenu } from './ModelMenu'
import { Summary } from './Summary'
import { pdfAiCaughtFailure, pdfAiFailureText } from './diagnostic'
import {
  cancelReading,
  generateReading,
  observeReading,
  readReading,
  readingBusy,
  recordReadingTiming,
} from './comprehension'

/** One controller for both entry points. Unmount disconnects UI, never cancels the task. */
export function Reading({
  literatureId,
  attachmentId,
  revision = '',
  active = true,
  showSources = true,
  onSource,
  onChat,
  onSaved,
}: {
  literatureId: string
  attachmentId: string
  revision?: string
  active?: boolean
  showSources?: boolean
  onSource: (source: ReadingEvidence, revision: string) => void
  onChat?: (summary: string) => void | boolean | Promise<void | boolean>
  onSaved?: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('pdf')
  const { state, act } = useApp()
  const { toast } = useToast()
  const [chatPending, setChatPending] = useState(false)
  const [chatFailed, setChatFailed] = useState(false)
  const chatRequest = useRef(false)
  const openChat = async (text: string): Promise<void> => {
    if (!onChat || !chatReady || chatRequest.current) return
    chatRequest.current = true
    setChatPending(true)
    setChatFailed(false)
    try {
      if ((await onChat(text)) === false) setChatFailed(true)
      else toast({ title: t('reading.chatReady'), tone: 'success' })
    } catch {
      setChatFailed(true)
    } finally {
      chatRequest.current = false
      setChatPending(false)
    }
  }
  const [data, setData] = useState<ReadingState | null>(null)
  const [task, setTask] = useState<ReadingTask | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const cancelling = useRef(false)
  const cancelledTask = useRef('')
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const submitting = useRef(false)
  const submission = useRef<Promise<ReadingTask | null> | null>(null)
  const publishedTask = useRef('')
  const readingStarted = useRef<number | null>(null)
  const measurements = useRef<ReadingTiming>({})
  const measuredTask = useRef<string | null>(null)
  const observeTiming = (taskId: string, field: keyof ReadingTiming): void => {
    if (
      readingStarted.current === null ||
      measuredTask.current !== taskId ||
      measurements.current[field] !== undefined
    )
      return
    measurements.current[field] = (performance.now() - readingStarted.current) / 1000
    const measured = { ...measurements.current }
    setData((previous) => {
      const saved = previous?.results.summary
      if (!previous || saved?.metadata?.task_id !== taskId) return previous
      return {
        ...previous,
        results: {
          ...previous.results,
          summary: {
            ...saved,
            metadata: { ...saved.metadata!, ui_timing: measured },
          },
        },
      }
    })
    void recordReadingTiming(taskId, measured).catch((cause) => {
      console.warn('[reading-timing]', { taskId, cause })
    })
  }
  const asset = data?.results.summary
  const savedSummary = asset?.modules?.summary
  const completeSummary = savedSummary?.organization === 'complete' ? savedSummary : undefined
  const failed = error || (task?.status === 'failed' ? task : null)
  const fallbackOnly = savedSummary?.organization === 'fallback'
  const unfinished = !readingBusy(task) && !pending && Boolean(failed || fallbackOnly)
  const preview =
    task?.status !== 'cancelled' &&
    !task?.reading_complete &&
    task?.status !== 'completed' &&
    (readingBusy(task) ||
      (!asset && task?.preview?.sections?.length) ||
      (asset?.modules?.summary?.organization === 'fallback' && task?.preview?.sections?.length))
      ? task?.preview
      : undefined
  const busy = pending || (readingBusy(task) && !task?.reading_complete)
  const summary = busy ? preview : unfinished ? completeSummary : preview || savedSummary
  const chatReady =
    !loading &&
    !loadError &&
    !busy &&
    !preview &&
    summary?.organization === 'complete' &&
    Boolean(summary.text.trim())
  const modelKey = selectableActionModelKey(
    state.literatureAiModels.interpretation || '',
    state.catalog.models,
    requestModelKey(state.catalog.models, state.model, state.activeSession, state.threads)
  )
  const observedTaskId = task?.task_id
  const observing = readingBusy(task)
  const readingComplete = task?.reading_complete
  const taskStatus = task?.status
  const hasReadingText = Boolean(
    summary?.overview?.text?.trim() ||
    summary?.sections?.some((section) => section.items.some((item) => item.text.trim()))
  )
  useEffect(() => {
    if (
      !hasReadingText ||
      readingStarted.current === null ||
      !observedTaskId ||
      measurements.current.first_seconds !== undefined
    )
      return
    const started = readingStarted.current
    const current = generation.current
    const frame = requestAnimationFrame(() => {
      if (current !== generation.current) return
      observeTiming(observedTaskId, 'first_seconds')
      console.info(
        '[reading-first-text]',
        JSON.stringify({
          taskId: observedTaskId,
          elapsedMs: Math.round(performance.now() - started),
          visible: document.visibilityState === 'visible',
        })
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [hasReadingText, observedTaskId])
  useEffect(() => {
    if (!observedTaskId || readingStarted.current === null) return
    const frame = requestAnimationFrame(() => {
      if (readingComplete || taskStatus === 'completed')
        observeTiming(observedTaskId, 'reading_seconds')
      if (!observing) observeTiming(observedTaskId, 'total_seconds')
    })
    return () => cancelAnimationFrame(frame)
  }, [observedTaskId, readingComplete, taskStatus, observing])
  useEffect(() => {
    generation.current += 1
    submitting.current = false
    submission.current = null
    publishedTask.current = ''
    readingStarted.current = null
    measurements.current = {}
    measuredTask.current = null
    setData(null)
    setTask(null)
    setError(null)
    setPending(false)
    setCancelPending(false)
    cancelling.current = false
    cancelledTask.current = ''
    return () => {
      generation.current += 1
    }
  }, [literatureId, attachmentId, revision])
  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const current = generation.current
    setLoading(true)
    setLoadError(false)
    void readReading(literatureId, attachmentId, revision, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || current !== generation.current) return
        setData(value)
        setTask(value.task)
      })
      .catch(() => {
        if (!controller.signal.aborted && current === generation.current) setLoadError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted && current === generation.current) setLoading(false)
      })
    return () => controller.abort()
  }, [literatureId, attachmentId, revision, reload, active])
  const publish = (next: ReadingTask): void => {
    if (cancelledTask.current === next.task_id && next.status !== 'cancelled') return
    setTask(next)
    if ((next.status === 'completed' || next.reading_complete) && next.result) {
      const result: ReadingAsset =
        next.result.metadata && readingStarted.current !== null
          ? {
              ...next.result,
              metadata: { ...next.result.metadata, ui_timing: { ...measurements.current } },
            }
          : next.result
      setData((previous) =>
        previous ? { ...previous, results: { ...previous.results, summary: result } } : previous
      )
      if (publishedTask.current !== next.task_id) {
        publishedTask.current = next.task_id
        onSaved?.()
      }
    }
  }
  const publishRef = useRef(publish)
  publishRef.current = publish
  useEffect(() => {
    if (!observedTaskId || !observing) return
    const controller = new AbortController()
    const current = generation.current
    void observeReading(observedTaskId, controller.signal, (next) => {
      if (!controller.signal.aborted && current === generation.current) publishRef.current(next)
    }).catch((cause) => {
      if (controller.signal.aborted || current !== generation.current) return
      if (publishedTask.current === observedTaskId) {
        console.warn('[reading-background-observation]', { taskId: observedTaskId, cause })
      } else {
        setError(cause)
      }
    })
    return () => controller.abort()
  }, [observedTaskId, observing, reload, literatureId, attachmentId, revision])
  const run = async (): Promise<void> => {
    if (busy || submitting.current || !data) return
    if (!modelKey) {
      act.openSettings('models')
      return
    }
    const current = generation.current
    const language = (i18n.resolvedLanguage || i18n.language).startsWith('en') ? 'en' : 'zh'
    cancelledTask.current = ''
    submitting.current = true
    measurements.current = {}
    measuredTask.current = null
    readingStarted.current = performance.now()
    setPending(true)
    setError(null)
    setTask(null)
    const request = (async () => {
      // The reading is already saved; finish releasing its remaining extraction
      // before replacing it with a new request using the selected model.
      if (task?.reading_complete && readingBusy(task)) await cancelReading(task.task_id)
      if (current !== generation.current) return null
      return generateReading(literatureId, data.attachment_id, data.revision, modelKey, language)
    })()
    submission.current = request
    try {
      const next = await request
      if (next && current === generation.current) {
        measuredTask.current = next.task_id
        publish(next)
      }
    } catch (cause) {
      if (current === generation.current) setError(cause)
    } finally {
      if (current === generation.current) {
        submitting.current = false
        submission.current = null
        setPending(false)
      }
    }
  }
  const cancel = async (): Promise<void> => {
    if (cancelling.current) return
    cancelling.current = true
    setCancelPending(true)
    const current = generation.current
    try {
      // A click during submission belongs to that request, including after unmount.
      // Wait for its accepted task ID; never fall back to the previous saved task.
      const target = submission.current ? await submission.current : task
      if (!target) return
      const next = await cancelReading(target.task_id)
      if (current === generation.current) {
        if (next.status === 'cancelled') {
          cancelledTask.current = next.task_id
          setError(null)
          toast({
            title: t(asset?.modules?.summary ? 'reading.cancelRestored' : 'reading.cancelEmpty'),
            tone: 'success',
          })
        }
        publish(next)
      }
    } catch (cause) {
      if (current === generation.current) setError(cause)
    } finally {
      if (current === generation.current) {
        cancelling.current = false
        setCancelPending(false)
      }
    }
  }
  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="paper-reading"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-[var(--vds-space-2)] px-[var(--vds-space-4)] py-[var(--vds-space-2)]">
        <div className="min-w-0 max-w-full">
          <ModelMenu
            compact
            variant="outline"
            independent
            showEffort={false}
            modelKey={modelKey}
            onModelSelect={(model) => act.setLiteratureAiModel('interpretation', model.key)}
            testIdPrefix="pdf-interpretation-model"
          />
        </div>
        <Tooltip portalled content={t('reading.regenerate')} className="ml-auto">
          <IconButton
            label={t('reading.regenerate')}
            title={undefined}
            variant="ghostIcon"
            size="sm"
            icon={<RotateCw size={16} />}
            disabled={!summary || busy || loading || loadError}
            onClick={() => void run()}
          />
        </Tooltip>
        {busy && (
          <Button
            size="sm"
            variant="outline"
            disabled={cancelPending || (!pending && !task?.task_id)}
            onClick={() => void cancel()}
          >
            {t('reading.cancel')}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="reading-body">
        {loading && (
          <div
            role="status"
            className="flex items-center gap-[var(--vds-space-2)] p-[var(--vds-space-4)]"
          >
            <Spinner />
            {t('reading.loadingSaved')}
          </div>
        )}
        {loadError && (
          <div role="alert" className="p-[var(--vds-space-4)]">
            <p>{t('reading.loadFailed')}</p>
            <Button size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}>
              {t('reading.retry')}
            </Button>
          </div>
        )}
        {chatFailed && <Alert tone="error" description={t('reading.chatFailed')} />}
        {busy && !hasReadingText && (
          <div
            role="status"
            data-testid="reading-generating"
            className="mx-[var(--vds-space-4)] mb-[var(--vds-space-4)] flex min-h-0 flex-1 flex-col items-center justify-center gap-[var(--vds-space-2)] overflow-auto rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
          >
            <Spinner aria-hidden="true" className="!size-[var(--vds-icon-7)] shrink-0" />
            <span>
              {pending || task?.status === 'pending'
                ? t('reading.preparing')
                : t('reading.organizing')}
            </span>
            {task?.model_key && (
              <span className="sr-only">
                {t('reading.runningModel', { model: task.model_key })}
              </span>
            )}
          </div>
        )}
        {unfinished && (
          <div role="alert" className="space-y-[var(--vds-space-2)] p-[var(--vds-space-4)]">
            <p>
              {failed ? pdfAiFailureText(pdfAiCaughtFailure(failed), t) : t('reading.incomplete')}
            </p>
            {completeSummary && <p>{t('reading.previousPreserved')}</p>}
            {!busy && (
              <Button variant="outline" size="sm" onClick={() => void run()}>
                {t('reading.retry')}
              </Button>
            )}
          </div>
        )}
        {unfinished && !completeSummary && preview && (
          <Collapsible
            key={task?.task_id}
            className="min-h-0 overflow-auto px-[var(--vds-space-4)]"
          >
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm">
                {t('reading.viewPartial')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Summary
                value={preview}
                showSources={showSources}
                onSource={(source) => onSource(source, data?.revision || revision)}
              />
            </CollapsibleContent>
          </Collapsible>
        )}
        {task?.status === 'unknown' && (
          <div role="status" className="p-[var(--vds-space-4)]">
            <p>{t('reading.interrupted')}</p>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
              {t('reading.retry')}
            </Button>
          </div>
        )}
        {summary && (!busy || hasReadingText) ? (
          <div className="mx-[var(--vds-space-4)] mb-[var(--vds-space-4)] flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]">
            <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
              <Summary
                value={summary}
                showSources={showSources}
                result={preview || summary.organization === 'fallback' ? undefined : asset}
                onSource={(source) => onSource(source, data?.revision || revision)}
              />
            </div>
          </div>
        ) : (
          !loading &&
          !loadError &&
          !busy &&
          !unfinished &&
          task?.status !== 'unknown' && (
            <div className="grid min-h-0 flex-1 place-items-center overflow-auto">
              <EmptyState
                data-testid="reading-empty"
                variant="panel"
                iconTone="subtle"
                icon={<img src={sproutIcon} alt="" className="!size-[var(--vds-icon-10)]" />}
                title={t('reading.introTitle')}
                description={t('reading.introDescription')}
                className="!gap-[var(--vds-space-3)] !p-[var(--vds-space-3)] [&_.vds-empty-state\_\_icon]:!size-[var(--vds-space-10)] [&_.vds-empty-state\_\_content]:!gap-[var(--vds-space-1)] [&_.vds-empty-state\_\_title]:!text-[length:var(--vds-font-body-lv1)] [&_.vds-empty-state\_\_title]:!leading-[var(--vds-lh-body-lv1)] [&_.vds-empty-state\_\_title]:!text-[var(--vds-text-secondary)] [&_.vds-empty-state\_\_description]:!text-[length:var(--vds-font-body-lv1)] [&_.vds-empty-state\_\_description]:!leading-[var(--vds-lh-body-lv1)]"
                action={
                  <Button
                    size="sm"
                    className="!text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !px-[calc(var(--vds-space-3)-var(--vds-border-width-1))]"
                    data-testid="pdf-generate-summary"
                    onClick={() => void run()}
                  >
                    {t('reading.generateSummary')}
                  </Button>
                }
              />
            </div>
          )
        )}
      </div>
      {onChat && (
        <div className="flex shrink-0 justify-end px-[var(--vds-space-4)] pb-[var(--vds-space-4)]">
          <Button
            icon={<Icon name="talk" />}
            className="h-auto min-h-[var(--vds-control-height-md)] max-w-full whitespace-normal"
            loading={chatPending}
            disabled={!chatReady || chatPending}
            onClick={() => void openChat(summary?.text ?? '')}
            data-testid="reading-chat"
          >
            {t('reading.chat')}
          </Button>
        </div>
      )}
    </div>
  )
}
