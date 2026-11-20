import { draftSessionTitle } from '../../session'
import { assistantContextFailure } from '../../features/assistant/state'
import {
  feedback,
  isRuntimePreparationBusyFeedback,
  renderFeedback,
  runtimePreparationBusyFeedback,
  stopFailureFeedback,
} from '../../contracts/feedback'
import React from 'react'
import { ComposerConfirmationContext } from './confirmation'
import { saveFollowUpPreference, useFollowUpPreference } from './followup'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  CornerDownRight,
  MoreHorizontal,
  BookOpenText,
  Database,
  Folder,
  LogIn,
  Paperclip,
  Plus,
  MessageCircle,
  Hammer,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  activeThread,
  activeDocumentForTurn,
  selectedLiteratureForTurn,
  assistantProject,
  selectedProjectPath,
  useApp,
} from '../../store'
import { assistantSourceAvailable } from '../../features/assistant/candidates'
import type { AppState, SessionSurface, ComposerReference } from '../../store'
import { effectiveSessionModelKey, hasSelectableModel } from '../../catalog'
import { modelSelectionBlocked } from '../../modelselection'
import { CLOUD_PAGE_ANCHORS, cloudPageUrl, creditsBlockBuiltInModel } from '../../account'
import { Icon, type IconName } from '../../icons'
import type {
  CollaborationMode,
  FollowUpMode,
  ModeInfo,
  SkillInfo,
  TurnInputItem,
  UploadedAttachment,
} from '../../api'
import {
  MODEL_SELECTION_UNCONFIRMED,
  confirmUnknownTurn,
  deleteQueuedMessage,
  getMode,
  type GlobalPermissionMode,
  type PermissionApplication,
  getSkills,
  interruptSession,
  isQueuedMessageNotSendable,
  listQueuedMessages,
  openSession,
  postTurn,
  postSide,
  updateQueuedMessage,
  reconcileQueuedMessage,
  requestFailureFeedback,
  registerLocalPaths,
  respondHil,
  setMode,
  setGlobalPermissionMode,
  sendQueuedMessage,
  type TurnContextAdmission,
  uploadAttachmentFile,
} from '../../api'
import { COMPOSER_FOCUS_EVENT, partitionComposerReferences } from '../../reference'
import { PROJECT_GUIDE_ANCHORS } from '../../contracts/onboarding'
import { createComposerDraftStore, restoreComposerDraft } from '../../draft'
import { ComposerEditor, type ComposerEditorLayout, type ComposerEditorReference } from './Editor'
import { ConfirmationCard } from '../primitive/Confirmation'
import { useInteractionPolicies } from './Interactions'
import {
  directQuestionTarget,
  hasHostQuestions,
  pendingQuestionItems,
  hilEventResolution,
  hilSubmissionFailure,
  isTerminalHil,
} from '../../hil'
import { predictionTurn } from '../../prediction'
import { useComposerPrediction } from '../../features/assistant/prediction'
import { ModelMenu } from './ModelMenu'
import { Reconfigure } from './Reconfigure'
import { HOST_CONFIGURATION_CONFLICT } from '../../../../reconfiguration'
import {
  PREPARATION_SUPERSEDED_ERROR,
  runtimePreparationFailure,
  runtimePreparationForegroundFailure,
  runtimePreparationRequestFailure,
  waitForPreparation,
} from '../../preparation'
import { LoginPrompt } from './LoginPrompt'
import { modelDefaultEffort, reasoningPreference } from '../../reasoning'

import { ReferencePicker } from './References'
import { SkillAdd } from './Skills'
import { StatusStrip } from './StatusStrip'
import { skillCallable, skillCategory, skillDescription, skillName } from '../../skill'
import { SKILL_SURFACE_CONVERSATION, SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { useAccountAccess } from './access'
import {
  buildTurnInput,
  canSubmitComposer,
  canConsumeDraftSubmission,
  composerHasContent,
  COMPOSER_SKILL_KIND,
  composerObscured,
  composerTrigger,
  turnAdmissionFeedback,
  isAbsoluteInputPath,
  isComposerSubmissionAccepted,
  isComposerSubmissionRejectedBeforeEnqueue,
  queuedContextSummary,
  queuedReferenceSummary,
  replaceComposerTrigger,
} from '../../input'
import {
  ASSISTANT_CONTEXT_REVISION_CONFLICT,
  pendingAssistantContextRefs,
  type AssistantContextCandidate,
} from '../../contracts/assistant'
import type { ConvItem, MessageReference, QueuedMessage } from '../../model'
import {
  hasDraggedFiles,
  hasDraggedLiterature,
  readLiteratureDrag,
  hasDraggedProjectEntry,
  readProjectEntryDrag,
} from '../../drag'
import { clipboardImageFiles } from '../../attachments'
import { OFFICE_IMAGE_MEDIA_TYPE } from '../../../../images'
import {
  IMPORT_PICKER_TARGET,
  supportsImportPickerTarget,
  type ImportPickerTarget,
} from '../../../../picker'
import { ComposerSkillRefs } from './SkillRefs'
import { AttachmentImages, DraftAttachments } from '../../features/assistant/Images'
import { isImageAttachment } from '../../features/assistant/utils'
import {
  appendOptimisticUserMessage,
  bindSubmittedTurn,
  projectAssistantContextRefs,
  removeOptimisticUserMessage,
  resolveHilItem,
} from '../../transcript'
import {
  canContinueFailedTurn,
  canOfferTurnRecovery,
  effectiveReadiness,
  hasCurrentTurnCapabilityFailure,
  permissionModeFeedback,
  permissionModeNeedsConfirmation,
  permissionModeShowsNextTurn,
  readinessAdmission,
  requestSessionResume,
} from '../../runtime'
import {
  canCancelQueuedMessage,
  canEditQueuedMessage,
  confirmQueuedOutcome,
  hasAcceptedMessageAwaitingRuntime,
  QUEUED_MESSAGE_SAFE_ERRORS,
  QUEUE_PRESENTATION_MESSAGE_KEYS,
  queueBlockedByUnconfirmed,
  markOptimisticQueueOutcomeUnknown,
  optimisticQueuedMessage,
  queuedMessageErrorText,
  queuedMessageNeedsStatusCheck,
  queuedMessageHasUnknownOpen,
  queuedWithdrawalFeedback,
  queuedMessageFromPayload,
  settleOptimisticQueuedMessage,
  shouldOptimisticallyPresentUserMessage,
  shouldPresentQueuedMessage,
  upsertQueuedMessage,
} from '../../queue'
import { mergeQueuedOutbox, releaseQueuedOutbox, retainQueuedOutbox } from '../../outbox'
import { useDocumentWorkspace } from '../../features/workbench/workspace'
import { RESOURCE_CONTEXT_KIND } from '../../features/assistant/api'
import {
  ANSWER_ANNOTATION_LOCATION,
  locateAnswerAnnotation,
} from '../../features/assistant/anchors'
import {
  Alert,
  AlertDialog,
  Dialog,
  DialogContent,
  DialogPortal,
  DialogHeader,
  DialogTitle,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  ScrollArea,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchBox,
  Spinner,
  Tooltip,
  cx,
} from '../ui'
import { IconFont } from '../primitive'
import aiThinking from '../../assets/ai-thinking.gif'

const AT_CONTEXT_SEARCH_DELAY_MS = 150
const COMPOSER_FOCUS_INTERRUPTS = ['beforeinput', 'keydown', 'pointerdown'] as const
const CREDITS_EXHAUSTED_NOTICE_ID = 'composer-credits-exhausted-notice'
// Sentinel root-row kind: unlike the other rows it never becomes `atKind` text —
// selecting it triggers the native file picker immediately instead of a sub-search.
const PLUS_MENU_SOURCE_ICONS: Partial<Record<IconName, LucideIcon>> = {
  folder: Folder,
  books: BookOpenText,
  quote: MessageCircle,
}

function plusMenuSourceIcon(icon: IconName): React.JSX.Element {
  const SourceIcon = PLUS_MENU_SOURCE_ICONS[icon]
  return SourceIcon ? <SourceIcon size={15} /> : <Icon name={icon} size={15} />
}

// 权限模式选择器 (对话框下方图标控件, 对齐 opentui Shift+Tab / webui mode-chip; 经 serve
// /sessions/{sid}/mode 读写)。模式清单以后端 enabled_modes 为准; 此表只是前端文案。
// 需求文档 2.1.2 ④: 菜单只展示三档权限；完全访问权限需二次确认。
type ModeTone = 'neutral' | 'accent' | 'danger'
type ModeMeta = { label: string; hint: string; tone: ModeTone }

const PERMISSION_MODE_OPTIONS: GlobalPermissionMode[] = ['ask', 'safe_auto', 'bypassPermissions']
const PERMISSION_MODE_ICON_TYPES: Record<string, string> = {
  ask: 'icon-qingqiupizhun',
  safe_auto: 'icon-bangwopizhun',
  bypassPermissions: 'icon-wanquanfangwen',
}
const UNKNOWN_MODE_TONE: ModeTone = 'neutral'
const DEFAULT_MODE = 'ask'
const MODE_CONFIRMATION_REQUIRED_ERROR = 'session_permission_confirmation_required'
const HOME_COMPOSER_MAX_HEIGHT_PX = 105
export const COMPOSER_MAX_HEIGHT_PX = 132
const INLINE_COMPOSER_MAX_ROWS = 10
/* assistant 面 pt-12 与 TodoPanel compact 的 -mb-4 相抵，使执行计划与输入框容器间距为 8px。 */
const composerRootPaddingClass = (home: boolean, surface: SessionSurface): string =>
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
    'relative flex flex-col rounded-[var(--vds-radius-4)] border border-solid [interpolate-size:allow-keywords] transition-[height,background-color,border-color] motion-reduce:transition-none',
    '[transition-duration:var(--vds-duration-normal),var(--vds-duration-fast),var(--vds-duration-fast)] ease-[var(--vds-ease-standard)]',
    surface === 'assistant'
      ? '!rounded-[var(--vds-radius-6)] bg-[var(--vds-bg-white-default)] p-[var(--vds-composer-right-padding)] [--vds-composer-right-padding:var(--vds-space-3)]'
      : home
        ? 'px-[var(--vds-composer-right-padding)] pb-[15px] pt-[var(--vds-space-4)] shadow-[0_14px_36px_rgb(45_35_20_/_0.08)] [--vds-composer-right-padding:18px]'
        : 'pb-[9px] pl-[13px] pr-[var(--vds-composer-right-padding)] pt-[var(--vds-space-0)] [--vds-composer-right-padding:11px]',
    draggingFiles
      ? 'border-[var(--active-border)] bg-[color-mix(in_srgb,var(--active-bg)_72%,var(--bg-2))]'
      : surface === 'assistant'
        ? 'border-[var(--border)] bg-[var(--vds-bg-white-default)]'
        : 'border-[var(--border)] bg-[var(--bg-2)]',
  ].join(' ')
const composerToolbarClass = (home: boolean, surface: SessionSurface): string =>
  [
    '@container/toolbar flex items-center',
    surface === 'assistant'
      ? 'mt-[var(--vds-space-2)] gap-[2px] pt-[var(--vds-space-0)]'
      : 'mt-[10px] gap-[7px] pt-[10px]',
    home ? '-ml-[18px] -mr-[17px] flex-nowrap px-[18px] pr-[17px]' : 'flex-nowrap',
  ].join(' ')
const readingColumnClass = (home: boolean, inline: boolean): string =>
  [
    'relative box-border mx-auto',
    home
      ? 'w-full'
      : inline
        ? 'w-full min-w-0'
        : 'w-full min-w-0 max-w-[var(--vds-conversation-content-width)]',
  ].join(' ')
const composerInputShellClass = (surface: SessionSurface): string =>
  `relative ${surface === 'assistant' ? 'mb-[var(--vds-space-1)]' : ''}`
// 待处理消息随排队增多而变长; 与执行计划 (TodoPanel) 同处 flex:0 0 auto 的 composer-host,
// 不设上限时会把上方的执行计划顶出视口。限高并在本区域内滚动, 保证计划等始终可见。
const queuedMessageClass =
  'mx-[var(--vds-space-3)] grid max-h-[var(--vds-composer-suggestion-list-max-height)] divide-y divide-[var(--vds-divider-default)] overflow-y-auto overscroll-contain rounded-t-[var(--vds-radius-4)] border border-b-0 border-solid border-[var(--vds-border-default)] px-[var(--vds-space-3)] py-0 [scrollbar-color:var(--vds-scrollbar-thumb)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-[var(--vds-scrollbar-size)] [&::-webkit-scrollbar-thumb]:rounded-[var(--vds-scrollbar-radius)] [&::-webkit-scrollbar-thumb]:bg-[var(--vds-scrollbar-thumb)] [&::-webkit-scrollbar-track]:bg-transparent'
const queuedMessageRowClass =
  'flex min-h-[var(--vds-control-height-lg)] min-w-0 flex-wrap items-center gap-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)]'
const queuedAlertClass =
  'mb-[var(--vds-space-3)] [&_.vds-alert__title]:text-[length:var(--vds-font-body-lv1)] [&_.vds-alert__title]:leading-[var(--vds-lh-body-lv1)] [&_.vds-alert__title]:font-[var(--vds-fw-regular)]'
const referenceTrayClass = 'mt-[5px] overflow-visible'
const referenceTrayScrollerClass =
  'flex w-max min-w-full flex-nowrap items-center gap-[var(--vds-composer-attachment-gap)] py-[var(--vds-space-1)] pl-[var(--vds-space-0)] pr-[var(--vds-space-1)]'
const PLUS_MENU_PAGE_SIZE = 10
const contextPaneClass =
  'max-h-[var(--vds-composer-reference-picker-max-height)] min-h-0 w-[268px] flex-none overflow-hidden bg-[var(--bg-2)]'
const skillPanelClass = [
  'flex max-h-[min(420px,70vh)] w-[268px] min-w-0 flex-col overflow-hidden bg-[var(--vds-surface-raised)] p-0',
].join(' ')
const skillPanelHeadClass = [
  'grid flex-none gap-[var(--vds-space-2)] border-b border-[var(--border-soft)]',
  'bg-[var(--bg-2)] px-[var(--vds-space-2)] pb-[var(--vds-space-3)] pt-[var(--vds-space-2)]',
].join(' ')
const skillMenuRowClass =
  'w-full rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[calc(var(--vds-space-2)+var(--vds-border-width-1))] text-left text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-regular)] hover:bg-[var(--vds-bg-white-hover-transparent)] focus:bg-[var(--vds-bg-white-hover-transparent)]'
const composerTextareaClass = (
  home: boolean,
  surface: SessionSurface,
  launching: boolean
): string =>
  [
    'block w-full resize-none overflow-y-hidden rounded-none border-0 bg-transparent [font:inherit] tracking-[inherit] text-[var(--text)] outline-none',
    'shadow-none focus:outline-none focus-visible:border-0 focus-visible:shadow-none',
    surface === 'assistant'
      ? 'min-h-[44px] max-h-[132px]'
      : home
        ? 'min-h-[105px] max-h-[105px]'
        : 'min-h-[23px] max-h-[132px]',
    launching ? 'opacity-[0.58]' : 'opacity-100',
  ].join(' ')
const stopButtonClass = (interrupting: boolean): string =>
  [
    'ml-auto grid size-8 min-h-8 min-w-8 place-items-center rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-brand-light-bg-default)] text-[var(--vds-brand-bg-default)] p-0 transition-colors duration-[var(--vds-duration-fast)] hover:bg-[var(--vds-brand-light-bg-hover)]',
    interrupting ? 'cursor-wait opacity-[0.68]' : 'cursor-pointer opacity-100',
  ].join(' ')
const sendButtonClass = (surface: SessionSurface, canSend: boolean, launching: boolean): string =>
  surface === 'assistant'
    ? 'grid size-8 min-w-8 shrink-0 place-items-center rounded-[var(--vds-radius-4)] border-0 bg-[var(--vds-brand-bg-default)] p-0 text-[var(--vds-static-white)] disabled:cursor-not-allowed disabled:bg-[var(--vds-surface-muted)] disabled:text-[var(--vds-text-tertiary)]'
    : [
        'grid h-[34px] min-h-[34px] w-[34px] min-w-[34px] place-items-center rounded-full border-0 [padding:0] transition-[background,color,transform] duration-[150ms]',
        canSend || launching
          ? '[background:var(--brand-ink)] [color:white] opacity-100 hover:[background:var(--brand-ink-hover)]'
          : '[background:var(--bg-3)] [color:var(--text-3)] opacity-60',
        launching ? 'cursor-wait' : canSend ? 'cursor-pointer' : 'cursor-not-allowed',
      ].join(' ')
// 无可用模型提示行: 小圆点与两条下划线出口与正文同基线, 钉在输入卡片上方。
const NO_MODEL_HINT_CLASS =
  'mb-[var(--vds-space-3)] flex flex-wrap items-center gap-x-[var(--vds-space-2)] gap-y-[var(--vds-space-1)] px-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]'
// 会话尚未创建时（首页首条消息才 openSession）的本地待选清单。
const PRE_SESSION_MODES: GlobalPermissionMode[] = ['ask', 'safe_auto', 'bypassPermissions']
const COLLABORATION_MODE_OPTIONS: ReadonlyArray<{
  value: CollaborationMode
  labelKey: 'composer.question' | 'composer.plan'
}> = [
  { value: 'default', labelKey: 'composer.question' },
  { value: 'plan', labelKey: 'composer.plan' },
]
function isCollaborationMode(value: string): value is CollaborationMode {
  return COLLABORATION_MODE_OPTIONS.some((option) => option.value === value)
}

