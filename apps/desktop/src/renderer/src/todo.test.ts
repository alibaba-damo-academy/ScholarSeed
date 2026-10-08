import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { ConvItem, Thread, TurnOutcome } from './model.ts'
import { displayTodos, isLatestUserTurn, planElapsedMilliseconds, projectPlanSnapshots, stepElapsedMilliseconds, todoProgress, todoProgressLabel, todoSummary } from './todo.ts'
import { projectActivityEvents } from './transcript.ts'
import { hilEventResolution, projectHilCard } from './hil.ts'
import type { ProductEvent } from './api.ts'

const TODO_PANEL_SOURCE = readFileSync(new URL('./components/business/TodoPanel.tsx', import.meta.url), 'utf8')
const AI_PANEL_SOURCE = readFileSync(new URL('./features/assistant/AiPanel.tsx', import.meta.url), 'utf8')
const TASK_MONITOR_SOURCE = readFileSync(new URL('./components/business/TaskMonitor.tsx', import.meta.url), 'utf8')

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: 'session-1', title: 'Session', conversation: [], sessionId: 'session-1', lastSeq: 0,
    todoTurnId: 'plan-turn',
    todos: [
      { content: 'read files', status: 'completed' },
      { content: 'compare', status: 'in_progress' },
      { content: 'report', status: 'pending' }
    ],
    turnOutcomes: { 'plan-turn': 'running' },
    ...patch
  }
}

function statuses(value: Thread): string[] {
  return displayTodos(value).map((item) => item.status)
}

function timedPlan(conversation: ConvItem[], completedAt?: number): Thread {
  return thread({ conversation, turnTimings: { 'plan-turn': { startedAt: 1_000, completedAt } } })
}

function planEvent(seq: number, ts: number, status: 'pending' | 'in_progress' | 'completed', turnId = 'plan-turn', planId = 'plan'): ProductEvent {
  return {
    v: 2, session_id: 'session-1', turn_id: turnId, seq, ts, type: 'plan_snapshot',
    data: { items: [{ id: 'step', content: 'read files', status }], plan: { source: 'structured', plan_id: planId, revision: seq } }
  }
}

test('plan and step clocks retain distinct starts, pause for HIL and freeze at completion', () => {
  const value = timedPlan([wait('confirmation', 4_000, 7_000)])
  value.planSnapshots = projectPlanSnapshots([planEvent(1, 2, 'pending'), planEvent(2, 3, 'in_progress')])
  const item = { id: 'step', content: 'read files', status: 'running' as const }
  assert.equal(planElapsedMilliseconds(value, 'plan-turn', 9_000), 5_000)
  assert.equal(stepElapsedMilliseconds(value, item, 9_000), 3_000)
  value.planSnapshots = projectPlanSnapshots([planEvent(3, 10, 'completed')], value.planSnapshots)
  assert.equal(planElapsedMilliseconds(value, 'plan-turn', 90_000), 6_000)
  assert.equal(stepElapsedMilliseconds(value, item, 90_000), 4_000)
})

test('same plan accumulates across turns without counting time between turns or double counting replay', () => {
  const value = timedPlan([], 6_000)
  value.todoTurnId = 'next-turn'
  value.turnTimings!['next-turn'] = { startedAt: 20_000 }
  value.turnOutcomes = { 'plan-turn': 'interrupted', 'next-turn': 'running' }
  const events = [planEvent(1, 2, 'in_progress'), planEvent(2, 21, 'in_progress', 'next-turn')]
  value.planSnapshots = projectPlanSnapshots(events)
  const item = { id: 'step', content: 'read files', status: 'running' as const }
  assert.equal(planElapsedMilliseconds(value, 'next-turn', 25_000), 10_000)
  assert.equal(stepElapsedMilliseconds(value, item, 25_000), 8_000)
  value.planSnapshots = projectPlanSnapshots([...events].reverse(), value.planSnapshots)
  assert.equal(value.planSnapshots.length, 2)
  assert.equal(planElapsedMilliseconds(value, 'next-turn', 25_000), 10_000)
  value.planSnapshots = projectPlanSnapshots([planEvent(3, 26, 'in_progress', 'next-turn', 'replacement')], value.planSnapshots)
  assert.equal(planElapsedMilliseconds(value, 'next-turn', 30_000), 4_000)
  assert.equal(stepElapsedMilliseconds(value, item, 30_000), 4_000)
})

