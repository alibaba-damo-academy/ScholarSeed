import type { AgentInvocationEvent } from '../../contracts/invocation.ts'
import { webSearchModeDefinition } from './search.ts'
import type {
  ResourceWebSearch,
  WebSearchAttempt,
  WebSearchStatus
} from './state.ts'

const PLAN_UPDATED_EVENT = 'plan.updated'
const WEB_SEARCH_STARTED_EVENT = 'web_search.started'
const WEB_SEARCH_COMPLETED_EVENT = 'web_search.completed'
const SKILL_STARTED_EVENT = 'skill.started'
const SKILL_COMPLETED_EVENT = 'skill.completed'
const TOOL_STARTED_EVENT = 'tool.started'
const TOOL_COMPLETED_EVENT = 'tool.completed'
const PLAN_IN_PROGRESS_STATUS = 'in_progress'
const AGENT_STAGE_DETAIL = '由 Agent 根据本次任务动态报告'
const UNREPORTED_ACTIVITY_TITLE = 'Agent 内部处理'
const UNREPORTED_ACTIVITY_DETAIL = '此时间段没有收到 Agent 的阶段更新'
const ROUTE_ACTIVITY_TITLE = '搜索调度'
const ROUTE_ACTIVITY_DETAIL = '正在选择并启动可用的搜索执行方式'
const RESULT_ACTIVITY_TITLE = '搜索结果确认'
const RESULT_ACTIVITY_DETAIL = '正在校验并展示本次搜索结果'
const PRODUCT_ACTIVITY_META = '书深产品阶段'
const TOOL_ACTIVITY_DETAIL = '运行时记录的真实工具活动'
const WEB_SEARCH_ACTIVITY_TITLE = 'Web Search'
const SKILL_ACTIVITY_TITLE = 'Skill'
const TOOL_ACTIVITY_TITLE = '工具调用'
const MILLISECONDS_PER_SECOND = 1_000
const PRODUCT_PHASE_MERGE_THRESHOLD_MS = 50
const BEFORE_FIRST_EVENT_SEQUENCE = Number.NEGATIVE_INFINITY

const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<WebSearchStatus> = new Set([
  'completed',
  'failed',
  'interrupted',
  'unknown',
  'unavailable'
])

type ActivityPair = {
  kind: 'web_search' | 'skill' | 'tool'
  identity: string
  started?: AgentInvocationEvent
  completed?: AgentInvocationEvent
}

type PlanStage = {
  title: string
  detail: string
  sequence: number
}

type OpenStage = PlanStage & { startedAt: number }

export type WebSearchProcessStatus = 'running' | 'done' | 'failed' | 'skipped'
export type WebSearchActivitySource = 'agent' | 'runtime' | 'router' | 'unreported'

export interface WebSearchProcessStep {
  id: string
  parentId?: string
  depth: 0 | 1
  title: string
  detail: string
  meta?: string
  source: WebSearchActivitySource
  status: WebSearchProcessStatus
  startedAt?: number
  completedAt?: number
  countsTowardTotal: boolean
  /** Internal event-order boundaries used to attach nested Runtime activities. */
  startedSequence?: number
  completedSequence?: number
}

function agentReportTime(attempt: WebSearchAttempt, event: AgentInvocationEvent): number {
  const observedAt = attempt.eventObservedAt[event.seq]
  if (Number.isFinite(observedAt)) return observedAt
  return event.created_at * MILLISECONDS_PER_SECOND
}

function runtimeEventTime(event: AgentInvocationEvent): number {
  return event.created_at * MILLISECONDS_PER_SECOND
}

function boundedTime(value: number, startedAt: number, completedAt: number): number {
  return Math.min(completedAt, Math.max(startedAt, value))
}

function terminalStatus(status: WebSearchStatus): WebSearchProcessStatus {
  if (status === 'failed' || status === 'interrupted' || status === 'unknown') return 'failed'
  if (status === 'unavailable') return 'skipped'
  return status === 'completed' ? 'done' : 'running'
}

