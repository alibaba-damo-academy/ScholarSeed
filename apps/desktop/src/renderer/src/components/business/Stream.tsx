import { referenceBaseLabel } from '../../features/assistant/text'
import { deliveryLabel } from '../../delivery'
import { formatTurnFailure } from '../../failures'
import { feedback, renderFeedback } from '../../contracts/feedback'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import aiThinking from '../../assets/ai-thinking.gif'
import { createFollowScroll } from './scroll'
import { activeThread, useApp } from '../../store'
import {
  ConvCard,
  ConvItem,
  DeliveryCardMember,
  SessionArtifact,
  TurnOutcome,
  TurnTiming,
  type HilResolvedMessage
} from '../../model'
import { Icon, type IconName } from '../../icons'
import { TONE } from '../../tone'
import { openByDefault } from '../../fileOpen'
import {
  formatHilPermissionScope,
  formatHilResolution,
  formatHilSubmissionError,
  hilEventResolution,
  hilPermissionScope,
  hilSubmissionFailure,
  isQuestionHil,
  pendingHilItems,
  permissionDecisionOptions,
  transcriptPresentationItems
} from '../../hil'
import { Markdown, visibleMarkdownText } from '../primitive/Markdown'
import { sourceOffsetRect } from '../markdown/source'
import { IconFont } from '../primitive/Iconfont'
import {
  confirmUnknownTurn,
  getHistoryWithTodos,
  interruptSession,
  postTurn,
  respondHil,
  rewindToPrompt
} from '../../api'
import { projectHistory, projectHistorySnapshot } from '../../transcript'
import {
  answerInteractionCapabilities,
  activityRunState,
  activityRows,
  type ActivityItem,
  type ArtifactItem,
  workingIndicatorVisible
} from '../../activity'
import {
  formatApplicationRequestFailure,
  formatRuntimeStatus,
  formatTurnUnknown,
  requestSessionResume
} from '../../runtime'
import { SentAttachments } from '../../features/assistant/Attachments'
import { AnnotatedAnswer } from '../../features/assistant/Annotations'
import { ArtifactCard } from '../../features/assistant/Artifacts'
import {
  AnnotationSummary,
  annotationDisplay
} from '../../features/assistant/Notes'
import { SessionReference } from '../../features/assistant/SessionReference'
import {
  DisplayCardView,
  useCardArtifacts,
  useLatestDisplayCards
} from './Cards'
import { useInteractionPolicies } from './Interactions'
import {
  activityDurationLabel,
  elapsedLabel,
  turnDurationLabel
} from './duration'
import { Finalizations } from '../../features/resources/Finalizations'
import { ReviewCard } from '../../features/resources/ReviewCard'
import { hasDirtyReviewEditor } from '../../contracts/resources'
import { resourceEditorHasChanges } from '../../contracts/workbench'
import {
  buildTurnInput,
  composerSubmissionOutcome,
  isComposerSubmissionAccepted,
  turnAdmissionFeedback
} from '../../input'
import {
  hasQueuedMessageAwaitingRuntime,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  rejectOptimisticQueuedMessage,
  settleOptimisticQueuedMessage,
  upsertQueuedMessage
} from '../../queue'
import { releaseQueuedOutbox, retainQueuedOutbox } from '../../outbox'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  EllipsisText,
  IconButton,
  ScrollArea,
  Spinner,
  Textarea,
  Tooltip
} from '../ui'

const HIL_WAIT_TICK_MS = 1000
const ACTIVITY_ELAPSED_TICK_MS = 1000
const EXTERNAL_RESULT_PROTOCOLS = new Set(['http:', 'https:'])
const HIL_OUTCOME_UNKNOWN_MESSAGE = 'stream.hil.outcomeUnknown'
const SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX = 140
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const ANSWER_SOURCE_RANGE_UNIT = 'utf16_code_unit'
const OPENABLE_RESOURCE_CONTEXT_KINDS = new Set(['file', 'resource'])
const SELECTION_CONTEXT_KIND = 'selection'
const LITERATURE_CONTEXT_KIND = 'literature'
const SESSION_CONTEXT_KIND = 'session'
type HilResponseBody = {
  option_id?: string
  answers?: Record<string, string>
  free_text?: string
  values?: Record<string, unknown>
  state_version?: number
  cancelled?: boolean
}
type HilAction =
  | {
      kind: 'respond'
      body: HilResponseBody
      label: string
      resolvedMessage?: HilResolvedMessage
      answers?: Record<string, string>
    }
  | { kind: 'cancel'; label?: string }

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}

const OUTLINE_HOVER_BUTTON_CLASS =
  '[transition:background_0.12s,color_0.12s,border-color_0.12s] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]'
const ACCENT_HOVER_BUTTON_CLASS =
  '[transition:filter_0.12s] hover:brightness-[1.06]'
const CHIP_BUTTON_CLASS =
  'rounded-[5px] border border-transparent bg-transparent px-[var(--vds-space-2)] py-[3px] text-[10px] text-[var(--text-3)] [transition:border-color_0.12s,color_0.12s] hover:bg-[var(--hover-bg)] hover:text-[var(--text-2)]'
const FLAT_BUTTON_CLASS =
  'min-h-[30px] appearance-none rounded-[5px] border border-transparent bg-[var(--bg-3)] px-[11px] py-[6px] text-[11px] leading-[1.25] text-[var(--text-2)] [transition:background_0.16s_ease,border-color_0.16s_ease,box-shadow_0.16s_ease,color_0.16s_ease,filter_0.16s_ease,transform_0.16s_cubic-bezier(0.2,0.8,0.2,1)] hover:enabled:-translate-y-px hover:enabled:bg-[var(--hover-bg)] hover:enabled:text-[var(--text)] active:enabled:scale-[0.982] active:enabled:translate-y-0 active:enabled:bg-[var(--active-bg)] active:enabled:text-[var(--active-text)] active:enabled:shadow-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_oklch,var(--accent)_50%,transparent)] disabled:opacity-55'
const READING_COLUMN_CLASS =
  'box-border w-full max-w-[var(--vds-conversation-content-width)] min-w-0 mx-auto'
const QUESTION_OPTION_MARK_CLASS =
  'h-[var(--vds-checkbox-mark-height)] w-[var(--vds-checkbox-mark-width)] rotate-[-45deg] translate-y-[var(--vds-checkbox-mark-offset-y)] border-solid border-current border-t-0 border-r-0 border-b-[length:var(--vds-checkbox-mark-border)] border-l-[length:var(--vds-checkbox-mark-border)]'
const MESSAGE_ACTIONS_CLASS =
  'mt-[7px] flex items-center gap-[var(--vds-space-1)]'
const TOOL_RUN_CLASS =
  'my-[10px] mb-[var(--vds-space-4)] overflow-clip rounded-[9px] bg-[color-mix(in_oklch,var(--bg-3)_56%,var(--bg-2))] shadow-[inset_0_0_0_1px_var(--border-soft)] [animation:tool-run-enter_240ms_cubic-bezier(0.2,0.8,0.2,1)_both] motion-reduce:animate-none'
const TOOL_RUN_TRIGGER_CLASS =
  'grid min-h-[46px] w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-[9px] border-0 bg-transparent px-[11px] py-[var(--vds-space-2)] pl-[10px] text-left text-[var(--text)] [transition:background_160ms_ease,color_160ms_ease] hover:bg-[color-mix(in_oklch,var(--hover-bg)_86%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color-mix(in_oklch,var(--active-border)_76%,transparent)]'
const TOOL_RUN_ICON_CLASS =
  'grid w-[25px] h-[25px] place-items-center rounded-[7px] bg-[color-mix(in_oklch,var(--accent-soft)_72%,var(--bg-2))] group-[.has-error]:bg-[color-mix(in_oklch,var(--c-tension)_12%,var(--bg-2))] group-[.is-running]:bg-[color-mix(in_oklch,var(--active-bg)_54%,var(--bg-2))]'
const TOOL_RUN_COPY_CLASS = 'grid min-w-0 gap-px'
const TOOL_RUN_TITLE_CLASS =
  'overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] font-semibold text-[var(--text)]'
const TOOL_RUN_SUMMARY_CLASS =
  'overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[var(--text-3)]'
const TOOL_RUN_STATE_CLASS =
  'inline-flex items-center justify-end gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] text-[var(--text-3)]'
const TOOL_RUN_STEP_STATUS_CLASS =
  'inline-flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'
const TOOL_RUN_STATUS_TONE_CLASS: Record<string, string> = {
  'is-running': 'text-[var(--c-fact)]',
  'is-done': 'text-[var(--c-experience)]',
  'is-error': 'text-[var(--c-tension)]',
  'is-cancelled': 'text-[var(--text-3)]'
}
const TOOL_RUN_PULSE_CLASS =
  'size-[6px] flex-none rounded-full bg-current [animation:tool-run-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none'
const TOOL_RUN_CARET_CLASS =
  'inline-flex items-center text-[var(--text-3)] transition-[transform,color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none group-[.is-open]:rotate-90 group-[.is-open]:text-[var(--text-2)]'
const TOOL_RUN_CONTENT_CLASS =
  'grid min-h-0 grid-rows-[0fr] opacity-0 pointer-events-none transition-[grid-template-rows,opacity] duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none group-[.is-open]:grid-rows-[1fr] group-[.is-open]:opacity-100 group-[.is-open]:pointer-events-auto'
const TOOL_RUN_CONTENT_INNER_CLASS = 'min-h-0 overflow-hidden'
const TOOL_RUN_STEPS_CLASS =
  'mb-[var(--vds-space-3)] min-w-0 border-l border-[var(--vds-border-default)] pl-[var(--vds-space-2)]'
const TOOL_RUN_STEP_CLASS =
  'group/step min-w-0 !gap-0 !border-0 !bg-transparent'
const TOOL_RUN_STEP_TRIGGER_CLASS =
  '!flex min-h-[var(--vds-control-height-md)] w-full cursor-pointer items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-2)] !border-0 !bg-transparent px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] transition-colors duration-[var(--vds-duration-fast)] hover:!bg-[var(--vds-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--vds-brand-text-primary)]'
const TOOL_RUN_STEP_NAME_CLASS =
  'shrink-0 font-normal text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]'
const TOOL_RUN_STEP_CARET_CLASS =
  'inline-flex items-center text-[var(--text-3)] transition-[transform,color] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none group-[.is-open]/step:rotate-90 group-[.is-open]/step:text-[var(--text-2)]'
const TOOL_RUN_STEP_CONTENT_CLASS =
  'grid min-h-0 grid-rows-[0fr] opacity-0 pointer-events-none transition-[grid-template-rows,opacity] duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none group-[.is-open]/step:grid-rows-[1fr] group-[.is-open]/step:opacity-100 group-[.is-open]/step:pointer-events-auto'
const TOOL_RUN_IO_STACK_CLASS =
  'ml-[calc(var(--vds-space-4)*2)] mr-[var(--vds-space-2)] mb-[var(--vds-space-3)] flex flex-col gap-[var(--vds-space-3)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]'
const TOOL_RUN_MARKDOWN_CLASS =
  '!font-mono !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-text-secondary)] [&_code]:!text-[length:var(--vds-font-body-lv1)] [&_code]:!leading-[var(--vds-lh-body-lv1)] [&_table]:!text-[length:var(--vds-font-body-lv1)] [&_.md-p]:!my-[var(--vds-space-2)] [&_.md-p:first-child]:!mt-0 [&_.md-p:last-child]:!mb-0'
const TOOL_RUN_IO_LABEL_CLASS =
  'mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-medium text-[var(--vds-text-secondary)]'
const TOOL_RUN_IO_CLASS =
  'm-[var(--vds-space-0)] max-h-[240px] overflow-auto rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-mono text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
const ACTIVITY_LINE_CLASS =
  'group/activity m-0 !flex !min-h-[28px] w-fit max-w-full cursor-pointer items-center gap-[var(--vds-space-2)] !border-0 !bg-transparent !p-0 text-left text-[12.5px] !font-normal leading-[1.45] !text-[var(--vds-text-tertiary)] shadow-none transition-colors duration-150 hover:!bg-transparent hover:!text-[var(--vds-text-primary)]'

type ToolItem = Extract<ConvItem, { kind: 'tool' }>
type WebSearchItem = Extract<ConvItem, { kind: 'web_search' }>
type PaperSearchItem = Extract<ConvItem, { kind: 'paper_search' }>
type SearchActivityItem = WebSearchItem | PaperSearchItem
type SkillActivityItem = Extract<ConvItem, { kind: 'skill' }>
type NativeActivityItem = Extract<ConvItem, { kind: 'native_activity' }>
type ThinkingActivityItem = Extract<ConvItem, { kind: 'thinking' }>

const TOOL_STATUS_KEYS = {
  running: { messageKey: 'stream.toolStatus.running' },
  done: { messageKey: 'stream.toolStatus.done' },
  error: { messageKey: 'stream.toolStatus.error' },
  cancelled: { messageKey: 'stream.toolStatus.cancelled' }
} as const

const NATIVE_ACTIVITY_LABELS = {
  hook_prompt: 'stream.native.hookPrompt',
  plan: 'stream.native.plan',
  agent_collaboration: 'stream.native.agentCollaboration',
  subagent_activity: 'stream.native.subagentActivity',
  image_view: 'stream.native.imageView',
  wait: 'stream.native.wait',
  image_generation: 'stream.native.imageGeneration',
  approval_review: 'stream.native.approvalReview',
  review_entered: 'stream.native.reviewEntered',
  review_exited: 'stream.native.reviewExited',
  runtime_activity: 'stream.native.runtimeActivity'
} as const
const USER_REFERENCE_TYPE_LABELS = {
  skill: 'stream.referenceType.skill',
  assistant_context: 'stream.referenceType.assistantContext'
} as const

function userMessageRefType(type: string, t: TFunction<'components'>): string {
  if (type === 'skill') return t(USER_REFERENCE_TYPE_LABELS.skill)
  if (type === 'assistant_context')
    return t(USER_REFERENCE_TYPE_LABELS.assistant_context)
  return type
}

function compactDurationLabel(
  startedAt: number | undefined,
  endedAt: number | undefined,
  completed: boolean
): string | null {
  if (startedAt === undefined || endedAt === undefined) return null
  const milliseconds = Math.max(0, endedAt - startedAt)
  const seconds =
    completed && milliseconds > 0
      ? Math.ceil(milliseconds / 1000)
      : Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function Btn({
  children,
  tone,
  ghost,
  onClick
}: {
  children: React.ReactNode
  tone?: string
  ghost?: boolean
  onClick?: () => void
}): React.JSX.Element {
  const filled = tone && !ghost
  return (
    <Button
      unstyled
      onClick={onClick}
      className={cx(
        OUTLINE_HOVER_BUTTON_CLASS,
        'rounded-lg px-[13px] py-[6px] text-[11.5px]',
        filled
          ? 'border-0 bg-[var(--btn-tone)] text-[var(--on-accent)]'
          : 'border border-[var(--border)] bg-transparent text-[var(--btn-tone)]',
        ghost && !filled && 'text-[var(--text-2)]'
      )}
      style={{ '--btn-tone': tone ?? 'var(--text-2)' } as React.CSSProperties}
    >
      {children}
    </Button>
  )
}

const cardBox = (color: string): React.CSSProperties => ({
  marginTop: 18,
  paddingLeft: 20,
  borderLeft: `2px solid ${color}`,
  animation: 'cardIn .5s ease both'
})

const rewindOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--vds-z-session-confirm)',
  display: 'grid',
  placeItems: 'center',
  padding: 20,
  background: 'color-mix(in srgb, var(--text) 18%, transparent)',
  backdropFilter: 'saturate(0.9)',
  WebkitBackdropFilter: 'saturate(0.9)'
}

const rewindDialogStyle: React.CSSProperties = {
  width: 'min(360px, calc(100vw - 40px))',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '22px 22px 20px',
  background: 'var(--bg-2)',
  boxShadow: 'var(--shadow)'
}