test('unknown step clocks remain unknown and parent and child durations are not added to the total', () => {
  const value = timedPlan([])
  const event = planEvent(1, 2, 'in_progress')
  if (event.type !== 'plan_snapshot') throw new Error('Expected plan snapshot')
  event.data.items.push({ id: 'child', parent_id: 'step', content: 'child', status: 'in_progress' })
  value.planSnapshots = projectPlanSnapshots([event])
  assert.equal(planElapsedMilliseconds(value, 'plan-turn', 10_000), 9_000)
  assert.equal(stepElapsedMilliseconds(value, { id: 'child', content: 'child', status: 'running' }, 10_000), 8_000)
  assert.equal(stepElapsedMilliseconds(value, { id: 'unknown', content: 'unknown', status: 'todo' }, 10_000), null)
})

function wait(requestId: string, requestedAt: number, resolvedAt?: number, hilKind = 'permission'): ConvItem {
  return { kind: 'hil', requestId, requestedAt, resolvedAt, hilKind, turnId: 'plan-turn' }
}

test('plan elapsed excludes every kind of user interaction and resumes after each wait', () => {
  for (const kind of ['permission', 'question', 'elicitation', 'confirmation']) {
    const pending = timedPlan([wait('request', 3_000, undefined, kind)])
    assert.equal(planElapsedMilliseconds(pending, 'plan-turn', 4_000), 2_000)
    assert.equal(planElapsedMilliseconds(pending, 'plan-turn', 60_000), 2_000)
    const resumed = timedPlan([wait('request', 3_000, 8_000, kind)])
    assert.equal(planElapsedMilliseconds(resumed, 'plan-turn', 10_000), 4_000)
  }
})

test('overlapping, repeated and sequential waits are subtracted as a union', () => {
  const current = timedPlan([
    wait('second', 4_000, 8_000), wait('first', 2_000, 6_000),
    wait('first', 2_000, 6_000), wait('third', 9_000, 10_000)
  ])
  const before = structuredClone(current)
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 12_000), 4_000)
  assert.deepEqual(current, before)
  current.conversation.push(wait('pending', 7_000))
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 20_000), 1_000)
})

test('terminal plans clip waits to their lifetime and retain their final elapsed time', () => {
  const current = timedPlan([wait('early', 0, 2_000), wait('open', 4_000)], 8_000)
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 10_000), 2_000)
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 50_000), 2_000)
  current.conversation[1] = wait('open', 4_000, 20_000)
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 50_000), 2_000)
})

test('plan elapsed ignores other turns and missing evidence without inventing waits', () => {
  const current = timedPlan([
    { ...wait('other', 2_000), turnId: 'other-turn' },
    { kind: 'hil', requestId: 'no-clock', hilKind: 'question', turnId: 'plan-turn' },
    wait('future', 20_000), wait('invalid', 8_000, 6_000)
  ])
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 10_000), 9_000)
  assert.equal(planElapsedMilliseconds(current, 'missing', 10_000), null)
  assert.equal(planElapsedMilliseconds(current, undefined, 10_000), null)
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 0), 0)
})

test('live and repeated history recovery retain the same waiting time for every resolution', () => {
  for (const state of ['resolved', 'cancelled', 'stale', 'unknown'] as const) {
    const request = { request_id: 'request', kind: 'question' }
    const events: ProductEvent[] = [
      { v: 2, session_id: 'session', turn_id: 'plan-turn', seq: 1, ts: 3, type: 'hil_requested', data: request },
      { v: 2, session_id: 'session', seq: 2, ts: 9, type: 'hil_resolved', data: { ...request, state, resolved_at: 8 } }
    ]
    const live = timedPlan([{
      ...projectHilCard(request, 3, 'plan-turn'),
      ...hilEventResolution(undefined, state, 8),
      hilState: state
    }])
    const recovered = timedPlan(projectActivityEvents([], events))
    assert.equal(planElapsedMilliseconds(live, 'plan-turn', 12_000), 6_000)
    assert.equal(planElapsedMilliseconds(recovered, 'plan-turn', 12_000), 6_000)
    recovered.conversation = projectActivityEvents(recovered.conversation, [...events, ...events])
    assert.equal(planElapsedMilliseconds(recovered, 'plan-turn', 12_000), 6_000)
  }
})

