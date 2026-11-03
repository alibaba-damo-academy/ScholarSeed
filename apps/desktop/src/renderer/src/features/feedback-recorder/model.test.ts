import assert from 'node:assert/strict'
import test from 'node:test'

import type { RecordingSession } from './model.ts'
import {
  appendInitialScreenshot,
  normalizeNote,
  RECORDER_NOTE_MAX_LENGTH,
  normalizeRectangleAnnotation,
  replaceRecordedScreenshot,
  requiresDiscardConfirmation,
  selectFeedbackImages,
} from './model.ts'

const initialSession: RecordingSession = {
  sessionId: 'session-1',
  startedAt: '2026-09-21T06:30:00.000Z',
  startedAtMs: Date.parse('2026-09-21T06:30:00.000Z'),
  initialPage: 'app://index',
  steps: [
    {
      stepId: 'step-1',
      occurredAt: '2026-09-21T06:30:00.000Z',
      elapsedMs: 0,
      kind: 'navigation',
      page: { url: 'app://index', title: '书深', label: '首页' },
      target: { tag: 'window', role: 'navigation' },
    },
  ],
  requests: [],
  notes: {},
  screenshots: [],
  truncated: { steps: false, requests: false },
}

test('initial page step alone does not require discard confirmation', () => {
  assert.equal(requiresDiscardConfirmation(initialSession), false)
})

test('automatic initial screenshot is linked to the current-page step without annotations', () => {
  const sourceFile = new File(['source'], 'source.png', { type: 'image/png' })
  const renderedFile = new File(['rendered'], 'rendered.png', { type: 'image/png' })
  const next = appendInitialScreenshot(initialSession, {
    screenshotId: 'screenshot-initial',
    sourceFile,
    renderedFile,
    previewUrl: 'blob:initial',
  })

  assert.equal(next.screenshots.length, 1)
  assert.equal(next.screenshots[0].stepId, 'step-1')
  assert.equal(next.screenshots[0].automatic, true)
  assert.deepEqual(next.screenshots[0].annotations, [])
  assert.equal(requiresDiscardConfirmation(next), false)
})

test('user operations and feedback content require discard confirmation', () => {
  assert.equal(
    requiresDiscardConfirmation({
      ...initialSession,
      steps: [
        ...initialSession.steps,
        { ...initialSession.steps[0], stepId: 'step-2', kind: 'click' },
      ],
    }),
    true
  )
  assert.equal(
    requiresDiscardConfirmation({
      ...initialSession,
      notes: { 'step-1': '页面显示异常' },
    }),
    true
  )
  assert.equal(
    requiresDiscardConfirmation({
      ...initialSession,
      screenshots: [
        {
          screenshotId: 'screenshot-1',
          stepId: 'step-1',
          note: '',
          sourceFile: new File([], 'feedback-source.png', { type: 'image/png' }),
          renderedFile: new File([], 'feedback.png', { type: 'image/png' }),
          previewUrl: 'blob:feedback',
          annotations: [],
        },
      ],
    }),
    true
  )
})

test('re-editing a screenshot replaces only its rendered output and preserves the original source', () => {
  const sourceFile = new File(['source'], 'source.png', { type: 'image/png' })
  const originalFile = new File(['first'], 'first.png', { type: 'image/png' })
  const replacementFile = new File(['second'], 'second.png', { type: 'image/png' })
  const screenshot = {
    screenshotId: 'screenshot-1',
    stepId: 'step-1',
    note: '原说明',
    sourceFile,
    renderedFile: originalFile,
    previewUrl: 'blob:first',
    annotations: [],
  }

  const next = replaceRecordedScreenshot(screenshot, {
    renderedFile: replacementFile,
    previewUrl: 'blob:second',
    note: '更新说明',
    annotations: [{ type: 'redact', x: 1, y: 2, width: 3, height: 4 }],
  })

  assert.equal(next.sourceFile, sourceFile)
  assert.equal(next.renderedFile, replacementFile)
  assert.equal(next.previewUrl, 'blob:second')
  assert.equal(next.note, '更新说明')
  assert.deepEqual(next.annotations, [{ type: 'redact', x: 1, y: 2, width: 3, height: 4 }])
})

test('redaction rectangles normalize reverse drags before rendering', () => {
  assert.deepEqual(
    normalizeRectangleAnnotation({ type: 'redact', x: 20, y: 30, width: -8, height: -12 }),
    { type: 'redact', x: 12, y: 18, width: 8, height: 12 }
  )
})

test('feedback submission selects rendered screenshots and never raw sources', () => {
  const sourceFile = new File(['private'], 'source.png', { type: 'image/png' })
  const renderedFile = new File(['redacted'], 'rendered.png', { type: 'image/png' })
  const session: RecordingSession = {
    ...initialSession,
    screenshots: [
      {
        screenshotId: 'screenshot-1',
        stepId: 'step-1',
        note: '',
        sourceFile,
        renderedFile,
        previewUrl: 'blob:rendered',
        annotations: [],
      },
    ],
  }

  assert.deepEqual(selectFeedbackImages(session), [renderedFile])
})

test('feedback text accepts 500 characters and truncates longer content', () => {
  assert.equal(RECORDER_NOTE_MAX_LENGTH, 500)
  assert.equal(normalizeNote('字'.repeat(500)), '字'.repeat(500))
  assert.equal(normalizeNote('字'.repeat(501)).length, 500)
  assert.equal(normalizeNote('  第一行\r\n第二行  '), '第一行\n第二行')
})