export function Stream({
  home = false,
  onOpenDelivery
}: {
  home?: boolean
  onOpenDelivery?: (member: DeliveryCardMember) => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, set, patchThread } = useApp()
  const thread = activeThread(state)
  const resourceProject = state.projects.find(
    (project) => project.path === thread.projectPath
  )
  const conv =
    state.activeSession === null && state.turnLaunch
      ? [state.turnLaunch.optimisticUserMessage]
      : thread.conversation
  const currentConv = useLatestDisplayCards(conv)
  const pendingHil = pendingHilItems(conv)
  const streamRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const focusSpacerRef = useRef<HTMLDivElement>(null)
  const focusedSessionRef = useRef<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const showScrollToBottomRef = useRef(false)
  const resumeFollowOnScroll = useRef(false)
  // Turn 终态事件是停止工作态的唯一依据。中途 assistant 文本之后仍可能继续执行
  // 不需要单独展示的活动（例如 web_fetch），因此不能根据最后一条文本隐藏运行标签。
  const busy =
    thread.running === true ||
    thread.status === 'running' ||
    thread.status === 'waiting'
  const admitting =
    state.turnLaunch !== null ||
    hasQueuedMessageAwaitingRuntime(thread.queuedMessages ?? [])
  const showWorking = workingIndicatorVisible(
    busy,
    admitting,
    pendingHil.length
  )
  const cardArtifacts = useCardArtifacts(currentConv)
  const presented = transcriptPresentationItems(currentConv).filter(
    (item) =>
      item.kind !== 'artifact' || !cardArtifacts.has(item.artifact.artifact_id)
  )
  const rows = activityRows(presented, thread.turnOutcomes)
  const finalAgentRows = new Set<number>()
  const turnsWithFinalAgent = new Set<string>()
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (
      row.kind !== 'item' ||
      row.item.kind !== 'agent' ||
      !row.item.turnId ||
      turnsWithFinalAgent.has(row.item.turnId)
    ) continue
    turnsWithFinalAgent.add(row.item.turnId)
    finalAgentRows.add(index)
  }
  const sessionRef = useRef(thread.sessionId)
  sessionRef.current = thread.sessionId
  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      if (home) return
      const stream = streamRef.current
      if (!stream) return
      focusedSessionRef.current = null
      if (focusSpacerRef.current) focusSpacerRef.current.style.height = '0px'
      stream.scrollTo({ top: stream.scrollHeight, behavior })
    },
    [home]
  )
  const updateScrollToBottomVisibility = React.useCallback((): void => {
    const stream = streamRef.current
    if (!stream || home) {
      setShowScrollToBottom(false)
      return
    }
    const distance =
      stream.scrollHeight - stream.scrollTop - stream.clientHeight
    const visible = distance > SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX
    showScrollToBottomRef.current = visible
    setShowScrollToBottom(visible)
  }, [home])

  const followScroll = React.useMemo(() => createFollowScroll(
    () => {
      scrollToBottom('auto')
      updateScrollToBottomVisibility()
    },
    (callback) => requestAnimationFrame(callback),
    (frame) => cancelAnimationFrame(frame)
  ), [scrollToBottom, updateScrollToBottomVisibility])

  useEffect(() => () => followScroll.cancel(), [followScroll])

  useLayoutEffect(() => {
    followScroll.resume()
    resumeFollowOnScroll.current = false
  }, [followScroll, thread.sessionId])

  const continueTurn = async (
    failure: Extract<ConvItem, { kind: 'error' }>
  ): Promise<void> => {
    const sessionId = thread.sessionId
    if (!sessionId || busy) return
    const patchFailure = (
      patch: Partial<Extract<ConvItem, { kind: 'error' }>>
    ): void =>
      patchThread(thread.id, (current) => ({
        conversation: current.conversation.map((item) =>
          item.kind === 'error' &&
          item.runtimeAction === 'continue_turn' &&
          item.turnId === failure.turnId
            ? { ...item, ...patch }
            : item
        )
      }))
    if (
      state.aiPanel.sessionId !== sessionId ||
      state.aiPanel.contextState !== 'ready'
    ) {
      patchFailure({
        actionState: 'failed',
        actionError: feedback('conversation', 'retry.contextNotReady')
      })
      return
    }
    const reviewProject =
      thread.projectPath ?? thread.workdir ?? state.resource.root
    if (
      resourceProject &&
      reviewProject &&
      (await hasDirtyReviewEditor(
        resourceProject.id,
        reviewProject,
        resourceEditorHasChanges
      ))
    ) {
      patchFailure({
        actionState: 'failed',
        actionError: feedback('shell', 'foreground.reviewUnsaved')
      })
      return
    }
    let input
    try {
      input = buildTurnInput(t('stream.continueInterrupted'), [])
    } catch (error) {
      patchFailure({
        actionState: 'failed',
        actionError: error instanceof Error ? error.message : String(error)
      })
      return
    }
    patchFailure({ actionState: 'submitting', actionError: undefined })
    const clientUserMessageId = crypto.randomUUID()
    const optimistic = optimisticQueuedMessage(
      thread.queuedMessages ?? [],
      clientUserMessageId,
      input,
      [],
      state.aiPanel.revision
    )
    retainQueuedOutbox(sessionId, optimistic)
    patchThread(thread.id, (current) => ({
      queuedMessages: upsertQueuedMessage(
        current.queuedMessages ?? [],
        optimistic
      )
    }))
    const delivered = await postTurn(
      sessionId,
      input,
      state.collaborationMode,
      {
        clientUserMessageId,
        assistantContextRevision: state.aiPanel.revision
      }
    )
    const submissionOutcome = composerSubmissionOutcome(delivered)
    if (submissionOutcome === 'rejected') {
      releaseQueuedOutbox(sessionId, clientUserMessageId)
      patchThread(thread.id, (current) => ({
        queuedMessages: rejectOptimisticQueuedMessage(
          current.queuedMessages ?? [],
          clientUserMessageId
        )
      }))
      patchFailure({
        actionState: 'failed',
        actionError: delivered
          ? turnAdmissionFeedback(delivered)
          : feedback('components', 'composer.messageFailed')
      })
      return
    }
    if (submissionOutcome === 'unknown') {
      patchThread(thread.id, (current) => ({
        queuedMessages: markOptimisticQueueOutcomeUnknown(
          current.queuedMessages ?? [],
          clientUserMessageId
        )
      }))
      patchFailure({
        actionState: 'outcome_unknown',
        actionError: feedback('conversation', 'retry.continueUnknown')
      })
      return
    }
    releaseQueuedOutbox(sessionId, clientUserMessageId)
    patchThread(thread.id, (current) => ({
      conversation: current.conversation.filter((item) => !(
        item.kind === 'error'
        && item.runtimeAction === 'continue_turn'
        && item.turnId === failure.turnId
      )),
      queuedMessages: settleOptimisticQueuedMessage(
        current.queuedMessages ?? [],
        clientUserMessageId
      )
    }))
  }

  useLayoutEffect(() => {
    if (busy) focusedSessionRef.current = null
  }, [busy])

  useLayoutEffect(() => {
    if (
      !state.aiPanel.messageFocus &&
      focusedSessionRef.current !== thread.sessionId
    ) followScroll.request()
  }, [busy, conv, showWorking, followScroll, state.aiPanel.messageFocus, thread.sessionId])

  useLayoutEffect(() => {
    const focus = state.aiPanel.messageFocus
    if (
      home ||
      !focus ||
      focus.sessionId !== thread.sessionId ||
      !columnRef.current ||
      !streamRef.current
    )
      return
    if (thread.resumeState === 'pending') return
    const candidates = Array.from(
      columnRef.current.querySelectorAll<HTMLElement>(
        '[data-message-item-id], [data-message-turn-id]'
      )
    )
    const target =
      candidates.find(
        (element) =>
          Boolean(focus.itemId) &&
          element.dataset.messageItemId === focus.itemId
      ) ??
      candidates.find(
        (element) =>
          Boolean(focus.turnId) &&
          element.dataset.messageTurnId === focus.turnId
      )
    if (!target) return
    const scrollTarget =
      target.firstElementChild instanceof HTMLElement
        ? target.firstElementChild
        : target
    const stream = streamRef.current
    const sourceRange = focus.sourceRange
    const bounds = sourceRange?.unit === ANSWER_SOURCE_RANGE_UNIT
      ? sourceOffsetRect(scrollTarget, sourceRange.start) ?? scrollTarget.getBoundingClientRect()
      : scrollTarget.getBoundingClientRect()
    const top = stream.scrollTop + bounds.top - stream.getBoundingClientRect().top - stream.clientTop
    const spacer = focusSpacerRef.current
    if (spacer) {
      const contentHeight = stream.scrollHeight - spacer.offsetHeight
      spacer.style.height = `${Math.max(0, top + stream.clientHeight - contentHeight)}px`
    }
    showScrollToBottomRef.current = true
    focusedSessionRef.current = thread.sessionId ?? null
    followScroll.pause()
    stream.scrollTo({ top, behavior: 'instant' })
    updateScrollToBottomVisibility()
    set((current) => ({
      aiPanel: { ...current.aiPanel, messageFocus: null }
    }))
  }, [conv, followScroll, home, set, state.aiPanel, thread.resumeState, thread.sessionId, updateScrollToBottomVisibility])

  useEffect(() => {
    if (home || !columnRef.current) return () => undefined
    const observer = new ResizeObserver(() => {
      if (focusedSessionRef.current !== thread.sessionId) followScroll.request()
    })
    observer.observe(columnRef.current)
    return () => observer.disconnect()
  }, [followScroll, home, thread.sessionId])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream || home) return () => undefined
    updateScrollToBottomVisibility()
    const onScroll = (): void => {
      updateScrollToBottomVisibility()
      if (resumeFollowOnScroll.current && !showScrollToBottomRef.current) followScroll.resume()
    }
    stream.addEventListener('scroll', onScroll, {
      passive: true
    })
    window.addEventListener('resize', updateScrollToBottomVisibility)
    return () => {
      stream.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', updateScrollToBottomVisibility)
    }
  }, [followScroll, home, updateScrollToBottomVisibility])

  useLayoutEffect(() => {
    updateScrollToBottomVisibility()
  }, [conv, showWorking, updateScrollToBottomVisibility])

  useEffect(() => {
    const sessionId = thread.sessionId
    if (!sessionId || busy) return () => undefined
    let current = true
    void getHistoryWithTodos(sessionId).then((history) => {
      if (!current || sessionRef.current !== sessionId || !history) return
      patchThread(thread.id, (active) =>
        active.sessionId === sessionId
          ? {
              conversation: projectHistorySnapshot(history, active.conversation)
            }
          : {}
      )
    })
    return () => {
      current = false
    }
  }, [busy, patchThread, thread.id, thread.sessionId])

  const rewindPrompt = async (anchor: number): Promise<string | null> => {
    const sessionId = thread.sessionId
    if (!sessionId || busy) return t('stream.running')
    const response = await rewindToPrompt(sessionId, anchor)
    if (sessionRef.current !== sessionId) return null
    if (!response?.ok) {
      const reason = response?.reason || ''
      return reason.includes('workspace changed outside ScholarSeed')
        ? t('stream.conflict')
        : t('stream.rewindFailed')
    }
    patchThread(thread.id, (active) =>
      active.sessionId === sessionId
        ? {
            conversation: projectHistory(response.turns || []),
            contextChannels: {},
            recall: [],
            recallQuery: null,
            todos: [],
            todoTurnId: null,
            turnOutcomes: {},
            turnTimings: {},
            backgroundTasks: {},
            running: false,
            status: 'done'
          }
        : {}
    )
    return null
  }

  // 切到新会话 (如创建资源开的新 session) → 整列以 key 重挂 + 入场动效, 平滑滑入而非生硬切换。
  const threadKey = thread.id
  return (
    <div
      ref={streamRef}
      onWheel={(event) => {
        focusedSessionRef.current = null
        followScroll.pause()
        resumeFollowOnScroll.current = event.deltaY > 0
        if (resumeFollowOnScroll.current && !showScrollToBottomRef.current) followScroll.resume()
      }}
      onPointerDown={() => {
        focusedSessionRef.current = null
        followScroll.pause()
        resumeFollowOnScroll.current = false
      }}
      onKeyDown={() => {
        focusedSessionRef.current = null
        followScroll.pause()
        resumeFollowOnScroll.current = false
      }}
      className={cx(
        'conversation-stream [--vds-card-radius:var(--vds-radius-6)] [container-name:conversation-stream] [container-type:inline-size] [scrollbar-gutter:stable_both-edges] [overflow-anchor:none] [&::-webkit-scrollbar]:w-[var(--vds-conversation-scrollbar-width)] [&_.vds-card]:!shadow-none',
        home ? 'pt-0' : 'pt-[var(--vds-space-4)]'
      )}
      style={{
        flex: home ? 'none' : 1,
        minHeight: 0,
        overflowY: home ? 'visible' : 'auto',
        paddingInline: 'var(--vds-conversation-inline-gutter)',
        paddingBottom: home ? '8px' : '10px',
        userSelect: 'text',
        WebkitUserSelect: 'text',
        cursor: 'auto'
      }}
    >
      <div
        ref={columnRef}
        key={threadKey}
        className={READING_COLUMN_CLASS}
        data-testid="conversation-content"
        style={{ animation: 'overlayIn .32s cubic-bezier(.4,0,.2,1) both' }}
      >
        {conv.length === 0 && <Empty home={home} />}
        {rows.map((row, index) => {
          const previous = rows[index - 1]
          const next = rows[index + 1]
          const attachedArtifacts =
            row.kind === 'item' &&
            row.item.kind === 'agent' &&
            next?.kind === 'artifacts' &&
            next.turnId === row.item.turnId
              ? next
              : undefined
          if (
            row.kind === 'artifacts' &&
            previous?.kind === 'item' &&
            previous.item.kind === 'agent' &&
            previous.item.turnId === row.turnId
          )
            return null
          if (row.kind === 'activity')
            return (
              <ActivityRun
                key={row.key}
                items={row.items}
                turnId={row.turnId}
                tail={row.tail}
                outcome={
                  row.turnId ? thread.turnOutcomes?.[row.turnId] : undefined
                }
                timing={
                  row.turnId ? thread.turnTimings?.[row.turnId] : undefined
                }
              />
            )
          if (row.kind === 'artifacts')
            return (
              <ArtifactCard
                key={row.key}
                items={row.items}
                turnId={row.turnId}
              />
            )
          return (
            <div
              key={row.key}
              className="contents"
              data-message-turn-id={row.item.turnId || undefined}
              data-message-item-id={row.item.itemId || undefined}
            >
              <Item
                item={row.item}
                trailingContent={
                  attachedArtifacts ? (
                    <ArtifactCard
                      items={attachedArtifacts.items}
                      turnId={attachedArtifacts.turnId}
                    />
                  ) : undefined
                }
                running={busy}
                turnOutcome={
                  row.item.turnId
                    ? thread.turnOutcomes?.[row.item.turnId]
                    : undefined
                }
                turnTiming={
                  finalAgentRows.has(index) && row.item.turnId
                    ? thread.turnTimings?.[row.item.turnId]
                    : undefined
                }
                onRewind={rewindPrompt}
                onContinue={continueTurn}
                onOpenDelivery={onOpenDelivery}
              />
            </div>
          )
        })}
        {resourceProject && thread.sessionId && (
          <Finalizations
            key={`${resourceProject.id}:${thread.sessionId}`}
            project={resourceProject.id}
            sessionId={thread.sessionId}
            running={busy}
            revision={thread.lastSeq}
          />
        )}
        {showWorking && <Working waiting={thread.status === 'waiting'} />}
        <div ref={endRef} />
        <div ref={focusSpacerRef} aria-hidden="true" />
      </div>
      {showScrollToBottom && (
        <Button
          unstyled
          type="button"
          className="sticky bottom-[14px] [left:50%] z-[var(--vds-z-scroll-control)] mx-auto mb-[10px] mt-[-52px] grid w-[35px] h-[35px] cursor-pointer place-items-center rounded-full border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-2)_94%,transparent)] p-[var(--vds-space-0)] text-[var(--text-2)] shadow-[var(--shadow)] [animation:cardIn_0.18s_ease_both] hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)] focus-visible:outline-none"
          data-testid="scroll-to-bottom"
          aria-label={t('stream.bottom')}
          title={t('stream.bottom')}
          onClick={() => {
            followScroll.resume()
            scrollToBottom(window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'auto' : 'smooth')
          }}
        >
          <span
            aria-hidden
            style={{ transform: 'rotate(180deg)', display: 'inline-grid' }}
          >
            <Icon name="send" size={18} sw={1.9} />
          </span>
        </Button>
      )}
    </div>
  )
}

/** Active interactions are blocking turn controls and stay adjacent to the composer. */
export function PendingHilDock(): React.JSX.Element | null {
  const { state } = useApp()
  const interactions = pendingHilItems(activeThread(state).conversation)
  if (interactions.length === 0) return null
  return (
    // 底部 pb-4：HIL 卡与下方执行计划/输入框容器的间距统一为 4px（卡自身 dock 态 mb-0）。
    <div
      className="relative z-[var(--vds-z-local-top)] flex min-h-0 flex-[1_1_auto] flex-col overflow-hidden bg-transparent px-[var(--vds-conversation-inline-gutter)] pt-[var(--vds-space-2)] pb-[var(--vds-space-1)]"
      data-testid="hil-dock"
    >
      <div className={cx(READING_COLUMN_CLASS, '@container flex min-h-0 flex-1 flex-col')}>
        <HilCard
          key={interactions[0].requestId}
          item={interactions[0]}
          presentation="dock"
          queueCount={interactions.length}
        />
      </div>
    </div>
  )
}

export function ConversationControls({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return (
    // 禁 overflow-hidden: composer 的 @/技能弹层是 absolute 向上弹出、会超出本容器盒子被裁成一条边; 高度收敛靠 composer 内部限高滚动。
    <div className="vds-ai-composer-host flex min-h-0 max-h-full flex-[0_1_auto] flex-col px-[var(--vds-conversation-scrollbar-width)]">
      <PendingHilDock />
      <div className="flex-none">{children}</div>
    </div>
  )
}

/** 「书深正在思考」脉冲指示（后台运行但前台尚无消息时的状态动态）。 */
function Working({ waiting }: { waiting: boolean }): React.JSX.Element {
  const { t } = useTranslation('components')
  const label = waiting ? t('stream.waiting') : t('stream.thinking')
  return (
    <div
      className="mb-[var(--vds-space-5)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]"
      role="status"
      data-testid="assistant-working"
    >
      {waiting ? (
        <Icon name="schedule" size={14} />
      ) : (
        <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
      )}
      <span>{label}</span>
    </div>
  )
}

function Empty({ home = false }: { home?: boolean }): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <div
      style={{
        marginTop: home ? 0 : 84,
        textAlign: 'center',
        color: 'var(--text-3)'
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '4px 12px',
          marginBottom: 14
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--accent)'
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
          {t('stream.newWorkspace')}
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 18,
          color: 'var(--text-2)',
          marginBottom: 6
        }}
      >
        {t('stream.start')}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.7 }}>
        {t('stream.startHint')}
      </div>
    </div>
  )
}

