import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/literature.json' with { type: 'json' }
import en from '../../../../localization/locales/en/literature.json' with { type: 'json' }
import { literatureCopy } from './copy.ts'
import { searchCriteria, searchCriteriaTitle } from './result.ts'

const localization = createInstance()
await localization.init({
  lng: 'zh',
  resources: { zh: { literature: zh }, en: { literature: en } },
  interpolation: { escapeValue: false },
})
const translate = localization.getFixedT('zh', 'literature')

test('question copy uses projected text but canonical answers still select the displayed option', () => {
  const copied = literatureCopy(
    'interaction.question',
    {
      question: '原始中文问题',
      displayQuestion: 'Start writing with the outline?',
      options: [
        {
          label: '按当前方案开始撰写',
          displayLabel: 'Start writing with the current plan',
          displayDescription: 'Use the current outline and output settings.',
        },
      ],
      answers: ['按当前方案开始撰写'],
    },
    localization.getFixedT('en', 'literature')
  )!.text
  assert.match(copied, /Start writing with the outline\?/)
  assert.match(copied, /\[x\] Start writing with the current plan/)
  assert.doesNotMatch(copied, /[\p{Script=Han}]/u)
  assert.equal(
    literatureCopy('interaction.question', { question: '历史原文' }, translate)!.text,
    '历史原文'
  )
})

test('search copy localizes only explicitly generated criteria and preserves historical text', () => {
  const english = localization.getFixedT('en', 'literature')
  const data = {
    criteria: ['用户原文', '年份：2023–不限', '本轮结果上限：10 篇'],
    criteria_details: [
      { kind: 'intent', text: '用户原文', values: ['用户原文'] },
      { kind: 'years', text: '年份：2023–不限', values: ['2023', ''] },
      { kind: 'limit', text: '本轮结果上限：10 篇', values: ['10'] },
    ],
    papers: [],
  }
  const copied = literatureCopy('display.literature-search', data, english)!.text
  assert.match(copied, /用户原文/)
  assert.match(copied, /Years: 2023–Any/)
  assert.match(copied, /Result limit: 10 papers/)
  assert.doesNotMatch(copied, /年份|本轮结果上限/)
  assert.match(
    literatureCopy('display.literature-search', { criteria: data.criteria }, english)!.text,
    /年份/
  )
  assert.match(
    literatureCopy('display.literature-search', data, translate)!.text,
    /年份：2023–不限/
  )
})

test('criteria with absent, unknown or mismatched provenance retain their frozen original text', () => {
  const english = localization.getFixedT('en', 'literature')
  const criteria = ['用户自己写的年份标题']
  for (const details of [
    undefined,
    [],
    [{ kind: 'years', text: '别的条件', values: ['2023', '2026'] }],
    [{ kind: 'years', values: ['2023', '2026'] }],
    [{ kind: 'intent', text: criteria[0], values: ['替换用户原文'] }],
    [{ kind: 'future_kind', text: criteria[0], values: [] }],
    [{ kind: ['paper_types'], text: criteria[0], values: ['journal'] }],
    [{ kind: 'years', text: criteria[0], values: ['2023'] }],
    [{ kind: 'limit', text: criteria[0], values: ['9007199254740993'] }],
    [{ kind: 'paper_types', text: criteria[0], values: [] }],
    [{ kind: 'paper_types', text: criteria[0], values: [null] }],
  ]) {
    assert.deepEqual(searchCriteria({ criteria, criteria_details: details }, english), criteria)
  }
})

test('generated criteria preserve supplied values and follow the translator without mutating the card', () => {
  const data = {
    criteria: [
      '年份：不限–2026',
      '本轮结果上限：1 篇',
      '文献类型：中文期刊；conference',
      '关键条件：中文条件',
      '排除条件：surveys',
    ],
    criteria_details: [
      { kind: 'years', text: '年份：不限–2026', values: ['', '2026'] },
      { kind: 'limit', text: '本轮结果上限：1 篇', values: ['1'] },
      {
        kind: 'paper_types',
        text: '文献类型：中文期刊；conference',
        values: ['中文期刊', 'conference'],
      },
      { kind: 'include_criteria', text: '关键条件：中文条件', values: ['中文条件'] },
      { kind: 'exclude_criteria', text: '排除条件：surveys', values: ['surveys'] },
    ],
  }
  const frozen = JSON.stringify(data)
  const english = localization.getFixedT('en', 'literature')
  assert.deepEqual(searchCriteria(data, english), [
    'Years: Any–2026',
    'Result limit: 1 paper',
    'Paper types: 中文期刊; conference',
    'Key criteria: 中文条件',
    'Exclusions: surveys',
  ])
  assert.deepEqual(searchCriteria(data, translate), data.criteria)
  assert.equal(JSON.stringify(data), frozen)
  assert.equal(searchCriteriaTitle(data), '')
  assert.equal(searchCriteriaTitle({ criteria: data.criteria }), data.criteria[0])
})

test('result tab titles retain user intent and never cache translated generated conditions', () => {
  const intent = { kind: 'intent', text: '用户检索主题', values: ['用户检索主题'] }
  assert.equal(
    searchCriteriaTitle({ criteria: [intent.text], criteria_details: [intent] }),
    intent.text
  )
  assert.equal(
    searchCriteriaTitle({
      criteria: [intent.text],
      criteria_details: [{ ...intent, text: 'stale' }],
    }),
    intent.text
  )
  assert.equal(searchCriteriaTitle({ criteria: [] }), '')
})

