import { PluginInteraction } from './Frame'
import {
  conversationTurns,
  currentConversationTurn,
  visibleConversationTurns,
  turnMarkerProximity,
  turnNavigationVisible,
} from './navigation'
import { markdownSummary } from '../../../../markdown/summary.ts'
import { OPENUI_SLOT } from '../../../../../../../packages/ui/document'
import { CANVAS_SLOT } from '../../../../../../../packages/ui/canvas'
import { WebNavigationContext } from '../../contracts/navigation'
import { LiteratureAuthorizationCard } from '../../features/literature/Scope'
import { fulltextSelection } from '../../features/literature/interaction'
import {
  LITERATURE_AUTHORIZATION_ACTIONS,
  LITERATURE_AUTHORIZATION_SLOTS,
} from '../../contracts/literature'
import { PLUGIN_ANSWER_CAPABILITY, PUBLIC_COMPONENT_PLUGIN } from '../../../../plugins'
import { Failure } from './Failure'
import { Continuation } from './Continuation'
import { Message } from '../primitive/Message'
import { EmptyAnswer } from '../primitive/Fallback'
import { canRetryEmptyTurn, isEmptyAnswer, isEmptyTurn } from './submission'
import { PluginInstallation } from './Skills'
import { QuestionOption, QuestionOptionsReveal, QuestionPrompt } from './Options'
import type { PluginMount } from '../../../../plugins'
import { availabilityPolicy } from '../../app/policy'
import { attentionRequest, matchingAttentionAnchors } from '../../attention'
import { referenceBaseLabel } from '../../features/assistant/text'
import { isSelectionReference, selectionReferenceGroups } from '../../features/assistant/contexts'
import { SelectionReference } from './Conversation'
import { ForkOriginDivider } from '../../features/assistant/Branch'
import { useForkOrigin } from '../../features/assistant/origin'
import { forkBoundaryIndex } from '../../features/assistant/fork'
import { markInteractionAttentionRead } from '../../features/assistant/attention'
import { deliveryLabel } from '../../delivery'
import {
  authenticationRecoveryAction,
  formatTurnFailure,
  presentRuntimeFailures,
  isRecoverableTurnFailure,
} from '../../failures'
import { feedback, renderFeedback } from '../../contracts/feedback'
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ReplyCopy, CardOnlyReplyCopy } from './Copy'
import { AnswerCopyContext, CopyItemsContext, CopySessionContext } from './clipboard'
import { hasCopyCard } from './copying'
import type { BrowserApprovalResponseReply } from '../../../../approval'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  GitBranch,
  TriangleAlert,
  CircleX,
  X,
  Hammer,
} from 'lucide-react'
import { streamingTextClassName } from '../../design/motion'
import aiThinking from '../../assets/ai-thinking.gif'
import {
  conversationInlinePadding,
  createFollowScroll,
  createScrollbarVisibility,
  messageFocusSpacerHeight,
} from './scroll'
import { useAccountAccess } from './access'
import { useSkillNames, type SkillNames } from './skillnames'
import { MessageActions, UserMessageText } from './Message'
import { userMessageTime } from './utils'
import { LoginPrompt } from './LoginPrompt'
import { commandOutcome } from '../../command'
import { activeThread, useApp, type ComposerReference } from '../../store'
import type {
  ConvCard,
  ConvItem,
  DeliveryCardMember,
  HilAnswerDetails,
  MessageReference,
  Thread,
  TurnOutcome,
  TurnTiming,
} from '../../model'
import { type HilResolvedMessage } from '../../model'
import { Icon, type IconName } from '../../icons'
import { modelSelectionBlocked } from '../../modelselection'
import { TONE } from '../../tone'

import {
  canReplayQuestionForm,
  componentOptionAnswers,
  declarativeAnswer,
  submittedPluginValues,
  hasHostQuestions,
  browserApprovalCardRole,
  browserApprovalSubmission,
  browserHistoryApprovalSubmission,
  browserApprovalTarget,
  approvalDetails,
  fileApprovalOperation,
  formatHilPermissionScope,
  formatHilResolution,
  formatHilSubmissionError,
  hilEventResolution,
  hilResolution,
  hilResolvedRunState,
  hilPermissionScope,
  hilSubmissionFailure,
  isQuestionHil,
  pendingHilItems,
  permissionDecisionOptions,
  transcriptPresentationItems,
  questionDraft,
  questionAnswer,
  replayQuestionAnswer,
  questionAtScroll,
  questionScrollTarget,
} from '../../hil'
import { Markdown, visibleMarkdownText } from '../primitive/Markdown'
import { sourceOffsetRect } from '../markdown/source'
import { IconFont } from '../primitive/Iconfont'
import { ConfirmationCard } from '../primitive/Confirmation'
import {
  checkSessionRecovery,
  getAuthMe,
  getHistoryWithTodos,
  getModels,
  interruptSession,
  openSession,
  postTurn,
  respondHil,
  rewindToPrompt,
} from '../../api'
import {
  appendOptimisticUserMessage,
  normalizeToolName,
  projectHistory,
  projectHistorySnapshot,
  recordHistoryCommit,
  removeOptimisticUserMessage,
  resolveHilItem,
} from '../../transcript'
import { projectPlanSnapshots } from '../../todo'
import {
  answerInteractionCapabilities,
  externalResultUrl,
  webSearchQuery,
  webSearchRecordData,
  subagentActivityItem,
  subagentIdentities,
  collaborationStatusKey,
  visibleThinkingItem,
  activityDisclosureOpen,
  executionProcesses,
  fallbackDurationRows,
  type ExecutionProcess as ExecutionProcessData,
  activityIdentity,
  activityRunState,
  activityRows,
  processRows,
  rowTurnId,
  type ActivityRow,
  hasVisibleTurnProgress,
  type ActivityItem,
  workingIndicatorVisible,
} from '../../activity'
import {
  canOfferTurnRecovery,
  canContinueFailedTurn,
  formatApplicationRequestFailure,
  formatRuntimeStatus,
  formatTurnUnknown,
  projectRecoveryCheck,
  recoveryCheckIdentity,
  recoveryCheckIsCurrent,
  requestSessionResume,
  type RecoveryCheckIdentity,
} from '../../runtime'
import { SentAttachments } from '../../features/assistant/Attachments'
import { LiteratureAttachment } from '../../features/assistant/Literature'
import { isImageAttachment } from '../../features/assistant/utils'
import { AnnotatedAnswer } from '../../features/assistant/Annotations'
import { loadAnswerImage } from '../../features/assistant/pictures'
import { TurnCitationSources } from '../../features/assistant/Citations'
import { createTurnSourceViewport } from '../../features/assistant/viewport'
import {
  ARTIFACT_DESCRIPTION_CLASS,
  ARTIFACT_ICON_CLASS,
  ARTIFACT_OUTLINE_ICON_CLASS,
  ARTIFACT_TITLE_CLASS,
  ArtifactOpenButton,
} from '../primitive/Receipt'
import { ArtifactCard } from '../../features/assistant/Artifacts'
import { artifactPreviewKind } from '../../features/assistant/delivery'
import { ARTIFACT_ROW_ITEM_CLASS, ARTIFACT_ROWS_CLASS } from './Artifact'
import { AnnotationSummary, annotationDisplay } from '../../features/assistant/Notes'
import { PdfCommentReference } from '../../features/assistant/Comment'
import { SessionReference } from '../../features/assistant/SessionReference'
import { WebSearchRecord } from './Retrieval'
import {
  ToolExecution,
  ExecutionBatch,
  ExecutionProcess,
  ExecutionStatus as ActivityStatusIcon,
  ExecutionIO as IoBlock,
  TOOL_ACTIVITY_DETAIL_INSET_CLASS,
  TOOL_ACTIVITY_LABEL_CLASS,
  TOOL_RUN_STEP_STATUS_CLASS,
  TOOL_RUN_STATUS_TONE_CLASS,
  TOOL_RUN_CONTENT_INNER_CLASS,
  TOOL_RUN_STEP_CLASS,
  TOOL_RUN_STEP_TRIGGER_CLASS,
  TOOL_RUN_STEP_NAME_CLASS,
  TOOL_RUN_STEP_CARET_CLASS,
  TOOL_RUN_STEP_CONTENT_CLASS,
  TOOL_RUN_IO_STACK_CLASS,
  TOOL_RUN_IO_LABEL_CLASS,
  TOOL_RUN_IO_CLASS,
} from './Execution'
import { SelectionReferences } from '../../features/assistant/Selections'
import { selectionLocator } from '../../features/workbench/reveal'
import { SentReferenceAttachment } from '../primitive'
import {
  DisplayCardView,
  useArtifactCardTypes,
  useCardArtifacts,
  useLatestDisplayCards,
  usePostDeliveryCardTypes,
} from './Cards'
import { useInteractionPolicies } from './Interactions'
import {
  ComposerConfirmationContext,
  isDockedInstallation,
  pendingConversationConfirmations,
} from './confirmation'
import {
  activityDurationLabel,
  activitySummaryState,
  answerCountdownLabel,
  elapsedLabel,
  turnDurationLabel,
} from './duration'
import { Finalizations } from '../../features/resources/Finalizations'
import { ReviewCard } from '../../features/resources/ReviewCard'
import { buildTurnInput, composerSubmissionOutcome, turnAdmissionFeedback } from '../../input'
import {
  hasQueuedMessageAwaitingRuntime,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  rejectOptimisticQueuedMessage,
  settleOptimisticQueuedMessage,
  upsertQueuedMessage,
} from '../../queue'
import { releaseQueuedOutbox, retainQueuedOutbox } from '../../outbox'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Tag,
  Checkbox,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CopyButton,
  EllipsisText,
  IconButton,
  Pagination,
  ScrollArea,
  Skeleton,
  Spinner,
  Textarea,
  Tooltip,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '../ui'

const HIL_WAIT_TICK_MS = 1000
const ACTIVITY_ELAPSED_TICK_MS = 1000
const SUBAGENT_ACTION_KEYS = {
  message: { key: 'subagent.action.message' },
  reasoning: { key: 'subagent.action.reasoning' },
  search: { key: 'subagent.action.search' },
  command: { key: 'subagent.action.command' },
  tool: { key: 'subagent.action.tool' },
  edit: { key: 'subagent.action.edit' },
  plan: { key: 'subagent.action.plan' },
  work: { key: 'subagent.action.work' },
} as const
const HIL_OUTCOME_UNKNOWN_MESSAGE = 'stream.hil.outcomeUnknown'
const SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX = 140
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const ANSWER_SOURCE_RANGE_UNIT = 'utf16_code_unit'
const OPENABLE_RESOURCE_CONTEXT_KINDS = new Set(['file', 'resource'])
const SELECTION_CONTEXT_KIND = 'selection'
const LITERATURE_CONTEXT_KIND = 'literature'
const SESSION_CONTEXT_KIND = 'session'
const GENERATION_PREVIEW_STATUS_KEYS = {
  streaming: 'generationPreview.streaming',
  generated: 'generationPreview.generated',
  unavailable: 'generationPreview.unavailable',
  failed: 'generationPreview.failed',
  cancelled: 'generationPreview.cancelled',
  timeout: 'generationPreview.timeout',
} as const
type HilResponseBody = {
  option_id?: string
  answers?: Record<string, string>
  answer_details?: HilAnswerDetails
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
const ACCENT_HOVER_BUTTON_CLASS = '[transition:filter_0.12s] hover:brightness-[1.06]'
const CHIP_BUTTON_CLASS =
  'rounded-[5px] border border-transparent bg-transparent px-[var(--vds-space-2)] py-[3px] text-[10px] text-[var(--text-3)] [transition:border-color_0.12s,color_0.12s] hover:bg-[var(--hover-bg)] hover:text-[var(--text-2)]'
const READING_COLUMN_CLASS =
  'box-border w-full max-w-[var(--vds-conversation-content-width)] min-w-0 mx-auto'
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
const TOOL_RUN_PULSE_CLASS =
  'size-[6px] flex-none rounded-full bg-current [animation:tool-run-pulse_1.2s_ease-in-out_infinite] motion-reduce:animate-none'
const TOOL_RUN_MARKDOWN_CLASS =
  '[&_*]:!font-[var(--vds-fw-regular)] [&_*]:!text-[var(--vds-text-tertiary)] !font-[var(--vds-font-code)] !font-[var(--vds-fw-regular)] !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !text-[var(--vds-text-tertiary)] [&_code]:!text-[length:var(--vds-font-body-lv1)] [&_code]:!leading-[var(--vds-lh-body-lv1)] [&_table]:!text-[length:var(--vds-font-body-lv1)] [&_.md-p]:!my-[var(--vds-space-2)] [&_.md-p:first-child]:!mt-0 [&_.md-p:last-child]:!mb-0'
const LEGACY_USER_STOPPED_STATUS = '已停止'

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
  cancelled: { messageKey: 'stream.toolStatus.cancelled' },
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
  approval_strict_review: 'stream.native.approvalStrictReview',
  review_entered: 'stream.native.reviewEntered',
  review_exited: 'stream.native.reviewExited',
  runtime_activity: 'stream.native.runtimeActivity',
} as const
const USER_REFERENCE_TYPE_LABELS = {
  skill: 'stream.referenceType.skill',
  assistant_context: 'stream.referenceType.assistantContext',
} as const

function userMessageRefType(type: string, t: TFunction<'components'>): string {
  if (type === 'skill') return t(USER_REFERENCE_TYPE_LABELS.skill)
  if (type === 'assistant_context') return t(USER_REFERENCE_TYPE_LABELS.assistant_context)
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
    completed && milliseconds > 0 ? Math.ceil(milliseconds / 1000) : Math.floor(milliseconds / 1000)
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
  onClick,
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
  animation: 'cardIn .5s ease both',
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
  WebkitBackdropFilter: 'saturate(0.9)',
}

const rewindDialogStyle: React.CSSProperties = {
  width: 'min(360px, calc(100vw - 40px))',
  boxSizing: 'border-box',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: '22px 22px 20px',
  background: 'var(--bg-2)',
  boxShadow: 'var(--shadow)',
}

const TURN_NAVIGATION_STATE_MESSAGES = {
  running: 'stream.navigation.states.running',
  waiting: 'stream.navigation.states.waiting',
  completed: 'stream.navigation.states.completed',
  failed: 'stream.navigation.states.failed',
  interrupted: 'stream.navigation.states.interrupted',
  unknown: 'stream.navigation.states.unknown',
} as const

function TurnAnswerSummary({ text }: { text: string }): React.JSX.Element {
  const summary = useMemo(() => markdownSummary(text), [text])
  return <>{summary}</>
}

function useScrollControlPlacement(
  target: HTMLDivElement | null,
  visible: boolean
): { left: number; size: number } | null {
  const [placement, setPlacement] = useState<{ left: number; size: number } | null>(null)
  useLayoutEffect(() => {
    if (!target || !visible) {
      setPlacement(null)
      return
    }
    const controls = target.closest('.vds-ai-composer-host')
    let observedPlan: HTMLElement | null = null
    const measure = (): void => {
      const plan = target.querySelector<HTMLElement>('[data-testid="todo-toggle"]')
      if (plan !== observedPlan) {
        if (observedPlan) resize.unobserve(observedPlan)
        if (plan) resize.observe(plan)
        observedPlan = plan
      }
      const displaced = controls?.querySelector(
        '[data-testid="hil-dock"], [data-testid="composer-message-queue"], [data-scroll-control-displaced]'
      )
      const bounds = plan?.getBoundingClientRect()
      const size = bounds?.height ?? 0
      const gap = parseFloat(getComputedStyle(target).getPropertyValue('--vds-space-2'))
      const center = (target.clientWidth - size) / 2
      const minimum = (bounds?.width ?? 0) + gap
      const left = center >= minimum ? center : target.clientWidth - size
      const next = size > 0 && !displaced && left >= minimum ? { left, size } : null
      setPlacement((current) =>
        current?.left === next?.left && current?.size === next?.size ? current : next
      )
    }
    const resize = new ResizeObserver(measure)
    resize.observe(target)
    const mutation = new MutationObserver(measure)
    mutation.observe(controls ?? target, { childList: true, subtree: true })
    measure()
    return () => {
      resize.disconnect()
      mutation.disconnect()
    }
  }, [target, visible])
  return target && visible ? placement : null
}