function composerReasoningEffort(state: AppState): string {
  const modelKey = effectiveSessionModelKey(
    state.catalog.models,
    state.model,
    state.activeSession,
    state.threads,
    state.draftModelId
  )
  const model = state.catalog.models.find((entry) => entry.key === modelKey)
  return state.activeSession
    ? state.threads[state.activeSession]?.runtime?.reasoning_effort || modelDefaultEffort(model)
    : reasoningPreference(model, state.reasoningPreferences)
}

export interface ComposerQueueProps {
  followUpMode?: FollowUpMode
  followUpPending?: boolean
  toggleFollowUp?: () => void | Promise<unknown>
  messages: QueuedMessage[]
  skillTitle?: (name: string) => string | undefined
  queuedActionId?: string | null
  editing?: boolean
  running?: boolean
  interrupting?: boolean
  waiting?: boolean
  activeTurnId?: string | null
  creditBlocked?: boolean
  recoveryAvailable?: boolean
  retractQueuedMessage?: (id: string) => void | Promise<unknown>
  confirmQueuedUnknown?: (message: QueuedMessage) => void | Promise<unknown>
  steerQueued?: (message: QueuedMessage) => void | Promise<unknown>
  reconcileQueued?: (id: string) => void | Promise<unknown>
  sendQueued?: (id: string) => void | Promise<unknown>
  editQueued?: (message: QueuedMessage) => void
}

