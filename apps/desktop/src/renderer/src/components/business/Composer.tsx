import { draftSessionTitle } from '../../session'
import { assistantContextFailure } from '../../features/assistant/state'
import { feedback, renderFeedback } from '../../contracts/feedback'
import { candidateLabel, candidateHint, useAssistantContextText } from '../../features/assistant/text'
import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpenText,
  Folder,
  Gauge,
  Paperclip,
  Plug,
  Quote,
  type LucideIcon
} from 'lucide-react'
import {
  activeThread,
  ComposerReference,
  assistantProject,
  selectedProjectPath,
  useApp
} from '../../store'
import { assistantSourceAvailable } from '../../features/assistant/candidates'
import type { SessionSurface } from '../../store'
import { effectiveSessionModelKey, hasSelectableModel } from '../../catalog'
import {
  CLOUD_PAGE_ANCHORS,
  cloudPageUrl,
  creditsBlockBuiltInModel
} from '../../account'
import { Icon, type IconName } from '../../icons'
import {
  CollaborationMode,
  confirmUnknownTurn,
  deleteQueuedMessage,
  getMode,
  type GlobalPermissionMode,
  getSkills,
  interruptSession,
  isQueuedMessageNotSendable,
  listQueuedMessages,
  ModeInfo,
  openSession,
  postSide,
  postTurn,
  reconcileQueuedMessage,
  requestFailureFeedback,
  registerLocalPaths,
  setMode,
  setGlobalPermissionMode,
  sendQueuedMessage,
  SkillInfo,
  type TurnContextAdmission,
  TurnInputItem,
  UploadedAttachment,
  uploadAttachmentFile
} from '../../api'
import { COMPOSER_FOCUS_EVENT } from '../../reference'
import { ModelMenu } from './ModelMenu'
import { LoginPrompt } from './LoginPrompt'
import { reasoningPreference } from '../../reasoning'
import { ContextOption } from './Context'
import { ReferencePicker } from './References'
import { SkillAdd } from './Skills'
import { StatusStrip } from './StatusStrip'
import { fuzzyFilter } from '../../fuzzy'
import { skillCallable, skillDescription } from '../../skill'
import { SKILL_SURFACE_CONVERSATION, SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { useAccountAccess } from './access'
import {
  buildTurnInput,
  canSubmitComposer,
  COMPOSER_SKILL_KIND,
  composerObscured,
  composerTrigger,
  turnAdmissionFeedback,
  isAbsoluteInputPath,
  isComposerSubmissionAccepted,
  queuedReferenceLabel,
  queuedReferenceSummary,
  replaceComposerTrigger
} from '../../input'
import type { AssistantContextCandidate, AssistantSourceFilter } from '../../contracts/assistant'
import { promptSessionTitle } from '../../model'
import type { ConvItem, MessageReference, QueuedMessage } from '../../model'
import { hasDraggedFiles } from '../../drag'
import { IMPORT_PICKER_TARGET, supportsImportPickerTarget, type ImportPickerTarget } from '../../../../picker'
import { ComposerSkillRefs } from './SkillRefs'
import { ComposerAttachments } from '../primitive/Attachments'
import {
  appendOptimisticUserMessage,
  bindSubmittedTurn,
  projectAssistantContextRefs,
  removeOptimisticUserMessage
} from '../../transcript'
import { effectiveReadiness, permissionModeFeedback, readinessAdmission } from '../../runtime'
import {
  canCancelQueuedMessage,
  QUEUED_MESSAGE_SAFE_ERRORS,
  QUEUE_STATE_MESSAGE_KEYS,
  queueBlockedByUnconfirmed,
  RESOURCE_WAIT_QUEUE_STATE,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  queuedMessageErrorText,
  queuedWithdrawalFeedback,
  queuedMessageFromPayload,
  settleOptimisticQueuedMessage,
  shouldOptimisticallyPresentUserMessage,
  shouldPresentQueuedMessage,
  upsertQueuedMessage
} from '../../queue'
import {
  mergeQueuedOutbox,
  releaseQueuedOutbox,
  retainQueuedOutbox
} from '../../outbox'
import {
  useDocumentWorkspace,
  useWorkspaceController
} from '../../features/workbench/workspace'
import {
  RESOURCE_CONTEXT_KIND,
  resourceContextSearchTerm,
  resourceContextTriggerPath
} from '../../features/assistant/api'
import {
  decideResourceReviewBatch,
  fetchResourceReviewBatches,
  fetchReviewMemberCurrent,
  hasDirtyReviewEditor,
  type ResourceReviewBatch
} from '../../contracts/resources'
import { resourceEditorHasChanges } from '../../contracts/workbench'
import {
  ANSWER_ANNOTATION_LOCATION,
  locateAnswerAnnotation
} from '../../features/assistant/anchors'
import {
  Alert,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '../ui'
import { IconFont } from '../primitive'
import aiThinking from '../../assets/ai-thinking.gif'

const AT_CANDIDATE_LIMIT = 200
const AT_CONTEXT_SEARCH_DELAY_MS = 150
const CREDITS_EXHAUSTED_NOTICE_ID = 'composer-credits-exhausted-notice'
// Sentinel root-row kind: unlike the other rows it never becomes `atKind` text —
// selecting it triggers the native file picker immediately instead of a sub-search.
const AT_LOCAL_FILE_KIND = 'local-file'
const AT_LOCAL_DIRECTORY_KIND = 'local-directory'
const PLUS_MENU_SOURCE_ICONS: Partial<Record<IconName, LucideIcon>> = {
  folder: Folder,
  books: BookOpenText,
  quote: Quote
}

function plusMenuSourceIcon(icon: IconName): React.JSX.Element {
  const SourceIcon = PLUS_MENU_SOURCE_ICONS[icon]
  return SourceIcon ? <SourceIcon size={15} /> : <Icon name={icon} size={15} />
}

// 技能描述最多两行, 超出截断; 仅在确实溢出时以浮层 Tooltip 展示全文。
function ClampedSkillDescription({ text }: { text: string }): React.JSX.Element {
  const spanRef = React.useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = React.useState(false)
  const refreshTruncated = React.useCallback(() => {
    const el = spanRef.current
    if (!el) return
    setTruncated(el.scrollHeight > el.clientHeight + 1)
  }, [])
  React.useEffect(refreshTruncated)
  return (
    <Tooltip portalled>
      <TooltipTrigger asChild>
        <span
          ref={spanRef}
          className="mt-[var(--vds-space-1)] line-clamp-2 whitespace-normal break-words text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-tertiary)]"
          onMouseEnter={refreshTruncated}
        >
          {text}
        </span>
      </TooltipTrigger>
      {truncated && (
        <TooltipContent>
          <span className="line-clamp-[12] break-words">{text}</span>
        </TooltipContent>
      )}
    </Tooltip>
  )
}
// 权限模式选择器 (对话框下方图标控件, 对齐 opentui Shift+Tab / webui mode-chip; 经 serve
// /sessions/{sid}/mode 读写)。模式清单以后端 enabled_modes 为准; 此表只是前端文案。
// 需求文档 2.1.2 ④: 菜单只展示三档权限；完全访问权限需二次确认。
type ModeTone = 'neutral' | 'accent' | 'danger'
class ReviewDiskReadError extends Error {
  constructor(readonly path: string) {
    super('review_disk_read_failed')
    this.name = 'ReviewDiskReadError'
  }
}

type ModeMeta = { label: string; hint: string; tone: ModeTone }

const PERMISSION_MODE_OPTIONS: GlobalPermissionMode[] = [
  'ask',
  'safe_auto',
  'bypassPermissions'
]
const PERMISSION_MODE_ICON_TYPES: Record<string, string> = {
  ask: 'icon-qingqiupizhun',
  safe_auto: 'icon-bangwopizhun',
  bypassPermissions: 'icon-wanquanfangwen'
}
const UNKNOWN_MODE_TONE: ModeTone = 'neutral'
const DEFAULT_MODE = 'ask'
// 选择已记下但还没换到运行时 —— 换 sandbox 要重开 vendor thread, 只能等当前 turn 结束。
// PRD 2.1.2 ③: 加号是输入框左下角的**圆形描边按钮**, 位于最左。
const HOME_COMPOSER_MIN_HEIGHT_PX = 105
const HOME_COMPOSER_MAX_HEIGHT_PX = 105
const COMPOSER_MAX_HEIGHT_PX = 132
/* assistant 面 pt-12 与 TodoPanel compact 的 -mb-8 相抵，使执行计划与输入框容器间距为 4px，
   与 HIL dock 的 pb-4 一致（AI 面板三个容器间距统一 4px）。 */
const composerRootPaddingClass = (
  home: boolean,
  surface: SessionSurface
): string =>
  home
    ? 'px-[var(--conversation-inline-gutter)] pb-[var(--vds-space-0)] pt-[var(--vds-space-2)]'
    : surface === 'assistant'
      ? 'px-[var(--vds-conversation-inline-gutter)] pb-[var(--vds-space-0)] pt-[var(--vds-space-3)]'
      : 'px-[var(--vds-conversation-inline-gutter)] pb-[var(--vds-space-4)] pt-[var(--vds-space-3)]'
const composerDropZoneClass = (
  home: boolean,
  draggingFiles: boolean,
  surface: SessionSurface
): string =>
  [
    'relative flex flex-col rounded-[var(--vds-radius-4)] border border-solid transition-[background-color,border-color]',
    'duration-[var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
    surface === 'assistant'
      ? '!rounded-[12px] bg-[var(--vds-bg-white-default)] p-[12px]'
      : home
        ? 'px-[18px] pb-[15px] pt-[var(--vds-space-4)] shadow-[0_14px_36px_rgb(45_35_20_/_0.08)]'
        : 'pb-[9px] pl-[13px] pr-[11px] pt-[var(--vds-space-0)]',
    draggingFiles
      ? 'border-[var(--active-border)] bg-[color-mix(in_srgb,var(--active-bg)_72%,var(--bg-2))]'
      : surface === 'assistant'
        ? 'border-[var(--border)] bg-[var(--vds-bg-white-default)]'
        : 'border-[var(--border)] bg-[var(--bg-2)]'
  ].join(' ')
const composerToolbarClass = (home: boolean, surface: SessionSurface): string =>
  [
    'flex items-center',
    surface === 'assistant'
      ? 'mt-[var(--vds-space-2)] gap-[2px] pt-[var(--vds-space-0)]'
      : 'mt-[10px] gap-[7px] pt-[10px]',
    home ? '-ml-[18px] -mr-[17px] flex-nowrap px-[18px] pr-[17px]' : 'flex-nowrap'
  ].join(' ')
const readingColumnClass = (home: boolean): string =>
  [
    'relative box-border mx-auto',
    home
      ? 'w-full'
      : 'w-full min-w-0 max-w-[var(--vds-conversation-content-width)]'
  ].join(' ')
const popoverClass = [
  'absolute z-[60] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)]',
  'shadow-[var(--shadow)] animate-[cardIn_0.16s_ease_both]'
].join(' ')
const composerInputShellClass = (surface: SessionSurface): string =>
  `relative ${surface === 'assistant' ? 'mb-[var(--vds-space-1)]' : ''}`
// 待处理消息随排队增多而变长; 与执行计划 (TodoPanel) 同处 flex:0 0 auto 的 composer-host,
// 不设上限时会把上方的执行计划顶出视口。限高并在本区域内滚动, 保证计划等始终可见。
const queuedMessageClass =
  'mb-[var(--vds-space-2)] grid max-h-[min(300px,36vh)] divide-y divide-[var(--vds-divider-default)] overflow-y-auto overscroll-contain rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] [scrollbar-color:var(--vds-scrollbar-thumb)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[var(--vds-scrollbar-size)] [&::-webkit-scrollbar-thumb]:rounded-[var(--vds-scrollbar-radius)] [&::-webkit-scrollbar-thumb]:bg-[var(--vds-scrollbar-thumb)] [&::-webkit-scrollbar-track]:bg-transparent'
const queuedMessageRowClass =
  'flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)] py-[var(--vds-space-1)]'
const atPanelClass = [
  popoverClass,
  'bottom-[calc(100%+9px)] left-[var(--vds-space-0)] z-[64] box-border max-h-[min(252px,42vh)] w-[min(420px,100%)]',
  'overflow-hidden rounded-[var(--radius)] border-[color-mix(in_srgb,var(--brand-ink)_22%,var(--border))]',
  'bg-[var(--bg-2)] p-[var(--vds-space-0)] shadow-[0_14px_36px_rgb(41_33_20_/_0.15),0_2px_7px_rgb(41_33_20_/_0.08)]'
].join(' ')
const atHeadClass = [
  'flex min-h-[34px] items-center justify-between gap-[var(--vds-space-4)] border-b border-[var(--border-soft)]',
  'px-[var(--vds-space-3)] text-[var(--text-3)]'
].join(' ')
const atTitleClass =
  'inline-flex items-center gap-[7px] text-[length:var(--vds-font-body-lv1)] font-[650] tracking-[0.02em] text-[var(--brand-ink)]'
const atBackClass = [
  'grid size-[23px] place-items-center rounded-[var(--vds-radius-2)] border-0 bg-transparent p-[var(--vds-space-0)]',
  'text-[var(--text-3)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)] focus-visible:bg-[var(--hover-bg)] focus-visible:text-[var(--text)]'
].join(' ')
const atListClass = [
  'max-h-[min(216px,calc(42vh-35px))] overflow-y-auto overscroll-contain p-[5px]',
  '[scrollbar-color:color-mix(in_srgb,var(--text-3)_38%,transparent)_transparent] [scrollbar-gutter:stable] [scrollbar-width:thin]',
  '[&::-webkit-scrollbar]:w-[7px] [&::-webkit-scrollbar-track]:bg-transparent',
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-[var(--bg-2)]',
  '[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--text-3)_34%,transparent)]'
].join(' ')
const atRowClass = (
  selected: boolean,
  unavailable = false,
  root = false
): string =>
  [
    'group flex w-full items-center gap-[10px] rounded-[9px] border-0 bg-transparent px-[var(--vds-space-2)] py-[6px] text-left text-[var(--text)]',
    'transition-[background,transform] duration-[120ms] ease-[ease]',
    root ? 'min-h-[52px]' : 'min-h-[43px]',
    selected ? 'bg-[var(--accent-soft)]' : '',
    unavailable ? 'cursor-not-allowed opacity-[0.52]' : 'cursor-pointer'
  ].join(' ')
const atLoadingClass = 'p-[var(--vds-space-3)]'
const atLoadingCopyClass =
  'flex items-center gap-[9px] px-[var(--vds-space-1)] pb-[10px] pt-[var(--vds-space-1)] text-[11.5px] font-[var(--vds-fw-medium)] text-[var(--brand-ink)]'
const atSkeletonRowClass = [
  'relative grid min-h-[41px] grid-cols-[27px_minmax(0,1fr)_46px] items-center gap-[10px] overflow-hidden rounded-[9px]',
  'bg-[color-mix(in_srgb,var(--bg-3)_78%,transparent)] px-[9px]',
  'after:absolute after:inset-[var(--vds-space-0)] after:animate-pulse',
  'after:bg-[linear-gradient(100deg,transparent_22%,rgb(255_255_255_/_0.62)_48%,transparent_74%)] after:content-[""]'
].join(' ')
const referenceTrayClass = 'mt-[5px] overflow-visible'
const referenceTrayScrollerClass =
  'flex flex-nowrap gap-[2px] overflow-x-auto overflow-y-hidden pb-[var(--vds-space-0)] pl-[var(--vds-space-0)] pr-[2px] pt-[5px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
const PLUS_MENU_PAGE_SIZE = 10
const SUBMENU_GAP = 6
const SUBMENU_CLOSE_DELAY = 160
const SUBMENU_VIEWPORT_PADDING = 8
const submenuFlyoutClass =
  'fixed z-[var(--vds-z-popover)] w-max overflow-hidden rounded-[12px] bg-[var(--vds-bg-white-default)] shadow-[2px_4px_12px_0_rgba(0,0,0,0.1)] transition-[height,top] duration-[var(--vds-duration-fast)] ease-[ease] motion-reduce:transition-none'
const plusMenuNavClass = (hasPane: boolean): string =>
  [
    'flex w-[176px] flex-none flex-col gap-[var(--vds-space-1)]',
    hasPane
      ? 'border-r border-[var(--border-soft)] pr-[var(--vds-space-1)]'
      : ''
  ].join(' ')
const plusNavButtonClass = (active = false): string =>
  [
    'flex min-h-8 w-full min-w-0 items-center justify-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 bg-transparent px-[var(--vds-space-3)] py-[var(--vds-space-2)]',
    'text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--text-2)] shadow-none [font:inherit] hover:bg-[var(--vds-bg-white-hover)] hover:text-[var(--text)] focus-visible:bg-[var(--vds-bg-white-hover)] focus-visible:text-[var(--text)] focus-visible:outline-none',
    active
      ? '!bg-[var(--vds-bg-white-active)] text-[var(--vds-text-primary)]'
      : ''
  ].join(' ')
const contextPaneClass =
  'max-h-[calc(min(420px,70vh)-var(--vds-space-2))] min-h-0 w-[268px] flex-none overflow-hidden bg-[var(--bg-2)]'
const contextOptionButtonClass =
  'flex h-auto min-h-8 w-full min-w-0 items-start justify-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-2)] border-0 bg-transparent px-[var(--vds-space-2)] py-[6px] text-left text-[var(--text-2)] hover:bg-[var(--vds-bg-white-hover)] hover:text-[var(--text)] focus-visible:bg-[var(--vds-bg-white-hover)] focus-visible:text-[var(--text)]'
const contextOptionCopyClass =
  'grid min-w-0 gap-[var(--vds-space-1)] [&>small]:whitespace-normal [&>small]:break-words [&>small]:text-[length:var(--vds-font-caption)] [&>small]:leading-relaxed [&>small]:text-[var(--vds-text-tertiary)] [&>span]:whitespace-normal [&>span]:break-words [&>span]:font-medium'
const skillPanelClass = [
  'relative min-h-0 max-h-[min(420px,70vh)] w-[268px] min-w-0 shrink overflow-y-auto bg-[var(--vds-surface-raised)] p-0'
].join(' ')
const skillPanelHeadClass = [
  'sticky top-[var(--vds-space-0)] flex items-center gap-[8px] border-b border-[var(--border-soft)]',
  'bg-[var(--bg-2)] px-[12px] py-[10px]'
].join(' ')
const composerTextareaClass = (
  home: boolean,
  surface: SessionSurface,
  launching: boolean
): string =>
  [
    'block w-full resize-none overflow-y-hidden rounded-none border-0 bg-transparent font-[var(--font-serif)] text-[var(--text)] outline-none',
    'shadow-none focus:outline-none focus-visible:border-0 focus-visible:shadow-none',
    surface === 'assistant'
      ? 'min-h-[44px] max-h-[132px] text-[length:var(--vds-font-body-lv2)] leading-[1.65]'
      : home
        ? 'min-h-[105px] max-h-[105px] text-[length:var(--vds-font-body-lv2)] leading-[1.45] tracking-[0.01em]'
        : 'min-h-[23px] max-h-[132px] text-[15.5px] leading-[1.45]',
    launching ? 'opacity-[0.58]' : 'opacity-100'
  ].join(' ')
const stopButtonClass = (interrupting: boolean): string =>
  [
    'grid size-8 min-h-8 min-w-8 place-items-center rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-brand-light-bg-default)] text-[var(--vds-brand-bg-default)] p-0 transition-colors duration-[var(--vds-duration-fast)] hover:bg-[var(--vds-brand-light-bg-hover)]',
    interrupting ? 'cursor-wait opacity-[0.68]' : 'cursor-pointer opacity-100'
  ].join(' ')
const sendButtonClass = (
  surface: SessionSurface,
  canSend: boolean,
  launching: boolean
): string =>
  surface === 'assistant'
    ? 'grid size-8 min-w-8 shrink-0 place-items-center rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-brand-bg-default)] p-0 text-[var(--vds-static-white)] disabled:cursor-not-allowed disabled:bg-[var(--vds-surface-muted)] disabled:text-[var(--vds-text-tertiary)]'
    : [
      'grid h-[34px] min-h-[34px] w-[34px] min-w-[34px] place-items-center rounded-full border-0 [padding:0] transition-[background,color,transform] duration-[150ms]',
      canSend || launching
        ? '[background:var(--brand-ink)] [color:white] opacity-100 hover:[background:var(--brand-ink-hover)]'
        : '[background:var(--bg-3)] [color:var(--text-3)] opacity-60',
      launching
        ? 'cursor-wait'
        : canSend
          ? 'cursor-pointer'
          : 'cursor-not-allowed'
    ].join(' ')
// 无可用模型提示行: 小圆点与两条下划线出口与正文同基线, 钉在输入卡片上方。
const NO_MODEL_HINT_CLASS =
  'mb-[var(--vds-space-3)] flex flex-wrap items-center gap-x-[var(--vds-space-2)] gap-y-[var(--vds-space-1)] px-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]'
const NO_MODEL_HINT_LINK_CLASS =
  'border-0 bg-transparent p-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-brand-text-primary)] underline underline-offset-[3px]'
// 会话尚未创建时（首页首条消息才 openSession）的本地待选清单。
const PRE_SESSION_MODES: GlobalPermissionMode[] = [
  'ask',
  'safe_auto',
  'bypassPermissions'
]
const COLLABORATION_MODE_OPTIONS: ReadonlyArray<{
  value: CollaborationMode
  labelKey: 'composer.question' | 'composer.plan'
}> = [
    { value: 'default', labelKey: 'composer.question' },
    { value: 'plan', labelKey: 'composer.plan' }
  ]
function isCollaborationMode(value: string): value is CollaborationMode {
  return COLLABORATION_MODE_OPTIONS.some((option) => option.value === value)
}

export function Composer({
  home = false,
  homeExtras,
  contextTray,
  inputBoxRef,
  surface = 'conversation'
}: {
  home?: boolean
  /** Rendered directly under the home composer (PRD 2.1.2: 选择项目). */
  homeExtras?: React.ReactNode
  /** Session context queue rendered inside the composer card above the draft text. */
  contextTray?: React.ReactNode
  /**
   * 外部对齐锚点：透传到输入框所在的会话内容列（readingColumnClass 那一列，
   * 窄时贴合面板、宽时被 --vds-conversation-content-width 封顶并居中）。
   * 历史浮层等需要「与输入框同宽同左」的层据此测量，不再各自复刻内容列布局。
   */
  inputBoxRef?: React.Ref<HTMLDivElement>
  /** Preserve the owning product surface when a new Session is created. */
  surface?: SessionSurface
}): React.JSX.Element {
  const { state, set, appendThread, patchThread, act } = useApp()
  const { authenticated, revision: skillRevision } = useAccountAccess(state.backendReady)
  const documents = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const { t, i18n } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const contextText = useAssistantContextText()
  const { t: reviewText } = useTranslation('resources')
  const collaborationModeLabel =
    COLLABORATION_MODE_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey)
    })).find((option) => option.value === state.collaborationMode)?.label ??
    t('composer.question')
  const AT_SKILL_PANEL_LABEL = t('composer.skill')
  const AT_SKILL_BUILTIN_LABEL = t('composer.builtin')
  const AT_SKILL_USER_LABEL = t('composer.local')
  const AT_SKILL_LOADING_LABEL = t('composer.loadingSkills')
  const AT_SKILL_EMPTY_LABEL = t('composer.emptySkills')
  const AT_ROOT_LABEL = t('composer.references')
  const unifiedLocalPicker = supportsImportPickerTarget(
    window.scholarseed?.platform,
    IMPORT_PICKER_TARGET.RESOURCE
  )
  const AT_LOCAL_FILE_ROOT_ROW = Object.freeze({
    kind: AT_LOCAL_FILE_KIND,
    label: t('composer.addLocal'),
    description: t(unifiedLocalPicker
      ? 'composer.addLocalCombinedDescription'
      : 'composer.addLocalDescription'),
    icon: 'clip' as const
  })
  const AT_LOCAL_DIRECTORY_ROOT_ROW = Object.freeze({
    kind: AT_LOCAL_DIRECTORY_KIND,
    label: t('composer.addLocalFolder'),
    description: t('composer.addLocalFolderDescription'),
    icon: 'folder' as const
  })
  const AT_SKILL_ROOT_ROW = Object.freeze({
    kind: COMPOSER_SKILL_KIND,
    label: AT_SKILL_PANEL_LABEL,
    description: t('composer.skillDescription'),
    icon: 'skills' as const
  })

  const MODE_META: Record<string, ModeMeta> = {
    // key 必须与后端 GLOBAL_PERMISSION_MODES 一致 (service/chat/constants.py: ask / safe_auto)。
    ask: {
      label: t('composer.askPermission'),
      hint: t('composer.askHint'),
      tone: 'neutral'
    },
    default: {
      label: t('composer.askPermission'),
      hint: t('composer.askHint'),
      tone: 'neutral'
    },
    safe_auto: {
      label: t('composer.autoPermission'),
      hint: t('composer.autoHint'),
      tone: 'accent'
    },
    bypassPermissions: {
      label: t('composer.fullPermission'),
      hint: t('composer.fullHint'),
      tone: 'danger'
    }
  }
  const modeMeta = (mode: string): ModeMeta =>
    MODE_META[mode] ?? { label: mode, hint: '', tone: UNKNOWN_MODE_TONE }
  const MODE_FULL_ACCESS_CONFIRM_TITLE = t('composer.fullConfirm')
  const MODE_FULL_ACCESS_CONFIRM_BODY = t('composer.fullBody')
  const MODE_PENDING_LABEL = t('composer.pending')
  const RUNNING_INPUT_PLACEHOLDER = t('composer.runningPlaceholder')
  const INTERRUPTING_INPUT_PLACEHOLDER = t('composer.stoppingPlaceholder')
  const RUNNING_SEND_HINT_TITLE = t('composer.enqueue')
  const COMPOSER_DROP_LABEL = t('composer.drop')
  const text = state.composerText
  const thread = activeThread(state)
  const sidNow = thread.sessionId
  const running = Boolean(thread.running)
  const waitingApproval = thread.status === 'waiting'
  const queuedMessages = thread.queuedMessages ?? []
  const visibleQueuedMessages = queuedMessages.filter((message) =>
    shouldPresentQueuedMessage(message, thread.conversation)
  )
  const interrupting = Boolean(thread.interrupting)
  const launching =
    state.turnLaunch !== null || thread.resumeState === 'pending'
  // 资源页只遮住旧对话页；文档旁的 AI 助手仍可交互，不得因此禁用候选菜单。
  const nonConversationSurfaceOpen = composerObscured(surface, {
    capabilities: Boolean(state.capGallery),
    files: state.workspaceFilesOpen,
    documents: Object.keys(documents.tabs).length > 0
  })
  const composing = React.useRef(false)
  const submissionInFlight = React.useRef(false)
  const composerInputRef = React.useRef<HTMLTextAreaElement>(null)
  const attachmentInputRef = React.useRef<HTMLInputElement>(null)
  const dragDepthRef = React.useRef(0)
  const [attaching, setAttaching] = React.useState(false)
  const [submittingMessage, setSubmittingMessage] = React.useState(false)
  const [loginPromptOpen, setLoginPromptOpen] = React.useState(false)
  const [draggingFiles, setDraggingFiles] = React.useState(false)
  const [queuedActionId, setQueuedActionId] = React.useState<string | null>(
    null
  )
  const [expandedQueuedMessages, setExpandedQueuedMessages] = React.useState<
    Set<string>
  >(() => new Set())
  const [plusMenuOpen, setPlusMenuOpen] = React.useState(false)
  const [referenceQuery, setReferenceQuery] = React.useState('')
  const [referenceFilter, setReferenceFilter] = React.useState<AssistantSourceFilter>('all')
  const [collaborationMenuOpen, setCollaborationMenuOpen] =
    React.useState(false)
  // PRD 2.1.2 ③(2): 点「技能」展开已启用技能列表, 点某条即加载到本次对话。
  const [skillPanelOpen, setSkillPanelOpen] = React.useState(false)
  const [skillRows, setSkillRows] = React.useState<SkillInfo[] | null>(null)
  const [skillRowsLoading, setSkillRowsLoading] = React.useState(true)
  const [selectedSkillCatalog, setSelectedSkillCatalog] = React.useState<{ revision: number; selection: string; rows: SkillInfo[] } | null>(null)
  const [skillQuery, setSkillQuery] = React.useState('')
  const [skillVisibleCount, setSkillVisibleCount] =
    React.useState(PLUS_MENU_PAGE_SIZE)
  const submenuRef = React.useRef<HTMLDivElement | null>(null)
  const submenuContentRef = React.useRef<HTMLDivElement | null>(null)
  const submenuCloseTimerRef = React.useRef<number | null>(null)
  const plusMenuNavRef = React.useRef<HTMLDivElement | null>(null)
  const [submenuStyle, setSubmenuStyle] = React.useState<React.CSSProperties>({
    visibility: 'hidden'
  })
  React.useEffect(() => {
    setPlusMenuOpen(false)
    setSkillPanelOpen(false)
    setSkillQuery('')
    setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
    setReferenceQuery('')
    setReferenceFilter('all')
    setSelIdx(0)
    setDismissed(false)
  }, [state.activeSession, home])
  React.useEffect(() => {
    const focus = (event: Event): void => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as
            | { selectionStart?: number; selectionEnd?: number }
            | undefined)
          : undefined
      window.requestAnimationFrame(() => {
        const input = composerInputRef.current
        if (!input) return
        input.focus()
        if (detail?.selectionStart == null) return
        const start = Math.max(
          0,
          Math.min(detail.selectionStart, input.value.length)
        )
        const end = Math.max(
          start,
          Math.min(detail.selectionEnd ?? start, input.value.length)
        )
        input.setSelectionRange(start, end)
      })
    }
    window.addEventListener(COMPOSER_FOCUS_EVENT, focus)
    return () => window.removeEventListener(COMPOSER_FOCUS_EVENT, focus)
  }, [])
  const resizeComposer = React.useCallback((): void => {
    const input = composerInputRef.current
    if (!input) return
    const maxHeight = home
      ? HOME_COMPOSER_MAX_HEIGHT_PX
      : COMPOSER_MAX_HEIGHT_PX
    input.style.height = '0px'
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`
    input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [home])
  React.useLayoutEffect(() => {
    resizeComposer()
  }, [resizeComposer, text])
  // @ 引用候选的键盘导航 (↑↓ 移动 · Enter/Tab 选中 · Esc 关闭)。
  // dismissed: Esc/选中后压住弹层, 直到下次输入 (onChange) 复位。
  const [selIdx, setSelIdx] = React.useState(0)
  const [dismissed, setDismissed] = React.useState(false)

  // 空闲会话由 Serve 重绑同一 Codex thread 的权限；未开会话在本地选择，
  // 随 openSession 提交。只以服务端确认结果更新已开会话的显示。
  const [modeInfo, setModeInfo] = React.useState<{
    sessionId: string
    value: ModeInfo
  } | null>(null)
  const openedModeProjection = React.useRef<{
    sessionId: string
    mode: GlobalPermissionMode
  } | null>(null)
  const [modeOpen, setModeOpen] = React.useState(false)
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] =
    React.useState(false)
  // null = 尚未显式覆盖设置页的全局默认；首页用户选了某个会话模式才写入。
  const [pendingMode, setPendingMode] = React.useState<GlobalPermissionMode | null>(null)
  const [modeChanging, setModeChanging] = React.useState(false)
  const modeRequest = React.useRef(0)
  const refreshMode = React.useCallback((): void => {
    const request = ++modeRequest.current
    const sessionId = sidNow
    if (sessionId)
      void getMode(sessionId).then((m) => {
        if (m && request === modeRequest.current) {
          setModeInfo({ sessionId, value: m })
          if (openedModeProjection.current?.sessionId === sessionId) {
            openedModeProjection.current = null
          }
        }
      })
  }, [sidNow])
  React.useEffect(() => {
    ++modeRequest.current
    setModeChanging(false)
    if (!sidNow) {
      setModeInfo(null)
      return
    }
    refreshMode()
    // 依赖 running: turn 结束再拉一次 —— plan 批准 (ExitPlanMode) 等 agent 内部切换
    // 只发生在后端, serve SSE 不透 mode_transition, 靠关键时点刷新保持同步。
  }, [sidNow, running, refreshMode])
  const currentModeInfo = modeInfo?.sessionId === sidNow ? modeInfo.value : null
  const openedMode =
    openedModeProjection.current?.sessionId === sidNow
      ? openedModeProjection.current.mode
      : null
  const curMode = sidNow
    ? (currentModeInfo?.mode ?? openedMode ?? DEFAULT_MODE)
    : (pendingMode ?? state.globalPermissionMode)
  const modeList = PRE_SESSION_MODES
  const permissionModeList = PERMISSION_MODE_OPTIONS.filter((m) =>
    modeList.includes(m)
  )
  const activeModeMeta = modeMeta(curMode)
  const modeControlLabel = waitingApproval
    ? t('composer.modeControlWaiting', { mode: activeModeMeta.label })
    : t('composer.modeControl', { mode: activeModeMeta.label })
  const modeControlIcon =
    PERMISSION_MODE_ICON_TYPES[curMode] ??
    PERMISSION_MODE_ICON_TYPES[DEFAULT_MODE]
  const persistDefaultMode = async (
    mode: GlobalPermissionMode
  ): Promise<boolean> => {
    const saved = await setGlobalPermissionMode(mode)
    if (!saved) {
      set({
        foregroundError: permissionModeFeedback({
          ok: false
        })
      })
      return false
    }
    set({ globalPermissionMode: saved.mode })
    return true
  }
  const applyMode = (m: GlobalPermissionMode): void => {
    if (waitingApproval) return
    setFullAccessConfirmOpen(false)
    if (!sidNow) {
      setPendingMode(m)
      const request = ++modeRequest.current
      setModeChanging(true)
      void persistDefaultMode(m).then((saved) => {
        if (request !== modeRequest.current) return
        setModeChanging(false)
        if (saved) setPendingMode(null)
      })
      return
    }
    const request = ++modeRequest.current
    setModeChanging(true)
    void setMode(sidNow, m).then(async (result) => {
      if (request !== modeRequest.current) return
      if (result.ok && result.mode) {
        const applied = result.mode
        setModeInfo((info) => ({
          sessionId: sidNow,
          value: {
            ...(info?.sessionId === sidNow ? info.value : {}),
            mode: applied,
            modes: PRE_SESSION_MODES,
            active_mode: result.active_mode,
            deferred: result.deferred
          }
        }))
        await persistDefaultMode(applied)
        if (request === modeRequest.current) setModeChanging(false)
        return
      }
      setModeChanging(false)
      refreshMode()
      set({ foregroundError: permissionModeFeedback(result) })
    })
  }
  const requestMode = (m: GlobalPermissionMode): void => {
    if (waitingApproval) return
    if (
      m === 'bypassPermissions' &&
      curMode !== 'bypassPermissions' &&
      !fullAccessConfirmOpen
    ) {
      setFullAccessConfirmOpen(true)
      return
    }
    applyMode(m)
    setModeOpen(false)
  }

  // @ 与“+”复用同一组 Assistant 来源贡献；项目文件和 Skill 保留原有专用入口。
  const atQuery = composerTrigger(text)?.query ?? null
  const atColon = atQuery?.indexOf(':') ?? -1
  const atKind =
    atQuery !== null && atColon >= 0 ? atQuery.slice(0, atColon) : null
  const atTerm =
    atQuery !== null && atColon >= 0
      ? atQuery.slice(atColon + 1)
      : (atQuery ?? '')
  const atRoot = atQuery !== null && atColon < 0
  const atSkill = atKind === COMPOSER_SKILL_KIND
  const assistantProjectId = assistantProject(state).projectId
  const availableContextSources = state.aiPanel.contextSources.filter(
    (source) => assistantSourceAvailable(source, assistantProjectId)
  ).map((source) => ({ ...source, label: renderFeedback(i18n, source.label), emptyLabel: renderFeedback(i18n, source.emptyLabel) }))
  const cancelSubmenuClose = (): void => {
    if (submenuCloseTimerRef.current !== null) {
      window.clearTimeout(submenuCloseTimerRef.current)
      submenuCloseTimerRef.current = null
    }
  }
  const scheduleSubmenuClose = (): void => {
    cancelSubmenuClose()
    submenuCloseTimerRef.current = window.setTimeout(() => {
      submenuCloseTimerRef.current = null
      if (submenuRef.current?.contains(document.activeElement)) return
      setSkillPanelOpen(false)
      act.closeAiContextPicker()
    }, SUBMENU_CLOSE_DELAY)
  }
  const openSkillSubmenu = (): void => {
    cancelSubmenuClose()
    clearAtTrigger()
    act.closeAiContextPicker()
    if (!skillPanelOpen) setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
    setSkillPanelOpen(true)
  }
  const openSourceSubmenu = (
    source: (typeof availableContextSources)[number]
  ): void => {
    cancelSubmenuClose()
    if (
      state.aiPanel.contextPickerOpen &&
      state.aiPanel.contextPickerSource === source.id
    )
      return
    clearAtTrigger()
    setSkillPanelOpen(false)
    setReferenceQuery('')
    setReferenceFilter('all')
    act.openAiContextPicker(source.id, '', 'all')
  }
  // 技能列表异步加载完成后浮层高度会变化, 必须随 deps 重新定位,
  // 否则首次打开会按加载占位的高度锁死坐标, 列表到达后弹窗错位。
  React.useLayoutEffect(() => {
    const el = submenuRef.current
    const content = submenuContentRef.current
    const nav = plusMenuNavRef.current
    if (!el || !content || !nav) return
    if (!(skillPanelOpen || state.aiPanel.contextPickerOpen)) return
    const navRect = nav.getBoundingClientRect()
    const width = content.offsetWidth
    const height = content.offsetHeight
    const viewportWidth = window.innerWidth
    // 右侧宽度足够贴右侧; 不够时翻到一级菜单左侧。
    const rightLeft = navRect.right + SUBMENU_GAP
    const leftLeft = navRect.left - SUBMENU_GAP - width
    const fitsRight =
      rightLeft + width <= viewportWidth - SUBMENU_VIEWPORT_PADDING
    const fitsLeft = leftLeft >= SUBMENU_VIEWPORT_PADDING
    const left = fitsRight
      ? rightLeft
      : fitsLeft
        ? leftLeft
        : Math.max(
          SUBMENU_VIEWPORT_PADDING,
          viewportWidth - width - SUBMENU_VIEWPORT_PADDING
        )
    // 二级弹窗底部与一级菜单底部对齐, 向上展开; 超高时收敛到视口内。
    const top = Math.max(SUBMENU_VIEWPORT_PADDING, navRect.bottom - height)
    setSubmenuStyle((current) => {
      if (
        current.visibility === 'visible' &&
        current.left === left &&
        current.top === top &&
        current.height === height
      ) {
        return current
      }
      return { height, left, top, visibility: 'visible' }
    })
  }, [
    skillPanelOpen,
    skillQuery,
    skillRows,
    skillRowsLoading,
    skillVisibleCount,
    state.aiPanel.contextCandidates,
    state.aiPanel.contextCandidatesLoading,
    state.aiPanel.contextPickerOpen
  ])
  const atContextSource = availableContextSources.find(
    (source) => source.id === atKind
  )
  const atContextSourceId = atContextSource?.id
  const atContext = Boolean(atContextSourceId)
  const atResourceContext = atContextSourceId === RESOURCE_CONTEXT_KIND
  const pendingRefs = state.composerRefs
  const selectedSkillNames = pendingRefs.filter((reference) => reference.type === 'skill').map((reference) => reference.id)
  const selectedSkillKey = JSON.stringify(selectedSkillNames)
  React.useEffect(() => {
    if (!state.backendReady || selectedSkillKey === '[]') return
    let current = true
    void getSkills(SKILL_SURFACE_SETTINGS).then((rows) => {
      if (current) setSelectedSkillCatalog({ revision: skillRevision, selection: selectedSkillKey, rows })
    }).catch(() => {
      if (current) setSelectedSkillCatalog({ revision: skillRevision, selection: selectedSkillKey, rows: [] })
    })
    return () => { current = false }
  }, [state.backendReady, selectedSkillKey, skillRevision])
  const selectedSkillsReady = selectedSkillNames.length === 0 || (
    selectedSkillCatalog?.revision === skillRevision
    && selectedSkillCatalog.selection === selectedSkillKey
    && selectedSkillNames.every((name) => selectedSkillCatalog.rows.some((skill) => skill.name === name && skillCallable(skill, authenticated)))
  )
  const hasComposerReferenceCards = pendingRefs.length > 0
  // 运行中发送会进入产品持久队列；插话必须由用户对指定队列项显式触发。
  const runtimeAdmission = readinessAdmission(thread, state.runtimeReadiness)
  // starting/recovering 只在已有会话时放行: 草稿先落持久队列, 运行时恢复后自动执行。新建会话
  // 没有队列兜底, 未知态（readiness 尚未加载）同样必须闭门。
  const runtimeReady = runtimeAdmission === 'ready'
    || (runtimeAdmission === 'transient' && Boolean(sidNow))
  const selectedModelKey = effectiveSessionModelKey(
    state.catalog.models,
    state.model,
    state.activeSession,
    state.threads
  )
  const selectedModel = state.catalog.models.find(
    (model) => model.key === selectedModelKey
  )
  const creditBlocked = creditsBlockBuiltInModel(state.credits, selectedModel)
  // 目录里一个可选模型都没有（未登录且未配置自有连接时内置/订阅行全被置灰）: 草稿发出去
  // 只会在执行面被拒, 所以发送在这里就闭门, 并在卡片上方给出两条出路。
  const modelAvailable = hasSelectableModel(state.catalog.models)
  const canSend = canSubmitComposer({
    runtimeReady: runtimeReady && selectedSkillsReady && activeThread(state).terminated !== true,
    creditsAvailable: !creditBlocked,
    modelAvailable,
    launching,
    running,
    interrupting,
    hasContent: Boolean(text.trim()) || pendingRefs.length > 0
  })
  const setPendingRefs = React.useCallback(
    (patch: React.SetStateAction<ComposerReference[]>) => {
      set((current) => ({
        composerRefs:
          typeof patch === 'function' ? patch(current.composerRefs) : patch
      }))
    },
    [set]
  )
  const clearAtTrigger = React.useCallback((): void => {
    set((current) => ({
      composerText: replaceComposerTrigger(current.composerText, '').replace(
        /\s+$/,
        ''
      )
    }))
  }, [set])
  const replaceAtTrigger = React.useCallback(
    (replacement: string): void => {
      set((current) => ({
        composerText: replaceComposerTrigger(current.composerText, replacement)
      }))
    },
    [set]
  )
  React.useEffect(() => {
    if (atQuery === null || nonConversationSurfaceOpen) return
    setPlusMenuOpen(false)
    setSkillPanelOpen(false)
  }, [atQuery, nonConversationSurfaceOpen])
  const ensureAttachmentSession = async (): Promise<string | null> => {
    if (sidNow) return sidNow
    if (!state.runtimeReadiness?.ready) {
      set({
        foregroundError:
          state.runtimeReadiness?.message || feedback('components', 'composer.runtimePreflight')
      })
      return null
    }
    const projectPath = selectedProjectPath(state)
    const targetWorkdir =
      projectPath ?? state.defaultWorkspacePath ?? state.workspacePath ?? ''
    const openingPermissionMode = pendingMode ?? state.globalPermissionMode
    const opened = await openSession({
      projectPath,
      modelId: state.model || undefined,
      reasoningEffort: reasoningPreference(
        state.catalog.models.find((model) => model.key === state.model),
        state.reasoningPreferences
      ),
      permissionMode: openingPermissionMode
    })
    if (
      !opened ||
      !('session_id' in opened) ||
      !opened.session_id ||
      opened.runtime_id !== 'codex' ||
      !opened.readiness.ready
    ) {
      set({
        foregroundError:
          opened && 'readiness' in opened
            ? opened.readiness.message || feedback('components', 'composer.runtimeUnavailable')
            : feedback('components', 'composer.attachmentSession')
      })
      return null
    }
    const runtimeRoot = opened.runtime_workdir || opened.workdir
    if (runtimeRoot)
      await window.scholarseed.addAuthorizedRoot('session', runtimeRoot)
    // Persist the assistant draft before activating the attachment session:
    // activation loads its saved context and would otherwise replace the draft.
    if (
      surface === 'assistant' &&
      (await act.prepareAiContext(opened.session_id)) === null
    ) {
      set({ foregroundError: feedback('components', 'composer.contextNotSaved') })
      return null
    }
    const attachmentTitle = draftSessionTitle('', opened)
    openedModeProjection.current = {
      sessionId: opened.session_id,
      mode: openingPermissionMode
    }
    act.openDraftSession(
      opened.session_id,
      attachmentTitle.title,
      runtimeRoot || targetWorkdir,
      opened.project_path ?? projectPath,
      {
        runtimeId: opened.runtime_id,
        runtime: opened.runtime,
        readiness: opened.readiness,
        capabilities: opened.capabilities
      },
      surface,
      attachmentTitle.title_fallback
    )
    if (pendingMode !== null) setPendingMode(null)
    return opened.session_id
  }
  const attachLocalSources = async (selected: Array<{ file?: File; path: string }>): Promise<void> => {
    if (!selected.length || attaching) return
    setAttaching(true)
    try {
      const attachmentSessionId = await ensureAttachmentSession()
      if (!attachmentSessionId) return
      const localPaths = selected.map((item) => item.path).filter(Boolean)
      const registered = localPaths.length
        ? await registerLocalPaths(attachmentSessionId, localPaths)
        : []
      // Browser mode and Playwright's synthetic in-memory File have no OS path.
      // Keep the existing upload as an honest fallback; real Electron files never copy.
      const fallbackFiles = selected
        .filter((item): item is { file: File; path: string } => !item.path && Boolean(item.file))
        .map((item) => item.file)
      const uploaded = await Promise.all(
        fallbackFiles.map((file) =>
          uploadAttachmentFile(attachmentSessionId, file)
        )
      )
      const uploadedRefs = uploaded.filter((item): item is UploadedAttachment =>
        Boolean(item?.path)
      )
      const directRefs: ComposerReference[] = (registered ?? []).map(
        (item): ComposerReference => item.kind === 'directory' ? ({
          type: 'directory',
          id: item.reference_id,
          referenceId: item.reference_id,
          path: item.path,
          title: item.name || item.path
        }) : ({
          type: 'file',
          id: item.reference_id,
          referenceId: item.reference_id,
          path: item.path,
          title: item.name || item.path,
          mediaType: item.media_type,
          size: item.size
        })
      )
      const fallbackRefs: ComposerReference[] = uploadedRefs.map((item) => ({
        type: 'file',
        id: item.path,
        path: item.path,
        title: item.name || item.path,
        mediaType: item.media_type,
        sha256: item.sha256,
        size: item.size
      }))
      const refs = [...directRefs, ...fallbackRefs]
      const failed =
        (localPaths.length > 0 && registered === null) ||
        uploadedRefs.length !== fallbackFiles.length
      if (failed) {
        set({
          foregroundError: refs.length
            ? feedback('components', 'composer.partialFilesFailed')
            : feedback('components', 'composer.filesFailed')
        })
      }
      if (!refs.length) return
      setPendingRefs((prev) => {
        const next = [...prev]
        for (const item of refs) {
          if (
            !next.some(
              (reference) =>
                reference.type === item.type && reference.id === item.id
            )
          )
            next.push(item)
        }
        return next
      })
    } finally {
      setAttaching(false)
      if (attachmentInputRef.current) attachmentInputRef.current.value = ''
    }
  }
  const attachLocalFiles = (files: FileList | null): Promise<void> =>
    attachLocalSources(Array.from(files ?? []).map((file) => {
      try {
        return { file, path: window.scholarseed?.pathForFile?.(file) || '' }
      } catch {
        return { file, path: '' }
      }
    }))
  const pickLocalSources = async (target: ImportPickerTarget): Promise<void> => {
    const pick = window.scholarseed?.pickImport
    if (!pick) {
      if (target === IMPORT_PICKER_TARGET.FILE) attachmentInputRef.current?.click()
      return
    }
    await attachLocalSources((await pick(target)).map((path) => ({ path })))
  }
  const onComposerDragEnter = (
    event: React.DragEvent<HTMLDivElement>
  ): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }
  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onComposerDragLeave = (
    event: React.DragEvent<HTMLDivElement>
  ): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }
  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    setPlusMenuOpen(false)
    setSkillPanelOpen(false)
    void attachLocalFiles(event.dataTransfer.files)
  }
  const atRootRows = [
    AT_LOCAL_FILE_ROOT_ROW,
    ...(!unifiedLocalPicker && window.scholarseed?.pickImport
      ? [AT_LOCAL_DIRECTORY_ROOT_ROW]
      : []),
    ...availableContextSources.map((source) => ({
      kind: source.id,
      label: source.label,
      description: t('composer.sourceDescription', { source: source.label }),
      icon: source.icon
    })),
    AT_SKILL_ROOT_ROW
  ]
  const rootCandidates = atRoot
    ? fuzzyFilter(atRootRows, atTerm, (row) => [
      row.label,
      row.kind,
      row.description
    ])
    : []
  const matchedSkills = atSkill
    ? fuzzyFilter(skillRows ?? [], atTerm, (skill) => [
      skill.name,
      skillDescription(skill, i18n.resolvedLanguage || i18n.language)
    ])
    : []
  const skillCandidates = matchedSkills.slice(0, AT_CANDIDATE_LIMIT)
  const atActive = atQuery !== null && !dismissed && !nonConversationSurfaceOpen
  const contextCandidatesReady = Boolean(
    atContextSourceId &&
    state.aiPanel.contextPickerOpen &&
    state.aiPanel.contextPickerSource === atContextSourceId
  )
  const contextFilter = atResourceContext
    ? resourceContextSearchTerm(atTerm)
    : atTerm
  const matchedContextCandidates =
    atContext && contextCandidatesReady
      ? fuzzyFilter(
        state.aiPanel.contextCandidates,
        contextFilter,
        (candidate) => [
          candidateLabel(candidate, assistantText),
          candidateHint(candidate, assistantText),
          candidate.source_id
        ]
      )
      : []
  const contextCandidates = matchedContextCandidates.slice(
    0,
    AT_CANDIDATE_LIMIT
  )
  const contextCandidatesLoading =
    atContext &&
    (!contextCandidatesReady || state.aiPanel.contextCandidatesLoading)
  // `act` intentionally excluded from deps — its reference is unstable
  // (useMemo depends on `state`), and openAiContextPicker reads
  // stateRef.current so staleness is safe. `atContextSourceId` is stable
  // even when mapping sources creates fresh objects on every render.
  // Including either unstable reference causes an infinite fetch loop:
  //   openAiContextPicker → state change → new refs → effect re-fires.
  React.useEffect(() => {
    if (!atActive || !atContextSourceId) return undefined
    const timer = window.setTimeout(() => {
      act.openAiContextPicker(atContextSourceId, atTerm)
    }, AT_CONTEXT_SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atActive, atContextSourceId, atTerm])
  React.useEffect(() => {
    if (!plusMenuOpen || !state.aiPanel.contextPickerOpen) return undefined
    const timer = window.setTimeout(() => {
      act.openAiContextPicker(
        state.aiPanel.contextPickerSource,
        referenceQuery,
        referenceFilter
      )
    }, AT_CONTEXT_SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plusMenuOpen, referenceFilter, referenceQuery, state.aiPanel.contextPickerOpen, state.aiPanel.contextPickerSource])
  React.useEffect(() => {
    if (!atRoot || !state.aiPanel.contextPickerOpen || plusMenuOpen) return
    act.closeAiContextPicker()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atRoot, plusMenuOpen, state.aiPanel.contextPickerOpen])
  const skillPickerOpen =
    !nonConversationSurfaceOpen &&
    state.accountSettingsPage === null &&
    ((plusMenuOpen && skillPanelOpen) || (atActive && atSkill))
  // Composer stays mounted behind the skill library. Each picker opening must
  // observe installs/removals/activation changes, not its initial inventory.
  // Closing a picker invalidates its request so a slow response cannot replace
  // the inventory fetched by a later opening.
  React.useEffect(() => {
    if (!skillPickerOpen) return
    let current = true
    setSkillRowsLoading(true)
    void getSkills(SKILL_SURFACE_CONVERSATION)
      .then((rows) => {
        if (!current) return
        setSkillRows(rows.filter((skill) => skillCallable(skill, authenticated)))
        setSkillRowsLoading(false)
      })
      .catch((error: unknown) => {
        if (!current) return
        setSkillRowsLoading(false)
        setSkillRows([])
        set({
          foregroundNotice:
            error instanceof Error ? error.message : t('composer.skillFailed')
        })
      })
    return () => {
      current = false
    }
  }, [skillPickerOpen, skillRevision, authenticated])

  // 跳到任一非对话 surface 后把引用候选栏视为已取消；下一次真实输入会由 onChange 复位。
  React.useEffect(() => {
    if (!nonConversationSurfaceOpen) return
    setDismissed(true)
    setModeOpen(false)
  }, [nonConversationSurfaceOpen])

  // 面板打开时键盘事件必须先由当前层处理，即使二级数据仍在加载。
  const candCount = atActive
    ? atRoot
      ? rootCandidates.length
      : atSkill
        ? skillCandidates.length
        : atContext
          ? contextCandidates.length
          : 0
    : 0
  const sel = Math.min(selIdx, Math.max(0, candCount - 1))
  const chooseSkill = (i: number): void => {
    const skill = skillCandidates[i]
    if (!atActive || skillRowsLoading || !skill) return
    const dependenciesReady =
      !skill.dependency_status || skill.dependency_status === 'ready'
    const enabled = skill.enabled !== false && skill.active !== false
    if (!enabled || !dependenciesReady || !isAbsoluteInputPath(skill.path)) {
      set({
        foregroundError:
          skill.unavailable_reason ||
          (!isAbsoluteInputPath(skill.path)
            ? feedback('components', 'composer.skillPath', { name: skill.name })
            : !enabled
              ? feedback('components', 'composer.skillDisabled', { name: skill.name })
              : feedback('components', 'composer.skillDependencies', { name: skill.name }))
      })
      return
    }
    const skillPath = skill.path
    setPendingRefs((items) =>
      items.some((item) => item.type === 'skill' && item.id === skill.name)
        ? items
        : [
          ...items,
          {
            type: 'skill',
            id: skill.name,
            title: skill.name,
            path: skillPath,
            version: skill.version
          }
        ]
    )
    clearAtTrigger()
    setDismissed(true)
    setSelIdx(0)
    window.requestAnimationFrame(() => composerInputRef.current?.focus())
  }
  const chooseContext = (i: number): void => {
    const candidate: AssistantContextCandidate | undefined =
      contextCandidates[i]
    if (!atActive || !candidate || candidate.unavailable_reason) return
    if (atResourceContext && candidate.kind === 'dir') {
      replaceAtTrigger(
        `@${RESOURCE_CONTEXT_KIND}:${resourceContextTriggerPath(candidate.source_id)}/`
      )
      setSelIdx(0)
      return
    }
    void act.addContext(candidate).then((result) => {
      if (result.rejected.length > 0) {
        set({
          foregroundError:
            result.rejected[0]?.message
              ? contextFailureFeedback(result.rejected[0].message)
              : feedback('components', 'composer.contextFailed')
        })
        return
      }
      clearAtTrigger()
      act.closeAiContextPicker()
      setDismissed(true)
      setSelIdx(0)
      window.requestAnimationFrame(() => composerInputRef.current?.focus())
    })
  }
  const chooseAt = (i: number): void => {
    if (atRoot) {
      const row = rootCandidates[i]
      if (!row) return
      if (row.kind === AT_LOCAL_FILE_KIND) {
        clearAtTrigger()
        setDismissed(true)
        setSelIdx(0)
        void pickLocalSources(unifiedLocalPicker
          ? IMPORT_PICKER_TARGET.RESOURCE
          : IMPORT_PICKER_TARGET.FILE)
        return
      }
      if (row.kind === AT_LOCAL_DIRECTORY_KIND) {
        clearAtTrigger()
        setDismissed(true)
        setSelIdx(0)
        void pickLocalSources(IMPORT_PICKER_TARGET.DIRECTORY)
        return
      }
      replaceAtTrigger(`@${row.kind}:`)
      setSelIdx(0)
      return
    }
    if (atSkill) chooseSkill(i)
    if (atContext) chooseContext(i)
  }

  // 长列表键盘导航: 选中项滚动跟随。
  React.useEffect(() => {
    document
      .querySelector('[data-testid="composer-at-panel"] [data-atsel="1"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [selIdx])

  const unfinishedReviewBatches = async (
    projectId: string
  ): Promise<ResourceReviewBatch[] | null> => {
    const loadState = async (
      batchState: ResourceReviewBatch['state']
    ): Promise<ResourceReviewBatch[] | null> => {
      const batches: ResourceReviewBatch[] = []
      let cursor = ''
      do {
        const page = await fetchResourceReviewBatches(
          projectId,
          batchState,
          cursor
        )
        if (!page) return null
        batches.push(...page.items)
        if (!page.next_cursor || page.next_cursor === cursor) break
        cursor = page.next_cursor
      } while (cursor)
      return batches
    }
    const pages = await Promise.all([
      loadState('open'),
      loadState('applying'),
      loadState('failed')
    ])
    return pages.every((page): page is ResourceReviewBatch[] => page !== null)
      ? pages.flat()
      : null
  }

  const acceptReviewBatches = async (
    projectId: string,
    batches: ResourceReviewBatch[]
  ): Promise<boolean> => {
    for (const batch of batches) {
      for (const member of batch.members) {
        const session = Object.values(workspace.getSnapshot().sessions).find(
          (candidate) =>
            candidate.source.kind === 'project' &&
            candidate.source.project === projectId &&
            candidate.source.path === member.path
        )
        if (session?.dirty && !(await workspace.discardMemory(session.id))) {
          set({
            foregroundError: reviewText('admissionFailure.undoFailed', {
              path: member.path
            })
          })
          return false
        }
      }
      const decisions = await Promise.all(
        batch.members.map(async (member) => {
          const action = member.state === 'completed'
            ? member.action ?? 'accept'
            : 'accept'
          if (member.state === 'completed') {
            return {
              file_id: member.file_id,
              review_id: member.review_id,
              pending_revision: member.pending_revision,
              action,
              expected_disk_revision: member.candidate_revision
            }
          }
          const current = await fetchReviewMemberCurrent(
            projectId,
            batch.id,
            member.file_id
          )
          if (!current) throw new ReviewDiskReadError(member.path)
          return {
            file_id: member.file_id,
            review_id: member.review_id,
            pending_revision: member.pending_revision,
            action,
            expected_disk_revision: current.revision
          }
        })
      ).catch((cause: unknown) => {
        set({
          foregroundError: reviewText('admissionFailure.readFailed', {
            path: cause instanceof ReviewDiskReadError ? cause.path : '',
            detail:
              cause instanceof ReviewDiskReadError
                ? ''
                : cause instanceof Error
                  ? cause.message
                  : String(cause)
          })
        })
        return null
      })
      if (!decisions) return false
      const result = await decideResourceReviewBatch(
        projectId,
        batch.id,
        decisions,
        crypto.randomUUID()
      )
      if (!result.ok || result.batch?.state !== 'completed') {
        set({
          foregroundError: reviewText('admissionFailure.submitFailed', {
            detail: result.error ?? ''
          })
        })
        return false
      }
    }
    act.invalidateResources()
    return true
  }

  const submitOnce = async (
    message: string,
    references: ComposerReference[]
  ): Promise<boolean> => {
    // Fail closed at the action boundary as well as through disabled UI.  This
    // also covers Enter and the desktop driver during a live/authorization turn.
    if (state.turnLaunch || interrupting || creditBlocked || !modelAvailable || !selectedSkillsReady)
      return false
    const v = message.trim()
    if (!v && !references.length) return false
    if (activeThread(state).terminated) {
      set({ foregroundError: feedback('components', 'composer.terminated') })
      return false
    }
    if (!runtimeReady) {
      // 未知态没有可展示的结论: 保留草稿并靠禁用态表达, 不要把空错误弹给用户。
      if (runtimeAdmission !== 'unknown') {
        set({
          foregroundError:
            effectiveReadiness(thread, state.runtimeReadiness)?.message
            || feedback('components', 'composer.runtimePreflight')
        })
      }
      return false
    }
    const activeThreadId = state.activeSession
    const sid = activeThread(state).sessionId
    const presentAsUserMessage = shouldOptimisticallyPresentUserMessage(
      Boolean(activeThread(state).running),
      activeThread(state).queuedMessages ?? []
    )
    const clientUserMessageId = crypto.randomUUID()
    const contextAdmission: TurnContextAdmission =
      sid &&
        state.aiPanel.sessionId === sid &&
        state.aiPanel.contextState === 'ready'
        ? {
          clientUserMessageId,
          assistantContextRevision: state.aiPanel.revision,
          ...(state.composerTaskType ? { taskType: state.composerTaskType } : {})
        }
        : {
          clientUserMessageId,
          ...(state.composerTaskType ? { taskType: state.composerTaskType } : {})
        }
    if (
      sid &&
      (state.aiPanel.sessionId !== sid ||
        state.aiPanel.contextState !== 'ready')
    ) {
      set({ foregroundError: feedback('components', 'composer.contextNotReady') })
      return false
    }
    const submittedAssistantRefs = state.aiPanel.refs.filter(
      (ref) => ref.retention === 'next_turn'
    )
    const submittedAssistantRefIds = submittedAssistantRefs.map(
      (ref) => ref.ref_id
    )
    const hideSubmittedAssistantRefs = (): void => {
      if (submittedAssistantRefIds.length === 0) return
      set((current) => ({
        aiPanel: {
          ...current.aiPanel,
          submittedRefIds: Array.from(
            new Set([
              ...current.aiPanel.submittedRefIds,
              ...submittedAssistantRefIds
            ])
          )
        }
      }))
    }
    const optimisticRefs: MessageReference[] = [
      ...references.map(
        (reference): MessageReference => ({
          type: reference.type,
          id: reference.id,
          title: reference.title,
          status: reference.status,
          path: reference.path,
          ...(reference.type === 'file'
            ? {
              mediaType: reference.mediaType,
              sha256: reference.sha256,
              size: reference.size
            }
            : {})
        })
      ),
      ...projectAssistantContextRefs(
        state.aiPanel.refs,
        state.aiPanel.submittedRefIds
      )
    ]
    const optimisticUserMessage: Extract<ConvItem, { kind: 'user' }> = {
      kind: 'user',
      text: v,
      refs: optimisticRefs.length > 0 ? optimisticRefs : undefined,
      itemId: clientUserMessageId
    }
    const restoreDraft = (): void => {
      set((current) => ({
        composerText: current.composerText.trim()
          ? `${v}\n${current.composerText}`
          : v,
        composerRefs: [
          ...references,
          ...current.composerRefs.filter(
            (reference) =>
              !references.some((submitted) => submitted.id === reference.id)
          )
        ]
      }))
    }
    const rollbackImmediatePresentation = (): void => {
      if (activeThreadId) {
        patchThread(activeThreadId, (current) => ({
          conversation: removeOptimisticUserMessage(
            current.conversation,
            clientUserMessageId
          )
        }))
      }
      set({ turnLaunch: null })
      restoreDraft()
    }
    if (presentAsUserMessage) {
      set({
        composerText: '',
        composerTaskType: '',
        turnLaunch: { phase: 'admitting', optimisticUserMessage }
      })
      setPendingRefs([])
      if (activeThreadId) {
        patchThread(activeThreadId, (current) => ({
          conversation: appendOptimisticUserMessage(
            current.conversation,
            optimisticUserMessage
          )
        }))
      }
    }
    const reviewProject =
      activeThread(state).projectPath ??
      activeThread(state).workdir ??
      selectedProjectPath(state) ??
      state.resource.root
    const reviewProjectId = state.projects.find(
      (project) => project.path === reviewProject
    )?.id
    if (reviewProjectId) {
      const batches = await unfinishedReviewBatches(reviewProjectId)
      if (!batches) {
        if (presentAsUserMessage) rollbackImmediatePresentation()
        set({ foregroundError: feedback('shell', 'foreground.reviewUnknown') })
        return false
      }
      if (
        batches.length > 0 &&
        !(await acceptReviewBatches(reviewProjectId, batches))
      ) {
        if (presentAsUserMessage) rollbackImmediatePresentation()
        return false
      }
    }
    if (
      reviewProjectId &&
      reviewProject &&
      (await hasDirtyReviewEditor(
        reviewProjectId,
        reviewProject,
        resourceEditorHasChanges
      ))
    ) {
      if (presentAsUserMessage) rollbackImmediatePresentation()
      set({
        foregroundError:
          feedback('shell', 'foreground.reviewUnsaved')
      })
      return false
    }
    let targetSessionId = sid
    let targetThreadId = activeThreadId
    let targetAdmission = contextAdmission
    if (!targetSessionId) {
      set({
        composerText: '',
        turnLaunch: { phase: 'opening', optimisticUserMessage }
      })
      setPendingRefs([])
      const projectPath = selectedProjectPath(state)
      const targetWorkdir =
        projectPath ?? state.defaultWorkspacePath ?? state.workspacePath ?? ''
      const openingPermissionMode = pendingMode ?? state.globalPermissionMode
      const opened = await openSession({
        projectPath,
        modelId: state.model || undefined,
        reasoningEffort: reasoningPreference(
          state.catalog.models.find((model) => model.key === state.model),
          state.reasoningPreferences
        ),
        permissionMode: openingPermissionMode
      })
      if (
        !opened?.session_id ||
        opened.runtime_id !== 'codex' ||
        !opened.readiness.ready
      ) {
        const failure =
          opened && 'error' in opened
            ? opened.applicationFailure ? requestFailureFeedback(opened.applicationFailure) : opened.error || opened.detail
            : opened && 'readiness' in opened
              ? opened.readiness.message
              : feedback('components', 'composer.createFailed')
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: failure || feedback('components', 'composer.createFailed')
        })
        return false
      }
      const runtimeRoot = opened.runtime_workdir || opened.workdir
      if (runtimeRoot) {
        const authorized = await window.scholarseed
          .addAuthorizedRoot('session', runtimeRoot)
          .catch(() => false)
        if (!authorized) {
          restoreDraft()
          set({
            turnLaunch: null,
            foregroundError: feedback('components', 'composer.workspaceFailed')
          })
          return false
        }
      }
      const assistantContextRevision =
        surface === 'assistant'
          ? await act.prepareAiContext(opened.session_id)
          : null
      if (surface === 'assistant' && assistantContextRevision === null) {
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: feedback('components', 'composer.contextNotSaved')
        })
        return false
      }
      const sessionTitle = draftSessionTitle(promptSessionTitle(v), opened)
      openedModeProjection.current = {
        sessionId: opened.session_id,
        mode: openingPermissionMode
      }
      act.openDraftSession(
        opened.session_id,
        sessionTitle.title,
        opened.runtime_workdir || opened.workdir || targetWorkdir,
        opened.project_path ?? projectPath,
        {
          runtimeId: opened.runtime_id,
          runtime: opened.runtime,
          readiness: opened.readiness,
          capabilities: opened.capabilities
        },
        surface,
        sessionTitle.title_fallback
      )
      if (pendingMode !== null) setPendingMode(null)
      targetSessionId = opened.session_id
      targetThreadId = opened.session_id
      targetAdmission =
        assistantContextRevision === null
          ? contextAdmission
          : { ...contextAdmission, assistantContextRevision }
    }
    if (!targetThreadId || !targetSessionId) {
      if (presentAsUserMessage) rollbackImmediatePresentation()
      set({ foregroundError: feedback('components', 'composer.sessionUnavailable') })
      return false
    }
    let submittedReferences = references
    const registrations = references.filter(
      (reference) => (reference.type === 'file' || reference.type === 'directory') && reference.registrationRequired
    )
    if (registrations.length > 0) {
      const registered = await registerLocalPaths(
        targetSessionId,
        registrations.map((reference) => reference.path)
      )
      const byPath = new Map(
        (registered ?? []).map((reference) => [reference.path, reference])
      )
      if (registrations.some((reference) => {
        const matched = byPath.get(reference.path)
        return !matched || (matched.kind ?? 'file') !== reference.type
      })) {
        if (presentAsUserMessage) rollbackImmediatePresentation()
        else restoreDraft()
        set({ foregroundError: feedback('components', 'composer.filesFailed') })
        return false
      }
      submittedReferences = references.map((reference) => {
        if ((reference.type !== 'file' && reference.type !== 'directory') || !reference.registrationRequired) return reference
        const registeredReference = byPath.get(reference.path)
        if (!registeredReference) return reference
        return {
          ...reference,
          id: registeredReference.reference_id,
          referenceId: registeredReference.reference_id,
          registrationRequired: false,
          path: registeredReference.path,
          title: reference.title || registeredReference.name,
          ...(reference.type === 'file' ? {
            mediaType: registeredReference.media_type || reference.mediaType,
            size: registeredReference.size
          } : {})
        }
      })
    }
    let input: TurnInputItem[]
    try {
      input = buildTurnInput(v, submittedReferences)
    } catch (error) {
      if (presentAsUserMessage) rollbackImmediatePresentation()
      else restoreDraft()
      set({
        foregroundError: error instanceof Error ? error.message : String(error)
      })
      return false
    }
    const optimisticAssistantReferences = await Promise.all(
      submittedAssistantRefs.map(async (ref) => {
        const annotation =
          ref.kind === 'note'
            ? state.aiPanel.annotations.find(
              (item) => item.annotation_id === ref.source_id
            )
            : undefined
        const target = annotation
          ? await locateAnswerAnnotation(
            annotation,
            activeThread(state).conversation
          )
          : null
        const selectedText =
          annotation && target?.status === ANSWER_ANNOTATION_LOCATION.AVAILABLE
            ? target.item?.text.slice(
              annotation.start_utf16,
              annotation.end_utf16
            )
            : undefined
        return {
          label: ref.label,
          ...(ref.anchor ? { anchor: { ...ref.anchor } } : {}),
          ...(ref.selection_source_label !== undefined ? { selection_source_label: ref.selection_source_label } : {}),
          ...(ref.label_fallback !== undefined ? { label_fallback: ref.label_fallback } : {}),
          kind: ref.kind,
          ref_id: ref.ref_id,
          surface:
            ref.anchor || annotation
              ? {
                answer_id: annotation?.answer_id,
                selected_text: selectedText,
                preview_text: ref.anchor?.preview_text,
                comment: annotation?.comment
              }
              : undefined
        }
      })
    )
    // Admission never predicts native execution, even for the first message.
    const optimistic = optimisticQueuedMessage(
      sid ? (activeThread(state).queuedMessages ?? []) : [],
      clientUserMessageId,
      input,
      optimisticAssistantReferences,
      targetAdmission.assistantContextRevision
    )
    retainQueuedOutbox(targetSessionId, optimistic)
    patchThread(targetThreadId, (current) => ({
      queuedMessages: upsertQueuedMessage(
        current.queuedMessages ?? [],
        optimistic
      ),
      ...(presentAsUserMessage
        ? {
          conversation: appendOptimisticUserMessage(
            current.conversation,
            optimisticUserMessage
          )
        }
        : {})
    }))
    if (sid && presentAsUserMessage) set({ turnLaunch: null })
    set({ composerText: '', composerTaskType: '' })
    setPendingRefs([])
    const delivered = await postTurn(
      targetSessionId,
      input,
      state.collaborationMode,
      targetAdmission
    )
    if (!isComposerSubmissionAccepted(delivered)) {
      const authoritative = await listQueuedMessages(targetSessionId)
      if (authoritative === null) {
        patchThread(targetThreadId, (current) => ({
          queuedMessages: markOptimisticQueueOutcomeUnknown(
            current.queuedMessages ?? [],
            clientUserMessageId
          )
        }))
        set({ foregroundError: feedback('components', 'composer.queueUnknown') })
        return false
      }
      const accepted = authoritative.some(
        (item) => item.queued_message_id === clientUserMessageId
      )
      // An absent queue row can already have become a real turn.
      const reconciliation = accepted
        ? null
        : await reconcileQueuedMessage(targetSessionId, clientUserMessageId)
      const applied = reconciliation?.ok && reconciliation.outcome === 'applied'
      const rejected =
        reconciliation?.ok && reconciliation.outcome === 'not_applied'
      if (!accepted && !applied && !rejected) {
        patchThread(targetThreadId, {
          queuedMessages: mergeQueuedOutbox(
            targetSessionId,
            authoritative.map(queuedMessageFromPayload)
          )
        })
        set({ foregroundError: feedback('components', 'composer.queueCheckUnknown') })
        return false
      }
      releaseQueuedOutbox(targetSessionId, clientUserMessageId)
      patchThread(targetThreadId, {
        queuedMessages: mergeQueuedOutbox(
          targetSessionId,
          authoritative.map(queuedMessageFromPayload)
        )
      })
      if (accepted || applied) {
        hideSubmittedAssistantRefs()
        return true
      }
      restoreDraft()
      patchThread(targetThreadId, (current) => ({
        conversation: removeOptimisticUserMessage(
          current.conversation,
          clientUserMessageId
        )
      }))
      set({
        foregroundError: delivered
          ? turnAdmissionFeedback(delivered)
          : feedback('components', 'composer.queueFailed')
      })
      return false
    }
    patchThread(targetThreadId, (current) => ({
      queuedMessages: settleOptimisticQueuedMessage(
        current.queuedMessages ?? [],
        clientUserMessageId
      ),
      ...(delivered?.turn_id
        ? {
          conversation: bindSubmittedTurn(
            current.conversation,
            delivered.turn_id,
            clientUserMessageId
          )
        }
        : {})
    }))
    releaseQueuedOutbox(targetSessionId, clientUserMessageId)
    hideSubmittedAssistantRefs()
    return true
  }

  const submit = (
    message = text,
    references = pendingRefs
  ): Promise<boolean> => {
    if (submissionInFlight.current) return Promise.resolve(false)
    submissionInFlight.current = true
    setSubmittingMessage(true)
    return submitOnce(message, references).finally(() => {
      submissionInFlight.current = false
      setSubmittingMessage(false)
    })
  }

  React.useEffect(() => {
    window.__scholarseedSubmitMessage = (message: string) => submit(message, [])
    return () => {
      delete window.__scholarseedSubmitMessage
    }
  })

  const stop = (): void => {
    if (interrupting) return
    const sid = activeThread(state).sessionId
    if (!sid) return
    patchThread(state.activeSession, { interrupting: true })
    appendThread(state.activeSession, {
      kind: 'status',
      text: t('composer.terminating'),
      displayMessage: feedback('components', 'composer.terminating'),
      tone: 'opinion'
    })
    const request = interruptSession(sid)
    void request.then((result) => {
      if (result.ok && result.idle) {
        patchThread(state.activeSession, {
          interrupting: false,
          running: false,
          status: 'done'
        })
        set({ petOverride: 'done' })
        return
      }
      if (!result.ok) {
        patchThread(state.activeSession, { interrupting: false })
        appendThread(state.activeSession, {
          kind: 'notice',
          displayMessage: feedback('components', 'composer.stopFailed', { error: result.applicationFailure ? requestFailureFeedback(result.applicationFailure) : result.error ?? feedback('components', 'composer.unknownError') }),
          text: t('composer.stopFailed', {
            error: result.error ?? t('composer.unknownError')
          })
        })
      }
    })
  }

  const refreshQueuedMessages = async (sessionId: string): Promise<boolean> => {
    const authoritative = await listQueuedMessages(sessionId)
    if (authoritative === null) return false
    patchThread(sessionId, {
      queuedMessages: mergeQueuedOutbox(
        sessionId,
        authoritative.map(queuedMessageFromPayload)
      )
    })
    return true
  }

  const resolveNotSendable = async (
    sessionId: string,
    queuedMessageId: string
  ): Promise<void> => {
    const authoritative = await listQueuedMessages(sessionId)
    if (authoritative === null) {
      set({ foregroundError: feedback('components', 'composer.checkFailed') })
      return
    }
    const syncQueue = (): void => {
      patchThread(sessionId, {
        queuedMessages: mergeQueuedOutbox(
          sessionId,
          authoritative.map(queuedMessageFromPayload)
        )
      })
    }
    const queued = authoritative.find((item) => item.queued_message_id === queuedMessageId)
    if (!queued) {
      const reconciliation = await reconcileQueuedMessage(sessionId, queuedMessageId)
      if (reconciliation?.ok && reconciliation.outcome === 'applied') {
        releaseQueuedOutbox(sessionId, queuedMessageId)
        syncQueue()
        await act.loadAiContext(sessionId)
        return
      }
      if (!reconciliation?.ok || reconciliation.outcome !== 'not_applied') {
        syncQueue()
        set({ foregroundError: feedback('components', 'composer.checkFailed') })
        return
      }
      const local = (activeThread(state).queuedMessages ?? []).find(
        (item) => item.queuedMessageId === queuedMessageId
      )
      if (local) {
        retainQueuedOutbox(sessionId, {
          ...local,
          state: 'failed',
          safeErrorCode: QUEUED_MESSAGE_SAFE_ERRORS.SUBMISSION_NOT_APPLIED,
          serverPresent: false
        })
      }
      syncQueue()
    } else {
      syncQueue()
      if (queued.state === 'waiting_resources' || queued.state === 'submitting') return
      if (queued.state === 'outcome_unknown') {
        return
      }
    }
    set({ foregroundError: feedback('components', 'composer.notSubmitted') })
  }

  const retractQueuedMessage = async (
    queuedMessageId: string
  ): Promise<void> => {
    if (queuedActionId !== null) return
    const sessionId = sidNow ?? ''
    if (!sessionId) {
      set({ foregroundError: feedback('components', 'composer.withdrawUnavailable') })
      return
    }
    const queued = (activeThread(state).queuedMessages ?? []).find(
      (message) => message.queuedMessageId === queuedMessageId
    )
    if (!queued || !canCancelQueuedMessage(queued)) return
    if (queued.serverPresent === false) {
      releaseQueuedOutbox(sessionId, queuedMessageId)
      patchThread(sessionId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).filter(
          (item) => item.queuedMessageId !== queuedMessageId
        )
      }))
      return
    }
    setQueuedActionId(queuedMessageId)
    try {
      const result = await deleteQueuedMessage(sessionId, queuedMessageId)
      if (result.ok) {
        releaseQueuedOutbox(sessionId, queuedMessageId)
        patchThread(sessionId, (thread) => ({
          queuedMessages: (thread.queuedMessages ?? []).filter(
            (item) => item.queuedMessageId !== queuedMessageId
          )
        }))
        void act.loadAiContext(sessionId)
        return
      }
      await refreshQueuedMessages(sessionId)
      set({ foregroundError: queuedWithdrawalFeedback(result) })
    } finally {
      setQueuedActionId(null)
    }
  }

  const sendQueued = async (queuedMessageId: string): Promise<void> => {
    const sessionId = sidNow ?? ''
    if (!sessionId || queuedActionId || creditBlocked) return
    const queued = (activeThread(state).queuedMessages ?? []).find(
      (message) => message.queuedMessageId === queuedMessageId
    )
    if (!queued || queued.state === RESOURCE_WAIT_QUEUE_STATE) return
    const reviewProject =
      activeThread(state).projectPath ??
      activeThread(state).workdir ??
      selectedProjectPath(state) ??
      state.resource.root
    const reviewProjectId = state.projects.find(
      (project) => project.path === reviewProject
    )?.id
    if (!running && reviewProjectId) {
      const batches = await unfinishedReviewBatches(reviewProjectId)
      if (!batches) {
        set({ foregroundError: feedback('shell', 'foreground.reviewUnknown') })
        return
      }
      if (batches.length > 0) {
        setQueuedActionId(queuedMessageId)
        if (!(await acceptReviewBatches(reviewProjectId, batches))) {
          setQueuedActionId(null)
          return
        }
      }
    }
    if (
      !running &&
      reviewProjectId &&
      reviewProject &&
      (await hasDirtyReviewEditor(
        reviewProjectId,
        reviewProject,
        resourceEditorHasChanges
      ))
    ) {
      setQueuedActionId(null)
      set({
        foregroundError:
          feedback('shell', 'foreground.reviewUnsaved')
      })
      return
    }
    setQueuedActionId(queuedMessageId)
    if (queued.serverPresent === false) {
      const result = await postTurn(
        sessionId,
        queued.input,
        state.collaborationMode,
        {
          clientUserMessageId: queuedMessageId,
          assistantContextRevision: queued.assistantContextRevision
        }
      )
      if (!result?.ok && !result?.queued) {
        set({ foregroundError: feedback('components', 'composer.resendFailed') })
        setQueuedActionId(null)
        return
      }
      releaseQueuedOutbox(sessionId, queuedMessageId)
    } else if (running) {
      const result = await postSide(sessionId, queuedMessageId)
      if (!result?.ok) {
        if (isQueuedMessageNotSendable(result?.reason)) {
          await resolveNotSendable(sessionId, queuedMessageId)
          setQueuedActionId(null)
          return
        }
        await refreshQueuedMessages(sessionId)
        if (result?.reason === QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED) {
          setQueuedActionId(null)
          return
        }
        set({
          foregroundError: feedback('components', 'composer.adjustFailed', {
            error: result?.applicationFailure
              ? requestFailureFeedback(result.applicationFailure)
              : queuedMessageErrorText(result?.reason ?? '', queued.state, t)
          })
        })
        setQueuedActionId(null)
        return
      }
    } else {
      const result = await sendQueuedMessage(sessionId, queuedMessageId)
      if (!result?.ok) {
        if (isQueuedMessageNotSendable(result?.error)) {
          await resolveNotSendable(sessionId, queuedMessageId)
          setQueuedActionId(null)
          return
        }
        await refreshQueuedMessages(sessionId)
        if (result?.error === QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED) {
          setQueuedActionId(null)
          return
        }
        set({
          foregroundError: feedback('components', 'composer.pendingFailed', {
            error: result?.applicationFailure
              ? requestFailureFeedback(result.applicationFailure)
              : queuedMessageErrorText(result?.error ?? '', queued.state, t)
          })
        })
        setQueuedActionId(null)
        return
      }
    }
    const refreshed = await refreshQueuedMessages(sessionId)
    if (!refreshed) {
      set({
        foregroundError: feedback('components', 'composer.queueRefreshFailed')
      })
    }
    await act.loadAiContext(sessionId)
    setQueuedActionId(null)
  }

  const reconcileQueued = async (queuedMessageId: string): Promise<void> => {
    const sessionId = sidNow ?? ''
    if (!sessionId || queuedActionId) return
    setQueuedActionId(queuedMessageId)
    const result = await reconcileQueuedMessage(sessionId, queuedMessageId)
    if (!result?.ok || !result.outcome) {
      set({ foregroundError: feedback('components', 'composer.checkFailed') })
      setQueuedActionId(null)
      return
    }
    if (result.outcome === 'applied') {
      releaseQueuedOutbox(sessionId, queuedMessageId)
      patchThread(sessionId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).filter(
          (message) => message.queuedMessageId !== queuedMessageId
        )
      }))
      set({ foregroundError: feedback('components', 'composer.submissionRecovered') })
    } else if (result.outcome === 'not_applied') {
      const localMessage = (activeThread(state).queuedMessages ?? []).find(
        (message) => message.queuedMessageId === queuedMessageId
      )
      if (!result.message && localMessage) {
        retainQueuedOutbox(sessionId, {
          ...localMessage,
          state: 'failed',
          safeErrorCode: QUEUED_MESSAGE_SAFE_ERRORS.SUBMISSION_NOT_APPLIED,
          serverPresent: false
        })
      }
      patchThread(sessionId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).map((message) =>
          message.queuedMessageId !== queuedMessageId
            ? message
            : result.message
              ? queuedMessageFromPayload(result.message)
              : {
                ...message,
                state: 'failed',
                safeErrorCode: QUEUED_MESSAGE_SAFE_ERRORS.SUBMISSION_NOT_APPLIED,
                serverPresent: false
              }
        )
      }))
    } else {
      patchThread(sessionId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).map((message) =>
          message.queuedMessageId === queuedMessageId
            ? {
              ...message,
              safeErrorCode:
                result.reason || QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED
            }
            : message
        )
      }))
    }
    await refreshQueuedMessages(sessionId)
    await act.loadAiContext(sessionId)
    setQueuedActionId(null)
  }

  const confirmQueuedUnknown = async (queued: QueuedMessage): Promise<void> => {
    const sessionId = sidNow ?? ''
    if (!sessionId || queuedActionId) return
    setQueuedActionId(queued.queuedMessageId)
    const result = await confirmUnknownTurn(sessionId, queued.nativeTurnId || queued.queuedMessageId)
    if (!result.ok) {
      set({ foregroundError: feedback('components', 'composer.confirmContinueFailed') })
      setQueuedActionId(null)
      return
    }
    await refreshQueuedMessages(sessionId)
    await act.loadAiContext(sessionId)
    setQueuedActionId(null)
  }

  const openCreditsPage = async (): Promise<void> => {
    const url = cloudPageUrl('credits', CLOUD_PAGE_ANCHORS.creditsMore)
    if (!url || !window.scholarseed?.openExternal) {
      act.openSettings('models')
      return
    }
    try {
      await window.scholarseed.openExternal(url)
    } catch {
      act.openSettings('models')
    }
  }

  return (
    <div
      className={`relative z-20 isolate flex-none border-t-0 bg-transparent ${composerRootPaddingClass(home, surface)}`}
    >
      <LoginPrompt open={loginPromptOpen} onOpenChange={setLoginPromptOpen} />
      <div ref={inputBoxRef} className={readingColumnClass(home)}>
        {/* Live Status Strip (proposal 65 v10): 真实 live 态 (运行 / 记忆命中 / 约束 / 成本) */}
        <StatusStrip />

        {creditBlocked && (
          <Card
            className="@container mb-[var(--vds-space-3)] flex flex-wrap items-center gap-x-[var(--vds-space-3)] gap-y-[var(--vds-space-2)] !rounded-[var(--vds-radius-6)] px-[var(--vds-space-4)] py-[var(--vds-space-3)] shadow-[var(--vds-shadow-1-center)]"
            data-testid="composer-credits-exhausted"
            id={CREDITS_EXHAUSTED_NOTICE_ID}
            padding="none"
            role="alert"
          >
            <span className="grid size-8 flex-none place-items-center rounded-[var(--vds-radius-circle)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-secondary)]" aria-hidden="true">
              <Gauge size={16} />
            </span>
            <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
              <strong className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                {t('composer.creditsExhaustedTitle')}
              </strong>
              <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                {t('composer.creditsExhaustedDescription')}
              </span>
            </span>
            <Button
              className="flex-none rounded-[var(--vds-radius-pill)] @max-[20rem]:basis-full"
              data-testid="composer-credits-more"
              onClick={() => void openCreditsPage()}
              size="md"
              variant="primary"
            >
              {t('composer.creditsMore')}
            </Button>
          </Card>
        )}

        {!modelAvailable && (
          <div className={NO_MODEL_HINT_CLASS} data-testid="composer-no-model-hint">
            <span
              className="size-[var(--vds-space-1)] flex-none rounded-full bg-[var(--vds-warning-bg-default)]"
              aria-hidden="true"
            />
            <span>{t('composer.noModelLead')}</span>
            <Button
              type="button"
              size="content"
              unstyled
              className={NO_MODEL_HINT_LINK_CLASS}
              data-testid="composer-no-model-configure"
              onClick={() => act.openSettings('models')}
            >
              {t('composer.noModelConfigure')}
            </Button>
            <span>{t('composer.noModelOr')}</span>
            <Button
              type="button"
              size="content"
              unstyled
              className={NO_MODEL_HINT_LINK_CLASS}
              data-testid="composer-no-model-login"
              onClick={() => setLoginPromptOpen(true)}
            >
              {t('composer.noModelLogin')}
            </Button>
          </div>
        )}

        {!selectedSkillsReady && <div role="status" className={NO_MODEL_HINT_CLASS} data-testid="composer-skill-unavailable">
          <span>{t('composer.selectedSkillUnavailable')}</span>
          {!authenticated && <Button variant="ghost" size="sm" onClick={() => setLoginPromptOpen(true)}>{t('composer.noModelLogin')}</Button>}
          <Button variant="ghost" size="sm" onClick={() => act.openSettings('skills')}>{t('composer.manageSkills')}</Button>
        </div>}
        <div className={composerInputShellClass(surface)}>
          {visibleQueuedMessages.length > 0 && (
            <div
              className={queuedMessageClass}
              data-testid="composer-message-queue"
            >
              {visibleQueuedMessages.map((queued) => {
                const referenceSummary = queuedReferenceSummary(
                  queued.input,
                  queued.assistantReferences,
                  assistantText
                )
                const expanded = expandedQueuedMessages.has(
                  queued.queuedMessageId
                )
                const annotations = queued.assistantReferences.filter(
                  (reference) => reference.kind === 'note'
                )
                const otherAssistantReferences =
                  queued.assistantReferences.filter(
                    (reference) => reference.kind !== 'note'
                  )
                const typedReferences = queued.input.filter(
                  (item) => item.type !== 'text'
                )
                const waitingResources =
                  queued.state === RESOURCE_WAIT_QUEUE_STATE
                const blockedByUnknown =
                  queued.state === 'queued' &&
                  queueBlockedByUnconfirmed(visibleQueuedMessages)
                const showQueuedSendAction =
                  !waitingResources &&
                  (!running || queued.state === 'outcome_unknown')
                const actionDisabled =
                  creditBlocked ||
                  queuedActionId !== null ||
                  queued.state === 'submitting' ||
                  (queued.serverPresent !== false &&
                    queued.state !== 'outcome_unknown' &&
                    running &&
                    thread.capabilities?.steer === false)
                const cancelAction = (
                  <Button
                    data-testid={`queued-delete-${queued.queuedMessageId}`}
                    size="sm"
                    variant="outline"
                    disabled={
                      queuedActionId !== null || !canCancelQueuedMessage(queued)
                    }
                    onClick={() =>
                      void retractQueuedMessage(queued.queuedMessageId)
                    }
                  >
                    {waitingResources
                      ? t('composer.cancelWait')
                      : t('composer.delete')}
                  </Button>
                )
                const confirmUnknownAction = (
                  <Button
                    data-testid={`queued-confirm-${queued.queuedMessageId}`}
                    size="sm"
                    variant="primary"
                    disabled={queuedActionId !== null}
                    onClick={() =>
                      void confirmQueuedUnknown(queued)
                    }
                  >
                    {queuedActionId === queued.queuedMessageId
                      ? t('composer.confirmingOutcome')
                      : t('composer.confirmContinue')}
                  </Button>
                )
                return (
                  <Collapsible
                    key={queued.queuedMessageId}
                    open={expanded}
                    onOpenChange={(open) => {
                      setExpandedQueuedMessages((current) => {
                        const next = new Set(current)
                        if (open) next.add(queued.queuedMessageId)
                        else next.delete(queued.queuedMessageId)
                        return next
                      })
                    }}
                  >
                    <div
                      className={queuedMessageRowClass}
                      data-testid={`queued-message-${queued.queuedMessageId}`}
                    >
                      <CollapsibleTrigger
                        asChild
                        className="!border-0 !bg-transparent !shadow-none"
                      >
                        <Button
                          unstyled
                          variant="ghost"
                          className="min-w-0 flex-1 basis-1/2 text-left"
                          data-testid={`queued-expand-${queued.queuedMessageId}`}
                        >
                          {/* CollapsibleTrigger 会把 inline-flex 合入按钮, 这里用内层栅格竖排标题与引用, 避免引用被挤成窄列裁成 "引" */}
                          <span className="grid min-w-0 flex-1 gap-[var(--vds-space-1)]">
                            <span className="block overflow-hidden text-ellipsis whitespace-nowrap text-[var(--text)]">
                              {queued.text || t('composer.referenceMessage')}
                            </span>
                            {referenceSummary ? (
                              <span
                                className="block overflow-hidden text-ellipsis whitespace-nowrap text-[length:var(--vds-font-body-lv1)] text-[var(--text-2)]"
                                title={referenceSummary}
                              >
                                {t('composer.referenceSummary', {
                                  summary: referenceSummary
                                })}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                      </CollapsibleTrigger>
                      {waitingResources ? (
                        <Alert
                          className="w-full min-w-0 basis-full"
                          data-testid={`queued-resource-wait-${queued.queuedMessageId}`}
                          tone="info"
                          title={t(QUEUE_STATE_MESSAGE_KEYS[queued.state])}
                          description={t('composer.resourceWaitHint')}
                          action={cancelAction}
                        />
                      ) : (
                        <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-[var(--vds-space-2)]">
                          <span className="whitespace-nowrap rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
                            {blockedByUnknown
                              ? t('composer.waitingUnknown')
                              : t(QUEUE_STATE_MESSAGE_KEYS[queued.state])}
                          </span>
                          {showQueuedSendAction ? (
                            <Button
                              data-testid={`queued-send-${queued.queuedMessageId}`}
                              size="sm"
                              variant="outline"
                              disabled={actionDisabled}
                              onClick={() =>
                                void (queued.state === 'outcome_unknown'
                                  ? reconcileQueued(queued.queuedMessageId)
                                  : sendQueued(queued.queuedMessageId))
                              }
                            >
                              {queuedActionId === queued.queuedMessageId
                                ? queued.state === 'outcome_unknown'
                                  ? t('composer.checking')
                                  : t('composer.submitting')
                                : queued.state === 'outcome_unknown'
                                  ? t('composer.checkOutcome')
                                  : queued.state === 'failed'
                                    ? t('composer.resend')
                                    : t('composer.sendDirect')}
                            </Button>
                          ) : null}
                          {queued.state === 'outcome_unknown'
                            ? confirmUnknownAction
                            : cancelAction}
                        </div>
                      )}
                      <CollapsibleContent className="w-full min-w-0 basis-full !border-0 !bg-transparent p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-relaxed text-[var(--vds-text-secondary)]">
                        {queued.state === 'outcome_unknown' ? (
                          <Alert
                            className="mb-[var(--vds-space-3)]"
                            tone="warning"
                            title={t('composer.unconfirmed')}
                            description={t('composer.unconfirmedHint')}
                          />
                        ) : null}
                        {blockedByUnknown ? (
                          <Alert
                            className="mb-[var(--vds-space-3)]"
                            data-testid={`queued-blocked-${queued.queuedMessageId}`}
                            tone="info"
                            title={t('composer.waitingUnknown')}
                            description={t('composer.blockedByUnknownHint')}
                          />
                        ) : null}
                        <section>
                          <div className="font-medium text-[var(--text)]">
                            {t('composer.body')}
                          </div>
                          <div className="mt-[var(--vds-space-1)] whitespace-pre-wrap break-words text-[var(--text)]">
                            {queued.text || t('composer.referenceOnly')}
                          </div>
                        </section>
                        {annotations.length > 0 ? (
                          <section
                            className="mt-[var(--vds-space-3)]"
                            data-testid={`queued-annotations-${queued.queuedMessageId}`}
                          >
                            <div className="font-medium text-[var(--text)]">
                              {t('composer.annotations')}
                            </div>
                            {annotations.map((reference, index) => (
                              <div
                                className="mt-[var(--vds-space-2)] rounded-md border border-[var(--border-soft)] p-[var(--vds-space-2)]"
                                key={
                                  reference.ref_id ??
                                  `${queued.queuedMessageId}-annotation-${index}`
                                }
                              >
                                <div className="whitespace-pre-wrap break-words text-[var(--text)]">
                                  {reference.surface?.selected_text ||
                                    reference.surface?.preview_text ||
                                    reference.label ||
                                    t('composer.selectionMissing')}
                                </div>
                                <div className="mt-[var(--vds-space-2)] whitespace-pre-wrap break-words">
                                  {t('composer.annotation', {
                                    comment:
                                      reference.surface?.comment ||
                                      t('composer.noComment')
                                  })}
                                </div>
                              </div>
                            ))}
                          </section>
                        ) : null}
                        {typedReferences.length > 0 ||
                          otherAssistantReferences.length > 0 ? (
                          <section
                            className="mt-[var(--vds-space-3)]"
                            data-testid={`queued-references-${queued.queuedMessageId}`}
                          >
                            <div className="font-medium text-[var(--text)]">
                              {t('composer.otherReferences')}
                            </div>
                            {[
                              ...typedReferences.map((item) => ({
                                key: `${item.type}:${'name' in item ? (item.name ?? '') : ''}:${'reference_id' in item ? (item.reference_id ?? '') : ''}`,
                                label:
                                  item.type === 'skill'
                                    ? t('composer.skillNamed', {
                                      name: item.name
                                    })
                                    : t('composer.itemNamed', {
                                      kind:
                                        item.type === 'local_image'
                                          ? t('composer.image')
                                          : item.type === 'directory'
                                            ? t('composer.folder')
                                          : t('composer.file'),
                                      name: item.name || t('composer.unnamed')
                                    })
                              })),
                              ...otherAssistantReferences.map(
                                (reference, index) => ({
                                  key:
                                    reference.ref_id ??
                                    `${queued.queuedMessageId}-reference-${index}`,
                                  label: queuedReferenceLabel(reference, assistantText)
                                })
                              )
                            ].map((reference) => (
                              <div
                                className="mt-[var(--vds-space-1)] break-words"
                                key={reference.key}
                              >
                                {reference.label}
                              </div>
                            ))}
                          </section>
                        ) : null}
                        {queued.safeErrorCode ? (
                          <div
                            className="mt-[var(--vds-space-3)] text-[var(--c-tension)]"
                            data-error-code={queued.safeErrorCode}
                          >
                            {queuedMessageErrorText(queued.safeErrorCode, queued.state, t)}
                          </div>
                        ) : null}
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )
              })}
            </div>
          )}
          {atActive && (
            <div
              className={atPanelClass}
              data-testid="composer-at-panel"
              role="listbox"
              aria-label={t('composer.chooseReferences')}
              aria-busy={
                (atSkill && skillRowsLoading) ||
                contextCandidatesLoading
              }
            >
              <div className={atHeadClass}>
                <span className={atTitleClass}>
                  {!atRoot && (
                    <Button
                      type="button"
                      className={atBackClass}
                      unstyled
                      variant="ghostIcon"
                      size="content"
                      aria-label={t('composer.backReferences')}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        replaceAtTrigger('@')
                        setSelIdx(0)
                      }}
                    >
                      <span className="grid rotate-180">
                        <Icon name="chevron-right" size={13} />
                      </span>
                    </Button>
                  )}
                  <Icon
                    name={
                      atSkill
                        ? 'skills'
                        : (atContextSource?.icon ?? 'link')
                    }
                    size={14}
                  />
                  {atSkill
                    ? AT_SKILL_PANEL_LABEL
                    : atContextSource
                      ? atContextSource.label
                      : AT_ROOT_LABEL}
                  {!atRoot &&
                    !skillRowsLoading &&
                    !contextCandidatesLoading && (
                      <span className="min-w-[18px] rounded-full bg-[var(--bg-3)] px-[6px] py-px text-center text-[9px] text-[var(--text-3)]">
                        {atSkill
                          ? `${skillCandidates.length}${matchedSkills.length > AT_CANDIDATE_LIMIT ? '+' : ''}`
                          : `${contextCandidates.length}${matchedContextCandidates.length > AT_CANDIDATE_LIMIT ? '+' : ''}`}
                      </span>
                    )}
                </span>
                <span className="whitespace-nowrap text-[9.5px]">
                  {t('composer.filterHint')}
                </span>
              </div>
              {atRoot ? (
                <div className={atListClass}>
                  {rootCandidates.map((row, index) => (
                    <Button
                      key={row.kind}
                      type="button"
                      role="option"
                      variant="ghost"
                      size="content"
                      unstyled
                      aria-selected={index === sel}
                      data-testid={`composer-at-kind-${row.kind}`}
                      data-atsel={index === sel ? '1' : undefined}
                      className={atRowClass(index === sel, false, true)}
                      onMouseEnter={() => setSelIdx(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseAt(index)}
                    >
                      <span className="grid size-[27px] flex-[0_0_27px] place-items-center rounded-[9px] border border-[var(--border-soft)] bg-[var(--bg-3)] text-[var(--text-2)] group-aria-selected:border-[color-mix(in_srgb,var(--brand-ink)_42%,var(--border-soft))] group-aria-selected:bg-[color-mix(in_srgb,var(--accent-soft)_72%,var(--bg-2))] group-aria-selected:text-[var(--brand-ink)]">
                        <Icon name={row.icon} size={14} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-[620]">
                          {row.label}
                        </span>
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] leading-[1.35] text-[var(--text-3)]">
                          {row.description}
                        </span>
                      </span>
                      <Icon name="chevron-right" size={13} />
                    </Button>
                  ))}
                </div>
              ) : atSkill && skillRowsLoading ? (
                <div
                  className={atLoadingClass}
                  role="status"
                  aria-live="polite"
                >
                  <div className={atLoadingCopyClass}>
                    <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
                    <span>{AT_SKILL_LOADING_LABEL}</span>
                  </div>
                  <div className="grid gap-[7px]" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                      <span key={row} className={atSkeletonRowClass}>
                        <i className="block size-[27px] rounded-[9px] bg-[color-mix(in_srgb,var(--text-3)_15%,var(--bg-2))]" />
                        <b className="block h-[9px] w-[min(72%,240px)] rounded-[var(--vds-radius-2)] bg-[color-mix(in_srgb,var(--text-3)_15%,var(--bg-2))]" />
                        <em className="block h-[15px] w-[42px] justify-self-end rounded-[var(--vds-radius-2)] bg-[color-mix(in_srgb,var(--text-3)_15%,var(--bg-2))]" />
                      </span>
                    ))}
                  </div>
                </div>
              ) : atContext && contextCandidatesLoading ? (
                <div
                  className={atLoadingClass}
                  role="status"
                  aria-live="polite"
                >
                  <div className={atLoadingCopyClass}>
                    <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
                    <span>
                      {t('composer.loadingSource', {
                        source: atContextSource?.label ?? ''
                      })}
                    </span>
                  </div>
                </div>
              ) : atSkill && skillCandidates.length ? (
                <div className={atListClass}>
                  {skillCandidates.map((skill, index) => {
                    const dependenciesReady =
                      !skill.dependency_status ||
                      skill.dependency_status === 'ready'
                    const selectable =
                      skill.enabled !== false &&
                      skill.active !== false &&
                      dependenciesReady &&
                      isAbsoluteInputPath(skill.path)
                    const loaded = pendingRefs.some(
                      (item) => item.type === 'skill' && item.id === skill.name
                    )
                    return (
                      <Button
                        key={`${skill.group}:${skill.name}`}
                        type="button"
                        role="option"
                        variant="ghost"
                        size="content"
                        unstyled
                        aria-selected={index === sel}
                        aria-disabled={!selectable}
                        data-testid={`composer-at-skill-${skill.name}`}
                        data-atsel={index === sel ? '1' : undefined}
                        className={atRowClass(index === sel, !selectable)}
                        onMouseEnter={() => setSelIdx(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseSkill(index)}
                      >
                        <span className="grid size-[27px] flex-[0_0_27px] place-items-center rounded-[9px] border border-[var(--border-soft)] bg-[var(--bg-3)] text-[var(--text-2)] group-aria-selected:border-[color-mix(in_srgb,var(--brand-ink)_42%,var(--border-soft))] group-aria-selected:bg-[color-mix(in_srgb,var(--accent-soft)_72%,var(--bg-2))] group-aria-selected:text-[var(--brand-ink)]">
                          <Icon name="skills" size={14} />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-[620]">
                            {skill.name}
                          </span>
                        </span>
                        <span className="flex-none rounded-full bg-[var(--bg-3)] px-[7px] py-[2px] text-[9.5px] text-[var(--text-3)]">
                          {loaded
                            ? t('composer.loaded')
                            : skill.group === 'scholarseed'
                              ? AT_SKILL_BUILTIN_LABEL
                              : AT_SKILL_USER_LABEL}
                        </span>
                      </Button>
                    )
                  })}
                </div>
              ) : atContext && contextCandidates.length ? (
                <div className={atListClass}>
                  {contextCandidates.map((candidate, index) => {
                    const unavailable = Boolean(candidate.unavailable_reason)
                    const loaded = state.aiPanel.refs.some(
                      (ref) =>
                        ref.kind === candidate.kind &&
                        ref.source_id === candidate.source_id
                    )
                    return (
                      <Button
                        key={`${candidate.kind}:${candidate.source_id}`}
                        type="button"
                        role="option"
                        variant="ghost"
                        size="content"
                        unstyled
                        aria-selected={index === sel}
                        aria-disabled={unavailable}
                        data-testid={`composer-at-context-${candidate.kind}-${candidate.source_id}`}
                        data-atsel={index === sel ? '1' : undefined}
                        className={atRowClass(index === sel, unavailable)}
                        onMouseEnter={() => setSelIdx(index)}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseContext(index)}
                        title={candidate.unavailable_reason ? contextText(candidate.unavailable_reason) : undefined}
                      >
                        <span className="grid size-[27px] flex-[0_0_27px] place-items-center rounded-[9px] border border-[var(--border-soft)] bg-[var(--bg-3)] text-[var(--text-2)] group-aria-selected:border-[color-mix(in_srgb,var(--brand-ink)_42%,var(--border-soft))] group-aria-selected:bg-[color-mix(in_srgb,var(--accent-soft)_72%,var(--bg-2))] group-aria-selected:text-[var(--brand-ink)]">
                          <Icon
                            name={
                              candidate.kind === 'dir'
                                ? 'folder'
                                : candidate.kind === 'literature'
                                  ? 'books'
                                  : candidate.kind === 'session'
                                    ? 'quote'
                                    : 'doc'
                            }
                            size={14}
                          />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-[620]">
                            {candidateLabel(candidate, assistantText)}
                          </span>
                          {(candidate.hint || candidate.hintKey || candidate.unavailable_reason) && (
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[10.5px] leading-[1.35] text-[var(--text-3)]">
                              {candidate.unavailable_reason ? contextText(candidate.unavailable_reason) : candidateHint(candidate, assistantText)}
                            </span>
                          )}
                        </span>
                        <span className="flex-none rounded-full bg-[var(--bg-3)] px-[7px] py-[2px] text-[9.5px] text-[var(--text-3)]">
                          {candidate.kind === 'dir' && atResourceContext
                            ? t('composer.enter')
                            : loaded
                              ? t('composer.referenced')
                              : t('composer.referenceAction')}
                        </span>
                      </Button>
                    )
                  })}
                </div>
              ) : (
                <div className="flex min-h-[88px] items-center justify-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--text-3)]">
                  <Icon name="search" size={15} />
                  <span>
                    {atSkill
                      ? AT_SKILL_EMPTY_LABEL
                      : (atContextSource?.emptyLabel ??
                        t('composer.emptyContents'))}
                  </span>
                </div>
              )}
            </div>
          )}
          <div
            data-testid="composer-drop-zone"
            onDragEnter={onComposerDragEnter}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
            className={composerDropZoneClass(home, draggingFiles, surface)}
          >
            {draggingFiles && (
              <div className="pointer-events-none absolute inset-[6px] z-[2] grid place-items-center rounded-[var(--vds-radius-3)] border border-dashed border-[var(--active-border)] bg-[color-mix(in_srgb,var(--active-bg)_56%,transparent)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--text-2)]">
                {COMPOSER_DROP_LABEL}
              </div>
            )}
            {contextTray}
            {hasComposerReferenceCards && (
              <div
                className={`${referenceTrayClass} ${surface === 'assistant' ? '!mt-0' : ''}`}
              >
                <div
                  className={`${referenceTrayScrollerClass} ${surface === 'assistant' ? '!pt-0 !flex-wrap max-h-36 !overflow-y-auto !overflow-x-hidden ![scrollbar-width:thin] [&::-webkit-scrollbar]:!block' : ''}`}
                >
                  <ComposerSkillRefs
                    refs={pendingRefs}
                    onRemove={(index) =>
                      setPendingRefs((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  />
                  <ComposerAttachments
                    refs={pendingRefs}
                    onRemove={(index) =>
                      setPendingRefs((items) =>
                        items.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                    onOpen={act.openFilePreview}
                  />
                </div>
              </div>
            )}
            <Textarea
              ref={composerInputRef}
              data-testid="composer-input"
              aria-label={t('composer.inputLabel')}
              rows={1}
              wrap="soft"
              unstyled
              value={text}
              onChange={(e) => {
                set({ composerText: e.target.value })
                setSelIdx(0)
                setDismissed(false)
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
              }}
              onKeyDown={(e) => {
                const ne = e.nativeEvent as KeyboardEvent & {
                  isComposing?: boolean
                }
                if (composing.current || ne.isComposing || ne.keyCode === 229)
                  return
                // @ 面板开着时，键盘操作不得落入消息发送链路。
                if (atActive) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    if (candCount) setSelIdx((i) => (i + 1) % candCount)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    if (candCount)
                      setSelIdx((i) => (i - 1 + candCount) % candCount)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    e.stopPropagation()
                    if (candCount) chooseAt(sel)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setDismissed(true)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void submit()
                }
              }}
              placeholder={
                creditBlocked
                  ? t('composer.creditsPlaceholder')
                  : interrupting
                  ? INTERRUPTING_INPUT_PLACEHOLDER
                  : running
                    ? RUNNING_INPUT_PLACEHOLDER
                    : surface === 'assistant'
                      ? t('composer.assistantPlaceholder')
                      : t('composer.ask')
              }
              disabled={launching || creditBlocked}
              aria-describedby={creditBlocked ? CREDITS_EXHAUSTED_NOTICE_ID : undefined}
              aria-busy={launching}
              className={composerTextareaClass(home, surface, launching)}
            />
            <div className={composerToolbarClass(home, surface)}>
              {/* PRD 2.1.2 ③: 加号在最左, 圆形描边按钮; 点击向上弹出「添加文件」「技能」。 */}
              <Popover
                open={plusMenuOpen}
                onOpenChange={(open) => {
                  setPlusMenuOpen(open)
                  if (!open) {
                    cancelSubmenuClose()
                    setSkillPanelOpen(false)
                    act.closeAiContextPicker()
                  }
                }}
              >
                <PopoverTrigger asChild>
                  <IconButton
                    type="button"
                    variant="ghostIcon"
                    label={t('composer.addMenu')}
                    title={undefined}
                    data-testid="composer-plus"
                    disabled={attaching || creditBlocked}
                    aria-haspopup="menu"
                    aria-expanded={plusMenuOpen}
                    icon={
                      attaching ? (
                        <span className="leading-none">…</span>
                      ) : (
                        <Icon name="plus" size={18} sw={1.8} />
                      )
                    }
                  />
                </PopoverTrigger>
                {plusMenuOpen && (
                  <PopoverContent
                    className="no-drag z-[var(--vds-z-popover)]"
                    data-testid="composer-plus-menu"
                  >
                    <div
                      className={plusMenuNavClass(false)}
                      ref={plusMenuNavRef}
                      onMouseEnter={cancelSubmenuClose}
                      onMouseLeave={scheduleSubmenuClose}
                    >
                      <Button
                        className={plusNavButtonClass(skillPanelOpen)}
                        data-testid="composer-skills-menu"
                        variant="ghost"
                        size="sm"
                        unstyled
                        icon={<Plug size={15} />}
                        onMouseEnter={openSkillSubmenu}
                        onClick={openSkillSubmenu}
                      >
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                          {t('composer.skill')}
                        </span>
                        <span className="ml-auto inline-flex flex-none items-center text-[var(--text-3)]">
                          /
                        </span>
                      </Button>
                      <Button
                        data-testid="composer-add-file"
                        variant="ghost"
                        size="sm"
                        className={plusNavButtonClass()}
                        unstyled
                        icon={<Paperclip size={15} />}
                        onMouseEnter={() => {
                          setSkillPanelOpen(false)
                          act.closeAiContextPicker()
                        }}
                        onClick={() => {
                          clearAtTrigger()
                          setPlusMenuOpen(false)
                          act.closeAiContextPicker()
                          void pickLocalSources(unifiedLocalPicker
                            ? IMPORT_PICKER_TARGET.RESOURCE
                            : IMPORT_PICKER_TARGET.FILE)
                        }}
                      >
                        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                          {t('composer.addLocal')}
                        </span>
                      </Button>
                      {!unifiedLocalPicker && window.scholarseed?.pickImport && (
                        <Button
                          data-testid="composer-add-folder"
                          variant="ghost"
                          size="sm"
                          className={plusNavButtonClass()}
                          unstyled
                          icon={<Folder size={15} />}
                          onClick={() => {
                            setPlusMenuOpen(false)
                            void pickLocalSources(IMPORT_PICKER_TARGET.DIRECTORY)
                          }}
                        >
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                            {t('composer.addLocalFolder')}
                          </span>
                        </Button>
                      )}
                      {/* 资料引用进入 Session 上下文队列；上面的“添加本地文件”仍是
                            本轮 typed attachment，两种语义不能合并成一套假状态。 */}
                      {availableContextSources.map((source) => (
                        <Button
                          key={source.id}
                          className={plusNavButtonClass(
                            state.aiPanel.contextPickerOpen &&
                            state.aiPanel.contextPickerSource === source.id
                          )}
                          data-testid={`composer-add-${source.id}-context`}
                          variant="ghost"
                          size="sm"
                          unstyled
                          icon={plusMenuSourceIcon(source.icon)}
                          onMouseEnter={() => openSourceSubmenu(source)}
                          onClick={() => openSourceSubmenu(source)}
                        >
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                            {t('composer.referenceSource', {
                              source: source.label
                            })}
                          </span>
                          <span className="ml-auto inline-flex flex-none items-center text-[var(--text-3)]">
                            <Icon name="chevron-right" size={12} />
                          </span>
                        </Button>
                      ))}
                    </div>
                    {(skillPanelOpen || state.aiPanel.contextPickerOpen) && (
                      <div
                        className={submenuFlyoutClass}
                        data-testid="composer-plus-submenu"
                        ref={submenuRef}
                        style={submenuStyle}
                        onFocusCapture={cancelSubmenuClose}
                        onMouseEnter={cancelSubmenuClose}
                        onMouseLeave={scheduleSubmenuClose}
                      >
                        <div className="w-max" ref={submenuContentRef}>
                          {state.aiPanel.contextPickerOpen && (
                            <div
                              className={contextPaneClass}
                              data-testid="ai-context-picker"
                            >
                              <ReferencePicker
                                candidates={state.aiPanel.contextCandidates}
                                emptyLabel={renderFeedback(i18n, state.aiPanel.contextSources.find(
                                  (source) => source.id === state.aiPanel.contextPickerSource
                                )?.emptyLabel ?? t('composer.emptySource'))}
                                filter={referenceFilter}
                                loading={state.aiPanel.contextCandidatesLoading}
                                onBack={() => act.closeAiContextPicker()}
                                onFilterChange={setReferenceFilter}
                                onQueryChange={setReferenceQuery}
                                onSelect={(candidate) => {
                                  void act.addContext(candidate).then((result) => {
                                    if (result.accepted_ref_ids.length === 0) return
                                    setPlusMenuOpen(false)
                                    act.closeAiContextPicker()
                                  })
                                }}
                                projectId={assistantProject(state).projectId}
                                query={referenceQuery}
                                sourceLabel={renderFeedback(i18n, state.aiPanel.contextSources.find(
                                  (source) => source.id === state.aiPanel.contextPickerSource
                                )?.label ?? '')}
                              />
                            </div>
                          )}
                          {/* 技能列表与导航左右排列，由页面浮层避让窗口边缘。
                          (技能名 + 一句话说明); 点某条即载入本次对话并生成输入框内的技能标签。 */}
                          {skillPanelOpen && (
                            <div className={skillPanelClass}>
                            <div className={skillPanelHeadClass}>
                              <Icon name="search" size={14} />
                              <Input
                                value={skillQuery}
                                onChange={(e) => {
                                  setSkillQuery(e.target.value)
                                  setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
                                }}
                                placeholder={t('composer.searchSkills')}
                                aria-label={t('composer.searchSkillsLabel')}
                                size="sm"
                                unstyled
                                className="min-h-0 min-w-0 flex-1 border-0 bg-transparent p-[var(--vds-space-0)] text-[length:var(--vds-font-body-lv2)] text-[var(--text)] shadow-none outline-none placeholder:text-[var(--text-3)]"
                              />
                            </div>
                            {skillRowsLoading || skillRows === null ? (
                              <p className="m-[var(--vds-space-0)] px-[14px] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]">
                                {t('composer.loadSkills')}
                              </p>
                            ) : (
                              (() => {
                                const q = skillQuery.trim().toLowerCase()
                                const language = i18n.resolvedLanguage || i18n.language
                                // 后端已按会话 surface 投射技能；这里只保留其中当前可调用的条目。
                                const rows = skillRows
                                  .filter(
                                    (s): s is SkillInfo & { path: string } =>
                                      s.enabled !== false &&
                                      s.active !== false &&
                                      (!s.dependency_status ||
                                        s.dependency_status === 'ready') &&
                                      isAbsoluteInputPath(s.path)
                                  )
                                  .filter(
                                    (s) =>
                                      !q ||
                                      s.name.toLowerCase().includes(q) ||
                                      skillDescription(s, language)
                                        .toLowerCase()
                                        .includes(q)
                                  )
                                if (!rows.length) {
                                  return (
                                    <p className="m-[var(--vds-space-0)] px-[14px] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]">
                                      {t('composer.emptySkills')}
                                    </p>
                                  )
                                }
                                const visibleRows = rows.slice(
                                  0,
                                  skillVisibleCount
                                )
                                return [
                                  ...visibleRows.map((s) => {
                                    const loaded = pendingRefs.some(
                                      (r) => r.type === 'skill' && r.id === s.name
                                    )
                                    return (
                                      <Button
                                        key={s.name}
                                        type="button"
                                        disabled={loaded}
                                        data-testid={`composer-skill-${s.name}`}
                                        variant="ghost"
                                        size="content"
                                        unstyled
                                        className={[
                                          'block w-full rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[9px] text-left',
                                          loaded
                                            ? 'cursor-default bg-[var(--vds-bg-white-active)]'
                                            : 'hover:bg-[var(--vds-bg-white-hover)]'
                                        ].join(' ')}
                                        onClick={() => {
                                          setPendingRefs((prev) =>
                                            prev.some(
                                              (r) =>
                                                r.type === 'skill' && r.id === s.name
                                            )
                                              ? prev
                                              : [
                                                ...prev,
                                                {
                                                  type: 'skill',
                                                  id: s.name,
                                                  title: s.name,
                                                  path: s.path,
                                                  version: s.version
                                                }
                                              ]
                                          )
                                          // PRD: 点击后菜单收起。
                                          clearAtTrigger()
                                          setSkillPanelOpen(false)
                                          setPlusMenuOpen(false)
                                          setSkillQuery('')
                                        }}
                                      >
                                        <span className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--vds-space-2)]">
                                          <span className="min-w-0 whitespace-normal break-words text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                                            {s.name}
                                          </span>
                                          {loaded ? (
                                            <span className="text-[10px] text-[var(--brand-ink)]">
                                              {t('composer.loaded')}
                                            </span>
                                          ) : s.category ? (
                                            <span className="flex-none rounded-[var(--vds-radius-2)] bg-[var(--bg-3)] px-[7px] py-[2px] text-[10px] text-[var(--text-3)]">
                                              {s.category}
                                            </span>
                                          ) : null}
                                        </span>
                                        {skillDescription(s, language) && (
                                          <ClampedSkillDescription
                                            text={skillDescription(s, language)}
                                          />
                                        )}
                                      </Button>
                                    )
                                  }),
                                  rows.length > visibleRows.length ? (
                                    <Button
                                      type="button"
                                      key="composer-skill-more"
                                      data-testid="composer-skill-more"
                                      variant="ghost"
                                      size="content"
                                      unstyled
                                      className="flex w-full items-center justify-center border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)] hover:bg-[var(--vds-bg-white-hover)] hover:text-[var(--text)]"
                                      onClick={() =>
                                        setSkillVisibleCount(
                                          (count) => count + PLUS_MENU_PAGE_SIZE
                                        )
                                      }
                                    >
                                      {t('composer.viewMore')} ({rows.length - visibleRows.length})
                                    </Button>
                                  ) : null
                                ]
                              })()
                            )}
                            <div className="sticky bottom-[var(--vds-space-0)] border-t border-[var(--border-soft)] bg-[var(--bg-2)] p-[5px]">
                              <Button
                                type="button"
                                data-testid="composer-skill-add"
                                variant="ghost"
                                size="content"
                                unstyled
                                className="flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[10px] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-2)] hover:bg-[var(--vds-bg-white-hover)]"
                                onClick={() => {
                                  clearAtTrigger()
                                  setSkillPanelOpen(false)
                                  setPlusMenuOpen(false)
                                  set({ skillUploadOpen: true })
                                }}
                              >
                                <Icon name="plus" size={13} />
                                <span className="flex-1 text-left">
                                  {t('composer.addSkills')}
                                </span>
                                <Icon name="chevron-right" size={13} />
                              </Button>
                              <Button
                                type="button"
                                data-testid="composer-skill-manage"
                                variant="ghost"
                                size="content"
                                unstyled
                                className="flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[10px] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-2)] hover:bg-[var(--vds-bg-white-hover)]"
                                onClick={() => {
                                  clearAtTrigger()
                                  setSkillPanelOpen(false)
                                  setPlusMenuOpen(false)
                                  act.openCap('skill')
                                }}
                              >
                                <Icon name="settings" size={13} />
                                {t('composer.manageSkills')}
                              </Button>
                            </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </PopoverContent>
                )}
              </Popover>
              <Popover
                open={modeOpen}
                onOpenChange={(open) => {
                  if (open && waitingApproval) return
                  if (open) refreshMode()
                  else setFullAccessConfirmOpen(false)
                  setModeOpen(open)
                }}
              >
                <PopoverTrigger asChild>
                  <IconButton
                    type="button"
                    variant="ghostIcon"
                    label={modeControlLabel}
                    title={modeControlLabel}
                    data-testid="mode-chip"
                    disabled={modeChanging || waitingApproval}
                    aria-busy={modeChanging}
                    aria-haspopup="menu"
                    icon={
                      <IconFont
                        type={modeControlIcon}
                        className="text-[length:var(--vds-font-body-lv2)] leading-none"
                      />
                    }
                  />
                </PopoverTrigger>
                {/* 权限模式菜单: 内容照设计稿, 图标 + 档位名 + 描述; 位置由 Popover 自动上翻。 */}
                <PopoverContent
                  className="no-drag z-[var(--vds-z-popover)] !w-[320px] max-w-[calc(100vw-32px)] gap-0 rounded-[var(--vds-radius-4)]"
                  data-testid="mode-menu"
                >
                  <div className="mb-[var(--vds-space-2)] pt-[10px] px-2 text-[length:var(--vds-font-body-lv2)] font-normal leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-6)]">
                    {t('composer.modeMenuTitle')}
                  </div>
                  {permissionModeList.map((m) => {
                    const meta = modeMeta(m)
                    const active = m === curMode
                    return (
                      <Button
                        key={m}
                        data-testid={`mode-${m}`}
                        variant="ghost"
                        size="content"
                        unstyled
                        className={[
                          'flex w-full items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-2)] py-1.5 text-left',
                          active
                            ? 'bg-[var(--vds-bg-white-active)]'
                            : 'bg-transparent hover:bg-[var(--vds-bg-white-hover)]'
                        ].join(' ')}
                        onClick={() => requestMode(m)}
                      >
                        <span
                          className={`grid size-8 flex-none place-items-center rounded-[var(--vds-radius-4)] border-[length:var(--vds-border-width-1)] bg-[var(--vds-bg-white-default)] ${meta.tone === 'danger' ? 'border-[var(--vds-warning-light-border)] text-[var(--vds-warning-text-primary)]' : 'border-[var(--vds-border-default)] text-[var(--vds-text-secondary)]'}`}
                        >
                          <IconFont
                            type={
                              PERMISSION_MODE_ICON_TYPES[m] ??
                              'icon-qingqiupizhun'
                            }
                            className="text-[15px] leading-none"
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-normal ${meta.tone === 'danger' ? 'text-[var(--vds-warning-text-primary)]' : 'text-[var(--vds-text-primary)]'}`}
                          >
                            {meta.label}
                            {active &&
                              (modeInfo?.deferred ? (
                                <span className="whitespace-nowrap text-[11.5px] text-[var(--text-3)]">
                                  {MODE_PENDING_LABEL}
                                </span>
                              ) : (
                                <span className="text-[12.5px] text-[var(--accent-ink)]">
                                  ✓
                                </span>
                              ))}
                          </span>
                          <span className="block min-w-0 whitespace-normal break-words text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-6)]">
                            {meta.hint}
                          </span>
                        </span>
                      </Button>
                    )
                  })}
                  {fullAccessConfirmOpen && (
                    /* 上边框去掉: 确认区仅靠警告底色与圆角与菜单项区分, 不再加分割线。 */
                    <div className="mx-[var(--vds-space-1)] mb-[var(--vds-space-1)] mt-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] bg-[var(--vds-warning-light-bg-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
                      {/* 标题前不再加 shield icon; 按钮统一用 Button 组件 variant/size, 不手写样式。 */}
                      <div className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-warning-text-primary)]">
                        <span>{MODE_FULL_ACCESS_CONFIRM_TITLE}</span>
                      </div>
                      <p className="mb-[var(--vds-space-2)] mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                        {MODE_FULL_ACCESS_CONFIRM_BODY}
                      </p>
                      <div className="flex justify-end gap-[var(--vds-space-1)]">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setFullAccessConfirmOpen(false)}
                        >
                          {t('composer.cancel')}
                        </Button>
                        <Button
                          type="button"
                          data-testid="mode-bypassPermissions-confirm"
                          variant="warning"
                          size="sm"
                          onClick={() => requestMode('bypassPermissions')}
                        >
                          {t('composer.enable')}
                        </Button>
                      </div>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <Input
                ref={attachmentInputRef}
                data-testid="composer-file-input"
                type="file"
                multiple
                onChange={(e) => void attachLocalFiles(e.target.files)}
                className="hidden"
              />
              {surface !== 'assistant' &&
                thread.capabilities?.collaboration_modes !== false && (
                  <Popover
                    open={collaborationMenuOpen}
                    onOpenChange={setCollaborationMenuOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        aria-label={t('composer.collaboration')}
                        aria-haspopup="listbox"
                        data-testid="collaboration-mode-select"
                        disabled={running || launching}
                        title={t('composer.collaborationHint')}
                        variant="ghost"
                        size="content"
                        unstyled
                        className="group flex h-8 min-w-[146px] items-center justify-between gap-[6px] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-3 py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] transition-colors duration-[var(--vds-duration-fast)] hover:border-[var(--vds-control-border-hover)] hover:bg-[var(--vds-surface-hover)] focus-visible:border-[var(--vds-border-brand)] focus-visible:bg-[var(--vds-surface-hover)]"
                      >
                        <span className="whitespace-nowrap">
                          {collaborationModeLabel}
                        </span>
                        <IconFont
                          aria-hidden="true"
                          className="text-[14px] leading-none text-[var(--vds-text-tertiary)]"
                          type="a-line-switch-arrow-down-s"
                        />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="no-drag z-[var(--vds-z-popover)] min-w-[128px] gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] p-[var(--vds-space-1)]"
                      data-testid="collaboration-mode-menu"
                    >
                      {COLLABORATION_MODE_OPTIONS.map((option) => {
                        const selected =
                          option.value === state.collaborationMode
                        return (
                          <Button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            variant="ghost"
                            size="content"
                            unstyled
                            className={[
                              'flex min-h-8 w-full items-center rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
                              selected
                                ? 'bg-[var(--vds-bg-white-active)]'
                                : 'bg-transparent hover:bg-[var(--vds-bg-white-hover)]'
                            ].join(' ')}
                            onClick={() => {
                              if (isCollaborationMode(option.value)) {
                                set({ collaborationMode: option.value })
                              }
                              setCollaborationMenuOpen(false)
                            }}
                          >
                            {t(option.labelKey)}
                          </Button>
                        )
                      })}
                    </PopoverContent>
                  </Popover>
                )}
              <span className="flex-1" />
              {surface === 'assistant' && <ModelMenu compact />}
              {surface !== 'assistant' && <ModelMenu />}
              {(!running || canSend) && (
                <Button
                  data-testid="composer-send"
                  data-state={
                    submittingMessage
                      ? 'submitting'
                      : launching
                      ? 'opening'
                      : running || interrupting
                        ? 'queueing'
                        : 'idle'
                  }
                  aria-busy={launching || submittingMessage}
                  aria-label={
                    running || interrupting
                      ? RUNNING_SEND_HINT_TITLE
                      : t('composer.sendMessage')
                  }
                  onClick={() => void submit()}
                  disabled={!canSend || submittingMessage}
                  variant={surface === 'assistant' ? 'primary' : 'ghostIcon'}
                  size={surface === 'assistant' ? 'md' : 'icon'}
                  unstyled
                  className={sendButtonClass(
                    surface,
                    canSend,
                    launching || submittingMessage
                  )}
                  title={
                    running || interrupting
                      ? RUNNING_SEND_HINT_TITLE
                      : creditBlocked
                        ? t('composer.creditsExhaustedTitle')
                      : !modelAvailable
                        ? t('composer.noModelSendTitle')
                      : !runtimeReady
                        ? t('composer.runtimeNotReady')
                        : launching
                          ? t('composer.creating')
                          : t('composer.sendMessage')
                  }
                >
                  {launching || submittingMessage ? (
                    <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
                  ) : (
                    <Icon name="send" size={16} sw={2} color="currentColor" />
                  )}
                </Button>
              )}
              {running && (
                <Button
                  data-testid="composer-stop"
                  onClick={stop}
                  disabled={interrupting}
                  variant="danger"
                  size="icon"
                  unstyled
                  className={stopButtonClass(interrupting)}
                  title={
                    interrupting ? t('composer.stopping') : t('composer.stop')
                  }
                >
                  <Icon name="stop" size={20} sw={2} fill="currentColor" color="currentColor" />
                </Button>
              )}
            </div>
          </div>
        </div>
        {home && homeExtras}
      </div>
      {/* 设计稿: 对话面板底部固定 AI 生成内容提示, 不随消息滚动、不遮挡输入与操作。 */}
      <p
        className="pointer-events-none select-none px-[var(--vds-space-2)] pb-[10px] pt-[var(--vds-space-0)] text-center text-[10px] font-normal leading-[16px] text-[var(--vds-text-3)]"
        data-testid="composer-ai-disclaimer"
      >
        {t('composer.aiGeneratedDisclaimer')}
      </p>
      {state.skillUploadOpen && (
        <SkillAdd
          onClose={() => set({ skillUploadOpen: false })}
          onDone={async (message) => {
            set({ skillUploadOpen: false, foregroundNotice: message })
          }}
        />
      )}
    </div>
  )
}

function contextFailureFeedback(message: string) {
  if (message === 'context_save_failed') return feedback('assistant', 'contextErrors.saveRetry')
  const failure = assistantContextFailure(message)
  return 'raw' in failure ? failure.raw : feedback('assistant', failure.key, { detail: failure.detail ?? '' })
}
