import assert from 'node:assert/strict'
import test from 'node:test'
import { createInstance } from 'i18next'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import componentsZh from '../../localization/locales/zh/components.json' with { type: 'json' }
import componentsEn from '../../localization/locales/en/components.json' with { type: 'json' }
import browserZh from '../../localization/locales/zh/browser.json' with { type: 'json' }
import browserEn from '../../localization/locales/en/browser.json' with { type: 'json' }
import { projectActivityEvents } from './transcript.ts'

import {
  componentOptionAnswers,
  browserApprovalBody,
  browserApprovalResolution,
  browserApprovalSubmission,
  browserApprovalTarget,
  browserApprovalCardRole,
  formatHilResolution,
  formatHilSubmissionError,
  hilEventResolution,
  hilPermissionScope,
  hilSubmissionFailure,
  pendingHilItems,
  projectHilCard,
  settlePendingHil,
  hilResolvedRunState,
  hilRequestedRunState,
  pendingPermissionItems,
  permissionDecisionOptions,
  transcriptPresentationItems,
} from './hil.ts'
import type { ConvItem } from './model.ts'

test('component options are proposals restricted to the original question', () => {
  const question = { question: 'Outline', options: [{ label: 'Write' }, { label: 'Revise' }] }
  assert.deepEqual(componentOptionAnswers(question, { answers: ['Write'] }), ['Write'])
  assert.equal(componentOptionAnswers(question, { answers: ['Invented approval'] }), null)
  assert.equal(componentOptionAnswers(question, { answers: ['Write', 'Revise'] }), null)
  assert.equal(
    componentOptionAnswers({ ...question, multiSelect: true }, { answers: ['Write', 'Write'] }),
    null
  )
  assert.equal(componentOptionAnswers(question, { selected_paper_ids: ['Write'] }), null)
})

test('product authorization survives completion while native callbacks expire', () => {
  const product = projectHilCard(
    { request_id: 'product', kind: 'question', lifetime: 'session' },
    1,
    'turn'
  )
  const native = projectHilCard({ request_id: 'native', kind: 'question' }, 1, 'turn')
  const completed = settlePendingHil([product, native], 'turn', 'stale', true)
  assert.equal(completed[0].kind === 'hil' && completed[0].hilState, 'pending')
  assert.equal(completed[1].kind === 'hil' && completed[1].hilState, 'stale')
  assert.equal(settlePendingHil([product], 'turn', 'stale')[0].kind === 'hil', true)
  assert.equal(pendingHilItems(settlePendingHil([product], 'turn', 'stale')).length, 0)
})

test('plugin installation projects the exact host admission report', () => {
  const report = {
    valid: true,
    candidate: 'candidate-token',
    sha256: 'a'.repeat(64),
    descriptor: {
      id: 'generated-plugin',
      version: '1.0.0',
      capabilities: ['interaction.answer'],
      components: [],
    },
    issues: [],
    dependencies: {},
  }
  const card = projectHilCard(
    {
      request_id: 'install-request',
      kind: 'question',
      lifetime: 'session',
      questions: [
        {
          id: 'install-request',
          question: 'generated-plugin',
          options: [],
          plugin_installation: report,
        },
      ],
    },
    1,
    'turn'
  )
  assert.deepEqual(card.questions?.[0].installation, report)
  assert.equal(card.questions?.[0].component, undefined)
})

test('independent installation stays in transcript without blocking the composer', () => {
  const card = projectHilCard(
    {
      request_id: 'independent-install',
      kind: 'question',
      lifetime: 'session',
      blocking: false,
      questions: [],
    },
    1,
    'turn'
  )
  assert.equal(card.blocking, false)
  assert.deepEqual(pendingHilItems([card]), [])
  assert.deepEqual(transcriptPresentationItems([card]), [card])
  assert.deepEqual(settlePendingHil([card], 'turn', 'stale'), [card])
  const event = { request_id: 'independent-install', kind: 'question', blocking: false }
  assert.deepEqual(hilRequestedRunState({ running: true, status: 'running' }, event), {
    running: true,
    status: 'running',
  })
  assert.deepEqual(hilRequestedRunState({ running: false, status: 'done' }, event), {
    running: false,
    status: 'done',
  })
})