export function Stream({
  home = false,
  onOpenDelivery,
  scrollControlTarget = null,
}: {
  home?: boolean
  scrollControlTarget?: HTMLDivElement | null
  onOpenDelivery?: (member: DeliveryCardMember) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { state, set, patchThread, getSnapshot } = useApp()
  const thread = activeThread(state)
  const [recoveryChecking, setRecoveryChecking] = useState(false)
  const [failedRecovery, setFailedRecovery] = useState<RecoveryCheckIdentity | null>(null)
  const recoveryError = failedRecovery !== null && recoveryCheckIsCurrent(thread, failedRecovery)
  const resourceProject = state.projects.find((project) => project.path === thread.projectPath)
  const conv =
    state.activeSession === null && state.turnLaunch
      ? [state.turnLaunch.optimisticUserMessage]
      : thread.conversation
  useLayoutEffect(() => recordHistoryCommit(conv), [conv])
  const hasSkillReferences = conv.some(
    (item) => item.kind === 'user' && item.refs?.some((reference) => reference.type === 'skill')
  )
  const language = i18n.language
  const skillNames = useSkillNames(state.backendReady && hasSkillReferences, language)
  const currentConv = useLatestDisplayCards(conv)
  const postDeliveryCardTypes = usePostDeliveryCardTypes()
  const pendingHil = pendingHilItems(conv)
  const pendingTurnIds = new Set(pendingHil.map((item) => item.turnId))
  const streamRef = useRef<HTMLDivElement>(null)
  const navigationRef = useRef<HTMLElement>(null)
  const navigationFocusRef = useRef<string | null>(null)
  const [currentNavigationKey, setCurrentNavigationKey] = useState<string>()
  const [visibleNavigationKeys, setVisibleNavigationKeys] = useState<string[]>([])
  const [navigationGutter, setNavigationGutter] = useState(0)
  const [hoveredNavigationIndex, setHoveredNavigationIndex] = useState<number | null>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const sourceViewport = useMemo(createTurnSourceViewport, [thread.id, thread.sessionId])
  useEffect(() => {
    const root = streamRef.current
    const column = columnRef.current
    if (root && column) return sourceViewport.observe(home ? null : root, column)
  }, [home, sourceViewport])
  const answerTextVersions = useMemo(() => {
    const turns = new Map<string, string[]>()
    for (const item of conv) {
      if (item.kind !== 'agent' || !item.turnId) continue
      const fragments = turns.get(item.turnId) ?? []
      fragments.push(item.text)
      turns.set(item.turnId, fragments)
    }
    return new Map(
      Array.from(turns, ([turnId, fragments]) => [turnId, JSON.stringify(fragments)] as const)
    )
  }, [conv])
  const focusSpacerRef = useRef<HTMLDivElement>(null)
  const focusBoundsRef = useRef<(() => DOMRect | null) | null>(null)
  const focusedSessionRef = useRef<string | null>(null)
  const continuingTurnsRef = useRef(new Set<string>())
  const endRef = useRef<HTMLDivElement>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const scrollControlPlacement = useScrollControlPlacement(scrollControlTarget, showScrollToBottom)
  const showScrollToBottomRef = useRef(false)
  const resumeFollowOnScroll = useRef(false)
  // Turn 终态事件是停止工作态的唯一依据。中途 assistant 文本之后仍可能继续执行
  // 不需要单独展示的活动（例如 web_fetch），因此不能根据最后一条文本隐藏运行标签。
  const busy = thread.running === true || thread.status === 'running' || thread.status === 'waiting'
  const admitting =
    state.turnLaunch !== null || hasQueuedMessageAwaitingRuntime(thread.queuedMessages ?? [])
  const cardArtifacts = useCardArtifacts(conv)
  const artifactCardTypes = useArtifactCardTypes()
  const presented = presentRuntimeFailures(
    transcriptPresentationItems(currentConv).filter(
      (item) =>
        (thread.readOnly || !isDockedInstallation(item)) &&
        (item.kind !== 'artifact' || !cardArtifacts.has(item.artifact.artifact_id))
    )
  )
  const activeTurnId = Object.entries(thread.turnOutcomes ?? {})
    .filter(([, outcome]) => outcome === 'running')
    .at(-1)?.[0]
  const rows = activityRows(presented, thread.turnOutcomes, postDeliveryCardTypes)
  const navigationTurns = conversationTurns(
    presented.map((item) =>
      item.kind === 'user' && item.displayMessage
        ? { ...item, text: renderFeedback(i18n, item.displayMessage) }
        : item
    ),
    thread.turnOutcomes,
    pendingTurnIds
  )
  useEffect(() => {
    const stream = streamRef.current
    const column = columnRef.current
    if (home || !stream || !column) return
    const navigationKeys = new Set(navigationTurns.map((turn) => turn.key))
    let frame: number | undefined
    const update = (): void => {
      frame = undefined
      setNavigationGutter(column.getBoundingClientRect().left - stream.getBoundingClientRect().left)
      const anchors = Array.from(column.querySelectorAll<HTMLElement>('[data-message-kind="user"]'))
        .filter((element) => element.checkVisibility())
        .map((element) => ({
          key: element.dataset.messageItemId || element.dataset.messageTurnId || '',
          top: element.getBoundingClientRect().top,
        }))
        .filter((anchor) => navigationKeys.has(anchor.key))
      setCurrentNavigationKey(
        currentConversationTurn(anchors, stream.getBoundingClientRect().top + stream.clientTop)
      )
      const viewportTop = stream.getBoundingClientRect().top + stream.clientTop
      const visibleKeys = visibleConversationTurns(
        anchors,
        viewportTop,
        viewportTop + stream.clientHeight,
        column.getBoundingClientRect().bottom
      )
      setVisibleNavigationKeys((previous) =>
        previous.length === visibleKeys.length &&
        previous.every((key, index) => key === visibleKeys[index])
          ? previous
          : visibleKeys
      )
    }
    const schedule = (): void => {
      if (frame === undefined) frame = requestAnimationFrame(update)
    }
    update()
    stream.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(stream)
    observer.observe(column)
    return () => {
      stream.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [home, thread.sessionId, navigationTurns])
  useEffect(() => {
    setHoveredNavigationIndex(null)
    navigationFocusRef.current = null
  }, [thread.sessionId])
  useEffect(() => {
    const navigation = navigationRef.current
    const entry = navigation?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!navigation || !entry) return
    const top = entry.offsetTop
    if (top < navigation.scrollTop) navigation.scrollTop = top
    else if (top + entry.offsetHeight > navigation.scrollTop + navigation.clientHeight)
      navigation.scrollTop = top + entry.offsetHeight - navigation.clientHeight
  }, [currentNavigationKey, navigationGutter])
  const sections = processRows(rows)
  const processes = executionProcesses(rows)
  const fallbackDurations = fallbackDurationRows(rows)
  const latestAgentRow = rows.reduce(
    (latest, row, index) =>
      row.kind === 'item' && row.item.kind === 'agent' && row.item.text ? index : latest,
    -1
  )
  const fork = useForkOrigin(thread.sessionId)
  const forkBoundary = fork.origin ? forkBoundaryIndex(rows, fork.origin.inherited_messages) : -1
  const forkDivider = fork.origin ? <ForkOriginDivider {...fork} origin={fork.origin} /> : null
  const inheritedFailures = new Set(fork.origin?.inherited_failed_turn_ids)
  for (const item of presented) {
    if (item.turnId && (item.kind === 'error' || (item.kind === 'agent' && item.text.trim()))) {
      inheritedFailures.delete(item.turnId)
    }
  }
  const isArtifactReceiptRow = (row: ActivityRow | undefined): boolean => {
    if (row?.kind === 'artifacts')
      return !thread.sessionId || row.items.every((item) => !artifactPreviewKind(item.artifact))
    return (
      row?.kind === 'item' &&
      row.item.kind === 'display_card' &&
      artifactCardTypes.has(row.item.card.type)
    )
  }
  const sharesArtifactRow = (left: number, right: number): boolean => {
    const turnId = rows[left] && rowTurnId(rows[left])
    return Boolean(
      turnId &&
      right !== forkBoundary &&
      rows[right] &&
      rowTurnId(rows[right]) === turnId &&
      isArtifactReceiptRow(rows[left]) &&
      isArtifactReceiptRow(rows[right])
    )
  }
  const agentIdentities = subagentIdentities(conv)
  const hasVisibleProgress = hasVisibleTurnProgress(rows, activeTurnId)
  const showWorking = workingIndicatorVisible(
    busy,
    admitting,
    pendingHil.length,
    hasVisibleProgress,
    thread.recoveryBlocked
  )
  // Track the latest terminal turn outcome for screen reader announcements.
  const [scrollbarVisible, setScrollbarVisible] = useState(false)
  const lastAnnouncedRef = useRef<string | null>(null)
  const [turnAnnouncementKey, setTurnAnnouncementKey] = useState<
    | 'stream.turnCompletedAnnouncement'
    | 'stream.turnFailedAnnouncement'
    | 'stream.turnInterruptedAnnouncement'
    | null
  >(null)
  useEffect(() => {
    if (!thread.turnOutcomes) return
    const entries = Object.entries(thread.turnOutcomes)
    if (entries.length === 0) return
    const [, latestOutcome] = entries[entries.length - 1]
    if (latestOutcome === 'running' || latestOutcome === 'unknown') return
    const key = `${thread.sessionId}:${entries.length}:${latestOutcome}`
    if (key === lastAnnouncedRef.current) return
    lastAnnouncedRef.current = key
    if (latestOutcome === 'completed') setTurnAnnouncementKey('stream.turnCompletedAnnouncement')
    else if (latestOutcome === 'failed') setTurnAnnouncementKey('stream.turnFailedAnnouncement')
    else if (latestOutcome === 'interrupted')
      setTurnAnnouncementKey('stream.turnInterruptedAnnouncement')
  }, [thread.turnOutcomes, thread.sessionId])
  const finalAgentRows = new Set<number>()
  const turnsWithFinalAgent = new Set<string>()
  const stoppedNotices = new Map<string, Extract<ConvItem, { kind: 'status' }>>()
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (
      row.kind === 'item' &&
      row.item.kind === 'status' &&
      row.item.turnId &&
      isUserStoppedStatus(row.item)
    )
      stoppedNotices.set(row.item.turnId, row.item)
    if (
      row.kind !== 'item' ||
      row.item.kind !== 'agent' ||
      !row.item.text.trim() ||
      !row.item.turnId ||
      turnsWithFinalAgent.has(row.item.turnId)
    )
      continue
    turnsWithFinalAgent.add(row.item.turnId)
    finalAgentRows.add(index)
  }
  const renderTurnSources = (turnId: string): React.ReactNode =>
    thread.sessionId && thread.turnOutcomes?.[turnId] !== 'running' ? (
      <TurnCitationSources
        sessionId={thread.sessionId}
        turnId={turnId}
        viewport={sourceViewport}
        textVersion={answerTextVersions.get(turnId) ?? '[]'}
      />
    ) : null
  const sessionRef = useRef(thread.sessionId)
  sessionRef.current = thread.sessionId
  const updateFocusSpacer = React.useCallback((): number | undefined => {
    const stream = streamRef.current
    const spacer = focusSpacerRef.current
    const bounds = focusBoundsRef.current?.()
    if (!stream || !spacer || !bounds) return
    const top =
      stream.scrollTop + bounds.top - stream.getBoundingClientRect().top - stream.clientTop
    spacer.style.height = `${messageFocusSpacerHeight(stream, spacer, top)}px`
    return top
  }, [])
  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = 'auto'): void => {
      if (home) return
      const stream = streamRef.current
      if (!stream) return
      focusedSessionRef.current = null
      focusBoundsRef.current = null
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
    const distance = stream.scrollHeight - stream.scrollTop - stream.clientHeight
    const visible = distance > SHOW_SCROLL_TO_BOTTOM_DISTANCE_PX
    showScrollToBottomRef.current = visible
    setShowScrollToBottom(visible)
  }, [home])

  const followScroll = React.useMemo(
    () =>
      createFollowScroll(
        () => {
          scrollToBottom('auto')
          updateScrollToBottomVisibility()
        },
        (callback) => requestAnimationFrame(callback),
        (frame) => cancelAnimationFrame(frame)
      ),
    [scrollToBottom, updateScrollToBottomVisibility]
  )

  useEffect(() => () => followScroll.cancel(), [followScroll])

  useLayoutEffect(() => {
    followScroll.resume()
    resumeFollowOnScroll.current = false
    focusBoundsRef.current = null
  }, [followScroll, thread.sessionId])

  const continueTurn = async (failure: Extract<ConvItem, { kind: 'error' }>): Promise<void> => {
    const sessionId = thread.sessionId
    if (
      !sessionId ||
      modelSelectionBlocked(getSnapshot().serviceInstanceId, sessionId) ||
      !canContinueFailedTurn(thread, failure)
    )
      return
    const recoveryKey = `${sessionId}:${failure.turnId}`
    if (continuingTurnsRef.current.has(recoveryKey)) return
    continuingTurnsRef.current.add(recoveryKey)
    try {
      await submitFailedTurn(failure, sessionId)
    } finally {
      continuingTurnsRef.current.delete(recoveryKey)
    }
  }

  const submitFailedTurn = async (
    failure: Extract<ConvItem, { kind: 'error' }>,
    sessionId: string
  ): Promise<void> => {
    const patchFailure = (patch: Partial<Extract<ConvItem, { kind: 'error' }>>): void =>
      patchThread(thread.id, (current) => ({
        conversation: current.conversation.map((item) =>
          item.kind === 'error' &&
          item.runtimeAction === failure.runtimeAction &&
          item.turnId === failure.turnId
            ? { ...item, ...patch }
            : item
        ),
      }))
    patchFailure({ actionState: 'submitting', actionError: undefined })
    if (state.aiPanel.sessionId !== sessionId || state.aiPanel.contextState !== 'ready') {
      patchFailure({
        actionState: 'failed',
        actionError: feedback('conversation', 'retry.contextNotReady'),
      })
      return
    }
    let input
    try {
      input = buildTurnInput(t('stream.continueTaskPrompt'), [])
    } catch (error) {
      patchFailure({
        actionState: 'failed',
        actionError: error instanceof Error ? error.message : String(error),
      })
      return
    }
    const clientUserMessageId = crypto.randomUUID()
    const optimistic = optimisticQueuedMessage(
      thread.queuedMessages ?? [],
      clientUserMessageId,
      input,
      [],
      state.aiPanel.revision,
      'direct'
    )
    retainQueuedOutbox(sessionId, optimistic)
    patchThread(thread.id, (current) => ({
      queuedMessages: upsertQueuedMessage(current.queuedMessages ?? [], optimistic),
      conversation: appendOptimisticUserMessage(current.conversation, {
        kind: 'user',
        text: optimistic.text,
        itemId: clientUserMessageId,
      }),
    }))
    const delivered = await postTurn(sessionId, input, state.collaborationMode, {
      clientUserMessageId,
      assistantContextRevision: state.aiPanel.revision,
      continueTurnId: failure.turnId,
      serviceInstanceId: getSnapshot().serviceInstanceId ?? undefined,
    })
    const submissionOutcome = composerSubmissionOutcome(delivered)
    if (submissionOutcome === 'rejected') {
      releaseQueuedOutbox(sessionId, clientUserMessageId)
      patchThread(thread.id, (current) => ({
        conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
        queuedMessages: rejectOptimisticQueuedMessage(
          current.queuedMessages ?? [],
          clientUserMessageId
        ),
      }))
      patchFailure({
        actionState: 'failed',
        actionError: delivered
          ? turnAdmissionFeedback(delivered)
          : feedback('components', 'composer.messageFailed'),
      })
      return
    }
    if (submissionOutcome === 'unknown') {
      patchThread(thread.id, (current) => ({
        queuedMessages: markOptimisticQueueOutcomeUnknown(
          current.queuedMessages ?? [],
          clientUserMessageId
        ),
      }))
      patchFailure({
        actionState: 'outcome_unknown',
        actionError: feedback('conversation', 'retry.continueUnknown'),
      })
      return
    }
    releaseQueuedOutbox(sessionId, clientUserMessageId)
    patchThread(thread.id, (current) => ({
      conversation: current.conversation.filter(
        (item) =>
          !(
            item.kind === 'error' &&
            item.runtimeAction === failure.runtimeAction &&
            item.turnId === failure.turnId
          )
      ),
      queuedMessages: settleOptimisticQueuedMessage(
        current.queuedMessages ?? [],
        clientUserMessageId,
        delivered?.disposition
      ),
    }))
  }

  useLayoutEffect(() => {
    if (busy) focusedSessionRef.current = null
  }, [busy])

  useLayoutEffect(() => {
    if (!state.aiPanel.messageFocus && focusedSessionRef.current !== thread.sessionId)
      followScroll.request()
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
      (focus.requestId ? document : columnRef.current).querySelectorAll<HTMLElement>(
        '[data-message-item-id], [data-message-turn-id], [data-interaction-request-id], [data-recovery-session-id]'
      )
    )
    const target = matchingAttentionAnchors(
      candidates.map((element) => ({
        element,
        recoverySessionId: element.dataset.recoverySessionId,
        recoveryIncidentId: element.dataset.recoveryIncidentId,
        interactionRequestId: element.dataset.interactionRequestId,
        messageItemId: element.dataset.messageItemId,
        messageTurnId: element.dataset.messageTurnId,
        messageKind: element.dataset.messageKind,
      })),
      focus
    ).find((anchor) => {
      const element =
        getComputedStyle(anchor.element).display === 'contents'
          ? anchor.element.firstElementChild
          : anchor.element
      return element instanceof HTMLElement && element.checkVisibility()
    })?.element
    if (!target) return
    if (focus.requestId) {
      target.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      target.focus({ preventScroll: true })
      set((current) => ({ aiPanel: { ...current.aiPanel, messageFocus: null } }))
      return
    }
    const scrollTarget =
      target.firstElementChild instanceof HTMLElement ? target.firstElementChild : target
    const stream = streamRef.current
    const sourceRange = focus.sourceRange
    focusBoundsRef.current = () =>
      !scrollTarget.isConnected
        ? null
        : sourceRange?.unit === ANSWER_SOURCE_RANGE_UNIT
          ? (sourceOffsetRect(scrollTarget, sourceRange.start) ??
            scrollTarget.getBoundingClientRect())
          : scrollTarget.getBoundingClientRect()
    const top = updateFocusSpacer()
    if (top === undefined) return
    showScrollToBottomRef.current = true
    focusedSessionRef.current = thread.sessionId ?? null
    followScroll.pause()
    const navigationJump =
      navigationFocusRef.current === (target.dataset.messageItemId || target.dataset.messageTurnId)
    navigationFocusRef.current = null
    stream.scrollTo({
      top,
      behavior:
        navigationJump && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'smooth'
          : 'instant',
    })
    if (target.dataset.messageKind === 'user') target.focus({ preventScroll: true })
    updateScrollToBottomVisibility()
    set((current) => ({
      aiPanel: { ...current.aiPanel, messageFocus: null },
    }))
  }, [
    conv,
    followScroll,
    home,
    set,
    state.aiPanel,
    thread.resumeState,
    thread.sessionId,
    updateFocusSpacer,
    updateScrollToBottomVisibility,
  ])

  useLayoutEffect(() => {
    const stream = streamRef.current
    if (!stream) return
    const updatePadding = (): void => {
      stream.style.paddingInline = conversationInlinePadding(stream)
    }
    updatePadding()
    const observer = new ResizeObserver(updatePadding)
    observer.observe(stream)
    return () => observer.disconnect()
  }, [home])

  useEffect(() => {
    if (home || !columnRef.current) return () => undefined
    const observer = new ResizeObserver(() => {
      updateFocusSpacer()
      updateScrollToBottomVisibility()
      if (focusedSessionRef.current !== thread.sessionId) followScroll.request()
    })
    observer.observe(columnRef.current)
    if (streamRef.current) observer.observe(streamRef.current)
    return () => observer.disconnect()
  }, [followScroll, home, thread.sessionId, updateFocusSpacer, updateScrollToBottomVisibility])

  useEffect(() => {
    const stream = streamRef.current
    if (!stream || home) return () => undefined
    const scrollbar = createScrollbarVisibility(
      setScrollbarVisible,
      (callback, delay) => window.setTimeout(callback, delay),
      (timer) => window.clearTimeout(timer)
    )
    updateScrollToBottomVisibility()
    const onScroll = (): void => {
      scrollbar.scroll()
      updateScrollToBottomVisibility()
      if (resumeFollowOnScroll.current && !showScrollToBottomRef.current) followScroll.resume()
    }
    stream.addEventListener('scroll', onScroll, {
      passive: true,
    })
    window.addEventListener('resize', updateScrollToBottomVisibility)
    stream.addEventListener('pointerleave', scrollbar.hide)
    return () => {
      scrollbar.hide()
      stream.removeEventListener('pointerleave', scrollbar.hide)
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
    void getHistoryWithTodos(sessionId, 'transcript').then((history) => {
      if (!current || sessionRef.current !== sessionId || !history) return
      patchThread(thread.id, (active) =>
        active.sessionId === sessionId
          ? {
              conversation: projectHistorySnapshot(history, active.conversation, 'transcript'),
              planSnapshots: projectPlanSnapshots(history.activity_events, active.planSnapshots),
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
    if (thread.readOnly || !sessionId || busy) return t('stream.running')
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
            planSnapshots: [],
            turnOutcomes: {},
            turnTimings: {},
            backgroundTasks: {},
            running: false,
            status: 'done',
          }
        : {}
    )
    return null
  }

  // 切到新会话 (如创建资源开的新 session) → 整列以 key 重挂 + 入场动效, 平滑滑入而非生硬切换。
  const threadKey = thread.id
  const checkRecovery = async (): Promise<void> => {
    if (thread.readOnly || !thread.sessionId || recoveryChecking) return
    const requested = recoveryCheckIdentity(thread)
    setRecoveryChecking(true)
    const result = await checkSessionRecovery(thread.sessionId)
    setRecoveryChecking(false)
    const current = getSnapshot().threads[thread.id]
    if (!current || !recoveryCheckIsCurrent(current, requested)) return
    setFailedRecovery(result.ok ? null : requested)
    patchThread(thread.id, (active) =>
      recoveryCheckIsCurrent(active, requested) ? projectRecoveryCheck(result) : active
    )
    if (result.ok && current.resumeState === 'failed') requestSessionResume(thread.sessionId)
  }
  const scrollOverlap = scrollControlPlacement
    ? `calc(${scrollControlPlacement.size}px + var(--vds-space-2))`
    : undefined
  const scrollControl = showScrollToBottom ? (
    <Button
      unstyled
      type="button"
      className={cx(
        'z-[var(--vds-z-scroll-control)] grid size-[var(--vds-control-height-md)] cursor-pointer place-items-center rounded-[var(--vds-radius-6)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-2)_94%,transparent)] p-0 text-[var(--text-2)] shadow-[var(--vds-shadow-1-center)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]',
        scrollControlPlacement
          ? 'pointer-events-auto absolute top-0'
          : 'sticky bottom-[var(--vds-space-3)] mx-auto mb-[var(--vds-space-2)] mt-[calc(-1*(var(--vds-control-height-md)+var(--vds-space-4)))]'
      )}
      style={
        scrollControlPlacement
          ? {
              left: scrollControlPlacement.left,
              width: scrollControlPlacement.size,
              height: scrollControlPlacement.size,
            }
          : undefined
      }
      data-testid="scroll-to-bottom"
      data-scroll-control-inline={scrollControlPlacement ? true : undefined}
      aria-label={t('stream.bottom')}
      title={t('stream.bottom')}
      onClick={() => {
        followScroll.resume()
        scrollToBottom(window.matchMedia(REDUCED_MOTION_QUERY).matches ? 'auto' : 'smooth')
      }}
    >
      <span aria-hidden className="inline-grid rotate-180">
        <Icon name="send" size={18} sw={1.9} />
      </span>
    </Button>
  ) : null
  return (
    <div
      className={home ? 'contents' : 'relative flex min-h-0 min-w-0 flex-1'}
      data-scroll-control-overlay={scrollOverlap ? true : undefined}
      style={scrollOverlap ? { marginBottom: `calc(-1 * ${scrollOverlap})` } : undefined}
    >
      {!home &&
        thread.sessionId &&
        turnNavigationVisible(navigationTurns.length, navigationGutter) && (
          <nav
            ref={navigationRef}
            data-testid="turn-navigation"
            aria-label={t('stream.navigation.label')}
            className="absolute left-0 top-1/2 z-[var(--vds-z-scroll-control)] flex max-h-full w-[var(--vds-space-10)] -translate-y-1/2 flex-col overflow-y-auto overscroll-contain py-[var(--vds-space-2)] [scrollbar-width:none]"
            onMouseLeave={() => setHoveredNavigationIndex(null)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setHoveredNavigationIndex(null)
            }}
          >
            {navigationTurns.map((turn, index) => (
              <HoverCard
                key={turn.key}
                onOpenChange={(open) => {
                  if (open) setHoveredNavigationIndex(index)
                  else setHoveredNavigationIndex((current) => (current === index ? null : current))
                }}
              >
                <HoverCardContent
                  side="right"
                  className="!w-[var(--vds-tooltip-max-width)] overflow-hidden border border-[var(--vds-border-default)] !p-[var(--vds-space-2)] motion-reduce:!animate-none"
                >
                  <span className="grid min-w-0 max-w-[var(--vds-tooltip-max-width)] gap-[var(--vds-space-1)]">
                    <span className="sr-only">{t('stream.navigation.question', { text: '' })}</span>
                    <span
                      data-testid="turn-preview-question"
                      className="block truncate text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [font-weight:var(--vds-fw-regular)]"
                    >
                      {turn.question || t('stream.navigation.emptyQuestion')}
                    </span>
                    <span className="sr-only">{t('stream.navigation.answer', { text: '' })}</span>
                    <span
                      data-testid="turn-preview-answer"
                      className="line-clamp-3 whitespace-normal text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)] [font-weight:var(--vds-fw-regular)] [overflow-wrap:anywhere]"
                    >
                      <TurnAnswerSummary
                        text={turn.answer || t(TURN_NAVIGATION_STATE_MESSAGES[turn.state])}
                      />
                    </span>
                  </span>
                </HoverCardContent>
                <HoverCardTrigger asChild>
                  <Button
                    unstyled
                    type="button"
                    data-testid="turn-navigation-entry"
                    aria-label={t('stream.navigation.turn', { number: index + 1 })}
                    aria-current={currentNavigationKey === turn.key ? 'step' : undefined}
                    onMouseEnter={() => setHoveredNavigationIndex(index)}
                    onFocus={() => setHoveredNavigationIndex(index)}
                    className="group grid h-[var(--vds-space-3)] w-full shrink-0 items-center justify-items-start rounded-[var(--vds-radius-2)] pl-[var(--vds-space-3)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]"
                    onClick={() => {
                      navigationFocusRef.current = turn.key
                      set((current) => ({
                        aiPanel: {
                          ...current.aiPanel,
                          messageFocus: {
                            sessionId: thread.sessionId!,
                            turnId: turn.turnId,
                            itemId: turn.itemId,
                          },
                        },
                      }))
                    }}
                  >
                    <span
                      aria-hidden="true"
                      data-proximity={turnMarkerProximity(index, hoveredNavigationIndex)}
                      className={cx(
                        'h-[var(--vds-border-width-2)] w-[calc(var(--vds-space-1)+var(--vds-space-half))] rounded-full transition-[width,background-color] duration-[var(--vds-duration-normal)] ease-[var(--vds-ease-standard)] motion-reduce:transition-none data-[proximity=outer]:w-[calc(var(--vds-space-2)+var(--vds-space-half))] data-[proximity=far]:w-[calc(var(--vds-space-3)+var(--vds-space-half))] data-[proximity=near]:w-[var(--vds-space-5)] data-[proximity=focused]:w-[calc(var(--vds-space-6)+var(--vds-space-half))] data-[proximity=focused]:!bg-[var(--vds-icon-fill-default)] group-focus-visible:!bg-[var(--vds-icon-fill-default)]',
                        visibleNavigationKeys.includes(turn.key)
                          ? 'bg-[var(--vds-icon-fill-default)]'
                          : 'bg-[var(--vds-border-default)]'
                      )}
                    />
                  </Button>
                </HoverCardTrigger>
              </HoverCard>
            ))}
          </nav>
        )}
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
          home ? 'pt-0' : 'pt-[var(--vds-space-4)]',
          scrollOverlap &&
            '[mask-image:linear-gradient(to_bottom,black_calc(100%_-_2*var(--vds-space-8)),transparent)]',
          scrollbarVisible
            ? '[scrollbar-color:var(--vds-scrollbar-thumb)_transparent] [&::-webkit-scrollbar-thumb]:bg-[var(--vds-scrollbar-thumb)]'
            : '[scrollbar-color:transparent_transparent] [&::-webkit-scrollbar-thumb]:bg-transparent'
        )}
        style={{
          flex: home ? 'none' : 1,
          minHeight: 0,
          overflowY: home ? 'visible' : 'auto',
          paddingInline: 'var(--vds-space-4)',
          paddingBottom: home ? '8px' : '10px',
          userSelect: 'text',
          WebkitUserSelect: 'text',
          cursor: 'auto',
        }}
      >
        <CopySessionContext.Provider value={thread.sessionId ?? ''}>
          <CopyItemsContext.Provider value={currentConv}>
            {turnAnnouncementKey && (
              <div role="status" aria-live="polite" className="sr-only">
                {t(turnAnnouncementKey)}
              </div>
            )}
            <div
              ref={columnRef}
              key={threadKey}
              className={cx(
                READING_COLUMN_CLASS,
                '[font-family:var(--vds-font-main)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]'
              )}
              data-testid="conversation-content"
              style={{ animation: 'overlayIn .32s cubic-bezier(.4,0,.2,1) both' }}
            >
              {thread.recoveryBlocked && !home && (
                <Alert
                  layout="stacked"
                  data-testid="session-recovery-blocked"
                  data-recovery-session-id={thread.sessionId}
                  data-recovery-incident-id={thread.recoveryIncidentId ?? undefined}
                  tone="warning"
                  className="mb-[var(--vds-space-4)]"
                  title={t('stream.recoveryBlocked')}
                  description={t(
                    recoveryError ? 'stream.recoveryCheckFailed' : 'stream.recoveryBlockedDetail'
                  )}
                  action={
                    <Button
                      data-testid="session-recovery-check"
                      size="sm"
                      variant="outline"
                      disabled={thread.readOnly || recoveryChecking}
                      loading={recoveryChecking}
                      onClick={() => void checkRecovery()}
                    >
                      {t('stream.recoveryCheck')}
                    </Button>
                  }
                />
              )}
              {conv.length === 0 &&
                (thread.resumeState === 'pending' ? <Loading /> : <Empty home={home} />)}
              {sections.map((section, sectionIndex) => {
                const sectionTurn = section.kind === 'row' ? rowTurnId(section.row) : section.turnId
                const nextSection = sections[sectionIndex + 1]
                const nextTurn =
                  nextSection?.kind === 'row' ? rowTurnId(nextSection.row) : nextSection?.turnId
                const inheritedFailure =
                  sectionTurn && sectionTurn !== nextTurn && inheritedFailures.has(sectionTurn)
                const missingAnswer = inheritedFailure ? (
                  <Alert
                    tone="warning"
                    layout="inline"
                    role="status"
                    className="mb-[var(--vds-space-3)] w-full"
                    data-testid="fork-history-failure"
                    description={conversation('failure.interrupted.message')}
                  />
                ) : sectionTurn &&
                  sectionTurn !== nextTurn &&
                  isEmptyTurn(thread, sectionTurn) &&
                  !conv.some((item) => item.kind === 'agent' && item.turnId === sectionTurn) ? (
                  <EmptyTurn key={`empty:${sectionTurn}`} turnId={sectionTurn} />
                ) : null
                const renderRow = (row: ActivityRow, index: number): React.ReactNode => {
                  const previous = rows[index - 1]
                  const next = rows[index + 1]
                  if (
                    row.kind === 'item' &&
                    row.item.turnId &&
                    isUserStoppedStatus(row.item) &&
                    turnsWithFinalAgent.has(row.item.turnId)
                  )
                    return null
                  const stoppedNotice =
                    finalAgentRows.has(index) && row.kind === 'item' && row.item.turnId
                      ? stoppedNotices.get(row.item.turnId)
                      : undefined
                  const attachedArtifacts =
                    row.kind === 'item' &&
                    row.item.kind === 'agent' &&
                    next?.kind === 'artifacts' &&
                    next.turnId === row.item.turnId &&
                    !sharesArtifactRow(index + 1, index + 2)
                      ? next
                      : undefined
                  if (
                    row.kind === 'artifacts' &&
                    previous?.kind === 'item' &&
                    previous.item.kind === 'agent' &&
                    previous.item.turnId === row.turnId &&
                    !sharesArtifactRow(index, index + 1)
                  )
                    return null
                  if (row.kind === 'activity')
                    return (
                      <ActivityRun
                        key={row.key}
                        agentIdentities={agentIdentities}
                        items={row.items}
                        turnId={row.turnId}
                        tail={row.tail}
                        outcome={row.turnId ? thread.turnOutcomes?.[row.turnId] : undefined}
                        timing={row.turnId ? thread.turnTimings?.[row.turnId] : undefined}
                      />
                    )
                  if (row.kind === 'artifacts')
                    return <ArtifactCard key={row.key} items={row.items} turnId={row.turnId} />
                  return (
                    <div
                      key={row.key}
                      className={
                        row.item.kind === 'user'
                          ? cx(
                              'outline-none focus-visible:shadow-[var(--vds-focus-brand)]',
                              index > 0 && 'mt-[var(--vds-space-10)]'
                            )
                          : 'contents'
                      }
                      tabIndex={row.item.kind === 'user' ? -1 : undefined}
                      data-message-turn-id={row.item.turnId || undefined}
                      data-message-item-id={row.item.itemId || undefined}
                      data-message-kind={row.item.kind}
                    >
                      <Item
                        item={row.item}
                        skillNames={skillNames}
                        awaitingConfirmation={pendingTurnIds.has(row.item.turnId)}
                        latestAgent={index === latestAgentRow}
                        finalAnswer={finalAgentRows.has(index)}
                        sourcesContent={
                          finalAgentRows.has(index) && row.item.turnId
                            ? renderTurnSources(row.item.turnId)
                            : undefined
                        }
                        trailingContent={
                          attachedArtifacts || stoppedNotice ? (
                            <>
                              {attachedArtifacts && (
                                <ArtifactCard
                                  items={attachedArtifacts.items}
                                  turnId={attachedArtifacts.turnId}
                                />
                              )}
                              {stoppedNotice && <StatusLine item={stoppedNotice} />}
                            </>
                          ) : undefined
                        }
                        running={busy}
                        turnOutcome={
                          row.item.turnId ? thread.turnOutcomes?.[row.item.turnId] : undefined
                        }
                        turnTiming={
                          (finalAgentRows.has(index) || row.item.kind === 'user') &&
                          row.item.turnId &&
                          (row.item.kind === 'agent' ||
                            !processes.some((process) => process.turnId === row.item.turnId))
                            ? thread.turnTimings?.[row.item.turnId]
                            : undefined
                        }
                        onRewind={rewindPrompt}
                        onContinue={continueTurn}
                        onOpenDelivery={onOpenDelivery}
                      />
                      {row.item.kind !== 'interaction_reply' &&
                        row.item.turnId &&
                        thread.turnOutcomes?.[row.item.turnId] !== 'running' && (
                          <CardOnlyReplyCopy item={row.item} />
                        )}
                    </div>
                  )
                }
                const renderForkRow = (
                  row: ActivityRow,
                  index: number,
                  groupedArtifacts = false
                ): React.ReactNode => {
                  const turnId = rowTurnId(row)
                  const timing =
                    fallbackDurations.has(index) &&
                    turnId &&
                    !processes.some((process) => process.turnId === turnId)
                      ? thread.turnTimings?.[turnId]
                      : undefined
                  const content = renderRow(row, index)
                  const footer = (
                    <>
                      {turnId &&
                        !turnsWithFinalAgent.has(turnId) &&
                        !rows
                          .slice(index + 1)
                          .some((candidate) => rowTurnId(candidate) === turnId) &&
                        renderTurnSources(turnId)}
                      {timing?.completedAt !== undefined && <TurnDuration timing={timing} />}
                    </>
                  )
                  return (
                    <React.Fragment key={row.key}>
                      {index === forkBoundary ? (
                        groupedArtifacts ? (
                          <div className="col-span-full">{forkDivider}</div>
                        ) : (
                          forkDivider
                        )
                      ) : null}
                      {groupedArtifacts && row.kind === 'item' ? (
                        <div className={ARTIFACT_ROW_ITEM_CLASS}>{content}</div>
                      ) : (
                        content
                      )}
                      {groupedArtifacts ? (
                        <div className="col-span-full empty:hidden">{footer}</div>
                      ) : (
                        footer
                      )}
                    </React.Fragment>
                  )
                }
                if (section.kind === 'row') {
                  if (sharesArtifactRow(section.index - 1, section.index)) return missingAnswer
                  if (sharesArtifactRow(section.index, section.index + 1)) {
                    const cards = [renderForkRow(section.row, section.index, true)]
                    let index = section.index
                    while (sharesArtifactRow(index, index + 1)) {
                      index += 1
                      cards.push(renderForkRow(rows[index], index, true))
                    }
                    return (
                      <div
                        key={section.row.key}
                        className={cx(ARTIFACT_ROWS_CLASS, '[&_[data-artifact-list]]:contents')}
                      >
                        {cards}
                      </div>
                    )
                  }
                  return (
                    <React.Fragment key={section.row.key}>
                      {renderForkRow(section.row, section.index)}
                      {missingAnswer}
                    </React.Fragment>
                  )
                }
                const focus = state.aiPanel.messageFocus
                const reveal =
                  focus?.sessionId === thread.sessionId &&
                  matchingAttentionAnchors(
                    section.entries.flatMap((entry) =>
                      entry.row.kind === 'item'
                        ? [
                            {
                              messageItemId: entry.row.item.itemId,
                              messageTurnId: entry.row.item.turnId,
                              messageKind: entry.row.item.kind,
                            },
                          ]
                        : []
                    ),
                    focus
                  ).length > 0
                return (
                  <React.Fragment key={section.key}>
                    <TurnProcess
                      key={section.key}
                      statusOwner={section.statusOwner}
                      process={{
                        turnId: section.turnId,
                        rows: section.entries.map((entry) => entry.row),
                        indices: section.entries.map((entry) => entry.index),
                      }}
                      agentIdentities={agentIdentities}
                      outcome={thread.turnOutcomes?.[section.turnId]}
                      timing={thread.turnTimings?.[section.turnId]}
                      reveal={reveal}
                    />
                    {missingAnswer}
                  </React.Fragment>
                )
              })}
              {forkBoundary === rows.length && forkDivider}
              {resourceProject && thread.sessionId && (
                <Finalizations
                  key={`${resourceProject.id}:${thread.sessionId}`}
                  project={resourceProject.id}
                  sessionId={thread.sessionId}
                  running={busy}
                  revision={thread.lastSeq}
                />
              )}
              {showWorking && (
                <Working
                  waiting={thread.status === 'waiting'}
                  recovering={thread.readiness?.process_state === 'recovering'}
                />
              )}
              <div ref={endRef} />
              <div ref={focusSpacerRef} aria-hidden="true" />
              {scrollOverlap && <div aria-hidden="true" style={{ height: scrollOverlap }} />}
            </div>
          </CopyItemsContext.Provider>
        </CopySessionContext.Provider>
        {scrollControlPlacement && scrollControlTarget
          ? createPortal(scrollControl, scrollControlTarget)
          : scrollControl}
      </div>
    </div>
  )
}

