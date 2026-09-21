import assert from 'node:assert/strict'
import test from 'node:test'

import type { LiteratureDetail } from '../../contracts/literature'
import {
  classifyPaperMetaFailure,
  canSyncMetadata,
  paperMetaDescriptionKey,
  paperMetaDiff,
  paperMetaFields,
  paperMetaPickedFields,
  paperMetaTitleKey,
  requiresConfirmation,
  selectPaperMetaQuery,
  type PaperMetaFields,
  type PaperMetaPayload
} from './metadata.ts'

/**
 * 一次标题检索的更新体; 取自 OpenAlex W2166273353 的真实归一化结果。
 * serve 侧 tests/contract_literature_papermeta.py 用同一条记录做契约。
 */
const FIELDS: PaperMetaFields = {
  abstract: 'Dew formation was investigated in three stages',
  authors: 'Thomas Fischer, Maik Veste',
  doi: '10.5194/bg-9-4621-2012',
  number: '11',
  pages: '4621-4628',
  publication: 'Biogeosciences',
  published_date: '2012-11-20',
  publisher: 'Copernicus Publications',
  title: 'Dew formation on the surface of biological soil crusts',
  url: 'https://doi.org/10.5194/bg-9-4621-2012',
  volume: '9',
  year: 2012
}

/** 预印本命中项: 没有 DOI, 以 arXiv 号与摘要页为准。 */
const PREPRINT_FIELDS: PaperMetaFields = {
  arxiv: '1706.03762',
  authors: 'Ashish Vaswani, Noam Shazeer',
  publication: 'arXiv (Cornell University)',
  title: 'Attention Is All You Need',
  url: 'https://arxiv.org/abs/1706.03762',
  year: 2017
}

/**
 * 只剩标题这一维时用的题录标题: 必须是「像论文标题」的值, 否则维度门槛会先把它挡掉
 * (见 `./title.ts`)。短词 (`Attention`) 与编号一类不算标题, 用在这类断言里会测错东西。
 */
const TITLE_ONLY = 'Attention Is All You Need'

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
  assert.deepEqual(selectPaperMetaQuery(detail({ title: TITLE_ONLY })), {
    dimension: 'title',
    value: TITLE_ONLY
  })
  assert.equal(selectPaperMetaQuery(detail({ doi: '  ', arxiv: '', title: '' })), null)
  // title 这一维多一道形态门槛: 编号/文件名/整句话不像论文标题, 拿去做 OpenAlex
  // 标题模糊检索只会回一堆不相干的命中, 所以直接不给维度。doi/arxiv 不看形态。
  assert.equal(selectPaperMetaQuery(detail({ title: '17' })), null)
  assert.equal(selectPaperMetaQuery(detail({ title: 'scan0001.pdf' })), null)
  assert.equal(selectPaperMetaQuery(detail({ title: 'The weather is nice today.' })), null)
})

test('every dimension stays open to a re-sync, complete records included', () => {
  // 三条腿都不需要账号, 也不看题录填全没有: 同步过的记录可以再同步一次,
  // 要不要覆盖现值由确认框里逐字段勾选决定。
  assert.ok(canSyncMetadata(detail({ doi: '10.1234/example', year: 2017 })))
  assert.ok(canSyncMetadata(detail({ arxiv: '1706.03762', abstract: 'already there' })))
  assert.ok(canSyncMetadata(detail()))
  // 只剩标题这一维也照样开放 (只要标题像个标题), 命中不命中交给确认框。
  assert.ok(canSyncMetadata(detail({ title: TITLE_ONLY, year: 2017 })))
  assert.ok(canSyncMetadata(detail({ title: TITLE_ONLY, publisher: 'Copernicus' })))
  // 库内派生值不影响可用性: citation_key / item_type / bib_type 恒有值也不挡同步。
  assert.ok(canSyncMetadata(detail({ arxiv: '1706.03762', citation_key: 'Attention2017' })))

  // 三个标识符全空、或只剩一个不像标题的 title 时才收起入口, 否则按钮点了只会报错。
  assert.equal(canSyncMetadata(detail({ title: '' })), false)
  assert.equal(canSyncMetadata(detail({ title: '   ', creators_display: 'A. Author' })), false)
  assert.equal(canSyncMetadata(detail({ title: '17 32 45' })), false)
})

test('title matches need confirmation while identifier lookups do not', () => {
  assert.equal(requiresConfirmation('title'), true)
  assert.equal(requiresConfirmation('doi'), false)
  assert.equal(requiresConfirmation('arxiv'), false)
})