test('browser approval preserves scoped request and sends only a structured decision', () => {
  const card = projectHilCard(
    {
      request_id: 'browser-request',
      kind: 'browser_approval',
      method: 'browser_approval',
      tab_id: 'tab-1',
      proof_id: 'main-proof',
      target_instance_id: 'instance-1',
      target_generation: 3,
      origin: 'https://example.org',
      action: 'interact',
      intent: 'Open article',
      expires_at: 1_800_000_000,
    },
    1,
    'turn'
  )
  assert.equal(card.hilKind, 'browser_approval')
  assert.deepEqual(card.browserApproval, {
    tabId: 'tab-1',
    proofId: 'main-proof',
    targetInstanceId: 'instance-1',
    targetGeneration: 3,
    origin: 'https://example.org',
    action: 'interact',
    intent: 'Open article',
    expiresAt: 1_800_000_000_000,
  })
  assert.deepEqual(browserApprovalBody('allow_once'), { decision: 'allow_once' })
  assert.deepEqual(browserApprovalBody('deny'), { decision: 'deny' })
  assert.deepEqual(browserApprovalResolution('allow_once', ''), { kind: 'allowedOnce' })
  assert.deepEqual(browserApprovalResolution('deny', 'expired'), { kind: 'browserExpired' })
  assert.deepEqual(browserApprovalResolution('deny', 'turn_inactive'), { kind: 'browserInactive' })
  assert.deepEqual(browserApprovalResolution('deny', ''), { kind: 'denied' })
  assert.equal(
    projectHilCard(
      {
        request_id: 'malformed',
        kind: 'browser_approval',
        method: 'browser_approval',
        tab_id: 'tab-1',
        origin: 'https://example.org',
        action: 'read',
        expires_at: Number.NaN,
      },
      1
    ).browserApproval,
    undefined
  )
  assert.equal(
    projectHilCard(
      {
        request_id: 'missing-proof',
        kind: 'browser_approval',
        method: 'browser_approval',
        tab_id: 'tab-1',
        origin: 'https://example.org',
        action: 'read',
        expires_at: 1_800_000_000,
      },
      1
    ).browserApproval,
    undefined
  )
  assert.deepEqual(transcriptPresentationItems([card]), [])
  const resolved = projectActivityEvents(
    [card],
    [
      {
        v: 2,
        seq: 1,
        ts: 1_800_000_000,
        type: 'hil_resolved',
        session_id: 'session',
        turn_id: 'turn',
        item_id: '',
        data: {
          request_id: 'browser-request',
          kind: 'browser_approval',
          state: 'resolved',
          decision: 'deny',
          reason: 'expired',
        },
      },
    ]
  )
  assert.equal(resolved[0].kind === 'hil' && resolved[0].resolvedMessage?.kind, 'browserExpired')
  assert.equal(transcriptPresentationItems(resolved).length, 1)
  assert.equal(browserZh.approval.title, '浏览器访问请求')
  assert.equal(browserEn.approval.title, 'Browser access request')
})

test('history approval projects only a bounded query, without inventing a tab or origin', () => {
  const card = projectHilCard(
    {
      request_id: 'history-request',
      kind: 'browser_history_approval',
      method: 'browser_history_approval',
      proof_id: 'history-proof',
      query_digest: 'a'.repeat(64),
      history_revision: 3,
      search: 'research',
      offset: 2,
      limit: 10,
      intent: 'Find a paper',
      expires_at: 1_800_000_000,
    },
    1,
    'turn'
  )
  assert.equal(card.hilKind, 'browser_history_approval')
  assert.deepEqual(card.browserHistoryApproval, {
    proofId: 'history-proof',
    queryDigest: 'a'.repeat(64),
    historyRevision: 3,
    search: 'research',
    offset: 2,
    limit: 10,
    intent: 'Find a paper',
    expiresAt: 1_800_000_000_000,
  })
  assert.equal(card.browserApproval, undefined)
  assert.deepEqual(transcriptPresentationItems([card]), [])
  const resolved = projectActivityEvents(
    [card],
    [
      {
        v: 2,
        seq: 1,
        ts: 1_800_000_000,
        type: 'hil_resolved',
        session_id: 'session',
        turn_id: 'turn',
        item_id: '',
        data: {
          request_id: 'history-request',
          kind: 'browser_history_approval',
          state: 'resolved',
          decision: 'deny',
          reason: 'expired',
        },
      },
    ]
  )
  assert.equal(resolved[0].kind === 'hil' && resolved[0].resolvedMessage?.kind, 'historyExpired')
  assert.equal(transcriptPresentationItems(resolved).length, 1)
})