test('history repairs a recovered request clock and uses event time for legacy resolutions', () => {
  const request = { request_id: 'request', kind: 'permission' }
  const pending: ProductEvent = {
    v: 2, session_id: 'session', turn_id: 'plan-turn', seq: 1, ts: 3, type: 'hil_requested', data: request
  }
  const recovered = timedPlan(projectActivityEvents([projectHilCard(request, 8, 'plan-turn')], [pending]))
  assert.equal(planElapsedMilliseconds(recovered, 'plan-turn', 12_000), 2_000)
  recovered.conversation = projectActivityEvents(recovered.conversation, [pending, {
    v: 2, session_id: 'session', seq: 2, ts: 9, type: 'hil_resolved', data: { ...request, state: 'cancelled' }
  }])
  assert.equal(planElapsedMilliseconds(recovered, 'plan-turn', 12_000), 5_000)
})

test('local submission state cannot resume the plan clock before durable resolution', () => {
  for (const hilState of ['submitting', 'failed', 'resolved'] as const) {
    const current = timedPlan([{ ...wait('request', 3_000), hilState } as ConvItem])
    assert.equal(planElapsedMilliseconds(current, 'plan-turn', 12_000), 2_000)
  }
})

test('a late stale resolution cannot move the waiting boundary past the turn terminal', () => {
  const current = timedPlan([wait('request', 3_000)], 8_000)
  current.conversation = projectActivityEvents(current.conversation, [{
    v: 2, session_id: 'session', seq: 2, ts: 20, type: 'hil_resolved',
    data: { request_id: 'request', kind: 'permission', state: 'stale' }
  }])
  assert.equal(planElapsedMilliseconds(current, 'plan-turn', 30_000), 2_000)
})

test('progress labels distinguish actual step ordinals from completed counts', () => {
  const label = (value: Thread) => todoProgressLabel(displayTodos(value))
  const first = thread({ todos: Array.from({ length: 7 }, (_, index) => ({
    content: `step ${index + 1}`, status: index === 0 ? 'in_progress' : 'pending'
  })) })
  assert.equal(label(first), '1 / 7')
  assert.equal(label(thread()), '2 / 3')
  const skipped = thread({ todos: [
    { content: 'pending', status: 'pending' },
    { content: 'active', status: 'in_progress' }
  ] })
  assert.equal(label(skipped), '2 / 2')
  assert.equal(label(thread({ todos: first.todos!.map((item) => ({ ...item, status: 'pending' })) })), '0 / 7')
  assert.equal(label(thread({ todos: first.todos!.map((item) => ({ ...item, status: 'completed' })) })), '7 / 7')
  assert.equal(label(thread({ todos: [
    { content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }
  ] })), '2 / 2')
  for (const outcome of ['interrupted', 'failed', 'completed'] as const) {
    assert.equal(label(thread({ turnOutcomes: { 'plan-turn': outcome } })), '2 / 3')
  }
  assert.equal(label(thread({ todos: [{ content: 'approval', status: 'needs_confirmation' }] })), '1 / 1')
  assert.equal(label(thread({ todos: [
    { content: 'done', status: 'completed' },
    { content: 'partial', status: 'partial' },
    { content: 'blocked', status: 'blocked' },
    { content: 'failed', status: 'failed' }
  ] })), '4 / 4')
})

test('uses real steps for progress and never promotes a pending step', () => {
  const value = thread()
  assert.deepEqual(statuses(value), ['done', 'running', 'todo'])
  assert.deepEqual(todoProgress(displayTodos(value)), { done: 1, total: 3 })
  assert.deepEqual(todoSummary(value, displayTodos(value)), { label: 'compare', status: 'running' })
  const pending = thread({ todos: [{ content: 'not started', status: 'pending' }] })
  assert.deepEqual(statuses(pending), ['todo'])
  assert.equal(todoSummary(pending, displayTodos(pending)).messageKey, 'todo.summary.waiting')
})

