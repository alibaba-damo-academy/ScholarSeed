import assert from 'node:assert/strict'
import test from 'node:test'
import type { AnswerSource, ConvItem } from '../../model.ts'
import { answerCopyText, hasCopyCard, readCardCopy, replyCopyText } from './copying.ts'

const reference = { plugin: 'notes', component: 'focus', fingerprint: 'v1', binding: 'binding' }

test('answered paper questions retain their displayed default selection and empty prompt', async () => {
  for (const papers of [[{ id: 'paper', label: 'Paper' }], []]) {
    const items: ConvItem[] = [
      {
        kind: 'interaction_reply',
        turnId: 'one',
        requestId: 'request',
        questions: [
          {
            id: 'permission',
            question: 'Read these papers?',
            component: reference,
            papers,
            options: [],
          },
        ],
        answers: { permission: papers.length ? 'Allow' : 'Reject' },
      },
    ]
    const copied = await replyCopyText(
      items,
      'one',
      async (_reference, data) => {
        assert.equal(data.question, 'Read these papers?')
        assert.deepEqual(
          data.selected_paper_ids,
          papers.map((paper) => paper.id)
        )
        return { text: String(data.question) }
      },
      'missing'
    )
    assert.equal(copied, `Read these papers?\n${papers.length ? 'Allow' : 'Reject'}`)
  }
})

test('whole reply supplies each displayed card identity for complete result loading', async () => {
  const items = [
    {
      kind: 'display_card',
      turnId: 'one',
      card: {
        cardId: 'saved-search',
        type: 'literature-search',
        component: reference,
        content: { retained: 40 },
      },
    },
  ] as ConvItem[]
  let savedCard: string | undefined
  await replyCopyText(
    items,
    'one',
    async (_reference, _data, cardId) => {
      savedCard = cardId
      return { text: '全部 40 篇' }
    },
    'missing'
  )
  assert.equal(savedCard, 'saved-search')
})

for (const snapshot of [
  { name: 'display defaults', state: {}, expected: ['paper'] },
  { name: 'persisted cleared selection', state: { selected_paper_ids: [] }, expected: [] },
]) {
  test(`card copy retains ${snapshot.name} with current server fields`, async (context) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
    context.after(() => {
      if (original) Object.defineProperty(globalThis, 'window', original)
      else Reflect.deleteProperty(globalThis, 'window')
    })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        scholarseed: {
          deviceSkills: async () => ({
            status: 200,
            body: JSON.stringify({
              content: null,
              data: { question: '后端当前问题', papers: [{ id: 'paper', label: '论文' }] },
              state: snapshot.state,
            }),
          }),
        },
      },
    })
    let projected: Record<string, unknown> = {}
    await readCardCopy(
      reference,
      'session',
      (value) => {
        projected = value
        return { text: '复制内容' }
      },
      { question: '界面旧问题', selected_paper_ids: ['paper'] }
    )
    assert.equal(projected.question, '后端当前问题')
    assert.deepEqual(projected.selected_paper_ids, snapshot.expected)
  })
}

test('answer copy retains native citation markers, UTF-16 positions and public source links', () => {
  const paragraph = '🔬 开头与结尾最好、中段显著下降。'
  const text = `${paragraph}\n\n长上下文检索。<!-- scholarseed-ref private -->`
  const sources = [
    {
      kind: 'searched' as const,
      number: 1,
      title: 'Lost in the Middle',
      url: 'https://arxiv.org/abs/2307.03172',
      search_kind: 'paper' as const,
      search_id: 'search',
      citation_urls: ['https://arxiv.org/abs/2307.03172'],
      occurrences: [
        { start_utf16: 0, end_utf16: paragraph.length },
        { start_utf16: 0, end_utf16: paragraph.length },
        { start_utf16: paragraph.length + 2, end_utf16: paragraph.length + 10 },
        { start_utf16: 0, end_utf16: text.length + 1 },
      ],
    },
  ]
  const copied = answerCopyText(text, sources)
  assert.ok(copied.includes(`${paragraph}[1]`))
  assert.ok(copied.includes(sources[0].url))
  assert.ok(copied.includes(sources[0].title))
  assert.doesNotMatch(copied, /scholarseed-ref|private|search_id/)
  assert.equal(copied.split(`${paragraph}[1]`).length - 1, 1)
})

