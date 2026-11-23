import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNextStepSender,
  nextStepMessage,
  nextStepsAvailable,
  parseNextSteps,
} from './suggestions.ts'
import {
  canRetryEmptyAnswer,
  canRetryEmptyTurn,
  isEmptyAnswer,
  isEmptyTurn,
  createComposerSubmission,
} from '../../components/business/submission.ts'
import type { Thread } from '../../model.ts'

const content = {
  title: '接下来你希望做什么？',
  options: [
    { label: 'Deep · 文献支撑', description: '检索相关工作并补充引用。' },
    { label: 'Validation · 验证方案', description: '为选定想法设计实验。' },
  ],
  free_text_label: '其他需求',
  submit_label: '发送',
}

const thread = (patch: Partial<Thread> = {}): Thread =>
  ({
    id: 'thread',
    sessionId: 'session',
    lastSeq: 3,
    title: 'Task',
    conversation: [
      {
        kind: 'display_card',
        turnId: 'turn',
        card: { cardId: 'card', type: 'next-steps', content },
      },
    ],
    turnOutcomes: { turn: 'completed' },
    ...patch,
  }) as Thread

test('next-step choices submit exactly their displayed label and description', () => {
  const parsed = parseNextSteps(content)
  assert.ok(parsed)
  assert.equal(nextStepMessage(parsed.options[0]), 'Deep · 文献支撑\n检索相关工作并补充引用。')
  assert.equal(parsed.title, content.title)
  assert.equal(parseNextSteps({ ...content, options: [content.options[0]] })?.options.length, 1)
  assert.equal(parseNextSteps({ ...content, title: '  hello  ' })?.title, 'hello')
})

test('dismissal stays scoped to the owner session and turn without consuming a user action', () => {
  const bridge = createComposerSubmission()
  bridge.dismiss('session', 'turn')
  assert.equal(bridge.dismissed('session', 'turn'), true)
  assert.equal(bridge.dismissed('other', 'turn'), false)
  assert.equal(bridge.dismissed('session', 'next'), false)
  assert.equal(bridge.consumed('session', 'turn'), false)
})

test('empty-answer retry requires the current completed owner and preserves later user input', () => {
  const answer = { kind: 'agent' as const, text: '  ', turnId: 'turn' }
  const current = thread({ conversation: [answer] })
  assert.equal(canRetryEmptyAnswer(current, answer), true)
  assert.equal(canRetryEmptyAnswer(current, { ...answer }), false)
  for (const outcome of ['running', 'failed', 'interrupted', 'unknown'] as const)
    assert.equal(
      canRetryEmptyAnswer({ ...current, turnOutcomes: { turn: outcome } }, answer),
      false
    )
  for (const flags of [
    { running: true },
    { readOnly: true },
    { status: 'waiting' },
    { terminated: true },
    { recoveryPending: true },
  ])
    assert.equal(canRetryEmptyAnswer({ ...current, ...flags } as Thread, answer), false)
  current.conversation.push({ kind: 'user', text: '已经开始下一轮' })
  assert.equal(canRetryEmptyAnswer(current, answer), false)
})

test('empty answer is a completed turn result, not an individual empty message', () => {
  const first = { kind: 'agent' as const, text: '', turnId: 'turn' }
  const last = { kind: 'agent' as const, text: '<!-- scholarseed-ref private -->', turnId: 'turn' }
  const current = thread({ conversation: [first, last] })
  assert.equal(isEmptyAnswer(current, first), false)
  assert.equal(isEmptyAnswer(current, last), true)
  assert.equal(canRetryEmptyAnswer(current, last), true)
  for (const outcome of ['running', 'failed', 'interrupted', 'unknown'] as const) {
    assert.equal(isEmptyAnswer({ ...current, turnOutcomes: { turn: outcome } }, last), false)
  }
  const body = { kind: 'agent' as const, text: '实际答案', turnId: 'turn' }
  assert.equal(isEmptyAnswer(thread({ conversation: [body, last] }), last), false)
  assert.equal(
    isEmptyAnswer(
      thread({
        conversation: [
          {
            kind: 'display_card',
            turnId: 'turn',
            card: { cardId: 'result', type: 'result', content: {} },
          },
          last,
        ],
      }),
      last
    ),
    false
  )
  assert.equal(isEmptyAnswer(current, { ...last }), false)
})

test('completed turns without any model message still offer a result without inventing transcript content', () => {
  const current = thread({ conversation: [{ kind: 'user', text: '请回答原问题', turnId: 'turn' }] })
  const original = structuredClone(current)
  assert.equal(isEmptyTurn(current, 'turn'), true)
  assert.equal(canRetryEmptyTurn(current, 'turn'), true)
  assert.equal(isEmptyTurn(current, 'missing'), false)
  assert.equal(isEmptyTurn({ ...current, conversation: [] }, 'turn'), false)
  assert.deepEqual(current, original)
  const artifact = {
    artifact_id: 'artifact',
    path: 'output.md',
    name: 'output.md',
    publication_id: 'publication',
    role: 'final' as const,
  }
  for (const status of ['failed', 'deleted'] as const) {
    assert.equal(
      isEmptyTurn(
        {
          ...current,
          conversation: [
            ...current.conversation,
            { kind: 'artifact', turnId: 'turn', artifact: { ...artifact, status } },
          ],
        },
        'turn'
      ),
      true
    )
  }
  assert.equal(
    isEmptyTurn(
      {
        ...current,
        conversation: [
          ...current.conversation,
          { kind: 'artifact', turnId: 'turn', artifact: { ...artifact, status: 'available' } },
        ],
      },
      'turn'
    ),
    false
  )
  assert.equal(
    isEmptyTurn(
      {
        ...current,
        conversation: [
          ...current.conversation,
          {
            kind: 'artifact',
            turnId: 'turn',
            artifact: { ...artifact, role: 'intermediate', status: 'available' },
          },
        ],
      },
      'turn'
    ),
    true
  )
  const hil = { kind: 'hil' as const, turnId: 'turn', requestId: 'request', hilKind: 'permission' }
  assert.equal(
    isEmptyTurn({ ...current, conversation: [...current.conversation, hil] }, 'turn'),
    false
  )
  assert.equal(
    isEmptyTurn(
      { ...current, conversation: [...current.conversation, { ...hil, resolved: 'allowed' }] },
      'turn'
    ),
    true
  )
  assert.equal(
    canRetryEmptyTurn(
      {
        ...current,
        conversation: [...current.conversation, { kind: 'user', text: '下一轮', turnId: 'next' }],
      },
      'turn'
    ),
    false
  )
})

