import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeText } from './utils.ts'

import {
  RECORDER_DESCRIPTION_MAX_LENGTH,
  type RecordedScreenshot,
  type RecordingSession,
  type SummaryFields,
} from './model.ts'
import {
  buildRecordingReport,
  composeFinalDescription,
  generateSummary,
  prepareDescriptionForSubmission,
  reportFile,
} from './report.ts'

const descriptionLabels = {
  actual: '实际现象：',
  expected: '预期结果：',
  additional: '补充信息：',
  operations: '用户操作过程：',
  requests: 'API 接口信息：',
  empty: '无',
  cancelled: '已取消',
  moreInReport: '更多内容见完整录制报告。',
  page: (value: string) => `页面=${value}`,
  dialog: (value: string) => `弹窗=${value}`,
  locator: (value: string) => `定位=${value}`,
  containers: (value: string) => `容器=${value}`,
  pointer: (x: number, y: number) => `坐标=${x},${y}`,
  bounds: (x: number, y: number, width: number, height: number) =>
    `矩形=${x},${y},${width},${height}`,
  operation: (
    index: number,
    occurredAt: string,
    elapsedMs: number,
    kind: string,
    target: string,
    value: string,
    note: string,
    context: string
  ) =>
    `${index}. ${occurredAt} +${elapsedMs}ms ${kind} ${target} ${value} ${note} ${context}`.trim(),
  request: (
    index: number,
    startedAt: string,
    elapsedMs: number,
    method: string,
    url: string,
    status: string,
    durationMs: number,
    linkedStep: number | undefined
  ) =>
    `${index}. ${startedAt} +${elapsedMs}ms ${method} ${url} ${status} ${durationMs}ms step=${linkedStep || '-'}`,
}

const session: RecordingSession = {
  sessionId: 'session-1',
  startedAt: '2026-09-16T00:00:00.000Z',
  startedAtMs: Date.parse('2026-09-16T00:00:00.000Z'),
  initialPage: 'app://index',
  endedAt: '2026-09-16T00:01:00.000Z',
  finalPage: 'app://review',
  steps: [
    {
      stepId: 'step-1',
      occurredAt: '2026-09-16T00:00:01.000Z',
      elapsedMs: 1000,
      kind: 'click',
      page: {
        url: 'app://index',
        title: 'ScholarSeed',
        path: '/literature',
        dialogLabel: '导入文献',
      },
      target: {
        tag: 'button',
        testId: 'submit',
        locator: { kind: 'testId', value: 'submit' },
        containerTestIds: ['literature-overview'],
        bounds: { x: 10, y: 20, width: 100, height: 40 },
      },
      pointer: { x: 30, y: 40 },
    },
  ],
  requests: [
    {
      requestId: 'request-1',
      startedAt: '2026-09-16T00:00:01.000Z',
      endedAt: '2026-09-16T00:00:02.000Z',
      durationMs: 1000,
      method: 'POST',
      url: '/api/test',
      status: 500,
      stepId: 'step-1',
    },
  ],
  notes: { 'step-1': '页面没有响应', removed: '' },
  screenshots: [],
  truncated: { steps: false, requests: false },
}

const summary: SummaryFields = {
  generated: 'generated',
  final: 'final',
  actual: 'actual',
  expected: 'expected',
  additional: 'additional',
}

test('deterministic summary uses user notes without exposing request evidence', () => {
  const value = generateSummary(session, {
    step: (index, kind, target, note) => `${index}:${kind}:${target}:${note}`,
    screenshots: (count) => `shots:${count}`,
    screenshotNote: (index, note) => `shot-note:${index}:${note}`,
    empty: 'empty',
  })
  assert.equal(value, '1:click:submit:页面没有响应')
})

test('recording report keeps immutable evidence and omits deleted notes', () => {
  const report = buildRecordingReport(session, '2026-09-16T00:01:00.000Z', summary)
  assert.deepEqual(report.steps, session.steps)
  assert.deepEqual(report.requests, session.requests)
  assert.deepEqual(report.stepNotes, [{ stepId: 'step-1', text: '页面没有响应' }])
  assert.equal(reportFile(report).type, 'application/json')
})

test('report serializes compact JSON', async () => {
  const report = buildRecordingReport(session, session.endedAt!, summary)
  assert.equal(await reportFile(report).text(), JSON.stringify(report))
})

test('report file retains the size safety guard', () => {
  const report = buildRecordingReport(session, session.endedAt!, summary)
  report.summary.final = 'x'.repeat(2 * 1024 * 1024)
  assert.throws(() => reportFile(report), /recording_report_too_large/)
})

test('report preserves captured input truncation counts', () => {
  const value = summarizeText('中'.repeat(1000))
  const report = buildRecordingReport(
    { ...session, steps: [{ ...session.steps[0], value }] },
    session.endedAt!,
    summary
  )
  assert.equal(report.steps[0].value, value)
})

test('maximum recording keeps bounded evidence below the report limit', () => {
  const oversized = '中😀\\"\n'.repeat(10_000)
  const crowded: RecordingSession = {
    ...session,
    steps: Array.from({ length: 500 }, (_, index) => ({
      ...session.steps[0],
      stepId: `step-${index}`,
      value: oversized,
      page: { ...session.steps[0].page, url: oversized },
      target: { ...session.steps[0].target, href: oversized },
    })),
    requests: Array.from({ length: 300 }, (_, index) => ({
      ...session.requests[0],
      requestId: `request-${index}`,
      url: oversized,
      requestBody: 'a'.repeat(200),
      responseBody: 'b'.repeat(200),
    })),
    notes: Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`step-${index}`, oversized])
    ),
  }
  const report = buildRecordingReport(crowded, session.endedAt!, { ...summary, final: oversized })
  assert.ok(reportFile(report).size <= 2 * 1024 * 1024)
  assert.equal(report.steps.length, 500)
  assert.equal(report.requests.length, 300)
  assert.match(report.steps[0].value || '', /已截断/)
  assert.match(report.summary.final, /已截断/)
  assert.equal(crowded.steps[0].value, oversized)
})

