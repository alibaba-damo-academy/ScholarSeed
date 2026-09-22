import assert from 'node:assert/strict'
import test from 'node:test'

import type { SessionNode } from './model.ts'
import { notificationIntents, sessionNeedsAttention } from './attention.ts'

const session = (id: string, status: SessionNode['status'], activityAt = 10): SessionNode => ({
  id,
  title: `任务 ${id}`,
  status,
  activityAt
})

test('session attention separates actionable waiting and unread terminal sessions', () => {
  assert.equal(sessionNeedsAttention(session('waiting', 'waiting'), 99), true)
  assert.equal(sessionNeedsAttention(session('done', 'done'), 9), true)
  assert.equal(sessionNeedsAttention(session('done', 'done'), 10), false)
  assert.equal(sessionNeedsAttention(session('meta', 'dormant', 99), 0), false)
})

test('notification intents cover waiting and terminal transitions once', () => {
  const intents = notificationIntents(
    { a: 'running', b: 'waiting', c: 'done' },
    [session('a', 'waiting'), session('b', 'done'), session('c', 'done')],
    null,
    false
  )
  assert.deepEqual(intents.map((intent) => [intent.sessionId, intent.terminal]), [
    ['a', false],
    ['b', true]
  ])
})

test('focused active session suppresses its own notification', () => {
  assert.deepEqual(
    notificationIntents({ a: 'running' }, [session('a', 'done')], 'a', true),
    []
  )
})

test('notification intent keeps user titles and stable message keys until delivery', () => {
  const sessions = [{ ...session('a', 'done'), title: '研究 project' }, { ...session('b', 'failed'), title: '' }]
  const intents = notificationIntents({ a: 'running', b: 'running' }, sessions, null, false)
  assert.equal(intents[0].title, '研究 project')
  assert.equal(intents[1].title, '')
  assert.deepEqual(intents.map(intent => intent.bodyKey), ['notifications.done', 'notifications.failed'])
  assert.deepEqual(notificationIntents({ a: 'done', b: 'failed' }, sessions, null, false), [])
})
