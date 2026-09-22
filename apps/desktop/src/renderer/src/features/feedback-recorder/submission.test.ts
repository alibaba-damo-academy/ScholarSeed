import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const recorder = readFileSync(new URL('./Recorder.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./Review.tsx', import.meta.url), 'utf8')

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
