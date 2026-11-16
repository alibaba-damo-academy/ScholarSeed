import assert from 'node:assert/strict'
import test from 'node:test'
import zh from '../../localization/locales/zh/conversation.json' with { type: 'json' }
import en from '../../localization/locales/en/conversation.json' with { type: 'json' }
import {
  clarificationOption,
  questionScrollTarget,
  questionDraft,
  questionAnswer,
  replayQuestionAnswer,
  questionAtScroll,
  directQuestionTarget,
  hasHostQuestions,
  projectHilCard,
  transcriptPresentationItems,
} from './hil.ts'
import { projectActivityEvents, resolveHilItem } from './transcript.ts'
import { projectSessionRecovery } from './runtime.ts'
import type { ConvItem, Thread } from './model.ts'

test('host routing follows every question without changing ordinary clarification ownership', () => {
  assert.equal(hasHostQuestions(), false)
  assert.equal(hasHostQuestions([]), false)
  const ordinary = { id: 'scope', question: 'Scope?', options: [] }
  assert.equal(hasHostQuestions([ordinary]), false)
  const manual = projectHilCard(
    {
      request_id: 'manual-fallback',
      kind: 'question',
      questions: [
        { id: 'manual', question: 'Confirm full text?', requires_user_confirmation: true },
      ],
    },
    1
  ).questions![0]
  assert.equal(hasHostQuestions([ordinary, manual]), true)
  const external = projectHilCard(
    {
      request_id: 'external-read:file',
      kind: 'question',
      questions: [{ id: 'file', question: '/tmp/report.txt', requires_host_response: true }],
    },
    1
  ).questions![0]
  assert.equal(hasHostQuestions([external]), true)
  assert.equal(external.requiresUserConfirmation, undefined)
  const component = projectHilCard(
    {
      request_id: 'component',
      kind: 'question',
      questions: [
        {
          id: 'host',
          question: 'Host?',
          component: { plugin: 'host', component: 'question', fingerprint: 'host-v1' },
        },
      ],
    },
    1
  ).questions![0]
  assert.equal(hasHostQuestions([ordinary, component]), true)
  const installation = {
    ...ordinary,
    installation: {
      valid: true,
      sha256: 'a'.repeat(64),
      descriptor: null,
      issues: [],
      dependencies: {},
    },
  }
  assert.equal(hasHostQuestions([installation, ordinary]), true)
})

test('clarification recommendation presentation preserves the raw protocol label', () => {
  assert.deepEqual(clarificationOption('效率（推荐）'), { label: '效率', recommended: true })
  assert.deepEqual(clarificationOption('Quality (Recommended)'), {
    label: 'Quality',
    recommended: true,
  })
  assert.deepEqual(clarificationOption('普通选项'), { label: '普通选项', recommended: false })
})

test('short questions retain the explicit next target at the native scroll limit', () => {
  assert.equal(questionScrollTarget(300, 500, 400), 100)
  assert.equal(questionAtScroll([0, 300, 400], 100, true, 1), 1)
  assert.equal(questionScrollTarget(20, 100, 400), 0)
})

test('a skipped clarification explicitly records an unanswered question in both languages', () => {
  assert.equal(zh.reply.skipped, '未作答')
  assert.equal(en.reply.skipped, 'Not answered')
})

test('late HTTP failures cannot replace a confirmed clarification receipt', () => {
  const resolved: ConvItem = {
    kind: 'hil',
    requestId: 'q',
    hilKind: 'question',
    hilState: 'resolved',
    timedOut: true,
  }
  const conversation = [resolved]
  assert.equal(resolveHilItem(conversation, 'q', { hilState: 'stale' }), conversation)
  assert.equal(resolveHilItem(conversation, 'q', { hilState: 'unknown' }), conversation)
})

test('scroll end selects the last question without overriding explicit navigation', () => {
  assert.equal(questionAtScroll([0, 100, 200], 100, true), 2)
  assert.equal(questionAtScroll([0, 100, 200], 100, true, 1), 1)
})

test('clarification recommendations are drafts and preserve selected options with supplements', () => {
  const questions = [
    {
      id: 'scope',
      question: 'Scope?',
      options: [{ label: 'Broad' }, { label: 'Focused (Recommended)' }],
    },
  ]
  const draft = questionDraft(questions)
  assert.deepEqual(draft, { 0: [1] })
  assert.equal(
    questionAnswer(questions[0], { option_indices: draft[0], text: 'Include recent work' }),
    'Focused (Recommended)\nInclude recent work'
  )
  assert.deepEqual(
    questionDraft([{ question: 'No recommendation', options: [{ label: 'First' }] }]),
    { 0: [] }
  )
  assert.equal(questionAtScroll([0, 200, 500], 250), 1)
  assert.equal(questionAtScroll([0, 200, 500], 900), 2)
})

