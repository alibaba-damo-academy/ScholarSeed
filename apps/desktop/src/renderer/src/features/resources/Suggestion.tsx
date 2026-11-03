import { MAX_SELECTION_REQUIREMENT_CHARS, selectionInstruction } from '../../../../prompts'
import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  Button,
  CopyButton,
  FloatingToolbar,
  IconButton,
  ScrollArea,
  Spinner,
  Textarea,
} from '../../components/ui'
import { Icon } from '../../icons'
import { Markdown } from '../../components/primitive'
import { writeClipboard } from '../../components/primitive/clipboard'
import {
  defaultTranslationTarget,
  readTranslationModel,
  readTranslationTarget,
  TranslationTargetPicker,
  writeTranslationModel,
  writeTranslationTarget,
} from '../../components/business/Language'
import { ModelMenu } from '../../components/business/ModelMenu'
import { PromptSettingsGuide } from '../../components/business/PromptSettingsGuide'
import type { AssistantTranslationTarget } from '../../contracts/assistant'
import { effectiveSessionModelKey, selectableActionModelKey } from '../../catalog'
import { useApp } from '../../store'
import {
  cancelResource,
  invokeResource,
  type ResourceAction,
  type ResourceInput,
  type ResourceRequest,
} from './ai'
import {
  suggestionPosition,
  suggestionSize,
  sourceNeedsDisclosure,
  SUGGESTION_VIEWPORT_MARGIN,
} from './utils'

const LABELS = {
  explain: 'suggestion.labelExplain',
  polish: 'suggestion.labelPolish',
  translate: 'suggestion.labelTranslate',
} as const
const PLACEHOLDERS = {
  explain: 'suggestion.placeholderExplain',
  polish: 'suggestion.placeholderPolish',
  translate: 'suggestion.placeholderTranslate',
} as const
const PROMPT_GUIDES = {
  explain: 'suggestion.promptGuideExplain',
  polish: 'suggestion.promptGuidePolish',
  translate: 'suggestion.promptGuideTranslate',
} as const
const FLOATING_MARGIN_PX = SUGGESTION_VIEWPORT_MARGIN
const SELECTION_OFFSET_PX = 8
const KEYBOARD_MOVE_PX = 16
const INPUT_WIDTH_PX = 390
const RESULT_WIDTH_PX = 440
const TRANSLATION_RESULT_WIDTH_PX = 520
export const RESOURCE_AI_SUGGESTION_SELECTOR = '[data-resource-ai-suggestion]'
const ERRORS = {
  annotation_failed: 'suggestion.errors.annotationFailed',
  selection_changed: 'suggestion.errors.selection_changed',
  replacement_timeout: 'suggestion.errors.replacement_timeout',
  replacement_stale: 'suggestion.errors.replacement_stale',
  resource_dirty_file: 'suggestion.errors.resource_dirty_file',
  resource_model_unavailable: 'suggestion.errors.resource_model_unavailable',
  reasoning_disabled_unsupported: 'suggestion.errors.reasoning_disabled_unsupported',
  resource_file_unreadable: 'suggestion.errors.resource_file_unreadable',
  resource_context_unavailable: 'suggestion.errors.resource_context_unavailable',
  selection_too_large: 'suggestion.errors.selection_too_large',
  selection_stale: 'suggestion.errors.selection_stale',
  selection_unsupported: 'suggestion.errors.selection_unsupported',
  resource_stream_incomplete: 'suggestion.errors.resource_stream_incomplete',
} as const

function knownError(code: string): (typeof ERRORS)[keyof typeof ERRORS] | undefined {
  return Object.prototype.hasOwnProperty.call(ERRORS, code)
    ? ERRORS[code as keyof typeof ERRORS]
    : undefined
}