test('every dimension maps to its own banner title and reason copy', () => {
  assert.equal(paperMetaTitleKey('doi'), 'detail.sync.bannerByDoi')
  assert.equal(paperMetaTitleKey('arxiv'), 'detail.sync.bannerByArxiv')
  assert.equal(paperMetaTitleKey('title'), 'detail.sync.bannerByTitle')
  assert.equal(paperMetaDescriptionKey('doi'), 'detail.sync.byDoi')
  assert.equal(paperMetaDescriptionKey('arxiv'), 'detail.sync.byArxiv')
  assert.equal(paperMetaDescriptionKey('title'), 'detail.sync.byTitle')
})

test('quota exhaustion is told apart from every other failure', () => {
  assert.equal(classifyPaperMetaFailure({ status: 429, code: 'PAPER_META_QUOTA_EXHAUSTED' }), 'quota')
  // 只认状态码或只认 code 都算配额: 中间层可能改写其中一个。
  assert.equal(classifyPaperMetaFailure({ status: 429, code: 'REQUEST_FAILED' }), 'quota')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_QUOTA_EXHAUSTED' }), 'quota')
  assert.equal(classifyPaperMetaFailure({ status: 404, code: 'PAPER_META_NOT_FOUND' }), 'missing')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_NETWORK_FAILED' }), 'network')
  assert.equal(classifyPaperMetaFailure({ status: 502, code: 'PAPER_META_UPSTREAM_FAILED' }), 'failed')
  assert.equal(classifyPaperMetaFailure({ status: 500, code: 'PAPER_META_ENDPOINT_INVALID' }), 'failed')
  assert.equal(classifyPaperMetaFailure(null), 'failed')
})

test('the update body comes straight off the payload and blank values are dropped', () => {
  assert.deepEqual(paperMetaFields({ success: true, fields: FIELDS, bib_type: 'article' }), FIELDS)
  // serve 侧只写有值的键, 但空值仍要在这里挡住, 否则会把已有数据抹成空。
  assert.deepEqual(
    paperMetaFields({ success: true, fields: { title: 'Only a title', abstract: '', publisher: null } }),
    { title: 'Only a title' }
  )
  assert.deepEqual(paperMetaFields({ success: true }), {})
  assert.deepEqual(paperMetaFields({ success: true, fields: null }), {})
  assert.deepEqual(paperMetaFields(null), {})
  assert.deepEqual(paperMetaFields(undefined), {})
  // 旧的「上游命中项列表」形状不再被解析: 渲染层不认识任何上游形状。
  assert.deepEqual(paperMetaFields({ data: [FIELDS] } as unknown as PaperMetaPayload), {})
})

test('the confirmation dialog lists every offered field, publisher and issue included', () => {
  const rows = paperMetaDiff(FIELDS, detail())
  assert.deepEqual(
    rows.map((row) => row.field).sort(),
    Object.keys(FIELDS).sort()
  )

  // 当前值取文献上的同义字段 (authors ↔ creators_display), 空值渲染成空串。
  const byField = new Map(rows.map((row) => [row.field, row]))
  assert.equal(byField.get('publisher')?.labelKey, 'columns.publisher')
  assert.equal(byField.get('publisher')?.current, '')
  assert.equal(byField.get('publisher')?.next, 'Copernicus Publications')
  assert.equal(byField.get('number')?.labelKey, 'columns.number')
  assert.equal(byField.get('authors')?.current, '')
  assert.equal(byField.get('authors')?.next, 'Thomas Fischer, Maik Veste')
  assert.equal(byField.get('year')?.next, '2012')

  // 现值相同的字段也列出来 (默认不勾选, 由页面按 current !== next 决定)。
  const same = paperMetaDiff(PREPRINT_FIELDS, detail({ title: 'Attention Is All You Need' }))
  assert.equal(same.find((row) => row.field === 'title')?.current, 'Attention Is All You Need')
  assert.equal(same.find((row) => row.field === 'title')?.next, 'Attention Is All You Need')

  // 更新体里没有的键不会凭空多出一行。
  assert.equal(paperMetaDiff({}, detail()).length, 0)
})

test('only the checked fields reach the update body', () => {
  assert.deepEqual(paperMetaPickedFields(FIELDS, new Set(['title', 'year'])), {
    title: FIELDS.title,
    year: 2012
  })
  assert.deepEqual(paperMetaPickedFields(FIELDS, new Set()), {})
  // 勾了一个上游没给的键也不会凭空写进去。
  assert.deepEqual(paperMetaPickedFields(PREPRINT_FIELDS, new Set(['isbn', 'arxiv'])), {
    arxiv: '1706.03762'
  })
})
