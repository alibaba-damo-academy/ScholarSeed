import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { isFeedbackRecorderAvailable, feedbackShortcutAction } from './access.ts'

test('feedback entry routes anonymous and external users to the form', () => {
  assert.equal(feedbackShortcutAction('idle', true, true), 'record')
  assert.equal(feedbackShortcutAction('idle', true, false), 'feedback')
  assert.equal(feedbackShortcutAction('idle', false, true), 'feedback')
  assert.equal(feedbackShortcutAction('idle', false, false), 'feedback')
})

test('an active recording keeps screenshot shortcuts regardless of entry identity', () => {
  for (const internal of [true, false]) {
    for (const authenticated of [true, false]) {
      assert.equal(feedbackShortcutAction('recording', internal, authenticated), 'capture')
      assert.equal(feedbackShortcutAction('paused', internal, authenticated), 'capture')
      for (const phase of ['annotating', 'review', 'submitting', 'done'] as const) {
        assert.equal(feedbackShortcutAction(phase, internal, authenticated), null)
      }
    }
  }
})

test('feedback recorder is available only to authenticated internal users', () => {
  assert.equal(isFeedbackRecorderAvailable(true, true), true)
  assert.equal(isFeedbackRecorderAvailable(true, false), false)
  assert.equal(isFeedbackRecorderAvailable(false, true), false)
})

test('review labels describe the optional field as problem supplement', () => {
  const localeUrl = new URL('../../../../localization/locales/', import.meta.url)
  const zh = JSON.parse(readFileSync(new URL('zh/components.json', localeUrl), 'utf8'))
  const en = JSON.parse(readFileSync(new URL('en/components.json', localeUrl), 'utf8'))

  assert.equal(zh.feedbackRecorder.review.summary, '问题补充')
  assert.equal(en.feedbackRecorder.review.summary, 'Additional details')
})