test('uses only HIL owned by the plan turn, including submitting requests', () => {
  for (const hilState of ['pending', 'submitting', 'cancelled', 'failed'] as const) {
    for (const turnId of ['plan-turn', 'older-turn', 'later-turn', undefined]) {
      const value = thread({ conversation: [{ kind: 'hil', requestId: 'hil', hilKind: 'permission', hilState, turnId }] })
      const expected = turnId === 'plan-turn' && hilState !== 'cancelled' ? 'need' : 'running'
      assert.deepEqual(statuses(value), ['done', expected, 'todo'], `${turnId}/${hilState}`)
    }
  }
})

test('shows a resolved confirmation as applying until the next plan snapshot', () => {
  const value = thread({
    todos: [{ content: 'choose format', status: 'needs_confirmation' }],
    conversation: [{
      kind: 'hil', requestId: 'answered', hilKind: 'question', hilState: 'resolved',
      resolved: 'Markdown', turnId: 'plan-turn'
    }]
  })
  const items = displayTodos(value)
  assert.equal(items[0].status, 'running')
  assert.equal(items[0].applyingConfirmation, true)
  assert.deepEqual(todoSummary(value, items), {
    messageKey: 'todo.summary.applying', status: 'running'
  })
})

test('terminal outcome stops active and confirmation steps without inventing completion', () => {
  const expected: Partial<Record<TurnOutcome, string>> = { completed: 'stopped', interrupted: 'stopped', failed: 'failed' }
  for (const [outcome, status] of Object.entries(expected)) {
    const value = thread({
      turnOutcomes: { 'plan-turn': outcome as TurnOutcome },
      todos: [...thread().todos!, { content: 'approve', status: 'needs_confirmation' }],
      conversation: [{ kind: 'hil', requestId: 'stale-hil', hilKind: 'permission', hilState: 'pending', turnId: 'plan-turn' }]
    })
    assert.deepEqual(statuses(value), ['done', status, 'todo', status])
    assert.deepEqual(todoProgress(displayTodos(value)), { done: 1, total: 4 })
    assert.equal(todoSummary(value, displayTodos(value)).status, status)
  }
})

test('later questions, retries and uncorrelated approvals never take ownership of an old plan', () => {
  const value = thread({
    turnOutcomes: { 'plan-turn': 'interrupted', 'unrelated': 'running', 'retry': 'running' },
    conversation: [
      { kind: 'user', text: 'start', turnId: 'plan-turn' },
      { kind: 'user', text: 'another question', turnId: 'unrelated' },
      { kind: 'user', text: 'continue', turnId: 'retry' },
      { kind: 'hil', requestId: 'retry-hil', hilKind: 'permission', hilState: 'pending', turnId: 'retry' },
      { kind: 'hil', requestId: 'unknown-hil', hilKind: 'permission', hilState: 'cancelled' }
    ]
  })
  assert.deepEqual(statuses(value), ['done', 'stopped', 'todo'])
  assert.equal(todoSummary(value, displayTodos(value)).messageKey, 'todo.summary.interrupted')
  const replanned = { ...value, todoTurnId: 'retry', todos: [{ content: 'new plan', status: 'in_progress' as const }] }
  assert.deepEqual(statuses(replanned), ['need'])
})

test('the composer hides a previous plan only after the next user turn starts', () => {
  const completed = thread({
    conversation: [{ kind: 'user', text: 'original task', turnId: 'plan-turn' }],
    todos: [{ content: 'finish', status: 'completed' }],
    turnOutcomes: { 'plan-turn': 'completed' },
    running: false,
    status: 'done'
  })
  assert.equal(isLatestUserTurn(completed, completed.todoTurnId), true)

  const queued = {
    ...completed,
    conversation: [...completed.conversation, { kind: 'user' as const, text: 'queued task', itemId: 'queued-message' }]
  }
  assert.equal(isLatestUserTurn(queued, queued.todoTurnId), true)

  const nextTurn = {
    ...queued,
    conversation: [...queued.conversation, { kind: 'user' as const, text: 'next task', turnId: 'next-turn' }]
  }
  assert.equal(isLatestUserTurn(nextTurn, nextTurn.todoTurnId), false)
  assert.equal(isLatestUserTurn(nextTurn, 'next-turn'), true)
})

