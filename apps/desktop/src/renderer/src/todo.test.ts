import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import type { Thread, TurnOutcome } from './model.ts'
import { displayTodos, isLatestUserTurn, todoProgress, todoProgressLabel, todoSummary } from './todo.ts'

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
      const expected = turnId === 'plan-turn' && (hilState === 'pending' || hilState === 'submitting') ? 'need' : 'running'
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

test('collapsed summaries agree with explicit confirmation and failure steps', () => {
  for (const [status, expected] of [['needs_confirmation', 'need'], ['failed', 'failed']] as const) {
    const value = thread({ todos: [{ content: 'explicit state', status }] })
    assert.equal(todoSummary(value, displayTodos(value)).status, expected)
  }
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

test('plan header collapses the elapsed time when narrow and restores it when wide', () => {
  // 宽度不足(描述压到极限仍溢出)时把「· 时间」折叠为零宽, 让出空间给描述;
  // 宽度恢复后再内联展示; ResizeObserver 驱动。
  assert.match(TODO_PANEL_SOURCE, /elapsedHidden \? '!-ml-\[var\(--vds-space-2\)\] !w-0 !max-w-0 overflow-hidden' : 'inline-flex'/)
  // 用时不再用 tooltip 展示, 横幅内不应残留用时 Tooltip 包裹与受控 hover 状态。
  assert.doesNotMatch(TODO_PANEL_SOURCE, /setElapsedTipOpen/)
  assert.match(TODO_PANEL_SOURCE, /const observer = new ResizeObserver\(update\)/)
  // 展示态看描述是否被截断; 折叠态用描述 wrapper 的 ml-auto 剩余自动外边距量真实空余
  // (scrollWidth 不溢出时恒等于 clientWidth, 量不出空余, 会导致宽度恢复后仍不恢复内联)。
  assert.match(TODO_PANEL_SOURCE, /if \(!hidden\) return currentText \? currentText\.scrollWidth > currentText\.clientWidth : hidden/)
  assert.match(TODO_PANEL_SOURCE, /const slack = Number\.parseFloat\(window\.getComputedStyle\(currentWrapper\)\.marginLeft\) \|\| 0/)
  assert.match(TODO_PANEL_SOURCE, /return slack < elapsedNeedRef\.current/)
  assert.match(TODO_PANEL_SOURCE, /<EllipsisText ref=\{currentTextRef\}[\s\S]*data-testid="todo-current"/)
  // hooks 必须在条件 return 之前, 否则渲染 hook 顺序不稳定导致白屏(React #310)。
  assert.match(TODO_PANEL_SOURCE, /observer\.observe\(button\)[\s\S]*if \(currentTurnOnly/)
  // 描述 wrapper 不能 flex-1: 否则隐藏时间后的空余宽度被吸收, 宽度恢复时再显示条件恒假。
  assert.match(TODO_PANEL_SOURCE, /data-testid="todo-current"[\s\S]*wrapperClassName="ml-auto min-w-0"/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /wrapperClassName="ml-auto min-w-0 flex-1"/)
})

test('elapsed time uses the default font at body-lv1 size with tertiary color', () => {
  assert.match(TODO_PANEL_SOURCE, /<span ref=\{elapsedRef\} className="shrink-0 whitespace-nowrap text-\[length:var\(--vds-font-body-lv1\)\] text-\[var\(--vds-text-tertiary\)\]"/)
  assert.doesNotMatch(TODO_PANEL_SOURCE, /<span ref=\{elapsedRef\} className="[^"]*font-mono/)
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
  assert.match(AI_PANEL_SOURCE, /<TodoPanel compact currentTurnOnly \/>/)
  assert.match(TASK_MONITOR_SOURCE, /<TodoPanel \/>/)
})
