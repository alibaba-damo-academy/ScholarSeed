import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LITERATURE_SCOPE_KEY,
  clearContinuity,
  continuityScopeKey,
  readContinuityRecord,
  rememberContinuity,
  restoreContinuityCandidate,
  writeContinuityRecord,
  type ContinuityRecord,
  type ContinuityStorage,
} from './continuity.ts'
import type { SessionNode } from './model.ts'

function memoryStorage(
  initial: string | null = null
): ContinuityStorage & { value: string | null } {
  const storage = {
    value: initial,
    getItem: () => storage.value,
    setItem: (_key: string, value: string) => {
      storage.value = value
    },
  }
  return storage
}

function sessionNode(patch: Partial<SessionNode> = {}): SessionNode {
  return { id: 's1', title: '对话 A', status: 'dormant', ...patch }
}

const PROJECTS = [
  { id: 'p1', path: '/work/甲' },
  { id: 'p2', path: '/work/乙' },
]

function scopeInput(patch: Partial<Parameters<typeof continuityScopeKey>[0]> = {}) {
  return {
    activeSession: null,
    threadProjectPath: undefined,
    homeSelectedProjectId: null,
    mainView: 'home',
    projects: PROJECTS,
    ...patch,
  }
}

test('无记录的作用域恢复为新对话（规则 5），记录保持不变', () => {
  const record: ContinuityRecord = {}
  const candidate = restoreContinuityCandidate(
    record,
    'p1',
    (id) => (id === 's1' ? sessionNode() : undefined),
    '/work/甲'
  )
  assert.equal(candidate.node, null)
  assert.equal(candidate.record, record)
})

test('记录为 null（新对话）时恢复为新对话，不清除条目（规则 1）', () => {
  const record: ContinuityRecord = { p1: null }
  const candidate = restoreContinuityCandidate(
    record,
    'p1',
    (id) => (id === 's1' ? sessionNode() : undefined),
    '/work/甲'
  )
  assert.equal(candidate.node, null)
  assert.deepEqual(candidate.record, { p1: null })
})

test('有效会话恢复对应节点', () => {
  const node = sessionNode({ projectPath: '/work/甲' })
  const record: ContinuityRecord = { p1: node.id }
  const candidate = restoreContinuityCandidate(
    record,
    'p1',
    (id) => (id === node.id ? node : undefined),
    '/work/甲'
  )
  assert.equal(candidate.node, node)
  assert.equal(candidate.record, record)
})

test('会话已不在目录中时清除记录并回退新对话', () => {
  const record: ContinuityRecord = { p1: 's-gone', p2: 's2' }
  const candidate = restoreContinuityCandidate(record, 'p1', () => undefined, '/work/甲')
  assert.equal(candidate.node, null)
  assert.deepEqual(candidate.record, { p2: 's2' })
})

test('容器行、不可打开、不属于该作用域的会话都视为失效并清除', () => {
  const cases: Array<SessionNode> = [
    sessionNode({ container: true, projectPath: '/work/甲' }),
    sessionNode({ openable: false, projectPath: '/work/甲' }),
    sessionNode({ projectPath: '/work/乙' }),
    sessionNode({ projectPath: null }),
    sessionNode(),
  ]
  for (const node of cases) {
    const record: ContinuityRecord = { p1: node.id }
    const candidate = restoreContinuityCandidate(
      record,
      'p1',
      (id) => (id === node.id ? node : undefined),
      '/work/甲'
    )
    assert.equal(candidate.node, null)
    assert.deepEqual(candidate.record, {})
  }
})

test('作用域 key：会话归属项目、无项目会话仅在文献库视图归属文献库、无法归属返回 null', () => {
  assert.equal(
    continuityScopeKey(scopeInput({ activeSession: 's1', threadProjectPath: '/work/甲' })),
    'p1'
  )
  assert.equal(
    continuityScopeKey(
      scopeInput({ activeSession: 's1', threadProjectPath: null, mainView: LITERATURE_SCOPE_KEY })
    ),
    LITERATURE_SCOPE_KEY
  )
  // 首页/对话面的无项目全局对话不属于文献库作用域，不能写进文献库 key。
  assert.equal(
    continuityScopeKey(
      scopeInput({ activeSession: 's1', threadProjectPath: null, mainView: 'conversation' })
    ),
    null
  )
  assert.equal(
    continuityScopeKey(
      scopeInput({ activeSession: 's1', threadProjectPath: null, mainView: 'home' })
    ),
    null
  )
  assert.equal(
    continuityScopeKey(
      scopeInput({ activeSession: 's1', threadProjectPath: null, mainView: 'resource' })
    ),
    null
  )
  assert.equal(
    continuityScopeKey(scopeInput({ activeSession: 's1', threadProjectPath: undefined })),
    null
  )
  assert.equal(
    continuityScopeKey(scopeInput({ activeSession: 's1', threadProjectPath: '/gone' })),
    null
  )
  assert.equal(continuityScopeKey(scopeInput({ homeSelectedProjectId: 'p2' })), 'p2')
  assert.equal(
    continuityScopeKey(scopeInput({ mainView: LITERATURE_SCOPE_KEY })),
    LITERATURE_SCOPE_KEY
  )
  assert.equal(continuityScopeKey(scopeInput()), null)
})

test('记录读写：损坏数据与新对象容错，非字符串值收敛为 null', () => {
  const empty = memoryStorage()
  assert.deepEqual(readContinuityRecord(empty), {})

  const corrupted = memoryStorage('not-json')
  assert.deepEqual(readContinuityRecord(corrupted), {})

  const sanitized = memoryStorage(
    JSON.stringify({ p1: 's1', p2: 7, p3: null, '': 's4', list: ['s5'] })
  )
  assert.deepEqual(readContinuityRecord(sanitized), { p1: 's1', p2: null, p3: null, list: null })

  const roundTrip = memoryStorage()
  writeContinuityRecord(roundTrip, { p1: 's1', [LITERATURE_SCOPE_KEY]: null })
  assert.deepEqual(readContinuityRecord(roundTrip), { p1: 's1', [LITERATURE_SCOPE_KEY]: null })
})

test('rememberContinuity：同值不产生新对象，不同值覆盖', () => {
  const record: ContinuityRecord = { p1: 's1' }
  assert.equal(rememberContinuity(record, 'p1', 's1'), record)
  assert.deepEqual(rememberContinuity(record, 'p1', 's2'), { p1: 's2' })
  assert.deepEqual(rememberContinuity(record, 'p1', null), { p1: null })
  assert.deepEqual(rememberContinuity(record, 'p2', 's3'), { p1: 's1', p2: 's3' })
})

test('clearContinuity：只清除存在的条目', () => {
  const record: ContinuityRecord = { p1: 's1' }
  assert.deepEqual(clearContinuity(record, 'p1'), {})
  assert.equal(clearContinuity(record, 'p2'), record)
})