test('maximum multipart summaries share the report budget even with JSON escaping', () => {
  const multipart = JSON.stringify(
    Array.from({ length: 20 }, (_, index) => [String(index), '\\'.repeat(200)])
  )
  const crowded: RecordingSession = {
    ...session,
    steps: Array.from({ length: 500 }, (_, index) => ({
      ...session.steps[0],
      stepId: `step-${index}`,
    })),
    requests: Array.from({ length: 300 }, (_, index) => ({
      ...session.requests[0],
      requestId: `request-${index}`,
      requestBody: multipart,
      responseBody: multipart,
    })),
  }
  const report = buildRecordingReport(crowded, session.endedAt!, summary)
  assert.ok(reportFile(report).size <= 2 * 1024 * 1024)
  assert.equal(report.requests.length, 300)
  assert.match(report.requests[0].requestBody || '', /已截断，省略 \d+ 字节/)
})

test('recording report excludes screenshots without a valid linked step', () => {
  const screenshots: RecordedScreenshot[] = [
    {
      screenshotId: 'linked',
      stepId: 'step-1',
      note: '',
      sourceFile: {} as File,
      renderedFile: { name: 'feedback.png' } as File,
      previewUrl: 'blob:linked',
      annotations: [],
    },
    {
      screenshotId: 'orphan',
      note: '',
      sourceFile: {} as File,
      renderedFile: { name: 'feedback-2.png' } as File,
      previewUrl: 'blob:orphan',
      annotations: [],
    },
  ]
  const report = buildRecordingReport({ ...session, screenshots }, session.endedAt!, summary)
  assert.deepEqual(
    report.screenshots.map((screenshot) => screenshot.screenshotId),
    ['linked']
  )
})

test('final description composes editable summary fields', () => {
  assert.equal(
    composeFinalDescription(summary, descriptionLabels),
    'final\n\n实际现象：\nactual\n\n预期结果：\nexpected\n\n补充信息：\nadditional'
  )
})

test('final description includes ordered operations and API request diagnostics', () => {
  const value = composeFinalDescription(summary, descriptionLabels, session)
  assert.match(
    value,
    /用户操作过程：\n1\. 2026-09-16T00:00:01\.000Z \+1000ms click submit {2}页面没有响应 页面=\/literature \| 弹窗=导入文献 \| 定位=\[data-testid="submit"\] \| 容器=literature-overview \| 坐标=30,40 \| 矩形=10,20,100,40/
  )
  assert.match(
    value,
    /API 接口信息：\n1\. 2026-09-16T00:00:01\.000Z \+1000ms POST \/api\/test 500 1000ms step=1/
  )
})

test('a request the client cancelled is reported as cancelled, not as a failure', () => {
  const value = composeFinalDescription(summary, descriptionLabels, {
    ...session,
    requests: [
      {
        ...session.requests[0],
        method: 'GET',
        url: '/api/v1/literatures?recent=true',
        status: undefined,
        cancelled: true,
        error: 'signal is aborted without reason',
      },
    ],
  })
  assert.match(
    value,
    /1\. 2026-09-16T00:00:01\.000Z \+1000ms GET \/api\/v1\/literatures\?recent=true 已取消 1000ms step=1/
  )
  assert.doesNotMatch(value, /signal is aborted without reason/)
})

test('recording evidence stays within the description limit and points to the full report', () => {
  const repeated = Array.from({ length: 200 }, (_, index) => ({
    ...session.steps[0],
    stepId: `step-${index}`,
    target: { tag: 'button', testId: `very-long-operation-target-${index}-${'x'.repeat(80)}` },
  }))
  const value = composeFinalDescription(summary, descriptionLabels, {
    ...session,
    steps: repeated,
    requests: [],
  })
  assert.ok(value.length <= RECORDER_DESCRIPTION_MAX_LENGTH)
  assert.match(value, /更多内容见完整录制报告。/)
})

test('submission normalizes multipart line breaks and truncates with a visible notice', () => {
  const value = `${Array.from({ length: 600 }, (_, index) => `第 ${index + 1} 步操作`).join('\n')}😀`
  const prepared = prepareDescriptionForSubmission(value, '描述已截断，完整内容见录制报告。')
  assert.equal(prepared.truncated, true)
  assert.ok(prepared.description.length <= RECORDER_DESCRIPTION_MAX_LENGTH)
  assert.doesNotMatch(prepared.description, /\r(?!\n)|(?<!\r)\n/)
  assert.match(prepared.description, /描述已截断，完整内容见录制报告。$/)
  assert.doesNotMatch(prepared.description, /\uD800$/)
})

test('submission preserves descriptions already within the server limit', () => {
  const prepared = prepareDescriptionForSubmission('第一行\n第二行', '描述已截断。')
  assert.deepEqual(prepared, {
    description: '第一行\r\n第二行',
    truncated: false,
  })
})

test('report retains all submitted descriptions independently of later drafts', () => {
  const stepId = session.steps[0].stepId
  const result = buildRecordingReport(
    {
      ...session,
      notes: { [stepId]: '后续草稿' },
      submittedNotes: { [stepId]: ['提交一', '提交二'], missing: ['失效步骤'] },
    },
    session.endedAt!,
    summary
  )
  assert.deepEqual(result.submittedStepNotes, [
    { stepId, text: '提交一' },
    { stepId, text: '提交二' },
  ])
  assert.equal(result.stepNotes[0].text, '后续草稿')
})