test('session-level termination stops a plan whose todoTurnId still reads as running', () => {
  // A released bridge plan keeps `todoTurnId` on a historical turn whose outcome
  // is still `running`; without the session-level short-circuit the panel would
  // spin forever after an interrupt.
  const running = thread({ turnOutcomes: { 'plan-turn': 'running' }, running: true, status: 'running' })
  assert.equal(statuses(running)[1], 'running')
  const interrupted = { ...running, running: false, status: 'abandon' as const }
  assert.equal(statuses(interrupted)[1], 'stopped')
  const closed = { ...running, running: false, status: 'done' as const }
  assert.equal(statuses(closed)[1], 'stopped')
  const failed = { ...running, running: false, status: 'failed' as const }
  assert.equal(statuses(failed)[1], 'stopped')
})

test('snapshot replacement supports a single step, completed retention and empty removal', () => {
  const single = thread({ todos: [{ content: 'one step', status: 'in_progress' }] })
  assert.deepEqual(todoProgress(displayTodos(single)), { done: 0, total: 1 })
  const completed = { ...single, todos: [{ content: 'one step', status: 'completed' as const }] }
  assert.deepEqual(todoSummary(completed, displayTodos(completed)), { messageKey: 'todo.summary.allDone', status: 'done' })
  assert.deepEqual(displayTodos({ ...completed, todos: [] }), [])
  assert.deepEqual(todoProgress(displayTodos({ ...completed, todos: [] })), { done: 0, total: 0 })
})

test('restored plans need owner execution evidence and never inherit a different session', () => {
  const persisted = thread({ turnOutcomes: { 'plan-turn': 'completed' } })
  const restored = JSON.parse(JSON.stringify(persisted)) as Thread
  assert.deepEqual(statuses(restored), ['done', 'stopped', 'todo'])
  assert.equal(todoSummary(restored, displayTodos(restored)).messageKey, 'todo.summary.ended')
  const unknown = thread({ turnOutcomes: undefined })
  assert.deepEqual(statuses(unknown), ['done', 'stopped', 'todo'])
  assert.deepEqual(displayTodos(thread({ sessionId: 'session-2', todos: [], todoTurnId: null })), [])
})

test('does not mutate authoritative snapshot facts', () => {
  const value = thread({ turnOutcomes: { 'plan-turn': 'failed' } })
  const original = structuredClone(value)
  displayTodos(value)
  todoSummary(value, displayTodos(value))
  assert.deepEqual(value, original)
})

test('a denied tool does not poison later replanning within the same turn', () => {
  const value = thread({ conversation: [{ kind: 'hil', requestId: 'old-denial', hilKind: 'permission', hilState: 'cancelled', turnId: 'plan-turn' }] })
  assert.equal(displayTodos(value)[1].status, 'running')
  assert.equal(todoSummary(value, displayTodos(value)).label, 'compare')
})

test('collapsed summaries do not treat plan intent as a confirmation request', () => {
  for (const [status, expected] of [['needs_confirmation', 'unrequested'], ['failed', 'failed']] as const) {
    const value = thread({ todos: [{ content: 'explicit state', status }] })
    assert.equal(todoSummary(value, displayTodos(value)).status, expected)
  }
})

test('unrequested confirmation preserves reached progress and authoritative plan facts', () => {
  const value = thread({ todos: [{ id: 'approval', content: 'approve', status: 'needs_confirmation', dependsOn: ['prepare'] }] })
  const original = structuredClone(value)
  const items = displayTodos(value)
  assert.equal(items[0].status, 'unrequested')
  assert.equal(todoProgressLabel(items), '1 / 1')
  assert.deepEqual(todoProgress(items), { done: 0, total: 1 })
  assert.deepEqual(todoSummary(value, items), { messageKey: 'todo.summary.unrequested', status: 'unrequested' })
  assert.deepEqual(value, original)
})

