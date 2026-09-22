import assert from 'node:assert/strict'
import test from 'node:test'

import type { RecordingSession } from './model.ts'
import { requiresDiscardConfirmation } from './model.ts'

const initialSession: RecordingSession = {
  sessionId: 'session-1',
  startedAt: '2026-09-21T06:30:00.000Z',
  startedAtMs: Date.parse('2026-09-21T06:30:00.000Z'),
  initialPage: 'app://index',
  steps: [{
    stepId: 'step-1',
    occurredAt: '2026-09-21T06:30:00.000Z',
    elapsedMs: 0,
    kind: 'navigation',
    page: { url: 'app://index', title: '书深', label: '首页' },
    target: { tag: 'window', role: 'navigation' }
  }],
  requests: [],
  notes: {},
  screenshots: [],
  truncated: { steps: false, requests: false }
}

test('initial page step alone does not require discard confirmation', () => {
  assert.equal(requiresDiscardConfirmation(initialSession), false)
})

test('user operations and feedback content require discard confirmation', () => {
  assert.equal(requiresDiscardConfirmation({
    ...initialSession,
    steps: [...initialSession.steps, { ...initialSession.steps[0], stepId: 'step-2', kind: 'click' }]
  }), true)
  assert.equal(requiresDiscardConfirmation({
    ...initialSession,
    notes: { 'step-1': '页面显示异常' }
  }), true)
  assert.equal(requiresDiscardConfirmation({
    ...initialSession,
    screenshots: [{
      screenshotId: 'screenshot-1',
      stepId: 'step-1',
      note: '',
      file: new File([], 'feedback.png', { type: 'image/png' }),
      previewUrl: 'blob:feedback',
      annotations: []
    }]
  }), true)
})
