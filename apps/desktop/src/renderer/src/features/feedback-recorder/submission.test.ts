import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const recorder = readFileSync(new URL('./Recorder.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./Review.tsx', import.meta.url), 'utf8')

test('notes and screenshots stay local until the complete recording is submitted', () => {
  const localActions = recorder.slice(
    recorder.indexOf('const saveScreenshot ='),
    recorder.indexOf('const submit =')
  )
  assert.doesNotMatch(localActions, /submitFeedback\(/)
  assert.equal(recorder.match(/await submitFeedback\(/g)?.length, 1)
  const stop = recorder.slice(recorder.indexOf('const stop ='), recorder.indexOf('const capture ='))
  assert.match(stop, /setPhase\('review'\)/)
  assert.doesNotMatch(stop, /submit\(/)
})

test('recorder feedback carries the diagnostics consent fields', () => {
  const call = recorder.slice(recorder.indexOf('await submitFeedback({'))
  const body = call.slice(0, call.indexOf('recordingReport: reportFile(report)'))
  // 省略这三个字段会落成 include_logs=false，serve 据此整段跳过诊断收集，反馈包只剩录制报告。
  assert.match(body, /includeLogs: true/)
  assert.match(body, /includeTrace: true/)
  assert.match(body, /sessionId: state\.activeSession/)
})

test('recorder review states what will be uploaded before submit', () => {
  assert.match(review, /data-testid="feedback-recorder-diagnostics-notice"/)
  assert.match(review, /feedbackRecorder\.review\.diagnosticsNotice'/)
  assert.match(review, /feedbackRecorder\.review\.diagnosticsNoticeNoSession'/)
})

test('empty problem supplement does not block submission', () => {
  assert.match(review, /data-testid="feedback-recorder-submit"\s+disabled=\{submitting\}/)
  assert.doesNotMatch(review, /disabled=\{!summary\.final\.trim\(\)\}/)
})

test('recorder review is a bounded dialog with paginated steps', () => {
  assert.match(review, /data-testid="feedback-recorder-review"/)
  assert.match(review, /max-h-\[calc\(100dvh-var\(--vds-space-8\)\)\]/)
  assert.match(review, /const STEPS_PER_PAGE = 5/)
  assert.match(review, /data-testid="feedback-recorder-review-header"/)
  assert.doesNotMatch(review, /!\[inset:0\]/)
})
