import type { ProductHilData } from './api'
import type { TFunction } from 'i18next'
import type { ConvItem, HilOption, HilPermissionScope, HilSubmissionMessage } from './model'

export type HilItem = Extract<ConvItem, { kind: 'hil' }>

const TERMINAL_HIL_STATES = new Set(['resolved', 'cancelled', 'stale', 'unknown'])
const DENY_OPTION_IDS = new Set(['n', 'no', 'deny', 'decline', 'reject', 'cancel'])
const ALLOW_ONCE_OPTION_IDS = new Set(['y', 'yes', 'accept', 'allowonce', 'allow_once'])
const DENY_OPTION_LABEL = /^\s*(no|deny|decline|reject|cancel|stop|拒绝|取消)/i
const ALLOW_ONCE_OPTION_LABEL = /(allow\s+once|once|仅这一次|允许一次|本次)/i

function epochMilliseconds(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
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
    requestId: data.request_id,
    hilKind: data.kind,
    toolName: data.tool_name,
    title: data.title,
    body: data.body,
    questions: (data.questions ?? []).map((question) => ({
      id: question.id,
      header: question.name ?? question.header,
      question: question.question,
      options: question.options ?? [],
      multiSelect: question.multiSelect
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
    requestedAt: epochMilliseconds(data.requested_at ?? timestamp),
    hilState: 'pending',
    turnId,
    itemId,
    eventSeq
  }
}

export function isQuestionHil(item: HilItem): boolean {
  return item.hilKind === 'question' || (item.questions?.length ?? 0) > 0
}

export function isTerminalHil(item: HilItem): boolean {
  return item.resolved != null || TERMINAL_HIL_STATES.has(item.hilState ?? '')
}

export function pendingHilItems(items: ConvItem[]): HilItem[] {
  return items.filter(
    (item): item is HilItem => item.kind === 'hil' && !isTerminalHil(item)
  )
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
    if (isQuestionHil(item)) {
      if (item.hilState === 'resolved' && Object.keys(item.answers ?? {}).length > 0) {
        return [{
          kind: 'interaction_reply',
          requestId: item.requestId,
          questions: item.questions ?? [],
          answers: item.answers ?? {},
          turnId: item.turnId,
          itemId: item.itemId,
          eventSeq: item.eventSeq
        }]
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
  return ALLOW_ONCE_OPTION_IDS.has(option.id.toLowerCase())
    || ALLOW_ONCE_OPTION_LABEL.test(option.label)
}

export function permissionDecisionOptions(item: HilItem): {
  allowOnce: HilOption
  deny: HilOption
} {
  const options = item.options?.length
    ? item.options
    : [
        { id: 'accept', label: 'Allow once' },
        { id: 'decline', label: 'Decline' }
      ]
  const allowed = options.filter((option) => !isDenyOption(option))
  return {
    allowOnce: allowed.find(isAllowOnceOption) ?? allowed[0] ?? { id: 'accept', label: 'Allow once' },
    deny: options.find(isDenyOption) ?? { id: 'decline', label: 'Decline' }
  }
}

const HIL_RESOLVED_TEXT = {
  stale: '请求已过期',
  cancelled: '已取消任务',
  handled: '已处理'
} as const
const HIL_SUBMISSION_TEXT = {
  outcomeUnknown: '提交结果尚未确认。书深不会重新提交；请先检查当前会话与产物，确认后继续对话。',
  cancelUnconfirmed: '取消请求未被后端确认，请重试。',
  answerUnconfirmed: 'HIL 回答未被后端确认，请重试。'
} as const

export function hilPermissionScope(option: HilOption, prefixKind?: string): HilPermissionScope {
  switch (option.id) {
    case 'y':
    case 'accept': return { kind: 'once' }
    case 'p':
      if (prefixKind === 'shell_prefix') return { kind: 'commandPrefix' }
      if (prefixKind === 'file_dir') return { kind: 'directory' }
      if (prefixKind === 'web_host') return { kind: 'site' }
      return { kind: 'always' }
    case 't':
    case 'acceptForSession': return { kind: 'session' }
    case 'e': return { kind: 'edits' }
    default: return { kind: 'raw', label: option.label }
  }
}

export function hilResolution(message: { kind: 'stale' | 'cancelled' | 'handled' }): Pick<HilItem, 'resolved' | 'resolvedMessage'> {
  return { resolved: HIL_RESOLVED_TEXT[message.kind], resolvedMessage: message }
}

/** The event's real answer wins, even when identical to application wording. */
export function hilEventResolution(answer: string | undefined, state: HilItem['hilState']): Pick<HilItem, 'resolved' | 'resolvedMessage'> {
  return answer
    ? { resolved: answer, resolvedMessage: undefined }
    : hilResolution({ kind: state === 'stale' ? 'stale' : state === 'cancelled' ? 'cancelled' : 'handled' })
}

export function hilSubmissionFailure(message: HilSubmissionMessage, diagnostic?: string): Pick<HilItem, 'submissionError' | 'submissionErrorMessage'> {
  return diagnostic
    ? { submissionError: diagnostic, submissionErrorMessage: undefined }
    : { submissionError: HIL_SUBMISSION_TEXT[message], submissionErrorMessage: message }
}

const HIL_RESOLVED_KEYS = {
  stale: 'stream.hil.stale', cancelled: 'stream.hil.cancelledTask',
  answered: 'stream.hil.answered', allowedOnce: 'stream.hil.allowedOnce', denied: 'stream.hil.denied'
} as const
const HIL_SCOPE_KEYS = {
  once: 'stream.hil.once', commandPrefix: 'stream.hil.allowCommandPrefix',
  directory: 'stream.hil.allowDirectory', site: 'stream.hil.allowSite',
  always: 'stream.hil.alwaysAllow', session: 'stream.hil.allowSession', edits: 'stream.hil.acceptEdits'
} as const
const HIL_SUBMISSION_KEYS = {
  outcomeUnknown: 'stream.hil.outcomeUnknown', cancelUnconfirmed: 'stream.hil.cancelUnconfirmed',
  answerUnconfirmed: 'stream.hil.answerUnconfirmed'
} as const

export function formatHilPermissionScope(scope: HilPermissionScope, t: TFunction<'components'>): string {
  return scope.kind === 'raw' ? scope.label : t(HIL_SCOPE_KEYS[scope.kind])
}

export function formatHilResolution(
  item: Pick<HilItem, 'resolved' | 'resolvedMessage'>,
  t: TFunction<'components'>,
  conversation: TFunction<'conversation'>
): string | undefined {
  const message = item.resolvedMessage
  if (!message) return item.resolved
  if (message.kind === 'handled') return conversation('hil.handled')
  if (message.kind === 'allowedScope') {
    const scope = formatHilPermissionScope(message.scope, t)
    return t('stream.hil.allowedScope', { scope })
  }
  return t(HIL_RESOLVED_KEYS[message.kind])
}

export function formatHilSubmissionError(item: Pick<HilItem, 'submissionError' | 'submissionErrorMessage'>, t: TFunction<'components'>): string | undefined {
  return item.submissionErrorMessage ? t(HIL_SUBMISSION_KEYS[item.submissionErrorMessage]) : item.submissionError
}