/** A pending confirmation occupies the conversation's input position. */
export function PendingHilDock({
  floating = false,
  adjacentComposer = false,
}: {
  floating?: boolean
  adjacentComposer?: boolean
} = {}): React.JSX.Element | null {
  const { state } = useApp()
  const interactionPolicies = useInteractionPolicies()
  const thread = activeThread(state)
  const confirmations = pendingConversationConfirmations(thread)
  const interactions =
    confirmations.length > 0 || floating || thread.readOnly
      ? confirmations
      : pendingHilItems(thread.conversation)
  const focus = state.aiPanel.messageFocus
  const requestedId = focus?.sessionId === thread.sessionId ? focus.requestId : null
  const [selected, setSelected] = useState<{ sessionId: string | null; requestId: string } | null>(
    null
  )
  useEffect(() => {
    if (requestedId) setSelected({ sessionId: thread.sessionId, requestId: requestedId })
    else setSelected((current) => (current?.sessionId === thread.sessionId ? current : null))
  }, [requestedId, thread.sessionId])
  const interaction = attentionRequest(
    interactions,
    requestedId ?? (selected?.sessionId === thread.sessionId ? selected.requestId : null)
  )
  const attached = Boolean(
    interaction &&
    isQuestionHil(interaction) &&
    interactionPolicies.find((policy) => policy.matches(interaction.questions ?? []))
      ?.composerAttached
  )
  if (!interaction) return null
  return (
    <div
      className={cx(
        'relative flex min-h-0 flex-[1_1_auto] flex-col overflow-hidden bg-transparent',
        !floating && 'px-[var(--vds-conversation-inline-gutter)] pt-[var(--vds-space-2)]',
        adjacentComposer
          ? 'z-[var(--vds-z-local-top)]'
          : attached
            ? 'z-auto pb-[var(--vds-space-2)]'
            : isQuestionHil(interaction)
              ? 'z-[var(--vds-z-local-top)] pb-[var(--vds-space-3)]'
              : 'z-[var(--vds-z-local-top)] pb-[var(--vds-space-1)]'
      )}
      data-testid="hil-dock"
      data-hil-attached={attached || undefined}
    >
      <div className={cx(READING_COLUMN_CLASS, '@container flex min-h-0 flex-1 flex-col')}>
        <BrowserAwareHilCard
          key={interaction.requestId}
          item={interaction}
          presentation="dock"
          queueCount={interactions.length}
        />
      </div>
    </div>
  )
}

export function ConversationControls({
  children,
  externalConfirmation = false,
  floatingComposer = false,
}: {
  children: React.ReactNode
  externalConfirmation?: boolean
  floatingComposer?: boolean
}): React.JSX.Element {
  const { state } = useApp()
  const thread = activeThread(state)
  const interactionPolicies = useInteractionPolicies()
  const confirmations = pendingConversationConfirmations(thread)
  const installations = thread.readOnly ? [] : thread.conversation.filter(isDockedInstallation)
  const hasPendingHil = confirmations.length > 0
  const hasInstallations = installations.length > 0
  const requiresCard = confirmations.some(
    (item) =>
      !isQuestionHil(item) ||
      interactionPolicies.some(
        (policy) => policy.directDecision && policy.matches(item.questions ?? [])
      )
  )
  return (
    // 禁 overflow-hidden: composer 的 @/技能弹层是 absolute 向上弹出、会超出本容器盒子被裁成一条边; 高度收敛靠 composer 内部限高滚动。
    <div
      className={cx(
        'vds-ai-composer-host flex min-h-0 max-h-full flex-[0_1_auto] flex-col px-[var(--vds-conversation-scrollbar-width)] has-[[data-scroll-control-inline]]:pointer-events-none',
        (hasPendingHil || hasInstallations) && 'max-h-3/4',
        hasPendingHil &&
          'has-[[data-clarification-paged=true]]:max-h-full [&_[data-testid=todo-panel]]:hidden'
      )}
    >
      {hasInstallations && (
        <ScrollArea
          data-scroll-control-displaced=""
          className={cx(
            'grid min-h-0 grid-rows-[minmax(0,1fr)]',
            !floatingComposer && 'px-[var(--vds-conversation-inline-gutter)]'
          )}
          viewportClassName="min-h-0"
        >
          <div
            className={cx(
              READING_COLUMN_CLASS,
              '@container flex flex-col gap-[var(--vds-space-2)] pt-[var(--vds-space-2)]',
              floatingComposer && 'pb-[var(--vds-space-2)]'
            )}
          >
            {installations.map((item) => (
              <BrowserAwareHilCard key={item.requestId} item={item} presentation="dock" />
            ))}
          </div>
        </ScrollArea>
      )}
      {!externalConfirmation && (
        <PendingHilDock adjacentComposer={hasPendingHil && !floatingComposer} />
      )}
      <ComposerConfirmationContext.Provider value={{ pending: requiresCard }}>
        <div
          className={cx(
            floatingComposer && hasPendingHil
              ? 'hidden'
              : 'flex min-h-0 max-h-full flex-[0_1_auto] flex-col',
            (hasPendingHil || hasInstallations) && 'shrink-0'
          )}
        >
          {children}
        </div>
      </ComposerConfirmationContext.Provider>
    </div>
  )
}

/** 「书深正在思考」脉冲指示（后台运行但前台尚无消息时的状态动态）。 */
function Working({
  waiting,
  recovering,
}: {
  waiting: boolean
  recovering: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const label = recovering
    ? t('stream.recovering')
    : waiting
      ? t('stream.waiting')
      : t('stream.thinking')
  return (
    <div
      className="mb-[var(--vds-space-5)] flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-stream-content-line-height)] text-[var(--vds-text-secondary)]"
      role="status"
      data-testid="assistant-working"
    >
      {waiting ? (
        <Icon name="schedule" size={14} />
      ) : (
        <Spinner
          imageSrc={aiThinking}
          size="sm"
          className="!size-[var(--vds-icon-8)]"
          aria-hidden="true"
        />
      )}
      <span>{label}</span>
    </div>
  )
}

function Loading(): React.JSX.Element {
  return (
    <div
      data-testid="conversation-loading"
      aria-hidden="true"
      className="grid gap-[var(--vds-space-6)] py-[var(--vds-space-4)]"
    >
      <div className="ml-auto grid w-3/5 gap-[var(--vds-space-2)]">
        <Skeleton height="var(--vds-space-6)" />
        <Skeleton width="70%" />
      </div>
      <div className="grid gap-[var(--vds-space-3)]">
        <Skeleton width="30%" />
        <Skeleton />
        <Skeleton width="90%" />
        <Skeleton width="75%" />
      </div>
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
        color: 'var(--text-3)',
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
          marginBottom: 14,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--accent)',
          }}
        />
        <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{t('stream.newWorkspace')}</span>
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 18,
          color: 'var(--text-2)',
          marginBottom: 6,
        }}
      >
        {t('stream.start')}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.7 }}>{t('stream.startHint')}</div>
    </div>
  )
}

function Item({
  item,
  skillNames,
  awaitingConfirmation,
  latestAgent,
  finalAnswer,
  sourcesContent,
  trailingContent,
  running,
  turnOutcome,
  turnTiming,
  onRewind,
  onContinue,
  onOpenDelivery,
}: {
  item: ConvItem
  skillNames: SkillNames
  awaitingConfirmation: boolean
  latestAgent: boolean
  finalAnswer: boolean
  sourcesContent?: React.ReactNode
  trailingContent?: React.ReactNode
  running: boolean
  turnOutcome?: TurnOutcome
  turnTiming?: TurnTiming
  onRewind: (anchor: number) => Promise<string | null>
  onContinue: (item: Extract<ConvItem, { kind: 'error' }>) => Promise<void>
  onOpenDelivery?: (member: DeliveryCardMember) => void
}): React.JSX.Element | null {
  const { state } = useApp()
  const readOnly = activeThread(state).readOnly
  const { t: conversation } = useTranslation('conversation')
  const interactions = answerInteractionCapabilities(turnOutcome)
  switch (item.kind) {
    case 'day':
      return <Day text={item.text} />
    case 'prompt':
      return <PromptCard text={item.text} />
    case 'reentry':
      return <Reentry item={item} />
    case 'user':
      return (
        <UserBubble
          item={item}
          skillNames={skillNames}
          running={running}
          onRewind={onRewind}
          sentAt={item.startedAt ?? (!item.steer ? turnTiming?.startedAt : undefined)}
        />
      )
    case 'interaction_reply':
      return (
        <InteractionReply
          item={item}
          copyAction={
            item.turnId && turnOutcome !== 'running' ? <CardOnlyReplyCopy item={item} /> : undefined
          }
        />
      )
    case 'agent':
      return (
        <AgentMsg
          latest={latestAgent}
          compact={turnOutcome === 'completed' && !finalAnswer}
          citationEnabled={interactions.citationEnabled}
          copyEnabled={
            !awaitingConfirmation &&
            turnOutcome !== 'running' &&
            (turnOutcome !== 'completed' || finalAnswer)
          }
          forkEnabled={
            finalAnswer &&
            !awaitingConfirmation &&
            interactions.forkEnabled &&
            !readOnly &&
            turnOutcome === 'completed'
          }
          item={item}
          sourcesContent={sourcesContent}
          trailingContent={trailingContent}
          selectionEnabled={!readOnly && interactions.selectionEnabled}
          timing={awaitingConfirmation ? undefined : turnTiming}
        />
      )
    case 'delivery':
      return <DeliveryCard item={item} onOpen={onOpenDelivery} />
    case 'artifact':
      return <ArtifactCard items={[item]} turnId={item.turnId} />
    case 'generation_preview':
      return (
        <section
          aria-label={conversation('generationPreview.label')}
          data-testid="generation-preview"
          data-preview-id={item.preview.preview_id}
          data-preview-status={item.preview.status}
          className="mb-[var(--vds-space-5)] min-w-0 rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)]"
        >
          <div
            role="status"
            className="mb-[var(--vds-space-3)] flex flex-wrap items-center gap-[var(--vds-space-2)]"
          >
            <Tag size="small" tone="neutral">
              {conversation(GENERATION_PREVIEW_STATUS_KEYS[item.preview.status])}
            </Tag>
            <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
              {conversation('generationPreview.unverified')}
            </span>
          </div>
          {item.preview.blocks.length ? (
            item.preview.blocks.map((block) => (
              <Markdown
                key={block.id}
                text={
                  block.kind === 'heading1'
                    ? `# ${block.text}`
                    : block.kind === 'heading2'
                      ? `## ${block.text}`
                      : block.text
                }
                math
                className="!text-[length:var(--vds-font-body-lv2)]"
              />
            ))
          ) : item.preview.status === 'streaming' ? (
            <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {conversation('generationPreview.waiting')}
            </p>
          ) : null}
        </section>
      )
    case 'review':
      return <ReviewCard review={item.review} />
    case 'display_card':
      return <DisplayCardView card={item.card} turnId={item.turnId} />
    case 'thinking':
      return (
        <Thinking
          text={item.text}
          itemId={item.itemId}
          selectionEnabled={!readOnly && interactions.selectionEnabled}
        />
      )
    case 'status':
      return <StatusLine item={item} />
    case 'notice':
      return (
        <NoticeLine text={item.text} message={item.message} displayMessage={item.displayMessage} />
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
      return <BrowserAwareHilCard item={item} />
    default:
      return <></>
  }
}

function DeliveryCard({
  item,
  onOpen,
}: {
  item: Extract<ConvItem, { kind: 'delivery' }>
  onOpen?: (member: DeliveryCardMember) => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { delivery } = item
  const primary = delivery.members.find((member) => member.primary) ?? delivery.members[0]
  const label = deliveryLabel(delivery, conversation)
  const previewTarget =
    delivery.members.find((member) => member.primary && member.previewAvailable) ??
    delivery.members.find((member) => member.previewAvailable)
  const revision = primary?.revision.replace('sha256:', '').slice(0, 9) ?? ''
  const meta = primary ? `${primary.workspacePath} · ${revision}` : t('stream.noArtifacts')
  const open = (): void => {
    if (!previewTarget || (!previewTarget.materialId && !previewTarget.workspacePath)) return
    onOpen?.(previewTarget)
  }
  const description = primary
    ? `${t('stream.registered', { count: delivery.members.length })} · ${meta}`
    : meta
  return (
    <Card
      padding="none"
      variant="flat"
      className="my-[var(--vds-space-3)] box-border flex h-[var(--vds-artifact-card-height)] items-center gap-[var(--vds-space-2)] !border-[var(--vds-divider-default)] !bg-[var(--vds-artifact-card-bg)] px-[var(--vds-card-padding-sm)]"
      data-testid="delivery-card"
    >
      <span className={cx(ARTIFACT_ICON_CLASS, ARTIFACT_OUTLINE_ICON_CLASS)} aria-hidden>
        <Icon name="artifacts" />
      </span>
      <div className="min-w-0 flex-1">
        <EllipsisText className={ARTIFACT_TITLE_CLASS} tooltipPortalled>
          {label}
        </EllipsisText>
        <EllipsisText className={ARTIFACT_DESCRIPTION_CLASS} tooltipPortalled>
          {description}
        </EllipsisText>
      </div>
      {previewTarget && onOpen && <ArtifactOpenButton onOpen={open} />}
    </Card>
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
  if (item.name !== 'Skill' || !item.input || typeof item.input !== 'object') return null
  const skillName = (item.input as { skill?: unknown }).skill
  return typeof skillName === 'string' && skillName.trim() ? skillName.trim() : null
}

function toolLabel(item: ToolItem, t: TFunction<'conversation'>): string {
  const skillName = loadedSkillName(item)
  const key = TOOL_ACTION_LABELS[activityAction(item)]
  if (skillName) return t('toolActions.skill', { name: skillName })
  return key ? t(key) : normalizeToolName(item.name)
}

const TOOL_ACTION_LABELS: Partial<
  Record<
    ActivityAction,
    'toolActions.command' | 'toolActions.read' | 'toolActions.edit' | 'toolActions.image'
  >
> = {
  command: 'toolActions.command',
  read: 'toolActions.read',
  edit: 'toolActions.edit',
  image: 'toolActions.image',
}

const TOOL_SUMMARY_FIELDS = ['command', 'cmd', 'file_path', 'path', 'filename'] as const

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

function latestRunningSearch(items: WebSearchItem[]): WebSearchItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function latestRunningPaperSearch(items: PaperSearchItem[]): PaperSearchItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function latestRunningNativeActivity(items: NativeActivityItem[]): NativeActivityItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'running') return items[index]
  }
  return undefined
}

function nativeActivityLabel(item: NativeActivityItem, t: TFunction<'components'>): string {
  if (item.activityType === 'hook_prompt') return t(NATIVE_ACTIVITY_LABELS.hook_prompt)
  if (item.activityType === 'plan') return t(NATIVE_ACTIVITY_LABELS.plan)
  if (item.activityType === 'agent_collaboration')
    return t(NATIVE_ACTIVITY_LABELS.agent_collaboration)
  if (item.activityType === 'subagent_activity') return t(NATIVE_ACTIVITY_LABELS.subagent_activity)
  if (item.activityType === 'image_view') return t(NATIVE_ACTIVITY_LABELS.image_view)
  if (item.activityType === 'wait') return t(NATIVE_ACTIVITY_LABELS.wait)
  if (item.activityType === 'image_generation') return t(NATIVE_ACTIVITY_LABELS.image_generation)
  if (item.activityType === 'approval_review') return t(NATIVE_ACTIVITY_LABELS.approval_review)
  if (item.activityType === 'approval_strict_review')
    return t(NATIVE_ACTIVITY_LABELS.approval_strict_review)
  if (item.activityType === 'review_entered') return t(NATIVE_ACTIVITY_LABELS.review_entered)
  if (item.activityType === 'review_exited') return t(NATIVE_ACTIVITY_LABELS.review_exited)
  if (item.activityType === 'runtime_activity') return t(NATIVE_ACTIVITY_LABELS.runtime_activity)
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
  | 'approval'
  | 'other'

// 机器自动审批（含升级成严格复核）与普通工具活动混在 category=mode 里，靠活动类型区分，
// 否则折叠行全部退化成同一个齿轮图标，用户看不出这一行是权限裁决。
const APPROVAL_ACTIVITY_TYPES = new Set(['approval_review', 'approval_strict_review'])

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
  approval: 'shield',
  other: 'gear',
}

function activityAction(item: ActivityItem): ActivityAction {
  if (item.kind === 'thinking') return 'thinking'
  if (item.kind === 'web_search') return 'web'
  if (item.kind === 'paper_search') return 'paper'
  if (item.kind === 'skill') return 'skill'
  if (item.kind === 'native_activity') {
    if (APPROVAL_ACTIVITY_TYPES.has(item.activityType)) return 'approval'
    if (item.activityType === 'image_view' || item.category === 'media') return 'image'
    if (item.category === 'collaboration') return 'collaboration'
    if (item.category === 'wait') return 'wait'
    return 'other'
  }
  const name = normalizeToolName(item.name).toLowerCase()
  if (name === 'file_change' || name.includes('apply_patch')) return 'edit'
  if (name === 'read') return 'read'
  if (name.includes('view_image') || name.includes('image')) return 'image'
  if (name === 'bash' || name === 'shell' || name.includes('exec_command')) return 'command'
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
          approval: 'stream.action.running.approval',
          other: 'stream.action.running.other',
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
          approval: 'stream.action.error.approval',
          other: 'stream.action.error.other',
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
        approval: 'stream.action.done.approval',
        other: 'stream.action.done.other',
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
    const status = group.some((item) => 'status' in item && item.status === 'running')
      ? 'running'
      : group.some(
            (item) =>
              'status' in item &&
              item.status === 'error' &&
              !(item.kind === 'tool' && item.recoveredBy)
          )
        ? 'error'
        : 'done'
    return activityActionLabel(action, group.length, status, t)
  })
  const firstAction = groups.keys().next().value ?? 'other'
  return {
    icon: ACTIVITY_ACTION_ICONS[firstAction],
    label: labels.join(' · '),
    running: items.some((item) => 'status' in item && item.status === 'running'),
    failed: items.some(
      (item) =>
        'status' in item && item.status === 'error' && !(item.kind === 'tool' && item.recoveredBy)
    ),
  }
}

function webSearchActionLabel(item: WebSearchItem, t: TFunction<'components'>): string {
  if (item.action.purpose?.trim()) return item.action.purpose
  if (item.action.type === 'openPage') return t('stream.web.openPage')
  if (item.action.type === 'findInPage') return t('stream.web.findInPage')
  return t('stream.web.search')
}

// Consecutive tool calls are a rendering projection, not a transcript mutation.
// The outer group owns the noisy list; each step still keeps its own input/output
// disclosure for users who need the exact call evidence.
function TurnProcess({
  process,
  statusOwner,
  agentIdentities,
  outcome,
  timing,
  reveal,
}: {
  process: ExecutionProcessData
  statusOwner: boolean
  agentIdentities: ReadonlyMap<string, string | number>
  outcome?: TurnOutcome
  timing?: TurnTiming
  reveal?: boolean
}): React.JSX.Element {
  const { state: appState } = useApp()
  const focus = appState.aiPanel.messageFocus
  const focused =
    reveal ||
    (focus?.kind === 'progress' && focus.turnId === process.turnId && Boolean(focus.itemId))
  return (
    <ExecutionProcess
      outcome={outcome}
      statusOwner={statusOwner}
      turnId={process.turnId}
      reveal={focused}
      timing={timing}
    >
      {process.rows.map((row) =>
        row.kind === 'activity' ? (
          <ActivityRun
            key={row.key}
            items={row.items}
            agentIdentities={agentIdentities}
            turnId={process.turnId}
            tail={row.tail}
            outcome={outcome}
            timing={timing}
          />
        ) : row.kind === 'item' && row.item.kind === 'thinking' ? (
          <Markdown
            key={row.key}
            text={row.item.text}
            math
            className="!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-lh-body-lv2)] !text-[var(--vds-text-primary)]"
          />
        ) : null
      )}
    </ExecutionProcess>
  )
}

