import assert from 'node:assert/strict'
import test from 'node:test'

import { sanitizeDesktopNotification } from './notifications.ts'

test('notification boundary requires a session identity and visible text', () => {
  assert.equal(sanitizeDesktopNotification({ title: '任务', body: '完成' }), null)
  assert.equal(sanitizeDesktopNotification({ sessionId: 's-1', title: '', body: '完成' }), null)
  assert.deepEqual(sanitizeDesktopNotification({
    sessionId: ' s-1 ',
    title: ' 任务 ',
    body: ' 完成 '
  }), { sessionId: 's-1', title: '任务', body: '完成' })
})