function Item({
  item,
  trailingContent,
  running,
  turnOutcome,
  turnTiming,
  onRewind,
  onContinue,
  onOpenDelivery
}: {
  item: ConvItem
  trailingContent?: React.ReactNode
  running: boolean
  turnOutcome?: TurnOutcome
  turnTiming?: TurnTiming
  onRewind: (anchor: number) => Promise<string | null>
  onContinue: (item: Extract<ConvItem, { kind: 'error' }>) => Promise<void>
  onOpenDelivery?: (member: DeliveryCardMember) => void
}): React.JSX.Element | null {
  switch (item.kind) {
    case 'day':
      return <Day text={item.text} />
    case 'prompt':
      return <PromptCard text={item.text} />
    case 'reentry':
      return <Reentry item={item} />
    case 'user':
      return <UserBubble item={item} running={running} onRewind={onRewind} />
    case 'interaction_reply':
      return <InteractionReply item={item} />
    case 'agent': {
      const interactions = answerInteractionCapabilities(turnOutcome)
      return (
        <AgentMsg
          citationEnabled={interactions.citationEnabled}
          copyEnabled={turnOutcome !== 'running'}
          item={item}
          trailingContent={trailingContent}
          selectionEnabled={turnOutcome !== 'running'}
          timing={turnTiming}
        />
      )
    }
    case 'delivery':
      return <DeliveryCard item={item} onOpen={onOpenDelivery} />
    case 'artifact':
      return <ArtifactCard items={[item]} turnId={item.turnId} />
    case 'review':
      return <ReviewCard review={item.review} />
    case 'display_card':
      return <DisplayCardView card={item.card} />
    case 'thinking':
      return (
        <Thinking
          text={item.text}
          itemId={item.itemId}
          selectionEnabled={turnOutcome !== 'running'}
        />
      )
    case 'status':
      return <StatusLine item={item} />
    case 'notice':
      return (
        <NoticeLine
          text={item.text}
          message={item.message}
          displayMessage={item.displayMessage}
        />
      )
    case 'error':
      return <ErrorCard item={item} onContinue={onContinue} />
    case 'tool':
      return item.status === 'running' || item.status === 'error' ? (
        <ActivityRun items={[item]} turnId={item.turnId} />
      ) : null
    case 'web_search':
      return <SearchActivityCard item={item} />
    case 'paper_search':
      return <SearchActivityCard item={item} />
    case 'skill':
      return <ActivityRun items={[item]} turnId={item.turnId} />
    case 'native_activity':
      return <ActivityRun items={[item]} turnId={item.turnId} />
    case 'hil':
      return <HilCard item={item} />
    default:
      return <></>
  }
}