function planStage(event: AgentInvocationEvent): PlanStage | null {
  if (event.type !== PLAN_UPDATED_EVENT || !Array.isArray(event.data.todos)) return null
  const current = event.data.todos.find((value) => (
    typeof value === 'object'
      && value !== null
      && 'status' in value
      && value.status === PLAN_IN_PROGRESS_STATUS
      && 'content' in value
      && typeof value.content === 'string'
      && value.content.trim().length > 0
  ))
  if (!current || typeof current !== 'object' || !('content' in current)) return null
  const explanation = typeof event.data.explanation === 'string'
    ? event.data.explanation.trim()
    : ''
  return {
    title: String(current.content).trim(),
    detail: explanation || AGENT_STAGE_DETAIL,
    sequence: event.seq
  }
}

function sameStage(current: OpenStage | null, next: PlanStage | null): boolean {
  return current?.title === next?.title
}

function unreportedStep(
  attemptIndex: number,
  gapIndex: number,
  attempt: WebSearchAttempt,
  startedAt: number,
  completedAt: number | undefined,
  status: WebSearchProcessStatus,
  startedSequence: number,
  completedSequence?: number
): WebSearchProcessStep {
  return {
    id: `${attemptIndex}:gap:${gapIndex}`,
    depth: 0,
    title: UNREPORTED_ACTIVITY_TITLE,
    detail: UNREPORTED_ACTIVITY_DETAIL,
    meta: `${webSearchModeDefinition(attempt.mode).label} · 未报告活动`,
    source: 'unreported',
    status,
    startedAt,
    completedAt,
    countsTowardTotal: true,
    startedSequence,
    completedSequence
  }
}

function stageStep(
  attemptIndex: number,
  attempt: WebSearchAttempt,
  stage: OpenStage,
  completedAt: number | undefined,
  status: WebSearchProcessStatus,
  completedSequence?: number
): WebSearchProcessStep {
  return {
    id: `${attemptIndex}:stage:${stage.sequence}`,
    depth: 0,
    title: stage.title,
    detail: stage.detail,
    meta: `${webSearchModeDefinition(attempt.mode).label} · Agent 动态阶段`,
    source: 'agent',
    status,
    startedAt: stage.startedAt,
    completedAt,
    countsTowardTotal: true,
    startedSequence: stage.sequence,
    completedSequence
  }
}

function topLevelSteps(
  attempt: WebSearchAttempt,
  attemptIndex: number,
  effectiveCompletedAt: number
): WebSearchProcessStep[] {
  if (attempt.status === 'unavailable') {
    return [{
      id: `${attemptIndex}:unavailable`,
      depth: 0,
      title: `${webSearchModeDefinition(attempt.mode).label} 当前不可用`,
      detail: attempt.error || '当前运行时不支持此搜索方式',
      source: 'router',
      status: 'skipped',
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
      countsTowardTotal: true,
      startedSequence: BEFORE_FIRST_EVENT_SEQUENCE
    }]
  }

  const terminal = TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
  const finalStatus = terminalStatus(attempt.status)
  const planEvents = attempt.invocationEvents
    .filter((event) => event.type === PLAN_UPDATED_EVENT)
    .sort((left, right) => left.seq - right.seq)
  const steps: WebSearchProcessStep[] = []
  let boundary = attempt.startedAt
  let boundarySequence = BEFORE_FIRST_EVENT_SEQUENCE
  let current: OpenStage | null = null
  let gapIndex = 0

  for (const event of planEvents) {
    const next = planStage(event)
    if (sameStage(current, next)) {
      if (current && next) {
        current = {
          title: current.title,
          detail: next.detail,
          sequence: current.sequence,
          startedAt: current.startedAt
        }
      }
      continue
    }
    const changedAt = boundedTime(
      agentReportTime(attempt, event),
      attempt.startedAt,
      effectiveCompletedAt
    )
    if (current) {
      steps.push(stageStep(
        attemptIndex,
        attempt,
        current,
        changedAt,
        'done',
        event.seq
      ))
    } else if (changedAt > boundary) {
      steps.push(unreportedStep(
        attemptIndex,
        gapIndex,
        attempt,
        boundary,
        changedAt,
        'done',
        boundarySequence,
        event.seq
      ))
      gapIndex += 1
    }
    boundary = changedAt
    boundarySequence = event.seq
    current = next ? { ...next, startedAt: changedAt } : null
  }

  const completedAt = terminal ? effectiveCompletedAt : undefined
  if (current) {
    steps.push(stageStep(attemptIndex, attempt, current, completedAt, finalStatus))
  } else if (effectiveCompletedAt > boundary || steps.length === 0) {
    steps.push(unreportedStep(
      attemptIndex,
      gapIndex,
      attempt,
      boundary,
      completedAt,
      finalStatus,
      boundarySequence
    ))
  }
  return steps
}

