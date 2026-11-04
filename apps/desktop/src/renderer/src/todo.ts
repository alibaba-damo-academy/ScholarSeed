import type { ParseKeys } from 'i18next'
import {
  RELEASED_PLAN_SOURCE,
  PLAN_EXECUTION_TIMING_POLICY,
  isTurnBoundary,
  type PlanSnapshotUI,
  type SkillDurationEstimate,
  type Thread,
  type TodoItemUI,
} from './model.ts'
import type { ProductEvent } from './api'
import { pendingHilItems } from './hil.ts'

const MILLISECONDS_PER_SECOND = 1_000

export function projectPlanSnapshots(
  events: ProductEvent[],
  current: PlanSnapshotUI[] = []
): PlanSnapshotUI[] {
  const snapshots = new Map(current.map((snapshot) => [snapshot.sequence, snapshot]))
  for (const event of events) {
    if (event.type !== 'plan_snapshot') continue
    snapshots.set(event.seq, {
      sequence: event.seq,
      turnId: event.turn_id,
      timestamp: event.ts * MILLISECONDS_PER_SECOND,
      planId: event.data.plan?.plan_id,
      timingPolicy: event.data.plan?.timing_policy,
      released: event.data.plan?.source === RELEASED_PLAN_SOURCE,
      items: event.data.items,
    })
  }
  return [...snapshots.values()].sort((left, right) => left.sequence - right.sequence)
}

function currentPlanSnapshots(thread: Thread, turnId: string | null | undefined): PlanSnapshotUI[] {
  const snapshots = thread.planSnapshots ?? []
  const latest = snapshots.at(-1)
  if (!latest || latest.turnId !== turnId) return []
  let start = snapshots.length - 1
  while (start > 0) {
    const previous = snapshots[start - 1]
    const samePlan = latest.planId
      ? previous.planId === latest.planId
      : !previous.planId && previous.turnId === latest.turnId
    if (!samePlan) break
    start -= 1
  }
  return snapshots.slice(start)
}

export function planSkillEstimate(
  thread: Thread
): { turnId: string; estimate: SkillDurationEstimate } | undefined {
  const conversation = [...thread.conversation].reverse()
  const estimateForTurns = (turnIds: Set<string>) => {
    const event = conversation.find(
      (item) => item.kind === 'skill' && item.estimate && item.turnId && turnIds.has(item.turnId)
    )
    if (event?.kind === 'skill' && event.turnId && event.estimate)
      return { turnId: event.turnId, estimate: event.estimate }
    for (const item of conversation) {
      if (item.kind !== 'user' || !item.turnId || !turnIds.has(item.turnId)) continue
      const reference = item.refs?.find((ref) => ref.type === 'skill' && ref.estimate)
      if (reference?.estimate) return { turnId: item.turnId, estimate: reference.estimate }
    }
    return undefined
  }
  const runningTurns = new Set(
    Object.entries(thread.turnOutcomes ?? {})
      .filter(([, outcome]) => outcome === 'running')
      .map(([turnId]) => turnId)
  )
  const current = estimateForTurns(runningTurns)
  if (current) return current
  const turnId = thread.todoTurnId
  if (!turnId || !runningTurns.has(turnId)) return undefined
  const snapshots = currentPlanSnapshots(thread, turnId)
  if (!snapshots.length || snapshots.at(-1)?.released) return undefined
  const planTurns = new Set(
    snapshots.flatMap((snapshot) => (snapshot.turnId ? [snapshot.turnId] : []))
  )
  const previous = estimateForTurns(planTurns)
  return previous ? { turnId, estimate: previous.estimate } : undefined
}

function snapshotEnd(
  thread: Thread,
  snapshot: PlanSnapshotUI,
  next: PlanSnapshotUI | undefined,
  now: number,
  includeFinalization = false
): number {
  const timing = snapshot.turnId ? thread.turnTimings?.[snapshot.turnId] : undefined
  if (
    snapshot.released ||
    (!includeFinalization && snapshot.items.every((item) => item.status === 'completed'))
  )
    return snapshot.timestamp
  const terminal = snapshot.turnId && thread.turnOutcomes?.[snapshot.turnId] !== 'running'
  return Math.max(
    snapshot.timestamp,
    Math.min(
      next?.timestamp ?? Infinity,
      timing?.completedAt ?? (terminal ? snapshot.timestamp : now)
    )
  )
}