test('confirmation submission failures remain actionable even after an earlier resolution', () => {
  for (const hilState of ['pending', 'submitting', 'failed', undefined] as const) {
    const value = thread({ todos: [{ content: 'approve', status: 'needs_confirmation' }], conversation: [
      { kind: 'hil', requestId: 'old', hilKind: 'question', hilState: 'resolved', turnId: 'plan-turn' },
      { kind: 'hil', requestId: 'current', hilKind: 'question', hilState, turnId: 'plan-turn' }
    ] })
    const items = displayTodos(value)
    assert.equal(items[0].status, 'need')
    assert.equal(items[0].applyingConfirmation, false)
    assert.deepEqual(todoSummary(value, items), { messageKey: 'todo.summary.need', status: 'need' })
  }
})

test('terminal confirmation requests wait for a plan update without claiming no request or requiring action', () => {
  for (const hilState of ['stale', 'unknown'] as const) {
    const value = thread({ todos: [{ content: 'approve', status: 'needs_confirmation' }], conversation: [
      { kind: 'hil', requestId: 'current', hilKind: 'question', hilState, turnId: 'plan-turn' }
    ] })
    const items = displayTodos(value)
    assert.equal(items[0].status, 'running')
    assert.equal(items[0].applyingConfirmation, false)
    assert.equal(todoProgressLabel(items), '1 / 1')
    assert.deepEqual(todoSummary(value, items), { messageKey: 'todo.summary.waiting', status: 'running' })
  }
})

test('blocked parent remains the summary until a real confirmation request arrives', () => {
  const value = thread({ todos: [
    { id: 'setup', content: 'setup', status: 'completed' },
    { id: 'search', content: 'search', status: 'blocked' },
    { id: 'worker', parent_id: 'search', content: 'worker failed', status: 'blocked' },
    { id: 'diagnosis', parent_id: 'search', content: 'diagnosed', status: 'completed' },
    { id: 'approval', parent_id: 'search', content: 'approve recovery', status: 'needs_confirmation' },
    { id: 'review', content: 'review', status: 'pending' },
    { id: 'download', content: 'download', status: 'pending' },
    { id: 'verify', content: 'verify', status: 'pending' }
  ] })
  const items = displayTodos(value)
  assert.equal(items[1].children?.[2].status, 'unrequested')
  assert.equal(todoProgressLabel(items), '2 / 5')
  assert.deepEqual(todoSummary(value, items), { messageKey: 'todo.summary.blocked', status: 'blocked' })
  for (const hilState of ['pending', 'submitting'] as const) {
    const requested = { ...value, conversation: [{
      kind: 'hil' as const, requestId: 'approval', hilKind: 'question', hilState, turnId: 'plan-turn'
    }] }
    const requestedItems = displayTodos(requested)
    assert.equal(requestedItems[1].children?.[2].status, 'need')
    assert.equal(todoProgressLabel(requestedItems), '2 / 5')
    assert.deepEqual(todoSummary(requested, requestedItems), { messageKey: 'todo.summary.need', status: 'need' })
  }
})

test('unrequested confirmation does not override active work or borrow another turn request', () => {
  const value = thread({ todos: [
    { content: 'working', status: 'in_progress' },
    { content: 'approval', status: 'needs_confirmation' }
  ], conversation: [{
    kind: 'hil', requestId: 'unrelated', hilKind: 'question', hilState: 'pending', turnId: 'other-turn'
  }] })
  assert.deepEqual(statuses(value), ['running', 'unrequested'])
  assert.deepEqual(todoSummary(value, displayTodos(value)), { label: 'working', status: 'running' })
})

