import assert from 'node:assert/strict'
import test from 'node:test'

import type { RecordingSession, SummaryFields } from './model.ts'
import { composeReviewHtml, composeReviewMarkdown, type ReviewMarkdownLabels } from './markdown.ts'

const session: RecordingSession = {
  sessionId: 'session-1',
  startedAt: '2026-09-21T06:30:00.000Z',
  startedAtMs: Date.parse('2026-09-21T06:30:00.000Z'),
  initialPage: 'app://index',
  endedAt: '2026-09-21T06:31:00.000Z',
  finalPage: 'app://review',
  steps: [{
    stepId: 'step-1',
    occurredAt: '2026-09-21T06:30:01.000Z',
    elapsedMs: 1000,
    kind: 'click',
    page: { url: 'app://index', title: '书深', label: '首页' },
    target: { tag: 'button', accessibleName: '新建项目' },
    value: '测试项目'
  }],
  requests: [{
    requestId: 'request-1',
    startedAt: '2026-09-21T06:30:01.000Z',
    endedAt: '2026-09-21T06:30:02.000Z',
    durationMs: 1000,
    method: 'POST',
    url: '/api/private-log',
    status: 500
  }],
  notes: { 'step-1': '创建后没有响应' },
  screenshots: [{
    screenshotId: 'screenshot-1',
    stepId: 'step-1',
    note: '项目卡片没有响应',
    file: new File([new Uint8Array([1, 2, 3])], 'feedback.png', { type: 'image/png' }),
    previewUrl: 'blob:feedback',
    annotations: []
  }, {
    screenshotId: 'screenshot-2',
    stepId: 'step-1',
    note: '项目区域完整截图',
    file: new File([new Uint8Array([4, 5, 6])], 'feedback-2.png', { type: 'image/png' }),
    previewUrl: 'blob:feedback-2',
    annotations: []
  }],
  truncated: { steps: false, requests: false }
}

const summary: SummaryFields = {
  generated: '',
  final: '创建项目没有响应，期望正常进入项目。',
  actual: '',
  expected: '',
  additional: ''
}

test('review markdown contains visible feedback without hidden request logs', () => {
  const labels: ReviewMarkdownLabels = {
    title: '检查并提交问题反馈',
    summary: '问题总结',
    steps: '操作步骤',
    action: () => '点击',
    sourcePage: (page) => `在「${page}」页面`,
    sourceDialog: (page, dialog) => `在「${page}」页面的「${dialog}」弹窗中`,
    elapsed: (value) => `+${value} 毫秒`,
    note: (value) => `说明：${value}`,
    input: '输入内容：',
    emptyValue: '（空）',
    screenshots: '关联截图',
    screenshotNote: '截图说明',
    operation: '操作',
    target: '操作对象',
    time: '时间'
  }
  const screenshotSources = {
    'screenshot-1': 'data:image/png;base64,AQID',
    'screenshot-2': 'data:image/png;base64,BAUG'
  }
  const markdown = composeReviewMarkdown(session, summary, labels, screenshotSources)

  assert.match(markdown, /^# 检查并提交问题反馈/m)
  assert.match(markdown, /^## 问题总结/m)
  assert.match(markdown, /创建项目没有响应，期望正常进入项目。/)
  assert.match(markdown, /### 1\. 在「首页」页面/)
  assert.match(markdown, /\*\*操作\*\*：点击/)
  assert.match(markdown, /\*\*操作对象\*\*：新建项目/)
  assert.match(markdown, /说明：创建后没有响应/)
  assert.match(markdown, /输入内容：测试项目/)
  assert.match(markdown, /截图说明 1：项目卡片没有响应/)
  assert.match(markdown, /!\[截图说明 1\]\(data:image\/png;base64,AQID\)/)
  assert.match(markdown, /截图说明 2：项目区域完整截图/)
  assert.match(markdown, /!\[截图说明 2\]\(data:image\/png;base64,BAUG\)/)
  assert.doesNotMatch(markdown, /private-log|POST|500/)

  const html = composeReviewHtml(session, summary, labels, screenshotSources)
  assert.match(html, /<h1>检查并提交问题反馈<\/h1>/)
  assert.match(html, /<strong>操作<\/strong>：点击/)
  assert.match(html, /<img src="data:image\/png;base64,AQID"/)
  assert.match(html, /<img src="data:image\/png;base64,BAUG"/)
  assert.match(html, /<figcaption>截图说明 2：项目区域完整截图<\/figcaption>/)
  assert.doesNotMatch(html, /private-log|POST|500/)
})