function ActivityRun({
  items,
  agentIdentities = subagentIdentities(items),
  turnId,
  tail = true,
  outcome,
  timing,
}: {
  items: ActivityItem[]
  agentIdentities?: ReadonlyMap<string, string | number>
  turnId?: string
  tail?: boolean
  outcome?: TurnOutcome
  timing?: TurnTiming
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const [now, setNow] = useState(Date.now())
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool')
  const searches = items.filter((item): item is WebSearchItem => item.kind === 'web_search')
  const paperSearches = items.filter(
    (item): item is PaperSearchItem => item.kind === 'paper_search'
  )
  const skills = items.filter((item): item is SkillActivityItem => item.kind === 'skill')
  const nativeActivities = items.filter(
    (item): item is NativeActivityItem => item.kind === 'native_activity'
  )
  const runningTool = latestRunningTool(tools)
  const runningSearch = latestRunningSearch(searches)
  const runningPaperSearch = latestRunningPaperSearch(paperSearches)
  const runningSkill = skills.find((item) => item.status === 'running')
  const runningNative = latestRunningNativeActivity(nativeActivities)
  const itemRunning = Boolean(
    runningTool || runningSearch || runningPaperSearch || runningSkill || runningNative
  )
  const itemCompleted = items.some((item) => 'status' in item && item.status === 'done')
  const runState = activityRunState(
    runningTool?.retryOf ? 'running' : outcome,
    itemRunning,
    itemCompleted,
    tail
  )
  const running = runState === 'running'
  const { state: appState } = useApp()
  const focusedItemId =
    appState.aiPanel.messageFocus?.kind === 'progress'
      ? appState.aiPanel.messageFocus.itemId
      : undefined
  const focused = tools.some((item) => item.toolId === focusedItemId)
  const expanded = focused || activityDisclosureOpen(userExpanded, running)
  useEffect(() => {
    if (focused) setUserExpanded(true)
  }, [focused])
  const visibleThinking = visibleThinkingItem(items, running, tail)
  useEffect(() => {
    if (!running) return () => undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), ACTIVITY_ELAPSED_TICK_MS)
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
  const toolCount = tools.length + searches.length + paperSearches.length + skills.length
  // The group's own item timing is the truth for its duration. Turn timing only
  // fills the live group or the final group without tools.
  const useTurnTiming = running || (!toolCount && tail)
  const startedAt = itemStartedAt ?? (useTurnTiming ? timing?.startedAt : undefined)
  const completedAt = itemCompletedAt ?? (useTurnTiming ? timing?.completedAt : undefined)
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
  const state = activitySummaryState(runState, stateLabel, taskDuration, t)
  const presentation = activityLinePresentation(items, t)
  const lineLabel = toolCount
    ? running
      ? t('stream.executing')
      : t('stream.toolsExecuted', { count: toolCount })
    : running
      ? t('stream.processing')
      : t('stream.processed')
  const accessibleState = state || (running && !toolCount ? stateLabel : '')
  return (
    <ExecutionBatch
      label={lineLabel}
      state={state}
      expanded={expanded}
      onExpandedChange={setUserExpanded}
      turnId={turnId}
      failureCount={
        tools.filter(
          (item) =>
            item.status === 'error' && !item.recoveredBy && commandOutcome(item) !== 'noMatches'
        ).length
      }
      failed={hasFailure || presentation.failed}
      running={running || presentation.running}
      accessibleLabel={
        accessibleState
          ? t('stream.activityLabel', { label: lineLabel, state: accessibleState })
          : lineLabel
      }
      title={state ? `${presentation.label} · ${state}` : presentation.label}
    >
      {items.map((item, index) => {
        if (item.kind === 'thinking') {
          return (
            <ThinkingActivityStep
              key={activityIdentity(item, index)}
              item={item}
              groupOpen={expanded}
              autoExpand={item === visibleThinking}
            />
          )
        }
        if (item.kind === 'web_search') {
          return <WebSearchStep key={item.searchId} item={item} groupOpen={expanded} />
        }
        if (item.kind === 'paper_search') {
          return <PaperSearchStep key={item.searchId} item={item} groupOpen={expanded} />
        }
        if (item.kind === 'skill') {
          return <SkillActivityStep key={item.skillId} item={item} groupOpen={expanded} />
        }
        if (item.kind === 'native_activity') {
          return (
            <NativeActivityStep
              key={item.activityId}
              agentIdentity={agentIdentities.get(item.activityId)}
              item={item}
              groupOpen={expanded}
              now={now}
            />
          )
        }
        return <ToolStep key={item.toolId} item={item} groupOpen={expanded} now={now} />
      })}
    </ExecutionBatch>
  )
}

function ThinkingActivityStep({
  item,
  groupOpen,
  autoExpand,
  selectionEnabled = true,
}: {
  item: ThinkingActivityItem
  groupOpen: boolean
  autoExpand: boolean
  selectionEnabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const open = activityDisclosureOpen(userExpanded, autoExpand)
  const active = autoExpand && !item.completed
  return (
    <Collapsible
      animated
      open={open}
      onOpenChange={setUserExpanded}
      className={cx(TOOL_RUN_STEP_CLASS, 'grid-cols-[minmax(0,1fr)]', open && 'is-open')}
      data-testid="thinking-activity-step"
    >
      <CollapsibleTrigger asChild>
        <Button
          unstyled
          type="button"
          className={cx(
            TOOL_RUN_STEP_TRIGGER_CLASS,
            TOOL_ACTIVITY_LABEL_CLASS,
            '!min-h-[var(--vds-control-height-sm)] !py-[var(--vds-space-half)]'
          )}
          aria-label={t('stream.thinkingContent')}
          tabIndex={groupOpen ? 0 : -1}
        >
          <ActivityStatusIcon status={active ? 'running' : 'done'} />
          <span className={TOOL_RUN_STEP_NAME_CLASS}>
            {t(active ? 'stream.thinking' : 'stream.thought')}
          </span>
          <span className="flex-1" />
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cx(
          TOOL_RUN_IO_CLASS,
          TOOL_ACTIVITY_DETAIL_INSET_CLASS,
          '!border-[var(--vds-divider-default)] !px-[var(--vds-space-3)] !py-[var(--vds-space-2)] !whitespace-normal !bg-[var(--vds-surface-muted)]'
        )}
        data-testid="thinking-activity-content"
      >
        {item.itemId && selectionEnabled ? (
          <AnnotatedAnswer
            citationEnabled={false}
            markdownClassName={TOOL_RUN_MARKDOWN_CLASS}
            text={item.text}
            selectionEnabled
            messageId={`item:${item.itemId}`}
          />
        ) : (
          <Markdown text={item.text} math className={TOOL_RUN_MARKDOWN_CLASS} />
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function SkillActivityStep({
  item,
  groupOpen,
}: {
  item: SkillActivityItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { act } = useApp()
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.path)
  const stateTone =
    item.status === 'error' ? 'is-error' : item.status === 'done' ? 'is-done' : 'is-running'
  return (
    <div className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')} data-testid="skill-activity-step">
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
        <span className={cx(TOOL_RUN_STEP_STATUS_CLASS, TOOL_RUN_STATUS_TONE_CLASS[stateTone])}>
          {item.status === 'running' && <span className={TOOL_RUN_PULSE_CLASS} />}
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
  agentIdentity,
  groupOpen,
  now,
}: {
  item: NativeActivityItem
  agentIdentity?: string | number
  groupOpen: boolean
  now: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null)
  const details = Object.keys(item.details).length ? toolValue(item.details) : ''
  const subagentRunning = item.activityType === 'subagent_activity' && item.status === 'running'
  const callStatusKey = collaborationStatusKey(item)
  const label =
    item.activityType === 'subagent_activity' && agentIdentity !== undefined
      ? typeof agentIdentity === 'number'
        ? conversation('subagent.numbered', { number: agentIdentity })
        : conversation('subagent.named', { name: agentIdentity })
      : nativeActivityLabel(item, t)
  const progress = item.activityType === 'subagent_activity' ? (item.progress ?? []) : []
  const hasDetails = Boolean(details || progress.length)
  const open = activityDisclosureOpen(userExpanded, subagentRunning && groupOpen)
  const observedAt =
    typeof item.details.last_observed_at === 'number'
      ? item.details.last_observed_at
      : item.startedAt
  const activity =
    typeof item.details.recent_activity === 'string' ? item.details.recent_activity : ''
  const activityKey =
    activity in SUBAGENT_ACTION_KEYS ? (activity as keyof typeof SUBAGENT_ACTION_KEYS) : 'work'
  const recentActivityLabel = conversation(SUBAGENT_ACTION_KEYS[activityKey].key)
  const stateTone =
    item.status === 'error' ? 'is-error' : item.status === 'done' ? 'is-done' : 'is-running'
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid={`native-activity-${item.activityType}`}
    >
      <Button
        unstyled
        type="button"
        className={cx(TOOL_RUN_STEP_TRIGGER_CLASS, '!flex-col !items-stretch')}
        aria-expanded={hasDetails ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasDetails && setUserExpanded(!open)}
      >
        <span className="flex w-full min-w-0 items-center gap-[var(--vds-space-2)]">
          <ActivityStatusIcon status={item.status} />
          <span className={TOOL_RUN_STEP_NAME_CLASS} data-testid="native-activity-name">
            {label}
          </span>
          <span
            className={cx(TOOL_RUN_STEP_STATUS_CLASS, TOOL_RUN_STATUS_TONE_CLASS[stateTone])}
            data-testid="native-activity-status"
          >
            {item.status === 'running' && <span className={TOOL_RUN_PULSE_CLASS} />}
            {callStatusKey
              ? conversation(callStatusKey)
              : subagentRunning
                ? conversation('subagent.running')
                : t(TOOL_STATUS_KEYS[item.status].messageKey)}
          </span>
          {hasDetails && (
            <span className={TOOL_RUN_STEP_CARET_CLASS}>
              <Icon name="chevron-right" size={12} sw={1.8} />
            </span>
          )}
        </span>
        {subagentRunning && (
          <span className="flex w-full min-w-0 flex-wrap gap-x-[var(--vds-space-3)] gap-y-[var(--vds-space-1)] pl-[var(--vds-space-4)] text-[var(--vds-text-tertiary)]">
            {item.startedAt !== undefined && (
              <span data-testid="subagent-elapsed">
                {conversation('subagent.elapsed', {
                  duration: elapsedLabel(item.startedAt, now, t),
                })}
              </span>
            )}
            {observedAt !== undefined && (
              <span data-testid="subagent-last-observed">
                {conversation('subagent.lastObserved', {
                  activity: recentActivityLabel,
                  age: elapsedLabel(observedAt, now, t),
                })}
              </span>
            )}
          </span>
        )}
      </Button>
      {hasDetails && (
        <div className={TOOL_RUN_STEP_CONTENT_CLASS} aria-hidden={!open}>
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            {progress.length ? (
              <div
                className={cx(TOOL_RUN_IO_STACK_CLASS, '!gap-0')}
                data-testid="subagent-progress"
              >
                {progress.map((step, index) => {
                  const activityItem = subagentActivityItem(step, item)
                  if (activityItem?.kind === 'thinking') {
                    return (
                      <ThinkingActivityStep
                        key={step.itemId}
                        item={activityItem}
                        groupOpen={open}
                        autoExpand={subagentRunning && index === progress.length - 1}
                        selectionEnabled={false}
                      />
                    )
                  }
                  if (activityItem?.kind === 'tool') {
                    return (
                      <ToolStep key={step.itemId} item={activityItem} groupOpen={open} now={now} />
                    )
                  }
                  if (
                    !step.summary &&
                    (step.activity === 'message' || step.activity === 'reasoning')
                  )
                    return null
                  const key =
                    step.activity in SUBAGENT_ACTION_KEYS
                      ? (step.activity as keyof typeof SUBAGENT_ACTION_KEYS)
                      : 'work'
                  if (!step.summary) {
                    return (
                      <div key={step.itemId} className={TOOL_RUN_IO_LABEL_CLASS}>
                        {conversation(SUBAGENT_ACTION_KEYS[key].key)}
                      </div>
                    )
                  }
                  return (
                    <IoBlock
                      key={step.itemId}
                      label={conversation(SUBAGENT_ACTION_KEYS[key].key)}
                      text={step.summary}
                    />
                  )
                })}
              </div>
            ) : (
              <div className={TOOL_RUN_IO_STACK_CLASS}>
                <IoBlock label={t('stream.details')} text={details} err={item.status === 'error'} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function WebSearchStep({
  item,
  groupOpen,
}: {
  item: WebSearchItem
  groupOpen: boolean
}): React.JSX.Element {
  const openWebPage = useContext(WebNavigationContext)
  const { t } = useTranslation('components')
  const data = webSearchRecordData(item)
  const isSearch = item.action.type !== 'openPage' && item.action.type !== 'findInPage'
  const title = webSearchActionLabel(item, t)
  const status =
    item.status === 'running'
      ? t('stream.search.searching')
      : t(TOOL_STATUS_KEYS[item.status].messageKey)
  return (
    <WebSearchRecord
      title={
        isSearch ? <span className="text-[length:var(--vds-font-body-lv1)]">{title}</span> : title
      }
      {...data}
      showKeywordCount={isSearch}
      groupOpen={groupOpen}
      statusIcon={<ActivityStatusIcon status={item.status} />}
      statusLabel={status}
      onOpenResult={(result) => {
        const destination = externalResultUrl(result.url)
        if (destination) openWebPage(destination)
      }}
    />
  )
}

function SearchActivityCard({ item }: { item: SearchActivityItem }): React.JSX.Element {
  const { t } = useTranslation('components')
  const paper = item.kind === 'paper_search'
  const target = paper ? t('stream.search.paperTarget') : t('stream.search.webTarget')
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
            {running ? t('stream.search.runningTitle') : t('stream.search.doneTitle')}
          </span>
          <span className={TOOL_RUN_SUMMARY_CLASS}>{query ? `${target} · ${query}` : target}</span>
        </span>
        <span
          className={cx(
            TOOL_RUN_STATE_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[running ? 'is-running' : 'is-done']
          )}
        >
          {running && <span className={TOOL_RUN_PULSE_CLASS} />}
          {running ? t('stream.search.searching') : t(TOOL_STATUS_KEYS.done.messageKey)}
        </span>
      </div>
    </section>
  )
}

function PaperSearchStep({
  item,
  groupOpen,
}: {
  item: PaperSearchItem
  groupOpen: boolean
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(item.query)
  return (
    <div className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')} data-testid="paper-search-step">
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
            TOOL_RUN_STATUS_TONE_CLASS[item.status === 'running' ? 'is-running' : 'is-done']
          )}
        >
          {item.status === 'running' && <span className={TOOL_RUN_PULSE_CLASS} />}
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
              <IoBlock label={t('stream.search.paperQuery')} text={item.query} />
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
  now,
}: {
  item: ToolItem
  groupOpen: boolean
  now: number
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { act, state: appState } = useApp()
  const focus = appState.aiPanel.messageFocus
  const focused =
    focus?.kind === 'progress' && focus.itemId === item.toolId && focus.turnId === item.turnId
  const skillName = loadedSkillName(item)
  const outcome = commandOutcome(item)
  const neutralSearch = outcome === 'noMatches'
  const displayStatus = neutralSearch || item.recoveredBy ? 'done' : item.status
  const outcomeKey = {
    commandNotFound: 'toolOutcome.commandNotFound',
    permissionDenied: 'toolOutcome.permissionDenied',
    fileMissing: 'toolOutcome.fileMissing',
    nonzero: 'toolOutcome.nonzero',
    unknown: 'toolOutcome.unknown',
    none: 'toolOutcome.toolFailed',
    noMatches: 'toolOutcome.noMatches',
  } as const
  const outcomeText =
    item.status === 'error' ? conversation(outcomeKey[outcome], { code: item.exitCode ?? 0 }) : ''
  const summary = item.status !== 'error' ? toolInputSummary(item) : ''
  const action = activityAction(item)
  const duration = compactDurationLabel(
    item.startedAt,
    item.status === 'running' ? now : item.completedAt,
    item.status !== 'running'
  )
  return (
    <ToolExecution
      groupOpen={groupOpen}
      reveal={focused}
      itemId={item.toolId}
      turnId={item.turnId}
      data={{
        name: normalizeToolName(item.name),
        label: toolLabel(item, conversation),
        status: displayStatus,
        statusLabel: item.recoveredBy
          ? conversation('toolOutcome.recovered')
          : neutralSearch
            ? outcomeText
            : item.status === 'done'
              ? t('stream.ran')
              : t(TOOL_STATUS_KEYS[item.status].messageKey),
        failure:
          item.status === 'error'
            ? {
                summary: neutralSearch || item.recoveredBy ? undefined : outcomeText,
                help: conversation(
                  item.recoveredBy
                    ? 'toolOutcome.recoveredHelp'
                    : neutralSearch
                      ? 'toolOutcome.noMatchesHelp'
                      : 'toolOutcome.failedHelp'
                ),
              }
            : undefined,
        summary: summary
          ? { text: summary, badge: action === 'read' || action === 'edit' }
          : undefined,
        preview: item.status === 'done' ? toolPreview(item) : undefined,
        duration: duration ?? undefined,
        input: item.input != null ? toolValue(item.input) : undefined,
        output: item.result != null && item.result !== '' ? item.result : undefined,
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
      }}
      actions={
        skillName && item.status === 'done' ? (
          <Button
            unstyled
            type="button"
            className={CHIP_BUTTON_CLASS}
            data-testid="load-skill-open-files"
            onClick={() => act.openCap('skill')}
          >
            {t('stream.skill.open')}
          </Button>
        ) : undefined
      }
    />
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
  Grep: 'stream.hil.title.grep',
} as const
// safety tag → 中文 chip 文案 / 语气色 (PolicyRequest.safety_tags)。
const TAG_LABEL = {
  read_only: 'stream.hil.tag.readOnly',
  writes: 'stream.hil.tag.writes',
  destructive: 'stream.hil.tag.destructive',
  network: 'stream.hil.tag.network',
} as const
const TAG_TONE: Record<string, string> = {
  destructive: 'var(--c-tension)',
  network: 'var(--c-opinion)',
  writes: 'var(--accent-ink)',
  read_only: 'var(--c-experience)',
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
  const short = formatHilPermissionScope(hilPermissionScope(o, item.prefixKind), t)
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
            : t('stream.hil.allowCommandClassCaption'),
        }
      if (item.prefixKind === 'file_dir')
        return {
          short,
          caption: px
            ? t('stream.hil.allowDirectoryCaption', { prefix: px })
            : t('stream.hil.allowThisDirectoryCaption'),
        }
      if (item.prefixKind === 'web_host')
        return {
          short,
          caption: px
            ? t('stream.hil.allowSiteCaption', { host: px })
            : t('stream.hil.allowThisSiteCaption'),
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

function Chip({ label, tone }: { label: string; tone?: string }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10.5,
        color: tone ?? 'var(--text-2)',
        border: `1px solid ${tone ?? 'var(--border)'}`,
        borderRadius: 6,
        padding: '1.5px 7px',
        opacity: tone ? 0.92 : 1,
        whiteSpace: 'nowrap',
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
      target: fmtVal(item.networkTarget, t),
    })
  const body = item.body?.trim()
  return body || t('stream.hil.summary.default')
}

function BrowserAwareHilCard(props: {
  item: HilItem
  presentation?: 'history' | 'dock'
  queueCount?: number
}): React.JSX.Element {
  const { state } = useApp()
  const interactionPolicies = useInteractionPolicies()
  const { item } = props
  const questions = item.questions ?? []
  const questionPolicy = isQuestionHil(item)
    ? interactionPolicies.find((policy) => policy.matches(questions))
    : undefined
  if (item.hilState === 'cancelled' && questionPolicy?.renderReply)
    return (
      <div
        data-testid="hil-card"
        data-interaction-request-id={item.requestId}
        data-hil-state="cancelled"
        data-hil-resolved="true"
      >
        {questionPolicy.renderReply({
          requestId: item.requestId,
          questions,
          answers: item.answers ?? {},
          cancelled: true,
        })}
      </div>
    )
  if (
    item.hilState === 'stale' &&
    isQuestionHil(item) &&
    availabilityPolicy.hilAvailable(item.hilKind ?? '', item.browserApproval?.action) &&
    questions.every(
      (question) => !question.installation && (!question.component || question.options.length > 0)
    ) &&
    !interactionPolicies.some((policy) => policy.matches(questions))
  ) {
    return (
      <div
        data-testid="hil-card"
        data-hil-kind="question"
        data-interaction-request-id={item.requestId}
        data-hil-resolved="true"
        data-hil-state="stale"
      >
        <InteractionReply
          key={item.requestId}
          expired
          item={{ kind: 'interaction_reply', requestId: item.requestId, questions, answers: {} }}
        />
      </div>
    )
  }
  const content =
    props.item.hilKind === 'browser_approval' &&
    availabilityPolicy.hilAvailable(props.item.hilKind, props.item.browserApproval?.action) ? (
      <BrowserApprovalCard {...props} />
    ) : props.item.hilKind === 'browser_history_approval' &&
      availabilityPolicy.hilAvailable(props.item.hilKind) ? (
      <BrowserHistoryApprovalCard {...props} />
    ) : !availabilityPolicy.hilAvailable(
        props.item.hilKind ?? '',
        props.item.browserApproval?.action
      ) ? (
      <UnavailableHilCard />
    ) : (
      <HilCardView {...props} />
    )
  return activeThread(state).readOnly ? (
    <fieldset disabled className="min-w-0 border-0 p-0">
      {content}
    </fieldset>
  ) : (
    content
  )
}

function UnavailableHilCard(): React.JSX.Element {
  const { t } = useTranslation('browser')
  return (
    <Card data-testid="browser-unavailable-record">
      <CardContent>{t('disabledRecord')}</CardContent>
    </Card>
  )
}

function BrowserHistoryApprovalCard({
  item,
  presentation = 'history',
  queueCount = 1,
}: {
  item: HilItem
  presentation?: 'history' | 'dock'
  queueCount?: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation('browser')
  const { t: conversationT } = useTranslation('conversation')
  const { t: componentsT } = useTranslation('components')
  const { state, patchThread } = useApp()
  const thread = activeThread(state)
  const sessionId = thread.sessionId
  const threadId = state.activeSession
  const approval = item.browserHistoryApproval
  const [now, setNow] = useState(Date.now())
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const expired = !approval || now >= approval.expiresAt
  const done =
    item.resolved != null ||
    item.hilState === 'resolved' ||
    item.hilState === 'stale' ||
    item.hilState === 'cancelled' ||
    item.hilState === 'unknown'

  useLayoutEffect(() => {
    if (presentation !== 'dock' || done || expired) return
    const card = cardRef.current
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    card?.focus()
    return () => {
      if (card?.contains(document.activeElement) && previousFocus?.isConnected)
        previousFocus.focus()
    }
  }, [presentation, done, expired, item.requestId])

  useEffect(() => {
    if (done || expired) return () => undefined
    const timer = window.setInterval(() => setNow(Date.now()), HIL_WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [done, expired])

  const decide = async (decision: 'deny' | 'allow_once'): Promise<void> => {
    if (thread.readOnly) return
    if (!availabilityPolicy.hilAvailable(item.hilKind ?? '', item.browserApproval?.action)) return
    if (
      !sessionId ||
      !approval ||
      !item.turnId ||
      done ||
      expired ||
      submitting ||
      inFlight.current
    )
      return
    inFlight.current = true
    setSubmitting(true)
    patchThread(threadId, (thread) => ({
      conversation: thread.conversation.map((entry) =>
        entry.kind === 'hil' && entry.requestId === item.requestId
          ? { ...entry, hilState: 'submitting', submissionError: undefined }
          : entry
      ),
    }))
    let result: BrowserApprovalResponseReply = { ok: false, outcome: 'unknown' }
    try {
      result =
        (await window.scholarseed.respondBrowserHistoryApproval?.({
          sessionId,
          requestId: item.requestId,
          proofId: approval.proofId,
          turnId: item.turnId,
          search: approval.search,
          offset: approval.offset,
          limit: approval.limit,
          intent: approval.intent,
          queryDigest: approval.queryDigest,
          historyRevision: approval.historyRevision,
          expiresAt: approval.expiresAt,
          decision,
        })) ?? result
    } catch {
      result = { ok: false, outcome: 'unknown' }
    }
    inFlight.current = false
    setSubmitting(false)
    patchThread(threadId, (thread) => ({
      conversation: thread.conversation.map((entry) => {
        if (
          entry.kind !== 'hil' ||
          entry.requestId !== item.requestId ||
          entry.hilState === 'resolved' ||
          entry.hilState === 'stale' ||
          entry.hilState === 'cancelled'
        )
          return entry
        return { ...entry, ...browserHistoryApprovalSubmission(result), submissionError: undefined }
      }),
    }))
  }

  const status = done
    ? item.hilState === 'unknown'
      ? t('historyApproval.unknownOutcome')
      : (formatHilResolution(item, componentsT, conversationT) ?? t('historyApproval.inactive'))
    : expired
      ? t('historyApproval.expired')
      : submitting
        ? t('historyApproval.submitting')
        : t('historyApproval.waiting')
  const blockModifiedDecisionKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    if (event.target instanceof Element && event.target.closest('button')) event.preventDefault()
  }

  return (
    <Card
      ref={cardRef}
      role={browserApprovalCardRole(presentation, done, expired)}
      aria-label={t('historyApproval.title')}
      tabIndex={presentation === 'dock' && !done && !expired ? -1 : undefined}
      data-testid="hil-card"
      data-hil-kind="browser_history_approval"
      data-interaction-request-id={item.requestId}
      data-hil-state={item.hilState ?? 'pending'}
      data-hil-resolved={done ? 'true' : 'false'}
      className={
        presentation === 'dock'
          ? 'min-w-0 outline-none focus-visible:shadow-[var(--vds-focus-brand)]'
          : 'my-[var(--vds-conversation-block-gap)] min-w-0'
      }
      onKeyDownCapture={blockModifiedDecisionKey}
      onKeyUpCapture={blockModifiedDecisionKey}
      onKeyDown={(event) => {
        if (
          presentation !== 'dock' ||
          done ||
          expired ||
          submitting ||
          event.repeat ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return
        if (event.key === 'Escape') {
          event.preventDefault()
          void decide('deny')
        } else if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault()
          void decide('allow_once')
        }
      }}
    >
      <CardContent className="grid min-w-0 gap-[var(--vds-space-3)]">
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
          <strong className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)]">
            {t('historyApproval.title')}
          </strong>
          {queueCount > 1 && (
            <span className="text-[var(--vds-text-secondary)]">
              {conversationT('queuePosition', { current: 1, total: queueCount })}
            </span>
          )}
        </div>
        <dl className="grid min-w-0 gap-[var(--vds-space-2)] break-words text-[length:var(--vds-font-body-lv1)]">
          <div>
            <dt>
              <strong>{t('historyApproval.task')}</strong>
            </dt>
            <dd className="m-0">
              {thread.title} · {sessionId} · {item.turnId}
            </dd>
          </div>
          <div>
            <dt>
              <strong>{t('historyApproval.search')}</strong>
            </dt>
            <dd className="m-0">{approval?.search}</dd>
          </div>
          <div>
            <dt>
              <strong>{t('historyApproval.range')}</strong>
            </dt>
            <dd className="m-0">
              {approval
                ? t('historyApproval.rangeValue', {
                    start: approval.offset + 1,
                    limit: approval.limit,
                  })
                : null}
            </dd>
          </div>
          <div>
            <dt>
              <strong>{t('historyApproval.intent')}</strong>
            </dt>
            <dd className="m-0">{approval?.intent || t('historyApproval.unspecified')}</dd>
          </div>
          <div>
            <dt>
              <strong>{t('historyApproval.expiry')}</strong>
            </dt>
            <dd className="m-0">
              {approval ? new Date(approval.expiresAt).toLocaleTimeString(i18n.language) : null}
            </dd>
          </div>
        </dl>
        <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('historyApproval.risk')}
        </p>
        <p
          role="status"
          className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {status}
        </p>
        {!done && !expired && (
          <div className="flex flex-wrap justify-end gap-[var(--vds-space-2)]">
            <Button
              variant="outline"
              size="md"
              disabled={submitting}
              data-testid="hil-history-deny"
              onClick={() => {
                void decide('deny')
              }}
            >
              {t('historyApproval.deny')}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={submitting}
              data-testid="hil-history-allow-once"
              onClick={() => {
                void decide('allow_once')
              }}
            >
              {t('historyApproval.allowOnce')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function BrowserApprovalCard({
  item,
  presentation = 'history',
  queueCount = 1,
}: {
  item: HilItem
  presentation?: 'history' | 'dock'
  queueCount?: number
}): React.JSX.Element {
  const { t, i18n } = useTranslation('browser')
  const { t: conversationT } = useTranslation('conversation')
  const { t: componentsT } = useTranslation('components')
  const { state, patchThread } = useApp()
  const thread = activeThread(state)
  const sessionId = thread.sessionId
  const threadId = state.activeSession
  const [now, setNow] = useState(Date.now())
  const [submitting, setSubmitting] = useState(false)
  const [mainTab, setMainTab] = useState<{ tabId: string; title: string; url: string } | null>(null)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const inFlight = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const approval = item.browserApproval
  const expired = !approval || now >= approval.expiresAt
  const done =
    item.resolved != null ||
    item.hilState === 'resolved' ||
    item.hilState === 'stale' ||
    item.hilState === 'cancelled' ||
    item.hilState === 'unknown'

  useLayoutEffect(() => {
    if (presentation !== 'dock' || done || expired) return
    const card = cardRef.current
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    card?.focus()
    return () => {
      if (card?.contains(document.activeElement) && previousFocus?.isConnected)
        previousFocus.focus()
    }
  }, [presentation, done, expired, item.requestId])

  useEffect(() => {
    if (done || expired) return () => undefined
    const timer = window.setInterval(() => setNow(Date.now()), HIL_WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [done, expired])

  useEffect(() => {
    if (done || !approval) return () => undefined
    let mounted = true
    let observedUpdate = false
    const unsubscribe = window.scholarseed.browser.subscribe((snapshot) => {
      observedUpdate = true
      if (mounted) setMainTab(browserApprovalTarget(snapshot, approval))
    })
    const refresh = async (): Promise<void> => {
      try {
        const reply = await window.scholarseed.browser.snapshot()
        if (mounted && !observedUpdate)
          setMainTab(reply.ok ? browserApprovalTarget(reply.snapshot, approval) : null)
      } catch {
        if (mounted && !observedUpdate) setMainTab(null)
      }
    }
    void refresh()
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [approval?.tabId, approval?.origin, approval?.sourceOrigin, done])

  const decide = async (decision: 'deny' | 'allow_once'): Promise<void> => {
    if (thread.readOnly) return
    if (!availabilityPolicy.hilAvailable(item.hilKind ?? '', item.browserApproval?.action)) return
    if (
      !sessionId ||
      done ||
      expired ||
      submitting ||
      inFlight.current ||
      (decision === 'allow_once' && !mainTab)
    )
      return
    inFlight.current = true
    setSubmitting(true)
    patchThread(threadId, (thread) => ({
      conversation: thread.conversation.map((entry) =>
        entry.kind === 'hil' && entry.requestId === item.requestId
          ? { ...entry, hilState: 'submitting', submissionError: undefined }
          : entry
      ),
    }))
    let result: BrowserApprovalResponseReply = { ok: false, outcome: 'unknown' }
    try {
      result =
        (await window.scholarseed.respondBrowserApproval?.({
          sessionId,
          requestId: item.requestId,
          proofId: approval?.proofId ?? '',
          turnId: item.turnId ?? '',
          tabId: approval?.tabId ?? '',
          targetInstanceId: approval?.targetInstanceId ?? '',
          targetGeneration: approval?.targetGeneration ?? -1,
          origin: approval?.origin ?? '',
          ...(approval?.action === 'navigate'
            ? {
                sourceOrigin: approval.sourceOrigin,
                destinationUrl: approval.destinationUrl,
                destinationOrigin: approval.destinationOrigin,
              }
            : {}),
          ...(['click', 'fill', 'submit'].includes(approval?.action ?? '')
            ? {
                preparedId: approval?.preparedId,
                snapshotId: approval?.snapshotId,
                elementRef: approval?.elementRef,
                browserAction: approval?.browserAction,
                element: approval?.element,
              }
            : {}),
          action: approval?.action ?? '',
          intent: approval?.intent ?? '',
          expiresAt: approval?.expiresAt ?? 0,
          decision,
        })) ?? result
    } catch {
      result = { ok: false, outcome: 'unknown' }
    }
    inFlight.current = false
    setSubmitting(false)
    patchThread(threadId, (thread) => ({
      conversation: thread.conversation.map((entry) => {
        if (
          entry.kind !== 'hil' ||
          entry.requestId !== item.requestId ||
          entry.hilState === 'resolved' ||
          entry.hilState === 'stale' ||
          entry.hilState === 'cancelled'
        )
          return entry
        const outcome = browserApprovalSubmission(result)
        return {
          ...entry,
          ...outcome,
          submissionError: undefined,
        }
      }),
    }))
  }

  const status = done
    ? item.hilState === 'unknown'
      ? t('approval.unknownOutcome')
      : (formatHilResolution(item, componentsT, conversationT) ?? t('approval.inactive'))
    : expired
      ? t('approval.expired')
      : submitting
        ? t('approval.submitting')
        : !mainTab
          ? t('approval.targetUnavailable')
          : t('approval.waiting')
  const actionLabel = (() => {
    switch (approval?.action) {
      case 'navigate':
        return t('approval.navigate')
      case 'snapshot':
        return t('approval.snapshot')
      case 'read':
        return t('approval.read')
      case 'interact':
        return t('approval.interact')
      case 'click':
        return t('approval.click')
      case 'fill':
        return t('approval.fill')
      case 'submit':
        return t('approval.submit')
      default:
        return approval?.action ?? t('approval.unknown')
    }
  })()
  const blockModifiedDecisionKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    if (event.target instanceof Element && event.target.closest('button')) event.preventDefault()
  }

  const approvalIcon = <IconFont type="icon-qingqiupizhun" />
  const confirmation = (
    <ConfirmationCard
      compact
      title={t('approval.title')}
      icon={approvalIcon}
      description={t(
        approval?.action === 'navigate' ? 'approval.description' : 'approval.operationDescription'
      )}
      readOnly={done || expired || thread.readOnly === true}
      disabled={submitting}
      allowDisabled={!mainTab}
      allowLabel={t('approval.allowOnce')}
      denyLabel={t('approval.deny')}
      onAllow={() => void decide('allow_once')}
      onDeny={() => void decide('deny')}
      allowAttributes={{
        'data-testid': 'hil-browser-allow-once',
        'data-hil-decision': 'allow-once',
      }}
      denyAttributes={{
        'data-testid': 'hil-browser-deny',
        'data-hil-decision': 'deny',
      }}
      details={[
        {
          id: 'url',
          label: t('approval.url'),
          value:
            approval?.action === 'navigate'
              ? approval.destinationUrl || t('approval.unknown')
              : approval?.tabUrl || approval?.origin || t('approval.unknown'),
          multiline: true,
        },
        {
          id: 'expiry',
          label: t('approval.expiry'),
          value: approval
            ? new Date(approval.expiresAt).toLocaleTimeString(i18n.language)
            : t('approval.unknown'),
        },
        {
          id: 'scope',
          label: t('approval.scope'),
          value:
            (expired && !done) || item.resolvedMessage?.kind === 'browserExpired' ? (
              <span className="text-[var(--vds-warning-text-primary)]">
                {t('approval.scopeExpired')}
              </span>
            ) : item.resolvedMessage?.kind === 'denied' ? (
              t('approval.scopeDenied')
            ) : (
              t('approval.once')
            ),
        },
        ...(approval?.action !== 'navigate'
          ? [
              {
                id: 'action',
                label: t('approval.action'),
                value: actionLabel,
              },
            ]
          : []),
        ...(approval?.element
          ? [
              {
                id: 'element',
                label: t('approval.element'),
                value: `${approval.element.role} · ${approval.element.name || t('approval.unknown')}`,
                multiline: true,
              },
            ]
          : []),
      ]}
    >
      {queueCount > 1 && (
        <p className="m-0 text-[var(--vds-text-secondary)]">
          {conversationT('queuePosition', { current: 1, total: queueCount })}
        </p>
      )}
      {(approval?.action === 'snapshot' || approval?.action === 'read') && !done && !expired && (
        <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('approval.readRisk')}
        </p>
      )}
      {['click', 'fill', 'submit'].includes(approval?.action ?? '') && !done && !expired && (
        <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {t('approval.actionRisk')}
        </p>
      )}
      {!done && !expired && (submitting || !mainTab) && (
        <p
          role="status"
          className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
        >
          {status}
        </p>
      )}
      {item.hilState === 'failed' && (
        <p role="alert" className="m-0 text-[var(--vds-error-text-primary)]">
          {item.submissionError || t('approval.failed')}
        </p>
      )}
    </ConfirmationCard>
  )

  return (
    <Card
      ref={cardRef}
      role={browserApprovalCardRole(presentation, done, expired)}
      aria-label={t('approval.title')}
      tabIndex={presentation === 'dock' && !done && !expired ? -1 : undefined}
      data-testid="hil-card"
      data-hil-kind="browser_approval"
      data-interaction-request-id={item.requestId}
      data-hil-state={item.hilState ?? 'pending'}
      data-hil-resolved={done ? 'true' : 'false'}
      className={
        presentation === 'dock'
          ? 'min-h-0 min-w-0 !border-0 !bg-transparent !p-0 shadow-none outline-none focus-visible:shadow-[var(--vds-focus-brand)]'
          : 'my-[var(--vds-conversation-block-gap)] min-w-0 !border-0 !bg-transparent !p-0 shadow-none'
      }
      onKeyDownCapture={blockModifiedDecisionKey}
      onKeyUpCapture={blockModifiedDecisionKey}
      onKeyDown={(event) => {
        if (
          presentation !== 'dock' ||
          done ||
          expired ||
          submitting ||
          event.repeat ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return
        if (event.key === 'Escape') {
          event.preventDefault()
          void decide('deny')
        } else if (event.key === 'Enter' && event.target === event.currentTarget && mainTab) {
          event.preventDefault()
          void decide('allow_once')
        }
      }}
    >
      {presentation === 'history' && (done || expired) ? (
        <ExecutionBatch
          label={
            (expired && !done) || item.resolvedMessage?.kind === 'browserExpired'
              ? t('approval.expired')
              : item.resolvedMessage?.kind === 'allowedOnce'
                ? t('approval.authorized')
                : item.resolvedMessage?.kind === 'denied'
                  ? t('approval.denied')
                  : status
          }
          icon={approvalIcon}
          warning={item.resolvedMessage?.kind !== 'allowedOnce' ? status : undefined}
          expanded={historyExpanded}
          onExpandedChange={setHistoryExpanded}
          animated={false}
        >
          {confirmation}
        </ExecutionBatch>
      ) : (
        confirmation
      )}
    </Card>
  )
}

export interface HilController {
  readOnly?: boolean
  sessionId: string | null
  threadId: string | null
  patchThread: ReturnType<typeof useApp>['patchThread']
  respond: typeof respondHil
  interrupt: typeof interruptSession
}

interface HilCardProps {
  item: HilItem
  presentation?: 'history' | 'dock'
  queueCount?: number
  controller?: HilController
  previewMount?: PluginMount
}

function HilCardView(props: HilCardProps): React.JSX.Element {
  return props.controller ? (
    <HilCard {...props} controller={props.controller} />
  ) : (
    <ConnectedHilCard {...props} />
  )
}

export { HilCardView as HilCard }

function ConnectedHilCard(props: HilCardProps): React.JSX.Element {
  const app = useApp()
  return (
    <HilCard
      {...props}
      controller={{
        readOnly: activeThread(app.state).readOnly,
        sessionId: activeThread(app.state).sessionId,
        threadId: app.state.activeSession,
        patchThread: app.patchThread,
        respond: respondHil,
        interrupt: interruptSession,
      }}
    />
  )
}

function HilCard({
  item,
  presentation = 'history',
  queueCount = 1,
  controller,
  previewMount,
}: HilCardProps & { controller: HilController }): React.JSX.Element {
  const { t: skillT } = useTranslation('skills')
  const { t, i18n: localization } = useTranslation('components')
  const { t: hilT } = useTranslation('conversation')
  const patchThread = controller.patchThread
  const sid = controller.sessionId
  const tid = controller.threadId
  const [picks, setPicks] = useState<Record<number, number[]>>(() =>
    questionDraft(item.questions ?? [])
  )
  const [subsetPicks, setSubsetPicks] = useState<Record<number, string[]>>({})
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [codeOpen, setCodeOpen] = useState(false)
  const [questionOpen, setQuestionOpen] = useState(true)
  const [authorizationOpen, setAuthorizationOpen] = useState(false)
  const [preparation, setPreparation] = useState<{
    requestId: string
    state: 'opening' | 'ready' | 'failed'
  } | null>(null)
  const [questionPage, setQuestionPage] = useState(1)
  const [skippedQuestions, setSkippedQuestions] = useState<number[]>([])
  const questionViewport = useRef<HTMLDivElement>(null)
  const questionNodes = useRef<(HTMLDivElement | null)[]>([])
  const questionNavigation = useRef<{ index: number; scrollTop: number } | null>(null)
  const [editingError, setEditingError] = useState(false)
  const editingRequest = useRef(false)
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
  const questionAnswered = (index: number): boolean =>
    (picks[index]?.length ?? 0) > 0 || Boolean(texts[index]?.trim())
  const questionComplete =
    questions.length > 0 &&
    (questionPolicy?.complete?.(
      questions,
      Object.fromEntries(
        questions.map((question, index) => [
          index,
          (picks[index] ?? []).map((position) => question.options[position]?.label),
        ])
      ),
      texts
    ) ??
      questions.every((_, index) => skippedQuestions.includes(index) || questionAnswered(index)))
  const countdownAt =
    isQuestion && item.cancelTimeoutOnEdit && !item.timeoutCancelled ? item.timeoutAt : undefined
  const cancelledLabel =
    item.hilState === 'cancelled' && questionPolicy?.cancelledLabel && questions[0]
      ? questionPolicy.cancelledLabel(questions[0])
      : undefined
  const resolutionItem =
    done && questions.some((question) => question.installation)
      ? {
          ...item,
          resolved: skillT('installation.title'),
          resolvedMessage: undefined,
          hilState: 'resolved' as const,
        }
      : cancelledLabel
        ? {
            ...item,
            resolved: cancelledLabel,
            resolvedMessage: undefined,
          }
        : item.resolved && questions.length === 1 && questionPolicy?.presentAnswer
          ? {
              ...item,
              resolved: questionPolicy.presentAnswer(questions[0], item.resolved, localization),
            }
          : item

  useEffect(() => {
    if (done || item.blocking === false || (isQuestion && countdownAt === undefined)) return
    const timer = window.setInterval(() => setNow(Date.now()), HIL_WAIT_TICK_MS)
    return () => window.clearInterval(timer)
  }, [countdownAt, done, isQuestion, item.blocking])

  const patchHil = useCallback(
    (patch: Partial<HilItem>): void =>
      patchThread(tid, (thread) => ({
        conversation: thread.conversation.map((entry) =>
          entry.kind === 'hil' && entry.requestId === item.requestId
            ? { ...entry, ...patch }
            : entry
        ),
      })),
    [item.requestId, patchThread, tid]
  )
  const markInstallationHandled = useCallback(
    () => patchHil({ installationHandled: true }),
    [patchHil]
  )

  const markEditing = async (): Promise<void> => {
    if (
      !sid ||
      !item.cancelTimeoutOnEdit ||
      item.timeoutCancelled ||
      editingRequest.current ||
      done
    )
      return
    editingRequest.current = true
    try {
      const response = await respondHil(
        sid,
        item.requestId,
        { editing: true },
        hasHostQuestions(questions)
      )
      const confirmed = response.ok && response.interaction?.timeout_cancelled === true
      setEditingError(!confirmed)
      if (confirmed) patchHil({ timeoutCancelled: true })
    } catch {
      setEditingError(true)
    } finally {
      editingRequest.current = false
    }
  }

  const markResolved = (
    label: string,
    answers?: Record<string, string>,
    resolvedMessage?: HilResolvedMessage,
    answerDetails?: HilAnswerDetails
  ): void =>
    patchThread(tid, (t) => {
      const alreadyTerminal = t.conversation.some(
        (it) =>
          it.kind === 'hil' &&
          it.requestId === item.requestId &&
          (it.hilState === 'stale' || it.hilState === 'cancelled' || it.hilState === 'unknown')
      )
      if (alreadyTerminal) return {}
      return {
        ...hilResolvedRunState(t, item.turnId),
        conversation: resolveHilItem(t.conversation, item.requestId, {
          // Preserve the existing canonical label: denial styling still inspects it.
          resolved: label,
          resolvedMessage,
          hilState: 'resolved',
          submissionError: undefined,
          submissionErrorMessage: undefined,
          submissionRequestFailure: undefined,
          ...(answers ? { answers } : {}),
          ...(answerDetails ? { answerDetails } : {}),
        }),
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
        ),
      }
    })
  }

  const submitAction = async (action: HilAction, requireConfirmed = false): Promise<void> => {
    console.info(
      '[hil-submit]',
      JSON.stringify({
        stage: 'received',
        requestId: item.requestId,
        sessionId: sid,
        itemSessionId: item.sessionId,
        action: action.kind,
        readOnly: Boolean(controller.readOnly),
        submitting,
        done,
        inFlight: submissionInFlight.current,
      })
    )
    if (
      controller.readOnly ||
      !sid ||
      submitting ||
      done ||
      submissionInFlight.current ||
      (item.sessionId && item.sessionId !== sid)
    ) {
      if (requireConfirmed) throw new Error('canvas_submission_unavailable')
      return
    }
    submissionInFlight.current = true
    void markInteractionAttentionRead(sid, item.requestId).catch((error) =>
      console.warn('[attention] interaction read unavailable', error)
    )
    setLastAction(action)
    patchHil({
      hilState: 'submitting',
      submissionError: undefined,
      submissionErrorMessage: undefined,
      submissionRequestFailure: undefined,
    })
    if (action.kind === 'cancel') {
      const response = await controller.interrupt(sid)
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
                  submissionRequestFailure: undefined,
                }
              : it
          ),
        }))
      } else {
        markSubmissionFailed({
          ...hilSubmissionFailure('cancelUnconfirmed', response.error),
          submissionRequestFailure: response.applicationFailure,
        })
      }
      return
    }
    console.info(
      '[hil-submit]',
      JSON.stringify({ stage: 'dispatched', requestId: item.requestId, sessionId: sid })
    )
    const response = await controller.respond(
      sid,
      item.requestId,
      action.body,
      hasHostQuestions(questions)
    )
    console.info(
      '[hil-submit]',
      JSON.stringify({
        stage: 'completed',
        requestId: item.requestId,
        sessionId: sid,
        ok: response.ok,
      })
    )
    if (!response.ok) {
      if (response.outcome === 'unknown') {
        submissionInFlight.current = false
        patchHil({
          hilState: 'unknown',
          ...hilSubmissionFailure('outcomeUnknown'),
          submissionRequestFailure: undefined,
        })
        if (requireConfirmed) throw new Error('canvas_submission_unknown')
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
          submissionRequestFailure: undefined,
        })
        if (requireConfirmed) throw new Error('canvas_submission_stale')
        return
      }
      markSubmissionFailed({
        ...hilSubmissionFailure('answerUnconfirmed', response.error),
        submissionRequestFailure: response.applicationFailure,
      })
      if (requireConfirmed) throw new Error(response.error ?? 'canvas_submission_failed')
      return
    }
    submissionInFlight.current = false
    markResolved(
      action.label,
      action.answers,
      action.resolvedMessage,
      response.interaction?.answer_details
    )
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
      resolvedMessage,
    })
  }
  const submitQuestion = (skipIndex?: number): void => {
    const qs = questions
    if (skipIndex === undefined && !questionComplete) return
    const submitted = qs.flatMap((question, index) => {
      if (index === skipIndex || skippedQuestions.includes(index)) return []
      const key = question.id || question.header || question.question
      const detail = { option_indices: picks[index] ?? [], text: texts[index]?.trim() ?? '' }
      const answer = questionAnswer(question, detail)
      return answer ? [{ key, answer, detail }] : []
    })
    const answers = Object.fromEntries(submitted.map(({ key, answer }) => [key, answer]))
    const answerDetails =
      !questionPolicy && qs.every(canReplayQuestionForm)
        ? Object.fromEntries(submitted.map(({ key, detail }) => [key, detail]))
        : undefined
    const summary = Object.values(answers).join(' · ')
    void submitAction({
      kind: 'respond',
      body: { answers, ...(answerDetails ? { answer_details: answerDetails } : {}) },
      label: summary || t('stream.hil.skipped'),
      answers,
    })
  }
  const toggle = (qi: number, position: number, multi: boolean): void =>
    setPicks((p) => {
      const cur = p[qi] || []
      if (!multi) return { ...p, [qi]: [position] }
      return {
        ...p,
        [qi]: cur.includes(position)
          ? cur.filter((index) => index !== position)
          : [...cur, position],
      }
    })
  const subsetIdsFor = (qi: number, question: (typeof questions)[number]): string[] =>
    subsetPicks[qi] ?? question.papers?.map((paper) => paper.id) ?? []
  const decideQuestion = (
    question: (typeof questions)[number],
    option: (typeof question.options)[number],
    subsetIds?: readonly string[]
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
      const body: HilResponseBody = { answers }
      // 子集只经决策值回传：账本行保持候选全集，serve 侧现算派生 scope。
      if (question.papers?.length) body.values = { selected_paper_ids: [...(subsetIds ?? [])] }
      void submitAction({
        kind: 'respond',
        body,
        label,
        answers,
      })
    }
  }
  const qs = item.questions ?? []
  const plainClarification =
    !questionPolicy && qs.every((question) => !question.installation && !question.component)
  const fixedClarification =
    presentation === 'dock' &&
    isQuestion &&
    !done &&
    !questionPolicy &&
    qs.every(
      (question) => !question.installation && (!question.component || question.options.length > 0)
    )
  const pagedQuestions =
    !done &&
    !questionPolicy?.directDecision &&
    qs.length > 1 &&
    qs.every(
      (question) =>
        !question.installation &&
        (plainClarification ? !question.component : question.options.length > 0)
    )
  const visibleQuestionPage = Math.min(questionPage, qs.length)
  const goToQuestion = (page: number): void => {
    const viewport = questionViewport.current
    if (fixedClarification) {
      setQuestionPage(page)
      viewport?.scrollTo({ top: 0 })
      return
    }
    const node = questionNodes.current[page - 1]
    if (!viewport || !node) return
    const scrollTop = questionScrollTarget(
      node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop,
      viewport.scrollHeight,
      viewport.clientHeight
    )
    questionNavigation.current = { index: page - 1, scrollTop }
    setQuestionPage(page)
    viewport.scrollTo({ top: scrollTop })
  }
  const presentedQuestions = qs.map((question) =>
    questionPolicy?.presentQuestion?.(question, localization)
  )

  // permission: 作用域选项平铺成一列, 点击即刻生效 (无下拉); 推荐档排最前 ——
  // 「允许此工具」(t) 优先, 其次前缀级 (p), 最后仅一次 (y), 减少反复弹卡。
  const rawOpts: Opt[] =
    item.options && item.options.length
      ? item.options
      : [
          { id: 'y', label: t('stream.hil.allow') },
          { id: 'n', label: t('stream.hil.deny') },
        ]
  const dockOptions = permissionDecisionOptions(item)
  const allowOpts = rawOpts.filter((o) => !isDenyOpt(o))
  const denyOpt = rawOpts.find((o) => isDenyOpt(o)) ?? {
    id: 'n',
    label: t('stream.hil.denyAndStop'),
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
  const cancelled = item.hilState === 'cancelled'
  const denied =
    stale || cancelled || /拒|deny|decline|reject|cancel|^n$|^no$/i.test(item.resolved || '')

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
        overflowWrap: 'anywhere',
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
        marginTop: 3,
      }}
    >
      <span>{stale ? '⌛' : denied ? '⊘' : '✓'}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
        {formatHilResolution(
          cancelled
            ? { ...resolutionItem, ...hilResolution({ kind: 'cancelled' }) }
            : resolutionItem,
          t,
          hilT
        )}
      </span>
    </span>
  ) : item.hilState === 'failed' ? (
    <span
      data-testid="hil-submit-error"
      style={{
        display: 'block',
        marginTop: fixedClarification ? undefined : 5,
        fontSize: fixedClarification ? 'var(--vds-font-body-lv1)' : 11.5,
        lineHeight: 1.5,
        color: 'var(--c-tension)',
        overflowWrap: 'anywhere',
      }}
    >
      {t('stream.hil.submitFailed', {
        message:
          (item.submissionRequestFailure
            ? formatApplicationRequestFailure(item.submissionRequestFailure, hilT)
            : formatHilSubmissionError(item, t)) || t('stream.hil.notConfirmed'),
      })}
    </span>
  ) : (
    <span
      className={isQuestion && !fixedClarification ? streamingTextClassName : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize:
          isQuestion && !fixedClarification
            ? 'var(--vds-font-body-lv2)'
            : 'var(--vds-font-body-lv1)',
        color: fixedClarification
          ? 'var(--vds-text-secondary)'
          : isQuestion
            ? undefined
            : 'var(--text-3)',
        whiteSpace: 'nowrap',
        marginTop: isQuestion ? 0 : 4,
      }}
    >
      {!isQuestion && (
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--c-experience)',
            animation: 'softPulse 1.4s ease-in-out infinite',
          }}
        />
      )}
      {submitting
        ? t('stream.hil.submittingWait')
        : countdownAt !== undefined
          ? answerCountdownLabel(countdownAt, now, t)
          : isQuestion
            ? fixedClarification
              ? hilT('reply.title')
              : t('stream.hil.waitingAnswer')
            : t('stream.hil.waitingElapsed', {
                label: t('stream.hil.waitingPermission'),
                duration: elapsedLabel(requestedAt, now, t),
              })}
    </span>
  )

  const title = isQuestion
    ? item.title || t('stream.hil.needAnswer')
    : permTitle(item.toolName, item.hilKind, item.title, t)
  const answerOnce = (): void => {
    if (!dockOptions.allowOnce) return
    answerPermission(dockOptions.allowOnce.id, t('stream.hil.allowedOnce'), {
      kind: 'allowedOnce',
    })
  }
  const deny = (): void =>
    answerPermission(dockOptions.deny.id, t('stream.hil.denied'), {
      kind: 'denied',
    })

  useEffect(() => {
    if (presentation !== 'dock' || done || isQuestion) return
    dockRef.current?.focus()
  }, [done, isQuestion, item.requestId, presentation])

  useEffect(() => {
    if (presentation !== 'dock' || done || isQuestion || submitting) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
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
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    answerPermission,
    dockOptions.allowOnce?.id,
    dockOptions.deny.id,
    done,
    isQuestion,
    item.requestId,
    presentation,
    submitting,
  ])

  if (item.blocking === false && questions.every((question) => question.installation)) {
    return (
      <>
        {questions.map((question) => (
          <PluginInstallation
            key={question.id}
            report={question.installation!}
            done={false}
            busy={Boolean(controller.readOnly)}
            session={sid}
            request={item.requestId ?? ''}
            onHandled={presentation === 'dock' ? markInstallationHandled : undefined}
          />
        ))}
      </>
    )
  }

  if (
    presentation === 'dock' &&
    !done &&
    questionPolicy?.directPresentation === 'high-risk' &&
    qs.length === 1 &&
    qs[0].options.length === 2
  ) {
    const question = qs[0]
    const displayed = presentedQuestions[0] ?? question
    const prepared =
      !questionPolicy.prepareDecision ||
      (preparation?.requestId === item.requestId && preparation.state === 'ready')
    const preparing = preparation?.requestId === item.requestId && preparation.state === 'opening'
    const prepareFailed =
      preparation?.requestId === item.requestId && preparation.state === 'failed'
    const primaryAction = async (): Promise<void> => {
      if (prepared) {
        decideQuestion(question, question.options[0])
        return
      }
      if (preparing || submitting || !questionPolicy.prepareDecision) return
      setPreparation({ requestId: item.requestId, state: 'opening' })
      try {
        const opened = await questionPolicy.prepareDecision()
        setPreparation({ requestId: item.requestId, state: opened ? 'ready' : 'failed' })
      } catch {
        setPreparation({ requestId: item.requestId, state: 'failed' })
      }
    }
    return (
      <div
        role="alertdialog"
        aria-label={displayed.header}
        data-testid="hil-card"
        data-hil-kind="question"
        data-interaction-request-id={item.requestId}
        data-hil-resolved="false"
        data-hil-state={item.hilState ?? 'pending'}
        className="min-w-0"
      >
        <ConfirmationCard
          compact
          risk="high"
          title={
            displayed.header ??
            (typeof questionPolicy.title === 'function'
              ? questionPolicy.title(localization)
              : questionPolicy.title)
          }
          description={displayed.question}
          disabled={submitting}
          allowDisabled={preparing}
          allowLabel={
            prepared
              ? displayed.options[0].label
              : (questionPolicy.prepareLabel?.(localization) ?? displayed.options[0].label)
          }
          denyLabel={displayed.options[1].label}
          allowAttributes={{ 'data-testid': 'hil-question-option-0-0' }}
          denyAttributes={{ 'data-testid': 'hil-question-option-0-1' }}
          onAllow={() => void primaryAction()}
          onDeny={() => decideQuestion(question, question.options[1])}
        >
          {prepareFailed && (
            <p role="alert" className="m-0 text-[var(--vds-error-text-primary)]">
              {questionPolicy.prepareFailure?.(localization)}
            </p>
          )}
          {item.hilState === 'failed' && (
            <p data-testid="hil-submit-error" className="m-0 text-[var(--vds-error-text-primary)]">
              {formatHilSubmissionError(item, t)}
            </p>
          )}
        </ConfirmationCard>
      </div>
    )
  }

  if (
    presentation === 'dock' &&
    !done &&
    questionPolicy?.directPresentation === 'failure-strip' &&
    qs.length === 1 &&
    qs[0].options.length === 2
  ) {
    const question = qs[0]
    const displayed = presentedQuestions[0] ?? question
    return (
      <Card
        padding="none"
        role="alert"
        data-testid="hil-card"
        data-hil-kind="question"
        data-interaction-request-id={item.requestId}
        data-hil-resolved="false"
        className="min-w-0 !border-[var(--vds-access-border)] !shadow-none"
      >
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
          <CircleX
            className="size-[var(--vds-icon-6)] shrink-0 text-[var(--vds-access-heading)]"
            aria-hidden
          />
          <span className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv1)]">
            {displayed.header}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="underline"
            aria-expanded={codeOpen}
            onClick={() => setCodeOpen(!codeOpen)}
          >
            {t('stream.hil.viewFailure')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={submitting}
            data-testid="hil-question-option-0-0"
            onClick={() => decideQuestion(question, question.options[0])}
          >
            {displayed.options[0].label}
          </Button>
          <IconButton
            label={displayed.options[1].label}
            icon={<X />}
            variant="ghost"
            size="xs"
            disabled={submitting}
            data-testid="hil-question-option-0-1"
            onClick={() => decideQuestion(question, question.options[1])}
          />
        </div>
        {codeOpen && (
          <div className="whitespace-pre-wrap border-t border-[var(--vds-border-default)] p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] [overflow-wrap:anywhere]">
            {displayed.question}
          </div>
        )}
        {item.hilState === 'failed' && (
          <p
            data-testid="hil-submit-error"
            className="px-[var(--vds-space-3)] text-[var(--vds-access-heading)]"
          >
            {formatHilSubmissionError(item, t)}
          </p>
        )}
      </Card>
    )
  }

  if (presentation === 'dock' && !done && item.hilKind === 'file_approval') {
    const details = approvalDetails(item)
    const operationLabels = {
      create: t('stream.hil.access.operations.create'),
      update: t('stream.hil.access.operations.update'),
      delete: t('stream.hil.access.operations.delete'),
      changes: t('stream.hil.access.operations.changes'),
    }
    return (
      <div
        ref={dockRef}
        tabIndex={-1}
        role="alertdialog"
        aria-label={t('stream.hil.access.fileTitle')}
        data-testid="hil-card"
        data-hil-kind="permission"
        data-interaction-request-id={item.requestId}
        data-hil-resolved="false"
        data-hil-state={item.hilState ?? 'pending'}
        className="min-w-0 outline-none focus-visible:shadow-[var(--vds-focus-brand)]"
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.repeat || submitting) return
          if (event.key === 'Escape') {
            event.preventDefault()
            deny()
          }
        }}
      >
        <ConfirmationCard
          compact
          risk="high"
          title={t('stream.hil.access.fileTitle')}
          description={t('stream.hil.access.fileDescription')}
          disabled={submitting}
          allowVisible={Boolean(dockOptions.allowOnce)}
          allowLabel={submitting ? t('stream.hil.submitting') : t('stream.hil.access.allow')}
          denyLabel={t('stream.hil.deny')}
          allowAttributes={{
            'data-testid': `hil-permission-${dockOptions.allowOnce?.id}`,
            'data-hil-decision': 'allow-once',
          }}
          denyAttributes={{
            'data-testid': `hil-permission-${dockOptions.deny.id}`,
            'data-hil-decision': 'deny',
          }}
          details={[
            ...(details.paths.length
              ? [
                  {
                    id: 'path',
                    label: t('stream.hil.access.path'),
                    value: details.paths.join('\n'),
                    highlighted: true,
                    multiline: true,
                  },
                ]
              : []),
            {
              id: 'operation',
              label: t('stream.hil.access.operation'),
              value: (
                <Collapsible
                  open={codeOpen}
                  onOpenChange={setCodeOpen}
                  className="!border-0 !bg-transparent !p-0"
                >
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="content"
                      className="!justify-start !p-0 !text-[length:inherit]"
                      aria-label={t('stream.hil.access.changes')}
                    >
                      {operationLabels[fileApprovalOperation(item)]}
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="!border-0 !p-0">
                    <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {item.diff || JSON.stringify(item.changes ?? [], null, 2)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              ),
              multiline: true,
            },
            {
              id: 'scope',
              label: t('stream.hil.access.scope'),
              value: t('stream.hil.access.fileScope'),
              multiline: true,
            },
            ...(item.permissions
              ? [
                  {
                    id: 'permissions',
                    label: t('stream.hil.access.permissions'),
                    value: fmtVal(item.permissions, t),
                    multiline: true,
                  },
                ]
              : []),
          ]}
          onAllow={answerOnce}
          onDeny={deny}
        >
          {queueCount > 1 && (
            <span>{hilT('queuePosition', { current: 1, total: queueCount })}</span>
          )}
          {item.hilState === 'failed' && (
            <p data-testid="hil-submit-error" className="m-0 text-[var(--vds-error-text-primary)]">
              {t('stream.hil.submitFailed', {
                message: item.submissionRequestFailure
                  ? formatApplicationRequestFailure(item.submissionRequestFailure, hilT)
                  : formatHilSubmissionError(item, t) || t('stream.hil.notConfirmedRetry'),
              })}
            </p>
          )}
        </ConfirmationCard>
      </div>
    )
  }

  if (presentation === 'dock' && !isQuestion && !done) {
    const summary = permissionSummary(item, t)
    const commandApproval = Boolean(item.command)
    const approvalTitle = commandApproval
      ? t('stream.hil.access.commandTitle')
      : t('stream.hil.requestPermission')
    const scopeOptions = dockOptions.allowed.filter(
      (option) => option.id !== dockOptions.allowOnce?.id
    )
    return (
      <div
        ref={dockRef}
        tabIndex={-1}
        role="alertdialog"
        aria-label={approvalTitle}
        data-testid="hil-card"
        data-hil-kind="permission"
        data-interaction-request-id={item.requestId}
        data-hil-resolved="false"
        data-hil-state={item.hilState ?? 'pending'}
        className="min-w-0 outline-none focus-visible:shadow-[var(--vds-focus-brand)]"
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.repeat || submitting) return
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
        <ConfirmationCard
          title={approvalTitle}
          compact={commandApproval}
          description={commandApproval ? t('stream.hil.access.description') : summary}
          details={
            commandApproval
              ? [
                  ...(item.path
                    ? [
                        {
                          id: 'path',
                          label: t('stream.hil.access.path'),
                          value: item.path,
                          highlighted: true,
                        },
                      ]
                    : []),
                  {
                    id: 'operation',
                    label: t('stream.hil.access.operation'),
                    value: t('stream.hil.access.commandOperation'),
                  },
                  {
                    id: 'scope',
                    label: t('stream.hil.access.scope'),
                    value: t('stream.hil.access.commandScope'),
                  },
                  {
                    id: 'command',
                    label: t('stream.hil.access.commandDetails'),
                    value: (
                      <span>
                        {item.reason && <span>{item.reason} </span>}
                        <span data-testid="hil-command-details">{codeText}</span>
                      </span>
                    ),
                  },
                ]
              : undefined
          }
          risk={commandApproval || item.safetyTags?.includes('destructive') ? 'high' : 'normal'}
          disabled={submitting}
          allowVisible={Boolean(dockOptions.allowOnce)}
          allowLabel={submitting ? t('stream.hil.submitting') : t('stream.hil.allowOnce')}
          denyLabel={t('stream.hil.deny')}
          allowAttributes={{
            'data-testid': `hil-permission-${dockOptions.allowOnce?.id}`,
            'data-hil-decision': 'allow-once',
          }}
          denyAttributes={{
            'data-testid': `hil-permission-${dockOptions.deny.id}`,
            'data-hil-decision': 'deny',
          }}
          onAllow={answerOnce}
          onDeny={deny}
        >
          {queueCount > 1 && (
            <span>{hilT('queuePosition', { current: 1, total: queueCount })}</span>
          )}
          {!commandApproval && codeText && !summary.includes(codeText.trim()) && (
            <pre className="max-h-[var(--vds-authorization-list-max-height)] overflow-auto whitespace-pre-wrap break-words font-[family-name:var(--vds-font-code)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
              {codeText}
            </pre>
          )}
          {(item.path || item.networkTarget || item.permissions || item.diff) && (
            <div
              data-testid="hil-permission-details"
              className="grid min-w-0 gap-[var(--vds-space-2)] break-words text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]"
            >
              {!commandApproval && item.path && (
                <div>
                  {t('stream.hil.pathLabel')}
                  {item.path}
                </div>
              )}
              {item.networkTarget && (
                <div>
                  {t('stream.hil.networkTargetLabel')}
                  {fmtVal(item.networkTarget, t)}
                </div>
              )}
              {item.permissions && (
                <div>
                  {t('stream.hil.extraPermissionsLabel')}
                  {fmtVal(item.permissions, t)}
                </div>
              )}
              {item.diff && (
                <pre
                  data-testid="hil-file-diff"
                  className="max-h-[var(--vds-authorization-list-max-height)] overflow-auto whitespace-pre-wrap"
                >
                  {item.diff}
                </pre>
              )}
            </div>
          )}
          {item.hilState === 'failed' && (
            <span
              className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--c-tension)]"
              data-testid="hil-submit-error"
            >
              {t('stream.hil.submitFailed', {
                message:
                  (item.submissionRequestFailure
                    ? formatApplicationRequestFailure(item.submissionRequestFailure, hilT)
                    : formatHilSubmissionError(item, t)) || t('stream.hil.notConfirmedRetry'),
              })}
            </span>
          )}
          {scopeOptions.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-[var(--vds-space-2)]">
              {scopeOptions.map((option) => {
                const info = scopeInfo(option, item, t)
                return (
                  <Button
                    key={option.id}
                    variant="outline"
                    size="md"
                    type="button"
                    data-testid={`hil-permission-${option.id}`}
                    data-hil-decision={option.id}
                    title={info.caption}
                    disabled={submitting}
                    onClick={() =>
                      answerPermission(option.id, info.short, {
                        kind: 'allowedScope',
                        scope: hilPermissionScope(option, item.prefixKind),
                      })
                    }
                  >
                    {info.short}
                  </Button>
                )
              })}
            </div>
          )}
        </ConfirmationCard>
      </div>
    )
  }

  const scopeQuestion = questions[0]
  if (
    !done &&
    questionPolicy?.selectablePapers !== undefined &&
    questions.length === 1 &&
    (!questionPolicy.selectablePapers || scopeQuestion.papers?.length) &&
    (!scopeQuestion.component ||
      (scopeQuestion.component.plugin === PUBLIC_COMPONENT_PLUGIN &&
        scopeQuestion.component.component ===
          (questionPolicy.selectablePapers
            ? LITERATURE_AUTHORIZATION_SLOTS.selectable
            : LITERATURE_AUTHORIZATION_SLOTS.fixed)))
  ) {
    const selectedIds = subsetIdsFor(0, scopeQuestion)
    const primary = scopeQuestion.options.find((option) => questionPolicy.isPrimaryOption?.(option))
    const secondary = scopeQuestion.options.find(
      (option) => !questionPolicy.isPrimaryOption?.(option)
    )
    if (primary && secondary && scopeQuestion.component)
      return (
        <div
          className="flex !min-h-0 !min-w-0 flex-[1_1_auto] flex-col"
          data-testid="hil-card"
          data-hil-kind="question"
          data-interaction-request-id={item.requestId}
          data-hil-resolved="false"
          data-hil-state={item.hilState ?? 'pending'}
        >
          <PluginInteraction
            reference={scopeQuestion.component}
            previewMount={previewMount}
            data={{
              ...scopeQuestion.componentData,
              papers: scopeQuestion.papers ?? [],
              selected_paper_ids: selectedIds,
              authorization_card: true,
            }}
            status={submitting ? 'submitting' : 'pending'}
            renderHosted={
              questionPolicy.selectablePapers
                ? ({ data, status, onAction }) => (
                    <LiteratureAuthorizationCard
                      selectable
                      papers={scopeQuestion.papers ?? []}
                      selectedPaperIds={fulltextSelection(scopeQuestion, data, true) ?? selectedIds}
                      expanded={authorizationOpen}
                      disabled={status !== 'pending'}
                      onExpandedChange={setAuthorizationOpen}
                      onSelectionChange={(selected) =>
                        onAction(LITERATURE_AUTHORIZATION_ACTIONS.select, {
                          selected_paper_ids: selected,
                        })
                      }
                      onAllow={() =>
                        onAction(LITERATURE_AUTHORIZATION_ACTIONS.authorize, {
                          selected_paper_ids: data.selected_paper_ids,
                        })
                      }
                      onDeny={() =>
                        onAction(LITERATURE_AUTHORIZATION_ACTIONS.reject, {
                          selected_paper_ids: data.selected_paper_ids,
                        })
                      }
                    />
                  )
                : undefined
            }
            prepareDraft={(values) => {
              const selected = fulltextSelection(
                scopeQuestion,
                values,
                Boolean(questionPolicy.selectablePapers)
              )
              if (!selected) throw new Error('invalid_authorization_selection')
              return { selected_paper_ids: selected }
            }}
            onRestore={(values) => {
              const restored = fulltextSelection(
                scopeQuestion,
                values,
                Boolean(questionPolicy.selectablePapers)
              )
              if (restored) setSubsetPicks((previous) => ({ ...previous, 0: restored }))
            }}
            onAction={(action, values) => {
              if (
                action !== LITERATURE_AUTHORIZATION_ACTIONS.select &&
                action !== LITERATURE_AUTHORIZATION_ACTIONS.authorize &&
                action !== LITERATURE_AUTHORIZATION_ACTIONS.reject
              )
                return
              const selected = fulltextSelection(
                scopeQuestion,
                values,
                Boolean(questionPolicy.selectablePapers),
                action === LITERATURE_AUTHORIZATION_ACTIONS.authorize
              )
              if (!selected) return
              if (action === LITERATURE_AUTHORIZATION_ACTIONS.select) {
                if (questionPolicy.selectablePapers)
                  setSubsetPicks((previous) => ({ ...previous, 0: selected }))
              } else
                decideQuestion(
                  scopeQuestion,
                  action === LITERATURE_AUTHORIZATION_ACTIONS.authorize ? primary : secondary,
                  selected
                )
            }}
            renderContainer={(content, component) => {
              if (questionPolicy.selectablePapers) return content
              const complete = [
                LITERATURE_AUTHORIZATION_ACTIONS.authorize,
                LITERATURE_AUTHORIZATION_ACTIONS.reject,
              ].every((action) =>
                component?.actions.some(
                  (declaration) =>
                    declaration.id === action && declaration.capability === PLUGIN_ANSWER_CAPABILITY
                )
              )
              if (!complete && !questionPolicy.selectablePapers)
                return (
                  <LiteratureAuthorizationCard
                    selectable={false}
                    papers={scopeQuestion.papers ?? []}
                    selectedPaperIds={selectedIds}
                    expanded={false}
                    disabled={submitting}
                    onExpandedChange={setAuthorizationOpen}
                    onSelectionChange={(paperIds) =>
                      setSubsetPicks((previous) => ({ ...previous, 0: paperIds }))
                    }
                    onAllow={() => decideQuestion(scopeQuestion, primary, selectedIds)}
                    onDeny={() => decideQuestion(scopeQuestion, secondary, selectedIds)}
                  />
                )
              return complete ? (
                content
              ) : (
                <ConfirmationCard
                  compact
                  title={localization.t('review.authorization.scopeTitle', { ns: 'literature' })}
                  description={localization.t('review.authorization.scopeDescription', {
                    ns: 'literature',
                  })}
                  allowLabel={localization.t('review.authorization.authorize', {
                    ns: 'literature',
                  })}
                  denyLabel={localization.t('review.authorization.reject', { ns: 'literature' })}
                  disabled={submitting}
                  allowDisabled={
                    Boolean(questionPolicy.selectablePapers) && selectedIds.length === 0
                  }
                  onAllow={() => decideQuestion(scopeQuestion, primary, selectedIds)}
                  onDeny={() => decideQuestion(scopeQuestion, secondary, selectedIds)}
                >
                  {content}
                </ConfirmationCard>
              )
            }}
          />
          {(item.hilState === 'failed' || editingError) && <div role="alert">{pill}</div>}
        </div>
      )
    if (primary && secondary)
      return (
        <div
          className="flex !min-h-0 !min-w-0 flex-[1_1_auto] flex-col"
          data-testid="hil-card"
          data-hil-kind="question"
          data-interaction-request-id={item.requestId}
          data-hil-resolved="false"
          data-hil-state={item.hilState ?? 'pending'}
        >
          <LiteratureAuthorizationCard
            selectable={questionPolicy.selectablePapers}
            papers={scopeQuestion.papers ?? []}
            selectedPaperIds={selectedIds}
            expanded={authorizationOpen}
            disabled={submitting}
            onExpandedChange={setAuthorizationOpen}
            onSelectionChange={(paperIds) =>
              setSubsetPicks((previous) => ({ ...previous, 0: paperIds }))
            }
            onAllow={() => decideQuestion(scopeQuestion, primary, selectedIds)}
            onDeny={() => decideQuestion(scopeQuestion, secondary, selectedIds)}
          >
            {(item.hilState === 'failed' || editingError) && <div role="alert">{pill}</div>}
          </LiteratureAuthorizationCard>
        </div>
      )
  }

  const scrollableQuestion = presentation === 'dock' && isQuestion && !done

  return (
    <Collapsible
      open={!isQuestion || fixedClarification || questionOpen}
      onOpenChange={setQuestionOpen}
      data-testid="hil-card"
      data-hil-kind={isQuestion ? 'question' : 'permission'}
      data-clarification-paged={fixedClarification || undefined}
      data-interaction-request-id={item.requestId}
      data-hil-resolved={done ? 'true' : 'false'}
      data-hil-state={item.hilState ?? 'pending'}
      onInputCapture={(event) => {
        const target = event.target as HTMLTextAreaElement
        if (isQuestion && target.tagName === 'TEXTAREA' && target.value.trim()) void markEditing()
      }}
      className={cx(
        presentation === 'dock'
          ? 'mb-0 min-w-0 p-[var(--vds-space-4)]'
          : 'my-[var(--vds-conversation-block-gap)] min-w-0 p-[var(--vds-space-4)]',
        'border border-solid border-[var(--vds-border-default)]',
        /* 权限卡保持 raised 表面；问句卡标题行按执行计划卡片的紧凑间距组合。 */
        isQuestion
          ? 'rounded-[var(--vds-radius-6)] bg-[var(--vds-bg-white-default)] !p-0'
          : 'rounded-[var(--vds-radius-6)] bg-[var(--vds-surface-raised)]',
        scrollableQuestion && '!flex min-h-0 flex-1 flex-col overflow-hidden'
      )}
    >
      {fixedClarification ? (
        <div className="flex shrink-0 items-start justify-between gap-[var(--vds-space-2)] px-[var(--vds-space-4)] pt-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
          <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
            <IconFont
              type="line-tool-batch-follow-up"
              className="shrink-0 text-[length:var(--vds-icon-7)]"
            />
            <span role="status">{pill}</span>
          </div>
          <span data-testid="hil-question-position" className="shrink-0">
            {visibleQuestionPage} / {qs.length}
          </span>
        </div>
      ) : isQuestion ? (
        <CollapsibleTrigger asChild>
          <Button
            unstyled
            className="group flex w-full min-w-0 items-center gap-[var(--vds-space-2)] !border-0 !bg-transparent !px-[var(--vds-space-3)] !py-[var(--vds-space-2)] text-left !shadow-none"
            data-testid="hil-question-toggle"
          >
            <span className="shrink-0 transition-transform [[data-state=open]>&]:rotate-90">
              <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              {questionPolicy ? (
                <span className="block min-w-0 font-[var(--vds-font-serif)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-subhead)] text-[var(--text)] [overflow-wrap:anywhere]">
                  {typeof questionPolicy.title === 'function'
                    ? questionPolicy.title(localization)
                    : questionPolicy.title}
                </span>
              ) : null}
              {pill}
              {item.timeoutCancelled && (
                <span className="block text-[var(--vds-text-secondary)]">
                  {hilT('clarification.editing')}
                </span>
              )}
            </span>
            {plainClarification && (
              <span
                data-testid="hil-question-position"
                className="shrink-0 text-[var(--vds-text-secondary)]"
              >
                {visibleQuestionPage} / {qs.length}
              </span>
            )}
          </Button>
        </CollapsibleTrigger>
      ) : (
        <div>
          <div
            style={{
              minWidth: 0,
              fontFamily: 'var(--font-serif)',
              fontSize: 17.5,
              fontWeight: 600,
              color: 'var(--text)',
              lineHeight: 1.35,
              overflowWrap: 'anywhere',
            }}
          >
            {title}
          </div>
          {pill}
        </div>
      )}

      {isQuestion ? (
        <CollapsibleContent
          className={cx(
            'mx-[var(--vds-space-4)] mb-[var(--vds-space-4)] !rounded-none !border-0 !bg-transparent !p-0',
            fixedClarification ? 'mt-[var(--vds-space-3)]' : 'mt-[var(--vds-space-1)]',
            scrollableQuestion && 'flex min-h-0 flex-1 flex-col'
          )}
        >
          {editingError && (
            <Button variant="ghost" size="sm" onClick={() => void markEditing()}>
              {hilT('clarification.editingFailed')}
            </Button>
          )}
          {plainClarification && !fixedClarification && (
            <div className="mb-[var(--vds-space-4)] flex flex-wrap items-center gap-[var(--vds-space-2)] text-[var(--vds-text-primary)]">
              <IconFont type="line-tool-batch-follow-up" />
              <strong className="text-[length:var(--vds-font-body-lv2)]">
                {hilT('reply.title')}
              </strong>
              <span className="text-[var(--vds-text-tertiary)]">
                {hilT('clarification.scrollHint')}
              </span>
            </div>
          )}
          <ScrollArea
            viewportRef={questionViewport}
            className={cx(scrollableQuestion && 'grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)]')}
            viewportClassName={cx(scrollableQuestion && 'min-h-0')}
            viewportProps={{
              'data-testid': 'hil-question-scroll-area',
              onWheel: () => {
                questionNavigation.current = null
              },
              onTouchStart: () => {
                questionNavigation.current = null
              },
              onPointerDown: () => {
                questionNavigation.current = null
              },
              onKeyDown: () => {
                questionNavigation.current = null
              },
              onScroll: (event) => {
                if (fixedClarification) return
                const viewport = event.currentTarget
                const top = viewport.getBoundingClientRect().top
                const offsets = questionNodes.current.map((node) =>
                  node ? node.getBoundingClientRect().top - top + viewport.scrollTop : 0
                )
                const atEnd =
                  viewport.scrollTop > 0 &&
                  Math.ceil(viewport.scrollTop + viewport.clientHeight) >= viewport.scrollHeight
                const navigation = questionNavigation.current
                setQuestionPage(
                  questionAtScroll(
                    offsets,
                    viewport.scrollTop,
                    atEnd,
                    navigation?.scrollTop === viewport.scrollTop ? navigation.index : undefined
                  ) + 1
                )
              },
            }}
          >
            {questionPolicy?.directDecision &&
            questionPolicy.directPresentation === 'primary-secondary' ? (
              <div className="grid gap-[var(--vds-space-4)]">
                {qs.map((q, qi) => {
                  const subsetIds = subsetIdsFor(qi, q)
                  const selectedCount =
                    q.papers?.filter((paper) => subsetIds.includes(paper.id)).length ?? 0
                  const selectAllState: boolean | 'mixed' =
                    selectedCount === 0
                      ? false
                      : selectedCount === (q.papers?.length ?? 0)
                        ? true
                        : 'mixed'
                  return (
                    <div className="grid gap-[var(--vds-space-3)]" key={qi}>
                      <div className="min-w-0 whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
                        {presentedQuestions[qi]?.question ?? q.question}
                      </div>
                      {q.component && (
                        <PluginInteraction
                          reference={q.component}
                          previewMount={previewMount}
                          onRestore={(values) => {
                            if (
                              Array.isArray(values.selected_paper_ids) &&
                              values.selected_paper_ids.every(
                                (id) =>
                                  typeof id === 'string' &&
                                  q.papers?.some((paper) => paper.id === id)
                              )
                            )
                              setSubsetPicks((previous) => ({
                                ...previous,
                                [qi]: values.selected_paper_ids as string[],
                              }))
                          }}
                          data={{
                            ...q.componentData,
                            ...(q.papers
                              ? { papers: q.papers, selected_paper_ids: subsetIds }
                              : {}),
                          }}
                          status={done ? 'resolved' : submitting ? 'submitting' : 'pending'}
                          onAction={(_action, values) => {
                            const selected = values.selected_paper_ids
                            if (
                              !Array.isArray(selected) ||
                              selected.some(
                                (id) =>
                                  typeof id !== 'string' ||
                                  !q.papers?.some((paper) => paper.id === id)
                              ) ||
                              new Set(selected).size !== selected.length
                            )
                              return
                            setSubsetPicks((previous) => ({
                              ...previous,
                              [qi]: selected as string[],
                            }))
                          }}
                        />
                      )}
                      {!q.component && !done && q.papers && q.papers.length > 0 && (
                        <div
                          aria-label={localization.t('review.authorization.subsetHint', {
                            ns: 'literature',
                          })}
                          className="flex flex-col gap-[var(--vds-space-2)]"
                          role="group"
                        >
                          <div className="min-w-0 whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]">
                            {localization.t('review.authorization.subsetHint', {
                              ns: 'literature',
                            })}
                          </div>
                          <Checkbox
                            checked={selectAllState}
                            className="min-w-0"
                            data-testid={`hil-subset-all-${qi}`}
                            disabled={submitting}
                            label={localization.t('review.authorization.subsetSelectAll', {
                              ns: 'literature',
                            })}
                            onCheckedChange={(checked) =>
                              setSubsetPicks((prev) => ({
                                ...prev,
                                [qi]: checked ? (q.papers?.map((item) => item.id) ?? []) : [],
                              }))
                            }
                            type="button"
                          />
                          {q.papers.map((paper) => {
                            const selected = subsetIds.includes(paper.id)
                            return (
                              <Checkbox
                                align="first-line"
                                aria-label={`${paper.label}${paper.description ? ` ${paper.description}` : ''}`}
                                checked={selected}
                                className="min-w-0"
                                data-testid={`hil-subset-paper-${qi}-${paper.id}`}
                                disabled={submitting}
                                key={paper.id}
                                onCheckedChange={() =>
                                  setSubsetPicks((prev) => {
                                    const current =
                                      prev[qi] ?? q.papers?.map((item) => item.id) ?? []
                                    const next = current.includes(paper.id)
                                      ? current.filter((id) => id !== paper.id)
                                      : [...current, paper.id]
                                    return { ...prev, [qi]: next }
                                  })
                                }
                                type="button"
                              >
                                {paper.label}
                              </Checkbox>
                            )
                          })}
                        </div>
                      )}
                      {!done && (
                        <div
                          aria-label={presentedQuestions[qi]?.header || q.header || q.question}
                          className="flex min-w-0 items-center gap-[var(--vds-space-3)] border-t border-[var(--vds-divider-default)] pt-[var(--vds-space-3)]"
                          role="group"
                        >
                          {q.options.map((option, optionIndex) => {
                            const decision = questionPolicy.directDecision?.(q, option)
                            const requiresSelection =
                              questionPolicy.directSelectionRequired?.(option) ?? false
                            const primary = decision === 'respond'
                            const subset = q.papers?.length ? subsetIds : undefined
                            return (
                              <Button
                                className={
                                  primary
                                    ? 'min-w-0 flex-1'
                                    : 'flex-none text-[var(--vds-text-secondary)]'
                                }
                                data-hil-decision={decision}
                                data-testid={`hil-question-option-${qi}-${optionIndex}`}
                                disabled={submitting || (requiresSelection && subset?.length === 0)}
                                key={optionIndex}
                                onClick={() => decideQuestion(q, option, subset)}
                                size={primary ? 'md' : 'sm'}
                                type="button"
                                variant={primary ? 'primary' : 'ghost'}
                              >
                                {presentedQuestions[qi]?.options[optionIndex]?.label ??
                                  questionPolicy.optionLabel?.(option) ??
                                  option.label}
                              </Button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              qs.map((q, qi) =>
                fixedClarification && qi !== visibleQuestionPage - 1 ? null : (
                  <div
                    key={qi}
                    ref={(node) => {
                      questionNodes.current[qi] = node
                    }}
                    onFocusCapture={() => setQuestionPage(qi + 1)}
                    style={{ marginBottom: !fixedClarification && qi < qs.length - 1 ? 16 : 0 }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        fontFamily: 'var(--font-serif)',
                        fontSize: 14.5,
                        color: 'var(--text)',
                        marginBottom: 'var(--vds-space-3)',
                        lineHeight: 1.5,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      <QuestionPrompt presentation={q.presentation}>
                        {plainClarification && `${qi + 1}. `}
                        {presentedQuestions[qi]?.question ?? q.question}
                        {plainClarification && q.options.length > 0 && (
                          <span className="ml-[var(--vds-space-2)] text-[var(--vds-text-tertiary)]">
                            {hilT(
                              q.multiSelect ? 'clarification.multiple' : 'clarification.single'
                            )}
                          </span>
                        )}
                      </QuestionPrompt>
                    </div>
                    {q.installation ? (
                      <PluginInstallation
                        report={q.installation}
                        done={done}
                        busy={submitting}
                        session={sid}
                        request={item.requestId ?? ''}
                        answer={item.answers?.[q.id || q.question]}
                        onAnswer={async (receipt) => {
                          const answers = receipt
                            ? { [q.id || q.question]: JSON.stringify(receipt) }
                            : undefined
                          await submitAction({
                            kind: 'respond',
                            body: answers ? { answers } : { cancelled: true },
                            answers,
                            label: t('stream.hil.answered'),
                            resolvedMessage: { kind: 'answered' },
                          })
                        }}
                      />
                    ) : q.component && q.options.length === 0 ? (
                      <PluginInteraction
                        reference={q.component}
                        previewMount={previewMount}
                        data={q.componentData ?? {}}
                        contentRevision={q.componentRevision}
                        status={
                          item.hilState === 'cancelled'
                            ? 'cancelled'
                            : done
                              ? 'resolved'
                              : submitting
                                ? 'submitting'
                                : q.component?.component === CANVAS_SLOT &&
                                    item.hilState === 'unknown'
                                  ? 'unknown'
                                  : 'pending'
                        }
                        onAction={(action, values, contentRevision) => {
                          if (q.component?.component === CANVAS_SLOT && action === 'cancel') {
                            return submitAction(
                              {
                                kind: 'respond',
                                body: { cancelled: true },
                                label: t('stream.hil.answered'),
                                resolvedMessage: { kind: 'answered' },
                              },
                              true
                            )
                          }
                          if (action === 'cancel') {
                            void submitAction({ kind: 'cancel' })
                            return
                          }
                          const answers = {
                            [q.id || q.header || q.question]: JSON.stringify({
                              action,
                              values,
                              ...(q.component?.component === OPENUI_SLOT
                                ? { content_revision: contentRevision ?? 0 }
                                : {}),
                            }),
                          }
                          return submitAction(
                            {
                              kind: 'respond',
                              body: { answers },
                              answers,
                              label: t('stream.hil.answered'),
                              resolvedMessage: { kind: 'answered' },
                            },
                            q.component?.component === CANVAS_SLOT
                          )
                        }}
                      />
                    ) : q.options.length > 0 ? (
                      <div
                        aria-label={presentedQuestions[qi]?.header || q.header || q.question}
                        className="flex flex-col gap-[var(--vds-space-3)]"
                        role={q.multiSelect ? 'group' : 'radiogroup'}
                      >
                        {q.component && (
                          <QuestionOptionsReveal>
                            <PluginInteraction
                              reference={q.component}
                              previewMount={previewMount}
                              onRestore={(values) => {
                                const answers = componentOptionAnswers(q, values)
                                if (answers)
                                  setPicks((previous) => ({
                                    ...previous,
                                    [qi]: answers.map((label) =>
                                      q.options.findIndex((option) => option.label === label)
                                    ),
                                  }))
                                if (typeof values.text === 'string')
                                  setTexts((previous) => ({
                                    ...previous,
                                    [qi]: values.text as string,
                                  }))
                              }}
                              prepareDraft={(values) => ({ ...values })}
                              supplement={(save) =>
                                !done && !questionPolicy?.directDecision ? (
                                  <Textarea
                                    data-testid={`hil-question-other-${qi}`}
                                    aria-label={t('stream.otherAnswer')}
                                    placeholder={t('stream.otherAnswerPlaceholder')}
                                    rows={2}
                                    disabled={submitting}
                                    value={texts[qi] || ''}
                                    className="mt-[var(--vds-space-3)] w-full resize-y placeholder:font-[number:var(--vds-fw-regular)]"
                                    onChange={(event) => {
                                      const value = event.target.value
                                      setTexts((previous) => ({ ...previous, [qi]: value }))
                                      void save({
                                        text: value,
                                      }).catch(() => undefined)
                                    }}
                                  />
                                ) : null
                              }
                              data={{
                                ...q.componentData,
                                question: q.question,
                                displayQuestion: presentedQuestions[qi]?.question ?? q.question,
                                options: q.options.map((option, index) => ({
                                  ...option,
                                  displayLabel:
                                    presentedQuestions[qi]?.options[index]?.label ??
                                    questionPolicy?.optionLabel?.(option) ??
                                    option.label,
                                  displayDescription:
                                    presentedQuestions[qi]?.options[index]?.description ??
                                    option.description,
                                })),
                                multiSelect: q.multiSelect,
                                answers: done
                                  ? q.options
                                      .filter((option) =>
                                        String(item.answers?.[q.id || q.header || q.question] ?? '')
                                          .split('\n')[0]
                                          .split(', ')
                                          .includes(
                                            questionPolicy?.optionLabel?.(option) ?? option.label
                                          )
                                      )
                                      .map((option) => option.label)
                                  : (picks[qi] ?? []).map((index) => q.options[index]?.label),
                              }}
                              status={
                                item.hilState === 'cancelled'
                                  ? 'cancelled'
                                  : done
                                    ? 'resolved'
                                    : submitting
                                      ? 'submitting'
                                      : 'pending'
                              }
                              onAction={(_action, values) => {
                                const answers = componentOptionAnswers(q, values)
                                if (!answers) return
                                if (questionPolicy?.directDecision && answers.length === 1) {
                                  decideQuestion(
                                    q,
                                    q.options.find((option) => option.label === answers[0])!
                                  )
                                  return
                                }
                                setPicks((previous) => ({
                                  ...previous,
                                  [qi]: answers.map((label) =>
                                    q.options.findIndex((option) => option.label === label)
                                  ),
                                }))
                              }}
                            />
                          </QuestionOptionsReveal>
                        )}
                        {!q.component &&
                          q.options.map((o, i) => {
                            // 已答态按会话项里的 answers 回显勾选 (多选按 ', ' 拆回 label 列表);
                            // 未答态才用组件本地 picks —— 否则 resolved 后勾选被清空, 卡片像没答过。
                            const answered = done
                              ? String((item.answers ?? {})[q.id || q.header || q.question] ?? '')
                              : ''
                            const on = done
                              ? answered
                                  .split('\n')[0]
                                  .split(', ')
                                  .includes(questionPolicy?.optionLabel?.(o) ?? o.label)
                              : (picks[qi] ?? []).includes(i)
                            return (
                              <QuestionOption
                                key={i}
                                testId={`hil-question-option-${qi}-${i}`}
                                disabled={done || submitting}
                                checked={on}
                                multiSelect={q.multiSelect}
                                label={
                                  presentedQuestions[qi]?.options[i]?.label ??
                                  questionPolicy?.optionLabel?.(o) ??
                                  o.label
                                }
                                description={
                                  presentedQuestions[qi]?.options[i]?.description ?? o.description
                                }
                                onSelect={() => {
                                  if (questionPolicy?.directDecision) {
                                    decideQuestion(q, o)
                                    return
                                  }
                                  toggle(qi, i, !!q.multiSelect)
                                }}
                              />
                            )
                          })}
                        {done ? (
                          item.answers?.[q.id || q.header || q.question] && (
                            <p className="m-0 whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                              {t('stream.submittedAnswer')}
                              {questionPolicy?.presentAnswer?.(
                                q,
                                item.answers[q.id || q.header || q.question],
                                localization
                              ) ?? item.answers[q.id || q.header || q.question]}
                            </p>
                          )
                        ) : questionPolicy?.directDecision || q.component ? null : (
                          <Textarea
                            data-testid={`hil-question-other-${qi}`}
                            aria-label={t('stream.otherAnswer')}
                            placeholder={
                              plainClarification
                                ? hilT('clarification.supplement')
                                : t('stream.otherAnswerPlaceholder')
                            }
                            rows={2}
                            disabled={submitting}
                            value={texts[qi] || ''}
                            onChange={(event) => {
                              const value = event.target.value
                              setTexts((t) => ({ ...t, [qi]: value }))
                            }}
                            className="w-full resize-y placeholder:font-[number:var(--vds-fw-regular)]"
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
                                (item.answers ?? {})[q.id || q.header || q.question] ??
                                  texts[qi] ??
                                  ''
                              )
                            : texts[qi] || ''
                        }
                        onChange={(e) => setTexts((t) => ({ ...t, [qi]: e.target.value }))}
                        className="box-border w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-[10px] py-[var(--vds-space-2)] text-[13px] text-[var(--text)] [font:inherit]"
                      />
                    )}
                  </div>
                )
              )
            )}
          </ScrollArea>
          {pagedQuestions && !fixedClarification && !plainClarification && (
            <div
              className="mt-[var(--vds-space-3)] flex flex-wrap items-center justify-between gap-[var(--vds-space-2)]"
              data-testid="hil-question-pages"
            >
              <span className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
                {visibleQuestionPage} / {qs.length}
              </span>
              <Pagination
                page={visibleQuestionPage}
                pageCount={qs.length}
                disabled={submitting}
                onPageChange={goToQuestion}
              />
            </div>
          )}
          {!done &&
            !questionPolicy?.directDecision &&
            !questions.every(
              (question) =>
                question.installation || (question.component && question.options.length === 0)
            ) && (
              <div
                className="mt-[var(--vds-space-4)] flex flex-none items-center justify-end gap-[var(--vds-space-2)]"
                data-testid="hil-question-actions"
              >
                {plainClarification && (
                  <span className="mr-auto text-[var(--vds-text-tertiary)]">
                    {hilT('clarification.directReply')}
                  </span>
                )}
                <Button
                  variant={fixedClarification || plainClarification ? 'ghost' : 'outline'}
                  size="sm"
                  type="button"
                  data-testid="hil-question-skip"
                  disabled={submitting}
                  onClick={() => {
                    if (fixedClarification) {
                      const index = visibleQuestionPage - 1
                      if (visibleQuestionPage < qs.length) {
                        setSkippedQuestions((previous) => [...previous, index])
                        goToQuestion(visibleQuestionPage + 1)
                      } else {
                        submitQuestion(index)
                      }
                      return
                    }
                    const answers = plainClarification ? {} : (questionPolicy?.defaults?.(qs) ?? {})
                    void submitAction({
                      kind: 'respond',
                      body: { answers },
                      label: questionPolicy?.defaultLabel ?? t('stream.hil.skipped'),
                      answers,
                    })
                  }}
                >
                  {t('stream.hil.skip')}
                </Button>
                {(fixedClarification || plainClarification) &&
                  pagedQuestions &&
                  visibleQuestionPage > 1 && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="hil-question-previous"
                      disabled={submitting}
                      onClick={() => goToQuestion(visibleQuestionPage - 1)}
                    >
                      {hilT('clarification.previous')}
                    </Button>
                  )}
                {(fixedClarification || plainClarification) &&
                pagedQuestions &&
                visibleQuestionPage < qs.length ? (
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="hil-question-next"
                    disabled={submitting || !questionAnswered(visibleQuestionPage - 1)}
                    onClick={() => {
                      setSkippedQuestions((previous) =>
                        previous.filter((index) => index !== visibleQuestionPage - 1)
                      )
                      goToQuestion(visibleQuestionPage + 1)
                    }}
                  >
                    {hilT('clarification.next')}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    type="button"
                    data-testid="hil-question-confirm"
                    disabled={submitting || !questionComplete}
                    onClick={() => submitQuestion()}
                  >
                    {fixedClarification || plainClarification
                      ? hilT('clarification.submit')
                      : t('stream.hil.confirm')}
                  </Button>
                )}
              </div>
            )}
        </CollapsibleContent>
      ) : (
        <>
          {(item.toolName || item.workdir || item.safetyTags) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 7,
              }}
            >
              {item.toolName && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    color: 'var(--text-3)',
                  }}
                >
                  {item.toolName.toLowerCase()}
                </span>
              )}
              {item.workdir && <Chip label={shortPath(item.workdir)} />}
              {(item.safetyTags ?? []).map((tag) => (
                <Chip key={tag} label={safetyTagLabel(tag, t)} tone={TAG_TONE[tag]} />
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
                    transition: 'transform .15s',
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
                    overflow: 'auto',
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
                lineHeight: 1.6,
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
                color: 'var(--text-2)',
              }}
            >
              {item.path && (
                <div>
                  <b>{t('stream.hil.pathLabel')}</b>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{item.path}</span>
                </div>
              )}
              {item.networkTarget && (
                <div>
                  <b>{t('stream.hil.networkTargetLabel')}</b>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{item.networkTarget}</span>
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
                wordBreak: 'break-word',
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
                      'min-h-[var(--vds-control-height-lg)] cursor-pointer whitespace-nowrap rounded-lg border px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] disabled:cursor-default disabled:opacity-60',
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
                      answerPermission(o.id, t('stream.hil.allowedScope', { scope: oi.short }), {
                        kind: 'allowedScope',
                        scope: hilPermissionScope(o, item.prefixKind),
                      })
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
                  'min-h-[var(--vds-control-height-lg)] cursor-pointer whitespace-nowrap rounded-lg border border-[var(--border)] bg-transparent px-[var(--vds-space-4)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-2)] disabled:cursor-default disabled:opacity-60'
                )}
                disabled={submitting}
                onClick={() =>
                  answerPermission(denyOpt.id, t('stream.hil.denied'), {
                    kind: 'denied',
                  })
                }
              >
                {t('stream.hil.deny')}
              </Button>
            </div>
          )}
        </>
      )}
      {!done &&
        item.hilState === 'failed' &&
        lastAction &&
        !questions.some((question) => question.installation) &&
        (item.hilKind !== 'question' ||
          questions.every((question) => question.component && question.options.length === 0)) && (
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
    </Collapsible>
  )
}

function PromptCard({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <div
      style={{
        background: 'var(--bg-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '13px 16px',
        marginBottom: 30,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 7,
        }}
      >
        {t('stream.task')}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-serif)',
          fontSize: 15,
          color: 'var(--text-2)',
          lineHeight: 1.55,
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
  selectionEnabled = true,
}: {
  text: string
  itemId?: string
  selectionEnabled?: boolean
}): React.JSX.Element {
  const messageId = itemId ? `item:${itemId}` : undefined
  const markdownClassName =
    '!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-conversation-answer-line-height)] text-[var(--text-2)] [&>*:last-child]:mb-0'
  return (
    <div className="min-w-0" data-testid="turn-commentary">
      {messageId ? (
        <AnnotatedAnswer
          citationEnabled={false}
          text={text}
          selectionEnabled={selectionEnabled}
          messageId={messageId}
          markdownClassName={markdownClassName}
        />
      ) : (
        <Markdown text={text} math className={markdownClassName} />
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
        margin: '4px 0 26px',
      }}
    >
      <span style={{ fontSize: 10, letterSpacing: '0.2em', color: 'var(--text-3)' }}>{text}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border-soft)' }} />
    </div>
  )
}

function Reentry({ item }: { item: Extract<ConvItem, { kind: 'reentry' }> }): React.JSX.Element {
  const { t } = useTranslation('components')
  const { set, act } = useApp()
  return (
    <div
      style={{
        borderLeft: '2px solid var(--accent)',
        padding: '2px 0 2px 22px',
        marginBottom: 48,
        animation: 'cardIn .5s ease both',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: 'var(--accent-ink)',
          }}
        >
          {item.topic}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{item.sub}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '14px 20px',
          alignItems: 'baseline',
        }}
      >
        {item.rows.map(([label, value, tone], i) => (
          <React.Fragment key={i}>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</span>
            <span
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                color: tone ? TONE[tone] : 'var(--text)',
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

function UserBubble({
  item,
  skillNames,
  running,
  onRewind,
  sentAt,
}: {
  item: Extract<ConvItem, { kind: 'user' }>
  skillNames: SkillNames
  running: boolean
  onRewind: (anchor: number) => Promise<string | null>
  sentAt?: number
}): React.JSX.Element {
  const { t, i18n: localization } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const displayText = item.displayMessage
    ? renderFeedback(localization, item.displayMessage)
    : item.text
  const hasMessageText = Boolean(displayText.trim())
  const { state, act } = useApp()
  const displayRefs = (item.refs ?? []).map((reference) =>
    reference.type === 'assistant_context' &&
    reference.kind === 'file' &&
    !reference.anchor &&
    reference.sourceId
      ? { ...reference, type: 'file', path: reference.sourceId }
      : reference
  )
  const steer = item.steer
  const imageCount =
    displayRefs?.filter(
      (reference) =>
        reference.type === 'file' &&
        reference.path &&
        isImageAttachment({
          type: 'file',
          id: reference.id,
          title: reference.title,
          path: reference.path,
        })
    ).length ?? 0
  const hasFileAttachments = displayRefs?.some(
    (reference) =>
      reference.path &&
      (reference.type === 'directory' ||
        (reference.type === 'file' &&
          !isImageAttachment({
            type: 'file',
            id: reference.id,
            title: reference.title,
            path: reference.path,
          })))
  )
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState('')
  const canRewind =
    !activeThread(state).readOnly && !steer && !running && item.rewindAnchor !== undefined
  const annotationRefs =
    displayRefs?.filter(
      (reference) => reference.type === 'assistant_context' && reference.kind === 'note'
    ) ?? []
  const annotations = annotationRefs.flatMap((reference) => {
    const annotation = state.aiPanel.annotations.find(
      (candidate) => candidate.annotation_id === reference.sourceId
    )
    return annotation ? [annotationDisplay(annotation)] : []
  })
  const contextRefs =
    displayRefs?.filter(
      (reference) =>
        reference.type === 'assistant_context' &&
        reference.kind !== 'note' &&
        reference.kind !== SESSION_CONTEXT_KIND
    ) ?? []
  const sessionRefs =
    displayRefs?.filter(
      (reference) =>
        reference.type === 'assistant_context' && reference.kind === SESSION_CONTEXT_KIND
    ) ?? []
  const inlineRefs = displayRefs.filter(
    (reference) =>
      reference.type !== 'assistant_context' &&
      ((reference.type !== 'file' && reference.type !== 'directory') || !reference.path)
  )
  const selectionGroups = selectionReferenceGroups(contextRefs)
  const project = state.projects.find(
    (candidate) => candidate.path === activeThread(state).projectPath
  )
  const openContextSource = (reference: MessageReference): void => {
    if (!reference.sourceId) return
    const locator = selectionLocator(reference.anchor?.locator)
    const selection = locator
      ? {
          locator,
          text: reference.anchor?.previewText ?? '',
          sourceRevision: reference.sourceRevision,
        }
      : undefined
    if (reference.kind === LITERATURE_CONTEXT_KIND) {
      if (reference.anchor) {
        void act.openLiteratureAttachment(
          reference.sourceId,
          reference.anchor.documentId,
          undefined,
          { selection }
        )
        return
      }
      if (!project) return
      void act.openLiteratureItem(reference.sourceId, project.id)
      return
    }
    if (!project) return
    if (
      reference.kind === SELECTION_CONTEXT_KIND ||
      OPENABLE_RESOURCE_CONTEXT_KINDS.has(reference.kind ?? '')
    ) {
      act.openResourceFile(reference.sourceId, project.id, undefined, selection)
    }
  }
  const contextSourceLabel = (reference: MessageReference): string => {
    const title = referenceBaseLabel(reference, assistantText)
    if (!reference.anchor && OPENABLE_RESOURCE_CONTEXT_KINDS.has(reference.kind ?? '')) {
      return reference.sourceId?.split('/').filter(Boolean).pop() || title
    }
    return title
  }
  const annotationSummary = (
    <AnnotationSummary
      annotations={annotations}
      className="mb-[var(--vds-space-2)]"
      location={state.aiPanel.answerAnnotationFocus}
      numberForAnnotation={(annotationId, index) => {
        const raw = state.aiPanel.annotations.find((item) => item.annotation_id === annotationId)
        if (!raw) return index + 1
        return (
          state.aiPanel.annotations
            .filter((item) => item.source_item_id === raw.source_item_id)
            .findIndex((item) => item.annotation_id === annotationId) + 1
        )
      }}
      onOpenOriginal={(annotationId) => void act.focusAnswerAnnotation(annotationId)}
      testId="user-message-annotations"
    />
  )
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
    <>
      <div className="group/message mb-[22px] flex justify-end">
        <div
          className={cx(
            'relative grid min-w-0 justify-items-end',
            imageCount > 1 || hasFileAttachments
              ? 'w-full max-w-full'
              : 'w-max max-w-[var(--conversation-user-message-max)]'
          )}
        >
          {(annotations.length > 0 ||
            contextRefs.some(
              (reference) => reference.anchor || reference.kind === 'pdf_comment'
            )) && (
            <ScrollArea
              orientation="horizontal"
              className="mb-[var(--vds-space-3)] min-w-0 max-w-full"
              horizontalControls={{
                previous: assistantText('attachments.scrollPrevious'),
                next: assistantText('attachments.scrollNext'),
                hoverOnly: true,
              }}
              viewportClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
            >
              <div
                data-testid="sent-context-layer-selections"
                className="flex w-max min-w-full flex-nowrap items-center gap-[var(--vds-composer-attachment-gap)] empty:hidden"
              >
                {contextRefs
                  .filter((reference) => reference.kind === 'pdf_comment')
                  .map((reference) => (
                    <PdfCommentReference
                      key={reference.id}
                      id={reference.id}
                      sourceId={reference.sourceId}
                      sourceRevision={reference.sourceRevision}
                      label={reference.title}
                      presentation="sent"
                      testId="sent-pdf-comment"
                    />
                  ))}
                {contextRefs.some(
                  (reference) => reference.anchor && reference.kind !== 'pdf_comment'
                ) && (
                  <SelectionReferences
                    references={contextRefs}
                    label={contextSourceLabel}
                    onOpen={openContextSource}
                  />
                )}
                <AnnotationSummary
                  presentation="sent"
                  annotations={annotations}
                  location={state.aiPanel.answerAnnotationFocus}
                  numberForAnnotation={(annotationId, index) => {
                    const raw = state.aiPanel.annotations.find(
                      (item) => item.annotation_id === annotationId
                    )
                    if (!raw) return index + 1
                    return (
                      state.aiPanel.annotations
                        .filter((item) => item.source_item_id === raw.source_item_id)
                        .findIndex((item) => item.annotation_id === annotationId) + 1
                    )
                  }}
                  onOpenOriginal={(annotationId) => void act.focusAnswerAnnotation(annotationId)}
                  testId="user-message-annotations"
                />
              </div>
            </ScrollArea>
          )}
          {imageCount > 0 && (
            <div
              data-testid="sent-context-layer-images"
              className={cx(
                'mb-[var(--vds-space-3)] min-w-0 max-w-full',
                imageCount > 1 && 'w-full'
              )}
            >
              <SentAttachments
                imagesOnly
                sourceLabel={(ref) => {
                  const reference = displayRefs?.find((candidate) => candidate.id === ref.id)
                  if (!reference?.sourceId) return undefined
                  if (reference.kind === LITERATURE_CONTEXT_KIND)
                    return assistantText('queue.kinds.literature')
                  if (reference.kind === SESSION_CONTEXT_KIND)
                    return assistantText('queue.kinds.session')
                  return OPENABLE_RESOURCE_CONTEXT_KINDS.has(reference.kind ?? '')
                    ? assistantText('queue.kinds.resource')
                    : undefined
                }}
                refs={(displayRefs ?? []).flatMap<ComposerReference>((reference) =>
                  reference.type === 'file' && reference.path
                    ? [
                        {
                          type: 'file',
                          id: reference.id,
                          title: reference.title,
                          path: reference.path,
                          mediaType: reference.mediaType,
                          previewSource:
                            reference.sourceId && reference.kind === 'file' && project
                              ? {
                                  kind: 'project' as const,
                                  project: project.id,
                                  path: reference.sourceId,
                                }
                              : undefined,
                          size: reference.size,
                        },
                      ]
                    : []
                )}
              />
            </div>
          )}
          {(hasFileAttachments ||
            contextRefs.some(
              (reference) => !reference.anchor && reference.kind !== 'pdf_comment'
            )) && (
            <ScrollArea
              orientation="horizontal"
              className="mb-[var(--vds-space-3)] min-w-0 max-w-full"
              horizontalControls={{
                previous: assistantText('attachments.scrollPrevious'),
                next: assistantText('attachments.scrollNext'),
                hoverOnly: true,
              }}
              viewportClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
            >
              <div
                data-testid="sent-context-layer-references"
                className="flex w-max min-w-full flex-nowrap items-center gap-[var(--vds-composer-attachment-gap)] empty:hidden"
              >
                {hasFileAttachments && (
                  <div data-testid="sent-context-layer-files" className="contents">
                    <SentAttachments
                      key={activeThread(state).sessionId}
                      sourceLabel={(ref) =>
                        displayRefs?.some(
                          (reference) =>
                            reference.id === ref.id &&
                            reference.kind === 'file' &&
                            reference.sourceId
                        )
                          ? assistantText('queue.kinds.resource')
                          : undefined
                      }
                      refs={(displayRefs ?? []).flatMap<ComposerReference>(
                        (reference): ComposerReference[] => {
                          if (!reference.path) return []
                          if (reference.type === 'directory')
                            return [
                              {
                                type: 'directory' as const,
                                id: reference.id,
                                title: reference.title,
                                status: reference.status,
                                path: reference.path,
                              },
                            ]
                          if (reference.type === 'file')
                            return [
                              {
                                type: 'file' as const,
                                id: reference.id,
                                title: reference.title,
                                status: reference.status,
                                path: reference.path,
                                mediaType: reference.mediaType,
                                previewSource:
                                  reference.sourceId && reference.kind === 'file' && project
                                    ? {
                                        kind: 'project' as const,
                                        project: project.id,
                                        path: reference.sourceId,
                                      }
                                    : undefined,
                                sha256: reference.sha256,
                                size: reference.size,
                              },
                            ]
                          return []
                        }
                      )}
                    />
                  </div>
                )}
                {contextRefs.some(
                  (reference) => !reference.anchor && reference.kind !== 'pdf_comment'
                ) ? (
                  <div className="contents" data-testid="sent-context-references">
                    {contextRefs
                      .filter((reference) => !reference.anchor && reference.kind !== 'pdf_comment')
                      .map((reference) => {
                        if (
                          reference.kind === LITERATURE_CONTEXT_KIND &&
                          !reference.anchor &&
                          reference.sourceId
                        )
                          return (
                            <LiteratureAttachment
                              showActions
                              key={reference.id}
                              id={reference.sourceId}
                              referenceId={reference.id}
                              title={contextSourceLabel(reference)}
                              onOpen={() => openContextSource(reference)}
                            />
                          )
                        const canOpen = Boolean(
                          reference.sourceId &&
                          (project ||
                            (reference.kind === LITERATURE_CONTEXT_KIND && reference.anchor))
                        )
                        return (
                          <SentReferenceAttachment
                            key={reference.id}
                            disabled={!canOpen}
                            icon={
                              <Icon
                                name={reference.kind === LITERATURE_CONTEXT_KIND ? 'books' : 'doc'}
                                size={12}
                              />
                            }
                            label={contextSourceLabel(reference)}
                            onOpen={() => openContextSource(reference)}
                          />
                        )
                      })}
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          )}
          <div
            className={cx(
              'relative min-w-0',
              imageCount > 1 ? 'max-w-[var(--conversation-user-message-max)]' : 'max-w-full',
              hasMessageText &&
                'box-border w-auto overflow-hidden rounded-[var(--vds-radius-4)] bg-[var(--vds-other-overlay-1)] px-[15px] pb-[12px] pt-[11px]',
              hasMessageText && steer && 'border border-dashed border-[var(--accent)]'
            )}
            data-testid={hasMessageText ? 'user-bubble' : undefined}
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
            <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-1)]">
              {inlineRefs.map((reference) => (
                <SentReferenceAttachment
                  key={reference.type + reference.id}
                  variant={reference.type === 'skill' ? 'text' : 'default'}
                  icon={
                    reference.type === 'skill' ? (
                      <Hammer size={12} />
                    ) : (
                      userMessageRefType(reference.type, t)
                    )
                  }
                  label={
                    reference.type === 'skill'
                      ? skillNames.names.get(reference.id) ||
                        (skillNames.pending && reference.title === reference.id
                          ? t(USER_REFERENCE_TYPE_LABELS.skill)
                          : reference.title)
                      : reference.title
                  }
                  status={reference.type === 'skill' ? undefined : reference.status}
                  title={t('stream.referenceSent', {
                    type: reference.type,
                    id: reference.id,
                  })}
                />
              ))}
              {sessionRefs.map((reference) => (
                <SessionReference
                  currentSessionId={activeThread(state).sessionId}
                  key={reference.id}
                  reference={reference}
                />
              ))}
              {hasMessageText && <UserMessageText text={displayText} />}
            </div>
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
          {hasMessageText && item.text && (
            <MessageActions alignEnd>
              {sentAt !== undefined && Number.isFinite(sentAt) && (
                <time
                  dateTime={new Date(sentAt).toISOString()}
                  className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
                >
                  {userMessageTime(sentAt, localization.resolvedLanguage ?? localization.language)}
                </time>
              )}
              <CopyButton
                type="button"
                size="xs"
                variant="ghostIcon"
                value={displayText}
                writeText={writeDesktopClipboard}
                idleLabel={t('stream.copyMessage')}
                copiedLabel={t('stream.copied')}
                copiedIcon={<Check size={14} />}
                showLoading={false}
                statusStyle={false}
                tooltip
              >
                <Copy size={14} />
              </CopyButton>
            </MessageActions>
          )}
        </div>
      </div>
      {item.cancelled && (
        <StatusLine
          item={{
            kind: 'status',
            text: '',
            displayMessage: feedback('components', 'stream.stopped'),
          }}
        />
      )}
    </>
  )
}

function InteractionReply({
  item,
  expired = false,
  copyAction,
}: {
  item: Extract<ConvItem, { kind: 'interaction_reply' }>
  expired?: boolean
  copyAction?: React.ReactNode
}): React.JSX.Element {
  const { i18n: localization } = useTranslation('literature')
  const { t: conversation } = useTranslation('conversation')
  const [open, setOpen] = useState(false)
  const interactionPolicies = useInteractionPolicies()
  const questionPolicy = interactionPolicies.find((policy) => policy.matches(item.questions))
  const question = item.questions[0]
  const answer = question && item.answers[question.id || question.header || question.question]
  const replyText =
    question && answer ? questionPolicy?.replyText?.(question, answer, localization) : undefined
  const replyTitle =
    question && answer ? questionPolicy?.replyTitle?.(question, answer, localization) : undefined
  const declarative =
    question && answer
      ? declarativeAnswer(question, answer, {
          submitted: conversation('reply.submitted'),
          cancelled: conversation('reply.cancelled'),
        })
      : undefined
  const policyTitle =
    typeof questionPolicy?.title === 'function'
      ? questionPolicy.title(localization)
      : questionPolicy?.title
  const title = item.timedOut
    ? conversation('clarification.timedOutTitle')
    : (replyTitle ??
      policyTitle ??
      conversation(declarative === undefined ? 'reply.title' : 'reply.decision'))
  const receiptText = item.timedOut
    ? conversation('clarification.timedOut')
    : item.freeText || replyText
  if (questionPolicy?.renderReply)
    return (
      <>
        {questionPolicy.renderReply(item)}
        {copyAction}
      </>
    )
  if (!questionPolicy && !expired && item.questions.every(canReplayQuestionForm)) {
    const copyValue = [item.freeText, ...Object.values(item.answers)].filter(Boolean).join('\n\n')
    const skipped =
      !item.timedOut &&
      !item.freeText &&
      !Object.values(item.answers).some((answer) => answer.trim())
    return (
      <ExecutionBatch
        label={
          item.timedOut
            ? title
            : conversation(skipped ? 'reply.skippedSummary' : 'reply.confirmedSummary')
        }
        warning={item.timedOut ? receiptText : skipped ? conversation('reply.skipped') : undefined}
        icon={
          <IconFont type="line-tool-batch-follow-up" className="text-[length:var(--vds-icon-6)]" />
        }
        expanded={open}
        onExpandedChange={setOpen}
      >
        <div
          data-testid="interaction-reply"
          data-interaction-request-id={item.requestId}
          className="mt-[var(--vds-space-2)] w-full min-w-0 max-w-[var(--vds-conversation-interaction-reply-max-width)] rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]"
        >
          <div className="mb-[var(--vds-space-3)] flex items-center gap-[var(--vds-space-2)] text-[var(--vds-text-primary)]">
            <IconFont
              type="line-tool-batch-follow-up"
              className="text-[length:var(--vds-icon-7)]"
            />
            <span className="text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)]">
              {conversation('reply.title')}
            </span>
            {skipped && (
              <span className="text-[var(--vds-text-tertiary)]">
                {conversation('clarification.skipped')}
              </span>
            )}
            <span className="ml-auto text-right text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
              {conversation('reply.readOnly')}
            </span>
            {!item.timedOut && copyValue && (
              <CopyButton
                iconOnly
                icon={<Copy />}
                copiedIcon={<Check />}
                size="xs"
                variant="ghostIcon"
                value={copyValue}
                writeText={writeDesktopClipboard}
                tooltip
                data-testid="interaction-reply-copy"
              />
            )}
          </div>
          {item.freeText && (
            <p className="whitespace-pre-wrap text-[var(--vds-text-secondary)] [overflow-wrap:anywhere]">
              {item.freeText}
            </p>
          )}
          {item.questions.map((question, index) => {
            const key = question.id || question.header || question.question
            const answer = item.timedOut ? undefined : item.answers[key]
            const replay = replayQuestionAnswer(
              question,
              answer,
              item.timedOut ? undefined : item.answerDetails?.[key]
            )
            return (
              <div
                key={question.id || index}
                className="mb-[var(--vds-space-3)] grid min-w-0 gap-[var(--vds-space-3)]"
              >
                <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-2)]">
                  <div className="min-w-0 flex-1 text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
                    <QuestionPrompt presentation={question.presentation}>
                      {index + 1}. {question.question}
                    </QuestionPrompt>
                  </div>
                  {!answer && !item.timedOut && !item.freeText && (
                    <Tag size="small" tone="neutral" className="shrink-0">
                      {conversation('reply.skipped')}
                    </Tag>
                  )}
                </div>
                {question.options.length > 0 && (
                  <div
                    aria-label={question.header || question.question}
                    role={question.multiSelect ? 'group' : 'radiogroup'}
                    className="grid min-w-0 gap-[var(--vds-space-3)]"
                  >
                    {question.options.map((option, position) => (
                      <QuestionOption
                        key={position}
                        {...option}
                        checked={replay.option_indices.includes(position)}
                        disabled
                        readOnly
                        multiSelect={question.multiSelect}
                      />
                    ))}
                  </div>
                )}
                <Textarea
                  aria-label={
                    question.options.length
                      ? conversation('clarification.supplement')
                      : question.question
                  }
                  className="w-full !resize-none [field-sizing:content]"
                  placeholder={conversation('reply.emptyText')}
                  rows={2}
                  readOnly
                  value={replay.text}
                />
              </div>
            )
          })}
        </div>
        {copyAction}
      </ExecutionBatch>
    )
  }
  const rows = item.questions.map((question) => {
    const key = question.id || question.header || question.question
    const answer = item.answers[key]?.trim()
    const presented = questionPolicy?.presentQuestion?.(question, localization)
    const values = expired ? undefined : submittedPluginValues(question, answer)
    const replay =
      values && question.component
        ? { reference: question.component, data: question.componentData ?? {}, values }
        : undefined
    return {
      question: presented?.question ?? question.question,
      presentation: question.presentation,
      replay,
      multiSelect: question.multiSelect,
      options: question.options.map((option, index) => ({
        label:
          presented?.options[index]?.label ?? questionPolicy?.optionLabel?.(option) ?? option.label,
        description: presented?.options[index]?.description ?? option.description,
        checked: (answer ?? '')
          .split('\n')[0]
          .split(', ')
          .includes(questionPolicy?.optionLabel?.(option) ?? option.label),
      })),
      answer: replay
        ? conversation('reply.submitted')
        : answer
          ? (questionPolicy?.presentAnswer?.(question, answer, localization) ??
            declarativeAnswer(question, answer, {
              submitted: conversation('reply.submitted'),
              cancelled: conversation('reply.cancelled'),
            }) ??
            answer)
          : undefined,
    }
  })
  const skipped = !item.freeText && !Object.values(item.answers).some((answer) => answer.trim())
  return (
    <ExecutionBatch
      label={
        expired
          ? conversation('reply.expiredSummary')
          : item.timedOut
            ? title
            : questionPolicy
              ? (replyText ?? title)
              : conversation(skipped ? 'reply.skippedSummary' : 'reply.confirmedSummary')
      }
      icon={
        <IconFont type="line-tool-batch-follow-up" className="text-[length:var(--vds-icon-6)]" />
      }
      expanded={open}
      onExpandedChange={setOpen}
      warning={
        item.timedOut
          ? conversation('clarification.timedOut')
          : skipped && !expired
            ? conversation('reply.skipped')
            : undefined
      }
    >
      <div
        data-testid="interaction-reply"
        data-interaction-request-id={item.requestId}
        className="grid w-full min-w-0 max-w-[var(--vds-conversation-interaction-reply-max-width)] gap-[var(--vds-space-4)] rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]"
      >
        <div className="flex min-w-0 items-center gap-[var(--vds-space-2)] text-[var(--vds-text-secondary)]">
          <IconFont type="line-tool-batch-follow-up" className="text-[length:var(--vds-icon-7)]" />
          <span className="text-[length:var(--vds-font-body-lv1)] font-[number:var(--vds-fw-regular)]">
            {title}
          </span>
          {!expired && (
            <span className="ml-auto text-right text-[length:var(--vds-font-body-lv1)] !font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
              {conversation('reply.readOnly')}
            </span>
          )}
        </div>
        {receiptText && (
          <p className="m-0 whitespace-pre-wrap text-[var(--vds-text-tertiary)]">{receiptText}</p>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            className="grid min-w-0 gap-[var(--vds-space-2)]"
            aria-label={
              expired
                ? undefined
                : conversation('reply.answerLabel', {
                    question: row.question,
                    answer: row.answer ?? conversation('reply.skipped'),
                  })
            }
          >
            <div className="flex min-w-0 items-start justify-between gap-[var(--vds-space-2)]">
              <div className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] [overflow-wrap:anywhere]">
                <QuestionPrompt presentation={row.presentation}>
                  {index + 1}. {row.question}
                </QuestionPrompt>
              </div>
              {!expired && !row.answer && (
                <Tag size="small" tone="neutral" className="shrink-0">
                  {conversation('reply.skipped')}
                </Tag>
              )}
            </div>
            {row.options.map((option, optionIndex) => (
              <QuestionOption
                key={optionIndex}
                {...option}
                disabled
                readOnly
                multiSelect={row.multiSelect}
              />
            ))}
            {row.replay && (
              <PluginInteraction
                reference={row.replay.reference}
                data={row.replay.data}
                submittedValues={row.replay.values}
                status="resolved"
                onAction={() => undefined}
              />
            )}
            {!expired && row.answer && (
              <p className="m-0 whitespace-pre-wrap text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)] [overflow-wrap:anywhere]">
                {row.answer}
              </p>
            )}
          </div>
        ))}
      </div>
      {copyAction}
    </ExecutionBatch>
  )
}

function RewindConfirmation({
  error,
  restoring,
  onCancel,
  onConfirm,
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
      <div style={rewindDialogStyle} onClick={(event) => event.stopPropagation()}>
        <div
          style={{
            width: 38,
            height: 38,
            margin: '0 auto 13px',
            display: 'grid',
            placeItems: 'center',
            borderRadius: 12,
            background: 'var(--accent-soft)',
            color: 'var(--accent-ink)',
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
            textAlign: 'center',
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
            textAlign: 'center',
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
              textAlign: 'center',
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
            {restoring ? t('stream.rewinding') : error ? t('stream.retry') : t('stream.rewind')}
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

function EmptyTurn({ turnId }: { turnId: string }): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const { state, composerSubmission, composerDraft } = useApp()
  const readySession = React.useSyncExternalStore(
    composerSubmission.subscribe,
    composerSubmission.getSnapshot
  )
  const composerText = React.useSyncExternalStore(
    composerDraft.subscribe,
    composerDraft.getSnapshot
  )
  const owner = activeThread(state)
  const allowed =
    readySession === owner.sessionId &&
    !state.foregroundError &&
    !composerText.length &&
    canRetryEmptyTurn(owner, turnId)
  const current = useRef({ owner, allowed })
  current.current = { owner, allowed }
  const retry = async (): Promise<boolean> => {
    const snapshot = current.current
    if (
      !snapshot.allowed ||
      !snapshot.owner.sessionId ||
      snapshot.owner.sessionId !== owner.sessionId
    )
      return false
    return composerSubmission.submit(
      snapshot.owner.sessionId,
      `empty-answer:${turnId}`,
      t('answer.retryPrompt')
    )
  }
  return <EmptyAnswer onRetry={allowed ? retry : undefined} />
}

function AgentMsg({
  citationEnabled,
  latest,
  compact,
  copyEnabled,
  forkEnabled,
  item,
  sourcesContent,
  trailingContent,
  selectionEnabled,
  timing,
}: {
  citationEnabled: boolean
  latest: boolean
  compact: boolean
  copyEnabled: boolean
  forkEnabled: boolean
  item: Extract<ConvItem, { kind: 'agent' }>
  sourcesContent?: React.ReactNode
  trailingContent?: React.ReactNode
  selectionEnabled: boolean
  timing?: TurnTiming
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { state, set, act } = useApp()
  const owner = activeThread(state)
  const copyItems = useContext(CopyItemsContext)
  const sessionId = useContext(CopySessionContext)
  const copyAnswer = useContext(AnswerCopyContext)
  const mergeCards =
    item.turnId &&
    copyItems
      .filter(
        (candidate) =>
          candidate.turnId === item.turnId && candidate.kind === 'agent' && candidate.text
      )
      .at(-1) === item &&
    copyItems.some((candidate) => candidate.turnId === item.turnId && hasCopyCard(candidate))
  const [forking, setForking] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const forkPending = useRef(false)
  const fork = async (): Promise<void> => {
    const sourceSessionId = activeThread(state).sessionId
    if (activeThread(state).readOnly || !sourceSessionId || !item.turnId || forkPending.current)
      return
    forkPending.current = true
    setForking(true)
    setForkError(null)
    try {
      if (!(await act.forkSession(sourceSessionId, item.turnId))) {
        setForkError(t('stream.forkFailed'))
        return
      }
    } finally {
      forkPending.current = false
      setForking(false)
    }
  }
  const duration =
    timing?.completedAt === undefined
      ? null
      : turnDurationLabel(timing.startedAt, timing.completedAt)
  const empty = !visibleMarkdownText(item.text).trim()
  return (
    <div
      className={cx(
        'group/message',
        compact ? 'mb-[var(--vds-space-2)]' : 'mb-[var(--vds-space-7)]'
      )}
      style={{ display: 'flex', gap: 11 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {!empty ? (
          <div className="motion-safe:animate-[vds-answer-in_var(--vds-duration-fast)_var(--vds-ease-standard)_backwards]">
            <AnnotatedAnswer
              loadRemoteImage={loadAnswerImage}
              pending={Boolean(item.turnId && owner.turnOutcomes?.[item.turnId] === 'running')}
              citationEnabled={citationEnabled}
              text={item.text}
              eventSeq={item.eventSeq}
              evidence={item.evidence}
              selectionEnabled={selectionEnabled}
              turnId={item.turnId}
              messageId={item.itemId ? `item:${item.itemId}` : null}
              answerSources={item.answerSources}
              answerCoverage={item.answerCoverage}
              showSources={!item.turnId}
              citationPending={!citationEnabled}
              markdownClassName="!text-[length:var(--vds-font-body-lv2)] !leading-[var(--vds-conversation-answer-line-height)]"
            />
            {sourcesContent}
            {trailingContent}
          </div>
        ) : (
          <>
            {isEmptyAnswer(owner, item) ? <EmptyTurn turnId={item.turnId!} /> : null}
            {trailingContent}
          </>
        )}
        {item.text && copyEnabled && (
          <MessageActions latest={latest}>
            {mergeCards ? (
              <ReplyCopy items={copyItems} turnId={item.turnId!} sessionId={sessionId} />
            ) : (
              <CopyButton
                type="button"
                size="xs"
                variant="ghostIcon"
                getValue={() => copyAnswer(item, sessionId)}
                writeText={writeDesktopClipboard}
                idleLabel={t('stream.copyReply')}
                copiedLabel={t('stream.copied')}
                copiedIcon={<Check size={14} />}
                showLoading={false}
                statusStyle={false}
                tooltip
              >
                <Copy size={14} />
              </CopyButton>
            )}
            {forkEnabled && item.turnId ? (
              <Tooltip content={t('stream.forkTask')} portalled>
                <IconButton
                  type="button"
                  size="xs"
                  variant="ghostIcon"
                  label={t('stream.forkTask')}
                  icon={<GitBranch size={14} />}
                  disabled={forking}
                  loading={forking}
                  data-testid="message-fork-task"
                  onClick={() => void fork()}
                />
              </Tooltip>
            ) : null}
            <TurnDuration timing={timing} />
          </MessageActions>
        )}
        {forkError ? (
          <p role="alert" className="text-[var(--vds-error-text-primary)]">
            {forkError}
          </p>
        ) : null}
        {item.evidence?.length ? (
          <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 10.5 }}>
            {t('stream.evidence', { count: item.evidence.length })}
          </div>
        ) : null}
        {item.evidenceNotice ? (
          <div style={{ marginTop: 8, color: 'var(--c-opinion)', fontSize: 10.5 }}>
            {item.evidenceNotice}
          </div>
        ) : null}
        {item.card && <CardView card={item.card} />}
      </div>
    </div>
  )
}

function isUserStoppedStatus(item: ConvItem): boolean {
  return (
    item.kind === 'status' &&
    (item.text === LEGACY_USER_STOPPED_STATUS ||
      (typeof item.displayMessage === 'object' &&
        item.displayMessage?.ns === 'components' &&
        item.displayMessage.key === 'stream.stopped'))
  )
}

function TurnDuration({ timing }: { timing?: TurnTiming }): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  if (timing?.completedAt === undefined) return null
  const duration = turnDurationLabel(timing.startedAt, timing.completedAt)
  const label = t('turn.duration', { duration })
  return (
    <Tooltip content={label} portalled>
      <span
        aria-label={label}
        className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]"
        data-testid="turn-duration"
        tabIndex={0}
      >
        {duration}
      </span>
    </Tooltip>
  )
}

function StatusLine({
  item,
  showIcon = true,
}: {
  item: Extract<ConvItem, { kind: 'status' }>
  showIcon?: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const { state } = useApp()
  const userStopped = isUserStoppedStatus(item)
  if (
    typeof item.displayMessage === 'object' &&
    item.displayMessage?.ns === 'components' &&
    item.displayMessage.key === 'stream.interrupted'
  )
    return (
      <Alert
        tone="warning"
        role="status"
        aria-live="polite"
        data-testid="task-interrupted-card"
        className="mb-[var(--vds-space-3)] w-full"
        layout="stacked"
        title={t('stream.interruptedTitle')}
        description={t('stream.interruptedDescription')}
      />
    )
  if (userStopped)
    return (
      <Alert
        tone="warning"
        layout="inline"
        description={t('stream.stopped')}
        role="status"
        data-testid="user-stopped-card"
        className="mt-[var(--vds-space-1)] mb-[var(--vds-stream-stopped-margin-bottom)] w-full"
      />
    )
  return (
    <div
      className="mb-[var(--vds-space-5)] flex flex-wrap items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-stream-content-line-height)] text-[var(--vds-text-secondary)]"
      role="status"
    >
      {showIcon && !item.hideIcon ? (
        <IconFont type="fill-status-tips" className="shrink-0 leading-[22px]" />
      ) : null}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {item.displayMessage
          ? renderFeedback(i18n, item.displayMessage)
          : item.runtimeNotice
            ? conversation('runtime.legacyNotice', {
                detail: conversation('runtime.nonterminal'),
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
          disabled={activeThread(state).readOnly}
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
  displayMessage,
}: Pick<
  Extract<ConvItem, { kind: 'notice' }>,
  'text' | 'message' | 'displayMessage'
>): React.JSX.Element {
  const { t, i18n } = useTranslation('conversation')
  // 真实通知文本 (checkout 历史化 / 后端错误 等), 不再写死任何示例内容。
  return (
    <div
      className="mb-[var(--vds-space-5)] flex items-start gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-stream-content-line-height)] text-[var(--vds-text-secondary)]"
      role="status"
    >
      <IconFont type="fill-status-tips" className="shrink-0" />
      <span className="min-w-0 break-words">
        {displayMessage ? renderFeedback(i18n, displayMessage) : message ? t(message.key) : text}
      </span>
    </div>
  )
}

function ErrorCard({
  item,
  onContinue,
}: {
  item: Extract<ConvItem, { kind: 'error' }>
  onContinue: (item: Extract<ConvItem, { kind: 'error' }>) => Promise<void>
}): React.JSX.Element {
  const { t, i18n } = useTranslation('components')
  const { state, set, act } = useApp()
  const recoveryThread = activeThread(state)
  const authenticationFailed = item.failure?.kind === 'auth'
  const { authenticated } = useAccountAccess(state.backendReady && authenticationFailed)
  const [loginPromptOpen, setLoginPromptOpen] = useState(false)
  const [authenticationChecking, setAuthenticationChecking] = useState(false)
  const [authenticationCheckFailed, setAuthenticationCheckFailed] = useState(false)
  const authenticationCheckingRef = useRef(false)
  const recoveryModelKey = recoveryThread.runtime?.model_id || state.model
  const recoveryModel = state.catalog.models.find((model) => model.key === recoveryModelKey)
  const recoveryContext = useRef<{
    thread: Thread
    item: typeof item
    modelKey: string
    onContinue: typeof onContinue
  } | null>(null)
  useLayoutEffect(() => {
    recoveryContext.current = {
      thread: recoveryThread,
      item,
      modelKey: recoveryModelKey,
      onContinue,
    }
    return () => {
      recoveryContext.current = null
    }
  }, [recoveryThread, item, recoveryModelKey, onContinue])
  const authenticationAction = authenticationRecoveryAction(item, recoveryModel, authenticated)
  const selectionBlocked = Boolean(
    recoveryThread.sessionId &&
    modelSelectionBlocked(state.serviceInstanceId, recoveryThread.sessionId)
  )
  const recoveryAvailable =
    item.runtimeAction === 'continue_turn' || item.runtimeAction === 'confirm_turn_unknown'
      ? (item.runtimeAction !== 'continue_turn' || !selectionBlocked) &&
        canContinueFailedTurn(recoveryThread, { ...item, actionState: 'idle' })
      : canOfferTurnRecovery(recoveryThread)
  const { t: conversation } = useTranslation('conversation')
  const recoverAuthentication = async (continueRequested: boolean): Promise<void> => {
    if (
      recoveryThread.readOnly ||
      authenticationCheckingRef.current ||
      (continueRequested && !recoveryAvailable)
    )
      return
    authenticationCheckingRef.current = true
    setAuthenticationChecking(true)
    setAuthenticationCheckFailed(false)
    try {
      const [identity, catalog] = await Promise.all([getAuthMe(), getModels(true)])
      const latest = recoveryContext.current
      if (
        !latest ||
        latest.thread.id !== recoveryThread.id ||
        latest.item.turnId !== item.turnId ||
        latest.modelKey !== recoveryModelKey ||
        (continueRequested && !canContinueFailedTurn(latest.thread, latest.item))
      )
        return
      if (!identity || !catalog) {
        setAuthenticationCheckFailed(true)
        return
      }
      const model = catalog.available_models.find((candidate) => candidate.key === latest.modelKey)
      const action = authenticationRecoveryAction(latest.item, model, identity.auth)
      if (action === 'login') setLoginPromptOpen(true)
      else if (action === 'configure' || !continueRequested) act.openSettings('models')
      else await latest.onContinue(latest.item)
    } finally {
      authenticationCheckingRef.current = false
      setAuthenticationChecking(false)
    }
  }
  const failureText = item.applicationFailure
    ? {
        title: conversation('failure.title'),
        message: formatApplicationRequestFailure(item.applicationFailure, conversation),
        action: formatApplicationRequestFailure(item.applicationFailure, conversation),
      }
    : item.turnUnknown
      ? formatTurnUnknown(item, conversation)
      : formatTurnFailure(item, conversation)
  const confirming = item.actionState === 'submitting'
  const continuing = item.runtimeAction === 'continue_turn' && item.actionState === 'submitting'
  const continueUnknown =
    item.runtimeAction === 'continue_turn' && item.actionState === 'outcome_unknown'
  const turnUnknown = item.runtimeAction === 'confirm_turn_unknown'
  const recoverableFailure = isRecoverableTurnFailure(item)
  const failureDescription =
    item.failure?.kind === 'unknown'
      ? failureText.action
      : failureText.action && failureText.action !== failureText.message
        ? `${failureText.message} ${failureText.action}`
        : failureText.message || failureText.action
  if (turnUnknown) {
    return (
      <Alert
        action={
          recoveryAvailable ? (
            <Button
              data-testid="turn-unknown-continue"
              disabled={confirming || item.actionState === 'outcome_unknown'}
              loading={confirming}
              loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
              onClick={() => void onContinue(item)}
              size="sm"
              variant="outline"
            >
              {item.actionState === 'outcome_unknown'
                ? t('stream.continuePending')
                : t('stream.continueInterrupted')}
            </Button>
          ) : null
        }
        className="mb-[var(--vds-space-3)] w-full"
        data-testid="turn-interrupted-notice"
        layout="stacked"
        title={failureText.title}
        tone="warning"
      >
        <AlertDescription truncate={false}>{failureDescription}</AlertDescription>
        {item.actionError ? (
          <span className="text-[var(--vds-error-text-primary)]">
            {item.actionErrorMessage
              ? formatApplicationRequestFailure(item.actionErrorMessage, conversation)
              : renderFeedback(i18n, item.actionError)}
          </span>
        ) : null}
      </Alert>
    )
  }
  if (item.failure?.kind === 'credits') {
    return (
      <Alert
        className="mb-[var(--vds-space-5)] w-full !rounded-[var(--vds-radius-6)]"
        data-testid="turn-credits-exhausted"
        layout="stacked"
        tone="warning"
        title={failureText.message}
      >
        <AlertDescription truncate={false}>{failureText.action}</AlertDescription>
      </Alert>
    )
  }
  if (recoverableFailure) {
    return (
      <Alert
        className="mb-[var(--vds-space-5)] w-full flex-wrap !items-center !rounded-[var(--vds-radius-5)] [--vds-alert-background:var(--vds-stream-error-bg)] [--vds-alert-border:var(--vds-stream-error-border)] [--vds-alert-icon-color:var(--vds-stream-error-text)]"
        data-testid="turn-recoverable-notice"
        layout="inline"
        icon={<TriangleAlert className="size-[var(--vds-icon-8)]" aria-hidden />}
        tone="warning"
        action={
          recoveryAvailable ? (
            <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
              <Button
                data-testid="turn-continue"
                disabled={continuing || continueUnknown}
                loading={continuing}
                loadingIcon={<Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />}
                onClick={() => void onContinue(item)}
                size="sm"
                variant="ghost"
              >
                {continueUnknown
                  ? t('stream.continuePending')
                  : item.failure?.kind === 'connection' || item.failure?.kind === 'unknown'
                    ? t('stream.continueInterrupted')
                    : conversation('failure.retry')}
              </Button>
              <Button
                data-testid="turn-switch-model"
                disabled={continuing || continueUnknown}
                onClick={() => set({ modelMenuOpen: true })}
                size="sm"
                variant="outline"
              >
                {conversation('failure.switchModel')}
              </Button>
            </div>
          ) : null
        }
      >
        <AlertTitle className="!font-[var(--vds-fw-regular)] !text-[var(--vds-stream-error-text)]">
          {item.failure?.kind === 'unknown'
            ? conversation('failure.interrupted.message')
            : failureText.message}
        </AlertTitle>
        <AlertDescription truncate={false}>{failureText.action}</AlertDescription>
        {item.actionError ? (
          <span
            className="col-span-full break-words text-[var(--vds-error-text-primary)]"
            data-testid="turn-continue-error"
          >
            {item.actionErrorMessage
              ? formatApplicationRequestFailure(item.actionErrorMessage, conversation)
              : renderFeedback(i18n, item.actionError)}
          </span>
        ) : null}
      </Alert>
    )
  }
  return (
    <Failure
      item={item}
      failureText={failureText}
      recoveryAvailable={recoveryAvailable}
      onContinue={onContinue}
      authenticationAction={authenticationAction}
      authenticationChecking={authenticationChecking}
      authenticationCheckFailed={authenticationCheckFailed}
      onRepair={recoverAuthentication}
      actionError={
        item.actionError
          ? item.actionErrorMessage
            ? formatApplicationRequestFailure(item.actionErrorMessage, conversation)
            : renderFeedback(i18n, item.actionError)
          : undefined
      }
    >
      <Continuation item={item} />
      <LoginPrompt open={loginPromptOpen} onOpenChange={setLoginPromptOpen} />
    </Failure>
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
                  flex: 'none',
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 14.5,
                  color: 'var(--text)',
                  lineHeight: 1.55,
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
                marginTop: 2,
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
            marginBottom: 8,
          }}
        >
          {card.label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 16.5,
            color: 'var(--text)',
            lineHeight: 1.6,
          }}
        >
          {card.text}
        </div>
        {state.tension === 'open' && (
          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <Btn tone="var(--c-tension)" onClick={() => set({ tension: 'hypothesis' })}>
              {t('stream.card.setHypothesis')}
            </Btn>
            <Btn ghost onClick={() => set({ tension: 'ignored' })}>
              {t('stream.card.ignore')}
            </Btn>
          </div>
        )}
        {state.tension === 'hypothesis' && (
          <Note color="var(--c-experience)">{t('stream.card.hypothesisSet')}</Note>
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
          <span style={{ color: 'var(--accent-ink)' }}>{t('stream.card.judgmentCaptured')}</span>
          <span style={{ color: 'var(--text-3)' }}>{t('stream.card.lowConfidence')}</span>
        </Head>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '10px 16px',
            alignItems: 'baseline',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('stream.card.action')}</span>
          <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{card.action}</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{t('stream.card.judgment')}</span>
          <span
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 15,
              color: 'var(--text)',
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
              alignItems: 'center',
            }}
          >
            <Btn tone="var(--accent)" onClick={() => set({ judgment: 'confirmed' })}>
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
          <Note color="var(--c-experience)">{t('stream.card.judgmentAnchored')}</Note>
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
          lineHeight: 1.6,
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
          <Btn tone="var(--c-experience)" onClick={() => set({ thread: 'folded' })}>
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
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  )
}
function Note({
  children,
  color,
}: {
  children: React.ReactNode
  color: string
}): React.JSX.Element {
  return <div style={{ fontSize: 12, color, marginTop: 14 }}>{children}</div>
}
