import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInvocationEvent } from '../../contracts/invocation.ts'
import {
  webSearchAccountedDuration,
  webSearchProcessSteps
} from './activity.ts'
import {
  BROWSER_SEARCH_MODE,
  WEB_SEARCH_CANDIDATES_MODE,
  type ResourceWebSearch,
  type WebSearchAttempt
} from './state.ts'

const SEARCH_STARTED_AT = 1_000
const SEARCH_COMPLETED_AT = 7_000

function invocationEvent(
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
  itemId = ''
): AgentInvocationEvent {
  return {
    schema_version: 1,
    invocation_id: 'invocation-1',
    seq,
    type,
    turn_id: 'turn-1',
    item_id: itemId,
    data,
    created_at: seq
  }
}

function planEvent(
  seq: number,
  current: string | null,
  explanation = ''
): AgentInvocationEvent {
  return invocationEvent(seq, 'plan.updated', {
    explanation,
    todos: current
      ? [{ content: current, status: 'in_progress' }]
      : [{ content: '完成搜索', status: 'completed' }]
  })
}

function attempt(
  invocationEvents: AgentInvocationEvent[],
  eventObservedAt: Record<number, number>,
  patch: Partial<WebSearchAttempt> = {}
): WebSearchAttempt {
  return {
    mode: WEB_SEARCH_CANDIDATES_MODE,
    startedAt: SEARCH_STARTED_AT,
    completedAt: SEARCH_COMPLETED_AT,
    invocationId: 'invocation-1',
    invocationEvents,
    eventObservedAt,
    status: 'completed',
    ...patch
  }
}

function search(webSearchAttempt: WebSearchAttempt): ResourceWebSearch {
  return {
    tabId: 'web-search:test',
    query: '黎曼猜想',
    startedAt: SEARCH_STARTED_AT,
    completedAt: SEARCH_COMPLETED_AT,
    attempts: [webSearchAttempt],
    resolvedMode: WEB_SEARCH_CANDIDATES_MODE,
    status: 'completed',
    selectedUrls: [],
    importing: false,
    importResults: {},
    notified: []
  }
}

test('search process uses Agent-reported stages and nests runtime evidence', () => {
  const events = [
    invocationEvent(1, 'invocation.started'),
    planEvent(2, '制定检索策略', '先判断查询需要哪些来源'),
    planEvent(3, '检索权威来源'),
    invocationEvent(4, 'web_search.started', { query: '黎曼猜想' }, 'search-1'),
    invocationEvent(
      5,
      'web_search.completed',
      { query: '黎曼猜想', result_count: 37 },
      'search-1'
    ),
    planEvent(6, '筛选可靠候选'),
    planEvent(7, null),
    invocationEvent(8, 'result.completed')
  ]
  const observedAt = {
    1: 1_100,
    2: 1_500,
    3: 2_500,
    4: 3_000,
    5: 4_500,
    6: 5_000,
    7: 6_500,
    8: 6_950
  }
  const steps = webSearchProcessSteps(search(attempt(events, observedAt)), SEARCH_COMPLETED_AT)
  const topLevel = steps.filter((step) => step.countsTowardTotal)
  const runtime = steps.filter((step) => step.source === 'runtime')

  assert.deepEqual(topLevel.map((step) => step.title), [
    'Agent 内部处理',
    '制定检索策略',
    '检索权威来源',
    '筛选可靠候选',
    'Agent 内部处理'
  ])
  assert.equal(topLevel.some((step) => step.title === '整理候选网页'), false)
  assert.equal(topLevel[1]?.detail, '先判断查询需要哪些来源')
  assert.equal(webSearchAccountedDuration(steps, SEARCH_COMPLETED_AT), 6_000)
  assert.deepEqual(runtime.map((step) => [
    step.title,
    step.depth,
    step.parentId,
    step.startedAt,
    step.completedAt,
    step.meta
  ]), [[
    'Web Search',
    1,
    topLevel[2]?.id,
    4_000,
    5_000,
    '返回 37 条原始结果'
  ]])
})

