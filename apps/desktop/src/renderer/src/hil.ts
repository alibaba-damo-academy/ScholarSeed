import type { ProductHilData } from './api'
import type { TFunction } from 'i18next'
import type {
  ConvItem,
  HilOption,
  HilQuestion,
  HilPermissionScope,
  HilResolvedMessage,
  HilSubmissionMessage,
  Thread,
} from './model'

export type HilItem = Extract<ConvItem, { kind: 'hil' }>

export function componentOptionAnswers(
  question: HilQuestion,
  values: Record<string, unknown>
): string[] | null {
  const answers = values.answers
  if (
    !Array.isArray(answers) ||
    (!question.multiSelect && answers.length > 1) ||
    new Set(answers).size !== answers.length ||
    answers.some(
      (answer) =>
        typeof answer !== 'string' || !question.options.some((option) => option.label === answer)
    )
  )
    return null
  return answers as string[]
}

const TERMINAL_HIL_STATES = new Set(['resolved', 'cancelled', 'stale', 'unknown'])
const DENY_OPTION_IDS = new Set(['n', 'no', 'deny', 'decline', 'reject', 'cancel'])
const ALLOW_ONCE_OPTION_IDS = new Set(['y', 'yes', 'accept', 'allowonce', 'allow_once'])
const DENY_OPTION_LABEL = /^\s*(no|deny|decline|reject|cancel|stop|拒绝|取消)/i
const ALLOW_ONCE_OPTION_LABEL = /(allow\s+once|once|仅这一次|允许一次|本次)/i
const EPOCH_MILLISECONDS_THRESHOLD = 10_000_000_000
const MILLISECONDS_PER_SECOND = 1_000
const HISTORY_SEARCH_MAX_LENGTH = 256
const HISTORY_OFFSET_MAX = 1_000
const HISTORY_LIMIT_MAX = 20
const HISTORY_INTENT_MAX_LENGTH = 512
const HISTORY_DIGEST = /^[a-f0-9]{64}$/

export function hilTimestamp(timestamp: number): number {
  return timestamp < EPOCH_MILLISECONDS_THRESHOLD ? timestamp * MILLISECONDS_PER_SECOND : timestamp
}

export function browserApprovalBody(decision: 'deny' | 'allow_once'): {
  decision: 'deny' | 'allow_once'
} {
  return { decision }
}

export function browserApprovalCardRole(
  presentation: 'history' | 'dock',
  done: boolean,
  expired: boolean
): 'alertdialog' | 'group' {
  return presentation === 'dock' && !done && !expired ? 'alertdialog' : 'group'
}

export function browserApprovalTarget<T extends { tabId: string; title: string; url: string }>(
  snapshot: { tabs: T[] },
  approval: { tabId: string; origin: string; action?: string; sourceOrigin?: string | null }
): T | null {
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === approval.tabId)
  if (!tab) return null
  if (approval.action === 'navigate' && approval.sourceOrigin === null) {
    return tab.url === 'about:blank' ? tab : null
  }
  try {
    return new URL(tab.url).origin ===
      (approval.action === 'navigate' ? approval.sourceOrigin : approval.origin)
      ? tab
      : null
  } catch {
    return null
  }
}

function validBrowserOrigin(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.origin === value &&
      !parsed.username &&
      !parsed.password
    )
  } catch {
    return false
  }
}

function validNavigateApproval(data: ProductHilData): boolean {
  if (
    data.source_origin !== null &&
    (typeof data.source_origin !== 'string' || !validBrowserOrigin(data.source_origin))
  )
    return false
  if (
    typeof data.destination_url !== 'string' ||
    typeof data.destination_origin !== 'string' ||
    !validBrowserOrigin(data.destination_origin) ||
    data.destination_origin !== data.origin
  )
    return false
  try {
    const destination = new URL(data.destination_url)
    return (
      (destination.protocol === 'https:' || destination.protocol === 'http:') &&
      !destination.username &&
      !destination.password &&
      destination.href === data.destination_url &&
      destination.origin === data.destination_origin
    )
  } catch {
    return false
  }
}