export function stepElapsedMilliseconds(
  thread: Thread,
  item: TodoDisplayItem,
  now: number
): number | null {
  if (item.kind === 'group' && !item.children?.length) return 0
  if (item.children?.length) {
    const durations = item.children.map((child) => stepElapsedMilliseconds(thread, child, now))
    return durations.some((duration) => duration === null)
      ? null
      : durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0)
  }
  const snapshots = currentPlanSnapshots(thread, thread.todoTurnId)
  let elapsed: number | null = null
  snapshots.forEach((snapshot, index) => {
    const matches = snapshot.items.filter((candidate) =>
      item.id ? candidate.id === item.id : !candidate.id && candidate.content === item.content
    )
    if (matches.length !== 1 || matches[0].status !== 'in_progress' || snapshot.released) return
    const end = snapshotEnd(thread, snapshot, snapshots[index + 1], now)
    elapsed =
      (elapsed ?? 0) + executionMilliseconds(thread, snapshot.turnId, snapshot.timestamp, end)
  })
  if (
    elapsed === null &&
    snapshots.at(-1)?.timingPolicy === PLAN_EXECUTION_TIMING_POLICY &&
    item.status !== 'done' &&
    item.status !== 'failed' &&
    item.status !== 'partial'
  ) {
    return 0
  }
  return elapsed
}

export function stepDisplayMilliseconds(
  thread: Thread,
  item: TodoDisplayItem,
  now: number
): number | null {
  if (item.children?.length) {
    const durations = item.children.map((child) => stepDisplayMilliseconds(thread, child, now))
    return durations.some((duration) => duration === null)
      ? null
      : durations.reduce<number>((sum, duration) => sum + (duration ?? 0), 0)
  }
  const elapsed = stepElapsedMilliseconds(thread, item, now)
  return elapsed === null
    ? null
    : Math.floor(elapsed / MILLISECONDS_PER_SECOND) * MILLISECONDS_PER_SECOND
}

export function stepEstimatedMilliseconds(thread: Thread, item: TodoDisplayItem): number | null {
  if (item.status !== 'done') return null
  const snapshots = currentPlanSnapshots(thread, thread.todoTurnId)
  const matchesFor = (snapshot: PlanSnapshotUI) =>
    snapshot.items.filter((candidate) =>
      item.id ? candidate.id === item.id : !candidate.id && candidate.content === item.content
    )
  for (const [index, snapshot] of snapshots.entries()) {
    const matches = matchesFor(snapshot)
    if (matches.length > 1 || snapshot.released) return null
    if (matches[0]?.status === 'in_progress') return null
    if (matches[0]?.status !== 'completed' || !snapshot.turnId) continue
    const timing = thread.turnTimings?.[snapshot.turnId]
    const previous = snapshots[index - 1]
    const previousMatches = previous ? matchesFor(previous) : []
    if (previousMatches.length > 1) return null
    const start =
      previous?.turnId === snapshot.turnId && previousMatches[0]?.status === 'pending'
        ? Math.max(previous.timestamp, timing?.startedAt ?? previous.timestamp)
        : timing?.startedAt
    if (
      start === undefined ||
      !Number.isFinite(start) ||
      !Number.isFinite(snapshot.timestamp) ||
      snapshot.timestamp < start ||
      (timing?.completedAt !== undefined && snapshot.timestamp > timing.completedAt)
    )
      return null
    return executionMilliseconds(thread, snapshot.turnId, start, snapshot.timestamp)
  }
  return null
}

// Plan facts belong to todoTurnId. Later conversation turns are not evidence of
// continuation: only a new plan_snapshot can transfer that ownership.
export type TodoDisplayStatus =
  | 'done'
  | 'running'
  | 'need'
  | 'unrequested'
  | 'todo'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'stopped'

