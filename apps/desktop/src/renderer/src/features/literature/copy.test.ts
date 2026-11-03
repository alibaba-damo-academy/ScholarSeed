import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'
import zh from '../../../../localization/locales/zh/literature.json' with { type: 'json' }
import en from '../../../../localization/locales/en/literature.json' with { type: 'json' }
import { literatureCopy } from './copy.ts'

const localization = createInstance()
await localization.init({
  lng: 'zh',
  resources: { zh: { literature: zh }, en: { literature: en } },
  interpolation: { escapeValue: false },
})
const translate = localization.getFixedT('zh', 'literature')

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