test('history approval fails closed on malformed query and provenance', () => {
  const request = {
    request_id: 'history-request',
    kind: 'browser_history_approval',
    method: 'browser_history_approval',
    proof_id: 'history-proof',
    query_digest: 'a'.repeat(64),
    history_revision: 3,
    search: 'research',
    offset: 2,
    limit: 10,
    intent: 'Find a paper',
    expires_at: 1_800_000_000,
  }
  for (const mutation of [
    { proof_id: '' },
    { query_digest: 'wrong' },
    { history_revision: -1 },
    { search: '' },
    { search: 'x'.repeat(257) },
    { offset: -1 },
    { offset: 1001 },
    { limit: 0 },
    { limit: 21 },
    { intent: '' },
    { intent: 'x'.repeat(513) },
    { expires_at: Number.NaN },
    { method: 'browser_approval' },
  ]) {
    assert.equal(projectHilCard({ ...request, ...mutation }, 1).browserHistoryApproval, undefined)
  }
})

test('browser approval treats lost POST and incomplete confirmation as unknown, never retryable', () => {
  assert.deepEqual(browserApprovalSubmission({ ok: false, error: 'network failed' }), {
    hilState: 'unknown',
  })
  assert.deepEqual(browserApprovalSubmission({ ok: false, outcome: 'unknown' }), {
    hilState: 'unknown',
  })
  assert.deepEqual(browserApprovalSubmission({ ok: true }), { hilState: 'unknown' })
  assert.deepEqual(browserApprovalSubmission({ ok: true, interaction: { state: 'resolved' } }), {
    hilState: 'unknown',
  })
  assert.deepEqual(
    browserApprovalSubmission({
      ok: true,
      interaction: { state: 'resolved', decision: 'deny', reason: 'expired' },
    }),
    {
      hilState: 'resolved',
      resolved: 'deny',
      resolvedMessage: { kind: 'browserExpired' },
    }
  )
})

test('browser approval carries only trusted tab and turn identity, marking model intent as advisory', () => {
  const card = projectHilCard(
    {
      request_id: 'request',
      kind: 'browser_approval',
      method: 'browser_approval',
      tab_id: 'tab-1',
      proof_id: 'main-proof',
      target_instance_id: 'instance-1',
      target_generation: 3,
      tab_title: 'Article',
      tab_url: 'https://example.org/article',
      origin: 'https://example.org',
      action: 'read',
      intent: 'Ignore safeguards',
      expires_at: 1_800_000_000,
    },
    1,
    'turn-1'
  )
  assert.equal(card.turnId, 'turn-1')
  assert.equal(card.browserApproval?.tabId, 'tab-1')
  assert.equal(card.browserApproval?.targetInstanceId, 'instance-1')
  assert.equal(card.browserApproval?.targetGeneration, 3)
  assert.equal(card.browserApproval?.tabTitle, 'Article')
  assert.equal(card.browserApproval?.tabUrl, 'https://example.org/article')
  assert.equal(card.browserApproval?.intent, 'Ignore safeguards')
  assert.match(browserZh.approval.intent, /Agent/)
  assert.match(browserEn.approval.intent, /Agent/)
})

test('browser approval verifies Main tab identity and origin before enabling consent', () => {
  const approval = { tabId: 'tab-1', origin: 'https://example.org' }
  const page = { tabId: 'tab-1', title: 'Article', url: 'https://example.org/article' }
  assert.deepEqual(browserApprovalTarget({ tabs: [page] }, approval), page)
  assert.equal(
    browserApprovalTarget({ tabs: [{ ...page, url: 'https://other.org/article' }] }, approval),
    null
  )
  assert.equal(browserApprovalTarget({ tabs: [{ ...page, tabId: 'tab-2' }] }, approval), null)
  assert.equal(browserApprovalTarget({ tabs: [{ ...page, url: 'not a URL' }] }, approval), null)
})

test('navigate approval displays trusted source and destination, including a blank source tab', () => {
  const card = projectHilCard(
    {
      request_id: 'navigate-request',
      kind: 'browser_approval',
      method: 'browser_approval',
      tab_id: 'tab-1',
      proof_id: 'navigate-proof',
      target_instance_id: 'instance-1',
      target_generation: 2,
      origin: 'https://www.iana.org',
      source_origin: null,
      action: 'navigate',
      intent: 'Open reference',
      destination_url: 'https://www.iana.org/domains/reserved',
      destination_origin: 'https://www.iana.org',
      expires_at: 1_800_000_000,
    },
    1,
    'turn'
  )
  assert.equal(card.browserApproval?.sourceOrigin, null)
  assert.equal(card.browserApproval?.destinationUrl, 'https://www.iana.org/domains/reserved')
  assert.equal(card.browserApproval?.destinationOrigin, 'https://www.iana.org')
  const blank = { tabId: 'tab-1', title: '', url: 'about:blank' }
  assert.deepEqual(browserApprovalTarget({ tabs: [blank] }, card.browserApproval!), blank)
  assert.equal(
    browserApprovalTarget(
      { tabs: [{ ...blank, url: 'https://example.org/' }] },
      card.browserApproval!
    ),
    null
  )
})