export interface TodoDisplayItem {
  kind?: 'group' | 'step'
  content: string
  activeForm?: string
  status: TodoDisplayStatus
  id?: string
  dependsOn?: string[]
  children?: TodoDisplayItem[]
  applyingConfirmation?: boolean
  awaitingPlanUpdate?: boolean
}

type TodoSummaryKey = Extract<
  ParseKeys<'components'>,
  | 'todo.summary.allDone'
  | 'todo.summary.applying'
  | 'todo.summary.blocked'
  | 'todo.summary.completedPartial'
  | 'todo.summary.ended'
  | 'todo.summary.failed'
  | 'todo.summary.interrupted'
  | 'todo.summary.need'
  | 'todo.summary.partialFailure'
  | 'todo.summary.previous'
  | 'todo.summary.unrequested'
  | 'todo.summary.waiting'
>

export type TodoSummary = { status: TodoDisplayStatus; issueCount?: number } & (
  { label: string; messageKey?: never } | { messageKey: TodoSummaryKey; label?: never }
)

export function isLatestUserTurn(thread: Thread, turnId: string | null | undefined): boolean {
  if (!turnId) return false
  const latestUserTurnId = [...thread.conversation]
    .reverse()
    .find((item) => isTurnBoundary(item) && item.turnId)?.turnId
  return !latestUserTurnId || latestUserTurnId === turnId
}

export function planElapsedMilliseconds(
  thread: Thread,
  turnId: string | null | undefined,
  now: number
): number | null {
  const snapshots = currentPlanSnapshots(thread, turnId)
  if (snapshots.length) {
    let elapsed = 0
    snapshots.forEach((snapshot, index) => {
      const previous = snapshots[index - 1]
      const timing = snapshot.turnId ? thread.turnTimings?.[snapshot.turnId] : undefined
      const earlierPlan = thread.planSnapshots?.some(
        (candidate) =>
          candidate.sequence < snapshot.sequence && candidate.turnId === snapshot.turnId
      )
      const start =
        previous?.turnId === snapshot.turnId || earlierPlan
          ? snapshot.timestamp
          : (timing?.startedAt ?? snapshot.timestamp)
      const end = snapshotEnd(
        thread,
        snapshot,
        snapshots[index + 1],
        now,
        snapshot.timingPolicy === PLAN_EXECUTION_TIMING_POLICY
      )
      elapsed +=
        snapshot.timingPolicy === PLAN_EXECUTION_TIMING_POLICY
          ? Math.max(0, end - start)
          : executionMilliseconds(thread, snapshot.turnId, start, end)
    })
    return elapsed
  }
  const timing = turnId ? thread.turnTimings?.[turnId] : undefined
  if (!timing) return null
  const end = Math.max(timing.startedAt, timing.completedAt ?? now)
  return executionMilliseconds(thread, turnId, timing.startedAt, end)
}

function executionMilliseconds(
  thread: Thread,
  turnId: string | null | undefined,
  startedAt: number,
  end: number
): number {
  const waits = thread.conversation
    .flatMap((item) => {
      if (item.kind !== 'hil' || item.turnId !== turnId || item.requestedAt === undefined) return []
      const start = Math.max(startedAt, item.requestedAt)
      const finish = Math.min(end, item.resolvedAt ?? end)
      return finish > start ? [{ start, finish }] : []
    })
    .sort((left, right) => left.start - right.start)
  let waited = 0
  let accountedUntil = startedAt
  for (const wait of waits) {
    waited += Math.max(0, wait.finish - Math.max(accountedUntil, wait.start))
    accountedUntil = Math.max(accountedUntil, wait.finish)
  }
  return Math.max(0, end - startedAt - waited)
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
  if (
    thread.running === false ||
    thread.status === 'abandon' ||
    thread.status === 'done' ||
    thread.status === 'failed' ||
    thread.status === 'dormant'
  ) {
    return 'stopped'
  }
  if (outcome !== 'running') return 'stopped'
  const requests = thread.conversation.filter(
    (item) => item.kind === 'hil' && item.turnId === turnId
  )
  if (pendingHilItems(requests).length > 0) return 'need'
  // A declined tool is not a failed plan: Codex may replan within this same turn.
  return 'running'
}

