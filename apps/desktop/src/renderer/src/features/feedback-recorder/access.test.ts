import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { isFeedbackRecorderAvailable } from './access.ts'

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
