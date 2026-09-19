import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import { projectActivityEvents } from './transcript.ts'

import {
  formatHilResolution,
  formatHilSubmissionError,
  hilEventResolution,
  hilPermissionScope,
  hilSubmissionFailure,
  pendingHilItems,
  pendingPermissionItems,
  permissionDecisionOptions,
  transcriptPresentationItems
} from './hil.ts'
import type { ConvItem } from './model.ts'

test('keeps pending interactions out of the transcript for the composer dock', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'run command', turnId: 'turn-1' },
    {
      kind: 'hil',
      requestId: 'permission-1',
      hilKind: 'permission',
      hilState: 'pending',
      turnId: 'turn-1'
    },
    {
      kind: 'hil',
      requestId: 'question-1',
      hilKind: 'question',
      hilState: 'pending',
      questions: [{ question: '选择方案', options: [] }],
      turnId: 'turn-1'
    }
  ]

  assert.deepEqual(pendingHilItems(items).map((item) => item.requestId), [
    'permission-1',
    'question-1'
  ])
  assert.deepEqual(pendingPermissionItems(items).map((item) => item.requestId), [
    'permission-1'
  ])
  assert.deepEqual(transcriptPresentationItems(items).map((item) => item.kind), [
    'user'
  ])
})

test('projects a confirmed question answer as one interaction reply', () => {
  const resolved: ConvItem = {
    kind: 'hil',
    requestId: 'question-1',
    hilKind: 'question',
    hilState: 'resolved',
    questions: [{ question: '今天早餐你想吃什么？', options: [] }],
    answers: { '今天早餐你想吃什么？': '包子配豆浆' },
    turnId: 'turn-1',
    eventSeq: 8
  }
  assert.deepEqual(transcriptPresentationItems([resolved]), [{
    kind: 'interaction_reply',
    requestId: 'question-1',
    questions: resolved.questions,
    answers: resolved.answers,
    turnId: 'turn-1',
    itemId: undefined,
    eventSeq: 8
  }])
})

test('never presents a stale question as a user reply', () => {
  const stale: ConvItem = {
    kind: 'hil',
    requestId: 'question-1',
    hilKind: 'question',
    hilState: 'stale',
    questions: [{ question: '今天早餐你想吃什么？', options: [] }]
  }
  assert.deepEqual(transcriptPresentationItems([stale]), [stale])
})

test('drops a decided permission card because its tool row carries the outcome', () => {
  const allowed: ConvItem = {
    kind: 'hil',
    requestId: 'permission-1',
    hilKind: 'permission',
    hilState: 'resolved',
    resolved: '已允许 · 仅这一次',
    turnId: 'turn-1'
  }
  const denied: ConvItem = {
    kind: 'hil',
    requestId: 'permission-2',
    hilKind: 'permission',
    hilState: 'resolved',
    resolved: '已拒绝',
    resolvedMessage: { kind: 'denied' },
    turnId: 'turn-1'
  }
  assert.deepEqual(transcriptPresentationItems([allowed, denied]), [])
})

test('drops undecided terminal permissions because their outcome is conveyed elsewhere', () => {
  const stale: ConvItem = {
    kind: 'hil',
    requestId: 'permission-0',
    hilKind: 'permission',
    hilState: 'stale',
    resolved: '请求已过期'
  }
  const cancelled: ConvItem = {
    kind: 'hil',
    requestId: 'permission-1',
    hilKind: 'permission',
    hilState: 'cancelled',
    resolved: '已取消任务'
  }
  const unknown: ConvItem = {
    kind: 'hil',
    requestId: 'permission-2',
    hilKind: 'permission',
    hilState: 'unknown',
    submissionErrorMessage: 'outcomeUnknown'
  }
  assert.deepEqual(transcriptPresentationItems([stale, cancelled, unknown]), [])
})

test('selects the vendor one-time decision instead of broader session permission', () => {
  const item: Extract<ConvItem, { kind: 'hil' }> = {
    kind: 'hil',
    requestId: 'permission-1',
    hilKind: 'permission',
    options: [
      { id: 'acceptForSession', label: 'Allow for session' },
      { id: 'accept', label: 'Allow once' },
      { id: 'decline', label: 'Decline' },
      { id: 'cancel', label: 'Decline and stop' }
    ]
  }
  const decision = permissionDecisionOptions(item)
  assert.equal(decision.allowOnce.id, 'accept')
  assert.equal(decision.deny.id, 'decline')
})