/** Overlay execution state only on explicitly active steps; never select a pending step by position. */
export function displayTodos(thread: Thread): TodoDisplayItem[] {
  const state = planStatus(thread)
  const requests = thread.conversation.filter(
    (item) => item.kind === 'hil' && item.turnId === thread.todoTurnId
  )
  const confirmationResolved = requests.some(
    (item) => item.kind === 'hil' && (item.hilState === 'resolved' || item.hilState === 'cancelled')
  )
  const projected = (thread.todos ?? []).map((item) => {
    if (item.status === 'completed') return toItem(item, 'done')
    if (item.status === 'partial') return toItem(item, 'partial')
    if (item.status === 'blocked') return toItem(item, 'blocked')
    if (item.status === 'failed') return toItem(item, 'failed')
    if (item.status === 'in_progress') return toItem(item, state)
    if (item.status === 'needs_confirmation') {
      const confirmationStatus =
        state === 'running' && requests.length === 0 ? 'unrequested' : state
      return {
        ...toItem(item, confirmationStatus),
        applyingConfirmation: state === 'running' && confirmationResolved,
        awaitingPlanUpdate: state === 'running' && requests.length > 0 && !confirmationResolved,
      }
    }
    return toItem(item, 'todo')
  })
  const byId = new Map(projected.flatMap((item) => (item.id ? [[item.id, item] as const] : [])))
  const roots = projected.filter((item, index) => {
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
  roots.forEach(summarizeGroup)
  return roots
}

function summarizeGroup(item: TodoDisplayItem): void {
  if (!item.children?.length) return
  item.children.forEach(summarizeGroup)
  if (
    item.status === 'blocked' ||
    item.status === 'failed' ||
    item.status === 'partial' ||
    item.applyingConfirmation !== undefined
  )
    return
  if (item.children.every((child) => child.status === 'done')) item.status = 'done'
  else if (item.status === 'done') item.status = 'todo'
}

export function todoSummary(thread: Thread, items: TodoDisplayItem[]): TodoSummary {
  const { done, total } = todoProgress(items)
  if (total > 0 && done === total) return { messageKey: 'todo.summary.allDone', status: 'done' }
  const state = planStatus(thread)
  const details = flattenTodos(items)
  const current = deepestRunning(items)
  const issueCount = details.filter(
    (item) => item.status === 'partial' || item.status === 'blocked' || item.status === 'failed'
  ).length
  if (state === 'running' && current?.applyingConfirmation) {
    return { messageKey: 'todo.summary.applying', status: 'running' }
  }
  if (state === 'running' && current?.awaitingPlanUpdate) {
    return { messageKey: 'todo.summary.waiting', status: 'running' }
  }
  if (state === 'running' && !current) {
    if (details.some((item) => item.status === 'blocked'))
      return { messageKey: 'todo.summary.blocked', status: 'blocked' }
    if (details.some((item) => item.status === 'failed'))
      return { messageKey: 'todo.summary.partialFailure', status: 'failed' }
    if (details.some((item) => item.status === 'unrequested'))
      return { messageKey: 'todo.summary.unrequested', status: 'unrequested' }
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
    messageKey:
      outcome === 'interrupted'
        ? 'todo.summary.interrupted'
        : outcome === 'completed'
          ? 'todo.summary.ended'
          : 'todo.summary.previous',
    status: 'stopped',
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
  return {
    content: item.content,
    kind: item.kind,
    activeForm: item.activeForm ?? undefined,
    status,
    id: item.id,
    dependsOn: item.dependsOn,
  }
}

/** Completed steps / total steps, not a time estimate. */
export function todoProgress(items: TodoDisplayItem[]): { done: number; total: number } {
  return { done: items.filter((item) => item.status === 'done').length, total: items.length }
}

/** Active-step ordinals remain tied to root stages; child plans never change the denominator. */
export function todoProgressLabel(items: TodoDisplayItem[]): string {
  const total = items.length
  const reached = items.reduce(
    (latest, item, index) => (item.status === 'todo' ? latest : Math.max(latest, index + 1)),
    0
  )
  return `${reached} / ${total}`
}
