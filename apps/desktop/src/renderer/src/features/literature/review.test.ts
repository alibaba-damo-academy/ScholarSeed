import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import i18next, { createInstance } from 'i18next'

import type { ConvItem } from '../../model.ts'
import { latestDisplayCardItems } from '../../transcript.ts'
import { literatureRetrievalAuthorization, literatureReviewInteraction } from './interaction.ts'
import { parseReview, reviewStatus, reviewSupersessionKey, REVIEW_VERDICTS } from './projection.ts'

const engine = createInstance()
const resources = {
  zh: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/literature.json', import.meta.url), 'utf8')) },
  en: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/en/literature.json', import.meta.url), 'utf8')) }
}
await engine.init({ lng: 'zh', fallbackLng: false, resources })
await i18next.init({ lng: 'zh', fallbackLng: false, resources })

const snapshot = {
  schema_version: '1.1', session_id: 'session', workspace: 'survey', title: '研究方法', intent: '比较方法边界',
  checkpoint: 'outline', status: 'outline', generation_status: null,
  scope: { topic: '研究方法', time_range: '2021–2026', focus: ['方法演进'], requested_materials: [], project_materials: 1, external_materials: 1 },
  output: { format: null, citation_style: null, decided_by: null },
  included: 2, fulltext: null, abstract_only: null, pending_checks: null, cited: null,
  section_count: 1, sections: [{ id: '1', title: '方法', description: '', papers: 2, children: ['条件'], comparison_tables: [] }],
  citations: [], abstract_evidence: [], issues: [], warnings: [], checks: [], source_hashes: { 'survey/outline.md': 'digest' },
  artifacts: [{ artifact_id: 'outline', path: 'survey/outline.md', name: 'outline.md', title: '完整大纲', sha256: 'digest' }]
}

test('review preserves unknown coverage and original artifact identities', () => {
  assert.equal(parseReview(snapshot)?.fulltext, null)
  assert.equal(parseReview(snapshot)?.artifacts[0].artifact_id, 'outline')
  assert.equal(parseReview({ ...snapshot, schema_version: '2.0' }), null)
})

test('the settled review replaces its outline while other workspaces remain visible', () => {
  const cards: ConvItem[] = [
    { kind: 'display_card', card: { cardId: 'outline-one', type: 'literature-review', content: { workspace: 'one', checkpoint: 'outline' } } },
    { kind: 'display_card', card: { cardId: 'outline-two', type: 'literature-review', content: { workspace: 'two', checkpoint: 'outline' } } },
    { kind: 'display_card', card: { cardId: 'failed-one', type: 'literature-review', content: { workspace: 'one', checkpoint: 'result', status: 'failed' } } },
    { kind: 'display_card', card: { cardId: 'recovered-one', type: 'literature-review', content: { workspace: 'one', checkpoint: 'result', status: 'generated' } } }
  ]

  const visible = latestDisplayCardItems(cards, card => reviewSupersessionKey(card.content))

  assert.deepEqual(
    visible.map(item => item.kind === 'display_card' ? item.card.cardId : ''),
    ['outline-two', 'recovered-one']
  )
  assert.equal(cards.length, 4)
  assert.equal(reviewSupersessionKey({ workspace: 'one', checkpoint: 'unknown' }), null)
})

test('malformed nested cards do not crash or hide original evidence', () => {
  for (const change of [{ checks: [null] }, { sections: [{ title: 'bad' }] }, { artifacts: [{}] }, { included: -1 }, { status: 'toString' }]) {
    assert.equal(parseReview({ ...snapshot, ...change }), null)
  }
})

test('historic derived status is not relabeled as a producer verdict', () => {
  const historic = parseReview({ ...snapshot, checkpoint: 'result', status: 'partial' })!
  assert.equal(reviewStatus(historic, engine.getFixedT('zh', 'literature')), '结果快照')
  assert.equal(reviewStatus({ ...historic, generation_status: 'SUCCESS' }, engine.getFixedT('zh', 'literature')), '生成报告：成功')
})