test('repeated plan snapshots keep one current stage running', () => {
  const events = [
    planEvent(1, '动态检索阶段'),
    planEvent(2, '动态检索阶段', '仍在处理同一个目标')
  ]
  const runningAttempt = attempt(events, { 1: 1_500, 2: 2_000 }, {
    completedAt: undefined,
    status: 'running'
  })
  const runningSearch = {
    ...search(runningAttempt),
    completedAt: undefined,
    status: 'running' as const,
    resolvedMode: undefined
  }
  const steps = webSearchProcessSteps(runningSearch, 4_000)

  assert.deepEqual(steps.map((step) => [step.title, step.status]), [
    ['Agent 内部处理', 'done'],
    ['动态检索阶段', 'running']
  ])
  assert.equal(steps[1]?.detail, '仍在处理同一个目标')
  assert.equal(webSearchAccountedDuration(steps, 4_000), 3_000)
})

test('a new current stage after a completed plan is retained as a real replan', () => {
  const events = [
    planEvent(1, '初步搜索'),
    planEvent(2, null),
    planEvent(3, '补充验证'),
    planEvent(4, null)
  ]
  const steps = webSearchProcessSteps(search(attempt(events, {
    1: 1_500,
    2: 3_000,
    3: 4_000,
    4: 6_000
  })), SEARCH_COMPLETED_AT)

  assert.deepEqual(steps.filter((step) => step.source === 'agent').map((step) => step.title), [
    '初步搜索',
    '补充验证'
  ])
  assert.equal(webSearchAccountedDuration(steps, SEARCH_COMPLETED_AT), 6_000)
})

test('fallback attempts and routing gaps partition the complete product wall clock', () => {
  const nativeAttempt = attempt([planEvent(1, '尝试原生搜索')], { 1: 1_500 }, {
    startedAt: 1_200,
    completedAt: 5_000,
    status: 'failed',
    error: '原生搜索没有返回可验证结果'
  })
  const browserAttempt = attempt([], {}, {
    mode: BROWSER_SEARCH_MODE,
    startedAt: 5_500,
    completedAt: 11_000
  })
  const fallbackSearch: ResourceWebSearch = {
    ...search(browserAttempt),
    completedAt: 12_000,
    attempts: [nativeAttempt, browserAttempt],
    resolvedMode: BROWSER_SEARCH_MODE
  }
  const steps = webSearchProcessSteps(fallbackSearch, 12_000)

  assert.equal(steps.some((step) => step.title === '搜索调度'), true)
  assert.equal(steps.some((step) => step.meta?.startsWith('Web Search')), true)
  assert.equal(steps.some((step) => step.meta?.startsWith('浏览器')), true)
  assert.equal(webSearchAccountedDuration(steps, 12_000), 11_000)
})

test('overlapping and anonymous tool lifecycles pair once by runtime event order', () => {
  const events = [
    planEvent(1, '执行检索'),
    invocationEvent(2, 'tool.started', { title: '工具 A' }, 'tool-a'),
    invocationEvent(3, 'tool.started', { title: '工具 B' }, 'tool-b'),
    invocationEvent(4, 'tool.completed', { title: '工具 B' }, 'tool-b'),
    invocationEvent(5, 'tool.completed', { title: '工具 A' }, 'tool-a'),
    invocationEvent(6, 'tool.started', { title: '匿名工具' }),
    invocationEvent(7, 'tool.completed', { title: '匿名工具' })
  ]
  const steps = webSearchProcessSteps(search(attempt(events, { 1: 1_200 })), SEARCH_COMPLETED_AT)
  const runtime = steps.filter((step) => step.source === 'runtime')

  assert.deepEqual(runtime.map((step) => [
    step.title,
    step.status,
    step.startedAt,
    step.completedAt
  ]), [
    ['工具 A', 'done', 2_000, 5_000],
    ['工具 B', 'done', 3_000, 4_000],
    ['匿名工具', 'done', 6_000, 7_000]
  ])
})

test('missing Agent plan is reported as unclassified activity without invented stages', () => {
  const steps = webSearchProcessSteps(search(attempt([
    invocationEvent(1, 'invocation.started'),
    invocationEvent(2, 'result.completed')
  ], { 1: 1_100, 2: 6_900 })), SEARCH_COMPLETED_AT)

  assert.deepEqual(steps.map((step) => [step.title, step.source, step.status]), [[
    'Agent 内部处理',
    'unreported',
    'done'
  ]])
  assert.equal(webSearchAccountedDuration(steps, SEARCH_COMPLETED_AT), 6_000)
})