test('malformed, oversized or duplicate next-step payloads are rejected', () => {
  for (const invalid of [
    { ...content, title: '' },
    { ...content, title: 'x'.repeat(501) },
    { ...content, options: [] },
    { ...content, options: [...content.options, ...content.options] },
    { ...content, options: [content.options[0], content.options[0]] },
    { ...content, hidden_prompt: 'unexpected' },
    {
      ...content,
      options: [{ ...content.options[0], hidden_prompt: 'unexpected' }, content.options[1]],
    },
    { ...content, submit_label: ' ' },
  ])
    assert.equal(parseNextSteps(invalid), null)
})

test('only a completed owner turn with no later user input offers a next step', () => {
  assert.equal(nextStepsAvailable(thread(), 'card', 'turn'), true)
  for (const outcome of ['running', 'failed', 'interrupted', 'unknown'] as const) {
    assert.equal(
      nextStepsAvailable(thread({ turnOutcomes: { turn: outcome } }), 'card', 'turn'),
      false
    )
  }
  assert.equal(nextStepsAvailable(thread(), 'card', undefined), false)
  assert.equal(nextStepsAvailable(thread(), 'missing', 'turn'), false)
  assert.equal(nextStepsAvailable(thread(), 'card', 'other'), false)
  assert.equal(nextStepsAvailable(thread({ running: true }), 'card', 'turn'), false)
  assert.equal(nextStepsAvailable(thread({ terminated: true }), 'card', 'turn'), false)
  assert.equal(nextStepsAvailable(thread({ recoveryPending: true }), 'card', 'turn'), false)
  assert.equal(
    nextStepsAvailable(thread({ recoveryPending: true, resourceFinalizing: true }), 'card', 'turn'),
    true
  )
  assert.equal(nextStepsAvailable(thread({ status: 'waiting' }), 'card', 'turn'), false)
  const old = thread()
  old.conversation.push({ kind: 'user', text: 'continue' })
  assert.equal(nextStepsAvailable(old, 'card', 'turn'), false)
})

test('the card sender rereads the owner turn before sending and never answers an old card', async () => {
  let current = thread()
  const bridge = createComposerSubmission()
  const messages: string[] = []
  bridge.register({
    sessionId: 'session',
    disabled: false,
    submit: async (message) => {
      messages.push(message)
      return true
    },
  })
  const send = createNextStepSender(
    () => current,
    { sessionId: 'session', cardId: 'card', turnId: 'turn' },
    bridge
  )
  current = thread({ turnOutcomes: { turn: 'running' } })
  assert.equal(await send('no'), false)
  current = thread({ sessionId: 'different' })
  assert.equal(await send('no'), false)
  current = thread()
  current.conversation.push({ kind: 'user', text: 'another next step' })
  assert.equal(await send('no'), false)
  current = thread({ recoveryPending: true, resourceFinalizing: true, recoveryBlocked: true })
  assert.equal(await send('no'), false)
  current = thread({ recoveryPending: true, resourceFinalizing: true })
  const visible = nextStepMessage(content.options[0])
  assert.equal(await send(visible), true)
  assert.deepEqual(messages, [visible])
})

test('a blocked composer keeps the card available for explicit retry after readiness changes', async () => {
  const bridge = createComposerSubmission()
  const messages: string[] = []
  const submit = async (message: string) => {
    messages.push(message)
    return true
  }
  bridge.register({ sessionId: 'session', disabled: true, submit })
  const send = createNextStepSender(
    () => thread(),
    { sessionId: 'session', cardId: 'card', turnId: 'turn' },
    bridge
  )
  const message = nextStepMessage(content.options[1])
  assert.equal(bridge.getSnapshot(), null)
  assert.equal(await send(message), false)
  assert.equal(bridge.consumed('session', 'card'), false)
  bridge.register({ sessionId: 'session', disabled: false, submit })
  assert.deepEqual(messages, [])
  assert.equal(await send(message), true)
  assert.deepEqual(messages, [message])
})

test('free input keeps its exact text, failed submission stays retryable, success stays consumed', async () => {
  const bridge = createComposerSubmission()
  const messages: string[] = []
  let accepted = false
  bridge.register({
    sessionId: 'session',
    disabled: false,
    submit: async (message) => {
      messages.push(message)
      return accepted
    },
  })
  const send = createNextStepSender(
    () => thread(),
    { sessionId: 'session', cardId: 'card', turnId: 'turn' },
    bridge
  )
  const input = '  请比较这两个方向\n再继续  '
  assert.equal(await send(input), false)
  accepted = true
  assert.equal(await send(input), true)
  assert.equal(await send(input), false)
  assert.deepEqual(messages, [input, input])
})
