import type { ParseKeys } from 'i18next'
import type { Thread, TodoItemUI } from './model'

// Plan facts belong to todoTurnId. Later conversation turns are not evidence of
// continuation: only a new plan_snapshot can transfer that ownership.
export type TodoDisplayStatus = 'done' | 'running' | 'need' | 'todo' | 'partial' | 'blocked' | 'failed' | 'stopped'

export interface TodoDisplayItem {
  content: string
  activeForm?: string
  status: TodoDisplayStatus
  id?: string
  dependsOn?: string[]
  children?: TodoDisplayItem[]
  applyingConfirmation?: boolean
}

type TodoSummaryKey = Exclude<
  Extract<ParseKeys<'components'>, `todo.summary.${string}`>,
  'todo.summary.runningWithIssues'
>

export type TodoSummary = { status: TodoDisplayStatus; issueCount?: number } & (
  { label: string; messageKey?: never }
  | { messageKey: TodoSummaryKey; label?: never }
)

export function isLatestUserTurn(thread: Thread, turnId: string | null | undefined): boolean {
  if (!turnId) return false
  const latestUserTurnId = [...thread.conversation].reverse().find((item) => (
    item.kind === 'user' && item.turnId
  ))?.turnId
  return !latestUserTurnId || latestUserTurnId === turnId
}

export function planStatus(thread: Thread): TodoDisplayStatus {
  const turnId = thread.todoTurnId
  if (!turnId) return 'stopped'
  const outcome = thread.turnOutcomes?.[turnId]
  // Terminal evidence wins over any stale permission request or plan snapshot.
  if (outcome === 'failed') return 'failed'
  // Session-level termination overrides the plan's turn ownership: a released
  // bridge plan keeps `todoTurnId` on a historical turn whose outcome never
  // reaches this thread, so the plan would otherwise spin forever after stop.
  if (thread.running === false || thread.status === 'abandon' || thread.status === 'done' || thread.status === 'failed' || thread.status === 'dormant') {
    return 'stopped'
  }
  if (outcome !== 'running') return 'stopped'
  const requests = thread.conversation.filter((item) => item.kind === 'hil' && item.turnId === turnId)
  if (requests.some((item) => item.kind === 'hil' && (item.hilState === 'pending' || item.hilState === 'submitting'))) return 'need'
  // A declined tool is not a failed plan: Codex may replan within this same turn.
  return 'running'
}

/** Overlay execution state only on explicitly active steps; never select a pending step by position. */
export function displayTodos(thread: Thread): TodoDisplayItem[] {
  const state = planStatus(thread)
  const confirmationResolved = Boolean(thread.todoTurnId && thread.conversation.some((item) => (
    item.kind === 'hil'
      && item.turnId === thread.todoTurnId
      && (item.hilState === 'resolved' || item.hilState === 'cancelled')
  )))
  const projected = (thread.todos ?? []).map((item) => {
    if (item.status === 'completed') return toItem(item, 'done')
    if (item.status === 'partial') return toItem(item, 'partial')
    if (item.status === 'blocked') return toItem(item, 'blocked')
    if (item.status === 'failed') return toItem(item, 'failed')
    if (item.status === 'in_progress') return toItem(item, state)
    if (item.status === 'needs_confirmation') {
      const confirmationStatus = state === 'need'
        ? 'need'
        : state === 'running'
          ? confirmationResolved ? 'running' : 'need'
          : state
      return {
        ...toItem(item, confirmationStatus),
        applyingConfirmation: state === 'running' && confirmationResolved
      }
    }
    return toItem(item, 'todo')
  })
  const byId = new Map(projected.flatMap((item) => item.id ? [[item.id, item] as const] : []))
  return projected.filter((item, index) => {
    const parentId = thread.todos?.[index].parent_id
    const parent = parentId ? byId.get(parentId) : undefined
    if (!parent) return true
    const seen = new Set([item.id])
    let ancestor: string | null | undefined = parentId
    while (ancestor) {
      if (seen.has(ancestor)) return true
      seen.add(ancestor)
      ancestor = thread.todos?.find((candidate) => candidate.id === ancestor)?.parent_id
    }
    parent.children = [...(parent.children ?? []), item]
    return false
  })
}

export function todoSummary(thread: Thread, items: TodoDisplayItem[]): TodoSummary {
  const { done, total } = todoProgress(items)
  if (total > 0 && done === total) return { messageKey: 'todo.summary.allDone', status: 'done' }
  const state = planStatus(thread)
  const details = flattenTodos(items)
  const current = deepestRunning(items)
  const issueCount = details.filter((item) => (
    item.status === 'partial' || item.status === 'blocked' || item.status === 'failed'
  )).length
  if (state === 'running' && current?.applyingConfirmation) {
    return { messageKey: 'todo.summary.applying', status: 'running' }
  }
  if (state === 'running' && !current) {
    if (details.some((item) => item.status === 'need')) return { messageKey: 'todo.summary.need', status: 'need' }
    if (details.some((item) => item.status === 'blocked')) return { messageKey: 'todo.summary.blocked', status: 'blocked' }
    if (details.some((item) => item.status === 'failed')) return { messageKey: 'todo.summary.partialFailure', status: 'failed' }
  }
  if (state === 'need') return { messageKey: 'todo.summary.need', status: state }
  if (state === 'failed') return { messageKey: 'todo.summary.failed', status: state }
  if (state === 'running') {
    const label = current?.activeForm || current?.content
    return label
      ? { label, status: state, ...(issueCount ? { issueCount } : {}) }
      : { messageKey: 'todo.summary.waiting', status: state, ...(issueCount ? { issueCount } : {}) }
  }
  const outcome = thread.todoTurnId ? thread.turnOutcomes?.[thread.todoTurnId] : undefined
  if (outcome === 'completed' && issueCount > 0) {
    return { messageKey: 'todo.summary.completedPartial', status: 'partial', issueCount }
  }
  return {
    messageKey: outcome === 'interrupted' ? 'todo.summary.interrupted' : outcome === 'completed' ? 'todo.summary.ended' : 'todo.summary.previous',
    status: 'stopped'
  }
}

function deepestRunning(items: TodoDisplayItem[]): TodoDisplayItem | undefined {
  for (const item of items) {
    if (item.status !== 'running') continue
    return deepestRunning(item.children ?? []) ?? item
  }
  return undefined
}

function flattenTodos(items: TodoDisplayItem[]): TodoDisplayItem[] {
  return items.flatMap((item) => [item, ...flattenTodos(item.children ?? [])])
}

function toItem(item: TodoItemUI, status: TodoDisplayStatus): TodoDisplayItem {
  return { content: item.content, activeForm: item.activeForm ?? undefined, status, id: item.id, dependsOn: item.dependsOn }
}

/** Completed steps / total steps, not a time estimate. */
export function todoProgress(items: TodoDisplayItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === 'done').length, total: items.length }
}

/** Active-step ordinals remain tied to root stages; child plans never change the denominator. */
export function todoProgressLabel(items: TodoDisplayItem[]): string {
  const total = items.length
  const reached = items.reduce(
    (latest, item, index) => item.status === 'todo'
      ? latest
      : Math.max(latest, index + 1),
    0
  )
  return `${reached} / ${total}`
}