function activityPair(event: AgentInvocationEvent): {
  kind: ActivityPair['kind']
  phase: 'started' | 'completed'
} | null {
  if (event.type === WEB_SEARCH_STARTED_EVENT) return { kind: 'web_search', phase: 'started' }
  if (event.type === WEB_SEARCH_COMPLETED_EVENT) return { kind: 'web_search', phase: 'completed' }
  if (event.type === SKILL_STARTED_EVENT) return { kind: 'skill', phase: 'started' }
  if (event.type === SKILL_COMPLETED_EVENT) return { kind: 'skill', phase: 'completed' }
  if (event.type === TOOL_STARTED_EVENT) return { kind: 'tool', phase: 'started' }
  if (event.type === TOOL_COMPLETED_EVENT) return { kind: 'tool', phase: 'completed' }
  return null
}

function activityPairs(events: readonly AgentInvocationEvent[]): ActivityPair[] {
  const pairs: ActivityPair[] = []
  const stablePairs = new Map<string, ActivityPair>()
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const definition = activityPair(event)
    if (!definition) continue
    const callId = event.data.call_id
    const identity = event.item_id || (
      typeof callId === 'string' || typeof callId === 'number'
        ? String(callId)
        : ''
    )
    let pair: ActivityPair | undefined
    if (identity) {
      const key = `${definition.kind}:${identity}`
      pair = stablePairs.get(key)
      if (!pair) {
        pair = { kind: definition.kind, identity }
        stablePairs.set(key, pair)
        pairs.push(pair)
      }
    } else if (definition.phase === 'completed') {
      pair = pairs.find((candidate) => (
        candidate.kind === definition.kind
        && candidate.started !== undefined
        && candidate.completed === undefined
      ))
      if (!pair) continue
    } else {
      pair = {
        kind: definition.kind,
        identity: `anonymous-${definition.kind}-${event.seq}`
      }
      pairs.push(pair)
    }
    pair[definition.phase] = event
  }
  return pairs
}