function DeliveryCard({
  item,
  onOpen
}: {
  item: Extract<ConvItem, { kind: 'delivery' }>
  onOpen?: (member: DeliveryCardMember) => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { delivery } = item
  const primary =
    delivery.members.find((member) => member.primary) ?? delivery.members[0]
  const label = deliveryLabel(delivery, conversation)
  const previewTarget =
    delivery.members.find(
      (member) => member.primary && member.previewAvailable
    ) ?? delivery.members.find((member) => member.previewAvailable)
  const revision = primary?.revision.replace('sha256:', '').slice(0, 9) ?? ''
  const meta = primary
    ? `${primary.workspacePath} · ${revision}`
    : t('stream.noArtifacts')
  const open = (): void => {
    if (
      !previewTarget ||
      (!previewTarget.materialId && !previewTarget.workspacePath)
    )
      return
    onOpen?.(previewTarget)
  }
  return (
    <div
      className="flex items-center gap-[12px] rounded-[9px] border border-[var(--border)] bg-[var(--bg-2)] px-[14px] py-[13px] [margin:-10px_0_28px_41px] @max-[44rem]:m-[var(--vds-space-0)] @max-[44rem]:mb-[18px] @max-[44rem]:grid @max-[44rem]:grid-cols-[30px_minmax(0,1fr)_34px] @max-[44rem]:grid-areas-[icon_copy_action] @max-[44rem]:gap-[9px] @max-[44rem]:rounded-[10px] @max-[44rem]:p-[10px]"
      data-testid="delivery-card"
    >
      <div className="grid size-[34px] flex-none place-items-center rounded-[7px] bg-[var(--bg-3)] text-[var(--text-2)] @max-[44rem]:[grid-area:icon] @max-[44rem]:size-[30px]">
        <Icon name="artifacts" size={17} sw={2} />
      </div>
      <div className="min-w-0 flex-1 @max-[44rem]:[grid-area:copy]">
        <div className="text-[9px] font-[650] uppercase tracking-[0.12em] text-[var(--text-3)] @max-[44rem]:hidden">
          {t('stream.registered', { count: delivery.members.length })}
        </div>
        <div
          className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-[650] text-[var(--text)] @max-[44rem]:m-[var(--vds-space-0)] @max-[44rem]:text-xs @max-[44rem]:leading-[1.3]"
          title={label}
        >
          {label}
        </div>
        <div
          className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[9.5px] text-[var(--text-3)] @max-[44rem]:text-[9px] @max-[44rem]:leading-[1.3]"
          title={meta}
        >
          {meta}
        </div>
      </div>
      {previewTarget && onOpen && (
        <a
          className={cx(
            FLAT_BUTTON_CLASS,
            'flex-none self-center justify-self-end border-[var(--border)] text-[var(--text-2)] hover:enabled:border-[color-mix(in_oklch,var(--accent)_46%,var(--border))] hover:enabled:bg-[var(--accent-soft)] hover:enabled:text-[var(--accent-ink)] @max-[44rem]:inline-flex @max-[44rem]:size-[34px] @max-[44rem]:min-w-[34px] @max-[44rem]:items-center @max-[44rem]:justify-center @max-[44rem]:rounded-lg @max-[44rem]:p-[var(--vds-space-0)] @max-[44rem]:[grid-area:action]'
          )}
          data-testid="delivery-card-open-preview"
          aria-label={t('stream.previewFile')}
          title={t('stream.previewFile')}
          onClick={(event) => {
            event.preventDefault()
            open()
          }}
        >
          <span className="@max-[44rem]:hidden">{t('stream.preview')}</span>
          <span className="hidden @max-[44rem]:inline-flex @max-[44rem]:w-full h-full @max-[44rem]:items-center @max-[44rem]:justify-center @max-[44rem]:leading-none [&_svg]:block [&_svg]:flex-none">
            <Icon name="expand" size={16} sw={1.8} />
          </span>
        </a>
      )}
    </div>
  )
}

function toolValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function toolPreview(item: ToolItem): string {
  return (item.result || '').split('\n')[0].slice(0, 56)
}

function loadedSkillName(item: ToolItem): string | null {
  if (item.name !== 'Skill' || !item.input || typeof item.input !== 'object')
    return null
  const skillName = (item.input as { skill?: unknown }).skill
  return typeof skillName === 'string' && skillName.trim()
    ? skillName.trim()
    : null
}

function toolLabel(item: ToolItem, t: TFunction<'conversation'>): string {
  const skillName = loadedSkillName(item)
  const key = TOOL_ACTION_LABELS[activityAction(item)]
  return skillName
    ? t('toolActions.skill', { name: skillName })
    : key
      ? t(key)
      : item.name
}

const TOOL_ACTION_LABELS: Partial<
  Record<
    ActivityAction,
    | 'toolActions.command'
    | 'toolActions.read'
    | 'toolActions.edit'
    | 'toolActions.image'
  >
> = {
  command: 'toolActions.command',
  read: 'toolActions.read',
  edit: 'toolActions.edit',
  image: 'toolActions.image'
}

const ACTIVITY_ERROR_STATUS: ToolItem['status'] = 'error'
const ACTIVITY_STATUS_ICONS: Record<ToolItem['status'], string> = {
  done: 'a-line-status-success',
  [ACTIVITY_ERROR_STATUS]: 'a-line-status-error',
  cancelled: 'a-line-status-notfull',
  running: 'fill-status-loading'
}

function ActivityStatusIcon({
  status
}: {
  status: ToolItem['status']
}): React.JSX.Element {
  if (status === 'running') {
    return <Spinner imageSrc={aiThinking} size="sm" className="!size-[var(--vds-icon-7)] shrink-0" aria-hidden="true" />
  }
  return (
    <IconFont
      type={ACTIVITY_STATUS_ICONS[status]}
      className={cx(
        'inline-flex size-[var(--vds-icon-7)] shrink-0 items-center justify-center !text-[length:var(--vds-icon-7)]',
        TOOL_RUN_STATUS_TONE_CLASS[`is-${status}`]
      )}
    />
  )
}

const TOOL_SUMMARY_FIELDS = [
  'command',
  'cmd',
  'file_path',
  'path',
  'filename'
] as const

function toolInputSummary(item: ToolItem): string {
  if (typeof item.input === 'string') return item.input
  if (!item.input || typeof item.input !== 'object') return ''
  const input = item.input as Record<string, unknown>
  for (const field of TOOL_SUMMARY_FIELDS) {
    if (typeof input[field] === 'string') return input[field]
  }
  return ''
}

function latestRunningTool(items: ToolItem[]): ToolItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function latestRunningSearch(
  items: WebSearchItem[]
): WebSearchItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function latestRunningPaperSearch(
  items: PaperSearchItem[]
): PaperSearchItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function latestRunningNativeActivity(
  items: NativeActivityItem[]
): NativeActivityItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function nativeActivityLabel(
  item: NativeActivityItem,
  t: TFunction<'components'>
): string {
  if (item.activityType === 'hook_prompt')
    return t(NATIVE_ACTIVITY_LABELS.hook_prompt)
  if (item.activityType === 'plan') return t(NATIVE_ACTIVITY_LABELS.plan)
  if (item.activityType === 'agent_collaboration')
    return t(NATIVE_ACTIVITY_LABELS.agent_collaboration)
  if (item.activityType === 'subagent_activity')
    return t(NATIVE_ACTIVITY_LABELS.subagent_activity)
  if (item.activityType === 'image_view')
    return t(NATIVE_ACTIVITY_LABELS.image_view)
  if (item.activityType === 'wait') return t(NATIVE_ACTIVITY_LABELS.wait)
  if (item.activityType === 'image_generation')
    return t(NATIVE_ACTIVITY_LABELS.image_generation)
  if (item.activityType === 'approval_review')
    return t(NATIVE_ACTIVITY_LABELS.approval_review)
  if (item.activityType === 'review_entered')
    return t(NATIVE_ACTIVITY_LABELS.review_entered)
  if (item.activityType === 'review_exited')
    return t(NATIVE_ACTIVITY_LABELS.review_exited)
  if (item.activityType === 'runtime_activity')
    return t(NATIVE_ACTIVITY_LABELS.runtime_activity)
  return t('stream.native.fallback', { type: item.activityType })
}

type ActivityAction =
  | 'thinking'
  | 'command'
  | 'edit'
  | 'image'
  | 'read'
  | 'skill'
  | 'web'
  | 'paper'
  | 'collaboration'
  | 'wait'
  | 'other'

const ACTIVITY_ACTION_ICONS: Record<ActivityAction, IconName> = {
  thinking: 'sparkle',
  command: 'gear',
  edit: 'edit-square',
  image: 'image',
  read: 'doc',
  skill: 'skills',
  web: 'search',
  paper: 'books',
  collaboration: 'agents',
  wait: 'schedule',
  other: 'gear'
}

function activityAction(item: ActivityItem): ActivityAction {
  if (item.kind === 'thinking') return 'thinking'
  if (item.kind === 'web_search') return 'web'
  if (item.kind === 'paper_search') return 'paper'
  if (item.kind === 'skill') return 'skill'
  if (item.kind === 'native_activity') {
    if (item.activityType === 'image_view' || item.category === 'media')
      return 'image'
    if (item.category === 'collaboration') return 'collaboration'
    if (item.category === 'wait') return 'wait'
    return 'other'
  }
  const name = item.name.toLowerCase()
  if (name === 'file_change' || name.includes('apply_patch')) return 'edit'
  if (name === 'read') return 'read'
  if (name.includes('view_image') || name.includes('image')) return 'image'
  if (name === 'bash' || name === 'shell' || name.includes('exec_command'))
    return 'command'
  return 'other'
}

function activityActionLabel(
  action: ActivityAction,
  count: number,
  status: 'running' | 'done' | 'error',
  t: TFunction<'components'>
): string {
  if (status === 'running') {
    return t(
      (
        {
          command: 'stream.action.running.command',
          thinking: 'stream.action.running.thinking',
          edit: 'stream.action.running.edit',
          image: 'stream.action.running.image',
          read: 'stream.action.running.read',
          skill: 'stream.action.running.skill',
          web: 'stream.action.running.web',
          paper: 'stream.action.running.paper',
          collaboration: 'stream.action.running.collaboration',
          wait: 'stream.action.running.wait',
          other: 'stream.action.running.other'
        } as const
      )[action]
    )
  }
  if (status === 'error') {
    return t(
      (
        {
          command: 'stream.action.error.command',
          thinking: 'stream.action.error.thinking',
          edit: 'stream.action.error.edit',
          image: 'stream.action.error.image',
          read: 'stream.action.error.read',
          skill: 'stream.action.error.skill',
          web: 'stream.action.error.web',
          paper: 'stream.action.error.paper',
          collaboration: 'stream.action.error.collaboration',
          wait: 'stream.action.error.wait',
          other: 'stream.action.error.other'
        } as const
      )[action]
    )
  }
  if (action === 'image' && count > 1) return t('stream.images', { count })
  if (action === 'command' && count > 1) return t('stream.commands', { count })
  if (action === 'skill' && count > 1) return t('stream.tools', { count })
  return t(
    (
      {
        thinking: 'stream.action.done.thinking',
        command: 'stream.action.done.command',
        edit: 'stream.action.done.edit',
        image: 'stream.action.done.image',
        read: 'stream.action.done.read',
        skill: 'stream.action.done.skill',
        web: 'stream.action.done.web',
        paper: 'stream.action.done.paper',
        collaboration: 'stream.action.done.collaboration',
        wait: 'stream.action.done.wait',
        other: 'stream.action.done.other'
      } as const
    )[action]
  )
}

function activityLinePresentation(
  items: ActivityItem[],
  t: TFunction<'components'>
): {
  icon: IconName
  label: string
  running: boolean
  failed: boolean
} {
  const groups = new Map<ActivityAction, ActivityItem[]>()
  for (const item of items) {
    const action = activityAction(item)
    const group = groups.get(action)
    if (group) group.push(item)
    else groups.set(action, [item])
  }
  const labels = Array.from(groups, ([action, group]) => {
    const status = group.some(
      (item) => 'status' in item && item.status === 'running'
    )
      ? 'running'
      : group.some((item) => 'status' in item && item.status === 'error')
        ? 'error'
        : 'done'
    return activityActionLabel(action, group.length, status, t)
  })
  const firstAction = groups.keys().next().value ?? 'other'
  return {
    icon: ACTIVITY_ACTION_ICONS[firstAction],
    label: labels.join(' · '),
    running: items.some(
      (item) => 'status' in item && item.status === 'running'
    ),
    failed: items.some((item) => 'status' in item && item.status === 'error')
  }
}

function webSearchActionLabel(
  item: WebSearchItem,
  t: TFunction<'components'>
): string {
  if (item.action.type === 'openPage') return t('stream.web.openPage')
  if (item.action.type === 'findInPage') return t('stream.web.findInPage')
  return t('stream.web.search')
}

function webSearchQuery(item: WebSearchItem): string {
  if (item.query) return item.query
  if (typeof item.action.query === 'string') return item.action.query
  if (Array.isArray(item.action.queries)) return item.action.queries.join(' · ')
  if (typeof item.action.url === 'string') return item.action.url
  return ''
}

function externalResultUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return EXTERNAL_RESULT_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

// Consecutive tool calls are a rendering projection, not a transcript mutation.
// The outer group owns the noisy list; each step still keeps its own input/output
// disclosure for users who need the exact call evidence.
function ActivityRun({
  items,
  turnId,
  tail = true,
  outcome,
  timing
}: {
  items: ActivityItem[]
  turnId?: string
  tail?: boolean
  outcome?: TurnOutcome
  timing?: TurnTiming
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const [now, setNow] = useState(Date.now())
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool')
  const searches = items.filter(
    (item): item is WebSearchItem => item.kind === 'web_search'
  )
  const paperSearches = items.filter(
    (item): item is PaperSearchItem => item.kind === 'paper_search'
  )
  const skills = items.filter(
    (item): item is SkillActivityItem => item.kind === 'skill'
  )
  const nativeActivities = items.filter(
    (item): item is NativeActivityItem => item.kind === 'native_activity'
  )
  const runningTool = latestRunningTool(tools)
  const runningSearch = latestRunningSearch(searches)
  const runningPaperSearch = latestRunningPaperSearch(paperSearches)
  const runningSkill = skills.find((item) => item.status === 'running')
  const runningNative = latestRunningNativeActivity(nativeActivities)
  const itemRunning = Boolean(
    runningTool ||
    runningSearch ||
    runningPaperSearch ||
    runningSkill ||
    runningNative
  )
  const itemCompleted = items.some(
    (item) => 'status' in item && item.status === 'done'
  )
  const runState = activityRunState(outcome, itemRunning, itemCompleted, tail)
  const running = runState === 'running'
  const expanded = userExpanded ?? running
  useEffect(() => {
    if (!running) return () => undefined
    setNow(Date.now())
    const timer = window.setInterval(
      () => setNow(Date.now()),
      ACTIVITY_ELAPSED_TICK_MS
    )
    return () => window.clearInterval(timer)
  }, [running])
  // A failed tool is a normal result the agent may recover from. Only the
  // durable turn terminal event can mark the whole execution failed.
  const hasFailure = runState === 'failed'
  const interrupted = runState === 'interrupted'
  const itemStartedAt = items.reduce<number | undefined>(
    (earliest, item) =>
      item.startedAt === undefined
        ? earliest
        : Math.min(earliest ?? item.startedAt, item.startedAt),
    undefined
  )
  const itemCompletedAt = items.reduce<number | undefined>(
    (latest, item) =>
      item.completedAt === undefined
        ? latest
        : Math.max(latest ?? item.completedAt, item.completedAt),
    undefined
  )
  // The group's own item timing is the truth for its duration. Turn timing only
  // fills a live group whose items carry no wall clock yet; reusing it for
  // every historical group makes each one appear to have taken the whole turn.
  const startedAt = itemStartedAt ?? (running ? timing?.startedAt : undefined)
  const completedAt =
    itemCompletedAt ?? (running ? timing?.completedAt : undefined)
  const durationEnd = running ? now : completedAt
  const taskDuration =
    startedAt !== undefined && durationEnd !== undefined
      ? activityDurationLabel(startedAt, durationEnd, t)
      : null
  const stateLabel = running
    ? t('stream.executing')
    : hasFailure
      ? t(TOOL_STATUS_KEYS.error.messageKey)
      : interrupted
        ? t(TOOL_STATUS_KEYS.cancelled.messageKey)
        : t(TOOL_STATUS_KEYS.done.messageKey)
  const state = taskDuration
    ? running
      ? t('stream.elapsedState', { state: stateLabel, duration: taskDuration })
      : t('stream.durationState', { state: stateLabel, duration: taskDuration })
    : stateLabel
  const presentation = activityLinePresentation(items, t)
  const toolCount =
    tools.length + searches.length + paperSearches.length + skills.length
  const lineLabel = toolCount
    ? t('stream.toolsExecuted', { count: toolCount })
    : running
      ? t('stream.processing')
      : t('stream.processed')
  return (
    <Collapsible
      animated
      open={expanded}
      onOpenChange={setUserExpanded}
      className={cx(
        'group my-[var(--vds-space-2)] min-w-0 [--vds-collapsible-content-gap:0px]',
        expanded && 'is-open'
      )}
      data-testid="turn-activity"
      data-turn-id={turnId}
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          size="content"
          variant="ghost"
          className={cx(
            ACTIVITY_LINE_CLASS,
            (hasFailure || presentation.failed) && '!text-[var(--c-tension)]',
            (running || presentation.running) && '!text-[var(--c-fact)]'
          )}
          data-testid="turn-activity-trigger"
          aria-label={t('stream.activityLabel', { label: lineLabel, state })}
          title={`${presentation.label} · ${state}`}
        >
          <Badge
            size="sm"
            tone="neutral"
            className="!inline-flex !size-6 shrink-0 !justify-center !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-bg-white-default)] !p-0"
          >
            {toolCount}
          </Badge>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
            {lineLabel}
          </span>
          {/* 与 label 同款收缩约束：w-fit 触发按钮的 min-content 否则被 nowrap 状态文案撑宽，
              窄对话区会出现横向滚动条。 */}
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{state}</span>
          <span className="inline-flex flex-none opacity-0 transition-opacity duration-150 group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100">
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} sw={1.8} />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-[var(--vds-space-3)] !rounded-none !border-0 !bg-transparent !p-0">
        <div className={TOOL_RUN_STEPS_CLASS}>
          {items.map((item) => {
            if (item.kind === 'thinking') {
              return (
                <ThinkingActivityStep
                  key={item.itemId ?? item.text}
                  item={item}
                  groupOpen={expanded}
                />
              )
            }
            if (item.kind === 'web_search') {
              return (
                <WebSearchStep
                  key={item.searchId}
                  item={item}
                  groupOpen={expanded}
                />
              )
            }
            if (item.kind === 'paper_search') {
              return (
                <PaperSearchStep
                  key={item.searchId}
                  item={item}
                  groupOpen={expanded}
                />
              )
            }
            if (item.kind === 'skill') {
              return (
                <SkillActivityStep
                  key={item.skillId}
                  item={item}
                  groupOpen={expanded}
                />
              )
            }
            if (item.kind === 'native_activity') {
              return (
                <NativeActivityStep
                  key={item.activityId}
                  item={item}
                  groupOpen={expanded}
                />
              )
            }
            return (
              <ToolStep
                key={item.toolId}
                item={item}
                groupOpen={expanded}
                now={now}
              />
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ThinkingActivityStep({
  item,
  groupOpen
}: {
  item: ThinkingActivityItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      animated
      open={open}
      onOpenChange={setOpen}
      className={cx(
        TOOL_RUN_STEP_CLASS,
        'grid-cols-[minmax(0,1fr)]',
        open && 'is-open'
      )}
      data-testid="thinking-activity-step"
    >
      <CollapsibleTrigger asChild>
        <Button
          unstyled
          type="button"
          className={cx(
            TOOL_RUN_STEP_TRIGGER_CLASS,
            'min-w-0 !px-[var(--vds-space-2)] !py-[var(--vds-space-1)]'
          )}
          aria-label={t('stream.thinkingContent')}
          tabIndex={groupOpen ? 0 : -1}
        >
          <ActivityStatusIcon status="done" />
          <span className={TOOL_RUN_STEP_NAME_CLASS}>
            {t('stream.thought')}
          </span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 flex-1 truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
            {visibleMarkdownText(item.text)}
          </span>
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cx(
          TOOL_RUN_IO_CLASS,
          '!ml-[calc(var(--vds-space-4)*2)] !mr-[var(--vds-space-2)] !mb-[var(--vds-space-3)] !px-[var(--vds-space-3)] !py-[var(--vds-space-2)] !whitespace-normal !bg-[var(--vds-surface-muted)]'
        )}
        data-testid="thinking-activity-content"
      >
        {item.itemId ? (
          <AnnotatedAnswer
            citationEnabled={false}
            markdownClassName={TOOL_RUN_MARKDOWN_CLASS}
            text={item.text}
            selectionEnabled
            messageId={`item:${item.itemId}`}
          />
        ) : (
          <Markdown text={item.text} className={TOOL_RUN_MARKDOWN_CLASS} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SkillActivityStep({
  item,
  groupOpen
}: {
  item: SkillActivityItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { act } = useApp()
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.path)
  const stateTone =
    item.status === 'error'
      ? 'is-error'
      : item.status === 'done'
        ? 'is-done'
        : 'is-running'
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid="skill-activity-step"
    >
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={hasBody ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <ActivityStatusIcon status={item.status} />
        <span className={TOOL_RUN_STEP_NAME_CLASS}>
          {t('stream.skill.load', { name: item.name })}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[stateTone]
          )}
        >
          {item.status === 'running' && (
            <span className={TOOL_RUN_PULSE_CLASS} />
          )}
          {t(TOOL_STATUS_KEYS[item.status].messageKey)}
        </span>
        {hasBody && (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        )}
      </Button>
      {hasBody && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div className={TOOL_RUN_IO_STACK_CLASS}>
              <IoBlock
                label={t('stream.skill.document')}
                text={item.path}
                err={item.status === 'error'}
              />
              {item.status === 'done' && (
                <Button
                  unstyled
                  type="button"
                  className={CHIP_BUTTON_CLASS}
                  data-testid="skill-activity-open"
                  onClick={() => act.openCap('skill')}
                >
                  {t('stream.skill.open')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NativeActivityStep({
  item,
  groupOpen
}: {
  item: NativeActivityItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const details = Object.keys(item.details).length
    ? toolValue(item.details)
    : ''
  const stateTone =
    item.status === 'error'
      ? 'is-error'
      : item.status === 'done'
        ? 'is-done'
        : 'is-running'
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid={`native-activity-${item.activityType}`}
    >
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={details ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => details && setOpen((value) => !value)}
      >
        <ActivityStatusIcon status={item.status} />
        <span className={TOOL_RUN_STEP_NAME_CLASS}>
          {nativeActivityLabel(item, t)}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[stateTone]
          )}
        >
          {item.status === 'running' && (
            <span className={TOOL_RUN_PULSE_CLASS} />
          )}
          {t(TOOL_STATUS_KEYS[item.status].messageKey)}
        </span>
        {details && (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        )}
      </Button>
      {details && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div className={TOOL_RUN_IO_STACK_CLASS}>
              <IoBlock
                label={t('stream.details')}
                text={details}
                err={item.status === 'error'}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function WebSearchStep({
  item,
  groupOpen
}: {
  item: WebSearchItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const query = webSearchQuery(item)
  const url = typeof item.action.url === 'string' ? item.action.url : ''
  const pattern =
    typeof item.action.pattern === 'string' ? item.action.pattern : ''
  const results = item.results
    .map((result) => ({
      ...result,
      externalUrl: externalResultUrl(result.url)
    }))
    .filter((result) => Boolean(result.title || result.url))
  const hasBody = Boolean(query || url || pattern || results.length)
  const status =
    item.status === 'running'
      ? t('stream.search.searching')
      : results.length
        ? t('stream.search.results', { count: results.length })
        : t(TOOL_STATUS_KEYS.done.messageKey)
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid="web-search-step"
    >
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={hasBody ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <span
          className={cx(
            TOOL_RUN_STEP_NAME_CLASS,
            'inline-flex items-center gap-[6px] text-[var(--c-fact)] [&_svg]:flex-none'
          )}
        >
          <ActivityStatusIcon status={item.status} />
          {webSearchActionLabel(item, t)}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[
              item.status === 'running' ? 'is-running' : 'is-done'
            ]
          )}
        >
          {item.status === 'running' && (
            <span className={TOOL_RUN_PULSE_CLASS} />
          )}
          {status}
        </span>
        {hasBody && (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        )}
      </Button>
      {hasBody && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div
              className={cx(
                TOOL_RUN_IO_STACK_CLASS,
                'bg-[color-mix(in_oklch,var(--c-fact)_5%,var(--bg-2))]'
              )}
            >
              {query && (
                <IoBlock label={t('stream.search.query')} text={query} />
              )}
              {url && url !== query && (
                <IoBlock label={t('stream.search.page')} text={url} />
              )}
              {pattern && (
                <IoBlock label={t('stream.search.pattern')} text={pattern} />
              )}
              {results.length > 0 && (
                <div
                  className="grid gap-[var(--vds-space-2)]"
                  data-testid="web-search-results"
                >
                  {results.map((result, index) => (
                    <div
                      className="grid min-w-0 gap-[2px] rounded-md border border-[var(--border-soft)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
                      key={`${result.url || result.title || 'result'}-${index}`}
                    >
                      <span className="break-words text-[var(--text)]">
                        {result.title || result.url}
                      </span>
                      {result.url && (
                        <span className="break-all text-[var(--text-3)]">
                          {result.url}
                        </span>
                      )}
                      {result.externalUrl && (
                        <Button
                          unstyled
                          type="button"
                          className="justify-self-start text-[var(--accent-ink)] hover:underline"
                          onClick={() =>
                            void window.scholarseed.openExternal(
                              result.externalUrl as string
                            )
                          }
                        >
                          {t('stream.search.openOriginal')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SearchActivityCard({
  item
}: {
  item: SearchActivityItem
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const paper = item.kind === 'paper_search'
  const target = paper
    ? t('stream.search.paperTarget')
    : t('stream.search.webTarget')
  const query = paper ? item.query : webSearchQuery(item)
  const running = item.status === 'running'
  return (
    <section
      className={cx('group', TOOL_RUN_CLASS, running && 'is-running')}
      data-testid={paper ? 'paper-search-card' : 'web-search-card'}
      data-turn-id={item.turnId}
    >
      <div className={TOOL_RUN_TRIGGER_CLASS} role="status" aria-live="polite">
        <span className={TOOL_RUN_ICON_CLASS}>
          <Icon name="search" size={14} sw={1.8} />
        </span>
        <span className={TOOL_RUN_COPY_CLASS}>
          <span className={TOOL_RUN_TITLE_CLASS}>
            {running
              ? t('stream.search.runningTitle')
              : t('stream.search.doneTitle')}
          </span>
          <span className={TOOL_RUN_SUMMARY_CLASS}>
            {query ? `${target} · ${query}` : target}
          </span>
        </span>
        <span
          className={cx(
            TOOL_RUN_STATE_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[running ? 'is-running' : 'is-done']
          )}
        >
          {running && <span className={TOOL_RUN_PULSE_CLASS} />}
          {running
            ? t('stream.search.searching')
            : t(TOOL_STATUS_KEYS.done.messageKey)}
        </span>
      </div>
    </section>
  )
}

function PaperSearchStep({
  item,
  groupOpen
}: {
  item: PaperSearchItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.query)
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid="paper-search-step"
    >
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={hasBody ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <span
          className={cx(
            TOOL_RUN_STEP_NAME_CLASS,
            'inline-flex items-center gap-[6px] text-[var(--c-fact)] [&_svg]:flex-none'
          )}
        >
          <ActivityStatusIcon status={item.status} />
          {t('stream.search.paper')}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[
              item.status === 'running' ? 'is-running' : 'is-done'
            ]
          )}
        >
          {item.status === 'running' && (
            <span className={TOOL_RUN_PULSE_CLASS} />
          )}
          {item.status === 'running'
            ? t('stream.search.searching')
            : t(TOOL_STATUS_KEYS.done.messageKey)}
        </span>
        {hasBody && (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        )}
      </Button>
      {hasBody && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div className={TOOL_RUN_IO_STACK_CLASS}>
              <IoBlock
                label={t('stream.search.paperQuery')}
                text={item.query}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolStep({
  item,
  groupOpen,
  now
}: {
  item: ToolItem
  groupOpen: boolean
  now: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { act } = useApp()
  const [open, setOpen] = useState(false)
  const skillName = loadedSkillName(item)
  const hasBody =
    item.input != null || (item.result != null && item.result !== '')
  const stateTone =
    item.status === 'error'
      ? 'is-error'
      : item.status === 'done'
        ? 'is-done'
        : item.status === 'cancelled'
          ? 'is-cancelled'
          : 'is-running'
  const resultPreview = toolPreview(item)
  const duration = compactDurationLabel(
    item.startedAt,
    item.status === 'running' ? now : item.completedAt,
    item.status !== 'running'
  )
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid="tool-run-step"
    >
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={hasBody ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <ActivityStatusIcon status={item.status} />
        <span className={TOOL_RUN_STEP_NAME_CLASS} title={item.name}>
          {toolLabel(item, conversation)}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[stateTone]
          )}
        >
          <span className="shrink-0">
            {item.status === 'done'
              ? t('stream.ran')
              : t(TOOL_STATUS_KEYS[item.status].messageKey)}
          </span>
          {toolInputSummary(item) &&
            (activityAction(item) === 'read' ||
            activityAction(item) === 'edit' ? (
              <Badge
                size="sm"
                tone="neutral"
                className="min-w-0 truncate"
                title={toolInputSummary(item)}
              >
                {toolInputSummary(item)}
              </Badge>
            ) : (
              <span
                className="min-w-0 truncate text-[var(--vds-text-tertiary)]"
                title={toolInputSummary(item)}
              >
                · {toolInputSummary(item)}
              </span>
            ))}
          {item.status === 'done' && resultPreview && (
            <span
              className="min-w-0 truncate text-[var(--vds-text-tertiary)]"
              title={resultPreview}
            >
              · {resultPreview}
            </span>
          )}
          {duration && (
            <span
              className="flex-none border-l border-[var(--border-soft)] pl-[6px]"
              data-testid="tool-run-step-duration"
            >
              {duration}
            </span>
          )}
        </span>
        {hasBody && (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        )}
      </Button>
      {hasBody && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div className={TOOL_RUN_IO_STACK_CLASS}>
              <div className={TOOL_RUN_IO_LABEL_CLASS}>{item.name}</div>
              {item.input != null && (
                <IoBlock
                  label={t('stream.input')}
                  text={toolValue(item.input)}
                />
              )}
              {item.result != null && item.result !== '' && (
                <IoBlock
                  label={t('stream.output')}
                  text={item.result}
                  err={item.status === 'error'}
                />
              )}
              {skillName && item.status === 'done' && (
                <Button
                  unstyled
                  type="button"
                  className={CHIP_BUTTON_CLASS}
                  data-testid="load-skill-open-files"
                  onClick={() => act.openCap('skill')}
                >
                  {t('stream.skill.open')}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function IoBlock({
  label,
  text,
  err
}: {
  label: string
  text: string
  err?: boolean
}): React.JSX.Element {
  return (
    <div>
      <div className={TOOL_RUN_IO_LABEL_CLASS}>{label}</div>
      <pre
        className={cx(
          TOOL_RUN_IO_CLASS,
          err &&
            'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--c-tension)_72%,var(--border))]'
        )}
      >
        {text}
      </pre>
    </div>
  )
}

// ── HIL 卡片 (permission 授权 · question/AskUserQuestion 逐题作答) —— 对齐 Claude 授权卡:
//    标题即问句 · 真实工具/环境 chip · 可折叠命令块 · 作用域感知的分体「允许 ▾」+「拒绝」。──

type HilItem = Extract<ConvItem, { kind: 'hil' }>
type Opt = NonNullable<HilItem['options']>[number]

// 工具 → 友好问句 (闭集, 未命中回退到「允许运行 {tool}?」)。
const PERM_TITLES = {
  Shell: 'stream.hil.title.shell',
  Command: 'stream.hil.title.command',
  shell_command: 'stream.hil.title.shell',
  Read: 'stream.hil.title.read',
  Write: 'stream.hil.title.write',
  Edit: 'stream.hil.title.edit',
  MultiEdit: 'stream.hil.title.edit',
  NotebookEdit: 'stream.hil.title.notebook',
  WebFetch: 'stream.hil.title.webFetch',
  WebSearch: 'stream.hil.title.webSearch',
  Glob: 'stream.hil.title.glob',
  Grep: 'stream.hil.title.grep'
} as const
// safety tag → 中文 chip 文案 / 语气色 (PolicyRequest.safety_tags)。
const TAG_LABEL = {
  read_only: 'stream.hil.tag.readOnly',
  writes: 'stream.hil.tag.writes',
  destructive: 'stream.hil.tag.destructive',
  network: 'stream.hil.tag.network'
} as const
const TAG_TONE: Record<string, string> = {
  destructive: 'var(--c-tension)',
  network: 'var(--c-opinion)',
  writes: 'var(--accent-ink)',
  read_only: 'var(--c-experience)'
}

// 无 toolName 的审批卡统一用本地化标题, 不回显 vendor 文案 (elicitation 等输入请求仍走 fallback)。
const APPROVAL_HIL_KINDS = new Set(['command_approval', 'file_approval', 'permission'])

function permTitle(
  tool: string | undefined,
  hilKind: string | undefined,
  fallback: string | undefined,
  t: TFunction<'components'>
): string {
  if (tool === 'Shell') return t(PERM_TITLES.Shell)
  if (tool === 'Command') return t(PERM_TITLES.Command)
  if (tool === 'shell_command') return t(PERM_TITLES.shell_command)
  if (tool === 'Read') return t(PERM_TITLES.Read)
  if (tool === 'Write') return t(PERM_TITLES.Write)
  if (tool === 'Edit') return t(PERM_TITLES.Edit)
  if (tool === 'MultiEdit') return t(PERM_TITLES.MultiEdit)
  if (tool === 'NotebookEdit') return t(PERM_TITLES.NotebookEdit)
  if (tool === 'WebFetch') return t(PERM_TITLES.WebFetch)
  if (tool === 'WebSearch') return t(PERM_TITLES.WebSearch)
  if (tool === 'Glob') return t(PERM_TITLES.Glob)
  if (tool === 'Grep') return t(PERM_TITLES.Grep)
  if (tool) return t('stream.hil.title.tool', { tool })
  if (hilKind && APPROVAL_HIL_KINDS.has(hilKind)) return t('stream.hil.title.approval')
  const cleanedFallback = (fallback || '')
    .replace(/^\s*(Permission requested|Approval required)\s*:\s*/i, '')
    .trim()
  return cleanedFallback
    ? t('stream.hil.title.tool', { tool: cleanedFallback })
    : t('stream.hil.needApproval')
}

function safetyTagLabel(tag: string, t: TFunction<'components'>): string {
  if (tag === 'read_only') return t(TAG_LABEL.read_only)
  if (tag === 'writes') return t(TAG_LABEL.writes)
  if (tag === 'destructive') return t(TAG_LABEL.destructive)
  if (tag === 'network') return t(TAG_LABEL.network)
  return tag
}

function isDenyOpt(o: Opt): boolean {
  return (
    ['n', 'deny', 'decline', 'cancel'].includes(o.id) ||
    /^\s*(no|deny|decline|reject|cancel|stop)\b/i.test(o.label)
  )
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}

function fmtVal(v: unknown, t?: TFunction<'components'>): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v))
    return v.length && v.every((x) => typeof x !== 'object')
      ? v.join(', ')
      : t
        ? t('stream.items', { count: v.length })
        : String(v.length)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// y/p/t/e/n 作用域 (permission.py 契约) → 简短按钮文案 + 一行作用范围说明。
function scopeInfo(
  o: Opt,
  item: HilItem,
  t: TFunction<'components'>
): { short: string; caption: string } {
  const short = formatHilPermissionScope(
    hilPermissionScope(o, item.prefixKind),
    t
  )
  const px = item.suggestedPrefix || ''
  const tool = item.toolName || t('stream.hil.thisTool')
  switch (o.id) {
    case 'y':
    case 'accept':
      return { short, caption: t('stream.hil.onceCaption') }
    case 'p':
      if (item.prefixKind === 'shell_prefix')
        return {
          short,
          caption: px
            ? t('stream.hil.allowCommandPrefixCaption', { prefix: px })
            : t('stream.hil.allowCommandClassCaption')
        }
      if (item.prefixKind === 'file_dir')
        return {
          short,
          caption: px
            ? t('stream.hil.allowDirectoryCaption', { prefix: px })
            : t('stream.hil.allowThisDirectoryCaption')
        }
      if (item.prefixKind === 'web_host')
        return {
          short,
          caption: px
            ? t('stream.hil.allowSiteCaption', { host: px })
            : t('stream.hil.allowThisSiteCaption')
        }
      return { short, caption: o.label }
    case 't':
    case 'acceptForSession':
      return { short, caption: t('stream.hil.allowSessionCaption', { tool }) }
    case 'e':
      return { short, caption: t('stream.hil.acceptEditsCaption') }
    default:
      return { short, caption: o.description || o.label }
  }
}

function Chip({
  label,
  tone
}: {
  label: string
  tone?: string
}): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10.5,
        color: tone ?? 'var(--text-2)',
        border: `1px solid ${tone ?? 'var(--border)'}`,
        borderRadius: 6,
        padding: '1.5px 7px',
        opacity: tone ? 0.92 : 1,
        whiteSpace: 'nowrap'
      }}
    >
      {label}
    </span>
  )
}

function permissionSummary(item: HilItem, t: TFunction<'components'>): string {
  const reason = item.reason?.trim()
  if (reason) return reason
  const command = item.command?.trim()
  if (command) return t('stream.hil.summary.command', { command })
  if (item.path) return t('stream.hil.summary.file', { path: item.path })
  if (item.networkTarget)
    return t('stream.hil.summary.network', {
      target: fmtVal(item.networkTarget, t)
    })
  const body = item.body?.trim()
  return body || t('stream.hil.summary.default')
}

function HilCard({
  item,
  presentation = 'history',
  queueCount = 1
}: {
  item: HilItem
  presentation?: 'history' | 'dock'
  queueCount?: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: hilT } = useTranslation('conversation')
  const { state, patchThread } = useApp()
  const sid = activeThread(state).sessionId
  const tid = state.activeSession
  const [picks, setPicks] = useState<Record<number, string[]>>({})
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [codeOpen, setCodeOpen] = useState(false)
  const [lastAction, setLastAction] = useState<HilAction | null>(null)
  const [now, setNow] = useState(Date.now())
  const submissionInFlight = useRef(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const unknown = item.hilState === 'unknown'
  const done =
    item.resolved != null ||
    item.hilState === 'resolved' ||
    item.hilState === 'cancelled' ||
    item.hilState === 'stale' ||
    unknown
  const submitting = item.hilState === 'submitting'
  const isQuestion = isQuestionHil(item)
  const questions = item.questions ?? []
  const interactionPolicies = useInteractionPolicies()
  const questionPolicy = isQuestion
    ? interactionPolicies.find((policy) => policy.matches(questions))
    : undefined
  const questionComplete =
    questions.length > 0 &&
    (questionPolicy?.complete?.(questions, picks, texts) ??
      questions.every((question, index) =>
        question.options.length > 0
          ? (picks[index]?.length ?? 0) > 0 || Boolean(texts[index]?.trim())
          : Boolean(texts[index]?.trim())
      ))
  const cancelledLabel =
    item.hilState === 'cancelled' && questionPolicy?.cancelledLabel && questions[0]
      ? questionPolicy.cancelledLabel(questions[0])
      : undefined
  const resolutionItem =
    cancelledLabel
      ? {
          ...item,
          resolved: cancelledLabel,
          resolvedMessage: undefined
        }
      : item

  useEffect(() => {
    if (done) return () => undefined
    const timer = window.setInterval(() => setNow(Date.now()), HIL_WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [done])

  const patchHil = (patch: Partial<HilItem>): void =>
    patchThread(tid, (t) => ({
      conversation: t.conversation.map((it) =>
        it.kind === 'hil' && it.requestId === item.requestId
          ? { ...it, ...patch }
          : it
      )
    }))

  const markResolved = (
    label: string,
    answers?: Record<string, string>,
    resolvedMessage?: HilResolvedMessage
  ): void =>
    patchThread(tid, (t) => {
      const alreadyTerminal = t.conversation.some(
        (it) =>
          it.kind === 'hil' &&
          it.requestId === item.requestId &&
          (it.hilState === 'stale' ||
            it.hilState === 'cancelled' ||
            it.hilState === 'unknown')
      )
      if (alreadyTerminal) return {}
      return {
        running: true,
        status: 'running',
        conversation: t.conversation.map((it) =>
          it.kind === 'hil' && it.requestId === item.requestId
            ? {
                ...it,
                // Preserve the existing canonical label: denial styling still inspects it.
                resolved: label,
                resolvedMessage,
                hilState: 'resolved',
                submissionError: undefined,
                submissionErrorMessage: undefined,
                submissionRequestFailure: undefined,
                ...(answers ? { answers } : {})
              }
            : it
        )
      }
    })

  const markSubmissionFailed = (
    failure: Pick<
      HilItem,
      'submissionError' | 'submissionErrorMessage' | 'submissionRequestFailure'
    >
  ): void => {
    submissionInFlight.current = false
    patchThread(tid, (t) => {
      const settled = t.conversation.some(
        (it) =>
          it.kind === 'hil' &&
          it.requestId === item.requestId &&
          (it.resolved != null ||
            it.hilState === 'resolved' ||
            it.hilState === 'cancelled' ||
            it.hilState === 'stale' ||
            it.hilState === 'unknown')
      )
      if (settled) return {}
      return {
        running: true,
        status: 'waiting',
        conversation: t.conversation.map((it) =>
          it.kind === 'hil' && it.requestId === item.requestId
            ? { ...it, hilState: 'failed', ...failure }
            : it
        )
      }
    })
  }

  const submitAction = async (action: HilAction): Promise<void> => {
    if (!sid || submitting || done || submissionInFlight.current) return
    submissionInFlight.current = true
    setLastAction(action)
    patchHil({
      hilState: 'submitting',
      submissionError: undefined,
      submissionErrorMessage: undefined,
      submissionRequestFailure: undefined
    })
    if (action.kind === 'cancel') {
      const response = await interruptSession(sid)
      if (response.ok) {
        patchThread(tid, (thread) => ({
          running: false,
          status: 'done',
          conversation: thread.conversation.map((it) =>
            it.kind === 'hil' && it.requestId === item.requestId
              ? {
                  ...it,
                  ...hilEventResolution(action.label, 'cancelled'),
                  hilState: 'cancelled',
                  submissionError: undefined,
                  submissionErrorMessage: undefined,
                  submissionRequestFailure: undefined
                }
              : it
          )
        }))
      } else {
        markSubmissionFailed({
          ...hilSubmissionFailure('cancelUnconfirmed', response.error),
          submissionRequestFailure: response.applicationFailure
        })
      }
      return
    }
    const response = await respondHil(sid, item.requestId, action.body)
    if (!response.ok) {
      if (response.outcome === 'unknown') {
        submissionInFlight.current = false
        patchHil({
          hilState: 'unknown',
          ...hilSubmissionFailure('outcomeUnknown'),
          submissionRequestFailure: undefined
        })
        return
      }
      if (response.outcome === 'stale') {
        submissionInFlight.current = false
        patchHil({
          hilState: 'stale',
          resolvedMessage: { kind: 'stale' },
          resolved: t('stream.hil.stale'),
          submissionError: undefined,
          submissionErrorMessage: undefined,
          submissionRequestFailure: undefined
        })
        return
      }
      markSubmissionFailed({
        ...hilSubmissionFailure('answerUnconfirmed', response.error),
        submissionRequestFailure: response.applicationFailure
      })
      return
    }
    submissionInFlight.current = false
    markResolved(action.label, action.answers, action.resolvedMessage)
  }

  const answerPermission = (
    optId: string,
    label: string,
    resolvedMessage: HilResolvedMessage
  ): void => {
    void submitAction({
      kind: 'respond',
      body: { option_id: optId },
      label,
      resolvedMessage
    })
  }
  const submitQuestion = (): void => {
    const qs = questions
    if (!questionComplete) return
    const answers: Record<string, string> = {}
    qs.forEach((q, i) => {
      const key = q.id || q.header || q.question
      if (q.options.length) {
        const labels = picks[i] || []
        const custom = (texts[i] || '').trim()
        const answer = [labels.join(', '), custom].filter(Boolean).join('\n')
        if (answer) answers[key] = answer
      } else if ((texts[i] || '').trim()) {
        answers[key] = texts[i].trim()
      }
    })
    void submitAction({
      kind: 'respond',
      body: { answers },
      label: Object.values(answers).join(' · ') || t('stream.hil.answered'),
      resolvedMessage: Object.values(answers).join(' · ')
        ? undefined
        : { kind: 'answered' },
      answers
    })
  }
  const toggle = (qi: number, label: string, multi: boolean): void =>
    setPicks((p) => {
      const cur = p[qi] || []
      if (!multi) return { ...p, [qi]: [label] }
      return {
        ...p,
        [qi]: cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label]
      }
    })
  const decideQuestion = (
    question: (typeof questions)[number],
    option: (typeof question.options)[number]
  ): void => {
    const decision = questionPolicy?.directDecision?.(question, option)
    const label = questionPolicy?.optionLabel?.(option) ?? option.label
    if (decision === 'cancel') {
      void submitAction({ kind: 'cancel', label: questionPolicy?.cancelledLabel?.(question) })
      return
    }
    if (decision === 'respond') {
      const key = question.id || question.header || question.question
      const answers = { [key]: label }
      void submitAction({
        kind: 'respond',
        body: { answers },
        label,
        answers
      })
    }
  }
  const qs = item.questions ?? []

  // permission: 作用域选项平铺成一列, 点击即刻生效 (无下拉); 推荐档排最前 ——
  // 「允许此工具」(t) 优先, 其次前缀级 (p), 最后仅一次 (y), 减少反复弹卡。
  const rawOpts: Opt[] =
    item.options && item.options.length
      ? item.options
      : [
          { id: 'y', label: t('stream.hil.allow') },
          { id: 'n', label: t('stream.hil.deny') }
        ]
  const dockOptions = permissionDecisionOptions(item)
  const allowOpts = rawOpts.filter((o) => !isDenyOpt(o))
  const denyOpt = rawOpts.find((o) => isDenyOpt(o)) ?? {
    id: 'n',
    label: t('stream.hil.denyAndStop')
  }
  const preferred =
    allowOpts.find((o) => o.id === 'acceptForSession') ??
    allowOpts.find((o) => o.id === 't') ??
    allowOpts.find((o) => o.id === 'p') ??
    allowOpts[0]
  const orderedAllows = preferred
    ? [preferred, ...allowOpts.filter((o) => o !== preferred)]
    : allowOpts
  const stale = item.hilState === 'stale'
  const denied =
    stale || /拒|deny|decline|reject|cancel|^n$|^no$/i.test(item.resolved || '')

  // 命令块: 优先真实命令 → 其它工具展开参数字段 → external_cli 回退到 body。
  const codeText = item.command?.trim()
    ? item.command
    : item.toolInput && Object.keys(item.toolInput).length
      ? Object.entries(item.toolInput)
          .map(([k, v]) => `${k}: ${fmtVal(v, t)}`)
          .join('\n')
      : (item.body || '').trim()
  const codeLabel = item.command
    ? t('stream.hil.command')
    : item.toolInput
      ? t('stream.hil.parameters')
      : t('stream.details')
  const descText = item.reason || ''

  const requestedAt = item.requestedAt ?? now
  const pill = unknown ? (
    <span
      data-testid="hil-outcome-unknown"
      style={{
        display: 'block',
        marginTop: 5,
        fontSize: 11.5,
        lineHeight: 1.5,
        color: 'var(--c-tension)',
        overflowWrap: 'anywhere'
      }}
    >
      {(item.submissionRequestFailure
        ? formatApplicationRequestFailure(item.submissionRequestFailure, hilT)
        : formatHilSubmissionError(item, t)) || t(HIL_OUTCOME_UNKNOWN_MESSAGE)}
    </span>
  ) : done ? (
    <span
      data-testid={stale ? 'hil-stale' : 'hil-resolved'}
      style={{
        display: 'inline-flex',
        alignItems: 'flex-start',
        gap: 5,
        minWidth: 0,
        maxWidth: '100%',
        fontSize: 11,
        lineHeight: 1.5,
        color: denied ? 'var(--text-3)' : 'var(--c-experience)',
        overflowWrap: 'anywhere',
        marginTop: 3
      }}
    >
      <span>{stale ? '⌛' : denied ? '⊘' : '✓'}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {formatHilResolution(resolutionItem, t, hilT)}
      </span>
    </span>
  ) : item.hilState === 'failed' ? (
    <span
      data-testid="hil-submit-error"
      style={{
        display: 'block',
        marginTop: 5,
        fontSize: 11.5,
        lineHeight: 1.5,
        color: 'var(--c-tension)',
        overflowWrap: 'anywhere'
      }}
    >
      {t('stream.hil.submitFailed', {
        message:
          (item.submissionRequestFailure
            ? formatApplicationRequestFailure(
                item.submissionRequestFailure,
                hilT
              )
            : formatHilSubmissionError(item, t)) || t('stream.hil.notConfirmed')
      })}
    </span>
  ) : (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 11.5,
        color: 'var(--text-3)',
        whiteSpace: 'nowrap',
        marginTop: 4
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--c-experience)',
          animation: 'softPulse 1.4s ease-in-out infinite'
        }}
      />
      {submitting
        ? t('stream.hil.submittingWait')
        : t('stream.hil.waitingElapsed', {
            label: isQuestion
              ? t('stream.hil.waitingAnswer')
              : t('stream.hil.waitingPermission'),
            duration: elapsedLabel(requestedAt, now, t)
          })}
    </span>
  )

  const title = isQuestion
    ? item.title || t('stream.hil.needAnswer')
    : permTitle(item.toolName, item.hilKind, item.title, t)
  const answerOnce = (): void =>
    answerPermission(dockOptions.allowOnce.id, t('stream.hil.allowedOnce'), {
      kind: 'allowedOnce'
    })
  const deny = (): void =>
    answerPermission(dockOptions.deny.id, t('stream.hil.denied'), {
      kind: 'denied'
    })

  useEffect(() => {
    if (presentation !== 'dock' || done || isQuestion) return
    dockRef.current?.focus()
  }, [done, isQuestion, item.requestId, presentation])

  useEffect(() => {
    if (presentation !== 'dock' || done || isQuestion || submitting) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.repeat ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('button, a, select, option, [role="button"]')) return
      if (event.key === 'Escape') {
        event.preventDefault()
        deny()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        answerOnce()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    answerPermission,
    dockOptions.allowOnce.id,
    dockOptions.deny.id,
    done,
    isQuestion,
    item.requestId,
    presentation,
    submitting
  ])

  if (presentation === 'dock' && !isQuestion && !done) {
    const summary = permissionSummary(item, t)
    return (
      <div
        ref={dockRef}
        tabIndex={-1}
        role="alertdialog"
        aria-label={t('stream.hil.requestPermission')}
        data-testid="hil-card"
        data-hil-kind="permission"
        data-hil-resolved="false"
        data-hil-state={item.hilState ?? 'pending'}
        className="grid min-h-[64px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[var(--vds-space-3)] rounded-[var(--vds-radius-6)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-4)] py-[var(--vds-space-3)] outline-none [animation:cardIn_0.24s_ease_both] focus-visible:shadow-[var(--vds-focus-brand)] @max-[340px]:grid-cols-[auto_minmax(0,1fr)]"
        onKeyDown={(event) => {
          if (event.repeat || submitting) return
          if (event.key === 'Escape') {
            event.preventDefault()
            deny()
            return
          }
          if (event.key === 'Enter' && event.target === event.currentTarget) {
            event.preventDefault()
            answerOnce()
          }
        }}
      >
        <span
          className="grid size-[var(--vds-icon-8)] place-items-center text-[var(--vds-text-secondary)]"
          aria-hidden
        >
          <IconFont
            type="icon-wanquanfangwen"
            className="text-[20px] leading-none"
          />
        </span>
        <span className="flex min-w-0 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-[7px] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-bold text-[var(--text)]">
            <span className="truncate">{t('stream.hil.requestPermission')}</span>
            {queueCount > 1 && (
              <span className="flex-none text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-medium text-[var(--text-3)]">
                1 / {queueCount}
              </span>
            )}
          </span>
          <EllipsisText
            className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--text-2)]"
            tooltip={summary}
            tooltipPortalled
          >
            {summary}
          </EllipsisText>
          {item.hilState === 'failed' && (
            <span
              className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--c-tension)]"
              data-testid="hil-submit-error"
            >
              {t('stream.hil.submitFailed', {
                message:
                  (item.submissionRequestFailure
                    ? formatApplicationRequestFailure(
                        item.submissionRequestFailure,
                        hilT
                      )
                    : formatHilSubmissionError(item, t)) ||
                  t('stream.hil.notConfirmedRetry')
              })}
            </span>
          )}
        </span>
        <span className="inline-flex flex-none items-center gap-[var(--vds-space-2)] @max-[340px]:col-span-2 @max-[340px]:justify-self-end">
          <Button
            variant="outline"
            size="sm"
            type="button"
            data-testid={`hil-permission-${dockOptions.deny.id}`}
            data-hil-decision="deny"
            className="whitespace-nowrap"
            disabled={submitting}
            onClick={deny}
          >
            {t('stream.hil.deny')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            data-testid={`hil-permission-${dockOptions.allowOnce.id}`}
            data-hil-decision="allow-once"
            className="whitespace-nowrap"
            disabled={submitting}
            onClick={answerOnce}
          >
            {submitting
              ? t('stream.hil.submitting')
              : t('stream.hil.allowOnce')}
          </Button>
        </span>
      </div>
    )
  }

  const scrollableQuestion = presentation === 'dock' && isQuestion && !done

  return (
    <div
      data-testid="hil-card"
      data-hil-kind={isQuestion ? 'question' : 'permission'}
      data-hil-resolved={done ? 'true' : 'false'}
      data-hil-state={item.hilState ?? 'pending'}
      className={cx(
        presentation === 'dock'
          ? 'mb-0 min-w-0 p-[var(--vds-space-4)]'
          : 'mb-[var(--vds-space-4)] min-w-0 p-[var(--vds-space-4)]',
        'border border-solid border-[var(--vds-border-default)]',
        /* 权限卡与执行计划卡片一致: 12px 圆角 + raised 背景; 问句卡保持原样。 */
        isQuestion
          ? 'rounded-[var(--vds-radius-4)] bg-[var(--vds-bg-white-default)]'
          : 'rounded-[var(--vds-radius-6)] bg-[var(--vds-surface-raised)]',
        scrollableQuestion && 'flex min-h-0 flex-1 flex-col overflow-hidden'
      )}
    >
      <div>
        {(!isQuestion || questionPolicy) && (
          <div
            style={{
              minWidth: 0,
              fontFamily: 'var(--font-serif)',
              fontSize: 17.5,
              fontWeight: 600,
              color: 'var(--text)',
              lineHeight: 1.35,
              overflowWrap: 'anywhere'
            }}
          >
            {isQuestion ? questionPolicy?.title : title}
          </div>
        )}
        {pill}
      </div>

      {isQuestion ? (
        <div
          className={cx(
            'mt-[var(--vds-space-3)]',
            scrollableQuestion && 'flex min-h-0 flex-1 flex-col'
          )}
        >
          <ScrollArea
            className={cx(scrollableQuestion && 'min-h-0 flex-1')}
            viewportClassName={cx(
              scrollableQuestion &&
                'h-full min-h-0 pr-[var(--vds-space-2)]'
            )}
            viewportProps={{
              'data-testid': 'hil-question-scroll-area'
            }}
          >
          {questionPolicy?.directDecision &&
          questionPolicy.directPresentation === 'primary-secondary' ? (
            <div className="grid gap-[var(--vds-space-4)]">
              {qs.map((q, qi) => (
                <div className="grid gap-[var(--vds-space-3)]" key={qi}>
                  <div className="min-w-0 whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
                    {q.question}
                  </div>
                  {!done && (
                    <div
                      aria-label={q.header || q.question}
                      className="flex min-w-0 items-center gap-[var(--vds-space-3)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]"
                      role="group"
                    >
                      {q.options.map((option, optionIndex) => {
                        const decision = questionPolicy.directDecision?.(
                          q,
                          option
                        )
                        const primary = decision === 'respond'
                        return (
                          <Button
                            className={
                              primary
                                ? 'min-w-0 flex-1'
                                : 'flex-none text-[var(--vds-text-secondary)]'
                            }
                            data-hil-decision={decision}
                            data-testid={`hil-question-option-${qi}-${optionIndex}`}
                            disabled={submitting}
                            key={optionIndex}
                            onClick={() => decideQuestion(q, option)}
                            size={primary ? 'md' : 'sm'}
                            type="button"
                            variant={primary ? 'primary' : 'ghost'}
                          >
                            {questionPolicy.optionLabel?.(option) ??
                              option.label}
                          </Button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            qs.map((q, qi) => (
              <div
                key={qi}
                style={{ marginBottom: qi < qs.length - 1 ? 16 : 0 }}
              >
                {q.header && (
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-3)',
                      marginBottom: 5,
                      letterSpacing: '.02em'
                    }}
                  >
                    {q.header}
                    {q.multiSelect ? t('stream.hil.multiSelectSuffix') : ''}
                  </div>
                )}
                <div
                  style={{
                    minWidth: 0,
                    fontFamily: 'var(--font-serif)',
                    fontSize: 14.5,
                    color: 'var(--text)',
                    marginBottom: 8,
                    lineHeight: 1.5,
                    overflowWrap: 'anywhere'
                  }}
                >
                  {q.question}
                </div>
                {q.options.length > 0 ? (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                  >
                    {q.options.map((o, i) => {
                      // 已答态按会话项里的 answers 回显勾选 (多选按 ', ' 拆回 label 列表);
                      // 未答态才用组件本地 picks —— 否则 resolved 后勾选被清空, 卡片像没答过。
                      const answered = done
                        ? String(
                            (item.answers ?? {})[
                              q.id || q.header || q.question
                            ] ?? ''
                          )
                        : ''
                      const on = done
                        ? answered
                            .split('\n')[0]
                            .split(', ')
                            .includes(
                              questionPolicy?.optionLabel?.(o) ?? o.label
                            )
                        : (picks[qi] || []).includes(o.label)
                      return (
                        <Button
                          unstyled
                          type="button"
                          key={i}
                          data-testid={`hil-question-option-${qi}-${i}`}
                          disabled={done || submitting}
                          onClick={() => {
                            if (questionPolicy?.directDecision) {
                              decideQuestion(q, o)
                              return
                            }
                            if (!q.multiSelect)
                              setTexts((t) => ({ ...t, [qi]: '' }))
                            toggle(qi, o.label, !!q.multiSelect)
                          }}
                          aria-pressed={on}
                          className={cx(
                            'flex items-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-solid px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-left disabled:cursor-default',
                            on
                              ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                              : 'border-[var(--border)] bg-transparent'
                          )}
                        >
                          <span
                            className={cx(
                              'mt-px grid size-[14px] flex-none place-items-center rounded border text-[10px] text-[var(--on-accent)]',
                              on
                                ? 'border-[var(--accent)] bg-[var(--accent)]'
                                : 'border-[var(--border)] bg-transparent'
                            )}
                          >
                            {on ? (
                              <span
                                aria-hidden="true"
                                className={QUESTION_OPTION_MARK_CLASS}
                              />
                            ) : null}
                          </span>
                          <span className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]">
                            <span className="mr-[var(--vds-space-2)] font-medium text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
                              {questionPolicy?.optionLabel?.(o) ?? o.label}
                            </span>
                            {o.description && (
                              <span className="text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]">
                                {o.description}
                              </span>
                            )}
                          </span>
                        </Button>
                      )
                    })}
                    {done ? (
                      item.answers?.[q.id || q.header || q.question] && (
                        <p className="m-0 whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                          {t('stream.submittedAnswer')}
                          {item.answers[q.id || q.header || q.question]}
                        </p>
                      )
                    ) : questionPolicy?.directDecision ? null : (
                      <Textarea
                        data-testid={`hil-question-other-${qi}`}
                        aria-label={t('stream.otherAnswer')}
                        placeholder={t('stream.otherAnswerPlaceholder')}
                        rows={2}
                        disabled={submitting}
                        value={texts[qi] || ''}
                        onChange={(event) => {
                          const value = event.target.value
                          setTexts((t) => ({ ...t, [qi]: value }))
                          if (!q.multiSelect && value.trim())
                            setPicks((p) => ({ ...p, [qi]: [] }))
                        }}
                        className="mt-[var(--vds-space-1)] w-full resize-y"
                      />
                    )}
                  </div>
                ) : (
                  <Textarea
                    unstyled
                    data-testid={`hil-question-text-${qi}`}
                    disabled={done || submitting}
                    rows={2}
                    placeholder={t('stream.hil.answerPlaceholder')}
                    value={
                      done
                        ? String(
                            (item.answers ?? {})[
                              q.id || q.header || q.question
                            ] ??
                              texts[qi] ??
                              ''
                          )
                        : texts[qi] || ''
                    }
                    onChange={(e) =>
                      setTexts((t) => ({ ...t, [qi]: e.target.value }))
                    }
                    className="box-border w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-[10px] py-[var(--vds-space-2)] text-[13px] text-[var(--text)] [font:inherit]"
                  />
                )}
              </div>
            ))
          )}
          </ScrollArea>
          {!done && !questionPolicy?.directDecision && (
            <div
              className="mt-[var(--vds-space-4)] flex flex-none gap-[var(--vds-space-2)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]"
              data-testid="hil-question-actions"
            >
              <Button
                variant="primary"
                size="sm"
                type="button"
                data-testid="hil-question-confirm"
                disabled={submitting || !questionComplete}
                onClick={submitQuestion}
              >
                {t('stream.hil.confirm')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                data-testid="hil-question-skip"
                disabled={submitting}
                onClick={() => {
                  const answers = questionPolicy?.defaults?.(qs) ?? {}
                  void submitAction({
                    kind: 'respond',
                    body: { answers },
                    label:
                      questionPolicy?.defaultLabel ?? t('stream.hil.skipped'),
                    answers
                  })
                }}
              >
                {t('stream.hil.skip')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {(item.toolName || item.workdir || item.safetyTags) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 7
              }}
            >
              {item.toolName && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-3)'
                  }}
                >
                  {item.toolName.toLowerCase()}
                </span>
              )}
              {item.workdir && <Chip label={shortPath(item.workdir)} />}
              {(item.safetyTags ?? []).map((tag) => (
                <Chip
                  key={tag}
                  label={safetyTagLabel(tag, t)}
                  tone={TAG_TONE[tag]}
                />
              ))}
            </div>
          )}

          {codeText && (
            <div style={{ marginTop: 12 }}>
              <Button
                unstyled
                type="button"
                onClick={() => setCodeOpen((v) => !v)}
                className="inline-flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-[var(--vds-space-0)] text-xs text-[var(--text-2)]"
              >
                <span
                  style={{
                    fontSize: 9,
                    color: 'var(--text-3)',
                    transform: codeOpen ? 'rotate(90deg)' : 'none',
                    transition: 'transform .15s'
                  }}
                >
                  ▶
                </span>
                {codeLabel}
              </Button>
              {codeOpen && (
                <pre
                  style={{
                    margin: '8px 0 0',
                    padding: '11px 13px',
                    background: 'var(--bg-3)',
                    border: '1px solid var(--border-soft)',
                    borderRadius: 9,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: 'var(--text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    maxHeight: 220,
                    overflow: 'auto'
                  }}
                >
                  {codeText}
                </pre>
              )}
            </div>
          )}

          {descText && (
            <div
              style={{
                marginTop: 12,
                fontSize: 12,
                color: 'var(--text-3)',
                lineHeight: 1.6
              }}
            >
              {descText}
            </div>
          )}

          {(item.path || item.networkTarget || item.permissions) && (
            <div
              data-testid="hil-permission-details"
              style={{
                marginTop: 10,
                padding: '9px 11px',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                background: 'var(--bg-3)',
                fontSize: 11,
                lineHeight: 1.55,
                color: 'var(--text-2)'
              }}
            >
              {item.path && (
                <div>
                  <b>{t('stream.hil.pathLabel')}</b>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {item.path}
                  </span>
                </div>
              )}
              {item.networkTarget && (
                <div>
                  <b>{t('stream.hil.networkTargetLabel')}</b>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {item.networkTarget}
                  </span>
                </div>
              )}
              {item.permissions && (
                <div>
                  <b>{t('stream.hil.extraPermissionsLabel')}</b>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>
                    {fmtVal(item.permissions, t)}
                  </span>
                </div>
              )}
            </div>
          )}
          {item.diff && (
            <pre
              data-testid="hil-file-diff"
              style={{
                margin: '10px 0 0',
                padding: '10px 12px',
                maxHeight: 180,
                overflow: 'auto',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                background: 'var(--bg-3)',
                color: 'var(--text-2)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {item.diff}
            </pre>
          )}

          {!done && (
            <div className="mt-[15px] flex flex-wrap items-center gap-[var(--vds-space-2)]">
              {orderedAllows.map((o, i) => {
                const oi = scopeInfo(o, item, t)
                const primary = i === 0
                return (
                  <Button
                    unstyled
                    type="button"
                    key={o.id}
                    data-testid={`hil-permission-${o.id}`}
                    disabled={submitting}
                    className={cx(
                      'cursor-pointer whitespace-nowrap rounded-lg border px-[14px] py-[var(--vds-space-2)] text-[13px] disabled:cursor-default disabled:opacity-60',
                      primary
                        ? cx(
                            ACCENT_HOVER_BUTTON_CLASS,
                            'border-[var(--accent)] bg-[var(--accent)] font-semibold text-[var(--on-accent)]'
                          )
                        : cx(
                            OUTLINE_HOVER_BUTTON_CLASS,
                            'border-[var(--border)] bg-transparent font-normal text-[var(--text)]'
                          )
                    )}
                    title={oi.caption !== oi.short ? oi.caption : undefined}
                    onClick={() =>
                      answerPermission(
                        o.id,
                        t('stream.hil.allowedScope', { scope: oi.short }),
                        {
                          kind: 'allowedScope',
                          scope: hilPermissionScope(o, item.prefixKind)
                        }
                      )
                    }
                  >
                    {oi.short}
                  </Button>
                )
              })}
              <Button
                unstyled
                type="button"
                data-testid={`hil-permission-${denyOpt.id}`}
                className={cx(
                  OUTLINE_HOVER_BUTTON_CLASS,
                  'cursor-pointer whitespace-nowrap rounded-lg border border-[var(--border)] bg-transparent px-[14px] py-[var(--vds-space-2)] text-[13px] text-[var(--text-2)] disabled:cursor-default disabled:opacity-60'
                )}
                disabled={submitting}
                onClick={() =>
                  answerPermission(denyOpt.id, t('stream.hil.denied'), {
                    kind: 'denied'
                  })
                }
              >
                {t('stream.hil.deny')}
              </Button>
            </div>
          )}
        </>
      )}
      {!done && item.hilState === 'failed' && lastAction && (
        <div className="mt-[var(--vds-space-3)] flex gap-[var(--vds-space-2)]">
          {item.hilState === 'failed' && lastAction && (
            <Button
              unstyled
              type="button"
              data-testid="hil-retry"
              className={cx(
                ACCENT_HOVER_BUTTON_CLASS,
                'rounded-lg border-0 bg-[var(--accent)] px-[13px] py-[7px] text-xs text-[var(--on-accent)]'
              )}
              onClick={() => void submitAction(lastAction)}
            >
              {t('stream.hil.resubmit')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** gray task-prompt at the very top of a sub-session stream (scrolls with messages) */
function PromptCard({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '13px 16px',
        marginBottom: 30
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 7
        }}
      >
        {t('stream.task')}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 15,
          color: 'var(--text-2)',
          lineHeight: 1.55
        }}
      >
        {text}
      </div>
    </div>
  )
}

function Thinking({
  text,
  itemId,
  selectionEnabled = true
}: {
  text: string
  itemId?: string
  selectionEnabled?: boolean
}): React.JSX.Element {
  const messageId = itemId ? `item:${itemId}` : undefined
  const markdownClassName =
    '!text-[length:var(--vds-font-body-lv2)] leading-[1.65] text-[var(--text-2)] [&>*:last-child]:mb-0'
  return (
    <div
      className="min-w-0"
      data-testid="turn-commentary"
    >
      {messageId ? (
        <AnnotatedAnswer
          citationEnabled={false}
          text={text}
          selectionEnabled={selectionEnabled}
          messageId={messageId}
          markdownClassName={markdownClassName}
        />
      ) : (
        <Markdown text={text} className={markdownClassName} />
      )}
    </div>
  )
}

function Day({ text }: { text: string }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        margin: '4px 0 26px'
      }}
    >
      <span
        style={{ fontSize: 10, letterSpacing: '0.2em', color: 'var(--text-3)' }}
      >
        {text}
      </span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
    </div>
  )
}

function Reentry({
  item
}: {
  item: Extract<ConvItem, { kind: 'reentry' }>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { set, act } = useApp()
  return (
    <div
      style={{
        borderLeft: '2px solid var(--accent)',
        padding: '2px 0 2px 22px',
        marginBottom: 48,
        animation: 'cardIn .5s ease both'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--accent-ink)'
          }}
        >
          {item.topic}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
          {item.sub}
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '14px 20px',
          alignItems: 'baseline'
        }}
      >
        {item.rows.map(([label, value, tone], i) => (
          <React.Fragment key={i}>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {label}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                color: tone ? TONE[tone] : 'var(--text)'
              }}
            >
              {value}
            </span>
          </React.Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
        <Btn
          tone="var(--accent)"
          onClick={() => {
            act.startPanelDraft()
            set({ recallOpen: false })
          }}
        >
          {t('stream.continue')}
        </Btn>
      </div>
    </div>
  )
}

function Avatar({
  kind,
  who
}: {
  kind: 'user' | 'agent'
  who?: string
}): React.JSX.Element {
  const user = kind === 'user'
  // team 成员: 用名字首字母的彩色头像区分说话人 (群聊感)
  if (who) {
    return (
      <span
        style={{
          width: 30,
          height: 30,
          flex: 'none',
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent)',
          color: 'var(--accent-ink)',
          fontSize: 12,
          fontWeight: 600,
          textTransform: 'uppercase'
        }}
      >
        {who.replace(/[^a-z0-9]/gi, '').slice(0, 1) || '@'}
      </span>
    )
  }
  return (
    <span
      style={{
        width: 30,
        height: 30,
        flex: 'none',
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        background: user ? 'var(--accent-soft)' : 'var(--bg-3)',
        border: `1px solid ${user ? 'var(--accent)' : 'var(--border)'}`,
        color: user ? 'var(--accent-ink)' : 'var(--text-2)'
      }}
    >
      <Icon name={kind} size={16} />
    </span>
  )
}

function UserBubble({
  item,
  running,
  onRewind
}: {
  item: Extract<ConvItem, { kind: 'user' }>
  running: boolean
  onRewind: (anchor: number) => Promise<string | null>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { state, act } = useApp()
  const steer = item.steer
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState('')
  const [expandedReferenceId, setExpandedReferenceId] = useState<string | null>(
    null
  )
  const canRewind = !steer && !running && item.rewindAnchor !== undefined
  const annotationRefs =
    item.refs?.filter(
      (reference) =>
        reference.type === 'assistant_context' && reference.kind === 'note'
    ) ?? []
  const annotations = annotationRefs.flatMap((reference) => {
    const annotation = state.aiPanel.annotations.find(
      (candidate) => candidate.annotation_id === reference.sourceId
    )
    return annotation ? [annotationDisplay(annotation)] : []
  })
  const contextRefs =
    item.refs?.filter(
      (reference) =>
        reference.type === 'assistant_context' && reference.kind !== 'note'
    ) ?? []
  const project = state.projects.find(
    (candidate) => candidate.path === activeThread(state).projectPath
  )
  const openContextSource = (reference: MessageReference): void => {
    if (!reference.sourceId || !project) return
    if (reference.kind === LITERATURE_CONTEXT_KIND) {
      if (reference.anchor) {
        void act.openLiteratureAttachment(reference.sourceId)
        return
      }
      void act.openLiteratureItem(reference.sourceId, project.id)
      return
    }
    if (
      reference.kind === SELECTION_CONTEXT_KIND ||
      OPENABLE_RESOURCE_CONTEXT_KINDS.has(reference.kind ?? '')
    ) {
      act.openResourceFile(reference.sourceId, project.id)
    }
  }
  const contextSourceLabel = (reference: MessageReference): string =>
    !reference.anchor &&
    reference.kind !== SESSION_CONTEXT_KIND &&
    reference.kind !== LITERATURE_CONTEXT_KIND
      ? reference.sourceId?.split('/').filter(Boolean).pop() || reference.title
      : referenceBaseLabel(reference, assistantText)
  const confirmRewind = async (): Promise<void> => {
    if (item.rewindAnchor === undefined || restoring) return
    setRestoring(true)
    setError('')
    const reason = await onRewind(item.rewindAnchor)
    if (reason) {
      setError(reason)
      setRestoring(false)
    }
  }
  return (
    <div className="mb-[22px] flex justify-end">
      <div className="relative grid w-max min-w-0 max-w-[var(--conversation-user-message-max)] justify-items-end">
        {steer && (
          <div className="mx-[var(--vds-space-1)] mb-[6px] flex items-center justify-end gap-[7px] text-[9px] font-[650] uppercase tracking-[0.08em] text-[var(--text-3)]">
            <span>{item.steerLabel}</span>
            <span className="rounded-[5px] border border-[var(--accent)] px-[6px] py-px text-[9px] text-[var(--accent-ink)]">
              {t('stream.steer')}
            </span>
          </div>
        )}
        <div
          className={cx(
            'relative box-border w-auto max-w-full overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--border-soft)] bg-[var(--vds-other-overlay-2)] px-[15px] pb-[12px] pt-[11px]',
            steer && 'border-dashed border-[var(--accent)]'
          )}
          data-testid="user-bubble"
        >
          {canRewind && !confirming && (
            <Button
              unstyled
              type="button"
              className={cx(
                OUTLINE_HOVER_BUTTON_CLASS,
                'absolute right-[10px] top-[-10px] grid size-[24px] place-items-center rounded-[7px] border border-[var(--border)] bg-[var(--bg-2)] p-[var(--vds-space-0)] text-[var(--text-3)]'
              )}
              onClick={() => setConfirming(true)}
              data-testid="rewind-prompt"
              title={t('stream.rewindHere')}
              aria-label={t('stream.rewindHere')}
            >
              <Icon name="rewind" size={13} />
            </Button>
          )}
          {contextRefs.length > 0 ? (
            <div
              className="mb-[var(--vds-space-2)] flex flex-wrap justify-end gap-[var(--vds-space-1)]"
              data-testid="sent-context-references"
            >
              {contextRefs.map((reference) => {
                const selection = Boolean(reference.anchor)
                const canOpen = Boolean(reference.sourceId && project)
                const expanded = expandedReferenceId === reference.id
                if (reference.kind === SESSION_CONTEXT_KIND) {
                  return (
                    <SessionReference
                      currentSessionId={activeThread(state).sessionId}
                      key={reference.id}
                      reference={reference}
                    />
                  )
                }
                return selection ? (
                  <div
                    className="grid w-full justify-items-end gap-[var(--vds-space-1)]"
                    key={reference.id}
                  >
                    <Button
                      unstyled
                      variant="ghost"
                      size="content"
                      className="inline-flex max-w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-brand-light-border)] bg-[var(--vds-brand-light-bg-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-brand-text-primary)]"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedReferenceId(expanded ? null : reference.id)
                      }
                    >
                      <Icon name="quote" size={12} />
                      <span className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {contextSourceLabel(reference)}
                      </span>
                      <span className="border-l border-[var(--vds-brand-light-border)] pl-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
                        {t('stream.fragment')}
                      </span>
                    </Button>
                    {expanded ? (
                      <Card
                        className="w-full text-left"
                        padding="sm"
                        data-testid="sent-selection-reference"
                      >
                        <CardContent className="grid gap-[var(--vds-space-2)]">
                          <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                            <Icon name="quote" size={13} />
                            <Button
                              unstyled
                              variant="link"
                              size="content"
                              disabled={!canOpen}
                              className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left font-medium text-[var(--vds-text-primary)]"
                              onClick={() => openContextSource(reference)}
                            >
                              {contextSourceLabel(reference)}
                            </Button>
                            <IconButton
                              label={t('stream.collapseReference')}
                              icon={<Icon name="close" size={12} />}
                              size="sm"
                              variant="ghostIcon"
                              onClick={() => setExpandedReferenceId(null)}
                            />
                          </div>
                          <ScrollArea
                            className="max-h-[120px]"
                            viewportClassName="max-h-[120px] whitespace-pre-wrap break-words border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]"
                          >
                            {reference.anchor?.previewText ||
                              t('stream.unavailableFragment')}
                          </ScrollArea>
                        </CardContent>
                      </Card>
                    ) : null}
                  </div>
                ) : (
                  <Button
                    key={reference.id}
                    unstyled
                    variant="outline"
                    size="content"
                    disabled={!canOpen}
                    className="inline-flex max-w-full items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
                    onClick={() => openContextSource(reference)}
                  >
                    <Icon
                      name={
                        reference.kind === LITERATURE_CONTEXT_KIND
                          ? 'books'
                          : 'doc'
                      }
                      size={12}
                    />
                    <span className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap">
                      {contextSourceLabel(reference)}
                    </span>
                  </Button>
                )
              })}
            </div>
          ) : null}
          {item.refs?.some(
            (reference) =>
              ((reference.type !== 'file' && reference.type !== 'directory') || !reference.path) &&
              reference.type !== 'assistant_context'
          ) && (
            <div className="mb-[var(--vds-space-2)] flex flex-wrap gap-[6px]">
              {item
                .refs!.filter(
                  (reference) =>
                    ((reference.type !== 'file' && reference.type !== 'directory') || !reference.path) &&
                    reference.type !== 'assistant_context'
                )
                .map((reference) => (
                  <span
                    key={reference.type + reference.id}
                    className="inline-flex max-w-full items-center gap-[6px] rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-[var(--vds-space-2)] py-[2px] text-[10.5px]"
                    title={t('stream.referenceSent', {
                      type: reference.type,
                      id: reference.id
                    })}
                  >
                    <span className="flex-none font-semibold text-[var(--accent-ink)]">
                      {userMessageRefType(reference.type, t)}
                    </span>
                    <span className="max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text-2)]">
                      {reference.title}
                    </span>
                    {reference.status && (
                      <span className="flex-none text-[9px] text-[var(--text-3)]">
                        {reference.status}
                      </span>
                    )}
                  </span>
                ))}
            </div>
          )}
          <div className="whitespace-pre-wrap font-serif text-[length:var(--vds-font-body-lv2)] leading-[1.62] text-[var(--text)] [overflow-wrap:anywhere]">
            {item.text}
          </div>
          <AnnotationSummary
            annotations={annotations}
            className="mt-[var(--vds-space-1)]"
            location={state.aiPanel.answerAnnotationFocus}
            numberForAnnotation={(annotationId, index) => {
              const raw = state.aiPanel.annotations.find(item => item.annotation_id === annotationId)
              if (!raw) return index + 1
              return state.aiPanel.annotations.filter(item => item.source_item_id === raw.source_item_id)
                .findIndex(item => item.annotation_id === annotationId) + 1
            }}
            onEdit={(annotationId, comment) => act.updateAnswerAnnotation(annotationId, comment)}
            onOpenOriginal={(annotationId) => void act.focusAnswerAnnotation(annotationId)}
            onRemove={(annotationId) => void act.deleteAnswerAnnotation(annotationId)}
            testId="user-message-annotations"
          />
          {item.refs?.some(
            (reference) => (reference.type === 'file' || reference.type === 'directory') && reference.path
          ) && (
            <div className="mb-[6px] flex w-min max-w-full flex-nowrap justify-start gap-[2px] overflow-x-auto overflow-y-hidden py-[var(--vds-space-1)] pl-[var(--vds-space-0)] pr-[2px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <SentAttachments
                key={activeThread(state).sessionId}
                refs={item.refs.flatMap((reference) => {
                  if (!reference.path) return []
                  if (reference.type === 'directory') return [{
                    type: 'directory' as const,
                    id: reference.id,
                    title: reference.title,
                    status: reference.status,
                    path: reference.path
                  }]
                  if (reference.type === 'file') return [{
                    type: 'file' as const,
                    id: reference.id,
                    title: reference.title,
                    status: reference.status,
                    path: reference.path,
                    mediaType: reference.mediaType,
                    sha256: reference.sha256,
                    size: reference.size
                  }]
                  return []
                })}
              />
            </div>
          )}
          {confirming &&
            createPortal(
              <RewindConfirmation
                error={error}
                restoring={restoring}
                onCancel={() => setConfirming(false)}
                onConfirm={confirmRewind}
              />,
              document.body
            )}
        </div>
        {item.text && (
          <div className={cx(MESSAGE_ACTIONS_CLASS, 'justify-end')}>
            <CopyButton
              type="button"
              size="xs"
              variant="ghostIcon"
              value={item.text}
              writeText={writeDesktopClipboard}
              idleLabel={t('stream.copyMessage')}
              copiedLabel={t('stream.copied')}
            >
              <Copy size={14} />
            </CopyButton>
          </div>
        )}
      </div>
    </div>
  )
}

function InteractionReply({
  item
}: {
  item: Extract<ConvItem, { kind: 'interaction_reply' }>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const rows = item.questions.map((question) => {
    const key = question.id || question.header || question.question
    return {
      question: question.question,
      answer: item.answers[key] || conversation('reply.skipped')
    }
  })
  return (
    <div
      className="mt-[var(--vds-space-2)] mb-[22px] flex justify-end"
      data-testid="interaction-reply"
      data-interaction-request-id={item.requestId}
    >
      <div className="grid w-max min-w-0 max-w-[var(--conversation-user-message-max)] gap-[10px] rounded-[var(--vds-radius-4)] border border-[var(--border-soft)] bg-[var(--vds-other-overlay-2)] px-[15px] py-[12px]">
        {rows.map((row, index) => (
          <div
            key={`${row.question}:${index}`}
            className="grid min-w-0 gap-[3px] border-t border-[var(--border-soft)] pt-[10px] first:border-t-0 first:pt-0"
            aria-label={conversation('reply.answerLabel', {
              question: row.question,
              answer: row.answer
            })}
          >
            <span className="font-serif text-[12px] leading-[1.45] text-[var(--text-3)] [overflow-wrap:anywhere]">
              {row.question}
            </span>
            <span className="font-serif text-[15px] font-medium leading-[1.55] text-[var(--text)] [overflow-wrap:anywhere]">
              {row.answer}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RewindConfirmation({
  error,
  restoring,
  onCancel,
  onConfirm
}: {
  error: string
  restoring: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('stream.confirmRewind')}
      style={rewindOverlayStyle}
      onClick={() => {
        if (!restoring) onCancel()
      }}
    >
      <div
        style={rewindDialogStyle}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            width: 38,
            height: 38,
            margin: '0 auto 13px',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 12,
            background: 'var(--accent-soft)',
            color: 'var(--accent-ink)'
          }}
        >
          <Icon name="rewind" size={19} />
        </div>
        <div
          style={{
            color: 'var(--text)',
            fontFamily: 'var(--font-serif)',
            fontSize: 18,
            fontWeight: 600,
            lineHeight: 1.35,
            textAlign: 'center'
          }}
        >
          {t('stream.rewindTitle')}
        </div>
        <div
          style={{
            marginTop: 7,
            color: 'var(--text-2)',
            fontSize: 13,
            lineHeight: 1.55,
            textAlign: 'center'
          }}
        >
          {t('stream.rewindDescription')}
        </div>
        {error && (
          <div
            role="alert"
            style={{
              marginTop: 12,
              color: 'var(--c-tension)',
              fontSize: 12,
              lineHeight: 1.45,
              textAlign: 'center'
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: error ? 16 : 20 }}>
          <Button
            unstyled
            type="button"
            onClick={onCancel}
            disabled={restoring}
            className="h-9 flex-1 rounded-[9px] border border-[var(--border)] bg-[var(--bg)] text-[12.5px] text-[var(--text-2)] disabled:cursor-default"
          >
            {t('stream.cancel')}
          </Button>
          <Button
            unstyled
            type="button"
            onClick={() => void onConfirm()}
            data-testid="rewind-confirm"
            disabled={restoring}
            className="h-9 flex-1 rounded-[9px] border-0 bg-[var(--accent)] text-[12.5px] font-semibold text-[var(--on-accent)] disabled:cursor-default disabled:opacity-[0.65]"
          >
            {restoring
              ? t('stream.rewinding')
              : error
                ? t('stream.retry')
                : t('stream.rewind')}
          </Button>
        </div>
      </div>
    </div>
  )
}

async function writeDesktopClipboard(text: string): Promise<void> {
  const native = window.scholarseed?.writeClipboard
  if (native) {
    const result = await native(text)
    if (!result.ok) throw new Error(result.error || 'clipboard_write_failed')
    return
  }
  await navigator.clipboard.writeText(text)
}

function AgentMsg({
  citationEnabled,
  copyEnabled,
  item,
  trailingContent,
  selectionEnabled,
  timing
}: {
  citationEnabled: boolean
  copyEnabled: boolean
  item: Extract<ConvItem, { kind: 'agent' }>
  trailingContent?: React.ReactNode
  selectionEnabled: boolean
  timing?: TurnTiming
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const duration = timing?.completedAt === undefined
    ? null
    : turnDurationLabel(timing.startedAt, timing.completedAt)
  return (
    <div style={{ display: 'flex', gap: 11, marginBottom: 28 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {item.text && (
          <div className="motion-safe:animate-[vds-answer-in_var(--vds-duration-fast)_var(--vds-ease-standard)_both]">
            <AnnotatedAnswer
              citationEnabled={citationEnabled}
              text={item.text}
              eventSeq={item.eventSeq}
              evidence={item.evidence}
              selectionEnabled={selectionEnabled}
              turnId={item.turnId}
              messageId={item.itemId ? `item:${item.itemId}` : null}
              answerSources={item.answerSources}
              markdownClassName="!text-[length:var(--vds-font-body-lv2)]"
            />
          </div>
        )}
        {trailingContent}
        {item.text && copyEnabled && (
          <div className={MESSAGE_ACTIONS_CLASS}>
            <CopyButton
              type="button"
              size="xs"
              variant="ghostIcon"
              value={visibleMarkdownText(item.text || '')}
              writeText={writeDesktopClipboard}
              idleLabel={t('stream.copyReply')}
              copiedLabel={t('stream.copied')}
            >
              <Copy size={14} />
            </CopyButton>
            {duration ? (
              <Tooltip
                content={conversation('turn.duration', { duration })}
                portalled
              >
                <span
                  aria-label={conversation('turn.duration', { duration })}
                  className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
                  data-testid="turn-duration"
                  tabIndex={0}
                >
                  {duration}
                </span>
              </Tooltip>
            ) : null}
          </div>
        )}
        {item.evidence?.length ? (
          <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 10.5 }}>
            {t('stream.evidence', { count: item.evidence.length })}
          </div>
        ) : null}
        {item.evidenceNotice ? (
          <div
            style={{ marginTop: 8, color: 'var(--c-opinion)', fontSize: 10.5 }}
          >
            {item.evidenceNotice}
          </div>
        ) : null}
        {item.card && <CardView card={item.card} />}
      </div>
    </div>
  )
}

function StatusLine({
  item
}: {
  item: Extract<ConvItem, { kind: 'status' }>
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  return (
    <div
      className="mb-[var(--vds-space-5)] flex flex-wrap items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]"
      role="status"
    >
      <IconFont type="fill-status-tips" className="shrink-0 leading-[22px]" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {item.displayMessage
          ? renderFeedback(i18n, item.displayMessage)
          : item.runtimeNotice
            ? conversation('runtime.legacyNotice', {
                detail:
                  item.runtimeNotice.diagnostic ||
                  conversation('runtime.nonterminal')
              })
            : typeof item.text === 'string'
              ? item.text
              : formatRuntimeStatus(item.text, conversation)}
      </span>
      {item.runtimeAction === 'retry_session_resume' && item.actionSessionId ? (
        <Button
          size="sm"
          variant="secondary"
          data-testid="session-resume-retry"
          className="shrink-0"
          onClick={() => requestSessionResume(item.actionSessionId ?? '')}
        >
          {t('stream.reconnect')}
        </Button>
      ) : null}
    </div>
  )
}

function NoticeLine({
  text,
  message,
  displayMessage
}: Pick<
  Extract<ConvItem, { kind: 'notice' }>,
  'text' | 'message' | 'displayMessage'
>): React.JSX.Element {
  const { t, i18n } = useTranslation('conversation')
  // 真实通知文本 (checkout 历史化 / 后端错误 等), 不再写死任何示例内容。
  return (
    <div
      className="mb-[var(--vds-space-5)] flex items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]"
      role="status"
    >
      <IconFont type="fill-status-tips" className="shrink-0" />
      <span className="min-w-0 break-words">
        {displayMessage
          ? renderFeedback(i18n, displayMessage)
          : message
            ? t(message.key)
            : text}
      </span>
    </div>
  )
}

function ErrorCard({
  item,
  onContinue
}: {
  item: Extract<ConvItem, { kind: 'error' }>
  onContinue: (item: Extract<ConvItem, { kind: 'error' }>) => Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const { state, patchThread } = useApp()
  const { t: conversation } = useTranslation('conversation')
  const failureText = item.applicationFailure
    ? {
        title: conversation('failure.title'),
        message: formatApplicationRequestFailure(
          item.applicationFailure,
          conversation
        ),
        action: formatApplicationRequestFailure(
          item.applicationFailure,
          conversation
        )
      }
    : item.turnUnknown
      ? formatTurnUnknown(item, conversation)
      : formatTurnFailure(item, conversation)
  const confirming = item.actionState === 'submitting'
  const continueInterruptedTurn = async (): Promise<void> => {
    const sessionId = item.actionSessionId
    const turnId = item.actionTurnId
    const threadId = Object.entries(state.threads).find(
      ([, thread]) => thread.sessionId === sessionId
    )?.[0]
    if (!sessionId || !turnId || !threadId || confirming) return
    const patchAction = (
      patch: Partial<Extract<ConvItem, { kind: 'error' }>>
    ): void => {
      patchThread(threadId, (thread) => ({
        conversation: thread.conversation.map((candidate) =>
          candidate.kind === 'error' &&
          candidate.runtimeAction === 'confirm_turn_unknown' &&
          candidate.actionTurnId === turnId
            ? { ...candidate, ...patch }
            : candidate
        )
      }))
    }
    patchAction({
      actionState: 'submitting',
      actionError: undefined,
      actionErrorMessage: undefined
    })
    const result = await confirmUnknownTurn(sessionId, turnId)
    if (!result.ok) {
      patchAction({
        actionState: 'failed',
        actionError:
          result.error || feedback('conversation', 'retry.continueUnconfirmed'),
        actionErrorMessage: result.applicationFailure
      })
      return
    }
    const continuationInput = buildTurnInput(
      t('stream.continueInterrupted'),
      []
    )
    const clientUserMessageId = crypto.randomUUID()
    const currentThread = state.threads[threadId]
    const optimistic = optimisticQueuedMessage(
      currentThread?.queuedMessages ?? [],
      clientUserMessageId,
      continuationInput,
      [],
      state.aiPanel.revision
    )
    retainQueuedOutbox(sessionId, optimistic)
    patchThread(threadId, (thread) => ({
      conversation: thread.conversation.filter((candidate) => !(
        candidate.kind === 'error'
        && candidate.runtimeAction === 'confirm_turn_unknown'
        && candidate.actionTurnId === turnId
      )),
      queuedMessages: upsertQueuedMessage(
        thread.queuedMessages ?? [],
        optimistic
      )
    }))
    const delivered = await postTurn(
      sessionId,
      continuationInput,
      state.collaborationMode,
      {
        clientUserMessageId,
        assistantContextRevision: state.aiPanel.revision
      }
    )
    if (!isComposerSubmissionAccepted(delivered)) {
      patchThread(threadId, (thread) => ({
        queuedMessages: markOptimisticQueueOutcomeUnknown(
          thread.queuedMessages ?? [],
          clientUserMessageId
        )
      }))
      return
    }
    releaseQueuedOutbox(sessionId, clientUserMessageId)
    patchThread(threadId, (thread) => ({
      queuedMessages: settleOptimisticQueuedMessage(
        thread.queuedMessages ?? [],
        clientUserMessageId
      )
    }))
  }
  const continuing =
    item.runtimeAction === 'continue_turn' && item.actionState === 'submitting'
  const continueUnknown =
    item.runtimeAction === 'continue_turn' &&
    item.actionState === 'outcome_unknown'
  const turnUnknown = item.runtimeAction === 'confirm_turn_unknown'
  const retryExhausted = item.runtimeAction === 'continue_turn' &&
    item.failure?.kind === 'unavailable' &&
    Boolean(item.failure.automaticRetryAttempts)
  if (turnUnknown) {
    return (
      <div
        className="mb-[var(--vds-space-5)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        data-testid="turn-interrupted-notice"
        role="status"
      >
        <IconFont type="fill-status-tips" className="shrink-0" />
        <span>{failureText.title}</span>
        <Button
          data-testid="turn-unknown-continue"
          disabled={confirming}
          loading={confirming}
          loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
          onClick={() => void continueInterruptedTurn()}
          size="sm"
          variant="outline"
        >
          {t('stream.continueInterrupted')}
        </Button>
        {item.actionError ? (
          <span className="text-[var(--vds-error-text-primary)]">
            {item.actionErrorMessage
              ? formatApplicationRequestFailure(
                  item.actionErrorMessage,
                  conversation
                )
              : renderFeedback(i18n, item.actionError)}
          </span>
        ) : null}
      </div>
    )
  }
  if (retryExhausted) {
    return (
      <div
        className="mb-[var(--vds-space-5)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        data-testid="turn-retry-exhausted-notice"
        role="status"
      >
        <IconFont type="fill-status-tips" className="shrink-0" />
        <span>{failureText.message}</span>
        <Button
          data-testid="turn-continue"
          disabled={continuing || continueUnknown}
          loading={continuing}
          loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
          onClick={() => void onContinue(item)}
          size="sm"
          variant="outline"
        >
          {continueUnknown
            ? t('stream.continuePending')
            : t('stream.continueInterrupted')}
        </Button>
        {item.actionError ? (
          <span className="text-[var(--vds-error-text-primary)]" data-testid="turn-continue-error">
            {item.actionErrorMessage
              ? formatApplicationRequestFailure(item.actionErrorMessage, conversation)
              : renderFeedback(i18n, item.actionError)}
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <Alert
      className="mb-[var(--vds-space-5)] rounded-[var(--vds-radius-4)] px-[var(--vds-space-3)] py-[var(--vds-space-3)]"
      data-testid="turn-failure-card"
      tone="error"
    >
      <div className="grid w-full min-w-0 gap-[var(--vds-space-3)]">
        <AlertTitle className="text-[length:var(--vds-font-body-lv2)] font-medium">
          {failureText.title}
        </AlertTitle>
        {failureText.message ? (
          <AlertDescription
            truncate={false}
            data-testid="turn-failure-reason"
            className="whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
          >
            {failureText.message}
          </AlertDescription>
        ) : null}
        {/* 原因与下一步同源时 (content_policy 的 messageKey==actionKey、applicationFailure 分支) 只渲染一次。 */}
        {failureText.action && failureText.action !== failureText.message ? (
          <AlertDescription
            truncate={false}
            data-testid="turn-failure-action"
            className="whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]"
          >
            {failureText.action}
          </AlertDescription>
        ) : null}
        {item.runtimeAction === 'continue_turn' ? (
          <div>
            <Button
              data-testid="turn-continue"
              disabled={continuing || continueUnknown}
              loading={continuing}
              loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
              onClick={() => void onContinue(item)}
              variant="outline"
            >
              {continueUnknown
                ? t('stream.continuePending')
                : t('stream.continueInterrupted')}
            </Button>
          </div>
        ) : null}
        {item.actionError ? (
          <div
            className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-error-text-primary)]"
            data-testid={
              item.runtimeAction === 'continue_turn'
                ? 'turn-continue-error'
                : 'turn-unknown-confirm-error'
            }
          >
            {item.actionErrorMessage
              ? formatApplicationRequestFailure(
                  item.actionErrorMessage,
                  conversation
                )
              : renderFeedback(i18n, item.actionError)}
          </div>
        ) : null}
      </div>
    </Alert>
  )
}

// ─── nested inline cards ───

function CardView({ card }: { card: ConvCard }): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { state, set, act } = useApp()

  if (card.type === 'recall') {
    return (
      <div style={cardBox('var(--border)')}>
        <Head>
          <span style={{ color: 'var(--text-2)' }}>{card.head}</span>
          <span style={{ color: 'var(--text-3)' }}>{card.meta}</span>
        </Head>
        {card.entries.map((e) => (
          <div key={e.id} style={{ marginBottom: 11 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: TONE[e.cls],
                  marginTop: 7,
                  flex: 'none'
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 14.5,
                  color: 'var(--text)',
                  lineHeight: 1.55
                }}
              >
                {e.text}
              </span>
            </div>
            <div
              style={{
                fontSize: 9.5,
                color: 'var(--text-3)',
                marginLeft: 14,
                marginTop: 2
              }}
            >
              {e.provenance}
            </div>
          </div>
        ))}
        <Button
          unstyled
          type="button"
          className={CHIP_BUTTON_CLASS}
          onClick={() => set({ recallOpen: true })}
        >
          {t('stream.card.expandRecall')}
        </Button>
      </div>
    )
  }

  if (card.type === 'tension') {
    return (
      <div style={cardBox('var(--c-tension)')}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--c-tension)',
            marginBottom: 8
          }}
        >
          {card.label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 16.5,
            color: 'var(--text)',
            lineHeight: 1.6
          }}
        >
          {card.text}
        </div>
        {state.tension === 'open' && (
          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <Btn
              tone="var(--c-tension)"
              onClick={() => set({ tension: 'hypothesis' })}
            >
              {t('stream.card.setHypothesis')}
            </Btn>
            <Btn ghost onClick={() => set({ tension: 'ignored' })}>
              {t('stream.card.ignore')}
            </Btn>
          </div>
        )}
        {state.tension === 'hypothesis' && (
          <Note color="var(--c-experience)">
            {t('stream.card.hypothesisSet')}
          </Note>
        )}
        {state.tension === 'ignored' && (
          <Note color="var(--text-3)">{t('stream.card.ignored')}</Note>
        )}
      </div>
    )
  }

  if (card.type === 'judgment') {
    return (
      <div style={cardBox('var(--accent)')}>
        <Head>
          <span style={{ color: 'var(--accent-ink)' }}>
            {t('stream.card.judgmentCaptured')}
          </span>
          <span style={{ color: 'var(--text-3)' }}>
            {t('stream.card.lowConfidence')}
          </span>
        </Head>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '10px 16px',
            alignItems: 'baseline'
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('stream.card.action')}
          </span>
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
            {card.action}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {t('stream.card.judgment')}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 15,
              color: 'var(--text)'
            }}
          >
            {card.judgment}
          </span>
        </div>
        {state.judgment === 'pending' ? (
          <div
            style={{
              display: 'flex',
              gap: 9,
              marginTop: 14,
              alignItems: 'center'
            }}
          >
            <Btn
              tone="var(--accent)"
              onClick={() => set({ judgment: 'confirmed' })}
            >
              {t('stream.hil.confirm')}
            </Btn>
            <Btn ghost>{t('stream.card.rewrite')}</Btn>
            <Btn ghost>{t('stream.card.leaveBlank')}</Btn>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
              {t('stream.card.provenanceSaved')}
            </span>
          </div>
        ) : (
          <Note color="var(--c-experience)">
            {t('stream.card.judgmentAnchored')}
          </Note>
        )}
      </div>
    )
  }

  // thread result
  return (
    <div style={cardBox('var(--c-experience)')}>
      <Head>
        <span style={{ color: 'var(--c-experience)' }}>{card.head}</span>
        <span style={{ color: 'var(--text-3)' }}>{card.meta}</span>
      </Head>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 15.5,
          color: 'var(--text)',
          lineHeight: 1.6
        }}
      >
        {card.text}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 8 }}>
        {t('stream.card.artifactSavedPrefix')}{' '}
        <span style={{ color: 'var(--accent-ink)' }}>{card.artifact}</span>{' '}
        {t('stream.card.artifactSavedSuffix')}
      </div>
      {state.thread === 'open' ? (
        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          <Btn
            tone="var(--c-experience)"
            onClick={() => set({ thread: 'folded' })}
          >
            {conversation('card.foldAction')}
          </Btn>
          <Btn ghost>{conversation('card.keepAction')}</Btn>
          <Btn ghost>{conversation('card.abandonAction')}</Btn>
          <Btn ghost onClick={() => act.openSession('tent-augmix-a03')}>
            {t('stream.card.openSession')}
          </Btn>
        </div>
      ) : (
        <Note color="var(--c-experience)">{t('stream.card.folded')}</Note>
      )}
    </div>
  )
}

function Head({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 10
      }}
    >
      {children}
    </div>
  )
}
function Note({
  children,
  color
}: {
  children: React.ReactNode
  color: string
}): React.JSX.Element {
  return <div style={{ fontSize: 12, color, marginTop: 14 }}>{children}</div>
}