export function ComposerQueue({
  followUpMode = 'queue',
  followUpPending = false,
  toggleFollowUp,
  messages: visibleQueuedMessages,
  skillTitle,
  queuedActionId = null,
  editing = false,
  running = false,
  interrupting = false,
  waiting = false,
  activeTurnId = null,
  creditBlocked = false,
  recoveryAvailable = false,
  retractQueuedMessage,
  confirmQueuedUnknown,
  steerQueued,
  reconcileQueued,
  sendQueued,
  editQueued,
}: ComposerQueueProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  return (
    <>
      {visibleQueuedMessages.length > 0 && (
        <div className={queuedMessageClass} data-testid="composer-message-queue">
          {visibleQueuedMessages.map((queued) => {
            const contextSummary = queuedContextSummary(
              queued.input,
              queued.assistantReferences,
              assistantText,
              skillTitle
            )
            const summary = [queued.text, contextSummary].filter((part) => part.trim()).join(' ')
            const blockedByUnknown =
              queued.state === 'queued' && queueBlockedByUnconfirmed(visibleQueuedMessages)
            const needsStatusCheck = queuedMessageNeedsStatusCheck(queued)
            const unknownOpen = queuedMessageHasUnknownOpen(queued)
            const showQueuedSendAction =
              (queued.state === 'failed' && recoveryAvailable) || needsStatusCheck
            const actionDisabled =
              (creditBlocked && !needsStatusCheck) ||
              queuedActionId !== null ||
              (queued.state === 'failed' && !needsStatusCheck && !recoveryAvailable) ||
              (needsStatusCheck ? !reconcileQueued : !sendQueued)
            const cancelAction = (
              <IconButton
                data-testid={`queued-delete-${queued.queuedMessageId}`}
                size="xs"
                variant="ghostIcon"
                icon={<Icon name="trash" />}
                label={t('composer.delete')}
                disabled={
                  queuedActionId !== null ||
                  !canCancelQueuedMessage(queued) ||
                  !retractQueuedMessage
                }
                onClick={() => void retractQueuedMessage?.(queued.queuedMessageId)}
              />
            )
            const confirmUnknownAction = (
              <Button
                data-testid={`queued-confirm-${queued.queuedMessageId}`}
                size="xs"
                variant="primary"
                disabled={queuedActionId !== null || !confirmQueuedUnknown}
                onClick={() => void confirmQueuedUnknown?.(queued)}
              >
                {queuedActionId === queued.queuedMessageId
                  ? t('composer.confirmingOutcome')
                  : t('composer.confirmContinue')}
              </Button>
            )
            return (
              <React.Fragment key={queued.queuedMessageId}>
                <div
                  className={queuedMessageRowClass}
                  data-testid={`queued-message-${queued.queuedMessageId}`}
                >
                  <Tooltip
                    className="min-w-0 flex-1 basis-1/2"
                    content={summary}
                    contentClassName="whitespace-pre-wrap"
                    disabled={!summary}
                  >
                    <span
                      className="min-w-0 truncate text-[var(--vds-text-primary)]"
                      data-testid={`queued-summary-${queued.queuedMessageId}`}
                      tabIndex={summary ? 0 : undefined}
                    >
                      {summary}
                    </span>
                  </Tooltip>
                  <div className="ml-auto flex shrink-0 flex-nowrap items-center gap-[var(--vds-space-2)]">
                    <Button
                      size="xs"
                      variant="ghost"
                      className="!text-[var(--vds-text-secondary)]"
                      data-testid={`queued-steer-${queued.queuedMessageId}`}
                      icon={<CornerDownRight aria-hidden="true" />}
                      disabled={
                        !canEditQueuedMessage(queued) ||
                        !running ||
                        interrupting ||
                        waiting ||
                        !activeTurnId ||
                        !steerQueued ||
                        queuedActionId !== null
                      }
                      loading={queuedActionId === queued.queuedMessageId}
                      onClick={() => void steerQueued?.(queued)}
                    >
                      {t('composer.steer')}
                    </Button>
                    {(blockedByUnknown ||
                      queued.state === 'failed' ||
                      queued.state === 'outcome_unknown') && (
                      <span className="whitespace-nowrap rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[var(--vds-text-secondary)]">
                        {blockedByUnknown
                          ? t('composer.waitingUnknown')
                          : t(QUEUE_PRESENTATION_MESSAGE_KEYS[queued.state])}
                      </span>
                    )}
                    {showQueuedSendAction ? (
                      <Button
                        data-testid={`queued-send-${queued.queuedMessageId}`}
                        size="xs"
                        variant="outline"
                        disabled={actionDisabled}
                        loading={queuedActionId === queued.queuedMessageId}
                        onClick={() =>
                          void (needsStatusCheck
                            ? reconcileQueued?.(queued.queuedMessageId)
                            : sendQueued?.(queued.queuedMessageId))
                        }
                      >
                        {needsStatusCheck ? t('composer.checkOutcome') : t('composer.resend')}
                      </Button>
                    ) : null}
                    {queued.state === 'outcome_unknown'
                      ? !unknownOpen && confirmUnknownAction
                      : cancelAction}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          size="xs"
                          variant="ghostIcon"
                          icon={<MoreHorizontal />}
                          label={t('composer.queueMore')}
                          data-testid={`queued-more-${queued.queuedMessageId}`}
                        />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem
                          disabled={
                            Boolean(editing) ||
                            queuedActionId !== null ||
                            !canEditQueuedMessage(queued) ||
                            !editQueued
                          }
                          onSelect={() => editQueued?.(queued)}
                        >
                          {t('composer.editQueued')}
                        </DropdownMenuItem>
                        {toggleFollowUp && (
                          <DropdownMenuItem
                            data-testid="queued-toggle-follow-up"
                            disabled={followUpPending}
                            onSelect={() => void toggleFollowUp()}
                          >
                            {t(
                              followUpMode === 'queue'
                                ? 'followUp.disableQueue'
                                : 'followUp.enableQueue'
                            )}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {(queued.state === 'outcome_unknown' || blockedByUnknown) && (
                    <div className="w-full min-w-0 basis-full">
                      {queued.state === 'outcome_unknown' && !unknownOpen ? (
                        <Alert
                          className={queuedAlertClass}
                          tone="warning"
                          title={t('composer.unconfirmed')}
                          description={t('composer.unconfirmedHint')}
                        />
                      ) : null}
                      {blockedByUnknown ? (
                        <Alert
                          className={queuedAlertClass}
                          data-testid={`queued-blocked-${queued.queuedMessageId}`}
                          tone="info"
                          title={t('composer.waitingUnknown')}
                          description={t('composer.blockedByUnknownHint')}
                        />
                      ) : null}
                    </div>
                  )}
                  {queued.retryBlockedErrorCode || queued.safeErrorCode ? (
                    <div
                      className="w-full min-w-0 basis-full whitespace-pre-wrap break-words text-[var(--vds-error-text-primary)]"
                      data-error-code={queued.safeErrorCode}
                    >
                      {queuedMessageErrorText(
                        queued.retryBlockedErrorCode || queued.safeErrorCode,
                        queued.state,
                        t,
                        queued.safeErrorDetails
                      )}
                    </div>
                  ) : null}
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}
    </>
  )
}

export function Composer({
  home = false,
  homeExtras,
  contextTray,
  contextReferences,
  header,
  notice,
  inputBoxRef,
  surface = 'conversation',
  inline = false,
  showModelHint = true,
}: {
  home?: boolean
  /** Rendered directly under the home composer (PRD 2.1.2: 选择项目). */
  homeExtras?: React.ReactNode
  /** Session context queue rendered inside the composer card above the draft text. */
  contextTray?: React.ReactNode
  notice?: React.ReactNode
  contextReferences?: (ComposerEditorReference & {
    inline: boolean
    attachment?: ComposerReference
  })[]
  header?: (controls: {
    continueTurn: () => Promise<boolean>
    continueDisabled: boolean
  }) => React.ReactNode
  /**
   * 外部对齐锚点：透传到输入框所在的会话内容列（readingColumnClass 那一列，
   * 窄时贴合面板、宽时被 --vds-conversation-content-width 封顶并居中）。
   * 历史浮层等需要「与输入框同宽同左」的层据此测量，不再各自复刻内容列布局。
   */
  inputBoxRef?: React.Ref<HTMLDivElement>
  /** Preserve the owning product surface when a new Session is created. */
  surface?: SessionSurface
  inline?: boolean
  showModelHint?: boolean
}): React.JSX.Element {
  const {
    state,
    set,
    composerDraft,
    composerSubmission,
    getSnapshot,
    prepareModel,
    appendThread,
    patchThread,
    act,
  } = useApp()
  const followUp = useFollowUpPreference(state.serviceInstanceId)
  const confirmation = React.useContext(ComposerConfirmationContext)
  const interactionPolicies = useInteractionPolicies()
  const editingHilRequest = React.useRef<string | null>(null)
  const { authenticated, revision: skillRevision } = useAccountAccess(state.backendReady)
  const documents = useDocumentWorkspace()
  const { t, i18n } = useTranslation('components')
  const language = i18n.resolvedLanguage || i18n.language
  const { t: assistantText } = useTranslation('assistant')
  const { t: skillText } = useTranslation('skills')
  const collaborationModeLabel =
    COLLABORATION_MODE_OPTIONS.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    })).find((option) => option.value === state.collaborationMode)?.label ?? t('composer.question')
  const unifiedLocalPicker = supportsImportPickerTarget(
    window.scholarseed?.platform,
    IMPORT_PICKER_TARGET.RESOURCE
  )

  const MODE_META: Record<string, ModeMeta> = {
    // key 必须与后端 GLOBAL_PERMISSION_MODES 一致 (service/chat/constants.py: ask / safe_auto)。
    ask: {
      label: t('composer.askPermission'),
      hint: t('composer.askHint'),
      tone: 'neutral',
    },
    default: {
      label: t('composer.askPermission'),
      hint: t('composer.askHint'),
      tone: 'neutral',
    },
    safe_auto: {
      label: t('composer.autoPermission'),
      hint: t('composer.autoHint'),
      tone: 'accent',
    },
    bypassPermissions: {
      label: t('composer.fullPermission'),
      hint: t('composer.fullHint'),
      tone: 'danger',
    },
  }
  const modeMeta = (mode: string): ModeMeta =>
    MODE_META[mode] ?? { label: mode, hint: '', tone: UNKNOWN_MODE_TONE }
  const MODE_FULL_ACCESS_CONFIRM_TITLE = t('composer.fullConfirm')
  const MODE_FULL_ACCESS_CONFIRM_BODY = t('composer.fullBody')
  const MODE_PENDING_LABEL = t('composer.pending')
  const RUNNING_INPUT_PLACEHOLDER = t(
    followUp.mode === 'steer' ? 'followUp.runningPlaceholder' : 'composer.runningPlaceholder'
  )
  const INTERRUPTING_INPUT_PLACEHOLDER = t('composer.stoppingPlaceholder')
  const RUNNING_SEND_HINT_TITLE = t(
    followUp.mode === 'steer' ? 'followUp.sendSteer' : 'composer.enqueue'
  )
  const COMPOSER_DROP_LABEL = t('composer.drop')
  const [queueEdit, setQueueEdit] = React.useState<{
    sessionId: string
    message: QueuedMessage
    draft: ReturnType<typeof createComposerDraftStore>
  } | null>(null)
  const editing = queueEdit?.sessionId === activeThread(state).sessionId ? queueEdit : null
  const activeDraft = editing?.draft ?? composerDraft
  const text = React.useSyncExternalStore(
    activeDraft.subscribe,
    activeDraft.getSnapshot,
    activeDraft.getSnapshot
  )
  const thread = activeThread(state)
  const readOnlyDraft = React.useMemo(() => createComposerDraftStore(), [])
  const selectedModelKey = effectiveSessionModelKey(
    state.catalog.models,
    state.model,
    state.activeSession,
    state.threads,
    state.draftModelId
  )
  const exactDraftModelId = state.draftModelId
  const sidNow = thread.sessionId
  const selectionBlocked = Boolean(sidNow && modelSelectionBlocked(state.serviceInstanceId, sidNow))
  const selectedEffort = composerReasoningEffort(state)
  const running = Boolean(thread.running)
  const resourceFinalizing = Boolean(
    sidNow && !running && thread.resourceFinalizing && !thread.recoveryBlocked
  )
  const recoveryAvailable =
    canOfferTurnRecovery(thread) && !thread.recoveryPending && !selectionBlocked
  const queuedMessages = thread.queuedMessages ?? []
  const visibleQueuedMessages = queuedMessages.filter(
    (message) =>
      shouldPresentQueuedMessage(message, thread.conversation) &&
      message.queuedMessageId !== editing?.message.queuedMessageId
  )
  const [queueEditError, setQueueEditError] = React.useState(false)
  const interrupting = Boolean(thread.interrupting)
  const canStop =
    interrupting ||
    running ||
    (!resourceFinalizing && hasAcceptedMessageAwaitingRuntime(queuedMessages))
  const launching =
    state.turnLaunch !== null || thread.resumeState === 'pending' || state.modelSelectionPending > 0
  // 资源页只遮住旧对话页；文档旁的 AI 助手仍可交互，不得因此禁用候选菜单。
  const nonConversationSurfaceOpen = composerObscured(surface, {
    capabilities: Boolean(state.capGallery),
    files: state.workspaceFilesOpen,
    documents: Object.keys(documents.tabs).length > 0,
  })
  const prediction = useComposerPrediction(
    sidNow,
    predictionTurn(thread.turnOutcomes),
    running,
    state.composerPredictionsEnabled,
    Boolean(editing || thread.readOnly || launching || nonConversationSurfaceOpen || interrupting),
    text
  )
  const submissionInFlight = React.useRef(false)
  const preparationWait = React.useRef<AbortController | null>(null)
  const composerMounted = React.useRef(true)
  React.useEffect(() => {
    composerMounted.current = true
    return () => {
      composerMounted.current = false
      preparationWait.current?.abort()
    }
  }, [])
  const preparationProject = selectedProjectPath(state)
  React.useEffect(
    () => () => {
      preparationWait.current?.abort()
    },
    [
      state.activeSession,
      selectedModelKey,
      selectedEffort,
      state.modelSelectionGeneration,
      state.draftGeneration,
      state.serviceInstanceId,
      preparationProject,
      state.aiPanel.sessionId,
      state.aiPanel.revision,
    ]
  )
  const composerInputRef = React.useRef<HTMLTextAreaElement>(null)
  const composerDropZoneRef = React.useRef<HTMLDivElement>(null)
  const [inlineReferencesExpanded, setInlineReferencesExpanded] = React.useState(false)
  React.useEffect(() => {
    setInlineReferencesExpanded(false)
  }, [inline, thread.sessionId])
  const [inlineEditorLayout, setInlineEditorLayout] = React.useState<ComposerEditorLayout>({
    multiline: false,
    above: false,
    below: false,
  })
  const pendingCaretRef = React.useRef<number | null>(null)
  const shortcutOpeningRef = React.useRef(false)
  const composerFocusFrameRef = React.useRef<number | null>(null)
  const cancelComposerFocus = React.useCallback((): void => {
    if (composerFocusFrameRef.current !== null) {
      window.cancelAnimationFrame(composerFocusFrameRef.current)
    }
    composerFocusFrameRef.current = null
  }, [])
  const restoreComposerFocus = (): void => {
    // Wait for menu/dialog focus scopes to unmount before returning to the draft.
    cancelComposerFocus()
    composerFocusFrameRef.current = window.requestAnimationFrame(() => {
      composerFocusFrameRef.current = null
      composerInputRef.current?.focus({ preventScroll: true })
    })
  }
  const [selection, setSelection] = React.useState({ start: 0, end: 0 })
  const syncComposerSelection = React.useCallback(() => {
    const input = composerInputRef.current
    if (!input) return
    const start = input.selectionStart
    const end = input.selectionEnd
    setSelection((current) =>
      current.start === start && current.end === end ? current : { start, end }
    )
  }, [])
  React.useLayoutEffect(() => {
    const input = composerInputRef.current
    if (input && pendingCaretRef.current !== null) {
      if (!shortcutOpeningRef.current) input.focus()
      input.setSelectionRange(pendingCaretRef.current, pendingCaretRef.current)
      pendingCaretRef.current = null
      shortcutOpeningRef.current = false
    }
    syncComposerSelection()
  }, [text, activeDraft, syncComposerSelection])
  const attachmentInputRef = React.useRef<HTMLInputElement>(null)
  const dragDepthRef = React.useRef(0)
  const [attaching, setAttaching] = React.useState(false)
  const [submittingMessage, setSubmittingMessage] = React.useState(false)
  const [loginPromptOpen, setLoginPromptOpen] = React.useState(false)
  const [draggingFiles, setDraggingFiles] = React.useState(false)
  const [queuedActionId, setQueuedActionId] = React.useState<string | null>(null)
  const [plusMenuOpen, setPlusMenuOpen] = React.useState(false)
  const [menuEntry, setMenuEntry] = React.useState<'plus' | 'skills'>('plus')
  React.useEffect(() => {
    if (!plusMenuOpen) setMenuEntry('plus')
  }, [plusMenuOpen])
  const [referenceDialogSource, setReferenceDialogSource] = React.useState<string | null>(null)
  const [referenceQuery, setReferenceQuery] = React.useState('')
  const referenceSearchSourceRef = React.useRef<string | null>(null)
  const openingReferenceSourceRef = React.useRef<string | null>(null)
  const [collaborationMenuOpen, setCollaborationMenuOpen] = React.useState(false)
  // PRD 2.1.2 ③(2): 点「技能」展开已启用技能列表, 点某条即加载到本次对话。
  const [skillPanelOpen, setSkillPanelOpen] = React.useState(false)
  const [skillRows, setSkillRows] = React.useState<SkillInfo[] | null>(null)
  const [skillRowsLoading, setSkillRowsLoading] = React.useState(true)
  const [selectedSkillCatalog, setSelectedSkillCatalog] = React.useState<{
    revision: number
    selection: string
    rows: SkillInfo[]
  } | null>(null)
  const [skillQuery, setSkillQuery] = React.useState('')
  const skillSearchRef = React.useRef<HTMLInputElement>(null)
  const skillPanelRef = React.useRef<HTMLDivElement>(null)
  const [skillVisibleCount, setSkillVisibleCount] = React.useState(PLUS_MENU_PAGE_SIZE)
  React.useEffect(() => {
    setPlusMenuOpen(false)
    setSkillPanelOpen(false)
    setReferenceDialogSource(null)
    setSkillQuery('')
    setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
    setReferenceQuery('')
  }, [state.activeSession, home])
  React.useEffect(() => {
    const focus = (event: Event): void => {
      const detail =
        event instanceof CustomEvent
          ? (event.detail as { selectionStart?: number; selectionEnd?: number } | undefined)
          : undefined
      cancelComposerFocus()
      composerFocusFrameRef.current = window.requestAnimationFrame(() => {
        composerFocusFrameRef.current = null
        const input = composerInputRef.current
        if (!input) return
        input.focus()
        if (detail?.selectionStart == null) return
        const start = Math.max(0, Math.min(detail.selectionStart, input.value.length))
        const end = Math.max(start, Math.min(detail.selectionEnd ?? start, input.value.length))
        input.setSelectionRange(start, end)
      })
    }
    window.addEventListener(COMPOSER_FOCUS_EVENT, focus)
    for (const event of COMPOSER_FOCUS_INTERRUPTS) {
      window.addEventListener(event, cancelComposerFocus, true)
    }
    return () => {
      window.removeEventListener(COMPOSER_FOCUS_EVENT, focus)
      for (const event of COMPOSER_FOCUS_INTERRUPTS) {
        window.removeEventListener(event, cancelComposerFocus, true)
      }
      cancelComposerFocus()
    }
  }, [cancelComposerFocus])

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
  const [modeConfirmation, setModeConfirmation] = React.useState<{
    sessionId: string
    mode: GlobalPermissionMode
  } | null>(null)
  const [fullAccessConfirmOpen, setFullAccessConfirmOpen] = React.useState(false)
  // null = 尚未显式覆盖设置页的全局默认；首页用户选了某个会话模式才写入。
  const [pendingMode, setPendingMode] = React.useState<GlobalPermissionMode | null>(null)
  const [modeChanging, setModeChanging] = React.useState(false)
  const modeRequest = React.useRef(0)
  const modeMutation = React.useRef(0)
  React.useEffect(() => {
    setModeConfirmation(null)
    setFullAccessConfirmOpen(false)
  }, [sidNow])
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
    ++modeMutation.current
    setModeChanging(false)
    if (!sidNow) {
      setModeInfo(null)
      return
    }
  }, [sidNow])
  React.useEffect(() => {
    if (sidNow && !modeChanging) refreshMode()
  }, [sidNow, running, thread.activeTurnId, modeChanging, refreshMode])
  const currentModeInfo = modeInfo?.sessionId === sidNow ? modeInfo.value : null
  const openedMode =
    openedModeProjection.current?.sessionId === sidNow ? openedModeProjection.current.mode : null
  const curMode = sidNow
    ? (currentModeInfo?.mode ?? openedMode ?? DEFAULT_MODE)
    : (pendingMode ?? state.globalPermissionMode)
  const modeList = PRE_SESSION_MODES
  const permissionModeList = PERMISSION_MODE_OPTIONS.filter((m) => modeList.includes(m))
  const shownMode = currentModeInfo?.active_mode || curMode
  const activeModeMeta = modeMeta(shownMode)
  const showsNextTurn = permissionModeShowsNextTurn(currentModeInfo)
  const modeLabel = showsNextTurn
    ? t('composer.modeDeferred', {
        active: activeModeMeta.label,
        selected: modeMeta(curMode).label,
      })
    : activeModeMeta.label
  const modeControlLabel = t('composer.modeControl', { mode: modeLabel })
  const modeControlIcon =
    PERMISSION_MODE_ICON_TYPES[shownMode] ?? PERMISSION_MODE_ICON_TYPES[DEFAULT_MODE]
  const persistDefaultMode = async (mode: GlobalPermissionMode): Promise<boolean> => {
    const saved = await setGlobalPermissionMode(mode)
    if (!saved) {
      set({
        foregroundError: permissionModeFeedback({
          ok: false,
        }),
      })
      return false
    }
    set({ globalPermissionMode: saved.mode })
    return true
  }
  const applyMode = (
    m: GlobalPermissionMode,
    application: PermissionApplication = 'auto'
  ): void => {
    if (modeChanging) return
    setFullAccessConfirmOpen(false)
    if (!sidNow) {
      setPendingMode(m)
      ++modeRequest.current
      const request = ++modeMutation.current
      setModeChanging(true)
      void persistDefaultMode(m).then((saved) => {
        if (request !== modeMutation.current) return
        setModeChanging(false)
        if (saved) setPendingMode(null)
      })
      return
    }
    ++modeRequest.current
    const request = ++modeMutation.current
    setModeChanging(true)
    const continuation =
      application === 'interrupt_continue'
        ? {
            clientUserMessageId: crypto.randomUUID(),
            locale: language,
            ...(state.aiPanel.sessionId === sidNow && state.aiPanel.contextState === 'ready'
              ? { assistantContextRevision: state.aiPanel.revision }
              : {}),
            activeDocument: activeDocumentForTurn(state) ?? undefined,
            selectedLiteratureIds: selectedLiteratureForTurn(state),
            ...(state.composerTaskType ? { taskType: state.composerTaskType } : {}),
          }
        : undefined
    void setMode(sidNow, m, application, continuation).then(async (result) => {
      if (request !== modeMutation.current) return
      if (result.ok && result.mode) {
        const applied = result.mode
        setModeInfo((info) => ({
          sessionId: sidNow,
          value: {
            ...(info?.sessionId === sidNow ? info.value : {}),
            mode: applied,
            modes: PRE_SESSION_MODES,
            active_mode: result.active_mode,
            deferred: result.deferred,
            switch_warning: result.switch_warning,
            current_turn_modes: result.current_turn_modes,
            next_turn_selected: result.next_turn_selected,
          },
        }))
        await persistDefaultMode(applied)
        if (request === modeMutation.current) setModeChanging(false)
        return
      }
      setModeChanging(false)
      refreshMode()
      if (result.error === MODE_CONFIRMATION_REQUIRED_ERROR) {
        setModeConfirmation({ sessionId: sidNow, mode: m })
        return
      }
      set({ foregroundError: permissionModeFeedback(result) })
    })
  }
  const requestMode = (m: GlobalPermissionMode): void => {
    if (modeChanging) return
    if (m === curMode && !currentModeInfo?.deferred) {
      setModeOpen(false)
      return
    }
    if (sidNow && permissionModeNeedsConfirmation(currentModeInfo, m, running)) {
      setModeOpen(false)
      setFullAccessConfirmOpen(false)
      setModeConfirmation({ sessionId: sidNow, mode: m })
      return
    }
    if (m === 'bypassPermissions' && curMode !== 'bypassPermissions' && !fullAccessConfirmOpen) {
      setFullAccessConfirmOpen(true)
      return
    }
    applyMode(m)
    setModeOpen(false)
  }

  const confirmMode = (application: PermissionApplication): void => {
    if (!modeConfirmation || modeConfirmation.sessionId !== sidNow) return
    const target = modeConfirmation.mode
    setModeConfirmation(null)
    applyMode(target, application)
  }

  const shortcut = selection.start === selection.end ? composerTrigger(text, selection.start) : null
  const assistantProjectId = assistantProject(state).projectId
  const availableContextSources = state.aiPanel.contextSources
    .filter((source) => assistantSourceAvailable(source, assistantProjectId))
    .map((source) => ({
      ...source,
      label: renderFeedback(i18n, source.label),
      emptyLabel: renderFeedback(i18n, source.emptyLabel),
    }))
  const closePlusSubmenus = (): void => {
    openingReferenceSourceRef.current = null
    setSkillPanelOpen(false)
    if (state.aiPanel.contextPickerOpen) act.closeAiContextPicker()
  }
  const openSkillSubmenu = (): void => {
    clearAtTrigger()
    openingReferenceSourceRef.current = null
    act.closeAiContextPicker()
    if (!skillPanelOpen) setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
    setSkillPanelOpen(true)
  }
  const openSourceSubmenu = (source: (typeof availableContextSources)[number]): void => {
    if (
      openingReferenceSourceRef.current === source.id ||
      (state.aiPanel.contextPickerOpen && state.aiPanel.contextPickerSource === source.id)
    )
      return
    openingReferenceSourceRef.current = source.id
    clearAtTrigger()
    setSkillPanelOpen(false)
    setReferenceQuery('')
    act.openAiContextPicker(source.id)
  }
  const dialogSource = availableContextSources.find((source) => source.id === referenceDialogSource)
  const closeReferenceDialog = (): void => {
    setReferenceDialogSource(null)
    openingReferenceSourceRef.current = null
    act.closeAiContextPicker()
  }
  const pendingRefs: ComposerReference[] = thread.readOnly
    ? []
    : editing
      ? editing.message.input.flatMap((item): ComposerReference[] =>
          item.type === 'skill'
            ? [
                {
                  type: 'skill',
                  id: item.name,
                  title: item.name,
                  path: item.path,
                  version: item.version,
                },
              ]
            : []
        )
      : state.composerRefs
  const pendingContextRefs =
    surface === 'assistant' && !thread.readOnly && !editing
      ? pendingAssistantContextRefs(state.aiPanel.refs, state.aiPanel.submittedRefIds)
      : []
  const hasContent = composerHasContent(text, pendingRefs, pendingContextRefs)
  const contextReady =
    !sidNow || (state.aiPanel.sessionId === sidNow && state.aiPanel.contextState === 'ready')
  const selectedSkillNames = pendingRefs
    .filter((reference) => reference.type === 'skill')
    .map((reference) => reference.id)
  const selectedSkillKey = JSON.stringify(selectedSkillNames)
  React.useEffect(() => {
    if (!state.backendReady || selectedSkillKey === '[]') return
    let current = true
    void getSkills(SKILL_SURFACE_SETTINGS, language)
      .then((rows) => {
        if (current)
          setSelectedSkillCatalog({ revision: skillRevision, selection: selectedSkillKey, rows })
      })
      .catch(() => {
        if (current)
          setSelectedSkillCatalog({
            revision: skillRevision,
            selection: selectedSkillKey,
            rows: [],
          })
      })
    return () => {
      current = false
    }
  }, [state.backendReady, selectedSkillKey, skillRevision, language])
  const selectedSkillsChecking =
    selectedSkillNames.length > 0 &&
    (selectedSkillCatalog?.revision !== skillRevision ||
      selectedSkillCatalog.selection !== selectedSkillKey)
  const selectedSkillsReady =
    selectedSkillNames.length === 0 ||
    (selectedSkillCatalog?.revision === skillRevision &&
      selectedSkillCatalog.selection === selectedSkillKey &&
      selectedSkillNames.every((name) =>
        selectedSkillCatalog.rows.some(
          (skill) => skill.name === name && skillCallable(skill, authenticated)
        )
      ))
  // 运行中发送会进入产品持久队列；插话必须由用户对指定队列项显式触发。
  const runtimeAdmission = readinessAdmission(thread, state.runtimeReadiness)
  // starting/recovering 只在已有会话时放行: 草稿先落持久队列, 运行时恢复后自动执行。新建会话
  // 没有队列兜底, 未知态（readiness 尚未加载）同样必须闭门。
  const runtimeReady =
    state.runtimePreparation?.state !== 'restart_required' &&
    (resourceFinalizing ||
      runtimeAdmission === 'ready' ||
      (runtimeAdmission === 'transient' && Boolean(sidNow)) ||
      (!sidNow && state.runtimePreparationTarget === state.model) ||
      (!sidNow &&
        state.runtimePreparation?.model_id === state.model &&
        state.runtimePreparation.service_instance_id === state.serviceInstanceId &&
        ['accepted', 'applied'].includes(state.runtimePreparation.state)))
  const selectedModel = state.catalog.models.find((model) => model.key === selectedModelKey)
  const creditBlocked = creditsBlockBuiltInModel(state.credits, selectedModel)
  // 目录里一个可选模型都没有（未登录且未配置自有连接时内置/订阅行全被置灰）: 草稿发出去
  // 只会在执行面被拒, 所以发送在这里就闭门, 并在卡片上方给出两条出路。
  const modelAvailable = exactDraftModelId
    ? Boolean(selectedModel && !selectedModel.disabled)
    : hasSelectableModel(state.catalog.models)
  const canSend =
    !confirmation.pending &&
    !thread.readOnly &&
    !(!resourceFinalizing && running && (followUp.loading || followUp.saving || followUp.error)) &&
    (editing
      ? Boolean(text.trim()) && queuedActionId === null
      : canSubmitComposer({
          runtimeReady:
            runtimeReady &&
            contextReady &&
            selectedSkillsReady &&
            !selectionBlocked &&
            activeThread(state).terminated !== true &&
            (!thread.recoveryPending || resourceFinalizing),
          creditsAvailable: !creditBlocked,
          modelAvailable,
          launching,
          running,
          interrupting,
          hasContent,
        }))
  let sendButtonLabel: string = t('composer.sendMessage')
  let sendButtonHint: string | undefined
  if (editing) {
    sendButtonLabel = t('composer.editQueued')
  } else if (resourceFinalizing) {
    sendButtonLabel = t('composer.enqueue')
  } else if (running || interrupting) {
    sendButtonLabel = RUNNING_SEND_HINT_TITLE
  } else if (creditBlocked) {
    sendButtonHint = t('composer.creditsExhaustedTitle')
  } else if (!modelAvailable) {
    sendButtonHint = t(
      authenticated ? 'composer.noModelAuthenticatedSendTitle' : 'composer.noModelSendTitle'
    )
  } else if (!runtimeReady) {
    sendButtonHint = t('composer.runtimeNotReady')
  } else if (launching) {
    sendButtonHint = t('composer.creating')
  }
  const setPendingRefs = React.useCallback(
    (patch: React.SetStateAction<ComposerReference[]>) => {
      if (editing) return
      set((current) => ({
        composerRefs: typeof patch === 'function' ? patch(current.composerRefs) : patch,
      }))
    },
    [set, editing]
  )
  const referenceGroups = partitionComposerReferences(
    [
      ...(!editing ? (contextReferences ?? []) : []),
      ...pendingRefs.map((reference) => {
        const onRemove = editing
          ? undefined
          : () =>
              setPendingRefs((items) =>
                items.filter((item) => item.type !== reference.type || item.id !== reference.id)
              )
        return {
          key: `${reference.type}:${reference.id}`,
          inline: reference.type === 'skill',
          attachment: reference,
          content:
            reference.type === 'skill' ? (
              <ComposerSkillRefs refs={[reference]} onRemove={onRemove} />
            ) : (
              <DraftAttachments
                refs={[reference]}
                sessionId={thread.sessionId ?? undefined}
                onRemove={onRemove}
                onOpen={act.openFilePreview}
              />
            ),
          onRemove,
        }
      }),
    ],
    editing ? [] : state.composerReferenceOrder
  )
  const galleryReferences = referenceGroups.attachments.filter(
    (reference) => reference.attachment && isImageAttachment(reference.attachment)
  )
  const galleryAttachments = galleryReferences.flatMap((reference) =>
    reference.attachment && isImageAttachment(reference.attachment)
      ? [{ ...reference.attachment, id: reference.key }]
      : []
  )
  const replaceAtTrigger = React.useCallback(
    (replacement: string): void => {
      const current = composerDraft.getSnapshot()
      const trigger = composerTrigger(current, selection.start)
      if (!trigger || selection.start !== selection.end) return
      pendingCaretRef.current = trigger.start + replacement.length
      composerDraft.set(replaceComposerTrigger(current, replacement, selection.start))
    },
    [composerDraft, selection]
  )
  const clearAtTrigger = React.useCallback((): void => {
    replaceAtTrigger('')
  }, [replaceAtTrigger])
  const openSkillCenter = (): void => {
    clearAtTrigger()
    setSkillPanelOpen(false)
    setPlusMenuOpen(false)
    act.openWorkbenchView('skills', {
      preserveProject: true,
      returnProjectId: state.homeSelectedProjectId ?? undefined,
    })
  }
  React.useEffect(() => {
    if (
      !shortcut ||
      editing ||
      thread.readOnly ||
      (nonConversationSurfaceOpen && document.activeElement !== composerInputRef.current) ||
      plusMenuOpen
    )
      return
    const skills = shortcut.query.startsWith(COMPOSER_SKILL_KIND + ':')
    const query = skills ? shortcut.query.slice(COMPOSER_SKILL_KIND.length + 1) : ''
    shortcutOpeningRef.current = true
    clearAtTrigger()
    setMenuEntry(skills ? 'skills' : 'plus')
    setSkillPanelOpen(skills)
    if (skills) setSkillQuery(query)
    composerDropZoneRef.current
      ?.querySelector<HTMLButtonElement>('[data-testid="composer-plus"]')
      ?.click()
  }, [
    shortcut?.start,
    shortcut?.query,
    editing,
    thread.readOnly,
    nonConversationSurfaceOpen,
    plusMenuOpen,
    clearAtTrigger,
  ])
  const resolveAttachmentSources = async (
    attachmentSessionId: string,
    selected: Array<{ file?: File; path: string }>
  ): Promise<{ refs: ComposerReference[]; failed: boolean }> => {
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
      fallbackFiles.map((file) => uploadAttachmentFile(attachmentSessionId, file))
    )
    const uploadedRefs = uploaded.filter((item): item is UploadedAttachment => Boolean(item?.path))
    const directRefs: ComposerReference[] = (registered ?? []).map((item): ComposerReference =>
      item.kind === 'directory'
        ? {
            type: 'directory',
            id: item.reference_id,
            referenceId: item.reference_id,
            path: item.path,
            title: item.name || item.path,
          }
        : {
            type: 'file',
            id: item.reference_id,
            referenceId: item.reference_id,
            path: item.path,
            title: item.name || item.path,
            mediaType: item.media_type,
            size: item.size,
          }
    )
    const fallbackRefs: ComposerReference[] = uploadedRefs.map((item) => ({
      type: 'file',
      id: item.path,
      path: item.path,
      title: item.name || item.path,
      mediaType: item.media_type,
      sha256: item.sha256,
      size: item.size,
      previewSource: item.relative_path
        ? {
            kind: 'session-file',
            sessionId: attachmentSessionId,
            path: item.relative_path,
            mediaType: item.media_type,
          }
        : undefined,
    }))
    const refs = [...directRefs, ...fallbackRefs]
    const failed =
      (localPaths.length > 0 && registered === null) || uploadedRefs.length !== fallbackFiles.length
    return { refs, failed }
  }
  const attachLocalSources = async (
    selected: Array<{ file?: File; path: string; directory?: boolean; imagePreview?: Blob | null }>
  ): Promise<void> => {
    if (!selected.length || attaching) return
    const addReferences = (refs: ComposerReference[]): void => {
      setPendingRefs((prev) => {
        const next = [...prev]
        for (const item of refs) {
          const index = next.findIndex(
            (reference) => reference.type === item.type && reference.id === item.id
          )
          if (index < 0) next.push(item)
          else {
            const previous = next[index]
            if (
              previous.type === 'file' &&
              previous.localSource &&
              !previous.localSource.file &&
              !previous.localSource.imagePreview &&
              item.type === 'file' &&
              item.localSource?.imagePreview
            ) {
              next[index] = {
                ...previous,
                localSource: {
                  ...previous.localSource,
                  imagePreview: item.localSource.imagePreview,
                },
              }
            }
          }
        }
        return next
      })
    }
    if (!sidNow) {
      addReferences(
        selected.flatMap(({ file, path, directory, imagePreview }): ComposerReference[] => {
          if (!path && !file) return []
          const source = {
            id: path || crypto.randomUUID(),
            path,
            title:
              file?.name ||
              path
                .split(/[/\\\\]/)
                .filter(Boolean)
                .at(-1) ||
              path,
            localSource: { file, imagePreview },
          }
          return directory
            ? [{ ...source, type: 'directory' }]
            : [{ ...source, type: 'file', mediaType: file?.type, size: file?.size }]
        })
      )
      if (attachmentInputRef.current) attachmentInputRef.current.value = ''
      return
    }
    setAttaching(true)
    try {
      const { refs, failed } = await resolveAttachmentSources(sidNow, selected)
      if (failed) {
        set({
          foregroundError: refs.length
            ? feedback('components', 'composer.partialFilesFailed')
            : feedback('components', 'composer.filesFailed'),
        })
      }
      if (refs.length) addReferences(refs)
    } finally {
      setAttaching(false)
      if (attachmentInputRef.current) attachmentInputRef.current.value = ''
    }
  }
  const attachLocalFiles = (files: ArrayLike<File> | null): Promise<void> =>
    attachLocalSources(
      Array.from(files ?? []).map((file) => {
        try {
          return { file, path: window.scholarseed?.pathForFile?.(file) || '' }
        } catch {
          return { file, path: '' }
        }
      })
    )
  const composerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    prediction.dismiss()
    const files = clipboardImageFiles(event.clipboardData.items)
    if (!files.length) return
    event.preventDefault()
    if (launching || creditBlocked || attaching) return
    void attachLocalFiles(files)
  }
  const composerPasteRef = React.useRef(composerPaste)
  React.useLayoutEffect(() => {
    composerPasteRef.current = composerPaste
  })
  const handleComposerPaste = React.useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      composerPasteRef.current(event)
    },
    []
  )
  const pickLocalSources = async (target: ImportPickerTarget): Promise<void> => {
    const pick = window.scholarseed?.pickImport
    if (!pick) {
      if (target === IMPORT_PICKER_TARGET.FILE) attachmentInputRef.current?.click()
      return
    }
    const previewPick = window.scholarseed?.pickImportPreview
    const selected = previewPick
      ? await previewPick(target)
      : (await pick(target)).map((path) => ({ path, imagePreview: undefined }))
    await attachLocalSources(
      selected.map(({ path, imagePreview }) => ({
        path,
        directory: target === IMPORT_PICKER_TARGET.DIRECTORY,
        imagePreview:
          imagePreview === undefined
            ? undefined
            : imagePreview.status === 'image'
              ? new Blob([new Uint8Array(imagePreview.bytes)], { type: OFFICE_IMAGE_MEDIA_TYPE })
              : null,
      }))
    )
  }
  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (thread.readOnly) return
    if (
      !hasDraggedFiles(event.dataTransfer) &&
      !hasDraggedLiterature(event.dataTransfer) &&
      !hasDraggedProjectEntry(event.dataTransfer)
    )
      return
    event.preventDefault()
    dragDepthRef.current += 1
    setDraggingFiles(true)
  }
  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (thread.readOnly) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'none'
      return
    }
    if (
      !hasDraggedFiles(event.dataTransfer) &&
      !hasDraggedLiterature(event.dataTransfer) &&
      !hasDraggedProjectEntry(event.dataTransfer)
    )
      return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (
      !hasDraggedFiles(event.dataTransfer) &&
      !hasDraggedLiterature(event.dataTransfer) &&
      !hasDraggedProjectEntry(event.dataTransfer)
    )
      return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFiles(false)
  }
  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (thread.readOnly || editing) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (
      !hasDraggedFiles(event.dataTransfer) &&
      !hasDraggedLiterature(event.dataTransfer) &&
      !hasDraggedProjectEntry(event.dataTransfer)
    )
      return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = 0
    setDraggingFiles(false)
    setPlusMenuOpen(false)
    setSkillPanelOpen(false)
    if (hasDraggedLiterature(event.dataTransfer) || hasDraggedProjectEntry(event.dataTransfer)) {
      const projectId = assistantProject(state).projectId
      const entry = hasDraggedProjectEntry(event.dataTransfer)
        ? readProjectEntryDrag(event.dataTransfer, projectId)
        : null
      const candidates: AssistantContextCandidate[] | null = hasDraggedProjectEntry(
        event.dataTransfer
      )
        ? entry
          ? [
              {
                kind: entry.kind,
                source_id: entry.path,
                label: entry.name,
                retention: 'next_turn',
                origin: 'explicit',
              },
            ]
          : null
        : (readLiteratureDrag(event.dataTransfer, projectId)?.map((item) => ({
            kind: 'literature',
            source_id: item.id,
            label: item.title,
            retention: 'next_turn',
            origin: 'explicit',
          })) ?? null)
      if (!candidates) {
        set({ foregroundError: feedback('components', 'composer.contextFailed') })
        return
      }
      void act.addContexts(candidates).then((result) => {
        if (result.rejected.length > 0) {
          set({ foregroundError: contextFailureFeedback(result.rejected[0].message) })
        }
        composerInputRef.current?.focus()
      })
      return
    }
    void attachLocalFiles(event.dataTransfer.files)
  }

  React.useEffect(() => {
    if ((!plusMenuOpen && !referenceDialogSource) || !state.aiPanel.contextPickerOpen) {
      referenceSearchSourceRef.current = null
      openingReferenceSourceRef.current = null
      return undefined
    }
    if (referenceSearchSourceRef.current !== state.aiPanel.contextPickerSource) {
      referenceSearchSourceRef.current = state.aiPanel.contextPickerSource
      return undefined
    }
    const timer = window.setTimeout(() => {
      act.openAiContextPicker(state.aiPanel.contextPickerSource, referenceQuery)
    }, AT_CONTEXT_SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    plusMenuOpen,
    referenceDialogSource,
    referenceQuery,
    state.aiPanel.contextPickerOpen,
    state.aiPanel.contextPickerSource,
  ])
  const skillPickerOpen =
    state.accountSettingsPage === null && plusMenuOpen && (skillPanelOpen || menuEntry === 'skills')
  React.useEffect(() => {
    if (!skillPickerOpen) return
    const frame = window.requestAnimationFrame(() => {
      const first = skillPanelRef.current?.querySelector<HTMLButtonElement>(
        '[data-composer-skill-option]'
      )
      ;(first ?? skillSearchRef.current)?.focus()
      first?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [skillPickerOpen, skillRowsLoading])
  // Composer stays mounted behind the skill library. Each picker opening must
  // observe installs/removals/activation changes, not its initial inventory.
  // Closing a picker invalidates its request so a slow response cannot replace
  // the inventory fetched by a later opening.
  React.useEffect(() => {
    if (!skillPickerOpen) return
    let current = true
    setSkillRowsLoading(true)
    void getSkills(SKILL_SURFACE_CONVERSATION, language)
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
          foregroundNotice: error instanceof Error ? error.message : t('composer.skillFailed'),
        })
      })
    return () => {
      current = false
    }
  }, [skillPickerOpen, skillRevision, authenticated, language])

  // 跳到任一非对话 surface 后把引用候选栏视为已取消；下一次真实输入会由 onChange 复位。
  React.useEffect(() => {
    if (!nonConversationSurfaceOpen) return
    setModeOpen(false)
  }, [nonConversationSurfaceOpen])

  const submitOnce = async (
    message: string,
    references: ComposerReference[],
    preserveDraft = false
  ): Promise<boolean> => {
    // Fail closed at the action boundary as well as through disabled UI.  This
    // also covers Enter and the desktop driver during a live/authorization turn.
    if (
      confirmation.pending ||
      (!resourceFinalizing && running && (followUp.loading || followUp.saving || followUp.error)) ||
      thread.readOnly ||
      state.turnLaunch ||
      getSnapshot().modelSelectionPending > 0 ||
      getSnapshot().modelSelectionGeneration !== state.modelSelectionGeneration ||
      Boolean(sidNow && modelSelectionBlocked(getSnapshot().serviceInstanceId, sidNow)) ||
      interrupting ||
      creditBlocked ||
      !modelAvailable ||
      !selectedSkillsReady ||
      (thread.recoveryPending && !resourceFinalizing)
    )
      return false
    const v = message.trim()
    const submittedFollowUpMode: FollowUpMode =
      running && thread.activeTurnId ? followUp.mode : 'queue'
    const submittedExpectedTurnId = thread.activeTurnId ?? undefined
    if (!composerHasContent(v, references, pendingContextRefs)) return false
    const submittedDraftRevision = composerDraft.getRevision()
    const submittedReferenceSet = new Set(references)
    if (activeThread(state).terminated) {
      set({ foregroundError: feedback('components', 'composer.terminated') })
      return false
    }
    if (!runtimeReady) {
      // 未知态没有可展示的结论: 保留草稿并靠禁用态表达, 不要把空错误弹给用户。
      if (runtimeAdmission !== 'unknown') {
        set({
          foregroundError:
            effectiveReadiness(thread, state.runtimeReadiness)?.message ||
            feedback('components', 'composer.runtimePreflight'),
        })
      }
      return false
    }
    const activeThreadId = state.activeSession
    const sid = activeThread(state).sessionId
    const pendingQuestions = pendingQuestionItems(thread.conversation)
    if (sid && pendingQuestions.length) {
      const focus = state.aiPanel.messageFocus
      const target = directQuestionTarget(
        thread.conversation,
        focus?.sessionId === sid ? focus.requestId : null
      )
      if (
        !target ||
        interactionPolicies.some(
          (policy) => policy.directDecision && policy.matches(target.questions ?? [])
        ) ||
        references.length
      ) {
        set({ foregroundError: feedback('conversation', 'clarification.useCard') })
        return false
      }
      const question = target.questions?.[0]
      const key = question && (question.id || question.header || question.question)
      patchThread(activeThreadId, (current) => ({
        conversation: current.conversation.map((item) =>
          item.kind === 'hil' && item.requestId === target.requestId
            ? { ...item, hilState: 'submitting' }
            : item
        ),
      }))
      const response = await respondHil(
        sid,
        target.requestId,
        {
          free_text: v,
          ...(key ? { answers: { [key]: v } } : {}),
        },
        hasHostQuestions(target.questions)
      )
      patchThread(activeThreadId, (current) =>
        !response.ok &&
        current.conversation.some(
          (item) =>
            item.kind === 'hil' && item.requestId === target.requestId && isTerminalHil(item)
        )
          ? {}
          : {
              conversation: resolveHilItem(
                current.conversation,
                target.requestId,
                response.ok
                  ? {
                      ...hilEventResolution(undefined, 'resolved'),
                      hilState: 'resolved',
                      answers: response.interaction?.answers ?? {},
                      freeText: response.interaction?.free_text || v,
                    }
                  : response.outcome
                    ? {
                        hilState: response.outcome,
                        ...hilSubmissionFailure(
                          response.outcome === 'unknown' ? 'outcomeUnknown' : 'answerUnconfirmed'
                        ),
                      }
                    : {
                        hilState: 'failed',
                        ...hilSubmissionFailure('answerUnconfirmed', response.error),
                      }
              ),
            }
      )
      if (response.ok && !preserveDraft)
        composerDraft.set((current) => (current.trim() === v ? '' : current))
      return response.ok
    }
    const presentAsUserMessage =
      !resourceFinalizing &&
      shouldOptimisticallyPresentUserMessage(
        Boolean(activeThread(state).running),
        activeThread(state).queuedMessages ?? []
      )
    const clientUserMessageId = crypto.randomUUID()
    const activeDocument = activeDocumentForTurn(state)
    const selectedLiteratureIds = selectedLiteratureForTurn(state)
    const interruptedTurn = [...thread.conversation]
      .reverse()
      .find(
        (item) =>
          item.kind === 'error' &&
          item.runtimeAction === 'confirm_turn_unknown' &&
          canContinueFailedTurn(thread, item)
      )
    const contextAdmission: TurnContextAdmission =
      sid && state.aiPanel.sessionId === sid && state.aiPanel.contextState === 'ready'
        ? {
            clientUserMessageId,
            assistantContextRevision: state.aiPanel.revision,
            ...(activeDocument ? { activeDocument } : {}),
            ...(selectedLiteratureIds.length ? { selectedLiteratureIds } : {}),
            ...(state.composerTaskType ? { taskType: state.composerTaskType } : {}),
          }
        : {
            clientUserMessageId,
            ...(activeDocument ? { activeDocument } : {}),
            ...(selectedLiteratureIds.length ? { selectedLiteratureIds } : {}),
            ...(state.composerTaskType ? { taskType: state.composerTaskType } : {}),
          }
    if (interruptedTurn?.kind === 'error') contextAdmission.continueTurnId = interruptedTurn.turnId
    if (sid && (state.aiPanel.sessionId !== sid || state.aiPanel.contextState !== 'ready')) {
      set({ foregroundError: feedback('components', 'composer.contextNotReady') })
      return false
    }
    const submittedAssistantRefs = pendingContextRefs.filter((ref) => ref.retention === 'next_turn')
    const submittedAssistantRefIds = submittedAssistantRefs.map((ref) => ref.ref_id)
    const hideSubmittedAssistantRefs = (): void => {
      if (submittedAssistantRefIds.length === 0) return
      set((current) =>
        current.aiPanel.sessionId !== targetSessionId
          ? {}
          : {
              aiPanel: {
                ...current.aiPanel,
                submittedRefIds: Array.from(
                  new Set([...current.aiPanel.submittedRefIds, ...submittedAssistantRefIds])
                ),
              },
            }
      )
    }
    const optimisticRefs: MessageReference[] = [
      ...references.map((reference): MessageReference => ({
        type: reference.type,
        id: reference.id,
        title: reference.title,
        status: reference.status,
        path: reference.path,
        ...(reference.type === 'file'
          ? {
              mediaType: reference.mediaType,
              sha256: reference.sha256,
              size: reference.size,
            }
          : {}),
      })),
      ...projectAssistantContextRefs(state.aiPanel.refs, state.aiPanel.submittedRefIds),
    ]
    const optimisticUserMessage: Extract<ConvItem, { kind: 'user' }> = {
      kind: 'user',
      text: v,
      refs: optimisticRefs.length > 0 ? optimisticRefs : undefined,
      itemId: clientUserMessageId,
    }
    let draftCleared = false
    let consumedReferences: ComposerReference[] = []
    const restoreDraft = (): void => {
      if (preserveDraft) return
      if (draftCleared) {
        draftCleared = false
        composerDraft.set((current) => restoreComposerDraft(v, current))
      }
      const referencesToRestore = consumedReferences
      consumedReferences = []
      if (referencesToRestore.length)
        set((current) => ({
          composerRefs: [
            ...referencesToRestore.filter(
              (reference) => !current.composerRefs.some((pending) => pending.id === reference.id)
            ),
            ...current.composerRefs,
          ],
        }))
    }
    const rollbackImmediatePresentation = (): void => {
      if (activeThreadId) {
        patchThread(activeThreadId, (current) => ({
          conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
        }))
      }
      set({ turnLaunch: null })
      restoreDraft()
    }
    let preparationInstanceId: string | undefined
    // Existing-session enqueue skips runtime preparation but still awaits reference work.
    const preparationController = new AbortController()
    preparationWait.current = preparationController
    const submissionCurrent = (sessionId: string | null = activeThreadId): boolean => {
      const current = getSnapshot()
      const valid =
        composerMounted.current &&
        !preparationController.signal.aborted &&
        current.draftGeneration === state.draftGeneration &&
        current.modelSelectionGeneration === state.modelSelectionGeneration &&
        current.modelSelectionPending === 0 &&
        !(
          sessionId &&
          current.threads[sessionId]?.sessionId &&
          modelSelectionBlocked(current.serviceInstanceId, current.threads[sessionId].sessionId!)
        ) &&
        (!exactDraftModelId ||
          current.catalog.models.some(
            (model) => model.key === exactDraftModelId && !model.disabled
          )) &&
        composerReasoningEffort(current) === selectedEffort &&
        effectiveSessionModelKey(
          current.catalog.models,
          current.model,
          current.activeSession,
          current.threads,
          current.draftModelId
        ) === selectedModelKey &&
        (!sid ||
          (current.aiPanel.sessionId === sid &&
            current.aiPanel.revision === state.aiPanel.revision)) &&
        selectedProjectPath(current) === preparationProject &&
        current.serviceInstanceId === preparationInstanceId &&
        (current.activeSession === sessionId || current.activeSession === activeThreadId)
      if (!valid)
        set((latest) =>
          latest.turnLaunch?.optimisticUserMessage.itemId === clientUserMessageId
            ? { turnLaunch: null }
            : {}
        )
      return valid
    }
    if (resourceFinalizing) {
      preparationInstanceId = state.serviceInstanceId ?? undefined
    } else {
      if (presentAsUserMessage && activeThreadId) {
        patchThread(activeThreadId, (current) => ({
          conversation: appendOptimisticUserMessage(current.conversation, optimisticUserMessage),
        }))
      }
      set((current) => ({
        turnLaunch: { phase: 'preparing', optimisticUserMessage },
        ...(isRuntimePreparationBusyFeedback(current.foregroundError)
          ? { foregroundError: null }
          : {}),
      }))
      try {
        const prepared = await waitForPreparation(
          prepareModel(selectedModelKey),
          preparationController.signal
        )
        const current = getSnapshot()
        if (
          preparationController.signal.aborted ||
          current.activeSession !== activeThreadId ||
          current.draftGeneration !== state.draftGeneration ||
          current.modelSelectionGeneration !== state.modelSelectionGeneration ||
          current.modelSelectionPending > 0 ||
          composerReasoningEffort(current) !== selectedEffort ||
          effectiveSessionModelKey(
            current.catalog.models,
            current.model,
            current.activeSession,
            current.threads,
            current.draftModelId
          ) !== selectedModelKey ||
          (sid &&
            (current.aiPanel.sessionId !== sid ||
              current.aiPanel.revision !== state.aiPanel.revision)) ||
          selectedProjectPath(current) !== preparationProject ||
          current.serviceInstanceId !== prepared.service_instance_id ||
          current.turnLaunch?.optimisticUserMessage.itemId !== clientUserMessageId
        )
          return false
        if (prepared.state !== 'applied') {
          const failure = runtimePreparationForegroundFailure(prepared)
          if (failure) set({ foregroundError: failure })
          return false
        }
        preparationInstanceId = prepared.service_instance_id
        if (sid && activeThreadId && current.threads[activeThreadId]?.resumeState === 'failed')
          requestSessionResume(sid)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== PREPARATION_SUPERSEDED_ERROR) {
          set({ foregroundError: runtimePreparationRequestFailure(error) })
        }
        return false
      } finally {
        if (!preparationInstanceId && preparationWait.current === preparationController)
          preparationWait.current = null
        if (!preparationInstanceId && presentAsUserMessage && activeThreadId) {
          patchThread(activeThreadId, (current) => ({
            conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
          }))
        }
        set((current) =>
          current.turnLaunch?.optimisticUserMessage.itemId === clientUserMessageId &&
          current.turnLaunch.phase === 'preparing'
            ? { turnLaunch: null }
            : {}
        )
      }
    }
    if (presentAsUserMessage) {
      set({
        ...(sid ? { composerTaskType: '' } : {}),
        turnLaunch: { phase: 'admitting', optimisticUserMessage },
      })
    }
    let targetSessionId = sid
    let targetThreadId = activeThreadId
    let targetAdmission = contextAdmission
    if (!targetSessionId) {
      set({
        turnLaunch: { phase: 'opening', optimisticUserMessage },
      })
      const projectPath = selectedProjectPath(state)
      const targetWorkdir = projectPath ?? state.defaultWorkspacePath ?? state.workspacePath ?? ''
      const openingPermissionMode = pendingMode ?? state.globalPermissionMode
      const opened = await openSession({
        projectPath,
        modelId: exactDraftModelId || state.model || undefined,
        reasoningEffort: selectedEffort,
        permissionMode: openingPermissionMode,
        prepareRuntime: true,
        serviceInstanceId: preparationInstanceId,
        signal: preparationController.signal,
      })
      if (!submissionCurrent()) return false
      if (!opened?.session_id || opened.runtime_id !== 'codex' || !opened.readiness.ready) {
        const failure =
          opened && 'error' in opened
            ? (runtimePreparationBusyFeedback(opened.code) ??
              (opened.applicationFailure
                ? requestFailureFeedback(opened.applicationFailure)
                : opened.error || opened.detail))
            : opened && 'readiness' in opened
              ? opened.readiness.message
              : feedback('components', 'composer.createFailed')
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: failure || feedback('components', 'composer.createFailed'),
        })
        return false
      }
      if (exactDraftModelId && opened.runtime.model_id !== exactDraftModelId) {
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: feedback('conversation', 'continuation.modelUnavailable'),
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
            foregroundError: feedback('components', 'composer.workspaceFailed'),
          })
          return false
        }
      }
      const assistantContextRevision =
        surface === 'assistant' ? await act.prepareAiContext(opened.session_id) : null
      if (!submissionCurrent()) return false
      if (surface === 'assistant' && assistantContextRevision === null) {
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: feedback('components', 'composer.contextNotSaved'),
        })
        return false
      }
      const sessionTitle = draftSessionTitle(opened)
      if (preparationWait.current === preparationController) preparationWait.current = null
      openedModeProjection.current = {
        sessionId: opened.session_id,
        mode: openingPermissionMode,
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
          capabilities: opened.capabilities,
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
    const acceptDraftModel = (): void => {
      if (!exactDraftModelId) return
      set((current) =>
        current.draftModelId === exactDraftModelId &&
        current.draftGeneration === state.draftGeneration &&
        current.activeSession === targetThreadId
          ? { draftModelId: null }
          : {}
      )
    }
    const submittedReferences = await Promise.all(
      references.map(async (reference): Promise<ComposerReference | null> => {
        if (reference.type === 'skill' || !reference.localSource) return reference
        const { refs, failed } = await resolveAttachmentSources(targetSessionId, [
          { path: reference.path, file: reference.localSource.file },
        ])
        return failed ? null : (refs[0] ?? null)
      })
    )
    if (submittedReferences.some((reference) => reference === null)) {
      if (presentAsUserMessage) rollbackImmediatePresentation()
      else restoreDraft()
      set({ foregroundError: feedback('components', 'composer.filesFailed') })
      return false
    }
    let resolvedReferences = submittedReferences.filter((reference) => reference !== null)
    const registrations = references.filter(
      (reference) =>
        (reference.type === 'file' || reference.type === 'directory') &&
        reference.registrationRequired
    )
    if (registrations.length > 0) {
      const registered = await registerLocalPaths(
        targetSessionId,
        registrations.map((reference) => reference.path)
      )
      const byPath = new Map((registered ?? []).map((reference) => [reference.path, reference]))
      if (
        registrations.some((reference) => {
          const matched = byPath.get(reference.path)
          return !matched || (matched.kind ?? 'file') !== reference.type
        })
      ) {
        if (presentAsUserMessage) rollbackImmediatePresentation()
        else restoreDraft()
        set({ foregroundError: feedback('components', 'composer.filesFailed') })
        return false
      }
      resolvedReferences = resolvedReferences.map((reference) => {
        if (
          (reference.type !== 'file' && reference.type !== 'directory') ||
          !reference.registrationRequired
        )
          return reference
        const registeredReference = byPath.get(reference.path)
        if (!registeredReference) return reference
        return {
          ...reference,
          id: registeredReference.reference_id,
          referenceId: registeredReference.reference_id,
          registrationRequired: false,
          path: registeredReference.path,
          title: reference.title || registeredReference.name,
          ...(reference.type === 'file'
            ? {
                mediaType: registeredReference.media_type || reference.mediaType,
                size: registeredReference.size,
              }
            : {}),
        }
      })
    }
    let input: TurnInputItem[]
    try {
      input = buildTurnInput(v, resolvedReferences)
    } catch (error) {
      if (presentAsUserMessage) rollbackImmediatePresentation()
      else restoreDraft()
      set({
        foregroundError: error instanceof Error ? error.message : String(error),
      })
      return false
    }
    const optimisticAssistantReferences = await Promise.all(
      submittedAssistantRefs.map(async (ref) => {
        const annotation =
          ref.kind === 'note'
            ? state.aiPanel.annotations.find((item) => item.annotation_id === ref.source_id)
            : undefined
        const target = annotation
          ? await locateAnswerAnnotation(annotation, activeThread(state).conversation)
          : null
        const selectedText =
          annotation && target?.status === ANSWER_ANNOTATION_LOCATION.AVAILABLE
            ? target.item?.text.slice(annotation.start_utf16, annotation.end_utf16)
            : undefined
        return {
          label: ref.label,
          ...(ref.anchor ? { anchor: { ...ref.anchor } } : {}),
          ...(ref.selection_source_label !== undefined
            ? { selection_source_label: ref.selection_source_label }
            : {}),
          ...(ref.label_fallback !== undefined ? { label_fallback: ref.label_fallback } : {}),
          kind: ref.kind,
          ref_id: ref.ref_id,
          surface:
            ref.anchor || annotation
              ? {
                  answer_id: annotation?.answer_id,
                  selected_text: selectedText,
                  preview_text: ref.anchor?.preview_text,
                  comment: annotation?.comment,
                }
              : undefined,
        }
      })
    )
    if (!submissionCurrent(targetThreadId)) {
      patchThread(targetThreadId, (current) => ({
        conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
      }))
      return false
    }
    // Admission never predicts native execution, even for the first message.
    const optimistic = optimisticQueuedMessage(
      sid ? (activeThread(state).queuedMessages ?? []) : [],
      clientUserMessageId,
      input,
      optimisticAssistantReferences,
      targetAdmission.assistantContextRevision,
      presentAsUserMessage ? 'direct' : 'queued',
      targetAdmission.activeDocument,
      targetAdmission.selectedLiteratureIds
    )
    retainQueuedOutbox(targetSessionId, optimistic)
    patchThread(targetThreadId, (current) => ({
      queuedMessages: upsertQueuedMessage(current.queuedMessages ?? [], optimistic),
      ...(presentAsUserMessage
        ? {
            conversation: appendOptimisticUserMessage(current.conversation, optimisticUserMessage),
          }
        : {}),
    }))
    if (sid && presentAsUserMessage) set({ turnLaunch: null })
    if (!preserveDraft) {
      if (
        composerDraft.getRevision() === submittedDraftRevision &&
        composerDraft.getSnapshot() === message
      ) {
        composerDraft.set('')
        draftCleared = v.length > 0
      }
      consumedReferences = getSnapshot().composerRefs.filter((reference) =>
        submittedReferenceSet.has(reference)
      )
      setPendingRefs((current) =>
        current.filter((reference) => !submittedReferenceSet.has(reference))
      )
    }
    set({ composerTaskType: '' })
    // Once dispatched, keep the enqueue result even if the composer is no longer active.
    const delivered = await postTurn(targetSessionId, input, state.collaborationMode, {
      ...targetAdmission,
      expectedModelId: selectedModelKey,
      serviceInstanceId: preparationInstanceId,
      followUpMode: submittedFollowUpMode,
      expectedTurnId: submittedExpectedTurnId,
    })
    if (!isComposerSubmissionAccepted(delivered)) {
      if (
        delivered &&
        (delivered.code === MODEL_SELECTION_UNCONFIRMED ||
          isComposerSubmissionRejectedBeforeEnqueue(delivered))
      ) {
        releaseQueuedOutbox(targetSessionId, clientUserMessageId)
        patchThread(targetThreadId, (current) => ({
          queuedMessages: (current.queuedMessages ?? []).filter(
            (item) => item.queuedMessageId !== clientUserMessageId
          ),
          conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
        }))
        restoreDraft()
        set({
          turnLaunch: null,
          foregroundError: delivered.preparation_error
            ? runtimePreparationFailure({
                state: delivered.preparation_state ?? 'rejected',
                error: typeof delivered.error === 'string' ? delivered.error : '',
              })
            : delivered.code === MODEL_SELECTION_UNCONFIRMED
              ? feedback('components', 'composer.notSubmitted')
              : turnAdmissionFeedback(delivered),
        })
        return false
      }
      const authoritative = await listQueuedMessages(targetSessionId)
      if (authoritative === null) {
        patchThread(targetThreadId, (current) => ({
          queuedMessages: markOptimisticQueueOutcomeUnknown(
            current.queuedMessages ?? [],
            clientUserMessageId
          ),
        }))
        set({ foregroundError: feedback('components', 'composer.queueUnknown') })
        return false
      }
      const accepted = authoritative.some((item) => item.queued_message_id === clientUserMessageId)
      // An absent queue row can already have become a real turn.
      const reconciliation = accepted
        ? null
        : await reconcileQueuedMessage(targetSessionId, clientUserMessageId)
      const applied = reconciliation?.ok && reconciliation.outcome === 'applied'
      const rejected = reconciliation?.ok && reconciliation.outcome === 'not_applied'
      if (!accepted && !applied && !rejected) {
        patchThread(targetThreadId, {
          queuedMessages: mergeQueuedOutbox(
            targetSessionId,
            authoritative.map(queuedMessageFromPayload)
          ),
        })
        set({ foregroundError: feedback('components', 'composer.queueCheckUnknown') })
        return false
      }
      releaseQueuedOutbox(targetSessionId, clientUserMessageId)
      patchThread(targetThreadId, {
        queuedMessages: mergeQueuedOutbox(
          targetSessionId,
          authoritative.map(queuedMessageFromPayload)
        ),
      })
      if (accepted || applied) {
        acceptDraftModel()
        hideSubmittedAssistantRefs()
        return true
      }
      restoreDraft()
      patchThread(targetThreadId, (current) => ({
        conversation: removeOptimisticUserMessage(current.conversation, clientUserMessageId),
      }))
      if ((delivered?.code ?? delivered?.error) === ASSISTANT_CONTEXT_REVISION_CONFLICT) {
        await act.loadAiContext(targetSessionId)
      }
      set({
        foregroundError: delivered
          ? turnAdmissionFeedback(delivered)
          : feedback('components', 'composer.queueFailed'),
      })
      return false
    }
    patchThread(targetThreadId, (current) => ({
      queuedMessages: settleOptimisticQueuedMessage(
        current.queuedMessages ?? [],
        clientUserMessageId,
        delivered?.disposition
      ),
      ...(delivered?.turn_id
        ? {
            conversation: bindSubmittedTurn(
              current.conversation,
              delivered.turn_id,
              clientUserMessageId
            ),
          }
        : {}),
    }))
    releaseQueuedOutbox(targetSessionId, clientUserMessageId)
    acceptDraftModel()
    hideSubmittedAssistantRefs()
    return true
  }

  const submit = (
    message = text,
    references = pendingRefs,
    preserveDraft = false
  ): Promise<boolean> => {
    if (submissionInFlight.current) return Promise.resolve(false)
    if (editing) {
      if (!text.trim()) return Promise.resolve(false)
      const target = editing
      submissionInFlight.current = true
      setSubmittingMessage(true)
      setQueueEditError(false)
      return updateQueuedMessage(target.sessionId, target.message.queuedMessageId, text)
        .then((updated) => {
          if (!updated) {
            setQueueEditError(true)
            return false
          }
          patchThread(target.sessionId, (current) => ({
            queuedMessages: (current.queuedMessages ?? []).map((item) =>
              item.queuedMessageId === updated.queued_message_id
                ? queuedMessageFromPayload(updated)
                : item
            ),
          }))
          setQueueEdit((current) => (current === target ? null : current))
          return true
        })
        .finally(() => {
          submissionInFlight.current = false
          setSubmittingMessage(false)
        })
    }
    submissionInFlight.current = true
    setSubmittingMessage(true)
    return submitOnce(message, references, preserveDraft).finally(() => {
      preparationWait.current = null
      submissionInFlight.current = false
      setSubmittingMessage(false)
    })
  }

  const draftSubmissionConsumed = React.useRef(false)
  React.useEffect(() => {
    if (editing) return
    if (!state.composerSubmitRequested) {
      draftSubmissionConsumed.current = false
      return
    }
    if (
      !canConsumeDraftSubmission({
        surface,
        view: state.mainView,
        ready: canSend && !submittingMessage,
        consumed: draftSubmissionConsumed.current,
        obscured: nonConversationSurfaceOpen,
      })
    )
      return
    draftSubmissionConsumed.current = true
    set({ composerSubmitRequested: false })
    void submit()
  })

  const composerKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      !editing &&
      !thread.readOnly &&
      !event.nativeEvent.isComposing &&
      event.key === 'Backspace' &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0
    ) {
      if (pendingRefs.length > 0) {
        event.preventDefault()
        setPendingRefs((items) => items.slice(0, -1))
        return
      }
      const reference = pendingContextRefs.at(-1)
      if (reference) {
        event.preventDefault()
        void act.detachAiContext(reference.ref_id)
        return
      }
    }
    if (
      !editing &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !contextReady &&
      pendingQuestionItems(thread.conversation).length === 0
    ) {
      event.preventDefault()
      return
    }
    if (editing) {
      if (event.key === 'Escape' && !submittingMessage) {
        event.preventDefault()
        setQueueEdit(null)
        setQueueEditError(false)
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void submit()
      }
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }
  const composerKeyDownRef = React.useRef(composerKeyDown)
  React.useLayoutEffect(() => {
    composerKeyDownRef.current = composerKeyDown
  })
  const handleComposerKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      composerKeyDownRef.current(event)
    },
    []
  )
  const handleComposerChange = React.useCallback(() => {
    syncComposerSelection()
    if (editing || !composerDraft.getSnapshot().trim()) return
    const sid = thread.sessionId
    const target = directQuestionTarget(
      thread.conversation,
      state.aiPanel.messageFocus?.sessionId === sid ? state.aiPanel.messageFocus.requestId : null
    )
    if (
      !sid ||
      !target?.cancelTimeoutOnEdit ||
      target.timeoutCancelled ||
      editingHilRequest.current === target.requestId
    )
      return
    const threadId = state.activeSession
    editingHilRequest.current = target.requestId
    void respondHil(sid, target.requestId, { editing: true }, hasHostQuestions(target.questions))
      .then((response) => {
        if (response.ok && response.interaction?.timeout_cancelled) {
          patchThread(threadId, (current) => ({
            conversation: current.conversation.map((item) =>
              item.kind === 'hil' && item.requestId === target.requestId
                ? { ...item, timeoutCancelled: true }
                : item
            ),
          }))
        } else {
          set({ foregroundError: feedback('conversation', 'clarification.editingFailed') })
        }
      })
      .finally(() => {
        editingHilRequest.current = null
      })
  }, [
    syncComposerSelection,
    editing,
    composerDraft,
    thread,
    state.aiPanel.messageFocus,
    state.activeSession,
    patchThread,
    set,
  ])

  React.useEffect(() => {
    window.__scholarseedSubmitMessage = (message: string) => submit(message, [])
    return () => {
      delete window.__scholarseedSubmitMessage
    }
  })

  const stop = (): void => {
    if (thread.readOnly || interrupting) return
    const threadId = state.activeSession
    const sid = activeThread(state).sessionId
    if (!sid) return
    patchThread(threadId, { interrupting: true })
    const request = interruptSession(sid)
    void request.then((result) => {
      if (result.ok && result.idle) {
        patchThread(threadId, {
          interrupting: false,
          running: false,
          status: 'done',
        })
        set({ petOverride: 'done' })
        return
      }
      if (!result.ok) {
        patchThread(threadId, { interrupting: false })
        const displayMessage = stopFailureFeedback(
          result.error,
          result.applicationFailure && requestFailureFeedback(result.applicationFailure)
        )
        appendThread(threadId, {
          kind: 'notice',
          displayMessage,
          text: renderFeedback(i18n, displayMessage),
        })
      }
    })
  }

  const refreshQueuedMessages = async (sessionId: string): Promise<boolean> => {
    const authoritative = await listQueuedMessages(sessionId)
    if (authoritative === null) return false
    patchThread(sessionId, {
      queuedMessages: mergeQueuedOutbox(sessionId, authoritative.map(queuedMessageFromPayload)),
    })
    return true
  }

  const steerQueued = async (message: QueuedMessage): Promise<void> => {
    const targetTurnId = thread.activeTurnId
    if (
      !sidNow ||
      !targetTurnId ||
      queuedActionId ||
      modelSelectionBlocked(getSnapshot().serviceInstanceId, sidNow)
    )
      return
    const sessionId = sidNow
    setQueuedActionId(message.queuedMessageId)
    try {
      const result = await postSide(
        sessionId,
        message.queuedMessageId,
        targetTurnId,
        getSnapshot().serviceInstanceId
      )
      await refreshQueuedMessages(sessionId)
      if (!result?.ok) {
        set({
          foregroundError: feedback(
            'components',
            result?.unknownOutcome ? 'composer.queueUnknown' : 'composer.steerFailed'
          ),
        })
      }
    } finally {
      setQueuedActionId(null)
    }
  }

  const editQueued = (message: QueuedMessage): void => {
    if (!sidNow || editing || !canEditQueuedMessage(message)) return
    setQueueEditError(false)
    setQueueEdit({ sessionId: sidNow, message, draft: createComposerDraftStore(message.text) })
    pendingCaretRef.current = message.text.length
    setPlusMenuOpen(false)
  }

  const resolveNotSendable = async (sessionId: string, queuedMessageId: string): Promise<void> => {
    const authoritative = await listQueuedMessages(sessionId)
    if (authoritative === null) {
      set({ foregroundError: feedback('components', 'composer.checkFailed') })
      return
    }
    const syncQueue = (): void => {
      patchThread(sessionId, {
        queuedMessages: mergeQueuedOutbox(sessionId, authoritative.map(queuedMessageFromPayload)),
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
          serverPresent: false,
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

  const retractQueuedMessage = async (queuedMessageId: string): Promise<void> => {
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
        ),
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
          ),
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
    if (
      !sessionId ||
      queuedActionId ||
      creditBlocked ||
      modelSelectionBlocked(getSnapshot().serviceInstanceId, sessionId)
    )
      return
    const queued = (activeThread(state).queuedMessages ?? []).find(
      (message) => message.queuedMessageId === queuedMessageId
    )
    if (
      !queued ||
      queued.state !== 'failed' ||
      queuedMessageNeedsStatusCheck(queued) ||
      !recoveryAvailable
    )
      return
    setQueuedActionId(queuedMessageId)
    if (queued.serverPresent === false) {
      const result = await postTurn(sessionId, queued.input, state.collaborationMode, {
        clientUserMessageId: queuedMessageId,
        assistantContextRevision: queued.assistantContextRevision,
        activeDocument: queued.activeDocument,
        selectedLiteratureIds: queued.selectedLiteratureIds,
        serviceInstanceId: getSnapshot().serviceInstanceId ?? undefined,
      })
      if (!isComposerSubmissionAccepted(result)) {
        set({ foregroundError: feedback('components', 'composer.resendFailed') })
        setQueuedActionId(null)
        return
      }
      releaseQueuedOutbox(sessionId, queuedMessageId)
    } else {
      const result = await sendQueuedMessage(
        sessionId,
        queuedMessageId,
        getSnapshot().serviceInstanceId
      )
      if (!result?.ok) {
        if (isQueuedMessageNotSendable(result?.error)) {
          await resolveNotSendable(sessionId, queuedMessageId)
          setQueuedActionId(null)
          return
        }
        await refreshQueuedMessages(sessionId)
        set({
          foregroundError: feedback('components', 'composer.pendingFailed', {
            error: result?.applicationFailure
              ? requestFailureFeedback(result.applicationFailure)
              : queuedMessageErrorText(result?.error ?? '', queued.state, t),
          }),
        })
        setQueuedActionId(null)
        return
      }
    }
    const refreshed = await refreshQueuedMessages(sessionId)
    if (!refreshed) {
      set({
        foregroundError: feedback('components', 'composer.queueRefreshFailed'),
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
        ),
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
          serverPresent: false,
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
                  serverPresent: false,
                }
        ),
      }))
    } else {
      const localMessage = (activeThread(state).queuedMessages ?? []).find(
        (message) => message.queuedMessageId === queuedMessageId
      )
      const reconciled = result.message
        ? queuedMessageFromPayload(result.message)
        : localMessage
          ? {
              ...localMessage,
              ...(result.reason === QUEUED_MESSAGE_SAFE_ERRORS.SESSION_OPEN_UNKNOWN
                ? { retryBlockedErrorCode: result.reason }
                : {
                    safeErrorCode:
                      result.reason || QUEUED_MESSAGE_SAFE_ERRORS.TURN_OUTCOME_UNCONFIRMED,
                  }),
            }
          : null
      if (reconciled?.serverPresent === false) retainQueuedOutbox(sessionId, reconciled)
      patchThread(sessionId, (thread) => ({
        queuedMessages: (thread.queuedMessages ?? []).map((message) =>
          message.queuedMessageId === queuedMessageId && reconciled ? reconciled : message
        ),
      }))
    }
    await refreshQueuedMessages(sessionId)
    await act.loadAiContext(sessionId)
    setQueuedActionId(null)
  }

  const confirmQueuedUnknown = async (queued: QueuedMessage): Promise<void> => {
    const sessionId = sidNow ?? ''
    if (!sessionId || queuedActionId || queuedMessageHasUnknownOpen(queued)) return
    setQueuedActionId(queued.queuedMessageId)
    try {
      const error = await confirmQueuedOutcome({
        confirm: () => confirmUnknownTurn(sessionId, queued.nativeTurnId || queued.queuedMessageId),
        refreshQueue: () => refreshQueuedMessages(sessionId),
        refreshContext: () => act.loadAiContext(sessionId),
      })
      if (error) set({ foregroundError: error })
    } finally {
      setQueuedActionId(null)
    }
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

  const continueDisabled =
    confirmation.pending ||
    Boolean(editing) ||
    thread.readOnly ||
    canStop ||
    launching ||
    submittingMessage ||
    !runtimeReady ||
    !modelAvailable ||
    creditBlocked ||
    Boolean(thread.terminated) ||
    Boolean(thread.recoveryPending) ||
    selectionBlocked ||
    queuedMessages.length > 0

  // Suggested follow-ups are ordinary new messages, only after the current turn ends.
  const nextTurnDisabled =
    continueDisabled ||
    !selectedSkillsReady ||
    !contextReady ||
    Boolean(thread.running || thread.status === 'running' || thread.status === 'waiting')
  const nextTurn = React.useRef({ sessionId: thread.sessionId, disabled: nextTurnDisabled, submit })
  nextTurn.current = { sessionId: thread.sessionId, disabled: nextTurnDisabled, submit }
  React.useLayoutEffect(
    () =>
      composerSubmission.register({
        sessionId: thread.sessionId,
        disabled: nextTurnDisabled,
        submit: (message) => {
          const current = nextTurn.current
          if (current.disabled || current.sessionId !== thread.sessionId)
            return Promise.resolve(false)
          return current.submit(message, [], true)
        },
      }),
    [composerSubmission, thread.sessionId, nextTurnDisabled]
  )

  const selectFirstMenuItem = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return
    const first = event.currentTarget.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)'
    )
    if (!first) return
    event.preventDefault()
    event.stopPropagation()
    first.click()
  }
  const skillMenuContent = (
    <div
      ref={skillPanelRef}
      className={skillPanelClass}
      onKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          Boolean(event.target.closest('[data-composer-skill-option]')) &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          ((event.key.length === 1 && event.key !== ' ') || event.key === 'Backspace')
        ) {
          event.preventDefault()
          event.stopPropagation()
          setSkillQuery((current) =>
            event.key === 'Backspace' ? current.slice(0, -1) : current + event.key
          )
          setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
          skillSearchRef.current?.focus()
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        if (
          (event.key === 'Home' || event.key === 'End') &&
          event.target instanceof HTMLInputElement
        )
          return
        const rows = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[data-composer-skill-option]'
          ),
        ]
        if (!rows.length) return
        event.preventDefault()
        event.stopPropagation()
        const current = rows.indexOf(document.activeElement as HTMLButtonElement)
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? rows.length - 1
              : event.key === 'ArrowDown'
                ? (current + 1) % rows.length
                : (current - 1 + rows.length) % rows.length
        rows[index].focus()
        rows[index].scrollIntoView({ block: 'nearest' })
      }}
    >
      <div className={skillPanelHeadClass}>
        <div className="relative">
          <SearchBox
            ref={skillSearchRef}
            value={skillQuery}
            onChange={(event) => {
              setSkillQuery(event.target.value)
              setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
            }}
            placeholder={t('composer.searchSkills')}
            aria-label={t('composer.searchSkillsLabel')}
            size="sm"
          />
          {skillQuery && (
            <IconButton
              className="absolute right-[var(--vds-space-1)] top-1/2 -translate-y-1/2"
              icon={<X size={13} />}
              label={t('composer.clearSearch')}
              onClick={() => {
                setSkillQuery('')
                setSkillVisibleCount(PLUS_MENU_PAGE_SIZE)
              }}
              size="xs"
              variant="ghost"
            />
          )}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain" data-testid="composer-skill-list">
        {skillRowsLoading || skillRows === null ? (
          <p className="m-[var(--vds-space-0)] px-[var(--vds-space-3)] py-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)]">
            {t('composer.loadSkills')}
          </p>
        ) : (
          (() => {
            const q = skillQuery.trim().toLowerCase()
            const language = i18n.resolvedLanguage || i18n.language
            const rows = skillRows
              .filter(
                (s): s is SkillInfo & { path: string } =>
                  s.enabled !== false &&
                  s.active !== false &&
                  (!s.dependency_status || s.dependency_status === 'ready') &&
                  isAbsoluteInputPath(s.path)
              )
              .filter(
                (s) =>
                  !q ||
                  s.name.toLowerCase().includes(q) ||
                  skillName(s, language).toLowerCase().includes(q) ||
                  skillDescription(s, language).toLowerCase().includes(q)
              )
            if (!rows.length) {
              return (
                <EmptyState
                  variant="compact"
                  icon={<Icon name="search" />}
                  title={t('composer.emptySkills')}
                />
              )
            }
            const visibleRows = rows.slice(0, skillVisibleCount)
            return [
              ...visibleRows.map((s) => {
                const description = skillDescription(s, language)
                return (
                  <Tooltip
                    key={s.name}
                    className="!w-full"
                    content={description}
                    disabled={!description}
                    portalled
                    side="right"
                  >
                    <span className="block w-full">
                      <Button
                        type="button"
                        data-testid={`composer-skill-${s.name}`}
                        data-composer-skill-option
                        role="menuitem"
                        variant="ghost"
                        size="content"
                        unstyled
                        className={`block ${skillMenuRowClass}`}
                        onClick={() => {
                          setPendingRefs((prev) =>
                            prev.some((r) => r.type === 'skill' && r.id === s.name)
                              ? prev
                              : [
                                  ...prev,
                                  {
                                    type: 'skill',
                                    id: s.name,
                                    title: skillName(s, language),
                                    path: s.path,
                                    version: s.version,
                                  },
                                ]
                          )
                          clearAtTrigger()
                          setSkillPanelOpen(false)
                          setPlusMenuOpen(false)
                          setSkillQuery('')
                          restoreComposerFocus()
                        }}
                      >
                        <span className="flex min-w-0 items-center justify-between gap-[var(--vds-space-2)]">
                          <span className="min-w-0 truncate text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]">
                            {skillName(s, language)}
                          </span>
                          {s.category ? (
                            <span className="flex-none whitespace-nowrap rounded-[var(--vds-radius-2)] bg-[var(--bg-3)] px-[var(--vds-space-2)] py-[var(--vds-space-half)] text-[length:var(--vds-font-caption)] text-[var(--text-3)]">
                              {skillCategory(s, skillText)}
                            </span>
                          ) : null}
                        </span>
                      </Button>
                    </span>
                  </Tooltip>
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
                  className="flex w-full items-center justify-center border-0 px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--text-3)] hover:bg-[var(--vds-bg-white-hover-transparent)] hover:text-[var(--text)]"
                  onClick={() => setSkillVisibleCount((count) => count + PLUS_MENU_PAGE_SIZE)}
                >
                  {t('composer.viewMore')} ({rows.length - visibleRows.length})
                </Button>
              ) : null,
            ]
          })()
        )}
      </div>
      <div className="shrink-0 border-t border-[var(--border-soft)] bg-[var(--bg-2)] p-[calc(var(--vds-space-1)+var(--vds-border-width-1))] [&_button]:!font-[var(--vds-fw-regular)]">
        <Button
          data-testid="composer-skill-upload"
          variant="ghost"
          size="content"
          unstyled
          className={`flex items-center justify-start gap-[var(--vds-space-2)] ${skillMenuRowClass}`}
          icon={<Upload aria-hidden className="size-[var(--vds-icon-7)]" />}
          onClick={() => {
            clearAtTrigger()
            setSkillPanelOpen(false)
            setPlusMenuOpen(false)
            set({ skillUploadOpen: true })
          }}
        >
          {t('composer.uploadSkill')}
        </Button>
        <Button
          data-testid="composer-skill-market"
          variant="ghost"
          size="content"
          unstyled
          className={`flex items-center justify-start gap-[var(--vds-space-2)] ${skillMenuRowClass}`}
          icon={<Hammer aria-hidden className="size-[var(--vds-icon-7)]" />}
          onClick={openSkillCenter}
        >
          {t('composer.skillMarket')}
        </Button>
      </div>
    </div>
  )
  return (
    <>
      {header?.({
        continueTurn: () =>
          continueDisabled || hasCurrentTurnCapabilityFailure(thread)
            ? Promise.resolve(false)
            : submit(t('stream.continueTaskPrompt'), [], true),
        continueDisabled: continueDisabled || hasCurrentTurnCapabilityFailure(thread),
      })}
      {notice}
      <div
        className={cx(
          'relative z-20 isolate flex-none border-t-0 bg-transparent',
          inline ? 'p-0' : composerRootPaddingClass(home, surface),
          confirmation.pending && '!pt-[var(--vds-space-2)]'
        )}
      >
        <LoginPrompt open={loginPromptOpen} onOpenChange={setLoginPromptOpen} />
        <div
          ref={inputBoxRef}
          data-ob={state.homeSelectedProjectId ? PROJECT_GUIDE_ANCHORS.composer : undefined}
          className={cx(readingColumnClass(home, inline), 'pointer-events-auto')}
        >
          {/* Live Status Strip (proposal 65 v10): 真实 live 态 (运行 / 记忆命中 / 约束 / 成本) */}
          <StatusStrip />
          {state.runtimePreparationTarget !== selectedModelKey &&
          state.runtimePreparation?.model_id === selectedModelKey &&
          ['rejected', 'restart_required', 'unsupported'].includes(
            state.runtimePreparation.state
          ) ? (
            <Alert
              className="mb-[var(--vds-space-3)]"
              data-testid="runtime-preparation"
              tone="error"
              description={renderFeedback(
                i18n,
                runtimePreparationFailure(state.runtimePreparation)
              )}
            />
          ) : null}
          {state.activeSession ? (
            <Reconfigure
              key={state.activeSession}
              sessionId={state.activeSession}
              modelId={selectedModelKey}
              revision={`${thread.resumeMessage?.key ?? ''}:${queuedMessages
                .filter(
                  (queued) =>
                    queued.state === 'failed' &&
                    queued.safeErrorCode === HOST_CONFIGURATION_CONFLICT
                )
                .map((queued) => queued.queuedMessageId)
                .join(',')}`}
            />
          ) : null}

          {creditBlocked && (
            <div
              className="mb-[var(--vds-space-3)]"
              data-testid="composer-credits-exhausted"
              id={CREDITS_EXHAUSTED_NOTICE_ID}
              role="alert"
            >
              <ConfirmationCard
                icon={<Database strokeWidth={1.5} className="size-[var(--vds-icon-8)]" />}
                title={t('composer.creditsExhaustedTitle')}
                description={t('composer.creditsExhaustedDescription')}
                allowLabel={t('composer.creditsMore')}
                allowAttributes={{ 'data-testid': 'composer-credits-more' }}
                onAllow={() => void openCreditsPage()}
              />
            </div>
          )}

          {!modelAvailable && showModelHint && (
            <div
              role="status"
              className="mb-[var(--vds-space-3)]"
              data-testid="composer-no-model-hint"
            >
              <ConfirmationCard
                icon={
                  <LogIn className="size-[var(--vds-icon-8)] text-[var(--vds-text-secondary)]" />
                }
                title={t(
                  authenticated ? 'composer.noModelAuthenticatedTitle' : 'composer.noModelTitle'
                )}
                description={t(
                  authenticated
                    ? 'composer.noModelAuthenticatedSendTitle'
                    : 'composer.noModelDescription'
                )}
                allowLabel={t(
                  authenticated ? 'composer.noModelConfigure' : 'composer.noModelLogin'
                )}
                allowAttributes={{
                  'data-testid': authenticated
                    ? 'composer-no-model-configure'
                    : 'composer-no-model-login',
                }}
                onAllow={() =>
                  authenticated ? act.openSettings('models') : setLoginPromptOpen(true)
                }
                denyLabel={authenticated ? undefined : t('composer.noModelConfigure')}
                denyAttributes={{ 'data-testid': 'composer-no-model-configure' }}
                onDeny={authenticated ? undefined : () => act.openSettings('models')}
              />
            </div>
          )}

          {!selectedSkillsReady && !selectedSkillsChecking && (
            <div
              role="status"
              className={NO_MODEL_HINT_CLASS}
              data-testid="composer-skill-unavailable"
            >
              <span>{t('composer.selectedSkillUnavailable')}</span>
              {!authenticated && (
                <Button variant="ghost" size="sm" onClick={() => setLoginPromptOpen(true)}>
                  {t('composer.noModelLogin')}
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={openSkillCenter}>
                {t('composer.manageSkills')}
              </Button>
            </div>
          )}
          <div className={inline ? 'relative' : composerInputShellClass(surface)}>
            <ComposerQueue
              followUpMode={followUp.mode}
              followUpPending={followUp.loading || followUp.saving || followUp.error}
              toggleFollowUp={async () => {
                const saved = await saveFollowUpPreference(
                  followUp.mode === 'queue' ? 'steer' : 'queue'
                )
                if (!saved) set({ foregroundError: feedback('components', 'followUp.failed', {}) })
              }}
              messages={visibleQueuedMessages}
              skillTitle={(name) => {
                const skill = skillRows?.find((item) => item.name === name)
                return skill ? skillName(skill, language) : undefined
              }}
              queuedActionId={queuedActionId}
              editing={Boolean(editing)}
              running={running}
              interrupting={interrupting}
              waiting={thread.status === 'waiting'}
              activeTurnId={thread.activeTurnId}
              creditBlocked={creditBlocked}
              recoveryAvailable={recoveryAvailable}
              retractQueuedMessage={retractQueuedMessage}
              confirmQueuedUnknown={confirmQueuedUnknown}
              steerQueued={confirmation.pending || selectionBlocked ? undefined : steerQueued}
              reconcileQueued={reconcileQueued}
              sendQueued={confirmation.pending ? undefined : sendQueued}
              editQueued={editQueued}
            />

            <div
              data-testid="composer-drop-zone"
              ref={composerDropZoneRef}
              onBlurCapture={(event) => {
                if (inline && !event.currentTarget.contains(event.relatedTarget as Node | null))
                  setInlineReferencesExpanded(false)
              }}
              onDragEnter={onComposerDragEnter}
              onDragOver={onComposerDragOver}
              onDragLeave={onComposerDragLeave}
              onDrop={onComposerDrop}
              className={cx(
                composerDropZoneClass(home, draggingFiles, surface),
                inline &&
                  '!min-h-[var(--vds-floating-composer-height)] !flex-row flex-wrap items-center gap-[var(--vds-space-1)] !rounded-[var(--vds-radius-6)] !px-[var(--vds-space-3)] !pt-[var(--vds-space-2)] !pb-[var(--vds-space-3)]'
              )}
            >
              {draggingFiles && (
                <div className="pointer-events-none absolute inset-[var(--vds-space-2)] z-[var(--vds-z-local-control)] grid place-items-center rounded-[var(--vds-radius-3)] border border-dashed border-[var(--vds-border-brand)] bg-[var(--vds-surface-active)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)]">
                  {COMPOSER_DROP_LABEL}
                </div>
              )}
              <div
                data-testid="composer-reference-region"
                hidden={inline && !inlineReferencesExpanded}
                className={inline ? '-order-1 w-full empty:hidden' : 'contents'}
              >
                {editing && (
                  <div className="text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
                    {queuedReferenceSummary(
                      editing.message.input.filter((item) => item.type !== 'skill'),
                      editing.message.assistantReferences,
                      assistantText
                    )}
                  </div>
                )}
                {queueEditError && editing && (
                  <Alert tone="warning" description={t('composer.queueEditFailed')} />
                )}
                {(referenceGroups.attachments.length > 0 || (!editing && contextTray)) && (
                  <div
                    className={`${referenceTrayClass} ${surface === 'assistant' ? '!mt-0' : !home && !inline ? '!mt-[var(--vds-space-3)]' : ''}`}
                  >
                    <ScrollArea
                      className="[--vds-scroll-area-horizontal-fade:var(--vds-bg-white-default)]"
                      orientation="horizontal"
                      horizontalControls={{
                        previous: assistantText('attachments.scrollPrevious'),
                        next: assistantText('attachments.scrollNext'),
                      }}
                      viewportClassName="![scrollbar-width:none] [&::-webkit-scrollbar]:!hidden"
                    >
                      <div
                        data-testid="composer-reference-tray"
                        className={`${referenceTrayScrollerClass} ${!home && !inline ? '[&_[data-testid=attachment-images]]:!py-[var(--vds-space-0)] [&_[data-slot=attachment-list]]:!py-[var(--vds-space-0)]' : ''}`}
                      >
                        {!editing && contextTray}
                        <AttachmentImages
                          refs={galleryAttachments}
                          sessionId={thread.sessionId ?? undefined}
                          onOpen={act.openFilePreview}
                          onRemove={
                            editing ? undefined : (index) => galleryReferences[index].onRemove?.()
                          }
                          renderThumbnails={(thumbnails) =>
                            referenceGroups.attachments.map((reference) => (
                              <React.Fragment key={reference.key}>
                                {reference.attachment && isImageAttachment(reference.attachment)
                                  ? thumbnails.get(reference.key)
                                  : reference.content}
                              </React.Fragment>
                            ))
                          }
                        />
                      </div>
                    </ScrollArea>
                  </div>
                )}
              </div>
              <div
                data-testid="composer-editor"
                className={
                  inline
                    ? `relative order-1 min-w-0 ${inlineEditorLayout.multiline ? 'w-full flex-none' : 'flex-1'}`
                    : 'contents'
                }
              >
                <ComposerEditor
                  typographyClassName={`font-[var(--font-serif)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] ${inline ? 'leading-[var(--vds-space-6)]' : 'leading-[var(--vds-lh-body-lv2)]'}`}
                  references={referenceGroups.inline}
                  onRemoveAllReferences={
                    editing || thread.readOnly
                      ? undefined
                      : async () => {
                          const scope = composerDraft.getScope()
                          const references = pendingRefs
                          const removed = pendingContextRefs.length
                            ? await act.detachAiContext(
                                pendingContextRefs.map((reference) => reference.ref_id)
                              )
                            : true
                          if (!removed || composerDraft.getScope() !== scope) return false
                          setPendingRefs((items) =>
                            items.filter((reference) => !references.includes(reference))
                          )
                          return true
                        }
                  }
                  prediction={prediction.text}
                  onDismissPrediction={prediction.dismiss}
                  predictionLabel={t('composer.predictionHint')}
                  inputRef={composerInputRef}
                  draft={thread.readOnly ? readOnlyDraft : activeDraft}
                  maxHeight={home && !inline ? HOME_COMPOSER_MAX_HEIGHT_PX : COMPOSER_MAX_HEIGHT_PX}
                  maxRows={inline ? INLINE_COMPOSER_MAX_ROWS : undefined}
                  compactContainerRef={inline ? composerDropZoneRef : undefined}
                  onLayoutChange={inline ? setInlineEditorLayout : undefined}
                  data-testid="composer-input"
                  onClick={inline ? () => setInlineReferencesExpanded(true) : undefined}
                  aria-label={t('composer.inputLabel')}
                  rows={1}
                  wrap="soft"
                  spellCheck={false}
                  unstyled
                  onChange={handleComposerChange}
                  onSelect={syncComposerSelection}
                  onKeyDown={handleComposerKeyDown}
                  onPaste={editing ? undefined : handleComposerPaste}
                  placeholder={
                    !modelAvailable && !authenticated
                      ? t('composer.noModelTitle')
                      : creditBlocked
                        ? t('composer.creditsPlaceholder')
                        : interrupting
                          ? INTERRUPTING_INPUT_PLACEHOLDER
                          : running && !confirmation.pending
                            ? RUNNING_INPUT_PLACEHOLDER
                            : surface === 'assistant'
                              ? t(
                                  inline
                                    ? 'composer.floatingPlaceholder'
                                    : 'composer.assistantPlaceholder'
                                )
                              : t('composer.ask')
                  }
                  disabled={thread.readOnly || (!editing && creditBlocked)}
                  aria-describedby={creditBlocked ? CREDITS_EXHAUSTED_NOTICE_ID : undefined}
                  aria-busy={launching}
                  className={cx(
                    composerTextareaClass(home, surface, launching),
                    inline && '!min-h-0 min-w-0 py-[var(--vds-space-1)]'
                  )}
                />
                {inline && inlineEditorLayout.above && (
                  <span
                    aria-hidden="true"
                    data-testid="composer-fade-top"
                    className="pointer-events-none absolute inset-x-0 top-0 h-[var(--vds-space-6)] bg-gradient-to-b from-[var(--vds-bg-white-default)] to-transparent"
                  />
                )}
                {inline && inlineEditorLayout.below && (
                  <span
                    aria-hidden="true"
                    data-testid="composer-fade-bottom"
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-[var(--vds-space-6)] bg-gradient-to-t from-[var(--vds-bg-white-default)] to-transparent"
                  />
                )}
              </div>
              <div
                data-testid="composer-toolbar"
                key={inline ? 'floating' : 'conversation'}
                className={
                  inline
                    ? inlineEditorLayout.multiline
                      ? 'order-2 flex w-full items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)]'
                      : 'order-2 contents'
                    : composerToolbarClass(home, surface)
                }
              >
                {/* PRD 2.1.2 ③: 加号在最左, 圆形描边按钮; 点击向上弹出「添加文件」「技能」。 */}
                <DropdownMenu
                  open={plusMenuOpen}
                  onOpenChange={(open) => {
                    setPlusMenuOpen(open)
                    if (!open) {
                      setMenuEntry('plus')
                      if (
                        openingReferenceSourceRef.current === RESOURCE_CONTEXT_KIND ||
                        openingReferenceSourceRef.current === 'literature'
                      )
                        return
                      openingReferenceSourceRef.current = null
                      setSkillPanelOpen(false)
                      if (!referenceDialogSource) act.closeAiContextPicker()
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      type="button"
                      variant="ghostIcon"
                      label={t('composer.addMenu')}
                      title={undefined}
                      data-testid="composer-plus"
                      disabled={Boolean(editing) || attaching || creditBlocked}
                      aria-haspopup="menu"
                      aria-expanded={plusMenuOpen}
                      icon={
                        attaching ? (
                          <span className="leading-none">…</span>
                        ) : (
                          <Plus
                            className="text-[var(--vds-icon-outline-default)]"
                            aria-hidden="true"
                          />
                        )
                      }
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    key={menuEntry}
                    coordinateNavigation
                    className="no-drag"
                    data-testid="composer-plus-menu"
                    side="top"
                    onKeyDown={selectFirstMenuItem}
                  >
                    {menuEntry === 'skills' ? (
                      skillMenuContent
                    ) : (
                      <>
                        <DropdownMenuSub
                          open={skillPanelOpen}
                          onOpenChange={(open) => {
                            if (open) openSkillSubmenu()
                            else setSkillPanelOpen(false)
                          }}
                        >
                          <DropdownMenuSubTrigger data-testid="composer-skills-menu" openOnHover>
                            <Hammer size={15} />
                            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                              {t('composer.skill')}
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent
                            coordinateNavigation
                            data-testid="composer-plus-submenu"
                            onKeyDown={selectFirstMenuItem}
                          >
                            {skillMenuContent}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem
                          data-testid="composer-add-file"
                          onFocus={closePlusSubmenus}
                          onSelect={() => {
                            clearAtTrigger()
                            act.closeAiContextPicker()
                            void pickLocalSources(
                              unifiedLocalPicker
                                ? IMPORT_PICKER_TARGET.RESOURCE
                                : IMPORT_PICKER_TARGET.FILE
                            )
                          }}
                        >
                          <Paperclip size={15} />
                          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                            {t('composer.addLocal')}
                          </span>
                        </DropdownMenuItem>
                        {!unifiedLocalPicker &&
                          typeof window.scholarseed?.pickImport === 'function' && (
                            <DropdownMenuItem
                              data-testid="composer-add-folder"
                              onFocus={closePlusSubmenus}
                              onSelect={() => {
                                void pickLocalSources(IMPORT_PICKER_TARGET.DIRECTORY)
                              }}
                            >
                              <Folder size={15} />
                              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                                {t('composer.addLocalFolder')}
                              </span>
                            </DropdownMenuItem>
                          )}
                        {/* 资料引用进入 Session 上下文队列；上面的“添加本地文件”仍是
                        本轮 typed attachment，两种语义不能合并成一套假状态。 */}
                        {availableContextSources.map((source) => {
                          if (source.id === RESOURCE_CONTEXT_KIND || source.id === 'literature')
                            return (
                              <DropdownMenuItem
                                key={source.id}
                                data-testid={`composer-add-${source.id}-context`}
                                onFocus={closePlusSubmenus}
                                onSelect={() => {
                                  setReferenceDialogSource(source.id)
                                  setPlusMenuOpen(false)
                                  openSourceSubmenu(source)
                                }}
                              >
                                {plusMenuSourceIcon(source.icon)}
                                <span>
                                  {t('composer.referenceSource', { source: source.label })}
                                </span>
                              </DropdownMenuItem>
                            )
                          const sourceOpen =
                            state.aiPanel.contextPickerOpen &&
                            state.aiPanel.contextPickerSource === source.id
                          return (
                            <DropdownMenuSub
                              key={source.id}
                              open={sourceOpen}
                              onOpenChange={(open) => {
                                if (open) openSourceSubmenu(source)
                                else if (sourceOpen) {
                                  if (openingReferenceSourceRef.current === source.id)
                                    openingReferenceSourceRef.current = null
                                  act.closeAiContextPicker()
                                }
                              }}
                            >
                              <DropdownMenuSubTrigger
                                data-testid={`composer-add-${source.id}-context`}
                                openOnHover
                              >
                                {plusMenuSourceIcon(source.icon)}
                                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                                  {t('composer.referenceSource', {
                                    source: source.label,
                                  })}
                                </span>
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent
                                coordinateNavigation
                                data-testid="composer-plus-submenu"
                                onKeyDown={selectFirstMenuItem}
                              >
                                <div className={contextPaneClass} data-testid="ai-context-picker">
                                  <ReferencePicker
                                    browse={source.browse}
                                    candidates={state.aiPanel.contextCandidates}
                                    emptyLabel={renderFeedback(i18n, source.emptyLabel)}
                                    loading={state.aiPanel.contextCandidatesLoading}
                                    key={source.id}
                                    onQueryChange={setReferenceQuery}
                                    onConfirm={async (candidates) => {
                                      const result = await act.addContexts(candidates)
                                      if (result.accepted_ref_ids.length === 0) return
                                      setPlusMenuOpen(false)
                                      act.closeAiContextPicker()
                                      restoreComposerFocus()
                                    }}
                                    projectId={assistantProject(state).projectId}
                                    query={referenceQuery}
                                    sourceId={source.id}
                                    sourceLabel={source.label}
                                  />
                                </div>
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )
                        })}
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Popover
                  open={modeOpen}
                  onOpenChange={(open) => {
                    if (open) refreshMode()
                    else setFullAccessConfirmOpen(false)
                    setModeOpen(open)
                  }}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="content"
                      aria-label={modeControlLabel}
                      title={modeControlLabel}
                      data-testid="mode-chip"
                      disabled={modeChanging}
                      aria-busy={modeChanging}
                      aria-haspopup="menu"
                      className={`min-h-[var(--vds-control-height-md)] min-w-[var(--vds-control-height-md)] overflow-hidden gap-[var(--vds-space-2)] px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] ${inline ? 'order-2 !size-[var(--vds-space-8)] !p-0' : ''} ${activeModeMeta.tone === 'danger' ? '!text-[var(--vds-warning-text-primary)]' : ''}`}
                      icon={
                        <IconFont
                          type={modeControlIcon}
                          className={`text-[length:var(--vds-font-body-lv2)] leading-none ${activeModeMeta.tone === 'danger' ? 'text-[var(--vds-warning-text-primary)]' : 'text-[var(--vds-icon-outline-default)]'}`}
                        />
                      }
                    >
                      <span
                        className={inline ? 'hidden' : 'hidden min-w-0 truncate @sm/toolbar:inline'}
                      >
                        {modeLabel}
                      </span>
                      {currentModeInfo?.switch_warning && (
                        <span
                          data-testid="mode-warning"
                          className="whitespace-nowrap text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]"
                        >
                          {t('composer.modePendingConfirmation')}
                        </span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  {/* 权限模式菜单: 内容照设计稿, 图标 + 档位名 + 描述; 位置由 Popover 自动上翻。 */}
                  <PopoverContent
                    className="no-drag z-[var(--vds-z-popover)] !max-w-[var(--vds-composer-mode-menu-viewport-max-width)] gap-0 rounded-[var(--vds-radius-4)]"
                    data-testid="mode-menu"
                  >
                    <div className="mb-[var(--vds-space-2)] pt-[10px] px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-6)]">
                      {t('composer.modeMenuTitle')}
                    </div>
                    {currentModeInfo?.switch_warning && (
                      <p className="px-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-warning-text-primary)] [contain:inline-size]">
                        {t('composer.modeUnconfirmed')}
                      </p>
                    )}
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
                              ? 'bg-[var(--vds-bg-white-active-transparent)]'
                              : 'bg-transparent hover:bg-[var(--vds-bg-white-hover-transparent)]',
                          ].join(' ')}
                          onClick={() => requestMode(m)}
                        >
                          <span
                            className={`grid size-[var(--vds-space-8)] flex-none place-items-center rounded-[var(--vds-radius-4)] border-[length:var(--vds-border-width-1)] bg-[var(--vds-bg-white-default)] ${meta.tone === 'danger' ? 'border-[var(--vds-warning-light-border)] text-[var(--vds-warning-text-primary)]' : 'border-[var(--vds-border-default)] text-[var(--vds-icon-outline-default)]'}`}
                          >
                            <IconFont
                              type={PERMISSION_MODE_ICON_TYPES[m] ?? 'icon-qingqiupizhun'}
                              className="text-[15px] leading-none"
                            />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={`flex items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] font-[var(--vds-fw-regular)] ${meta.tone === 'danger' ? 'text-[var(--vds-warning-text-primary)]' : 'text-[var(--vds-text-primary)]'}`}
                            >
                              {meta.label}
                              {active &&
                                (currentModeInfo?.deferred ? (
                                  <span className="whitespace-nowrap text-[11.5px] text-[var(--text-3)]">
                                    {showsNextTurn
                                      ? MODE_PENDING_LABEL
                                      : t('composer.modePendingConfirmation')}
                                  </span>
                                ) : (
                                  <span className="text-[12.5px] text-[var(--accent-ink)]">✓</span>
                                ))}
                            </span>
                            <span
                              className={`block min-w-0 whitespace-normal break-words text-left text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv1)] ${meta.tone === 'danger' ? 'text-[var(--vds-warning-text-primary)]' : 'text-[var(--vds-text-6)]'}`}
                            >
                              {meta.hint}
                            </span>
                          </span>
                        </Button>
                      )
                    })}
                    {fullAccessConfirmOpen && (
                      /* 上边框去掉: 确认区仅靠警告底色与圆角与菜单项区分, 不再加分割线。 */
                      <div className="mx-[var(--vds-space-1)] mb-[var(--vds-space-1)] mt-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] bg-[var(--vds-warning-light-bg-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] [contain:inline-size]">
                        {/* 标题前不再加 shield icon; 按钮统一用 Button 组件 variant/size, 不手写样式。 */}
                        <div className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-warning-text-primary)]">
                          <span>{MODE_FULL_ACCESS_CONFIRM_TITLE}</span>
                        </div>
                        <p className="mb-[var(--vds-space-2)] mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          {MODE_FULL_ACCESS_CONFIRM_BODY}
                        </p>
                        <div className="flex flex-wrap justify-end gap-[var(--vds-space-1)]">
                          <Button
                            type="button"
                            variant="ghost"
                            size="md"
                            onClick={() => setFullAccessConfirmOpen(false)}
                          >
                            {t('composer.cancel')}
                          </Button>
                          <Button
                            type="button"
                            data-testid="mode-bypassPermissions-confirm"
                            variant="warning"
                            size="md"
                            onClick={() => requestMode('bypassPermissions')}
                          >
                            {t('composer.enable')}
                          </Button>
                        </div>
                      </div>
                    )}
                    {(showsNextTurn || currentModeInfo?.switch_warning) && running && (
                      <div className="mt-[var(--vds-space-2)] mb-[var(--vds-space-1)] flex items-center justify-between gap-[var(--vds-space-2)] border-t border-solid border-[var(--vds-border-default)] pt-[var(--vds-space-2)]">
                        <p className="m-0 min-w-0 flex-1 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-6)]">
                          {t('composer.modeCurrentTask', { mode: activeModeMeta.label })}
                        </p>
                        <Button
                          data-testid="mode-interrupt-continue"
                          className="shrink-0"
                          variant="outline"
                          size="sm"
                          disabled={modeChanging}
                          onClick={() => {
                            applyMode(curMode as GlobalPermissionMode, 'interrupt_continue')
                            setModeOpen(false)
                          }}
                        >
                          {t('composer.modeInterruptContinue')}
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
                <AlertDialog
                  open={Boolean(modeConfirmation?.sessionId === sidNow && modeConfirmation)}
                  onOpenChange={(open) => {
                    if (!open) setModeConfirmation(null)
                  }}
                >
                  <AlertDialogPortal>
                    <AlertDialogContent data-testid="mode-application-dialog">
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t('composer.modeSwitchTitle', {
                            mode: modeMeta(modeConfirmation?.mode ?? curMode).label,
                          })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t('composer.modeSwitchBody')}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel data-testid="mode-application-cancel">
                          {t('composer.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          data-testid="mode-application-next-turn"
                          variant="secondary"
                          onClick={() => confirmMode('next_turn')}
                        >
                          {t('composer.modeNextTurnAction')}
                        </AlertDialogAction>
                        <AlertDialogAction
                          data-testid="mode-application-now"
                          variant={
                            modeConfirmation?.mode === 'bypassPermissions' ? 'warning' : 'primary'
                          }
                          onClick={() => confirmMode('interrupt_continue')}
                        >
                          {t('composer.modeInterruptContinue')}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialogPortal>
                </AlertDialog>
                <Input
                  ref={attachmentInputRef}
                  data-testid="composer-file-input"
                  type="file"
                  multiple
                  onChange={(e) => void attachLocalFiles(e.target.files)}
                  className="hidden"
                />
                {surface !== 'assistant' && thread.capabilities?.collaboration_modes !== false && (
                  <Popover open={collaborationMenuOpen} onOpenChange={setCollaborationMenuOpen}>
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
                        <span className="whitespace-nowrap">{collaborationModeLabel}</span>
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
                        const selected = option.value === state.collaborationMode
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
                              'flex min-h-[var(--vds-control-height-sm)] w-full items-center rounded-[var(--vds-radius-3)] border-0 px-[var(--vds-space-3)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]',
                              selected
                                ? 'bg-[var(--vds-bg-white-active)]'
                                : 'bg-transparent hover:bg-[var(--vds-bg-white-hover)]',
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
                <span className={inline && !inlineEditorLayout.multiline ? 'hidden' : 'flex-1'} />
                {surface === 'assistant' && <ModelMenu compact iconOnly={inline} />}
                {surface !== 'assistant' && <ModelMenu />}
                {!canStop && (
                  <Button
                    data-testid="composer-send"
                    data-admission-blockers={
                      [
                        confirmation.pending && 'confirmation',
                        !runtimeReady && 'runtime',
                        !contextReady && 'context',
                        !selectedSkillsReady && 'skills',
                        thread.terminated === true && 'terminated',
                        thread.recoveryPending && !resourceFinalizing && 'recovery',
                        creditBlocked && 'credits',
                        !modelAvailable && 'model',
                        launching && 'launching',
                        interrupting && 'interrupting',
                        !hasContent && 'empty',
                        submittingMessage && 'submitting',
                      ]
                        .filter(Boolean)
                        .join(',') || undefined
                    }
                    data-state={
                      submittingMessage
                        ? 'submitting'
                        : launching
                          ? 'opening'
                          : resourceFinalizing || running || interrupting
                            ? 'queueing'
                            : 'idle'
                    }
                    aria-busy={launching || submittingMessage}
                    aria-label={sendButtonLabel}
                    onClick={() => void submit()}
                    disabled={!canSend || submittingMessage}
                    variant={surface === 'assistant' ? 'primary' : 'ghostIcon'}
                    size={surface === 'assistant' ? 'md' : 'icon'}
                    unstyled
                    className={`${sendButtonClass(surface, canSend, launching || submittingMessage)}${inline ? ' order-4' : ''}`}
                    title={sendButtonHint ?? sendButtonLabel}
                  >
                    {launching || submittingMessage ? (
                      <Spinner imageSrc={aiThinking} size="sm" aria-hidden="true" />
                    ) : (
                      <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
                    )}
                  </Button>
                )}
                {canStop && (
                  <Button
                    data-testid="composer-stop"
                    onClick={stop}
                    disabled={interrupting}
                    variant="danger"
                    size="icon"
                    unstyled
                    className={`${stopButtonClass(interrupting)}${inline ? ' order-4' : ''}`}
                    title={interrupting ? t('composer.stopping') : t('composer.stop')}
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
          className={
            inline
              ? 'hidden'
              : 'pointer-events-none select-none px-[var(--vds-space-2)] pb-[var(--vds-composer-hint-padding-bottom)] pt-[var(--vds-space-0)] text-center text-[length:var(--vds-font-caption)] font-[var(--vds-fw-regular)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-3)]'
          }
          data-testid="composer-ai-disclaimer"
        >
          {t('composer.aiGeneratedDisclaimer')}
        </p>
        <Dialog
          open={Boolean(dialogSource)}
          onOpenChange={(open) => {
            if (!open) closeReferenceDialog()
          }}
        >
          <DialogPortal>
            {dialogSource && (
              <DialogContent
                headerLayout="aligned"
                aria-label={assistantText(
                  dialogSource.id === RESOURCE_CONTEXT_KIND
                    ? 'referencePicker.resourcesTitle'
                    : 'referencePicker.literatureTitle'
                )}
                className="!flex h-[var(--vds-feedback-dialog-height)] !w-[var(--vds-feedback-dialog-width)] min-h-0 flex-col"
                data-testid="reference-library-dialog"
              >
                <DialogHeader>
                  <DialogTitle>
                    {assistantText(
                      dialogSource.id === RESOURCE_CONTEXT_KIND
                        ? 'referencePicker.resourcesTitle'
                        : 'referencePicker.literatureTitle'
                    )}
                  </DialogTitle>
                </DialogHeader>
                <ReferencePicker
                  key={`${dialogSource.id}:${assistantProject(state).projectId}`}
                  candidates={state.aiPanel.contextCandidates}
                  emptyLabel={dialogSource.emptyLabel}
                  loading={state.aiPanel.contextCandidatesLoading}
                  onQueryChange={setReferenceQuery}
                  onCancel={closeReferenceDialog}
                  onConfirm={async (candidates) => {
                    const result = await act.addContexts(candidates)
                    if (result.accepted_ref_ids.length > 0) {
                      closeReferenceDialog()
                      restoreComposerFocus()
                    }
                  }}
                  projectId={assistantProject(state).projectId}
                  query={referenceQuery}
                  sourceId={dialogSource.id}
                  sourceLabel={dialogSource.label}
                />
              </DialogContent>
            )}
          </DialogPortal>
        </Dialog>
        {state.skillUploadOpen && (
          <SkillAdd
            onClose={() => set({ skillUploadOpen: false })}
            onDone={async (message) => {
              set({ skillUploadOpen: false, foregroundNotice: message })
            }}
          />
        )}
      </div>
    </>
  )
}

function contextFailureFeedback(message: string) {
  if (message === 'context_save_failed') return feedback('assistant', 'contextErrors.saveRetry')
  const failure = assistantContextFailure(message)
  return 'raw' in failure
    ? failure.raw
    : feedback('assistant', failure.key, { detail: failure.detail ?? '' })
}