test('paper copy does not repeat an identical decision reason and evidence reason', () => {
  const copied = literatureCopy(
    'display.literature-search',
    {
      papers: [
        {
          title: 'AI Scientist',
          decision_reason: '关键自主科研系统',
          reasons: ['关键自主科研系统'],
        },
      ],
    },
    translate
  )!.text
  assert.equal(copied.split('关键自主科研系统').length - 1, 1)
})

test('public card copy uses business data, includes non-visible pages and preserves evidence links', () => {
  const papers = Array.from({ length: 8 }, (_, index) => ({
    title: `Paper ${index + 1}`,
    authors: ['Researcher'],
    year: 2026,
    doi: `10.123/${index}`,
    evidence: 'Page 3: observed result',
  }))
  const copied = literatureCopy(
    'display.literature-references',
    { references: papers },
    translate
  )!.text
  assert.match(copied, /Paper 8/)
  assert.match(copied, /https:\/\/doi.org\/10.123\/7/)
  assert.match(copied, /Page 3: observed result/)
  assert.equal(literatureCopy('custom.unknown', { secret: 'private' }, translate), null)
})

test('choice copy uses current answers without serializing private fields', () => {
  assert.equal(
    literatureCopy(
      'interaction.question',
      {
        options: [
          {
            label: 'evidence',
            description: 'internal',
            displayLabel: '证据',
            displayDescription: '核对引用',
          },
        ],
        answers: ['evidence'],
        secret: 'hidden',
      },
      translate
    )!.text,
    '[x] 证据 核对引用'
  )
})

test('search copy keeps the displayed heading, retained count and translated warnings', () => {
  const content = {
    status: 'success',
    retained: 15,
    selection: { artifact_id: 'selection' },
    criteria: ['长上下文检索'],
    papers: [],
    warnings: ['agentic-search returned a partial result'],
  }
  const copied = literatureCopy('display.literature-search', content, translate)!.text
  assert.ok(
    copied.includes(
      translate('result.heading', {
        heading: translate('searchResult.authorizationPending'),
        count: 15,
      })
    )
  )
  assert.ok(copied.includes(translate('result.warning.partial')))
  const english = localization.getFixedT('en', 'literature')
  assert.ok(
    literatureCopy('display.literature-search', content, english)!.text.includes(
      english('searchResult.authorizationPending')
    )
  )
})

test('downloads copy preserves the admission count and project outcome', () => {
  const copied = literatureCopy(
    'display.literature-downloads',
    {
      schema_version: '1.0',
      session_id: 'session',
      run: 'run',
      project_id: 'project',
      papers: [
        {
          paper_id: 'paper',
          literature_id: 'literature',
          attachment_id: 'attachment',
          revision: 'revision',
          title: 'Lost in the Middle',
        },
      ],
      failures: [],
    },
    translate
  )!.text
  assert.ok(copied.includes(translate('downloads.heading', { count: 1 })))
  assert.ok(copied.includes(translate('downloads.projectLinked')))
})

test('delivery copy preserves its heading, live counts and readable state', () => {
  const copied = literatureCopy(
    'display.literature-delivery',
    {
      state: 'pending',
      papers: [{ title: 'Lost in the Middle', saved: 'pending', library: 'saved' }],
    },
    translate
  )!.text
  for (const value of [
    translate('delivery.cardTitle'),
    translate('delivery.counts', { acquired: 1, saved: 0, admitted: 1 }),
    translate('delivery.status.pending'),
  ])
    assert.ok(copied.includes(value), value)
})

test('references copy includes DOI and source URL independently on every page', () => {
  const references = Array.from({ length: 26 }, (_, index) => ({
    title: `Paper ${index + 1}`,
    doi: `10.123/${index}`,
    url: `https://example.org/paper-${index}`,
    arxiv_id: `2601.00${index}`,
    cited_by: [`claim-${index}`],
  }))
  const copied = literatureCopy('display.literature-references', { references }, translate)!.text
  for (const paper of references)
    for (const value of [paper.title, paper.doi, paper.url, paper.arxiv_id])
      assert.ok(copied.includes(value), value)
  assert.doesNotMatch(copied, /claim-/)
  assert.ok(copied.includes(translate('references.heading', { count: 26 })))
})

test('delivery copy includes reuse and skipped-version outcomes without claiming files were saved', () => {
  const copied = literatureCopy(
    'display.literature-delivery',
    {
      state: 'saved',
      papers: [{ title: 'Existing', saved: 'skipped', library: 'skipped', library_reused: true }],
    },
    translate
  )!.text
  for (const value of [
    translate('delivery.allSkipped'),
    translate('delivery.reused', { count: 1 }),
    translate('delivery.skipped', { count: 1 }),
    translate('delivery.counts', { acquired: 1, saved: 0, admitted: 0 }),
  ])
    assert.ok(copied.includes(value), value)
})

test('public review and outline retain their full snapshot and current choice', () => {
  const content = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../../skills/community/literature-review/components/outline.json',
        import.meta.url
      ),
      'utf8'
    )
  ).data
  const copied = literatureCopy('display.literature-review', content, translate)!.text
  assert.ok(copied.includes(content.title))
  for (const section of content.sections) assert.ok(copied.includes(section.title))
  const question = {
    ...content,
    question: '是否开始撰写？',
    options: [{ label: '开始' }],
    answers: ['开始'],
  }
  const outline = literatureCopy('literature.outline', question, translate)!.text
  assert.ok(outline.includes(copied))
  assert.ok(outline.includes('是否开始撰写？'))
  assert.ok(outline.includes('[x] 开始'))
})