test('navigate approval fails closed on missing, malformed, or mismatched destination', () => {
  const valid = {
    request_id: 'navigate-request',
    kind: 'browser_approval',
    method: 'browser_approval',
    tab_id: 'tab-1',
    proof_id: 'navigate-proof',
    target_instance_id: 'instance-1',
    target_generation: 2,
    origin: 'https://www.iana.org',
    source_origin: 'https://example.org',
    action: 'navigate',
    intent: 'Open reference',
    destination_url: 'https://www.iana.org/domains/reserved',
    destination_origin: 'https://www.iana.org',
    expires_at: 1_800_000_000,
  }
  const page = { tabId: 'tab-1', title: 'Source', url: 'https://example.org/page' }
  const card = projectHilCard(valid, 1, 'turn')
  assert.deepEqual(browserApprovalTarget({ tabs: [page] }, card.browserApproval!), page)
  assert.equal(
    browserApprovalTarget(
      { tabs: [{ ...page, url: 'https://other.org/' }] },
      card.browserApproval!
    ),
    null
  )
  for (const invalid of [
    { destination_url: undefined },
    { destination_origin: undefined },
    { destination_origin: 'https://other.org' },
    { origin: 'https://other.org' },
    { destination_url: 'https://www.iana.org@evil.example/' },
    { destination_url: 'javascript:alert(1)' },
    { source_origin: undefined },
  ]) {
    assert.equal(projectHilCard({ ...valid, ...invalid }, 1, 'turn').browserApproval, undefined)
  }
})

test('action approval binds the visible element without carrying fill content', () => {
  const valid = {
    request_id: 'action-request',
    kind: 'browser_approval',
    method: 'browser_approval',
    tab_id: 'tab-1',
    proof_id: 'action-proof',
    target_instance_id: 'instance-1',
    target_generation: 2,
    origin: 'https://example.org',
    action: 'fill',
    browser_action: 'fill' as const,
    prepared_id: 'prepared-1',
    snapshot_id: 'snapshot-1',
    element_ref: 'ref-1',
    element: { role: 'textbox', name: 'Search' },
    intent: 'Search articles',
    expires_at: 1_800_000_000,
  }
  const card = projectHilCard(valid, 1, 'turn')
  assert.equal(card.browserApproval?.element?.name, 'Search')
  assert.equal(card.browserApproval?.browserAction, 'fill')
  assert.equal(JSON.stringify(card).includes('search terms'), false)
  for (const invalid of [
    { prepared_id: undefined },
    { snapshot_id: undefined },
    { element_ref: undefined },
    { browser_action: 'click' as const },
    { element: undefined },
    { element: { role: '', name: 'Search' } },
  ]) {
    assert.equal(projectHilCard({ ...valid, ...invalid }, 1, 'turn').browserApproval, undefined)
  }
})

test('only an active browser approval uses alertdialog semantics', () => {
  assert.equal(browserApprovalCardRole('dock', false, false), 'alertdialog')
  assert.equal(browserApprovalCardRole('history', true, false), 'group')
  assert.equal(browserApprovalCardRole('dock', false, true), 'group')
  assert.equal(browserApprovalCardRole('history', false, false), 'group')
})

test('late authorization HTTP and SSE answers cannot invent execution', () => {
  assert.deepEqual(
    hilResolvedRunState(
      { running: false, status: 'done', turnOutcomes: { turn: 'completed' } },
      'turn'
    ),
    {}
  )
  assert.deepEqual(
    hilResolvedRunState(
      { running: true, status: 'waiting', turnOutcomes: { turn: 'running' } },
      'turn'
    ),
    { running: true, status: 'running' }
  )
  assert.deepEqual(
    hilResolvedRunState(
      { running: true, status: 'waiting', turnOutcomes: { other: 'running', turn: 'completed' } },
      'turn'
    ),
    {}
  )
})