test('explicit child plans never change the main-stage denominator', () => {
  const roots = Array.from({ length: 8 }, (_, index) => ({
    id: `root-${index}`, content: `stage ${index}`, status: index === 0 ? 'in_progress' as const : 'pending' as const
  }))
  const children = Array.from({ length: 17 }, (_, index) => ({
    id: `child-${index}`, parent_id: 'root-0', content: `detail ${index}`,
    status: index === 0 ? 'completed' as const : 'in_progress' as const
  }))
  const current = thread({ todos: [...roots, ...children] })
  const items = displayTodos(current)
  assert.deepEqual(todoProgress(items), { done: 0, total: 8 })
  assert.deepEqual(todoProgress(items[0].children!), { done: 1, total: 17 })
  assert.equal(todoProgressLabel(items), '1 / 8')
  assert.equal(items[0].children?.[1].status, 'running')
  const stopped = displayTodos({ ...current, turnOutcomes: { 'plan-turn': 'interrupted' } })
  assert.equal(stopped[0].status, 'stopped')
  assert.equal(stopped[0].children?.[0].status, 'done')
  assert.equal(stopped[0].children?.[1].status, 'stopped')
})

test('titles and dependency edges do not fabricate child plans', () => {
  const items = displayTodos(thread({ todos: [
    { id: 'one', content: '正文', status: 'in_progress' },
    { id: 'two', content: '正文', status: 'pending', dependsOn: ['one'] }
  ] }))
  assert.equal(items.length, 2)
  assert.equal(items[0].children, undefined)
})

test('child failures appear in summary without altering parent progress', () => {
  const current = thread({ todos: [
    { id: 'phase', content: '正文', status: 'in_progress' },
    { id: 'chapter', parent_id: 'phase', content: '章节', status: 'failed' }
  ] })
  const items = displayTodos(current)
  assert.deepEqual(todoProgress(items), { done: 0, total: 1 })
  assert.equal(items[0].status, 'running')
  assert.deepEqual(todoSummary(current, items), { label: '正文', status: 'running', issueCount: 1 })
})

test('uses the deepest active child and reserves partial wording for terminal plans', () => {
  const running = thread({ todos: [
    { id: 'phase', content: '正文', activeForm: '生成正文', status: 'in_progress' },
    { id: 'section', parent_id: 'phase', content: '第四节', activeForm: '生成第四节', status: 'in_progress' },
    { id: 'table', parent_id: 'phase', content: '对比表', status: 'partial' }
  ] })
  assert.deepEqual(todoSummary(running, displayTodos(running)), {
    label: '生成第四节', status: 'running', issueCount: 1
  })

  const completed = { ...running, turnOutcomes: { 'plan-turn': 'completed' as const } }
  assert.deepEqual(todoSummary(completed, displayTodos(completed)), {
    messageKey: 'todo.summary.completedPartial', status: 'partial', issueCount: 1
  })
})

test('collapsed plan summary truncates through the shared ellipsis tooltip component', () => {
  assert.match(TODO_PANEL_SOURCE, /<EllipsisText[\s\S]*data-testid="todo-current"[\s\S]*tooltipPortalled/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /data-testid="todo-current"[\s\S]*title=\{summaryLabel\}/)
})