const outputQuestions = [
  { header: '综述输出格式', question: '请选择输出格式', options: [{ label: 'PDF' }, { label: 'Markdown' }] },
  { header: '综述引用格式', question: '请选择引用格式', options: [{ label: '通用数字顺序制' }, { label: '通用作者—年份制' }, { label: '出版社格式' }] }
]

test('SLR output policy requires every answer and records exact skip defaults', () => {
  assert.equal(literatureReviewInteraction.matches(outputQuestions), true)
  assert.equal(literatureReviewInteraction.complete(outputQuestions, { 0: ['Markdown'] }, {}), false)
  assert.equal(literatureReviewInteraction.complete(outputQuestions, { 0: ['Markdown'], 1: ['通用数字顺序制'] }, {}), true)
  assert.deepEqual(literatureReviewInteraction.defaults(outputQuestions), {
    综述输出格式: 'Markdown',
    综述引用格式: '通用数字顺序制'
  })
})

test('publisher follow-up stays inside IEEE and ACM and other HIL remains unmatched', () => {
  const publisher = [{ header: '综述出版社格式', question: '请选择出版社格式', options: [{ label: 'IEEE' }, { label: 'ACM' }] }]
  assert.equal(literatureReviewInteraction.matches(publisher), true)
  assert.equal(literatureReviewInteraction.complete(publisher, {}, {}), false)
  assert.equal(literatureReviewInteraction.matches([{ question: '继续吗', options: [{ label: '继续' }] }]), false)
})

test('all literature fulltext headers reuse the exact two-option one-click interaction', () => {
  for (const header of ['精准检索授权', '综述检索授权', '想法原文授权']) {
    const authorization = [{
      id: `${header}:challenge`,
      header,
      question: '是否允许读取已展示文献的全文？',
      options: [{ label: '一键授权 (Recommended)' }, { label: '拒绝' }]
    }]
    assert.equal(literatureRetrievalAuthorization.matches(authorization), true, header)
    assert.deepEqual(
      authorization[0].options.map(option => literatureRetrievalAuthorization.optionLabel?.(option)),
      ['一键授权', '拒绝'],
      header
    )
    assert.equal(literatureRetrievalAuthorization.directDecision?.(authorization[0], authorization[0].options[0]), 'respond', header)
    assert.equal(
      literatureRetrievalAuthorization.directDecision?.(authorization[0], authorization[0].options[1]),
      'respond',
      header
    )
    assert.equal(literatureReviewInteraction.matches(authorization), false, header)
    assert.equal(literatureRetrievalAuthorization.matches([{
      ...authorization[0],
      options: [{ label: '一键授权 (Recommended)' }]
    }]), false, header)
    assert.equal(literatureRetrievalAuthorization.matches([{
      ...authorization[0],
      options: [...authorization[0].options, { label: '稍后' }]
    }]), false, header)
  }
  assert.equal(literatureRetrievalAuthorization.directPresentation, 'primary-secondary')
  assert.equal(
    literatureRetrievalAuthorization.cancelledLabel?.({
      header: '精准检索授权',
      question: '是否允许读取全文？',
      options: []
    }),
    '已拒绝全文授权。本次任务已停止，未读取任何文献全文。'
  )
})

test('review display translates snapshots, producer generation and verdicts without changing evidence', () => {
  const review = parseReview(snapshot)!
  const before = structuredClone(review)
  const zh = engine.getFixedT('zh', 'literature')
  const en = engine.getFixedT('en', 'literature')
  assert.equal(reviewStatus(review, en), 'Outline snapshot')
  for (const generation_status of ['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED'] as const) {
    assert.notEqual(reviewStatus({ ...review, generation_status }, zh), reviewStatus({ ...review, generation_status }, en))
  }
  for (const key of Object.values(REVIEW_VERDICTS)) { assert.notEqual(zh(key), en(key)); assert.notEqual(en(key), key) }
  assert.deepEqual(review, before)
})