function validActionApproval(data: ProductHilData): boolean {
  return (
    typeof data.prepared_id === 'string' &&
    data.prepared_id.length > 0 &&
    typeof data.snapshot_id === 'string' &&
    data.snapshot_id.length > 0 &&
    typeof data.element_ref === 'string' &&
    data.element_ref.length > 0 &&
    data.browser_action === data.action &&
    typeof data.element?.role === 'string' &&
    data.element.role.length > 0 &&
    typeof data.element.name === 'string'
  )
}

function validHistoryApproval(data: ProductHilData): boolean {
  return (
    data.kind === 'browser_history_approval' &&
    data.method === 'browser_history_approval' &&
    typeof data.proof_id === 'string' &&
    data.proof_id.length > 0 &&
    typeof data.query_digest === 'string' &&
    HISTORY_DIGEST.test(data.query_digest) &&
    typeof data.history_revision === 'number' &&
    Number.isSafeInteger(data.history_revision) &&
    data.history_revision >= 0 &&
    typeof data.search === 'string' &&
    data.search.trim().length > 0 &&
    data.search.length <= HISTORY_SEARCH_MAX_LENGTH &&
    typeof data.offset === 'number' &&
    Number.isSafeInteger(data.offset) &&
    data.offset >= 0 &&
    data.offset <= HISTORY_OFFSET_MAX &&
    typeof data.limit === 'number' &&
    Number.isSafeInteger(data.limit) &&
    data.limit > 0 &&
    data.limit <= HISTORY_LIMIT_MAX &&
    typeof data.intent === 'string' &&
    data.intent.trim().length > 0 &&
    data.intent.length <= HISTORY_INTENT_MAX_LENGTH &&
    typeof data.expires_at === 'number' &&
    Number.isFinite(data.expires_at) &&
    data.expires_at > 0
  )
}

export function browserApprovalResolution(decision?: string, reason?: string): HilResolvedMessage {
  if (reason === 'expired') return { kind: 'browserExpired' }
  if (reason === 'turn_inactive' || reason === 'product_interaction_cancelled')
    return { kind: 'browserInactive' }
  if (decision === 'allow_once') return { kind: 'allowedOnce' }
  if (decision === 'deny') return { kind: 'denied' }
  return { kind: 'browserUnknown' }
}

export function browserHistoryApprovalResolution(
  decision?: string,
  reason?: string
): HilResolvedMessage {
  if (reason === 'expired') return { kind: 'historyExpired' }
  if (reason === 'turn_inactive' || reason === 'product_interaction_cancelled')
    return { kind: 'historyInactive' }
  if (decision === 'allow_once') return { kind: 'allowedOnce' }
  if (decision === 'deny') return { kind: 'denied' }
  return { kind: 'historyUnknown' }
}

export function browserApprovalSubmission(response: {
  ok: boolean
  error?: string
  outcome?: 'unknown' | 'stale'
  interaction?: { state?: string; decision?: string; reason?: string }
}): Pick<HilItem, 'hilState' | 'resolved' | 'resolvedMessage'> {
  return approvalSubmission(response, browserApprovalResolution)
}

export function browserHistoryApprovalSubmission(response: {
  ok: boolean
  error?: string
  outcome?: 'unknown' | 'stale'
  interaction?: { state?: string; decision?: string; reason?: string }
}): Pick<HilItem, 'hilState' | 'resolved' | 'resolvedMessage'> {
  return approvalSubmission(response, browserHistoryApprovalResolution)
}

function approvalSubmission(
  response: {
    ok: boolean
    outcome?: 'unknown' | 'stale'
    interaction?: { state?: string; decision?: string; reason?: string }
  },
  resolution: (decision?: string, reason?: string) => HilResolvedMessage
): Pick<HilItem, 'hilState' | 'resolved' | 'resolvedMessage'> {
  if (!response.ok && response.outcome === 'stale') return { hilState: 'stale' }
  const interaction = response.interaction
  if (
    response.ok &&
    interaction?.state === 'resolved' &&
    (interaction.decision === 'allow_once' || interaction.decision === 'deny')
  ) {
    return {
      hilState: 'resolved',
      resolved: interaction.decision,
      resolvedMessage: resolution(interaction.decision, interaction.reason),
    }
  }
  return { hilState: 'unknown' }
}

