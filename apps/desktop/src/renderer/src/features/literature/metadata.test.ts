import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiteratureDetail } from '../../contracts/literature'
import {
  classifyPaperMetaFailure,
  canSyncMetadata,
  needsMetadataSync,
  paperMetaFields,
  paperMetaPreview,
  paperMetaRecord,
  requiresConfirmation,
  selectPaperMetaQuery
} from './metadata.ts'

/** 上游 papersearch 命中项样例; 形状取自 z/result.json (serve 侧原封不动透出)。 */
const RECORD = {
  abstract: 'The central question addressed in this research is ...',
  authors: ['Vukosi Marivate', 'Second Author'],
  externalids: { ArXiv: '1706.03762', DOI: '10.7282/T34X59H0' },
  id: '5956271',
  journalname: 'Journal of Fallback',
  journalpages: '12-34',
  journalvolume: '7',
  publicationdate: '2018-03-01',
  title: 'Improved empirical methods in reinforcement-learning evaluation',
  url: 'https://www.semanticscholar.org/paper/88f5535a',
  venue: 'NeurIPS'
}

function detail(overrides: Partial<LiteratureDetail> = {}): LiteratureDetail {
  return {
    id: 'paper-1',
    item_type: 'document',
    bib_type: 'misc',
    title: 'Attention is All You Need',
    creators_display: '',
    publication_display: '',
    year: null,
    published_date: null,
    created_at: '2026-01-01T00:00:00+00:00',
    updated_at: '2026-01-01T00:00:00+00:00',
    last_read_at: null,
    read_progress: 0,
    is_unread: true,
    primary_attachment: null,
    attachments: [],
    collections: [],
    project_collections: [],
    tags: [],
    projects: [],
    version: 1,
    citation_key: null,
    subtitle: null,
    abstract: null,
    doi: null,
    arxiv: null,
    isbn: null,
    url: null,
    volume: null,
    number: null,
    pages: null,
    publisher: null,
    address: null,
    ...overrides
  }
}

test('doi wins over arxiv and title, arxiv over title, and nothing yields no query', () => {
  assert.deepEqual(
    selectPaperMetaQuery(detail({ doi: '10.1/x', arxiv: '1706.03762', title: 'Attention' })),
    { dimension: 'doi', value: '10.1/x' }
  )
  assert.deepEqual(selectPaperMetaQuery(detail({ arxiv: ' 1706.03762 ', title: 'Attention' })), {
    dimension: 'arxiv',
    value: '1706.03762'
  })
  assert.deepEqual(selectPaperMetaQuery(detail({ title: 'Attention' })), {
    dimension: 'title',
    value: 'Attention'
  })
  assert.equal(selectPaperMetaQuery(detail({ doi: '  ', arxiv: '', title: '' })), null)
})

test('public identifiers enable anonymous sync while title search requires login', () => {
  assert.ok(canSyncMetadata(detail({ doi: '10.1234/example', year: 2017 }), false))
  assert.ok(canSyncMetadata(detail({ arxiv: '1706.03762' }), false))
  assert.equal(canSyncMetadata(detail(), false), false)
  assert.ok(canSyncMetadata(detail(), true))
  assert.equal(canSyncMetadata(detail({ title: '' }), true), false)
})

test('only records whose filled bibliography stays inside title/author/arxiv/doi need a sync', () => {
  assert.ok(needsMetadataSync(detail({ arxiv: '1706.03762', creators_display: 'A. Author' })))
  assert.ok(needsMetadataSync(detail({ doi: '10.1/x' })))

  // 任一题录字段被填过, 记录就不再稀疏。
  for (const overrides of [
    { abstract: 'already there' },
    { publication_display: 'NeurIPS' },
    { year: 2017 },
    { published_date: '2017-06-12' },
    { url: 'https://arxiv.org/abs/1706.03762' },
    { pages: '5998-6018' },
    { subtitle: 'a subtitle' }
  ]) {
    assert.equal(needsMetadataSync(detail({ arxiv: '1706.03762', ...overrides })), false, JSON.stringify(overrides))
  }

  // 库内派生值不参与判据: citation_key / item_type / bib_type 恒有值也不该挡住同步。
  assert.ok(needsMetadataSync(detail({ arxiv: '1706.03762', citation_key: 'Attention2017' })))

  // 选不出同步维度时不提示 (标题也空), 否则按钮点了只会报错。
  assert.equal(
    needsMetadataSync(detail({ title: '  ', creators_display: 'A. Author' })),
    false
  )
})

test('title matches need confirmation while identifier lookups do not', () => {
  assert.equal(requiresConfirmation('title'), true)
  assert.equal(requiresConfirmation('doi'), false)
  assert.equal(requiresConfirmation('arxiv'), false)
})

test('quota exhaustion is told apart from every other failure', () => {
  assert.equal(classifyPaperMetaFailure({ status: 429, code: 'PAPER_META_QUOTA_EXHAUSTED' }), 'quota')
  // 只认状态码或只认 code 都算配额: 中间层可能改写其中一个。
  assert.equal(classifyPaperMetaFailure({ status: 429, code: 'REQUEST_FAILED' }), 'quota')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_QUOTA_EXHAUSTED' }), 'quota')
  assert.equal(classifyPaperMetaFailure({ status: 404, code: 'PAPER_META_NOT_FOUND' }), 'missing')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_NETWORK_FAILED' }), 'network')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_UPSTREAM_FAILED' }), 'failed')
  assert.equal(classifyPaperMetaFailure({ status: 401, code: 'PAPER_META_KEY_MISSING' }), 'failed')
  assert.equal(classifyPaperMetaFailure(null), 'failed')
})

test('only a single upstream hit is accepted', () => {
  assert.deepEqual(paperMetaRecord({ success: true, data: [RECORD] }), RECORD)
  assert.equal(paperMetaRecord({ success: true, data: [] }), null)
  assert.equal(paperMetaRecord({ success: true, data: [RECORD, RECORD] }), null)
  assert.equal(paperMetaRecord(null), null)
  assert.equal(paperMetaRecord({}), null)
})

test('upstream fields map onto literature update fields and never blank existing data', () => {
  assert.deepEqual(paperMetaFields(RECORD), {
    abstract: RECORD.abstract,
    arxiv: '1706.03762',
    authors: 'Vukosi Marivate, Second Author',
    doi: '10.7282/T34X59H0',
    pages: '12-34',
    publication: 'NeurIPS',
    published_date: '2018-03-01',
    title: RECORD.title,
    url: RECORD.url,
    volume: '7',
    year: 2018
  })

  // 上游没给的键一个都不进更新体: venue/journalname 皆空时不落 publication, 也不写空串。
  const sparse = paperMetaFields({
    authors: [],
    externalids: { ArXiv: null, DOI: null },
    journalname: '',
    title: 'Only a title',
    venue: ''
  })
  assert.deepEqual(sparse, { title: 'Only a title' })

  // venue 为空时退回 journalname。
  assert.deepEqual(paperMetaFields({ journalname: 'Journal of Fallback', venue: '' }).publication, 'Journal of Fallback')
})

test('the confirmation preview exposes human-readable values without upstream keys', () => {
  assert.deepEqual(paperMetaPreview(RECORD), {
    abstract: RECORD.abstract,
    arxiv: '1706.03762',
    authors: 'Vukosi Marivate, Second Author',
    doi: '10.7282/T34X59H0',
    publication: 'NeurIPS',
    publishedDate: '2018-03-01',
    title: RECORD.title,
    url: RECORD.url,
    year: 2018
  })
  assert.equal(paperMetaPreview({ publicationdate: 'not a date' }).year, null)
})
