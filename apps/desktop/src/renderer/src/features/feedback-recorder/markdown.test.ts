import assert from 'node:assert/strict'
import test from 'node:test'

import type { RecordingSession, SummaryFields } from './model.ts'
import {
  compactStepLabel,
  reviewStepNotes,
  reviewStepNote,
  composeReviewHtml,
  composeReviewMarkdown,
  type ReviewMarkdownLabels,
} from './markdown.ts'

const session: RecordingSession = {
  sessionId: 'session-1',
  startedAt: '2026-09-21T06:30:00.000Z',
  startedAtMs: Date.parse('2026-09-21T06:30:00.000Z'),
  initialPage: 'app://index',
  endedAt: '2026-09-21T06:31:00.000Z',
  finalPage: 'app://review',
  steps: [
    {
      stepId: 'step-1',
      occurredAt: '2026-09-21T06:30:01.000Z',
      elapsedMs: 1000,
      kind: 'click',
      page: { url: 'app://index', title: '书深', label: '首页' },
      target: { tag: 'button', accessibleName: '新建项目' },
      value: '测试项目',
    },
  ],
  requests: [
    {
      requestId: 'request-1',
      startedAt: '2026-09-21T06:30:01.000Z',
      endedAt: '2026-09-21T06:30:02.000Z',
      durationMs: 1000,
      method: 'POST',
      url: '/api/private-log',
      status: 500,
    },
  ],
  notes: { 'step-1': '创建后没有响应' },
  screenshots: [
    {
      screenshotId: 'screenshot-1',
      stepId: 'step-1',
      note: '项目卡片没有响应',
      sourceFile: new File([new Uint8Array([9])], 'feedback-source.png', { type: 'image/png' }),
      renderedFile: new File([new Uint8Array([1, 2, 3])], 'feedback.png', { type: 'image/png' }),
      previewUrl: 'blob:feedback',
      annotations: [],
    },
    {
      screenshotId: 'screenshot-2',
      stepId: 'step-1',
      note: '项目区域完整截图',
      sourceFile: new File([new Uint8Array([8])], 'feedback-source-2.png', { type: 'image/png' }),
      renderedFile: new File([new Uint8Array([4, 5, 6])], 'feedback-2.png', { type: 'image/png' }),
      previewUrl: 'blob:feedback-2',
      annotations: [],
    },
  ],
  truncated: { steps: false, requests: false },
}

const summary: SummaryFields = {
  generated: '',
  final: '创建项目没有响应，期望正常进入项目。',
  actual: '',
  expected: '',
  additional: '',
}

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
  time: '时间',
}

test('review markdown contains visible feedback without hidden request logs', () => {
  const screenshotSources = {
    'screenshot-1': 'data:image/png;base64,AQID',
    'screenshot-2': 'data:image/png;base64,BAUG',
  }
  const markdown = composeReviewMarkdown(session, summary, labels)

  assert.match(markdown, /^# 检查并提交问题反馈/m)
  assert.match(markdown, /^## 问题总结/m)
  assert.match(markdown, /创建项目没有响应，期望正常进入项目。/)
  assert.match(markdown, /### 1\. 在「首页」页面/)
  assert.match(markdown, /\*\*操作\*\*：点击/)
  assert.match(markdown, /\*\*操作对象\*\*：新建项目/)
  assert.match(markdown, /说明：创建后没有响应/)
  assert.match(markdown, /输入内容：测试项目/)
  assert.match(markdown, /截图说明 1：项目卡片没有响应/)
  assert.match(markdown, /截图说明 2：项目区域完整截图/)
  assert.doesNotMatch(markdown, /data:image\//)
  assert.doesNotMatch(markdown, /base64,/)
  assert.doesNotMatch(markdown, /!\[/)
  assert.doesNotMatch(markdown, /private-log|POST|500/)

  const html = composeReviewHtml(session, summary, labels, screenshotSources)
  assert.match(html, /<h1>检查并提交问题反馈<\/h1>/)
  assert.match(html, /<strong>操作<\/strong>：点击/)
  assert.match(html, /<img src="data:image\/png;base64,AQID"/)
  assert.match(html, /<img src="data:image\/png;base64,BAUG"/)
  assert.match(html, /<figcaption>截图说明 2：项目区域完整截图<\/figcaption>/)
  assert.doesNotMatch(html, /private-log|POST|500/)
})

test('compact recording step stays readable without input values or request logs', () => {
  const label = compactStepLabel(session.steps[0], 0, {
    action: () => '点击',
    sourcePage: (page) => `在「${page}」页面`,
    sourceDialog: (page, dialog) => `在「${page}」页面的「${dialog}」弹窗中`,
  })

  assert.equal(label, '1. 在「首页」页面 点击 新建项目')
  assert.doesNotMatch(label, /测试项目|private-log|POST|500/)
})

test('review and clipboard retain submitted notes after a draft is cleared', () => {
  const current = {
    ...session,
    notes: {},
    submittedNotes: { 'step-1': ['已提交说明', '第二次说明'] },
  }
  assert.deepEqual(reviewStepNotes(current, 'step-1'), ['已提交说明', '第二次说明'])
  assert.deepEqual(reviewStepNotes({ ...current, notes: { 'step-1': '已提交说明' } }, 'step-1'), [
    '已提交说明',
    '第二次说明',
  ])
  assert.match(composeReviewMarkdown(current, summary, labels), /已提交说明/)
  assert.match(composeReviewHtml(current, summary, labels, {}), /第二次说明/)
})

test('editable step description preserves explicit clears and falls back to submitted text or screenshot notes', () => {
  assert.equal(reviewStepNote(session, 'step-1'), '创建后没有响应')
  assert.equal(reviewStepNote({ ...session, notes: {} }, 'step-1'), '项目卡片没有响应')
  assert.equal(
    reviewStepNote(
      { ...session, notes: {}, submittedNotes: { 'step-1': ['原说明', '最近提交'] } },
      'step-1'
    ),
    '最近提交'
  )
  assert.equal(reviewStepNote({ ...session, notes: { 'step-1': '' } }, 'step-1'), '')
})