export function projectHilCard(
  data: ProductHilData,
  timestamp: number,
  turnId?: string,
  itemId?: string,
  eventSeq?: number
): HilItem {
  return {
    kind: 'hil',
    sessionId: data.session_id,
    requestId: data.request_id,
    lifetime: data.lifetime,
    blocking: data.blocking,
    hilKind: data.kind,
    ...(validHistoryApproval(data)
      ? {
          browserHistoryApproval: {
            proofId: data.proof_id!,
            queryDigest: data.query_digest!,
            historyRevision: data.history_revision!,
            search: data.search!,
            offset: data.offset!,
            limit: data.limit!,
            intent: data.intent!,
            expiresAt: hilTimestamp(data.expires_at!),
          },
        }
      : {}),
    ...(data.kind === 'browser_approval' &&
    data.method === 'browser_approval' &&
    data.tab_id &&
    data.proof_id &&
    data.target_instance_id &&
    typeof data.target_generation === 'number' &&
    Number.isSafeInteger(data.target_generation) &&
    data.target_generation >= 0 &&
    data.origin &&
    data.action &&
    typeof data.expires_at === 'number' &&
    Number.isFinite(data.expires_at) &&
    data.expires_at > 0 &&
    (data.action !== 'navigate' || validNavigateApproval(data)) &&
    (!['click', 'fill', 'submit'].includes(data.action) || validActionApproval(data))
      ? {
          browserApproval: {
            tabId: data.tab_id,
            proofId: data.proof_id,
            targetInstanceId: data.target_instance_id,
            targetGeneration: data.target_generation,
            ...(data.tab_title ? { tabTitle: data.tab_title } : {}),
            ...(data.tab_url ? { tabUrl: data.tab_url } : {}),
            origin: data.origin,
            ...(data.action === 'navigate'
              ? {
                  sourceOrigin: data.source_origin,
                  destinationUrl: data.destination_url,
                  destinationOrigin: data.destination_origin,
                }
              : {}),
            ...(['click', 'fill', 'submit'].includes(data.action)
              ? {
                  preparedId: data.prepared_id,
                  snapshotId: data.snapshot_id,
                  elementRef: data.element_ref,
                  browserAction: data.browser_action,
                  element: data.element,
                }
              : {}),
            action: data.action,
            intent: data.intent ?? '',
            expiresAt: hilTimestamp(data.expires_at),
          },
        }
      : {}),
    toolName: data.tool_name,
    title: data.title,
    body: data.body,
    questions: (data.questions ?? []).map((question) => ({
      ...(question.presentation ? { presentation: question.presentation } : {}),
      id: question.id,
      header: question.name ?? question.header,
      question: question.question,
      options: question.options ?? [],
      multiSelect: question.multiSelect,
      papers: question.papers,
      component: question.component,
      componentData: question.component_data,
      installation: question.plugin_installation,
    })),
    options: data.options,
    allowFreeText: data.allow_free_text,
    command: data.command,
    workdir: data.cwd,
    path: data.path,
    diff: data.diff,
    networkTarget: data.network_target,
    permissions: data.permissions,
    safetyTags: data.safety_tags,
    reason: data.reason,
    suggestedPrefix: data.suggested_prefix,
    prefixKind: data.prefix_kind,
    requestedAt: hilTimestamp(data.requested_at ?? timestamp),
    hilState: 'pending',
    turnId,
    itemId,
    eventSeq,
  }
}

export function isQuestionHil(item: HilItem): boolean {
  return item.hilKind === 'question' || (item.questions?.length ?? 0) > 0
}

export function settlePendingHil(
  conversation: ConvItem[],
  turnId: string | undefined,
  state: 'cancelled' | 'stale',
  preserveSession = false
): ConvItem[] {
  return conversation.map((item) =>
    item.kind === 'hil' &&
    item.blocking !== false &&
    item.turnId === turnId &&
    !(preserveSession && item.lifetime === 'session') &&
    (item.hilState === 'pending' || item.hilState === 'submitting')
      ? { ...item, ...hilResolution({ kind: state }), hilState: state }
      : item
  )
}

export function hilResolvedRunState(
  thread: Pick<Thread, 'running' | 'status' | 'turnOutcomes'>,
  turnId: string | undefined
): Partial<Pick<Thread, 'running' | 'status'>> {
  return thread.running && turnId && thread.turnOutcomes?.[turnId] === 'running'
    ? { running: true, status: 'running' }
    : {}
}

export function isTerminalHil(item: HilItem): boolean {
  return item.resolved != null || TERMINAL_HIL_STATES.has(item.hilState ?? '')
}