function TranslationSource({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('resources')
  const id = useId()
  const content = useRef<HTMLDivElement | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  useLayoutEffect(() => {
    const node = content.current
    if (!node) return
    const measure = (): void => {
      setCollapsible(
        sourceNeedsDisclosure(node.scrollHeight, parseFloat(getComputedStyle(node).lineHeight))
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [text])
  return (
    <div className="border-b border-[var(--vds-divider-default)] bg-[var(--vds-bg-component)] p-[var(--vds-space-4)]">
      <div className="mb-[var(--vds-space-2)] flex items-center justify-between gap-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
        <span>{t('suggestion.original')}</span>
        {collapsible && (
          <Button
            size="content"
            variant="link"
            aria-expanded={expanded}
            aria-controls={id}
            data-testid="resource-translation-source-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {t(expanded ? 'suggestion.collapseOriginal' : 'suggestion.expandOriginal')}
          </Button>
        )}
      </div>
      <div
        ref={content}
        id={id}
        data-testid="resource-translation-source"
        className={`whitespace-pre-wrap${expanded ? '' : ' line-clamp-3'}`}
      >
        {text}
      </div>
    </div>
  )
}

export interface SuggestionProps {
  action: ResourceAction
  anchorPosition?: { left: number; top: number }
  anchorWidth?: number
  identity: string
  selectedText: string
  point: { x: number; y: number }
  snapshot: Promise<ResourceInput>
  onClose: () => void
  onAnnotate?: (output: string) => Promise<boolean>
  onApply?: (output: string) => Promise<string | null>
  onPinnedChange: (pinned: boolean) => void
  pinned: boolean
  toolbarActions?: ReactNode
  toolbarLabel?: string
}

/** A resource suggestion owns only the request and preview; editors own mutation. */
export function ResourceSuggestion({
  action,
  anchorPosition,
  anchorWidth,
  identity,
  selectedText,
  point,
  snapshot,
  onClose,
  onAnnotate,
  onApply,
  onPinnedChange,
  pinned,
  toolbarActions,
  toolbarLabel,
}: SuggestionProps): React.JSX.Element {
  const { state, act } = useApp()
  const { t, i18n } = useTranslation('resources')
  const { t: ui } = useTranslation('ui')
  const [instruction, setInstruction] = useState('')
  const [output, setOutput] = useState('')
  const [error, setError] = useState<{
    key:
      | (typeof ERRORS)[keyof typeof ERRORS]
      | 'suggestion.errors.cancelledIncomplete'
      | 'suggestion.errors.generateFailed'
      | 'suggestion.errors.requestFailed'
      | 'suggestion.errors.cancelled'
      | 'suggestion.errors.cancelUnconfirmed'
      | 'suggestion.errors.applyFailed'
  } | null>(null)
  const [submitted, setSubmitted] = useState(action === 'translate')
  const [target, setTarget] = useState<AssistantTranslationTarget>(
    () =>
      readTranslationTarget('resource-selection') ??
      defaultTranslationTarget(i18n.resolvedLanguage || i18n.language, selectedText)
  )
  const [busy, setBusy] = useState(false)
  const [complete, setComplete] = useState(false)
  const [applying, setApplying] = useState(false)
  const [annotating, setAnnotating] = useState(false)
  const [annotated, setAnnotated] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))
  const stream = useRef<AbortController | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const resize = useRef<{
    pointerId: number
    x: number
    y: number
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const taskId = useRef('')
  const request = useRef<ResourceRequest | null>(null)
  const applySnapshot = useRef(onApply)
  const mounted = useRef(true)
  const assistantModel = effectiveSessionModelKey(
    state.catalog.models,
    state.model,
    state.activeSession,
    state.threads
  )
  const [translationModel, setTranslationModel] = useState<string | undefined>(() =>
    readTranslationModel('resource-selection')
  )
  const selectedModel = selectableActionModelKey(
    action === 'translate' ? (translationModel ?? '') : '',
    state.catalog.models,
    assistantModel
  )
  const hasModel = state.catalog.models.some((item) => item.key === selectedModel && !item.disabled)
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = (): void => {
      const nextViewport = { width: window.innerWidth, height: window.innerHeight }
      setViewport((value) =>
        value.width === nextViewport.width && value.height === nextViewport.height
          ? value
          : nextViewport
      )
      setSize((value) => {
        if (!value) return value
        const next = {
          width: Math.min(value.width, nextViewport.width - FLOATING_MARGIN_PX * 2),
          height: Math.min(value.height, nextViewport.height - FLOATING_MARGIN_PX * 2),
        }
        return value.width === next.width && value.height === next.height ? value : next
      })
      const bounds = node.getBoundingClientRect()
      setPosition((value) => {
        const next = suggestionPosition(
          value ?? { left: bounds.left, top: bounds.top },
          bounds,
          nextViewport
        )
        return value?.left === next.left && value.top === next.top ? value : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [identity])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stream.current?.abort()
    }
  }, [])
  useEffect(() => {
    setPosition(null)
    setSize(null)
    setAnnotated(false)
  }, [identity])
  useEffect(() => {
    if (!hasModel) setError({ key: ERRORS.resource_model_unavailable })
  }, [hasModel])
  const close = (): void => {
    stream.current?.abort()
    onClose()
  }
  const run = async (
    retry = false,
    targetLanguage = target,
    modelOverride = selectedModel
  ): Promise<void> => {
    if (busy) return
    if (!state.catalog.models.some((item) => item.key === modelOverride && !item.disabled)) {
      setError({ key: ERRORS.resource_model_unavailable })
      return
    }
    stream.current?.abort()
    setBusy(true)
    setSubmitted(true)
    setComplete(false)
    setError(null)
    setOutput('')
    setAnnotated(false)
    if (!retry) applySnapshot.current = onApply
    const abort = new AbortController()
    stream.current = abort
    taskId.current = ''
    try {
      const previous = request.current
      const input = retry && previous ? previous : await snapshot
      if (abort.signal.aborted) return
      const next: ResourceRequest =
        retry && previous
          ? {
              ...previous,
              model_key: modelOverride,
              client_attempt_id: crypto.randomUUID(),
              retry_of_attempt_id: previous.client_attempt_id,
            }
          : {
              ...input,
              instruction: selectionInstruction(state.selectionPrompts, action, instruction),
              model_key: modelOverride,
              ...(action === 'translate' ? { target_language: targetLanguage } : {}),
              client_action_id: crypto.randomUUID(),
              client_attempt_id: crypto.randomUUID(),
            }
      request.current = next
      let item = ''
      const result = await invokeResource(action, next, abort.signal, (event) => {
        if (!mounted.current || abort.signal.aborted) return
        taskId.current = event.invocation_id
        if (event.type === 'output_delta' || event.type === 'output_completed') {
          const same = item === event.item_id
          item = event.item_id
          setOutput((value) =>
            event.type === 'output_completed' || !same ? event.text : value + event.text
          )
        }
      })
      if (!mounted.current || abort.signal.aborted) return
      if (result.status === 'completed') {
        setOutput(result.output)
        setComplete(true)
      } else
        setError({
          key:
            result.status === 'cancelled'
              ? 'suggestion.errors.cancelledIncomplete'
              : (knownError(result.error_code) ?? 'suggestion.errors.generateFailed'),
        })
    } catch (cause) {
      if (mounted.current && !abort.signal.aborted)
        setError({
          key: knownError(String((cause as Error).message)) ?? 'suggestion.errors.requestFailed',
        })
    } finally {
      if (mounted.current && stream.current === abort) {
        setBusy(false)
        stream.current = null
      }
    }
  }
  useEffect(() => {
    if (action === 'translate') void run()
  }, [])
  const stop = async (): Promise<void> => {
    try {
      if (!taskId.current) {
        stream.current?.abort()
        setError({ key: 'suggestion.errors.cancelled' })
        setBusy(false)
        return
      }
      if (!(await cancelResource(taskId.current)))
        setError({ key: 'suggestion.errors.cancelUnconfirmed' })
    } catch {
      setError({ key: 'suggestion.errors.cancelUnconfirmed' })
    }
  }
  const apply = async (): Promise<void> => {
    if (!complete || !onApply || applying) return
    setApplying(true)
    try {
      const failure = await applySnapshot.current?.(output)
      if (failure) {
        setError({ key: knownError(failure) ?? 'suggestion.errors.applyFailed' })
        setComplete(false)
      } else close()
    } catch {
      setError({ key: 'suggestion.errors.applyFailed' })
      setComplete(false)
    } finally {
      setApplying(false)
    }
  }
  const annotate = async (): Promise<void> => {
    if (!complete || !onAnnotate || annotating || annotated) return
    setAnnotating(true)
    try {
      const saved = await onAnnotate(output)
      if (saved) setAnnotated(true)
      else setError({ key: ERRORS.annotation_failed })
    } catch {
      setError({ key: ERRORS.annotation_failed })
    } finally {
      setAnnotating(false)
    }
  }
  // Position is derived from the captured selection, never from fixed document coordinates.
  const width = submitted
    ? action === 'translate'
      ? TRANSLATION_RESULT_WIDTH_PX
      : RESULT_WIDTH_PX
    : INPUT_WIDTH_PX
  const integratedInput = Boolean(toolbarActions && !submitted)
  const left =
    position?.left ??
    (integratedInput ? anchorPosition?.left : undefined) ??
    Math.max(FLOATING_MARGIN_PX, Math.min(point.x, window.innerWidth - width - FLOATING_MARGIN_PX))
  const top =
    position?.top ??
    (integratedInput ? anchorPosition?.top : undefined) ??
    point.y + SELECTION_OFFSET_PX
  const moveTo = (nextLeft: number, nextTop: number): void => {
    const bounds = root.current?.getBoundingClientRect()
    if (!bounds) return
    setPosition(
      suggestionPosition({ left: nextLeft, top: nextTop }, bounds, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    )
  }
  const startDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return
    const bounds = root.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
    }
    setPosition({ left: bounds.left, top: bounds.top })
  }
  const moveDrag = (event: React.PointerEvent<HTMLElement>): void => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    moveTo(event.clientX - current.offsetX, event.clientY - current.offsetY)
  }
  const stopDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLElement>): void => {
    const offsets: Partial<Record<string, { x: number; y: number }>> = {
      ArrowLeft: { x: -KEYBOARD_MOVE_PX, y: 0 },
      ArrowRight: { x: KEYBOARD_MOVE_PX, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_MOVE_PX },
      ArrowDown: { x: 0, y: KEYBOARD_MOVE_PX },
    }
    const offset = offsets[event.key]
    if (!offset) return
    event.preventDefault()
    const bounds = root.current?.getBoundingClientRect()
    if (bounds) moveTo(bounds.left + offset.x, bounds.top + offset.y)
  }
  const resizeTo = (
    next: { width: number; height: number },
    origin: { left: number; top: number }
  ): void => {
    setSize(suggestionSize(next, origin, { width: window.innerWidth, height: window.innerHeight }))
  }
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const bounds = root.current?.getBoundingClientRect()
    if (!bounds) return
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    resize.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
    setPosition({ left: bounds.left, top: bounds.top })
  }
  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const origin = resize.current
    if (!origin || origin.pointerId !== event.pointerId) return
    resizeTo(
      {
        width: origin.width + event.clientX - origin.x,
        height: origin.height + event.clientY - origin.y,
      },
      origin
    )
  }
  const stopResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const horizontal =
      event.key === 'ArrowRight'
        ? KEYBOARD_MOVE_PX
        : event.key === 'ArrowLeft'
          ? -KEYBOARD_MOVE_PX
          : 0
    const vertical =
      event.key === 'ArrowDown' ? KEYBOARD_MOVE_PX : event.key === 'ArrowUp' ? -KEYBOARD_MOVE_PX : 0
    if (!horizontal && !vertical) return
    event.preventDefault()
    const bounds = root.current?.getBoundingClientRect()
    if (bounds)
      resizeTo({ width: bounds.width + horizontal, height: bounds.height + vertical }, bounds)
  }
  const moveHandle = (
    <strong
      className={
        integratedInput
          ? 'cursor-move touch-none px-[var(--vds-space-2)]'
          : 'flex-1 cursor-move touch-none px-[var(--vds-space-2)]'
      }
      tabIndex={0}
      aria-label={ui('floatingWindow.move', { title: t(LABELS[action]) })}
      onKeyDown={moveByKeyboard}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
    >
      {integratedInput ? <Icon name="more-horizontal" size={14} /> : t(LABELS[action])}
    </strong>
  )
  const suggestionActions = (
    <>
      {integratedInput ? toolbarActions : null}
      {moveHandle}
      {submitted && action === 'translate' && (
        <>
          <TranslationTargetPicker
            value={target}
            disabled={busy}
            onChange={(nextTarget) => {
              writeTranslationTarget('resource-selection', nextTarget)
              setTarget(nextTarget)
              void run(false, nextTarget)
            }}
          />
          <ModelMenu
            compact
            independent
            modelKey={selectedModel}
            onModelSelect={(model) => {
              writeTranslationModel('resource-selection', model.key)
              setTranslationModel(model.key)
              if (submitted) void run(false, target, model.key)
            }}
            showEffort={false}
            testIdPrefix="resource-translation-model"
          />
        </>
      )}
      {submitted && (action === 'explain' || action === 'translate') ? (
        <IconButton
          aria-pressed={pinned}
          label={ui(pinned ? 'floatingWindow.unpin' : 'floatingWindow.pin')}
          icon={<Icon name="pin" size={14} />}
          onClick={() => onPinnedChange(!pinned)}
          variant={pinned ? 'secondary' : 'ghost'}
        />
      ) : null}
      <IconButton
        label={t('suggestion.close')}
        icon={<Icon name="close" size={14} />}
        onClick={close}
        variant="ghost"
      />
    </>
  )
  return (
    <FloatingToolbar
      key={identity}
      label={integratedInput ? (toolbarLabel ?? t(LABELS[action])) : t(LABELS[action])}
      expanded
      ref={root}
      data-resource-ai-suggestion
      data-testid="resource-ai-suggestion"
      className={`fixed z-[var(--vds-z-popover)] flex flex-col overflow-hidden [&>[role=toolbar]]:shrink-0 [&>[role=toolbar]]:flex-wrap ${integratedInput ? 'max-w-[var(--vds-resource-suggestion-max-width)]' : submitted ? 'max-w-[88vw]' : 'max-w-[86vw] [&_[role=toolbar]]:gap-[var(--vds-space-2)] [&_[role=toolbar]>label]:flex-1'}`}
      style={{
        left,
        top,
        width: size?.width ?? (integratedInput && anchorWidth ? anchorWidth : width),
        height: size?.height,
        maxWidth: size ? viewport.width - FLOATING_MARGIN_PX * 2 : undefined,
        maxHeight: viewport.height - FLOATING_MARGIN_PX * 2,
      }}
      actions={suggestionActions}
    >
      {!submitted && (
        <div className="vds-selection-action-result min-h-0 overflow-auto">
          <Textarea
            autoFocus
            maxLength={MAX_SELECTION_REQUIREMENT_CHARS}
            aria-label={t('suggestion.optionalInstruction')}
            label={t('suggestion.optionalInstruction')}
            placeholder={t(PLACEHOLDERS[action])}
            rows={2}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void run()
              }
              if (event.key === 'Escape') close()
            }}
          />
          <PromptSettingsGuide
            prefix={t(PROMPT_GUIDES[action])}
            linkLabel={t('suggestion.promptSettings')}
            suffix={action === 'translate' ? t('suggestion.promptGuideSuffix') : undefined}
          />
          <Button
            className="justify-self-start"
            size="sm"
            icon={<Icon name="sparkle" size={14} />}
            disabled={!hasModel || busy}
            onClick={() => void run()}
          >
            {t('suggestion.submit', { action: t(LABELS[action]) })}
          </Button>
        </div>
      )}
      {submitted && (output || busy || action === 'translate') && (
        <div
          className={`flex min-h-0 flex-col cursor-text select-text break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-resource-ai-line-height)] text-[var(--vds-text-primary)]${size ? ' flex-1' : ''}`}
        >
          {action === 'translate' && (
            <ScrollArea
              className={`flex min-h-0 flex-col${size ? ' flex-1' : ''}`}
              viewportClassName="flex-1"
              viewportProps={{
                tabIndex: 0,
                style: { minHeight: 0 },
                'aria-label': t('suggestion.original'),
              }}
            >
              <TranslationSource key={identity} text={selectedText} />
            </ScrollArea>
          )}
          {(output || busy || action === 'translate') && (
            <ScrollArea
              className={
                size
                  ? 'flex min-h-0 flex-1 flex-col'
                  : action === 'translate'
                    ? 'max-h-[var(--vds-resource-ai-result-height)] shrink-0'
                    : 'min-h-0 max-h-[320px]'
              }
              viewportClassName={
                size
                  ? 'min-h-0 flex-1'
                  : action === 'translate'
                    ? 'max-h-[var(--vds-resource-ai-result-height)]'
                    : 'max-h-[320px]'
              }
              viewportProps={{
                tabIndex: 0,
                'aria-label':
                  action === 'translate' ? t('suggestion.translation') : t(LABELS[action]),
              }}
            >
              <div className="p-[var(--vds-space-4)]" data-testid="resource-translation-result">
                {action === 'translate' && (
                  <div className="mb-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
                    {t('suggestion.translation')}
                  </div>
                )}
                {output ? (
                  action === 'explain' ? (
                    <Markdown text={output} />
                  ) : (
                    <div className="whitespace-pre-wrap">{output}</div>
                  )
                ) : busy ? (
                  t('suggestion.generating')
                ) : (
                  ''
                )}
              </div>
            </ScrollArea>
          )}
        </div>
      )}
      {busy && (
        <div className="flex shrink-0 items-center justify-between px-4 py-2">
          <Spinner size="sm" />
          <Button size="sm" variant="ghost" onClick={() => void stop()}>
            {t('suggestion.stop')}
          </Button>
        </div>
      )}
      {error && (
        <div className="shrink-0 p-3">
          <Alert tone="error" description={t(error.key)} />
          <div className="mt-2 flex gap-[var(--vds-space-2)]">
            <Button size="sm" variant="outline" onClick={() => act.openSettings('models')}>
              {t('suggestion.configure')}
            </Button>
            {submitted && !busy && (
              <Button size="sm" onClick={() => void run(true)}>
                {t('suggestion.retry')}
              </Button>
            )}
          </div>
        </div>
      )}
      {submitted && (
        <div
          className={`flex shrink-0 items-center justify-between gap-[var(--vds-space-3)] border-t border-[var(--vds-divider-default)] bg-[var(--vds-bg-component)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]${size ? ' flex-wrap' : ''}`}
        >
          {action === 'translate' ? (
            <PromptSettingsGuide
              className={size ? 'min-w-0 flex-1 basis-1/2' : 'min-w-0 flex-1'}
              prefix={t(PROMPT_GUIDES.translate)}
              linkLabel={t('suggestion.promptSettings')}
              suffix={t('suggestion.promptGuideSuffix')}
            />
          ) : (
            <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
              {action === 'polish' ? t('suggestion.pending') : t('suggestion.resultHint')}
            </span>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)]">
            {onAnnotate && action !== 'polish' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!complete || busy || annotating || annotated}
                loading={annotating}
                onClick={() => void annotate()}
              >
                {t(annotated ? 'suggestion.addedToAnnotation' : 'suggestion.addToAnnotation')}
              </Button>
            ) : null}
            {action === 'polish' && onApply ? (
              <Button
                size="sm"
                variant="primary"
                disabled={!complete || busy || applying || !onApply}
                onClick={() => void apply()}
              >
                {t('suggestion.replace')}
              </Button>
            ) : (
              <CopyButton
                size="sm"
                writeText={writeClipboard}
                value={output}
                disabled={!complete || busy}
                errorLabel={t('suggestion.copyFailed')}
              />
            )}
          </div>
        </div>
      )}
      <div
        role="separator"
        aria-label={ui('floatingWindow.resize')}
        tabIndex={0}
        data-testid="resource-suggestion-resize"
        className="absolute bottom-0 right-0 h-[var(--vds-space-4)] w-[var(--vds-space-4)] cursor-se-resize touch-none rounded-br-[var(--vds-radius-2)] border-b-[length:var(--vds-border-width-2)] border-r-[length:var(--vds-border-width-2)] border-[var(--vds-border-default)] focus-visible:shadow-[var(--vds-focus-ring)]"
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={stopResize}
        onPointerCancel={stopResize}
        onLostPointerCapture={stopResize}
        onKeyDown={resizeByKeyboard}
      />
    </FloatingToolbar>
  )
}