function activityText(data: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function childStep(
  attempt: WebSearchAttempt,
  attemptIndex: number,
  pair: ActivityPair,
  parentId: string
): WebSearchProcessStep {
  const evidence = pair.completed ?? pair.started!
  const startedAt = pair.started ? runtimeEventTime(pair.started) : undefined
  const completedAt = pair.completed ? runtimeEventTime(pair.completed) : undefined
  const failed = pair.completed?.data.ok === false
    || pair.completed?.data.success === false
  const status: WebSearchProcessStatus = pair.completed
    ? failed ? 'failed' : 'done'
    : TERMINAL_ATTEMPT_STATUSES.has(attempt.status)
      ? 'failed'
      : 'running'
  let title = TOOL_ACTIVITY_TITLE
  let detail = TOOL_ACTIVITY_DETAIL
  let meta: string | undefined
  if (pair.kind === 'web_search') {
    title = WEB_SEARCH_ACTIVITY_TITLE
    detail = activityText(evidence.data, ['query']) || TOOL_ACTIVITY_DETAIL
    const resultCount = Number(pair.completed?.data.result_count)
    if (Number.isInteger(resultCount) && resultCount >= 0) {
      meta = `返回 ${resultCount} 条原始结果`
    }
  } else if (pair.kind === 'skill') {
    const name = activityText(evidence.data, ['name', 'skill', 'id'])
    title = name ? `${SKILL_ACTIVITY_TITLE} · ${name}` : SKILL_ACTIVITY_TITLE
  } else {
    title = activityText(evidence.data, ['title', 'name']) || TOOL_ACTIVITY_TITLE
  }
  return {
    id: `${attemptIndex}:activity:${pair.kind}:${pair.identity}`,
    parentId,
    depth: 1,
    title,
    detail,
    meta,
    source: 'runtime',
    status,
    startedAt,
    completedAt,
    countsTowardTotal: false,
    startedSequence: pair.started?.seq ?? pair.completed?.seq,
    completedSequence: pair.completed?.seq
  }
}

function withChildActivities(
  attempt: WebSearchAttempt,
  attemptIndex: number,
  topLevel: WebSearchProcessStep[]
): WebSearchProcessStep[] {
  const children = activityPairs(attempt.invocationEvents).map((pair) => {
    const anchorEvent = pair.started ?? pair.completed!
    const parent = [...topLevel].reverse().find((step) => (
      (step.startedSequence ?? BEFORE_FIRST_EVENT_SEQUENCE) <= anchorEvent.seq
      && (step.completedSequence === undefined || anchorEvent.seq < step.completedSequence)
    )) ?? topLevel[0]
    return parent ? childStep(attempt, attemptIndex, pair, parent.id) : null
  }).filter((step): step is WebSearchProcessStep => step !== null)

  return topLevel.flatMap((step) => [
    step,
    ...children
      .filter((child) => child.parentId === step.id)
      .sort((left, right) => (left.startedAt ?? left.completedAt ?? 0) - (right.startedAt ?? right.completedAt ?? 0))
  ])
}

function routeStep(
  index: number,
  startedAt: number,
  completedAt: number | undefined,
  status: WebSearchProcessStatus,
  detail = ROUTE_ACTIVITY_DETAIL,
  title = ROUTE_ACTIVITY_TITLE
): WebSearchProcessStep {
  return {
    id: `route:${index}`,
    depth: 0,
    title,
    detail,
    meta: PRODUCT_ACTIVITY_META,
    source: 'router',
    status,
    startedAt,
    completedAt,
    countsTowardTotal: true,
    startedSequence: BEFORE_FIRST_EVENT_SEQUENCE
  }
}

/** Build a dynamic Agent activity timeline while retaining product-owned route boundaries. */
export function webSearchProcessSteps(
  search: ResourceWebSearch,
  now: number
): WebSearchProcessStep[] {
  const terminal = TERMINAL_ATTEMPT_STATUSES.has(search.status)
  const effectiveCompletedAt = terminal ? search.completedAt ?? now : now
  const steps: WebSearchProcessStep[] = []
  let cursor = search.startedAt
  let routeIndex = 0

  if (search.attempts.length === 0) {
    return [routeStep(
      routeIndex,
      search.startedAt,
      terminal ? effectiveCompletedAt : undefined,
      terminalStatus(search.status)
    )]
  }

  for (const [attemptIndex, attempt] of search.attempts.entries()) {
    if (attempt.startedAt > cursor) {
      steps.push(routeStep(routeIndex, cursor, attempt.startedAt, 'done'))
      routeIndex += 1
    }
    const attemptCompletedAt = attempt.completedAt ?? effectiveCompletedAt
    const topLevel = topLevelSteps(attempt, attemptIndex, attemptCompletedAt)
    steps.push(...withChildActivities(attempt, attemptIndex, topLevel))
    cursor = Math.max(cursor, attemptCompletedAt)
  }

  if (effectiveCompletedAt > cursor) {
    const trailingDuration = effectiveCompletedAt - cursor
    let lastTopLevelIndex = -1
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      if (steps[index]?.countsTowardTotal) {
        lastTopLevelIndex = index
        break
      }
    }
    if (trailingDuration < PRODUCT_PHASE_MERGE_THRESHOLD_MS && lastTopLevelIndex >= 0) {
      steps[lastTopLevelIndex] = {
        ...steps[lastTopLevelIndex],
        completedAt: terminal ? effectiveCompletedAt : undefined
      }
    } else {
      const finalStatus = terminal ? terminalStatus(search.status) : 'running'
      const previousError = search.attempts.at(-1)?.error
      steps.push(routeStep(
        routeIndex,
        cursor,
        terminal ? effectiveCompletedAt : undefined,
        finalStatus,
        previousError || RESULT_ACTIVITY_DETAIL,
        RESULT_ACTIVITY_TITLE
      ))
    }
  }
  return steps
}

/** Sum only sequential top-level phases; nested runtime activities are intentionally excluded. */
export function webSearchAccountedDuration(
  steps: readonly WebSearchProcessStep[],
  now: number
): number {
  return steps.reduce((total, step) => {
    if (!step.countsTowardTotal || step.startedAt === undefined) return total
    return total + Math.max(0, (step.completedAt ?? now) - step.startedAt)
  }, 0)
}