export function pendingHilItems(items: ConvItem[]): HilItem[] {
  return items.filter(
    (item): item is HilItem =>
      item.kind === 'hil' && item.blocking !== false && !isTerminalHil(item)
  )
}

export function hilRequestedRunState(
  thread: Pick<Thread, 'running' | 'status'>,
  data: ProductHilData
): Pick<Thread, 'running' | 'status'> {
  if (data.blocking === false) return { running: thread.running, status: thread.status }
  return {
    running: data.lifetime === 'session' ? thread.running : true,
    status: data.lifetime === 'session' && !thread.running ? thread.status : 'waiting',
  }
}

export function pendingPermissionItems(items: ConvItem[]): HilItem[] {
  return pendingHilItems(items).filter((item) => !isQuestionHil(item))
}

export function pendingQuestionItems(items: ConvItem[]): HilItem[] {
  return pendingHilItems(items).filter(isQuestionHil)
}

/**
 * A pending interaction is an active turn control, not transcript content.
 * The durable HIL item remains in the conversation as the single source of truth;
 * only its pending presentation moves to the composer dock.
 *
 * Permission HIL never appears in transcript: an executed permission is already
 * carried by its tool row (success or failure); an un-executed one (stale /
 * cancelled / unknown) carries no user-facing value on its own — the turn's
 * status/error line already conveys the outcome, and unknown turns surface a
 * dedicated confirm card elsewhere.
 *
 * Question HIL keeps the transcript trace: resolved answers become
 * interaction_reply, and terminal-without-answer stays at causal position.
 */
export function transcriptPresentationItems(items: ConvItem[]): ConvItem[] {
  return items.flatMap((item): ConvItem[] => {
    if (item.kind !== 'hil') return [item]
    if (item.blocking === false) return [item]
    if (item.hilKind === 'browser_approval' || item.hilKind === 'browser_history_approval')
      return isTerminalHil(item) ? [item] : []
    if (isQuestionHil(item)) {
      if (item.hilState === 'resolved' && Object.keys(item.answers ?? {}).length > 0) {
        return [
          {
            kind: 'interaction_reply',
            requestId: item.requestId,
            questions: item.questions ?? [],
            answers: item.answers ?? {},
            turnId: item.turnId,
            itemId: item.itemId,
            eventSeq: item.eventSeq,
          },
        ]
      }
      if (item.hilState === 'resolved') return []
      if (!isTerminalHil(item)) return []
      return [item]
    }
    return []
  })
}

function isDenyOption(option: HilOption): boolean {
  return DENY_OPTION_IDS.has(option.id.toLowerCase()) || DENY_OPTION_LABEL.test(option.label)
}

function isAllowOnceOption(option: HilOption): boolean {
  return (
    ALLOW_ONCE_OPTION_IDS.has(option.id.toLowerCase()) || ALLOW_ONCE_OPTION_LABEL.test(option.label)
  )
}

export function permissionDecisionOptions(item: HilItem): {
  allowOnce: HilOption | undefined
  deny: HilOption
  allowed: HilOption[]
} {
  const options = item.options?.length
    ? item.options
    : [
        { id: 'accept', label: 'Allow once' },
        { id: 'decline', label: 'Decline' },
      ]
  const allowed = options.filter((option) => !isDenyOption(option))
  return {
    allowOnce: allowed.find(isAllowOnceOption),
    allowed,
    deny: options.find(isDenyOption) ?? { id: 'decline', label: 'Decline' },
  }
}

const HIL_RESOLVED_TEXT = {
  stale: '请求已过期',
  cancelled: '已取消任务',
  handled: '已处理',
} as const
const HIL_SUBMISSION_TEXT = {
  outcomeUnknown: '提交结果尚未确认。书深不会重新提交；请先检查当前会话与产物，确认后继续任务。',
  cancelUnconfirmed: '取消请求未被后端确认，请重试。',
  answerUnconfirmed: 'HIL 回答未被后端确认，请重试。',
} as const