test('HIL display provenance follows language changes while raw answers and diagnostics remain exact', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, interpolation: { escapeValue: false }, resources: { zh: { conversation: zh, components: componentsZh }, en: { conversation: en, components: componentsEn } } })
  const t = locale.getFixedT(null, 'components')
  const conversation = locale.getFixedT(null, 'conversation')
  const expired = hilEventResolution(undefined, 'stale')
  const userAnswer = hilEventResolution('请求已过期', 'resolved')
  const rawFailure = hilSubmissionFailure('cancelUnconfirmed', '取消请求未被后端确认，请重试。')
  const applicationFailure = hilSubmissionFailure('cancelUnconfirmed')
  const unknown = hilSubmissionFailure('outcomeUnknown')
  assert.equal(formatHilResolution(expired, t, conversation), '请求已过期')
  assert.equal(formatHilSubmissionError(applicationFailure, t), '取消请求未被后端确认，请重试。')
  await locale.changeLanguage('en')
  assert.equal(formatHilResolution(expired, t, conversation), componentsEn.stream.hil.stale)
  assert.equal(expired.resolved, '请求已过期')
  assert.equal(formatHilResolution(userAnswer, t, conversation), '请求已过期')
  assert.equal(userAnswer.resolvedMessage, undefined)
  assert.equal(formatHilSubmissionError(rawFailure, t), '取消请求未被后端确认，请重试。')
  assert.equal(rawFailure.submissionErrorMessage, undefined)
  assert.equal(formatHilSubmissionError(applicationFailure, t), componentsEn.stream.hil.cancelUnconfirmed)
  assert.equal(formatHilSubmissionError(unknown, t), componentsEn.stream.hil.outcomeUnknown)
  assert.equal(hilSubmissionFailure('answerUnconfirmed', '原始诊断\nERR 42').submissionError, '原始诊断\nERR 42')
})

test('permission display translates application scopes and preserves raw vendor scope text', async () => {
  const locale = createInstance()
  await locale.init({ lng: 'en', fallbackLng: false, interpolation: { escapeValue: false }, resources: { en: { conversation: en, components: componentsEn } } })
  const t = locale.getFixedT(null, 'components')
  const conversation = locale.getFixedT(null, 'conversation')
  for (const [id, prefixKind, scope] of [
    ['accept', undefined, 'once'], ['p', 'shell_prefix', 'allowCommandPrefix'],
    ['p', 'file_dir', 'allowDirectory'], ['p', 'web_host', 'allowSite'],
    ['p', undefined, 'alwaysAllow'], ['acceptForSession', undefined, 'allowSession'], ['e', undefined, 'acceptEdits']
  ] as const) {
    const message = { kind: 'allowedScope' as const, scope: hilPermissionScope({ id, label: 'vendor label' }, prefixKind) }
    const item = { resolved: 'existing canonical', resolvedMessage: message }
    const original = JSON.stringify(item)
    assert.equal(formatHilResolution(item, t, conversation), componentsEn.stream.hil.allowedScope.replace('{{scope}}', componentsEn.stream.hil[scope]))
    assert.equal(JSON.stringify(item), original)
  }
  const raw = { resolved: 'existing canonical', resolvedMessage: { kind: 'allowedScope' as const, scope: hilPermissionScope({ id: 'vendor_custom', label: '<原始 scope>' }) } }
  assert.equal(formatHilResolution(raw, t, conversation), 'Allowed · <原始 scope>')
  // Preserve old label-dependent denial styling; translation never replaces its input.
  const existing = { resolved: 'Denied', resolvedMessage: { kind: 'denied' as const } }
  assert.equal(formatHilResolution(existing, t, conversation), componentsEn.stream.hil.denied)
  assert.equal(existing.resolved, 'Denied')
})

test('history restores application HIL fallback provenance and a later user answer clears it', () => {
  const initial: ConvItem[] = [{ kind: 'hil', requestId: 'request', hilKind: 'permission', hilState: 'pending' }]
  const envelope = { v: 2 as const, ts: 1, session_id: 'session', turn_id: 'turn', item_id: 'item', type: 'hil_resolved' as const }
  const resolved = projectActivityEvents(initial, [{ ...envelope, seq: 1, data: { request_id: 'request', kind: 'permission', state: 'stale' as const } }])
  const card = resolved.find(item => item.kind === 'hil')
  assert.equal(card?.resolved, '请求已过期')
  assert.deepEqual(card?.resolvedMessage, { kind: 'stale' })
  const answered = projectActivityEvents(resolved, [{ ...envelope, seq: 2, data: { request_id: 'request', kind: 'permission', state: 'resolved' as const, answer: '请求已过期', answers: { choice: '请求已过期' } } }])
  const final = answered.find(item => item.kind === 'hil')
  assert.equal(final?.resolved, '请求已过期')
  assert.equal(final?.resolvedMessage, undefined)
  assert.deepEqual(final?.answers, { choice: '请求已过期' })
  assert.deepEqual(
    hilEventResolution('已拒绝全文授权。本次任务已停止，未读取任何文献全文。', 'cancelled'),
    {
      resolved: '已拒绝全文授权。本次任务已停止，未读取任何文献全文。',
      resolvedMessage: undefined
    }
  )
  assert.deepEqual(hilEventResolution('', 'cancelled'), { resolved: '已取消任务', resolvedMessage: { kind: 'cancelled' } })
  assert.deepEqual(hilEventResolution(undefined, 'resolved'), { resolved: '已处理', resolvedMessage: { kind: 'handled' } })
})