test('answer replay prefers confirmed option positions and preserves ambiguous legacy text', () => {
  const question = {
    question: 'Which?',
    options: [{ label: 'A' }, { label: 'B' }, { label: 'A, B' }],
    multiSelect: true,
  }
  assert.deepEqual(
    replayQuestionAnswer(question, 'A, B\nline one\nline two', {
      option_indices: [2],
      text: 'line one\nline two',
    }),
    { option_indices: [2], text: 'line one\nline two' }
  )
  assert.deepEqual(replayQuestionAnswer(question, 'A, B'), {
    option_indices: [],
    text: 'A, B',
  })
  assert.deepEqual(
    replayQuestionAnswer({ ...question, options: question.options.slice(0, 2) }, 'B, A\nnotes'),
    { option_indices: [1, 0], text: 'notes' }
  )
  assert.deepEqual(replayQuestionAnswer(question, 'A', { option_indices: [], text: 'A' }), {
    option_indices: [],
    text: 'A',
  })
  assert.deepEqual(replayQuestionAnswer(question, 'original', { option_indices: [9], text: '' }), {
    option_indices: [],
    text: 'original',
  })
})

test('direct clarification targets the visible question only, never an authorization', () => {
  const question = projectHilCard({ request_id: 'question', kind: 'question' }, 1)
  const permission = projectHilCard({ request_id: 'permission', kind: 'permission' }, 1)
  assert.equal(directQuestionTarget([question, permission])?.requestId, 'question')
  assert.equal(directQuestionTarget([question, { ...question, requestId: 'other' }]), null)
  assert.equal(
    directQuestionTarget([question, { ...question, requestId: 'other' }], 'other')?.requestId,
    'other'
  )
  assert.equal(directQuestionTarget([permission]), null)
})

test('skipped, free text and timed out clarifications remain durable transcript receipts', () => {
  const question = projectHilCard(
    { request_id: 'question', kind: 'question', questions: [{ id: 'q', question: 'Scope?' }] },
    1
  )
  for (const fields of [{ answers: {} }, { freeText: 'Use recent papers' }, { timedOut: true }]) {
    const receipt = transcriptPresentationItems([
      { ...question, hilState: 'resolved', ...fields },
    ])[0]
    assert.equal(receipt?.kind, 'interaction_reply')
    if (receipt?.kind === 'interaction_reply' && 'freeText' in fields) {
      assert.equal(receipt.freeText, fields.freeText)
    }
  }
})

test('authoritative resolution replays free text and timeout reasons, not default answers', () => {
  const question = projectHilCard(
    {
      request_id: 'question',
      kind: 'question',
      questions: [{ id: 'q', question: 'Scope?', cancel_timeout_on_edit: true }],
      timeout_seconds: 300,
      created_at: 100,
      timeout_cancelled: true,
    },
    1,
    'turn'
  )
  assert.equal(question.timeoutCancelled, true)
  assert.equal(question.cancelTimeoutOnEdit, true)
  assert.equal(question.timeoutAt, 400_000)
  for (const data of [
    { free_text: 'Include methods', timed_out: false },
    { free_text: '', timed_out: true },
  ]) {
    const resolved = projectActivityEvents(
      [question],
      [
        {
          v: 2,
          seq: 2,
          ts: 2,
          type: 'hil_resolved',
          session_id: 'session',
          turn_id: 'turn',
          data: {
            request_id: 'question',
            kind: 'question',
            state: 'resolved',
            answers: {},
            ...data,
          },
        },
      ]
    )
    const receipt = transcriptPresentationItems(resolved)[0]
    assert.equal(receipt.kind, 'interaction_reply')
    if (receipt.kind === 'interaction_reply') {
      assert.equal(receipt.freeText ?? '', data.free_text)
      assert.equal(receipt.timedOut ?? false, data.timed_out)
      assert.deepEqual(receipt.answers, {})
    }
  }
})

test('session recovery restores authoritative timeout cancellation on an existing card', () => {
  const initial: Thread = {
    id: 'thread',
    title: 'Clarification',
    sessionId: 'session-1',
    lastSeq: 0,
    conversation: [{ kind: 'hil', requestId: 'outline', hilKind: 'question', hilState: 'pending' }],
  }
  const recovered = projectSessionRecovery(initial, {
    sessionId: 'session-1',
    running: true,
    activeTurnId: 'turn',
    unknownOutcome: false,
    pendingHil: [
      {
        request_id: 'outline',
        kind: 'question',
        created_at: 20,
        timeout_seconds: 300,
        timeout_cancelled: true,
      },
    ],
    uncertainOperations: [],
    timestamp: 1,
  })
  const card = recovered.conversation?.find((item) => item.kind === 'hil')
  assert.equal(card?.kind === 'hil' && card.timeoutCancelled, true)
  assert.equal(card?.kind === 'hil' && card.timeoutAt, 320_000)
})