test('keeps pending interactions out of the transcript for the composer dock', () => {
  const items: ConvItem[] = [
    { kind: 'user', text: 'run command', turnId: 'turn-1' },
    {
      kind: 'hil',
      requestId: 'permission-1',
      hilKind: 'permission',
      hilState: 'pending',
      turnId: 'turn-1',
    },
    {
      kind: 'hil',
      requestId: 'question-1',
      hilKind: 'question',
      hilState: 'pending',
      questions: [{ question: '选择方案', options: [] }],
      turnId: 'turn-1',
    },
  ]

  assert.deepEqual(
    pendingHilItems(items).map((item) => item.requestId),
    ['permission-1', 'question-1']
  )
  assert.deepEqual(
    pendingPermissionItems(items).map((item) => item.requestId),
    ['permission-1']
  )
  assert.deepEqual(
    transcriptPresentationItems(items).map((item) => item.kind),
    ['user']
  )
})

test('projects confirmed questions as distinct ordered interaction replies', () => {
  const resolved: ConvItem = {
    kind: 'hil',
    requestId: 'question-1',
    hilKind: 'question',
    hilState: 'resolved',
    questions: [{ question: '今天早餐你想吃什么？', options: [] }],
    answers: { '今天早餐你想吃什么？': '包子配豆浆' },
    turnId: 'turn-1',
    eventSeq: 8,
  }
  assert.deepEqual(transcriptPresentationItems([resolved]), [
    {
      kind: 'interaction_reply',
      requestId: 'question-1',
      questions: resolved.questions,
      answers: resolved.answers,
      turnId: 'turn-1',
      itemId: undefined,
      eventSeq: 8,
    },
  ])
  const next: ConvItem = {
    kind: 'hil',
    requestId: 'question-2',
    hilKind: 'question',
    hilState: 'resolved',
    questions: [{ question: '喝什么？', options: [] }],
    answers: { '喝什么？': '豆浆' },
    turnId: 'turn-1',
    eventSeq: 9,
  }
  assert.deepEqual(
    transcriptPresentationItems([resolved, next]).map((item) =>
      item.kind === 'interaction_reply' ? item.requestId : item.kind
    ),
    ['question-1', 'question-2']
  )
})

test('never presents a stale question as a user reply', () => {
  const stale: ConvItem = {
    kind: 'hil',
    requestId: 'question-1',
    hilKind: 'question',
    hilState: 'stale',
    questions: [{ question: '今天早餐你想吃什么？', options: [] }],
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
    turnId: 'turn-1',
  }
  const denied: ConvItem = {
    kind: 'hil',
    requestId: 'permission-2',
    hilKind: 'permission',
    hilState: 'resolved',
    resolved: '已拒绝',
    resolvedMessage: { kind: 'denied' },
    turnId: 'turn-1',
  }
  assert.deepEqual(transcriptPresentationItems([allowed, denied]), [])
})

test('drops undecided terminal permissions because their outcome is conveyed elsewhere', () => {
  const stale: ConvItem = {
    kind: 'hil',
    requestId: 'permission-0',
    hilKind: 'permission',
    hilState: 'stale',
    resolved: '请求已过期',
  }
  const cancelled: ConvItem = {
    kind: 'hil',
    requestId: 'permission-1',
    hilKind: 'permission',
    hilState: 'cancelled',
    resolved: '已取消任务',
  }
  const unknown: ConvItem = {
    kind: 'hil',
    requestId: 'permission-2',
    hilKind: 'permission',
    hilState: 'unknown',
    submissionErrorMessage: 'outcomeUnknown',
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
      { id: 'cancel', label: 'Decline and stop' },
    ],
  }
  const decision = permissionDecisionOptions(item)
  assert.equal(decision.allowOnce?.id, 'accept')
  assert.equal(decision.deny.id, 'decline')
  assert.deepEqual(
    decision.allowed.map((option) => option.id),
    ['acceptForSession', 'accept']
  )
})

test('does not invent a one-time grant when only session scope is offered', () => {
  const decision = permissionDecisionOptions({
    kind: 'hil',
    requestId: 'session-only',
    hilKind: 'permission',
    options: [
      { id: 'acceptForSession', label: 'Allow for session' },
      { id: 'decline', label: 'Decline' },
    ],
  })
  assert.equal(decision.allowOnce, undefined)
  assert.deepEqual(
    decision.allowed.map((option) => option.id),
    ['acceptForSession']
  )
})