test('whole reply does not repeat a prompt already supplied by its card', async () => {
  const items = [
    {
      kind: 'interaction_reply',
      turnId: 'one',
      requestId: 'request',
      questions: [{ id: 'focus', question: '阅读重点？', component: reference, options: [] }],
      answers: { focus: '证据' },
    },
  ] as ConvItem[]
  const copied = await replyCopyText(
    items,
    'one',
    async () => ({ text: '阅读重点？\n[x] 证据' }),
    'missing'
  )
  assert.equal(copied.split('阅读重点？').length - 1, 1)
  assert.equal(copied.split('证据').length - 1, 1)
})

test('selected answers with descriptions are not repeated after their cards', async () => {
  const content = '阅读重点？\n[x] 证据 对照实验与数字'
  const items: ConvItem[] = [
    {
      kind: 'interaction_reply',
      turnId: 'one',
      requestId: 'request',
      questions: [{ id: 'focus', question: '阅读重点？', component: reference, options: [] }],
      answers: { focus: '证据' },
    },
  ]
  assert.equal(
    await replyCopyText(items, 'one', async () => ({ text: content }), 'missing'),
    content
  )
})

test('receipt citations retain displayed numbering without internal destinations', () => {
  const sources: AnswerSource[] = [
    { number: 4, kind: 'receipt', handle: 'first', citation_urls: ['scholarseed-cite:first'] },
    { number: 5, kind: 'receipt', handle: 'second', citation_urls: ['scholarseed-cite:second'] },
  ]
  const text =
    '事实[1](scholarseed-cite:first)。后续[1][evidence]。\n\n[evidence]: scholarseed-cite:second'
  const copied = answerCopyText(text, sources)
  assert.equal(copied.trim(), '事实[4]。后续[5]。')
  assert.doesNotMatch(copied, /scholarseed-cite|first|second/)
  const code = '`[1](scholarseed-cite:first)`\n\n```md\n[1](scholarseed-cite:first)\n```'
  assert.equal(answerCopyText(code, sources), code)
})

test('whole reply prefers the answered interaction over its pending projection', async () => {
  const question = { id: 'focus', question: '阅读重点？', component: reference, options: [] }
  const items = [
    {
      kind: 'hil',
      hilKind: 'question',
      turnId: 'one',
      requestId: 'request',
      questions: [question],
    },
    {
      kind: 'interaction_reply',
      turnId: 'one',
      requestId: 'request',
      questions: [question],
      answers: { focus: '证据' },
    },
  ] as ConvItem[]
  const copied = await replyCopyText(items, 'one', async () => ({ text: '卡片正文' }), 'missing')
  assert.ok(copied.includes('证据'))
  assert.equal(copied.split('卡片正文').length - 1, 1)
})

test('an answer-only projection retains its original question and card', async () => {
  const items = [
    {
      kind: 'hil',
      hilKind: 'question',
      turnId: 'one',
      requestId: 'request',
      questions: [{ id: 'focus', question: '阅读重点？', component: reference, options: [] }],
    },
    { kind: 'interaction_reply', turnId: 'one', requestId: 'request', answers: { focus: '证据' } },
  ] as ConvItem[]
  assert.equal(
    await replyCopyText(items, 'one', async () => ({ text: '卡片正文' }), 'missing'),
    '阅读重点？\n卡片正文\n证据'
  )
})
test('reply copy preserves message order, private comment filtering and one copy per binding', async () => {
  const items = [
    { kind: 'agent', turnId: 'one', text: '开始<!-- scholarseed-ref private -->' },
    {
      kind: 'display_card',
      turnId: 'one',
      card: { component: reference, content: {}, cardId: 'card' },
    },
    {
      kind: 'display_card',
      turnId: 'one',
      card: { component: reference, content: {}, cardId: 'duplicate' },
    },
    { kind: 'agent', turnId: 'two', text: '另一个回合' },
    { kind: 'agent', turnId: 'one', text: '结论' },
  ] as ConvItem[]
  let requests = 0
  assert.equal(
    await replyCopyText(
      items,
      'one',
      async () => {
        requests++
        return { text: '证据卡' }
      },
      '[卡片未提供文本]'
    ),
    '开始\n\n证据卡\n\n结论'
  )
  assert.equal(requests, 1)
})