test('plan header preserves elapsed time and result hints before optional details', () => {
  assert.doesNotMatch(TODO_PANEL_SOURCE, /elapsedHidden|elapsedNeedRef|setElapsedTipOpen/)
  assert.match(TODO_PANEL_SOURCE, /const observer = new ResizeObserver\(update\)/)
  assert.match(TODO_PANEL_SOURCE, /setHeaderWidth\(button\.clientWidth\)/)
  assert.match(TODO_PANEL_SOURCE, /summary.status !== 'done' && Boolean\(stepLabel\) && headerWidth >= PLAN_DETAIL_MIN_WIDTH/)
  assert.match(TODO_PANEL_SOURCE, /estimateLabel && headerWidth >= PLAN_ESTIMATE_MIN_WIDTH/)
  assert.match(TODO_PANEL_SOURCE, /summary.status !== 'running' && summary.status !== 'done'/)
  assert.match(TODO_PANEL_SOURCE, /observer\.observe\(button\)[\s\S]*if \(currentTurnOnly/)
  const toggleStart = TODO_PANEL_SOURCE.indexOf('data-testid="todo-toggle"')
  const chevron = TODO_PANEL_SOURCE.indexOf('<Icon name="chevron-down"', toggleStart)
  const title = TODO_PANEL_SOURCE.indexOf("{t('todo.title')}", toggleStart)
  const statusMark = TODO_PANEL_SOURCE.indexOf('<StatusMark status={summary.status}', toggleStart)
  const elapsed = TODO_PANEL_SOURCE.indexOf('data-testid="todo-elapsed"', toggleStart)
  assert.ok(toggleStart < chevron && chevron < title && title < statusMark && statusMark < elapsed)
  const currentStatus = TODO_PANEL_SOURCE.indexOf('data-testid="todo-current"', toggleStart)
  assert.ok(toggleStart < chevron && chevron < title && title < currentStatus)
  assert.doesNotMatch(TODO_PANEL_SOURCE.slice(toggleStart, currentStatus), /<StatusMark status=\{summary.status\}/)
  assert.match(TODO_PANEL_SOURCE.slice(title - 150, title), /planRunning \? streamingTextClassName/)
})

test('elapsed time uses the default font at body-lv1 size with tertiary color', () => {
  assert.match(TODO_PANEL_SOURCE, /<span className="shrink-0 whitespace-nowrap text-\[length:var\(--vds-font-body-lv1\)\] text-\[var\(--vds-text-tertiary\)\]" data-testid="todo-elapsed"/)
  assert.match(TODO_PANEL_SOURCE, /planDurationLabel\(elapsedMilliseconds\)/)
})

test('plan progress numbers use the default font', () => {
  assert.match(TODO_PANEL_SOURCE, /<Badge size="sm" tone="neutral" className="shrink-0" data-testid="todo-progress">/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /data-testid="todo-progress"[^>]*(?:font-mono|tabular-nums)/)
})

test('pending steps use the lucide circle-dashed mark instead of the disabled glyph', () => {
  assert.match(TODO_PANEL_SOURCE, /todo: \{ lucide: CircleDashed, messageKey: 'todo\.status\.todo'/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /todo: \{ mark: 'a-line-status-notfull'/)
})

test('lucide status marks keep iconfont glyph metrics and line-box alignment', () => {
  // .iconfont 全局 16px → lucide 用同档 icon-8; svg 无行盒 → min-h-[1lh] 兜底与文字首行居中。
  assert.match(TODO_PANEL_SOURCE, /inline-grid min-h-\[1lh\] shrink-0 place-items-center/)
  assert.match(TODO_PANEL_SOURCE, /<LucideMark aria-hidden="true" className="size-\[var\(--vds-icon-8\)\]" \/>/)
})

test('plan card uses the 12px radius token', () => {
  assert.match(TODO_PANEL_SOURCE, /!rounded-\[var\(--vds-radius-6\)\]/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /!rounded-\[var\(--vds-radius-4\)\]/)
})

test('the composer shows only the current turn while task monitor retains the latest snapshot', () => {
  assert.match(AI_PANEL_SOURCE, /<TodoPanel compact currentTurnOnly onContinue=\{continueTurn\} continueDisabled=\{continueDisabled\} \/>/)
  assert.match(TASK_MONITOR_SOURCE, /<TodoPanel \/>/)
})

test('paused plan continuation is a separate action and keeps elapsed time visible', () => {
  assert.match(TODO_PANEL_SOURCE, /summary.messageKey === 'todo.summary.interrupted' && !thread.terminated && isLatestUserTurn/)
  assert.match(TODO_PANEL_SOURCE, /continueDisabled \|\| continuingRef.current/)
  assert.match(TODO_PANEL_SOURCE, /<\/CollapsibleTrigger>[\s\S]*data-testid="todo-continue"/)
  assert.match(TODO_PANEL_SOURCE, /className="group !flex flex-1 !shrink min-w-0/)
  assert.match(TODO_PANEL_SOURCE, /total > 0 && !compactPaused/)
  const composer = readFileSync(new URL('./components/business/Composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /submit\(t\('stream.continueInterrupted'\), \[\], true\)/)
  assert.match(composer, /if \(!preserveDraft\) composerDraft.set\(''\)/)
  assert.match(composer, /if \(preserveDraft\) return/)
  assert.match(composer, /submissionInFlight.current\) return Promise.resolve\(false\)/)
})
