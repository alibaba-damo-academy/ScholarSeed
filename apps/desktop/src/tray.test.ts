import assert from 'node:assert/strict'
import test from 'node:test'
import { isTrayNavigation, isTrayReply, TRAY_RECENT_LIMIT } from './tray.ts'

test('tray replies distinguish unavailable, empty and project snapshots', () => {
  assert.equal(isTrayReply({ requestId: 1, snapshot: null }), true)
  assert.equal(isTrayReply({ requestId: 1, snapshot: { project: null, sessions: [] } }), true)
  assert.equal(isTrayReply({ requestId: 1, snapshot: {
    project: { id: 'project', name: '研究' }, sessions: [{ id: 'session', title: '检索' }],
  } }), true)
})

test('tray replies reject stale-shaped, unbounded and unscoped payloads', () => {
  const project = { id: 'project', name: '研究' }
  for (const snapshot of [
    {}, { project: null, sessions: [{ id: 'session', title: '检索' }] },
    { project, sessions: Array.from({ length: TRAY_RECENT_LIMIT + 1 }, (_, index) => ({ id: String(index), title: '任务' })) },
    { project, sessions: [{ id: 'same', title: '任务' }, { id: 'same', title: '重复' }] },
    { project: { id: '', name: '研究' }, sessions: [] },
  ]) assert.equal(isTrayReply({ requestId: 1, snapshot }), false)
  assert.equal(isTrayReply({ requestId: 0, snapshot: null }), false)
})

test('tray navigation only carries fixed actions and stable identifiers', () => {
  assert.equal(isTrayNavigation({ kind: 'literature' }), true)
  assert.equal(isTrayNavigation({ kind: 'create', projectId: 'project' }), true)
  assert.equal(isTrayNavigation({ kind: 'session', projectId: 'project', sessionId: 'session' }), true)
  for (const value of [null, { kind: 'execute', command: 'x' }, { kind: 'project' },
    { kind: 'session', projectId: 'project' }]) assert.equal(isTrayNavigation(value), false)
})