export function hilPermissionScope(option: HilOption, prefixKind?: string): HilPermissionScope {
  switch (option.id) {
    case 'y':
    case 'accept':
      return { kind: 'once' }
    case 'p':
      if (prefixKind === 'shell_prefix') return { kind: 'commandPrefix' }
      if (prefixKind === 'file_dir') return { kind: 'directory' }
      if (prefixKind === 'web_host') return { kind: 'site' }
      return { kind: 'always' }
    case 't':
    case 'acceptForSession':
      return { kind: 'session' }
    case 'e':
      return { kind: 'edits' }
    default:
      return { kind: 'raw', label: option.label }
  }
}

export function hilResolution(message: {
  kind: 'stale' | 'cancelled' | 'handled'
}): Pick<HilItem, 'resolved' | 'resolvedMessage'> {
  return { resolved: HIL_RESOLVED_TEXT[message.kind], resolvedMessage: message }
}

/** The event's real answer wins, even when identical to application wording. */
export function hilEventResolution(
  answer: string | undefined,
  state: HilItem['hilState'],
  timestamp?: number
): Pick<HilItem, 'resolved' | 'resolvedMessage' | 'resolvedAt'> {
  const resolution = answer
    ? { resolved: answer, resolvedMessage: undefined }
    : hilResolution({
        kind: state === 'stale' ? 'stale' : state === 'cancelled' ? 'cancelled' : 'handled',
      })
  return {
    ...resolution,
    ...(timestamp === undefined ? {} : { resolvedAt: hilTimestamp(timestamp) }),
  }
}

export function hilSubmissionFailure(
  message: HilSubmissionMessage,
  diagnostic?: string
): Pick<HilItem, 'submissionError' | 'submissionErrorMessage'> {
  return diagnostic
    ? { submissionError: diagnostic, submissionErrorMessage: undefined }
    : { submissionError: HIL_SUBMISSION_TEXT[message], submissionErrorMessage: message }
}

const HIL_RESOLVED_KEYS = {
  stale: 'stream.hil.stale',
  cancelled: 'stream.hil.cancelledTask',
  answered: 'stream.hil.answered',
  allowedOnce: 'stream.hil.allowedOnce',
  denied: 'stream.hil.denied',
} as const
const HIL_SCOPE_KEYS = {
  once: 'stream.hil.once',
  commandPrefix: 'stream.hil.allowCommandPrefix',
  directory: 'stream.hil.allowDirectory',
  site: 'stream.hil.allowSite',
  always: 'stream.hil.alwaysAllow',
  session: 'stream.hil.allowSession',
  edits: 'stream.hil.acceptEdits',
} as const
const HIL_SUBMISSION_KEYS = {
  outcomeUnknown: 'stream.hil.outcomeUnknown',
  cancelUnconfirmed: 'stream.hil.cancelUnconfirmed',
  answerUnconfirmed: 'stream.hil.answerUnconfirmed',
} as const

export function formatHilPermissionScope(
  scope: HilPermissionScope,
  t: TFunction<'components'>
): string {
  return scope.kind === 'raw' ? scope.label : t(HIL_SCOPE_KEYS[scope.kind])
}

export function formatHilResolution(
  item: Pick<HilItem, 'resolved' | 'resolvedMessage'>,
  t: TFunction<'components'>,
  conversation: TFunction<'conversation'>
): string | undefined {
  const message = item.resolvedMessage
  if (!message) return item.resolved
  if (message.kind === 'browserExpired') return conversation('browserApproval.expired')
  if (message.kind === 'browserInactive') return conversation('browserApproval.inactive')
  if (message.kind === 'browserUnknown') return conversation('browserApproval.unknown')
  if (message.kind === 'historyExpired') return conversation('browserHistoryApproval.expired')
  if (message.kind === 'historyInactive') return conversation('browserHistoryApproval.inactive')
  if (message.kind === 'historyUnknown') return conversation('browserHistoryApproval.unknown')
  if (message.kind === 'handled') return conversation('hil.handled')
  if (message.kind === 'allowedScope') {
    const scope = formatHilPermissionScope(message.scope, t)
    return t('stream.hil.allowedScope', { scope })
  }
  return t(HIL_RESOLVED_KEYS[message.kind])
}

export function formatHilSubmissionError(
  item: Pick<HilItem, 'submissionError' | 'submissionErrorMessage'>,
  t: TFunction<'components'>
): string | undefined {
  return item.submissionErrorMessage
    ? t(HIL_SUBMISSION_KEYS[item.submissionErrorMessage])
    : item.submissionError
}