test('card-only replies and missing card content are not silently dropped', async () => {
  const items: ConvItem[] = [
    {
      kind: 'hil',
      hilKind: 'question',
      turnId: 'one',
      requestId: 'request',
      questions: [{ id: 'focus', question: '阅读重点？', component: reference, options: [] }],
      answers: { focus: '证据' },
    },
  ]
  assert.equal(
    await replyCopyText(items, 'one', async () => null, '[卡片未提供文本]'),
    '阅读重点？\n[卡片未提供文本]\n证据'
  )
  await assert.rejects(
    replyCopyText(
      items,
      'one',
      async () => {
        throw new Error('denied')
      },
      'missing'
    ),
    /denied/
  )
})

test('multiline card questions are included only once', async () => {
  const question = '请选择阅读重点：\n实验结果还是研究方法？'
  const items: ConvItem[] = [
    {
      kind: 'interaction_reply',
      turnId: 'one',
      requestId: 'request',
      questions: [{ header: 'focus', question, component: reference, options: [] }],
      answers: { focus: '实验结果' },
    },
  ]
  const content = `${question}\n\n[x] 实验结果`
  assert.equal(
    await replyCopyText(items, 'one', async () => ({ text: content }), 'missing'),
    content
  )
})

test('answered question projections retain card content and the actual answer', async () => {
  const items: ConvItem[] = [
    {
      kind: 'interaction_reply',
      turnId: 'one',
      requestId: 'request',
      questions: [{ header: 'focus', question: '阅读重点？', component: reference, options: [] }],
      answers: { focus: '证据' },
    },
  ]
  assert.equal(
    await replyCopyText(items, 'one', async () => ({ text: '证据卡正文' }), 'missing'),
    '阅读重点？\n证据卡正文\n证据'
  )
})

test('native artifact, delivery and review cards remain in the copied conversation order', async () => {
  const items: ConvItem[] = [
    { kind: 'agent', turnId: 'one', text: '验证方案如下' },
    {
      kind: 'artifact',
      turnId: 'one',
      artifact: {
        artifact_id: 'plan',
        title: '研究验证方案',
        name: 'plan.md',
        path: 'outputs/plan.md',
        status: 'available',
      },
    },
    {
      kind: 'delivery',
      turnId: 'one',
      delivery: {
        deliveryId: 'delivery',
        label: '交付材料',
        status: 'ready',
        members: [
          {
            materialId: 'material',
            title: '实验清单',
            workspacePath: 'outputs/checklist.md',
            mediaType: 'text/markdown',
            previewAvailable: true,
            revision: 'v1',
            versionId: 'version',
            primary: true,
          },
        ],
      },
    },
    {
      kind: 'review',
      turnId: 'one',
      review: {
        batchId: 'batch',
        projectId: 'project',
        fileIds: ['file'],
        reviewIds: ['review'],
        paths: ['outputs/review.md'],
      },
    },
    { kind: 'agent', turnId: 'one', text: '请检查对照实验' },
  ]
  for (const item of items.slice(1, 4)) assert.equal(hasCopyCard(item), true)
  const copied = await replyCopyText(
    items,
    'one',
    async () => {
      throw new Error('not_a_plugin')
    },
    'missing'
  )
  for (const value of [
    '研究验证方案',
    'plan.md',
    'outputs/plan.md',
    'available',
    '交付材料',
    'ready',
    '实验清单',
    'outputs/checklist.md',
    'outputs/review.md',
  ])
    assert.ok(copied.includes(value), value)
  assert.ok(copied.indexOf('验证方案如下') < copied.indexOf('outputs/plan.md'))
  assert.ok(copied.indexOf('outputs/plan.md') < copied.indexOf('outputs/checklist.md'))
  assert.ok(copied.indexOf('outputs/review.md') < copied.indexOf('请检查对照实验'))
  assert.doesNotMatch(copied, /material|version|project|batch|missing/)
})