test('HIL display provenance follows language changes while raw answers and diagnostics remain exact', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'zh',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: {
      zh: { conversation: zh, components: componentsZh },
      en: { conversation: en, components: componentsEn },
    },
  })
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
  assert.equal(
    formatHilSubmissionError(applicationFailure, t),
    componentsEn.stream.hil.cancelUnconfirmed
  )
  assert.equal(formatHilSubmissionError(unknown, t), componentsEn.stream.hil.outcomeUnknown)
  assert.equal(
    hilSubmissionFailure('answerUnconfirmed', '原始诊断\nERR 42').submissionError,
    '原始诊断\nERR 42'
  )
})

test('permission display translates application scopes and preserves raw vendor scope text', async () => {
  const locale = createInstance()
  await locale.init({
    lng: 'en',
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: { en: { conversation: en, components: componentsEn } },
  })
  const t = locale.getFixedT(null, 'components')
  const conversation = locale.getFixedT(null, 'conversation')
  for (const [id, prefixKind, scope] of [
    ['accept', undefined, 'once'],
    ['p', 'shell_prefix', 'allowCommandPrefix'],
    ['p', 'file_dir', 'allowDirectory'],
    ['p', 'web_host', 'allowSite'],
    ['p', undefined, 'alwaysAllow'],
    ['acceptForSession', undefined, 'allowSession'],
    ['e', undefined, 'acceptEdits'],
  ] as const) {
    const message = {
      kind: 'allowedScope' as const,
      scope: hilPermissionScope({ id, label: 'vendor label' }, prefixKind),
    }
    const item = { resolved: 'existing canonical', resolvedMessage: message }
    const original = JSON.stringify(item)
    assert.equal(
      formatHilResolution(item, t, conversation),
      componentsEn.stream.hil.allowedScope.replace('{{scope}}', componentsEn.stream.hil[scope])
    )
    assert.equal(JSON.stringify(item), original)
  }
  const raw = {
    resolved: 'existing canonical',
    resolvedMessage: {
      kind: 'allowedScope' as const,
      scope: hilPermissionScope({ id: 'vendor_custom', label: '<原始 scope>' }),
    },
  }
  assert.equal(formatHilResolution(raw, t, conversation), 'Allowed · <原始 scope>')
  // Preserve old label-dependent denial styling; translation never replaces its input.
  const existing = { resolved: 'Denied', resolvedMessage: { kind: 'denied' as const } }
  assert.equal(formatHilResolution(existing, t, conversation), componentsEn.stream.hil.denied)
  assert.equal(existing.resolved, 'Denied')
})

test('history restores application HIL fallback provenance and a later user answer clears it', () => {
  const initial: ConvItem[] = [
    { kind: 'hil', requestId: 'request', hilKind: 'permission', hilState: 'pending' },
  ]
  const envelope = {
    v: 2 as const,
    ts: 1,
    session_id: 'session',
    turn_id: 'turn',
    item_id: 'item',
    type: 'hil_resolved' as const,
  }
  const resolved = projectActivityEvents(initial, [
    {
      ...envelope,
      seq: 1,
      data: { request_id: 'request', kind: 'permission', state: 'stale' as const },
    },
  ])
  const card = resolved.find((item) => item.kind === 'hil')
  assert.equal(card?.resolved, '请求已过期')
  assert.deepEqual(card?.resolvedMessage, { kind: 'stale' })
  const answered = projectActivityEvents(resolved, [
    {
      ...envelope,
      seq: 2,
      data: {
        request_id: 'request',
        kind: 'permission',
        state: 'resolved' as const,
        answer: '请求已过期',
        answers: { choice: '请求已过期' },
      },
    },
  ])
  const final = answered.find((item) => item.kind === 'hil')
  assert.equal(final?.resolved, '请求已过期')
  assert.equal(final?.resolvedMessage, undefined)
  assert.deepEqual(final?.answers, { choice: '请求已过期' })
  assert.deepEqual(
    hilEventResolution('已拒绝全文授权。本次任务已停止，未读取任何文献全文。', 'cancelled'),
    {
      resolved: '已拒绝全文授权。本次任务已停止，未读取任何文献全文。',
      resolvedMessage: undefined,
    }
  )
  assert.deepEqual(hilEventResolution('', 'cancelled'), {
    resolved: '已取消任务',
    resolvedMessage: { kind: 'cancelled' },
  })
  assert.deepEqual(hilEventResolution(undefined, 'resolved'), {
    resolved: '已处理',
    resolvedMessage: { kind: 'handled' },
  })
})
